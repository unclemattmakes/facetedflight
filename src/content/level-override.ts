// src/content/level-override.ts — a shipped mission, edited without touching
// what 2016 shipped. DEV-538 (plan/SHIPPED-COURSE-EDITS.md §2–§3, §6.2).
//
// Matt, 2026-09-29: *"we should make our current shipped levels be able to be
// editable in our level editor. (i have no other way of iterating those levels
// based on feedback)"*. The pick is an OVERRIDE LAYER: `content/levels/*.json`
// stays the extractor's bytes, guarded by `content/_generated.sha256` and
// `pnpm extract:check` exactly as before, and an edit is a small hand-authored
// patch in `content/overrides/<missionId>.json` that `loadLevel` applies on top.
//
// ── The shape: a patch over NAMED entities ────────────────────────────────
//
// Every 2016 entity carries its Unity `fileID` (`_meta.ringFileID` on a ring,
// `_meta.fileID` on a turn indicator), and a fileID is stable across
// re-extraction of an unchanged scene. So the patch names what it touches by
// fileID, never by array index: an index changes meaning whenever the
// extractor's liveness walk or order changes, and a fileID does not (§2.1).
// The diff of an edit is the edit.
//
// ── A CLOSED list of fields (§3.4) ────────────────────────────────────────
//
// Hard rule 3 forbids typing an EXTRACTED number. An override's numbers are
// not transcriptions of 2016; they are Matt's new placements, made with a
// mouse, which is what `content/authored/` already is. The risk the rule
// guards against is an override that re-types an extracted fact, so the format
// names what it may touch — {@link OVERRIDE_FIELDS} — and the validator refuses
// every other key. Environment facts (`worldOffset`, `fog`, `lighting`,
// `clouds`, `boundary`, `ui`, `scoring`, `timer.countdown`), 2016's recordings
// (`ghosts`, `ambientTraffic`), the spawn and the lift (§10 call 2) and
// anything under `_meta` are not on it, and cannot be reached by adding a key.
// Widening the list is an edit to that constant, which
// `tests/unit/level-overrides.test.ts` pins by value.
//
// ── The pin: `base` ───────────────────────────────────────────────────────
//
// An override names the sha256 the manifest lists for the generated file it
// was made against (§3.3). The runtime cannot check it — Vite hands the loader
// a parsed object, not bytes — so it is a test guard, as the manifest itself
// is: `level-overrides.test.ts` refuses an override whose `base` is no longer
// the manifest's line, and names it for re-review.
//
// ── No new policy numbers ─────────────────────────────────────────────────
//
// Every bound and quantum here is the player course's
// (`PLAYER_COURSE_LIMITS`, `PLAYER_COURSE_SHAPE`, already pinned), save ONE:
// a quaternion component's quantum, {@link OVERRIDE_SHAPE}, which is the
// precision the extractor itself prints quaternions at — pinned by value and
// checked against `content/levels/` in the test.
//
// Pure: no glob, no three, no DOM, so the node tests, the tools and the dev
// server's writer (`tools/dev/override-writer.mjs`, DEV-539) run the same
// validator the game does. `load-level.ts` is the only thing that applies it.

import { IssueList, isRecord, shownValue } from '@/net/validate-kit'
import { canonicalJson, fnv1a32, oneLineNumberArrays, sortedKeys } from './canonical-json'
import { buildCourseSpline, resampleByArcLength, splinePointAt } from './course-spline'
import {
  type Level,
  LevelSchemaError,
  liveRings,
  type Medals,
  maxRingScore,
  type QuatTuple,
  type Ring,
  type TurnIndicator,
  type Vec3Tuple,
} from './level-schema'
import {
  moveFinishRigid,
  moveRingRigid,
  PLAYER_COURSE_LIMITS,
  PLAYER_COURSE_SHAPE,
  playerCourseMedals,
  poseMotion,
  quantise,
} from './player-course'

// ── The format ────────────────────────────────────────────────────────────

/** The format's version. A v2 is a new reader, never a silent reinterpretation. */
export const OVERRIDE_VERSION = 1

/**
 * The CLOSED list (§3.4): every key an override may hold, and the keys each
 * block may hold. Anything else is refused. **Pinned by value** in
 * `tests/unit/level-overrides.test.ts`: widening it — orbs and JumpSeat pads
 * are DEV-E's — is a deliberate edit to that test as well as to this.
 */
export const OVERRIDE_FIELDS = {
  $schema: [],
  v: [],
  mission: [],
  base: [],
  rings: ['move', 'remove', 'add'],
  turnIndicators: ['move', 'remove', 'add'],
  finish: ['pos', 'quat'],
  route: ['points'],
  timer: ['timeLimit', 'bonusParTime'],
  medals: ['bronze', 'silver', 'gold', 'platinum'],
  notes: ['at', 'what'],
} as const satisfies Record<string, readonly string[]>

/** The keys of one added entity. */
export const OVERRIDE_ADD_FIELDS = ['key', 'after', 'pos', 'quat'] as const

/**
 * The format's own quanta. Positions use the player course's point quantum; a
 * quaternion component is held to the precision the extractor prints them at
 * (six decimals, every quaternion in `content/levels/`, which the test
 * checks), so a pose re-saved without an edit is the same text.
 */
export const OVERRIDE_SHAPE = {
  posQuantumMetres: PLAYER_COURSE_SHAPE.pointQuantumMetres,
  quatQuantum: 1e-6,
} as const

/** A new pose for a 2016 entity: THREE space, world, like every number in `content/levels/`. */
export interface OverridePose {
  readonly pos: Vec3Tuple
  readonly quat: QuatTuple
}

/**
 * A new entity: a copy of the mission's own first live one, moved rigidly to
 * `pos`/`quat` (DEV-466's rule), standing after `after` — an existing fileID,
 * an earlier add's key, or null for the very start.
 */
export interface OverrideAdd extends OverridePose {
  /** `ov:<n>`, unique within the override. What the editor and a later add name it by. */
  readonly key: string
  readonly after: string | null
}

/** Move, remove or add entities of one kind, by 2016 fileID. */
export interface OverrideEntities {
  readonly move?: Readonly<Record<string, OverridePose>>
  readonly remove?: readonly string[]
  readonly add?: readonly OverrideAdd[]
}

/** One change's reason, reviewed in the same diff as its numbers (§3.6, Matt's call 4). */
export interface OverrideNote {
  /** `YYYY-MM-DD`. */
  readonly at: string
  readonly what: string
}

/** `content/overrides/<mission>.json`, validated and quantised. */
export interface LevelOverride {
  readonly $schema?: string
  readonly v: typeof OVERRIDE_VERSION
  readonly mission: string
  /** sha256 of `content/levels/<mission>.json`, as `content/_generated.sha256` lists it. */
  readonly base: string
  readonly rings?: OverrideEntities
  readonly turnIndicators?: OverrideEntities
  /** The finish, moved rigidly: trigger, frame and studs (DEV-466). A sphere-union gate only. */
  readonly finish?: OverridePose
  /** The racing line's control points; resampled every `routeSpacingMetres` on load. */
  readonly route?: { readonly points: readonly Vec3Tuple[] }
  readonly timer?: { readonly timeLimit?: number; readonly bonusParTime?: number }
  /** Matt's own medal call. Absent: re-derived from the ring count (§2.2). */
  readonly medals?: Medals
  readonly notes?: readonly OverrideNote[]
}

export type OverrideIssue = readonly [path: string, message: string]

export type OverrideResult =
  | { readonly ok: true; readonly override: LevelOverride }
  | { readonly ok: false; readonly errors: readonly OverrideIssue[] }

// ── Keys ──────────────────────────────────────────────────────────────────

/** A Unity fileID, as the extractor writes it: a decimal string. */
const FILE_ID = /^-?\d+$/
/** An added entity's key. */
const ADDED_KEY = /^ov:[1-9]\d*$/
const SHA256 = /^[0-9a-f]{64}$/
const MISSION_ID = /^[A-Za-z][A-Za-z0-9_]*$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

type Meta = { readonly _meta?: Record<string, unknown> }

/** Is `key` an added entity's (`ov:<n>`, n a positive whole number), as the reader takes it? */
export const isAddedKey = (key: string): boolean => ADDED_KEY.test(key)

/**
 * The next unused `ov:<n>` among a block's adds: one past the biggest `n`. A key
 * the reader would refuse is not an added key and never seeds the next one.
 */
export const nextAddedKey = (add: readonly { readonly key: string }[] | undefined): string => {
  let n = 0
  for (const a of add ?? []) if (isAddedKey(a.key)) n = Math.max(n, Number(a.key.slice(3)))
  return `ov:${n + 1}`
}

/** The key a ring answers to: its 2016 fileID, or an added ring's `ov:` key. */
export const ringKey = (ring: Ring): string | null => {
  const meta = (ring as Ring & Meta)._meta
  const key = meta?.ringFileID ?? meta?.overrideKey
  return typeof key === 'string' ? key : null
}

/** The key a turn indicator answers to: its 2016 fileID, or an added one's `ov:` key. */
export const turnIndicatorKey = (t: TurnIndicator): string | null => {
  const meta = (t as TurnIndicator & Meta)._meta
  const key = meta?.fileID ?? meta?.overrideKey
  return typeof key === 'string' ? key : null
}

// ── Validation: the structural half ──────────────────────────────────────

class Issues extends IssueList<OverrideIssue> {
  constructor() {
    super(PLAYER_COURSE_LIMITS.errorsReported)
  }
}

/** A short, safe rendering of something hostile, for a message. Never throws. */
const shown = (v: unknown): string => shownValue(v, PLAYER_COURSE_LIMITS.idLength, '…')

const onlyKeys = (
  path: string,
  obj: Record<string, unknown>,
  allowed: readonly string[],
  issues: Issues,
): void => {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      issues.add(
        path ? `${path}.${k}` : k,
        `is not an overridable field; ${path || 'an override'} may hold ${allowed.join(', ')}`,
      )
    }
  }
}

const qPos = (v: number): number => quantise(v, OVERRIDE_SHAPE.posQuantumMetres)
const qQuat = (v: number): number => quantise(v, OVERRIDE_SHAPE.quatQuantum)

const readPos = (path: string, v: unknown, issues: Issues): Vec3Tuple | null => {
  const bound = PLAYER_COURSE_LIMITS.coordinateMetres
  if (
    !Array.isArray(v) ||
    v.length !== 3 ||
    !v.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= bound)
  ) {
    issues.add(path, `must be [x, y, z], each a finite number within ±${bound} m`)
    return null
  }
  return [qPos(v[0]), qPos(v[1]), qPos(v[2])]
}

/**
 * A rotation, normalised, on its quantum, with w ≥ 0 — q and −q are one
 * rotation, and the canonical text should not depend on which the editor had.
 */
const readQuat = (path: string, v: unknown, issues: Issues): QuatTuple | null => {
  if (
    !Array.isArray(v) ||
    v.length !== 4 ||
    !v.every((x) => typeof x === 'number' && Number.isFinite(x))
  ) {
    issues.add(path, 'must be [x, y, z, w], four finite numbers')
    return null
  }
  const [x, y, z, w] = v as number[] as [number, number, number, number]
  const n = Math.hypot(x, y, z, w)
  if (!(n > 0)) {
    issues.add(path, 'is not a rotation: all four are zero')
    return null
  }
  const s = w < 0 ? -1 / n : 1 / n
  return [qQuat(x * s), qQuat(y * s), qQuat(z * s), qQuat(w * s)]
}

const readPose = (path: string, v: unknown, issues: Issues): OverridePose | null => {
  if (!isRecord(v)) {
    issues.add(path, 'must be { "pos": [x, y, z], "quat": [x, y, z, w] }')
    return null
  }
  onlyKeys(path, v, ['pos', 'quat'], issues)
  const pos = readPos(`${path}.pos`, v.pos, issues)
  const quat = readQuat(`${path}.quat`, v.quat, issues)
  return pos && quat ? { pos, quat } : null
}

/** A position on the format's grid, and nothing else checked: for a caller that holds its own bounds. */
export const quantisePos = (p: readonly number[]): Vec3Tuple => [
  qPos(p[0] as number),
  qPos(p[1] as number),
  qPos(p[2] as number),
]

/**
 * A pose as the file holds it: the reader's own reading of `pos` and `quat`
 * (in bounds, on the grid, a normalised rotation with w >= 0), or `null`
 * where the reader would refuse it. The editor writes poses through this, so
 * a draft never holds one the file cannot.
 */
export const canonicalPose = (
  pos: readonly number[],
  quat: readonly number[],
): OverridePose | null => readPose('', { pos, quat }, new Issues())

/**
 * The route's rules: its count, then every point read (bounds and grid) and
 * the spacing tested on the GRIDDED points, which is what the file holds. The
 * result is the gridded points when no rule is broken, else `null`, with the
 * breaches in `issues`.
 */
const readRoute = (v: unknown, issues: Issues): Vec3Tuple[] | null => {
  const { min, max } = PLAYER_COURSE_LIMITS.points
  if (!Array.isArray(v) || v.length < min || v.length > max) {
    issues.add('route.points', `must be ${min} to ${max} control points`)
    return null
  }
  const points: Vec3Tuple[] = []
  v.forEach((p, i) => {
    const q = readPos(`route.points[${i}]`, p, issues)
    if (q) points.push(q)
  })
  const gap = PLAYER_COURSE_LIMITS.pointSpacingMetres.min
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Vec3Tuple
    const b = points[i] as Vec3Tuple
    if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) < gap) {
      issues.add(`route.points[${i}]`, `is within ${gap} m of the point before it`)
    }
  }
  return points.length === v.length ? points : null
}

/** What the file's reader would say about a racing line: empty when it holds. */
export const routeIssues = (points: readonly unknown[]): readonly OverrideIssue[] => {
  const issues = new Issues()
  readRoute(points, issues)
  return issues.list
}

const readEntities = (path: string, v: unknown, issues: Issues): OverrideEntities | null => {
  if (!isRecord(v)) {
    issues.add(path, 'must be { "move": {…}, "remove": […], "add": […] }')
    return null
  }
  onlyKeys(path, v, OVERRIDE_FIELDS.rings, issues)
  const out: { move?: Record<string, OverridePose>; remove?: string[]; add?: OverrideAdd[] } = {}

  if (v.move !== undefined) {
    if (!isRecord(v.move)) issues.add(`${path}.move`, 'must be an object keyed by 2016 fileID')
    else {
      const move: Record<string, OverridePose> = {}
      for (const [key, pose] of Object.entries(v.move)) {
        if (!FILE_ID.test(key)) {
          issues.add(
            `${path}.move.${key}`,
            ADDED_KEY.test(key)
              ? 'an added entity is placed by its own "add" entry, not moved'
              : 'must be a 2016 fileID (a decimal string)',
          )
          continue
        }
        const p = readPose(`${path}.move.${key}`, pose, issues)
        if (p) move[key] = p
      }
      if (Object.keys(move).length > 0) out.move = move
    }
  }

  if (v.remove !== undefined) {
    if (!Array.isArray(v.remove)) issues.add(`${path}.remove`, 'must be a list of 2016 fileIDs')
    else {
      const remove = new Set<string>()
      v.remove.forEach((key, i) => {
        if (typeof key !== 'string' || !FILE_ID.test(key)) {
          issues.add(
            `${path}.remove[${i}]`,
            `${shown(key)} is not a 2016 fileID; an added entity is removed by deleting its "add" entry`,
          )
        } else if (remove.has(key)) issues.add(`${path}.remove[${i}]`, `${key} is listed twice`)
        else remove.add(key)
      })
      for (const key of remove) {
        if (out.move && Object.hasOwn(out.move, key)) {
          issues.add(`${path}.remove`, `${key} is both moved and removed`)
        }
      }
      // Order does not change what a removal means, so the canonical text sorts it.
      if (remove.size > 0) out.remove = [...remove].sort()
    }
  }

  if (v.add !== undefined) {
    if (!Array.isArray(v.add)) issues.add(`${path}.add`, 'must be a list of new entities')
    else {
      const add: OverrideAdd[] = []
      const keys = new Set<string>()
      v.add.forEach((entry, i) => {
        const at = `${path}.add[${i}]`
        if (!isRecord(entry)) {
          issues.add(at, 'must be { "key", "after", "pos", "quat" }')
          return
        }
        onlyKeys(at, entry, OVERRIDE_ADD_FIELDS, issues)
        const key = entry.key
        if (typeof key !== 'string' || !ADDED_KEY.test(key)) {
          issues.add(`${at}.key`, 'must be "ov:<n>", n a positive whole number')
          return
        }
        if (keys.has(key)) {
          issues.add(`${at}.key`, `${key} is used twice`)
          return
        }
        const after = entry.after
        if (
          after !== null &&
          !(typeof after === 'string' && (FILE_ID.test(after) || keys.has(after)))
        ) {
          issues.add(
            `${at}.after`,
            'must be a 2016 fileID, the key of an EARLIER add, or null for the start',
          )
        }
        keys.add(key)
        const pos = readPos(`${at}.pos`, entry.pos, issues)
        const quat = readQuat(`${at}.quat`, entry.quat, issues)
        if (pos && quat) add.push({ key, after: (after ?? null) as string | null, pos, quat })
      })
      if (add.length > 0) out.add = add
    }
  }
  return out
}

const readTime = (path: string, v: unknown, issues: Issues): number | null => {
  const { min, max } = PLAYER_COURSE_LIMITS.timeLimitSeconds
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    issues.add(path, `must be seconds from ${min} to ${max}`)
    return null
  }
  return quantise(v, PLAYER_COURSE_SHAPE.timeLimitQuantumSeconds)
}

/**
 * Validate an override on its own: every key on the closed list, every value's
 * shape, bounds and quanta. Never throws. `override` on success is QUANTISED
 * and stripped of empty blocks, so it is the canonical content.
 *
 * What needs the baseline — that every fileID it names is in it, that the
 * finish is a gate that can move, that the ring count stays in bounds — is
 * {@link checkOverride}'s.
 */
export const validateOverride = (input: unknown): OverrideResult => {
  const issues = new Issues()
  if (!isRecord(input)) {
    return { ok: false, errors: [['', 'an override must be a JSON object']] }
  }
  const out: Record<string, unknown> = {}
  try {
    onlyKeys('', input, Object.keys(OVERRIDE_FIELDS), issues)
    if (input.$schema !== undefined) {
      if (typeof input.$schema !== 'string') issues.add('$schema', 'must be a string')
      else out.$schema = input.$schema
    }
    if (input.v !== OVERRIDE_VERSION) issues.add('v', `must be ${OVERRIDE_VERSION}`)
    out.v = OVERRIDE_VERSION
    if (
      typeof input.mission !== 'string' ||
      !MISSION_ID.test(input.mission) ||
      input.mission.length > PLAYER_COURSE_LIMITS.idLength
    ) {
      issues.add('mission', 'must name a shipped mission id')
    } else out.mission = input.mission
    if (typeof input.base !== 'string' || !SHA256.test(input.base)) {
      issues.add(
        'base',
        "must be the sha256 content/_generated.sha256 lists for the mission's file",
      )
    } else out.base = input.base

    for (const kind of ['rings', 'turnIndicators'] as const) {
      if (input[kind] === undefined) continue
      const e = readEntities(kind, input[kind], issues)
      if (e && (e.move || e.remove || e.add)) out[kind] = e
    }

    if (input.finish !== undefined) {
      const f = readPose('finish', input.finish, issues)
      if (f) out.finish = f
    }

    if (input.route !== undefined) {
      const r = input.route
      if (!isRecord(r)) issues.add('route', 'must be { "points": [[x, y, z], …] }')
      else {
        onlyKeys('route', r, OVERRIDE_FIELDS.route, issues)
        const points = readRoute(r.points, issues)
        if (points) out.route = { points }
      }
    }

    if (input.timer !== undefined) {
      const t = input.timer
      if (!isRecord(t)) issues.add('timer', 'must be { "timeLimit", "bonusParTime" }')
      else {
        onlyKeys('timer', t, OVERRIDE_FIELDS.timer, issues)
        const timer: Record<string, number> = {}
        for (const k of OVERRIDE_FIELDS.timer) {
          if (t[k] === undefined) continue
          const s = readTime(`timer.${k}`, t[k], issues)
          if (s !== null) timer[k] = s
        }
        if (Object.keys(timer).length > 0) out.timer = timer
      }
    }

    if (input.medals !== undefined) {
      const m = input.medals
      if (!isRecord(m)) issues.add('medals', 'must be { bronze, silver, gold, platinum }')
      else {
        onlyKeys('medals', m, OVERRIDE_FIELDS.medals, issues)
        let previous = 0
        let whole = true
        for (const k of OVERRIDE_FIELDS.medals) {
          const x = m[k]
          if (!Number.isInteger(x) || (x as number) < previous) {
            issues.add(`medals.${k}`, `must be a whole score, at least ${previous}`)
            whole = false
          } else previous = x as number
        }
        if (whole) {
          out.medals = {
            bronze: m.bronze as number,
            silver: m.silver as number,
            gold: m.gold as number,
            platinum: m.platinum as number,
          }
        }
      }
    }

    if (input.notes !== undefined) {
      if (!Array.isArray(input.notes)) issues.add('notes', 'must be a list of { at, what }')
      else {
        const notes: OverrideNote[] = []
        input.notes.forEach((n, i) => {
          if (!isRecord(n)) {
            issues.add(`notes[${i}]`, 'must be { "at": "YYYY-MM-DD", "what": "…" }')
            return
          }
          onlyKeys(`notes[${i}]`, n, OVERRIDE_FIELDS.notes, issues)
          if (typeof n.at !== 'string' || !DAY.test(n.at)) {
            issues.add(`notes[${i}].at`, 'must be a date, YYYY-MM-DD')
          } else if (typeof n.what !== 'string' || n.what.trim().length === 0) {
            issues.add(`notes[${i}].what`, 'must say what changed and why')
          } else notes.push({ at: n.at, what: n.what })
        })
        if (notes.length > 0) out.notes = notes
      }
    }
  } catch (error) {
    issues.add('', `could not be read (${error instanceof Error ? error.name : typeof error})`)
  }
  if (issues.any) return { ok: false, errors: issues.list }
  return { ok: true, override: out as unknown as LevelOverride }
}

// ── Validation: against the baseline ─────────────────────────────────────

const checkEntities = (
  kind: 'rings' | 'turnIndicators',
  patch: OverrideEntities | undefined,
  keys: ReadonlySet<string>,
  hasTemplate: boolean,
  issues: Issues,
): void => {
  if (!patch) return
  const noun = kind === 'rings' ? 'ring' : 'turn indicator'
  for (const key of Object.keys(patch.move ?? {})) {
    if (!keys.has(key)) issues.add(`${kind}.move.${key}`, `names no ${noun} in the baseline`)
  }
  for (const key of patch.remove ?? []) {
    if (!keys.has(key)) issues.add(`${kind}.remove`, `${key} names no ${noun} in the baseline`)
  }
  for (const [i, a] of (patch.add ?? []).entries()) {
    if (a.after !== null && FILE_ID.test(a.after) && !keys.has(a.after)) {
      issues.add(`${kind}.add[${i}].after`, `${a.after} names no ${noun} in the baseline`)
    }
  }
  if ((patch.add ?? []).length > 0 && !hasTemplate) {
    issues.add(`${kind}.add`, `the baseline has no live ${noun} to copy`)
  }
}

/**
 * Everything about `ov` that needs its baseline: it names this mission, every
 * fileID it moves, removes or anchors an add to is in the baseline, a moved
 * finish is a gate (a JumpSeat's slab is DEV-E's), a new line replaces a line,
 * the rings stay within the player course's bounds, and explicit medals are
 * reachable. Never throws.
 */
export const checkOverride = (base: Level, ov: LevelOverride): readonly OverrideIssue[] => {
  const issues = new Issues()
  if (ov.mission !== base.id) {
    issues.add('mission', `names ${shown(ov.mission)} but the baseline is ${shown(base.id)}`)
    return issues.list
  }
  const baseRings = base.routes.flatMap((r) => r.rings)
  const ringKeys = new Set(baseRings.map(ringKey).filter((k): k is string => k !== null))
  checkEntities('rings', ov.rings, ringKeys, liveRings(base).length > 0, issues)
  const tiKeys = new Set(
    base.turnIndicators.map(turnIndicatorKey).filter((k): k is string => k !== null),
  )
  checkEntities(
    'turnIndicators',
    ov.turnIndicators,
    tiKeys,
    base.turnIndicators.some((t) => t.live),
    issues,
  )
  if (ov.finish && base.finish?.shape !== 'sphereUnion') {
    issues.add('finish', 'only a sphere-union finish gate moves in v1 (a JumpSeat slab is DEV-E)')
  }
  if (ov.route && !(Array.isArray(base.route) && base.route.length > 1)) {
    issues.add('route', 'this mission has no racing line to replace')
  }
  if (issues.any) return issues.list

  // The rings as they will stand, so the count and the medals are checked on
  // the course that loads rather than on arithmetic about it.
  if (ov.rings && liveRings(base).length > 0) {
    const n = liveRings(placeRings(base, ov)).length
    const { min, max } = PLAYER_COURSE_LIMITS.rings
    if (n < min || n > max)
      issues.add('rings', `leaves ${n} live rings; a course has ${min} to ${max}`)
  }
  if (ov.medals) {
    const ceiling = maxRingScore(placeRings(base, ov))
    if (ceiling <= 0) issues.add('medals', 'this mission awards no ring medals to set')
    else if (ov.medals.platinum > ceiling) {
      issues.add('medals.platinum', `is ${ov.medals.platinum}; every ring scores ${ceiling}`)
    }
  }
  return issues.list
}

// ── Applying ──────────────────────────────────────────────────────────────

type Keyed<T> = T & Meta

/** `_meta` without the 2016 raw pose it no longer has, marked as moved. */
const movedMeta = (meta: Record<string, unknown> | undefined): Record<string, unknown> => {
  const { raw: _raw, ...rest } = meta ?? {}
  return { ...rest, movedBy: 'override' }
}

/**
 * Insert the adds, in file order, into `lists` (a mission's routes, or its one
 * list of turn indicators). An add stands right after its anchor — and after
 * any EARLIER add on the same anchor, so two adds after one ring read in the
 * order they are written. `after: null` is the start of the first list.
 * Anchors are found before anything is removed, so an add may stand after an
 * entity the same override removes.
 */
const insertAdds = <T>(
  lists: T[][],
  adds: readonly OverrideAdd[],
  keyOf: (t: T) => string | null,
  make: (a: OverrideAdd) => T,
): void => {
  const lastOn = new Map<string | null, string>()
  for (const a of adds) {
    const anchor = lastOn.get(a.after) ?? a.after
    let list = lists[0]
    let at = 0
    if (anchor !== null) {
      for (const l of lists) {
        const i = l.findIndex((t) => keyOf(t) === anchor)
        if (i >= 0) {
          list = l
          at = i + 1
          break
        }
      }
    }
    list?.splice(at, 0, make(a))
    lastOn.set(a.after, a.key)
  }
}

/** The rings with the override's ring block applied: moved, added, removed, renumbered. */
const placeRings = (base: Level, ov: LevelOverride): Level => {
  const patch = ov.rings
  if (!patch) return base
  const routes = base.routes.map((route) => ({
    ...route,
    rings: route.rings.map((ring) => {
      const key = ringKey(ring)
      const to = key !== null ? patch.move?.[key] : undefined
      if (!to) return ring
      const moved = moveRingRigid(ring, poseMotion(ring.pos, ring.quat, to.pos, to.quat))
      return { ...moved, _meta: movedMeta((ring as Keyed<Ring>)._meta) } as Ring
    }),
  }))
  // DEV-466's rule: a new ring is the mission's first live ring, moved rigidly.
  const template = liveRings(base)[0]
  if (template) {
    insertAdds(
      routes.map((r) => r.rings),
      patch.add ?? [],
      ringKey,
      (a) =>
        ({
          ...moveRingRigid(template, poseMotion(template.pos, template.quat, a.pos, a.quat)),
          name: `Checkpoint_Ring(Override ${a.key})`,
          _meta: { overrideKey: a.key, copiedFrom: ringKey(template) },
        }) as Ring,
    )
  }
  const removed = new Set(patch.remove ?? [])
  return {
    ...base,
    routes: routes.map((route) => ({
      ...route,
      rings: route.rings
        .filter((ring) => !removed.has(ringKey(ring) ?? ''))
        .map((ring, i) => (ring.i === i && ring.order === i ? ring : { ...ring, i, order: i })),
    })),
  }
}

/** The turn indicators with the override's block applied. Their arrow's pose is prefab-local, so a move is the placement's pose. */
const placeTurnIndicators = (base: Level, ov: LevelOverride): TurnIndicator[] => {
  const patch = ov.turnIndicators
  if (!patch) return base.turnIndicators
  const list = base.turnIndicators.map((t) => {
    const key = turnIndicatorKey(t)
    const to = key !== null ? patch.move?.[key] : undefined
    if (!to) return t
    return {
      ...t,
      pos: [...to.pos] as Vec3Tuple,
      quat: [...to.quat] as QuatTuple,
      _meta: movedMeta((t as Keyed<TurnIndicator>)._meta),
    } as TurnIndicator
  })
  const template = base.turnIndicators.find((t) => t.live)
  if (template) {
    insertAdds([list], patch.add ?? [], turnIndicatorKey, (a) => ({
      ...structuredClone(template),
      pos: [...a.pos] as Vec3Tuple,
      quat: [...a.quat] as QuatTuple,
      _meta: { overrideKey: a.key, copiedFrom: turnIndicatorKey(template) },
    }))
  }
  const removed = new Set(patch.remove ?? [])
  return list
    .filter((t) => !removed.has(turnIndicatorKey(t) ?? ''))
    .map((t, i) => (t.i === i ? t : { ...t, i }))
}

/**
 * The racing line through `points`, as a player course's is: the format's own
 * Catmull-Rom, sampled every `routeSpacingMetres` from its first point, and its
 * last point (DEVIATIONS DEV-466, "`route` runs … every 25 m").
 */
export const overrideRoute = (points: readonly Vec3Tuple[]): Vec3Tuple[] => {
  const spline = buildCourseSpline(
    points.map(([x, y, z]) => ({ x, y, z })),
    {
      divisionsPerSegment: PLAYER_COURSE_SHAPE.divisionsPerSegment,
      tension: PLAYER_COURSE_SHAPE.tension,
    },
  )
  const at = (s: number): Vec3Tuple => {
    const p = splinePointAt(spline, s)
    return [p.x, p.y, p.z]
  }
  const L = spline.length
  const steps = resampleByArcLength(0, L, PLAYER_COURSE_SHAPE.routeSpacingMetres)
  const route: Vec3Tuple[] = [at(0), ...steps.map(at)]
  if ((steps[steps.length - 1] ?? 0) < L) route.push(at(L))
  return route
}

/**
 * The course a best is judged on (§6.2): what the lap `rules` hash covers —
 * the scoring rings' triggers, the finish, the start, the respawn, the line,
 * the time limit and par — plus the orbs and pads a JumpSeat course is flown
 * for. Turn indicators, medals and notes move no score, and are not in it.
 */
const courseBody = (level: Level): unknown => ({
  rings: liveRings(level).map((r) => ({
    pos: r.trigger.pos,
    quat: r.trigger.quat,
    radius: r.trigger.radius,
    spheres: r.trigger.spheres,
    addScore: r.scoring.addScore,
    triggerOnce: r.scoring.triggerOnce,
  })),
  finish: level.finish
    ? { pos: level.finish.pos, quat: level.finish.quat, radius: level.finish.radius }
    : null,
  spawn: level.spawn.pos,
  respawn: level.respawn?.pos ?? null,
  route: level.route ?? null,
  timer: { timeLimit: level.timer.timeLimit, bonusParTime: level.timer.bonusParTime },
  orbs: level.orbs,
  pads: level.pads,
})

/** Eight hex digits naming a course, for keys: {@link courseBody}'s canonical text, hashed. */
export const courseKeyOf = (level: Level): string => fnv1a32(canonicalJson(courseBody(level)))

/**
 * `base` with `raw` applied. Throws `LevelSchemaError` naming every problem
 * when `raw` does not validate or does not fit this baseline — the only way an
 * override reaches a level is through the validator.
 *
 * The result carries `_override` (its base and notes) and, ONLY when the
 * course a best is judged on differs from the baseline's, `courseKey` — which
 * gives the personal best its course segment (`game/personal-best.ts`, §6.2,
 * Matt's call 3: fresh bests on an edited course). An override that changes
 * only medals or notes, or that is reverted to the baseline, keeps the
 * baseline's key byte for byte and so its bests.
 */
export const applyOverride = (base: Level, raw: unknown): Level => {
  const checked = validateOverride(raw)
  if (!checked.ok) throw overrideError(base.id, checked.errors)
  const ov = checked.override
  const problems = checkOverride(base, ov)
  if (problems.length > 0) throw overrideError(base.id, problems)

  let level = placeRings(base, ov)
  const turnIndicators = placeTurnIndicators(base, ov)
  if (turnIndicators !== base.turnIndicators) level = { ...level, turnIndicators }
  if (ov.finish && base.finish?.shape === 'sphereUnion') {
    const f = base.finish
    level = {
      ...level,
      finish: moveFinishRigid(f, poseMotion(f.pos, f.quat, ov.finish.pos, ov.finish.quat)),
    }
  }
  if (ov.route) level = { ...level, route: overrideRoute(ov.route.points) }
  if (ov.timer) level = { ...level, timer: { ...level.timer, ...ov.timer } }

  // Medals: Matt's own, or re-derived from the ring count when it moved (§2.2,
  // §6.5) — the baseline's bands on the new count, platinum every ring. On an
  // unchanged count the baseline's curve stands exactly, so none is written.
  const live = liveRings(level)
  const template = liveRings(base)[0]
  if (ov.medals) {
    level = {
      ...level,
      medalsFf2: { ...ov.medals, _meta: { deviation: 'DEV-538', note: 'set by the override' } },
    }
  } else if (template && live.length !== liveRings(base).length) {
    const perRing = template.scoring.addScore * base.scoring.gateMultiplier
    level = {
      ...level,
      medalsFf2: {
        ...playerCourseMedals(base, live.length, perRing),
        _meta: {
          deviation: 'DEV-538',
          note: `re-derived for ${live.length} rings (playerCourseMedals)`,
        },
      },
    }
  }

  const key = courseKeyOf(level)
  const stamped: Level = { ...level, _override: { base: ov.base, notes: ov.notes ?? [] } }
  return key === courseKeyOf(base) ? stamped : { ...stamped, courseKey: key }
}

const overrideError = (id: string, errors: readonly OverrideIssue[]): LevelSchemaError =>
  new LevelSchemaError(
    id,
    `override refused: ${errors
      .slice(0, 3)
      .map(([p, m]) => (p ? `${p}: ${m}` : m))
      .join('; ')}${errors.length > 3 ? ` (+${errors.length - 3} more)` : ''}`,
  )

// ── The file's bytes ──────────────────────────────────────────────────────

/**
 * The canonical text of a VALIDATED override (§2.2): sorted keys, two-space
 * indent, every pose on one line, LF, a final newline. So re-saving without an
 * edit is a zero diff, whatever order the editor built the object in. The
 * dev server's writer (DEV-539) writes exactly these bytes.
 */
export const canonicalOverrideText = (ov: LevelOverride): string =>
  `${oneLineNumberArrays(JSON.stringify(sortedKeys(ov), null, 2))}\n`

/**
 * The sha256 `content/_generated.sha256` lists for `content/levels/<id>.json`,
 * or null. A string parse, so a test, a tool and the dev server read the one
 * manifest one way.
 */
export const manifestShaOf = (manifest: string, id: string): string | null => {
  const path = `content/levels/${id}.json`
  for (const line of manifest.split('\n')) {
    const [sha, file] = line.trim().split(/\s+/)
    if (file === path && sha && SHA256.test(sha)) return sha
  }
  return null
}

/**
 * The base pin (§3.3), or null when it holds: `ov.base` must be the line the
 * manifest lists for its mission TODAY. When a re-extraction moves the
 * generated file under an override, every fileID and pose the override names
 * was chosen against a baseline that is gone, so this names the override and
 * says what to do rather than letting it apply to a course nobody checked.
 * `level-overrides.test.ts` and the dev server's writer (DEV-539) both ask.
 */
export const baseProblem = (
  ov: Pick<LevelOverride, 'mission' | 'base'>,
  manifest: string,
): string | null => {
  const current = manifestShaOf(manifest, ov.mission)
  if (current === null) {
    return `content/_generated.sha256 lists no content/levels/${ov.mission}.json: an override edits a generated mission`
  }
  if (current === ov.base) return null
  return (
    `the baseline moved under this override (content/overrides/${ov.mission}.json pins ${ov.base.slice(0, 12)}…, ` +
    `the manifest now says ${current.slice(0, 12)}…): re-open it in the editor, check every entity it names, and re-save`
  )
}
