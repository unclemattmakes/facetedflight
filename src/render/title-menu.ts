// src/render/title-menu.ts: the title screen's choices. DEV-353; since
// DEV-558, two rows: START and ENTER VR.
//
// Matt, 2026-10-01, after a short play of 0.14.0: *"Title Screen: Start, Enter
// VR. Clicking either should take us to the Hangar, where the first set of
// choices are: Single Player / Multiplayer / FFTV."*
//
// So the title is the way in and nothing else. Everything the plate used to
// hold moved to the hangar's holotables (`render/hangar-doors.ts`): DEV-441's
// Single Player and Multiplayer doors and the pages behind them, DEV-480's TV
// row, and DEV-467's COURSES hub (onto the Custom Courses shelf). Quick Race
// (DEV-353) and Learn to Fly (DEV-379) left with them: Learn to Fly IS the
// Flight School plan, and Quick Race is not in the menus (DEV-558's row says
// why, and where it would go back). In a headset the hangar is the whole UI,
// and a table is what every device there already aims.
//
// The rows, top to bottom:
//
//   a LINK's row, when a link brought the page here: a shared lap's RACE
//          THIS LAP (DEV-373; DEV-571's words), or a shared course (DEV-467),
//          or why that course was refused. First, and aimed, so the press the
//          link was sent for is still the first one.
//   WATCH THIS LAP, under a shared lap's RACE row where the build has TV
//          (DEV-571, Matt: *"when clicking a shared lap - ask if i want to
//          watch or race the shared lap"*): TV's lap show (DEV-480/483), the
//          lap flown among the AI racers under TV's camera.
//   START  the hangar. Flat; and in a headset, where it is the only row.
//   ENTER VR  a session, and then the hangar (DEV-557's plate, made a row).
//          It reads CONNECT VR HEADSET where the platform says there is none,
//          and a press asks again. Absent where the page can show none: in a
//          headset (you are in VR), and on a touch device with no headset (a
//          phone; DEV-557's call 2), so a phone's title is START (and the newsletter, below).
//   THE MAKING-OF  the making-of site (`/making-of/`), in this tab (DEV-802;
//          Matt, 2026-10-07: *"add one more option to the title screen"*).
//          Second to last, no note. Absent in a headset, where a page
//          navigation would drop the session.
//   JOIN THE FLIGHT CLUB  the newsletter's signup page, in a new tab
//          (DEV-658; Matt, 2026-10-05: *"add it to the same panel as the start
//          button, remove the extra text"*). Last, and no note. Absent in a
//          headset, where a tab would open behind the eyes.
//
// A room's link (`?room=`) has no row: START goes to the hangar, and the room's
// lobby is up there, as it always was. START's note says so. A `?tv` or
// `?watch=` link boards on the page's first press (DEV-557), as before.
//
// ── It is the pause plate, on purpose ─────────────────────────────────────
//
// `render/pause.ts` already is a world-space plate whose painter and hit test
// share one layout function (`rowTopM`), and every one of the title's inputs
// already aims it: the stick and the arrow keys walk its rows, a head or a
// laser (DEV-321) picks one by ray, a finger picks one by ray (DEV-291), and
// A, Enter, the trigger or a click commits. A second plate built beside it
// would be a second hit test to drift from its own painter, which is the one
// failure a world-space menu has. (DEV-557's ENTER VR plate was exactly that,
// beside the rows; it is a row now, and its hit test went with it.)
//
// ── Where it hangs ────────────────────────────────────────────────────────
//
// Under the rig, straight ahead and below the eye line, facing the eye: the
// emblem is ABOVE the sightline (10.85 degrees, DEV-068) and the edition's
// name sits on the valley floor at about 8 degrees below it (DEV-285), so the
// plate starts under that line and ends inside a flat 70-degree frame. Under
// the rig and not in the world because in a headset the rig is what carries
// the reference space — the plate is world-locked relative to where you stand,
// never head-locked, and the local reference space puts the head at the rig's
// origin (`render/renderer.ts`).
//
// A PHONE is the exception (DEV-902): its title is two columns, the emblem on the
// left and this plate on the right, centred on its own height (`phone-floor.ts`).
//
// Farther than the pause plate's 0.86 m and scaled to match: there is no
// cockpit here to hang it inside, and a title plate an arm's length from a
// stranger's face in a headset is a lot of plate. The angles below are what is
// being chosen; the metres follow from them.

import type * as THREE from 'three'
import { NEWSLETTER_LABEL } from '@/net/newsletter'
import { angleDeg, topEdgeY } from '@/render/eye-plate'
import {
  type PauseOption,
  type PauseOptions,
  panelHeight,
  type RowAlign,
  rowBand,
  TOP_LOCAL_Y,
  titleBandM,
  WIDTH,
} from '@/render/pause'
import {
  phoneUi,
  TITLE_PHONE_BEARING_DEG,
  TITLE_PHONE_CENTRE_DEG,
  TITLE_PHONE_SCALE,
} from '@/render/phone-floor'
import { type TitleVrState, titleVrText } from '@/render/title-vr'

/**
 * START: the hangar (DEV-558). The id is the row's old one, `hangar`, because
 * it goes where that row went, and every spec and log that named it means it.
 */
export const START_ROW: PauseOption = {
  id: 'hangar',
  label: 'Start',
  note: 'into the hangar',
}

/** OPTIONS' row id on the title (DEV-859). Same as the pause plate's row for the same page. */
export const OPTIONS_ROW_ID = 'options'

/**
 * DEV-859: OPTIONS, under START (UX pass decision 1: the settings were
 * reachable only from a pause mid-flight). Opens the one OPTIONS page
 * (`render/options-menu.ts`) on this plate, in a headset as well as on a flat
 * screen. No note: the page is what it says.
 */
export const optionsRow = (): PauseOption => ({
  id: OPTIONS_ROW_ID,
  label: 'Options',
  note: '',
})

/** The making-of row's id (DEV-802). */
export const MAKING_OF_ROW_ID = 'making-of'

/** Where the making-of row goes: the site's front page, same origin. */
export const MAKING_OF_PATH = '/making-of/'

/** DEV-802: the making-of site, just above the newsletter. No note. */
export const makingOfRow = (): PauseOption => ({
  id: MAKING_OF_ROW_ID,
  label: 'The making-of',
  note: '',
})

/** The newsletter row's id (DEV-658). */
export const NEWSLETTER_ROW_ID = 'newsletter'

/**
 * DEV-658: the newsletter, last on the plate. Matt, 2026-10-05: *"remove the
 * extra text"*, so no note, and *"if there's an email icon or something, add
 * that next to it"*: U+2709, which the label's face does not carry and the
 * browser draws from a system face. `blocked` is a press whose tab the browser
 * refused (a pad's press carries no user activation): the note then says what
 * will work, in the accent, as ENTER VR's does.
 */
export const newsletterRow = (blocked = false): PauseOption => ({
  id: NEWSLETTER_ROW_ID,
  label: `✉ ${NEWSLETTER_LABEL}`,
  note: blocked ? 'the browser blocked the tab: click, tap or press Enter' : '',
  ...(blocked ? { accentNote: true } : {}),
})

/** ENTER VR's row id (DEV-558; DEV-557's plate, made a row). */
export const ENTER_VR_ROW_ID = 'enter-vr'

/**
 * The ENTER VR row for the state DEV-557's machine is in (`boot/enter-vr.ts`):
 * Matt's words, *Enter VR* or *Connect VR headset*, and the plate's note. The
 * note is in the accent when it asks for something else: a gamepad pressed it
 * (*a pad cannot: press H, or click*), or the browser said no.
 */
export const enterVrRow = (state: TitleVrState): PauseOption => {
  const text = titleVrText(state)
  return {
    id: ENTER_VR_ROW_ID,
    label: text.label,
    note: text.note,
    ...(state === 'needs-key' || state === 'refused' ? { accentNote: true } : {}),
  }
}

/**
 * DEV-353's Quick Race id. Not a row on the title since DEV-558; a shared
 * lap's link still takes it (`ghostRaceRow`), because the race a ghost link
 * boards IS a Quick Race on that lap's course (`startQuickRace`).
 */
export const QUICK_RACE_ROW_ID = 'quick-race'

/**
 * DEV-373: the row a shared lap's link (`?ghost=<id>`) puts on the title: whose
 * lap it is in the value slot, and what racing it means under it. It boards
 * that lap's course in its aircraft, no lift ride, the lap flying beside you
 * as a ghost (a see-through copy you cannot hit).
 *
 * DEV-571 reworded it for a stranger: it said `RACE A GHOST` over `their 61.2 s
 * lap, speed jet, no lift ride`, which names a thing (a ghost) the page has
 * not explained and a ride the player has never seen.
 */
export const ghostRaceRow = (handle: string, seconds: number, variant: string): PauseOption => ({
  id: QUICK_RACE_ROW_ID,
  label: 'Race this lap',
  value: handle,
  note: `fly against their ${seconds.toFixed(1)} s, ${variant} jet`,
})

/** DEV-571: WATCH THIS LAP's row id. */
export const WATCH_LAP_ROW_ID = 'watch-lap'

/**
 * DEV-571: a shared lap's second row, where the build has TV: watch it flown,
 * among the AI racers, under TV's camera (`/tv/lap/<id>`'s show, DEV-480/483).
 */
export const ghostWatchRow = (handle: string, seconds: number): PauseOption => ({
  id: WATCH_LAP_ROW_ID,
  label: 'Watch this lap',
  value: handle,
  note: `see their ${seconds.toFixed(1)} s flown, on FF-TV`,
})

// ── DEV-467: a shared course's row (`#c=` link) ─────────────────────────────

/** A link that was refused: said on the title, where its row would have gone. */
export const COURSE_REFUSED_ROW_ID = 'course-refused'

/** A course row's id: `course:<pc_ id>`. The press reads the id back out. */
const COURSE_ROW_PREFIX = 'course:'
export const courseRowId = (id: string): string => `${COURSE_ROW_PREFIX}${id}`
/** The course a row names, or null for any other row. */
export const courseOfRow = (row: string | undefined): string | null =>
  row?.startsWith(COURSE_ROW_PREFIX) ? row.slice(COURSE_ROW_PREFIX.length) : null

/** One course as the row reads it. `app.ts` hands it in from the library. */
export interface CourseRowSource {
  readonly id: string
  /** Its two words: `Amber Heron`. */
  readonly name: string
  /** The island's display name. */
  readonly place: string
  readonly source: 'link' | 'file' | 'made-here'
}

const SOURCE_NOTE: Readonly<Record<CourseRowSource['source'], string>> = {
  link: 'from a link',
  file: 'from a file',
  'made-here': 'made here',
}

/** A course's row: its name, its island in the value slot, where it came from under it. */
export const courseRow = (c: CourseRowSource): PauseOption => ({
  id: courseRowId(c.id),
  label: c.name,
  value: c.place,
  note: SOURCE_NOTE[c.source],
})

/** The refusal's row: nothing to press, the reason to read. */
export const courseRefusedRow = (from: 'link' | 'file', reason: string): PauseOption => ({
  id: COURSE_REFUSED_ROW_ID,
  label: from === 'link' ? 'Shared Course' : 'Course File',
  value: 'refused',
  note: reason,
  accentNote: true,
})

// ── the rows ────────────────────────────────────────────────────────────────

/** What decides the title's rows, as plain values: `app.ts` reads them off the page. */
export interface TitleInput {
  /**
   * ENTER VR's state, or null where the row is not offered (in a headset; a
   * touch device with no headset). `titleVrShown` is the rule.
   */
  readonly vr: TitleVrState | null
  /** A link's row (a ghost race, a shared course or its refusal), or null. */
  readonly link: PauseOption | null
  /** DEV-571: a shared lap's WATCH THIS LAP, under the link's row; absent or null for none. */
  readonly watch?: PauseOption | null
  /**
   * START's note for this visit, or null for its own: the room a `?room=`
   * link named (`room ABCD, from your link`), or why a link's room or race
   * could not be reached (DEV-470), in the accent.
   */
  readonly start: { readonly note: string; readonly accent: boolean } | null
  /** DEV-658: the newsletter's row (`newsletterRow`), or absent or null where it is not offered. */
  readonly newsletter?: PauseOption | null
  /** DEV-802: the making-of's row (`makingOfRow`), or absent or null where it is not offered. */
  readonly makingOf?: PauseOption | null
  /** DEV-859: the OPTIONS row (`optionsRow`), or absent or null where it is not offered. */
  readonly options?: PauseOption | null
}

/** The title's rows, top to bottom: the link's (and WATCH under it), START, OPTIONS, ENTER VR, the newsletter. */
export const titleRows = (input: TitleInput): readonly PauseOption[] => [
  ...(input.link ? [input.link] : []),
  ...(input.link && input.watch ? [input.watch] : []),
  input.start === null
    ? START_ROW
    : { ...START_ROW, note: input.start.note, ...(input.start.accent ? { accentNote: true } : {}) },
  ...(input.options ? [input.options] : []),
  ...(input.vr === null ? [] : [enterVrRow(input.vr)]),
  ...(input.makingOf ? [input.makingOf] : []),
  ...(input.newsletter ? [input.newsletter] : []),
]

/**
 * The row a visit OPENS aimed at: a link's row, the press it was sent for,
 * unless it is a refusal (a row to read, not to press); else START.
 */
export const titleOpeningAim = (rows: readonly PauseOption[]): number => {
  const link = rows[0]
  if (link !== undefined && link.id !== START_ROW.id && link.id !== COURSE_REFUSED_ROW_ID) {
    return 0
  }
  return Math.max(
    0,
    rows.findIndex((r) => r.id === START_ROW.id),
  )
}

/**
 * How the title's rows set their words: centred, label and note (DEV-610).
 * Matt, 2026-10-03: *"center the text on their buttons (start, vr)"*. Every
 * other plate the pause painter draws stays flush left. Part of
 * `TITLE_MENU_PLATE`, and pinned in `title-type.test.ts`.
 */
export const TITLE_MENU_ALIGN: RowAlign = 'center'

/**
 * The plate's heading: none, since DEV-619. Matt, 2026-10-03: *"let's remove
 * "-Fly-" from the title screen menu panel"*. It read `- FLY -` from DEV-353;
 * the emblem above the plate already says whose it is, and the rows say what
 * a press does. Empty, so the probe's `heading` says what is drawn.
 */
export const TITLE_MENU_HEADING = ''

/**
 * How the title's plate is built: centred words (DEV-610) and no heading
 * band (DEV-619), so the plate closes up around its rows. The one object
 * `app.ts` hands `createPause`; its band is `TITLE_MENU_BAND_M`.
 */
export const TITLE_MENU_PLATE: PauseOptions = { align: TITLE_MENU_ALIGN, heading: false }

/** The title plate's title band, in metres: every layout read of it passes this. */
export const TITLE_MENU_BAND_M = titleBandM(TITLE_MENU_PLATE)

/**
 * The most rows the title ever holds: a shared lap's RACE and WATCH (DEV-571),
 * START and ENTER VR.
 */
export const TITLE_MENU_MAX_ROWS = 4

/**
 * The most rows the plate holds at its full size. A fourth (a shared lap's
 * WATCH, DEV-571) shrinks the plate so its bottom edge stays where three rows
 * put it (`titleMenuScale`), rather than running past a flat frame's lower
 * edge: every title without one is drawn exactly as before.
 */
export const TITLE_MENU_FULL_ROWS = 3

/** Metres in front of the eye. */
export const TITLE_MENU_DISTANCE = 2.0

/** Scale on the pause plate's own metres: about two thirds of the angle it subtends at 0.86 m. */
export const TITLE_MENU_SCALE = 1.6

/** How far below the eye line the plate's TOP edge sits, in degrees. */
export const TITLE_MENU_TOP_DEG = 12.5

/**
 * DEV-648: the plate on a FLAT screen is 1.4 times its angular size (Matt, the
 * polish wave: the broadcast plate reads small on a monitor and a phone). The
 * boost is flat only: in a headset the plate is sized by the angle it subtends
 * at the eye, which is what `TITLE_MENU_SCALE` was chosen for, and a plate 1.4
 * times larger there is a lot of plate in a stranger's face. The top edge stays
 * where `TITLE_MENU_TOP_DEG` puts it; the plate grows down and out.
 */
export const TITLE_MENU_FLAT_BOOST = 1.4

/**
 * The plate's scale for `rows` of them: `TITLE_MENU_SCALE` up to three, less past
 * it; times {@link TITLE_MENU_FLAT_BOOST} when `flat`.
 */
export const titleMenuScale = (
  rows: number = TITLE_MENU_FULL_ROWS,
  flat = false,
  /**
   * DEV-859: a row-height floor in degrees, for the OPTIONS pages when they are
   * drawn on this plate (`TITLE_OPTIONS_ROW_DEG`). Applied in a headset only: a
   * flat screen keeps the bottom edge in frame, a head can look down.
   */
  floorDeg: number | null = null,
): number => {
  const fitted =
    (flat ? TITLE_MENU_FLAT_BOOST : 1) *
    (rows <= TITLE_MENU_FULL_ROWS
      ? TITLE_MENU_SCALE
      : (TITLE_MENU_SCALE * panelHeight(TITLE_MENU_FULL_ROWS, TITLE_MENU_BAND_M)) /
        panelHeight(rows, TITLE_MENU_BAND_M))
  if (flat || floorDeg === null) return fitted
  // The scale at which one row subtends `floorDeg` at the plate's distance.
  const floorScale =
    (2 * TITLE_MENU_DISTANCE * Math.tan((floorDeg * Math.PI) / 360)) / rowBand(rows)
  return Math.max(fitted, floorScale)
}

/**
 * DEV-859: the row height the OPTIONS pages keep on the title in a headset, in
 * degrees: the floor the pause plate's tests hold (DEV-838's note on 4.00).
 */
export const TITLE_OPTIONS_ROW_DEG = 4

/** The plate's pose under the rig, for `rows` of them: position, and the scale that sizes it. */
export const titleMenuPose = (
  rows: number = TITLE_MENU_FULL_ROWS,
  flat = false,
  floorDeg: number | null = null,
): {
  readonly position: readonly [number, number, number]
  readonly scale: number
} => {
  // DEV-902: a phone's plate stands in the right half of the view, centred on its
  // own height, one size for any row count (`phone-floor.ts`).
  if (flat && phoneUi.on) {
    const scale = TITLE_PHONE_SCALE
    const centre = TITLE_MENU_DISTANCE * Math.tan((TITLE_PHONE_CENTRE_DEG * Math.PI) / 180)
    const height = panelHeight(rows, TITLE_MENU_BAND_M) * scale
    return {
      position: [
        TITLE_MENU_DISTANCE * Math.tan((TITLE_PHONE_BEARING_DEG * Math.PI) / 180),
        centre + height / 2 - TOP_LOCAL_Y * scale,
        -TITLE_MENU_DISTANCE,
      ],
      scale,
    }
  }
  const top = topEdgeY(TITLE_MENU_TOP_DEG, TITLE_MENU_DISTANCE)
  const scale = titleMenuScale(rows, flat, floorDeg)
  return {
    position: [0, top - TOP_LOCAL_Y * scale, -TITLE_MENU_DISTANCE],
    scale,
  }
}

/**
 * The plate's angular extent from the eye, in degrees, for the test that
 * holds it inside the frame and under the prompt, and for anybody tuning it.
 */
export const titleMenuExtent = (
  rows: number = TITLE_MENU_MAX_ROWS,
  flat = false,
): { readonly topDeg: number; readonly bottomDeg: number; readonly halfWidthDeg: number } => {
  const { position, scale } = titleMenuPose(rows, flat)
  const top = position[1] + TOP_LOCAL_Y * scale
  const bottom = top - panelHeight(rows, TITLE_MENU_BAND_M) * scale
  const deg = (y: number) => angleDeg(y, TITLE_MENU_DISTANCE)
  return {
    topDeg: deg(top),
    bottomDeg: deg(bottom),
    halfWidthDeg: deg((WIDTH / 2) * scale),
  }
}

/**
 * Put the plate where it goes, sized for `rows` (DEV-571: the title re-places
 * it when its row count changes). Its plane faces +z, which is the eye.
 */
export const placeTitleMenu = (
  object: THREE.Object3D,
  rows: number = TITLE_MENU_FULL_ROWS,
  flat = false,
  floorDeg: number | null = null,
): void => {
  const { position, scale } = titleMenuPose(rows, flat, floorDeg)
  object.position.set(position[0], position[1], position[2])
  object.rotation.set(0, 0, 0)
  object.scale.setScalar(scale)
  object.name = 'title-menu'
}
