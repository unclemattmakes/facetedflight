import { afterEach, describe, expect, it } from 'vitest'
import {
  beginPadFrame,
  endPadFrames,
  gamepadBack,
  gamepadConfirm,
  gamepadPause,
} from '@/input/gamepad'

// DEV-942: the browser is asked for the pads once per frame, however many
// helpers read them, and once per call when no frame has begun.
describe('one getGamepads() per frame', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  afterEach(() => {
    endPadFrames()
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
  })
  const install = () => {
    const calls = { n: 0 }
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        getGamepads: () => {
          calls.n += 1
          return [{ connected: true, mapping: 'standard', axes: [], buttons: [] }]
        },
      },
      configurable: true,
      writable: true,
    })
    return calls
  }

  it('asks once for ten reads inside a frame, again after the next begin', () => {
    const calls = install()
    beginPadFrame()
    for (let i = 0; i < 5; i++) {
      gamepadBack()
      gamepadConfirm()
    }
    expect(calls.n).toBe(1)
    beginPadFrame()
    gamepadPause()
    expect(calls.n).toBe(2)
  })

  it('asks every call when no frame has begun', () => {
    const calls = install()
    gamepadBack()
    gamepadConfirm()
    expect(calls.n).toBe(2)
  })
})
