// src/render/tv-panel-layout.ts: what TV's on-screen layer SAYS, and where it
// stands. DEV-482 (plan/FF-TV.md §5.2, §5.3, §5.4).
//
// Pure: plain values in, plain values out, and a 2D context that a unit test
// can fake. `render/tv-panel.ts` is the half with canvases, meshes and the rig.
//
// ── The three panels ──────────────────────────────────────────────────────
//
//   · the IDENT between shows: FACETED FLIGHT TV, then one line saying what is
//     on (`LIVE · Simonet Islands · Ring Attack · 4 racers`, `EXHIBITION · … ·
//     AI racers`, `SHARED LAP · …`), held `TV_IDENT_SECONDS` (2.5 s, DEV-653);
//   · the LOWER THIRD in flight: the bug, the course, the standings (place,
//     colour, name, rings or time) with the camera's racer marked and the racer
//     a link follows marked, and how many rooms are getting ready;
//   · the RESULTS card at the finish.
//
// ── No names on TV, ever (Matt, 2026-09-30, plan §8) ──────────────────────
//
// A row's drawn name is DERIVED here from its kind, never copied from the
// feed: a live racer is `Racer N` from its racer number whatever `name` says,
// a shared lap's ghost is `TV_LAP_NAME`, and an AI racer carries its CALLSIGN
// (DEV-651: a pool name, drawn in capitals) or, for a racer no race named, its
// tuned name, each only if that name IS in the pool or one of `AI_RACER_TUNINGS`'
// (as `game/racers.ts`'s `assignTunings` makes them: `fast`, `fast-2`). So a handle that reached the
// feed by any route cannot reach a pixel: `tests/unit/tv-panel.test.ts` feeds
// one through every kind and reads back every string the paint drew.
//
// ── Where the panels stand ────────────────────────────────────────────────
//
// Every panel is a child of the RIG. On a flat screen TV's camera zeroes the
// camera's local pose (`tv-camera.ts`), so a rig child is screen-anchored and
// `tvPanelPlacement` fits it inside the frustum (portrait first on a phone:
// the lower third spans the width). In a headset the rig moves only at a cut
// (DEV-481), so a rig child placed once per cut, against the head as it stood
// at that cut, is world-locked: it never swims with the head and never moves
// between cuts. `createTvCutAnchor` is that rule.
//
// AT LAUNCH a headset gets the flat camera (DEV-481 follow-up, Matt,
// 2026-10-01), so the rig moves every frame. Re-placing on every rig move
// would hang the panels on the head (they would swim with every look), so the
// anchor's `perCut: false` policy is RIG-LOCKED, a cockpit display: placed
// against the head once, and again only when the camera's mode changes or the
// head has drifted `TV_PANEL_REANCHOR_METRES` inside the rig (the wearer stood
// up, or leaned far). Between those it rides with the rig, as a dashboard
// rides with a car, and the head looks round it freely.

import { callsignDisplay, isCallsign } from '@/content/callsigns'
import { fillTextCells } from '@/render/ui-digits'
import { drawTag, tagWidth, wrapParts } from '@/render/ui-draw'
import {
  UI_ACCENT as ACCENT,
  UI_DIM as DIM,
  UI_SELECTED_FILL as FOLLOWED_WASH,
  uiFont as font,
  UI_INK as INK,
  UI_PLATE as PLATE,
  UI_PLATE_EDGE as PLATE_EDGE,
  UI_CYAN,
  UI_GAIN,
  UI_INK_DARK,
  UI_LIVE,
  UI_LOSS,
  UI_ON_ACCENT,
} from '@/render/ui-tokens'
import { AI_RACER_TUNINGS } from '@/sim/ai-racer'

/** What TV is showing. */
export type TvShow = 'live' | 'exhibition' | 'lap'

/** Which panel the moment wants: the ident (loading, the countdown), flight, the results. */
export type TvPanelPhase = 'ident' | 'racing' | 'results' | 'off'

/** A live room's racer, an AI racer, or a shared lap's ghost. */
export type TvRowKind = 'live' | 'racer' | 'ghost'

export type TvRowStatus = 'finished' | 'flying' | 'dnf'

/** One craft on the standings. In place order in the feed. */
export interface TvPanelRow {
  /** Stable across frames: `slot:2`, `racer:fast`, `ghost`. What `TvPanelFeed.followed` names. */
  readonly key: string
  readonly kind: TvRowKind
  /** A live racer's N (its slot plus one); null for the others. The ONLY source of a live row's name. */
  readonly racer: number | null
  /** What a press on this row hands the camera's `follow(n)`. */
  readonly follow: number
  /** An AI racer's tuned name (`fast`, `fast-2`). Ignored for `live` and `ghost`: see the header. */
  readonly name: string
  /** CSS colour of its hull; null draws a hollow swatch (a recording, the hologram). */
  readonly colour: string | null
  /** 1-based. */
  readonly place: number
  readonly status: TvRowStatus
  /** Its time once it has crossed. */
  readonly seconds: number | null
  /** Rings taken so far, or null where the feed cannot say. */
  readonly rings: number | null
  /**
   * DEV-653: seconds behind the leader, measured at the SAME gate (the clock at
   * which each was seen to cross it, `render/tv-gaps.ts`), never estimated;
   * 0 for the leader; null or absent where it cannot be said.
   */
  readonly gap?: number | null
}

/** DEV-653: a split on the followed racer, every few gates. */
export interface TvSplit {
  /** The 1-based gate it was taken at. */
  readonly gate: number
  /** Seconds behind the racer ahead of it (positive), or ahead of the racer behind (negative). */
  readonly seconds: number
}

/**
 * What DEV-480's TV block hands the panel each frame (and what
 * `tvFeedFromExhibition` builds from DEV-483's exhibition). Null: TV is off.
 */
export interface TvPanelFeed {
  readonly show: TvShow
  readonly phase: TvPanelPhase
  /** `Simonet Islands · Ring Attack` (`tvCourseLabel`). Empty while unknown. */
  readonly course: string
  /** How many race, for the ident (a live list entry's `racers`); null: the rows' count. */
  readonly racers: number | null
  readonly rows: readonly TvPanelRow[]
  /** The course's rings, for `12/21`; 0 where unknown. */
  readonly gates: number
  /** The row the camera is on (`TvPanelRow.key`), or null (`tvFollowedKey`). */
  readonly followed: string | null
  /** The racer N a link's `?follow=` named, or null. */
  readonly linkFollows: number | null
  /** The list's `lobbies`: rooms getting ready. Null where there is no list. */
  readonly lobbies: number | null
  /** Seconds since GO. */
  readonly raceSeconds: number
  /** DEV-653: the followed racer's split while it stands, or absent. */
  readonly split?: TvSplit | null
}

/** DEV-653: the ident stands this long once it is on screen (it stood about twenty), seconds. */
export const TV_IDENT_SECONDS = 2.5

/**
 * What the TV block writes for the panel (`boot/app.ts`'s DEV-482 block holds
 * one): DEV-480's live feed while a room's race is on screen, else null and
 * the exhibition's is built; and the list's `lobbies`, for the exhibition's
 * lower third (a live feed carries its own).
 */
export interface TvPanelInput {
  live: TvPanelFeed | null
  lobbies: number | null
}

/** What a shared lap's ghost is called. The same words as `game/tv/exhibition.ts`'s `TV_LAP_NAME`. */
export const TV_PANEL_LAP_NAME = 'Shared lap'

export const TV_TITLE = 'FACETED FLIGHT TV'

// ── Names ──────────────────────────────────────────────────────────────────

const TUNED_NAME = /^([a-z]+)(?:-([1-9][0-9]?))?$/

/** Is `name` one `assignTunings` makes (`fast`, `fast-2`)? */
export const isTunedRacerName = (name: string): boolean => {
  const m = TUNED_NAME.exec(name)
  return m !== null && m[1] !== undefined && Object.hasOwn(AI_RACER_TUNINGS, m[1])
}

/** The only name a row may be drawn with. See the header. */
export const tvDrawnName = (row: TvPanelRow): string => {
  if (row.kind === 'ghost') return TV_PANEL_LAP_NAME
  if (row.kind === 'racer' && isCallsign(row.name)) return callsignDisplay(row.name)
  if (row.kind === 'racer' && isTunedRacerName(row.name)) return row.name
  const n =
    row.racer !== null && Number.isInteger(row.racer) && row.racer > 0 ? row.racer : row.place
  return `Racer ${n}`
}

/**
 * What the world marker over the followed racer says (DEV-653): the name the
 * board would draw for that craft. A craft with a racer number is a live
 * racer (`Racer N`, never a handle); the rest are AI racers (callsign) or a
 * shared lap's ghost.
 */
export const tvCraftName = (c: {
  readonly name: string
  readonly racer?: number | null | undefined
  readonly place?: number | null | undefined
}): string =>
  tvDrawnName({
    key: c.name,
    kind: c.racer != null ? 'live' : c.name === TV_PANEL_LAP_NAME ? 'ghost' : 'racer',
    racer: c.racer ?? null,
    follow: 0,
    name: c.name,
    colour: null,
    place: c.place ?? 0,
    status: 'flying',
    seconds: null,
    rings: null,
  })

// ── Words ──────────────────────────────────────────────────────────────────

/** `Simonet Islands · Ring Attack`. */
export const tvCourseLabel = (place: string, mode: string): string =>
  [place, mode].filter((s) => s.length > 0).join(' · ')

/** The bug: the corner word and its plate. */
export const tvBug = (
  show: TvShow,
): { readonly text: string; readonly plate: string; readonly ink: string } =>
  show === 'live'
    ? { text: 'LIVE', plate: UI_LIVE, ink: INK }
    : show === 'lap'
      ? { text: 'SHARED LAP', plate: UI_CYAN, ink: UI_INK_DARK }
      : { text: 'EXHIBITION', plate: ACCENT, ink: UI_ON_ACCENT }

/** The ident's second line. */
export const tvIdentLine = (feed: TvPanelFeed): string => {
  const parts = [tvBug(feed.show).text]
  if (feed.course) parts.push(feed.course)
  if (feed.show === 'live') {
    const n = feed.racers ?? feed.rows.length
    if (n > 0) parts.push(`${n} ${n === 1 ? 'racer' : 'racers'}`)
  } else if (feed.show === 'exhibition') {
    parts.push('AI racers')
  }
  return parts.join(' · ')
}

/** `2 rooms getting ready`, or '' when none are (or nobody knows). */
export const tvLobbiesLine = (lobbies: number | null): string =>
  lobbies === null || lobbies <= 0
    ? ''
    : `${lobbies} ${lobbies === 1 ? 'room' : 'rooms'} getting ready`

/** `74.3s`: one decimal, as the results panel prints a lap. */
const secs = (s: number): string => `${s.toFixed(1)}s`

/** `1:07` race clock. */
export const tvClock = (s: number): string => {
  const whole = Math.max(0, Math.floor(s))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** A row's right-hand figure: its time, `DNF`, or its rings while it flies. */
export const tvRowDetail = (row: TvPanelRow, gates: number): string => {
  if (row.status === 'finished' && row.seconds !== null) return secs(row.seconds)
  if (row.status === 'dnf') return 'DNF'
  if (row.gap !== undefined && row.gap !== null) return row.gap > 0 ? tvGap(row.gap) : 'LEAD'
  if (row.rings === null) return ''
  return gates > 0 ? `${row.rings}/${gates}` : String(row.rings)
}

/** `+1.4`: seconds behind, one decimal. */
export const tvGap = (seconds: number): string => `+${seconds.toFixed(1)}`

/** `SPLIT GATE 8  +1.4` (behind) or `-0.8` (ahead). */
export const tvSplitLine = (s: TvSplit): string =>
  `SPLIT GATE ${s.gate}  ${s.seconds > 0 ? '+' : s.seconds < 0 ? '-' : ''}${Math.abs(s.seconds).toFixed(1)}`

/** The header's right-hand figure: the followed (else the leading) racer's gates, `12/21`. */
export const tvGateLine = (feed: TvPanelFeed): string => {
  if (feed.gates <= 0) return ''
  const row = feed.rows.find((r) => r.key === feed.followed) ?? feed.rows[0]
  return row && row.rings !== null ? `GATE ${row.rings}/${feed.gates}` : ''
}

/** `1ST`, `2ND`, `11TH`. The results panel's (`render/results.ts`), kept here so this file stays three-free. */
export const tvOrdinal = (n: number): string => {
  const teen = n % 100 >= 11 && n % 100 <= 13
  const suffix = teen ? 'TH' : (['TH', 'ST', 'ND', 'RD'][n % 10] ?? 'TH')
  return `${n}${suffix}`
}

// ── Which panel, and the sound that goes with it ───────────────────────────

export interface TvPanelState {
  readonly phase: TvPanelPhase
  readonly course: string
  readonly show: TvShow | null
  /** Seconds the ident has left to stand. */
  readonly identHold: number
  /** DEV-653: seconds the standings board has left to show (0 is hidden). */
  readonly boardLeft: number
  /** DEV-653: the standings' order last frame (row keys by place) and the row the camera was on. */
  readonly order: string
  readonly followed: string | null
}

export const TV_PANEL_IDLE: TvPanelState = {
  phase: 'off',
  course: '',
  show: null,
  identHold: 0,
  boardLeft: 0,
  order: '',
  followed: null,
}

/** A sound the moment asks for (plan §5.4): the ident's sting, the soundtrack's two cues. */
export type TvCue = 'sting' | 'music.lift' | 'music.go'

export interface TvPanelShown {
  readonly ident: boolean
  readonly lowerThird: boolean
  readonly results: boolean
}

/**
 * The standings board shows for this long after the ident, a change of place
 * or a change of who the camera is on, then fades (DEV-653: it covered a
 * quarter of the frame, permanently; Matt wants it quieter).
 */
export const TV_BOARD_SECONDS = 6
/** The last of those seconds it fades over. */
export const TV_BOARD_FADE_SECONDS = 0.8

/** `1` while the board is up, easing to `0` over its last `TV_BOARD_FADE_SECONDS`. */
export const tvBoardAlpha = (boardLeft: number): number =>
  Math.max(0, Math.min(1, boardLeft / TV_BOARD_FADE_SECONDS))

/**
 * One frame of the panel's state: which panel stands, and which cues fire. A
 * new show (the ident coming up, or a different course or show under it) is
 * the sting and the soundtrack's `lift` (a no-op while a song plays, as in a
 * mission); GO is its `go`, a new song, as a mission's GO is (DEV-423).
 *
 * DEV-653: the ident stands `TV_IDENT_SECONDS` of ON-SCREEN time (the caller
 * passes `dt` 0 while the loading scene covers it), and the board comes up
 * when the ident leaves, on any change in the order of places or in who the
 * camera follows, and fades `TV_BOARD_SECONDS` later. `board` is its 0..1
 * opacity this frame.
 */
export const stepTvPanel = (
  state: TvPanelState,
  feed: TvPanelFeed | null,
  dt: number,
): { state: TvPanelState; shown: TvPanelShown; cues: TvCue[]; board: number } => {
  const cues: TvCue[] = []
  if (feed === null || feed.phase === 'off') {
    return {
      state: TV_PANEL_IDLE,
      shown: { ident: false, lowerThird: false, results: false },
      cues,
      board: 0,
    }
  }
  let hold = Math.max(0, state.identHold - dt)
  // A course label arriving under an ident already up (the course's name known
  // once its card or level is) is the same show, not a second sting.
  const newShow =
    feed.phase === 'ident' &&
    (state.phase !== 'ident' ||
      state.show !== feed.show ||
      (state.course !== '' && state.course !== feed.course))
  if (newShow) {
    cues.push('sting', 'music.lift')
    hold = TV_IDENT_SECONDS
  }
  if (feed.phase === 'racing' && state.phase !== 'racing' && state.phase !== 'off') {
    cues.push('music.go')
  }
  const ident = (feed.phase === 'ident' || feed.phase === 'racing') && hold > 0
  const racingClear = feed.phase === 'racing' && !ident
  const order = feed.rows.map((r) => r.key).join('|')
  let boardLeft = Math.max(0, state.boardLeft - dt)
  if (racingClear) {
    const wasClear = state.phase === 'racing' && state.identHold <= 0
    const changed =
      !wasClear || (state.order !== '' && state.order !== order) || state.followed !== feed.followed
    if (changed) boardLeft = TV_BOARD_SECONDS
  } else {
    boardLeft = 0
  }
  return {
    state: {
      phase: feed.phase,
      course: feed.course,
      show: feed.show,
      identHold: hold,
      boardLeft,
      order,
      followed: feed.followed,
    },
    shown: {
      ident,
      lowerThird: racingClear && boardLeft > 0,
      results: feed.phase === 'results',
    },
    cues,
    board: racingClear ? tvBoardAlpha(boardLeft) : 0,
  }
}

// ── From DEV-483's exhibition and DEV-481's camera ─────────────────────────

/** What `tvFeedFromExhibition` reads of `__ff2.exhibition.probe()` (an `ExhibitionReport`). */
export interface ExhibitionPanelSource {
  readonly phase: 'boarding' | 'countdown' | 'racing' | 'results' | 'stopped'
  readonly course: string | null
  readonly raceSeconds: number
  readonly craft: readonly {
    readonly kind: 'racer' | 'ghost'
    readonly name: string
    readonly place: number
    readonly status: TvRowStatus
    readonly seconds: number | null
  }[]
}

export interface ExhibitionPanelContext {
  /** `tvCourseLabel(place, mode)` for the course on screen. */
  readonly course: string
  /** An AI racer's hull colour by its tuned name (`spec.colour`), or null. */
  readonly colourOf: (name: string) => string | null
  /** An AI racer's rings so far by its tuned name, or null. */
  readonly ringsOf: (name: string) => number | null
  readonly gates: number
  /** The camera's `report().following` (a craft's name), or null. */
  readonly following: string | null
  readonly linkFollows: number | null
  readonly lobbies: number | null
}

const EXHIBITION_PHASE: Readonly<Record<ExhibitionPanelSource['phase'], TvPanelPhase>> = {
  boarding: 'ident',
  countdown: 'ident',
  racing: 'racing',
  results: 'results',
  stopped: 'off',
}

/** The exhibition as the panel reads it. A ghost on the field makes it a SHARED LAP show. */
export const tvFeedFromExhibition = (
  ex: ExhibitionPanelSource,
  c: ExhibitionPanelContext,
): TvPanelFeed => {
  const rows: TvPanelRow[] = ex.craft.map((craft, i) =>
    craft.kind === 'ghost'
      ? {
          key: 'ghost',
          kind: 'ghost',
          racer: null,
          follow: i + 1,
          name: '',
          colour: null,
          place: craft.place,
          status: craft.status,
          seconds: craft.seconds,
          rings: null,
        }
      : {
          key: `racer:${craft.name}`,
          kind: 'racer',
          racer: null,
          // The exhibition's craft carry no racer number: `follow(n)` is the n-th on the list.
          follow: i + 1,
          name: craft.name,
          colour: c.colourOf(craft.name),
          place: craft.place,
          status: craft.status,
          seconds: craft.seconds,
          rings: c.ringsOf(craft.name),
        },
  )
  return {
    show: ex.craft.some((x) => x.kind === 'ghost') ? 'lap' : 'exhibition',
    phase: EXHIBITION_PHASE[ex.phase],
    course: c.course,
    racers: null,
    rows,
    gates: c.gates,
    followed: tvFollowedKey({ following: c.following, racer: null }, rows),
    linkFollows: c.linkFollows,
    lobbies: c.lobbies,
    raceSeconds: ex.raceSeconds,
  }
}

/** A live room's racer as a row: what DEV-480's TV block builds per remote ship. */
export const tvLiveRow = (r: {
  readonly slot: number
  readonly colour: string | null
  readonly place: number
  readonly status: TvRowStatus
  readonly seconds: number | null
  readonly rings: number | null
}): TvPanelRow => ({
  key: `slot:${r.slot}`,
  kind: 'live',
  racer: r.slot + 1,
  follow: r.slot + 1,
  name: '',
  colour: r.colour,
  place: r.place,
  status: r.status,
  seconds: r.seconds,
  rings: r.rings,
})

/**
 * The row the camera is on, from its `report()`: by racer number where it has
 * one (a live race), else by the craft's name on an AI or ghost row.
 */
export const tvFollowedKey = (
  report: { readonly following: string | null; readonly racer: number | null } | null,
  rows: readonly TvPanelRow[],
): string | null => {
  if (!report) return null
  if (report.racer !== null) {
    const live = rows.find((r) => r.kind === 'live' && r.racer === report.racer)
    if (live) return live.key
  }
  if (report.following === null) return null
  const byName = rows.find(
    (r) =>
      (r.kind === 'racer' && r.name === report.following) ||
      (r.kind === 'ghost' && report.following === TV_PANEL_LAP_NAME),
  )
  return byName?.key ?? null
}

// ── Painting ───────────────────────────────────────────────────────────────

/** The part of a 2D context the paint uses; a test fakes it and reads back every string. */
export interface TvCtx {
  /** Optional so a test's fake need not carry it. */
  globalAlpha?: number
  font: string
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number, maxWidth?: number): void
  measureText(text: string): { readonly width: number }
}

// The HUD's palette (`ui-tokens.ts`), because this is the same instrument.
const WIN = UI_GAIN
/** DEV-653: a gap to the leader, and a split against you (the results' loss colour). */
const LOSS = UI_LOSS

/** The racer a link follows: drawn after the name, and explained in the footer. */
export const TV_LINK_MARK = '◆'
export const TV_LINK_LEGEND = `${TV_LINK_MARK} the racer this link follows`

/** At most this many rows; more say `+N more`. Six starts, plus a ghost, plus one. */
export const TV_MAX_ROWS = 8

/**
 * The standings board's canvas, px. Fixed: the plate is drawn bottom-aligned in
 * it. DEV-653 made it smaller (it was 900 wide with 72 px rows: a quarter of the
 * frame), room for the three footers a race can have (more or lobbies, the
 * link's legend, a split).
 */
export const LOWER_THIRD_CANVAS = { width: 620, height: 60 + TV_MAX_ROWS * 52 + 3 * 40 } as const
const LT = { pad: 16, header: 60, row: 52, footer: 40 } as const

/** DEV-653: the board's plate is see-through. */
export const BOARD_PLATE_ALPHA = 0.6

export interface LowerThirdLayout {
  /** Where the plate starts, px from the canvas top (it ends at the bottom). */
  readonly top: number
  readonly rows: readonly { readonly row: TvPanelRow; readonly y: number; readonly h: number }[]
  readonly more: number
  readonly footers: readonly string[]
}

/** Does this row carry the link's mark? A live row by racer number; an AI row by its list place. */
const linked = (feed: TvPanelFeed, row: TvPanelRow): boolean =>
  feed.linkFollows !== null &&
  (row.kind === 'live' ? row.racer === feed.linkFollows : row.follow === feed.linkFollows)

export const layoutLowerThird = (feed: TvPanelFeed): LowerThirdLayout => {
  const shown = feed.rows.slice(0, TV_MAX_ROWS)
  const more = feed.rows.length - shown.length
  const footers: string[] = []
  const lobbies = tvLobbiesLine(feed.lobbies)
  if (lobbies) footers.push(more > 0 ? `+${more} more · ${lobbies}` : lobbies)
  else if (more > 0) footers.push(`+${more} more`)
  if (feed.rows.some((r) => linked(feed, r))) footers.push(TV_LINK_LEGEND)
  if (feed.split) footers.push(tvSplitLine(feed.split))
  const used = LT.header + shown.length * LT.row + footers.length * LT.footer + LT.pad
  const top = LOWER_THIRD_CANVAS.height - used
  return {
    top,
    rows: shown.map((row, i) => ({ row, y: top + LT.header + i * LT.row, h: LT.row })),
    more,
    footers,
  }
}

/** The row a press at canvas pixel (`x`, `y`) lands on, or null. */
export const lowerThirdRowAt = (
  layout: LowerThirdLayout,
  x: number,
  y: number,
): TvPanelRow | null => {
  if (x < 0 || x > LOWER_THIRD_CANVAS.width) return null
  for (const r of layout.rows) if (y >= r.y && y < r.y + r.h) return r.row
  return null
}

const drawBug = (ctx: TvCtx, show: TvShow, x: number, y: number, h: number, px: number): number => {
  const bug = tvBug(show)
  ctx.font = font(px, 800)
  const w = ctx.measureText(bug.text).width + px * 1.1
  ctx.fillStyle = bug.plate
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = bug.ink
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(bug.text, x + w / 2, y + h / 2 + 1)
  return w
}

export const drawPlate = (
  ctx: TvCtx,
  x: number,
  y: number,
  w: number,
  h: number,
  alpha = 1,
): void => {
  ctx.globalAlpha = alpha
  ctx.fillStyle = PLATE
  ctx.fillRect(x, y, w, h)
  ctx.globalAlpha = 1
  ctx.strokeStyle = PLATE_EDGE
  ctx.lineWidth = 3
  ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3)
}

const drawSwatch = (ctx: TvCtx, colour: string | null, x: number, y: number, s: number): void => {
  if (colour) {
    ctx.fillStyle = colour
    ctx.fillRect(x, y, s, s)
  } else {
    // A recording: hollow, as a replay craft wears the hologram (plan §5.2).
    ctx.strokeStyle = PLATE_EDGE
    ctx.lineWidth = 4
    ctx.strokeRect(x + 2, y + 2, s - 4, s - 4)
  }
}

export const paintLowerThird = (
  ctx: TvCtx,
  feed: TvPanelFeed,
  layout = layoutLowerThird(feed),
): void => {
  const W = LOWER_THIRD_CANVAS.width
  ctx.clearRect(0, 0, W, LOWER_THIRD_CANVAS.height)
  const top = layout.top
  // DEV-653: a translucent plate, quiet; the numbers carry it.
  drawPlate(ctx, 0, top, W, LOWER_THIRD_CANVAS.height - top, BOARD_PLATE_ALPHA)

  // The header: the bug, the race clock, and the gate the camera's racer is on.
  const bugW = drawBug(ctx, feed.show, LT.pad, top + 12, 36, 20)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = INK
  ctx.font = font(24, 600)
  const clock = feed.phase === 'racing' ? tvClock(feed.raceSeconds) : ''
  // CRYSTAL's figures are proportional: seat the ticking clock's digits in cells (DEV-848).
  if (clock) fillTextCells(ctx, clock, LT.pad + bugW + 14, top + 31)
  const gate = tvGateLine(feed)
  if (gate) {
    ctx.textAlign = 'right'
    ctx.fillStyle = DIM
    ctx.fillText(gate, W - LT.pad, top + 31)
  }

  for (const { row, y, h } of layout.rows) {
    const followed = feed.followed !== null && row.key === feed.followed
    const mid = y + h / 2
    if (followed) {
      ctx.fillStyle = FOLLOWED_WASH
      ctx.fillRect(4, y + 3, W - 8, h - 6)
      ctx.fillStyle = ACCENT
      ctx.fillRect(4, y + 3, 4, h - 6)
    }
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.font = font(28, 700)
    ctx.fillStyle = row.status === 'dnf' ? DIM : followed ? ACCENT : INK
    ctx.fillText(row.status === 'dnf' ? '-' : String(row.place), LT.pad + 8, mid)
    drawSwatch(ctx, row.colour, LT.pad + 52, mid - 11, 22)
    const name = tvDrawnName(row)
    const detail = tvRowDetail(row, feed.gates)
    const detailW = 110
    const isLinked = linked(feed, row)
    ctx.font = font(26, 600)
    ctx.fillStyle = row.status === 'dnf' ? DIM : INK
    const nameX = LT.pad + 88
    // DEV-854: an AI racer wears a tag; a live racer (a human in a room) does not.
    const isAi = row.kind === 'racer'
    const tagSize = 18
    const tagW = isAi ? tagWidth(ctx, tagSize) + 10 : 0
    ctx.font = font(26, 600)
    const nameMax = W - nameX - detailW - (isLinked ? 36 : 0) - LT.pad - tagW
    ctx.fillText(name, nameX, mid, nameMax)
    if (isAi) {
      const nw = Math.min(nameMax, ctx.measureText(name).width)
      drawTag(ctx, nameX + nw + 10, mid, tagSize, row.status === 'dnf' ? DIM : ACCENT)
      ctx.font = font(26, 600)
    }
    if (isLinked) {
      const w = Math.min(nameMax, ctx.measureText(name).width) + tagW
      ctx.fillStyle = ACCENT
      ctx.font = font(22, 700)
      ctx.fillText(TV_LINK_MARK, nameX + w + 10, mid)
    }
    if (detail) {
      ctx.textAlign = 'right'
      ctx.font = font(24, row.status === 'finished' ? 700 : 500)
      ctx.fillStyle = row.status === 'finished' ? WIN : row.gap != null && row.gap > 0 ? LOSS : DIM
      ctx.fillText(detail, W - LT.pad, mid)
    }
  }

  let fy = top + LT.header + layout.rows.length * LT.row
  for (const line of layout.footers) {
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.font = font(20, 500)
    ctx.fillStyle =
      line === TV_LINK_LEGEND
        ? ACCENT
        : feed.split && line === tvSplitLine(feed.split)
          ? feed.split.seconds <= 0
            ? WIN
            : LOSS
          : DIM
    ctx.fillText(line, LT.pad, fy + LT.footer / 2, W - LT.pad * 2)
    fy += LT.footer
  }
}

/** The ident's canvas: wider on a landscape screen, taller (the line wraps) in portrait. */
export const identCanvas = (portrait: boolean): { width: number; height: number } =>
  portrait ? { width: 900, height: 460 } : { width: 1400, height: 360 }

/** The ident's line, broken at its ` · ` separators into lines that fit `maxW`. */
export const wrapIdentLine = (
  ctx: Pick<TvCtx, 'measureText'>,
  line: string,
  maxW: number,
): string[] => {
  return wrapParts(line.split(' · '), ' · ', maxW, (s) => ctx.measureText(s).width)
}

export const paintIdent = (ctx: TvCtx, feed: TvPanelFeed, portrait: boolean): void => {
  const { width: W, height: H } = identCanvas(portrait)
  ctx.clearRect(0, 0, W, H)
  drawPlate(ctx, 0, 0, W, H)
  const titlePx = portrait ? 84 : 104
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = font(titlePx, 800)
  ctx.fillStyle = INK
  ctx.fillText(TV_TITLE, W / 2, portrait ? 110 : 120, W - 60)
  ctx.fillStyle = tvBug(feed.show).plate
  ctx.fillRect(W * 0.18, portrait ? 180 : 200, W * 0.64, 6)
  const linePx = portrait ? 40 : 46
  ctx.font = font(linePx, 600)
  const lines = wrapIdentLine(ctx, tvIdentLine(feed), W - 80)
  const y0 = portrait ? 250 : 270
  lines.forEach((l, i) => {
    ctx.fillStyle = i === 0 ? INK : DIM
    ctx.fillText(l, W / 2, y0 + i * linePx * 1.35, W - 60)
  })
}

// ── DEV-654: the lower third's line ──────────────────────────────────────────

/** The banner's canvas. */
export const BANNER_CANVAS = { width: 760, height: 100 } as const
/** A line stands this long, seconds of on-screen time, and fades over the last `TV_BANNER_FADE_SECONDS`. */
export const TV_BANNER_SECONDS = 3
export const TV_BANNER_FADE_SECONDS = 0.4
/** `1` while the line is up, easing to `0` over its last fade seconds. */
export const tvBannerAlpha = (left: number): number =>
  Math.max(0, Math.min(1, left / TV_BANNER_FADE_SECONDS))

/** What kind of line: an overtake (the plate and a hard accent edge) or the winner (the accent plate). */
export type TvBannerKind = 'overtake' | 'winner'

/**
 * `CUTTER takes #1`: flat plate, one hard accent edge, the tight face in caps.
 * The winner's line is the accent itself (the gold of the first medal in the
 * UI's own palette).
 */
export const paintBanner = (ctx: TvCtx, line: string, kind: TvBannerKind): void => {
  const { width: W, height: H } = BANNER_CANVAS
  ctx.clearRect(0, 0, W, H)
  const winner = kind === 'winner'
  ctx.fillStyle = winner ? ACCENT : PLATE
  ctx.fillRect(0, 0, W, H)
  if (!winner) {
    ctx.fillStyle = ACCENT
    ctx.fillRect(0, 0, 14, H)
  }
  ctx.fillStyle = winner ? UI_ON_ACCENT : INK
  ctx.font = font(52, 800)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(line, 44, H / 2 + 2, W - 64)
}

/** The results card's canvas. */
export const RESULTS_CANVAS = { width: 1000, height: 200 + TV_MAX_ROWS * 64 + 60 } as const

export const paintResults = (ctx: TvCtx, feed: TvPanelFeed): void => {
  const W = RESULTS_CANVAS.width
  const H = RESULTS_CANVAS.height
  ctx.clearRect(0, 0, W, H)
  const rows = feed.rows.slice(0, TV_MAX_ROWS)
  const lobbies = tvLobbiesLine(feed.lobbies)
  const used = 200 + rows.length * 64 + (lobbies ? 60 : 24)
  drawPlate(ctx, 0, 0, W, used)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.font = font(60, 800)
  ctx.fillStyle = ACCENT
  ctx.fillText('RESULTS', 36, 70)
  ctx.font = font(32, 600)
  ctx.fillStyle = INK
  ctx.fillText(feed.course, 36, 136, W - 72)
  // The bug on the right, so the card says what kind of race it was.
  ctx.font = font(28, 800)
  const bug = tvBug(feed.show)
  const bw = ctx.measureText(bug.text).width + 30
  drawBug(ctx, feed.show, W - 36 - bw, 44, 52, 28)
  ctx.fillStyle = PLATE_EDGE
  ctx.fillRect(36, 172, W - 72, 3)
  rows.forEach((row, i) => {
    const mid = 200 + i * 64 + 32
    const won = row.status === 'finished' && row.place === 1
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.font = font(34, 700)
    ctx.fillStyle = row.status === 'finished' ? (won ? WIN : INK) : DIM
    ctx.fillText(row.status === 'finished' ? tvOrdinal(row.place) : '-', 36, mid)
    drawSwatch(ctx, row.colour, 170, mid - 17, 34)
    ctx.font = font(34, 600)
    ctx.fillStyle = row.status === 'dnf' ? DIM : INK
    const cardName = tvDrawnName(row)
    const cardAi = row.kind === 'racer'
    const cardTagW = cardAi ? tagWidth(ctx, 26) + 14 : 0
    ctx.font = font(34, 600)
    const cardMax = W - 226 - 220 - cardTagW
    ctx.fillText(cardName, 226, mid, cardMax)
    if (cardAi) {
      const nw = Math.min(cardMax, ctx.measureText(cardName).width)
      drawTag(ctx, 226 + nw + 14, mid, 26, row.status === 'dnf' ? DIM : ACCENT)
      ctx.font = font(34, 600)
    }
    ctx.textAlign = 'right'
    ctx.font = font(34, row.status === 'finished' ? 700 : 500)
    ctx.fillStyle = row.status === 'finished' ? (won ? WIN : INK) : DIM
    const detail =
      row.status === 'finished' && row.seconds !== null
        ? secs(row.seconds)
        : row.status === 'dnf'
          ? 'DNF'
          : 'flying'
    ctx.fillText(detail, W - 36, mid)
  })
  if (lobbies) {
    ctx.textAlign = 'left'
    ctx.font = font(26, 500)
    ctx.fillStyle = DIM
    ctx.fillText(lobbies, 36, 200 + rows.length * 64 + 30, W - 72)
  }
}

/** The text a paint would draw for this feed, as one key: repaint only when it changes. */
export const lowerThirdKey = (feed: TvPanelFeed): string =>
  [
    feed.show,
    feed.course,
    feed.phase === 'racing' ? tvClock(feed.raceSeconds) : '',
    feed.followed ?? '',
    feed.linkFollows ?? '',
    feed.lobbies ?? '',
    feed.gates,
    feed.split ? tvSplitLine(feed.split) : '',
    ...feed.rows.map(
      (r) =>
        `${r.key}|${r.place}|${r.status}|${r.seconds ?? ''}|${r.rings ?? ''}|${r.colour ?? ''}|${tvDrawnName(r)}|${r.gap == null ? '' : tvGap(r.gap)}`,
    ),
  ].join('/')

// ── Where each panel stands ─────────────────────────────────────────────────

/** `bug`: the broadcast bug, the game's emblem in a corner (DEV-617). */
export type TvPanelKind = 'ident' | 'lowerThird' | 'results' | 'bug' | 'banner' | 'map'

/** A panel's place, LOCAL to the rig: centre, the tilt toward the eye, and its size, metres. */
export interface TvPanelPlace {
  readonly position: readonly [number, number, number]
  /** Euler 'YXZ': yaw toward the eye, then the tip back. */
  readonly yaw: number
  readonly pitch: number
  readonly width: number
  readonly height: number
}

export interface TvFlatView {
  /** The camera's vertical field, degrees. */
  readonly fovDeg: number
  /** Width over height. Under 1 is portrait. */
  readonly aspect: number
}

/** Metres in front of a flat camera the panels stand: inside every near plane, behind nothing (they draw on top). */
export const TV_FLAT_DISTANCE = 1

/** Headset placements, relative to the head at the cut, along the vantage's facing (rig −z). */
export const TV_HEADSET = {
  lowerThird: { right: -0.38, up: -0.52, ahead: 1.5, width: 0.72 },
  ident: { right: 0, up: 0.02, ahead: 2.2, width: 1.15 },
  results: { right: 0, up: -0.12, ahead: 2.0, width: 0.95 },
  // DEV-617: low and right, where a broadcast's bug sits, mirroring the lower
  // third's corner; rig-locked with the panels, never stuck to the eye.
  bug: { right: 0.5, up: -0.5, ahead: 1.6, width: 0.16 },
  // DEV-654: the overtake line, low and centred, under the standings' corner.
  banner: { right: 0, up: -0.45, ahead: 1.8, width: 0.9 },
  // DEV-866: the mini-map and the followed racer's numbers, right of centre, above the bug.
  map: { right: 0.52, up: -0.1, ahead: 1.7, width: 0.5 },
} as const

/**
 * DEV-617: the bug's width as a share of the flat frame's: landscape (a corner
 * of a monitor) and portrait (a phone held upright, where it is a larger share
 * of a narrow frame).
 */
export const TV_BUG_SHARE = { landscape: 0.075, portrait: 0.17 } as const

/**
 * Fit `kind` inside a flat frustum. `aspect` is the canvas's width over height.
 * Landscape: the standings board in the top-right corner (DEV-653; it was the
 * bottom left); portrait (a phone held
 * upright, the way the touch UI is played): the full width at the bottom.
 */
export const tvFlatPlacement = (
  kind: TvPanelKind,
  view: TvFlatView,
  canvasAspect: number,
  /**
   * The share of the board's canvas (0..1) the plate leaves empty at its top
   * (it is bottom-aligned in its canvas), so a board at the TOP of the frame can
   * hang its plate from the margin rather than float below it. Default 0.
   */
  emptyTop = 0,
): TvPanelPlace => {
  const d = TV_FLAT_DISTANCE
  const hh = d * Math.tan(((view.fovDeg / 2) * Math.PI) / 180)
  const hw = hh * view.aspect
  const portrait = view.aspect < 1
  const m = hh * 0.06
  const fitW = (wantW: number, maxH: number): number => Math.min(wantW, maxH * canvasAspect)
  let w: number
  let x = 0
  let y = 0
  if (kind === 'lowerThird') {
    // DEV-653: smaller and quieter, and top RIGHT in landscape (the controls are
    // top left, the bug bottom right, the subject centre). Portrait keeps the
    // bottom, which is where a thumb is not.
    w = portrait ? fitW(2 * hw - 2 * m, 2 * hh * 0.4) : fitW(2 * hw * 0.22, 2 * hh * 0.55)
    const h = w / canvasAspect
    x = portrait ? 0 : hw - m - w / 2
    y = portrait ? -hh + m + h / 2 : hh - m - h / 2 + emptyTop * h
  } else if (kind === 'banner') {
    // DEV-654: the lower third's line (`CUTTER takes #1`): bottom centre in
    // landscape (the bug is bottom right), above the board in portrait.
    w = portrait ? fitW(2 * hw - 2 * m, 2 * hh * 0.12) : fitW(2 * hw * 0.38, 2 * hh * 0.14)
    const h = w / canvasAspect
    y = portrait ? -hh + 2 * hh * 0.4 + m + h / 2 : -hh + m + h / 2
  } else if (kind === 'map') {
    // DEV-866: the mini-map and the followed racer's numbers. Landscape: bottom left, across
    // from the bug and clear of the board (top right). Portrait: top left; the board has the bottom.
    w = portrait ? fitW(2 * hw * 0.62, 2 * hh * 0.2) : fitW(2 * hw * 0.27, 2 * hh * 0.32)
    const h = w / canvasAspect
    x = -hw + m + w / 2
    y = portrait ? hh - m - h / 2 : -hh + m + h / 2
  } else if (kind === 'ident') {
    w = portrait ? fitW(2 * hw - 2 * m, 2 * hh * 0.4) : fitW(2 * hw * 0.56, 2 * hh * 0.4)
    y = hh * 0.18
  } else if (kind === 'bug') {
    // DEV-617, Matt: "show the faceted flight logo in the bottom right of the
    // screen". Landscape: the bottom-right corner, across from the lower third
    // (bottom-left) and under the ident and the results (centred). Portrait:
    // the lower third takes the bottom's whole width, so the TOP right.
    w = fitW(2 * hw * (portrait ? TV_BUG_SHARE.portrait : TV_BUG_SHARE.landscape), 2 * hh * 0.2)
    const h = w / canvasAspect
    x = hw - m - w / 2
    y = portrait ? hh - m - h / 2 : -hh + m + h / 2
  } else {
    w = portrait ? fitW(2 * hw - 2 * m, 2 * hh * 0.7) : fitW(2 * hw * 0.44, 2 * hh * 0.8)
    y = 0
  }
  return { position: [x, y, -d], yaw: 0, pitch: 0, width: w, height: w / canvasAspect }
}

/** Place `kind` in a headset, against `head` (the camera's LOCAL position at the cut). */
export const tvHeadsetPlacement = (
  kind: TvPanelKind,
  head: readonly [number, number, number],
  canvasAspect: number,
): TvPanelPlace => {
  const p = TV_HEADSET[kind]
  // Turned to face the eye, then tipped back toward it.
  const yaw = Math.atan2(-p.right, p.ahead)
  const pitch = Math.atan2(-p.up, Math.hypot(p.ahead, p.right))
  return {
    position: [head[0] + p.right, head[1] + p.up, head[2] - p.ahead],
    yaw,
    pitch,
    width: p.width,
    height: p.width / canvasAspect,
  }
}

/**
 * The headset rule (DEV-481): a panel is placed once per CUT, against the head
 * as it stood then. `update` returns the head to place against, which changes
 * only when the rig has moved (a cut, a teleport, a snap turn) or a session has
 * begun; between cuts it returns the same head however the wearer's head moves.
 */
export const TV_PANEL_REANCHOR_METRES = 0.6

/**
 * How the anchor re-places. `perCut` (the headset comfort cuts): on every rig
 * move. Otherwise rig-locked: on a change of `key` (the camera's mode) or a
 * head drift past `TV_PANEL_REANCHOR_METRES`. Absent is `perCut`.
 */
export interface TvAnchorPolicy {
  readonly perCut: boolean
  readonly key: string
}

export const createTvCutAnchor = () => {
  let rig: number[] | null = null
  let head: [number, number, number] = [0, 0, 0]
  let key: string | null = null
  let cuts = 0
  return {
    update(
      rigPose: readonly [number, number, number, number, number, number, number],
      headNow: readonly [number, number, number],
      policy: TvAnchorPolicy = { perCut: true, key: '' },
    ): { head: readonly [number, number, number]; cut: boolean } {
      const was = rig
      const moved = policy.perCut
        ? was === null ||
          rigPose.some((v, i) => Math.abs(v - (was[i] ?? Number.POSITIVE_INFINITY)) > 1e-6)
        : was === null ||
          key !== policy.key ||
          Math.hypot(headNow[0] - head[0], headNow[1] - head[1], headNow[2] - head[2]) >
            TV_PANEL_REANCHOR_METRES
      key = policy.key
      if (moved) {
        rig = [...rigPose]
        head = [headNow[0], headNow[1], headNow[2]]
        cuts++
      }
      return { head, cut: moved }
    },
    /** Forget: the next update places afresh (out of a session, or TV off). */
    reset(): void {
      rig = null
    },
    get cuts() {
      return cuts
    },
  }
}
