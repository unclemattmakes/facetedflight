// src/net/stats-server.ts: POST /api/stats: gameplay statistics into Workers
// Analytics Engine. DEV-589; docs/plan/ANALYTICS.md §4.4, docs/stats.md.
//
// `functions/api/stats.ts` is a one-line shell over `postStats`. What this does,
// in order:
//
//   1. Refuse a body that is too big, or from another site's page. A beacon
//      from our own page carries our own Origin; a missing Origin is let through
//      (some browsers omit it on a same-origin beacon), a foreign one is not.
//   2. Parse `{ rows: [...] }`, at most `STATS_MAX_ROWS`.
//   3. Check each row against `stats-schema.ts`: its kind exists, every field it
//      names is in that kind's list, every field in the list is present, every
//      enum value is in its list, every shape matches, every number is finite
//      and is clamped. A row that fails ANY of that is dropped whole. No field
//      the schema does not name is ever written, which is also what keeps free
//      text, and anything a modified client tries to add, out of the dataset.
//   4. Write each surviving row with `writeDataPoint`.
//   5. Answer 204 whatever happened, so the game never retries and never waits;
//      except for a bug report (DEV-622), the one row a player waits on, which
//      is answered 200 with the report's short id as their receipt.
//
// What this never does: read the client's address, set or read a cookie, or
// write any value the game did not send other than the schema version, the
// country Cloudflare attaches to the request (on a visit row only, ANALYTICS.md
// §7 call 3) and an error row's index, which is a hash made here.
//
// With no `STATS` binding (a local `wrangler pages dev`, or a deploy before the
// binding is added) it validates and writes nothing: the game cannot tell.
//
// SERVER-SAFE: web platform only, no DOM, no clock.

import { hexOfBytes, sha256Bytes } from './digest'
import { json, readCapped } from './http'
import { cryptoFill, randomIdOver } from './random-id'
import {
  cleanErrorMessage,
  numberFields,
  STATS_BUG_ID_ALPHABET,
  STATS_BUG_ID_LENGTH,
  STATS_KINDS,
  STATS_MAX_BODY,
  STATS_MAX_ROWS,
  STATS_SCHEMA,
  type StatsField,
  type StatsKind,
  textFields,
} from './stats-schema'

/** The slice of Workers Analytics Engine this uses. */
export interface AnalyticsEngineDataset {
  writeDataPoint(point: {
    readonly blobs?: readonly (string | null)[]
    readonly doubles?: readonly number[]
    readonly indexes?: readonly (string | null)[]
  }): void
}

/** The Pages project's binding. `ff10yr_stats` on production, `ff10yr_stats_preview` on preview (underscores: the dataset name is the SQL table name). */
export interface StatsEnv {
  readonly STATS?: AnalyticsEngineDataset
}

/** One row as it is written: Analytics Engine's three arrays. */
export interface StatsPoint {
  readonly blobs: string[]
  readonly doubles: number[]
  readonly indexes: [string]
}

/** What a request came to. The HTTP answer is 204 either way; tests read this. */
export interface StatsOutcome {
  readonly written: number
  readonly dropped: number
  readonly refused?: 'too-big' | 'foreign-origin' | 'not-json'
  /** The ids of the bug reports written (DEV-622), which the answer carries. */
  readonly bugIds?: readonly string[]
}

const NO_CONTENT = (): Response =>
  new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })

/** Cloudflare's country for the request: two capitals, `XX` when it has none, `T1` for Tor. */
const countryOf = (request: Request): string => {
  const cf = (request as Request & { readonly cf?: { readonly country?: unknown } }).cf
  const c = cf?.country
  return typeof c === 'string' && /^[A-Z][A-Z0-9]$/.test(c) ? c : 'XX'
}

const sha256Hex16 = async (text: string): Promise<string> =>
  hexOfBytes((await sha256Bytes(text)).slice(0, 8))

/** A bug report's id (DEV-622): uniform over the alphabet, bytes past its last whole multiple rerolled. */
export const newBugId = (): string =>
  randomIdOver(STATS_BUG_ID_ALPHABET, STATS_BUG_ID_LENGTH, cryptoFill)

const textOk = (field: StatsField, value: unknown): value is string => {
  if (typeof value !== 'string') return false
  if (field.kind === 'enum') return field.values.includes(value)
  if (field.kind === 'shape') return field.pattern.test(value)
  return false
}

const numberOf = (field: StatsField, value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (field.kind === 'flag') return value === 0 || value === 1 ? value : null
  if (field.kind === 'count' || field.kind === 'seconds') {
    return Math.min(field.max, Math.max(0, Math.round(value)))
  }
  return null
}

/**
 * A row as Analytics Engine takes it, or null if it may not be written. Pure,
 * apart from the error index's hash; the request only lends its country.
 */
export const toPoint = async (raw: unknown, country: string): Promise<StatsPoint | null> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const kind = row.k
  if (typeof kind !== 'string' || !Object.hasOwn(STATS_KINDS, kind)) return null
  const fields = STATS_KINDS[kind as StatsKind]
  const names = new Set(fields.map((f) => f.name))
  for (const key of Object.keys(row)) if (key !== 'k' && !names.has(key)) return null

  // An error's words are cleaned BEFORE the shape check, so the shape judges
  // what would be kept.
  const values: Record<string, unknown> = { ...row }
  if (kind === 'error' && typeof values.message === 'string') {
    values.message = cleanErrorMessage(values.message)
  }
  if (kind === 'bug') {
    for (const name of ['error1', 'error2', 'error3']) {
      const v = values[name]
      if (typeof v === 'string' && v !== 'none') values[name] = cleanErrorMessage(v) || '(empty)'
    }
  }

  const blobs: string[] = [kind, STATS_SCHEMA]
  for (const f of textFields(fields)) {
    const v = values[f.name]
    if (!textOk(f, v)) return null
    blobs.push(v)
  }
  const doubles: number[] = []
  for (const f of numberFields(fields)) {
    const n = numberOf(f, values[f.name])
    if (n === null) return null
    doubles.push(n)
  }

  let index: string
  if (kind === 'visit') {
    blobs.push(country)
    index = 'visit'
  } else if (kind === 'attempt' || kind === 'crash') {
    index = values.mission as string
  } else if (kind === 'bug') {
    index = newBugId()
  } else {
    index = await sha256Hex16(`${values.message as string}\n${values.frame as string}`)
  }
  return { blobs, doubles, indexes: [index] }
}

/** The handler behind `POST /api/stats`, with what happened, for tests. */
export const acceptStats = async (request: Request, env: StatsEnv): Promise<StatsOutcome> => {
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== new URL(request.url).origin) {
    return { written: 0, dropped: 0, refused: 'foreign-origin' }
  }
  // DEV-676: refused WHILE reading, in bytes. This read `request.text()` and
  // measured afterwards, trusting a Content-Length that a chunked or lying
  // body does not honour.
  const text = await readCapped(request, STATS_MAX_BODY)
  if (text === null) return { written: 0, dropped: 0, refused: 'too-big' }

  let rows: unknown
  try {
    rows = (JSON.parse(text) as { rows?: unknown }).rows
  } catch {
    return { written: 0, dropped: 0, refused: 'not-json' }
  }
  if (!Array.isArray(rows)) return { written: 0, dropped: 0, refused: 'not-json' }

  const country = countryOf(request)
  const bugIds: string[] = []
  let written = 0
  let dropped = Math.max(0, rows.length - STATS_MAX_ROWS)
  for (const raw of rows.slice(0, STATS_MAX_ROWS)) {
    const point = await toPoint(raw, country)
    if (point === null) {
      dropped++
      continue
    }
    env.STATS?.writeDataPoint(point)
    if (env.STATS) {
      written++
      if (point.blobs[0] === 'bug') bugIds.push(point.indexes[0])
    }
  }
  return bugIds.length > 0 ? { written, dropped, bugIds } : { written, dropped }
}

export const postStats = async (request: Request, env: StatsEnv): Promise<Response> => {
  const outcome = await acceptStats(request, env)
  // A bug report is the one row the player waits on: its id is their receipt.
  const id = outcome.bugIds?.[0]
  if (id !== undefined) {
    return json(200, { id })
  }
  return NO_CONTENT()
}
