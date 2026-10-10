// src/input/touch-overlay.ts — the controls a thumb actually lands on.
//
// `touch.ts` is the mapping and this is the glass: the elements, the pointer
// events that move them, and the one place that decides what a given touch
// MEANS. Draw and hit are the same object here on purpose — `controls-menu.ts`
// makes the same argument about the pause plate, and the bug it is guarding
// against ("what you look at and what you hit drift apart") is the one that
// cannot happen if the ring you see is the element you pressed.
//
// ── Why DOM and not three.js, when `hud.ts` argues the opposite ──────────
//
// Because `hud.ts`'s argument is about a HEADSET: a DOM overlay is invisible in
// an immersive session, `dom-overlay` is not reliably granted on Quest, and a
// HUD the headset cannot show is not a HUD. Every word of that is true and none
// of it applies here. These controls exist only on a flat phone screen, they
// are hidden the instant a session starts, and the thing they most need to be
// is crisp at a phone's device-pixel-ratio and reachable by a real finger —
// which is CSS's job, and which a canvas texture on a quad would do worse at
// three times the code.
//
// ── The layout, and why the buttons are at the TOP ───────────────────────
//
//     [BRAKE]        [AUTO] [☰ MENU] [CAM]        [BOOST]
//
//              (left stick)              (right stick)
//                      [ RACE THIS LAP ]     (the results panel only)
//                        [  LAUNCH  ]
//
// A phone in landscape puts both thumbs in the lower corners, so the lower half
// belongs entirely to the two floating sticks — a stick appears wherever the
// thumb lands in its half, so the control finds the thumb instead of the thumb
// hunting for the control. That leaves the index fingers, which come over the
// top edge, which is where BOOST and BRAKE are. It is also where they belong on
// the pad: 2016's boost is the LEFT TRIGGER (`Input_Ship.cs:426`) and the
// airbrake is L1 — both shoulders, in the same place, on both devices.
//
// ── The top row is a FLEX ROW, and that is a bug fix (DEV-290) ───────────
//
// It used to be five absolutely-positioned buttons: two pinned to the corners
// and three hung off `left: 50%` with hand-written `translateX` offsets. Five
// independent positions cannot know they have collided, and at a phone's
// PORTRAIT width — 412 css px, which is a Pixel held the ordinary way round —
// they had: `BOOST` overlapped `CAM` and its own label was clipped to `OOST`.
// Landscape hid it, and landscape is the only width this file had ever been
// looked at in, so the overlay was laid out against the one aspect ratio a
// player does NOT get by default when they open a link on a phone.
//
// A flex row cannot produce that state: the browser does the arithmetic, the
// corners stay in the corners, and the centre group shrinks between them. The
// narrow-width rules below then buy back the room the labels need.
//
// ── ☰, because nobody could find `❚❚` (DEV-290) ─────────────────────────
//
// Matt, on a phone, having played it: *"i don't know how you're opening the
// pause menu - can you add a 'hamburger button' to the ui"*. The control was
// there the whole time — an unlabelled 52 px `❚❚` glyph, wedged between `AUTO`
// and `CAM`, drawn exactly like the two readouts either side of it. So the one
// button on the screen that opens EVERY setting the game has looked like a
// status light, and the only person who could find it was the person who put
// it there.
//
// It is `☰ MENU` now: the word, and the glyph every phone on earth uses for
// it. `data-act` stays `pause` — the ACTION is still the pause toggle, and the
// specs, the latch table and `app.ts`'s `touch.pause` all name it — so what
// changed is what a thumb sees, which is the half that was broken. While the
// plate is up it says `✕`, because a hamburger that opens and does not visibly
// close is the same discoverability bug one screen further in.
//
// ── The one-shot latch ───────────────────────────────────────────────────
//
// `confirm`, `pause` and `toggleAutopilot` are edge-detected by `app.ts`
// against the previous frame's value, exactly as the keyboard's are. A finger
// is faster than a key: a tap can land and lift between two animation frames,
// and the press would then never be seen at all. So a tap LATCHES, and `read()`
// is the frame boundary that clears it — call `read()` once per frame, before
// the getters, which is the order `app.ts` already reads the keyboard in.
//
// ── Tapping a ROW, which is a ray and not a hit test here (DEV-291) ──────
//
// Matt: *"mobile menu should work w/ tap"*. It did not: the pause plate is a
// canvas texture on a quad IN THE WORLD, so there is no element under the
// finger to press and no amount of DOM can put one there. What `app.ts` has
// instead is `flight.pause.pick(origin, direction, rows)` — the ray the NOSE
// POINTER already uses, and the same one a headset aims with its head.
//
// So this file does not decide which row was tapped, and must not: it reports
// WHERE the glass was touched and nothing else. `app.ts` turns that point into
// a ray through the camera and hands it to the picker the plate already owns.
// One picker, three aimers (head, nose, finger) — which is the property that
// makes "what you look at and what you hit" impossible to drift apart, the
// same argument the top of this file makes about the buttons.
//
// A TAP, not a press: the point is reported on pointer-UP, and only if the
// finger stayed inside `MENU_TAP_SLOP_PX` of where it landed. A drag across a
// plate is somebody scrolling a list that does not scroll, and delivering that
// as a press on whatever row it happened to end over is how a menu selects
// EXIT by itself.

import {
  UI_ACCENT,
  UI_INK,
  UI_ON_ACCENT,
  UI_PLATE,
  UI_PLATE_EDGE,
  UI_STACK,
} from '@/render/ui-tokens'
import type { FlightActions } from './actions'
import { noActions } from './actions'
import { type LookDelta, type LookOptions, NO_LOOK } from './look'
import {
  CENTRED,
  NO_TOUCH_BUTTONS,
  STICK_RADIUS_PX,
  type StickVector,
  stickVector,
  type TouchOptions,
  type TouchZone,
  touchActions,
  touchLook,
  zoneFor,
} from './touch'

/** What the controls should be showing right now. Set once a frame by `app.ts`. */
export interface TouchContext {
  /** There is a ship: show two sticks, the shoulders, AUTO and pause. */
  readonly flying: boolean
  /**
   * There is nothing to fly, so a drag LOOKS instead of deflecting a stick.
   *
   * True in the level select, where the whole screen is the look surface —
   * the room is aimed by eye and a holotable is chosen by pointing the nose at
   * it, so a phone with no look control could not pick a course at all. Same
   * argument `look.ts` makes about the keyboard, one device along.
   */
  readonly lookMode: boolean
  /**
   * A plate is up and its rows are TAPPED, not flown (DEV-291).
   *
   * True while the pause menu is open. It is not `paused` under another name,
   * even though that is what `app.ts` passes today — what it means here is
   * *"the whole glass is a picker"*, and everything that follows from that is
   * about the picker: the sticks and the shoulders go away (a frozen ship has
   * nothing to do with them), the hamburger becomes a close button, and a tap
   * on the bare surface is reported through `readMenuTap` instead of moving a
   * stick that would command a ship nobody is flying.
   *
   * It outranks `flying`, which stays true underneath it — the pause plate
   * only exists on the mission screen, so the two are on together and the
   * reader has to say which wins.
   */
  readonly menu: boolean
  /**
   * The bare glass reports TAPS, and nothing else changes (DEV-353).
   *
   * The title screen's two rows — the hangar and Quick Race — are picked the
   * way the pause plate's are, by a ray through the finger (DEV-291). But the
   * title is not a plate over a frozen ship: its START chip stays, because on a
   * phone it is the press that has always started the game, and it still does
   * (it takes the highlighted row, which opens on the hangar). So this is the
   * picker half of `menu` without the half that hides the controls.
   * Optional, so every context that says nothing about it taps nothing.
   */
  readonly taps?: boolean
  /** The big button's word — 'LAUNCH', 'SELECT', 'START' — or null to hide it. */
  readonly confirmLabel: string | null
  /**
   * The results panel's "race this lap" chip: its word, or null (or absent)
   * to hide it. DEV-371 follow-up.
   *
   * Matt, 2026-09-25: *"a touch route to 'race this lap'"*. The panel offers
   * it by R, a pad's Y and the right stick's click in a headset, and a phone
   * had none of the three: it could fly again against its best (the AGAIN
   * chip) and never race the lap it had just flown. `app.ts` passes a word
   * exactly when its race handler would act — the run left a lap, the panel is
   * up, nothing is paused — and the word names what the press will do there.
   * Optional, so every context that says nothing about it offers nothing.
   */
  readonly raceLabel?: string | null
  /**
   * DEV-406 follow-up: the results panel's FLY AGAIN chip, its word, or null
   * (or absent) to hide it. Matt, 2026-09-26: *"maybe it should be 2 buttons
   * after the race is over - ("continue. fly again.")"*. The confirm chip is
   * CONTINUE there (it goes to the hangar), and a phone had no labelled way to
   * fly again: that was the unlabelled pause chip. `app.ts` passes a word
   * exactly while the panel is up and nothing is paused.
   */
  readonly againLabel?: string | null
  /**
   * One line of how to fly, shown over the glass while the ship waits on the
   * pad (DEV-890), or null (or absent) to hide it. The pad prompt on the dash
   * says what to PRESS; on a phone nothing said where the thumbs go, and the
   * agent playtest sat on the pad looking for a button. Never over a plate.
   */
  readonly padHint?: string | null
  /** The autopilot is engaged; the AUTO chip lights. */
  readonly autopilot: boolean
  /**
   * The AUTO chip is offered at all (DEV-435): false in a mode the autopilot
   * cannot fly, Free Flight. Absent is offered.
   */
  readonly autopilotOffered?: boolean
  /** The chase camera is live; the CAM chip lights. A readout, like AUTO. DEV-128. */
  readonly thirdPerson: boolean
  /**
   * The TILT chip is offered at all (DEV-292).
   *
   * **It is NOT "this device has a gyroscope", and the name is the strongest
   * thing that can honestly be said.** There is no way to ask a browser
   * whether the sensors exist without attaching a listener and waiting to see
   * whether a reading arrives, so what `app.ts` actually passes is
   * `deviceLook.supported` — *the platform exposes the event*, which is true
   * of every browser including a desktop one. On a machine with a touchscreen
   * and no gyroscope the chip is therefore drawn, and a tap on it does
   * nothing visible.
   *
   * That is a real limit and it is written here rather than hidden behind a
   * confident name, because a comment claiming a capability nothing checks is
   * precisely the `hoverjet.input.controlScheme` mistake: a sheet said
   * `"a"` with `trust: verified` for four sessions while the shipped layout
   * was something else, and it was found by Matt holding a pad.
   *
   * What keeps the failure honest is `tilt` below, which is `active` — the
   * chip lights on the first READING and not on the tap. A device with no
   * sensors gives a chip that never lights, which is the truth, rather than a
   * lit chip over a view that does not move.
   */
  readonly tiltAvailable: boolean
  /** The phone is driving the view; the TILT chip lights. A readout, like AUTO. */
  readonly tilt: boolean
  /** An immersive session is running. Nothing here belongs in a headset. */
  readonly hidden: boolean
}

export const IDLE_CONTEXT: TouchContext = {
  flying: false,
  lookMode: false,
  menu: false,
  confirmLabel: null,
  autopilot: false,
  thirdPerson: false,
  tiltAvailable: false,
  tilt: false,
  hidden: false,
}

/** A tap on the glass, in CSS pixels from the top-left of the viewport. */
export interface MenuTap {
  readonly x: number
  readonly y: number
}

/**
 * How far a finger may travel and still count as a tap, in CSS pixels.
 *
 * The same order as `STICK_DEAD_PX`, and for the same reason it exists at all:
 * a finger rolls two or three pixels between landing and lifting. Bigger,
 * because this one is not fighting a control's slop but a deliberate drag —
 * anything past it is somebody trying to scroll a list, and must not select.
 */
export const MENU_TAP_SLOP_PX = 12

export interface TouchControls {
  /**
   * Advance a frame and read the sticks. **Call this once, first**: it is the
   * frame boundary that clears the tap latches the getters below report.
   */
  read(opts: TouchOptions): FlightActions
  /** The drag accumulated since the last call, in radians. Consuming, like the mouse's. */
  readLook(opts: LookOptions): LookDelta
  /**
   * Where the glass was tapped while a plate was up, in CSS pixels from the
   * top-left of the VIEWPORT — or null (DEV-291).
   *
   * Consuming, like `readLook` and for the same reason: a tap is an event, and
   * a reader that peeked without clearing would re-pick the same row every
   * frame until the next one arrived, which on a plate means holding EXIT down.
   *
   * Viewport coordinates and not NDC, because this file has no camera and no
   * canvas rect to divide by — turning a point into a ray is the caller's job
   * and doing a third of it here would put half a transform in each file.
   */
  readMenuTap(): MenuTap | null
  /**
   * What to run when the TILT chip is released — inside the gesture (DEV-292).
   *
   * A callback and not a `toggleTilt` latch beside `toggleAutopilot`, which is
   * the shape every other chip here uses, because iOS will only hand over the
   * orientation sensors to a call whose stack goes back to a user gesture. A
   * latch read from the frame loop is one animation frame too late, for ever.
   */
  onGyroTap(fn: () => void): void
  /** The big confirm button is down. `app.ts` edge-detects. */
  readonly confirm: boolean
  /** The pause chip is down. `app.ts` edge-detects — it is a TOGGLE. */
  readonly pause: boolean
  /** The AUTO chip is down. `app.ts` edge-detects. */
  readonly toggleAutopilot: boolean
  /** The CAM chip is down — CHANGE VIEW. `app.ts` edge-detects. DEV-128. */
  readonly toggleCamera: boolean
  /** The RACE THIS LAP chip is down. `app.ts` edge-detects. DEV-371 follow-up. */
  readonly raceLap: boolean
  /** The FLY AGAIN chip is down. `app.ts` edge-detects. DEV-406 follow-up. */
  readonly again: boolean
  /** Whether there is anything here at all. False on a desktop, and in a host with no DOM. */
  readonly available: boolean
  /**
   * Show or hide the whole thing.
   *
   * The CURTAIN, and separate from `TouchContext.hidden` on purpose. It went
   * up when the landing card was dismissed, because controls drawn over the
   * card's Start button were controls for a game the visitor had not started.
   * DEV-557 took the card away, so `main.ts` raises it at boot. `app.ts` owns
   * the other switch, per frame, for the session it can see.
   */
  setVisible(visible: boolean): void
  setContext(ctx: TouchContext): void
  dispose(): void
}

/** What a host with no touchscreen gets: the same interface, doing nothing. */
export const noTouchControls = (): TouchControls => ({
  read: () => noActions(),
  readLook: () => NO_LOOK,
  readMenuTap: () => null,
  onGyroTap: () => {},
  confirm: false,
  pause: false,
  toggleAutopilot: false,
  toggleCamera: false,
  raceLap: false,
  again: false,
  available: false,
  setVisible: () => {},
  setContext: () => {},
  dispose: () => {},
})

/**
 * The hamburger's two faces (DEV-290).
 *
 * Exported so `mobile-controls.spec.ts` asserts against the word the game
 * draws rather than against its own copy of it — the same rule `CONFIRM_LABEL`
 * is exported under, for the same reason: the check is about the button
 * CHANGING when the plate opens, not about two string literals.
 */
export const MENU_LABEL = '☰ MENU'
export const MENU_CLOSE_LABEL = '✕'

/**
 * The race chip's word (DEV-371 follow-up), exported for the reason the
 * hamburger's are: a spec reads the word the game draws. It had two more faces
 * (ANOTHER NAME while Share showed the handle, DEV-373; KEEP IT while it asked
 * to delete, DEV-374) until DEV-571 moved both onto the results panel's own
 * menu, where the race press is always "race this lap".
 */
export const RACE_LAP_LABEL = 'RACE THIS LAP'
/** DEV-406 follow-up: the results panel's other way on, beside CONTINUE. */
export const AGAIN_LABEL = 'FLY AGAIN'

/** Ids so a spec — and a person with devtools — can find these by name. */
export const TOUCH_ROOT_ID = 'touch-controls'
const STYLE_ID = 'touch-controls-style'

/** The action each button carries, in its `data-act`. Exported so a spec switches on a NAME. */
export const TOUCH_BUTTON_IDS = [
  'brake',
  'boost',
  'auto',
  'pause',
  'cam',
  'tilt',
  'confirm',
  'race',
  'again',
] as const
export type TouchButtonId = (typeof TOUCH_BUTTON_IDS)[number]

const CSS = `
#${TOUCH_ROOT_ID} {
  position: fixed;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  touch-action: none;
  overscroll-behavior: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  font: 700 14px/1 ${UI_STACK};
  font-synthesis: none;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: ${UI_INK};
}
#${TOUCH_ROOT_ID}[hidden] { display: none; }
#${TOUCH_ROOT_ID} .surface {
  position: absolute;
  inset: 0;
  pointer-events: auto;
  touch-action: none;
}
/* The top row: one flex line, so the corners and the centre cannot collide. */
#${TOUCH_ROOT_ID} .top {
  position: absolute;
  top: calc(10px + env(safe-area-inset-top, 0px));
  left: calc(12px + env(safe-area-inset-left, 0px));
  right: calc(12px + env(safe-area-inset-right, 0px));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  pointer-events: none;
}
/* AUTO, the hamburger and CAM travel together between the two shoulders. */
#${TOUCH_ROOT_ID} .top .centre {
  display: flex;
  align-items: center;
  gap: 8px;
}
#${TOUCH_ROOT_ID} button {
  position: relative;
  flex: 0 0 auto;
  margin: 0;
  pointer-events: auto;
  touch-action: none;
  font: inherit;
  color: inherit;
  background: ${UI_PLATE};
  border: 1px solid ${UI_PLATE_EDGE};
  border-bottom: 3px solid ${UI_ACCENT};
  border-radius: 0;
}
#${TOUCH_ROOT_ID} button[data-down="1"] {
  background: ${UI_ACCENT};
  border-color: ${UI_ACCENT};
  color: ${UI_ON_ACCENT};
}
#${TOUCH_ROOT_ID} button[hidden] { display: none; }
/* The pad hint (DEV-890): one line low on the glass, never a target. */
#${TOUCH_ROOT_ID} .pad-hint {
  position: absolute;
  left: 50%;
  bottom: calc(18px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  max-width: 86%;
  padding: 8px 14px;
  text-align: center;
  font-size: 14px;
  letter-spacing: 0.04em;
  color: ${UI_INK};
  background: ${UI_PLATE};
  border: 1px solid ${UI_PLATE_EDGE};
  border-bottom: 3px solid ${UI_ACCENT};
  pointer-events: none;
}
#${TOUCH_ROOT_ID} .pad-hint[hidden] { display: none; }
/* The shoulders: index fingers, over the top edge. Wide targets, thin chrome. */
#${TOUCH_ROOT_ID} .shoulder {
  width: 108px;
  height: 46px;
  border-radius: 0;
}
/* AUTO and CAM: tapped rarely, so inboard and small. */
#${TOUCH_ROOT_ID} .chip {
  height: 46px;
  padding: 0 16px;
}
#${TOUCH_ROOT_ID} [data-act="auto"][data-on="1"],
#${TOUCH_ROOT_ID} [data-act="tilt"][data-on="1"],
#${TOUCH_ROOT_ID} [data-act="cam"][data-on="1"] {
  background: ${UI_ACCENT};
  border-color: ${UI_ACCENT};
  color: ${UI_ON_ACCENT};
}
/* ── The hamburger (DEV-290) ──────────────────────────────────────────────
   AMBER, and darker than the chips either side, because it is the only thing
   on this row that OPENS something and the old one was mistaken for a status
   light. The colour is the pause plate's own ACCENT (render/pause.ts) — the
   button that opens the amber plate is amber, and the accent now carries every lit
   control on this screen (DEV-647).

   It was a pale translucent fill for one iteration and that was worse than the
   glyph it replaced: light-on-light, so against a bright cloud it washed out
   to nothing at exactly the moment a player looks up. A dark base with a bright
   edge reads on sky and on rock alike, which is the property that matters for
   a button drawn over a game rather than over a page.

   Its left padding is tighter than the plain chip's, to keep the glyph and the
   word reading as one label rather than two.
   (No backticks anywhere in this block: the whole stylesheet is a TEMPLATE
   LITERAL, so one in a comment ends the string and the file stops parsing.) */
#${TOUCH_ROOT_ID} [data-act="pause"] {
  padding: 0 16px 0 13px;
  letter-spacing: 0.06em;
  background: ${UI_PLATE};
  border-color: ${UI_ACCENT};
  color: ${UI_ACCENT};
}
/* ── Narrow glass: a phone held PORTRAIT is 412 css px (DEV-290) ──────────
   The flex row already refuses to overlap; this is the room the five labels
   need in order to fit inside it without wrapping. 560 px is the width below
   which the full-size row stops clearing its own gaps, derived by shrinking
   the viewport until it does — it is not a device breakpoint and no device
   is named here. */
@media (max-width: 560px) {
  #${TOUCH_ROOT_ID} button { font-size: 11px; letter-spacing: 0.03em; }
  #${TOUCH_ROOT_ID} .shoulder { width: 74px; }
  #${TOUCH_ROOT_ID} .chip { padding: 0 9px; }
  #${TOUCH_ROOT_ID} [data-act="pause"] { padding: 0 9px 0 7px; }
  #${TOUCH_ROOT_ID} .top, #${TOUCH_ROOT_ID} .top .centre { gap: 5px; }
}
/* ── Narrower still: the mode chips take their own line ───────────────────
   Six controls do not fit across 360 css px and no amount of padding makes
   them. Shrinking the LABELS back towards glyphs was the other option and it
   is the bug this pair of numbers is fixing, one size down — so instead the
   row wraps: the two shoulders keep the corners where an index finger expects
   them, and AUTO / MENU / CAM / TILT ride a centred line underneath.

   The threshold is 480 rather than the 412 that forced it, because a layout
   that only just fits is a layout one label away from not fitting, and the
   two-line form is the better portrait layout anyway. Measured, not guessed:
   the mobile-controls spec checks three widths for rectangle overlap, and it
   is what found the 360 case — by failing the first version of this fix.
   (Again, no backticks in here: this stylesheet is a template literal.) */
@media (max-width: 480px) {
  #${TOUCH_ROOT_ID} .top { flex-wrap: wrap; }
  #${TOUCH_ROOT_ID} .top .centre {
    order: 1;
    flex-basis: 100%;
    justify-content: center;
    margin-top: 6px;
  }
}
/* The one button a menu needs. Big, central, and only there when a press does something. */
#${TOUCH_ROOT_ID} [data-act="confirm"] {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(18px + env(safe-area-inset-bottom, 0px));
  min-width: 168px;
  height: 56px;
  padding: 0 28px;
  font-size: 15px;
  background: ${UI_ACCENT};
  border-color: ${UI_ACCENT};
  color: ${UI_ON_ACCENT};
}
#${TOUCH_ROOT_ID} [data-act="confirm"][data-down="1"] { background: ${UI_INK}; }
/* ── RACE THIS LAP (DEV-371 follow-up) ───────────────────────────────────
   The results panel's second press, stacked just ABOVE the big one and
   centred on it, so the pair reads the way the panel does: the primary, then
   race this lap. Dark with the confirm's blue edge rather than a second solid blue
   pill, because the confirm (HANGAR since DEV-406) is the primary and two equal buttons ask the thumb to
   read both before it presses either. The offset is the confirm's own bottom
   plus its height (56 px) plus a gap. (No backticks: template literal.) */
#${TOUCH_ROOT_ID} [data-act="race"] {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  /* Above FLY AGAIN since DEV-406's follow-up: its 46 px and a 12 px gap. */
  bottom: calc(18px + 56px + 12px + 46px + 12px + env(safe-area-inset-bottom, 0px));
  min-width: 168px;
  height: 46px;
  padding: 0 22px;
  font-size: 14px;
  background: ${UI_PLATE};
  border-color: ${UI_ACCENT};
  color: ${UI_INK};
}
/* ── FLY AGAIN (DEV-406 follow-up) ────────────────────────────────────────
   The results panel's other way on, stacked just ABOVE CONTINUE and centred
   on it. Beside it does not fit a portrait phone: at 375 px the centred
   CONTINUE starts at about 104 px. So the column reads, from the thumb up:
   CONTINUE, FLY AGAIN, then RACE THIS LAP when the run left a lap. Styled
   like RACE THIS LAP, a secondary. (No backticks: template literal.) */
#${TOUCH_ROOT_ID} [data-act="again"] {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(18px + 56px + 12px + env(safe-area-inset-bottom, 0px));
  min-width: 168px;
  height: 46px;
  padding: 0 22px;
  font-size: 14px;
  background: ${UI_PLATE};
  border-color: ${UI_ACCENT};
  color: ${UI_INK};
}
/* A stick is drawn only while a thumb is on it: an empty ring is furniture. */
#${TOUCH_ROOT_ID} .stick {
  position: absolute;
  left: 0;
  top: 0;
  width: ${STICK_RADIUS_PX * 2}px;
  height: ${STICK_RADIUS_PX * 2}px;
  margin: -${STICK_RADIUS_PX}px 0 0 -${STICK_RADIUS_PX}px;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, ${UI_INK} 28%, transparent);
  background: color-mix(in srgb, ${UI_PLATE} 28%, transparent);
}
#${TOUCH_ROOT_ID} .stick[hidden] { display: none; }
#${TOUCH_ROOT_ID} .knob {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 52px;
  height: 52px;
  margin: -26px 0 0 -26px;
  border-radius: 50%;
  background: color-mix(in srgb, ${UI_ACCENT} 50%, transparent);
  border: 1px solid color-mix(in srgb, ${UI_INK} 60%, transparent);
}
@media (prefers-reduced-motion: no-preference) {
  #${TOUCH_ROOT_ID} button { transition: background 90ms linear, border-color 90ms linear; }
}
`

/** One live finger, and what it was doing when it went down. */
interface LivePointer {
  readonly kind: 'stick' | 'look' | 'tap'
  readonly zone: TouchZone | null
  readonly originX: number
  readonly originY: number
  x: number
  y: number
}

export interface TouchControlsOptions {
  /**
   * Build the controls at all.
   *
   * `capability-gate.ts` decides this, and it is passed in rather than
   * re-detected so there is ONE answer to "is this a touch device" in the
   * build. A desktop gets `noTouchControls()` and no elements in its DOM.
   */
  readonly enabled: boolean
}

/**
 * Mount the touch controls over the canvas.
 *
 * Starts HIDDEN: `main.ts` calls `setVisible(true)` at boot (DEV-557). See
 * `TouchControls.setVisible`.
 */
export const attachTouchControls = (
  canvas: HTMLElement | null,
  options: TouchControlsOptions,
): TouchControls => {
  const doc = canvas?.ownerDocument ?? null
  if (!options.enabled || !doc?.body) return noTouchControls()

  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    doc.head.appendChild(style)
  }

  const root = doc.createElement('div')
  root.id = TOUCH_ROOT_ID
  root.hidden = true

  const surface = doc.createElement('div')
  surface.className = 'surface'
  root.appendChild(surface)

  const makeStick = (): HTMLDivElement => {
    const stick = doc.createElement('div')
    stick.className = 'stick'
    stick.hidden = true
    const knob = doc.createElement('div')
    knob.className = 'knob'
    stick.appendChild(knob)
    root.appendChild(stick)
    return stick
  }
  const sticks: Record<TouchZone, HTMLDivElement> = { left: makeStick(), right: makeStick() }

  /** Down right now, and the tap latch the header explains. */
  const blank = (): Record<TouchButtonId, boolean> =>
    Object.fromEntries(TOUCH_BUTTON_IDS.map((id) => [id, false])) as Record<TouchButtonId, boolean>
  // Built from the ID list rather than written out twice: the two tables and
  // the list were three copies of the same seven names, and DEV-292's `tilt`
  // had to be added to all three or the one that was missed would have been a
  // silent `undefined` where a boolean was expected.
  const down = blank()
  const latched = blank()

  // The top row, and the group that rides between the two shoulders. Appended
  // AFTER `surface` so the buttons sit over it; `pointer-events` is off on both
  // wrappers, so the gaps between the chips are still glass a thumb reaches
  // the surface through (DEV-290).
  const topRow = doc.createElement('div')
  topRow.className = 'top'
  const centreGroup = doc.createElement('div')
  centreGroup.className = 'centre'

  const buttons = {} as Record<TouchButtonId, HTMLButtonElement>
  const makeButton = (
    id: TouchButtonId,
    label: string,
    cls: string,
    parent: HTMLElement = root,
    /**
     * Run synchronously inside the pointer-UP handler, for a button whose job
     * needs a USER GESTURE and cannot wait for the frame loop to notice a
     * latch (DEV-292).
     *
     * There is exactly one: `TILT` asks
     * `DeviceOrientationEvent.requestPermission()`, which iOS rejects unless
     * the call stack goes back to a gesture — and a frame callback does not,
     * however recently the player tapped something. `pointerup` rather than
     * `pointerdown` because transient activation is granted on the release.
     */
    onRelease?: () => void,
  ): HTMLButtonElement => {
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = cls
    button.dataset.act = id
    button.textContent = label
    const press = (e: PointerEvent) => {
      down[id] = true
      latched[id] = true
      button.dataset.down = '1'
      try {
        button.setPointerCapture(e.pointerId)
      } catch {
        // A host without pointer capture still gets the up event on the
        // document; the release handlers below cover it.
      }
      // Stop the browser turning this into a scroll, a zoom, or a synthetic
      // click on the canvas underneath — and stop the surface reading it as a
      // thumb reaching for a stick.
      e.preventDefault()
      e.stopPropagation()
    }
    const release = (e: PointerEvent) => {
      down[id] = false
      delete button.dataset.down
      e.stopPropagation()
    }
    button.addEventListener('pointerdown', press as EventListener)
    button.addEventListener('pointerup', ((e: PointerEvent) => {
      release(e)
      // Only from a real release. `pointercancel` and `lostpointercapture`
      // below deliberately do NOT call this: the browser taking the pointer
      // away is not a gesture, and asking iOS for the sensors on one would
      // spend the prompt on a press the player did not finish making.
      onRelease?.()
    }) as EventListener)
    button.addEventListener('pointercancel', release as EventListener)
    button.addEventListener('lostpointercapture', release as EventListener)
    // A button inside a game canvas has no business scrolling the page.
    button.addEventListener('contextmenu', (e) => e.preventDefault())
    parent.appendChild(button)
    buttons[id] = button
    return button
  }

  // Left to right, which is also the order they are laid out in: the flex row
  // takes DOM order, so this list IS the row and there is no second place that
  // says where anything goes.
  makeButton('brake', 'BRAKE', 'shoulder', topRow)
  topRow.appendChild(centreGroup)
  makeButton('auto', 'AUTO', 'chip', centreGroup)
  makeButton('pause', MENU_LABEL, 'chip', centreGroup)
  makeButton('cam', 'CAM', 'chip', centreGroup)
  makeButton('tilt', 'TILT', 'chip', centreGroup, () => gyroTap?.())
  makeButton('boost', 'BOOST', 'shoulder', topRow)
  root.appendChild(topRow)
  makeButton('confirm', 'START', '')
  // Born hidden: it is offered only on the results panel, and a context that
  // says nothing about it (every other screen) must not show it for a frame.
  makeButton('race', RACE_LAP_LABEL, '').hidden = true
  makeButton('again', AGAIN_LABEL, '').hidden = true
  const padHint = doc.createElement('div')
  padHint.className = 'pad-hint'
  padHint.dataset.role = 'pad-hint'
  padHint.hidden = true
  root.appendChild(padHint)

  doc.body.appendChild(root)

  // ── state ───────────────────────────────────────────────────────────────

  const live = new Map<number, LivePointer>()
  let lookDx = 0
  let lookDy = 0
  /** The tap waiting to be picked, or null. Consumed by `readMenuTap` (DEV-291). */
  let menuTap: MenuTap | null = null
  /** `app.ts`'s gyro toggle, run inside the gesture. See `onGyroTap` (DEV-292). */
  let gyroTap: (() => void) | null = null
  let ctx: TouchContext = IDLE_CONTEXT
  let visible = false
  /** Cleared and refilled by `read()`. See the header's note on the latch. */
  let frame = {
    confirm: false,
    pause: false,
    auto: false,
    cam: false,
    race: false,
    again: false,
  }

  const showing = (): boolean => visible && !ctx.hidden

  const stickOf = (zone: TouchZone): StickVector => {
    for (const p of live.values()) {
      if (p.kind === 'stick' && p.zone === zone) {
        return stickVector(p.x - p.originX, p.y - p.originY)
      }
    }
    return CENTRED
  }

  const drawSticks = (): void => {
    for (const zone of ['left', 'right'] as const) {
      const element = sticks[zone]
      let found: LivePointer | null = null
      for (const p of live.values()) if (p.kind === 'stick' && p.zone === zone) found = p
      if (!found) {
        element.hidden = true
        continue
      }
      const v = stickVector(found.x - found.originX, found.y - found.originY)
      element.hidden = false
      element.style.transform = `translate(${found.originX}px, ${found.originY}px)`
      const knob = element.firstElementChild as HTMLElement | null
      if (knob) {
        knob.style.transform = `translate(${v.x * STICK_RADIUS_PX}px, ${v.y * STICK_RADIUS_PX}px)`
      }
    }
  }

  // ── the surface: sticks in a mission, a look drag in the menu ───────────

  const onDown = (event: Event) => {
    const e = event as PointerEvent
    if (!showing()) return
    // The plate outranks both branches below: while it is up the ship is
    // frozen, so a stick has nothing to command and a look has nothing to aim
    // — the glass is a picker and nothing else (DEV-291).
    // DEV-604: in the hangar (`lookMode`) a touch that asks for taps still
    // LOOKS; it is the look branch below that reports a still finger as a tap.
    if (ctx.menu || (ctx.taps && !ctx.lookMode)) {
      live.set(e.pointerId, {
        kind: 'tap',
        zone: null,
        originX: e.clientX,
        originY: e.clientY,
        x: e.clientX,
        y: e.clientY,
      })
    } else if (ctx.lookMode) {
      live.set(e.pointerId, {
        kind: 'look',
        zone: null,
        originX: e.clientX,
        originY: e.clientY,
        x: e.clientX,
        y: e.clientY,
      })
    } else if (ctx.flying) {
      const zone = zoneFor(e.clientX, surface.clientWidth || doc.documentElement.clientWidth)
      // One stick per half. A second finger in the same half must not move a
      // stick the first one is already holding — the ship would jump to
      // wherever the new finger landed, which reads as the controls letting go.
      for (const p of live.values()) if (p.kind === 'stick' && p.zone === zone) return
      live.set(e.pointerId, {
        kind: 'stick',
        zone,
        originX: e.clientX,
        originY: e.clientY,
        x: e.clientX,
        y: e.clientY,
      })
    } else {
      return
    }
    try {
      surface.setPointerCapture(e.pointerId)
    } catch {
      // Same as the buttons: capture is an optimisation, not a requirement.
    }
    e.preventDefault()
    drawSticks()
  }

  const onMove = (event: Event) => {
    const e = event as PointerEvent
    const p = live.get(e.pointerId)
    if (!p) return
    if (p.kind === 'look') {
      lookDx += e.clientX - p.x
      lookDy += e.clientY - p.y
    }
    p.x = e.clientX
    p.y = e.clientY
    e.preventDefault()
    drawSticks()
  }

  const onUp = (event: Event) => {
    const e = event as PointerEvent
    const p = live.get(e.pointerId)
    if (!live.delete(e.pointerId)) return
    // A tap is decided on the way UP, and only if the finger stayed put — see
    // the header. `pointercancel` and `lostpointercapture` come through here
    // too, and both SHOULD be able to produce a tap: a capture lost to the
    // browser is not a drag, and refusing those would make the picker
    // intermittent in exactly the conditions that are hardest to reproduce.
    // DEV-604: and a LOOK that never left the slop is a tap too, where the
    // context asks for taps: the hangar's tables are tapped, and dragged past.
    if (
      (p?.kind === 'tap' || (p?.kind === 'look' && ctx.taps === true)) &&
      Math.hypot(e.clientX - p.originX, e.clientY - p.originY) <= MENU_TAP_SLOP_PX
    ) {
      menuTap = { x: e.clientX, y: e.clientY }
    }
    e.preventDefault()
    drawSticks()
  }

  surface.addEventListener('pointerdown', onDown)
  surface.addEventListener('pointermove', onMove)
  surface.addEventListener('pointerup', onUp)
  surface.addEventListener('pointercancel', onUp)
  surface.addEventListener('lostpointercapture', onUp)
  surface.addEventListener('contextmenu', (e) => e.preventDefault())

  /**
   * A hidden control cannot be held. Otherwise a stick survives into the menu.
   *
   * The LATCHES go too, and that is not tidiness: a tap that landed on the
   * frame a session started would otherwise be delivered to the game one frame
   * later, from a button that is no longer on screen. A control that has been
   * taken away must not still be able to press itself.
   */
  const releaseAll = (): void => {
    live.clear()
    lookDx = 0
    lookDy = 0
    // For the reason the latches go: a tap that landed on the frame the plate
    // closed would otherwise pick a row on a plate nobody can see.
    menuTap = null
    for (const id of TOUCH_BUTTON_IDS) {
      down[id] = false
      latched[id] = false
      delete buttons[id].dataset.down
    }
    drawSticks()
  }

  /** Only write the DOM when something actually changed; this runs at 90 Hz. */
  /**
   * `undefined` means NOTHING HAS BEEN WRITTEN YET, and it is not `null`.
   *
   * It was `string | null = null`, and every other cache on this list is
   * `boolean | null = null` — which works for those, because `null` is not a
   * boolean and the first sync therefore always runs. This one's value type
   * INCLUDES null: `confirmLabel` is null whenever a press would do nothing.
   * So on a screen that opens with no label — which is every `?autopilot=1`
   * boot, where the launch prompt is spent in the same frame it appears —
   * `shownLabel !== ctx.confirmLabel` was `null !== null`, the block never ran
   * once, and `buttons.confirm.hidden` was never assigned at all. The button
   * kept the `START` it is built with and sat over the cockpit for the whole
   * flight, saying a word for a screen two screens back.
   *
   * A sentinel outside the value's domain, rather than a `first` flag beside
   * it: the flag is a second thing to keep in step, and this cannot be equal
   * to any label the game can produce.
   *
   * **The line that actually fires is the `shownLabel = undefined` in the menu
   * block below, not this declaration**, and that is measured rather than
   * reasoned: reverting only this initialiser leaves the test green, because
   * `shownMenu` starts `null` against a `false` context and so the menu block
   * runs on the FIRST sync of every mount, clearing this before the label
   * block is reached. Reverting both is what turns the test red. The
   * declaration stays anyway — it is what makes the invariant true of the
   * type rather than true of the order two blocks happen to run in.
   */
  let shownLabel: string | null | undefined
  /** The race chip's word as last written; `undefined` for `shownLabel`'s reason. */
  let shownRace: string | null | undefined
  /** The FLY AGAIN chip's word as last written (DEV-406 follow-up). */
  let shownAgain: string | null | undefined
  /** The pad hint's line as last written (DEV-890); `undefined` for `shownLabel`'s reason. */
  let shownHint: string | null | undefined
  let shownFlying: boolean | null = null
  let shownAuto: boolean | null = null
  let shownAutoOffered: boolean | null = null
  let shownThird: boolean | null = null
  let shownTilt: boolean | null = null
  /**
   * Constant for the life of the page in practice — a phone does not grow or
   * lose a gyroscope — but tracked anyway, because `shownFlying` is what
   * decides whether the TILT chip is drawn and a cache keyed on one input
   * while reading two is how a control silently stops updating.
   */
  let shownAvail: boolean | null = null
  let shownRoot: boolean | null = null
  let shownMenu: boolean | null = null

  const sync = (): void => {
    const on = showing()
    if (shownRoot !== on) {
      root.hidden = !on
      shownRoot = on
      if (!on) releaseAll()
    }
    // ── the plate's face of the row (DEV-290 / DEV-291) ──────────────────
    //
    // While the plate is up the four controls that fly the ship are furniture
    // over a frozen sim, and on a portrait phone the plate is most of the
    // screen — so they go, and the hamburger becomes the way back out. It runs
    // BEFORE the `flying` block and the `flying` block re-asserts the same four
    // on the way out, which is what keeps one flag from stranding the other.
    if (shownMenu !== ctx.menu) {
      shownMenu = ctx.menu
      buttons.pause.textContent = ctx.menu ? MENU_CLOSE_LABEL : MENU_LABEL
      if (ctx.menu) root.dataset.menu = '1'
      else delete root.dataset.menu
      // A stick or a shoulder held when the plate opened must not survive into
      // it — same argument as `releaseAll`, one flag down.
      if (ctx.menu) {
        live.clear()
        for (const id of ['brake', 'boost'] as const) {
          down[id] = false
          delete buttons[id].dataset.down
        }
        drawSticks()
      }
      shownFlying = null
      shownLabel = undefined
      shownRace = undefined
      shownAgain = undefined
    }
    if (shownAvail !== ctx.tiltAvailable) {
      shownAvail = ctx.tiltAvailable
      shownFlying = null
    }
    if (shownFlying !== ctx.flying) {
      for (const id of ['brake', 'boost', 'auto', 'cam'] as const) {
        buttons[id].hidden = !ctx.flying || ctx.menu
      }
      // TILT needs the sensors as well as a ship — see `tiltAvailable`.
      buttons.tilt.hidden = !ctx.flying || ctx.menu || !ctx.tiltAvailable
      buttons.pause.hidden = !ctx.flying
      shownFlying = ctx.flying
      if (!ctx.flying) {
        // A held shoulder must not survive the end of the run.
        for (const id of ['brake', 'boost'] as const) {
          down[id] = false
          delete buttons[id].dataset.down
        }
      }
    }
    if (shownLabel !== ctx.confirmLabel) {
      // Hidden while the plate is up, and that is the POINT of DEV-291 rather
      // than a tidy-up: a 168 px chip pinned to the bottom centre sits exactly
      // over a centred plate's last two rows, so on a phone you could not read
      // EDITION or EXIT — let alone press them — and the button covering them
      // was the only way to press anything. A tap picks the row directly now,
      // so the chip has nothing left to do here and its absence is what makes
      // the rows visible.
      buttons.confirm.hidden = ctx.confirmLabel === null || ctx.menu
      if (ctx.confirmLabel !== null) buttons.confirm.textContent = ctx.confirmLabel
      shownLabel = ctx.confirmLabel
    }
    // DEV-371 follow-up: the race chip, by the confirm chip's rule — a word
    // when a press does something, nothing otherwise, and never over a plate.
    const race = ctx.raceLabel ?? null
    if (shownRace !== race) {
      buttons.race.hidden = race === null || ctx.menu
      if (race !== null) buttons.race.textContent = race
      shownRace = race
      // A chip taken away must not still be held (`releaseAll`'s argument).
      if (race === null) {
        down.race = false
        latched.race = false
        delete buttons.race.dataset.down
      }
    }
    // DEV-890: the pad hint, by the same rule: a line when there is one to
    // say, and never over a plate.
    const hint = ctx.menu ? null : (ctx.padHint ?? null)
    if (shownHint !== hint) {
      padHint.hidden = hint === null
      if (hint !== null) padHint.textContent = hint
      shownHint = hint
    }
    // DEV-406 follow-up: FLY AGAIN, by the race chip's rule.
    const again = ctx.againLabel ?? null
    if (shownAgain !== again) {
      buttons.again.hidden = again === null || ctx.menu
      if (again !== null) buttons.again.textContent = again
      shownAgain = again
      if (again === null) {
        down.again = false
        latched.again = false
        delete buttons.again.dataset.down
      }
    }
    const autoOffered = ctx.autopilotOffered ?? true
    if (shownAutoOffered !== autoOffered) {
      buttons.auto.hidden = !autoOffered
      shownAutoOffered = autoOffered
      if (!autoOffered) {
        down.auto = false
        latched.auto = false
        delete buttons.auto.dataset.down
      }
    }
    if (shownAuto !== ctx.autopilot) {
      if (ctx.autopilot) buttons.auto.dataset.on = '1'
      else delete buttons.auto.dataset.on
      shownAuto = ctx.autopilot
    }
    if (shownThird !== ctx.thirdPerson) {
      if (ctx.thirdPerson) buttons.cam.dataset.on = '1'
      else delete buttons.cam.dataset.on
      shownThird = ctx.thirdPerson
    }
    if (shownTilt !== ctx.tilt) {
      if (ctx.tilt) buttons.tilt.dataset.on = '1'
      else delete buttons.tilt.dataset.on
      shownTilt = ctx.tilt
    }
  }

  return {
    available: true,
    read(opts) {
      // The frame boundary. Everything the getters report is decided here, and
      // the tap latches are spent here — see the header.
      frame = {
        confirm: down.confirm || latched.confirm,
        pause: down.pause || latched.pause,
        auto: down.auto || latched.auto,
        cam: down.cam || latched.cam,
        race: down.race || latched.race,
        again: down.again || latched.again,
      }
      for (const id of TOUCH_BUTTON_IDS) latched[id] = false
      if (!showing()) return noActions()
      // `menu` zeroes the sticks for the same reason it hides them: the plate
      // is up, the sim is frozen, and `app.ts` throws these away anyway. Doing
      // it here as well means the ONE reader that could still see a deflection
      // — a held thumb at the moment the plate opened — cannot.
      const flying = ctx.flying && !ctx.menu
      return touchActions(
        flying ? stickOf('left') : CENTRED,
        flying ? stickOf('right') : CENTRED,
        flying ? { boost: down.boost, brake: down.brake } : NO_TOUCH_BUTTONS,
        opts,
      )
    },
    readLook(opts) {
      if (lookDx === 0 && lookDy === 0) return NO_LOOK
      // CONSUMING, like the mouse's: a drag is a displacement, so a reader that
      // peeked without clearing would re-apply the same flick every frame until
      // the next one arrived. Cleared even when `touchLook` refuses the gesture,
      // or leaving the menu would replay the last drag in the cockpit.
      const delta = touchLook(lookDx, lookDy, opts)
      lookDx = 0
      lookDy = 0
      return delta
    },
    readMenuTap() {
      const tap = menuTap
      menuTap = null
      return tap
    },
    onGyroTap(fn) {
      gyroTap = fn
    },
    get confirm() {
      return frame.confirm
    },
    get pause() {
      return frame.pause
    },
    get toggleAutopilot() {
      return frame.auto
    },
    get toggleCamera() {
      return frame.cam
    },
    get raceLap() {
      return frame.race
    },
    get again() {
      return frame.again
    },
    setVisible(next) {
      visible = next
      sync()
    },
    setContext(next) {
      ctx = next
      sync()
    },
    dispose() {
      releaseAll()
      surface.removeEventListener('pointerdown', onDown)
      surface.removeEventListener('pointermove', onMove)
      surface.removeEventListener('pointerup', onUp)
      surface.removeEventListener('pointercancel', onUp)
      surface.removeEventListener('lostpointercapture', onUp)
      root.remove()
    },
  }
}
