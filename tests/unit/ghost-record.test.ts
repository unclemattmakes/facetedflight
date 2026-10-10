// tests/unit/ghost-record.test.ts — a player's lap, recorded, cut and carried.
// DEV-370, `docs/plan/PLAYER-GHOSTS.md` §5.
//
// The lap every gate below is held against is REAL: the autopilot flies
// `int_01_hoverJet` from the lift's release through `stepHoverJet` at the fixed
// step, and the game's own `stepMission` says when it took each ring and when
// it crossed the finish. That is the live run. The recorder only watches it.
//
// ── What each gate compares against ───────────────────────────────────────
//
// Nothing here is checked against a second copy of the recorder's arithmetic
// (CLAUDE.md, trap 24):
//
//   the TRACK     against the sim body itself, converted by
//                 `render/unity-space.ts` — the renderer's one definition of
//                 the flip, which the sim may not import;
//   the TIME      against `stepMission`'s own `finishAt` and ring events, which
//                 test the finish with a different function (mission.ts's
//                 sphere) from the one `scoreGhost` uses (`runIsOver`);
//   the BOUNDS    against the plan's numbers, written here as literals, not
//                 imported from the module that is meant to meet them.

import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { courseGates, placeMission, startMission, stepMission } from '@/game/mission'
import {
  flipPosition,
  flipQuaternion,
  threeQuatTupleToUnity,
  threeTupleToUnity,
} from '@/render/unity-space'
import type { FinishSphere } from '@/sim/ai-racer'
import { autopilotActions, nextGate } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import {
  decodeGhostClip,
  type GhostCourse,
  type GhostPose,
  LAP_SCHEMA,
  type LapDoc,
  sampleGhost,
  scoreGhost,
} from '@/sim/ghost'
import {
  clearLap,
  createLapRecorder,
  type LapRecorder,
  lapFromBytes,
  lapToBytes,
  markLapEvent,
  recordedLap,
  recordPose,
} from '@/sim/ghost-record'
import { createHoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import int01 from '../../content/levels/int_01_hoverJet.json'

const LEVEL = int01 as unknown as Level
const WORLD_OFFSET: readonly [number, number, number] = [
  LEVEL.worldOffset[0] as number,
  LEVEL.worldOffset[1] as number,
  LEVEL.worldOffset[2] as number,
]
const META = {
  mission: LEVEL.id,
  mode: 'ringAttack',
  edition: 'anniversary',
  rules: '1',
  vehicle: 'hoverJet',
  build: 'unit-test',
}

/** `PLAYER-GHOSTS.md` §5's bounds, as the plan wrote them. */
const BOUND_AXIS_M = 0.025
const BOUND_DEG = 0.5

const finishLevel = LEVEL.finish as NonNullable<Level['finish']>
const finishSphere: FinishSphere = {
  x: finishLevel.pos[0] as number,
  y: finishLevel.pos[1] as number,
  z: -(finishLevel.pos[2] as number),
  radius: finishLevel.radius,
}
/** A player's lap: no pad hold to skip and no 2016 stagger. */
const COURSE: GhostCourse = {
  gates: courseGates(LEVEL),
  finish: finishSphere,
  worldOffset: WORLD_OFFSET,
  startTime: 0,
}

interface FlownLap {
  readonly rec: LapRecorder
  /** The sim body at every recorded tick, SIM space, as the flight model left it. */
  readonly simPos: Float64Array
  readonly simQuat: Float64Array
  /** The live run's finish tick, and its `finishAt` — the mission clock's own sum. */
  readonly finishTick: number
  readonly finishAt: number
  readonly rings: number
  /** Gate index -> the tick the live run took it. */
  readonly ringTicks: ReadonlyMap<number, number>
}

/**
 * Fly the lap and record it the way `boot/app.ts` will (DEV-371): tick 0 is the
 * release, and each tick's pose is taken AFTER `stepHoverJet`, which is the
 * position `stepMission` scores. Recording stops on the finish tick, as a lap
 * the player keeps will.
 *
 * `recordBeforeStep` is the wiring mistake the time gate exists to catch, and
 * `ticksPastFinish` keeps the recorder running so that mistake lands as a
 * finish a tick late rather than as no finish at all.
 */
const flyLap = (
  options: { recordBeforeStep?: boolean; ticksPastFinish?: number } = {},
): FlownLap => {
  const jet = createHoverJet()
  jet.launched = true
  threeTupleToUnity(jet.body.position, LEVEL.spawn.pos as number[])
  threeQuatTupleToUnity(jet.body.orientation, LEVEL.spawn.quat as number[])
  jet.body.position.y += LEVEL.spawn.launch?.rise ?? 0

  const mission = startMission(LEVEL)
  const steps = Math.ceil(LEVEL.timer.timeLimit / FIXED_DT)
  const rec = createLapRecorder(WORLD_OFFSET, steps)
  const simPos = new Float64Array((steps + 1) * 3)
  const simQuat = new Float64Array((steps + 1) * 4)
  const record = (tick: number): void => {
    recordPose(rec, tick, jet.body.position, jet.body.orientation)
    const b = jet.body
    simPos.set([b.position.x, b.position.y, b.position.z], tick * 3)
    simQuat.set([b.orientation.x, b.orientation.y, b.orientation.z, b.orientation.w], tick * 4)
  }

  const input = noInput()
  const ringTicks = new Map<number, number>()
  let finishTick = -1
  let past = 0
  if (!options.recordBeforeStep) record(0)
  for (let tick = 1; tick <= steps; tick++) {
    const gates = mission.course.gates
    const target = nextGate(gates, mission.course.passed)
    const finishGate = mission.finishGate as NonNullable<typeof mission.finishGate>
    const aim = target >= 0 ? (gates[target] as (typeof gates)[number]).centre : finishGate
    const after = target >= 0 ? (gates[target + 1]?.centre ?? finishGate) : null
    autopilotActions(jet.body, aim, input, undefined, [], Number.POSITIVE_INFINITY, after)
    if (options.recordBeforeStep) record(tick)
    stepHoverJet(jet, input)
    if (!options.recordBeforeStep) record(tick)
    const ring = stepMission(mission, LEVEL, jet.body.position, FIXED_DT)
    if (finishTick >= 0) {
      if (++past >= (options.ticksPastFinish ?? 0)) break
      continue
    }
    if (ring >= 0) {
      ringTicks.set(ring, tick)
      markLapEvent(rec, tick, 'gate')
    }
    if (mission.finishCrossed) {
      finishTick = tick
      markLapEvent(rec, tick, 'finish')
      if (!options.ticksPastFinish) break
    }
  }
  return {
    rec,
    simPos,
    simQuat,
    finishTick,
    finishAt: mission.finishAt as number,
    rings: mission.ringsPassed,
    ringTicks,
  }
}

let flown: FlownLap | null = null
/** Flown once, on first use and never during collection. */
const lap = (): FlownLap => {
  if (!flown) flown = flyLap()
  return flown
}
const lapDoc = (): LapDoc => recordedLap(lap().rec, META)

// ── The live run is a real lap ────────────────────────────────────────────

describe('the lap under test', () => {
  it('is a finished int_01 lap with every ring, or nothing below means much', () => {
    const run = lap()
    expect(run.finishTick).toBeGreaterThan(0)
    expect(run.rings).toBe(COURSE.gates.length)
    expect(run.rec.count).toBe(run.finishTick + 1)
  })
})

// ── 1. The recorder ───────────────────────────────────────────────────────

describe('the recorder', () => {
  const pose = (x: number, y: number, z: number, q: [number, number, number, number]) => ({
    position: { x, y, z },
    orientation: { x: q[0], y: q[1], z: q[2], w: q[3] },
  })
  /** A rotation with every component non-zero, so a sign slip on any one shows. */
  const tilted = (() => {
    const [x, y, z, w] = [0.21, -0.37, 0.52, 0.74]
    const n = Math.hypot(x, y, z, w)
    return [x / n, y / n, z / n, w / n] as [number, number, number, number]
  })()
  /**
   * Keep every tick. A tolerance of ZERO does not: a span that interpolates a
   * dropped key exactly has zero error and is dropped, which on these
   * straight-line fixtures is most of them. No error is at or below -1.
   */
  const fullRate = { pos: -1, rot: -1 }

  it('stores THREE space relative to worldOffset, by the renderer’s own flip', () => {
    const rec = createLapRecorder(WORLD_OFFSET)
    const sims = [
      pose(-1812.25, 431.5, 2210.125, tilted),
      pose(35.5, 120.25, -40.75, [0, 0, 0, 1]),
      pose(2047.5, 988.0, -1333.3, [-tilted[1], tilted[0], -tilted[3], tilted[2]]),
    ]
    sims.forEach((s, i) => {
      recordPose(rec, i, s.position, s.orientation)
    })
    const clip = decodeGhostClip(recordedLap(rec, META, fullRate))
    const out: GhostPose = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
    sims.forEach((s, i) => {
      sampleGhost(clip, i * FIXED_DT, out)
      const want = flipPosition({ x: 0, y: 0, z: 0 }, s.position)
      expect(out.px + WORLD_OFFSET[0]).toBeCloseTo(want.x, 3)
      expect(out.py + WORLD_OFFSET[1]).toBeCloseTo(want.y, 3)
      expect(out.pz + WORLD_OFFSET[2]).toBeCloseTo(want.z, 3)
      const q = flipQuaternion({ x: 0, y: 0, z: 0, w: 1 }, s.orientation)
      const dot = Math.abs(out.qx * q.x + out.qy * q.y + out.qz * q.z + out.qw * q.w)
      expect(dot).toBeGreaterThan(Math.cos(((0.05 / 2) * Math.PI) / 180))
    })
  })

  it('keeps each quaternion on the last one’s hemisphere, so q and -q cost nothing', () => {
    const rec = createLapRecorder(WORLD_OFFSET)
    recordPose(rec, 0, { x: 0, y: 0, z: 0 }, { x: 0.6, y: 0, z: 0, w: 0.8 })
    recordPose(rec, 1, { x: 0, y: 0, z: 0 }, { x: -0.6, y: 0, z: 0, w: -0.8 })
    const doc = recordedLap(rec, META, fullRate)
    expect(doc.q.slice(4, 8)).toEqual(doc.q.slice(0, 4))
  })

  it('refuses a tick that does not ascend', () => {
    const rec = createLapRecorder(WORLD_OFFSET)
    const p = pose(0, 0, 0, [0, 0, 0, 1])
    recordPose(rec, 5, p.position, p.orientation)
    expect(() => recordPose(rec, 5, p.position, p.orientation)).toThrow(/does not follow/)
    expect(() => recordPose(rec, 4, p.position, p.orientation)).toThrow(/does not follow/)
    expect(() => recordPose(rec, 6.5, p.position, p.orientation)).toThrow(/not an integer/)
  })

  it('grows past its first capacity without losing a pose', () => {
    const rec = createLapRecorder(WORLD_OFFSET, 1)
    for (let t = 0; t < 1000; t++) {
      recordPose(rec, t, { x: t, y: t * 0.5, z: -t * 2 }, { x: 0, y: 0, z: 0, w: 1 })
    }
    const doc = recordedLap(rec, META, fullRate)
    expect(doc.keyCount).toBe(1000)
    expect(doc.tick[999]).toBe(999)
    expect(doc.p.slice(999 * 3)).toEqual([
      Math.round((999 - WORLD_OFFSET[0]) * 1000),
      Math.round((499.5 - WORLD_OFFSET[1]) * 1000),
      Math.round((999 * 2 - WORLD_OFFSET[2]) * 1000),
    ])
  })

  it('shares nothing between two recorders — trap 19', () => {
    const a = createLapRecorder(WORLD_OFFSET)
    const b = createLapRecorder(WORLD_OFFSET)
    recordPose(a, 0, { x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 0, w: 1 })
    const before = recordedLap(a, META, fullRate)
    recordPose(b, 0, { x: 9, y: 9, z: 9 }, { x: 1, y: 0, z: 0, w: 0 })
    markLapEvent(b, 0, 'reset')
    expect(recordedLap(a, META, fullRate)).toEqual(before)
  })

  it('clears for the next lap and keeps its buffer', () => {
    const rec = createLapRecorder(WORLD_OFFSET)
    recordPose(rec, 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 })
    markLapEvent(rec, 0, 'reset')
    const buffer = rec.poses
    clearLap(rec)
    expect(rec.count).toBe(0)
    expect(rec.events).toEqual([])
    expect(rec.poses).toBe(buffer)
    expect(() => recordedLap(rec, META)).toThrow(/nothing recorded/)
  })
})

// ── 2. The decimator ──────────────────────────────────────────────────────

describe('the decimated lap stays on the flown one', () => {
  it('holds every full-rate tick within 25 mm per axis and 0.5 degrees', () => {
    // Against the SIM BODY, flipped by the renderer's function, not against the
    // recorder's own stored floats: a wrong flip inside the recorder would be
    // invisible to a comparison with itself.
    const run = lap()
    const clip = decodeGhostClip(lapDoc())
    const out: GhostPose = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
    const at = { x: 0, y: 0, z: 0 }
    const q = { x: 0, y: 0, z: 0, w: 1 }
    let worstAxis = 0
    let worstDeg = 0
    let worstTick = -1
    for (let tick = 0; tick <= run.finishTick; tick++) {
      sampleGhost(clip, tick * FIXED_DT, out)
      flipPosition(at, {
        x: run.simPos[tick * 3] as number,
        y: run.simPos[tick * 3 + 1] as number,
        z: run.simPos[tick * 3 + 2] as number,
      })
      flipQuaternion(q, {
        x: run.simQuat[tick * 4] as number,
        y: run.simQuat[tick * 4 + 1] as number,
        z: run.simQuat[tick * 4 + 2] as number,
        w: run.simQuat[tick * 4 + 3] as number,
      })
      const axis = Math.max(
        Math.abs(out.px + WORLD_OFFSET[0] - at.x),
        Math.abs(out.py + WORLD_OFFSET[1] - at.y),
        Math.abs(out.pz + WORLD_OFFSET[2] - at.z),
      )
      // The angle by atan2, a different road from the decimator's acos.
      const dot = Math.abs(out.qx * q.x + out.qy * q.y + out.qz * q.z + out.qw * q.w)
      const norm = Math.hypot(q.x, q.y, q.z, q.w)
      const c = Math.min(1, dot / norm)
      const deg = (2 * Math.atan2(Math.sqrt(1 - c * c), c) * 180) / Math.PI
      if (axis > worstAxis) {
        worstAxis = axis
        worstTick = tick
      }
      worstDeg = Math.max(worstDeg, deg)
    }
    const said = `worst ${(worstAxis * 1000).toFixed(2)} mm at tick ${worstTick}, ${worstDeg.toFixed(3)} deg`
    expect(worstAxis, said).toBeLessThanOrEqual(BOUND_AXIS_M)
    expect(worstDeg, said).toBeLessThanOrEqual(BOUND_DEG)
    // And it is a decimation, not a copy: 2016's rule kept about a fifth.
    expect(clip.keyCount).toBeLessThan(run.rec.count / 4)
  })

  it('keeps both sides of every event, and nothing else pins a key', () => {
    // A straight, steady line decimates to its two ends. A `gate` at tick 20
    // must keep ticks 19 and 20, so a rescore sees the edge the live run saw.
    const rec = createLapRecorder(WORLD_OFFSET)
    for (let t = 0; t <= 40; t++) {
      recordPose(rec, t, { x: t * 2, y: 300, z: 0 }, { x: 0, y: 0, z: 0, w: 1 })
    }
    expect(recordedLap(rec, META).tick).toEqual([0, 40])
    markLapEvent(rec, 20, 'gate')
    expect(recordedLap(rec, META).tick).toEqual([0, 19, 20, 40])
  })

  it('keeps every event of the flown lap', () => {
    const doc = lapDoc()
    const kept = new Set(doc.tick)
    expect(doc.events.length).toBe(COURSE.gates.length + 1)
    for (const e of doc.events) {
      expect(kept.has(e.tick), `${e.kind} at ${e.tick}`).toBe(true)
      expect(kept.has(e.tick - 1), `the tick before ${e.kind} at ${e.tick}`).toBe(true)
    }
  })

  it('draws a reset as a jump between two exact poses, not a smear', () => {
    // A crash reset puts the ship 150 m back. The keys either side are kept
    // and exact, so the only interpolated span is the one tick of the jump.
    const rec = createLapRecorder(WORLD_OFFSET)
    for (let t = 0; t <= 30; t++) {
      const x = t < 15 ? t * 2 : t * 2 - 150
      recordPose(rec, t, { x, y: 300, z: 0 }, { x: 0, y: 0, z: 0, w: 1 })
    }
    markLapEvent(rec, 15, 'reset')
    const doc = recordedLap(rec, META)
    expect(doc.tick).toEqual([0, 14, 15, 30])
    expect(doc.events).toEqual([{ tick: 15, kind: 'reset' }])
    const clip = decodeGhostClip(doc)
    const out: GhostPose = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
    expect(sampleGhost(clip, 14 * FIXED_DT, out).px + WORLD_OFFSET[0]).toBeCloseTo(28, 3)
    expect(sampleGhost(clip, 15 * FIXED_DT, out).px + WORLD_OFFSET[0]).toBeCloseTo(-120, 3)
    expect(clip.events).toEqual([{ tick: 15, kind: 'reset' }])
  })
})

// ── 3. The time is the live run's ─────────────────────────────────────────

describe('scoring the recorded lap gives the live result', () => {
  it('finishes on the live finish tick, to the bit, with the live rings', () => {
    // `scoreGhost` sums `dt` the way `mission.elapsed` does, so on the right
    // tick the two are the SAME double, not merely close. And the recording
    // stops on its finish tick, which is the case that once scored `null`.
    const run = lap()
    const r = scoreGhost(decodeGhostClip(lapDoc()), COURSE, FIXED_DT, { ringTimes: true })
    expect(r.seconds).toBe(run.finishAt)
    expect(Math.round((r.seconds as number) / FIXED_DT)).toBe(run.finishTick)
    expect(r.gates).toBe(run.rings)
    const ringTicks = (r.ringTimes ?? []).map((t) => (t === null ? null : Math.round(t / FIXED_DT)))
    expect(ringTicks).toEqual(COURSE.gates.map((_, i) => run.ringTicks.get(i) ?? null))
  })

  it('and still does after the wire', () => {
    const run = lap()
    const doc = lapFromBytes(lapToBytes(lapDoc()))
    const r = scoreGhost(decodeGhostClip(doc), COURSE)
    expect(r.seconds).toBe(run.finishAt)
    expect(r.gates).toBe(run.rings)
    expect(r.ringTimes).toBeUndefined()
  })

  it('does not pay for a ring a reset PUT the ship in, exactly as the live mission does', () => {
    // The oracle is the game's own door for a placement: `placeMission` on the
    // reset tick, then `stepMission`, fed the same positions the lap records.
    // The track: 180 m short of ring 0, a reset into its centre (DEV-126's
    // crash rule does this), out the far side, then back in on purpose.
    const gate = COURSE.gates[0] as (typeof COURSE.gates)[number]
    const RESET = 10
    const offset = (tick: number): number =>
      tick < RESET ? -200 + 2 * tick : tick <= 40 ? 2 * (tick - RESET) : 60 - 2 * (tick - 40)
    const rec = createLapRecorder(WORLD_OFFSET)
    const mission = startMission(LEVEL)
    const live: number[] = []
    const at = { x: 0, y: 0, z: 0 }
    for (let tick = 0; tick <= 80; tick++) {
      at.x = gate.centre.x + offset(tick)
      at.y = gate.centre.y
      at.z = gate.centre.z
      recordPose(rec, tick, at, { x: 0, y: 0, z: 0, w: 1 })
      if (tick === 0) continue
      if (tick === RESET) {
        placeMission(mission, at)
        markLapEvent(rec, tick, 'reset')
      }
      if (stepMission(mission, LEVEL, at, FIXED_DT) === 0) live.push(tick)
    }
    // The live rule first, so the comparison below is with something real:
    // nothing on the reset tick, and ring 0 on the way back in.
    expect(live).toHaveLength(1)
    expect(live[0]).toBeGreaterThan(40)

    const r = scoreGhost(decodeGhostClip(recordedLap(rec, META)), COURSE, FIXED_DT, {
      ringTimes: true,
    })
    const ring0 = r.ringTimes?.[0]
    expect(ring0 === null || ring0 === undefined ? null : Math.round(ring0 / FIXED_DT)).toBe(
      live[0],
    )
    expect(r.gates).toBe(1)
    // And the jump is not path: 2 m a tick for the 79 ticks that moved.
    expect(r.distance).toBeCloseTo(2 * 79, 1)
  })

  it('does not pay for a ring the ship is inside on its FIRST step, as the live mission does not', () => {
    // DEV-371, closing the seeding question DEV-370 left open. `stepMission`
    // seeds the course on its first call, from wherever the ship is, so a
    // release inside a ring scores nothing until the ship leaves and comes
    // back. The oracle is `stepMission` itself, fed the same positions. The
    // track: in ring 0's centre at the release, out the far side, back in.
    const gate = COURSE.gates[0] as (typeof COURSE.gates)[number]
    const offset = (tick: number): number => (tick <= 30 ? 2 * tick : 60 - 2 * (tick - 30))
    const rec = createLapRecorder(WORLD_OFFSET)
    const mission = startMission(LEVEL)
    const live: number[] = []
    const at = { x: 0, y: 0, z: 0 }
    for (let tick = 0; tick <= 60; tick++) {
      at.x = gate.centre.x + offset(tick)
      at.y = gate.centre.y
      at.z = gate.centre.z
      recordPose(rec, tick, at, { x: 0, y: 0, z: 0, w: 1 })
      if (tick === 0) continue
      if (stepMission(mission, LEVEL, at, FIXED_DT) === 0) live.push(tick)
    }
    // The live rule first: nothing on tick 1, ring 0 on the way back in.
    expect(live).toHaveLength(1)
    expect(live[0]).toBeGreaterThan(30)

    const r = scoreGhost(decodeGhostClip(recordedLap(rec, META)), COURSE, FIXED_DT, {
      ringTimes: true,
    })
    const ring0 = r.ringTimes?.[0]
    expect(ring0 === null || ring0 === undefined ? null : Math.round(ring0 / FIXED_DT)).toBe(
      live[0],
    )
    expect(r.gates).toBe(1)
    // A seed is not a placement: the first step is still path flown.
    expect(r.distance).toBeCloseTo(2 * 60, 1)
  })

  it('moves the finish a tick late when the pose is taken BEFORE the step', () => {
    // The wiring mistake, kept as a test so the gate above is known to see it.
    const early = flyLap({ recordBeforeStep: true, ticksPastFinish: 1 })
    const r = scoreGhost(decodeGhostClip(recordedLap(early.rec, META)), COURSE)
    expect(Math.round((r.seconds as number) / FIXED_DT)).toBe(early.finishTick + 1)
  })
})

// ── 4. The wire ───────────────────────────────────────────────────────────

/**
 * The wire from its SPEC (`ghost-record.ts`, §3), built by hand: `FFG2`, a
 * varint header length, the header JSON, then the body's varints as given.
 * For bytes `lapToBytes` will not write, and as a second reading of the format.
 */
const wire = (header: object, body: readonly number[]): Uint8Array => {
  const varint = (value: number): number[] => {
    const out: number[] = []
    let v = value
    for (; v >= 128; v = Math.floor(v / 128)) out.push((v % 128) + 128)
    out.push(v)
    return out
  }
  const json = new TextEncoder().encode(JSON.stringify(header))
  return Uint8Array.from([0x46, 0x46, 0x47, 0x32, ...varint(json.length), ...json, ...body])
}
const HEADER = { $schema: LAP_SCHEMA, ...META, events: [] }
/** keyCount 1; tick 5 (zigzag 10); the origin; identity, qw 32767 (zigzag 65534). */
const ONE_KEY = [1, 10, 0, 0, 0, 0, 0, 0, 0xfe, 0xff, 0x03]

describe('the wire', () => {
  it('round-trips the flown lap: identity on every integer', () => {
    const doc = lapDoc()
    expect(lapFromBytes(lapToBytes(doc))).toEqual(doc)
  })

  it('round-trips the edges: a lap from before the release, big jumps, int16 ends', () => {
    const doc: LapDoc = {
      $schema: LAP_SCHEMA,
      ...META,
      mission: 'ünïcode_mission',
      keyCount: 4,
      tick: [-400, -1, 0, 900_000],
      p: [-4_096_000, 0, 4_096_000, 1, -1, 0, 2_000_000_000, -2_000_000_000, 7, 0, 0, 0],
      q: [32767, -32767, 0, 0, -32767, 32767, 1, -1, 0, 0, 0, 32767, 12, -13, 14, -15],
      events: [
        { tick: -1, kind: 'reset' },
        { tick: 0, kind: 'gate' },
        { tick: 0, kind: 'finish' },
      ],
    }
    expect(lapFromBytes(lapToBytes(doc))).toEqual(doc)
  })

  it('refuses bytes it could not have written', () => {
    const bytes = lapToBytes(lapDoc())
    const bad = (b: Uint8Array) => () => lapFromBytes(b)
    expect(bad(Uint8Array.from([0x7b, ...bytes.subarray(1)]))).toThrow(/magic/)
    expect(bad(bytes.subarray(0, bytes.length - 1))).toThrow(/truncated/)
    expect(bad(bytes.subarray(0, 40))).toThrow()
    expect(bad(Uint8Array.from([...bytes, 0]))).toThrow(/trailing/)
    // The rest are bytes `lapToBytes` refuses to write, so they are built from
    // the format's spec (see `wire`). A keyCount the input could never hold is
    // refused before anything is allocated for it: the half of a zip bomb that
    // reaches the decoder.
    expect(bad(wire(HEADER, [0xff, 0xff, 0xff, 0x7f]))).toThrow(/cannot fit/)
    // Two keys on one tick: the second tick's change is zero.
    expect(bad(wire(HEADER, [2, 10, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(
      /does not ascend/,
    )
    expect(bad(wire({ ...HEADER, $schema: 'ff2-ghost-3' }, ONE_KEY))).toThrow(/header is not/)
    expect(bad(wire({ ...HEADER, rules: 1 }, ONE_KEY))).toThrow(/rules is not a string/)
    // A quaternion component past int16 decodes as a number and is refused as a value.
    expect(bad(wire(HEADER, [1, 10, 0, 0, 0, 0, 0, 0, 0x80, 0xf1, 0x04]))).toThrow(/int16/)
  })

  it('reads the format as its spec describes it, not only as `lapToBytes` writes it', () => {
    // One key at tick 5, the origin, identity: zigzag 5 is 10, zigzag 1 is 2.
    const doc = lapFromBytes(wire(HEADER, ONE_KEY))
    expect(doc).toEqual({ ...HEADER, keyCount: 1, tick: [5], p: [0, 0, 0], q: [0, 0, 0, 32767] })
    // And the encoder writes exactly those bytes back.
    expect([...lapToBytes(doc)]).toEqual([...wire(HEADER, ONE_KEY)])
  })

  it('refuses to write a lap it could not read back', () => {
    const doc = lapDoc()
    // One key short: the last key's integers would go out as NaN, stored as 0.
    expect(() => lapToBytes({ ...doc, keyCount: doc.keyCount + 1 })).toThrow(/disagrees/)
    expect(() => lapToBytes({ ...doc, tick: doc.tick.map((t) => t + 0.5) })).toThrow(/integer/)
  })

  it('decodes ff2-ghost-2 into float64, and refuses a malformed document', () => {
    const doc = lapDoc()
    const clip = decodeGhostClip(doc)
    expect(clip.data).toBeInstanceOf(Float64Array)
    expect(clip.launchAt).toBe(0)
    expect(clip.events).toEqual(doc.events)
    const bad = (over: Partial<LapDoc>) => () => decodeGhostClip({ ...doc, ...over })
    expect(bad({ keyCount: doc.keyCount + 1 })).toThrow(/disagrees/)
    expect(bad({ tick: [...doc.tick].reverse() })).toThrow(/ascend/)
    expect(bad({ q: doc.q.map((v, i) => (i === 3 ? 40000 : v)) })).toThrow(/int16/)
    expect(bad({ p: doc.p.map((v, i) => (i === 0 ? 0.5 : v)) })).toThrow(/not an integer/)
    expect(bad({ events: [{ tick: 1, kind: 'teleport' as 'reset' }] })).toThrow(/event 0/)
  })
})

// ── 5. The byte budget ────────────────────────────────────────────────────

/**
 * The autopilot `int_01` lap, measured 2026-09-24. PINNED: a change to the
 * recorder, the decimator or the codec that moves these has to edit this line,
 * and say why. `raw` is this module's own output and is exact. `deflated` is
 * zlib's, which can differ by a few bytes between builds and CPUs, so it is
 * held to 2 % of the measurement rather than to the byte.
 *
 * Re-measured 2026-09-25 for DEV-394, which changed the AUTOPILOT, not the
 * recorder: its lap no longer weaves, so the decimator has fewer turns to keep
 * (1136 keys, 17,166 raw, 15,393 deflated before).
 */
const MEASURED = { keys: 907, raw: 13819, deflated: 12270 }

describe('the byte budget', () => {
  it('fits the autopilot int_01 lap in 20 KB deflated, the way a browser deflates it', () => {
    // `deflateRawSync` at zlib's default level is what `CompressionStream
    // ('deflate-raw')` produces; §3.2 measured level 9, which is 0.1 % smaller.
    const doc = lapDoc()
    const raw = lapToBytes(doc)
    const deflated = deflateRawSync(raw).length
    expect(deflated).toBeLessThanOrEqual(20 * 1024)
    expect({ keys: doc.keyCount, raw: raw.length }).toEqual({
      keys: MEASURED.keys,
      raw: MEASURED.raw,
    })
    expect(Math.abs(deflated - MEASURED.deflated)).toBeLessThanOrEqual(MEASURED.deflated * 0.02)
  })
})
