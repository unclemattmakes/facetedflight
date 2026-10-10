// src/input/xr.ts — the thumbsticks that only exist once a session is running.
//
// ── Why this is a separate file from gamepad.ts ───────────────────────────
//
// Because an XR controller is NOT in `navigator.getGamepads()`. It never
// appears there, before or during a session. It arrives as
// `XRInputSource.gamepad` — a `Gamepad`-shaped object with mapping
// `xr-standard` — hanging off `session.inputSources`, and only while the
// session is live.
//
// That is not a detail. Until this file existed, putting on a standalone
// headset gave you a cockpit, a course, ghosts, the right lighting, and no
// controls at all: `readGamepad()` looked in the one place the Touch sticks are
// guaranteed not to be. On a PC with a pad plugged in you would never notice.
//
// ── The mapping, and why it mirrors the pad exactly ───────────────────────
//
// 2016's shipped scheme is "a" — `hoverjet.input.controlScheme` on the shipped
// prefab, and `Input_Ship.cs:488-492` says what the letter means. `gamepad.ts`
// carries the full argument; the short version is **left stick flies the nose,
// right stick's horizontal rolls**. The whole point of `FlightActions` is that
// the sim never learns which device produced it, so the job here is to
// reproduce that scheme on two hands rather than to invent a VR one:
//
//   left thumbstick X  -> yaw        left thumbstick Y -> pitch
//   right thumbstick X -> roll       right trigger     -> throttle
//   left trigger     -> boost        right grip        -> boost (alternate)
//   left grip ("L1") -> airbrake     right B           -> brake
//   left stick DOWN + click -> recentre    right A -> launch
//   left X or Y -> pause (open) / step the menu (while open)    right B -> back
//   both grips (held 2 s) -> autopilot
//
// **Left X and Y are the D-PAD on a Steam Frame**, and both are bound to pause
// for that reason — see `pause` on the interface. Xbox semantics throughout,
// which is what the flat pad already has: A accepts, B backs out, the D-pad
// works the menu. The one Xbox binding that cannot be reproduced is the one
// 2016 actually used, Start — the platform reserves it and the spec says it
// MUST NOT be exposed.
//
// Launch is the A button because 2016's is: `Input_Ship` starts the elevator on
// `device.Action1.IsPressed` (Input_Ship.cs:381), and InControl's Action1 is the
// bottom face button -- A on a pad, A on a Touch controller's right hand. The
// brake is `Action2` for the same reason (:444), which is B on both.
//
// The left trigger is BOOST, not brake: `Input_Ship.cs:426` boosts on the left
// trigger held with the right. The brake moved to B, where 2016 had it, and it
// costs nothing — `game/flight.ts` folds brake and airbrake into one effect.
//
// **The right thumbstick's Y is deliberately unassigned.** Scheme "a" has three
// axes and the pad has four; giving the spare one a job here and not on the pad
// would break the parity this file exists to keep.
//
// Pitch and roll are both NEGATED against the raw axis, in the mapping rather
// than via `invertPitch` — that setting is a user preference (D16) and
// defaulting it to true would mean "off" gave the wrong thing.
//
// The earlier version of this file put pitch on the right stick and yaw on the
// LEFT STICK'S VERTICAL and called that scheme "a". It is not scheme a and it
// is not any 2016 scheme: none of the five puts yaw on a vertical. See
// `gamepad.ts` and DEV-069.
//
// ── Recentre, and what "dpad down" means on a device with no dpad ─────────
//
// Two readings, and one implementation satisfies both. On a controller with a
// TOUCHPAD (`xr-standard` axes 0,1 + button 2) "dpad down" is literal: press
// the pad in its lower half. On Touch there is no pad, so the nearest thing is
// the thumbstick — pushed DOWN and clicked.
//
// So: the stick or pad is CLICKED while it is pushed down. The click is what
// makes it safe. Pushing the left stick down is pitch, and it happens
// constantly; recentring by accident mid-manoeuvre would be worse than not
// having the button at all.
//
// Recentre is the one control with no flat equivalent — there is no head pose
// to recentre on a monitor — so it is NOT a `FlightActions` field. The sim
// consumes `FlightActions` and nothing else (CLAUDE.md rule 4 in spirit), and a
// view command has no business in there. It comes back beside the actions.
//
// Same dead zones as the pad (0.2 / 0.9, and they are 2016's — see
// `gamepad.ts`), because a Touch stick is an analogue stick like any other.
//
// ── `xr-standard`, from the spec ──────────────────────────────────────────
//
//   axes    0,1 touchpad X/Y        2,3 thumbstick X/Y
//   buttons 0 trigger  1 squeeze  2 touchpad  3 thumbstick  4 A/X  5 B/Y
//
// Y is positive DOWN on both the thumbstick and a standard pad's stick, so
// `pitch` needs no extra sign here — it goes through the same global
// `applyPitchInvert` and nothing else. A sign flip smuggled in at this layer is
// exactly the kind of thing that makes VR and flat disagree about which way is
// up, so there is deliberately none.

import { type FlightActions, noActions, schemeAFlightAxes } from './actions'
import { BOOST_TRIGGER, buttonDown, buttonValue, shapeAxis } from './gamepad'

export interface XrInputOptions {
  invertPitch: boolean
}

export interface XrInputResult {
  readonly actions: FlightActions
  /**
   * The launch button is DOWN this frame — the raw state, not an edge.
   *
   * 2016 polled it the same way and guarded with a `gameReady` flag, because the
   * button is held across many frames. `startLaunch` is idempotent for the same
   * reason, so an un-edged signal is safe here; the caller still edge-detects so
   * that a held button cannot re-trigger anything else.
   */
  readonly confirm: boolean
  /**
   * A recentre was REQUESTED this frame — the raw button state, not an edge.
   *
   * Edge detection belongs to the caller, which is the thing that knows what a
   * "frame" is. Holding the button must not recentre 90 times a second.
   */
  readonly recenter: boolean
  /**
   * The pause button is DOWN — raw state, not an edge.
   *
   * 2016 paused on Start/Menu, and `gamepad.ts` still does — `BUTTON.start`,
   * index 9, the Xbox Start button. **That button does not exist in WebXR.**
   * The Gamepads Module is normative about it: *"buttons reserved by the UA or
   * platform MUST NOT be exposed on the Gamepad"*, and the registry's generic
   * profiles deliberately exclude the reserved one. So there is no Start to
   * bind and there never was.
   *
   * ── EITHER left face index, and that is not belt-and-braces (DEV-207) ────
   *
   * On a Quest Touch these are X and Y. **On a Steam Frame they are the
   * D-PAD** — the left controller has a D-pad where Touch has face buttons,
   * and SteamVR (which has no Frame profile in the registry at all, only
   * `valve-index.json`) advertises the whole device as `oculus-touch`. The
   * Touch profile has seven indices and no 4-way, so a D-pad has two slots to
   * fold into.
   *
   * Measured on the hardware, 2026-09-17: eight presses — up, up, down, down,
   * left, left, right, right — produced exactly TWO distinct indices, 4 and 5,
   * and nothing on axes 0/1. So two of the four directions reach the page and
   * **which two is not knowable from here**: it is a SteamVR mapping decision
   * for a device the registry does not describe.
   *
   * Binding both is therefore the only reading that survives not knowing.
   * Matt's ask was *"put pause on dpad left or right"*; this is that, robust to
   * which pair the runtime kept, and on a Touch it costs one spare face button
   * that scheme "a" never used.
   */
  readonly pause: boolean
  /**
   * Menu row movement from the left face buttons: -1 up, +1 down, 0 neither.
   *
   * The same two indices as `pause`, read differently depending on whether a
   * menu is open — which is Matt's other half: *"disable that when the pause
   * menu is up"*. Closed, either one OPENS the plate; open, they step the
   * selection, because a D-pad stepping a list is what a D-pad is for and it is
   * what every pad has done since 1985.
   *
   * The caller decides which meaning applies, and edge-detects: this file does
   * not know what a frame is, and a held direction must step one row rather
   * than strobing the list.
   */
  readonly menuStep: -1 | 0 | 1
  /**
   * BACK/CANCEL is down — raw state, not an edge. B on a pad, B on a Touch.
   *
   * Xbox convention, and Matt asked for it by name: A accepts, B backs out. It
   * shares `xr-standard` index 5 on the RIGHT hand with the brake, which costs
   * nothing because the two can never be read in the same frame — the caller
   * reads `back` only while a menu is up, and a paused run is handed
   * `noActions()` so the brake is not read at all.
   *
   * Without this, closing the pause plate needs a row selection, and a player
   * who cannot work the rows is stuck in the menu. That is the failure this
   * whole session was spent diagnosing; it should not be reachable a second
   * time through the fix for it.
   */
  readonly back: boolean
  /**
   * The AUTOPILOT chord is down — raw state, not an edge and not a hold.
   *
   * DEV-181, moved by DEV-207. It was the left hand's index 4, chosen as the
   * one app button scheme "a" left unassigned — which was true on a Touch and
   * false on a Frame, where index 4 is a D-PAD DIRECTION. With the D-pad now
   * opening the pause plate, a two-second hold of a direction while stepping a
   * list would have engaged the autopilot mid-menu: the exact class of surprise
   * that costs a headset session to find.
   *
   * So: BOTH GRIPS, together. Deliberate, effectively unreachable by accident,
   * and free of collisions — individually they are the airbrake (left) and the
   * alternate boost (right), and holding those two against each other for two
   * seconds is a contradictory flight input nobody produces on purpose. It has
   * no flat-pad equivalent either way; `gamepad.ts` has never bound autopilot.
   *
   * It has to be HELD, and `src/input/hold-toggle.ts` says why the two
   * directions are not symmetrical. The hold is the caller's, for the same
   * reason the edges are — this file does not know what a frame is.
   */
  readonly autopilot: boolean
  /**
   * "Race this lap" is DOWN — raw state, not an edge. DEV-371.
   *
   * The RIGHT stick CLICKED (`xr-standard` index 3). Every face button in a
   * headset already has a job: right A confirms, right B brakes and backs out,
   * and the left pair is pause on a Steam Frame's D-pad (DEV-207). The right
   * stick's click is the one control scheme "a" leaves free (`dpadDown` reads
   * the LEFT stick's). The caller reads it only while the results panel is up.
   */
  readonly raceLap: boolean
  /**
   * "Share this lap" is DOWN — raw state, not an edge. DEV-373.
   *
   * The LEFT stick CLICKED with the stick NOT pushed down. The right stick's
   * click races this lap (above), and the left one's is the recentre only when
   * the stick is also held down (`dpadDown`, DEV-181's D-pad reading) — so a
   * plain left click is the one press left in scheme "a", and the pair reads as
   * a pair on the panel: RIGHT to race this lap, LEFT to share it. The caller
   * reads it only while the results panel is up.
   */
  readonly shareLap: boolean
  /**
   * Whether ANY input source offered a thumbstick.
   *
   * Not decoration. Apple Vision Pro supports `immersive-vr` and has no
   * controllers at all — its input sources are transient pointers with no
   * `gamepad` — so a headset can legitimately enter a session and be unable to
   * fly. The caller needs to be able to say so out loud instead of leaving
   * someone shaking a controller that was never going to work.
   */
  readonly hasSticks: boolean
}

/**
 * The thumbstick axes, preferring the real stick over the touchpad.
 *
 * `xr-standard` puts the thumbstick at 2,3 and reserves 0,1 for a touchpad.
 * Devices that have only a touchpad report it at 0,1 and stop there, so a
 * short `axes` array is the signal to fall back — never a reason to read 2,3
 * and get `undefined`.
 */
const stick = (pad: Gamepad): [number, number] => {
  const [x, y] =
    pad.axes.length >= 4
      ? [pad.axes[XR_AXIS.stickX], pad.axes[XR_AXIS.stickY]]
      : [pad.axes[XR_AXIS.padX], pad.axes[XR_AXIS.padY]]
  return [shapeAxis(x ?? 0), shapeAxis(y ?? 0)]
}

/**
 * "Dpad down": the stick or touchpad CLICKED while pushed down.
 *
 * Read from the RAW axis, not the shaped one — this is a gesture, not an axis,
 * and the flight dead zones have nothing to say about it. Down is +Y in
 * `xr-standard`, same as a standard pad.
 *
 * The click is what makes this safe to put on the flight stick: pushing the left
 * stick down is pitch and happens constantly, so the direction alone would
 * recentre the world every time you dived.
 */
const DPAD_DOWN = 0.5
const dpadDown = (pad: Gamepad | null): boolean => {
  if (!pad) return false
  const clicked = buttonDown(pad, XR_BUTTON.stick) || buttonDown(pad, XR_BUTTON.touchpad)
  if (!clicked) return false
  const y = pad.axes.length >= 4 ? (pad.axes[XR_AXIS.stickY] ?? 0) : (pad.axes[XR_AXIS.padY] ?? 0)
  return y > DPAD_DOWN
}

/**
 * The `xr-standard` button indices, named once (the WebXR Gamepads registry:
 * 0 trigger, 1 squeeze, 2 touchpad, 3 thumbstick, 4 and 5 the face buttons, A/X
 * under B/Y). The flat pad has `BUTTON` in `gamepad.ts`; this was the other
 * mapping with no table, so `app.ts` carried a comment listing the numbers and
 * the readers wrote them bare. Only `buttons[0]` is REQUIRED by the spec: the
 * higher indices are present on the Frame and on Touch (see `confirm` below).
 */
export const XR_BUTTON = {
  trigger: 0,
  squeeze: 1,
  touchpad: 2,
  stick: 3,
  /** A on the right hand, X on the left. On a Steam Frame's left, a D-pad direction. */
  lower: 4,
  /** B on the right hand, Y on the left. On a Steam Frame's left, a D-pad direction. */
  upper: 5,
} as const

/** The `xr-standard` axis indices: 0,1 a touchpad's X/Y, 2,3 the thumbstick's. */
export const XR_AXIS = { padX: 0, padY: 1, stickX: 2, stickY: 3 } as const

/**
 * The gamepad of the FIRST input source on `hand` that has one, or null.
 *
 * A source is usable for flight only if it is a hand holding something with a
 * stick. FIRST, because that is what flight has always read: when two sources
 * share a hand (a tracked hand beside a controller) every reader that answers
 * "which pad is the left one" has to answer it the same way or the bench, the
 * pointer and the ship disagree about which controller is which. Exported so
 * they all ask here.
 */
export const controllerFor = (session: XRSession | null, hand: XRHandedness): Gamepad | null => {
  for (const source of session?.inputSources ?? []) {
    if (source.handedness !== hand) continue
    if (!source.gamepad) continue
    return source.gamepad
  }
  return null
}

/**
 * Read both controllers into the same action set the pad and keyboard produce.
 *
 * Safe to call with a session that has no controllers yet: `inputSources` is
 * empty until the runtime reports them, which on Quest is a frame or two after
 * the session starts, and this returns neutral actions until then rather than
 * throwing.
 */
export const readXrInput = (session: XRSession | null, opts: XrInputOptions): XrInputResult => {
  const out = noActions()
  if (!session)
    return {
      actions: out,
      hasSticks: false,
      recenter: false,
      confirm: false,
      pause: false,
      menuStep: 0,
      back: false,
      autopilot: false,
      raceLap: false,
      shareLap: false,
    }

  const left = controllerFor(session, 'left')
  const right = controllerFor(session, 'right')
  if (!left && !right)
    return {
      actions: out,
      hasSticks: false,
      recenter: false,
      confirm: false,
      pause: false,
      menuStep: 0,
      back: false,
      autopilot: false,
      raceLap: false,
      shareLap: false,
    }

  // Scheme "a", the one mapping every device shares (`schemeAFlightAxes`). A
  // hand that is not there contributes a centred stick, and only the hand that IS
  // there assigns its fields, so a missing hand leaves its axes as `noActions()`
  // had them.
  const [leftX, leftY] = left ? stick(left) : [0, 0]
  const [rightX] = right ? stick(right) : [0]
  const axes = schemeAFlightAxes(leftX, leftY, rightX, opts.invertPitch)

  if (left) {
    // This stick flies the nose. Horizontal yaws, vertical pitches.
    out.yaw = axes.yaw
    out.pitch = axes.pitch
    // Index trigger — 2016's boost (`Input_Ship.cs:426`). Read as a THRESHOLD
    // on the analogue value, not `pressed`, so it matches the pad's left
    // trigger exactly; the parity test compares them.
    out.boost = buttonValue(left, XR_BUTTON.trigger) > BOOST_TRIGGER
    // Squeeze — "L1". On Touch that is the middle-finger grip, the shoulder
    // button's nearest relative, and reachable without letting go of the stick.
    out.airbrake = buttonDown(left, XR_BUTTON.squeeze)
  }
  if (right) {
    // The aileron, and the whole of this stick's job. Its Y is unassigned in
    // scheme "a"; see the header.
    out.roll = axes.roll
    // Analogue, like the pad's right trigger: a flight throttle that is on or
    // off is a different game.
    out.throttle = buttonValue(right, XR_BUTTON.trigger)
    // The alternate boost, mirroring the pad's R1.
    out.boost = out.boost || buttonDown(right, XR_BUTTON.squeeze)
    // `Action2` — B on a Touch controller's right hand, as on a pad.
    out.brake = buttonDown(right, XR_BUTTON.upper)
  }

  // A controller with only a touchpad still counts: it produced axes, and the
  // fallback above read them. What does not count is a hand with no gamepad.
  return {
    actions: out,
    hasSticks: true,
    recenter: dpadDown(left),
    confirm: buttonDown(right, XR_BUTTON.lower),
    // EITHER left face index, because on a D-pad device they are two D-pad
    // directions and we cannot know which two. See `pause` on the interface.
    pause: buttonDown(left, XR_BUTTON.lower) || buttonDown(left, XR_BUTTON.upper),
    menuStep: buttonDown(left, XR_BUTTON.lower) ? -1 : buttonDown(left, XR_BUTTON.upper) ? 1 : 0,
    back: buttonDown(right, XR_BUTTON.upper),
    // Both grips. See `autopilot` on the interface — it had left index 4, which
    // is a D-pad direction on the Frame, and a 2 s hold while navigating a menu
    // would have engaged it.
    autopilot: buttonDown(left, XR_BUTTON.squeeze) && buttonDown(right, XR_BUTTON.squeeze),
    // The right stick's click; see `raceLap` on the interface.
    raceLap: buttonDown(right, XR_BUTTON.stick),
    // The left stick's click, not held down (that is the recentre); see
    // `shareLap` on the interface.
    shareLap: buttonDown(left, XR_BUTTON.stick) && !dpadDown(left),
  }
}
