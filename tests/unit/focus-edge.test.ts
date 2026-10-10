// tests/unit/focus-edge.test.ts: menus that click (DEV-646).

import { describe, expect, it } from 'vitest'
import { actionsForEvent } from '@/audio/events'
import { createFocusEdge } from '@/input/focus-edge'

describe('a click on a CHANGE of row', () => {
  it('is silent on the first aim (the menu arriving) and on a held aim', () => {
    const edge = createFocusEdge()
    expect(edge.step(0)).toBe(false)
    for (let i = 0; i < 100; i++) expect(edge.step(0)).toBe(false)
  })

  it('clicks once per move, in either direction', () => {
    const edge = createFocusEdge()
    edge.step(1)
    expect(edge.step(2)).toBe(true)
    expect(edge.step(2)).toBe(false)
    expect(edge.step(1)).toBe(true)
    expect(edge.step(0)).toBe(true)
  })

  it('a menu going away forgets, so reopening on another row is not a click', () => {
    const edge = createFocusEdge()
    edge.step(3)
    expect(edge.step(null)).toBe(false)
    expect(edge.step(0)).toBe(false)
  })

  it('works for string keys too', () => {
    const edge = createFocusEdge()
    edge.step('start')
    expect(edge.step('enter-vr')).toBe(true)
  })

  it('trap 19: a second detector does not move the first', () => {
    const a = createFocusEdge()
    const b = createFocusEdge()
    a.step(0)
    b.step(5)
    expect(a.step(1)).toBe(true)
    expect(b.step(5)).toBe(false)
  })

  it("the click is the hover cue, and a press is the confirm cue (the language is 2016's)", () => {
    expect(actionsForEvent({ type: 'ui.focus' }, [])[0]?.cue).toBe('ui.hover')
    expect(actionsForEvent({ type: 'ui.confirm' }, [])[0]?.cue).toBe('ui.confirm')
    expect(actionsForEvent({ type: 'ui.back' }, [])[0]?.cue).toBe('ui.back')
  })
})
