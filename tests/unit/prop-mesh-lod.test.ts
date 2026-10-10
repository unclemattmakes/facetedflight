// tests/unit/prop-mesh-lod.test.ts — DEV-338, the scatter's coarser rungs.
//
// Four layers, each held to something outside itself:
//
//   sim/props/lod.ts          a swap is COMPLEMENTARY — every prop of a chunk is
//                             on exactly one rung at every step — and staggered;
//                             with no edges it is DEV-225's numbers exactly.
//   instance-plan.ts          `packRange` splits every batch at the same slot the
//                             pass-level count does, for any run length.
//   lod-geometry.ts           a rung is smaller, one colour per face, every
//                             colour one the source had, same attribute SET.
//   load-props.ts             the rung meshes are driven, a hidden prop is hidden
//                             on every rung, and a live disable walks back.
//
// No GL and no disk: the geometry is built here, so the suite means the same
// thing on CI as on a hydrated box.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { PropScatter } from '@/content/load-environment'
import { type ChunkRun, packRange, packVisible } from '@/game/props/instance-plan'
import {
  createPassLod,
  createScatterBatch,
  type LoadPropsOptions,
  scatterRef,
} from '@/game/props/load-props'
import { propRungGeometries, simplifyPropGeometry } from '@/game/props/lod-geometry'
import {
  initPropLod,
  type PropLodParams,
  RUNG_OFF,
  rungAt,
  rungShare,
  stepPropLod,
} from '@/sim/props/lod'
import desertJson from '../../content/environments/desert.json'

const PARAMS: PropLodParams = {
  lodDistance: 1000,
  transitionSeconds: 1,
  hysteresis: 0.03,
  scanIntervalSeconds: 1 / 30,
  rungEdges: [200, 500],
}

const chunkAt = (centreX: number, total = 100, halfSize = 0) => [
  { total, centreX, centreZ: 0, halfSize },
]

/** Every rung's share of chunk 0, as counts, and their sum. */
const shares = (rt: ReturnType<typeof initPropLod>, rungs: number) => {
  const c = rt.chunks[0]
  if (!c) throw new Error('no chunk')
  const each = Array.from({ length: rungs }, (_, r) => {
    const [a, b] = rungShare(c, r)
    return b - a
  })
  return { each, sum: each.reduce((x, y) => x + y, 0) }
}

describe('rungAt reads the edges as half-open bands', () => {
  it('puts a distance on the first edge it is inside, and past the last on the last rung', () => {
    expect(rungAt([200, 500], 0)).toBe(0)
    expect(rungAt([200, 500], 199.9)).toBe(0)
    expect(rungAt([200, 500], 200)).toBe(1)
    expect(rungAt([200, 500], 499)).toBe(1)
    expect(rungAt([200, 500], 900)).toBe(2)
    expect(rungAt([], 900)).toBe(0)
  })
})

describe('a chunk changes rung by the staggered reveal, never as a block', () => {
  it('starts on the rung its NEAREST point calls for, not its centre', () => {
    // Centre 300 m away, half-size 128: nearest point 172 m, which is rung 0.
    // A centre-distance rule would have put every tree in it on rung 1 — one
    // of them standing 172 m from the camera.
    const rt = initPropLod(chunkAt(300, 100, 128), 0, 0, PARAMS)
    expect(rt.chunks[0]?.rung).toBe(0)
    // Centre 600, nearest 472: rung 1, where the centre (600) would say rung 2.
    const far = initPropLod(chunkAt(600, 100, 128), 0, 0, PARAMS)
    expect(far.chunks[0]?.rung).toBe(1)
  })

  it('is complementary at every step: each prop on exactly one rung', () => {
    const rt = initPropLod(chunkAt(100), 0, 0, PARAMS)
    expect(shares(rt, 3).each).toEqual([100, 0, 0])
    // Fly away until the chunk is 700 m off: rung 0 -> rung 2 directly.
    const seen: number[][] = []
    for (let i = 0; i < 90; i++) {
      stepPropLod(rt, -600, 0, PARAMS, 1 / 60)
      const s = shares(rt, 3)
      expect(s.sum, `step ${i}`).toBe(100)
      seen.push(s.each)
    }
    // Staggered: some step had props on BOTH meshes.
    expect(seen.some(([a, , c]) => (a as number) > 0 && (c as number) > 0)).toBe(true)
    // And it arrived.
    expect(seen.at(-1)).toEqual([0, 0, 100])
    expect(rt.chunks[0]?.revealed).toBe(100)
  })

  it('does not trade meshes in the hysteresis dead band at a rung edge', () => {
    // Nearest distance exactly on the 200 m edge, from both sides.
    const near = initPropLod(chunkAt(150), 0, 0, PARAMS)
    for (let i = 0; i < 120; i++) stepPropLod(near, -50, 0, PARAMS, 1 / 60)
    expect(near.chunks[0]?.rung).toBe(0)
    const far = initPropLod(chunkAt(250), 0, 0, PARAMS)
    expect(far.chunks[0]?.rung).toBe(1)
    for (let i = 0; i < 120; i++) stepPropLod(far, 50, 0, PARAMS, 1 / 60)
    expect(far.chunks[0]?.rung).toBe(1)
  })

  it('reveals from OFF onto the rung the distance calls for, and hides from it', () => {
    const rt = initPropLod(chunkAt(5000), 0, 0, PARAMS)
    expect(rt.chunks[0]?.rung).toBe(RUNG_OFF)
    // Arrive 700 m from it: rung 2, revealed a few at a time.
    const counts: number[] = []
    for (let i = 0; i < 90; i++) {
      stepPropLod(rt, 4300, 0, PARAMS, 1 / 60)
      counts.push(shares(rt, 3).each[2] as number)
      expect(shares(rt, 3).each.slice(0, 2)).toEqual([0, 0])
    }
    expect(counts[0]).toBeLessThan(100)
    expect(counts.at(-1)).toBe(100)
    // And leaving: the rung empties to OFF, monotonically.
    let last = 100
    for (let i = 0; i < 90; i++) {
      stepPropLod(rt, 0, 0, PARAMS, 1 / 60)
      const now = shares(rt, 3).sum
      expect(now).toBeLessThanOrEqual(last)
      last = now
    }
    expect(last).toBe(0)
    expect(rt.chunks[0]?.rung).toBe(RUNG_OFF)
  })

  it('walks back to rung 0 when the edges go away mid-flight (a live disable)', () => {
    const rt = initPropLod(chunkAt(700), 0, 0, PARAMS)
    expect(rt.chunks[0]?.rung).toBe(2)
    const off: PropLodParams = { ...PARAMS, rungEdges: [] }
    for (let i = 0; i < 90; i++) {
      stepPropLod(rt, 0, 0, off, 1 / 60)
      expect(shares(rt, 3).sum).toBe(100)
    }
    expect(shares(rt, 3).each).toEqual([100, 0, 0])
  })

  it('with NO edges is DEV-225 exactly: the same revealed count, step for step', () => {
    const one: PropLodParams = { ...PARAMS, rungEdges: [] }
    const none: PropLodParams = {
      lodDistance: 1000,
      transitionSeconds: 1,
      hysteresis: 0.03,
      scanIntervalSeconds: 1 / 30,
    }
    const a = initPropLod(chunkAt(5000, 37), 0, 0, one)
    const b = initPropLod(chunkAt(5000, 37), 0, 0, none)
    const path = [5000, 5000, 4500, 4200, 0, 0, -900, 3000]
    for (const x of path) {
      for (let i = 0; i < 20; i++) {
        stepPropLod(a, x, 0, one, 1 / 45)
        stepPropLod(b, x, 0, none, 1 / 45)
        expect(a.chunks[0]?.revealed).toBe(b.chunks[0]?.revealed)
        // And on one rung, rung 0 draws what `revealed` says.
        expect(shares(a, 1).each[0]).toBe(a.chunks[0]?.revealed)
      }
    }
  })
})

describe('packRange splits every batch at the same slot', () => {
  it('two rungs handed [0,f) and [f,1) cover every run exactly once, for any length', () => {
    for (let n = 1; n < 40; n++) {
      const runs: ChunkRun[] = [{ chunk: 7, start: 3, count: n }]
      for (let moved = 0; moved <= 23; moved++) {
        const f = moved / 23
        const newer = packRange(runs, () => [0, f])
        const older = packRange(runs, () => [f, 1])
        expect(newer.count + older.count, `n=${n} f=${f}`).toBe(n)
        if (newer.count > 0 && older.count > 0) {
          // Abutting in the SOURCE: where one stops the other starts.
          const a = newer.spans[0]
          const b = older.spans[0]
          expect((a?.src as number) + (a?.count as number)).toBe(b?.src)
        }
      }
    }
  })

  it('is packVisible when the range starts at zero', () => {
    const runs: ChunkRun[] = [
      { chunk: 0, start: 0, count: 10 },
      { chunk: 1, start: 10, count: 7 },
    ]
    for (const f of [0, 0.2, 0.5, 1]) {
      expect(packRange(runs, () => [0, f])).toEqual(packVisible(runs, () => f))
    }
  })

  it('does not merge a slice that starts part-way into its run', () => {
    const runs: ChunkRun[] = [
      { chunk: 0, start: 0, count: 10 },
      { chunk: 1, start: 10, count: 10 },
    ]
    const plan = packRange(runs, (c) => (c === 0 ? [0, 1] : [0.5, 1]))
    expect(plan.spans).toEqual([
      { src: 0, dst: 0, count: 10 },
      { src: 15, dst: 10, count: 5 },
    ])
  })
})

/**
 * A faceted test prop: an icosphere split per face, each face one colour from
 * a small palette, with a `uv1` it does not use — `cactus-tall-03`'s shape.
 */
const facetedProp = (): THREE.BufferGeometry => {
  const g = new THREE.IcosahedronGeometry(10, 4).toNonIndexed()
  const n = g.getAttribute('position').count
  const palette = [
    [0.2, 0.5, 0.1, 1],
    [0.4, 0.3, 0.1, 1],
    [0.1, 0.4, 0.2, 1],
  ]
  const colour = new Float32Array(n * 4)
  for (let t = 0; t < n / 3; t++) {
    const c = palette[t % palette.length] as number[]
    for (let k = 0; k < 3; k++) colour.set(c, (t * 3 + k) * 4)
  }
  g.setAttribute('color', new THREE.BufferAttribute(colour, 4))
  g.setAttribute('uv1', new THREE.BufferAttribute(new Float32Array(n * 2), 2))
  return g
}

const triangles = (g: THREE.BufferGeometry): number =>
  (g.index ? g.index.count : g.getAttribute('position').count) / 3

describe('simplifyPropGeometry', () => {
  it('is smaller, and smaller again at a lower keep', () => {
    const src = facetedProp()
    const mid = simplifyPropGeometry(src, 0.35)
    const far = simplifyPropGeometry(src, 0.12)
    expect(mid).not.toBeNull()
    expect(far).not.toBeNull()
    const [s, m, f] = [triangles(src), triangles(mid as never), triangles(far as never)]
    expect(m).toBeLessThan(s * 0.6)
    expect(f).toBeLessThan(m)
  })

  it('keeps one colour per face, and every colour is one the source had', () => {
    const src = facetedProp()
    const out = simplifyPropGeometry(src, 0.2) as THREE.BufferGeometry
    const srcColours = new Set<string>()
    const sc = src.getAttribute('color')
    for (let v = 0; v < sc.count; v++) {
      srcColours.add([sc.getX(v), sc.getY(v), sc.getZ(v), sc.getW(v)].join(','))
    }
    const c = out.getAttribute('color')
    expect(c.itemSize).toBe(4)
    for (let t = 0; t < c.count / 3; t++) {
      const face = [0, 1, 2].map((k) => {
        const v = t * 3 + k
        return [c.getX(v), c.getY(v), c.getZ(v), c.getW(v)].join(',')
      })
      expect(new Set(face).size, `face ${t} is one colour`).toBe(1)
      expect(srcColours.has(face[0] as string), `face ${t}'s colour came from the source`).toBe(
        true,
      )
    }
  })

  it('carries the same attribute SET, so it shares rung 0 program', () => {
    // three keys a program on `!!geometry.attributes.uv1` and on the colour's
    // item size. A rung without them compiles its own program mid-flight.
    const src = facetedProp()
    const out = simplifyPropGeometry(src, 0.2) as THREE.BufferGeometry
    expect(Object.keys(out.attributes).sort()).toEqual(Object.keys(src.attributes).sort())
    for (const name of Object.keys(src.attributes)) {
      expect(out.getAttribute(name).itemSize, name).toBe(src.getAttribute(name).itemSize)
    }
  })

  it('stays inside the source bounds — a far rung is the same prop, not a bigger one', () => {
    const src = facetedProp()
    src.computeBoundingBox()
    const out = simplifyPropGeometry(src, 0.12) as THREE.BufferGeometry
    const b = out.boundingBox as THREE.Box3
    const s = src.boundingBox as THREE.Box3
    expect(s.containsBox(b.clone().expandByScalar(-1e-3))).toBe(true)
  })

  it('refuses a rung that would be a shard, and the ladder reuses the rung before', () => {
    const tiny = new THREE.TetrahedronGeometry(1).toNonIndexed()
    expect(simplifyPropGeometry(tiny, 0.1)).toBeNull()
    const { rungs, owned } = propRungGeometries(tiny, [0.5, 0.1])
    expect(rungs.length).toBe(3)
    expect(rungs.every((g) => g === tiny)).toBe(true)
    expect(owned).toEqual([])
  })
})

// ── the pass, with rung meshes ───────────────────────────────────────────

const CHUNK_SIZE = 256
const PER_CHUNK = 10
const RUNS: ChunkRun[] = [
  { chunk: 0, start: 0, count: PER_CHUNK },
  { chunk: 1, start: PER_CHUNK, count: PER_CHUNK },
  { chunk: 2, start: 2 * PER_CHUNK, count: PER_CHUNK },
]
const TOTAL = RUNS.length * PER_CHUNK
const desertPass = desertJson.scatter[0] as unknown as PropScatter

const rungedBatch = () => {
  const make = () =>
    new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.Material(), TOTAL)
  const inst = make()
  const lower = [make(), make()]
  const batch = createScatterBatch(inst, RUNS, lower)
  const m = new THREE.Matrix4()
  for (let i = 0; i < TOTAL; i++) batch.setSource(i, m.makeTranslation(i, 0, 0))
  batch.apply({ count: TOTAL, spans: [{ src: 0, dst: 0, count: TOTAL }] })
  return { batch, meshes: [inst, ...lower] }
}

const drawnXs = (inst: THREE.InstancedMesh): number[] => {
  const m = new THREE.Matrix4()
  return Array.from({ length: inst.count }, (_, k) => {
    inst.getMatrixAt(k, m)
    return m.elements[12] as number
  })
}

const options = (enabled: { on: boolean }): LoadPropsOptions =>
  ({
    terrain: { terrainSize: 4096, terrainHeight: 1000, chunkSize: CHUNK_SIZE },
    heightMap: null as never,
    meshLod: {
      rungs: [
        { from: 200, keep: 0.35 },
        { from: 550, keep: 0.12 },
      ],
      enabled: () => enabled.on,
    },
  }) as LoadPropsOptions

describe('createPassLod drives the rung meshes', () => {
  it('draws every prop exactly once across the rungs, near ones on rung 0', () => {
    const { batch, meshes } = rungedBatch()
    const lod = createPassLod(desertPass, [batch], 16, options({ on: true }))
    // Camera on chunk 0's centre: chunk 0 nearest 0 (rung 0), chunk 1 nearest
    // 128 (rung 0), chunk 2 nearest 384 (rung 1).
    expect(lod?.step(128, 128, 1)).toBe(TOTAL)
    const xs = meshes.map(drawnXs)
    expect([...xs.flat()].sort((a, b) => a - b)).toEqual([...Array(TOTAL).keys()])
    expect(xs[0]?.every((x) => x < 2 * PER_CHUNK)).toBe(true)
    expect(xs[1]?.every((x) => x >= 2 * PER_CHUNK)).toBe(true)
    expect(xs[2]).toEqual([])
  })

  it('keeps a hidden prop hidden on EVERY rung, across a swap', () => {
    const { batch, meshes } = rungedBatch()
    const enabled = { on: true }
    const lod = createPassLod(desertPass, [batch], 16, options(enabled))
    lod?.step(128, 128, 1)
    scatterRef(batch, 25).hide()
    // Move so chunk 2 is near: it swaps to rung 0 over a second.
    for (let i = 0; i < 40; i++) lod?.step(640, 128, 1 / 30)
    for (const mesh of meshes) expect(drawnXs(mesh)).not.toContain(25)
    expect(meshes.reduce((n, m) => n + m.count, 0)).toBe(TOTAL)
  })

  it('walks back to rung 0 when the flag goes off live', () => {
    const { batch, meshes } = rungedBatch()
    const enabled = { on: true }
    const lod = createPassLod(desertPass, [batch], 16, options(enabled))
    lod?.step(128, 128, 1)
    expect(meshes[1]?.count).toBe(PER_CHUNK)
    enabled.on = false
    for (let i = 0; i < 40; i++) lod?.step(128, 128, 1 / 30)
    expect(meshes[0]?.count).toBe(TOTAL)
    expect(meshes[1]?.count).toBe(0)
    expect(meshes[2]?.count).toBe(0)
  })
})
