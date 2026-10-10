// tests/unit/audio-engine-sound.test.ts — DEV-137: a deep rumble under the
// engine, and a pitch that tracks forward speed. Anniversary only.
//
// Four things are checked here, each in the way that can catch its own bug:
//
//   1. **The arithmetic**, against a fixture whose numbers a person can do in
//      their head (trap 24: no expectation below is computed with `sampleCurve`).
//   2. **The shipped preset**, by RELATIONSHIP and against something OUTSIDE the
//      port — the knees of the speed curve are asserted to sit on the generated
//      sheet's four 2016 speed gates, not on "25, 120, 240, 350" typed here.
//   3. **The two new voices**, as geometry between two specs: every tone in the
//      rumble is HALF a tone in the thruster. A test that read the rumble's Hz
//      off the rumble spec would agree with whatever was authored.
//   4. **Classic**, by flying a profile through the shipped ladder and asserting
//      that neither new cue and no idle modulation appears — the load-bearing
//      claim of the whole preset split, one row on.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createAudioSystem } from '@/audio'
import { createRecordingBackend } from '@/audio/backend'
import { CUES, type CueSpec, type ToneLayer } from '@/audio/cues'
import {
  type CueAction,
  createEngineAudio,
  type EngineAudioInput,
  type EngineAudioSpec,
  engineAudioWithCurves,
  engineAudioWithEngineSound,
  resetEngineAudio,
  SHIPPED_ENGINE_AUDIO,
  stepEngineAudio,
} from '@/audio/engine'
import { createRacerEngines, type RacerAudioInput } from '@/audio/racer-engines'
import { DEFAULT_LISTENER, type Vec3Tuple } from '@/audio/spatial'
import { rumbleModulation, sampleCurve, speedRate } from '@/audio/speed-curves'
import {
  type Edition,
  type EditionEnginePitchTracking,
  type EditionEngineRumble,
  type EditionEngineSound,
  validateEdition,
} from '@/content/edition-schema'
import { DERIVED, HOVERJET, WORLD } from '@/generated/constants.generated'
import { slewToward } from '@/sim/math/scalar'
import { FIXTURE_CURVES } from './helpers/speed-curves'

// ── Fixtures whose arithmetic is mental ───────────────────────────────────

/** 0.5 at a standstill, 1.5 at 100 m/s. So 1.0 at 50, flat at 1.5 above 100. */
const TRACKING: EditionEnginePitchTracking = {
  enabled: true,
  rateBySpeed: [
    [0, 0.5],
    [100, 1.5],
  ],
  // Ten rate units a second: one 0.0122 s tick moves the rate by 0.122.
  slewPerSecond: 10,
}

/** Gain 0.2 at no throttle, 1 at full; the burner doubles it and opens 100 -> 400 Hz. */
const RUMBLE: EditionEngineRumble = {
  enabled: true,
  gainByThrottle: [
    [0, 0.2],
    [1, 1],
  ],
  cutoffHz: 100,
  boostGain: 2,
  boostCutoffHz: 400,
  growlGain: 0.7,
}

const SOUND: EditionEngineSound = { rumble: RUMBLE, pitchTracking: TRACKING }
const OFF: EditionEngineSound = {
  rumble: { ...RUMBLE, enabled: false },
  pitchTracking: { ...TRACKING, enabled: false },
}

/** Both on, over S4's fixture curves — the full Anniversary shape. */
const FULL = engineAudioWithEngineSound(SOUND, engineAudioWithCurves(FIXTURE_CURVES))
/** The engine voice on, S4 off — a legitimate hand-authored preset. */
const SOUND_ONLY = engineAudioWithEngineSound(SOUND)

const DT = WORLD.fixedDeltaTime

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
  spec: EngineAudioSpec = FULL,
): CueAction[] => stepEngineAudio(state, input(over), spec, [])

const plays = (actions: readonly CueAction[]): string[] =>
  actions.filter((a) => a.kind === 'play').map((a) => a.cue)
const stops = (actions: readonly CueAction[]): string[] =>
  actions.filter((a) => a.kind === 'stop').map((a) => a.cue)
const mods = (actions: readonly CueAction[]): Map<string, CueAction & { kind: 'modulate' }> => {
  const out = new Map<string, CueAction & { kind: 'modulate' }>()
  for (const a of actions) if (a.kind === 'modulate') out.set(a.cue, a)
  return out
}

/** Settle a fresh state at `over` (two ticks, so the edges are behind us) and return the third. */
const settled = (over: Partial<EngineAudioInput>, spec: EngineAudioSpec = FULL): CueAction[] => {
  const state = createEngineAudio()
  step(state, over, spec)
  step(state, over, spec)
  return step(state, over, spec)
}

const DIR = fileURLToPath(new URL('../../content/editions/', import.meta.url))
const preset = (id: string): Edition =>
  validateEdition(JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8')) as Edition)

// ─────────────────────────────────────────────────────────────────────────

describe('the arithmetic: speedRate, slewToward, rumbleModulation', () => {
  it('reads the rate off the speed curve, flat outside it', () => {
    expect(speedRate(TRACKING, 0)).toBe(0.5)
    expect(speedRate(TRACKING, 50)).toBe(1)
    expect(speedRate(TRACKING, 100)).toBe(1.5)
    expect(speedRate(TRACKING, 5000)).toBe(1.5)
    expect(speedRate(TRACKING, -40)).toBe(0.5)
  })

  it('slews by at most the step, and lands exactly when within reach', () => {
    expect(slewToward(1, 2, 0.25)).toBe(1.25)
    expect(slewToward(2, 1, 0.25)).toBe(1.75)
    expect(slewToward(1, 1.1, 0.25)).toBe(1.1)
    expect(slewToward(1, 1, 0.25)).toBe(1)
  })

  it('gains the rumble off the throttle and steps it on the burner', () => {
    // 0.2 -> 1 over 0..1, so 0.6 at half throttle; x2 and 400 Hz while burning.
    const idle = rumbleModulation(RUMBLE, 0.5, false)
    expect(idle.gain).toBeCloseTo(0.6, 10)
    expect(idle.cutoffHz).toBe(100)
    const lit = rumbleModulation(RUMBLE, 0.5, true)
    expect(lit.gain).toBeCloseTo(1.2, 10)
    expect(lit.cutoffHz).toBe(400)
    expect(rumbleModulation(RUMBLE, 0, false).gain).toBeCloseTo(0.2, 10)
  })
})

describe('the rumble bed and the growl', () => {
  it('starts the rumble on the tick the idle bed starts, and not before release', () => {
    const state = createEngineAudio()
    expect(plays(step(state, { released: false }))).toEqual([])
    const first = step(state, {})
    expect(plays(first)).toEqual(expect.arrayContaining(['engine.idle', 'engine.rumble']))
    // And modulates it in the SAME action list, at the idle-throttle gain and
    // the closed cutoff — the backend builds its nodes at the first target.
    const m = mods(first).get('engine.rumble')
    expect(m?.gain).toBeCloseTo(0.2, 10)
    expect(m?.cutoffHz).toBe(100)
  })

  it('modulates the rumble every tick with the throttle gain', () => {
    const m = mods(settled({ throttle: 0.5, speed: 50 })).get('engine.rumble')
    expect(m?.gain).toBeCloseTo(0.6, 10)
    expect(m?.cutoffHz).toBe(100)
  })

  it('lights the growl WITH the burner and puts it out with it', () => {
    const state = createEngineAudio()
    step(state, { throttle: 1, speed: 50 })
    const lit = step(state, { throttle: 1, boost: true, speed: 50 })
    expect(plays(lit)).toEqual(['engine.afterburner', 'engine.growl'])
    const m = mods(lit)
    // The rumble opens and doubles while the burner is lit; the growl carries
    // the preset's growl gain and the open cutoff.
    expect(m.get('engine.rumble')?.gain).toBeCloseTo(2, 10)
    expect(m.get('engine.rumble')?.cutoffHz).toBe(400)
    expect(m.get('engine.growl')?.gain).toBe(0.7)
    expect(m.get('engine.growl')?.cutoffHz).toBe(400)
    const out = step(state, { throttle: 1, boost: false, speed: 50 })
    expect(stops(out)).toEqual(['engine.afterburner', 'engine.growl'])
    expect(mods(out).has('engine.growl')).toBe(false)
  })

  it('kills the growl when the THROTTLE is released with the boost still held — 2016s asymmetry', () => {
    // `GasReleased()` stops both loops (`Input_Ship.cs:599-600`); the growl is
    // tied to the afterburner and must follow it out.
    const state = createEngineAudio()
    step(state, { throttle: 1, boost: true, speed: 50 })
    const out = step(state, { throttle: 0, boost: true, speed: 50 })
    expect(stops(out)).toEqual(
      expect.arrayContaining(['engine.thrust', 'engine.afterburner', 'engine.growl']),
    )
  })

  it('locks the rumble to the thruster and the growl to the burner, whatever the rate', () => {
    // Not "the rumble is at rate X" — the rumble is at the SAME rate as the loop
    // it doubles, so the octave holds under every throttle and every speed.
    for (const over of [
      { throttle: 0.3, speed: 20 },
      { throttle: 1, speed: 80, boost: true },
      { throttle: 0.7, speed: 300, boost: true },
    ]) {
      const m = mods(settled(over))
      expect(m.get('engine.rumble')?.rate).toBeCloseTo(m.get('engine.thrust')?.rate as number, 12)
      if (over.boost) {
        expect(m.get('engine.growl')?.rate).toBeCloseTo(
          m.get('engine.afterburner')?.rate as number,
          12,
        )
      }
    }
  })

  it('puts both away when the flag goes off under a running voice', () => {
    const state = createEngineAudio()
    step(state, { throttle: 1, boost: true, speed: 50 })
    expect(state.rumble).toBe(true)
    expect(state.growl).toBe(true)
    const off = step(
      state,
      { throttle: 1, boost: true, speed: 50 },
      engineAudioWithCurves(FIXTURE_CURVES),
    )
    expect(stops(off)).toEqual(['engine.rumble', 'engine.growl'])
    expect(state.rumble).toBe(false)
    expect(state.growl).toBe(false)
    // And the 2016 loops are untouched by the flip.
    expect(state.thrust).toBe(true)
    expect(state.afterburner).toBe(true)
  })
})

describe('the pitch that tracks forward speed', () => {
  it('multiplies S4s throttle rate by the speed rate on the thruster and the burner', () => {
    // Fixture thrustRate is 1.5 at full throttle, x afterburnerStep 2 while
    // burning = 3; afterburnerRate is 4 at full. Speed 50 is rate 1.0, speed 100
    // is 1.5 — so 4.5 and 6 at 100 m/s, and the plain S4 numbers at 50.
    const at50 = mods(settled({ throttle: 1, boost: true, speed: 50 }))
    expect(at50.get('engine.thrust')?.rate).toBeCloseTo(3, 10)
    expect(at50.get('engine.afterburner')?.rate).toBeCloseTo(4, 10)
    const at100 = mods(settled({ throttle: 1, boost: true, speed: 100 }))
    expect(at100.get('engine.thrust')?.rate).toBeCloseTo(4.5, 10)
    expect(at100.get('engine.afterburner')?.rate).toBeCloseTo(6, 10)
  })

  it('moves the idle bed with the air alone', () => {
    // No throttle term on the bed — 2016 authored it at one fixed pitch and S4
    // left it there — so its rate IS the speed rate.
    expect(mods(settled({ speed: 50 })).get('engine.idle')?.rate).toBeCloseTo(1, 10)
    expect(mods(settled({ speed: 100 })).get('engine.idle')?.rate).toBeCloseTo(1.5, 10)
    expect(mods(settled({ speed: 100, throttle: 1 })).get('engine.idle')?.rate).toBeCloseTo(1.5, 10)
  })

  it('rates every engine voice off the speed alone when S4s curves are not installed', () => {
    const m = mods(settled({ throttle: 1, boost: true, speed: 100 }, SOUND_ONLY))
    expect(m.get('engine.thrust')?.rate).toBeCloseTo(1.5, 10)
    expect(m.get('engine.afterburner')?.rate).toBeCloseTo(1.5, 10)
    expect(m.get('engine.idle')?.rate).toBeCloseTo(1.5, 10)
    expect(m.get('engine.rumble')?.rate).toBeCloseTo(1.5, 10)
    // And no wind modulation at all: that is S4's, and S4 is off.
    expect(m.has('wind.aircraft')).toBe(false)
  })

  it('seeds the tracked rate to the FIRST ticks target rather than gliding from 1', () => {
    const state = createEngineAudio()
    const first = step(state, { speed: 100 })
    expect(state.trackedRate).toBe(1.5)
    expect(mods(first).get('engine.idle')?.rate).toBe(1.5)
  })

  it('slews: a stall walks the rate down by slewPerSecond x dt a tick, and never chirps', () => {
    const state = createEngineAudio()
    step(state, { speed: 100 })
    expect(state.trackedRate).toBe(1.5)
    // Speed to zero in one tick — a crash. Target 0.5, but one tick moves 0.122.
    step(state, { speed: 0 })
    expect(state.trackedRate).toBeCloseTo(1.5 - 10 * DT, 10)
    let ticks = 1
    while (state.trackedRate > 0.5 + 1e-9 && ticks < 200) {
      step(state, { speed: 0 })
      ticks++
    }
    // 1.0 of rate at 10/s is 0.1 s, which is nine ticks at 82 Hz.
    expect(ticks).toBe(Math.ceil(1 / (10 * DT)))
    expect(state.trackedRate).toBe(0.5)
    // Settled: it stays.
    step(state, { speed: 0 })
    expect(state.trackedRate).toBe(0.5)
  })

  it('never limits an acceleration the flight model can produce', () => {
    // 0 -> 100 m/s over two seconds is a rate change of 1.0 over 164 ticks,
    // 0.006 a tick, forty times under the slew. The tracked rate must equal the
    // target on every one of them.
    const state = createEngineAudio()
    const ticks = Math.round(2 / DT)
    for (let i = 0; i <= ticks; i++) {
      const speed = (100 * i) / ticks
      step(state, { speed })
      expect(state.trackedRate).toBeCloseTo(speedRate(TRACKING, speed), 10)
    }
  })

  it('resets with the rest of the state', () => {
    const state = createEngineAudio()
    step(state, { speed: 100, throttle: 1, boost: true })
    resetEngineAudio(state)
    expect(state).toEqual(createEngineAudio())
    expect(state.rateSeeded).toBe(false)
  })
})

describe('Classic is untouched', () => {
  const PROFILE: readonly Partial<EngineAudioInput>[] = [
    { released: false },
    {},
    { throttle: 1, speed: 20 },
    { throttle: 1, speed: 80 },
    { throttle: 1, boost: true, speed: 140 },
    { throttle: 1, boost: true, speed: 260 },
    { throttle: 1, speed: 180 },
    { throttle: 0, speed: 60 },
    { throttle: 0, speed: 2 },
  ]

  const fly = (spec: EngineAudioSpec): CueAction[] => {
    const state = createEngineAudio()
    const out: CueAction[] = []
    for (const tick of PROFILE) stepEngineAudio(state, input(tick), spec, out)
    return out
  }

  it('produces neither new cue and no idle modulation on the shipped ladder', () => {
    const classic = fly(SHIPPED_ENGINE_AUDIO)
    expect(classic.map((a) => a.cue)).not.toContain('engine.rumble')
    expect(classic.map((a) => a.cue)).not.toContain('engine.growl')
    expect(classic.filter((a) => a.kind === 'modulate')).toEqual([])
  })

  it('produces the same list with S4 on and the engine voice OFF as with S4 alone', () => {
    // The `with` function must be a no-op for a block with both flags off — or
    // the Classic preset, which carries exactly that block, would not be Classic.
    const s4 = engineAudioWithCurves(FIXTURE_CURVES)
    expect(engineAudioWithEngineSound(OFF, s4)).toBe(s4)
    expect(engineAudioWithEngineSound(null)).toBe(SHIPPED_ENGINE_AUDIO)
    expect(fly(engineAudioWithEngineSound(OFF, s4))).toEqual(fly(s4))
  })

  it('honours each flag on its own', () => {
    const rumbleOnly = engineAudioWithEngineSound({ ...OFF, rumble: RUMBLE })
    expect(rumbleOnly.rumble).toBe(RUMBLE)
    expect(rumbleOnly.pitchTracking).toBeNull()
    const pitchOnly = engineAudioWithEngineSound({ ...OFF, pitchTracking: TRACKING })
    expect(pitchOnly.rumble).toBeNull()
    expect(pitchOnly.pitchTracking).toBe(TRACKING)
    // Pitch without rumble: the 2016 loops move and nothing new plays.
    const m = fly(pitchOnly)
    expect(m.map((a) => a.cue)).not.toContain('engine.rumble')
    expect(m.some((a) => a.kind === 'modulate' && a.cue === 'engine.idle')).toBe(true)
  })

  it('leaves every 2016 threshold and both kept-bug switches exactly where they were', () => {
    expect(FULL.windSpeed).toBe(SHIPPED_ENGINE_AUDIO.windSpeed)
    expect(FULL.flightWindSpeed).toBe(SHIPPED_ENGINE_AUDIO.flightWindSpeed)
    expect(FULL.stage2Speed).toBe(SHIPPED_ENGINE_AUDIO.stage2Speed)
    expect(FULL.stage3Speed).toBe(SHIPPED_ENGINE_AUDIO.stage3Speed)
    expect(FULL.gasThreshold).toBe(SHIPPED_ENGINE_AUDIO.gasThreshold)
    // The engine voice turns nothing off: `windLoopsNeverStop` is S4's call, and
    // with S4 absent it stays true even with both DEV-137 flags on.
    expect(SOUND_ONLY.windLoopsNeverStop).toBe(true)
  })
})

describe('trap 19 — a second state does not inherit the first one', () => {
  it('steps two ships and the first does not move, tracked rate included', () => {
    const a = createEngineAudio()
    const b = createEngineAudio()
    for (let v = 0; v <= 100; v += 10) step(a, { speed: v, throttle: 1, boost: true })
    const before = { ...a }
    for (let v = 0; v <= 100; v += 10) step(b, { speed: 100 - v, throttle: 0 })
    expect({ ...a }).toEqual(before)
    expect(b.trackedRate).not.toBe(a.trackedRate)
  })
})

describe('the two new voices, as geometry between specs', () => {
  const tones = (spec: CueSpec): ToneLayer[] =>
    spec.layers.filter((l): l is ToneLayer => l.kind === 'tone')
  const hz = (spec: CueSpec, layer: ToneLayer): number => layer.startHz * spec.pitch

  it('the rumble is the thruster an OCTAVE DOWN: every tone is half a thruster tone', () => {
    const thrust = CUES['engine.thrust']
    const rumble = CUES['engine.rumble']
    const thrustHz = tones(thrust).map((l) => hz(thrust, l))
    expect(tones(rumble).length).toBeGreaterThan(0)
    for (const layer of tones(rumble)) {
      const f = hz(rumble, layer)
      expect(
        thrustHz.some((t) => Math.abs(t / 2 - f) < 1e-9),
        `${f} Hz is not half of any thruster tone (${thrustHz.join(', ')})`,
      ).toBe(true)
    }
    // The sub IS a sine on the thruster's fundamental / 2 — 47 Hz for a 94 Hz
    // thruster — and it is the lowest thing in the recipe.
    const sub = tones(rumble).find((l) => l.wave === 'sine')
    expect(sub).toBeDefined()
    expect(hz(rumble, sub as ToneLayer)).toBeCloseTo(Math.min(...thrustHz) / 2, 9)
    expect(hz(rumble, sub as ToneLayer)).toBe(Math.min(...tones(rumble).map((l) => hz(rumble, l))))
  })

  it('the rumble carries none of the thrusters bright noise band', () => {
    // An octave down there is nothing for a 900 Hz band to say, and the cutoff
    // would only take it out again. The low noise stays.
    const noises = CUES['engine.rumble'].layers.filter((l) => l.kind === 'noise')
    expect(noises.length).toBeGreaterThan(0)
    for (const n of noises) expect(n.filter).toBe('lowpass')
  })

  it('the growl is the burner an octave down, plus a partner a fifth up that beats in the roughness band', () => {
    const burner = CUES['engine.afterburner']
    const growl = CUES['engine.growl']
    const burnerHz = tones(burner).map((l) => hz(burner, l))
    const growlHz = tones(growl).map((l) => hz(growl, l))
    const halves = growlHz.filter((f) => burnerHz.some((b) => Math.abs(b / 2 - f) < 1e-9))
    expect(halves).toHaveLength(burnerHz.length)
    const partners = growlHz.filter((f) => !halves.includes(f))
    expect(partners).toHaveLength(1)
    const partner = partners[0] as number
    // A fifth above the burner's sawtooth-half: 1.5x, and the difference tone
    // lands in 20..70 Hz, where the ear reads roughness rather than a pitch.
    const saw = tones(growl).find((l) => l.wave === 'sawtooth' && halves.includes(hz(growl, l)))
    expect(saw).toBeDefined()
    const sawHz = hz(growl, saw as ToneLayer)
    expect(partner / sawHz).toBeCloseTo(1.5, 9)
    expect(partner - sawHz).toBeGreaterThan(20)
    expect(partner - sawHz).toBeLessThan(70)
  })

  it('both are loops that cannot interrupt themselves, sit under the loop they double, and say they are ours', () => {
    for (const [id, over] of [
      ['engine.rumble', 'engine.thrust'],
      ['engine.growl', 'engine.afterburner'],
    ] as const) {
      const s = CUES[id]
      expect(s.loop).toBe(true)
      expect(s.retrigger).toBe('ignore')
      expect(s.group).toBeNull()
      expect(s.gain).toBeLessThan(CUES[over].gain)
      expect(s.provenance).toContain('DEV-137')
    }
  })
})

describe('the shipped Anniversary preset, by relationship and against the sheet', () => {
  const anniversary = preset('anniversary')
  const classic = preset('classic')
  const tracking = anniversary.audio.engine.pitchTracking
  const rumble = anniversary.audio.engine.rumble

  it('has both flags on, and Classic has both off with no-op numbers', () => {
    expect(rumble.enabled).toBe(true)
    expect(tracking.enabled).toBe(true)
    expect(classic.audio.engine.rumble.enabled).toBe(false)
    expect(classic.audio.engine.pitchTracking.enabled).toBe(false)
    for (const [, g] of classic.audio.engine.rumble.gainByThrottle) expect(g).toBe(0)
    expect(classic.audio.engine.rumble.growlGain).toBe(0)
    for (const [, r] of classic.audio.engine.pitchTracking.rateBySpeed) expect(r).toBe(1)
  })

  it('puts its knees on the sheets four 2016 speed gates — not on numbers typed here', () => {
    // Compare against something outside the port (CLAUDE.md, DEV-069): the
    // generated constants, which resolve to PlayerShip_SR14_Photon.prefab.
    const knees = tracking.rateBySpeed.map(([x]) => x)
    for (const gate of [
      HOVERJET.ship.minEffectsSpeed,
      HOVERJET.ship.minBoostEffectsSpeed,
      HOVERJET.ship.minBoostEffect_stage2_speed,
      HOVERJET.ship.minBoostEffect_stage3_speed,
    ]) {
      expect(knees, `no knee at ${gate} m/s`).toContain(gate)
    }
    // And the boost band's floor is where the loops sit AS AUTHORED: 2016's
    // `FlightWind` arrives at 120, and that is the speed the 2016 pitch belongs to.
    expect(speedRate(tracking, HOVERJET.ship.minBoostEffectsSpeed)).toBe(1)
  })

  it('rises with speed, monotonically, and stays within an octave of authored', () => {
    let previous = Number.NEGATIVE_INFINITY
    for (const [x] of tracking.rateBySpeed) {
      expect(x).toBeGreaterThanOrEqual(previous)
      previous = x
    }
    for (let v = 0; v < 400; v += 5) {
      const here = speedRate(tracking, v)
      const next = speedRate(tracking, v + 5)
      expect(next, `${v} m/s`).toBeGreaterThanOrEqual(here)
      expect(here).toBeGreaterThan(0.5)
      expect(here).toBeLessThan(2)
    }
    // A standstill is BELOW authored and terminal is above it: the range brackets 1.
    expect(speedRate(tracking, 0)).toBeLessThan(1)
    expect(speedRate(tracking, 350)).toBeGreaterThan(1)
  })

  it('puts the two derived terminals where the brief asked: cruise under authored, boost over it', () => {
    // `derived.hoverjet.terminalSpeed{Cruise,Boost}` are the sheet's own
    // fixed points of the flight model (89.8 and 179.6 m/s). A held throttle
    // settles there, so these two rates are what a pilot hears most of a run —
    // one just under the authored pitch, one just over, with the 120 m/s
    // `FlightWind` gate between them at exactly 1.
    const cruise = speedRate(tracking, DERIVED.hoverjet.terminalSpeedCruise)
    const boost = speedRate(tracking, DERIVED.hoverjet.terminalSpeedBoost)
    expect(cruise).toBeLessThan(1)
    expect(boost).toBeGreaterThan(1)
    expect(cruise).toBeGreaterThan(speedRate(tracking, 0))
    expect(boost).toBeLessThan(speedRate(tracking, 350))
  })

  it('composes with S4 to less than a fifth up at the very top', () => {
    // thrustRate(1) x afterburnerStep x rateBySpeed(350). A fifth is 1.5; past
    // that the thruster stops reading as the same engine.
    const curves = anniversary.audio.speedCurves
    const top =
      sampleCurve(curves.thrustRate, 1) * curves.afterburnerStep * speedRate(tracking, 350)
    expect(top).toBeGreaterThan(1)
    expect(top).toBeLessThan(1.5)
  })

  it('slews slowly enough that a stall takes at least half a second, and fast enough to finish in three', () => {
    const span = speedRate(tracking, 350) - speedRate(tracking, 0)
    const seconds = span / tracking.slewPerSecond
    expect(seconds).toBeGreaterThan(0.5)
    expect(seconds).toBeLessThan(3)
  })

  it('keeps the rumble present at idle and under the thruster at full', () => {
    expect(sampleCurve(rumble.gainByThrottle, 0)).toBeGreaterThan(0)
    expect(sampleCurve(rumble.gainByThrottle, 1)).toBeGreaterThan(
      sampleCurve(rumble.gainByThrottle, 0),
    )
    // Catalogue gain x the full-throttle multiplier stays under the thruster's
    // catalogue gain: the rumble is under the loop, not over it.
    expect(CUES['engine.rumble'].gain * sampleCurve(rumble.gainByThrottle, 1)).toBeLessThan(
      CUES['engine.thrust'].gain,
    )
    // The burner opens the filter rather than closing it.
    expect(rumble.boostCutoffHz).toBeGreaterThan(rumble.cutoffHz)
    expect(rumble.boostGain).toBeGreaterThanOrEqual(1)
  })
})

describe('the racers engines take the same speed rate, each on its own', () => {
  const racer = (id: string, position: Vec3Tuple, speed: number): RacerAudioInput => ({
    id,
    position,
    speed,
    finished: false,
  })
  const detunes = (backend: ReturnType<typeof createRecordingBackend>): Map<number, number> => {
    const out = new Map<number, number>()
    for (const c of backend.calls) if (c.call === 'detune') out.set(c.handle, c.cents)
    return out
  }

  it('gives two STATIONARY racers different detunes for their different speeds', () => {
    const backend = createRecordingBackend()
    const engines = createRacerEngines(backend)
    engines.setPitchTracking(TRACKING)
    const slow = racer('slow', [10, 0, 0], 0)
    const fast = racer('fast', [-10, 0, 0], 100)
    engines.sync([slow, fast], DEFAULT_LISTENER, 1 / 90)
    engines.sync([slow, fast], DEFAULT_LISTENER, 1 / 90)
    const d = detunes(backend)
    // Not moving, so the Doppler is zero cents and what is left is the rate:
    // 0.5 is an octave down (-1200), 1.5 is a fifth up (+701.96). Seeded at
    // the speed each appeared at, so no glide.
    expect(d.get(1)).toBeCloseTo(-1200, 6)
    expect(d.get(2)).toBeCloseTo(1200 * Math.log2(1.5), 6)
  })

  it('leaves the detune at the Doppler alone when the tracking is off — which is Classic', () => {
    const backend = createRecordingBackend()
    const engines = createRacerEngines(backend)
    const r = racer('fast', [10, 0, 0], 100)
    engines.sync([r], DEFAULT_LISTENER, 1 / 90)
    engines.sync([r], DEFAULT_LISTENER, 1 / 90)
    expect(detunes(backend).get(1)).toBe(0)
  })

  it('slews a racers stall on the FRAME delta, and the other racer does not move', () => {
    const backend = createRecordingBackend()
    const engines = createRacerEngines(backend)
    engines.setPitchTracking(TRACKING)
    const a = racer('a', [10, 0, 0], 100)
    const b = racer('b', [-10, 0, 0], 100)
    const dt = 1 / 90
    engines.sync([a, b], DEFAULT_LISTENER, dt)
    engines.sync([a, b], DEFAULT_LISTENER, dt)
    // `a` hits the sea: speed 0 in one frame. One frame moves 10 x (1/90) = 0.111.
    engines.sync([racer('a', [10, 0, 0], 0), b], DEFAULT_LISTENER, dt)
    const d = detunes(backend)
    expect(d.get(1)).toBeCloseTo(1200 * Math.log2(1.5 - 10 * dt), 6)
    expect(d.get(2)).toBeCloseTo(1200 * Math.log2(1.5), 6)
  })
})

describe('through the system', () => {
  it('setEngineSound reaches the ladder and the racers; null puts both back', () => {
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend, random: () => 0.5 })
    const anniversary = preset('anniversary')
    system.setEngineSound(anniversary.audio.engine)
    system.stepFlight({ speed: 0, throttle: 0, boost: false, released: true })
    expect(backend.calls.filter((c) => c.call === 'play').map((c) => c.id)).toContain(
      'engine.rumble',
    )
    backend.clear()
    system.setEngineSound(null)
    system.stepFlight({ speed: 0, throttle: 0, boost: false, released: true })
    expect(backend.calls.filter((c) => c.call === 'stop').map((c) => c.id)).toEqual([
      'engine.rumble',
    ])
    system.dispose()
  })

  it('setSpeedCurves and setEngineSound do not lose each others contribution', () => {
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend, random: () => 0.5 })
    system.setSpeedCurves(FIXTURE_CURVES)
    system.setEngineSound(SOUND)
    system.stepFlight({ speed: 50, throttle: 1, boost: false, released: true })
    system.stepFlight({ speed: 50, throttle: 1, boost: false, released: true })
    const m = backend.calls.filter((c) => c.call === 'modulate')
    // S4's wind is still modulated with the engine voice installed...
    expect(m.some((c) => c.id === 'wind.aircraft')).toBe(true)
    // ...and the rumble is still running with S4 installed.
    expect(m.some((c) => c.id === 'engine.rumble')).toBe(true)
    // Flip S4 off: the rumble stays.
    backend.clear()
    system.setSpeedCurves(null)
    system.stepFlight({ speed: 50, throttle: 1, boost: false, released: true })
    const after = backend.calls.filter((c) => c.call === 'modulate')
    expect(after.some((c) => c.id === 'engine.rumble')).toBe(true)
    expect(after.some((c) => c.id === 'wind.aircraft')).toBe(false)
    system.dispose()
  })

  it('mission.end and stopAll leave neither new loop running', () => {
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend, random: () => 0.5 })
    system.setEngineSound(SOUND)
    system.stepFlight({ speed: 50, throttle: 1, boost: true, released: true })
    expect(backend.sounding).toEqual(expect.arrayContaining(['engine.rumble', 'engine.growl']))
    system.event({ type: 'mission.end' })
    expect(backend.sounding).not.toContain('engine.rumble')
    expect(backend.sounding).not.toContain('engine.growl')
    // And a restart plays them again — the state followed the event.
    system.stepFlight({ speed: 50, throttle: 1, boost: true, released: true })
    expect(backend.sounding).toEqual(expect.arrayContaining(['engine.rumble', 'engine.growl']))
    system.stopAll()
    expect(backend.sounding).toEqual([])
    system.dispose()
  })
})
