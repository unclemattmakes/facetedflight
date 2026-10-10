// src/game/lap-ask.ts: the questions after a lap, as one menu. DEV-571.
//
// Matt, 2026-10-02, after playing 0.17.0: *"sharing a lap - a.) always ask if
// they want to post to the leaderboard b.) ask if they want to save their
// ghost"*, and *"need clearer language for sharing ghost laps"*.
//
// Until now both happened out of sight. A lap that beat the saved one was
// saved on the finish tick and nothing said so; posting was two presses of a
// button the panel named in passing (`SELECT or G to share it`), with the name
// it would post under shown only after the first. So the panel now carries a
// menu under it, the MENUS' OWN plate (`render/pause.ts`), answered the way
// every menu in the game is: the stick, the D-pad or the arrow keys walk it,
// a head or a laser aims it in a headset, a cursor or a finger picks a row,
// and A, Enter, the trigger or a click presses. One plate, not a chain of
// popups, and nothing on it stands between the player and another go:
// START (BACKSPACE, the FLY AGAIN chip) flies again whatever the plate says,
// and "race this lap" is still Y or R.
//
//   POST TO LEADERBOARD?   NO     press to post it as Swift Kestrel 42
//   ANOTHER NAME                  names are made up; press for a new one
//   SAVED AS YOUR GHOST     YES    it flies with you next time on this course
//   BACK TO THE HANGAR            leave this course
//
// It opens on the last row, so A after a run still goes home (DEV-406, Matt:
// *"take me back to the hangar when i press A"*), and posting takes a move and
// a press, never a press alone.
//
// ── The answers ──────────────────────────────────────────────────────────
//
// POST: nothing is posted without the press on its row, ever (the privacy
// page's first promise, PLAYER-GHOSTS §8 call 9). The answer reads NO until
// then. The row is absent where the course has no leaderboard, and says why
// where the lap cannot go on one (the autopilot flew it).
//
// SAVE: the answer starts where the game used to leave it, YES for a lap that
// beats the saved one (it is saved on the finish tick, so a quick retry races
// it) and NO otherwise, and the press moves it either way: YES saves this lap
// over whatever is saved, faster or not; NO puts back what was saved before
// (`LapRun.keepLast`). A call for Matt: the default could be NO for every lap.
//
// PURE: the rows and what a press on each one means. `boot/app.ts` holds the
// plate, the aim and the network; `lap-share.ts` is the post's own state.

import type { PauseOption } from '@/render/pause'
import type { ShareState } from './lap-share'

/** The rows, by id. `app.ts` switches on these; specs name them. */
export const LAP_ASK_ROW = {
  post: 'lap-post',
  name: 'lap-name',
  keep: 'lap-keep',
  home: 'lap-home',
} as const

/** The plate's heading. */
export const LAP_ASK_HEADING = '- YOUR LAP -'

/** What the rows are a function of, as plain values `app.ts` reads off the run. */
export interface LapAskFacts {
  /** The post's own state (`lap-share.ts`). */
  readonly share: ShareState
  /** The course has a leaderboard this lap's rules are filed under (`boardedLap`). */
  readonly boarded: boolean
  /** It may be posted (`shareable`): boarded and clean. */
  readonly postable: boolean
  /** Why it is tainted (`FlownLap.reasons`), when it is. */
  readonly taint: readonly string[]
  /** Saved as your ghost now (`LapRun.lastKept`), or null where it cannot be. */
  readonly kept: boolean | null
  /** The seconds of the lap saved before this one finished, or null. */
  readonly savedBefore: number | null
  /** Where the last row goes: the hangar, or the editor after a playtest (DEV-469). */
  readonly home: 'hangar' | 'editor'
  /**
   * DEV-629: the place this lap would take on its board, read off the board
   * the results panel already fetched ({@link lapWouldRank}), or null where it
   * is not known or would not make it. Absent reads as null.
   */
  readonly wouldRank?: number | null
}

/**
 * DEV-629 (Matt, 2026-10-04): *"make submit to leaderboards "yes" the default
 * if they rank in the top 1000"*. The rank at or under which the question
 * opens on YES. Matt's number; the server keeps only `LAP_BOARD_SIZE` (100)
 * laps a board, so today the binding limit is the board, not this.
 */
export const LAP_ASK_YES_RANK = 1000

/**
 * DEV-629: where a lap of `seconds` would land on a board whose rows are
 * `boardSeconds` (any order), as the server ranks it (`lap-server.ts`: by
 * seconds, an equal time behind the older lap), or null when it would not be
 * kept: the board is `boardSize` long and the lap is behind all of it.
 *
 * The rank is KNOWN before the question because the results panel fetches the
 * board as the run ends (`loadResultsBoard`); a board that has not landed, or
 * failed, is the caller's null. One approximation: the server keeps one lap
 * per owner, so a player whose own slower lap is on the board reads one place
 * lower here than the server will give.
 */
export const lapWouldRank = (
  seconds: number,
  boardSeconds: readonly number[],
  boardSize: number,
): number | null => {
  if (!Number.isFinite(seconds)) return null
  let ahead = 0
  for (const s of boardSeconds) if (s <= seconds) ahead += 1
  const rank = ahead + 1
  return rank <= boardSize ? rank : null
}

/** DEV-629: does the question open on YES for this lap? */
export const lapAskDefaultsYes = (f: LapAskFacts): boolean =>
  f.boarded &&
  f.postable &&
  f.share.phase === 'idle' &&
  f.wouldRank != null &&
  f.wouldRank <= LAP_ASK_YES_RANK

/** DEV-856: the keep row's label while the lap is saved, and while it is only a question. */
export const LAP_ASK_SAVED_LABEL = 'Saved as your ghost'
export const LAP_ASK_SAVE_LABEL = 'Save as your ghost?'
/** DEV-856: what a saved first lap means, named where it happens. */
export const LAP_ASK_SAVED_NOTE = 'it flies with you next time on this course'

/** A note is one line of the plate's small type; longer than this runs off its edge. */
export const LAP_ASK_NOTE_MAX = 42

/** `text`, or `otherwise` when it would not fit a note. */
const noteOr = (text: string | null, otherwise: string): string =>
  text !== null && text.length > 0 && text.length <= LAP_ASK_NOTE_MAX ? text : otherwise

/** Why a lap on a course with a leaderboard cannot go on it, in a stranger's words. */
export const taintWords = (reasons: readonly string[]): string => {
  if (reasons.includes('autopilot')) return 'the autopilot flew part of this lap'
  if (reasons.includes('edition changed mid-lap')) return 'the look changed during the lap'
  const key = reasons[0]
  return key
    ? noteOr(`a test switch is on: ?${key}`, 'a test switch is on')
    : 'it cannot be checked'
}

const secs = (s: number): string => `${s.toFixed(1)} s`

/** POST TO LEADERBOARD?, for the state it is in. Null where the course has no leaderboard. */
const postRow = (f: LapAskFacts): PauseOption | null => {
  if (!f.boarded) return null
  const id = LAP_ASK_ROW.post
  if (!f.postable) {
    return { id, label: 'Leaderboard', value: "Can't post", note: taintWords(f.taint) }
  }
  const s = f.share
  switch (s.phase) {
    case 'idle':
      // DEV-629: a lap that would rank opens AIMED here (`lapAskOpeningRowFor`),
      // so A is yes; the note says where it lands. Still nothing is sent
      // without the press (the privacy page's promise), so the answer reads
      // NO until it is pressed.
      return lapAskDefaultsYes(f)
        ? {
            id,
            label: 'Post to leaderboard?',
            value: 'No',
            note: noteOr(
              `#${f.wouldRank}! press to post as ${s.handle ?? ''}`,
              `#${f.wouldRank}! press to post it`,
            ),
            accentNote: true,
          }
        : {
            id,
            label: 'Post to leaderboard?',
            value: 'No',
            note: noteOr(`press to post it as ${s.handle ?? ''}`, 'press to post it'),
          }
    case 'posting':
      return { id, label: 'Posting', note: 'sending the lap to the leaderboard' }
    case 'posted':
      return s.board
        ? {
            id,
            label: 'Posted',
            value: s.rank !== null ? `#${s.rank}` : 'Ranked',
            note: 'press to take it down',
          }
        : {
            id,
            label: 'Posted',
            value: 'Not ranked',
            note: noteOr(s.reason, 'the link works; not on the leaderboard'),
          }
    case 'failed':
      return {
        id,
        label: 'Not posted',
        value: 'Retry',
        note: noteOr(s.reason, 'press to try again'),
      }
    case 'confirm-delete':
      return {
        id,
        label: 'Take it down?',
        value: 'Confirm',
        note: 'press again; the link will stop working',
        accentNote: true,
      }
    case 'deleting':
      return { id, label: 'Taking it down', note: 'deleting it from the server' }
    case 'deleted':
      return { id, label: 'Taken down', note: 'the link no longer works' }
    case 'delete-failed':
      return {
        id,
        label: 'Not taken down',
        value: 'Retry',
        note: noteOr(s.reason, 'press to try again'),
      }
  }
}

/** ANOTHER NAME, while a name can still be changed. */
const nameRow = (f: LapAskFacts): PauseOption | null =>
  f.boarded && f.postable && (f.share.phase === 'idle' || f.share.phase === 'failed')
    ? {
        id: LAP_ASK_ROW.name,
        label: 'Another name',
        note: 'names are made up; press for a new one',
      }
    : null

/**
 * SAVE AS YOUR GHOST?, where this lap can be saved at all. DEV-856: once the
 * answer is YES the row SAYS it is done ("SAVED AS YOUR GHOST") and what that
 * means ("it flies with you next time on this course"), at the moment it
 * becomes true; a NO puts the question back.
 */
const keepRow = (f: LapAskFacts): PauseOption | null => {
  if (f.kept === null) return null
  const before = f.savedBefore
  const note = f.kept
    ? before === null
      ? LAP_ASK_SAVED_NOTE
      : `replaces your ${secs(before)}; flies with you next`
    : before === null
      ? 'no ghost is saved for this course'
      : `keeps your saved ${secs(before)} ghost`
  return {
    id: LAP_ASK_ROW.keep,
    label: f.kept ? LAP_ASK_SAVED_LABEL : LAP_ASK_SAVE_LABEL,
    value: f.kept ? 'Yes' : 'No',
    note,
    ...(f.kept ? { accentNote: true } : {}),
  }
}

/** The last row: home, which is where A went after a run before there was a menu. */
const homeRow = (f: LapAskFacts): PauseOption => ({
  id: LAP_ASK_ROW.home,
  label: f.home === 'editor' ? 'Back to the editor' : 'Back to the hangar',
  note: f.home === 'editor' ? 'with this lap' : 'leave this course',
})

/** The plate's rows, top to bottom. Never empty: home is always last. */
export const lapAskRows = (f: LapAskFacts): PauseOption[] =>
  [postRow(f), nameRow(f), keepRow(f), homeRow(f)].filter((r): r is PauseOption => r !== null)

/** Is there anything to ASK? A plate of one row (home) is the plain panel's A. */
export const lapAskAsks = (f: LapAskFacts): boolean => lapAskRows(f).length > 1

/** What a press on a row does. `app.ts` performs it. */
export type LapAskAction = 'post' | 'name' | 'keep' | 'home' | 'none'

export const lapAskAction = (id: string | undefined): LapAskAction => {
  switch (id) {
    case LAP_ASK_ROW.post:
      return 'post'
    case LAP_ASK_ROW.name:
      return 'name'
    case LAP_ASK_ROW.keep:
      return 'keep'
    case LAP_ASK_ROW.home:
      return 'home'
    default:
      return 'none'
  }
}

/** The row a fresh plate is aimed at: home, so A after a run still goes there. */
export const lapAskOpeningRow = LAP_ASK_ROW.home

/**
 * DEV-629: the row a plate for THIS lap opens on. POST where the lap would
 * rank in the top {@link LAP_ASK_YES_RANK} (so A says yes), home otherwise
 * (DEV-406, unchanged for every other lap).
 */
export const lapAskOpeningRowFor = (f: LapAskFacts | null): string =>
  f !== null && lapAskDefaultsYes(f) ? LAP_ASK_ROW.post : lapAskOpeningRow

/**
 * The aimed row's index in `rows`, by id, so a row that comes or goes (ANOTHER
 * NAME, once posted) never moves the aim onto a neighbour: an aim whose row has
 * gone falls back to home.
 */
export const lapAskAimIndex = (rows: readonly PauseOption[], aimId: string): number => {
  const at = rows.findIndex((r) => r.id === aimId)
  if (at >= 0) return at
  return Math.max(
    0,
    rows.findIndex((r) => r.id === LAP_ASK_ROW.home),
  )
}

// ── Where it hangs ────────────────────────────────────────────────────────
//
// On the SHIP's group with the results panel, for the panel's reason (it banks
// with the cockpit), directly under the panel's bottom edge, at the panel's
// distance and scaled down from the pause plate's own metres: a plate of four
// rows at 0.86 m is 30 degrees tall, which under a panel already 18 degrees
// tall would run off the bottom of a flat frame. At 0.72 of its size and 0.95 m
// it is 19 degrees (four rows), each row about 3.6 degrees: inside the pause
// plate's comfort page (4.6 degrees a row) and above the 3 degrees the first
// pass of that page was rejected at.

/** Scale on the pause plate's own metres. */
export const LAP_ASK_SCALE = 0.72
/**
 * The same, on a touch screen (DEV-794, Matt 2026-10-07: "go with your recs",
 * QUESTIONS item 18). The menu hangs BESIDE the panel there, where the notes
 * were a squint at 915 x 412 (DEV-571's row, finding 7); one size up is about
 * a fifth, which still fits a 360 px tall landscape phone with room beside the
 * panel (`ghost-share.spec.ts` measures it). **A number to argue with.**
 */
export const LAP_ASK_SCALE_TOUCH = 0.86

/** The plate's scale: `beside` is the touch placement (`lapAskPlace`). */
export const lapAskScale = (beside: boolean): number =>
  beside ? LAP_ASK_SCALE_TOUCH : LAP_ASK_SCALE
/** Between the results panel's edge and the plate's, metres. */
export const LAP_ASK_GAP = 0.012

/**
 * Where the plate's origin goes, in the results panel's own group: UNDER the
 * panel, or BESIDE it (to its right, tops level) on a touch screen, where the
 * thumbs' chips (RACE THIS LAP, FLY AGAIN, CONTINUE) stand in a column across
 * the bottom middle of the glass and covered every row of a plate hung under
 * the panel (photographed, 915 x 412 landscape). A phone held sideways has
 * room either side of the panel; a headset and a desk screen look down.
 * `plate.top` is the pause plate's `TOP_LOCAL_Y`, `plate.width` its `WIDTH`,
 * both before the scale.
 */
export const lapAskPlace = (
  panel: {
    readonly y: number
    readonly z: number
    readonly width: number
    readonly height: number
  },
  plate: { readonly width: number; readonly top: number },
  beside: boolean,
): { readonly x: number; readonly y: number; readonly z: number } =>
  beside
    ? {
        x: panel.width / 2 + LAP_ASK_GAP + (plate.width * lapAskScale(true)) / 2,
        y: panel.y + panel.height / 2 - plate.top * lapAskScale(true),
        z: panel.z,
      }
    : {
        x: 0,
        y: panel.y - panel.height / 2 - LAP_ASK_GAP - plate.top * LAP_ASK_SCALE,
        z: panel.z,
      }
