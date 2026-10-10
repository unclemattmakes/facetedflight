// tests/unit/comfort-quality.test.ts — resolution is what gives, and it gives
// in the right direction at the right moment.
//
// **What this cannot test.** Nothing in CI has a GPU that can be made to
// struggle on demand, and `docs/vr-testing.md` is blunt about the XR double:
// *"It reports a perfect frame every rAF ... Never read a performance or comfort
// conclusion out of it."* So there is no assertion below about a frame rate.
// PORT_PLAN M2's *"measured with and without"* is a headset job, and M3's *"72 Hz
// with AdaptiveResolution engaged on no more than 20 % of frames"* is a number
// this file makes COMPUTABLE rather than one it checks.
//
// **What it can test**, by scripting the frame times the controller is fed: does
// it step down under sustained load and not on a single hitch; does it step back
// up only when there is real headroom; does it stay off the knobs three.js
// refuses; and does the engaged-fraction counter mean what M3's exit says.

import type * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { KNOWN_REFRESH_HZ } from '@/boot/perf-recorder'
import { DEFAULT_SETTINGS, VR_AUTO_QUALITY } from '@/boot/settings'
import {
  ADAPTIVE_STEPS,
  type AdaptiveConfig,
  adaptiveScale,
  BUDGET_ADOPT_SECONDS,
  CLIMB_SUSTAIN_SECONDS,
  createAdaptiveState,
  createQualityController,
  DEFAULT_ADAPTIVE,
  DEFAULT_TARGET_HZ_FLAT,
  DEFAULT_TARGET_HZ_XR,
  engagedFraction,
  FOVEATION_OFF,
  FOVEATION_ON,
  isSubRateOf,
  MEASURED_MIN_FRAMES,
  type MeasuredHz,
  QUALITY,
  resolveDisplayRate,
  stepAdaptive,
  stickyDisplayHz,
  TIER_RATIO_TOLERANCE,
} from '@/render/quality'

const config = (hz = DEFAULT_TARGET_HZ_XR): AdaptiveConfig => ({
  ...DEFAULT_ADAPTIVE,
  targetSeconds: 1 / hz,
})

/**
 * A renderer that IS presenting and whose session reports no `frameRate`.
 *
 * Desktop Chrome exactly: `'frameRate' in XRSession.prototype` is false there
 * (DEV-160 §3), so the measured interval is the only source a Steam Frame has.
 */
const sessionRendererNoRate = (): THREE.WebGLRenderer =>
  ({
    setPixelRatio: () => {},
    xr: {
      isPresenting: true,
      getSession: () => ({}),
      setFoveation: () => {},
      setFramebufferScaleFactor: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  }) as unknown as THREE.WebGLRenderer

/** Run `seconds` of frames, every one taking `frameSeconds`. */
const run = (
  state: ReturnType<typeof createAdaptiveState>,
  frameSeconds: number,
  seconds: number,
  cfg = config(),
) => {
  const frames = Math.max(1, Math.round(seconds / frameSeconds))
  for (let i = 0; i < frames; i++) stepAdaptive(state, frameSeconds, cfg)
}

/**
 * A renderer stand-in. `createQualityController` touches exactly five things,
 * and a stub makes the ones three REFUSES observable — which a real renderer in
 * node cannot be, because there is no XR session to be presenting in.
 */
const fakeRenderer = (presenting = false) => {
  const calls = {
    pixelRatio: [] as number[],
    foveation: [] as number[],
    framebufferScale: [] as number[],
  }
  // `renderer.xr` is an `EventDispatcher` and both ends of a session fire on
  // it — `flat-fov.ts` has used that since M2 and DEV-178 joins it. The fake
  // carries a listener table so a test can fire `sessionstart` without a
  // headset, and `fire` is the only way the reset is reachable at all.
  const listeners = new Map<string, (() => void)[]>()
  const renderer = {
    setPixelRatio: (v: number) => calls.pixelRatio.push(v),
    xr: {
      isPresenting: presenting,
      getSession: () => (presenting ? { frameRate: 72 } : null),
      setFoveation: (v: number) => calls.foveation.push(v),
      setFramebufferScaleFactor: (v: number) => calls.framebufferScale.push(v),
      addEventListener: (type: string, fn: () => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn])
      },
      removeEventListener: (type: string, fn: () => void) => {
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((f) => f !== fn),
        )
      },
    },
  }
  const fire = (type: string) => {
    for (const fn of listeners.get(type) ?? []) fn()
  }
  const listenerCount = (type: string) => (listeners.get(type) ?? []).length
  return { renderer: renderer as unknown as THREE.WebGLRenderer, calls, fire, listenerCount }
}

describe('the presets', () => {
  it('leaves HIGH exactly where the renderer already was', () => {
    // `renderer.ts` shipped `setPixelRatio(Math.min(devicePixelRatio, 2))`
    // before this file existed. `high` is the default, so nobody who never
    // opens the menu sees any change — which is the only honest way to add a
    // preset system to a thing people have already been flying.
    expect(QUALITY.high.pixelRatioCap).toBe(2)
    expect(QUALITY.high.framebufferScale).toBe(1)
    expect(DEFAULT_SETTINGS.quality).toBe('high')
  })

  it('pins MEDIUM’s XR scale at 0.75, Matt’s call after the first worn eye-size comparison', () => {
    // A shipped default, pinned by VALUE in one place somebody has to edit on
    // purpose (CLAUDE.md, DEV-266). It was 0.85 until 2026-09-23; see the
    // comment on `QUALITY` and `docs/perf-baseline.md` for the measurement.
    expect(QUALITY.medium.framebufferScale).toBe(0.75)
    expect(QUALITY.medium.msaa).toBe(true)
  })

  it('is monotone: lower preset, less of everything', () => {
    expect(QUALITY.low.framebufferScale).toBeLessThan(QUALITY.medium.framebufferScale)
    expect(QUALITY.medium.framebufferScale).toBeLessThan(QUALITY.high.framebufferScale)
    expect(QUALITY.low.pixelRatioCap).toBeLessThan(QUALITY.medium.pixelRatioCap)
    expect(QUALITY.medium.pixelRatioCap).toBeLessThan(QUALITY.high.pixelRatioCap)
  })

  it('never scales the framebuffer to nothing', () => {
    // The floor of the whole system: the lowest preset at the lowest adaptive
    // step. Below about half you are reading a HUD through frosted glass, and a
    // HUD you cannot read is its own failure.
    const floor = QUALITY.low.framebufferScale * (ADAPTIVE_STEPS.at(-1) ?? 1)
    expect(floor).toBeGreaterThan(0.4)
  })
})

describe('the adaptive controller', () => {
  it('does nothing at all while the frame budget is being met', () => {
    const state = createAdaptiveState()
    run(state, 1 / 72, 20)
    expect(state.stepIndex).toBe(0)
    expect(adaptiveScale(state)).toBe(1)
    expect(engagedFraction(state)).toBe(0)
  })

  it('steps DOWN under sustained load, one step at a time', () => {
    // 45 fps against a 72 Hz budget: 22 ms a frame against 13.9.
    const state = createAdaptiveState()
    run(state, 1 / 45, 2)
    expect(state.stepIndex).toBe(1)
    run(state, 1 / 45, 2)
    expect(state.stepIndex).toBe(2)
    // ...and never past the end of the list.
    run(state, 1 / 45, 60)
    expect(state.stepIndex).toBe(ADAPTIVE_STEPS.length - 1)
    expect(adaptiveScale(state)).toBe(ADAPTIVE_STEPS.at(-1))
  })

  it('does NOT react to a single hitch', () => {
    // A geometry upload, a GC, a terrain chunk swap. A hitch is a frame, not a
    // trend, and a controller that drops the resolution every time one lands
    // makes the image pulse for reasons the player cannot connect to anything.
    const state = createAdaptiveState()
    run(state, 1 / 72, 10)
    stepAdaptive(state, 0.25, config())
    stepAdaptive(state, 1 / 72, config())
    expect(state.stepIndex).toBe(0)
  })

  it('takes one step per sustained interval, not four at once', () => {
    // Each step has to be given time to show whether it worked. Without that,
    // one bad second takes the resolution from 1.0 to 0.6 in four frames and the
    // player watches the whole image go soft at once.
    const state = createAdaptiveState()
    run(state, 1 / 30, DEFAULT_ADAPTIVE.sustainSeconds * 1.2)
    expect(state.stepIndex).toBe(1)
  })

  it('comes back up when there is REAL headroom, and not before', () => {
    const state = createAdaptiveState()
    run(state, 1 / 40, 6)
    expect(state.stepIndex).toBeGreaterThan(0)

    // CHANGED BY DEV-178. This used to run ten seconds of at-budget frames and
    // assert the index had not moved — "exactly at budget is NOT headroom". It
    // still is not headroom, and the middle band still climbs far more slowly
    // than the fast path; what is no longer true is that it never climbs, and
    // the reason is in the row: on a vsync-locked display the middle band is
    // the ONLY band there is, so "never climbs there" meant "never climbs".
    // The property that survives is the ORDERING, which the test below states
    // directly. Here, one `sustainSeconds` of at-budget frames — enough for the
    // fast path twice over — must still not have climbed. (It may still step
    // DOWN in that window: the EMA arrives from the 25 ms frames above and
    // takes ~a second to come back through the top band, which is the existing
    // "the history is void after a step" behaviour and not this row's.)
    const held = state.stepIndex
    run(state, 1 / 72, DEFAULT_ADAPTIVE.sustainSeconds)
    expect(state.stepIndex).toBeGreaterThanOrEqual(held)

    // Comfortably under it IS headroom, and it walks all the way back.
    run(state, 1 / 144, 30)
    expect(state.stepIndex).toBe(0)
  })

  it('CLIMBS BACK from a machine that is exactly making its budget, then stops', () => {
    // ── CHANGED BY DEV-178, and the change is the point of that row ────────
    //
    // This test used to assert `moves === 0` — that a controller sitting
    // exactly ON its budget never moves again. That was the anti-oscillation
    // property as written, and it was HALF of one. A display that paces you
    // hands back exactly one budget per frame for ever, so it lives in the
    // middle band permanently: it could step DOWN (on the load's own hitches)
    // and could never step back up, because the only climb was the 0.78 fast
    // path and 0.78 of a vsync-locked frame does not happen.
    //
    // Worn 2026-09-17: the flat loading screen walked the controller to the 0.6
    // floor and held it there for 99.9 % of 29,038 frames, and
    // `applyBeforeSession()` then handed that 0.6 to the headset.
    //
    // So the property is now the one this test asserts: it climbs back to full
    // resolution on `CLIMB_SUSTAIN_SECONDS`, and THEN it stops. Both halves —
    // a climb with no stop is the oscillation the old assertion was guarding
    // against, and the test below covers the case where the climb keeps failing.
    const state = createAdaptiveState()
    run(state, 1 / 40, 6)
    run(state, 1 / 72, 5)
    expect(state.stepIndex).toBeGreaterThan(0)

    let moves = 0
    const cfg = config()
    for (let i = 0; i < 72 * 30; i++) if (stepAdaptive(state, 1 / 72, cfg)) moves += 1
    expect(state.stepIndex).toBe(0)
    // One move per step it had to climb, and not one more in the remaining
    // ~20 seconds: at full resolution the climb has nowhere to go.
    expect(moves).toBeLessThanOrEqual(ADAPTIVE_STEPS.length - 1)

    let after = 0
    for (let i = 0; i < 72 * 30; i++) if (stepAdaptive(state, 1 / 72, cfg)) after += 1
    expect(after).toBe(0)
    expect(state.stepIndex).toBe(0)
  })

  it('takes longer to climb from the middle band than from real headroom', () => {
    // The hysteresis on the new path, stated as the relationship rather than as
    // either number (trap 24): a step up on the weaker signal must cost more
    // than a step up on the stronger one, whatever the constants become.
    expect(CLIMB_SUSTAIN_SECONDS).toBeGreaterThan(DEFAULT_ADAPTIVE.sustainSeconds)

    /**
     * Wall seconds until the first step, feeding frames of `dt`.
     *
     * The time is ACCUMULATED, not derived from a frame count and an assumed
     * rate: the first version of this divided both legs by 72 while feeding one
     * of them 144 Hz frames, and the two answers came out identical to twelve
     * decimal places — a test that passed its own arithmetic rather than the
     * code. (Trap 24, in miniature.)
     */
    const secondsToFirstStep = (dt: number): number => {
      const state = createAdaptiveState()
      state.stepIndex = 2
      let seconds = 0
      for (let i = 0; i < 10_000; i++) {
        seconds += dt
        if (stepAdaptive(state, dt, config())) return seconds
      }
      return Number.POSITIVE_INFINITY
    }

    const headroomAt = secondsToFirstStep(1 / 144)
    const meetingAt = secondsToFirstStep(1 / 72)
    expect(headroomAt).toBeCloseTo(DEFAULT_ADAPTIVE.sustainSeconds, 1)
    expect(meetingAt).toBeCloseTo(CLIMB_SUSTAIN_SECONDS, 1)
    expect(meetingAt).toBeGreaterThan(headroomAt)
  })

  it('SETTLES rather than ping-pongs when every climb blows the budget', () => {
    // The adversarial case for the middle-band climb, and the reason for the
    // backoff. A machine that exactly makes its frame at step N and misses it
    // at step N−1 would otherwise climb every 3 s, fall back 1.5 s later, and
    // repeat for the whole session — the image breathing once every four and a
    // half seconds, which is the artifact `upFactor`'s asymmetry exists to stop.
    //
    // The assertion is a BOUND on the changes per minute, not an exact count:
    // the exact count is a function of three constants and would pin the
    // tuning rather than the property. Thirteen a minute is the metronome;
    // anything near a handful is a controller that has given up and settled.
    const state = createAdaptiveState()
    state.stepIndex = 2
    const cfg = config()
    let changes = 0
    // 60 s at 72 Hz. `1/72` is at budget (the middle band) at the current step;
    // as soon as the controller climbs, the frames go to 1/60 — over budget —
    // which is the "every step up fails" condition stated literally.
    for (let i = 0; i < 72 * 60; i++) {
      const dt = state.stepIndex < 2 ? 1 / 60 : 1 / 72
      if (stepAdaptive(state, dt, cfg)) changes += 1
    }
    expect(changes).toBeGreaterThan(0)
    expect(changes).toBeLessThanOrEqual(10)
    // And the backoff is what did it — the failures are recorded, not inferred.
    expect(state.climbFailures).toBeGreaterThan(0)
  })

  it('clears the climb backoff when REAL headroom turns up', () => {
    // A machine that genuinely got faster — a window resize, a tab coming back
    // to the front, an effect switched off in the menu — must not be held to a
    // 48-second wait it earned under different conditions. The fast path is a
    // different observation, not a louder one.
    const state = createAdaptiveState()
    state.stepIndex = 2
    state.climbFailures = 3
    run(state, 1 / 144, 4)
    expect(state.climbFailures).toBe(0)
  })

  it('counts engaged frames the way M3-s exit criterion asks', () => {
    // "72 Hz with AdaptiveResolution engaged on no more than 20 % of frames."
    // A criterion nobody can compute is a criterion nobody checks.
    const state = createAdaptiveState()
    run(state, 1 / 72, 30)
    expect(engagedFraction(state)).toBe(0)
    run(state, 1 / 40, 30)
    expect(engagedFraction(state)).toBeGreaterThan(0)
    expect(engagedFraction(state)).toBeLessThanOrEqual(1)
    // Frames, not seconds: the denominator is every frame ever stepped.
    expect(state.frames).toBeGreaterThan(state.engagedFrames)
  })

  it('shrugs off a backgrounded tab', () => {
    const state = createAdaptiveState()
    run(state, 1 / 72, 10)
    // 90 seconds in one delta, clamped to 0.25 s. It moves the EMA a long way —
    // a quarter of a second really is a quarter of a second — but it is one
    // frame, so it cannot reach `sustainSeconds` on its own...
    stepAdaptive(state, 90, config())
    expect(state.stepIndex).toBe(0)
    // ...and a couple of seconds of ordinary frames clears it entirely.
    run(state, 1 / 72, 3)
    expect(state.stepIndex).toBe(0)
    expect(state.ema).toBeCloseTo(1 / 72, 3)
  })

  it('seeds the smoother rather than easing in from an infinitely fast machine', () => {
    const state = createAdaptiveState()
    stepAdaptive(state, 1 / 30, config())
    expect(state.ema).toBeCloseTo(1 / 30, 6)
  })
})

// ── DEV-228: the climb on a frame stream that has hitches in it ───────────
//
// **Every climb test above feeds a mathematically CONSTANT frame time**, via
// `run()`. That is the one input shape on which the middle-band climb cannot
// fail: a constant `dt` makes the EMA a flat line, so it never crosses
// `downFactor`, `meetingSeconds` only ever counts up, and the climb fires at
// exactly `CLIMB_SUSTAIN_SECONDS` every time. The property those tests assert
// — *it climbs out of the middle band* — was true of the one stream a display
// never produces, and the suite had no way to tell that from the general claim.
//
// Worn on a Steam Frame and on the VRto3D rig, the controller sat at
// `ADAPTIVE_STEPS`' 0.6 floor on frame one and on every frame after: 2,763
// frames worn, 4,288 and 3,517 on the rig, in both arms of two A/Bs. Replaying
// those recorded `dt` columns back through this same `stepAdaptive` reproduces
// it exactly — from step 0 it walks 0→1→2→3→4 in 11.5 s and then never moves,
// with `climbFailures` still 0, because `meetingSeconds` topped out at **1.98 s
// against the 3 s it needs**.
//
// The cause was an inconsistency rather than a tuning error. *A hitch is not a
// trend* is the rule the step DOWN already follows — it will not act on less
// than `sustainSeconds` of it — and the climb treated the SAME single frame as
// decisive, zeroing its counter outright. So the two directions disagreed about
// what one bad frame means, and on any stream with a stall in it every couple
// of seconds the climb's counter was cleared before it could ever fill.
//
// These tests drive the controller with a frame-time FUNCTION rather than a
// constant, which is the only difference that matters.
describe('the climb, on the kind of frame stream a display actually produces', () => {
  /** Step until full resolution, feeding `next(t)`. Returns the wall seconds. */
  const secondsToFullResolution = (next: (t: number) => number, limit = 300): number => {
    const state = createAdaptiveState()
    state.stepIndex = ADAPTIVE_STEPS.length - 1
    const cfg = config()
    let t = 0
    while (t < limit) {
      const dt = next(t)
      t += dt
      stepAdaptive(state, dt, cfg)
      if (state.stepIndex === 0) return t
    }
    return Number.POSITIVE_INFINITY
  }

  /** `base` every frame, except one `hitch` frame every `every` seconds. */
  const withHitch = (base: number, hitch: number, every: number) => {
    let due = every
    return (t: number): number => {
      if (t < due) return base
      due = t + every
      return hitch
    }
  }

  /**
   * 11 ms, which is INSIDE a 72 Hz budget and still not headroom.
   *
   * 11 / 13.889 = 0.792, above `upFactor`'s 0.78 — so the fast path is
   * excluded by construction and what these tests exercise is the middle-band
   * climb and nothing else. Asserted rather than assumed, because a later
   * change to `upFactor` would otherwise move these tests onto the other path
   * silently and they would go on passing while testing something else.
   */
  const BASE = 0.011

  /** A stall: a shader compiled in the air, a geometry upload, a GC. */
  const HITCH = 0.25

  it('is testing the MIDDLE band, and the hitch really does cross the down band', () => {
    const cfg = config()
    expect(BASE).toBeGreaterThan(cfg.targetSeconds * cfg.upFactor)
    expect(BASE).toBeLessThan(cfg.targetSeconds * cfg.downFactor)

    // And one hitch, from a settled 11 ms, must put the EMA over the down band
    // — otherwise these tests would pass on the broken code too, which is the
    // way a regression test quietly stops being one.
    const state = createAdaptiveState()
    for (let i = 0; i < 300; i++) stepAdaptive(state, BASE, cfg)
    expect(state.ema).toBeLessThan(cfg.targetSeconds * cfg.downFactor)
    stepAdaptive(state, HITCH, cfg)
    expect(state.ema).toBeGreaterThan(cfg.targetSeconds * cfg.downFactor)

    // ...and is still not, on its own, enough to step DOWN. That pair is the
    // whole bug: one frame that cannot move the controller one way was allowed
    // to veto it moving the other.
    expect(state.stepIndex).toBe(0)
  })

  it('RECOVERS from the floor on a machine that meets its budget between hitches', () => {
    // The regression, stated as the thing a player gets: a machine comfortably
    // able to hold the resolution, stalling once every two seconds, must climb
    // back to full. Before DEV-228 this was `Infinity` — the controller sat on
    // the floor for as long as the session lasted.
    const seconds = secondsToFullResolution(withHitch(BASE, HITCH, 2))
    expect(seconds).toBeLessThan(120)
  })

  it('still climbs at EVERY hitch rate, and a quieter machine climbs sooner', () => {
    // The relationship rather than the constants (trap 24). More hitches may
    // cost more time; they may never cost ALL of it. A single infinity here is
    // the bug returning under a different frame rate.
    const clean = secondsToFullResolution(() => BASE)
    expect(clean).toBeLessThan(120)
    for (const every of [1, 2, 3, 5, 10]) {
      const seconds = secondsToFullResolution(withHitch(BASE, HITCH, every))
      expect(seconds).toBeLessThan(120)
      expect(seconds).toBeGreaterThanOrEqual(clean)
    }
  })

  it('does NOT climb on a machine that is genuinely missing its frame', () => {
    // The control arm, and the reason this row is not simply "let it climb".
    // 22.2 ms against a 13.9 ms budget is the worn shape exactly: the Steam
    // Frame capture of 2026-09-19 read a 90 Hz display, a `dt` p50 of 22.2 ms
    // and `tierFraction` 1.0 — every frame of the session inside SteamVR's
    // half-rate tier. There the 0.6 floor is the right answer and the
    // controller must stay on it, hitches or no hitches.
    const cfg = config()
    for (const next of [() => 0.0222, withHitch(0.0222, HITCH, 3)]) {
      const state = createAdaptiveState()
      state.stepIndex = ADAPTIVE_STEPS.length - 1
      let t = 0
      let moves = 0
      while (t < 90) {
        const dt = next(t)
        t += dt
        if (stepAdaptive(state, dt, cfg)) moves += 1
      }
      expect(state.stepIndex).toBe(ADAPTIVE_STEPS.length - 1)
      expect(moves).toBe(0)
    }
  })

  it('does not turn a marginal machine into a metronome', () => {
    // The other way this fix could be wrong. A machine sitting ON its budget —
    // the rig's measured mean was 13.99 ms against a 13.89 ms budget — may try
    // the climb, but the backoff has to make it settle rather than breathe.
    // The bound is the one `SETTLES rather than ping-pongs` already uses.
    const state = createAdaptiveState()
    state.stepIndex = ADAPTIVE_STEPS.length - 1
    const cfg = config()
    let t = 0
    let changes = 0
    while (t < 120) {
      // At the floor it makes budget; one step up and it does not. The
      // adversarial case for any climb path.
      const dt = state.stepIndex < ADAPTIVE_STEPS.length - 1 ? 0.017 : BASE
      t += dt
      if (stepAdaptive(state, dt, cfg)) changes += 1
    }
    expect(changes).toBeGreaterThan(0)
    expect(changes).toBeLessThanOrEqual(10)
    expect(state.climbFailures).toBeGreaterThan(0)
  })
})

describe('the renderer knobs, and the ones three.js refuses', () => {
  it('sets the pixel ratio out of session', () => {
    const { renderer, calls } = fakeRenderer(false)
    const quality = createQualityController(renderer, { devicePixelRatio: () => 3 })
    quality.apply({ ...DEFAULT_SETTINGS, quality: 'medium' })
    // Capped at the preset's 1.5, not the display's 3.
    expect(calls.pixelRatio).toEqual([1.5])
  })

  it('NEVER touches the pixel ratio while presenting', () => {
    // `setPixelRatio` routes through `setSize`, which three refuses with
    // "Can't change size while VR device is presenting." Entering VR on a Quest
    // fires a burst of resizes, and the first time this was worn ~80 identical
    // warnings buried a real one (see `renderer.ts`'s resize guard). One per
    // frame would be very much worse.
    const { renderer, calls } = fakeRenderer(true)
    const quality = createQualityController(renderer, { devicePixelRatio: () => 2 })
    quality.apply(DEFAULT_SETTINGS)
    for (let i = 0; i < 500; i++) quality.frame(1 / 30)
    expect(calls.pixelRatio).toEqual([])
  })

  it('NEVER changes the framebuffer scale while presenting', () => {
    // Same shape, different warning: `setFramebufferScaleFactor` stores the
    // value and warns that it cannot apply it (three.module.js:14144-14152). It
    // is a session-START decision, so the controller only pushes it when there
    // is no session.
    const { renderer, calls } = fakeRenderer(true)
    const quality = createQualityController(renderer)
    quality.apply({ ...DEFAULT_SETTINGS, quality: 'low' })
    quality.applyBeforeSession()
    expect(calls.framebufferScale).toEqual([])
  })

  it('pushes the framebuffer scale for the NEXT session when out of one', () => {
    const { renderer, calls } = fakeRenderer(false)
    const quality = createQualityController(renderer)
    quality.apply({ ...DEFAULT_SETTINGS, quality: 'low' })
    expect(calls.framebufferScale.at(-1)).toBeCloseTo(QUALITY.low.framebufferScale, 6)
  })
  it('actually calls setFoveation(1) on the default path', () => {
    // PORT_PLAN M2 asks for `renderer.xr.setFoveation(1)` explicitly. three's
    // own default is already 1, so it would have been tempting to seed the
    // "already applied" value at 1 and skip the call — truthful, and it would
    // make the plan's one line a line nobody could prove ran.
    const { renderer, calls } = fakeRenderer(true)
    const quality = createQualityController(renderer)
    quality.apply(DEFAULT_SETTINGS)
    expect(calls.foveation).toEqual([FOVEATION_ON])
  })

  it('turns foveation off when the player asks, and it is the MEASURABLE state', () => {
    // three's own default is already 1.0 (three.module.js:13915), so PORT_PLAN
    // M2's "setFoveation(1)" has been in effect since the renderer was written.
    // That makes OFF the interesting measurement, and this is the call that
    // makes it possible from inside the headset.
    const { renderer, calls } = fakeRenderer(true)
    const quality = createQualityController(renderer)
    quality.apply({ ...DEFAULT_SETTINGS, foveation: false })
    expect(calls.foveation).toEqual([FOVEATION_OFF])
    quality.apply({ ...DEFAULT_SETTINGS, foveation: true })
    expect(calls.foveation).toEqual([FOVEATION_OFF, FOVEATION_ON])
  })

  it('escalates foveation as the LIVE in-session degradation path', () => {
    // The honest consequence of the three.js constraint: in a session, the
    // resolution knob is frozen and foveation is the only thing left that moves.
    // So a player who turned foveation off to get a sharp periphery gets it back
    // automatically when the budget runs out — peripheral resolution spent to
    // protect the frame, which is R12's whole trade.
    const { renderer, calls } = fakeRenderer(true)
    const quality = createQualityController(renderer)
    quality.apply({ ...DEFAULT_SETTINGS, foveation: false })
    expect(calls.foveation).toEqual([FOVEATION_OFF])
    for (let i = 0; i < 400; i++) quality.frame(1 / 30)
    expect(calls.foveation.at(-1)).toBe(FOVEATION_ON)
    expect(quality.report.scale).toBeLessThan(1)
  })

  it('does not spam a knob with a value it already has', () => {
    const { renderer, calls } = fakeRenderer(false)
    const quality = createQualityController(renderer, { devicePixelRatio: () => 1 })
    quality.apply(DEFAULT_SETTINGS)
    const first = calls.pixelRatio.length
    for (let i = 0; i < 300; i++) quality.frame(1 / 72)
    quality.apply(DEFAULT_SETTINGS)
    expect(calls.pixelRatio.length).toBe(first)
  })

  it('leaves the resolution alone entirely when adaptive is off', () => {
    // The point of the OFF setting: a fixed resolution is the only way to read
    // a GPU number that means anything.
    const { renderer, calls } = fakeRenderer(false)
    const quality = createQualityController(renderer, { devicePixelRatio: () => 1 })
    quality.apply({ ...DEFAULT_SETTINGS, adaptiveResolution: false })
    const before = calls.pixelRatio.length
    for (let i = 0; i < 600; i++) quality.frame(1 / 20)
    expect(calls.pixelRatio.length).toBe(before)
    expect(quality.report.scale).toBe(1)
  })

  it('reads the budget off the live session rather than assuming 72', () => {
    // A Quest set to 90 or 120 Hz reports it on `XRSession.frameRate`. Hard-code
    // 72 and a 90 Hz headset is declared permanently over budget and walks the
    // resolution to the floor on its first ten seconds.
    const { renderer } = fakeRenderer(true)
    const spy = vi.spyOn(renderer.xr, 'getSession')
    const quality = createQualityController(renderer)
    quality.apply(DEFAULT_SETTINGS)
    quality.frame(1 / 72)
    expect(spy).toHaveBeenCalled()
  })
})

// ── The base resolution a session starts at (DEV-178) ─────────────────────
//
// Worn 2026-09-17: the session's render target was 3522 x 1761 — 1761 per eye
// on a 2160 panel — with `getNativeFramebufferScaleFactor` reading 1. That is
// 0.6 x the runtime's recommendation, and the 0.6 came from the FLAT loading
// screen: the controller had walked to its floor over 29,038 frames of a
// vsync-locked page, and `applyBeforeSession()` multiplied the tier's base by
// the live step. Every GPU number that session was taken at a third of the
// pixels the headset asked for.
//
// Both editions ride on this: `QUALITY` and the controller are edition-blind,
// so Classic and Anniversary took the same 0.6 and get the same fix.
describe('the base scale a session starts at, and the adaptive step that must not reach it', () => {
  /** Walk the controller down `steps` steps on flat, over-budget frames. */
  const walkDown = (quality: ReturnType<typeof createQualityController>, steps: number) => {
    // 20 ms frames against the flat 60 Hz budget of 16.7. `sustainSeconds` is
    // 1.5, so three seconds a step is comfortable.
    for (let i = 0; i < steps; i++) for (let f = 0; f < 200; f++) quality.frame(0.02)
  }

  it('hands the session the TIER, whatever the flat controller has been doing', () => {
    // The regression, stated as the measurement it came from: at `high` the
    // tier is 1.0, the flat step had reached 0.6, and three built the layer at
    // 0.6. The assertion is that the pushed value is the tier EXACTLY — not
    // "greater than 0.6", which a half-fix would also satisfy.
    const { renderer, calls } = fakeRenderer(false)
    const quality = createQualityController(renderer, { devicePixelRatio: () => 1 })
    quality.apply(DEFAULT_SETTINGS)
    walkDown(quality, 4)
    expect(quality.report.scale).toBeLessThan(1)

    calls.framebufferScale.length = 0
    quality.applyBeforeSession()
    // DEV-334: the default settings are AUTO, and an auto headset starts at
    // `VR_AUTO_QUALITY` (Medium), not the monitor's High. Still the tier EXACTLY.
    expect(calls.framebufferScale).toEqual([QUALITY[VR_AUTO_QUALITY].framebufferScale])
    expect(quality.report.framebufferScale).toBeCloseTo(
      QUALITY[VR_AUTO_QUALITY].framebufferScale,
      9,
    )
  })

  it('is the tier for a LOWER preset too — the step is the only thing removed', () => {
    // The pair that separates "the adaptive step was dropped" from "the whole
    // multiplication was dropped": a player on `low` must still get 0.7.
    const { renderer, calls } = fakeRenderer(false)
    const quality = createQualityController(renderer, { devicePixelRatio: () => 1 })
    quality.apply({ ...DEFAULT_SETTINGS, quality: 'low' })
    walkDown(quality, 4)
    calls.framebufferScale.length = 0
    quality.applyBeforeSession()
    expect(calls.framebufferScale).toEqual([QUALITY.low.framebufferScale])
  })

  it('still spends the adaptive step on the FLAT pixel ratio, which is its surface', () => {
    // The other half of the fix: the step was not deleted, it was confined to
    // the one knob three.js lets us move live out of a session. A fix that
    // stopped the flat resolution moving would have removed the feature.
    const { renderer, calls } = fakeRenderer(false)
    const quality = createQualityController(renderer, { devicePixelRatio: () => 1 })
    quality.apply(DEFAULT_SETTINGS)
    walkDown(quality, 2)
    expect(calls.pixelRatio.at(-1)).toBeLessThan(1)
    expect(calls.pixelRatio.at(-1)).toBeCloseTo(quality.report.scale, 6)
  })

  it('RESETS the controller on sessionstart, so a session counts its own frames', () => {
    // M3's exit criterion is "engaged on no more than 20 % of frames". With
    // 29,038 loading-screen frames in the denominator — 99.9 % of them engaged
    // — the number is about a loading screen. `engaged` must mean the session.
    const { renderer, fire } = fakeRenderer(false)
    const quality = createQualityController(renderer, { devicePixelRatio: () => 1 })
    quality.apply(DEFAULT_SETTINGS)
    walkDown(quality, 4)
    expect(quality.report.scale).toBeLessThan(1)
    expect(quality.report.frames).toBeGreaterThan(0)
    expect(quality.report.engagedFrames).toBeGreaterThan(0)

    fire('sessionstart')
    expect(quality.report.scale).toBe(1)
    expect(quality.report.frames).toBe(0)
    expect(quality.report.engagedFrames).toBe(0)
    expect(quality.report.engaged).toBe(0)
  })

  it('RESETS on sessionend too, so the flat build does not inherit the headset-s step', () => {
    // The same leak in the other direction, and it is not hypothetical: take
    // the headset off mid-struggle and the flat page would open at 0.6 with
    // nothing on screen saying why.
    const { renderer, fire } = fakeRenderer(false)
    const quality = createQualityController(renderer, { devicePixelRatio: () => 1 })
    quality.apply(DEFAULT_SETTINGS)
    walkDown(quality, 3)
    expect(quality.report.scale).toBeLessThan(1)
    fire('sessionend')
    expect(quality.report.scale).toBe(1)
  })

  it('puts the flat pixel ratio back on the reset rather than waiting for a settings change', () => {
    // A reset that moved the state and not the knob would leave the page
    // rendering at 0.6 with the report saying 1.0 — the worst of the two.
    const { renderer, calls, fire } = fakeRenderer(false)
    const quality = createQualityController(renderer, { devicePixelRatio: () => 1 })
    quality.apply(DEFAULT_SETTINGS)
    walkDown(quality, 3)
    expect(calls.pixelRatio.at(-1)).toBeLessThan(1)
    fire('sessionend')
    expect(calls.pixelRatio.at(-1)).toBeCloseTo(1, 6)
  })

  it('drops both listeners on dispose', () => {
    // `renderer.dispose()` does not clear listeners the app added to
    // `renderer.xr`, and `render/renderer.ts` calls this for exactly that.
    const { renderer, listenerCount } = fakeRenderer(false)
    const quality = createQualityController(renderer)
    expect(listenerCount('sessionstart')).toBe(1)
    expect(listenerCount('sessionend')).toBe(1)
    quality.dispose()
    expect(listenerCount('sessionstart')).toBe(0)
    expect(listenerCount('sessionend')).toBe(0)
  })
})

// ── Where the frame budget comes from (DEV-160 / VR-PERF §5.3, gap 10) ────
//
// The resolver replaced `session.frameRate ?? DEFAULT_TARGET_HZ_XR`, and on the
// rig this was written for the `??` was the entire thing: desktop Chrome does
// not put `frameRate` on `XRSession.prototype` at all, so a Steam Frame at 90
// or 120 Hz was judged against 13.9 ms and the adaptive controller could never
// trip. Everything here is about the ORDER and about the label, because a
// budget with no provenance turns a measurement into a verdict.
describe('the frame budget, and where it says it came from', () => {
  /** A renderer whose session reports whatever `frameRate` is passed — or none. */
  const sessionRenderer = (frameRate?: number) => {
    const renderer = {
      setPixelRatio: () => {},
      xr: {
        isPresenting: true,
        getSession: () => (frameRate === undefined ? {} : { frameRate }),
        setFoveation: () => {},
        setFramebufferScaleFactor: () => {},
      },
    }
    return renderer as unknown as THREE.WebGLRenderer
  }

  const measured = (hz: number, share: number, frames: number) => () => ({ hz, share, frames })

  it('is the flat default out of session, labelled `flat`', () => {
    const { renderer } = fakeRenderer(false)
    const q = createQualityController(renderer, { measuredHz: measured(90, 1, 300) })
    q.apply(DEFAULT_SETTINGS)
    expect(q.report.targetSource).toBe('flat')
    expect(q.report.targetSeconds).toBeCloseTo(1 / DEFAULT_TARGET_HZ_FLAT, 9)
  })

  it('uses the MEASURED interval when the runtime reports no rate', () => {
    // The whole point. `getSession()` returns a session object with no
    // `frameRate`, which is desktop Chrome exactly.
    const q = createQualityController(sessionRenderer(undefined), {
      measuredHz: measured(90, 0.83, 260),
    })
    q.apply(DEFAULT_SETTINGS)
    expect(q.report.targetSource).toBe('measured')
    expect(q.report.targetSeconds).toBeCloseTo(1 / 90, 9)
  })

  it('prefers the SESSION over the measurement when the runtime does report one', () => {
    // The runtime's own answer beats an inference about it. Byte-identical to
    // the behaviour before the resolver existed, which is the compatibility
    // claim this test is here to hold.
    const q = createQualityController(sessionRenderer(72), { measuredHz: measured(90, 1, 300) })
    q.apply(DEFAULT_SETTINGS)
    expect(q.report.targetSource).toBe('session')
    expect(q.report.targetSeconds).toBeCloseTo(1 / 72, 9)
  })

  it('an explicit override beats everything', () => {
    const q = createQualityController(sessionRenderer(72), {
      targetHz: 120,
      measuredHz: measured(90, 1, 300),
    })
    q.apply(DEFAULT_SETTINGS)
    expect(q.report.targetSource).toBe('override')
    expect(q.report.targetSeconds).toBeCloseTo(1 / 120, 9)
  })

  it('refuses a measurement too few frames agree with, and SAYS it is guessing', () => {
    // A window that is 40 % one rate and 60 % scattered is a machine in
    // trouble, not a 90 Hz machine. The fallback is the old 72 — unchanged —
    // and the label is what is new: a reading stamped `default` is a reading to
    // distrust, and `docs/perf-baseline.md` carries the source on every row.
    const q = createQualityController(sessionRenderer(undefined), {
      measuredHz: measured(90, 0.4, 300),
    })
    q.apply(DEFAULT_SETTINGS)
    expect(q.report.targetSource).toBe('default')
    expect(q.report.targetSeconds).toBeCloseTo(1 / DEFAULT_TARGET_HZ_XR, 9)
  })

  it('refuses a measurement taken over too short a window', () => {
    const q = createQualityController(sessionRenderer(undefined), {
      measuredHz: measured(90, 1, MEASURED_MIN_FRAMES - 1),
    })
    q.apply(DEFAULT_SETTINGS)
    expect(q.report.targetSource).toBe('default')
  })

  it('engages within half a second at 90 Hz, which is before the first compile storm', () => {
    // `MEASURED_MIN_FRAMES` is the knob, and what matters is the WALL TIME it
    // corresponds to: the frames are at their worst in the first second of a
    // session, and a controller judging those against a guessed 72 while the
    // headset runs at 90 would step the resolution down on arrival.
    expect(MEASURED_MIN_FRAMES / 90).toBeLessThan(0.6)
  })

  it('falls back to `default` when nothing is injected at all', () => {
    // Every existing call site — `createRenderer` without options, and every
    // test above — is this case, and it must behave exactly as it did before.
    const q = createQualityController(sessionRenderer(undefined))
    q.apply(DEFAULT_SETTINGS)
    expect(q.report.targetSource).toBe('default')
    expect(q.report.targetSeconds).toBeCloseTo(1 / DEFAULT_TARGET_HZ_XR, 9)
  })

  it('drives the ADAPTIVE CONTROLLER off the measured budget, not just the report', () => {
    // The report is what a panel reads; the controller is what actually spends
    // resolution. A resolver wired into one and not the other would print the
    // right budget while stepping against the wrong one — which is worse than
    // the bug it replaced, because it would look correct.
    //
    // 11.5 ms frames are UNDER a 72 Hz budget (13.9) and OVER a 90 Hz one
    // (11.1), so the two budgets disagree about this machine. With the measured
    // 90 Hz in force the controller must step down; that is the separating case.
    const q = createQualityController(sessionRenderer(undefined), {
      measuredHz: measured(90, 1, 300),
      devicePixelRatio: () => 1,
    })
    q.apply(DEFAULT_SETTINGS)
    for (let i = 0; i < 600; i++) q.frame(0.0125)
    expect(q.report.scale).toBeLessThan(1)

    const slow = createQualityController(sessionRenderer(undefined), { devicePixelRatio: () => 1 })
    slow.apply(DEFAULT_SETTINGS)
    for (let i = 0; i < 600; i++) slow.frame(0.0125)
    expect(slow.report.scale).toBe(1)
  })
})

// ── A tier is a tier: the display rate, and the hysteresis (DEV-161) ──────
//
// Every number below is scripted from the first worn session (DEV-160 §3), and
// the finding it encodes is this: SteamVR's reprojection tiers are EXACT halves
// and thirds of the display's rate, so a window holding 45 and 90 together is a
// 90 Hz display we are hitting every other frame of — not a 45 Hz display.
//
// The two readings want opposite verdicts. Against 22.2 ms our 15.6 ms serial
// cost is comfortable and there is nothing to fix; against 11.1 ms it is 40 %
// over, which is the true statement and the one the whole optimisation backlog
// is gated on.
describe('the display rate, the tier, and which of them is the budget', () => {
  const measured = (
    candidates: readonly { hz: number; share: number }[],
    frames = 260,
  ): MeasuredHz => ({
    hz: candidates.reduce(
      (best, c) => (c.share > best.share ? c : best),
      candidates[0] as {
        hz: number
        share: number
      },
    ).hz,
    share: Math.max(...candidates.map((c) => c.share)),
    frames,
    candidates,
  })

  it('reads the WORN window as a 90 Hz display with the app at 45', () => {
    // 60 % of frames at 22.2 ms and 40 % at 11.1 — lap 1, exactly as the trace
    // binned it. The mode is 45 and the mode is not the display.
    const rate = resolveDisplayRate(
      measured([
        { hz: 45, share: 0.6 },
        { hz: 90, share: 0.4 },
      ]),
    )
    expect(rate).not.toBeNull()
    expect(rate?.displayHz).toBe(90)
    expect(rate?.tierHz).toBe(45)
    expect(rate?.dropping).toBeCloseTo(0.6, 6)
  })

  it('reads a third-rate window the same way — lap 2 read 30', () => {
    const rate = resolveDisplayRate(
      measured([
        { hz: 30, share: 0.55 },
        { hz: 90, share: 0.35 },
      ]),
    )
    expect(rate?.displayHz).toBe(90)
    expect(rate?.tierHz).toBe(30)
  })

  it('leaves a machine that is keeping up alone', () => {
    const clean = resolveDisplayRate(measured([{ hz: 90, share: 0.98 }]))
    expect(clean?.displayHz).toBe(90)
    expect(clean?.tierHz).toBe(90)
    expect(clean?.dropping).toBe(0)

    // A flat 60 Hz monitor is the same case and must not acquire a tier.
    const monitor = resolveDisplayRate(measured([{ hz: 60, share: 1 }]))
    expect(monitor?.displayHz).toBe(60)
    expect(monitor?.tierHz).toBe(60)
  })

  it('tolerates the jitter a streamed headset puts in a half-rate bin', () => {
    // 45 is NOT in `KNOWN_REFRESH_HZ`, so it keeps its raw integer bin and a
    // streamed interval lands on 44 or 46 as readily as 45. A rule that
    // demanded an exact half would see two unrelated rates and fall back to
    // `default` on the one window that matters most.
    const rate = resolveDisplayRate(
      measured([
        { hz: 44, share: 0.55 },
        { hz: 90, share: 0.4 },
      ]),
    )
    expect(rate?.displayHz).toBe(90)
    expect(rate?.tierHz).toBe(44)
  })

  it('does NOT mistake 60 for half of 90 — the tolerance has a ceiling', () => {
    // The separating case for `TIER_RATIO_TOLERANCE`. 90/2 is 45 and 60 is 33 %
    // away from it; a tolerance wide enough to swallow that would turn every
    // dual-monitor window into a phantom 120 Hz display.
    const rate = resolveDisplayRate(
      measured([
        { hz: 60, share: 0.6 },
        { hz: 90, share: 0.35 },
      ]),
    )
    // No family, so the mode stands on its own and there is no tier.
    expect(rate?.displayHz).toBe(60)
    expect(rate?.tierHz).toBe(60)
    expect(rate?.dropping).toBe(0)
  })

  it('refuses a window that agrees about nothing', () => {
    // Scatter across four bins, none of them a multiple of another. The honest
    // answer is "this machine has no refresh rate", and the caller labels it
    // `default` so the reading is visibly a guess.
    expect(
      resolveDisplayRate(
        measured([
          { hz: 51, share: 0.3 },
          { hz: 58, share: 0.25 },
          { hz: 67, share: 0.25 },
          { hz: 41, share: 0.2 },
        ]),
      ),
    ).toBeNull()
    expect(resolveDisplayRate(null)).toBeNull()
  })

  it('accepts the PAIR on a combined share the mode alone would fail', () => {
    // The mechanism that ended the flap. 0.45 and 0.45 are each under
    // `MEASURED_MIN_SHARE`, so the old resolver refused the window and stamped
    // it `default 72`. Together they are 0.9 of a 90 Hz display, which is a
    // confident reading of a machine in trouble — the case DEV-160 §4 called
    // out as the honest failure this row should fix.
    const rate = resolveDisplayRate(
      measured([
        { hz: 45, share: 0.45 },
        { hz: 90, share: 0.45 },
      ]),
    )
    expect(rate?.displayHz).toBe(90)
    expect(rate?.share).toBeCloseTo(0.9, 6)
  })

  it('drives the BUDGET off the display, not off the rate we are getting', () => {
    // The end-to-end assertion, and the one that would have caught the worn
    // bug: the controller must judge the frames against 11.1 ms.
    const q = createQualityController(sessionRendererNoRate(), {
      measuredHz: () =>
        measured([
          { hz: 45, share: 0.6 },
          { hz: 90, share: 0.4 },
        ]),
    })
    q.apply(DEFAULT_SETTINGS)
    q.frame(1 / 45)
    expect(q.report.targetSource).toBe('measured')
    expect(q.report.targetSeconds).toBeCloseTo(1 / 90, 9)
    expect(q.report.displayHz).toBe(90)
    expect(q.report.tierHz).toBe(45)
    expect(q.report.droppingFraction).toBeCloseTo(0.6, 6)
    expect(q.report.measuredShare).toBeCloseTo(1, 6)
  })
})

describe('the hysteresis on a change of budget', () => {
  /** Feed `seconds` of frames at `dt`, with the reading the fake returns. */
  const fly = (
    q: ReturnType<typeof createQualityController>,
    dt: number,
    seconds: number,
  ): void => {
    for (let i = 0; i < Math.round(seconds / dt); i++) q.frame(dt)
  }

  it('adopts the FIRST budget at once, without serving a wait', () => {
    // Two seconds of a session judged against the flat build's 16.7 ms is two
    // seconds of the adaptive controller being told it has headroom it does
    // not have — on the two seconds where the programs compile.
    const q = createQualityController(sessionRendererNoRate(), {
      measuredHz: () => ({ hz: 90, share: 1, frames: 260, candidates: [{ hz: 90, share: 1 }] }),
    })
    q.apply(DEFAULT_SETTINGS)
    expect(q.report.targetSeconds).toBeCloseTo(1 / 90, 9)
    expect(q.report.targetSource).toBe('measured')
  })

  it('will not move the budget on a wobble shorter than BUDGET_ADOPT_SECONDS', () => {
    // The property the constant actually delivers. The reading flips every
    // half second between a coherent 90 and scatter; a resolver with no
    // hysteresis prints a new budget line twice a second for the whole lap,
    // which is what sixty lines in one worn lap looked like.
    const coherent = { hz: 90, share: 1, frames: 260, candidates: [{ hz: 90, share: 1 }] }
    const scatter = {
      hz: 51,
      share: 0.3,
      frames: 260,
      candidates: [
        { hz: 51, share: 0.3 },
        { hz: 58, share: 0.3 },
      ],
    }
    let flip = 0
    const q = createQualityController(sessionRendererNoRate(), {
      measuredHz: () => (Math.floor(flip / 0.5) % 2 === 0 ? coherent : scatter),
    })
    q.apply(DEFAULT_SETTINGS)
    const dt = 1 / 90
    let adoptions = 0
    let last = q.report.targetSeconds
    for (let i = 0; i < 90 * 30; i++) {
      flip += dt
      q.frame(dt)
      if (Math.abs(q.report.targetSeconds - last) > 1e-9) {
        adoptions += 1
        last = q.report.targetSeconds
      }
    }
    expect(adoptions).toBe(0)
    expect(q.report.targetSeconds).toBeCloseTo(1 / 90, 9)
  })

  it('DOES adopt a change that holds, and only once', () => {
    // The other half: hysteresis that never adopts is not hysteresis, it is a
    // frozen budget. SteamVR's refresh really can be changed under a running
    // session, and the plate has to follow it.
    let hz = 90
    const q = createQualityController(sessionRendererNoRate(), {
      measuredHz: () => ({ hz, share: 1, frames: 260, candidates: [{ hz, share: 1 }] }),
    })
    q.apply(DEFAULT_SETTINGS)
    fly(q, 1 / 90, 5)
    expect(q.report.targetSeconds).toBeCloseTo(1 / 90, 9)

    hz = 72
    // Less than the wait: still the old budget.
    fly(q, 1 / 72, BUDGET_ADOPT_SECONDS * 0.5)
    expect(q.report.targetSeconds).toBeCloseTo(1 / 90, 9)
    // Past it: adopted, and then it stays put.
    fly(q, 1 / 72, BUDGET_ADOPT_SECONDS)
    expect(q.report.targetSeconds).toBeCloseTo(1 / 72, 9)
    let moves = 0
    let last = q.report.targetSeconds
    for (let i = 0; i < 72 * 30; i++) {
      q.frame(1 / 72)
      if (Math.abs(q.report.targetSeconds - last) > 1e-9) {
        moves += 1
        last = q.report.targetSeconds
      }
    }
    expect(moves).toBe(0)
  })

  it('takes ONE adoption from the worn flap, not thirty', () => {
    // The worn failure, scripted: the mode's share hovers either side of
    // `MEASURED_MIN_SHARE` (0.58 / 0.62) every window, and the old resolver
    // flipped between `measured 45` and `default 72` each time.
    //
    // The hysteresis is NOT what fixes this — a flap whose period is three
    // seconds has held for two, so it would be adopted every window. The RULE
    // fixes it: 45 and 90 are one family whose combined share is ~1.0 whatever
    // the split, so the budget is 11.1 ms in every one of those windows and
    // there is no edge to print.
    let t = 0
    const q = createQualityController(sessionRendererNoRate(), {
      measuredHz: () => {
        const low = Math.floor(t / 3) % 2 === 0 ? 0.58 : 0.62
        return {
          hz: 45,
          share: low,
          frames: 260,
          candidates: [
            { hz: 45, share: low },
            { hz: 90, share: 1 - low },
          ],
        }
      },
    })
    q.apply(DEFAULT_SETTINGS)
    const dt = 1 / 45
    let adoptions = 0
    let last = 0
    for (let i = 0; i < 45 * 60; i++) {
      t += dt
      q.frame(dt)
      const now = q.report.targetSeconds
      if (Math.abs(now - last) > 1e-9) {
        adoptions += 1
        last = now
      }
    }
    // One: the first resolution. Never again for the rest of the minute.
    expect(adoptions).toBe(1)
    expect(q.report.targetSeconds).toBeCloseTo(1 / 90, 9)
    expect(q.report.targetSource).toBe('measured')
  })

  it('advances the budget clock even with adaptive resolution OFF', () => {
    // `?adaptive=0` is the MEASURING configuration (perf-protocol §3). The
    // hysteresis clock lives outside the adaptive guard in `frame()` for
    // exactly this: a budget frozen at whatever the first frame resolved would
    // stamp every trace header of every row we take.
    let hz = 90
    const q = createQualityController(sessionRendererNoRate(), {
      measuredHz: () => ({ hz, share: 1, frames: 260, candidates: [{ hz, share: 1 }] }),
    })
    q.apply({ ...DEFAULT_SETTINGS, adaptiveResolution: false })
    fly(q, 1 / 90, 3)
    hz = 72
    fly(q, 1 / 72, BUDGET_ADOPT_SECONDS * 2)
    expect(q.report.targetSeconds).toBeCloseTo(1 / 72, 9)
    // ...and the resolution still never moved, which is the other half of OFF.
    expect(q.report.scale).toBe(1)
  })
})

// ── A display rate is a fact about the SESSION (DEV-179) ──────────────────
//
// DEV-161's rule needs both R and R/2 inside ONE 3 s window to name R. Lap 4
// spent whole windows entirely inside the 30 Hz tier — the trace binned
// `30 @ 0.65` with `45 / 22 / 23` beside it and **no 90 at all**, because only
// 6 of 2,364 flying frames made 90 Hz. No family reaches `MEASURED_MIN_SHARE`,
// so the resolver falls through to its last rule (*the mode is the display and
// we are getting every frame of it*) and answers 30: a 33.3 ms budget, and a
// report that the app has three times the headroom it has, at the moment it has
// least.
//
// `BUDGET_ADOPT_SECONDS` cannot fix that and raising it never could — a flap
// whose period is seconds has held for two. What fixes it is that a display's
// refresh does not change because we stopped hitting it.
describe('a sticky display rate', () => {
  /** Lap 4's window, as the trace binned it: no 90 anywhere in it. */
  const LAP_4: MeasuredHz = {
    hz: 30,
    share: 0.65,
    frames: 260,
    candidates: [
      { hz: 30, share: 0.65 },
      { hz: 45, share: 0.15 },
      { hz: 22, share: 0.1 },
      { hz: 23, share: 0.1 },
    ],
  }
  /** The first seconds of the same session, before the GPU cost crossed 11 ms. */
  const CLEAN_90: MeasuredHz = {
    hz: 90,
    share: 0.98,
    frames: 260,
    candidates: [{ hz: 90, share: 0.98 }],
  }
  /** Lap 1's window: half rate, with the display still visible beside it. */
  const TIERED_90: MeasuredHz = {
    hz: 45,
    share: 0.6,
    frames: 260,
    candidates: [
      { hz: 45, share: 0.6 },
      { hz: 90, share: 0.4 },
    ],
  }

  /**
   * A presenting renderer that reports no `frameRate` and whose session events
   * can be fired — `sessionRendererNoRate()` plus `fakeRenderer()`'s listener
   * table, and a `presenting` flag a test can flip, because the leak DEV-178
   * found is only reachable by crossing that boundary.
   */
  const rig = (presenting = true) => {
    const listeners = new Map<string, (() => void)[]>()
    const state = { presenting }
    const renderer = {
      setPixelRatio: () => {},
      xr: {
        get isPresenting() {
          return state.presenting
        },
        getSession: () => ({}),
        setFoveation: () => {},
        setFramebufferScaleFactor: () => {},
        addEventListener: (type: string, fn: () => void) => {
          listeners.set(type, [...(listeners.get(type) ?? []), fn])
        },
        removeEventListener: () => {},
      },
    }
    return {
      renderer: renderer as unknown as THREE.WebGLRenderer,
      state,
      fire: (type: string) => {
        for (const fn of listeners.get(type) ?? []) fn()
      },
    }
  }

  /** Feed `seconds` of frames at `dt`. */
  const fly = (
    q: ReturnType<typeof createQualityController>,
    dt: number,
    seconds: number,
  ): void => {
    for (let i = 0; i < Math.round(seconds / dt); i++) q.frame(dt)
  }

  it('reads lap 4’s window ON ITS OWN as a 30 Hz display — the bug, unchanged', () => {
    // THE CONTROL, and the test below means nothing without it. A controller
    // that has never seen 90 has no evidence of one, and 30 is the honest
    // reading of this window: `resolveDisplayRate` is unchanged and still says
    // so. So when the same window resolves to 90 further down, the difference
    // cannot be the resolver getting cleverer — it is the session remembering,
    // which is the only thing that moved.
    const { renderer } = rig()
    const q = createQualityController(renderer, { measuredHz: () => LAP_4 })
    q.apply(DEFAULT_SETTINGS)
    q.frame(1 / 30)
    expect(q.report.displayHz).toBe(30)
    expect(q.report.targetSeconds).toBeCloseTo(1 / 30, 9)
    expect(q.report.displaySticky).toBe(false)
  })

  it('holds 90 through the rest of the lap once 90 has been seen', () => {
    // The session as it was actually flown: a few seconds where the frames are
    // still arriving, then a minute inside the tier.
    let window: MeasuredHz = CLEAN_90
    const { renderer } = rig()
    const q = createQualityController(renderer, { measuredHz: () => window })
    q.apply(DEFAULT_SETTINGS)
    fly(q, 1 / 90, 3)
    expect(q.report.displayHz).toBe(90)

    window = LAP_4
    fly(q, 1 / 30, 60)
    expect(q.report.displayHz).toBe(90)
    expect(q.report.targetSeconds).toBeCloseTo(1 / 90, 9)
    expect(q.report.displaySticky).toBe(true)
    // And the TIER still follows the window — the one half a session-long
    // memory must never supply. `90 Hz display · app 30 Hz` is the pair the
    // whole row exists to print; a sticky tier would make them agree for ever
    // and say nothing.
    expect(q.report.tierHz).toBe(30)
  })

  it('never lowers the budget inside a session, whatever order the windows come in', () => {
    // The property, over a scripted lap rather than over one window. A budget
    // that LOOSENS mid-lap is the failure: it tells the adaptive controller it
    // has headroom at the moment it has least, so `displayHz` must be
    // non-decreasing across the whole flight however the tier moves.
    //
    // Asserted as a relationship over the sequence, not against a table of
    // expected values — a table would be this test re-deriving the rule the way
    // the code does (CLAUDE.md trap 24).
    const script: readonly MeasuredHz[] = [
      CLEAN_90,
      TIERED_90,
      LAP_4,
      LAP_4,
      TIERED_90,
      LAP_4,
      CLEAN_90,
      LAP_4,
    ]
    let at = 0
    const { renderer } = rig()
    const q = createQualityController(renderer, {
      measuredHz: () => script[at] as MeasuredHz,
    })
    q.apply(DEFAULT_SETTINGS)

    let lowest = 0
    let budgetChanges = 0
    let lastBudget = 0
    let sawATier = false
    for (at = 0; at < script.length; at++) {
      // Five seconds on each window — longer than `BUDGET_ADOPT_SECONDS`, so
      // every one of them gets its chance to move the budget.
      const dt = 1 / (script[at] as MeasuredHz).hz
      for (let i = 0; i < Math.round(5 / dt); i++) {
        q.frame(dt)
        const r = q.report
        expect(r.displayHz, `window ${at}`).toBeGreaterThanOrEqual(lowest)
        lowest = r.displayHz
        if (Math.abs(r.targetSeconds - lastBudget) > 1e-9) {
          budgetChanges += 1
          lastBudget = r.targetSeconds
        }
        if (r.tierHz !== r.displayHz) sawATier = true
      }
    }
    // One: the first resolution, and never again for the rest of the flight.
    // The worn console printed this line about sixty times in one lap.
    expect(budgetChanges).toBe(1)
    expect(q.report.targetSeconds).toBeCloseTo(1 / 90, 9)
    // ...while the tier moved under it, which is the point of holding it still.
    expect(sawATier).toBe(true)
  })

  it('forgets the headset’s rate at both ends of a session — DEV-178’s leak', () => {
    // The trap this row could have walked straight into. 90 Hz is a fact about
    // the HEADSET; a flat page that inherited it would judge its own frames
    // against 11.1 ms and walk the pixel ratio to the floor, which is DEV-178's
    // bug with the sign reversed.
    let window: MeasuredHz = CLEAN_90
    const { renderer, state, fire } = rig(true)
    const q = createQualityController(renderer, { measuredHz: () => window })
    q.apply(DEFAULT_SETTINGS)
    fly(q, 1 / 90, 3)
    expect(q.report.displayHz).toBe(90)

    // Take the headset off.
    state.presenting = false
    fire('sessionend')
    expect(q.report.targetSource).toBe('flat')

    // Put it back on, onto a lap that never once reaches its display's rate.
    // Without the reset this would still be 90, carried across two displays.
    state.presenting = true
    fire('sessionstart')
    window = LAP_4
    fly(q, 1 / 30, 10)
    expect(q.report.displayHz).toBe(30)
    expect(q.report.displaySticky).toBe(false)
  })

  it('still follows a refresh rate that genuinely changed under the session', () => {
    // The other side of the rule, and the case that makes it a rule rather than
    // a latch: SteamVR's refresh can be changed while the app is running, and
    // 72 is not a tier of 90 — no whole division of 90 lands near it. A latch
    // would judge a 72 Hz session against 11.1 ms for ever.
    let window: MeasuredHz = CLEAN_90
    const { renderer } = rig()
    const q = createQualityController(renderer, { measuredHz: () => window })
    q.apply(DEFAULT_SETTINGS)
    fly(q, 1 / 90, 3)
    expect(q.report.displayHz).toBe(90)

    window = { hz: 72, share: 0.98, frames: 260, candidates: [{ hz: 72, share: 0.98 }] }
    fly(q, 1 / 72, BUDGET_ADOPT_SECONDS * 2)
    expect(q.report.displayHz).toBe(72)
    expect(q.report.targetSeconds).toBeCloseTo(1 / 72, 9)
  })

  it('calls every whole division of a display a sub-rate, and no real refresh one', () => {
    // The rule that separates "us, inside a tier" from "a display that
    // changed". Generated on both sides rather than listed, so it is the
    // PROPERTY that is asserted: every 90/k is a sub-rate, and every rate a
    // display is actually built to run at is not.
    const display = 90
    const divisions: number[] = []
    for (let k = 2; k <= 6; k++) {
      const tier = display / k
      divisions.push(tier)
      expect(isSubRateOf(display, tier), `${display}/${k} = ${tier}`).toBe(true)
    }
    for (const hz of KNOWN_REFRESH_HZ) {
      if (hz >= display) continue
      if (divisions.some((d) => Math.abs(hz - d) <= d * TIER_RATIO_TOLERANCE)) continue
      expect(isSubRateOf(display, hz), `${hz} Hz is a display, not a tier of ${display}`).toBe(
        false,
      )
    }
    // 60 is the one a loose tolerance would swallow — it is two thirds of 90,
    // and `round(90 / 60)` is 2, so only the distance check refuses it.
    expect(isSubRateOf(90, 60)).toBe(false)
  })

  it('is monotone in the session’s own knowledge, for any window at all', () => {
    // `stickyDisplayHz` on its own, and the property is the one the controller
    // rests on: holding the session's knowledge fixed, the answer is never
    // LOWER than that knowledge unless the window names something that could
    // not be a tier of it. Swept over every pair of known refresh rates rather
    // than over a chosen few.
    for (const held of KNOWN_REFRESH_HZ) {
      for (const seen of KNOWN_REFRESH_HZ) {
        const out = stickyDisplayHz(null, held, seen)
        if (seen >= held) expect(out, `${held} then ${seen}`).toBe(seen)
        else expect(out, `${held} then ${seen}`).toBe(isSubRateOf(held, seen) ? held : seen)
      }
      // No window at all — a 3 s window that agreed about nothing — leaves the
      // session's knowledge alone rather than falling back to the 72 Hz guess.
      expect(stickyDisplayHz(null, held, 0)).toBe(held)
    }
  })

  it('takes the ?hz= pin over both, and keeps the tier measured', () => {
    // The switch for the run that never once reaches its display's rate, where
    // no window contains the evidence and there is nothing to latch. Somebody
    // who has just set SteamVR to 90 knows the answer.
    const { renderer, fire } = rig()
    const q = createQualityController(renderer, { measuredHz: () => LAP_4, displayHz: 90 })
    q.apply(DEFAULT_SETTINGS)
    q.frame(1 / 30)
    expect(q.report.displayHz).toBe(90)
    expect(q.report.targetSeconds).toBeCloseTo(1 / 90, 9)
    expect(q.report.targetSource).toBe('override')
    // The tier is still this window's — a pin states the display and nothing
    // else, so `90 Hz display · app 30 Hz` reads true under it.
    expect(q.report.tierHz).toBe(30)
    // And no share: the window's 0.65 did not decide this number and must not
    // be printed as though it had.
    expect(q.report.measuredShare).toBeNull()

    // A pin is a fact about the LOAD, so a session boundary does not clear it —
    // unlike the measured high-water mark beside it.
    fire('sessionstart')
    q.frame(1 / 30)
    expect(q.report.displayHz).toBe(90)
  })
})

// ── DEV-262: the controller decides on OUR cost, not on the wall clock ──────
//
// Matt, on what "adaptive quality working" has to mean: the app runs in budget,
// and scales appropriately when it does not. The half that was broken is which
// number "in budget" is read off.
describe('the adaptive controller reads our COST, not the compositor’s pacing', () => {
  /** The worn lap, as numbers: SteamVR's 45 Hz tier against a 90 Hz budget. */
  const TIER_DT = 0.0222
  const BUDGET_HZ = 90
  /** GPU 5.07 ms, main thread 3.0 ms — the measured worn cost. The max is ours. */
  const WORN_COST = 0.00507

  it('does NOT step down when the frame is long but the COST is not', () => {
    // THE regression, and it is a worn reading rather than a hypothetical.
    // 2026-09-20, `rookie_01_hoverJet`, three laps: `dt` p50 22.20 ms with GPU
    // p50 5.07 ms and only 0.12 % of frames over the 11.11 ms interval. The
    // controller saw 22.2 > 11.11 x 1.08, called it over budget and walked to
    // the floor — `scale` 0.600 on all 12,866 frames — with 60 % of the frame
    // spare. There is nothing to render our way out of: the tier is SteamVR's.
    const state = createAdaptiveState()
    const cfg = config(BUDGET_HZ)
    for (let i = 0; i < Math.round(60 / TIER_DT); i++) {
      stepAdaptive(state, TIER_DT, cfg, WORN_COST)
    }
    expect(state.stepIndex, 'a minute in a 45 Hz tier must not cost a single step').toBe(0)
    expect(adaptiveScale(state)).toBe(1)
  })

  it('and the SAME stream steps to the floor when the cost is left as dt', () => {
    // The control that makes the assertion above mean something: identical
    // frames, identical config, the only difference being which quantity the
    // controller is handed. Without this the test above would pass on a
    // controller that had simply stopped working.
    const state = createAdaptiveState()
    const cfg = config(BUDGET_HZ)
    for (let i = 0; i < Math.round(60 / TIER_DT); i++) stepAdaptive(state, TIER_DT, cfg)
    expect(state.stepIndex, 'the old signal walks to the floor').toBe(ADAPTIVE_STEPS.length - 1)
  })

  it('still steps down when WE are the ones over budget', () => {
    // The other half, and the one that would be easy to break while fixing the
    // first: a genuinely slow machine must still be scaled down. Here the wall
    // clock and the cost agree, which is every non-tiered display.
    const state = createAdaptiveState()
    const cfg = config(BUDGET_HZ)
    const slow = 0.02
    for (let i = 0; i < Math.round(10 / slow); i++) stepAdaptive(state, slow, cfg, slow)
    expect(state.stepIndex).toBeGreaterThan(0)
  })

  it('climbs back once our cost drops, even while the compositor keeps pacing us', () => {
    // "It never recovers even when it could" — Matt. A controller that stepped
    // down for a real reason must come back when the reason goes, and on a
    // streamed headset the wall clock may never improve to tell it so.
    const state = createAdaptiveState()
    const cfg = config(BUDGET_HZ)
    const slow = 0.02
    for (let i = 0; i < Math.round(10 / slow); i++) stepAdaptive(state, slow, cfg, slow)
    const dropped = state.stepIndex
    expect(dropped).toBeGreaterThan(0)
    // The tier holds at 45 Hz throughout: `dt` never improves. Only the cost does.
    for (let i = 0; i < Math.round(60 / TIER_DT); i++) {
      stepAdaptive(state, TIER_DT, cfg, WORN_COST)
    }
    expect(state.stepIndex, 'it climbs back on the cost alone').toBeLessThan(dropped)
  })

  it('falls back to dt when no cost is given, so an old caller is unchanged', () => {
    // The compatibility claim, asserted rather than assumed: the parameter is
    // optional and every existing caller and test relies on the old meaning.
    const a = createAdaptiveState()
    const b = createAdaptiveState()
    const cfg = config(BUDGET_HZ)
    for (let i = 0; i < 400; i++) {
      stepAdaptive(a, TIER_DT, cfg)
      stepAdaptive(b, TIER_DT, cfg, TIER_DT)
    }
    expect(a.stepIndex).toBe(b.stepIndex)
    expect(a.ema).toBeCloseTo(b.ema, 12)
  })
})
