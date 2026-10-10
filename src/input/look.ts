// src/input/look.ts — looking around, which is not flying.
//
// ── Why this is not a `FlightActions` field ───────────────────────────────
//
// Because a look is a VIEW command, and the sim consumes `FlightActions` and
// nothing else (CLAUDE.md rule 4 in spirit — the same argument `xr.ts` makes
// for keeping recentre out). More practically: in a headset there is no look
// control at all, because you have a neck. This whole file is the flat-screen
// stand-in for a neck.
//
// ── The bug it is the answer to ──────────────────────────────────────────
//
// The hangar had no look control of its own, so it borrowed the flight stick:
// `seatLookYaw -= actions.yaw`, `seatLookPitch -= actions.pitch`. Under the old
// mapping that meant **the left stick's vertical turned you left and right**
// and the right stick's vertical looked up and down BACKWARDS — a flight-sim
// pitch convention on a control that is not a pitch. Matt, 2026-09-13, with a
// PS5 pad: *"look up/down is reversed; look left/right should be on right
// stick... this makes me wonder if you're using the flight controls vs the
// standard three.js fps look controls."* He was right, and that is exactly what
// was happening. DEV-070.
//
// ── Two devices, one convention ──────────────────────────────────────────
//
// A look is measured in RADIANS THIS FRAME, so a stick (a rate, integrated over
// dt) and a mouse (a displacement, already absolute) can be added together
// without the caller knowing which one moved. Both obey the same signs, which
// are three.js's and not the flight model's:
//
//   push right / move the mouse right -> look RIGHT -> yaw DECREASES
//   push up    / move the mouse up    -> look UP    -> pitch INCREASES
//
// (Yaw is a Y-Euler on a camera looking down −Z, so turning right is negative;
// pitch is an X-Euler, and positive tilts the nose of the *view* up.)
//
// `invertPitch` still applies. It is the global "invert Y" preference (D16) and
// somebody who inverts their pitch stick expects their look inverted too — one
// switch, as 2016's `InputManager.InvertYAxis` was.
//
// ── Which device, and when ───────────────────────────────────────────────
//
// The mouse always (click the canvas to capture the pointer, Escape to give it
// back — see `attachMouseLook`). The flight controls — the pad's right stick,
// and the
// keyboard — ONLY where they are free, which is the hangar: there is no ship
// there, so they have nothing else to do and looking is their whole job. In a
// mission the right stick's horizontal is the aileron (scheme "a") and W is the
// elevator, so neither is read and the mouse is the only look device. That is
// what `flightIdle` gates. Giving one axis two meanings on one screen is how
// you get a ship that rolls when you glance left.
//
// The keyboard is NOT optional here, and forgetting it broke the game for an
// entire tier of player. When the hangar's look moved off `FlightActions`, a
// keyboard-only visitor could no longer turn the chair — so they could not put
// the nose pointer on a holotable, so they could not select a level at all, on
// a tier the landing page advertises as "Playable". `pnpm check` was green;
// `menu-screen.spec.ts` said it in one line, because it drives that screen with
// W and S like a person without a pad would.

import { applyPitchInvert, type FlightActions } from './actions'
import { firstStandardPad, shapeAxis } from './gamepad'

/** Radians to add to the view this frame. Zero on both axes is "no look". */
export interface LookDelta {
  readonly yaw: number
  readonly pitch: number
}

export const NO_LOOK: LookDelta = { yaw: 0, pitch: 0 }

/**
 * Radians a second at full stick deflection.
 *
 * Was 1.6 when the hangar integrated the flight stick, and stays 1.6: it is the
 * one number in the old look that nobody complained about, and changing a feel
 * constant in the same pass as a mapping fix makes the mapping fix unreviewable.
 */
export const LOOK_RATE = 1.6

/**
 * Radians per pixel of mouse movement — about 0.14° a pixel.
 *
 * Deliberately near the middle of what shooters ship, because this is a look
 * and not an aim: nothing is being hit with it, and a player who wants a fast
 * one has an OS mouse speed.
 */
export const MOUSE_SENSITIVITY = 0.0025

/**
 * Negate, but keep zero POSITIVE.
 *
 * `-0` looks around exactly as well as `0` does, and it is never what a caller
 * means: it makes a motionless frame compare unequal to `NO_LOOK` under
 * `Object.is`, which is what `toEqual` uses. Every axis here is negated at some
 * point, so without this a centred stick produces a delta that says it moved.
 */
const flip = (n: number): number => (n === 0 ? 0 : -n)

export interface LookOptions {
  readonly invertPitch: boolean
  /**
   * The flight controls have nothing to fly, so they may look instead.
   *
   * True in the hangar, false in a mission. Named for the CONDITION rather than
   * for a device, because it gates two of them — the pad's right stick and the
   * whole keyboard — and a flag called `stick` that also silences W and S is
   * the next bug in this file.
   */
  readonly flightIdle: boolean
}

/** The right stick's contribution, as radians over `dt`. Pure but for the pad read. */
export const readStickLook = (dt: number, opts: LookOptions): LookDelta => {
  if (!opts.flightIdle) return NO_LOOK
  const pad = firstStandardPad()
  if (!pad) return NO_LOOK
  const x = shapeAxis(pad.axes[2] ?? 0)
  const y = shapeAxis(pad.axes[3] ?? 0)
  const pitch = flip(y * LOOK_RATE * dt)
  return { yaw: flip(x * LOOK_RATE * dt), pitch: applyPitchInvert(pitch, opts.invertPitch) }
}

/**
 * The keyboard's contribution, from the actions it has already produced.
 *
 * Takes `FlightActions` rather than reading keys itself, for two reasons. The
 * ramp is in there — a key is on or off and a look that snapped to full rate
 * would be unusable — and so is `invertPitch`, ALREADY APPLIED, which is why
 * this must not apply it a second time.
 *
 * The axes it reads are the ones a chair has no use for:
 *
 *   pitch (W / S, arrows)      -> look up and down
 *   roll  (A / D, arrows) and  -> look left and right
 *   yaw   (Q / E)
 *
 * Roll doing a yaw's job is deliberate: nothing banks in a chair, and A and D
 * are where a hand already is. Both are folded together and clamped so holding
 * D and E is not twice the rate.
 *
 * ── The signs, and why one of them is not flipped ──────────────────────────
 *
 * `+pitch` is nose DOWN, which is the stick pushed forward, which is the same
 * physical gesture as a mouse pushed forward — and that LOOKS UP. So pitch
 * passes through unflipped, and the apparent mismatch is the whole distinction
 * Matt drew: a look and an elevator read the same gesture opposite ways, and
 * the old hangar was wrong precisely because it used the elevator's answer.
 * `+roll` banks left and `+yaw` turns right, so both are flipped to face the
 * look the same way.
 */
export const readKeyboardLook = (keys: FlightActions, dt: number, opts: LookOptions): LookDelta => {
  if (!opts.flightIdle) return NO_LOOK
  const turn = Math.max(-1, Math.min(1, flip(keys.roll) + keys.yaw))
  return { yaw: flip(turn * LOOK_RATE * dt), pitch: keys.pitch * LOOK_RATE * dt }
}

export interface MouseLook {
  /**
   * Take the movement accumulated since the last call, in radians, and clear it.
   *
   * CONSUMING, which is the only correct shape: a mouse reports displacement,
   * so a reader that peeked without clearing would apply the same flick on
   * every frame until the next one arrived.
   */
  read(opts: LookOptions): LookDelta
  /**
   * Take the click that was NOT spent capturing the pointer. DEV-301.
   *
   * CONSUMING, like `read` and for a sharper reason: a click is an edge, it can
   * land and lift between two animation frames, and a latch that was peeked at
   * rather than spent would press the same button on every frame after it. Same
   * shape as `touch-overlay.ts`'s tap latch and `xr-select.ts`'s.
   *
   * ── What this is a piece of ───────────────────────────────────────────────
   *
   * **The mouse is a CURSOR or a NECK, never both, and pointer lock is the
   * switch.** While it is a neck a click means *select what I am aiming at* —
   * the same `confirm` the pad's A, Enter, the XR trigger and a finger all
   * ride, because `pause.pick` takes a RAY and the nose already aims one. The
   * mouse is a fifth aimer, not a cursor the game has to draw.
   *
   * The click that TURNS it into a neck is spent on that and reported false,
   * and the reason is not tidiness: **an unlocked mouse moves nothing** — the
   * reader above returns `NO_LOOK` when `!locked` — so a click from that state
   * has no aim to select with. That is also what keeps the click-to-focus
   * gesture from pressing a button: a player (or a spec) who clicks the canvas
   * to give the page focus buys the capture and nothing else.
   *
   * On a screen where the mouse can never become a neck — `setEnabled(false)`:
   * a session, and the title before its rows are up — there is no capture to
   * spend a click on, so every click is reported.
   *
   * **And a cursor click that lands ON something is a press of it (DEV-418).**
   * The title looks around like the hangar now, so the capture is live there
   * — but the title also draws rows you can click with the cursor (DEV-353),
   * and a cursor on a row HAS an aim: where it landed. So a click from the
   * cursor state asks `setCursorTarget`'s test first. Yes: it is reported, and
   * nothing is captured. No: it is the capture, as everywhere else. The rule
   * is unchanged — an unlocked click with nothing under it has no aim, and is
   * spent on becoming a neck — it has simply learned that a cursor can be ON
   * something.
   */
  readClick(): boolean
  /**
   * Where a click from the CURSOR state presses rather than captures, by its
   * client position; null for nowhere. Consulted only while enabled and
   * unlocked: a neck's click is always a press, and a disabled mouse always
   * reports.
   *
   * One test per `slot`, and a click presses if ANY slot says yes. The title
   * holds the default slot (DEV-418); the pause plate holds `'pause'`
   * (DEV-563 follow-up: a free cursor over the plate after Escape), so the
   * two screens own their own tests and neither has to know the other's.
   */
  setCursorTarget(hits: ((clientX: number, clientY: number) => boolean) | null, slot?: string): void
  /**
   * Take the capture the PLAYER let go of since the last call. DEV-563.
   *
   * CONSUMING, like `readClick`, because it is an edge: true once for each
   * time the pointer left the canvas by any hand but this file's own
   * `setEnabled(false)` / `dispose`. That is Escape, almost always. While the
   * pointer is captured Chrome keeps Escape for itself: the page receives no
   * keydown and no keyup, only a `pointerlockchange` (measured 2026-10-01 with
   * an OS-level key press; a CDP press is delivered as a keydown instead and
   * releases nothing, so a spec cannot stand in for this half). So a lost
   * capture is the only form a captured player's Escape ever takes, and
   * `app.ts` opens the pause menu on it. Tabbing away loses the capture the
   * same way and reads the same, which is the pause a player wants there too.
   *
   * The game's OWN release is not reported: leaving for a headset, the title
   * before its rows, the editor. Those are the game changing screens, not the
   * player asking for a menu.
   */
  readLostCapture(): boolean
  /**
   * Where the FREE cursor moved to since the last call, client pixels, or null
   * if it has not moved (or is captured, when there is no cursor). DEV-563
   * follow-up: the pause plate selects the row under a cursor that moves onto
   * it, so a still mouse never fights the arrow keys for the selection.
   * CONSUMING, so a move is one selection, not one per frame.
   */
  readHover(): { readonly x: number; readonly y: number } | null
  /** Whether the pointer is captured, i.e. whether the mouse is looking right now. */
  readonly locked: boolean
  /**
   * Turn the mouse off — for an XR session, where the neck does this job.
   *
   * Releases the pointer if it is held: a captured cursor at the moment the
   * headset takes over is a cursor nobody can see or get back.
   */
  setEnabled(enabled: boolean): void
  dispose(): void
}

/** A `MouseLook` that never moves. What a host with no Pointer Lock API gets. */
export const noMouseLook = (): MouseLook => ({
  read: () => NO_LOOK,
  readClick: () => false,
  readLostCapture: () => false,
  readHover: () => null,
  setCursorTarget: () => {},
  locked: false,
  setEnabled: () => {},
  dispose: () => {},
})

/**
 * Click the canvas to capture the pointer; Escape gives it back.
 *
 * ── This is the convention, and the convention is right ───────────────────
 *
 * Pointer Lock is what the API was built for — web.dev's introduction is
 * literally *"Pointer lock and first person shooter controls"* — and click to
 * capture, Escape to release is what every mouse-look page on the web does.
 * The alternative, reading `mousemove` unlocked, is strictly worse: the view
 * stops at the window edge, which is the exact defect the API exists to remove.
 *
 * Three things the spec asks of a caller, all obeyed here:
 *
 *  - **The request needs transient activation.** It is made from a click and
 *    from nothing else. Nothing here ever captures the pointer on its own.
 *  - **Escape always wins.** The browser releases on Escape and a page cannot
 *    rebind it or refuse. Nothing here tries.
 *  - **Never re-enter immediately.** A player who pressed Escape meant it. The
 *    next CLICK captures again, which is the "click to play" idiom; a
 *    `pointerlockchange` that re-requested would be a page fighting its user.
 *
 * `unadjustedMovement` is deliberately NOT requested. It would hand back raw
 * counts with the OS acceleration curve removed, which is right when the mouse
 * is aiming a weapon and wrong here: this is a look, nothing is being hit with
 * it, and the player's own pointer settings are a better default than ours.
 * Chrome and Edge honour the flag, Firefox ignores it and Safari does not
 * define it, so asking also buys a three-engine fallback path for a preference
 * nobody asked for. One line if that ever changes.
 *
 * ── What a locked pointer costs, and who pays it ─────────────────────────
 *
 * **While the pointer is locked, the canvas receives every mouse event and
 * nothing else on the page is clickable.** That is not a quirk, it is the
 * feature — but it means any DOM the game draws over the canvas is unreachable
 * until the pointer is released. `?lookdev=1`'s panel is the one that exists
 * today, and a player has to press Escape before they can drag its sliders.
 *
 * It cost a day to learn that, because the first version captured on click and
 * the e2e suite went from 1.7 min to nine, with `lookdev.spec.ts` failing two
 * runs in three. The error was exact and I did not read it closely enough:
 *
 *     performing click action
 *     <canvas id="viewport"> intercepts pointer events
 *     retrying click action   (until a five-minute timeout)
 *
 * Not a harness artifact — Chrome doing precisely what pointer lock says. The
 * harness answer is in `tests/e2e/fixtures/canvas.ts`: the specs press Escape,
 * in effect, the way a player does. What it is NOT is a switch that makes the
 * game skip the capture under test; that would make the tested path differ from
 * the played path, and this project has already shipped a headset build whose
 * one untested path was the one a human uses.
 */
export const attachMouseLook = (canvas: HTMLElement | null): MouseLook => {
  const doc = canvas?.ownerDocument ?? null
  if (!canvas || !doc || typeof canvas.requestPointerLock !== 'function') return noMouseLook()

  let yawPixels = 0
  let pitchPixels = 0
  let locked = false
  let enabled = true
  /** A click the capture did not spend, waiting for `readClick`. */
  let clicked = false
  /** DEV-418: what a cursor click can land on and press. See `setCursorTarget`. */
  const cursorTargets = new Map<string, (clientX: number, clientY: number) => boolean>()
  const cursorTarget = (x: number, y: number): boolean => {
    for (const hits of cursorTargets.values()) if (hits(x, y)) return true
    return false
  }
  /** DEV-563 follow-up: where a FREE cursor moved to, waiting for `readHover`. */
  let hover: { readonly x: number; readonly y: number } | null = null
  /** DEV-563: a capture the player let go of, waiting for `readLostCapture`. */
  let lostCapture = false
  /** DEV-563: the release in flight is OURS, so the change it causes is not the player's. */
  let releasing = false

  const onClick = (e: Event) => {
    // The capture comes first and takes the click with it: never from anything
    // but a click (the request needs transient activation and the player needs
    // to have asked), and never while already captured.
    if (enabled && !locked) {
      // ...unless the cursor is ON something that takes a click (DEV-418): then
      // the click has an aim, and it is a press of that, not a capture.
      const at = e as MouseEvent
      if (cursorTarget(at.clientX ?? Number.NaN, at.clientY ?? Number.NaN)) {
        clicked = true
        return
      }
      try {
        // Chrome returns a promise that rejects on an unfocused document; Safari
        // returns undefined. Both have to be survivable, and a refusal just means
        // the stick and the keyboard are still flying the ship.
        void Promise.resolve(canvas.requestPointerLock()).catch(() => {})
      } catch {
        // A webview with the API present and disabled.
      }
      return
    }
    // Every other click is the NECK clicking — or, where there is no capture to
    // be had at all, the cursor pressing the one thing on the screen. See
    // `readClick`, which is where that rule is written down.
    clicked = true
  }

  const onLockChange = () => {
    const was = locked
    locked = doc.pointerLockElement === canvas
    // DEV-563: a capture that ended without `release` asking for it ended at
    // the player's hand. A change either way settles whatever we asked for.
    if (was && !locked && !releasing) lostCapture = true
    releasing = false
    // A cursor position from before the change is not where the cursor is now.
    hover = null
    // Movement from either side of the transition is movement the player did
    // not aim with: the click that captured it, or the flick that let it go.
    yawPixels = 0
    pitchPixels = 0
  }

  const onMove = (e: Event) => {
    const me = e as MouseEvent
    if (!locked) {
      // DEV-563 follow-up: a free cursor is a position, for `readHover`.
      const x = me.clientX
      const y = me.clientY
      if (Number.isFinite(x) && Number.isFinite(y)) hover = { x, y }
      return
    }
    // `movementX/Y`, which under lock is the only thing that means anything —
    // there is no cursor position while the pointer is captured.
    yawPixels += me.movementX ?? 0
    pitchPixels += me.movementY ?? 0
  }

  canvas.addEventListener('click', onClick)
  doc.addEventListener('pointerlockchange', onLockChange)
  // `pointerlockerror` is deliberately unhandled: a refused capture is a
  // no-op, and the one wrong response would be to ask again.
  doc.addEventListener('mousemove', onMove)

  const release = () => {
    if (!locked) return
    releasing = true
    try {
      doc.exitPointerLock?.()
    } catch {
      // Already gone. Nothing to do and nothing worth saying.
      releasing = false
    }
  }

  return {
    get locked() {
      return locked
    },
    read(opts) {
      if (!locked) return NO_LOOK
      const yaw = flip(yawPixels * MOUSE_SENSITIVITY)
      const pitch = flip(pitchPixels * MOUSE_SENSITIVITY)
      yawPixels = 0
      pitchPixels = 0
      return { yaw, pitch: applyPitchInvert(pitch, opts.invertPitch) }
    },
    readClick() {
      const was = clicked
      clicked = false
      return was
    },
    readHover() {
      const at = hover
      hover = null
      return at
    },
    readLostCapture() {
      const was = lostCapture
      lostCapture = false
      return was
    },
    setCursorTarget(hits, slot = 'default') {
      if (hits) cursorTargets.set(slot, hits)
      else cursorTargets.delete(slot)
    },
    setEnabled(next) {
      enabled = next
      if (!next) release()
    },
    dispose() {
      canvas.removeEventListener('click', onClick)
      doc.removeEventListener('pointerlockchange', onLockChange)
      doc.removeEventListener('mousemove', onMove)
      release()
    },
  }
}

/** Both look devices, summed. The caller never learns which one moved. */
export const addLook = (a: LookDelta, b: LookDelta): LookDelta => ({
  yaw: a.yaw + b.yaw,
  pitch: a.pitch + b.pitch,
})

// ── Free look, which is the COCKPIT's version and not the hangar's ────────

/**
 * How far the head may turn in the seat, radians. ~115° and ~57°.
 *
 * Not a full 180: past that the cockpit shell is between you and everything,
 * and a flat-screen player has no proprioception to tell them which way they
 * are facing.
 */
export const FREE_LOOK_YAW_LIMIT = 2
export const FREE_LOOK_PITCH_LIMIT = 1

/** Seconds of no movement before the view starts coming back, and its time constant. */
export const FREE_LOOK_HOLD = 0.6
export const FREE_LOOK_RETURN_TAU = 0.18

/** What `FreeLook.update` needs to know beyond the delta. */
export interface FreeLookOptions {
  /**
   * False while a MENU is up: the view stays exactly where the player put it.
   *
   * DEV-300. Matt, 2026-09-23: *"look auto-reset should be off while the pause
   * plate is up."* The return exists for one reason, and this file states it —
   * *"a player who glanced left at 300 m/s, let go of the mouse, and is now
   * flying into an island they cannot see."* With the plate up the sim is
   * frozen: nobody is at 300 m/s, there is no island arriving, and the only
   * thing the timer can measure is somebody READING, which is what a menu is
   * for. A flight behaviour was running under a menu.
   *
   * It is not cosmetic. On a flat screen this free look is also what AIMS the
   * plate — `app.ts` picks the row under the gaze — so 0.6 s after you stop
   * moving the mouse the aim slid off the row you were about to choose and
   * back to the title band, which selects nothing.
   *
   * The idle timer does not advance either, so unpausing gives you the whole
   * `FREE_LOOK_HOLD` again rather than an instant return on the first frame.
   */
  readonly recentre: boolean
}

/** The default, and what flying wants: the view comes back. */
const RECENTRING: FreeLookOptions = { recentre: true }

export interface FreeLook {
  readonly yaw: number
  readonly pitch: number
  /** Apply this frame's look and advance the return. */
  update(delta: LookDelta, dt: number, opts?: FreeLookOptions): void
  /** Snap back to straight ahead — on a restart, or leaving the cockpit. */
  reset(): void
}

/**
 * A look that comes BACK.
 *
 * The hangar's look does not do this: you are parked, you turned to face a
 * table, and you want to still be facing it. A cockpit's does, because the
 * alternative is a player who glanced left at 300 m/s, let go of the mouse, and
 * is now flying into an island they cannot see. A glance is cheap and a stuck
 * view is expensive, so the view returns whenever the mouse has been still for
 * `FREE_LOOK_HOLD`.
 *
 * No three.js and no DOM: it is two numbers and a timer, so it can be tested
 * without either.
 */
export const createFreeLook = (): FreeLook => {
  let yaw = 0
  let pitch = 0
  let idle = 0

  const clamp = (v: number, limit: number): number => (v > limit ? limit : v < -limit ? -limit : v)

  return {
    get yaw() {
      return yaw
    },
    get pitch() {
      return pitch
    },
    update(delta, dt, opts = RECENTRING) {
      if (delta.yaw !== 0 || delta.pitch !== 0) {
        yaw = clamp(yaw + delta.yaw, FREE_LOOK_YAW_LIMIT)
        pitch = clamp(pitch + delta.pitch, FREE_LOOK_PITCH_LIMIT)
        idle = 0
        return
      }
      // A held view does not accumulate idle either. Otherwise the menu would
      // bank up a return and spend it on the first frame after the unpause,
      // which is the same swing one gesture later.
      if (!opts.recentre) return
      idle += dt
      if (idle < FREE_LOOK_HOLD) return
      // Exponential, not linear: it decelerates into centre instead of stopping
      // dead, and it is frame-rate independent without a special case at dt=0.
      const k = 1 - Math.exp(-dt / FREE_LOOK_RETURN_TAU)
      yaw -= yaw * k
      pitch -= pitch * k
      // Otherwise it converges forever and the camera carries a 1e-17 rotation.
      if (Math.abs(yaw) < 1e-4) yaw = 0
      if (Math.abs(pitch) < 1e-4) pitch = 0
    },
    reset() {
      yaw = 0
      pitch = 0
      idle = 0
    },
  }
}
