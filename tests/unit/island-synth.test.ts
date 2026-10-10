// tests/unit/island-synth.test.ts — DEV-493 (T1): an island from a seed.
//
// The generator is pure and seeded, so the properties are held directly:
// the same seed makes the same bytes; the sliders move the island the way
// their names say; every sample is in range; and a reroll's preview grid is
// cheap enough to be a reroll.

import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { courseGround, loadPlayerCourse } from '@/content/load-player-course'
import {
  canonicalPlayerCourse,
  groundKey,
  islandWaterline,
  isSeedIsland,
  PLAYER_COURSE_LIMITS,
  PLAYER_COURSE_VERSION,
  type PlayerCourse,
  playerCourseId,
  seedVersion,
  validatePlayerCourse,
} from '@/content/player-course'
import { courseToken, PLAYER_COURSE_WIRE, readCourseToken } from '@/content/player-course-wire'
import { readDraftCourse } from '@/editor/core/drafts'
import { customGroundOf, seedGridEdge, seedGround } from '@/game/terrain/custom-ground'
import { HANDLE_ADJECTIVES, HANDLE_NOUNS } from '@/net/handles'
import {
  ISLAND_SYNTH,
  ISLAND_SYNTH_V2,
  ISLAND_SYNTH_VERSION,
  type IslandShape,
  type IslandSynthVersion,
  islandElevation,
  synthesiseIsland,
} from '@/sim/terrain/island-synth'

const SHAPE: IslandShape = { size: 4096, height: 450, rugged: 0.5, sea: 0.4 }
const hash = (a: Float32Array): string =>
  crypto.createHash('sha256').update(new Uint8Array(a.buffer)).digest('hex')
const landFraction = (a: Float32Array): number => a.filter((e) => e > 0).length / a.length

describe('DEV-493 — synthesiseIsland', () => {
  it('pins its fixed numbers by value', () => {
    expect(ISLAND_SYNTH).toEqual({
      seedMax: 2147483647,
      radiusAtNoSea: 0.92,
      radiusAtMostSea: 0.3,
      coastWavelength: 1400,
      coastDepth: 0.35,
      warpWavelength: 2200,
      warpMetres: 420,
      dome: 0.5,
      hillWavelength: 1100,
      hills: 0.22,
      ridgeWavelength: 850,
      ridgeAtSmooth: 0.12,
      ridgeAtRugged: 0.62,
      shelf: 0.05,
      octaves: 5,
    })
  })

  it('the same seed gives byte-identical heights; another seed does not', () => {
    const a = synthesiseIsland(490, SHAPE, 129, 1)
    const b = synthesiseIsland(490, SHAPE, 129, 1)
    expect(hash(a)).toBe(hash(b))
    expect(hash(synthesiseIsland(493, SHAPE, 129, 1))).not.toBe(hash(a))
    // A grid is samples of ONE function: the preview's corners are the world's.
    const big = synthesiseIsland(490, SHAPE, 257, 1)
    expect(big[0]).toBe(a[0])
    expect(big[256]).toBe(a[128])
    expect(big[257 * 128 + 128]).toBe(a[129 * 64 + 64])
  })

  it('pinned bytes for three seeds (a change to the generator changes every shared seed)', () => {
    const got = [1, 490, 2147483647].map((s) =>
      hash(synthesiseIsland(s, SHAPE, 65, 1)).slice(0, 16),
    )
    expect(got).toMatchInlineSnapshot(`
      [
        "4c6e47365adddac6",
        "7b65ef760379f103",
        "ee9577e0b32e2cac",
      ]
    `)
  })

  it('every sample is in -1..1, the edge is sea and the middle is land', () => {
    for (const seed of [0, 7, 99, 12345, ISLAND_SYNTH.seedMax]) {
      for (const sea of [0, 0.5, 1]) {
        for (const rugged of [0, 1]) {
          const a = synthesiseIsland(seed, { ...SHAPE, sea, rugged }, 65, 1)
          for (const e of a) expect(e >= -1 && e <= 1).toBe(true)
          expect(a[0], 'the corner is sea').toBeLessThan(0)
          expect(Math.max(...a), 'there is land').toBeGreaterThan(0.3)
        }
      }
    }
  })

  it('the sliders: more sea is less land, more rugged is more relief', () => {
    for (const seed of [3, 41, 777]) {
      const land = [0.1, 0.5, 0.9].map((sea) =>
        landFraction(synthesiseIsland(seed, { ...SHAPE, sea }, 97, 1)),
      )
      expect(land[0]).toBeGreaterThan(land[1] as number)
      expect(land[1]).toBeGreaterThan(land[2] as number)
      // Relief: the mean absolute step between neighbours, on land.
      const relief = (rugged: number): number => {
        const a = synthesiseIsland(seed, { ...SHAPE, rugged, sea: 0.2 }, 129, 1)
        let sum = 0
        let n = 0
        for (let i = 1; i < a.length; i++) {
          if ((a[i] as number) > 0 && (a[i - 1] as number) > 0) {
            sum += Math.abs((a[i] as number) - (a[i - 1] as number))
            n++
          }
        }
        return sum / n
      }
      expect(relief(1)).toBeGreaterThan(relief(0) * 1.3)
    }
  })

  it('features are in metres: a bigger island is not the same island drawn larger', () => {
    const small = islandElevation(5, { ...SHAPE, size: 2048 }, 0.4, 0.45, 1)
    const large = islandElevation(5, { ...SHAPE, size: 8192 }, 0.4, 0.45, 1)
    expect(small).not.toBe(large)
  })

  it('a reroll preview (129²) is quick', () => {
    const t0 = performance.now()
    for (let i = 0; i < 10; i++) synthesiseIsland(i, SHAPE, 129, 1)
    const each = (performance.now() - t0) / 10
    console.info(`[DEV-493] a 129² preview synthesises in ${each.toFixed(1)} ms`)
    expect(each).toBeLessThan(100)
  })
})

// ── The format: `island: { seed, shape, colours }`, in a link ─────────────

describe('DEV-493 — a seeded island in the course, the link and the world', () => {
  const COURSE: PlayerCourse = {
    v: PLAYER_COURSE_VERSION,
    island: 'simonet',
    sky: 'int_01_hoverJet',
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    path: {
      points: [
        [0, 300, 0],
        [0, 300, 800],
      ],
      gap: 200,
    },
    rings: [],
    start: { pos: [0, 280, -60], yaw: 180 },
    finish: { t: 1 },
    timeLimit: 120,
    name: [HANDLE_ADJECTIVES[0] as string, HANDLE_NOUNS[0] as string],
  }
  const SEEDED: PlayerCourse = {
    ...COURSE,
    ground: { seed: 2147483647, shape: { size: 8192, height: 1300.4, rugged: 0.555, sea: 0.1 } },
  }

  it('is written inside `island`, quantised, and read back to the same id', () => {
    const canonical = JSON.parse(canonicalPlayerCourse(SEEDED)) as { island: unknown }
    expect(canonical.island).toEqual({
      seed: 2147483647,
      shape: { size: 8192, height: 1300, rugged: 0.56, sea: 0.1 },
      colours: 'simonet',
    })
    const back = validatePlayerCourse(canonical)
    expect(back.ok && playerCourseId(back.course)).toBe(playerCourseId(SEEDED))
    expect(back.ok && groundKey(back.course.ground)).toBe('seed:2147483647:8192:1300:0.56:0.1')
    // Height is held under Simonet's ceiling with its waterline (198 m + 1,300 fits 1,536).
    const tall = validatePlayerCourse({
      ...canonical,
      island: {
        seed: 1,
        shape: { size: 4096, height: 1400, rugged: 0, sea: 0 },
        colours: 'simonet',
      },
    })
    expect(tall.ok || tall.errors.map(([p]) => p)).toContain('island.height')
    const bad = validatePlayerCourse({
      ...canonical,
      island: {
        seed: -1,
        shape: { size: 4000, height: 400, rugged: 2, sea: 0 },
        colours: 'simonet',
      },
    })
    expect(bad.ok ? [] : bad.errors.map(([p]) => p)).toEqual(
      expect.arrayContaining(['island.seed', 'island.shape.rugged']),
    )
  })

  it('fits in a link: the most of everything, on a seeded island, is under the token cap', async () => {
    const most: PlayerCourse = {
      ...SEEDED,
      path: {
        points: Array.from(
          { length: PLAYER_COURSE_LIMITS.points.max },
          (_, i): [number, number, number] => [
            -3000.1 + i * 97.3,
            450.7 + (i % 7) * 13.1,
            -2500.3 + ((i * 37) % 64) * 83.9,
          ],
        ),
        gap: 60,
      },
    }
    const { ground: _g, ...plainCourse } = most
    const token = await courseToken(most)
    const plain = await courseToken(plainCourse)
    console.info(
      `[DEV-493] a most-of-everything link: ${token.length} characters (${token.length - plain.length} for the island)`,
    )
    expect(token.length).toBeLessThan(PLAYER_COURSE_WIRE.maxTokenChars)
    expect(token.length - plain.length).toBeLessThan(120)
    const read = await readCourseToken(token)
    expect(read.ok && groundKey(read.course.ground)).toBe(groundKey(most.ground))
  })

  it('the world ground is the same bytes every time, and stands the waterline where the sea is', async () => {
    const shape = { size: 4096, height: 500, rugged: 0.5, sea: 0.4 }
    const a = seedGround(77, shape, 'simonet', undefined, 1)
    const b = seedGround(77, shape, 'simonet', undefined, 1)
    expect(hash(a.heights.data)).toBe(hash(b.heights.data))
    expect(a.heights.width).toBe(seedGridEdge(4096, 'simonet'))
    expect(a.heights.width).toBe(513)
    expect(a.maxHeight).toBeCloseTo(islandWaterline('simonet') + 500, 6)
    // courseGround makes it from the course alone, keyed to it.
    const course: PlayerCourse = { ...COURSE, ground: { seed: 77, shape } }
    const g = await courseGround(course, null)
    expect(g?.key).toBe(groundKey(course.ground))
    expect(hash(g?.heights.data ?? new Float32Array())).toBe(hash(a.heights.data))
    const level = await loadPlayerCourse(course, { ground: g })
    expect(customGroundOf(level)?.key).toBe(groundKey(course.ground))
    await expect(loadPlayerCourse(course)).rejects.toThrow(/own island is not here/)
    // A draft keeps it.
    expect(readDraftCourse(JSON.parse(JSON.stringify(course)))?.ground).toEqual(course.ground)
  })
})

// ── DEV-499: the generator version, and version 2 ─────────────────────────

describe('DEV-499 — the island generator has a version, and v2 is 2016-shaped', () => {
  it('v2 pins its fixed numbers by value, and a new island is made with v2', () => {
    expect(ISLAND_SYNTH_VERSION).toBe(2)
    expect(ISLAND_SYNTH_V2).toEqual({
      warp2Wavelength: 900,
      warp2Metres: 160,
      dome: 0.42,
      hills: 0.24,
      ridgeAtSmooth: 0.2,
      ridgeAtRugged: 0.7,
      redistribute: 1,
      fineWavelength: 120,
      fineOctaves: 4,
      fineAtShore: 0.02,
      fineAtTop: 0.3,
      fineBias: 0.35,
      gain: 1.05,
      shelf: 0.02,
    })
  })

  it('v2 is deterministic, one function on any grid, and pinned for three seeds', () => {
    const a = synthesiseIsland(490, SHAPE, 129, 2)
    expect(hash(synthesiseIsland(490, SHAPE, 129, 2))).toBe(hash(a))
    expect(hash(a)).not.toBe(hash(synthesiseIsland(490, SHAPE, 129, 1)))
    const big = synthesiseIsland(490, SHAPE, 257, 2)
    expect(big[257 * 128 + 128]).toBe(a[129 * 64 + 64])
    const got = [1, 490, 2147483647].map((s) =>
      hash(synthesiseIsland(s, SHAPE, 65, 2)).slice(0, 16),
    )
    expect(got).toMatchInlineSnapshot(`
      [
        "fcb25e438717dd18",
        "dfc6f9b6c712dfc7",
        "6a2ffd221da7005d",
      ]
    `)
  })

  it('v2 keeps the contract: in range, sea at the corner, land in the middle, sliders by name', () => {
    for (const seed of [0, 7, 99, 12345, ISLAND_SYNTH.seedMax]) {
      for (const sea of [0, 0.5, 1]) {
        for (const rugged of [0, 1]) {
          const a = synthesiseIsland(seed, { ...SHAPE, sea, rugged }, 65, 2)
          for (const e of a) expect(e >= -1 && e <= 1).toBe(true)
          expect(a[0], 'the corner is sea').toBeLessThan(0)
          expect(Math.max(...a), 'there is land').toBeGreaterThan(0.3)
        }
      }
    }
    for (const seed of [3, 41, 777]) {
      const land = [0.1, 0.5, 0.9].map((sea) =>
        landFraction(synthesiseIsland(seed, { ...SHAPE, sea }, 97, 2)),
      )
      expect(land[0]).toBeGreaterThan(land[1] as number)
      expect(land[1]).toBeGreaterThan(land[2] as number)
    }
  })

  // The row measured 2016's maps against both versions at the facet pitch.
  // What this holds is the direction of the change, per seed, on the world's
  // own grid: v2 has more small-scale relief (a crag) and a lower body under
  // the same summit than v1 — the two things 2016's islands had and v1 lacked.
  it('v2 against v1, on the world grid: rougher inside 40 m, and a lower body for its summit', () => {
    const shape = { size: 4096, height: 1337, rugged: 0.5, sea: 0.45 }
    const stats = (version: IslandSynthVersion, seed: number) => {
      const n = 513
      const e = synthesiseIsland(seed, shape, n, version)
      let land = 0
      let sum = 0
      let peak = 0
      let relief = 0
      for (let r = 2; r < n - 2; r++) {
        for (let c = 2; c < n - 2; c++) {
          const y = e[r * n + c] as number
          if (y <= 0.001) continue
          land++
          sum += y
          peak = Math.max(peak, y)
          let m = 0
          for (let a = -2; a <= 2; a++)
            for (let b = -2; b <= 2; b++) m += e[(r + a) * n + c + b] as number
          relief += Math.abs(y - m / 25)
        }
      }
      return { bodyOverPeak: sum / land / peak, relief: (relief / land) * shape.height }
    }
    for (const seed of [1, 490, 2026]) {
      const one = stats(1, seed)
      const two = stats(2, seed)
      expect(two.relief, `seed ${seed}: relief inside 40 m`).toBeGreaterThan(one.relief * 2)
      expect(two.bodyOverPeak, `seed ${seed}: body under the summit`).toBeLessThan(one.bodyOverPeak)
    }
  })

  const COURSE_V: PlayerCourse = {
    v: PLAYER_COURSE_VERSION,
    island: 'simonet',
    sky: 'int_01_hoverJet',
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    path: {
      points: [
        [0, 300, 0],
        [0, 300, 800],
      ],
      gap: 200,
    },
    rings: [],
    start: { pos: [0, 280, -60], yaw: 180 },
    finish: { t: 1 },
    timeLimit: 120,
    name: [HANDLE_ADJECTIVES[0] as string, HANDLE_NOUNS[0] as string],
  }
  const SHAPE_V = { size: 4096, height: 500, rugged: 0.5, sea: 0.4 }

  it('a version-less seed course reads as v1, keeps its bytes and id; 1 is never written', () => {
    const old: PlayerCourse = { ...COURSE_V, ground: { seed: 77, shape: SHAPE_V } }
    const canonical = JSON.parse(canonicalPlayerCourse(old)) as { island: Record<string, unknown> }
    expect(Object.keys(canonical.island)).toEqual(['seed', 'shape', 'colours'])
    const back = validatePlayerCourse(canonical)
    if (!back.ok || !isSeedIsland(back.course.ground)) throw new Error('refused')
    expect(seedVersion(back.course.ground)).toBe(1)
    expect(playerCourseId(back.course)).toBe(playerCourseId(old))
    // An explicit 1 is the same course: the same bytes, the same id.
    const one = validatePlayerCourse({ ...canonical, island: { v: 1, ...canonical.island } })
    expect(one.ok && canonicalPlayerCourse(one.course)).toBe(canonicalPlayerCourse(old))
    // The key a draft compares worlds by is the one DEV-493 wrote.
    expect(groundKey(old.ground)).toBe('seed:77:4096:500:0.5:0.4')
  })

  it('a v2 course writes its version first, is another island and another id', async () => {
    const v1: PlayerCourse = { ...COURSE_V, ground: { seed: 77, shape: SHAPE_V } }
    const v2: PlayerCourse = { ...COURSE_V, ground: { v: 2, seed: 77, shape: SHAPE_V } }
    const canonical = JSON.parse(canonicalPlayerCourse(v2)) as { island: Record<string, unknown> }
    expect(Object.keys(canonical.island)).toEqual(['v', 'seed', 'shape', 'colours'])
    expect(canonical.island.v).toBe(2)
    expect(playerCourseId(v2)).not.toBe(playerCourseId(v1))
    expect(groundKey(v2.ground)).toBe('seed:77:4096:500:0.5:0.4:v2')
    const back = validatePlayerCourse(canonical)
    expect(back.ok && playerCourseId(back.course)).toBe(playerCourseId(v2))
    // The world is built by the version the course names.
    const g1 = await courseGround(v1, null)
    const g2 = await courseGround(v2, null)
    expect(hash(g1?.heights.data ?? new Float32Array())).toBe(
      hash(seedGround(77, SHAPE_V, 'simonet', undefined, 1).heights.data),
    )
    expect(hash(g2?.heights.data ?? new Float32Array())).toBe(
      hash(seedGround(77, SHAPE_V, 'simonet', undefined, 2).heights.data),
    )
    expect(hash(g2?.heights.data ?? new Float32Array())).not.toBe(
      hash(g1?.heights.data ?? new Float32Array()),
    )
    // A link carries it, and a draft keeps it.
    const read = await readCourseToken(await courseToken(v2))
    expect(read.ok && groundKey(read.course.ground)).toBe(groundKey(v2.ground))
    expect(readDraftCourse(JSON.parse(JSON.stringify(v2)))?.ground).toEqual(v2.ground)
  })

  it('a later generator is refused by name, and a version that is not one is refused', () => {
    const canonical = JSON.parse(
      canonicalPlayerCourse({ ...COURSE_V, ground: { v: 2, seed: 77, shape: SHAPE_V } }),
    ) as { island: Record<string, unknown> }
    const later = validatePlayerCourse({ ...canonical, island: { ...canonical.island, v: 3 } })
    expect(later.ok ? [] : later.errors).toContainEqual([
      'island.v',
      expect.stringMatching(/newer build \(island generator 3\)/),
    ])
    for (const v of [0, '2', 1.5, null]) {
      const bad = validatePlayerCourse({ ...canonical, island: { ...canonical.island, v } })
      expect(bad.ok ? [] : bad.errors.map(([p]) => p)).toContain('island.v')
    }
  })
})
