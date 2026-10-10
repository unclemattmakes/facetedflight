// tests/unit/quality-ultra.test.ts: the fourth tier, flat only. DEV-581,
// docs/plan/ULTRA.md.
//
// Three properties, and the second is the one the whole plan rests on:
//
//  1. Ultra's values are pinned in ONE assertion somebody has to edit on
//     purpose (CLAUDE.md, DEV-266, the `HUD_RASTER_SHIPPED` pattern).
//  2. While a headset is presenting, ultra IS `high`: the same spec object,
//     not a copy that happens to agree today. VR is unchanged by construction.
//  3. On a monitor the pixel ratio is a pixel TARGET, at least `high`'s and at
//     most the cap, and the adaptive step still multiplies it.

import type * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  nextQualityChoice,
  QUALITIES,
  qualitiesOffered,
  qualityInForce,
} from '@/boot/settings'
import { qualityAtLeast } from '@/game/life/load-life'
import { activateSettingRow, qualityRow } from '@/render/comfort-menu'
import {
  ADAPTIVE_STEPS,
  createQualityController,
  DEFAULT_ADAPTIVE,
  msaaFor,
  QUALITY,
  qualitySpecFor,
  ULTRA_SNAP_RATIO,
  ultraFor,
  ultraPixelRatio,
} from '@/render/quality'

const ultra = { ...DEFAULT_SETTINGS, quality: 'ultra' as const, qualityAuto: false }
const ULTRA_SPEC = QUALITY.ultra.ultra
if (!ULTRA_SPEC) throw new Error('QUALITY.ultra.ultra must not be null')

describe('the ultra preset, pinned', () => {
  it('holds the values DEV-581 shipped, in one place', () => {
    // Edit this on purpose or not at all. `renderTargetMpx` is 3840 x 2160
    // exactly (see `UltraSpec`'s note for why not the plan's 8.3).
    expect(QUALITY.ultra).toEqual({
      framebufferScale: 1,
      pixelRatioCap: 2,
      msaa: true,
      ultra: { renderTargetMpx: 8.2944, seaReflection: true, lodMultiplier: 2 },
    })
    expect(ULTRA_SPEC.renderTargetMpx * 1e6).toBe(3840 * 2160)
  })

  it('is the only tier with an ultra block, and sits at the top of the ladder', () => {
    for (const q of QUALITIES) {
      expect(QUALITY[q].ultra === null, q).toBe(q !== 'ultra')
    }
    expect(QUALITIES.at(-1)).toBe('ultra')
  })

  it('is opt-in: the default tier is still high (C4 is open)', () => {
    expect(DEFAULT_SETTINGS.quality).toBe('high')
    expect(qualityInForce(DEFAULT_SETTINGS, false)).toBe('high')
  })
})

describe('in a headset, ultra is high', () => {
  it('resolves to high’s EXACT spec while presenting', () => {
    expect(qualityInForce(ultra, true)).toBe('high')
    expect(qualitySpecFor(ultra, true)).toBe(QUALITY.high)
    // And with the AUTO flag left on by a partial update: still high, never
    // the AUTO headset tier, because ultra is a choice.
    expect(qualitySpecFor({ quality: 'ultra', qualityAuto: true }, true)).toBe(QUALITY.high)
  })

  it('has no ultra features while presenting, and has them on a monitor', () => {
    expect(ultraFor(ultra, true)).toBeNull()
    expect(ultraFor(ultra, false)).toBe(ULTRA_SPEC)
    for (const q of ['low', 'medium', 'high'] as const) {
      expect(ultraFor({ quality: q, qualityAuto: false }, false), q).toBeNull()
    }
    expect(ultraFor(DEFAULT_SETTINGS, false)).toBeNull()
  })

  it('answers the load-time readers that take the raw tier exactly as high does', () => {
    // MSAA is a context attribute read from the stored tier, not the tier in
    // force; ultra must build the same context high builds.
    expect(msaaFor('ultra')).toBe(msaaFor('high'))
    expect(QUALITY.ultra.framebufferScale).toBe(QUALITY.high.framebufferScale)
  })

  it('keeps the life gate at least where high has it', () => {
    // `qualityAtLeast` indexed the three floors, where ultra is -1: every
    // boat vanished at the best tier. The ladder is QUALITIES now.
    for (const min of ['low', 'medium', 'high'] as const) {
      expect(qualityAtLeast('ultra', min), min).toBe(true)
      expect(qualityAtLeast('ultra', min)).toBe(qualityAtLeast('high', min))
    }
    expect(qualityAtLeast('extreme', 'low')).toBe(false)
  })
})

describe('the pixel target', () => {
  // dpr 1 is an ordinary monitor; the floor is high's `min(dpr, 2)`.
  it('supersamples a 1080p monitor by 2, a 1440p one by 1.5, and a 4K one by 1', () => {
    expect(ultraPixelRatio(ULTRA_SPEC, 2, 1, 1920 * 1080)).toBeCloseTo(2, 2)
    expect(ultraPixelRatio(ULTRA_SPEC, 2, 1, 1920 * 1080)).toBeLessThanOrEqual(2)
    expect(ultraPixelRatio(ULTRA_SPEC, 2, 1, 2560 * 1440)).toBeCloseTo(1.5, 12)
    expect(ultraPixelRatio(ULTRA_SPEC, 2, 1, 3840 * 2160)).toBeCloseTo(1, 12)
    // The drawing buffer three builds is `floor(css * ratio)`: a 4K canvas
    // must stay 3840 wide, not 3841 (the reason for 8.2944 over 8.3).
    expect(Math.floor(3840 * ultraPixelRatio(ULTRA_SPEC, 2, 1, 3840 * 2160))).toBe(3840)
  })

  it('never renders fewer pixels than high, and never past the cap', () => {
    // A HiDPI laptop: high already gives 2, ultra cannot add to it.
    expect(ultraPixelRatio(ULTRA_SPEC, 2, 2, 1440 * 900)).toBe(2)
    // A screen bigger than the target: the floor, which is high's answer.
    expect(ultraPixelRatio(ULTRA_SPEC, 2, 1, 5120 * 2880)).toBe(1)
    expect(ultraPixelRatio(ULTRA_SPEC, 2, 1.5, 3840 * 2400)).toBe(1.5)
    // A tiny window: the cap.
    expect(ultraPixelRatio(ULTRA_SPEC, 2, 1, 640 * 360)).toBe(2)
    // A canvas with no size yet: the floor, not Infinity.
    expect(ultraPixelRatio(ULTRA_SPEC, 2, 1, 0)).toBe(1)
  })

  it('snaps a near-native ratio to the floor rather than resampling for nothing', () => {
    expect(ULTRA_SNAP_RATIO).toBe(1.25)
    // A 4K monitor with the browser windowed: about 1.03 wanted, 1 given.
    const windowed = 3840 * 2040
    expect(Math.sqrt((ULTRA_SPEC.renderTargetMpx * 1e6) / windowed)).toBeCloseTo(1.03, 2)
    expect(ultraPixelRatio(ULTRA_SPEC, 2, 1, windowed)).toBe(1)
    // 1440p wants 1.5, well past the threshold: unchanged.
    expect(ultraPixelRatio(ULTRA_SPEC, 2, 1, 2560 * 1440)).toBeCloseTo(1.5, 12)
    // Either side of the threshold, by the canvas that asks for it.
    const asking = (r: number) => (ULTRA_SPEC.renderTargetMpx * 1e6) / (r * r)
    expect(ultraPixelRatio(ULTRA_SPEC, 2, 1, asking(1.26))).toBeCloseTo(1.26, 12)
    expect(ultraPixelRatio(ULTRA_SPEC, 2, 1, asking(1.24))).toBe(1)
    // The threshold scales with the floor: dpr 1.5 wanting 1.8 (< 1.875) snaps.
    expect(ultraPixelRatio(ULTRA_SPEC, 2, 1.5, asking(1.8))).toBe(1.5)
  })
})

/** A renderer stand-in: the flat surface only, and the pixel-ratio calls. */
const fakeRenderer = (presenting = false) => {
  const pixelRatio: number[] = []
  const framebufferScale: number[] = []
  const renderer = {
    setPixelRatio: (v: number) => pixelRatio.push(v),
    xr: {
      isPresenting: presenting,
      getSession: () => (presenting ? { frameRate: 72 } : null),
      setFoveation: () => {},
      setFramebufferScaleFactor: (v: number) => framebufferScale.push(v),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  }
  return { renderer: renderer as unknown as THREE.WebGLRenderer, pixelRatio, framebufferScale }
}

describe('the controller under ultra', () => {
  it('pushes the target ratio, and re-derives it when the window is resized', () => {
    const r = fakeRenderer()
    let css = 2560 * 1440
    const q = createQualityController(r.renderer, {
      devicePixelRatio: () => 1,
      cssPixels: () => css,
    })
    q.apply({ ...ultra, adaptiveResolution: false })
    expect(r.pixelRatio.at(-1)).toBeCloseTo(1.5, 12)
    // No event reaches the controller on a resize; the next frame re-derives.
    css = 1920 * 1080
    q.frame(1 / 60)
    expect(r.pixelRatio.at(-1)).toBeCloseTo(2, 2)
    // And a still window pushes nothing more.
    const calls = r.pixelRatio.length
    q.frame(1 / 60)
    q.frame(1 / 60)
    expect(r.pixelRatio.length).toBe(calls)
  })

  it('lets the adaptive step multiply the target ratio, as it does the cap', () => {
    const r = fakeRenderer()
    const q = createQualityController(r.renderer, {
      devicePixelRatio: () => 1,
      cssPixels: () => 2560 * 1440,
      targetHz: 60,
    })
    q.apply({ ...ultra, adaptiveResolution: true })
    expect(r.pixelRatio.at(-1)).toBeCloseTo(1.5, 12)
    // Sustained over-budget: twice the budget, for well past the sustain.
    const frames = Math.ceil((DEFAULT_ADAPTIVE.sustainSeconds * 3) / (2 / 60))
    for (let i = 0; i < frames; i++) q.frame(2 / 60)
    const step = q.report.scale
    expect(step).toBeLessThan(1)
    expect(ADAPTIVE_STEPS).toContain(step)
    expect(r.pixelRatio.at(-1)).toBeCloseTo(1.5 * step, 12)
  })

  it('leaves every other tier’s ratio exactly the cap rule, whatever the size', () => {
    for (const quality of ['low', 'medium', 'high'] as const) {
      const r = fakeRenderer()
      const q = createQualityController(r.renderer, {
        devicePixelRatio: () => 1.25,
        cssPixels: () => 2560 * 1440,
      })
      q.apply({ ...DEFAULT_SETTINGS, quality, qualityAuto: false, adaptiveResolution: false })
      expect(r.pixelRatio.at(-1), quality).toBe(Math.min(1.25, QUALITY[quality].pixelRatioCap))
    }
  })

  it('gives the headset high’s framebuffer scale, never anything ultra (DEV-178 holds)', () => {
    const r = fakeRenderer()
    const q = createQualityController(r.renderer, { devicePixelRatio: () => 1 })
    q.apply({ ...ultra, adaptiveResolution: true })
    q.applyBeforeSession()
    expect(r.framebufferScale.at(-1)).toBe(QUALITY.high.framebufferScale)
  })

  it('pushes no pixel ratio while presenting, and reports high', () => {
    const r = fakeRenderer(true)
    const q = createQualityController(r.renderer, {
      devicePixelRatio: () => 1,
      cssPixels: () => 2560 * 1440,
    })
    q.apply({ ...ultra, adaptiveResolution: false })
    q.frame(1 / 72)
    expect(r.pixelRatio).toEqual([])
    expect(q.report.quality).toBe('high')
    expect(q.report.pixelRatio).toBeNull()
  })
})

describe('the quality row', () => {
  const row = qualityRow

  it('offers ultra on a monitor and never in a headset', () => {
    expect(qualitiesOffered(false)).toContain('ultra')
    expect(qualitiesOffered(true)).not.toContain('ultra')
    const high = { ...DEFAULT_SETTINGS, quality: 'high' as const, qualityAuto: false }
    expect(activateSettingRow(high, 'quality', false)?.quality).toBe('ultra')
    const inHeadset = activateSettingRow(high, 'quality', true)
    expect(inHeadset?.qualityAuto).toBe(true)
  })

  it('reaches no ultra from any state in a headset', () => {
    for (const start of [
      DEFAULT_SETTINGS,
      ...(['low', 'medium', 'high'] as const).map((q) => ({
        ...DEFAULT_SETTINGS,
        quality: q,
        qualityAuto: false,
      })),
    ]) {
      let s = start
      for (let i = 0; i < 8; i++) {
        s = { ...s, ...nextQualityChoice(s, true) }
        expect(s.quality).not.toBe('ultra')
      }
    }
  })

  it('steps a stored ultra met in a headset as high steps: to Auto', () => {
    expect(nextQualityChoice(ultra, true)).toEqual({
      quality: DEFAULT_SETTINGS.quality,
      qualityAuto: true,
    })
  })

  it('shows ultra on a monitor, and high (with the reason) in a headset', () => {
    expect(row(ultra)?.value).toBe('ultra')
    expect(row(ultra)?.note).toMatch(/headset/)
    expect(row(ultra, null, true)?.value).toBe('high')
    expect(row(ultra, null, true)?.note).toMatch(/monitor/)
    // A URL pin of ultra, in a headset, is still high on the row.
    expect(row(DEFAULT_SETTINGS, 'ultra', true)?.value).toBe('high')
    expect(row(DEFAULT_SETTINGS, 'ultra', false)?.value).toBe('ultra')
  })
})
