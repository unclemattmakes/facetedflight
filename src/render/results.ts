// src/render/results.ts — what you see when the run ends.
//
// PORT_PLAN M4, product P1: the slice needs *"a reason to play it twice"*. Until
// now a finished run swapped the gate count on the HUD for the word PLATINUM
// and wrote one line to the console. That is a scoreboard with no score on it.
//
// ── World space, not DOM ─────────────────────────────────────────────────
//
// `dom-overlay` is not reliably granted on Quest (CLAUDE.md), so a DOM results
// screen is invisible in a headset — in the one place this game is meant to be
// played. Same construction as the HUD: a canvas painted once per change, on a
// plane, unlit and depth-test-free so cockpit geometry cannot eat a corner of
// it. The difference is where it hangs: the HUD is INSET into the console under
// eye level, and this sits up at eye level where you cannot miss it.
//
// ── Drawn once per change, not per frame ─────────────────────────────────
//
// The panel is static the whole time it is up, so there is a signature and a
// redraw only when it moves. The HUD has the same guard for the opposite
// reason: its clock ticks eighty times a second and it shows whole seconds.

import type * as THREE from 'three'
import { phoneUi, RESULTS_PHONE_SCALE } from '@/render/phone-floor'
import { RESULTS_SETTLED, type ResultsFrame, resultsFrame } from '@/render/results-anim'
import { drawPlate, drawSelectedRow, drawTag, tagWidth } from '@/render/ui-draw'
import { createUiPlate, UI_PIXELS_PER_METRE } from '@/render/ui-plate'
import {
  UI_ACCENT as ACCENT,
  UI_DIM as DIM,
  uiFont as font,
  UI_INK as INK,
  UI_GAIN,
  uiType,
} from '@/render/ui-tokens'

/**
 * Where a runner is in the race.
 *
 * `flying` is not `dnf`, and conflating them was DEV-344: the panel was built
 * the tick the player crossed, so every racer still in the air printed `DNF`
 * and a won race read as a board of non-finishers. `dnf` is kept for a runner
 * that genuinely cannot finish — see `game/results-state.ts`.
 */
export type StandingStatus = 'finished' | 'flying' | 'dnf'

/** One opponent's result as it stands. `seconds` is non-null iff `finished`. */
export interface OpponentStanding {
  readonly name: string
  readonly seconds: number | null
  readonly status: StandingStatus
  /**
   * DEV-854: an AI racer, which the board marks with a tag. Absent for a human
   * (a player in a room) and for a recording (a ghost).
   */
  readonly ai?: boolean | undefined
}

/** A row on the board: an opponent, or the player (`you`). */
export interface Standing extends OpponentStanding {
  readonly you: boolean
  /**
   * DEV-855: the player's own callsign, drawn beside YOU where there is room.
   * Only ever on the `you` row, and absent when the device has none.
   */
  readonly callsign?: string | undefined
  /**
   * A player's ghost (DEV-371): listed in time order and never placed, because
   * it is a benchmark and not an entrant. See `withStandings`.
   */
  readonly ghost?: boolean
  /** Finishing place, shared on a dead heat; null until (unless) it crosses. */
  readonly place: number | null
  /** The player crossed and this racer did not cross first. Never set on `you`. */
  readonly beaten: boolean
}

/** Everything on the panel that is fixed the tick the run ended. */
export interface RunSummary {
  readonly medal: string
  /**
   * The panel's headline where it is not the medal, or absent. DEV-379: a run
   * whose mode TEACHES is headed `LESSON COMPLETE` (FLIGHT-INSTRUCTOR §7) —
   * a lesson awards no medal (call 11), and the word the medal slot would
   * otherwise print is `NONE`. `game/results-state.ts` decides it.
   */
  readonly heading?: string | undefined
  /**
   * Why there is no best, where the reason is not storage (DEV-601: the
   * autopilot flew part of the run), or absent.
   */
  readonly bestNote?: string | undefined
  /** The objective's count — rings, pads or orbs by mode. Labelled by `countLabel`. */
  readonly gates: number
  readonly gatesTotal: number
  readonly timeSeconds: number
  /** The objective's own score: rings in Ring Attack, pads in Target Practice. */
  readonly ringScore: number
  /**
   * The time bonus, which is the half DEV-014 added — or null where the mode's
   * rules earn none (`rulesFor(mode).timeBonus`), so no `+ 0 time` is printed.
   */
  readonly timeBonus: number | null
  /**
   * How many of the objective this run missed when missing them is what cost
   * it the time bonus, or 0 (DEV-393: a missed ring forfeits the bonus). Absent
   * reads as 0.
   */
  readonly timeBonusForfeit?: number | undefined
  /** `ringScore + timeBonus`. NEVER includes `proximityBonus` — see below. */
  readonly score: number
  /**
   * G1's pool, or 0 (DEV-110). Shown BESIDE the score and never folded into it.
   *
   * That separation is the whole balance answer for §4.1's first lever, not a
   * presentation choice: `score` is what medals are read from, so a bonus folded
   * in would change what a medal MEANS — and `int_01`'s platinum is 2,100 while
   * a clean 21-gate run scores exactly 2,100, which leaves no headroom at all.
   * Shown apart, the medal is 2016's on the same flight to the point, and the
   * bonus is the Anniversary score.
   *
   * It is also why the pool exists rather than a multiplier on the gate: a
   * player can read "2100 + 1219 time + 780 low" and learn three mechanics. A
   * single total teaches none of them.
   */
  readonly proximityBonus?: number | undefined
  /** G2's best clean-gate streak this run, or 0. A run's own record. */
  readonly cleanStreak?: number | undefined
  /**
   * Race seconds at the player's crossing of the finish, or null for a run the
   * clock ended. Same clock as a racer's `finishedAt`.
   */
  readonly finishedAt: number | null
  /** The best that now stands, or null when nothing could be stored. */
  readonly best: number | null
  /** True when THIS run set it. */
  readonly improved: boolean
  /** What to press. Worded by the caller, because it knows the input route. */
  readonly again: string
  /**
   * And what to press to LEAVE. One line under it.
   *
   * Two lines rather than one long one: naming both input routes for both
   * actions is 44 characters on a panel whose prompt was written for 23, and a
   * squeezed prompt reads as a font bug — the trap `paintLabel` in
   * `render/hangar.ts` already paid for once. Both get a `maxWidth` anyway.
   *
   * Empty draws nothing, so a caller with only one thing to offer still has a
   * panel that looks deliberate.
   */
  readonly back: string
  /**
   * What the count is OF — `GATES` in Ring Attack, and the mode's own word
   * otherwise.
   *
   * 2016 writes `Gates cleared:` on this line; the panel has room for one word,
   * so `uiLabelWord` takes the first and upper-cases it. Supplied by the caller
   * because the word is the MODE's, and this module draws a panel.
   */
  readonly countLabel: string
  /**
   * DEV-371: the third thing to press, "race this lap", or '' (or absent) where
   * the run left no lap to race. Drawn between `again` and `back`, as the
   * second of three prompts: it is another go, so it outranks leaving.
   */
  readonly race?: string | undefined
  /**
   * DEV-373: Share's block, drawn IN PLACE OF the board while it is up — the
   * handle to post under, the link once it is posted, or why it was not. The
   * board is the race as it stands and comes back with the next run; the link
   * is the one thing on this panel a player has to copy down, so it gets the
   * room. Null or absent draws the board.
   */
  readonly share?: ShareBlockView | null | undefined
  /**
   * DEV-431: the COURSE's board — the lap server's, not this race's — on a
   * plate of its own above the panel. Null or absent draws no plate: a course
   * that keeps no board, and a room, whose panel is the room's standings.
   */
  readonly world?: BoardPlateView | null | undefined
  /**
   * DEV-650: the one line under the best that says what to try next, or null.
   * `game/next-medal.ts`'s `2 MORE RINGS FOR GOLD` for a run with a medal left
   * to take, and `game/results-board.ts`'s `NEXT: BEAT STAN, 2.1s FASTER` for a
   * clean lap with a faster one on the board (the board's answer replaces the
   * medal's, and the two never apply to the same run). Absent draws nothing.
   */
  readonly next?: string | null | undefined
}

/** DEV-373's block: a small heading over one big line. `game/lap-share.ts` writes the words. */
export interface ShareBlockView {
  readonly heading: string
  readonly line: string
  readonly tone: 'accent' | 'ink' | 'dim'
  /**
   * A small line under `line`, drawn as given. DEV-571: what the link does
   * (`ANYONE WITH THIS LINK CAN WATCH OR RACE THIS LAP`), or what a press will
   * do. It was DEV-480's TV link (`WATCH ON TV <host>/tv/lap/<id>`) until the
   * lap's own link asked WATCH or RACE.
   */
  readonly detail?: string | undefined
}

/** DEV-431: one line of the course's board. `game/results-board.ts` writes the words. */
export interface BoardPlateRow {
  readonly rank: number
  /** Not the line after the one above it: drawn with a gap mark before the rank. */
  readonly gap: boolean
  readonly time: string
  readonly name: string
  /** The player's own line: drawn in the accent, as 2016 drew it in orange. */
  readonly mine: boolean
}

/** DEV-431: what the board plate says beside its lines, or in their place when there are none. */
export interface BoardPlateSay {
  readonly caption: string
  readonly line: string
  readonly detail: string
  readonly tone: 'accent' | 'ink' | 'dim'
}

/** DEV-431: the board plate. */
export interface BoardPlateView {
  readonly heading: string
  /** Which board: the edition, and the aircraft variant where there is a board per variant. */
  readonly sub: string
  readonly rows: readonly BoardPlateRow[]
  readonly say: BoardPlateSay | null
}

/** The run plus the race as it stands. Built by `game/results-state.ts`'s `withStandings`. */
export interface ResultsState extends RunSummary {
  /**
   * The board in race order, the player included — finishers by time, then
   * those still flying, then non-finishers. Empty when nobody else flew.
   *
   * Re-read every frame the panel is up, because the race outlives the run.
   */
  readonly standings: readonly Standing[]
  /** The player's finishing place, or null (no race, or the clock ended the run). */
  readonly place: number | null
  /** How many ran, the player included; 0 with no race. */
  readonly field: number
}

export interface Results {
  readonly object: THREE.Object3D
  /** Hidden until there is something to show. */
  setVisible(visible: boolean): void
  /**
   * `nowMs` is the caller's frame clock (DEV-650: the panel animates in, over
   * `render/results-anim.ts`'s timeline, from the first update after it is
   * shown). Defaults to `performance.now()`.
   */
  update(state: ResultsState, nowMs?: number): void
  /**
   * DEV-650: called once per appearance, on the first frame of the medal's stamp,
   * with the headline that stamped. Set by the caller; the cue for it is
   * DEV-644's (`audio/cues.ts`), wired where the panel is built.
   */
  onStamp: ((headline: string) => void) | null
  /**
   * The state the panel last DREW, or null before its first (DEV-390). A probe
   * reads this, not a second call of what the frame hands `update`: a copy of
   * the call would agree with itself however the frame's call went wrong.
   */
  readonly drawn: ResultsState | null
  dispose(): void
}

/**
 * Panel size in metres, and its texture resolution.
 *
 * Wider and taller than the HUD because it is read once, at a stop, rather than
 * glanced at during a turn — and it sits further away, at the windscreen rather
 * than on the console. 0.62 m at 1.05 m is about 33 degrees across, which is
 * inside the comfortable reading cone in a headset without being a wall.
 */
const WIDTH = 0.62
const HEIGHT = 0.34
const PIXELS_PER_METRE = UI_PIXELS_PER_METRE
/** The panel's size, metres: DEV-571's questions hang under it, or beside it on a touch screen. */
export const RESULTS_PANEL_HEIGHT = HEIGHT
export const RESULTS_PANEL_WIDTH = WIDTH

// The HUD's palette, because this is the same instrument (`ui-tokens.ts`).
const WIN = UI_GAIN

/** `74.3` — one decimal, which is the resolution a lap time is compared at. */
const secs = (s: number): string => `${s.toFixed(1)}s`

/** `1ST`, `2ND`, `11TH`, `23RD`. */
export const ordinal = (n: number): string => {
  const teen = n % 100 >= 11 && n % 100 <= 13
  const suffix = teen ? 'TH' : (['TH', 'ST', 'ND', 'RD'][n % 10] ?? 'TH')
  return `${n}${suffix}`
}

/**
 * The score's breakdown, or '' when there is nothing to break down.
 *
 * One term per thing the run earned: the objective, the time bonus where the
 * mode's rules award one (null otherwise — never `+ 0 time` on a mode that
 * cannot earn it, DEV-344), and G1's pool as a THIRD term rather than part of
 * the first — `score` is 2016's and the medal is read from it (DEV-110). A
 * single term is the score itself, printed twice, so it prints nothing.
 *
 * A time term the run FORFEITED says why (DEV-393): `0 time (2 missed)`. A
 * 26-second finish reading `+ 0 time` is a rule the player cannot see.
 */
export const scoreBreakdown = (state: ResultsState): string => {
  const terms = [String(state.ringScore)]
  if (state.timeBonus !== null) {
    const missed = state.timeBonusForfeit ?? 0
    terms.push(
      missed > 0 ? `${state.timeBonus} time (${missed} missed)` : `${state.timeBonus} time`,
    )
  }
  if (state.proximityBonus) terms.push(`${state.proximityBonus} near miss`)
  return terms.length > 1 ? terms.join(' + ') : ''
}

/**
 * The count line: `21/21 GATES   74.3s`, and the place where there was a race.
 *
 * `DNF` for a player the clock stopped — the one thing on the board a finished
 * run cannot say about itself.
 */
export const countLine = (state: ResultsState): { head: string; place: string } => ({
  head: `${state.gates}/${state.gatesTotal} ${state.countLabel}   ${secs(state.timeSeconds)}`,
  place:
    state.field === 0
      ? ''
      : state.place === null
        ? 'DNF'
        : `${ordinal(state.place)} OF ${state.field}`,
})

/** A board row's result: a time, `still flying`, or `DNF`. */
export const standingText = (s: Standing): string =>
  s.status === 'finished' && s.seconds !== null
    ? secs(s.seconds)
    : s.status === 'flying'
      ? 'still flying'
      : 'DNF'

// ── DEV-431: the course's board, on a plate of its own ───────────────────
//
// 2016's results room hung two panels side by side on one holotable canvas:
// `ui_results/results` ("Your Score") and `ui_results/leaderboard`
// ("LEADERBOARD" over the top five). The port's panel is a cockpit plate whose
// own board is the RACE (DEV-344) and whose space is spoken for, down to the
// row pitch; so the course's board is a second plate, hung on this one's top
// edge, the same width, and laid out from its OWN measures — nothing here reads
// the panel's rows or columns, which a room's names may widen (DEV-390).
//
// ABOVE, because below is the console: the HUD is inset there and stays up at
// the finish. The band above the panel is the briefing's, which is only up
// before the countdown. The top of the plate is 0.38 m over the eye at 0.95 m,
// 22 degrees: inside a flat build's 35-degree half-height and an easy glance
// up in a headset. A CHILD of the panel, so it banks with the cockpit, shows
// and hides with it, and carries the panel's `depthTest: false` and order.

/** The board plate's height, metres. Six lines under a heading, at the panel's own type size. */
const BOARD_HEIGHT = 0.18
/** Between the panel's top edge and the plate, metres. */
const BOARD_GAP = 0.012

interface BoardPlate {
  readonly object: THREE.Mesh
  /** Redraw on a change; true when it drew. */
  update(view: BoardPlateView | null): boolean
  dispose(): void
}

const createBoardPlate = (): BoardPlate & { setOpacity(opacity: number): void } => {
  // The panel's material, for the panel's reasons (see `createResults`).
  const plate = createUiPlate({
    name: 'results-board',
    widthM: WIDTH,
    heightM: BOARD_HEIGHT,
    renderOrder: 11, // the panel's
    pxPerM: PIXELS_PER_METRE,
  })
  const { canvas, ctx, object } = plate
  object.position.set(0, HEIGHT / 2 + BOARD_GAP + BOARD_HEIGHT / 2, 0)

  // Type in the PANEL's pixels, so a line here is the size of a line there.
  const panelPx = HEIGHT * PIXELS_PER_METRE
  const toneInk = (tone: BoardPlateSay['tone']): string =>
    tone === 'accent' ? ACCENT : tone === 'ink' ? INK : DIM

  const draw = (view: BoardPlateView) => {
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    // DEV-647: broadcast plate, and the type scale off the board's own title (its
    // hero, the place, is 0.1 of the panel).
    const T = uiType((panelPx * 0.1) / 1.4, PIXELS_PER_METRE)
    drawPlate(ctx, w, h, { bar: panelPx * 0.022, lineWidth: Math.max(2, panelPx * 0.005) })

    const pad = w * 0.055
    ctx.textBaseline = 'middle'

    // ── the heading: 2016's word, and which board ───────────────────────
    const headY = h * 0.15
    ctx.textAlign = 'left'
    ctx.fillStyle = INK
    ctx.font = font(T.label, 700)
    ctx.fillText(view.heading, pad, headY)
    if (view.sub) {
      ctx.textAlign = 'right'
      ctx.fillStyle = DIM
      ctx.font = font(T.sub, 600)
      ctx.fillText(view.sub, w - pad, headY, w * 0.5)
    }

    const say = view.say
    if (view.rows.length === 0) {
      // ── nothing to list: the plate says why, across its whole width ───
      if (say) {
        ctx.textAlign = 'center'
        if (say.caption) {
          ctx.fillStyle = DIM
          ctx.font = font(T.sub, 600)
          ctx.fillText(say.caption, w / 2, h * 0.4, w - 2 * pad)
        }
        ctx.fillStyle = toneInk(say.tone)
        ctx.font = font(T.title, 700)
        ctx.fillText(say.line, w / 2, h * 0.58, w - 2 * pad)
        if (say.detail) {
          ctx.fillStyle = DIM
          ctx.font = font(T.sub, 500)
          ctx.fillText(say.detail, w / 2, h * 0.78, w - 2 * pad)
        }
      }
      plate.commit()
      return
    }

    // ── the lines: `rank.  time  HANDLE`, 2016's order of the three ───────
    //
    // The rank and the time are right-aligned in columns measured for the
    // widest either can be (`…100.`, `999.99s`), so the times line up to
    // compare; the handle takes what is left of the left 60 %, which holds the
    // longest generated handle (20 characters) at this size.
    ctx.font = font(T.label, 500)
    const rankW = ctx.measureText('…100.').width
    const timeW = ctx.measureText('999.99s').width
    const gap = w * 0.018
    const listRight = w * 0.6
    const rankX = pad + rankW
    const timeX = rankX + gap + timeW
    const nameX = timeX + gap
    const top = h * 0.31
    const pitch = (h * 0.87 - top) / 5
    view.rows.forEach((row, i) => {
      const y = top + i * pitch
      // DEV-855: your own line is picked out with a wash and reads YOU, with the
      // handle you posted under beside it.
      if (row.mine) {
        drawSelectedRow(
          ctx,
          pad * 0.5,
          y - pitch * 0.46,
          listRight - pad * 0.5,
          pitch * 0.92,
          w * 0.005,
        )
      }
      ctx.fillStyle = row.mine ? ACCENT : INK
      ctx.textAlign = 'right'
      ctx.fillText(`${row.gap ? '…' : ''}${row.rank}.`, rankX, y)
      ctx.fillText(row.time, timeX, y)
      ctx.textAlign = 'left'
      if (row.mine) {
        const youW = ctx.measureText('YOU  ').width
        ctx.fillText('YOU', nameX, y)
        ctx.fillText(row.name, nameX + youW, y, Math.max(1, listRight - nameX - youW))
      } else {
        ctx.fillText(row.name, nameX, y, Math.max(1, listRight - nameX))
      }
    })

    // ── beside them: where you stand, or would ──────────────────────────
    if (say) {
      const cx = (listRight + w - pad) / 2
      const room = w - pad - listRight - w * 0.02
      ctx.textAlign = 'center'
      if (say.caption) {
        ctx.fillStyle = DIM
        ctx.font = font(T.sub, 600)
        ctx.fillText(say.caption, cx, h * 0.42, room)
      }
      if (say.line) {
        ctx.fillStyle = toneInk(say.tone)
        ctx.font = font(T.hero, 700)
        ctx.fillText(say.line, cx, h * 0.62, room)
      }
      if (say.detail) {
        ctx.fillStyle = DIM
        ctx.font = font(T.sub, 500)
        ctx.fillText(say.detail, cx, h * 0.82, room)
      }
    }
    plate.commit()
  }

  let signature = ''
  return {
    object,
    setOpacity(opacity) {
      plate.material.opacity = opacity
    },
    update(view) {
      object.visible = view !== null
      const next = view === null ? '' : JSON.stringify(view)
      if (next === signature) return false
      signature = next
      if (view) draw(view)
      return true
    },
    dispose() {
      plate.dispose()
    },
  }
}

export const createResults = (): Results => {
  // Unlit, untoned (`render/tone.ts`, DEV-081: the medal colours on this panel are
  // authored values and have to survive a preset flip) and undepthed, for the
  // HUD's reason: the camera lives inside the cockpit, and an instrument you
  // cannot read because a strut is in front of it is not an instrument. Revisit
  // if a third-person view ever lands. All of it is `ui-plate.ts`.
  const plate = createUiPlate({
    name: 'results',
    widthM: WIDTH,
    heightM: HEIGHT,
    renderOrder: 11, // above the HUD, which is 10
    pxPerM: PIXELS_PER_METRE,
  })
  const { canvas, ctx, object } = plate
  // DEV-431: the course's board, a child plate above this one (see `createBoardPlate`).
  const board = createBoardPlate()
  object.add(board.object)

  let signature = ''
  let drawnState: ResultsState | null = null
  // DEV-650: when the panel appeared (null until its first update after being
  // shown), whether the stamp's cue has fired for this appearance, and the last
  // frame drawn, so the animation redraws exactly while it is moving.
  let appearedMs: number | null = null
  let stampFired = false
  let lastFrame: ResultsFrame = RESULTS_SETTLED
  let onStamp: ((headline: string) => void) | null = null
  const prefersReducedMotion = (): boolean =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  /** The run's numbers at `c` of the way to their final value (the count-up). */
  const counted = (state: ResultsState, c: number): ResultsState =>
    c >= 1
      ? state
      : {
          ...state,
          gates: Math.round(state.gates * c),
          timeSeconds: state.timeSeconds * c,
          score: Math.round(state.score * c),
          ringScore: Math.round(state.ringScore * c),
          timeBonus: state.timeBonus === null ? null : Math.round(state.timeBonus * c),
          timeBonusForfeit: state.timeBonusForfeit ?? 0,
          proximityBonus: state.proximityBonus ? Math.round(state.proximityBonus * c) : 0,
        }

  const draw = (finalState: ResultsState, frame: ResultsFrame) => {
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    // The numbers climb to the final state; everything else reads the final one.
    const state = counted(finalState, frame.count)

    // The plate.
    // DEV-647: broadcast plate; the three sizes (and the hero medal) off a title of
    // 0.11 of the plate, so the dense lines come out at the old 0.05.
    const T = uiType(h * 0.11, PIXELS_PER_METRE)
    drawPlate(ctx, w, h, { bar: h * 0.022, lineWidth: Math.max(2, h * 0.005) })

    const pad = w * 0.055
    let y = h * 0.15

    // ── the medal, which is the headline ────────────────────────────────
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = ACCENT
    ctx.font = font(T.hero)
    // DEV-650: the headline STAMPS in: it lands big and settles (`stampScale`),
    // from a faint first frame to full ink. Nothing is drawn before the stamp.
    // DEV-379's heading is fifteen characters to the medal's eight: held to
    // the plate's width, which it fits at this size with room to spare, and
    // held to it AFTER the scale, so the big first frame never leaves the plate.
    if (frame.stamped) {
      ctx.save()
      ctx.translate(w / 2, y)
      ctx.scale(frame.stampScale, frame.stampScale)
      ctx.globalAlpha = Math.min(1, 0.35 + frame.stamp * 3)
      ctx.fillText(
        (state.heading ?? state.medal).toUpperCase(),
        0,
        0,
        (w * 0.94) / frame.stampScale,
      )
      ctx.restore()
    }

    y += h * 0.13
    ctx.font = font(T.sub, 500)
    // The place rides on the count line, inked brighter than it: it is the
    // answer to "did I win", and a line of its own would cost the board a row.
    // Laid out by hand so the pair stays centred as one line.
    // DEV-650: laid out from the FINAL line, so the pair does not slide as the
    // digits climb; the place waits for the count to land.
    const line = countLine(state)
    const final = countLine(finalState)
    const gap = final.place ? '   ' : ''
    const headW = ctx.measureText(final.head + gap).width
    const lineX = w / 2 - (headW + ctx.measureText(final.place).width) / 2
    ctx.textAlign = 'left'
    ctx.fillStyle = DIM
    ctx.fillText(line.head + gap, lineX, y)
    if (final.place && frame.count >= 1) {
      ctx.fillStyle = state.place === 1 ? WIN : INK
      ctx.fillText(final.place, lineX + headW, y)
    }

    // ── the score, broken into its two halves ───────────────────────────
    //
    // Shown apart because they are: DEV-014 made time contribute to the medal,
    // and a single total hides the decision. A player who sees "2100 + 1219"
    // knows that flying faster is worth something.
    y += h * 0.16
    ctx.textAlign = 'left'
    ctx.fillStyle = INK
    ctx.font = font(T.label)
    ctx.fillText(String(state.score), pad, y)
    ctx.fillStyle = DIM
    ctx.font = font(T.sub, 500)
    // See `scoreBreakdown` for which terms, and why a lone term prints nothing.
    const breakdown = scoreBreakdown(state)
    // G2's run record, on the same line's right. Two or more, for the reason the
    // HUD's corner draws nothing at one: a streak of one is not a streak, and a
    // panel that always shows a number trains the eye past it (DEV-044).
    const streak = (state.cleanStreak ?? 0) > 1 ? `${state.cleanStreak} clean in a row` : ''
    // The breakdown gets what the streak leaves, so DEV-393's longer forfeit term
    // (`0 time (2 missed)`) squeezes rather than running under the streak.
    const breakdownX = pad + w * 0.2
    const streakW = streak ? ctx.measureText(streak).width + w * 0.03 : 0
    if (breakdown) {
      ctx.fillText(`  ${breakdown}`, breakdownX, y + h * 0.012, w - pad - streakW - breakdownX)
    }
    if (streak) {
      ctx.textAlign = 'right'
      ctx.fillText(streak, w - pad, y + h * 0.012)
      ctx.textAlign = 'left'
    }

    // ── the best, and the delta ─────────────────────────────────────────
    y += h * 0.13
    ctx.font = font(T.sub, 600)
    if (state.best === null) {
      ctx.fillStyle = DIM
      ctx.fillText(`BEST  ${state.bestNote ?? 'not saved on this device'}`, pad, y)
    } else if (state.improved) {
      // DEV-650: NEW BEST flashes between the win ink and the plain ink, a touch
      // larger on the lit beats, and settles on the win ink.
      if (frame.best !== 'hidden') {
        ctx.fillStyle = frame.best === 'off' ? INK : WIN
        ctx.font = font(T.sub * (frame.best === 'on' ? 1.08 : 1), 600)
        ctx.fillText(`NEW BEST  ${state.best}`, pad, y)
        ctx.font = font(T.sub, 600)
      }
    } else if (frame.count >= 1) {
      const delta = state.score - state.best
      ctx.fillStyle = DIM
      ctx.fillText(`BEST  ${state.best}   (${delta >= 0 ? '+' : ''}${delta})`, pad, y)
    }

    // ── DEV-650: what to try next ───────────────────────────────────────
    //
    // One line on the best's own row, right-aligned, in the accent, fading in
    // after the stamp. The medal's own gap or the lap to beat
    // (`game/next-medal.ts`, `game/results-board.ts`): never both, because a clean
    // run has no medal left and a run with a medal left is not on the board. On
    // the best's row because that row's right half is empty, so the board and the
    // share block below it keep every pixel they had. Squeezed to what the best
    // text leaves, never run under it.
    const nextLine = (state.next ?? '').trim()
    if (nextLine && frame.next > 0) {
      ctx.save()
      ctx.globalAlpha = frame.next
      ctx.textAlign = 'right'
      ctx.fillStyle = ACCENT
      ctx.font = font(T.sub, 700)
      const leftW =
        state.best === null
          ? ctx.measureText(`BEST  ${state.bestNote ?? 'not saved on this device'}`).width
          : w * 0.34
      ctx.fillText(nextLine, w - pad, y, Math.max(1, w - 2 * pad - leftW - w * 0.03))
      ctx.restore()
      ctx.textAlign = 'left'
    }

    // ── the board ───────────────────────────────────────────────────────
    //
    // In race order, the player included, and in TWO columns past three rows:
    // a single column of six (five racers and you) ran from 0.67 to 0.98 of
    // the plate, straight through both press prompts. Filled down the left
    // column first, so it reads as a list. The row pitch shrinks rather than
    // the rows running into the prompts, for a grid bigger than any preset
    // ships today.
    const rows = state.standings.length > 3 ? Math.ceil(state.standings.length / 2) : 3
    // DEV-371: a third prompt takes a line, so the board starts a little higher
    // and stops a little sooner. Only when it is offered: a panel with nothing
    // to race is the panel it always was.
    const hasRace = (state.race ?? '').length > 0
    const top = y + (hasRace ? h * 0.075 : h * 0.1)
    const pitch = Math.min(
      h * 0.062,
      ((hasRace ? h * 0.765 : h * 0.83) - top) / Math.max(1, rows - 1),
    )
    const colW = (w - 2 * pad) / 2
    const colGap = w * 0.04
    // The type follows a pitch squeezed below its own size, so four rows of a
    // column (five racers, you and a ghost) stay four lines and not one smear.
    // Nothing ships that squeezes it without the race line: 0.05 is the size
    // at every pitch the panel had before DEV-371.
    ctx.font = font(Math.min(T.sub, pitch * 1.12), 500)
    const share = state.share ?? null
    if (share) {
      // ── DEV-373: Share's block, where the board was ──────────────────
      //
      // The line is the biggest type below the medal and the score, because it
      // is the one thing here a player may have to copy down — in a headset,
      // off a panel a metre away. 0.07 of the plate is 33 px of this 476 px
      // canvas, a 24 mm em on the 0.34 m plate. Monospace advances ~0.6 em, so
      // the longest host we deploy to (`main.ff-10yr.pages.dev/?ghost=` and a
      // ten-character id, 40 characters) is 0.91 of the width and is not
      // squeezed by the `maxWidth` below.
      ctx.textAlign = 'center'
      ctx.fillStyle = DIM
      ctx.font = font(T.sub, 600)
      ctx.fillText(share.heading, w / 2, top + h * 0.005, w * 0.94)
      ctx.fillStyle = share.tone === 'accent' ? ACCENT : share.tone === 'ink' ? INK : DIM
      ctx.font = font(T.label, 700)
      ctx.fillText(share.line, w / 2, top + h * 0.085, w * 0.94)
      // DEV-571: what the link does, small, under it (DEV-480's TV link sat here).
      if (share.detail) {
        ctx.fillStyle = DIM
        ctx.font = font(T.sub, 600)
        ctx.fillText(share.detail, w / 2, top + h * 0.15, w * 0.94)
      }
      ctx.textAlign = 'left'
    }
    ;(share ? [] : state.standings).forEach((row, i) => {
      const col = state.standings.length > 3 ? Math.floor(i / rows) : 0
      const x = pad + col * colW
      const ry = top + (i % rows) * pitch
      // DEV-855: the player's own line is picked out, as a selected row is: a
      // wash and the accent bar behind it, so it reads at a glance.
      if (row.you) {
        drawSelectedRow(
          ctx,
          x - w * 0.018,
          ry - pitch * 0.46,
          colW - colGap + w * 0.018,
          pitch * 0.92,
          w * 0.006,
        )
      }
      ctx.fillStyle = row.you ? ACCENT : row.beaten ? WIN : DIM
      // The result right-aligned to the column, so times line up to compare.
      const result = standingText(row)
      ctx.textAlign = 'right'
      ctx.fillText(result, x + colW - colGap, ry)
      // DEV-390: a long name — a room's handle with its variant and `assisted`
      // marks — is squeezed into what the result leaves, never run under it.
      // A name that fits is drawn exactly as before (`maxWidth` only narrows).
      const room = colW - colGap - ctx.measureText(result).width - w * 0.02
      ctx.textAlign = 'left'
      const lead = `${row.place ?? ' '}  `
      const rowFont = ctx.font
      // DEV-854: an AI rival wears a tag, so its width comes off the name's room.
      const tagSize = Math.min(T.sub, pitch * 0.62)
      const tagW = row.ai ? tagWidth(ctx, tagSize) + w * 0.012 : 0
      ctx.font = rowFont
      // DEV-855: the player's line reads YOU, and the callsign sits beside it, in
      // the small type, where the column has room (dropped when it has almost none).
      const word = row.you ? 'YOU' : row.name.toUpperCase()
      ctx.fillText(`${lead}${word}`, x, ry, Math.max(1, room - tagW))
      if (row.you && row.callsign) {
        const used = Math.min(Math.max(1, room - tagW), ctx.measureText(`${lead}${word}`).width)
        ctx.font = font(T.sub, 600)
        const left = room - tagW - used - w * 0.015
        const want = ctx.measureText(row.callsign.toUpperCase()).width
        if (left >= want * 0.6) {
          ctx.fillText(row.callsign.toUpperCase(), x + used + w * 0.015, ry, left)
        }
        ctx.font = rowFont
      }
      if (row.ai) {
        const nameW = Math.min(Math.max(1, room - tagW), ctx.measureText(`${lead}${word}`).width)
        drawTag(ctx, x + nameW + w * 0.012, ry, tagSize, row.beaten ? WIN : DIM)
        ctx.font = rowFont
      }
    })
    ctx.textAlign = 'left'

    // ── what to press ───────────────────────────────────────────────────
    ctx.textAlign = 'center'
    ctx.fillStyle = ACCENT
    ctx.font = font(T.sub, 600)
    const hasBack = state.back.length > 0
    if (hasRace) {
      // Three lines: again, race this lap, and the way out. The second is an
      // action like the first, so it keeps the accent at the smaller size.
      ctx.fillText(state.again.toUpperCase(), w / 2, h * 0.84, w * 0.94)
      ctx.font = font(T.sub, 600)
      ctx.fillText((state.race ?? '').toUpperCase(), w / 2, h * 0.893, w * 0.94)
      if (hasBack) {
        ctx.fillStyle = DIM
        ctx.font = font(T.sub, 500)
        ctx.fillText(state.back.toUpperCase(), w / 2, h * 0.943, w * 0.94)
      }
      plate.commit()
      return
    }
    // Lifted off the bottom when there are two lines: at 0.958 the second one
    // sat in the plate's rounded corner, which reads as text falling off a card.
    ctx.fillText(state.again.toUpperCase(), w / 2, hasBack ? h * 0.878 : h * 0.93, w * 0.94)
    if (hasBack) {
      // Dimmer than the primary. Flying again is what most people want after a
      // run; leaving is what they need to be ABLE to find.
      ctx.fillStyle = DIM
      ctx.font = font(T.sub, 500)
      ctx.fillText(state.back.toUpperCase(), w / 2, h * 0.937, w * 0.94)
    }

    plate.commit()
  }

  return {
    object,
    setVisible(visible: boolean) {
      // DEV-650: a panel that is shown starts its animation afresh, and one that
      // is hidden forgets it: the next appearance is another run's.
      if (!visible || !object.visible) {
        appearedMs = null
        stampFired = false
      }
      object.visible = visible
    },
    get onStamp() {
      return onStamp
    },
    set onStamp(fn: ((headline: string) => void) | null) {
      onStamp = fn
    },
    update(state: ResultsState, nowMs: number = performance.now()) {
      // DEV-650: the clock of this appearance, and where the animation is on it.
      appearedMs ??= nowMs
      const frame = resultsFrame((nowMs - appearedMs) / 1000, {
        improved: state.improved && state.best !== null,
        reduced: prefersReducedMotion(),
      })
      plate.material.opacity = frame.enter
      board.setOpacity(frame.enter)
      const scale = 0.94 + 0.06 * frame.enter
      // DEV-894: a phone's panel is larger (`phone-floor.ts`).
      const k = phoneUi.on ? RESULTS_PHONE_SCALE : 1
      object.scale.set(scale * k, scale * k, 1)
      if (frame.stamped && !stampFired) {
        stampFired = true
        onStamp?.((state.heading ?? state.medal).toUpperCase())
      }
      // DEV-431: the board plate redraws on its own signature, and what it drew
      // is part of what the panel last drew.
      if (board.update(state.world ?? null)) drawnState = state
      const next = [
        state.medal,
        state.heading ?? '',
        state.gates,
        state.gatesTotal,
        state.timeSeconds.toFixed(1),
        state.score,
        state.ringScore,
        state.timeBonus ?? 'none',
        state.timeBonusForfeit ?? 0,
        // Drawn, so in the signature: "drawn and not in the signature is how a
        // label goes stale until something else moves it" (`hud.ts`).
        state.proximityBonus ?? 0,
        state.cleanStreak ?? 0,
        state.best ?? 'none',
        state.improved,
        state.again,
        state.back,
        state.race ?? '',
        state.share
          ? `${state.share.heading}|${state.share.line}|${state.share.tone}|${state.share.detail ?? ''}`
          : '',
        state.countLabel,
        state.next ?? '',
        state.place ?? 'none',
        state.field,
        // The part that MOVES while the panel is up (DEV-344): a racer's time
        // arrives the frame it crosses, and this is the only thing that says so.
        state.standings
          .map(
            (s) =>
              `${s.name}:${s.status}:${s.seconds ?? ''}:${s.place ?? ''}:${s.beaten}:${s.ghost === true}:${s.ai === true}:${s.callsign ?? ''}`,
          )
          .join(','),
      ].join('|')
      // While the animation is moving the panel repaints every frame; once it
      // has settled it is back to drawing on a change (the frame is part of the
      // signature only through `done`, so the last settled paint is the one kept).
      const moving = !frame.done || !lastFrame.done
      if (next === signature && !moving) return
      signature = next
      lastFrame = frame
      drawnState = state
      draw(state, frame)
    },
    get drawn() {
      return drawnState
    },
    dispose() {
      board.dispose()
      plate.dispose()
    },
  }
}
