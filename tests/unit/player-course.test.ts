// tests/unit/player-course.test.ts — the player-course format, v1. DEV-466.
//
// What is worth asserting, and against what:
//
//  1. The POLICY, by value: `PLAYER_COURSE_LIMITS` and `PLAYER_COURSE_SHAPE`
//     are the numbers a shared course is judged by. Moving one is an edit made
//     here on purpose (CLAUDE.md, "CHANGING A SHIPPED DEFAULT").
//  2. The numbers those limits LEAN on, measured from 2016's own data rather
//     than restated: the ring trigger radius the gap floor clears, the route
//     spacing, the facing axis of a ring and of the finish, the spawn's yaw
//     convention, and the medal bands. A derived number needs a test (DEV-027).
//  3. The canonical form and the id: identical under key order and under
//     sub-quantum noise, different for a different course.
//  4. The validator never throws. Fuzzed with garbage and with mutated good
//     courses, it returns errors with paths.
//  5. Expansion, on every HoverJet donor on all four islands, passes
//     `validateLevel`, `validateModeContent` and `content/levels/_schema.json`.
//  6. The GEOMETRY, not the rotation (the orientation lesson, DEVIATIONS):
//     a metre along each ring's facing is further along the path, and ring
//     centres are `gap` apart by arc length.
//  7. The OUTSIDE ORACLE: a spline fitted to `int_01_hoverJet`'s own route,
//     expanded at 2016's own spacing, lands on 2016's rings — and 2016's two
//     recorded flights score on it exactly as they score on 2016's course.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { nearestArc, splineTangentAt } from '@/content/course-spline'
import {
  type Level,
  liveRings,
  maxRingScore,
  type Ring,
  type SpawnPoint,
  validateLevel,
} from '@/content/level-schema'
import { loadPlayerCourse } from '@/content/load-player-course'
import {
  canonicalPlayerCourse,
  expandPlayerCourse,
  isCourseName,
  islandExtent,
  normaliseYaw,
  PLAYER_COURSE_GENERATOR,
  PLAYER_COURSE_LIMITS,
  PLAYER_COURSE_SHAPE,
  PLAYER_COURSE_VERSION,
  type PlayerCourse,
  PlayerCourseError,
  playerCourseArea,
  playerCourseId,
  playerCourseMedals,
  playerCourseSpline,
  randomCourseName,
  ringFacing,
  validatePlayerCourse,
} from '@/content/player-course'
import { sha256Hex } from '@/content/sha256'
import { courseGates } from '@/game/mission'
import { validateModeContent } from '@/game/modes'
import { HANDLE_ADJECTIVES, HANDLE_NOUNS } from '@/net/handles'
import { decodeGhostClip, type GhostCourse, type GhostDoc, scoreGhost } from '@/sim/ghost'
import { type Quat, quat, rotateVec3 } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'
import fastDoc from '../../content/ghosts/int_01_leftSpawn_fast_01.json'
import slowDoc from '../../content/ghosts/int_01_rightSpawn_slow_01.json'
import { REPO, rel, walkImports } from '../../tools/test/import-graph.mjs'
import { readJson, shippedLevels } from './helpers/content'
import { createValidator, type SchemaNode } from './helpers/json-schema'
import { seeded as rng } from './helpers/seeded'

type V = [number, number, number]

// ── The shipped levels, read the way the loader reads them ───────────────

const shipped: Level[] = shippedLevels()
const hoverjets = shipped.filter((l) => l.vehicle === 'hoverjet')
const byId = (id: string): Level => shipped.find((l) => l.id === id) as Level
const int01 = byId('int_01_hoverJet')

const levelSchema = readJson<SchemaNode>('content/levels/_schema.json')
const validateAgainstSchema = createValidator(levelSchema)

// ── Small helpers ─────────────────────────────────────────────────────────

const qv = (q: readonly number[]): Quat =>
  quat(q[0] as number, q[1] as number, q[2] as number, q[3] as number)
const vv = (p: readonly number[]): Vec3 => v3(p[0] as number, p[1] as number, p[2] as number)
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.sqrt(
    ((a[0] as number) - (b[0] as number)) ** 2 +
      ((a[1] as number) - (b[1] as number)) ** 2 +
      ((a[2] as number) - (b[2] as number)) ** 2,
  )
/**
 * Local −z in the world: the facing axis, written HERE rather than imported, so
 * the geometry tests do not read the module's belief back to it.
 */
const minusZ = (q: readonly number[]): Vec3 => rotateVec3(v3(), qv(q), v3(0, 0, -1))
const deg = (c: number): number => (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI

/** Tangent of a polyline at its vertex nearest `p`, by central difference. */
const polyTangent = (poly: readonly (readonly number[])[], p: readonly number[]): Vec3 => {
  let best = 0
  let bestD = Number.POSITIVE_INFINITY
  poly.forEach((q, i) => {
    const d = dist(q, p)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  const a = poly[Math.max(0, best - 1)] as readonly number[]
  const b = poly[Math.min(poly.length - 1, best + 1)] as readonly number[]
  const t = vv([
    (b[0] as number) - (a[0] as number),
    (b[1] as number) - (a[1] as number),
    (b[2] as number) - (a[2] as number),
  ])
  const l = Math.sqrt(dot(t, t))
  return v3(t.x / l, t.y / l, t.z / l)
}

/** A deterministic PRNG (mulberry32), so a fuzz failure reproduces. */
/** Is `p` inside the donor's play area? The test's own reading of the two shapes. */
const insideOf = (donor: Level, p: readonly number[]): boolean => {
  const area = playerCourseArea(donor)
  if (area?.kind === 'sphere') return dist(p, area.centre) <= area.radius
  return (
    area?.kind === 'box' &&
    [0, 1, 2].every(
      (i) =>
        (p[i] as number) >= (area.min[i] as number) && (p[i] as number) <= (area.max[i] as number),
    )
  )
}

/**
 * A course drawn along a donor's own route: every `every`th point of the part
 * inside the donor's play area (all of it, but for int_02's first kilometre —
 * see below), finishing where the route passes nearest the donor's finish gate.
 */
const courseAlong = (donor: Level, every = 12, gap = 400): PlayerCourse => {
  const route = (donor.route as V[]).filter((p) => insideOf(donor, p))
  const points: V[] = []
  for (let i = 0; i < route.length; i += every) points.push(route[i] as V)
  const last = route[route.length - 1] as V
  if (points[points.length - 1] !== last) points.push(last)
  const first = points[0] as V
  const second = points[1] as V
  const draft: PlayerCourse = {
    v: PLAYER_COURSE_VERSION,
    island: donor.environment,
    sky: donor.id,
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    path: { points: points.slice(0, PLAYER_COURSE_LIMITS.points.max), gap },
    rings: [],
    // DEV-475: the pad at the line's first point, headed along its first leg.
    start: {
      pos: first,
      yaw: normaliseYaw(
        (Math.atan2(-(second[0] - first[0]), -(second[2] - first[2])) * 180) / Math.PI,
      ),
    },
    finish: { t: 1 },
    timeLimit: donor.timer.timeLimit,
    name: ['Amber', 'Heron'],
  }
  const spline = playerCourseSpline(draft)
  const fin = donor.finish as NonNullable<Level['finish']>
  const t = Math.round((nearestArc(spline, vv(fin.pos)) / spline.length) * 1e4) / 1e4
  return { ...draft, finish: { t: Math.max(0.5, t) } }
}

/** A valid course on int_01, small enough to read. */
const SAMPLE: PlayerCourse = courseAlong(int01)

// ── 1. The policy, pinned ─────────────────────────────────────────────────

describe('DEV-466 — the policy numbers, pinned by value', () => {
  it('holds these limits', () => {
    expect(PLAYER_COURSE_LIMITS).toEqual({
      points: { min: 2, max: 64 },
      pointSpacingMetres: { min: 5 },
      gapMetres: { min: 60, max: 1000 },
      timeLimitSeconds: { min: 30, max: 900 },
      rings: { min: 1, max: 100 },
      coordinateMetres: 32_768,
      airAboveTerrainMetres: 1000,
      anchorHeightMetres: { min: 0, max: 1000 }, // DEV-501
      props: { max: 1024 }, // DEV-504: 256; DEV-533: the FILE's ceiling (the link's is 128)
      propScaleRatio: { min: 0.25, max: 4 }, // DEV-504
      propSpacingMetres: 1, // DEV-504
      idLength: 64,
      errorsReported: 32,
    })
  })

  it('holds this shape', () => {
    expect(PLAYER_COURSE_SHAPE).toEqual({
      pointQuantumMetres: 0.1,
      tQuantum: 0.0001,
      yawQuantumDegrees: 0.1,
      gapQuantumMetres: 1,
      timeLimitQuantumSeconds: 1,
      propYawQuantumDegrees: 1, // DEV-504
      propScaleQuantum: 0.01, // DEV-504
      divisionsPerSegment: 64,
      tension: 0.5,
      routeSpacingMetres: 25,
      idHexDigits: 12,
    })
    expect(PLAYER_COURSE_GENERATOR).toBe('player-v1')
  })
})

// ── 2. What the limits lean on, measured from 2016 ────────────────────────

describe('the numbers the format leans on are 2016’s, measured', () => {
  it('finds the seven HoverJet missions on four islands', () => {
    expect(hoverjets.map((l) => l.id).sort()).toEqual([
      'adv_01_hoverJet',
      'adv_02_hoverJet',
      'hoverJet_kauai_beg',
      'int_01_hoverJet',
      'int_02_hoverJet',
      'rookie_01_hoverJet',
      'rookie_02_hoverJet',
    ])
    expect([...new Set(hoverjets.map((l) => l.environment))].sort()).toEqual([
      'alpine',
      'desert',
      'kauai',
      'simonet',
    ])
  })

  it('the gap floor clears two ring triggers, so no two triggers overlap', () => {
    for (const l of hoverjets) {
      for (const r of liveRings(l)) {
        expect(2 * r.trigger.radius, `${l.id} ${r.name}`).toBeLessThan(
          PLAYER_COURSE_LIMITS.gapMetres.min,
        )
      }
    }
  })

  it('2016 spaced its rings inside the gap range', () => {
    for (const l of hoverjets) {
      const rings = liveRings(l)
      for (let i = 1; i < rings.length; i++) {
        const d = dist((rings[i] as Ring).pos, (rings[i - 1] as Ring).pos)
        expect(d, `${l.id} ring ${i}`).toBeGreaterThan(PLAYER_COURSE_LIMITS.gapMetres.min)
        expect(d, `${l.id} ring ${i}`).toBeLessThan(PLAYER_COURSE_LIMITS.gapMetres.max)
      }
    }
  })

  it('the route spacing sits inside the spacing 2016 wrote its routes at', () => {
    const spacings = hoverjets.map((l) => {
      const r = l.route as V[]
      let len = 0
      for (let i = 1; i < r.length; i++) len += dist(r[i] as V, r[i - 1] as V)
      return len / (r.length - 1)
    })
    expect(Math.min(...spacings)).toBeLessThanOrEqual(PLAYER_COURSE_SHAPE.routeSpacingMetres)
    expect(Math.max(...spacings)).toBeGreaterThanOrEqual(PLAYER_COURSE_SHAPE.routeSpacingMetres)
  })

  it('a ring faces along its local −z, with +y up: measured on every shipped ring', () => {
    // The axis `ringFacing` and the expansion's frame are built on. Measured
    // against each route's own tangent, so it is a fact about 2016's data and
    // not a belief about a quaternion.
    for (const l of hoverjets) {
      for (const r of liveRings(l)) {
        const facing = minusZ(r.quat)
        const along = polyTangent(l.route as V[], r.pos)
        expect(deg(dot(facing, along)), `${l.id} ${r.name} facing`).toBeLessThan(5)
        const up = rotateVec3(v3(), qv(r.quat), v3(0, 1, 0))
        const flat = v3(-facing.y * facing.x, 1 - facing.y * facing.y, -facing.y * facing.z)
        const fl = Math.sqrt(dot(flat, flat))
        expect(deg(dot(up, flat) / fl), `${l.id} ${r.name} roll`).toBeLessThan(2)
      }
    }
  })

  it('ringFacing is that measured axis', () => {
    for (const r of liveRings(int01)) {
      expect(ringFacing(r.quat)).toEqual(minusZ(r.quat))
    }
  })

  it('the finish gate’s frame −z and its trigger’s +z agree, on every shipped finish', () => {
    // `expandFinish` faces the gate by its art frame, and by the trigger where
    // there is no art: the two must be one direction or the fallback is a lie.
    for (const l of hoverjets) {
      const f = l.finish
      if (f?.shape !== 'sphereUnion' || !f.art) throw new Error(`${l.id} finish`)
      const a = minusZ(f.art.frame.quat)
      const b = rotateVec3(v3(), qv(f.quat), v3(0, 0, 1))
      expect(deg(dot(a, b)), l.id).toBeLessThan(1)
    }
  })

  it('a spawn noses along its local −z: int_01’s own spawn faces its first ring', () => {
    // The yaw convention `spawnAt` writes, checked on 2016's own spawn.
    const nose = rotateVec3(v3(), qv(int01.respawn.quat), v3(0, 0, -1))
    const toRing = vv((liveRings(int01)[0] as Ring).pos)
    const from = vv(int01.respawn.pos)
    const d = v3(toRing.x - from.x, toRing.y - from.y, toRing.z - from.z)
    const horizontal = Math.sqrt(d.x * d.x + d.z * d.z)
    expect((nose.x * d.x + nose.z * d.z) / horizontal).toBeGreaterThan(0.95)
  })

  it('the time bonus’s par is the time limit on every shipped HoverJet mission', () => {
    for (const l of hoverjets) expect(l.timer.bonusParTime, l.id).toBe(l.timer.timeLimit)
  })

  it('the medal rule gives back each donor’s own curve on the donor’s own ring count', () => {
    for (const l of hoverjets) {
      const n = liveRings(l).length
      const perRing = maxRingScore(l) / n
      expect(playerCourseMedals(l, n, perRing), l.id).toEqual({
        bronze: l.medalsFf2?.bronze,
        silver: l.medalsFf2?.silver,
        gold: l.medalsFf2?.gold,
        platinum: l.medalsFf2?.platinum,
      })
    }
  })

  it('the medal bands never cross, and platinum is every ring, however few', () => {
    for (const l of hoverjets) {
      for (let n = 1; n <= 40; n++) {
        const m = playerCourseMedals(l, n, 100)
        expect(m.bronze).toBeGreaterThanOrEqual(100)
        expect(m.silver).toBeGreaterThanOrEqual(m.bronze)
        expect(m.gold).toBeGreaterThanOrEqual(m.silver)
        expect(m.platinum).toBe(n * 100)
        expect(m.platinum).toBeGreaterThanOrEqual(m.gold)
      }
    }
  })

  it('the island extents land where the scene flattener measured the terrains', () => {
    // `terrain-env-root.test.ts`'s oracle: world positions read through a
    // second code path (the flattener), Unity space. The THREE box's min x is
    // the Unity corner's x, and its max z is the Unity corner's z mirrored.
    const measured: Record<string, V> = {
      simonet: [-2157.91968, -81.69, -1867.1416],
      kauai: [-4266, 68, -3739],
      alpine: [-2157.919624, 15.881851, -1867.14154],
      desert: [-2157.919624, 15.881851, -1867.14154],
    }
    for (const [env, corner] of Object.entries(measured)) {
      const e = islandExtent(env, int01.worldOffset)
      expect(e, env).not.toBeNull()
      expect(e?.min[0], env).toBeCloseTo(corner[0], 3)
      expect(e?.min[1], env).toBeCloseTo(corner[1], 3)
      expect(e?.max[2], env).toBeCloseTo(-corner[2], 3)
    }
    // kauai's land is twice the others' size, and the box says so.
    const k = islandExtent('kauai', int01.worldOffset)
    expect((k?.max[0] ?? 0) - (k?.min[0] ?? 0)).toBe(8192)
    expect(islandExtent('nowhere', int01.worldOffset)).toBeNull()
  })

  it('every shipped HoverJet route lies inside its own play area — but int_02 STARTS outside', () => {
    // The premise of every "donor" test below, and of the bounds: a course
    // drawn along 2016's own line is a course 2016 flew. True of six of seven.
    // int_02_hoverJet spawns ~445 m OUTSIDE its own 1,944.6 m boundary sphere
    // and its route's first ~1 km, ring 0 included, is outside too. 2016 never
    // noticed because the boundary is an EDGE trigger (DEV-074): a ship that
    // was never inside never leaves. A player course is held to "every point
    // inside", which is stricter than 2016 was on its own course.
    const outsideAt: Record<string, number[]> = {}
    for (const l of hoverjets) {
      expect(playerCourseArea(l), l.id).not.toBeNull()
      const idx = (l.route as V[]).flatMap((p, i) => (insideOf(l, p) ? [] : [i]))
      if (idx.length > 0) outsideAt[l.id] = idx
    }
    expect(Object.keys(outsideAt)).toEqual(['int_02_hoverJet'])
    const idx = outsideAt.int_02_hoverJet as number[]
    // A PREFIX: the start is outside, and once in, the line stays in.
    expect(idx).toEqual(idx.map((_, i) => i))
    expect(insideOf(byId('int_02_hoverJet'), byId('int_02_hoverJet').spawn.pos)).toBe(false)
  })
})

// ── SHA-256 against node's own ────────────────────────────────────────────

describe('sha256Hex agrees with node:crypto', () => {
  const node = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
  it('on the FIPS 180-4 examples', () => {
    const enc = new TextEncoder()
    expect(sha256Hex(enc.encode(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256Hex(enc.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256Hex(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('on every length across the padding boundaries, and some long ones', () => {
    const next = rng(466)
    for (const n of [...Array.from({ length: 200 }, (_, i) => i), 1000, 4096, 65_537]) {
      const bytes = new Uint8Array(n)
      for (let i = 0; i < n; i++) bytes[i] = Math.floor(next() * 256)
      expect(sha256Hex(bytes), `length ${n}`).toBe(node(bytes))
    }
  })
})

// ── 3. The canonical form and the id ──────────────────────────────────────

/** The same object with every key order reversed, all the way down. */
const reversedKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(reversedKeys)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).reverse())
      out[k] = reversedKeys((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

describe('the canonical form, and the id', () => {
  it('round-trips: canonical -> parse -> validate -> canonical is identical', () => {
    const once = canonicalPlayerCourse(SAMPLE)
    const parsed = validatePlayerCourse(JSON.parse(once), int01)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(canonicalPlayerCourse(parsed.course)).toBe(once)
  })

  it('is an id of the right shape, whose seed is its own 48 bits', () => {
    const id = playerCourseId(SAMPLE)
    expect(id).toMatch(/^pc_[0-9a-f]{12}$/)
    const level = expandPlayerCourse(SAMPLE, int01)
    expect(level.id).toBe(id)
    expect(level.generated).toEqual({
      generator: 'player-v1',
      seed: Number.parseInt(id.slice(3), 16),
    })
    expect(Number.isSafeInteger(level.generated?.seed)).toBe(true)
  })

  it('does not depend on key order', () => {
    const shuffled = reversedKeys(SAMPLE)
    const parsed = validatePlayerCourse(shuffled)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(playerCourseId(parsed.course)).toBe(playerCourseId(SAMPLE))
    expect(canonicalPlayerCourse(parsed.course)).toBe(canonicalPlayerCourse(SAMPLE))
  })

  it('does not depend on float noise below a quantum', () => {
    const next = rng(7)
    // Start from the canonical course, whose numbers sit ON their grid, and
    // nudge each by under half a quantum, both ways.
    const parsed = validatePlayerCourse(JSON.parse(canonicalPlayerCourse(SAMPLE)))
    if (!parsed.ok) throw new Error('sample')
    const c = parsed.course
    const nudge = (x: number, q: number): number => x + (next() - 0.5) * 0.8 * q
    const noisy: PlayerCourse = {
      ...c,
      path: {
        points: c.path.points.map(
          (p) => p.map((x) => nudge(x, PLAYER_COURSE_SHAPE.pointQuantumMetres)) as V,
        ),
        gap: nudge(c.path.gap, PLAYER_COURSE_SHAPE.gapQuantumMetres),
      },
      start: {
        pos: c.start.pos.map((x) => nudge(x, PLAYER_COURSE_SHAPE.pointQuantumMetres)) as V,
        yaw: nudge(c.start.yaw, PLAYER_COURSE_SHAPE.yawQuantumDegrees),
      },
      finish: { t: nudge(c.finish.t, PLAYER_COURSE_SHAPE.tQuantum) },
      timeLimit: nudge(c.timeLimit, PLAYER_COURSE_SHAPE.timeLimitQuantumSeconds),
    }
    expect(canonicalPlayerCourse(noisy)).toBe(canonicalPlayerCourse(c))
    expect(playerCourseId(noisy)).toBe(playerCourseId(c))
  })

  it('carries no float noise of its own', () => {
    // `0.1 * 3` prints as 0.30000000000000004; the canonical form must not.
    const text = canonicalPlayerCourse(SAMPLE)
    expect(text).not.toMatch(/\d\.\d*0000000\d/)
    expect(text).not.toMatch(/\d\.\d*9999999\d/)
  })

  it('changes when the course does', () => {
    const ids = new Set([
      playerCourseId(SAMPLE),
      playerCourseId({ ...SAMPLE, path: { ...SAMPLE.path, gap: SAMPLE.path.gap + 1 } }),
      playerCourseId({ ...SAMPLE, timeLimit: SAMPLE.timeLimit + 1 }),
      playerCourseId({ ...SAMPLE, name: ['Azure', 'Heron'] }),
      playerCourseId({ ...SAMPLE, start: { ...SAMPLE.start, yaw: SAMPLE.start.yaw + 1 } }),
      playerCourseId({
        ...SAMPLE,
        start: {
          ...SAMPLE.start,
          pos: [...SAMPLE.start.pos.slice(0, 2), SAMPLE.start.pos[2] + 1] as V,
        },
      }),
      playerCourseId({ ...SAMPLE, sky: 'adv_02_hoverJet' }),
    ])
    expect(ids.size).toBe(7)
  })
})

// ── 4. The validator never throws ─────────────────────────────────────────

const expectRefusal = (r: ReturnType<typeof validatePlayerCourse>, label: string): void => {
  expect(r.ok, label).toBe(false)
  if (r.ok) return
  expect(r.errors.length, label).toBeGreaterThan(0)
  expect(r.errors.length, label).toBeLessThanOrEqual(PLAYER_COURSE_LIMITS.errorsReported)
  for (const e of r.errors) {
    expect(typeof e[0], label).toBe('string')
    expect(typeof e[1], label).toBe('string')
    expect(e[1].length, label).toBeGreaterThan(0)
  }
}

describe('validatePlayerCourse never throws', () => {
  const randomValue = (next: () => number, depth: number): unknown => {
    const pick = Math.floor(next() * 12)
    switch (pick) {
      case 0:
        return null
      case 1:
        return next() < 0.5
      case 2:
        return (next() - 0.5) * 10 ** Math.floor(next() * 12)
      case 3:
        return [Number.NaN, Number.POSITIVE_INFINITY, -0, Number.MAX_VALUE][Math.floor(next() * 4)]
      case 4:
        return 'x'.repeat(Math.floor(next() * 100))
      case 5:
        return ['simonet', 'int_01_hoverJet', 'hoverjet', 'ringAttack', 'Amber', '__proto__'][
          Math.floor(next() * 6)
        ]
      case 6:
      case 7:
        if (depth > 3) return 0
        return Array.from({ length: Math.floor(next() * 5) }, () => randomValue(next, depth + 1))
      default: {
        if (depth > 3) return {}
        const keys = [
          'v',
          'island',
          'sky',
          'path',
          'points',
          'gap',
          't',
          'seed',
          'map',
          'rings',
          'name',
          'zzz',
        ]
        const out: Record<string, unknown> = {}
        for (let i = Math.floor(next() * 5); i > 0; i--) {
          out[keys[Math.floor(next() * keys.length)] as string] = randomValue(next, depth + 1)
        }
        return out
      }
    }
  }

  it('on random JSON', () => {
    const next = rng(20260927)
    for (let i = 0; i < 2000; i++) {
      const input = randomValue(next, 0)
      let r: ReturnType<typeof validatePlayerCourse> | undefined
      expect(() => {
        r = validatePlayerCourse(input)
      }, `case ${i}`).not.toThrow()
      expectRefusal(r as ReturnType<typeof validatePlayerCourse>, `case ${i}`)
      expect(() => validatePlayerCourse(input, int01), `case ${i} with donor`).not.toThrow()
    }
  })

  it('on mutated good courses, with and without the donor', () => {
    const next = rng(466)
    const good = JSON.parse(canonicalPlayerCourse(SAMPLE)) as Record<string, unknown>
    /** Every path into the object, so a mutation can land anywhere. */
    const paths: (string | number)[][] = []
    const walk = (v: unknown, at: (string | number)[]): void => {
      paths.push(at)
      if (Array.isArray(v))
        v.forEach((x, i) => {
          walk(x, [...at, i])
        })
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) walk(x, [...at, k])
    }
    walk(good, [])
    let refused = 0
    for (let i = 0; i < 3000; i++) {
      const copy = JSON.parse(JSON.stringify(good)) as Record<string, unknown>
      const at = paths[Math.floor(next() * paths.length)] as (string | number)[]
      if (at.length === 0) continue
      let parent: unknown = copy
      for (const k of at.slice(0, -1)) parent = (parent as Record<string | number, unknown>)[k]
      const leaf = at[at.length - 1] as string | number
      if (next() < 0.2) delete (parent as Record<string | number, unknown>)[leaf]
      else (parent as Record<string | number, unknown>)[leaf] = randomValue(next, 1)
      for (const donor of [undefined, int01]) {
        let r: ReturnType<typeof validatePlayerCourse> | undefined
        expect(
          () => {
            r = validatePlayerCourse(copy, donor)
          },
          `mutation ${i} at ${at.join('.')}`,
        ).not.toThrow()
        const result = r as ReturnType<typeof validatePlayerCourse>
        if (!result.ok) {
          refused++
          expectRefusal(result, `mutation ${i}`)
        }
      }
    }
    // Most mutations break something; a validator that refused nothing would
    // pass the loop above too.
    expect(refused).toBeGreaterThan(3000)
  })

  it('checks an array’s length before it walks it', () => {
    const huge = { ...SAMPLE, path: { points: new Array(1_000_000).fill([0, 0, 0]), gap: 400 } }
    const started = performance.now()
    const r = validatePlayerCourse(huge)
    expect(performance.now() - started).toBeLessThan(50)
    expectRefusal(r, 'huge')
    if (!r.ok) expect(r.errors[0]?.[0]).toBe('path.points')
  })

  it('refuses an unknown key rather than ignoring it — __proto__ included', () => {
    const smuggled = JSON.parse(
      `{"__proto__": {"polluted": 1}, ${canonicalPlayerCourse(SAMPLE).slice(1)}`,
    )
    expectRefusal(validatePlayerCourse(smuggled), '__proto__')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expectRefusal(validatePlayerCourse({ ...SAMPLE, extra: 1 }), 'extra')
  })

  it('never echoes a long hostile string back', () => {
    const r = validatePlayerCourse({ ...SAMPLE, sky: 'A'.repeat(10_000) })
    expectRefusal(r, 'long sky')
    if (!r.ok) for (const [p, m] of r.errors) expect(p.length + m.length).toBeLessThan(200)
  })
})

// ── The fields, one refusal each ──────────────────────────────────────────

describe('what a course refuses', () => {
  const refusedAt = (input: unknown, donor?: Level): string[] => {
    const r = validatePlayerCourse(input, donor)
    return r.ok ? [] : r.errors.map(([p]) => p)
  }

  it('the reserved island shapes, read field by field: seeded (T1, DEV-493) and imported (T1.5, DEV-490)', () => {
    // DEV-493 reads the seed shape; a shape that is a word, with no colours, is
    // refused for exactly those.
    const seeded = validatePlayerCourse({ ...SAMPLE, island: { seed: 7, shape: 'atoll' } })
    expect(seeded.ok ? [] : seeded.errors.map(([p]) => p)).toEqual([
      'island.colours',
      'island.shape',
      'island',
    ])
    // DEV-490 reads the map shape; one without its waterline and its colours
    // is refused for exactly those two.
    const mapped = validatePlayerCourse({
      ...SAMPLE,
      island: { map: 'ab'.repeat(32), size: 4096, height: 1024 },
    })
    expect(mapped.ok ? [] : mapped.errors.map(([p]) => p)).toEqual([
      'island.sea',
      'island.colours',
      'island',
    ])
  })

  it('a newer format by its version', () => {
    const r = validatePlayerCourse({ ...SAMPLE, v: PLAYER_COURSE_VERSION + 1 })
    expect(r.ok || r.errors[0]?.[1]).toContain('newer than this build')
  })

  it('another vehicle or mode', () => {
    expect(refusedAt({ ...SAMPLE, vehicle: 'jumpseat' })).toEqual(['vehicle'])
    expect(refusedAt({ ...SAMPLE, mode: 'freeFlight' })).toEqual(['mode'])
  })

  it('a name off the lists, or free text', () => {
    expect(refusedAt({ ...SAMPLE, name: ['amber', 'Heron'] })).toEqual(['name'])
    expect(refusedAt({ ...SAMPLE, name: ['Heron', 'Amber'] })).toEqual(['name'])
    expect(refusedAt({ ...SAMPLE, name: 'Amber Heron' })).toEqual(['name'])
    expect(isCourseName(['Amber', 'Heron'])).toBe(true)
    const next = rng(3)
    for (let i = 0; i < 50; i++) {
      expect(isCourseName(randomCourseName((n) => Math.floor(next() * n)))).toBe(true)
    }
    expect(HANDLE_ADJECTIVES).toContain('Amber')
    expect(HANDLE_NOUNS.length).toBeGreaterThan(0)
  })

  it('bounds on counts, gaps, times and parameters', () => {
    const L = PLAYER_COURSE_LIMITS
    expect(refusedAt({ ...SAMPLE, path: { ...SAMPLE.path, points: [[0, 0, 0]] } })).toEqual([
      'path.points',
    ])
    expect(refusedAt({ ...SAMPLE, path: { ...SAMPLE.path, gap: L.gapMetres.min - 1 } })).toEqual([
      'path.gap',
    ])
    expect(refusedAt({ ...SAMPLE, path: { ...SAMPLE.path, gap: L.gapMetres.max + 1 } })).toEqual([
      'path.gap',
    ])
    expect(refusedAt({ ...SAMPLE, timeLimit: L.timeLimitSeconds.max + 1 })).toEqual(['timeLimit'])
    expect(refusedAt({ ...SAMPLE, finish: { t: 0 } })).toEqual(['finish.t'])
    // DEV-475: the pad — a place and a heading, both bounded, nothing else.
    expect(refusedAt({ ...SAMPLE, start: { ...SAMPLE.start, pos: [0, 0] } })).toEqual(['start.pos'])
    expect(refusedAt({ ...SAMPLE, start: { ...SAMPLE.start, yaw: 181 } })).toEqual(['start.yaw'])
    expect(refusedAt({ ...SAMPLE, start: { t: 0.1 } })).toEqual([
      'start."t"',
      'start.pos',
      'start.yaw',
    ])
    const doubled = [...SAMPLE.path.points]
    doubled.splice(3, 0, [...(SAMPLE.path.points[2] as V)] as V)
    expect(refusedAt({ ...SAMPLE, path: { ...SAMPLE.path, points: doubled } })).toEqual([
      'path.points[3]',
    ])
    expect(refusedAt({ ...SAMPLE, rings: [{ t: 0.5, skip: false }] })).toEqual(['rings[0].skip'])
    expect(
      refusedAt({
        ...SAMPLE,
        rings: [
          { t: 0.5, skip: true },
          { t: 0.5, skip: true },
        ],
      }),
    ).toEqual(['rings'])
  })

  it('against the donor: the island, the vehicle, and the donor itself', () => {
    expect(refusedAt({ ...SAMPLE, island: 'alpine' }, int01)).toEqual(['island'])
    expect(refusedAt(SAMPLE, byId('adv_02_hoverJet'))).toEqual(['sky'])
    // Every JumpSeat mission is a donor of the wrong vehicle for v1.
    for (const l of shipped.filter((s) => s.vehicle === 'jumpseat')) {
      const r = validatePlayerCourse({ ...SAMPLE, sky: l.id, island: l.environment }, l)
      expect(r.ok, l.id).toBe(false)
      if (!r.ok)
        expect(
          r.errors.map(([p]) => p),
          l.id,
        ).toContain('sky')
    }
  })

  it('too many rings, or none, after expansion', () => {
    const tooMany = courseAlong(int01, 12, PLAYER_COURSE_LIMITS.gapMetres.min)
    expect(refusedAt(tooMany, int01)).toEqual(['path.gap'])
    const none = { ...SAMPLE, finish: { t: 0.001 } }
    expect(refusedAt(none, int01)).toEqual(['finish.t'])
  })

  it('an override that names no ring', () => {
    const r = validatePlayerCourse(
      { ...SAMPLE, rings: [{ t: SAMPLE.finish.t, skip: true }] },
      int01,
    )
    expect(r.ok || r.errors.map(([p]) => p)).toEqual(['rings[0].t'])
  })
})

// ── The play area: both kinds of donor ────────────────────────────────────

describe('the play area — a donor with a boundary, and one without', () => {
  // int_01's boundary kills (a 2,918.7 m sphere); adv_01's is disabled, so its
  // area is the desert's terrain. A point both courses can reach: the first
  // point of each course, pushed out sideways until it leaves the sphere.
  const withBoundary = int01
  const without = byId('adv_01_hoverJet')

  it('the two donors are the two kinds', () => {
    expect(withBoundary.boundary.enabled).toBe(true)
    expect(playerCourseArea(withBoundary)?.kind).toBe('sphere')
    expect(without.boundary.enabled).toBe(false)
    expect(playerCourseArea(without)?.kind).toBe('box')
  })

  it('refuses a point outside the sphere where the boundary kills', () => {
    const area = playerCourseArea(withBoundary)
    if (area?.kind !== 'sphere') throw new Error('sphere')
    const out: V = [area.centre[0] + area.radius + 50, area.centre[1], area.centre[2]]
    const pts = [...SAMPLE.path.points]
    pts[pts.length - 1] = out
    const r = validatePlayerCourse(
      { ...SAMPLE, path: { ...SAMPLE.path, points: pts } },
      withBoundary,
    )
    expect(r.ok || r.errors.map(([p]) => p)).toContain(`path.points[${pts.length - 1}]`)
  })

  it('takes a point outside that sphere where the boundary is off, if it is over the island', () => {
    const course = courseAlong(without)
    const sphere = without.boundary.volume
    const box = playerCourseArea(without)
    if (!sphere || box?.kind !== 'box') throw new Error('shapes')
    // A corner of the terrain box, just inside, is outside the disabled
    // sphere: the case where the two rules disagree (the agreement lesson).
    const corner: V = [box.max[0] - 10, (box.min[1] + box.max[1]) / 2, box.max[2] - 10]
    expect(dist(corner, sphere.centre)).toBeGreaterThan(sphere.radius ?? 0)
    const pts = [...course.path.points, corner]
    const r = validatePlayerCourse({ ...course, path: { ...course.path, points: pts } }, without)
    const at = r.ok ? [] : r.errors.map(([p]) => p)
    expect(at).not.toContain(`path.points[${pts.length - 1}]`)
    // And the same corner pushed off the island is refused.
    const off: V = [box.max[0] + 10, corner[1], corner[2]]
    const r2 = validatePlayerCourse(
      { ...course, path: { ...course.path, points: [...course.path.points, off] } },
      without,
    )
    expect(r2.ok || r2.errors.map(([p]) => p)).toContain(`path.points[${pts.length - 1}]`)
  })

  it('refuses a curve that swings out between points that are all inside', () => {
    const area = playerCourseArea(withBoundary)
    if (area?.kind !== 'sphere') throw new Error('sphere')
    const [cx, cy, cz] = area.centre
    const R = area.radius
    // A hairpin whose apex is just inside the sphere: the curve passes the
    // apex still heading OUT (its tangent there is along the chord from the
    // point before to the point after), so it leaves before it turns back.
    const pts: V[] = [
      [cx - 0.5 * R, cy, cz],
      [cx + 0.99 * R, cy, cz],
      [cx + 0.5 * R, cy, cz + 0.3 * R],
    ]
    for (const p of pts) expect(dist(p, area.centre)).toBeLessThan(R)
    const r = validatePlayerCourse(
      {
        ...SAMPLE,
        path: { points: pts, gap: 400 },
        start: { pos: pts[0] as V, yaw: 0 },
        finish: { t: 1 },
      },
      withBoundary,
    )
    expect(r.ok || r.errors.map(([p]) => p)).toEqual(['path'])
  })
})

// ── 5. Every donor expands, and the result is a level ────────────────────

describe('every HoverJet donor, on all four islands, expands to a valid level', () => {
  for (const donor of hoverjets) {
    it(`${donor.id} (${donor.environment})`, () => {
      const course = courseAlong(donor)
      const checked = validatePlayerCourse(course, donor)
      expect(checked.ok || checked.errors).toBe(true)
      const level = expandPlayerCourse(course, donor)
      expect(() => validateModeContent(validateLevel(level))).not.toThrow()
      const errs: string[] = []
      validateAgainstSchema(levelSchema, level, level.id, errs)
      expect(errs, errs.join('\n')).toEqual([])

      // What the brief says a player course is.
      // Not listed: absent means no (`Level.listed`), and the schema has no key.
      expect(level.listed).toBeUndefined()
      expect(level.mode).toBe('ringAttack')
      expect(level.forcedMode).toBeNull()
      expect(level.forcedModeFf2).toBeNull()
      // DEV-475: the lift with no ride, over the pad; no shaft.
      expect(level.spawn.launchKind).toBe('elevator')
      expect(level.spawn.launch?.rise).toBe(0)
      expect(level.spawn.launch?.shaft).toBeNull()
      expect(level.spawn.launch?.platform).toEqual(donor.spawn.launch?.platform)
      expect(level.props).toEqual([])
      expect(level.pads).toEqual([])
      expect(level.orbs).toEqual([])
      expect(level.ghosts).toEqual([])
      expect(level.turnIndicators).toEqual([])
      expect(level.ambientTraffic).toBeNull()
      expect(level.generated?.generator).toBe(PLAYER_COURSE_GENERATOR)
      // Environment facts are the donor's, not retyped.
      for (const key of [
        'fog',
        'lighting',
        'boundary',
        'scoring',
        'ui',
        'clouds',
        'worldOffset',
      ] as const) {
        expect(level[key], key).toEqual(donor[key])
      }
      // The ring is the donor's template: same shape, same scoring.
      const template = liveRings(donor)[0] as Ring
      for (const r of liveRings(level)) {
        expect(r.scale).toEqual(template.scale)
        expect(r.scoring).toEqual(template.scoring)
        expect(r.trigger.radius).toBe(template.trigger.radius)
        expect(dist(r.trigger.pos, r.pos)).toBeCloseTo(dist(template.trigger.pos, template.pos), 6)
      }
      // Platinum is every ring.
      expect(level.medalsFf2?.platinum).toBe(maxRingScore(level))
      // Pure: the same course and donor give the same level, byte for byte.
      expect(JSON.stringify(expandPlayerCourse(course, donor))).toBe(JSON.stringify(level))
    })
  }
})

// ── 6. The geometry, not the rotation ─────────────────────────────────────

describe('the rings, measured along the path', () => {
  for (const donor of hoverjets) {
    it(`${donor.id}: each ring faces along the path, and they are gap apart`, () => {
      const course = courseAlong(donor, 9, 180)
      const level = expandPlayerCourse(course, donor)
      const parsed = validatePlayerCourse(course, donor)
      if (!parsed.ok) throw new Error('course')
      const spline = playerCourseSpline(parsed.course)
      const rings = liveRings(level)
      expect(rings.length).toBeGreaterThan(10)
      const arcs = rings.map((r) => nearestArc(spline, vv(r.pos)))
      rings.forEach((r, i) => {
        // DIRECTION: a metre along the facing normal is further along the path.
        const f = minusZ(r.quat)
        const ahead = v3(r.pos[0] + f.x, r.pos[1] + f.y, r.pos[2] + f.z)
        expect(nearestArc(spline, ahead), `ring ${i}`).toBeGreaterThan(arcs[i] as number)
        // The trigger, which is what scores, faces the same way the ring does.
        const trig = rotateVec3(v3(), qv(r.trigger.quat), v3(0, 0, 1))
        expect(dot(trig, f), `ring ${i} trigger`).toBeGreaterThan(0.999)
      })
      // SPACING: successive centres are `gap` apart by arc length.
      for (let i = 1; i < arcs.length; i++) {
        expect((arcs[i] as number) - (arcs[i - 1] as number), `gap ${i}`).toBeCloseTo(
          course.path.gap,
          0,
        )
      }
      // The first ring is one gap past the line's first point (DEV-475), and
      // the last clears the finish sphere with its whole trigger.
      expect(arcs[0] as number).toBeCloseTo(course.path.gap, 0)
      const fin = level.finish as NonNullable<Level['finish']>
      const last = rings[rings.length - 1] as Ring
      expect(dist(last.trigger.pos, fin.pos)).toBeGreaterThan(last.trigger.radius + fin.radius)
    })
  }

  it('the finish stands at finish.t, facing along the path, the donor’s gate moved rigidly', () => {
    const donor = int01
    const level = expandPlayerCourse(SAMPLE, donor)
    const parsed = validatePlayerCourse(SAMPLE, donor)
    if (!parsed.ok) throw new Error('course')
    const spline = playerCourseSpline(parsed.course)
    const f = level.finish
    const d = donor.finish
    if (f?.shape !== 'sphereUnion' || d?.shape !== 'sphereUnion' || !f.art || !d.art)
      throw new Error('finish')
    expect(nearestArc(spline, vv(f.pos)) / spline.length).toBeCloseTo(parsed.course.finish.t, 3)
    const facing = minusZ(f.art.frame.quat)
    const s = parsed.course.finish.t * spline.length
    expect(dot(facing, splineTangentAt(spline, s))).toBeGreaterThan(0.999)
    const ahead = v3(f.pos[0] + facing.x, f.pos[1] + facing.y, f.pos[2] + facing.z)
    expect(nearestArc(spline, ahead)).toBeGreaterThan(nearestArc(spline, vv(f.pos)))
    // Rigid: every distance inside the gate is the donor's.
    expect(f.art.studs.length).toBe(d.art.studs.length)
    expect(dist(f.art.frame.pos, f.pos)).toBeCloseTo(dist(d.art.frame.pos, d.pos), 6)
    f.art.studs.forEach((stud, i) => {
      const was = d.art?.studs[i]
      expect(dist(stud.pos, f.pos)).toBeCloseTo(dist(was?.pos ?? [], d.pos), 6)
      expect(dist(stud.pos, f.art?.frame.pos ?? [])).toBeCloseTo(
        dist(was?.pos ?? [], d.art?.frame.pos ?? []),
        6,
      )
    })
    expect(f.radius).toBe(d.radius)
    expect(f.spheres).toEqual(d.spheres)
  })

  it('the ship starts over its pad, nosed as the pad is aimed, and the route starts under it', () => {
    // DEV-475: a pad off the line, aimed somewhere the line does not go.
    const foot: V = [SAMPLE.start.pos[0] + 40, SAMPLE.start.pos[1] - 20, SAMPLE.start.pos[2] - 30]
    const course: PlayerCourse = { ...SAMPLE, start: { pos: foot, yaw: 37.5 } }
    const level = expandPlayerCourse(course, int01)
    const platform = int01.spawn.launch?.platform
    if (!platform) throw new Error('int01 has a lift')
    const standUp = (platform.shipOffset[1] as number) - (platform.offset[1] as number)
    // WHERE: straight over the pad's foot, by the lift's own stand-up.
    expect(level.spawn.pos[0]).toBeCloseTo(foot[0], 9)
    expect(level.spawn.pos[2]).toBeCloseTo(foot[2], 9)
    expect(level.spawn.pos[1] - foot[1]).toBeCloseTo(standUp, 9)
    // The pad the game stands there is the player's, its foot on the pad's.
    const grid = (level.spawn as unknown as { startGrid: { pads: { role: string; pos: V }[] } })
      .startGrid
    expect(grid.pads[0]?.role).toBe('player')
    expect(grid.pads[0]?.pos).toEqual(foot)
    // WHICH WAY: a point ahead of the nose is further along the heading the
    // pad was given — the heading measured as a direction on the ground,
    // (−sin yaw, −cos yaw), not as the quaternion it was written with.
    const nose = rotateVec3(v3(), qv(level.spawn.quat), v3(0, 0, -1))
    const r = (37.5 * Math.PI) / 180
    expect(nose.x * -Math.sin(r) + nose.z * -Math.cos(r)).toBeGreaterThan(0.9999)
    const { launchKind, launch, ...pose } = level.spawn as SpawnPoint & { startGrid?: unknown }
    void launch
    expect(launchKind).toBe('elevator')
    expect(level.respawn).toEqual({ pos: pose.pos, quat: pose.quat, yaw: pose.yaw })
    // The route: from the ship on its pad to the line's first point, then
    // along the line to its end, never further apart than its spacing.
    const route = level.route as V[]
    expect(dist(route[0] as V, level.spawn.pos)).toBeLessThan(1e-9)
    expect(dist(route[1] as V, SAMPLE.path.points[0] as V)).toBeLessThan(0.01)
    expect(
      dist(route[route.length - 1] as V, SAMPLE.path.points[SAMPLE.path.points.length - 1] as V),
    ).toBeLessThan(0.01)
    for (let i = 2; i < route.length; i++) {
      expect(dist(route[i] as V, route[i - 1] as V)).toBeLessThanOrEqual(
        PLAYER_COURSE_SHAPE.routeSpacingMetres + 1e-6,
      )
    }
  })

  it('the sky’s two ai pads stand beside the pad as they stood beside 2016’s: moved rigidly', () => {
    for (const donor of hoverjets) {
      const course = courseAlong(donor)
      const level = expandPlayerCourse(course, donor)
      type Pad = { role: string; pos: V; size: V }
      const pads = (level.spawn as unknown as { startGrid: { pads: Pad[] } }).startGrid.pads
      const skyPads = (
        (donor.spawn as unknown as { startGrid?: { pads?: Pad[] } }).startGrid?.pads ?? []
      ).filter((p) => p.role === 'ai')
      const ours = pads.filter((p) => p.role === 'ai')
      expect(ours.length, donor.id).toBe(skyPads.length)
      // Distances from the ship and between the pads are 2016's: a rigid motion.
      const skyRelease: V = [
        donor.spawn.pos[0] as number,
        (donor.spawn.pos[1] as number) + (donor.spawn.launch?.rise ?? 0),
        donor.spawn.pos[2] as number,
      ]
      ours.forEach((p, i) => {
        const was = skyPads[i] as Pad
        expect(dist(p.pos, level.spawn.pos), `${donor.id} pad ${i}`).toBeCloseTo(
          dist(was.pos, skyRelease),
          6,
        )
        expect(p.size).toEqual(was.size)
      })
      if (ours.length === 2) {
        expect(dist((ours[0] as Pad).pos, (ours[1] as Pad).pos)).toBeCloseTo(
          dist((skyPads[0] as Pad).pos, (skyPads[1] as Pad).pos),
          6,
        )
      }
    }
  })

  it('a skip override leaves exactly that ring out', () => {
    const full = expandPlayerCourse(SAMPLE, int01)
    const parsed = validatePlayerCourse(SAMPLE, int01)
    if (!parsed.ok) throw new Error('course')
    const spline = playerCourseSpline(parsed.course)
    const victim = liveRings(full)[3] as Ring
    const t = nearestArc(spline, vv(victim.pos)) / spline.length
    const skipped = expandPlayerCourse({ ...SAMPLE, rings: [{ t, skip: true }] }, int01)
    const before = liveRings(full).map((r) => r.pos)
    const after = liveRings(skipped).map((r) => r.pos)
    expect(after.length).toBe(before.length - 1)
    expect(after).toEqual(before.filter((_, i) => i !== 3))
    expect(liveRings(skipped).map((r) => r.i)).toEqual(after.map((_, i) => i))
    expect(skipped.medalsFf2?.platinum).toBe(maxRingScore(skipped))
  })
})

// ── 7. The outside oracle: 2016's own course, and 2016's own flights ─────

describe('the oracle: int_01’s route, expanded, is int_01 — and 2016’s ghosts agree', () => {
  // Fit: every tenth point of 2016's `CurvyClonePath`, plus one point back
  // along its first direction, one gap before ring 0 (a player course's rings
  // begin one gap past its first point; 2016's route begins AT ring 0, with
  // the ship in an elevator elsewhere).
  const route = int01.route as V[]
  const points: V[] = []
  for (let i = 0; i < route.length; i += 10) points.push(route[i] as V)
  if (points[points.length - 1] !== route[route.length - 1])
    points.push(route[route.length - 1] as V)
  const a = route[0] as V
  const b = route[1] as V
  const ab = dist(a, b)
  const backBy = (m: number): V => [
    a[0] - ((b[0] - a[0]) / ab) * m,
    a[1] - ((b[1] - a[1]) / ab) * m,
    a[2] - ((b[2] - a[2]) / ab) * m,
  ]
  const rings2016 = liveRings(int01)
  // DEV-475: v2's rings begin one gap past the line's FIRST POINT (v1's began
  // one gap past a start parameter), so the back point is walked in until
  // ring 0 lies one measured gap along the curve from it. Three rounds settle
  // it to well under a metre; the end segment is nearly straight.
  let backMetres = 600
  let fit = { spline: playerCourseSpline(SAMPLE), gap: 0, arcs: [] as number[] }
  for (let round = 0; round < 4; round++) {
    const trial: PlayerCourse = {
      ...SAMPLE,
      path: { points: [backBy(backMetres), ...points], gap: 500 },
    }
    const parsedTrial = validatePlayerCourse(trial, int01)
    if (!parsedTrial.ok) throw new Error(JSON.stringify(parsedTrial.errors))
    const s = playerCourseSpline(parsedTrial.course)
    const arcs = rings2016.map((r) => nearestArc(s, vv(r.pos)))
    // 2016's own spacing, MEASURED along the fitted curve: `SplinePathCloneBuilder`
    // cloned a ring every `Gap` metres, so the mean arc between rings is that Gap.
    const g = Math.round(
      arcs.slice(1).reduce((sum, x, i) => sum + (x - (arcs[i] as number)), 0) / (arcs.length - 1),
    )
    fit = { spline: s, gap: g, arcs }
    backMetres -= (arcs[0] as number) - g
  }
  const spline = fit.spline
  const L = spline.length
  const gap = fit.gap
  const fin = int01.finish as NonNullable<Level['finish']>
  const course: PlayerCourse = {
    ...SAMPLE,
    path: { points: [backBy(backMetres), ...points], gap },
    finish: { t: nearestArc(spline, vv(fin.pos)) / L },
  }
  const level = expandPlayerCourse(course, int01)

  const ghostCourseOf = (l: Level): GhostCourse => {
    const f = l.finish as NonNullable<Level['finish']>
    return {
      gates: courseGates(l),
      finish: { x: f.pos[0], y: f.pos[1], z: -f.pos[2], radius: f.radius },
      worldOffset: [l.worldOffset[0], l.worldOffset[1], l.worldOffset[2]],
      startTime: int01.ghosts[0]?.startTime ?? 0,
    }
  }
  const clips = {
    fast: decodeGhostClip(fastDoc as unknown as GhostDoc),
    slow: decodeGhostClip(slowDoc as unknown as GhostDoc),
  }

  it('measures 2016’s gap as a whole ring spacing, and lays the same number of rings', () => {
    expect(gap).toBeGreaterThan(PLAYER_COURSE_LIMITS.gapMetres.min)
    expect(gap).toBeLessThan(PLAYER_COURSE_LIMITS.gapMetres.max)
    expect(liveRings(level).length).toBe(rings2016.length)
  })

  it('puts every ring’s trigger within 10 m of 2016’s', () => {
    liveRings(level).forEach((r, i) => {
      expect(dist(r.trigger.pos, (rings2016[i] as Ring).trigger.pos), `ring ${i}`).toBeLessThan(10)
    })
  })

  it('the slow 2016 ghost, which takes every ring of 2016’s course, takes every ring of this one', () => {
    const ours = scoreGhost(clips.slow, ghostCourseOf(level))
    const theirs = scoreGhost(clips.slow, ghostCourseOf(int01))
    expect(theirs.gates).toBe(theirs.gatesTotal)
    expect(ours.gates).toBe(ours.gatesTotal)
    expect(ours.seconds).not.toBeNull()
    expect(ours.seconds as number).toBeCloseTo(theirs.seconds as number, 0)
  })

  it('the fast ghost misses exactly the rings it misses on 2016’s course, and finishes', () => {
    // It clips the edges of three 2016 rings (ghost-result.test.ts): a course
    // that reproduced 2016's would make it miss the same three, no more.
    const missed = (l: Level): number[] =>
      (scoreGhost(clips.fast, ghostCourseOf(l), undefined, { ringTimes: true }).ringTimes ?? [])
        .map((t, i) => (t === null ? i : -1))
        .filter((i) => i >= 0)
    expect(missed(level)).toEqual(missed(int01))
    const ours = scoreGhost(clips.fast, ghostCourseOf(level))
    const theirs = scoreGhost(clips.fast, ghostCourseOf(int01))
    expect(ours.seconds as number).toBeCloseTo(theirs.seconds as number, 0)
  })
})

// ── The door, and what it may import ──────────────────────────────────────

describe('loadPlayerCourse', () => {
  it('turns a course into a validated level', async () => {
    const level = await loadPlayerCourse(JSON.parse(canonicalPlayerCourse(SAMPLE)))
    expect(level.id).toBe(playerCourseId(SAMPLE))
    expect(liveRings(level).length).toBeGreaterThan(0)
  })

  it('refuses garbage, an unknown sky and an authored one, with PlayerCourseError', async () => {
    await expect(loadPlayerCourse('not a course')).rejects.toBeInstanceOf(PlayerCourseError)
    await expect(loadPlayerCourse({ ...SAMPLE, sky: 'no_such_mission' })).rejects.toBeInstanceOf(
      PlayerCourseError,
    )
    // A lesson is a hand-authored HoverJet course, not a sky.
    await expect(
      loadPlayerCourse({ ...SAMPLE, sky: 'lesson_01_canyon', island: 'desert' }),
    ).rejects.toBeInstanceOf(PlayerCourseError)
  })

  it('keeps the format importable from a Playwright spec: no Vite-only global reachable', () => {
    // DEV-467's e2e builds a course in code. `load-level.ts` uses a Vite-only
    // global (`tests/unit/e2e-import-graph.test.ts`), so the format must not
    // reach it; the loader, which does, lives in its own file.
    const viteOnly = /import\.meta\.(glob|env)/
    for (const node of walkImports(path.join(REPO, 'src', 'content', 'player-course.ts'))) {
      const code = fs
        .readFileSync(node.file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*)/.test(line))
        .join('\n')
      expect(viteOnly.test(code), rel(node.file)).toBe(false)
    }
  })
})
