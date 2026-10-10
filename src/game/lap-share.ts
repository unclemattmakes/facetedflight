// src/game/lap-share.ts: posting a lap to the leaderboard, from the results
// panel. DEV-373; asked as a question since DEV-571.
//
// PLAYER-GHOSTS §8 call 9: *"posting is an explicit Share action on the panel.
// Nothing leaves the browser unasked."* DEV-571 (Matt, 2026-10-02: *"always
// ask if they want to post to the leaderboard"*) made it a question on the
// panel's own menu (`game/lap-ask.ts`): the name it would post under is on the
// row beside it before anything is pressed, so one press of POST TO
// LEADERBOARD? is the yes, and nothing is ever posted without it.
//
//   idle     the question, with the name to post under (`handle`); the name
//            row's press gives another one (§8 call 4: a generated list)
//   posting  the press: the lap goes to `POST /api/laps`
//   posted   the short link, big enough to read in a headset
//   failed   why not, and the same press tries again
//
// And back again (DEV-374, §8 call 6: "deletable by their owner"), asked first
// because a delete is as final as a post:
//
//   confirm-delete  the next press once posted: "TAKE THIS LAP DOWN?", the link
//                   under it; any other row (or a new run) keeps it
//   deleting        the press after: `DELETE /api/laps?id=`, the owner key in
//                   a header (`net/lap-client.ts`'s `deleteLap`)
//   deleted         the link no longer works; the row is done
//   delete-failed   why not, and the same press tries again
//
// ── Which laps may be posted ─────────────────────────────────────────────
//
// A lap THIS run finished (`LapRun.last`), that:
//
//   · crossed the finish (a run the clock ended keeps no lap at all);
//   · is not tainted: D30's `runTainted` (DEV-371): the autopilot at any
//     tick, a URL switch off the presentation allowlist, a preset flipped
//     mid-lap. A tainted lap is raced here and NEVER posted, and the panel
//     says why it cannot be (`lap-ask.ts`'s `taintWords`);
//   · carries a leaderboard's rules (`lapRules`), not `LOCAL_LAP_RULES`: a
//     course the server keeps no leaderboard for would refuse it at `course`,
//     so the panel does not ask.
//
// A lap that missed rings IS offered: the server keeps it, raceable from its
// link and off the leaderboard (§8 call 3), and the panel says which.
//
// PURE: state in, state out; the panel's words for each state. `boot/app.ts`
// owns the presses and the network (`net/lap-client.ts`).

import { LOCAL_LAP_RULES } from './ghost-store'

export type SharePhase =
  | 'idle'
  | 'posting'
  | 'posted'
  | 'failed'
  // DEV-374: taking it back.
  | 'confirm-delete'
  | 'deleting'
  | 'deleted'
  | 'delete-failed'

export interface ShareState {
  readonly phase: SharePhase
  /** The name it posts under: shown from `idle`, posted under from `posting` on. */
  readonly handle: string | null
  /** `posted`: the lap's id, and its link as the panel prints it. */
  readonly id: string | null
  readonly link: string | null
  /** `posted`: on the leaderboard, and where. */
  readonly board: boolean
  readonly rank: number | null
  /** `failed`: why. `posted`: why it is not on the leaderboard, when it is not. */
  readonly reason: string | null
  /** `posted`, flat: the link is on the clipboard. */
  readonly copied: boolean
}

export const SHARE_IDLE: ShareState = {
  phase: 'idle',
  handle: null,
  id: null,
  link: null,
  board: false,
  rank: null,
  reason: null,
  copied: false,
}

/** The question, before any press: the name it would post under. */
export const shareAsking = (handle: string): ShareState => ({ ...SHARE_IDLE, handle })

/** The fields of a finished lap Share reads (`FlownLap`'s). */
export interface ShareableLap {
  readonly seconds: number | null
  readonly tainted: boolean
  readonly doc: { readonly rules: string }
}

/** Is this a lap on a course with a leaderboard? Whether or not it may be posted. */
export const boardedLap = (lap: ShareableLap | null): boolean =>
  lap !== null && lap.seconds !== null && lap.doc.rules !== LOCAL_LAP_RULES

/** May this lap be posted? See the header. */
export const shareable = (lap: ShareableLap | null): boolean =>
  boardedLap(lap) && lap !== null && !lap.tainted

/**
 * The press on POST TO LEADERBOARD? `offered` is `shareable(lap)` for the lap on
 * the panel. `post` is true exactly when this press should send the lap, and
 * `remove` (DEV-374) exactly when it should delete the posted one; never both.
 * A press with no name to post under does nothing.
 */
export const pressShare = (
  state: ShareState,
  offered: boolean,
): { readonly next: ShareState; readonly post: boolean; readonly remove?: boolean } => {
  if (!offered) return { next: state, post: false }
  switch (state.phase) {
    case 'idle':
    case 'failed':
      if (state.handle === null) return { next: state, post: false }
      return { next: { ...state, phase: 'posting', reason: null }, post: true }
    // DEV-374: once posted, the same row takes the lap back: asked first,
    // then sent, as a post is. A posted lap is never posted twice.
    case 'posted':
      return { next: { ...state, phase: 'confirm-delete' }, post: false }
    case 'confirm-delete':
    case 'delete-failed':
      return { next: { ...state, phase: 'deleting', reason: null }, post: false, remove: true }
    default:
      // A post or a delete in flight, or a lap already deleted: nothing.
      return { next: state, post: false }
  }
}

/**
 * The name row's press: another name, while the lap is not yet posted (or its
 * post failed). Null in any other phase, where the name is the one it went
 * under and the press does nothing.
 */
export const rerollShare = (
  state: ShareState,
  reroll: (current: string | null) => string,
): ShareState | null =>
  state.phase === 'idle' || state.phase === 'failed'
    ? { ...state, handle: reroll(state.handle) }
    : null

/** DEV-374: any press but the confirming one keeps a posted lap. Null when nothing was being asked. */
export const keepPosted = (state: ShareState): ShareState | null =>
  state.phase === 'confirm-delete' ? { ...state, phase: 'posted' } : null

/** The server took it. */
export const sharePosted = (
  state: ShareState,
  result: {
    readonly id: string
    readonly link: string
    readonly board: boolean
    readonly rank: number | null
    readonly boardReason: string | null
  },
): ShareState => ({
  ...state,
  phase: 'posted',
  id: result.id,
  link: result.link,
  board: result.board,
  rank: result.rank,
  reason: result.board ? null : result.boardReason,
})

/** It did not. */
export const shareFailed = (state: ShareState, reason: string): ShareState => ({
  ...state,
  phase: 'failed',
  reason,
})

/** DEV-374: the server deleted it. The link is dead; the id is kept, for the record. */
export const shareDeleted = (state: ShareState): ShareState => ({
  ...state,
  phase: 'deleted',
  reason: null,
  copied: false,
})

/** DEV-374: it did not: a wrong key and a missing lap alike (the server's 404). */
export const deleteFailed = (state: ShareState, reason: string): ShareState => ({
  ...state,
  phase: 'delete-failed',
  reason,
})

/** Which device the prompts are worded for. */
export type ShareRoute = 'flat' | 'xr'

/**
 * The share and race buttons, by route: a player COURSE's panel still uses
 * them (`course-share.ts`, DEV-467). A lap's panel did until DEV-571 moved its
 * questions onto a menu. Flat: the keyboard and a standard pad together. In a
 * headset: the two stick clicks (`input/xr.ts` says why those).
 */
export const SHARE_KEYS: Readonly<Record<ShareRoute, { share: string; race: string }>> = {
  flat: { share: 'SELECT or G', race: 'Y or R' },
  xr: { share: 'CLICK THE LEFT STICK', race: 'CLICK THE RIGHT STICK' },
}

/** A panel's three prompts and its block (`course-share.ts`'s shape). */
export interface SharePanel {
  readonly again: string
  readonly race: string
  readonly back: string
  readonly block: ShareBlock | null
}

/** What the results panel says in place of the race standings, or nothing. */
export interface ShareBlock {
  /** The small line above. */
  readonly heading: string
  /** The big one: a link, or why not. */
  readonly line: string
  /** `accent` a question, `ink` a link to read, `dim` a wait or a refusal. */
  readonly tone: 'accent' | 'ink' | 'dim'
  /** A small line under `line`: what the link does, or what a press will do. */
  readonly detail?: string
}

/**
 * DEV-571: what anyone who opens a lap's link is offered. WATCH needs Faceted
 * Flight TV (`gameplay.tv`, on every build since DEV-578): where the
 * build has none, the link races and nothing else, and the panel says only that.
 */
export const linkDetail = (watch: boolean): string =>
  watch
    ? 'ANYONE WITH THIS LINK CAN WATCH OR RACE THIS LAP'
    : 'ANYONE WITH THIS LINK CAN RACE THIS LAP'

/**
 * The panel's block for a state, or null where it shows the race standings: a
 * lap not posted, and not being posted, leaves the standings where they are,
 * because the question is on the menu under the panel (`lap-ask.ts`).
 */
export const shareBlock = (
  state: ShareState,
  offered: boolean,
  watch: boolean,
): ShareBlock | null => {
  if (!offered) return null
  const name = (state.handle ?? '').toUpperCase()
  switch (state.phase) {
    case 'idle':
      return null
    case 'posting':
      return { heading: `POSTING AS ${name}`, line: 'SENDING THE LAP', tone: 'dim' }
    case 'posted': {
      const where = state.board
        ? state.rank !== null
          ? ` · #${state.rank} ON THE LEADERBOARD`
          : ' · ON THE LEADERBOARD'
        : ' · NOT RANKED'
      return {
        heading: `POSTED AS ${name}${where}${state.copied ? ' · LINK COPIED' : ''}`,
        line: state.link ?? '',
        tone: 'ink',
        detail: linkDetail(watch),
      }
    }
    case 'failed':
      return { heading: 'NOT POSTED', line: state.reason ?? '', tone: 'dim' }
    // ── DEV-374: taking it back ──────────────────────────────────────────
    case 'confirm-delete':
      return {
        heading: 'TAKE THIS LAP DOWN?',
        line: state.link ?? '',
        tone: 'accent',
        detail: 'IT LEAVES THE LEADERBOARD AND THE LINK STOPS WORKING',
      }
    case 'deleting':
      return { heading: 'TAKING THE LAP DOWN', line: state.link ?? '', tone: 'dim' }
    case 'deleted':
      return { heading: 'TAKEN DOWN', line: 'THE LINK NO LONGER WORKS', tone: 'dim' }
    case 'delete-failed':
      return { heading: 'NOT TAKEN DOWN', line: state.reason ?? '', tone: 'dim' }
  }
}
