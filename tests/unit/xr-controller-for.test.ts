// tests/unit/xr-controller-for.test.ts: "which gamepad is the left hand's", and
// the `xr-standard` indices every reader names.
//
// Asked four ways before (`xr.ts`, `app.ts`'s bench, `tv-camera-input.ts`, and
// the flat pad's own closures), with different answers when two sources share a
// hand. `controllerFor` is the one answer now and it is exported so it can be
// tested directly.

import { describe, expect, it } from 'vitest'
import { buttonDown, buttonValue } from '@/input/gamepad'
import { controllerFor, XR_AXIS, XR_BUTTON } from '@/input/xr'

const pad = (tag: string, buttons: number[] = []): Gamepad =>
  ({
    id: tag,
    mapping: 'xr-standard',
    axes: [0, 0, 0, 0],
    buttons: buttons.map((v) => ({ value: v, pressed: v > 0.5, touched: false })),
  }) as unknown as Gamepad

const source = (handedness: XRHandedness, gamepad: Gamepad | null): XRInputSource =>
  ({ handedness, gamepad, targetRayMode: 'tracked-pointer' }) as unknown as XRInputSource

const session = (...sources: XRInputSource[]): XRSession =>
  ({ inputSources: sources }) as unknown as XRSession

describe('the xr-standard tables', () => {
  it('match the WebXR Gamepads registry', () => {
    // 0 trigger, 1 squeeze, 2 touchpad, 3 thumbstick, 4 and 5 the face buttons.
    expect(XR_BUTTON).toEqual({ trigger: 0, squeeze: 1, touchpad: 2, stick: 3, lower: 4, upper: 5 })
    // 0,1 touchpad X/Y; 2,3 thumbstick X/Y.
    expect(XR_AXIS).toEqual({ padX: 0, padY: 1, stickX: 2, stickY: 3 })
  })
})

describe('controllerFor', () => {
  it('is null with no session, no sources, or no source on that hand', () => {
    expect(controllerFor(null, 'left')).toBeNull()
    expect(controllerFor(session(), 'left')).toBeNull()
    expect(controllerFor(session(source('right', pad('r'))), 'left')).toBeNull()
  })

  it('skips a source on the hand that has no gamepad', () => {
    const s = session(source('left', null), source('left', pad('second')))
    expect(controllerFor(s, 'left')?.id).toBe('second')
  })

  it('takes the FIRST source with a gamepad when two share a hand', () => {
    // A tracked hand beside a controller is the real case. Flight has always read
    // the first; every reader that answers this question now asks here.
    const s = session(source('left', pad('first')), source('left', pad('second')))
    expect(controllerFor(s, 'left')?.id).toBe('first')
  })

  it('keeps the hands apart', () => {
    const s = session(source('right', pad('r')), source('left', pad('l')))
    expect(controllerFor(s, 'left')?.id).toBe('l')
    expect(controllerFor(s, 'right')?.id).toBe('r')
  })

  it('never answers for a source with no handedness', () => {
    expect(controllerFor(session(source('none', pad('gaze'))), 'left')).toBeNull()
  })
})

describe('buttonDown and buttonValue', () => {
  it('read a button, and read 0 / false for a short array, a missing pad or a missing index', () => {
    const p = pad('p', [0, 0.75, 0, 1])
    expect(buttonValue(p, XR_BUTTON.squeeze)).toBe(0.75)
    expect(buttonDown(p, XR_BUTTON.squeeze)).toBe(true)
    expect(buttonDown(p, XR_BUTTON.trigger)).toBe(false)
    expect(buttonDown(p, XR_BUTTON.stick)).toBe(true)
    // Only buttons[0] is required by the spec: the face buttons may not exist.
    expect(buttonDown(p, XR_BUTTON.lower)).toBe(false)
    expect(buttonValue(p, XR_BUTTON.upper)).toBe(0)
    expect(buttonDown(null, XR_BUTTON.trigger)).toBe(false)
    expect(buttonValue(null, XR_BUTTON.trigger)).toBe(0)
  })
})
