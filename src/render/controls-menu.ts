// src/render/controls-menu.ts — the controls, as a page of the pause menu.
//
// ── The bug this file is the answer to ───────────────────────────────────
//
// Matt, 2026-09-13, playing the deployed build with a PS5 pad: *"i don't know
// how to boost."* He did not, and there was no way for him to: this game has
// shipped thirteen missions, two vehicles, three modes and a soundtrack, and
// **it has never once said what any button does.** Not on the landing page, not
// in the cockpit, not in the pause menu. The binding was there (it was R1) and
// the player had no route to it short of reading `gamepad.ts`.
//
// So this page is a reference first and a settings page second. It is built
// like `comfort-menu.ts` — settings in, rows out; index in, new settings out —
// and reuses `pause.ts`'s plate, hit test and row band the same way, for the
// same reason: one plate means one place for the "what you look at and what you
// hit must not drift apart" bug to live.
//
// ── Why most of these rows do nothing when you press A ───────────────────
//
// Because they are LABELS. `comfort-menu.ts` argues that a row which does not
// respond "reads as a broken menu", and that is true of a row that looks like a
// verb. These do not: each one has its binding in the value column, which is
// the same column the comfort page uses for a state, and the note under it says
// what the control does. The one row that IS a setting — invert pitch — is the
// first one, where it is found without reading the rest.
//
// ── It knows whether it is being read in a headset ───────────────────────
//
// `L2` means nothing on a Touch controller and `mouse` means nothing at all, so
// the rows take an `xr` flag. A controls page that names the wrong buttons is
// worse than none: it is a page you consult, disbelieve, and stop consulting.

import type { ComfortSettings } from '@/boot/settings'
import type { LESSON_CONTROL_TOKENS } from '@/content/level-schema'
import type { FlightActions } from '@/input/actions'
import { HOLD_TOGGLE_SECONDS } from '@/input/hold-toggle'
import type { PauseOption } from '@/render/pause'
import { createSettingsPage, type SettingsPage } from '@/render/settings-page'

/** 2016's punctuation, as the pause title and the comfort page have it. */
export const CONTROLS_TITLE = '- CONTROLS -'

/** What the caller still has to do. Only one thing, and it is leaving. */
export type ControlsAction = 'none' | 'back'

/** The label the ROOT pause menu uses for the row that opens this page. */
export const CONTROLS_OPTION: PauseOption = {
  id: 'controls',
  label: 'Controls',
  note: 'what every button does on this device',
}

export interface ControlsContext {
  /** True while an immersive session is running — the rows name different hardware. */
  readonly xr: boolean
  /**
   * True on a phone or a tablet, where every value in the pad column is a lie.
   *
   * `xr` WINS where both are somehow set: a Quest browser reports a touchscreen
   * and nobody in a session is looking at one.
   */
  readonly touch: boolean
  /**
   * True when the last device that produced input was the KEYBOARD. DEV-377.
   *
   * The page had no keyboard column: a flat build without a pad was told `R2`
   * and `L2`, which on a keyboard are nothing. `xr` and `touch` win over it, in
   * that order, for their own reasons above. Absent is false — a pad.
   */
  readonly keyboard?: boolean
}

/** A desktop with a pad: the case this page was written for. */
const FLAT: ControlsContext = { xr: false, touch: false }

/**
 * Which hardware a page or a prompt names. DEV-377.
 *
 * One word for the four columns, so the lesson plate and this page ask the
 * same question and cannot give two answers: `xr` wins, then `touch`, then the
 * keyboard, and a pad is what is left.
 */
export type ControlsDevice = 'xr' | 'touch' | 'keyboard' | 'pad'

/** The device a context names. The precedence is the page's own. */
export const deviceOf = (ctx: ControlsContext): ControlsDevice =>
  ctx.xr ? 'xr' : ctx.touch ? 'touch' : ctx.keyboard ? 'keyboard' : 'pad'

/** A device that is not a headset: the one the page names when you are not in one. */
export type FlatDevice = Exclude<ControlsDevice, 'xr'>

/** Past this much deflection an axis is a player's hand, not a stick resting off-centre. */
const ACTIVE_AXIS = 0.2

/** Did this device's reading this frame come from a hand? Any axis past a rest, any button. */
export const actionsActive = (a: FlightActions): boolean =>
  Math.abs(a.pitch) > ACTIVE_AXIS ||
  Math.abs(a.yaw) > ACTIVE_AXIS ||
  Math.abs(a.roll) > ACTIVE_AXIS ||
  a.throttle > ACTIVE_AXIS ||
  a.boost ||
  a.brake ||
  a.airbrake

/**
 * The last flat device that produced input (DEV-377: "keyed on the last device
 * that produced input", plan §5.1). The pad wins a frame that both used, being
 * the device this game is built for; with nothing touched, nothing changes.
 * The headset is not in here — `app.ts` asks whether one is presenting, which
 * is a fact about the session rather than about a hand.
 */
export const latestFlatDevice = (
  prev: FlatDevice,
  used: { readonly pad: boolean; readonly keyboard: boolean; readonly touch: boolean },
): FlatDevice => (used.pad ? 'pad' : used.keyboard ? 'keyboard' : used.touch ? 'touch' : prev)

/**
 * The flat device a page assumes before any hand has produced input. DEV-596.
 *
 * A phone is touch. A desktop is the KEYBOARD, and it was the pad until the
 * 2026-10-03 persona playtest: a player who only ever used the mouse (the title
 * and the hangar both take a click) read "PRESS A TO CHOOSE" and lesson 1's
 * "Hold R2 to fly." on a laptop with no A and no R2, because the mouse is not a
 * device {@link latestFlatDevice} hears. The keyboard's words are right for a
 * mouse player too: the confirm is Enter (a click also works) and the throttle
 * is Space. A pad is not lost: its first stick or button moves this on, and
 * Chrome hides a pad from the page until a button is pressed anyway, so "no
 * pad yet" is the ordinary state of a desktop at boot.
 */
export const startingFlatDevice = (touch: boolean): FlatDevice => (touch ? 'touch' : 'keyboard')

/** The context that names `device`. {@link deviceOf}'s inverse. */
export const contextFor = (device: ControlsDevice): ControlsContext => ({
  xr: device === 'xr',
  touch: device === 'touch',
  keyboard: device === 'keyboard',
})

/**
 * The keyboard's words, by row. Each names a key `input/keyboard.ts` binds to
 * that action — `lesson-tokens.test.ts` reads the bindings and holds every one
 * of these to them, so a key moved there and not here is a red test rather
 * than a page that names the wrong key. The key a player is likeliest to reach
 * for comes first where two are bound (Space over Shift, Z over Ctrl).
 */
export const KEYBOARD_WORDS = {
  /** `noseDown` / `noseUp`, then `yawLeft` / `yawRight`. */
  fly: 'W/S Q/E',
  /** `bankLeft` / `bankRight`. */
  roll: 'A / D',
  throttle: 'Space',
  boost: 'Z',
  /** The airbrake, which is what the pad's L1 and the phone's BRAKE chip are. */
  slow: 'C',
  /** `CONFIRM_KEYS`. */
  launch: 'Enter',
  /** `noseDown`: the stick pushed forward. */
  noseDown: 'W',
  /** `noseUp`: the stick pulled back. */
  noseUp: 'S',
  /** DEV-598: the keys with no row of their own, each a `*_KEYS` in `input/keyboard.ts`. */
  autopilot: 'P',
  enterVr: 'H',
  raceLap: 'R',
  shareLap: 'G',
} as const

/**
 * The two pitch words for a device, with the invert applied (D16).
 *
 * `up` is what makes the nose climb. With `invertPitch` off — the shipped
 * prefab's value — that is the stick PULLED BACK (`xr-input.test.ts`: "push
 * forward to dive"); with it on, the stick pushed forward. On a keyboard it is
 * the key bound to that same stick direction.
 */
export const pitchWords = (
  s: Pick<ComfortSettings, 'invertPitch'>,
  device: ControlsDevice,
): { readonly up: string; readonly down: string } => {
  if (device === 'keyboard') {
    return s.invertPitch
      ? { up: KEYBOARD_WORDS.noseDown, down: KEYBOARD_WORDS.noseUp }
      : { up: KEYBOARD_WORDS.noseUp, down: KEYBOARD_WORDS.noseDown }
  }
  // A thumb on glass goes up and down; a stick goes forward and back.
  const [stick, forward, back] =
    device === 'touch' ? ['left thumb', 'up', 'down'] : ['left stick', 'forward', 'back']
  return s.invertPitch
    ? { up: `${stick} ${forward}`, down: `${stick} ${back}` }
    : { up: `${stick} ${back}`, down: `${stick} ${forward}` }
}

/**
 * Row ids, in order. Exported so `app.ts` and the tests switch on a NAME.
 *
 * An index is a thing that silently means something else the day a row is
 * inserted, and this page is going to grow a row the first time somebody asks
 * what the B button does.
 */
export const CONTROLS_ROW_IDS = [
  'invert',
  /** A pad or a headset only (DEV-637): a keyboard and a phone have no motor to switch. */
  'haptics',
  'fly',
  'roll',
  'throttle',
  'boost',
  'slow',
  'look',
  /** Flat only — a headset has no third person (DEV-128). */
  'view',
  /** Touchscreens only — the AUTO chip is the only route to the autopilot there. */
  'autopilot',
  /** Keyboard only (DEV-598): the keys with no flight row. DEV-835: two rows of two, not one line of four. */
  'keys',
  'keys2',
  'back',
] as const

export type ControlsRowId = (typeof CONTROLS_ROW_IDS)[number]

const onOff = (b: boolean) => (b ? 'on' : 'off')

/** One word per column. The page's precedence, through {@link deviceOf}. */
const by = <T>(ctx: ControlsContext, words: { readonly [D in ControlsDevice]: T }): T =>
  words[deviceOf(ctx)]

/**
 * The page. Eight rows, which is what the comfort page already costs — see
 * `pause.ts`'s `ROWS_MAX_M` and `comfort-menu.ts`'s note on what a ninth buys.
 *
 * The bindings themselves are `input/gamepad.ts`, `input/xr.ts` and
 * `input/keyboard.ts`, which are 2016's scheme "a" plus the two triggers. If you
 * change one, change this: a controls page is the one document in the game that
 * is checked by a person within seconds of being wrong.
 */
export const controlsRows = (
  s: ComfortSettings,
  ctx: ControlsContext = FLAT,
): readonly PauseOption[] => [
  {
    id: 'invert',
    label: 'Invert pitch',
    // Says which way the setting points, not just that it exists. "On" alone
    // leaves you pressing it twice to find out which one you are in.
    //
    // DEV-377: it said "pull back to climb" with the invert ON, which is the
    // shipped default's gesture and the opposite of what the switch does — with
    // it on, pulling back DIVES (`applyPitchInvert`, and `xr-input.test.ts`'s
    // "push forward to dive" for off). Read off `pitchWords` now, the same
    // words a lesson prompt's `{pitchUp}` resolves to, so the two cannot
    // disagree about which way is up.
    note: `${pitchWords(s, deviceOf(ctx)).up} to climb`,
    value: onOff(s.invertPitch),
  },
  // DEV-637: the rumble switch, on the devices that have a motor. The note says
  // what it does on THAT device, because "haptics" alone is a word a pad player
  // has to translate and a headset player has to guess at.
  ...(ctx.xr || deviceOf(ctx) === 'pad'
    ? [
        {
          id: 'haptics' as const,
          label: 'Haptics',
          note: ctx.xr
            ? 'the controllers pulse on gates, hits and boost'
            : 'the pad rumbles on gates, hits and boost',
          value: onOff(s.haptics),
        },
      ]
    : []),
  {
    id: 'fly',
    label: 'Fly',
    // The note is the same on the three stick devices because the GESTURE is
    // the same on all three — that is what `touch.ts` copying the pad's
    // arithmetic rather than re-deriving it buys. The keyboard's is two pairs
    // of keys.
    note: by(ctx, {
      xr: 'up-down pitches, left-right yaws',
      touch: 'up-down pitches, left-right yaws',
      keyboard: 'W/S pitch (the arrows too), Q/E yaw',
      pad: 'up-down pitches, left-right yaws',
    }),
    value: by(ctx, {
      xr: 'left stick',
      touch: 'left thumb',
      keyboard: KEYBOARD_WORDS.fly,
      pad: 'left stick',
    }),
  },
  {
    id: 'roll',
    label: 'Roll',
    note: by(ctx, {
      xr: 'the aileron, and only left and right',
      touch: 'the aileron, on the right thumb',
      keyboard: 'the aileron; the side arrows too',
      pad: 'the aileron, and only left and right',
    }),
    value: by(ctx, {
      xr: 'right stick',
      touch: 'right thumb',
      keyboard: KEYBOARD_WORDS.roll,
      pad: 'right stick',
    }),
  },
  {
    id: 'throttle',
    label: 'Throttle',
    // On a phone it is the one axis that is NOT the pad's: scheme "a" leaves the
    // right stick's vertical unused, and a finger is not a trigger.
    note: by(ctx, {
      xr: 'hold the right hand trigger',
      touch: 'push the right thumb forward',
      keyboard: 'hold Space, or Shift',
      pad: 'hold the right trigger',
    }),
    value: by(ctx, {
      xr: 'right trigger',
      touch: 'right thumb, up',
      keyboard: KEYBOARD_WORDS.throttle,
      pad: 'R2',
    }),
  },
  {
    id: 'boost',
    label: 'Boost',
    // The row this page exists for. 2016's own binding, and the note says the
    // thing that is not obvious: it does nothing without the throttle.
    note: by(ctx, {
      xr: 'left hand trigger, with throttle',
      touch: 'top right; hold it WITH the throttle',
      keyboard: 'hold it WITH the throttle; Ctrl too',
      pad: 'hold it WITH the throttle',
    }),
    value: by(ctx, {
      xr: 'left trigger',
      touch: 'BOOST',
      keyboard: KEYBOARD_WORDS.boost,
      pad: 'L2',
    }),
  },
  {
    id: 'slow',
    label: 'Slow down',
    // One chip, because `flight.ts:567` ORs the brake and the airbrake and the
    // JumpSeat reads neither — two buttons for one effect, on a screen the size
    // of a hand. DEV-104.
    note: by(ctx, {
      xr: 'left grip; B brakes too',
      touch: 'top left; brake and airbrake at once',
      keyboard: 'airbrake; X brakes as well',
      pad: 'airbrake; B brakes as well',
    }),
    value: by(ctx, {
      xr: 'left grip',
      touch: 'BRAKE',
      keyboard: KEYBOARD_WORDS.slow,
      pad: 'L1',
    }),
  },
  {
    id: 'look',
    label: 'Look',
    note: by(ctx, {
      xr: 'the right stick turns the seat',
      touch: 'drag anywhere, in the hangar',
      // DEV-563: Esc still lets go of the pointer, and in flight that now
      // opens this menu as well.
      keyboard: 'click to capture; Esc frees it and pauses',
      pad: 'click to capture; Esc frees it and pauses',
    }),
    value: by(ctx, { xr: 'your head', touch: 'drag', keyboard: 'mouse', pad: 'mouse' }),
  },
  ...(ctx.xr
    ? // In a headset the camera IS the head, and a third person is a rig placed
      // where the body is not — a comfort feature of its own, refused in
      // session (DEV-128). A row naming a control that does nothing there would
      // be the broken-menu read `comfort-menu.ts` argues against.
      []
    : [
        {
          id: 'view' as const,
          label: 'Change view',
          // 2016's own binding: `Input_Ship.cs:312` on InControl's Action3, the
          // X button, labelled CHANGE VIEW on the hangar's controls poster.
          note: ctx.touch ? 'cockpit or chase camera' : 'cockpit or chase; 2016 put it on X',
          value: by(ctx, { xr: 'X / V', touch: 'CAM', keyboard: 'V', pad: 'X / V' }),
        },
      ]),
  ...(ctx.touch || ctx.xr
    ? // On a phone and in a HEADSET, and both for the same reason: `P` needs a
      // keyboard and `?autopilot=1` is a development switch, so on either
      // device the binding named here is the ONLY route to the autopilot. A
      // control whose one home is a chip in the corner of the sky — or a
      // button you have to already know about, with the headset on — needs a
      // line in the one document that lists the controls.
      //
      // The headset's is a HOLD, and the row says the duration because a
      // gesture with no feedback and no stated length reads as a broken
      // button (DEV-181).
      [
        {
          id: 'autopilot' as const,
          label: 'Autopilot',
          note: 'flies the course; grab a stick to take it back',
          // DEV-597: it said `hold X, 2 s` since DEV-181 moved the chord to
          // both grips (`input/xr.ts`, `hold-toggle.test.ts`). Holding X opens
          // the pause plate, which is what a player who read the row got.
          value: ctx.xr ? `both grips, ${HOLD_TOGGLE_SECONDS} s` : 'AUTO',
        },
      ]
    : []),
  // DEV-598: P, H, R and G were bound and named nowhere a keyboard player could
  // read them (the 2026-10-03 persona playtest). ONE row, not four: the plate
  // is a fixed height (`pause.ts`'s `ROWS_MAX_M`), so every row added shrinks
  // every row's words, and they are small already. Pause is in Look's note.
  ...(deviceOf(ctx) === 'keyboard'
    ? [
        {
          id: 'keys' as const,
          label: 'More keys',
          note: `${KEYBOARD_WORDS.autopilot} autopilot, ${KEYBOARD_WORDS.enterVr} headset`,
          value: [KEYBOARD_WORDS.autopilot, KEYBOARD_WORDS.enterVr].join(' '),
        },
        // DEV-835 (Matt, 2026-10-08): the four keys were one line. Two rows of
        // two read as a list and each note fits the plate at its own size.
        {
          id: 'keys2' as const,
          label: 'Lap keys',
          note: `${KEYBOARD_WORDS.raceLap} race a lap, ${KEYBOARD_WORDS.shareLap} share it`,
          value: [KEYBOARD_WORDS.raceLap, KEYBOARD_WORDS.shareLap].join(' '),
        },
      ]
    : []),
  { id: 'back', label: 'Back', note: 'to the options' },
]

// ── DEV-377: a lesson prompt in the device's own words ────────────────────
//
// `docs/plan/FLIGHT-INSTRUCTOR.md` §5.1: `{throttle}` becomes `right trigger`
// in a headset, `R2` on a pad, `right thumb, up` on a phone and `Space` on a
// keyboard — READ OFF THE ROWS ABOVE, so the plate and this page cannot
// disagree. `{launch}` is the one control with no row: its words are the launch
// banner's (2016's "Press A to launch", `level.ui.strings.launchPrompt`), the
// touch overlay's confirm chip (`CONFIRM_LABEL.launch`) and the keyboard's
// confirm key (`input/keyboard.ts`'s `CONFIRM_KEYS`).

/** A control token a prompt may carry: one of `LESSON_CONTROL_TOKENS`. */
export type LessonControlToken = (typeof LESSON_CONTROL_TOKENS)[number]

/** The row each row-backed token reads its word off. */
const TOKEN_ROWS = {
  throttle: 'throttle',
  boost: 'boost',
  slow: 'slow',
  fly: 'fly',
  roll: 'roll',
} as const satisfies Partial<Record<LessonControlToken, ControlsRowId>>

/**
 * What a phone taps to launch, since DEV-607 took the LAUNCH chip away: the
 * screen itself (a tap on the glass, on the pad, is the launch).
 */
export const TOUCH_LAUNCH_WORD = 'the screen'

/**
 * The phone's one line on the launch pad (DEV-890): where the thumbs go. The
 * dash says what to tap to launch; nothing said how to fly. Worded off the
 * same rows as the controls page (throttle is `right thumb, up`, fly is
 * `left thumb`), and a unit test holds the two together.
 */
export const TOUCH_PAD_HINT = 'Right thumb up to go. Left thumb steers.'

/** `{launch}`'s word per device. See the section header for each source. */
export const launchWord = (device: ControlsDevice): string =>
  by(contextFor(device), {
    xr: 'A',
    pad: 'A',
    touch: TOUCH_LAUNCH_WORD,
    keyboard: KEYBOARD_WORDS.launch,
  })

// ── DEV-396: the two confirm prompts, in the device's own words ────────────
//
// The dash plate on the pad said `Press A to launch` and the pause plate's
// footer `PRESS A TO CHOOSE` to a keyboard player, on whose keyboard A BANKS
// LEFT (`input/keyboard.ts`'s `bankLeft`) and the confirm is Enter. The results
// panel already names both routes and DEV-291's footer already says `tap` on a
// phone; these are the two prompts that did not. Both read `launchWord` above,
// which is the confirm button per device, so the plate, the footer, a lesson's
// `{launch}` and this page cannot name four different keys.

/** A standalone capital `A`: the button word in 2016's `launchPrompt`. */
const BUTTON_A = /\bA\b/

/**
 * 2016's launch prompt worded for `device`. `prompt` is the level's own string
 * (`level.ui.strings.launchPrompt`, "Press A to launch" in all thirteen), so the
 * CONTENT is not edited: a pad and a headset get it byte for byte, since A is
 * the confirm on both, and the other two get the one word swapped for their
 * own confirm. A prompt that names no A button is returned as it came.
 */
export const launchPromptFor = (prompt: string, device: ControlsDevice): string => {
  if (device === 'pad' || device === 'xr' || !BUTTON_A.test(prompt)) return prompt
  const worded = prompt.replace(BUTTON_A, launchWord(device))
  // A chip is tapped, not pressed: DEV-291's footer says `tap` for this reason.
  return device === 'touch' ? worded.replace(/^Press\b/, 'Tap') : worded
}

/**
 * The pause plate's footer (and the title menu's, which is the same plate):
 * what to press to take the row you are looking at. A phone keeps DEV-291's
 * `tap an option`, since its chip there says SELECT and the row is tapped.
 */
export const chooseWords = (device: ControlsDevice): string =>
  device === 'touch' ? 'tap an option' : `press ${launchWord(device)} to choose`

/** One control token, in `device`'s words, with the invert applied. */
export const controlWord = (
  token: LessonControlToken,
  s: ComfortSettings,
  device: ControlsDevice,
): string => {
  if (token === 'launch') return launchWord(device)
  if (token === 'pitchUp') return pitchWords(s, device).up
  if (token === 'pitchDown') return pitchWords(s, device).down
  const id = TOKEN_ROWS[token]
  const row = controlsRows(s, contextFor(device)).find((r) => r.id === id)
  if (!row?.value) throw new Error(`controls: the ${id} row has no value to name {${token}} with`)
  return row.value
}

/** The live values a prompt may carry. */
export interface LessonValues {
  /** 1-based: the ring the player is making for. */
  readonly nextRing: number
  /**
   * The airspeed AS THE DASH PRINTS IT — `render/hud.ts`'s `formatSpeed` in the
   * preset's unit, `271 km/h` on Anniversary and a bare `75` on Classic — so
   * the plate and the readout under it never show two numbers for one speed.
   */
  readonly speed: string
  /**
   * The speed the prompt's own `until` asks for, printed as `speed` is
   * (DEV-378: `lessonSpeedTarget`, in the preset's unit), or null for a prompt
   * whose `until` asks for none — which `validateLevel` refuses to pair with a
   * `{target}`, so null here leaves the braces showing.
   */
  readonly target: string | null
}

/** Is `name` a control token? `LESSON_CONTROL_TOKENS`, which is type-only here. */
const isControlToken = (name: string): name is LessonControlToken =>
  Object.hasOwn(TOKEN_ROWS, name) || name === 'launch' || name === 'pitchUp' || name === 'pitchDown'

/**
 * A prompt, every `{token}` replaced: control tokens by the device's words,
 * `{nextRing}`, `{speed}` and `{target}` by the values. A token that opens a sentence
 * takes a capital, so "{pitchUp} to climb" reads "Left stick back to climb".
 *
 * An unknown token is left as it is. It cannot reach here from a level —
 * `validateLevel` refuses one at load (DEV-375) — and a plate that shows the
 * braces is a louder failure than one that quietly drops a word.
 */
export const resolveLessonText = (
  text: string,
  s: ComfortSettings,
  device: ControlsDevice,
  values: LessonValues,
): string =>
  text.replace(/\{([A-Za-z]+)\}/g, (whole: string, name: string, at: number) => {
    const word =
      name === 'nextRing'
        ? String(values.nextRing)
        : name === 'speed'
          ? values.speed
          : name === 'target'
            ? (values.target ?? whole)
            : isControlToken(name)
              ? controlWord(name, s, device)
              : whole
    const opensSentence = at === 0 || /[.!?:]\s+$/.test(text.slice(0, at))
    return opensSentence ? word.charAt(0).toUpperCase() + word.slice(1) : word
  })

export interface ControlsActivation {
  readonly settings: ComfortSettings
  readonly action: ControlsAction
  /** True when `settings` differs from what went in. */
  readonly changed: boolean
}

/**
 * Press A on row `index`. Pure, like `activateComfortRow`: the caller decides
 * when a write happens.
 *
 * An out-of-range index is a no-op rather than a throw — `app.ts` can be looking
 * at nothing (`selected === -1`).
 *
 * ── Why the id comes off `controlsRows` and not off `CONTROLS_ROW_IDS` ────
 *
 * Because the page is no longer a fixed list: a touchscreen gets an extra row,
 * so 'back' is the eighth row on a pad and the ninth on a phone. Reading the id
 * out of a parallel constant would mean a press on AUTOPILOT leaving the page,
 * which is precisely the "what you look at and what you hit drift apart" bug
 * this file's header says one plate exists to prevent — and the constant would
 * have kept quiet about it, because `CONTROLS_ROW_IDS[7]` is a perfectly valid
 * id for the wrong row.
 *
 * So: one list, three consumers — the same discipline `pause.ts`'s `pausePage`
 * already runs on. `ctx` has to match what was DRAWN, which is why the little
 * state machine below holds it rather than the caller passing it twice.
 */
export const activateControlsRow = (
  settings: ComfortSettings,
  index: number,
  ctx: ControlsContext = FLAT,
): ControlsActivation => {
  const id = controlsRows(settings, ctx)[index]?.id
  const still = { settings, action: 'none' as ControlsAction, changed: false }
  if (id === 'invert') {
    return {
      settings: { ...settings, invertPitch: !settings.invertPitch },
      action: 'none',
      changed: true,
    }
  }
  if (id === 'haptics') {
    return {
      settings: { ...settings, haptics: !settings.haptics },
      action: 'none',
      changed: true,
    }
  }
  if (id === 'back') return { ...still, action: 'back' }
  // Every other row is a label. See the header.
  return still
}

// ── The little state machine `app.ts` holds, mirroring ComfortMenu ────────

/** The state machine is `createSettingsPage`'s; these three set the context its rows read. */
export interface ControlsMenu extends SettingsPage<ControlsAction> {
  /** Tell the page which hardware to name. Called every frame; cheap. */
  setXr(xr: boolean): void
  /**
   * Tell the page it is being read on a phone. Set once, at boot — a device
   * does not grow a touchscreen mid-session.
   */
  setTouch(touch: boolean): void
  /**
   * Tell the page the keyboard was the last device that produced input, so it
   * names keys (DEV-377). Called every frame, beside `setXr`.
   */
  setKeyboard(keyboard: boolean): void
}

export interface ControlsMenuOptions {
  readonly settings: ComfortSettings
  /**
   * Called on every change. The input readers take `invertPitch` per frame, so
   * in practice this is where `app.ts` updates its one copy of the settings —
   * the same single-notification discipline `ComfortMenu` has.
   */
  readonly onChange: (settings: ComfortSettings) => void
  /** Injectable so the tests can watch the write, and hand in a store that throws. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}

export const createControlsMenu = (options: ControlsMenuOptions): ControlsMenu => {
  let xr = false
  let touch = false
  let keyboard = false

  return createSettingsPage(
    options,
    {
      title: CONTROLS_TITLE,
      rows: (settings) => controlsRows(settings, { xr, touch, keyboard }),
      // The SAME context the rows were drawn with. See `activateControlsRow`.
      activate: (settings, index) => activateControlsRow(settings, index, { xr, touch, keyboard }),
    },
    () => ({
      setXr(next: boolean) {
        xr = next
      },
      setTouch(next: boolean) {
        touch = next
      },
      setKeyboard(next: boolean) {
        keyboard = next
      },
    }),
  )
}
