// tests/unit/audio-engine.test.ts — the one stateful thing in the audio port.
//
// Five loops and the rules that swap them. It is pure, so it is testable in
// node; it is the only part that can get STUCK, so it is tested hard; and it
// carries two shipped 2016 bugs on purpose, so the tests have to pin the bugs
// as well as the behaviour or a later tidy-up will "fix" them.
//
// Trap 19 gets its own block at the bottom. `ai-racer.ts` shared one
// module-level `HoverJetInput` across every racer and a finished racer flew on
// with the other racer's stick until it went into the sea — invisible to every
// single-object test, because with one object there is nobody to inherit from.
// The guard is "step a SECOND one and assert the first did not move."

import { describe, expect, it } from 'vitest'
import type { CueId } from '@/audio/cues'
import {
  type CueAction,
  createEngineAudio,
  ENGINE_LOOPS,
  type EngineAudioInput,
  type EngineAudioSpec,
  gateOff,
  gateOn,
  resetEngineAudio,
  SHIPPED_ENGINE_AUDIO,
  stepEngineAudio,
} from '@/audio/engine'
import { HOVERJET } from '@/generated/constants.generated'

const spec = SHIPPED_ENGINE_AUDIO

const input = (over: Partial<EngineAudioInput> = {}): EngineAudioInput => ({
  speed: 0,
  throttle: 0,
  boost: false,
  released: true,
  ...over,
})

/** Step once and return just this step's actions. */
const step = (
  state: ReturnType<typeof createEngineAudio>,
  over: Partial<EngineAudioInput> = {},
  s: EngineAudioSpec = spec,
): CueAction[] => stepEngineAudio(state, input(over), s, [])

const plays = (actions: readonly CueAction[]): CueId[] =>
  actions.filter((a) => a.kind === 'play').map((a) => a.cue)
const stops = (actions: readonly CueAction[]): CueId[] =>
  actions.filter((a) => a.kind === 'stop').map((a) => a.cue)

describe('the thresholds come off the shipped prefab, not the .cs', () => {
  it('uses 25 and 120, not the initialisers 5 and 32', () => {
    // CLAUDE.md hard rule 2. All four fields are `public` in Ship_HoverShip.cs,
    // so the initialisers 5 / 32 / 150 / 190 are hypotheses; the shipped values
    // are on PlayerShip_SR14_Photon.prefab:9349-9352, which is the prefab
    // int_01's Level.ShipPrefab actually instantiates.
    expect(spec.windSpeed).toBe(25)
    expect(spec.flightWindSpeed).toBe(120)
    expect(spec.windSpeed).toBe(HOVERJET.ship.minEffectsSpeed)
    expect(spec.flightWindSpeed).toBe(HOVERJET.ship.minBoostEffectsSpeed)
  })

  it('DOES carry 240 and 350, because they guard the branch that makes the sound', () => {
    // The survey's scoping caveat — "only 25 and 120 gate audio; 240 and 350
    // start ParticleSystems and make no MasterAudio call" — is true in its
    // second half and wrong in its conclusion. `Ship_HoverShip.cs:463` puts the
    // one audio call inside `< minBoostEffect_stage2_speed &&
    // !boostEffects.isPlaying`, so 240 is the CEILING of the band that plays
    // FlightWind, and crossing it downward is what re-arms the duck.
    expect(spec.stage2Speed).toBe(240)
    expect(spec.stage3Speed).toBe(350)
    expect(spec.stage2Speed).toBe(HOVERJET.ship.minBoostEffect_stage2_speed)
    expect(spec.stage3Speed).toBe(HOVERJET.ship.minBoostEffect_stage3_speed)
  })

  it('orders the four rungs the way the prefab does', () => {
    expect(spec.windSpeed).toBeLessThan(spec.flightWindSpeed)
    expect(spec.flightWindSpeed).toBeLessThan(spec.stage2Speed)
    expect(spec.stage2Speed).toBeLessThan(spec.stage3Speed)
  })

  it('carries the trigger thresholds from Input_Ship method bodies', () => {
    // Literals inside methods, not field initialisers — so the cardinal rule
    // does not apply and these ARE shipped behaviour. :407 and :435, and the
    // asymmetry between them is real.
    expect(spec.gasThreshold).toBe(0.05)
    expect(spec.boostReleaseThreshold).toBe(0.1)
    expect(spec.boostReleaseThreshold).toBeGreaterThan(spec.gasThreshold)
  })
})

describe('nothing sounds before the ship is released', () => {
  it('is silent at full throttle and 300 m/s while still on the lift', () => {
    const state = createEngineAudio()
    const actions = step(state, { released: false, throttle: 1, boost: true, speed: 300 })
    expect(actions).toEqual([])
    expect(state.idle).toBe(false)
    expect(state.thrust).toBe(false)
    expect(state.afterburner).toBe(false)
  })

  it('does not even start the wind, which has no release gate of its own', () => {
    // The wind layers key off speed alone in 2016 too, but a ship bolted to a
    // lift has no speed. The assertion is that nothing here reads a stale
    // speed and starts the layer in the hangar.
    const state = createEngineAudio()
    step(state, { released: false, speed: 0 })
    expect(state.aircraftWind).toBe(false)
  })
})

describe('the idle bed: once, at release, and never again', () => {
  it('starts on the first released tick', () => {
    const state = createEngineAudio()
    expect(plays(step(state, { released: true }))).toContain('engine.idle')
  })

  it('does not restart on any later tick', () => {
    // Ship_HoverShip.cs:167 is in Start(), which runs once. A bed re-emitted
    // every tick at 82 Hz would stack 82 voices a second even with the
    // backend's retrigger guard catching them.
    const state = createEngineAudio()
    step(state)
    for (let i = 0; i < 200; i++) {
      expect(plays(step(state, { speed: i })), `tick ${i}`).not.toContain('engine.idle')
    }
  })

  it('is never stopped by anything the machine does', () => {
    // A project-wide grep finds no StopAllOfSound / FadeOutAllOfSound naming
    // JumpSeat_Idle. The bed runs for the whole flight.
    const state = createEngineAudio()
    const seen: CueId[] = []
    for (const s of [0, 40, 150, 300, 150, 0, 0]) {
      seen.push(...stops(step(state, { speed: s, throttle: s > 0 ? 1 : 0 })))
    }
    expect(seen).not.toContain('engine.idle')
  })
})

describe('the throttle and boost edges are 2016 edges', () => {
  it('starts the thruster above 0.05 and not at it', () => {
    const state = createEngineAudio()
    step(state) // consume the idle
    expect(plays(step(state, { throttle: 0.05 }))).not.toContain('engine.thrust')
    expect(plays(step(state, { throttle: 0.051 }))).toContain('engine.thrust')
  })

  it('starts it once for a held throttle', () => {
    const state = createEngineAudio()
    step(state, { throttle: 1 })
    for (let i = 0; i < 50; i++) {
      expect(plays(step(state, { throttle: 1 }))).not.toContain('engine.thrust')
    }
  })

  it('releasing the throttle stops BOTH loops', () => {
    // Input_Ship.cs:599-600 — GasReleased stops Thrusters AND AfterBurner. The
    // asymmetry is real: BoostReleased (:644) stops only one.
    const state = createEngineAudio()
    step(state, { throttle: 1, boost: true })
    const actions = step(state, { throttle: 0, boost: true })
    expect(stops(actions)).toEqual(expect.arrayContaining(['engine.thrust', 'engine.afterburner']))
    expect(state.afterburner).toBe(false)
  })

  it('releasing boost alone stops only the afterburner', () => {
    const state = createEngineAudio()
    step(state, { throttle: 1, boost: true })
    const actions = step(state, { throttle: 1, boost: false })
    expect(stops(actions)).toEqual(['engine.afterburner'])
    expect(state.thrust).toBe(true)
  })

  it('will not burn without the throttle, because 2016 needs both triggers', () => {
    // Input_Ship.cs:426 `if (device.LeftTrigger && device.RightTrigger)`.
    const state = createEngineAudio()
    const actions = step(state, { throttle: 0, boost: true })
    expect(plays(actions)).not.toContain('engine.afterburner')
    expect(state.afterburner).toBe(false)
  })
})

describe('hysteresis is OURS, and it is symmetric', () => {
  it('computes the two edges around a threshold', () => {
    expect(gateOn(25, 0.02)).toBeCloseTo(25.5, 10)
    expect(gateOff(25, 0.02)).toBeCloseTo(24.5, 10)
    expect(gateOn(120, 0.02)).toBeCloseTo(122.4, 10)
    expect(gateOff(120, 0.02)).toBeCloseTo(117.6, 10)
  })

  it('does not fire inside the band', () => {
    // 2016 has NO hysteresis — `Ship_HoverShip.cs:443` is a bare
    // `if (ForwardSpeed > minEffectsSpeed)` every FixedUpdate, and what stops
    // that chattering is the sampled clip's own retrigger gate. A synthesized
    // loop has nothing to mask it. AUD-3.
    const state = createEngineAudio()
    step(state)
    for (const speed of [24.6, 25, 25.4]) {
      expect(plays(step(state, { speed })), `${speed} m/s`).not.toContain('wind.aircraft')
    }
    expect(plays(step(state, { speed: 25.6 }))).toContain('wind.aircraft')
  })

  it('does not chatter on a ship holding exactly the threshold', () => {
    // The failure mode the band exists for: at 82 Hz, a bare `>` would strobe
    // the layer eighty-two times a second.
    const state = createEngineAudio()
    step(state)
    let played = 0
    for (let i = 0; i < 500; i++) {
      // A ship sitting on 25.0 with a tick of numerical noise either way.
      const speed = 25 + (i % 2 === 0 ? 0.05 : -0.05)
      played += plays(step(state, { speed })).filter((c) => c === 'wind.aircraft').length
    }
    expect(played).toBe(0)
  })
})

describe('the two shipped wind bugs are KEPT', () => {
  it('never stops a wind layer once it has started', () => {
    // Ship_HoverShip.cs:457 and :497 are both commented out and nothing else in
    // the project stops either group. So once you have been past 120, the layer
    // is under the rest of the run — including at a standstill. Same class as
    // the no-auto-level and free-boost bugs Matt kept.
    const state = createEngineAudio()
    step(state, { speed: 200 })
    expect(state.aircraftWind).toBe(true)
    expect(state.flightWind).toBe(true)
    const actions = step(state, { speed: 0 })
    expect(stops(actions)).toEqual([])
    expect(state.aircraftWind).toBe(true)
    expect(state.flightWind).toBe(true)
  })

  it('turns the bug off with one flag, and then both layers follow the speed', () => {
    const fixed: EngineAudioSpec = { ...spec, windLoopsNeverStop: false }
    const state = createEngineAudio()
    step(state, { speed: 200 }, fixed)
    const actions = step(state, { speed: 0 }, fixed)
    expect(stops(actions)).toEqual(expect.arrayContaining(['wind.aircraft', 'wind.flight']))
    expect(state.aircraftWind).toBe(false)
    expect(state.flightWind).toBe(false)
  })

  it('ducks the aircraft wind on the 120 crossing and restores it next tick', () => {
    // Ship_HoverShip.cs:470 fades AircraftWind over 0.15 s on the crossing, and
    // :448 replays it the very next FixedUpdate — a dip, not a stop, and 2016's
    // own two-tick sequence.
    const state = createEngineAudio()
    step(state, { speed: 40 })
    const crossing = step(state, { speed: 130 })
    expect(plays(crossing)).toContain('wind.flight')
    expect(crossing).toContainEqual({
      kind: 'gain',
      cue: 'wind.aircraft',
      to: spec.aircraftWindDuckGain,
      seconds: 0.15,
    })
    expect(state.duckRecoveryPending).toBe(true)
    const next = step(state, { speed: 135 })
    expect(next).toContainEqual({
      kind: 'gain',
      cue: 'wind.aircraft',
      to: 1,
      seconds: 0.15,
    })
    expect(state.duckRecoveryPending).toBe(false)
  })

  it('skips FlightWind entirely on a jump straight past the stage-1 band', () => {
    // 0 -> 300 in one tick lands in stage 2, and `:463`'s guard is
    // `ForwardSpeed < minBoostEffect_stage2_speed` — so the branch with the
    // only audio call in the ladder never runs. No FlightWind and no duck.
    // Unreachable in flight (it needs a >240 m/s change in 12 ms) and exactly
    // reachable on a respawn, which is why it is pinned.
    const state = createEngineAudio()
    const actions = step(state, { speed: 300 })
    expect(plays(actions)).toContain('wind.aircraft')
    expect(plays(actions)).not.toContain('wind.flight')
    expect(actions.filter((a) => a.kind === 'gain')).toEqual([])
    expect(state.duckRecoveryPending).toBe(false)
    expect(state.stage2).toBe(true)
    expect(state.stage1).toBe(false)
  })

  it('re-ducks every time the ship drops out of stage 2 back into the band', () => {
    // The consequence of 240 being a ceiling. `:473` stops `boostEffects`, so
    // re-entering 120..240 passes `!boostEffects.isPlaying` again and `:469`
    // and `:470` both fire a second time. On int_01 the speed chain takes
    // terminal from 182 to 340 m/s over twenty-one gates, so this boundary is
    // crossed repeatedly in a good run.
    const state = createEngineAudio()
    step(state, { speed: 40 })
    step(state, { speed: 150 }) // stage 1: play + duck
    step(state, { speed: 160 }) // recovery
    step(state, { speed: 300 }) // stage 2 stops stage 1
    expect(state.stage1).toBe(false)
    const back = step(state, { speed: 150 })
    expect(state.stage1).toBe(true)
    expect(back).toContainEqual({
      kind: 'gain',
      cue: 'wind.aircraft',
      to: spec.aircraftWindDuckGain,
      seconds: spec.aircraftWindDuckSeconds,
    })
    // But FlightWind is NOT replayed: it never stopped, so the loop is already
    // running and the state has nothing to change.
    expect(plays(back)).not.toContain('wind.flight')
  })

  it('does not re-duck coming down from stage 3, because :481 leaves stage 1 alone', () => {
    // The asymmetry transcribed rather than tidied: `:481` stops stage 2 and
    // pointedly does not stop `boostEffects`. A ship that reaches stage 1 and
    // jumps straight to stage 3 returns with the guard still false.
    const state = createEngineAudio()
    step(state, { speed: 150 }) // stage 1
    step(state, { speed: 160 }) // recovery
    step(state, { speed: 400 }) // stage 3 -- stage 1 was never stopped
    expect(state.stage1).toBe(true)
    const back = step(state, { speed: 150 })
    expect(back.filter((a) => a.kind === 'gain')).toEqual([])
  })

  it('does not chatter at 240 either', () => {
    const state = createEngineAudio()
    step(state, { speed: 150 })
    step(state, { speed: 160 })
    let ducks = 0
    for (let i = 0; i < 400; i++) {
      const speed = 240 + (i % 2 === 0 ? 1 : -1)
      ducks += step(state, { speed }).filter((a) => a.kind === 'gain').length
    }
    expect(ducks).toBe(0)
  })
})

describe('the machine cannot get stuck', () => {
  it('never leaves a duck pending across an arbitrary walk', () => {
    // A pending recovery that never fires leaves the wind permanently 12 dB
    // down with nothing in the state to say why — exactly the shape of bug
    // that survives four sessions.
    const state = createEngineAudio()
    let seed = 1234567
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let i = 0; i < 5000; i++) {
      const actions = step(state, {
        speed: rnd() * 400,
        throttle: rnd(),
        boost: rnd() > 0.5,
        released: rnd() > 0.02,
      })
      // At most one duck action per tick, ever.
      expect(actions.filter((a) => a.kind === 'gain').length).toBeLessThanOrEqual(1)
    }
    // Two quiet ticks and the flag must be down.
    step(state, { speed: 200 })
    step(state, { speed: 200 })
    expect(state.duckRecoveryPending).toBe(false)
  })

  it('keeps play and stop strictly alternating for every loop', () => {
    // The invariant that makes a leak impossible: a loop can never be started
    // twice without a stop in between, or stopped twice without a start. A
    // violation is a stacked voice or a ramp on a dead node.
    const state = createEngineAudio()
    const on = new Set<CueId>()
    let seed = 99
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const fixed: EngineAudioSpec = { ...spec, windLoopsNeverStop: false }
    for (let i = 0; i < 5000; i++) {
      const actions = step(
        state,
        { speed: rnd() * 400, throttle: rnd(), boost: rnd() > 0.5, released: true },
        fixed,
      )
      for (const action of actions) {
        if (action.kind === 'play') {
          expect(on.has(action.cue), `double start of ${action.cue} at ${i}`).toBe(false)
          on.add(action.cue)
        } else if (action.kind === 'stop') {
          expect(on.has(action.cue), `double stop of ${action.cue} at ${i}`).toBe(true)
          on.delete(action.cue)
        } else {
          // A gain ramp on a cue that is not running is a ramp on a dead node.
          expect(on.has(action.cue), `ramp on idle ${action.cue} at ${i}`).toBe(true)
        }
      }
    }
  })

  it('resets to exactly a fresh state', () => {
    const state = createEngineAudio()
    step(state, { speed: 300, throttle: 1, boost: true })
    resetEngineAudio(state)
    expect(state).toEqual(createEngineAudio())
  })

  it('replays every loop after a reset, so a restart is not silent', () => {
    const state = createEngineAudio()
    step(state, { speed: 150, throttle: 1, boost: true })
    resetEngineAudio(state)
    const again = plays(step(state, { speed: 150, throttle: 1, boost: true }))
    expect(again).toEqual(
      expect.arrayContaining([
        'engine.idle',
        'engine.thrust',
        'engine.afterburner',
        'wind.aircraft',
        'wind.flight',
      ]),
    )
  })

  it('lists every loop it can leave running', () => {
    // ENGINE_LOOPS is written out rather than derived, because "stop everything"
    // has to be right even when the state is lying — which, after a
    // windLoopsNeverStop run followed by an exit, it structurally is.
    const state = createEngineAudio()
    step(state, { speed: 150, throttle: 1, boost: true })
    for (const flag of ['idle', 'thrust', 'afterburner', 'aircraftWind', 'flightWind'] as const) {
      expect(state[flag], flag).toBe(true)
    }
    // Five the Classic ladder can leave running, plus DEV-137's two — which
    // Classic never starts (`rumble` is null on the shipped spec) but which the
    // teardown must still name, because "stop everything" is read off this list
    // and not off the state. `audio-engine-sound.test.ts` covers the two.
    expect(state.rumble).toBe(false)
    expect(state.growl).toBe(false)
    expect(new Set(ENGINE_LOOPS)).toEqual(
      new Set([
        'engine.idle',
        'engine.thrust',
        'engine.afterburner',
        'wind.aircraft',
        'wind.flight',
        'engine.rumble',
        'engine.growl',
      ]),
    )
  })
})

describe('trap 19: no shared scratch between two machines', () => {
  it('stepping a SECOND state does not move the first', () => {
    // The guard CLAUDE.md names by name. With one object there is nobody to
    // inherit from, which is why every single-object test above would pass with
    // a module-level scratch state in place.
    const a = createEngineAudio()
    const b = createEngineAudio()
    step(a, { speed: 300, throttle: 1, boost: true })
    const before = { ...a }
    for (let i = 0; i < 20; i++) {
      step(b, { speed: i * 10, throttle: i % 2, boost: i % 3 === 0 })
    }
    expect(a).toEqual(before)
    // And the other way: the second machine reached its own conclusions rather
    // than inheriting the first's.
    expect(b.afterburner).not.toBe(a.afterburner)
  })

  it('writes into the array it is given and returns that array', () => {
    const state = createEngineAudio()
    const out: CueAction[] = []
    const returned = stepEngineAudio(state, input({ throttle: 1 }), spec, out)
    expect(returned).toBe(out)
    expect(out.length).toBeGreaterThan(0)
  })

  it('does not accumulate across two calls sharing one buffer', () => {
    // A caller that forgets to truncate would replay the previous tick's
    // actions. The machine must not do the truncation for it — that is the
    // caller's buffer — but it must not make the situation worse by holding a
    // reference to it either.
    const state = createEngineAudio()
    const out: CueAction[] = []
    stepEngineAudio(state, input({ throttle: 1 }), spec, out)
    const afterFirst = out.length
    stepEngineAudio(state, input({ throttle: 1 }), spec, out)
    expect(out.length).toBe(afterFirst)
  })
})
