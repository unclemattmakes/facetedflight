// tests/unit/xr-pointer-smoothing.test.ts — the laser's One Euro filter.
//
// Matt, worn, 2026-09-23: *"feels jittery since it's 1:1 with my hand motion.
// can you smooth it a lil bit"*. What it must do, measured as angles on the
// ray rather than as filter internals: take most of a still hand's tremor out,
// stay close behind a deliberate sweep, and start afresh after a gap.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createPoseSmoother, POINTER_RESET_SECONDS } from '@/render/xr-pointer'

const DT = 1 / 90
const DEG = Math.PI / 180

/** A pose at the origin, turned `yaw` and `pitch` radians. */
const pose = (yaw: number, pitch: number): THREE.Matrix4 =>
  new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'))

/** Where the pose's −z (the ray) points. */
const rayOf = (m: THREE.Matrix4): THREE.Vector3 =>
  new THREE.Vector3().setFromMatrixColumn(m, 2).negate().normalize()

describe('the laser smoother', () => {
  it('passes the first pose through exactly', () => {
    const s = createPoseSmoother()
    const m = pose(0.3, -0.2)
    const want = m.clone()
    s.filter('right', m, 10)
    expect(m.equals(want)).toBe(true)
  })

  it('takes most of a still hand’s tremor out of the ray', () => {
    // A hand held still: ±0.4° of tremor at 9 Hz on both axes, plus noise.
    const s = createPoseSmoother()
    let seed = 7
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296 - 0.5
    }
    const rest = rayOf(pose(0, 0))
    let raw = 0
    let smooth = 0
    const frames = 540
    for (let i = 0; i < frames; i++) {
      const t = i * DT
      const yaw = 0.4 * DEG * Math.sin(2 * Math.PI * 9 * t) + 0.15 * DEG * rnd()
      const pitch = 0.4 * DEG * Math.cos(2 * Math.PI * 9 * t) + 0.15 * DEG * rnd()
      const m = pose(yaw, pitch)
      if (i > 90) raw += rayOf(m).angleTo(rest)
      s.filter('right', m, t)
      if (i > 90) smooth += rayOf(m).angleTo(rest)
    }
    // "a lil bit" is the brief: the tremor well down, not frozen.
    expect(smooth / raw).toBeLessThan(0.4)
    expect(smooth / raw).toBeGreaterThan(0.02)
  })

  it('stays close behind a deliberate sweep', () => {
    // A 90°/s turn, the pace of swinging from one holotable to the next.
    const s = createPoseSmoother()
    const rate = 90 * DEG
    let lag = 0
    for (let i = 0; i < 90; i++) {
      const m = pose(rate * i * DT, 0)
      const target = rayOf(m)
      s.filter('right', m, i * DT)
      lag = rayOf(m).angleTo(target)
    }
    // Steady-state lag: under 3°, about 30 ms at that pace. A plain low-pass
    // at the rest cutoff would trail by ~9.5°.
    expect(lag).toBeLessThan(3 * DEG)
  })

  it('starts afresh after a gap instead of gliding from the old pose', () => {
    const s = createPoseSmoother()
    s.filter('right', pose(0, 0), 1)
    s.filter('right', pose(0, 0), 1 + DT)
    const far = pose(1.2, 0)
    const want = far.clone()
    s.filter('right', far, 1 + DT + POINTER_RESET_SECONDS + 0.01)
    expect(far.equals(want)).toBe(true)
  })

  it('keeps the two hands apart: one hand’s motion never drags the other', () => {
    const s = createPoseSmoother()
    s.filter('left', pose(0, 0), 0)
    s.filter('right', pose(1, 0), 0)
    const left = pose(0, 0)
    s.filter('left', left, DT)
    expect(rayOf(left).angleTo(rayOf(pose(0, 0)))).toBeLessThan(1e-9)
  })
})
