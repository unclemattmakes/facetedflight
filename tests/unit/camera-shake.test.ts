// tests/unit/camera-shake.test.ts: the flat camera shake (DEV-636).
//
// The order is the order these would hurt in:
//
//  1. **Never in a headset, and never the rig.** The rule is ART_DIRECTION
//     pillar 3: a shaken rig shakes the world around a stationary head. So the
//     offset is ZERO while presenting, and wearing it moves the camera's LOCAL
//     pose only: the rig's world matrix is bit-identical before, during and
//     after, and the camera's local pose is bit-identical after a restore.
//  2. **The slider is not a lie.** Speed FX off is zero, light is half,
//     linearly.
//  3. **It decays to exactly zero**, so a resting camera costs nothing and the
//     test for "no shake" can be an equality.
//  4. **A pass at 10 m rattles and one at 60 m does not** (Matt's words), by a
//     function that is monotonic in distance and continuous at the range edge.
//
// No GL context: a real `PerspectiveCamera` and a `Group` need none.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  createCameraShake,
  createShakeOffset,
  createShakeWear,
  FLYBY_FULL_CLOSING,
  FLYBY_FULL_METRES,
  FLYBY_RANGE_METRES,
  flybyTrauma,
  SHAKE_TUNING,
  TRAUMA,
} from '@/render/camera-shake'

/** The largest |component| `sample` produced over a second of 240 Hz time. */
const peak = (shake: ReturnType<typeof createCameraShake>, scale: number, presenting = false) => {
  const out = createShakeOffset()
  let m = 0
  for (let i = 0; i < 240; i++) {
    shake.sample(out, i / 240, scale, presenting)
    m = Math.max(m, Math.abs(out.x), Math.abs(out.y), Math.abs(out.z), Math.abs(out.roll))
  }
  return m
}

describe('trauma', () => {
  it('adds, clamps at 1, and ignores a NaN, a zero and a negative', () => {
    const s = createCameraShake()
    s.add(0.4)
    s.add(0.4)
    expect(s.trauma).toBeCloseTo(0.8, 12)
    s.add(0.9)
    expect(s.trauma).toBe(1)
    s.clear()
    for (const bad of [Number.NaN, 0, -1, Number.NEGATIVE_INFINITY]) s.add(bad)
    expect(s.trauma).toBe(0)
  })

  it('decays linearly to EXACTLY zero and stays there', () => {
    const s = createCameraShake()
    s.add(1)
    const seconds = 1 / SHAKE_TUNING.decayPerSecond
    s.step(seconds * 0.5)
    expect(s.trauma).toBeCloseTo(0.5, 9)
    s.step(seconds * 0.6)
    expect(s.trauma).toBe(0)
    s.step(1)
    expect(s.trauma).toBe(0)
  })

  it('a ten-second frame (a hidden tab) lands on zero, not on a blow', () => {
    const s = createCameraShake()
    s.add(1)
    s.step(10)
    expect(s.trauma).toBe(0)
  })

  it('ignores a non-positive dt', () => {
    const s = createCameraShake()
    s.add(0.5)
    s.step(0)
    s.step(-1)
    s.step(Number.NaN)
    expect(s.trauma).toBe(0.5)
  })
})

describe('the offset', () => {
  it('is exactly zero with no trauma', () => {
    const s = createCameraShake()
    const o = createShakeOffset()
    s.sample(o, 1.234, 1, false)
    expect(o).toEqual(createShakeOffset())
  })

  it('is ZERO while an XR session is presenting, at any trauma', () => {
    const s = createCameraShake()
    s.add(1)
    const o = createShakeOffset()
    o.x = 9
    s.sample(o, 0.37, 1, true)
    expect(o).toEqual(createShakeOffset())
  })

  it('is ZERO with Speed FX off, and HALF with it on light, linearly', () => {
    const s = createCameraShake()
    s.add(1)
    expect(peak(s, 0)).toBe(0)
    const full = peak(s, 1)
    const light = peak(s, 0.5)
    expect(full).toBeGreaterThan(0)
    expect(light / full).toBeCloseTo(0.5, 9)
  })

  it('is trauma SQUARED: half the trauma is a quarter of the offset', () => {
    const a = createCameraShake()
    const b = createCameraShake()
    a.add(1)
    b.add(0.5)
    expect(peak(b, 1) / peak(a, 1)).toBeCloseTo(0.25, 9)
  })

  it('stays inside its tuning ceilings', () => {
    const s = createCameraShake()
    s.add(1)
    const o = createShakeOffset()
    for (let i = 0; i < 2400; i++) {
      s.sample(o, i / 240, 1, false)
      expect(Math.abs(o.x)).toBeLessThanOrEqual(SHAKE_TUNING.translateMetres)
      expect(Math.abs(o.y)).toBeLessThanOrEqual(SHAKE_TUNING.translateMetres)
      expect(Math.abs(o.roll)).toBeLessThanOrEqual(SHAKE_TUNING.rollRadians)
      expect(Math.abs(o.pitch)).toBeLessThanOrEqual(SHAKE_TUNING.tiltRadians)
      expect(Math.abs(o.yaw)).toBeLessThanOrEqual(SHAKE_TUNING.tiltRadians)
    }
  })

  it('is continuous in time: no frame-to-frame jump bigger than the noise allows', () => {
    // 1 ms apart, a per-frame RANDOM shake would jump by its whole amplitude.
    const s = createCameraShake()
    s.add(1)
    const a = createShakeOffset()
    const b = createShakeOffset()
    let worst = 0
    for (let i = 0; i < 2000; i++) {
      s.sample(a, i / 1000, 1, false)
      s.sample(b, (i + 1) / 1000, 1, false)
      worst = Math.max(worst, Math.abs(a.x - b.x))
    }
    expect(worst).toBeLessThan(SHAKE_TUNING.translateMetres * 0.25)
  })

  it('is deterministic in time (no Math.random)', () => {
    const s = createCameraShake()
    s.add(0.8)
    const a = createShakeOffset()
    const b = createShakeOffset()
    s.sample(a, 3.21, 1, false)
    s.sample(b, 3.21, 1, false)
    expect(a).toEqual(b)
  })

  it('the six channels are not the same signal (golden-angle phases)', () => {
    const s = createCameraShake()
    s.add(1)
    const o = createShakeOffset()
    s.sample(o, 0.123, 1, false)
    const k = [o.x, o.y, o.roll, o.pitch, o.yaw].map((v) => v.toFixed(9))
    expect(new Set(k).size).toBe(5)
  })
})

describe('wearing it: the camera, and never the rig (pillar 3)', () => {
  /** The flat build's graph: scene -> rig (placed by the ship) -> camera (local pose zero). */
  const build = () => {
    const scene = new THREE.Scene()
    const rig = new THREE.Group()
    rig.position.set(120.5, 340.25, -77.125)
    rig.quaternion.setFromEuler(new THREE.Euler(0.3, -1.1, 0.2, 'YXZ'))
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.08, 6000)
    rig.add(camera)
    scene.add(rig)
    scene.updateMatrixWorld(true)
    return { scene, rig, camera }
  }
  const offset = () => {
    const s = createCameraShake()
    s.add(1)
    const o = createShakeOffset()
    s.sample(o, 0.37, 1, false)
    return o
  }

  it("leaves the rig's world matrix BIT-IDENTICAL while the camera moves", () => {
    const { scene, rig, camera } = build()
    const before = rig.matrixWorld.toArray()
    const camBefore = camera.matrixWorld.toArray()
    const wear = createShakeWear()
    wear.wear(camera, offset())
    scene.updateMatrixWorld(true)
    expect(wear.worn).toBe(true)
    expect(rig.matrixWorld.toArray()).toEqual(before)
    // ...and the camera DID move, or the test above proves nothing.
    expect(camera.matrixWorld.toArray()).not.toEqual(camBefore)
    expect(Math.abs(camera.position.x) + Math.abs(camera.position.y)).toBeGreaterThan(0)
    wear.restore(camera)
    expect(rig.matrixWorld.toArray()).toEqual(before)
  })

  it('restores the camera local pose exactly, and its world matrix', () => {
    const { scene, camera } = build()
    camera.position.set(0.01, -0.02, 0.003)
    camera.quaternion.setFromEuler(new THREE.Euler(0.1, 0.2, 0.0, 'YXZ'))
    scene.updateMatrixWorld(true)
    const pos = camera.position.toArray()
    const quat = camera.quaternion.toArray()
    const world = camera.matrixWorld.toArray()
    const wear = createShakeWear()
    wear.wear(camera, offset())
    wear.restore(camera)
    expect(wear.worn).toBe(false)
    expect(camera.position.toArray()).toEqual(pos)
    expect(camera.quaternion.toArray()).toEqual(quat)
    expect(camera.matrixWorld.toArray()).toEqual(world)
  })

  it('a zero offset touches nothing at all, and restore is then a no-op', () => {
    const { camera } = build()
    const world = camera.matrixWorld.toArray()
    const wear = createShakeWear()
    wear.wear(camera, createShakeOffset())
    expect(wear.worn).toBe(false)
    wear.restore(camera)
    expect(camera.matrixWorld.toArray()).toEqual(world)
  })

  it('keeps the camera quaternion a unit quaternion, and the roll small', () => {
    const { camera } = build()
    const wear = createShakeWear()
    wear.wear(camera, offset())
    expect(camera.quaternion.length()).toBeCloseTo(1, 12)
    // The roll worn is the camera's own local-z rotation, inside the ceiling.
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
    expect(Math.abs(e.z)).toBeLessThanOrEqual(SHAKE_TUNING.rollRadians + 1e-6)
  })

  it('the whole life of a shake is zero at the end: decay, then no wear', () => {
    const { camera } = build()
    const s = createCameraShake()
    s.add(1)
    const wear = createShakeWear()
    const o = createShakeOffset()
    for (let i = 0; i < 240; i++) {
      s.step(1 / 120)
      s.sample(o, i / 120, 1, false)
      wear.wear(camera, o)
      wear.restore(camera)
    }
    expect(s.trauma).toBe(0)
    s.sample(o, 9, 1, false)
    expect(o).toEqual(createShakeOffset())
    expect(camera.position.toArray()).toEqual([0, 0, 0])
  })
})

describe('a racer whooshing past', () => {
  it('a pass at 10 m rattles; a pass at 60 m does not (Matt)', () => {
    const near = flybyTrauma(FLYBY_FULL_CLOSING, 10)
    const far = flybyTrauma(FLYBY_FULL_CLOSING, 60)
    expect(near).toBeGreaterThan(TRAUMA.flyby * 0.9)
    expect(far).toBe(0)
  })

  it('falls with distance, and rises with closing speed', () => {
    let last = Number.POSITIVE_INFINITY
    for (let d = FLYBY_FULL_METRES; d <= FLYBY_RANGE_METRES; d += 1) {
      const t = flybyTrauma(FLYBY_FULL_CLOSING, d)
      expect(t).toBeLessThanOrEqual(last + 1e-12)
      last = t
    }
    expect(flybyTrauma(60, 15)).toBeLessThan(flybyTrauma(120, 15))
    expect(flybyTrauma(0, 10)).toBe(0)
    expect(flybyTrauma(-30, 10)).toBe(0)
  })

  it('is continuous at the range edge: no step from a little to nothing', () => {
    const justIn = flybyTrauma(FLYBY_FULL_CLOSING, FLYBY_RANGE_METRES - 0.01)
    expect(justIn).toBeLessThan(0.01)
    expect(flybyTrauma(FLYBY_FULL_CLOSING, FLYBY_RANGE_METRES)).toBe(0)
  })

  it('is capped at the ceiling whatever the speed', () => {
    expect(flybyTrauma(10_000, 0)).toBeLessThanOrEqual(TRAUMA.flyby)
  })
})
