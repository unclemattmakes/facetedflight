// src/game/award-line.ts — what the HUD's event line may still say once the run
// is over. DEV-397.
//
// `docs/BUGS.md`, 2026-09-24: *"After the finish the row still says `BOOST
// READY` and `+4 AUTO`."* The `+4 AUTO` half is the badges' (`render/hud.ts`,
// `dashContent`). This is the other half.
//
// ── Why an award outlived its run ──────────────────────────────────────────
//
// Every award `boot/app.ts` raises carries `until`, in RUN seconds
// (`mission.elapsed + 1.6` for a gate, `+ 1.5` for the boost edge), and the
// panel shows it while `mission.elapsed < until`. **The run's clock stops at the
// finish**: `game/mission.ts`'s step returns before `state.elapsed += dt` once
// `state.finished`. So an award raised in the last second and a half of a run,
// or at any time after it, can never expire. And it outranks the medal
// (`state.award ?? (state.finished ? state.medal : '')`), so it did not just
// linger: it took the finish's one line for the rest of the visit. The boost
// tank keeps charging after the finish, so `BOOST READY` was the usual one.
//
// ── The rule ───────────────────────────────────────────────────────────────
//
// After the finish, the event line keeps what was live AT the finish for the
// rest of its dwell, timed on the frame clock (the run's clock is stopped), and
// nothing raised after the finish is shown: it is news about a run that is
// over. Then the line is the medal's, which is what 2016 put there.

/** An award on the event line: `until` is in run seconds, as `app.ts` raises it. */
export interface Award {
  readonly text: string
  readonly until: number
  readonly tone?: 'gain' | 'loss'
}

/** What the line held when the run finished, and when (frame clock, ms) it lets go. */
export interface FinishLatch {
  readonly award: Award | null
  readonly releaseAtMs: number
}

/**
 * The award the event line may carry this frame, and the latch to keep.
 *
 * While the run is live this changes nothing: the award's own `until` expires
 * it. The first frame that sees the run finished latches the award live then,
 * with its REMAINING dwell moved onto the frame clock; every frame after keeps
 * that same award (by identity, so a new one raised after the finish is not it)
 * until the frame clock passes, and returns null otherwise.
 */
export const settleAward = (
  award: Award | null,
  run: { readonly elapsed: number; readonly finished: boolean },
  latch: FinishLatch | null,
  nowMs: number,
): { readonly award: Award | null; readonly latch: FinishLatch | null } => {
  if (!run.finished) return { award, latch: null }
  const live = award !== null && run.elapsed < award.until ? award : null
  const held: FinishLatch = latch ?? {
    award: live,
    releaseAtMs: nowMs + (live ? (live.until - run.elapsed) * 1000 : 0),
  }
  const keep = held.award !== null && award === held.award && nowMs < held.releaseAtMs
  return { award: keep ? award : null, latch: held }
}
