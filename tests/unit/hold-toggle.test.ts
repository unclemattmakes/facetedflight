// tests/unit/hold-toggle.test.ts — the autopilot chord has to be MEANT.
//
// DEV-181. Every worn lap so far has been hand-flown, because the autopilot
// arms from `?autopilot=1` and from a keyboard `P` and a headset has neither.
// The binding that fixes it is the left hand's X, HELD — and the hold is the
// whole safety argument, so it is the thing tested here.
//
// **Compare against something outside the port** (CLAUDE.md, DEV-069): the
// button index is not a number this file invented, it is `xr-standard`'s, and
// the test below names the whole map so a future reassignment collides with a
// spec rather than with a preference.

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { HOLD_TOGGLE_SECONDS, NO_HOLD, stepHoldToggle } from '@/input/hold-toggle'
import { readXrInput } from '@/input/xr'
import { contextFor, controlsRows } from '@/render/controls-menu'

/** `xr-standard`, from the WebXR Gamepads Module: 0 trigger, 1 squeeze, 2 touchpad, 3 thumbstick, 4 A/X, 5 B/Y. */
const controller = (
  handedness: XRHandedness,
  buttons: Record<number, number> = {},
): XRInputSource =>
  ({
    handedness,
    targetRayMode: 'tracked-pointer',
    gamepad: {
      mapping: 'xr-standard',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 6 }, (_, i) => ({
        value: buttons[i] ?? 0,
        pressed: (buttons[i] ?? 0) > 0.5,
        touched: false,
      })),
    },
  }) as unknown as XRInputSource

const session = (...sources: XRInputSource[]): XRSession =>
  ({ inputSources: sources }) as unknown as XRSession

const OPTS = { invertPitch: false }

/** Hold `down` for `seconds`, at `hz` frames a second. Returns how many times it fired. */
const holdFor = (seconds: number, hz = 90, threshold = HOLD_TOGGLE_SECONDS) => {
  let state = NO_HOLD
  let fired = 0
  const dt = 1 / hz
  for (let t = 0; t < seconds; t += dt) {
    const step = stepHoldToggle(state, true, dt, threshold)
    state = step.state
    if (step.toggled) fired++
  }
  return { fired, state }
}

// ── This block used to say "left hand, button 4", and that was the bug ────
//
// It read: *"the chord is the one button this scheme leaves free"*, and the
// button it named was the left hand's index 4. True on a Quest Touch, where
// index 4 is X. **False on a Steam Frame, where the left controller has a D-PAD
// and index 4 is one of its directions** (DEV-207) — SteamVR has no Frame
// profile to advertise, so it describes the device as `oculus-touch` and folds
// a 4-way into two face-button slots.
//
// Nothing was "free". The scheme had simply never met the hardware, and the old
// test could not have caught it: it asserted the binding it was written from.
// With the D-pad now opening the pause plate, and `app.ts` holding this for two
// seconds, holding a direction to step a list would have engaged the autopilot
// mid-menu.
//
// So the chord is BOTH GRIPS, and a chord is only a chord if half of it does
// nothing — which is what the assertions below are actually about.
describe('the autopilot chord is both grips, and cannot be struck by accident', () => {
  const both = (): ReturnType<typeof readXrInput> =>
    readXrInput(session(controller('left', { 1: 1 }), controller('right', { 1: 1 })), OPTS)

  it('needs both hands — neither grip alone arms it', () => {
    expect(both().autopilot).toBe(true)
    expect(readXrInput(session(controller('left', { 1: 1 })), OPTS).autopilot).toBe(false)
    expect(readXrInput(session(controller('right', { 1: 1 })), OPTS).autopilot).toBe(false)
  })

  it('is NOT on left index 4, which is a D-pad direction on the Frame', () => {
    // The regression guard, named after the hardware rather than the profile:
    // this is the assertion the old version of this block got wrong.
    expect(readXrInput(session(controller('left', { 4: 1 })), OPTS).autopilot).toBe(false)
    expect(readXrInput(session(controller('left', { 5: 1 })), OPTS).autopilot).toBe(false)
  })

  it('does not collide with anything else the scheme binds', () => {
    // Left: 0 boost, 2/3 recentre click, 4/5 pause + menu step. Right: 0
    // throttle, 4 confirm, 5 brake/back. Every one of them at once, with the
    // GRIPS DELIBERATELY LEFT OUT, must not arm it — if a later change moves a
    // binding onto a grip this is the test that says so.
    const everythingElse = readXrInput(
      session(
        controller('left', { 0: 1, 2: 1, 3: 1, 4: 1, 5: 1 }),
        controller('right', { 0: 1, 2: 1, 3: 1, 4: 1, 5: 1 }),
      ),
      OPTS,
    )
    expect(everythingElse.autopilot).toBe(false)
    // ...and the controls it SHOULD have set are still set, so this is not
    // passing because the read fell over.
    expect(everythingElse.confirm).toBe(true)
    expect(everythingElse.pause).toBe(true)
  })

  it('leaves both grips doing their flight jobs while the chord is held', () => {
    // The chord must not STEAL the inputs. Holding both is a contradictory
    // flight command — airbrake against boost — which is exactly why it is safe
    // to overload, but each must still be what it was.
    const r = both()
    expect(r.actions.airbrake).toBe(true)
    expect(r.actions.boost).toBe(true)
  })

  it('is what the headset Controls page tells the player to hold (DEV-597)', () => {
    // The page said `hold X, 2 s` for months after the chord moved here; a
    // player who did that got the pause plate. Held to the binding above, not
    // to a copy of the page's own string.
    const row = controlsRows(DEFAULT_SETTINGS, contextFor('xr')).find((r) => r.id === 'autopilot')
    expect(row?.value).toBe(`both grips, ${HOLD_TOGGLE_SECONDS} s`)
    expect(both().autopilot).toBe(true)
    // X is left index 4: it pauses, it does not arm the autopilot.
    const x = readXrInput(session(controller('left', { 4: 1 })), OPTS)
    expect(x.autopilot).toBe(false)
    expect(x.pause).toBe(true)
    expect(row?.value).not.toMatch(/\bX\b/)
  })

  it('reports the raw state, leaving the hold to the caller', () => {
    // The same contract `confirm`, `pause` and `recenter` have, and for the
    // reason xr.ts gives: this file does not know what a frame is. Two reads
    // of a held chord are both true; nothing here latches.
    const s = session(controller('left', { 1: 1 }), controller('right', { 1: 1 }))
    expect(readXrInput(s, OPTS).autopilot).toBe(true)
    expect(readXrInput(s, OPTS).autopilot).toBe(true)
  })
})

describe('the hold', () => {
  it('does not fire early, and fires exactly once', () => {
    expect(holdFor(HOLD_TOGGLE_SECONDS - 0.1).fired).toBe(0)
    expect(holdFor(HOLD_TOGGLE_SECONDS + 0.1).fired).toBe(1)
    // The latch is the point: a five-second hold is still one toggle. Without
    // it the strobe is the same bug `autopilotKeyHeld` exists to stop one
    // level up — four hundred toggles in the time it takes to notice.
    expect(holdFor(5).fired).toBe(1)
  })

  it('needs a RELEASE before it can fire again', () => {
    const held = holdFor(HOLD_TOGGLE_SECONDS + 0.5)
    expect(held.fired).toBe(1)
    // Still down: no second fire, however long.
    const stillDown = stepHoldToggle(held.state, true, 5)
    expect(stillDown.toggled).toBe(false)
    // Released: the state is clean again.
    const released = stepHoldToggle(stillDown.state, false, 0.011)
    expect(released.state).toEqual(NO_HOLD)
    expect(released.toggled).toBe(false)
  })

  it('takes the same wall time at any frame rate', () => {
    // The hold is in SECONDS, not frames. A 45 Hz headset and a 144 Hz monitor
    // must want the same gesture — a threshold counted in frames would be
    // three times slower on one of them, and the one it would be slower on is
    // the one in trouble.
    for (const hz of [30, 45, 72, 90, 144]) {
      expect(holdFor(HOLD_TOGGLE_SECONDS - 0.1, hz).fired).toBe(0)
      expect(holdFor(HOLD_TOGGLE_SECONDS + 0.1, hz).fired).toBe(1)
    }
  })

  it('cannot be completed by one enormous delta', () => {
    // A backgrounded tab hands back a delta of seconds. `app.ts` clamps to
    // 0.1 s before calling — the same clamp the particles take — so a hold
    // still needs twenty frames of intent. Here: one frame of a clamped delta
    // gets nowhere near.
    const one = stepHoldToggle(NO_HOLD, true, Math.min(10, 0.1))
    expect(one.toggled).toBe(false)
    expect(one.progress).toBeCloseTo(0.05, 6)
  })

  it('reports progress, so a cue can be hung off it later', () => {
    const half = stepHoldToggle({ heldSeconds: HOLD_TOGGLE_SECONDS / 2, fired: false }, true, 0)
    expect(half.progress).toBeCloseTo(0.5, 6)
    expect(stepHoldToggle(NO_HOLD, false, 0.011).progress).toBe(0)
  })

  it('ignores a non-finite delta rather than poisoning the accumulator', () => {
    // One NaN would make `heldSeconds` NaN for the rest of the press, and the
    // comparison would then be false for ever — a binding that silently stops
    // working, which is the worst shape of bug for a control nobody can see.
    const bad = stepHoldToggle(NO_HOLD, true, Number.NaN)
    expect(bad.state.heldSeconds).toBe(0)
    expect(holdFor(HOLD_TOGGLE_SECONDS + 0.1).fired).toBe(1)
  })
})
