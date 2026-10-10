// src/boot/snap.ts — `?snap=<seconds>`: stop the sim on a chosen tick so the
// same frame can be photographed twice.
//
// ANNIVERSARY.md §4.3: *"The autopilot is deterministic, so a `?snap=<tick>`
// that freezes the sim at a tick (a screenshot tool like `?view=cam`, not a
// different game) would give the Anniversary work its first honest before/after
// frames. Every visual proposal above wants it."* And §7's first bullet makes
// same-tick A/B the measurement for every visual item in the document.
//
// ── It is the PAUSE, with a different trigger ────────────────────────────
//
// The one rule this had to obey is CLAUDE.md's: *"NEVER make the test harness
// take a different code path to get green."* A freeze implemented by reaching
// into the sim — skipping `stepFixed`, zeroing a velocity, holding a body — would
// be a build nobody plays, and every A/B frame taken with it would be evidence
// about that build instead of about the game.
//
// So there is no new mechanism. `app.ts` already freezes the sim for the pause
// menu by handing `stepFixed` ZERO WALL TIME — *"Paused freezes the SIM, not the
// frame: zero wall time in, so nothing accumulates and no tick runs"* — and this
// is the same argument reaching the same call from a different condition.
// Physics, the race clock, the AI racers and the scoring stop together because
// they all live under that one call, exactly as they do when a player pauses.
//
// What it deliberately does NOT do is show the pause plate. A snap is a
// photograph, not a pause: the flag is its own, so `flight.pause.setVisible`
// still keys off `paused` alone and the menu never appears. The vignette is
// released the way the pause releases it, for the reason the pause releases it —
// there is no angular rate to respond to when nothing is turning.
//
// ── What is frozen, and what is not ──────────────────────────────────────
//
// Frozen: everything under `stepFixed`. The ship, the racers, the ghosts, the
// mission clock, the score.
//
// NOT frozen: anything driven from the RENDER clock, because those run on wall
// time by design and nothing in `src/sim` can see them — the ocean's wave phase
// (`setWaveTime(time / 1000)`), the gate particles, the holotable's jets, the
// orb bob. Two loads reach the same sim tick at different wall times, so those
// differ between an A and a B frame. For the comparisons this exists for — fog,
// tone mapping, haze, near-field air, speed lines, cockpit art — the subject is
// identical and the sea is a few centimetres out. If a pair ever needs the water
// held too, the change is to hold `time` at the snap and pass zero for the
// render delta as well; it is deliberately not done here, because it would put a
// second clock under a dozen systems for a case that has not come up.

import { FIXED_DT } from '@/sim/constants'

/**
 * Parse `?snap=`. Seconds of MISSION time — `mission.elapsed`, the sim's own
 * clock, which starts when the launch elevator lets go and stops when the run
 * does.
 *
 * `null` for absent, for a value that is not a finite number, and for a negative
 * one. An unparseable switch is ignored rather than fatal, the way `?edition=`
 * is: a typo in a URL should not be a black page.
 *
 * `?snap=0` is legal and means the first tick.
 */
export const parseSnap = (raw: string | null): number | null => {
  if (raw === null || raw.trim() === '') return null
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0) {
    console.warn(`?snap=${raw} is not a number of seconds; ignored`)
    return null
  }
  return seconds
}

/**
 * Has the mission clock reached the snap?
 *
 * `>=`, not `==`: the sim advances in fixed 0.0121999998 s steps (D4), so it
 * lands SOMEWHERE at or past the mark and never exactly on the number. That is
 * the whole precision the tool has, and it is the same for both halves of an
 * A/B pair because both are driven by the same fixed step — which is what makes
 * the two frames comparable at all.
 *
 * **The window is TWO steps, not one, and this comment used to say one.** The
 * caller checks this once per FRAME, after `stepFixed` has run every step the
 * frame's budget allowed (`boot/app.ts`), and `stepFixed` carries an
 * accumulator across frames — so a frame can cross the mark and take one more
 * step before anybody asks. The landing is `[snapAt, snapAt + 2·dt)`. Reading
 * the old one-step claim is what let a census baseline be recorded on the
 * second of those two ticks, keyed to a frame duration; see `snapFloorTick`.
 *
 * `null` means no snap was asked for, and never freezes.
 */
export const shouldFreeze = (elapsed: number, snapAt: number | null): boolean =>
  snapAt !== null && elapsed >= snapAt

/**
 * The fixed-step index of the FIRST step at or past `snapAt` — the landing
 * every build reaches, whatever its frame rate. DEV-160 H2.
 *
 * `shouldFreeze` above lands in `[snapAt, snapAt + 2·dt)`, which is two
 * adjacent tick indices. Only the lower one is guaranteed: `elapsed >= snapAt`
 * always holds, and the smallest index satisfying it is `ceil(snapAt / dt)`.
 * The upper one needs the previous frame to have left enough in `stepFixed`'s
 * accumulator to fit an extra step — a fact about frame DURATION and nothing
 * about the scene.
 *
 * So anything that stores a snapped tick must store THIS one. A baseline keyed
 * to the upper value is reproducible only while frames stay slow, and stops
 * being reachable on the first build that gets faster — which is what happened
 * to `rookie_01_hoverJet/anniversary@20` at 1641 when DEV-184 and DEV-192
 * landed: five loads read 1640 on five different boot ticks, and the spec
 * SKIPPED rather than failed, so it read as a pass.
 *
 * Guarded in `tests/unit/census-baseline-tick.test.ts` over the tracked file,
 * so the class is closed in `pnpm check` rather than in a spec CI never runs.
 */
export const snapFloorTick = (snapAt: number, dt: number = FIXED_DT): number =>
  Math.ceil(snapAt / dt)
