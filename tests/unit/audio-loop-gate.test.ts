// tests/unit/audio-loop-gate.test.ts: `gateLoop`, the play/stop edge of a loop
// that follows one boolean. IU-2.
//
// Three sites wrote it inline (the afterburner and the growl in `engine.ts`,
// the charge tone in `jump-charge.ts`) and now call one helper. The oracle here
// is the OLD inline code, kept below verbatim in shape: it is replayed against
// the helper and against the real steps over seeded sequences, and the actions
// must be identical, in order. Nothing audible may change.
//
// What is NOT merged is pinned too, because a later tidy would "fix" it: the
// thrust stop that also stops the afterburner (`Input_Ship.cs:599-600`).

import { describe, expect, it } from 'vitest'
import type { CueId } from '@/audio/cues'
import {
  type CueAction,
  createEngineAudio,
  type EngineAudioInput,
  engineAudioWithEngineSound,
  gateLoop,
  SHIPPED_ENGINE_AUDIO,
  stepEngineAudio,
} from '@/audio/engine'
import {
  createJumpChargeAudio,
  JUMP_CHARGE_STOP_SECONDS,
  jumpChargeRate,
  stepJumpChargeAudio,
} from '@/audio/jump-charge'

/** A small seeded generator, so a failure replays. */
const lcg = (seed: number) => {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** The inline pattern the helper replaced, as the three sites wrote it. */
const oldGate = (
  want: boolean,
  state: { playing: boolean },
  cue: CueId,
  fadeSeconds: number,
  out: CueAction[],
): void => {
  if (want && !state.playing) {
    state.playing = true
    out.push({ kind: 'play', cue })
  } else if (!want && state.playing) {
    state.playing = false
    out.push({ kind: 'stop', cue, fadeSeconds })
  }
}

describe('IU-2: gateLoop is a rising and a falling edge, nothing else', () => {
  it('plays on the rise, stops with the fade on the fall, and is silent while it holds', () => {
    const out: CueAction[] = []
    expect(gateLoop(false, false, 'engine.growl', 0.3, out)).toBe(false)
    expect(out).toEqual([])
    expect(gateLoop(true, false, 'engine.growl', 0.3, out)).toBe(true)
    expect(out).toEqual([{ kind: 'play', cue: 'engine.growl' }])
    expect(gateLoop(true, true, 'engine.growl', 0.3, out)).toBe(true)
    expect(out).toHaveLength(1)
    expect(gateLoop(false, true, 'engine.growl', 0.3, out)).toBe(false)
    expect(out).toEqual([
      { kind: 'play', cue: 'engine.growl' },
      { kind: 'stop', cue: 'engine.growl', fadeSeconds: 0.3 },
    ])
  })

  it('appends to out and leaves what is already there alone', () => {
    const earlier: CueAction = { kind: 'play', cue: 'engine.idle' }
    const out: CueAction[] = [earlier]
    gateLoop(true, false, 'jump.charge', 0.05, out)
    expect(out[0]).toBe(earlier)
    expect(out).toHaveLength(2)
  })

  it('replays the old inline pattern over seeded sequences, action for action', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rnd = lcg(seed)
      const state = { playing: false }
      let playing = false
      for (let i = 0; i < 600; i++) {
        // Long runs, so both edges and the holds between them all occur.
        const want = rnd() < 0.5 ? state.playing : rnd() < 0.5
        const expected: CueAction[] = []
        oldGate(want, state, 'engine.afterburner', 0.25, expected)
        const actual: CueAction[] = []
        playing = gateLoop(want, playing, 'engine.afterburner', 0.25, actual)
        expect(actual).toEqual(expected)
        expect(playing).toBe(state.playing)
      }
    }
  })
})

describe('IU-2: the jump-charge step is unchanged', () => {
  /** The step as it was written before the helper, kept as the oracle. */
  const oldStep = (
    state: { playing: boolean },
    charge: number | undefined,
    out: CueAction[],
  ): CueAction[] => {
    if (charge !== undefined && charge > 0) {
      if (!state.playing) {
        out.push({ kind: 'play', cue: 'jump.charge' })
        state.playing = true
      }
      out.push({ kind: 'modulate', cue: 'jump.charge', rate: jumpChargeRate(charge) })
    } else if (state.playing) {
      out.push({ kind: 'stop', cue: 'jump.charge', fadeSeconds: JUMP_CHARGE_STOP_SECONDS })
      state.playing = false
    }
    return out
  }

  it('matches the old step on charges that include undefined, zero, negative, NaN and over 1', () => {
    const odd: (number | undefined)[] = [undefined, 0, -0.2, Number.NaN, 1.4, 1, 0.0001]
    for (const seed of [11, 12, 13, 14]) {
      const rnd = lcg(seed)
      const mine = createJumpChargeAudio()
      const old = { playing: false }
      for (let i = 0; i < 500; i++) {
        const r = rnd()
        const charge = r < 0.3 ? odd[Math.floor(rnd() * odd.length)] : rnd()
        expect(stepJumpChargeAudio(mine, charge, [])).toEqual(oldStep(old, charge, []))
        expect(mine.playing).toBe(old.playing)
      }
    }
  })

  it('plays then modulates on the first tick of a charge, and stops on the first tick after', () => {
    const s = createJumpChargeAudio()
    expect(stepJumpChargeAudio(s, undefined, [])).toEqual([])
    expect(stepJumpChargeAudio(s, 0.5, [])).toEqual([
      { kind: 'play', cue: 'jump.charge' },
      { kind: 'modulate', cue: 'jump.charge', rate: jumpChargeRate(0.5) },
    ])
    expect(stepJumpChargeAudio(s, 0.6, [])).toEqual([
      { kind: 'modulate', cue: 'jump.charge', rate: jumpChargeRate(0.6) },
    ])
    expect(stepJumpChargeAudio(s, 0, [])).toEqual([
      { kind: 'stop', cue: 'jump.charge', fadeSeconds: JUMP_CHARGE_STOP_SECONDS },
    ])
    expect(stepJumpChargeAudio(s, 0, [])).toEqual([])
  })
})

describe('IU-2: the engine afterburner and growl, and the asymmetry that stays', () => {
  const SOUND = engineAudioWithEngineSound({
    rumble: {
      enabled: true,
      gainByThrottle: [
        [0, 0.2],
        [1, 1],
      ],
      cutoffHz: 100,
      boostGain: 2,
      boostCutoffHz: 400,
      growlGain: 0.7,
    },
    pitchTracking: { enabled: false, rateBySpeed: [[0, 1]], slewPerSecond: 10 },
  })
  const fade = SOUND.loopStopSeconds

  const input = (over: Partial<EngineAudioInput> = {}): EngineAudioInput => ({
    speed: 0,
    throttle: 0,
    boost: false,
    released: true,
    ...over,
  })

  /** Only the play and stop edges, which is what the helper owns. */
  const edges = (actions: readonly CueAction[]): string[] =>
    actions.filter((a) => a.kind === 'play' || a.kind === 'stop').map((a) => `${a.kind} ${a.cue}`)

  it('the burner and the growl start together and stop together, in that order', () => {
    const state = createEngineAudio()
    const at = (over: Partial<EngineAudioInput>) => stepEngineAudio(state, input(over), SOUND, [])
    at({}) // the idle bed and the rumble start here
    expect(edges(at({ throttle: 1 }))).toEqual(['play engine.thrust'])
    expect(edges(at({ throttle: 1, boost: true }))).toEqual([
      'play engine.afterburner',
      'play engine.growl',
    ])
    expect(edges(at({ throttle: 1, boost: true }))).toEqual([])
    // Boost released with the throttle still held: BoostReleased stops one.
    const released = at({ throttle: 1, boost: false })
    expect(edges(released)).toEqual(['stop engine.afterburner', 'stop engine.growl'])
    expect(
      released.filter((a) => a.kind === 'stop').map((a) => a.kind === 'stop' && a.fadeSeconds),
    ).toEqual([fade, fade])
  })

  it('NOT merged: releasing the throttle stops the thruster and then the burner, boost held', () => {
    const state = createEngineAudio()
    const at = (over: Partial<EngineAudioInput>) => stepEngineAudio(state, input(over), SOUND, [])
    at({})
    at({ throttle: 1 })
    at({ throttle: 1, boost: true })
    // `GasReleased()` stops BOTH (`Input_Ship.cs:599-600`), even with boost held.
    expect(edges(at({ throttle: 0, boost: true }))).toEqual([
      'stop engine.thrust',
      'stop engine.afterburner',
      'stop engine.growl',
    ])
    // And the burner does not stop a second time.
    expect(edges(at({ throttle: 0, boost: true }))).toEqual([])
  })

  it('boost without throttle is silent, and a held boost re-arms when the throttle returns', () => {
    const state = createEngineAudio()
    const at = (over: Partial<EngineAudioInput>) => stepEngineAudio(state, input(over), SOUND, [])
    at({})
    expect(edges(at({ throttle: 0, boost: true }))).toEqual([])
    expect(edges(at({ throttle: 1, boost: true }))).toEqual([
      'play engine.thrust',
      'play engine.afterburner',
      'play engine.growl',
    ])
  })

  it('without the rumble spec there is no growl, and the burner is untouched', () => {
    const state = createEngineAudio()
    const at = (over: Partial<EngineAudioInput>) =>
      stepEngineAudio(state, input(over), SHIPPED_ENGINE_AUDIO, [])
    at({})
    expect(edges(at({ throttle: 1, boost: true }))).toEqual([
      'play engine.thrust',
      'play engine.afterburner',
    ])
    expect(edges(at({ throttle: 1, boost: false }))).toEqual(['stop engine.afterburner'])
  })
})
