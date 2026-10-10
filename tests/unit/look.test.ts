// tests/unit/look.test.ts — looking around, which is not flying.
//
// ── The bug this file is the answer to ───────────────────────────────────
//
// The hangar had no look control of its own and borrowed the flight stick:
// `seatLookYaw -= actions.yaw`, `seatLookPitch -= actions.pitch`. Two things
// followed, and Matt hit both within a minute of picking up a PS5 pad:
//
//   1. looking left and right was on the LEFT STICK'S VERTICAL, because that is
//      where the (broken) mapping had put yaw;
//   2. looking up and down ran the FLIGHT convention — push forward, look up —
//      which is right for an elevator and backwards for a neck.
//
// Neither was catchable by a test of the look code, because there was no look
// code. So the assertions that matter here are about AGREEMENT: the stick and
// the mouse must look the same way as each other, and both must match the
// three.js convention the camera is built on. A test that re-derived the
// expectation from the implementation's own signs would have passed on the bug.

import { describe, expect, it } from 'vitest'
import type { FlightActions } from '@/input/actions'
import {
  addLook,
  attachMouseLook,
  createFreeLook,
  FREE_LOOK_HOLD,
  FREE_LOOK_PITCH_LIMIT,
  FREE_LOOK_YAW_LIMIT,
  type MouseLook,
  NO_LOOK,
  noMouseLook,
  readKeyboardLook,
  readStickLook,
} from '@/input/look'

const DT = 1 / 60
const FLAT = { invertPitch: false, flightIdle: true }

/** Full deflection, past the 0.2 dead zone. */
const FULL = 0.95

describe('the right stick, in the hangar', () => {
  it('looks RIGHT when pushed right, and that is a NEGATIVE yaw', () => {
    // Yaw is a Y-Euler on a camera looking down −Z, so turning right is
    // negative. This is the three.js convention and not the flight model's —
    // the whole point of the file.
    const out = withPad([0, 0, FULL, 0], () => readStickLook(DT, FLAT))
    expect(out.yaw).toBeLessThan(0)
    expect(out.pitch).toBeCloseTo(0, 10)
  })

  it('looks UP when pushed up, which is what "reversed" meant', () => {
    // A pad's Y is positive DOWN, so pushing up is −Y, and looking up is a
    // POSITIVE X-Euler. Under the old code this came out the other way round
    // because it was reading a pitch axis.
    const out = withPad([0, 0, 0, -FULL], () => readStickLook(DT, FLAT))
    expect(out.pitch).toBeGreaterThan(0)
    const down = withPad([0, 0, 0, FULL], () => readStickLook(DT, FLAT))
    expect(down.pitch).toBeLessThan(0)
  })

  it('ignores the LEFT stick entirely', () => {
    // The left stick flies the ship. It looked around the room for four
    // sessions, and that is the bug.
    const out = withPad([FULL, FULL, 0, 0], () => readStickLook(DT, FLAT))
    expect(out).toEqual(NO_LOOK)
  })

  it('is silent in a mission, where that stick is the aileron', () => {
    const out = withPad([0, 0, FULL, FULL], () =>
      readStickLook(DT, { invertPitch: false, flightIdle: false }),
    )
    expect(out).toEqual(NO_LOOK)
  })

  it('scales with dt, so the look is the same speed on any machine', () => {
    const slow = withPad([0, 0, FULL, 0], () => readStickLook(1 / 30, FLAT))
    const fast = withPad([0, 0, FULL, 0], () => readStickLook(1 / 60, FLAT))
    expect(slow.yaw).toBeCloseTo(fast.yaw * 2, 10)
  })

  it('honours the global invert on PITCH and never on yaw', () => {
    const axes = [0, 0, FULL, FULL]
    const normal = withPad(axes, () => readStickLook(DT, FLAT))
    const inverted = withPad(axes, () => readStickLook(DT, { invertPitch: true, flightIdle: true }))
    expect(inverted.pitch).toBeCloseTo(-normal.pitch, 12)
    // "Invert Y" is about Y. A yaw that flipped with it would be a new bug
    // wearing the old one's clothes.
    expect(inverted.yaw).toBeCloseTo(normal.yaw, 12)
  })
})

describe('the keyboard, in the hangar', () => {
  // ── The regression this block is the answer to ──────────────────────────
  //
  // Moving the hangar look off `FlightActions` took the keyboard with it, and
  // a visitor with no pad could then not turn the chair — so not aim the nose
  // pointer at a holotable, so not choose a level, on the tier the landing page
  // calls "Playable". `pnpm check` was green. `menu-screen.spec.ts` failed in
  // one line, because it drives that screen with W and S like a person would.
  //
  // These take `FlightActions` because that is what the module takes: the ramp
  // and the pitch-invert are already in there, and re-reading the keys would
  // duplicate both.

  const keys = (over: Partial<FlightActions>): FlightActions => ({
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: 0,
    boost: false,
    brake: false,
    airbrake: false,
    ...over,
  })

  it('looks UP for W, the same way a stick pushed forward does', () => {
    // W is `+pitch`, which is nose DOWN in flight — and the same physical
    // gesture as a mouse pushed forward, which LOOKS UP. That is the whole
    // distinction: a look and an elevator read one gesture opposite ways, and
    // the old hangar was wrong because it used the elevator's answer.
    const onKeys = readKeyboardLook(keys({ pitch: 1 }), DT, FLAT)
    const onStick = withPad([0, 0, 0, -FULL], () => readStickLook(DT, FLAT))
    expect(onKeys.pitch).toBeGreaterThan(0)
    expect(Math.sign(onKeys.pitch)).toBe(Math.sign(onStick.pitch))
  })

  it('looks RIGHT for D and for E, the same way a stick pushed right does', () => {
    // D is roll and E is yaw. Neither banks or turns anything in a chair, so
    // both are spent on the one thing a chair can do.
    const onStick = withPad([0, 0, FULL, 0], () => readStickLook(DT, FLAT))
    for (const [label, action] of [
      ['D', keys({ roll: -1 })],
      ['E', keys({ yaw: 1 })],
    ] as const) {
      const out = readKeyboardLook(action, DT, FLAT)
      expect(out.yaw, `${label} must look right`).toBeLessThan(0)
      expect(Math.sign(out.yaw)).toBe(Math.sign(onStick.yaw))
    }
  })

  it('does not double the rate when roll and yaw are both held', () => {
    const one = readKeyboardLook(keys({ roll: -1 }), DT, FLAT)
    const both = readKeyboardLook(keys({ roll: -1, yaw: 1 }), DT, FLAT)
    expect(both.yaw).toBeCloseTo(one.yaw, 12)
  })

  it('is silent in a mission, where those keys fly the ship', () => {
    const out = readKeyboardLook(keys({ pitch: 1, roll: 1, yaw: 1 }), DT, {
      invertPitch: false,
      flightIdle: false,
    })
    expect(out).toEqual(NO_LOOK)
  })

  it('does NOT apply the pitch invert a second time', () => {
    // `keyboard.read()` has already applied it. Applying it again here would
    // cancel it out, and the setting would look broken on exactly one device.
    const inverted = readKeyboardLook(keys({ pitch: 1 }), DT, {
      invertPitch: true,
      flightIdle: true,
    })
    expect(inverted.pitch).toBeCloseTo(readKeyboardLook(keys({ pitch: 1 }), DT, FLAT).pitch, 12)
  })
})

describe('the mouse and the stick agree', () => {
  // THE assertion. Two devices on one view, and the failure mode Matt found is
  // exactly "these two disagree about which way up is". Compared as SIGNS,
  // because the magnitudes have nothing to do with each other — one is a rate
  // and one is a displacement — and a test that compared values would have to
  // re-derive the implementation's own constants to know what to expect.
  const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0)

  it('turns the same way for a stick pushed right and a mouse moved right', () => {
    const stick = withPad([0, 0, FULL, 0], () => readStickLook(DT, FLAT))
    const mouse = movedMouse({ x: 40, y: 0 }).read(FLAT)
    expect(sign(mouse.yaw)).toBe(sign(stick.yaw))
    expect(sign(mouse.yaw)).toBe(-1)
  })

  it('tilts the same way for a stick pushed up and a mouse moved up', () => {
    // A mouse reports movementY positive DOWNWARD, like the stick's axis.
    const stick = withPad([0, 0, 0, -FULL], () => readStickLook(DT, FLAT))
    const mouse = movedMouse({ x: 0, y: -40 }).read(FLAT)
    expect(sign(mouse.pitch)).toBe(sign(stick.pitch))
    expect(sign(mouse.pitch)).toBe(1)
  })

  it('sums rather than picking a winner, so both hands work at once', () => {
    const both = addLook({ yaw: 0.2, pitch: -0.1 }, { yaw: 0.05, pitch: 0.3 })
    expect(both.yaw).toBeCloseTo(0.25, 12)
    expect(both.pitch).toBeCloseTo(0.2, 12)
  })
})

describe('the mouse, captured', () => {
  // ── The convention, and what it costs ───────────────────────────────────
  //
  // Click to capture, Escape to release, is what every mouse-look page on the
  // web does and what the Pointer Lock API was built for. The cost is real and
  // it is the feature: while the pointer is captured the canvas receives every
  // mouse event and nothing else on the page is clickable. That is why
  // `tests/e2e/fixtures/canvas.ts` exists — the specs let go of the pointer the
  // way a player pressing Escape does.
  //
  // A middle version of this file briefly made it a click-and-drag instead,
  // which dodged the problem by not having the feature. Escape-to-release is
  // what a player expects; unbounded movement is the whole point of the API.

  it('reads nothing at all until the pointer is captured', () => {
    // Unlocked `mousemove` would swing the view whenever the cursor crossed the
    // canvas, with no way to stop it and no way to reach anything else.
    const { look, fire } = fakeMouse()
    fire('mousemove', { movementX: 100, movementY: 100 })
    expect(look.locked).toBe(false)
    expect(look.read(FLAT)).toEqual(NO_LOOK)
  })

  it('captures on a click, and only on a click', () => {
    // The request needs transient activation, and the player needs to have
    // asked. Nothing here may capture the pointer on its own.
    const { look, fire, requests } = fakeMouse()
    fire('mousemove', { movementX: 10, movementY: 10 })
    expect(requests()).toBe(0)
    fire('click', {})
    expect(requests()).toBe(1)
    expect(look.locked).toBe(true)
  })

  it('does NOT ask again while it already has the pointer', () => {
    const { fire, requests } = fakeMouse()
    fire('click', {})
    fire('click', {})
    fire('click', {})
    expect(requests()).toBe(1)
  })

  it('lets Escape win, and waits to be asked again', () => {
    // The browser releases on Escape and a page cannot refuse. Re-requesting on
    // `pointerlockchange` would be a page fighting its user — so the NEXT click
    // captures, and nothing else does.
    const { look, fire, pressEscape, requests } = fakeMouse()
    fire('click', {})
    expect(look.locked).toBe(true)
    pressEscape()
    expect(look.locked).toBe(false)
    expect(requests(), 'nothing re-requested on its own').toBe(1)
    fire('mousemove', { movementX: 80, movementY: 0 })
    expect(look.read(FLAT), 'and the view does not move while released').toEqual(NO_LOOK)
    fire('click', {})
    expect(requests()).toBe(2)
  })

  it('CONSUMES what it reports, so one flick is applied once', () => {
    // A reader that peeked without clearing would re-apply the same movement
    // every frame until the next event arrived — a view that keeps drifting
    // after the hand has stopped.
    const look = movedMouse({ x: 40, y: 0 })
    const first = look.read(FLAT)
    expect(first.yaw).not.toBe(0)
    expect(look.read(FLAT)).toEqual(NO_LOOK)
  })

  it('throws away movement from either side of the capture', () => {
    // Getting to the canvas is not aiming, and neither is the flick that let go.
    const { look, fire, pressEscape } = fakeMouse()
    fire('mousemove', { movementX: 500, movementY: 500 })
    fire('click', {})
    expect(look.read(FLAT)).toEqual(NO_LOOK)
    fire('mousemove', { movementX: 500, movementY: 500 })
    pressEscape()
    fire('click', {})
    expect(look.read(FLAT)).toEqual(NO_LOOK)
  })

  it('releases the pointer when disabled, which is what entering a session does', () => {
    // In a headset there is a neck. A captured cursor left behind on the way in
    // is a cursor nobody can see or get back.
    const { look, fire, exits } = fakeMouse()
    fire('click', {})
    expect(look.locked).toBe(true)
    look.setEnabled(false)
    expect(exits()).toBe(1)
    expect(look.locked).toBe(false)
    // And it stays off until it is turned back on.
    fire('click', {})
    expect(look.locked).toBe(false)
  })

  it('degrades to a dead look where there is no Pointer Lock API at all', () => {
    // Some embedded webviews. The stick and the keyboard still fly; nothing
    // throws at boot.
    expect(attachMouseLook(null).read(FLAT)).toEqual(NO_LOOK)
    expect(noMouseLook().locked).toBe(false)
  })
})

describe('free look, the cockpit one that comes back', () => {
  it('accumulates while you are moving', () => {
    const look = createFreeLook()
    look.update({ yaw: 0.1, pitch: 0.05 }, DT)
    look.update({ yaw: 0.1, pitch: 0.05 }, DT)
    expect(look.yaw).toBeCloseTo(0.2, 10)
    expect(look.pitch).toBeCloseTo(0.1, 10)
  })

  it('clamps, so you can never end up facing the seat back', () => {
    const look = createFreeLook()
    for (let i = 0; i < 200; i++) look.update({ yaw: 0.5, pitch: 0.5 }, DT)
    expect(look.yaw).toBeCloseTo(FREE_LOOK_YAW_LIMIT, 10)
    expect(look.pitch).toBeCloseTo(FREE_LOOK_PITCH_LIMIT, 10)
  })

  it('HOLDS the view while the hand is only briefly still', () => {
    // A glance has pauses in it. Returning the instant the mouse stops would
    // make the control unusable.
    const look = createFreeLook()
    look.update({ yaw: 1, pitch: 0 }, DT)
    const held = look.yaw
    for (let t = 0; t < FREE_LOOK_HOLD - 2 * DT; t += DT) look.update(NO_LOOK, DT)
    expect(look.yaw).toBeCloseTo(held, 10)
  })

  it('comes back to straight ahead once the hand stays still', () => {
    // The reason this exists: a flat-screen player who glanced left at 300 m/s
    // and let go has no proprioception to tell them they are still looking left.
    const look = createFreeLook()
    look.update({ yaw: 1.5, pitch: -0.8 }, DT)
    for (let t = 0; t < 3; t += DT) look.update(NO_LOOK, DT)
    expect(look.yaw).toBe(0)
    expect(look.pitch).toBe(0)
  })

  it('settles EXACTLY on zero rather than converging forever', () => {
    // An exponential never arrives. A camera carrying a 1e-17 rotation is
    // harmless and it is also a thing that shows up in a screenshot diff.
    const look = createFreeLook()
    look.update({ yaw: 0.001, pitch: 0.001 }, DT)
    for (let t = 0; t < 5; t += DT) look.update(NO_LOOK, DT)
    expect(Object.is(look.yaw, 0)).toBe(true)
    expect(Object.is(look.pitch, 0)).toBe(true)
  })

  it('starts the return over again the moment you move', () => {
    const look = createFreeLook()
    look.update({ yaw: 1, pitch: 0 }, DT)
    for (let t = 0; t < FREE_LOOK_HOLD + 0.2; t += DT) look.update(NO_LOOK, DT)
    const partway = look.yaw
    expect(partway).toBeLessThan(1)
    look.update({ yaw: 0.0001, pitch: 0 }, DT)
    const after = look.yaw
    for (let i = 0; i < 3; i++) look.update(NO_LOOK, DT)
    expect(look.yaw).toBeCloseTo(after, 10)
  })

  it('resets flat, which is what a restart needs', () => {
    const look = createFreeLook()
    look.update({ yaw: 1, pitch: 1 }, DT)
    look.reset()
    expect(look.yaw).toBe(0)
    expect(look.pitch).toBe(0)
  })
})

describe('DEV-300: and it does NOT come back while a menu is up', () => {
  // Matt, 2026-09-23: *"look auto-reset should be off while the pause plate is
  // up."* The return is for a player at 300 m/s who glanced left; with the plate
  // up the sim is frozen and the only thing the idle timer can measure is
  // somebody reading. `boot/app.ts` passes `recentre: !paused` at both of its
  // `freeLook.update` call sites.
  //
  // The measurement is the ANGLE AFTER A HOLD LONGER THAN `FREE_LOOK_HOLD`,
  // which is the thing a player sees, rather than a claim about the timer.

  /** Sit still for `seconds`, and answer where the view ended up. */
  const stillFor = (seconds: number, recentre: boolean): number => {
    const look = createFreeLook()
    look.update({ yaw: 1.2, pitch: 0 }, DT)
    for (let t = 0; t < seconds; t += DT) look.update(NO_LOOK, DT, { recentre })
    return look.yaw
  }

  it('holds the view through an idle far longer than the hold', () => {
    // Five seconds is eight times `FREE_LOOK_HOLD` and twenty-seven time
    // constants — if anything decayed at all it would be gone.
    expect(stillFor(5, false)).toBeCloseTo(1.2, 12)
  })

  it('and the SAME idle returns the view when a menu is not up', () => {
    // The contrast case, in the same breath: without it the assertion above is
    // true of a `createFreeLook` that never returns at all, and the whole
    // control could be deleted with this file still green.
    expect(stillFor(5, true)).toBe(0)
  })

  it('does not bank up a return to spend on the first frame after the unpause', () => {
    // If the held frames still advanced `idle`, closing the plate would swing
    // the view immediately — the same bug one gesture later. So the hold has to
    // be the whole `FREE_LOOK_HOLD` again, measured from the unpause.
    const look = createFreeLook()
    look.update({ yaw: 1.2, pitch: 0 }, DT)
    for (let t = 0; t < 5; t += DT) look.update(NO_LOOK, DT, { recentre: false })
    // Unpaused, but not yet idle for long enough.
    for (let t = 0; t < FREE_LOOK_HOLD - 2 * DT; t += DT) look.update(NO_LOOK, DT)
    expect(look.yaw, 'still where the player left it').toBeCloseTo(1.2, 12)
    // And then it behaves exactly as it always did.
    for (let t = 0; t < 3; t += DT) look.update(NO_LOOK, DT)
    expect(look.yaw).toBe(0)
  })

  it('still accepts a look while it is held, because the gaze AIMS the plate', () => {
    // On a flat screen this free look is what points the ray at a pause row.
    // A hold that also froze the input would make the plate unaimable.
    const look = createFreeLook()
    look.update({ yaw: 0.3, pitch: -0.2 }, DT, { recentre: false })
    look.update({ yaw: 0.3, pitch: -0.2 }, DT, { recentre: false })
    expect(look.yaw).toBeCloseTo(0.6, 12)
    expect(look.pitch).toBeCloseTo(-0.4, 12)
  })
})

describe('DEV-301: a click is a fifth aimer, and the capture eats the first one', () => {
  // ── The one rule ────────────────────────────────────────────────────────
  //
  // The mouse is a CURSOR or a NECK, never both, and pointer lock is the switch.
  // While it is a neck a click says "select what I am aiming at" and rides the
  // same `confirm` as A, Enter, the XR trigger and a finger. The click that
  // TURNS it into a neck is spent on that, because an unlocked mouse moves
  // nothing — so there was no aim for it to select with.
  //
  // That second clause is also what keeps `tests/e2e/fixtures/canvas.ts` honest:
  // ~50 specs click the canvas for focus, and not one of them presses a button.

  it('reports nothing for the click that captures the pointer', () => {
    const { look, fire, requests } = fakeMouse()
    fire('click', {})
    expect(requests(), 'it captured').toBe(1)
    expect(look.readClick(), 'and spent the click on that').toBe(false)
  })

  it('reports every click after that, while the mouse is the neck', () => {
    const { look, fire } = fakeMouse()
    fire('click', {})
    look.readClick()
    fire('click', {})
    expect(look.readClick()).toBe(true)
    fire('click', {})
    expect(look.readClick()).toBe(true)
  })

  it('CONSUMES the click, so one press is delivered once', () => {
    // A latch that was peeked at rather than spent presses the same button on
    // every frame after it — and a click can land and lift between two frames,
    // which is why it is a latch at all.
    const { look, fire } = fakeMouse()
    fire('click', {})
    fire('click', {})
    expect(look.readClick()).toBe(true)
    expect(look.readClick()).toBe(false)
  })

  it('spends the NEXT capture too, after Escape gave the pointer back', () => {
    // Escape is how a player reaches anything else on the page. Coming back is
    // a capture like the first one, and it presses nothing.
    const { look, fire, pressEscape } = fakeMouse()
    fire('click', {})
    look.readClick()
    pressEscape()
    fire('click', {})
    expect(look.readClick(), 'the re-capture is not a press').toBe(false)
    fire('click', {})
    expect(look.readClick()).toBe(true)
  })

  it('reports the FIRST click where there is no capture to be had', () => {
    // A session, and the title before its rows are up: `app.ts` disables the
    // look there. With no capture to spend a click on, one click presses the
    // one thing on the screen. That was all of wishlist #35 until DEV-418 gave
    // the title a look of its own; see the next block for how a click still
    // leaves it in one.
    const { look, fire, requests } = fakeMouse()
    look.setEnabled(false)
    fire('click', {})
    expect(requests(), 'nothing was captured').toBe(0)
    expect(look.readClick()).toBe(true)
  })

  it('has a dead version, so a webview with no Pointer Lock presses nothing', () => {
    expect(noMouseLook().readClick()).toBe(false)
    expect(attachMouseLook(null).readClick()).toBe(false)
  })
})

describe('DEV-418: a CURSOR click that lands on something presses it, and captures nothing', () => {
  // Matt, 2026-09-26: *"titlescreen: enable look just like the other menus"*.
  // The title captures now, as the hangar does — but it also draws rows a
  // cursor can click (DEV-353), and a cursor ON a row has an aim: where it
  // landed. So an unlocked click asks the screen's target first. The rule is
  // DEV-301's, refined rather than excepted: a cursor click with nothing under
  // it still has no aim, and is spent on becoming a neck.

  it('presses what the cursor is on, and leaves the pointer free', () => {
    const { look, fire, requests } = fakeMouse()
    look.setCursorTarget(() => true)
    fire('click', { clientX: 640, clientY: 520 })
    expect(requests(), 'no capture').toBe(0)
    expect(look.readClick(), 'one click, one press').toBe(true)
    expect(look.locked).toBe(false)
  })

  it('captures, and presses nothing, where the cursor is on nothing', () => {
    const { look, fire, requests } = fakeMouse()
    look.setCursorTarget(() => false)
    fire('click', { clientX: 640, clientY: 200 })
    expect(requests(), 'the capture').toBe(1)
    expect(look.readClick(), 'spent on it').toBe(false)
    expect(look.locked).toBe(true)
  })

  it('asks the target WHERE the click landed', () => {
    const asked: [number, number][] = []
    const { look, fire, requests, pressEscape } = fakeMouse()
    look.setCursorTarget((x, y) => {
      asked.push([x, y])
      return y > 400
    })
    fire('click', { clientX: 10, clientY: 500 })
    expect(look.readClick(), 'below the line: a press').toBe(true)
    fire('click', { clientX: 20, clientY: 300 })
    expect(look.readClick(), 'above it: the capture').toBe(false)
    expect(requests()).toBe(1)
    expect(asked).toEqual([
      [10, 500],
      [20, 300],
    ])
    pressEscape()
    expect(look.locked).toBe(false)
  })

  it('never asks while the mouse is the NECK: its click is always a press', () => {
    // Under pointer lock the event's position is frozen where the capture
    // began, so a target asked then would be answering about a stale point.
    let asked = 0
    const { look, fire } = fakeMouse()
    fire('click', {})
    look.readClick()
    look.setCursorTarget(() => {
      asked++
      return false
    })
    fire('click', { clientX: 1, clientY: 1 })
    expect(look.readClick(), 'the neck clicked').toBe(true)
    expect(asked, 'and nobody asked the cursor').toBe(0)
  })

  it('never asks while the mouse is off, either: every click is reported', () => {
    let asked = 0
    const { look, fire, requests } = fakeMouse()
    look.setEnabled(false)
    look.setCursorTarget(() => {
      asked++
      return false
    })
    fire('click', { clientX: 1, clientY: 1 })
    expect(look.readClick()).toBe(true)
    expect(requests()).toBe(0)
    expect(asked).toBe(0)
  })

  it('null is nowhere, which is every screen but the title', () => {
    const { look, fire, requests } = fakeMouse()
    look.setCursorTarget(() => true)
    look.setCursorTarget(null)
    fire('click', { clientX: 640, clientY: 520 })
    expect(requests(), 'back to the capture').toBe(1)
    expect(look.readClick()).toBe(false)
  })

  it('has a dead version too', () => {
    const dead = noMouseLook()
    dead.setCursorTarget(() => true)
    expect(dead.readClick()).toBe(false)
  })
})

describe('DEV-563: a capture the PLAYER let go of is reported, once', () => {
  // While the pointer is captured Chrome spends Escape on the release and the
  // page sees no key at all, so the release IS the player's Escape. `app.ts`
  // opens the pause menu on it. The game's own releases (a headset, the
  // editor, the title before its rows) are screen changes and must not read
  // as a request for a menu.

  it('reports the browser letting go, which is what Escape is while captured', () => {
    const { look, fire, pressEscape } = fakeMouse()
    fire('click', {})
    expect(look.readLostCapture(), 'nothing lost while it is held').toBe(false)
    pressEscape()
    expect(look.readLostCapture()).toBe(true)
  })

  it('CONSUMES it, so one Escape opens one menu', () => {
    const { look, fire, pressEscape } = fakeMouse()
    fire('click', {})
    pressEscape()
    expect(look.readLostCapture()).toBe(true)
    expect(look.readLostCapture()).toBe(false)
  })

  it('does not report the GAME letting go', () => {
    const { look, fire, exits } = fakeMouse()
    fire('click', {})
    look.setEnabled(false)
    expect(exits()).toBe(1)
    expect(look.readLostCapture()).toBe(false)
  })

  it('still reports the player after the game has let go once', () => {
    // The "ours" mark is settled by the change it caused, so it cannot hide
    // the NEXT release, which is the player's.
    const { look, fire, pressEscape } = fakeMouse()
    fire('click', {})
    look.setEnabled(false)
    look.setEnabled(true)
    fire('click', {})
    pressEscape()
    expect(look.readLostCapture()).toBe(true)
  })

  it('reports nothing for a pointer that was never captured', () => {
    const { look, pressEscape } = fakeMouse()
    pressEscape()
    expect(look.readLostCapture()).toBe(false)
  })

  it('has a dead version, which never loses what it never had', () => {
    expect(noMouseLook().readLostCapture()).toBe(false)
    expect(attachMouseLook(null).readLostCapture()).toBe(false)
  })
})

describe('DEV-563 follow-up: a free cursor on the pause plate', () => {
  // After Escape the cursor is free over the plate. A click on a row presses
  // it and captures nothing, through the plate's own cursor slot, while the
  // title keeps its slot; a move onto a row is reported for the hover.

  it('presses through a second SLOT, and either slot saying yes is enough', () => {
    const { look, fire, requests } = fakeMouse()
    look.setCursorTarget(() => false) // the title's: nothing under the cursor
    look.setCursorTarget((x) => x > 100, 'pause')
    fire('click', { clientX: 200, clientY: 10 })
    expect(requests(), 'a click on a pause row captures nothing').toBe(0)
    expect(look.readClick(), 'and is a press').toBe(true)
    fire('click', { clientX: 50, clientY: 10 })
    expect(requests(), 'a click on neither is the capture').toBe(1)
    expect(look.readClick()).toBe(false)
  })

  it('clears one slot without touching the other', () => {
    const { look, fire, requests } = fakeMouse()
    look.setCursorTarget(() => true)
    look.setCursorTarget(() => true, 'pause')
    look.setCursorTarget(null, 'pause')
    fire('click', { clientX: 1, clientY: 1 })
    expect(requests(), 'the title slot still presses').toBe(0)
    look.setCursorTarget(null)
    fire('click', { clientX: 1, clientY: 1 })
    expect(requests(), 'with both gone the click captures').toBe(1)
  })

  it('reports where the FREE cursor moved, once', () => {
    const { look, fire } = fakeMouse()
    expect(look.readHover(), 'nothing until it moves').toBe(null)
    fire('mousemove', { clientX: 30, clientY: 40 })
    fire('mousemove', { clientX: 31, clientY: 42 })
    expect(look.readHover(), 'the latest position').toEqual({ x: 31, y: 42 })
    expect(look.readHover(), 'consumed').toBe(null)
  })

  it('reports no hover while captured: there is no cursor then', () => {
    const { look, fire } = fakeMouse()
    fire('click', {})
    fire('mousemove', { clientX: 30, clientY: 40, movementX: 5, movementY: 0 })
    expect(look.readHover()).toBe(null)
  })

  it('forgets a position from before the capture changed', () => {
    const { look, fire } = fakeMouse()
    fire('mousemove', { clientX: 30, clientY: 40 })
    fire('click', {})
    expect(look.readHover()).toBe(null)
  })

  it('has a dead version with no cursor', () => {
    expect(noMouseLook().readHover()).toBe(null)
  })
})

// ── fakes ─────────────────────────────────────────────────────────────────
//
// `tests/unit` runs `environment: 'node'` — there is no DOM here and this file
// is not worth one. The fakes are the three methods `attachMouseLook` touches.

interface FakeMouse {
  readonly look: MouseLook
  fire(type: string, event: Record<string, unknown>): void
  /** How many times the canvas was asked to capture the pointer. */
  requests(): number
  /** How many times the document was asked to give it back. */
  exits(): number
  /** What the browser does on Escape — release, unasked. */
  pressEscape(): void
}

/**
 * The three DOM methods `attachMouseLook` touches, and nothing else.
 *
 * `tests/unit` runs `environment: 'node'`, and this file is not worth a DOM.
 * The fake also models the bit that matters about the real API: the lock lands
 * via a `pointerlockchange` event, not as a return value.
 */
function fakeMouse(): FakeMouse {
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  let requestCount = 0
  let exitCount = 0
  const add = (type: string, fn: (e: unknown) => void) => {
    const set = listeners.get(type) ?? new Set()
    set.add(fn)
    listeners.set(type, set)
  }
  const remove = (type: string, fn: (e: unknown) => void) => listeners.get(type)?.delete(fn)
  const fire = (type: string, event: Record<string, unknown>): void => {
    for (const fn of listeners.get(type) ?? []) fn(event)
  }

  const doc = {
    pointerLockElement: null as unknown,
    addEventListener: add,
    removeEventListener: remove,
    exitPointerLock: () => {
      exitCount++
      doc.pointerLockElement = null
      fire('pointerlockchange', {})
    },
  }
  const canvas = {
    ownerDocument: doc,
    addEventListener: add,
    removeEventListener: remove,
    requestPointerLock: () => {
      requestCount++
      doc.pointerLockElement = canvas
      fire('pointerlockchange', {})
    },
  }

  const look = attachMouseLook(canvas as unknown as HTMLElement)
  return {
    look,
    fire,
    requests: () => requestCount,
    exits: () => exitCount,
    // Escape is the BROWSER releasing the pointer. It is not `exitPointerLock`
    // and the page never sees a request — it just finds out afterwards.
    pressEscape: () => {
      doc.pointerLockElement = null
      fire('pointerlockchange', {})
    },
  }
}

/** A captured mouse that has just been moved by (x, y) pixels. */
function movedMouse(by: { x: number; y: number }): MouseLook {
  const { look, fire } = fakeMouse()
  fire('click', {})
  fire('mousemove', { movementX: by.x, movementY: by.y })
  return look
}

/**
 * Run `fn` with a fake `navigator.getGamepads`. See `control-scheme.test.ts`'s
 * copy for why this is `defineProperty` and why it is not shared.
 */
function withPad<T>(axes: number[], fn: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      getGamepads: () => [{ connected: true, mapping: 'standard', axes, buttons: [] }],
    },
    configurable: true,
    writable: true,
  })
  try {
    return fn()
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
}
