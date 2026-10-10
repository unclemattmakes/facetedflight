// src/input/touch.ts — a phone's thumbs as a flight stick.
//
// The mapping only. `touch-overlay.ts` is the DOM half — the elements you put a
// thumb on, and the pointer events that move them. This file is the part that
// can be handed a number and asked which way the ship goes, in node, with no
// document, which is the only way the lesson below gets enforced rather than
// asserted.
//
// ── Why this exists ──────────────────────────────────────────────────────
//
// `index.html` USED to say, in as many words, **"Not supported: phones and
// tablets"** -- that copy was deleted by DEV-278, and this is the history,
// and the capability gate meant it: no `immersive-vr`, no standard pad, and
// `hasKeyboard()` false on anything with a coarse pointer, so a phone routed to
// `attract` and got the flyby. That is an honest answer for a device that
// cannot fly the game and the wrong answer for one that can — a phone has two
// thumbs, which is one more control surface than the keyboard tier the landing
// page already calls "Playable".
//
// ── The arithmetic is the PAD'S, line for line, and that is the point ────
//
// Every sign below is copied from `gamepad.ts` rather than re-derived, because
// re-deriving is how this port got four orientation bugs and three device
// disagreements. `xr-input.test.ts` asserts the XR reader and the pad agree
// axis for axis; the keyboard was compared to nothing for four sessions and
// spent all four of them pitching and rolling backwards (DEV-071). A fourth
// device arriving with its own opinion about which way is up would be the same
// bug for the fourth time.
//
// So the touch sticks are the pad's sticks, and the screen makes that free:
// **a screen's y grows DOWNWARD, and so does a gamepad's stick axis.** Dragging
// a thumb up the screen is `dy < 0`, which is the same number a stick pushed
// forward reports, so `pitch = -y` dives on both without a special case. The
// same is true of x on both axes. Nothing here negates anything the pad does
// not negate, and `tests/unit/touch-input.test.ts` compares the two readers
// directly rather than taking this paragraph's word for it.
//
// ── What is NOT the pad's, and why ───────────────────────────────────────
//
// **Throttle is the right stick's vertical.** On the pad it is R2, and scheme
// "a" leaves the right stick's y unused (`Input_Ship.cs:490-492` binds only its
// x, to roll). A finger is not a trigger and a phone has no spare thumb, so the
// power goes on the axis that is already under the thumb that rolls — push the
// right stick forward for throttle, exactly the gesture the left hand makes on
// a HOTAS. Nothing is displaced: the axis it uses was dead.
//
// **The dead zone is in PIXELS, not the pad's 0.2/0.9.** Those two numbers are
// 2016's and they are about a physical stick — slop around centre, a mechanical
// gate that saturates early — and they are part of the feel, which is why
// `gamepad.ts` forbids "fixing" them. A touchscreen has neither: it reports
// exactly where the finger is, and spending a fifth of a 56 px travel on slop
// that does not exist would throw away a fifth of a control that is already
// small. What a finger DOES have is a tap that drifts two or three pixels on
// the way down, so there is a small dead zone measured in the units the problem
// is actually in.

import { applyPitchInvert, type FlightActions, noActions, schemeAFlightAxes } from './actions'
import { type LookDelta, type LookOptions, NO_LOOK } from './look'

/**
 * Pixels from the stick's origin to full deflection.
 *
 * A thumb's comfortable arc from where it lands, not a size chosen to look
 * right: 56 px at a phone's device-pixel-ratio is roughly a centimetre of
 * travel, which is about what a thumb sweeps without the hand moving. The
 * sticks FLOAT — the origin is wherever the thumb went down — so this is the
 * only geometry number in the control, and `touch-overlay.ts` draws the ring at
 * exactly this radius so that what you see and what you hit cannot drift apart.
 */
export const STICK_RADIUS_PX = 56

/**
 * Slop around the origin, in pixels. See the header: a finger does not have a
 * stick's mechanical dead zone, but it does roll a little on the way down.
 */
export const STICK_DEAD_PX = 4

/**
 * Radians per pixel dragged, for the look.
 *
 * The mouse's is 0.0025 (`look.ts`) and this is deliberately not the same
 * number: a captured mouse can be moved as far as the desk allows, and a drag
 * stops at the edge of the glass. At 0.004 a drag across the short side of a
 * phone in landscape turns you most of a right angle, which is the gesture that
 * has to work — the level select is aimed by looking at a holotable.
 */
export const TOUCH_LOOK_SENSITIVITY = 0.004

/** A stick's deflection, −1 … 1 on each axis, y POSITIVE DOWN as a gamepad reports it. */
export interface StickVector {
  readonly x: number
  readonly y: number
}

/** A stick nobody is touching. */
export const CENTRED: StickVector = { x: 0, y: 0 }

/**
 * Screen-pixel offset from the stick's origin to a deflection.
 *
 * Clamped to the unit CIRCLE, not the unit square: a physical stick cannot
 * reach 1.41 along the diagonal and neither may this one, or a diagonal drag
 * would command 41% more pitch and roll than the same drag along an axis.
 */
export const stickVector = (dx: number, dy: number, radius = STICK_RADIUS_PX): StickVector => {
  const distance = Math.hypot(dx, dy)
  if (distance <= STICK_DEAD_PX || radius <= 0) return CENTRED
  // Re-scaled so the dead zone costs travel rather than creating a step: the
  // first pixel past it commands ~0, not 4/56.
  const reach = Math.min(1, (distance - STICK_DEAD_PX) / Math.max(1, radius - STICK_DEAD_PX))
  const scale = reach / distance
  return { x: dx * scale, y: dy * scale }
}

/** The momentary buttons. Held state; the caller edge-detects where it cares. */
export interface TouchButtons {
  readonly boost: boolean
  readonly brake: boolean
}

export const NO_TOUCH_BUTTONS: TouchButtons = { boost: false, brake: false }

export interface TouchOptions {
  readonly invertPitch: boolean
}

/**
 * Two thumbs and two buttons, as the one action set the sim consumes.
 *
 * The three stick axes go through `schemeAFlightAxes`, the one scheme "a"
 * mapping the pad and the headset use too, which is:
 *
 *     pitch     = applyPitchInvert(-leftY,  invert)     leftY   <- left stick Y
 *     yaw       =                   leftX               leftX   <- left stick X
 *     roll      =                  -rightX              rightX  <- right stick X
 *     throttle  =          max(0, -rightY)              R2 on the pad
 *
 * **`airbrake` is deliberately always false and BRAKE covers both.** They are
 * one effect in the shipped rig — `game/flight.ts:567` is `input.brake =
 * actions.brake || actions.airbrake` — and `jumpseat-flight.ts:682` zeroes the
 * pair, so a second chip would be a second button for the same result and one
 * more thing between a thumb and the stick. That is a deviation with a row
 * (DEV-104), not an oversight.
 */
export const touchActions = (
  left: StickVector,
  right: StickVector,
  buttons: TouchButtons,
  opts: TouchOptions,
): FlightActions => {
  const out = noActions()
  const stick = schemeAFlightAxes(left.x, left.y, right.x, opts.invertPitch)
  out.pitch = stick.pitch
  out.yaw = stick.yaw
  out.roll = stick.roll
  // Forward only. Pulling the right stick back is not a reverse and not a
  // brake — the brake is a button, as it is on the pad.
  out.throttle = Math.max(0, -right.y)
  out.boost = buttons.boost
  out.brake = buttons.brake
  return out
}

/**
 * A drag, in pixels, as radians to add to the view this frame.
 *
 * The MOUSE's conventions, because they are the ones the camera is built on and
 * `look.ts` argues them out: drag right to look right (yaw decreases), drag up
 * to look up (pitch increases). A touch drag is a displacement, like
 * `movementX/Y` and unlike a stick, so there is no `dt` here — the caller has
 * already accumulated the pixels and this converts them.
 *
 * `invertPitch` applies, for the same reason it applies to the mouse: it is one
 * switch for the whole game (D16), and a switch that corrects one device and
 * breaks another is a second bug with a menu row.
 *
 * `flightIdle` gates it, exactly as it gates `readStickLook` and
 * `readKeyboardLook`: in a mission a drag is flying the ship, and a control
 * with two meanings on one screen is a ship that rolls when you glance left.
 * The gate lives HERE rather than only at the call site so that all three look
 * readers answer the same question the same way — the fourth device arriving
 * with its own opinion is the bug this port has already paid for three times.
 */
export const touchLook = (dxPixels: number, dyPixels: number, opts: LookOptions): LookDelta => {
  if (!opts.flightIdle) return NO_LOOK
  // `-0` compares unequal to `NO_LOOK` under `Object.is`, which is what
  // `toEqual` uses — `look.ts`'s `flip` exists for this and the reasoning is
  // the same here.
  const yaw = dxPixels === 0 ? 0 : -dxPixels * TOUCH_LOOK_SENSITIVITY
  const raw = dyPixels === 0 ? 0 : -dyPixels * TOUCH_LOOK_SENSITIVITY
  const pitch = applyPitchInvert(raw, opts.invertPitch)
  return { yaw, pitch }
}

/** Which stick a thumb landed on. The screen is split down the middle, and that is all. */
export type TouchZone = 'left' | 'right'

/**
 * The half of the screen a touch went down in.
 *
 * Halves rather than two drawn pads, because the sticks float: a thumb that
 * lands anywhere in its half gets a stick centred there, so the control is
 * always under the thumb rather than the thumb having to find the control. A
 * fixed pad is a thing you look down at, and there is nothing to look at on a
 * phone held in front of a game.
 */
export const zoneFor = (x: number, width: number): TouchZone => (x < width / 2 ? 'left' : 'right')
