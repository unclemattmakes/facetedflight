// src/input/keyboard.ts — the keyboard as a flight stick.
//
// Not the intended way to play — the 2016 game is a gamepad game and the port
// is a gamepad-and-headset game — but the landing page promises a flat build
// that runs "with a gamepad or keyboard", and a visitor with neither should
// still be able to fly rather than watch.
//
// Produces the same `FlightActions` every other source produces. The sim never
// learns which device it came from (PORT_PLAN §2.6).
//
// ── Why the axes ramp ─────────────────────────────────────────────────────
//
// A key is on or off; a stick is not. Feeding raw 0/1 into a flight model tuned
// for analogue input gives twitchy, unflyable control — the HoverJet has no
// auto-level (DEV-001), so every input is held until it is taken out, and a
// binary roll axis means the aircraft is always either level or slamming.
// Ramping over ~180 ms approximates a stick being pushed, and self-centres at
// the same rate. It is a KEYBOARD concern, so it lives here and not in the sim.

import { slewToward } from '@/sim/math/scalar'
import { applyPitchInvert, type FlightActions, noActions } from './actions'

/** Seconds from 0 to full deflection, and back. */
const RAMP_SECONDS = 0.18

export interface KeyboardOptions {
  invertPitch: boolean
}

export interface KeyboardSource {
  /** Advance the ramps and read the current actions. */
  read(dt: number, opts: KeyboardOptions): FlightActions
  /**
   * The pitch axis WITHOUT the ramp — exactly 0 or ±1. For a MENU (DEV-299).
   *
   * Same convention as `read().pitch`, `invertPitch` and all: it is what that
   * field would be if the ramp were instant, so it can be handed to `menuNudge`
   * in its place and the direction still lives in one function.
   *
   * ── Why a menu may not read the ramped one ─────────────────────────────
   *
   * Compose the two constants and the answer is arithmetic. `menuNudge` wants
   * `MENU_NUDGE_DEADBAND` of deflection and the ramp takes `RAMP_SECONDS` to
   * reach full, so **an arrow key must be held 0.5 x 0.18 = 90 ms before the
   * menu sees anything at all** — and a tap shorter than that moves nothing, no
   * matter how many of them you make. Matt, 2026-09-23: *"arrow keys need
   * several presses in the pause screen."*
   *
   * The ramp is right for flying (a key is on or off and a stick is not) and
   * wrong for a list, which is the same shape as the correction already in
   * `menuNudge`'s header — *"the invert has no business reaching a menu."* The
   * D-pad path, `xr.menuStep`, has always read the BUTTON and has never had
   * this bug, which is the strongest evidence available that a flight axis is
   * the wrong input for a row.
   *
   * The RELEASE half matters as much as the press and is easier to miss: a
   * ramp that is still decaying past the deadband keeps the caller's
   * edge-detector held, so a second tap inside ~90 ms of the first is eaten.
   * That is why `app.ts` takes this INSTEAD of the keyboard's ramped axis and
   * not as well as it.
   */
  menuPitch(opts: KeyboardOptions): number
  /**
   * The launch key is DOWN right now.
   *
   * Not a `FlightActions` field: the sim consumes those and nothing else, and
   * "begin the mission" is not a control surface the flight model should see.
   */
  readonly confirm: boolean
  /** The autopilot toggle is DOWN. The caller edge-detects. */
  readonly toggleAutopilot: boolean
  /** The third-person camera key is DOWN. The caller edge-detects. DEV-128. */
  readonly toggleCamera: boolean
  /** The pause key is DOWN. The caller edge-detects — it is a TOGGLE. */
  readonly pause: boolean
  /**
   * Escape is DOWN, pressed while the pointer was free. The caller
   * edge-detects. DEV-563: see `ESCAPE_KEYS` for why a captured press is not.
   */
  readonly escape: boolean
  /** "Race this lap" (R) is DOWN. The caller edge-detects, and reads it only on the results panel. DEV-371. */
  readonly raceLap: boolean
  /** "Share this lap" (G) is DOWN. The caller edge-detects, and reads it only on the results panel. DEV-373. */
  readonly shareLap: boolean
  /**
   * ENTER VR (H, for headset) is DOWN. The caller edge-detects, and reads it
   * only flat, with a headset there. DEV-557: the key hint the title's ENTER VR
   * plate shows, and the way in from a screen that has no plate.
   */
  readonly enterVr: boolean
  /** Whether any flight key has been pressed since attach. Drives the hint text. */
  readonly used: boolean
  dispose(): void
}

/**
 * Named for what the ship DOES, not for which way the key points.
 *
 * They used to be named for the key — `pitchDown: ['ArrowUp', 'KeyW']` — and
 * two of the three were wired backwards behind the name. W pitched the nose UP
 * and D banked LEFT, while the same gesture on a pad did the opposite in both
 * cases: a stick pushed forward dives and a stick pushed right banks right.
 *
 * Nothing caught it in four sessions because **no test compares the two
 * devices**. `xr-input.test.ts` compares VR to the pad, thoroughly; nothing
 * compared the keyboard to anything, so each device was self-consistent and
 * they disagreed with each other. Same shape as the control-scheme bug in
 * `gamepad.ts`, one layer down.
 *
 * It surfaced because Matt asked for an invert-pitch option (D16, one switch
 * for the whole game) — and a switch that corrects one device and breaks
 * another is not an option, it is a second bug with a menu row. `+pitch` is
 * nose DOWN and `+roll` banks LEFT (`sim/autopilot.ts:41-44`, measured), so the
 * names below are the truth and the arithmetic follows them. DEV-071.
 */
export const BINDINGS = {
  /** The stick pushed forward. */
  noseDown: ['ArrowUp', 'KeyW'],
  noseUp: ['ArrowDown', 'KeyS'],
  bankLeft: ['ArrowLeft', 'KeyA'],
  bankRight: ['ArrowRight', 'KeyD'],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],
  throttle: ['ShiftLeft', 'ShiftRight', 'Space'],
  boost: ['KeyZ', 'ControlLeft'],
  brake: ['KeyX'],
  airbrake: ['KeyC'],
} as const

/**
 * Launch. Deliberately NOT `KeyA` even though the pad button is A: `KeyA` is
 * roll-left here, and a key that both starts the mission and banks the ship is
 * a key you press by accident on the way to the first gate.
 */
export const CONFIRM_KEYS = ['Enter', 'NumpadEnter'] as const

/** Autopilot toggle. P for pilot, and nothing else is bound to it. */
export const AUTOPILOT_KEYS = ['KeyP'] as const

/**
 * The third-person camera toggle (DEV-128). `V` is 2016's own binding:
 * `CameraMode.cs:Update()` toggles its cameras on `KeyCode.V`. Nothing else
 * here is bound to it — `L` is the lookdev panel and `O` the wireframe cycle,
 * both in `boot/app.ts`, and `tests/unit/third-person-input.test.ts` holds
 * that V moves no flight axis.
 */
const CAMERA_KEYS = ['KeyV'] as const

/**
 * Pause. `Backspace` is 2016's own binding (`Input_Ship.cs:349-363`).
 *
 * Escape is NOT in this list, and is not a second pause key. It is its own
 * reading, `escape` below (DEV-563), because the browser owns it: while the
 * pointer is captured Chrome spends Escape on letting go, and the page sees no
 * key at all, only the capture ending (`look.ts`'s `readLostCapture`). The two
 * halves are one control in `app.ts`.
 */
const PAUSE_KEYS = ['Backspace'] as const

/**
 * Escape, read only while the pointer is FREE (DEV-563). Matt, 2026-10-01:
 * Escape opens the pause menu in flight.
 *
 * A captured Escape never reaches a page in Chrome (measured with an OS-level
 * press: no keydown, no keyup, just `pointerlockchange`), and `look.ts`
 * reports that release instead. A browser that DID deliver it would hand the
 * game the same press twice, once as this key and once as the release, and the
 * second would close the menu the first opened. So a keydown that arrives while
 * the pointer is captured is not recorded here: the release speaks for it.
 */
const ESCAPE_KEYS = ['Escape'] as const

/** Whether this page holds the pointer. The default `captured` for `attachKeyboard`. */
const pointerCaptured = (): boolean =>
  (globalThis as { document?: { pointerLockElement?: unknown } }).document?.pointerLockElement !=
  null

/**
 * "Race this lap" on the results panel (DEV-371). R for race, and nothing else
 * is bound to it: not a flight key, not L (the lookdev panel) and not O (the
 * wireframe cycle), both in `boot/app.ts`.
 */
export const RACE_LAP_KEYS = ['KeyR'] as const

/**
 * "Share this lap" on the results panel (DEV-373). G, for the ghost it posts:
 * S would be the obvious letter and is the nose-up key, and nothing else is
 * bound to G — not a flight key, not L (the lookdev panel) and not O (the
 * wireframe cycle), both in `boot/app.ts`.
 */
export const SHARE_LAP_KEYS = ['KeyG'] as const

/**
 * ENTER VR (DEV-557). H, for headset, and nothing else is bound to it: not a
 * flight key, not L (the lookdev panel) or O (the wireframe cycle) in
 * `boot/app.ts`, not the results panel's R and G. A KEY because
 * `requestSession` needs transient user activation, which a keydown is and a
 * gamepad press is not; so this is also what the title's plate tells a pad.
 */
export const ENTER_VR_KEYS = ['KeyH'] as const

export const attachKeyboard = (
  target: EventTarget = globalThis,
  captured: () => boolean = pointerCaptured,
): KeyboardSource => {
  const down = new Set<string>()
  let used = false

  const onDown = (e: Event) => {
    const key = (e as KeyboardEvent).code
    // DEV-563: an Escape the browser is spending on the capture is not ours.
    if (key === 'Escape' && captured()) return
    down.add(key)
    if (!used) {
      for (const codes of Object.values(BINDINGS)) {
        if ((codes as readonly string[]).includes(key)) {
          used = true
          break
        }
      }
    }
    // Arrow keys and space scroll the page; a flight control should not.
    if (used && (key.startsWith('Arrow') || key === 'Space')) e.preventDefault()
  }
  const onUp = (e: Event) => down.delete((e as KeyboardEvent).code)
  // A window blur while a key is held would otherwise leave it stuck down for
  // ever, which reads as "the controls broke".
  const onBlur = () => down.clear()

  target.addEventListener('keydown', onDown)
  target.addEventListener('keyup', onUp)
  globalThis.addEventListener?.('blur', onBlur)

  const held = (codes: readonly string[]): boolean => codes.some((c) => down.has(c))

  // Ramp state, one per analogue axis.
  let pitch = 0
  let roll = 0
  let yaw = 0
  let throttle = 0

  const ramp = (current: number, want: number, dt: number): number =>
    slewToward(current, want, dt / RAMP_SECONDS)

  /**
   * What the pitch keys are ASKING for, before the ramp. One expression, read by
   * `read` and by `menuPitch`, so the flight axis and the menu axis cannot come
   * to disagree about which key is nose-up — which is the bug this whole file's
   * header is about, one layer down.
   */
  const wantPitch = (): number =>
    (held(BINDINGS.noseDown) ? 1 : 0) - (held(BINDINGS.noseUp) ? 1 : 0)

  return {
    get used() {
      return used
    },
    get confirm() {
      return held(CONFIRM_KEYS)
    },
    get toggleAutopilot() {
      return held(AUTOPILOT_KEYS)
    },
    get toggleCamera() {
      return held(CAMERA_KEYS)
    },
    get pause() {
      return held(PAUSE_KEYS)
    },
    get escape() {
      return held(ESCAPE_KEYS)
    },
    get raceLap() {
      return held(RACE_LAP_KEYS)
    },
    get shareLap() {
      return held(SHARE_LAP_KEYS)
    },
    get enterVr() {
      return held(ENTER_VR_KEYS)
    },
    menuPitch(opts: KeyboardOptions): number {
      return applyPitchInvert(wantPitch(), opts.invertPitch)
    },
    read(dt: number, opts: KeyboardOptions): FlightActions {
      const out = noActions()
      // Each line reads "the action this axis is POSITIVE for, minus the other".
      // +pitch is nose down, +yaw is nose right, +roll banks left — all three
      // measured off the integrator, never reasoned from the axis conventions.
      const wantRoll = (held(BINDINGS.bankLeft) ? 1 : 0) - (held(BINDINGS.bankRight) ? 1 : 0)
      const wantYaw = (held(BINDINGS.yawRight) ? 1 : 0) - (held(BINDINGS.yawLeft) ? 1 : 0)
      const wantThrottle = held(BINDINGS.throttle) ? 1 : 0

      pitch = ramp(pitch, wantPitch(), dt)
      roll = ramp(roll, wantRoll, dt)
      yaw = ramp(yaw, wantYaw, dt)
      throttle = ramp(throttle, wantThrottle, dt)

      out.pitch = applyPitchInvert(pitch, opts.invertPitch)
      out.roll = roll
      out.yaw = yaw
      out.throttle = throttle
      out.boost = held(BINDINGS.boost)
      out.brake = held(BINDINGS.brake)
      out.airbrake = held(BINDINGS.airbrake)
      return out
    },
    dispose() {
      target.removeEventListener('keydown', onDown)
      target.removeEventListener('keyup', onUp)
      globalThis.removeEventListener?.('blur', onBlur)
      down.clear()
    },
  }
}
