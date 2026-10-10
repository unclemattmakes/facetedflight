// tests/unit/terrain-oracle-sweep.test.ts — the generator against ALL 256
// baked Simonet chunks, not one of them.
//
// ── Why this file exists ──────────────────────────────────────────────────
//
// `terrain-simonet.test.ts` checked chunk (0,0) against the 2016 bake and
// agreed to 4 mm on mean height. That number was real, and it certified almost
// nothing:
//
//   * Chunk (0,0) sits at u,v ≈ 0.03, so a texel-addressing error proportional
//     to u — which is exactly the error we had — was 3% of a texel there.
//   * It is open sea, so the import-time 1025→1024 rescale, which only moves
//     height where the map has detail, moved nothing.
//   * It is on the grid diagonal, so a transposed chunk index would have been
//     invisible.
//   * Its neighbour (8,8), the other chunk spot-checked, is ALSO open sea and
//     ALSO on the diagonal.
//
// Sweeping the whole grid put 48% of inland grid points outside the jitter
// bound, by up to 30 m, and led straight to both bugs (see `image-sampler.ts`).
// One spot-check is not a verification, and the corner is the worst possible
// place to take it.
//
// ── What it needs, and why it skips ───────────────────────────────────────
//
// The oracle is decoded from the 2016 bake by `pnpm oracle:sweep`, which needs
// the legacy Unity project mounted AND UnityPy. Its output is gitignored: the
// bake is derived from World Machine content whose licence question is still
// open (content/MANIFEST.md, D26), so per-chunk statistics stay local.
//
// The skip is LOUD — a test that passes because its input is missing is worse
// than no test.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TERRAIN } from '@/generated/constants.generated'
import {
  buildVertexGrid,
  type FacetedTerrainParams,
  generateChunk,
  grayscale,
} from '@/sim/terrain/faceted'
import { importUnityTexture } from '@/sim/terrain/image-sampler'
import { legacyRootOrAbsent } from '../../tools/legacy-root.mjs'
import { decodePng } from '../../tools/terrain/png.mjs'

const LEGACY = legacyRootOrAbsent()
const ORACLE_DIR = 'tools/terrain/.oracle'
const SWEEP = path.join(ORACLE_DIR, 'simonet.islands.json')

const ISLANDS = TERRAIN.simonet.terrains.islands
const SIMONET: FacetedTerrainParams = {
  terrainSize: ISLANDS.terrainSize,
  terrainHeight: ISLANDS.terrainHeight,
  chunkSize: ISLANDS.chunkSize,
  baseResolution: ISLANDS.baseResolution,
  randomOffset: ISLANDS.randomOffset,
  seed: 20160101,
}

interface ChunkStats {
  chunkX: number
  chunkY: number
  lod: number
  vertexCount: number
  skirtVerts: number
  min: number[]
  max: number[]
  heightMean: number
}

interface Sweep {
  chunkSize: number
  chunkPerSide: number
  chunkCount: number
  duplicateCoords: string[]
  decodeFailures: string[]
  chunks: Record<string, ChunkStats>
}

const heightMapFile = path.join(LEGACY, ISLANDS.sourceHeightMap)
const available = fs.existsSync(heightMapFile) && fs.existsSync(SWEEP)

const load = () => ({
  height: importUnityTexture(decodePng(heightMapFile)),
  color: importUnityTexture(decodePng(path.join(LEGACY, ISLANDS.sourceColorMap))),
})

const readSweep = (): Sweep => JSON.parse(fs.readFileSync(SWEEP, 'utf8')) as Sweep

/**
 * The jitter bound. `insideUnitSphere * randomOffset` displaces a vertex by at
 * most `randomOffset` on each axis, so a height that differs by more than this
 * is NOT explained by DEV-006 and means the sampler disagrees.
 *
 * Its standard deviation is `randomOffset * sqrt(1/5)` = 0.581 m — the floor
 * any per-vertex comparison can reach, and the number the rms below is judged
 * against.
 */
const JITTER_BOUND = ISLANDS.randomOffset

describe.skipIf(!available)('Simonet — every baked chunk, not just the corner', () => {
  it('has an oracle that decoded cleanly and covers the whole grid', () => {
    const sweep = readSweep()
    // A duplicate coordinate means the bounds-based chunk identification in
    // `unity_mesh.py` is wrong, and every diff below is comparing the wrong
    // pair of chunks while looking fine.
    expect(sweep.duplicateCoords).toEqual([])
    expect(sweep.decodeFailures).toEqual([])
    // 16 x 16 chunks x 3 LODs. Note 256 at LOD 0, not 255: Unity renames the
    // main asset of a .asset file to the file's basename, so chunk (0,0) LOD0
    // is called `terrain_simonetIslands_FacetedChunks`, and a tool that
    // filters on the name drops precisely the chunk everyone spot-checks.
    expect(sweep.chunkCount).toBe(ISLANDS.chunkPerSide * ISLANDS.chunkPerSide * ISLANDS.lodLevels)
    const lod0 = Object.values(sweep.chunks).filter((c) => c.lod === 0)
    expect(lod0.length).toBe(256)
    expect(sweep.chunkSize).toBe(ISLANDS.chunkSize)
  })

  it('reproduces the structure of all 256 chunks exactly', () => {
    const { height, color } = load()
    const grid = buildVertexGrid(height, SIMONET)
    const sweep = readSweep()

    const badVerts: string[] = []
    const badSkirt: string[] = []
    const badBounds: string[] = []

    for (const o of Object.values(sweep.chunks)) {
      if (o.lod !== 0) continue
      const c = generateChunk(grid, color, height, SIMONET, o.chunkX, o.chunkY)
      const n = c.positions.length / 3
      let zeroY = 0
      let xMin = Number.POSITIVE_INFINITY
      let zMin = Number.POSITIVE_INFINITY
      for (let i = 0; i < c.positions.length; i += 3) {
        if (c.positions[i + 1] === 0) zeroY++
        const x = c.positions[i] as number
        const z = c.positions[i + 2] as number
        if (x < xMin) xMin = x
        if (z < zMin) zMin = z
      }
      const tag = `(${o.chunkX},${o.chunkY})`
      if (n !== o.vertexCount) badVerts.push(`${tag} ${n} vs ${o.vertexCount}`)
      if (zeroY !== o.skirtVerts) badSkirt.push(`${tag} ${zeroY} vs ${o.skirtVerts}`)
      // Placement, which is what catches a transposed or off-by-one index.
      // Both spot-checked chunks were on the diagonal, where a transpose does
      // not show.
      if (
        Math.abs(xMin - (o.min[0] as number)) > JITTER_BOUND ||
        Math.abs(zMin - (o.min[2] as number)) > JITTER_BOUND
      ) {
        badBounds.push(
          `${tag} origin ${xMin.toFixed(1)},${zMin.toFixed(1)} vs ${o.min[0]},${o.min[2]}`,
        )
      }
    }

    expect(badVerts).toEqual([])
    expect(badSkirt).toEqual([])
    expect(badBounds).toEqual([])
  })

  it('keeps every chunk mean height within a fraction of its own relief', () => {
    const { height, color } = load()
    const grid = buildVertexGrid(height, SIMONET)
    const sweep = readSweep()

    const deltas: number[] = []
    const worst: Array<[string, number]> = []
    for (const o of Object.values(sweep.chunks)) {
      if (o.lod !== 0) continue
      const c = generateChunk(grid, color, height, SIMONET, o.chunkX, o.chunkY)
      let sum = 0
      const n = c.positions.length / 3
      for (let i = 1; i < c.positions.length; i += 3) sum += c.positions[i] as number
      const d = sum / n - o.heightMean
      deltas.push(d)
      worst.push([`(${o.chunkX},${o.chunkY})`, d])
    }

    const rms = Math.sqrt(deltas.reduce((p, c) => p + c * c, 0) / deltas.length)
    worst.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))

    // With both import bugs present: rms 1.543, worst chunk 6.793 m.
    // With them fixed:                rms 0.051, worst chunk 0.236 m.
    //
    // A 30x improvement, and the bounds sit just above the fixed pipeline so
    // that reintroducing either bug fails here instead of being absorbed. The
    // residual is the jitter draw (DEV-006), which is zero-mean and cannot be
    // matched by construction.
    expect(
      rms,
      `worst chunks: ${worst
        .slice(0, 5)
        .map(([k, v]) => `${k} ${v.toFixed(2)}`)
        .join(', ')}`,
    ).toBeLessThan(0.15)
    expect(Math.abs(worst[0]?.[1] ?? 0)).toBeLessThan(0.6)
  })

  // ── The skirt's normals, which positions cannot see ───────────────────
  //
  // A skirt quad is a vertical wall. Its own face normal is horizontal, and
  // 2016 throws that away: `FacetedTerrain.cs:1031-1038` stamps each edge skirt
  // with the normal of the INTERIOR triangle sharing its boundary edge, so a
  // skirt exposed through a LOD seam shades as a continuation of the terrain
  // beside it rather than as a lit sliver.
  //
  // The port shipped the skirt GEOMETRY without the stamp. Nothing else here
  // could see it — the positions are identical either way, so every structural
  // test above passed — and the symptom was a pale dashed line down every seam,
  // which at fog range reads as the horizon bleeding through the mountain.
  //
  // What is asserted is the RULE, not the numbers. Our jitter is a seeded PRNG
  // and not Unity's `Random.insideUnitSphere`, so no two corresponding faces
  // share a normal to any useful precision and a value comparison would only
  // ever measure the RNG. The relation between a skirt quad and its neighbour
  // is jitter-independent, holds inside each mesh separately, and is the thing
  // that was actually wrong.
  const skirtStampFailures = (
    vertices: ArrayLike<number>,
    normals: ArrayLike<number>,
    quadPerChunk: number,
    tag: string,
  ): { failures: string[]; checked: number } => {
    const quadsPerSide = quadPerChunk + 2
    const at = (a: ArrayLike<number>, i: number): number[] => [
      a[i * 3] as number,
      a[i * 3 + 1] as number,
      a[i * 3 + 2] as number,
    ]
    const close = (a: number[], b: number[], eps: number): boolean =>
      a.every((v, i) => Math.abs(v - (b[i] as number)) <= eps)

    const failures: string[] = []
    let checked = 0
    for (let qx = -1; qx <= quadPerChunk; qx++) {
      for (let qy = -1; qy <= quadPerChunk; qy++) {
        const lowX = qx === -1
        const highX = qx === quadPerChunk
        const lowY = qy === -1
        const highY = qy === quadPerChunk
        // Corner quads have two boundary edges and no single right answer;
        // `FacetedTerrain.cs:1032` bounds the stamp at `i < quadPerSide` and
        // leaves them alone, so they are out of scope here too.
        if (!(lowX || highX || lowY || highY)) continue
        if ((lowX || highX) && (lowY || highY)) continue
        checked++

        const q = (qx + 1) * quadsPerSide + (qy + 1)
        const inner =
          ((lowX ? 0 : highX ? quadPerChunk - 1 : qx) + 1) * quadsPerSide +
          ((lowY ? 0 : highY ? quadPerChunk - 1 : qy) + 1)

        // Both of the skirt quad's triangles must carry one normal, and it must
        // not be the wall's own — a vertical wall's normal has y exactly 0.
        const n0 = at(normals, q * 6)
        const n1 = at(normals, q * 6 + 3)
        if (!close(n0, n1, 1e-6)) {
          failures.push(`${tag} quad ${qx},${qy}: two normals ${n0} / ${n1}`)
          continue
        }
        if (n0[1] === 0) {
          failures.push(`${tag} quad ${qx},${qy}: unstamped wall normal ${n0}`)
          continue
        }

        // The skirt vertices NOT pinned to y = 0 are the boundary edge. The
        // interior triangle sharing them is the one whose normal belongs here.
        const edge: number[][] = []
        for (let k = 0; k < 6; k++) {
          const v = at(vertices, q * 6 + k)
          if (v[1] !== 0 && !edge.some((e) => close(e, v, 0))) edge.push(v)
        }
        if (edge.length !== 2) {
          failures.push(`${tag} quad ${qx},${qy}: ${edge.length} unpinned verts, expected 2`)
          continue
        }
        const owner = [0, 1].find((half) => {
          const tri = [0, 1, 2].map((k) => at(vertices, inner * 6 + half * 3 + k))
          return edge.every((e) => tri.some((t) => close(t, e, 1e-4)))
        })
        if (owner === undefined) {
          failures.push(`${tag} quad ${qx},${qy}: no interior triangle shares the edge`)
          continue
        }
        const expected = at(normals, inner * 6 + owner * 3)
        if (!close(n0, expected, 1e-6)) {
          failures.push(`${tag} quad ${qx},${qy}: ${n0} but neighbour is ${expected}`)
        }
      }
    }
    return { failures, checked }
  }

  it('stamps the skirt with its neighbour triangle — in the bake, and in ours', () => {
    const { height, color } = load()
    const grid = buildVertexGrid(height, SIMONET)
    const quadPerChunk = ISLANDS.chunkSize / ISLANDS.baseResolution

    const dumps = fs
      .readdirSync(ORACLE_DIR)
      .filter((f) => /^simonet\.islands_x\d+_y\d+_lod0\.json$/.test(f))
    expect(dumps.length).toBeGreaterThanOrEqual(8)

    const bad: string[] = []
    let checkedTotal = 0
    for (const f of dumps) {
      const raw = JSON.parse(fs.readFileSync(path.join(ORACLE_DIR, f), 'utf8')) as {
        chunk: [number, number]
        vertices: number[][]
        normals: number[][] | null
      }
      // A sweep from before `--dump` carried normals would make this pass on
      // nothing. Re-run `pnpm oracle:sweep` instead.
      expect(raw.normals, `${f} has no normals; re-run pnpm oracle:sweep`).toBeTruthy()

      const flat = (rows: number[][]): number[] => rows.flat()
      const oracle = skirtStampFailures(
        flat(raw.vertices),
        flat(raw.normals as number[][]),
        quadPerChunk,
        `bake ${f}`,
      )
      const mine = generateChunk(grid, color, height, SIMONET, raw.chunk[0], raw.chunk[1], 0)
      const ours = skirtStampFailures(
        mine.positions,
        mine.normals,
        quadPerChunk,
        `ours ${raw.chunk}`,
      )

      expect(oracle.checked).toBe(quadPerChunk * 4)
      expect(ours.checked).toBe(oracle.checked)
      checkedTotal += oracle.checked
      bad.push(...oracle.failures, ...ours.failures)
    }
    expect(checkedTotal).toBe(dumps.length * quadPerChunk * 4)
    expect(bad.slice(0, 12)).toEqual([])
  })

  it('samples the heightmap the way Unity did, at every dumped grid point', () => {
    // The sharpest available test. Jitter is applied ONCE per grid point, so
    // every split copy of a vertex carries the same height — which means a
    // bake vertex's y is exactly `h(u,v) + jitter.y * randomOffset`, and any
    // disagreement beyond `randomOffset` is the sampler, not the jitter.
    const { height } = load()
    const rgb = { r: 0, g: 0, b: 0 }
    const dumps = fs
      .readdirSync(ORACLE_DIR)
      .filter((f) => /^simonet\.islands_x\d+_y\d+_lod0\.json$/.test(f))
    expect(dumps.length).toBeGreaterThanOrEqual(8)

    let total = 0
    let beyond = 0
    let sq = 0
    for (const f of dumps) {
      const raw = JSON.parse(fs.readFileSync(path.join(ORACLE_DIR, f), 'utf8')) as {
        vertices: number[][]
      }
      const points = new Map<string, number>()
      for (const v of raw.vertices) {
        const y = v[1] as number
        if (y === 0) continue // the skirt ring is pinned, not sampled
        const gx = Math.round((v[0] as number) / ISLANDS.baseResolution)
        const gz = Math.round((v[2] as number) / ISLANDS.baseResolution)
        points.set(`${gx},${gz}`, y)
      }
      for (const [k, y] of points) {
        const [gx, gz] = k.split(',').map(Number) as [number, number]
        const u = (gx * ISLANDS.baseResolution) / SIMONET.terrainSize
        const v = (gz * ISLANDS.baseResolution) / SIMONET.terrainSize
        if (u < 0 || u > 1 || v < 0 || v > 1) continue
        height.sample(u, v, rgb)
        const err = y - grayscale(rgb.r, rgb.g, rgb.b) * SIMONET.terrainHeight
        total++
        sq += err * err
        if (Math.abs(err) > JITTER_BOUND) beyond++
      }
    }

    const pctBeyond = (100 * beyond) / total
    const rms = Math.sqrt(sq / total)
    // Measured: 48.5% beyond / rms 1.71 with the texel-addressing bug alone,
    // and ~90% on steep chunks with both. Fixed pipeline: 1.57% / rms 0.959,
    // against a jitter floor of randomOffset * sqrt(1/5) = 0.581.
    //
    // The last 1.57% is `resampleBilinear` not being byte-identical to Unity's
    // 2016 importer — DEV-007, measured rather than chased.
    expect(pctBeyond, `${beyond}/${total} grid points beyond the jitter bound`).toBeLessThan(3)
    expect(rms).toBeLessThan(1.1)
  })
})

describe.skipIf(available)('Simonet oracle sweep — not available', () => {
  it('is skipped loudly rather than passing vacuously', () => {
    expect(available).toBe(false)
  })
})
