// src/boot/capability-gate.ts — decide what this visitor can actually play
// before offering it to them (PORT_PLAN §2.8, risk F12).
//
// This is an hour of routing that converts a bounce into a watched trailer,
// and it matters concretely: **Apple Vision Pro's Safari supports
// `immersive-vr` and has no thumbsticks**, so a link opened there would enter
// VR and be unplayable — worse than an honest refusal. Phones get the attract
// loop, not a broken game.

import { touchOverride, xrProbeOff } from './switches'

export type PlayRoute =
  /** Headset + a stick to fly with. The real thing. */
  | 'vr'
  /** Flat screen with keyboard or a standard gamepad. */
  | 'flat'
  /** Neither. Show the flyby and say why, with the supported-device list. */
  | 'attract'

export interface Capabilities {
  immersiveVr: boolean
  standardGamepad: boolean
  keyboard: boolean
  /** A touchscreen is the PRIMARY pointer — a phone or a tablet. See `hasTouchscreen`. */
  touch: boolean
  route: PlayRoute
  /**
   * The headset probe's answer, still on its way, when boot stopped waiting
   * for it (DEV-603); null when it answered in time or was never asked. The
   * title's ENTER VR row asks again when it lands.
   */
  xrProbeLate: Promise<boolean> | null
}

/**
 * How long boot waits for `isSessionSupported` before it goes on as flat.
 * DEV-603.
 *
 * The 2026-10-03 persona playtest measured the cost on this laptop, which has
 * SteamVR as its OpenXR runtime and no headset plugged in: the probe answered
 * `false` in 8.4 to 8.8 s on every flat load, and the title was ready at 14 to
 * 18 s against 4.5 s with a headset that answers at once. Every SteamVR owner
 * without a headset on pays that, and they are this game's audience. A runtime
 * that is already up (a headset in use) answers in well under this.
 *
 * Past the deadline the page boots FLAT and the probe is left to finish. If it
 * then says yes, `xrProbeLate` resolves true and the ENTER VR row asks again
 * (fast, the runtime being up by then) and lights; H and a press of the row ask
 * again anyway. What a late headset costs: `route` is `flat` for that load
 * (the warm-up does not also compile for the headset's target, so entering
 * compiles then).
 */
export const XR_PROBE_DEADLINE_MS = 1500

/** What the deadline came to: the answer, or "not yet" and the answer still to come. */
export type ProbeOutcome =
  | { readonly kind: 'answered'; readonly immersiveVr: boolean }
  | { readonly kind: 'late'; readonly answer: Promise<boolean> }

/**
 * Race `ask` against `deadlineMs`. A rejection is a `false` (some browsers
 * reject rather than resolve false), in time or late.
 */
export const probeWithDeadline = async (
  ask: () => Promise<boolean>,
  deadlineMs: number,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ProbeOutcome> => {
  const answer = ask().then(
    (ok) => ok === true,
    () => false,
  )
  const LATE = Symbol('late')
  const first = await Promise.race([answer, wait(deadlineMs).then(() => LATE)])
  return typeof first === 'boolean'
    ? { kind: 'answered', immersiveVr: first }
    : { kind: 'late', answer }
}

const hasStandardGamepad = (): boolean => {
  const pads = navigator.getGamepads?.() ?? []
  for (const pad of pads) if (pad?.connected && pad.mapping === 'standard') return true
  return false
}

/**
 * A coarse but honest keyboard test: no touch points and a pointer that can
 * hover implies a real keyboard far more reliably than sniffing user agents.
 */
const hasKeyboard = (): boolean =>
  (navigator.maxTouchPoints ?? 0) === 0 ||
  globalThis.matchMedia?.('(hover: hover)').matches === true

/**
 * `?touch=1` / `?touch=0` — answer the touchscreen question by hand.
 *
 * NOT a test-only branch, and it must not become one: it selects the same
 * controls a phone gets, built by the same code, driven by the same events.
 * What it buys is the ability to LOOK at them on a desktop, and a way out for
 * the two devices the media query gets wrong in opposite directions — a
 * touchscreen laptop that does not want a thumbstick over its game, and an
 * iPad with a trackpad attached, which reports a fine pointer and still has a
 * sheet of glass in front of it.
 *
 * `hasTouchscreen` below is what a real phone takes, and no spec may set this
 * to reach behaviour a phone could not. `mobile-controls.spec.ts` emulates a
 * real device instead — `hasTouch`, `isMobile`, a coarse pointer — so the
 * detection itself is on the tested path. CLAUDE.md, "never make the test
 * harness take a different code path to get green".
 *
 * The reader is `touchOverride` in `./switches` (the leaf), BE-15.
 */

/**
 * Is a finger the way this device is driven?
 *
 * Both halves are load-bearing. `maxTouchPoints` alone says a touchscreen
 * EXISTS, which is true of a great many laptops whose owner has never touched
 * the screen; `(pointer: coarse)` alone is the PRIMARY pointer being imprecise,
 * which is what actually decides whether a 46 px chip is reachable. Together
 * they are "a phone or a tablet", and they are what the platform will tell you
 * — unlike a user agent, which on an iPad has claimed to be a Mac since 2019.
 */
export const hasTouchscreen = (): boolean =>
  (navigator.maxTouchPoints ?? 0) > 0 &&
  globalThis.matchMedia?.('(pointer: coarse)').matches === true

/**
 * Ask what this visitor can play. Under `?xr=off` (`switches.ts`) it answers
 * "no headset" without asking the platform.
 *
 * `isSessionSupported('immersive-vr')` is not a passive query: it starts the
 * machine's OpenXR runtime. On a Windows box whose registered runtime is
 * SteamVR (`HKLM\SOFTWARE\Khronos\OpenXR\1\ActiveRuntime` pointing at
 * `steamxr_win64.json`) that means every page load launches Steam — and a
 * screenshot sweep loads the page twenty times.
 *
 * So the switch is for the screenshot and gameplay specs, which want the flat
 * route and never enter VR. It is deliberately NOT wired into `xr-support.ts`:
 * the specs that exist to test the probe must still make it.
 */
export const detectCapabilities = async (): Promise<Capabilities> => {
  let immersiveVr = false
  let xrProbeLate: Promise<boolean> | null = null
  // The reader lives in `./switches` (a leaf), not in `./app/pins`: that one
  // imports three and `import.meta.glob`, which this file must never reach.
  if (!xrProbeOff()) {
    // DEV-413: timed, because boot awaits this before the renderer and the
    // title exist, and on a SteamVR box it starts the runtime. With the probe
    // skipped, a cold load of the live site reached the title in 4.1-4.4 s
    // (2026-09-26); Matt sees over 10 s. This line is how a real load says
    // what the probe costs, rather than a guess.
    const asked = performance.now()
    const ms = () => Math.round(performance.now() - asked)
    // DEV-603: waited on for XR_PROBE_DEADLINE_MS at most.
    const outcome = await probeWithDeadline(
      async () => (await navigator.xr?.isSessionSupported('immersive-vr')) === true,
      XR_PROBE_DEADLINE_MS,
    )
    if (outcome.kind === 'answered') {
      immersiveVr = outcome.immersiveVr
      console.info(
        `xr probe: isSessionSupported('immersive-vr') answered ${immersiveVr} in ${ms()} ms (boot waits on it)`,
      )
    } else {
      xrProbeLate = outcome.answer
      console.info(
        `xr probe: no answer in ${XR_PROBE_DEADLINE_MS} ms; booting flat, the answer still coming (DEV-603)`,
      )
      void xrProbeLate.then((late) =>
        console.info(
          `xr probe: isSessionSupported('immersive-vr') answered ${late} late, in ${ms()} ms`,
        ),
      )
    }
  }

  const standardGamepad = hasStandardGamepad()
  const keyboard = hasKeyboard()
  const touch = touchOverride() ?? hasTouchscreen()

  // NOTE: XR controllers are NOT visible to `navigator.getGamepads()` before a
  // session starts — they arrive as `XRInputSource.gamepad` with mapping
  // `xr-standard` once the session is running. So `standardGamepad` here means
  // "a desktop-style pad is plugged in", and it cannot be used to decide
  // whether a headset has sticks. The Vision Pro case (immersive-vr supported,
  // no thumbsticks anywhere) is therefore settled by `hasFlightSticks` below,
  // AFTER session start. Gating on `standardGamepad` here would send every
  // Quest user to the attract loop.
  //
  // ── A phone is FLAT now, not attract ──────────────────────────────────
  //
  // It used to be attract, and the landing page said so: *"Not supported:
  // phones and tablets"*. That was true of a build with three input readers,
  // all of which need hardware a phone does not have — but the reason given for
  // the attract route is *"a cockpit you cannot fly"*, and a phone with two
  // thumbs can fly one. `input/touch-overlay.ts` is the fourth reader, and it
  // is the same 2016 scheme "a" the other three produce (DEV-104).
  //
  // Note which way this reads: `touch` ADDS a route, it never removes one. A
  // Quest browser reports both a touchscreen and `immersive-vr`, and `vr` still
  // wins — the order of this expression is the whole guarantee of that.
  const route: PlayRoute = immersiveVr
    ? 'vr'
    : standardGamepad || keyboard || touch
      ? 'flat'
      : 'attract'

  return { immersiveVr, standardGamepad, keyboard, touch, route, xrProbeLate }
}

/**
 * Post-session-start check for the Vision Pro case. Call once the session's
 * input sources have arrived; if it returns false, end the session and fall
 * back to the attract route with the supported-device list, rather than
 * leaving the visitor inside an unflyable cockpit.
 */
export const hasFlightSticks = (session: XRSession): boolean => {
  for (const src of session.inputSources) {
    const axes = src.gamepad?.axes
    if (axes && axes.length >= 2) return true
  }
  return false
}
