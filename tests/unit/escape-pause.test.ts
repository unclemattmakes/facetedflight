// tests/unit/escape-pause.test.ts: Escape opens the pause menu in flight. DEV-563.
//
// Escape reaches the game in one of two forms (a captured pointer let go, or a
// key pressed with the pointer free) and must never arrive as both. The rule is
// `input/escape-pause.ts`; the keyboard's half of "never both" is that a press
// which lands while the pointer is captured is not recorded at all.
//
// What a real Chrome does with a player's Escape was measured, not assumed
// (2026-10-01, an OS-level key press into a headed Chrome): captured, the page
// got no keydown and no keyup, only `pointerlockchange`; free, an ordinary
// keydown. A capture asked for ~0.45 s after the release was refused with a
// SecurityError, and one at 2 s was granted.

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { nextPaused, type PauseSignals } from '@/input/escape-pause'
import { attachKeyboard } from '@/input/keyboard'
import { controlsRows } from '@/render/controls-menu'

const NONE: PauseSignals = { toggle: false, escape: false, lostCapture: false }

describe('the rule: a lost capture opens, a free Escape toggles', () => {
  it('opens on a lost capture', () => {
    expect(nextPaused(false, { ...NONE, lostCapture: true })).toBe(true)
  })

  it('does NOT close on a lost capture: the plate is aimed with the captured mouse', () => {
    // A player reading the menu holds the pointer, and Escape while reading it
    // lets go. That must leave them reading it, not drop them into the run.
    expect(nextPaused(true, { ...NONE, lostCapture: true })).toBe(true)
  })

  it('toggles on a free Escape, as Backspace does', () => {
    expect(nextPaused(false, { ...NONE, escape: true })).toBe(true)
    expect(nextPaused(true, { ...NONE, escape: true })).toBe(false)
  })

  it('still toggles on Backspace (2016 binding), unchanged', () => {
    expect(nextPaused(false, { ...NONE, toggle: true })).toBe(true)
    expect(nextPaused(true, { ...NONE, toggle: true })).toBe(false)
  })

  it('takes two toggles in one frame as ONE press, not two that cancel', () => {
    expect(nextPaused(false, { ...NONE, toggle: true, escape: true })).toBe(true)
    expect(nextPaused(true, { ...NONE, toggle: true, escape: true })).toBe(false)
  })

  it('lets a lost capture win a frame it shares with a toggle', () => {
    expect(nextPaused(true, { toggle: true, escape: true, lostCapture: true })).toBe(true)
    expect(nextPaused(false, { toggle: true, escape: false, lostCapture: true })).toBe(true)
  })

  it('with the lookdev panel open, Escape in either form only frees the pointer', () => {
    // Matt, 2026-10-01: freeing the pointer to use the tuning panel must not
    // open the pause menu.
    const lookdev = { ...NONE, escapeFreesOnly: true }
    expect(nextPaused(false, { ...lookdev, lostCapture: true })).toBe(false)
    expect(nextPaused(false, { ...lookdev, escape: true })).toBe(false)
    expect(nextPaused(true, { ...lookdev, escape: true }), 'nor closes').toBe(true)
    // Backspace is still the pause key.
    expect(nextPaused(false, { ...lookdev, toggle: true })).toBe(true)
    expect(nextPaused(false, { ...lookdev, toggle: true, lostCapture: true })).toBe(true)
  })

  it('does nothing on a frame with nothing pressed', () => {
    expect(nextPaused(false, NONE)).toBe(false)
    expect(nextPaused(true, NONE)).toBe(true)
  })
})

describe('the keyboard: Escape counts only while the pointer is free', () => {
  const fakeKeyboard = (captured: { now: boolean }) => {
    const listeners = new Map<string, Set<(e: unknown) => void>>()
    const target = {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        const set = listeners.get(type) ?? new Set()
        set.add(fn)
        listeners.set(type, set)
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners.get(type)?.delete(fn)
      },
    }
    const keyboard = attachKeyboard(target as unknown as EventTarget, () => captured.now)
    const fire = (type: 'keydown' | 'keyup', code: string): void => {
      for (const fn of listeners.get(type) ?? []) fn({ code, preventDefault() {} })
    }
    return { keyboard, fire }
  }

  it('reads Escape pressed with the pointer free, until it is let go', () => {
    const { keyboard, fire } = fakeKeyboard({ now: false })
    expect(keyboard.escape).toBe(false)
    fire('keydown', 'Escape')
    expect(keyboard.escape).toBe(true)
    fire('keyup', 'Escape')
    expect(keyboard.escape).toBe(false)
  })

  it('does not record an Escape that arrives while the pointer is captured', () => {
    // Chrome never delivers one (the release speaks for it). A browser that
    // did would otherwise pause on the key and then again on the release.
    const captured = { now: true }
    const { keyboard, fire } = fakeKeyboard(captured)
    fire('keydown', 'Escape')
    expect(keyboard.escape).toBe(false)
    // Still not down once the capture has gone: the press belonged to it.
    captured.now = false
    expect(keyboard.escape).toBe(false)
  })

  it('is not the pause key, and the pause key is not Escape', () => {
    const { keyboard, fire } = fakeKeyboard({ now: false })
    fire('keydown', 'Escape')
    expect(keyboard.pause).toBe(false)
    fire('keyup', 'Escape')
    fire('keydown', 'Backspace')
    expect(keyboard.pause).toBe(true)
    expect(keyboard.escape).toBe(false)
  })
})

describe('the controls page says so', () => {
  it('names Escape as the pause on the mouse look row, for a keyboard and for a pad', () => {
    for (const ctx of [
      { xr: false, touch: false, keyboard: true },
      { xr: false, touch: false, keyboard: false },
    ]) {
      const look = controlsRows(DEFAULT_SETTINGS, ctx).find((r) => r.id === 'look')
      expect(look?.note).toMatch(/Esc/)
      expect(look?.note).toMatch(/pause/)
    }
  })
})
