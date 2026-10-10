// src/sim/ghost.ts — sampling a recorded run.
//
// ── What a ghost actually is ──────────────────────────────────────────────
//
// NOT a physics replay. 2016 recorded ghosts with the Motion Recorder asset
// into legacy Unity `AnimationClip`s — one position curve and one rotation
// curve, bound to path "" (the recorded object's own root), sampled at 60 Hz.
// So a ghost is a list of poses, and replaying one means interpolating that
// list, not re-running the flight model against recorded input (D20).
//
// That distinction is worth holding onto. A pose recording cannot drift, cannot
// desync when the flight model is retuned, and does not care that FF2's
// integrator is a reimplementation. It is also why the 2016 ghosts are still
// raceable at all: they survived the engine they were made in.
//
// ── The packing ───────────────────────────────────────────────────────────
//
// IN MEMORY: eight `Float32`s per key, `[t, px, py, pz, qx, qy, qz, qw]`, THREE
// space, positions relative to the level's `worldOffset`. Times ascend. (A
// player's lap is the same eight, in float64: see `GhostClip.data`.)
//
// ON DISK: `content/ghosts/<clip>.json`, plain quantised integers -- time in ms,
// position in mm, rotation as int16 -- written by `tools/extract/ghost.mjs` and
// read back by {@link decodeGhostClip}. A ghost is first-party 2016 data that
// versions with the level referencing it, so it ships in git rather than in the
// R2 bucket (D12, content/MANIFEST.md §3); it is text rather than the raw
// float32 stream because the denylist blocks opaque binaries a human cannot
// review in a diff, and that objection is answered by not being one. The text
// form is also SMALLER in the repository than the binary it replaced -- 39,008 B
// against 43,124 B packed, float32 being close to incompressible.
//
// The clips are decimated at 0.025 m before shipping and it matters: the raw
// `int_01_leftSpawn_fast_01` is 5,771 keys and 2.9 MB of YAML, and the decimated
// one is 1,417 keys and 44 KB. A 66x saving for an error smaller than the
// vertex jitter on the terrain it flies over.
//
// SIM LAYER: no three, no DOM, no clock. Sampling is a pure function of the
// buffer and a time, which is what lets a ghost be scored by the same headless
// harness that scores a live run.
//
// ── Two formats, one clip (DEV-370) ───────────────────────────────────────
//
// `ff2-ghost-1` is 2016's: millisecond times, in git, one integer per line.
// `ff2-ghost-2` is a PLAYER'S lap, written by `sim/ghost-record.ts`: the same
// mm and int16 quantisation, but the time is the integer fixed-step TICK, and
// the document carries whose lap it is (mission, mode, edition, rules, vehicle,
// build) and its events. Both decode into the same `GhostClip`, so drawing and
// scoring a player's lap is the code that draws and scores 2016's.
//
// Why a tick and not a millisecond: a tick is 12.2 ms, so a ms time is up to
// 0.5 ms off the moment the pose was taken, and at 160 m/s that is 8 cm along
// the track. `docs/plan/PLAYER-GHOSTS.md` §3.2 measured it: 8.6 cm worst with ms
// times against 4.0 cm with ticks, on a lap decimated at 25 mm. The tick is also
// what the server compares a finish against, and `tick × FIXED_DT` is the very
// sum the live mission clock adds up.

import { type FinishSphere, runIsOver } from './ai-racer'
import { FIXED_DT } from './constants'
import { createCourse, type Gate, seedCourse, stepCourse } from './course'
import { lerp } from './math/scalar'

/** Floats per key. */
export const GHOST_STRIDE = 8

export interface GhostPose {
  px: number
  py: number
  pz: number
  qx: number
  qy: number
  qz: number
  qw: number
}

export interface GhostClip {
  /**
   * `[t, px,py,pz, qx,qy,qz,qw]` per key. Float32 for 2016's clips; FLOAT64
   * for a player's lap, whose key times are `tick × FIXED_DT` and must meet the
   * mission clock exactly: float32 holds 67 s only to 4 µs, which is 0.7 mm of
   * track at 180 m/s on every key, and it would put a finish scored from the
   * poses on the wrong side of a tick the live run was on the right side of.
   */
  readonly data: Float32Array | Float64Array
  readonly keyCount: number
  readonly duration: number
  /**
   * Seconds of recording before the ghost leaves the line. DEV-025.
   *
   * Both `int_01` clips hold on the pad for about seven seconds — 2016's own
   * pre-race pause, baked into the recording. Sampling from zero hands the
   * player that as a head start; `game/ghosts.ts` skips it so all three ships
   * launch together. Derived in `tools/extract/ghost.mjs` by displacement,
   * because speed could not tell a hovering ship from a launching one.
   */
  readonly launchAt: number
  /**
   * A player lap's events, ticks ascending. Empty for 2016's clips, which
   * recorded nothing but poses. A `reset` tick is a pose the ship was PUT at
   * (a crash reset, a boundary respawn), so the one-tick segment into it is a
   * teleport rather than a path.
   */
  readonly events: readonly LapEvent[]
}

export const createGhostClip = (
  data: Float32Array | Float64Array,
  launchAt = 0,
  events: readonly LapEvent[] = [],
): GhostClip => {
  if (data.length === 0 || data.length % GHOST_STRIDE !== 0) {
    throw new Error(
      `ghost clip: ${data.length} floats is not a whole number of ${GHOST_STRIDE}-float keys`,
    )
  }
  const keyCount = data.length / GHOST_STRIDE
  return {
    data,
    keyCount,
    duration: data[(keyCount - 1) * GHOST_STRIDE] as number,
    launchAt,
    events,
  }
}

/** The on-disk form. `tools/extract/ghost.mjs` is the only thing that writes it. */
export interface GhostDoc {
  readonly $schema?: string
  readonly name?: string
  readonly keyCount: number
  /** Seconds before the ghost leaves the line. See `GhostClip.launchAt`. */
  readonly launchAt?: number
  /** Clip length in seconds. Written for readability; the decoder reads `t`. */
  readonly duration?: number
  readonly quant: { readonly time: number; readonly pos: number; readonly rot: number }
  /** One time per key. Line N of each array is key N, which is what makes it diffable. */
  readonly t: readonly number[]
  readonly p: readonly number[]
  readonly q: readonly number[]
}

export const GHOST_SCHEMA = 'ff2-ghost-1'

// ── ff2-ghost-2: a player's lap ───────────────────────────────────────────

export const LAP_SCHEMA = 'ff2-ghost-2'

/**
 * `ff2-ghost-2`'s quantisation, fixed by the schema name rather than written
 * into every document: millimetres, and int16 quaternion components. They are
 * `ff2-ghost-1`'s own two scales (`tools/extract/ghost.mjs`'s `QUANT`), whose
 * bounds `tests/unit/ghost.test.ts` already holds against real 2016 data:
 * 0.5 mm, and 0.034 degrees after renormalising. Time has no scale: it is an
 * integer TICK, and a tick is `FIXED_DT`. A lap written at any other scale is a
 * new schema, which is the point of pinning them here.
 */
export const LAP_QUANT = { pos: 1000, rot: 32767 } as const

/**
 * What happened at a tick, besides a pose.
 *
 * - `reset`: the pose at this tick was PLACED — a crash reset (DEV-126) or a
 *   boundary respawn — so the step into it is a teleport. The only tick at
 *   which a lap may jump (`PLAYER-GHOSTS.md` §3.4).
 * - `gate`: the live run took a ring on this tick.
 * - `finish`: the live run crossed the finish on this tick.
 *
 * The last two are not claims anybody trusts: the server rescores the poses.
 * They make the decimator keep the two poses either side of the edge, so that a
 * rescore sees the edge the live run saw (see `sim/ghost-record.ts`).
 */
export type LapEventKind = 'reset' | 'gate' | 'finish'

export interface LapEvent {
  readonly tick: number
  readonly kind: LapEventKind
}

export const LAP_EVENT_KINDS: readonly LapEventKind[] = ['reset', 'gate', 'finish']

/** Whose lap, under which rules. Strings, carried verbatim; the sim reads none of them. */
export interface LapMeta {
  readonly mission: string
  readonly mode: string
  readonly edition: string
  /** The gameplay rules version; a board is keyed by it (PLAYER-GHOSTS §3.6). */
  readonly rules: string
  readonly vehicle: string
  readonly build: string
}

/** `LapMeta`'s fields, in the order the wire header writes them. */
export const LAP_META_KEYS: readonly (keyof LapMeta)[] = [
  'mission',
  'mode',
  'edition',
  'rules',
  'vehicle',
  'build',
]

/**
 * `ff2-ghost-2`. THREE space, positions relative to the level's `worldOffset`,
 * exactly as `ff2-ghost-1` — so `game/ghosts.ts` places both the same way.
 * `sim/ghost-record.ts` writes it, and its wire codec carries it byte for byte.
 */
export interface LapDoc extends LapMeta {
  readonly $schema: typeof LAP_SCHEMA
  readonly keyCount: number
  /** Fixed-step ticks, strictly ascending. Tick 0 is the release; mission time is `tick × FIXED_DT`. */
  readonly tick: readonly number[]
  /** mm, three per key. */
  readonly p: readonly number[]
  /** int16 units of `LAP_QUANT.rot`, four per key. */
  readonly q: readonly number[]
  readonly events: readonly LapEvent[]
}

/**
 * Decode one `ff2-ghost-2` key into `data` at float offset `o`.
 *
 * Exported for ONE reader besides the decoder: `sim/ghost-record.ts`'s
 * decimator, which judges a key by what this will draw rather than by the
 * floats it was recorded from. Sharing it is what makes the decimator's error
 * bound a property of the decoded track and not of a second copy of the
 * arithmetic.
 */
export const writeLapKey = (
  data: Float64Array,
  o: number,
  tick: number,
  p: ArrayLike<number>,
  q: ArrayLike<number>,
  i: number,
): void => {
  data[o] = tick * FIXED_DT
  data[o + 1] = (p[i * 3] as number) / LAP_QUANT.pos
  data[o + 2] = (p[i * 3 + 1] as number) / LAP_QUANT.pos
  data[o + 3] = (p[i * 3 + 2] as number) / LAP_QUANT.pos
  // Renormalised for the reason `ff2-ghost-1` is: int16 rounding leaves |q| off
  // unit by ~1e-4, and a sample landing exactly on a key returns it verbatim.
  const qx = (q[i * 4] as number) / LAP_QUANT.rot
  const qy = (q[i * 4 + 1] as number) / LAP_QUANT.rot
  const qz = (q[i * 4 + 2] as number) / LAP_QUANT.rot
  const qw = (q[i * 4 + 3] as number) / LAP_QUANT.rot
  const len = Math.hypot(qx, qy, qz, qw) || 1
  data[o + 4] = qx / len
  data[o + 5] = qy / len
  data[o + 6] = qz / len
  data[o + 7] = qw / len
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

/**
 * Throw unless `doc` is a well-formed `ff2-ghost-2`: the arrays agree with
 * `keyCount`, every value is a safe integer, ticks ascend, quaternion
 * components fit int16, and the events are known kinds in tick order.
 *
 * A lap arrives from a browser, a link or a server, never from git, so nothing
 * trusts one to be well formed: the decoder calls this, and so do both halves of
 * the wire codec (`sim/ghost-record.ts`), so bytes are never written from a doc
 * that could not be read back, nor read into one. Whether the lap is PLAUSIBLE
 * is the validator's business (DEV-372); this guarantees only a clip
 * `sampleGhost` can sample.
 */
export const assertLapDoc = (doc: LapDoc): void => {
  if (doc.$schema !== LAP_SCHEMA) throw new Error(`ghost lap: schema is not ${LAP_SCHEMA}`)
  for (const key of LAP_META_KEYS) {
    if (typeof doc[key] !== 'string') throw new Error(`ghost lap: ${key} is not a string`)
  }
  const n = doc.keyCount
  if (!isInt(n) || n <= 0) throw new Error(`ghost lap: keyCount ${n} is not a positive integer`)
  if (
    !Array.isArray(doc.tick) ||
    !Array.isArray(doc.p) ||
    !Array.isArray(doc.q) ||
    doc.tick.length !== n ||
    doc.p.length !== n * 3 ||
    doc.q.length !== n * 4
  ) {
    throw new Error(
      `ghost lap: keyCount ${n} disagrees with tick=${doc.tick?.length} p=${doc.p?.length} q=${doc.q?.length}`,
    )
  }
  for (let i = 0; i < n; i++) {
    const t = doc.tick[i]
    if (!isInt(t)) throw new Error(`ghost lap: tick ${i} is not an integer`)
    if (i > 0 && t <= (doc.tick[i - 1] as number)) {
      throw new Error(`ghost lap: ticks must ascend, key ${i} is ${t} after ${doc.tick[i - 1]}`)
    }
  }
  for (const v of doc.p) if (!isInt(v)) throw new Error('ghost lap: a position is not an integer')
  for (const v of doc.q) {
    if (!isInt(v) || v < -LAP_QUANT.rot || v > LAP_QUANT.rot) {
      throw new Error(`ghost lap: quaternion component ${v} is outside int16`)
    }
  }
  const events = doc.events ?? []
  if (!Array.isArray(events)) throw new Error('ghost lap: events is not a list')
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as LapEvent
    if (!isInt(e?.tick) || !LAP_EVENT_KINDS.includes(e.kind)) {
      throw new Error(`ghost lap: event ${i} is not {tick, kind}`)
    }
    if (i > 0 && e.tick < (events[i - 1] as LapEvent).tick) {
      throw new Error(`ghost lap: events must be in tick order, event ${i} is not`)
    }
  }
}

/** Decode a player's lap, once `assertLapDoc` has passed it. */
const decodeLapClip = (doc: LapDoc): GhostClip => {
  assertLapDoc(doc)
  const n = doc.keyCount
  const events = doc.events ?? []
  const data = new Float64Array(n * GHOST_STRIDE)
  for (let i = 0; i < n; i++)
    writeLapKey(data, i * GHOST_STRIDE, doc.tick[i] as number, doc.p, doc.q, i)
  return createGhostClip(
    data,
    0,
    events.map((e) => ({ tick: e.tick, kind: e.kind })),
  )
}

/**
 * 2016's `ff2-ghost-1`, unchanged by DEV-370 but for the name of the function
 * it lives in. The scales are read from the document rather than assumed, so a
 * clip written at a different precision decodes correctly against this same
 * code and an old clip keeps decoding after the encoder changes.
 */
const decodeClip2016 = (doc: GhostDoc): GhostClip => {
  if (doc.$schema !== undefined && doc.$schema !== GHOST_SCHEMA) {
    throw new Error(
      `ghost clip: unknown schema ${doc.$schema}, expected ${GHOST_SCHEMA} or ${LAP_SCHEMA}`,
    )
  }
  const n = doc.keyCount
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`ghost clip: keyCount ${n} is not a positive integer`)
  }
  if (doc.t.length !== n || doc.p.length !== n * 3 || doc.q.length !== n * 4) {
    throw new Error(
      `ghost clip: keyCount ${n} disagrees with t=${doc.t.length} p=${doc.p.length} q=${doc.q.length}`,
    )
  }
  const { time, pos, rot } = doc.quant
  if (!(time > 0 && pos > 0 && rot > 0)) {
    throw new Error(
      `ghost clip: quant scales must all be positive, got ${JSON.stringify(doc.quant)}`,
    )
  }

  const data = new Float32Array(n * GHOST_STRIDE)
  for (let i = 0; i < n; i++) {
    const o = i * GHOST_STRIDE
    data[o] = (doc.t[i] as number) / time
    data[o + 1] = (doc.p[i * 3] as number) / pos
    data[o + 2] = (doc.p[i * 3 + 1] as number) / pos
    data[o + 3] = (doc.p[i * 3 + 2] as number) / pos

    // Renormalise. int16 rounding leaves |q| off unit by ~1e-4, and `readKey`
    // returns a key verbatim when a sample lands exactly on one -- so without
    // this, landing on a key hands the renderer a very slightly non-unit
    // quaternion while landing between two keys does not.
    const qx = (doc.q[i * 4] as number) / rot
    const qy = (doc.q[i * 4 + 1] as number) / rot
    const qz = (doc.q[i * 4 + 2] as number) / rot
    const qw = (doc.q[i * 4 + 3] as number) / rot
    const len = Math.hypot(qx, qy, qz, qw) || 1
    data[o + 4] = qx / len
    data[o + 5] = qy / len
    data[o + 6] = qz / len
    data[o + 7] = qw / len
  }
  return createGhostClip(data, doc.launchAt ?? 0)
}

/**
 * Decode an integer ghost document into the stream everything else samples:
 * `ff2-ghost-1` (2016's; its oldest files carry no `$schema`, which is still
 * accepted) or `ff2-ghost-2` (a player's lap).
 */
export const decodeGhostClip = (doc: GhostDoc | LapDoc): GhostClip => {
  if (doc.$schema === LAP_SCHEMA) return decodeLapClip(doc as LapDoc)
  return decodeClip2016(doc as GhostDoc)
}

/**
 * Binary search for the last key at or before `time`.
 *
 * Linear scanning would be fine at 1,400 keys and 81 Hz, and would still be
 * fine at ten ghosts. It is a binary search anyway because the alternative —
 * caching the last index and scanning forward — breaks the moment anything
 * seeks backwards, and a restart is a seek backwards.
 */
const keyBefore = (clip: GhostClip, time: number): number => {
  let lo = 0
  let hi = clip.keyCount - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((clip.data[mid * GHOST_STRIDE] as number) <= time) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Sample the clip at `time` seconds, into `out`.
 *
 * Clamps at both ends: before the start the ghost sits on its first pose, after
 * the end it sits on its last. It does NOT loop — a ghost that reappears at the
 * start line halfway through your run is a bug that looks like a feature.
 *
 * Position is linear and rotation is nlerp. At a 60 Hz recording the difference
 * between nlerp and slerp is far below the visible threshold, and nlerp cannot
 * produce the long-way-round flip that catches slerp implementations that skip
 * the dot-product sign check. The sign check is here regardless.
 */
export const sampleGhost = (clip: GhostClip, time: number, out: GhostPose): GhostPose => {
  const d = clip.data
  const last = clip.keyCount - 1

  if (time <= (d[0] as number)) return readKey(d, 0, out)
  if (time >= (d[last * GHOST_STRIDE] as number)) return readKey(d, last, out)

  const i = keyBefore(clip, time)
  const j = Math.min(i + 1, last)
  const t0 = d[i * GHOST_STRIDE] as number
  const t1 = d[j * GHOST_STRIDE] as number
  const span = t1 - t0
  const a = span > 0 ? (time - t0) / span : 0

  const oi = i * GHOST_STRIDE
  const oj = j * GHOST_STRIDE

  out.px = lerp(d[oi + 1] as number, d[oj + 1] as number, a)
  out.py = lerp(d[oi + 2] as number, d[oj + 2] as number, a)
  out.pz = lerp(d[oi + 3] as number, d[oj + 3] as number, a)

  let bx = d[oj + 4] as number
  let by = d[oj + 5] as number
  let bz = d[oj + 6] as number
  let bw = d[oj + 7] as number
  const ax = d[oi + 4] as number
  const ay = d[oi + 5] as number
  const az = d[oi + 6] as number
  const aw = d[oi + 7] as number

  // q and -q are the same rotation. Without this the interpolation takes the
  // long way round and the ghost spins through 300-odd degrees between two keys
  // that were a degree apart.
  if (ax * bx + ay * by + az * bz + aw * bw < 0) {
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }

  const qx = lerp(ax, bx, a)
  const qy = lerp(ay, by, a)
  const qz = lerp(az, bz, a)
  const qw = lerp(aw, bw, a)
  const len = Math.hypot(qx, qy, qz, qw) || 1
  out.qx = qx / len
  out.qy = qy / len
  out.qz = qz / len
  out.qw = qw / len
  return out
}

// ── Scoring a recording ───────────────────────────────────────────────────
//
// A clip is a flight PATH, not a result. 2016 recorded where the ship was, and
// nothing about what it scored — so `?opponents=ghosts` had an empty opponent
// list on the results panel, and "beat the fast ghost" was not a thing the game
// could say. The times below are what fills that in.
//
// ── It is not a physics replay, and that is the whole method ──────────────
//
// D20: a ghost is a pose track. So this does NOT re-fly the clip through the
// flight model — there is no `stepHoverJet` here, no input, no integrator and
// nothing that could drift. It samples the recorded pose at the sim's own fixed
// step and feeds the position to `stepCourse`, which is the same gate test the
// live run uses against the same spheres. A recording cannot desync from a
// retuned flight model because the flight model is not involved.
//
// ── The finish line, not the last ring ────────────────────────────────────
//
// `runIsOver` is imported from `ai-racer.ts` rather than reimplemented, because
// this is the third place that rule has to be right and the first two disagreed
// for months: 2016 ends a run at a separate non-scoring `Trigger_FinishLine`
// **234.6 m past ring 21** on `int_01` (DEV-045). Timing a ghost to its last
// ring would put a shorter course next to the player's on the same panel.
//
// SIM LAYER: pure. No clock, no renderer, no allocation beyond the result.

/** Where a clip's poses live, so a sampled key can be tested against gates. */
export interface GhostCourse {
  /** SIM space, exactly as `game/mission.ts` builds them. */
  readonly gates: readonly Gate[]
  /** SIM space. Null for a course with none — then every gate has to be taken. */
  readonly finish: FinishSphere | null
  /**
   * The level's `worldOffset`, THREE space.
   *
   * Clip positions are relative to the level's `levelOffset` GameObject, which
   * is exactly this — the same offset the terrain is placed by. Verified in
   * `game/ghosts.ts`: the first key of `int_01_leftSpawn_fast_01` plus this
   * lands within 3 m of the ghost's own authored spawn transform.
   */
  readonly worldOffset: readonly [number, number, number]
  /**
   * The shipped `GhostRacer` component's own stagger, seconds. 0.55 on `int_01`.
   *
   * Applied exactly as `game/ghosts.ts` applies it when it draws the ghost, so
   * the time this returns is the time you watched it take.
   */
  readonly startTime?: number
}

export interface GhostResult {
  /**
   * MISSION seconds at the finish — zero is the tick the player is released —
   * or null for a recording that never crosses it.
   *
   * Null prints as DNF, which is honest: a clip that stops short of the finish
   * gate has no finishing time and never will.
   */
  readonly seconds: number | null
  /** Rings this recording takes on the way. */
  readonly gates: number
  readonly gatesTotal: number
  /**
   * Path length flown to the finish, metres. An INDEPENDENT handle on
   * `seconds`: a time is only believable next to the distance it covered.
   */
  readonly distance: number
  /** `distance / seconds`, m/s. The other half of the same check. */
  readonly meanSpeed: number
  /**
   * Only when asked for (`{ ringTimes: true }`): MISSION seconds at which each
   * gate was taken, indexed by gate, null for one this recording missed. The
   * HUD's split against a ghost at every ring, and the order a validator checks.
   */
  readonly ringTimes?: readonly (number | null)[]
}

export interface ScoreGhostOptions {
  /** Record the mission time each gate is taken. See `GhostResult.ringTimes`. */
  readonly ringTimes?: boolean
}

/**
 * Fly a recorded clip round the course and report when it finishes.
 *
 * Pure, deterministic and O(keys); a few hundred microseconds per clip. It is
 * still not a per-frame call — `game/ghosts.ts` runs it once at load and keeps
 * the answer, which is the caching the results panel needs.
 *
 * **Deliberately NOT memoised inside this module.** A cache keyed on the clip
 * alone would hand a second course the first course's answer, and a clip is
 * shared across missions by design — that is trap 19's shape wearing different
 * clothes, and the cheapest way not to have it is not to build it.
 */
export const scoreGhost = (
  clip: GhostClip,
  course: GhostCourse,
  dt: number = FIXED_DT,
  options: ScoreGhostOptions = {},
): GhostResult => {
  const state = createCourse(course.gates)
  const ringTimes: (number | null)[] | null = options.ringTimes
    ? course.gates.map(() => null)
    : null
  const pose: GhostPose = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
  const [ox, oy, oz] = course.worldOffset
  const startTime = course.startTime ?? 0
  // SIM space. The clip is THREE space and relative to `levelOffset`, the gates
  // are absolute Unity space — so: add the offset, then flip z. The same flip
  // every gate centre goes through in `game/mission.ts`, and getting it wrong
  // scores the ghost against the mirror image of its own island.
  const at = { x: 0, y: 0, z: 0 }
  const place = (): void => {
    at.x = ox + pose.px
    at.y = oy + pose.py
    at.z = -(oz + pose.pz)
  }

  // Mission time -> clip time. `+ launchAt` skips the recording's own pre-race
  // hold (DEV-025: both `int_01` clips sit on their pad for about seven seconds)
  // so the ghost leaves the line on the tick the player does; `- startTime` is
  // the shipped component's stagger on top. Identical to what `game/ghosts.ts`
  // hands `sampleGhost` every frame, because a time nobody could have watched is
  // not a time.
  const clipAt = (mission: number): number => mission + clip.launchAt - startTime
  // The last mission time the recording has something to say about. Past it
  // `sampleGhost` clamps to the final pose and the ghost is parked, so scanning
  // on would only ever re-score a stationary ship.
  //
  // Plus HALF A TICK (DEV-370). The clock below is a running sum of `dt`, the
  // same sum `mission.elapsed` is, and the last key's time is one product; the
  // two can disagree in the last bit, either way. A player's lap ends ON its
  // finish tick, and the first recording of one scored `null`: the sum
  // overshot the product by a rounding error and the loop stopped a tick short
  // of the finish. Half a tick reaches the final key on every lap, and anything
  // sampled past the end is that same final pose: `sampleGhost` clamps there.
  const lastMission = clip.duration - clip.launchAt + startTime + dt / 2

  // A player lap's RESET ticks, as steps of the loop below (DEV-370). A reset
  // PUT the ship where it is, and the live run treats that as `placeMission`
  // does: the course is re-seeded, so a gate the ship was placed inside does
  // not score until it leaves and comes back (DEV-149 — a trigger fires on an
  // edge). Without this a rescore would pay for the ring a crash reset dropped
  // the ship into, and the teleport would count as path flown. 2016's clips
  // carry no events, so nothing about them changes.
  const shift = Math.round((startTime - clip.launchAt) / dt)
  const resets = new Set<number>()
  for (const e of clip.events) if (e.kind === 'reset') resets.add(e.tick + shift)

  sampleGhost(clip, clipAt(0), pose)
  place()
  let px = at.x
  let py = at.y
  let pz = at.z
  let distance = 0
  let seconds: number | null = null
  let step = 0

  for (let mission = dt; mission <= lastMission; mission += dt) {
    step++
    sampleGhost(clip, clipAt(mission), pose)
    place()
    const placed = resets.has(step)
    // The FIRST step seeds too (DEV-371), because the live mission's does:
    // `stepMission` has no previous position on its first call and seeds the
    // course from where the ship is, so a ring the ship is already inside on
    // tick 1 does not score until it leaves and comes back. DEV-370 left this
    // open: it agreed on `int_01`, whose release point is inside no ring, and a
    // course whose release sits inside one would have scored ring 0 here and
    // not live. It is a seed and not a placement, so the step is still path.
    if (placed || step === 1) seedCourse(state, at)
    if (!placed) distance += Math.hypot(at.x - px, at.y - py, at.z - pz)
    px = at.x
    py = at.y
    pz = at.z
    const took = stepCourse(state, at)
    if (ringTimes && took >= 0) ringTimes[took] = mission
    if (runIsOver(course.finish, at, state.passed)) {
      seconds = mission
      break
    }
  }

  const result: GhostResult = {
    seconds,
    gates: state.passedCount,
    gatesTotal: course.gates.length,
    distance,
    meanSpeed: seconds !== null && seconds > 0 ? distance / seconds : 0,
  }
  return ringTimes ? { ...result, ringTimes } : result
}

const readKey = (d: Float32Array | Float64Array, i: number, out: GhostPose): GhostPose => {
  const o = i * GHOST_STRIDE
  out.px = d[o + 1] as number
  out.py = d[o + 2] as number
  out.pz = d[o + 3] as number
  out.qx = d[o + 4] as number
  out.qy = d[o + 5] as number
  out.qz = d[o + 6] as number
  out.qw = d[o + 7] as number
  return out
}
