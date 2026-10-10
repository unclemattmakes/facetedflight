// tests/unit/diorama-body.test.ts: a table's island has a BODY (DEV-579).
//
// Matt, 2026-10-03: *"something i really don't like about the current dioramas
// is how the edge just stops and we can see under the diorama, making it look
// wafer-thin."* `render/diorama.ts` now snaps the island's outline onto a true
// circle and stands a faceted wall under it, down to a foot and a closed
// underside, all inside the island's one mesh. Measured on the vertices and
// colours the island DRAWS, never on the option echoed back: the outline is a
// circle, no top face folds, the wall meets the rim with no gap, the underside
// is closed, the bands darken toward the bottom, and the table's own body
// stands on the table's inset and inside its square.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { BODY_ROWS, bodyEarth, createDiorama, type DioramaBody, easeAt } from '@/render/diorama'
import {
  DIORAMA_LIFT,
  MODEL_SIZE,
  SELECTED_ISLAND_SCALE,
  TABLE_BODY,
  TABLE_BOUND,
  TABLE_EASE,
  TABLE_SEA_RING,
  TABLE_TOP,
} from '@/render/hangar'
import { buildHeightField, terrainHeightAt } from '@/sim/terrain/height-field'
import type { MapSampler } from '@/sim/terrain/image-sampler'

/** Land everywhere, rising west to east and with a ridge: the rim is all land, at every height. */
const tilted: MapSampler = {
  width: 64,
  height: 64,
  sample(u, v, out) {
    const h = 0.15 + 0.5 * u + 0.25 * Math.max(0, 1 - Math.abs(v - 0.5) * 6)
    out.r = h
    out.g = h
    out.b = h
  },
}
/** Sea round a cone: the rim is all sea. */
const cone: MapSampler = {
  width: 64,
  height: 64,
  sample(u, v, out) {
    const h = Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.5) * 6)
    out.r = h
    out.g = h
    out.b = h
  },
}
const fieldOf = (sampler: MapSampler) =>
  buildHeightField(
    sampler,
    {
      terrainSize: 4096,
      terrainHeight: 900,
      chunkSize: 256,
      baseResolution: 16,
      randomOffset: 0,
      seed: 1,
    },
    { position: [0, 0, 0], scale: [1, 1, 1] },
  )
/** A palette with three different channels, so a colour is never mistaken for grey. */
const olive: MapSampler = {
  width: 1,
  height: 1,
  sample(_u, _v, out) {
    out.r = 0.45
    out.g = 0.38
    out.b = 0.22
  },
}

const BODY: DioramaBody = { depth: 0.1, lip: 0.014, foot: 0.14 }
const R = MODEL_SIZE / 2

const build = (sampler: MapSampler, body: DioramaBody | null) =>
  createDiorama({ field: fieldOf(sampler), palette: olive, route: null, size: MODEL_SIZE, body })

const attrs = (d: ReturnType<typeof createDiorama>) => {
  const mesh = d.object.getObjectByName('diorama-island') as THREE.Mesh
  return {
    pos: mesh.geometry.attributes.position as THREE.BufferAttribute,
    col: mesh.geometry.attributes.color as THREE.BufferAttribute,
  }
}

const key = (x: number, y: number, z: number) =>
  `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`

describe('the island’s outline is a circle when it has a body', () => {
  for (const [name, sampler] of [
    ['land at the rim', tilted],
    ['sea at the rim', cone],
  ] as const) {
    it(`${name}: same cells, the rim on the circle, and no top face folds`, () => {
      const bare = build(sampler, null)
      const solid = build(sampler, BODY)
      const top = attrs(bare).pos.count
      const { pos } = attrs(solid)
      expect(pos.count).toBeGreaterThan(top)
      let far = 0
      let positive = 0
      let negative = 0
      const a = new THREE.Vector3()
      const b = new THREE.Vector3()
      const c = new THREE.Vector3()
      for (let i = 0; i < top; i += 3) {
        a.fromBufferAttribute(pos, i)
        b.fromBufferAttribute(pos, i + 1)
        c.fromBufferAttribute(pos, i + 2)
        for (const p of [a, b, c]) far = Math.max(far, Math.hypot(p.x, p.z))
        // Signed area in plan. Every cell is wound the same way, so every face
        // keeps one sign; a fold would flip one.
        const area = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)
        if (area > 1e-12) positive++
        if (area < -1e-12) negative++
      }
      // The outline is ON the circle: the farthest top vertex is exactly R.
      expect(far).toBeCloseTo(R, 6)
      expect(Math.min(positive, negative)).toBe(0)
      expect(Math.max(positive, negative)).toBeGreaterThan(top / 3 - 40)
      // The bare island's outline is the staircase, poking past the circle.
      let bareFar = 0
      const bp = attrs(bare).pos
      for (let i = 0; i < bp.count; i++)
        bareFar = Math.max(bareFar, Math.hypot(bp.getX(i), bp.getZ(i)))
      expect(bareFar).toBeGreaterThan(R + 1e-4)
      bare.dispose()
      solid.dispose()
    })
  }
})

describe('the body (DEV-579)', () => {
  it('meets the rim with no gap: every open edge of the top surface is an edge of the wall', () => {
    const d = build(tilted, BODY)
    const bare = build(tilted, null)
    const top = attrs(bare).pos.count
    const { pos } = attrs(d)
    const edgeKey = (i: number, j: number) => {
      const p = key(pos.getX(i), pos.getY(i), pos.getZ(i))
      const q = key(pos.getX(j), pos.getY(j), pos.getZ(j))
      return p < q ? `${p}|${q}` : `${q}|${p}`
    }
    const topEdges = new Map<string, number>()
    for (let i = 0; i < top; i += 3) {
      for (const [m, n] of [
        [0, 1],
        [1, 2],
        [2, 0],
      ] as const) {
        const k = edgeKey(i + m, i + n)
        topEdges.set(k, (topEdges.get(k) ?? 0) + 1)
      }
    }
    const open = [...topEdges].filter(([, n]) => n === 1).map(([k]) => k)
    const wallEdges = new Set<string>()
    for (let i = top; i < pos.count; i += 3) {
      wallEdges.add(edgeKey(i, i + 1))
      wallEdges.add(edgeKey(i + 1, i + 2))
      wallEdges.add(edgeKey(i + 2, i))
    }
    // A full ring of them, a couple of hundred, and every one of them walled.
    expect(open.length).toBeGreaterThan(150)
    const missing = open.filter((k) => !wallEdges.has(k))
    expect(missing).toEqual([])
    d.dispose()
    bare.dispose()
  })

  it('goes down to the foot, inside the disc, and closes underneath', () => {
    const d = build(cone, BODY)
    const top = attrs(build(cone, null)).pos.count
    const { pos } = attrs(d)
    let lowest = Infinity
    let widest = 0
    let underside = 0
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    for (let i = top; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i)
      b.fromBufferAttribute(pos, i + 1)
      c.fromBufferAttribute(pos, i + 2)
      for (const p of [a, b, c]) {
        lowest = Math.min(lowest, p.y)
        widest = Math.max(widest, Math.hypot(p.x, p.z))
      }
      if (
        Math.abs(a.y + BODY.depth) < 1e-6 &&
        Math.abs(b.y + BODY.depth) < 1e-6 &&
        Math.abs(c.y + BODY.depth) < 1e-6
      ) {
        underside += Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2
      }
    }
    expect(lowest).toBeCloseTo(-BODY.depth, 6)
    expect(widest).toBeLessThanOrEqual(R + 1e-6)
    // Closed: the underside covers the foot's disc (a polygon of ~200 sides inside it).
    expect(underside).toBeGreaterThan(Math.PI * BODY.foot ** 2 * 0.99)
    expect(underside).toBeLessThanOrEqual(Math.PI * BODY.foot ** 2 + 1e-6)
    d.dispose()
  })

  it('darkens toward the bottom, in the earth’s own hue', () => {
    const d = build(tilted, BODY)
    const top = attrs(build(tilted, null)).pos.count
    const { pos, col } = attrs(d)
    // Each body face by its band, read back as the sRGB a screen shows.
    const bands = {
      cut: [] as number[],
      upper: [] as number[],
      lower: [] as number[],
      under: [] as number[],
    }
    const c = new THREE.Color()
    const srgb = { r: 0, g: 0, b: 0 }
    const midY = -(BODY.lip + BODY.depth) / 2
    for (let i = top; i < pos.count; i += 3) {
      const ys = [pos.getY(i), pos.getY(i + 1), pos.getY(i + 2)]
      const lo = Math.min(...ys)
      const hi = Math.max(...ys)
      c.setRGB(col.getX(i), col.getY(i), col.getZ(i))
      c.getRGB(srgb, THREE.SRGBColorSpace)
      // The hue is the earth's: olive's channel order, red over green over blue.
      expect(srgb.r).toBeGreaterThan(srgb.g)
      expect(srgb.g).toBeGreaterThan(srgb.b)
      const l = (srgb.r + srgb.g + srgb.b) / 3
      if (hi - lo < 1e-6) bands.under.push(l)
      else if (Math.abs(lo + BODY.depth) < 1e-6) bands.lower.push(l)
      else if (Math.abs(lo - midY) < 1e-6) bands.upper.push(l)
      else bands.cut.push(l)
    }
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
    for (const xs of Object.values(bands)) expect(xs.length).toBeGreaterThan(100)
    expect(mean(bands.cut)).toBeGreaterThan(mean(bands.upper))
    expect(mean(bands.upper)).toBeGreaterThan(mean(bands.lower))
    expect(mean(bands.lower)).toBeGreaterThan(mean(bands.under))
    d.dispose()
  })

  it('a sea rim’s cut is the water’s section, bluer than the earth under it', () => {
    const d = build(cone, BODY)
    const top = attrs(build(cone, null)).pos.count
    const { pos, col } = attrs(d)
    let water = 0
    for (let i = top; i < pos.count; i += 3) {
      const hi = Math.max(pos.getY(i), pos.getY(i + 1), pos.getY(i + 2))
      if (hi < -1e-6) continue
      // A face reaching the waterline: the cut band under the sea.
      expect(col.getZ(i)).toBeGreaterThan(col.getX(i))
      water++
    }
    expect(water).toBeGreaterThan(150)
    d.dispose()
  })

  it('takes its earth from the steep faces, which is where a map paints its rock', () => {
    const flatGreen = { r: 0.2, g: 0.6, b: 0.2, ny: 0.99 }
    const steepGrey = { r: 0.5, g: 0.5, b: 0.5, ny: 0.3 }
    const e = bodyEarth([...Array(20).fill(flatGreen), steepGrey, steepGrey])
    expect(e.g - e.r).toBeLessThan(0.02)
    expect(e.r).toBeGreaterThan(0.45)
    // Nothing to read: a dark umber, not black and not a NaN.
    const none = bodyEarth([])
    expect(none.r).toBeGreaterThan(none.b)
    expect(Number.isFinite(none.r)).toBe(true)
    expect(BODY_ROWS.cut).toBeGreaterThan(BODY_ROWS.underside)
  })
})

describe('a land-only table stands on its own lowest ground', () => {
  it('rises off the height map’s zero to just under the lowest ground, and turns nothing to sea', () => {
    const bare = build(tilted, null)
    const solid = build(tilted, BODY)
    // The bare surface keeps the field's origin: 0, under ground that starts 135 m up.
    expect(bare.frame.seaY).toBe(0)
    // With a body, off the zero: the lowest ground on this disc is over 135 m.
    expect(solid.frame.seaY).toBeGreaterThan(120)
    // So the wall under the lowest rim is a couple of millimetres, not 3 cm.
    const top = attrs(bare).pos.count
    const { pos } = attrs(solid)
    let lowestTop = Infinity
    for (let i = 0; i < top; i++) lowestTop = Math.min(lowestTop, pos.getY(i))
    expect(lowestTop).toBeGreaterThan(0)
    expect(lowestTop).toBeLessThan(0.003)
    bare.dispose()
    solid.dispose()
  })

  it('a table with sea on it keeps its waterline', () => {
    expect(build(cone, BODY).frame.seaY).toBe(0)
    expect(
      createDiorama({
        field: fieldOf(tilted),
        palette: olive,
        route: null,
        size: MODEL_SIZE,
        body: BODY,
        seaLevel: 50,
      }).frame.seaY,
    ).toBe(50)
  })
})

/* ═══════ the land eased down to the rim (DEV-579 follow-up) ═══════════════ */
//
// Matt, 2026-10-03: *"yes, ease the alpine and canyon edges plz"*. Measured on
// the drawn vertices: nothing inside the band moves, the rim keeps `keep` of its
// height over the origin, and a craft on the route keeps its height over the
// eased ground.

const EASE = { band: 0.25, keep: 0.1 }
const EASED: DioramaBody = { ...BODY, ease: EASE }

/** The drawn top surface: each vertex's (x, z) key to its y, and its distance from the centre. */
const topOf = (d: ReturnType<typeof createDiorama>, count: number) => {
  const { pos } = attrs(d)
  const out = new Map<string, { y: number; r: number }>()
  for (let i = 0; i < count; i++) {
    out.set(`${Math.round(pos.getX(i) * 1e6)},${Math.round(pos.getZ(i) * 1e6)}`, {
      y: pos.getY(i),
      r: Math.hypot(pos.getX(i), pos.getZ(i)),
    })
  }
  return out
}

describe('the land eases down to the rim', () => {
  it('easeAt is 0 inside the band, 1 at the rim, and never falls', () => {
    expect(easeAt(EASE, 0)).toBe(0)
    expect(easeAt(EASE, 1 - EASE.band)).toBe(0)
    expect(easeAt(EASE, 1)).toBe(1)
    let last = 0
    for (let t = 0; t <= 1.2; t += 0.01) {
      const s = easeAt(EASE, t)
      expect(s).toBeGreaterThanOrEqual(last)
      last = s
    }
  })

  it('leaves the land inside the band alone and brings the rim down to `keep` of its height', () => {
    const top = attrs(build(tilted, null)).pos.count
    const plain = build(tilted, BODY)
    const eased = build(tilted, EASED)
    // The same origin either way: the ease is measured from it, it does not move it.
    expect(eased.frame.seaY).toBe(plain.frame.seaY)
    const a = topOf(plain, top)
    const b = topOf(eased, top)
    let inner = 0
    let rim = 0
    for (const [k, v] of a) {
      const w = b.get(k)
      expect(w, k).toBeDefined()
      if (!w) continue
      if (v.r < R * (1 - EASE.band) - 1e-6) {
        expect(w.y).toBe(v.y)
        inner++
      } else if (v.r > R - 1e-6) {
        // At the rim: keep of the height over the origin, which is local y 0.
        expect(w.y).toBeCloseTo(v.y * EASE.keep, 6)
        rim++
      } else {
        expect(w.y).toBeLessThanOrEqual(v.y + 1e-9)
        expect(w.y).toBeGreaterThanOrEqual(v.y * EASE.keep - 1e-9)
      }
    }
    expect(inner).toBeGreaterThan(1000)
    expect(rim).toBeGreaterThan(150)
    plain.dispose()
    eased.dispose()
  })

  it('a craft on the route keeps its height over the eased ground', () => {
    const field = fieldOf(tilted)
    const cellSize = field.terrainSize / 56
    // A grid vertex inside the band: 4 cells in from the west rim, on the axis.
    const x = field.originX + 4 * cellSize
    const simZ = field.originZ + 28 * cellSize
    const ground = terrainHeightAt(field, x, simZ)
    // Exactly ON the ground, and a hair along so the path has a direction.
    const route = [
      [x, ground, -simZ],
      [x + 0.001, ground, -simZ],
    ]
    const d = createDiorama({ field, palette: olive, route, size: MODEL_SIZE, body: EASED })
    d.update(0)
    const jet = d.object.children.find(
      (o) => (o as THREE.Mesh).isMesh && o.name !== 'diorama-island',
    ) as THREE.Mesh
    expect(jet).toBeDefined()
    const top = topOf(d, attrs(build(tilted, null)).pos.count)
    const under = top.get(`${Math.round(jet.position.x * 1e6)},${Math.round(jet.position.z * 1e6)}`)
    expect(under).toBeDefined()
    // It sits on the drawn, eased ground, which has come down from the field's.
    expect(jet.position.y).toBeCloseTo(under?.y as number, 5)
    expect(under?.y as number).toBeLessThan(
      (ground - d.frame.seaY) * d.frame.scale * d.frame.relief - 1e-4,
    )
    d.dispose()
  })
})

describe('DEV-627: the table’s own body is a puck inside its table', () => {
  // Matt, 2026-10-04: *"remove the tapered bottom from the underside of the
  // dioramas. a simple flat cap works. ... plz scale them down a lil bit so
  // they fit within the bounds of the table. also, scale the oceans up just a
  // bit since the terrain pokes out of the sides of the ocean"*. Measured on
  // the drawn geometry and on the table's own numbers, never on a belief about
  // either.

  it('drops straight from the rim to a flat cap: no vertex of the wall leans in', () => {
    const d = createDiorama({
      field: fieldOf(cone),
      palette: olive,
      route: null,
      size: MODEL_SIZE,
      body: TABLE_BODY,
    })
    const top = attrs(build(cone, null)).pos.count
    const { pos } = attrs(d)
    let cap = 0
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    for (let i = top; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i)
      b.fromBufferAttribute(pos, i + 1)
      c.fromBufferAttribute(pos, i + 2)
      const onCap = [a, b, c].every((p) => Math.abs(p.y + TABLE_BODY.depth) < 1e-6)
      if (onCap) {
        cap += Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2
        continue
      }
      // A wall triangle: every corner on the rim's circle.
      for (const p of [a, b, c]) expect(Math.hypot(p.x, p.z)).toBeCloseTo(R, 6)
    }
    // The cap is the whole disc, flat at the depth (a polygon of ~200 sides).
    expect(cap).toBeGreaterThan(Math.PI * R ** 2 * 0.99)
    expect(cap).toBeLessThanOrEqual(Math.PI * R ** 2 + 1e-6)
    expect(TABLE_BODY.foot).toBe(R)
    d.dispose()
  })

  it('sits inside the table’s top at rest and selected, on its nearest side', () => {
    // The bound is the table frame's nearest side, measured off the GLB in
    // `hangar-tables.test.ts`: 0.217 m.
    expect(TABLE_BOUND).toBeCloseTo(0.217, 3)
    expect(R).toBeLessThan(TABLE_BOUND)
    expect(R * SELECTED_ISLAND_SCALE).toBeLessThan(TABLE_BOUND)
    // And the drawn geometry agrees: nothing of the island or its puck is
    // wider than R, on a field whose land runs to the rim.
    for (const sampler of [cone, tilted]) {
      const d = createDiorama({
        field: fieldOf(sampler),
        palette: olive,
        route: null,
        size: MODEL_SIZE,
        body: TABLE_BODY,
      })
      const { pos } = attrs(d)
      let widest = 0
      for (let i = 0; i < pos.count; i++)
        widest = Math.max(widest, Math.hypot(pos.getX(i), pos.getZ(i)))
      expect(widest).toBeLessThanOrEqual(R + 1e-6)
      d.dispose()
    }
  })

  it('rests its cap flush on the table top, and sinks a selected one a few millimetres (DEV-843)', () => {
    const capAt = (scale: number) => DIORAMA_LIFT - TABLE_BODY.depth * scale
    // Flush: no float (it stood 2.5 cm over the top until DEV-843).
    expect(capAt(1)).toBeCloseTo(TABLE_TOP, 9)
    // Grown, the puck goes into the top, never above it.
    expect(capAt(SELECTED_ISLAND_SCALE)).toBeLessThanOrEqual(TABLE_TOP + 1e-9)
    expect(TABLE_TOP - capAt(SELECTED_ISLAND_SCALE)).toBeLessThan(0.01)
  })

  it('keeps every edge of a sea table water: the land stops inside the ocean', () => {
    // Land everywhere on the field, all of it over the water: the case where
    // the islands used to run off the disc's sides.
    const sea = 50
    const field = fieldOf(tilted)
    const top = attrs(build(tilted, null)).pos.count
    const d = createDiorama({
      field,
      palette: olive,
      route: null,
      size: MODEL_SIZE,
      body: TABLE_BODY,
      seaLevel: sea,
    })
    const surface = topOf(d, top)
    const landR = (1 - TABLE_SEA_RING) * R
    const cell = MODEL_SIZE / 56
    let rimVertices = 0
    let landVertices = 0
    for (const { y, r } of surface.values()) {
      if (y > 1e-9) {
        landVertices++
        // Land only inside the ocean's ring (a vertex of a cell straddling it
        // may sit up to a cell outside, at the waterline's height or under).
        expect(r).toBeLessThanOrEqual(landR + cell)
      }
      if (Math.abs(r - R) < 1e-6) {
        rimVertices++
        expect(y, 'a rim vertex above the water').toBeLessThanOrEqual(1e-9)
      }
    }
    expect(landVertices).toBeGreaterThan(100)
    expect(rimVertices).toBeGreaterThan(100)
    expect(TABLE_SEA_RING).toBeGreaterThan(0)
    expect(TABLE_SEA_RING).toBeLessThan(0.15)
    d.dispose()
    // A table with no sea keeps its land to the rim, as before (alpine, the canyon).
    const dry = createDiorama({
      field,
      palette: olive,
      route: null,
      size: MODEL_SIZE,
      body: TABLE_BODY,
    })
    const rimLand = [...topOf(dry, top).values()].filter(
      (v) => Math.abs(v.r - R) < 1e-6 && v.y > 1e-6,
    )
    expect(rimLand.length).toBeGreaterThan(100)
    dry.dispose()
  })

  it('pins the shipped body and ease once, so a change is made on purpose', () => {
    expect(TABLE_BODY.lip).toBeLessThan(TABLE_BODY.depth)
    expect(TABLE_BODY.ease).toEqual({ band: 0.25, keep: 0.1 })
    expect(TABLE_EASE).toBe(TABLE_BODY.ease)
    expect(TABLE_BODY.seaRing).toBe(TABLE_SEA_RING)
  })
})
