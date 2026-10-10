// DEV-339: with the sea drawn as rings there is no sea mesh to pick, so the
// desk's click met nothing over open water and placed no point (editor-input,
// editor-panel). The ray now meets the sea's resting plane.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { groundHit } from '@/editor/desk/ground-hit'

const down = new THREE.Ray(new THREE.Vector3(10, 100, 20), new THREE.Vector3(0, -1, 0))

describe('groundHit', () => {
  it('meets the sea plane where no land mesh is hit', () => {
    const p = groundHit(down, null, 40)
    expect(p?.x).toBeCloseTo(10)
    expect(p?.y).toBeCloseTo(40)
    expect(p?.z).toBeCloseTo(20)
  })

  it('takes the land when it is nearer than the sea, and the sea when it is nearer', () => {
    const hill = new THREE.Vector3(10, 70, 20)
    expect(groundHit(down, hill, 40)).toBe(hill)
    const seabed = new THREE.Vector3(10, 5, 20)
    expect(groundHit(down, seabed, 40)?.y).toBeCloseTo(40)
  })

  it('is the land hit unchanged when the sea is not rings', () => {
    const hill = new THREE.Vector3(1, 2, 3)
    expect(groundHit(down, hill, null)).toBe(hill)
    expect(groundHit(down, null, null)).toBeNull()
  })

  it('misses a plane the ray points away from', () => {
    const up = new THREE.Ray(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, 1, 0))
    expect(groundHit(up, null, 40)).toBeNull()
  })
})
