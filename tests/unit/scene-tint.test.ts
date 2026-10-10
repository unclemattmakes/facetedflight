// tests/unit/scene-tint.test.ts — DEV-446: the scene tint is a luma-preserving
// filter, drawn only when it has work, sorted between the world and the UI,
// shipped neutral, and off on Classic.
//
// What these tests cannot say: whether a tint LOOKS right, which is Matt's call
// on a lap (hard rule 9), or that its program links, which needs a GPU
// (`tests/e2e/scene-tint.spec.ts` and `shader-link.spec.ts`). What they can say
// is everything that is arithmetic or structure — and the ordering claim is
// held against the real UI objects that can be built without a DOM, while the
// e2e spec holds it against every UI surface in a live mission.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { colorToHex, hexToColor } from '@/boot/lookdev'
import { sceneTintLookdevGroup } from '@/boot/lookdev-scene-tint'
import {
  type Edition,
  type EditionSceneTint,
  editionFeatures,
  type SceneTintValue,
  validateEdition,
} from '@/content/edition-schema'
import { isUiObject } from '@/render/bloom'
import { createHorizon } from '@/render/horizon'
import {
  createSceneTint,
  IDENTITY_EPSILON,
  isIdentityGain,
  LUMA_709,
  MAX_GAIN,
  resolveSceneTint,
  SCENE_TINT_IDENTITY,
  SCENE_TINT_ORDER,
  sceneTintGain,
} from '@/render/scene-tint'
import { createVignette } from '@/render/vignette'
import { editionJson as read } from './helpers/content'

const luma = (g: readonly number[]): number =>
  LUMA_709[0] * (g[0] as number) + LUMA_709[1] * (g[1] as number) + LUMA_709[2] * (g[2] as number)

const v = (color: [number, number, number], strength: number): SceneTintValue => ({
  color,
  strength,
})

const block = (over: Partial<EditionSceneTint> = {}): EditionSceneTint => ({
  enabled: true,
  default: SCENE_TINT_IDENTITY,
  missions: {},
  ...over,
})

/** What GL's blend unit computes for one channel, from the material's own factors. */
const blend = (material: THREE.Material, src: number, dst: number): number => {
  const factor = (f: THREE.BlendingSrcFactor | THREE.BlendingDstFactor | null | undefined) => {
    switch (f) {
      case THREE.DstColorFactor:
        return dst
      case THREE.SrcColorFactor:
        return src
      case THREE.OneFactor:
        return 1
      case THREE.ZeroFactor:
        return 0
      default:
        throw new Error(`blend factor ${String(f)} is not one this test models`)
    }
  }
  expect(material.blendEquation).toBe(THREE.AddEquation)
  return src * factor(material.blendSrc) + dst * factor(material.blendDst)
}

describe('the gain: a luma-preserving filter', () => {
  it('is identity at strength 0, whatever the colour — black and pure red included', () => {
    for (const c of [
      [1, 0, 0],
      [0, 0, 0],
      [0.2, 0.9, 0.4],
    ] as [number, number, number][]) {
      expect(sceneTintGain(v(c, 0))).toEqual([1, 1, 1])
    }
  })

  it('is identity for white at any strength, and for any grey', () => {
    for (const s of [0.25, 0.5, 1]) {
      for (const g of [1, 0.5, 0.1]) {
        const gain = sceneTintGain(v([g, g, g], s))
        for (const x of gain) expect(x).toBeCloseTo(1, 12)
      }
    }
  })

  it('keeps a neutral pixel’s luma exactly while the hue moves, wherever it does not clip', () => {
    for (const c of [
      [1, 0.8, 0.6],
      [0.6, 0.75, 1],
      [0.9, 0.7, 0.8],
      [0.5, 0.55, 0.4],
    ] as [number, number, number][]) {
      for (const s of [0.1, 0.5, 1]) {
        const gain = sceneTintGain(v(c, s))
        // The premise the luma claim needs: nothing clipped.
        for (const x of gain) expect(x > 0 && x < MAX_GAIN).toBe(true)
        expect(luma(gain)).toBeCloseTo(1, 12)
      }
    }
  })

  it('leans the frame TOWARD the colour: a warm pick lifts red and drops blue', () => {
    const [r, g, b] = sceneTintGain(v([1, 0.8, 0.6], 0.5))
    expect(r).toBeGreaterThan(1)
    expect(b).toBeLessThan(1)
    expect(r).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(b)
  })

  it('ignores the colour’s brightness: a colour and its half are the same tint', () => {
    expect(sceneTintGain(v([0.5, 0.4, 0.3], 0.7))).toEqual(sceneTintGain(v([1, 0.8, 0.6], 0.7)))
  })

  it('grows with strength, monotonically, from none to all of it', () => {
    let last = 1
    for (let s = 0; s <= 1.0001; s += 0.1) {
      const r = sceneTintGain(v([1, 0.7, 0.5], s))[0]
      expect(r).toBeGreaterThanOrEqual(last)
      last = r
    }
  })

  it('clamps to what the blend can do, 0..2, and never returns NaN', () => {
    // Pure red: red / luma is 4.7, past the blend's 2.
    expect(sceneTintGain(v([1, 0, 0], 1))).toEqual([MAX_GAIN, 0, 0])
    // Black: no hue to divide out, so it darkens smoothly instead of exploding.
    const dark = sceneTintGain(v([0, 0, 0], 0.4))
    for (const x of dark) {
      expect(Number.isFinite(x)).toBe(true)
      expect(x).toBeCloseTo(0.6, 12)
    }
    // A strength outside 0..1 is clamped, not extrapolated.
    expect(sceneTintGain(v([1, 0.8, 0.6], 3))).toEqual(sceneTintGain(v([1, 0.8, 0.6], 1)))
  })

  it('writes into the array it is handed, so the per-frame call allocates nothing', () => {
    const out: [number, number, number] = [0, 0, 0]
    expect(sceneTintGain(v([1, 0.8, 0.6], 0.5), out)).toBe(out)
  })
})

describe('identity means no pixel moves', () => {
  it('draws nothing inside the epsilon, and something just outside it', () => {
    expect(isIdentityGain([1, 1, 1])).toBe(true)
    expect(isIdentityGain([1 + IDENTITY_EPSILON / 2, 1, 1 - IDENTITY_EPSILON / 2])).toBe(true)
    expect(isIdentityGain([1, 1 + IDENTITY_EPSILON * 2, 1])).toBe(false)
  })

  it('the epsilon moves the brightest 8-bit value by under half a level, so it rounds away', () => {
    expect(255 * IDENTITY_EPSILON).toBeLessThan(0.5)
  })
})

describe('which value a level gets', () => {
  const warm = v([1, 0.8, 0.6], 0.5)
  const cool = v([0.6, 0.75, 1], 0.3)

  it('takes the mission’s own row when the block names it, the default when not', () => {
    const b = block({ default: cool, missions: { int_01_hoverJet: warm } })
    expect(resolveSceneTint(b, 'int_01_hoverJet')).toBe(warm)
    expect(resolveSceneTint(b, 'adv_01_hoverJet')).toBe(cool)
    expect(resolveSceneTint(b, null)).toBe(cool)
  })

  it('is identity when the flag is off, whatever the rows say — Classic', () => {
    const b = block({ enabled: false, default: cool, missions: { int_01_hoverJet: warm } })
    expect(resolveSceneTint(b, 'int_01_hoverJet')).toBe(SCENE_TINT_IDENTITY)
  })

  it('is not fooled by a level id that is an Object prototype key', () => {
    const b = block({ default: cool })
    expect(resolveSceneTint(b, 'constructor')).toBe(cool)
    expect(resolveSceneTint(b, 'toString')).toBe(cool)
  })
})

describe('the quad', () => {
  const warm = v([1, 0.8, 0.6], 0.5)

  it('is not drawn at identity — every mission on both presets as shipped', () => {
    const tint = createSceneTint()
    for (const id of ['classic', 'anniversary']) {
      tint.update(read(id).render.sceneTint, 'int_01_hoverJet', true)
      expect(tint.report.drawn, id).toBe(false)
      expect(tint.object.visible, id).toBe(false)
    }
  })

  it('is drawn for an authored tint on a mission’s world, and only there', () => {
    const tint = createSceneTint()
    const b = block({ missions: { int_01_hoverJet: warm } })
    tint.update(b, 'int_01_hoverJet', true)
    expect(tint.report.drawn).toBe(true)
    tint.update(b, 'int_01_hoverJet', false)
    expect(tint.report.drawn).toBe(false)
    tint.update(b, 'adv_01_hoverJet', true)
    expect(tint.report.drawn).toBe(false)
  })

  it('writes HALF the gain, because the blend doubles it: dst × gain, exactly', () => {
    const tint = createSceneTint()
    tint.update(block({ default: warm }), 'x', true)
    const gain = sceneTintGain(warm)
    const u = (tint.object.material as THREE.ShaderMaterial).uniforms.uHalfGain
      ?.value as THREE.Vector3
    expect(u.toArray()).toEqual(gain.map((g) => g / 2))
    const material = tint.object.material as THREE.Material
    for (const dst of [0, 0.25, 0.5, 1]) {
      expect(blend(material, u.x, dst)).toBeCloseTo(dst * gain[0], 12)
      expect(blend(material, u.z, dst)).toBeCloseTo(dst * gain[2], 12)
    }
  })

  it('leaves the destination’s alpha exactly as it was', () => {
    const m = createSceneTint().object.material as THREE.Material
    expect(m.blending).toBe(THREE.CustomBlending)
    expect(m.blendSrcAlpha).toBe(THREE.ZeroFactor)
    expect(m.blendDstAlpha).toBe(THREE.OneFactor)
  })

  it('lets the lookdev value win while set, hands back on null, and never outranks the flag', () => {
    const tint = createSceneTint()
    const b = block()
    tint.setOverride(warm)
    tint.update(b, 'int_01_hoverJet', true)
    expect(tint.report.drawn).toBe(true)
    expect(tint.report.gain).toEqual(sceneTintGain(warm))
    tint.update({ ...b, enabled: false }, 'int_01_hoverJet', true)
    expect(tint.report.drawn).toBe(false)
    tint.setOverride(null)
    tint.update(b, 'int_01_hoverJet', true)
    expect(tint.report.drawn).toBe(false)
  })

  it('is a quad whose positions ARE normalised device coordinates, never culled', () => {
    const tint = createSceneTint()
    const pos = tint.object.geometry.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      expect(Math.abs(pos.getX(i))).toBe(1)
      expect(Math.abs(pos.getY(i))).toBe(1)
    }
    expect(tint.object.frustumCulled).toBe(false)
    const m = tint.object.material as THREE.ShaderMaterial
    expect(m.depthTest).toBe(false)
    expect(m.depthWrite).toBe(false)
    expect(m.transparent).toBe(true)
  })

  it('is classified as modifying the frame — so the composite draws it in the UI pass, after the curve', () => {
    expect(isUiObject(createSceneTint().object)).toBe(true)
  })

  it('sorts above a world transparent and below the UI surfaces that can be built here', () => {
    // The default renderOrder every world transparent is born with.
    expect(SCENE_TINT_ORDER).toBeGreaterThan(new THREE.Object3D().renderOrder)
    expect(SCENE_TINT_ORDER).toBeLessThan(createHorizon().object.renderOrder)
    expect(SCENE_TINT_ORDER).toBeLessThan(createVignette().object.renderOrder)
    expect(createSceneTint().object.renderOrder).toBe(SCENE_TINT_ORDER)
  })
})

describe('the presets', () => {
  it('ship it neutral: Anniversary on with an identity default and no rows, Classic off', () => {
    const a = read('anniversary').render.sceneTint
    expect(a.enabled).toBe(true)
    expect(isIdentityGain(sceneTintGain(a.default))).toBe(true)
    expect(read('classic').render.sceneTint.enabled).toBe(false)
  })

  it('is a registered feature, so vr.disable and ?feature= can name it', () => {
    expect(editionFeatures(read('anniversary')).map(([p]) => p)).toContain('render.sceneTint')
  })

  it('names only levels that exist, in both presets', () => {
    const ids = new Set<string>()
    for (const dir of ['content/levels', 'content/authored']) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json') || f.startsWith('_')) continue
        const id = (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { id?: unknown }).id
        if (typeof id === 'string') ids.add(id)
      }
    }
    expect(ids.has('int_01_hoverJet')).toBe(true)
    for (const e of ['classic', 'anniversary']) {
      for (const level of Object.keys(read(e).render.sceneTint.missions)) {
        expect(ids.has(level), `${e}: render.sceneTint.missions.${level}`).toBe(true)
      }
    }
  })

  it('refuses at load every hole that would render black or throw later, naming the key', () => {
    const bad = (mutate: (t: { default: unknown; missions: unknown }) => void, message: RegExp) => {
      const e = read('anniversary') as unknown as {
        render: { sceneTint: { default: unknown; missions: unknown } }
      }
      mutate(e.render.sceneTint)
      expect(() => validateEdition(e as unknown as Edition)).toThrow(message)
    }
    bad((t) => {
      t.default = { color: [1, 1], strength: 0 }
    }, /render\.sceneTint\.default\.color/)
    bad((t) => {
      t.default = { color: [1, 1, 1.2], strength: 0 }
    }, /render\.sceneTint\.default\.color/)
    bad((t) => {
      t.default = { color: [1, 1, 1], strength: Number.NaN }
    }, /render\.sceneTint\.default\.strength/)
    bad((t) => {
      t.missions = []
    }, /render\.sceneTint\.missions/)
    bad((t) => {
      t.missions = { int_01_hoverJet: { color: [1, 0.8, 0.6], strength: 2 } }
    }, /render\.sceneTint\.missions\.int_01_hoverJet\.strength/)
  })
})

describe('the ?lookdev=1 group', () => {
  const tint = () => {
    let value: SceneTintValue | null = SCENE_TINT_IDENTITY
    return {
      setOverride: (next: SceneTintValue | null) => {
        value = next
      },
      get value() {
        return value
      },
    }
  }

  it('is absent on Classic, where it would be inert', () => {
    expect(sceneTintLookdevGroup(tint(), read('classic'), 'int_01_hoverJet')).toBeNull()
  })

  it('clears the last world’s value when it is built, and writes the override when touched', () => {
    const t = tint()
    const group = sceneTintLookdevGroup(t, read('anniversary'), 'int_01_hoverJet')
    expect(t.value).toBeNull()
    group?.colors?.[0]?.set([1, 0.8, 0.6])
    group?.controls[0]?.set(0.5)
    expect(t.value).toEqual({ color: [1, 0.8, 0.6], strength: 0.5 })
  })

  it('copies the exact row for the mission being flown, in the preset’s own shape', () => {
    const group = sceneTintLookdevGroup(tint(), read('anniversary'), 'adv_02_hoverJet')
    group?.colors?.[0]?.set([0.93333, 0.8, 0.6])
    group?.controls[0]?.set(0.35)
    expect(group?.json?.path).toBe(
      'content/editions/anniversary.json render.sceneTint.missions.adv_02_hoverJet',
    )
    const row = group?.json?.value() as SceneTintValue
    expect(row).toEqual({ color: [0.9333, 0.8, 0.6], strength: 0.35 })
    // And what it copies is a row the loader takes.
    const e = read('anniversary')
    const next = {
      ...e,
      render: {
        ...e.render,
        sceneTint: { ...e.render.sceneTint, missions: { adv_02_hoverJet: row } },
      },
    }
    expect(() => validateEdition(next)).not.toThrow()
  })

  it('round-trips the picker’s hex exactly at its own 8 bits', () => {
    for (let i = 0; i < 256; i += 17) {
      const c: [number, number, number] = [i / 255, (255 - i) / 255, 1]
      expect(hexToColor(colorToHex(c))).toEqual(c)
    }
    expect(colorToHex([1.5, -1, 0.5])).toBe('#ff0080')
  })
})

describe("DEV-476 — a player course's own tint", () => {
  const warm = v([1, 0.8, 0.6], 0.5)
  const cool = v([0.6, 0.8, 1], 0.4)

  it('stands in for the preset on that course, and only while it is given', () => {
    const tint = createSceneTint()
    const b = block({ default: cool })
    tint.update(b, 'pc_0123456789ab', true, warm)
    expect(tint.report.gain).toEqual(sceneTintGain(warm))
    tint.update(b, 'pc_0123456789ab', true, null)
    expect(tint.report.gain).toEqual(sceneTintGain(cool))
  })

  it('at amount 0 is no tint, even over a preset default that has one', () => {
    const tint = createSceneTint()
    tint.update(block({ default: cool }), 'pc_0123456789ab', true, v([1, 0, 0], 0))
    expect(tint.report.drawn).toBe(false)
  })

  it('loses to the lookdev override, and never outranks the flag (Classic draws none)', () => {
    const tint = createSceneTint()
    const b = block()
    tint.setOverride(cool)
    tint.update(b, 'pc_0123456789ab', true, warm)
    expect(tint.report.gain).toEqual(sceneTintGain(cool))
    tint.setOverride(null)
    tint.update({ ...b, enabled: false }, 'pc_0123456789ab', true, warm)
    expect(tint.report.drawn).toBe(false)
    expect(tint.report.gain).toEqual([1, 1, 1])
  })
})
