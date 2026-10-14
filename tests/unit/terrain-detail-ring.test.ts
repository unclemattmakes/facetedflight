// tests/unit/terrain-detail-ring.test.ts — LOD −1, and the four things it must
// never touch.
//
// ANNIVERSARY.md T1 / DEV-085. The ring's whole claim is that it ADDS a rung
// below the ladder and changes nothing else, so most of this file is that
// "nothing else": LOD 0 and above answer exactly what they answered, the
// collision height field is the same bytes, Classic can never reach −1, and the
// ocean is not in the feature's reach at all.
//
// What is deliberately NOT asserted anywhere here is a jittered vertex. The
// detail grid is a different walk of the same PRNG, so its displacements
// legitimately differ from LOD 0's at the same grid point — comparing them would
// be asserting the PRNG, not the terrain. Every geometric claim below is made
// against a `randomOffset: 0` build, where the grid is the sampling and nothing
// else, which is the same move `height-field.ts` makes for the same reason.

import { describe, expect, it } from 'vitest'
import {
  EDITION_IDS,
  type Edition,
  type EditionDetailRing,
  editionFeatures,
  validateEdition,
} from '@/content/edition-schema'
import { detailRingFor } from '@/game/terrain/detail-ring'
import { TERRAIN } from '@/generated/constants.generated'
import {
  chunkTriangles,
  type DetailCandidate,
  type DetailRingSpec,
  detailBand,
  detailChunkParams,
  planDetailRequests,
} from '@/sim/terrain/detail'
import {
  buildVertexGrid,
  type FacetedTerrainParams,
  generateChunk,
  type MapSampler,
} from '@/sim/terrain/faceted'
import { buildHeightField } from '@/sim/terrain/height-field'
import { lodBands, selectLod } from '@/sim/terrain/lod'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const ANNIVERSARY = (anniversaryJson as unknown as Edition).terrain.detailRing
const CLASSIC = (classicJson as unknown as Edition).terrain.detailRing

/** A deterministic analytic height map — no image decoding in unit tests. */
const ridgeMap = (): MapSampler => ({
  width: 256,
  height: 256,
  sample(u, v, out) {
    const h = 0.5 + 0.5 * Math.sin(u * Math.PI * 3) * Math.cos(v * Math.PI * 3)
    out.r = h
    out.g = h
    out.b = h
  },
})

const bandedMap = (): MapSampler => ({
  width: 256,
  height: 256,
  sample(u, v, out) {
    out.r = u
    out.g = v
    out.b = u * v
  },
})

// Simonet's shape at a tenth of the size, so a full grid is cheap: the ratios
// that matter — chunkSize / baseResolution = 32 quads, and a ring at half the
// pitch — are the shipped ones.
const BASE: FacetedTerrainParams = {
  terrainSize: 1024,
  terrainHeight: 256,
  chunkSize: 256,
  baseResolution: 8,
  randomOffset: 1.3,
  seed: 20160101,
}

const RING: DetailRingSpec = {
  baseResolution: 4,
  radius: 320,
  jitterScale: 0.5,
  maxInFlight: 2,
  // The geometric claims below are about the GRID; the reconstruction between
  // levels (DEV-131) has its own file and is off here on purpose.
  smoothMetres: 0,
}

/** The same params with no jitter, so a position claim is a sampling claim. */
const flat = (p: FacetedTerrainParams): FacetedTerrainParams => ({ ...p, randomOffset: 0 })

const ISLANDS = TERRAIN.simonet.terrains.islands
const bands = lodBands(ISLANDS.lodDistance, ISLANDS.lodLevels, ISLANDS.flipFlopPercent)
const band = detailBand(RING, ISLANDS, ISLANDS.flipFlopPercent)

// ───────────────────────────────────────────────────────────────────────────
// The band below zero
// ───────────────────────────────────────────────────────────────────────────

describe('the band below zero uses the same mechanism as the ladder above it', () => {
  it('is a real band, not a null one, for the Anniversary ring', () => {
    expect(band).not.toBeNull()
    expect(band?.radius).toBe(320)
    // Not a number of its own: `FlipFlopPercent` is the terrain's, 0.03 on
    // every shipped one, and a ring with its own hysteresis would be a second
    // place for the same idea to be tuned differently by accident.
    expect(band?.hysteresis).toBeCloseTo(ISLANDS.flipFlopPercent, 6)
  })

  it('steps IN only below the radius minus 3%', () => {
    // 320 * 0.97 = 310.4
    expect(selectLod(bands, 311, 0, band)).toBe(0)
    expect(selectLod(bands, 310, 0, band)).toBe(-1)
    expect(selectLod(bands, 0, 0, band)).toBe(-1)
  })

  it('steps OUT only past the radius plus 3%', () => {
    // 320 * 1.03 = 329.6
    expect(selectLod(bands, 329, -1, band)).toBe(-1)
    expect(selectLod(bands, 330, -1, band)).toBe(0)
  })

  it('holds a chunk sitting exactly on the ring, from either side', () => {
    // The flip-flop the field is named after, one rung lower. A chunk on the
    // boundary must not swap its mesh every frame — and at LOD −1 that swap is
    // four times the geometry, regenerated in a worker.
    let inside = -1
    let outside = 0
    for (let i = 0; i < 50; i++) {
      inside = selectLod(bands, 320, inside, band)
      outside = selectLod(bands, 320, outside, band)
    }
    expect(inside).toBe(-1)
    expect(outside).toBe(0)
  })

  it('settles from any start, and another pass does not move it', () => {
    for (const distance of [0, 200, 320, 500, 1500, 3000, 99999]) {
      let lod = 2
      for (let i = 0; i < bands.distances.length + 1; i++)
        lod = selectLod(bands, distance, lod, band)
      expect(selectLod(bands, distance, lod, band)).toBe(lod)
    }
  })

  it('coarsens one level at a time out of the ring, like everything else', () => {
    // A chunk 4 km away that was at −1 walks −1 → 0 → 1 → 2, never jumping.
    const seen: number[] = []
    let lod = -1
    for (let i = 0; i < 5; i++) {
      lod = selectLod(bands, 4000, lod, band)
      seen.push(lod)
    }
    expect(seen).toEqual([0, 1, 2, 2, 2])
  })
})

describe('Classic can never reach LOD −1', () => {
  it('has no band at all — the radius is zero AND the pitch is not finer', () => {
    expect(
      detailBand(detailRingFor(CLASSIC, { isOcean: false, quality: 'high' }), ISLANDS, 0.03),
    ).toBeNull()
    // And each of the two would be enough on its own.
    expect(detailBand({ ...RING, radius: 0 }, ISLANDS, 0.03)).toBeNull()
    expect(detailBand({ ...RING, baseResolution: 8 }, ISLANDS, 0.03)).toBeNull()
    expect(detailBand({ ...RING, baseResolution: 16 }, ISLANDS, 0.03)).toBeNull()
  })

  it('can only ever ADD the bottom rung — every other answer is untouched', () => {
    // The guard that matters most in this file, and it asserts a RELATIONSHIP
    // rather than a value (trap 24): re-stating the expected LOD here the way
    // `selectLod` computes it would test nothing, and the old implementation is
    // not around to diff against. So: a band may turn one answer, from LOD 0
    // inside the ring, into −1. Every other pair must agree. Swept, not
    // spot-checked — 715 distances by five levels — because a spot check is a
    // smoke test.
    let turned = 0
    for (let d = 0; d <= 5000; d += 7) {
      // Every level a chunk can actually BE at. Out-of-range inputs clamp to
      // the floor, and the floor is the thing the band moves — that case is its
      // own test below rather than an exception buried in this one.
      for (const lod of [0, 1, 2]) {
        const without = selectLod(bands, d, lod)
        const withRing = selectLod(bands, d, lod, band)
        // Classic's answer is never below zero, whatever it is handed.
        expect(without).toBeGreaterThanOrEqual(0)
        if (withRing === without) continue
        expect([lod, without, withRing]).toEqual([0, 0, -1])
        turned++
      }
    }
    // And it really did turn some, or the sweep proved nothing.
    expect(turned).toBeGreaterThan(0)
  })

  it('clamps a nonsense current level to the FLOOR, which the band moves', () => {
    // `-5` is `terrain-lod.test.ts`'s existing clamp case. Without a band the
    // floor is 0 and it steps out to 1; with one the floor is −1, so the answer
    // is whatever the ring says about that distance — 0 at 1e6, −1 at zero. It
    // is the clamp working, not the ring leaking: nothing ever hands `selectLod`
    // a level below −1, because `slot.lod` only ever comes from a reply.
    expect(selectLod(bands, 1e6, -5, null)).toBe(1)
    expect(selectLod(bands, 1e6, -5, band)).toBe(0)
    expect(selectLod(bands, 0, -5, band)).toBe(-1)
    expect(selectLod(bands, 0, -5, null)).toBe(0)
    // And in the other direction the clamp is untouched by the band.
    expect(selectLod(bands, 0, 99, band)).toBe(selectLod(bands, 0, 99, null))
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The generator at the finer pitch
// ───────────────────────────────────────────────────────────────────────────

describe('a detail chunk is the same generator at a different pitch', () => {
  const height = ridgeMap()
  const color = bandedMap()
  const fine = detailChunkParams(BASE, RING)

  const chunkAt = (p: FacetedTerrainParams, cx = 1, cy = 2) =>
    // The detail ring keeps 2016's skirt to the sea (DEV-929; the worker passes 'sea').
    generateChunk(buildVertexGrid(height, p), color, height, p, cx, cy, 0, 'sea')

  it('quadruples the INTERIOR triangles, and says what the skirt costs', () => {
    const coarse = chunkAt(BASE)
    const detail = chunkAt(fine)
    const q0 = BASE.chunkSize / BASE.baseResolution // 32
    const q1 = BASE.chunkSize / RING.baseResolution // 64
    expect(q1 / q0).toBe(2)
    // Interior: exactly four times, which is the claim.
    expect((q1 * q1 * 2) / (q0 * q0 * 2)).toBe(4)
    // Total, skirt included, is NOT four times — the skirt ring is `+2` quads a
    // side however fine the interior is, so it is a shrinking fraction of a
    // finer chunk. 3.768, not 4, and the ledger's budget uses these numbers.
    expect(coarse.triangleCount).toBe(chunkTriangles(BASE.chunkSize, BASE.baseResolution))
    expect(detail.triangleCount).toBe(chunkTriangles(BASE.chunkSize, RING.baseResolution))
    expect(coarse.triangleCount).toBe(2312)
    expect(detail.triangleCount).toBe(8712)
    expect(detail.triangleCount / coarse.triangleCount).toBeCloseTo(3.768, 3)
  })

  it('occupies exactly the same footprint, so the chunk boundaries do not move', () => {
    // If they moved, every seam in the ring would be a gap — and the skirt,
    // which drops from the chunk's own edge, would be hanging in the wrong
    // place to hide it.
    const extent = (p: FacetedTerrainParams, cx: number, cy: number) => {
      const c = chunkAt(flat(p), cx, cy)
      let minX = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      let minZ = Number.POSITIVE_INFINITY
      let maxZ = Number.NEGATIVE_INFINITY
      for (let i = 0; i < c.positions.length; i += 3) {
        const x = c.positions[i] as number
        const z = c.positions[i + 2] as number
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
      return [minX, maxX, minZ, maxZ]
    }
    for (const [cx, cy] of [
      [0, 0],
      [1, 2],
      [3, 3],
    ] as const) {
      expect(extent(fine, cx, cy)).toEqual(extent(BASE, cx, cy))
      // And it is the footprint the LOD test measures against: cx * chunkSize.
      expect(extent(fine, cx, cy)).toEqual([
        cx * BASE.chunkSize,
        (cx + 1) * BASE.chunkSize,
        cy * BASE.chunkSize,
        (cy + 1) * BASE.chunkSize,
      ])
    }
  })

  it('samples the height map identically at every coincident grid point', () => {
    // The assertion is about the SAMPLING, not about a jittered vertex: both
    // grids are built with the jitter off, and then every second vertex of the
    // fine grid must be a vertex of the coarse one, to the float.
    const coarse = buildVertexGrid(height, flat(BASE))
    const detail = buildVertexGrid(height, flat(fine))
    expect(coarse.vertPerSide).toBe(BASE.terrainSize / BASE.baseResolution + 1)
    expect(detail.vertPerSide).toBe(BASE.terrainSize / RING.baseResolution + 1)
    const step = BASE.baseResolution / RING.baseResolution // 2
    let checked = 0
    for (let x = 0; x < coarse.vertPerSide; x++) {
      for (let y = 0; y < coarse.vertPerSide; y++) {
        const a = (x * coarse.vertPerSide + y) * 3
        const b = (x * step * detail.vertPerSide + y * step) * 3
        expect(detail.verts[b]).toBe(coarse.verts[a])
        expect(detail.verts[b + 1]).toBe(coarse.verts[a + 1])
        expect(detail.verts[b + 2]).toBe(coarse.verts[a + 2])
        checked++
      }
    }
    expect(checked).toBe(coarse.vertPerSide ** 2)
  })

  it('keeps the skirt, pinned to sea level at the outer ring', () => {
    const detail = chunkAt(flat(fine))
    let minY = Number.POSITIVE_INFINITY
    let atZero = 0
    for (let i = 1; i < detail.positions.length; i += 3) {
      const y = detail.positions[i] as number
      if (y < minY) minY = y
      if (y === 0) atZero++
    }
    // The ridge map never reaches 0 in the interior, so every y = 0 vertex is a
    // pinned skirt corner — and there are plenty of them.
    expect(minY).toBe(0)
    expect(atZero).toBeGreaterThan(BASE.chunkSize / RING.baseResolution)
  })

  it('stamps the skirt with its neighbour normal rather than its own wall normal', () => {
    // Trap 17: the positions are identical with and without the stamp, so a
    // position diff cannot see this. A pinned wall quad whose vertices span a
    // height drop has a HORIZONTAL face normal if it keeps its own; the stamp
    // replaces it with the interior triangle's, which points up.
    const detail = chunkAt(fine)
    let upward = 0
    let horizontal = 0
    for (let i = 0; i < detail.positions.length / 3; i++) {
      // A skirt vertex is one pinned to y = 0 in a chunk whose ground is above
      // it. Count the normals on those faces.
      if ((detail.positions[i * 3 + 1] as number) !== 0) continue
      const ny = detail.normals[i * 3 + 1] as number
      if (ny > 0.2) upward++
      else if (Math.abs(ny) < 1e-6) horizontal++
    }
    expect(upward).toBeGreaterThan(0)
    // The four CORNER skirt quads are never stamped — 2016's own bound — so a
    // handful of horizontal normals is correct and zero would be wrong.
    expect(horizontal).toBeLessThan(upward)
  })

  it('runs the 2016 diagonal bug at the finer pitch too', () => {
    // The `.y`-for-`.z` mid-edge V (DEV-005, KEPT). Proved by showing the
    // branch is live: turning the bug off must change the mesh, at 4 m exactly
    // as it does at 8. A detail chunk that had quietly lost it would be four
    // times as many triangles laid out on the FIXED rule, which is a silhouette
    // nothing in the game has.
    const faithful = chunkAt(fine)
    const fixed = generateChunk(
      buildVertexGrid(height, { ...fine, faithfulDiagonalBug: false }),
      color,
      height,
      { ...fine, faithfulDiagonalBug: false },
      1,
      2,
      0,
    )
    expect(fixed.triangleCount).toBe(faithful.triangleCount)
    expect(Array.from(fixed.positions)).not.toEqual(Array.from(faithful.positions))
  })

  it('scales the jitter with the pitch instead of carrying 2016 s amplitude onto it', () => {
    expect(fine.randomOffset).toBeCloseTo(BASE.randomOffset * RING.jitterScale, 12)
    // The RATIO is the invariant, and it is the reason the key is a scale and
    // not a length: 1.3 m on an 8 m facet and 0.65 m on a 4 m one are the same
    // rock at two sizes. Carried unchanged, two neighbours 4 m apart could each
    // move 1.3 m and fold the triangle between them.
    expect(fine.randomOffset / fine.baseResolution).toBeCloseTo(
      BASE.randomOffset / BASE.baseResolution,
      12,
    )
  })

  it('refuses a pitch that does not divide the chunk, naming both numbers', () => {
    expect(() => detailChunkParams(BASE, { ...RING, baseResolution: 3 })).toThrow(
      /does not divide the chunk size 256 m/,
    )
    // 1026 / 4 is 256.5 while 256 / 4 is 64, so the chunk divides and the
    // terrain does not — the second check is not implied by the first, and a
    // grid that does not land on the terrain edge is a chunk short of its own.
    expect(() => detailChunkParams({ ...BASE, terrainSize: 1026 }, RING)).toThrow(
      /does not divide the terrain size/,
    )
  })

  it('does not mutate the terrain s own params', () => {
    const before = { ...BASE }
    detailChunkParams(BASE, RING)
    expect(BASE).toEqual(before)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Collision
// ───────────────────────────────────────────────────────────────────────────

describe('the collision surface is not in the ring s reach', () => {
  const height = ridgeMap()
  const color = bandedMap()
  const transform = { position: [0, 0, 0], scale: [1, 1, 1] }

  it('is byte-identical with the ring configured and with it off', () => {
    // DEV-041: `heightField` is NOT what you see. It is built from the ORIGINAL
    // grid at `terrainSize / baseResolution + 1`, never from the LOD being
    // drawn, which is why LOD has never moved the surface you hit. A finer
    // visual grid is the same kind of change as a coarser one — and the render
    // already disagrees with collision by the jitter, on every preset.
    const before = buildHeightField(height, BASE, transform)
    const fine = detailChunkParams(BASE, RING)
    generateChunk(buildVertexGrid(height, fine), color, height, fine, 1, 2, 0, 'sea')
    const after = buildHeightField(height, BASE, transform)
    expect(after.vertPerSide).toBe(before.vertPerSide)
    expect(after.step).toBe(before.step)
    expect(Array.from(after.heights)).toEqual(Array.from(before.heights))
  })

  it('keeps the 2016 sample pitch, not the ring s', () => {
    const field = buildHeightField(height, BASE, transform)
    expect(field.vertPerSide).toBe(BASE.terrainSize / BASE.baseResolution + 1)
    expect(field.step).toBe(BASE.baseResolution)
    // And explicitly not the finer one, which is the mistake this asserts away.
    expect(field.vertPerSide).not.toBe(BASE.terrainSize / RING.baseResolution + 1)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The queue
// ───────────────────────────────────────────────────────────────────────────

describe('the in-flight cap', () => {
  const ring = (n: number): DetailCandidate[] =>
    Array.from({ length: n }, (_, i) => ({ cx: i, cy: 0, distance: 300 - i }))

  it('asks for at most maxInFlight, however many chunks enter at once', () => {
    // Twelve chunks come into range on one frame — which is what happens when
    // the ring first opens, and again every time the ship crosses a chunk row
    // at 180 m/s.
    expect(planDetailRequests(ring(12), 0, 2)).toHaveLength(2)
    expect(planDetailRequests(ring(12), 1, 2)).toHaveLength(1)
    expect(planDetailRequests(ring(12), 2, 2)).toHaveLength(0)
    // And it stays shut until a reply lands, however many frames pass.
    for (let frame = 0; frame < 60; frame++) {
      expect(planDetailRequests(ring(12), 2, 2)).toEqual([])
    }
  })

  it('takes the NEAREST first, because the ring exists for the near field', () => {
    // §2.1: optic flow is v/d and the near field dominates. A queue that filled
    // the far edge of the ring first would spend the budget where the effect is
    // smallest.
    const plan = planDetailRequests(ring(12), 0, 3)
    expect(plan.map((c) => c.distance)).toEqual([289, 290, 291])
  })

  it('breaks ties on chunk index, so the order is not the Map s', () => {
    const tied: DetailCandidate[] = [
      { cx: 5, cy: 1, distance: 100 },
      { cx: 2, cy: 9, distance: 100 },
      { cx: 2, cy: 3, distance: 100 },
    ]
    expect(planDetailRequests(tied, 0, 2).map((c) => [c.cx, c.cy])).toEqual([
      [2, 3],
      [2, 9],
    ])
  })

  it('does not mutate the candidate list it was handed', () => {
    // It sorts, and a sort in place would reorder the caller's array — which is
    // harmless here and would not be if it were ever a live view of the slots.
    const given = ring(4)
    const copy = given.map((c) => ({ ...c }))
    planDetailRequests(given, 0, 2)
    expect(given).toEqual(copy)
  })

  it('asks for nothing on a nonsense budget rather than throwing', () => {
    expect(planDetailRequests(ring(4), 0, 0)).toEqual([])
    expect(planDetailRequests(ring(4), 0, -3)).toEqual([])
    expect(planDetailRequests([], 0, 8)).toEqual([])
    expect(planDetailRequests(ring(4), 9, 2)).toEqual([])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Which terrains get one
// ───────────────────────────────────────────────────────────────────────────

describe('who gets a ring, and who never does', () => {
  const on = ANNIVERSARY

  it('gives one to the land at medium and high quality', () => {
    expect(detailRingFor(on, { isOcean: false, quality: 'high' })).not.toBeNull()
    expect(detailRingFor(on, { isOcean: false, quality: 'medium' })).not.toBeNull()
  })

  it('never gives one to the OCEAN', () => {
    // The exclusion with no symptom: the water plate is a second FacetedTerrain
    // with 8,192 m chunks and its own density knob (DEV-023), and a sea
    // regenerated at 4 m looks exactly like a sea. Four million quads, in a
    // worker, to change nothing.
    expect(detailRingFor(on, { isOcean: true, quality: 'high' })).toBeNull()
    expect(detailRingFor(on, { isOcean: true, quality: 'medium' })).toBeNull()
  })

  it('turns off at quality low, which is what that preset is for', () => {
    expect(detailRingFor(on, { isOcean: false, quality: 'low' })).toBeNull()
  })

  it('turns off on Classic, and on a hand-edited preset that cannot work', () => {
    expect(detailRingFor(CLASSIC, { isOcean: false, quality: 'high' })).toBeNull()
    expect(detailRingFor(null, { isOcean: false, quality: 'high' })).toBeNull()
    expect(detailRingFor({ ...on, radius: 0 }, { isOcean: false, quality: 'high' })).toBeNull()
    expect(detailRingFor({ ...on, maxInFlight: 0 }, { isOcean: false, quality: 'high' })).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The preset, against the sheet
// ───────────────────────────────────────────────────────────────────────────

describe('the preset s numbers, checked against the generated sheet', () => {
  // The real invariant is not "a power of two" — that is only the half
  // `validateEdition` can see without a terrain. This is the other half, and it
  // is checked against every terrain the sheet knows rather than the one
  // Simonet that the port used to be the only witness for (the agreement
  // lesson: a rule tested only where two explanations agree has not been
  // tested).
  const land = Object.entries(TERRAIN).flatMap(([env, v]) =>
    Object.entries(v.terrains)
      .filter(([name]) => name !== 'ocean')
      .map(([name, t]) => [`${env}.${name}`, t] as const),
  )

  it('finds every land terrain in the sheet', () => {
    expect(land.length).toBeGreaterThanOrEqual(5)
  })

  for (const [key, t] of land) {
    it(`divides ${key}'s chunk and terrain size, and is finer than its own pitch`, () => {
      const r = ANNIVERSARY.baseResolution
      expect(t.chunkSize % r).toBe(0)
      expect(t.terrainSize % r).toBe(0)
      expect(r).toBeLessThan(t.baseResolution)
      // And `detailChunkParams` agrees, which is the code path that would throw.
      const params: FacetedTerrainParams = {
        terrainSize: t.terrainSize,
        terrainHeight: t.terrainHeight,
        chunkSize: t.chunkSize,
        baseResolution: t.baseResolution,
        randomOffset: t.randomOffset,
        seed: 1,
      }
      expect(() => detailChunkParams(params, detailSpec(ANNIVERSARY))).not.toThrow()
    })
  }

  it('keeps the ring well inside every land terrain s own LOD 0 band', () => {
    // A radius past `lodDistance` would put the ring's outer edge in a region
    // where chunks are already coarsening, which is two ladders arguing. The
    // narrowest shipped band is alpine's 700 m.
    for (const [key, t] of land) {
      expect(ANNIVERSARY.radius, key).toBeLessThan(t.lodDistance * 0.5)
    }
  })

  it('states the budget the ledger quotes, so a tuning change has to move it', () => {
    // Simonet, 256 m chunks. DEV-085's row carries these four numbers.
    const coarse = chunkTriangles(ISLANDS.chunkSize, ISLANDS.baseResolution)
    const detail = chunkTriangles(ISLANDS.chunkSize, ANNIVERSARY.baseResolution)
    expect(coarse).toBe(2312)
    expect(detail).toBe(8712)
    expect(detail * 3).toBe(26136)
    // At most fourteen chunks at 320 m — computed here rather than quoted, and
    // the sweep is over sub-chunk offsets because the worst case is a ship
    // sitting on a chunk corner.
    expect(maxRingChunks(ISLANDS.chunkSize, ANNIVERSARY.radius)).toBe(14)
    expect(14 * (detail - coarse)).toBe(89600)
  })

  it('costs a lot more per chunk on the 512 m terrains, and the row says so', () => {
    const desert = TERRAIN.desert.terrains.canyon
    expect(chunkTriangles(desert.chunkSize, ANNIVERSARY.baseResolution)).toBe(33800)
    expect(maxRingChunks(desert.chunkSize, ANNIVERSARY.radius)).toBe(7)
  })
})

describe('the preset is a gate, and the ring is a feature like any other', () => {
  it('appears in editionFeatures, so the every-flag-off walk reaches it', () => {
    const paths = editionFeatures(classicJson as unknown as Edition).map(([p]) => p)
    expect(paths).toContain('terrain.detailRing')
  })

  it('is off on Classic and on on Anniversary', () => {
    expect(CLASSIC.enabled).toBe(false)
    expect(ANNIVERSARY.enabled).toBe(true)
  })

  it('refuses a baseResolution that is not a power of two', () => {
    for (const bad of [3, 5, 0, -4, 4.5]) {
      expect(() => validateEdition(withRing({ baseResolution: bad }))).toThrow(
        /baseResolution must be a positive power of two/,
      )
    }
  })

  it('refuses a negative radius, a negative jitter and an empty queue', () => {
    expect(() => validateEdition(withRing({ radius: -1 }))).toThrow(/radius must be zero or above/)
    expect(() => validateEdition(withRing({ jitterScale: -0.5 }))).toThrow(
      /jitterScale must be zero or above/,
    )
    expect(() => validateEdition(withRing({ maxInFlight: 0 }))).toThrow(/maxInFlight/)
    expect(() => validateEdition(withRing({ maxInFlight: 1.5 }))).toThrow(/maxInFlight/)
  })

  it('refuses a hole, at LOAD rather than at the first frame over the island', () => {
    const holed = JSON.parse(JSON.stringify(anniversaryJson)) as Record<string, unknown>
    ;(holed.terrain as { detailRing: Record<string, unknown> }).detailRing.radius = undefined
    expect(() => validateEdition(holed as unknown as Edition)).toThrow(
      /terrain\.detailRing\.radius must be a finite number/,
    )
  })

  it('refuses a preset with no terrain block at all, naming it', () => {
    const stripped = JSON.parse(JSON.stringify(anniversaryJson)) as Record<string, unknown>
    delete stripped.terrain
    expect(() => validateEdition(stripped as unknown as Edition)).toThrow(
      /terrain\.detailRing\.enabled/,
    )
  })

  it('accepts both shipped presets unchanged', () => {
    for (const id of EDITION_IDS) {
      const preset = (id === 'classic' ? classicJson : anniversaryJson) as unknown as Edition
      expect(validateEdition(preset).id).toBe(id)
    }
  })
})

// ── helpers ──────────────────────────────────────────────────────────────

const detailSpec = (ring: EditionDetailRing): DetailRingSpec => ({
  baseResolution: ring.baseResolution,
  radius: ring.radius,
  jitterScale: ring.jitterScale,
  maxInFlight: ring.maxInFlight,
  smoothMetres: ring.smoothMetres,
})

const withRing = (patch: Partial<EditionDetailRing>): Edition => {
  const e = JSON.parse(JSON.stringify(anniversaryJson)) as unknown as Edition
  return { ...e, terrain: { ...e.terrain, detailRing: { ...e.terrain.detailRing, ...patch } } }
}

/**
 * The most chunks a ring of `radius` can hold on a grid of `chunkSize` chunks.
 *
 * Swept over sub-chunk offsets rather than reasoned about, because the worst
 * case is a ship sitting on a chunk CORNER, where four chunks are at distance
 * zero and the disc reaches a ring further out in every direction than it does
 * from a chunk centre. Distance is to the FOOTPRINT and horizontal, which is
 * what `chunkFootprintDistance` measures and what `selectLod` is handed.
 */
function maxRingChunks(chunkSize: number, radius: number): number {
  let worst = 0
  const span = Math.ceil(radius / chunkSize) + 2
  for (let a = 0; a <= 16; a++) {
    for (let b = 0; b <= 16; b++) {
      const px = (a / 16) * chunkSize
      const pz = (b / 16) * chunkSize
      let n = 0
      for (let cx = -span; cx <= span; cx++) {
        for (let cy = -span; cy <= span; cy++) {
          const dx = Math.max(cx * chunkSize - px, 0, px - (cx + 1) * chunkSize)
          const dz = Math.max(cy * chunkSize - pz, 0, pz - (cy + 1) * chunkSize)
          if (Math.hypot(dx, dz) <= radius) n++
        }
      }
      if (n > worst) worst = n
    }
  }
  return worst
}
