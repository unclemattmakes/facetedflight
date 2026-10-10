// tests/unit/tv-panel-controls.test.ts: FF-TV's hint names the controls that
// exist. DEV-628 (Matt: "unclear how to change which racer i'm following").
//
// The words are checked against the bindings, not against themselves: C and
// the arrows are `boot/tv-camera-input.ts`'s keys, M is this module's own,
// Escape is `boot/app.ts`'s TV back. A hint naming a key nothing reads is the
// DEV-069 shape (a control described in prose, wired to something else).

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tvControlsHint } from '@/render/tv-panel-controls'

const input = fs.readFileSync('src/boot/tv-camera-input.ts', 'utf8')
const controls = fs.readFileSync('src/render/tv-panel-controls.ts', 'utf8')

describe('DEV-628: the hint names the controls for the device in hand', () => {
  it('flat: a click is the next racer, a drag orbits, and the keys it names are read', () => {
    const h = tvControlsHint(false, 'follow')
    expect(h).toMatch(/CLICK next racer/)
    expect(h).toMatch(/DRAG orbit/)
    expect(h).toMatch(/ESC exit/)
    expect(input).toContain("e.code === 'KeyC'")
    expect(input).toContain("e.code === 'ArrowRight'")
    expect(controls).toContain("ev.code !== 'KeyM'")
  })

  it('in Free the drag looks and the keys fly', () => {
    const h = tvControlsHint(false, 'free')
    expect(h).toMatch(/DRAG look/)
    expect(h).toMatch(/W A S D fly/)
  })

  it('a phone: taps and drags, no keys', () => {
    const h = tvControlsHint(true, 'director')
    expect(h).toMatch(/TAP next racer/)
    expect(h).toMatch(/DRAG orbit/)
    expect(h).not.toMatch(/ESC|CLICK/)
  })
})
