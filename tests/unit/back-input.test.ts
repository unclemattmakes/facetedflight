// tests/unit/back-input.test.ts: "back", defined once.
//
// `app.ts` composed it four ways (TV, the title's letter plate, the hangar, the
// pause plate), and the pad half read `readGamepad().brake`, which is B only
// because the reader maps B to the brake. The consolidation is a pure refactor,
// so the truth tables of the four old expressions are kept below as the oracle
// and compared with `backPressed` over every combination of sources.

import { describe, expect, it } from 'vitest'
import { BACK_KEYS_ALL, BACK_KEYS_BACKSPACE, type BackSources, backPressed } from '@/input/actions'
import { BUTTON, gamepadBack, readGamepad, setPadsHeld } from '@/input/gamepad'
import { appFileWith, codeOnly } from './helpers/app-source'

describe('app.ts reads back through the one definition', () => {
  // Source, because the frame loop is a closure no unit test can build. Comments
  // are stripped first: a guard that classifies by substring is answered by
  // prose about it (DEV-287).
  const src = (): string => codeOnly(appFileWith('const backSources').text)

  it('does not borrow the flight brake for B', () => {
    expect(src()).not.toMatch(/\bpad\.brake\b/)
  })

  it('builds the sources once and asks `backPressed` at all four screens', () => {
    expect(src().match(/const backSources/g) ?? []).toHaveLength(1)
    expect(src().match(/backPressed\(backSources/g) ?? []).toHaveLength(4)
  })
})

const combos = (): BackSources[] => {
  const out: BackSources[] = []
  for (let m = 0; m < 16; m++) {
    out.push({
      xrBack: (m & 1) !== 0,
      padB: (m & 2) !== 0,
      backspace: (m & 4) !== 0,
      freeEscape: (m & 8) !== 0,
    })
  }
  return out
}

describe('backPressed against the four expressions it replaced', () => {
  it('TV and hangar: B on either controller, Backspace, or a free Escape', () => {
    for (const s of combos()) {
      // app.ts: xr.back || pad.brake || keyboard.pause || (free escape)
      expect(backPressed(s, BACK_KEYS_ALL)).toBe(s.xrBack || s.padB || s.backspace || s.freeEscape)
    }
  })

  it('the title: B on either controller or Backspace, never Escape', () => {
    for (const s of combos()) {
      // app.ts: xr.back || pad.brake || keyboard.pause
      expect(backPressed(s, BACK_KEYS_BACKSPACE)).toBe(s.xrBack || s.padB || s.backspace)
    }
  })

  it('the hangar is the title plus a free Escape, as `titleBack || escape` was', () => {
    for (const s of combos()) {
      const titleBack = backPressed(s, BACK_KEYS_BACKSPACE)
      expect(backPressed(s, BACK_KEYS_ALL)).toBe(titleBack || s.freeEscape)
    }
  })

  it('the pause plate: B on either controller only, because the keys already reach nextPaused', () => {
    for (const s of combos()) {
      // app.ts: xr.back || pad.brake
      expect(backPressed(s)).toBe(s.xrBack || s.padB)
    }
    expect(backPressed({ xrBack: false, padB: false, backspace: true, freeEscape: true })).toBe(
      false,
    )
  })

  it('is false with nothing down', () => {
    expect(
      backPressed(
        { xrBack: false, padB: false, backspace: false, freeEscape: false },
        BACK_KEYS_ALL,
      ),
    ).toBe(false)
  })
})

describe('gamepadBack names the button', () => {
  const withButtons = <T>(pressed: readonly number[], fn: () => T): T => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        getGamepads: () => [
          {
            connected: true,
            mapping: 'standard',
            axes: [0, 0, 0, 0],
            buttons: Array.from({ length: 17 }, (_, i) => ({
              value: pressed.includes(i) ? 1 : 0,
              pressed: pressed.includes(i),
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

  it('is B, the standard mapping index 1, and no other button', () => {
    expect(BUTTON.b).toBe(1)
    for (let i = 0; i < 17; i++) {
      expect(withButtons([i], gamepadBack), `button ${i}`).toBe(i === BUTTON.b)
    }
  })

  it('agrees with what the brake reads today, which is how the menus used to find B', () => {
    // True now and the reason the old code worked; the point of the name is that
    // it stays true of BACK if the brake ever moves (it moved once, DEV-069).
    for (let i = 0; i < 17; i++) {
      expect(withButtons([i], gamepadBack), `button ${i}`).toBe(
        withButtons([i], () => readGamepad({ invertPitch: false }).brake),
      )
    }
  })

  it('reads as unplugged while a screen holds the pads (DEV-566)', () => {
    withButtons([BUTTON.b], () => {
      expect(gamepadBack()).toBe(true)
      setPadsHeld(true)
      try {
        expect(gamepadBack()).toBe(false)
      } finally {
        setPadsHeld(false)
      }
    })
  })

  it('is false with no pad at all', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {
      value: { getGamepads: () => [] },
      configurable: true,
      writable: true,
    })
    try {
      expect(gamepadBack()).toBe(false)
    } finally {
      if (previous) Object.defineProperty(globalThis, 'navigator', previous)
      else Reflect.deleteProperty(globalThis, 'navigator')
    }
  })
})
