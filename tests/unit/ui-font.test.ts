// tests/unit/ui-font.test.ts: CRYSTAL reaches the UI's plates (DEV-848, was DEV-647).

import { beforeEach, describe, expect, it } from 'vitest'
import { type FontHost, loadHudFont, resetHudFontForTests } from '@/render/hud-font'
import { uiFontEpoch } from '@/render/ui-font'
import { UI_FONT_FAMILY, UI_STACK, uiFont } from '@/render/ui-tokens'

beforeEach(() => resetHudFontForTests())

const host = (fail = false): FontHost => ({
  FontFace: class {
    load() {
      return fail ? Promise.reject(new Error('404')) : Promise.resolve(this)
    }
  } as unknown as FontHost['FontFace'],
  fonts: { add: () => {} },
})

describe('the UI face is CRYSTAL', () => {
  it('names the family hud-font registers, with no Roboto left in the stack', () => {
    expect(UI_FONT_FAMILY).toBe('FF2 CRYSTAL')
    expect(UI_STACK).not.toContain('Roboto')
  })

  it('asks for the weight given while the fallback stands in, and 400 (its only weight) once loaded', async () => {
    expect(uiFont(40, 700)).toBe(`700 40px ${UI_STACK}`)
    await loadHudFont('/x.ttf', host())
    expect(uiFont(40, 700)).toBe(`400 40px ${UI_STACK}`)
    expect(uiFont(30, 500)).toBe(`400 30px ${UI_STACK}`)
  })
})

describe('uiFontEpoch', () => {
  it('is 0 until the CRYSTAL load settles, then 1', async () => {
    expect(uiFontEpoch()).toBe(0)
    const done = loadHudFont('/x.ttf', host())
    expect(uiFontEpoch()).toBe(0)
    await done
    expect(uiFontEpoch()).toBe(1)
  })

  it('moves to 1 on a failed load too, so the plates repaint once either way', async () => {
    const warn = console.warn
    console.warn = () => {}
    await loadHudFont('/x.ttf', host(true))
    console.warn = warn
    expect(uiFontEpoch()).toBe(1)
  })

  it('settles as failed where there is no FontFace API to ask (node): the fallback is final', async () => {
    expect(await loadHudFont('/x.ttf', null)).toBe(false)
    expect(uiFontEpoch()).toBe(1)
  })
})
