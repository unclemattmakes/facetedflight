// src/game/ghost-pick.ts — the hangar's ghost line, on a course's card. DEV-373.
//
// PLAYER-GHOSTS §4.2, door 2: *"One cycling line on the level card: none ·
// your best · world #1 · the lap just above yours. Your best is local; the
// other two are one board fetch."* And §8 call 8: your own best is ON by
// default, and an online ghost is OPT-IN — so the line opens on `best`, and
// nothing is fetched until the press that moves it to `world`.
//
// One press (the race button, the one "race this lap" already uses) moves the
// AIMED course's line on, in the plan's order read round from the default:
//
//   best → world → above → none → best …
//
// The third door, a link (`?ghost=<id>`), lands outside the cycle as `link`,
// and the next press takes it back to `best`.
//
// PURE: which lap each pick names, and the words for it. The fetches and the
// per-course memory are `boot/app.ts`'s; the drawing is `render/hangar.ts`'s.

import type { BoardEntry } from '@/net/lap-client'

export type GhostPick = 'best' | 'world' | 'above' | 'none' | 'link'

/** The cycle, from the default. `link` is not in it: see the header. */
export const GHOST_PICKS: readonly GhostPick[] = ['best', 'world', 'above', 'none']

/** §8 call 8: your own best lap is on by default. */
export const DEFAULT_GHOST_PICK: GhostPick = 'best'

/**
 * The next pick. `boardable` is whether the lap server has a board for this
 * course at all (its `lapRules` are known, the results panel's own test).
 * Where it has none, the cycle is `best → none`: no pick names the board, so
 * nothing is ever fetched. DEV-488 follow-up: a player course's `pc_` id is a
 * hash of the course, and /privacy promises that nothing about a player
 * course leaves the device.
 */
export const nextGhostPick = (pick: GhostPick, boardable = true): GhostPick => {
  const cycle = boardable ? GHOST_PICKS : GHOST_PICKS.filter((p) => !pickNeedsBoard(p))
  const i = cycle.indexOf(pick)
  return i < 0 ? DEFAULT_GHOST_PICK : (cycle[(i + 1) % cycle.length] as GhostPick)
}

/** Does this pick need the board? */
export const pickNeedsBoard = (pick: GhostPick): boolean => pick === 'world' || pick === 'above'

/**
 * "The lap just above yours": the SLOWEST board lap that is still faster than
 * `mine`, which is the next one to beat. Null with no time of yours, and when
 * nothing on the board is faster (you are first, or level with it).
 */
export const lapAbove = (
  entries: readonly BoardEntry[],
  mine: number | null,
): BoardEntry | null => {
  if (mine === null) return null
  let best: BoardEntry | null = null
  for (const e of entries) {
    if (e.seconds < mine && (best === null || e.seconds > best.seconds)) best = e
  }
  return best
}

/** A board as the card knows it. */
export type BoardView =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly entries: readonly BoardEntry[] }
  | { readonly status: 'failed'; readonly reason: string }

/** The board lap a pick names, or null (none, loading, or nothing there). */
export const pickEntry = (
  pick: GhostPick,
  board: BoardView | null,
  mine: number | null,
): BoardEntry | null => {
  if (board?.status !== 'ready') return null
  if (pick === 'world') return board.entries[0] ?? null
  if (pick === 'above') return lapAbove(board.entries, mine)
  return null
}

/**
 * DEV-650: the lap a REPEAT attempt races, when the player has not chosen.
 *
 * After a clean lap, the next one up the board is the point of trying again, so
 * "fly again" defaults to racing it (the consultant's design item 1; Matt, "go
 * with your recs"). Only where the player has not chosen a ghost for this card
 * (`chosen` false: no press on the card's race button has set a pick), and only
 * with a lap faster than the one just flown. Null leaves the default (your best).
 */
export const retryGhost = (
  chosen: boolean,
  entries: readonly BoardEntry[],
  mine: number | null,
): BoardEntry | null => (chosen ? null : lapAbove(entries, mine))

const secs = (s: number): string => `${s.toFixed(1)}s`

/**
 * The line, as the card paints it (upper case; the caller adds the button).
 * `mine` is your kept lap's seconds on this course, preset and aircraft, or
 * null; `link` is the shared lap a `?ghost=` link chose, for `link`.
 */
export const ghostLine = (
  pick: GhostPick,
  facts: {
    readonly mine: number | null
    readonly board: BoardView | null
    readonly link?: { readonly handle: string; readonly seconds: number } | null
  },
): string => {
  const { mine, board } = facts
  // DEV-571: in a stranger's words, and in the results panel's (SAVE AS YOUR
  // GHOST?, POST TO LEADERBOARD?). `GHOST YOUR BEST` named a lap the player had
  // never been told was kept, and `WORLD #1` / `ABOVE YOURS` a board the game
  // calls the leaderboard everywhere else.
  switch (pick) {
    case 'none':
      return 'GHOST: OFF'
    case 'best':
      return mine === null ? 'GHOST: NONE SAVED YET' : `GHOST: YOUR SAVED LAP ${secs(mine)}`
    case 'link':
      return facts.link
        ? `GHOST: ${facts.link.handle.toUpperCase()} ${secs(facts.link.seconds)}`
        : 'GHOST: THE LINKED LAP'
    case 'world':
    case 'above': {
      const label = pick === 'world' ? 'LEADERBOARD #1' : 'NEXT ONE UP'
      if (pick === 'above' && mine === null) return `GHOST: ${label} · SAVE A LAP FIRST`
      if (!board || board.status === 'loading') return `GHOST: ${label} · LOADING`
      if (board.status === 'failed') return `GHOST: ${label} · OFFLINE`
      const entry = pickEntry(pick, board, mine)
      if (!entry) {
        return pick === 'world' ? `GHOST: ${label} · NO LAPS YET` : `GHOST: ${label} · NONE FASTER`
      }
      return `GHOST: #${entry.rank} ${entry.handle.toUpperCase()} ${secs(entry.seconds)}`
    }
  }
}
