// tests/unit/race-lap-input.test.ts — "race this lap", on three devices. DEV-371.
//
// DEV-069's lesson for a new binding on the day it lands: say what it is bound
// to, and prove it moves nothing the flight model sees and fires from nothing
// that flies. R on a keyboard, Y on a standard pad, the right stick's click in
// a headset. The comparison is against `readGamepad` / `read` / `readXrInput`
// themselves, not against another device's binding (CLAUDE.md: a test that
// compares two of your own devices has tested neither).

import { describe, expect, it } from 'vitest'
import type { FlightActions } from '@/input/actions'
import { BUTTON, gamepadRaceLap, gamepadShareLap, readGamepad } from '@/input/gamepad'
import { attachKeyboard } from '@/input/keyboard'
import { readXrInput } from '@/input/xr'

const OPTS = { invertPitch: false }

const flightIsIdle = (a: FlightActions): void => {
  expect(a.pitch).toBeCloseTo(0, 10)
  expect(a.yaw).toBeCloseTo(0, 10)
  expect(a.roll).toBeCloseTo(0, 10)
  expect(a.throttle).toBe(0)
  expect(a.boost).toBe(false)
  expect(a.brake).toBe(false)
  expect(a.airbrake).toBe(false)
}

describe('the keyboard: R', () => {
  it('raises raceLap and flies nothing, and nothing else raises it', () => {
    const { keyboard, press } = fakeKeyboard()
    try {
      press('KeyR')
      expect(keyboard.raceLap).toBe(true)
      flightIsIdle(keyboard.read(1, OPTS))
      expect(keyboard.confirm).toBe(false)
      expect(keyboard.pause).toBe(false)
      expect(keyboard.toggleAutopilot).toBe(false)
      expect(keyboard.toggleCamera).toBe(false)
    } finally {
      keyboard.dispose()
    }
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyZ', 'KeyX', 'KeyC']) {
      const k = fakeKeyboard()
      try {
        k.press(code)
        expect(k.keyboard.raceLap, code).toBe(false)
      } finally {
        k.keyboard.dispose()
      }
    }
  })
})

describe('a standard pad: Y', () => {
  it('is index 3, raises raceLap and flies nothing', () => {
    expect(BUTTON.y).toBe(3)
    withPad({ [BUTTON.y]: 1 }, () => {
      expect(gamepadRaceLap()).toBe(true)
      flightIsIdle(readGamepad(OPTS))
    })
  })

  it('does not fire from any button the game already reads', () => {
    for (const b of [
      BUTTON.a,
      BUTTON.b,
      BUTTON.x,
      BUTTON.l1,
      BUTTON.r1,
      BUTTON.l2,
      BUTTON.r2,
      BUTTON.start,
    ]) {
      withPad({ [b]: 1 }, () => expect(gamepadRaceLap(), `button ${b}`).toBe(false))
    }
  })
})

describe('a headset: the right stick clicked', () => {
  const hand = (handedness: XRHandedness, buttons: Record<number, number>): XRInputSource =>
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
  const read = (left: Record<number, number>, right: Record<number, number>) =>
    readXrInput(
      { inputSources: [hand('left', left), hand('right', right)] } as unknown as XRSession,
      OPTS,
    )

  it('raises raceLap and flies nothing', () => {
    const r = read({}, { 3: 1 })
    expect(r.raceLap).toBe(true)
    flightIsIdle(r.actions)
    expect(r.confirm).toBe(false)
    expect(r.back).toBe(false)
    expect(r.pause).toBe(false)
    expect(r.recenter).toBe(false)
  })

  it('is not the LEFT stick, which recentres, nor any face button, trigger or grip', () => {
    expect(read({ 3: 1 }, {}).raceLap).toBe(false)
    for (const i of [0, 1, 2, 4, 5]) {
      expect(read({}, { [i]: 1 }).raceLap, `right ${i}`).toBe(false)
      expect(read({ [i]: 1 }, {}).raceLap, `left ${i}`).toBe(false)
    }
  })
})

// ── DEV-373: "share this lap", on the same three devices ─────────────────
//
// G on a keyboard, SELECT (index 8) on a standard pad, and the LEFT stick's
// click in a headset — but not while the stick is also held down, which is the
// recentre (`dpadDown`). Each moves nothing the flight model sees, and none of
// them is a press the game already reads.

describe('share this lap: the keyboard, G', () => {
  it('raises shareLap and flies nothing, and no flight key raises it', () => {
    const { keyboard, press } = fakeKeyboard()
    try {
      press('KeyG')
      expect(keyboard.shareLap).toBe(true)
      expect(keyboard.raceLap).toBe(false)
      flightIsIdle(keyboard.read(1, OPTS))
      expect(keyboard.confirm).toBe(false)
      expect(keyboard.pause).toBe(false)
    } finally {
      keyboard.dispose()
    }
    for (const code of [
      'KeyW',
      'KeyA',
      'KeyS',
      'KeyD',
      'KeyQ',
      'KeyE',
      'KeyZ',
      'KeyX',
      'KeyC',
      'KeyR',
    ]) {
      const k = fakeKeyboard()
      try {
        k.press(code)
        expect(k.keyboard.shareLap, code).toBe(false)
      } finally {
        k.keyboard.dispose()
      }
    }
  })
})

describe('share this lap: a standard pad, SELECT', () => {
  it('is index 8, raises shareLap and flies nothing', () => {
    expect(BUTTON.select).toBe(8)
    withPad({ [BUTTON.select]: 1 }, () => {
      expect(gamepadShareLap()).toBe(true)
      expect(gamepadRaceLap()).toBe(false)
      flightIsIdle(readGamepad(OPTS))
    })
  })

  it('does not fire from any button the game already reads', () => {
    for (const b of [
      BUTTON.a,
      BUTTON.b,
      BUTTON.x,
      BUTTON.y,
      BUTTON.l1,
      BUTTON.r1,
      BUTTON.l2,
      BUTTON.r2,
      BUTTON.start,
    ]) {
      withPad({ [b]: 1 }, () => expect(gamepadShareLap(), `button ${b}`).toBe(false))
    }
  })
})

describe('share this lap: a headset, the LEFT stick clicked', () => {
  const hand = (
    handedness: XRHandedness,
    buttons: Record<number, number>,
    stickY = 0,
  ): XRInputSource =>
    ({
      handedness,
      targetRayMode: 'tracked-pointer',
      gamepad: {
        mapping: 'xr-standard',
        axes: [0, 0, 0, stickY],
        buttons: Array.from({ length: 6 }, (_, i) => ({
          value: buttons[i] ?? 0,
          pressed: (buttons[i] ?? 0) > 0.5,
          touched: false,
        })),
      },
    }) as unknown as XRInputSource
  const read = (left: Record<number, number>, right: Record<number, number>, leftY = 0) =>
    readXrInput(
      {
        inputSources: [hand('left', left, leftY), hand('right', right)],
      } as unknown as XRSession,
      OPTS,
    )

  it('raises shareLap, and nothing else a press reads', () => {
    const r = read({ 3: 1 }, {})
    expect(r.shareLap).toBe(true)
    expect(r.raceLap).toBe(false)
    expect(r.recenter).toBe(false)
    expect(r.confirm).toBe(false)
    expect(r.pause).toBe(false)
  })

  it('is NOT the recentre: clicked with the stick held down it is the recentre alone', () => {
    const r = read({ 3: 1 }, {}, 0.9)
    expect(r.recenter).toBe(true)
    expect(r.shareLap).toBe(false)
  })

  it('is not the right stick, which races this lap, nor any face button, trigger or grip', () => {
    expect(read({}, { 3: 1 }).shareLap).toBe(false)
    for (const i of [0, 1, 2, 4, 5]) {
      expect(read({}, { [i]: 1 }).shareLap, `right ${i}`).toBe(false)
      expect(read({ [i]: 1 }, {}).shareLap, `left ${i}`).toBe(false)
    }
  })
})

function fakeKeyboard() {
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
  const press = (code: string): void => {
    for (const fn of listeners.get('keydown') ?? []) fn({ code, preventDefault() {} })
  }
  return { keyboard, press }
}

/** A fake `navigator.getGamepads` holding one standard pad, sticks at rest. */
function withPad<T>(buttons: Record<number, number>, fn: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      getGamepads: () => [
        {
          connected: true,
          mapping: 'standard',
          axes: [0, 0, 0, 0],
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
