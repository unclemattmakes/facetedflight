// tests/unit/control-scheme.test.ts — the pad mapping, held against the sheet.
//
// ── The bug this file is the answer to ───────────────────────────────────
//
// The port flew for four sessions on a control scheme that exists in no version
// of this game. `gamepad.ts` and `xr.ts` both called it *scheme "a"*; the
// constants sheet has carried `hoverjet.input.controlScheme: "a"` — extracted,
// `trust: verified`, off `PlayerShip_SR14_Photon.prefab#11400186` — the whole
// time, and `Input_Ship.cs:484-515` says what the letter means. Nobody put the
// two together until Matt flew it flat with a PS5 pad and called it unplayable.
//
// Four hundred green tests had nothing to say, because **every one of them
// tested the mapping against itself**: `xr-input.test.ts` asserts VR and flat
// agree, which is a true and useful claim that stays true when both are wrong.
// The missing assertion was against something OUTSIDE the port.
//
// So: this file compares the reader to the sheet, and to the `Input_Ship.cs`
// lines the sheet points at. It is the same shape as trap 24 — *"a test that
// re-derives its expectation the way the code does has not tested the code"* —
// and the thing outside the code here is 2016.

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { type FlightActions, MENU_NUDGE_DEADBAND, menuNudge } from '@/input/actions'
import { AXIS, BUTTON, CONTROL_SCHEME, readGamepad } from '@/input/gamepad'
import { attachKeyboard } from '@/input/keyboard'
import { controlsRows, TOUCH_PAD_HINT } from '@/render/controls-menu'

const OPTS = { invertPitch: false }

/** Read the pad with exactly one axis pushed, everything else centred. */
const withAxis = (index: number, value: number): FlightActions =>
  withPad(Object.assign([0, 0, 0, 0], { [index]: value }) as number[], [], () => readGamepad(OPTS))

/** Read the pad with exactly one button held. */
const withButton = (index: number, value = 1): FlightActions =>
  withPad([0, 0, 0, 0], Object.assign(Array(10).fill(0), { [index]: value }), () =>
    readGamepad(OPTS),
  )

/** A deflection well past `DEAD_ZONE_LOWER`, so the shaping cannot swallow it. */
const FULL = 0.95

describe('the scheme is the one the shipped prefab names', () => {
  it('is "a", and this file is written for "a"', () => {
    // If this ever fails, the extractor found a different letter on the shipped
    // prefab and the MAPPING has to move, not this assertion. The five schemes
    // are `Input_Ship.cs:486-514`.
    expect(CONTROL_SCHEME).toBe('a')
  })

  it('routes each stick axis where Input_Ship.cs:488-492 sends it', () => {
    // Scheme "a", transcribed:
    //     rollAxis  = device.RightStickX    :490
    //     pitchAxis = device.LeftStickY     :491
    //     yawAxis   = device.LeftStickX     :492
    //
    // Asserted as "push one axis, exactly one action moves". That is a
    // STRUCTURAL claim — it is true whichever sign convention the body frame
    // turns out to have — and it is the one the broken mapping failed: it put
    // pitch and yaw on two different sticks' verticals and left `LeftStickX`,
    // the yaw axis 2016 ships, doing nothing at all.
    const routes: ReadonlyArray<[number, keyof FlightActions]> = [
      [AXIS.leftX, 'yaw'],
      [AXIS.leftY, 'pitch'],
      [AXIS.rightX, 'roll'],
    ]
    for (const [axis, action] of routes) {
      const out = withAxis(axis, FULL)
      expect(Math.abs(out[action] as number), `axis ${axis} -> ${action}`).toBeGreaterThan(0.5)
      for (const other of ['pitch', 'yaw', 'roll'] as const) {
        if (other === action) continue
        expect(Math.abs(out[other]), `axis ${axis} must not touch ${other}`).toBeCloseTo(0, 10)
      }
    }
  })

  it('leaves the right stick’s VERTICAL unbound, because scheme "a" has three axes', () => {
    // Not an oversight and not a spare slot to fill: a pad has four axes and
    // 2016's scheme uses three. Binding this one here and not in `xr.ts` is how
    // VR and flat stop agreeing.
    const out = withAxis(AXIS.rightY, FULL)
    expect(Math.abs(out.pitch)).toBeCloseTo(0, 10)
    expect(Math.abs(out.yaw)).toBeCloseTo(0, 10)
    expect(Math.abs(out.roll)).toBeCloseTo(0, 10)
  })
})

describe('the signs, against the measured body frame', () => {
  // `sim/autopilot.ts:41-44` sampled the integrator rather than arguing about
  // handedness, and got:
  //     pitch +1 -> nose DOWN     yaw +1 -> nose RIGHT     roll +1 -> banks LEFT
  // Everything below is that table plus "a pad's Y is positive DOWN".

  it('pushes the nose DOWN when the left stick goes forward', () => {
    // The arcade default, and `invertPitch: false` has to mean it or the
    // setting is named backwards. Forward on a pad is NEGATIVE Y.
    expect(withAxis(AXIS.leftY, -FULL).pitch).toBeGreaterThan(0)
    expect(withAxis(AXIS.leftY, FULL).pitch).toBeLessThan(0)
  })

  it('flips exactly that, and only that, when invert pitch is on', () => {
    const push = Object.assign([0, 0, 0, 0], { [AXIS.leftY]: -FULL }) as number[]
    const normal = withPad(push, [], () => readGamepad({ invertPitch: false }))
    const inverted = withPad(push, [], () => readGamepad({ invertPitch: true }))
    expect(inverted.pitch).toBeCloseTo(-normal.pitch, 10)
    // The other two axes are NOT a "Y axis" and must not move with the switch.
    const turn = Object.assign([0, 0, 0, 0], {
      [AXIS.leftX]: FULL,
      [AXIS.rightX]: FULL,
    }) as number[]
    const yesInvert = withPad(turn, [], () => readGamepad({ invertPitch: true }))
    const noInvert = withPad(turn, [], () => readGamepad({ invertPitch: false }))
    // Per axis rather than `toEqual`: the invert turns a centred pitch into -0,
    // and `Object.is(-0, 0)` is false. -0 flies exactly like 0.
    expect(yesInvert.yaw).toBeCloseTo(noInvert.yaw, 10)
    expect(yesInvert.roll).toBeCloseTo(noInvert.roll, 10)
  })

  it('turns the nose RIGHT for a left stick pushed right', () => {
    expect(withAxis(AXIS.leftX, FULL).yaw).toBeGreaterThan(0)
  })

  it('banks RIGHT for a right stick pushed right', () => {
    // +roll banks LEFT, so a right-hand deflection has to come out negative.
    expect(withAxis(AXIS.rightX, FULL).roll).toBeLessThan(0)
  })

  it('defaults invert pitch OFF, as the shipped HoverJet prefab does', () => {
    // `hoverjet.input.invertPitch` is 0. The JumpSeat prefab says 1, which is
    // exactly why D16 exists: it is per-instance state, not a vehicle constant,
    // and the shipped behaviour is the global `InputManager.InvertYAxis`.
    expect(DEFAULT_SETTINGS.invertPitch).toBe(false)
  })
})

describe('the buttons, against Input_Ship.cs', () => {
  it('throttles on the right trigger and keeps it ANALOGUE (:406)', () => {
    expect(withButton(BUTTON.r2, 0.4).throttle).toBeCloseTo(0.4, 6)
  })

  it('boosts on the LEFT trigger (:426), which is the thing nobody could find', () => {
    expect(withButton(BUTTON.l2).boost).toBe(true)
    // 2016's own release threshold, :435. A resting finger is not a boost.
    expect(withButton(BUTTON.l2, 0.05).boost).toBe(false)
    // The alternate. It is what this port bound before, and taking a working
    // button away is not a fix.
    expect(withButton(BUTTON.r1).boost).toBe(true)
  })

  it('brakes on B — InControl’s Action2 (:444) — and airbrakes on L1', () => {
    expect(withButton(BUTTON.b).brake).toBe(true)
    expect(withButton(BUTTON.l1).airbrake).toBe(true)
    // The left trigger is the boost now. A brake still on it would mean the two
    // fight every time the throttle and boost are held together.
    expect(withButton(BUTTON.l2).brake).toBe(false)
  })

  it('keeps A and Start out of FlightActions entirely', () => {
    // Launch and pause are not control surfaces the flight model may see, and
    // both are held down across many frames.
    for (const b of [BUTTON.a, BUTTON.start]) {
      const out = withButton(b)
      expect(out.throttle, `button ${b}`).toBe(0)
      expect(out.boost, `button ${b}`).toBe(false)
      expect(out.brake, `button ${b}`).toBe(false)
      expect(out.airbrake, `button ${b}`).toBe(false)
    }
  })
})

describe('the paused menu steps the same way on every device', () => {
  // The third instance of one bug, and the one that hid longest. The pause
  // menu is picked by GAZE, and on a flat screen the gaze is the frozen ship's
  // forward — so the pitch axis moves the selection instead. Its sign said
  // "down the list is POSITIVE pitch", which was true of ArrowDown and false of
  // a pad, because the pad's reader negates its axis: pulling the stick BACK
  // moved the selection UP for the whole life of the port.
  //
  // Nothing caught it because the only thing that drives this menu without a
  // human is a Playwright keyboard.

  it('goes DOWN the list for a stick pulled back', () => {
    expect(menuNudge(withAxis(AXIS.leftY, FULL).pitch, false)).toBe(1)
  })

  it('goes UP the list for a stick pushed forward', () => {
    expect(menuNudge(withAxis(AXIS.leftY, -FULL).pitch, false)).toBe(-1)
  })

  it('agrees with ArrowDown and ArrowUp, which is the assertion that was missing', () => {
    expect(menuNudge(heldKeys(['ArrowDown'], { invertPitch: false }).pitch, false)).toBe(1)
    expect(menuNudge(heldKeys(['ArrowUp'], { invertPitch: false }).pitch, false)).toBe(-1)
  })

  it('does NOT scroll backwards for a player who flies inverted', () => {
    // `invertPitch` is a flight preference. Nobody who flies pull-back-to-climb
    // asked for a menu that reads their stick upside down, and this axis is
    // only borrowed here in the first place.
    const backInverted = withPad(
      Object.assign([0, 0, 0, 0], { [AXIS.leftY]: FULL }) as number[],
      [],
      () => readGamepad({ invertPitch: true }),
    ).pitch
    expect(menuNudge(backInverted, true), 'stick back still goes down').toBe(1)
    expect(menuNudge(heldKeys(['ArrowDown'], { invertPitch: true }).pitch, true)).toBe(1)
  })

  it('sits still inside the deadband, so a resting thumb does not walk the list', () => {
    expect(menuNudge(0, false)).toBe(0)
    expect(menuNudge(MENU_NUDGE_DEADBAND, false)).toBe(0)
    expect(menuNudge(-MENU_NUDGE_DEADBAND, false)).toBe(0)
  })
})

describe('the controls page tells the truth', () => {
  // A controls page is the one document in this game that a person checks
  // within seconds of it being wrong — and it is the only reason the boost is
  // findable at all. If a binding moves and the page does not, the page becomes
  // a thing you consult, disbelieve, and stop consulting.
  const rows = controlsRows(DEFAULT_SETTINGS, { xr: false, touch: false })
  const bindingFor = (id: string) => rows.find((r) => r.id === id)?.value

  it('names a button for boost that actually boosts', () => {
    expect(bindingFor('boost')).toBe('L2')
    expect(withButton(BUTTON.l2).boost).toBe(true)
  })

  it('names a button for the throttle and the airbrake that actually work', () => {
    expect(bindingFor('throttle')).toBe('R2')
    expect(withButton(BUTTON.r2, 1).throttle).toBe(1)
    expect(bindingFor('slow')).toBe('L1')
    expect(withButton(BUTTON.l1).airbrake).toBe(true)
  })

  it('names the right stick for roll and the left for everything else', () => {
    expect(bindingFor('fly')).toBe('left stick')
    expect(bindingFor('roll')).toBe('right stick')
    expect(Math.abs(withAxis(AXIS.rightX, FULL).roll)).toBeGreaterThan(0.5)
    expect(Math.abs(withAxis(AXIS.leftX, FULL).yaw)).toBeGreaterThan(0.5)
    expect(Math.abs(withAxis(AXIS.leftY, FULL).pitch)).toBeGreaterThan(0.5)
  })

  it('says which way invert pitch currently points, not just that it is off', () => {
    // "On" alone leaves you pressing it twice to find out where you started.
    const off = controlsRows(
      { ...DEFAULT_SETTINGS, invertPitch: false },
      { xr: false, touch: false },
    )
    const on = controlsRows({ ...DEFAULT_SETTINGS, invertPitch: true }, { xr: false, touch: false })
    // DEV-377: the gesture that CLIMBS, both ways round. This pinned "dive" for
    // off and "climb" for on — and the "on" note was "pull back to climb",
    // which is the default's gesture: with the invert on, pulling back dives
    // (`pitchWords`; `xr-input.test.ts` measures the default). The notes must
    // differ, and each must be true.
    expect(off.find((r) => r.id === 'invert')?.note).toBe('left stick back to climb')
    expect(on.find((r) => r.id === 'invert')?.note).toBe('left stick forward to climb')
  })

  it('names Touch hardware in a headset and pad hardware out of one', () => {
    // `L2` means nothing on a Touch controller, and `mouse` means nothing at all.
    const xr = controlsRows(DEFAULT_SETTINGS, { xr: true, touch: false })
    expect(xr.find((r) => r.id === 'boost')?.value).toBe('left trigger')
    expect(xr.find((r) => r.id === 'look')?.value).not.toBe('mouse')
  })
})

describe('the keyboard agrees with the pad, gesture for gesture', () => {
  // ── The bug this block is the answer to ─────────────────────────────────
  //
  // W pitched the nose UP and D banked LEFT, while a pad stick pushed forward
  // dived and a stick pushed right banked right. Two of the three axes, wrong,
  // for the whole life of the port — and `keyboard.ts` named them for the KEY
  // (`pitchDown: ['ArrowUp', 'KeyW']`) rather than for what the ship did, so
  // the names read correct while the arithmetic under them was not.
  //
  // Nothing caught it because **no test compared the two devices**.
  // `xr-input.test.ts` compares VR to the pad, exhaustively; the keyboard was
  // compared to nothing, so it was perfectly self-consistent and disagreed with
  // everything else. That is the same shape as the control-scheme bug above:
  // consistent with itself, never checked against anything outside.
  //
  // It has to be right for `invertPitch` to be a real option at all: one switch
  // for the whole game (D16), and a switch that corrects one device while
  // breaking another is a second bug with a menu row on it.

  const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0)

  /** The same physical intention, expressed on each device. */
  const GESTURES: ReadonlyArray<{
    name: string
    axis: number
    value: number
    keys: string[]
    action: 'pitch' | 'yaw' | 'roll'
  }> = [
    { name: 'stick forward / W', axis: AXIS.leftY, value: -FULL, keys: ['KeyW'], action: 'pitch' },
    { name: 'stick back / S', axis: AXIS.leftY, value: FULL, keys: ['KeyS'], action: 'pitch' },
    { name: 'stick right / E', axis: AXIS.leftX, value: FULL, keys: ['KeyE'], action: 'yaw' },
    { name: 'stick left / Q', axis: AXIS.leftX, value: -FULL, keys: ['KeyQ'], action: 'yaw' },
    { name: 'bank right / D', axis: AXIS.rightX, value: FULL, keys: ['KeyD'], action: 'roll' },
    { name: 'bank left / A', axis: AXIS.rightX, value: -FULL, keys: ['KeyA'], action: 'roll' },
  ]

  for (const g of GESTURES) {
    it(`sends ${g.name} the same way`, () => {
      const onPad = withAxis(g.axis, g.value)
      const onKeys = heldKeys(g.keys, { invertPitch: false })
      expect(sign(onKeys[g.action]), g.name).toBe(sign(onPad[g.action]))
      // And it actually moved, or two zeroes would agree about nothing.
      expect(Math.abs(onPad[g.action])).toBeGreaterThan(0.5)
      expect(Math.abs(onKeys[g.action])).toBeGreaterThan(0.5)
    })
  }

  it('arrows and letters mean the same thing', () => {
    // Both are bound, and half a fix would leave the arrows on the old
    // convention — which is exactly how this survived: the names looked fine.
    const wasd = heldKeys(['KeyW', 'KeyD'], { invertPitch: false })
    const arrows = heldKeys(['ArrowUp', 'ArrowRight'], { invertPitch: false })
    expect(arrows.pitch).toBeCloseTo(wasd.pitch, 10)
    expect(arrows.roll).toBeCloseTo(wasd.roll, 10)
  })

  it('inverts the keyboard and the pad TOGETHER, which is the point of one switch', () => {
    const padNormal = withAxis(AXIS.leftY, -FULL).pitch
    const padInverted = withPad(
      Object.assign([0, 0, 0, 0], { [AXIS.leftY]: -FULL }) as number[],
      [],
      () => readGamepad({ invertPitch: true }),
    ).pitch
    const keyNormal = heldKeys(['KeyW'], { invertPitch: false }).pitch
    const keyInverted = heldKeys(['KeyW'], { invertPitch: true }).pitch
    expect(sign(padInverted)).toBe(-sign(padNormal))
    expect(sign(keyInverted)).toBe(-sign(keyNormal))
    // The claim that matters: after the switch they STILL agree.
    expect(sign(keyInverted)).toBe(sign(padInverted))
  })
})

/**
 * Hold `codes` on a fresh keyboard and read one full-deflection frame.
 *
 * `read(1, ...)` rather than a frame's worth: the axes ramp over ~180 ms
 * (`keyboard.ts` says why), and a 16 ms sample would compare two devices at
 * one-eleventh deflection, where a sign is still a sign but a threshold is not.
 *
 * `tests/unit` is `environment: 'node'` — no DOM — so the target is the three
 * methods `attachKeyboard` touches.
 */
function heldKeys(codes: string[], opts: { invertPitch: boolean }): FlightActions {
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  const target = {
    addEventListener(type: string, fn: (e: unknown) => void) {
      const set = listeners.get(type) ?? new Set()
      set.add(fn)
      listeners.set(type, set)
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn)
    },
  }
  const keyboard = attachKeyboard(target as unknown as EventTarget)
  try {
    for (const code of codes) {
      for (const fn of listeners.get('keydown') ?? []) fn({ code, preventDefault() {} })
    }
    return keyboard.read(1, opts)
  } finally {
    keyboard.dispose()
  }
}

/**
 * Run `fn` with a fake `navigator.getGamepads`.
 *
 * `defineProperty`, not assignment: Node exposes `globalThis.navigator` as a
 * getter-only accessor, so `navigator = ...` throws in a module under strict
 * mode. The original descriptor is put back rather than deleted, or the next
 * test in the file gets a global Node did not give it. Same helper as
 * `xr-input.test.ts`'s, and it stays duplicated on purpose: a shared fixture
 * between two files that exist to CHECK each other is one more thing that can
 * be wrong in both at once.
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

describe('the phone pad line names the controls the Controls page names (DEV-890)', () => {
  const rows = controlsRows(DEFAULT_SETTINGS, { xr: false, touch: true })
  const value = (id: string) => rows.find((r) => r.id === id)?.value ?? ''

  it('says the throttle thumb and the steering thumb the page says', () => {
    // 'right thumb, up' / 'left thumb': the hint is those words in a sentence.
    const throttle = value('throttle').split(',')[0] ?? ''
    expect(throttle).not.toBe('')
    expect(TOUCH_PAD_HINT.toLowerCase()).toContain(throttle)
    expect(TOUCH_PAD_HINT.toLowerCase()).toContain(value('fly'))
  })
})
