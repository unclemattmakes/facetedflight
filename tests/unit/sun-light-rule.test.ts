// tests/unit/sun-light-rule.test.ts — every mission's sun is drawn by 2016's
// light rule, from the level JSON, and `?sunlight=port` is the old rule for
// A/B. DEV-454 (DEV-446 found it).
//
// The rule's oracle is OUTSIDE the extractor: `render/hangar-light.ts`'s
// `unityLightLinear`, which DEV-437 pinned against Unity's own linear grey and
// measured on the hangar before anybody believed it. The extractor's copy
// (`tools/extract/unity-light.mjs`) is held to it here, over all thirteen
// missions and the hand-authored courses — two implementations agreeing, where
// one of them was measured against the engine.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Level, SunLight } from '@/content/level-schema'
import { unityGammaToLinear as runtimeGammaToLinear, unityLightLinear } from '@/render/hangar-light'
import { sunLightRuleFrom, withSunLightRule } from '@/render/sun-light-rule'
import {
  unityGammaToLinear as toolGammaToLinear,
  unity54LightLinear,
} from '../../tools/extract/unity-light.mjs'

interface Row {
  readonly file: string
  readonly id: string
  readonly sun: SunLight
}

const read = (dir: string): Row[] =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Level
      return { file: `${dir}/${f}`, id: j.id, sun: j.lighting.sun as SunLight }
    })

const shipped = (): Row[] => read('content/levels')
const authored = (): Row[] => read('content/authored').filter((r) => r.sun)

const saturation = (c: readonly number[]) => Math.min(...c) / Math.max(...c)

describe('the premise: what 2016 serialised', () => {
  it('int_01_hoverJet’s sun carries the raw m_Color and intensity of `Light &118365899`', () => {
    // `int_01_hoverJet.unity`: m_Color {r: 0.8308824, g: 0.56939465, b:
    // 0.39100346}, m_Intensity 1.3 — the six-place rounding and nothing else.
    const int01 = shipped().find((r) => r.id === 'int_01_hoverJet')
    expect(int01?.sun.colorGamma).toEqual([0.830882, 0.569395, 0.391003])
    expect(int01?.sun.intensity).toBe(1.3)
  })

  it('finds all thirteen shipped missions, each with a sun', () => {
    expect(shipped()).toHaveLength(13)
    for (const r of shipped()) expect(r.sun, r.id).toBeTruthy()
  })
})

describe('the extractor writes Unity 5.4’s rule, and the runtime’s copy agrees', () => {
  it('the tool’s curve is the runtime’s curve, and lands 0.5 on Unity’s linear grey', () => {
    expect(toolGammaToLinear(0.5)).toBeCloseTo(0.214041, 6)
    for (let v = 0; v <= 2; v += 0.01) {
      expect(toolGammaToLinear(v)).toBeCloseTo(runtimeGammaToLinear(v), 12)
    }
  })

  it('on every mission, colorLinear × intensity is GammaToLinear(m_Color × intensity)', () => {
    for (const { id, sun } of shipped()) {
      const oracle = unityLightLinear(sun.colorGamma, sun.intensity)
      for (let c = 0; c < 3; c++) {
        // colorGamma is the six-place rounding of what the extractor read, so
        // the bound is a few units in the sixth place, not zero.
        expect((sun.colorLinear[c] as number) * sun.intensity, `${id}[${c}]`).toBeCloseTo(
          oracle[c] as number,
          5,
        )
      }
    }
  })

  it('folds the intensity in BEFORE the curve: 0.5 at 1 and 1 at 0.5 are one light', () => {
    const a = unity54LightLinear({ r: 0.5, g: 0.5, b: 0.5 }, 1).map((x) => x * 1)
    const b = unity54LightLinear({ r: 1, g: 1, b: 1 }, 0.5).map((x) => x * 0.5)
    for (let c = 0; c < 3; c++) expect(a[c]).toBeCloseTo(b[c] as number, 5)
  })

  it('draws every mission’s sun a deeper colour than its raw m_Color', () => {
    for (const { id, sun } of shipped()) {
      expect(saturation(sun.colorLinear), id).toBeLessThan(saturation(sun.colorGamma))
    }
  })
})

describe('the hand-authored courses carry the same sun as the mission they copy', () => {
  it('every authored sun is exactly a shipped mission’s', () => {
    const rows = authored()
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      const twin = shipped().find(
        (s) =>
          s.sun.intensity === r.sun.intensity &&
          s.sun.colorGamma.every((v, i) => v === r.sun.colorGamma[i]),
      )
      expect(twin, `${r.file}: no shipped mission has this sun`).toBeTruthy()
      expect(r.sun.colorLinear, r.file).toEqual(twin?.sun.colorLinear)
    }
  })
})

describe('?sunlight=port — the old rule, for A/B, at the one door', () => {
  const level = () =>
    JSON.parse(fs.readFileSync('content/levels/int_01_hoverJet.json', 'utf8')) as Level

  it('is only reached by name; anything else is 2016’s', () => {
    expect(sunLightRuleFrom('port')).toBe('port')
    for (const other of [null, '', '2016', 'unity54', 'PORT']) {
      expect(sunLightRuleFrom(other)).toBe('unity54')
    }
  })

  it('2016’s rule hands back the loaded level itself — nothing to do, nothing copied', () => {
    const l = level()
    expect(withSunLightRule(l, 'unity54')).toBe(l)
  })

  it('the port’s rule swaps ONLY the sun’s colour, to the raw m_Color, and leaves the input alone', () => {
    const l = level()
    const before = JSON.stringify(l)
    const port = withSunLightRule(l, 'port')
    expect(port.lighting.sun?.colorLinear).toEqual(l.lighting.sun?.colorGamma)
    expect(port.lighting.sun?.intensity).toBe(l.lighting.sun?.intensity)
    expect(port.lighting.sun?.direction).toEqual(l.lighting.sun?.direction)
    expect(port.lighting.ambient).toBe(l.lighting.ambient)
    expect(port.routes).toBe(l.routes)
    expect(JSON.stringify(l)).toBe(before)
  })
})
