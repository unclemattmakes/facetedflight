// tests/unit/title-type.test.ts: the title's words, as DEV-610 set them.
//
// Matt, 2026-10-03: *"change the "10th Anniversary Edition" text to use the
// same font as the hover-jet hud / center the text on their buttons (start,
// vr) / center the copyright text at the bottom"*. Held here, in node:
//
//   1. The edition's line names the HUD's face, CRYSTAL, through the HUD's own
//      loader, and only once that loader has it: the same answer the cockpit
//      dash gets, compared against the font module's family name rather than a
//      string this test spells the way the code does.
//   2. A title built while CRYSTAL is still loading repaints in it when it
//      lands, through the REAL `createTitle` (a canvas never redraws itself).
//   3. The title plate's rows are centred, the label, the note and a value
//      after the label; every other plate the painter draws keeps its left
//      edge. Driven through `rowTextAnchors`, the layout `draw` itself calls.
//
// The third of Matt's asks, centring the credit line at the title's foot, was
// overtaken the same day by DEV-614: the line left the title for the pause
// plate's CREDITS page (`credits-menu.test.ts`).

import * as THREE from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dashFont } from '@/render/hud-dash'
import {
  type FontHost,
  HUD_FONT_FAMILY,
  loadHudFont,
  resetHudFontForTests,
} from '@/render/hud-font'
import { CENTRED_VALUE_GAP_EM, rowTextAnchors } from '@/render/pause'
import { createTitle, subtitleFont, TITLE_SUBTITLE_PX } from '@/render/title'
import { TITLE_MENU_ALIGN } from '@/render/title-menu'

beforeEach(() => {
  resetHudFontForTests()
  vi.unstubAllGlobals()
})

/** A FontFace stand-in whose load the test settles by hand. */
const host = () => {
  let settle: (() => void) | null = null
  class Face {
    load() {
      return new Promise((resolve) => {
        settle = () => resolve(this)
      })
    }
  }
  const h: FontHost = { FontFace: Face, fonts: { add: () => undefined } }
  return { h, resolve: () => settle?.() }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('DEV-610: the edition line is in the HoverJet HUD face', () => {
  it('keeps its size: the face changed, the type size did not', () => {
    expect(TITLE_SUBTITLE_PX).toBe(64)
  })

  it('names CRYSTAL once the HUD loader has it, and the old stack until then', async () => {
    const f = host()
    const done = loadHudFont('/assets/fonts/crystal-regular.ttf', f.h)
    // Loading is not loaded: a canvas drawing now must not name a face it cannot have.
    // The fallback is the UI stack (DEV-848): it lists the family, which a canvas
    // skips until it exists, and keeps the weight asked for; the HUD stack is the
    // one with Bahnschrift behind CRYSTAL.
    expect(subtitleFont(64)).toMatch(/^600 64px "FF2 CRYSTAL", "Arial Narrow"/)
    f.resolve()
    expect(await done).toBe(true)
    expect(subtitleFont(64)).toContain(`"${HUD_FONT_FAMILY}"`)
    // CRYSTAL is one weight, Regular, and is never synthesised bold.
    expect(subtitleFont(64)).toMatch(/^400 64px /)
  })

  it('is the same face the cockpit dash draws in', async () => {
    const f = host()
    const done = loadHudFont('/assets/fonts/crystal-regular.ttf', f.h)
    f.resolve()
    await done
    const family = (font: string) => font.replace(/^\d+ \d+px /, '')
    expect(family(subtitleFont(64))).toBe(family(dashFont(64)))
  })

  it('stays on the old stack for good when the font cannot load', async () => {
    const h: FontHost = {
      FontFace: class {
        load() {
          return Promise.reject(new Error('404'))
        }
      },
      fonts: { add: () => undefined },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await loadHudFont('/missing.ttf', h)).toBe(false)
    expect(subtitleFont(64)).toMatch(/^600 64px "FF2 CRYSTAL", "Arial Narrow"/)
    warn.mockRestore()
  })
})

// ── the repaint, through the real createTitle ───────────────────────────────

/** A 2-D canvas stand-in that records each `fillText` with the font it was drawn in. */
const installCanvas = () => {
  const drawn: { text: string; font: string }[] = []
  let font = ''
  const noop = () => {}
  const context = {
    set font(v: string) {
      font = v
    },
    get font() {
      return font
    },
    fillStyle: '',
    textAlign: '',
    textBaseline: '',
    clearRect: noop,
    fillText: (text: string) => drawn.push({ text, font }),
  }
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  })
  return drawn
}

const EDITION = '10th Anniversary Edition'

const buildTitle = () =>
  createTitle({
    eye: new THREE.Vector3(0, 10, 0),
    facing: 0,
    title: 'Faceted Flight',
    subtitle: EDITION,
    prompt: EDITION,
  })

describe('DEV-610: a title built before CRYSTAL lands repaints in it', () => {
  it('draws the line in the fallback first, then in CRYSTAL when the load settles', async () => {
    const f = host()
    void loadHudFont('/assets/fonts/crystal-regular.ttf', f.h)
    const drawn = installCanvas()
    const title = buildTitle()
    const edition = () => drawn.filter((d) => d.text === EDITION.toUpperCase())
    // The prompt (shadow and face) and the stand-in's subtitle.
    expect(edition().length).toBeGreaterThan(0)
    expect(edition().every((d) => !d.font.includes('Bahnschrift'))).toBe(true)
    drawn.length = 0
    f.resolve()
    await flush()
    expect(edition().length, 'the font landed and the title did not repaint').toBeGreaterThan(0)
    expect(edition().every((d) => d.font.includes('Bahnschrift'))).toBe(true)
    title.dispose()
  })

  it('a disposed title owes nothing when the font lands', async () => {
    const f = host()
    void loadHudFont('/assets/fonts/crystal-regular.ttf', f.h)
    const drawn = installCanvas()
    buildTitle().dispose()
    drawn.length = 0
    f.resolve()
    await flush()
    expect(drawn).toEqual([])
  })
})

// ── the rows: centred on the title, flush left everywhere else ───────────────

describe('DEV-610: the title plate centres the words on its rows', () => {
  it('the title hands the painter `center`', () => {
    expect(TITLE_MENU_ALIGN).toBe('center')
  })

  const W = 784
  const PAD = W * 0.07

  it('a centred row puts the label and the note on the plate centre line', () => {
    const at = rowTextAnchors('center', W, PAD, 200, null, 30)
    expect(at.labelAlign).toBe('center')
    expect(at.noteAlign).toBe('center')
    expect(at.labelX).toBe(W / 2)
    expect(at.noteX).toBe(W / 2)
    expect(at.valueX).toBeNull()
  })

  it('a centred row with a value centres label, gap and value as one run', () => {
    const labelW = 220
    const valueW = 140
    const gap = 40 * CENTRED_VALUE_GAP_EM
    const at = rowTextAnchors('center', W, PAD, labelW, valueW, gap)
    // The run's two outer edges are equally far from the plate's edges: the
    // relationship, not a re-derivation of the arithmetic.
    const runLeft = (at.labelX as number) - labelW / 2
    const runRight = (at.valueX as number) + valueW
    expect(runLeft).toBeCloseTo(W - runRight, 6)
    // The value starts after the label, by the gap, on the label's line.
    expect((at.valueX as number) - (at.labelX + labelW / 2)).toBeCloseTo(gap, 6)
    expect(at.valueAlign).toBe('left')
    expect(at.noteX).toBe(W / 2)
  })

  it('every other plate keeps the layout it shipped with: flush left, the value flush right', () => {
    const at = rowTextAnchors('left', W, PAD, 200, 120, 30)
    expect(at).toEqual({
      labelX: PAD,
      labelAlign: 'left',
      valueX: W - PAD,
      valueAlign: 'right',
      noteX: PAD,
      noteAlign: 'left',
    })
  })
})
