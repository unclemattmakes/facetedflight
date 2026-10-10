// tests/unit/ski-map-place.test.ts — Ring Attack's places carry their own
// difficulty, as a ski map's marks. DEV-420.
//
// Matt, 2026-09-26: *"instead of choosing difficulty and then the terrain, let's
// combine the menu, so we go ring attack > terrain. on each terrain holotable, we
// should indicate difficulty like a ski map (green square, blue circle, black
// diamond). the changing difficulty should change which path is drawn on the
// terrain."* And where: *"vertically aligned on the right side of the table,
// floating above the terrain. looking up at the icon would change the path to
// indicate a different route. should be green on top, blue mid, black on
// bottom."*
//
// ── What is here, and what is Playwright's ─────────────────────────────────
//
// Here: the WALK (which plan skips its rank step, what BACK says, that no
// course is hidden by the regrouping), the PLACES (one per environment, the
// courses in rank order, a duplicate spilled rather than dropped), the COLUMN'S
// GEOMETRY from the seat — measured as angles and ray misses from the eye, the
// units a head works in, never a constant read back to itself — and the drawn
// ROUTE on the diorama. Every arc here is dealt from the real content off the
// disk, on both editions.
//
// Playwright's (`ship-select.spec.ts`, `menu-screen.spec.ts`): that LOOKING at a
// mark in a real room picks it and the island's line changes, and that a press
// then boards that course — the half that needs a canvas and a GPU.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { fleetOf } from '@/content/aircraft-schema'
import type { Edition } from '@/content/edition-schema'
import type { Difficulty, GameMode, VehicleId } from '@/content/level-schema'
import { aircraftFor } from '@/content/load-aircraft'
import { fixedPages, loadMissionIndex, type MissionCard, modeCards } from '@/game/mission-index'
import { MODES } from '@/game/modes'
import { variantStep } from '@/game/variant-stats'
import { createDiorama, ROUTE_LINE_NAME } from '@/render/diorama'
import {
  DIORAMA_LIFT,
  difficultyOnPlace,
  GAZE_RADIUS,
  type HangarArc,
  hangarArcs,
  hangarViews,
  MARK_GAZE_RADIUS,
  MARK_SPREAD,
  markGazeLocal,
  pagesFor,
  pickNearestSphere,
  placeCards,
  placesDirect,
  SEAT_REST_BEARING,
  seatEyeLocal,
  seatPitchLocal,
  slotOrdersFor,
  stepsFor,
  TABLE_ART_SCALE,
  TABLE_BODY,
  TABLE_BOUND,
  TABLE_FRAME_RAW,
  TABLE_TOP,
  TABLES_PER_PAGE,
  tableBearings,
  tableGazeLocal,
  tableLocal,
} from '@/render/hangar'
import { SKI_MARK_COLOURS, skiMarkShape, skiRouteColour } from '@/render/ski-marks'
import { hangarSpecFor } from '@/sim/hangar'
import { buildHeightField } from '@/sim/terrain/height-field'
import type { MapSampler } from '@/sim/terrain/image-sampler'

const REPO = process.cwd()
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(path.join(REPO, p), 'utf8')) as T
const ANNIVERSARY = readJson<Edition>('content/editions/anniversary.json')
const CLASSIC = readJson<Edition>('content/editions/classic.json')

/** `int_01`'s real room. The angles do not depend on it. */
const SPEC = hangarSpecFor(9.35 / 2, 12)

const deg = (r: number): number => (r * 180) / Math.PI
type V3 = { x: number; y: number; z: number }
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const len = (v: V3): number => Math.hypot(v.x, v.y, v.z)
const unit = (v: V3): V3 => {
  const l = len(v)
  return { x: v.x / l, y: v.y / l, z: v.z / l }
}
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z
/** The true angle between two directions from the eye, degrees. */
const apart = (a: V3, b: V3): number => deg(Math.acos(Math.min(1, dot(unit(a), unit(b)))))
/** Bearing of a direction, degrees; positive is to the RIGHT (the room's `tableLocal` convention). */
const bearingOf = (v: V3): number => deg(Math.atan2(v.x, -v.z))

const EYE = seatEyeLocal(SPEC)

const cardsOn = (edition: Edition): Promise<MissionCard[]> =>
  loadMissionIndex(
    undefined,
    fleetOf(() => edition),
  )
const arcsOn = async (edition: Edition): Promise<readonly HangarArc[]> =>
  hangarArcs(
    await cardsOn(edition),
    variantStep(
      () => edition,
      aircraftFor,
      () => null,
    ),
  )

/** Which modes carry their difficulty on the place, read off the rows. */
const carriers = (): string[] =>
  (Object.keys(MODES) as GameMode[]).filter((m) => MODES[m].difficultyOnPlace)

describe('which plans carry their difficulty on the place (DEV-420)', () => {
  it('is Ring Attack and Target Practice (DEV-874, the JumpSeat flow matches the HoverJet one)', () => {
    // Pinned by value, so turning it on for another plan is an edit somebody
    // makes on purpose, with the row that says why. Free Flight and Flight
    // School are Matt's calls (DEV-420's row).
    expect(carriers()).toEqual(['ringAttack', 'targetPractice'])
    expect(difficultyOnPlace('ringAttack')).toBe(true)
    expect(difficultyOnPlace('targetPractice')).toBe(true)
    expect(difficultyOnPlace('freeFlight')).toBe(false)
    expect(difficultyOnPlace('notAMode')).toBe(false)
    expect(difficultyOnPlace(undefined)).toBe(false)
  })

  it('walks plan -> place for it, and 2016’s plan -> rank -> place for the rest', () => {
    for (const variants of [false, true]) {
      const step = variants
        ? variantStep(
            () => ANNIVERSARY,
            aircraftFor,
            () => null,
          )
        : null
      const whole = stepsFor(step, 'hoverjet')
      expect(whole, 'with nothing open, the whole walk').toEqual(hangarViews(variants))
      expect(stepsFor(step, 'hoverjet', 'ringAttack')).toEqual(whole.filter((v) => v !== 'ranks'))
      // DEV-874: Target Practice (the JumpSeat's plan) walks plan -> place too.
      expect(stepsFor(step, 'jumpseat', 'targetPractice')).toEqual(
        whole.filter((v) => v !== 'ranks'),
      )
      expect(stepsFor(step, 'hoverjet', 'lesson'), 'lesson').toEqual(whole)
      // DEV-800: and Free Flight skips the rank too, with no marks (below).
      expect(stepsFor(step, 'hoverjet', 'freeFlight')).toEqual(whole.filter((v) => v !== 'ranks'))
    }
  })

  it('skips the rank for Free Flight alone, with NO marks on its places (DEV-800)', () => {
    // Matt, 2026-10-07 ("go with your recs", QUESTIONS item 61): 2016's
    // `ChallengeSelection()` goes from Free Flight straight to the places.
    // Pinned by value so a second plan skipping its rank is a deliberate edit.
    const skippers = (Object.keys(MODES) as GameMode[]).filter((m) => MODES[m].skipsRank)
    expect(skippers).toEqual(['freeFlight'])
    expect(placesDirect('freeFlight')).toBe(true)
    expect(placesDirect('ringAttack')).toBe(true)
    expect(placesDirect('targetPractice')).toBe(true)
    expect(placesDirect('lesson')).toBe(false)
    expect(placesDirect('notAMode')).toBe(false)
    expect(placesDirect(undefined)).toBe(false)
    // One flag or the other, never both: the marks are the first one's.
    for (const m of Object.keys(MODES) as GameMode[]) {
      expect(MODES[m].skipsRank && MODES[m].difficultyOnPlace, m).toBe(false)
    }
  })
})

describe('the places: one table per environment, its courses in rank order', () => {
  it("deals the HoverJet's six Ring Attack courses onto three places, two each, easiest first", async () => {
    const cards = await cardsOn(CLASSIC)
    const orders = slotOrdersFor(cards)
    const ring = modeCards(cards, 'hoverjet').find((m) => m.mode === 'ringAttack')
    expect(ring, 'the premise: a HoverJet Ring Attack plan').toBeDefined()
    const places = placeCards((ring as NonNullable<typeof ring>).missions, orders.ranks)
    // Every course on exactly one place: the regrouping hides nothing.
    const onPlaces = places.flatMap((p) => p.courses.map((c) => c.id)).sort()
    expect(onPlaces).toEqual((ring as NonNullable<typeof ring>).missions.map((c) => c.id).sort())
    for (const place of places) {
      expect(new Set(place.courses.map((c) => c.environment))).toEqual(new Set([place.environment]))
      // Easiest first, by the rank ORDER (2016's chain), never by name.
      const rows = place.courses.map((c) => orders.ranks.indexOf(c.difficulty))
      expect(rows, `${place.environment}'s column`).toEqual([...rows].sort((a, b) => a - b))
      expect(new Set(rows).size, `${place.environment}: two courses on one mark`).toBe(rows.length)
    }
    expect(
      Object.fromEntries(places.map((p) => [p.environment, p.courses.map((c) => c.difficulty)])),
    ).toEqual({
      alpine: ['beginner', 'intermediate'],
      desert: ['beginner', 'professional'],
      simonet: ['intermediate', 'professional'],
    })
  })

  it('spills a second course at one place and rank onto the next page, never onto one mark', () => {
    // No shipped content has it; a fourteenth JSON could. The second course
    // makes a second place card for the environment, and `fixedPages` puts it
    // one page later at the SAME position — reachable, and nothing moved.
    const card = (id: string, difficulty: Difficulty, environment: string): MissionCard => ({
      id,
      title: id,
      vehicle: 'hoverjet' as VehicleId,
      difficulty,
      chainIndex: null,
      environment,
      mode: 'ringAttack',
      vehicleName: 'HoverJet',
      difficultyName: difficulty,
      modeName: 'Ring Attack',
      environmentName: environment,
      best: null,
      medal: null,
    })
    const ranks = ['beginner', 'intermediate', 'professional']
    const places = placeCards(
      [
        card('a', 'beginner', 'alpine'),
        card('b', 'beginner', 'alpine'),
        card('c', 'professional', 'alpine'),
      ],
      ranks,
    )
    expect(places.map((p) => p.key)).toEqual(['alpine', 'alpine#2'])
    expect(places.flatMap((p) => p.courses.map((c) => c.id)).sort()).toEqual(['a', 'b', 'c'])
    const pages = fixedPages(places, (p) => p.environment, ['alpine', 'desert'], 2)
    expect(pages.map((row) => row.map((p) => p?.key ?? null))).toEqual([
      ['alpine', null],
      ['alpine#2', null],
    ])
  })

  it('stands the places in their environments’ order, and NO table where the plan has none (DEV-560)', async () => {
    const cards = await cardsOn(CLASSIC)
    const orders = slotOrdersFor(cards)
    const hover = modeCards(cards, 'hoverjet')
    const ring = hover.find((m) => m.mode === 'ringAttack') as (typeof hover)[number]
    const page = pagesFor(
      'courses',
      {
        vehicles: [],
        modes: hover,
        ranks: [],
        courses: ring.missions,
        places: placeCards(ring.missions, orders.ranks),
      },
      orders,
    )[0]
    // Kauai: the HoverJet flies there (Free Flight), Ring Attack does not. It
    // stood as DEV-203's greyed plate until DEV-560 (Matt, 2026-10-01: *"don't
    // show greyed out tables if they don't have a mode (Kauai showing on ring
    // attack)"*); the arc is the three places Ring Attack flies, in order.
    expect(page?.map((s) => (s?.kind === 'place' ? s.place.environment : null))).toEqual([
      'alpine',
      'desert',
      'simonet',
    ])
    expect(orders.courses).toEqual(['alpine', 'desert', 'simonet', 'kauai'])
  })
})

describe("the room's walk, dealt as the checklist reads it", () => {
  for (const [name, edition] of [
    ['Anniversary', ANNIVERSARY],
    ['Classic', CLASSIC],
  ] as const) {
    it(`${name}: Ring Attack's places sit straight under the plan, and their BACK plate names it`, async () => {
      const arcs = await arcsOn(edition)
      const planOf = (a: HangarArc, back: number) => a.path[a.path.length - back]
      // No rank arc under Ring Attack, on any aircraft that flies it.
      expect(arcs.filter((a) => a.view === 'ranks' && planOf(a, 1) === 'ringAttack')).toEqual([])
      const places = arcs.filter((a) => a.view === 'courses' && planOf(a, 1) === 'ringAttack')
      expect(places.length, 'the premise: Ring Attack place arcs').toBeGreaterThan(0)
      for (const arc of places) {
        expect(arc.backWord, `${arc.path.join(' / ')}: BACK`).toBe('FLIGHT PLAN')
        for (const plate of arc.plates) {
          if (!plate.live) continue
          expect(plate.marks?.length, `${plate.key}: a place with no marks`).toBeGreaterThan(0)
        }
      }
      // And every other plan keeps its rank step, whose places back out to it.
      const ranked = arcs.filter(
        (a) =>
          a.view === 'courses' &&
          planOf(a, 2) !== undefined &&
          planOf(a, 1) !== 'ringAttack' &&
          planOf(a, 1) !== 'targetPractice' &&
          planOf(a, 1) !== 'freeFlight',
      )
      expect(ranked.length, 'the premise: rank-walked place arcs').toBeGreaterThan(0)
      for (const arc of ranked) expect(arc.backWord).toBe('DIFFICULTY')
    })

    it(`${name}: the JumpSeat's places are locations with difficulty marks, like the HoverJet's (DEV-874)`, async () => {
      const arcs = await arcsOn(edition)
      const places = arcs.filter(
        (a) =>
          a.view === 'courses' && a.path[0] === 'jumpseat' && a.path.includes('targetPractice'),
      )
      expect(places.length, 'the premise: JumpSeat place arcs').toBeGreaterThan(0)
      for (const arc of places) {
        expect(arc.backWord, 'BACK names the plan').toBe('FLIGHT PLAN')
        // Grouped by location, derived from the content: one live table per environment
        // and a mark per difficulty it holds, never a literal mission id.
        const live = arc.plates.filter((p) => p.live)
        expect(live.length).toBeGreaterThan(0)
        const keys = live.map((p) => p.key)
        expect(new Set(keys).size, 'one table per location').toBe(keys.length)
        for (const plate of live) {
          expect(plate.marks?.length, `${plate.key}: difficulty marks`).toBeGreaterThan(0)
          const diffs = (plate.marks ?? []).map((m) => m.difficulty)
          expect(new Set(diffs).size, `${plate.key}: one mark per difficulty`).toBe(diffs.length)
        }
        // And it is symmetric about the eye line, as every arc is (DEV-858).
        const mean =
          arc.plates.reduce((a, p) => a + p.offEyeDegrees, 0) / Math.max(1, arc.plates.length)
        expect(Math.abs(mean), 'centred on the eye line').toBeLessThan(1e-6)
      }
    })

    it(`${name}: Free Flight's places sit under the plan with no rank and no marks (DEV-800)`, async () => {
      const arcs = await arcsOn(edition)
      const planOf = (a: HangarArc, back: number) => a.path[a.path.length - back]
      expect(arcs.filter((a) => a.view === 'ranks' && planOf(a, 1) === 'freeFlight')).toEqual([])
      const places = arcs.filter((a) => a.view === 'courses' && planOf(a, 1) === 'freeFlight')
      expect(places.length, 'the premise: Free Flight place arcs').toBeGreaterThan(0)
      for (const arc of places) {
        expect(arc.backWord, `${arc.path.join(' / ')}: BACK`).toBe('FLIGHT PLAN')
        const live = arc.plates.filter((p) => p.live)
        expect(live.length, 'a table per place').toBeGreaterThan(0)
        for (const plate of live) expect(plate.marks, `${plate.key}: marks`).toBeUndefined()
      }
    })

    it(`${name}: every listed course is reachable exactly once, by the room's own walk`, async () => {
      const cards = await cardsOn(edition)
      const arcs = await arcsOn(edition)
      // One variant's walk per aircraft (every variant flies the same courses):
      // the standard's, where the aircraft has a variant step.
      const withVariants = new Set(arcs.filter((a) => a.view === 'variants').map((a) => a.path[0]))
      const once = arcs.filter(
        (a) => a.view === 'courses' && (!withVariants.has(a.path[0]) || a.path[1] === 'standard'),
      )
      for (const arc of once) expect(arc.pageCount, 'the premise: one page').toBe(1)
      const reached = once.flatMap((arc) =>
        arc.plates.flatMap((p) => {
          if (!p.live) return []
          if (p.marks) return p.marks.map((m) => m.id)
          // A course plate names its environment; the arc's path names the rest.
          // Free Flight's has no rank in its path (DEV-800): the plan is last.
          const noRank = arc.path[arc.path.length - 1] === 'freeFlight'
          const hit = cards.find(
            (c) =>
              c.vehicle === arc.path[0] &&
              c.environment === p.key &&
              (noRank
                ? c.mode === 'freeFlight'
                : c.mode === arc.path[arc.path.length - 2] &&
                  c.difficulty === arc.path[arc.path.length - 1]),
          )
          return hit ? [hit.id] : []
        }),
      )
      expect(reached.slice().sort()).toEqual(cards.map((c) => c.id).sort())
    })
  }
})

describe("DEV-626: the row along the table's front, from the chair", () => {
  // Matt, 2026-10-04: *"let's put the difficulty selectors on the front of the
  // locations table, with green on the left edge, blue centered, and black on
  // the right edge"*. Every position a place arc can stand a table at, and every
  // rank a mark can take: the geometry has to hold on all of them, not on the
  // one a screenshot happened to show.
  const bearings = tableBearings(TABLES_PER_PAGE)
  const ROWS = [0, 1, 2]

  it('stands green at the left edge, blue centred, black at the right edge', () => {
    for (const b of bearings) {
      const table = sub(tableGazeLocal(SPEC, b), EYE)
      const off = ROWS.map(
        (row) => bearingOf(sub(markGazeLocal(SPEC, b, row), EYE)) - bearingOf(table),
      )
      expect(off[0], 'green left of the table axis').toBeLessThan(-5)
      expect(Math.abs(off[1] as number), 'blue on the axis').toBeLessThan(0.5)
      expect(off[2], 'black right of the table axis').toBeGreaterThan(5)
      // One row: all three at the same height.
      const ys = ROWS.map((row) => markGazeLocal(SPEC, b, row).y)
      expect(new Set(ys).size).toBe(1)
    }
    // At its EDGES: the outer two inside the table's half width, and near it.
    expect(MARK_SPREAD).toBeLessThan(TABLE_FRAME_RAW.half * TABLE_ART_SCALE)
    expect(MARK_SPREAD).toBeGreaterThan(TABLE_BOUND * 0.85)
    expect(ROWS.map(skiMarkShape)).toEqual(['square', 'circle', 'diamond'])
    // Colour as a relation, not a value: green's green channel leads, blue's
    // blue does, and black is darker than both.
    const rgb = (hex: number) => new THREE.Color(hex)
    const g = rgb(SKI_MARK_COLOURS.square)
    const bl = rgb(SKI_MARK_COLOURS.circle)
    const k = rgb(SKI_MARK_COLOURS.diamond)
    expect(g.g).toBeGreaterThan(Math.max(g.r, g.b))
    expect(bl.b).toBeGreaterThan(Math.max(bl.r, bl.g))
    expect(k.getHSL({ h: 0, s: 0, l: 0 }).l).toBeLessThan(0.15)
    // And the route a mark draws is the mark's own colour.
    for (const row of ROWS) expect(skiRouteColour(row)).toBe(SKI_MARK_COLOURS[skiMarkShape(row)])
  })

  it('stands on the FRONT: nearer the seat than the table, just proud of its face', () => {
    const flat = (v: V3) => Math.hypot(v.x - EYE.x, v.z - EYE.z)
    for (const b of bearings) {
      const base = tableLocal(SPEC, b)
      const towardSeat = { x: -Math.sin(b), z: Math.cos(b) }
      for (const row of ROWS) {
        const m = markGazeLocal(SPEC, b, row)
        const out = (m.x - base.x) * towardSeat.x + (m.z - base.z) * towardSeat.z
        // Past the table's widest side (its frame reaches 0.514 raw along z).
        expect(out).toBeGreaterThan(TABLE_FRAME_RAW.zMax * TABLE_ART_SCALE)
        expect(out).toBeLessThan(0.3)
        expect(flat(m)).toBeLessThan(flat(base))
        // Hung just under the table's top, below the island's flat cap.
        expect(m.y).toBeLessThan(SPEC.floorY + DIORAMA_LIFT - TABLE_BODY.depth)
        expect(m.y).toBeGreaterThan(SPEC.floorY + TABLE_TOP - 0.05)
      }
    }
  })

  it('gives every mark its own window: a ray at its centre takes it, and no other', () => {
    const tables = bearings.map((t) => tableGazeLocal(SPEC, t))
    for (const [n, b] of bearings.entries()) {
      const marks = ROWS.map((row) => markGazeLocal(SPEC, b, row))
      for (const [row, m] of marks.entries()) {
        const d = sub(m, EYE)
        const centres = marks.map((p) => [p.x, p.y, p.z] as const)
        expect(
          pickNearestSphere(EYE.x, EYE.y, EYE.z, d.x, d.y, d.z, centres, MARK_GAZE_RADIUS),
          'the ray at a mark picks that mark',
        ).toBe(row)
        // In no OTHER table's window (its own, or none): the room asks the
        // marks first, so a look at one aims its table too (DEV-420), and a
        // neighbour's window must never be the nearer answer.
        expect([-1, n]).toContain(
          pickNearestSphere(
            EYE.x,
            EYE.y,
            EYE.z,
            d.x,
            d.y,
            d.z,
            tables.map((p) => [p.x, p.y, p.z] as const),
            GAZE_RADIUS,
          ),
        )
      }
      // Two neighbours' windows do not overlap: the angle between them is more
      // than both windows' half-angles.
      for (let row = 1; row < marks.length; row++) {
        const a = sub(marks[row - 1] as V3, EYE)
        const c = sub(marks[row] as V3, EYE)
        const half = (v: V3) => deg(Math.atan(MARK_GAZE_RADIUS / len(v)))
        expect(apart(a, c)).toBeGreaterThan(half(a) + half(c))
      }
    }
  })

  it('stays out of the resting sightline, so turning along the arc picks nothing', () => {
    // The chair's aim is pitched down at the tables; a player turns from table
    // to table at that pitch. A ray at the resting pitch, turned to face any
    // mark square on, must still miss it, or every glance along the arc would
    // pick a difficulty on every table it passed.
    const pitch = seatPitchLocal()
    for (const b of bearings) {
      for (const row of ROWS) {
        const m = markGazeLocal(SPEC, b, row)
        const yaw = Math.atan2(m.x - EYE.x, -(m.z - EYE.z))
        const d = {
          x: Math.sin(yaw) * Math.cos(pitch),
          y: Math.sin(pitch),
          z: -Math.cos(yaw) * Math.cos(pitch),
        }
        expect(
          pickNearestSphere(
            EYE.x,
            EYE.y,
            EYE.z,
            d.x,
            d.y,
            d.z,
            [[m.x, m.y, m.z]],
            MARK_GAZE_RADIUS,
          ),
          'the resting sightline takes a mark',
        ).toBe(-1)
      }
    }
    // The premise: that ray really is at the resting pitch and the resting
    // bearing is on the arc.
    expect(deg(pitch)).toBeLessThan(-20)
    // DEV-858: the arc is symmetric about the resting bearing (an even arc straddles it).
    expect(bearings.reduce((a, b) => a + b, 0) / bearings.length).toBeCloseTo(SEAT_REST_BEARING, 9)
  })
})

/* ════════════════ the drawn route, on the diorama (render/diorama.ts) ════════ */

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
const field = () =>
  buildHeightField(
    cone,
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
const ROUTE_A = [
  [500, 100, -500],
  [2500, 150, -900],
  [3500, 120, -3000],
]
const ROUTE_B = [
  [3500, 100, -500],
  [1500, 150, -2000],
  [500, 120, -3500],
]

const drawnRoute = (d: ReturnType<typeof createDiorama>) =>
  d.object.getObjectByName(ROUTE_LINE_NAME) ?? null
const craft = (d: ReturnType<typeof createDiorama>) =>
  d.object.children.filter(
    (o) =>
      (o as THREE.Mesh).isMesh &&
      ((o as THREE.Mesh).geometry as THREE.BufferGeometry).type === 'ConeGeometry',
  ).length

describe('a place table draws its pick’s route (render/diorama.ts)', () => {
  it('draws nothing unless asked — every other level table since DEV-354', () => {
    const d = createDiorama({ field: field(), route: ROUTE_A, size: 0.5 })
    expect(drawnRoute(d)).toBeNull()
    expect(craft(d), 'the craft still fly it').toBeGreaterThan(0)
    d.dispose()
  })

  it('draws the route in its colour, over a white casing, and swaps it without rebuilding the island', () => {
    const blue = skiRouteColour(1)
    const d = createDiorama({ field: field(), route: ROUTE_A, size: 0.5, routeColour: blue })
    const island = d.object.getObjectByName('diorama-island')
    const first = drawnRoute(d)
    expect(first, 'a drawn route').not.toBeNull()
    const core = first?.getObjectByName(`${ROUTE_LINE_NAME}-core`) as THREE.Mesh
    const casing = first?.getObjectByName(`${ROUTE_LINE_NAME}-casing`) as THREE.Mesh
    expect((core.material as THREE.MeshBasicMaterial).color.getHex()).toBe(blue)
    // The casing is the edge: drawn after the island without writing depth,
    // and the core drawn after it — the order that leaves a white rim.
    expect((casing.material as THREE.Material).depthWrite).toBe(false)
    expect(core.renderOrder).toBeGreaterThan(casing.renderOrder)
    expect(casing.renderOrder).toBeGreaterThan(0)
    // Both are front-faced basic materials: no side, no new program.
    expect((core.material as THREE.Material).side).toBe(THREE.FrontSide)
    expect((casing.material as THREE.Material).side).toBe(THREE.FrontSide)

    // A new pick: a different line, the same island object.
    const black = skiRouteColour(2)
    d.setRoute(ROUTE_B, black)
    const second = drawnRoute(d)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    expect(d.object.getObjectByName('diorama-island')).toBe(island)
    const core2 = second?.getObjectByName(`${ROUTE_LINE_NAME}-core`) as THREE.Mesh
    expect((core2.material as THREE.MeshBasicMaterial).color.getHex()).toBe(black)
    // Where the line went, the craft went: the core's bounds moved with it.
    const box = (m: THREE.Mesh) => new THREE.Box3().setFromObject(m)
    expect(box(core2).equals(box(core))).toBe(false)
    // Exactly one line on the table after a swap.
    let lines = 0
    d.object.traverse((o) => {
      if (o.name === ROUTE_LINE_NAME) lines++
    })
    expect(lines).toBe(1)

    // No route: no line and no craft.
    d.setRoute(null, black)
    expect(drawnRoute(d)).toBeNull()
    expect(craft(d)).toBe(0)
    d.dispose()
  })
})
