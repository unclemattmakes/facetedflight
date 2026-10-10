// tests/unit/mode-crossed-progress.test.ts — both vehicles, both modes, one course.
//
// ── The bug this exists for (DEV-235) ─────────────────────────────────────
//
// `game/mission.ts` gated the ring and pad PROGRESS counters on
// `rules.scores`. Both autopilots steer by exactly those counters:
//
//     HoverJet   `nextGate(mission.course.gates, mission.course.passed)`
//     JumpSeat   `jumpSeatPilot.step(mission.targets.padTaken)`
//
// so a HoverJet in Target Practice never advanced `course.passed`, `nextGate`
// returned 0 for ever, and it flew to ring 1, was not credited, and flew to
// ring 1 again. A JumpSeat in Ring Attack re-flew pad 1 the same way. Measured
// in `perf-out/vehicle-mode/` before the fix: **1538 m inside a 173x133 m box**
// over 60 s where the mission's own mode flew 7873 m, and the two JumpSeat cells
// sat at their spawn for the whole arm without moving one metre.
//
// ── Why it was invisible to 400+ green tests ──────────────────────────────
//
// `tests/unit/autopilot.test.ts` flies the whole of `int_01_hoverJet` and calls
// `createCourse`/`stepCourse` **itself**. It never goes through `stepMission`,
// so there is no mode in it and the gate it would have to cross does not exist
// on its path. `jumpseat-autopilot-missions.test.ts` does go through
// `stepMission` — and flies all six missions in their own mode, where the gate
// is open. Neither harness could see this, and no shipped mission is in the
// state that reveals it: the thirteen pair each vehicle with its own mode, which
// is the collinearity `docs/plan/VR-PERF-WAVE-3.md` §3 is about.
//
// **So the assertions here go through `stepMission` and cross the mode.** That
// is the whole design of the file; a version that stepped the course directly
// would be green before the fix.
//
// ── The course ────────────────────────────────────────────────────────────
//
// `rookie_02_jumpSeat` is the ONLY shipped course with both — 29 live rings on
// the `CurvyClonePath` route and 7 live pads, authored side by side, with
// `ringAttackParent` null so nothing can ever switch the rings off. It is
// therefore the one mission where "what advances" and "what scores" can be
// pulled apart on real content instead of on a fixture.
//
// ── What 2016 does, which is what the fix restores ────────────────────────
//
// `TriggerCheckpoint.OnTriggerEnter` disables the ring's colliders, plays
// `CollectRing`, disables the parent checkpoint, deactivates the art, fires the
// effect and calls `EnableNextRoute()` — all unconditionally. Exactly one line
// is guarded:
//
//     if (addScore) { if (energySystem != null) ++energySystem.gatesCleared; }
//
// and `energySystem` is the `EnergySystem_Ship` the JumpSeat has not got. So a
// 2016 ring in a Target Practice mission really is consumed and really does
// advance the route; it just never increments the counter. `live` advances,
// `scores` banks.

import { describe, expect, it } from 'vitest'
import type { GameMode, Level } from '@/content/level-schema'
import { courseGates, NO_LEVERS, startMission, stepMission } from '@/game/mission'
import { padZones } from '@/game/targets'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { autopilotActions, DEFAULT_AUTOPILOT, nextGate } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import { createHoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import { type Vec3, v3 } from '@/sim/math/vec3'
import rookie02 from '../../content/levels/rookie_02_jumpSeat.json'
import {
  flyJumpSeatMission,
  jumpSeatTerrainAvailable,
  loadJumpSeatLevel,
} from './helpers/jumpseat-run'

const LEVEL = rookie02 as unknown as Level

/** The two modes that put ring and pad content in the world. */
const CROSSED: readonly GameMode[] = ['targetPractice', 'ringAttack']

// ── Half 1: the gate itself, on synthetic positions ───────────────────────
//
// No autopilot, no flight model, no terrain and no `public/assets/` — so this
// half runs on CI, where the flown half below cannot. It is deliberately the
// narrow guard: the flown half proves the consequence, this proves the cause,
// and the house rule is that a gate living only where the assets exist can rot
// for months while every run stays green.

/** Straight-line flight from `a` to `b`, sampled at the fixed timestep. */
const flyThrough = (
  state: ReturnType<typeof startMission>,
  from: Vec3,
  to: Vec3,
  speed = 60,
): Vec3 => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / (speed * FIXED_DT)))
  const at = v3()
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    at.x = from.x + dx * t
    at.y = from.y + dy * t
    at.z = from.z + dz * t
    stepMission(state, LEVEL, at, FIXED_DT, NO_LEVERS)
  }
  return at
}

/** A point `d` metres before `to` on the line from `from`, so the sweep crosses it. */
const approach = (from: Vec3, to: Vec3, d: number): Vec3 => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const len = Math.hypot(dx, dy, dz) || 1
  return v3(to.x - (dx / len) * d, to.y - (dy / len) * d, to.z - (dz / len) * d)
}

describe('the ring and pad counters advance on `live`, not on `scores`', () => {
  it('a ring advances the course in BOTH modes — and scores in only one', () => {
    const gate = courseGates(LEVEL)[0]
    expect(gate, 'rookie_02_jumpSeat should author rings').toBeDefined()
    if (!gate) return

    const seen = new Map<GameMode, { passed: number; score: number }>()
    for (const mode of CROSSED) {
      const state = startMission(LEVEL, mode)
      expect(state.mode, `${mode} should survive runningMode on this level`).toBe(mode)
      flyThrough(state, approach(v3(0, gate.centre.y, 0), gate.centre, 400), gate.centre)
      seen.set(mode, { passed: state.course.passedCount, score: state.score })
    }

    // THE assertion. Before DEV-235 the Target Practice row was 0.
    for (const mode of CROSSED) {
      expect(seen.get(mode)?.passed, `${mode} did not advance the course`).toBe(1)
    }
    // ...and the banking still belongs to the mode. `readScores` sums only
    // `rules.scores`, so `course.score` accrues in Target Practice and is never
    // read there — the 2,900 points `modes.ts` prices those 29 rings at stay
    // uninvented.
    expect(seen.get('ringAttack')?.score, 'Ring Attack should score the ring').toBeGreaterThan(0)
    expect(seen.get('targetPractice')?.score, 'Target Practice must not score a ring').toBe(0)
  })

  it('a pad plate advances the targets in BOTH modes — and scores in only one', () => {
    const zone = padZones(LEVEL)[0]
    expect(zone, 'rookie_02_jumpSeat should author pads').toBeDefined()
    if (!zone) return

    const seen = new Map<GameMode, { taken: number; score: number }>()
    for (const mode of CROSSED) {
      const state = startMission(LEVEL, mode)
      // Straight down onto the plate: the zones are thin boxes set into the pad
      // floor, so a descent is the approach that crosses one.
      const above = v3(zone.centre.x, zone.centre.y + 200, zone.centre.z)
      flyThrough(state, above, v3(zone.centre.x, zone.centre.y - 1, zone.centre.z))
      // `padTaken` is a per-PAD latch array, and it is what the JumpSeat
      // autopilot is handed — so the count of set entries is the progress the
      // controller actually reads, not `padsHit`, which is the scorer's tally.
      seen.set(mode, { taken: state.targets.padTaken.filter(Boolean).length, score: state.score })
    }

    // Before DEV-235 the Ring Attack row was 0 — which is what froze the
    // JumpSeat autopilot, because `padTaken` is the only thing it steers by.
    for (const mode of CROSSED) {
      expect(seen.get(mode)?.taken, `${mode} did not advance the targets`).toBeGreaterThan(0)
    }
    expect(
      seen.get('targetPractice')?.score,
      'Target Practice should score the plate',
    ).toBeGreaterThan(0)
    expect(seen.get('ringAttack')?.score, 'Ring Attack must not score a plate').toBe(0)
  })

  it('warns when the running mode can score nothing on this level', () => {
    // The other half of DEV-235, and the reason it is a warning and not a
    // refusal: `int_01_hoverJet` has no pads at all, so a HoverJet course in
    // Target Practice is playable and banks nothing. Silent on all thirteen in
    // their own mode.
    const warnings: string[] = []
    const real = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))
    try {
      startMission(LEVEL, 'targetPractice')
      expect(warnings, 'the mission in its own mode must be silent').toHaveLength(0)
      startMission(LEVEL, 'ringAttack')
      expect(warnings, 'rookie_02 has 29 live rings, so Ring Attack is scoreable too').toHaveLength(
        0,
      )
    } finally {
      console.warn = real
    }
  })
})

// ── Half 2: flown, by the real autopilots ─────────────────────────────────

/**
 * The HoverJet, flown through `stepMission` — the harness that did not exist.
 *
 * `autopilot.test.ts`'s own `fly()` steps `stepCourse` directly, which is
 * precisely why it cannot see a mode gate. The call shape here is otherwise
 * that one verbatim, including the seventh `nextTarget` argument whose absence
 * silently disabled corner braking in that harness for the life of the feature.
 *
 * No terrain, as there: `pathClearance` returns Infinity without a field and the
 * question being asked is whether the counter advances, not whether the ship
 * survives the desert. Needs no `public/assets/`, so this half runs on CI.
 */
const flyHoverJet = (level: Level, mode: GameMode, maxSeconds: number) => {
  const jet = createHoverJet()
  // Gravity is off once the elevator has released (`LaunchElevator.FinishLaunch`).
  jet.launched = true
  threeTupleToUnity(jet.body.position, level.spawn.pos as number[])
  threeQuatTupleToUnity(jet.body.orientation, level.spawn.quat as number[])
  jet.body.position.y += level.spawn.launch?.rise ?? 0

  const mission = startMission(level, mode)
  const input = noInput()
  const start = v3(jet.body.position.x, jet.body.position.y, jet.body.position.z)
  let metres = 0
  let elapsed = 0

  const steps = Math.ceil(maxSeconds / FIXED_DT)
  for (let i = 0; i < steps && !mission.finished; i++) {
    const target = nextGate(mission.course.gates, mission.course.passed)
    if (target < 0) break
    const gate = mission.course.gates[target]
    if (!gate) break
    const after = mission.course.gates[target + 1]?.centre ?? null
    autopilotActions(
      jet.body,
      gate.centre,
      input,
      DEFAULT_AUTOPILOT,
      [],
      Number.POSITIVE_INFINITY,
      after,
    )
    const was = v3(jet.body.position.x, jet.body.position.y, jet.body.position.z)
    stepHoverJet(jet, input)
    metres += Math.hypot(
      jet.body.position.x - was.x,
      jet.body.position.y - was.y,
      jet.body.position.z - was.z,
    )
    // The game's own door, which is where the gate was.
    stepMission(mission, level, jet.body.position, FIXED_DT, NO_LEVERS)
    elapsed += FIXED_DT
  }

  return {
    ringsPassed: mission.course.passedCount,
    metres,
    elapsed,
    finished: mission.finished,
    start,
    end: v3(jet.body.position.x, jet.body.position.y, jet.body.position.z),
  }
}

describe('the HoverJet autopilot flies rookie_02_jumpSeat in EITHER mode', () => {
  // 120 s, comfortably inside the level's 180 s `timer.timeLimit`, so that
  // `MODES.ringAttack.clockEnds` (true) and `targetPractice`'s (false) cannot
  // end one run and not the other and confound the comparison below.
  const RUNS = new Map<GameMode, ReturnType<typeof flyHoverJet>>()
  const run = (mode: GameMode) => {
    const hit = RUNS.get(mode)
    if (hit) return hit
    const flown = flyHoverJet(LEVEL, mode, 120)
    RUNS.set(mode, flown)
    return flown
  }

  it('passes rings in Ring Attack — the control', () => {
    const flown = run('ringAttack')
    expect(flown.ringsPassed, 'took no rings in its own ring mode').toBeGreaterThan(5)
    expect(flown.metres).toBeGreaterThan(2000)
  }, 30_000)

  it('passes rings in TARGET PRACTICE — red before DEV-235', () => {
    // This is the 1538 m / 173x133 m cell. Before the fix `course.passed` never
    // advanced, so `nextGate` returned 0 on every tick and the ship circled
    // ring 1 for the whole arm.
    const flown = run('targetPractice')
    expect(flown.ringsPassed, 'the crossed pairing took no rings').toBeGreaterThan(5)
    expect(flown.metres, 'the crossed pairing barely moved').toBeGreaterThan(2000)
  }, 30_000)

  it('flies the SAME path in both — the mode no longer steers the ship', () => {
    // The strong form, and the one DEV-230's 2x2 needs to be readable at all:
    // with progress off `scores`, nothing the HoverJet autopilot reads is
    // mode-gated, so the two runs are the same arithmetic and must agree
    // exactly. A sweep whose cells fly different distances is comparing four
    // different flights, which is what voided that table.
    const ring = run('ringAttack')
    const target = run('targetPractice')
    expect(target.ringsPassed).toBe(ring.ringsPassed)
    expect(target.metres).toBeCloseTo(ring.metres, 6)
    expect(target.end.x).toBeCloseTo(ring.end.x, 6)
    expect(target.end.y).toBeCloseTo(ring.end.y, 6)
    expect(target.end.z).toBeCloseTo(ring.end.z, 6)
  }, 30_000)
})

// The JumpSeat half flies over the real collision height field, which lives in
// gitignored `public/assets/` (`pnpm assets:pull`). Per CLAUDE.md's
// `describe.skipIf` trap every byte of that disk work happens inside an `it` —
// `loadJumpSeatLevel` reads `content/levels/`, which is tracked, and
// `jumpSeatTerrainAvailable` is an `existsSync`; neither touches the maps.
const HAVE_MAPS = jumpSeatTerrainAvailable(LEVEL)

describe.skipIf(!HAVE_MAPS)(
  'the JumpSeat autopilot flies rookie_02_jumpSeat in EITHER mode',
  () => {
    const RUNS = new Map<GameMode, ReturnType<typeof flyJumpSeatMission>>()
    const run = (mode: GameMode) => {
      const hit = RUNS.get(mode)
      if (hit) return hit
      const flown = flyJumpSeatMission(loadJumpSeatLevel('rookie_02_jumpSeat'), { mode })
      RUNS.set(mode, flown)
      return flown
    }

    it('takes pads in Target Practice — the control', () => {
      const flown = run('targetPractice')
      expect(flown.padTaken, 'took no pads in its own pad mode').toBeGreaterThan(0)
    }, 60_000)

    it('takes pads in RING ATTACK — red before DEV-235', () => {
      // `jumpSeatPilot.step(mission.targets.padTaken)` is the only progress the
      // JumpSeat controller has. Gated on `scores`, `padTaken` never moved in Ring
      // Attack and the seat re-flew pad 1 until the arm ran out.
      const flown = run('ringAttack')
      expect(flown.padTaken, 'the crossed pairing took no pads').toBeGreaterThan(0)
    }, 60_000)

    it('ends up in the same place in both — the mode no longer steers the seat', () => {
      // Loosened from the HoverJet's exact agreement on purpose:
      // `MODES.targetPractice.finishSettleSeconds` is 0.1 and Ring Attack's is 0
      // (`LevelFinaleManager.cs:36`), so a run that crosses the finish slab keeps
      // scoring for one-tenth of a second longer in one mode than the other. That
      // is a real difference in when the run ENDS, not in where the seat went, so
      // the tolerance is a few metres of descent rather than the float agreement
      // the HoverJet gets.
      const target = run('targetPractice')
      const ring = run('ringAttack')
      const apart = Math.hypot(
        target.finalPosition.x - ring.finalPosition.x,
        target.finalPosition.y - ring.finalPosition.y,
        target.finalPosition.z - ring.finalPosition.z,
      )
      expect(apart, `the two modes ended ${apart.toFixed(1)} m apart`).toBeLessThan(25)
      expect(target.padTaken).toBe(ring.padTaken)
    }, 60_000)
  },
)

describe.skipIf(HAVE_MAPS)('the skip guard itself', () => {
  it('is only skipping because the terrain maps are absent', () => {
    // The loud counterpart. Without it the suite above could be skipped for
    // months — a red gate argues for itself, a skipped one reads as a pass in a
    // summary line.
    expect(HAVE_MAPS, 'run `pnpm assets:pull` to fly the JumpSeat half').toBe(false)
  })
})
