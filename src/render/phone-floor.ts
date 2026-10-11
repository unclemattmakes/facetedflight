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
/**
 * DEV-902: a phone's title is its own layout, two columns. Matt, 2026-10-10: *"titlescreen
 * could use a re-work on mobile, lots of overlapping and hard to read elements. it's ok if
 * mobile has a different title."* A sideways phone is twice as wide as it is tall, and the
 * desktop's one column (emblem, edition line, rows, version line) stacked four things into
 * 360 px, where each fix to one pair (DEV-895, the plate's lift) pushed into the next. So
 * the emblem and its edition line stand in the LEFT half and the rows in the RIGHT, side
 * by side and both clear of the version line along the foot; the add-to-home-screen card
 * is a chip in the top right corner until it is opened (`input/home-screen-guide.ts`).
 *
 * The view turns this far right of the emblem (still level), which puts the emblem's right
 * edge about 4 degrees left of centre.
 */
export const TITLE_PHONE_GAZE_YAW_DEG = 20
/**
 * The rows plate's scale on a phone (on the pause plate's own metres, at
 * `TITLE_MENU_DISTANCE`): a row 0.145 of the lens's half-height tall, which is 37 px on a
 * 360 px phone, so a row's note (two thirds of a label) is 9.5 px, over the small floor.
 * A flat plane square to the view, so every row is the same size on the glass.
 */
export const TITLE_PHONE_SCALE = 3.45
/** How far right of centre the phone's plate stands: its centre's bearing, degrees. */
export const TITLE_PHONE_BEARING_DEG = 33.4
/** And its centre's height, degrees from the eye line (negative is below). */
export const TITLE_PHONE_CENTRE_DEG = -1.2
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
/**
 * The title's edition line under the emblem. DEV-902: x1.55, 14 px on a 360 px phone (x1.25
 * set it at 11.5). It hangs where a desktop's does, under the emblem, since the rows moved
 * beside it (DEV-895 had lifted it into the gap above a plate hung underneath).
 */
export const PROMPT_PHONE_SCALE = 1.55

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
