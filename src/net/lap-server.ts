// src/net/lap-server.ts — the lap server's handlers, over a D1 binding. DEV-372.
//
// `functions/api/**` are one-line shells over these, so everything a request
// can do is testable in node against a real SQLite (`tests/unit/lap-server.test.ts`
// binds `node:sqlite` behind the few D1 methods used here). What is NOT here:
//
//   - judging a lap, which is `lap-validate.ts` and pure;
//   - the admin routes (delete any lap, wipe a handle, block, audit), which
//     are `lap-admin.ts` (DEV-374). The one thing of theirs the submit path
//     does is read `blocks`, below.
//
// ── Bindings (docs/lap-server.md) ─────────────────────────────────────────
//
//   LAPS_DB    the D1 database. `ff10yr-laps` on production, `ff10yr-laps-preview`
//              on preview, a LOCAL one under `wrangler pages dev`.
//   IP_SALT    a secret. Salts the address hash the rate limit counts by. With no
//              salt the server refuses submits rather than count raw addresses.
//   ADMIN_TOKEN  a secret, read by DEV-374's routes (`lap-admin.ts`) and by
//              nothing here.
//
// ── Endpoints ─────────────────────────────────────────────────────────────
//
//   POST   /api/laps                      submit: { lap, seconds, handle, owner }
//   GET    /api/laps?id=<id>              one lap, to race
//   DELETE /api/laps?id=<id>              your own lap; the owner key in `X-FF-Owner`
//   GET    /api/board/<mission>/<mode>/<edition>/<variant>
//                                         the current board, fastest first; one
//                                         per aircraft variant (DEV-380)
//
// SERVER-SAFE: web platform only (fetch types, `crypto`), no DOM, no three, no
// game layer. The clock comes in as an argument.

import { fromBase64url, toBase64url } from './base64url'
import { sha256HexAsync } from './digest'
import { isHandle } from './handles'
import { json, readCapped, refuse } from './http'
import { LAP_COURSES, type LapCourses, lapCourse, lapRules } from './lap-courses'
import {
  ADMIN_LOG_DAYS,
  LAP_BOARD_SIZE,
  LAP_BODY_MAX,
  LAP_DAILY_CAP,
  LAP_ID_LENGTH,
  LAP_SHARE_TTL_DAYS,
  LAP_SUBMITS_PER_HOUR,
} from './lap-policy'
import { validateCompressedLap } from './lap-validate'
import { cryptoFill, randomIdOver } from './random-id'

// ── The slice of D1 this uses ─────────────────────────────────────────────

export interface D1Result<T = Record<string, unknown>> {
  readonly results: T[]
  readonly success: boolean
  readonly meta?: { readonly changes?: number }
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  run(): Promise<D1Result>
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>
}

/** The Pages project's bindings, by the names that already exist (PLAYER-GHOSTS §5). */
export interface LapEnv {
  readonly LAPS_DB?: D1Database
  readonly IP_SALT?: string
  readonly ADMIN_TOKEN?: string
}

// ── Responses ─────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** A lap id: base62, `LAP_ID_LENGTH` characters. The whole of a share link. */
export const ID_SHAPE = new RegExp(`^[0-9A-Za-z]{${LAP_ID_LENGTH}}$`)
/** A device's owner key: random, made and kept by the client; at least 128 bits of base64url. */
const OWNER_SHAPE = /^[A-Za-z0-9_-]{22,128}$/

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** A fresh lap id, uniform over base62 (bytes >= 248 are rerolled, so `% 62` is unbiased). */
export const newLapId = (): string => randomIdOver(BASE62, LAP_ID_LENGTH, cryptoFill)

/**
 * What the hourly limit counts an address as (S-03, docs/SECURITY-AUDIT.md):
 * an IPv4 address whole, an IPv6 address by its first 64 bits, the network a
 * single client is normally handed (RFC 6177), so rotating through it is one
 * sender. Spellings of one address agree (`::` expanded, case and leading
 * zeros dropped). Anything that does not parse as IPv6 passes through whole.
 */
export const rateKey = (address: string): string => {
  if (!address.includes(':')) return address
  const halves = address.toLowerCase().split('::')
  if (halves.length > 2) return address
  const groupsOf = (part: string | undefined) => (part ? part.split(':') : [])
  const left = groupsOf(halves[0])
  const right = groupsOf(halves[1])
  // An embedded IPv4 tail (`::ffff:1.2.3.4`) fills two groups.
  const width = right.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0)
  const groups =
    halves.length === 2 ? [...left, ...Array(Math.max(0, 8 - left.length - width)).fill('0')] : left
  const network = groups.slice(0, 4)
  while (network.length < 4) network.push(right.shift() ?? '0')
  if (!network.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return address
  return `${network.map((g) => Number.parseInt(g, 16).toString(16)).join(':')}::/64`
}

/** Count one submit in `bucket`, and return the count including it. */
const count = async (db: D1Database, bucket: string, win: number): Promise<number> => {
  const row = await db
    .prepare(
      'INSERT INTO rate (bucket, win, count) VALUES (?, ?, 1) ' +
        'ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count',
    )
    .bind(bucket, win)
    .first<{ count: number }>()
  return row?.count ?? 1
}

// ── Moderation, as the submit path sees it (DEV-374) ──────────────────────
//
// `migrations/0002_moderation.sql` adds `blocks` and `admin_log`, and
// `lap-admin.ts` writes them. A submit does two things with them: it refuses
// a blocked device or handle, and it sweeps the log past its retention. Both
// read a MISSING table as empty, because until 0002 is applied there can be
// no blocks and no log — so deploying this before the migration cannot break
// a submit (the admin routes say `unmigrated` instead).

/** D1 and SQLite both say this, in their own framing, for a table that is not there. */
export const isMissingTable = (e: unknown): boolean =>
  e instanceof Error && /no such table/i.test(e.message)

/** What blocks a submit: the device, the handle, or nothing. */
export const blockOf = async (
  db: D1Database,
  ownerHash: string,
  handle: string,
): Promise<'owner' | 'handle' | null> => {
  try {
    const row = await db
      .prepare(
        "SELECT kind FROM blocks WHERE (kind = 'owner' AND value = ?) OR (kind = 'handle' AND value = ?) " +
          "ORDER BY kind = 'owner' DESC LIMIT 1",
      )
      .bind(ownerHash, handle)
      .first<{ kind: 'owner' | 'handle' }>()
    return row?.kind ?? null
  } catch (e) {
    if (isMissingTable(e)) return null
    throw e
  }
}

/** Delete log rows older than `ADMIN_LOG_DAYS`. What `/privacy` says about the log rests on it. */
export const sweepAdminLog = async (db: D1Database, now: number): Promise<void> => {
  try {
    await db
      .prepare('DELETE FROM admin_log WHERE at < ?')
      .bind(now - ADMIN_LOG_DAYS * DAY_MS)
      .run()
  } catch (e) {
    if (!isMissingTable(e)) throw e
  }
}

// ── POST /api/laps ────────────────────────────────────────────────────────

interface SubmitBody {
  readonly lap: string
  readonly seconds: number
  readonly handle: string
  readonly owner: string
}

const parseSubmit = (text: string): SubmitBody | string => {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return 'the body is not JSON'
  }
  if (body === null || typeof body !== 'object') return 'the body is not an object'
  const b = body as Record<string, unknown>
  if (typeof b.lap !== 'string') return '`lap` is not base64url text'
  if (typeof b.seconds !== 'number' || !Number.isFinite(b.seconds))
    return '`seconds` is not a number'
  if (!isHandle(b.handle)) return '`handle` is not one the game generates'
  if (typeof b.owner !== 'string' || !OWNER_SHAPE.test(b.owner))
    return '`owner` is not an owner key'
  return { lap: b.lap, seconds: b.seconds, handle: b.handle, owner: b.owner }
}

/**
 * Submit a lap. Counted against the address before anything else is read, so
 * a stream of garbage costs its sender the same as a stream of laps.
 */
export const submitLap = async (
  request: Request,
  env: LapEnv,
  now: number,
  courses: LapCourses = LAP_COURSES,
): Promise<Response> => {
  const db = env.LAPS_DB
  if (!db || !env.IP_SALT) {
    return refuse(503, 'unconfigured', 'the lap server has no database or no IP salt bound')
  }
  const hour = Math.floor(now / HOUR_MS)
  const dayStart = Math.floor(now / DAY_MS) * 24

  // Housekeeping on EVERY submit, refused or not, before anything else: expired
  // laps, and rate rows a day past the hour they count. What `/privacy` says
  // about how long an address hash lives rests on this running on the next
  // request, whoever sends it — so it cannot sit behind a check that fails.
  await db.batch([
    db.prepare('DELETE FROM laps WHERE expires_at IS NOT NULL AND expires_at < ?').bind(now),
    db.prepare('DELETE FROM rate WHERE win < ?').bind(hour - 24),
  ])
  // DEV-374: and the moderation log past its retention. Its own statement, not
  // in the batch above: it tolerates a database 0002 has not reached yet.
  await sweepAdminLog(db, now)

  // Rate: per salted address per hour. Before the body is read, so an
  // oversize body is counted like any other. An IPv6 address counts by its
  // /64 (`rateKey`): one client usually holds the whole network.
  const address = rateKey(request.headers.get('cf-connecting-ip') ?? 'unknown')
  const who = await sha256HexAsync(`${env.IP_SALT}:${address}`)
  if ((await count(db, `${who}:${hour}`, hour)) > LAP_SUBMITS_PER_HOUR) {
    return refuse(429, 'rate', `more than ${LAP_SUBMITS_PER_HOUR} submits this hour`, {
      'retry-after': String(Math.ceil(((hour + 1) * HOUR_MS - now) / 1000)),
    })
  }

  const text = await readCapped(request, LAP_BODY_MAX)
  if (text === null) return refuse(413, 'size', `the body is over ${LAP_BODY_MAX} bytes`)
  const body = parseSubmit(text)
  if (typeof body === 'string') return refuse(400, 'body', body)
  const compressed = fromBase64url(body.lap)
  if (!compressed) return refuse(400, 'body', '`lap` is not base64url text')

  // DEV-374: a device or a handle the admin routes blocked posts nothing.
  // Before the validator, which is the expensive part; after the rate count,
  // so a blocked device's retries cost it like anybody's.
  const ownerHash = await sha256HexAsync(body.owner)
  const blocked = await blockOf(db, ownerHash, body.handle)
  if (blocked === 'owner') return refuse(403, 'blocked', 'this device may not post laps')
  if (blocked === 'handle') {
    return refuse(403, 'blocked', 'that name is retired: share again and pick another')
  }

  const verdict = await validateCompressedLap(compressed, { seconds: body.seconds }, courses)
  if (!verdict.ok) return refuse(422, verdict.stage, verdict.reason)

  // The whole server per day, on laps it would STORE (S-02, docs/SECURITY-AUDIT.md).
  // `LAP_DAILY_CAP` budgets storage for new laps; counted before the body was
  // read, a few addresses sending `{}` filled it and closed every board for
  // the day. The hourly count above still charges garbage to its sender.
  if ((await count(db, `*:${dayStart / 24}`, dayStart)) > LAP_DAILY_CAP) {
    return refuse(503, 'full', 'the server has taken all the laps it will take today')
  }
  const { doc, score } = verdict

  // One place per device per board: the better of its laps. The other one is
  // demoted to a shared lap, raceable from its link for the TTL.
  const key = [doc.mission, doc.mode, doc.edition, verdict.variant, doc.rules] as const
  const expires = now + LAP_SHARE_TTL_DAYS * DAY_MS
  let board = verdict.board
  let boardReason = verdict.boardReason
  if (board) {
    const mine = await db
      .prepare(
        'SELECT id, seconds FROM laps WHERE mission = ? AND mode = ? AND edition = ? AND variant = ? AND rules = ? ' +
          'AND board = 1 AND owner_hash = ?',
      )
      .bind(...key, ownerHash)
      .all<{ id: string; seconds: number }>()
    for (const old of mine.results) {
      if (old.seconds <= score.seconds) {
        board = false
        // DEV-571: short enough for the panel's row, in its words.
        boardReason = `your ${old.seconds.toFixed(1)} s lap is already ranked`
      }
    }
    if (board && mine.results.length > 0) {
      await db.batch(
        mine.results.map((old) =>
          db
            .prepare('UPDATE laps SET board = 0, expires_at = ? WHERE id = ?')
            .bind(expires, old.id),
        ),
      )
    }
  }

  let id = ''
  for (let attempt = 0; ; attempt++) {
    id = newLapId()
    try {
      await db
        .prepare(
          'INSERT INTO laps (id, mission, mode, edition, variant, rules, vehicle, build, handle, owner_hash, ' +
            'ticks, seconds, rings, rings_total, distance, score2016, board, created_at, expires_at, lap) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          id,
          ...key,
          // The vehicle alone: the variant half of `<vehicle>:<variant>` is its own column.
          doc.vehicle.split(':')[0] as string,
          doc.build.slice(0, 64),
          body.handle,
          ownerHash,
          score.ticks,
          score.seconds,
          score.rings,
          score.ringsTotal,
          score.distance,
          score.score2016,
          board ? 1 : 0,
          now,
          board ? null : expires,
          toBase64url(compressed),
        )
        .run()
      break
    } catch (e) {
      // A 59-bit id colliding is the only failure worth a second try.
      if (attempt >= 2) throw e
    }
  }

  // Prune the board to its size: whatever falls off becomes a shared lap.
  let rank: number | null = null
  if (board) {
    await db
      .prepare(
        'UPDATE laps SET board = 0, expires_at = ? WHERE id IN (' +
          'SELECT id FROM laps WHERE mission = ? AND mode = ? AND edition = ? AND variant = ? AND rules = ? AND board = 1 ' +
          'ORDER BY seconds, created_at, id LIMIT -1 OFFSET ?)',
      )
      .bind(expires, ...key, LAP_BOARD_SIZE)
      .run()
    const still = await db
      .prepare(
        'SELECT (SELECT board FROM laps WHERE id = ?) AS board, (SELECT COUNT(*) FROM laps ' +
          'WHERE mission = ? AND mode = ? AND edition = ? AND variant = ? AND rules = ? AND board = 1 ' +
          'AND (seconds < ? OR (seconds = ? AND (created_at < ? OR (created_at = ? AND id < ?))))) AS ahead',
      )
      .bind(id, ...key, score.seconds, score.seconds, now, now, id)
      .first<{ board: number; ahead: number }>()
    board = still?.board === 1
    rank = board ? (still?.ahead ?? 0) + 1 : null
    if (!board) boardReason = `not in the top ${LAP_BOARD_SIZE}`
  }

  return json(201, {
    id,
    variant: verdict.variant,
    seconds: score.seconds,
    ticks: score.ticks,
    rings: score.rings,
    ringsTotal: score.ringsTotal,
    score2016: score.score2016,
    board,
    rank,
    boardReason,
    expiresAt: board ? null : expires,
  })
}

// ── GET /api/laps?id= ─────────────────────────────────────────────────────

interface LapRow {
  id: string
  mission: string
  mode: string
  edition: string
  variant: string
  rules: string
  vehicle: string
  handle: string
  ticks: number
  seconds: number
  rings: number
  rings_total: number
  score2016: number
  board: number
  created_at: number
  expires_at: number | null
  lap: string
}

export const getLap = async (request: Request, env: LapEnv, now: number): Promise<Response> => {
  const db = env.LAPS_DB
  if (!db) return refuse(503, 'unconfigured', 'the lap server has no database bound')
  const id = new URL(request.url).searchParams.get('id') ?? ''
  if (!ID_SHAPE.test(id)) return refuse(400, 'id', 'not a lap id')
  const row = await db
    .prepare(
      'SELECT id, mission, mode, edition, variant, rules, vehicle, handle, ticks, seconds, rings, rings_total, ' +
        'score2016, board, created_at, expires_at, lap FROM laps ' +
        'WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)',
    )
    .bind(id, now)
    .first<LapRow>()
  if (!row) return refuse(404, 'gone', 'no such lap, or it has expired')
  return json(
    200,
    {
      id: row.id,
      mission: row.mission,
      mode: row.mode,
      edition: row.edition,
      variant: row.variant,
      rules: row.rules,
      vehicle: row.vehicle,
      handle: row.handle,
      ticks: row.ticks,
      seconds: row.seconds,
      rings: row.rings,
      ringsTotal: row.rings_total,
      score2016: row.score2016,
      board: row.board === 1,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      // Deflated `ff2-ghost-2`, base64url: `lapFromBytes` after an inflate.
      lap: row.lap,
    },
    // A lap never changes; it can only be deleted, so a minute of cache.
    { 'cache-control': 'public, max-age=60' },
  )
}

// ── DELETE /api/laps?id= ──────────────────────────────────────────────────

/**
 * Delete your own lap. The owner key travels in a header, never the URL,
 * which access logs keep. A wrong key and a missing lap answer alike, so the
 * endpoint cannot be used to learn which ids exist.
 */
export const deleteLap = async (request: Request, env: LapEnv): Promise<Response> => {
  const db = env.LAPS_DB
  if (!db) return refuse(503, 'unconfigured', 'the lap server has no database bound')
  const id = new URL(request.url).searchParams.get('id') ?? ''
  const owner = request.headers.get('x-ff-owner') ?? ''
  if (!ID_SHAPE.test(id) || !OWNER_SHAPE.test(owner)) {
    return refuse(400, 'id', 'a lap id and an owner key are both required')
  }
  const result = await db
    .prepare('DELETE FROM laps WHERE id = ? AND owner_hash = ?')
    .bind(id, await sha256HexAsync(owner))
    .run()
  if ((result.meta?.changes ?? 0) === 0) return refuse(404, 'gone', 'no such lap of yours')
  return new Response(null, { status: 204 })
}

// ── GET /api/board/<mission>/<mode>/<edition>/<variant> ───────────────────

/**
 * One board: a mission, a mode, an edition and an aircraft variant (DEV-380),
 * under the CURRENT rules. A variant the edition does not fly — anything but
 * `standard` on Classic — has no board and answers 404.
 */
export const getBoard = async (
  params: { mission: string; mode: string; edition: string; variant: string },
  request: Request,
  env: LapEnv,
  courses: LapCourses = LAP_COURSES,
): Promise<Response> => {
  const db = env.LAPS_DB
  if (!db) return refuse(503, 'unconfigured', 'the lap server has no database bound')
  const rules = lapRules(params.mission, params.edition, params.variant, courses)
  const course = lapCourse(params.mission, courses)
  if (!rules || !course || course.mode !== params.mode) {
    return refuse(404, 'board', 'no board for that mission, mode, edition and variant')
  }
  const asked = Number(new URL(request.url).searchParams.get('limit') ?? LAP_BOARD_SIZE)
  const limit =
    Number.isInteger(asked) && asked > 0 ? Math.min(asked, LAP_BOARD_SIZE) : LAP_BOARD_SIZE
  const rows = await db
    .prepare(
      'SELECT id, handle, ticks, seconds, rings, score2016, created_at FROM laps ' +
        'WHERE mission = ? AND mode = ? AND edition = ? AND variant = ? AND rules = ? AND board = 1 ' +
        'ORDER BY seconds, created_at, id LIMIT ?',
    )
    .bind(params.mission, params.mode, params.edition, params.variant, rules, limit)
    .all<{
      id: string
      handle: string
      ticks: number
      seconds: number
      rings: number
      score2016: number
      created_at: number
    }>()
  return json(
    200,
    {
      mission: params.mission,
      mode: params.mode,
      edition: params.edition,
      variant: params.variant,
      rules,
      entries: rows.results.map((r, i) => ({
        rank: i + 1,
        id: r.id,
        handle: r.handle,
        seconds: r.seconds,
        ticks: r.ticks,
        rings: r.rings,
        score2016: r.score2016,
        createdAt: r.created_at,
      })),
    },
    { 'cache-control': 'public, max-age=30' },
  )
}
