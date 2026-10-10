// tests/unit/life-boats.test.ts — DEV-447, the moored boats.
//
// Three things, each against something outside the code under test:
//
//  1. WHERE — `placeBoats` over a synthetic island in a synthetic sea. Every
//     gate is asserted on the OUTPUT by re-measuring it with the terrain
//     (depth under the hull, spacing, the keep-outs), never by re-deriving the
//     search. And the rule is deterministic, and a new course gets a harbour of
//     its own from the same data.
//  2. WHEN — `boatsWanted`: the preset flag AND the comfort floor, the one rule
//     a quality tier drops them by; Classic's flag is off by the preset itself.
//  3. HOW THEY LIE — `hullRotation` is a rotation (a mirror would turn the hull
//     inside out: DEV-044's class), level on a flat sea, nose up when the bow
//     is higher, and pointing along the yaw it was given; `hullHeight` is the
//     shader's displacement at the corners, weighted.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { EditionLifeBoats } from '@/content/edition-schema'
import { boatsWanted, qualityAtLeast } from '@/game/life/load-life'
import { hullHeight, hullRotation } from '@/render/life-boats'
import { type WaterDisplace, waterDisplacement } from '@/render/water'
import {
  type BoatInput,
  type BoatPlacement,
  type BoatSpec,
  placeBoats,
  seedOf,
  waterDepthAt,
} from '@/sim/life/boats'
import { createRoute, routeAt } from '@/sim/route'
import type { FacetedTerrainParams, MapSampler } from '@/sim/terrain/faceted'
import { buildHeightField, type HeightField } from '@/sim/terrain/height-field'
import type { Rgb } from '@/sim/terrain/image-sampler'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'

const map = (f: (u: number, v: number) => number): MapSampler =>
  ({
    width: 128,
    height: 128,
    sample(u: number, v: number, out: Rgb): Rgb {
      const g = Math.min(1, Math.max(0, f(u, v)))
      out.r = g
      out.g = g
      out.b = g
      return out
    },
  }) as unknown as MapSampler

const LAND_PARAMS: FacetedTerrainParams = {
  terrainSize: 2048,
  terrainHeight: 400,
  chunkSize: 256,
  baseResolution: 8,
  randomOffset: 0,
  seed: 1,
}
/** A round island: 100 m of seabed at the rim rising to 300 m in the middle. */
const island = (u: number, v: number): number => {
  const r = Math.hypot(u - 0.5, v - 0.5) * 2
  return 0.25 + 0.5 * Math.max(0, 1 - r * 1.6)
}
/** The sea: flat at 116 m (0.29 of 400), a plate bigger than the island. */
const SEA_PARAMS: FacetedTerrainParams = { ...LAND_PARAMS, terrainSize: 1024, baseResolution: 32 }
const LAND = buildHeightField(map(island), LAND_PARAMS, { position: [0, 0, 0], scale: [1, 1, 1] })
const SEA = buildHeightField(
  map(() => 0.29),
  SEA_PARAMS,
  {
    position: [-2048, 0, -2048],
    scale: [6, 1, 6],
  },
)

const SPEC: BoatSpec = {
  seed: 447,
  alongRoute: 8,
  atStart: 3,
  routeReach: [40, 600],
  startReach: [60, 500],
  depth: [3, 40],
  startOpenWater: false,
  spacing: 70,
  swing: 25,
  search: { step: 20, angles: 12 },
  kinds: [
    { id: 'row', weight: 3, scale: [1.4, 1.8], halfLength: 1.58 },
    { id: 'sail', weight: 2, scale: [3, 3.8], halfLength: 1.24 },
  ],
}

/** A line that circles the island just inside its shore, SIM space. */
const LINE = createRoute(
  Array.from({ length: 64 }, (_, i) => {
    const a = (i / 63) * Math.PI * 2
    // THREE space in, because `createRoute` flips z.
    return [1024 + Math.cos(a) * 520, 150, -(1024 + Math.sin(a) * 520)]
  }),
)

const INPUT: BoatInput = {
  spec: SPEC,
  courseSeed: seedOf('int_01_hoverJet'),
  line: LINE,
  start: { x: 1024 + 560, z: 1024 },
  sea: SEA,
  land: LAND,
  keepOut: [{ x: 1024 + 560, z: 1024, radius: 52 }],
}

const depthAt = (x: number, z: number): number => waterDepthAt(SEA, LAND, x, z)
const reachOf = (s: BoatSpec): number =>
  s.kinds.reduce((m, k) => Math.max(m, k.halfLength * (k.scale[1] as number)), 0)

describe('placeBoats — the rule, measured on its output', () => {
  const boats = placeBoats(INPUT)

  it('places a fleet at all (the synthetic shore has water in the band)', () => {
    expect(boats.length).toBeGreaterThanOrEqual(8)
  })

  it('every boat floats in the depth band, and so does every hull point', () => {
    const reach = reachOf(SPEC)
    for (const b of boats) {
      const d = depthAt(b.x, b.z)
      expect(d).toBeGreaterThanOrEqual(SPEC.depth[0])
      expect(d).toBeLessThanOrEqual(SPEC.depth[1])
      for (let q = 0; q < 4; q++) {
        const a = (q * Math.PI) / 2
        expect(
          depthAt(b.x + Math.cos(a) * reach, b.z + Math.sin(a) * reach),
        ).toBeGreaterThanOrEqual(SPEC.depth[0])
      }
    }
  })

  it('keeps its spacing, and out of every keep-out', () => {
    for (const [i, a] of boats.entries()) {
      for (const b of boats.slice(i + 1)) {
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(SPEC.spacing)
      }
      for (const k of INPUT.keepOut) {
        expect(Math.hypot(a.x - k.x, a.z - k.z)).toBeGreaterThanOrEqual(k.radius)
      }
    }
  })

  it('spreads the route boats by arc length, each near the fraction it answered', () => {
    const route = boats.filter((b) => b.target >= 0)
    expect(route.length).toBeGreaterThan(SPEC.alongRoute / 2)
    const at = { x: 0, y: 0, z: 0 }
    for (const b of route) {
      // `(i + 0.5) / n` — the traffic's own half-open spacing.
      expect((((b.target * SPEC.alongRoute - 0.5) % 1) + 1) % 1).toBeCloseTo(0, 9)
      routeAt(LINE, b.target * LINE.length, at)
      const d = Math.hypot(b.x - at.x, b.z - at.z)
      expect(d).toBeGreaterThanOrEqual(SPEC.routeReach[0] - 1e-6)
      expect(d).toBeLessThanOrEqual(SPEC.routeReach[1] + 1e-6)
    }
    // And they are NOT one bunch: the targets they answered cover the lap.
    const targets = route.map((b) => b.target)
    expect(Math.max(...targets) - Math.min(...targets)).toBeGreaterThan(0.5)
  })

  it('the start boats are near the spawn, outside the deck', () => {
    const start = boats.filter((b) => b.target === -1)
    expect(start.length).toBe(SPEC.atStart)
    for (const b of start) {
      const d = Math.hypot(b.x - INPUT.start.x, b.z - INPUT.start.z)
      expect(d).toBeGreaterThanOrEqual(SPEC.startReach[0] - 1e-6)
      expect(d).toBeLessThanOrEqual(SPEC.startReach[1] + 1e-6)
    }
  })

  it('moored boats share one wind: every heading within the swing of the others', () => {
    const swing = (SPEC.swing * Math.PI) / 180
    const ys = boats.map((b) => b.yaw)
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(2 * swing + 1e-9)
  })

  it('is deterministic, and a different course gets a different harbour', () => {
    expect(placeBoats(INPUT)).toEqual(boats)
    const other = placeBoats({ ...INPUT, courseSeed: seedOf('adv_02_hoverJet') })
    expect(other.map((b: BoatPlacement) => [b.x, b.z])).not.toEqual(boats.map((b) => [b.x, b.z]))
  })

  it('puts nothing in open ocean: no island, no finite band holds', () => {
    expect(placeBoats({ ...INPUT, land: null })).toEqual([])
  })

  it('puts nothing where there is no sea over the land', () => {
    const high = buildHeightField(
      map(() => 1),
      LAND_PARAMS,
      { position: [0, 0, 0], scale: [1, 1, 1] },
    )
    expect(placeBoats({ ...INPUT, land: high as HeightField })).toEqual([])
  })

  it('a start out at sea gets its boats only when they may anchor in open water', () => {
    // int_01_hoverJet's shape: the spawn is off the island's map, where no
    // finite depth band holds. The route boats are unchanged by the switch.
    const offshore = { ...INPUT, start: { x: 2048 + 900, z: 1024 } }
    const moored = placeBoats(offshore).filter((b) => b.target === -1)
    const anchored = placeBoats({
      ...offshore,
      spec: { ...SPEC, startOpenWater: true },
    }).filter((b) => b.target === -1)
    expect(moored).toEqual([])
    expect(anchored.length).toBe(SPEC.atStart)
    for (const b of anchored) expect(depthAt(b.x, b.z)).toBeGreaterThanOrEqual(SPEC.depth[0])
  })

  it('a kind of weight 0 is never drawn', () => {
    const only = placeBoats({
      ...INPUT,
      spec: {
        ...SPEC,
        kinds: [
          { ...(SPEC.kinds[0] as BoatSpec['kinds'][number]), weight: 0 },
          SPEC.kinds[1] as BoatSpec['kinds'][number],
        ],
      },
    })
    expect(only.length).toBeGreaterThan(0)
    expect(only.every((b) => b.kind === 1)).toBe(true)
  })
})

describe('boatsWanted — the preset, and the comfort floor that drops them', () => {
  const ann = (anniversary as unknown as { life: { boats: EditionLifeBoats } }).life.boats
  const cls = (classic as unknown as { life: { boats: EditionLifeBoats } }).life.boats

  it('Anniversary draws them at its floor and above, and drops them below it', () => {
    expect(ann.enabled).toBe(true)
    expect(boatsWanted(ann, 'high')).toBe(true)
    expect(boatsWanted(ann, ann.minQuality)).toBe(true)
    expect(boatsWanted({ ...ann, minQuality: 'medium' }, 'low')).toBe(false)
  })

  it('Classic never does, at any quality — 2016 bought these boats and placed none', () => {
    for (const q of ['low', 'medium', 'high']) expect(boatsWanted(cls, q)).toBe(false)
  })

  it('reads the ladder in order', () => {
    expect(qualityAtLeast('low', 'low')).toBe(true)
    expect(qualityAtLeast('low', 'medium')).toBe(false)
    expect(qualityAtLeast('medium', 'low')).toBe(true)
    expect(qualityAtLeast('high', 'medium')).toBe(true)
    expect(qualityAtLeast('medium', 'high')).toBe(false)
  })
})

describe('hullRotation — how a hull lies on four heights', () => {
  const q = new THREE.Quaternion()
  const x = new THREE.Vector3()
  const y = new THREE.Vector3()
  const z = new THREE.Vector3()
  const axes = (quat: THREE.Quaternion): void => {
    x.set(1, 0, 0).applyQuaternion(quat)
    y.set(0, 1, 0).applyQuaternion(quat)
    z.set(0, 0, 1).applyQuaternion(quat)
  }

  it('is a rotation, never a mirror, at any heights', () => {
    for (const [b, s, p, r] of [
      [0, 0, 0, 0],
      [2, -1, 0.5, 3],
      [-4, 4, 4, -4],
    ] as const) {
      hullRotation(0.7, [6, 2], b, s, p, r, q)
      const m = new THREE.Matrix4().makeRotationFromQuaternion(q)
      expect(m.determinant()).toBeCloseTo(1, 9)
    }
  })

  it('on a flat sea it is level and points the long axis along the yaw', () => {
    for (const yaw of [0, 0.4, 2.1, -1.3]) {
      hullRotation(yaw, [6, 2], 1, 1, 1, 1, q)
      axes(q)
      expect(y.y).toBeCloseTo(1, 9)
      // `(cos, 0, -sin)`: a turn about +y by `yaw`, the convention the
      // hull samples are laid out in (`game/life/load-life.ts`).
      expect(x.x).toBeCloseTo(Math.cos(yaw), 9)
      expect(x.z).toBeCloseTo(-Math.sin(yaw), 9)
    }
  })

  it('noses up when the bow is higher, and heels to the higher side', () => {
    hullRotation(0, [6, 2], 1, 0, 0, 0, q)
    axes(q)
    expect(x.y).toBeGreaterThan(0)
    expect(Math.atan2(x.y, Math.hypot(x.x, x.z))).toBeCloseTo(Math.atan2(1, 6), 6)
    hullRotation(0, [6, 2], 0, 0, 1, 0, q)
    axes(q)
    expect(z.y).toBeGreaterThan(0)
    expect(Math.atan2(z.y, Math.hypot(z.x, z.z))).toBeCloseTo(Math.atan2(1, 2), 6)
  })
})

describe('hullHeight — the displaced facet, as the vertex shader builds it', () => {
  const d: WaterDisplace = {
    live: true,
    direction: 322,
    speed: 2,
    amplitude: 4,
    frequency: 0.4,
    noise: -1,
  }
  const corners = new Float64Array([100, 116, -40, 132, 115.5, -40, 100, 116.8, -72])

  it('at a corner it is that vertex, displaced at THREE (x, -z), plus the bob', () => {
    for (const t of [0, 1.3, 7.77]) {
      const h = hullHeight({ corners, weights: [1, 0, 0] }, d, t, 2.5)
      expect(h).toBeCloseTo(116 + waterDisplacement(d, 100, 40, t) + 2.5, 12)
    }
  })

  it('between corners it is the plane through the three displaced vertices', () => {
    const w: [number, number, number] = [0.2, 0.5, 0.3]
    const t = 3.1
    const want =
      0.2 * (116 + waterDisplacement(d, 100, 40, t)) +
      0.5 * (115.5 + waterDisplacement(d, 132, 40, t)) +
      0.3 * (116.8 + waterDisplacement(d, 100, 72, t))
    expect(hullHeight({ corners, weights: w }, d, t, 0)).toBeCloseTo(want, 12)
  })
})
