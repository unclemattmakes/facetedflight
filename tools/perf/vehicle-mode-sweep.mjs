// tools/perf/vehicle-mode-sweep.mjs — DEV-230. What is the 2.07 ms HoverJet term?
//
// STATUS: RUN ONCE 2026-09-19/20, and the crossing half of that run is VOID.
// DEV-233 read the four columns the report never touched and found that three
// of block A's four cells never flew the course — two of them never moved one
// metre in sixty seconds. `docs/plan/VR-PERF-DEV233.md` is the whole finding;
// the short version is at the top of `report()`'s `flightAgreement`. The
// SUSPECT half of that run is sound and its rows are in §3 of that doc.
//
//   node tools/perf/vehicle-mode-sweep.mjs --dry-run   # the plan, the clock,
//                                                      # and the pre-flight
//                                                      # mechanism check
//   node tools/perf/vehicle-mode-sweep.mjs --only suspects   # READ THIS ONE FIRST
//   node tools/perf/vehicle-mode-sweep.mjs             # the sweep
//
// Run it serially, on a quiet box: concurrent GPU work is what put three runs
// of one identical `perf-fill` measurement 2.2x apart across days
// (`docs/plan/VR-PERF-WAVE-3.md` §1).
//
// ── What DEV-233 changed, and why each one is a REFUSAL and not a tweak ──
//
// The first run produced a table of plausible numbers and two of its own guards
// told it not to believe them — the internal control disagreed by 0.93 ms and
// the calibration arm missed its known answer. Both were right and neither
// could say why, because the report was reading six columns of a
// twenty-two-column CSV.
//
//   1. **`?adaptive=0` on every arm** ({@link PIN_QUERY}). The calibration arm
//      ran at median render scale 1.000 against a bracket at 0.600 — 2.78x the
//      pixels, in the two halves of one subtraction.
//   2. **{@link flightAgreement}** — a block whose cells flew different
//      distances, or recorded different durations, gets no main effects.
//   3. **A SCALE column and refusal** on the suspects, for the same reason as 1
//      in the cases where the pin is off or did not take.
//   4. **{@link expectedCockpitMs}** — the calibration's expectation is derived
//      from the rig in the trace header instead of being a literal 0.48.
//   5. `lights` joins the mechanism list, because three issues no draw call for
//      a `PointLight` and the table was printing `ARM DID NOT FIRE` at a flag
//      that had worked.
//
// ── The question, and why the shipped content cannot answer it ───────────
//
// Wave 3 fitted GPU cost across all thirteen missions (`VR-PERF-WAVE-3` §3):
//
//     GPU p50 = 3.13 ms fixed + 0.223 ms per Mtri + 2.04 ms if HoverJet
//     R² 0.954
//
// The third term is the second-largest item in the game after the floor, seven
// of thirteen missions pay it, and **nobody knows what it is**. What is already
// ruled out, and what each fact kills:
//
//   NOT FILL.      2.04 ms at 1512 px/eye scale 0.6 and 2.07 ms at 2016 px/eye
//                  scale 1.0 — ~5x the pixels, no change. Anything whose cost
//                  scales with rasterised area is out, which kills the obvious
//                  "the cockpit covers a lot of screen".
//   NOT THE COCKPIT. A bracketed A/B switching `cockpit.body` + `cockpit.lighting`
//                  off measured **-0.48 ms** against a 0.02 ms bracket. Real,
//                  and under a quarter of the term.
//   NOT GEOMETRY.  On simonet the HoverJet missions draw FEWER triangles than
//                  the JumpSeat ones and still cost ~1.75 ms more.
//   NOT THE SHADOW PASS. Derived here from `perf-out/census-all/`, which stores
//                  `base.triangles` (world + shadow) and `census.triangles`
//                  (world alone) for all thirteen. The difference is the shadow
//                  pass, and it is flat across the vehicle:
//                    alpine  4.504 / 4.514  (HJ)  vs  4.515 / 4.482  (JS)
//                    desert  7.690 / 7.721  (HJ)  vs  7.632 / 7.684  (JS)
//                    simonet 1.122 / 1.107  (HJ)  vs  1.065 / 1.097  (JS)
//                  A fixed-size shadow map is the one big resolution-INDEPENDENT
//                  rasterisation in the frame, so it was the best remaining
//                  candidate that "not fill" did not already exclude. It is not
//                  the term. That reading cost nothing and it is why no arm
//                  below spends a slot on it.
//
// What still tracks the term is **program count**: 135-152 on HoverJet missions
// against 77-102 on JumpSeat ones in the stereo trace, and 88-105 against 62-80
// in the flat census. That is a correlation with no mechanism yet, and
// `programs` did not move when the cockpit went off (151 -> 150).
//
// ── THE CONFOUND, which is the whole difficulty ──────────────────────────
//
// **Vehicle and game mode are PERFECTLY COLLINEAR across all thirteen shipped
// missions.** Every HoverJet mission is `ringAttack`; every JumpSeat mission is
// `targetPractice`. No regression over the shipped content can separate them,
// and the term must not be called "the vehicle" until something does.
//
// And a third variable is collinear with both, which the brief did not name and
// the source does: **`spawn.launch` is non-null on 7/7 HoverJet missions and
// null on 6/6 JumpSeat ones.** So is `turnIndicators` (non-empty 7/7 vs empty
// 6/6), and so is the finish gate's art (`finish.shape === 'sphereUnion'` with
// art on 7/7 vs `convexMesh` with none on 6/6). The shipped thirteen do not
// separate FOUR things, not two.
//
// `hoverJet_kauai_beg` (HoverJet + `freeFlight`) is the one natural experiment
// and it is one point with the largest positive residual (+0.60).
//
// ── How this sweep separates them ────────────────────────────────────────
//
// **Two 2x2 blocks, each on ONE course.** Holding the course fixed is what
// makes a cell-to-cell difference a single variable: same environment, same
// rings, same turn indicators, same launch rig, same spawn, same lighting, same
// clouds, same scatter. Only the vehicle or only the mode moves.
//
//   BLOCK A, on the `int_01_hoverJet` course (simonet; rings, 9 turn
//   indicators, a launch elevator, a sphereUnion finish with art):
//
//                    ringAttack                      targetPractice
//     HoverJet       int_01_hoverJet                 int_01_hoverJet &mode=targetPractice
//     JumpSeat       dev230_int01_jumpSeat           dev230_int01_jumpSeat &mode=targetPractice
//
//   BLOCK B, on the `adv_02_jumpSeat` course (simonet; 13 pads, NO turn
//   indicators, NO launch elevator, a convexMesh finish with no art):
//
//                    ringAttack                      targetPractice
//     HoverJet       dev230_adv02_hoverJet &mode=ringAttack   dev230_adv02_hoverJet
//     JumpSeat       adv_02_jumpSeat &mode=ringAttack         adv_02_jumpSeat
//
// **Two blocks and not one, because a rule tested only where two explanations
// agree has not been tested** (CLAUDE.md's agreement lesson; DEV-042 and the
// env-root fix are the two instances that cost a day each). Block A's vehicle
// contrast carries the launch rig and the turn indicators in BOTH cells, so
// they cancel out of it. Block B's carries neither in either cell. If the
// vehicle effect is the same size in both blocks, the rig and the indicators
// contribute nothing to it; if A's is larger, they do, and the gap is how much.
// One block alone cannot tell those apart — which is exactly the shape of
// mistake the agreement lesson is about.
//
// ── The two crossings use DIFFERENT mechanisms, both already in the build ─
//
// **The mode crosses with `?mode=`** — DEV-144, `boot/app.ts:1254-1261`, fed to
// `runningMode(level, requested)` (`game/modes.ts:506`). A level's own forcing
// still wins, and both course owners carry `forcedMode: null` and
// `forcedModeFf2: null`, so the request wins on both. Nothing is authored and
// the level JSON is untouched: the cleanest possible mode arm.
//
// **The vehicle crosses with an AUTHORED LEVEL**, because there is no
// `?vehicle=` and there should not be one. `game/flight.ts:495-501` says it in
// its own words: *"`level.vehicle` ... is the only thing this branches on — no
// mission id, no environment, no mode. Content is data (hard rule 6): a mission
// that wants the other vehicle changes one string in its JSON."* So the two
// crossing levels change exactly one string each, plus the `id` that names the
// file:
//
//     content/authored/dev230_int01_jumpSeat.json   = int_01_hoverJet, vehicle jumpseat
//     content/authored/dev230_adv02_hoverJet.json   = adv_02_jumpSeat, vehicle hoverjet
//
// `content/authored/` and not `content/levels/`, and that is not tidiness.
// `tools/extract/check-content.mjs`'s `inventory()` hashes every `*.json` under
// `content/levels`, so a file dropped in there fails `extract:check` with
// `+ content/levels/<id>.json (not in the manifest)` — and adding it to the
// manifest would make the manifest mean something other than what its header
// says. `content/load-level.ts:32` already reads the authored tree and
// `?mission=` already finds it; DEV-145's glider lives there for the same
// reason. **No `src/` file changes to run this sweep**, which is hard rule 6
// working rather than being quoted.
//
// `tests/unit/vehicle-mode-cross.test.ts` holds both crossings to the
// relationship rather than to a value (trap 24): each authored level must equal
// its source in EVERY key but `id` and `vehicle`. A copy that drifted would
// otherwise look like a vehicle effect.
//
// ── Both crossed vehicles can actually fly, and it was checked ───────────
//
// A JumpSeat on a HoverJet course rides the lift: the launch spec is built from
// `level.spawn.launch` (`app.ts:6176-6185`), not from the vehicle, and
// `rideElevator` is a required member of the shared `Flight` interface
// (`game/flight.ts:391`) that the JumpSeat implements as a no-op
// (`jumpseat-flight.ts:699`).
//
// A HoverJet on a JumpSeat course does NOT fall, which was the thing worth
// checking: with no launch spec `app.ts:6364` sets `launch.phase = 'flying'`
// from frame one, and `sim/hoverjet.ts:159` initialises `launched: true`, so
// `body.useGravity = !jet.launched` (`hoverjet.ts:238`) is false from the first
// tick. The gravity trap in CLAUDE.md is about a ship that has not launched;
// this one has.
//
// ── Arms rejected by the FREE-CUT TEST, and why each would have lied ─────
//
// DEV-226 found that three edition flags switch off by writing a uniform with
// no early-out behind them, so each reports a free cut that reads exactly like
// a result. The same test is applied to every arm here BEFORE it reaches the
// list, and it threw four out:
//
//   `launch-anchor` (hide)   The launch elevator, the shaft and the hangar room
//                            — the one structure besides the ship that is
//                            perfectly vehicle-collinear, so the tempting arm.
//                            It draws NOTHING during the flight:
//                            `perf-out/census-all/` has no `launch-anchor` or
//                            `launch-room` row in ANY of the thirteen, and
//                            `censusRows` folds real render items, so a missing
//                            row is zero draws and not an omission. `app.ts:6979`
//                            sets `launchRoom.object.visible = !revealed` and
//                            the reveal is long past by the time the recorder
//                            arms. Hiding it removes no work, and its row would
//                            have said "the launch rig is free" when what it
//                            means is "the launch rig was already not drawn".
//                            Its PROGRAMS survive the reveal, which is a real
//                            hypothesis and needs a different instrument than a
//                            hide — see `no-warm-shaft` below.
//   `turn-indicators` (hide) 2 calls over 684 triangles at the 20 s census.
//                            That is the same order as `only-horizon-geo`,
//                            which DEV-226 rejected as smaller than any bracket
//                            this route has ever produced (0.01-0.02 ms).
//                            `turn-indicators.ts:165-178` sizes both
//                            `InstancedMesh`es `Math.max(n, 1)` and never
//                            narrows `count`, so a JumpSeat mission draws them
//                            too, with one identity instance — they are not
//                            where a program delta comes from either.
//                            Block A carries them in both cells regardless.
//   `fx.speedLines` (flag)   The stored census delta for this flag is
//                            `calls 0, triangles -24`. It removes nothing
//                            measurable at the snap, and
//                            `particle-fx.ts:293-313` builds the ship's five
//                            particle fields from `HOVERJET.particles` on BOTH
//                            vehicles, so it is not vehicle-gated in the first
//                            place. Two reasons, either sufficient.
//   `render.bloom` (flag)    Post-processing over the whole eye buffer, so its
//                            cost scales with the pixel count — and the term
//                            being hunted does not. Excluded a priori by the
//                            resolution pair, not by a shader read.
//
// ── What each arm ALSO changes, stated rather than hidden ────────────────
//
// - **A cell changes the LEVEL, so it changes the course's own geometry.** That
//   is why the blocks are read DOWN and ACROSS and never diagonally: A's
//   HoverJet cells and B's HoverJet cells are different courses and their
//   difference is not a vehicle effect. `report()` computes main effects within
//   a block only, and refuses a block with a missing cell rather than filling
//   it from the other one.
// - **`?mode=` between `ringAttack` and `targetPractice` moves ONE render-side
//   thing, and it is the opponents.** `MODES.ringAttack.live` and
//   `MODES.targetPractice.live` are both `['ring','padZone']` (`modes.ts:353`,
//   `:375`), so the live content set is identical; `opponents` is `true` and
//   `false` (`:369`, `:438`). So the mode main effect IS the racer cost, and
//   `no-racers` below must agree with it. Two mechanisms, one quantity: if they
//   disagree, something else is mode-gated and the enumeration missed it. That
//   is the sweep's internal control and it is worth its slot.
// - **`cockpit.lighting` moves the scene's POINT-LIGHT COUNT**, which is field
//   #36 of three's program cache key, so it re-keys every lit material that has
//   not had its loop cut. `scopeWorldPointLights` (`app.ts:5762`) cuts the loop
//   out of the world's materials textually (`point-light-scope.ts:202`) and
//   EXEMPTS the ship's, so the per-fragment cost is confined to the cockpit and
//   the program-count effect is scene-wide. Those are two different quantities
//   and this arm moves both; its row says so.
//
// ── The bracket, and why the runner adds it ──────────────────────────────
//
// `main()` puts a baseline at both ends whatever the arm list says, and the
// report refuses to attribute any effect at or below the bracket drift. There
// is no flag for it. Run 2 of DEV-191 came back 4.72 ms first and 6.98 ms last
// — the fixed term drifting inside four minutes — and without a bracket it
// would have produced a table of plausible numbers. An effect smaller than the
// drift is not a small effect; it is not an effect.
//
// The baseline is `int_01_hoverJet`, which is also cell A/HoverJet/ringAttack.
// The runner scores that cell from the BRACKET MEAN rather than re-running it,
// so the bracket is not wasted: two of the ten flights are the bracket and the
// bracket is also a cell.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { flag, isMain } from '../lib/cli.mjs'
import { COOL_MAX_SECONDS, COOL_TO_C } from './measure-queue.mjs'
import {
  ARM_OVERHEAD_SECONDS,
  DEFAULT_SECONDS,
  f2,
  median,
  mtri,
  readSummary,
  readTrace,
  refuseIfBusy,
  runArm,
  SPEC,
} from './sweep-core.mjs'

// The shared pieces keep their old names here: `tests/unit/vehicle-mode-cross.test.ts` and the
// `.d.mts` read them from this module.
export { ARM_OVERHEAD_SECONDS, DEFAULT_SECONDS, median, readTrace, SPEC }

/**
 * Appended to EVERY arm's query. DEV-233, and it is the sweep's biggest fix.
 *
 * `?adaptive=0` pins the render scale for the load, and `src/boot/quality-pin.ts`'s
 * own header — written for DEV-161, four months before this file existed —
 * states the case better than this comment could:
 *
 *   *"a GPU number read while the adaptive controller is walking the pixel
 *   count up and down is a number about the controller, and `?adaptive=0` is
 *   how a measurement says so."*
 *
 * The first run of this sweep did not pass it, and the controller ate two of
 * the three rows that mattered. `no-cockpit-all` — **the calibration arm, the
 * one row with a known answer** — settled at median scale **1.000** while the
 * baseline it is subtracted from settled at **0.600**. `ADAPTIVE_STEPS` is
 * `[1, 0.9, 0.8, 0.7, 0.6]`, so that arm rasterised **(1/0.6)^2 = 2.78x** the
 * pixels of its own control and still came back 0.85 ms cheaper. That is not a
 * measurement of the cockpit; it is a measurement of a closed loop being handed
 * a saving and spending it on resolution.
 *
 * **The error has a KNOWN SIGN**, which is what makes it worse than noise: the
 * controller converts a saving in milliseconds into a gain in pixels, so an arm
 * that works always UNDER-reports, and always by an amount nobody can see.
 *
 * `--no-pin` puts it back the way it was, for anyone reproducing the void run.
 */
export const PIN_QUERY = 'adaptive=0'

/**
 * How far two cells of one block may differ in metres flown before the block's
 * main effects are refused.
 *
 * **This is not a tolerance on noise, it is a floor under absurdity.** The eight
 * suspect arms of the first run — same mission, same mode, same autopilot —
 * flew 7871, 7873, 7873, 7873, 7873, 7875 and 7831 m, a spread of 44 m over
 * 7.9 km, which is 0.6 %. So a reproducible flight is reproducible to metres,
 * and anything approaching this number is a different flight rather than a
 * noisy one. 250 m is roughly three ring-gate spacings on `int_01_hoverJet`:
 * far beyond any drift this route has produced, and far below the 7873 m that
 * separated the block A cells the day this guard was written.
 */
export const FLIGHT_PATH_TOLERANCE_M = 250

/**
 * How far two cells may differ in RECORDED seconds before the block is refused.
 *
 * A separate guard from the path because it catches a separate failure: block
 * B's two HoverJet cells flew 3233 m apiece — identical to the metre, which
 * would pass any path check — and recorded **27.4 s of a 60 s arm**, because a
 * HoverJet dropped on a JumpSeat course has no rings, aims at the finish volume
 * from the first tick and gets there. Their JumpSeat neighbours recorded 59.2 s.
 * Half a table's worth of frames is not a vehicle effect.
 *
 * 3 s, because the shipped arms sit within 0.8 s of each other (60.0 against
 * 59.2) and an early finish costs tens.
 */
export const FLIGHT_SPAN_TOLERANCE_S = 3

/**
 * How far a row's median adaptive `scale` may sit from the bracket's before the
 * row is refused.
 *
 * `ADAPTIVE_STEPS` is a five-rung ladder, so the smallest real move is 0.6 to
 * 0.7 — a 36 % change in rasterised area. Anything above a rounding error is a
 * different resolution; 0.02 catches a median that landed between two rungs
 * because the run spent time on each, which is itself a reason not to attribute
 * the row.
 *
 * With {@link PIN_QUERY} on, every row should report the same pinned scale and
 * this guard should never fire. It stays because a guard that only fires when
 * somebody passes `--no-pin` is exactly the guard that tells them why their
 * numbers disagree with everybody else's.
 */
export const SCALE_TOLERANCE = 0.02

/**
 * Wave 3 §5's cockpit A/B: **0.48 ms**, bracket 0.02, on `int_01_hoverJet`.
 *
 * The one prior this sweep can be calibrated against, and the arm that carries
 * it is `no-cockpit-all`. See {@link expectedCockpitMs} for what has to be done
 * to it before it can be compared with anything measured here.
 */
export const WAVE3_COCKPIT_MS = 0.48

/** Pixels per eye the wave 3 cockpit A/B was measured at (`VR-PERF-WAVE-3` §2). */
export const WAVE3_RIG_PX = 1512

/**
 * What the calibration arm should report on THIS rig — the rig, and nothing else.
 *
 * The brief that commissioned DEV-233 supplied this and was right: the rig moved
 * from 1512 to 2016 px per eye between wave 3 and this sweep, and
 * `0.48 x (2016/1512)^2 = 0.853` against 0.85 measured, 0.4 % off. The cockpit
 * is a pure fill cost, so its price genuinely scales with rasterised area, and
 * an expectation quoted as a bare 0.48 is an expectation about hardware nobody
 * is running. **The arm keeps crying wolf because its premise went stale, not
 * because its reading is bad.**
 *
 * ── What is deliberately NOT in here ─────────────────────────────────────
 *
 * Pixels per eye are `rigPx^2 x scale^2`, and the adaptive `scale` moved between
 * the two halves of the very subtraction being calibrated on the first run:
 * 0.600 under the baseline, 1.000 under `no-cockpit-all`. The tempting fix is a
 * second factor for it — and it would be WRONG, because the arm's millisecond is
 * `baseline - arm` and a resolution change moves the *whole frame*, not just the
 * cockpit. Correcting the expectation for it would quietly claim that everything
 * else in the picture cost the same at 2.78x the pixels.
 *
 * So the scale is a REFUSAL and not a correction: `report()` declines to compare
 * at all when the two halves ran at different resolutions, and says why. That is
 * this project's posture everywhere else — `floor-sweep.mjs` refuses four ways
 * rather than guess once — and it is the right one here. {@link PIN_QUERY} makes
 * the case stop arising.
 *
 * Returns `null` rather than a guess when the rig is unknown (a pre-DEV-227
 * trace, or the flat path), and the report then says it could not check.
 */
export const expectedCockpitMs = (rigPx) => {
  if (!Number.isFinite(rigPx) || rigPx <= 0) return null
  return WAVE3_COCKPIT_MS * (rigPx / WAVE3_RIG_PX) ** 2
}

/**
 * The bracket, which is also cell A/hoverjet/ringAttack — see the header.
 *
 * It is `int_01_hoverJet` with nothing switched: the shipped configuration of
 * the mission the whole 2.07 ms question was first asked about.
 */
export const BASELINE = {
  name: 'baseline',
  mission: 'int_01_hoverJet',
  block: 'A',
  vehicle: 'hoverjet',
  mode: 'ringAttack',
  kind: 'cell',
  mechanism: 'none',
  why: 'the shipped configuration — the bracket, and cell A/hoverjet/ringAttack',
}

/**
 * The 2x2 cells and the suspect arms, in the order they run.
 *
 * `kind` decides how the report scores a row and there are exactly two:
 *
 *   `cell`     one square of a 2x2. Scored against the OTHER CELLS OF ITS OWN
 *              BLOCK, never against the baseline and never across blocks —
 *              A and B are different courses and a diagonal is not a variable.
 *   `suspect`  a subtractive arm on the baseline mission. Scored
 *              `baseline - arm`, the same convention as `floor-sweep.mjs`.
 *
 * `mechanism` is how the work is removed, printed beside every row because what
 * an arm removes decides what its millisecond means:
 *
 *   `content`         a different level or a different mode. No runtime call
 *                     signature is assumed; the PRE-FLIGHT check below proves
 *                     the arm is what it claims, out of the JSON, before the
 *                     GPU is touched.
 *   `draws`           the call is not issued. `calls` must fall.
 *   `build`           the subsystem is never constructed. `calls` must fall AND
 *                     the program count should too, which a hide cannot do.
 *   `lights`          a LIGHT is added or removed. **No call-count signature
 *                     exists, and that is a fact about lights rather than a
 *                     failure of the arm** — three issues no draw for a
 *                     `PointLight`; what moves is the scene's light COUNT,
 *                     field #36 of the program cache key. Marked, never judged.
 *                     DEV-233: the first run printed `no-cockpit-light` as
 *                     `ARM DID NOT FIRE` on exactly this, while the flag had
 *                     done its job perfectly.
 *   `pass+define`     a render pass AND a program change. Attributes neither.
 *   `none`            the baseline.
 */
export const DEFAULT_ARMS = [
  // ── BLOCK A — the int_01_hoverJet course, vehicle and mode crossed ─────
  //
  // A/hoverjet/ringAttack is the bracket and is not repeated here.
  {
    name: 'A-hj-target',
    mission: 'int_01_hoverJet',
    query: 'mode=targetPractice',
    block: 'A',
    vehicle: 'hoverjet',
    mode: 'targetPractice',
    kind: 'cell',
    mechanism: 'content',
    why: 'HoverJet flying Target Practice — the mode moved and nothing else',
  },
  {
    name: 'A-js-ring',
    mission: 'dev230_int01_jumpSeat',
    block: 'A',
    vehicle: 'jumpseat',
    mode: 'ringAttack',
    kind: 'cell',
    mechanism: 'content',
    why: 'JumpSeat flying Ring Attack on the HoverJet course — the vehicle moved and nothing else',
  },
  {
    name: 'A-js-target',
    mission: 'dev230_int01_jumpSeat',
    query: 'mode=targetPractice',
    block: 'A',
    vehicle: 'jumpseat',
    mode: 'targetPractice',
    kind: 'cell',
    mechanism: 'content',
    why: 'both moved — the interaction cell, and the shipped JumpSeat pairing',
  },

  // ── BLOCK B — the adv_02_jumpSeat course, the same 2x2 ─────────────────
  //
  // No launch rig, no turn indicators, no finish art, 13 pads, 0 rings. If the
  // vehicle effect here matches block A's, none of those is in it.
  //
  // **B'S MODE CONTRAST IS WEAKER THAN A'S, AND THE REPORT SAYS SO RATHER THAN
  // AVERAGING IT IN.** `adv_02_jumpSeat` has `route: null` and no gates, so the
  // three slot racers that `mode=ringAttack` spawns (`racer-grid.ts:197-211`
  // needs no start grid — Anniversary's three slots are placed off
  // `level.spawn.pos` alone) have no course to fly. They are built and drawn,
  // which is what a GPU reading is about, but where they end up over 60 s is
  // not controlled, and racers that sink out of the frustum stop costing
  // anything half way through the arm.
  //
  // **It does not touch B's VEHICLE effect**, which is the reason block B
  // exists: that effect is the mean of `hoverjet - jumpseat` within each mode
  // column, so the ringAttack column carries the same three unguided racers on
  // BOTH of its cells and they cancel exactly. Read B for the vehicle, read A
  // for the mode.
  {
    name: 'B-js-target',
    mission: 'adv_02_jumpSeat',
    block: 'B',
    vehicle: 'jumpseat',
    mode: 'targetPractice',
    kind: 'cell',
    mechanism: 'content',
    why: 'the shipped configuration of the cheapest mission in the game — block B’s origin',
  },
  {
    name: 'B-js-ring',
    mission: 'adv_02_jumpSeat',
    query: 'mode=ringAttack',
    block: 'B',
    vehicle: 'jumpseat',
    mode: 'ringAttack',
    kind: 'cell',
    mechanism: 'content',
    why: 'JumpSeat flying Ring Attack — the mode moved, on a course with no rig',
  },
  {
    name: 'B-hj-target',
    mission: 'dev230_adv02_hoverJet',
    block: 'B',
    vehicle: 'hoverjet',
    mode: 'targetPractice',
    kind: 'cell',
    mechanism: 'content',
    why: 'HoverJet flying Target Practice with no launch rig and no turn indicators',
  },
  {
    name: 'B-hj-ring',
    mission: 'dev230_adv02_hoverJet',
    query: 'mode=ringAttack',
    block: 'B',
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    kind: 'cell',
    mechanism: 'content',
    why: 'both moved — block B’s far corner, and the HoverJet pairing without its furniture',
  },

  // ── SUSPECTS — subtractive, on the baseline mission ────────────────────
  //
  // Each names ONE thing the enumeration found on the HoverJet side. They are
  // scored `baseline - arm` and they do not partition the term: the cockpit and
  // the racers overlap nothing, but `no-cockpit-all` is deliberately the sum of
  // the two rows above it and is here as their check.
  {
    name: 'no-cockpit-body',
    flagsOff: ['cockpit.body'],
    block: null,
    kind: 'suspect',
    mechanism: 'build',
    why: 'the seat, pilot, boots and gloves — 4 materials, 1 call, ~1276 tri (cockpit-body.ts:178)',
  },
  {
    name: 'no-cockpit-light',
    flagsOff: ['cockpit.lighting'],
    block: null,
    kind: 'suspect',
    // `lights` and not `build`, which is a CORRECTION rather than a relabel.
    // The first run printed this row as `ARM DID NOT FIRE` because its calls
    // came back 395 against the bracket's 394, and a `build` arm is proved by
    // the call count falling. **A light issues no draw call.** There was
    // nothing to fall, the flag worked perfectly, and the table said the
    // opposite in capitals — which is the same class of mistake as the free-cut
    // test, arriving from the other direction: a proof that cannot apply is not
    // a failed proof.
    mechanism: 'lights',
    why: 'the two cabin PointLights — moves the light COUNT, which re-keys every lit material',
  },
  {
    name: 'no-cockpit-all',
    flagsOff: ['cockpit.body', 'cockpit.lighting'],
    block: null,
    kind: 'suspect',
    mechanism: 'build',
    why: 'THE CALIBRATION ARM — wave 3 measured -0.48 ms, bracket 0.02. It must come back',
  },
  {
    name: 'no-racers',
    hide: ['racers'],
    block: null,
    kind: 'suspect',
    mechanism: 'draws',
    why: '5 transparent DoubleSide depthWrite:false ships — must agree with the mode effect',
  },
  {
    name: 'no-racers-built',
    flagsOff: ['gameplay.racers'],
    block: null,
    kind: 'suspect',
    mechanism: 'build',
    why: 'the same five, never constructed — the gap to `no-racers` is the cost of HAVING them',
  },
  {
    name: 'no-rings',
    hide: ['rings'],
    block: null,
    kind: 'suspect',
    mechanism: 'draws',
    why: '7 calls over 26.5 k tri — gates, studs, the finish frame and its banner',
  },
  {
    name: 'keep-point-lights',
    query: 'pointLights=keep',
    block: null,
    kind: 'suspect',
    mechanism: 'pass+define',
    why: 'puts the cut point-light loop BACK into every world material — sizes what the scope saves',
  },

  // ── DEV-233's two additions ───────────────────────────────────────────
  //
  // Both are subtractive on the baseline mission, so they inherit the one
  // property the first run proved this route has: eight arms flew 7871-7875 m
  // over the identical course. A suspect arm is the half of this sweep that
  // can produce a millisecond.
  {
    name: 'no-launch-anchor',
    hide: ['launch-anchor'],
    block: null,
    kind: 'suspect',
    mechanism: 'draws',
    // DEV-230 REJECTED this arm, and its own run then contradicted the evidence
    // it was rejected on. §5 said the launch rig "draws NOTHING during the
    // flight: `perf-out/census-all/` has no `launch-anchor` or `launch-room`
    // row in ANY of the thirteen". But `perf-out/vehicle-mode/01-baseline/
    // int_01_hoverJet-anniversary-60s-vrto3d.census.json` has one:
    // **`launch-anchor`, 9 objects, 1272 triangles**, at 60 s, in this sweep's
    // own output.
    //
    // Those are two different instruments — `census-all` folds DRAWN items and
    // this walk lists DRAWABLE ones — so the rejection is not refuted. It is
    // **unproven**, which is a different thing and the reason the arm is back:
    // the launch rig is the only structure besides the ship that is perfectly
    // vehicle-collinear across the shipped thirteen, and the `calls` column
    // settles in one arm what a census argument has now got wrong once.
    // If it draws nothing the row will say `ARM DID NOT FIRE` and that IS the
    // answer, for the price of one flight.
    why: '9 objects, 1272 tri in this sweep’s own census — DEV-230 rejected it on a census that disagrees',
  },
  {
    name: 'no-particle-fx',
    hide: ['particle-fx'],
    block: null,
    kind: 'suspect',
    mechanism: 'draws',
    // The free-cut test RUN BACKWARDS is how this one was missed. DEV-230
    // rejected `fx.speedLines` partly on a stored census delta of
    // `calls 0, triangles -24` — and a triangle count is a measurement of
    // GEOMETRY about a system whose entire cost is transparent, additive,
    // screen-filling overdraw. Twenty-four triangles of full-screen alpha is
    // not twenty-four triangles' worth of work; `floor-sweep.mjs` says the same
    // thing about the ocean from the other side.
    //
    // This is the GROUP, not the flag, so the draws genuinely stop: the census
    // carries `particle-fx`, 11 objects, and a hide is proved by `calls`.
    // It is not vehicle-gated (`particle-fx.ts:293` builds from
    // `HOVERJET.particles` on both ships) and it is not claimed to be — it is
    // here because nothing in this game has ever priced its fill.
    why: '11 objects of transparent additive overdraw — 22 triangles, and a triangle count cannot see fill',
  },
]

// ── reading what a run left on disk ──────────────────────────────────────

/**
 * The per-eye viewport the rig presented, out of the trace header's `projection`.
 *
 * Needed by ONE thing — the calibration arm's expected value — and that is the
 * whole of why it is here. Wave 3 measured the cockpit at 0.48 ms on a rig
 * running **1512 px per eye**; this sweep's traces carry
 * `projection[0].viewport.w === 2016`. Fill scales with area, so an expectation
 * quoted as a bare 0.48 is an expectation about a rig nobody is running.
 * DEV-227 is why the header carries this at all.
 *
 * `null` on the flat path and on any trace whose header predates DEV-227 — the
 * report then says it could not check rather than inventing a number.
 */
export const readRigPixels = (csvPath) => {
  if (!fs.existsSync(csvPath)) return null
  const first = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/)[0] ?? ''
  try {
    const header = JSON.parse(first)
    const w = header?.projection?.[0]?.viewport?.w
    const h = header?.projection?.[0]?.viewport?.h
    return Number.isFinite(w) && Number.isFinite(h) ? { w, h } : null
  } catch {
    return null
  }
}

/**
 * The summary + trace an arm's run wrote, or null if it wrote none. The stem carries the
 * MISSION (see `readSummary`), so a cell that loaded the wrong level fails loudly.
 */
export const readArm = (dir, mission, edition, seconds) => {
  const got = readSummary(dir, mission, edition, seconds)
  if (got === null) return null
  return { ...got.base, trace: readTrace(got.csv), rig: readRigPixels(got.csv) }
}

// ── the PRE-FLIGHT mechanism check ───────────────────────────────────────

/**
 * Read a level out of either tree — generated first, then authored, which is
 * `loadLevel`'s own order (`src/content/load-level.ts:63`).
 */
export const readLevel = (repo, id) => {
  for (const tree of ['levels', 'authored']) {
    const p = path.join(repo, 'content', tree, `${id}.json`)
    if (fs.existsSync(p)) return { tree, level: JSON.parse(fs.readFileSync(p, 'utf8')) }
  }
  return null
}

/**
 * `game/modes.ts:506`'s `runningMode`, re-implemented over the raw JSON.
 *
 * Re-implemented and NOT imported, because this is a `.mjs` tool and that is a
 * TypeScript module — but the duplication is the hazard trap 24 names, so
 * `tests/unit/vehicle-mode-cross.test.ts` asserts the two AGREE on every
 * shipped level and every mode, rather than asserting either one's output.
 *
 * The ternary is load-bearing and `forcedModeFf2 ?? forcedMode` would be wrong:
 * the FF2 value is itself `{ mode: null }` on `int_02_jumpSeat`, meaning *force
 * nothing*, and `??` would fall through to 2016's forcing and re-impose it.
 */
export const runningModeOf = (level, requested) =>
  (level.forcedModeFf2 ? level.forcedModeFf2.mode : level.forcedMode) ??
  (requested && TEACHING_MODES.includes(requested) === (level.lesson != null)
    ? requested
    : undefined) ??
  level.mode

/**
 * The modes whose row TEACHES (`game/modes.ts`, `teaches: true`). DEV-377:
 * `runningMode` honours a request only where it keeps the level's teaching the
 * same — a teaching mode where the level carries a lesson, any other where it
 * does not. This `.mjs` cannot read the row, so it carries the list, and
 * `vehicle-mode-cross.test.ts` holds it equal to the rows that say `teaches`.
 */
export const TEACHING_MODES = ['lesson']

/**
 * Does this arm actually produce the vehicle and mode it claims?
 *
 * **This is the mechanism check for a CONTENT arm, and it runs before the GPU
 * is touched.** §3d rule 1 of the perf protocol is that an arm must prove it
 * reached the compiler before any millisecond is believed — and for a hide that
 * proof is the call count falling, which a content arm has no equivalent of. It
 * has something better: the whole question is decidable from the JSON, so it is
 * decided in node, in `--dry-run`, for free, rather than being inferred from a
 * number after an hour of flying.
 *
 * The failure it exists to catch is silent by design. `?mode=` warns and
 * IGNORES an unknown id (`app.ts:1258`, deliberately — a typo in a URL should
 * not be a black page), and `runningMode` lets a level's own forcing beat the
 * request. Either one turns a crossing cell into a duplicate of the cell beside
 * it, and two cells that agree would then read as *"the mode costs nothing"*.
 */
export const preflight = (arm, repo) => {
  const wantMode = (arm.query ?? '').match(/(?:^|&)mode=([^&]+)/)?.[1] ?? null
  const found = readLevel(repo, arm.mission)
  if (!found)
    return { ok: false, note: `no such level: content/{levels,authored}/${arm.mission}.json` }
  const { tree, level } = found
  const notes = []
  let ok = true
  if (level.id !== arm.mission) {
    ok = false
    notes.push(`the file's id is ${level.id}, not ${arm.mission} — loadLevel keys on the FILENAME`)
  }
  if (arm.vehicle && level.vehicle !== arm.vehicle) {
    ok = false
    notes.push(`vehicle is ${level.vehicle}, the arm claims ${arm.vehicle}`)
  }
  const running = runningModeOf(level, wantMode)
  if (arm.mode && running !== arm.mode) {
    ok = false
    notes.push(
      `running mode is ${running}, the arm claims ${arm.mode}` +
        (wantMode && level.forcedMode
          ? ` — the level FORCES ${level.forcedMode} and a forcing beats ?mode=`
          : ''),
    )
  }
  return { ok, tree, vehicle: level.vehicle, mode: running, note: notes.join('; ') }
}

/**
 * Every content arm's pre-flight, plus the one check no single arm can make:
 * **that the block's four cells are four DIFFERENT (vehicle, mode) pairs.**
 *
 * A 2x2 whose cells collapse is the failure mode this sweep exists to avoid and
 * it cannot be seen one row at a time — each row would pass its own check while
 * two of them measured the same thing. Same shape as DEV-226's control being
 * identified by what it DOES rather than by its name.
 */
export const preflightAll = (arms, repo) => {
  // BY NAME, deduplicated, because the runner puts the baseline at both ends
  // and the baseline is also a cell. Two runs of ONE arm are the bracket; two
  // arms at one (vehicle, mode) are the collapse. The first version of this
  // counted the bracket as a collapse and refused its own default arm list —
  // caught by `--dry-run`, which is the whole reason that flag exists.
  const seenNames = new Set()
  const rows = arms
    .filter((a) => a.kind === 'cell')
    .filter((a) => !seenNames.has(a.name) && seenNames.add(a.name))
    .map((a) => ({ arm: a, check: preflight(a, repo) }))
  const problems = rows.filter((r) => !r.check.ok).map((r) => `${r.arm.name}: ${r.check.note}`)
  const blocks = new Map()
  for (const r of rows) {
    const key = r.arm.block
    const seen = blocks.get(key) ?? new Map()
    const pair = `${r.check.vehicle}/${r.check.mode}`
    seen.set(pair, [...(seen.get(pair) ?? []), r.arm.name])
    blocks.set(key, seen)
  }
  for (const [block, seen] of blocks) {
    for (const [pair, names] of seen) {
      if (names.length > 1)
        problems.push(
          `block ${block} has ${names.length} cells at ${pair} (${names.join(', ')}) — ` +
            'the 2x2 has collapsed and its main effects would be about nothing',
        )
    }
    if (seen.size !== 4)
      problems.push(
        `block ${block} covers ${seen.size} of the 4 (vehicle, mode) pairs: ` +
          `${[...seen.keys()].join(', ')}`,
      )
  }
  return { rows, problems }
}

// ── running one arm ──────────────────────────────────────────────────────

/**
 * The arm's own query with {@link PIN_QUERY} merged in — `&`-joined, the arm's
 * half first so it reads the way the doc writes it.
 *
 * Exported because it is the one place the pin can go missing and because a
 * unit test asserting *"every arm carries the pin"* is worth more than a
 * comment saying it does. `pin: false` is `--no-pin`.
 *
 * An arm that spells `adaptive=` itself wins — the pin is a default, not a
 * clamp, and an arm whose whole point was the controller would otherwise be
 * silently overruled by a global. Nothing in `DEFAULT_ARMS` does that today.
 */
export const armQuery = (arm, pin = true) => {
  const own = arm.query ?? ''
  if (!pin || /(?:^|&)adaptive=/.test(own)) return own
  return own === '' ? PIN_QUERY : `${own}&${PIN_QUERY}`
}

const armEnv = (arm, opts, dir) => ({
  VRTO3D_MISSION: arm.mission ?? opts.mission,
  VRTO3D_SECONDS: String(opts.seconds),
  VRTO3D_EDITION: opts.edition,
  VRTO3D_DIR: dir,
  VRTO3D_FLAGS_OFF: (arm.flagsOff ?? []).join(','),
  VRTO3D_FLAGS_ON: (arm.flagsOn ?? []).join(','),
  VRTO3D_HIDE: (arm.hide ?? []).join(','),
  VRTO3D_SOLO: (arm.solo ?? []).join(','),
  VRTO3D_QUERY: armQuery(arm, opts.pin !== false),
})

const run = (arm, opts, index, total) => {
  const dir = path.join(opts.outDir, `${String(index).padStart(2, '0')}-${arm.name}`)
  const mission = arm.mission ?? opts.mission
  return runArm({
    arm,
    dir,
    env: armEnv(arm, opts, dir),
    mission,
    dryRun: opts.dryRun,
    index,
    total,
    read: (d) => readArm(d, mission, opts.edition, opts.seconds),
  })
}

// ── the report ───────────────────────────────────────────────────────────

/**
 * Did these rows fly the same flight?
 *
 * ── The refusal DEV-230's run needed and did not have ────────────────────
 *
 * The bracket measures whether the INSTRUMENT moved between the first arm and
 * the last. It cannot see whether an arm measured a different world, and on
 * 2026-09-19 three of block A's four cells did:
 *
 *     baseline       7873 m flown, 60.0 s recorded
 *     A-hj-target    1538 m flown inside a 173 x 133 m box
 *     A-js-ring         0 m — the ship sat at its spawn for sixty seconds
 *     A-js-target       0 m — likewise
 *
 * Every cell passed its own pre-flight: the JSON really did name the vehicle
 * and the mode each one claimed. What no check asked was whether the aircraft
 * then went anywhere. On a renderer this fill-bound the camera's position is
 * the largest single input to a frame's cost, so a "mode effect" of 0.88 ms was
 * the difference between crossing an island and circling one ring — and the
 * 1.71 ms "interaction" that looked like the most interesting number in the
 * table was the arithmetic of one row differing by 7.9 km while the other
 * differed by nothing at all.
 *
 * **Both halves matter and they catch different failures.** Block B's two
 * HoverJet cells flew 3233 m each — identical to the metre, which passes any
 * path test — and recorded 27.4 s of a 60 s arm, because a HoverJet on a
 * JumpSeat course has no rings, aims at the finish volume from the first tick,
 * and reaches it. A run that ends early is not a short measurement of the same
 * thing; it is a measurement of the first half of a different thing.
 *
 * Returns `{ ok, reason, note }`. `ok` is false only when the data EXISTS and
 * disagrees: a trace with no `ship_x` (an older wire format, or a synthetic row
 * in a test) reports `ok: true` with a reason saying it could not check, because
 * a guard that fails closed on missing data would refuse every historical run
 * rather than the two arms that deserve it.
 */
export const flightAgreement = (
  rows,
  pathTolerance = FLIGHT_PATH_TOLERANCE_M,
  spanTolerance = FLIGHT_SPAN_TOLERANCE_S,
) => {
  const present = rows.filter((r) => r?.read?.trace)
  const paths = present.map((r) => r.read.trace.path).filter((p) => typeof p === 'number')
  const spans = present.map((r) => r.read.trace.span).filter((s) => typeof s === 'number')
  if (paths.length < 2 && spans.length < 2)
    return {
      ok: true,
      reason: 'no flight data',
      note: 'the traces carry no ship track — not checked',
    }
  const notes = []
  let ok = true
  if (paths.length >= 2) {
    const spread = Math.max(...paths) - Math.min(...paths)
    if (spread > pathTolerance) {
      ok = false
      notes.push(
        `they flew ${Math.min(...paths).toFixed(0)}-${Math.max(...paths).toFixed(0)} m, a spread of ` +
          `${spread.toFixed(0)} m against a ${pathTolerance} m tolerance`,
      )
    }
  }
  if (spans.length >= 2) {
    const spread = Math.max(...spans) - Math.min(...spans)
    if (spread > spanTolerance) {
      ok = false
      notes.push(
        `they recorded ${Math.min(...spans).toFixed(1)}-${Math.max(...spans).toFixed(1)} s, a spread of ` +
          `${spread.toFixed(1)} s against a ${spanTolerance} s tolerance`,
      )
    }
  }
  return { ok, reason: ok ? 'agree' : 'diverge', note: notes.join('; ') }
}

/**
 * What a completed 2x2 means for the question the whole sweep was built to ask.
 *
 * The two main effects are the answer and the interaction is the caveat. The
 * thresholds are stated so a reader can disagree with them; only the numbers
 * they are applied to are measurements. Rule 1 of the perf protocol is *print,
 * don't gate* — nothing here passes or fails.
 */
export const verdict = (vehicle, mode, drift, term = 2.07) => {
  if (vehicle === null || mode === null)
    return 'the block is incomplete — no main effect can be read'
  const v = Math.abs(vehicle) > drift
  const m = Math.abs(mode) > drift
  if (!v && !m)
    return (
      `NEITHER clears the bracket (${f2(drift)} ms). On this course the ${term} ms term did ` +
      'not reproduce at all, which is a result about the COURSE and not about the vehicle — ' +
      'read the other block before concluding anything.'
    )
  if (v && !m)
    return (
      `THE VEHICLE. ${f2(vehicle)} ms moves with the ship and ${f2(mode)} ms with the mode, ` +
      'which is below the bracket. The term is the HoverJet, and the cockpit is the part of ' +
      'it already priced at 0.48 ms.'
    )
  if (m && !v)
    return (
      `THE MODE. ${f2(mode)} ms moves with the mode and ${f2(vehicle)} ms with the ship, ` +
      'below the bracket. Ring Attack costs it, not the HoverJet — and the only render-side ' +
      'thing the mode moves is the opponents, so `no-racers` should match this number.'
    )
  return (
    `BOTH. vehicle ${f2(vehicle)} ms, mode ${f2(mode)} ms, and each clears the bracket. ` +
    'The 2.07 ms is a sum of two terms the shipped thirteen could never separate, and the ' +
    'split above is the separation.'
  )
}

/**
 * The tables. `echo` is injectable so a unit test can drive the whole report on
 * synthetic rows — and, more to the point, so the BRACKET REFUSAL and the
 * collapsed-cell refusal are things a test can assert rather than things
 * somebody reads once on the night.
 */
export const report = (rows, opts, echo = console.log) => {
  const out = []
  const say = (line = '') => {
    out.push(line)
    echo(line)
  }

  const baselines = rows.filter((r) => r.arm.name === BASELINE.name && r.read?.gpu)
  const first = baselines[0]
  const last = baselines[baselines.length - 1]

  say()
  say('══ DEV-230 · is the 2.07 ms term the VEHICLE or the MODE? ══════════════')
  say(`   ${opts.edition} · ${opts.seconds} s per arm · ${rows.length} runs`)
  say(`   ${SPEC}`)
  say()

  if (!first || !last || first === last) {
    say('   NO BRACKET — fewer than two baseline runs produced a reading.')
    say('   Nothing below can be attributed. Re-run the sweep.')
    return out.join('\n')
  }
  const drift = Math.abs(last.read.gpu.p50 - first.read.gpu.p50)
  const base = (first.read.gpu.p50 + last.read.gpu.p50) / 2
  const driftP95 = Math.abs(last.read.gpu.p95 - first.read.gpu.p95)
  const W = 63
  const box = (text) => say(`   │ ${text.padEnd(W - 2)} │`)
  say(`   ┌─ BRACKET ${'─'.repeat(W - 10)}┐`)
  box(`baseline FIRST ${f2(first.read.gpu.p50)} ms    baseline LAST ${f2(last.read.gpu.p50)} ms`)
  box(`DRIFT ${f2(drift)} ms (p50), ${f2(driftP95)} ms (p95)`)
  box('Nothing at or below the drift is attributed. That is not')
  box('caution, it is what the drift MEANS. (perf-protocol §3d.2)')
  say(`   └${'─'.repeat(W)}┘`)
  if (drift > 0.5)
    say(
      `\n   !! DRIFT ${f2(drift)} ms is large. Wave 3's two bracketed A/Bs on this route\n` +
        '      came back 0.01 and 0.02 ms. Something moved under this run — check the\n' +
        '      GPU clocks and the chrome/node counts in the per-arm lines above before\n' +
        '      reading a single row.',
    )

  // The baseline IS a cell, so it enters the grid at the bracket mean rather
  // than as one of its two halves — see the header.
  const cells = rows.filter((r) => r.arm.kind === 'cell' && r.arm.name !== BASELINE.name)
  const baseCell = {
    arm: BASELINE,
    read: { ...first.read, gpu: { p50: base, p95: (first.read.gpu.p95 + last.read.gpu.p95) / 2 } },
  }
  const all = [baseCell, ...cells]

  const at = (block, vehicle, mode) =>
    all.find((r) => r.arm.block === block && r.arm.vehicle === vehicle && r.arm.mode === mode) ??
    null
  const gpuOf = (r) => r?.read?.gpu?.p50 ?? null

  const blockIds = [...new Set(all.map((r) => r.arm.block))].filter((b) => b !== null).sort()
  const effects = new Map()

  for (const block of blockIds) {
    const hr = at(block, 'hoverjet', 'ringAttack')
    const ht = at(block, 'hoverjet', 'targetPractice')
    const jr = at(block, 'jumpseat', 'ringAttack')
    const jt = at(block, 'jumpseat', 'targetPractice')
    const quad = [hr, ht, jr, jt]
    say()
    say(`── BLOCK ${block} — ${blockCourse(all, block)}`)
    say()
    say('                     ringAttack        targetPractice')
    const cellText = (r) =>
      r === null
        ? '   MISSING    '
        : r.read?.gpu
          ? `${f2(r.read.gpu.p50).padStart(7)} ms     `
          : '  DID NOT RUN '
    say(`   HoverJet      ${cellText(hr)}   ${cellText(ht)}`)
    say(`   JumpSeat      ${cellText(jr)}   ${cellText(jt)}`)
    say()
    for (const r of quad) {
      if (r === null) continue
      const t = r.read?.trace
      say(
        `     ${r.arm.name.padEnd(14)}${String(r.arm.mission ?? opts.mission).padEnd(24)}` +
          `calls ${String(t?.calls ?? 'n/a').padStart(4)}   tris ${mtri(t?.triangles)}` +
          `   flew ${t?.path === null || t?.path === undefined ? '  n/a' : `${t.path.toFixed(0)} m`.padStart(7)}` +
          `  in ${t?.span === null || t?.span === undefined ? ' n/a' : `${t.span.toFixed(1)} s`.padStart(7)}` +
          `  scale ${t?.scale === null || t?.scale === undefined ? 'n/a' : t.scale.toFixed(3)}`,
      )
    }
    // A main effect is the MEAN of two independent contrasts, and it is refused
    // outright if either is missing. Filling one from the other block would be
    // a diagonal across two different courses, which is not a variable at all.
    const need = quad.every((r) => gpuOf(r) !== null)
    if (!need) {
      say()
      say(`   Block ${block} is incomplete — no main effect. A missing cell is NOT filled`)
      say('   from the other block: those are different courses and a diagonal between')
      say('   them is not a single variable.')
      effects.set(block, { vehicle: null, mode: null })
      continue
    }
    // ── the FLIGHT refusal (DEV-233) ─────────────────────────────────────
    //
    // The cells passed their pre-flight: the JSON named the vehicle and the
    // mode each one claims. This asks the question the pre-flight cannot,
    // because it is not in the JSON — did the aircraft then go anywhere?
    const flight = flightAgreement(quad)
    if (!flight.ok) {
      say()
      say(`   !! BLOCK ${block}'S CELLS DID NOT FLY THE SAME COURSE — ${flight.note}.`)
      say()
      say('   No main effect is computed from these four numbers, and the ones above are')
      say('   not small versions of the right answer: on this renderer the camera position')
      say('   is the largest single input to a frame, so a cell that circled one gate is')
      say('   not a cheap lap, it is a different picture. A bracket cannot see this — the')
      say('   bracket says the INSTRUMENT held still, not that the ARMS measured one world.')
      say()
      say("   The known cause is `game/modes.ts`'s `scores` array, one layer below the")
      say('   renderer. `game/mission.ts:594` runs `stepCourse` only when the mode scores')
      say('   rings and `:615` runs `stepTargets` only when it scores pads, and BOTH')
      say('   autopilots steer by the counter those two lines advance. A HoverJet in')
      say('   Target Practice flies at ring 1 for ever; a JumpSeat in Ring Attack re-flies')
      say('   pad 1. `docs/plan/VR-PERF-DEV233.md` §2 has the walk.')
      effects.set(block, { vehicle: null, mode: null })
      continue
    }
    const vehicle = (gpuOf(hr) - gpuOf(jr) + (gpuOf(ht) - gpuOf(jt))) / 2
    const mode = (gpuOf(hr) - gpuOf(ht) + (gpuOf(jr) - gpuOf(jt))) / 2
    const interaction = gpuOf(hr) - gpuOf(ht) - (gpuOf(jr) - gpuOf(jt))
    effects.set(block, { vehicle, mode, interaction })
    say()
    say(
      `   VEHICLE effect  ${f2(vehicle).padStart(7)} ms   (HoverJet minus JumpSeat, mean of both modes)`,
    )
    say(
      `   MODE effect     ${f2(mode).padStart(7)} ms   (ringAttack minus targetPractice, mean of both ships)`,
    )
    say(
      `   interaction     ${f2(interaction).padStart(7)} ms   (how much the mode effect depends on the ship)`,
    )
    say()
    say(`   ${verdict(vehicle, mode, drift)}`)
  }

  // ── the two blocks against each other ──────────────────────────────────
  if (blockIds.length > 1) {
    const a = effects.get('A')
    const b = effects.get('B')
    say()
    say('══ the two courses, and what their AGREEMENT rules out ═════════════════')
    say()
    if (!a || !b || a.vehicle === null || b.vehicle === null) {
      say('   One block is incomplete, so the courses cannot be compared. That comparison')
      say('   is the only thing that separates the VEHICLE from the launch rig, the turn')
      say('   indicators and the finish art — all three ride with the course, not the')
      say('   ship. Without it, "the vehicle" still means "the vehicle and its furniture".')
    } else {
      const gap = a.vehicle - b.vehicle
      say(
        `   vehicle effect  block A ${f2(a.vehicle)} ms   block B ${f2(b.vehicle)} ms   gap ${f2(gap)} ms`,
      )
      say(
        `   mode effect     block A ${f2(a.mode)} ms   block B ${f2(b.mode)} ms   gap ${f2(a.mode - b.mode)} ms`,
      )
      say()
      say("   Read B for the VEHICLE and A for the MODE. B's course has no route and no")
      say('   gates, so the three racers `mode=ringAttack` spawns there fly unguided and')
      say("   may leave the frustum part-way through the arm. That cancels out of B's")
      say('   vehicle effect — the same racers are on both of its ringAttack cells — and')
      say("   it does NOT cancel out of B's mode effect. The gap on that row is not")
      say('   evidence about courses.')
      say()
      say('   Block A carries the launch rig, 9 turn indicators and a sphereUnion finish')
      say('   with art in BOTH of its vehicle cells; block B carries none of the three in')
      say('   either. So:')
      say()
      if (Math.abs(gap) <= drift)
        say(
          `   THE TWO AGREE (gap ${f2(gap)} ms, inside the ${f2(drift)} ms bracket). The launch\n` +
            '   rig, the turn indicators and the finish art are NOT in the vehicle term —\n' +
            '   it survives on a course that has none of them. What is left is the ship\n' +
            '   itself: the cockpit, the exterior GLB, the cabin lights and their programs.',
        )
      else
        say(
          `   THEY DIVERGE by ${f2(gap)} ms, which is more than the ${f2(drift)} ms bracket. The\n` +
            '   vehicle term is not a property of the vehicle alone: it is larger on the\n' +
            '   course that carries the launch rig, the turn indicators and the finish art.\n' +
            `   ${f2(Math.abs(gap))} ms of the term belongs to that furniture, and the suspect\n` +
            '   rows below are where to look for which piece.',
        )
    }
  }

  // ── the suspects ───────────────────────────────────────────────────────
  const suspects = rows.filter((r) => r.arm.kind === 'suspect')
  if (suspects.length > 0) {
    const baseCalls = first.read?.trace?.calls ?? null
    say()
    say(`══ SUSPECTS — ${BASELINE.mission}, baseline MINUS the arm ══════════════`)
    say()
    say('   Each names one thing the enumeration found on the HoverJet side. They do')
    say('   not partition the term and they are not meant to: `no-cockpit-all` is the')
    say('   sum of the two rows above it and is here as their check, and the two racer')
    say('   rows are the same subsystem removed two different ways.')
    say()
    say(
      `   BASELINE ${f2(base)} ms p50, ${String(baseCalls ?? 'n/a')} calls — the mean of the bracket.`,
    )
    say()
    // The bracket's own flight and resolution. Every suspect is subtracted from
    // it, so every suspect has to have been flown against the same picture.
    const baseScale = first.read?.trace?.scale ?? null
    say(
      '   arm                mechanism      gpu p50   effect    calls   flew  scale   attribution',
    )
    say(`   ${'─'.repeat(103)}`)
    for (const r of suspects) {
      if (!r.read?.gpu) {
        say(`   ${r.arm.name.padEnd(19)}${r.arm.mechanism.padEnd(15)}   DID NOT RUN — see ${r.dir}`)
        continue
      }
      const calls = r.read.trace?.calls ?? null
      const scale = r.read.trace?.scale ?? null
      const effect = base - r.read.gpu.p50
      // Did the arm FIRE? A `draws` or `build` arm must show the call count
      // fall; `pass+define` moves a define and `lights` moves a light, and
      // NEITHER has a call-count signature — three issues no draw for a light,
      // so there is nothing to fall and a proof that cannot apply is not a
      // failed proof. Both are marked rather than judged. An arm that never
      // fired reports a free cut, which is indistinguishable from a result —
      // the failure this column is the whole of. (perf-protocol §3d rule 1.)
      const needsFall = r.arm.mechanism === 'draws' || r.arm.mechanism === 'build'
      const fired = !needsFall
        ? 'no runtime proof'
        : calls === null
          ? 'ARM DID NOT FIRE'
          : baseCalls !== null && calls < baseCalls
            ? 'fired'
            : 'ARM DID NOT FIRE'
      // DEV-233. A suspect is `baseline - arm`, so it inherits the bracket's
      // flight whether anyone checks or not. These two say whether it did.
      const flight = flightAgreement([first, r])
      const scaleMoved =
        baseScale !== null && scale !== null && Math.abs(scale - baseScale) > SCALE_TOLERANCE
      const pixelRatio = scaleMoved ? (scale / baseScale) ** 2 : 1
      const attribution =
        fired === 'ARM DID NOT FIRE'
          ? 'ARM DID NOT FIRE — not a result'
          : !flight.ok
            ? `FLEW DIFFERENTLY — ${flight.note}`
            : scaleMoved
              ? `SCALE MOVED ${baseScale.toFixed(2)}→${scale.toFixed(2)} ` +
                `(${pixelRatio.toFixed(2)}x the pixels) — NOT attributable`
              : Math.abs(effect) <= drift
                ? `below bracket (${f2(drift)}) — NOT attributable`
                : r.arm.mechanism === 'pass+define'
                  ? `${f2(effect)} ms, CONFOUNDED (pass + define)`
                  : r.arm.mechanism === 'lights'
                    ? `${f2(effect)} ms, a light COUNT — no call signature to prove it`
                    : fired === 'no runtime proof'
                      ? `${f2(effect)} ms, mechanism unproven at runtime`
                      : `${f2(effect)} ms`
      const t = r.read.trace
      say(
        `   ${r.arm.name.padEnd(19)}${r.arm.mechanism.padEnd(15)}${f2(r.read.gpu.p50).padStart(7)}` +
          `${f2(effect).padStart(9)}${String(calls ?? 'n/a').padStart(9)}` +
          `${(t?.path === null || t?.path === undefined ? 'n/a' : `${(t.path / 1000).toFixed(1)}k`).padStart(7)}` +
          `${(scale === null ? 'n/a' : scale.toFixed(2)).padStart(7)}   ${attribution}`,
      )
    }
    if (baseScale !== null) {
      say()
      say(
        `   The bracket ran at scale ${baseScale.toFixed(2)}. \`ADAPTIVE_STEPS\` is [1, .9, .8, .7, .6], so a row`,
      )
      say('   one rung away rasterised 36 % more pixels than the row it is subtracted from.')
      say(`   \`?${PIN_QUERY}\` is appended to every arm to hold that still; --no-pin removes it.`)
    }

    // ── the internal control ─────────────────────────────────────────────
    //
    // `?mode=targetPractice` and `hide racers` remove the same thing by two
    // mechanisms: the mode row's `opponents` is the ONLY render-side difference
    // between ringAttack and targetPractice (`modes.ts:353` and `:375` have the
    // same `live` set). If they disagree, something else is mode-gated and the
    // enumeration missed it — which is worth more than either number.
    const modeA = effects.get('A')?.mode ?? null
    const hideRacers = suspects.find((r) => r.arm.name === 'no-racers')
    const hideEffect = hideRacers?.read?.gpu ? base - hideRacers.read.gpu.p50 : null
    if (modeA === null && hideEffect !== null) {
      // DEV-233. The control needs a block A mode effect and block A did not
      // produce one — which is not a missing number, it is the answer. The
      // first run DID produce one, the two halves disagreed by 0.93 ms, and the
      // disagreement was real: `hide racers` was a measurement (same flight,
      // same scale) and the mode column was not.
      say()
      say('   INTERNAL CONTROL — not available, and that is the result')
      say(`     hide racers           ${f2(hideEffect)} ms  — same flight, same resolution`)
      say('     block A mode effect   refused above, so there is nothing to compare it with.')
      say('     The racer row stands on its own. The mode column does not exist to disagree')
      say('     with it, which is a stronger statement than the two of them agreeing.')
    }
    if (modeA !== null && hideEffect !== null) {
      say()
      say('   INTERNAL CONTROL — two mechanisms, one quantity')
      say(`     block A mode effect   ${f2(modeA)} ms`)
      say(`     hide racers           ${f2(hideEffect)} ms`)
      const d = Math.abs(modeA - hideEffect)
      say(
        d <= drift
          ? `     They AGREE to ${f2(d)} ms, inside the bracket. The mode's whole render-side\n` +
              '     effect is the opponents, as the mode table says, and the enumeration is'
          : `     They DISAGREE by ${f2(d)} ms, outside the bracket. Something other than the\n` +
              '     opponents is mode-gated and the enumeration missed it — find it before',
      )
      say(d <= drift ? '     complete for these two modes.' : '     reading the vehicle number.')
    }

    // ── the calibration arm ──────────────────────────────────────────────
    const cal = suspects.find((r) => r.arm.name === 'no-cockpit-all')
    if (cal?.read?.gpu) {
      const got = base - cal.read.gpu.p50
      // DEV-233. The expectation is DERIVED, because a bare 0.48 is an
      // expectation about a rig nobody is running any more. Two factors, and
      // the report prints both so the reader can see which one is doing the
      // work — the rig moved 1512 -> 2016 px per eye between wave 3 and this
      // sweep, and the adaptive controller then moved the scale UNDER the
      // subtraction, 0.600 on the baseline against 1.000 on this arm.
      const rigPx = cal.read.rig?.w ?? first.read?.rig?.w ?? null
      const calScale = cal.read.trace?.scale ?? null
      const scaleMoved =
        baseScale !== null && calScale !== null && Math.abs(calScale - baseScale) > SCALE_TOLERANCE
      const want = rigPx === null ? null : expectedCockpitMs(rigPx)
      say()
      say('   CALIBRATION — the one arm here with a known answer')
      say(`     wave 3 §5 measured ${WAVE3_COCKPIT_MS.toFixed(2)} ms at ${WAVE3_RIG_PX} px/eye.`)
      if (want === null) {
        say('     This trace carries no per-eye projection (pre-DEV-227, or the flat path), so')
        say(
          `     the expectation cannot be scaled to this rig. Measured ${f2(got)} ms; NOT compared.`,
        )
        say('     A calibration against an unknown rig is not a calibration.')
      } else if (scaleMoved) {
        // The refusal, not a correction. See `expectedCockpitMs`'s own note for
        // why a second factor here would be worse than no comparison at all.
        say(
          `     This rig is ${rigPx} px/eye, so the expectation is ` +
            `${WAVE3_COCKPIT_MS.toFixed(2)} x (${rigPx}/${WAVE3_RIG_PX})^2 = ${want.toFixed(2)} ms.`,
        )
        say(`     This run says ${f2(got)} ms — and it is NOT COMPARED.`)
        say()
        say(
          `     !! THE TWO HALVES RAN AT DIFFERENT RESOLUTIONS: the bracket at scale ` +
            `${baseScale.toFixed(2)},`,
        )
        say(
          `     this arm at ${calScale.toFixed(2)} — ${((calScale / baseScale) ** 2).toFixed(2)}x the pixels. ` +
            'The number above is not a bad',
        )
        say('     measurement of the cockpit, it is a subtraction between two different')
        say('     pictures, and there is no factor that repairs it: a resolution change moves')
        say(`     the WHOLE frame. Re-run with \`?${PIN_QUERY}\` (the default) and this goes away.`)
      } else {
        say(
          `     This rig is ${rigPx} px/eye and the cockpit is a pure fill cost, so the` +
            ` expectation`,
        )
        say(
          `     is ${WAVE3_COCKPIT_MS.toFixed(2)} x (${rigPx}/${WAVE3_RIG_PX})^2 = ${want.toFixed(2)} ms. ` +
            `This run says ${f2(got)} ms.`,
        )
        say(
          Math.abs(got - want) <= Math.max(drift, 0.1)
            ? '     It reproduced. That is the licence to read every other row in this report.'
            : '     !! IT DID NOT REPRODUCE. The one arm whose answer was already known came\n' +
                '     back different, so nothing else in this report should be filed. Check the\n' +
                '     rig, the clocks and the edition before re-running.',
        )
      }
    }
  }

  say()
  say('   Confounds carried into these tables, stated rather than hidden:')
  say('   · a CELL changes the level, so the two blocks are different courses. Main')
  say('     effects are computed within a block only; a diagonal is not a variable.')
  say('   · the mode moves one render-side thing — the opponents — and one SIM-side thing')
  say("     that costs far more: `modes.ts`'s `scores` array gates `stepCourse` and")
  say('     `stepTargets` (`mission.ts:594`, `:615`), which are the only two counters')
  say('     either autopilot steers by. A crossed cell may therefore fly nowhere at all.')
  say('     That is what the FLIGHT refusal above is for. DEV-233.')
  say('   · `no-cockpit-light` moves the point-light COUNT, which is both a per-fragment')
  say('     change on the ship and a program-key change on everything lit. One row,')
  say('     two quantities; `keep-point-lights` is what sizes the second.')
  say('   · the free-cut test keeps `turn-indicators`, `fx.speedLines` and `render.bloom`')
  say("     out of this list; this file's header has the measurement or the file:line for")
  say('     each. DEV-233 put `launch-anchor` BACK — the census DEV-230 rejected it on')
  say("     disagrees with this sweep's own. Do not move an arm either way without")
  say('     reading the argument.')
  say('   · every row here is `baseline - arm` and therefore inherits the bracket’s')
  say('     flight and its render scale. Both are now columns, and both refuse.')
  say()

  return out.join('\n')
}

/**
 * What a block's cells are flying over, for the table's title.
 *
 * A block is ONE COURSE flown by TWO level files — the shipped one and its
 * authored crossing copy, which differ in `vehicle` and in nothing else. Saying
 * `a + b` alone reads as two courses, which is the one thing a reader must not
 * conclude about a block: the whole design is that a block holds the course
 * fixed. Three or more names is a malformed block and says so rather than being
 * dressed up as one.
 */
export const blockCourse = (rows, block) => {
  const names = [...new Set(rows.filter((r) => r.arm.block === block).map((r) => r.arm.mission))]
  if (names.length === 1) return `the ${names[0]} course`
  if (names.length === 2) return `the ${names[0]} course — flown as ${names[0]} and ${names[1]}`
  return `${names.length} MISSIONS: ${names.join(', ')} — this is not one course`
}

// ── the plan, printed before anything runs ───────────────────────────────

const plan = (arms, opts, repo) => {
  const total = arms.length
  const flight = opts.seconds + ARM_OVERHEAD_SECONDS
  const lowMin = Math.round((total * flight) / 60)
  const highMin = Math.round((total * (flight + COOL_MAX_SECONDS)) / 60)
  console.log('DEV-230 vehicle/mode sweep — is the 2.07 ms term the ship or the mode?')
  console.log(`  spec      ${SPEC}`)
  console.log(`  out       ${opts.outDir}`)
  console.log(`  edition   ${opts.edition}, ${opts.seconds} s per arm`)
  console.log(`  arms      ${total}, baseline-bracketed at both ends`)
  console.log(
    opts.pin === false
      ? '  scale     NOT PINNED (--no-pin). The adaptive controller is free to move the\n' +
          '            pixel count between arms, which is what voided DEV-230’s calibration\n' +
          '            row — see PIN_QUERY. The report will refuse rows it moved under.'
      : `  scale     pinned, ?${PIN_QUERY} on every arm (DEV-233)`,
  )
  console.log(
    `  runtime   ~${lowMin} min if the GPU never needs cooling, ~${highMin} min worst case\n` +
      `            (${opts.seconds} s of flight + ~${ARM_OVERHEAD_SECONDS} s boot/load/VR per arm,\n` +
      `            plus up to ${COOL_MAX_SECONDS} s cooling to ${COOL_TO_C} C before each)`,
  )
  console.log()

  // ── the pre-flight check, before the clock and before the GPU ──────────
  const { rows, problems } = preflightAll(arms, repo)
  console.log('  PRE-FLIGHT — every content arm is what it claims, out of the JSON:')
  for (const r of rows)
    console.log(
      `    ${r.check.ok ? 'ok  ' : 'FAIL'} ${r.arm.name.padEnd(14)}` +
        `${String(r.arm.mission).padEnd(24)}${String(r.check.tree ?? '?').padEnd(10)}` +
        `${String(r.check.vehicle ?? '?').padEnd(10)}${r.check.mode ?? '?'}` +
        (r.check.note ? `   ${r.check.note}` : ''),
    )
  if (problems.length > 0) {
    console.error('\n  REFUSING TO RUN — the arm list does not describe what it would measure:')
    for (const p of problems) console.error(`    · ${p}`)
    console.error(
      '\n  A crossing cell that quietly duplicates the cell beside it is the exact\n' +
        '  failure this sweep exists to avoid, and it is decidable from the JSON —\n' +
        '  so it is decided here, for free, and not inferred from a number after an\n' +
        '  hour of flying.',
    )
    process.exit(1)
  }
  console.log('  All cells distinct, all four (vehicle, mode) pairs covered per block.')
  console.log()
  console.log('  Before you start:')
  console.log('   1. Install the virtual headset — in ../vr-browser:')
  console.log('        node tools/steamvr-rig.mjs install vrto3d')
  console.log('      and `uninstall vrto3d` afterwards.')
  console.log('   2. Start SteamVR, and make it the active OpenXR runtime.')
  console.log('   3. Nothing else on this box. Not a fan-out, not `pnpm check` —')
  console.log('      node with 220 test files is CPU starvation and this app measures')
  console.log('      itself and DROPS A TIER (perf-protocol §3a-quater).')
  console.log('   4. Optionally start your own dev server first, so every arm talks to')
  console.log('      one warm process rather than sixteen cold ones:')
  console.log(
    `        E2E_PORT=${process.env.E2E_PORT ?? '5273'} pnpm dev --port ${process.env.E2E_PORT ?? '5273'} --strictPort --host`,
  )
  console.log()
}

// ── main ─────────────────────────────────────────────────────────────────

const main = () => {
  const dryRun = process.argv.includes('--dry-run')
  const armsFile = flag('arms', process.env.CROSS_ARMS ?? null)
  const opts = {
    mission: flag('mission', process.env.CROSS_MISSION ?? BASELINE.mission),
    edition: flag('edition', process.env.CROSS_EDITION ?? 'anniversary'),
    seconds: Number(flag('seconds', process.env.CROSS_SECONDS ?? String(DEFAULT_SECONDS))),
    outDir: flag('out', process.env.CROSS_DIR ?? path.join('perf-out', 'vehicle-mode')),
    // DEV-233. ON unless asked otherwise — see PIN_QUERY. `--no-pin` exists to
    // reproduce the void first run, not because anybody should want it.
    pin: !process.argv.includes('--no-pin'),
    dryRun,
  }
  const repo = flag('repo', process.cwd())
  // `--only cells` or `--only suspects`, because sixteen arms is over half an
  // hour and the crossing is the part that answers the question. Splitting it
  // across two sittings is fine: each half gets its OWN bracket, which is the
  // thing that makes two sittings comparable at all.
  const only = flag('only', null)
  if (only !== null && only !== 'cells' && only !== 'suspects') {
    console.error(`--only ${only} is not one of: cells, suspects`)
    process.exit(1)
  }
  const given = armsFile ? JSON.parse(fs.readFileSync(armsFile, 'utf8')) : DEFAULT_ARMS
  // Defaults BEFORE the `--only` filter: an `--arms` file need not spell `kind`,
  // and filtering on a field that has not been defaulted yet drops every row of
  // somebody else's arm list without saying why.
  for (const a of given) {
    a.kind ??= a.block ? 'cell' : 'suspect'
    a.mechanism ??= a.hide || a.solo ? 'draws' : a.flagsOff ? 'build' : 'content'
    a.why ??= ''
  }
  const chosen = given.filter(
    (a) => only === null || (only === 'cells' ? a.kind === 'cell' : a.kind === 'suspect'),
  )
  if (chosen.length === 0) {
    console.error(`--only ${only} selected no arms out of ${given.length}.`)
    process.exit(1)
  }
  // The bracket is the runner's, not the arm list's — see the header.
  const rows = [BASELINE, ...chosen, BASELINE]

  plan(rows, opts, repo)

  if (!dryRun) refuseIfBusy()

  // A dry run touches nothing on disk — it is the thing you run to check the
  // plan, the clock and the pre-flight, and it should leave nothing to tidy up.
  if (!dryRun) fs.mkdirSync(opts.outDir, { recursive: true })
  const results = []
  for (const [i, arm] of rows.entries()) results.push(run(arm, opts, i + 1, rows.length))

  if (dryRun) {
    console.log('\n── dry run: nothing was measured.')
    return
  }

  const text = report(results, opts)
  fs.writeFileSync(path.join(opts.outDir, 'vehicle-mode.txt'), `${text}\n`)
  fs.writeFileSync(
    path.join(opts.outDir, 'vehicle-mode.json'),
    `${JSON.stringify({ opts, spec: SPEC, rows: results }, null, 2)}\n`,
  )
  console.log(`   written to ${path.join(opts.outDir, 'vehicle-mode')}.{txt,json}`)

  if (results.some((r) => !r.skipped && r.status !== 0)) process.exit(1)
}

if (isMain(import.meta.url)) main()
