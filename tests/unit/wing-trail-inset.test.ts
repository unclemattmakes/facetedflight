// tests/unit/wing-trail-inset.test.ts: the wing trails start half a width in. DEV-864.
//
// Matt, 2026-10-08: the ribbon was centred on the measured wing tip, so half its
// width hung off the wing. The inset is half the preset's glow width, so the
// ribbon's OUTER edge lands on the tip `measureWingTips` found on the hull.
// These are geometric: distances and a hull built by hand, not a restated rule.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { insetWingTips } from '@/game/wing-trails'
import { measureWingTips } from '@/render/wing-trails'
import anniversary from '../../content/editions/anniversary.json'

const WIDTH = anniversary.fx.wingTrails.startWidth

/** A flat delta planform, 12 m across, nose at -z. */
const hull = (): THREE.Object3D => {
  const geometry = new THREE.BufferGeometry()
  const v = [-6, 0, 2, 6, 0, 2, 0, 0, -5, -6, 0, 4, 6, 0, 4, 0, 1, 0]
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
  const root = new THREE.Group()
  root.add(new THREE.Mesh(geometry))
  return root
}

describe('DEV-864: the trail starts half a width inboard of the tip', () => {
  it('pulls each tip toward the centre by half the width, along the wing', () => {
    const tips = measureWingTips(hull())
    const port = tips.port.clone()
    const starboard = tips.starboard.clone()
    const span = port.distanceTo(starboard)
    insetWingTips(port, starboard, WIDTH * 0.5)
    expect(port.distanceTo(tips.port)).toBeCloseTo(WIDTH * 0.5, 6)
    expect(starboard.distanceTo(tips.starboard)).toBeCloseTo(WIDTH * 0.5, 6)
    expect(port.distanceTo(starboard)).toBeCloseTo(span - WIDTH, 6)
  })

  it('puts the ribbon outer edge on the tip', () => {
    const tips = measureWingTips(hull())
    const port = tips.port.clone()
    const starboard = tips.starboard.clone()
    insetWingTips(port, starboard, WIDTH * 0.5)
    // The ribbon is across the line of flight, which on this planform is the
    // span: its outer edge is half a width outboard of the new centre line.
    const outward = tips.port.clone().sub(tips.starboard).normalize()
    const edge = port.clone().addScaledVector(outward, WIDTH * 0.5)
    expect(edge.distanceTo(tips.port)).toBeLessThan(1e-6)
  })

  it('works in world metres whatever the frame scale', () => {
    const port = new THREE.Vector3(-30, 5, 0)
    const starboard = new THREE.Vector3(30, 5, 0)
    insetWingTips(port, starboard, 0.215)
    expect(port.x).toBeCloseTo(-29.785, 6)
    expect(starboard.x).toBeCloseTo(29.785, 6)
    expect(port.y).toBe(5)
  })

  it('never crosses over: tips closer than twice the inset meet at the middle', () => {
    const port = new THREE.Vector3(-0.1, 0, 0)
    const starboard = new THREE.Vector3(0.1, 0, 0)
    insetWingTips(port, starboard, 5)
    expect(port.distanceTo(starboard)).toBeCloseTo(0, 9)
    expect(port.x).toBeCloseTo(0, 9)
  })

  it('does nothing for no inset, and survives coincident tips', () => {
    const a = new THREE.Vector3(1, 2, 3)
    const b = new THREE.Vector3(4, 5, 6)
    insetWingTips(a, b, 0)
    expect(a.toArray()).toEqual([1, 2, 3])
    const c = new THREE.Vector3(1, 1, 1)
    const d = new THREE.Vector3(1, 1, 1)
    insetWingTips(c, d, 1)
    expect(c.toArray()).toEqual([1, 1, 1])
  })
})
