// tests/unit/water-spray.test.ts — the sea throws spray at a ship skimming it. DEV-429.
//
// Matt, 2026-09-26: *"plz continue the polish elements like water over the hull
// when going over water"* — NEXT.md P3 #2, water first.
//
// Three questions, each against something the spray code did not make:
//
//  - WHEN: only over sea (the ocean's field above the island's), only low over
//    the sea you can SEE (the field plus the bob), only moving, and scaled by
//    the comfort slider;
//  - WHICH WAY: up, against the SHEET's world gravity, with gravity and drag
//    zeroed on a copy so a falling droplet cannot pass for a rising one
//    (DEV-416's method);
//  - WHERE and HOW FAST: born at the water under the ship as the renderer's own
//    `flipPosition` places the ship, and carried along the ship's velocity as
//    that same conversion turns it.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { Edition, EditionWaterSpray } from '@/content/edition-schema'
import {
  poseSprayEmitter,
  type SeaSource,
  seaUnder,
  sprayStrength,
  waterSpraySpec,
} from '@/game/particle-fx'
import { WORLD } from '@/generated/constants.generated'
import { createParticleField } from '@/render/particles'
import { flipPosition } from '@/render/unity-space'
import type { HeightField } from '@/sim/terrain/height-field'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const SHIPPED: EditionWaterSpray = (anniversaryJson as unknown as Edition).fx.waterSpray
const CLASSIC: EditionWaterSpray = (classicJson as unknown as Edition).fx.waterSpray

describe('DEV-429: when the sea sprays', () => {
  const full = (h: number | null, depth = 50, speed = SHIPPED.fullSpeed, fx = 1) =>
    sprayStrength(SHIPPED, h, depth, speed, fx)

  it('is full at the water, at full speed, with the slider up', () => {
    expect(full(0)).toBeCloseTo(1, 10)
  })

  it('throws nothing over LAND — the island above the sea there', () => {
    expect(full(1, 0)).toBe(0)
    expect(full(1, -12)).toBe(0)
    // …and does over the shallowest water.
    expect(full(1, 0.5)).toBeGreaterThan(0)
  })

  it(`throws nothing at or above ${SHIPPED.heightMetres} m, under the surface, or with no sea at all`, () => {
    expect(full(SHIPPED.heightMetres)).toBe(0)
    expect(full(SHIPPED.heightMetres + 20)).toBe(0)
    expect(full(-0.5)).toBe(0)
    expect(full(null)).toBe(0)
  })

  it('thickens as the ship comes down, and as it speeds up, to the full rate', () => {
    const heights = [7, 5, 3, 1, 0]
    const byHeight = heights.map((h) => full(h))
    for (let i = 1; i < byHeight.length; i++) {
      expect(byHeight[i] as number).toBeGreaterThan(byHeight[i - 1] as number)
    }
    expect(full(1, 50, SHIPPED.minSpeed)).toBe(0)
    const speeds = [SHIPPED.minSpeed + 10, 70, 100, SHIPPED.fullSpeed]
    const bySpeed = speeds.map((v) => full(1, 50, v))
    for (let i = 1; i < bySpeed.length; i++) {
      expect(bySpeed[i] as number).toBeGreaterThan(bySpeed[i - 1] as number)
    }
    expect(full(1, 50, SHIPPED.fullSpeed + 200)).toBeCloseTo(full(1, 50, SHIPPED.fullSpeed), 10)
  })

  it('answers to the comfort slider: half is half, off is none (ART_DIRECTION: vection)', () => {
    expect(full(1, 50, SHIPPED.fullSpeed, 0.5)).toBeCloseTo(full(1) * 0.5, 10)
    expect(full(0, 50, SHIPPED.fullSpeed, 0)).toBe(0)
  })

  it('is off on Classic, whatever the ship does', () => {
    expect(CLASSIC.enabled).toBe(false)
    expect(sprayStrength(CLASSIC, 0, 50, 200, 1)).toBe(0)
  })
})

/** A flat analytic field at `y`, inside everywhere, or inside a disc of `radius`. */
const field = (heightAt: (x: number, z: number) => number, radius = Number.POSITIVE_INFINITY) =>
  ({
    analytic: {
      inside: (x: number, z: number) => Math.hypot(x, z) <= radius,
      heightAt,
      normalStep: 1,
    },
    vertPerSide: 2,
    heights: new Float32Array(4),
    step: 1,
    terrainSize: 1,
    terrainHeight: 1,
    originX: 0,
    originY: 0,
    originZ: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
  }) as HeightField

describe('DEV-429: which water — the sea you can SEE, over the island or off it', () => {
  // The sea's field at 100 and this frame's bob 3; an island 1 km in radius: a
  // hill at 120 inside 200 m, a lagoon floor at 80 out to its edge, and open sea
  // beyond it.
  const sea: SeaSource = {
    ocean: field(() => 100),
    land: field((x, z) => (Math.hypot(x, z) < 200 ? 120 : 80), 1000),
    bob: () => 3,
  }
  const at = (x: number, z: number) => seaUnder(sea, x, z, { seaY: 0, depth: 0 })

  it('is the field PLUS the bob — the plate as drawn this frame', () => {
    expect(at(500, 0).seaY).toBe(103)
  })

  it('is land over the hill, water over the lagoon, and open sea off the island', () => {
    expect(at(0, 0).depth).toBe(-17)
    expect(at(500, 0).depth).toBe(23)
    expect(at(5000, 0).depth).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('DEV-429: which way it goes (geometry against the sheet and the renderer)', () => {
  /**
   * A moment of spray from a ship at SIM `ship` with SIM velocity `v`: the
   * mean LAUNCH velocity and where the droplets were born.
   * Gravity and drag are zeroed on a copy.
   */
  const launch = (
    ship: { x: number; y: number; z: number },
    v: { x: number; y: number; z: number },
    carry: number,
  ) => {
    const spec = waterSpraySpec({ ...SHIPPED, gravity: 0, drag: 0 })
    const f = createParticleField(spec, new THREE.Texture(), {
      capacity: spec.initial?.maxParticles ?? 0,
      look: 'paper',
    })
    const e = f.addEmitter()
    poseSprayEmitter(e, ship, v, carry)
    e.play()
    const camera = new THREE.PerspectiveCamera()
    for (let k = 0; k < 20 && f.alive < 60; k++) f.update(0.005, camera)
    const g = (f.object as THREE.Mesh).geometry
    const vel = g.getAttribute('iVelocity')
    const pos = g.getAttribute('iPosition')
    const mean = new THREE.Vector3()
    const born = new THREE.Vector3()
    for (let i = 0; i < f.alive; i++) {
      mean.x += vel.getX(i)
      mean.y += vel.getY(i)
      mean.z += vel.getZ(i)
      born.x += pos.getX(i)
      born.y += pos.getY(i)
      born.z += pos.getZ(i)
    }
    const n = f.alive
    mean.divideScalar(Math.max(1, n))
    born.divideScalar(Math.max(1, n))
    f.dispose()
    return { mean, born, n }
  }

  // The sheet's world gravity, not a direction this file believes in.
  const g = WORLD.gravity
  const up = new THREE.Vector3(-g.x, -g.y, -g.z).normalize()

  it('rises off the water, against the world gravity', () => {
    const { mean, n } = launch({ x: 40, y: 104, z: 60 }, { x: 0, y: 0, z: 0 }, 0)
    expect(n).toBeGreaterThan(20)
    // The cone opens `angleDeg` either side of up; its mean is near vertical.
    expect(mean.clone().normalize().dot(up)).toBeGreaterThan(0.85)
  })

  it('is born at the hull, where the renderer puts the ship', () => {
    // At the hull and not at the modelled sea — `poseSprayEmitter` says why.
    const ship = { x: 40, y: 104, z: 60 }
    const { born } = launch(ship, { x: 0, y: 0, z: 0 }, 0)
    const hull = flipPosition({ x: 0, y: 0, z: 0 }, ship)
    // Mean of a disc about the point; a few ms of flight lift it a little.
    expect(Math.hypot(born.x - hull.x, born.z - hull.z)).toBeLessThan(SHIPPED.radius * 0.5)
    expect(born.y - hull.y).toBeGreaterThanOrEqual(0)
    expect(born.y - hull.y).toBeLessThan(1)
  })

  it(`is thrown along the ship's own velocity, ${SHIPPED.carry} of it`, () => {
    const ship = { x: 40, y: 104, z: 60 }
    // SIM: forward along Unity +z and a little to the side.
    const v = { x: 20, y: 0, z: 110 }
    const { mean } = launch(ship, v, SHIPPED.carry)
    const along = flipPosition(new THREE.Vector3(), v)
    const flat = new THREE.Vector3(mean.x, 0, mean.z)
    expect(flat.clone().normalize().dot(along.clone().normalize())).toBeGreaterThan(0.95)
    expect(flat.length() / (SHIPPED.carry * along.length())).toBeGreaterThan(0.85)
    expect(flat.length() / (SHIPPED.carry * along.length())).toBeLessThan(1.15)
  })
})
