// tests/unit/scheme-a.test.ts: the one scheme "a" mapping, held against the sheet.
//
// `gamepad.ts`, `xr.ts` and `touch.ts` each wrote the three stick lines
// (pitch, yaw, roll) themselves, and the tests that guarded them compared one
// device to another (`xr-input.test.ts`, `touch-input.test.ts`) or the pad to
// the sheet (`control-scheme.test.ts`). That is the DEV-069/071 shape: a test
// comparing two of your own devices has tested neither. The mapping now lives
// in `schemeAFlightAxes`; this file holds THAT against the sheet key and against
// `Input_Ship.cs:488-492`, then holds all three devices to it.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOVERJET } from '@/generated/constants.generated'
import { SCHEME_A, schemeAFlightAxes } from '@/input/actions'
import { CONTROL_SCHEME, readGamepad } from '@/input/gamepad'
import { touchActions } from '@/input/touch'
import { readXrInput } from '@/input/xr'
import { REPO } from './helpers/repo-root'

/** `-0` and `0` fly the same; `toEqual` uses `Object.is`, so normalise before comparing. */
const flat = (a: { pitch: number; yaw: number; roll: number }) => ({
  pitch: a.pitch === 0 ? 0 : a.pitch,
  yaw: a.yaw === 0 ? 0 : a.yaw,
  roll: a.roll === 0 ? 0 : a.roll,
})

describe('the mapping is scheme "a", and the sheet says so', () => {
  it('is the letter the shipped prefab carries (hoverjet.input.controlScheme)', () => {
    // If this fails the extractor found another letter on the shipped prefab and
    // the MAPPING has to move (the five schemes are `Input_Ship.cs:486-514`),
    // not this assertion.
    expect(HOVERJET.input.controlScheme).toBe(SCHEME_A)
    expect(CONTROL_SCHEME).toBe(SCHEME_A)
  })

  it('routes each stick axis where Input_Ship.cs:488-492 sends it, and nowhere else', () => {
    //     rollAxis  = device.RightStickX    :490
    //     pitchAxis = device.LeftStickY     :491
    //     yawAxis   = device.LeftStickX     :492
    const moved = (a: ReturnType<typeof schemeAFlightAxes>): string[] =>
      (['pitch', 'yaw', 'roll'] as const).filter((k) => Math.abs(a[k]) > 0.5)
    expect(moved(schemeAFlightAxes(1, 0, 0, false))).toEqual(['yaw'])
    expect(moved(schemeAFlightAxes(0, 1, 0, false))).toEqual(['pitch'])
    expect(moved(schemeAFlightAxes(0, 0, 1, false))).toEqual(['roll'])
  })

  it('has the measured signs: pitch +1 nose DOWN, yaw +1 nose RIGHT, roll +1 banks LEFT', () => {
    // From `sim/autopilot.ts:41-44`, which sampled the integrator. A stick's Y is
    // positive DOWN, so forward (-1) must dive (+pitch).
    expect(schemeAFlightAxes(0, -1, 0, false).pitch).toBe(1)
    expect(schemeAFlightAxes(1, 0, 0, false).yaw).toBe(1)
    // A right-hand deflection banks RIGHT, which is negative roll.
    expect(schemeAFlightAxes(0, 0, 1, false).roll).toBe(-1)
  })

  it('applies the global invert to pitch and to nothing else', () => {
    const on = schemeAFlightAxes(0.3, -0.6, 0.9, true)
    const off = schemeAFlightAxes(0.3, -0.6, 0.9, false)
    expect(on.pitch).toBe(-off.pitch)
    expect(on.yaw).toBe(off.yaw)
    expect(on.roll).toBe(off.roll)
  })
})

describe('every device goes through it', () => {
  // Raw stick values that the pad's dead zones leave exactly at -1, 0 and 1, so
  // "what the mapper says" and "what the device reads" are the same numbers.
  const VALUES = [-1, 0, 1] as const

  const padAxes = (lx: number, ly: number, rx: number): number[] => [lx, ly, rx, 0]

  const readPad = (lx: number, ly: number, rx: number, invertPitch: boolean) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        getGamepads: () => [
          {
            connected: true,
            mapping: 'standard',
            axes: padAxes(lx, ly, rx),
            buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
          },
        ],
      },
      configurable: true,
      writable: true,
    })
    try {
      return readGamepad({ invertPitch })
    } finally {
      if (previous) Object.defineProperty(globalThis, 'navigator', previous)
      else Reflect.deleteProperty(globalThis, 'navigator')
    }
  }

  const hand = (handedness: XRHandedness, x: number, y: number): XRInputSource =>
    ({
      handedness,
      targetRayMode: 'tracked-pointer',
      gamepad: {
        mapping: 'xr-standard',
        axes: [0, 0, x, y],
        buttons: Array.from({ length: 6 }, () => ({ value: 0, pressed: false, touched: false })),
      },
    }) as unknown as XRInputSource

  const readXr = (lx: number, ly: number, rx: number, invertPitch: boolean) =>
    readXrInput(
      { inputSources: [hand('left', lx, ly), hand('right', rx, 0)] } as unknown as XRSession,
      { invertPitch },
    ).actions

  const readTouch = (lx: number, ly: number, rx: number, invertPitch: boolean) =>
    touchActions({ x: lx, y: ly }, { x: rx, y: 0 }, { boost: false, brake: false }, { invertPitch })

  it('the pad, the two XR thumbsticks and the two touch thumbs all read what the mapper says', () => {
    let cases = 0
    for (const lx of VALUES)
      for (const ly of VALUES)
        for (const rx of VALUES)
          for (const invert of [false, true]) {
            const want = flat(schemeAFlightAxes(lx, ly, rx, invert))
            const where = `lx ${lx} ly ${ly} rx ${rx} invert ${invert}`
            expect(flat(readPad(lx, ly, rx, invert)), `pad: ${where}`).toEqual(want)
            expect(flat(readXr(lx, ly, rx, invert)), `xr: ${where}`).toEqual(want)
            expect(flat(readTouch(lx, ly, rx, invert)), `touch: ${where}`).toEqual(want)
            cases++
          }
    expect(cases).toBe(54)
  })

  it('a headset with one hand missing leaves that hand’s axes exactly as noActions had them', () => {
    // Only the right hand: pitch and yaw were never assigned, so they stay `+0`
    // (`Object.is`), not the `-0` a centred stick under the mapper would give.
    const rightOnly = readXrInput({ inputSources: [hand('right', 1, 0)] } as unknown as XRSession, {
      invertPitch: false,
    }).actions
    expect(Object.is(rightOnly.pitch, 0)).toBe(true)
    expect(Object.is(rightOnly.yaw, 0)).toBe(true)
    expect(rightOnly.roll).toBe(-1)
    const leftOnly = readXrInput({ inputSources: [hand('left', 1, -1)] } as unknown as XRSession, {
      invertPitch: false,
    }).actions
    expect(Object.is(leftOnly.roll, 0)).toBe(true)
    expect(leftOnly.yaw).toBe(1)
    expect(leftOnly.pitch).toBe(1)
  })

  it('no reader writes the stick lines itself any more', () => {
    for (const file of ['gamepad.ts', 'xr.ts', 'touch.ts']) {
      const src = readFileSync(path.join(REPO, 'src/input', file), 'utf8')
      expect(src, file).toMatch(/schemeAFlightAxes\(/)
      // The negations the three copies carried.
      expect(src, file).not.toMatch(/out\.roll\s*=\s*-/)
      expect(src, file).not.toMatch(/out\.pitch\s*=\s*applyPitchInvert/)
    }
  })
})
