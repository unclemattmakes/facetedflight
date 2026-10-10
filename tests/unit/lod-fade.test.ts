// tests/unit/lod-fade.test.ts — the LOD cross-fade's render half (DEV-130).
//
// What can be proved without a GPU: the GLSL lands where it should and only
// there, the base material draws the identity, a clone shares the base's
// program and carries its own uniform, the pool returns what it lends, and the
// duration is the sheet's number times the preset's ratio.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { type Edition, validateEdition } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import { TERRAIN } from '@/generated/constants.generated'
import { createFarShadow } from '@/render/far-shadow'
import {
  createLodFadePool,
  LOD_FADE_DEFINE,
  LOD_FADE_INCLUDE,
  LOD_FADE_MAIN,
  LOD_FADE_POOL_CAP,
  lodFadePatchFragment,
  lodFadeSeconds,
  lodFadeUniformOf,
  variantKey,
} from '@/render/lod-fade'
import { fogFlag, setFogFlag } from '@/render/program-cache-key'
import { createUnityFog } from '@/render/unity-fog'
import { applyWaterWaves } from '@/render/water'
import anniversaryJson from '../../content/editions/anniversary.json'

const terrainLike = () =>
  new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0, side: THREE.FrontSide })

const fog = () =>
  createUnityFog({
    mode: 2,
    density: 0.00025,
    linearStart: 100,
    linearEnd: 2500,
    color: [0.87, 0.66, 0.7],
    distanceFog: true,
    heightFog: true,
    useRadialDistance: true,
    height: 387,
    heightDensity: 0.03,
    startDistance: 256,
  })

describe('the GLSL', () => {
  it('splices into the real stock physical fragment shader, once, after the clipping planes', () => {
    const stock = THREE.ShaderLib.physical.fragmentShader
    expect(stock).toContain(LOD_FADE_INCLUDE)
    const out = lodFadePatchFragment(stock)
    expect(out.split('uniform vec2 uLodFade;')).toHaveLength(2)
    // Seeded from the eye's pixel, both branches (DEV-556; eye-dither.test.ts).
    expect(out.split('ff2LodFadeDither( ff2EyePixel() )')).toHaveLength(3)
    // Declaration before main, test after the include.
    expect(out.indexOf('uniform vec2 uLodFade;')).toBeLessThan(out.indexOf('void main()'))
    expect(out.indexOf(LOD_FADE_INCLUDE)).toBeLessThan(out.indexOf(LOD_FADE_MAIN.trim()))
    // Every other include of the stock shader is still there.
    expect(out).toContain('#include <roughnessmap_fragment>')
    expect(out).toContain('#include <dithering_fragment>')
  })

  it('leaves a shader without the include, or without a main, exactly alone', () => {
    // The shadow pass never reaches this function at all — `WebGLShadowMap`
    // compiles its own `MeshDepthMaterial` and copies neither
    // `onBeforeCompile` nor the cache key across — so a fading chunk casts a
    // WHOLE shadow. These are the two shapes the function itself refuses.
    expect(lodFadePatchFragment('void main() { gl_FragColor = vec4( 1.0 ); }')).toBe(
      'void main() { gl_FragColor = vec4( 1.0 ); }',
    )
    expect(lodFadePatchFragment(LOD_FADE_INCLUDE)).toBe(LOD_FADE_INCLUDE)
  })

  it('is complementary: incoming keeps dither < t, outgoing keeps dither >= t', () => {
    // Read the two branches as text — the whole fade rests on them owning
    // disjoint, exhaustive halves of the dither's range.
    expect(LOD_FADE_MAIN).toContain('uLodFade.y > 0.5')
    expect(LOD_FADE_MAIN).toContain('>= uLodFade.x ) discard')
    expect(LOD_FADE_MAIN).toContain('uLodFade.y < -0.5')
    expect(LOD_FADE_MAIN).toContain('< uLodFade.x ) discard')
  })

  it('puts every discard behind the define, which is what removes it (DEV-184)', () => {
    // The structural one, in `water-underside.test.ts`'s shape and for the same
    // reason: an `#ifdef` is in `shader.fragmentShader` whichever material is
    // compiling it — the GLSL PREPROCESSOR is what strips the body — so a text
    // search for `discard` cannot tell the base from a clone. What it can say,
    // and what decides whether the driver's code generator ever sees one, is
    // that no `discard` sits outside a gate the defines control.
    //
    // This is the whole of DEV-184. A `discard` in the text costs late depth
    // write on every fragment of the terrain and the ocean whether the branch
    // is taken or not, and the base material draws 71 % of the frame.
    const pool = createLodFadePool()
    const base = terrainLike()
    pool.applyTo(base)
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    }
    base.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer)
    let open: string | null = null
    const ungated: string[] = []
    for (const line of shader.fragmentShader.split('\n')) {
      const ifdef = /#ifdef\s+(\w+)/.exec(line)
      if (ifdef) open = ifdef[1] as string
      else if (line.includes('#endif')) open = null
      else if (line.includes('discard') && !line.trimStart().startsWith('//')) {
        if (open !== LOD_FADE_DEFINE) ungated.push(line.trim())
      }
    }
    expect(ungated).toEqual([])
    // …and the gate is really there, so an empty list cannot mean the discards
    // were deleted rather than gated.
    expect(shader.fragmentShader).toContain(`#ifdef ${LOD_FADE_DEFINE}`)
    expect(shader.fragmentShader).toContain('discard')
  })

  it('defines the gate on the CLONE and not on the base', () => {
    // The other half, and the half the text cannot show. `Material.copy` resets
    // a built-in's `defines` to its own set, so this is put on after the clone
    // rather than inherited — and if it ever stopped being put on, the fade
    // would compile without its discard and do nothing, silently.
    const pool = createLodFadePool()
    const base = terrainLike()
    pool.applyTo(base)
    const pair = pool.acquire(base)
    expect(pair).not.toBeNull()
    if (!pair) return
    expect(base.defines?.[LOD_FADE_DEFINE]).toBeUndefined()
    expect(pair.incoming.defines?.[LOD_FADE_DEFINE]).toBeDefined()
    expect(pair.outgoing.defines?.[LOD_FADE_DEFINE]).toBeDefined()
    // The base keeps everything three's own constructor put there — dropping
    // `PHYSICAL` would change the program in a way nobody asked for.
    expect(base.defines?.STANDARD).toBeDefined()
    expect(pair.incoming.defines?.STANDARD).toBeDefined()
  })

  it('uses no GLSL ES reserved word as an identifier', () => {
    const reserved = ['half', 'fixed', 'input', 'output', 'filter', 'sizeof', 'cast', 'namespace']
    const words = new Set(
      LOD_FADE_MAIN.concat(lodFadePatchFragment(LOD_FADE_INCLUDE)).match(/[A-Za-z_]\w*/g),
    )
    for (const r of reserved) expect(words.has(r), r).toBe(false)
  })
})

describe('the base material', () => {
  it('is tagged, so a fading material cannot borrow an unfaded program', () => {
    const pool = createLodFadePool()
    const a = terrainLike()
    const b = terrainLike()
    pool.applyTo(a)
    expect(a.customProgramCacheKey()).not.toBe(b.customProgramCacheKey())
    expect(a.customProgramCacheKey()).toContain('lod-fade')
  })

  it('is idempotent and chains onto the fog', () => {
    const pool = createLodFadePool()
    const m = terrainLike()
    fog().applyTo(m)
    pool.applyTo(m)
    pool.applyTo(m)
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    }
    m.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer)
    expect(shader.fragmentShader.split('uniform vec2 uLodFade;')).toHaveLength(2)
    // The fog's own uniform arrived too: the chain held.
    expect(Object.keys(shader.uniforms)).toContain('uLodFade')
    expect(Object.keys(shader.uniforms).some((k) => /fog/i.test(k))).toBe(true)
  })

  it('installs the OFF uniform on the base — mode 0, never written', () => {
    const pool = createLodFadePool()
    const m = terrainLike()
    pool.applyTo(m)
    const shader = {
      uniforms: {} as Record<string, { value: THREE.Vector2 }>,
      vertexShader: '',
      fragmentShader: '',
    }
    m.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer)
    expect(shader.uniforms.uLodFade?.value.y).toBe(0)
    const pair = pool.acquire(m)
    pair?.setCoverage(0.7)
    expect(shader.uniforms.uLodFade?.value.y).toBe(0)
  })
})

describe('the clones', () => {
  it('do NOT share the base program key — a clone with the base program cannot fade', () => {
    // This used to assert the opposite, and that was right while the base and
    // the clone compiled the same text. DEV-184 gave the clone a `#define` the
    // base does not carry, so a shared key would be the silent failure: three
    // would hand the clone the base's program, the `discard` would not be in
    // it, and the fade would do nothing at all while every other test here
    // stayed green.
    const pool = createLodFadePool()
    const base = terrainLike()
    fog().applyTo(base)
    pool.applyTo(base)
    const pair = pool.acquire(base)
    expect(pair).not.toBeNull()
    if (!pair) return
    expect(pair.incoming).not.toBe(base)
    expect(pair.outgoing).not.toBe(pair.incoming)
    expect(pair.incoming.customProgramCacheKey()).not.toBe(base.customProgramCacheKey())
    expect(pair.outgoing.customProgramCacheKey()).not.toBe(base.customProgramCacheKey())
    // …and the two clones DO share one, so a pool of clones is one program.
    expect(pair.incoming.customProgramCacheKey()).toBe(pair.outgoing.customProgramCacheKey())
    // The clone's chain is the base's chain plus its own uniform.
    const shader = {
      uniforms: {} as Record<string, { value: THREE.Vector2 }>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    }
    pair.incoming.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer)
    expect(shader.uniforms.uLodFade).toBe(lodFadeUniformOf(pair.incoming))
    expect(shader.fragmentShader).toContain('ff2LodFadeDither')
    expect(Object.keys(shader.uniforms).some((k) => /fog/i.test(k))).toBe(true)
  })

  it('keep the base parameters that decide the program', () => {
    const pool = createLodFadePool()
    const base = terrainLike()
    base.specularColor.setRGB(0.5, 0.6, 0.7)
    base.roughness = 0.17
    pool.applyTo(base)
    const pair = pool.acquire(base)
    if (!pair) throw new Error('no pair')
    const c = pair.incoming as THREE.MeshPhysicalMaterial
    expect(c.vertexColors).toBe(true)
    expect(c.metalness).toBe(0)
    expect(c.roughness).toBe(0.17)
    expect(c.specularColor.g).toBeCloseTo(0.6, 9)
  })

  it('setCoverage drives incoming +1 and outgoing -1 to the same t, clamped', () => {
    const pool = createLodFadePool()
    const base = terrainLike()
    pool.applyTo(base)
    const pair = pool.acquire(base)
    if (!pair) throw new Error('no pair')
    const fin = lodFadeUniformOf(pair.incoming)
    const fout = lodFadeUniformOf(pair.outgoing)
    expect(fin?.value.toArray()).toEqual([0, 1])
    expect(fout?.value.toArray()).toEqual([0, -1])
    pair.setCoverage(0.3)
    expect(fin?.value.toArray()).toEqual([0.3, 1])
    expect(fout?.value.toArray()).toEqual([0.3, -1])
    pair.setCoverage(1.7)
    expect(fin?.value.x).toBe(1)
    pair.setCoverage(-2)
    expect(fout?.value.x).toBe(0)
  })

  it('are pooled: a released pair is lent again, quiet, and the count does not grow', () => {
    const pool = createLodFadePool()
    const base = terrainLike()
    pool.applyTo(base)
    const first = pool.acquire(base)
    if (!first) throw new Error('no pair')
    first.setCoverage(0.5)
    expect(pool.cloneCount).toBe(2)
    expect(pool.inUse).toBe(2)
    pool.release(first)
    expect(pool.inUse).toBe(0)
    expect(lodFadeUniformOf(first.incoming)?.value.y).toBe(0)
    const second = pool.acquire(base)
    expect(pool.cloneCount).toBe(2)
    expect([second?.incoming, second?.outgoing]).toEqual(
      expect.arrayContaining([first.incoming, first.outgoing]),
    )
  })

  it('steps aside at the cap rather than allocating without bound', () => {
    const pool = createLodFadePool()
    const base = terrainLike()
    pool.applyTo(base)
    const pairs = []
    for (let i = 0; i < LOD_FADE_POOL_CAP / 2; i++) {
      const p = pool.acquire(base)
      expect(p).not.toBeNull()
      pairs.push(p)
    }
    expect(pool.acquire(base)).toBeNull()
    pool.release(pairs[0] as NonNullable<(typeof pairs)[0]>)
    expect(pool.acquire(base)).not.toBeNull()
  })

  it('refuses to clone a material that was never patched', () => {
    const pool = createLodFadePool()
    expect(() => pool.acquire(terrainLike())).toThrow(/before applyTo/)
  })
})

describe('the duration is the sheet times the ratio', () => {
  it("is 2016's own authored second on Simonet at scale 1, and 0.6 s on its ocean", () => {
    const islands = TERRAIN.simonet.terrains.islands.lodTransitionTime
    const ocean = TERRAIN.simonet.terrains.ocean.lodTransitionTime
    expect(islands).toBe(1)
    expect(ocean).toBe(0.6)
    expect(lodFadeSeconds({ durationScale: 1 }, islands)).toBe(1)
    expect(lodFadeSeconds({ durationScale: 1 }, ocean)).toBeCloseTo(0.6, 9)
    expect(lodFadeSeconds({ durationScale: 0.5 }, islands)).toBe(0.5)
  })

  it('is null — the one-assignment swap — on Classic, at scale 0, and with no authored time', () => {
    expect(lodFadeSeconds(null, 1)).toBeNull()
    expect(lodFadeSeconds(undefined, 1)).toBeNull()
    expect(lodFadeSeconds({ durationScale: 0 }, 1)).toBeNull()
    expect(lodFadeSeconds({ durationScale: 1 }, null)).toBeNull()
    expect(lodFadeSeconds({ durationScale: 1 }, undefined)).toBeNull()
    expect(lodFadeSeconds({ durationScale: Number.NaN }, 1)).toBeNull()
  })

  it('every shipped terrain carries an authored transition time', () => {
    for (const [env, e] of Object.entries(TERRAIN)) {
      for (const [name, t] of Object.entries(
        (e as { terrains: Record<string, { lodTransitionTime?: number }> }).terrains,
      )) {
        expect(t.lodTransitionTime, `${env}.${name}`).toBeGreaterThan(0)
      }
    }
  })
})

// ── DEV-186 follow-up: a clone must carry the BASE's defines ──────────────
//
// `Material.copy` resets `this.defines` to the subclass's own set, so a clone
// is born without whatever the base was given at runtime — while faithfully
// copying `side`. The sea is where that stops being tidiness: `render/water.ts`
// pairs `FF2_WATER_TWO_SIDED` with `side = DoubleSide`, so a fading ocean chunk
// was drawing two-sided with no hardware cull AND no discard — DEV-050's 35.6 %
// grazing-speckle regime, and DEV-106's sea back across the launch tube.
//
// Simonet's ocean has `lodLevels: 6` and `lodTransitionTime: 0.6`, so it fades.
describe('a fade clone inherits the material it is cloned from', () => {
  it('carries the base defines as well as its own', () => {
    const pool = createLodFadePool()
    const base = new THREE.MeshStandardMaterial()
    base.defines = { FF2_WATER_TWO_SIDED: '', FF2_WATER_SHAFT: '' }
    pool.applyTo(base)
    const pair = pool.acquire(base)
    expect(pair).not.toBeNull()
    for (const m of [pair?.incoming, pair?.outgoing]) {
      expect(m?.defines).toMatchObject({
        FF2_WATER_TWO_SIDED: '',
        FF2_WATER_SHAFT: '',
        [LOD_FADE_DEFINE]: '',
      })
    }
    pool.dispose()
  })

  it('re-syncs a POOLED clone, which was cut under the old variant', () => {
    // The case a birth-time copy misses: the eye crosses the sea surface while
    // chunks are fading, the base drops a define, and the pool hands back a
    // clone that still has it. Releasing and re-acquiring is exactly what a
    // second fade does.
    const pool = createLodFadePool()
    const base = new THREE.MeshStandardMaterial()
    base.defines = { FF2_WATER_TWO_SIDED: '' }
    pool.applyTo(base)
    const first = pool.acquire(base)
    expect(first?.incoming.defines).toHaveProperty('FF2_WATER_TWO_SIDED')
    if (first) pool.release(first)

    // The breach: the sea goes single-sided.
    delete (base.defines as Record<string, string>).FF2_WATER_TWO_SIDED
    const second = pool.acquire(base)
    // The SAME two objects come back — the pool pops from the end, so which of
    // the pair is now `incoming` is not something to assert.
    const reused = [second?.incoming, second?.outgoing]
    expect(reused).toContain(first?.incoming)
    expect(reused).toContain(first?.outgoing)
    // ...with the define gone from both, and dirtied so three re-fetches.
    for (const m of reused) {
      expect(m?.defines).not.toHaveProperty('FF2_WATER_TWO_SIDED')
      expect(m?.defines).toHaveProperty(LOD_FADE_DEFINE)
    }
    pool.dispose()
  })

  it('keeps the SUBCLASS defines, which is why the base is the authority', () => {
    // `MeshStandardMaterial`'s constructor sets `defines.STANDARD`, and the
    // shader will not compile without it. Copying from the base carries it;
    // building the clone's defines from scratch would not, and this test is
    // what says so out loud. (`MeshPhysicalMaterial` adds `PHYSICAL` the same
    // way — the terrain is one or the other depending on its F0.)
    const pool = createLodFadePool()
    const base = new THREE.MeshStandardMaterial()
    expect(base.defines).toHaveProperty('STANDARD')
    pool.applyTo(base)
    const pair = pool.acquire(base)
    expect(Object.keys(pair?.incoming.defines ?? {}).sort()).toEqual(
      [LOD_FADE_DEFINE, 'STANDARD'].sort(),
    )
    pool.dispose()
  })
})

// ── DEV-189: `side` is the other half of the pair, and it was left behind ──
//
// The block above re-syncs a pooled clone's DEFINES. It does not re-sync
// `side`, and `copy()` only runs at birth — so the two halves of DEV-167's
// pair moved at different rates, and the hybrid stayed reachable. The case
// that matters is not exotic; it is the ordinary one:
//
//   `warmLodFade()` cuts the ocean's FIRST clone under the curtain, where the
//   base is two-sided with the shaft's bore live. That clone is pooled for the
//   rest of the mission. Lent back in flight it had `FF2_WATER_TWO_SIDED`
//   correctly removed and `side = DoubleSide` still on it — the same
//   two-sided-with-no-cull, moved out of the ride and into flight ABOVE the
//   water, which is exactly where DEV-167 measured the 35.6 %.
//
// Why the tests above stayed green through it: each builds `base.defines` by
// hand and never touches `base.side`, so the material's two halves could not
// disagree. CLAUDE.md's rule after `xr-input.test.ts` — a test that compares
// two of your own devices has not tested either. These drive the real
// `applyWaterWaves` and the real `createFarShadow` instead.

describe('a fade clone carries side and defines as ONE thing (DEV-189)', () => {
  /** The ocean material as `load-terrain.ts` builds it: pool first, then water. */
  const oceanLike = () => {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0 })
    const pool = createLodFadePool()
    pool.applyTo(material)
    const water = applyWaterWaves(material, TERRAIN.simonet.terrains.ocean.displace)
    return { material, pool, water }
  }

  it('the ride-born clone, lent back in flight, is not two-sided with no cull', () => {
    const { material, pool, water } = oceanLike()

    // Under the curtain. The eye is at the bottom of a shaft ~95 m under the
    // sea and the bore is live — the state `warmLodFade()` cuts the first
    // clone in, and the state it is then pooled in.
    water.setShaftBore(0, 0, 12, 120)
    water.setEyeHeight(-90, 0)
    expect(material.side).toBe(THREE.DoubleSide)
    expect(material.defines?.FF2_WATER_TWO_SIDED).toBe('')
    const warm = pool.acquire(material)
    if (!warm) throw new Error('no pair')
    pool.release(warm)

    // In flight: above the water, rim cleared, bore gone. The base is the
    // cheap variant DEV-167 W6 added.
    water.clearShaftBore()
    water.setEyeHeight(400, 0)
    expect(material.side).toBe(THREE.FrontSide)
    expect(material.defines?.FF2_WATER_TWO_SIDED).toBeUndefined()

    const flight = pool.acquire(material)
    if (!flight) throw new Error('no pair')
    // It really is the ride's clone flying — otherwise this proves nothing.
    expect([warm.incoming, warm.outgoing]).toContain(flight.incoming)
    for (const clone of [flight.incoming, flight.outgoing]) {
      expect(clone.defines?.FF2_WATER_TWO_SIDED).toBeUndefined()
      expect(clone.side, 'DoubleSide with no per-fragment cull is the hybrid').toBe(THREE.FrontSide)
    }
    pool.dispose()
  })

  it('hands out a clone whose side and cull agree, wherever the eye is', () => {
    // The invariant, swept rather than spot-checked, and asserted against
    // `variantKey` so it does not need a list of the water's defines to keep
    // in step with `water.ts`.
    const { material, pool, water } = oceanLike()
    const seen = new Set<string>()
    for (const eyeY of [1000, 200, 20, 3, -5, 3, 20, 200, 1000]) {
      water.setEyeHeight(eyeY, 0)
      const pair = pool.acquire(material)
      if (!pair) throw new Error('no pair')
      for (const clone of [pair.incoming, pair.outgoing]) {
        expect(variantKey(clone), `eye ${eyeY}`).toBe(variantKey(material))
        // Spelled out once, so the invariant is not merely true of
        // `variantKey`'s own idea of itself: DoubleSide iff the cull.
        expect(clone.side === THREE.DoubleSide, `eye ${eyeY}`).toBe(
          clone.defines?.FF2_WATER_TWO_SIDED !== undefined,
        )
      }
      seen.add(variantKey(material))
      pool.release(pair)
    }
    // …and the sweep really did cross the waterline, so an all-green run
    // cannot mean every acquire happened in one state.
    expect(seen.size).toBe(2)
    pool.dispose()
  })

  it("keeps far-shadow's FF2_SUN_GROUND, so a fading LAND chunk is still ground", () => {
    // The half nobody had written down. `far-shadow.ts` marks the ground with
    // `FF2_SUN_GROUND` through `applyGroundAtmosphere` and nothing else
    // (DEV-133: the far-field term judges the ground by its texel's swept
    // depth and everything else by its own height), so a clone that dropped it
    // was shaded as an OBJECT for the whole of its transition, beside settled
    // neighbours shaded as ground — a difference in the thing a cross-fade
    // exists to hide. Unlike the sea's, the land's fade really runs: DEV-184's
    // own e2e counted 33 chunks in one pass.
    //
    // The real module, the real Anniversary preset, in `boot/app.ts`'s order:
    // the pool patches the material at load, the ground door follows, clones
    // are cut later.
    const state = createEditionState(
      validateEdition(anniversaryJson as unknown as Edition),
      DEFAULT_SETTINGS,
    )
    const farShadow = createFarShadow(state)
    const pool = createLodFadePool()
    const base = terrainLike()
    pool.applyTo(base)
    farShadow.applyTo(base, 'ground')
    expect(base.defines?.FF2_SUN_GROUND).toBe('')
    const pair = pool.acquire(base)
    if (!pair) throw new Error('no pair')
    expect(pair.incoming.defines?.FF2_SUN_GROUND).toBe('')
    expect(pair.outgoing.defines?.FF2_SUN_GROUND).toBe('')
    // The land's define never moves, so it is still ONE clone program per
    // terrain material — DEV-184's `79 -> 80` keeps its shape.
    expect(pool.cloneCount).toBe(2)
    farShadow.dispose()
    pool.dispose()
  })

  it('variantKey is side, fog and the defines IN ORDER, and ignores the fade gate itself', () => {
    const a = terrainLike()
    const b = terrainLike()
    expect(variantKey(a)).toBe(variantKey(b))
    b.side = THREE.DoubleSide
    expect(variantKey(a)).not.toBe(variantKey(b))
    b.side = a.side
    b.defines = { ...(b.defines ?? {}), X: '' }
    expect(variantKey(a)).not.toBe(variantKey(b))
    // ── insertion order IS a variant, and this assertion used to say it was
    //    not (DEV-194) ────────────────────────────────────────────────────
    //
    // `getProgramCacheKey` walks `for (const name in parameters.defines)`, so
    // `{A,B}` and `{B,A}` are two cache keys for one piece of GLSL —
    // `tests/unit/water-fog-flag.test.ts` §1 reads that loop out of three's own
    // build rather than trusting this paragraph. `render/water.ts`'s variant
    // switch produced both orders, and the flip is `int_01_hoverJet`'s 178.6 ms
    // freeze at 77.2 s.
    //
    // The old `variantKey` sorted the keys away, so it reported "same state"
    // for two materials that compile separately — it agreed with itself while
    // the pool went on lending a clone whose program is not its base's.
    a.defines = { X: '', ...(a.defines ?? {}) }
    expect(Object.keys(a.defines ?? {})).not.toEqual(Object.keys(b.defines ?? {}))
    expect(variantKey(a)).not.toBe(variantKey(b))
    // Same set AND same order is the same state, which is what `syncVariant`
    // produces by spreading the base.
    a.defines = { ...(b.defines ?? {}) }
    expect(variantKey(a)).toBe(variantKey(b))
    // `fog` is in the key too. It cannot change a pixel in this build, which is
    // exactly why it needs an assertion rather than an eye — DEV-194 shipped
    // for as long as it did because there was nothing to see.
    setFogFlag(b, !fogFlag(b))
    expect(variantKey(a)).not.toBe(variantKey(b))
    setFogFlag(b, fogFlag(a))
    expect(variantKey(a)).toBe(variantKey(b))
    // The gate is the one define a clone has and its base does not, so it must
    // not make the two look like different states — the `acquire` comparison
    // would then re-sync and dirty every clone, every fade.
    b.defines = { ...(b.defines ?? {}), [LOD_FADE_DEFINE]: '' }
    expect(variantKey(a)).toBe(variantKey(b))
  })
})
