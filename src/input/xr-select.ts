// src/input/xr-select.ts — the one button every WebXR device is required to have.
//
// Matt, in a headset: *"i can't pick menu options when in VR mode"* — the gaze
// half of which is DEV-199. This is the other half: even with a perfect pointer,
// committing needs a button, and the one the hangar commits on may not exist.
//
// ── The binding this exists because of, stated at its true strength ───────
//
// `input/xr.ts` reads every control as a raw `xr-standard` index —
// `confirm: pressed(right, 4)`, and `pressed()` is
// `pad?.buttons[i]?.pressed ?? false`, so **an index that is not there is
// silently `false`**. From the WebXR Gamepads Module (transcribed in
// `docs/research/09-web-platform-research.md` §7.2) only **`buttons[0]`, the
// trigger, is REQUIRED**. 1 (squeeze), 2 (touchpad) and 3 (thumbstick) are
// reserved but optional, and **indices >= 4 are not reserved at all** — they
// are per-profile, which is the entire reason `@webxr-input-profiles` exists.
// Nor is there a fallback in a session: XR gamepads MUST NOT appear in
// `navigator.getGamepads()` (§7.3), so the pad path is dead while presenting.
//
// **This is NOT a claim about the Steam Frame, and it was written as one for an
// afternoon.** Measured in the headset, 2026-09-17: both hands report
// `mapping: "xr-standard"` with **SEVEN buttons** and four axes, so index 4 is
// there and `confirm` reads a button that exists. The reasoning that got three
// separate sessions to the opposite conclusion — no `valve-frame*` profile is
// in the registry, therefore the indices may not be there — explains nothing
// about anything that failed. A registry entry is how you *name* a control, not
// whether a runtime *reports* one.
//
// So this file is **defence against the profiles we have not met**, not the
// cure for the one we have. That is weaker and it is true. It is still worth
// landing: the port used the one input a session is actually promised nowhere
// at all, and a binding that depends on an unreserved index is a binding whose
// working is a coincidence of the hardware in the room.
//
// The other finding from that reading explains the rest of it. Both hands
// report **`profiles: ["oculus-touch", "generic-trigger-squeeze-thumbstick"]`**:
// SteamVR tells the browser the Frame's controllers ARE Oculus Touch. The Touch
// profile is trigger, squeeze, a dead slot, thumbstick click, two face buttons
// and a capacitive thumbrest — and **no slot for View or Menu**, so those two
// physical buttons have nowhere to go in the `xr-standard` array and a press of
// one **latches no index at all**. Not an unknown device: a device faithfully
// described as a DIFFERENT device. No binding can reach them, so this file does
// not try — `select` is the trigger, and the pause button is somebody else's
// problem with a different shape.
//
// Read DEV-199's second half before trusting anything an input source says
// about itself: FOUR claims about that one pair of controllers were retracted
// inside a day, all of them from identity strings, while nothing read off a
// latched index was ever wrong. **An identity string is a claim; a latched
// index and a state transition are observations.**
//
// ── What the spec DOES promise ────────────────────────────────────────────
//
// `XRSession` fires `selectstart` / `select` / `selectend` for the **primary
// action** of any input source, on every WebXR device, whatever the profile and
// whatever the button count. A controller's trigger, a hand's pinch, a gaze
// dwell, a tap on a phone screen — the runtime decides what its primary action
// is and the page is told when it happened. It is the one input a session can
// rely on, and a menu is exactly what it is for.
//
// So the trigger commits, **in addition to** right-hand button 4 and without
// removing it: a controller that does report index 4 keeps the binding it has,
// and nothing that cannot be tested here loses anything. `pause` and
// `autopilot` are deliberately untouched — those are a separate defect and a
// separate reading (DEV-199's second half).
//
// `select`, not `selectstart`: it is the "the primary action HAPPENED" event,
// fires once per action, and a press-then-drag-away does not become a commit.
//
// ── The listener is on the SESSION, never on an input source ──────────────
//
// Not a detail, and the headset reading is why. The Frame's controllers arrive
// and are immediately replaced: an **`inputsourceschange +2 -2` one tick after
// they appear**. A listener attached to an `XRInputSource` would be stranded by
// that swap — the object it was on is gone, the session carries on, and the
// button goes quiet for the rest of the session with nothing logged. `follow`
// holds the SESSION, so a swap costs nothing: the session object is unchanged,
// `session === attached` short-circuits, and the same listener keeps firing.
// A future handedness gate would walk straight into this.
//
// ── Not gated on handedness, on purpose ───────────────────────────────────
//
// `XRInputSourceEvent` carries the `inputSource`, so "only the right hand" is
// one line away. It is not taken. A device with one controller, a hand-tracking
// runtime, or a transient pointer (Apple Vision Pro supports `immersive-vr` and
// has no thumbsticks at all — `input/xr.ts` already worries about that case)
// would then be back to a commit that silently never fires, which is the exact
// failure this file exists to end. Either hand commits.
//
// The measurement above hardened that from a preference into a reason: the
// Frame's hands identify as `oculus-touch`, which they are not, so a per-hand
// rule keyed on what a hand SAYS it is would be reasoning about the wrong
// plastic — and the `+2 -2` swap means per-hand state would have to survive a
// re-identification it cannot see coming.
//
// ── WHERE it commits is not this file's business ──────────────────────────
//
// `take(armed)` is handed the answer; `input/confirm.ts` is where the answer
// lives, as `confirmArmed()`. The first cut of this file had its own
// `selectArms(screen, paused)` — a THIRD copy of the confirm handler's branch
// list, in a codebase where `touchConfirmLabel` already warns in prose that two
// copies drift. It also got the arming wrong in the direction that mattered,
// leaving the launch pad and the results plate out on the theory that the
// trigger there is the throttle. It is not: while the prompt says "Press A to
// launch" the ship is HELD, so a mission you could pick and not start was a
// guess costing the exact thing the fix was for. Read `input/confirm.ts`.
//
// ── A `select` is an EVENT; `confirm` is a per-frame BOOLEAN ──────────────
//
// Those do not compose by themselves. An event that lands between two animation
// frames is lost entirely, and one latched but never cleared confirms for ever.
// So it LATCHES and `take()` is the frame boundary that spends it — the same
// arrangement `input/touch-overlay.ts` uses for a tap, and for the same reason
// ("a finger is faster than a key"). Two rules make it safe:
//
//   * `take()` SPENDS the latch whether or not it was armed. A trigger pull
//     during a mission is the throttle; if it merely sat in the latch it would
//     be delivered the moment somebody paused.
//   * `take()` must be called EVERY frame, once, and its result stored — never
//     inline in an `||` chain, where short-circuiting would skip the call on
//     any frame another device already said yes, and deliver that select a
//     frame later.
//
// It is also strictly better than what the pad path does today: `xr.confirm` is
// a LEVEL sampled once a frame, so a tap that lands and lifts inside 11 ms is
// never seen at all. A latched edge cannot be missed.

/**
 * The part of an `XRSession` this needs. Structural, so a test can hand in a
 * fake — there is no headless WebXR worth maintaining (CLAUDE.md), and the
 * whole point of this file is a path that cannot be exercised in a browser here.
 */
export interface XrSelectSource {
  addEventListener(type: 'select', listener: (event: XrSelectEvent) => void): void
  removeEventListener(type: 'select', listener: (event: XrSelectEvent) => void): void
}

/** An `XRInputSourceEvent`, narrowed to what this file may look at. */
export interface XrSelectEvent {
  readonly inputSource?: { readonly handedness?: string }
}

export interface XrSelectLatch {
  /**
   * Point it at the live session — every frame, with whatever
   * `renderer.xr.getSession()` returns, exactly as `readXrInput` is handed it.
   *
   * Re-following the same session is a no-op, so this costs nothing at 90 Hz;
   * a different session (or `null`) detaches the old listener first and drops
   * anything it had latched. A select from a session that has ended must not be
   * delivered into the next one.
   */
  follow(session: XrSelectSource | null): void
  /**
   * Has the primary action fired since the last call?
   *
   * True at most once per `select`, and **the latch is spent either way** —
   * see the header. Call it once a frame and store the result.
   */
  take(armed: boolean): boolean
  /** Detach. After this the latch is inert until `follow` is called again. */
  dispose(): void
}

export const createXrSelectLatch = (): XrSelectLatch => {
  let attached: XrSelectSource | null = null
  let fired = false

  // ONE listener for the life of the latch, added and removed rather than
  // rebuilt, so `removeEventListener` is always given the function that was
  // added. A fresh closure per attach is the classic way to leak one listener
  // per session on a headset where people enter and leave VR all evening.
  const onSelect = (): void => {
    fired = true
  }

  const detach = (): void => {
    if (attached) attached.removeEventListener('select', onSelect)
    attached = null
    // Anything latched belonged to the session that just went away.
    fired = false
  }

  return {
    follow(session) {
      if (session === attached) return
      detach()
      if (session) {
        session.addEventListener('select', onSelect)
        attached = session
      }
    },
    take(armed) {
      const hit = fired
      fired = false
      return hit && armed
    },
    dispose() {
      detach()
    },
  }
}
