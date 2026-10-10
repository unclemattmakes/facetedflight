// src/render/hangar.ts — the room you choose a mission in, and launch out of.
//
// The geometry comes from `sim/hangar.ts`, which is pure and seeded. This file
// turns it into meshes, and adds the three things that are furniture rather
// than shape: the strip lights, the chair, and the ring of holotables that is
// the level select.
//
// ── Why it has its own lights ─────────────────────────────────────────────
//
// `int_01`'s sun is 4 degrees above the horizon and this room is underground.
// Lit by the scene alone it is black — the clouds hit the same wall and took a
// 0.22 emissive floor (DEV-028). Here the honest answer is different, because a
// hangar is a place that would really have lights in it: the strips are
// `MeshBasicMaterial`, so they are their own illumination, and a small point
// light near the platform picks the facets out of the dark.
//
// ── You are in the CHAIR, not in the jet ─────────────────────────────────
//
// The first build of this put the camera in the cockpit and called the cockpit
// the seat. Matt, 2026-09-11: *"players were not in the cockpit while in the
// menus. that was only on the missions."* Which is what the source says too and
// what I had already read — `MM_Commander_Chair_01` sits 1.04 m below the eye
// in `setGameplayOptions`, with the HoverJet parked 8–10 m away and holotables
// ringing the seat at 1.35–1.56 m. You choose the mission, and THEN you are in
// the ship.
//
// ══ THE LEVEL SELECT ══════════════════════════════════════════════════════
//
// Until now this room held ONE table, under a comment that said so: *"FF2 ships
// ONE mission, so it gets one table — and until there is a second, a table you
// choose between is a table with nothing to choose."* All thirteen missions now
// load, so that day has arrived and the comment has been spent.
//
// ── The arrangement, in degrees from the seat ────────────────────────────
//
// 2016 rings the seat with sixteen holotables and **twenty-two of the
// thirty-seven in the scene are `m_IsActive: 0`** (`_ui-flow.md` §5), with
// `level_sel_room` parenting the chair, `MenuManager` and *the pages*. So 2016
// paged too; a full ring of everything is not what it did and not what a seated
// player can see.
//
// Thirteen tables on a full ring at 1.45 m would sit 27.7 degrees apart and
// nearly touch, and seven of them would be behind your shoulders. A seated head
// is comfortable to about ±45 degrees of yaw and can reach ±55. So:
//
//   FOUR tables on a 90-degree arc in front of the chair.
//
// Which is exactly the four PLACES, and exactly the most courses any one place
// holds — so the two steps below fill the same arc and neither of them pages.
//
// Everything below is measured from the eye, which is 1.15 m up and directly
// over the arc's centre — so every table is the same 1.551 m away
// (`hypot(1.43, 0.60)`, inside 2016's 1.35–1.56 m ring) and the numbers hold
// for all four:
//
//   | quantity                               | value                     |
//   |----------------------------------------|---------------------------|
//   | bearings                               | -45, -15, +15, +45 deg    |
//   | depression                             | 22.8 deg (a table, not a wall) |
//   | slant range, eye to table              | 1.551 m                   |
//   | true angular separation, neighbours    | **27.6 deg**              |
//   | model width 0.50 m subtends            | **18.3 deg**              |
//   | gaze window (0.26 m sphere) subtends   | **19.3 deg**              |
//   | dead band between two windows          | **8.3 deg**               |
//   | page plate to nearest table            | 26.1 deg, an 8.4 deg gap  |
//   | title cap height on the label          | 1.2 deg (~24 px on a Quest 3) |
//
// The resting pointer sits on the table at -15, not in the gap — see
// `SEAT_REST_BEARING`, which is why the arc's home bearing is half a step left.
//
// The dead band is the row to check against the pause menu, which sized its
// rows at 6 degrees because *"a head can hold 6 degrees comfortably and cannot
// reliably hold 3"*. Looking BETWEEN two tables selects neither, and the gap you
// have to hold to do it is 8.3 degrees — 38% more room than the pause menu
// already asks for. The gaze window is deliberately a degree WIDER than the
// model it guards: 2016's `SphereCast` is fat on purpose, *because a head is
// not a mouse*.
//
// Note that the separation is 27.6 degrees and not the 30 of the bearings. Both
// rays are pitched 22.8 degrees down, and yaw separation shrinks with pitch
// (`cos(sep) = sin²φ + cos²φ·cos(Δyaw)`). Sizing the dead band off the bearing
// step alone would have claimed 2.4 degrees the geometry does not have —
// `tests/unit/level-select.test.ts` measures the angle rather than asserting the
// step.
//
// ══ FOUR STEPS: AIRCRAFT, FLIGHT PLAN, RANK, PLACE ════════════════════════
//
// Matt, from the headset, 2026-09-17: *"the beginner flow is currently odd - it
// should just be ring attack, but includes free flight missions."* And the call:
// **"free flight should be a mode. so aircraft > mode > difficulty > location
// (these should be fixed, not randomly placed as they are now)."**
//
// That is 2016's own chain, restored. `Scripts/MenuManager.cs` page-swaps
// **ship -> mode -> rank -> challenge**, `GoBack()` unwinds the same chain
// backwards (`missionSel* -> rank -> mode -> ship -> main_menu`), and
// `ChallengeSelection()` dispatches on `PlayerShip × MissionRank × GameMode` —
// **three axes**. The port kept two (`['vehicles','ranks','courses']`, DEV-105),
// so the one Free Flight course had nowhere of its own to live and landed on the
// HoverJet Beginner rank page, because its extracted `difficulty` says
// `beginner`. That is exactly what Matt saw. (DEV-203.)
//
// And a `missionSel_<ship>_<rank>` page's holotables are labelled with PLACES —
// "The Simonet IslanDs", "Mesa Canyon", "Alpine Forest" — one per environment
// that cell is offered in, which is what the last step still holds.
//
// ── What the DEV-073 version got wrong, and it was a real reading ────────
//
// The port shipped WORLDS -> COURSES for a day, off `page_envSelection` and
// `MenuManager.EnvSelection()`, which do exist and are exactly as described.
// What was missed is the ONE LINE that reaches them: `ChallengeSelection()`
// short-circuits to `page_environmentSelect` **`if (mode == "freeFlight")`** and
// otherwise walks the rank pages. So `page_envSelection` is the free-flight
// branch, and the port had faithfully ported one of two routes and used it for
// both. *A structural claim with one source is a hypothesis* (§4.7).
//
// So the arc holds four kinds of table and the room's `view` has four values:
//
//   VEHICLES — one table per aircraft, carrying the aircraft itself (DEV-142).
//              A press descends. 2016's `- Select an Aircraft -`.
//   MODES    — Flight School, Ring Attack, Target Practice, Free Flight: the
//              ones that aircraft flies, and only those (DEV-419).
//              A press descends. 2016's `- Select a Flight Plan -`
//              (`modeSelection.prefab`).
//   RANKS    — Beginner, Intermediate, Professional, within that cell.
//              2016's `- Mission Difficulty -`. A press descends.
//   COURSES  — the places you can fly that aircraft, in that mode, at that rank.
//              A press BOARDS.
//
// `choose()` still returns a `MissionCard` **only when a course is committed**,
// so `boot/app.ts` needs no change: a vehicle, mode or rank press returns null,
// which it already treats as "do not board".
//
// **Ring Attack skips RANKS (DEV-420).** Matt, 2026-09-26: *"instead of
// choosing difficulty and then the terrain, let's combine the menu, so we go
// ring attack > terrain."* A plan whose mode row says `difficultyOnPlace` opens
// straight onto its places, and each place's table stands a row of ski-map
// marks along its front, one per course there: green square at the left edge,
// blue circle centred, black diamond at the right edge (DEV-626; a column off
// its right side until then). Looking at a mark picks that course and the island draws its
// route; a press on the table or the mark boards the pick. See `PlaceCard`.
//
// **JumpSeat's mode page holds ONE table.** Matt chose the no-skip shape
// knowingly, so the page is shown rather than skipped: a menu that sometimes has
// three steps and sometimes four teaches the player it has three.
//
// ══ DEV-558: a step IN FRONT of the aircraft ═══════════════════════════════
//
// Matt, 2026-10-01: *"Title Screen: Start, Enter VR. Clicking either should
// take us to the Hangar, where the first set of choices are: Single Player /
// Multiplayer / FFTV."* So a room built with `doors` opens on DOORS
// (`render/hangar-doors.ts` says what stands there): SINGLE PLAYER descends to
// the aircraft and the walk below, MULTIPLAYER descends to its own step (host,
// join with a code, a link's room), and FF-TV is the app's to board. BACK from
// the aircraft names the step it goes to, START. A room built without `doors`
// (the unit tests, the launch room) opens on the aircraft, as it always did.
//
// The MULTIPLAYER step is a branch, not a step of the walk: the live list
// (`liveViews`) is `doors, multiplayer` while it is up and `doors, vehicles,
// ...` otherwise, so BACK and its word come off the same rule they always did.
//
// ══ DEV-560: no dead plates ═══════════════════════════════════════════════
//
// Matt, 2026-10-01: *"don't show greyed out tables if they don't have a mode
// (Kauai showing on ring attack)"*. Every step's arc is the order CUT to the
// keys its content holds, as DEV-419 already cut the flight plans: a place the
// open plan does not fly, or a rank it does not offer, holds no position at all,
// and the row closes up and lays from the resting pointer like any other row.
// A key keeps its ORDER (Alpine, Mesa Canyon, Simonet, Kauai, left to right,
// wherever they stand) and the same selection lays the same arc every visit;
// what it no longer keeps is one bearing across selections. That is DEV-203's
// first property given up on purpose, and it is in DEV-560's row as a call.
//
// ══ FIXED SLOTS: the second half of what he asked for ═════════════════════
//
// ── What decided a table's bearing BEFORE, which is the diagnosis ────────
//
// Two things composed, and neither of them was the table's identity.
// `tableBearings(count)` lays a page out as
// `SEAT_REST_BEARING + (i - floor((count-1)/2)) * TABLE_BEARING_STEP`, where
// `count` is **how many tables the page happens to hold** — four give
// -45/-15/+15/+45, three give -45/-15/+15, two give -15/+15, one goes to -15. So
// an option's bearing was a function of its INDEX and of the PAGE SIZE: Beginner
// sat at -45 on a three-rank page and at -15 on a one-rank page. Then
// `restFirst`/`rotateHome` ROTATED the page so whatever you had arrived in
// landed under the resting pointer, which moved everything else too, by a
// different amount on every visit. Compose the two and a table's bearing was a
// function of the page's contents and of the session's history. Deterministic,
// and unlearnable — which is what "randomly placed" means from a chair.
//
// ── What decides it NOW ─────────────────────────────────────────────────
//
// Its IDENTITY, and only that. `mission-index.ts`'s `slotOrder` gives each key a
// place from 2016's own campaign chain, and `fixedPages` puts it there: page
// `floor(rank / width)`, slot `rank % width`, every visit, whatever else is on
// the arc. An empty position stays EMPTY — Free Flight × Intermediate holds no
// course today and its neighbours do not slide over to hide the fact.
//
//   vehicles  hoverjet   jumpseat                                  2 slots
//   modes     the OPEN AIRCRAFT's own plans (DEV-419):
//             hoverjet:  lesson     ringAttack     freeFlight      3 slots
//             jumpseat:  targetPractice                            1 slot
//   ranks     beginner   intermediate   professional               3 slots
//   courses   alpine     desert         simonet       kauai        4 slots
//
// (`lesson` is Flight School, listed since DEV-379. Matt, 2026-09-26: *"hoverjet
// flow: flight school should be the left-most table. in order -> flight school,
// ring attack, free flight"* — and, asked whether that is both aircraft, *"just
// hover jet"*. So the plan step is the one step whose arc is the open aircraft's
// own row rather than a global one: `teachersLeft` puts a teaching plan first,
// and `pagesFor` deals the plans over the order CUT to what the aircraft flies.
// The 2016 thirteen alone offer the HoverJet two plans, Ring Attack and Free
// Flight.)
//
// The slot COUNT is a property of the step (and, on the plan step, of the
// aircraft) and not of the page, so the arc a step draws is the same arc every
// time you see it.
//
// ── Which identity rests under the pointer, per step ────────────────────
//
// `tableBearings` puts slot `floor((count-1)/2)` on `SEAT_REST_BEARING`, so with
// fixed slots that is a deliberate choice and it is this one:
//
//   vehicles  2 slots, home 0 -> **HoverJet** at -15, JumpSeat at +15
//   modes     the aircraft's own: the HoverJet's 3, home 1 -> **Ring Attack** at
//             -15, Flight School at -45 and Free Flight at +15 (DEV-419); the
//             JumpSeat's one plan under the pointer
//   ranks     3 slots, home 1 -> **Intermediate** at -15
//   courses   4 slots, home 1 -> **Mesa Canyon** at -15
//
// The flight-plan step keeps one exception for an EVEN number of plans, and
// `stepBearings` is where it is made: a four-plan arc is laid CENTRED on the
// resting pointer rather than with a table under it, so all four stand in a flat
// 16:9 frame from rest (the DEV-379 follow-up, 2026-09-25). For an odd count the
// centred arc and `tableBearings`' arc are the same one, and no shipped aircraft
// has an even number of plans since DEV-419 cut the plan arc to the aircraft's
// own — so today the rule is dormant, kept for the aircraft that gets a fourth.
//
// A player therefore learns a LAYOUT — Beginner on the left, Intermediate ahead,
// Professional on the right — which is the thing the old arc could not teach.
//
// **And the bug `restFirst` existed to fix cannot happen here.** Its own note:
// *"sitting down in `int_01_hoverJet` and pressing A, with no aiming at all,
// reloaded the world into a different mission."* With four steps the room always
// opens on VEHICLES, and a press on a vehicle table descends — `choose()`
// returns null and `boot/app.ts` boards nothing. A press can only board on the
// fourth step, which you reach by three deliberate presses. The unaimed press is
// now structurally incapable of launching anything, which is a stronger
// guarantee than the rotation was, and `tests/unit/level-steps.test.ts` asserts
// it rather than leaving it to be noticed.
//
// The arc, the bearings, the gaze windows and the dead bands are untouched.
//
// ── What each step stands on its tables (DEV-142, DEV-354) ───────────────
//
//   AIRCRAFT  the aircraft, turning (`render/holo-ship.ts`).
//   MODES     ONE mark, turning: a gate, a pad or an orb (`render/mode-mark.ts`).
//             No island, no course, no jets. Matt, 2026-09-24: *"mode select -
//             this should be a single rotating ring/gate for ring attack, a
//             single jump pad for target practice. a single orb for free
//             flight."*
//   RANKS     the signature course's island, and its craft.
//   COURSES   the course's island, and its craft — and nothing marked on it:
//             *"level select - show terrain diorama, no gates."*
//   PLACES    (a plan that carries its difficulty, DEV-420) the island, the
//             PICKED course's route drawn on it in its mark's colour, and the
//             row of ski-map marks along its front (DEV-626). Still no gates.
//
// {@link tablePicture} is that table, as the one branch `applyPage` takes.
//
// ── What it costs, which is a height map only once you pick a PLAN ───────
//
// A land table draws a diorama, and a diorama needs its environment's height map
// (195 KB simonet .. 969 KB kauai, `game/mission-shape.ts`). The old first
// screen was four worlds and therefore four maps, before the player had chosen
// anything. The first screen is two aircraft and NO map — the tables carry ships
// (DEV-142) — and since DEV-354 the flight-plan step costs none either: a gate
// and an orb are GLBs the room already holds, and a pad is read off one level
// JSON. `missionField` caches per environment, so a full drill-down still tops
// out at the four maps the game has.
//
// ── The two lap plates, and what they mean on each step ──────────────────
//
// Two plates sit low and close, 0.75 m out and 0.30 m up, so you find them by
// looking down into your lap — **26.4 degrees** from the nearest table, three
// dead bands away. They fill on a 0.75 s dwell, and an A press takes them too.
//
//   left   BACK one step, on every step but the first — 2016's own `GoBack()`,
//          which unwinds one page at a time rather than jumping to the top.
//          Page-previous on the aircraft step, and hidden there unless there is
//          more than one page.
//   right  Page-next, on any step, hidden unless there is more than one page.
//
// The plate's word names the step it takes you to — `AIRCRAFT` from the modes,
// `FLIGHT PLAN` from the ranks, `DIFFICULTY` from the courses — because "BACK"
// on a four-step menu asks the player to remember where they came from, and the
// room already knows.
//
// The asymmetry is deliberate and it costs nothing: `wrapPage` wraps, so a
// "next" that comes round is enough to reach every page, and **no view has more
// than one page today** — two aircraft, three modes, three ranks and four
// places, and the arc holds four. BACK is the plate a player uses on every
// visit, so it gets the fixed home; paging is the one that may never appear at
// all. If a fifth ENVIRONMENT lands, the right plate appears beside BACK and
// everything is still reachable without a code change (hard rule 6).
//
// **Trap: dwell is for NAVIGATION, never for selection.** 2016's menu is gaze
// *plus a button press* and explicitly not dwell (`_ui-flow.md` §0), and
// choosing a mission stays that way. Both lap plates dwell because both are
// navigation — a page turn and a step back out are each reversible in one
// glance, where a mission launch reloads the world. Descending a step is not on
// a dwell either: it is a table, and tables take a press.
//
// `gaze()` returns true for a table of any of the four kinds and false for a
// plate, so `boot/app.ts`'s `holotableHovered` still means "the pointer is on
// something you could press" and can never be tripped by a plate.
//
// ── What `boot/app.ts` does, and does not have to know ───────────────────
//
// Nothing about the four steps. It passes `currentId`, calls `gaze()` while the
// menu is up, and at the A press does `const picked = hangar.choose()`:
// a `MissionCard` means board it, and null means the room handled the press
// itself. Descending a step, turning a page and going back are all null.
//
// Optional and independent: bind `turnPage(-1)` / `turnPage(+1)` to the shoulder
// buttons and `goBack()` to B — 2016's own back is `Action2` ->
// `MenuManager.GoBack()` (`Input_Look.cs:318-331`), which this room now has the
// matching method for and nothing yet binds.
//
// **Every e2e spec that walks the menu takes one more press than it used to**,
// and none of them may assume the resting pointer is on the option they want any
// more — that was the rotation, and it is gone. They search with `lookUntil`
// instead, which is what a player does. `tests/e2e/menu-screen.spec.ts` and
// `switch-course.spec.ts` are the two that encode this behaviour directly.

import * as THREE from 'three'
import { FLEET_2016, type Fleet, STANDARD_VARIANT_ID } from '@/content/aircraft-schema'
import type { EditionMedalOutline } from '@/content/edition-schema'
import type { GameMode } from '@/content/level-schema'
import {
  bestLine,
  fixedPages,
  flownLine,
  loadMissionIndex,
  type MissionCard,
  type ModeCard,
  modeCards,
  modeRanks,
  type RankCard,
  rankCards,
  rankPlaces,
  type SlotFacet,
  slotOrder,
  type VehicleCard,
  vehicleCards,
  withVariant,
} from '@/game/mission-index'
import { loadMissionPad, type MissionShape, missionShape } from '@/game/mission-shape'
import { MODES } from '@/game/modes'
import { buildPadGeometry } from '@/game/pad-art'
import { ringFrameMaterial } from '@/game/rings'
import { barFill, type VariantBar, type VariantCard, type VariantStep } from '@/game/variant-stats'
import {
  generateHangar,
  generateHangarDressing,
  type HangarSpec,
  PLINTH,
  plinthTopY,
} from '@/sim/hangar'
import type { HeightField } from '@/sim/terrain/height-field'
import { creditsRoll } from './credits-menu'
import { createDiorama, type Diorama, type HoloLook } from './diorama'
import {
  createEditorMark,
  createFormationMark,
  createOptionsMark,
  createRollMark,
  createScrollMark,
  createTvMark,
} from './door-marks'
import { type DoorCard, type DoorStep, doorDescends, FIRST_VISIT_NOTE } from './hangar-doors'
import { aircraftFront, createHoloShip, type HoloShip, type HoloShipLamp } from './holo-ship'
import { INSTRUMENT_ACCENT } from './instrument-colour'
import { createMedal, type MedalArt, type MedalPlacement, medalPlacement } from './medal'
import {
  createInstructorMark,
  createModeMark,
  disposeInstructorHull,
  gateMarkGeometry,
  instructorHull,
  type ModeMark,
  type ModeMarkKind,
  modeMarkKind,
  orbMarkGeometry,
} from './mode-mark'
import {
  CAPTION_PHONE_SCALE,
  DETAIL_PHONE_SCALE,
  HEADER_PHONE_SCALE,
  LABEL_PHONE_SCALE,
  PLATE_PHONE_SCALE,
  phoneUi,
} from './phone-floor'
import { hexSrgb } from './racer-livery'
import { disposeTree } from './scene-walk'
import {
  createSkiMarkKit,
  SKI_MARK_COLOURS,
  type SkiMarkShape,
  skiMarkShape,
  skiRouteColour,
} from './ski-marks'
import { forgetTextExtent } from './ui-font'
import {
  UI_ACCENT,
  UI_DEAD,
  UI_DEAD_DIM,
  UI_DIM,
  UI_DIM_TRACK,
  UI_HOLO,
  UI_INK,
  UI_LABEL_BACK,
  UI_LABEL_HALO,
  uiFont,
  uiType,
} from './ui-tokens'

/**
 * Every step the level select CAN have, in order. See the header.
 *
 * In order, and the order is load-bearing: {@link goBack} walks the live list
 * ({@link hangarViews}) leftwards rather than carrying a table of "which step
 * is behind which".
 *
 * `variants` is DEV-382's: the aircraft VARIANT, a second pick after the
 * aircraft (Matt, 2026-09-24: *"a new selection after the aircraft type"*). It
 * exists on Anniversary only (AIRCRAFT-VARIANTS §8), so this is the whole set
 * and {@link hangarViews} is what a room actually walks.
 */
export const HANGAR_VIEWS = ['vehicles', 'variants', 'modes', 'ranks', 'courses'] as const
/** A step of the single-player walk: the aircraft and everything under it. */
export type WalkView = (typeof HANGAR_VIEWS)[number]

/**
 * DEV-558's two door steps, IN FRONT of the walk: `doors` (Single Player,
 * Multiplayer, FF-TV) and the `multiplayer` branch under it. Only a room built
 * with `HangarOptions.doors` has them. See the header.
 */
export const DOOR_VIEWS = ['doors', 'multiplayer', 'options', 'credits'] as const
export type HangarView = WalkView | DoorStep

/** Is `view` one of DEV-558's door steps? */
export const isDoorView = (view: HangarView): view is DoorStep =>
  view === 'doors' || view === 'multiplayer' || view === 'options' || view === 'credits'

/**
 * The steps a room walks: all five when the edition has aircraft variants,
 * and 2016's four — ship, flight plan, rank, place — when it does not. Classic
 * never shows the variant step and never reads a variant's record.
 */
export const hangarViews = (variants: boolean): readonly HangarView[] =>
  variants ? HANGAR_VIEWS : HANGAR_VIEWS.filter((v) => v !== 'variants')

/**
 * The steps a room walks below `vehicle`, given its variant step (DEV-382).
 *
 * THE decision, as a pure function, and the room and {@link hangarArcs} both
 * take it: the variant step is there when the edition has one (read live) AND
 * the aircraft has variants to show. So Classic walks 2016's four whatever is
 * stored, and an aircraft with no variants file walks straight to its plans.
 * With no aircraft open yet, it is the edition's answer alone.
 */
export const stepsFor = (
  step: VariantStep | null | undefined,
  vehicle: string | undefined,
  /**
   * The open flight plan, once one is (DEV-420). A plan whose place carries its
   * difficulty walks no rank step: plan -> place. Absent — nothing opened yet,
   * or a caller asking about the room as a whole — is the full walk.
   */
  mode?: string,
): readonly HangarView[] => {
  const views = hangarViews(
    !!step?.enabled() && (vehicle === undefined || step.cardsFor(vehicle).length > 0),
  )
  return placesDirect(mode) ? views.filter((v) => v !== 'ranks') : views
}

/**
 * Does this flight plan choose its difficulty ON the place's table (DEV-420)?
 * The mode row's own answer (`game/modes.ts`, `difficultyOnPlace`), never its
 * name; an unknown key does not. Ring Attack, today.
 */
export const difficultyOnPlace = (mode: string | undefined): boolean =>
  mode !== undefined && Object.hasOwn(MODES, mode) && MODES[mode as GameMode].difficultyOnPlace

/**
 * Does this flight plan open straight onto its PLACES, with no rank step
 * (DEV-420, DEV-800)? Ring Attack, because its places carry the difficulty, and
 * Free Flight, because 2016 skipped the rank for it and its places carry no
 * difficulty at all. The mode rows' own answer, never a name.
 */
export const placesDirect = (mode: string | undefined): boolean =>
  difficultyOnPlace(mode) ||
  (mode !== undefined && Object.hasOwn(MODES, mode) && MODES[mode as GameMode].skipsRank)

/** What the nose pointer is resting on. */
export type HangarAim =
  /**
   * A course table, on the LAST step. The only aim an A press BOARDS.
   *
   * On a PLACE table (DEV-420) it is the course that table has picked, and
   * `place` is the table's; on one of its difficulty marks it is that mark's
   * course, `mark` is true, and aiming there has just picked it.
   */
  | {
      readonly kind: 'mission'
      readonly mission: MissionCard
      readonly place?: PlaceCard
      readonly mark?: boolean
    }
  /**
   * A door table (DEV-558), on the first step or Multiplayer's. An A press
   * descends (Single Player, Multiplayer) or hands the door to the app.
   */
  | { readonly kind: 'door'; readonly door: DoorCard }
  /** An aircraft table, on the aircraft step. An A press descends into it. */
  | { readonly kind: 'vehicle'; readonly vehicle: VehicleCard }
  /** A variant table, on Anniversary's second step (DEV-382). An A press descends into it. */
  | { readonly kind: 'variant'; readonly variant: VariantCard }
  /** A flight-plan table, on the second step. An A press descends into it. */
  | { readonly kind: 'mode'; readonly mode: ModeCard }
  /** A rank table, on the third step. An A press descends into it. */
  | { readonly kind: 'rank'; readonly rank: RankCard }
  | { readonly kind: 'page'; readonly delta: -1 | 1 }
  /** The lap plate that goes back one step. Up on every step but the first. */
  | { readonly kind: 'back' }

export interface HangarArt {
  readonly object: THREE.Object3D
  /**
   * Advance the dioramas' tiny jets, turn the aircraft and the flight-plan
   * marks, and fill the page plates' dwell. Render time.
   */
  update(seconds: number): void
  /**
   * Is the NOSE POINTER on a mission holotable?
   *
   * Matt: *"UI was in-world and selection was 'nose pointer' based, so where
   * the user looked was the 'hovered over' item."* 2016 implements it as a
   * 0.125 m `SphereCast` against layer 18 (`Input_Look.cs:132`) — a fat ray,
   * deliberately, because a head is not a mouse and an exact ray makes a small
   * target unhittable.
   *
   * So this is a ray-versus-sphere test around each table rather than a mesh
   * raycast: the same forgiveness, it cannot be thrown off by the tiny jets
   * flying between you and it, and with N tables the NEAREST miss wins.
   *
   * `origin` and `direction` are WORLD space; `direction` need not be
   * normalised. Calling it also sets the hover state the tables draw, and it is
   * what tells `update()` that the menu is on screen — a frame with no `gaze()`
   * clears the aim and resets the dwell, so pages cannot turn while you are
   * flying.
   *
   * Returns a BOOLEAN, not the mission: the lap plates are aimable too and a
   * press on one must not board a ship. True for a table of ANY kind — an
   * aircraft, a flight plan, a rank or a course — because all four are things
   * an A press does something with. Read {@link aim} for which.
   */
  gaze(origin: THREE.Vector3, direction: THREE.Vector3): boolean
  /** What the pointer is on, mission or page plate, or null. */
  readonly aim: HangarAim | null
  /**
   * How far along the last {@link gaze} ray the aimed thing's window is
   * centred, in world metres — the point on the ray nearest that table's or
   * plate's gaze sphere. Null whenever {@link aim} is.
   *
   * For the motion controller's reticle (DEV-321), which has to sit where the
   * beam meets the table. The windows are fat spheres, not the table's mesh, so
   * this is where the RAY is when it counts as a hit — the honest place to draw
   * one, and the only one the picker itself knows about.
   */
  readonly aimDistance: number | null
  /** The last mission committed with {@link choose}. Survives a page turn. */
  readonly chosen: MissionCard | null
  /**
   * Commit whatever the pointer is on. The A press.
   *
   * On a COURSE: records it, fires `onChoose`, returns it — the one case that
   * returns non-null, and therefore the one case the caller boards on. On an
   * AIRCRAFT, a FLIGHT PLAN or a RANK: descends a step and returns null. On a
   * page plate: turns the page. On the back plate: goes back a step. On nothing:
   * nothing. So a caller can be one line — `const picked = hangar.choose()` —
   * and never has to know which kind of thing it was aiming at.
   */
  choose(): MissionCard | null
  /** Which step is up. */
  readonly view: HangarView
  /**
   * DEV-884: a difficulty mark is under the aim. A click or a tap on one picks
   * it (aiming is picking) and does not also board: the room's caller skips
   * `choose()` for a pointer press while this is true.
   */
  readonly markAimed: boolean
  /**
   * DEV-884: the bearing a first visit's seat rests on at the step that is up
   * (its first table), or null for the step's own rest. `stepStartYaw` turns it
   * into the seat's look.
   */
  readonly firstRestBearing: number | null
  /**
   * The steps this room walks right now: {@link hangarViews}, five when the
   * edition has aircraft variants and the open aircraft has any, 2016's four
   * otherwise (DEV-382).
   */
  readonly views: readonly HangarView[]
  /** Every aircraft, once the index lands. Empty until then. */
  readonly vehicles: readonly VehicleCard[]
  /** Which aircraft is open. Null on the first step. */
  readonly vehicle: VehicleCard | null
  /**
   * The open aircraft's variant tables (DEV-382), with each one's record.
   * Empty on the first step and on an edition without the variant step.
   */
  readonly variants: readonly VariantTable[]
  /** Which variant is open. Null above the flight-plan step, and on Classic. */
  readonly variant: VariantCard | null
  /** The flight plans of the open aircraft. Empty on the first step. */
  readonly modes: readonly ModeCard[]
  /** Which flight plan is open. Null on the first two steps. */
  readonly mode: ModeCard | null
  /** The ranks of the open (aircraft, mode). Empty on the first two steps. */
  readonly ranks: readonly RankCard[]
  /** Which rank is open. Null unless {@link view} is 'courses'. */
  readonly rank: RankCard | null
  /** Descend into an aircraft by index. Out of range is ignored. */
  openVehicle(index: number): void
  /** Descend into a variant of the open aircraft, by index (DEV-382). Out of range is ignored. */
  openVariant(index: number): void
  /** Descend into a flight plan of the open aircraft, by index. Out of range is ignored. */
  openMode(index: number): void
  /** Descend into a rank of the open (aircraft, mode), by index. Out of range is ignored. */
  openRank(index: number): void
  /** Back one step — 2016's `MenuManager.GoBack()`. No-op on the first step. */
  goBack(): void
  /** Straight to the AIRCRAFT step, whatever is open. Idempotent. */
  showVehicles(): void
  /**
   * Straight to the FIRST step (DEV-558): the doors, on a room built with
   * them; the aircraft otherwise. Idempotent.
   */
  showDoors(): void
  /** The door tables on the step that is up (DEV-558). Empty off a door step. */
  readonly doors: readonly DoorCard[]
  /**
   * Park a ship in the room, once its mesh arrives.
   *
   * Separate from {@link HangarOptions.parkedShip} because the room is built
   * synchronously and a GLB is not, and a boot that waits on a mesh to show a
   * menu is a boot that waits. Replaces whatever is parked; null clears it.
   */
  park(ship: THREE.Object3D | null): void
  /**
   * Hand the room the title logo, once its mesh arrives, so finished courses
   * can wear their medal (DEV-113, `render/medal.ts`).
   *
   * Same shape as {@link park} for the same reason: the room is built
   * synchronously and a GLB is not. Any course table already up gets its medal
   * on the spot; later pages get theirs as they are laid out. Null clears the
   * logo and every medal with it.
   */
  medals(logo: THREE.Object3D | null): void
  /**
   * Hand the room the AIRCRAFT models, once their meshes arrive — one per
   * vehicle id, which is the key the level index deals cards under (DEV-142).
   *
   * Same shape as {@link park} and {@link medals}, for the same reason. An
   * aircraft table already up gets its ship on the spot; later pages get
   * theirs as they are laid out. Null clears them, and an id with no model
   * gets a bare table rather than a stand-in.
   */
  ships(models: Readonly<Record<string, THREE.Object3D>> | null): void
  /**
   * Hand the room the GATE — the loaded `checkpoint-ring.glb` — once it
   * arrives, so a ring-scoring flight plan stands 2016's own frame (DEV-326,
   * and on the flight-plan table since DEV-354).
   *
   * Same shape as {@link medals}, for the same reason. The room takes its own
   * copy of the geometry (`gateMarkGeometry`), so the caller may dispose what
   * it loaded. A table already up gets its gate on the spot. Null takes it off.
   */
  gates(gate: THREE.Object3D | null): void
  /**
   * Hand the room the ORB — the loaded `energy-orb.glb` — so an orb-scoring
   * flight plan stands 2016's own ball (DEV-327, DEV-354). {@link gates}'s
   * shape exactly: the room copies the geometry (`orbMarkGeometry`), a table
   * already up gets its orb on the spot, and null takes it off.
   */
  orbs(orb: THREE.Object3D | null): void
  /**
   * Say the room is busy, and refuse presses while it is.
   *
   * A mission swap takes seconds — a level, a terrain worker, 1.8 M vertices —
   * and it happens with the player still sitting here, because the room is not
   * part of what is being replaced. So the room has to say so, and it has to
   * stop a second press starting a second swap on top of the first.
   *
   * `null` clears it. The header goes back to whatever the step says.
   */
  setBusy(text: string | null): void
  /**
   * Tell the room which mission is now loaded.
   *
   * It moves no table — nothing rotates since DEV-203, which is the point — but
   * it decides which PAGE the last step opens on the next time you go down to
   * it. The POSITION of a place is the place's, whatever you are flying.
   */
  setCurrent(missionId: string): void
  /**
   * DEV-465: the room while a course loads IN it. Every table but the one
   * standing for `missionId` is hidden (all of them, if no table on the step
   * does), and so are the page and back plates and the step header: the
   * loading plate says what the header would. The kept table keeps the look
   * it had when it was pressed, and nothing is aimable, so the course cannot
   * change under the load. It holds through a re-lay of the step. `null` puts
   * the step back as it lays.
   *
   * Hiding costs no program: a table's lamps hang on the room, never in the
   * table's group, so the room's light count cannot move (`Table.lamps`).
   */
  focus(missionId: string | null): void
  /** The course the room is focused on, or null. */
  readonly focused: string | null
  /**
   * Re-read the personal bests, keeping the step and the place you are on.
   *
   * A card's `best` is read once, when the index loads — so a run you have just
   * flown is not on the table you flew it from until the document reloads. That
   * was a single stale line on one table before the maps step; it is now also a
   * **count of the whole place** ("4 courses · 2 flown") and a rim colour, which
   * is the one thing the first screen is for. `boot/app.ts` calls this when the
   * player comes back to the chair.
   *
   * Deliberately NOT a re-open: the view, the open aircraft, the open flight
   * plan, the open rank and the page all survive, because coming out of a run
   * into the aircraft step would throw away the list you launched from and the
   * obvious next thing to fly — the other place at the same rank, one press
   * away.
   */
  refresh(): void
  /**
   * DEV-373: repaint the COURSE labels on the page that is up, and nothing
   * else — no diorama, no medal, no header. For the ghost line
   * ({@link HangarOptions.ghostLine}), which moves on a press or when a board
   * arrives; a whole `refresh` would rebuild the islands to change one line.
   */
  relabel(): void
  /**
   * DEV-420: the course a PLACE table has picked — what it draws, labels and
   * boards. For readers outside the room (`__ff2.share()`'s card report).
   */
  pickFor(place: PlaceCard): MissionCard
  /** Which page is up, and how many there are. Both 0 while the index loads. */
  readonly page: number
  readonly pageCount: number
  /** Turn by `delta` pages of the CURRENT step, wrapping. Returns the page now up. */
  turnPage(delta: number): number
  /**
   * The FIXED SLOT pages of the step that is up. Empty until the index lands.
   *
   * A page is a fixed-length row and `null` is a position this step has nothing
   * for — see `mission-index.ts`'s `fixedPages`. It is a row and not a list
   * precisely so an empty position cannot be closed up.
   */
  readonly pages: readonly (readonly (TableSlot | null)[])[]
  dispose(): void
}

export interface HangarOptions {
  readonly spec: HangarSpec
  /** Deterministic, so the room is the same room every load. */
  readonly seed: number
  /** The mission already in memory — its name, for the table shown while the
   * index loads. */
  readonly title: string
  /** The line under it — the best so far, or an invitation. Same placeholder. */
  readonly subtitle: string
  /**
   * The level already in memory, for the placeholder table's diorama. Null
   * builds the table without one.
   *
   * Matt: *"levels were presented as mini-dioramas of the actual level, with
   * tiny jets flying around em."* See `render/diorama.ts`.
   *
   * This is the CURRENT mission only. Every other table gets its shape from
   * `game/mission-shape.ts`, which reads it off the level JSON. It carried the
   * level's `gates` too until DEV-354, when the level tables stopped drawing
   * any: the island and the racing line are all a level table shows.
   */
  readonly level: {
    readonly field: HeightField
    readonly route: readonly (readonly number[])[] | null
  } | null
  /**
   * Which mission `title`/`level` describe, so the room opens on its page.
   *
   * Optional, and worth passing: without it the current mission is matched by
   * TITLE, which works for the thirteen shipped levels (all distinct) and
   * silently opens on page 0 for anything else. Missing it costs a page turn,
   * never a wrong table.
   */
  readonly currentId?: string
  /**
   * The index, pre-built. Omit and the room loads it itself from
   * `content/levels/*.json`.
   *
   * Injectable so a test can hand in four cards with no `import.meta.glob`, no
   * network and no PNG decode.
   */
  readonly missions?: readonly MissionCard[] | null
  /** Where a table's course comes from. Defaults to `missionShape`. */
  readonly shapeFor?: (missionId: string) => Promise<MissionShape>
  /**
   * How much of a hologram to make each table's island — the live preset's
   * `menu.holoTerrainColours`, read when a diorama is built (DEV-140). A
   * callback rather than a value so a preset flip needs only a `refresh()`.
   * Omitted or null: 2016's plain full-colour miniature.
   */
  readonly holoLook?: () => HoloLook | null
  /**
   * The medal's silhouette shell — the live preset's `menu.medalOutline`, read
   * when a medal is built (DEV-151). A callback for the same reason as
   * `holoLook`. Omitted or null: 2016's bare emblem.
   */
  readonly medalOutline?: () => EditionMedalOutline | null
  /** Fired when the player commits a mission. See {@link HangarArt.choose}. */
  readonly onChoose?: (mission: MissionCard) => void
  /**
   * Chair, holotables, page plates and header — the things you CHOOSE with.
   *
   * ── 2016 builds this room twice, and only one of them is furnished ─────
   *
   * `Environment_Hangar.prefab` is instanced in `Scenes/setGameplayOptions.unity`
   * AND inside `Prefabs/PlayerStart_ElevatorShaft_Photon_02.prefab`, which is
   * what a mission scene places. Counted:
   *
   *     setGameplayOptions   hangar shell, 8 shaft segments, 61 chair objects,
   *                          16 holotables, NO mission terrain
   *     the launch prefab    hangar shell, 8 shaft segments, **no chair**,
   *                          **no holotables**
   *
   * So the menu room and the launch room are the same ART in two unrelated
   * places: one you sit in and choose from, one you ride out of and never sit
   * in. The port had a single room doing both jobs, welded into the mission
   * world at the base of its launch shaft — which is where every environment
   * bug of 2026-09-13/14 came from (DEV-076).
   *
   * `false` builds the shell and its lights and nothing else: no chair, no
   * tables, no index load, and a `gaze()` that never reports a target. That is
   * the launch prefab's room.
   */
  readonly furnished?: boolean
  /**
   * A ship parked in the room, at its origin, facing the room's forward.
   *
   * 2016's menu scene instances `hoverJet_exterior_orange.fbx` **twice**, which
   * is why there is a jet beside the chair at all. The port used to get one for
   * free by wrapping the room around the mission's own launch platform — and
   * therefore had none on the six missions with no platform.
   *
   * Parked at the origin and yawed by `PARKED_SHIP_YAW` in the room's frame —
   * swept, not derived (DEV-139). 2016's own room parks its jet 10.1 m from
   * the chair (`Environment_Hangar/HoverJet` at (400.93, −9.65, 322.25) against
   * the live `MM_Commander_Chair_01` at (391.13, −10.13, 324.64) in
   * `setGameplayOptions.unity`); the port's chair is 8.5 m out.
   */
  readonly parkedShip?: THREE.Object3D | null
  /**
   * The aircraft VARIANTS, for the step after the aircraft (DEV-382). Absent
   * or null is a room with 2016's four steps, which is also what an edition
   * whose `enabled()` is false gets.
   */
  readonly variants?: VariantStep | null
  /**
   * DEV-399: which aircraft the live edition flies — the glider stands behind
   * `gameplay.glider` — asked on every index load, so a preset flip adds or
   * removes its table at the next `refresh()`. Absent: 2016's two, which is
   * `loadMissionIndex`'s own default.
   */
  readonly fleet?: Fleet
  /**
   * DEV-373: a course card's GHOST line — which ghost boarding it races, and
   * the press that changes it (PLAYER-GHOSTS §4.2, door 2) — or null for a
   * course with none (a mode that races nobody). Asked whenever a course label
   * is painted; {@link HangarArt.relabel} asks again. Absent: 2016's three
   * lines, exactly as before.
   */
  readonly ghostLine?: (mission: MissionCard) => string | null
  /** Flow A: a browser that has never finished a run: Flight School wears the first-visit note. */
  readonly firstVisit?: boolean
  /**
   * DEV-558: the door tables for a door step, asked whenever that step is
   * laid (a preset flip reaches it at the next `refresh()`). Present: the room
   * opens on the DOORS, in front of the aircraft. Absent: no door steps, and
   * the room opens on the aircraft, as before (the launch room, the tests).
   */
  readonly doors?: (step: DoorStep) => readonly DoorCard[]
  /**
   * DEV-558: a press of a door the room does not descend through (FF-TV,
   * Host a Race, Join with a Code, Join Room). The room does nothing else with
   * it; `choose()` returns null as for every press that is not a course.
   */
  readonly onDoor?: (id: string) => void
}

/**
 * The HUD's accent, so the room belongs to the same instrument family.
 *
 * Re-exported rather than defined here: `render/elevator.ts` needs it too, and
 * an edge from the elevator into this file drags `mission-shape` -> `load-level`
 * -> `import.meta.glob` behind it, which killed the whole Playwright collection
 * for a day. See `render/instrument-colour.ts`.
 */
export const STRIP_COLOUR = INSTRUMENT_ACCENT
const HOLO_COLOUR = 0xffcf7a
/** The rim, while the nose pointer is on it: since DEV-574 the only ink a rim is drawn in. */
const HOLO_HOVER = 0xfff3d6
/** A table whose mission has a personal best on it (the rim's, until DEV-574; the shelf's look). */
const HOLO_FLOWN = 0x8ad8e0
/**
 * The rim of a table with **nothing behind it** — a slot the step defines and
 * the content has no course for (DEV-203). **This is the number to argue with.**
 *
 * Matt, 2026-09-17, choosing the dimmed plate over an empty position: *"The arc
 * reads as a row. Nothing moves between visits. A dead table is still a thing
 * you try to press."* He took the last risk knowingly, so the job is to make
 * the second sentence as untrue as a picture can make it.
 *
 * ── Why THIS value, against `ART_DIRECTION.md` ──────────────────────────
 *
 * The rim is a `MeshBasicMaterial`, so it is its own light: a live one GLOWS in
 * a dark hangar and that is the table's whole "I am a thing" signal. The dead
 * state is the removal of that glow, which is the register rather than an
 * exception to it — *"nothing else glows"*, and this is one fewer thing that
 * does.
 *
 * `0x3c4654` is a neutral slate, one step lighter than the plinth's `0x2a313c`
 * so the ring still reads as a ring rather than dissolving into the table (*too
 * dark has not been reviewed, it has been rendered*). Against `HOLO_COLOUR` it
 * is **3.1x darker in sRGB** and carries none of the amber's chroma, so the
 * difference survives both the ACES roll-off and a comfort-darkened periphery —
 * it is a hue change as well as a value change.
 *
 * And it is the SECOND cue, not the first. Pillar 1 is silhouette: a dead table
 * has no island, no aircraft and no medal on it, so at 500 mm of arc it is a
 * bare disc among models. That is the cue that survives peripheral vision; the
 * colour is what confirms it when you look.
 */
const HOLO_DEAD = 0x3c4654

/**
 * Yaw applied to the WHOLE ROOM, to put the chair where the shot is.
 *
 * Matt, 2026-09-11: *"it looks like the hoverjet is rotated with its engine
 * facing the player, instead of the nose kinda diagonally angled towards the
 * player"* — and then, given a sweep to choose from: *"if the nose is pointing
 * at 12 o'clock, I'd like the seat to be around 2."*
 *
 * The room is a symmetric revolve, so this is applied by spinning the group
 * rather than by moving the furniture: the chair, the tables and the dioramas
 * keep their relationship to each other, and only their relationship to the
 * parked SHIP changes.
 *
 * ── Measured, not derived, and the derivation is why ────────────────────
 *
 * The first build computed this from "the jet's nose points along −z" and put
 * the chair at what should have been a 40-degree front quarter. It came out a
 * side view. The mesh does not settle it either: the art's local bounds run
 * −2.2 to +4.4 in z, so the LONG end is +z — while a spin of 0, which puts the
 * chair at +z, renders the exhaust. Two plausible readings, opposite answers,
 * and a quaternion assertion would have "proved" whichever one I believed.
 *
 * So it was swept — 0, 90, 180, 220, 270, 320 — and Matt picked the frame. The
 * calibration that fell out: **clock hour = 6 + spin / 30**, with 0 at the
 * tail. Keep that if this ever needs moving again; it is the only part of this
 * that generalises.
 *
 * ── And then the ship moved INTO the room, and this stopped moving it ──────
 *
 * That calibration was measured while the ship hung from the mission's launch
 * anchor OUTSIDE this group, so spinning the group walked the chair around a
 * ship that stayed put. Since the room got its own scene (DEV-076) the jet is
 * parked as a CHILD of this group (`parkShip`), and a child turns with its
 * parent: the chair and the ship kept the spin-0 relation whatever this said —
 * which is the tail (DEV-040's own words: *"a spin of 0 … renders the
 * exhaust"*), and which is what Matt saw on 2026-09-16: *"the ship should be
 * rotated to face me."* The knob that turns the ship relative to the chair is
 * now {@link PARKED_SHIP_YAW}; this one only orients the room in the world,
 * and the room is a revolve. Left at 220 so nothing else moves (DEV-139).
 */
export const HANGAR_SPIN = (220 * Math.PI) / 180

/**
 * The parked ship's yaw IN THE ROOM'S FRAME, about +y. The chair sits on the
 * room's local +z (`seatEyeLocal`).
 *
 * ── Swept, not derived (DEV-139, the orientation lesson) ───────────────────
 *
 * Twelve frames from the seat with the mesh yawed by hand through `__ff2`, on
 * 2026-09-16: 0, 60, 120, 180, 240, 300, then 90, 270, 285, 300, 315, 330. What
 * the frames showed, and what the numbers off the same frames measured:
 *
 *   - the hull runs along the mesh's local **x**, not z — 0 and 180 are the
 *     two SIDE views (mirror images), which is why DEV-040's z-reasoning could
 *     never have settled it;
 *   - **90 is the tail**: three exhaust nozzles, the −x end (half-width
 *     0.313 m) 5.36 m from the eye and the +x end 12.14 m;
 *   - **270 is the nose, head-on**: canopy up, wings symmetric, the +x end
 *     (half-width 0.276 m, the one that tapers) **4.85 m** from the eye and the
 *     tail **11.66 m**;
 *   - 285 is the nose on the seat with a 15-degree quarter, so the canopy and
 *     one flank read rather than a flat symmetric wedge — the composition of
 *     2016's own aircraft-select frame (the 2016 gameplay video at 0:30 and
 *     4:40: three-quarter from the front, nose to the viewer).
 *
 * Calibration, re-based onto the ship: **270 puts the nose on the chair, 90
 * the tail, and 30 degrees is one clock hour.** `tests/unit/parked-ship.test.ts`
 * pins it as a distance — the nose end nearer the eye than the tail end — and
 * not as an angle.
 */
export const PARKED_SHIP_YAW = (285 * Math.PI) / 180

/**
 * Where the chair sits, as a fraction of the room radius from the axis.
 *
 * 0.66 of 12.86 m is 8.5 m from the platform's centre — inside 2016's *"the
 * parked HoverJet sits ~8–10 m away"* and far enough back that the whole ship
 * is in frame rather than filling it.
 */
const SEAT_RADIUS_FRACTION = 0.66

/**
 * Seated eye height above the floor, in metres.
 *
 * 2016 puts `MM_Commander_Chair_01` 1.04 m below the eye. That is the chair's
 * ORIGIN rather than its seat pan, so this is the same figure rounded to a
 * seated eye height that also works for a standing player in a headset who
 * never gets a chair under them.
 */
export const SEAT_EYE_HEIGHT = 1.15

/**
 * Metres from the seat's AXIS to a table, horizontally.
 *
 * 2016 rings the seat at 1.35–1.56 m, and that is a slant range to a table
 * 0.7 m below the eye — so the horizontal reach that lands inside it is 1.43,
 * giving `hypot(1.43, 0.60) = 1.551 m` to the point the gaze sphere is centred
 * on. The single-table build used 1.45 with a 0.52 m side offset, which put the
 * target at **1.653 m**: outside the band it cited, by a tenth of a metre.
 */
export const HOLO_REACH = 1.43

/**
 * Height of a table top above the floor.
 *
 * The first build of this was a STANDING console — a 1.5 m plinth under a
 * 1.35 m ring — which at 1.45 m from a seated eye put a bar of glowing orange
 * straight across the eyeline and hid the parked jet behind it. 2016 puts its
 * holotables **about 0.7 m below eye level**: a table you look down at. So the
 * top is that far under `SEAT_EYE_HEIGHT` and the rest is sized from it.
 */
export const TABLE_TOP = SEAT_EYE_HEIGHT - 0.7

/**
 * Where on a table the gaze sphere is centred, above the table top.
 *
 * The model's visual middle rather than its base: the islands stand proud of
 * the rim, and a sphere centred on the glass would sit under the thing you are
 * looking at.
 */
const GAZE_LIFT = 0.1

/**
 * How far a label floats above its table top, in metres.
 *
 * 0.40 puts it at 0.85 m — 0.30 m below the eye, clear of the model's 0.15 m
 * peaks, and, more to the point, clear of the NEIGHBOUR's peaks. On an arc you
 * read each label across the island next door: the first build lifted it 0.28
 * and the outer labels came out sitting in the middle of the next table's
 * mountains.
 */
const LABEL_LIFT = 0.4

/** How many tables fit on the arc. See the header for the whole derivation. */
export const TABLES_PER_PAGE = 4

/**
 * DEV-620, DEV-879: the tables the room builds, two more than a page holds: the first
 * step's fifth and sixth (OPTIONS and the COURSE EDITOR). Every other step uses four and
 * hides the rest. Their lamps are not in the room (`Table.lamps`): it never
 * stands an aircraft, and two more point lights would be two more in every
 * lit program's key.
 */
export const ROOM_TABLES = TABLES_PER_PAGE + 2

/** Bearing between neighbouring tables, radians. 30 degrees. */
export const TABLE_BEARING_STEP = Math.PI / 6

/**
 * How wide a diorama is, in metres. 14.3 degrees at 1.551 m.
 *
 * DEV-627: 0.5 until Matt, 2026-10-04: *"plz scale them down a lil bit so they
 * fit within the bounds of the table"*. A 0.25 m radius overhung 2016's
 * table, whose top frame comes no nearer its axis than 0.217 m
 * ({@link TABLE_BOUND}). 0.39 keeps the island inside that even at the
 * selected table's 1.1 scale (0.2145 m), at rest and selected, at every
 * pedestal turn. `diorama-body.test.ts` measures it.
 */
export const MODEL_SIZE = 0.39
/**
 * The holo rim's radius — the table's edge, from its axis. The plinth's top is
 * 0.24 under it and its foot 0.32. The medal's offset is a ratio of THIS
 * (`medalLocal`), the way 2016's is a ratio of its table's half-depth.
 */
export const TABLE_RIM_RADIUS = 0.26
/** The plinth: 0.24 at the top against a 0.375 m half-spacing, 0.32 at the foot. */
export const TABLE_TOP_RADIUS = 0.24
export const TABLE_FOOT_RADIUS = 0.32

/**
 * DEV-574: the HIGHLIGHT is a square, half this many metres a side, laid with
 * one side toward the seat. Matt, 2026-10-02: *"right now theres an octogon -
 * make it a square instead (so it matches the table) - only show the
 * 'highlight square' when a table is selected"*.
 *
 * And on the photographs, the same day: *"make the "highlighted" square match
 * the holotable inset size. give it a glow"*. So it traces the INSET, the
 * recessed dark screen in the table's top, not the outer edge it traced at
 * first (0.235 m, the top's bevel).
 *
 * The table is 2016's `MM_Commander_Table_01` (`render/hangar-art.ts`), scaled
 * uniformly by `TABLE_TOP / TABLE_ART_HEIGHT` so its top lands on `TABLE_TOP`.
 * Measured off its geometry ({@link TABLE_INSET_RAW}, in its own units): the
 * inset is a flat square of near-black faces at y 0.830, +-0.367 in x and
 * -0.335 to 0.400 in z (so +-0.367 about a centre 0.0325 along its z), sunk
 * 0.046 under the blue frame round it, whose top is at 0.876. At the port's
 * scale that is a square 0.177 m half a side, its centre 16 mm off the axis
 * along the table's own z, 0.401 m over the floor, in a frame whose top is at
 * 0.423 m. The square is laid in the pedestal's own frame (`layHighlight`), so
 * it lies on the inset whatever the pedestal's turn. `hangar-tables.test.ts`
 * measures all four numbers against the GLB.
 */
export const TABLE_ART_HEIGHT = 0.9322
/** DEV-574: the table GLB's inset, in its own units, measured off its faces (see above). */
export const TABLE_INSET_RAW = { half: 0.367, centre: 0.0325, floor: 0.83, frame: 0.876 } as const
/** The table art's uniform scale on the port's table: `hangar-art.ts`'s `tableTop / tableHeight`. */
export const TABLE_ART_SCALE = TABLE_TOP / TABLE_ART_HEIGHT
/** DEV-574: the highlight square's half side: the inset's, 0.177 m. */
export const TABLE_SQUARE_HALF = TABLE_INSET_RAW.half * TABLE_ART_SCALE
/** DEV-574: the inset's centre, off the table's axis along the pedestal's own z: 16 mm. */
export const TABLE_INSET_CENTRE = TABLE_INSET_RAW.centre * TABLE_ART_SCALE
/** The square's bar: 8 mm, finer than the 18 mm octagon's, because the glow carries its weight. */
export const TABLE_SQUARE_BAR = 0.008
/**
 * DEV-574: the square's height over the floor: on the frame's top, at the lip
 * of the inset, so the frame's near side cannot hide it from the chair.
 */
export const TABLE_HIGHLIGHT_Y = TABLE_INSET_RAW.frame * TABLE_ART_SCALE + TABLE_SQUARE_BAR

/**
 * DEV-574: the glow, as three bands laid flat along the square, each reaching
 * `reach` metres either side of its line and adding `intensity` of the hover
 * ink. Additive, so where they overlap (on the line) they sum: 1.75 on the
 * line, 0.55 a centimetre off it, 0.15 at the edge, nothing past 2.6 cm. A
 * stepped falloff, faceted like everything else in the room, and in the
 * world rather than in a post pass, so a headset (which never runs the bloom,
 * `render/bloom.ts`) sees the same glow a monitor does. On a monitor the
 * bloom adds its own soft halo, because the line sums past its threshold of
 * 1.0. Taste, and Matt's to move.
 */
export const TABLE_GLOW_BANDS: readonly { readonly reach: number; readonly intensity: number }[] = [
  { reach: 0.006, intensity: 1.2 },
  { reach: 0.014, intensity: 0.4 },
  { reach: 0.026, intensity: 0.15 },
]

/**
 * DEV-574: how far a resting picture is turned past facing the chair, radians.
 * Matt: the models *"rest (at a pleasing angle, not edge-on)"*: an aircraft
 * shows its nose and one flank, a gate its opening and its depth, the set its
 * screen and its side. Thirty degrees, counter-clockwise seen from above.
 * Taste, and Matt's to move.
 */
export const PICTURE_REST_TURN = (30 * Math.PI) / 180

/**
 * DEV-574: the yaw (about the table group's vertical, which the room never
 * turns) that faces a picture's FRONT to the seat from a table at `bearing`,
 * then turns it `turn` further. The table stands at
 * `(sin b, -cos b) * HOLO_REACH` from the seat, so the seat lies along
 * `(-sin b, cos b)`, which three's `rotation.y = -b` turns +z onto.
 */
export const restYawFor = (bearing: number, front: number, turn = PICTURE_REST_TURN): number =>
  -bearing + front + turn

/** DEV-574: the highlight square's mesh name, for anything reading the scene from outside. */
export const TABLE_RIM_NAME = 'holotable-rim'
/** DEV-574: the highlight: the square and its glow, one group, shown and hidden together. */
export const TABLE_HIGHLIGHT_NAME = 'holotable-highlight'
/** DEV-574: a glow band's mesh name. */
export const TABLE_GLOW_NAME = 'holotable-glow'

/**
 * DEV-574: lay a table's highlight in the PEDESTAL's frame: turned as the
 * pedestal is, and centred on its inset, which stands {@link TABLE_INSET_CENTRE}
 * along the pedestal's own +z.
 *
 * `pedestalYaw` is the pedestal's `rotation.y` where 2016's table has landed
 * (`hangar-art.ts`, `pedestalYaw`, kept true for the bearing by `applyPage`),
 * and null where it has not (the generated plinth, or a failed load): then the
 * yaw the pedestal WOULD have, near enough. 2016's eye-ward side faces the seat,
 * and that side is the table's -x (its mean `toSeat` is 0.3 degrees off -x), so
 * the turn is the seat's, -bearing, plus a quarter. Inside the group the square
 * is axis-aligned (`createHangar` builds it so), and a square is the same at
 * every quarter turn, so one side faces the seat either way.
 */
export const layHighlight = (
  highlight: THREE.Object3D,
  bearing: number,
  pedestalYaw: number | null,
): void => {
  const yaw = pedestalYaw ?? -bearing + Math.PI / 2
  highlight.rotation.set(0, yaw, 0)
  highlight.position.set(
    Math.sin(yaw) * TABLE_INSET_CENTRE,
    TABLE_HIGHLIGHT_Y,
    Math.cos(yaw) * TABLE_INSET_CENTRE,
  )
}

/** A flat square annulus in XZ, centred on the origin: `inner` to `outer` half a side. */
const squareBand = (inner: number, outer: number): THREE.BufferGeometry => {
  const shape = new THREE.Shape()
  shape.moveTo(-outer, -outer)
  shape.lineTo(outer, -outer)
  shape.lineTo(outer, outer)
  shape.lineTo(-outer, outer)
  shape.closePath()
  const hole = new THREE.Path()
  hole.moveTo(-inner, -inner)
  hole.lineTo(-inner, inner)
  hole.lineTo(inner, inner)
  hole.lineTo(inner, -inner)
  hole.closePath()
  shape.holes.push(hole)
  const geometry = new THREE.ShapeGeometry(shape)
  geometry.rotateX(-Math.PI / 2)
  geometry.deleteAttribute('uv')
  return geometry
}

/**
 * DEV-574: a glow band's material: `ringFrameMaterial()`'s class (the gate on
 * QUICK RACE's table, the plans' and the multiplayer step's), black, glowing the
 * hover ink, added to the frame and writing no depth. Colour, emissive and
 * opacity are uniforms and blending and depth writes are state, so it is the
 * gate's PROGRAM: a table selected for the first time compiles nothing, and the
 * bands, which the room never disposes, keep that program alive on every step
 * after (a step whose tables stand no gate used to release it).
 * `hangar-tables.test.ts` holds every field a program key reads against the
 * gate's.
 */
export const tableGlowMaterial = (intensity: number): THREE.MeshStandardMaterial => {
  const material = ringFrameMaterial()
  material.color.setRGB(0, 0, 0)
  material.emissive.setHex(HOLO_HOVER)
  material.emissiveIntensity = intensity
  material.opacity = 1
  material.blending = THREE.AdditiveBlending
  material.depthWrite = false
  return material
}

/**
 * DEV-574: one table's highlight: the square (the rim) and its glow bands, in
 * a group laid by {@link layHighlight}, hidden until its table is selected.
 * Geometry and materials are the room's, shared by every table (and the
 * course shelf's), so nothing here compiles per table.
 */
export const buildHighlight = (kit: {
  readonly rimGeometry: THREE.BufferGeometry
  readonly rimMaterial: THREE.Material
  readonly bands: readonly { geometry: THREE.BufferGeometry; material: THREE.Material }[]
}): THREE.Group => {
  const highlight = new THREE.Group()
  highlight.name = TABLE_HIGHLIGHT_NAME
  const rim = new THREE.Mesh(kit.rimGeometry, kit.rimMaterial)
  rim.name = TABLE_RIM_NAME
  // A torus is built in its XY plane with corners on its axes: laid flat
  // (x a quarter turn) and turned an eighth in its plane, its sides lie along
  // the group's x and z, which are the pedestal's.
  rim.rotation.set(Math.PI / 2, 0, Math.PI / 4)
  highlight.add(rim)
  for (const band of kit.bands) {
    const mesh = new THREE.Mesh(band.geometry, band.material)
    mesh.name = TABLE_GLOW_NAME
    // Under the line, so the line reads on top of its own glow.
    mesh.position.y = -TABLE_SQUARE_BAR * 0.5
    mesh.renderOrder = 1
    highlight.add(mesh)
  }
  highlight.visible = false
  return highlight
}

/** DEV-574: the room's highlight kit, built once. See {@link buildHighlight}. */
const highlightKit = () => ({
  // A torus of four segments is a square frame whose corners stand root two
  // times its half side out.
  rimGeometry: new THREE.TorusGeometry(TABLE_SQUARE_HALF * Math.SQRT2, TABLE_SQUARE_BAR, 3, 4),
  // The hover ink, doubled: a uniform, so no program of its own, and bright
  // enough to pass the monitor's bloom threshold (1.0) so the line itself
  // blooms too. A headset tone-maps it to near white.
  rimMaterial: new THREE.MeshBasicMaterial({
    color: new THREE.Color(HOLO_HOVER).multiplyScalar(2),
  }),
  bands: TABLE_GLOW_BANDS.map((b) => ({
    geometry: squareBand(TABLE_SQUARE_HALF - b.reach, TABLE_SQUARE_HALF + b.reach),
    material: tableGlowMaterial(b.intensity),
  })),
})

/**
 * The cylinder a flight-plan MARK is sized into (DEV-354, `render/mode-mark.ts`):
 * its swept disc at most {@link MARK_SWEEP} across and its height at most
 * {@link MARK_TALL}, whichever binds first.
 *
 * `MARK_SWEEP` is the aircraft's own — the rim's diameter, the disc
 * `createHoloShip` sizes a ship to — so no step's model overhangs its table.
 *
 * `MARK_TALL` is the room under the LABEL. The label hangs 0.40 m over the table
 * top and 0.18 m toward the seat, 0.155 m tall and tilted back, so its lower
 * edge is about 0.33 m up; the sight line from the eye over that edge crosses
 * the table's axis about 0.28 m up. A mark stands on the model plane
 * (`DIORAMA_LIFT`, 0.06 m) plus the aircraft's hover (a twelfth of its sweep),
 * so 0.18 m puts a gate's top at about 0.26 m — seen whole, under the words.
 *
 * What that makes of each, on this table: the GATE is bound by its height, 0.18
 * m tall and 0.26 m wide; the ORB too, 0.18 m across; the PAD by its sweep, a
 * dish 0.52 m across, as wide as the aircraft sweeps. Both numbers are taste,
 * the ship's included, and Matt's to move (DEV-354's row).
 */
export const MARK_SWEEP = TABLE_RIM_RADIUS * 2
export const MARK_TALL = 0.18

/**
 * DEV-623: the credits roll on the CREDITS step's one table, metres. It is
 * the only table on its step, so it is not held to a mark's sweep, and the
 * table hides its label (the roll says CREDITS itself), so the roll stands
 * where the label was: 0.72 m by 0.38 m at the table's 1.55 m, about 26 by
 * 14 degrees, its bottom 0.1 m above the model plane and its top about
 * 0.16 m below the eye, under the step's CREDITS sign. The first placement,
 * over the label, put its top 0.42 m above the eye, and a flat frame at rest
 * cut the top line off (DEVIATIONS DEV-623).
 */
export const CREDITS_ROLL_WIDTH = 0.72
export const CREDITS_ROLL_HEIGHT = 0.38
export const CREDITS_ROLL_LIFT = 0.1

/**
 * How fat the ray is, in metres, at the table.
 *
 * 0.26 m at 1.551 m is a 19.3-degree window around an 18.3-degree model — half
 * a degree of forgiveness on each side, and 8.3 degrees of dead band before the
 * next one starts. 2016's cast is 0.125 m at up to 20 m; forgiveness scales
 * with distance and this target is close.
 *
 * The ceiling is HALF the neighbour spacing (0.370 m), above which two windows
 * overlap and "look between them" stops being reachable. `level-select.test.ts`
 * asserts the gap rather than this number.
 */
export const GAZE_RADIUS = 0.26

/**
 * The step header: its height above the floor, and its plane. Names rather than
 * literals since DEV-420, whose difficulty column has to stand clear of it and
 * is measured against it (`ski-map-place.test.ts`).
 */
export const HEADER_LIFT = 1.02
export const HEADER_WIDE = 0.78
export const HEADER_TALL = 0.1

/** The page plates: bearing, reach and height. Low and close, in your lap. */
/**
 * DEV-858: how far either side of the EYE's resting line a page plate lies, in
 * radians. It was 20 degrees either side of the room's forward, and the eye
 * rests 15 degrees left of that (`SEAT_REST_BEARING`), so the two plates stood
 * at -5 and +35 degrees from where the player looks: the left one dead ahead,
 * under the room's floor logo (DEV-839). Measured from the eye now, and 30
 * degrees (a table step) so the BACK plate's word clears the logo's footprint
 * (`hangar-symmetry.test.ts`).
 */
export const ARROW_BEARING = (30 * Math.PI) / 180
export const ARROW_REACH = 0.75
const ARROW_HEIGHT = 0.3
/** Their own forgiveness. Smaller targets, and they must not reach a table. */
export const ARROW_GAZE_RADIUS = 0.16
/** DEV-858: the window about the gap between an even arc's middle two tables that takes the right-middle one at rest. */
export const REST_GAP_RADIUS = 0.2
/**
 * DEV-580: a page plate is a square this many metres half a side: the
 * apothem of the octagon it replaces (0.11 m to a corner, so 0.1016 m to a
 * side), rounded, so the plate reads the size it did.
 */
export const PLATE_HALF = 0.1
/** DEV-580: the dwell's fill frame, a square band from this half side... */
export const PLATE_FILL_INNER = 0.105
/** ...to this one: the 2 cm band the round fill ring had (0.115 to 0.135). */
export const PLATE_FILL_OUTER = 0.125
/** A square's corner radius from its half side: what three's four-segment circle is sized by. */
export const plateSquareRadius = (half: number): number => half * Math.SQRT2
/** Seconds of continuous aim that turns a page. */
export const PAGE_DWELL_SECONDS = 0.75

/**
 * The eye's position while the menu is up, in the hangar's own local space.
 *
 * Exported because the camera is placed by `app.ts` and the layout is the
 * room's business: a caller that has to know where the chair is, is a caller
 * that gets it wrong the first time the room changes.
 */
export const seatEyeLocal = (spec: HangarSpec): { x: number; y: number; z: number } => ({
  x: 0,
  y: spec.floorY + SEAT_EYE_HEIGHT,
  z: spec.roomRadius * SEAT_RADIUS_FRACTION,
})

/**
 * Where the nose pointer rests when you sit down and move nothing.
 *
 * Half a step LEFT of the room's forward, so that a full page of four is the
 * symmetric -45/-15/+15/+45 arc AND there is a table exactly under the
 * pointer. Those two are not automatically compatible: an arc of an EVEN number
 * of tables centred on the forward has a gap in the middle, and the first build
 * of this put the resting pointer in it.
 *
 * A menu that starts aimed at nothing is defensible — you cannot launch
 * something you have not read — and it is wrong here for a concrete reason:
 * `tests/e2e/menu-screen.spec.ts` boards from the resting aim, on the flat
 * screen, with a symmetric look-away and look-back. Under a pointer resting in
 * the gap, two of its three tests stop passing and the failure looks like a
 * gaze bug rather than a layout choice.
 */
export const SEAT_REST_BEARING = -TABLE_BEARING_STEP / 2

/**
 * The bearings of `count` tables, laid out around the resting pointer.
 *
 * Positive is to the RIGHT. **DEV-858: every arc is SYMMETRIC about
 * {@link SEAT_REST_BEARING}**, the eye's resting line (Matt: *"the hangar menus
 * are not centred"*): an odd count has its middle table on the line, an even one
 * has the line between its middle two. Four give -45/-15/+15/+45 off the eye
 * line (it was -30/0/+30/+60: the arc stood 15 degrees right of where you look),
 * three -30/0/+30, two -15/+15. The price is that on an even arc the resting
 * pointer is in the gap, so a blind press does nothing there; the frame loop
 * aims the right-middle table at rest instead (`restingSlot`).
 *
 * **Since DEV-203 `count` is a property of the STEP and not of the page.** It is
 * `slotCount(order)` — how many distinct keys the content offers that step — so
 * the arc a step draws is the same arc every time you see it, and an option's
 * bearing is a function of its own identity. Before, `count` was however many
 * items had survived filtering, which is why Beginner moved.
 */
export const tableBearings = (count: number, step: number = TABLE_BEARING_STEP): number[] => {
  const mid = (Math.max(1, count) - 1) / 2
  return Array.from({ length: Math.max(0, count) }, (_, i) => SEAT_REST_BEARING + (i - mid) * step)
}

/**
 * DEV-858: the slot a resting head falls on: the middle one of an odd arc, and
 * the right-middle of an even one (the line lies between the middle two).
 */
export const restingSlot = (count: number): number => Math.floor(Math.max(1, count) / 2)

/**
 * DEV-578: the bearing between neighbouring tables on the FIRST step (the
 * doors), radians. 23 degrees, where every other step keeps
 * {@link TABLE_BEARING_STEP}'s 30.
 *
 * Matt, 2026-10-03: *"FF-TV - move to production"*. So a release build's
 * first step is four tables too (QUICK RACE, SINGLE PLAYER, MULTIPLAYER,
 * FF-TV), and with SINGLE PLAYER under the resting pointer (Matt,
 * 2026-10-02) the home table is the second of four: one table to its left,
 * two to its right. At 30 degrees FF-TV stood at +60 from the resting aim,
 * its centre past the edge of a flat 1280 x 720 frame (about 51 degrees
 * each side at the room's 70-degree vertical field). So the doors close up
 * instead, and the step is the narrowest that keeps the tables apart:
 *
 *   | step | gap between 2016's tables | FF-TV's right edge, flat 1280 | phone 915 |
 *   |------|---------------------------|-------------------------------|-----------|
 *   | 22.5 |   6 mm                    | 1222 px                       | 791 px    |
 *   | 23   |  18 mm                    | 1240 px                       | 801 px    |
 *   | 24   |  42 mm                    | 1277 px (3 px to spare)       | 822 px    |
 *   | 30   | 178 mm                    | 1591 px (out of frame)        | 1002 px   |
 *
 * Measured, not assumed: the gap is between the convex footprints of
 * `commander-table.glb`'s table as the room hangs it (`pedestalYaw`, scaled
 * to `TABLE_TOP`), two neighbours at `HOLO_REACH`; the edges are every
 * vertex of FF-TV's table projected through the resting camera.
 * `hangar-tables.test.ts` holds the gap against the GLB, and
 * `hangar-doors.test.ts` the frame against the camera. The label planes
 * (0.54 m) now overlap their neighbours' at the edges, where they are
 * transparent; what they DRAW keeps apart, because a line stays within half
 * the spacing of its own centre (0.25 m at the labels' 1.25 m): the widest,
 * QUICK RACE's *Ring Attack on random course* with its backing, reaches
 * about 0.20 m. The gaze windows keep a dead band between them
 * (21.2 degrees between neighbours' centres along the pitched sightline,
 * against a 19.3-degree window), so looking between two still selects
 * neither; but it is 1.9 degrees, where the 30-degree steps leave 8.3, so a
 * glance across the doors goes from one table straight to the next.
 */
export const DOORS_BEARING_STEP = (23 * Math.PI) / 180

/**
 * DEV-620: how far left of the resting pointer the CREDITS table stands, off
 * the first step's left end: 80 degrees, QUICK RACE being at 23. Matt,
 * 2026-10-03: *"add a credits table in the hangar"*; the brief: do not crowd
 * the first step. So it stands wholly outside a flat 1280 x 720 frame and a
 * Pixel 7's in landscape at rest, the four doors keep the frame as DEV-578
 * laid it, and a turn to the left finds it. Measured, every vertex of the
 * hung table projected: at 69 degrees (two steps past QUICK RACE) a sliver
 * of its pedestal stood in the 1280 frame's left edge, at 75 and 77 in the
 * phone's (its lens is wider); 78 is the first whole degree clear of both,
 * and 80 keeps two to spare. `hangar-tables.test.ts` holds it.
 */
export const OPTIONS_DOOR_OFF = (80 * Math.PI) / 180

/**
 * The first step's bearings: CREDITS first (`doorCards` puts it there), off
 * the left end; the rest laid by {@link tableBearings} at
 * {@link DOORS_BEARING_STEP} exactly as DEV-578 laid them, SINGLE PLAYER still
 * under the resting pointer.
 */
export const doorsBearings = (count: number): number[] => {
  // DEV-858: OPTIONS is the arc's first table, not a table 80 degrees off the
  // left end, and the arc is symmetric about the eye line like every step: with
  // all five doors up they stand at -2, -1, 0, +1, +2 steps and FLY is on it.
  return tableBearings(count, DOORS_BEARING_STEP)
}

/**
 * DEV-620: the CREDITS step's bearings. It opens where its table stood: the
 * first credit on CREDITS' own bearing, where the player is looking when they
 * press it, and the rest at the doors' step to its right, back toward the
 * resting pointer (the first photograph laid them at the doors' bearings and
 * the step opened 57 degrees to the right of the eye). The BACK plate is the
 * room's, in the lap.
 */
export const creditsBearings = (count: number): number[] =>
  Array.from(
    { length: Math.max(0, count) },
    (_, i) => SEAT_REST_BEARING - OPTIONS_DOOR_OFF + i * DOORS_BEARING_STEP,
  )

/**
 * DEV-606 met DEV-620: the seat's look YAW a new step starts on, radians, as
 * the flat seat look counts it (0 is rest; positive turns left, three's yaw,
 * and a bearing left of rest is a smaller one).
 *
 * DEV-606 returns the look to rest on a new step because a step lays its
 * tables around the resting look. The CREDITS step is the one that does not:
 * it is laid from CREDITS' own bearing ({@link creditsBearings}), so a rest
 * there opened it with the first credit 80 degrees to the left and two of its
 * four tables out of a flat frame. Its start is where its arc is laid, which
 * is where the player was looking when they pressed CREDITS; every other step
 * starts at rest, as DEV-606 has it.
 */
export const stepStartYaw = (view: HangarView | null, firstRest: number | null = null): number =>
  firstRest !== null && view !== null && FIRST_VISIT_REST_STEPS.has(view)
    ? SEAT_REST_BEARING - firstRest
    : view === 'credits' || view === 'options'
      ? SEAT_REST_BEARING - (creditsBearings(1)[0] ?? SEAT_REST_BEARING)
      : 0

/**
 * DEV-884 (the 2026-10-09 playtest, row 12): the steps a FIRST visit rests on
 * the FIRST table of, not on the one under the resting pointer. The flight
 * plan step rests on Ring Attack (the middle of Flight School, Ring Attack,
 * Free Flight) while the note says *new here? start here* on Flight School, and
 * the difficulty step rested on the right-hand rank: a new player nearly picked
 * PROFESSIONAL. Both steps list the gentle choice first (`teachersLeft`; the
 * chain order puts beginner first), so "first table" is the one to rest on.
 * A returning player (any best on record) rests where they always did.
 */
export const FIRST_VISIT_REST_STEPS: ReadonlySet<HangarView> = new Set<HangarView>([
  'modes',
  'ranks',
])

/**
 * The bearing the seat should rest on at `view`: the first occupied position of
 * its arc on a first visit's {@link FIRST_VISIT_REST_STEPS}, else null (the
 * step's own rest).
 */
export const firstVisitRestBearing = (
  view: HangarView,
  firstVisit: boolean,
  bearings: readonly number[],
  slots: readonly unknown[],
): number | null => {
  if (!firstVisit || !FIRST_VISIT_REST_STEPS.has(view)) return null
  const at = slots.findIndex((slot) => slot !== null && slot !== undefined)
  return at >= 0 ? (bearings[at] ?? null) : null
}

/**
 * The bearings the step HEADER centres over: the arc the step stands in front
 * of you. On the first step that is the four doors, not CREDITS off the left
 * end, so the header stays over them (DEV-620).
 */
export const headerBearings = (view: HangarView, bearings: readonly number[]): readonly number[] =>
  view === 'doors' && bearings.length > 1 ? bearings.slice(1) : bearings

/**
 * The steps whose arc is laid CENTRED on the resting pointer rather than with a
 * table under it: the flight plans, and only them (DEV-379 follow-up).
 *
 * Matt, 2026-09-25, of the plan step with Flight School at its right-hand end:
 * *"move flight school to the middle. otherwise this is ok"*. Moving it to a
 * middle SLOT was `teachersMiddle` (now `teachersLeft`, DEV-419, below); this
 * was the other half. A four-wide arc laid
 * by {@link tableBearings} runs -30 / 0 / +30 / +60 degrees from the resting
 * aim, and on a flat 16:9 screen (70 degrees vertical, about 51 each side) a
 * table's centre at +60 is out of frame — whichever plan stands there. Centred,
 * the four run -45 / -15 / +15 / +45 from the resting aim: all four in frame,
 * and all four inside the ±45 degrees a seated head turns through comfortably
 * (the header's figure), where +60 was not.
 *
 * What it gives up is a table under the resting pointer, `SEAT_REST_BEARING`'s
 * reason — and on this step that was already gone for the aircraft that had
 * four plans: the HoverJet does not fly Target Practice, so the position under
 * its resting pointer was a gap (#41d) before this moved anything. Every other
 * step keeps {@link tableBearings}: *"otherwise this is ok"*.
 *
 * **Dormant since DEV-419.** Matt, 2026-09-26, reversed the middle: *"flight
 * school should be the left-most table. in order -> flight school, ring attack,
 * free flight"*, for the HoverJet only. The plan arc is now the open aircraft's
 * own plans (`pagesFor`), so the HoverJet's is three wide — and for an odd
 * count this rule and {@link tableBearings} lay the same arc, Ring Attack under
 * the pointer. It stays for the argument it was made on, which is still true of
 * an EVEN count: the day an aircraft flies four plans, a `tableBearings` arc
 * would stand the fourth at +60 from the resting aim, out of a flat frame.
 *
 * **DEV-565 woke it on the first step.** QUICK RACE made the doors four wide
 * on a preview build (SINGLE PLAYER, QUICK RACE, MULTIPLAYER, FF-TV), and laid
 * by `tableBearings` FF-TV stood at +60 from the resting aim, its centre past
 * the edge of a flat 1280 frame (about 51 degrees each side) and of a phone in
 * landscape (about 57). Centred, the four stand at -45 / -15 / +15 / +45, all
 * in frame, and the resting pointer falls between QUICK RACE and MULTIPLAYER.
 * A release build then had no TV (`PREVIEW_ONLY` until DEV-578), so its doors
 * were three, which both rules lay alike.
 *
 * **And Matt put it back to sleep there** (2026-10-02: *"single player under
 * the pointer"*). The doors are laid by {@link tableBearings} again, with
 * QUICK RACE moved to SINGLE PLAYER's left (`doorCards`), so SINGLE PLAYER is
 * the home table on three and on four. What that cost on a preview build's
 * four was the reason above: FF-TV stood at +60, a head turn past the edge of
 * a flat frame. **DEV-578 paid it back** when TV shipped and release became
 * four too: the doors are laid by `tableBearings` at their own, narrower
 * {@link DOORS_BEARING_STEP}, so all four stand in frame with SINGLE PLAYER
 * still under the pointer.
 */
export const CENTRED_STEPS: ReadonlySet<HangarView> = new Set<HangarView>(['modes'])

/**
 * The bearings of `count` positions on `view`'s arc — the one function the room
 * (`applyPage`) and the plain-value walk (`hangarArcs`) both lay a
 * step out with, so the two cannot disagree about where a plan stands.
 *
 * {@link tableBearings} on every step but the {@link CENTRED_STEPS}, which are
 * laid symmetrically about {@link SEAT_REST_BEARING}. For an ODD count the two
 * rules give the same arc — the middle position IS under the pointer — so a
 * three-plan arc (the 2016 thirteen alone) is exactly the one it always was.
 *
 * DEV-578: the first step (`doors`) keeps `tableBearings`' home under the
 * pointer at its own {@link DOORS_BEARING_STEP}.
 */
export const stepBearings = (view: HangarView, count: number): number[] => {
  if (view === 'doors') return doorsBearings(count)
  if (view === 'credits' || view === 'options') return creditsBearings(count)
  if (!CENTRED_STEPS.has(view)) return tableBearings(count)
  const n = Math.max(0, count)
  return Array.from(
    { length: n },
    (_, i) => SEAT_REST_BEARING + (i - (n - 1) / 2) * TABLE_BEARING_STEP,
  )
}

/**
 * How many FIXED positions a step's arc has: one per key it offers, capped at
 * what fits in front of a seated head.
 *
 * At least one, so a step whose content has not landed yet still has an arc to
 * be empty on rather than a zero-length one that `placeHeader` has to special
 * case.
 */
export const slotCount = (order: readonly string[]): number =>
  Math.max(1, Math.min(order.length, TABLES_PER_PAGE))

/**
 * Which page holds the first item satisfying `match`, or -1.
 *
 * Over FIXED SLOT pages, so it steps over the empty positions. Used to open the
 * last step on the page carrying the mission you arrived in — the page, not the
 * position: the position is the environment's and never moves.
 */
export const pageHolding = <T>(
  pages: readonly (readonly (T | null)[])[],
  match: (item: T) => boolean,
): number => pages.findIndex((page) => page.some((item) => item !== null && match(item)))

/**
 * A table's base, in the hangar's local space.
 *
 * Three looks down −z at yaw 0, so a bearing to the RIGHT is +x and −z.
 */
export const tableLocal = (
  spec: HangarSpec,
  bearing: number,
): { x: number; y: number; z: number } => {
  const seat = seatEyeLocal(spec)
  return {
    x: seat.x + Math.sin(bearing) * HOLO_REACH,
    y: spec.floorY,
    z: seat.z - Math.cos(bearing) * HOLO_REACH,
  }
}

/** Where a table's gaze sphere is centred, in the hangar's local space. */
export const tableGazeLocal = (
  spec: HangarSpec,
  bearing: number,
): { x: number; y: number; z: number } => {
  const base = tableLocal(spec, bearing)
  return { x: base.x, y: base.y + TABLE_TOP + GAZE_LIFT, z: base.z }
}

/** DEV-858: a page plate's bearing off the room's forward: the eye's resting line, then `side` times {@link ARROW_BEARING}. */
export const arrowBearing = (side: -1 | 1): number => SEAT_REST_BEARING + side * ARROW_BEARING

/** A page plate's centre, in the hangar's local space. `side` is -1 or +1. */
export const arrowLocal = (spec: HangarSpec, side: -1 | 1): { x: number; y: number; z: number } => {
  const seat = seatEyeLocal(spec)
  return {
    x: seat.x + Math.sin(arrowBearing(side)) * ARROW_REACH,
    y: spec.floorY + ARROW_HEIGHT,
    z: seat.z - Math.cos(arrowBearing(side)) * ARROW_REACH,
  }
}

/**
 * Which way the chair faces, as a yaw in the hangar's local space.
 *
 * ── A yaw is the NEGATIVE of a bearing, and that is the whole content ────
 *
 * Three looks down −z at yaw 0, and `rotation.y = ψ` sends that forward to
 * `(-sin ψ, 0, -cos ψ)`. A table at BEARING θ sits at `(+sin θ, ·, -cos θ)`
 * from the seat — see `tableLocal`, which is where the +x/−z convention is
 * written down. So looking at it is `ψ = -θ`, and every sign error in this file
 * is that minus.
 *
 * The single-table build had it: a table 0.52 m to the right of a 1.45 m reach
 * is bearing +19.7 degrees and its `seatYawLocal` returned **-19.7**. This is
 * the same relation with the arc's home bearing in it, which puts the resting
 * pointer on a table rather than in the gap between two.
 *
 * Not asserted as a quaternion anywhere: `tests/unit/level-select.test.ts`
 * builds the forward vector from three's own documented convention and checks
 * that it LANDS on the home table's gaze sphere, and `tests/e2e/menu-screen.spec.ts`
 * boards from the resting aim in a real browser. A sign that is wrong fails
 * both by missing, not by disagreeing with a number I chose.
 */
export const seatYawLocal = (): number => -SEAT_REST_BEARING

/**
 * And how far DOWN, in radians. Negative is down.
 *
 * A table is below the eye — that is what makes it a table — so a seat aimed
 * only in yaw points straight over the top of it and the nose pointer never
 * touches anything. The first build did exactly that: the chair faced the right
 * direction, the pointer sailed 0.55 m above the target, and every A press did
 * nothing with no way to find out why.
 *
 * 22.8 degrees down, at the height the gaze spheres are centred — and every
 * table is at the same horizontal reach, so this one pitch aims at all four.
 * Together with {@link seatYawLocal} it lands on the home table's gaze sphere
 * dead centre.
 */
export const seatPitchLocal = (): number =>
  Math.atan2(TABLE_TOP + GAZE_LIFT - SEAT_EYE_HEIGHT, HOLO_REACH)

/**
 * Nearest sphere a ray enters, or -1.
 *
 * Pure, and in whatever frame the caller hands it — `gaze()` uses world space,
 * the tests use the seat's own. NEAREST by perpendicular miss rather than first
 * hit: with a dead band this only matters when two windows overlap, and it is
 * the behaviour you want if a future page ever packs them tighter.
 *
 * Behind the eye is not hovered, whatever the perpendicular distance — the
 * original one-table test had that and it is the difference between a menu and
 * a menu that also works facing the wall.
 */
export const pickNearestSphere = (
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  centres: readonly (readonly [number, number, number])[],
  radius: number,
  /** How many of `centres` are live. Lets the caller reuse one array forever. */
  count: number = centres.length,
): number => {
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-9) return -1
  const ux = dx / len
  const uy = dy / len
  const uz = dz / len
  let best = -1
  let bestMiss = radius
  for (let i = 0; i < Math.min(count, centres.length); i++) {
    const c = centres[i] as readonly [number, number, number]
    const tx = c[0] - ox
    const ty = c[1] - oy
    const tz = c[2] - oz
    const along = tx * ux + ty * uy + tz * uz
    if (along <= 0) continue
    const miss = Math.hypot(tx - ux * along, ty - uy * along, tz - uz * along)
    if (miss <= bestMiss) {
      bestMiss = miss
      best = i
    }
  }
  return best
}

/**
 * Step `index` by `delta` pages, wrapping in both directions.
 *
 * Its own function because `%` is not modulo in JavaScript: `-1 % 4` is `-1`,
 * so the naive form makes the page before the first unreachable and indexes an
 * array with a negative number, which is `undefined` and a blank arc.
 */
export const wrapPage = (index: number, delta: number, count: number): number =>
  count <= 0 ? 0 : (((index + delta) % count) + count) % count

/**
 * The dwell rule for the page plates, as a function of nothing but its inputs.
 *
 * **Trap: `update()` runs every frame of the game, `gaze()` only while the menu
 * is up.** `boot/app.ts` calls `hangar.update(frameSeconds)` unconditionally and
 * `hangar.gaze(...)` only when `screen === 'menu'`. Without `gazed`, the dwell
 * keeps filling for the whole mission against the aim the last menu frame left
 * behind, and pages turn behind your back — which is trap 19's shape exactly: a
 * value left by one call and read by a later one that has no business seeing it.
 * The guard there was *"step a SECOND one and assert the first did not move"*;
 * here it is *"run a frame with no gaze and assert the dwell is zero"*.
 *
 * Returns the dwell now standing and whether this frame turned a page. A turn
 * consumes the dwell, so holding the plate pages once and then once more a full
 * `PAGE_DWELL_SECONDS` later, rather than every frame after the first.
 */
export const advanceDwell = (
  held: number,
  seconds: number,
  onPlate: boolean,
  gazed: boolean,
): { held: number; turn: boolean } => {
  if (!gazed || !onPlate) return { held: 0, turn: false }
  const next = held + seconds
  return next >= PAGE_DWELL_SECONDS ? { held: 0, turn: true } : { held: next, turn: false }
}

/**
 * What a lap plate does when you take it. `null` is a plate with nothing to do.
 *
 * ── Why this is out here, and pure ───────────────────────────────────────
 *
 * Because it decides whether there is a WAY OUT of a place, and that is the one
 * rule in the room that must not depend on how many pages the place happens to
 * have. Inside the closure it would be reachable only from Playwright — a DOM,
 * a GPU and a real browser to answer "is BACK up?" — and the case that matters
 * is the boring one nobody would take a screenshot of: a world with a single
 * course, where nothing is paged and the only plate on screen is the exit.
 *
 *   left   BACK, on every step but the first — ALWAYS. Page-previous on the
 *          aircraft step.
 *   right  Page-next, on any step.
 *
 * Both page roles vanish at a single page, which today is always: two aircraft,
 * three flight plans, three ranks and four places all fit one arc. The asymmetry
 * costs nothing — `wrapPage` wraps, so "next" alone reaches every page a
 * fourteenth mission could add — and it buys BACK a fixed home, which is the
 * plate a player takes on every single visit.
 */
export type PlateAction =
  | { readonly kind: 'page'; readonly delta: -1 | 1 }
  | { readonly kind: 'back' }

export const plateAction = (
  side: -1 | 1,
  view: HangarView,
  pageCount: number,
  /**
   * The steps the room walks (DEV-558): BACK stands on every step that has one
   * behind it in this list, so on a room with DOORS the aircraft step gets it.
   */
  views: readonly HangarView[] = HANGAR_VIEWS,
): PlateAction | null => {
  if (side < 0 && viewBehind(view, views) !== null) return { kind: 'back' }
  if (pageCount <= 1) return null
  return { kind: 'page', delta: side }
}

/**
 * The step behind `view` in `views` — the room's live list, all five steps by
 * default — or null on the first one. 2016's `GoBack()`.
 */
export const viewBehind = (
  view: HangarView,
  views: readonly HangarView[] = HANGAR_VIEWS,
): HangarView | null => views[views.indexOf(view) - 1] ?? null

/**
 * The course a DIFFICULTY press boards directly, or null to open its PLACE
 * step. DEV-608.
 *
 * The 2026-10-03 persona playtest's new player pressed six tables to reach
 * the first lesson, and the last, PLACE, held one table: MESA CANYON. Every
 * Flight School rank holds exactly one lesson, so on a plan that TEACHES a
 * one-course rank boards from the rank. Only there: a Ring Attack, Target
 * Practice or Free Flight rank with one course keeps its PLACE step, which
 * shows the island, the best and the ghost before you commit.
 */
export const boardsFromRank = (rank: {
  readonly mode: GameMode
  readonly missions: readonly MissionCard[]
}): MissionCard | null =>
  MODES[rank.mode].teaches && rank.missions.length === 1 ? (rank.missions[0] ?? null) : null

/**
 * The small line over BACK's word on its plate (DEV-605). The word itself is
 * still the step it goes to, never "BACK" (below); this line says it is a way
 * back, because the first step's word is the title's START.
 */
export const BACK_KICKER = 'BACK TO'

/** Flow A (UX-PASS 2026-10-08): said once, under the place step's header, where marks stand. */
export const PLACE_CAPTION = 'LOOK AT, CLICK OR TAP A MARK TO PICK THE DIFFICULTY'

/**
 * DEV-884 (the 2026-10-09 playtest, row 16): one entry of the place step's
 * LEGEND, which says what each mark means: the ski-map shape, in its own
 * colour, and the difficulty's name. Built from the cards on the page, never a
 * list in code (hard rule 6), easiest first, one entry a rank.
 */
export interface MarkLegendEntry {
  readonly index: number
  readonly shape: SkiMarkShape
  readonly name: string
}

/** The legend a page of place tables needs: its courses' ranks, deduplicated, easiest first. */
export const markLegend = (
  courses: readonly { readonly index: number; readonly name: string }[],
): readonly MarkLegendEntry[] => {
  const seen = new Map<number, string>()
  for (const c of courses) if (!seen.has(c.index)) seen.set(c.index, c.name)
  return [...seen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, name]) => ({ index, shape: skiMarkShape(index), name }))
}

/**
 * The word on the BACK plate: the step it takes you TO, never "BACK".
 *
 * On a four-step menu "BACK" asks the player to remember which of three
 * questions they answered last, and the room already knows.
 *
 * It is the HEADER of the step you land on, not the thing you chose there —
 * `DIFFICULTY` from the courses, `FLIGHT PLAN` from the ranks, `AIRCRAFT` from
 * the modes. The first draft put the aircraft's own name on the courses plate
 * (`HOVERJET`) and a screenshot settled it: on a page headed **HOVERJET ·
 * INTERMEDIATE**, a plate reading **HOVERJET** looks like it goes to the
 * aircraft, which is two steps up. Matching the header you will arrive at makes
 * the pair readable without remembering anything.
 *
 * **Out here rather than in `createHangar`'s closure since DEV-221**, for the
 * reason {@link plateAction} is: the checklist's §5 asserts this table in prose
 * — *"its word is the step it takes you to — `DIFFICULTY`, `FLIGHT PLAN`, then
 * `AIRCRAFT`"* — and inside the closure that sentence could only be checked by
 * a human in a headset reading three plates. It had no instrument at all when
 * DEV-203 added the fourth step, which is why it is the one sentence DEV-203
 * falsified that nothing caught.
 */
export const BACK_WORDS: Readonly<Record<HangarView, string>> = {
  // DEV-858: the first step has no header since DEV-832 took START off it, so
  // the plate that returns to it says BACK TO THE HANGAR (Flow A; it read BACK TO START).
  doors: 'THE HANGAR',
  multiplayer: 'MULTIPLAYER',
  // DEV-832: the OPTIONS step, behind the first step's OPTIONS table, and
  // DEV-620's credits behind that.
  options: 'OPTIONS',
  credits: 'CREDITS',
  vehicles: 'AIRCRAFT',
  variants: 'VARIANT',
  modes: 'FLIGHT PLAN',
  ranks: 'DIFFICULTY',
  courses: 'PLACE',
}

/**
 * The word on `view`'s BACK plate, or **null on the step that has none**.
 *
 * Written off {@link viewBehind} rather than as three ternaries, so a fifth step
 * cannot get a plate that names the wrong place — and the null is the same
 * predicate {@link plateAction} uses for whether the plate is drawn at all, so
 * "is there a BACK plate" and "what does it say" cannot disagree. §5 of the
 * orientation lesson: *two things that must stay equal should be the same
 * object.*
 */
export const backWordFor = (
  view: HangarView,
  views: readonly HangarView[] = HANGAR_VIEWS,
): string | null => {
  const behind = viewBehind(view, views)
  return behind === null ? null : BACK_WORDS[behind]
}

/** How far towards the seat a label stands from its table's axis, in metres. */
const LABEL_TOWARDS_SEAT = 0.18

/**
 * The yaw that turns a panel at BEARING θ to face the seat.
 *
 * **The minus is the whole function, and it shipped wrong for one screenshot.**
 * A table at bearing θ sits at `(+sin θ, ·, -cos θ)` from the seat, so the
 * direction back to the seat is `(-sin θ, ·, +cos θ)`; three's `rotation.y = ψ`
 * sends a plane's face (its local +z) to `(+sin ψ, 0, +cos ψ)`, so ψ = **-θ**.
 *
 * Built the other way the two inner labels are 30 degrees askew — legible, so
 * they read as a font problem — and **the outer two are 90 degrees off and
 * vanish entirely**, which reads as "the label did not render". That is the
 * orientation lesson exactly: invisible where the geometry is nearly symmetric
 * (±15) and obvious where it is not (±45), and caught from a PICTURE rather
 * than by any of 1,134 green tests. The single-table build had the sign right —
 * `atan2(seat.x - holo.x, seat.z - holo.z)` is -θ — and it was lost in the
 * rewrite, which is §5's *"a duplicated constant cannot tell you it has
 * drifted"* wearing a trigonometric hat.
 *
 * Its own exported function so the tables and the page header cannot disagree,
 * and so `level-select.test.ts` can check it as a DIRECTION — "the face points
 * at the chair" is true independently of what I believed the sign was, where
 * `expect(yaw).toBe(-bearing)` is that belief written twice.
 */
export const labelYaw = (bearing: number): number => -bearing

/**
 * Where a course's medal stands, relative to its table's base (DEV-113).
 *
 * On the SEAT side of the table, the way the label is: 2016's slot sits at the
 * table's edge opposite the island's centre, and on a table whose island can
 * reach 0.15 m the seat side is the one side a 0.077 m emblem cannot be hidden
 * behind a peak from. `placement` is `medalPlacement(MODEL_SIZE)` — the 2016
 * offsets as a ratio of the table — and this only turns "out" into a direction.
 */
export const medalLocal = (
  bearing: number,
  placement: MedalPlacement,
): { x: number; y: number; z: number } => ({
  x: -Math.sin(bearing) * placement.out,
  y: TABLE_TOP + placement.lift,
  z: Math.cos(bearing) * placement.out,
})

/**
 * Where a table's diorama sits: its waterline, above the table's top. The
 * medal's rest height is measured against this, so it is a name and not a
 * literal in two places.
 */
export const DIORAMA_LIFT = TABLE_TOP + 0.06

/**
 * DEV-579: the solid under every table's island (`DioramaBody`). Matt,
 * 2026-10-03: *"how the edge just stops and we can see under the diorama,
 * making it look wafer-thin."*
 *
 * DEV-627: a PUCK. Matt, 2026-10-04: *"remove the tapered bottom from the
 * underside of the dioramas. a simple flat cap works."* Until then the wall
 * leaned in from the rim to a foot on the inset's floor, a bowl seated in the
 * table. Now it drops straight all the way down (`foot` is the disc's own
 * radius, so the wall is a drum) and a flat cap closes it, {@link
 * TABLE_BODY_DEPTH} under the waterline: clear of the table's top, so the
 * highlight square (DEV-574) still shows under the puck's near edge from the
 * chair, on the selected table at its {@link SELECTED_ISLAND_SCALE}.
 */
export const TABLE_BODY_LIP = 0.014
/**
 * DEV-627: the puck's depth under the waterline, metres. DEV-843 (Matt,
 * 2026-10-08, playtest item 63) made it FLUSH: the cap rests on the table's top
 * (it stood 2.5 cm over it, 0.035 deep), so the depth is the whole of the
 * island's lift, and a selected puck, grown by {@link SELECTED_ISLAND_SCALE}, sinks
 * 6 mm into the top instead of floating. The earlier note: it stood 2.5 cm
 * over the table's top at rest (2.15 cm selected). Deeper and the chair loses
 * the highlight square's near side under the selected puck: the sightline to
 * it passes under the cap's front edge with about a centimetre to spare
 * (`diorama-body.test.ts`). **A number to argue with.**
 */
export const TABLE_BODY_DEPTH = DIORAMA_LIFT - TABLE_TOP
/** The selected table's island scale (DEV-140's hover growth): one name for both places that set it. */
export const SELECTED_ISLAND_SCALE = 1.1
/**
 * DEV-627: the table top's frame, measured off 2016's table GLB in its own
 * units (`hangar-tables.test.ts`): the flat blue frame round the inset, at
 * `TABLE_INSET_RAW.frame`, is +-0.483 across and -0.450 to 0.514 along its z.
 */
export const TABLE_FRAME_RAW = { half: 0.483, zMin: -0.45, zMax: 0.514 } as const
/**
 * DEV-627: the table's bound, metres from its axis: the NEAREST side of its top
 * frame, 0.217 m. The pedestal turns a quarter at a time to keep a side to the
 * seat (`pedestalYaw`), so any of its sides may face any way; a disc inside
 * the nearest is inside the table at every turn.
 */
export const TABLE_BOUND =
  Math.min(TABLE_FRAME_RAW.half, -TABLE_FRAME_RAW.zMin, TABLE_FRAME_RAW.zMax) * TABLE_ART_SCALE
/**
 * DEV-627: how much of a SEA table's radius, from the rim in, is open sea. Matt,
 * 2026-10-04: *"scale the oceans up just a bit since the terrain pokes out of
 * the sides of the ocean"*. On Simonet and Kauai the islands ran to the disc's
 * edge, and the wall under them was earth where the rest of the rim was the
 * water's blue section. Now the land is drawn inside 92 % of the radius, eased
 * all the way down to the waterline at that circle, and the sea runs on to the
 * rim all round, so every edge of a sea table is water. A table with no sea
 * (alpine, the canyon) is unchanged.
 */
export const TABLE_SEA_RING = 0.08
/**
 * DEV-579 follow-up: the land eased down over the outer quarter of the disc to
 * a tenth of its height at the rim (`DioramaEase`). Matt, 2026-10-03: *"yes,
 * ease the alpine and canyon edges plz"*. Chosen on photographs over band 0.15
 * keep 0.15 (a steep ring left at the rim) and band 0.35 keep 0.25 (more of the
 * land flattened, a taller wall): alpine's rim wall comes down from 157 mm to
 * 16 mm and the canyon's from 150 mm to 15 mm, and the inner three quarters of
 * every disc do not move. Pinned in `diorama-body.test.ts`.
 */
export const TABLE_EASE = { band: 0.25, keep: 0.1 } as const
export const TABLE_BODY = {
  depth: TABLE_BODY_DEPTH,
  lip: TABLE_BODY_LIP,
  // A drum: the foot is the disc's own radius, so the wall never leans in.
  foot: MODEL_SIZE / 2,
  ease: TABLE_EASE,
  seaRing: TABLE_SEA_RING,
} as const

/**
 * Air between the emblem's lowest vertex and the island's highest under it,
 * metres. Two facets of the miniature (`MODEL_SIZE / 56` is one), so a medal
 * that has been lifted still reads as FLOATING over the peak rather than
 * resting on it (DEV-140).
 */
export const MEDAL_CLEARANCE = (MODEL_SIZE / 56) * 2

/**
 * The medal's rest height over its table, table-local (DEV-140).
 *
 * 2016's slot stood at a fixed height, and 2016's miniature never reached it.
 * The port's island is exaggerated 1.35x and Simonet's peaks come to 0.15 m —
 * above the 0.098 m the slot puts the emblem's ORIGIN at, and the emblem hangs
 * below its origin — so on the tables where a peak stands under the seat-side
 * edge the emblem was drawn through rock. Matt, 2026-09-16: *"level select
 * medals should float above the terrain."*
 *
 * `restY` is the 2016 height (`medalLocal(...).y`); `peak` is the island's
 * highest vertex within the medal's swept footprint, in the DIORAMA's frame
 * (`-Infinity` for none, or no diorama yet); `bottom` is how far the emblem's
 * lowest vertex hangs below the medal's origin (negative, from the mesh). The
 * medal is never LOWERED: a table whose island is flat under it keeps 2016's
 * ratio exactly.
 */
export const medalRestY = (
  restY: number,
  dioramaLift: number,
  peak: number,
  bottom: number,
): number => {
  if (!Number.isFinite(peak)) return restY
  return Math.max(restY, dioramaLift + peak + MEDAL_CLEARANCE - bottom)
}

/** Where a label stands, relative to its table's base. */
export const labelLocal = (
  bearing: number,
  height: number,
): { x: number; y: number; z: number } => ({
  x: -Math.sin(bearing) * LABEL_TOWARDS_SEAT,
  y: height,
  z: Math.cos(bearing) * LABEL_TOWARDS_SEAT,
})

/**
 * Turn a panel to face the seat, and stand it clear of the model.
 *
 * `YXZ` order so the backwards tilt happens about the panel's OWN right axis
 * after the turn. Under three's default `XYZ` the tilt is applied about world
 * x, which at ±45 degrees of yaw skews the text in the plane instead of
 * leaning it back.
 */
const faceSeat = (label: THREE.Object3D, bearing: number, height: number, tilt = -0.3): void => {
  const at = labelLocal(bearing, height)
  label.position.set(at.x, at.y, at.z)
  label.rotation.order = 'YXZ'
  label.rotation.set(tilt, labelYaw(bearing), 0)
  // DEV-894: a phone's labels are larger (`phone-floor.ts`).
  label.scale.setScalar(phoneUi.on ? LABEL_PHONE_SCALE : 1)
}

/* ═══════════ DEV-420: a place that carries its own difficulty ═══════════ */
//
// Matt, 2026-09-26: *"instead of choosing difficulty and then the terrain, let's
// combine the menu, so we go ring attack > terrain. on each terrain holotable, we
// should indicate difficulty like a ski map (green square, blue circle, black
// diamond). the changing difficulty should change which path is drawn on the
// terrain."* And, asked where the marks go: *"vertically aligned on the right
// side of the table, floating above the terrain. looking up at the icon would
// change the path to indicate a different route. should be green on top, blue
// mid, black on bottom."*
//
// So for a plan whose mode row says `difficultyOnPlace` (Ring Attack), the rank
// step is not walked: the plan opens straight onto its PLACES, one table per
// environment, and each table stands a row of ski-map marks, one per course
// the plan flies there, easiest on the left (DEV-626: along the table's front).
// Looking at a mark PICKS it: the table
// draws that course's route (DEV-354 took routes off the level tables; this
// puts back one, the picked one) — and the pick stays when you look away, so a
// press on the table or on the mark boards the course you are looking at.
//
// Looking picks, pressing boards. That keeps the room's one rule — *dwell is
// for navigation, never for selection* — because a pick moves nothing but a
// line on a model; only a press launches.

/**
 * One PLACE on a step that carries its difficulty (DEV-420): an environment,
 * and every course the open plan flies there, easiest first.
 */
export interface PlaceCard {
  /** Which table this is, for the room's picks: the environment, or `env#2` for a spill. */
  readonly key: string
  readonly environment: string
  readonly environmentName: string
  /** The courses here, in the rank order, at most one per rank. */
  readonly courses: readonly MissionCard[]
}

/**
 * The places a plan's courses stand on, with each place's courses in the RANK
 * order (`ranks`, the global one: 2016's chain, easiest first).
 *
 * **Nothing can be hidden** (`fixedPages`' second property, and the mission
 * index's standing rule). Two courses in one place at one rank — which no
 * shipped content has, and a fourteenth JSON could — cannot share a mark, so the
 * second makes a second place card for the same environment, which `fixedPages`
 * spills onto the next page at the same position.
 */
export const placeCards = (
  courses: readonly MissionCard[],
  ranks: readonly string[],
): readonly PlaceCard[] => {
  const rankOfCard = (c: MissionCard) => {
    const at = ranks.indexOf(c.difficulty)
    return at < 0 ? ranks.length : at
  }
  const byEnvironment = new Map<string, MissionCard[][]>()
  for (const course of courses) {
    const rows = byEnvironment.get(course.environment) ?? []
    let row = rows.find((r) => !r.some((c) => c.difficulty === course.difficulty))
    if (!row) {
      row = []
      rows.push(row)
    }
    row.push(course)
    byEnvironment.set(course.environment, rows)
  }
  const out: PlaceCard[] = []
  for (const [environment, rows] of byEnvironment) {
    rows.forEach((row, n) => {
      const sorted = row
        .slice()
        .sort((a, b) => rankOfCard(a) - rankOfCard(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      out.push({
        key: n === 0 ? environment : `${environment}#${n + 1}`,
        environment,
        environmentName: (sorted[0] as MissionCard).environmentName,
        courses: sorted,
      })
    })
  }
  return out
}

/**
 * Does this place stand difficulty marks (DEV-800)? Only where its plan carries
 * the difficulty on the place (`difficultyOnPlace`); Free Flight's places hold
 * one course each and carry none. Asked of the plan the place's courses run in.
 */
export const placeHasMarks = (place: PlaceCard): boolean =>
  difficultyOnPlace(place.courses[0]?.mode)

/**
 * DEV-626: the difficulty marks stand along the FRONT of a place table, the
 * edge toward the seat, in a row: green at the left edge, blue centred, black
 * at the right edge. Matt, 2026-10-04: *"let's put the difficulty selectors on
 * the front of the locations table, with green on the left edge, blue
 * centered, and black on the right edge"*. (DEV-420 stood them as a column
 * off the table's right side, green on top.)
 *
 * How far toward the seat from the table's axis the row stands, in metres:
 * just proud of the table's front face (the body's half side is 0.242 m and
 * the frame's farthest side 0.248 m, `hangar-tables.test.ts`), so a card is
 * never inside the table. **One of the numbers to argue with.**
 */
export const MARK_FRONT = 0.27
/**
 * How far either side of the table's axis the two outer marks stand, metres:
 * the table's half width (0.242 m) less a card's half width (about 0.035 m
 * when aimed), so green and black sit at its two edges and blue between.
 */
export const MARK_SPREAD = 0.2
/**
 * The row's height over the floor: the table's top less a centimetre, so each
 * card hangs on the table's front just under its lip, below the island's flat
 * cap (DEV-627) and well under the RESTING sightline (22.8 degrees down from
 * the eye; the row is about 31), so turning along the arc picks no mark.
 * `ski-map-place.test.ts` measures every one of these.
 */
export const MARK_FRONT_Y = TABLE_TOP - 0.01
/** A mark's gaze window, metres at the mark: 2.9 degrees, far less than the 9.6 between two. */
export const MARK_GAZE_RADIUS = 0.06

/**
 * Where the mark for the rank at `index` stands, relative to its table's base.
 *
 * "Towards the seat" and "right" are the seat's as it looks at a table at
 * `bearing`: the seat looks along `(sin θ, ·, −cos θ)` (`tableLocal`), so
 * towards it is `(−sin θ, ·, cos θ)` and its right-hand side `(cos θ, ·, sin
 * θ)`. The table group never yaws, so both are worked out here per bearing,
 * as `labelLocal` works out "towards the seat". Rank 0 (green) is left, 1
 * (blue) centred, 2 (black) right.
 */
export const markLocal = (bearing: number, index: number): { x: number; y: number; z: number } => {
  const side = (Math.max(0, index) - 1) * MARK_SPREAD
  return {
    x: -Math.sin(bearing) * MARK_FRONT + Math.cos(bearing) * side,
    y: MARK_FRONT_Y,
    z: Math.cos(bearing) * MARK_FRONT + Math.sin(bearing) * side,
  }
}

/** A mark's position in the hangar's local space: its table's base plus {@link markLocal}. */
export const markGazeLocal = (
  spec: HangarSpec,
  bearing: number,
  index: number,
): { x: number; y: number; z: number } => {
  const base = tableLocal(spec, bearing)
  const at = markLocal(bearing, index)
  return { x: base.x + at.x, y: base.y + at.y, z: base.z + at.z }
}

/**
 * What a table is standing in for. The arc holds one kind at a time.
 *
 * A discriminated union rather than four nullable fields, so "a table showing a
 * flight plan" and "a table showing a course" cannot both be true — which they
 * were for one build, and the symptom was a world table that boarded a ship.
 */
export type TableSlot =
  | { readonly kind: 'vehicle'; readonly vehicle: VehicleCard }
  /** An aircraft variant, with its record on this aircraft (DEV-382). */
  | { readonly kind: 'variant'; readonly variant: VariantCard; readonly table: VariantTable }
  | { readonly kind: 'mode'; readonly mode: ModeCard }
  | { readonly kind: 'rank'; readonly rank: RankCard }
  | { readonly kind: 'course'; readonly mission: MissionCard }
  /**
   * A PLACE carrying its difficulty (DEV-420): the last step of a plan whose
   * mode row says `difficultyOnPlace`. Its table boards the course it has
   * picked; its marks pick.
   */
  | { readonly kind: 'place'; readonly place: PlaceCard }
  /**
   * A DOOR (DEV-558): Single Player, Multiplayer or FF-TV on the first step,
   * or one of Multiplayer's room choices. The card says what it stands.
   *
   * (Until DEV-560 the union also held `empty`, the dead plate: a position the
   * step defined and the content had nothing for, drawn greyed. Matt,
   * 2026-10-01: *"don't show greyed out tables"*. A step's arc is now cut to
   * what it holds, so there is no such position to draw.)
   */
  | { readonly kind: 'door'; readonly door: DoorCard }

/**
 * Can the nose pointer take this table? Every table that stands can (DEV-560
 * took the dead plate, the one that could not, out of the room).
 *
 * Null is the filler: a position on an overflow page that no key owns, or the
 * variant step's padding. Unaimable, and drawn as nothing at all, because it is
 * not a thing that is missing; it is not a thing. `gaze()` builds its sphere
 * list off this, so a null contributes no window.
 */
export const slotAimable = (slot: TableSlot | null): boolean => slot !== null

/**
 * Does this table's subject count as done? It drove the rim's colour until
 * DEV-574, when the rim became the highlight square, drawn only on the
 * selected table and always in the hover ink: so no rim reads it today. Kept
 * as the one definition of "done" for a table, and pinned by
 * `level-steps.test.ts`, for the day a table says it again.
 */
export const slotFlown = (slot: TableSlot | null): boolean => {
  if (slot === null || slot.kind === 'door') return false
  if (slot.kind === 'course') return slot.mission.best !== null
  // A place is a group of courses (DEV-420): done when every one of them is.
  if (slot.kind === 'place')
    return slot.place.courses.length > 0 && slot.place.courses.every((c) => c.best !== null)
  // A variant is a group too: every course of its aircraft, flown IN it.
  if (slot.kind === 'variant')
    return slot.table.courses > 0 && slot.table.flown === slot.table.courses
  // A GROUP is only finished when every course in it is. "Some of it" is what
  // the label's `flownLine` says in words; the rim is a binary and has to pick
  // the meaning that is still true when you come back.
  const group =
    slot.kind === 'vehicle' ? slot.vehicle : slot.kind === 'mode' ? slot.mode : slot.rank
  return group.missions.length > 0 && group.flown === group.missions.length
}

/**
 * What a table STANDS, by what the table is for. See the header's table.
 *
 *   aircraft  the aircraft itself, turning (DEV-142).
 *   mark      ONE mark for the flight plan, turning: a gate, a pad or an orb
 *             (DEV-354). No island, no course, no craft.
 *   land      a course's island and its craft, and nothing marked on it
 *             (DEV-354). A course, or the rank's signature course.
 *   nothing   a bare table: a door whose card stands nothing (DEV-558).
 *
 * A DOOR stands what its card says (`hangar-doors.ts`): Single Player the
 * aircraft, Multiplayer and Host a Race a gate, FF-TV an orb.
 *
 * **The one branch `applyPage` takes**, so "what goes on a table" is a function
 * of the slot and nothing else, and a test can hold it without a room. The
 * flight-plan step was a `land` table from DEV-203 until DEV-354: it stood its
 * signature course's island under the plan's name, and DEV-313 then drew the
 * plan on the COURSES instead. `tests/unit/level-steps.test.ts` holds this so a
 * plan table cannot grow a course again without an edit somebody makes on
 * purpose.
 */
export type TablePicture = 'aircraft' | 'mark' | 'land' | 'nothing'

export const tablePicture = (slot: TableSlot): TablePicture =>
  // A variant IS an aircraft (AIRCRAFT-VARIANTS §6.2: "a variant is an
  // aircraft, so it stands the aircraft"), and its label carries the difference.
  slot.kind === 'vehicle' || slot.kind === 'variant'
    ? 'aircraft'
    : slot.kind === 'mode'
      ? 'mark'
      : slot.kind === 'rank' || slot.kind === 'course' || slot.kind === 'place'
        ? 'land'
        : slot.door.picture === 'aircraft'
          ? 'aircraft'
          : slot.door.picture === null
            ? 'nothing'
            : 'mark'

/**
 * The id a shape request is keyed on — the course, or the rank's signature —
 * and null for every table that is not {@link tablePicture}'s `land`.
 *
 * **Null for an AIRCRAFT**, which is the whole of DEV-142 at the level of the
 * data: an aircraft table carries the aircraft (`render/holo-ship.ts`), so it
 * asks for no terrain at all. It used to answer with its first course's id —
 * `rookie_01_*` for both aircraft, the same alpine island twice — which is
 * what `game/mission-index.ts` had already promised it would not do: the
 * opening screen was supposed to cost **no height map**, and it cost one
 * before the player had chosen anything. **And null for a flight plan** since
 * DEV-354, for the same reason one step down: it stands a mark, not a place.
 */
export const slotShapeId = (slot: TableSlot): string | null =>
  tablePicture(slot) !== 'land'
    ? null
    : slot.kind === 'course'
      ? slot.mission.id
      : slot.kind === 'rank'
        ? slot.rank.signature.id
        : // A place's island is its first course's — every course there shares
          // it; the ROUTE is the pick's, and the room swaps it (DEV-420).
          slot.kind === 'place'
          ? ((slot.place.courses[0] as MissionCard | undefined)?.id ?? null)
          : null

/**
 * The four SLOT ORDERS — one per step — each derived from the whole content.
 *
 * Global, deliberately, and this is the design decision the whole of DEV-203
 * turns on: the order for the RANKS step is over every difficulty the game
 * offers, **not** over the difficulties of the cell you happen to have opened.
 * That is what makes Beginner's bearing a fact about Beginner rather than about
 * the cell — and it is what leaves Free Flight × Intermediate showing an empty
 * position where Professional would be, instead of sliding Professional left.
 *
 * Computed once when the index lands, off all thirteen cards. See
 * `mission-index.ts`'s `slotOrder` for where the order comes from (2016's own
 * campaign chain) and why it is not a list in code.
 */
export interface SlotOrders {
  readonly vehicles: readonly string[]
  readonly modes: readonly string[]
  readonly ranks: readonly string[]
  readonly courses: readonly string[]
}

/**
 * DEV-399. The aircraft arc with every aircraft 2016 did not ship moved to its
 * LEFT end — the glider, on Anniversary — so 2016's two keep on Anniversary
 * the bearings they have on Classic: the HoverJet under the resting pointer,
 * the JumpSeat one step right. DEV-203's first property, *a key's position does
 * not depend on what else is present*, held across the edition switch.
 *
 * In the chain's order the glider would come THIRD (it is outside the chain,
 * and 2016's own `page_shipSelection` stacks `button_glider_grp` below the
 * JumpSeat's), and `tableBearings(3)` would then put the JumpSeat under the
 * pointer and walk the HoverJet 30 degrees left of where every Classic room and
 * every earlier Anniversary room had it. That is the open call this makes, and
 * it is written down as one (DEVIATIONS DEV-399): newcomers on the left.
 */
const newcomersLeft = (order: readonly string[]): readonly string[] => [
  ...order.filter((vehicle) => !FLEET_2016(vehicle)),
  ...order.filter((vehicle) => FLEET_2016(vehicle)),
]

/** Does this flight plan TEACH? The mode row's own answer; an unknown key does not. */
const teaches = (mode: string): boolean =>
  Object.hasOwn(MODES, mode) && MODES[mode as GameMode].teaches

/**
 * DEV-419. The flight-plan order with every plan that TEACHES — Flight School —
 * at its LEFT end. Matt, 2026-09-26: *"hoverjet flow: flight school should be
 * the left-most table. in order -> flight school, ring attack, free flight"*,
 * and asked whether that is both aircraft: *"just hover jet"*.
 *
 * **This reverses the day before.** The DEV-379 follow-up (Matt, 2026-09-25,
 * *"move flight school to the middle"*) stood it between Target Practice and
 * Free Flight, on a four-wide arc the HoverJet drew with a gap in it where
 * Target Practice stood for the JumpSeat. The other half of this change is in
 * {@link pagesFor}: the plan arc is now the open aircraft's own plans, in this
 * order, so the HoverJet's reads
 *
 *   Flight School · Ring Attack · Free Flight
 *
 * with no gap, Ring Attack under the resting pointer — and the JumpSeat, which
 * flies one plan, keeps its one table. 2016's plans keep 2016's order among
 * themselves (Ring Attack, Target Practice, Free Flight); only the teaching plan
 * moves, to the front.
 *
 * Asked of `teaches`, the one question the mode row answers for everything that
 * treats a lesson differently — never of the row's name (`game/modes.ts`'s
 * standing rule). With no teaching plan in the content, the 2016 thirteen alone,
 * it returns the order it was given.
 */
const teachersLeft = (order: readonly string[]): readonly string[] => {
  const teachers = order.filter(teaches)
  if (teachers.length === 0) return order
  return [...teachers, ...order.filter((mode) => !teaches(mode))]
}

export const slotOrdersFor = (cards: readonly MissionCard[]): SlotOrders => ({
  vehicles: newcomersLeft(slotOrder(cards, (c) => c.vehicle)),
  modes: teachersLeft(slotOrder(cards, (c) => c.mode)),
  ranks: slotOrder(cards, (c) => c.difficulty),
  courses: slotOrder(cards, (c) => c.environment),
})

/** An order with nothing in it — the shape `SlotOrders` takes before the index lands. */
export const NO_SLOT_ORDERS: SlotOrders = {
  vehicles: [],
  modes: [],
  ranks: [],
  courses: [],
}

/**
 * **What is on the arc**: which tables, at which FIXED positions, for the step
 * that is up. `null` is a position this step has nothing for.
 *
 * The whole layout decision, as a pure function. Out here rather than in the
 * closure for the reason `plateAction` is: inside `createHangar` it needs a DOM,
 * a canvas and a GPU to ask a question that involves none of them, and the cases
 * that matter are the ones a browser cannot reach —
 *
 *  * a step with **more keys than the arc holds** (a fifth environment), which
 *    today's content cannot produce;
 *  * a step whose content holds only SOME of the keys the game offers (Ring
 *    Attack flies no Kauai course): since DEV-560 the arc is cut to the keys
 *    it holds, so no position stands for a thing that is not there;
 *  * two items sharing one key, which `fixedPages` spills to a second page
 *    rather than hiding.
 *
 * All three are the growth path hard rule 6 promises works without a code
 * change, and a promise nothing exercises is a promise.
 * `tests/unit/level-steps.test.ts` drives this directly.
 */
export interface StepContent {
  readonly vehicles: readonly VehicleCard[]
  /**
   * The variants of the OPEN aircraft, with their records (DEV-382). Absent or
   * empty above and below the variant step, and on an edition without one.
   */
  readonly variants?: readonly VariantTable[]
  /** The flight plans of the OPEN aircraft. Empty on the first step. */
  readonly modes: readonly ModeCard[]
  /** The ranks of the OPEN (aircraft, mode). Empty above the ranks step. */
  readonly ranks: readonly RankCard[]
  /** The courses of the OPEN (aircraft, mode, rank). Empty above the last step. */
  readonly courses: readonly MissionCard[]
  /**
   * The PLACES of the open plan, where it carries its difficulty (DEV-420):
   * the last step deals these instead of `courses`. Absent or empty otherwise.
   */
  readonly places?: readonly PlaceCard[]
  /** DEV-558: the door tables, on a door step. Absent or empty otherwise. */
  readonly doors?: readonly DoorCard[]
}

/**
 * Every fixed-slot page of the step that is up.
 *
 * ONE implementation of the layout, because `slotsFor` and "how many pages are
 * there" have to agree exactly: the plates appear off the count and the tables
 * are laid out off the rows, and a page plate that pages past the last row would
 * be a menu that can show you an empty arc. §5 of the orientation lesson applied
 * to a page count — *two things that must stay equal should be the same object*.
 */
/** Which of the things each step is choosing between. */
export const VIEW_FACET: Readonly<Record<WalkView, SlotFacet>> = {
  vehicles: 'vehicle',
  variants: 'variant',
  modes: 'mode',
  ranks: 'difficulty',
  courses: 'environment',
}

export const pagesFor = (
  view: HangarView,
  content: StepContent,
  orders: SlotOrders,
): readonly (readonly (TableSlot | null)[])[] => {
  // DEV-558: a door step is its cards, in the card order, left to right.
  if (isDoorView(view)) return doorPages(content.doors ?? [])
  // The variant step is per AIRCRAFT, in its file's order, not a global order
  // over the cards: see `variantPages`.
  if (view === 'variants') return variantPages(content.variants ?? [])
  // ── DEV-560: the arc is the order CUT to what the step holds ────────────
  //
  // Matt, 2026-10-01: *"don't show greyed out tables if they don't have a mode
  // (Kauai showing on ring attack)"*. Until now a key the step's content had
  // nothing for still held its position, drawn as a dead plate (DEV-203), and
  // `reach` (#41d) hid only the keys the open AIRCRAFT could not reach at all.
  // Kauai is reachable by the HoverJet (Free Flight), so on Ring Attack it
  // stood greyed. Now every step does what DEV-419 did for the plans: the
  // global order, cut to the keys its own items carry. The ORDER is still the
  // global one (Alpine, Mesa Canyon, Simonet, Kauai), so a key never jumps past
  // its neighbour; the WIDTH is the step's own, so the row closes up and lays
  // from the resting pointer like every other row.
  const deal = <T>(
    items: readonly T[],
    keyOf: (item: T) => string,
    order: readonly string[],
    wrap: (item: T) => TableSlot,
  ): readonly (readonly (TableSlot | null)[])[] => {
    const held = new Set(items.map(keyOf))
    const own = order.filter((key) => held.has(key))
    // `slotCount(own)` and not `TABLES_PER_PAGE`: how wide a step's arc is, is
    // the RENDER layer's business, and this is the one place that says it.
    // A `null` that survives is a position on an OVERFLOW page that no key owns
    // (two items shared a key): not a thing that is missing, not a thing.
    return fixedPages(items, keyOf, own, slotCount(own)).map((row) =>
      row.map((item) => (item === null ? null : wrap(item))),
    )
  }

  if (view === 'vehicles') {
    return deal(
      content.vehicles,
      (v) => v.vehicle,
      orders.vehicles,
      (vehicle) => ({ kind: 'vehicle', vehicle }),
    )
  }
  if (view === 'modes') {
    // ── DEV-419: the plan arc is the open AIRCRAFT's own row ──────────────
    //
    // Matt's order for the HoverJet is three tables in a row (*"flight
    // school, ring attack, free flight"*), and on the global four-wide order
    // that row had a hole where the JumpSeat's Target Practice stands. The cut
    // above is the same rule, and since DEV-560 every step takes it.
    return deal(
      content.modes,
      (m) => m.mode,
      orders.modes,
      (mode) => ({ kind: 'mode', mode }),
    )
  }
  if (view === 'ranks') {
    return deal(
      content.ranks,
      (r) => r.difficulty,
      orders.ranks,
      (rank) => ({ kind: 'rank', rank }),
    )
  }
  // DEV-420: a plan that carries its difficulty deals PLACES, in the order a
  // course of that place would take.
  const places = content.places ?? []
  if (places.length > 0) {
    return deal(
      places,
      (p) => p.environment,
      orders.courses,
      (place) => ({ kind: 'place', place }),
    )
  }
  return deal(
    content.courses,
    (c) => c.environment,
    orders.courses,
    (mission) => ({ kind: 'course', mission }),
  )
}

/**
 * A door step's pages (DEV-558): its cards in their own order, a row of at most
 * {@link TABLES_PER_PAGE}. No padding: the row lays from the resting pointer as
 * every row does, so the first step's middle table (Multiplayer, of three)
 * stands under it, as Ring Attack does on the plans.
 */
export const doorPages = (
  cards: readonly DoorCard[],
): readonly (readonly (TableSlot | null)[])[] => {
  const pages: TableSlot[][] = []
  // DEV-620: a door step holds the room's five (the first step's CREDITS).
  for (let i = 0; i < cards.length; i += ROOM_TABLES) {
    pages.push(cards.slice(i, i + ROOM_TABLES).map((door): TableSlot => ({ kind: 'door', door })))
  }
  return pages
}

/**
 * One table on the VARIANT step (DEV-382): the variant, and its record on the
 * open aircraft — how many of the aircraft's courses have a time in it, of how
 * many — and whether it is the variant this aircraft last flew, which its
 * label says ("LAST FLOWN") while the arc stays where it is.
 */
export interface VariantTable {
  readonly variant: VariantCard
  readonly courses: number
  readonly flown: number
  readonly lastFlown: boolean
}

/**
 * The variant step's tables for one aircraft, off the cards and its variants.
 *
 * `flown` re-reads each variant's records (`withVariant`), because records are
 * per variant (AIRCRAFT-VARIANTS §6.3) and a card carries one variant's. A pure
 * function of the cards and the store, out here for `pagesFor`'s reason.
 */
export const variantTables = (
  cards: readonly MissionCard[],
  vehicle: string,
  variants: readonly VariantCard[],
  lastFlown: string | null,
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null,
): readonly VariantTable[] => {
  const courses = cards.filter((c) => c.vehicle === vehicle).length
  return variants.map((variant) => ({
    variant,
    courses,
    flown: withVariant(cards, vehicle, variant.id, storage).filter(
      (c) => c.vehicle === vehicle && c.best !== null,
    ).length,
    lastFlown: variant.id === lastFlown,
  }))
}

/**
 * The variant step's pages (DEV-382): the aircraft's FILE order, which is slot
 * order, padded with empty positions so `standard` stands in the MIDDLE of the
 * arc — and therefore under the resting pointer, `SEAT_REST_BEARING`, on every
 * aircraft, whichever of its variants exist yet.
 *
 * AIRCRAFT-VARIANTS §6.2 puts acrobat / standard / speed at −45 / −15 / +15:
 * nimble to the left, 2016 under your nose, fast to the right, the same reading
 * on every aircraft. Three variants in that order ARE that arc with no padding.
 * The padding is for the file that has only one side filled — today, where
 * only `standard` exists (one table at −15), and on the day the JumpSeat has a
 * spider and no overclocked yet, when an unpadded pair would put the spider
 * under the pointer and 2016's seat off to the right. An empty position is
 * drawn as nothing, not as a dead plate: a variant the aircraft does not have
 * is not a thing that is missing (`reachableKeys`'s reasoning, #41d).
 *
 * **No skip.** One variant is a one-table page, Matt's rule for the JumpSeat's
 * one-table mode page: *"a menu that sometimes has three steps and sometimes
 * four teaches the player it has three."*
 */
export const variantPages = (
  tables: readonly VariantTable[],
): readonly (readonly (TableSlot | null)[])[] => {
  if (tables.length === 0) return []
  const at = Math.max(
    0,
    tables.findIndex((t) => t.variant.id === STANDARD_VARIANT_ID),
  )
  const after = tables.length - 1 - at
  const side = Math.max(at, after)
  const row: (TableSlot | null)[] = [
    ...Array.from({ length: side - at }, () => null),
    ...tables.map((table): TableSlot => ({ kind: 'variant', variant: table.variant, table })),
    ...Array.from({ length: side - after }, () => null),
  ]
  const pages: (TableSlot | null)[][] = []
  for (let i = 0; i < row.length; i += TABLES_PER_PAGE)
    pages.push(row.slice(i, i + TABLES_PER_PAGE))
  return pages
}

export const slotsFor = (
  view: HangarView,
  content: StepContent,
  orders: SlotOrders,
  pageIndex: number,
): readonly (TableSlot | null)[] => pagesFor(view, content, orders)[Math.max(0, pageIndex)] ?? []

/* ──────────────────────────────────────────────── the arc, as plain values ── */
//
// DEV-221. Everything below turns the four steps into numbers and strings, for
// the unit tests (and, until DEV-900 removed it, the XR checklist runner's
// probes), and it exists because of a sentence rather than a
// feature: §5 of the XR checklist asserts *"it now appears on three of the four
// steps and its word is the step it takes you to"* about the BACK plate, and
// **nothing checked it.** DEV-203 added the fourth step and falsified two
// checklist sentences; the runner caught the one that happened to have a probe.
//
// The reason it had none is mechanical, not an oversight: the arc's content
// lived inside `createHangar`'s closure, so the only way to ask what is on a
// step was to build a room — a DOM, a canvas and a GPU — to answer a question
// that involves none of them. That is the same argument `plateAction` and
// `pagesFor` are out here for, applied to the step's CONTENT.

/**
 * One POSITION on a step's arc — what is drawn there, and where it stands.
 *
 * A position, not a table: since DEV-203 the arc is a row of fixed slots and a
 * step's width is a property of the CONTENT's key order, not of how many items
 * happen to be present. So there is one of these per position, always, and the
 * nulls say which kind of nothing is there —
 *
 *   `key` set, `live` true    a table you can take.
 *   `key` set, `live` false   a DEAD PLATE: the step defines this key and has
 *                             nothing for it. Matt chose the dimmed plate over
 *                             a gap — *"the arc reads as a row"*.
 *   `key` null                a position no key owns, on an overflow page.
 *                             Drawn as nothing at all: not a thing that is
 *                             missing, not a thing.
 */
export interface HangarPlate {
  /** `hoverjet`, `ringAttack`, `beginner`, `kauai` — or null where none is owned. */
  readonly key: string | null
  /** What the table says: "HoverJet", "Ring Attack", "Beginner", "Kauai". */
  readonly name: string | null
  /** Can the nose pointer take it? {@link slotAimable}. */
  readonly live: boolean
  /** Where the position stands, degrees. Positive is to the RIGHT. */
  readonly bearingDegrees: number
  /** DEV-858: the same, measured off the EYE's resting line, which every arc is symmetric about. */
  readonly offEyeDegrees: number
  /**
   * A PLACE's difficulty marks (DEV-420), top of the column first: the rank's
   * key and the course it picks. Absent on every other kind of position.
   */
  readonly marks?: readonly { readonly difficulty: string; readonly id: string }[]
}

/**
 * One arc the level select can deal: a step, and the path that opens it.
 *
 * `plates` is the FIRST page. Every page of a step is the same width — the
 * width is `slotCount(order)` and `fixedPages` deals fixed-length rows — so
 * `plates.length` is the step's arc width whatever `pageCount` is, which is the
 * number the ±45° item is really about.
 */
export interface HangarArc {
  readonly view: HangarView
  /**
   * The keys taken on the steps above, outermost first: `[]` on the aircraft
   * step, `['hoverjet', 'freeFlight', 'beginner']` on a course arc — and
   * `['hoverjet', 'ringAttack']` on a place arc whose plan carries its
   * difficulty (DEV-420), which has no rank above it.
   */
  readonly path: readonly string[]
  readonly plates: readonly HangarPlate[]
  readonly pageCount: number
  /** The word on this step's BACK plate, or null where it has none. */
  readonly backWord: string | null
}

/** The key and the word on a slot's plate. Null, null for an unowned position. */
const plateOf = (slot: TableSlot | null): { key: string | null; name: string | null } => {
  if (slot === null) return { key: null, name: null }
  switch (slot.kind) {
    case 'vehicle':
      return { key: slot.vehicle.vehicle, name: slot.vehicle.name }
    case 'variant':
      return { key: slot.variant.id, name: slot.variant.name }
    case 'mode':
      return { key: slot.mode.mode, name: slot.mode.name }
    case 'rank':
      return { key: slot.rank.difficulty, name: slot.rank.name }
    case 'course':
      return { key: slot.mission.environment, name: slot.mission.environmentName }
    case 'place':
      return { key: slot.place.environment, name: slot.place.environmentName }
    case 'door':
      return { key: slot.door.id, name: slot.door.name }
  }
}

/**
 * **Every arc the level select can deal**, from the content alone.
 *
 * The whole four-step tree, walked the way `createHangar` walks it — the same
 * `vehicleCards` → `modeCards` → `rankCards` → `rank.missions` descent, against
 * the same global `slotOrdersFor`, through the same `pagesFor`. It is a
 * SECOND WALK of one structure, which is the shape §5 of the orientation lesson
 * warns about, so it calls the same four functions rather than re-deriving what
 * they do; what it adds is only the loop over every branch instead of the one
 * branch a player has open.
 *
 * **No mission, mode, vehicle or environment is named anywhere in here** (hard
 * rule 6). A fourteenth JSON adds arcs; it does not touch this function. The
 * probe that cares about *"Beginner HoverJet"* does its own navigating, because
 * that phrase belongs to a sentence in a document, not to the level select.
 *
 * Returned in the order a player would meet them, so a report reads top-down.
 */
export const hangarArcs = (
  cards: readonly MissionCard[],
  /**
   * The variant step (DEV-382), as a room is handed it. Where {@link stepsFor}
   * says an aircraft has the step, it gets a variant arc (path `[vehicle]`)
   * and everything below it is walked once per variant (path
   * `[vehicle, variant, …]`), which is how a room walks it: the plans, ranks
   * and places do not depend on the variant, only the records on them.
   * Absent, or an edition without the step: 2016's four, as before.
   */
  step?: VariantStep | null,
): readonly HangarArc[] => {
  const orders = slotOrdersFor(cards)
  const vehicles = vehicleCards(cards)
  const arcs: HangarArc[] = []

  const add = (
    view: HangarView,
    path: readonly string[],
    content: StepContent,
    views: readonly HangarView[],
  ): void => {
    const pages = pagesFor(view, content, orders)
    const row = pages[0] ?? []
    // Degrees, here, because a reader of this is three-free and cannot call
    // `stepBearings` itself.
    // `stepBearings`, the room's own layout, so a centred plan arc (DEV-379
    // follow-up) is reported where it stands.
    const bearings = stepBearings(view, row.length)
    arcs.push({
      view,
      path,
      pageCount: pages.length,
      backWord: backWordFor(view, views),
      plates: row.map((slot, at) => ({
        ...plateOf(slot),
        live: slotAimable(slot),
        bearingDegrees: ((bearings[at] ?? 0) * 180) / Math.PI,
        offEyeDegrees: (((bearings[at] ?? 0) - SEAT_REST_BEARING) * 180) / Math.PI,
        // DEV-420: a place's column, top first — the order the room stands it.
        ...(slot?.kind === 'place' && placeHasMarks(slot.place)
          ? { marks: slot.place.courses.map((c) => ({ difficulty: c.difficulty, id: c.id })) }
          : {}),
      })),
    })
  }

  // `modes`, `ranks` and `courses` are emptied on the way down exactly as
  // `openVehicle`/`openMode`/`openRank` empty them, so an arc built here and the
  // same arc built by the room cannot differ in what `pagesFor` is handed.
  add('vehicles', [], { vehicles, modes: [], ranks: [], courses: [] }, hangarViews(false))
  for (const vehicle of vehicles) {
    const views = stepsFor(step, vehicle.vehicle)
    const variants =
      step && views.includes('variants')
        ? variantTables(
            cards,
            vehicle.vehicle,
            step.cardsFor(vehicle.vehicle),
            step.lastFlown(vehicle.vehicle),
          )
        : []
    if (variants.length > 0) {
      add(
        'variants',
        [vehicle.vehicle],
        { vehicles, variants, modes: [], ranks: [], courses: [] },
        views,
      )
    }
    const above: readonly (readonly string[])[] =
      variants.length > 0
        ? variants.map((t) => [vehicle.vehicle, t.variant.id])
        : [[vehicle.vehicle]]
    const modes = modeCards(cards, vehicle.vehicle)
    for (const path of above) {
      add('modes', path, { vehicles, modes, ranks: [], courses: [] }, views)
      for (const mode of modes) {
        // DEV-420: a plan that carries its difficulty walks plan -> place, and
        // its place arc's path ends at the PLAN — there is no rank above it.
        if (placesDirect(mode.mode)) {
          add(
            'courses',
            [...path, mode.mode],
            {
              vehicles,
              modes,
              ranks: [],
              courses: mode.missions,
              places: placeCards(mode.missions, orders.ranks),
            },
            stepsFor(step, vehicle.vehicle, mode.mode),
          )
          continue
        }
        const ranks = rankCards(cards, mode.vehicle, mode.mode)
        add('ranks', [...path, mode.mode], { vehicles, modes, ranks, courses: [] }, views)
        for (const rank of ranks) {
          add(
            'courses',
            [...path, mode.mode, rank.difficulty],
            { vehicles, modes, ranks, courses: rank.missions },
            views,
          )
        }
      }
    }
  }
  return arcs
}

/** One difficulty mark on a place's table (DEV-420): the mesh, and the course it picks. */
interface MarkSlot {
  readonly mark: THREE.Group
  readonly course: MissionCard
  readonly shape: SkiMarkShape
}

/** One table's meshes and the state that goes with it. */
interface Table {
  readonly group: THREE.Group
  /** DEV-574: the square on the inset and its glow, shown only while selected. */
  readonly highlight: THREE.Group
  readonly label: THREE.Mesh
  readonly canvas: HTMLCanvasElement
  readonly texture: THREE.CanvasTexture
  diorama: Diorama | null
  /**
   * This table's two lamps, and the group holding them.
   *
   * ── Why they are not on the table, and not on the ship (DEV-188) ────────
   *
   * They light the AIRCRAFT (`render/holo-ship.ts` says why an aircraft needs
   * them when nothing else on a holotable does), and the obvious places to put
   * them are the two this must not use.
   *
   * On the SHIP is where they started, and the ship is torn down on every step
   * (`clearShip`). On the table GROUP is no better: `applyPage` hides the
   * tables a step does not use, and three's `projectObject` opens with
   * `if ( object.visible === false ) return;` — an invisible subtree
   * contributes no lights at all. Either way the scene's `numPointLights`
   * moves when the player presses, and that number is a field of every lit
   * material's program cache key: the room recompiles its shell, its floor,
   * its tables and the parked jet on the first press. Measured at **four
   * programs**, on the walk a player takes.
   *
   * So the pair is built with the ROOM, hangs off the room's own group, is
   * never hidden and is never removed. `lamps.position` follows the table on
   * every layout and the intensities go to zero when no aircraft is up — which
   * contributes exactly nothing to the frame and exactly nothing to the count.
   * DEV-186 is the same fix one room over.
   *
   * Since DEV-354 they light a flight-plan MARK the same way: a mark is lit,
   * the world's own material, and reports the pair it wants as a ship does. So
   * the rule is *lit exactly while a ship or a mark stands on the table*.
   */
  readonly lamps: THREE.Group
  readonly key: THREE.PointLight
  readonly fill: THREE.PointLight
  /**
   * The aircraft turning over an AIRCRAFT table, or null. See
   * `render/holo-ship.ts`. At most one of `ship`, `mark` and `diorama` is set:
   * they are what the steps put on a table, and a step picks one
   * ({@link tablePicture}).
   */
  ship: HoloShip | null
  /** The one mark turning over a FLIGHT-PLAN table, or null (DEV-354). */
  mark: ModeMark | null
  /** The medal over a finished course, or null. See `render/medal.ts`. */
  medal: MedalArt | null
  /**
   * DEV-420: a PLACE's difficulty marks standing on this table, one per course
   * there, and which course's route its diorama is drawing (null for none yet).
   * Empty on every other kind of table.
   */
  marks: MarkSlot[]
  routeShown: string | null
  slot: TableSlot | null
  /** Where on the arc this table currently stands. Set by `applyPage`. */
  bearing: number
  /** Bumped on every page change; a shape that arrives for an old one is dropped. */
  generation: number
  /**
   * DEV-574: this is the SELECTED table (under the pointer, or held while a
   * course loads in the room): its highlight square shows and its picture
   * turns. Every other table's picture rests.
   */
  held: boolean
}

/**
 * The three ink colours of a label, live and dead (DEV-203).
 *
 * ── Why the dimming is in the CANVAS and not in the material ────────────
 *
 * A material opacity would be a second cue for free, and it is exactly the kind
 * of free that costs a session here: the four tables are REUSED across every
 * page, so an opacity left at 0.55 by one step and read by the next is trap
 * 19's shape — a value one call leaves behind and a later one inherits. The
 * canvas is repainted unconditionally on every `applyPage`, so a dead label
 * cannot outlive the page that drew it.
 *
 * The dead inks are the room's own recessive greys (`#9fb4c4` is the header and
 * the lap plates), taken two steps down. Readable if you look at it, plainly
 * not an option if you do not — which is what a dead plate is for.
 */
const LABEL_INK = {
  live: { title: UI_ACCENT, detail: UI_HOLO, best: UI_DIM },
  dead: { title: UI_DEAD, detail: UI_DEAD_DIM, best: UI_DEAD_DIM },
} as const

/**
 * DEV-647: the labels' three sizes, off one title each (`ui-tokens.ts`'s
 * `uiType`). The label canvas is 1024 px across 0.54 m, 1896 px per metre, so the
 * sub-line floor is 32 px. The title is 76 px where the monospace needed 58: the
 * broadcast sans is narrower, so the longest shipped name ("INTERMEDIATE 1 -
 * HOVERJET", 25 characters) still fits the canvas at a larger size. The four-line
 * ghost layout keeps its tighter 54 px title.
 */
const LABEL_PX_PER_M = 1024 / 0.54
const LABEL_TYPE = uiType(76, LABEL_PX_PER_M)
const GHOST_TYPE = uiType(54, LABEL_PX_PER_M)
const VARIANT_TYPE = uiType(58, LABEL_PX_PER_M)

/**
 * DEV-373: the ghost line's ink — the room's own accent (`HOLO_COLOUR`, the
 * rims), because it is the one line on a card that a press changes, and the
 * accent is what this room already uses to say "this is live".
 */
const GHOST_LINE_INK = UI_ACCENT

/** Draw a table's label. One canvas per table, redrawn on a page turn. */
/**
 * DEV-894: a phone's table label is its TITLE alone, and the lines under it (the
 * detail, the best, the ghost) are kept here for the one aimed table's strip
 * (`updatePhoneDetail`). Five tables stand 30 degrees apart and their three-line
 * labels are as wide as the gap: at a scale that reads they ran into each other.
 */
const labelDetails = new WeakMap<HTMLCanvasElement, readonly string[]>()

const paintLabel = (
  canvas: HTMLCanvasElement,
  title: string,
  detail: string,
  best: string,
  dead = false,
  ghost: string | null = null,
): void => {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  forgetTextExtent(canvas)
  const ink = dead ? LABEL_INK.dead : LABEL_INK.live
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (phoneUi.on) {
    labelDetails.set(
      canvas,
      [detail, best, ghost ?? ''].filter((line) => line !== ''),
    )
    ctx.fillStyle = ink.title
    ctx.font = uiFont(LABEL_TYPE.title)
    ctx.fillText(title.toUpperCase(), canvas.width / 2, canvas.height / 2, canvas.width * 0.98)
    return
  }
  if (ghost !== null) {
    // ── DEV-373: four lines, the fourth the ghost ─────────────────────────
    //
    // The same three lines, each a little smaller and higher, and the ghost
    // under them in the room's accent: it is the one line on the card that a
    // press changes. 34 px fits 49 characters across the canvas (monospace
    // advances ~0.6 em); the longest line `game/ghost-pick.ts` can write, with
    // the headset's button, is 48 ("GHOST #100 CRIMSON ALBATROSS 99 188.8s
    // [R STICK]"), so it is never squeezed. `ghost-pick.test.ts` holds the 49.
    ctx.fillStyle = ink.title
    ctx.font = uiFont(GHOST_TYPE.title)
    ctx.fillText(title.toUpperCase(), canvas.width / 2, 38, canvas.width * 0.98)
    ctx.fillStyle = ink.detail
    ctx.font = uiFont(GHOST_TYPE.label, 500)
    ctx.fillText(detail, canvas.width / 2, 96, canvas.width * 0.98)
    ctx.fillStyle = ink.best
    ctx.font = uiFont(GHOST_TYPE.sub, 500)
    ctx.fillText(best, canvas.width / 2, 150, canvas.width * 0.98)
    ctx.fillStyle = GHOST_LINE_INK
    ctx.font = uiFont(GHOST_TYPE.sub, 600)
    ctx.fillText(ghost, canvas.width / 2, 210, canvas.width * 0.98)
    return
  }
  // 58px rather than 74: monospace advance is ~0.6 em, so a 74px face needs
  // 1,100 px for "INTERMEDIATE 1 - HOVERJET" on a 1,024 px canvas and the
  // renderer squeezes it. A squeezed title looks like a font bug and is a
  // measurement one. 58px fits 28 characters, which covers every shipped name.
  // At 0.54 m across 1.55 m away that is still 1.2 degrees of cap height —
  // about 24 px on a Quest 3, twice the floor for readable text.
  ctx.fillStyle = ink.title
  ctx.font = uiFont(LABEL_TYPE.title)
  ctx.fillText(title.toUpperCase(), canvas.width / 2, 52, canvas.width * 0.98)
  // An empty line is not painted (DEV-559: an aircraft's label is its name
  // alone), so the backing (`backHolotableText`) draws no empty pill for it.
  if (detail !== '') {
    ctx.fillStyle = ink.detail
    ctx.font = uiFont(LABEL_TYPE.label, 500)
    ctx.fillText(detail, canvas.width / 2, 128, canvas.width * 0.98)
  }
  if (best !== '') {
    ctx.fillStyle = ink.best
    ctx.font = uiFont(LABEL_TYPE.sub, 500)
    ctx.fillText(best, canvas.width / 2, 196, canvas.width * 0.98)
  }
}

/**
 * A DOOR's label (DEV-558): `paintLabel`'s three lines, the third in the room's
 * accent (the ghost line's ink) when the card asks for it: a first visit's
 * *new here? start here*, or the room a link named.
 */
const paintDoorLabel = (canvas: HTMLCanvasElement, door: DoorCard): void => {
  paintLabel(canvas, door.name, door.detail, door.accent === true ? '' : door.note)
  if (door.accent !== true || door.note === '') return
  if (phoneUi.on) {
    labelDetails.set(canvas, [...(labelDetails.get(canvas) ?? []), door.note])
    return
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = GHOST_LINE_INK
  ctx.font = uiFont(LABEL_TYPE.sub, 600)
  ctx.fillText(door.note, canvas.width / 2, 196, canvas.width * 0.98)
}

/**
 * Draw a VARIANT table's label (DEV-382): its name, its blurb, and its bars.
 *
 * AIRCRAFT-VARIANTS §6.2: *"the name, the blurb, and three short bars DERIVED
 * from the variant's view ... each drawn against the standard's value at the
 * bar's middle mark."* The bars are `game/variant-stats.ts`'s, so a retune
 * moves them and the label cannot lie; the middle mark is 2016's machine, so
 * `standard`'s own bars all stop exactly on it. The table this aircraft last
 * flew says so in its title, and the arc does not move to it (fixed slots).
 */
const paintVariantLabel = (
  canvas: HTMLCanvasElement,
  name: string,
  blurb: string,
  bars: readonly VariantBar[],
  lastFlown: boolean,
): void => {
  if (phoneUi.on) {
    paintLabel(canvas, name, lastFlown ? `LAST FLOWN · ${blurb}` : blurb, '')
    return
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const ink = LABEL_INK.live
  const w = canvas.width
  ctx.clearRect(0, 0, w, canvas.height)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = ink.title
  ctx.font = uiFont(VARIANT_TYPE.title)
  ctx.fillText(
    lastFlown ? `${name.toUpperCase()} · LAST FLOWN` : name.toUpperCase(),
    w / 2,
    44,
    w * 0.98,
  )
  ctx.fillStyle = ink.detail
  ctx.font = uiFont(VARIANT_TYPE.label, 500)
  ctx.fillText(blurb, w / 2, 104, w * 0.98)
  // One column per bar, the row centred: three for the HoverJet, two for the
  // JumpSeat until DEV-383 gives the spider its JUMP.
  const column = w / Math.max(3, bars.length)
  const left = (w - column * bars.length) / 2
  const track = column * 0.8
  for (const [i, bar] of bars.entries()) {
    const cx = left + column * (i + 0.5)
    ctx.fillStyle = ink.best
    ctx.font = uiFont(VARIANT_TYPE.sub, 500)
    ctx.fillText(bar.label, cx, 152, column * 0.96)
    const x0 = cx - track / 2
    ctx.fillStyle = UI_DIM_TRACK
    ctx.fillRect(x0, 178, track, 24)
    ctx.fillStyle = ink.detail
    ctx.fillRect(x0, 178, track * barFill(bar), 24)
    // The middle mark: 2016's value.
    ctx.fillStyle = ink.title
    ctx.fillRect(cx - 2, 170, 4, 40)
  }
}

// ══ DEV-488: the room's own holotable look, lent to the Your courses shelf ══
//
// `render/course-shelf.ts` stands the player's courses on holotables of its
// own (the door on the aircraft step, and the shelf it opens). They must be
// THIS room's tables, not a lookalike: the same rim inks, the same label
// painter and lift, the same turn to the seat. So the private definitions are
// lent here, by name, and nothing about them moves. Re-exports only: no
// behaviour in this file changes.
/** The rim's four inks and the label's lift, as the room's own tables use them. */
export const HOLOTABLE_LOOK = {
  rest: HOLO_COLOUR,
  hover: HOLO_HOVER,
  flown: HOLO_FLOWN,
  dead: HOLO_DEAD,
  labelLift: LABEL_LIFT,
} as const
/** The room's label painter: title, detail, best line, dead, ghost line. */
export const paintHolotableLabel = paintLabel
/** The room's turn of a panel to face the seat, clear of the model. */
export const faceHolotableSeat = faceSeat
/*
 * DEV-437's backing, lifted by DEV-488: every line of words the room paints
 * sits on a dark plate with a fine outline round its letters. See the DEV-437
 * note at its call site in `createHangar`, and `hangar-label-backing.test.ts`,
 * which pins that the lift moved no pixel. Verbatim: it reads nothing but the
 * canvas it is handed and these two inks.
 */
const LABEL_BACKING_2016 = UI_LABEL_BACK
const LABEL_HALO_2016 = UI_LABEL_HALO
/** Wrap `canvas`'s `fillText` so every line it paints is backed. Once per canvas. */
export const backHolotableText = (canvas: HTMLCanvasElement) => {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const fill = ctx.fillText.bind(ctx)
  ctx.fillText = (text: string, x: number, y: number, maxWidth?: number) => {
    const px = Number.parseFloat(/([\d.]+)px/.exec(ctx.font)?.[1] ?? '40')
    const wide = Math.min(ctx.measureText(text).width, maxWidth ?? Number.POSITIVE_INFINITY)
    ctx.save()
    ctx.fillStyle = LABEL_BACKING_2016
    ctx.beginPath()
    // DEV-647: a flat rectangle, not a rounded pill (the broadcast look).
    ctx.rect(x - wide / 2 - px * 0.35, y - px * 0.65, wide + px * 0.7, px * 1.3)
    ctx.fill()
    ctx.lineJoin = 'round'
    ctx.strokeStyle = LABEL_HALO_2016
    ctx.lineWidth = px * 0.14
    if (maxWidth === undefined) ctx.strokeText(text, x, y)
    else ctx.strokeText(text, x, y, maxWidth)
    ctx.restore()
    if (maxWidth === undefined) fill(text, x, y)
    else fill(text, x, y, maxWidth)
  }
}
// ══ end DEV-488 ═════════════════════════════════════════════════════════════

/**
 * Build the room, its lights, the chair and the level select.
 *
 * Everything is positioned relative to the platform's RESTING position, which is
 * the frame `sim/hangar.ts` works in and the frame `createElevator` already uses
 * for its shaft segments. The caller puts the whole group on the static launch
 * anchor.
 */
/**
 * Put a ship on the floor at the room's origin, replacing any previous one.
 *
 * Yawed by {@link PARKED_SHIP_YAW} in the room's frame. The previous version
 * parked it at identity on the argument that the ship had been *"unrotated in
 * the room's frame"* when it hung from the launch anchor — but the room was
 * SPUN relative to that anchor by `HANGAR_SPIN`, so the ship was in fact
 * rotated by −220° in the room's frame, and parking it at identity inside the
 * spun group showed the chair the tail. Twelve frames settled it (DEV-139).
 */
const parkShip = (
  room: THREE.Object3D,
  spec: HangarSpec,
  ship: THREE.Object3D | null,
  /** The surface the wheels go on: the plinth's top in the menu room, the floor in the launch room (DEV-139). */
  parkY: number = spec.floorY,
): void => {
  const existing = room.getObjectByName('hangar-parked-ship')
  if (existing) {
    room.remove(existing)
    // Geometry only: the parked ship's materials are the room's own.
    disposeTree(existing, { materials: false })
  }
  if (!ship) return
  ship.name = 'hangar-parked-ship'
  ship.position.set(0, parkY, 0)
  ship.rotation.set(0, PARKED_SHIP_YAW, 0)
  room.add(ship)
}

export const createHangar = (opts: HangarOptions): HangarArt => {
  const object = new THREE.Group()
  object.name = 'hangar'
  // Spun so the chair looks at the jet's front quarter rather than its exhaust.
  // The shell is a 12-sided revolve, so the room itself cannot tell.
  object.rotation.y = HANGAR_SPIN

  const mesh = generateHangar(opts.spec, opts.seed)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3))
  geometry.computeBoundingSphere()

  const shellMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    // The normals are already per-face — the generator splits every triangle —
    // so this is belt and braces rather than the mechanism.
    flatShading: true,
    // FRONT, not back. The generator winds every wall and ceiling triangle so
    // its normal points INTO the room, which is what makes it lit correctly
    // from the inside — and three's front face is the one its normal points
    // out of. `BackSide` therefore culls exactly the faces you are meant to
    // see: the first build of this had a hangar you could look straight
    // through at the island. Winding and side are one decision, not two.
    side: THREE.FrontSide,
  })
  const shell = new THREE.Mesh(geometry, shellMaterial)
  shell.name = 'hangar-shell'
  object.add(shell)

  // The floor is wound to face UP, so it is the one part that is not back-faced.
  // Rather than a second draw call for `n` triangles, the shell is BackSide and
  // the floor is a separate disc that is not.
  const floorGeometry = new THREE.CircleGeometry(opts.spec.roomRadius * 0.995, opts.spec.sides)
  floorGeometry.rotateX(-Math.PI / 2)
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x141820,
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
  })
  const floor = new THREE.Mesh(floorGeometry, floorMaterial)
  floor.position.y = opts.spec.floorY + 0.02
  floor.name = 'hangar-floor'
  object.add(floor)

  // ── strip lights ────────────────────────────────────────────────────────
  //
  // Two rings of short bars just inside the wall. `MeshBasicMaterial` so they
  // are their own illumination and do not go out when the sun is behind the
  // island — the room is underground and there is no sun in it.
  const stripMaterial = new THREE.MeshBasicMaterial({ color: STRIP_COLOUR })
  const strips = new THREE.Group()
  strips.name = 'hangar-strips'
  const stripRadius = opts.spec.roomRadius * 0.93
  for (const [y, count] of [
    [opts.spec.floorY + 1.4, opts.spec.sides],
    [opts.spec.wallTopY - 1.2, opts.spec.sides],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.9, 2.6), stripMaterial)
      bar.position.set(Math.cos(a) * stripRadius, y, Math.sin(a) * stripRadius)
      bar.rotation.y = -a
      strips.add(bar)
    }
  }
  object.add(strips)

  // ── the dressing: girders, pipes, and the plinth under the jet (DEV-139) ──
  //
  // Generated in `sim/hangar.ts` from 2016's counts and the video's frames;
  // the same material family as the shell (vertex colours, one per face, lit
  // by the lamp) so nothing here glows. The plinth is the MENU room's — the
  // launch room's platform rises through the same footprint — and its lamps
  // below are the only emissive part: twelve short bars in the strips' own
  // material, tucked under the upper tier's lip, which is where the video's
  // ships stood over a ring of lit pods (0:30).
  const furnished = opts.furnished !== false
  const parkY = furnished ? plinthTopY(opts.spec) : opts.spec.floorY
  const dressing = generateHangarDressing(opts.spec, opts.seed, { plinth: furnished })
  const dressingGeometry = new THREE.BufferGeometry()
  dressingGeometry.setAttribute('position', new THREE.BufferAttribute(dressing.positions, 3))
  dressingGeometry.setAttribute('normal', new THREE.BufferAttribute(dressing.normals, 3))
  dressingGeometry.setAttribute('color', new THREE.BufferAttribute(dressing.colors, 3))
  dressingGeometry.computeBoundingSphere()
  const dressingMesh = new THREE.Mesh(dressingGeometry, shellMaterial)
  dressingMesh.name = 'hangar-dressing'
  object.add(dressingMesh)
  if (furnished) {
    // Pods at the foot of the upper riser: the strips' colour at 0.4, because
    // a full-strength bar 8.5 m away sits exactly on the labels' line from the
    // seat and fought the text in the first frame. A dim pod is still a lamp.
    const podMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(STRIP_COLOUR).multiplyScalar(0.4),
    })
    const plinthLamps = new THREE.Group()
    plinthLamps.name = 'hangar-plinth-lamps'
    const lampRadius = opts.spec.boreRadius * PLINTH.upperRadiusOfBore + 0.12
    const lampY = opts.spec.floorY + PLINTH.lowerRise + 0.05
    for (let i = 0; i < opts.spec.sides; i++) {
      const a = ((i + 0.5) / opts.spec.sides) * Math.PI * 2
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.6), podMaterial)
      bar.position.set(Math.cos(a) * lampRadius, lampY, Math.sin(a) * lampRadius)
      bar.rotation.y = -a
      plinthLamps.add(bar)
    }
    strips.add(plinthLamps)
  }

  // Enough to pick the facets out of the dark, and no more: the room should
  // read as lit by its own strips, not as a studio.
  const lamp = new THREE.PointLight(0xbfe6ec, 90, opts.spec.roomRadius * 3.4, 2)
  // Named for DEV-188's reason: a light's bugs are COUNTED rather than seen,
  // and a spec asking which lamps a scene is holding gets a list of
  // `(unnamed)` unless somebody wrote a name down.
  lamp.name = opts.furnished === false ? 'launch-room-lamp' : 'menu-room-lamp'
  lamp.position.set(0, opts.spec.wallTopY * 0.6, 0)
  if (opts.furnished === false) {
    // The LAUNCH room's lamp is OFF THE AXIS, at the upper strip ring's height.
    // The axis is the lift's track: the eye rides it from rise 0 to 106 m, and
    // a lamp sitting on it at +5.9 m was passed at **1.3 m** on `int_01` and
    // `rookie_01` — a 1/r² lamp at 1.3 m is fifteen times what it is from the
    // pad, and the cockpit went to white for a second (frame luma 103 → 175,
    // 8 % of pixels clipped, at rise 5.8; DEV-106's finding, DEV-115's fix).
    // At 0.7 R the closest the eye ever comes is 9 m, so the ride never sees
    // more light than the pad does; the intensity is raised so the pad frame
    // stays about as bright as it was. The height is the upper strips' own, so
    // the light reads as theirs. The MENU room keeps the axis lamp: nobody
    // rides through it, and DEV-040's spin was chosen under that light.
    lamp.intensity = 160
    lamp.position.set(opts.spec.roomRadius * 0.7, opts.spec.wallTopY - 1.2, 0)
  }
  object.add(lamp)

  // ── the ship parked in it ───────────────────────────────────────────────
  if (opts.parkedShip) parkShip(object, opts.spec, opts.parkedShip, parkY)

  // ── the LAUNCH room stops here ──────────────────────────────────────────
  //
  // Shell, strips, lamp, and whatever is parked in it. No chair, no tables, no
  // mission index — see `HangarOptions.furnished`, which is 2016's own split
  // between the room you choose in and the room you ride out of.
  if (opts.furnished === false) {
    return {
      object,
      update() {},
      gaze: () => false,
      aim: null,
      aimDistance: null,
      chosen: null,
      choose: () => null,
      view: 'vehicles' as HangarView,
      firstRestBearing: null,
      markAimed: false,
      views: hangarViews(false),
      vehicles: [],
      vehicle: null,
      variants: [],
      variant: null,
      modes: [],
      mode: null,
      ranks: [],
      rank: null,
      openVehicle() {},
      openVariant() {},
      openMode() {},
      openRank() {},
      goBack() {},
      showVehicles() {},
      showDoors() {},
      doors: [],
      park(ship: THREE.Object3D | null) {
        parkShip(object, opts.spec, ship, parkY)
      },
      medals() {},
      // The launch room has no tables to stand an aircraft on. It has the
      // parked ship above and that is the whole of its ship budget.
      ships() {},
      // And no course to stand a gate on (DEV-326), or an orb (DEV-327).
      gates() {},
      orbs() {},
      setBusy() {},
      setCurrent() {},
      focus() {},
      focused: null,
      refresh() {},
      relabel() {},
      pickFor: (place: PlaceCard) => place.courses[0] as MissionCard,
      page: 0,
      pageCount: 0,
      pages: [],
      turnPage: () => 0,
      dispose() {
        disposeTree(object)
      },
    }
  }

  const seat = seatEyeLocal(opts.spec)

  // ── the holotables ──────────────────────────────────────────────────────
  //
  // Four shells, built once and re-labelled on every page turn rather than torn
  // down and rebuilt: a page change should cost a canvas repaint and a diorama,
  // not thirteen plinths.
  //
  // The plinth is 0.24 m at the top against a 0.375 m half-spacing, so two
  // neighbours clear each other by 0.11 m of floor. A wider one — the single
  // table's 0.46 m — would have them overlapping by 17 cm and reading as one
  // bench with four models on it.
  const tableGeometry = new THREE.CylinderGeometry(
    TABLE_TOP_RADIUS,
    TABLE_FOOT_RADIUS,
    TABLE_TOP,
    8,
  )
  const tableMaterial = new THREE.MeshStandardMaterial({
    color: 0x2a313c,
    roughness: 0.8,
    flatShading: true,
  })
  // DEV-574: the highlight's square and glow, one set for every table.
  const highlights = highlightKit()
  const labelGeometry = new THREE.PlaneGeometry(0.54, 0.155)

  const tables: Table[] = []
  for (const bearing of tableBearings(ROOM_TABLES)) {
    const group = new THREE.Group()
    group.name = 'hangar-holotable'
    const base = tableLocal(opts.spec, bearing)
    group.position.set(base.x, base.y, base.z)
    // **The group is NEVER yawed**, and that is a decision about the maps.
    //
    // Turning each table to face the seat would turn its ISLAND with it, so the
    // four dioramas on a page would show the same archipelago at four different
    // headings and stop being comparable at a glance — which is the whole
    // argument for grouping a page by environment. Only the LABEL turns, which
    // is the only part that has a front. See `faceSeat`.

    const plinth = new THREE.Mesh(tableGeometry, tableMaterial)
    plinth.position.y = TABLE_TOP / 2
    group.add(plinth)

    // DEV-574: the highlight, drawn ONLY on the table the pointer selects, in
    // the hover ink (the rest and flown inks drew it on every table), on the
    // table's inset, glowing.
    const highlight = buildHighlight(highlights)
    layHighlight(highlight, bearing, null)
    group.add(highlight)

    // The label. A canvas panel like every other readable surface in this game,
    // standing above the plinth and facing the seat.
    //
    // Over the model, clear of its peaks. The first build of the single table
    // put it AT table height where the miniature grew straight through the
    // words, and the second put it on the fascia where the table's own edge hid
    // it. The peaks reach about 0.15 m at this relief and this size, so
    // `LABEL_LIFT` clears them with room to spare — and it has to, because on an
    // arc you also read each label ACROSS its neighbour's island.
    const canvas = document.createElement('canvas')
    canvas.width = 1024
    canvas.height = 256
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const label = new THREE.Mesh(
      labelGeometry,
      // The course's name. Canvas text in sRGB, so no tone curve — DEV-081,
      // `render/tone.ts`. The ROOM around it, and the holo islands on the
      // tables, are things in the world and keep it.
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false }),
    )
    faceSeat(label, bearing, TABLE_TOP + LABEL_LIFT)
    group.add(label)

    // DEV-580: no cursor sphere. 2016 snapped a small sphere to the button's
    // own `cursorPos` (`Input_Look.cs:159`), and this room drew one over the
    // selected table until Matt, 2026-10-03: the triangle reticle (DEV-572,
    // `render/menu-reticle.ts`) is the one mark, and the square (DEV-574)
    // says which table is selected.

    group.visible = false
    object.add(group)

    // ── this table's two lamps, built once and never taken away ───────────
    //
    // On the ROOM, not on `group`, and never hidden: see `Table.lamps`. The
    // index is in the name because there are four of these and "which lamp"
    // has to be answerable from a scene traverse — a light's bugs are counted
    // rather than seen.
    //
    // Zero intensity until an aircraft stands here. A point light at zero adds
    // nothing to any fragment and, crucially, does not change what it COSTS to
    // add nothing: the count is what the shader is compiled against, so a lamp
    // that is sometimes dark is free where a lamp that sometimes exists is not.
    const lamps = new THREE.Group()
    lamps.name = `holotable-lamps-${tables.length}`
    const key = new THREE.PointLight(0xffe6c4, 0, 1, 2)
    key.name = `holotable-key-${tables.length}`
    const fill = new THREE.PointLight(0xbfe6ec, 0, 1, 2)
    fill.name = `holotable-fill-${tables.length}`
    lamps.add(key)
    lamps.add(fill)
    // DEV-620: the fifth table (CREDITS) stands no aircraft, so its pair is
    // built and never put in the room: the light count is the four tables'.
    if (tables.length < TABLES_PER_PAGE) object.add(lamps)

    tables.push({
      group,
      highlight,
      label,
      canvas,
      texture,
      lamps,
      key,
      fill,
      diorama: null,
      ship: null,
      mark: null,
      medal: null,
      marks: [],
      routeShown: null,
      slot: null,
      bearing,
      generation: 0,
      held: false,
    })
  }

  // ── the page plates ─────────────────────────────────────────────────────
  //
  // In your lap, 26.4 degrees below the nearest table. A flat SQUARE with a
  // chevron on it and a square fill frame that closes as the dwell runs.
  //
  // DEV-580: squares, laid one side to the seat, to match the tables. Matt,
  // 2026-10-02, of the tables' octagon: *"make it a square instead (so it
  // matches the table)"*, and on 0.18.0 the same for these plates (they were
  // eight-sided, 0.11 m to a corner). A `CircleGeometry` of four segments
  // turned 45 degrees is a square whose sides lie on the axes; sized by
  // `PLATE_HALF` (the octagon's own apothem, so the plate reads the size it
  // did) and `plateSquareRadius` turns a half side into the corner radius
  // three's circle takes. The fill frame keeps its old 2 cm band, as squares.
  const arrowGeometry = new THREE.CircleGeometry(plateSquareRadius(PLATE_HALF), 4, Math.PI / 4)
  arrowGeometry.rotateX(-Math.PI / 2)
  const arrowFillGeometry = new THREE.RingGeometry(
    plateSquareRadius(PLATE_FILL_INNER),
    plateSquareRadius(PLATE_FILL_OUTER),
    4,
    1,
    Math.PI / 4,
  )
  arrowFillGeometry.rotateX(-Math.PI / 2)
  // A plate with nothing to do is HIDDEN rather than inert: an aimable target
  // that does nothing is the exact shape of "the menu is broken" to a player who
  // cannot see why. `plateAction` is the rule; this is the furniture.
  const plates: {
    readonly group: THREE.Group
    readonly material: THREE.MeshBasicMaterial
    readonly fill: THREE.Mesh
    readonly label: THREE.Mesh
    readonly canvas: HTMLCanvasElement
    readonly texture: THREE.CanvasTexture
    readonly side: -1 | 1
    action: PlateAction | null
  }[] = []
  for (const side of [-1, 1] as const) {
    const group = new THREE.Group()
    group.name = `hangar-page-${side < 0 ? 'prev' : 'next'}`
    const at = arrowLocal(opts.spec, side)
    group.position.set(at.x, at.y, at.z)
    const material = new THREE.MeshBasicMaterial({ color: 0x4d6272, side: THREE.DoubleSide })
    const plate = new THREE.Mesh(arrowGeometry, material)
    // DEV-580: one side to the seat, as a table's square lies (`labelYaw`).
    plate.rotation.y = labelYaw(arrowBearing(side))
    group.add(plate)
    // A solid TRIANGLE pointing the way the page goes, not a two-bar chevron:
    // the first build's two bars read as a "T" in the screenshot, because at
    // this size and this viewing angle two thin quads at 40 degrees are two
    // thin quads. A filled arrowhead has a direction you cannot misread, and a
    // `CircleGeometry` of three segments is one.
    const head = new THREE.Mesh(
      new THREE.CircleGeometry(0.055, 3),
      new THREE.MeshBasicMaterial({ color: HOLO_COLOUR, side: THREE.DoubleSide }),
    )
    head.geometry.rotateX(-Math.PI / 2)
    // The triangle's first vertex is at +x; `side` -1 is the previous page, so
    // it turns to point the other way.
    head.rotation.y = side < 0 ? Math.PI : 0
    head.position.y = 0.005
    group.add(head)
    const fill = new THREE.Mesh(
      arrowFillGeometry,
      new THREE.MeshBasicMaterial({ color: HOLO_HOVER, side: THREE.DoubleSide }),
    )
    fill.position.y = 0.004
    fill.rotation.y = plate.rotation.y
    fill.scale.setScalar(0.001)
    fill.visible = false
    group.add(fill)

    // Its own word, lying flat on the floor just beyond the plate.
    //
    // The page arrows never needed one — a triangle pointing along the arc says
    // everything a page turn is — but BACK is not a direction, it is a place to
    // return to, and the same triangle would read as "previous page". A plate
    // whose meaning depends on which step you are on has to say which.
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 128
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.075),
      // Canvas text: not tone-mapped (DEV-081).
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false }),
    )
    // Flat on the floor, past the plate, turned so its top points AWAY from the
    // chair — which is how text lying in front of you reads. `-PI/2` about x
    // puts the face up; `labelYaw` then turns it, for the reason `faceSeat`
    // gives at length. YXZ so the turn happens about world y after the flatten.
    const bearing = arrowBearing(side)
    label.position.set(Math.sin(bearing) * 0.15, 0.003, -Math.cos(bearing) * 0.15)
    label.rotation.order = 'YXZ'
    label.rotation.set(-Math.PI / 2, labelYaw(bearing), 0)
    group.add(label)

    group.visible = false
    object.add(group)
    // DEV-894: a phone's plate words and step header are larger (`phone-floor.ts`).
    label.scale.setScalar(phoneUi.on ? PLATE_PHONE_SCALE : 1)
    plates.push({ group, material, fill, label, canvas, texture, side, action: null })
  }

  /** Draw a plate's word. Same family as every other readable surface here. */
  const paintPlate = (canvas: HTMLCanvasElement, text: string, kicker = ''): void => {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = UI_DIM
    if (!kicker) {
      ctx.font = uiFont(72)
      ctx.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width * 0.94)
      return
    }
    // DEV-605: two lines, a small kicker over the word, so a long step name is
    // not squeezed to fit beside it.
    ctx.font = uiFont(uiType(72, LABEL_PX_PER_M).sub)
    ctx.fillText(kicker, canvas.width / 2, canvas.height * 0.24, canvas.width * 0.94)
    ctx.font = uiFont(60)
    ctx.fillText(text, canvas.width / 2, canvas.height * 0.68, canvas.width * 0.94)
  }

  // ── the page header ─────────────────────────────────────────────────────
  //
  // "SIMONET ISLANDS · 4 OF 4 · PAGE 1/4". Above the models and below the eye,
  // so it never crosses the parked ship.
  const headerCanvas = document.createElement('canvas')
  headerCanvas.width = 1024
  headerCanvas.height = 128
  const headerTexture = new THREE.CanvasTexture(headerCanvas)
  headerTexture.colorSpace = THREE.SRGBColorSpace
  const header = new THREE.Mesh(
    new THREE.PlaneGeometry(HEADER_WIDE, HEADER_TALL),
    // Canvas text: not tone-mapped (DEV-081).
    new THREE.MeshBasicMaterial({ map: headerTexture, transparent: true, toneMapped: false }),
  )
  // Named so a spec can ask whether it is up (DEV-465's focus hides it).
  header.name = 'hangar-header'
  object.add(header)
  /**
   * Over the middle of whatever the page holds, turned to face the seat.
   *
   * At 1.02 m — 0.13 m under the eye and 0.17 m above the highest label, so it
   * never crosses one. The first build put it at 0.78 and it landed on top of
   * the inner table's title. Yawed by MINUS the bearing, for the reason
   * `faceSeat` gives at length.
   */
  let captionWanted = false
  const placeHeader = (bearings: readonly number[]) => {
    const mid = bearings.length
      ? ((bearings[0] as number) + (bearings[bearings.length - 1] as number)) / 2
      : SEAT_REST_BEARING
    header.position.set(
      seat.x + Math.sin(mid) * HOLO_REACH,
      opts.spec.floorY + HEADER_LIFT,
      seat.z - Math.cos(mid) * HOLO_REACH,
    )
    header.rotation.order = 'YXZ'
    header.rotation.set(-0.1, labelYaw(mid), 0)
    header.scale.setScalar(phoneUi.on ? HEADER_PHONE_SCALE : 1)
  }
  placeHeader(tableBearings(TABLES_PER_PAGE))

  // ── the place step's caption (Flow A, DEV-858) ──────────────────────────
  //
  // The difficulty marks on a place table are looked at, not pressed, and
  // nothing said so (UX-PASS 2026-10-08). One small line under the header, on
  // the place step only, in the header's own ink.
  // Built the first time a place step wants it, so a room that never reaches
  // that step draws and allocates nothing for it.
  /**
   * The caption's group: the caption line (under the header, where it always
   * stood) and, DEV-884, the LEGEND line over the header, mirrored about it. Under
   * the header the legend ran into the middle table's label.
   */
  let caption: THREE.Group | null = null
  let captionTexture: THREE.CanvasTexture | null = null
  let captionCanvas: HTMLCanvasElement | null = null
  let legendTexture: THREE.CanvasTexture | null = null
  let legendCanvas: HTMLCanvasElement | null = null
  /** What the legend line was last painted for. */
  let legendPainted = ''
  /** How far apart the caption and the legend stand along the header's up: 0.075 m either side of it. */
  const LEGEND_OFFSET = 0.15
  const ensureCaption = (): THREE.Group => {
    if (caption !== null) return caption
    const line = (): {
      canvas: HTMLCanvasElement
      texture: THREE.CanvasTexture
      mesh: THREE.Mesh
    } => {
      const canvas = document.createElement('canvas')
      canvas.width = 1024
      canvas.height = 64
      // The room's own backing under its words (DEV-437), wrapped BEFORE the paint.
      backHolotableText(canvas)
      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(HEADER_WIDE, HEADER_TALL / 2),
        // Canvas text: not tone-mapped (DEV-081).
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false }),
      )
      return { canvas, texture, mesh }
    }
    const top = line()
    const legend = line()
    captionCanvas = top.canvas
    captionTexture = top.texture
    legendCanvas = legend.canvas
    legendTexture = legend.texture
    top.mesh.name = 'hangar-caption-line'
    legend.mesh.name = 'hangar-legend'
    legend.mesh.position.y = LEGEND_OFFSET
    caption = new THREE.Group()
    caption.name = 'hangar-caption'
    caption.add(top.mesh, legend.mesh)
    caption.visible = false
    object.add(caption)
    const cctx = captionCanvas.getContext('2d')
    if (cctx) {
      cctx.textAlign = 'center'
      cctx.textBaseline = 'middle'
      cctx.fillStyle = UI_DIM
      cctx.font = uiFont(36, 500)
      cctx.fillText(
        PLACE_CAPTION,
        captionCanvas.width / 2,
        captionCanvas.height / 2,
        captionCanvas.width * 0.96,
      )
      captionTexture.needsUpdate = true
    }
    return caption
  }
  /**
   * Paint the legend line for `legend`: each mark's shape in the ski map's own
   * colour (on a white card, as the mark is, so the black one reads) and its
   * difficulty's name. Only when the legend changed.
   */
  const paintLegend = (legend: readonly MarkLegendEntry[]) => {
    const key = legend.map((e) => `${e.shape}:${e.name}`).join('|')
    if (legendCanvas === null || legendTexture === null || key === legendPainted) return
    legendPainted = key
    const cctx = legendCanvas.getContext('2d')
    if (!cctx) return
    const w = legendCanvas.width
    cctx.clearRect(0, 0, w, legendCanvas.height)
    cctx.textBaseline = 'middle'
    // Sized to be read from the chair: the caption's own line is 36 px on this canvas, and
    // the shapes are the marks' own, so they stand a little taller than the words.
    const ICON = 46
    const GAP = 14
    const BETWEEN = 46
    cctx.font = uiFont(40, 500)
    cctx.textAlign = 'left'
    const widths = legend.map((e) => cctx.measureText(e.name).width)
    const run =
      legend.length * (ICON + GAP) +
      widths.reduce((a, b) => a + b, 0) +
      (legend.length - 1) * BETWEEN
    // One run, centred, squeezed to fit the plane when a long name would overrun it.
    const fit = Math.min(1, (w * 0.96) / Math.max(1, run))
    const y = legendCanvas.height / 2
    cctx.save()
    cctx.translate(w / 2, y)
    cctx.scale(fit, fit)
    let x = -run / 2
    for (const [i, e] of legend.entries()) {
      const colour = `#${SKI_MARK_COLOURS[e.shape].toString(16).padStart(6, '0')}`
      const cx = x + ICON / 2
      // A white card behind, so the black one reads on the dark room.
      cctx.fillStyle = UI_INK
      cctx.fillRect(x - 3, -ICON / 2 - 3, ICON + 6, ICON + 6)
      cctx.fillStyle = colour
      cctx.beginPath()
      if (e.shape === 'circle') cctx.arc(cx, 0, ICON * 0.4, 0, Math.PI * 2)
      else if (e.shape === 'diamond') {
        cctx.moveTo(cx, -ICON * 0.46)
        cctx.lineTo(cx + ICON * 0.46, 0)
        cctx.lineTo(cx, ICON * 0.46)
        cctx.lineTo(cx - ICON * 0.46, 0)
        cctx.closePath()
      } else cctx.rect(cx - ICON * 0.36, -ICON * 0.36, ICON * 0.72, ICON * 0.72)
      cctx.fill()
      cctx.fillStyle = UI_DIM
      cctx.fillText(e.name.toUpperCase(), x + ICON + GAP, 0)
      x += ICON + GAP + (widths[i] ?? 0) + BETWEEN
    }
    cctx.restore()
    legendTexture.needsUpdate = true
  }
  /** Stand the caption under the header: the header's pose, 0.075 m down along its own up. */
  const placeCaption = () => {
    if (caption === null) return
    caption.position.copy(header.position)
    caption.position.y -= 0.075
    caption.rotation.copy(header.rotation)
    caption.scale.setScalar(phoneUi.on ? CAPTION_PHONE_SCALE : 1)
  }

  // ── DEV-894: a phone's detail strip ────────────────────────────────────
  //
  // The lines a condensed table label leaves out, for the AIMED table only, in one
  // strip over the row where nothing else stands (above the caption and legend).
  let detail: THREE.Mesh | null = null
  let detailCanvas: HTMLCanvasElement | null = null
  let detailTexture: THREE.CanvasTexture | null = null
  let detailPainted = ''
  const updatePhoneDetail = (table: Table | null) => {
    if (!phoneUi.on) return
    const lines = table === null ? [] : (labelDetails.get(table.canvas) ?? [])
    if (lines.length === 0 || !header.visible) {
      if (detail) detail.visible = false
      return
    }
    if (detail === null) {
      detailCanvas = document.createElement('canvas')
      detailCanvas.width = 1024
      detailCanvas.height = 192
      backHolotableText(detailCanvas)
      detailTexture = new THREE.CanvasTexture(detailCanvas)
      detailTexture.colorSpace = THREE.SRGBColorSpace
      detail = new THREE.Mesh(
        new THREE.PlaneGeometry(HEADER_WIDE, (HEADER_WIDE * 192) / 1024),
        new THREE.MeshBasicMaterial({ map: detailTexture, transparent: true, toneMapped: false }),
      )
      detail.name = 'hangar-detail'
      object.add(detail)
    }
    detail.position.copy(header.position)
    detail.position.y += 0.35
    detail.rotation.copy(header.rotation)
    detail.scale.setScalar(DETAIL_PHONE_SCALE)
    detail.visible = true
    const key = lines.join('|')
    if (key === detailPainted || !detailCanvas || !detailTexture) return
    detailPainted = key
    const dctx = detailCanvas.getContext('2d')
    if (!dctx) return
    dctx.clearRect(0, 0, detailCanvas.width, detailCanvas.height)
    dctx.textAlign = 'center'
    dctx.textBaseline = 'middle'
    const step = detailCanvas.height / (lines.length + 1)
    for (const [i, line] of lines.entries()) {
      dctx.fillStyle = i === 0 ? UI_INK : UI_DIM
      dctx.font = uiFont(i === 0 ? 60 : 54, 500)
      dctx.fillText(line, detailCanvas.width / 2, step * (i + 1), detailCanvas.width * 0.96)
    }
    detailTexture.needsUpdate = true
  }

  const paintHeader = (text: string) => {
    const ctx = headerCanvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, headerCanvas.width, headerCanvas.height)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = UI_DIM
    // ── 48px, not 64: the fourth step brought longer names ────────────────
    //
    // Monospace advance is ~0.6 em, so a 64 px face fits `1024 * 0.96 / 38.4` =
    // **25 characters** — and "TARGET PRACTICE · PROFESSIONAL" is 30. The
    // renderer would squeeze it, which reads as a font bug and is a measurement
    // one; `paintLabel` has the same note about the same trap one plate over.
    //
    // 48 px fits **34**, with four to spare on the longest header the shipped
    // content produces, and it is still the biggest text in the room: the plane
    // is 0.78 m across a 1,024 px canvas, so a 48 px glyph is 36.6 mm, which at
    // the 1.44 m slant range to this plate subtends **1.46 degrees** against the
    // 1.13 the table titles have had since they were sized. Anything down to
    // 37 px would still clear that floor; `level-steps.test.ts` asserts the 34.
    ctx.font = uiFont(48, 600)
    ctx.fillText(text, headerCanvas.width / 2, headerCanvas.height / 2, headerCanvas.width * 0.96)
    headerTexture.needsUpdate = true
  }

  // ── the chair ───────────────────────────────────────────────────────────
  //
  // Faceted and simple: the FALLBACK. 2016's own `MM_Commander_Chair_01` (SLK
  // Sci-Fi Level Kit through Mesh Materializer) replaces it once DEV-430's art
  // lands — bought geometry ships from R2 since hard rule 7 was revised on
  // 2026-09-23 — and this one stays drawn only if that load fails. Its POSITION
  // is 2016's; it exists so that a player who looks down in a headset is
  // sitting in something whatever the network did.
  const chair = new THREE.Group()
  chair.name = 'hangar-chair'
  chair.position.set(seat.x, opts.spec.floorY, seat.z)
  // DEV-858: square to the eye's resting line, which is where it looks.
  chair.rotation.y = seatYawLocal()
  const chairMaterial = new THREE.MeshStandardMaterial({
    color: 0x323a46,
    roughness: 0.78,
    metalness: 0,
    flatShading: true,
  })
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.6, 0.44, 6), chairMaterial)
  base.position.y = 0.22
  chair.add(base)
  const pan = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.16, 0.72), chairMaterial)
  pan.position.y = 0.52
  chair.add(pan)
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.9, 0.16), chairMaterial)
  back.position.set(0, 1.0, 0.34)
  chair.add(back)
  object.add(chair)

  // ── 2016's own room, when it lands (DEV-430) ───────────────────────────
  //
  // Everything above this block is the generated room, and it stays the room
  // until `render/hangar-art.ts` has loaded `setGameplayOptions`' meshes — the
  // shell, the lift's deck, the shaft, the light tubes, `MM_Commander_Chair_01`
  // and a pedestal under every table. Then the generated pieces named here are
  // HIDDEN, never removed, so a failed load leaves this room exactly as it was.
  // Furniture only: nothing here reads or writes a step, a slot, the pointer or
  // the seat. Imported lazily so this stays one block, and the room still
  // builds synchronously (`mp-driver` builds the lobby in this file next).
  //
  // And 2016's LIGHT (DEV-437): a spot, a directional key and a Skyshop probe,
  // built HERE, synchronously and dark, because a light's count is in every lit
  // program's cache key and the lazy import below lands after the first frame
  // (`menu-light-compile.spec.ts`). `render/hangar-light.ts` fills them in from
  // the generated sheet when the art lands, and turns `lamp` down as they come
  // up. The three TYPES are that module's `bareHangarLightRig`, by hand.
  const lightRig2016 = new THREE.Group()
  const key2016 = new THREE.DirectionalLight(0xffffff, 0)
  // Named now, not when the art lands: `boot/app.ts` finds it by this name at
  // boot to set its shadow (DEV-440) before the room's first frame compiles.
  key2016.name = 'hangar-2016-key'
  lightRig2016.add(new THREE.SpotLight(0xffffff, 0), key2016, new THREE.LightProbe(undefined, 0))
  object.add(lightRig2016)
  // And 2016's REFLECTIVE ambient (DEV-439): the deck reflects a sky that
  // `render/hangar-light.ts` writes into this texture when the art lands (the
  // shaft did too until DEV-561, which bakes it unlit in the launch shaft's
  // colours, `render/hangar-art.ts`). Built EMPTY here, with the one material class that wears it, and a
  // primer — one triangle of no area — that draws that class from the room's
  // first frame: `envMap` and the prefiltered map's size are in three's program
  // key, so the program compiles with the room's others and not in the clear
  // when the art lands. 512 x 256 is the size the nine-coefficient sky is
  // written at (DEV-899), since the prefiltered map's size is in the key too.
  const reflectSky2016 = new THREE.DataTexture(
    new Uint16Array(512 * 256 * 4),
    512,
    256,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  )
  reflectSky2016.mapping = THREE.EquirectangularReflectionMapping
  reflectSky2016.colorSpace = THREE.LinearSRGBColorSpace
  reflectSky2016.needsUpdate = true
  const reflective2016 = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    flatShading: true,
    side: THREE.FrontSide,
    metalness: 0,
    envMap: reflectSky2016,
  })
  const primer2016 = new THREE.BufferGeometry()
  primer2016.setAttribute('position', new THREE.Float32BufferAttribute(new Array(9).fill(0), 3))
  primer2016.setAttribute('color', new THREE.Float32BufferAttribute(new Array(9).fill(0), 3))
  const reflectivePrimer2016 = new THREE.Mesh(primer2016, reflective2016)
  reflectivePrimer2016.name = 'hangar-2016-reflective-primer'
  reflectivePrimer2016.frustumCulled = false
  object.add(reflectivePrimer2016)
  // And every line of words the room paints sits on a dark BACKING (DEV-437
  // addendum). The labels float in a lit room, and whatever the light makes of
  // the room behind them — 2016's spot turns the deck near-white — the words
  // must read: `hangar-art.spec.ts` floors each label at WCAG's 4.5:1 against
  // the pixels round its letters. 2016's own text carried a `Shadow` (black at
  // 0.5, six units down), which backs a letter on one side; a thin halo was
  // tried first and measured 1.5–3.8:1 at the seat, because a label is a few
  // pixels tall there and a halo that narrow is mostly blended away. So each
  // line gets a rounded plate behind it and a fine outline round its letters.
  // Wrapped round each canvas's own `fillText` here, once, so every painter
  // above — table, plate, header — inks the same way without a second copy of
  // the rule, and this stays one block. Sized from the face the painter set;
  // every painter here centres its text on (x, y), which is what the plate
  // assumes.
  //
  // DEV-437's backing, lifted by DEV-488: the wrapper itself is now
  // `backHolotableText`, verbatim at module scope, so the Your courses
  // shelf's labels wear it too. `hangar-label-backing.test.ts` pins that
  // this room paints exactly as it did before the lift.
  for (const canvas of [
    headerCanvas,
    ...tables.map((table) => table.canvas),
    ...plates.map((plate) => plate.canvas),
  ])
    backHolotableText(canvas)
  // DEV-531: the parked jet's material — the deck's class, cloned NOW so it is
  // the program the primer compiles with the room's first frame. The jet wears
  // it once 2016's light stands (`hangar-art.ts`, "the parked jet wears the
  // deck's material"); until then, and for good if the art never lands, it
  // wears its own glTF material under the generated room's lamp.
  const jet2016 = reflective2016.clone()
  jet2016.name = 'hangar-2016-jet'
  // DEV-546's follow-up: the wing's projectors in `Projector04_Mat`'s colour,
  // which is a uniform, so a second clone of the same class made now compiles
  // nothing either (`hangar-art.ts`, `dressParkedJet`).
  const jetProjectors2016 = reflective2016.clone()
  jetProjectors2016.name = 'hangar-2016-jet-projectors'
  /** Set once 2016's room stands: dresses a parked jet in `jet2016`. */
  let dressJet: ((ship: THREE.Object3D) => void) | null = null
  void import('./hangar-art')
    .then(({ createHangarArt, dressParkedJet }) => {
      const art = createHangarArt({
        room: object,
        material: shellMaterial,
        replaces: [shell, floor, strips, dressingMesh, chair],
        tables: tables.map((table) => ({ group: table.group, bearing: table.bearing })),
        plinth: tableGeometry,
        seat,
        floorY: opts.spec.floorY,
        parkY,
        tableTop: TABLE_TOP,
        restBearing: SEAT_REST_BEARING,
        alive: () => !disposed,
        lightRig: lightRig2016,
        portLights: [lamp],
        reflective: {
          texture: reflectSky2016,
          material: reflective2016,
          primer: reflectivePrimer2016,
          jet: jet2016,
          projectors: jetProjectors2016,
        },
      })
      void art.ready.then((stands) => {
        if (!stands || disposed) return
        dressJet = (ship) => dressParkedJet(ship, jet2016, jetProjectors2016)
        const parked = object.getObjectByName('hangar-parked-ship')
        if (parked) dressJet(parked)
      })
    })
    .catch((error: unknown) => {
      console.warn("hangar: 2016's room module did not load; the generated room stays —", error)
    })

  // ── state ───────────────────────────────────────────────────────────────

  let disposed = false
  /**
   * Which step is up. A room with doors opens on them (DEV-558); one without
   * opens on the aircraft, as it always did; see `openWith`.
   */
  const hasDoors = opts.doors !== undefined
  let view: HangarView = hasDoors ? 'doors' : 'vehicles'
  /** The door tables of the door step that is up (DEV-558). Empty off one. */
  let doors: readonly DoorCard[] = []
  /**
   * Every card the index handed over. Kept because `rankCards` deals a cell out
   * of the WHOLE list rather than out of one aircraft's slice, and re-deriving
   * it from `vehicles` would be the same grouping written twice.
   */
  let missions: readonly MissionCard[] = []
  /**
   * The four fixed slot orders, computed once when the index lands.
   *
   * Off the WHOLE card set, never off a filtered slice — that is what makes a
   * bearing a fact about the identity rather than about the page (DEV-203).
   */
  let orders: SlotOrders = NO_SLOT_ORDERS
  /** Every aircraft, in `vehicleCards` order. Empty until the index lands. */
  let vehicles: readonly VehicleCard[] = []
  /** Which aircraft is open. Meaningless while `view` is 'vehicles'. */
  let vehicleIndex = 0
  /**
   * The open aircraft's variant tables (DEV-382). Kept while you are below the
   * variant step, because BACK from the flight plans re-opens it. Empty on an
   * edition without the step, and on the first step.
   */
  let variants: readonly VariantTable[] = []
  /** Which variant is open. Meaningless above the flight-plan step. */
  let variantIndex = 0
  /**
   * The variant opened on each aircraft THIS visit, by vehicle key. Whose
   * records that aircraft's tables carry from then on, ahead of the one it
   * last flew; never written anywhere but here (the flight is `app.ts`'s).
   */
  const opened = new Map<string, string>()
  /** The open aircraft's flight plans. Empty while `view` is 'vehicles'. */
  let modes: readonly ModeCard[] = []
  /** Which flight plan is open. Meaningless above the ranks step. */
  let modeIndex = 0
  /** The open (aircraft, mode)'s ranks. Empty above the ranks step. */
  let ranks: readonly RankCard[] = []
  /** Which rank is open. Meaningless unless `view` is 'courses'. */
  let rankIndex = 0
  /** The open rank's courses. Empty unless `view` is 'courses'. */
  let courses: readonly MissionCard[] = []
  /**
   * DEV-420: the open plan's PLACES, where it carries its difficulty — what the
   * last step deals instead of `courses`. Empty otherwise.
   */
  let places: readonly PlaceCard[] = []
  /**
   * DEV-420: which course each place table has picked, by the place's key —
   * the last mark you looked at there. Kept for the room's life, so a place
   * you come back to shows the route you left it on.
   */
  const picks = new Map<string, string>()
  /** The difficulty mark the pointer is on, if it is on one. Cleared with `aim`. */
  let aimedMark: MarkSlot | null = null
  /** The marks' shared geometry and materials: one kit per room. */
  const kit = createSkiMarkKit()
  /**
   * DEV-420: each course's route and pads as `shapeFor` returned them, so a new
   * pick redraws its line on the same frame instead of waiting on a promise.
   */
  const tours = new Map<
    string,
    {
      readonly route: readonly (readonly number[])[] | null
      readonly pads: readonly (readonly number[])[]
    }
  >()
  /**
   * The fixed-slot pages of the CURRENT step — one row per page, `null` for a
   * position this step has nothing for.
   *
   * Deliberately not "every mission's pages". A `pageIndex` that indexes all
   * thirteen missions while the arc is showing three of them is a second source
   * of truth about what is on screen, and the first thing it does is disagree.
   */
  let pages: readonly (readonly (TableSlot | null)[])[] = []
  let pageIndex = 0
  /**
   * The mission the world is currently built for.
   *
   * It no longer moves any table — nothing rotates since DEV-203 — but it still
   * decides which PAGE the last step opens on, which is the courtesy the
   * rotation was really for and the half of it that survives fixed slots.
   */
  let currentMissionId: string | null = null
  let generation = 0
  let aim: HangarAim | null = null
  /** See `HangarArt.aimDistance`. Null whenever `aim` is (DEV-321). */
  let aimAlong: number | null = null
  let chosen: MissionCard | null = null
  let dwell = 0
  /** Set by `gaze()`, consumed by `update()`. See `HangarArt.gaze`. */
  let gazedSinceUpdate = false
  /** Non-null while a mission swap is in flight. See `HangarArt.setBusy`. */
  let busy: string | null = null
  /**
   * WHICH lap plate the pointer is on, so `update()` can fill the right ring.
   *
   * The plate itself rather than its action: two plates can carry the same
   * action the moment a step has more than one page, and matching on the action
   * would fill both rings from one aim. Cleared with `aim`, always — trap 19 is
   * a reference left behind by one call and read by the next.
   */
  let aimedPlate: (typeof plates)[number] | null = null

  // ══ DEV-465: the room while a course loads in it ═════════════════════════
  //
  // Matt, 2026-09-27: *"stay in the hangar, but show the loading indicator and
  // spinning logo? (maybe hide the holo-tables that weren't the last selected
  // one)"*. See `HangarArt.focus`. Visibility only: nothing here adds or
  // removes a material, an object or a light, so it compiles nothing, and a
  // table's lamps are not in its group (`Table.lamps`), so the room's light
  // count is the same focused or not.
  /** The course the room is loading in place, or null. */
  let focusId: string | null = null
  /** DEV-574: lay `table`'s highlight on its pedestal's inset, or where it would be. */
  const layTableHighlight = (table: Table): void => {
    const pedestal = table.group.getObjectByName('holotable-pedestal')
    layHighlight(table.highlight, table.bearing, pedestal ? pedestal.rotation.y : null)
  }
  /** DEV-574: select `table` or not: its highlight square, and whether its picture turns. */
  const holdTable = (table: Table, on: boolean): void => {
    table.held = on
    // Laid again as it shows: 2016's pedestal may have landed since the page
    // was laid, and the square lies on ITS inset.
    if (on) layTableHighlight(table)
    table.highlight.visible = on
  }
  /** Hide all but the focused course's table, and the plates and the header. */
  const applyFocus = (): void => {
    if (focusId === null) return
    for (const table of tables) {
      const keep = table.group.visible && table.group.userData.missionId === focusId
      table.group.visible = keep
      if (!keep) continue
      // The look it had under the pointer when it was pressed: the pick, held.
      holdTable(table, true)
      table.diorama?.object.scale.setScalar(SELECTED_ISLAND_SCALE)
    }
    for (const plate of plates) plate.group.visible = false
    header.visible = false
    if (caption) caption.visible = false
    if (detail) detail.visible = false
  }
  /**
   * The step back as `applyPage` and `applyPlates` lay it, without re-laying:
   * no diorama torn down, no shape asked for. The placeholder table is up
   * until the index lands, which is the one table `slot` does not describe.
   */
  const releaseFocus = (): void => {
    for (const table of tables) {
      table.group.visible = table.slot !== null || (table === tables[0] && pages.length === 0)
      holdTable(table, false)
      table.diorama?.object.scale.setScalar(1)
    }
    for (const plate of plates) plate.group.visible = plate.action !== null
    header.visible = true
    if (caption) caption.visible = captionWanted
  }
  const setFocus = (missionId: string | null): void => {
    focusId = missionId
    // Whatever was aimed stops being aimed: a press cannot act while it is up.
    aim = null
    aimAlong = null
    aimedPlate = null
    dwell = 0
    if (missionId === null) releaseFocus()
    else applyFocus()
  }
  // ══ end DEV-465 ══════════════════════════════════════════════════════════

  const shapeFor = opts.shapeFor ?? missionShape

  /** What the steps have to choose from right now. `pagesFor`'s input. */
  const stepContent = (): StepContent => ({
    vehicles,
    variants,
    modes,
    ranks,
    courses,
    places,
    doors,
  })

  /**
   * The course a place table has picked (DEV-420): the one you last looked at
   * there; else the mission you are flying, if it is here; else the easiest.
   */
  const pickOf = (place: PlaceCard): MissionCard => {
    const want = picks.get(place.key) ?? currentMissionId
    return place.courses.find((c) => c.id === want) ?? (place.courses[0] as MissionCard)
  }

  /** A course's place in the rank order: its mark's row in the column, and its colour. */
  const rankRow = (course: MissionCard): number => {
    const at = orders.ranks.indexOf(course.difficulty)
    return at < 0 ? orders.ranks.length : at
  }

  // ── the variant step (DEV-382) ───────────────────────────────────────────
  //
  // Everything the room asks about variants goes through these, so an edition
  // flip (read live in `enabled()`) cannot leave half the room on one answer
  // and half on the other.

  /** One aircraft's variants, or none where the edition has no step. */
  const variantCardsFor = (vehicle: string): readonly VariantCard[] =>
    opts.variants?.enabled() ? opts.variants.cardsFor(vehicle) : []

  /** Does this aircraft get the variant step? {@link stepsFor} is the rule. */
  const stepsVariants = (vehicle: string): boolean =>
    stepsFor(opts.variants, vehicle).includes('variants')

  /**
   * The steps the room is walking now, for BACK and its word, and for
   * `views`: the open aircraft's, or on the first step the edition's.
   */
  const liveViews = (): readonly HangarView[] => {
    // DEV-558: the Multiplayer branch is its own two-step list, and every
    // other step of a room with doors has the doors in front of it.
    if (view === 'multiplayer') return ['doors', 'multiplayer']
    // DEV-620: the credits are a branch of the first step, as Multiplayer is;
    // since DEV-832 a branch of OPTIONS, which is the first step's.
    if (view === 'options') return ['doors', 'options']
    if (view === 'credits') return ['doors', 'options', 'credits']
    const walk = stepsFor(
      opts.variants,
      view === 'vehicles' || isDoorView(view) ? undefined : vehicles[vehicleIndex]?.vehicle,
      // DEV-420: below the plan step, the open plan — Ring Attack's walk has
      // no rank step, so BACK from its places names the FLIGHT PLAN.
      view === 'ranks' || view === 'courses' ? modes[modeIndex]?.mode : undefined,
    )
    return hasDoors ? ['doors', ...walk] : walk
  }

  /**
   * Whose records `vehicle`'s tables carry: the variant opened this visit, else
   * the one it last flew, else `standard` — and always `standard` on an edition
   * without the step, the only record Classic reads (AIRCRAFT-VARIANTS §8).
   */
  const variantOf = (vehicle: string): string => {
    const known = variantCardsFor(vehicle).map((v) => v.id)
    const want = opened.get(vehicle) ?? opts.variants?.lastFlown(vehicle) ?? null
    return want !== null && known.includes(want) ? want : STANDARD_VARIANT_ID
  }

  /** `cards` with every aircraft's records re-read under {@link variantOf}. */
  const underVariants = (cards: readonly MissionCard[]): readonly MissionCard[] => {
    let out = cards
    for (const vehicle of new Set(cards.map((c) => c.vehicle))) {
      const id = variantOf(vehicle)
      if (out.some((c) => c.vehicle === vehicle && (c.variant ?? STANDARD_VARIANT_ID) !== id)) {
        out = withVariant(out, vehicle, id)
      }
    }
    return out
  }

  /**
   * Re-deal the step that is up into its fixed slots, and clamp the page.
   *
   * The ONE place `pages` is assigned, so the five openers cannot each have
   * their own idea of what a step's pages are — which is how `pageIndex` and
   * `pages.length` start disagreeing and a page plate pages onto an empty arc.
   */
  const dealPages = (wantPage = 0) => {
    // DEV-558: a door step's cards are asked for as it is laid, so a preset
    // that lands, or a link's room that closes, reaches them on the next lay.
    doors = isDoorView(view) ? (opts.doors?.(view) ?? []) : []
    pages = pagesFor(view, stepContent(), orders)
    pageIndex = Math.max(0, Math.min(wantPage, pages.length - 1))
  }

  /** Give each lap plate its job for the step that is up. `plateAction` is the rule. */
  const applyPlates = () => {
    for (const plate of plates) {
      plate.action = plateAction(plate.side, view, pages.length, liveViews())
      plate.group.visible = plate.action !== null
      // DEV-605: BACK's word is a step's header, and the first step's is the
      // title's START, which a player read as "start the game" (the 2026-10-03
      // persona playtest). So the plate says where it goes back TO.
      if (plate.action?.kind === 'back') paintPlate(plate.canvas, backWord(), BACK_KICKER)
      else paintPlate(plate.canvas, 'PAGE')
      plate.texture.needsUpdate = true
      // A plate that has just lost its job must lose the pointer with it.
      // Without this, the dwell ring keeps filling on the plate you used to
      // step back with — inside a hidden group, so the only symptom is the NEXT
      // aim inheriting a dwell it did not earn. Trap 19's shape: a reference
      // left behind by the call that is no longer true.
      if (plate.action === null && aimedPlate === plate) {
        aimedPlate = null
        aim = null
        dwell = 0
      }
    }
  }

  /** Tear a table's diorama down. Called on every page turn and on dispose. */
  const clearDiorama = (table: Table) => {
    // A new island draws no route until one is set on it (DEV-420).
    table.routeShown = null
    if (!table.diorama) return
    table.group.remove(table.diorama.object)
    table.diorama.dispose()
    table.diorama = null
  }

  /**
   * Put a table's two lamps out. They outlive everything they light by design
   * (DEV-188, `Table.lamps`), so "nothing lit stands here" has to be written
   * into them as the lit thing goes — otherwise the first aircraft to stand on
   * this table leaves its key burning over an island.
   */
  const darkenLamps = (table: Table) => {
    table.key.intensity = 0
    table.fill.intensity = 0
  }

  /** The same, for the aircraft standing on an aircraft table (DEV-142). */
  const clearShip = (table: Table) => {
    // Only when there IS a ship. This darkened unconditionally until DEV-354,
    // which was right while a ship was the only lit thing a table could hold;
    // a flight-plan mark is lit by the same pair, and `ships()` re-attaches the
    // aircraft on EVERY table when the GLBs land — so an unconditional darken
    // put out the mark's lamps on whichever step the aircraft arrived during.
    // The lamps are lit only by `attachShip` and `attachMark`, and put out by
    // the two clears, so "lit exactly while one stands here" still holds.
    if (!table.ship) return
    table.group.remove(table.ship.object)
    table.ship.dispose()
    table.ship = null
    darkenLamps(table)
  }

  /** The same, for the mark standing on a flight-plan table (DEV-354). */
  const clearMark = (table: Table) => {
    if (!table.mark) return
    table.group.remove(table.mark.object)
    table.mark.dispose()
    table.mark = null
    darkenLamps(table)
  }

  /**
   * Take a place's difficulty marks off its table (DEV-420). They borrow the
   * room's kit, so there is nothing of theirs to free — only to remove.
   */
  const clearDifficultyMarks = (table: Table) => {
    for (const m of table.marks) table.group.remove(m.mark)
    if (aimedMark && table.marks.includes(aimedMark)) aimedMark = null
    table.marks = []
    table.routeShown = null
  }

  /**
   * Stand a place's difficulty marks on its table (DEV-420): one per course
   * there, at its rank's place along the table's front (`markLocal`, DEV-626),
   * each turned to face the seat and leaned back toward the eye, the way the
   * labels are.
   */
  const standDifficultyMarks = (table: Table, place: PlaceCard, bearing: number) => {
    clearDifficultyMarks(table)
    if (!placeHasMarks(place)) return
    for (const course of place.courses) {
      const index = rankRow(course)
      const shape = skiMarkShape(index)
      const mark = kit.mark(shape)
      const at = markLocal(bearing, index)
      mark.position.set(at.x, at.y, at.z)
      // Leaned back by the angle the eye looks down at it, so the card is
      // square to the sightline rather than to the horizon.
      const reach = Math.hypot(HOLO_REACH - MARK_FRONT, (Math.max(0, index) - 1) * MARK_SPREAD)
      mark.rotation.order = 'YXZ'
      mark.rotation.set(-Math.atan2(SEAT_EYE_HEIGHT - at.y, reach), labelYaw(bearing), 0)
      mark.userData.missionId = course.id
      mark.userData.difficulty = course.difficulty
      table.group.add(mark)
      table.marks.push({ mark, course, shape })
    }
  }

  /** Dress every mark on a place's table for its pick and the aim. Allocates nothing. */
  const styleDifficultyMarks = (table: Table) => {
    if (table.slot?.kind !== 'place') return
    const pick = pickOf(table.slot.place)
    for (const m of table.marks)
      kit.style(m.mark, m.shape, m.course.id === pick.id, m === aimedMark)
  }

  /** A place's label: the place, the difficulty it has picked, and that course's best. */
  const paintPlaceLabel = (table: Table, place: PlaceCard) => {
    const pick = pickOf(place)
    paintLabel(
      table.canvas,
      place.environmentName,
      // DEV-800: a place with no marks (Free Flight's) names no difficulty.
      placeHasMarks(place) ? `${pick.difficultyName} · ${pick.modeName}` : pick.modeName,
      bestLine(pick.best),
      false,
      opts.ghostLine?.(pick) ?? null,
    )
    table.texture.needsUpdate = true
  }

  /**
   * Draw a place table's PICKED route on its island, once both have arrived
   * (DEV-420) — the island is the first shape to land, the route the pick's.
   * Only when it is not already the one drawn, so the line is rebuilt once per
   * new pick and never per frame or per shape.
   */
  const showRoute = (table: Table) => {
    if (table.slot?.kind !== 'place') return
    const pick = pickOf(table.slot.place)
    const tour = tours.get(pick.id)
    if (!table.diorama || !tour || table.routeShown === pick.id) return
    table.diorama.setRoute(tour.route, skiRouteColour(rankRow(pick)), tour.pads)
    table.routeShown = pick.id
  }

  /**
   * Show a NEW pick everywhere a place table shows it (DEV-420): the marks, the
   * route, the label, the medal, and the id outside readers pair a table with.
   */
  const showPick = (table: Table) => {
    if (table.slot?.kind !== 'place') return
    const place = table.slot.place
    table.group.userData.missionId = pickOf(place).id
    styleDifficultyMarks(table)
    showRoute(table)
    paintPlaceLabel(table, place)
    attachMedal(table)
  }

  // ── the aircraft models (DEV-142) ─────────────────────────────────────
  //
  // One prototype per vehicle id, handed over by `ships()` once the GLBs land —
  // the shape `park()` and `medals()` already use, and for the same reason: the
  // room is built synchronously and a mesh is not. Empty until then, and a
  // table laid out before they arrive gets its aircraft when they do.
  //
  // Keyed by the vehicle id rather than held as two fields, so the day a third
  // aircraft exists it is content and not a code change (hard rule 6). An id
  // with no model gets an empty table rather than a fallback island: a wrong
  // picture is worse than none, and it is exactly the wrong picture this row
  // exists to remove.
  let shipModels: Readonly<Record<string, THREE.Object3D>> = {}

  /**
   * The gate a ring-scoring flight plan stands — 2016's own frame, posed and
   * normalised once by `gateMarkGeometry` and shared by every table that wants
   * it (DEV-326; on the flight-plan table since DEV-354). Null until `gates()`
   * hands the GLB over; a table laid out before then gets its gate when it
   * does. The room owns it and frees it.
   */
  let gateArt: THREE.BufferGeometry | null = null
  /** The orb an orb-scoring flight plan stands, the same way (DEV-327, DEV-354). */
  let orbArt: THREE.BufferGeometry | null = null
  /**
   * The target a pad-scoring flight plan stands, lathed from its signature
   * course's own pad surface (`loadMissionPad`) and keyed by that course's id —
   * a pad is content, and a plan whose courses placed a different pad would get
   * its own. `null` is a course with no live pad surface, which stands nothing
   * rather than a stand-in. Owned by the room, like the gate and the orb.
   */
  const padArts = new Map<string, THREE.BufferGeometry | null>()

  /**
   * The geometry a flight-plan table's mark is drawn with: the room's gate or
   * orb, or its signature course's pad. Undefined while a pad has not been read
   * yet — which is not the same as null, a pad that is not there.
   */
  const markArt = (mode: ModeCard): THREE.BufferGeometry | null | undefined => {
    const kind = modeMarkKind(mode.mode)
    if (kind === 'ring') return gateArt
    if (kind === 'orb') return orbArt
    if (kind === 'padZone') return padArts.get(mode.signature.id)
    return null
  }

  /**
   * The instructor's hull a teaching plan stands (DEV-379): the plan's own
   * aircraft, painted in its signature course's instructor colour — built once
   * per aircraft and colour, shared by every table that wants it, and freed by
   * the room, like the gate and the orb. Null until `ships()` has handed that
   * aircraft over, or for a plan whose course names no colour.
   */
  const instructorHulls = new Map<string, THREE.Object3D>()
  /**
   * Aircraft `vehicle` painted `colour` (`#rrggbb`), built once per pair and
   * shared: the instructor's (DEV-379), and since DEV-565 QUICK RACE's AI
   * racer, which is the same paint on the same hull.
   */
  const paintedHull = (
    vehicle: string | undefined,
    colour: string | null,
  ): THREE.Object3D | null => {
    const prototype = vehicle === undefined ? undefined : shipModels[vehicle]
    if (!colour || !prototype) return null
    const key = `${vehicle}:${colour}`
    let hull = instructorHulls.get(key)
    if (!hull) {
      hull = instructorHull(prototype, hexSrgb(colour))
      instructorHulls.set(key, hull)
    }
    return hull
  }
  const instructorHullFor = (mode: ModeCard): THREE.Object3D | null =>
    paintedHull(mode.vehicle, mode.signature.instructorColour ?? null)
  const disposeInstructorHulls = () => {
    for (const hull of instructorHulls.values()) disposeInstructorHull(hull)
    instructorHulls.clear()
  }

  /**
   * Stand this flight-plan table's mark on it, if its art is here (DEV-354).
   *
   * The kind is the mode's, read off its row in `MODES` (`modeMarkKind`), never
   * off its name. Sized into `MARK_SWEEP` by `MARK_TALL`, stood on the model
   * plane the aircraft and the islands use, and lit by the table's own pair,
   * exactly as an aircraft is.
   */
  const attachMark = (table: Table) => {
    clearMark(table)
    const slot = table.slot
    if (!slot || tablePicture(slot) !== 'mark') return
    if (slot.kind === 'door') {
      // DEV-575: MULTIPLAYER's three jets, each in a racer's livery, on the
      // instructor's display case. It waits for the aircraft, as that does.
      if (slot.door.picture === 'formation') {
        const hulls = (slot.door.liveries ?? []).map((c) => paintedHull(slot.door.vehicle, c))
        if (hulls.length === 0 || hulls.some((h) => h === null)) return
        const front = aircraftFront(slot.door.vehicle ?? '')
        standMark(
          table,
          createFormationMark(hulls as THREE.Object3D[], MARK_SWEEP, MARK_TALL, front),
        )
        return
      }
      // DEV-575: FF-TV's set, built here and needing no art.
      if (slot.door.picture === 'tv') {
        standMark(table, createTvMark(MARK_SWEEP, MARK_TALL))
        return
      }
      // DEV-623: the CREDITS step's one table stands the roll itself, the
      // text the pause plate's CREDITS page rolls (`creditsRoll`).
      if (slot.door.picture === 'roll') {
        standMark(
          table,
          createRollMark(
            creditsRoll(slot.door.note),
            CREDITS_ROLL_WIDTH,
            CREDITS_ROLL_HEIGHT,
            CREDITS_ROLL_LIFT,
          ),
        )
        return
      }
      // DEV-832: OPTIONS' sliders, the scroll's class and materials.
      if (slot.door.picture === 'options') {
        standMark(table, createOptionsMark(MARK_SWEEP, MARK_TALL))
        return
      }
      // DEV-879: the COURSE EDITOR's map and pencil, the scroll's class and materials.
      if (slot.door.picture === 'editor') {
        standMark(table, createEditorMark(MARK_SWEEP, MARK_TALL))
        return
      }
      // DEV-620: CREDITS' scroll, the set's class in other colours.
      if (slot.door.picture === 'scroll') {
        standMark(table, createScrollMark(MARK_SWEEP, MARK_TALL))
        return
      }
      // DEV-558: a door stands 2016's gate, the art the plans borrow (QUICK
      // RACE since DEV-575, HOST A RACE and JOIN ROOM).
      if (!gateArt) return
      standMark(table, createModeMark('ring', gateArt, MARK_SWEEP, MARK_TALL))
      return
    }
    if (slot.kind !== 'mode') return
    const kind = modeMarkKind(slot.mode.mode)
    let mark: ModeMark
    if (kind === 'instructor') {
      // DEV-379: a plan that TEACHES stands its instructor, on the aircraft's
      // own display case. It waits for the aircraft's GLB, as that table does.
      const hull = instructorHullFor(slot.mode)
      if (!hull) return
      mark = createInstructorMark(
        hull,
        MARK_SWEEP,
        MARK_TALL,
        'instructor',
        aircraftFront(slot.mode.vehicle),
      )
    } else {
      const art = markArt(slot.mode)
      if (!kind || !art) return
      mark = createModeMark(kind, art, MARK_SWEEP, MARK_TALL)
    }
    standMark(table, mark)
  }

  /**
   * Put `mark` on `table`: on the model plane, lit by the table's own pair,
   * and laid at its rest (DEV-574), facing the seat and turned a little.
   */
  const standMark = (table: Table, mark: ModeMark) => {
    mark.object.position.y = DIORAMA_LIFT
    // DEV-623: the roll is words, so it faces the seat square, not turned.
    mark.rest(restYawFor(table.bearing, mark.front, mark.kind === 'roll' ? 0 : PICTURE_REST_TURN))
    table.group.add(mark.object)
    table.mark = mark
    aimLamp(table.key, mark.lamps.key)
    aimLamp(table.fill, mark.lamps.fill)
  }

  /** Is this table a flight plan whose mark is `kind`? For re-hanging late art. */
  const standsMark = (table: Table, kind: ModeMarkKind): boolean =>
    (table.slot?.kind === 'mode' && modeMarkKind(table.slot.mode.mode) === kind) ||
    // DEV-558: a door's gate waits on the same art.
    (table.slot?.kind === 'door' &&
      // DEV-575: MULTIPLAYER's formation waits on the aircraft, as the instructor does.
      (table.slot.door.picture === kind ||
        (kind === 'instructor' && table.slot.door.picture === 'formation')))

  /**
   * Read a pad-scoring plan's target off its signature course, then stand it.
   *
   * One level JSON, and no height map — the flight-plan step's whole cost. The
   * page may have turned or the room gone by the time it lands, so the table's
   * generation is checked before anything is drawn, as a shape's is.
   */
  const fetchPadArt = (table: Table, missionId: string, generationAsked: number) => {
    void loadMissionPad(missionId)
      .then((solid) => {
        if (disposed) return
        if (!padArts.has(missionId)) {
          padArts.set(missionId, solid ? buildPadGeometry(solid).geometry : null)
        }
        if (table.generation !== generationAsked) return
        attachMark(table)
      })
      .catch((error: unknown) => {
        // A plan table with a name and no mark is a usable table.
        console.warn(`level select: no pad for the flight plan of ${missionId} —`, error)
      })
  }

  /** Stand this table's aircraft on it, if we have the mesh. */
  const attachShip = (table: Table) => {
    clearShip(table)
    const slot = table.slot
    if (!slot || tablePicture(slot) !== 'aircraft') return
    // A variant table stands its aircraft too (DEV-382). The same hull on
    // three tables; the label is what differs, and nothing is invented art.
    // And so does SINGLE PLAYER, the first step's own (DEV-558).
    const id =
      slot.kind === 'vehicle'
        ? slot.vehicle.vehicle
        : slot.kind === 'variant'
          ? slot.variant.vehicle
          : slot.kind === 'door'
            ? (slot.door.vehicle ?? '')
            : ''
    const prototype = shipModels[id]
    if (!prototype) return
    // The RIM's diameter, not `MODEL_SIZE`: the ship turns, so what has to fit
    // the table is the disc it sweeps, and the rim is where the table visibly
    // ends. An island is a flat plate and is allowed to overhang it; an
    // aircraft at the same 0.5 m would graze the rim at two yaws a turn.
    const ship = createHoloShip(prototype, id, TABLE_RIM_RADIUS * 2, aircraftFront(id))
    // `DIORAMA_LIFT`, not `TABLE_TOP`: the island's floor, so the three steps
    // stand their models on one plane and a step change does not look like the
    // table moved. It also clears the rim torus, which `TABLE_TOP + 0.02` does
    // not by much.
    ship.object.position.y = DIORAMA_LIFT
    // DEV-574: laid at rest, nose toward the chair and turned a little.
    ship.rest(restYawFor(table.bearing, ship.front))
    table.group.add(ship.object)
    table.ship = ship
    // Aim this table's own pair at it. The lamp frame is the SHIP's, and
    // `placeLamps` has already put that frame where the ship is, so the offsets
    // `holoShipLamps` derives from the model's span land exactly where they did
    // when the lights hung off the ship itself. Both aircraft are different
    // sizes, so this is a per-ship solve and not a constant (DEV-142).
    aimLamp(table.key, ship.lamps.key)
    aimLamp(table.fill, ship.lamps.fill)
  }

  /** Set one of a table's fixed lamps from an aircraft's description of it. */
  const aimLamp = (light: THREE.PointLight, lamp: HoloShipLamp) => {
    light.color.setHex(lamp.color)
    light.intensity = lamp.intensity
    light.distance = lamp.distance
    light.decay = lamp.decay
    light.position.set(lamp.x, lamp.y, lamp.z)
  }

  /**
   * Put a table's lamp group where the table's SHIP would be.
   *
   * The group never yaws for the reason the table group never yaws, and it
   * carries `DIORAMA_LIFT` because that is where `attachShip` stands the
   * aircraft — so a lamp offset expressed in the ship's frame needs no
   * correction here. Called from `applyPage` beside the table's own placement,
   * because the two must not be able to disagree about where this table is.
   */
  const placeLamps = (table: Table, at: { x: number; y: number; z: number }) => {
    table.lamps.position.set(at.x, at.y + DIORAMA_LIFT, at.z)
  }

  // ── the medals (DEV-113) ─────────────────────────────────────────────────
  //
  // The title logo, once `medals()` has handed it over; null until then, and a
  // table laid out before it arrives gets its medal when it does. One
  // placement for every table: `TABLE_RIM_RADIUS` is the half-extent 2016's
  // numbers are rescaled to, and it is the same for all four.
  let logo: THREE.Object3D | null = null
  const placement = medalPlacement(TABLE_RIM_RADIUS)

  const clearMedal = (table: Table) => {
    if (!table.medal) return
    table.medal.dispose()
    table.medal = null
  }

  /**
   * Put a course's medal over its table, if it has one and the logo is here.
   *
   * Only a COURSE slot: an aircraft or a rank is a group, and a group's medal
   * would be a fourth thing to define ("the lowest of its courses"? "all
   * platinum"?) that 2016 never defined. Its rim colour and "n flown" line
   * already say what a group has.
   */
  const attachMedal = (table: Table) => {
    clearMedal(table)
    const slot = table.slot
    // A course's medal — or, on a place (DEV-420), its PICK's: the course the
    // table is showing and would board.
    const mission =
      slot?.kind === 'course' ? slot.mission : slot?.kind === 'place' ? pickOf(slot.place) : null
    if (!logo || !mission || mission.medal === null) return
    const medal = createMedal(
      logo,
      mission.medal,
      TABLE_RIM_RADIUS,
      undefined,
      opts.medalOutline?.() ?? null,
    )
    medal.object.userData.missionId = mission.id
    // DEV-574: a medal rests face to the chair, and turns with its table.
    medal.rest(restYawFor(table.bearing, medal.front, 0))
    table.group.add(medal.object)
    table.medal = medal
    settleMedal(table)
  }

  /**
   * Put the medal where 2016 put it — or higher, if the island is in the way.
   *
   * The medal and the diorama arrive on their own clocks (a GLB and a height
   * map, neither awaited), so this runs from BOTH `attachMedal` and
   * `attachShape`: whichever lands second settles the pair. `medalRestY` is the
   * rule; this only reads the two objects it needs (DEV-140).
   */
  const settleMedal = (table: Table) => {
    const medal = table.medal
    if (!medal) return
    const at = medalLocal(table.bearing, placement)
    const peak = table.diorama
      ? table.diorama.peakUnder(at.x, at.z, medal.reach + MEDAL_CLEARANCE)
      : -Infinity
    medal.object.position.set(at.x, medalRestY(at.y, DIORAMA_LIFT, peak, medal.bottom), at.z)
  }

  /**
   * Put a LAND table's shape on it: the island, and its craft (DEV-354).
   *
   * No marks, on any step. Until DEV-354 a COURSE table drew its objective — a
   * Ring Attack course as a gate circuit with no island under it (DEV-313), a
   * Target Practice course as red-and-white targets — while the FLIGHT-PLAN
   * table stood one course's island under the plan's name. Matt, 2026-09-24:
   * *"level select - show terrain diorama, no gates. (this was a previous
   * misunderstanding i think on both our counts)"*. The plan is on its own step
   * now, as one mark ({@link attachMark}); a place is the land.
   *
   * The craft stays on every land table — 2016's own environment tables carry
   * an `npc_aiShip` over the miniature and no rings — and where a mission is
   * about its pads it lobs pad to pad (`missionTour`, DEV-313 #41c) on the RANK
   * table as well as the course table now: the rank's island is its signature
   * course's, so its craft flies that course's own path.
   */
  const attachShape = (table: Table, shape: MissionShape) => {
    clearDiorama(table)
    const diorama = createDiorama({
      field: shape.field,
      // The terrain's own colours, and however much of a hologram the live
      // preset wants made of them (DEV-140).
      palette: shape.palette,
      holo: opts.holoLook?.() ?? null,
      // The sea's own surface, not the land's origin (DEV-579).
      seaLevel: shape.seaLevel ?? null,
      // A solid standing on the table, not a sheet over it (DEV-579).
      body: TABLE_BODY,
      route: shape.route,
      // The craft's tour, never drawn. Empty unless the pads are the objective.
      pads: shape.pads,
      size: MODEL_SIZE,
      // A craft drawn to the single table's proportion is 4 px across here. See
      // `DioramaOptions.craftScale`, and orientation lesson §5c.
      craftScale: 1.8,
    })
    diorama.object.position.y = DIORAMA_LIFT
    table.group.add(diorama.object)
    table.diorama = diorama
    // The island is here now; if the medal got here first, lift it clear.
    settleMedal(table)
  }

  /**
   * What the arc is holding right now. `pagesFor` is the rule; this is the state.
   *
   * All four steps go through ONE layout path on purpose. The alternative — a
   * `showModes()` that lays out tables and a `showCourses()` that lays out
   * tables — is four copies of the bearing, label, diorama and generation logic,
   * and the second copy is where the next orientation bug lives.
   */
  const currentSlots = (): readonly (TableSlot | null)[] => pages[pageIndex] ?? []

  /** Put the current step on the tables. Labels now, dioramas when they arrive. */
  /** DEV-884: where a first visit rests at this step; set by `applyPage`. */
  let firstRest: number | null = null
  const applyPage = () => {
    generation++
    const mine = generation
    const slots = currentSlots()
    // The step's own layout: the flight plans are laid centred on the resting
    // pointer, every other step by `tableBearings` (DEV-379 follow-up).
    const bearings = stepBearings(view, slots.length)
    firstRest = firstVisitRestBearing(view, opts.firstVisit === true, bearings, slots)
    placeHeader(headerBearings(view, bearings))
    placeCaption()
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i] as Table
      const slot = slots[i] ?? null
      table.slot = slot
      table.generation = mine
      clearDiorama(table)
      clearShip(table)
      clearMark(table)
      clearMedal(table)
      clearDifficultyMarks(table)
      table.group.visible = slot !== null
      // DEV-574: nothing is selected on a new page until the pointer says so.
      holdTable(table, false)
      // Which course this table stands for, for anything reading the scene
      // from outside — the medal spec pairs medals with tables by it. Cleared
      // on a group or an empty table so a stale id cannot outlive its page. A
      // place's is its pick's (DEV-420), kept current by `showPick`.
      table.group.userData.missionId =
        slot?.kind === 'course'
          ? slot.mission.id
          : slot?.kind === 'place'
            ? pickOf(slot.place).id
            : null
      // Whether the pointer can take it, for the same outside readers.
      table.group.userData.aimable = slotAimable(slot)
      // DEV-558: which door it is, for the same readers.
      table.group.userData.door = slot?.kind === 'door' ? slot.door.id : null
      // Null is a position on an OVERFLOW page that no key owns, or the
      // variant step's padding: not a thing that is missing, not a thing.
      // Drawn as nothing. (Since DEV-560 there is no dead plate at all.)
      if (!slot) continue
      // The bearing this table's FIXED SLOT has. `bearings` is indexed by slot,
      // not by "how many tables we got", so slot 2 is the same bearing whether
      // or not slots 0 and 1 have anything on them.
      const bearing = bearings[i] as number
      // DEV-574: 2016's pedestal turns with its table. `render/hangar-art.ts`
      // hangs it turned for the bearing the table had when the art LANDED
      // (`pedestalYaw`, one side to the seat), and a table's bearing moves
      // between steps (a two-table step lays its first at -15, a four-table
      // step at -45), so until now a pedestal could stand up to 30 degrees off
      // the seat on a later step. Turned by the change, it keeps `pedestalYaw`
      // for the bearing it stands at, so the highlight square below lies on
      // it on every step.
      const pedestal = table.group.getObjectByName('holotable-pedestal')
      if (pedestal) pedestal.rotation.y += table.bearing - bearing
      table.bearing = bearing
      const at = tableLocal(opts.spec, bearing)
      table.group.position.set(at.x, at.y, at.z)
      // The lamps are not in the group — they must not be, see `Table.lamps` —
      // so they are moved here, off the same `at`.
      placeLamps(table, at)
      faceSeat(table.label, bearing, TABLE_TOP + LABEL_LIFT)
      // DEV-623: the CREDITS step's one table shows no label: the roll says
      // CREDITS itself, and stands where the label would.
      table.label.visible = !(slot.kind === 'door' && slot.door.picture === 'roll')
      // DEV-574: the highlight square, on the pedestal's inset from here.
      layTableHighlight(table)
      attachMedal(table)
      if (slot.kind === 'door') {
        // DEV-558: a door's three lines, its note in the accent where it asks
        // for something (a first visit, a link's room).
        paintDoorLabel(table.canvas, slot.door)
      } else if (slot.kind === 'place') {
        // DEV-420: the place, and the difficulty its marks have picked — the
        // words that say which of the column's routes the island is drawing.
        standDifficultyMarks(table, slot.place, bearing)
        styleDifficultyMarks(table)
        paintPlaceLabel(table, slot.place)
      } else if (slot.kind === 'course') {
        // The PLACE is the headline on the last step, not the mission title.
        // By here the aircraft and the rank are both already chosen and both
        // are in the header, so "Intermediate 1 - HoverJet" would be repeating
        // the two things the player just pressed and burying the one thing
        // they are choosing between. 2016 agrees: a `missionSel_*` holotable's
        // `lbl_levelName` reads "The Simonet IslanDs".
        paintLabel(
          table.canvas,
          slot.mission.environmentName,
          slot.mission.modeName,
          bestLine(slot.mission.best),
          false,
          opts.ghostLine?.(slot.mission) ?? null,
        )
      } else if (slot.kind === 'rank') {
        // A rank reads as a rank: its name, where it takes you, how much of it
        // you have flown. Same three lines as a course, one level up.
        paintLabel(
          table.canvas,
          slot.rank.name,
          rankPlaces(slot.rank),
          flownLine(slot.rank.missions.length, slot.rank.flown),
        )
      } else if (slot.kind === 'mode') {
        // A flight plan: its name and which ranks it is offered in. DEV-559:
        // no count. Matt, 2026-10-01: *"don't show the game modes on the
        // aircraft mode select, nor number of courses vs flown"*; the count
        // left this step with the aircraft's.
        paintLabel(table.canvas, slot.mode.name, modeRanks(slot.mode), '')
        // Flow A: the first-visit note continues one step further, on the plan
        // that TEACHES (Flight School), in the accent as SINGLE PLAYER's was.
        if (opts.firstVisit === true && teaches(slot.mode.mode)) {
          const fctx = table.canvas.getContext('2d')
          if (phoneUi.on) {
            // DEV-894: a phone's label is its title; the note rides in the detail strip.
            labelDetails.set(table.canvas, [
              ...(labelDetails.get(table.canvas) ?? []),
              FIRST_VISIT_NOTE,
            ])
          } else if (fctx) {
            fctx.textAlign = 'center'
            fctx.textBaseline = 'middle'
            fctx.fillStyle = GHOST_LINE_INK
            fctx.font = uiFont(LABEL_TYPE.sub, 600)
            fctx.fillText(FIRST_VISIT_NOTE, table.canvas.width / 2, 196, table.canvas.width * 0.98)
          }
        }
      } else if (slot.kind === 'variant') {
        // A variant reads as a MACHINE: its name, Matt's words for it, and
        // what it does against 2016's, as bars (DEV-382).
        paintVariantLabel(
          table.canvas,
          slot.variant.name,
          slot.variant.blurb,
          slot.variant.bars,
          slot.table.lastFlown,
        )
      } else {
        // DEV-559: the aircraft and nothing else. Matt, 2026-10-01: *"don't
        // show the game modes on the aircraft mode select, nor number of
        // courses vs flown"*. The aircraft stands on the table; its name is
        // the label.
        paintLabel(table.canvas, slot.vehicle.name, '', '')
      }
      table.texture.needsUpdate = true
      const picture = tablePicture(slot)
      if (picture === 'aircraft') {
        // It carries the aircraft, synchronously if the mesh is already here —
        // and no height map is asked for, which is the cost
        // `game/mission-index.ts` budgeted for this step (DEV-142).
        attachShip(table)
        continue
      }
      if (picture === 'mark') {
        // ONE mark, and no height map either (DEV-354): a gate or an orb the
        // room already holds, or a pad read off one level JSON.
        attachMark(table)
        if (slot.kind === 'mode' && markArt(slot.mode) === undefined) {
          fetchPadArt(table, slot.mode.signature.id, mine)
        }
        continue
      }
      if (slot.kind === 'place') {
        // ── DEV-420: every course's shape, so a new pick redraws at once ────
        //
        // They share the island (one environment, one cached field) and differ
        // in the route, so the first to land builds the island and each one
        // files its route in `tours`; `showPick` then draws the pick's.
        const place = slot.place
        for (const course of place.courses) {
          void shapeFor(course.id)
            .then((shape) => {
              if (disposed || table.generation !== mine || table.slot?.kind !== 'place') return
              tours.set(course.id, { route: shape.route, pads: shape.pads })
              if (!table.diorama) attachShape(table, shape)
              showRoute(table)
            })
            .catch((error: unknown) => {
              console.warn(`level select: no diorama for ${course.id} —`, error)
            })
        }
        continue
      }
      const shapeId = slotShapeId(slot)
      if (shapeId === null) continue
      void shapeFor(shapeId)
        .then((shape) => {
          // The page may have turned, the STEP may have changed, or the room may
          // be gone. Dropping a stale shape rather than drawing it is the same
          // rule the terrain worker uses for a reply whose LOD we have since
          // changed our mind about.
          if (disposed || table.generation !== mine) return
          if (!table.slot || slotShapeId(table.slot) !== shapeId) return
          attachShape(table, shape)
        })
        .catch((error: unknown) => {
          // A table with a name and no model is a usable table. A menu that
          // throws away the room because one height map 404'd is not.
          console.warn(`level select: no diorama for ${shapeId} —`, error)
        })
    }
    applyPlates()
    paintHeader(headerText())
    // Flow A: the place step's caption, where a place stands difficulty marks.
    captionWanted =
      view === 'courses' && slots.some((s) => s?.kind === 'place' && placeHasMarks(s.place))
    if (captionWanted) {
      ensureCaption()
      placeCaption()
      paintLegend(
        markLegend(
          slots.flatMap((s) =>
            s?.kind === 'place' && placeHasMarks(s.place)
              ? s.place.courses.map((c) => ({ index: rankRow(c), name: c.difficultyName }))
              : [],
          ),
        ),
      )
    }
    if (caption) caption.visible = captionWanted && focusId === null
    // DEV-465: a re-lay while the room loads in place keeps the focus.
    applyFocus()
  }

  /**
   * The one line above the arc.
   *
   * It says WHICH QUESTION IS BEING ASKED, because the four steps are
   * otherwise the same four tables — and below the first it also says what has
   * already been answered, because a menu four deep that does not show the
   * path is a menu you get lost in. The page counter appears only when there is
   * more than one page — which today is never, and a permanent "1/1" is the
   * kind of noise that teaches a reader to stop reading the line.
   *
   * The three headers are 2016's own words: `page_shipSelection`'s
   * `text_airfield` reads *"- Select an Aircraft -"*, `modeSelection.prefab`
   * reads *"- Select a Flight Plan -"* and `page_rankSelection`'s
   * `text_mode (1)` reads *"- Mission Difficulty -"*. The dashes are dropped
   * because this header is a canvas in a hangar and not a Unity UI plate, and
   * every other header in the room is a bare uppercase phrase.
   *
   * The last two steps print the PLAN and then the rank rather than the whole
   * path, because the plate fits 34 characters (see `paintHeader`) and
   * "HOVERJET · TARGET PRACTICE · PROFESSIONAL" is 41. The plan is the half
   * worth keeping: the aircraft is standing in front of you, parked, and
   * Ring Attack versus Free Flight is the distinction the old menu could not
   * make at all.
   */
  const headerText = (): string => {
    if (busy !== null) return busy
    const paged = (text: string) =>
      pages.length > 1 ? `${text} · ${pageIndex + 1}/${pages.length}` : text
    // DEV-558: the door steps say what they are, in the BACK plate's words.
    // DEV-832: the first step has no header: it said START, which a player read
    // as a button, and Matt asked for it gone.
    if (view === 'doors') return ''
    if (isDoorView(view)) return paged(BACK_WORDS[view])
    if (view === 'vehicles') {
      if (vehicles.length === 0) return 'LOADING MISSIONS'
      return paged('SELECT AN AIRCRAFT')
    }
    const open = vehicles[vehicleIndex]
    if (!open) return 'LOADING MISSIONS'
    // DEV-382's step, between the aircraft and its flight plans.
    if (view === 'variants') return paged(`${open.name.toUpperCase()} · VARIANT`)
    if (view === 'modes') return paged(`${open.name.toUpperCase()} · FLIGHT PLAN`)
    const mode = modes[modeIndex]
    if (!mode) return 'LOADING MISSIONS'
    if (view === 'ranks') return paged(`${mode.name.toUpperCase()} · DIFFICULTY`)
    // DEV-420: no rank was asked for — the place carries it, on its table.
    if (placesDirect(mode.mode)) return paged(`${mode.name.toUpperCase()} · PLACE`)
    const rank = ranks[rankIndex]
    if (!rank) return 'LOADING MISSIONS'
    return paged(`${mode.name.toUpperCase()} · ${rank.name.toUpperCase()}`)
  }

  // The word on the BACK plate — see {@link backWordFor}, which is the table
  // and the rule, lifted to module scope by DEV-221 so a test can read it
  // without a room to stand in.
  //
  // The `??` is unreachable and deliberate: `paintPlate` only asks for a back
  // word when `plateAction` already said the plate is up, and that is false on
  // `vehicles` — the one step `backWordFor` returns null for. Kept so a future
  // caller with looser footing gets 2016's own first header rather than
  // `undefined` painted onto a plate.
  const backWord = (): string => backWordFor(view, liveViews()) ?? BACK_WORDS.vehicles

  // ── the placeholder, before the index lands ─────────────────────────────
  //
  // The room is built synchronously and the thirteen level JSONs are not (301 KB
  // gzipped, thirteen parallel chunks). Rather than an empty arc for a frame or
  // two, the first table shows the mission `app.ts` already has in memory — its
  // real name, its real best, its real course.
  const placeholder = tables[0]
  if (placeholder) {
    placeholder.group.visible = true
    paintLabel(placeholder.canvas, opts.title, '', opts.subtitle)
    placeholder.texture.needsUpdate = true
    const bearing0 = (tableBearings(1)[0] as number) ?? 0
    const at0 = tableLocal(opts.spec, bearing0)
    placeholder.group.position.set(at0.x, at0.y, at0.z)
    placeLamps(placeholder, at0)
    faceSeat(placeholder.label, bearing0, TABLE_TOP + LABEL_LIFT)
    if (opts.level) {
      // The land and its craft, as every level table is since DEV-354.
      const diorama = createDiorama({
        field: opts.level.field,
        route: opts.level.route,
        size: MODEL_SIZE,
        craftScale: 1.8,
        body: TABLE_BODY,
      })
      diorama.object.position.y = DIORAMA_LIFT
      placeholder.group.add(diorama.object)
      placeholder.diorama = diorama
    }
  }
  paintHeader('LOADING MISSIONS')

  const openWith = (cards: readonly MissionCard[]) => {
    if (disposed) return
    // Each aircraft's records are its variant's: the one it last flew on an
    // edition with the step, the standard's on one without (DEV-382).
    missions = underVariants(cards)
    // The four fixed slot orders, off the WHOLE set, computed once. Everything
    // the arc does about position reads them and nothing else recomputes them:
    // an order derived from a filtered slice is the bug DEV-203 removed.
    orders = slotOrdersFor(missions)
    vehicles = vehicleCards(missions)
    currentMissionId =
      opts.currentId ?? cards.find((c) => c.title === opts.title)?.id ?? (cards[0]?.id as string)
    // DEV-558: a room on its doors stays there (they need no index); one that
    // was opened on the aircraft before the index landed lays them now.
    if (!isDoorView(view)) showVehicles()
  }

  /**
   * Descend into an aircraft: its flight plans.
   *
   * `dwell` is cleared because the step under the plate has changed and a
   * half-filled ring belongs to the question you just left.
   *
   * ── `lay`, and why the openers can be asked NOT to draw ────────────────
   *
   * `applyPage` tears every diorama down and asks for the next one. That is
   * right for a press — one step, one rebuild — and wrong for `refresh`, which
   * has to walk from the top to re-find the step you were on and would
   * otherwise rebuild the arc three times to show you one. Three teardowns of
   * four islands, on the frame a player comes back to the chair, is the shape
   * of a hitch. `lay = false` sets the state and leaves the drawing to the
   * caller, and `refresh` is the only caller that passes it.
   */
  const openVehicle = (index: number, lay = true) => {
    const vehicle = vehicles[index]
    if (!vehicle) return
    vehicleIndex = index
    if (stepsVariants(vehicle.vehicle)) {
      // DEV-382: Anniversary asks WHICH of this aircraft before the plan. The
      // records on each table are that variant's.
      view = 'variants'
      variants = variantTables(
        missions,
        vehicle.vehicle,
        variantCardsFor(vehicle.vehicle),
        opts.variants?.lastFlown(vehicle.vehicle) ?? null,
      )
      modes = []
    } else {
      view = 'modes'
      variants = []
      modes = modeCards(missions, vehicle.vehicle)
    }
    ranks = []
    courses = []
    places = []
    dealPages()
    dwell = 0
    if (lay) applyPage()
  }

  /**
   * Descend into a variant of the open aircraft: its flight plans (DEV-382).
   *
   * The plans, ranks and places are the aircraft's whatever the variant — every
   * variant flies all of its aircraft's missions — but their RECORDS are this
   * variant's (AIRCRAFT-VARIANTS §6.3), so the cards are re-read here, on the
   * press, and the next step is laid with them on the same frame.
   */
  const openVariant = (index: number, lay = true) => {
    const table = variants[index]
    const vehicle = vehicles[vehicleIndex]
    if (!table || !vehicle) return
    variantIndex = index
    opened.set(vehicle.vehicle, table.variant.id)
    missions = withVariant(missions, vehicle.vehicle, table.variant.id)
    // The aircraft cards count records too, and the aircraft keeps its index:
    // the same set of cards deals the same aircraft order.
    vehicles = vehicleCards(missions)
    view = 'modes'
    modes = modeCards(missions, vehicle.vehicle)
    ranks = []
    courses = []
    places = []
    dealPages()
    dwell = 0
    if (lay) applyPage()
  }

  /**
   * Descend into a flight plan: the ranks it is offered at — or, for a plan
   * whose place carries its difficulty (DEV-420), straight to its PLACES, each
   * table with its column of marks. The page is the one holding the mission
   * you arrived in, as `openRank` opens its courses.
   */
  const openMode = (index: number, lay = true) => {
    const mode = modes[index]
    if (!mode) return
    modeIndex = index
    if (placesDirect(mode.mode)) {
      view = 'courses'
      ranks = []
      courses = mode.missions
      places = placeCards(mode.missions, orders.ranks)
      dealPages()
      pageIndex = Math.max(
        0,
        pageHolding(
          pages,
          (slot) =>
            slot.kind === 'place' && slot.place.courses.some((c) => c.id === currentMissionId),
        ),
      )
      dwell = 0
      if (lay) applyPage()
      return
    }
    view = 'ranks'
    ranks = rankCards(missions, mode.vehicle, mode.mode)
    courses = []
    places = []
    dealPages()
    dwell = 0
    if (lay) applyPage()
  }

  /**
   * Descend into a rank: the places you can fly it.
   *
   * `pageHolding` rather than 0, so a cell that overflows one arc opens on the
   * page carrying the mission you arrived with. Dead code until a fifth
   * environment or a repeated one lands — the POSITION of a place never moves,
   * so this is only ever about which page, never about which slot.
   */
  const openRank = (index: number, lay = true) => {
    const rank = ranks[index]
    if (!rank) return
    rankIndex = index
    view = 'courses'
    courses = rank.missions
    places = []
    dealPages()
    // `pageHolding` returns -1 or a real index, so this is already in range.
    pageIndex = Math.max(
      0,
      pageHolding(pages, (slot) => slot.kind === 'course' && slot.mission.id === currentMissionId),
    )
    dwell = 0
    if (lay) applyPage()
  }

  /**
   * Rebuild the cards from storage and re-lay the step that is up.
   *
   * The open aircraft, plan and rank are found again by their KEYS rather than
   * by their indices or their objects: the card functions return new objects
   * every call, and an index is only stable while the set is — which it is today
   * and is not the day content is added at runtime. A key that no longer
   * resolves falls back to the step above it rather than to the top, because
   * that is the smallest correct answer.
   *
   * **It walks down with `lay = false` and draws ONCE at the end.** Four steps
   * means four openers to get back to where you were, and each one would
   * otherwise tear down four dioramas and ask for four more — three rebuilds a
   * player never sees, on the frame they come back to the chair. See
   * `openVehicle`'s note.
   */
  const refresh = () => {
    const source = opts.missions
      ? Promise.resolve(opts.missions)
      : loadMissionIndex(undefined, opts.fleet)
    void source
      .then((cards) => {
        if (disposed || cards.length === 0) return
        const wasView = view
        const wasPage = pageIndex
        // DEV-558: on a door step there is nothing to walk back down to. The
        // cards are re-read for the walk, and the doors re-laid as they stand.
        if (isDoorView(view)) {
          missions = underVariants(cards)
          orders = slotOrdersFor(missions)
          vehicles = vehicleCards(missions)
          dealPages(wasPage)
          applyPage()
          return
        }
        const vehicleKey = view === 'vehicles' ? null : (vehicles[vehicleIndex]?.vehicle ?? null)
        const belowVariants = view === 'modes' || view === 'ranks' || view === 'courses'
        const modeKey =
          view === 'ranks' || view === 'courses' ? (modes[modeIndex]?.mode ?? null) : null
        const rankKey = view === 'courses' ? (ranks[rankIndex]?.difficulty ?? null) : null
        // Re-read under each aircraft's variant, which may have changed with the
        // edition (DEV-382); `opened` survives, so the variant you picked does.
        missions = underVariants(cards)
        orders = slotOrdersFor(missions)
        vehicles = vehicleCards(missions)
        const atVehicle =
          vehicleKey === null ? -1 : vehicles.findIndex((v) => v.vehicle === vehicleKey)
        if (atVehicle < 0) {
          showVehicles()
          return
        }
        openVehicle(atVehicle, false)
        // The variant step, where the edition has one: back down through it to
        // where you were, on the variant you were on — or, where the step has
        // just appeared under you, on the one whose records you were reading.
        if (view === 'variants' && belowVariants && vehicleKey !== null) {
          const want = variantOf(vehicleKey)
          openVariant(
            Math.max(
              0,
              variants.findIndex((t) => t.variant.id === want),
            ),
            false,
          )
        }
        const atMode =
          modeKey === null || view !== 'modes' ? -1 : modes.findIndex((m) => m.mode === modeKey)
        if (atMode >= 0) {
          openMode(atMode, false)
          const atRank =
            rankKey === null || view !== 'ranks'
              ? -1
              : ranks.findIndex((r) => r.difficulty === rankKey)
          if (atRank >= 0) openRank(atRank, false)
          // The page you were on, if it still exists. `openRank` (and, on a
          // plan whose place carries its difficulty, `openMode`, DEV-420) opens
          // on the page holding the CURRENT mission, which is right when you
          // arrive and wrong when you are only coming back from a run —
          // `refresh` is documented as "keeping the step and the place you are
          // on". The places' picks live in `picks` and survive it too.
          if (view === 'courses' && wasView === 'courses') {
            pageIndex = Math.max(0, Math.min(wasPage, pages.length - 1))
          }
        }
        applyPage()
      })
      .catch((error: unknown) => {
        // The room keeps the cards it has, which are merely out of date. A menu
        // that empties itself because storage hiccuped is worse than one showing
        // a best from a minute ago.
        console.warn('level select: could not refresh the missions —', error)
      })
  }

  /**
   * Straight back to the aircraft, whatever is open.
   *
   * Every load opens here — not on the plan, the rank or the courses of the one
   * you happen to be flying. *"aircraft > mode > difficulty > location"* is the
   * whole change, and a room that skips the first step for the common case
   * teaches the common case that there isn't one.
   */
  const showVehicles = () => {
    view = 'vehicles'
    variants = []
    modes = []
    ranks = []
    courses = []
    places = []
    dealPages()
    dwell = 0
    applyPage()
  }

  /**
   * One step back — 2016's `MenuManager.GoBack()`, which unwinds a page at a
   * time rather than jumping to the top.
   *
   * `viewBehind` is the rule and `HANGAR_VIEWS` is the order. Re-entering the
   * step above by calling its own opener means there is exactly one place that
   * knows how to lay each step out; a `goBack` that set `view` and `pages`
   * itself would be a second copy of `openVehicle`, and the second copy is
   * where the drift lives.
   */
  const goBack = () => {
    const behind = viewBehind(view, liveViews())
    if (behind === null) return
    if (behind === 'ranks') openMode(modeIndex)
    // The plans are behind the ranks; they are reached through the variant
    // where the room has that step (DEV-382), and straight off the aircraft
    // where it does not.
    else if (behind === 'modes') {
      if (variants.length > 0) openVariant(variantIndex)
      else openVehicle(vehicleIndex)
    } else if (behind === 'variants') openVehicle(vehicleIndex)
    else if (behind === 'vehicles') showVehicles()
    // DEV-832: behind the credits is OPTIONS, which holds them.
    else if (behind === 'options') openDoorStep('options')
    // DEV-558: behind the aircraft, and behind Multiplayer's choices.
    else showDoors()
  }

  /**
   * The first step (DEV-558): the doors, where the room has them, and the
   * aircraft where it does not. Everything below them is put by, as
   * `showVehicles` puts by everything below the aircraft.
   */
  const showDoors = () => {
    if (!hasDoors) {
      showVehicles()
      return
    }
    openDoorStep('doors')
  }

  /** Lay door step `step`: the first one, or the Multiplayer branch (DEV-558). */
  const openDoorStep = (step: DoorStep) => {
    view = step
    variants = []
    modes = []
    ranks = []
    courses = []
    places = []
    dealPages()
    dwell = 0
    applyPage()
  }

  // DEV-558: a room with doors opens on them before the index has landed:
  // they need none of it, and a press on SINGLE PLAYER before it lands is the
  // aircraft step's "LOADING MISSIONS" until `openWith` lays it.
  if (hasDoors) showDoors()
  if (opts.missions) openWith(opts.missions)
  else {
    void loadMissionIndex(undefined, opts.fleet)
      .then(openWith)
      .catch((error: unknown) => {
        // The placeholder table stays up, which is the pre-level-select hangar.
        console.warn('level select: could not read the missions —', error)
      })
  }

  // Volatile, and valid only inside the call that fills them (trap 19). Never
  // stored, never read across a call — `gaze()` refills every entry every time.
  const _origin = new THREE.Vector3()
  const _direction = new THREE.Vector3()
  const _centre = new THREE.Vector3()
  const tableCentres: [number, number, number][] = tables.map(() => [0, 0, 0])
  const plateCentres: [number, number, number][] = plates.map(() => [0, 0, 0])
  // DEV-420: the difficulty marks' windows, grown on demand and reused, and the
  // mark each entry is — refilled every `gaze()`, never read across one.
  const markCentres: [number, number, number][] = []
  const markRefs: { table: Table; slot: MarkSlot }[] = []

  const turnPage = (delta: number): number => {
    if (pages.length === 0) return 0
    pageIndex = wrapPage(pageIndex, delta, pages.length)
    dwell = 0
    applyPage()
    return pageIndex
  }

  return {
    object,

    update(seconds: number) {
      for (const table of tables) {
        table.diorama?.update(seconds)
        // DEV-574: a picture turns only while its table is selected, and
        // otherwise goes back to its rest (`render/turntable.ts`).
        table.ship?.update(seconds, table.held)
        table.mark?.update(seconds, table.held)
        table.medal?.update(seconds, table.held)
      }
      // `advanceDwell` owns the whole rule, including the one that matters:
      // a frame with no `gaze()` is a frame the menu is not on screen, and it
      // clears both the aim and the dwell. See its own note.
      const onPlate = aim?.kind === 'page' || aim?.kind === 'back' ? aim : null
      const stepped = advanceDwell(dwell, seconds, onPlate !== null, gazedSinceUpdate)
      dwell = stepped.held
      if (!gazedSinceUpdate) {
        aim = null
        aimAlong = null
        aimedPlate = null
        // And the mark it was on stops being drawn as aimed (DEV-420). Its
        // PICK stays: that is the whole point of a pick.
        if (aimedMark) {
          aimedMark = null
          for (const table of tables) styleDifficultyMarks(table)
        }
      }
      gazedSinceUpdate = false
      // Both plates dwell because both are NAVIGATION — see the header. A step
      // back is as reversible in one glance as a page turn is; what never
      // dwells is a table, because a table launches a mission.
      if (stepped.turn && onPlate) {
        if (onPlate.kind === 'page') turnPage(onPlate.delta)
        else goBack()
      }
      for (const plate of plates) {
        const active = plate === aimedPlate
        plate.fill.visible = active
        plate.fill.scale.setScalar(active ? Math.max(0.001, dwell / PAGE_DWELL_SECONDS) : 0.001)
        plate.material.color.set(active ? 0x6f8a9c : 0x4d6272)
      }
    },

    gaze(origin: THREE.Vector3, direction: THREE.Vector3): boolean {
      gazedSinceUpdate = true
      // DEV-465: nothing is aimable while a course loads in the room — not a
      // table, not a plate, and not a difficulty mark, whose look would re-pick.
      if (focusId !== null) return false
      _origin.copy(origin)
      _direction.copy(direction)

      // ── DEV-420: a place's difficulty marks, FIRST ─────────────────────────
      //
      // Since DEV-626 they stand along their table's front, INSIDE its window,
      // so the order is what makes them takeable: the mark wins, because it is
      // the smaller thing and you had to mean it, and a mark hit is its table's
      // aim too.
      let liveMarks = 0
      for (const table of tables) {
        if (!table.group.visible || table.slot?.kind !== 'place') continue
        for (const slot of table.marks) {
          slot.mark.updateWorldMatrix(true, false)
          _centre.setFromMatrixPosition(slot.mark.matrixWorld)
          if (markCentres.length <= liveMarks) markCentres.push([0, 0, 0])
          const c = markCentres[liveMarks] as [number, number, number]
          c[0] = _centre.x
          c[1] = _centre.y
          c[2] = _centre.z
          // Pooled: an entry is made once and refilled, so a frame of the
          // menu allocates nothing here (trap 19: read only inside this call).
          const ref = markRefs[liveMarks]
          if (ref) {
            ref.table = table
            ref.slot = slot
          } else markRefs.push({ table, slot })
          liveMarks++
        }
      }
      const markHit = pickNearestSphere(
        _origin.x,
        _origin.y,
        _origin.z,
        _direction.x,
        _direction.y,
        _direction.z,
        markCentres,
        MARK_GAZE_RADIUS,
        liveMarks,
      )
      const onMark = markHit >= 0 ? (markRefs[markHit] ?? null) : null
      if (onMark?.slot !== aimedMark) {
        const was = aimedMark
        aimedMark = onMark?.slot ?? null
        // LOOKING PICKS: the mark under the pointer becomes its table's pick,
        // and the island draws its route. A press is still what boards.
        if (onMark && onMark.table.slot?.kind === 'place') {
          const place = onMark.table.slot.place
          if (pickOf(place).id !== onMark.slot.course.id) {
            picks.set(place.key, onMark.slot.course.id)
            showPick(onMark.table)
          }
        }
        for (const table of tables) {
          if (table.marks.some((m) => m === was || m === aimedMark) && table.slot?.kind === 'place')
            styleDifficultyMarks(table)
        }
      }

      let live = 0
      for (let i = 0; i < tables.length; i++) {
        const table = tables[i] as Table
        // **`slotAimable`, not `group.visible` — this line is the dead plate's
        // whole safety** (DEV-203). A dead plate is ON SCREEN and must not be
        // pickable, so it contributes NO SPHERE and `pickNearestSphere` has
        // nothing to find. No flag downstream has to remember it exists: the
        // picker, `aim`, `choose()` and the lap plates' dwell are all fed from
        // this list and none of them can see past it.
        //
        // It also un-aims the PLACEHOLDER table, which was visible and hoverable
        // before the index landed while doing nothing on a press — a rim that
        // lit for a table you could not take. That is the shape `app.ts` calls
        // *"the difference between a menu and a trap"*, and it was already here.
        if (!table.group.visible || !slotAimable(table.slot)) continue
        table.group.updateWorldMatrix(true, false)
        _centre.set(0, TABLE_TOP + GAZE_LIFT, 0).applyMatrix4(table.group.matrixWorld)
        const slot = tableCentres[live] as [number, number, number]
        slot[0] = _centre.x
        slot[1] = _centre.y
        slot[2] = _centre.z
        live++
      }
      // A mark hit is the table's too, so no table window is asked once one
      // has been taken (DEV-420).
      const tableHit =
        onMark !== null
          ? -1
          : pickNearestSphere(
              _origin.x,
              _origin.y,
              _origin.z,
              _direction.x,
              _direction.y,
              _direction.z,
              tableCentres,
              GAZE_RADIUS,
              live,
            )

      // Only the plates that are UP are aimable. `livePlates` is the same
      // compaction `live` does for tables, and for the same reason: an invisible
      // plate that still answers the ray is a target you cannot see and cannot
      // stop hitting.
      let plateHit = -1
      const livePlates: (typeof plates)[number][] = []
      if (tableHit < 0 && onMark === null) {
        for (const plate of plates) {
          if (!plate.group.visible || plate.action === null) continue
          plate.group.updateWorldMatrix(true, false)
          _centre.set(0, 0, 0).applyMatrix4(plate.group.matrixWorld)
          const slot = plateCentres[livePlates.length] as [number, number, number]
          slot[0] = _centre.x
          slot[1] = _centre.y
          slot[2] = _centre.z
          livePlates.push(plate)
        }
        plateHit = pickNearestSphere(
          _origin.x,
          _origin.y,
          _origin.z,
          _direction.x,
          _direction.y,
          _direction.z,
          plateCentres,
          ARROW_GAZE_RADIUS,
          livePlates.length,
        )
      }

      // `live` indexes the AIMABLE tables, and the walk back has to use the
      // **same predicate the fill used** or the hit resolves to the wrong table.
      // Since DEV-203 an unaimable table can sit in the MIDDLE of the arc — a
      // dead plate between two live ones — so this is no longer an ordering
      // nicety: compacting on `visible` here while filling on `slotAimable`
      // above would put the label of one mission on the hit of another, which
      // is the exact bug the old comment warned about and could not produce.
      // On a difficulty mark, its table is the one that lights: you are
      // looking at that place, at one of its routes (DEV-420).
      let hitTable: Table | null = onMark?.table ?? null
      if (tableHit >= 0) {
        let seen = 0
        for (const table of tables) {
          if (!table.group.visible || !slotAimable(table.slot)) continue
          if (seen === tableHit) {
            hitTable = table
            break
          }
          seen++
        }
      }

      // ── DEV-858: the resting aim on an EVEN arc ──────────────────────────────
      //
      // Arcs are symmetric about the eye line, so an even one has the eye's rest
      // BETWEEN its middle two tables and a blind press would do nothing. The
      // resting look (a small window about the gap, well inside the half a step
      // between two tables) takes the right-middle one, so a first press still
      // lands, without moving the arc.
      if (hitTable === null && tableHit < 0 && onMark === null && plateHit < 0) {
        const count = currentSlots().length
        if (count >= 2 && count % 2 === 0) {
          const g = tableGazeLocal(opts.spec, SEAT_REST_BEARING)
          _centre.set(g.x, g.y, g.z)
          object.updateWorldMatrix(true, false)
          _centre.applyMatrix4(object.matrixWorld)
          const slot = tableCentres[0] as [number, number, number]
          const saved0 = [slot[0], slot[1], slot[2]] as const
          slot[0] = _centre.x
          slot[1] = _centre.y
          slot[2] = _centre.z
          const onGap =
            pickNearestSphere(
              _origin.x,
              _origin.y,
              _origin.z,
              _direction.x,
              _direction.y,
              _direction.z,
              tableCentres,
              REST_GAP_RADIUS,
              1,
            ) >= 0
          slot[0] = saved0[0]
          slot[1] = saved0[1]
          slot[2] = saved0[2]
          const t = tables[restingSlot(count)]
          if (onGap && t && t.group.visible && slotAimable(t.slot)) hitTable = t
        }
      }

      for (const table of tables) {
        const on = table === hitTable
        // DEV-574: the highlight square on this table only, and only this
        // table's picture turns. Visibility, never a material: no program.
        holdTable(table, on)
        // The aimed table lifts and grows. A rim colour alone is a 2 mm line at
        // 1.57 m; this is 10% of an 18-degree model and cannot be missed.
        table.diorama?.object.scale.setScalar(on ? SELECTED_ISLAND_SCALE : 1)
      }
      updatePhoneDetail(hitTable)

      const plate = plateHit >= 0 ? (livePlates[plateHit] ?? null) : null
      const slot = hitTable?.slot ?? null
      // Every kind spelled out, so the TYPE keeps this exhaustive: add a kind
      // of table and this stops compiling instead of quietly aiming at it.
      const aimFor = (s: TableSlot): HangarAim | null => {
        switch (s.kind) {
          case 'course':
            return { kind: 'mission', mission: s.mission }
          case 'place':
            // DEV-420: the table boards what it has picked — the route it is
            // drawing — and on a mark, that mark's course, which it has just
            // picked. The same `mission` aim either way, so `boot/app.ts`'s
            // one-line contract (a MissionCard boards) holds unchanged.
            return onMark !== null
              ? { kind: 'mission', mission: onMark.slot.course, place: s.place, mark: true }
              : { kind: 'mission', mission: pickOf(s.place), place: s.place }
          case 'rank':
            return { kind: 'rank', rank: s.rank }
          case 'mode':
            return { kind: 'mode', mode: s.mode }
          case 'vehicle':
            return { kind: 'vehicle', vehicle: s.vehicle }
          case 'variant':
            return { kind: 'variant', variant: s.variant }
          case 'door':
            return { kind: 'door', door: s.door }
        }
      }
      const nextAim: HangarAim | null = slot ? aimFor(slot) : (plate?.action ?? null)
      // A dwell only survives an unbroken aim at the SAME plate. Compared by
      // plate rather than by action for the reason `aimedPlate` gives.
      if (plate === null || plate !== aimedPlate) dwell = 0
      aim = nextAim
      aimedPlate = plate
      // DEV-321: where along the ray the window that won is centred. The same
      // centre the picker just measured the miss to, projected on the ray —
      // `along` in `pickNearestSphere`'s own terms.
      const hitCentre =
        nextAim === null
          ? null
          : markHit >= 0 && onMark !== null
            ? markCentres[markHit]
            : tableHit >= 0
              ? tableCentres[tableHit]
              : plateHit >= 0
                ? plateCentres[plateHit]
                : null
      if (hitCentre) {
        const length = _direction.length()
        aimAlong =
          length > 0
            ? ((hitCentre[0] - _origin.x) * _direction.x +
                (hitCentre[1] - _origin.y) * _direction.y +
                (hitCentre[2] - _origin.z) * _direction.z) /
              length
            : null
      } else aimAlong = null
      // True for a table of ANY kind: all three are things an A press acts on,
      // and `app.ts` uses this for the hover cue and for nothing else. Written
      // as "not a plate and not nothing" rather than as a list of the three
      // kinds, so a fourth step cannot silently stop lighting the cue.
      return nextAim !== null && nextAim.kind !== 'page' && nextAim.kind !== 'back'
    },

    get aim() {
      return aim
    },
    get markAimed() {
      return aimedMark !== null
    },
    get aimDistance() {
      return aimAlong
    },
    get chosen() {
      return chosen
    },

    choose(): MissionCard | null {
      // A swap is already in flight. A second press must not start another —
      // the first one has already begun taking the world apart.
      if (busy !== null) return null
      if (!aim) return null
      if (aim.kind === 'page') {
        turnPage(aim.delta)
        return null
      }
      if (aim.kind === 'back') {
        goBack()
        return null
      }
      if (aim.kind === 'door') {
        // DEV-558: Single Player and Multiplayer descend; every other door is
        // the app's (TV, a room, the letter plate). Nothing boards from here.
        const to = doorDescends(aim.door.id)
        if (to === 'vehicles') showVehicles()
        else if (to === 'multiplayer') openDoorStep('multiplayer')
        else if (to === 'credits') openDoorStep('credits')
        else opts.onDoor?.(aim.door.id)
        return null
      }
      if (aim.kind === 'vehicle') {
        // Descending is not choosing. Returning null here is what keeps
        // `app.ts`'s one-line contract honest — a press on anything but a
        // course must never board a ship, and the type is what stops the next
        // edit from making it. It is also why the unaimed press a player makes
        // when they first sit down cannot launch anything: the first step is
        // this one (DEV-203).
        openVehicle(vehicles.indexOf(aim.vehicle))
        return null
      }
      if (aim.kind === 'variant') {
        // Descending, like the aircraft: a variant is not a course (DEV-382).
        const id = aim.variant.id
        openVariant(variants.findIndex((t) => t.variant.id === id))
        return null
      }
      if (aim.kind === 'mode') {
        openMode(modes.indexOf(aim.mode))
        return null
      }
      if (aim.kind === 'rank') {
        // DEV-608: a lesson rank holds one lesson, and its PLACE step would be
        // one table to press again. It boards from here.
        const only = boardsFromRank(aim.rank)
        if (only !== null) {
          chosen = only
          opts.onChoose?.(chosen)
          return chosen
        }
        openRank(ranks.indexOf(aim.rank))
        return null
      }
      chosen = aim.mission
      opts.onChoose?.(chosen)
      return chosen
    },

    get view() {
      return view
    },
    get firstRestBearing() {
      return firstRest
    },
    get views() {
      return liveViews()
    },
    get vehicles() {
      return vehicles
    },
    get vehicle() {
      return view === 'vehicles' || isDoorView(view) ? null : (vehicles[vehicleIndex] ?? null)
    },
    get doors() {
      return doors
    },
    get variants() {
      return variants
    },
    get variant() {
      return view === 'modes' || view === 'ranks' || view === 'courses'
        ? (variants[variantIndex]?.variant ?? null)
        : null
    },
    get modes() {
      return modes
    },
    get mode() {
      return view === 'ranks' || view === 'courses' ? (modes[modeIndex] ?? null) : null
    },
    get ranks() {
      return ranks
    },
    get rank() {
      return view === 'courses' ? (ranks[rankIndex] ?? null) : null
    },
    openVehicle,
    openVariant,
    openMode,
    openRank,
    goBack,
    showVehicles,
    showDoors,
    park(ship: THREE.Object3D | null) {
      parkShip(object, opts.spec, ship, parkY)
      // DEV-531: in 2016's light, the jet wears the deck's material.
      if (ship) dressJet?.(ship)
    },
    medals(next: THREE.Object3D | null) {
      logo = next
      for (const table of tables) attachMedal(table)
    },
    ships(models: Readonly<Record<string, THREE.Object3D>> | null) {
      shipModels = models ?? {}
      for (const table of tables) attachShip(table)
      // DEV-379: the instructor is painted off these models, so a Flight
      // School table re-hangs on them, and the old paint goes AFTER — nothing
      // on the stage is left holding a freed buffer, as with the gates.
      const previous = [...instructorHulls.values()]
      instructorHulls.clear()
      for (const table of tables) if (standsMark(table, 'instructor')) attachMark(table)
      for (const hull of previous) disposeInstructorHull(hull)
    },
    gates(gate: THREE.Object3D | null) {
      if (disposed) return
      const previous = gateArt
      gateArt = gate ? gateMarkGeometry(gate) : null
      // Every gate table re-hung BEFORE the old geometry goes, so nothing on
      // the stage is ever left holding a freed buffer. Only the tables that
      // stand a gate: re-hanging an orb would restart its turn for nothing.
      for (const table of tables) if (standsMark(table, 'ring')) attachMark(table)
      previous?.dispose()
    },
    orbs(orb: THREE.Object3D | null) {
      if (disposed) return
      const previous = orbArt
      orbArt = orb ? orbMarkGeometry(orb) : null
      // Re-hung before the old one goes, as the gates are.
      for (const table of tables) if (standsMark(table, 'orb')) attachMark(table)
      previous?.dispose()
    },
    setBusy(text: string | null) {
      busy = text
      // Repaint through the same call the steps use, so "busy" cannot drift
      // into being a fourth kind of header with its own wording rules.
      paintHeader(headerText())
    },
    setCurrent(missionId: string) {
      currentMissionId = missionId
      applyPage()
    },
    focus: setFocus,
    get focused() {
      return focusId
    },
    refresh,
    pickFor: pickOf,
    relabel() {
      if (disposed) return
      for (const table of tables) {
        const slot = table.slot
        // A place's label carries its pick's ghost line (DEV-420).
        if (slot?.kind === 'place') paintPlaceLabel(table, slot.place)
        if (slot?.kind !== 'course') continue
        paintLabel(
          table.canvas,
          slot.mission.environmentName,
          slot.mission.modeName,
          bestLine(slot.mission.best),
          false,
          opts.ghostLine?.(slot.mission) ?? null,
        )
        table.texture.needsUpdate = true
      }
    },

    get page() {
      return pageIndex
    },
    get pageCount() {
      return pages.length
    },
    get pages() {
      return pages
    },
    turnPage,

    dispose() {
      disposed = true
      for (const table of tables) {
        clearDiorama(table)
        clearShip(table)
        clearMark(table)
        clearMedal(table)
        table.texture.dispose()
        // The lamps outlive every ship and mark that borrows them (DEV-188), so
        // the room is the only thing that can drop them. The traverse below
        // only reaches meshes.
        table.key.dispose()
        table.fill.dispose()
      }
      // The art the marks borrowed, now that none is left to borrow it
      // (DEV-326, DEV-327, DEV-354).
      gateArt?.dispose()
      gateArt = null
      orbArt?.dispose()
      orbArt = null
      for (const pad of padArts.values()) pad?.dispose()
      padArts.clear()
      disposeInstructorHulls()
      // The difficulty marks' shared kit (DEV-420). The marks come off their
      // tables first, so the traverse below never reaches a shared buffer.
      for (const table of tables) clearDifficultyMarks(table)
      kit.dispose()
      for (const plate of plates) plate.texture.dispose()
      headerTexture.dispose()
      captionTexture?.dispose()
      detailTexture?.dispose()
      legendTexture?.dispose()
      disposeTree(object)
    },
  }
}
