// tests/unit/finish-gate-art.test.ts — the finish gate has a picture (DEV-123).
//
// Data first, then geometry, then the banner:
//
//  1. Seven HoverJet missions carry `finish.art`; six JumpSeat missions carry a
//     convex-mesh finish with none. A finish with art in the wrong colour, or
//     the wrong number of studs, is new information about 2016, not a default.
//  2. **Geometry, not belief** (the orientation lesson §4). The finish frame is
//     three times a ring's frame, by the RATIO of two world scales the level
//     already carries; its centre sits inside its own stud cage; and the cage
//     is taller than it is wide, which is what a frame with no `offset` roll
//     under it has to be — where every ring's cage is wider than tall.
//  3. `bannerCells` puts the Anniversary band ON the frame's top edge, centred,
//     alternating, with the gap that notches the silhouette.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { FinishGateArt, Level } from '@/content/level-schema'
import { bannerCells } from '@/game/rings'
import { PROPS } from '@/generated/constants.generated'
import { editionJson as edition, levelJson as level } from './helpers/content'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LEVELS = path.join(HERE, '..', '..', 'content', 'levels')
const ids = fs
  .readdirSync(LEVELS)
  .filter((f) => /^[A-Za-z0-9][A-Za-z0-9_]*\.json$/.test(f))
  .map((f) => f.replace(/\.json$/, ''))

const artOf = (lvl: Level): FinishGateArt => {
  expect(lvl.finish?.shape).toBe('sphereUnion')
  const art = lvl.finish?.shape === 'sphereUnion' ? lvl.finish.art : undefined
  expect(art, `${lvl.id} has finish art`).toBeDefined()
  return art as FinishGateArt
}

describe('the data', () => {
  it('finds all thirteen shipped levels', () => {
    expect(ids.length).toBe(13)
  })

  for (const id of ids) {
    const lvl = level(id)
    if (lvl.vehicle === 'hoverjet') {
      it(`${id}: the finish wears checkpoint_finish.mat on the ring's mesh, over 40 studs`, () => {
        const art = artOf(lvl)
        expect(art.frame.mesh).toMatch(/jumpGate_diamond\.fbx$/)
        expect(art.frame.material).toMatch(/checkpoint_finish\.mat$/)
        expect(art.studMaterial).toMatch(/glowyMaterial\.mat$/)
        expect(art.studs.length).toBe(40)
        // The bought triangular frame was SEEN and left out, not missed.
        expect(art._meta?.inactiveRenderers).toContain('TriangularJumpgate2Green_pwm')
      })
    } else {
      it(`${id}: a JumpSeat finish is a pad, and has no gate art`, () => {
        expect(lvl.finish?.shape).toBe('convexMesh')
        expect((lvl.finish as { art?: unknown }).art).toBeUndefined()
      })
    }
  }

  it('the sheet carries the finish material, and it is not the ring`s', () => {
    const f = PROPS.finishGate
    const r = PROPS.checkpointRing
    expect(f.frameMaterial).toMatch(/checkpoint_finish\.mat$/)
    // Orange against green: the red channel is the tell.
    expect(f.frameColor[0]).toBeGreaterThan(r.frameColor[0])
    expect(f.frameColor[1]).toBeLessThan(r.frameColor[1])
    // Same alpha, same glow strength, same blend: the finish is the ring's
    // material family with the hue changed, which is how 2016 authored it.
    expect(f.frameColor[3]).toBeCloseTo(r.frameColor[3], 6)
    expect(f.frameGlowStrength).toBeCloseTo(r.frameGlowStrength ?? 0, 6)
    expect(f.frameBlends).toBe(r.frameBlends)
    expect(f.studMaterialIsRingStud).toBe(true)
  })
})

describe('the geometry', () => {
  for (const id of ids) {
    const lvl = level(id)
    if (lvl.vehicle !== 'hoverjet') continue
    const art = artOf(lvl)
    const ring0 = lvl.routes[0]?.rings[0]

    it(`${id}: the finish frame is three times a ring's frame, by ratio of world scales`, () => {
      expect(ring0).toBeDefined()
      const ringFrameScale =
        (ring0?.scale[0] as number) * (PROPS.checkpointRing.frame.scale[0] as number)
      const ratio = (art.frame.scale[0] as number) / ringFrameScale
      expect(ratio).toBeGreaterThan(2.9)
      expect(ratio).toBeLessThan(3.1)
      // Uniform, like the ring's.
      expect(art.frame.scale[1]).toBeCloseTo(art.frame.scale[0] as number, 3)
      expect(art.frame.scale[2]).toBeCloseTo(art.frame.scale[0] as number, 3)
    })

    it(`${id}: the frame's centre sits inside its own stud cage, and on the trigger`, () => {
      const cage = new THREE.Box3()
      for (const s of art.studs)
        cage.expandByPoint(new THREE.Vector3(...(s.pos as [number, number, number])))
      const centre = new THREE.Vector3(...(art.frame.pos as [number, number, number]))
      expect(
        cage.containsPoint(centre),
        `${centre.toArray()} inside ${cage.min.toArray()}..${cage.max.toArray()}`,
      ).toBe(true)
      // The picture is where the run ends: within the big trigger sphere.
      const finish = lvl.finish
      expect(finish).not.toBeNull()
      if (!finish) return
      const trigger = new THREE.Vector3(...(finish.pos as [number, number, number]))
      expect(centre.distanceTo(trigger)).toBeLessThan(finish.radius)
    })

    it(`${id}: the finish cage is TALLER than wide — no roll under it — where a ring's is wider`, () => {
      const cage = new THREE.Box3()
      for (const s of art.studs)
        cage.expandByPoint(new THREE.Vector3(...(s.pos as [number, number, number])))
      const size = cage.getSize(new THREE.Vector3())
      const across = Math.hypot(size.x, size.z)
      expect(size.y).toBeGreaterThan(across * 0.9)
      // And it is a BIG thing: the 2016 finish is a landmark, not a ring.
      expect(size.y).toBeGreaterThan(150)
    })
  }
})

describe('the banner', () => {
  // A stand-in frame box in the frame's UNIT-scale local space, the shape the
  // ring's baked geometry has (6.24 x 9.07 x 4.47 m, per the sheet's note).
  const frameBox = new THREE.Box3(
    new THREE.Vector3(-3.12, -4.53, -2.23),
    new THREE.Vector3(3.12, 4.53, 2.23),
  )
  const scale = 23.56
  const spec = edition('anniversary').gates.finishBanner

  it('is on in Anniversary and off in Classic, with the same numbers', () => {
    expect(spec.enabled).toBe(true)
    const classic = edition('classic').gates.finishBanner
    expect(classic.enabled).toBe(false)
    expect({ ...classic, enabled: true, note: '' }).toEqual({ ...spec, enabled: true, note: '' })
  })

  it('lays columns x rows cells ON the top edge, centred on the frame', () => {
    const cells = bannerCells(spec, frameBox, scale)
    expect(cells.length).toBe(spec.columns * spec.rows)
    const pitch = spec.cellMetres / scale
    const bottom = frameBox.max.y + spec.lift / scale
    for (const c of cells) {
      // Every cell clears the frame's top by the lift, and no cell is below the band.
      expect(c.position[1] - c.size / 2).toBeGreaterThanOrEqual(bottom - 1e-9)
      expect(c.size).toBeCloseTo(pitch * (1 - spec.gap), 9)
    }
    const xs = cells.map((c) => c.position[0])
    const meanX = xs.reduce((a, b) => a + b, 0) / xs.length
    expect(meanX).toBeCloseTo((frameBox.min.x + frameBox.max.x) / 2, 9)
    // Spans the columns: outermost centres are (columns - 1) pitches apart.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo((spec.columns - 1) * pitch, 9)
    // Spans the frame: twelve 12 m cells across a 147 m top edge.
    expect(spec.columns * spec.cellMetres).toBeGreaterThan(
      frameBox.getSize(new THREE.Vector3()).x * scale * 0.8,
    )
    expect(spec.columns * spec.cellMetres).toBeLessThan(
      frameBox.getSize(new THREE.Vector3()).x * scale * 1.1,
    )
  })

  it('alternates light and dark in both directions, and gaps notch the outline', () => {
    const cells = bannerCells(spec, frameBox, scale)
    const at = (c: number, r: number) => cells[r * spec.columns + c]!
    for (let r = 0; r < spec.rows; r++) {
      for (let c = 0; c + 1 < spec.columns; c++) expect(at(c, r).light).not.toBe(at(c + 1, r).light)
    }
    for (let r = 0; r + 1 < spec.rows; r++) expect(at(0, r).light).not.toBe(at(0, r + 1).light)
    // A gap: neighbouring cells do not touch, so a black cut-out is crenellated.
    const pitch = spec.cellMetres / scale
    expect(at(0, 0).size).toBeLessThan(pitch)
    expect(spec.gap).toBeGreaterThan(0)
  })

  it('draws nothing for a degenerate frame', () => {
    expect(bannerCells(spec, frameBox, 0)).toEqual([])
  })
})
