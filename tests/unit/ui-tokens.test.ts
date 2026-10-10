// tests/unit/ui-tokens.test.ts: the UI palette, type and scale, pinned as VALUES.
//
// Until `ui-tokens.ts` nothing pinned these: eleven files each held a private
// copy, so a retune was eleven edits and a missed one was a menu that no longer
// matched its neighbour. Now it is one, and THIS is the edit somebody has to make
// on purpose: it fails if a colour moves without being asked to, which is the
// same job `HUD_RASTER_SHIPPED`'s pin does for a shipped default.
//
// And the two forms of one colour agree: the strings a canvas draws with and the
// numbers a three material takes (`menu-reticle.ts`, `xr-pointer.ts`) are one
// source, not two that match today.

import { describe, expect, it } from 'vitest'
import { RETICLE_OFF, RETICLE_ON } from '@/render/menu-reticle'
import {
  UI_ACCENT,
  UI_ACCENT_HEX,
  UI_ALERT,
  UI_CYAN,
  UI_DIM,
  UI_DIM_HEX,
  UI_FONT_FAMILY,
  UI_GAIN,
  UI_INK,
  UI_LOSS,
  UI_MONO_STACK,
  UI_PLATE,
  UI_PLATE_EDGE,
  UI_SELECTED_FILL,
  UI_STACK,
  UI_SUB_FLOOR_M,
  UI_TYPE_RATIO,
  uiFont,
  uiType,
} from '@/render/ui-tokens'

const hexOf = (n: number): string => `#${n.toString(16).padStart(6, '0')}`

describe('the UI palette', () => {
  it('is the broadcast palette: the old ink, dim and gold, a flat plate, and the gain, loss, alert and cyan', () => {
    expect(UI_INK).toBe('#f2f7fb')
    expect(UI_DIM).toBe('#9fb4c4')
    expect(UI_ACCENT).toBe('#ffcf7a')
    expect(UI_GAIN).toBe('#8ef0a8')
    expect(UI_LOSS).toBe('#8fb3bd')
    expect(UI_ALERT).toBe('#ff8a5c')
    expect(UI_CYAN).toBe('#8ad8e0')
    expect(UI_PLATE).toBe('rgba(10, 22, 30, 0.94)')
    expect(UI_PLATE_EDGE).toBe('rgba(242, 247, 251, 0.16)')
    expect(UI_SELECTED_FILL).toBe('rgba(255, 207, 122, 0.16)')
  })

  it('has one source for a colour in both its forms', () => {
    expect(hexOf(UI_ACCENT_HEX)).toBe(UI_ACCENT)
    expect(hexOf(UI_DIM_HEX)).toBe(UI_DIM)
  })

  it('the reticle and the beam read the same accent and dim', () => {
    expect(RETICLE_ON).toBe(UI_ACCENT_HEX)
    expect(RETICLE_OFF).toBe(UI_DIM_HEX)
  })

  it('the selected wash is the accent at 16 %', () => {
    expect(UI_SELECTED_FILL).toBe('rgba(255, 207, 122, 0.16)')
    expect(UI_ACCENT_HEX).toBe((255 << 16) | (207 << 8) | 122)
  })
})

describe('the UI type', () => {
  it('is CRYSTAL first (DEV-848), then the platform sans, bold unless asked', () => {
    expect(UI_FONT_FAMILY).toBe('FF2 CRYSTAL')
    expect(UI_STACK.startsWith('"FF2 CRYSTAL", ')).toBe(true)
    expect(UI_STACK).not.toContain('Roboto')
    expect(UI_STACK).not.toContain('monospace')
    expect(uiFont(42)).toBe(`700 42px ${UI_STACK}`)
    expect(uiFont(30.5, 500)).toBe(`500 30.5px ${UI_STACK}`)
  })

  it('keeps the developer instruments their own monospace', () => {
    expect(UI_MONO_STACK).toBe('ui-monospace, SFMono-Regular, Menlo, Consolas, monospace')
  })
})

describe('the type scale: three sizes and a floor under the sub-line', () => {
  it('is 1, 0.7 and 0.46 of a surface title, and a hero of 1.4', () => {
    expect(UI_TYPE_RATIO).toEqual({ hero: 1.4, title: 1, label: 0.7, sub: 0.46 })
    const t = uiType(100, 1400)
    expect(t.title).toBe(100)
    expect(t.hero).toBeCloseTo(140, 9)
    expect(t.label).toBeCloseTo(70, 9)
    // 0.46 of 100 is 46 px, well over the floor at 1400 px/m (23.8 px).
    expect(t.sub).toBeCloseTo(46, 9)
  })

  it('floors the sub-line at 0.017 m of em, whatever the ratio says', () => {
    expect(UI_SUB_FLOOR_M).toBe(0.017)
    // A small title: 0.46 x 30 = 13.8 px, under the 23.8 px floor.
    expect(uiType(30, 1400).sub).toBeCloseTo(23.8, 9)
    // The floor follows the texel density: 1896 px/m (the hangar's label canvas).
    expect(uiType(30, 1896).sub).toBeCloseTo(0.017 * 1896, 9)
  })

  it('never shrinks the label or the title', () => {
    for (const title of [20, 58, 154, 300]) {
      const t = uiType(title, 1400)
      expect(t.title).toBeGreaterThanOrEqual(t.label)
      expect(t.label).toBeGreaterThan(0)
    }
  })
})
