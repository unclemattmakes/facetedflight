// tests/unit/prop-ground.test.ts — how tall is a tree, and is it standing on
// anything? DEV-134.
//
// Matt, 2026-09-16: *"do a scale pass on the trees in alpine to be more true
// to life"* and *"many of the trees in alpine seem to be floating."* Both are
// measurements before they are fixes, and both are measured HERE, through the
// renderer's own instance matrix (`instanceMatrixOf`, the function
// `load-props.ts` draws with) applied to the glTF's own accessor bounds — not
// reasoned out of the prefab YAML, which is how the first estimate of tree1's
// base came out 12.5 m in the air and 20 m off-centre (the wrapper carries a
// −90° roll that swaps the bake's y and z).
//
// Two surfaces are in play and the whole row is the gap between them:
//
//   the HEIGHT MAP     what 2016's `GenerateObjects()` placed on, minus the
//                      pass's `ObjectHeightOffset`;
//   the RENDERED mesh  that map plus `RandomOffset` of jitter per vertex,
//                      triangulated with the 2016 diagonal bug — what you see.
//
// The gate is the gitignored assets: the alpine height map and the prop GLBs
// come from R2, so every read is inside an `it` and the loud counterpart says
// so when they are absent (CLAUDE.md's `describe.skipIf` trap).

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { MeshTransform, PropPaletteEntry, PropScatter } from '@/content/load-environment'
import { childMatrixOf, FLOATING_METRES, instanceMatrixOf } from '@/game/props/load-props'
import { environmentTerrains, terrainParams } from '@/game/terrain/load-terrain'
import { decodeBase64, expandPlacements } from '@/sim/props/placements'
import { buildVertexGrid } from '@/sim/terrain/faceted'
import { type ImageData8, importUnityTexture } from '@/sim/terrain/image-sampler'
import { renderSurfaceHeightAt, snapToRenderSurface } from '@/sim/terrain/surface'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { REPO as ROOT } from './helpers/repo-root'
import { MAPS } from './helpers/terrain-field'

const ENV = path.join(ROOT, 'content', 'environments', 'alpine.json')
const PUBLIC = path.join(ROOT, 'public')

/** Cheap existence checks at collection time; every READ is inside an `it`. */
const haveMaps = fs.existsSync(path.join(ROOT, MAPS.alpine as string))
const haveProps = fs.existsSync(path.join(PUBLIC, 'assets', 'props', 'tree1.glb'))

interface EnvJson {
  scatter: PropScatter[]
}

/** glTF POSITION bounds and the mesh node's own matrix, straight off the file. */
const glbBounds = (
  file: string,
): { min: THREE.Vector3; max: THREE.Vector3; node: THREE.Matrix4 | null } => {
  const buf = fs.readFileSync(file)
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')) as {
    nodes?: {
      mesh?: number
      translation?: number[]
      rotation?: number[]
      scale?: number[]
      matrix?: number[]
    }[]
    meshes?: { primitives: { attributes: { POSITION: number } }[] }[]
    accessors: { min?: number[]; max?: number[] }[]
  }
  const min = new THREE.Vector3(Infinity, Infinity, Infinity)
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  let node: THREE.Matrix4 | null = null
  for (const n of json.nodes ?? []) {
    if (n.mesh === undefined) continue
    const mesh = json.meshes?.[n.mesh]
    for (const prim of mesh?.primitives ?? []) {
      const a = json.accessors[prim.attributes.POSITION]
      if (!a?.min || !a.max) continue
      min.min(new THREE.Vector3(...(a.min as [number, number, number])))
      max.max(new THREE.Vector3(...(a.max as [number, number, number])))
    }
    if (n.matrix) node = new THREE.Matrix4().fromArray(n.matrix)
    else if (n.translation || n.rotation || n.scale) {
      node = new THREE.Matrix4().compose(
        new THREE.Vector3(...((n.translation ?? [0, 0, 0]) as [number, number, number])),
        new THREE.Quaternion(...((n.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])),
        new THREE.Vector3(...((n.scale ?? [1, 1, 1]) as [number, number, number])),
      )
    }
  }
  return { min, max, node }
}

/** The eight corners of a box through a matrix: the drawn extents. */
const drawnBox = (
  min: THREE.Vector3,
  max: THREE.Vector3,
  m: THREE.Matrix4,
): { minY: number; maxY: number; width: number } => {
  let minY = Infinity
  let maxY = -Infinity
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  const c = new THREE.Vector3()
  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      for (const z of [min.z, max.z]) {
        c.set(x, y, z).applyMatrix4(m)
        minY = Math.min(minY, c.y)
        maxY = Math.max(maxY, c.y)
        minX = Math.min(minX, c.x)
        maxX = Math.max(maxX, c.x)
        minZ = Math.min(minZ, c.z)
        maxZ = Math.max(maxZ, c.z)
      }
    }
  }
  return { minY, maxY, width: Math.max(maxX - minX, maxZ - minZ) }
}

/**
 * One palette entry's geometry at scale 1, in the instance frame: how far its
 * base sits above/below its own placement point, how tall it is, how wide.
 */
const geometryAtUnit = (
  spec: PropPaletteEntry,
): { base: number; height: number; width: number } => {
  const g = glbBounds(path.join(PUBLIC, spec.meshAsset as string))
  const child = childMatrixOf(spec.meshTransform as MeshTransform | null, new THREE.Matrix4())
  const m = instanceMatrixOf(0, 0, 0, 0, 1, child, g.node, new THREE.Matrix4())
  const box = drawnBox(g.min, g.max, m)
  return { base: box.minY, height: box.maxY - box.minY, width: box.width }
}

const pct = (arr: number[], p: number): number => {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number
}

describe('DEV-134: alpine trees, measured through the instance matrix', () => {
  const env = (): EnvJson => JSON.parse(fs.readFileSync(ENV, 'utf8')) as EnvJson

  describe.skipIf(!haveProps)('scale — how tall the forest is, at 1 and as scattered', () => {
    it('prints every alpine palette entry at scale 1 and at the pass scale band, and says how the two passes compare with a conifer', () => {
      const lines: string[] = []
      const heights: Record<number, { min: number; max: number }> = {}
      for (const s of env().scatter) {
        let lo = Infinity
        let hi = 0
        for (const p of s.palette) {
          const g = geometryAtUnit(p)
          lo = Math.min(lo, g.height * s.scaleMin)
          hi = Math.max(hi, g.height * s.scaleMax)
          lines.push(
            `  pass ${s.index} ${(p.prefab ?? '?').split('/').pop()?.padEnd(24)} base ${g.base.toFixed(2).padStart(6)} m  ` +
              `height ${g.height.toFixed(2).padStart(6)} m  width ${g.width.toFixed(2).padStart(6)} m  at scale 1` +
              `  -> ${(g.height * s.scaleMin).toFixed(1)}-${(g.height * s.scaleMax).toFixed(1)} m at ${s.scaleMin}..${s.scaleMax}`,
          )
          // The trunk stands on its own foot: the base is within a metre of the
          // placement point at scale 1, on every entry. A base metres away is
          // the wrapper transform read wrong (it was, once — see the header).
          expect(Math.abs(g.base), `${p.prefab} base`).toBeLessThan(1)
          // And a tree is taller than it is wide.
          expect(g.height, `${p.prefab} proportions`).toBeGreaterThan(g.width * 0.8)
        }
        heights[s.index] = { min: lo, max: hi }
      }
      console.log(`DEV-134 alpine palette, drawn geometry:\n${lines.join('\n')}`)
      console.log(
        `DEV-134 alpine forest height bands: pass 0 (never run; Anniversary) ${heights[0]?.min.toFixed(1)}-${heights[0]?.max.toFixed(1)} m, ` +
          `pass 1 (shipped) ${heights[1]?.min.toFixed(1)}-${heights[1]?.max.toFixed(1)} m; a mature spruce or fir is 20-45 m`,
      )
      // Both passes reach well past a real conifer. This is the measurement the
      // `props.scale` knob exists for; the assertion is only that the row's
      // claim — "the forest is 1.5-2x life size at the top" — is what the
      // geometry says.
      expect(heights[1]?.max).toBeGreaterThan(60)
      expect(heights[0]?.max).toBeGreaterThan(60)
    })
  })

  describe.skipIf(!haveMaps || !haveProps)(
    'floating — base against the rendered surface, before and after',
    () => {
      it('counts alpine placements whose base is more than 0.3 m above the RENDERED mesh, per pass, then snaps and counts again', () => {
        const e = env()
        const land = environmentTerrains('alpine').land
        const params = terrainParams(land)
        const img = decodePngBuffer(
          fs.readFileSync(path.join(ROOT, MAPS.alpine as string)),
          'alpine',
        ) as ImageData8
        const heightMap = importUnityTexture(img)
        const grid = buildVertexGrid(heightMap, params)
        const terrain = {
          terrainSize: params.terrainSize,
          terrainHeight: params.terrainHeight,
          chunkSize: params.chunkSize,
        }

        const report: string[] = []
        let floatingAfter = 0
        for (const s of e.scatter) {
          const placed = expandPlacements(
            decodeBase64(s.placements.data),
            { width: s.placements.mapWidth, height: s.placements.mapHeight },
            heightMap,
            terrain,
            {
              probabilityScale: s.probabilityScale,
              heightOffset: s.heightOffset,
              scaleMin: s.scaleMin,
              scaleMax: s.scaleMax,
              paletteSize: s.palette.length,
              seed: s.placements.seed,
            },
          )
          const baseAtUnit = s.palette.map((p) => geometryAtUnit(p).base)

          // The gap between the drawn BASE of each instance and the rendered
          // surface under its placement point, at LOD 0 and at LOD 1.
          const gap0: number[] = []
          const gap1: number[] = []
          for (let i = 0; i < placed.count; i++) {
            const x = placed.positions[i * 3] as number
            const y = placed.positions[i * 3 + 1] as number
            const z = placed.positions[i * 3 + 2] as number
            const base =
              y + (baseAtUnit[placed.palette[i] as number] as number) * (placed.scale[i] as number)
            gap0.push(base - renderSurfaceHeightAt(grid, heightMap, params, x, z, 0))
            gap1.push(base - renderSurfaceHeightAt(grid, heightMap, params, x, z, 1))
          }
          const floating0 = gap0.filter((g) => g > FLOATING_METRES).length
          const floating1 = gap1.filter((g) => g > FLOATING_METRES).length
          report.push(
            `  pass ${s.index} (heightOffset ${s.heightOffset}, ${placed.count} props): base above LOD0 mesh by >${FLOATING_METRES} m: ` +
              `${floating0} (${((100 * floating0) / placed.count).toFixed(1)} %); median gap ${pct(gap0, 0.5).toFixed(2)} m, ` +
              `p95 ${pct(gap0, 0.95).toFixed(2)} m, max ${Math.max(...gap0).toFixed(2)} m; ` +
              `against LOD1: ${floating1} floating, p95 ${pct(gap1, 0.95).toFixed(2)} m`,
          )

          // The fix: snap to the rendered surface and sink 0.6 m (the preset's
          // number), then measure the same thing again.
          const sink = 0.6
          snapToRenderSurface(placed.positions, placed.count, grid, heightMap, params, sink)
          let after = 0
          const gapAfter: number[] = []
          for (let i = 0; i < placed.count; i++) {
            const x = placed.positions[i * 3] as number
            const y = placed.positions[i * 3 + 1] as number
            const z = placed.positions[i * 3 + 2] as number
            const base =
              y + (baseAtUnit[placed.palette[i] as number] as number) * (placed.scale[i] as number)
            const g = base - renderSurfaceHeightAt(grid, heightMap, params, x, z, 0)
            gapAfter.push(g)
            if (g > FLOATING_METRES) after++
          }
          floatingAfter += after
          report.push(
            `           after snap + ${sink} m sink: ${after} floating; median base ${pct(gapAfter, 0.5).toFixed(2)} m, ` +
              `p95 ${pct(gapAfter, 0.95).toFixed(2)} m (negative is buried)`,
          )

          // The row's diagnosis, as a relationship: the never-run pass
          // (heightOffset -2.6) floats far more than the shipped one (5).
          if (s.index === 0) expect(floating0 / placed.count).toBeGreaterThan(0.5)
          if (s.index === 1) expect(floating0 / placed.count).toBeLessThan(0.05)
        }
        console.log(`DEV-134 alpine floating, before/after:\n${report.join('\n')}`)
        expect(floatingAfter).toBe(0)
      })
    },
  )

  describe.skipIf(haveMaps && haveProps)('the loud counterpart', () => {
    it('says out loud that the geometry checks did NOT run', () => {
      expect(haveMaps && haveProps).toBe(false)
    })
  })
})
