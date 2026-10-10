// src/net/pose-codec.ts — the pose message, §7.2 of plan/MULTIPLAYER.md. DEV-387.
//
// One message every `POSE_SEND_TICKS` fixed ticks: an 8-byte header and one
// 36-byte record per craft the sender flies (its own ship, and the bot host's
// bots, batched so bots cost no billed messages). Little-endian throughout.
//
//   header   0 tag (0x10)  1 slot (the ROOM writes it)  2 count  3 reserved  4 tick uint32
//   record   0 kind  1 index  2 flags  3 reserved
//            4 position int32 x3, millimetres           (LAP_QUANT.pos)
//           16 rotation int16 x4, quaternion x 32767    (LAP_QUANT.rot)
//           24 velocity int16 x3, m/s x 32 -> ±1023.97 m/s at 3.1 cm/s
//           30 stick int8 x4: pitch, roll, yaw, throttle (x 127)
//           34 reserved
//
// Millimetres and int16 quaternions are `ff2-ghost-2`'s own quantisation, so
// a remote track and a recorded lap agree to the unit. Positions are in
// whatever frame the caller writes; the game writes THREE space relative to
// the course's `worldOffset`, the lap recorder's frame (§7.2).
//
// NO ALLOCATION PER MESSAGE (§5.4, the Steam Frame's frame budget): `PoseWriter`
// encodes into a buffer it owns and reuses, and `decodePose` fills a `PoseFrame`
// the caller owns. Sending hands the socket a view of the writer's buffer; a
// real socket copies on send, and so does the harness's link.
//
// Pure, like every room module (`sim-purity-guard.test.ts`).

import { LAP_QUANT } from '../sim/ghost'
import {
  POSE_AT,
  POSE_HEADER_BYTES,
  POSE_KIND,
  POSE_RECORD_BYTES,
  POSE_TAG_V1,
  ROOM_MAX_SEATS,
} from './room-protocol'

/** Velocity quantum: m/s x 32 in an int16, so ±1023.97 m/s at 1/32 m/s. */
export const POSE_VELOCITY_SCALE = 32
/** The fastest a record can carry, m/s. `pose-codec.test.ts` holds every course's full-chain terminal speed under it. */
export const POSE_VELOCITY_MAX = 32767 / POSE_VELOCITY_SCALE
/** Stick axes, x 127 in an int8. */
export const POSE_STICK_SCALE = 127

/** A record's flag bits. */
export const POSE_FLAG = {
  boost: 1,
  crashHeld: 2,
  finished: 4,
  waiting: 8,
} as const

/**
 * The fifteen numbers a pose carries, wherever it is: on the wire
 * (`PoseRecord`), in the track's ring (`TrackInput`, read-only) and in what a
 * remote ship is drawn from (`DrawnPose`). Positions in metres, velocity in
 * m/s, stick in -1..1. TYPE ONLY: the three zero factories stay apart on
 * purpose (reuse audit XC-23): each is a reused hot-path object, and the rest
 * values live once, in {@link restPoseFields}.
 */
export interface PoseFields {
  flags: number
  px: number
  py: number
  pz: number
  qx: number
  qy: number
  qz: number
  qw: number
  vx: number
  vy: number
  vz: number
  pitch: number
  roll: number
  yaw: number
  throttle: number
}

/** One craft's pose, in floats. */
export interface PoseRecord extends PoseFields {
  kind: number
  index: number
}

/**
 * The fifteen numbers at rest: nothing moving, identity rotation. A FRESH
 * object on every call, because both callers reuse what they get for a whole
 * session and a shared one would be two owners (reuse audit, last clones).
 */
export const restPoseFields = (): PoseFields => ({
  flags: 0,
  px: 0,
  py: 0,
  pz: 0,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
  vx: 0,
  vy: 0,
  vz: 0,
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0,
})

export const poseRecord = (): PoseRecord => ({
  kind: POSE_KIND.own,
  index: 0,
  ...restPoseFields(),
})

/** A decoded message: the caller owns it and reuses it for every message. */
export interface PoseFrame {
  slot: number
  tick: number
  count: number
  readonly records: PoseRecord[]
}

export const poseFrame = (capacity = ROOM_MAX_SEATS): PoseFrame => ({
  slot: 0,
  tick: 0,
  count: 0,
  records: Array.from({ length: capacity }, poseRecord),
})

const clampInt = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : Math.round(v)

/**
 * Encodes pose messages into one buffer it owns. `encode` returns a view of
 * that buffer, valid until the next `encode`: send it (a socket copies) and
 * forget it.
 */
export class PoseWriter {
  readonly #bytes: Uint8Array
  readonly #view: DataView
  /** One view per record count, made once: a `subarray` per message would allocate. */
  readonly #views: Uint8Array[]

  constructor(capacity = ROOM_MAX_SEATS) {
    this.#bytes = new Uint8Array(POSE_HEADER_BYTES + POSE_RECORD_BYTES * capacity)
    this.#view = new DataView(this.#bytes.buffer)
    this.#views = Array.from({ length: capacity + 1 }, (_, n) =>
      this.#bytes.subarray(0, POSE_HEADER_BYTES + POSE_RECORD_BYTES * n),
    )
  }

  encode(tick: number, records: readonly PoseRecord[], count: number): Uint8Array {
    const b = this.#bytes
    const v = this.#view
    const len = POSE_HEADER_BYTES + POSE_RECORD_BYTES * count
    if (count < 1 || len > b.byteLength) throw new RangeError(`pose count ${count}`)
    b.fill(0, 0, len)
    b[POSE_AT.tag] = POSE_TAG_V1
    b[POSE_AT.count] = count
    v.setUint32(POSE_AT.tick, tick >>> 0, true)
    for (let i = 0; i < count; i++) {
      const r = records[i] as PoseRecord
      const at = POSE_HEADER_BYTES + i * POSE_RECORD_BYTES
      b[at + POSE_AT.kind] = r.kind
      b[at + POSE_AT.index] = r.index
      b[at + 2] = r.flags
      const p = at + POSE_AT.position
      v.setInt32(p, clampInt(r.px * LAP_QUANT.pos, -0x80000000, 0x7fffffff), true)
      v.setInt32(p + 4, clampInt(r.py * LAP_QUANT.pos, -0x80000000, 0x7fffffff), true)
      v.setInt32(p + 8, clampInt(r.pz * LAP_QUANT.pos, -0x80000000, 0x7fffffff), true)
      v.setInt16(at + 16, clampInt(r.qx * LAP_QUANT.rot, -32767, 32767), true)
      v.setInt16(at + 18, clampInt(r.qy * LAP_QUANT.rot, -32767, 32767), true)
      v.setInt16(at + 20, clampInt(r.qz * LAP_QUANT.rot, -32767, 32767), true)
      v.setInt16(at + 22, clampInt(r.qw * LAP_QUANT.rot, -32767, 32767), true)
      v.setInt16(at + 24, clampInt(r.vx * POSE_VELOCITY_SCALE, -32767, 32767), true)
      v.setInt16(at + 26, clampInt(r.vy * POSE_VELOCITY_SCALE, -32767, 32767), true)
      v.setInt16(at + 28, clampInt(r.vz * POSE_VELOCITY_SCALE, -32767, 32767), true)
      v.setInt8(at + 30, clampInt(r.pitch * POSE_STICK_SCALE, -127, 127))
      v.setInt8(at + 31, clampInt(r.roll * POSE_STICK_SCALE, -127, 127))
      v.setInt8(at + 32, clampInt(r.yaw * POSE_STICK_SCALE, -127, 127))
      v.setInt8(at + 33, clampInt(r.throttle * POSE_STICK_SCALE, -127, 127))
    }
    return this.#views[count] as Uint8Array
  }
}

/**
 * Decode `bytes` into `into`, allocating nothing. False (and `into` untouched
 * past what was read) for a message that is not a v1 pose message of a
 * consistent length: a newer build's tag is a version skew, dropped rather
 * than misread (king-tide's rule).
 */
// Little-endian reads straight off the bytes: a DataView per message is an allocation per message.
const i32 = (b: Uint8Array, o: number): number =>
  (b[o] as number) |
  ((b[o + 1] as number) << 8) |
  ((b[o + 2] as number) << 16) |
  ((b[o + 3] as number) << 24)
const i16 = (b: Uint8Array, o: number): number =>
  (((b[o] as number) | ((b[o + 1] as number) << 8)) << 16) >> 16
const i8 = (b: Uint8Array, o: number): number => ((b[o] as number) << 24) >> 24

export const decodePose = (bytes: Uint8Array, into: PoseFrame): boolean => {
  if (bytes.byteLength < POSE_HEADER_BYTES || bytes[POSE_AT.tag] !== POSE_TAG_V1) return false
  const count = bytes[POSE_AT.count] as number
  if (count < 1 || count > into.records.length) return false
  if (bytes.byteLength !== POSE_HEADER_BYTES + count * POSE_RECORD_BYTES) return false
  const b = bytes
  into.slot = b[POSE_AT.slot] as number
  into.tick = i32(b, POSE_AT.tick) >>> 0
  into.count = count
  for (let i = 0; i < count; i++) {
    const r = into.records[i] as PoseRecord
    const at = POSE_HEADER_BYTES + i * POSE_RECORD_BYTES
    r.kind = bytes[at + POSE_AT.kind] as number
    r.index = bytes[at + POSE_AT.index] as number
    r.flags = bytes[at + 2] as number
    const p = at + POSE_AT.position
    r.px = i32(b, p) / LAP_QUANT.pos
    r.py = i32(b, p + 4) / LAP_QUANT.pos
    r.pz = i32(b, p + 8) / LAP_QUANT.pos
    // NOT renormalised here, unlike ff2-ghost's decoder: int16 rounding leaves |q|
    // off 1 by up to ~1e-4, and renormalising moves a component by one unit on
    // re-encode in ~6 % of records, so decode would stop being encode's exact
    // inverse. The remote track normalises every rotation it draws instead.
    r.qx = i16(b, at + 16) / LAP_QUANT.rot
    r.qy = i16(b, at + 18) / LAP_QUANT.rot
    r.qz = i16(b, at + 20) / LAP_QUANT.rot
    r.qw = i16(b, at + 22) / LAP_QUANT.rot
    r.vx = i16(b, at + 24) / POSE_VELOCITY_SCALE
    r.vy = i16(b, at + 26) / POSE_VELOCITY_SCALE
    r.vz = i16(b, at + 28) / POSE_VELOCITY_SCALE
    r.pitch = i8(b, at + 30) / POSE_STICK_SCALE
    r.roll = i8(b, at + 31) / POSE_STICK_SCALE
    r.yaw = i8(b, at + 32) / POSE_STICK_SCALE
    r.throttle = i8(b, at + 33) / POSE_STICK_SCALE
  }
  return true
}
