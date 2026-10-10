// tests/unit/ocean-rings.test.ts: the rings' layout, and the GLSL's spelling of it.
//
// DEV-339. `ocean-ring-lattice.test.ts` holds the VERTICES to the plate's. This
// holds the arrangement: windows that nest on each other's lattices, holes that
// leave exactly one live cell over every point, a perimeter that lands on the
// coarser level's edge, triangles that face up. The GLSL cannot run here (no GL
// context in node), so what is asserted of it is what `water.test.ts` asserts of
// `WAVE_GLSL`: that it still spells the facts the TypeScript twin pins. The GPU
// half of the claim is `tests/e2e/ocean-rings.spec.ts`.
//
// Geometry, not beliefs (CLAUDE.md, the orientation lesson): the winding test
// measures the face normal of real baked triangles, and the coverage test counts
// live cells over random points rather than restating the hole rule.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  OCEAN_RINGS_KEY,
  patchRingFragment,
  patchRingVertex,
  RING_FRAGMENT_SWAPS,
  RING_GLSL_DECLS,
  RING_GLSL_FACE,
  RING_GLSL_FACE_DECLS,
  RING_GLSL_LOOKUP,
  RING_GLSL_SNAP,
  ringGeometry,
  ringLevelSpecs,
} from '@/render/ocean-rings'
import { WAVE_GLSL } from '@/render/water'
import { buildVertexGrid, type FacetedTerrainParams, type MapSampler } from '@/sim/terrain/faceted'
import type { Rgb } from '@/sim/terrain/image-sampler'
import { bakeRingLattice, ringStepMesh } from '@/sim/terrain/ocean-ring-lattice'
import {
  RING_CELL_CORNERS_ANTI,
  RING_CELL_CORNERS_DIAG,
  ringCellCorner,
  ringCellInHole,
  ringCoarseNeighbours,
  ringFrame,
  ringOnPerimeter,
  ringWindowOrigin,
} from '@/sim/terrain/ocean-ring-layout'
import { lcg } from './helpers/seeded'

const PLATE: FacetedTerrainParams = {
  terrainSize: 32768,
  terrainHeight: 512,
  chunkSize: 1024,
  baseResolution: 32,
  randomOffset: 2,
  seed: 20161027,
}
const LADDER = { cells: 64, innerCell: 32, levels: 4 }
const specs = ringLevelSpecs(PLATE, 8, LADDER)
const steps = specs.map((s) => ringStepMesh(PLATE, s))
const CELLS = LADDER.cells

describe('ringLevelSpecs: the example ladder is the plate at the same split', () => {
  it('four levels, every one 8 x 8 on LOD 0..3, cells 32 / 64 / 128 / 256 m', () => {
    expect(specs).toEqual([
      { stride: 1, n: 8 },
      { stride: 2, n: 8 },
      { stride: 4, n: 8 },
      { stride: 8, n: 8 },
    ])
    expect(steps.map((s) => s * 8)).toEqual([32, 64, 128, 256])
  })

  it('refuses a ladder the plate cannot take', () => {
    expect(() => ringLevelSpecs(PLATE, 8, { ...LADDER, innerCell: 48 })).toThrow(/divide/)
    expect(() => ringLevelSpecs(PLATE, 8, { ...LADDER, cells: 63 })).toThrow(/even/)
    expect(() => ringLevelSpecs(PLATE, 8, { ...LADDER, levels: 12 })).toThrow(/coarser/)
  })
})

describe('the windows nest', () => {
  const rnd = lcg(339)
  it('every window origin is even, so it sits on the next coarser level', () => {
    for (let i = 0; i < 200; i++) {
      const o = ringWindowOrigin((rnd() - 0.5) * 4000, CELLS)
      expect(Math.abs(o % 2)).toBe(0)
    }
  })

  it('each finer window lies inside the coarser one with room to spare', () => {
    for (let i = 0; i < 200; i++) {
      const frames = ringFrame(rnd() * 9000 + 1000, rnd() * 9000 + 1000, steps, CELLS)
      for (let k = 1; k < frames.length; k++) {
        const fine = frames[k - 1]
        const coarse = frames[k]
        const h = coarse?.hole
        expect(h).not.toBeNull()
        // The hole is the finer window in the coarser lattice, exactly.
        expect(h?.x1 && h.x0 + CELLS / 2).toBe(h?.x1)
        expect((fine?.wx ?? 0) / 2).toBe(h?.x0)
        expect((fine?.wz ?? 0) / 2).toBe(h?.z0)
        // And the hole stays well inside the coarse window: a ring is at least
        // 15 coarse cells thick on every side.
        const rx = (h?.x0 ?? 0) - (coarse?.wx ?? 0)
        const rz = (h?.z0 ?? 0) - (coarse?.wz ?? 0)
        expect(rx).toBeGreaterThanOrEqual(15)
        expect(rz).toBeGreaterThanOrEqual(15)
        expect((coarse?.wx ?? 0) + CELLS - (h?.x1 ?? 0)).toBeGreaterThanOrEqual(15)
        expect((coarse?.wz ?? 0) + CELLS - (h?.z1 ?? 0)).toBeGreaterThanOrEqual(15)
      }
    }
  })

  it('the finest level has no hole', () => {
    expect(ringFrame(1000, 1000, steps, CELLS)[0]?.hole).toBeNull()
  })
})

describe('coverage: exactly one live cell over every point inside the outermost window', () => {
  it('no gap and no overlap, over random eyes and random points', () => {
    const rnd = lcg(3390)
    let points = 0
    for (let e = 0; e < 60; e++) {
      const ex = 2000 + rnd() * 20000
      const ez = 2000 + rnd() * 20000
      const frames = ringFrame(ex, ez, steps, CELLS)
      const last = frames[frames.length - 1]
      const lastStep = steps[steps.length - 1] as number
      const x0 = (last?.wx ?? 0) * lastStep
      const z0 = (last?.wz ?? 0) * lastStep
      const span = CELLS * lastStep
      for (let p = 0; p < 400; p++) {
        // Anywhere in the outer window, with a bias to the inside where the
        // boundaries are.
        const bias = p % 2 === 0 ? 0.25 : 1
        const px = x0 + span * (0.5 + (rnd() - 0.5) * bias)
        const pz = z0 + span * (0.5 + (rnd() - 0.5) * bias)
        let live = 0
        for (let k = 0; k < frames.length; k++) {
          const f = frames[k]
          if (!f) continue
          const gx = Math.floor(px / (steps[k] as number))
          const gz = Math.floor(pz / (steps[k] as number))
          const inWindow = gx >= f.wx && gx < f.wx + CELLS && gz >= f.wz && gz < f.wz + CELLS
          if (inWindow && !ringCellInHole(f, gx, gz)) live++
        }
        expect(live).toBe(1)
        points++
      }
    }
    expect(points).toBe(60 * 400)
  })
})

describe('the perimeter lands on the coarser level', () => {
  it('coarse neighbours: even is the coarse vertex, odd is the midpoint of two', () => {
    expect(ringCoarseNeighbours(10, 6)).toEqual([
      [5, 3],
      [5, 3],
    ])
    expect(ringCoarseNeighbours(11, 6)).toEqual([
      [5, 3],
      [6, 3],
    ])
    expect(ringCoarseNeighbours(10, 7)).toEqual([
      [5, 3],
      [5, 4],
    ])
  })

  it('every perimeter vertex of a finer level is a point on the edge of the coarser hole', () => {
    const rnd = lcg(33900)
    for (let e = 0; e < 10; e++) {
      const frames = ringFrame(3000 + rnd() * 15000, 3000 + rnd() * 15000, steps, CELLS)
      for (let k = 0; k < frames.length - 1; k++) {
        const fine = frames[k]
        const hole = frames[k + 1]?.hole
        if (!fine || !hole) throw new Error('frame missing')
        for (let a = 0; a <= CELLS; a++) {
          for (const b of [0, CELLS]) {
            for (const [ra, rb] of [
              [a, b],
              [b, a],
            ] as const) {
              expect(ringOnPerimeter(ra, rb, CELLS)).toBe(true)
              const gx = fine.wx + ra
              const gz = fine.wz + rb
              const [c0, c1] = ringCoarseNeighbours(gx, gz)
              for (const c of [c0, c1]) {
                // On or inside the closed hole, and on its boundary.
                expect(c[0]).toBeGreaterThanOrEqual(hole.x0)
                expect(c[0]).toBeLessThanOrEqual(hole.x1)
                expect(c[1]).toBeGreaterThanOrEqual(hole.z0)
                expect(c[1]).toBeLessThanOrEqual(hole.z1)
                const onEdge =
                  c[0] === hole.x0 || c[0] === hole.x1 || c[1] === hole.z0 || c[1] === hole.z1
                expect(onEdge).toBe(true)
              }
            }
          }
        }
      }
    }
  })

  it('interior vertices are not on the perimeter', () => {
    expect(ringOnPerimeter(1, 1, CELLS)).toBe(false)
    expect(ringOnPerimeter(CELLS - 1, 30, CELLS)).toBe(false)
  })
})

describe('the six corners of a cell', () => {
  const swell = (u: number, v: number): number =>
    0.5 + 0.2 * Math.sin(u * 61 + 0.7) * Math.cos(v * 47)
  const map = {
    width: 64,
    height: 64,
    sample(u: number, v: number, out: Rgb): Rgb {
      const g = Math.min(1, Math.max(0, swell(u, v)))
      out.r = g
      out.g = g
      out.b = g
      return out
    },
  } as unknown as MapSampler
  const params: FacetedTerrainParams = { ...PLATE, terrainSize: 4096, terrainHeight: 40 }
  const grid = buildVertexGrid(map, params)
  const lat = bakeRingLattice(grid, map, params, specs[0] as (typeof specs)[number], {
    gx0: 200,
    gz0: 200,
    width: 80,
    height: 80,
  })
  const at = (gx: number, gz: number): number[] => {
    const i = ((gz - lat.gz0) * lat.width + (gx - lat.gx0)) * 4
    return [lat.data[i] as number, lat.data[i + 1] as number, lat.data[i + 2] as number]
  }

  it('both splits face UP in three space, measured from baked positions', () => {
    let up = 0
    let total = 0
    let diag = 0
    let anti = 0
    for (let gx = lat.gx0; gx < lat.gx0 + lat.width - 1; gx++) {
      for (let gz = lat.gz0; gz < lat.gz0 + lat.height - 1; gz++) {
        const isDiag =
          (lat.data[((gz - lat.gz0) * lat.width + (gx - lat.gx0)) * 4 + 3] as number) > 0.5
        if (isDiag) diag++
        else anti++
        for (let t = 0; t < 2; t++) {
          const pts = [0, 1, 2].map((k) => {
            const [du, dv] = ringCellCorner(isDiag, t * 3 + k)
            return at(gx + du, gz + dv)
          }) as [number[], number[], number[]]
          const ux = (pts[1][0] as number) - (pts[0][0] as number)
          const uy = (pts[1][1] as number) - (pts[0][1] as number)
          const uz = (pts[1][2] as number) - (pts[0][2] as number)
          const vx = (pts[2][0] as number) - (pts[0][0] as number)
          const vy = (pts[2][1] as number) - (pts[0][1] as number)
          const vz = (pts[2][2] as number) - (pts[0][2] as number)
          // (u x v).y: a face that looks up has a positive y normal.
          const ny = uz * vx - ux * vz
          // Plate-sized relief tilts a face by a few degrees; a normal pointing
          // down would be a negative area in plan.
          expect(Number.isFinite(uy + vy)).toBe(true)
          total++
          if (ny > 0) up++
        }
      }
    }
    expect(diag).toBeGreaterThan(100)
    expect(anti).toBeGreaterThan(100)
    expect(up).toBe(total)
  })

  it('the two splits cover the quad once: three distinct corners a face, four in all', () => {
    for (const table of [RING_CELL_CORNERS_DIAG, RING_CELL_CORNERS_ANTI]) {
      const tri0 = new Set(table.slice(0, 3).map((c) => c.join(',')))
      const tri1 = new Set(table.slice(3, 6).map((c) => c.join(',')))
      expect(tri0.size).toBe(3)
      expect(tri1.size).toBe(3)
      expect(new Set([...tri0, ...tri1]).size).toBe(4)
      // They share exactly the diagonal's two corners.
      expect([...tri0].filter((c) => tri1.has(c)).length).toBe(2)
    }
  })
})

describe('the geometry', () => {
  it('is cell x, cell z, slot: 6 vertices a cell, every cell once', () => {
    const g = ringGeometry(4, [0.1, 0.2, 0.3])
    const pos = g.getAttribute('position')
    expect(pos.count).toBe(4 * 4 * 6)
    const seen = new Set<string>()
    for (let i = 0; i < pos.count; i++) {
      seen.add(`${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)}`)
    }
    expect(seen.size).toBe(pos.count)
    const colour = g.getAttribute('color')
    expect([colour.getX(0), colour.getY(0), colour.getZ(0)].map((n) => Math.fround(n))).toEqual(
      [0.1, 0.2, 0.3].map((n) => Math.fround(n)),
    )
    expect(g.boundingSphere?.radius).toBeGreaterThan(1e6)
  })
})

describe('the GLSL spells the TypeScript', () => {
  it('declares the lookups, the corner tables and the wave function', () => {
    for (const name of [
      'uRingLat',
      'uRingLatC',
      'uRingTex',
      'uRingTexC',
      'uRingWin',
      'uRingHole',
      'uRingFall',
      'FF2_RING_DIAG',
      'FF2_RING_ANTI',
      'ff2RingTexel',
      'ff2RingLocal',
      'ff2RingWave',
      'texelFetch',
    ]) {
      expect(RING_GLSL_DECLS).toContain(name)
    }
  })

  it('has the same two corner tables as ocean-ring-layout.ts', () => {
    const spell = (t: readonly (readonly [number, number])[]): string =>
      t.map(([a, b]) => `ivec2(${a}, ${b})`).join(', ')
    expect(RING_GLSL_DECLS.replace(/\s+/g, ' ')).toContain(
      `FF2_RING_DIAG[6] = ivec2[6]( ${spell(RING_CELL_CORNERS_DIAG)});`,
    )
    expect(RING_GLSL_DECLS.replace(/\s+/g, ' ')).toContain(
      `FF2_RING_ANTI[6] = ivec2[6]( ${spell(RING_CELL_CORNERS_ANTI)});`,
    )
  })

  it('its wave function is the arithmetic of WAVE_GLSL, all four traps', () => {
    // Both rotated components in the phase, the hash's two separate z terms,
    // the (n + 1) amplitude scale and the z flip into Unity space.
    const fn = RING_GLSL_DECLS.slice(RING_GLSL_DECLS.indexOf('float ff2RingWave'))
    const lines = (s: string): string[] =>
      s
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^(float (r|n|phase|s|c|ux|uz)|vec2 dir)/.test(l))
    const base = lines(WAVE_GLSL)
    expect(base.length).toBeGreaterThanOrEqual(7)
    for (const line of base) {
      // `float ux = wp.x;` is the same line in both, `float displace = ...` is
      // the one that differs (it returns instead of assigning).
      expect(fn.replace(/\s+/g, ' ')).toContain(line.replace(/\s+/g, ' '))
    }
    expect(fn).toContain('uWave.z * (n + 1.0) * sin(phase)')
    expect(WAVE_GLSL).toContain('float displace = uWave.z * (n + 1.0) * sin(phase);')
  })

  it('the lookup replaces `transformed` from the cell, slot and lattice', () => {
    expect(RING_GLSL_LOOKUP).toContain('transformed = ff2RingLocal(uRingLat, uRingTex, ff2RingG')
    expect(RING_GLSL_LOOKUP).toContain('FF2_RING_DIAG[ff2RingSlot]')
    expect(RING_GLSL_LOOKUP).toContain('ff2RingCorner = ivec2(0)')
    expect(RING_GLSL_LOOKUP).toContain('ff2RingT0.w > 0.5')
  })

  it('every vertex takes its final position from ff2RingFinal, whose perimeter branch averages the coarse neighbours through the SAME ff2RingDisp', () => {
    const decls = RING_GLSL_DECLS.replace(/\s+/g, ' ')
    // The coarse level's own vertices and a fine vertex snapped onto them are one
    // function of one lattice point (the GPU run found single-pixel leaks when
    // they were two code paths).
    expect(decls).toContain(
      'vec3 ff2RingDisp(highp sampler2D tex, vec4 meta, ivec2 g, float stepM)',
    )
    expect(decls).toContain('ff2RingWave((modelMatrix * vec4(p, 1.0)).xyz) / yScale')
    expect(decls).toContain('ivec2 c0 = g / 2;')
    expect(decls).toContain('ff2RingDisp(uRingLatC, uRingTexC, c0, uRingFall.y)')
    expect(decls).toContain('ff2RingDisp(uRingLatC, uRingTexC, c1, uRingFall.y)')
    expect(decls).toContain('return 0.5 * (p0 + p1);')
    expect(decls).toContain('return ff2RingDisp(uRingLat, uRingTex, g, uRingFall.x);')
    expect(RING_GLSL_SNAP).toContain(
      'transformed = ff2RingFinal(ff2RingG, ff2RingCell + ff2RingCorner)',
    )
    expect(RING_GLSL_SNAP).toContain('!ff2RingHole')
    expect(RING_GLSL_SNAP).toContain('vWaterWorld = ')
    // The mirror's clip position is recomputed for the vertices the snap moved.
    expect(RING_GLSL_SNAP).toContain('vFf2MirrorClip')
  })

  it('patchRingVertex lands each block at its anchor, in order', () => {
    const shader = [
      'varying vec3 vWaterWorld;',
      'void main() {',
      '#include <begin_vertex>',
      '  {WAVE}',
      '#include <project_vertex>',
      '}',
    ].join('\n')
    const out = patchRingVertex(shader)
    const at = (s: string): number => out.indexOf(s)
    expect(at('uniform highp sampler2D uRingLat;')).toBeLessThan(at('void main() {'))
    expect(at('#include <begin_vertex>')).toBeLessThan(at('ff2RingCell = '))
    expect(at('ff2RingCell = ')).toBeLessThan(at('{WAVE}'))
    expect(at('{WAVE}')).toBeLessThan(at('transformed = ff2RingFinal('))
    expect(at('transformed = ff2RingFinal(')).toBeLessThan(at('#include <project_vertex>'))
  })

  it('refuses a shader it cannot anchor on, loudly', () => {
    expect(() => patchRingVertex('void main() { }')).toThrow(/begin_vertex/)
    expect(() => patchRingVertex('void main() {\n#include <begin_vertex>\n}')).toThrow(
      /project_vertex/,
    )
    expect(() =>
      patchRingVertex('void main() {\n#include <begin_vertex>\n#include <project_vertex>\n}'),
    ).toThrow(/water wave block/)
  })

  it('DEV-340: the face variant adds the flat normal, after the snap, and only there', () => {
    const shader = [
      'varying vec3 vWaterWorld;',
      'void main() {',
      '#include <begin_vertex>',
      '#include <project_vertex>',
      '}',
    ].join('\n')
    const plain = patchRingVertex(shader)
    const face = patchRingVertex(shader, true)
    expect(plain).not.toContain('vRingNormal')
    expect(face).toContain('flat varying vec3 vRingNormal;')
    // The normal is computed after the vertex's own position, from the same function.
    expect(face.indexOf('transformed = ff2RingFinal(')).toBeLessThan(face.indexOf('vRingNormal = '))
    expect(face.indexOf('vRingNormal = ')).toBeLessThan(face.indexOf('#include <project_vertex>'))
    // All three corners of the vertex's own triangle, by slot / 3.
    expect(RING_GLSL_FACE).toContain('(ff2RingSlot / 3) * 3')
    expect(RING_GLSL_FACE).toContain('cross(ff2RingWb - ff2RingWa, ff2RingWc - ff2RingWa)')
  })

  it('DEV-340: ff2RingFinal has the perimeter test the layout twin has', () => {
    const fn = RING_GLSL_DECLS.replace(/\s+/g, ' ')
    expect(fn).toContain(
      'uRingWin.w > 0.5 && (rel.x == 0 || rel.y == 0 || rel.x == n || rel.y == n)',
    )
    expect(RING_GLSL_FACE_DECLS).toContain('flat varying vec3 vRingNormal;')
  })

  it('DEV-340: the fragment swaps land on the water block as it is written', () => {
    // The swap anchors are statements in render/water.ts's normal block. Read
    // from the source it ships in, so a rewording there fails HERE rather than
    // leaving a ring drawing the derived normal while the arm says "face".
    const water = readFileSync(
      fileURLToPath(new URL('../../src/render/water.ts', import.meta.url)),
      'utf8',
    )
    for (const [from] of RING_FRAGMENT_SWAPS) expect(water).toContain(from)
    const out = patchRingFragment(
      RING_FRAGMENT_SWAPS.map(([from]) => from).join('\n') +
        '\nfloat footprint = max(length(dPdx), length(dPdy));',
    )
    expect(out).toContain('flat varying vec3 vRingNormal;')
    expect(out).toContain('vec3 faceNormal = vRingNormal;')
    expect(out).not.toContain('dFdx')
    expect(out).not.toContain('dFdy')
    expect(() => patchRingFragment('void main() {}')).toThrow(/no longer has/)
  })

  it('its program key suffix is one name, for every level', () => {
    expect(OCEAN_RINGS_KEY).toBe('oceanRings')
  })
})
