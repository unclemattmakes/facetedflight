// tests/unit/clouds.test.ts — the environment's clouds, as extracted.
//
// The 2016 meshes are `Assets/Geometric-Landscape-Tropic-Island`, a bought
// pack: `licence: REPLACE`, so they can never ship (D26). What comes across is
// the PLACEMENT, and these pin the two things about it that a port gets wrong
// silently — the frame the positions are in, and whether the environment
// instantiates a level-art prefab at all.

import { describe, expect, it } from 'vitest'
import { CLOUD_SHAPES, cloudShape, generateCloud, icosphere, NOMINAL_RADIUS } from '@/sim/clouds'
import { levelJson as load } from './helpers/content'

const int01 = load('int_01_hoverJet')

describe('the environment clouds', () => {
  it('finds all nineteen on Simonet, and the same set on every Simonet mission', () => {
    expect(int01.clouds.length).toBe(19)
    // The clouds belong to the ENVIRONMENT, not the mission, so the four
    // Simonet missions must agree exactly. A per-mission difference would mean
    // the reader is picking them up from the mission scene by accident.
    for (const id of ['int_01_jumpSeat', 'adv_02_hoverJet', 'adv_02_jumpSeat']) {
      const other = load(id)
      expect(other.clouds.map((c) => c.name)).toEqual(int01.clouds.map((c) => c.name))
      expect(other.clouds.map((c) => c.pos)).toEqual(int01.clouds.map((c) => c.pos))
    }
  })

  it('finds clouds in BOTH shapes of environment scene — and this test used to assert the bug', () => {
    // ── What this assertion said before, and why it was wrong ────────────
    //
    // It said Alpine and Kauai have NO clouds, and called zero "the honest
    // answer". It was not: it was the reader's answer. `constants.mjs`
    // documents the Alpine surprise correctly — `LevelArt_AlpineForest.unity`
    // is not an instance of `LevelArt_AlpineForest.prefab` — and the wrong
    // conclusion was drawn from it, that such a scene therefore has no clouds.
    // It has 11, baked in as ordinary GameObjects under
    // `levelOffset/LevelArt_<env>/art/clouds`, 8 of them live. Kauai has 19.
    //
    // Two authoring shapes, and the extractor knew one:
    //   INSTANTIATED  simonet, desert — clouds in the prefab, composed through
    //                 the instance (which sits at Unity (-2048, 0, -2048)).
    //   BAKED         alpine, kauai — clouds in the SCENE, already world space.
    //
    // The lesson is the one at the end of `docs/DEVIATIONS.md`: the rule was
    // only ever checked where the two explanations agree. On Simonet and Desert,
    // "follow the prefab instance" and "read whatever the scene loads" give the
    // same 19 and the same 3.
    const counts: Record<string, number> = {
      int_01_hoverJet: 19, // simonet, instantiated
      adv_01_hoverJet: 3, //  desert,  instantiated — 6 authored, 3 switched off
      int_02_hoverJet: 8, //  alpine,  baked — 11 authored, 8 live
      rookie_01_hoverJet: 8, // alpine, baked
      hoverJet_kauai_beg: 19, // kauai, baked
    }
    for (const [id, n] of Object.entries(counts)) expect(load(id).clouds.length, id).toBe(n)
  })

  it('reads a baked environment from the SCENE, not from a prefab it never loads', () => {
    // Kauai's cloud group is Simonet's, duplicated by the artist and dragged
    // somewhere else: the same nineteen names, the same nineteen scales, and
    // FOURTEEN of the nineteen moved by one identical vector (-2218, 0, 1691).
    // The other five were then nudged by hand — a first draft of this assertion
    // said "moved rigidly", which is true of the first six rows and false of the
    // set, and the test caught it. Checking a rule where it happens to hold is
    // not checking it (`docs/DEVIATIONS.md`, the agreement lesson).
    //
    // What the check is FOR: distinguishing "read Kauai's own scene" from
    // "accidentally read Simonet's prefab again", which would give nineteen
    // identical rows.
    const kauai = load('hoverJet_kauai_beg').clouds
    expect(kauai.map((c) => c.name)).toEqual(int01.clouds.map((c) => c.name))
    expect(kauai.map((c) => c.scale)).toEqual(int01.clouds.map((c) => c.scale))
    const deltas = kauai.map((c, i) => {
      const base = int01.clouds[i]?.pos ?? [0, 0, 0]
      return [c.pos[0] - base[0], c.pos[1] - base[1], c.pos[2] - base[2]] as const
    })
    // Not a copy: every single row moved, and by hundreds of metres.
    expect(deltas.every((d) => Math.hypot(d[0], d[2]) > 100)).toBe(true)
    // A duplicated GROUP: one delta dominates.
    const tally = new Map<string, number>()
    for (const d of deltas) tally.set(String(d), (tally.get(String(d)) ?? 0) + 1)
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1])
    const modal = ranked[0] ?? ['', 0]
    expect(modal[1]).toBeGreaterThanOrEqual(12)
    // And that group delta is NOT the level-art instance's (-2048, 0, -2048),
    // which is what a composition applied to the wrong path would produce.
    const groupDelta = modal[0].split(',').map(Number)
    expect(Math.abs((groupDelta[0] ?? 0) + 2048)).toBeGreaterThan(50)
    expect(Math.abs((groupDelta[2] ?? 0) - 2048)).toBeGreaterThan(50)
  })

  it('puts the alpine clouds above the course, which is where a cloud layer goes', () => {
    // 1311 m to 2128 m against a course that tops out at 821 m. Alpine's are a
    // high layer rather than Simonet's low banks — none of them sits inside the
    // course footprint, and that is art direction, not a placement error.
    const alpine = load('int_02_hoverJet').clouds
    const route = (load('int_02_hoverJet') as unknown as { route: number[][] }).route
    const courseTop = Math.max(...route.map((p) => p[1] as number))
    expect(alpine.length).toBe(8)
    expect(Math.min(...alpine.map((c) => c.pos[1]))).toBeGreaterThan(courseTop)
    expect(Math.max(...alpine.map((c) => c.pos[1]))).toBeLessThan(3000)
    // Both alpine missions see the same environment, so they must agree exactly.
    expect(load('rookie_01_hoverJet').clouds).toEqual(alpine)
  })

  it('composes through the prefab instance, which is NOT at the origin', () => {
    // The instance sits at Unity (-2048, 0, -2048). Reading the prefab's local
    // positions and calling them world would put every cloud 2.9 km out — far
    // enough to be in the wrong place, close enough to look like art direction.
    //
    // The check is a RELATION, not a number: clouds hang OVER the course, so
    // most of them should sit inside its xz footprint. Composed, 12 of 19 do.
    // Undo the offset and it collapses to 3, with every cloud pushed to
    // negative z — which is the shape of the bug, not a tolerance.
    const route = (int01 as unknown as { route: number[][] }).route
    const rx = route.map((p) => p[0] as number)
    const rz = route.map((p) => p[2] as number)
    const box = {
      x0: Math.min(...rx),
      x1: Math.max(...rx),
      z0: Math.min(...rz),
      z1: Math.max(...rz),
    }
    const over = (p: readonly number[]) =>
      (p[0] as number) >= box.x0 &&
      (p[0] as number) <= box.x1 &&
      (p[2] as number) >= box.z0 &&
      (p[2] as number) <= box.z1
    expect(int01.clouds.filter((c) => over(c.pos)).length).toBeGreaterThanOrEqual(10)

    // And the same measurement on the uncomposed positions, so this fails for
    // the right reason rather than because the course moved.
    const uncomposed = int01.clouds.map((c) => [c.pos[0] + 2048, c.pos[1], c.pos[2] - 2048])
    expect(uncomposed.filter(over).length).toBeLessThan(5)
  })

  it('puts every cloud above the course and below nothing', () => {
    // 539 m to 1382 m. The course tops out at 890 m and the terrain at ~900, so
    // the lowest clouds are among the peaks and the highest are well clear —
    // which is what makes them read as sky rather than as scenery.
    const ys = int01.clouds.map((c) => c.pos[1])
    expect(Math.min(...ys)).toBeGreaterThan(500)
    expect(Math.max(...ys)).toBeLessThan(1500)
  })

  it('keeps the non-uniform scale, because that is where the variety is', () => {
    // Only three source meshes across nineteen instances; everything else is
    // the scale. Normalising it would make nineteen identical clouds.
    const widths = int01.clouds.map((c) => c.scale[0])
    expect(Math.min(...widths)).toBeGreaterThan(150)
    expect(Math.max(...widths)).toBeGreaterThan(800)
    // Most are flattened: y well under x.
    const flattened = int01.clouds.filter((c) => c.scale[1] < c.scale[0] * 0.8)
    expect(flattened.length).toBeGreaterThanOrEqual(10)
  })

  it('records which of the three silhouettes each one wore', () => {
    const counts: Record<string, number> = {}
    for (const c of int01.clouds) counts[c.shape ?? 'null'] = (counts[c.shape ?? 'null'] ?? 0) + 1
    // 17 of `GL-Cloud-02`, one each of `-01` and `-03`. A generator that
    // ignores this makes nineteen of the same thing.
    expect(counts).toEqual({ '01': 1, '02': 17, '03': 1 })
  })
})

// ── the generator ────────────────────────────────────────────────────────
//
// Pure geometry: the seed goes in and the same bytes come out. These pin the
// three things a lobed-icosphere generator gets wrong silently — a seam where
// the subdivision forgot to share midpoints, a blob that is not actually
// lumpy, and normals that are not per-face.

describe('the cloud generator', () => {
  const shape = cloudShape('02')

  it('subdivides without tearing: every edge midpoint is shared', () => {
    // If the midpoint cache misses, each face makes its OWN copy of a shared
    // vertex. The sphere still renders — and then the radial displacement moves
    // the two copies to slightly different places and the cloud splits along
    // every original edge. Counting vertices is what catches it: Euler says a
    // subdivided icosahedron has 10 * 4^n + 2 vertices, and an unshared one has
    // three per triangle.
    for (const n of [0, 1, 2]) {
      const { vertices, faces } = icosphere(n)
      expect(faces.length / 3).toBe(20 * 4 ** n)
      expect(vertices.length / 3).toBe(10 * 4 ** n + 2)
    }
  })

  it('puts every icosphere vertex on the unit sphere', () => {
    const { vertices } = icosphere(2)
    for (let i = 0; i < vertices.length; i += 3) {
      const r = Math.hypot(
        vertices[i] as number,
        vertices[i + 1] as number,
        vertices[i + 2] as number,
      )
      expect(r).toBeCloseTo(1, 6)
    }
  })

  it('is deterministic — same seed, same bytes', () => {
    const a = generateCloud(shape, 1234)
    const b = generateCloud(shape, 1234)
    const c = generateCloud(shape, 1235)
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(Array.from(a.positions)).not.toEqual(Array.from(c.positions))
  })

  it('is actually lumpy, not a sphere with extra steps', () => {
    // The whole point of the lobes. A generator whose strength quietly reached
    // zero would still produce a plausible cloud-shaped blob — because a
    // flattened sphere IS cloud-shaped — so this measures the SPREAD of the
    // radius, which a sphere has none of.
    //
    // All ratios against the blob's own mean, so it says nothing about the
    // absolute size and does not move when NOMINAL_RADIUS does.
    const cloud = generateCloud(shape, 77)
    const radii: number[] = []
    for (let i = 0; i < cloud.positions.length; i += 3) {
      // Undo the shape's vertical squash, or the flattening reads as lumpiness.
      radii.push(
        Math.hypot(
          cloud.positions[i] as number,
          (cloud.positions[i + 1] as number) / shape.flatten,
          cloud.positions[i + 2] as number,
        ),
      )
    }
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length
    const min = Math.min(...radii) / mean
    const max = Math.max(...radii) / mean
    expect(min).toBeGreaterThan(0.55) // never caves in on itself
    expect(max / min).toBeGreaterThan(1.3) // and genuinely bulges
    expect(max).toBeLessThan(2.2) // without growing a spike
  })

  it('normalises every shape and seed to the same mean radius', () => {
    // The lobes only ADD, so a 30-lobe shape naturally comes out bigger than a
    // 13-lobe one and the shape table would silently be a size table. The
    // normalising pass is what keeps `lobes` a texture control — and the mean
    // radius is the direct statement of it, where comparing two shapes' widths
    // is not: their natural sizes happen to land close enough that dropping the
    // pass entirely still passed such a test.
    for (const name of ['01', '02', '03']) {
      for (const seed of [1, 2, 99]) {
        const cloud = generateCloud(cloudShape(name), seed)
        let total = 0
        let n = 0
        for (let i = 0; i < cloud.positions.length; i += 3) {
          total += Math.hypot(
            cloud.positions[i] as number,
            cloud.positions[i + 1] as number,
            cloud.positions[i + 2] as number,
          )
          n++
        }
        // Vertices are split per face, so the mean over VERTICES weights a
        // vertex by how many faces touch it — close to, but not exactly, the
        // mean the generator normalised over. Two decimals is the honest band.
        expect(total / n, `${name} seed ${seed}`).toBeCloseTo(NOMINAL_RADIUS, 2)
      }
    }
  })

  it('gives every triangle its own flat normal', () => {
    const cloud = generateCloud(shape, 9)
    expect(cloud.positions.length).toBe(cloud.triangleCount * 9)
    let differing = 0
    for (let f = 0; f < cloud.triangleCount; f++) {
      const b = f * 9
      // All three vertices of a face share one normal...
      for (let k = 1; k < 3; k++) {
        expect(cloud.normals[b + k * 3]).toBe(cloud.normals[b])
        expect(cloud.normals[b + k * 3 + 1]).toBe(cloud.normals[b + 1])
      }
      // ...and it is a unit vector, perpendicular to the face.
      const n = [cloud.normals[b], cloud.normals[b + 1], cloud.normals[b + 2]] as number[]
      expect(Math.hypot(n[0] as number, n[1] as number, n[2] as number)).toBeCloseTo(1, 5)
      const e = [
        (cloud.positions[b + 3] as number) - (cloud.positions[b] as number),
        (cloud.positions[b + 4] as number) - (cloud.positions[b + 1] as number),
        (cloud.positions[b + 5] as number) - (cloud.positions[b + 2] as number),
      ]
      expect(
        (n[0] as number) * (e[0] as number) +
          (n[1] as number) * (e[1] as number) +
          (n[2] as number) * (e[2] as number),
      ).toBeCloseTo(0, 5)
      if (f > 0 && cloud.normals[b] !== cloud.normals[0]) differing++
    }
    // Flat shading means neighbouring faces DISAGREE. Averaged normals would
    // make this nearly zero and the cloud would read as smooth.
    expect(differing).toBeGreaterThan(cloud.triangleCount * 0.9)
  })

  it('points its lobes outward, so a cloud spreads rather than towers', () => {
    // `spread` flattens the lobe DIRECTIONS toward horizontal, so the bulges go
    // out rather than up. Measuring the finished blob's width against its
    // height does not test it — `flatten` alone guarantees a wide answer, and
    // an earlier version of this passed with `spread` removed entirely.
    //
    // So hold `flatten` at 1 and vary only `spread`. Isotropic lobes give a
    // roughly round blob; spread ones give a visibly wider than tall one.
    //
    // Averaged over seeds, because seven lobes is few enough that one draw is
    // mostly luck: at seed 5 the isotropic version already comes out 1.34 wide.
    const meanExtent = (spread: number) => {
      let total = 0
      const seeds = 32
      for (let seed = 1; seed <= seeds; seed++) {
        const cloud = generateCloud({ ...cloudShape('02'), flatten: 1, spread }, seed)
        let wide = 0
        let tall = 0
        for (let i = 0; i < cloud.positions.length; i += 3) {
          wide = Math.max(
            wide,
            Math.hypot(cloud.positions[i] as number, cloud.positions[i + 2] as number),
          )
          tall = Math.max(tall, Math.abs(cloud.positions[i + 1] as number))
        }
        total += wide / tall
      }
      return total / seeds
    }
    const isotropic = meanExtent(0)
    const spread = meanExtent(0.8)
    expect(isotropic, 'isotropic lobes should average near round').toBeLessThan(1.2)
    expect(spread / isotropic, 'spread should widen the silhouette').toBeGreaterThan(1.12)
  })

  it('stays watertight: the crunch moves SHARED vertices, not face copies', () => {
    // The one way to get vertex jitter wrong. Positions are split per face, so
    // it is easy to roughen them after the split — and then each of the faces
    // meeting at a vertex takes its copy somewhere else and the cloud comes
    // apart into confetti. It still renders, and from 500 m it still looks
    // vaguely like a cloud, which is why this counts rather than eyeballs.
    //
    // A subdivided icosahedron has 10 * 4^n + 2 vertices; split and jittered
    // per face it would have three per triangle. At n = 3 that is 642 against
    // 3840.
    const cloud = generateCloud(shape, 4242)
    const distinct = new Set<string>()
    for (let i = 0; i < cloud.positions.length; i += 3) {
      distinct.add(`${cloud.positions[i]},${cloud.positions[i + 1]},${cloud.positions[i + 2]}`)
    }
    expect(distinct.size).toBe(10 * 4 ** shape.subdivisions + 2)
    expect(cloud.triangleCount * 3).toBeGreaterThan(distinct.size * 5)
  })

  it('actually roughens the facets, and more of it roughens them more', () => {
    // Without this the lobes alone give a smooth pillow: every facet is a
    // regular subdivision of a regular solid, so neighbouring faces differ by a
    // fixed small angle and the shading reads as a sphere. The crunch is the
    // SPREAD of that angle.
    const meanNeighbourAngle = (jitter: number) => {
      const cloud = generateCloud({ ...shape, jitter }, 31)
      // Face normals, compared against the blob's own outward direction: a
      // smooth sphere has every face nearly aligned with its own centre.
      let total = 0
      for (let f = 0; f < cloud.triangleCount; f++) {
        const b = f * 9
        const cx =
          ((cloud.positions[b] as number) +
            (cloud.positions[b + 3] as number) +
            (cloud.positions[b + 6] as number)) /
          3
        const cy =
          ((cloud.positions[b + 1] as number) +
            (cloud.positions[b + 4] as number) +
            (cloud.positions[b + 7] as number)) /
          3
        const cz =
          ((cloud.positions[b + 2] as number) +
            (cloud.positions[b + 5] as number) +
            (cloud.positions[b + 8] as number)) /
          3
        const l = Math.hypot(cx, cy, cz) || 1
        const dot =
          ((cloud.normals[b] as number) * cx +
            (cloud.normals[b + 1] as number) * cy +
            (cloud.normals[b + 2] as number) * cz) /
          l
        total += Math.acos(Math.min(1, Math.max(-1, dot)))
      }
      return total / cloud.triangleCount
    }
    // NOT an absolute threshold: the lobes alone already tilt the average face
    // 29 degrees off its own radius, and an earlier version of this asserted
    // "smooth < 15 degrees" on the assumption that a lobed sphere is nearly
    // round. It is not. What the jitter does is ADD to that, monotonically.
    const smooth = meanNeighbourAngle(0)
    expect(meanNeighbourAngle(shape.jitter)).toBeGreaterThan(smooth * 1.2)
    const ladder = [0, 0.03, 0.06, 0.1, 0.15].map(meanNeighbourAngle)
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i] as number, `jitter step ${i}`).toBeGreaterThan(ladder[i - 1] as number)
    }
  })

  it('gives each shape its own silhouette', () => {
    // Three shapes across nineteen placements. If they collapsed to one, the
    // sky would be the same cloud nineteen times and nothing would error.
    const a = generateCloud(cloudShape('01'), 1)
    const b = generateCloud(cloudShape('02'), 1)
    const c = generateCloud(cloudShape('03'), 1)
    expect(Array.from(a.positions)).not.toEqual(Array.from(b.positions))
    expect(Array.from(b.positions)).not.toEqual(Array.from(c.positions))
  })

  it('falls back to the workhorse shape for an unknown or missing name', () => {
    expect(cloudShape(null)).toBe(CLOUD_SHAPES['02'])
    expect(cloudShape('99')).toBe(CLOUD_SHAPES['02'])
  })
})
