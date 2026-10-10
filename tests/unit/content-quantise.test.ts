// The shared grid arithmetic of the player-course canonical form (code-reuse
// audit XC-5 / C11). The reference bodies are the three copies it replaced.

import { describe, expect, it } from 'vitest'
import { normalisePropYaw, normaliseYaw, PLAYER_COURSE_SHAPE } from '@/content/player-course'
import { normaliseAzimuth } from '@/content/player-course-light'
import { normaliseDegreesOnGrid, quantise } from '@/content/quantise'

const wrap = (y: number): number => ((((y + 180) % 360) + 360) % 360) - 180

/** `normalisePropYaw` as it was: no re-quantise after the fold. */
const oldPropYaw = (yaw: number): number => {
  const q = quantise(wrap(yaw), PLAYER_COURSE_SHAPE.propYawQuantumDegrees)
  const out = q >= 180 ? q - 360 : q
  return Object.is(out, -0) ? 0 : out
}

describe('normaliseDegreesOnGrid', () => {
  it('the prop yaw never needed the re-quantise: swept, the two forms are the same number', () => {
    // 0.01 degree steps over three turns, plus the awkward neighbours of 180.
    for (let i = -54000; i <= 54000; i++) {
      const yaw = i / 100
      expect(Object.is(normalisePropYaw(yaw), oldPropYaw(yaw))).toBe(true)
    }
    for (const yaw of [179.49, 179.5, 179.51, 179.99, 180, 180.01, -180, -179.5, 539.5, -540.5]) {
      expect(Object.is(normalisePropYaw(yaw), oldPropYaw(yaw))).toBe(true)
    }
  })

  it('folds 180 to -180 on every grid the course uses, and never returns -0', () => {
    for (const step of [
      PLAYER_COURSE_SHAPE.yawQuantumDegrees,
      PLAYER_COURSE_SHAPE.propYawQuantumDegrees,
    ]) {
      expect(normaliseDegreesOnGrid(179.99, step)).toBe(-180)
      expect(Object.is(normaliseDegreesOnGrid(-0.0001, step), 0)).toBe(true)
    }
    expect(normaliseYaw(180)).toBe(-180)
    expect(normaliseAzimuth(180)).toBe(-180)
  })
})
