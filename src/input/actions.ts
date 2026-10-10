// src/input/actions.ts — the action set. Every input source (gamepad, keyboard,
// XR controllers) produces one of these per frame; the sim consumes nothing
// else. Adding a device must never mean touching the sim.

export interface FlightActions {
  /** −1 … 1. Body X torque. Sign is AFTER the global pitch-invert option. */
  pitch: number
  /** −1 … 1. Body Y torque. */
  yaw: number
  /** −1 … 1. Body Z torque, applied NEGATED (body Z = −roll in the 2016 rig). */
  roll: number
  /** 0 … 1. */
  throttle: number
  boost: boolean
  /**
   * DEV-410: the part of the boost the tank paid for this tick, 0..1. Absent
   * means the whole boost. Only `app.ts`'s tank step writes it; no device does.
   */
  boostPower?: number
  brake: boolean
  airbrake: boolean
}

export const noActions = (): FlightActions => ({
  pitch: 0,
  yaw: 0,
  roll: 0,
  throttle: 0,
  boost: false,
  brake: false,
  airbrake: false,
})

/**
 * `invertPitch` is a GLOBAL user setting, never a vehicle constant.
 *
 * In 2016 it was InControl's static `InputManager.InvertYAxis` — one switch for
 * the whole game, applied at the input layer. It has already been mistaken for
 * a per-vehicle prefab field once. It lives here, in the settings object, and
 * nowhere else. See CLAUDE.md gotchas and DECISIONS D16.
 *
 * Every reader goes through THIS, the look paths included (they negated by hand
 * with a zero guard of their own). It never hands back `-0` from the inverted
 * branch: a centred stick under invert is `0`, because `-0` looks and flies
 * exactly like `0` but compares unequal to it under `Object.is`, which is what
 * `toEqual` uses.
 */
export const applyPitchInvert = (pitch: number, invertPitch: boolean): number =>
  invertPitch ? (pitch === 0 ? 0 : -pitch) : pitch

/**
 * The control scheme this mapping is written for: 2016's scheme "a", the letter
 * `hoverjet.input.controlScheme` carries on the shipped prefab. Asserted against
 * the sheet, not remembered, in `tests/unit/scheme-a.test.ts`: if the extractor
 * ever finds another letter, `schemeAFlightAxes` has to move, not that test.
 */
export const SCHEME_A = 'a'

/**
 * Scheme "a", `Input_Ship.cs:488-492`, written ONCE for every device:
 *
 *     rollAxis  = device.RightStickX    :490
 *     pitchAxis = device.LeftStickY     :491
 *     yawAxis   = device.LeftStickX     :492
 *
 * The left stick flies the nose and the right stick's horizontal rolls. The
 * pad, the two XR thumbsticks and the two touch thumbs all end here: they
 * differ in where a stick comes from and in the buttons around it, never in
 * which axis does what, and three copies of three lines is how a fourth device
 * gets a fifth opinion (DEV-069 shipped a scheme that exists in no 2016
 * build, on exactly that footing).
 *
 * Inputs are +Y DOWN and +X RIGHT, as a standard pad's and an `xr-standard`
 * thumbstick's are, already shaped by the caller. The signs are MEASURED, not
 * reasoned (`sim/autopilot.ts:41-44`): pitch +1 is nose DOWN, yaw +1 is nose
 * RIGHT, roll +1 banks LEFT. So pitch negates (push forward, dive: which is
 * `invertPitch: false`), yaw does not, roll does. `invertPitch` is the one
 * GLOBAL setting (D16) and is applied here and nowhere above this call.
 *
 * Deliberately returns `-0` for a centred stick under `invertPitch: false`
 * (`-0` is what `-y` is): callers hand it straight to the sim, where it flies as
 * 0, and the old per-device lines did the same.
 *
 * Throttle, boost and brake are NOT here: they differ per device (touch has no
 * trigger, XR splits them across hands).
 */
export const schemeAFlightAxes = (
  leftX: number,
  leftY: number,
  rightX: number,
  invertPitch: boolean,
): Pick<FlightActions, 'pitch' | 'yaw' | 'roll'> => ({
  pitch: applyPitchInvert(-leftY, invertPitch),
  yaw: leftX,
  roll: -rightX,
})

/** Past this much deflection a stick is asking for a row. Deadband, not a dead zone. */
export const MENU_NUDGE_DEADBAND = 0.5

/**
 * Which way a paused menu should step, from the pitch axis. −1 up, +1 down, 0 still.
 *
 * ── Why a menu reads a flight axis at all ─────────────────────────────────
 *
 * Because the pause menu is picked by GAZE, and on a flat screen the "gaze" is
 * the ship's forward — a frozen sim means a frozen ship, so the ray cannot be
 * aimed. The pitch axis moves the selection instead: arrow keys, a pad stick
 * and an XR thumbstick, all through one merged action, on all three routes.
 *
 * ── Why it is a function, and not two lines in `app.ts` ───────────────────
 *
 * It was two lines in `app.ts`, and it was wrong for the pad for the life of the
 * port: the sign said "down the list" was POSITIVE pitch, which was true of
 * ArrowDown and false of a stick, because the pad's reader negates its axis.
 * Pulling the stick back moved the selection UP. Nothing noticed, because the
 * only thing that drives this menu automatically is a Playwright keyboard.
 *
 * That is the third instance of one bug this session: two devices, one
 * convention asserted in a comment, and no test comparing them. Out here it can
 * be handed a number and asked which way it goes.
 *
 * **Down the list is NEGATIVE pitch** — a stick pulled back, and `ArrowDown`,
 * which agree now that `keyboard.ts` and `gamepad.ts` do.
 *
 * `invertPitch` is undone first. It is a FLIGHT preference; nobody who flies
 * pull-back-to-climb asked for a menu that scrolls backwards, and this axis is
 * only borrowed here. `applyPitchInvert` is its own inverse.
 */
export const menuNudge = (pitch: number, invertPitch: boolean): -1 | 0 | 1 => {
  const upright = applyPitchInvert(pitch, invertPitch)
  if (upright < -MENU_NUDGE_DEADBAND) return 1
  if (upright > MENU_NUDGE_DEADBAND) return -1
  return 0
}

/** Every device's BACK, as the raw state of this frame. */
export interface BackSources {
  /** A headset's right-hand B (`xr.back`). */
  readonly xrBack: boolean
  /** A pad's B (`gamepadBack()`): named for the button, not borrowed from the brake. */
  readonly padB: boolean
  /** Backspace (`keyboard.pause`), 2016's pause key and this game's back key. */
  readonly backspace: boolean
  /**
   * Escape while the pointer is FREE and no session is presenting. A captured
   * Escape is the browser's, not the game's (DEV-563), so this is `keyboard.escape`
   * AND not locked AND not in a headset, computed once a frame by the caller.
   */
  readonly freeEscape: boolean
}

/** Which keys a screen counts as BACK, beside B on either controller. */
export interface BackKeys {
  readonly backspace?: boolean
  readonly escape?: boolean
}

/** Backspace and a free Escape: the TV plate and the hangar. */
export const BACK_KEYS_ALL: BackKeys = { backspace: true, escape: true }
/** Backspace only: the title's letter plate (the hangar's back adds Escape on top). */
export const BACK_KEYS_BACKSPACE: BackKeys = { backspace: true }

/**
 * BACK is down: B on a headset's right hand or on a pad, plus the keys the
 * SCREEN says count (`keys`). One definition of "B", where `app.ts` wrote it
 * four ways (DEV-441 title, DEV-605 hangar, DEV-621 pause, DEV-628 TV).
 *
 * The pause plate passes no keys, on purpose: Backspace and Escape already
 * reach it through `nextPaused` and `pausePageBack`, and counting them here
 * too would take one press twice. The title counts Backspace but not Escape,
 * as it did; the hangar's back, which runs on the same press, adds Escape.
 *
 * Raw state, not an edge: the caller steps its own `Edge`.
 */
export const backPressed = (s: BackSources, keys: BackKeys = {}): boolean =>
  s.xrBack ||
  s.padB ||
  (keys.backspace === true && s.backspace) ||
  (keys.escape === true && s.freeEscape)

/**
 * Fold several devices into one action set.
 *
 * Whichever device is actually being used wins, PER AXIS, by magnitude. No mode
 * switch and no "press any key to activate": pick up a pad mid-flight and it
 * just works, and in a headset the Touch sticks and a paired pad coexist
 * without one of them having to be declared the real one.
 *
 * Axes take the larger magnitude, throttle the larger value, and the booleans
 * are an OR — a brake held on any device is a brake.
 */
export const mergeActions = (...sources: FlightActions[]): FlightActions =>
  sources.reduce<FlightActions>(
    (a, b) => ({
      pitch: Math.abs(a.pitch) >= Math.abs(b.pitch) ? a.pitch : b.pitch,
      yaw: Math.abs(a.yaw) >= Math.abs(b.yaw) ? a.yaw : b.yaw,
      roll: Math.abs(a.roll) >= Math.abs(b.roll) ? a.roll : b.roll,
      throttle: Math.max(a.throttle, b.throttle),
      boost: a.boost || b.boost,
      brake: a.brake || b.brake,
      airbrake: a.airbrake || b.airbrake,
    }),
    noActions(),
  )
