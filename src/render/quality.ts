// src/render/quality.ts — quality presets, fixed foveated rendering, and the
// thing that spends resolution to protect the frame.
//
// PORT_PLAN M2: *"adaptive resolution ... And `renderer.xr.setFoveation(1)`,
// measured with and without. Fixed foveated rendering is one line and typically
// buys 15–30 % GPU on Quest for a game whose action is centre-screen."* R6 lists
// both, plus *"quality presets from M2"*, as mitigations for Quest 3 standalone
// not holding 72 Hz.
//
// The comfort argument is the one that decides the design, though: R12 is that
// *"a dropped frame during a fast roll is nauseogenic in a way it was not on a
// tethered Rift."* So when the budget runs out, the thing that gives is
// RESOLUTION. Never the frame, and never the vignette.
//
// ── What three.js 0.185.1 will and will not let us change, measured ──────
//
// This is the section to read before changing anything here, because two of the
// three knobs are not live and the API does not say so at the call site.
//
//  - **`renderer.xr.setFoveation(v)` is live in THREE and dead in desktop
//    CHROME.** `three.module.js:14722` writes `fixedFoveation` straight onto
//    the layer that is presenting, but Chrome's projection layer never forwards
//    it to an OpenXR device (`docs/plan/XR-PERF-VS-THREE.md` §3.3). On the
//    shipping path (desktop Chrome through SteamVR), no GPU knob moves
//    mid-session: `requestViewportScale` below is a no-op there too (§4.3).
//    The only resolution lever is the framebuffer scale at session start.
//  - **`renderer.xr.setFramebufferScaleFactor(v)` is NOT.**
//    `three.module.js:14144-14152` stores the value and then, if
//    `isPresenting`, warns *"WebXRManager: Cannot change framebuffer scale while
//    presenting."* — it applies to the NEXT session. So XR base resolution is a
//    session-start decision.
//  - **`renderer.setPixelRatio(v)` is flat-screen only.** It routes through
//    `setSize`, which three refuses while presenting with its own warning. That
//    warning is the one `renderer.ts`'s resize guard exists to suppress — eighty
//    of them in the first seconds of a session, enough to bury a real one.
//
// **Rejected:** reaching past three to call `session.updateRenderState({
// baseLayer: new XRWebGLLayer(...) })` ourselves mid-session. It is legal WebXR
// and it would give live resolution scaling — and three would go on rendering
// into the `glBaseLayer` it still holds a reference to, which is a black
// headset with no error message. Not worth it for a knob that has a working
// substitute.
//
// So, honestly stated: **in an XR session the live degradation path is
// foveation**, which lowers PERIPHERAL resolution — exactly the right thing to
// spend for a game whose action is centre-screen — and the framebuffer scale is
// carried to the next session. On the flat build the pixel ratio moves live.
//
// **That paragraph is INCOMPLETE and has been since DEV-208 — see
// `pushViewportScale` below.** Three knobs were enumerated above, all three
// correctly, and the enumeration was of three.js's `renderer.xr` surface rather
// than of WebXR's. The spec has a fourth, `XRView.requestViewportScale(s)`,
// which three does not wrap and does not need to: it re-reads the per-view
// viewport every frame, so the request reaches the compositor without a line of
// three being patched. It is live, it is the whole image rather than the
// periphery, and it is worth an estimated ~3.1 ms worn. DEV-208 found it and
// aimed it at the wrong object; DEV-236 aims it at the view.
//
// ── And what "carried to the next session" must NOT mean (DEV-178) ────────
//
// Carried means the TIER — `QUALITY[quality].framebufferScale`, the number the
// player chose in the comfort menu — and nothing else. It cost a worn session
// to learn that, on 2026-09-17:
//
// `applyBeforeSession()` used to push `tier × ADAPTIVE_STEPS[stepIndex]`, and
// the step it multiplied by was the FLAT one. The loading screen is a
// vsync-locked flat page, which sits BETWEEN the controller's two bands — a
// 60 Hz screen delivering 16.7 ms frames against a 16.7 ms budget is neither
// over by 8 % nor under by 22 % — so `overSeconds` and `underSeconds` both
// reset every frame and the index could go down (on the load's own hitches) and
// never come back up. It reached the 0.6 floor and stayed there for 99.9 % of
// 29,038 frames. Enter VR, and three built the layer at 0.6 × recommended:
// **3522 × 1761, i.e. 1761 per eye on a 2160 panel**, with
// `getNativeFramebufferScaleFactor` reading 1. Every GPU number that session
// was taken at roughly a third of the pixels the headset was asking for.
//
// Two halves to the fix, and the second is the one that generalises:
//
//  1. The XR base scale is the TIER alone. The adaptive step multiplies the
//     FLAT pixel ratio only, which is the one surface where it is live anyway —
//     see `pushPixelRatio` against `applyBeforeSession`. A controller cannot
//     leak a measurement from one display into the base resolution of another.
//  2. The controller RESETS on `sessionstart` and on `sessionend`, so a
//     session's `engaged` fraction is that session's. M3's exit criterion is
//     *"engaged on no more than 20 % of frames"*, and a counter that had
//     already spent 29,000 frames on a loading screen answers a question
//     nobody asked.
//
// And then a third thing, because the first two would otherwise leave the flat
// build stuck at whatever step the load left it on: a step UP is now reachable
// from the MIDDLE band too, on a longer sustain. See `CLIMB_SUSTAIN_SECONDS`.
//
// ── And that third thing only worked on a frame time that never varies (DEV-228)
//
// The middle-band climb was written against a vsync-locked flat page and tested
// against one: a `dt` that is the same number every frame, for ever. On that
// stream the EMA is a flat line, so it never crosses `downFactor` and
// `meetingSeconds` only ever counts up — the climb fires at exactly
// `CLIMB_SUSTAIN_SECONDS`, every time, on every run. No display produces that
// stream.
//
// What a display produces is BIMODAL. A compositor holds the app in a tier for
// a run of frames and then lets go: worn on a Steam Frame, and on the VRto3D
// rig, the intervals cluster at ~11 ms and ~22 ms, and the EMA of that walks
// back and forth across the down band every second or two. `meetingSeconds` was
// zeroed outright by ANY frame above the line, so a counter that needs three
// CONSECUTIVE seconds never got there. Measured by replaying the recorded `dt`
// columns back through `stepAdaptive`: the longest run it ever accumulated was
// **1.98 s against the 3 s it needs**, and the controller sat on `ADAPTIVE_STEPS`'
// 0.6 floor for 2,763 worn frames and for every frame of three 60 s rig traces,
// with `climbFailures` still 0 — it never even got as far as failing.
//
// The cause was an inconsistency rather than a tuning error. *A hitch is not a
// trend* is the rule the step DOWN already follows: it will not act on less than
// `sustainSeconds` of over-budget. The climb treated the SAME single frame as
// decisive. So one bad frame could not move the resolution down and could veto
// it moving up, for ever — and a machine stalling 2 % of the time was pinned at
// the floor exactly as hard as one missing every frame.
//
// `meetingSeconds` is now cleared only by the step DOWN, which is the evidence
// that actually moves the controller. See the band block in `stepAdaptive`.

import type * as THREE from 'three'
import { type ComfortSettings, type QualitySetting, qualityInForce } from '@/boot/settings'

export interface QualitySpec {
  /**
   * XR base framebuffer scale. 1.0 is the runtime's own recommended
   * resolution, which on a Quest 3 browser is already below the panel's native
   * count — so this is a multiplier on a number the runtime chose, not on the
   * hardware.
   */
  readonly framebufferScale: number
  /**
   * Flat-screen device-pixel-ratio ceiling. `high`'s 2 is exactly what
   * `renderer.ts` shipped before this file existed, so `high` changes nothing
   * for anyone who never opens the menu.
   */
  readonly pixelRatioCap: number
  /**
   * Multisampling. DEV-165.
   *
   * `renderer.ts` has always passed `antialias: true`, chosen when the only
   * surface was a 1280 x 720 canvas. In a session that one boolean becomes
   * three's `samples: attributes.antialias ? 4 : 0` on the XR projection layer
   * (`three.module.js:14365`) — so on the Steam Frame it is a **5032 x 2516
   * four-sample** colour target plus a four-sample depth buffer, resolved to
   * the runtime's texture every frame. Nothing ever chose that; it was
   * inherited.
   *
   * It is a CONTEXT ATTRIBUTE, so it is fixed for the life of the WebGL
   * context: a tier change takes effect on the next load, exactly as
   * `framebufferScale` takes effect on the next session. The comfort row says
   * so.
   *
   * Only `low` is false today. `medium` waits on a headset A/B — three offers
   * 4 or 0 and nothing between, so "2x" is not on the menu and the middle tier
   * has to pick a side.
   */
  readonly msaa: boolean
  /**
   * The flat-only spending. `null` on every tier but `ultra` (DEV-581).
   *
   * Never read directly: ask {@link ultraFor}, which resolves the tier IN FORCE
   * first, so a headset presenting under a stored `ultra` gets `null` here and
   * every feature behind it stays off without one of them having to remember.
   */
  readonly ultra: UltraSpec | null
}

/**
 * What `ultra` spends that `high` does not. DEV-581, docs/plan/ULTRA.md.
 *
 * `renderTargetMpx` is consumed by `pushPixelRatio`, and `seaReflection` by
 * `render/sea-reflection.ts` (DEV-583). `lodMultiplier` is the plumbing DEV-586
 * will read, through {@link ultraFor}. DEV-581 also carried a `nearCascade`
 * flag; DEV-583 deleted it, because DEV-582 shipped the near cascade as an
 * edition feature for every tier and nothing ever read it.
 */
export interface UltraSpec {
  /**
   * The flat frame's PIXEL TARGET, in megapixels, not a ratio. The flat pixel
   * ratio becomes `clamp(sqrt(target / cssPixels), min(dpr, cap), cap)`
   * ({@link ultraPixelRatio}): at least what `high` gives, at most the cap, so
   * a 1440p monitor supersamples by 1.5x, a 1080p one by 2x, and a 4K screen
   * gets no more than it already had. The adaptive controller steps down from
   * there unchanged.
   *
   * 8.2944 is a 3840 x 2160 frame EXACTLY. The plan's first guess was 8.3, and
   * 8.3 gives a 4K screen a ratio of 1.0003: three floors the drawing buffer to
   * 3841 px for a 3840 px canvas, and the browser resamples the whole frame by
   * one pixel, which is a blur that buys nothing. At 8.2944 a 4K screen lands
   * on 1 and a 2560 x 1440 one on 1.5, both exact.
   */
  readonly renderTargetMpx: number
  /**
   * DEV-583: the sea reflects the scene again (2016's realtime reflection),
   * flat only, and only where the edition's `render.seaReflection` is on.
   * Read by `render/sea-reflection.ts`'s `seaReflectionFor`.
   */
  readonly seaReflection: boolean
  /**
   * DEV-586: the multiplier on the terrain's and the props' `lodDistance`.
   * First guess 2. Not read yet; DEV-586 waits on DEV-193.
   */
  readonly lodMultiplier: number
}

/**
 * `medium`'s XR scale is 0.75, Matt's call on 2026-09-23 ("knock med to .75
 * plz"), down from 0.85. It follows the first worn capture that compared eye
 * sizes on one build (`docs/perf-baseline.md`, "the props did not get more
 * expensive"): at 2160 px an eye the 2016 scatter holds 90 Hz on 1–18 % of
 * frames, and at `low`'s 1512 on 75–98 %. 0.75 is 1620 px on the Steam Frame,
 * 1.15× `low`'s pixels and 0.56× `high`'s. It has not been worn yet.
 */
export const QUALITY: Readonly<Record<QualitySetting, QualitySpec>> = {
  low: { framebufferScale: 0.7, pixelRatioCap: 1, msaa: false, ultra: null },
  medium: { framebufferScale: 0.75, pixelRatioCap: 1.5, msaa: true, ultra: null },
  high: { framebufferScale: 1, pixelRatioCap: 2, msaa: true, ultra: null },
  // DEV-581. `framebufferScale` is `high`'s and is never read: the tier
  // resolves to `high` while presenting (`qualityInForce`), and the XR scale is
  // only ever asked for the headset's tier. The cap is `high`'s 2: ultra
  // supersamples a monitor UP TO that, it does not raise it. MSAA stays 4x.
  ultra: {
    framebufferScale: 1,
    pixelRatioCap: 2,
    msaa: true,
    ultra: { renderTargetMpx: 8.2944, seaReflection: true, lodMultiplier: 2 },
  },
}

/**
 * The spec of the tier IN FORCE: the player's, AUTO resolved per surface, and
 * `ultra` resolved to `high` while presenting. DEV-581.
 *
 * Pass the PINNED settings (`boot/quality-pin.ts`'s `applyQualityPins`), as
 * `app.ts` does for the report: a `?quality=` pin is the tier in force.
 */
export const qualitySpecFor = (
  s: Pick<ComfortSettings, 'quality' | 'qualityAuto'>,
  presenting: boolean,
): QualitySpec => QUALITY[qualityInForce(s, presenting)]

/**
 * Is ultra in force right now, and with what? `null` when it is not. DEV-581.
 *
 * THE question every ultra feature asks (the sea reflection, the draw
 * distance, anything later), and the only one. The `detailRingFor` pattern
 * (`game/terrain/detail-ring.ts`): a pure function of the settings and
 * `presenting`, read LIVE every time it matters and never cached, because the
 * tier flips from the pause menu and a headset can start presenting mid-run.
 * While presenting it is always `null`, so no ultra feature can reach a
 * headset; that is one line in `qualityInForce` and a unit test holds it.
 */
export const ultraFor = (
  s: Pick<ComfortSettings, 'quality' | 'qualityAuto'>,
  presenting: boolean,
): UltraSpec | null => qualitySpecFor(s, presenting).ultra

/**
 * The flat pixel ratio under ultra, before the adaptive step. DEV-581.
 *
 * `clamp(sqrt(target / cssPixels), min(dpr, cap), cap)`. The floor is what
 * the same cap gives without a target (`high`'s answer on this screen), so
 * ultra never renders fewer pixels than `high`; the ceiling is the cap.
 * A `want` within {@link ULTRA_SNAP_RATIO} of the floor snaps to the floor.
 * Pure, and exported so the arithmetic is a unit test without a canvas.
 */
export const ultraPixelRatio = (
  ultra: UltraSpec,
  cap: number,
  dpr: number,
  cssPixels: number,
): number => {
  const floor = Math.min(dpr, cap)
  if (!(cssPixels > 0)) return floor
  const want = Math.sqrt((ultra.renderTargetMpx * 1e6) / cssPixels)
  if (want < floor * ULTRA_SNAP_RATIO) return floor
  return Math.min(cap, want)
}

/**
 * Below this multiple of the floor, ultra renders AT the floor. DEV-581.
 *
 * A near-native ratio (a windowed 4K browser wants about 1.03) resamples the
 * whole frame for almost no extra pixels, which softens it and buys nothing.
 */
export const ULTRA_SNAP_RATIO = 1.25

/**
 * Whether this load builds a multisampled context, given the tier and the pin.
 *
 * The one place that decision is made, so `renderer.ts` carries no policy and
 * a test can assert the mapping without a canvas. `?aa=` overrides the tier,
 * which is what makes the same-tick A/B in `docs/testing/perf-protocol.md`
 * possible at all: MSAA cannot be flipped on a live context, so the two sides
 * of that pair are two loads and the switch has to live in the URL.
 */
export const msaaFor = (quality: QualitySetting, pin: boolean | null = null): boolean =>
  pin ?? QUALITY[quality].msaa

/**
 * `setFoveation`'s argument for on and off.
 *
 * 1 is PORT_PLAN M2's number — *"maximum foveation (the edges render at lower
 * resolution)"* in three's own words. **three's default is ALREADY 1.0**
 * (`three.module.js:13915`), so the plan's "one line" has been in effect since
 * the renderer was written.
 *
 * **On desktop Chrome it buys nothing at all.** Chrome's projection layer
 * stores `fixedFoveation` and never forwards it to the device, and no
 * foveation extension exists anywhere in its OpenXR sources
 * (`docs/plan/XR-PERF-VS-THREE.md` §3.3). This said *"the 15–30 % was never
 * not being spent"*; nothing was being spent, and the 15–30 % is a Quest
 * Browser figure. It stays a setting because a Quest-style runtime would honour
 * it, and because the OFF arm is still the cheap way to CONFIRM the dead knob
 * worn: fly the same gate twice and expect identical frames.
 */
export const FOVEATION_ON = 1
export const FOVEATION_OFF = 0

/**
 * The steps adaptive resolution walks. Multipliers on the preset's base.
 *
 * Coarse and few: a continuously-varying resolution is its own artifact — the
 * whole image softens and sharpens as you fly — and five steps with a hold
 * between them reads as a stable image that occasionally changes.
 */
export const ADAPTIVE_STEPS: readonly number[] = [1, 0.9, 0.8, 0.7, 0.6]

/** Quest 3's browser default, and M3's exit target. */
export const DEFAULT_TARGET_HZ_XR = 72
/** A flat browser with vsync. Not measured; the flat build is not the budget. */
export const DEFAULT_TARGET_HZ_FLAT = 60

/**
 * Where the frame budget came from. Printed, and carried on every reading.
 *
 * VR-PERF §5.3 / DEV-160. A budget with no provenance is the shape of mistake
 * the port has paid for before (CLAUDE.md: *a derived number needs the same
 * provenance discipline as an extracted one*). A p95 of 13 ms is a pass at
 * 72 Hz and a fail at 90, so a reading filed against a GUESSED 72 while the
 * headset ran at 90 is not a slightly-wrong number, it is the wrong verdict.
 *
 *  - `override` — `?perf`-adjacent test injection, `QualityOptions.targetHz`.
 *  - `session` — `XRSession.frameRate`, the runtime's own answer. Meta's
 *    extension: absent from `XRSession.prototype` on desktop Chrome entirely.
 *  - `measured` — the modal frame interval (`perf-recorder.ts`'s `modalHz`).
 *    On this desktop rig this is the ONLY correct source.
 *  - `default` — `DEFAULT_TARGET_HZ_XR`, i.e. nobody knows. A reading stamped
 *    with this is a reading to distrust.
 *  - `flat` — not presenting; the flat build's vsync assumption.
 */
export type TargetSource = 'override' | 'session' | 'measured' | 'default' | 'flat'

/**
 * How much of the window must agree before a measured rate is believed.
 *
 * 0.6 is deliberately loose. The rig this was written for is a STREAMED
 * headset, where the encoder and the network put jitter into the interval that
 * a tethered display does not have, and a threshold tuned on a monitor would
 * refuse the measurement exactly where it is the only source there is. The
 * protection against a bad reading is not a tighter threshold, it is that the
 * source is printed and carried: a budget from a 0.61 share is visible as such.
 */
export const MEASURED_MIN_SHARE = 0.6

/**
 * How many frames the reading must be taken over.
 *
 * 48 is about half a second at 90 Hz, so the measured budget engages within the
 * first second of a session rather than after the recorder's whole 3 s window —
 * which matters because the first seconds are when the programs compile and the
 * frames are at their worst, and a controller judging those against a guessed
 * 72 while the headset runs at 90 would step the resolution down on arrival.
 */
export const MEASURED_MIN_FRAMES = 48

/** What `QualityOptions.measuredHz` returns — `perf-recorder.ts`'s `ModalHz`. */
export interface MeasuredHz {
  readonly hz: number
  readonly share: number
  readonly frames: number
  /** `perf-recorder.ts`'s `HzCandidate[]`. Optional so an old fake still types. */
  readonly candidates?: readonly { readonly hz: number; readonly share: number }[]
}

/**
 * The sub-multiples a compositor drops to. Half rate and third rate.
 *
 * DEV-161, and these are not a guess: SteamVR's reprojection tiers of a 90 Hz
 * display are 45 and 30, exactly, and the worn session read both — 45 as the
 * mode on lap 1 and 30 on lap 2. A tier is a DIVISION of the display's frame,
 * which is why the test is a ratio and not a list of rates.
 */
export const TIER_DIVISORS: readonly number[] = [2, 3]

/**
 * How far off an exact half or third a candidate may sit and still be that tier.
 *
 * 6 %, and it is bounded from both sides. Below it: a streamed headset's
 * interval jitters, 45 Hz is not in `KNOWN_REFRESH_HZ` so it keeps its raw
 * integer bin, and a reading of 44 or 46 must still be recognised as half of
 * 90. Above it: 90/2 = 45 must never be confused with 60, the nearest real
 * display rate, which is 33 % away — so anything up to about 15 % would still
 * be safe and 6 % leaves the margin visible.
 */
export const TIER_RATIO_TOLERANCE = 0.06

/**
 * How long a different budget must hold before it replaces the one in force.
 *
 * DEV-161. The worn session's console printed the budget line ~60 times in one
 * lap because the resolver flipped between `measured 45` and `default 72` on
 * every 3 s window, as the mode's share crossed 0.6 and came back. The rule
 * above is what fixes THAT flap — a display and its tier together hold a
 * combined share near 1.0, which does not hover — and this is the guard for
 * the ones no rule catches.
 *
 * **What it does NOT do, stated because the number invites the wrong reading:**
 * 2 s cannot stop a flap whose period is 3 s. A candidate that holds for three
 * seconds HAS held for two, so it is adopted, and a genuine 3 s alternation
 * would still move the budget every window. What this filters is wobble
 * SHORTER than itself — the common case, since `modalHz` reads a sliding 3 s
 * window and a single hitch moves it for a fraction of a second. Raising it
 * past the recorder's own window would mean a budget that cannot follow a real
 * change of refresh rate, which is worse.
 *
 * DEV-179 is the other half of that sentence, and it is why raising this number
 * is never the fix: the flap lap 4 produced has a period of SECONDS, so no
 * hysteresis can filter it. What removes it is `stickyDisplayHz` below — the
 * display's rate is a fact about the SESSION, not about a 3 s window, and a
 * window that cannot see 90 Hz is not evidence that the display stopped being
 * 90 Hz.
 */
export const BUDGET_ADOPT_SECONDS = 2

/**
 * How different a budget must be to count as a change at all. 3 %.
 *
 * The same tolerance `perf-recorder.ts` snaps refresh rates with, deliberately:
 * two numbers that would snap to the same display are the same budget, and a
 * hysteresis clock that restarted on a difference smaller than the measurement
 * it is made of would never finish.
 */
export const BUDGET_CHANGE_TOLERANCE = 0.03

/**
 * What the measured interval says about the display and about us.
 *
 * The pair is the point (DEV-161). `displayHz` is the DISPLAY's frame — the
 * thing the app has to get under to leave a tier — and `tierHz` is the rate
 * frames are actually arriving at. Worn 2026-09-17: 90 and 45. The budget is
 * the first one, always: judging against 22.2 ms because that is what we are
 * getting would declare a half-rate session comfortable and remove every
 * reason to fix it.
 */
export interface DisplayRate {
  /** The display's own rate. The budget is `1 / displayHz`. */
  readonly displayHz: number
  /** The rate frames are arriving at — the largest share in the family. */
  readonly tierHz: number
  /** Fraction of the window's frames that arrived BELOW the display rate. */
  readonly dropping: number
  /** Combined share of the display and its tiers. The confidence in the pair. */
  readonly share: number
}

/**
 * Read a display rate out of a measured interval, or refuse to.
 *
 * Returns null when nothing in the window reaches `MEASURED_MIN_SHARE` — which
 * is the honest answer for a machine with no steady rate at all, and leaves the
 * caller to label the budget `default`.
 *
 * The rule, in one sentence: **if a rate R and a rate at about R/2 or R/3 are
 * both in the window, the display is R and we are dropping.** Exported and pure
 * so it can be scripted against the worn numbers; `quality.ts` is the only
 * caller.
 */
export const resolveDisplayRate = (measured: MeasuredHz | null): DisplayRate | null => {
  if (!measured || !(measured.hz > 0)) return null
  const candidates =
    measured.candidates && measured.candidates.length > 0
      ? measured.candidates
      : [{ hz: measured.hz, share: measured.share }]

  const isTierOf = (display: number, hz: number): boolean =>
    TIER_DIVISORS.some((d) => Math.abs(hz - display / d) <= (display / d) * TIER_RATIO_TOLERANCE)

  // Highest rate first, because the DISPLAY is the fastest thing in the family
  // by construction. Taking the largest share first would pick 45 on the worn
  // data and produce exactly the verdict this rule exists to avoid.
  const byHz = [...candidates].sort((a, b) => b.hz - a.hz)

  for (const display of byHz) {
    const family = candidates.filter((c) => c.hz === display.hz || isTierOf(display.hz, c.hz))
    if (family.length < 2) continue
    const share = family.reduce((sum, c) => sum + c.share, 0)
    if (share < MEASURED_MIN_SHARE) continue
    const tier = family.reduce((best, c) => (c.share > best.share ? c : best), family[0] as HzShare)
    const dropping = family.reduce((sum, c) => (c.hz < display.hz ? sum + c.share : sum), 0)
    return { displayHz: display.hz, tierHz: tier.hz, dropping, share }
  }

  // No family: the mode is the display and we are getting every frame of it.
  if (measured.share < MEASURED_MIN_SHARE) return null
  return { displayHz: measured.hz, tierHz: measured.hz, dropping: 0, share: measured.share }
}

type HzShare = { readonly hz: number; readonly share: number }

/**
 * Is `hz` a compositor SUB-RATE of `display` — the display's frame divided by a
 * whole number, two or more? DEV-179.
 *
 * The divisor is derived rather than searched (`round(display / hz)`), and the
 * tolerance is `TIER_RATIO_TOLERANCE` measured against the TIER's own rate,
 * exactly as `resolveDisplayRate`'s `isTierOf` measures it. That relative form
 * is what makes an unbounded divisor safe: the window a candidate has to land
 * in shrinks with the tier, so `k` can be 4 without the test going slack.
 *
 * Wider than `TIER_DIVISORS` on purpose, and the reason is the one number that
 * separates the two callers. `TIER_DIVISORS` answers *which tier is SteamVR
 * holding us in* — half and third, measured. This answers a weaker question:
 * *could this window be us, inside a tier of the display we already know
 * about?* Lap 4's window carried bins at 22 and 23 against a 90 Hz display,
 * which is a quarter, and a rule that admitted only halves and thirds would
 * read a window whose mode landed there as a 22 Hz DISPLAY and throw the
 * session's knowledge away.
 *
 * The case it must NOT admit is the one that separates it from "anything
 * slower": 72 against a 90 Hz sticky gives `k = round(1.25) = 1`, and 60 gives
 * `k = 2` with 60 fifteen Hz away from 45. Neither is a sub-rate, and both are
 * a display whose refresh genuinely changed under a running session — which
 * SteamVR can do and which the budget has to follow.
 */
export const isSubRateOf = (display: number, hz: number): boolean => {
  if (!(display > 0) || !(hz > 0) || hz >= display) return false
  const k = Math.round(display / hz)
  if (k < 2) return false
  const tier = display / k
  return Math.abs(hz - tier) <= tier * TIER_RATIO_TOLERANCE
}

/**
 * The display rate in force, given the pin, what the session already knows and
 * what this window can see. DEV-179.
 *
 * **A display's refresh rate does not change because we stopped hitting it.**
 * `resolveDisplayRate`'s family rule needs both R and R/2 inside one 3 s window
 * to name R, and on lap 4 the app spent whole windows entirely inside the 30 Hz
 * tier: candidates `30 @ 0.65` with `45 / 22 / 23` beside it and **no 90 at
 * all**. No family reaches `MEASURED_MIN_SHARE`, so the resolver falls through
 * to its last rule — *the mode is the display and we are getting every frame of
 * it* — and returns `displayHz: 30`, a budget of 33.3 ms, and a report that the
 * app has three times the headroom it has. At the exact moment it has least.
 *
 * So the display rate is a fact about the SESSION, and this is where that is
 * applied. Pure, and separate from the resolver, because the resolver answers
 * about a WINDOW — two different questions that were being asked with one call.
 *
 * Three ways the session's rate can move, and only the first two lower it:
 *
 *  1. A pin. `?hz=` wins outright, including over a higher measurement: a pin
 *     is an instruction and a measurement is an inference.
 *  2. A window naming a rate that is NOT a sub-rate of the one we hold. That is
 *     a display whose refresh changed — SteamVR can do it under a running
 *     session — and the budget has to follow it down as well as up. This is the
 *     half that keeps DEV-161's *"a change that holds is adopted"* true.
 *  3. A window naming a HIGHER rate, which is simply better evidence.
 *
 * A window naming a sub-rate changes nothing: that is us in a tier, which is
 * the state the budget most needs to be right in and the one where the naive
 * reading is worst.
 *
 * @param pinned `?hz=`, or null.
 * @param sticky the display rate adopted so far this session. 0 before the first.
 * @param window what `resolveDisplayRate` made of this window, or 0 for none.
 */
export const stickyDisplayHz = (pinned: number | null, sticky: number, window: number): number => {
  if (pinned !== null && pinned > 0) return pinned
  if (!(sticky > 0)) return window > 0 ? window : 0
  if (!(window > 0)) return sticky
  if (window >= sticky) return window
  return isSubRateOf(sticky, window) ? sticky : window
}

export interface AdaptiveConfig {
  /** Frame budget, seconds. `1 / targetHz`. */
  readonly targetSeconds: number
  /** Step DOWN when the smoothed frame time exceeds the budget by this much. */
  readonly downFactor: number
  /** Step UP only when it is this far UNDER, which is what stops oscillation. */
  readonly upFactor: number
  /** Smoothing time constant, seconds. */
  readonly emaTau: number
  /**
   * How long the smoothed frame time must stay on ONE side of the budget before
   * anything moves. A hitch is not a trend.
   */
  readonly sustainSeconds: number
  /**
   * How long the smoothed frame time must sit AT or under the budget — not
   * comfortably under it — before a step up. See `CLIMB_SUSTAIN_SECONDS`.
   */
  readonly climbSustainSeconds: number
  /**
   * How many times the middle-band climb may double its wait after failing.
   * See `CLIMB_BACKOFF_MAX`.
   */
  readonly climbBackoffMax: number
  /**
   * Frames longer than this many budgets are recorded AS this many.
   *
   * A 250 ms frame is not a measurement of rendering cost, it is a stall — a
   * geometry upload, a GC, a tab coming back from the background. Fed in whole
   * it dominates the average for the next two seconds and the average stops
   * being about the renderer. Clamping the SAMPLE keeps the outlier's duration
   * (it still counts toward `overSeconds`, because a quarter of a second really
   * did elapse badly) while keeping its magnitude out of the mean.
   */
  readonly sampleCapFactor: number
}

/**
 * `downFactor` 1.08 and `upFactor` 0.78 are deliberately NOT symmetric, and the
 * gap between them is the hysteresis: a system that steps down at 1.0 and back
 * up at 1.0 spends its life on the boundary, changing resolution every second.
 * The 0.3 of budget between them means a step up only happens when there is
 * room for the step to survive.
 *
 * `sustainSeconds` 1.5 is longer than it looks necessary. A first pass used it
 * as a cooldown — "at least this long since the last step" — and the test for a
 * single hitch found the hole in that immediately: after ten quiet seconds the
 * cooldown is long expired, so ONE 250 ms frame drops the resolution a step.
 * A geometry upload, a GC and a terrain chunk swap all look exactly like that,
 * so the image would go soft every time a chunk crossed a LOD boundary. The
 * condition has to PERSIST, not merely occur.
 */
/**
 * How long the frame time must sit AT the budget before the controller climbs.
 *
 * DEV-178. The 0.78 fast path above is unreachable on a display that paces us:
 * a vsync-locked screen hands back one budget per frame, exactly, for ever. Its
 * EMA lands in the middle band, both counters reset every frame, and the
 * controller can only ever go DOWN — which is how a loading screen walked the
 * resolution to its floor and held it there for 29,000 frames.
 *
 * So the middle band climbs too, and 3 s rather than `sustainSeconds`' 1.5 is
 * the whole of the hysteresis on it. The fast path is evidence that the machine
 * has 22 % of the frame spare and the step will survive; the middle band is
 * evidence of nothing except that the frame is being MET at the current
 * resolution, and a step up is a bet that it would also be met at a higher one.
 * Twice the wait is the price of a bet against a weaker signal — and the
 * backoff below is what happens when the bet loses.
 */
export const CLIMB_SUSTAIN_SECONDS = 3

/**
 * How many times a failed middle-band climb doubles its next wait. 4 → 16×.
 *
 * Without it the middle-band climb is a metronome: a machine that is exactly at
 * budget at step N and over it at step N−1 climbs after 3 s, blows the budget,
 * drops back after 1.5, and repeats every 4.5 seconds for the whole session —
 * the image breathing, which is precisely the artifact `upFactor`'s asymmetry
 * exists to prevent. Doubling after each failure turns thirteen changes a minute
 * into four, then one, then none: it SETTLES rather than ping-pongs, and it is
 * still able to find a genuinely faster machine because the fast path clears the
 * counter (real headroom is a different observation, not a louder one).
 *
 * 4 caps the wait at 48 s, which is long enough to be invisible in a session and
 * short enough that a machine that recovers after a minute is not written off.
 */
export const CLIMB_BACKOFF_MAX = 4

export const DEFAULT_ADAPTIVE: Omit<AdaptiveConfig, 'targetSeconds'> = {
  downFactor: 1.08,
  upFactor: 0.78,
  emaTau: 0.5,
  sustainSeconds: 1.5,
  climbSustainSeconds: CLIMB_SUSTAIN_SECONDS,
  climbBackoffMax: CLIMB_BACKOFF_MAX,
  sampleCapFactor: 4,
}

export interface AdaptiveState {
  /** Smoothed frame time, seconds. `0` until the first frame. */
  ema: number
  /** Index into `ADAPTIVE_STEPS`. 0 is full resolution. */
  stepIndex: number
  /** Seconds the EMA has been continuously OVER budget. Reset by any let-up. */
  overSeconds: number
  /** Seconds it has been continuously under it, with headroom to spare. */
  underSeconds: number
  /**
   * Seconds spent AT or under budget — the middle band and the under band
   * together — SINCE THE LAST STEP DOWN. The vsync-locked climb; see
   * `CLIMB_SUSTAIN_SECONDS`.
   *
   * A superset of `underSeconds`, deliberately: a run that dips into real
   * headroom and back out has still been meeting its frame throughout, and
   * resetting this on the way out would make the two paths fight.
   *
   * **Not "continuously", and DEV-228 is the whole of that word.** It stops
   * ADVANCING while the frame is being missed, but a momentary excursion no
   * longer zeroes it — only a step down does, which is the same threshold the
   * controller needs before it will act on over-budget frames in the other
   * direction. Read the DEV-228 section of this file's header before
   * reinstating a reset here: a strictly-consecutive counter is unreachable on
   * every real display, and this one was, for 2,763 worn frames.
   */
  meetingSeconds: number
  /**
   * How many middle-band climbs in a row have been undone by a step down.
   * The exponent in `CLIMB_BACKOFF_MAX`'s doubling. Cleared by the fast path.
   */
  climbFailures: number
  /** Was the LAST step a step up? How a failed climb is recognised. */
  lastStepWasUp: boolean
  /** Frames seen, and frames seen while below full resolution. */
  frames: number
  /**
   * Frames spent below full resolution.
   *
   * This is not telemetry decoration: M3's exit is *"72 Hz with
   * `AdaptiveResolution` engaged on no more than 20 % of frames"*, and a
   * criterion nobody can compute is a criterion nobody checks. `engagedFraction`
   * is the number that criterion asks for.
   */
  engagedFrames: number
}

export const createAdaptiveState = (): AdaptiveState => ({
  ema: 0,
  stepIndex: 0,
  overSeconds: 0,
  underSeconds: 0,
  meetingSeconds: 0,
  climbFailures: 0,
  lastStepWasUp: false,
  frames: 0,
  engagedFrames: 0,
})

/**
 * Put a state back to where `createAdaptiveState` starts, IN PLACE.
 *
 * In place because the controller closes over exactly one of these and every
 * reader (`adaptiveScale`, `engagedFraction`, `report`) reads that object —
 * reassigning a fresh one would leave `report`'s closure on the old.
 *
 * DEV-178: called on `sessionstart` and on `sessionend`. A session and the flat
 * page that launched it are different displays with different budgets, and the
 * evidence from one is not evidence about the other. It is the same argument
 * `stepAdaptive` already makes about a single step ("the history is void after
 * a step"), one level up.
 */
export const resetAdaptiveState = (state: AdaptiveState): void => {
  const fresh = createAdaptiveState()
  state.ema = fresh.ema
  state.stepIndex = fresh.stepIndex
  state.overSeconds = fresh.overSeconds
  state.underSeconds = fresh.underSeconds
  state.meetingSeconds = fresh.meetingSeconds
  state.climbFailures = fresh.climbFailures
  state.lastStepWasUp = fresh.lastStepWasUp
  state.frames = fresh.frames
  state.engagedFrames = fresh.engagedFrames
}

/** The multiplier the state currently asks for. */
export const adaptiveScale = (state: AdaptiveState): number => ADAPTIVE_STEPS[state.stepIndex] ?? 1

/** Fraction of frames spent below full resolution. 0 before the first frame. */
export const engagedFraction = (state: AdaptiveState): number =>
  state.frames === 0 ? 0 : state.engagedFrames / state.frames

/**
 * Advance the controller by one frame. Pure apart from mutating `state`, three-
 * free, and therefore testable against a scripted frame-time sequence — which is
 * the only way this gets tested at all, since nothing in CI has a GPU that can
 * be made to struggle on demand.
 *
 * Returns true when the step index changed.
 */
export const stepAdaptive = (
  state: AdaptiveState,
  dtSeconds: number,
  config: AdaptiveConfig,
  costSeconds?: number,
): boolean => {
  // Same clamp as the vignette's, for the same reason: a backgrounded tab hands
  // back a delta of minutes, and without this the first frame back drops the
  // resolution to the floor on the strength of one number.
  const dt = dtSeconds < 0 ? 0 : dtSeconds > 0.25 ? 0.25 : dtSeconds
  state.frames += 1
  if (state.stepIndex > 0) state.engagedFrames += 1

  // ── DEV-262: WHAT the average is made of, which is not the wall clock ────
  //
  // `costSeconds` is OUR serial cost — the longer of the main thread and the
  // GPU. `dt` is how much time passed. They were the same number until today
  // and the difference is the whole of this change.
  //
  // Worn, on a streamed Steam Frame held in SteamVR's 45 Hz reprojection tier,
  // `dt` is **22.2 ms** on every frame while our own cost is **~5 ms GPU and
  // ~3 ms main thread** against an 11.11 ms budget. Fed `dt`, this function
  // reads 22.2 > 11.11 x 1.08, calls it over budget, and walks to the floor of
  // `ADAPTIVE_STEPS` — with 60 % of the frame spare. It did exactly that on
  // all three worn laps of 2026-09-20: `scale` 0.600 on all 12,866 frames.
  //
  // That is not a tuning error, it is the wrong quantity. `gpu-timer.ts`'s
  // header and `perf-protocol.md` §4 both already say it — *a wall delta at
  // vsync is the compositor's opinion rather than a cost* — and a compositor
  // holding us in a tier is not a thing we can render our way out of. Degrading
  // the image in response to it makes the game worse and the tier no better.
  //
  // Absent, it falls back to `dt`, which is the old behaviour exactly: a caller
  // with no cost measurement is no worse off than before.
  const cost =
    costSeconds === undefined ? dt : costSeconds < 0 ? 0 : costSeconds > 0.25 ? 0.25 : costSeconds
  // Seed rather than ease in from zero: starting the EMA at 0 reads as an
  // infinitely fast machine for the first second, which is the second the app is
  // loading and the frames are at their worst.
  // The outlier clamp. `dt` still measures how much TIME passed — that is what
  // `overSeconds` counts — but `sample` is what the average is made of.
  const cap = config.targetSeconds * config.sampleCapFactor
  const sample = cost > cap ? cap : cost
  // ── The exponent is `sample`, NOT `dt`, and that is deliberate ───────────
  //
  // It reads like a bug — an EMA's time constant should be a function of
  // elapsed time — and DEV-262 changed it to `dt` on exactly that reasoning.
  // Two DEV-228 tests went red and they were right: **the clamp bounds the
  // WEIGHT as well as the magnitude, and that is most of what it is for.**
  //
  // A backgrounded tab hands back a 90 s delta. Clamped to 0.25 s and used as
  // the exponent it is a weight of `1 - exp(-0.25/0.5)` = **0.39**, so one
  // frame drags the average 39 % of the way to a stall value and the next
  // three seconds of good frames cannot clear it. Through `sample`, clamped to
  // four budgets, the same frame weighs **0.105**. *"Fed in whole it dominates
  // the average for the next two seconds and the average stops being about the
  // renderer"* — that is `sampleCapFactor`'s own docstring, and it applies to
  // both halves of the term.
  //
  // What it costs: the EMA is smoothed in COST time rather than wall time, so
  // on a machine held in a tier it converges more slowly than `emaTau` reads.
  // That is a slower controller, not a wrong one, and the counters that decide
  // anything — `overSeconds`, `meetingSeconds` — are in wall seconds either way.
  if (state.ema === 0) state.ema = sample
  else state.ema += (sample - state.ema) * (1 - Math.exp(-sample / config.emaTau))

  // Three bands, and the middle one is the point. Over budget accumulates
  // `overSeconds`; comfortably under accumulates `underSeconds`; BETWEEN them —
  // meeting the budget with no room to spare — resets both, which is what keeps
  // a system that is exactly making its frames from stepping up into one that is
  // not. Either counter is reset by the other condition, so the seconds are
  // CONSECUTIVE: a hitch inside a good stretch contributes one frame and then
  // the stretch clears it.
  //
  // DEV-178 adds a THIRD counter across the same three bands. `meetingSeconds`
  // runs whenever the frame is not being missed — the middle band and the under
  // band together — and it is the only counter a vsync-locked display can ever
  // fill, because such a display hands back exactly one budget per frame and
  // never enters the under band at all. Without it the middle band is a trap
  // door: the controller can fall through it and cannot climb back.
  if (state.ema > config.targetSeconds * config.downFactor) {
    state.overSeconds += dt
    state.underSeconds = 0
    // ── DEV-228: `meetingSeconds` is NOT cleared here ────────────────────
    //
    // It used to be, and that one assignment is why the controller never left
    // the 0.6 floor on any real display. The counter stops ADVANCING while the
    // frame is being missed — time spent over budget is not time spent meeting
    // it — but a momentary excursion does not void the evidence behind it.
    //
    // The bug was an inconsistency, not a tuning error: *a hitch is not a
    // trend* is the rule the step DOWN already follows, and it needs 1.5
    // consecutive seconds before it will act. The climb treated the SAME
    // single frame as decisive. So a machine over budget 2 % of the time —
    // one chunk upload every couple of seconds — cleared a 3-second counter
    // before it could ever fill, and could only ever go down.
    //
    // What clears it now is evidence that would MOVE the controller: the step
    // down at the foot of this function, which fires at `sustainSeconds` and
    // zeroes all three counters. A machine genuinely missing its frame still
    // cannot climb, because it reaches that branch every 1.5 s.
  } else if (state.ema < config.targetSeconds * config.upFactor) {
    state.underSeconds += dt
    state.overSeconds = 0
    state.meetingSeconds += dt
  } else {
    state.overSeconds = 0
    state.underSeconds = 0
    state.meetingSeconds += dt
  }

  // The wait the middle-band climb must serve, doubled once per failed attempt.
  // `2 ** 0` is 1, so an unblemished controller climbs at `climbSustainSeconds`
  // and the backoff costs nothing until something has actually gone wrong.
  const climbWait =
    config.climbSustainSeconds * 2 ** Math.min(state.climbFailures, config.climbBackoffMax)

  const before = state.stepIndex
  let steppingUp: boolean
  if (state.overSeconds >= config.sustainSeconds) {
    const moved = state.stepIndex < ADAPTIVE_STEPS.length - 1
    state.stepIndex = Math.min(ADAPTIVE_STEPS.length - 1, state.stepIndex + 1)
    steppingUp = false
    // A step DOWN that undoes the step up before it is a failed climb, and the
    // next one waits twice as long. This is the ping-pong detector, and it is
    // deliberately about the SEQUENCE rather than about a time: two changes in
    // opposite directions is the signature whatever the interval was.
    if (moved && state.lastStepWasUp) state.climbFailures += 1
  } else if (state.underSeconds >= config.sustainSeconds) {
    // The fast path — real headroom, 22 % of the frame spare. It also CLEARS
    // the backoff: headroom is a new observation about the machine, not a
    // louder version of the old one, and a controller that stayed pessimistic
    // through a genuine change would never recover a resolution it could hold.
    state.stepIndex = Math.max(0, state.stepIndex - 1)
    state.climbFailures = 0
    steppingUp = true
  } else if (state.meetingSeconds >= climbWait && state.stepIndex > 0) {
    // The middle-band climb. Guarded on `stepIndex > 0` so a controller already
    // at full resolution does not reseed its EMA every three seconds for a step
    // it cannot take.
    state.stepIndex -= 1
    steppingUp = true
  } else {
    return false
  }
  // Only a step that MOVED is a step. At the floor an over-budget stretch keeps
  // asking and nothing happens; at full resolution the fast path keeps asking
  // and nothing happens. Recording either as "the last step was up/down" would
  // feed the backoff detector a sequence that never occurred.
  if (state.stepIndex !== before) state.lastStepWasUp = steppingUp
  state.overSeconds = 0
  state.underSeconds = 0
  state.meetingSeconds = 0
  // ── The history is void after a step ──────────────────────────────────
  //
  // A step CHANGES the cost of a frame, so every frame time measured before it
  // is evidence about a renderer that no longer exists. Carrying the old average
  // forward is what made this controller overshoot on RECOVERY: the frames go
  // good, the EMA takes ~1.2 s to notice, and `overSeconds` keeps filling up in
  // the meantime — so a machine that has just got faster takes one more step
  // DOWN. Seeding at the budget says "assume the step worked, now show me",
  // which is both the optimistic reading and the one that cannot overshoot.
  state.ema = config.targetSeconds
  return state.stepIndex !== before
}

// ── The applier ───────────────────────────────────────────────────────────

export interface QualityReport {
  readonly quality: QualitySetting
  /**
   * The base framebuffer scale the NEXT session will start at — the TIER's,
   * with no adaptive step in it (DEV-178). `scale` below is the step, and it
   * applies to the flat pixel ratio; multiplying the two is what shipped a
   * session at 0.6 × the runtime's recommendation on 2026-09-17.
   */
  readonly framebufferScale: number
  /** Flat-screen pixel ratio actually set, or null while presenting. */
  readonly pixelRatio: number | null
  /**
   * The viewport scale REQUESTED of the session's `XRView`s, or null when flat,
   * before the session's first frame, or on a runtime whose views have no
   * `requestViewportScale` (DEV-208, corrected by DEV-236).
   *
   * **It said "of the projection layer" and that was the bug.** The WebXR
   * Device API puts dynamic viewport scaling on `XRView`; an
   * `XRProjectionLayer` has no such method, so between DEV-208 and DEV-236 this
   * read `null` in every session on every runtime, and read it for a reason no
   * instrument could distinguish from "the controller never moved".
   *
   * `pixelRatio`'s counterpart: that one is null in a session, this one is null
   * outside it, and between them the adaptive step always has one surface it
   * landed on. A reader who sees both null while `scale` is below 1 is looking
   * at a controller degrading with nowhere to spend it, which is what every XR
   * session did between DEV-178 and this row — and, it turned out, for six
   * weeks after it too.
   */
  readonly viewportScale: number | null
  /** `setFoveation`'s current argument, including any adaptive escalation. */
  readonly foveation: number
  /** `ADAPTIVE_STEPS[stepIndex]`. 1 when adaptive resolution is idle or off. */
  readonly scale: number
  /** Frames below full resolution, as a fraction. M3's exit criterion. */
  readonly engaged: number
  /** Smoothed frame time, seconds. */
  readonly frameSeconds: number
  /**
   * The frame budget in force, seconds — `1 / frameRate` from the live XR
   * session, or the flat default out of one. Exposed for `boot/perf-hud.ts`,
   * which has to print what the frames are being judged AGAINST: a p95 of
   * 13 ms is a pass at 72 Hz and a fail at 90, and a panel that shows only the
   * first half of that comparison invites the wrong reading.
   */
  readonly targetSeconds: number
  /**
   * Where `targetSeconds` came from. See `TargetSource`.
   *
   * On the panel and in every trace header, because a budget is only as good as
   * its provenance and `default` means nobody knows.
   */
  readonly targetSource: TargetSource
  /**
   * The DISPLAY's rate, and the rate the app is actually getting frames at
   * (DEV-161). Equal on a machine that is keeping up.
   *
   * `targetSeconds` is always `1 / displayHz`: the budget is the display's
   * frame, because that is the thing we have to get under to leave a
   * compositor's tier. Worn 2026-09-17 they were 90 and 45, and the whole
   * reason this pair exists is that the single number before it read 45 and
   * said we were 11 ms inside a 22 ms budget.
   */
  readonly displayHz: number
  readonly tierHz: number
  /**
   * Is `displayHz` higher than THIS window alone would have said? DEV-179.
   *
   * The mechanism made visible, and the field a reader reaches for the first
   * time they see `90 Hz display · app 30 Hz` printed off a window with no 90
   * in it. True means *"the session saw 90 earlier and a display does not stop
   * being 90 because we stopped hitting it"*; false means the window itself
   * said so. `?hz=` also reads true — it is the same claim, stated by the
   * operator instead of measured.
   *
   * It is deliberately NOT on the console line: that line prints on an EDGE in
   * the budget, and stickiness engages without moving the budget (that is its
   * whole job), so the edge would never fire. The plate and `__ff2perf.budget()`
   * carry it live instead.
   */
  readonly displaySticky: boolean
  /** Fraction of the window's frames that arrived BELOW `displayHz`. 0 when keeping up. */
  readonly droppingFraction: number
  /**
   * How much of the measurement agreed, or null where the budget was not
   * measured. Carried here so the plate and the console print the same number
   * rather than each asking the recorder at their own moment.
   */
  readonly measuredShare: number | null
  /**
   * Frames the adaptive controller has seen, and the ones it spent below full
   * resolution — the RAW counters behind `engaged`.
   *
   * `engaged` is the whole-session fraction, which is the right shape for M3's
   * exit criterion and the wrong one for an overlay: a bad thirty seconds is
   * invisible in an hour's average. `boot/perf-recorder.ts` differences
   * `engagedFrames` between frames so it can report the same quantity over its
   * own window — READING this counter rather than deciding for itself what
   * "engaged" means, so there stays exactly one definition of it.
   *
   * Both are 0 while adaptive resolution is off, because `frame()` does not run
   * the controller at all then. That is the honest answer: a controller that is
   * not running has not engaged.
   */
  readonly frames: number
  readonly engagedFrames: number
}

export interface QualityController {
  /** One RENDER frame. Safe to call out of session and before the first frame. */
  /**
   * One frame. `dtSeconds` is the wall delta; `costSeconds` is OUR serial cost
   * — the longer of the main thread and the GPU — and it is what the adaptive
   * controller decides on (DEV-262).
   *
   * Passing only `dtSeconds` is the pre-DEV-262 behaviour and is wrong in a
   * headset: a compositor holding the app in a reprojection tier hands back a
   * constant `dt` that has nothing to do with what the app cost.
   */
  frame(dtSeconds: number, costSeconds?: number): void
  apply(settings: ComfortSettings): void
  /**
   * Push the session-start-only settings. Call BEFORE `requestSession`, and
   * again on `sessionend` — three reads `framebufferScaleFactor` when it builds
   * the layer and never again.
   */
  applyBeforeSession(): void
  /**
   * Drop the `sessionstart` / `sessionend` listeners. Called by
   * `render/renderer.ts`'s own `dispose`; nothing else owns this controller.
   */
  dispose(): void
  readonly report: QualityReport
}

export interface QualityOptions {
  /** Override the frame budget. Otherwise read from the live session. */
  readonly targetHz?: number
  /** Injectable for the tests, which have no `devicePixelRatio`. */
  readonly devicePixelRatio?: () => number
  /**
   * The canvas's size in CSS pixels, width times height. DEV-581: `ultra`'s
   * pixel target divides by it. Injectable for the same reason as
   * `devicePixelRatio`; the default reads the renderer's own canvas, which is
   * what `renderer.ts`'s resize handler sizes from.
   */
  readonly cssPixels?: () => number
  /**
   * The measured frame interval, when the runtime will not say (gap 10).
   *
   * INJECTED, not imported: `boot/perf-recorder.ts` is the only thing that
   * knows what the frames have been doing, and this file must not depend on it
   * — partly so a test can script the reading, and mostly because a render
   * module reaching into boot for a measurement is the wrong direction. `app.ts`
   * passes `() => perf.modalHz()` and nothing else ever does.
   *
   * Called on every budget resolution, so it must stay cheap; `modalHz` is
   * three short walks of a 720-float ring and clears only the bins it touched.
   */
  readonly measuredHz?: () => MeasuredHz | null
  /**
   * `?hz=90` — the display's rate, STATED. DEV-179, `boot/quality-pin.ts`.
   *
   * Not `targetHz`. That one replaces the whole resolution, so it reports
   * `tierHz === displayHz` and a `dropping` of zero — which is right for a test
   * injecting a budget and wrong for a headset, where the tier is the thing
   * being looked at. This pins the DISPLAY and leaves the tier measured, so
   * `90 Hz display · app 30 Hz` still reads true with the pin in force.
   *
   * It exists because the measurement has a failure mode the operator does not:
   * on a run that never once reaches the display's rate, no window contains the
   * evidence and `stickyDisplayHz` has nothing to latch. Somebody who has just
   * set SteamVR to 90 knows the answer and can say so.
   *
   * **In a session only.** Out of one the budget is `DEFAULT_TARGET_HZ_FLAT`
   * and is labelled `flat` — the flat build's frames are not a budget anybody
   * files a row against, so there is nothing here for a pin to correct. Use
   * `targetHz` if you genuinely want to judge a flat page against something
   * else.
   */
  readonly displayHz?: number
}

/**
 * The bits of the live XR frame `pushViewportScale` reads (DEV-236).
 *
 * Structural and optional, not `XRFrame`/`XRView` from `@types/webxr`, and the
 * difference is the whole point: that package declares
 * `XRView.requestViewportScale(scale)` as a REQUIRED member, which is a claim
 * about every runtime that is not true of any runtime we cannot probe. Modelled
 * as optional here so the feature detection below is a real branch rather than
 * one TypeScript narrows to `never`. Same posture as `boot/perf-surface.ts`,
 * which reads the same objects through the same kind of shape.
 */
type XrViewLike = { requestViewportScale?: (scale: number) => void }
type XrFrameLike = {
  getViewerPose?: (space: unknown) => { views?: readonly XrViewLike[] } | null
}

/**
 * Bind the quality settings to a renderer.
 *
 * Everything that can be applied at any time is applied on `apply()`; everything
 * that cannot is stored and pushed by `applyBeforeSession()`. The split is not
 * an abstraction, it is the three.js constraint written into the type so a
 * caller cannot get it wrong silently.
 */
export const createQualityController = (
  renderer: THREE.WebGLRenderer,
  options: QualityOptions = {},
): QualityController => {
  const dpr = options.devicePixelRatio ?? (() => globalThis.devicePixelRatio ?? 1)
  const cssPixels =
    options.cssPixels ??
    (() => {
      const canvas = (renderer as { domElement?: { clientWidth?: number; clientHeight?: number } })
        .domElement
      return (canvas?.clientWidth || 1) * (canvas?.clientHeight || 1)
    })
  let settings: Pick<
    ComfortSettings,
    'quality' | 'qualityAuto' | 'foveation' | 'adaptiveResolution'
  > = {
    quality: 'high',
    foveation: true,
    adaptiveResolution: true,
  }
  const adaptive = createAdaptiveState()
  let appliedPixelRatio: number | null = null
  /**
   * NaN, not `FOVEATION_ON`, so the FIRST `apply()` always pushes.
   *
   * Seeding it at 1 would be truthful — three's own default is 1 — and would
   * mean `setFoveation` was never actually called on the default path, so
   * PORT_PLAN M2's "one line" would be a line nobody could prove ran. NaN never
   * equals anything, including itself, so the first call always goes through.
   */
  let appliedFoveation = Number.NaN
  /**
   * The viewport scale last REQUESTED of an `XRView` (DEV-208, DEV-236).
   *
   * **Not a change-guard.** DEV-236 asks on every presenting frame, so there is
   * nothing here to suppress a repeat with; what it still does — and what
   * nothing else in this controller can do — is separate *"we asked for 0.6"*
   * from *"this runtime has no such knob"*. It stays `null` until a request has
   * actually reached at least one view, so `report.viewportScale` reading `—`
   * on the plate beside a `scale` of 0.600 is the signature of a runtime
   * WITHOUT THE METHOD, rather than of a controller that has not moved.
   *
   * **A number here is not proof the pixels moved.** Desktop Chrome has the
   * method and implements it as a no-op: its OpenXR backend never opts in, so
   * this reads the ASK (0.6) while the eye width stays put
   * (`docs/plan/XR-PERF-VS-THREE.md` §3.6, §4.3). Only `vp_w` in a capture
   * says whether a request landed.
   *
   * A session boundary puts it back to `null` for the same reason the value
   * exists: the views are the new session's, and a remembered number would
   * report a request that session never heard.
   */
  let appliedViewportScale: number | null = null

  const presenting = () => renderer.xr.isPresenting === true

  /**
   * The frame budget, and where it came from (VR-PERF §5.3, gap 10).
   *
   * Four sources in falling order of authority, and the order is the point:
   *
   *  1. An explicit override, which is a test or a deliberate experiment.
   *  2. `XRSession.frameRate` — what the runtime says it is driving. This was
   *     the whole resolver until now, with `?? 72` behind it, and the `??` was
   *     doing all the work on the target rig: `frameRate` is Meta's extension
   *     and is not on `XRSession.prototype` in desktop Chrome at all (probed
   *     2026-09-16), so a Steam Frame at 90 or 120 Hz was judged against 13.9 ms
   *     and the adaptive controller could never trip.
   *  3. The MEASURED modal interval. The frames themselves know what rate they
   *     are arriving at; nothing was asking them. Guarded on share and count so
   *     a machine in trouble is not mistaken for a machine at 48 Hz.
   *  4. `DEFAULT_TARGET_HZ_XR`, unchanged — and now labelled `default` so a
   *     reading taken against a guess is visible as one.
   *
   * Behaviour where `frameRate` IS present is byte-identical to before.
   */
  /** A resolved budget and everything printed beside it. */
  type Budget = {
    seconds: number
    source: TargetSource
    displayHz: number
    tierHz: number
    sticky: boolean
    dropping: number
    measuredShare: number | null
    presenting: boolean
  }

  /** A budget from a rate nobody measured: display and tier are the same thing. */
  const plain = (hz: number, source: TargetSource, isPresenting: boolean): Budget => ({
    seconds: 1 / hz,
    source,
    displayHz: hz,
    tierHz: hz,
    sticky: false,
    dropping: 0,
    measuredShare: null,
    presenting: isPresenting,
  })

  /**
   * The display rate ADOPTED so far this session. 0 before the first.
   *
   * Moved only where a budget is adopted, never where one is merely resolved,
   * so `BUDGET_ADOPT_SECONDS` is the guard: one freak window reading 144 has to
   * hold for two seconds before it can pin the session's budget at 6.9 ms for
   * the rest of the flight. And RESET at both ends of a session — see
   * `onSession`, and DEV-178, whose whole lesson was a measurement leaking from
   * one display into another's.
   */
  let sticky = 0

  /** `?hz=`, or null. Read once: a pin is a fact about the LOAD. */
  const displayPin =
    options.displayHz && options.displayHz > 0 && Number.isFinite(options.displayHz)
      ? options.displayHz
      : null

  const resolveCandidate = (): Budget => {
    const isPresenting = presenting()
    if (options.targetHz && options.targetHz > 0) {
      return plain(options.targetHz, 'override', isPresenting)
    }
    if (!isPresenting) return plain(DEFAULT_TARGET_HZ_FLAT, 'flat', false)

    const reported = (renderer.xr.getSession() as { frameRate?: number } | null)?.frameRate
    if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) {
      return plain(reported, 'session', true)
    }

    const measured = options.measuredHz?.() ?? null
    const rate =
      measured && measured.frames >= MEASURED_MIN_FRAMES ? resolveDisplayRate(measured) : null
    // ── The window, then the session, then the operator (DEV-179) ─────────
    //
    // `rate` is what THIS window can see; `display` is what the SESSION knows.
    // They differ exactly when the app has spent a whole window inside a tier,
    // which is the state the budget most needs to be right in.
    const display = stickyDisplayHz(displayPin, sticky, rate?.displayHz ?? 0)
    if (display > 0) {
      return {
        seconds: 1 / display,
        // A pinned display is an instruction, not a measurement, and the plate
        // prints the share only beside `measured` — which is what we want: the
        // window's share did not decide this number and must not be read as
        // though it had.
        source: displayPin !== null ? 'override' : 'measured',
        displayHz: display,
        // The TIER is always this window's, pin or no pin. It is the one half
        // of the pair a session-long memory must never supply: "we are in a
        // tier" is a statement about now.
        tierHz: rate?.tierHz ?? display,
        sticky: display > (rate?.displayHz ?? 0),
        dropping: rate?.dropping ?? 0,
        measuredShare: displayPin !== null ? null : (rate?.share ?? null),
        presenting: true,
      }
    }

    return plain(DEFAULT_TARGET_HZ_XR, 'default', true)
  }

  /**
   * Take the session's display rate from a budget that has been ADOPTED.
   *
   * The one place `sticky` moves, and it takes `displayHz` whole rather than a
   * maximum: `stickyDisplayHz` has already decided whether this window is us in
   * a tier (hold) or a display that changed (follow), and doing that arithmetic
   * twice, in two places, with two different rules, is how the two halves come
   * to disagree.
   *
   * Only a `measured` or `override` budget may move it: `session` is the
   * runtime's own answer and needs no memory, `flat` belongs to the other
   * display entirely, and `default` is 72 because nobody knows — latching a
   * guess would make every later window unable to correct it, which is the
   * failure this row exists to remove rather than to reproduce one level up.
   */
  const remember = (budget: Budget): void => {
    if (budget.source !== 'measured' && budget.source !== 'override') return
    if (budget.displayHz > 0) sticky = budget.displayHz
  }

  // ── The budget in force, and the hysteresis on changing it (DEV-161) ─────
  //
  // `adopted` is what everything reads. `pending` is a candidate serving its
  // `BUDGET_ADOPT_SECONDS`, and it exists because the worn session's console
  // printed the budget line about sixty times in one lap: the resolver flipped
  // between `measured 45` and `default 72` on every 3 s window as the mode's
  // share crossed 0.6 and came back.
  //
  // The clock is `frame()`'s `dt` rather than a wall clock, because a render
  // module must not read `performance.now()` — and because a budget that
  // advanced while the tab was backgrounded would adopt whatever the last
  // frame before the freeze happened to see.
  let adopted: Budget | null = null
  let pending: Budget | null = null
  let pendingHeld = 0

  const sameBudget = (a: Budget, b: Budget): boolean =>
    a.source === b.source && Math.abs(a.seconds - b.seconds) <= b.seconds * BUDGET_CHANGE_TOLERANCE

  /**
   * The budget in force. Adopts immediately the first time, and whenever the
   * session state flips.
   *
   * Immediately on a flip because entering or leaving a headset is not a wobble
   * — it is a different display — and two seconds of judging a 90 Hz session
   * against the flat build's 16.7 ms is two seconds of the adaptive controller
   * being told it has headroom it does not have.
   */
  const budgetNow = (): Budget => {
    if (adopted === null || adopted.presenting !== presenting()) {
      adopted = resolveCandidate()
      remember(adopted)
      pending = null
      pendingHeld = 0
    }
    return adopted
  }

  /** Advance the hysteresis clock by one frame. Called from `frame()` only. */
  const updateBudget = (dtSeconds: number): void => {
    // `budgetNow()` has already taken the session flip, immediately and without
    // a pending clock: entering or leaving a headset is not a wobble, it is a
    // different display, and two seconds of judging a 90 Hz session against the
    // flat build's 16.7 ms is two seconds of the adaptive controller being told
    // it has headroom it does not have.
    const current = budgetNow()
    const next = resolveCandidate()
    if (sameBudget(next, current)) {
      // ── The BUDGET is hysteretic. The TIER is not (DEV-179) ─────────────
      //
      // `adopted` is a SNAPSHOT, and until the display rate became sticky it
      // was refreshed every few seconds by the flap — which hid the fact that
      // everything on it froze at the moment of adoption. Now that the budget
      // genuinely holds for a whole session, a tier left on the snapshot would
      // read `app 90 Hz` for a lap spent entirely at 30, and the pair whose
      // whole purpose is to disagree would agree for ever.
      //
      // So: the two fields the hysteresis is FOR — the budget and where it came
      // from — keep their adopted values, and everything that describes the
      // frames arriving right now is taken from this window. Mutated in place
      // rather than rebuilt, because this runs once a frame and `adopted` is
      // nobody else's object.
      current.tierHz = next.tierHz
      current.sticky = next.sticky
      current.dropping = next.dropping
      current.measuredShare = next.measuredShare
      pending = null
      pendingHeld = 0
      return
    }
    // A hitch clamps the same way the controller's own sample does: a
    // backgrounded tab handing back a delta of minutes must not adopt a budget
    // on the strength of one frame.
    const dt = dtSeconds > 0 && dtSeconds < 0.25 ? dtSeconds : 0
    if (pending && sameBudget(next, pending)) {
      pendingHeld += dt
      pending = next
      if (pendingHeld >= BUDGET_ADOPT_SECONDS) {
        adopted = next
        remember(adopted)
        pending = null
        pendingHeld = 0
      }
      return
    }
    pending = next
    pendingHeld = 0
  }

  const pushFoveation = () => {
    const base = settings.foveation ? FOVEATION_ON : FOVEATION_OFF
    // The live XR degradation path. With foveation ON there is no headroom left
    // to give — it is already at maximum — so this only bites for a player who
    // turned it off, which is exactly the player who chose the sharp periphery
    // over the frame and should get the frame back when it runs out.
    const want = settings.adaptiveResolution && adaptive.stepIndex > 0 ? FOVEATION_ON : base
    if (want === appliedFoveation) return
    appliedFoveation = want
    renderer.xr.setFoveation(want)
  }

  const pushPixelRatio = () => {
    // NEVER while presenting: `setPixelRatio` routes through `setSize`, which
    // three refuses with a warning, and a warning per frame is the noise that
    // buried a real one the first time this was worn.
    if (presenting()) return
    // `settings.quality`, not the tier in force: this surface is flat by the
    // guard above, and flat is the surface the stored tier names.
    const spec = QUALITY[settings.quality]
    const cap = spec.pixelRatioCap
    const scale = settings.adaptiveResolution ? adaptiveScale(adaptive) : 1
    // DEV-581: ultra's base is a pixel TARGET; every other tier's is the cap.
    const base = spec.ultra
      ? ultraPixelRatio(spec.ultra, cap, dpr(), cssPixels())
      : Math.min(dpr(), cap)
    const next = base * scale
    if (appliedPixelRatio !== null && Math.abs(next - appliedPixelRatio) < 1e-6) return
    appliedPixelRatio = next
    renderer.setPixelRatio(next)
  }

  /**
   * The LIVE XR resolution knob, which this file spent a session insisting did
   * not exist (DEV-208).
   *
   * The header above argues — correctly, with citations — that
   * `setFramebufferScaleFactor` defers to the next session and `setPixelRatio`
   * is refused while presenting, and concludes that foveation is the only thing
   * that moves in a session. It then REJECTS rebuilding the base layer by hand,
   * also correctly: three keeps rendering into the reference it still holds, and
   * that is a black headset with no error.
   *
   * All of that is true and it misses the API the spec provides for exactly
   * this: **dynamic viewport scaling**. It is live, mid-session, and supported —
   * WebXR's own dynamic-resolution mechanism rather than a way around one.
   *
   * ── DEV-236: it is on the VIEW, not on the LAYER ─────────────────────────
   *
   * DEV-208 landed this call on `renderer.xr.getBaseLayer()` and it never once
   * ran. `XRProjectionLayer` has no `requestViewportScale`, so the feature
   * detection guarding it — `typeof layer.requestViewportScale !== 'function'`
   * — returned early on every frame of every session this build has ever had.
   * Silent by construction: a feature detect that is false asks for nothing and
   * says nothing. What caught it was two instruments disagreeing rather than
   * any test: the adaptive `scale` column read **0.600** while DEV-227's
   * recorded per-eye viewport read the full **2016 × 2016**
   * (`VR-PERF-WAVE-3.md` §10.1, row 1).
   *
   * The spec puts both halves on `XRView` — `recommendedViewportScale` to read
   * and `requestViewportScale(s)` to write — and `boot/perf-surface.ts` has
   * been probing the VIEW, correctly, since before anything called it. Only
   * this file and `perf-format.ts`'s prose ever believed it was the layer's.
   *
   * ── The mechanism, out of the spec and out of three's own build ──────────
   *
   * A view carries three internal slots. **"requested viewport scale"** starts
   * at 1.0 and is what `requestViewportScale(s)` writes. **"current viewport
   * scale"** is what the system is using, and it is updated to match the
   * requested one *when a `getViewport()` call successfully applies it*.
   * **"viewport modifiable"** is set true at the START of an animation frame
   * and false once `getViewport()` has been called for that view — so, in the
   * spec's own words, the requested scale *"does not take effect until the
   * application calls `getViewport()` for that view"*.
   *
   * three reads the viewport BEFORE it calls us. `WebXRManager.js`:
   *
   *     pose = frame.getViewerPose( ... );                        // :918
   *     viewport = glBaseLayer.getViewport( view );               // :951
   *     const glSubImage = glBinding.getViewSubImage( ..., view );// :955
   *     camera.viewport.set( viewport.x, ..., viewport.height );  // :987
   *     if ( onAnimationFrameCallback ) onAnimationFrameCallback( // :1075
   *
   * So a request made from inside the app's loop is made when this frame's view
   * is no longer modifiable, and **lands on the NEXT frame's read.** That is
   * fine and it is the only ordering available to us: one frame of latency on a
   * controller whose own hysteresis is measured in seconds. It is also the
   * relationship the whole fix rests on, so it is asserted against three's own
   * build in `tests/unit/xr-viewport-scale-oracle.test.ts` rather than trusted.
   *
   * ── Every presenting frame, not once on change ───────────────────────────
   *
   * The spec's normative text reads as though the requested scale persists (the
   * slot is only ever overwritten, never cleared), and Chrome keeps it per view
   * index. But **both the spec's own example and MDN's re-request on every
   * animation frame**, for every view in the pose, and a UA is explicitly
   * permitted to implement the whole API as a no-op. So this is designed for
   * the conservative reading: ask every presenting frame. The cost is two
   * method calls and one `getViewerPose` on a frame that already has a pose;
   * the cost of being wrong the other way is a headset pinned at 0.6 for a
   * whole session, which is what DEV-160 spent a worn night on.
   *
   * **This is why `appliedViewportScale` is no longer a change-guard** — a
   * per-frame request cannot have one. It is kept because it still guards
   * something real, and something nothing else can say: it is `null` until a
   * request has actually reached a view, so `report.viewportScale` distinguishes
   * *"asked for 0.6"* from *"this runtime has no such knob"*. On the old code
   * that distinction was carried by the layer type and was wrong about it.
   *
   * ── What we do NOT do ────────────────────────────────────────────────────
   *
   * We never substitute `recommendedViewportScale`. The app's controller is the
   * authority for the scale — it is judging against a budget the runtime has no
   * view of — and the recommendation is a hint printed on the plate beside our
   * request so the two can be compared. The UA clamps below: *"if the scale is
   * smaller than the view's minimum viewport scale, it is set to the minimum"*,
   * which is why the plate's `vp` row and the trace's `vp_w` column are the
   * evidence and this number is only the ask.
   *
   * With adaptive resolution OFF — `?adaptive=0`, the measuring configuration —
   * we request **1.0** rather than nothing at all. A runtime that remembers a
   * previous 0.6 would otherwise pin the measurement at 0.6 forever, which is
   * DEV-178's leak with the surfaces swapped.
   *
   * Ask for a smaller scale and the next frame renders into a smaller region of
   * the same texture. The render target is NOT reallocated, which is the point:
   * the cost that falls is FILL, and fill is 75 % of the worn frame (§3c —
   * 8.62 ms of 11.51).
   *
   * **Why this is worth having when foveation already exists.** Foveation
   * spends the PERIPHERY and is capped — `pushFoveation` says so: with it on
   * there is no headroom left to give. This spends the whole image, continuously,
   * and it is the same trade R12 asks for: when the budget runs out, resolution
   * gives and the frame never does.
   *
   * The mirror of `pushPixelRatio` in every respect. That one refuses to run
   * while presenting; this one runs ONLY while presenting. Between them the
   * controller's step always has exactly one surface to spend itself on, which
   * is what DEV-178 severed and never replaced.
   */
  const pushViewportScale = () => {
    if (!presenting()) return
    const xrm = renderer.xr as unknown as {
      getFrame?: () => XrFrameLike | null
      getReferenceSpace?: () => unknown
    }
    // `getFrame()` is three's OWN guard and the reason no frame is threaded
    // through `frame()`: `WebXRManager` assigns `xrFrame` at :919 and puts it
    // back to `null` at :1083, after the callback returns. So it is non-null
    // exactly inside the animation loop — which is the only place an `XRView`
    // may legally be read — and an `apply()` from a settings menu no-ops here
    // and is picked up by the next frame.
    const frame = xrm.getFrame?.()
    if (!frame) return
    const scale = settings.adaptiveResolution ? adaptiveScale(adaptive) : 1
    try {
      const views = frame.getViewerPose?.(xrm.getReferenceSpace?.())?.views
      if (!views) return
      let asked = false
      for (const view of views) {
        // Per VIEW, and every one of them. `@types/webxr` declares this member
        // as required; the runtimes do not, so the detection is on the method
        // and a runtime without it is a silent no-op rather than a TypeError
        // in the frame loop.
        if (typeof view.requestViewportScale !== 'function') continue
        view.requestViewportScale(scale)
        asked = true
      }
      if (asked) appliedViewportScale = scale
    } catch {
      // Tracking lost, or a view read the runtime refuses. `perf-surface.ts`
      // makes the same call behind the same catch for the same reason: a knob
      // that can take the frame loop down is worse than no knob.
    }
  }

  /**
   * The XR base framebuffer scale: the TIER, and nothing else (DEV-178).
   *
   * It used to multiply by `adaptiveScale(adaptive)`, and the step it reached
   * for was whatever the FLAT page had accumulated — see the header. The
   * adaptive step belongs to `pushPixelRatio`, which is the surface it can
   * actually move, and a step measured on a 60 Hz monitor has no claim on the
   * resolution of a 90 Hz headset that has not rendered a frame yet.
   */
  // The HEADSET's tier: on AUTO that is `VR_AUTO_QUALITY`, not the monitor's
  // `quality` (DEV-334). This scale is only ever read for an XR session.
  const baseFramebufferScale = () => QUALITY[qualityInForce(settings, true)].framebufferScale

  // ── The controller resets at both ends of a session (DEV-178) ───────────
  //
  // `flat-fov.ts`'s pattern, for a related reason: `renderer.xr` is an
  // `EventDispatcher` and both events fire on it. `sessionstart` so the
  // session's engaged fraction is the session's — M3's exit criterion is a
  // percentage of frames, and 29,000 loading-screen frames in the denominator
  // answer nothing. `sessionend` so the flat build does not inherit a step the
  // headset earned, which is the same leak in the other direction.
  //
  // `apply()` is NOT called here: the reset puts the step back to 1, and the
  // two pushes below are what makes that visible on the surfaces that take it.
  //
  // DEV-179 resets the display rate's high-water mark on the same two events,
  // for the same reason one level up: 90 Hz is a fact about the HEADSET, and a
  // flat page that inherited it would judge its 60 Hz frames against 11.1 ms
  // and walk the pixel ratio to the floor — which is DEV-178's bug with the
  // sign flipped. `adopted` and `pending` go with it so the first frame after a
  // session boundary resolves from nothing rather than from the other display.
  const onSession = (): void => {
    resetAdaptiveState(adaptive)
    // The VIEWS are the new session's (DEV-236), so a remembered number would
    // report a request this session never heard.
    //
    // Nothing re-pushes it here, and that is deliberate rather than an
    // omission: `sessionstart` and `sessionend` do not fire inside the
    // animation loop, so `renderer.xr.getFrame()` is null and a view is
    // unreachable. The first frame of the session asks. A `pushViewportScale()`
    // on this line would be a call that cannot do anything, which is exactly
    // the kind of line DEV-236 was spent removing.
    appliedViewportScale = null
    sticky = 0
    adopted = null
    pending = null
    pendingHeld = 0
    pushFoveation()
    pushPixelRatio()
  }
  const xr = renderer.xr as unknown as {
    addEventListener?: (type: string, fn: () => void) => void
    removeEventListener?: (type: string, fn: () => void) => void
  }
  xr.addEventListener?.('sessionstart', onSession)
  xr.addEventListener?.('sessionend', onSession)

  return {
    frame(dtSeconds, costSeconds) {
      // OUTSIDE the adaptive guard, and that is not a detail: `?adaptive=0` is
      // the measuring configuration (`docs/testing/perf-protocol.md` §3), and a
      // hysteresis clock that only ticked while the controller was running
      // would leave the plate and every trace header stamped with whatever
      // budget the first frame resolved, for the whole run.
      updateBudget(dtSeconds)
      // DEV-581: ultra's ratio depends on the canvas's size, which a window
      // resize changes without telling this controller. So under ultra the
      // ratio is re-derived every flat frame; `pushPixelRatio` returns early
      // unless the answer moved, so a still window costs one sqrt. Only under
      // ultra: every other tier's ratio is the cap and does not depend on the
      // size, and their behaviour stays exactly what it was.
      if (QUALITY[settings.quality].ultra && !presenting()) pushPixelRatio()
      if (settings.adaptiveResolution) {
        const config: AdaptiveConfig = {
          ...DEFAULT_ADAPTIVE,
          targetSeconds: budgetNow().seconds,
        }
        if (stepAdaptive(adaptive, dtSeconds, config, costSeconds)) {
          pushPixelRatio()
          pushFoveation()
        }
      }
      // OUTSIDE the adaptive guard too, and for TWO reasons (DEV-236).
      //
      // Every presenting frame, because the WebXR view's "requested viewport
      // scale" is re-asked per frame by the spec's own example and by MDN's,
      // and because a view is only reachable from inside the animation loop at
      // all — `renderer.xr.getFrame()` is null everywhere else.
      //
      // And outside the `adaptiveResolution` branch, because `?adaptive=0` is
      // the measuring configuration and it must render FULL SIZE. A runtime
      // that remembered a 0.6 from before the setting was turned off would
      // otherwise pin every measurement taken after it at 0.6. Asking for 1.0
      // is how a session climbs back; asking for nothing is how it does not.
      pushViewportScale()
    },
    apply(next) {
      settings = next
      pushFoveation()
      pushPixelRatio()
      // NO `pushViewportScale()` here (DEV-236). `apply()` is a settings-change
      // handler and runs outside the animation loop, where `getFrame()` is null
      // and there is no view to ask. `frame()` pushes every presenting frame,
      // so a comfort-menu change lands ~11 ms later on its own. The version
      // that called it here was edge-triggered against a LAYER, which is the
      // object that turned out never to have taken the call at all.
      // Out of session this is a free store; in session three warns. Guarded.
      if (!presenting()) renderer.xr.setFramebufferScaleFactor(baseFramebufferScale())
    },
    applyBeforeSession() {
      if (presenting()) return
      renderer.xr.setFramebufferScaleFactor(baseFramebufferScale())
    },
    dispose() {
      xr.removeEventListener?.('sessionstart', onSession)
      xr.removeEventListener?.('sessionend', onSession)
    },
    get report(): QualityReport {
      const target = budgetNow()
      return {
        quality: qualityInForce(settings, presenting()),
        framebufferScale: baseFramebufferScale(),
        pixelRatio: presenting() ? null : appliedPixelRatio,
        // The XR half of the same story: null flat, a number in a session.
        // Reported so the plate can say which surface the step landed on —
        // a controller that is degrading and an instrument that cannot show
        // it is how the clipped plate row happened (DEV-206).
        viewportScale: presenting() ? appliedViewportScale : null,
        foveation: appliedFoveation,
        scale: settings.adaptiveResolution ? adaptiveScale(adaptive) : 1,
        engaged: engagedFraction(adaptive),
        frameSeconds: adaptive.ema,
        targetSeconds: target.seconds,
        targetSource: target.source,
        displayHz: target.displayHz,
        tierHz: target.tierHz,
        displaySticky: target.sticky,
        droppingFraction: target.dropping,
        measuredShare: target.measuredShare,
        frames: adaptive.frames,
        engagedFrames: adaptive.engagedFrames,
      }
    },
  }
}
