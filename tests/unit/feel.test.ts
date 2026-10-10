// tests/unit/feel.test.ts: the `feel` facade, the cockpit jolt and the flyby
// detector (DEV-636, DEV-637, DEV-642, DEV-643).
//
// The facade is where the feel rules are kept (POLISH-WAVE "the feel rules"), so
// this is where they are asserted: nothing shakes and no lens kicks in a
// headset or with Speed FX off, a haptic is not scaled by the slider, and the
// cockpit mesh jolt is the one thing that is legal everywhere.

import { describe, expect, it } from 'vitest'
import { createFeel } from '@/boot/feel'
import { cockpitJoltGain, createCockpitJolt, JOLTS, startJolt } from '@/game/cockpit-jolt'
import { createFlybyTracker, type FlybyInput } from '@/game/flyby'
import { createHaptics, type HapticSink } from '@/input/haptics'
import { createCameraShake, createShakeOffset, TRAUMA } from '@/render/camera-shake'

const make = (opts: { speedFx?: number; presenting?: boolean } = {}) => {
  const rumbles: number[] = []
  const sink: HapticSink = { rumble: (s) => rumbles.push(s), stop: () => {} }
  const kicks: [number, number][] = []
  const state = { speedFx: opts.speedFx ?? 1, presenting: opts.presenting ?? false, now: 1000 }
  const feel = createFeel({
    cameraShake: createCameraShake(),
    haptics: createHaptics(sink),
    cockpitJolt: createCockpitJolt(),
    flatFov: { kick: (d, s) => kicks.push([d, s]) },
    nowMs: () => state.now,
    speedFx: () => state.speedFx,
    presenting: () => state.presenting,
  })
  return { feel, rumbles, kicks, state }
}

describe('feel: flat only, slider-scaled', () => {
  it('shake adds trauma on the flat build at full Speed FX', () => {
    const { feel } = make()
    feel.shake(TRAUMA.crash)
    expect(feel.cameraShake.trauma).toBeCloseTo(TRAUMA.crash, 12)
  })

  it('shake and fovKick are DROPPED in an XR session', () => {
    const { feel, kicks } = make({ presenting: true })
    feel.shake(TRAUMA.crash)
    feel.fovKick(3, 0.2)
    expect(feel.cameraShake.trauma).toBe(0)
    expect(kicks).toEqual([])
  })

  it('shake and fovKick are DROPPED with Speed FX off', () => {
    const { feel, kicks } = make({ speedFx: 0 })
    feel.shake(TRAUMA.crash)
    feel.fovKick(3, 0.2)
    expect(feel.cameraShake.trauma).toBe(0)
    expect(kicks).toEqual([])
  })

  it('the lens kick is scaled by the slider: light is half', () => {
    const { feel, kicks } = make({ speedFx: 0.5 })
    feel.fovKick(4, 0.2)
    expect(kicks).toEqual([[2, 0.2]])
  })

  it('a haptic is NOT scaled by the slider and works in a session', () => {
    for (const opts of [{ speedFx: 0 }, { presenting: true }, { speedFx: 0.5 }]) {
      const { feel, rumbles } = make(opts)
      feel.haptic('crash')
      expect(rumbles.length).toBeGreaterThan(0)
    }
  })

  it('the cockpit jolt is legal everywhere: it is a mesh, and starts at any slider', () => {
    for (const opts of [{ speedFx: 0 }, { presenting: true }]) {
      const { feel, state } = make(opts)
      feel.jolt(JOLTS.crash)
      expect(cockpitJoltGain(feel.cockpitJolt, state.now / 1000)).toBeCloseTo(JOLTS.crash.gain, 9)
    }
  })

  it('boostHum goes to the scheduler', () => {
    const { feel, rumbles } = make()
    feel.boostHum(1)
    feel.haptics.update(0)
    expect(rumbles.length).toBe(1)
  })

  it('the shake offset is zero in a session even if trauma was added before it began', () => {
    const { feel } = make()
    feel.shake(1)
    const o = createShakeOffset()
    feel.cameraShake.sample(o, 0.3, 1, true)
    expect(o).toEqual(createShakeOffset())
  })
})

describe('the cockpit jolt', () => {
  it('is the gain at the blow, falling on a square to exactly zero', () => {
    const j = createCockpitJolt()
    startJolt(j, 10, 0.5, 2)
    expect(cockpitJoltGain(j, 2)).toBe(10)
    expect(cockpitJoltGain(j, 2.25)).toBeCloseTo(10 * 0.25, 9)
    expect(cockpitJoltGain(j, 2.5)).toBe(0)
    expect(cockpitJoltGain(j, 9)).toBe(0)
    expect(cockpitJoltGain(j, 1)).toBe(0)
  })

  it('a weaker blow does not cut a stronger one short; a stronger one takes over', () => {
    const j = createCockpitJolt()
    startJolt(j, 14, 0.7, 0)
    startJolt(j, 2, 0.3, 0.1)
    expect(j.gain).toBe(14)
    startJolt(j, 20, 0.2, 0.1)
    expect(j.gain).toBe(20)
  })

  it('ignores a non-positive gain or duration', () => {
    const j = createCockpitJolt()
    startJolt(j, 0, 1, 0)
    startJolt(j, 5, 0, 0)
    startJolt(j, Number.NaN, 1, 0)
    expect(cockpitJoltGain(j, 0)).toBe(0)
  })

  it('a crash is harder than a prop strike, which is harder than a near miss', () => {
    expect(JOLTS.crash.gain).toBeGreaterThan(JOLTS.propStrike.gain)
    expect(JOLTS.propStrike.gain).toBeGreaterThan(JOLTS.nearMiss.gain)
  })

  it('one flight’s jolt is not another’s (trap 19)', () => {
    const a = createCockpitJolt()
    const b = createCockpitJolt()
    startJolt(a, 9, 1, 0)
    expect(cockpitJoltGain(b, 0)).toBe(0)
  })
})

describe('the flyby detector', () => {
  const right = { rx: 1, ry: 0, rz: 0 }
  /** A ship crossing the player's path: lateral offset `x`, closing along z at `v` m/s. */
  const pass = (x: number, v: number, dt = 1 / 60) => {
    const t = createFlybyTracker()
    const events: { distance: number; side: number; trauma: number; speed: number }[] = []
    for (let z = 120; z > -120; z -= v * dt) {
      const input: FlybyInput = { dx: x, dy: 0, dz: z, ...right }
      const e = t.step('a', input, dt)
      if (e) events.push({ distance: e.distance, side: e.side, trauma: e.trauma, speed: e.speed })
    }
    return events
  }

  it('fires ONCE, at the closest approach, with that distance', () => {
    const events = pass(10, 100)
    expect(events).toHaveLength(1)
    expect(events[0]!.distance).toBeGreaterThanOrEqual(10)
    expect(events[0]!.distance).toBeLessThan(11.5)
    expect(events[0]!.speed).toBeGreaterThan(90)
  })

  it('a pass at 10 m rattles and one at 60 m does not even fire', () => {
    expect(pass(10, 120)[0]!.trauma).toBeGreaterThan(0.3)
    expect(pass(60, 120)).toEqual([])
  })

  it('knows the side: right of the player is +1, left is -1, dead ahead is 0', () => {
    expect(pass(12, 100)[0]!.side).toBe(1)
    expect(pass(-12, 100)[0]!.side).toBe(-1)
    expect(pass(0, 100)[0]!.side).toBe(0)
  })

  it('does not fire for a ship holding formation (no closing, no pass)', () => {
    const t = createFlybyTracker()
    let fired = 0
    for (let i = 0; i < 600; i++) {
      const wobble = Math.sin(i / 20) * 0.3
      if (t.step('a', { dx: 8, dy: 0, dz: 30 + wobble, ...right }, 1 / 60)) fired++
    }
    expect(fired).toBe(0)
  })

  it('does not fire for a ship moving away, or on its first sight', () => {
    const t = createFlybyTracker()
    expect(t.step('a', { dx: 5, dy: 0, dz: 5, ...right }, 1 / 60)).toBeNull()
    let fired = 0
    for (let i = 1; i < 120; i++) {
      if (t.step('a', { dx: 5, dy: 0, dz: 5 + i * 2, ...right }, 1 / 60)) fired++
    }
    expect(fired).toBe(0)
  })

  it('each ship has its own history: a second one does not move the first (trap 19)', () => {
    const t = createFlybyTracker()
    const events: string[] = []
    for (let z = 100; z > -100; z -= 2) {
      // `a` passes close; `b` hovers far away the whole time.
      if (t.step('a', { dx: 9, dy: 0, dz: z, ...right }, 1 / 60)) events.push('a')
      if (t.step('b', { dx: 300, dy: 0, dz: 300, ...right }, 1 / 60)) events.push('b')
    }
    expect(events).toEqual(['a'])
  })

  it('reset forgets the history: a teleport mid-approach is not a pass', () => {
    const t = createFlybyTracker()
    for (let z = 100; z > 50; z -= 2) t.step('a', { dx: 9, dy: 0, dz: z, ...right }, 1 / 60)
    t.reset()
    // After the reset the ship is "new": its first sight cannot fire.
    expect(t.step('a', { dx: 9, dy: 0, dz: 400, ...right }, 1 / 60)).toBeNull()
  })

  it('a vertical pass (over or under) counts the same as a lateral one', () => {
    const t = createFlybyTracker()
    let got = 0
    for (let z = 120; z > -120; z -= 2) {
      if (t.step('a', { dx: 0, dy: 10, dz: z, ...right }, 1 / 60)) got++
    }
    expect(got).toBe(1)
  })
})
