// src/boot/enter-vr.ts: the way into a headset, from inside the game. DEV-557.
//
// Until DEV-557 this lived in `src/main.ts`, behind the landing card's
// `#enter-vr` button: the card was the only place a session could be asked
// for, and since DEV-206 it came back on `sessionend` so a session the RUNTIME
// ended still had a way back in. Matt, 2026-10-01: *"let's get rid of the html
// curtain ... add an enter VR button to the title screen (or "connect vr
// headset" if it can't find one)".* So the request moves here, and two things
// in the game call it: the title's plate (`render/title-vr.ts`) and, while a
// page that has a headset is flat, the pause plate's ENTER VR row (DEV-206's
// route back, which the card used to be).
//
// ── Transient activation, and why a gamepad cannot do this ──────────────
//
// `requestSession('immersive-vr')` needs TRANSIENT user activation: a key, a
// click or a touch within the last few seconds. The game reads its input in
// the frame loop, not in the event handler, which is fine for a key or a
// click: the activation the keydown granted is still live a frame later. A
// GAMEPAD press is not an activation-triggering input in the HTML spec at all
// (a keydown, a mousedown, a pointerdown or pointerup, a touchend are), so a
// pad-only player's press would be refused by the browser. `press` checks
// first and says so (`needs-key`) rather than failing in silence.
//
// ── `?xr=off` ───────────────────────────────────────────────────────────
//
// `isSessionSupported` is not a passive question: on this kind of box it
// STARTS SteamVR (`capability-gate.ts`). A page opened with `?xr=off` never
// asks, so it never re-asks either, not on a press and not on `devicechange`.

import { visibilityMask } from '@/boot/visibility-mask'
import { XR_SESSION_INIT } from '@/boot/xr-support'
import type { TitleVrState } from '@/render/title-vr'

/** What a request for a session came to. */
export type EnterVrOutcome = 'entered' | 'refused' | 'unavailable'

/** The half of three's `WebXRManager` a session is handed to. */
export interface SessionSink {
  setSession(session: XRSession): Promise<void>
}

/**
 * Ask for an immersive session and hand it to three. The order is the one
 * `main.ts` had and `visibility-mask.test.ts` pins: the stored quality onto
 * the renderer BEFORE three builds the layer (`render/quality.ts`), the lens
 * mask's recorder attached BEFORE `setSession` awaits anything (DEV-331).
 */
export const requestImmersiveSession = async (
  sink: SessionSink,
  beforeSession: () => void,
): Promise<EnterVrOutcome> => {
  const xr = globalThis.navigator?.xr
  if (!xr) return 'unavailable'
  try {
    // The stored quality has to be on the renderer BEFORE three builds the XR
    // layer: it reads the framebuffer scale once, at layer creation.
    beforeSession()
    // `XR_SESSION_INIT`, not an inlined list (VR-PERF §5.1, DEV-160): its
    // `'layers'` entry is what lets three's projection-layer path start.
    const session = await xr.requestSession('immersive-vr', XR_SESSION_INIT)
    // DEV-331: the lens mask's initial events fire at session start, so the
    // recorder attaches here, before `setSession` awaits anything.
    visibilityMask.watch(session)
    await sink.setSession(session)
    return 'entered'
  } catch (err) {
    // A refusal (no activation, the runtime said no, a session already
    // running) is a state the plate shows, not an exception for the frame.
    console.warn('enter VR: the session was refused', err)
    return 'refused'
  }
}

/** Ask the platform whether a headset is there. Never called under `?xr=off`. */
export const probeImmersiveVr = async (): Promise<boolean> => {
  try {
    return (await globalThis.navigator?.xr?.isSessionSupported('immersive-vr')) === true
  } catch {
    return false
  }
}

/**
 * Whether the page holds transient user activation now. A browser without the
 * `userActivation` API gets `true`: the request then goes ahead and the
 * browser decides, which is what it did before this check existed.
 */
export const hasTransientActivation = (): boolean =>
  (globalThis.navigator as { userActivation?: { isActive: boolean } } | undefined)?.userActivation
    ?.isActive ?? true

export interface TitleVrDeps {
  /** What boot's capability probe answered; ignored when `probe` is false. */
  readonly supported: boolean
  /** False under `?xr=off`: never ask the platform. */
  readonly probe: boolean
  readonly ask: () => Promise<boolean>
  readonly activation: () => boolean
  readonly enter: () => Promise<EnterVrOutcome>
  /** Subscribe to the platform's device changes; returns the unsubscribe. */
  readonly watchDevices: (onChange: () => void) => () => void
}

export interface TitleVr {
  readonly state: TitleVrState
  /** A headset is there (the press would ask for a session). */
  readonly supported: boolean
  /** A press of the plate, or of the pause plate's ENTER VR row. */
  press(): void
  dispose(): void
}

/**
 * The plate's state machine, with the platform injected so a unit test can
 * drive it. See `TitleVrState` for what each state means.
 */
export const createTitleVr = (d: TitleVrDeps): TitleVr => {
  let state: TitleVrState = !d.probe ? 'off' : d.supported ? 'enter' : 'connect'
  let asking = false
  const ask = (): void => {
    if (!d.probe || asking) return
    asking = true
    if (state === 'connect') state = 'checking'
    void d.ask().then((ok) => {
      asking = false
      // A session in flight keeps its word; anything else follows the answer.
      if (state === 'starting') return
      state = ok ? 'enter' : 'connect'
    })
  }
  const unwatch = d.probe ? d.watchDevices(ask) : () => {}
  return {
    get state() {
      return state
    },
    get supported() {
      return (
        state === 'enter' || state === 'starting' || state === 'needs-key' || state === 'refused'
      )
    },
    press() {
      switch (state) {
        case 'enter':
        case 'needs-key':
        case 'refused':
          if (!d.activation()) {
            state = 'needs-key'
            return
          }
          state = 'starting'
          void d.enter().then((outcome) => {
            state = outcome === 'entered' ? 'enter' : outcome === 'refused' ? 'refused' : 'connect'
          })
          return
        case 'connect':
          ask()
          return
        default:
          // `checking`, `starting`: already asking. `off`: told not to.
          return
      }
    },
    dispose() {
      unwatch()
    },
  }
}

/**
 * `navigator.xr`'s `devicechange`, as `TitleVrDeps.watchDevices` wants it.
 * And the boot probe's late answer (DEV-603), when boot stopped waiting for
 * one: a late `true` calls `onChange` once, as a headset arriving would.
 */
export const watchXrDevices = (
  onChange: () => void,
  late: Promise<boolean> | null = null,
): (() => void) => {
  let live = true
  void late?.then((ok) => {
    if (ok && live) onChange()
  })
  const xr = globalThis.navigator?.xr as
    | {
        addEventListener?: (t: string, f: () => void) => void
        removeEventListener?: (t: string, f: () => void) => void
      }
    | undefined
  xr?.addEventListener?.('devicechange', onChange)
  return () => {
    live = false
    xr?.removeEventListener?.('devicechange', onChange)
  }
}
