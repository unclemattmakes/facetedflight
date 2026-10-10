// tests/unit/quat-look.test.ts — `lookAlong` is asserted as a DISTANCE.
//
// The orientation lesson (docs/DEVIATIONS.md): a quaternion assertion is your
// belief written twice. So nothing below names a component. Every assertion
// here is the geometric property the function exists to have — rotate the
// body's forward axis by the result and you land on the direction you asked
// for — swept over a grid of directions, including the poles and the axes.

import { describe, expect, it } from 'vitest'
import { lookAlong, quat, rotateVec3 } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'

/** The sim's body frame: +Z forward, +Y up, +X right. `autopilot.ts` line 371. */
const FORWARD = v3(0, 0, 1)
const UP = v3(0, 1, 0)

describe('lookAlong', () => {
  it('carries the body forward axis onto the direction, over a sweep', () => {
    let worst = 0
    let worstAt = ''
    // 24 bearings x 13 elevations, poles included.
    for (let i = 0; i < 24; i++) {
      const bearing = (i / 24) * Math.PI * 2
      for (let j = 0; j <= 12; j++) {
        const elevation = -Math.PI / 2 + (j / 12) * Math.PI
        const dir = v3(
          Math.cos(elevation) * Math.sin(bearing),
          Math.sin(elevation),
          Math.cos(elevation) * Math.cos(bearing),
        )
        const nose = rotateVec3(v3(), lookAlong(quat(), dir), FORWARD)
        const miss = Math.hypot(nose.x - dir.x, nose.y - dir.y, nose.z - dir.z)
        if (miss > worst) {
          worst = miss
          worstAt = `bearing ${((bearing * 180) / Math.PI).toFixed(0)} elevation ${((elevation * 180) / Math.PI).toFixed(0)}`
        }
      }
    }
    expect(worst, `worst miss at ${worstAt}`).toBeLessThan(1e-6)
  })

  it('does not scale: the length of the direction is irrelevant', () => {
    const dir = v3(3, -4, 12)
    const long = rotateVec3(v3(), lookAlong(quat(), dir), FORWARD)
    const short = rotateVec3(v3(), lookAlong(quat(), v3(0.03, -0.04, 0.12)), FORWARD)
    expect(Math.hypot(long.x - short.x, long.y - short.y, long.z - short.z)).toBeLessThan(1e-9)
    // And it IS a unit vector, whatever went in.
    expect(Math.hypot(long.x, long.y, long.z)).toBeCloseTo(1, 12)
  })

  it('keeps the wings level — the body up axis never dips below the horizon', () => {
    // "Level" is a measurement too: the rotated up axis has no negative y for
    // any pitch in [-90, +90], because there is no roll in the composition.
    for (let i = 0; i < 24; i++) {
      const bearing = (i / 24) * Math.PI * 2
      for (let j = 0; j <= 12; j++) {
        const elevation = -Math.PI / 2 + (j / 12) * Math.PI
        const dir = v3(
          Math.cos(elevation) * Math.sin(bearing),
          Math.sin(elevation),
          Math.cos(elevation) * Math.cos(bearing),
        )
        const up = rotateVec3(v3(), lookAlong(quat(), dir), UP)
        expect(up.y).toBeGreaterThanOrEqual(-1e-9)
      }
    }
  })

  it('is the identity for a direction of nowhere', () => {
    const q = lookAlong(quat(1, 1, 1, 1), v3(0, 0, 0))
    expect([q.x, q.y, q.z, q.w]).toEqual([0, 0, 0, 1])
  })

  it('returns a unit quaternion', () => {
    const q = lookAlong(quat(), v3(-7, 2, 0.5))
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 12)
  })
})
