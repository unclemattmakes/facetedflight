// tests/unit/tv-camera-trigger.test.ts: DEV-801 (QUESTIONS-FOR-MATT item 65).
//
// DEV-725 gave the TV camera's STICKS the ships' response and left its trigger
// pair (a pad's right trigger rises, the left falls, in a flat Free) on a hard
// cut of its own, 0.15. Matt, 2026-10-07 ("go with your recs"): the pair uses
// the ships' trigger gate, `hoverjet.input.triggerDeadZone`, 0.1 on the
// constants sheet (2016's `Input_Ship.cs` stops the boost under 0.1).
//
// What this pins AGAINST: the sheet's own JSON, read here as a file, not the
// TypeScript import the camera takes (two of our own readers agreeing proves
// nothing: CLAUDE.md, DEV-069). And a deflection (0.12) the old 0.15 cut
// refused and the gate takes, so the test is red on the old code.

import fs from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createTvCamera, TV_CAMERA_POLICY } from '@/game/tv/tv-camera'
import { tvBoundsOf, tvCourseOf } from '@/game/tv/tv-vantage'
import { INT01 } from './helpers/tv-race'

const DT = 1 / 90

/** The ships' trigger gate, straight off the generated sheet's JSON. */
const GATE = (
  JSON.parse(fs.readFileSync('src/generated/constants.generated.json', 'utf8')) as {
    provenance: Record<string, { value: number }>
  }
).provenance['hoverjet.input.triggerDeadZone']?.value

interface Rig {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
}

/** How far a flat Free's eye moves UP in one frame at this `padRise` (negative: down). */
const riseAt = (padRise: number): number => {
  const cam = createTvCamera({
    craft: () => [],
    presenting: () => false,
    heightAt: () => -1000,
    bounds: tvBoundsOf(INT01),
    course: tvCourseOf(INT01),
    headsetCuts: () => false,
  })
  const rig: Rig = {
    position: new THREE.Vector3(-800, 400, 2000),
    quaternion: new THREE.Quaternion(),
  }
  const camera: Rig = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
  cam.setMode('free')
  cam.frame(DT, rig, camera, {}) // seeds the eye
  const start = rig.position.y
  for (let f = 0; f < 1; f++) cam.frame(DT, rig, camera, { padRise })
  return rig.position.y - start
}

describe('DEV-801: the TV camera’s trigger pair uses the ships’ trigger gate', () => {
  it('the gate is the sheet’s 0.1, and the camera’s policy is that number', () => {
    expect(GATE).toBe(0.1)
    expect(TV_CAMERA_POLICY.padTriggerDeadzone).toBe(GATE)
  })

  it('rises and falls from the gate: nothing under it, the raw value from it', () => {
    const full = riseAt(1)
    expect(full).toBeGreaterThan(1)
    for (const v of [0.02, 0.05, 0.099]) {
      expect(riseAt(v), `rise ${v}`).toBe(0)
      expect(riseAt(-v), `fall ${v}`).toBe(0)
    }
    // 0.12 is a pull the old 0.15 hard cut refused and the ships' gate takes.
    expect(riseAt(0.12)).toBeGreaterThan(0)
    expect(riseAt(-0.12)).toBeLessThan(0)
    // Past the gate the raw value moves it (a trigger is not a stick: no rescale).
    for (const v of [0.12, 0.3, 0.5, 0.8]) {
      expect(riseAt(v) / full).toBeCloseTo(v, 6)
      expect(riseAt(-v) / full).toBeCloseTo(-v, 6)
    }
  })

  it('a pull at the gate takes it (2016 stops a boost UNDER 0.1, so 0.1 is held)', () => {
    expect(riseAt(GATE as number)).toBeGreaterThan(0)
  })
})
