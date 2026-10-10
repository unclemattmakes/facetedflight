// tests/unit/audio-spatial.test.ts — AUD-5: the two cues that earn a position.
//
// ── What can actually be tested here, and what cannot ─────────────────────
//
// Node has no `AudioContext` (D7), so a `PannerNode` never exists in this file
// and nothing here hears anything. What IS testable is the half that goes
// wrong silently:
//
//   - the GEOMETRY — where an emitter ends up relative to the head, in a frame
//     whose handedness two people will read two ways;
//   - the GRAPH SHAPE — that an emitter is created once, follows its object,
//     and is torn down when that object's run ends;
//   - the CURVE — that `spatial.ts`'s pure rolloff really is the function a
//     `PannerNode` computes, rather than a comment claiming it is.
//
// That split is the same bargain `backend.ts` exists to make. A bug in the
// oscillator plumbing is audible in one second in a headset; a leaked panner
// following a racer that finished four minutes ago is not, and neither is a
// listener quietly stuck at the world origin.
//
// ── The two lessons this file is shaped by ────────────────────────────────
//
// **The orientation lesson.** *Test the geometry, not the rotation.* A distance
// and a signed offset are true independently of what anybody believed about the
// handedness; an assertion on a quaternion or on "forward is −z" is the belief
// written twice. So every geometric assertion below is a metre or a sign that a
// person in the headset could confirm: *the racer on my left is on my left.*
//
// **Trap 19.** `ai-racer.ts` shared one module-level `HoverJetInput` across
// every racer and a finished racer flew on with the other racer's stick, frozen,
// until it went into the sea — invisible to every single-object test, because
// with one racer there is nobody to inherit from. The guard is
// *"step a SECOND one and assert the first did not move"*, and it is run here
// against the emitter handles.

import { describe, expect, it } from 'vitest'
import { createAudioSystem } from '@/audio'
import {
  type BackendCall,
  createRecordingBackend,
  createSilentBackend,
  type RecordingBackend,
} from '@/audio/backend'
import { CUES } from '@/audio/cues'
import { dbToGain, NPC_MIXER_GAMEPLAY_DB, NPC_MIXER_PRELAUNCH_DB } from '@/audio/mix'
import {
  createRacerEngines,
  NPC_RAMP_SECONDS,
  PRELAUNCH_GAIN,
  RACER_ENGINE_BUDGET,
  RACER_STOP_SECONDS,
  type RacerAudioInput,
} from '@/audio/racer-engines'
import {
  DEFAULT_LISTENER,
  distanceToListener,
  dopplerRatio,
  type ListenerPose,
  ratioToCents,
  SPEED_OF_SOUND,
  type SpatialSpec,
  toListenerSpace,
  unityLogRolloff,
  type Vec3Tuple,
} from '@/audio/spatial'

/** Facing −z with +y up: the identity pose, and three's camera convention. */
const at = (position: Vec3Tuple): ListenerPose => ({ ...DEFAULT_LISTENER, position })

/** Facing +x — a quarter turn to the player's right from the identity pose. */
const facingEastAt = (position: Vec3Tuple): ListenerPose => ({
  position,
  forward: [1, 0, 0],
  up: [0, 1, 0],
})

const emitterCalls = (backend: RecordingBackend): BackendCall[] =>
  backend.calls.filter(
    (c) =>
      c.call === 'emit' ||
      c.call === 'move' ||
      c.call === 'emitStop' ||
      c.call === 'emitGain' ||
      c.call === 'detune',
  )

const racer = (id: string, position: Vec3Tuple, finished = false): RacerAudioInput => ({
  id,
  position,
  // Standing still. DEV-137's speed-tracking pitch is off in every test here
  // and asserted in `audio-engine-sound.test.ts`; this file is about the
  // geometry and the Doppler, which a speed of zero leaves alone.
  speed: 0,
  finished,
})

// ─────────────────────────────────────────────────────────────────────────
describe('the frame: a point in the world, as the ears hear it', () => {
  it('puts a point dead ahead on −z, and one behind on +z', () => {
    // WebAudio's listener looks down −z, which is also where three's camera
    // looks. Nothing is being converted; this pins the convention so a later
    // "fix" that flips it has to delete a test that says what a player hears.
    expect(toListenerSpace(DEFAULT_LISTENER, [0, 0, -30])).toEqual([0, 0, -30])
    expect(toListenerSpace(DEFAULT_LISTENER, [0, 0, 30])).toEqual([0, 0, 30])
  })

  it('puts a racer 30 m to the LEFT at x = −30', () => {
    const [x, y, z] = toListenerSpace(DEFAULT_LISTENER, [-30, 0, 0])
    expect(x).toBe(-30)
    expect(y).toBeCloseTo(0, 12)
    // `toBeCloseTo`, not `toBe`: the z term is `-dot(d, f)`, and negating a
    // zero gives -0, which `Object.is` says is not 0. A sign on a zero is not
    // a fact about the geometry.
    expect(z).toBeCloseTo(0, 12)
  })

  it('is relative to where the head IS, not to the origin', () => {
    // The bug this catches is CLAUDE.md trap 18 one layer up: feeding
    // `camera.position` (the lean offset inside the XR rig) instead of
    // `getWorldPosition()`. With the head at 2 km out and 120 m up, an emitter
    // 10 m in front of it must read 10 m in front of it.
    const head = at([-857, 120, 2082])
    const [x, y, z] = toListenerSpace(head, [-857, 120, 2072])
    expect(x).toBeCloseTo(0, 9)
    expect(y).toBeCloseTo(0, 9)
    expect(z).toBeCloseTo(-10, 9)
  })

  it('rotates with the head: turn right and what was ahead is on your left', () => {
    // Geometry, not a quaternion. Stand at the origin, put a jet 50 m down −z
    // (dead ahead), then face +x. The jet must now be 50 m to the LEFT.
    const ahead: Vec3Tuple = [0, 0, -50]
    expect(toListenerSpace(DEFAULT_LISTENER, ahead)[2]).toBeCloseTo(-50, 9)
    const [x, y, z] = toListenerSpace(facingEastAt([0, 0, 0]), ahead)
    expect(x).toBeCloseTo(-50, 9)
    expect(y).toBeCloseTo(0, 9)
    expect(z).toBeCloseTo(0, 9)
  })

  it('keeps the distance whatever the head is doing', () => {
    // The one quantity that must be invariant under every rotation above — and
    // the one the rolloff actually reads.
    const world: Vec3Tuple = [30, -40, 0]
    for (const pose of [DEFAULT_LISTENER, facingEastAt([0, 0, 0])]) {
      const rel = toListenerSpace(pose, world)
      expect(Math.hypot(rel[0], rel[1], rel[2])).toBeCloseTo(50, 9)
      expect(distanceToListener(pose, world)).toBeCloseTo(50, 9)
    }
  })

  it('survives a non-unit forward vector, because a caller will hand one in', () => {
    const sloppy: ListenerPose = { position: [0, 0, 0], forward: [0, 0, -7], up: [0, 3, 0] }
    const [x, y, z] = toListenerSpace(sloppy, [0, 0, -10])
    expect(x).toBeCloseTo(0, 9)
    expect(y).toBeCloseTo(0, 9)
    expect(z).toBeCloseTo(-10, 9)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('the rolloff really is the curve a PannerNode computes', () => {
  // `webaudio.ts` sets distanceModel 'inverse', rolloffFactor 1, refDistance
  // MinDistance, maxDistance MaxDistance, and claims that is Unity's
  // `rolloffMode: 0`. A structural claim with one source is a hypothesis
  // (PORT_PLAN §4.7), so the spec's own formula is written out here
  // independently and the two are compared — rather than one of them being
  // asserted against itself.
  const webAudioInverse = (distance: number, s: SpatialSpec): number => {
    const ref = s.refDistance
    const clamped = Math.min(Math.max(distance, ref), s.maxDistance)
    return ref / (ref + 1 * (Math.max(clamped, ref) - ref))
  }

  const both = (s: SpatialSpec, d: number): [number, number] => [
    unityLogRolloff(d, s),
    webAudioInverse(d, s),
  ]

  it('agrees with the spec formula across the whooshs whole range', () => {
    const s = CUES['shaft.whoosh'].spatial as SpatialSpec
    for (const d of [0, 1, 9.99, 10, 10.01, 25, 100, 499, 500, 501, 5000]) {
      const [ours, spec] = both(s, d)
      expect(ours, `d=${d}`).toBeCloseTo(spec, 12)
    }
  })

  it('agrees across the racer engines whole range', () => {
    const s = CUES['racer.engine'].spatial as SpatialSpec
    for (const d of [0, 47, 48, 49, 200, 799, 800, 801, 10000]) {
      const [ours, spec] = both(s, d)
      expect(ours, `d=${d}`).toBeCloseTo(spec, 12)
    }
  })

  it('is flat inside MinDistance and never reaches zero', () => {
    // Unity's logarithmic curve does not go silent at MaxDistance; it STOPS
    // ATTENUATING there. A port that faded to nothing would make the 800 m
    // horizon a wall rather than a fade, which is a different game.
    const s = CUES['racer.engine'].spatial as SpatialSpec
    expect(unityLogRolloff(0, s)).toBe(1)
    expect(unityLogRolloff(47.9, s)).toBe(1)
    expect(unityLogRolloff(96, s)).toBeCloseTo(0.5, 12)
    expect(unityLogRolloff(9999, s)).toBeCloseTo(48 / 800, 12)
    expect(unityLogRolloff(9999, s)).toBeGreaterThan(0)
  })

  it('carries 2016s four numbers unchanged', () => {
    // MinDistance/MaxDistance off the prefab and the scene. If a mix pass ever
    // wants to move these, it should have to say so here.
    expect(CUES['shaft.whoosh'].spatial).toEqual({
      refDistance: 10,
      maxDistance: 500,
      doppler: 1,
    })
    expect(CUES['racer.engine'].spatial).toEqual({
      refDistance: 48,
      maxDistance: 800,
      doppler: 1.04,
    })
  })

  it('leaves every other cue 2D, which is what 2016 does', () => {
    // The rule, and it is measured: `MasterAudio.cs`'s non-positional branch
    // emits from the bank transform and `PlayerShipInitialization.cs:34-37`
    // parents the bank to the rig at local origin. Exactly two cues take the
    // other branch IN 2016. A third appearing silently is a deviation nobody
    // filed: `terrain.whoosh` is FF2's (DEV-642, a near miss whooshes from the
    // side the terrain was on) and `flyby.whoosh` is FF2's (DEV-641, a ship going
    // by, positional on the racer engines' distance model). Both are filed, so
    // they are named here as FF2 additions rather than as ports.
    const positional = Object.values(CUES)
      .filter((c) => c.spatial !== null)
      .map((c) => c.id)
      .sort()
    expect(positional).toEqual(['flyby.whoosh', 'racer.engine', 'shaft.whoosh', 'terrain.whoosh'])
    // And the flyby borrows the racers' reach, not a number of its own.
    const { refDistance, maxDistance } = CUES['racer.engine'].spatial as {
      refDistance: number
      maxDistance: number
    }
    expect(CUES['flyby.whoosh'].spatial).toMatchObject({ refDistance, maxDistance })
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('Doppler: linearised on purpose, and it says so', () => {
  it('raises the pitch when the gap is closing and lowers it when it opens', () => {
    expect(dopplerRatio(100, 1.04)).toBeGreaterThan(1)
    expect(dopplerRatio(-100, 1.04)).toBeLessThan(1)
    expect(dopplerRatio(0, 1.04)).toBe(1)
  })

  it('is 2016 1.04 over the engine speed of sound, to first order', () => {
    // The number this is the ratio OF: DopplerLevel 1.04 (x AudioManager.asset's
    // `Doppler Factor: 1`) times a closing speed, over Unity's 343 m/s.
    expect(dopplerRatio(50, 1.04)).toBeCloseTo(1 + (1.04 * 50) / SPEED_OF_SOUND, 12)
  })

  it('does not explode at the speeds this game reaches', () => {
    // The exact `c / (c - v)` form is singular at v = c, and `int_01`'s speed
    // chain takes terminal to 340 m/s — so two racers closing head-on can sit
    // on that singularity. The linearised form must stay finite and bounded.
    for (const closing of [300, 680, 5000, -5000, Number.POSITIVE_INFINITY]) {
      const ratio = dopplerRatio(closing, 1.04)
      expect(Number.isFinite(ratio), `closing=${closing}`).toBe(true)
      expect(ratio).toBeGreaterThanOrEqual(0.5)
      expect(ratio).toBeLessThanOrEqual(2)
    }
    expect(dopplerRatio(Number.NaN, 1.04)).toBe(1)
  })

  it('is off entirely at DopplerLevel 0', () => {
    expect(dopplerRatio(200, 0)).toBe(1)
  })

  it('converts a ratio to cents the way an oscillator detune wants', () => {
    expect(ratioToCents(1)).toBe(0)
    expect(ratioToCents(2)).toBeCloseTo(1200, 9)
    expect(ratioToCents(0.5)).toBeCloseTo(-1200, 9)
    expect(ratioToCents(0)).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('the shaft whoosh is emitted from a POINT, not at the listener', () => {
  const build = (): { system: ReturnType<typeof createAudioSystem>; backend: RecordingBackend } => {
    const backend = createRecordingBackend()
    return { system: createAudioSystem({ backend, random: () => 0.5 }), backend }
  }

  it('carries the collars world position all the way to the backend', () => {
    const { system, backend } = build()
    system.event({ type: 'shaft.pass', at: [-857, 40, 2082] })
    const plays = backend.calls.filter((c) => c.call === 'play')
    expect(plays).toHaveLength(1)
    expect(plays[0]).toMatchObject({ id: 'shaft.whoosh', at: [-857, 40, 2082] })
  })

  it('leaves every other cue with a null position', () => {
    // The regression this guards is the opposite of the bug AUD-5 fixes: a
    // later change that makes everything positional would put the ring ding
    // out in the world, and a ring ding 200 m behind you is inaudible.
    const { system, backend } = build()
    system.event({ type: 'gate.passed', index: 3 })
    system.event({ type: 'launch.start' })
    system.event({ type: 'countdown.go' })
    for (const call of backend.calls.filter((c) => c.call === 'play')) {
      expect(call.at, call.id).toBeNull()
    }
  })

  it('is a ladder: eight collars, eight whooshes, each from its own height', () => {
    // 2016's eight `Trigger_PlaySound` boxes are 12 m apart up the shaft, which
    // is the level schema's own `segmentSpacing` x `segmentsAuthored`. The cue
    // is a one-shot, so each pass is its own play — and the heights must differ,
    // because a ladder of eight identical positions is a 2D sound wearing a
    // position.
    const { system, backend } = build()
    for (let i = 0; i < 8; i++) system.event({ type: 'shaft.pass', at: [0, 12 * i, 0] })
    const ys = backend.calls.filter((c) => c.call === 'play').map((c) => (c.at as Vec3Tuple)[1])
    expect(ys).toEqual([0, 12, 24, 36, 48, 60, 72, 84])
  })

  it('sweeps DOWN past a rising player, which is the whole point of the cue', () => {
    // The collar is fixed and the lift rises through it. So the same emitter
    // that was level with the head is below it a second later — read here as a
    // sign flip on the listener-space y, which is what an ear reports as
    // "it went past me".
    const collar: Vec3Tuple = [0, 40, 0]
    expect(toListenerSpace(at([0, 38, 0]), collar)[1]).toBeGreaterThan(0)
    expect(toListenerSpace(at([0, 40, 0]), collar)[1]).toBeCloseTo(0, 9)
    expect(toListenerSpace(at([0, 46, 0]), collar)[1]).toBeLessThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('the racers engines: one node each, and nobody else touches it', () => {
  const build = (): {
    engines: ReturnType<typeof createRacerEngines>
    backend: RecordingBackend
  } => {
    const backend = createRecordingBackend()
    return { engines: createRacerEngines(backend), backend }
  }

  it('starts exactly one emitter per racer, at that racers position', () => {
    const { engines, backend } = build()
    engines.sync(
      [racer('fast', [10, 0, 0]), racer('steady', [-10, 0, 0])],
      DEFAULT_LISTENER,
      1 / 90,
    )
    expect(engines.count).toBe(2)
    expect(engines.ids).toEqual(['fast', 'steady'])
    const emits = backend.calls.filter((c) => c.call === 'emit')
    expect(emits).toHaveLength(2)
    expect(emits.map((c) => c.at)).toEqual([
      [10, 0, 0],
      [-10, 0, 0],
    ])
    expect(backend.emitters.map((e) => e.cue)).toEqual(['racer.engine', 'racer.engine'])
  })

  it('does not start a second one for a racer it already has', () => {
    const { engines, backend } = build()
    for (let i = 0; i < 10; i++) {
      engines.sync([racer('fast', [i, 0, 0])], DEFAULT_LISTENER, 1 / 90)
    }
    expect(backend.calls.filter((c) => c.call === 'emit')).toHaveLength(1)
    expect(engines.count).toBe(1)
  })

  it('follows its racer, frame by frame', () => {
    const { engines, backend } = build()
    for (const x of [0, 50, 120])
      engines.sync([racer('fast', [x, 5, -3])], DEFAULT_LISTENER, 1 / 90)
    const moves = backend.calls.filter((c) => c.call === 'move')
    expect(moves.map((c) => c.to)).toEqual([
      [50, 5, -3],
      [120, 5, -3],
    ])
    expect(backend.emitters[0]?.at).toEqual([120, 5, -3])
  })

  // ── TRAP 19, run as a test rather than promised in a comment ──────────
  it('starting a SECOND racer does not move the first', () => {
    // The literal guard from CLAUDE.md: `ai-racer.ts` shared one scratch input
    // across every racer and a finished racer flew on with the other racer's
    // stick. With one racer there is nobody to inherit from, so the bug is
    // invisible — which is why this test exists in the two-racer shape.
    const { engines, backend } = build()
    engines.sync([racer('fast', [100, 10, 0])], DEFAULT_LISTENER, 1 / 90)
    const firstHandle = backend.emitters[0]?.handle
    engines.sync(
      [racer('fast', [100, 10, 0]), racer('steady', [-900, 300, 42])],
      DEFAULT_LISTENER,
      1 / 90,
    )
    const first = backend.emitters.find((e) => e.handle === firstHandle)
    expect(first?.at).toEqual([100, 10, 0])
    // ...and the second is where IT is, not where the first is.
    const second = backend.emitters.find((e) => e.handle !== firstHandle)
    expect(second?.at).toEqual([-900, 300, 42])
  })

  it('gives the two racers DIFFERENT Doppler shifts, not one shared one', () => {
    // Same shape again, on the other per-racer quantity: `lastDistance` lives
    // on the racer's own record. One closing fast, one opening, from the same
    // frame — a shared scratch would give them the same sign.
    const { engines, backend } = build()
    const ears = DEFAULT_LISTENER
    engines.sync([racer('fast', [0, 0, -400]), racer('steady', [0, 0, -100])], ears, 1 / 90)
    engines.sync([racer('fast', [0, 0, -300]), racer('steady', [0, 0, -200])], ears, 1)
    const detunes = backend.calls.filter((c) => c.call === 'detune')
    expect(detunes).toHaveLength(2)
    // `fast` closed 100 m in a second -> pitch up. `steady` opened 100 m -> down.
    expect(detunes[0]?.cents).toBeGreaterThan(0)
    expect(detunes[1]?.cents).toBeLessThan(0)
    expect(detunes[0]?.cents).toBeCloseTo(ratioToCents(dopplerRatio(100, 1.04)), 9)
  })

  it('does not invent a Doppler shift on a racers first frame', () => {
    // One position sample is not a velocity. Treating the previous distance as
    // zero would hand frame one a closing speed of two kilometres a second —
    // a DEV-027 number with no reference frame, audible as a chirp on every
    // racer that comes into existence.
    const { engines, backend } = build()
    engines.sync([racer('fast', [0, 0, -400])], DEFAULT_LISTENER, 1 / 90)
    expect(backend.calls.filter((c) => c.call === 'detune')).toHaveLength(0)
  })

  it('does not divide by a zero frame delta', () => {
    const { engines, backend } = build()
    engines.sync([racer('fast', [0, 0, -400])], DEFAULT_LISTENER, 1 / 90)
    engines.sync([racer('fast', [0, 0, -300])], DEFAULT_LISTENER, 0)
    for (const c of backend.calls.filter((c) => c.call === 'detune')) {
      expect(Number.isFinite(c.cents)).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('a finished or despawned racer leaves NOTHING behind', () => {
  const build = (): {
    engines: ReturnType<typeof createRacerEngines>
    backend: RecordingBackend
  } => {
    const backend = createRecordingBackend()
    return { engines: createRacerEngines(backend), backend }
  }

  it('tears the node down when that racers run ends', () => {
    const { engines, backend } = build()
    engines.sync(
      [racer('fast', [0, 0, -50]), racer('steady', [0, 0, -60])],
      DEFAULT_LISTENER,
      1 / 90,
    )
    expect(engines.count).toBe(2)

    engines.sync(
      [racer('fast', [0, 0, -50], true), racer('steady', [0, 0, -60])],
      DEFAULT_LISTENER,
      1 / 90,
    )
    expect(engines.ids).toEqual(['steady'])
    expect(backend.emitters).toHaveLength(1)
    const stops = backend.calls.filter((c) => c.call === 'emitStop')
    expect(stops).toHaveLength(1)
    expect(stops[0]?.fadeSeconds).toBe(RACER_STOP_SECONDS)
  })

  it('does not keep moving a finished racers node', () => {
    // The leak that is silent in a test and permanent in a headset: a handle
    // still being driven by a `sync` for an object whose run is over.
    const { engines, backend } = build()
    engines.sync([racer('fast', [0, 0, -50])], DEFAULT_LISTENER, 1 / 90)
    backend.clear()
    engines.sync([racer('fast', [900, 0, -50], true)], DEFAULT_LISTENER, 1 / 90)
    engines.sync([racer('fast', [1800, 0, -50], true)], DEFAULT_LISTENER, 1 / 90)
    expect(emitterCalls(backend).filter((c) => c.call === 'move')).toHaveLength(0)
    expect(backend.emitters).toHaveLength(0)
  })

  it('tears the node down when the racer disappears from the list entirely', () => {
    const { engines, backend } = build()
    engines.sync(
      [racer('fast', [0, 0, -50]), racer('steady', [0, 0, -60])],
      DEFAULT_LISTENER,
      1 / 90,
    )
    engines.sync([racer('steady', [0, 0, -60])], DEFAULT_LISTENER, 1 / 90)
    expect(engines.ids).toEqual(['steady'])
    expect(backend.emitters).toHaveLength(1)
  })

  it('re-adding a finished racer starts ONE fresh node, not two', () => {
    // A restart puts the same two ids back. The old handle must be gone and
    // exactly one new one must exist — two emitters on one ship is a doubled
    // engine that only a headset would catch.
    const { engines, backend } = build()
    engines.sync([racer('fast', [0, 0, -50])], DEFAULT_LISTENER, 1 / 90)
    engines.sync([racer('fast', [0, 0, -50], true)], DEFAULT_LISTENER, 1 / 90)
    engines.sync([racer('fast', [0, 0, -50])], DEFAULT_LISTENER, 1 / 90)
    expect(engines.count).toBe(1)
    expect(backend.emitters).toHaveLength(1)
    expect(backend.calls.filter((c) => c.call === 'emit')).toHaveLength(2)
  })

  it('stopAll leaves no live emitter and is safe to call twice', () => {
    const { engines, backend } = build()
    engines.sync(
      [racer('fast', [0, 0, -50]), racer('steady', [0, 0, -60])],
      DEFAULT_LISTENER,
      1 / 90,
    )
    engines.stopAll()
    expect(engines.count).toBe(0)
    expect(backend.emitters).toEqual([])
    expect(() => engines.stopAll()).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('the NPC Ship mixer ramp, which 2016 really does run on GO', () => {
  it('starts an engine 31 dB down before the countdown ends', () => {
    // `NPC Ship.mixer` Pre-Launch −30.9 dB, Gameplay +0.13552584 dB, and the
    // cue gain already carries the Gameplay snapshot — so the pre-GO multiplier
    // is the RATIO of the two, which is what `PRELAUNCH_GAIN` is named for.
    expect(PRELAUNCH_GAIN).toBeCloseTo(
      dbToGain(NPC_MIXER_PRELAUNCH_DB) / dbToGain(NPC_MIXER_GAMEPLAY_DB),
      12,
    )
    expect(PRELAUNCH_GAIN).toBeLessThan(0.05)

    const backend = createRecordingBackend()
    const engines = createRacerEngines(backend)
    engines.sync([racer('fast', [0, 0, -50])], DEFAULT_LISTENER, 1 / 90)
    const gains = backend.calls.filter((c) => c.call === 'emitGain')
    expect(gains).toHaveLength(1)
    expect(gains[0]?.to).toBeCloseTo(PRELAUNCH_GAIN, 12)
    expect(gains[0]?.seconds).toBe(0)
  })

  it('ramps to full over 2 s on countdown.go, through the system', () => {
    // `E3/Scripts/Timer_Race.cs:70` calls `AudioDelayHack.TransitionToGameplay()`
    // on GO, and that transition is 2 s (`AudioDelayHack.cs:12`).
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend, random: () => 0.5 })
    system.racerEngines.sync([racer('fast', [0, 0, -50])], DEFAULT_LISTENER, 1 / 90)
    backend.clear()
    system.event({ type: 'countdown.go' })
    const gains = backend.calls.filter((c) => c.call === 'emitGain')
    expect(gains).toHaveLength(1)
    expect(gains[0]?.to).toBe(1)
    expect(gains[0]?.seconds).toBe(NPC_RAMP_SECONDS)
  })

  it('starts a racer that appears AFTER GO at full gain, not 31 dB down', () => {
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend, random: () => 0.5 })
    system.event({ type: 'countdown.go' })
    backend.clear()
    system.racerEngines.sync([racer('fast', [0, 0, -50])], DEFAULT_LISTENER, 1 / 90)
    expect(backend.calls.filter((c) => c.call === 'emitGain')).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('the system owns the engines, so a mission cannot leak one', () => {
  it('mission.end tears down every racer engine', () => {
    // `backend.stop(id)` addresses a CUE, and these are addressed by handle —
    // so the blanket stop in the `mission.end` branch cannot reach them. That
    // is exactly the shape of thing that outlives its mission unnoticed.
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend, random: () => 0.5 })
    system.racerEngines.sync(
      [racer('fast', [0, 0, -50]), racer('steady', [0, 0, -60])],
      DEFAULT_LISTENER,
      1 / 90,
    )
    expect(system.racerEngines.count).toBe(2)
    system.event({ type: 'mission.end' })
    expect(system.racerEngines.count).toBe(0)
    expect(backend.emitters).toEqual([])
  })

  it('stopAll and dispose both leave nothing running', () => {
    for (const teardown of ['stopAll', 'dispose'] as const) {
      const backend = createRecordingBackend()
      const system = createAudioSystem({ backend, random: () => 0.5 })
      system.racerEngines.sync([racer('fast', [0, 0, -50])], DEFAULT_LISTENER, 1 / 90)
      system[teardown]()
      expect(system.racerEngines.count, teardown).toBe(0)
      expect(backend.emitters, teardown).toEqual([])
    }
  })

  it('a restarted mission re-arms the pre-GO duck', () => {
    // `stopAll` clears the released latch, so the next run's racers sit 31 dB
    // down through its countdown too. Without this a second run starts with two
    // jets at full volume over the 3-2-1.
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend, random: () => 0.5 })
    system.racerEngines.sync([racer('fast', [0, 0, -50])], DEFAULT_LISTENER, 1 / 90)
    system.event({ type: 'countdown.go' })
    system.event({ type: 'mission.end' })
    backend.clear()
    system.racerEngines.sync([racer('fast', [0, 0, -50])], DEFAULT_LISTENER, 1 / 90)
    const gains = backend.calls.filter((c) => c.call === 'emitGain')
    expect(gains).toHaveLength(1)
    expect(gains[0]?.to).toBeCloseTo(PRELAUNCH_GAIN, 12)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('the listener, and the silence that must still work', () => {
  it('is the identity pose until the game says otherwise', () => {
    const backend = createRecordingBackend()
    expect(backend.listener).toEqual(DEFAULT_LISTENER)
  })

  it('reaches the backend from the system', () => {
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend, random: () => 0.5 })
    const pose = facingEastAt([-857, 120, 2082])
    system.setListener(pose)
    expect(backend.listener).toEqual(pose)
    expect(backend.calls.filter((c) => c.call === 'listener')).toHaveLength(1)
  })

  it('?audio=off: every positional call is a no-op and nothing throws', () => {
    // The silent backend is what `?audio=off` installs, and silence is a valid
    // output — the game must not care whether it has sound and must certainly
    // not crash because a racer moved.
    const system = createAudioSystem({ backend: createSilentBackend() })
    expect(() => {
      system.setListener(facingEastAt([1, 2, 3]))
      system.event({ type: 'shaft.pass', at: [0, 12, 0] })
      system.racerEngines.sync([racer('fast', [0, 0, -50])], DEFAULT_LISTENER, 1 / 90)
      system.racerEngines.sync([racer('fast', [0, 0, -40])], DEFAULT_LISTENER, 1 / 90)
      system.event({ type: 'countdown.go' })
      system.racerEngines.stopAll()
      system.stopAll()
      system.dispose()
    }).not.toThrow()
    expect(system.running).toBe(false)
  })

  it('the default backend in node is silent and still answers every call', () => {
    // Node has no `AudioContext`, so `createAudioSystem()` with no options is
    // the silent path — and it has to survive the whole positional API too.
    const system = createAudioSystem()
    expect(() => {
      system.setListener(DEFAULT_LISTENER)
      system.event({ type: 'shaft.pass', at: [0, 0, 0] })
      system.racerEngines.sync([racer('fast', [0, 0, 0])], DEFAULT_LISTENER, 1 / 90)
    }).not.toThrow()
    system.dispose()
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('the racer engine BUDGET: the nearest few are the audible ones (DEV-125)', () => {
  /** Five racers strung out ahead of the ears along −z, `spread` metres apart. */
  const five = (ears: ListenerPose, spread: number): RacerAudioInput[] =>
    ['fast', 'steady', 'cutter', 'wide', 'cruiser'].map((id, i) =>
      racer(id, [ears.position[0], ears.position[1], ears.position[2] - spread * (i + 1)]),
    )

  it('runs the NEAREST engines on the grid and no more than the budget', () => {
    // The default budget is the constant, and it is at least three so the
    // two-pad Classic grid is never touched by it.
    expect(RACER_ENGINE_BUDGET).toBeGreaterThanOrEqual(3)
    const backend = createRecordingBackend()
    const engines = createRacerEngines(backend, { maxAudible: 3 })
    engines.sync(five(DEFAULT_LISTENER, 12), DEFAULT_LISTENER, 1 / 90)
    expect(engines.count).toBe(3)
    expect(engines.ids).toEqual(['fast', 'steady', 'cutter'])
    expect(backend.calls.filter((c) => c.call === 'emit')).toHaveLength(3)
  })

  it('hands an engine to whoever comes nearest, and fades the one that fell away', () => {
    const backend = createRecordingBackend()
    const engines = createRacerEngines(backend, { maxAudible: 2 })
    engines.sync(five(DEFAULT_LISTENER, 100), DEFAULT_LISTENER, 1 / 90)
    expect(engines.ids).toEqual(['fast', 'steady'])
    // `cruiser` was 500 m out; it comes back to 50 m, closer than anyone.
    const swapped = five(DEFAULT_LISTENER, 100)
    swapped[4] = racer('cruiser', [0, 0, -50])
    engines.sync(swapped, DEFAULT_LISTENER, 1 / 90)
    // Ranks now: cruiser 0, fast 1, steady 2, cutter 3, wide 4. Budget 2:
    // cruiser starts, fast keeps, steady sits at rank == budget and KEEPS its
    // engine (the hysteresis slot); nobody past that has one to lose.
    expect(new Set(engines.ids)).toEqual(new Set(['fast', 'steady', 'cruiser']))
    // One more rank back for steady and it goes, with the run-end fade.
    const further = swapped.map((r) => (r.id === 'steady' ? racer('steady', [0, 0, -450]) : r))
    engines.sync(further, DEFAULT_LISTENER, 1 / 90)
    expect(new Set(engines.ids)).toEqual(new Set(['fast', 'cruiser']))
    const stops = backend.calls.filter((c) => c.call === 'emitStop')
    expect(stops).toHaveLength(1)
    expect(stops[0]?.fadeSeconds).toBe(RACER_STOP_SECONDS)
  })

  it('never starts a second emitter for a racer that already has one — trap 19, five wide', () => {
    // The five-racer form of "step a SECOND one and assert the first did not
    // move": sync five, then twenty more frames with everyone drifting, and the
    // emitter handles must be the same three objects they were on frame one.
    const backend = createRecordingBackend()
    const engines = createRacerEngines(backend, { maxAudible: 3 })
    const grid = five(DEFAULT_LISTENER, 12)
    engines.sync(grid, DEFAULT_LISTENER, 1 / 90)
    const first = backend.emitters.map((e) => e.handle)
    for (let frame = 1; frame <= 20; frame++) {
      engines.sync(
        grid.map((r, i) => racer(r.id, [r.position[0] + i, r.position[1], r.position[2] - frame])),
        DEFAULT_LISTENER,
        1 / 90,
      )
    }
    expect(backend.emitters.map((e) => e.handle)).toEqual(first)
    expect(engines.count).toBe(3)
  })
})
