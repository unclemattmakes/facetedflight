// src/input/gamepad.ts — the W3C Gamepad API, `standard` mapping, done well.
//
// PORT_PLAN §2.8 / DECISIONS D24 (Matt's decision, 2026-09-09, settled): this
// is the ONE input path that matters, plus keyboard for flat and XR controller
// thumbsticks in session. A Steam Controller works when Steam Input presents
// it as a standard pad; outside Steam it sits in "lizard mode" and is not
// supported, which is on the cut list with a price rather than implied.
// HOTAS needs a raw-axis, per-device-calibration path — deferred, not promised.
//
// `pad-profiles.ts` (king-tide, 309 lines, zero imports) is copied in later for
// *identification*, not capability. Do not re-derive it.

import { HOVERJET } from '@/generated/constants.generated'
import { type FlightActions, noActions, schemeAFlightAxes } from './actions'

/**
 * The 2016 dead zones: lower 0.2, upper 0.9. Large by modern standards and
 * part of the feel — a stick reads zero until a fifth of the way out and
 * saturates a tenth early. Do not "fix" these to modern values without a row
 * in `docs/DEVIATIONS.md`.
 *
 * TEMPORARY literals: these become generated constants at M0.7 (§4.1).
 */
export const DEAD_ZONE_LOWER = 0.2
export const DEAD_ZONE_UPPER = 0.9

/**
 * How far the left trigger has to be pulled to count as boost.
 *
 * 2016's own release threshold: `Input_Ship.cs:435` stops the boost at
 * `device.LeftTrigger.Value < 0.1f`. Using the same number for the press means
 * the control has no hysteresis, which is what 2016 had.
 */
export const BOOST_TRIGGER = 0.1

/** Rescale a raw axis through the dead zones so output is continuous over ±1. */
export const shapeAxis = (raw: number): number => {
  const sign = raw < 0 ? -1 : 1
  const mag = Math.abs(raw)
  if (mag <= DEAD_ZONE_LOWER) return 0
  if (mag >= DEAD_ZONE_UPPER) return sign
  return (sign * (mag - DEAD_ZONE_LOWER)) / (DEAD_ZONE_UPPER - DEAD_ZONE_LOWER)
}

/**
 * Is the launch button down on a standard pad?
 *
 * Button 0 is A in the `standard` mapping, which is what InControl's `Action1`
 * resolves to and therefore what `Input_Ship.cs:381` starts the elevator on.
 *
 * Separate from `readGamepad` because launching is not a `FlightActions` field:
 * the sim consumes those and nothing else, and "begin the mission" is not a
 * control surface the flight model has any business seeing.
 */
export const gamepadConfirm = (): boolean => firstStandardPad()?.buttons[0]?.pressed ?? false

/**
 * The Start/Menu button is DOWN. Raw state; the caller edge-detects.
 *
 * Index 9 in the W3C standard mapping, which is the same physical button 2016
 * paused on (`Input_Ship.cs:349-363` reads InControl's `Menu`). Separate from
 * `readGamepad` for the same reason `gamepadConfirm` is: pausing is not a
 * control surface the flight model has any business seeing.
 */
export const gamepadPause = (): boolean => firstStandardPad()?.buttons[9]?.pressed ?? false

/**
 * The CHANGE VIEW button is DOWN. Raw state; the caller edge-detects. DEV-128.
 *
 * `BUTTON.x` — index 2, the left face button, InControl's `Action3`. This is
 * 2016's OWN binding, not a free slot chosen for it: `Input_Ship.cs:312` reads
 * `device.GetControl(InputControlType.Action3)` and calls
 * `camViewChanger.NextCamView()` (debounced on release at :329), and the
 * controls poster in the 2016 hangar labels that button "CHANGE VIEW". It is
 * outside `FlightActions` for the reason `gamepadConfirm` and `gamepadPause`
 * are, and it is the one face button scheme "a" never reads —
 * `tests/unit/third-person-input.test.ts` asserts against the sheet's scheme
 * letter and against `readGamepad` that it moves nothing the flight model
 * sees, which is the assertion DEV-069 says a binding owes.
 */
export const gamepadCameraToggle = (): boolean =>
  firstStandardPad()?.buttons[BUTTON.x]?.pressed ?? false

/**
 * BACK is DOWN: B, the right face button. Raw state; the caller edge-detects.
 *
 * Xbox convention, and Matt's by name (DEV-207): A accepts, B backs out. Named
 * for the BUTTON, as `gamepadConfirm` is, rather than borrowed from a flight
 * field: the menus used to read `readGamepad().brake` for this, which is B only
 * because `readGamepad` maps B to the brake. DEV-069 moved the brake once, and
 * every "back" in the game would have moved with it. It is outside
 * `FlightActions` for the reason `gamepadPause` is.
 */
export const gamepadBack = (): boolean => firstStandardPad()?.buttons[BUTTON.b]?.pressed ?? false

/**
 * "Race this lap" is DOWN on the results panel. Raw state; the caller
 * edge-detects. DEV-371.
 *
 * `BUTTON.y`, index 3, the top face button: scheme "a" reads nothing on it and
 * neither does anything else here, so it moves nothing the flight model sees
 * (`tests/unit/race-lap-input.test.ts`).
 */
export const gamepadRaceLap = (): boolean => firstStandardPad()?.buttons[BUTTON.y]?.pressed ?? false

/**
 * "Share this lap" is DOWN on the results panel. Raw state; the caller
 * edge-detects. DEV-373.
 *
 * `BUTTON.select`, index 8: the standard mapping's left centre button — View
 * on an Xbox pad, SHARE on a DualShock 4 and Create on a DualSense, so on the
 * pads that name it the button already says what it does. Scheme "a" reads
 * nothing on it and neither does anything else here, so it moves nothing the
 * flight model sees (`tests/unit/race-lap-input.test.ts`).
 */
export const gamepadShareLap = (): boolean =>
  firstStandardPad()?.buttons[BUTTON.select]?.pressed ?? false

/**
 * DEV-566: while a screen stands over the whole game (a phone held upright,
 * `turn-phone.ts`), every pad reads as unplugged, so a pad paired to a phone
 * cannot press a row nobody can see. Every read in this file and
 * `look.ts`'s right stick go through `firstStandardPad`, so this is the one
 * switch. Set once a frame by `boot/app.ts`.
 */
let padsHeld = false
export const setPadsHeld = (held: boolean): void => {
  padsHeld = held
}

/** Only `standard`-mapping pads are read. Everything else needs the deferred raw-axis path. */
export const firstStandardPad = (): Gamepad | null => {
  if (padsHeld) return null
  const pads = navigator.getGamepads?.() ?? []
  for (const pad of pads) {
    if (pad?.connected && pad.mapping === 'standard') return pad
  }
  return null
}

/**
 * The `standard`-mapping axis indices, named once.
 *
 * Bare numbers in a control scheme are how you end up with a mapping nobody can
 * check against the sheet: `axis(1)` says nothing, `AXIS.leftY` says which
 * physical stick 2016 named.
 */
export const AXIS = { leftX: 0, leftY: 1, rightX: 2, rightY: 3 } as const

/**
 * The `standard`-mapping button indices this game uses.
 *
 * 0 A, 1 B, 2 X, 3 Y, 4/5 shoulders, 6/7 triggers, 9 Start. InControl's `Action1`
 * and `Action2` are the bottom and right face buttons, so they are 0 and 1
 * here; `Action3` is the left one, 2, which 2016 binds to CHANGE VIEW (see
 * `gamepadCameraToggle`).
 */
export const BUTTON = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  l1: 4,
  r1: 5,
  l2: 6,
  r2: 7,
  select: 8,
  start: 9,
} as const

/**
 * One button's analogue value (0..1), or 0 when there is no pad or no such
 * button. Shared by the flat pad and the XR controllers, which both hand back a
 * `Gamepad` whose `buttons` may be shorter than the index asked for.
 */
export const buttonValue = (pad: Gamepad | null, i: number): number => pad?.buttons[i]?.value ?? 0

/** One button's pressed state, or false when there is no pad or no such button. */
export const buttonDown = (pad: Gamepad | null, i: number): boolean =>
  pad?.buttons[i]?.pressed ?? false

export interface GamepadOptions {
  invertPitch: boolean
}

/**
 * The shipped 2016 control scheme letter, straight off the sheet.
 *
 * `PlayerShip_SR14_Photon.prefab#11400186 Input_Ship.controlScheme`, trust
 * `verified`. It is imported rather than remembered so the mapping below can be
 * checked against the game — see `tests/unit/control-scheme.test.ts`.
 */
export const CONTROL_SCHEME: string = HOVERJET.input.controlScheme

/**
 * Standard-mapping layout: axes 0/1 = left stick X/Y, 2/3 = right stick X/Y;
 * buttons 6/7 = left/right trigger, 4/5 = shoulders, 0/1 = A/B.
 *
 * ── The scheme is 2016's, and it has a NAME ───────────────────────────────
 *
 * `Input_Ship.cs:484-515` is a switch over five control schemes and the shipped
 * prefab picks one: `controlScheme: "a"`. Scheme "a" is
 *
 *     rollAxis  = device.RightStickX     (Input_Ship.cs:490)
 *     pitchAxis = device.LeftStickY      (Input_Ship.cs:491)
 *     yawAxis   = device.LeftStickX      (Input_Ship.cs:492)
 *
 * so: **the left stick flies the nose — up/down pitch, left/right yaw — and the
 * right stick's horizontal rolls.** Throttle is the right trigger
 * (`Input_Ship.cs:406`), boost is the LEFT trigger held with it (:426), and the
 * brake is `Action2`, the B button (:444).
 *
 * ── What was here before, and why it was wrong ────────────────────────────
 *
 * Pitch on the right stick's Y and yaw on the LEFT stick's Y — described in
 * this file and in `xr.ts` as "scheme a". It is not scheme a, and it is not b,
 * c, d or hotas either, because **no 2016 scheme puts yaw on a stick's
 * vertical**. It came from a headset session on 2026-09-09 where a scheme was
 * re-specified by feel and never checked against the sheet; the constant that
 * settles it had been extracted for months. Matt flew the result flat with a
 * PS5 pad on 2026-09-13, called it unplayable, and asked for pitch and yaw on
 * the left stick with roll on the right — scheme "a", arrived at from the pad,
 * independently. DEV-069.
 *
 * ── The signs are MEASURED, not reasoned ──────────────────────────────────
 *
 * From `sim/autopilot.ts:41-44`, which sampled the integrator rather than
 * arguing about handedness:
 *
 *     pitch +1 -> nose DOWN    yaw +1 -> nose RIGHT    roll +1 -> banks LEFT
 *
 * A standard pad's Y is positive DOWN and its X positive right. So pitch
 * negates (push the stick forward and dive — which is `invertPitch: false`, the
 * shipped default on the prefab), yaw does not, and roll does. Do not re-derive
 * these from the axis conventions: the body frame is not the one you expect,
 * and there are four orientation bugs in the ledger that say so.
 *
 * `tests/unit/xr-input.test.ts` asserts this reader and the XR one agree axis
 * for axis and button for button — that parity is the whole reason
 * `FlightActions` exists.
 */
export const readGamepad = (opts: GamepadOptions): FlightActions => {
  const out = noActions()
  const pad = firstStandardPad()
  if (!pad) return out

  const axis = (i: number): number => shapeAxis(pad.axes[i] ?? 0)
  const button = (i: number): number => buttonValue(pad, i)
  const pressed = (i: number): boolean => buttonDown(pad, i)

  const stick = schemeAFlightAxes(
    axis(AXIS.leftX),
    axis(AXIS.leftY),
    axis(AXIS.rightX),
    opts.invertPitch,
  )
  out.pitch = stick.pitch
  out.yaw = stick.yaw
  out.roll = stick.roll
  out.throttle = button(BUTTON.r2)
  // The left trigger is 2016's boost, and it is the answer to "I don't know how
  // to boost". R1 stays as an alternate because it is what this port bound for
  // four sessions and taking a working button away is not a fix — but the
  // trigger is the one the controls page and the landing page name.
  out.boost = button(BUTTON.l2) > BOOST_TRIGGER || pressed(BUTTON.r1)
  // `Action2` — 2016's brake (`Input_Ship.cs:444`). It shares one effect with
  // the airbrake: `game/flight.ts` is `input.brake = actions.brake ||
  // actions.airbrake`, so moving it off the left trigger costs nothing and
  // frees that trigger for the boost it always had.
  out.brake = pressed(BUTTON.b)
  out.airbrake = pressed(BUTTON.l1)
  return out
}
