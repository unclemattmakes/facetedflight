// src/game/results-board.ts — the course's board, on the results panel. DEV-431.
//
// Matt, 2026-09-26: *"i don't see leaderboards in the game at all - in the
// past, they were shown at the mission results screen."* The lap server has
// kept boards since DEV-372, and the only thing in the game that read one was
// the hangar's ghost line (`game/ghost-pick.ts`: world #1 and the lap above
// yours, one line, fetched on a press). Nothing ever DREW a board.
//
// ── What 2016 showed ──────────────────────────────────────────────────────
//
// `missionResults.unity` is the level-select room with one holotable whose
// canvas (`ui_canvas/ui_results`) carries two panels side by side: `results`
// ("Your Score": challenge score, time bonus, total) and `leaderboard`
// ("LEADERBOARD", then `text_leaderboardInfo`, with the filter buttons Top 5 /
// Friends / Global under it). `CheckSDK` switches on `Leaderboards/steamVR` on
// the Steam build, and `Leaderboard_Steam.cs` fills the text:
//
//   - `DownloadLeaderboardEntries(Global, -2, 5)` (line 219): the top five;
//   - one line per entry, `"{rank}.  {score}  {name}"` (line 322);
//   - the player's own line wrapped in `<Color=orange>` (line 318), matched on
//     the Steam persona NAME (`entryName == steamName`);
//   - and `RefreshUI()` sets the text to `""` before each download, so while it
//     loads, offline, or on an empty board, 2016 drew a blank panel.
//
// ── What this draws ───────────────────────────────────────────────────────
//
// The same list: the top `RESULTS_BOARD_TOP` of the course's board, one line
// each, `rank.  time  HANDLE`, and the player's own line in the accent colour
// (2016's orange). Where 2016 ranked by score, the port's board ranks by the
// server's rescored TIME (PLAYER-GHOSTS §8 call 3, which orders them exactly as
// 2016's formula does while its time bonus is positive), so the line shows the
// time. And where 2016 drew a blank, this says what is happening: loading, the
// board is unreachable, or it has no laps yet (Matt, through the brief: never
// a blank).
//
// "The player's own line" is decided ON THE DEVICE, from what the device
// already knows, and nothing about the player is sent to ask:
//
//   - a lap id this page posted (Share's answer, `share.id`) is exactly yours;
//   - and a line under the handle this device last shared under
//     (`game/lap-identity.ts`'s `readHandle`) is yours by 2016's own rule, a
//     NAME match. The board keeps one place per device (`net/lap-server.ts`),
//     so a handle match is another device only when two chose the same
//     generated name, and the line is marked in colour, never renamed.
//
// When your line is below the top five it is drawn after them, as a sixth,
// marked as a gap. And a lap on the panel that COULD go on this board — clean,
// every ring, not yet shared — is placed against it, so the panel can say
// where it would stand. Posting stays an explicit Share (§8 call 9): this only
// reads a public list and counts.
//
// PURE: facts in, words out. The fetch is `boot/app.ts`'s, over
// `net/lap-client.ts`'s `fetchBoard`; the drawing is `render/results.ts`'s.

import { lapAbove } from '@/game/ghost-pick'
import type { BoardEntry } from '@/net/lap-client'
import { LAP_BOARD_SIZE } from '@/net/lap-policy'
import type { BoardPlateRow, BoardPlateSay, BoardPlateView } from '@/render/results'

/**
 * Lines of the board drawn: 2016's Top 5 (`Leaderboard_Steam.cs:219`, Global
 * ranks -2..5, which Steam clamps to the first five). Your own line, when it
 * is below them, is drawn as one more.
 */
export const RESULTS_BOARD_TOP = 5

/** The board as the panel knows it. */
export type ResultsBoardFetch =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly entries: readonly BoardEntry[] }
  | {
      readonly status: 'failed'
      /** No response at all (`LapNetFailure.status` 0): the network, not the server. */
      readonly offline: boolean
      readonly reason: string
    }

/** Everything the board's words are made from. */
export interface ResultsBoardFacts {
  readonly fetch: ResultsBoardFetch
  /**
   * A refetch is in flight (after a Share or a delete): the entries are the
   * last good ones, and the panel says it is updating rather than go blank.
   */
  readonly refreshing: boolean
  /** The edition's title, as the game names it: `Anniversary`, `Classic`. */
  readonly edition: string
  /**
   * The aircraft variant's name where the edition flies more than one — a board
   * per variant (DEV-380) — or null, and then it is not printed.
   */
  readonly variant: string | null
  /** Lap ids this page posted and has not taken back. */
  readonly posted: ReadonlySet<string>
  /** The handle this device last shared under, or null. */
  readonly handle: string | null
  /**
   * The lap on the panel, in seconds, when it could go on THIS board and has
   * not been shared: clean (Share offers it), every ring taken. Null otherwise.
   */
  readonly eligible: number | null
}

/** `54.21s`: a board's times are a tick apart (12.2 ms), so one decimal would tie two ranks. */
export const boardTime = (seconds: number): string => `${seconds.toFixed(2)}s`

/** Is this line the player's? See the header: an id this page posted, or the device's handle. */
export const isMine = (
  entry: BoardEntry,
  facts: Pick<ResultsBoardFacts, 'posted' | 'handle'>,
): boolean => facts.posted.has(entry.id) || (facts.handle !== null && entry.handle === facts.handle)

/**
 * Where a lap of `seconds` would stand if it were posted now, or null.
 *
 * The server orders a board by seconds, then by when each lap arrived, so a
 * new lap goes BELOW any it ties: one more than every line at or under its
 * time. The player's own lines are left out, because the board keeps one place
 * per device and a better lap replaces the old one. Null when one of the
 * player's lines is already as fast (the new lap would not board; the line
 * that stands is the answer).
 */
export const wouldPlace = (
  entries: readonly BoardEntry[],
  seconds: number,
  facts: Pick<ResultsBoardFacts, 'posted' | 'handle'>,
): number | null => {
  let ahead = 0
  for (const e of entries) {
    if (isMine(e, facts)) {
      if (e.seconds <= seconds) return null
      continue
    }
    if (e.seconds <= seconds) ahead += 1
  }
  return ahead + 1
}

const row = (entry: BoardEntry, mine: boolean, gap: boolean): BoardPlateRow => ({
  rank: entry.rank,
  gap,
  time: boardTime(entry.seconds),
  name: entry.handle.toUpperCase(),
  mine,
})

/** The lines to draw: the top five, and your own line after them when it is lower. */
export const boardRows = (
  entries: readonly BoardEntry[],
  facts: Pick<ResultsBoardFacts, 'posted' | 'handle'>,
): BoardPlateRow[] => {
  const top = entries.slice(0, RESULTS_BOARD_TOP)
  const rows = top.map((e) => row(e, isMine(e, facts), false))
  if (!rows.some((r) => r.mine)) {
    // Entries arrive rank-ordered (`fetchBoard` sorts them), so the first of
    // yours below the top is your best.
    const yours = entries.slice(RESULTS_BOARD_TOP).find((e) => isMine(e, facts))
    if (yours) rows.push(row(yours, true, yours.rank !== RESULTS_BOARD_TOP + 1))
  }
  return rows
}

/** What the plate says beside its lines, or in their place when there are none. */
const say = (
  caption: string,
  line: string,
  detail: string,
  tone: BoardPlateSay['tone'],
): BoardPlateSay => ({ caption, line, detail, tone })

/**
 * The plate, for these facts. Never blank: either there are lines, or `say`
 * has a line that says why not (`results-board.test.ts` sweeps every state).
 */
export const resultsBoardView = (facts: ResultsBoardFacts): BoardPlateView => {
  const heading = 'LEADERBOARD'
  const sub = [facts.edition, facts.variant]
    .filter((s): s is string => s !== null && s.length > 0)
    .map((s) => s.toUpperCase())
    .join(' · ')
  const { fetch } = facts
  // DEV-571: the plate's own word, LEADERBOARD, everywhere it said BOARD, and
  // POST (the results panel's question) where it said SHARE.
  if (fetch.status === 'loading') {
    return { heading, sub, rows: [], say: say('', 'LOADING THE LEADERBOARD', '', 'dim') }
  }
  if (fetch.status === 'failed') {
    return {
      heading,
      sub,
      rows: [],
      say: fetch.offline
        ? say('', 'OFFLINE', 'THE LEADERBOARD COULD NOT BE REACHED', 'dim')
        : say('', 'LEADERBOARD UNAVAILABLE', fetch.reason.toUpperCase(), 'dim'),
    }
  }
  const { entries } = fetch
  if (entries.length === 0) {
    return {
      heading,
      sub,
      rows: [],
      say: facts.refreshing
        ? say('', 'UPDATING THE LEADERBOARD', '', 'dim')
        : say(
            '',
            'NO LAPS POSTED YET',
            facts.eligible !== null
              ? 'POST THIS LAP TO BE THE FIRST'
              : 'TAKE EVERY RING, THEN POST, TO BE THE FIRST',
            facts.eligible !== null ? 'accent' : 'dim',
          ),
    }
  }
  const rows = boardRows(entries, facts)
  if (facts.refreshing) {
    return { heading, sub, rows, say: say('UPDATING THE LEADERBOARD', '', '', 'dim') }
  }
  const place = facts.eligible === null ? null : wouldPlace(entries, facts.eligible, facts)
  if (place !== null) {
    return {
      heading,
      sub,
      rows,
      say:
        place > LAP_BOARD_SIZE
          ? say('THIS LAP WOULD BE', 'NOT RANKED', `ONLY THE TOP ${LAP_BOARD_SIZE} ARE`, 'dim')
          : say('THIS LAP WOULD BE', `#${place}`, 'IF YOU POST IT', 'accent'),
    }
  }
  const best = entries.find((e) => isMine(e, facts))
  return {
    heading,
    sub,
    rows,
    say: best ? say('YOUR PLACE', `#${best.rank}`, boardTime(best.seconds), 'accent') : null,
  }
}

// ── DEV-650: the next lap to beat ─────────────────────────────────────────
//
// The consultant (2026-10-05, design item 1): *"Default to 'the lap just above
// yours' on a repeat attempt, and say so on the results: 'Next: beat <handle>,
// 2.1 s faster.' That one line is most of what a retention loop is."*
//
// The lap just above yours is `game/ghost-pick.ts`'s `lapAbove`: the SLOWEST
// board lap still faster than yours. "Yours" is the faster of the lap on the
// panel (when it could go on this board and has not been sent) and your own
// lines on the board, so a run slower than your own posted lap is still told
// about the rival above your best and not about yourself. Another player's lap
// only: your own line is never "next to beat".

/** The lap to beat next, and by how much. */
export interface NextBeat {
  readonly entry: BoardEntry
  /** Your lap, seconds. */
  readonly mine: number
  /** How much faster the entry is than `mine`, seconds: always above zero. */
  readonly gap: number
}

export const nextBeat = (
  entries: readonly BoardEntry[],
  facts: Pick<ResultsBoardFacts, 'posted' | 'handle' | 'eligible'>,
): NextBeat | null => {
  let mine = facts.eligible
  for (const e of entries) {
    if (isMine(e, facts) && (mine === null || e.seconds < mine)) mine = e.seconds
  }
  if (mine === null) return null
  const entry = lapAbove(
    entries.filter((e) => !isMine(e, facts)),
    mine,
  )
  return entry ? { entry, mine, gap: mine - entry.seconds } : null
}

/**
 * `NEXT: BEAT STAN, 2.1s FASTER`. A gap under half a tenth reads in hundredths:
 * `0.0s faster` would be a rival you have already matched.
 */
export const nextBeatLine = (beat: NextBeat): string =>
  `NEXT: BEAT ${beat.entry.handle.toUpperCase()}, ${
    beat.gap < 0.05 ? beat.gap.toFixed(2) : beat.gap.toFixed(1)
  }s FASTER`
