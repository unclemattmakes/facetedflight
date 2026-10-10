// tests/unit/shaft-walls.test.ts — the sides of the shaft, and what a sealed
// tube changes about the reveal. DEV-106.
//
// Matt, 2026-09-14: *"our 'elevator ride' isn't enclosed, and players can see
// the world as they rise. please implement sides of the elevator shaft. make
// sure that players don't interpenetrate the world geo as they rise up."*
//
// Two claims, tested as geometry rather than as belief (the orientation
// lesson): the tube is closed around the bore from the room's ceiling to the
// rim, and the order of events on the way up is REVEAL, then RIM, then RELEASE
// — so the world is on before the eye can see out, and the deck is above
// everything in the bore before the ship is let go.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { EYE } from '@/game/flight'
import { createElevator, REVEAL_RISE, revealRiseFor } from '@/render/elevator'
import { applyWaterWaves } from '@/render/water'
import { generateShaft, hangarSpecFor, shaftSpecFor } from '@/sim/hangar'
import int01 from '../../content/levels/int_01_hoverJet.json'

const LAUNCH = int01.spawn.launch as {
  rise: number
  platform: { size: number[]; offset: number[]; shipOffset: number[] }
  shaft: { segmentSpacing: number; liveSegmentLocalY: number[]; deadSegmentLocalY: number[] }
}
const HANGAR = hangarSpecFor()
const SEED = 0x48414e47
const RIM =
  LAUNCH.rise + (LAUNCH.platform.offset[1] as number) - (LAUNCH.platform.shipOffset[1] as number)
const SPEC = shaftSpecFor(HANGAR, RIM)

const triangles = (m: ReturnType<typeof generateShaft>) =>
  Array.from({ length: m.triangleCount }, (_, t) => {
    const o = t * 9
    const p = (k: number) => ({
      x: m.positions[o + k * 3] as number,
      y: m.positions[o + k * 3 + 1] as number,
      z: m.positions[o + k * 3 + 2] as number,
    })
    const a = p(0)
    const b = p(1)
    const c = p(2)
    return {
      a,
      b,
      c,
      normal: {
        x: m.normals[o] as number,
        y: m.normals[o + 1] as number,
        z: m.normals[o + 2] as number,
      },
      centroid: { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 },
    }
  })

describe('the tube', () => {
  it('faces INWARD on the wall and UP on the collar', () => {
    // A dot product against the axis, which is true whatever anyone thought
    // the winding was. The collar is the flat ring at the rim.
    const tris = triangles(generateShaft(SPEC, SEED))
    let wall = 0
    let collar = 0
    for (const tri of tris) {
      const isCollar = Math.abs(tri.normal.y) > 0.9
      if (isCollar) {
        expect(tri.normal.y, 'collar faces up').toBeGreaterThan(0.9)
        collar++
      } else {
        // Inward: the normal points back toward the axis.
        const toAxis = -(tri.centroid.x * tri.normal.x + tri.centroid.z * tri.normal.z)
        expect(toAxis, 'wall faces the axis').toBeGreaterThan(0)
        wall++
      }
    }
    expect(collar).toBe(SPEC.sides * 2)
    expect(wall).toBeGreaterThan(SPEC.sides * 2 * 10)
  })

  it('runs from below the room ceiling to the rim, with no ring missing', () => {
    const tris = triangles(generateShaft(SPEC, SEED))
    const ys = tris.flatMap((t) => [t.a.y, t.b.y, t.c.y])
    expect(Math.min(...ys)).toBeLessThan(HANGAR.ceilingY - HANGAR.jitter * 2)
    expect(Math.max(...ys)).toBeCloseTo(SPEC.rimY, 4)
    // Sorted distinct ring heights step by at most a band and a bit of jitter.
    const distinct = [...new Set(ys.map((y) => Math.round(y * 10) / 10))].sort((a, b) => a - b)
    for (let i = 1; i < distinct.length; i++) {
      expect((distinct[i] as number) - (distinct[i - 1] as number)).toBeLessThan(
        SPEC.ringSpacing + SPEC.jitter * 2 + 0.2,
      )
    }
  })

  it('is the room bore across, and the rim is flat', () => {
    const tris = triangles(generateShaft(SPEC, SEED))
    const rimVerts = tris
      .flatMap((t) => [t.a, t.b, t.c])
      .filter((p) => Math.abs(p.y - SPEC.rimY) < 1e-3)
    expect(rimVerts.length).toBeGreaterThan(0)
    const radii = rimVerts.map((p) => Math.hypot(p.x, p.z))
    expect(Math.min(...radii)).toBeGreaterThan(SPEC.radius - SPEC.jitter - 1e-6)
    expect(Math.max(...radii)).toBeLessThan(SPEC.radius + SPEC.lip + SPEC.jitter + 1e-6)
  })

  it('is DETERMINISTIC, and a different tube on a different seed', () => {
    const a = generateShaft(SPEC, SEED)
    const b = generateShaft(SPEC, SEED)
    const c = generateShaft(SPEC, SEED + 1)
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(Array.from(a.positions)).not.toEqual(Array.from(c.positions))
  })

  it('emits a complete mesh — 9 floats a triangle, all finite, unit normals', () => {
    const m = generateShaft(SPEC, SEED)
    expect(m.positions.length).toBe(m.triangleCount * 9)
    expect(m.normals.length).toBe(m.triangleCount * 9)
    expect(m.colors.length).toBe(m.triangleCount * 9)
    for (const arr of [m.positions, m.normals, m.colors]) {
      expect(arr.every((v) => Number.isFinite(v))).toBe(true)
    }
    for (const tri of triangles(m)) {
      expect(Math.hypot(tri.normal.x, tri.normal.y, tri.normal.z)).toBeCloseTo(1, 5)
    }
  })
})

describe('the elevator wears it', () => {
  const build = () =>
    createElevator({
      platform: LAUNCH.platform,
      shaft: LAUNCH.shaft,
      rise: LAUNCH.rise,
      hangar: HANGAR,
      seed: SEED,
    })

  it('builds one wall mesh, both-sided, that clears the deck', () => {
    const elevator = build()
    const wall = elevator.object.getObjectByName('elevator-shaft-wall') as THREE.Mesh
    expect(wall).toBeDefined()
    expect((wall.material as THREE.Material).side).toBe(THREE.DoubleSide)
    const deckRadius =
      Math.max(LAUNCH.platform.size[0] as number, LAUNCH.platform.size[2] as number) / 2
    // The 12-gon's apothem is the closest the wall comes to the axis.
    const apothem = elevator.boreRadius * Math.cos(Math.PI / HANGAR.sides)
    expect(apothem - HANGAR.jitter, 'wall clears the deck').toBeGreaterThan(deckRadius)
    elevator.dispose()
  })

  it('puts the rim where the deck ARRIVES — a floor, not a segment top', () => {
    const elevator = build()
    const platform = elevator.object.getObjectByName('elevator-platform') as THREE.Object3D
    elevator.setRise(LAUNCH.rise)
    expect(elevator.rimY).toBeCloseTo(platform.position.y, 6)
    elevator.dispose()
  })

  it('reveals the world BEFORE the eye leaves the tube, and releases AFTER', () => {
    // The order that makes the pop-in invisible. The eye is `EYE.y` over the
    // ship's origin, and the ship's origin is at `rise` in this frame.
    const elevator = build()
    const eyeAtReveal = REVEAL_RISE + EYE.y
    expect(eyeAtReveal, 'eye still inside at the reveal').toBeLessThan(elevator.rimY)
    expect(elevator.rimY - eyeAtReveal, 'by a margin a leaning head cannot spend').toBeGreaterThan(
      1,
    )
    expect(LAUNCH.rise + EYE.y, 'and out by release').toBeGreaterThan(elevator.rimY)
    elevator.dispose()
  })

  it('switches the dead segments and the platform off at release, and nothing else', () => {
    const elevator = build()
    const shaft = elevator.object.getObjectByName('elevator-shaft') as THREE.Object3D
    const wall = elevator.object.getObjectByName('elevator-shaft-wall') as THREE.Object3D
    const platform = elevator.object.getObjectByName('elevator-platform') as THREE.Object3D
    const strips = elevator.object.getObjectByName('elevator-shaft-strips') as THREE.Object3D
    elevator.setReleased(true)
    const visibleSegments = shaft.children.filter((c) => c.visible)
    expect(visibleSegments.length).toBe(LAUNCH.shaft.liveSegmentLocalY.length)
    expect(platform.visible).toBe(false)
    expect(wall.visible).toBe(true)
    expect(strips.visible).toBe(true)
    elevator.setReleased(false)
    expect(shaft.children.every((c) => c.visible)).toBe(true)
    expect(platform.visible).toBe(true)
    elevator.dispose()
  })

  it('lights the tube with one instanced draw', () => {
    const elevator = build()
    const strips = elevator.object.getObjectByName('elevator-shaft-strips') as THREE.InstancedMesh
    expect(strips.isInstancedMesh).toBe(true)
    const segments = LAUNCH.shaft.liveSegmentLocalY.length + LAUNCH.shaft.deadSegmentLocalY.length
    expect(strips.count).toBe(segments * 6)
    elevator.dispose()
  })
})

describe('the land waits for the deck', () => {
  const deckDrop = (LAUNCH.platform.shipOffset[1] as number) - (LAUNCH.platform.offset[1] as number)
  const jitter = 0.8

  it("is 2016's height wherever the ground is below the deck at 2016's height", () => {
    // Six of the seven rigs, and the seabed on both Simonet ones.
    for (const top of [-42.04, -35.22, 82.42, 94.62, 95.62]) {
      expect(revealRiseFor(top, deckDrop, jitter)).toBe(REVEAL_RISE)
    }
    expect(revealRiseFor(null, deckDrop, jitter)).toBe(REVEAL_RISE)
  })

  it('is later on rookie_01, where the hillside crosses the bore above the deck', () => {
    const later = revealRiseFor(98.84, deckDrop, jitter)
    expect(later).toBeGreaterThan(REVEAL_RISE)
    expect(later).toBeCloseTo(98.84 + jitter + deckDrop, 6)
    // And still inside the tube: the eye at that rise is under the rim.
    expect(later + EYE.y).toBeLessThan(RIM)
  })
})

describe('the sea has a hole in it', () => {
  const compile = () => {
    const material = new THREE.MeshStandardMaterial()
    const water = applyWaterWaves(material, {
      live: true,
      direction: 0,
      frequency: 1,
      amplitude: 4,
      noise: -1,
      speed: 1,
    } as Parameters<typeof applyWaterWaves>[1])
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <begin_vertex>',
      fragmentShader:
        '#include <color_fragment>\n#include <normal_fragment_begin>\n#include <opaque_fragment>',
    }
    // biome-ignore lint/suspicious/noExplicitAny: three's hook signature is wider than we need
    ;(material.onBeforeCompile as any)(shader, null)
    return { water, shader }
  }

  it('cuts the bore out of the water fragments, next to the discard that was already there', () => {
    const { shader } = compile()
    expect(shader.fragmentShader).toContain('uniform vec4 uShaftBore;')
    // DEV-460: the circle became the shaft's outline, inside the circle
    // `uShaftBore.z` still bounds. `lift-seal.test.ts` pins the outline's read.
    expect(shader.fragmentShader).toMatch(/float fromR = length\(fromAxis\);/)
    expect(shader.fragmentShader).toMatch(/if \(fromR < uShaftBore\.z\) \{/)
    expect(shader.fragmentShader).toMatch(/\) discard;\s*\}\s*\}\s*#endif/)
  })

  it('is off until set, set by the caller, and off again when cleared', () => {
    const { water, shader } = compile()
    const u = shader.uniforms.uShaftBore?.value as THREE.Vector4
    expect(u.z).toBe(0)
    water.setShaftBore(-857.8, -2082.4, 6.78, 124.2)
    expect(u.x).toBeCloseTo(-857.8)
    expect(u.y).toBeCloseTo(-2082.4)
    expect(u.z).toBeCloseTo(6.78)
    expect(u.w).toBeCloseTo(124.2)
    water.clearShaftBore()
    expect(u.z).toBe(0)
  })
})
