// tests/unit/chunk-drain.test.ts — the chunk swap, after DEV-242.
//
// Three things are under test and they are three different KINDS of claim:
//
//  1. **`planChunkDrain`'s arithmetic** — new behaviour, so the test can only
//     pin it, not fail on the old tree. Both of its rules are pinned, because
//     the failure mode of a budget is not "wrong number", it is "deadlock"
//     (take nothing for ever) or "no budget at all" (take everything), and a
//     test of the happy middle catches neither.
//
//  2. **`boundingSphereOf` against three's own `computeBoundingSphere`** — the
//     worker now computes the culling sphere and the main thread trusts it, so
//     the claim *"this reproduces three"* is load-bearing and is checked
//     against three's BUILD rather than against this file's arithmetic. Same
//     discipline as `xr-eye-layers.test.ts` (DEV-141) and CLAUDE.md trap 24:
//     assert the relationship to the oracle, not a value written out twice.
//
//  3. **A structural guard on `worker.onmessage`** — and this is the one that
//     FAILS ON THE UNFIXED TREE. Before DEV-242 that handler built the
//     geometry, baked it, acquired a fade pair and set `slot.fade`, all inside
//     the task that received the message. The guard says it may now do nothing
//     but push, which is exactly the thing that was wrong and the thing that
//     would be quietly undone by anyone "simplifying" the queue away.
//
// (2) and (3) together are the answer to *"is a chunk waiting in the queue
// counted as fading?"*: `slot.fade` is assigned in exactly one place, and that
// place runs at DRAIN time. A queued arrival cannot be fading because nothing
// on the arrival path can set the field.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  CHUNK_VERTEX_BYTES,
  DRAIN_VERTEX_BUDGET,
  planChunkDrain,
} from '@/game/terrain/load-terrain'
import { chunkGeometry, chunkGeometryFromArrays } from '@/render/terrain-mesh'
import { boundingSphereOf, finishChunk } from '@/sim/terrain/chunk-to-three'
import {
  buildVertexGrid,
  type FacetedTerrainParams,
  generateChunk,
  type MapSampler,
} from '@/sim/terrain/faceted'
import { REPO as ROOT } from './helpers/repo-root'

/** A land chunk at LOD 0 on the shipped islands: 2,312 triangles. */
const LAND_LOD0_VERTICES = 6_936
/**
 * An ocean chunk at LOD 0 on the shipped sea: 2,312 triangles x 8^2.
 *
 * The number this whole row is about. It is thirteen times the drain budget on
 * its own, which is why rule 2 of `planChunkDrain` exists.
 */
const OCEAN_LOD0_VERTICES = 443_904

describe('planChunkDrain — a budget in vertices, because a chunk is not a unit', () => {
  it('spends up to the budget and leaves the rest for the next frame', () => {
    // Four land chunks fit in 32,768 vertices (27,744); a fifth does not
    // (34,680). So a burst of ten drains four a frame.
    const burst = Array.from({ length: 10 }, () => LAND_LOD0_VERTICES)
    expect(planChunkDrain(burst)).toBe(4)
    expect(4 * LAND_LOD0_VERTICES).toBeLessThanOrEqual(DRAIN_VERTEX_BUDGET)
    expect(5 * LAND_LOD0_VERTICES).toBeGreaterThan(DRAIN_VERTEX_BUDGET)
  })

  it('drains a burst over several frames rather than in one', () => {
    // The behaviour the row is for, stated as a loop rather than as a number:
    // ten arrivals in one tick must take more than one frame to land, and must
    // land eventually.
    const queue = Array.from({ length: 10 }, () => LAND_LOD0_VERTICES)
    let frames = 0
    while (queue.length > 0) {
      const take = planChunkDrain(queue)
      expect(take).toBeGreaterThan(0)
      queue.splice(0, take)
      frames++
      expect(frames).toBeLessThan(20)
    }
    expect(frames).toBeGreaterThan(1)
  })

  it('ALWAYS takes at least one, however big it is — a budget that can deadlock is not a budget', () => {
    // The ocean chunk. Thirteen times the whole budget; if the budget could
    // veto it the sea would freeze at whatever LOD it happened to be on and
    // the queue would never move again.
    expect(planChunkDrain([OCEAN_LOD0_VERTICES])).toBe(1)
    expect(planChunkDrain([OCEAN_LOD0_VERTICES, LAND_LOD0_VERTICES])).toBe(1)
    // And it is the FIRST one that is exempt, not the biggest: an oversized
    // arrival behind a small one waits its turn rather than jumping it.
    expect(planChunkDrain([LAND_LOD0_VERTICES, OCEAN_LOD0_VERTICES])).toBe(1)
  })

  it('takes nothing from an empty queue', () => {
    expect(planChunkDrain([])).toBe(0)
  })

  it('is a budget on BYTES wearing a vertex count, and the doc comment says the right ones', () => {
    // `CHUNK_VERTEX_BYTES` exists so the budget's real unit is written down
    // once rather than as "44" in a comment — and CLAUDE.md is clear that a
    // constant nothing reads is documentation, not a guard, so this reads it.
    // The two figures its doc comment quotes are checked here rather than
    // trusted: 1.44 MB of upload, and one ocean chunk thirteen times that.
    expect(CHUNK_VERTEX_BYTES).toBe(12 + 12 + 12 + 8)
    const mb = (DRAIN_VERTEX_BUDGET * CHUNK_VERTEX_BYTES) / 1e6
    expect(mb).toBeGreaterThan(1.4)
    expect(mb).toBeLessThan(1.5)
    expect(Math.floor(OCEAN_LOD0_VERTICES / DRAIN_VERTEX_BUDGET)).toBe(13)
  })

  it('honours a budget passed in, so the value is not the behaviour', () => {
    // The constant is insurance, not a measurement (see its doc comment). The
    // rule must hold at any budget, which is what makes the test a test of the
    // arithmetic rather than of the number.
    expect(planChunkDrain([10, 10, 10], 25)).toBe(2)
    expect(planChunkDrain([10, 10, 10], 30)).toBe(3)
    expect(planChunkDrain([10, 10, 10], 1)).toBe(1)
  })
})

// ── a real chunk to measure against ──────────────────────────────────────

const params: FacetedTerrainParams = {
  terrainSize: 256,
  terrainHeight: 64,
  chunkSize: 64,
  baseResolution: 8,
  // NON-zero, deliberately: the jitter is what makes the subdivided positions
  // something other than a plane, and a bounding sphere over a plane would
  // agree with three's for uninteresting reasons.
  randomOffset: 1.3,
  seed: 12345,
}

const heightMap = (): MapSampler => ({
  width: 128,
  height: 128,
  sample(u, v, out) {
    const h = 0.5 + 0.4 * Math.sin(u * Math.PI * 5) * Math.cos(v * Math.PI * 3)
    out.r = h
    out.g = h
    out.b = h
  },
})

const colorMap = (): MapSampler => ({
  width: 128,
  height: 128,
  sample(u, v, out) {
    out.r = u
    out.g = v
    out.b = 0.5
  },
})

const height = heightMap()
const color = colorMap()
const grid = buildVertexGrid(height, params)
const rawChunk = (lod = 0) => generateChunk(grid, color, height, params, 1, 1, lod)

describe("boundingSphereOf reproduces three's own computeBoundingSphere", () => {
  // Every case the streaming path can actually produce: a plain land chunk, a
  // coarser band, and a SUBDIVIDED one, which is the ocean's shape and the only
  // one where the jitter moves vertices off the parent plane.
  for (const [label, lod, subdivide] of [
    ['land, LOD 0', 0, 1],
    ['land, LOD 2', 2, 1],
    ['sea-shaped, LOD 0 x4', 0, 4],
    ['sea-shaped, LOD 1 x2', 1, 2],
  ] as const) {
    it(`agrees to the bit on ${label}`, () => {
      const arrays = finishChunk(rawChunk(lod), subdivide, params.randomOffset)

      // THREE'S OWN ANSWER, computed by three, on the same bytes. Not a
      // formula restated here — that would prove only that two copies of one
      // expression agree, which is the trap trap 24 names.
      const oracle = new THREE.BufferGeometry()
      oracle.setAttribute('position', new THREE.BufferAttribute(arrays.positions, 3))
      oracle.computeBoundingSphere()
      const want = oracle.boundingSphere as THREE.Sphere

      const got = boundingSphereOf(arrays.positions)
      // `toBe`, not `toBeCloseTo`. A culling sphere a hair small pops a chunk
      // out at the edge of the screen, and "close enough" is how that ships.
      expect(got.x).toBe(want.center.x)
      expect(got.y).toBe(want.center.y)
      expect(got.z).toBe(want.center.z)
      expect(got.radius).toBe(want.radius)
      // And it is a real sphere, not a degenerate one that would agree with
      // anything: the fixture has relief and the subdivision has jitter.
      expect(got.radius).toBeGreaterThan(0)
    })
  }

  it('gives three’s answer for an empty geometry rather than NaN', () => {
    // `Box3.getCenter` on an empty box is the origin; the radius is 0. Reached
    // by no shipped chunk, which is exactly why it is worth pinning: an
    // Infinity leaking out of the min/max scan would cull the whole terrain.
    const oracle = new THREE.BufferGeometry()
    oracle.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
    oracle.computeBoundingSphere()
    const want = oracle.boundingSphere as THREE.Sphere
    const got = boundingSphereOf(new Float32Array(0))
    expect([got.x, got.y, got.z, got.radius]).toEqual([
      want.center.x,
      want.center.y,
      want.center.z,
      want.radius,
    ])
  })
})

describe('the streamed chunk and the loaded chunk are the same chunk', () => {
  // `chunkGeometry` (the synchronous initial build, and every older test's
  // entry point) and `chunkGeometryFromArrays(finishChunk(...))` (what the
  // worker and the drain now do between them) must produce identical geometry,
  // or the island refines into a different island than it loaded as.
  for (const subdivide of [1, 4]) {
    it(`matches byte for byte at subdivide ${subdivide}`, () => {
      const raw = rawChunk(0)
      const loaded = chunkGeometry(raw, subdivide, params.randomOffset)
      const streamed = chunkGeometryFromArrays(finishChunk(raw, subdivide, params.randomOffset))

      for (const name of ['position', 'normal', 'color', 'uv']) {
        const a = loaded.getAttribute(name).array as Float32Array
        const b = streamed.getAttribute(name).array as Float32Array
        expect(b.length, name).toBe(a.length)
        expect(Array.from(b), name).toEqual(Array.from(a))
      }

      const a = loaded.boundingSphere as THREE.Sphere
      const b = streamed.boundingSphere as THREE.Sphere
      expect(b.center.toArray()).toEqual(a.center.toArray())
      expect(b.radius).toBe(a.radius)
      // The point of the whole exercise: the streamed geometry's arrays are
      // the ones handed in, not copies of them.
      const arrays = finishChunk(raw, subdivide, params.randomOffset)
      const wrapped = chunkGeometryFromArrays(arrays)
      expect(wrapped.getAttribute('position').array).toBe(arrays.positions)
      expect(wrapped.getAttribute('uv').array).toBe(arrays.uvs)
    })
  }
})

describe('the arrival path does nothing but queue — the guard that fails on the old tree', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/game/terrain/load-terrain.ts'), 'utf8')

  /** The body of the `worker.onmessage = …` assignment, braces balanced. */
  const onmessageBody = (): string => {
    const at = source.indexOf('worker.onmessage =')
    expect(at, 'worker.onmessage assignment not found').toBeGreaterThan(-1)
    const open = source.indexOf('{', source.indexOf('=>', at))
    let depth = 0
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i)
    }
    throw new Error('unbalanced braces after worker.onmessage')
  }

  it('pushes the reply and does not build anything', () => {
    const body = onmessageBody()
    expect(body).toContain('arrivals.push')
    // Each of these WAS in that handler before DEV-242, and each is a way of
    // doing a chunk's whole swap in the task that received the message —
    // which is the defect. This assertion is red on the pre-DEV-242 tree.
    for (const banned of [
      'chunkGeometry',
      'bakeGeometry',
      'fadePool',
      'slot.fade',
      'slot.lod',
      'group.add',
      'pending--',
    ]) {
      expect(body, `worker.onmessage must not reach ${banned}`).not.toContain(banned)
    }
  })

  it('assigns slot.fade in exactly one place, and it is not on the arrival path', () => {
    // "A chunk waiting in the queue is not counted as fading" is true by
    // construction rather than by care: `fadingChunks` counts slots whose
    // `fade` is set, and the field is written only where the swap happens.
    const writes = source.match(/slot\.fade = /g) ?? []
    expect(writes.length).toBe(2) // the fade is started in one place, cleared in one
    expect(source).toContain('slot.fade = null')
    expect(onmessageBody()).not.toContain('slot.fade')
  })

  it('counts a queued arrival as PENDING, so the trace cannot go blind', () => {
    // `terr_pending` / `sea_pending` mean "a chunk is on its way and the
    // picture has not caught up". A queue that did not count would make those
    // columns read zero while streaming was still happening — the instrument
    // disabled by the fix for the thing it was built to see.
    expect(source).toContain('return pending + arrivals.length')
  })
})
