// src/net/lap-admin.ts — the lap server's moderation routes, behind ADMIN_TOKEN. DEV-374.
//
// D30: *"best-effort and moderatable. We deter casual cheating and delete the
// rest."* DEV-372 built the deterring (`lap-validate.ts`); this is the
// deleting. PLAYER-GHOSTS §5's DEV-374: delete a lap, wipe a handle, block,
// audit — and nothing else, because every route here is one a leaked token
// would hand to somebody else.
//
//   DELETE /api/admin/laps?id=<id>[&reason=]          delete any lap
//   DELETE /api/admin/handles?handle=<h>[&reason=][&block=0]
//                                                     wipe every lap under a handle,
//                                                     and retire the handle (unless block=0)
//   GET    /api/admin/blocks                          what is blocked
//   POST   /api/admin/blocks  { kind, value | lap, reason?, wipe? }
//                                                     block a device (`owner`, by its
//                                                     key's hash or by one of its laps)
//                                                     or a `handle`; `wipe` also deletes
//                                                     every lap it holds
//   DELETE /api/admin/blocks?kind=<k>&value=<v>[&reason=]   lift one
//   GET    /api/admin/audit[?id=&handle=&owner=&mission=&limit=]
//                                                     the laps as the server holds them
//                                                     (owner hash, build, distance —
//                                                     what no public route shows), the
//                                                     blocks, the log, today's count
//
// `docs/lap-server.md` has a `curl` for each.
//
// ── The secret ────────────────────────────────────────────────────────────
//
// Every route answers only to `Authorization: Bearer <ADMIN_TOKEN>`, checked
// FIRST — before the body is read or the database is touched — by one wrapper
// (`guarded`) that every export below goes through, and the Functions export
// nothing else (`tests/unit/lap-admin.test.ts` calls every `onRequest*` under
// `functions/api/admin/` without the token). A token shorter than
// `ADMIN_TOKEN_MIN_LENGTH`, or none, switches the routes OFF (503), never open.
// The token is compared as SHA-256 digests, every byte, so the time a wrong
// guess takes says nothing about how much of it was right. It is a secret in
// the Cloudflare project (Pages › Settings › Variables and secrets); it is in
// no file in this repository and must never be in a URL.
//
// ── What a block does, and what it cannot ────────────────────────────────
//
// `submitLap` refuses a blocked device or handle with 403 (`blockOf` in
// `lap-server.ts`). A device is its owner key, so a block holds until that
// browser's storage is cleared — best effort, as D30 says of everything here.
// There is no address block: a lap never holds an address (/privacy's promise,
// `migrations/0001_laps.sql`), so nothing links a lap to one.
//
// SERVER-SAFE: web platform only, as `lap-server.ts`. The clock comes in.

import { sha256Bytes } from './digest'
import { isHandle } from './handles'
import { json, refuse } from './http'
import {
  ADMIN_AUDIT_MAX,
  ADMIN_REASON_MAX,
  ADMIN_TOKEN_MIN_LENGTH,
  LAP_DAILY_CAP,
} from './lap-policy'
import {
  type D1Database,
  type D1PreparedStatement,
  ID_SHAPE,
  isMissingTable,
  type LapEnv,
  sweepAdminLog,
} from './lap-server'

const DAY_MS = 24 * 60 * 60 * 1000

/** How `laps.owner_hash` holds a device: SHA-256 of its owner key, lower-case hex. */
const OWNER_HASH_SHAPE = /^[0-9a-f]{64}$/

export type BlockKind = 'owner' | 'handle'

// ── The secret ────────────────────────────────────────────────────────────

/** Equal, in a time that does not depend on where two digests first differ. */
const sameDigest = (a: Uint8Array, b: Uint8Array): boolean => {
  let diff = a.length ^ b.length
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] ?? 0)
  return diff === 0
}

/**
 * Why this request may NOT use an admin route, or null when it may. The whole
 * of the check; `guarded` runs it before anything else.
 */
export const adminRefusal = async (request: Request, env: LapEnv): Promise<Response | null> => {
  const token = env.ADMIN_TOKEN ?? ''
  if (token.length < ADMIN_TOKEN_MIN_LENGTH) {
    return refuse(
      503,
      'unconfigured',
      `the admin routes are off: ADMIN_TOKEN is unset or shorter than ${ADMIN_TOKEN_MIN_LENGTH} characters`,
    )
  }
  const given = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''
  if (!sameDigest(await sha256Bytes(given), await sha256Bytes(token))) {
    return refuse(401, 'admin', 'not authorised', { 'www-authenticate': 'Bearer' })
  }
  return null
}

/**
 * The answer for a database that 0002 has not reached, or null when `e` is
 * some other failure (BE-9: the lap and TV doors both ended in this).
 */
export const unmigratedRefusal = (e: unknown): Response | null =>
  isMissingTable(e)
    ? refuse(
        503,
        'unmigrated',
        'this database has not had migrations/0002_moderation.sql applied (docs/lap-server.md)',
      )
    : null

/** An admin route: the handler a Function is a shell over. */
export type AdminRoute = (request: Request, env: LapEnv, now: number) => Promise<Response>

type Handler = (request: Request, db: D1Database, now: number) => Promise<Response>

/**
 * The one door. The secret, then the database, then the log's retention, then
 * the route; a database 0002 has not reached answers `unmigrated`.
 */
const guarded =
  (handler: Handler): AdminRoute =>
  async (request, env, now) => {
    const refused = await adminRefusal(request, env)
    if (refused) return refused
    const db = env.LAPS_DB
    if (!db) return refuse(503, 'unconfigured', 'the lap server has no database bound')
    try {
      await db.prepare('SELECT 1 FROM blocks LIMIT 1').all()
      await sweepAdminLog(db, now)
      return await handler(request, db, now)
    } catch (e) {
      const unmigrated = unmigratedRefusal(e)
      if (unmigrated) return unmigrated
      throw e
    }
  }

// ── Shared pieces ─────────────────────────────────────────────────────────

/** A lap as the admin sees it: everything but the poses, the owner as its hash. */
interface AdminLapRow {
  id: string
  mission: string
  mode: string
  edition: string
  variant: string
  rules: string
  vehicle: string
  build: string
  handle: string
  owner_hash: string
  ticks: number
  seconds: number
  rings: number
  rings_total: number
  distance: number
  score2016: number
  board: number
  created_at: number
  expires_at: number | null
}

const LAP_COLUMNS =
  'id, mission, mode, edition, variant, rules, vehicle, build, handle, owner_hash, ticks, seconds, ' +
  'rings, rings_total, distance, score2016, board, created_at, expires_at'

const lapView = (r: AdminLapRow, now: number) => ({
  id: r.id,
  mission: r.mission,
  mode: r.mode,
  edition: r.edition,
  variant: r.variant,
  rules: r.rules,
  vehicle: r.vehicle,
  build: r.build,
  handle: r.handle,
  owner: r.owner_hash,
  ticks: r.ticks,
  seconds: r.seconds,
  rings: r.rings,
  ringsTotal: r.rings_total,
  distance: r.distance,
  score2016: r.score2016,
  board: r.board === 1,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  // Expired and not yet swept: served to nobody, still in the table.
  expired: r.expires_at !== null && r.expires_at <= now,
})

/** An admin's reason, trimmed and capped; "" when none was given. */
export const reasonOf = (text: unknown): string =>
  typeof text === 'string' ? text.trim().slice(0, ADMIN_REASON_MAX) : ''

/** One `admin_log` row: the audit log's whole vocabulary of actions is this union. */
export interface AdminLogEntry {
  readonly action: 'delete-lap' | 'wipe-handle' | 'block' | 'unblock' | 'off-air' | 'on-air'
  readonly target: string
  readonly count: number
  readonly reason: string
  readonly detail: unknown
}

/** One log row, as a statement to batch with the change it records. */
export const logged = (db: D1Database, now: number, entry: AdminLogEntry): D1PreparedStatement =>
  db
    .prepare(
      'INSERT INTO admin_log (at, action, target, count, reason, detail) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(now, entry.action, entry.target, entry.count, entry.reason, JSON.stringify(entry.detail))

const params = (request: Request): URLSearchParams => new URL(request.url).searchParams

// ── DELETE /api/admin/laps?id= ────────────────────────────────────────────

/** Delete any lap, whoever posted it. */
export const adminDeleteLap: AdminRoute = guarded(async (request, db, now) => {
  const q = params(request)
  const id = q.get('id') ?? ''
  if (!ID_SHAPE.test(id)) return refuse(400, 'id', 'not a lap id')
  const row = await db
    .prepare(`SELECT ${LAP_COLUMNS} FROM laps WHERE id = ?`)
    .bind(id)
    .first<AdminLapRow>()
  if (!row) return refuse(404, 'gone', 'no such lap')
  const view = lapView(row, now)
  await db.batch([
    db.prepare('DELETE FROM laps WHERE id = ?').bind(id),
    logged(db, now, {
      action: 'delete-lap',
      target: id,
      count: 1,
      reason: reasonOf(q.get('reason')),
      detail: view,
    }),
  ])
  return json(200, { deleted: 1, lap: view })
})

// ── DELETE /api/admin/handles?handle= ─────────────────────────────────────

/**
 * Wipe a handle: every lap posted under it, whichever devices posted them, and
 * — unless `block=0` — retire it, so the generated list can never hand it out
 * again. This is D30's "slur in slot two": the NAME is the problem. For a
 * cheat, block the device instead (`POST /api/admin/blocks`).
 */
export const adminWipeHandle: AdminRoute = guarded(async (request, db, now) => {
  const q = params(request)
  const handle = q.get('handle') ?? ''
  if (!isHandle(handle)) return refuse(400, 'handle', 'not a handle the game generates')
  const retire = q.get('block') !== '0'
  const reason = reasonOf(q.get('reason'))
  const rows = await db
    .prepare(`SELECT ${LAP_COLUMNS} FROM laps WHERE handle = ?`)
    .bind(handle)
    .all<AdminLapRow>()
  const statements = [
    db.prepare('DELETE FROM laps WHERE handle = ?').bind(handle),
    logged(db, now, {
      action: 'wipe-handle',
      target: handle,
      count: rows.results.length,
      reason,
      detail: { retired: retire, laps: rows.results.map((r) => lapView(r, now)) },
    }),
  ]
  if (retire) {
    statements.push(
      db
        .prepare(
          "INSERT INTO blocks (kind, value, reason, created_at) VALUES ('handle', ?, ?, ?) " +
            'ON CONFLICT(kind, value) DO NOTHING',
        )
        .bind(handle, reason, now),
    )
  }
  await db.batch(statements)
  return json(200, {
    handle,
    deleted: rows.results.length,
    blocked: retire,
    laps: rows.results.map((r) => r.id),
  })
})

// ── /api/admin/blocks ─────────────────────────────────────────────────────

interface BlockRow {
  kind: BlockKind
  value: string
  reason: string
  created_at: number
}

const blockView = (r: BlockRow) => ({
  kind: r.kind,
  value: r.value,
  reason: r.reason,
  createdAt: r.created_at,
})

/** Every block, newest first. */
export const adminListBlocks: AdminRoute = guarded(async (_request, db) => {
  const rows = await db
    .prepare('SELECT kind, value, reason, created_at FROM blocks ORDER BY created_at DESC, value')
    .all<BlockRow>()
  return json(200, { blocks: rows.results.map(blockView) })
})

/**
 * Block a device or a handle. A device is named by its owner-key hash (the
 * audit shows it) or, more usually, by one of its laps: `{ kind: 'owner', lap:
 * '<id>' }` blocks whoever posted that lap. `wipe: true` also deletes every lap
 * the block covers.
 */
export const adminBlock: AdminRoute = guarded(async (request, db, now) => {
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(await request.text())
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return refuse(400, 'body', 'the body is not a JSON object')
  }
  const kind = body.kind
  let value = typeof body.value === 'string' ? body.value : ''
  if (kind === 'owner') {
    if (typeof body.lap === 'string') {
      if (!ID_SHAPE.test(body.lap)) return refuse(400, 'lap', '`lap` is not a lap id')
      const row = await db
        .prepare('SELECT owner_hash FROM laps WHERE id = ?')
        .bind(body.lap)
        .first<{ owner_hash: string }>()
      if (!row) return refuse(404, 'gone', 'no such lap, so no device to block')
      value = row.owner_hash
    }
    if (!OWNER_HASH_SHAPE.test(value)) {
      return refuse(400, 'value', 'an owner block takes `lap` (an id) or `value` (a 64-hex hash)')
    }
  } else if (kind === 'handle') {
    if (!isHandle(value)) return refuse(400, 'value', '`value` is not a handle the game generates')
  } else {
    return refuse(400, 'kind', "`kind` is 'owner' or 'handle'")
  }
  const reason = reasonOf(body.reason)
  const column = kind === 'owner' ? 'owner_hash' : 'handle'
  const wiped =
    body.wipe === true
      ? (
          await db
            .prepare(`SELECT ${LAP_COLUMNS} FROM laps WHERE ${column} = ?`)
            .bind(value)
            .all<AdminLapRow>()
        ).results
      : []
  const statements = [
    db
      .prepare(
        'INSERT INTO blocks (kind, value, reason, created_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(kind, value) DO UPDATE SET reason = excluded.reason',
      )
      .bind(kind, value, reason, now),
    logged(db, now, {
      action: 'block',
      target: `${kind}:${value}`,
      count: wiped.length,
      reason,
      detail: { laps: wiped.map((r) => lapView(r, now)) },
    }),
  ]
  if (body.wipe === true) {
    statements.push(db.prepare(`DELETE FROM laps WHERE ${column} = ?`).bind(value))
  }
  await db.batch(statements)
  return json(201, { kind, value, wiped: wiped.length, laps: wiped.map((r) => r.id) })
})

/** Lift a block. */
export const adminUnblock: AdminRoute = guarded(async (request, db, now) => {
  const q = params(request)
  const kind = q.get('kind') ?? ''
  const value = q.get('value') ?? ''
  if (kind !== 'owner' && kind !== 'handle') {
    return refuse(400, 'kind', "`kind` is 'owner' or 'handle'")
  }
  const row = await db
    .prepare('SELECT kind, value, reason, created_at FROM blocks WHERE kind = ? AND value = ?')
    .bind(kind, value)
    .first<BlockRow>()
  if (!row) return refuse(404, 'gone', 'no such block')
  await db.batch([
    db.prepare('DELETE FROM blocks WHERE kind = ? AND value = ?').bind(kind, value),
    logged(db, now, {
      action: 'unblock',
      target: `${kind}:${value}`,
      count: 0,
      reason: reasonOf(q.get('reason')),
      detail: blockView(row),
    }),
  ])
  return json(200, { lifted: blockView(row) })
})

// ── GET /api/admin/audit ──────────────────────────────────────────────────

/**
 * What the server holds, as no public route shows it: laps newest first with
 * their owner hash, build and distance (filtered by `id`, `handle`, `owner`,
 * `mission`), the totals, today's accepted laps against the cap (`submits`;
 * since S-02 only laps the validator took count), every block, and the log
 * newest first.
 */
export const adminAudit: AdminRoute = guarded(async (request, db, now) => {
  const q = params(request)
  const asked = Number(q.get('limit') ?? 100)
  const limit =
    Number.isInteger(asked) && asked > 0 ? Math.min(asked, ADMIN_AUDIT_MAX) : ADMIN_AUDIT_MAX
  const where: string[] = []
  const values: unknown[] = []
  const filter = (name: string, column: string, shape: (v: string) => boolean): string | null => {
    const v = q.get(name)
    if (v === null) return null
    if (!shape(v)) return `\`${name}\` is not a ${name}`
    where.push(`${column} = ?`)
    values.push(v)
    return null
  }
  const bad =
    filter('id', 'id', (v) => ID_SHAPE.test(v)) ??
    filter('handle', 'handle', isHandle) ??
    filter('owner', 'owner_hash', (v) => OWNER_HASH_SHAPE.test(v)) ??
    filter('mission', 'mission', (v) => /^[A-Za-z0-9_]{1,64}$/.test(v))
  if (bad) return refuse(400, 'filter', bad)
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

  const laps = await db
    .prepare(`SELECT ${LAP_COLUMNS} FROM laps ${clause} ORDER BY created_at DESC, id LIMIT ?`)
    .bind(...values, limit)
    .all<AdminLapRow>()
  const totals = await db
    .prepare(
      'SELECT COUNT(*) AS laps, COALESCE(SUM(board), 0) AS board, ' +
        '(SELECT COUNT(*) FROM blocks) AS blocks FROM laps',
    )
    .first<{ laps: number; board: number; blocks: number }>()
  const today = await db
    .prepare('SELECT count FROM rate WHERE bucket = ?')
    .bind(`*:${Math.floor(now / DAY_MS)}`)
    .first<{ count: number }>()
  const blocks = await db
    .prepare(
      'SELECT kind, value, reason, created_at FROM blocks ORDER BY created_at DESC, value LIMIT ?',
    )
    .bind(limit)
    .all<BlockRow>()
  const log = await db
    .prepare(
      'SELECT at, action, target, count, reason, detail FROM admin_log ORDER BY at DESC, id DESC LIMIT ?',
    )
    .bind(limit)
    .all<{
      at: number
      action: string
      target: string
      count: number
      reason: string
      detail: string
    }>()

  return json(200, {
    now,
    totals: {
      laps: totals?.laps ?? 0,
      board: totals?.board ?? 0,
      shared: (totals?.laps ?? 0) - (totals?.board ?? 0),
      blocks: totals?.blocks ?? 0,
    },
    today: { submits: today?.count ?? 0, cap: LAP_DAILY_CAP },
    laps: laps.results.map((r) => lapView(r, now)),
    blocks: blocks.results.map(blockView),
    log: log.results.map((r) => ({
      at: r.at,
      action: r.action,
      target: r.target,
      count: r.count,
      reason: r.reason,
      detail: JSON.parse(r.detail) as unknown,
    })),
  })
})
