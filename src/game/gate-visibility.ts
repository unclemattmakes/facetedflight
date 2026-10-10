// src/game/gate-visibility.ts — a passed gate goes away. When, and how fast.
//
// ── What 2016 did (DEV-122) ──────────────────────────────────────────────
//
// `TriggerCheckpoint.OnTriggerEnter` on tag "Player", with `checkpointArt` set
// and `triggerOnce` true, starts `Deactivate()`: `WaitForSeconds(2f)`, then
// `checkpointArt.SetActive(false)`, then `Destroy(transform.parent)`.
// `checkpointArt` is the `offset` node — the rolled pivot BOTH the frame and the
// stud cage hang under — so two seconds after you fly through a gate the whole
// thing vanishes in one frame. Every one of the 172 live triggers across the
// seven shipped scenes resolves those two fields the same way after the scene's
// own overrides, so this is shipped behaviour in every mission, not a prefab
// default (hard rule 2, traced to the last step).
//
// Two things the code is equally clear about, and both are kept:
//
//  · **Only the PLAYER's pass hides a gate.** The `"npc"` branch plays the burst
//    and touches nothing else. A racer flying the course ahead of you does not
//    take your gates away — which is also the only sane reading of a race.
//  · **Any order.** `triggerOnce` gates hide whichever one you passed, in
//    whatever order you passed them. There is no "next gate" concept in the
//    prefab; the course is a bag of triggers.
//
// The port had never done this. Every gate stayed up for the whole run, and
// Matt's note — *"gates should disappear after you fly through them"* — is a
// fidelity report, not a feature request.
//
// ── What this module is ──────────────────────────────────────────────────
//
// The MAPPING from "gate i was passed at sim time t" to "how big gate i is at
// sim time now", as a scale factor about the gate's own centre. Pure, so the
// event -> visibility rule can be tested without a renderer; `game/rings.ts`
// rewrites two instance matrices from the number this returns.
//
// Sim seconds, not wall clock: the run's own clock is what 2016's coroutine
// counted, it pauses with the run, and it is what every other run event here
// is stamped in (`mission.elapsed`).
//
// ── Classic and Anniversary ───────────────────────────────────────────────
//
// Classic is 2016: hold for the sheet's `passedHideDelay` (2 s), then a POP.
// The Anniversary preset (`gates.passedFade`) replaces the pop with a short
// shrink — 0.3 s — so the gate you just threaded folds away behind you rather
// than blinking out (ART_DIRECTION pillar 1: a silhouette that changes over a
// few frames is read; one that changes over one frame is a glitch). Both are
// the same rule with different numbers, which is why the fade spec is resolved
// HERE from the preset and the sheet rather than in the renderer.
//
// ── WHEN the clock starts, and what that cost (DEV-195) ──────────────────
//
// Matt, from the headset: *"rings should become invisible after the player has
// exited them. they currently start to shrink as the player is going through
// them."*
//
// The preset's own note said the opposite in prose — *"the gate you just
// threaded is already behind you, so the shrink is seen in the mirror of the
// mind rather than the eye"* — and the wrong belief inside it is about WHERE a
// pass is stamped. It is not stamped as you leave the gate. `sim/course.ts`
// fires on the OUT-to-IN edge of the gate's TRIGGER SPHERE (DEV-149), which is
// **22.619 m** on every shipped HoverJet ring and very nearly concentric with
// the gate (2.4 m from the frame's origin). So the pass is recorded roughly a
// sphere-radius BEFORE the gate's own plane, and a shrink anchored on it runs
// out the same distance PAST it — i.e. entirely inside the crossing.
//
// How far before, measured rather than assumed: over 129 autopilot crossings
// the ship is a median of **21.5 m past the plane** when it reaches the far
// edge of the sphere (p95 24.1 m), so the near edge is the same distance short
// of it. And the consequence, measured directly over those same crossings: as
// the ship reaches the gate's own plane the gate has already shrunk to a median
// of **0.675**, and to **0.390** at the 5th percentile. A third to two thirds
// of the gate is gone while you are still flying through the hole. That is the
// report, exactly.
//
// (The gate is bigger than the sphere, not smaller: its frame spans 48.5 x
// 70.5 m at the shipped ring scale of 2 — `gate-bullseye.test.ts` measures it
// off the mesh. The "24 x 35 m hole" in older comments here is the prefab at
// scale 1 and no shipped ring is at scale 1.)
//
// ── Why this is an EXIT and not a bigger `delaySeconds` ──────────────────
//
// Because the time inside a gate is not a constant and is not close to one. It
// is chord over speed, and the speed varies by a factor of ten:
//
//   the two 2016 ghost recordings (real human runs, the sample from OUTSIDE
//   the port): 39 crossings, 0.098 s to 0.634 s — a 6.5x spread;
//   the autopilot over six courses: 129 crossings, 0.098 s to 1.074 s — 11x.
//
// A single delay sized to clear the slowest crossing leaves the fastest gate
// standing half a second — a hundred metres — after it should be gone, and one
// sized for the fastest still shrinks in your face on a slow gate. There is no
// number that is right for both, so the answer is not a number.
//
// It is also not new geometry. `sim/course.ts` already tracks the trigger's
// other edge in `CourseState.inside[]` — DEV-149 built it so a ring the ship is
// PLACED inside cannot pay — and a gate whose `inside` has gone false is a gate
// the ship has flown out of. `game/rings.ts` stamps `exit()` from that array
// rather than measuring a second distance of its own, because two copies of a
// containment test that must agree is how the ghosts flew backwards.
//
// ── The backstop ─────────────────────────────────────────────────────────
//
// A gate that should be gone and is not is a visible bug, so the exit cannot be
// the ONLY thing that starts the clock. `stepMission` early-returns once the
// run is `finished`, and a crash or a swap can leave `inside[]` frozen true, so
// a gate entered and never left is reachable. {@link EXIT_BACKSTOP_SECONDS} caps
// the wait — and it is 2016's own `passedHideDelay`, not a number anybody
// picked, so the worst case this rule can produce is exactly Classic's timing.

import type { EditionPassedFade } from '@/content/edition-schema'
import { PROPS } from '@/generated/constants.generated'

/**
 * The longest a gate may wait for an exit that is not coming. SIM seconds.
 *
 * 2016's own hold (`TriggerCheckpoint.Deactivate()`'s `WaitForSeconds(2f)`),
 * by key — so the degenerate case of `waitForExit` is the shipped 2016
 * behaviour rather than a new one, and there is no second number to argue with.
 *
 * It is comfortably longer than any crossing anyone has flown: the slowest of
 * 168 measured crossings (129 autopilot, 39 ghost) was 1.074 s, and 2 s inside
 * a 45 m chord is 22.6 m/s, which is below the slowest gate entry ever recorded
 * on this course (31.2 m/s).
 */
export const EXIT_BACKSTOP_SECONDS = PROPS.checkpointRing.passedHideDelay

export interface PassedFadeSpec {
  /** Seconds after the ANCHOR before anything changes. */
  readonly delaySeconds: number
  /** Seconds the shrink takes once it starts. 0 is a pop. */
  readonly seconds: number
  /**
   * Anchor the clock on the moment the ship LEFT the gate's trigger sphere
   * rather than the moment it entered. DEV-195.
   *
   * False is 2016's anchor and Classic's: `TriggerCheckpoint` starts its
   * coroutine in `OnTriggerEnter` and counts from there, so Classic must leave
   * this off to stay bit-for-bit.
   *
   * True waits for the exit, capped at {@link EXIT_BACKSTOP_SECONDS}. It needs
   * somebody to report the exit — `GateVisibility.exit()` — and a gate whose
   * exit never arrives falls back to the cap, never to "never".
   */
  readonly waitForExit: boolean
}

/**
 * 2016's own timing: hold `passedHideDelay` seconds, then vanish in one frame.
 *
 * `seconds: 0` is a POP by construction — `passedGateScale` returns 0 for any
 * non-negative time once the delay has elapsed — so Classic never draws a
 * frame of a gate mid-shrink.
 */
export const CLASSIC_PASSED_FADE: PassedFadeSpec = {
  delaySeconds: PROPS.checkpointRing.passedHideDelay,
  seconds: 0,
  // 2016 counts from `OnTriggerEnter`. Anything else here is not 2016.
  waitForExit: false,
}

/**
 * The spec the renderer runs: the preset's when its flag is on, 2016's when off.
 *
 * Read on every call rather than cached, because the edition can flip mid-run
 * and a gate passed under one preset should finish its fade under the other.
 */
export const passedFadeSpec = (fade: EditionPassedFade): PassedFadeSpec =>
  fade.enabled
    ? {
        delaySeconds: fade.delaySeconds,
        seconds: fade.seconds,
        waitForExit: fade.waitForExit,
      }
    : CLASSIC_PASSED_FADE

/**
 * Scale of a gate whose clock started `sinceAnchor` seconds ago, 1 (untouched)
 * down to 0 (gone).
 *
 * The anchor is the pass under 2016's rule and the EXIT under `waitForExit`
 * (DEV-195); this function does not know which, and does not need to — it is
 * the SHAPE of the fade, and {@link fadeAnchor} is what decides when it starts.
 *
 * Negative `sinceAnchor` — an anchor in the future, which is what a gate still
 * waiting for its exit has, or the caller's clock having been reset under it —
 * reads as "not yet", which is the safe side: a gate that should be gone and is
 * not is a visible bug, a gate that should be up and is not is a course you
 * cannot fly.
 */
export const passedGateScale = (sinceAnchor: number, spec: PassedFadeSpec): number => {
  if (!(sinceAnchor >= 0)) return 1
  const t = sinceAnchor - spec.delaySeconds
  if (t < 0) return 1
  if (!(spec.seconds > 0) || t >= spec.seconds) return 0
  return 1 - t / spec.seconds
}

/**
 * The sim time gate `i`'s fade starts counting from, given when it was passed
 * and when (if ever) the ship left it. NaN for a gate never passed.
 *
 * Under 2016's rule that is the pass, full stop. Under `waitForExit` it is the
 * EARLIER of the exit and `passedAt + EXIT_BACKSTOP_SECONDS` — the earlier, so
 * that a gate already fading on the backstop is not shunted forward again by a
 * late exit. `min` over a monotone pair keeps the fade monotone, which is what
 * stops a gate growing back.
 *
 * Exported because it is the whole of DEV-195's arithmetic and is worth
 * asserting on directly rather than through a scale.
 */
export const fadeAnchor = (passedAt: number, exitedAt: number, spec: PassedFadeSpec): number => {
  if (Number.isNaN(passedAt)) return Number.NaN
  if (!spec.waitForExit) return passedAt
  const cap = passedAt + EXIT_BACKSTOP_SECONDS
  return Number.isNaN(exitedAt) ? cap : Math.min(exitedAt, cap)
}

export interface GateVisibility {
  readonly count: number
  /** The sim time gate `i` was passed, or NaN. */
  passedAt(i: number): number
  /** The sim time the ship left gate `i`'s trigger sphere, or NaN. DEV-195. */
  exitedAt(i: number): number
  /**
   * Record the PLAYER's pass of gate `i` at sim time `at`. Idempotent: a
   * second pass of a gate that already has a time keeps the first, because the
   * course is `triggerOnce` and the renderer must not restart a fade.
   */
  pass(i: number, at: number): void
  /**
   * Record that the ship has LEFT gate `i`'s trigger sphere, at sim time `at`.
   * DEV-195.
   *
   * Idempotent, and a no-op for a gate that has not been passed: a gate the
   * ship has never been inside is outside it on every tick, and stamping that
   * would hand every unflown gate on the course an exit time. The pass is what
   * arms this.
   *
   * Safe to call every frame with the sim's `CourseState.inside[]` — which is
   * what `game/rings.ts` does — because only the first call after the pass
   * takes.
   */
  exit(i: number, at: number): void
  /** Scale of gate `i` at sim time `now` under `spec`. 1 for a gate never passed. */
  scaleAt(i: number, now: number, spec: PassedFadeSpec): number
  /** Every gate back to full size. A restarted run rebuilds the course. */
  reset(): void
}

export const createGateVisibility = (count: number): GateVisibility => {
  const passedAt = new Float64Array(count).fill(Number.NaN)
  const exitedAt = new Float64Array(count).fill(Number.NaN)
  return {
    count,
    passedAt: (i) => passedAt[i] ?? Number.NaN,
    exitedAt: (i) => exitedAt[i] ?? Number.NaN,
    pass(i, at) {
      if (i < 0 || i >= count) return
      if (Number.isNaN(passedAt[i] as number)) passedAt[i] = at
    },
    exit(i, at) {
      if (i < 0 || i >= count) return
      // Armed by the pass, and once only.
      if (Number.isNaN(passedAt[i] as number)) return
      if (Number.isNaN(exitedAt[i] as number)) exitedAt[i] = at
    },
    scaleAt(i, now, spec) {
      const t = passedAt[i]
      if (t === undefined || Number.isNaN(t)) return 1
      return passedGateScale(now - fadeAnchor(t, exitedAt[i] as number, spec), spec)
    },
    reset() {
      passedAt.fill(Number.NaN)
      exitedAt.fill(Number.NaN)
    },
  }
}
