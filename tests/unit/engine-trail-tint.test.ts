// tests/unit/engine-trail-tint.test.ts — DEV-407, each racer's engine trail
// wears its livery.
//
// Matt, 2026-09-25: *"racer's engine trail should be tinted to match the
// racer's color - like the wingtips."* What is worth asserting, against
// something outside the two helpers:
//
//  1. The amount IS the wing trails' own key, read from each preset, so the two
//     trails on one ship cannot disagree.
//  2. Classic is 2016's glowyMaterial exactly. Its wing trails are off, so
//     there is no tint, and the colour and the glow come out equal to the base.
//  3. A tint leans toward the livery without brightening any channel. The
//     livery's own channel keeps the base's value; the others give some up.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { engineTrailTint, tintEngineTrail } from '@/game/racers'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'

const base = (): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.8, 1, 1),
    emissive: new THREE.Color(0.5, 0.9, 1),
  })
const RED = [0.9, 0.1, 0.1] as const

describe("DEV-407 — a racer's engine trail takes its wing trails' tint", () => {
  it("reads the wing trails' own key on Anniversary", () => {
    expect(anniversary.fx.wingTrails.enabled).toBe(true)
    expect(engineTrailTint(anniversary.fx.wingTrails)).toBe(anniversary.fx.wingTrails.tint)
    expect(engineTrailTint(anniversary.fx.wingTrails)).toBeGreaterThan(0)
  })

  it('is 2016 exactly on Classic, where the wing trails are off', () => {
    expect(classic.fx.wingTrails.enabled).toBe(false)
    const b = base()
    const m = b.clone()
    tintEngineTrail(m, b, RED, engineTrailTint(classic.fx.wingTrails))
    expect(m.color.equals(b.color)).toBe(true)
    expect(m.emissive.equals(b.emissive)).toBe(true)
  })

  it('leans toward the livery without brightening any channel', () => {
    const b = base()
    const m = b.clone()
    tintEngineTrail(m, b, RED, engineTrailTint(anniversary.fx.wingTrails))
    expect(m.color.r).toBeCloseTo(b.color.r, 6)
    expect(m.color.g).toBeLessThan(b.color.g)
    expect(m.emissive.b).toBeLessThan(b.emissive.b)
    for (const k of ['r', 'g', 'b'] as const) {
      expect(m.color[k]).toBeLessThanOrEqual(b.color[k] + 1e-9)
      expect(m.emissive[k]).toBeLessThanOrEqual(b.emissive[k] + 1e-9)
    }
  })

  it('re-tints from the base, so a second tint does not compound the first', () => {
    const b = base()
    const m = b.clone()
    const amount = engineTrailTint(anniversary.fx.wingTrails)
    tintEngineTrail(m, b, RED, amount)
    const once = m.color.clone()
    tintEngineTrail(m, b, RED, amount)
    expect(m.color.equals(once)).toBe(true)
  })
})
