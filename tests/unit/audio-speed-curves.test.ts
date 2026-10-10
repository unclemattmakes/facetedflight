// tests/unit/audio-speed-curves.test.ts — S4: sound that moves with airspeed.
//
// DEV-084, docs/plan/ANNIVERSARY.md §2.5. Three things are checked here and they
// are checked in three different ways on purpose:
//
//   1. **The arithmetic**, against a fixture whose expectations are hand-computed
//      (`helpers/speed-curves.ts` says why they are absurd numbers). Trap 24:
//      a test that recomputes its expectation with the implementation's own
//      arithmetic has tested nothing, so no assertion below calls `sampleCurve`
//      to work out what `sampleCurve` should say.
//   2. **The shipped preset**, by RELATIONSHIP only — the wind gets brighter
//      with speed, the whoosh gets louder. Those stay true when Matt moves a
//      number; an exact assertion on a tuning table fails every time somebody
//      tunes, which trains people to update the test instead of reading it.
//   3. **Classic**, by flying a whole profile through the ladder twice and
//      diffing. "Classic sounds exactly as it did" is the load-bearing claim of
//      the entire Classic/Anniversary split, and the honest form of it is not
//      "no `modulate` appears" (necessary, not sufficient) but "here is every
//      way the two lists differ, and it is exactly the two the ledger row
//      names".

import { describe, expect, it } from 'vitest'
import { createRecordingBackend, createSilentBackend } from '@/audio/backend'
import { CUES } from '@/audio/cues'
import {
  type CueAction,
  createEngineAudio,
  type EngineAudioInput,
  type EngineAudioSpec,
  engineAudioWithCurves,
  gateWhooshActions,
  SHIPPED_ENGINE_AUDIO,
  stepEngineAudio,
} from '@/audio/engine'
import { createAudioSystem } from '@/audio/index'
import { sampleCurve } from '@/audio/speed-curves'
import type { Breakpoints } from '@/content/edition-schema'
import { loadEdition } from '@/content/load-edition'
import { FIXTURE_CURVES } from './helpers/speed-curves'

const ANNIVERSARY_SPEC = engineAudioWithCurves(FIXTURE_CURVES)

const input = (over: Partial<EngineAudioInput> = {}): EngineAudioInput => ({
  speed: 0,
  throttle: 0,
  boost: false,
  released: true,
  ...over,
})

const step = (
  state: ReturnType<typeof createEngineAudio>,
  over: Partial<EngineAudioInput> = {},
  spec: EngineAudioSpec = ANNIVERSARY_SPEC,
): CueAction[] => stepEngineAudio(state, input(over), spec, [])

/** Every `modulate` this step produced, keyed by cue. */
const mods = (actions: readonly CueAction[]): Map<string, CueAction & { kind: 'modulate' }> => {
  const out = new Map<string, CueAction & { kind: 'modulate' }>()
  for (const a of actions) if (a.kind === 'modulate') out.set(a.cue, a)
  return out
}

/**
 * Fly a state up to `speed` with the throttle down, then take one more step and
 * return only THAT step's actions.
 *
 * The settle matters: the ladder emits `play`/`stop` on edges, so the first tick
 * at a new speed carries them and every tick after carries only the continuous
 * layer. Reading the second tick is what makes "one modulate per running loop,
 * every tick" assertable rather than tangled up with the edges.
 */
const settled = (
  speed: number,
  over: Partial<EngineAudioInput> = {},
  spec: EngineAudioSpec = ANNIVERSARY_SPEC,
): CueAction[] => {
  const state = createEngineAudio()
  // Walk up rather than jumping: the stage ladder's guards are bands, and a
  // single step from 0 to 300 lands in stage 3 without ever arming stage 1 —
  // which is a real 2016 path (`:481` does not stop `boostEffects`) and not the
  // one a ship flies. See `engine.ts`'s header.
  for (let v = 0; v < speed; v += 20) step(state, { ...over, speed: v }, spec)
  step(state, { ...over, speed }, spec)
  return step(state, { ...over, speed }, spec)
}

describe('sampleCurve — flat outside, linear between', () => {
  // Two points on a straight line, so every expectation below is a sum a person
  // can check: y = 10 + (x - 10) at x in [10, 20], then flat.
  const curve: Breakpoints = [
    [10, 10],
    [20, 20],
  ]

  it('is FLAT below the first point, not extrapolated', () => {
    // The safety property. Extrapolation is how a tuning table becomes a gain of
    // 1.6 or a cutoff past Nyquist the first time a ship goes somewhere the
    // author did not imagine.
    expect(sampleCurve(curve, 0)).toBe(10)
    expect(sampleCurve(curve, -1000)).toBe(10)
  })

  it('is FLAT above the last point', () => {
    expect(sampleCurve(curve, 20)).toBe(20)
    expect(sampleCurve(curve, 9999)).toBe(20)
  })

  it('interpolates between two points', () => {
    expect(sampleCurve(curve, 15)).toBe(15)
    expect(sampleCurve(curve, 12.5)).toBe(12.5)
  })

  it('lands exactly on an interior point rather than near it', () => {
    const three: Breakpoints = [
      [0, 0],
      [10, 100],
      [20, 0],
    ]
    expect(sampleCurve(three, 10)).toBe(100)
    expect(sampleCurve(three, 5)).toBe(50)
    expect(sampleCurve(three, 15)).toBe(50)
  })

  it('reads two points at one x as a STEP, not a divide by zero', () => {
    // "Silent below 120, half above it" is a legitimate thing to author, and the
    // schema allows it (ascending is >=, not >). What it must never be is NaN.
    const step: Breakpoints = [
      [0, 0],
      [120, 0],
      [120, 0.5],
      [200, 0.5],
    ]
    expect(sampleCurve(step, 119)).toBeCloseTo(0, 10)
    expect(sampleCurve(step, 120)).toBe(0)
    expect(sampleCurve(step, 121)).toBe(0.5)
    expect(Number.isNaN(sampleCurve(step, 120))).toBe(false)
  })

  it('answers a single point with that point, and an empty curve with zero', () => {
    // The loader refuses both (`minItems: 2`), so neither can reach the mixer.
    // Pinned anyway, because "what does it do with no points" is a question
    // somebody will answer from the code otherwise, and the answer would then be
    // whatever a `for` loop happened to do.
    expect(sampleCurve([[5, 42]], 0)).toBe(42)
    expect(sampleCurve([[5, 42]], 500)).toBe(42)
    expect(sampleCurve([], 10)).toBe(0)
  })
})

describe('the wind follows airspeed, and only when the curves are installed', () => {
  it('modulates the aircraft layer at 30 m/s with the curve value and the cutoff', () => {
    // Fixture: aircraftWindGain is 0 -> 1 over 0..100, so 0.3 at 30.
    // windCutoffHz is 1000 -> 5000 over 0..200, so 1000 + 30/200 * 4000 = 1600.
    const m = mods(settled(30)).get('wind.aircraft')
    expect(m?.gain).toBeCloseTo(0.3, 10)
    expect(m?.cutoffHz).toBeCloseTo(1600, 10)
  })

  it('modulates BOTH layers at 180 m/s, each on its own gain curve', () => {
    // aircraftWindGain is flat at 1 above 100. flightWindGain is 0 -> 1 over
    // 100..200, so 0.8 at 180. The cutoff is shared: 1000 + 180/200 * 4000 = 4600.
    const m = mods(settled(180))
    expect(m.get('wind.aircraft')?.gain).toBeCloseTo(1, 10)
    expect(m.get('wind.flight')?.gain).toBeCloseTo(0.8, 10)
    expect(m.get('wind.aircraft')?.cutoffHz).toBeCloseTo(4600, 10)
    expect(m.get('wind.flight')?.cutoffHz).toBeCloseTo(4600, 10)
  })

  it('modulates nothing that is not running', () => {
    // Below `minEffectsSpeed` there is no wind at all, so there is nothing to
    // modulate — and a `modulate` for a cue with no voice is a call the backend
    // has to be told to ignore. Better not to make it.
    expect(mods(settled(10)).size).toBe(0)
    // And at 30 the flight layer has not started: one loop, one modulate.
    const m = mods(settled(30))
    expect([...m.keys()]).toEqual(['wind.aircraft'])
  })

  it('emits the modulate on the SAME tick the loop starts', () => {
    // Not decoration: the backend builds the modulation gain node at the first
    // target rather than at unity, so this ordering is what stops one tick of
    // the authored level being heard in front of a curve that starts at zero.
    const state = createEngineAudio()
    const first = step(state, { speed: 30 })
    expect(first.filter((a) => a.kind === 'play').map((a) => a.cue)).toContain('wind.aircraft')
    expect(mods(first).has('wind.aircraft')).toBe(true)
  })

  it('sends no modulate at all on Classic', () => {
    for (const speed of [10, 30, 130, 260, 400]) {
      const actions = settled(speed, {}, SHIPPED_ENGINE_AUDIO)
      expect(actions.filter((a) => a.kind === 'modulate')).toEqual([])
    }
  })
})

describe('the engine follows the throttle, which is not the speed', () => {
  it('rates the thruster off the throttle curve', () => {
    // Fixture thrustRate is 0.5 -> 1.5 over 0..1, so 1.0 at half throttle.
    const m = mods(settled(60, { throttle: 0.5 })).get('engine.thrust')
    expect(m?.rate).toBeCloseTo(1, 10)
    expect(m?.gain).toBeUndefined()
  })

  it('steps the thruster up while the burner is lit, and rates the burner too', () => {
    // 1.5 at full throttle, x afterburnerStep 2 = 3. The burner's own curve is
    // 2 -> 4 over 0..1, so 4 at full.
    const m = mods(settled(60, { throttle: 1, boost: true }))
    expect(m.get('engine.thrust')?.rate).toBeCloseTo(3, 10)
    expect(m.get('engine.afterburner')?.rate).toBeCloseTo(4, 10)
  })

  it('does not step the thruster when the burner is not lit', () => {
    const m = mods(settled(60, { throttle: 1, boost: false }))
    expect(m.get('engine.thrust')?.rate).toBeCloseTo(1.5, 10)
    expect(m.has('engine.afterburner')).toBe(false)
  })

  it('reads the THROTTLE and not the airspeed — the units mistake DEV-027 is about', () => {
    // Same throttle, wildly different speeds: the engine rate must not move. If
    // it ever does, somebody has wired `input.speed` into a 0..1 curve, which
    // would clamp to the last point and sound like a stuck engine.
    const slow = mods(settled(60, { throttle: 0.5 })).get('engine.thrust')?.rate
    const fast = mods(settled(300, { throttle: 0.5 })).get('engine.thrust')?.rate
    expect(slow).toBeCloseTo(fast as number, 10)
  })
})

describe('the gate whoosh', () => {
  it('gets louder and higher with the speed at the pass', () => {
    // Fixture: gain 0 -> 1 and pitch 1 -> 2, both over 0..100 m/s.
    const at40 = gateWhooshActions(40, ANNIVERSARY_SPEC, [])[0]
    const at90 = gateWhooshActions(90, ANNIVERSARY_SPEC, [])[0]
    expect(at40?.kind).toBe('play')
    if (at40?.kind !== 'play' || at90?.kind !== 'play') throw new Error('not a play action')
    expect(at40.gain).toBeCloseTo(0.4, 10)
    expect(at90.gain).toBeCloseTo(0.9, 10)
    expect(at40.pitch).toBeCloseTo(1.4, 10)
    expect(at90.pitch).toBeCloseTo(1.9, 10)
  })

  it('is flat above the last breakpoint rather than unbounded', () => {
    const fast = gateWhooshActions(2000, ANNIVERSARY_SPEC, [])[0]
    if (fast?.kind !== 'play') throw new Error('not a play action')
    expect(fast.gain).toBe(1)
    expect(fast.pitch).toBe(2)
  })

  it('appends nothing on Classic', () => {
    expect(gateWhooshActions(300, SHIPPED_ENGINE_AUDIO, [])).toEqual([])
  })

  it('is a one-shot with a DOWNWARD sweep — the falling half of a pass-by', () => {
    // The shape is the cue, so it is asserted as geometry rather than as a
    // quaternion-style restatement of what was authored: every swept layer must
    // end BELOW where it started, and the whole thing must be short. The
    // orientation lesson, one medium over.
    const spec = CUES['gate.whoosh']
    expect(spec.loop).toBe(false)
    expect(spec.durationSeconds).toBeLessThan(0.5)
    const swept = spec.layers.filter((l) => l.sweepSeconds > 0)
    expect(swept.length).toBeGreaterThan(0)
    for (const layer of swept) expect(layer.endHz).toBeLessThan(layer.startHz)
  })
})

describe('Classic is untouched, and the difference is exactly what the row claims', () => {
  /**
   * A lap's worth of flight: up through every threshold, boost on and off, and
   * back down to a standstill.
   *
   * Written out rather than generated so that what it covers is readable —
   * 25, 120, 240 and 350 are each crossed in both directions, which is the whole
   * of the ladder.
   */
  const PROFILE: readonly EngineAudioInput[] = [
    input({ released: false }),
    input(),
    input({ throttle: 1, speed: 5 }),
    input({ throttle: 1, speed: 20 }),
    input({ throttle: 1, speed: 40 }),
    input({ throttle: 1, speed: 80 }),
    input({ throttle: 1, speed: 110 }),
    input({ throttle: 1, boost: true, speed: 140 }),
    input({ throttle: 1, boost: true, speed: 190 }),
    input({ throttle: 1, boost: true, speed: 230 }),
    input({ throttle: 1, boost: true, speed: 260 }),
    input({ throttle: 1, boost: true, speed: 320 }),
    input({ throttle: 1, boost: true, speed: 360 }),
    input({ throttle: 1, speed: 330 }),
    input({ throttle: 1, speed: 250 }),
    input({ throttle: 1, speed: 180 }),
    input({ throttle: 0.5, speed: 130 }),
    input({ throttle: 0.5, speed: 100 }),
    input({ throttle: 0, speed: 60 }),
    input({ throttle: 0, speed: 30 }),
    input({ throttle: 0, speed: 15 }),
    input({ throttle: 0, speed: 2 }),
  ]

  const fly = (spec: EngineAudioSpec): CueAction[] => {
    const state = createEngineAudio()
    const out: CueAction[] = []
    for (const tick of PROFILE) stepEngineAudio(state, tick, spec, out)
    return out
  }

  /** What an action IS, for diffing: its kind and its cue, nothing else. */
  const shapes = (actions: readonly CueAction[]): Set<string> =>
    new Set(actions.map((a) => `${a.kind}:${a.cue}`))

  it('flies the whole profile on Classic with no S4 action of any kind', () => {
    const classic = fly(SHIPPED_ENGINE_AUDIO)
    expect(classic.length).toBeGreaterThan(0)
    expect(classic.filter((a) => a.kind === 'modulate')).toEqual([])
    expect(classic.map((a) => a.cue)).not.toContain('gate.whoosh')
    // And no play carries a per-play scale: every 2016 cue fires at its authored
    // level, which is the whole of `mix.ts`. A `gain` or `pitch` here would be
    // the port quietly departing from the gain chain it exists to preserve.
    for (const a of classic) {
      if (a.kind !== 'play') continue
      expect(a.gain).toBeUndefined()
      expect(a.pitch).toBeUndefined()
    }
  })

  it('differs from Anniversary in exactly two ways, both of them in the row', () => {
    const classic = shapes(fly(SHIPPED_ENGINE_AUDIO))
    const anniversary = fly(ANNIVERSARY_SPEC)
    // Strip S4's own additions: what is left should be the SAME ladder.
    const laddered = shapes(anniversary.filter((a) => a.kind !== 'modulate'))

    const onlyClassic = [...classic].filter((s) => !laddered.has(s)).sort()
    const onlyAnniversary = [...laddered].filter((s) => !classic.has(s)).sort()

    // 1. The 120 m/s duck is gone, replaced by the two gain curves crossfading.
    expect(onlyClassic).toEqual(['gain:wind.aircraft'])
    // 2. `windLoopsNeverStop` is off, so both layers can fall silent again.
    expect(onlyAnniversary).toEqual(['stop:wind.aircraft', 'stop:wind.flight'])
  })

  it('turns windLoopsNeverStop off when curves arrive and back on when they go', () => {
    // The one behaviour S4 changes that is NOT a number in the preset, so it is
    // the one that could drift without anybody noticing.
    expect(SHIPPED_ENGINE_AUDIO.windLoopsNeverStop).toBe(true)
    expect(ANNIVERSARY_SPEC.windLoopsNeverStop).toBe(false)
    expect(engineAudioWithCurves(null).windLoopsNeverStop).toBe(true)
    expect(engineAudioWithCurves(null).curves).toBeNull()
  })

  it('leaves every 2016 threshold exactly where it was', () => {
    // S4 rides ON the ladder; it does not move it. The thresholds still come off
    // the shipped prefab through the generated sheet.
    expect(ANNIVERSARY_SPEC.windSpeed).toBe(SHIPPED_ENGINE_AUDIO.windSpeed)
    expect(ANNIVERSARY_SPEC.flightWindSpeed).toBe(SHIPPED_ENGINE_AUDIO.flightWindSpeed)
    expect(ANNIVERSARY_SPEC.stage2Speed).toBe(SHIPPED_ENGINE_AUDIO.stage2Speed)
    expect(ANNIVERSARY_SPEC.stage3Speed).toBe(SHIPPED_ENGINE_AUDIO.stage3Speed)
    expect(ANNIVERSARY_SPEC.gasThreshold).toBe(SHIPPED_ENGINE_AUDIO.gasThreshold)
  })
})

describe('trap 19 — a second state does not inherit the first one', () => {
  it('steps two ships and the first does not move', () => {
    // The continuous layer reads more of the input than the ladder does, so it
    // is one more chance for a shared scratch object. `ai-racer.ts` shared one
    // `HoverJetInput` across every racer and a finished racer flew on with the
    // other racer's stick, frozen, until it went into the sea.
    const a = createEngineAudio()
    const b = createEngineAudio()
    for (let v = 0; v <= 200; v += 20) step(a, { speed: v, throttle: 1 })
    const before = { ...a }
    for (let v = 0; v <= 400; v += 20) step(b, { speed: v, throttle: 0 })
    expect({ ...a }).toEqual(before)
  })
})

describe('the backends take a modulate', () => {
  it('the silent one accepts it and the new cue, and answers nothing', () => {
    // `?audio=off` and a node import both land here, and S4 sends one of these
    // per running loop per sim tick — so silence has to include the continuous
    // layer or every screenshot spec on the Anniversary preset throws 82 times a
    // second.
    const silent = createSilentBackend()
    expect(() => {
      silent.modulate('wind.aircraft', { gain: 0.5, cutoffHz: 3000 })
      silent.modulate('engine.thrust', { rate: 1.1 })
      silent.play(CUES['gate.whoosh'], { pitch: 1.2, detuneCents: 0, position: null, gain: 0.7 })
    }).not.toThrow()
    expect(silent.isPlaying('wind.aircraft')).toBe(false)
  })

  it('the recording one keeps a COPY, not the engine scratch it was handed', () => {
    // Trap 19, in the test double. The engine builds a fresh object per action
    // today; a recording that held the reference would be a transcript of
    // whatever the last tick wrote the day somebody pools them.
    const backend = createRecordingBackend()
    const target = { gain: 0.5, cutoffHz: 3000 }
    backend.modulate('wind.aircraft', target)
    ;(target as { gain: number }).gain = 0.9
    const recorded = backend.calls.find((c) => c.call === 'modulate')
    expect(recorded?.target.gain).toBe(0.5)
  })
})

describe('the system, end to end, against a recording backend', () => {
  const system = (curves: typeof FIXTURE_CURVES | null) => {
    const backend = createRecordingBackend()
    // A fixed RNG so the whoosh's three variations cannot make the assertions
    // flaky — `resolveVariation` multiplies the chosen variation's pitch in.
    const s = createAudioSystem({ backend, random: () => 0 })
    s.setSpeedCurves(curves)
    return { backend, s }
  }

  it('modulates the wind loops once per tick once they are running', () => {
    const { backend, s } = system(FIXTURE_CURVES)
    s.event({ type: 'countdown.go' })
    for (let v = 0; v <= 60; v += 20) {
      s.stepFlight({ speed: v, throttle: 1, boost: false, released: true })
    }
    backend.clear()
    s.stepFlight({ speed: 60, throttle: 1, boost: false, released: true })
    const modulated = backend.calls.filter((c) => c.call === 'modulate')
    // The wind and the thruster, one each, and nothing twice.
    expect(modulated.map((c) => c.id).sort()).toEqual(['engine.thrust', 'wind.aircraft'])
  })

  it('plays the whoosh on a RING and on nothing else', () => {
    const { backend, s } = system(FIXTURE_CURVES)
    s.stepFlight({ speed: 90, throttle: 1, boost: false, released: true })
    backend.clear()
    s.event({ type: 'gate.passed', index: 3, kind: 'ring' })
    const whoosh = backend.calls.find((c) => c.call === 'play' && c.id === 'gate.whoosh')
    expect(whoosh).toBeDefined()
    // Fixture: gain 0.9 at 90 m/s, on a catalogue gain of 0.75 x 1 x 0.75.
    if (whoosh?.call !== 'play') throw new Error('not a play')
    expect(whoosh.gain).toBeCloseTo(CUES['gate.whoosh'].gain * 0.9, 10)

    backend.clear()
    s.event({ type: 'gate.passed', index: 4, kind: 'pad' })
    s.event({ type: 'gate.passed', index: 5, kind: 'orb' })
    s.event({ type: 'gate.passed', index: 6 })
    expect(backend.calls.filter((c) => c.call === 'play' && c.id === 'gate.whoosh')).toEqual([])
    // And the ring ding still fires for all three, as 2016 does.
    expect(backend.calls.filter((c) => c.call === 'play' && c.id === 'ring.pass')).toHaveLength(3)
  })

  it('plays no whoosh and sends no modulate with curves null', () => {
    const { backend, s } = system(null)
    s.stepFlight({ speed: 200, throttle: 1, boost: true, released: true })
    s.event({ type: 'gate.passed', index: 3, kind: 'ring' })
    expect(backend.calls.filter((c) => c.call === 'modulate')).toEqual([])
    expect(backend.calls.filter((c) => c.call === 'play' && c.id === 'gate.whoosh')).toEqual([])
  })

  it('forgets the speed on mission end, so the next run does not open at terminal', () => {
    const { backend, s } = system(FIXTURE_CURVES)
    s.stepFlight({ speed: 300, throttle: 1, boost: true, released: true })
    s.event({ type: 'mission.end' })
    backend.clear()
    s.event({ type: 'gate.passed', index: 0, kind: 'ring' })
    const whoosh = backend.calls.find((c) => c.call === 'play' && c.id === 'gate.whoosh')
    if (whoosh?.call !== 'play') throw new Error('not a play')
    // Fixture gain is 0 at 0 m/s. Without the reset this would be the full 1.
    expect(whoosh.gain).toBeCloseTo(0, 10)
  })
})

describe('the SHIPPED presets, by relationship', () => {
  it('classic carries curves that are no-ops, so a hand-flipped flag is silent', async () => {
    const classic = await loadEdition('classic')
    const c = classic.audio.speedCurves
    expect(c.enabled).toBe(false)
    for (const speed of [0, 30, 120, 250, 340]) {
      expect(sampleCurve(c.aircraftWindGain, speed)).toBe(1)
      expect(sampleCurve(c.flightWindGain, speed)).toBe(1)
      // The whoosh is the one no-op that is SILENT rather than neutral: there is
      // no "as authored" for a cue 2016 does not have.
      expect(sampleCurve(c.gateWhooshGain, speed)).toBe(0)
      // Transparent, not a blanket.
      expect(sampleCurve(c.windCutoffHz, speed)).toBeGreaterThanOrEqual(18000)
    }
    for (const throttle of [0, 0.5, 1]) {
      expect(sampleCurve(c.thrustRate, throttle)).toBe(1)
      expect(sampleCurve(c.afterburnerRate, throttle)).toBe(1)
    }
    expect(c.afterburnerStep).toBe(1)
  })

  it('anniversary gets brighter and louder with speed, and pitches with throttle', async () => {
    const a = (await loadEdition('anniversary')).audio.speedCurves
    expect(a.enabled).toBe(true)

    // The cutoff must RISE — the wind is muffled slow and a hiss fast. This is
    // the direction, which is the thing that would be wrong if anybody ever
    // inverted the curve, and it stays true whatever the numbers become.
    const cutoffs = [25, 80, 160, 260, 340].map((v) => sampleCurve(a.windCutoffHz, v))
    for (let i = 1; i < cutoffs.length; i++) {
      expect(cutoffs[i] as number).toBeGreaterThan(cutoffs[i - 1] as number)
    }
    // And it must end up transparent rather than audibly filtered at terminal.
    expect(sampleCurve(a.windCutoffHz, 340)).toBeGreaterThanOrEqual(10000)

    // Silent AT the gate, so the layer fades up out of nothing rather than
    // snapping on at the authored level.
    expect(sampleCurve(a.aircraftWindGain, 25)).toBe(0)
    expect(sampleCurve(a.flightWindGain, 120)).toBe(0)

    // Every gain stays inside [0, 1]: these multiply the catalogue gain, and a
    // value above 1 is a layer louder than `mix.ts` says it may be.
    for (const speed of [0, 25, 60, 120, 200, 340, 1000]) {
      for (const curve of [a.aircraftWindGain, a.flightWindGain, a.gateWhooshGain]) {
        const g = sampleCurve(curve, speed)
        expect(g).toBeGreaterThanOrEqual(0)
        expect(g).toBeLessThanOrEqual(1)
      }
    }

    // The total wind gets louder, even though the aircraft layer rolls back —
    // the crossfade must not be a hole. This is the claim the duck's removal
    // rests on, so it is the one that most wants a test.
    const total = (v: number): number =>
      sampleCurve(a.aircraftWindGain, v) + sampleCurve(a.flightWindGain, v)
    expect(total(340)).toBeGreaterThan(total(180))
    expect(total(180)).toBeGreaterThan(total(60))
    expect(total(60)).toBeGreaterThan(total(25))

    // The engine answers the stick, upward, and stays within an octave of
    // authored — a jet, not a siren.
    expect(sampleCurve(a.thrustRate, 1)).toBeGreaterThan(sampleCurve(a.thrustRate, 0.1))
    for (const throttle of [0, 0.25, 0.5, 0.75, 1]) {
      const r = sampleCurve(a.thrustRate, throttle) * a.afterburnerStep
      expect(r).toBeGreaterThan(0.5)
      expect(r).toBeLessThan(2)
    }

    // The whoosh gets louder with speed. The brief's own words.
    expect(sampleCurve(a.gateWhooshGain, 300)).toBeGreaterThan(sampleCurve(a.gateWhooshGain, 60))
    expect(sampleCurve(a.gateWhooshPitch, 300)).toBeGreaterThan(sampleCurve(a.gateWhooshPitch, 60))
  })
})
