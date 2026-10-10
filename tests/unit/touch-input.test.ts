// tests/unit/touch-input.test.ts — the thumbs, held against the pad.
//
// ── What this file is for ────────────────────────────────────────────────
//
// A fourth input device landing in a port that has already shipped three
// disagreeing ones. The ledger is specific about how that goes wrong:
//
//   - `gamepad.ts` flew a scheme that exists in no version of this game for
//     four sessions, described in its own prose as scheme "a" (DEV-069);
//   - `keyboard.ts` pitched and rolled BACKWARDS against the pad for the life
//     of the port, because **no test compared the two devices** (DEV-071);
//   - the pause menu read the pitch axis with the pad's sign inverted, and
//     nothing noticed because the only thing that drives that menu
//     automatically is a Playwright keyboard.
//
// Every one of those was self-consistent. So this file does not check the touch
// reader against itself — it pushes a gesture into `readGamepad` and the same
// gesture into `touchActions`, and asserts they produce the same number. The
// pad is the right yardstick because it is the device already pinned to
// something outside the port: `control-scheme.test.ts` holds it against
// `HOVERJET.input.controlScheme` and the `Input_Ship.cs` lines that letter
// names. Agreeing with the pad therefore means agreeing with 2016.
//
// ── The one axis that is deliberately NOT the pad's ──────────────────────
//
// Throttle. `control-scheme.test.ts` asserts the pad leaves the right stick's
// VERTICAL unbound — scheme "a" has three axes and a pad has four — and warns
// that binding it in one reader and not another is how two devices stop
// agreeing. A touchscreen has no triggers and no spare thumb, so the throttle
// goes there, and this file pins the divergence rather than letting it be
// discovered. DEV-104.
//
// The DOM half — the elements, the pointer events, the labels — is not here.
// `vitest.config.ts` is `environment: 'node'` on purpose: *"if a test needs a
// DOM, that test is testing the render layer and belongs in Playwright"*. It
// does, and it is `tests/e2e/mobile-controls.spec.ts`.

import { describe, expect, it } from 'vitest'
import type { FlightActions } from '@/input/actions'
import { AXIS, BUTTON, readGamepad } from '@/input/gamepad'
import { NO_LOOK, readStickLook } from '@/input/look'
import {
  CENTRED,
  NO_TOUCH_BUTTONS,
  STICK_DEAD_PX,
  STICK_RADIUS_PX,
  type StickVector,
  stickVector,
  touchActions,
  touchLook,
  zoneFor,
} from '@/input/touch'

const OPTS = { invertPitch: false }
const LOOK = { invertPitch: false, flightIdle: true }

/** A pad deflection well past `DEAD_ZONE_UPPER`, so `shapeAxis` saturates to ±1. */
const FULL_PAD = 0.95

/** A drag that has reached the stick's gate, so the touch reader saturates too. */
const REACH = STICK_RADIUS_PX * 2

/** A thumb dragged `(dx, dy)` pixels from where it went down. */
const dragged = (dx: number, dy: number): StickVector => stickVector(dx, dy)

/** Both thumbs and both chips, as one action set. */
const thumbs = (
  left: StickVector,
  right: StickVector = CENTRED,
  buttons = NO_TOUCH_BUTTONS,
  opts = OPTS,
): FlightActions => touchActions(left, right, buttons, opts)

describe('a stick is the circle it is drawn as', () => {
  it('sits still under a thumb that has not moved, and inside the slop', () => {
    expect(dragged(0, 0)).toEqual(CENTRED)
    expect(dragged(STICK_DEAD_PX, 0)).toEqual(CENTRED)
    expect(dragged(0, -STICK_DEAD_PX)).toEqual(CENTRED)
  })

  it('clamps to the unit CIRCLE, not the unit square', () => {
    // A physical stick cannot reach 1.41 along its diagonal and neither may
    // this one, or a diagonal drag would command 41% more pitch AND roll than
    // the same drag along either axis on its own.
    const corner = dragged(REACH, REACH)
    expect(Math.hypot(corner.x, corner.y)).toBeCloseTo(1, 6)
    const straight = dragged(REACH, 0)
    expect(Math.hypot(straight.x, straight.y)).toBeCloseTo(1, 6)
  })

  it('spends the dead zone on TRAVEL rather than stepping over it', () => {
    // The first pixel past the slop must command ~0. A reader that subtracted
    // nothing would jump straight to 4/56 — small, and exactly the kind of
    // small that reads as a ship that will not fly straight.
    const nudged = dragged(STICK_DEAD_PX + 1, 0)
    expect(nudged.x).toBeGreaterThan(0)
    expect(nudged.x).toBeLessThan(0.05)
    expect(dragged(STICK_RADIUS_PX, 0).x).toBeCloseTo(1, 6)
  })

  it('grows with the drag, all the way out', () => {
    let previous = 0
    for (let px = STICK_DEAD_PX + 1; px <= STICK_RADIUS_PX; px += 4) {
      const now = dragged(px, 0).x
      expect(now).toBeGreaterThan(previous)
      previous = now
    }
  })
})

describe('the thumbs agree with the pad, gesture for gesture', () => {
  // ── Read this before changing a sign below ─────────────────────────────
  //
  // A screen's y grows DOWNWARD and so does a gamepad's stick axis, so the two
  // devices report the same NUMBER for the same physical gesture — a thumb
  // dragged up the glass and a stick pushed away from you are both negative.
  // That is why `touch.ts` copies the pad's arithmetic verbatim instead of
  // re-deriving it, and it is why these assertions can compare the two readers
  // directly rather than each against a remembered convention.

  /** The pad, with one axis pushed and everything else centred. */
  const padAxis = (index: number, value: number): FlightActions =>
    withPad(Object.assign([0, 0, 0, 0], { [index]: value }) as number[], [], () =>
      readGamepad(OPTS),
    )

  it('dives when the left thumb goes forward, exactly as the left stick does', () => {
    // Push forward, dive: `invertPitch: false` is the shipped default on the
    // prefab, and `+pitch` is nose DOWN (`sim/autopilot.ts:41-44`, measured off
    // the integrator rather than reasoned from handedness).
    const pad = padAxis(AXIS.leftY, -FULL_PAD)
    const touch = thumbs(dragged(0, -REACH))
    expect(pad.pitch).toBeCloseTo(1, 6)
    expect(touch.pitch).toBeCloseTo(pad.pitch, 6)
  })

  it('climbs when the left thumb comes back, exactly as the left stick does', () => {
    const pad = padAxis(AXIS.leftY, FULL_PAD)
    const touch = thumbs(dragged(0, REACH))
    expect(pad.pitch).toBeCloseTo(-1, 6)
    expect(touch.pitch).toBeCloseTo(pad.pitch, 6)
  })

  it('yaws right when the left thumb goes right, exactly as the left stick does', () => {
    const pad = padAxis(AXIS.leftX, FULL_PAD)
    const touch = thumbs(dragged(REACH, 0))
    expect(pad.yaw).toBeCloseTo(1, 6)
    expect(touch.yaw).toBeCloseTo(pad.yaw, 6)
    expect(thumbs(dragged(-REACH, 0)).yaw).toBeCloseTo(padAxis(AXIS.leftX, -FULL_PAD).yaw, 6)
  })

  it('rolls the way the RIGHT stick rolls, on the right thumb', () => {
    const pad = padAxis(AXIS.rightX, FULL_PAD)
    const touch = thumbs(CENTRED, dragged(REACH, 0))
    // `+roll` banks LEFT, so a stick pushed right produces a negative roll.
    // Asserted as agreement AND as the measured sign, because agreement alone
    // is what stayed green while VR and flat were both wrong.
    expect(pad.roll).toBeCloseTo(-1, 6)
    expect(touch.roll).toBeCloseTo(pad.roll, 6)
  })

  it('reports a resting thumb as the pad reports a resting stick — negative zero and all', () => {
    // Both readers negate their pitch axis, so both hand back `-0` when nothing
    // is being touched. It is harmless — `-0` flies exactly as well as `0`, and
    // `mergeActions` compares magnitudes — but it is SHARED, and this line is
    // what keeps it shared. `look.ts` carries a `flip` helper precisely because
    // `-0` compares unequal under `Object.is`, so somebody will eventually
    // decide to tidy one of these two files up. Tidy both, or neither.
    const pad = withPad([0, 0, 0, 0], [], () => readGamepad(OPTS))
    const touch = thumbs(CENTRED)
    expect(Object.is(touch.pitch, pad.pitch)).toBe(true)
    expect(touch.yaw).toBe(pad.yaw)
    expect(touch.throttle).toBe(pad.throttle)
  })

  it('sends each thumb to its own axes and nowhere else', () => {
    // The structural claim, and the one the broken pad mapping failed: it put
    // pitch and yaw on two different sticks' verticals and left the yaw axis
    // 2016 ships doing nothing at all. True whichever sign convention the body
    // frame turns out to have.
    const routes: ReadonlyArray<[StickVector, StickVector, keyof FlightActions]> = [
      [dragged(0, -REACH), CENTRED, 'pitch'],
      [dragged(REACH, 0), CENTRED, 'yaw'],
      [CENTRED, dragged(REACH, 0), 'roll'],
    ]
    for (const [left, right, action] of routes) {
      const out = thumbs(left, right)
      expect(Math.abs(out[action] as number), `-> ${action}`).toBeGreaterThan(0.5)
      for (const other of ['pitch', 'yaw', 'roll'] as const) {
        if (other === action) continue
        expect(Math.abs(out[other]), `must not touch ${other}`).toBeCloseTo(0, 10)
      }
    }
  })

  it('inverts pitch with the SAME switch the pad inverts with, and nothing else', () => {
    // D16: one switch for the whole game. A switch that corrects one device and
    // breaks another is not an option, it is a second bug with a menu row.
    const gesture = dragged(REACH * 0.5, -REACH * 0.5)
    const normal = thumbs(gesture, CENTRED, NO_TOUCH_BUTTONS, { invertPitch: false })
    const inverted = thumbs(gesture, CENTRED, NO_TOUCH_BUTTONS, { invertPitch: true })
    expect(inverted.pitch).toBeCloseTo(-normal.pitch, 10)
    expect(inverted.yaw).toBeCloseTo(normal.yaw, 10)

    const padNormal = withPad(
      Object.assign([0, 0, 0, 0], { [AXIS.leftY]: -FULL_PAD }) as number[],
      [],
      () => readGamepad({ invertPitch: false }),
    )
    const padInverted = withPad(
      Object.assign([0, 0, 0, 0], { [AXIS.leftY]: -FULL_PAD }) as number[],
      [],
      () => readGamepad({ invertPitch: true }),
    )
    // Both devices flip, and both flip the same way round.
    expect(Math.sign(normal.pitch)).toBe(Math.sign(padNormal.pitch))
    expect(Math.sign(inverted.pitch)).toBe(Math.sign(padInverted.pitch))
  })
})

describe('throttle, the one axis that is not the pad’s', () => {
  it('reaches the same full throttle R2 does, pushed forward', () => {
    const pad = withPad([0, 0, 0, 0], Object.assign(Array(10).fill(0), { [BUTTON.r2]: 1 }), () =>
      readGamepad(OPTS),
    )
    expect(pad.throttle).toBe(1)
    expect(thumbs(CENTRED, dragged(0, -REACH)).throttle).toBeCloseTo(1, 6)
  })

  it('is FORWARD ONLY — pulling the right thumb back is not a reverse', () => {
    // And not a brake either. The brake is a button, as it is on the pad.
    expect(thumbs(CENTRED, dragged(0, REACH)).throttle).toBe(0)
    expect(thumbs(CENTRED, CENTRED).throttle).toBe(0)
  })

  it('opens the throttle without taking the roll away', () => {
    // The whole reason it lives on this axis: power and bank are the pair a
    // player needs at the same time, and there is one thumb for both.
    const both = thumbs(CENTRED, dragged(REACH, -REACH))
    expect(both.throttle).toBeGreaterThan(0.5)
    expect(Math.abs(both.roll)).toBeGreaterThan(0.5)
  })

  it('leaves the PAD’s right stick vertical alone, which is where it came from', () => {
    // `control-scheme.test.ts` owns this claim for the pad and warns that
    // binding the axis in one reader and not another is how two devices stop
    // agreeing. This is that divergence, deliberate and pinned: scheme "a" has
    // three axes, a pad has a fourth and a trigger, a touchscreen has neither.
    const pad = withPad(
      Object.assign([0, 0, 0, 0], { [AXIS.rightY]: -FULL_PAD }) as number[],
      [],
      () => readGamepad(OPTS),
    )
    expect(pad.throttle).toBe(0)
  })
})

describe('the chips', () => {
  it('brakes on BRAKE and boosts on BOOST, and neither on neither', () => {
    expect(thumbs(CENTRED, CENTRED, { boost: true, brake: false }).boost).toBe(true)
    expect(thumbs(CENTRED, CENTRED, { boost: false, brake: true }).brake).toBe(true)
    const idle = thumbs(CENTRED)
    expect(idle.boost).toBe(false)
    expect(idle.brake).toBe(false)
    expect(idle.airbrake).toBe(false)
  })

  it('leaves `airbrake` alone, because one chip already covers both', () => {
    // `game/flight.ts:567` is `input.brake = actions.brake || actions.airbrake`
    // and `jumpseat-flight.ts:682` zeroes the pair, so a second chip would be a
    // second button for one effect on a screen the size of a hand. DEV-104.
    const braking = thumbs(CENTRED, CENTRED, { boost: false, brake: true })
    expect(braking.brake).toBe(true)
    expect(braking.airbrake).toBe(false)
  })
})

describe('a drag looks where the other look devices look', () => {
  it('turns RIGHT when the thumb goes right, like the stick and like three.js', () => {
    // `look.ts`: push right -> look RIGHT -> yaw DECREASES, because yaw is a
    // Y-Euler on a camera down −Z. Asserted against the stick AND against the
    // stated convention: agreement alone is what stayed green while the pause
    // menu and the flight stick disagreed about which way was down.
    const stick = withPad(Object.assign([0, 0, 0, 0], { 2: FULL_PAD }) as number[], [], () =>
      readStickLook(1 / 60, LOOK),
    )
    const drag = touchLook(40, 0, LOOK)
    expect(stick.yaw).toBeLessThan(0)
    expect(drag.yaw).toBeLessThan(0)
    expect(touchLook(-40, 0, LOOK).yaw).toBeGreaterThan(0)
  })

  it('looks UP when the thumb goes up, which is the OPPOSITE of the elevator', () => {
    // The distinction Matt drew and DEV-070 is named after: a look and an
    // elevator read the same gesture opposite ways. The same drag that puts the
    // NOSE down puts the VIEW up.
    expect(touchLook(0, -40, LOOK).pitch).toBeGreaterThan(0)
    expect(thumbs(dragged(0, -REACH)).pitch).toBeGreaterThan(0)
    expect(touchLook(0, 40, LOOK).pitch).toBeLessThan(0)
  })

  it('inverts with the same global switch', () => {
    const up = touchLook(0, -40, LOOK)
    const upInverted = touchLook(0, -40, { ...LOOK, invertPitch: true })
    expect(upInverted.pitch).toBeCloseTo(-up.pitch, 12)
    expect(upInverted.yaw).toBeCloseTo(up.yaw, 12)
  })

  it('refuses to look while there is a ship to fly', () => {
    // In a mission the drag IS the flight stick. One gesture with two meanings
    // on one screen is a ship that rolls when you glance left — the same gate
    // `readStickLook` and `readKeyboardLook` are behind.
    expect(touchLook(40, 40, { ...LOOK, flightIdle: false })).toEqual(NO_LOOK)
    expect(readStickLook(1 / 60, { ...LOOK, flightIdle: false })).toEqual(NO_LOOK)
  })

  it('reports a motionless drag as NO_LOOK, negative zero and all', () => {
    // `-0` looks around exactly as well as `0` and compares unequal under
    // `Object.is`, which is what `toEqual` uses. `look.ts`'s `flip` exists for
    // this; so does the guard here.
    expect(touchLook(0, 0, LOOK)).toEqual(NO_LOOK)
    expect(Object.is(touchLook(0, 0, LOOK).yaw, -0)).toBe(false)
    expect(Object.is(touchLook(0, 0, LOOK).pitch, -0)).toBe(false)
  })
})

describe('which half a thumb landed in', () => {
  it('splits down the middle, and the middle belongs to the right', () => {
    expect(zoneFor(0, 800)).toBe('left')
    expect(zoneFor(399, 800)).toBe('left')
    expect(zoneFor(400, 800)).toBe('right')
    expect(zoneFor(800, 800)).toBe('right')
  })
})

/**
 * Run `fn` with a fake `navigator.getGamepads`.
 *
 * `defineProperty`, not assignment: Node exposes `globalThis.navigator` as a
 * getter-only accessor, so `navigator = ...` throws in a module under strict
 * mode. The original descriptor is put back rather than deleted, or the next
 * test in the file gets a global Node did not give it.
 *
 * Duplicated from `control-scheme.test.ts` and `xr-input.test.ts` ON PURPOSE,
 * and that file's own note says why: a shared fixture between files that exist
 * to CHECK each other is one more thing that can be wrong in both at once.
 */
function withPad<T>(axes: number[], buttons: number[], fn: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      getGamepads: () => [
        {
          connected: true,
          mapping: 'standard',
          axes,
          buttons: Array.from({ length: 17 }, (_, i) => ({
            value: buttons[i] ?? 0,
            pressed: (buttons[i] ?? 0) > 0.5,
          })),
        },
      ],
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
