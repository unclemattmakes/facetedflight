// tests/unit/audio-pitch-with-speed.test.ts — DEV-425: the engine and the wind
// rise in PITCH as you go faster, by enough to hear.
//
// Matt, 2026-09-26: *"would love if engine noise and wind sounds
// changed/pitch-shifted as i moved faster."* Half of that had shipped ten days
// earlier: DEV-137 put a speed-keyed rate on every engine voice, about four
// semitones from a standstill to 350 m/s and under two across the speed chain's
// band. He asked for it again, which is the one measurement of that range there
// is — it was below notice. The wind had gain and a cutoff on the air (S4,
// DEV-084) and no pitch at all.
//
// So this file pins three things, and says which half of the fix each covers:
//
//  1. **The wind carries a rate.** `windModulation` reads `windRate`, and both
//     wind `modulate` actions carry it — asserted against the hand-computable
//     fixture in `helpers/speed-curves.ts`, never against the shipped table.
//  2. **The shipped curves clear a floor**, derived from that measurement: the
//     engine rises at least SIX semitones from the standstill at GO to the
//     chain's ceiling (DEV-137's curve managed 4.2), and the wind at least FOUR
//     across the chain's own band. Floors, not values, so tuning above them is
//     free and tuning below them says, in red, that it is back where DEV-137
//     was.
//  3. **Classic is untouched**: its `windRate` is flat 1, so a hand flip of its
//     `enabled` cannot move the mix, which is the no-op rule every Classic
//     curve follows.
//
// The chain's band is DERIVED from the sheet (CLAUDE.md, DEV-027: say what the
// number is OF). `terminalSpeed` over the shipped prefab's `maxSpeed`, and over
// that plus `speedIncreaseAmt` for every ring on `int_01` — 182 -> 340 m/s, the
// figures `sim/speed-chain.ts` quotes in prose.

import { describe, expect, it } from 'vitest'
import {
  type CueAction,
  createEngineAudio,
  type EngineAudioInput,
  engineAudioWithCurves,
  stepEngineAudio,
} from '@/audio/engine'
import { sampleCurve, speedRate, windModulation } from '@/audio/speed-curves'
import { type Edition, validateEdition } from '@/content/edition-schema'
import { HOVERJET } from '@/generated/constants.generated'
import { terminalSpeed } from '@/sim/speed-chain'
import int01 from '../../content/levels/int_01_hoverJet.json'
import { validEdition as preset, editionJson as read } from './helpers/content'
import { FIXTURE_CURVES } from './helpers/speed-curves'

/** A frequency ratio in semitones. 12 is an octave. */
const semitones = (ratio: number): number => 12 * Math.log2(ratio)

const terminal = (maxSpeed: number): number =>
  terminalSpeed(
    maxSpeed,
    HOVERJET.ship.boostMultiplier,
    HOVERJET.rigidbody.mass,
    HOVERJET.rigidbody.drag,
  )
const RINGS = int01.routes[0]?.rings.length ?? 0
/** Boosted terminal with no chain: where a race's fast part starts. */
const CHAIN_FLOOR = terminal(HOVERJET.ship.maxSpeed)
/** Boosted terminal with every ring of `int_01` chained. */
const CHAIN_CEILING = terminal(
  HOVERJET.ship.maxSpeed + HOVERJET.speedChain.speedIncreaseAmt * RINGS,
)

const fly = (over: Partial<EngineAudioInput>): EngineAudioInput => ({
  speed: 0,
  throttle: 1,
  boost: false,
  released: true,
  ...over,
})

const windRates = (actions: readonly CueAction[]): Record<string, number | undefined> => {
  const out: Record<string, number | undefined> = {}
  for (const a of actions) {
    if (a.kind === 'modulate' && (a.cue === 'wind.aircraft' || a.cue === 'wind.flight')) {
      out[a.cue] = a.rate
    }
  }
  return out
}

describe('the band the floors are measured over is the chain’s, off the sheet', () => {
  it('is 182 -> 340 m/s, as `sim/speed-chain.ts` says in prose', () => {
    // A derived number with a stated referent (DEV-027). If either end moves,
    // every floor below is being measured over a different race.
    expect(RINGS).toBe(21)
    expect(CHAIN_FLOOR).toBeGreaterThan(180)
    expect(CHAIN_FLOOR).toBeLessThan(185)
    expect(CHAIN_CEILING).toBeGreaterThan(335)
    expect(CHAIN_CEILING).toBeLessThan(345)
  })
})

describe('DEV-425: the wind carries a rate, keyed on the air', () => {
  it('reads `windRate` off the curves: 1.3 at 30 m/s and 2.8 at 180 on the fixture', () => {
    expect(windModulation(FIXTURE_CURVES, 30).rate).toBeCloseTo(1.3, 9)
    expect(windModulation(FIXTURE_CURVES, 180).rate).toBeCloseTo(2.8, 9)
  })

  it('puts it on BOTH wind loops, every tick, alongside the gain and the cutoff', () => {
    const spec = engineAudioWithCurves(FIXTURE_CURVES)
    const state = createEngineAudio()
    // 30 m/s: past the 25 m/s gate and its hysteresis, so `AircraftWind` is up.
    const slow = windRates(stepEngineAudio(state, fly({ speed: 30 }), spec, []))
    expect(slow['wind.aircraft']).toBeCloseTo(1.3, 9)
    expect(slow['wind.flight']).toBeUndefined()
    // 180 m/s: `FlightWind` has come in too, and both move with the air.
    const fast = windRates(stepEngineAudio(state, fly({ speed: 180 }), spec, []))
    expect(fast['wind.aircraft']).toBeCloseTo(2.8, 9)
    expect(fast['wind.flight']).toBeCloseTo(2.8, 9)
  })

  it('refuses a rate of zero, which is a 0 Hz band and -Infinity cents', () => {
    const e = read('anniversary')
    const broken = {
      ...e,
      audio: {
        ...e.audio,
        speedCurves: {
          ...e.audio.speedCurves,
          windRate: [
            [0, 0],
            [340, 1],
          ],
        },
      },
    } as unknown as Edition
    expect(() => validateEdition(broken)).toThrow(/audio\.speedCurves\.windRate\[0\]/)
  })
})

describe('DEV-425: the shipped Anniversary curves rise by enough to hear', () => {
  const anniversary = preset('anniversary')
  const tracking = anniversary.audio.engine.pitchTracking
  const windRate = anniversary.audio.speedCurves.windRate

  it('has the wind at its authored pitch where 2016 brings `FlightWind` in, and rising', () => {
    // 120 m/s is `minBoostEffectsSpeed`, off the shipped prefab: the speed at
    // which 2016's loop swap happens, so the one speed its pitch belongs to.
    expect(sampleCurve(windRate, HOVERJET.ship.minBoostEffectsSpeed)).toBe(1)
    for (let v = 0; v < 400; v += 5) {
      expect(sampleCurve(windRate, v + 5), `${v} m/s`).toBeGreaterThanOrEqual(
        sampleCurve(windRate, v),
      )
    }
    expect(sampleCurve(windRate, CHAIN_CEILING)).toBeGreaterThan(1)
  })

  it('lifts the engine at least six semitones from GO to the chain’s ceiling (DEV-137 managed 4.2)', () => {
    const rise = semitones(speedRate(tracking, CHAIN_CEILING) / speedRate(tracking, 0))
    expect(rise, `the engine rises ${rise.toFixed(2)} st over a race`).toBeGreaterThanOrEqual(6)
  })

  it('lifts the wind at least four semitones across the chain’s own band, 182 -> 340', () => {
    const rise = semitones(
      sampleCurve(windRate, CHAIN_CEILING) / sampleCurve(windRate, CHAIN_FLOOR),
    )
    expect(rise, `the wind rises ${rise.toFixed(2)} st over the chain`).toBeGreaterThanOrEqual(4)
  })

  it('leaves Classic exactly as it was: the curves are off and `windRate` is flat 1', () => {
    const classic = preset('classic')
    expect(classic.audio.speedCurves.enabled).toBe(false)
    for (const [, rate] of classic.audio.speedCurves.windRate) expect(rate).toBe(1)
  })
})
