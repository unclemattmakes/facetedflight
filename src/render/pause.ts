// @engine-layer: imports nothing from game, content, generated or boot/app (tests/unit/engine-layering-guard.test.ts)
// src/render/pause.ts — the way out of a run that is going badly.
//
// 2016 has one and we did not, which for a VR game is a real gap: a player
// wearing a headset who wants to stop has no affordance at all short of taking
// it off. `Input_Ship.cs:349-363` toggles it on Start/Menu or `Backspace`;
// `Pause()` (`:524-538`) enables `Input_Look`, shows the gaze cursor, zeroes
// roll/pitch/yaw, releases the throttle and shows `panel_pause` — a world-space
// canvas reading "- PAUSE -" over three 3D buttons.
//
// ── How you pick one: gaze, then a button press ──────────────────────────
//
// Not dwell. Two of the three research passes disagreed about this and the code
// settles it (`A/FF_GearVR/Scripts/Input_Look.cs:163`):
//
//     if (Input.GetMouseButtonDown(0) || device.Action1.WasPressed)
//         hitObject.GetComponent<Button_Look_Simple>().Click();
//
// A 0.125 m spherecast against layer 18 finds what you are looking at, and A
// commits it. That model ports without change to both surfaces FF2 has: in a
// headset the gaze is the head pose, on a flat screen it is the camera forward,
// and "A" is already the confirm button on all three input routes.
//
// The hit test lives HERE rather than in the caller because it is a statement
// about this panel's own geometry — where the rows are, how tall they are — and
// a caller that has to know that is a caller that will get it wrong when the
// layout changes. It is also then testable without a renderer.

import * as THREE from 'three'
import { drawPlate, drawSelectedRow } from '@/render/ui-draw'
import { uiFontEpoch } from '@/render/ui-font'
import { type PlaneHit, rayPlaneHit, toPanelLocal } from '@/render/ui-pick'
import { createUiPlate, UI_PIXELS_PER_METRE } from '@/render/ui-plate'
import {
  UI_ACCENT as ACCENT,
  UI_DIM as DIM,
  uiFont as font,
  UI_INK as INK,
  uiType,
} from '@/render/ui-tokens'

/** One thing you can choose. `id` is what the caller switches on. */
export interface PauseOption {
  readonly id: string
  readonly label: string
  /** The line under it. Says what it does, in case the verb is ambiguous. */
  readonly note: string
  /**
   * The row's current SETTING, right-aligned against the label. Optional, and
   * absent on every action row.
   *
   * It exists for the comfort menu (PORT_PLAN §2.9 item 5), where a row is not a
   * verb but a state: VIGNETTE is `light`, and pressing A moves it on. Folding
   * that into `label` — "VIGNETTE: LIGHT" — reads fine on one row and turns a
   * column of settings into ragged prose you have to parse word by word, in a
   * headset, while feeling ill. A value column is scannable.
   */
  readonly value?: string
  /**
   * Paint the NOTE in the plate's accent, the colour of its heading, rather
   * than dim. DEV-379: the title's Learn to Fly row on a first visit, whose
   * note (*new here? start here*) is the one line on the plate addressed to a
   * stranger. Absent everywhere else, so every other plate draws as it did.
   */
  readonly accentNote?: boolean
}

export interface PauseState {
  readonly options: readonly PauseOption[]
  /** Index under the gaze, or −1. */
  readonly selected: number
  /**
   * DEV-861: the "press A to choose" footer is gone from every plate. What is
   * left is a footer a plate asks for by name: `PauseOptions.footer` reserves
   * the band, and this is its text (the lobby roster's room code). Unset on a
   * plate without the band.
   */
  readonly footer?: string
  /**
   * The panel's own heading — 2016's `- PAUSE -`, spaces and all.
   *
   * Supplied by the caller for the same reason `confirm` is: this module draws
   * a panel and does not know which mission's copy it is drawing. It comes from
   * `level.ui.strings.pauseTitle` and the port changes nothing about it.
   */
  readonly title: string
  /**
   * DEV-623: metres of open plate between the heading and the first row, for
   * a page that draws something of its own there (the credits roll,
   * `render/credits-roll.ts`). Absent or 0 is every other page, drawn as it
   * shipped. The painter, the plane and the hit test all read the one band,
   * so a ray into the body selects nothing, as a ray into the heading does.
   */
  readonly body?: number
  /**
   * DEV-859: draw a row's note only while that row is selected. The settings
   * pages set it (Matt's UX pass: *no wall of notes*): a page of eight rows
   * printed sixteen lines, and a stranger read all of them to find the one
   * they wanted. Absent or false is every plate as it shipped (the root pause
   * plate, the title, the TV plate), notes under every row.
   */
  readonly notesOnSelect?: boolean
}

// ── Which page the plate is turned to ────────────────────────────────────
//
// One plate draws four menus — the pause rows, comfort, controls, edition — and
// for the life of it "which one is up" existed only as a ladder of `.open`
// flags inside `createApp`'s closure, written out TWICE: once to pick the rows
// and once to pick the title. So the only way to ask what the plate was showing
// was to look at a PNG of it, and `controls-page.spec.ts` said so in as many
// words: *"the screenshot will say so, loudly, because it will be a picture of
// the comfort page."* A human looking at a picture is not a gate.
//
// Out here for the reason DEV-221 lifted `BACK_WORDS` and `backWordFor` out of
// `createHangar`'s: the question is about the menu's CONTENT, the answer is
// three plain values, and needing a DOM, a canvas and a GPU to get at them is
// what made the sentence uncheckable rather than anything about the sentence.
//
// It names no page but its own. A sub-page is identified by the ROOT ROW that
// opens it, so hard rule 6 holds — a fifth page is a fifth entry in the list
// `app.ts` hands in, and nothing in this file learns its name.

/**
 * What a sub-page has to be able to answer.
 *
 * Structural on purpose: `ComfortMenu`, `ControlsMenu` and `EditionMenu`
 * already satisfy it as they are, so this file imports none of them and a page
 * written tomorrow needs no change here.
 */
export interface PausePageSource {
  readonly open: boolean
  readonly title: string
  readonly rows: readonly PauseOption[]
}

/** A page the plate can turn to, and the row on the plate that opens it. */
export interface PauseSubPage {
  /**
   * The ROOT ROW this page hangs off — `CONTROLS_OPTION`, and so on.
   *
   * A `PauseOption` and not an id string, which is the whole anti-drift device:
   * the page's identity is that row's `id`, so the name a probe reports and the
   * row a player presses to get there are **the same object** and cannot come
   * apart. §5 of the orientation lesson.
   */
  readonly row: PauseOption
  readonly menu: PausePageSource
}

/** The plate as it stands: which page, what it says at the top, and the rows. */
export interface PausePage {
  /**
   * `ROOT_PAGE`, or the id of the row that opened the page that is up.
   *
   * This is what the plate is DRAWING. Whether it is on screen at all is a
   * different question with a different answer (an unpaused run hides it),
   * and the object's own `visible` flag is where that one is settled.
   */
  readonly page: string
  readonly title: string
  readonly rows: readonly PauseOption[]
}

/**
 * The plate itself: the page no row opens, named for the object in the scene.
 */
export const ROOT_PAGE = 'pause'

/**
 * Which page the plate is showing, as plain values.
 *
 * ONE function, for the same reason `rowTopM` is one function: the rows, the
 * title and the id must describe the same page or the plate is drawing a menu
 * whose heading belongs to another. Feed the result to `update()`, switch the
 * A press on it, and hand it to a probe — three consumers of one value rather
 * than three ladders that agree today.
 *
 * The FIRST open page wins. In practice at most one can be: a page is opened
 * from the root plate and closed before you are back on it. The order is
 * stated rather than relied on, so two somehow-open pages give a stable answer
 * instead of a different one per consumer.
 */
export const pausePage = (
  root: { readonly title: string; readonly rows: readonly PauseOption[] },
  pages: readonly PauseSubPage[],
): PausePage => {
  const open = pages.find((page) => page.menu.open)
  return open === undefined
    ? { page: ROOT_PAGE, title: root.title, rows: root.rows }
    : { page: open.row.id, title: open.menu.title, rows: open.menu.rows }
}

// ── Pressing a page: the same list, not a second ladder ──────────────────────
//
// `pausePage` made DRAWING one list. PRESSING a page stayed a ladder of
// `else if (comfortMenu.open) ... else if (controlsMenu.open) ...` in
// `boot/app.ts`, with a matching ladder to OPEN one from its row, a third list
// to shut them all, and a fourth to hand each its settings. Add a page and
// there were five places to remember, and DEV-269's Advanced page had already
// landed as the fourth arm of a ladder this file said it replaced.
//
// So the list `app.ts` hands `pausePage` carries what pressing needs, and
// these functions are the loops. A fifth page is a fifth entry, as the design
// above always said, and nothing here learns its name.

/**
 * A page the plate can open, shut and press, not only draw.
 *
 * `activate` is absent on a page whose rows the app acts on BY ID (OPTIONS: MUTE,
 * the row that opens each page, BACK); a page that has it takes its own presses
 * and shuts itself by returning `'back'`. `sync` folds in a setting some OTHER
 * page changed, and is silent (no save, no notify), or two pages loop.
 */
export interface PauseDoor<S = never> extends PausePageSource {
  openPage(): void
  closePage(): void
  activate?(index: number): string
  sync?(settings: S): void
}

/** A sub-page with a door: the row that opens it, plus how it opens. */
export interface PauseDoorPage<S = never> extends PauseSubPage {
  readonly menu: PauseDoor<S>
  /**
   * The aim a fresh page opens on. Absent is the first row; the credits open on
   * -1 (nothing selected, so A speeds the roll and BACK is a row below).
   */
  readonly openAim?: number
  /** Runs right after `openPage` (the credits put their roll back at the top). */
  readonly onOpen?: () => void
}

/**
 * The open page that takes the A press, or undefined: the plate is on the root,
 * or on OPTIONS, whose rows the caller acts on by id. FIRST open wins, in the
 * list's own order, as `pausePage` does, so the page that draws is the page that
 * presses.
 */
export const pageToPress = <S>(pages: readonly PauseDoorPage<S>[]): PauseDoorPage<S> | undefined =>
  pages.find((page) => page.menu.open && page.menu.activate !== undefined)

/** The page the row `rowId` opens, or undefined: a page's identity IS its row's `id`. */
export const pageOpenedBy = <S>(
  pages: readonly PauseDoorPage<S>[],
  rowId: string | null | undefined,
): PauseDoorPage<S> | undefined =>
  rowId == null ? undefined : pages.find((page) => page.row.id === rowId)

/** Open `page` and answer the aim it opens on (the caller owns the aim). */
export const openPausePage = <S>(page: PauseDoorPage<S>): number => {
  page.menu.openPage()
  page.onOpen?.()
  return page.openAim ?? 0
}

/** Shut the first page that is open, as BACK does: one page up. False when none was. */
export const closeOpenPausePage = <S>(pages: readonly PauseDoorPage<S>[]): boolean => {
  const open = pages.find((page) => page.menu.open)
  if (open === undefined) return false
  open.menu.closePage()
  return true
}

/** Every page shut, in the list's order, so the next pause opens on the root. */
export const shutPausePages = <S>(pages: readonly PauseDoorPage<S>[]): void => {
  for (const page of pages) page.menu.closePage()
}

/** Hand `settings` to every page that keeps a copy, in the list's order. */
export const syncPausePages = <S>(pages: readonly PauseDoorPage<S>[], settings: S): void => {
  for (const page of pages) page.menu.sync?.(settings)
}

export interface Pause {
  readonly object: THREE.Object3D
  setVisible(visible: boolean): void
  update(state: PauseState): void
  /**
   * Which option a ray is pointing at, or −1.
   *
   * `origin` and `direction` are WORLD space; `direction` need not be
   * normalised. Returns −1 for a ray that misses the panel, points away from
   * it, or lands on the title.
   */
  pick(origin: THREE.Vector3, direction: THREE.Vector3, optionCount: number): number
  /**
   * Hang the panel `metres` higher than the caller placed it (DEV-796); 0
   * puts it back. Idempotent, so a frame loop may assert it every frame. The
   * hit test reads the object's own transform, so a lifted panel is picked
   * where it is drawn.
   */
  setLift(metres: number): void
  dispose(): void
}

/**
 * How much higher the pause panel hangs than `flight.ts` placed it, metres,
 * on EVERY device (DEV-834; DEV-796 had it for touch only).
 *
 * DEV-834, Matt's playtest 2026-10-08: the panel sat cut off at the bottom of
 * the screen and a player who does not know to look down is lost. Measured at
 * the default flat eye (1280 x 720), a ten-row page ended at y 729 of 720. The
 * lift is bounded ABOVE by the title band: the band is 0.109 m deep and the eye
 * line already falls 0.03 m below its top, so a lift of 0.05 leaves the eye line
 * 0.029 m (about 2 degrees) inside the band, which is the property `PANEL_DROP`
 * protects. More than about 0.07 would put a row on the eye line.
 *
 * Written for the phone, DEV-796:
 *
 * The panel hangs below the eye on purpose (`PANEL_DROP`: a gaze that rests on
 * a row is re-selected every frame), and a seven-row page then runs its footer
 * past the bottom of a phone held sideways: a Pixel 7's OPTIONS page (915 x 412)
 * ended on the bottom edge, the BACK row last and the panel's lower border
 * cut off. A phone chooses by TAP and never by gaze, so the rule has nothing to
 * protect there and the panel can ride up. 0.05 m is about 3.3 degrees at
 * `PANEL_DISTANCE`, which clears the page with the border showing.
 */
export const PANEL_LIFT = 0.05

/** DEV-796 named this for the phone; DEV-834 made it every device's. Kept for the old name. */
export const TOUCH_PANEL_LIFT = PANEL_LIFT

/**
 * Panel size in metres, and its texture resolution.
 *
 * Bigger than the results panel, because this one is a TARGET as well as a
 * label. At 0.86 m the panel is 34 degrees across and each row subtends about
 * **6 degrees** — a head can hold 6 degrees comfortably and cannot reliably
 * hold 3, which is what the first pass at these numbers asked for.
 *
 * `REF_HEIGHT` is the THREE-ROW panel, and it is the reference for everything:
 * the type sizes, the title band, the footer, the pinned top edge. The panel
 * grows and shrinks with the row count (see `panelHeight`) and none of those
 * may grow with it.
 */
export const WIDTH = 0.56
/**
 * How far in front of the eye `game/flight.ts` hangs this panel, in metres.
 *
 * It was a literal at the one call site, and the comments here have described
 * its consequences — *"At 0.86 m the panel is 34 degrees across and each row
 * subtends about 6 degrees"* — since the panel was written. Two copies of one
 * number, one of them in prose, which is the shape CLAUDE.md spends a paragraph
 * on: move the plate and this file's whole argument becomes quietly false.
 *
 * Exported so the call site names it and so a reader can measure the distance
 * the panel is ACTUALLY at rather than the one the comment claims (DEV-220).
 */
export const PANEL_DISTANCE = 0.86
const REF_ROWS = 3
const REF_HEIGHT = 0.42
const PIXELS_PER_METRE = UI_PIXELS_PER_METRE
/** The three-row canvas, in pixels. Every type size is a fraction of THIS. */
const REF_PIXELS = REF_HEIGHT * PIXELS_PER_METRE

/**
 * Fraction of the THREE-ROW panel height given to the title before the first
 * row, and to each option row after it.
 *
 * Sized so THREE rows fit above the footer: 0.26 + 3 x 0.2 = 0.86, and "press A
 * to choose" sits at 0.94. The first version was cut for two rows (0.3 + 0.22)
 * and DEV-033b's third option — added the day the hangar gave it somewhere to
 * go — ran straight into the footer.
 *
 * They are converted to METRES immediately below and nothing downstream uses
 * the fractions, because a fraction of a panel whose height varies is not a
 * length. Keeping the two original fractions as the source is what makes the
 * three-row case arithmetically identical to what shipped rather than nearly
 * identical — and "nearly" in a hit test is the bug that renders perfectly and
 * plays wrong.
 */
const TITLE_FRACTION = 0.26
const ROW_FRACTION = 0.2
const FOOTER_BASELINE_FRACTION = 0.94

export const TITLE_M = TITLE_FRACTION * REF_HEIGHT
const ROW_M = ROW_FRACTION * REF_HEIGHT
/** The band a plate that asks for a footer keeps (`PauseOptions.footer`). */
export const FOOT_M = (1 - TITLE_FRACTION - REF_ROWS * ROW_FRACTION) * REF_HEIGHT
/**
 * DEV-861: what every other plate keeps under its last row: a quarter of a
 * row of margin, the same gap `HEADLESS_TITLE_M` leaves over the first. The
 * choose hint's band used to be here, empty once the hint went.
 */
export const FOOT_SLIM_M = ROW_M * 0.25
const FOOTER_FROM_BOTTOM_M = (1 - FOOTER_BASELINE_FRACTION) * REF_HEIGHT

/**
 * The panel's TOP EDGE, in panel-local metres. Pinned, for any row count.
 *
 * This is the load-bearing decision that lets the comfort menu exist without
 * touching `game/flight.ts`. `flight.ts` places this panel's ORIGIN at
 * `EYE.y - PANEL_DROP`, so if the panel grew symmetrically its top edge would
 * climb past the eye line and the "a ray along the eye line lands in the title
 * band" property — the one thing that makes the stick usable — would quietly
 * stop holding at four rows. Pinning the top and growing DOWNWARD keeps the
 * title band exactly where it was measured, whatever is on the panel.
 */
export const TOP_LOCAL_Y = REF_HEIGHT / 2

/**
 * Total height the rows may take before they start shrinking, in metres.
 *
 * 0.48 m at 0.86 m away is 32 degrees of list, which is a deliberate look down
 * and not a neck injury. Up to FIVE rows nothing shrinks at all (5 x 0.084 =
 * 0.42); the comfort menu's seven rows come out at 0.0686 m, or **4.6 degrees**
 * each. That is below the 6 degrees this panel was sized for and above the 3
 * the first pass was rejected at — a real trade, made because the alternative
 * was a 42-degree list whose bottom row you cannot see without leaning.
 *
 * It is survivable because the gaze is not the only way to move the selection:
 * `app.ts` steps the list with the stick and the gaze only overrides when it is
 * actually on a row. "Can you hit the bottom row of the comfort menu with your
 * head" is a worn question, not something a test can answer.
 */
const ROWS_MAX_M = 0.48

/** The height of one row, in metres, for a panel showing `count` of them. */
export const rowBand = (count: number): number =>
  count > 0 && count * ROW_M > ROWS_MAX_M ? ROWS_MAX_M / count : ROW_M

/** The whole panel's height in metres, for `count` rows. */
export const panelHeight = (
  count: number,
  titleM: number = TITLE_M,
  footM: number = FOOT_SLIM_M,
): number => titleM + Math.max(0, count) * rowBand(count) + footM

/**
 * The title band of a plate drawn with NO heading (DEV-619): a margin, so the
 * first row's selection box does not sit on the plate's rounded top edge. A
 * quarter of a row, which is the gap the footer's line keeps under the last
 * row. Every layout function below takes the band as its last argument, the
 * full `TITLE_M` by default, so a plate with a heading is the plate that
 * shipped to the last bit.
 */
export const HEADLESS_TITLE_M = ROW_M * 0.25

/**
 * How far BELOW the eye the panel's ORIGIN hangs, in metres. `flight.ts` places
 * it, and does not need to know the row count because of `TOP_LOCAL_Y`.
 *
 * Not decoration, and it lives here rather than at the call site because the
 * constraint it satisfies is about this panel's own bands. The menu is aimed
 * with the gaze; on a flat screen the gaze is the ship's forward, and with the
 * sim frozen the ship cannot turn. So if a ROW sat on the eye line it would be
 * re-selected every frame and the stick could never move off it.
 *
 * Hung this far down, a ray along the eye line lands in the TITLE band — no
 * selection — and the first row starts about 6 degrees below it. That is the
 * property `pause-menu.test.ts` asserts, because it is arithmetic I did myself
 * and a number you derived has no provenance machinery behind it (DEV-027).
 */
export const PANEL_DROP = 0.18

/**
 * DEV-897: where the pause plate's ORIGIN stands relative to the eye, in the frame of
 * the view: `PANEL_DISTANCE` ahead and `PANEL_DROP` below, turned by `pitchRad` about
 * x (0 for a level view: the cockpit, a headset) and moved up by `lift` metres
 * (`Pause.setLift`, the phone's centring). The ONE place the plate's offset is
 * written: the cockpit (`game/flight.ts`) adds it to the eye, and the hangar's and
 * the title's OPTIONS plates (`render/options-plate-pose.ts`) use it, so a plate that
 * shows the pause plate's page stands where the pause plate does.
 */
export const pausePlateOffset = (pitchRad = 0, lift = 0): readonly [number, number, number] => {
  const y = -PANEL_DROP + lift
  const z = -PANEL_DISTANCE
  const c = Math.cos(pitchRad)
  const s = Math.sin(pitchRad)
  return [0, y * c - z * s, y * s + z * c]
}

// The palette and the face are `ui-tokens.ts`'s, the HUD's, because this is the
// same instrument; they are imported under the short names this file draws with.

/**
 * The top edge of row `i`, in panel-local METRES measured DOWN from the panel's
 * top edge. The painter's native units.
 *
 * One function, used by both the painter and the hit test, so the thing you
 * look at and the thing you hit cannot drift apart. That drift is the entire
 * failure mode of a world-space menu, and it is invisible in a screenshot —
 * the panel renders perfectly either way.
 */
export const rowTopM = (i: number, count = REF_ROWS, titleM: number = TITLE_M): number =>
  titleM + i * rowBand(count)

/**
 * The top edge of row `i`, as a fraction of the panel height from the top.
 *
 * Kept because it is the shape the original painter and its test speak in, and
 * because a fraction is the honest unit for "how far down this panel is it".
 * `count` defaults to three, which is what shipped — so every existing call
 * returns exactly what it always did.
 */
export const rowTop = (
  i: number,
  count = REF_ROWS,
  titleM: number = TITLE_M,
  footM: number = FOOT_SLIM_M,
): number => rowTopM(i, count, titleM) / panelHeight(count, titleM, footM)

/**
 * Row `i`'s visual centre, in panel-local metres, +y UP from the panel ORIGIN.
 *
 * The bridge between the two coordinate conventions in this file: the painter
 * measures DOWN from the top edge in canvas pixels, the hit test works in plane
 * space where +y is up from the origin. Exported because that conversion is the
 * one thing here that is easy to get backwards, and a test that aims at a row's
 * centre and checks it comes back is the only thing that would notice.
 *
 * Note it is measured from the ORIGIN and not from the panel's centre — the two
 * are the same thing only at three rows. With the top edge pinned at
 * `TOP_LOCAL_Y` this is INDEPENDENT of the row count for any panel of five rows
 * or fewer, which is why the three-row and two-row cases the original test pins
 * down are unchanged to the last bit.
 */
export const rowCentreLocalY = (i: number, count = REF_ROWS, titleM: number = TITLE_M): number =>
  TOP_LOCAL_Y - (titleM + (i + 0.5) * rowBand(count))

// Volatile, and valid only inside one `pickLocal` call.
const _hit: PlaneHit = { x: 0, y: 0 }

/**
 * Which row a ray hits, in PANEL-LOCAL space. −1 for a miss.
 *
 * Split out from `pick` so it can be tested without a DOM: `createPause` needs
 * a canvas and the unit suite runs `environment: 'node'` on purpose (that is
 * what buys renderer-free sim tests). Everything that can be wrong about this
 * menu's geometry is in here; the world-space half is one matrix inverse.
 *
 * `optionCount` decides the LAYOUT as well as the range, so the caller must
 * pass the same count it last handed to `update()`. It does — `app.ts` reads
 * both off one array — and passing a stale one is the drift this whole file is
 * arranged to prevent.
 */
export const pickLocal = (
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  optionCount: number,
  titleM: number = TITLE_M,
): number => {
  // Parallel to the panel, or behind the eye (the panel is that way, not this
  // way): a miss. The one plane solve, `ui-pick.ts`.
  if (!rayPlaneHit(_hit, ox, oy, oz, dx, dy, dz)) return -1
  const x = _hit.x
  const y = _hit.y
  if (Math.abs(x) > WIDTH / 2) return -1
  // Metres down from the PINNED top edge, not a fraction of a height that now
  // varies. Above the top edge this is negative and falls out below.
  const fromTop = TOP_LOCAL_Y - y
  const band = rowBand(optionCount)
  const intoRows = fromTop - titleM
  if (intoRows < 0) return -1
  const i = Math.floor(intoRows / band)
  // Past the last row is the footer, and past the footer is the cockpit.
  return i >= 0 && i < optionCount ? i : -1
}

/**
 * How a row's words sit on it. `left` is every plate the game had until
 * DEV-610: the label and the note flush left at the pad, the value flush
 * right. `center` is the title's (Matt, 2026-10-03: *"center the text on their
 * buttons (start, vr)"*): the label and the note centred on the row, and a
 * value, where a row has one (a shared lap's handle, a course's island), kept
 * on the label's line after it, the two centred as one run. A value pushed to
 * the right edge of a centred row would read as a third column nobody asked
 * for.
 */
export type RowAlign = 'left' | 'center'

/** Where `draw` puts a row's three strings, in canvas pixels. */
export interface RowTextAnchors {
  readonly labelX: number
  readonly labelAlign: 'left' | 'center'
  /** Null for a row with no value. */
  readonly valueX: number | null
  readonly valueAlign: 'left' | 'right'
  readonly noteX: number
  readonly noteAlign: 'left' | 'center'
}

/** The gap between a centred row's label and its value, as a fraction of the label's type size. */
export const CENTRED_VALUE_GAP_EM = 0.6

/**
 * The anchors for one row on a plate `w` pixels wide with a `pad` margin.
 * `labelW` and `valueW` are the two strings' MEASURED widths at the label's
 * size (`valueW` null for no value), and `gap` the space between them; only a
 * centred row with a value reads them. Pure, so the layout is testable without
 * a canvas.
 */
export const rowTextAnchors = (
  align: RowAlign,
  w: number,
  pad: number,
  labelW: number,
  valueW: number | null,
  gap: number,
): RowTextAnchors => {
  if (align === 'left') {
    return {
      labelX: pad,
      labelAlign: 'left',
      valueX: valueW === null ? null : w - pad,
      valueAlign: 'right',
      noteX: pad,
      noteAlign: 'left',
    }
  }
  if (valueW === null) {
    return {
      labelX: w / 2,
      labelAlign: 'center',
      valueX: null,
      valueAlign: 'left',
      noteX: w / 2,
      noteAlign: 'center',
    }
  }
  // Label, gap, value: one run, centred. Drawn from its left edge.
  const run = labelW + gap + valueW
  const left = (w - run) / 2
  return {
    labelX: left + labelW / 2,
    labelAlign: 'center',
    valueX: left + labelW + gap,
    valueAlign: 'left',
    noteX: w / 2,
    noteAlign: 'center',
  }
}

/**
 * DEV-623: the centre of a page's body band (`PauseState.body`), in
 * panel-local metres, +y up from the ORIGIN, on a plate with a heading. What a
 * page hangs there (the credits roll) is placed by this, so it sits in the
 * band the hit test treats as a miss.
 */
export const bodyCentreLocalY = (body: number, titleM: number = TITLE_M): number =>
  TOP_LOCAL_Y - titleM - body / 2

/** How a plate is drawn. Every option is optional and its absence is the plate that shipped. */
export interface PauseOptions {
  /** How each row's words sit on it (DEV-610). Default `left`. */
  readonly align?: RowAlign
  /**
   * Draw the heading (`state.title`) in its band. Default true. False is the
   * title's plate since DEV-619 (Matt: *"let's remove "-Fly-" from the title
   * screen menu panel"*): no heading, and the band closes up to
   * `HEADLESS_TITLE_M`, so the rows sit at the plate's top. The painter, the
   * plane and the hit test all read the one band, `titleBandM` below.
   */
  readonly heading?: boolean
  /**
   * DEV-861: keep the full footer band and draw `PauseState.footer` in it.
   * Default false: the plate closes up under its last row.
   */
  readonly footer?: boolean
}

/** The title band a plate built with `options` has, in metres. */
export const titleBandM = (options: PauseOptions = {}): number =>
  options.heading === false ? HEADLESS_TITLE_M : TITLE_M

export const createPause = (options: PauseOptions = {}): Pause => {
  const align: RowAlign = options.align ?? 'left'
  const headM = titleBandM(options)
  const footM = options.footer === true ? FOOT_M : FOOT_SLIM_M
  /** The heading's band plus the page's body (DEV-623): where the rows start. */
  let titleM = headM
  /**
   * A plane of `count` rows, translated so its TOP EDGE lands on
   * `TOP_LOCAL_Y`: it grows downward from a fixed anchor rather than outward
   * from its centre. At three rows the translation is exactly zero and this is
   * the geometry that shipped.
   */
  const buildGeometry = (h: number) => {
    const geometry = new THREE.PlaneGeometry(WIDTH, h)
    geometry.translate(0, TOP_LOCAL_Y - h / 2, 0)
    return geometry
  }

  // The canvas, its texture, the unlit overlay material and the plane (`ui-plate.ts`).
  // `toneMapped: false` there is what puts this plate on UI_LAYER (DEV-081, DEV-141):
  // this one plate carries the pause rows AND the comfort, controls and edition
  // pages, so it is four menus' worth of legibility on one flag. `depthTest:
  // false` is the HUD's and the results panel's reasoning: the camera is inside
  // the cockpit, and a menu you cannot read because a strut is in front of it is
  // not a menu.
  const plate = createUiPlate({
    name: 'pause',
    widthM: WIDTH,
    heightM: panelHeight(REF_ROWS, titleM, footM),
    renderOrder: 12, // above the results panel, which is 11
    pxPerM: PIXELS_PER_METRE,
    geometry: buildGeometry,
  })
  const { canvas, ctx, object } = plate

  let rows = REF_ROWS

  let signature = ''

  /** DEV-796: how far {@link Pause.setLift} has moved the object from where it was placed. */
  let lifted = 0

  /** Resize the plane and the canvas for a page with a different row count or body. */
  const resize = (count: number, band: number) => {
    if (count === rows && band === titleM) return
    rows = count
    titleM = band
    // A canvas whose size changed is a NEW texture (`ui-plate.ts`), which is why
    // this is not a `needsUpdate`.
    plate.resize(panelHeight(count, titleM, footM))
  }

  const draw = (state: PauseState) => {
    const count = state.options.length
    const w = canvas.width
    const h = canvas.height
    // Type is sized against the THREE-ROW panel and never against `h`. A title
    // that grows with the row count is the classic bug of this refactor: the
    // panel gets taller, every fraction-of-height font gets bigger with it, and
    // a seven-row menu renders as three rows of enormous text and a scrollbar
    // nobody wrote.
    const ref = REF_PIXELS
    const band = rowBand(count) * PIXELS_PER_METRE
    // Rows that shrink take their type with them, so the label keeps its
    // proportion inside the row instead of colliding with the note.
    const type = rowBand(count) / ROW_M
    ctx.clearRect(0, 0, w, h)

    // DEV-647: the broadcast look: a flat plate, a hairline, one accent bar. The
    // three sizes come from the title's (`uiType`): label 0.7, sub-line 0.46.
    const t = uiType(ref * 0.11, PIXELS_PER_METRE)
    const bar = ref * 0.022
    drawPlate(ctx, w, h, { bar, lineWidth: Math.max(2, ref * 0.005) })

    // ── the title, in 2016's own punctuation ────────────────────────────
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    if (options.heading !== false) {
      ctx.fillStyle = ACCENT
      ctx.font = font(t.title)
      ctx.fillText(state.title, w / 2, ref * 0.15)
    }

    // ── the options ─────────────────────────────────────────────────────
    const pad = w * 0.07
    state.options.forEach((option, i) => {
      const top = rowTopM(i, count, titleM) * PIXELS_PER_METRE
      const on = i === state.selected
      if (on) {
        drawSelectedRow(ctx, pad * 0.5, top, w - pad, band, bar * 0.7)
      }
      const labelPx = t.label * type
      ctx.font = font(labelPx)
      const label = option.label.toUpperCase()
      const value = option.value?.toUpperCase()
      const at = rowTextAnchors(
        align,
        w,
        pad,
        align === 'center' && value !== undefined ? ctx.measureText(label).width : 0,
        value === undefined ? null : align === 'center' ? ctx.measureText(value).width : 0,
        labelPx * CENTRED_VALUE_GAP_EM,
      )
      ctx.textAlign = at.labelAlign
      ctx.fillStyle = on ? ACCENT : INK
      ctx.fillText(label, at.labelX, top + band * 0.36)
      // The setting, in the accent colour: right-aligned on a left plate so a
      // column of them scans top to bottom without reading a word of the
      // labels, and after the label on a centred one (`rowTextAnchors`).
      if (value !== undefined && at.valueX !== null) {
        ctx.textAlign = at.valueAlign
        ctx.fillStyle = ACCENT
        ctx.fillText(value, at.valueX, top + band * 0.36)
      }
      if (state.notesOnSelect !== true || on) {
        ctx.textAlign = at.noteAlign
        ctx.fillStyle = option.accentNote === true ? ACCENT : DIM
        ctx.font = font(t.sub * type, 500)
        ctx.fillText(option.note, at.noteX, top + band * 0.74)
      }
    })

    // ── the footer, on a plate that asked for the band (DEV-861) ─────────
    if (options.footer === true) {
      ctx.textAlign = 'center'
      ctx.fillStyle = DIM
      ctx.font = font(t.sub, 600)
      ctx.fillText(
        (state.footer ?? '').toUpperCase(),
        w / 2,
        h - FOOTER_FROM_BOTTOM_M * PIXELS_PER_METRE,
      )
    }

    plate.commit()
  }

  // Volatile, and valid only inside `pick`.
  const _origin = new THREE.Vector3()
  const _direction = new THREE.Vector3()

  return {
    object,
    setVisible(visible: boolean) {
      object.visible = visible
    },
    update(state: PauseState) {
      const next = [
        state.selected,
        state.footer ?? '',
        state.title,
        state.body ?? 0,
        state.notesOnSelect === true,
        // One repaint when the broadcast sans lands (`ui-font.ts`).
        uiFontEpoch(),
        // `value` is in the signature because on the comfort page it is the ONLY
        // thing that changes when you press A: the id, the label and the note
        // are identical before and after, so a signature without it would leave
        // VIGNETTE reading LIGHT for the rest of the session.
        // The accent is drawn, so it is in the signature too (DEV-379).
        state.options
          .map((o) => `${o.id}:${o.label}:${o.note}:${o.value ?? ''}:${o.accentNote === true}`)
          .join(','),
      ].join('|')
      if (next === signature) return
      signature = next
      // Before the draw, because the draw reads `canvas.height`.
      resize(state.options.length, headM + Math.max(0, state.body ?? 0))
      draw(state)
    },
    setLift(metres: number) {
      object.position.y += metres - lifted
      lifted = metres
    },
    pick(origin: THREE.Vector3, direction: THREE.Vector3, optionCount: number): number {
      // Into the panel's own space, where the plane is z = 0 and the rows are
      // rectangles. `matrixWorld` is stale inside an XR frame callback until
      // `render()` runs (CLAUDE.md), so refresh it rather than trusting the
      // caller — it costs one matrix compose on the frames the menu is up.
      toPanelLocal(object, origin, direction, _origin, _direction)
      return pickLocal(
        _origin.x,
        _origin.y,
        _origin.z,
        _direction.x,
        _direction.y,
        _direction.z,
        optionCount,
        titleM,
      )
    },
    dispose() {
      plate.dispose()
    },
  }
}
