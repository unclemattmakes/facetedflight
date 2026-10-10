// tests/unit/audio-system.test.ts — the orchestrator, against a fake backend.
//
// `backend.ts` exists so this file can exist: the unit suite runs in node with
// no `AudioContext` (D7), and everything that can be wrong about the audio port
// is on the near side of that interface. So a whole run — title, hangar, lift,
// 3-2-1-GO, twenty-one gates, the finish, the medal, the exit — is a transcript
// of calls, and "a finished run leaves no loop running" is two lines instead of
// a headed browser and a spectrogram.

import { describe, expect, it } from 'vitest'
import { createAudioSystem } from '@/audio'
import { createRecordingBackend, createSilentBackend, type RecordingBackend } from '@/audio/backend'
import { CUES, type CueId } from '@/audio/cues'
import { SHIPPED_ENGINE_AUDIO } from '@/audio/engine'

/** A deterministic [0,1) source, so variation choice is assertable. */
const fixedRandom =
  (value = 0.5): (() => number) =>
  () =>
    value

const build = (): { system: ReturnType<typeof createAudioSystem>; backend: RecordingBackend } => {
  const backend = createRecordingBackend()
  const system = createAudioSystem({ backend, random: fixedRandom() })
  return { system, backend }
}

const playedIds = (backend: RecordingBackend): CueId[] =>
  backend.calls.filter((c) => c.call === 'play').map((c) => c.id)

describe('it makes no AudioContext until asked', () => {
  it('constructs with no backend at all and never throws', () => {
    // Node has no `AudioContext`, so the default backend falls through to
    // silence. Silence is a valid output: the game must not care whether it has
    // sound, and it must certainly not crash in a headless test because of it.
    const system = createAudioSystem()
    expect(system.running).toBe(false)
    expect(() => system.event({ type: 'ui.confirm' })).not.toThrow()
    expect(() =>
      system.stepFlight({ speed: 300, throttle: 1, boost: true, released: true }),
    ).not.toThrow()
    system.dispose()
  })

  it('survives every call made against an explicitly silent backend', () => {
    const system = createAudioSystem({ backend: createSilentBackend() })
    system.setMasterGain(0.4)
    system.setMusicGain(0.2)
    system.event({ type: 'gate.passed', index: 0 })
    system.stopAll()
    system.dispose()
    expect(system.running).toBe(false)
  })

  it('reports running only after resume', async () => {
    const { system, backend } = build()
    expect(system.running).toBe(false)
    await system.resume()
    expect(system.running).toBe(true)
    // Idempotent: this is called on every user gesture forever, and a
    // suspended context (a tab that lost focus) has to be recoverable.
    await system.resume()
    await system.resume()
    expect(backend.running).toBe(true)
  })
})

describe('a whole run, as a transcript', () => {
  it('walks title -> hangar -> lift -> GO -> gates -> finish -> exit', async () => {
    const { system, backend } = build()
    await system.resume()

    // Title: the nose pointer crosses the prompt, then A.
    system.event({ type: 'ui.focus' })
    system.event({ type: 'ui.confirm' })
    // The hangar: the pointer finds the holotable, then A boards.
    system.event({ type: 'ui.focus' })
    system.event({ type: 'ui.confirm' })
    system.event({ type: 'mission.begin' })
    // The lift.
    system.event({ type: 'launch.start' })
    system.event({ type: 'launch.topped' })
    // 3-2-1-GO. countdownTime 3 / delayBetweenCountdown 1 in int_01.
    for (const n of [3, 2, 1]) system.event({ type: 'countdown.beat', n })
    system.event({ type: 'countdown.go' })

    expect(playedIds(backend)).toEqual([
      'ui.hover',
      'ui.confirm',
      'ui.hover',
      'ui.confirm',
      'ambient.island',
      'ambient.water',
      'elevator.start',
      'elevator.loop',
      'countdown.beat',
      'countdown.beat',
      'countdown.beat',
      'countdown.go',
    ])
    // The lift loop was stopped over 2016's own 1.7 s.
    expect(backend.calls).toContainEqual({
      call: 'stop',
      id: 'elevator.loop',
      fadeSeconds: 1.7,
    })

    // Fly. Twenty-one gates is the liveness-walked count for int_01.
    backend.clear()
    system.stepFlight({ speed: 0, throttle: 0, boost: false, released: true })
    system.stepFlight({ speed: 60, throttle: 1, boost: false, released: true })
    system.stepFlight({ speed: 200, throttle: 1, boost: true, released: true })
    for (let i = 0; i < 21; i++) system.event({ type: 'gate.passed', index: i })
    system.event({ type: 'run.finish' })
    system.event({ type: 'run.medal', medal: 'gold' })

    const played = playedIds(backend)
    expect(played.filter((id) => id === 'ring.pass')).toHaveLength(21)
    expect(played.filter((id) => id === 'ring.boost')).toHaveLength(21)
    expect(played).toContain('engine.idle')
    expect(played).toContain('engine.thrust')
    expect(played).toContain('engine.afterburner')
    expect(played).toContain('wind.aircraft')
    expect(played).toContain('wind.flight')
    expect(played).toContain('run.finish')
    // DEV-644: a gold medal has its own phrase, not 2016's one cue.
    expect(played).toContain('medal.gold')

    // Exit to the chair. Nothing may be left sounding.
    system.event({ type: 'mission.end' })
    expect(backend.sounding).toEqual([])
  })

  it('leaves no loop running after stopAll, and restarts cleanly', () => {
    const { system, backend } = build()
    system.stepFlight({ speed: 150, throttle: 1, boost: true, released: true })
    expect(backend.sounding.length).toBeGreaterThan(0)
    system.stopAll()
    expect(backend.sounding).toEqual([])
    // And the engine state went with it, so the next run is not silent because
    // the machine still believes the loops are up.
    backend.clear()
    system.stepFlight({ speed: 150, throttle: 1, boost: true, released: true })
    expect(playedIds(backend)).toEqual(
      expect.arrayContaining([
        'engine.idle',
        'engine.thrust',
        'engine.afterburner',
        'wind.aircraft',
        'wind.flight',
      ]),
    )
  })

  it('mission.end tears down the engine loops the KEPT bug would otherwise strand', () => {
    // `windLoopsNeverStop` means the wind never comes down on its own — that is
    // 2016's behaviour and it is deliberate. So the exit has to be the thing
    // that stops it, or a player who flies fast once hears wind in the hangar
    // for the rest of the session.
    const { system, backend } = build()
    system.stepFlight({ speed: 150, throttle: 1, boost: true, released: true })
    system.stepFlight({ speed: 0, throttle: 0, boost: false, released: true })
    expect(backend.sounding).toContain('wind.flight')
    system.event({ type: 'mission.end' })
    expect(backend.sounding).toEqual([])
  })
})

describe('the retrigger rule is 2016 retrigger rule', () => {
  it('will not stack a loop that is already sounding', () => {
    // retriggerPercentage 100 on Thrusters / JumpSeat_Idle / whoosh, applied to
    // every loop: holding the throttle at 82 Hz must not allocate 82 voices a
    // second. Belt and braces — `stepEngineAudio` already edge-detects, and
    // this is the guard for a caller that fires `play` directly.
    const { system, backend } = build()
    system.event({ type: 'mission.begin' })
    const first = playedIds(backend).length
    system.event({ type: 'mission.begin' })
    system.event({ type: 'mission.begin' })
    expect(playedIds(backend).length).toBe(first)
    expect(CUES['ambient.island'].retrigger).toBe('ignore')
  })

  it('lets a one-shot fire as often as it likes', () => {
    const { system, backend } = build()
    for (let i = 0; i < 50; i++) system.event({ type: 'ui.confirm' })
    expect(playedIds(backend).filter((id) => id === 'ui.confirm')).toHaveLength(50)
  })
})

describe('gains, positions and the parts that are deliberately absent', () => {
  it('plays every cue at its catalogue gain', () => {
    const { system, backend } = build()
    system.event({ type: 'gate.passed', index: 0 })
    const ring = backend.calls.find((c) => c.call === 'play' && c.id === 'ring.pass')
    expect(ring).toBeDefined()
    if (ring?.call === 'play') expect(ring.gain).toBeCloseTo(CUES['ring.pass'].gain, 12)
  })

  it('clamps a master gain to [0, 1]', () => {
    const { system, backend } = build()
    system.setMasterGain(4)
    system.setMasterGain(-2)
    expect(backend.calls.filter((c) => c.call === 'master').map((c) => c.gain)).toEqual([1, 0])
  })

  it('is deterministic given a deterministic random source', () => {
    // Same seed, same variation, same pitch. Without this the six ring
    // variations are unassertable and so is every later regression on them.
    const a = createRecordingBackend()
    const b = createRecordingBackend()
    createAudioSystem({ backend: a, random: fixedRandom(0.3) }).event({
      type: 'gate.passed',
      index: 0,
    })
    createAudioSystem({ backend: b, random: fixedRandom(0.3) }).event({
      type: 'gate.passed',
      index: 0,
    })
    expect(a.calls).toEqual(b.calls)
  })

  it('ships no music, and says so rather than pretending', () => {
    // The soundtrack is the one part of the audio port that is not
    // first-party-by-construction, so it is a licensing act and not a commit.
    // D13: six Cozendey CC-BY 3.0 tracks, attribution as a shipping condition.
    const { system } = build()
    expect(system.music.tracks).toEqual([])
    expect(system.music.crossfadeSeconds).toBe(2)
    system.music.start('go')
    expect(system.music.playing).toBeNull()
  })

  it('renders every cue 2D, which is what 2016 does', () => {
    // MasterAudio.cs:1689-1695 emits a non-positional cue from the bank's own
    // transform, and PlayerShipInitialization.cs:34-37 parents that bank to the
    // camera rig at local origin — so every PlaySound in the shipped game plays
    // at the listener, unattenuated, despite all 33 groups being ForceTo3D.
    const positions: unknown[] = []
    const system = createAudioSystem({
      backend: {
        ...createSilentBackend(),
        play(_spec, options) {
          positions.push(options.position)
        },
      },
      random: fixedRandom(),
    })
    system.event({ type: 'gate.passed', index: 0 })
    system.event({ type: 'run.medal', medal: 'gold' })
    expect(positions.length).toBeGreaterThan(0)
    expect(positions.every((p) => p === null)).toBe(true)
  })

  it('uses the shipped engine spec unless told otherwise', () => {
    const { system, backend } = build()
    // 25 is the shipped minEffectsSpeed. Just under the hysteresis band, so
    // the default spec must stay quiet; a spec with the .cs initialiser 5 would
    // have started the layer a long way back.
    system.stepFlight({ speed: 25.2, throttle: 0, boost: false, released: true })
    expect(playedIds(backend)).not.toContain('wind.aircraft')
    expect(SHIPPED_ENGINE_AUDIO.windSpeed).toBe(25)
  })
})
