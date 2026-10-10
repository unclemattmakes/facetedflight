// tests/unit/player-course-pad.test.ts — DEV-475: the start pad, and v2.
//
// docs/plan/EDITOR-PLAYTEST-2026-09-27.md, DEV-475. What is held here:
//
//  1. v1 → v2 against REAL v1 bytes: `fixtures/player-course-v1.json` was
//     written by the pre-v2 build's own code (44f13f23), once — its links, its
//     files, its drafts and what it expanded them to. Each is read by this
//     build, migrated, and round-tripped; the library keeps it under its new
//     id. The comparison is with what v1 DID, not with v1 as v2 imagines it.
//  2. The pad's launch: the shipped start with the ride taken out, stepped
//     through `sim/launch.ts` — held, 3-2-1, GO — and it never rises.
//  3. The warnings the core says about the pad and the racers' pads.
//  4. The racers beside it (`desk/slots.ts`): the game's `racerStarts`, laid
//     over the expanded spawn, measured as GEOMETRY in the pad's frame.
//  5. The prop clearing round a player course's pad, and that no shipped
//     mission's changes.
//  6. The premise `boot/app.ts`'s DEV-475 deck rule rests on.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { nearestArc, splinePointAt } from '@/content/course-spline'
import type { EditionRacers } from '@/content/edition-schema'
import { type Level, liveRings } from '@/content/level-schema'
import {
  canonicalPlayerCourse,
  expandPlayerCourse,
  legacyPlayerCourseId,
  PLAYER_COURSE_VERSION,
  type PlayerCourse,
  playerCourseId,
  playerCourseSpawn,
  playerCourseSpline,
  startStandUp,
  validatePlayerCourse,
  yawForward,
} from '@/content/player-course'
import {
  courseFile,
  courseToken,
  readCourseFile,
  readCourseToken,
} from '@/content/player-course-wire'
import {
  defaultStart,
  draftFromCourse,
  evaluateDraft,
  type Ground,
  groundClearance,
  loadDraft,
  newDraft,
  seatPadAt,
} from '@/editor/core'
import { courseSlots, gridReach, PAD_SPOT_POLICY, padSpot } from '@/editor/desk/slots'
import { createCourseLibrary, memoryBackend } from '@/game/course-library'
import { startPadClearings } from '@/game/props/no-prop-volumes'
import { fromBase64url } from '@/net/base64url'
import { FIXED_DT } from '@/sim/constants'
import { createLaunch, launchHoldsShip, startLaunch, stepLaunch } from '@/sim/launch'
import { quat, rotateVec3 } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'
import anniversary from '../../content/editions/anniversary.json'
import fixture from './fixtures/player-course-v1.json'
import { shippedLevels } from './helpers/content'

type V = [number, number, number]

const shipped: Level[] = shippedLevels()
const hoverjets = shipped.filter((l) => l.vehicle === 'hoverjet')
const int01 = shipped.find((l) => l.id === 'int_01_hoverJet') as Level
const ANNIV = (anniversary as unknown as { gameplay: { racers: EditionRacers } }).gameplay.racers

const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(
    (a[0] as number) - (b[0] as number),
    (a[1] as number) - (b[1] as number),
    (a[2] as number) - (b[2] as number),
  )
const vv = (p: readonly number[]) => v3(p[0] as number, p[1] as number, p[2] as number)
/** The nose of a spawn: local −z turned by its quaternion. */
const noseOf = (q: readonly number[]) =>
  rotateVec3(
    v3(),
    quat(q[0] as number, q[1] as number, q[2] as number, q[3] as number),
    v3(0, 0, -1),
  )

interface FixtureCourse {
  readonly label: string
  readonly course: Record<string, unknown> & { start: { t: number }; path: { gap: number } }
  readonly id: string
  readonly token: string
  readonly file: string
  readonly draft: unknown
  readonly expanded: { spawn: V; rings: V[]; finish: V | null }
}
const V1 = (fixture as unknown as { courses: FixtureCourse[] }).courses

// ── 1. v1, as the v1 build wrote it ───────────────────────────────────────

describe('DEV-475: a v1 course from the build that made it still reads — migrated, round-tripped', () => {
  it('the fixture is two v1 courses: one from the first point, one moved along its line', () => {
    expect(V1.map((c) => c.course.v)).toEqual([1, 1])
    expect(V1.map((c) => c.course.start.t)).toEqual([0, 0.3])
  })

  for (const f of V1) {
    it(`${f.label}: link, file and draft all read as the same v2 course`, async () => {
      const fromLink = await readCourseToken(f.token)
      if (!fromLink.ok) throw new Error(JSON.stringify(fromLink.errors))
      const c = fromLink.course
      expect(c.v).toBe(PLAYER_COURSE_VERSION)
      const bytes = fromBase64url(f.file)
      if (!bytes) throw new Error('fixture file')
      const fromFile = await readCourseFile(bytes)
      if (!fromFile.ok) throw new Error(JSON.stringify(fromFile.errors))
      expect(canonicalPlayerCourse(fromFile.course)).toBe(canonicalPlayerCourse(c))
      // The draft the v1 editor stored reads as the same course too.
      const store = new Map([['ff2.editor.draft.v1.fixture', JSON.stringify(f.draft)]])
      const loaded = loadDraft(
        {
          getItem: (k) => store.get(k) ?? null,
          setItem: () => undefined,
          removeItem: () => undefined,
        },
        'fixture',
      )
      expect(loaded && canonicalPlayerCourse(loaded.course)).toBe(canonicalPlayerCourse(c))
      // And it validates against its sky.
      expect(validatePlayerCourse(c, int01).ok).toBe(true)
    })

    it(`${f.label}: a new id, and the old one is known`, async () => {
      const read = await readCourseToken(f.token)
      if (!read.ok) throw new Error('read')
      expect(playerCourseId(read.course)).not.toBe(f.id)
      expect(legacyPlayerCourseId(f.course)).toBe(f.id)
      // A v2 course has no v1 id.
      expect(legacyPlayerCourseId(JSON.parse(canonicalPlayerCourse(read.course)))).toBeNull()
    })

    it(`${f.label}: round-trips — link and file — to the same bytes and id`, async () => {
      const read = await readCourseToken(f.token)
      if (!read.ok) throw new Error('read')
      const again = await readCourseToken(await courseToken(read.course))
      if (!again.ok) throw new Error('again')
      expect(canonicalPlayerCourse(again.course)).toBe(canonicalPlayerCourse(read.course))
      expect(playerCourseId(again.course)).toBe(playerCourseId(read.course))
      const file = await readCourseFile(await courseFile(read.course))
      if (!file.ok) throw new Error('file')
      expect(playerCourseId(file.course)).toBe(playerCourseId(read.course))
    })

    it(`${f.label}: the pad stands at the old start, headed along the line, the ship a lift's stand-up over it`, async () => {
      const read = await readCourseToken(f.token)
      if (!read.ok) throw new Error('read')
      const c = read.course
      const spline = playerCourseSpline(c)
      const sOld = f.course.start.t * spline.length
      const at = splinePointAt(spline, sOld)
      expect(dist(c.start.pos, [at.x, at.y, at.z])).toBeLessThan(0.1)
      // WHICH WAY, as geometry: 50 m along the heading is further along the line.
      const fwd = yawForward(c.start.yaw)
      const ahead = v3(at.x + fwd.x * 50, at.y, at.z + fwd.z * 50)
      expect(nearestArc(spline, ahead)).toBeGreaterThan(sOld + 25)
      // The ship over the old start: where v1 flew from, up by the lift's stand-up.
      const level = expandPlayerCourse(c, int01)
      const v1Spawn = f.expanded.spawn
      expect(
        Math.hypot(level.spawn.pos[0] - v1Spawn[0], level.spawn.pos[2] - v1Spawn[2]),
      ).toBeLessThan(0.1)
      expect(level.spawn.pos[1] - v1Spawn[1]).toBeCloseTo(startStandUp(int01) as number, 1)
    })
  }

  it('from the first point: every ring and the finish exactly where v1 put them', async () => {
    const f = V1[0] as FixtureCourse
    const read = await readCourseToken(f.token)
    if (!read.ok) throw new Error('read')
    const level = expandPlayerCourse(read.course, int01)
    const rings = liveRings(level).map((r) => r.pos)
    expect(rings.length).toBe(f.expanded.rings.length)
    rings.forEach((p, i) => {
      expect(dist(p, f.expanded.rings[i] as V), `ring ${i}`).toBeLessThan(1e-6)
    })
    expect(dist(level.finish?.pos ?? [], f.expanded.finish ?? [])).toBeLessThan(1e-6)
  })

  it('moved along its line: no ring behind the pad, and the rest within a gap of v1’s', async () => {
    const f = V1[1] as FixtureCourse
    const read = await readCourseToken(f.token)
    if (!read.ok) throw new Error('read')
    const spline = playerCourseSpline(read.course)
    const sOld = f.course.start.t * spline.length
    const gap = f.course.path.gap
    const rings = liveRings(expandPlayerCourse(read.course, int01)).map((r) => r.pos)
    for (const p of rings) expect(nearestArc(spline, vv(p))).toBeGreaterThan(sOld)
    expect(Math.abs(rings.length - f.expanded.rings.length)).toBeLessThanOrEqual(1)
    for (const p of rings) {
      const nearest = Math.min(...f.expanded.rings.map((q) => dist(p, q)))
      expect(nearest).toBeLessThan(gap)
    }
  })

  it('the library keeps a v1 entry: read under its new id, rewritten there, date and source kept', async () => {
    const backend = memoryBackend()
    const f = V1[1] as FixtureCourse
    await backend.save({
      id: f.id,
      course: f.course as unknown as PlayerCourse,
      name: 'Amber Kestrel',
      island: 'simonet',
      date: 1234,
      source: 'link',
    })
    const library = createCourseLibrary(backend, () => 9999)
    const list = await library.list()
    expect(list).toHaveLength(1)
    const e = list[0]
    const read = await readCourseToken(f.token)
    if (!e || !read.ok) throw new Error('entry')
    expect(e.id).toBe(playerCourseId(read.course))
    expect(e.course.v).toBe(PLAYER_COURSE_VERSION)
    expect(e.date).toBe(1234)
    expect(e.source).toBe('link')
    // Rewritten under the new key; the old key gone; a second list is the same.
    expect(await backend.one(f.id)).toBeNull()
    expect(await library.get(e.id)).not.toBeNull()
    expect((await library.list()).map((x) => x.id)).toEqual([e.id])
    // A row whose id is NOT its course's v1 id is still refused.
    await backend.save({ ...(e as object), id: 'pc_000000000000', course: f.course } as never)
    expect((await library.list()).map((x) => x.id)).toEqual([e.id])
  })
})

// ── 2. The launch: the shipped start, the ride taken out ──────────────────

describe('DEV-475: the pad launches as the shipped start does, with no ride', () => {
  const read = (): PlayerCourse => {
    const r = validatePlayerCourse(JSON.parse(canonicalPlayerCourse(newCourse())), int01)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    return r.course
  }
  const newCourse = (): PlayerCourse => {
    const route = int01.route as V[]
    return {
      ...newDraft(int01, ['Amber', 'Heron']).course,
      path: { points: [0, 40, 80, 120].map((i) => route[i] as V), gap: 400 },
    }
  }

  it('held on the pad, 3-2-1 from the press, let go on GO, and never rising an inch', () => {
    const level = expandPlayerCourse(read(), int01)
    const launch = level.spawn.launch
    if (!launch) throw new Error('a pad start has a launch')
    const countdown = level.timer.countdown
    expect(countdown).toEqual(int01.timer.countdown)
    const spec = {
      keys: launch.keys,
      releaseAtSeconds: launch.releaseAtSeconds,
      countdownSteps: countdown?.steps ?? 0,
      countdownStepSeconds: countdown?.stepSeconds ?? 0,
      // The default: the game rides the lift on a world's first launch.
      skipRide: false,
    }
    const state = createLaunch(spec)
    expect(state.phase).toBe('waiting')
    expect(launchHoldsShip(state)).toBe(true)
    startLaunch(state, spec)
    let t = 0
    let released = -1
    for (let i = 0; i < 2000 && released < 0; i++) {
      if (stepLaunch(state, spec, FIXED_DT)) released = t
      t += FIXED_DT
      expect(state.rise).toBe(0)
    }
    expect(state.phase).toBe('flying')
    // GO is the countdown's own length after the press: no ride before it.
    const beats = ((countdown?.steps ?? 0) + 1) * (countdown?.stepSeconds ?? 0)
    expect(released).toBeGreaterThan(beats - 2 * FIXED_DT)
    expect(released).toBeLessThan(beats + 2 * FIXED_DT)
  })

  it('no shaft: the game builds no lift where none rides (`boot/app.ts` gates the elevator on it)', () => {
    const level = expandPlayerCourse(read(), int01)
    expect(level.spawn.launch?.shaft).toBeNull()
    expect(level.spawn.launch?.rise).toBe(0)
  })
})

// ── 3. The warnings about the pad and the racers' pads ────────────────────

describe('DEV-475: what the editor says about where the pad stands', () => {
  const size = int01.spawn.launch?.platform?.size as number[]
  const rim = size[1] as number
  const course = (): PlayerCourse => {
    const route = int01.route as V[]
    return {
      ...newDraft(int01, ['Amber', 'Heron']).course,
      path: { points: [0, 40, 80, 120].map((i) => route[i] as V), gap: 400 },
      start: { pos: [-860, 150, 2080], yaw: 0 },
    }
  }
  const kinds = (ground: Ground, slots: { foot: V; size: number[] }[] = []) =>
    evaluateDraft(draftFromCourse(course()), int01, ground, slots)
      .warnings.filter((w) => w.kind.startsWith('pad-') || w.kind.startsWith('slot-'))
      .map((w) => [w.kind, w.severity])
  const plane = (h: number, slope = 0): Ground => ({ surfaceAt: (x) => h + slope * (x + 860) })

  it('says nothing of a pad seated on flat ground', () => {
    expect(kinds(plane(150))).toEqual([])
  })

  it('refuses a pad whose rim is under the ground, and warns of one floating or on a slope', () => {
    expect(kinds(plane(150 + rim + 0.5))).toEqual([['pad-in-ground', 'error']])
    expect(kinds(plane(150 - groundClearance() - 1))).toEqual([['pad-slope', 'warning']])
    // A slope: the high side at the foot, the low side past the clearance.
    const drop = (groundClearance() + 1) / (size[0] as number)
    expect(kinds(plane(150 - (groundClearance() + 1) / 2, drop))).toEqual([
      ['pad-slope', 'warning'],
    ])
  })

  it('warns of a pad on the water', () => {
    expect(kinds({ surfaceAt: () => 150, waterAt: () => true })).toEqual([
      ['pad-in-water', 'warning'],
    ])
  })

  it('refuses a racer’s pad in the ground, and warns of one over the water — by its own index', () => {
    const slots = [
      { foot: [-860, 150, 2060] as V, size },
      { foot: [-900, 150, 2080] as V, size },
    ]
    // The ground rises over the second pad's rim, and only there.
    const hill: Ground = { surfaceAt: (x) => (x < -880 ? 150 + rim + 2 : 150) }
    const w = evaluateDraft(draftFromCourse(course()), int01, hill, slots).warnings.filter((x) =>
      x.kind.startsWith('slot-'),
    )
    expect(w.map((x) => [x.kind, x.severity, x.slot])).toEqual([['slot-in-ground', 'error', 1]])
    const sea: Ground = { surfaceAt: () => 150, waterAt: (x) => x > -870 }
    const s = evaluateDraft(draftFromCourse(course()), int01, sea, slots).warnings.filter((x) =>
      x.kind.startsWith('slot-'),
    )
    expect(s.map((x) => [x.kind, x.slot])).toEqual([['slot-in-water', 0]])
  })

  it('refuses a pad outside the play area, once, with its place', () => {
    const far = { ...course(), start: { pos: [99_000, 150, 0] as V, yaw: 0 } }
    const e = evaluateDraft(draftFromCourse(far), int01, plane(150))
    expect(e.warnings.filter((w) => w.kind === 'pad-outside')).toHaveLength(1)
    expect(e.warnings.some((w) => w.path === 'start.pos')).toBe(false)
    expect(e.level).toBeNull()
  })

  it('seats a pad on the HIGHEST ground under its footprint, so neither dish nor ship is in the hill', () => {
    const slope = 0.2
    const y = seatPadAt(plane(100, slope), -860, 2080, size)
    // The footprint's high side is half its width up the slope.
    expect(y).toBeCloseTo(100 + slope * (Math.max(size[0] as number, size[2] as number) / 2), 6)
    expect(seatPadAt({ surfaceAt: () => Number.NEGATIVE_INFINITY }, 0, 0, size)).toBeNull()
  })
})

// ── 4. The racers beside it ───────────────────────────────────────────────

describe('DEV-475: the racers stand beside the pad, on the game’s own grid, turned with it', () => {
  for (const donor of hoverjets) {
    it(`${donor.id}: 2016's pads beside, the preset's slots ahead, in the pad's frame`, () => {
      const start = { pos: [100, 200, 300] as V, yaw: 63.2 }
      const slots = courseSlots(start, donor, ANNIV)
      const spawn = playerCourseSpawn(start, donor)
      if (!spawn) throw new Error('spawn')
      const skyAi = (
        (donor.spawn as unknown as { startGrid?: { pads?: { role: string }[] } }).startGrid?.pads ??
        []
      ).filter((p) => p.role === 'ai').length
      // 2016's ai pads (none on the rookie courses), then the preset's three.
      expect(slots.length, donor.id).toBe(skyAi + ANNIV.slots.length)
      // Each preset slot, measured in the pad's frame, is the preset's metres:
      // ahead along the heading, and to the right.
      const fwd = yawForward(start.yaw)
      const right = v3(-fwd.z, 0, fwd.x)
      const presetSlots = slots.filter((s) => s.start.from.kind === 'slot')
      presetSlots.forEach((s, i) => {
        const dx = s.start.pos[0] - spawn.pos[0]
        const dz = s.start.pos[2] - spawn.pos[2]
        const want = ANNIV.slots[i] as { ahead: number; right: number }
        expect(dx * fwd.x + dz * fwd.z).toBeCloseTo(want.ahead, 6)
        expect(dx * right.x + dz * right.z).toBeCloseTo(want.right, 6)
        // Held at the release: the ship's height, on a copy of the player's pad.
        expect(s.start.pos[1]).toBeCloseTo(spawn.pos[1], 9)
        expect(s.foot[1]).toBe(start.pos[1])
      })
      // Every racer faces the way the player does.
      for (const s of slots) {
        const n = noseOf(s.start.quat)
        expect(n.x * fwd.x + n.z * fwd.z).toBeGreaterThan(0.9999)
      }
    })
  }
})

describe('DEV-475: a new draft’s pad is looked for on dry, flat ground', () => {
  it('pins the search by value', () => {
    expect(PAD_SPOT_POLICY).toEqual({ stepMetres: 8, reachMetres: 2000, marginMetres: 16 })
  })

  it('walks off the water to the nearest place the whole grid stands dry and flat', () => {
    // The sea west of x = 50, a flat shelf at 130 m east of it.
    const shore: Ground = {
      surfaceAt: (x) => (x < 50 ? 116 : 130),
      waterAt: (x) => x < 50,
    }
    const start = { pos: [0, 120, 0] as V, yaw: 90 }
    const spot = padSpot(shore, int01, ANNIV, start, groundClearance(), () => true)
    if (!spot) throw new Error('a shore has a spot')
    expect(spot.yaw).toBe(90)
    expect(spot.pos[1]).toBe(130)
    // Every racer's pad is on the shelf too, and none over the sea.
    for (const s of courseSlots(spot, int01, ANNIV)) expect(s.foot[0]).toBeGreaterThanOrEqual(50)
    // The whole disc the grid can turn in is dry: its reach plus the margin.
    const room = gridReach(int01, ANNIV) + PAD_SPOT_POLICY.marginMetres
    expect(spot.pos[0] - room).toBeGreaterThanOrEqual(50 - 1e-6)
    // And it is the NEAREST such place: a step nearer, the disc reaches the sea.
    const d = Math.hypot(spot.pos[0], spot.pos[2])
    const stepNearer = spot.pos[0] - PAD_SPOT_POLICY.stepMetres - room < 50
    expect(stepNearer || d < PAD_SPOT_POLICY.stepMetres).toBe(true)
    // The reach is the farthest racer's pad and its half-width: the chevron's apex.
    expect(gridReach(int01, ANNIV)).toBeGreaterThan(27.5)
  })

  it('gives up on an island of sea, and on a place the area refuses', () => {
    const sea: Ground = { surfaceAt: () => 116, waterAt: () => true }
    const start = { pos: [0, 120, 0] as V, yaw: 0 }
    expect(padSpot(sea, int01, ANNIV, start, groundClearance(), () => true)).toBeNull()
    const land: Ground = { surfaceAt: () => 130 }
    expect(padSpot(land, int01, ANNIV, start, groundClearance(), () => false)).toBeNull()
    expect(padSpot(land, int01, ANNIV, start, groundClearance(), () => true)?.pos).toEqual([
      0, 130, 0,
    ])
  })
})

// ── 5. The prop clearing round the pad ────────────────────────────────────

describe('DEV-475: a player course clears its deck of props, and no shipped mission changes', () => {
  it('clears nothing on any shipped mission', () => {
    for (const l of shipped) expect(startPadClearings(l, 51.97), l.id).toEqual([])
  })

  it('clears the environment’s own spawn radius round the ship on its pad', () => {
    const env = JSON.parse(fs.readFileSync('content/environments/simonet.json', 'utf8')) as {
      spawnClearing: { radius: number }
    }
    const radius = env.spawnClearing.radius
    const route = int01.route as V[]
    const course: PlayerCourse = {
      ...newDraft(int01, ['Amber', 'Heron']).course,
      path: { points: [0, 40, 80, 120].map((i) => route[i] as V), gap: 400 },
    }
    const level = expandPlayerCourse(course, int01)
    const c = startPadClearings(level, radius)
    expect(c).toEqual([{ x: level.spawn.pos[0], z: -level.spawn.pos[2], radius }])
    // It holds the whole grid: every racer's pad and its half-width inside it.
    for (const s of courseSlots(course.start, int01, ANNIV)) {
      const reach =
        Math.hypot(s.foot[0] - level.spawn.pos[0], s.foot[2] - level.spawn.pos[2]) +
        Math.max(s.size[0] as number, s.size[2] as number) / 2
      expect(reach).toBeLessThan(radius)
    }
    expect(startPadClearings(level, null)).toEqual([])
  })
})

// ── 6. Premises the game leans on ─────────────────────────────────────────

describe('DEV-475: the premises', () => {
  it('no shipped level authors deck pads without slabs, so `boot/app.ts`’s pads-only deck is a player course’s alone', () => {
    for (const l of shipped) {
      const grid = (l.spawn as unknown as { startGrid?: { slabs?: unknown[]; pads?: unknown[] } })
        .startGrid
      if (grid?.pads?.length) expect(grid.slabs?.length ?? 0, l.id).toBeGreaterThan(0)
    }
  })

  it('every HoverJet sky has a lift to copy, and all seven hold the ship 2.2 m over its dish', () => {
    for (const l of hoverjets) expect(startStandUp(l), l.id).toBeCloseTo(2.2, 6)
  })

  it('a new draft’s pad is the sky’s own start: its dish, and its heading', () => {
    for (const l of hoverjets) {
      const s = defaultStart(l)
      const release = [
        l.spawn.pos[0] as number,
        (l.spawn.pos[1] as number) + (l.spawn.launch?.rise ?? 0),
        l.spawn.pos[2] as number,
      ]
      expect(
        dist([s.pos[0], s.pos[1] + (startStandUp(l) as number), s.pos[2]], release),
      ).toBeLessThan(1e-9)
      const n = noseOf(l.spawn.quat)
      const f = yawForward(s.yaw)
      expect((n.x * f.x + n.z * f.z) / Math.hypot(n.x, n.z), l.id).toBeGreaterThan(0.99999)
    }
  })
})
