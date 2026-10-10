// IA-9: one definition of "this key is aimed at a text field", for the TV
// camera, the TV controls, the room-code plate and the editor's panels.

import { describe, expect, it } from 'vitest'
import { isolateTextEntryKeys, isTextEntry } from '@/input/text-entry'

class Fake extends EventTarget {
  constructor(
    readonly tagName: string,
    readonly isContentEditable = false,
  ) {
    super()
  }
}

describe('isTextEntry', () => {
  it('is the union of the two definitions the repo used to hold', () => {
    // The editor's: INPUT, SELECT, TEXTAREA. The TV's: INPUT, TEXTAREA, contentEditable.
    for (const tag of ['INPUT', 'SELECT', 'TEXTAREA'])
      expect(isTextEntry({ tagName: tag })).toBe(true)
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('is false for everything else, including no target', () => {
    expect(isTextEntry(null)).toBe(false)
    expect(isTextEntry(undefined)).toBe(false)
    expect(isTextEntry({})).toBe(false)
    expect(isTextEntry({ tagName: 'BUTTON' })).toBe(false)
    expect(isTextEntry({ tagName: 'CANVAS', isContentEditable: false })).toBe(false)
    expect(isTextEntry(globalThis)).toBe(false)
  })
})

describe('isolateTextEntryKeys', () => {
  const press = (target: Fake, type: 'keydown' | 'keyup'): boolean => {
    const e = new Event(type)
    target.dispatchEvent(e)
    return e.cancelBubble
  }

  it('stops keydown and keyup aimed at a field, and only those', () => {
    const field = new Fake('INPUT')
    const button = new Fake('BUTTON')
    isolateTextEntryKeys(field)
    isolateTextEntryKeys(button)
    expect(press(field, 'keydown')).toBe(true)
    expect(press(field, 'keyup')).toBe(true)
    expect(press(button, 'keydown')).toBe(false)
    expect(press(button, 'keyup')).toBe(false)
  })
})
