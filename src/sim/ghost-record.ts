// src/sim/ghost-record.ts — recording a player's lap, and the bytes it travels as.
//
// DEV-370, the first piece of `docs/plan/PLAYER-GHOSTS.md`. Three things, in
// the order a lap meets them:
//
//   1. THE RECORDER. One pose per fixed step, appended to a growing buffer:
//      THREE space, relative to the level's `worldOffset`, indexed by the
//      integer TICK. Tick 0 is the release — the mission clock's zero — and the
//      pose recorded at tick k is the pose AFTER step k, because that is the
//      position `stepMission` scores and the moment `mission.elapsed` reads
//      `k × dt`. A caller that records before the step instead hands every
//      pose the previous tick's position and the finish lands one tick late;
//      `tests/unit/ghost-record.test.ts` is the argument.
//
//   2. THE DECIMATOR. 2016's greedy rule — the one its Motion Recorder clips
//      were cut down with before they shipped (`tools/prototype/
//      unity_anim_to_json.js`, `decimate`): walk forward from an anchor, and
//      keep a key only when spanning past it would put some dropped key more
//      than 25 mm off on any axis. Two changes, both so the bound holds on what
//      is DRAWN rather than on the floats it was recorded from:
//        - a key is judged by `sampleGhost` on the DECODED integers, so the
//          quantisation of the kept keys is inside the bound, not on top of it;
//        - rotation is judged as an ANGLE (see `LAP_DECIMATE_ROT`), where 2016
//          took a tenth of the position epsilon per quaternion component.
//      And one addition: the two poses either side of every event tick are
//      always kept, so a rescore sees the edges the live run saw (below).
//
//   3. THE WIRE. Delta-varint, the encoding §3.2 measured smallest of the
//      faithful ones (a 25 mm lap in ~16 KB raw, ~15 KB deflated, against 27 KB
//      for the same keys as `ff2-ghost-1` JSON). Compression is NOT here:
//      deflate is `CompressionStream` in a browser and `node:zlib` in a test,
//      and neither is the sim's to import.
//
// ── Why the event ticks are kept ──────────────────────────────────────────
//
// A lap is rescored from its poses (`scoreGhost`), by the results panel and by
// the server, which ignores any claimed time. Gates and the finish are sphere
// ENTRIES tested once a tick, so a 25 mm error at the tick before an entry can
// move it: the ship 1 cm outside the finish on the live run can be 1.5 cm
// inside on the decimated track, and the lap is scored a tick early, or a ring
// grazed for one tick is missed outright. Keeping the pose at the event tick and
// the one before it pins both sides of every edge to the quantisation (0.5 mm).
//
// SIM LAYER: no three, no DOM, no clock (hard rule 4). The per-tick path writes
// into typed arrays and allocates only when the buffer doubles.

import { FIXED_DT, TICK_RATE } from './constants'
import {
  assertLapDoc,
  GHOST_STRIDE,
  type GhostClip,
  type GhostPose,
  LAP_EVENT_KINDS,
  LAP_META_KEYS,
  LAP_QUANT,
  LAP_SCHEMA,
  type LapDoc,
  type LapEvent,
  type LapEventKind,
  type LapMeta,
  sampleGhost,
  writeLapKey,
} from './ghost'
import type { Quat } from './math/quat'
import type { Vec3 } from './math/vec3'

// ── 1. The recorder ───────────────────────────────────────────────────────

/** Floats per recorded tick: `px, py, pz, qx, qy, qz, qw`. */
const POSE_STRIDE = 7

export interface LapRecorder {
  /** THREE space; the lap's positions are recorded relative to it. */
  readonly worldOffset: readonly [number, number, number]
  /** Recorded ticks, strictly ascending. Grows by doubling. */
  ticks: Int32Array
  /** `POSE_STRIDE` float64s per recorded tick, THREE space, relative to `worldOffset`. */
  poses: Float64Array
  /** Ticks recorded so far. */
  count: number
  /** Ticks ascending. Rare, so an ordinary array. */
  readonly events: LapEvent[]
}

/**
 * A recorder for one lap at a time; `clearLap` reuses it for the next.
 *
 * `capacityTicks` is only where the buffer starts, and it doubles past it. A
 * caller that knows the mission's `timeLimit` passes `timeLimit / FIXED_DT` and
 * never grows it; the default is one second of ticks.
 */
export const createLapRecorder = (
  worldOffset: readonly [number, number, number],
  capacityTicks: number = Math.ceil(TICK_RATE),
): LapRecorder => {
  const capacity = Math.max(1, Math.ceil(capacityTicks))
  return {
    worldOffset: [worldOffset[0], worldOffset[1], worldOffset[2]],
    ticks: new Int32Array(capacity),
    poses: new Float64Array(capacity * POSE_STRIDE),
    count: 0,
    events: [],
  }
}

/** Forget the lap and keep the buffers, for a restart. */
export const clearLap = (rec: LapRecorder): void => {
  rec.count = 0
  rec.events.length = 0
}

/**
 * Append the pose at `tick`, from the sim's own body: SIM space (Unity's,
 * left-handed), absolute. Converted here, once, into what a ghost stores —
 * THREE space relative to `worldOffset` — so no caller does the flip by hand.
 * It is the inverse of `scoreGhost`'s `place()`, and of `game/ghosts.ts`'s
 * placement, and matches `render/unity-space.ts` (which the sim cannot import).
 *
 * Throws on a tick that does not ascend: a lap with two poses at one tick is a
 * wiring bug, and it would be scored as one.
 */
export const recordPose = (
  rec: LapRecorder,
  tick: number,
  position: Vec3,
  orientation: Quat,
): void => {
  if (!Number.isSafeInteger(tick)) throw new Error(`ghost-record: tick ${tick} is not an integer`)
  const n = rec.count
  if (n > 0 && tick <= (rec.ticks[n - 1] as number)) {
    throw new Error(`ghost-record: tick ${tick} does not follow ${rec.ticks[n - 1]}`)
  }
  if (n === rec.ticks.length) grow(rec)

  const [ox, oy, oz] = rec.worldOffset
  let qx = -orientation.x
  let qy = -orientation.y
  let qz = orientation.z
  let qw = orientation.w
  const o = n * POSE_STRIDE
  const d = rec.poses
  // q and -q are one rotation. Keeping each on the previous one's hemisphere
  // makes the per-key deltas small on the wire, and makes the decimator's
  // straight-line test between two keys mean what `sampleGhost` will draw.
  if (
    n > 0 &&
    qx * (d[o - 4] as number) +
      qy * (d[o - 3] as number) +
      qz * (d[o - 2] as number) +
      qw * (d[o - 1] as number) <
      0
  ) {
    qx = -qx
    qy = -qy
    qz = -qz
    qw = -qw
  }
  rec.ticks[n] = tick
  d[o] = position.x - ox
  d[o + 1] = position.y - oy
  d[o + 2] = -position.z - oz
  d[o + 3] = qx
  d[o + 4] = qy
  d[o + 5] = qz
  d[o + 6] = qw
  rec.count = n + 1
}

/**
 * Note an event at `tick`: a `reset` the pose at that tick was placed by, or a
 * `gate` / `finish` the live run scored on it. Either order against
 * `recordPose` for the same tick. A repeat of one (tick, kind) is ignored.
 */
export const markLapEvent = (rec: LapRecorder, tick: number, kind: LapEventKind): void => {
  if (!Number.isSafeInteger(tick)) throw new Error(`ghost-record: tick ${tick} is not an integer`)
  if (!LAP_EVENT_KINDS.includes(kind)) throw new Error(`ghost-record: unknown event ${kind}`)
  const events = rec.events
  const last = events[events.length - 1]
  if (last && tick < last.tick) {
    throw new Error(`ghost-record: event at ${tick} is before one at ${last.tick}`)
  }
  for (let i = events.length - 1; i >= 0 && (events[i] as LapEvent).tick === tick; i--) {
    if ((events[i] as LapEvent).kind === kind) return
  }
  events.push({ tick, kind })
}

const grow = (rec: LapRecorder): void => {
  const ticks = new Int32Array(rec.ticks.length * 2)
  ticks.set(rec.ticks)
  const poses = new Float64Array(rec.poses.length * 2)
  poses.set(rec.poses)
  rec.ticks = ticks
  rec.poses = poses
}

// ── 2. The decimator ──────────────────────────────────────────────────────

/**
 * Metres, per axis. 2016's: both shipped `int_01` clips are the `.eps025`
 * streams (`tools/extract/ghost.mjs`), and `ghost.ts` calls the error "smaller
 * than the vertex jitter on the terrain it flies over". A player's lap is cut
 * to the same rule so the two kinds of ghost are drawn to one standard.
 */
export const LAP_DECIMATE_POS = 0.025

/**
 * Radians of rotation between the decoded pose and the recorded one: 0.25
 * degrees.
 *
 * 2016's rule was a tenth of the position epsilon per quaternion COMPONENT,
 * 0.0025, which is about 0.29 degrees for an error in one component and up to
 * 0.57 when all four err together: a bound on the numbers, not on what a
 * viewer sees. An angle is what a viewer sees, and PLAYER-GHOSTS §5 holds the
 * decoded track to 0.5 degrees. Half of that leaves the int16 quantisation
 * (0.034 degrees) and every rounding in between a wide margin.
 *
 * It costs almost nothing, because rotation hardly ever binds: on the autopilot
 * `int_01` lap, 0.5 degrees keeps 1,136 keys, 0.25 keeps the same 1,136, and
 * even 0.1 keeps only 1,148. Position decides where the keys go.
 */
export const LAP_DECIMATE_ROT = (0.25 * Math.PI) / 180

/** Angle between two quaternions, radians; sign-blind, as a rotation is. */
const angleBetween = (
  ax: number,
  ay: number,
  az: number,
  aw: number,
  bx: number,
  by: number,
  bz: number,
  bw: number,
): number => {
  const dot = Math.abs(ax * bx + ay * by + az * bz + aw * bw)
  const norm = Math.hypot(ax, ay, az, aw) * Math.hypot(bx, by, bz, bw) || 1
  return 2 * Math.acos(Math.min(1, dot / norm))
}

/** Binary search for the index of `tick` in the recording, or -1. */
const indexOfTick = (rec: LapRecorder, tick: number): number => {
  let lo = 0
  let hi = rec.count - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const t = rec.ticks[mid] as number
    if (t === tick) return mid
    if (t < tick) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

/**
 * The finished lap as an `ff2-ghost-2` document: every tick quantised, then
 * decimated against what the decoder will draw from those integers.
 *
 * Allocates freely: it runs once, when the lap ends, never in the fixed step.
 */
export const recordedLap = (
  rec: LapRecorder,
  meta: LapMeta,
  tolerance: { readonly pos: number; readonly rot: number } = {
    pos: LAP_DECIMATE_POS,
    rot: LAP_DECIMATE_ROT,
  },
): LapDoc => {
  const n = rec.count
  if (n === 0) throw new Error('ghost-record: nothing recorded')
  for (const key of LAP_META_KEYS) {
    if (typeof meta[key] !== 'string') throw new Error(`ghost-record: meta.${key} is not a string`)
  }

  // Quantise every tick first. The decimator judges a candidate span by
  // decoding THESE, so the rounding of the keys it keeps is inside its bound.
  const qp = new Int32Array(n * 3)
  const qq = new Int32Array(n * 4)
  const d = rec.poses
  for (let i = 0; i < n; i++) {
    const o = i * POSE_STRIDE
    for (let c = 0; c < 3; c++) qp[i * 3 + c] = Math.round((d[o + c] as number) * LAP_QUANT.pos)
    for (let c = 0; c < 4; c++) {
      // Clamped: a unit quaternion's component can sit a hair past 1 after the
      // sim's own arithmetic, and int16 has no room at the ends.
      const v = Math.max(-1, Math.min(1, d[o + 3 + c] as number))
      qq[i * 4 + c] = Math.round(v * LAP_QUANT.rot)
    }
  }

  // The event ticks, and the tick before each: both sides of every edge.
  const pinned = new Uint8Array(n)
  for (const e of rec.events) {
    const i = indexOfTick(rec, e.tick)
    if (i < 0) continue
    pinned[i] = 1
    if (i > 0) pinned[i - 1] = 1
  }

  // Two decoded keys and a clip over them: `sampleGhost` on this is, bit for
  // bit, `sampleGhost` on the decoded lap between the same two keys.
  const pair = new Float64Array(2 * GHOST_STRIDE)
  const span: GhostClip = { data: pair, keyCount: 2, duration: 0, launchAt: 0, events: [] }
  const pose: GhostPose = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
  const spanHolds = (a: number, b: number): boolean => {
    writeLapKey(pair, 0, rec.ticks[a] as number, qp, qq, a)
    writeLapKey(pair, GHOST_STRIDE, rec.ticks[b] as number, qp, qq, b)
    for (let k = a + 1; k < b; k++) {
      sampleGhost(span, (rec.ticks[k] as number) * FIXED_DT, pose)
      const o = k * POSE_STRIDE
      if (
        Math.abs(pose.px - (d[o] as number)) > tolerance.pos ||
        Math.abs(pose.py - (d[o + 1] as number)) > tolerance.pos ||
        Math.abs(pose.pz - (d[o + 2] as number)) > tolerance.pos ||
        angleBetween(
          pose.qx,
          pose.qy,
          pose.qz,
          pose.qw,
          d[o + 3] as number,
          d[o + 4] as number,
          d[o + 5] as number,
          d[o + 6] as number,
        ) > tolerance.rot
      ) {
        return false
      }
    }
    return true
  }

  // 2016's greedy walk: from the anchor, try to span to i + 1; when that fails,
  // key i is the last one that could be dropped to, so it is kept.
  const kept: number[] = [0]
  let anchor = 0
  for (let i = 1; i < n - 1; i++) {
    if (pinned[i] === 1 || !spanHolds(anchor, i + 1)) {
      kept.push(i)
      anchor = i
    }
  }
  if (n > 1) kept.push(n - 1)

  const tick: number[] = []
  const p: number[] = []
  const q: number[] = []
  for (const i of kept) {
    tick.push(rec.ticks[i] as number)
    p.push(qp[i * 3] as number, qp[i * 3 + 1] as number, qp[i * 3 + 2] as number)
    q.push(
      qq[i * 4] as number,
      qq[i * 4 + 1] as number,
      qq[i * 4 + 2] as number,
      qq[i * 4 + 3] as number,
    )
  }
  return {
    $schema: LAP_SCHEMA,
    mission: meta.mission,
    mode: meta.mode,
    edition: meta.edition,
    rules: meta.rules,
    vehicle: meta.vehicle,
    build: meta.build,
    keyCount: kept.length,
    tick,
    p,
    q,
    events: rec.events.map((e) => ({ tick: e.tick, kind: e.kind })),
  }
}

// ── 3. The wire ───────────────────────────────────────────────────────────
//
//   'F' 'F' 'G' '2'                       magic, so garbage fails before a parse
//   varint  header length, then that many bytes of UTF-8 JSON:
//           { $schema, mission, mode, edition, rules, vehicle, build, events }
//   varint  keyCount
//   per key, each a zigzag varint of the change from the previous key (the
//   first key's from zero):
//           tick, px, py, pz (mm), qx, qy, qz, qw (int16 units)
//
// Zigzag throughout, the tick included: a lap MAY begin before its release (a
// recorder switched on in the lift would write negative ticks), and a decoder
// that cannot say so would have to be changed to. After the first key a tick
// delta is at least one, which the decoder enforces.

const MAGIC = [0x46, 0x46, 0x47, 0x32]

/**
 * The fewest bytes a key can occupy: one per varint. What lets the decoder
 * refuse a `keyCount` its input could not hold BEFORE it allocates for it —
 * which is the zip-bomb half a server needs from a decoder.
 */
const MIN_KEY_BYTES = 1 + 3 + 4

const zigzag = (v: number): number => (v >= 0 ? v * 2 : -v * 2 - 1)
const unzigzag = (u: number): number => (u % 2 === 0 ? u / 2 : -(u + 1) / 2)

/** LEB128, by arithmetic: bitwise operators would truncate past 2^31. */
const writeVarint = (out: number[], value: number): void => {
  let v = value
  while (v >= 0x80) {
    out.push((v % 0x80) + 0x80)
    v = Math.floor(v / 0x80)
  }
  out.push(v)
}

/**
 * Serialise a lap. The inverse of `lapFromBytes`, byte for byte. Refuses a doc
 * `assertLapDoc` refuses: a `keyCount` longer than its arrays would otherwise
 * write `NaN`, which a `Uint8Array` stores as a silent zero.
 */
export const lapToBytes = (doc: LapDoc): Uint8Array => {
  assertLapDoc(doc)
  const header = JSON.stringify({
    $schema: doc.$schema,
    mission: doc.mission,
    mode: doc.mode,
    edition: doc.edition,
    rules: doc.rules,
    vehicle: doc.vehicle,
    build: doc.build,
    events: doc.events.map((e) => ({ tick: e.tick, kind: e.kind })),
  })
  const headerBytes = new TextEncoder().encode(header)
  const out: number[] = [...MAGIC]
  writeVarint(out, headerBytes.length)
  for (const b of headerBytes) out.push(b)

  const n = doc.keyCount
  writeVarint(out, n)
  let t0 = 0
  const p0 = [0, 0, 0]
  const q0 = [0, 0, 0, 0]
  for (let i = 0; i < n; i++) {
    const t = doc.tick[i] as number
    writeVarint(out, zigzag(t - t0))
    t0 = t
    for (let c = 0; c < 3; c++) {
      const v = doc.p[i * 3 + c] as number
      writeVarint(out, zigzag(v - (p0[c] as number)))
      p0[c] = v
    }
    for (let c = 0; c < 4; c++) {
      const v = doc.q[i * 4 + c] as number
      writeVarint(out, zigzag(v - (q0[c] as number)))
      q0[c] = v
    }
  }
  return Uint8Array.from(out)
}

/**
 * Read a lap back. Refuses bad magic, truncated or trailing bytes, an absurd
 * `keyCount` before allocating for it, ticks that do not ascend, a header that
 * is not this schema, and anything `assertLapDoc` refuses. It does NOT judge
 * the lap: whether anybody could have flown it is the validator's (DEV-372).
 */
export const lapFromBytes = (bytes: Uint8Array): LapDoc => {
  let at = 0
  const readVarint = (): number => {
    let value = 0
    let scale = 1
    for (;;) {
      if (at >= bytes.length) throw new Error('ghost lap: truncated')
      const b = bytes[at++] as number
      value += (b % 0x80) * scale
      if (!Number.isSafeInteger(value)) throw new Error('ghost lap: a varint overflows')
      if (b < 0x80) return value
      scale *= 0x80
    }
  }

  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('ghost lap: not an ff2-ghost-2 lap (bad magic)')
  }
  at = MAGIC.length
  const headerLength = readVarint()
  if (headerLength > bytes.length - at) throw new Error('ghost lap: truncated header')
  let header: Record<string, unknown>
  try {
    header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(at, at + headerLength)),
    )
  } catch {
    throw new Error('ghost lap: the header is not JSON')
  }
  at += headerLength
  if (header === null || typeof header !== 'object' || header.$schema !== LAP_SCHEMA) {
    throw new Error(`ghost lap: header is not ${LAP_SCHEMA}`)
  }
  const meta: Record<string, string> = {}
  for (const key of LAP_META_KEYS) {
    const v = header[key]
    if (typeof v !== 'string') throw new Error(`ghost lap: header.${key} is not a string`)
    meta[key] = v
  }
  const rawEvents = header.events
  if (!Array.isArray(rawEvents)) throw new Error('ghost lap: header.events is not a list')
  const events: LapEvent[] = rawEvents.map((e: unknown, i: number) => {
    const ev = e as { tick?: unknown; kind?: unknown }
    if (!Number.isSafeInteger(ev?.tick) || !LAP_EVENT_KINDS.includes(ev?.kind as LapEventKind)) {
      throw new Error(`ghost lap: event ${i} is not {tick, kind}`)
    }
    return { tick: ev.tick as number, kind: ev.kind as LapEventKind }
  })

  const n = readVarint()
  if (n === 0 || n > (bytes.length - at) / MIN_KEY_BYTES) {
    throw new Error(`ghost lap: keyCount ${n} cannot fit in ${bytes.length - at} bytes`)
  }
  const tick = new Array<number>(n)
  const p = new Array<number>(n * 3)
  const q = new Array<number>(n * 4)
  let t0 = 0
  const p0 = [0, 0, 0]
  const q0 = [0, 0, 0, 0]
  for (let i = 0; i < n; i++) {
    const dt = unzigzag(readVarint())
    if (i > 0 && dt < 1) throw new Error(`ghost lap: key ${i}'s tick does not ascend`)
    t0 += dt
    tick[i] = t0
    for (let c = 0; c < 3; c++) {
      p0[c] = (p0[c] as number) + unzigzag(readVarint())
      p[i * 3 + c] = p0[c] as number
    }
    for (let c = 0; c < 4; c++) {
      q0[c] = (q0[c] as number) + unzigzag(readVarint())
      q[i * 4 + c] = q0[c] as number
    }
  }
  if (at !== bytes.length) throw new Error(`ghost lap: ${bytes.length - at} trailing bytes`)

  const doc: LapDoc = {
    $schema: LAP_SCHEMA,
    mission: meta.mission as string,
    mode: meta.mode as string,
    edition: meta.edition as string,
    rules: meta.rules as string,
    vehicle: meta.vehicle as string,
    build: meta.build as string,
    keyCount: n,
    tick,
    p,
    q,
    events,
  }
  assertLapDoc(doc)
  return doc
}
