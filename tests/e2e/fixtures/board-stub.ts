/**
 * tests/e2e/fixtures/board-stub.ts — a board, as `GET /api/board/…` answers.
 *
 * DEV-431's spec serves the lap server from `page.route` (the pattern
 * `ghost-share.spec.ts` set: the game's code path is the one it runs against
 * the real server; only the server is a fixture). A fixture answer that drifts
 * from the real one tests a game talking to a server that does not exist, so
 * this builder is not trusted on its word: `tests/unit/results-board.test.ts`
 * seeds the same laps into the REAL Function (`functions/api/board/…`, over
 * `node:sqlite` with the migration applied) and holds the two answers to the
 * same fields and types.
 *
 * Plain TypeScript: no Playwright import, so the unit suite can load it.
 */
import { FIXED_DT } from '@/sim/constants'

/** One lap on a stub board, fastest first. */
export interface StubBoardLap {
  readonly id: string
  readonly handle: string
  readonly seconds: number
}

/** Which board. */
export interface StubBoardKey {
  readonly mission: string
  readonly mode: string
  readonly edition: string
  readonly variant: string
}

/** When every stub lap was posted (ms): the real answer carries one per entry. */
export const STUB_CREATED_AT = Date.UTC(2026, 8, 25)

/** The body of a 200 from `getBoard` (`src/net/lap-server.ts`), for these laps in this order. */
export const boardAnswer = (
  key: StubBoardKey,
  rules: string,
  laps: readonly StubBoardLap[],
  ringsTotal: number,
) => ({
  mission: key.mission,
  mode: key.mode,
  edition: key.edition,
  variant: key.variant,
  rules,
  entries: laps.map((lap, i) => ({
    rank: i + 1,
    id: lap.id,
    handle: lap.handle,
    seconds: lap.seconds,
    ticks: Math.round(lap.seconds / FIXED_DT),
    rings: ringsTotal,
    score2016: 0,
    createdAt: STUB_CREATED_AT,
  })),
})
