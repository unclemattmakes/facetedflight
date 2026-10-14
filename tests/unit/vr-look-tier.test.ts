// tests/unit/vr-look-tier.test.ts: on AUTO, a headset wearing Anniversary gets
// `low`'s eye size, and none of `low`'s flat-tier answers. DEV-931, lever 1 of
// docs/plan/ANNIVERSARY-VR-FRAMERATE.md. Beside edition-auto.test.ts, which
// owns DEV-896's look half; tests/e2e/vr-look-tier.spec.ts drives the boot
// wiring (the look a headset wears, and the `?vrLookTier=0` pin) through IWER.

import type * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  qualityInForce,
  VR_AUTO_QUALITY,
  VR_AUTO_QUALITY_ANNIVERSARY,
  vrAutoQualityFor,
} from '@/boot/settings'
import type { Edition, EditionId } from '@/content/edition-schema'
import { lifeWanted } from '@/game/life/load-life'
import { createQualityController, msaaFor, QUALITY } from '@/render/quality'
import { shadowsEnabled } from '@/render/shadows'
import anniversaryJson from '../../content/editions/anniversary.json'

const ANNIVERSARY = anniversaryJson as unknown as Edition

/** A renderer out of session that records the XR scale it is handed. */
const fakeRenderer = () => {
  const scales: number[] = []
  const renderer = {
    setPixelRatio: () => {},
    xr: {
      isPresenting: false,
      getSession: () => null,
      setFoveation: () => {},
      setFramebufferScaleFactor: (v: number) => scales.push(v),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  }
  return { renderer: renderer as unknown as THREE.WebGLRenderer, scales }
}

describe('AUTO in a headset: the tier follows the look (DEV-931)', () => {
  it('pins the two headset tiers', () => {
    // The single place the values are written down: change one on purpose.
    expect(VR_AUTO_QUALITY_ANNIVERSARY).toBe('low')
    expect(VR_AUTO_QUALITY).toBe('medium')
    // And the Anniversary eye really is the smaller one.
    expect(QUALITY[VR_AUTO_QUALITY_ANNIVERSARY].framebufferScale).toBeLessThan(
      QUALITY[VR_AUTO_QUALITY].framebufferScale,
    )
  })

  it('gives Anniversary low, Classic and an unknown look medium, and the monitor high', () => {
    expect(qualityInForce(DEFAULT_SETTINGS, true, 'anniversary')).toBe('low')
    expect(qualityInForce(DEFAULT_SETTINGS, true, 'classic')).toBe('medium')
    expect(qualityInForce(DEFAULT_SETTINGS, true, null)).toBe('medium')
    // Omitted is the pre-DEV-931 answer, so a caller that cannot know the look reports it.
    expect(qualityInForce(DEFAULT_SETTINGS, true)).toBe('medium')
    expect(qualityInForce(DEFAULT_SETTINGS, false, 'anniversary'), 'flat is untouched').toBe('high')
    expect(vrAutoQualityFor('anniversary')).toBe(VR_AUTO_QUALITY_ANNIVERSARY)
  })

  it('never overrides a tier the player picked, on either look', () => {
    for (const q of ['low', 'medium', 'high'] as const) {
      for (const look of ['anniversary', 'classic'] as const) {
        expect(qualityInForce({ quality: q, qualityAuto: false }, true, look)).toBe(q)
      }
    }
    // AUTO left on with a non-default tier is a choice too (quality-auto.test.ts's rule).
    expect(qualityInForce({ ...DEFAULT_SETTINGS, quality: 'medium' }, true, 'anniversary')).toBe(
      'medium',
    )
  })

  it("takes low's EYE and none of low's flat-tier answers", () => {
    // The three readers VR_AUTO_QUALITY's comment names, plus the life pass's
    // floor, read the FLAT tier, which AUTO keeps at high. If a change ever made
    // AUTO's headset tier reach `quality` itself, these would read low's answers.
    expect(DEFAULT_SETTINGS.quality).toBe('high')
    expect(msaaFor(DEFAULT_SETTINGS.quality), 'the context stays multisampled').toBe(true)
    expect(shadowsEnabled(ANNIVERSARY, DEFAULT_SETTINGS), 'the map is not low-gated').toBe(true)
    const life = lifeWanted(ANNIVERSARY.life, DEFAULT_SETTINGS.quality)
    expect(life.boats && life.dolphins, 'the boats and dolphins keep their floor').toBe(true)
  })
})

describe("the quality controller hands three the look's scale", () => {
  const pushed = (look: (() => EditionId | null) | undefined): number[] => {
    const { renderer, scales } = fakeRenderer()
    const quality = createQualityController(renderer, {
      devicePixelRatio: () => 1,
      ...(look ? { headsetLook: look } : {}),
    })
    quality.apply(DEFAULT_SETTINGS)
    scales.length = 0
    quality.applyBeforeSession()
    return scales
  }

  it('builds an Anniversary session at 0.7 and every other at 0.75', () => {
    expect(pushed(() => 'anniversary')).toEqual([QUALITY.low.framebufferScale])
    expect(pushed(() => 'classic')).toEqual([QUALITY.medium.framebufferScale])
    expect(
      pushed(() => null),
      'the off pin',
    ).toEqual([QUALITY.medium.framebufferScale])
    expect(pushed(undefined), 'no option: as before DEV-931').toEqual([
      QUALITY.medium.framebufferScale,
    ])
  })

  it('reads the look LIVE, so a look chosen before ENTER VR is the one built', () => {
    const { renderer, scales } = fakeRenderer()
    let look: EditionId = 'classic'
    const quality = createQualityController(renderer, {
      devicePixelRatio: () => 1,
      headsetLook: () => look,
    })
    quality.apply(DEFAULT_SETTINGS)
    look = 'anniversary'
    scales.length = 0
    quality.applyBeforeSession()
    expect(scales).toEqual([QUALITY.low.framebufferScale])
    expect(quality.report.framebufferScale).toBeCloseTo(QUALITY.low.framebufferScale, 9)
  })
})
