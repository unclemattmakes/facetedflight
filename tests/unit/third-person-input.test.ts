// tests/unit/third-person-input.test.ts — CHANGE VIEW, held against 2016. DEV-128.
//
// DEV-069's lesson, applied to a NEW binding on the day it lands rather than
// four sessions later: the sheet has a key for the scheme, the 2016 source has
// a line for the button, and both are asserted against here. `gamepad.ts`
// binds CHANGE VIEW to X because `Input_Ship.cs:312` reads InControl's
// `Action3` — so the claim is not "X is free", it is "X is what 2016 used, AND
// scheme 'a' leaves it free", and both halves are checked: the first against
// the sheet's letter, the second against `readGamepad` itself.
//
// And the camera pose the Classic toggle draws is the sheet's, so the one
// thing worth measuring about it is GEOMETRY: 2016's `CamRoot_3rdPerson` sits
// behind and above the ship and looks down. Those three facts are true in any
// handedness, and a converted pose that fails any of them is mirrored, flipped
// or backwards — the four-times orientation bug, caught before a screenshot.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, parseSettings } from '@/boot/settings'
import { EYE, HOVERJET_THIRD_PERSON } from '@/game/flight'
import { JUMPSEAT_THIRD_PERSON } from '@/game/jumpseat-flight'
import { FADE, HOVERJET, JUMPSEAT } from '@/generated/constants.generated'
import type { FlightActions } from '@/input/actions'
import { BUTTON, CONTROL_SCHEME, gamepadCameraToggle, readGamepad } from '@/input/gamepad'
import { attachKeyboard } from '@/input/keyboard'
import { controlsRows } from '@/render/controls-menu'

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

describe('the pad button is 2016’s own, and scheme "a" leaves it free', () => {
  it('is written for scheme "a", which is what the shipped prefab says', () => {
    expect(CONTROL_SCHEME).toBe('a')
    expect(HOVERJET.input.controlScheme).toBe('a')
  })

  it('binds X — InControl Action3, Input_Ship.cs:312 — and nothing in FlightActions moves with it', () => {
    expect(BUTTON.x).toBe(2)
    withPad([0, 0, 0, 0], { [BUTTON.x]: 1 }, () => {
      expect(gamepadCameraToggle()).toBe(true)
      flightIsIdle(readGamepad(OPTS))
    })
    withPad([0, 0, 0, 0], {}, () => {
      expect(gamepadCameraToggle()).toBe(false)
    })
  })

  it('does not fire from the buttons 2016 DID bind to flight', () => {
    for (const b of [
      BUTTON.a,
      BUTTON.b,
      BUTTON.l1,
      BUTTON.r1,
      BUTTON.l2,
      BUTTON.r2,
      BUTTON.start,
    ]) {
      withPad([0, 0, 0, 0], { [b]: 1 }, () => {
        expect(gamepadCameraToggle(), `button ${b}`).toBe(false)
      })
    }
  })
})

describe('the keyboard key moves no flight axis', () => {
  it('V toggles the camera and flies nothing', () => {
    const { keyboard, press } = fakeKeyboard()
    try {
      press('KeyV')
      expect(keyboard.toggleCamera).toBe(true)
      flightIsIdle(keyboard.read(1, OPTS))
      expect(keyboard.toggleAutopilot).toBe(false)
      expect(keyboard.pause).toBe(false)
      expect(keyboard.confirm).toBe(false)
    } finally {
      keyboard.dispose()
    }
  })

  it('is not raised by any flight key', () => {
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
      'Space',
    ]) {
      const { keyboard, press } = fakeKeyboard()
      try {
        press(code)
        expect(keyboard.toggleCamera, code).toBe(false)
      } finally {
        keyboard.dispose()
      }
    }
  })
})

describe('the setting persists the way PlayerCameraPref did', () => {
  it('defaults to the seat, as both shipped prefabs do (startInThirdPerson 0)', () => {
    expect(HOVERJET.camera.startInThirdPerson).toBe(false)
    expect(JUMPSEAT.camera.startInThirdPerson).toBe(false)
    expect(DEFAULT_SETTINGS.cameraView).toBe('first')
  })

  it('round-trips third and refuses nonsense', () => {
    expect(parseSettings({ cameraView: 'third' }).cameraView).toBe('third')
    expect(parseSettings({ cameraView: 'sideways' }).cameraView).toBe('first')
  })
})

describe('the controls page names it, and only where it exists', () => {
  it('has a row on the flat page and on a phone, and none in a headset', () => {
    const flat = controlsRows(DEFAULT_SETTINGS, { xr: false, touch: false })
    const touch = controlsRows(DEFAULT_SETTINGS, { xr: false, touch: true })
    const xr = controlsRows(DEFAULT_SETTINGS, { xr: true, touch: false })
    expect(flat.find((r) => r.id === 'view')?.value).toBe('X / V')
    expect(touch.find((r) => r.id === 'view')?.value).toBe('CAM')
    expect(xr.find((r) => r.id === 'view')).toBeUndefined()
  })
})

describe('2016’s rigid camera, converted — geometry, not belief', () => {
  /** Behind, above, looking down: true in any handedness. */
  const behindAboveLookingDown = (
    name: string,
    cam: { position: THREE.Vector3; quaternion: THREE.Quaternion },
  ) => {
    // Three's forward is −z, so BEHIND the ship is +z.
    expect(cam.position.z, `${name} is behind the ship`).toBeGreaterThan(5)
    expect(cam.position.y, `${name} is above the ship`).toBeGreaterThan(1)
    expect(Math.abs(cam.position.x), `${name} is on the centreline`).toBeLessThan(0.01)
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion)
    expect(forward.y, `${name} looks DOWN`).toBeLessThan(-0.05)
    expect(forward.z, `${name} looks forward, along the ship`).toBeLessThan(-0.9)
    // The lens looks at the ship: the ray from the camera along its forward
    // passes within a few metres of the ship origin, which is the one fact a
    // camera aimed the wrong way cannot fake.
    const toShip = cam.position.clone().negate()
    const along = toShip.dot(forward)
    const miss = toShip.clone().sub(forward.clone().multiplyScalar(along)).length()
    expect(along, `${name}: the ship is in front of the lens`).toBeGreaterThan(0)
    expect(miss, `${name}: the ray passes near the ship`).toBeLessThan(2)
  }

  it('the HoverJet: 8.89 m back, 1.73 m up, 10.9° down, off the sheet', () => {
    behindAboveLookingDown('hoverjet', HOVERJET_THIRD_PERSON)
    expect(HOVERJET_THIRD_PERSON.position.z).toBeCloseTo(8.89, 1)
    expect(HOVERJET_THIRD_PERSON.position.y).toBeCloseTo(1.73, 1)
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(HOVERJET_THIRD_PERSON.quaternion)
    expect((Math.asin(-forward.y) * 180) / Math.PI).toBeCloseTo(10.9, 0)
  })

  it('the JumpSeat: its own numbers, not the HoverJet’s', () => {
    behindAboveLookingDown('jumpseat', JUMPSEAT_THIRD_PERSON)
    expect(JUMPSEAT_THIRD_PERSON.position.z).toBeCloseTo(8.32, 1)
    expect(JUMPSEAT_THIRD_PERSON.position.y).toBeCloseTo(2.32, 1)
    expect(
      JUMPSEAT_THIRD_PERSON.position.distanceTo(HOVERJET_THIRD_PERSON.position),
    ).toBeGreaterThan(0.5)
  })

  it('the eye the port has always used IS the sheet’s camTargets[0]', () => {
    // `EYE` was typed from a prefab reading before the extractor walked the
    // camera targets. Now it can be checked against something outside the port.
    const fp = HOVERJET.camera.firstPerson.positionInShipRootSpace
    expect(EYE.x).toBeCloseTo(fp.x, 4)
    expect(EYE.y).toBeCloseTo(fp.y, 4)
    expect(EYE.z).toBeCloseTo(-fp.z, 4)
  })

  it('the switch fade is 2016’s: out 0.12, hold 0.2, in 0.25', () => {
    // `CamChanger.ChangeCam()`'s three runtime overrides, on the sheet so the
    // port reads them rather than remembers them.
    expect(FADE.cameraSwitchOutSeconds).toBeCloseTo(0.12, 6)
    expect(FADE.cameraSwitchHoldSeconds).toBeCloseTo(0.2, 6)
    expect(FADE.cameraSwitchInSeconds).toBeCloseTo(0.25, 6)
    expect(FADE.cameraSwitchInSeconds).toBeGreaterThan(FADE.cameraSwitchOutSeconds)
  })
})

/** A keyboard on a fake target: the three methods `attachKeyboard` touches. */
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

/**
 * Run `fn` with a fake `navigator.getGamepads`. Duplicated from
 * `control-scheme.test.ts` on purpose, for the reason it gives: a shared
 * fixture between two files that exist to check each other is one more thing
 * that can be wrong in both at once.
 */
function withPad<T>(axes: number[], buttons: Record<number, number>, fn: () => T): T {
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
