// tests/unit/ai-racer.test.ts — opponents that fly.
//
// Matt: *"let's simplify and deviate from 2016 by giving our ghosts the same
// autopilot logic we're using for the player proxy."* DEV-026.
//
// The properties that matter are not "does it work" — it is the same autopilot
// and the same flight model the player uses, both already tested. They are:
// does it actually get round, and do the two racers fly DIFFERENTLY. Three
// identical controllers are a procession, which is worse than the recordings
// they replace.

import { describe, expect, it } from 'vitest'
import {
  AI_RACER_TUNINGS,
  type AiRacerSpec,
  createAiRacer,
  FLY_OUT_CLIMB,
  stepAiRacer,
} from '@/sim/ai-racer'
import { DEFAULT_AUTOPILOT } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import type { Gate } from '@/sim/course'
import { v3 } from '@/sim/math/vec3'
import int01 from '../../content/levels/int_01_hoverJet.json'

/** The real course, in sim space, the way the loader builds it. */
const gates: Gate[] = (
  int01.routes['0'] as { rings: { pos: number[]; trigger: { radius: number } }[] }
).rings.map((r) => ({
  // The level JSON is THREE space; sim space is that mirrored in z.
  centre: v3(r.pos[0] as number, r.pos[1] as number, -(r.pos[2] as number)),
  radius: r.trigger.radius,
  points: 100,
  triggerOnce: true,
}))

const spawn = v3(-857.8, 126.4, -2082.4)
const spec = (id: string, tuning: (typeof AI_RACER_TUNINGS)[string]): AiRacerSpec => ({
  id,
  spawn,
  orientation: [0, 0, 0, 1],
  tuning,
})

/** Fly a racer for `seconds` with no terrain, and report where it got to. */
const fly = (id: string, tuning: (typeof AI_RACER_TUNINGS)[string], seconds: number) => {
  const racer = createAiRacer(spec(id, tuning), gates)
  const steps = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < steps && !racer.finished; i++) stepAiRacer(racer, gates, [], FIXED_DT)
  return racer
}

describe('an AI racer', () => {
  it('starts LAUNCHED, or it falls off its pad', () => {
    // An unlaunched HoverJet has gravity on. `LaunchElevator.FinishLaunch()` is
    // what turns it off for the player, and a racer never rides an elevator.
    const racer = createAiRacer(spec('x', DEFAULT_AUTOPILOT), gates)
    expect(racer.jet.launched).toBe(true)
    expect(racer.jet.body.position.y).toBeCloseTo(126.4, 6)
  })

  it('counts gate ZERO, which `> 0` would have silently dropped', () => {
    // `stepCourse` returns the gate INDEX. Gate 0 is the first gate of every
    // course, so the guard has to be `>= 0`.
    const racer = fly('x', AI_RACER_TUNINGS.fast as never, 20)
    expect(racer.gates).toBeGreaterThan(0)
    expect(racer.gates).toBe(racer.course.passedCount)
    expect(racer.course.passed[0]).toBe(true)
  })

  it('gets round a real course', () => {
    const racer = fly('x', AI_RACER_TUNINGS.fast as never, 240)
    expect(racer.gates, `took ${racer.gates} of ${gates.length}`).toBe(gates.length)
    expect(racer.finished).toBe(true)
    expect(racer.finishedAt).toBeGreaterThan(10)
  })

  it('is DETERMINISTIC — the same racer twice is the same run', () => {
    // The sim has no wall clock and no RNG, so two racers with one spec must
    // agree to the last float. Without that a race is not reproducible and a
    // regression in the flight model cannot be seen.
    const a = fly('x', AI_RACER_TUNINGS.fast as never, 30)
    const b = fly('x', AI_RACER_TUNINGS.fast as never, 30)
    expect(a.jet.body.position.x).toBe(b.jet.body.position.x)
    expect(a.jet.body.position.y).toBe(b.jet.body.position.y)
    expect(a.jet.body.position.z).toBe(b.jet.body.position.z)
    expect(a.gates).toBe(b.gates)
  })

  it('flies a DIFFERENT LINE from the other racer, which is the whole point', () => {
    // Two identical controllers land on top of each other. The tunings exist to
    // stop that, and this is the assertion that says they do.
    const fast = fly('fast', AI_RACER_TUNINGS.fast as never, 30)
    const steady = fly('steady', AI_RACER_TUNINGS.steady as never, 30)
    const apart = Math.hypot(
      fast.jet.body.position.x - steady.jet.body.position.x,
      fast.jet.body.position.y - steady.jet.body.position.y,
      fast.jet.body.position.z - steady.jet.body.position.z,
    )
    expect(apart, `${apart.toFixed(0)} m apart after 30 s`).toBeGreaterThan(50)
  })

  it('is a VARIATION on the player proxy, not a clone of it', () => {
    // Sampled over the WHOLE run rather than at one instant: two lines that
    // differ can still cross, and asserting a snapshot measures the crossing.
    //
    // And the bound is 10 m, not 40. `fast` differs from the player proxy only
    // in `leadMetres` and bank, which is worth about 13 m over 30 s — it is a
    // sharper version of the same driver. The racer that flies a genuinely
    // different line is `steady`, and the test above holds it to 50 m.
    const a = createAiRacer(spec('fast', AI_RACER_TUNINGS.fast as never), gates)
    const b = createAiRacer(spec('player', DEFAULT_AUTOPILOT), gates)
    let worst = 0
    for (let i = 0; i < Math.round(30 / FIXED_DT); i++) {
      stepAiRacer(a, gates, [], FIXED_DT)
      stepAiRacer(b, gates, [], FIXED_DT)
      worst = Math.max(
        worst,
        Math.hypot(
          a.jet.body.position.x - b.jet.body.position.x,
          a.jet.body.position.y - b.jet.body.position.y,
          a.jet.body.position.z - b.jet.body.position.z,
        ),
      )
    }
    expect(worst, `${worst.toFixed(0)} m apart at their furthest`).toBeGreaterThan(10)
  })

  it('has one racer genuinely quicker than the other', () => {
    // `steady` does not boost and holds a wider line; `fast` cuts corners. If
    // they finished together the two tunings would be decoration.
    const fast = fly('fast', AI_RACER_TUNINGS.fast as never, 400)
    const steady = fly('steady', AI_RACER_TUNINGS.steady as never, 400)
    expect(fast.finished).toBe(true)
    expect(steady.finished).toBe(true)
    expect(fast.finishedAt).toBeLessThan(steady.finishedAt)
  })
})

// ── After the finish line ──────────────────────────────────────────────────
//
// Matt: *"fix the ai racers crashing out"*. They were not crashing during the
// race — both get round — they were crashing AFTER it. The finished branch of
// `stepAiRacer` wrote two of `HoverJetInput`'s six fields and called it
// "holding the last input"; `_input` is a module-level scratch shared by every
// racer, so a finished racer flew on with the bank and pitch of whichever racer
// stepped after it, frozen. Measured: a held turn and a 359 m phugoid, and
// eventually the corner of the world and the sea floor. DEV-032.

/** Fly to the finish, then keep stepping for `seconds` more. */
const flyOn = (
  id: string,
  tuning: (typeof AI_RACER_TUNINGS)[string],
  seconds: number,
  /** Stepped once per tick alongside it, to expose shared-scratch cross-talk. */
  other: ReturnType<typeof createAiRacer> | null = null,
) => {
  const racer = createAiRacer(spec(id, tuning), gates)
  const RACE_CAP = Math.round(200 / FIXED_DT)
  for (let i = 0; i < RACE_CAP && !racer.finished; i++) stepAiRacer(racer, gates, [], FIXED_DT)
  // The altitude it CROSSED the line at, recovered from the setpoint rather
  // than sampled — `holdAltitude` is latched once on the finishing tick and
  // `FLY_OUT_CLIMB` is the only thing added to it.
  const finishedAtY = racer.holdAltitude - FLY_OUT_CLIMB * tuning.minClearance
  const track: number[] = []
  for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) {
    stepAiRacer(racer, gates, [], FIXED_DT)
    if (other) stepAiRacer(other, gates, [], FIXED_DT)
    track.push(racer.jet.body.position.y)
  }
  return { racer, track, finishedAtY }
}

describe('a racer that has finished', () => {
  it('gets round at all, so the rest of this block is about the right thing', () => {
    // Guards the premise. If a tuning change ever stops a racer finishing these
    // tests would pass vacuously, asserting things about a racer mid-race.
    for (const id of ['fast', 'steady'] as const) {
      const { racer } = flyOn(id, AI_RACER_TUNINGS[id] as never, 1)
      expect(racer.finished, id).toBe(true)
      expect(racer.finishedAt, id).toBeGreaterThan(0)
    }
  })

  it('HOLDS ITS SETPOINT instead of porpoising into the sea', () => {
    // The claim is regulated flight, not a particular altitude: it was told to
    // aim at a fixed height and over two minutes it should be sitting on it.
    // The bug swung 359 m peak-to-peak and kept going down.
    for (const id of ['fast', 'steady'] as const) {
      const { racer, track } = flyOn(id, AI_RACER_TUNINGS[id] as never, 120)
      // ── and it settles at its SETPOINT ─────────────────────────────────
      //
      // Not merely at some altitude. The first version of this fix aimed at
      // the racer's LIVE `position.y`, which is a reference that tracks the
      // state and therefore corrects nothing — the racer settles wherever the
      // local dynamics leave it, and where that is depends on entry
      // conditions. Measured both ways: headless it sank 40 m below the
      // finish and held there; in the running game the same build CLIMBED at
      // 1.3 m/s for as long as it was watched.
      expect(Math.abs((track.at(-1) as number) - racer.holdAltitude), `${id} settles`).toBeLessThan(
        15,
      )
      // Settled, and settled STILL: over the last half-minute the whole band
      // is a couple of metres. That is the porpoise assertion, made where the
      // transient is over rather than across it.
      const tail = track.slice(-Math.round(30 / FIXED_DT))
      expect(Math.max(...tail) - Math.min(...tail), `${id} tail band`).toBeLessThan(5)
      // It never OVERSHOOTS the setpoint on the way up, which is the failure a
      // step change in a reference usually buys you.
      expect(Math.max(...track), `${id} overshoot`).toBeLessThan(racer.holdAltitude + 5)
      // And the floor, said separately: sea level is y = 0, and the climb is
      // upward from a height the course was flown at, so a racer that ends up
      // anywhere near the water has lost its reference again.
      expect(Math.min(...track), `${id} floor`).toBeGreaterThan(0)
      expect(racer.jet.body.position.y, `${id} end`).toBeGreaterThan(0)
    }
  })

  it('CLIMBS AWAY, by exactly one ground clearance', () => {
    // Matt's item: *"after two minutes it is 4-5 km out over open sea"* — level,
    // at the height the finish gate happens to sit at, which reads as a jet that
    // forgot to land rather than one that won something.
    //
    // The fix is four lines and a named constant, not a despawn system. The
    // assertion is the GEOMETRY of it: the racer ends one `minClearance` above
    // where it crossed the line, which is the altitude the controller itself
    // calls clear ground. A quaternion or a flag would be the belief written
    // twice; a height difference is true whatever anybody believed.
    for (const id of ['fast', 'steady'] as const) {
      const tuning = AI_RACER_TUNINGS[id] as never as { minClearance: number }
      const { racer, track, finishedAtY } = flyOn(id, AI_RACER_TUNINGS[id] as never, 120)
      const climb = FLY_OUT_CLIMB * tuning.minClearance
      expect(climb, 'the switch is set').toBeGreaterThan(0)
      expect(racer.holdAltitude - finishedAtY, `${id} setpoint`).toBeCloseTo(climb, 6)
      // And it actually gets there, rather than merely being told to.
      expect((track.at(-1) as number) - finishedAtY, `${id} climbed`).toBeGreaterThan(climb - 15)
    }
  })

  it('KEEPS FLYING, which is the half that was right all along', () => {
    // Freezing a jet mid-air in front of you looks like a bug, so the fix must
    // not be "stop". It cruises.
    const { racer } = flyOn('fast', AI_RACER_TUNINGS.fast as never, 60)
    const speed = Math.hypot(
      racer.jet.body.velocity.x,
      racer.jet.body.velocity.y,
      racer.jet.body.velocity.z,
    )
    expect(speed).toBeGreaterThan(10)
  })

  it('flies the same line whether or not another racer is stepped beside it', () => {
    // THE regression. `_input` is shared, `autopilotActions` writes all six of
    // its fields, and `racers.ts` steps the racers in a loop — so a finished
    // racer whose branch wrote only two of them inherited the other racer's
    // stick. Stepping a second racer must change nothing about the first.
    const alone = flyOn('fast', AI_RACER_TUNINGS.fast as never, 60).racer
    const beside = flyOn(
      'fast',
      AI_RACER_TUNINGS.fast as never,
      60,
      // Mid-course and cornering hard, which is when it commands real roll.
      createAiRacer(spec('steady', AI_RACER_TUNINGS.steady as never), gates),
    ).racer
    expect(beside.jet.body.position.x).toBeCloseTo(alone.jet.body.position.x, 3)
    expect(beside.jet.body.position.y).toBeCloseTo(alone.jet.body.position.y, 3)
    expect(beside.jet.body.position.z).toBeCloseTo(alone.jet.body.position.z, 3)
    // The setpoint too. `holdAltitude` is latched once and never rewritten, so
    // a second racer must not be able to move it — and it is now the thing the
    // whole fly-out is regulated against, so a leak here would be a leak into
    // every subsequent second of flight rather than one tick of stick.
    expect(beside.holdAltitude).toBeCloseTo(alone.holdAltitude, 6)
  })
})

// ── Five on the grid (DEV-125) ─────────────────────────────────────────────
//
// Matt: *"add 3 more racers to the hover jet."* The three new tunings have to
// earn their place the same way the first two did: every one gets round, no
// two fly the same line, and the field spreads out rather than finishing as a
// bunch. And trap 19 has to be re-proved at five, not assumed from two — the
// shared `_input` scratch is written by whichever racer stepped LAST, so the
// racer most exposed is the one stepped first in a loop of five.

const FIVE = Object.keys(AI_RACER_TUNINGS)

describe('five racers', () => {
  it('are five, and the sheet order is the grid order', () => {
    expect(FIVE).toEqual(['fast', 'steady', 'cutter', 'wide', 'cruiser'])
  })

  it('every one of them gets round the real course', () => {
    const times: Record<string, number> = {}
    for (const id of FIVE) {
      const racer = fly(id, AI_RACER_TUNINGS[id] as never, 300)
      expect(racer.finished, `${id} finished`).toBe(true)
      expect(racer.gates, `${id} took every gate`).toBe(gates.length)
      times[id] = racer.finishedAt
    }
    // The table the header of `ai-racer.ts` refers to.
    console.info(
      'int_01, no terrain: ' +
        FIVE.map((id) => `${id} ${(times[id] as number).toFixed(1)} s`).join(' · '),
    )
  })

  it('finish SPREAD OUT — no two within four seconds, over a minute across the field', () => {
    // Five controllers that finish within a few seconds of each other are one
    // racer drawn five times. The spread is the property; the order is not
    // asserted, because a tuning change that swaps two places is not a bug.
    const times = FIVE.map((id) => fly(id, AI_RACER_TUNINGS[id] as never, 300).finishedAt).sort(
      (a, b) => a - b,
    )
    for (let i = 1; i < times.length; i++) {
      expect((times[i] as number) - (times[i - 1] as number), `gap ${i}`).toBeGreaterThan(4)
    }
    expect((times[4] as number) - (times[0] as number)).toBeGreaterThan(30)
  })

  it('fly five DIFFERENT lines: every pair is apart at some point in the first 30 s', () => {
    const racers = FIVE.map((id) => createAiRacer(spec(id, AI_RACER_TUNINGS[id] as never), gates))
    const worst = new Map<string, number>()
    for (let i = 0; i < Math.round(30 / FIXED_DT); i++) {
      for (const r of racers) stepAiRacer(r, gates, [], FIXED_DT)
      for (let a = 0; a < racers.length; a++) {
        for (let b = a + 1; b < racers.length; b++) {
          const pa = (racers[a] as (typeof racers)[number]).jet.body.position
          const pb = (racers[b] as (typeof racers)[number]).jet.body.position
          const key = `${FIVE[a]}/${FIVE[b]}`
          worst.set(
            key,
            Math.max(worst.get(key) ?? 0, Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z)),
          )
        }
      }
    }
    for (const [pair, apart] of worst) {
      expect(apart, `${pair} ${apart.toFixed(0)} m apart at their furthest`).toBeGreaterThan(10)
    }
  })

  it('each flies the SAME line alone as it does with the other four stepped beside it', () => {
    // Trap 19 at five. `_input` is one module-level scratch; five racers in a
    // loop write it five times a tick. For each of the five, fly it alone and
    // fly it FIRST in a loop with the other four, and the two runs must agree
    // to the float — including after it has finished and the other four are
    // still writing bank and pitch into the scratch it once inherited from.
    for (const id of FIVE) {
      const alone = fly(id, AI_RACER_TUNINGS[id] as never, 90)
      const first = createAiRacer(spec(id, AI_RACER_TUNINGS[id] as never), gates)
      const others = FIVE.filter((o) => o !== id).map((o) =>
        createAiRacer(spec(o, AI_RACER_TUNINGS[o] as never), gates),
      )
      const steps = Math.round(90 / FIXED_DT)
      for (let i = 0; i < steps; i++) {
        // `fly` stops stepping its racer once it has finished; mirror that so
        // the two runs have the same number of ticks, and keep the other four
        // going regardless — they are the ones writing the scratch.
        if (!first.finished) stepAiRacer(first, gates, [], FIXED_DT)
        for (const o of others) stepAiRacer(o, gates, [], FIXED_DT)
      }
      expect(first.jet.body.position.x, `${id} x`).toBe(alone.jet.body.position.x)
      expect(first.jet.body.position.y, `${id} y`).toBe(alone.jet.body.position.y)
      expect(first.jet.body.position.z, `${id} z`).toBe(alone.jet.body.position.z)
      expect(first.gates, `${id} gates`).toBe(alone.gates)
      expect(first.finishedAt, `${id} finishedAt`).toBe(alone.finishedAt)
    }
  })

  it('a FINISHED racer keeps its own heading while four others corner around it', () => {
    // The DEV-032 shape, at five: the finished branch must write every field of
    // the scratch itself. Fly `fast` to the line, then 60 s more beside the
    // other four mid-course, and compare with the same 60 s alone.
    const alone = flyOn('fast', AI_RACER_TUNINGS.fast as never, 60).racer
    const pack = FIVE.filter((o) => o !== 'fast').map((o) =>
      createAiRacer(spec(o, AI_RACER_TUNINGS[o] as never), gates),
    )
    const racer = createAiRacer(spec('fast', AI_RACER_TUNINGS.fast as never), gates)
    const RACE_CAP = Math.round(200 / FIXED_DT)
    for (let i = 0; i < RACE_CAP && !racer.finished; i++) stepAiRacer(racer, gates, [], FIXED_DT)
    for (let i = 0; i < Math.round(60 / FIXED_DT); i++) {
      stepAiRacer(racer, gates, [], FIXED_DT)
      for (const o of pack) stepAiRacer(o, gates, [], FIXED_DT)
    }
    expect(racer.jet.body.position.x).toBeCloseTo(alone.jet.body.position.x, 3)
    expect(racer.jet.body.position.y).toBeCloseTo(alone.jet.body.position.y, 3)
    expect(racer.jet.body.position.z).toBeCloseTo(alone.jet.body.position.z, 3)
    expect(racer.holdAltitude).toBeCloseTo(alone.holdAltitude, 6)
  })
})
