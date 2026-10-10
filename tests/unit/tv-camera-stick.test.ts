// tests/unit/tv-camera-stick.test.ts: DEV-725 (code-reuse audit IA-6).
//
// The TV camera's sticks used to have a deadzone of their own: 0.15, a hard cut
// that jumps from 0 to 0.15. Matt (2026-10-05) chose the ships' curve so every
// stick in the game feels the same: 2016's lower 0.2 / upper 0.9, rescaled so
// the output is continuous (`shapeAxis`).
//
// What this pins AGAINST. Not against the other devices of ours (that is the
// DEV-069 / DEV-071 trap: two of our own things agreeing proves nothing). The
// expectations below are written out from 2016's two numbers, 0.2 and 0.9, as
// arithmetic: `(|v| - 0.2) / (0.9 - 0.2)`. The constants sheet carries no stick
// dead zone (its only key is the TRIGGER's, `hoverjet.input.triggerDeadZone`),
// so the two numbers are the literals `gamepad.ts` documents as 2016's; the
// first test ties the exported names to them, so a retyped constant fails here.
//
// The measure is a RATIO of what the camera does at a deflection to what it
// does at full deflection, in two modes that read different axes:
//   - a headset's smooth turn (`xrTurn`): the yaw it adds in one frame;
//   - a flat Free's pad move (`padMoveY`): the distance it travels in a run.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createTvCamera, TV_CAMERA_POLICY } from '@/game/tv/tv-camera'
import { tvBoundsOf, tvCourseOf } from '@/game/tv/tv-vantage'
import { DEAD_ZONE_LOWER, DEAD_ZONE_UPPER } from '@/input/gamepad'
import { INT01 } from './helpers/tv-race'

const DT = 1 / 90
const LOWER = 0.2
const UPPER = 0.9

/** 2016's response, from its two numbers: zero to 0.2, saturated from 0.9, linear between. */
const response2016 = (v: number): number => {
  const m = Math.abs(v)
  if (m <= LOWER) return 0
  if (m >= UPPER) return Math.sign(v)
  return (Math.sign(v) * (m - LOWER)) / (UPPER - LOWER)
}

interface Rig {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
}
const rigAndHead = (): { rig: Rig; camera: Rig } => ({
  rig: { position: new THREE.Vector3(-800, 400, 2000), quaternion: new THREE.Quaternion() },
  camera: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
})

const cameraOver = (presenting: boolean) =>
  createTvCamera({
    craft: () => [],
    presenting: () => presenting,
    heightAt: () => 100,
    bounds: tvBoundsOf(INT01),
    course: tvCourseOf(INT01),
    headsetCuts: () => false,
  })

const yawOf = (q: THREE.Quaternion): number => {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
  return Math.atan2(-f.x, -f.z)
}

/** The yaw a headset's Free adds in one frame at this `xrTurn`, in units of a full-deflection frame. */
const turnAt = (xrTurn: number): number => {
  const cam = cameraOver(true)
  const { rig, camera } = rigAndHead()
  cam.setMode('free')
  const gaze: [number, number, number, number] = [0, 0, 0, 1]
  cam.frame(DT, rig, camera, { gaze }) // seeds the turn
  const before = yawOf(rig.quaternion)
  cam.frame(DT, rig, camera, { xrTurn, gaze })
  const step = yawOf(rig.quaternion) - before
  // The camera subtracts (right is clockwise): a positive turn lowers the yaw.
  return -step / (TV_CAMERA_POLICY.headsetTurnPerSecond * DT)
}

/** How far a flat Free travels in 20 frames at this pad `padMoveY` (up is -1). */
const travelAt = (padMoveY: number): number => {
  const cam = cameraOver(false)
  const { rig, camera } = rigAndHead()
  cam.setMode('free')
  cam.frame(DT, rig, camera, {}) // seeds the eye
  const start = rig.position.clone()
  for (let f = 0; f < 20; f++) cam.frame(DT, rig, camera, { padMoveY })
  return rig.position.distanceTo(start)
}

describe('DEV-725: the TV camera reads its sticks through 2016’s response', () => {
  it('the names it borrows are 2016’s two numbers', () => {
    expect(DEAD_ZONE_LOWER).toBe(LOWER)
    expect(DEAD_ZONE_UPPER).toBe(UPPER)
  })

  it('a headset’s turn: nothing inside 0.2, rescaled between, full from 0.9', () => {
    expect(Math.abs(turnAt(1))).toBeCloseTo(1, 9)
    for (const v of [0.1, 0.15, 0.2]) expect(Math.abs(turnAt(v))).toBe(0)
    for (const v of [0.25, 0.4, 0.5, 0.75, 0.89, 0.9, 0.95]) {
      expect(turnAt(v)).toBeCloseTo(response2016(v), 9)
      expect(turnAt(-v)).toBeCloseTo(response2016(-v), 9)
    }
    // 0.5 is the case the old hard cut got differently: it passed 0.5 through whole.
    expect(turnAt(0.5)).toBeCloseTo(0.3 / 0.7, 9)
    // 0.17 is a value the old 0.15 cut passed and 2016's response does not.
    expect(Math.abs(turnAt(0.17))).toBe(0)
  })

  it('a flat Free’s pad stick moves the eye by the same response', () => {
    const full = travelAt(-1)
    expect(full).toBeGreaterThan(1)
    expect(travelAt(-0.17)).toBe(0)
    expect(travelAt(-0.2)).toBe(0)
    for (const v of [0.4, 0.6, 0.85]) {
      expect(travelAt(-v) / full).toBeCloseTo(response2016(v), 6)
    }
  })

  it('the response is continuous at the edge (no step where the old cut had one)', () => {
    const justPast = turnAt(LOWER + 1e-6)
    expect(justPast).toBeGreaterThanOrEqual(0)
    expect(justPast).toBeLessThan(1e-5)
  })
})
