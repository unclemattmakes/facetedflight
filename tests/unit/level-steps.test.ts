// tests/unit/level-steps.test.ts — the FOUR steps of the level select.
//
// Matt, from the headset, 2026-09-17: *"the beginner flow is currently odd - it
// should just be ring attack, but includes free flight missions."* And the
// call: **"free flight should be a mode. so aircraft > mode > difficulty >
// location (these should be fixed, not randomly placed as they are now)."**
//
// The room is three.js and a canvas, so how it LOOKS belongs to Playwright
// (`tests/e2e/menu-screen.spec.ts` presses through all four steps). What lives
// here is everything the four steps are made of that has no DOM in it: which
// aircraft exist, which flight plans each is offered in, which ranks are in a
// plan, which courses are in a rank, what the lap plate does — and the two
// assertions in this file that come from OUTSIDE the port, which are what 2016
// calls the places and which rank page 2016 files each course under.
//
// ── What this file is guarding against ───────────────────────────────────
//
// Four failures, and none of them is a rendering bug.
//
//  1. **A step that swallows a mission.** The aircraft screen is the only way
//     to reach all thirteen courses. If `vehicleCards`, `modeCards`,
//     `rankCards` and `fixedPages` ever order or group differently, a course
//     exists, loads, scores — and cannot be selected. `mission-index.test.ts`
//     has the same guard for the display-name table (*"never hides a mission
//     behind an unknown key"*); this is that guard for the four steps above it.
//  2. **An option that MOVES.** The whole of DEV-203: the same identity has to
//     land at the same position whatever else is on the page. It is asserted as
//     a position and then, in `level-select.test.ts`, as a bearing — because a
//     bearing is what a head actually learns.
//  3. **A step with no way out.** `plateAction` decides whether BACK is on
//     screen. The case that breaks is the dullest one — a cell with one course
//     and no paging — where a rule written as "show the plates when there is
//     more than one page" leaves you in a room you cannot leave.
//  4. **A rank that disagrees with 2016.** `difficulty` comes out of
//     `setGameplayOptions.unity`; the check below holds it against a different
//     2016 file — `Button_Next.cs`'s campaign chain — and asserts a
//     relationship neither of them states. *A test that re-derives its
//     expectation the way the code does has not tested the code* (trap 24).

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Difficulty, GameMode, Level, VehicleId } from '@/content/level-schema'
import {
  cardFor,
  flownLine,
  type MissionCard,
  modeCards,
  modeRanks,
  rankCards,
  rankPlaces,
  vehicleCards,
} from '@/game/mission-index'
import {
  hangarViews,
  NO_SLOT_ORDERS,
  pagesFor,
  placeCards,
  plateAction,
  SEAT_REST_BEARING,
  type StepContent,
  seatEyeLocal,
  slotAimable,
  slotCount,
  slotFlown,
  slotOrdersFor,
  slotShapeId,
  slotsFor,
  TABLES_PER_PAGE,
  tableBearings,
  tableGazeLocal,
  tablePicture,
  viewBehind,
} from '@/render/hangar'
import { doorCards, doorStepCards } from '@/render/hangar-doors'
import { hangarSpecFor } from '@/sim/hangar'
import { legacyRootOrAbsent } from '../../tools/legacy-root.mjs'

/* ─────────────────────────────────────────────────────────── the fixtures ── */

/** A card with only the fields the four steps read. */
const card = (
  id: string,
  vehicle: VehicleId,
  mode: GameMode,
  difficulty: Difficulty,
  environment: string,
  chainIndex: number | null = null,
  best: MissionCard['best'] = null,
): MissionCard => ({
  id,
  title: id,
  vehicle,
  difficulty,
  chainIndex,
  environment,
  mode,
  vehicleName: vehicle === 'hoverjet' ? 'HoverJet' : 'JumpSeat',
  difficultyName: difficulty.charAt(0).toUpperCase() + difficulty.slice(1),
  modeName: mode === 'ringAttack' ? 'Ring Attack' : mode === 'freeFlight' ? 'Free Flight' : 'Other',
  environmentName: environment.charAt(0).toUpperCase() + environment.slice(1),
  best,
  // The steps never read the medal; `best-medal.test.ts` owns its derivation.
  medal: null,
})

const aBest: MissionCard['best'] = { score: 1200, timeSeconds: 91.4, gates: 21, setAt: 0 }

/**
 * What you can TAKE on an arc, as keys, with `null` where you can take nothing.
 *
 * Since DEV-560 the one shape of nothing is a position no key owns (an overflow
 * page's filler, drawn as nothing); the dead plate is gone. *"Can I take this"*
 * is the question every assertion about the arc's CONTENT is really asking.
 *
 * {@link platesOn} is the other half: what is DRAWN.
 */
const keysOn = (
  slots: readonly (ReturnType<typeof slotsFor>[number] | null)[],
): (string | null)[] =>
  slots.map((slot) =>
    !slotAimable(slot)
      ? null
      : slot?.kind === 'vehicle'
        ? slot.vehicle.vehicle
        : slot?.kind === 'mode'
          ? slot.mode.mode
          : slot?.kind === 'rank'
            ? slot.rank.difficulty
            : slot?.kind === 'course'
              ? slot.mission.environment
              : null,
  )

/**
 * What is DRAWN on an arc, as keys.
 *
 * Until DEV-560 a dead plate was drawn under its own key, and this and
 * `keysOn` disagreed exactly there. Matt, 2026-10-01: *"don't show greyed out
 * tables"*, so since then the two agree on every arc, and the tests below
 * that held them apart now hold that they agree.
 */
const platesOn = (
  slots: readonly (ReturnType<typeof slotsFor>[number] | null)[],
): (string | null)[] =>
  slots.map((slot) =>
    slot === null
      ? null
      : slot.kind === 'door'
        ? slot.door.id
        : slot.kind === 'vehicle'
          ? slot.vehicle.vehicle
          : slot.kind === 'variant'
            ? slot.variant.id
            : slot.kind === 'mode'
              ? slot.mode.mode
              : slot.kind === 'rank'
                ? slot.rank.difficulty
                : slot.kind === 'place'
                  ? slot.place.environment
                  : slot.mission.environment,
  )

/** The four card lists for one walk down the menu, built from real content. */
const walkTo = (
  cards: readonly MissionCard[],
  vehicle: string,
  mode?: string,
  difficulty?: string,
): StepContent => {
  const modes = modeCards(cards, vehicle)
  const ranks = mode === undefined ? [] : rankCards(cards, vehicle, mode)
  const rank = difficulty === undefined ? undefined : ranks.find((r) => r.difficulty === difficulty)
  return {
    vehicles: vehicleCards(cards),
    modes,
    ranks,
    courses: rank?.missions ?? [],
  }
}

/* ──────────────────────────────────────────────── step 1: the aircraft ───── */

describe('the first step is the AIRCRAFT', () => {
  it('deals one card per aircraft, HoverJet first', () => {
    // 2016's own order: `page_shipSelection` puts `button_HoverJet_grp` before
    // `button_jumpSeat_grp`, and `Button_Next.cs` flies all six HoverJet
    // missions before the first JumpSeat one. Asserted as an ORDER rather than
    // as `[0].vehicle === 'hoverjet'`, so a third aircraft cannot quietly land
    // between them.
    const cards = [
      card('j1', 'jumpseat', 'targetPractice', 'beginner', 'alpine', 6),
      card('h1', 'hoverjet', 'ringAttack', 'beginner', 'alpine', 0),
      card('h2', 'hoverjet', 'ringAttack', 'professional', 'simonet', 5),
    ]
    expect(vehicleCards(cards).map((v) => v.vehicle)).toEqual(['hoverjet', 'jumpseat'])
  })

  it('knows an aircraft FLIGHT PLANS, which is what the next step asks', () => {
    // The plans an aircraft flies are what the next step deals. (Its LABEL
    // listed them until DEV-559: Matt, 2026-10-01, *"don't show the game modes
    // on the aircraft mode select"*; the label is the aircraft's name alone.)
    const cards = [
      card('k', 'hoverjet', 'freeFlight', 'beginner', 'kauai', null),
      card('h1', 'hoverjet', 'ringAttack', 'beginner', 'alpine', 0),
    ]
    expect(vehicleCards(cards)[0]?.modes).toEqual(['ringAttack', 'freeFlight'])
  })

  it('can reach EVERY course through some aircraft, plan and rank, exactly once', async () => {
    const cards = await realCards()
    const walked: string[] = []
    for (const vehicle of vehicleCards(cards)) {
      for (const mode of modeCards(cards, vehicle.vehicle)) {
        for (const rank of rankCards(cards, vehicle.vehicle, mode.mode)) {
          for (const mission of rank.missions) walked.push(mission.id)
        }
      }
    }
    expect(walked.slice().sort()).toEqual(cards.map((c) => c.id).sort())
    expect(new Set(walked).size, 'no course is reachable twice').toBe(walked.length)
  })

  it('keeps one aircraft courses out of another aircraft cells', () => {
    // What `vehicleOf`/`rankOfMission` used to be asked, now that nothing
    // rotates and the finders have gone with the rotation (see their note in
    // `mission-index.ts`): the CELLS themselves have to partition the courses,
    // because a rank page that counted a course from the other aircraft would
    // be a menu disagreeing with itself.
    const cards = [
      card('h1', 'hoverjet', 'ringAttack', 'beginner', 'alpine', 0),
      card('j1', 'jumpseat', 'targetPractice', 'professional', 'simonet', 11),
    ]
    expect(modeCards(cards, 'hoverjet').flatMap((m) => m.missions.map((c) => c.id))).toEqual(['h1'])
    expect(
      rankCards(cards, 'hoverjet', 'ringAttack').flatMap((r) => r.missions.map((c) => c.id)),
    ).toEqual(['h1'])
    // And a mode key that belongs to the OTHER aircraft yields nothing here
    // rather than borrowing its courses.
    expect(rankCards(cards, 'hoverjet', 'targetPractice')).toEqual([])
  })
})

/* ──────────────────────────────────────────── step 2: the FLIGHT PLAN ────── */

describe('the second step is the FLIGHT PLAN, which the port did not have', () => {
  it('takes Free Flight OFF the Beginner rank page, which is the report', async () => {
    // Matt's words: *"the beginner flow is currently odd - it should just be
    // ring attack, but includes free flight missions."* With two axes the one
    // Free Flight course had nowhere of its own, so it landed here because its
    // extracted `difficulty` says `beginner`. Asserted BOTH ways, because "it
    // is gone" alone would also pass if the course had been dropped entirely.
    const cards = await realCards()
    const ringBeginner = rankCards(cards, 'hoverjet', 'ringAttack').find(
      (r) => r.difficulty === 'beginner',
    )
    expect(ringBeginner?.missions.map((m) => m.id)).toEqual([
      'rookie_01_hoverJet',
      'rookie_02_hoverJet',
    ])
    const freeBeginner = rankCards(cards, 'hoverjet', 'freeFlight').find(
      (r) => r.difficulty === 'beginner',
    )
    expect(freeBeginner?.missions.map((m) => m.id)).toEqual(['hoverJet_kauai_beg'])
  })

  it('offers only the modes the CONTENT has — no empty energyRace table', async () => {
    // `energyRace` (DEV-143) is a real mode of this port with no shipped level.
    // A mode is offered exactly when some course runs in it, so a fourteenth
    // JSON adds the table and no code change does (hard rule 6).
    const cards = await realCards()
    expect(modeCards(cards, 'hoverjet').map((m) => m.mode)).toEqual(['ringAttack', 'freeFlight'])
    expect(modeCards(cards, 'jumpseat').map((m) => m.mode)).toEqual(['targetPractice'])
    expect(modeCards(cards, 'hoverjet').some((m) => m.mode === 'energyRace')).toBe(false)
  })

  it('shows the JumpSeat its ONE plan rather than skipping the step', async () => {
    // Matt chose the no-skip shape knowingly. A menu that sometimes has three
    // steps and sometimes four teaches the player it has three.
    const cards = await realCards()
    const content = walkTo(cards, 'jumpseat')
    const pages = pagesFor('modes', content, slotOrdersFor(cards))
    expect(pages).toHaveLength(1)
    // ONE takeable plan, at its own bearing, on an arc that is still three
    // WIDE — the step is not skipped and Target Practice has not slid left.
    //
    // **The two it cannot fly are GAPS since DEV-312**, not dimmed plates.
    // Matt chose the plate on 2026-09-17 and asked for this on 2026-09-21
    // (#41d), and 2016 settles which is which: the two are different
    // questions. See `reachableKeys` in `mission-index.ts`.
    expect(pages[0]?.filter((s) => slotAimable(s))).toHaveLength(1)
    expect(
      pages[0]?.filter((s) => s !== null),
      'only the plan it flies is drawn',
    ).toHaveLength(1)
    // **And since DEV-419 the arc is ONE wide**: the plan step is the open
    // aircraft's own plans, so the two it cannot fly hold no position at all,
    // where #41d left them as undrawn gaps on a three-wide arc. Matt's
    // *"flight school, ring attack, free flight"* is a row with no hole in it.
    expect(pages[0]).toHaveLength(1)
  })

  it('lists a plan RANKS, and counts what you have flown of it', () => {
    const cards = [
      card('a', 'hoverjet', 'ringAttack', 'professional', 'simonet', 5, aBest),
      card('b', 'hoverjet', 'ringAttack', 'beginner', 'alpine', 0),
      card('c', 'hoverjet', 'ringAttack', 'beginner', 'desert', 1),
    ]
    const mode = modeCards(cards, 'hoverjet')[0]
    expect(modeRanks(mode as never)).toBe('Beginner · Professional')
    expect(mode?.flown).toBe(1)
    expect(mode?.missions).toHaveLength(3)
    // Its signature is the first course in the cell — derived, never chosen.
    expect(mode?.signature.id).toBe('b')
  })
})

/* ════════════════════════ THE FIXED SLOTS, as positions ══════════════════ */

/**
 * The second half of what Matt asked for on 2026-09-17: *"these should be
 * fixed, not randomly placed as they are now."*
 *
 * ── What was actually happening, which is the diagnosis ─────────────────
 *
 * `tableBearings(count)` laid a page out around the resting pointer, where
 * `count` was **how many tables the page happened to hold**, and `restFirst`
 * then ROTATED the page so whatever you had arrived in landed under the
 * pointer, moving everything else by a different amount on every visit. That
 * is what "randomly placed" was: a function of the session's history.
 *
 * DEV-203 fixed it by giving every identity ONE position across every page
 * (dead plates kept the row whole). DEV-560 (Matt, 2026-10-01: *"don't show
 * greyed out tables"*) spends the "across every page" half on purpose: each
 * arc is cut to what its step holds. What stays, and what is asserted here, is
 * the half that was the bug: **the same selection lays the same arc on every
 * visit**, and a key keeps its ORDER among its neighbours. A Beginner-only plan
 * is one table under the resting pointer, not one table beside two greyed ones.
 */
describe('the same selection lays the same arc on every visit', () => {
  it('DEV-560: a one-rank plan is a one-table arc, not three with two greyed', async () => {
    // HoverJet · Ring Attack has three ranks; HoverJet · Free Flight has one.
    const cards = await realCards()
    const orders = slotOrdersFor(cards)
    const ring = slotsFor('ranks', walkTo(cards, 'hoverjet', 'ringAttack'), orders, 0)
    const free = slotsFor('ranks', walkTo(cards, 'hoverjet', 'freeFlight'), orders, 0)
    expect(keysOn(ring)).toEqual(['beginner', 'intermediate', 'professional'])
    expect(keysOn(free)).toEqual(['beginner'])
  })

  it('reaches every place the game has, each on the arcs that hold it', async () => {
    // Every course page in the game, walked: a place appears on an arc exactly
    // when that arc's rank holds a course there, and all four are reached.
    const cards = await realCards()
    const orders = slotOrdersFor(cards)
    const seen = new Set<string>()
    for (const vehicle of vehicleCards(cards)) {
      for (const mode of modeCards(cards, vehicle.vehicle)) {
        for (const rank of rankCards(cards, vehicle.vehicle, mode.mode)) {
          const content = walkTo(cards, vehicle.vehicle, mode.mode, rank.difficulty)
          const keys = keysOn(slotsFor('courses', content, orders, 0))
          expect(new Set(keys)).toEqual(new Set(rank.missions.map((m) => m.environment)))
          for (const k of keys) if (k !== null) seen.add(k)
        }
      }
    }
    expect([...seen].sort()).toEqual(['alpine', 'desert', 'kauai', 'simonet'])
  })

  it('stands a one-table arc under the resting pointer, as a BEARING', async () => {
    // In the units a player experiences: the angle between two rays from the
    // eye. Free Flight's one Beginner table is under the resting pointer
    // (`SEAT_REST_BEARING`), where DEV-203 put it at -45 beside two greyed
    // tables. And two DIFFERENT places on one arc really are far apart, so
    // "less than 0.01" is a measurement and not a function that returns zero.
    const cards = await realCards()
    const orders = slotOrdersFor(cards)
    const spec = hangarSpecFor(9.35 / 2, 12)
    const eye = seatEyeLocal(spec)
    const unit = (p: { x: number; y: number; z: number }) => {
      const v = [p.x - eye.x, p.y - eye.y, p.z - eye.z]
      const l = Math.hypot(v[0] as number, v[1] as number, v[2] as number)
      return v.map((c) => (c as number) / l)
    }
    /** The direction from the chair to whatever holds `key` on this step. */
    const towards = (view: 'ranks' | 'courses', content: StepContent, key: string) => {
      const slots = slotsFor(view, content, orders, 0)
      const at = keysOn(slots).indexOf(key)
      expect(at, `${key} is on the ${view} arc`).toBeGreaterThanOrEqual(0)
      return unit(tableGazeLocal(spec, tableBearings(slots.length)[at] as number))
    }
    const angle = (a: number[], b: number[]) =>
      (Math.acos(
        Math.min(
          1,
          (a[0] as number) * (b[0] as number) +
            (a[1] as number) * (b[1] as number) +
            (a[2] as number) * (b[2] as number),
        ),
      ) *
        180) /
      Math.PI

    const rest = unit(tableGazeLocal(spec, SEAT_REST_BEARING))
    const onOne = towards('ranks', walkTo(cards, 'hoverjet', 'freeFlight'), 'beginner')
    expect(angle(onOne, rest), 'the one table is under the resting pointer').toBeLessThan(0.01)

    const alpine = towards('courses', walkTo(cards, 'hoverjet', 'ringAttack', 'beginner'), 'alpine')
    const desert = towards('courses', walkTo(cards, 'hoverjet', 'ringAttack', 'beginner'), 'desert')
    expect(angle(alpine, desert), 'Alpine and Mesa Canyon are two tables').toBeGreaterThan(25)
  })

  it('holds for the AIRCRAFT and the PLANS', async () => {
    const cards = await realCards()
    const orders = slotOrdersFor(cards)
    expect(keysOn(slotsFor('vehicles', walkTo(cards, 'hoverjet'), orders, 0))).toEqual([
      'hoverjet',
      'jumpseat',
    ])
    // DEV-419: each aircraft's OWN plans, in the global order cut to them — so
    // on the 2016 thirteen, Ring Attack then Free Flight on the HoverJet with
    // nothing between, and the JumpSeat's one plan alone. (Target Practice's
    // position between them was an undrawn gap from #41d until DEV-419.)
    expect(keysOn(slotsFor('modes', walkTo(cards, 'hoverjet'), orders, 0))).toEqual([
      'ringAttack',
      'freeFlight',
    ])
    expect(keysOn(slotsFor('modes', walkTo(cards, 'jumpseat'), orders, 0))).toEqual([
      'targetPractice',
    ])
    // And the same row every visit: the plan arc depends on the aircraft and
    // on nothing the session has done.
    expect(keysOn(slotsFor('modes', walkTo(cards, 'hoverjet'), orders, 0))).toEqual(
      keysOn(slotsFor('modes', walkTo(cards, 'hoverjet', 'freeFlight'), orders, 0)),
    )
  })

  it('does NOT move when the mission you arrived in changes', async () => {
    // The rotation, gone. `slotsFor` takes no current mission at all, so this
    // is asserted on the one thing that could still carry it: the same inputs,
    // twice, are the same arc. The e2e specs assert the visible half: they
    // SEARCH for the option they want instead of assuming the pointer is on it.
    const cards = await realCards()
    const orders = slotOrdersFor(cards)
    const content = walkTo(cards, 'hoverjet', 'ringAttack', 'intermediate')
    expect(keysOn(slotsFor('courses', content, orders, 0))).toEqual(['alpine', 'simonet'])
    expect(keysOn(slotsFor('courses', content, orders, 0))).toEqual(
      keysOn(
        slotsFor('courses', walkTo(cards, 'hoverjet', 'ringAttack', 'intermediate'), orders, 0),
      ),
    )
  })

  it('gives every step an arc no wider than the seat can hold', async () => {
    // Four tables is a geometry constraint (27.6 degrees apart over a 90-degree
    // arc), not a content one. If a fifth environment lands this stays true and
    // the courses step gains a page instead.
    const orders = slotOrdersFor(await realCards())
    for (const order of [orders.vehicles, orders.modes, orders.ranks, orders.courses]) {
      expect(slotCount(order)).toBeLessThanOrEqual(TABLES_PER_PAGE)
      expect(slotCount(order)).toBeGreaterThan(0)
    }
    expect([
      slotCount(orders.vehicles),
      slotCount(orders.modes),
      slotCount(orders.ranks),
      slotCount(orders.courses),
    ]).toEqual([2, 3, 3, 4])
  })

  /* ── DEV-560: no greyed tables; each arc is what its step holds ──────── */

  it('DEV-560: draws only what the step holds, so no table is greyed', async () => {
    // Matt, 2026-10-01: *"don't show greyed out tables if they don't have a
    // mode (Kauai showing on ring attack)"*. Until now the row was complete on
    // every page (DEV-203's dead plates); `keysOn` (what you can take) and
    // `platesOn` (what is drawn) differed exactly by them. Now they agree.
    const cards = await realCards()
    const orders = slotOrdersFor(cards)

    const jumpPlans = slotsFor('modes', walkTo(cards, 'jumpseat'), orders, 0)
    expect(platesOn(jumpPlans)).toEqual(['targetPractice'])
    expect(keysOn(jumpPlans)).toEqual(['targetPractice'])

    // Free Flight holds a Beginner course and nothing above it: one table,
    // where DEV-203 drew Intermediate and Professional greyed beside it.
    const freeRanks = slotsFor('ranks', walkTo(cards, 'hoverjet', 'freeFlight'), orders, 0)
    expect(platesOn(freeRanks)).toEqual(['beginner'])
    expect(keysOn(freeRanks)).toEqual(['beginner'])

    const intCourses = slotsFor(
      'courses',
      walkTo(cards, 'hoverjet', 'ringAttack', 'intermediate'),
      orders,
      0,
    )
    expect(platesOn(intCourses)).toEqual(['alpine', 'simonet'])
    expect(keysOn(intCourses)).toEqual(['alpine', 'simonet'])
  })

  it('DEV-560: Ring Attack’s places stand no Kauai, the report', async () => {
    // Kauai flies only Free Flight, so the HoverJet REACHES it, and #41d's
    // aircraft-wide reach drew it greyed on Ring Attack. The places a plan
    // deals are its own, now.
    const cards = await realCards()
    const orders = slotOrdersFor(cards)
    const ring = modeCards(cards, 'hoverjet').find((m) => m.mode === 'ringAttack')
    if (!ring) throw new Error('the content has no HoverJet Ring Attack')
    const places = pagesFor(
      'courses',
      {
        ...walkTo(cards, 'hoverjet'),
        places: placeCards(ring.missions, orders.ranks),
      },
      orders,
    )
    const drawn = places.flat().map((s) => (s?.kind === 'place' ? s.place.environment : null))
    expect(drawn).not.toContain('kauai')
    expect(drawn).not.toContain(null)
    expect(new Set(ring.missions.map((m) => m.environment))).toEqual(new Set(drawn))
  })

  it('DEV-560: keeps the GLOBAL ORDER among what stands, on every step', async () => {
    // A key never jumps past its neighbour: the cut keeps the order, so Alpine
    // is still left of Simonet wherever both stand.
    const cards = await realCards()
    const orders = slotOrdersFor(cards)
    const orderOf = {
      vehicles: orders.vehicles,
      modes: orders.modes,
      ranks: orders.ranks,
      courses: orders.courses,
    } as const
    let arcs = 0
    for (const vehicle of vehicleCards(cards)) {
      for (const mode of modeCards(cards, vehicle.vehicle)) {
        for (const rank of rankCards(cards, vehicle.vehicle, mode.mode)) {
          const content = walkTo(cards, vehicle.vehicle, mode.mode, rank.difficulty)
          for (const view of ['vehicles', 'modes', 'ranks', 'courses'] as const) {
            const keys = keysOn(slotsFor(view, content, orders, 0))
            const at = keys.map((k) => orderOf[view].indexOf(k as string))
            expect(
              at.every((i) => i >= 0),
              `${view}: a key off the order`,
            ).toBe(true)
            expect(
              at.every((i, n) => n === 0 || i > (at[n - 1] as number)),
              `${view}: out of order`,
            ).toBe(true)
            arcs++
          }
        }
      }
    }
    expect(arcs).toBeGreaterThan(0)
  })

  /* ── #41d: an aircraft is not offered another aircraft's game (DEV-312) ── */

  it('offers NO PLATE for a flight plan the open aircraft cannot fly', async () => {
    // Matt, 2026-09-21: *"A JumpSeat table must not show HoverJet modes, or the
    // reverse."* Both halves, swept over the content rather than named — so a
    // fourteenth JSON that gives the JumpSeat a Ring Attack course turns that
    // plate on by existing.
    const cards = await realCards()
    const orders = slotOrdersFor(cards)
    for (const vehicle of vehicleCards(cards)) {
      const flies = new Set<string>(modeCards(cards, vehicle.vehicle).map((m) => m.mode))
      expect(flies.size, `${vehicle.vehicle} flies nothing`).toBeGreaterThan(0)
      for (const slot of slotsFor('modes', walkTo(cards, vehicle.vehicle), orders, 0)) {
        if (slot === null) continue
        const key = slot.kind === 'mode' ? slot.mode.mode : null
        expect(key, 'a flight-plan arc holds only flight plans').not.toBeNull()
        expect(flies.has(key as string), `${vehicle.vehicle} is offered ${key}`).toBe(true)
      }
    }
    // The sweep must actually have had something to reject: at least one
    // aircraft does not fly at least one of the modes on the global arc.
    const arc = orders.modes.length
    expect(
      vehicleCards(cards).some((v) => modeCards(cards, v.vehicle).length < arc),
      'every aircraft flies every mode — the sweep above is vacuous',
    ).toBe(true)
  })

  it('lays every arc as the step’s own row, in the global order (DEV-419, DEV-560)', async () => {
    // DEV-419 cut the plan arc to the aircraft's own plans; DEV-560 cut every
    // step's. So each position is at its key's index in the global order CUT
    // to what the step holds, and an arc is as wide as what it holds.
    const cards = await realCards()
    const orders = slotOrdersFor(cards)
    for (const vehicle of ['jumpseat', 'hoverjet']) {
      const row = slotsFor('modes', walkTo(cards, vehicle), orders, 0)
      const flies = new Set<string>(modeCards(cards, vehicle).map((m) => m.mode))
      const own = orders.modes.filter((m) => flies.has(m))
      expect(row, `the ${vehicle} plan arc is its own plans`).toHaveLength(own.length)
      row.forEach((slot, at) => {
        expect(slot?.kind, `${vehicle}: position ${at} holds no plan`).toBe('mode')
        if (slot?.kind !== 'mode') return
        expect(own.indexOf(slot.mode.mode), `${slot.mode.mode} moved`).toBe(at)
      })
    }
    // And the places: a JumpSeat Beginner arc is as wide as its own places.
    const jumpBeginner = walkTo(cards, 'jumpseat', 'targetPractice', 'beginner')
    const jumpPlaces = slotsFor('courses', jumpBeginner, orders, 0)
    expect(jumpPlaces).toHaveLength(new Set(jumpBeginner.courses.map((c) => c.environment)).size)
    expect(jumpPlaces.every((s) => s !== null)).toBe(true)
  })

  it('makes every table that stands aimable, and draws no position that is not', async () => {
    // Requirement 2, as a property of the data, now that DEV-560 took the one
    // unaimable table (the dead plate) out of the room.
    const cards = await realCards()
    const orders = slotOrdersFor(cards)
    let live = 0
    for (const vehicle of vehicleCards(cards)) {
      for (const mode of modeCards(cards, vehicle.vehicle)) {
        for (const rank of rankCards(cards, vehicle.vehicle, mode.mode)) {
          const content = walkTo(cards, vehicle.vehicle, mode.mode, rank.difficulty)
          for (const view of ['vehicles', 'modes', 'ranks', 'courses'] as const) {
            for (const slot of slotsFor(view, content, orders, 0)) {
              expect(slot, `${view}: a position with nothing on it`).not.toBeNull()
              expect(slotAimable(slot), `${view}: a table is not aimable`).toBe(true)
              live++
            }
          }
        }
      }
    }
    expect(live).toBeGreaterThan(0)
    // And the one shape of nothing left.
    expect(slotAimable(null)).toBe(false)
  })

  it('is empty, not broken, before the index lands', () => {
    const nothing: StepContent = { vehicles: [], modes: [], ranks: [], courses: [] }
    for (const view of ['vehicles', 'modes', 'ranks', 'courses'] as const) {
      // One page, one position, holding nothing — `pages.length === 0` has to
      // keep meaning "still loading" for `headerText` and `applyPlates`.
      expect(pagesFor(view, nothing, NO_SLOT_ORDERS)).toHaveLength(1)
      expect(slotsFor(view, nothing, NO_SLOT_ORDERS, 0)).toEqual([null])
      // A page index past the end is a page that does not exist, not a crash.
      expect(slotsFor(view, nothing, NO_SLOT_ORDERS, 9)).toEqual([])
    }
  })
})

/* ────────────────── the unaimed press cannot launch anything ────────────── */

describe('a press with no aiming cannot board a ship', () => {
  it('puts only DESCENDING tables on the step the room opens on', async () => {
    // `restFirst` existed because the arc used to open on COURSES-under-the-
    // pointer and a blind press reloaded the world into a mission you did not
    // choose. Four steps make that structurally impossible: the room always
    // opens on `vehicles`, every slot there is an aircraft, and `choose()`
    // returns null for one. Asserted rather than left to be noticed.
    const cards = await realCards()
    const orders = slotOrdersFor(cards)
    for (const slot of slotsFor('vehicles', walkTo(cards, 'hoverjet'), orders, 0)) {
      expect(slot?.kind ?? 'vehicle').toBe('vehicle')
    }
    // And only the LAST step holds anything a press boards.
    for (const view of ['vehicles', 'modes', 'ranks'] as const) {
      const slots = slotsFor(view, walkTo(cards, 'hoverjet', 'ringAttack', 'beginner'), orders, 0)
      expect(slots.some((s) => s?.kind === 'course')).toBe(false)
    }
  })
})

/* ───────────────────── what each step STANDS on its tables (DEV-354) ─────── */

/**
 * Matt, 2026-09-24: *"mode select - this should be a single rotating ring/gate
 * for ring attack, a single jump pad for target practice. a single orb for free
 * flight."* And: *"level select - show terrain diorama, no gates."*
 *
 * `tablePicture` is the one branch `applyPage` takes, so these hold the room's
 * decision without a room: the DOM half — that the mark really turns up and no
 * island does — is `tests/e2e/ship-select.spec.ts`'s. Swept over the real
 * content, every aircraft, every step, so a plan the content adds is held too.
 */
describe('each step stands its own kind of thing on its tables (DEV-354)', () => {
  it('stands ONE MARK on every flight-plan table, and asks it for no terrain', async () => {
    // The guard that goes red if a plan table grows a course again. A `land`
    // picture or a shape id on this step is exactly what stood a signature
    // course's island here from DEV-203 to DEV-354 — a PLACE answering a
    // question about a GAME — and a shape id is a height map fetched for it.
    const cards = await realCards()
    const orders = slotOrdersFor(cards)
    let plans = 0
    for (const vehicle of vehicleCards(cards)) {
      for (const slot of slotsFor('modes', walkTo(cards, vehicle.vehicle), orders, 0)) {
        if (!slot || !slotAimable(slot)) continue
        plans++
        const label = `${vehicle.vehicle}: ${slot.kind === 'mode' ? slot.mode.mode : slot.kind}`
        expect(tablePicture(slot), `${label} stands something other than its mark`).toBe('mark')
        expect(slotShapeId(slot), `${label} asks for a course's terrain`).toBeNull()
      }
    }
    // Two aircraft, three plans between them today. The loud half: a sweep that
    // found no plan would pass every line above.
    expect(plans, 'the sweep found no flight plan').toBeGreaterThanOrEqual(3)
  })

  it('stands the LAND on every rank and course table, and asks for that course', async () => {
    // The other half of the swap: a place is its island. Each asks for the
    // course it stands for — the course itself, or the rank's signature — so
    // the land on the table is the land you will fly.
    const cards = await realCards()
    const orders = slotOrdersFor(cards)
    let places = 0
    for (const mode of modeCards(cards, 'hoverjet').concat(modeCards(cards, 'jumpseat'))) {
      const content = walkTo(cards, mode.vehicle, mode.mode)
      for (const slot of slotsFor('ranks', content, orders, 0)) {
        if (!slot || !slotAimable(slot) || slot.kind !== 'rank') continue
        expect(tablePicture(slot)).toBe('land')
        expect(slotShapeId(slot)).toBe(slot.rank.signature.id)
        for (const course of slotsFor(
          'courses',
          walkTo(cards, mode.vehicle, mode.mode, slot.rank.difficulty),
          orders,
          0,
        )) {
          if (!course || !slotAimable(course) || course.kind !== 'course') continue
          places++
          expect(tablePicture(course)).toBe('land')
          expect(slotShapeId(course)).toBe(course.mission.id)
        }
      }
    }
    // Every course the game ships stands on a land table somewhere.
    expect(places).toBe(cards.length)
  })

  it('stands the aircraft on the aircraft step', async () => {
    const cards = await realCards()
    const orders = slotOrdersFor(cards)
    for (const slot of slotsFor('vehicles', walkTo(cards, 'hoverjet'), orders, 0)) {
      if (!slot) continue
      expect(tablePicture(slot)).toBe('aircraft')
      expect(slotShapeId(slot), 'an aircraft table asks for terrain').toBeNull()
    }
  })

  it('DEV-558: stands each DOOR’s own picture, and asks for no terrain', () => {
    const cards = doorCards({
      rooms: true,
      tv: true,
      firstVisit: false,
      linkRoom: 'K7Q X4M2',
      roomNotice: null,
    })
    const pictures = (step: 'doors' | 'multiplayer') =>
      (
        pagesFor(
          step,
          {
            vehicles: [],
            modes: [],
            ranks: [],
            courses: [],
            doors: doorStepCards(step, {
              rooms: true,
              tv: true,
              firstVisit: false,
              linkRoom: 'K7Q X4M2',
              roomNotice: null,
            }),
          },
          NO_SLOT_ORDERS,
        )[0] ?? []
      ).map((s) => (s === null ? null : tablePicture(s)))
    // DEV-575: Quick Race stands 2016's gate, Single Player the aircraft,
    // Multiplayer three jets in a vic (a mark, on the instructor's display
    // case), FF-TV a set on a stand. Quick Race leads since Matt put Single
    // Player under the pointer (2026-10-02).
    // DEV-620: CREDITS first, off the left end, a scroll (a mark).
    expect(cards.map((d) => d.picture)).toEqual(['options', 'ring', 'aircraft', 'formation', 'tv'])
    expect(pictures('doors')).toEqual(['mark', 'mark', 'aircraft', 'mark', 'mark'])
    // Join Room and Host a Race a gate; Join with a Code a bare table.
    expect(pictures('multiplayer')).toEqual(['mark', 'mark', 'nothing'])
    for (const step of ['doors', 'multiplayer'] as const) {
      for (const slot of pagesFor(
        step,
        { vehicles: [], modes: [], ranks: [], courses: [], doors: cards },
        NO_SLOT_ORDERS,
      )[0] ?? []) {
        if (slot) expect(slotShapeId(slot), 'a door asks for terrain').toBeNull()
      }
    }
  })
})

/* ─────────────────────────────────────────────── the words on the labels ──── */

describe('the labels say what the table is', () => {
  it('lists the places in a rank, once each and in course order', () => {
    const rank = rankCards(
      [
        card('b', 'hoverjet', 'ringAttack', 'beginner', 'desert', 1),
        card('a', 'hoverjet', 'ringAttack', 'beginner', 'alpine', 0),
        card('c', 'hoverjet', 'ringAttack', 'beginner', 'alpine', 2),
      ],
      'hoverjet',
      'ringAttack',
    )[0]
    expect(rankPlaces(rank as never)).toBe('Alpine · Desert')
  })

  /**
   * The label canvas fits 38 monospace characters on its middle line at 44 px.
   * A longer one is squeezed by the renderer, which reads as a font bug and is
   * a measurement bug — the same trap `paintLabel` sized the TITLE against.
   *
   * "Beginner · Intermediate · Professional" is 37, which is the tightest line
   * in the room and the reason nothing above the plan step lists places.
   */
  it('keeps every line inside the label it is drawn on', async () => {
    const cards = await realCards()
    for (const vehicle of vehicleCards(cards)) {
      // DEV-559: an aircraft's label is its name alone.
      expect(
        flownLine(vehicle.missions.length, vehicle.flown).length,
        vehicle.name,
      ).toBeLessThanOrEqual(38)
      expect(vehicle.name.length, vehicle.name).toBeLessThanOrEqual(28)
      for (const mode of modeCards(cards, vehicle.vehicle)) {
        expect(modeRanks(mode).length, `${vehicle.name} ${mode.name}`).toBeLessThanOrEqual(38)
        expect(mode.name.length, mode.name).toBeLessThanOrEqual(28)
        for (const rank of rankCards(cards, vehicle.vehicle, mode.mode)) {
          expect(rankPlaces(rank).length, `${mode.name} ${rank.name}`).toBeLessThanOrEqual(38)
          expect(rank.name.length, rank.name).toBeLessThanOrEqual(28)
          for (const mission of rank.missions) {
            // The LAST step's headline is the place, not the mission title.
            expect(mission.environmentName.length, mission.id).toBeLessThanOrEqual(28)
          }
        }
      }
    }
  })

  /**
   * And the HEADER, which is a different canvas and a tighter one.
   *
   * **This test found a real one on its first run.** The plate was 64 px on a
   * 1,024 px canvas, which fits `1024 * 0.96 / (64 * 0.6)` = **25 characters** —
   * and the fourth step's own header, "TARGET PRACTICE · DIFFICULTY", is 28.
   * The renderer squeezes an overlong line, which reads as a font bug and is a
   * measurement one. `paintHeader` is 48 px now, which fits 34 and is still the
   * largest text in the room; its comment carries the angular-size working.
   *
   * It is also why the last two steps print the PLAN and then the rank rather
   * than the whole path — "HOVERJET · TARGET PRACTICE · PROFESSIONAL" is 41.
   */
  it('keeps every HEADER inside the plate it is drawn on', async () => {
    const cards = await realCards()
    const fits = (text: string) => expect(text.length, text).toBeLessThanOrEqual(34)
    fits('SELECT AN AIRCRAFT')
    for (const vehicle of vehicleCards(cards)) {
      fits(`${vehicle.name.toUpperCase()} · FLIGHT PLAN`)
      for (const mode of modeCards(cards, vehicle.vehicle)) {
        fits(`${mode.name.toUpperCase()} · DIFFICULTY`)
        for (const rank of rankCards(cards, vehicle.vehicle, mode.mode)) {
          fits(`${mode.name.toUpperCase()} · ${rank.name.toUpperCase()}`)
        }
      }
    }
  })

  it('counts what you have flown, and words it', () => {
    expect(flownLine(1, 0)).toBe('1 course · none flown')
    expect(flownLine(3, 1)).toBe('3 courses · 1 flown')
    expect(flownLine(2, 2)).toBe('2 courses · all flown')
  })

  /**
   * A group lights up as DONE only when all of it is — not when any of it is.
   *
   * The rim is a binary and the label already carries the nuance in words, so
   * the binary has to pick the meaning that is still true when you come back in
   * a week: "nothing left here" is useful, "you have been here" is not.
   */
  it('lights a group only when every course in it is flown', () => {
    const partly = vehicleCards([
      card('a', 'hoverjet', 'ringAttack', 'beginner', 'alpine', 0, aBest),
      card('b', 'hoverjet', 'ringAttack', 'beginner', 'desert', 1),
    ])[0]
    const wholly = vehicleCards([
      card('c', 'hoverjet', 'ringAttack', 'beginner', 'alpine', 0, aBest),
    ])[0]
    const mode = modeCards(
      [card('e', 'hoverjet', 'freeFlight', 'beginner', 'kauai', null, aBest)],
      'hoverjet',
    )[0]
    const rank = rankCards(
      [card('d', 'hoverjet', 'ringAttack', 'beginner', 'alpine', 0, aBest)],
      'hoverjet',
      'ringAttack',
    )[0]
    expect(slotFlown({ kind: 'vehicle', vehicle: partly as never })).toBe(false)
    expect(slotFlown({ kind: 'vehicle', vehicle: wholly as never })).toBe(true)
    expect(slotFlown({ kind: 'mode', mode: mode as never })).toBe(true)
    expect(slotFlown({ kind: 'rank', rank: rank as never })).toBe(true)
    expect(
      slotFlown({
        kind: 'course',
        mission: card('x', 'hoverjet', 'ringAttack', 'beginner', 'a', 0, aBest),
      }),
    ).toBe(true)
    expect(
      slotFlown({ kind: 'course', mission: card('x', 'hoverjet', 'ringAttack', 'beginner', 'a') }),
    ).toBe(false)
    expect(slotFlown(null)).toBe(false)
  })
})

/* ──────────────────────────────────────── there is always a way back ─────── */

describe('there is always a way back', () => {
  it('walks the steps back one at a time, 2016s GoBack()', () => {
    // 2016's own chain: `GoBack()` unwinds `missionSel* -> page_rankSelection ->
    // page_modeSelection -> page_ShipSelection`. Classic's four steps are it.
    const classic = hangarViews(false)
    expect(viewBehind('courses', classic)).toBe('ranks')
    expect(viewBehind('ranks', classic)).toBe('modes')
    expect(viewBehind('modes', classic)).toBe('vehicles')
    // The top. `MenuManager.GoBack()` loads `main_menu` from here; this room is
    // the main menu, so there is nothing above it.
    expect(viewBehind('vehicles', classic)).toBe(null)
    // Anniversary's variant step (DEV-382) sits between the plans and the
    // aircraft, so BACK from the plans lands on the variants, then the aircraft.
    const anniversary = hangarViews(true)
    expect(viewBehind('modes', anniversary)).toBe('variants')
    expect(viewBehind('variants', anniversary)).toBe('vehicles')
    expect(viewBehind('ranks', anniversary)).toBe('modes')
  })

  it('puts BACK on the left plate for every step below the first, paged or not', () => {
    for (const pageCount of [1, 2, 5]) {
      expect(plateAction(-1, 'modes', pageCount)).toEqual({ kind: 'back' })
      expect(plateAction(-1, 'ranks', pageCount)).toEqual({ kind: 'back' })
      expect(plateAction(-1, 'courses', pageCount)).toEqual({ kind: 'back' })
    }
  })

  it('shows BACK even where there is nothing to page — the one-course cell', async () => {
    // The dullest case, and the one a "show the plates when there is more than
    // one page" rule strands you in. Built from the real content so it goes red
    // the day a cell shrinks to one and nobody notices.
    const cards = await realCards()
    const smallest = Math.min(
      ...vehicleCards(cards).flatMap((v) =>
        modeCards(cards, v.vehicle).flatMap((m) =>
          rankCards(cards, v.vehicle, m.mode).map((r) => r.missions.length),
        ),
      ),
    )
    expect(smallest, 'HoverJet · Free Flight · Beginner is a cell of one').toBe(1)
    expect(plateAction(-1, 'courses', smallest)).toEqual({ kind: 'back' })
    expect(plateAction(1, 'courses', 1)).toBe(null)
  })

  it('has no BACK on the first step — there is nowhere above the aircraft', () => {
    expect(plateAction(-1, 'vehicles', 1)).toBe(null)
    expect(plateAction(-1, 'vehicles', 3)).toEqual({ kind: 'page', delta: -1 })
  })

  it('hides both plates while the index is still loading', () => {
    expect(plateAction(1, 'vehicles', 0)).toBe(null)
    expect(plateAction(-1, 'vehicles', 0)).toBe(null)
  })
})

/* ───────────────────────────────── the shipped content fits the arc ──────── */

describe('the shipped thirteen fit the arc', () => {
  it('never leaves any step with more than one page', async () => {
    // The layout claim the header and the plates are both written against. If a
    // third aircraft, a fourth plan, a fourth rank or a FIFTH ENVIRONMENT
    // lands, this goes red — which is the moment to look at the arc rather than
    // the moment to find out from a player.
    const cards = await realCards()
    const orders = slotOrdersFor(cards)
    for (const vehicle of vehicleCards(cards)) {
      for (const mode of modeCards(cards, vehicle.vehicle)) {
        for (const rank of rankCards(cards, vehicle.vehicle, mode.mode)) {
          const content = walkTo(cards, vehicle.vehicle, mode.mode, rank.difficulty)
          for (const view of ['vehicles', 'modes', 'ranks', 'courses'] as const) {
            expect(
              pagesFor(view, content, orders).length,
              `${vehicle.name} ${mode.name} ${rank.name} ${view}`,
            ).toBe(1)
          }
        }
      }
    }
  })

  it('starts both aircraft in the SAME environment, so the first screen is one map', async () => {
    // Not a preference — a measurement the header of `hangar.ts` leans on.
    // The aircraft step costs no map at all (DEV-142), but the PLAN step below
    // it stands on its signature course's island, and both aircraft's first
    // courses are `rookie_01_*` in the alpine forest. If a content change
    // breaks this the claim in the comment is wrong.
    const first = vehicleCards(await realCards()).map((v) => v.missions[0]?.environment)
    expect(new Set(first).size, `first courses are in ${first.join(', ')}`).toBe(1)
    expect(first[0]).toBe('alpine')
  })
})

/* ──────────────────────────────── what 2016 says, read a second way ──────── */

/**
 * The place names, checked against 2016 rather than against ourselves.
 *
 * CLAUDE.md: *"a test that compares two of your own devices has not tested
 * either of them — compare against something outside the port."* The names are
 * what the LAST step's tables say, and three of the four were derived from the
 * environment's scene name rather than read: that is how the desert came to be
 * called "Desert Canyon" here and "Mesa Canyon" in the game.
 *
 * SKIPS when the legacy project is not mounted, which is CI. The loud
 * counterpart below fails if that guard is ever true on a machine that has it.
 */
const SCENE = path.join(
  legacyRootOrAbsent(),
  'Assets/Faceted Flight/Scenes/setGameplayOptions.unity',
)
const haveScene = fs.existsSync(SCENE)

describe.skipIf(!haveScene)('2016 names the places the way this port does', () => {
  /**
   * Mission id -> the place name 2016 puts on its table.
   *
   * Inside the `it`, not beside it: `describe.skipIf` skips the TESTS and not
   * the describe body, so a 61 MB read out here would throw during COLLECTION
   * on every machine without the Unity project — green locally, red only in CI.
   */
  const namesFromScene = (): Map<string, string> => {
    const text = fs.readFileSync(SCENE, 'utf8')
    const out = new Map<string, string>()
    for (const doc of text.split(/^--- /m)) {
      const id = doc.match(/propertyPath: targetMissionName\n\s*value: (.*)/)
      const name = doc.match(/propertyPath: levelName_ui\n\s*value: (.*)/)
      if (!id || !name) continue
      const unquote = (v: string) => v.trim().replace(/^'(.*)'$/, '$1')
      out.set(unquote(id[1] as string), unquote(name[1] as string))
    }
    return out
  }

  // 30 s, not the default 5: the scene is **61 MB** and this is the only test
  // in the repo that reads it whole. It measures 0.2 s on an idle box and tripped
  // the 5 s default on a busy one — six agents and a headset — which is a fact
  // about the machine and not about the claim. The assertions are untouched.
  it('calls the desert MESA CANYON, which is not what this port called it', {
    timeout: 30_000,
  }, async () => {
    const scene = namesFromScene()
    const cards = await realCards()
    // Majority spelling per environment: 2016 itself is inconsistent — one
    // JumpSeat table reads "Alpine Foresst". A typo on one of three tables is
    // not a name, and porting it would be reproducing a slip rather than a
    // decision (which is what `docs/DEVIATIONS.md` is for when it IS one).
    const votes = new Map<string, Map<string, number>>()
    for (const card of cards) {
      const said = scene.get(card.id)
      if (!said) continue
      const tally = votes.get(card.environment) ?? new Map<string, number>()
      tally.set(said, (tally.get(said) ?? 0) + 1)
      votes.set(card.environment, tally)
    }

    // Three of the four: kauai shipped after this backup and has no table.
    expect([...votes.keys()].sort()).toEqual(['alpine', 'desert', 'simonet'])
    for (const [environment, tally] of votes) {
      const winner = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      const ours = cards.find((c) => c.environment === environment)?.environmentName
      expect(ours, `${environment} is what 2016 calls it`).toBe(winner)
    }
    // Said plainly, so the diff that changes it back has to argue with a name.
    expect(votes.get('desert')?.has('Mesa Canyon')).toBe(true)
  })
})

/**
 * The RANK a course is filed under, checked against a DIFFERENT 2016 file.
 *
 * `difficulty` is read out of `setGameplayOptions.unity`. This reads
 * `Button_Next.cs` — the campaign chain, `chainIndex` — and asserts a
 * RELATIONSHIP between them that neither file states and both have to satisfy:
 *
 *   **within one aircraft, the ranks partition the chain into contiguous
 *   blocks, in ladder order.**
 *
 * 2016 walks a player rookie_01 -> rookie_02 -> int_01 -> int_02 -> adv_01 ->
 * adv_02, and the rank pages hold exactly those pairs. So a course filed under
 * the wrong rank breaks the partition — it either splits a block or puts a
 * harder rank before an easier one — and the assertion catches that without
 * ever naming which rank any particular mission is. It is the orientation
 * lesson's rule applied to a menu: *assert the relationship, not the value*.
 *
 * It is also what the fixed slot ORDER is derived from (`slotOrder`), so this
 * is now doing double duty: the day the chain and the ranks disagree, the arc
 * they are both used to lay out is wrong too.
 *
 * Needs no legacy mount, because both halves are in the shipped level JSON.
 *
 * ── Why this is not a text scan of the scene ─────────────────────────────
 *
 * The first version of this check split the scene text on each
 * `m_Name: missionSel_<ship>_<rank>` and took the mission ids that followed as
 * that page's. It reported `adv_01_hoverJet` as intermediate. **A Unity scene's
 * DOCUMENT order is not its hierarchy order** — the documents are written by
 * fileID, and a page's descendants can sit anywhere in the file, including
 * before the page itself. The extractor walks `m_Father`, which is the only
 * thing that says what contains what.
 */
describe('the ranks agree with 2016s campaign chain', () => {
  it('partitions the chain into contiguous blocks, easiest first', async () => {
    const ladder: Difficulty[] = ['beginner', 'intermediate', 'professional']
    const cards = await realCards()
    for (const vehicle of vehicleCards(cards)) {
      const chained = vehicle.missions
        .filter((m) => m.chainIndex !== null)
        .slice()
        .sort((a, b) => (a.chainIndex as number) - (b.chainIndex as number))
      expect(chained.length, `${vehicle.name} is in the chain`).toBeGreaterThan(0)
      // Ladder rank never goes DOWN as you walk 2016's own running order, and
      // a rank never comes back after another one has started.
      const seen: Difficulty[] = []
      let previous = -1
      for (const mission of chained) {
        const at = ladder.indexOf(mission.difficulty)
        expect(at, `${mission.id} is one of the three ranks`).toBeGreaterThanOrEqual(0)
        expect(at, `${mission.id} does not go back down the ladder`).toBeGreaterThanOrEqual(
          previous,
        )
        if (at !== previous) {
          expect(seen, `${mission.id} does not reopen a finished rank`).not.toContain(
            mission.difficulty,
          )
          seen.push(mission.difficulty)
        }
        previous = at
      }
      expect(seen, `${vehicle.name} climbs the whole ladder`).toEqual(ladder)
    }
  })

  it('names the three courses whose rank is NOT read from 2016s menu', async () => {
    // `_ui-flow.md` §5's blocking uncertainty, made explicit: this backup is
    // mid-refactor and three courses have no holotable under a rank page. The
    // extractor falls back to the mission id and says so. The list is asserted
    // so the fallback cannot quietly spread to a fourth.
    const levels = await realLevels()
    expect(
      levels
        .filter((l) => l.difficultySource === 'id')
        .map((l) => l.id)
        .sort(),
    ).toEqual(['hoverJet_kauai_beg', 'rookie_01_hoverJet', 'rookie_02_hoverJet'])
    expect(levels.filter((l) => l.difficultySource === 'menu').length).toBe(10)
  })
})

describe.skipIf(haveScene)('2016 menu scene not mounted', () => {
  it('is why the place names were not checked against the game', () => {
    // The loud counterpart. Without it the guard above can rot for months while
    // every run stays green and nothing has been compared to anything.
    expect(haveScene).toBe(false)
  })
})

/* ─────────────────────────────────────────────────────────────── helpers ── */

/**
 * The thirteen levels, off the disk. **Read once for the whole file.**
 *
 * Read directly rather than through `loadMissionIndex`, which wants
 * `import.meta.glob`. Memoised because this file grew from twelve tests to
 * thirty and the levels are 2.05 MB of JSON — re-parsing them per `it` is
 * thirty parses of a tree nothing here mutates, and on a busy box that is the
 * difference between a suite that runs and one that trips the 5 s timeout.
 *
 * Lazily, not at module scope: `describe.skipIf` skips the TESTS and not the
 * describe body, so disk work done eagerly runs on machines the guard is there
 * to spare.
 */
let LEVELS: Promise<Level[]> | null = null
const realLevels = async (): Promise<Level[]> => {
  LEVELS ??= (async () => {
    const dir = path.resolve(__dirname, '../../content/levels')
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .sort()
    return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Level)
  })()
  return LEVELS
}

/** The same thirteen, as cards. `null` storage means no bests, so `flown` is 0. */
let CARDS: Promise<MissionCard[]> | null = null
const realCards = async (): Promise<MissionCard[]> => {
  CARDS ??= (async () => (await realLevels()).map((level) => cardFor(level, null)))()
  return CARDS
}
