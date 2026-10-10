// tests/unit/audio-lift.test.ts — DEV-424: the lift ride has a motor that
// follows the platform, and a clunk when it arrives.
//
// Matt, 2026-09-26: *"need sound fx for the elevator ride."* 2016's ride is a
// servo, a loop it shipped MUTED (AUD-1 plays it) and eight positional
// whooshes; nothing follows the platform. `src/audio/lift.ts` derives the
// platform's speed from `launch.rise` tick to tick and drives a motor voice off
// it. What is asserted, and why that and not something easier:
//
//  1. **On `int_01`'s real ride**, stepped through `sim/launch.ts` exactly as
//     `boot/app.ts` steps it — so "the motor starts as the platform moves and
//     stops as it arrives" is a claim about the level's own curve rather than a
//     fixture's. The curve's hold key (0.6 s) and its settle are both in the
//     level JSON, and both are exactly where a fixed envelope would be wrong.
//  2. **Exact arithmetic on a fixture**, whose numbers can be done by hand, so
//     the curve lookups are tested against what the CODE does (trap 24).
//  3. **The two failure shapes a derived speed invites**: a difference across a
//     reset (a retry puts the platform at the top in one assignment), and a
//     platform that stops and moves again (the arrival must fire once).
//  4. **Through `AudioSystem`**, into a recording backend, because the wiring —
//     which event resets, what `mission.end` stops — has no other coverage.

import { describe, expect, it } from 'vitest'
import { createAudioSystem } from '@/audio'
import { createRecordingBackend } from '@/audio/backend'
import type { CueAction } from '@/audio/engine'
import { createLiftAudio, resetLiftAudio, stepLiftAudio } from '@/audio/lift'
import { sampleCurve } from '@/audio/speed-curves'
import { type Edition, type EditionLiftSound, validateEdition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { launchSpecOf } from '@/game/course-specs'
import { WORLD } from '@/generated/constants.generated'
import {
  createLaunch,
  type LaunchSpec,
  launchHoldsShip,
  startLaunch,
  stepLaunch,
} from '@/sim/launch'
import int01 from '../../content/levels/int_01_hoverJet.json'
import { validEdition as preset, editionJson as read } from './helpers/content'

const DT = WORLD.fixedDeltaTime

/**
 * `int_01`'s ride, with the ride ON — built by the function the game builds it
 * with (`game/course-specs.ts`, APP-SPLIT 2.2) rather than a hand copy.
 */
const RIDE: LaunchSpec = launchSpecOf(int01 as unknown as Level, false) as LaunchSpec

/** One action, stamped with the ride time it was emitted at. */
interface Stamped {
  readonly t: number
  readonly action: CueAction
}

/**
 * Fly the whole hold — a second of waiting, the press, the ride, the countdown —
 * calling the lift step exactly where `boot/app.ts` does: once per fixed step,
 * while `launchHoldsShip`, after `stepLaunch`.
 */
const ride = (spec: EditionLiftSound | null): Stamped[] => {
  const launch = createLaunch(RIDE)
  const state = createLiftAudio()
  const out: Stamped[] = []
  const buffer: CueAction[] = []
  const tick = (t: number): void => {
    buffer.length = 0
    stepLiftAudio(state, launch.rise, spec, buffer)
    for (const action of buffer) out.push({ t, action })
  }
  // Waiting on the pad for a second: a still platform makes no sound.
  for (let i = 0; i < Math.round(1 / DT); i++) tick(-1)
  startLaunch(launch, RIDE)
  let guard = 0
  while (launchHoldsShip(launch) && guard++ < 10_000) {
    stepLaunch(launch, RIDE, DT)
    tick(launch.elapsed)
  }
  return out
}

const of = (stamped: readonly Stamped[], kind: CueAction['kind'], cue: string): Stamped[] =>
  stamped.filter((s) => s.action.kind === kind && s.action.cue === cue)

// ─────────────────────────────────────────────────────────────────────────

describe('DEV-424: the motor follows int_01’s real ride', () => {
  const lift = preset('anniversary').audio.lift
  const heard = ride(lift)

  it('starts once, as the platform leaves the curve’s hold — not at the press', () => {
    const plays = of(heard, 'play', 'elevator.motor')
    expect(plays).toHaveLength(1)
    const t = plays[0]?.t ?? Number.NaN
    // The level's own hold key: the curve is flat until 0.6 s.
    const hold = int01.spawn.launch.keys[1]?.time ?? Number.NaN
    expect(t).toBeGreaterThan(hold)
    expect(t).toBeLessThan(hold + 1)
    // Nothing at all while waiting on the pad.
    expect(heard.filter((s) => s.t < 0)).toEqual([])
  })

  it('stops once, with ONE arrival, as the platform comes to rest — before the countdown', () => {
    const stops = of(heard, 'stop', 'elevator.motor')
    const arrivals = of(heard, 'play', 'elevator.arrive')
    expect(stops).toHaveLength(1)
    expect(arrivals).toHaveLength(1)
    expect(arrivals[0]?.t).toBe(stops[0]?.t)
    // At rest before the curve's settle key and well before the release: the
    // arrival belongs to the platform stopping, not to the countdown starting.
    const settled = int01.spawn.launch.settledAtSeconds
    expect(arrivals[0]?.t ?? Number.NaN).toBeGreaterThan(settled - 1.5)
    expect(arrivals[0]?.t ?? Number.NaN).toBeLessThan(settled)
    expect(arrivals[0]?.t ?? Number.NaN).toBeLessThan(RIDE.releaseAtSeconds)
    // And nothing after it, through the settle backwards and the countdown.
    const after = heard.filter((s) => s.t > (arrivals[0]?.t ?? 0))
    expect(after).toEqual([])
  })

  it('climbs in pitch and level as the platform speeds up, and peaks near its top speed', () => {
    const mods = of(heard, 'modulate', 'elevator.motor').map((s) => ({
      t: s.t,
      rate: s.action.kind === 'modulate' ? (s.action.rate ?? Number.NaN) : Number.NaN,
      gain: s.action.kind === 'modulate' ? (s.action.gain ?? Number.NaN) : Number.NaN,
    }))
    expect(mods.length).toBeGreaterThan(100)
    const first = mods[0]
    const peak = mods.reduce((a, b) => (b.rate > a.rate ? b : a))
    expect(first?.gain).toBeLessThan(0.3)
    expect(peak.rate).toBeGreaterThan((first?.rate ?? 0) * 1.5)
    // int_01's platform is fastest between 11 and 12 s (16.6 m/s at 11.6).
    expect(peak.t).toBeGreaterThan(11)
    expect(peak.t).toBeLessThan(12.2)
    // The spin-up is a climb, not a jump: across the first ten seconds of the
    // ride the rate never falls.
    const climb = mods.filter((m) => m.t < 10)
    for (let i = 1; i < climb.length; i++) {
      expect(climb[i]?.rate, `t=${climb[i]?.t}`).toBeGreaterThanOrEqual(climb[i - 1]?.rate ?? 0)
    }
  })

  it('says nothing on Classic, the whole ride through', () => {
    expect(ride(null)).toEqual([])
    // And Classic's block is off, with no-op numbers if flipped by hand.
    const classic = preset('classic').audio.lift
    expect(classic.enabled).toBe(false)
    expect(classic.arriveGain).toBe(0)
    for (const [, g] of classic.gainBySpeed) expect(g).toBe(0)
  })
})

describe('DEV-424: the arithmetic, on numbers a person can check', () => {
  /** Rate 1 at rest, 2 at 10 m/s; gain 0 at rest, 1 at 10. Stopped under 0.5. */
  const SPEC: EditionLiftSound = {
    enabled: true,
    rateBySpeed: [
      [0, 1],
      [10, 2],
    ],
    gainBySpeed: [
      [0, 0],
      [10, 1],
    ],
    stoppedBelow: 0.5,
    arriveGain: 0.7,
  }

  it('derives the speed as the rise per fixed step, and reads both curves at it', () => {
    const state = createLiftAudio()
    const out: CueAction[] = []
    stepLiftAudio(state, 0, SPEC, out) // seeds
    expect(out).toEqual([])
    stepLiftAudio(state, 5 * DT, SPEC, out) // 5 m/s
    expect(state.speed).toBeCloseTo(5, 9)
    expect(out[0]).toEqual({ kind: 'play', cue: 'elevator.motor' })
    const m = out[1]
    expect(m?.kind).toBe('modulate')
    if (m?.kind === 'modulate') {
      expect(m.rate).toBeCloseTo(1.5, 9)
      expect(m.gain).toBeCloseTo(0.5, 9)
    }
    expect(sampleCurve(SPEC.rateBySpeed, 5)).toBeCloseTo(1.5, 9)
  })

  it('plays the arrival at the preset’s gain', () => {
    const state = createLiftAudio()
    const out: CueAction[] = []
    for (const rise of [0, 5 * DT, 5 * DT]) stepLiftAudio(state, rise, SPEC, out)
    expect(out.at(-1)).toEqual({ kind: 'play', cue: 'elevator.arrive', gain: 0.7 })
  })

  it('seeds after a reset instead of differencing across it — a retry is not a 9,000 m/s motor', () => {
    const state = createLiftAudio()
    const out: CueAction[] = []
    stepLiftAudio(state, 0, SPEC, out)
    // The retry: `resetLaunch` stands the platform at the top in one assignment.
    resetLiftAudio(state)
    stepLiftAudio(state, 106.6, SPEC, out)
    stepLiftAudio(state, 106.6, SPEC, out)
    expect(out).toEqual([])
  })

  it('arrives ONCE: a platform that stops and moves again does not restart the motor', () => {
    const state = createLiftAudio()
    const out: CueAction[] = []
    const rises = [0, 5 * DT, 5 * DT, 10 * DT, 15 * DT, 15 * DT]
    for (const rise of rises) stepLiftAudio(state, rise, SPEC, out)
    expect(out.filter((a) => a.kind === 'play' && a.cue === 'elevator.arrive')).toHaveLength(1)
    expect(out.filter((a) => a.kind === 'play' && a.cue === 'elevator.motor')).toHaveLength(1)
  })

  it('refuses a stoppedBelow of zero — a lift that can never be at rest', () => {
    const e = read('anniversary')
    const broken = {
      ...e,
      audio: { ...e.audio, lift: { ...e.audio.lift, stoppedBelow: 0 } },
    } as unknown as Edition
    expect(() => validateEdition(broken)).toThrow(/audio\.lift\.stoppedBelow/)
  })
})

describe('DEV-424: through the audio system, into a backend', () => {
  const lift = preset('anniversary').audio.lift

  const build = () => {
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend, random: () => 0 })
    system.setLiftSound(lift)
    return { backend, system }
  }

  /** Step the system through `int_01`'s ride until `until` seconds in. */
  const rideTo = (system: ReturnType<typeof build>['system'], until: number): void => {
    const launch = createLaunch(RIDE)
    system.stepLift({ rise: launch.rise })
    startLaunch(launch, RIDE)
    system.event({ type: 'launch.start' })
    while (launchHoldsShip(launch) && launch.elapsed < until) {
      stepLaunch(launch, RIDE, DT)
      system.stepLift({ rise: launch.rise })
    }
  }

  it('has the motor SOUNDING mid-ride, beside AUD-1’s loop, and gone after the arrival', () => {
    const { backend, system } = build()
    rideTo(system, 8)
    expect(backend.sounding).toContain('elevator.motor')
    expect(backend.sounding).toContain('elevator.loop')
    expect(system.lift.motor).toBe(true)
    expect(system.lift.speed).toBeGreaterThan(5)
    rideTo(system, 20)
    expect(backend.sounding).not.toContain('elevator.motor')
    expect(system.lift.arrived).toBe(true)
    expect(backend.calls.some((c) => c.call === 'play' && c.id === 'elevator.arrive')).toBe(true)
  })

  it('stops a running motor on `mission.end` — a restart mid-ride leaves no motor behind', () => {
    const { backend, system } = build()
    rideTo(system, 6)
    expect(backend.sounding).toContain('elevator.motor')
    system.event({ type: 'mission.end' })
    expect(backend.sounding).not.toContain('elevator.motor')
    expect(system.lift.motor).toBe(false)
  })

  it('is silent with the preset off, and reports it', () => {
    const { backend, system } = build()
    system.setLiftSound(null)
    rideTo(system, 20)
    expect(backend.sounding).not.toContain('elevator.motor')
    expect(backend.calls.some((c) => c.call === 'play' && c.id === 'elevator.arrive')).toBe(false)
    expect(system.lift.enabled).toBe(false)
  })
})
