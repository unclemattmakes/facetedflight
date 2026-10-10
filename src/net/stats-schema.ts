// src/net/stats-schema.ts: what a gameplay-statistics row may hold. DEV-589.
//
// docs/plan/ANALYTICS.md is the why. The short of it: every row answers its
// questions ALONE, so no row carries a key that could join it to another row,
// to another visit or to another device. There is no user id, no session id,
// no device id, no address and no free text a player typed. This file is the
// whole list of what a row can say, and it is shared by both halves:
//
//   - the game builds rows against it (DEV-590 on), and buckets every duration
//     and frame time on the device with `bucketOf`, before anything is sent;
//   - the server (`stats-server.ts`) refuses any field not named here and any
//     value outside its list, so a modified client cannot widen it either;
//   - `/privacy` lists the fields from it (DEV-592), so the page cannot
//     describe a field the game no longer sends, or miss one it starts sending.
//
// LAYOUT. Workers Analytics Engine gives a row twenty text columns (blob1 to
// blob20), twenty numbers (double1 to double20) and one index, which is also
// its sampling key. blob1 is the row's kind and blob2 the schema version, then
// each kind's text fields in the order listed here; its numbers likewise from
// double1. `pnpm stats` (DEV-594) reads the same lists to name the columns, so
// REORDERING A LIST RENAMES HISTORY: append, or bump `STATS_SCHEMA`.
//
// SERVER-SAFE: no DOM, no clock, no game import (`lap-server-bundle.test.ts`).

/** blob2 of every row. Bump it when a field moves; append-only otherwise. */
export const STATS_SCHEMA = 's1'

/** At most this many rows in one request, and this many bytes of body. */
export const STATS_MAX_ROWS = 32
export const STATS_MAX_BODY = 16 * 1024

/**
 * A field. `enum` and `shape` are text columns; `count`, `flag` and `seconds`
 * are numbers. A count is CLAMPED, not bucketed, because a visit that sends
 * twice sends each count's increase since the last send and the reader SUMs
 * them; a duration or a frame time is BUCKETED, on the device.
 */
export type StatsField =
  | { readonly name: string; readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly name: string; readonly kind: 'shape'; readonly pattern: RegExp }
  | { readonly name: string; readonly kind: 'count'; readonly max: number }
  | { readonly name: string; readonly kind: 'flag' }
  | { readonly name: string; readonly kind: 'seconds'; readonly max: number }

// ── Buckets ────────────────────────────────────────────────────────────────

/** A bucket list: the labels, and the upper edge of each but the last. */
export interface Buckets {
  readonly labels: readonly string[]
  /** `edges[i]` is the largest value labelled `labels[i]`; the last label takes the rest. */
  readonly edges: readonly number[]
}

/** Seconds from navigation to the first settled title frame. */
export const TO_TITLE_BUCKETS: Buckets = {
  labels: ['lt5', '5-10', '10-20', '20-40', '40+'],
  edges: [5, 10, 20, 40],
}

/** A visit's length, or its time in a headset. `0` is its own label: most visits never enter VR. */
export const DURATION_BUCKETS: Buckets = {
  labels: ['0', 'lt1m', '1-3m', '3-10m', '10-30m', '30m+'],
  edges: [0, 60, 180, 600, 1800],
}

/**
 * Frame time in ms, labelled by the refresh rate it keeps up with: a frame of
 * 11.1 ms or less holds 90 Hz. The labels are the rates `render/quality.ts`
 * plans for (120, 90, 72, 60, and the 45 Hz tier), so the field speaks the
 * governor's language.
 */
export const FRAME_BUCKETS: Buckets = {
  labels: ['120', '90', '72', '60', '45', '30', 'lt30'],
  edges: [1000 / 120, 1000 / 90, 1000 / 72, 1000 / 60, 1000 / 45, 1000 / 30],
}

/** Which attempt on a course this is, from a counter the device keeps beside the personal best. */
export const ATTEMPT_BUCKETS: Buckets = {
  labels: ['1', '2-3', '4-10', '11+'],
  edges: [1, 3, 10],
}

/** A crash's height in the world, metres above the world's zero (sea level on the islands). */
export const ALTITUDE_BUCKETS: Buckets = {
  labels: ['lt25', '25-100', '100-300', '300+'],
  edges: [25, 100, 300],
}

/** A crash's position, snapped to a square this many metres on a side in the course's own frame. */
export const CRASH_CELL_METRES = 50

/** The label a value falls in. NaN and negatives fall in the first. */
export const bucketOf = (value: number, buckets: Buckets): string => {
  const { labels, edges } = buckets
  for (let i = 0; i < edges.length; i++)
    if (!(value > (edges[i] as number))) return labels[i] as string
  return labels[labels.length - 1] as string
}

/** A crash's cell: `<column>:<row>` of `CRASH_CELL_METRES` squares. */
export const crashCell = (x: number, z: number): string =>
  `${Math.floor(x / CRASH_CELL_METRES)}:${Math.floor(z / CRASH_CELL_METRES)}`

// ── Shared values ──────────────────────────────────────────────────────────

/** `BUILD_VERSION` (`boot/version.ts`): `v` and semver, nothing else. */
const BUILD = /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/
/**
 * A mission id. A SHAPE, not a list, so that a course added as data needs no
 * server change (hard rule 6). A player's own course is sent as `custom`,
 * never by its name or its content. A shape could carry a short made-up word;
 * the reader shows no cell under ten rows, which is what a one-off is.
 */
const MISSION = /^[A-Za-z0-9_]{1,48}$/
/** An aircraft variant id (`content/aircraft/`): the same reasoning. */
const VARIANT = /^[a-z0-9_]{1,24}$/

export const CHANNELS = ['release', 'preview'] as const
export const DEVICES = ['desktop', 'phone', 'tablet', 'headset', 'unknown'] as const
export const LOOKS = ['classic', 'anniversary'] as const
/** `GameMode` (`content/level-schema.ts`); `stats-schema.test.ts` holds them equal. */
export const MODES = ['ringAttack', 'targetPractice', 'freeFlight', 'energyRace', 'lesson'] as const
/** `XrBlocker` (`boot/xr-support.ts`), and `unprobed` for a visit that never asked. */
export const XR_BLOCKERS = [
  'none',
  'insecure-context',
  'no-webxr-api',
  'no-active-runtime',
  'query-rejected',
  'unprobed',
] as const

const common: readonly StatsField[] = [
  { name: 'build', kind: 'shape', pattern: BUILD },
  { name: 'channel', kind: 'enum', values: CHANNELS },
]

// ── The four kinds ─────────────────────────────────────────────────────────

/**
 * One row per page load (ANALYTICS.md §4.1): Q1 to Q3, Q6, Q7. Sent when the
 * page goes hidden; a page that comes back and is hidden again sends what
 * accrued since, so the counts SUM; `stageBefore` and `xrBefore` say what the
 * previous send already reported.
 * `country` is not here: the server adds it from the connection (§7 call 3).
 */
export const VISIT_FIELDS: readonly StatsField[] = [
  ...common,
  { name: 'device', kind: 'enum', values: DEVICES },
  { name: 'gate', kind: 'enum', values: ['ok', 'no-webgl2', 'no-asset-base', 'failed'] },
  { name: 'stage', kind: 'enum', values: ['booted', 'title', 'hangar', 'mission', 'finished'] },
  { name: 'xr', kind: 'enum', values: ['unsupported', 'offered', 'pressed', 'refused', 'started'] },
  { name: 'xrBlocker', kind: 'enum', values: XR_BLOCKERS },
  { name: 'quality', kind: 'enum', values: ['low', 'medium', 'high', 'ultra'] },
  { name: 'scale', kind: 'enum', values: ['1', '0.9', '0.8', '0.7', '0.6', 'other'] },
  { name: 'look', kind: 'enum', values: LOOKS },
  { name: 'vignette', kind: 'enum', values: ['off', 'light', 'strong'] },
  { name: 'speedFx', kind: 'enum', values: ['off', 'light', 'full'] },
  { name: 'toTitle', kind: 'enum', values: ['none', ...TO_TITLE_BUCKETS.labels] },
  { name: 'visitTime', kind: 'enum', values: DURATION_BUCKETS.labels },
  { name: 'vrTime', kind: 'enum', values: DURATION_BUCKETS.labels },
  { name: 'frameP50', kind: 'enum', values: ['none', ...FRAME_BUCKETS.labels] },
  { name: 'frameP95', kind: 'enum', values: ['none', ...FRAME_BUCKETS.labels] },
  // numbers
  /**
   * Where `stage` and `xr` stood at this visit's PREVIOUS send, as index + 1 in
   * their lists, and 0 on a visit's first row. A visit hidden twice sends twice,
   * so a funnel counts the rows where `stageBefore < S <= stage`: each visit
   * once per stage it reached, with no key between its rows. `stageBefore = 0`
   * is also what counts a visit.
   */
  { name: 'stageBefore', kind: 'count', max: 5 },
  { name: 'xrBefore', kind: 'count', max: 5 },
  { name: 'keyboard', kind: 'flag' },
  { name: 'gamepad', kind: 'flag' },
  { name: 'touch', kind: 'flag' },
  { name: 'xrControllers', kind: 'flag' },
  { name: 'horizon', kind: 'flag' },
  { name: 'qualityAuto', kind: 'flag' },
  { name: 'attempts', kind: 'count', max: 500 },
  { name: 'finishes', kind: 'count', max: 500 },
  { name: 'roomsJoined', kind: 'count', max: 100 },
  { name: 'tvWatched', kind: 'count', max: 100 },
  { name: 'editorOpened', kind: 'count', max: 100 },
  { name: 'posts', kind: 'count', max: 500 },
  { name: 'ghostSaves', kind: 'count', max: 500 },
  { name: 'hitches', kind: 'count', max: 100_000 },
  { name: 'tierDrops', kind: 'count', max: 1000 },
  { name: 'contextLosses', kind: 'count', max: 100 },
  { name: 'shaderFailures', kind: 'count', max: 100 },
  { name: 'errors', kind: 'count', max: 1000 },
]

/** One row per mission attempt, however it ends (§4.1): Q4. Index: the mission. */
export const ATTEMPT_FIELDS: readonly StatsField[] = [
  ...common,
  { name: 'device', kind: 'enum', values: DEVICES },
  { name: 'mission', kind: 'shape', pattern: MISSION },
  { name: 'mode', kind: 'enum', values: MODES },
  { name: 'look', kind: 'enum', values: LOOKS },
  { name: 'opponents', kind: 'enum', values: ['none', 'ai', 'ghosts', 'lap', 'room'] },
  { name: 'variant', kind: 'shape', pattern: VARIANT },
  { name: 'ending', kind: 'enum', values: ['finished', 'quit', 'restarted', 'left-page'] },
  { name: 'medal', kind: 'enum', values: ['none', 'bronze', 'silver', 'gold', 'platinum'] },
  { name: 'attemptNo', kind: 'enum', values: ATTEMPT_BUCKETS.labels },
  { name: 'quitTime', kind: 'enum', values: ['none', ...DURATION_BUCKETS.labels] },
  // numbers
  { name: 'ringsTaken', kind: 'count', max: 500 },
  { name: 'ringsTotal', kind: 'count', max: 500 },
  { name: 'lastRing', kind: 'count', max: 500 },
  /** A FINISH's time, whole seconds: already a leaderboard number. A quit's is `quitTime`. */
  { name: 'seconds', kind: 'seconds', max: 3600 },
  { name: 'crashes', kind: 'count', max: 1000 },
  { name: 'resets', kind: 'count', max: 1000 },
]

/**
 * One row per crash or reset, at most `STATS_CRASHES_PER_ATTEMPT` an attempt
 * (§4.1): Q5. Index: the mission. NO time, no attempt and no order, so a set
 * of them cannot be put back together into a flight.
 */
export const CRASH_FIELDS: readonly StatsField[] = [
  ...common,
  { name: 'mission', kind: 'shape', pattern: MISSION },
  { name: 'look', kind: 'enum', values: LOOKS },
  { name: 'cause', kind: 'enum', values: ['crash', 'out-of-bounds', 'head-strike', 'fuel'] },
  { name: 'cell', kind: 'shape', pattern: /^-?\d{1,4}:-?\d{1,4}$/ },
  { name: 'altitude', kind: 'enum', values: ALTITUDE_BUCKETS.labels },
]

export const STATS_CRASHES_PER_ATTEMPT = 8

/**
 * One row per distinct error per visit, at most `STATS_ERRORS_PER_VISIT` (§4.1):
 * Q8. Index: a hash the SERVER makes of the message and the frame, so a client
 * cannot choose an index. `message` is the one text column that is not a list
 * or a shape: the error's own words, which come from our code or the browser,
 * never from a player; the server strips numbers and addresses out of it and
 * cuts it (`cleanErrorMessage`).
 */
export const ERROR_FIELDS: readonly StatsField[] = [
  ...common,
  { name: 'device', kind: 'enum', values: DEVICES },
  {
    name: 'source',
    kind: 'enum',
    values: ['error', 'rejection', 'frame', 'shader', 'context-lost'],
  },
  { name: 'message', kind: 'shape', pattern: /^[\s\S]{1,400}$/ },
  /** The top stack frame inside our own bundle: `file:line`, no host, no query. */
  { name: 'frame', kind: 'shape', pattern: /^(none|[\w./-]{1,80}:\d{1,7})$/ },
]

export const STATS_ERRORS_PER_VISIT = 5
export const STATS_ERROR_MESSAGE_MAX = 120

/** How many of the page's last errors a bug report carries. */
export const STATS_BUG_ERRORS = 3

/**
 * One row per REPORT BUG press (DEV-622): the player's own report, sent only on
 * their SEND. Where they are and the setting in force, and the last few errors
 * the page saw, cleaned as an error row's are. Nothing typed, nothing personal.
 * Index: a short random id the SERVER makes and answers with, so the player can
 * quote it; it names the report, and nothing else carries it.
 */
export const BUG_FIELDS: readonly StatsField[] = [
  ...common,
  { name: 'device', kind: 'enum', values: DEVICES },
  { name: 'screen', kind: 'enum', values: ['title', 'hangar', 'mission', 'tv', 'editor', 'other'] },
  { name: 'mission', kind: 'shape', pattern: MISSION },
  { name: 'quality', kind: 'enum', values: ['low', 'medium', 'high', 'ultra'] },
  { name: 'look', kind: 'enum', values: LOOKS },
  { name: 'scale', kind: 'enum', values: ['1', '0.9', '0.8', '0.7', '0.6', 'other'] },
  { name: 'error1', kind: 'shape', pattern: /^[\s\S]{1,400}$/ },
  { name: 'error2', kind: 'shape', pattern: /^[\s\S]{1,400}$/ },
  { name: 'error3', kind: 'shape', pattern: /^[\s\S]{1,400}$/ },
  // numbers
  /** The sim's fixed step in the mission, or 0 off one. */
  { name: 'tick', kind: 'count', max: 10_000_000 },
]

/** A bug report's id: this many characters of an alphabet with no look-alikes. */
export const STATS_BUG_ID_LENGTH = 6
export const STATS_BUG_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

export const STATS_KINDS = {
  visit: VISIT_FIELDS,
  attempt: ATTEMPT_FIELDS,
  crash: CRASH_FIELDS,
  error: ERROR_FIELDS,
  bug: BUG_FIELDS,
} as const

export type StatsKind = keyof typeof STATS_KINDS

/** A row as the game sends it: its kind, and each field by name. */
export type StatsRow = { readonly k: StatsKind } & Readonly<Record<string, string | number>>

/** A row's fields that are text columns, in column order. */
export const textFields = (fields: readonly StatsField[]): StatsField[] =>
  fields.filter((f) => f.kind === 'enum' || f.kind === 'shape')
/** A row's fields that are numbers, in column order. */
export const numberFields = (fields: readonly StatsField[]): StatsField[] =>
  fields.filter((f) => f.kind === 'count' || f.kind === 'flag' || f.kind === 'seconds')

/**
 * An error's words as they may be kept: anything that looks like an address
 * becomes `<url>`, every run of digits `#`, whitespace one space, and the whole
 * cut to `STATS_ERROR_MESSAGE_MAX`. Numbers are where a stray value would hide
 * (an id, a coordinate, a count), and two errors that differ only by them are
 * one error.
 */
export const cleanErrorMessage = (message: string): string =>
  message
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/\b[\w.-]+@[\w-]+\.[\w.-]+\b/g, '<email>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, STATS_ERROR_MESSAGE_MAX)
