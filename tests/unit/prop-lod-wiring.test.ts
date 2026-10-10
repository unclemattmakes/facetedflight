// tests/unit/prop-lod-wiring.test.ts — DEV-225's plan reaching the MESH.
//
// `prop-instance-plan.test.ts` proves the arithmetic. This proves the half that
// touches three: that a plan becomes `InstancedMesh.count` and the right sixty
// matrices at the front of `instanceMatrix`, that the reveal is driven by
// 2016's own `lodDistance` off the environment JSON, and — the one with teeth —
// that a HIDDEN prop stays hidden across a repack.
//
// That last one is the bug this file exists for. Before DEV-225 an
// `InstanceRef` was `{inst, index}` and `hide` wrote `ZERO_MATRIX` at
// `instanceMatrix[index]`, which was correct while the buffer never moved. It
// moves now: the drawn buffer is a compacted PREFIX of a source buffer, so slot
// `k` holds a different prop every time the visible chunk set changes. A `hide`
// written to the live slot would delete whichever tree was standing there and
// resurrect the fractured one on the next repack — and it would look like the
// fracture "sometimes not working", which is the hardest kind of report to act
// on.
//
// No GL: an `InstancedMesh`'s `instanceMatrix` is a plain
// `InstancedBufferAttribute` and nothing here renders.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { PropScatter } from '@/content/load-environment'
import type { ChunkRun } from '@/game/props/instance-plan'
import {
  createPassLod,
  createScatterBatch,
  type LoadPropsOptions,
  scatterRef,
} from '@/game/props/load-props'
import desertJson from '../../content/environments/desert.json'

/** Three chunks, ten instances each, each instance marked by its x. */
const CHUNK_SIZE = 256
const PER_CHUNK = 10
const RUNS: ChunkRun[] = [
  { chunk: 0, start: 0, count: PER_CHUNK },
  { chunk: 1, start: PER_CHUNK, count: PER_CHUNK },
  { chunk: 2, start: 2 * PER_CHUNK, count: PER_CHUNK },
]
const TOTAL = RUNS.length * PER_CHUNK

/**
 * A batch whose instance `i` sits at x = i, so a matrix read back names the
 * source slot it came from. Marking the DATA rather than trusting the index is
 * what makes "the right matrices are at the front" checkable at all.
 */
const stubBatch = () => {
  const inst = new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.Material(), TOTAL)
  const batch = createScatterBatch(inst, RUNS)
  const m = new THREE.Matrix4()
  for (let i = 0; i < TOTAL; i++) batch.setSource(i, m.makeTranslation(i, 0, 0))
  batch.apply({ count: TOTAL, spans: [{ src: 0, dst: 0, count: TOTAL }] })
  return { inst, batch }
}

/** The x of every DRAWN instance, in draw order. */
const drawnXs = (inst: THREE.InstancedMesh): number[] => {
  const m = new THREE.Matrix4()
  const out: number[] = []
  for (let k = 0; k < inst.count; k++) {
    inst.getMatrixAt(k, m)
    out.push(m.elements[12] as number)
  }
  return out
}

describe("three's own build, on what count 0 actually costs", () => {
  it('skips the draw entirely at zero instances — the call, not the state setup', () => {
    // The claim DEV-225 rests on is "the draw count never RISES", and the half
    // of it that is about three rather than about us is this: a batch whose
    // whole visible set is empty must not still issue a call. It is the DRAW
    // that goes — `renderBufferDirect` has already bound the geometry and set
    // the program up by the time it gets here, so an all-hidden batch is cheap
    // and not free, and the honest claim is that the count can only fall.
    // Read out of
    // three's own build rather than believed, the way `xr-eye-layers.test.ts`
    // does — those are three's internals, not its API, and `three` is pinned
    // exact only until `three-mesh-bvh`'s ceiling is accepted.
    //
    // Inside the `it`, not above it: a `describe` body runs during COLLECTION
    // and this reads the disk (CLAUDE.md).
    const build = fs.readFileSync(
      path.join(process.cwd(), 'node_modules/three/build/three.module.js'),
      'utf8',
    )
    // Both buffer renderers — indexed and non-indexed — bail on primcount 0.
    const bails = [
      ...build.matchAll(
        /function renderInstances\([^)]*\)\s*\{\s*if \( primcount === 0 \) return;/g,
      ),
    ]
    expect(bails.length, 'three no longer short-circuits a zero-instance draw').toBe(2)
  })
})

describe('a ScatterBatch draws the plan and nothing else', () => {
  it('starts with every instance drawn, in source order', () => {
    const { inst } = stubBatch()
    expect(inst.count).toBe(TOTAL)
    expect(drawnXs(inst)).toEqual([...Array(TOTAL).keys()])
  })

  it('compacts a plan to the front and moves count, not the source', () => {
    const { inst, batch } = stubBatch()
    batch.apply({
      count: 2 * PER_CHUNK,
      spans: [
        { src: 0, dst: 0, count: PER_CHUNK },
        { src: 2 * PER_CHUNK, dst: PER_CHUNK, count: PER_CHUNK },
      ],
    })
    expect(inst.count).toBe(2 * PER_CHUNK)
    // Chunk 0 then chunk 2 — the CONTENT, not just the count.
    expect(drawnXs(inst)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
    ])
    // And the source is untouched, so the plan is reversible.
    const m = new THREE.Matrix4()
    for (let i = 0; i < TOTAL; i++) expect(batch.getSource(i, m).elements[12]).toBe(i)
  })

  it('draws nothing at count 0 rather than leaving the last frame up', () => {
    const { inst, batch } = stubBatch()
    batch.apply({ count: 0, spans: [] })
    expect(inst.count).toBe(0)
    expect(drawnXs(inst)).toEqual([])
  })
})

describe('hide survives a repack — the reason InstanceRef is not an index', () => {
  it('keeps a hidden prop hidden after the visible set moves', () => {
    const { inst, batch } = stubBatch()
    // Hide instance 25, which lives in chunk 2 and is currently drawn at slot 25.
    const ref = scatterRef(batch, 25)
    ref.hide()
    expect(drawnXs(inst)[25]).toBe(0)

    // Now the visible set changes so chunk 2 moves to the FRONT of the buffer.
    batch.apply({ count: PER_CHUNK, spans: [{ src: 2 * PER_CHUNK, dst: 0, count: PER_CHUNK }] })
    const xs = drawnXs(inst)
    expect(xs.length).toBe(PER_CHUNK)
    // Source 25 is chunk 2's sixth instance, now at slot 5, and still hidden.
    expect(xs[5]).toBe(0)
    // Its neighbours came through untouched: a hide that hit the wrong slot
    // would show up here as a second zero or a missing 24.
    expect(xs).toEqual([20, 21, 22, 23, 24, 0, 26, 27, 28, 29])
  })

  it('reports the matrix it was BUILT with, not the slot it happens to occupy', () => {
    const { batch } = stubBatch()
    batch.apply({ count: PER_CHUNK, spans: [{ src: 2 * PER_CHUNK, dst: 0, count: PER_CHUNK }] })
    // Slot 0 of the drawn buffer is source 20; `drawn(id)` must answer for the
    // SOURCE, or the fracture would spawn its debris at another prop's rock.
    expect(scatterRef(batch, 7).matrix(new THREE.Matrix4()).elements[12]).toBe(7)
    expect(scatterRef(batch, 20).matrix(new THREE.Matrix4()).elements[12]).toBe(20)
  })
})

// ── the pass, driven by 2016's own number off the environment JSON ────────

const desertPass = desertJson.scatter[0] as unknown as PropScatter

const options = (over: Partial<LoadPropsOptions> = {}): LoadPropsOptions =>
  ({
    terrain: { terrainSize: 4096, terrainHeight: 1000, chunkSize: CHUNK_SIZE },
    heightMap: null as never,
    ...over,
  }) as LoadPropsOptions

/** Chunk `c`'s centre in the mesh frame, on a 16-per-side grid. */
const centreOf = (c: number): [number, number] => [
  ((c % 16) + 0.5) * CHUNK_SIZE,
  (Math.floor(c / 16) + 0.5) * CHUNK_SIZE,
]

describe('createPassLod reads the extracted lodDistance and drives the batch', () => {
  it('takes 1280 m from the environment JSON, not from anything hand-typed', () => {
    // DEV-214 / hard rule 2: the C# initialiser says 300 and the shipped
    // generator says 1280. This asserts the number arrives from the file.
    expect(desertPass.lodDistance).toBe(1280)
    expect(desertPass.flipFlopPercent).toBe(0.03)
    expect(desertPass.lodTransitionTime).toBe(1)
  })

  it('hides chunks past the radius and shows the ones inside it', () => {
    const { inst, batch } = stubBatch()
    const lod = createPassLod(desertPass, [batch], 16, options())
    expect(lod).not.toBe(null)
    if (!lod) return

    // Sitting on chunk 0's centre: chunks 0, 1 and 2 are 256 m apart in x, so
    // all three are inside 1280 m and all thirty instances draw.
    const [x0, z0] = centreOf(0)
    expect(lod.step(x0, z0, 1)).toBe(TOTAL)
    expect(inst.count).toBe(TOTAL)

    // 4 km away in z: nothing is inside the radius.
    expect(lod.step(x0, z0 + 4000, 1)).toBe(0)
    expect(inst.count).toBe(0)
    expect(drawnXs(inst)).toEqual([])
  })

  it('ignores ALTITUDE, because a flying game must not cull what it flies over', () => {
    // `horizontalDistance` by design — 2016 sets `deltaToChunk.y = 0`. There is
    // no y in this API at all, which is the strongest form of that guarantee:
    // the caller cannot pass one to be ignored.
    const { batch } = stubBatch()
    const lod = createPassLod(desertPass, [batch], 16, options())
    const [x0, z0] = centreOf(0)
    expect(lod?.step(x0, z0, 1)).toBe(TOTAL)
  })

  it('is null when the distance is infinite — ?propLod=off costs nothing', () => {
    const { inst, batch } = stubBatch()
    expect(
      createPassLod(desertPass, [batch], 16, options({ lodDistance: Number.POSITIVE_INFINITY })),
    ).toBe(null)
    // And the batch is left drawing everything, which is the pre-DEV-225 frame.
    expect(inst.count).toBe(TOTAL)
  })

  it('obeys the ?propLod= override rather than the JSON', () => {
    const { inst, batch } = stubBatch()
    // 300 m — the C# initialiser, passed deliberately as an override, which is
    // the ONLY way that number may ever reach the game (DEV-214). Chunks 1 and
    // 2 are 256 and 512 m from chunk 0's centre; at 300 m * 0.97 only chunk 0
    // and chunk 1 are inside.
    const lod = createPassLod(desertPass, [batch], 16, options({ lodDistance: 300 }))
    const [x0, z0] = centreOf(0)
    expect(lod?.step(x0, z0, 1)).toBe(2 * PER_CHUNK)
    expect(drawnXs(inst)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ])
  })

  it('throttles the repack to 2016 own 1/30 s scan', () => {
    // The repack is a memcpy plus a buffer upload per batch and the revealed
    // count moves every frame during a 1 s transition. -1 means "nothing was
    // repacked": at 90 Hz that is two frames in three.
    const { batch } = stubBatch()
    const lod = createPassLod(desertPass, [batch], 16, options())
    const [x0, z0] = centreOf(0)
    lod?.step(x0, z0, 1 / 90)
    // A frame at 90 Hz is under 1/30, so the next two calls do nothing at all.
    expect(lod?.step(x0, z0 + 4000, 1 / 90)).toBe(-1)
    expect(lod?.step(x0, z0 + 4000, 1 / 90)).toBe(-1)
    // The third 1/90 crosses 1/30 and the scan runs — and what it returns is
    // NOT zero, because 2016 stages the hide over `lodTransitionTime`: one
    // scan of a 1 s transition takes `ceil(30 * 1/30)` = 1 instance out of each
    // chunk. Trees leave a few at a time, scattered, which is the look.
    const first = lod?.step(x0, z0 + 4000, 1 / 90) ?? -1
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(TOTAL)
  })

  it('stages the reveal over lodTransitionTime rather than popping a block', () => {
    const { batch } = stubBatch()
    const lod = createPassLod(desertPass, [batch], 16, options())
    const [x0, z0] = centreOf(0)
    expect(lod?.step(x0, z0, 1)).toBe(TOTAL)
    // Walk a whole second of 1/30 s scans away from the forest. The count has
    // to fall MONOTONICALLY and reach zero, not jump.
    const seen: number[] = []
    for (let i = 0; i < 40; i++) {
      const n = lod?.step(x0, z0 + 4000, 1 / 30) ?? -1
      if (n >= 0) seen.push(n)
    }
    expect(seen.length, 'the transition took more than one scan').toBeGreaterThan(5)
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i] as number, `scan ${i}`).toBeLessThanOrEqual(seen[i - 1] as number)
    }
    expect(seen.at(-1)).toBe(0)
  })

  it('has hysteresis, so a chunk parked on the edge does not toggle every scan', () => {
    const { batch } = stubBatch()
    const lod = createPassLod(desertPass, [batch], 16, options())
    const [x0, z0] = centreOf(0)
    // Start far away: everything hidden.
    lod?.step(x0, z0 + 4000, 1)
    // Just OUTSIDE the on-radius (1280 * 0.97 = 1241.6) from chunk 2's centre,
    // which is the furthest of the three: nothing comes back.
    const [, z2] = centreOf(2)
    expect(lod?.step(x0, z2 + 1250, 1)).toBe(-1)
    // Well inside: chunk 2 at least comes back.
    expect(lod?.step(x0, z2 + 200, 1)).toBeGreaterThan(0)
  })
})
