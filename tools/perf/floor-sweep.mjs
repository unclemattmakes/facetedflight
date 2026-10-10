// tools/perf/floor-sweep.mjs — DEV-226. What is IN the 3.13 ms every level pays?
//
// STATUS: RUN ONCE, 2026-09-19, and that run is VOID — its control was not a
// control. The arm hid the stage's groups by assignment, `app.ts`'s `frame()`
// wrote `world-terrain`'s and `sky-dome`'s visibility back on the next frame,
// and the "empty stage" drew 203 calls and 1.44 M triangles of land and sky.
// `perf-out/floor-sweep/floor-sweep.txt` is that run; do not read a number out
// of it. **The question is still open.** DEV-231 fixed the arm (a visibility
// LOCK, `setHidden` in the spec), made the spec refuse a control with anything
// left drawable, and made `report()` refuse a table whose control is not the
// smallest row in it — which is the one comparison that would have caught it
// for free, from data that was already on disk.
//
// Run it serially, on a quiet box: other agents and a live VR compositor are
// what put three runs of the identical `perf-fill` measurement on disk 2.2x
// apart (`docs/plan/VR-PERF-WAVE-3.md` §1).
//
//   node tools/perf/floor-sweep.mjs --dry-run      # the plan and the clock
//   node tools/perf/floor-sweep.mjs                # the sweep
//
// ── The question ─────────────────────────────────────────────────────────
//
// Wave 3 fitted GPU cost across all thirteen missions (VR-PERF-WAVE-3 §3):
//
//     GPU p50 = 3.13 ms fixed + 0.223 ms per Mtri + 2.04 ms if HoverJet
//     R² 0.954
//
// The **3.13 ms fixed term is paid by every level regardless of geometry** and
// is 40 % of the whole pass-rule budget (`GPU p95 <= 0.7 x 11.11 = 7.78 ms`)
// before anything mission-specific is drawn. It is the largest unattributed
// item on the board and nobody knows what is in it. Two stories fit it and they
// have opposite consequences:
//
//   **FILL.** Every frame shades roughly the same number of fragments whatever
//   the mission, because the sky, the sea and the land cover the same screen.
//   The census's own overdraw for `adv_02_jumpSeat` is `shaded` 2.22 — every
//   pixel shaded twice over — and 2 x 1512² x 2.22 is ~10 M shaded fragments a
//   frame. If that is the floor, the levers are the shaders on the big
//   surfaces, the pixel count, and MSAA.
//
//   **FIXED PER-FRAME OVERHEAD.** The clear, three's traversal and state
//   setup, two submissions, the MSAA resolve, and SteamVR's own swapchain
//   acquire/resolve. If that is the floor, **no art or content decision can
//   touch it** and the only levers left are multiview, the resolution, and the
//   compositor — which is a different roadmap from the one wave 3 dispatched.
//
// The EMPTY STAGE arm separates them in one reading, and nothing else on the
// board can. See `verdict()` at the bottom for the arithmetic that decides it.
//
// ── And the ranking under it is taken in BOTH directions ─────────────────
//
// Matt asked for the additive half directly, and it is not a mirror of the
// subtractive one. Each is wrong in a KNOWN direction:
//
//   **A HIDE UNDER-STATES.** Take an opaque group away and its pixels go to
//   whatever was behind it, which then shades them. You never recover the cost
//   of a thing that was hiding work.
//   **A SOLO OVER-STATES.** Drawn against nothing, a group pays for every pixel
//   it covers with no depth rejection in front of it, and loses the early-Z its
//   neighbours were granting it.
//
// So `report()` prints two tables and the GAP between them, and the gap is
// itself a reading: a group whose two numbers agree is genuinely that
// expensive; one where they diverge has a cost that is mostly **occlusion
// relationship** rather than intrinsic, and re-ordering it is then a lever that
// deleting it is not. For the ocean — `DoubleSide` with a per-fragment
// `discard`, forfeiting early depth write on the largest surface in the frame —
// that gap is the interesting number rather than a nuisance.
//
// ── Why this instrument and not the frozen frame ─────────────────────────
//
// `tests/e2e/xr-vrto3d-trace.spec.ts` flies 60 s through a real SteamVR
// compositor and repeats: wave 3's two A/Bs bracketed at **0.02 ms** and
// **0.01 ms** drift. The frozen-frame ablations on this laptop do not — §1 of
// the brief has the 5.24 / 11.84 / 11.69 ms triple for one identical
// measurement, and **no frozen-frame ablation taken on this machine has ever
// survived its own drift guard**. So every arm here is a flight.
//
// ── Why `adv_02_jumpSeat`, and not the worst mission ─────────────────────
//
// The floor is environment-independent by construction — it is the term the fit
// assigns with triangles at zero — so it can be measured anywhere. Measure it
// where it is the LARGEST SHARE of the frame, because that is where an arm's
// effect is largest relative to the drift that could hide it:
//
//   adv_02_jumpSeat   GPU p50 **3.73 ms**, of which ~3.13 is floor  — 84 %
//   adv_01_hoverJet   GPU p50 10.38 ms, of which ~3.13 is floor     — 30 %
//
// It is the cheapest mission in the game (wave 3 §2), on simonet, whose scatter
// is 0.90 M triangles against desert's 7.42 M — so DEV-224/225's territory is
// nearly absent from the frame and cannot crowd the reading. It is also a
// **JumpSeat/targetPractice** mission, so the 2.04 ms HoverJet term is not in
// it either. Three of the model's four terms are as small as the game gets and
// the fourth is the one being measured.
//
// The cost: nothing HoverJet-only is visible here — the cockpit, its two lamps,
// the ring-attack gates. That is deliberate. The ~1.56 ms that separates
// HoverJet from JumpSeat after the cockpit (wave 3 §6) is a different unknown
// and wants its own sweep, on `int_01_hoverJet`, with `--mission`.
//
// ── The bracket, and why the runner adds it rather than the arm list ─────
//
// `perf-scale.spec.ts` reads its baseline first and again LAST and prints the
// gap, because run 2 of DEV-191 came back 4.72 ms first and 6.98 ms last — the
// fixed term drifting 1.84 -> 3.84 inside four minutes — and without the
// bracket it would have produced a table of plausible numbers. Its own output
// is honestly stamped `NOT A FIT — do not read this row` where that happened.
//
// So `main()` puts a baseline at both ends whatever the arm file says, and
// **the report refuses to attribute any effect at or below the bracket drift**.
// An arm list cannot switch that off; there is no flag for it. An arm smaller
// than the drift is not a small effect, it is not an effect.
//
// ── The arms are chosen from evidence, and three were REJECTED ───────────
//
// Read `DEFAULT_ARMS` for what is in and why. What is out matters as much:
//
//   `render.haze`        `attachEditionHaze` sets `uHaze` to a zeroed vec4
//                        (`render/haze.ts:226`). `HAZE_GLSL`'s `ff2AerialHaze`
//                        has NO early-out — every term still evaluates and is
//                        multiplied by zero. The arm removes no work at all.
//   `render.illustrative` `uWarp.x = 0`, and `ILLUSTRATIVE_REPLACEMENT` is a
//                        `mix(irradiance, ff2IllustrativeWarp(...), uWarp.x)`.
//                        A uniform cannot be constant-folded; the warp runs.
//   `render.sunHeight`   `uSunTopC.x = 0` — but `ff2SunHeightTerm` takes its
//                        **texture sample and its `fwidth` BEFORE the branch**,
//                        deliberately (`far-shadow.ts:95-107`), because
//                        `fwidth` is undefined in non-uniform control flow. The
//                        fetch is the expensive half and it is unconditional.
//
// All three would read ~0.00 ms, and §3d of the perf protocol is explicit that
// such a row *"renders a row saying this cut is free — which is
// indistinguishable from a result"*. They are not run. This paragraph is what
// their rows would have said. `render.coast` survives the same test and IS an
// arm, because its GLSL really does branch: `if (uCoastRamp.z <= 0.0 &&
// uCoastRamp.w <= 0.0) return color;` skips a dependent texture fetch on every
// ocean fragment (`render/coast.ts:341`, whose comment says so).

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
  readTrace as readTraceFlight,
  refuseIfBusy,
  runArm,
  SPEC,
} from './sweep-core.mjs'

// The shared pieces keep their old names here: `tests/unit/floor-sweep.test.ts` and the `.d.mts`
// read them from this module.
export { ARM_OVERHEAD_SECONDS, DEFAULT_SECONDS, median, SPEC }

/** The mission the floor is largest in. The header argues for it. */
export const DEFAULT_MISSION = 'adv_02_jumpSeat'

/**
 * The sweep, in the order it runs. `main()` brackets it with a baseline at each
 * end, so nothing here needs one.
 *
 * Each arm is `{ name, hide?, solo?, flagsOff?, mechanism, why }`:
 *
 *   `hide`      stage groups to hide (`VRTO3D_HIDE`), or `['*']` for the empty
 *               stage — SUBTRACTIVE.
 *   `solo`      the one group to show, everything else hidden (`VRTO3D_SOLO`) —
 *               ADDITIVE.
 *   `flagsOff`  dotted edition flags to switch off (`VRTO3D_FLAGS_OFF`).
 *   `mechanism` how the work is removed — `draws` (the call is not issued),
 *               `pass+define` (a render pass AND a program change), or
 *               `uniform-branch` (a uniform-conditional skip inside the
 *               shader). The report prints it beside every row, because what an
 *               arm removes decides what its millisecond means.
 *   `why`       one line, printed in the plan.
 *
 * ── Two directions, because each is wrong in a KNOWN direction ───────────
 *
 * Matt asked for the additive half directly, and it is not a mirror of the
 * subtractive one. The two bound the answer from opposite sides:
 *
 * - **A HIDE UNDER-STATES.** Take an opaque group away and its pixels go to
 *   whatever was behind it, which then shades them. You never recover the full
 *   cost of a thing that was hiding work, so the hide arms are expected to sum
 *   SHORT of the empty stage. That is arithmetic, not error, and `report()`
 *   prints the gap rather than hiding it.
 * - **A SOLO OVER-STATES.** Drawn against nothing, a group pays for every pixel
 *   it covers with no depth rejection from anything in front of it, and loses
 *   the early-Z its neighbours were granting it.
 *
 * **Truth is between them, and the GAP is itself a reading.** A group whose two
 * numbers agree is genuinely that expensive. One where they diverge widely has
 * a cost that is mostly **occlusion relationship** rather than intrinsic — and
 * for the ocean (`DoubleSide` + `discard`, forfeiting early-Z on the largest
 * surface in the frame) that gap is the interesting number rather than a
 * nuisance.
 *
 * Both tables are measured from the SAME empty stage, which is why `*` leaves
 * the lights alone: it hid them for one commit, which recompiled every lit
 * material and made it an origin only the subtractive table could use.
 *
 * ── What each arm ALSO changes, which is the part that bites ─────────────
 *
 * §3 of the brief names two confounds that the thirteen-mission regression
 * could not escape — triangles are collinear with shadow-caster count, and
 * vehicle is perfectly collinear with game mode. The same question has to be
 * asked of every arm here, and three answers are uncomfortable:
 *
 * - **The occlusion pair above**, which is why the report prints both.
 *   `sky-dome` is the least affected on the subtractive side — three sorts
 *   opaques front-to-back so it is already mostly depth-rejected, which is
 *   itself a finding if `no-sky` comes back near zero and `only-sky` does not.
 * - **A SOLO still runs the SHADOW PASS, for its own group alone.** `only-land`
 *   carries the terrain's casting; `only-sky` carries a shadow pass with
 *   nothing in it. So the shadow term does not distribute evenly across the
 *   additive table and the rows are not a partition of the frame. Stated, not
 *   corrected — `shadows-off` is the arm that prices it.
 * - **`render.shadows` moves two things at once** — the whole shadow pass
 *   (geometry) and `USE_SHADOWMAP` in every lit material (fragment). It
 *   **cannot attribute either half** and its row says so. It is here because
 *   the fragment half is paid by every mission and is therefore floor, while
 *   wave 3 §5 already priced the pair on desert at 2.70 ms; a simonet reading
 *   against a 1.06 M-triangle shadow pass separates the halves ACROSS the two
 *   environments even though neither run can separate them alone.
 *
 * ── The additive arm that was REJECTED ───────────────────────────────────
 *
 * The same test that threw out `render.haze` applies here in its own form: an
 * arm that cannot remove work is not an arm. On the additive side the shape is
 * *"a solo that is indistinguishable from the empty stage"* — and
 * `only-horizon-geo` was a candidate and is not here. `horizon-geo` is ONE call
 * over 576 triangles; against nothing it draws a fogged band and no depth
 * rejection changes, so its solo and the empty stage would differ by less than
 * any bracket this route has ever produced (0.01–0.02 ms). Its SUBTRACTIVE row
 * stays, because there it is measured against a full frame where it can shade
 * over something. `only-clouds` is kept only because clouds are transparent —
 * they never had early-Z to lose, so their two directions should AGREE, which
 * makes them the table's internal control.
 */
export const DEFAULT_ARMS = [
  {
    name: 'empty-stage',
    hide: ['*'],
    mechanism: 'draws',
    why: 'the floor of the floor — clear, traverse, two submits, resolve, compositor',
  },
  {
    name: 'no-sky',
    hide: ['sky-dome'],
    mechanism: 'draws',
    why: '1 call, 20 k tris, the whole backdrop — near-pure fill, depth-rejected or not',
  },
  {
    name: 'no-ocean',
    hide: ['world-ocean'],
    mechanism: 'draws',
    why: '3 calls, 444 k tris, DoubleSide with a per-fragment discard — the fill suspect',
  },
  {
    name: 'no-land',
    hide: ['world-terrain'],
    mechanism: 'draws',
    why: '59 calls, 1.1 M tris — chunks, scatter and dressing, and their shadow casting',
  },
  {
    name: 'no-clouds',
    hide: ['clouds'],
    mechanism: 'draws',
    why: '3 transparent calls over 3.8 k tris — overdraw with no depth write',
  },
  {
    name: 'no-horizon-geo',
    hide: ['horizon-geo'],
    mechanism: 'draws',
    why: '1 call, 576 tris, a wide fogged band round the eye',
  },
  {
    name: 'shadows-off',
    flagsOff: ['render.shadows'],
    mechanism: 'pass+define',
    why: 'the shadow pass AND the per-fragment lookup — confounded, and said so',
  },
  {
    name: 'coast-off',
    flagsOff: ['render.coast'],
    mechanism: 'uniform-branch',
    why: 'skips a dependent texture fetch on every ocean fragment — pure fill, no geometry',
  },

  // ── ADDITIVE: one group against nothing ────────────────────────────────
  //
  // Read as `arm - empty-stage`, and paired in the report with the hide arm
  // that names the same group. Each over-states for the reason in the block
  // comment above; the pair brackets the truth.
  {
    name: 'only-sky',
    solo: ['sky-dome'],
    mechanism: 'draws',
    why: 'the backdrop with nothing in front of it — no depth rejection at all',
  },
  {
    name: 'only-ocean',
    solo: ['world-ocean'],
    mechanism: 'draws',
    why: 'the DoubleSide discard shader, every pixel it covers, early-Z forfeit and all',
  },
  {
    name: 'only-land',
    solo: ['world-terrain'],
    mechanism: 'draws',
    why: 'chunks, scatter and dressing against nothing — pairs with no-land',
  },
  {
    name: 'only-chunks',
    solo: ['world-terrain/chunks'],
    mechanism: 'draws',
    why: 'the land SURFACE without the scatter — safe to solo, unsafe to hide (streaming)',
  },
  {
    name: 'only-clouds',
    solo: ['clouds'],
    mechanism: 'draws',
    why: 'transparent, so it never had early-Z to lose — the tables should AGREE here',
  },
]

const BASELINE = {
  name: 'baseline',
  mechanism: 'none',
  why: 'the shipped configuration — the bracket',
}

// ── reading what a run left on disk ──────────────────────────────────────

/**
 * Median `calls` and `tris` over the recorded frames — the arm's MECHANISM
 * CHECK, and the reason it is read at all.
 *
 * §3d rule 1 of the perf protocol: *an arm must prove it reached the compiler
 * before any millisecond is believed*, because an arm that never fired reports
 * a free cut. For a `hide` arm the runtime proof is right here — the draws stop
 * being issued, so `calls` falls. A `uniform-branch` arm has no such proof and
 * `report()` says so in its row rather than pretending one exists.
 *
 * Columns are read from the CSV's own header line, never by index: the trace's
 * column list is a wire format that is APPENDED to (perf-protocol §5a), so
 * `row[8]` is right until the day it is not.
 */
export const readTrace = (csvPath) => {
  // The shared reader also returns the flight (path, span, scale, bbox); this sweep never
  // read those and its JSON never carried them, so it keeps the three it always had.
  const t = readTraceFlight(csvPath)
  return t === null ? null : { calls: t.calls, triangles: t.triangles, rows: t.rows }
}

/**
 * What the arm FAILED to hide — DEV-231, written beside the summary by the spec.
 *
 * `[]` and `null` are different answers, for `median`'s reason: an empty array
 * is the spec saying *nothing was left drawable*, and `null` is a run that said
 * nothing at all (an older output tree, or a crash before the write). The
 * report must never read the second as the first, because the whole defect this
 * guards against was a control that LOOKED like it had nothing to say.
 */
export const readResidue = (censusPath) => {
  if (!fs.existsSync(censusPath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(censusPath, 'utf8'))
    return {
      residue: Array.isArray(parsed.residue) ? parsed.residue : null,
      relit: typeof parsed.relit === 'object' && parsed.relit !== null ? parsed.relit : {},
    }
  } catch {
    return null
  }
}

/** The summary + trace an arm's run wrote, or null if it wrote none. */
export const readArm = (dir, mission, edition, seconds) => {
  const got = readSummary(dir, mission, edition, seconds)
  if (got === null) return null
  const side = readResidue(path.join(dir, `${got.stem}.census.json`))
  return {
    ...got.base,
    trace: readTrace(got.csv),
    residue: side?.residue ?? null,
    relit: side?.relit ?? null,
  }
}

// ── running one arm ──────────────────────────────────────────────────────

const armEnv = (arm, mission, seconds, edition, dir) => ({
  VRTO3D_MISSION: mission,
  VRTO3D_SECONDS: String(seconds),
  VRTO3D_EDITION: edition,
  VRTO3D_DIR: dir,
  VRTO3D_FLAGS_OFF: (arm.flagsOff ?? []).join(','),
  VRTO3D_HIDE: (arm.hide ?? []).join(','),
  VRTO3D_SOLO: (arm.solo ?? []).join(','),
})

const run = (arm, opts, index, total) => {
  const dir = path.join(opts.outDir, `${String(index).padStart(2, '0')}-${arm.name}`)
  return runArm({
    arm,
    dir,
    env: armEnv(arm, opts.mission, opts.seconds, opts.edition, dir),
    dryRun: opts.dryRun,
    index,
    total,
    read: (d) => readArm(d, opts.mission, opts.edition, opts.seconds),
  })
}

// ── the report ───────────────────────────────────────────────────────────

/**
 * The control, by WHAT IT DOES rather than by what it is called.
 *
 * It was `arm.name === 'empty-stage'` for an afternoon, which is right for
 * `DEFAULT_ARMS` and wrong for anybody's `--arms` file: rename the row and the
 * control silently becomes an ordinary arm, gets counted into the sum it is
 * supposed to BOUND, and the verdict goes quiet. `hide` containing `*` is the
 * thing that makes it a control, so that is what this asks.
 */
const isEmptyStage = (arm) => (arm.hide ?? []).includes('*')

/** An arm that SHOWS one group rather than taking one away. */
const isAdditive = (arm) => (arm.solo ?? []).length > 0

/**
 * The stage group an arm is about, so the two directions can be PAIRED.
 *
 * By the group, never by the arm's name: `no-ocean` and `only-ocean` are two
 * readings of `world-ocean`, and nothing but the key they both name says so.
 * `null` for the empty stage and for a flag arm, which pair with nothing.
 */
const armGroup = (arm) => {
  if (isEmptyStage(arm)) return null
  const solo = (arm.solo ?? [])[0]
  if (solo !== undefined) return solo
  return (arm.hide ?? [])[0] ?? null
}

/**
 * Why the control is NOT a control — DEV-231. `[]` when it is one.
 *
 * ── The comparison this file should always have made ────────────────────
 *
 * Every other arm hides a SUBSET of what the empty stage hides, so every other
 * arm draws a SUPERSET of what the empty stage draws. `control <= arm` is
 * therefore an IDENTITY, on calls and on triangles, for every row in both
 * tables including the baselines — and an arm that draws less than the control
 * is a proof, needing no headset and no second run, that the control failed to
 * hide something that arm did hide.
 *
 * The 2026-09-19 sweep had that proof on disk and printed a table anyway:
 * `only-chunks` came back **179 calls / 0.49 M tris against a control of
 * 203 / 1.44 M**. One `<` would have refused the run. Everything downstream —
 * both tables, the gap column, the FILL-or-FIXED verdict, and the 3.22 ms that
 * was read as 103 % of the model's fixed term — was measured from a control
 * that was drawing the whole of `world-terrain` and the sky.
 *
 * The second question needs no arithmetic at all: the spec now writes what the
 * arm failed to hide, by census key, next to the summary. A non-empty residue
 * on the control is the defect in its own words, and it is checked FIRST
 * because it names the groups while the inequality only proves that some exist.
 *
 * Nothing here is a tolerance and nothing here is a threshold. Both are
 * statements that must hold in any correct run, which is the only kind of
 * assertion worth spending a 34-minute sweep on. *(Trap 24: assert the
 * relationship, not the value.)*
 */
export const controlFailures = (rows) => {
  const control = rows.find((r) => isEmptyStage(r.arm))
  if (!control?.read) return []
  const residue = control.read.residue ?? null
  const out = []
  if (residue !== null && residue.length > 0)
    out.push(
      `the CONTROL still drew ${residue.length} group(s): ` +
        residue.map((r) => `${r.group} (${r.objects} obj, ${r.triangles} tri)`).join(', '),
    )
  const cc = control.read.trace?.calls ?? null
  const ct = control.read.trace?.triangles ?? null
  // A control whose own walk says it drew nothing, under an arm that drew
  // less than it, is not a smaller problem than a control with a residue. It
  // is two instruments contradicting each other about the same frame, and it
  // is worth saying in those words rather than filing one of them.
  const both =
    residue !== null && residue.length === 0
      ? ' (and its residue walk says it drew NOTHING — the two disagree)'
      : ''
  for (const r of rows) {
    if (r === control || !r.read?.trace) continue
    const { calls, triangles } = r.read.trace
    // Whole integers, never the `M` form: the first version of this printed
    // *"1.44M against 1.44M"* for a real 268-triangle shortfall, which reads
    // like a rounding bug rather than like the finding it is.
    if (cc !== null && calls !== null && calls < cc)
      out.push(`${r.arm.name} drew FEWER CALLS than the control — ${calls} against ${cc}${both}`)
    if (ct !== null && triangles !== null && triangles < ct)
      out.push(
        `${r.arm.name} drew FEWER TRIANGLES than the control — ${triangles} against ${ct}${both}`,
      )
  }
  return out
}

/**
 * Does the empty stage say the floor is FILL or FIXED OVERHEAD?
 *
 * The empty-stage arm is the frame with nothing in it: the clear, three's own
 * traversal, two submissions, the MSAA resolve and SteamVR's swapchain. Nothing
 * a content or art decision can reach is in that number.
 *
 *   floorFloor  >= ~2.5 ms   the model's 3.13 ms is mostly FIXED OVERHEAD. No
 *                            art change touches it. The levers left are the
 *                            per-eye pixel count, MSAA, multiview
 *                            (`docs/plan/WEBXR-MODERN.md`) and the compositor —
 *                            and DEV-224/225's scatter work does not move it.
 *   floorFloor  <= ~1.0 ms   the 3.13 ms is FILL, spread over the big surfaces,
 *                            and the ranked arms below say which. Art and
 *                            shader work is on the table.
 *
 * The thresholds are stated so the reader can disagree with them; the number
 * they are applied to is the only thing that is a measurement. Between them is
 * a split answer, which is also a real result and prints as one. Rule 1 of the
 * perf protocol is *print, don't gate*: nothing here passes or fails.
 */
export const verdict = (floorFloor, modelFixed = 3.13) => {
  if (floorFloor === null) return 'no empty-stage reading — the question is unanswered'
  const share = floorFloor / modelFixed
  if (floorFloor >= 2.5)
    return (
      `FIXED PER-FRAME OVERHEAD. ${f2(floorFloor)} ms with NOTHING drawn is ` +
      `${(100 * share).toFixed(0)} % of the model's ${modelFixed} ms fixed term. No art or ` +
      'content decision reaches it; the levers are pixels, MSAA, multiview and the compositor.'
    )
  if (floorFloor <= 1.0)
    return (
      `FILL. Only ${f2(floorFloor)} ms survives an empty stage — ` +
      `${(100 * share).toFixed(0)} % of the model's ${modelFixed} ms — so the floor is ` +
      'fragments, and the ranked arms below say whose. Shader and art work is on the table.'
    )
  return (
    `SPLIT. ${f2(floorFloor)} ms of the model's ${modelFixed} ms fixed term ` +
    `(${(100 * share).toFixed(0)} %) is unreachable overhead and the rest is fill. Both ` +
    'roadmaps are live and the arms below size the half that can be worked on.'
  )
}

/**
 * The attribution table, as text. `echo` is injectable so a unit test can drive
 * the whole report on synthetic rows without printing a sweep into the suite —
 * and, more to the point, so the BRACKET REFUSAL is a thing a test can assert
 * rather than a thing somebody reads once on the night.
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
  const arms = rows.filter((r) => r.arm.name !== BASELINE.name)

  say()
  say('══ DEV-226 · what is in the 3.13 ms floor ══════════════════════════════')
  say(`   mission ${opts.mission} · ${opts.edition} · ${opts.seconds} s per arm`)
  say(`   ${rows.length} runs · ${SPEC}`)
  say()

  // ── the bracket, first, because everything below is measured against it ──
  if (!first || !last || first === last) {
    say('   NO BRACKET — fewer than two baseline runs produced a reading.')
    say('   Nothing below can be attributed. Re-run the sweep.')
    return out.join('\n')
  }
  const drift = Math.abs(last.read.gpu.p50 - first.read.gpu.p50)
  const base = (first.read.gpu.p50 + last.read.gpu.p50) / 2
  const driftP95 = Math.abs(last.read.gpu.p95 - first.read.gpu.p95)
  // Padded rather than spelled, because a box drawn with literal runs of spaces
  // goes crooked the first time a number gains a digit — and this is the one
  // panel in the report that has to be read before anything else is believed.
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
        '      came back 0.01 and 0.02 ms. Something moved under this run — check\n' +
        '      the GPU clocks and the chrome/node counts in the per-arm lines above\n' +
        '      before reading a single row.',
    )
  say()

  // ── the control has to BE a control, and that is checked before it is used ──
  //
  // Second only to the bracket, and for the same reason: everything below is
  // measured from this row, so a control that drew something adds it to all
  // fourteen. This REFUSES rather than annotating — a warning above a full
  // table is read as a caveat on a result, and the 2026-09-19 sweep is the
  // proof: it printed a verdict of *"103 % of the model's fixed term"* off a
  // control that was drawing the whole of `world-terrain`. (DEV-231.)
  const wrong = controlFailures(rows)
  if (wrong.length > 0) {
    say('   ┌─ THE CONTROL IS NOT A CONTROL — NOTHING BELOW IS PRINTED ─────┐')
    box('Every arm is scored against the empty stage, so whatever it')
    box('still drew is added to all of them. Fix the arm, not the')
    box('table: a group that stays visible is usually a per-frame')
    box('`.visible =` write (DEV-231, setHidden in the spec).')
    say(`   └${'─'.repeat(W)}┘`)
    say()
    for (const line of wrong) say(`   · ${line}`)
    say()
    say('   Re-run the sweep. No attribution can be made from these runs.')
    return out.join('\n')
  }

  // ── the control, read first: both tables are measured FROM it ───────────
  const control = rows.find((r) => isEmptyStage(r.arm))
  const empty = control?.read?.gpu?.p50 ?? null
  const emptyCalls = control?.read?.trace?.calls ?? null
  const emptyTris = control?.read?.trace?.triangles ?? null
  // The MEAN of the bracket, which is what the line below already claims to
  // print, and the pair's own drift in each quantity — the noise model the
  // milliseconds have used since this file was written, applied to the two
  // numbers the mechanism check rests on.
  const pair = (pick) => {
    const a = pick(first.read?.trace)
    const b = pick(last.read?.trace)
    if (a === null || a === undefined || b === null || b === undefined)
      return { mean: null, drift: 0 }
    return { mean: (a + b) / 2, drift: Math.abs(b - a) }
  }
  const callsBracket = pair((t) => t?.calls ?? null)
  const trisBracket = pair((t) => t?.triangles ?? null)
  const baseCalls = callsBracket.mean
  const baseTris = trisBracket.mean

  const HEAD =
    '   arm             mechanism       gpu p50   effect   p95      calls     tris   attribution'

  /**
   * One row, scored in the direction its arm was run in.
   *
   * `effect` is `baseline - arm` going down and `arm - empty stage` coming up,
   * so both tables read as *"what this group costs"* and a gap between them is
   * a difference about one quantity rather than about two conventions.
   */
  const scoreRow = (r) => {
    const calls = r.read.trace?.calls ?? null
    const tris = r.read.trace?.triangles ?? null
    const additive = isAdditive(r.arm)
    const effect = additive
      ? empty === null
        ? null
        : r.read.gpu.p50 - empty
      : base - r.read.gpu.p50
    // ── did the arm FIRE? ────────────────────────────────────────────────
    //
    // A `draws` arm has a runtime signature and must show it: going down it
    // must draw LESS than the baseline, coming up it must draw MORE than the
    // empty stage, because a solo that showed nothing is the empty stage
    // wearing a group's name. A `uniform-branch` arm has no signature at all
    // and is marked rather than judged.
    //
    // **Less by CALLS or by TRIANGLES, and each half was load-bearing in the
    // 2026-09-19 run** (DEV-231). Calls alone had just refused a real result
    // and would go on refusing one:
    //
    //   `no-ocean`   calls **+1**, triangles **−1 088 740**. Taking the sea
    //                away changes what streams in behind it, and the land's
    //                call count moves further between two runs than three
    //                ocean meshes do. Read on calls it "did not fire"; a
    //                million triangles had gone.
    //   `no-clouds`  calls **−8**, triangles **0** — the clouds draw no
    //                triangles at all (baseline and no-clouds share a modal
    //                frame of 2 557 760). Read on triangles alone it would
    //                have been the one refused instead.
    //
    // So neither quantity is sufficient and the OR is not a loosening of the
    // rule, it is the rule stated over the evidence that exists. **Re-proved
    // against what the detector was FOR** (DEV-222 §6): the two arms that
    // genuinely did not fire that day — `no-sky` and `no-land`, both undone by
    // a per-frame `.visible =` write — came back **bit-identical to the
    // baseline in both quantities at every quantile**, 264 calls and 2 552 736
    // triangles. An OR still refuses them, and `tests/unit/floor-sweep.test.ts`
    // pins those exact rows so this can never be widened past them by accident.
    //
    // And each half is tested against the BRACKET's own drift in that
    // quantity, not against zero — §3d.2's noise model, which the milliseconds
    // have always used. On a tight box the drift is 0 (it was, in both
    // quantities, across that sweep's two baselines) and the rule is exactly
    // the strict inequality it replaces; on a noisy one it refuses a movement
    // the bracket cannot tell from the room.
    const beat = (from, to, driftOf) =>
      from !== null && from !== undefined && to !== null && to !== undefined && to - from > driftOf
    const proof = []
    if (additive) {
      if (beat(emptyCalls, calls, callsBracket.drift)) proof.push('calls')
      if (beat(emptyTris, tris, trisBracket.drift)) proof.push('tris')
    } else {
      if (beat(calls, baseCalls, callsBracket.drift)) proof.push('calls')
      if (beat(tris, baseTris, trisBracket.drift)) proof.push('tris')
    }
    // A solo cannot draw more than the whole frame does. Kept from the
    // original rule as a sanity bound rather than as the firing test.
    const sane =
      !additive || baseCalls === null || calls === null ? true : calls <= Math.ceil(baseCalls)
    const fired =
      r.arm.mechanism === 'uniform-branch'
        ? 'no runtime proof'
        : proof.length > 0 && sane
          ? 'fired'
          : 'ARM DID NOT FIRE'
    // Which quantity proved it, because `no-ocean` firing on triangles while
    // its calls went UP is a fact about the arm the reader should not have to
    // subtract two columns to find.
    const by = fired === 'fired' ? ` [${proof.join('+')}]` : ''
    const attribution = isEmptyStage(r.arm)
      ? 'THE CONTROL — everything content can reach'
      : effect === null
        ? 'no empty-stage reading — cannot be scored'
        : fired === 'ARM DID NOT FIRE'
          ? 'ARM DID NOT FIRE — not a result'
          : Math.abs(effect) <= drift
            ? `below bracket (${f2(drift)}) — NOT attributable`
            : r.arm.mechanism === 'pass+define'
              ? `${f2(effect)} ms, CONFOUNDED (pass + fragment)${by}`
              : fired === 'no runtime proof'
                ? `${f2(effect)} ms, mechanism unproven at runtime`
                : `${f2(effect)} ms${by}`
    return { effect, calls, fired, attribution }
  }

  const printRow = (r, s) =>
    say(
      `   ${r.arm.name.padEnd(16)}${r.arm.mechanism.padEnd(16)}${f2(r.read.gpu.p50).padStart(7)}` +
        `${f2(s.effect).padStart(9)}${f2(r.read.gpu.p95).padStart(8)}` +
        `${String(s.calls ?? 'n/a').padStart(8)}${mtri(r.read.trace?.triangles).padStart(9)}   ${s.attribution}`,
    )

  const scored = new Map()
  const table = (title, notes, chosen) => {
    say()
    say(`── ${title}`)
    // The whole caveat BEFORE the numbers, never split around them: a reader
    // who takes one table as the answer is the failure this report is shaped to
    // prevent, and they will have stopped reading by the row they wanted.
    for (const n of notes) say(`   ${n}`)
    say()
    say(HEAD)
    say(`   ${'─'.repeat(95)}`)
    for (const r of chosen) {
      if (!r.read?.gpu) {
        say(`   ${r.arm.name.padEnd(16)}${r.arm.mechanism.padEnd(16)}   DID NOT RUN — see ${r.dir}`)
        continue
      }
      const s = scoreRow(r)
      printRow(r, s)
      scored.set(r.arm.name, {
        name: r.arm.name,
        group: armGroup(r.arm),
        additive: isAdditive(r.arm),
        effect: s.effect,
        attributable:
          !isEmptyStage(r.arm) &&
          s.effect !== null &&
          Math.abs(s.effect) > drift &&
          s.fired !== 'ARM DID NOT FIRE',
      })
    }
  }

  const subtractive = arms.filter((r) => !isAdditive(r.arm))
  const additive = arms.filter((r) => isAdditive(r.arm))

  say()
  // `f2` is the millisecond formatter; a draw count is a count. `264.00 calls`
  // is not a more precise 264, it is a unit error in the reader's eye.
  const count = (n) => (n === null ? 'n/a' : Number.isInteger(n) ? String(n) : n.toFixed(1))
  say(
    `   BASELINE ${f2(base)} ms p50, ${count(baseCalls)} calls, ` +
      `${mtri(baseTris)} tris — the mean of the bracket.`,
  )
  // The control's clean bill, said OUT LOUD. A guard that only speaks when it
  // fails is a guard nobody knows ran — and the run that needed this one
  // printed fourteen confident rows and never mentioned the control at all.
  const controlResidue = control?.read?.residue ?? null
  const controlRelit = control?.read?.relit ?? null
  say(
    controlResidue === null
      ? '   CONTROL  residue NOT RECORDED by this run — the empty stage is unverified,\n' +
          '            and only the arithmetic below (control <= every arm) has checked it.'
      : `   CONTROL  the empty stage drew NOTHING — 0 drawable objects left in the stage.${
          controlRelit && Object.values(controlRelit).some((n) => n > 0)
            ? `\n            The game tried to re-show ${
                Object.entries(controlRelit).filter(([, n]) => n > 0).length
              } of them mid-flight; the arm's lock held. (DEV-231.)`
            : ''
        }`,
  )
  table(
    'SUBTRACTIVE — baseline MINUS the group. UNDER-states.',
    [
      'Hiding an occluder hands its pixels to whatever was behind it, which then',
      'shades them, so a hide never recovers the cost of work it was hiding.',
    ],
    subtractive,
  )

  if (additive.length > 0)
    table(
      'ADDITIVE — the group MINUS the empty stage. OVER-states.',
      [
        'Drawn against nothing, a group pays for every pixel it covers with no depth',
        'rejection in front of it, and loses the early-Z its neighbours granted it.',
        'It also carries the SHADOW PASS for its own group alone, so these rows are',
        'not a partition of the frame. `shadows-off` above is what prices that.',
      ],
      additive,
    )

  // ── the two directions, side by side ────────────────────────────────────
  const pairs = []
  for (const s of scored.values()) {
    if (s.group === null || s.additive) continue
    const up = [...scored.values()].find((o) => o.additive && o.group === s.group)
    if (up) pairs.push({ group: s.group, down: s, up })
  }
  // An unpaired row is not an omission and must not look like one. It is
  // computed — and printed — OUTSIDE the `pairs.length > 0` branch, because a
  // sweep where nothing paired at all is exactly the run that most needs to be
  // told so, and the first version of this said nothing in that case.
  const lonely = [...scored.values()].filter(
    (s) => s.group !== null && !pairs.some((p) => p.down === s || p.up === s),
  )
  if (pairs.length > 0 || lonely.length > 0) {
    say()
    say('══ the two directions, and the gap between them ════════════════════════')
  }
  if (pairs.length > 0) {
    say()
    say('   group                      subtractive   additive      gap   reading')
    say(`   ${'─'.repeat(92)}`)
    for (const p of pairs) {
      const d = p.down.effect
      const u = p.up.effect
      const gap = d === null || u === null ? null : u - d
      // Both sides refused by the bracket is not agreement, it is two silences.
      const reading =
        !p.down.attributable && !p.up.attributable
          ? 'neither side clears the bracket — nothing is said here'
          : !p.down.attributable || !p.up.attributable
            ? 'only ONE side clears the bracket — no gap can be read'
            : gap !== null && Math.abs(gap) <= drift
              ? 'the two AGREE — this cost is intrinsic, not occlusion'
              : `truth is between ${f2(Math.min(d, u))} and ${f2(Math.max(d, u))} ms — mostly occlusion`
      say(
        `   ${p.group.padEnd(26)}${f2(d).padStart(11)}${f2(u).padStart(11)}${f2(gap).padStart(9)}   ${reading}`,
      )
    }
    say()
    say('   A group whose two readings AGREE is genuinely that expensive. One where')
    say('   they diverge has a cost that is mostly OCCLUSION RELATIONSHIP — it is')
    say('   expensive because of what it is drawn against, and moving it up or down')
    say('   the draw order is then a lever that deleting it is not.')
  }
  if (lonely.length > 0) {
    say()
    say(`   Run in ONE direction only, so no gap: ${lonely.map((s) => s.name).join(', ')}.`)
    say("   That is deliberate — see DEFAULT_ARMS' header for which was rejected and why.")
  }

  // ── the answer ──────────────────────────────────────────────────────────
  say()
  say('══ what it means ═══════════════════════════════════════════════════════')
  say()
  say(`   EMPTY STAGE      ${f2(empty)} ms   — the frame with nothing drawn`)
  say(`   BASELINE         ${f2(base)} ms   — the same frame with the game in it`)
  if (empty !== null)
    say(`   ATTRIBUTABLE     ${f2(base - empty)} ms   — everything content can reach`)
  say()
  say(`   VERDICT: ${verdict(empty)}`)
  say()

  const sumOf = (wantAdditive) =>
    [...scored.values()]
      .filter((s) => s.attributable && s.additive === wantAdditive)
      .reduce((a, s) => a + (s.effect ?? 0), 0)
  if (empty !== null) {
    const attributable = base - empty
    const down = sumOf(false)
    say(`   The attributable SUBTRACTIVE arms sum to ${f2(down)} ms of ${f2(attributable)} ms.`)
    say('   They are EXPECTED to under-sum, for the reason at the head of that table.')
    if (down > attributable + drift)
      say(
        `\n   !! THE SUBTRACTIVE ARMS OVER-SUM by ${f2(down - attributable)} ms. That direction has\n` +
          '      no benign reading — occlusion can only make hides sum SHORT. Either the\n' +
          '      empty stage did not empty (check its calls column against the baseline),\n' +
          '      or the run drifted inside the bracket rather than across it, which a\n' +
          '      bracket cannot see. Do not file this table.',
      )
    if (additive.length > 0) {
      const up = sumOf(true)
      say()
      say(
        `   The attributable ADDITIVE arms sum to ${f2(up)} ms of the same ${f2(attributable)} ms.`,
      )
      say('   They are expected to OVER-sum, and they are not a partition either — the')
      say('   land is soloed twice (whole, and chunks alone) and the shadow pass rides')
      say('   along with each one. Read the pairs above, not this total.')
      if (up < attributable - drift)
        say(
          `\n   !! THE ADDITIVE ARMS UNDER-SUM by ${f2(attributable - up)} ms, which is the wrong\n` +
            '      direction for this table. Something in the frame is in neither the arms\n' +
            '      nor the empty stage — check the census for a group with no arm.',
        )
    }
  }
  say()
  say('   Confounds carried into these tables, stated rather than hidden:')
  say('   · every hide UNDER-states and every solo OVER-states, by construction.')
  say('     Neither table is the answer on its own; the pair brackets it.')
  say('   · a solo carries the shadow pass for its own group, so the additive rows')
  say('     do not partition the frame.')
  say('   · shadows-off moves a geometry PASS and a fragment DEFINE at once and')
  say('     attributes neither. Wave 3 §5 priced the pair on desert at 2.70 ms;')
  say('     the two environments together separate the halves, neither alone does.')
  say('   · haze, illustrative and sunHeight are NOT ARMS — they are uniform')
  say("     writes with no early-out, so they remove no work. This file's header")
  say('     has the file:line for each. Do not add them back without reading it.')
  say()

  return out.join('\n')
}

// ── the plan, printed before anything runs ───────────────────────────────

const plan = (arms, opts) => {
  const total = arms.length
  const flight = opts.seconds + ARM_OVERHEAD_SECONDS
  const lowMin = Math.round((total * flight) / 60)
  const highMin = Math.round((total * (flight + COOL_MAX_SECONDS)) / 60)
  console.log('DEV-226 floor sweep — attribute the 3.13 ms every level pays')
  console.log(`  mission   ${opts.mission}  (${opts.edition}, ${opts.seconds} s per arm)`)
  console.log(`  spec      ${SPEC}`)
  console.log(`  out       ${opts.outDir}`)
  console.log(`  arms      ${total}, baseline-bracketed at both ends`)
  console.log(
    `  runtime   ~${lowMin} min if the GPU never needs cooling, ~${highMin} min worst case\n` +
      `            (${opts.seconds} s of flight + ~${ARM_OVERHEAD_SECONDS} s boot/load/VR per arm,\n` +
      `            plus up to ${COOL_MAX_SECONDS} s cooling to ${COOL_TO_C} C before each)`,
  )
  console.log()
  console.log('  Before you start:')
  console.log('   1. Install the virtual headset — in ../vr-browser:')
  console.log('        node tools/steamvr-rig.mjs install vrto3d')
  console.log('      and `uninstall vrto3d` afterwards. The Steam Frame will not come')
  console.log('      up while it is installed.')
  console.log('   2. Start SteamVR, and make it the active OpenXR runtime.')
  console.log('   3. Nothing else on this box. Not a fan-out, not `pnpm check` —')
  console.log('      node with 220 test files is CPU starvation and this app measures')
  console.log('      itself and DROPS A TIER (perf-protocol §3a-quater).')
  console.log('   4. Optionally start your own dev server first, so every arm talks to')
  console.log('      one warm process rather than thirteen cold ones:')
  console.log(
    `        E2E_PORT=${process.env.E2E_PORT ?? '5273'} pnpm dev --port ${process.env.E2E_PORT ?? '5273'} --strictPort --host`,
  )
  console.log('      Playwright reuses an existing server outside CI.')
  console.log()
}

// ── main ─────────────────────────────────────────────────────────────────

const main = () => {
  const dryRun = process.argv.includes('--dry-run')
  const armsFile = flag('arms', process.env.FLOOR_ARMS ?? null)
  const opts = {
    mission: flag('mission', process.env.FLOOR_MISSION ?? DEFAULT_MISSION),
    edition: flag('edition', process.env.FLOOR_EDITION ?? 'anniversary'),
    seconds: Number(flag('seconds', process.env.FLOOR_SECONDS ?? String(DEFAULT_SECONDS))),
    outDir: flag('out', process.env.FLOOR_DIR ?? path.join('perf-out', 'floor-sweep')),
    dryRun,
  }
  const chosen = armsFile ? JSON.parse(fs.readFileSync(armsFile, 'utf8')) : DEFAULT_ARMS
  for (const a of chosen) {
    a.mechanism ??= a.hide || a.solo ? 'draws' : 'pass+define'
    a.why ??= ''
  }
  // The bracket is the runner's, not the arm list's — see the header.
  const rows = [BASELINE, ...chosen, BASELINE]

  plan(rows, opts)

  if (!dryRun) refuseIfBusy()

  // A dry run touches nothing on disk — it is the thing you run to check the
  // plan and the clock, and it should leave no trace to tidy up afterwards.
  if (!dryRun) fs.mkdirSync(opts.outDir, { recursive: true })
  const results = []
  for (const [i, arm] of rows.entries()) results.push(run(arm, opts, i + 1, rows.length))

  if (dryRun) {
    console.log('\n── dry run: nothing was measured.')
    return
  }

  const text = report(results, opts)
  fs.writeFileSync(path.join(opts.outDir, 'floor-sweep.txt'), `${text}\n`)
  fs.writeFileSync(
    path.join(opts.outDir, 'floor-sweep.json'),
    `${JSON.stringify({ opts, spec: SPEC, rows: results }, null, 2)}\n`,
  )
  console.log(`   written to ${path.join(opts.outDir, 'floor-sweep')}.{txt,json}`)

  // A refused report is a failed sweep, not a quiet one. The file is written
  // first — the refusal names what went wrong and that is worth keeping — and
  // then the exit code says so, because the operator's next question is
  // *"did that work?"* and a zero would answer it wrong. (DEV-231.)
  if (controlFailures(results).length > 0) process.exit(1)
  if (results.some((r) => !r.skipped && r.status !== 0)) process.exit(1)
}

if (isMain(import.meta.url)) main()
