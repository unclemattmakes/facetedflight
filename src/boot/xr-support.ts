// src/boot/xr-support.ts — "why is there no VR button?", answered.
//
// `capability-gate.ts` decides *what this visitor gets* (vr / flat / attract).
// This module answers the next question, which is a support question rather
// than a routing one: **when immersive-vr is unavailable, what exactly is
// missing, and what should the human do about it?** That question is asked
// constantly during development and almost always from inside a headset,
// where there is no URL bar, no devtools and no way to read a stack trace.
//
// Three failure modes account for nearly all of it, and they need different
// answers:
//
//  1. **Insecure context.** `navigator.xr` does not exist on `http://` unless
//     the host is `localhost`. This is the one that bites when you open the
//     LAN address on a headset over plain HTTP (research doc 09 §3.8.1).
//  2. **No WebXR at all.** Firefox ships none, on any platform, and that is
//     not changing (doc 09 §3.3). Safari outside visionOS likewise.
//  3. **WebXR present, no active runtime.** Desktop Chrome/Edge talk to
//     whichever OpenXR runtime is registered as active. If SteamVR is not
//     running, or Meta's runtime has taken the OpenXR key,
//     `isSessionSupported('immersive-vr')` resolves *false* — or rejects
//     outright, which is the long-lived crbug 40727637 shape. Neither is
//     fatal, and neither should ever be reported as "your browser doesn't
//     support VR" (doc 09 §3.2, risk R14).
//
// Kept deliberately free of three.js and of any DOM writes so it can be
// imported from a spec, from the console inside a headset, or from boot.
// See docs/vr-testing.md.

/** Why `immersive-vr` is unavailable. `none` means it is available. */
export type XrBlocker =
  | 'none'
  /** Page is not a secure context — `http://` on a LAN address. */
  | 'insecure-context'
  /** `navigator.xr` is absent: Firefox, or Safari off visionOS. */
  | 'no-webxr-api'
  /** WebXR exists but no OpenXR/device runtime answered. */
  | 'no-active-runtime'
  /** `isSessionSupported()` threw instead of resolving (crbug 40727637). */
  | 'query-rejected'

export interface XrSupportReport {
  readonly secureContext: boolean
  readonly hasXrApi: boolean
  readonly immersiveVr: boolean
  readonly blocker: XrBlocker
  /** One sentence aimed at a human: what is wrong, and what to do next. */
  readonly advice: string
  /**
   * True when `navigator.xr` is not the browser's own implementation — i.e. an
   * emulator or a test double is driving. Heuristic, see `isNativeXrSystem`.
   */
  readonly emulated: boolean
  /** The rejection message, when `blocker` is `query-rejected`. */
  readonly error?: string
}

/**
 * The session init FF2 uses everywhere. **Optional features only, no required
 * ones** — a `requiredFeatures` entry the runtime does not implement fails the
 * whole session, and every feature here is one FF2 can live without
 * (research doc 09 §3.8.3; polyfish does the same).
 */
export const XR_SESSION_INIT: XRSessionInit = {
  optionalFeatures: ['local-floor', 'bounded-floor', 'layers'],
}

/**
 * A native `navigator.xr` is a platform object and stringifies as
 * `[object XRSystem]` via its `Symbol.toStringTag`. A JavaScript class
 * instance — the Immersive Web Emulator's injected runtime, `iwer`, or the
 * test double under `tests/e2e/fixtures/` — stringifies as `[object Object]`
 * unless it goes out of its way not to.
 *
 * This is a heuristic and is documented as one: it is here so the landing page
 * and the logs can say "emulated" out loud instead of quietly reporting a
 * headset that is not in the room. Never gate behaviour on it.
 */
const isNativeXrSystem = (xr: unknown): boolean =>
  Object.prototype.toString.call(xr) === '[object XRSystem]'

const adviceFor = (blocker: XrBlocker, emulated: boolean): string => {
  switch (blocker) {
    case 'none':
      return emulated
        ? 'immersive-vr is available from an emulated WebXR runtime, not a headset.'
        : 'immersive-vr is available.'
    case 'insecure-context':
      return 'WebXR needs a secure context. Open this over https:// or on localhost — a plain http:// LAN address will never expose navigator.xr.'
    case 'no-webxr-api':
      return 'This browser has no WebXR. Firefox ships none on any platform; use Chrome, Edge, or the Quest browser.'
    case 'no-active-runtime':
      return 'WebXR is here but no headset runtime answered. Start SteamVR (or your headset’s runtime) and make sure it is the active OpenXR runtime, then reload.'
    case 'query-rejected':
      return 'The browser threw when asked about immersive-vr — usually a headset runtime that is installed but not running. Start it and reload; flat-screen play is unaffected.'
  }
}

/**
 * Inspect WebXR support without starting a session. Never throws: a rejection
 * from `isSessionSupported` is a *result*, not an error.
 */
export const inspectXrSupport = async (): Promise<XrSupportReport> => {
  const secureContext = globalThis.isSecureContext === true
  const xr = navigator.xr as unknown
  const hasXrApi = xr !== undefined && xr !== null
  const emulated = hasXrApi && !isNativeXrSystem(xr)

  if (!hasXrApi) {
    const blocker: XrBlocker = secureContext ? 'no-webxr-api' : 'insecure-context'
    return {
      secureContext,
      hasXrApi,
      immersiveVr: false,
      blocker,
      advice: adviceFor(blocker, emulated),
      emulated,
    }
  }

  try {
    const immersiveVr = (await navigator.xr?.isSessionSupported('immersive-vr')) === true
    const blocker: XrBlocker = immersiveVr ? 'none' : 'no-active-runtime'
    return {
      secureContext,
      hasXrApi,
      immersiveVr,
      blocker,
      advice: adviceFor(blocker, emulated),
      emulated,
    }
  } catch (cause) {
    return {
      secureContext,
      hasXrApi,
      immersiveVr: false,
      blocker: 'query-rejected',
      advice: adviceFor('query-rejected', emulated),
      emulated,
      error: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

/** A single line fit for the landing page's status paragraph. */
export const describeXrSupport = (report: XrSupportReport): string =>
  report.immersiveVr && !report.emulated ? 'Headset detected — Enter VR is live.' : report.advice

/**
 * Print the report to the console. Call this from a headset's remote devtools,
 * or leave it in dev boot: when a bug report arrives from someone wearing a
 * Quest, this line is the difference between a diagnosis and a guess.
 */
export const logXrSupport = async (): Promise<XrSupportReport> => {
  const report = await inspectXrSupport()
  const tag = report.emulated ? 'XR (emulated)' : 'XR'
  console.info(
    `${tag}: immersive-vr=${report.immersiveVr} blocker=${report.blocker} secure=${report.secureContext} — ${report.advice}`,
  )
  return report
}
