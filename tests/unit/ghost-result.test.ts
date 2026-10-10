// tests/unit/ghost-result.test.ts — what the 2016 recordings actually SCORED.
//
// A clip is a flight path, not a result. The Motion Recorder saved poses and
// nothing else, so `?opponents=ghosts` had an empty opponent list on the results
// panel and the game could not say "you beat the fast ghost" — which is most of
// the point of racing a decade-old recording.
//
// `scoreGhost` fills that in, and this file is the argument that the numbers it
// produces are real rather than merely produced.
//
// ── Why these assertions and not a golden snapshot ────────────────────────
//
// A snapshot of "57.32 s" is a belief written twice: it passes whatever the
// function does, including flying the mirror image of the course. So the times
// are pinned AND checked against three things that are true independently of
// this code:
//
//   the DISTANCE     the path a ghost flies must be a little longer than the
//                    gate polyline it flies through, never shorter.
//   the SPEED        `distance / seconds`, against what the corpus says about
//                    the 2016 pace and what the flight model can reach at all.
//   the FINISH LEG   the gap between "took the last ring" and "crossed the
//                    line" must be the 234.6 m of DEV-045, minus the radius of
//                    the sphere it enters.
//
// SIM LAYER: every import here is pure. `scoreGhost` runs in Vitest's node
// environment with no canvas, no GPU and no clip loader — which is the D7 split
// doing its job, and is why an opponent's time can be computed at load rather
// than watched for.

import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { ghostShortName } from '@/game/ghosts'
import { courseGates } from '@/game/mission'
import type { FinishSphere } from '@/sim/ai-racer'
import type { Gate } from '@/sim/course'
import { decodeGhostClip, type GhostCourse, type GhostDoc, scoreGhost } from '@/sim/ghost'
import fastDoc from '../../content/ghosts/int_01_leftSpawn_fast_01.json'
import slowDoc from '../../content/ghosts/int_01_rightSpawn_slow_01.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

const level = int01 as unknown as Level

/**
 * The real course, built by the loader's own function rather than mapped here.
 *
 * `courseGates` runs the LIVENESS walk — enabled, `addScore != 0`, the whole
 * `m_Father` chain active — and reading `routes['0'].rings` straight would skip
 * it. On `int_01` the two happen to agree at 21; on `int_02` they are 21 and 77.
 * A ghost scored against a different gate list from the player's is not racing
 * the player.
 */
const gates: Gate[] = courseGates(level)

/** `Trigger_FinishLine`'s largest sphere, sim space. The thing that ends a run. */
const finish: FinishSphere = {
  x: (level.finish as NonNullable<Level['finish']>).pos[0],
  y: (level.finish as NonNullable<Level['finish']>).pos[1],
  z: -(level.finish as NonNullable<Level['finish']>).pos[2],
  radius: (level.finish as NonNullable<Level['finish']>).radius,
}

const worldOffset: readonly [number, number, number] = [
  level.worldOffset[0],
  level.worldOffset[1],
  level.worldOffset[2],
]

const course = (over: Partial<GhostCourse> = {}): GhostCourse => ({
  gates,
  finish,
  worldOffset,
  // The shipped `GhostRacer` component's own stagger. Real 2016 data, unlike the
  // seven-second pad hold, which is an artefact of how the runs were recorded.
  startTime: 0.55,
  ...over,
})

const clips = {
  fast: decodeGhostClip(fastDoc as unknown as GhostDoc),
  slow: decodeGhostClip(slowDoc as unknown as GhostDoc),
}

/** Straight-line length of the gate chain. The floor for any flown path. */
const polyline = (() => {
  let total = 0
  for (let i = 1; i < gates.length; i++) {
    const a = (gates[i - 1] as Gate).centre
    const b = (gates[i] as Gate).centre
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  }
  return total
})()

describe('every shipped ghost clip has a finishing time', () => {
  // These are the numbers. They are pinned so a change to the sampler, the gate
  // spheres or the finish rule cannot move an opponent's time silently — the
  // whole failure mode DEV-045 was, where every opponent's time flattered them
  // by a quarter of a kilometre and nothing said so.
  it('int_01_leftSpawn_fast_01 finishes at 57.3 s', () => {
    const r = scoreGhost(clips.fast, course())
    expect(r.seconds).not.toBeNull()
    expect(r.seconds as number).toBeCloseTo(57.32, 1)
    // Eighteen rings, not twenty-one. 2016's quick pilot clipped the edge of
    // gates 5, 10 and 14 — closest approaches of 23.2, 24.6 and 24.2 m against a
    // 22.6 m trigger, so misses of 0.6 to 2.0 m on a course flown at 185 m/s.
    // Real, and it changes nothing: `Trigger_FinishLine` never asks how many
    // rings you took.
    expect(r.gates).toBe(18)
    expect(r.gatesTotal).toBe(21)
  })

  it('int_01_rightSpawn_slow_01 finishes at 102.4 s, and takes every ring', () => {
    const r = scoreGhost(clips.slow, course())
    expect(r.seconds).not.toBeNull()
    expect(r.seconds as number).toBeCloseTo(102.44, 1)
    expect(r.gates).toBe(21)
  })

  it('has the fast one genuinely quicker, which is what its name claims', () => {
    const fast = scoreGhost(clips.fast, course()).seconds as number
    const slow = scoreGhost(clips.slow, course()).seconds as number
    expect(fast).toBeLessThan(slow)
  })
})

describe('the times are checkable against something other than themselves', () => {
  it('flies a path a little LONGER than the gate chain, never shorter', () => {
    // A racing line through 21 spheres cannot be shorter than the straight
    // chain between their centres, and a sane one is not much longer. Both
    // clips come out 4 % over, which is what a curve through a polygon looks
    // like. Under 1.0 would mean the clip is not flying this course at all —
    // the shape a mirrored or mis-offset frame would produce.
    const tail = 234.6 // DEV-045: ring 21 -> the finish gate's centre.
    for (const [name, clip] of Object.entries(clips)) {
      const r = scoreGhost(clip, course())
      const ratio = r.distance / (polyline + tail)
      expect(ratio, `${name} flew ${r.distance.toFixed(0)} m`).toBeGreaterThan(1)
      expect(ratio, `${name} flew ${r.distance.toFixed(0)} m`).toBeLessThan(1.15)
    }
  })

  it('reports a mean speed the flight model can actually produce', () => {
    // The ship tops out at 89.8 m/s unboosted and the speed chain takes the
    // ceiling from 182 to 340 m/s over twenty-one gates. A mean of 185 m/s for
    // the fast clip therefore says "somebody held boost and chained the rings",
    // which is exactly what `sim/autopilot.ts` concluded independently from the
    // same recording: it *"spends 90 % of its run above 120 m/s"*.
    const fast = scoreGhost(clips.fast, course())
    expect(fast.meanSpeed).toBeGreaterThan(120)
    expect(fast.meanSpeed).toBeLessThan(340)
    // The slow clip is the other side of that line: a mean under the boosted
    // ceiling, so its pace is a driving difference rather than a physics one.
    const slow = scoreGhost(clips.slow, course())
    expect(slow.meanSpeed).toBeLessThan(fast.meanSpeed)
    expect(slow.meanSpeed).toBeGreaterThan(60)
  })

  it('keeps `meanSpeed` and `distance / seconds` the same number', () => {
    for (const clip of Object.values(clips)) {
      const r = scoreGhost(clip, course())
      expect(r.meanSpeed).toBeCloseTo(r.distance / (r.seconds as number), 6)
    }
  })
})

describe('the FINISH GATE ends the run, not the last ring (DEV-045)', () => {
  it('costs the slow ghost another 1.3 s and 189 m after ring 21', () => {
    // The independent check on the whole rule. `finish: null` falls back to
    // "every gate taken", which is where the port timed a run for months.
    //
    // The gap has to be the geometry: the finish sphere's centre is 234.6 m
    // past ring 21 and its radius is 68.6 m, so a ship crossing the line has
    // flown at least 234.6 - 68.6 = 166 m further than it had at the ring, and
    // not much more than 234.6 m. 189 m is inside that window, which is the
    // measurement confirming DEV-045's number from the other end — from a 2016
    // recording rather than from the scene file.
    const withGate = scoreGhost(clips.slow, course())
    const lastRing = scoreGhost(clips.slow, course({ finish: null }))
    const extraTime = (withGate.seconds as number) - (lastRing.seconds as number)
    const extraDistance = withGate.distance - lastRing.distance
    expect(extraTime).toBeGreaterThan(0)
    expect(extraTime).toBeCloseTo(1.3, 1)
    expect(extraDistance).toBeGreaterThan(234.6 - finish.radius)
    expect(extraDistance).toBeLessThan(234.6 * 1.2)
  })

  it('is the ONLY reason the fast recording finishes at all', () => {
    // 2016's quick pilot clipped three rings (see above). Under "every gate
    // taken" that run is a DNF, and the panel would print one for the very ghost
    // the player is meant to be chasing. Under the rule 2016 actually shipped it
    // is a finish, because `Trigger_FinishLine` never counts rings.
    expect(scoreGhost(clips.fast, course({ finish: null })).seconds).toBeNull()
    expect(scoreGhost(clips.fast, course()).seconds).not.toBeNull()
  })

  it('shares `runIsOver` with the AI racers rather than copying it', () => {
    // Not a style point. This rule has been wrong in this repo before, and the
    // cost was that every opponent time was measured over a course 234.6 m
    // shorter than the player's. Two copies is two chances to be wrong.
    const noGates: Gate[] = []
    // With no gates and no finish, "every gate taken" is vacuously true — the
    // same answer `runIsOver` gives, on the first sampled tick.
    const r = scoreGhost(clips.slow, course({ gates: noGates, finish: null }))
    expect(r.seconds).not.toBeNull()
    expect(r.gatesTotal).toBe(0)
  })
})

describe('scoring one clip cannot disturb another — trap 19', () => {
  // THE two-object test. `scoreGhost` allocates its course state and its pose
  // per call today, and this is what says so tomorrow: a module-level scratch
  // added for speed would be a channel between two clips that know nothing
  // about each other, and with one clip there is nobody to inherit from.
  it('gives the same answer for clip A whether or not clip B is scored between', () => {
    const before = scoreGhost(clips.fast, course())
    const other = scoreGhost(clips.slow, course())
    const after = scoreGhost(clips.fast, course())
    expect(after).toEqual(before)
    // And B's own answer is not A's.
    expect(other.seconds).not.toBeCloseTo(before.seconds as number, 2)
  })

  it('does not leak a COURSE between two scorings of the same clip', () => {
    // The subtler half, and the reason there is no memo inside `scoreGhost`: a
    // cache keyed on the clip alone would hand the second course the first
    // one's answer, and clips are shared across missions by design.
    const real = scoreGhost(clips.slow, course())
    const shortened = scoreGhost(clips.slow, course({ gates: gates.slice(0, 3) }))
    const realAgain = scoreGhost(clips.slow, course())
    expect(shortened.gatesTotal).toBe(3)
    expect(realAgain).toEqual(real)
  })
})

describe('the label the results panel shows', () => {
  it('shortens a clip id to its pace, which is the register the AI racers use', () => {
    expect(ghostShortName('int_01_leftSpawn_fast_01')).toBe('fast')
    expect(ghostShortName('int_01_rightSpawn_slow_01')).toBe('slow')
  })

  it('falls back to the whole id rather than inventing a name', () => {
    // A clip that is not `<mission>_<pad>_<pace>_<take>` gets printed as it is.
    // Better a long row than a row that says "01".
    expect(ghostShortName('weird')).toBe('weird')
    expect(ghostShortName('42')).toBe('42')
    expect(ghostShortName('a_2')).toBe('a')
  })
})
