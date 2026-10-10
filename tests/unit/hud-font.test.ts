// tests/unit/hud-font.test.ts — DEV-362 follow-up: the cockpit readout draws
// in CRYSTAL, 2016's own face, and the file it draws with is 2016's own file.
//
// Three things are held here:
//
//  1. The loader. It names CRYSTAL only once the face is in `document.fonts`,
//     never rejects, and leaves every panel on its fallback when the load fails
//     or the API is missing.
//  2. The repaint. A canvas never redraws itself when a font lands, so a panel
//     built while the font is loading must owe itself one paint — measured
//     through the REAL `createHud`, by its repaint count.
//  3. The licence's one hard duty. CC BY-SA 4.0's share-alike binds a MODIFIED
//     copy of the font, so the bytes on disk must be 2016's bytes, compared
//     against the Unity project's own file and against the manifest's sha256
//     — not against a number this test re-derives the way the code does.
//
// The disk half is guarded, with the reads inside the `it`, and has one loud
// counterpart.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHud, type HudState } from '@/render/hud'
import { dashFallbackFont, dashFont } from '@/render/hud-dash'
import {
  type FontHost,
  HUD_FONT_ASSET,
  HUD_FONT_FAMILY,
  hudFace,
  hudFontState,
  loadHudFont,
  resetHudFontForTests,
  whenHudFontSettles,
} from '@/render/hud-font'
import { legacyAvailable, legacyPath } from '../../tools/legacy-root.mjs'

beforeEach(() => {
  resetHudFontForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A FontFace stand-in whose load the test resolves or rejects by hand. */
const host = () => {
  const added: unknown[] = []
  const made: { family: string; source: string; descriptors: FontFaceDescriptors | undefined }[] =
    []
  let settle: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | null = null
  class Face {
    constructor(family: string, source: string, descriptors?: FontFaceDescriptors) {
      made.push({ family, source, descriptors })
    }
    load() {
      return new Promise((resolve, reject) => {
        settle = { resolve: () => resolve(this), reject }
      })
    }
  }
  const h: FontHost = { FontFace: Face, fonts: { add: (f: unknown) => added.push(f) } }
  return {
    h,
    added,
    made,
    resolve: () => settle?.resolve(undefined),
    reject: () => settle?.reject(new Error('404')),
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('loadHudFont — CRYSTAL, or the stack the panels always had', () => {
  it('registers FF2 CRYSTAL from the url it is given, Regular, and names it only once loaded', async () => {
    const f = host()
    const done = loadHudFont('/assets/fonts/crystal-regular.ttf', f.h)
    expect(hudFontState()).toBe('loading')
    // Loading is NOT loaded: a canvas drawing now must not name a face it cannot have.
    expect(dashFont(40)).toBe(dashFallbackFont(40))
    f.resolve()
    expect(await done).toBe(true)
    expect(hudFontState()).toBe('loaded')
    expect(f.made).toHaveLength(1)
    expect(f.made[0]?.family).toBe(HUD_FONT_FAMILY)
    expect(f.made[0]?.source).toContain('/assets/fonts/crystal-regular.ttf')
    expect(f.made[0]?.descriptors?.weight).toBe('400')
    expect(f.added).toHaveLength(1)
    expect(dashFont(40)).toContain(`"${HUD_FONT_FAMILY}"`)
    // One weight, Regular, as 2016 drew it — never a synthesised bold.
    expect(dashFont(40).startsWith('400 40px')).toBe(true)
  })

  it('a failed load never rejects, and leaves every panel on its fallback', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = host()
    const done = loadHudFont('/missing.ttf', f.h)
    f.reject()
    expect(await done).toBe(false)
    expect(hudFontState()).toBe('failed')
    expect(f.added).toHaveLength(0)
    expect(dashFont(40)).toBe(dashFallbackFont(40))
    expect(hudFace(40, (px) => `fallback ${px}`)).toBe('fallback 40')
  })

  it('no FontFace API at all is a failed load, not a crash', async () => {
    expect(await loadHudFont('/x.ttf', null)).toBe(false)
    expect(hudFontState()).toBe('failed')
  })

  it('is idempotent: one face, one promise, however often boot asks', async () => {
    const f = host()
    const a = loadHudFont('/a.ttf', f.h)
    const b = loadHudFont('/b.ttf', f.h)
    expect(b).toBe(a)
    expect(f.made).toHaveLength(1)
  })

  it('whenHudFontSettles fires once for a load in flight, and never for one that is not', async () => {
    const calls: string[] = []
    whenHudFontSettles(() => calls.push('idle'))
    const f = host()
    void loadHudFont('/a.ttf', f.h)
    whenHudFontSettles(() => calls.push('loading'))
    f.resolve()
    await flush()
    whenHudFontSettles(() => calls.push('loaded'))
    await flush()
    expect(calls).toEqual(['loading'])
  })
})

// ── the repaint, through the real panel ──────────────────────────────────────

const installCanvas = () => {
  const fonts: string[] = []
  const noop = () => {}
  const context = {
    set font(v: string) {
      fonts.push(v)
    },
    get font() {
      return fonts[fonts.length - 1] ?? ''
    },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    textAlign: '',
    textBaseline: '',
    clearRect: noop,
    fillRect: noop,
    fillText: noop,
    setTransform: noop,
    beginPath: noop,
    roundRect: noop,
    arc: noop,
    moveTo: noop,
    lineTo: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
    save: noop,
    restore: noop,
    clip: noop,
    rect: noop,
    measureText: (s: string) => ({ width: s.length * 8 }),
  }
  const element = { width: 0, height: 0, getContext: () => context }
  vi.stubGlobal('document', { createElement: () => element })
  return fonts
}

const state: HudState = {
  ringsPassed: 13,
  ringsTotal: 28,
  score: 0,
  elapsed: 44,
  timeLimit: 180,
  timeCountsDown: true,
  speed: 150,
  medal: '',
  finished: false,
  countLabel: 'GATES',
  timeLabel: 'TIME',
  speedLabel: 'SPEED',
  banner: null,
  autopilot: false,
}

describe('a panel built while CRYSTAL is loading repaints in it when it lands', () => {
  it('the dash owes one paint on the load, and that paint names CRYSTAL', async () => {
    const f = host()
    void loadHudFont('/assets/fonts/crystal-regular.ttf', f.h)
    const fonts = installCanvas()
    const hud = createHud()
    hud.setMount('dash')
    hud.update(state, 0)
    expect(hud.paints).toBe(1)
    expect(fonts.some((x) => x.includes(HUD_FONT_FAMILY))).toBe(false)
    // Same readings: without the font landing, nothing is owed.
    hud.update(state, 200)
    expect(hud.paints).toBe(1)
    f.resolve()
    await flush()
    fonts.length = 0
    hud.update(state, 400)
    expect(hud.paints, 'the font landed and the panel did not repaint').toBe(2)
    expect(fonts.every((x) => x.includes(HUD_FONT_FAMILY))).toBe(true)
  })

  it('the JumpSeat’s fuel dome draws in CRYSTAL too, once it has loaded (DEV-360)', async () => {
    const f = host()
    void loadHudFont('/assets/fonts/crystal-regular.ttf', f.h)
    f.resolve()
    await flush()
    const fonts = installCanvas()
    const hud = createHud({ layout: 'fuel' })
    hud.update({ ...state, energy: { fraction: 0.6, available: true } }, 0)
    expect(fonts.length).toBeGreaterThan(0)
    expect(fonts.every((x) => x.includes(HUD_FONT_FAMILY))).toBe(true)
  })
})

// ── the bytes: 2016's, unmodified ────────────────────────────────────────────

const FONT_ON_DISK = `public/${HUD_FONT_ASSET}`
const FONT_2016 = 'Assets/Faceted Flight/Fonts/CRYSTAL-Regular.ttf'
const haveFont = fs.existsSync(FONT_ON_DISK)
const haveLegacy = legacyAvailable()
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

interface ManifestRow {
  id: string
  path: string
  kind: string
  sha256?: string
  bytes?: number
}
const manifest = (): ManifestRow[] =>
  (
    JSON.parse(fs.readFileSync('tools/assets/required-assets.json', 'utf8')) as {
      assets: ManifestRow[]
    }
  ).assets

describe('the font the panels load is a manifest row, credited', () => {
  it('HUD_FONT_ASSET is the manifest’s font row, with a notice row beside it', () => {
    const rows = manifest()
    const font = rows.find((r) => r.path === HUD_FONT_ASSET)
    expect(font?.kind).toBe('font')
    expect(font?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(rows.some((r) => r.path === HUD_FONT_ASSET.replace(/\.ttf$/, '-license.txt'))).toBe(true)
  })
})

describe.skipIf(!(haveFont && haveLegacy))('the served font is 2016’s file, byte for byte', () => {
  it('equals the Unity project’s CRYSTAL-Regular.ttf and the manifest’s sha256', () => {
    const onDisk = sha(FONT_ON_DISK)
    expect(onDisk, 'the font on disk is not the file 2016 shipped: CC BY-SA would bind it').toBe(
      sha(legacyPath(FONT_2016)),
    )
    expect(onDisk).toBe(manifest().find((r) => r.path === HUD_FONT_ASSET)?.sha256)
  })
})

describe.skipIf(haveFont && haveLegacy)('the guarded half of this file', () => {
  it('is skipped only because the font or the Unity project is absent', () => {
    expect(haveFont && haveLegacy).toBe(false)
  })
})
