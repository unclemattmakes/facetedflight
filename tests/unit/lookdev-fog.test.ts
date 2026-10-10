// tests/unit/lookdev-fog.test.ts — the fog is ALL tunable in ?lookdev=1, every
// control moves the uniform it says it moves, and nothing is offered that the
// mission's fog would not read. DEV-455.
//
// Matt: *"let's keep our height fog - is it all tunable with lookdev enabled?"*
// "All" is checked structurally, not by listing: the keys the panel's controls
// hand to `UnityFog.retune` are compared with the keys `fog.tuning` reports, so
// a fog parameter added later without a control goes red here.

import { describe, expect, it } from 'vitest'
import { fogLookdevGroup } from '@/boot/lookdev-fog'
import {
  createUnityFog,
  FF2_FOG_REPLACEMENT,
  FF2_FOG_THINNING,
  type FogRetune,
  type UnityFog,
  type UnityFogParams,
} from '@/render/unity-fog'

const SKY_SH: readonly (readonly [number, number, number])[] = Array.from(
  { length: 9 },
  (_, i) => [0.3 / (i + 1), 0.25 / (i + 1), 0.2 / (i + 1)] as const,
)

/** `int_01_hoverJet`'s shape: exp fog, a decoded sky, FF2's replacement amounts. */
const EXP_WITH_SKY: UnityFogParams = {
  mode: 2,
  density: FF2_FOG_REPLACEMENT.density,
  linearStart: 100,
  linearEnd: 2500,
  color: [0.866667, 0.658824, 0.698039],
  distanceFog: true,
  heightFog: true,
  useRadialDistance: true,
  height: FF2_FOG_REPLACEMENT.height,
  heightDensity: FF2_FOG_REPLACEMENT.heightDensity,
  startDistance: 256,
  heightFogInverted: true,
  skySh: SKY_SH as [number, number, number][],
}
/** An alpine mission's shape: exp2, no decoded sky. */
const EXP2_NO_SKY: UnityFogParams = { ...EXP_WITH_SKY, mode: 3, skySh: null }
/** No shipped mission has a linear fog; the panel still has to be right for one. */
const LINEAR_WITH_SKY: UnityFogParams = { ...EXP_WITH_SKY, mode: 1 }

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4

/** A fog whose `retune` records every key it is handed, and still does its job. */
const recording = (p: UnityFogParams): { fog: UnityFog; keys: Set<string> } => {
  const fog = createUnityFog(p)
  const keys = new Set<string>()
  const real = fog.retune.bind(fog)
  const spy: UnityFog = Object.create(fog)
  Object.defineProperty(spy, 'retune', {
    value: (next: FogRetune) => {
      for (const k of Object.keys(next)) keys.add(k)
      real(next)
    },
  })
  Object.defineProperty(spy, 'tuning', { get: () => fog.tuning })
  return { fog: spy, keys }
}

/** Move every control, toggle and colour in the group once. */
const touchAll = (fog: UnityFog): void => {
  const g = fogLookdevGroup(fog, 'int_01_hoverJet')
  for (const c of g.colors ?? []) c.set([0.5, 0.6, 0.7])
  for (const c of g.controls) c.set((c.min + c.max) / 2)
  for (const t of g.toggles ?? []) t.set(!t.get())
}

describe('the fog is all tunable', () => {
  it('every parameter the fog reports has a control that moves it (a linear fog with a sky: all of them)', () => {
    const { fog, keys } = recording(LINEAR_WITH_SKY)
    touchAll(fog)
    const reported = Object.keys(fog.tuning).filter((k) => k !== 'mode' && k !== 'skyAvailable')
    expect([...keys].sort()).toEqual(reported.sort())
  })

  it('leaves out what this mission’s fog would not read: the linear pair on exp, the sky switch without a sky', () => {
    const labels = (p: UnityFogParams) => {
      const g = fogLookdevGroup(createUnityFog(p), 'x')
      return [...g.controls.map((c) => c.label), ...(g.toggles ?? []).map((t) => t.label)]
    }
    const exp = labels(EXP_WITH_SKY)
    expect(exp.some((l) => l.startsWith('linear'))).toBe(false)
    expect(exp.some((l) => l.startsWith('distance density'))).toBe(true)
    expect(exp.some((l) => l.includes("sky's colour"))).toBe(true)
    const noSky = labels(EXP2_NO_SKY)
    expect(noSky.some((l) => l.includes("sky's colour"))).toBe(false)
    const linear = labels(LINEAR_WITH_SKY)
    expect(linear.filter((l) => l.startsWith('linear'))).toHaveLength(2)
    expect(linear.some((l) => l.startsWith('distance density'))).toBe(false)
  })

  it('every control starts where the build is', () => {
    const fog = createUnityFog(EXP_WITH_SKY)
    const g = fogLookdevGroup(fog, 'x')
    const by = (prefix: string) => g.controls.find((c) => c.label.startsWith(prefix))
    expect(by('thinning')?.get()).toBe(1)
    expect(by('distance density')?.get()).toBeCloseTo(
      FF2_FOG_REPLACEMENT.density / FF2_FOG_THINNING,
      12,
    )
    expect(by('height density')?.get()).toBeCloseTo(0.03, 12)
    expect(by('plane height')?.get()).toBe(FF2_FOG_REPLACEMENT.height)
    expect(by('start distance')?.get()).toBe(256)
    expect(g.colors?.[0]?.get()).toEqual(EXP_WITH_SKY.color)
    expect(g.toggles?.map((t) => t.get())).toEqual([true, true, true, true])
  })

  it('every line ends in a source with a place for the number', () => {
    const g = fogLookdevGroup(createUnityFog(LINEAR_WITH_SKY), 'int_01_hoverJet')
    for (const s of [
      ...g.controls.map((c) => c.source),
      ...(g.toggles ?? []).map((t) => t.source),
      ...(g.colors ?? []).map((c) => c.source),
    ]) {
      expect(s).toContain('%')
    }
  })
})

describe('each control moves the uniform it names', () => {
  const setup = (p: UnityFogParams = EXP_WITH_SKY) => {
    const fog = createUnityFog(p)
    const g = fogLookdevGroup(fog, 'x')
    const control = (prefix: string) => {
      const c = g.controls.find((x) => x.label.startsWith(prefix))
      if (!c) throw new Error(`no control ${prefix}`)
      return c
    }
    const toggle = (needle: string) => {
      const t = g.toggles?.find((x) => x.label.includes(needle))
      if (!t) throw new Error(`no toggle ${needle}`)
      return t
    }
    return { fog, g, control, toggle }
  }

  it('the colour, sRGB in, linear in the uniform', () => {
    const { fog, g } = setup()
    g.colors?.[0]?.set([0.5, 0.25, 1])
    const c = fog.uniforms.uFogColor.value
    expect([c.r, c.g, c.b]).toEqual([srgbToLinear(0.5), srgbToLinear(0.25), srgbToLinear(1)])
    expect(fog.tuning.colorSrgb).toEqual([0.5, 0.25, 1])
  })

  it('the distance density, through the thinning, into the exp coefficient', () => {
    const { fog, control } = setup()
    control('distance density').set(0.0004)
    expect(fog.uniforms.uFogScene.value.y).toBeCloseTo(0.0004 * FF2_FOG_THINNING * Math.LOG2E, 12)
    control('thinning').set(2)
    expect(fog.uniforms.uFogScene.value.y).toBeCloseTo(
      0.0004 * FF2_FOG_THINNING * 2 * Math.LOG2E,
      12,
    )
  })

  it('the height density, through the thinning, into the half-space term', () => {
    const { fog, control } = setup()
    control('height density').set(0.1)
    expect(fog.uniforms.uFogHeight.value.w).toBeCloseTo(0.1 * FF2_FOG_THINNING * 0.5, 12)
  })

  it('the linear pair, into the linear slope and intercept', () => {
    const { fog, control } = setup(LINEAR_WITH_SKY)
    control('linear start').set(200)
    control('linear end').set(1200)
    expect(fog.uniforms.uFogScene.value.z).toBeCloseTo(-1 / 1000, 12)
    expect(fog.uniforms.uFogScene.value.w).toBeCloseTo(1.2, 12)
  })

  it('the two halves on and off, independently', () => {
    const { fog, toggle } = setup()
    toggle('distance fog').set(false)
    expect(fog.uniforms.uFogFlags.value.toArray()).toEqual([0, 1])
    toggle('height fog').set(false)
    expect(fog.uniforms.uFogFlags.value.toArray()).toEqual([0, 0])
    toggle('distance fog').set(true)
    expect(fog.uniforms.uFogFlags.value.toArray()).toEqual([1, 0])
  })

  it('the sky switch, and its refusal where there is no sky to fog toward', () => {
    const { fog, toggle } = setup()
    expect(fog.uniforms.uFogSkyMode.value).toBe(1)
    toggle("sky's colour").set(false)
    expect(fog.uniforms.uFogSkyMode.value).toBe(0)
    const noSky = createUnityFog(EXP2_NO_SKY)
    noSky.retune({ skyColour: true })
    expect(noSky.uniforms.uFogSkyMode.value).toBe(0)
  })

  it('a retune of one thing leaves the others where they were', () => {
    const fog = createUnityFog(EXP_WITH_SKY)
    const before = fog.tuning
    fog.retune({ height: 321 })
    expect({ ...fog.tuning, height: before.height }).toEqual(before)
  })
})
