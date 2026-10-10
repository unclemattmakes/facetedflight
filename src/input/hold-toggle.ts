// src/input/hold-toggle.ts — a button that has to be MEANT.
//
// DEV-181. Every worn lap so far has been hand-flown, because the autopilot
// arms from the URL and from a keyboard `P`, and a headset has neither. That is
// fine for a lap and wrong for a soak: `docs/testing/perf-protocol.md` asks for
// a repeatable run, and "Matt flies it again" is not repeatable.
//
// ── Why a HOLD and not a press ───────────────────────────────────────────
//
// The two directions are not symmetrical, and that asymmetry is the whole
// design. Turning the autopilot OFF by accident is self-correcting — `app.ts`
// already drops it the moment a stick moves more than 0.25 ("you took the
// stick"). Turning it ON by accident takes the aircraft away from somebody
// mid-lap, in a headset, with no undo but a stick nudge they may not know
// about. So the gesture is sized against the bad direction: long enough that a
// knuckle cannot produce it, short enough to do while flying.
//
// ── Why the state lives in the caller ────────────────────────────────────
//
// `src/input/xr.ts` reports raw button state and says why: *"Edge detection
// belongs to the caller, which is the thing that knows what a frame is."* A
// hold is edge detection with a clock, and the clock is the frame delta the
// loop already has. So this is a pure step function over an explicit state —
// no `performance.now()`, no module-level mutable, nothing that a second
// caller could inherit (CLAUDE.md trap 19: a shared scratch object is only
// valid inside one synchronous call, and `ai-racer.ts` paid for that one).

/** How long the chord must be held. Seconds. */
export const HOLD_TOGGLE_SECONDS = 2

export interface HoldToggleState {
  /** Seconds the chord has been down for, this press. */
  readonly heldSeconds: number
  /**
   * Has this press already fired?
   *
   * Without it a hold of three seconds fires on every frame after the second —
   * the strobe `app.ts`'s `autopilotKeyHeld` exists to stop one level up. The
   * latch clears on RELEASE, so a deliberate second toggle needs a deliberate
   * second hold.
   */
  readonly fired: boolean
}

export const NO_HOLD: HoldToggleState = Object.freeze({ heldSeconds: 0, fired: false })

export interface HoldToggleStep {
  readonly state: HoldToggleState
  /** True on the ONE frame the hold completes. */
  readonly toggled: boolean
  /** 0..1, for a progress cue. 1 means "let go, it has fired". */
  readonly progress: number
}

/**
 * Advance a hold by one frame.
 *
 * `deltaSeconds` is the RENDER delta, clamped by the caller the way every other
 * render-time consumer clamps it: a tab that was backgrounded for ten seconds
 * hands back a delta that would complete any hold instantly, and a toggle that
 * fires because someone alt-tabbed is a bug with no symptom anyone can trace.
 */
export const stepHoldToggle = (
  state: HoldToggleState,
  down: boolean,
  deltaSeconds: number,
  seconds: number = HOLD_TOGGLE_SECONDS,
): HoldToggleStep => {
  if (!down) return { state: NO_HOLD, toggled: false, progress: 0 }
  const dt = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0
  const heldSeconds = state.heldSeconds + dt
  const threshold = seconds > 0 ? seconds : HOLD_TOGGLE_SECONDS
  const reached = heldSeconds >= threshold
  const toggled = reached && !state.fired
  return {
    state: { heldSeconds, fired: state.fired || reached },
    toggled,
    progress: reached ? 1 : heldSeconds / threshold,
  }
}
