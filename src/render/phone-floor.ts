// src/render/phone-floor.ts: the floor under every plate a phone shows. DEV-894.
//
// Matt, 2026-10-09, playing on his phone: *"the UI panels are too small to read
// and hard to tap."* The plates are world-mounted canvases sized by the angle
// they subtend for a HEAD in a headset; a phone held sideways is a 412 px tall
// window onto the same angles, so a row that is 6 degrees tall (36 px on a 720p
// monitor) is 20 px on a Pixel 7 and its 0.7-em label is 8 px. One floor,
// written once, that a unit test pins and an e2e sweep (`phone-plates.spec.ts`)
// measures every plate against:
//
//   * BODY text, the size most of a plate's characters are set in: 12 css px.
//     The usual mobile minimum for running text.
//   * SMALL text, a plate's secondary lines (a row's note, a table's ghost
//     line): 9 css px. Not 12: a note two thirds the label's size is the type
//     scale's own ratio (`UI_TYPE_RATIO`), and an OPTIONS page of eight rows
//     cannot hold 12-px notes and a 32-px row in 412 px of glass at once.
//   * A TAP target: 32 css px tall. Material's compact list row is 32 dp and
//     iOS asks 44 pt for an isolated control; eight OPTIONS rows at 44 plus a
//     heading are 440 px, which does not fit a 412 px phone, so the single
//     floor is the one every page can meet. A lone button may be larger.
//
// The fix is to scale the PLATE for a phone (`phonePlateBoost`), never to shrink
// type, and only where the measured plate is under the floor: a desktop and a
// headset keep the sizes they have.

import { PANEL_DROP, panelHeight, TITLE_M, TOP_LOCAL_Y } from '@/render/pause'

/** The smallest text most of a plate is set in, css px. */
export const PHONE_MIN_BODY_TEXT_PX = 12
/** The smallest any secondary line may be, css px. */
export const PHONE_MIN_SMALL_TEXT_PX = 9
/** The smallest a pressable row or table is, css px. */
export const PHONE_MIN_TAP_PX = 32

/**
 * How much a phone scales each plate over what a desktop gets, from the sweep's
 * measurements on a Pixel 7 held sideways (915 x 412), where the pause plate's rows
 * were 20 px apart with 7 px body text and 5 px notes: x1.8 lifts them to 37 px, 13 px
 * and 9.4 px, and an eight-row page is then 91 percent of the glass, so a phone's
 * plate is CENTRED on the view instead of hung under its title line.
 */
export const PAUSE_PHONE_SCALE = 1.8
/** The title's rows plate on a phone: x1.7 over a desktop's (rows 21 px apart, text 9 px). */
export const TITLE_PHONE_BOOST = 1.67
/** Where the title's rows plate's top edge hangs on a phone, degrees below the eye (a desktop: 12.5; negative is above). */
export const TITLE_PHONE_TOP_DEG = 1
/** A hangar table's label (name, detail, ghost line) on a phone. */
export const LABEL_PHONE_SCALE = 1.8
/** The aimed table's detail strip (the lines a phone label leaves out). */
export const DETAIL_PHONE_SCALE = 1.3
/** The hangar's step header over the tables. */
export const HEADER_PHONE_SCALE = 1.6
/** The place step's caption and legend lines. */
export const CAPTION_PHONE_SCALE = 2.1
/** The words on the hangar's BACK and PAGE plates. */
export const PLATE_PHONE_SCALE = 2.1
/** The results panel and the lap questions beside it. */
export const RESULTS_PHONE_SCALE = 2.5
/** And it stands this far left of centre (metres), so the lap questions beside it stay on the glass. */
export const RESULTS_PHONE_SHIFT_M = -0.55
/**
 * The room lobby's two plates on a phone: x1.35 over their desktop scale, standing
 * +-28 degrees off the chair's forward (the pair would touch at +-19 once larger) and
 * centred on the eye line (a seven-row roster at this scale is 48 degrees tall).
 */
export const LOBBY_PHONE_BOOST = 1.35
export const LOBBY_PHONE_BEARING_DEG = 28
/** The join-code keypad on a phone: x1.7 over the title's scale, centred on the eye line. */
export const CODE_PLATE_PHONE_BOOST = 1.7
/** The title's edition line under the emblem. */
export const PROMPT_PHONE_SCALE = 1.25
/**
 * DEV-895: how far below the sightline to the emblem the edition line hangs on a phone,
 * degrees (a desktop: 17.5). The phone's rows plate is larger and hangs under the line,
 * so the line rides in the gap between the emblem and the plate's top edge.
 */
export const PROMPT_PHONE_BELOW_DEG = 9.5

/**
 * Whether the page is on a phone (the game's touch mode on a screen whose short
 * side is under `PHONE_SHORT_SIDE_PX` = 600). Set once at boot by `bootApp`; a
 * desktop, a tablet and a headset read false, so nothing below changes for them.
 */
export const phoneUi: { on: boolean } = { on: false }

/**
 * The factor a phone's plate is scaled by, beyond what a desktop gets: the
 * smallest that lifts `measuredPx` (what the plate measures on the phone now,
 * css px) to `floorPx`, never below 1, and never above `cap` so a plate that is
 * mostly tiny type is not blown across the glass.
 */
export const phonePlateBoost = (measuredPx: number, floorPx: number, cap = 2.4): number =>
  measuredPx >= floorPx ? 1 : Math.min(cap, floorPx / Math.max(0.001, measuredPx))

/**
 * The pause plate on a phone: its scale, and the lift (metres, `Pause.setLift`) that
 * centres it on the eye line for a page of `rows` rows under a title band of
 * `titleM` metres. The plate is hung `PANEL_DROP` below the eye with its top pinned
 * at `TOP_LOCAL_Y`, so the lift that puts its middle on the eye line is
 * `PANEL_DROP - (TOP_LOCAL_Y - height / 2) * scale`.
 */
export const pausePhoneFit = (
  rows: number,
  titleM: number = TITLE_M,
): { readonly scale: number; readonly lift: number } => {
  const height = panelHeight(rows, titleM)
  return {
    scale: PAUSE_PHONE_SCALE,
    lift: PANEL_DROP - (TOP_LOCAL_Y - height / 2) * PAUSE_PHONE_SCALE,
  }
}
