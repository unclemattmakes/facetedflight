// tests/unit/bench-hand-pad.test.ts: DEV-735, the bench reads the controller flight reads.
//
// `input/xr.ts` answered "which gamepad is the left hand's" with the FIRST input
// source on that hand that has one. `boot/app.ts`'s `benchHands` (the editor
// bench's buttons) asked the same question with its own loop that kept the LAST
// one. With one source per hand they agree, which is every test and every
// controller anyone has worn; with two sources on a hand (a tracked hand beside a
// controller) the bench read a different pad from the ship, so a button could
// work in flight and not on the bench, or the other way round.
//
// The loop is inside the app's closure, so the behaviour is asserted on the one
// function both now call, and the wiring is asserted on the source (comments
// stripped, because a guard that classifies by substring is answered by prose
// about it).

import { describe, expect, it } from 'vitest'
import { controllerFor, readXrInput } from '@/input/xr'
import { appFileWith, codeOnly } from './helpers/app-source'

const pad = (tag: string, buttons: Record<number, number> = {}): Gamepad =>
  ({
    id: tag,
    mapping: 'xr-standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 6 }, (_, i) => ({
      value: buttons[i] ?? 0,
      pressed: (buttons[i] ?? 0) > 0.5,
      touched: false,
    })),
  }) as unknown as Gamepad

const source = (handedness: XRHandedness, gamepad: Gamepad): XRInputSource =>
  ({ handedness, gamepad, targetRayMode: 'tracked-pointer' }) as unknown as XRInputSource

describe('two sources on one hand: flight and the bench ask the same function', () => {
  // The right hand: a tracked hand first (nothing pressed), a controller second
  // with A (`lower`, index 4) held.
  const session = {
    inputSources: [source('right', pad('hand')), source('right', pad('controller', { 4: 1 }))],
  } as unknown as XRSession

  it('flight reads the FIRST source: A on the second is not a confirm', () => {
    expect(readXrInput(session, { invertPitch: false }).confirm).toBe(false)
  })

  it('and controllerFor, which the bench now uses, hands back that same first pad', () => {
    expect(controllerFor(session, 'right')?.id).toBe('hand')
  })
})

describe('app.ts: benchHands asks controllerFor and keeps no loop of its own', () => {
  const body = (): string => {
    const src = codeOnly(appFileWith('const benchHands').text)
    const open = src.indexOf('const benchHands')
    expect(open, 'benchHands').toBeGreaterThan(-1)
    return src.slice(open, src.indexOf('return out', open))
  }

  it('calls controllerFor for each hand', () => {
    expect(body()).toMatch(/controllerFor\(\s*session,\s*hand\s*\)/)
  })

  it('does not walk inputSources itself', () => {
    expect(body()).not.toMatch(/inputSources/)
  })
})
