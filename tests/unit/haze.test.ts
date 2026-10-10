// tests/unit/haze.test.ts — aerial perspective (DEV-082), and the promise that
// Classic does not have it.
//
// Two things are being held here and they are different promises.
//
//  1. **The term does what the row says**: nothing inside `startDistance`, the
//     full desaturation and tint at `startDistance + range`, and a ramp
//     between. `hazeColor` is the TypeScript mirror of `HAZE_GLSL`'s
//     `ff2AerialHaze` and the only half a unit test can reach — there is no GL
//     context here, and the shader is covered by eye on the viewpoints the DEV
//     row names.
//
//  2. **Classic contributes NOTHING.** Not "almost nothing": the shipped
//     preset has to render what it rendered before the Anniversary work, and
//     the way this feature is built — one program, gated on uniforms — that is
//     a claim about arithmetic rather than about a define. So it is asserted
//     with `toBe`, on exact floats, at seven distances.
//
// The fog chunk is pinned here too, verbatim from commit 2b2bb93 (the preset
// scaffold, before this feature existed). The haze lives inside the same
// `onBeforeCompile` as the fog, which is a good place to accidentally change
// the fog — and the fog's numbers are Matt's calls twice over (DEV-018,
// DEV-018b). A string comparison is a blunt instrument and that is the point.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  HAZE_LUMA,
  HAZE_OFF,
  type HazeSettings,
  type HazeTuning,
  hazeAmount,
  hazeColor,
  hazePack,
} from '@/render/haze'
import { createUnityFog, type UnityFogParams } from '@/render/unity-fog'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'

/**
 * The Anniversary preset's own numbers, tint LINEARISED — which is what the
 * shader sees and therefore what the mirror has to be fed.
 *
 * The transfer function is spelled out rather than imported: IEC 61966-2-1's
 * sRGB EOTF is a published standard, so writing it here is an outside
 * reference, while importing the port's copy would be re-deriving the
 * expectation the way the code does (CLAUDE.md, trap 24).
 */
const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4

const tuning = anniversary.render.haze as unknown as HazeTuning
const ANNIVERSARY: HazeSettings = {
  startDistance: tuning.startDistance,
  range: tuning.range,
  strength: tuning.strength,
  desaturate: tuning.desaturate,
  tint: [srgbToLinear(tuning.tint[0]), srgbToLinear(tuning.tint[1]), srgbToLinear(tuning.tint[2])],
}

/** Colours off the real scene, so the sweeps are over things the game draws. */
const SAMPLES: readonly (readonly [string, [number, number, number]])[] = [
  // `TERRAIN.simonet.islands.material.tint`, linearised — DEV-008.
  ['terrain tint', [0.725, 0.539, 0.478]],
  // The measured sunward horizon, DEV-008's sky row.
  ['sky horizon', [0.52, 0.32, 0.23]],
  // `int_01`'s fog colour, linear — the pink everything fades into.
  ['fog colour', [0.723, 0.392, 0.445]],
  ['near black', [0.02, 0.03, 0.05]],
  ['near white', [0.9, 0.95, 1]],
]

describe('the haze amount', () => {
  it('is zero at and inside the start distance', () => {
    for (const d of [0, 1, 100, 399.9, ANNIVERSARY.startDistance]) {
      expect(hazeAmount(d, ANNIVERSARY)).toBe(0)
    }
  })

  it('is one at and beyond start + range', () => {
    const full = ANNIVERSARY.startDistance + ANNIVERSARY.range
    for (const d of [full, full + 1, 6000, 1e9]) {
      expect(hazeAmount(d, ANNIVERSARY)).toBe(1)
    }
  })

  it('rises monotonically between them, and only there', () => {
    // The AMOUNT is the monotone quantity. See the note on `hazeAmount`: the
    // composed colour is quadratic in it, because the desaturation and the tint
    // multiply, so a single channel may turn around inside the range. Each term
    // is checked separately below.
    let previous = -1
    for (let d = 0; d <= 6000; d += 25) {
      const t = hazeAmount(d, ANNIVERSARY)
      expect(t).toBeGreaterThanOrEqual(previous)
      previous = t
    }
    // And it is a straight line between the two ends, not a curve.
    const mid = ANNIVERSARY.startDistance + ANNIVERSARY.range / 2
    expect(hazeAmount(mid, ANNIVERSARY)).toBeCloseTo(0.5, 12)
  })

  it('packs the reciprocal of the range, because a fragment should not divide', () => {
    const [start, invRange, strength, desaturate] = hazePack(ANNIVERSARY)
    expect(start).toBe(ANNIVERSARY.startDistance)
    expect(invRange).toBeCloseTo(1 / ANNIVERSARY.range, 15)
    expect(strength).toBe(ANNIVERSARY.strength)
    expect(desaturate).toBe(ANNIVERSARY.desaturate)
  })
})

describe('the haze colour', () => {
  it('is the identity at distance zero', () => {
    for (const [name, c] of SAMPLES) {
      expect(hazeColor(c, 0, ANNIVERSARY), name).toEqual(c)
    }
  })

  it('is the identity anywhere inside the start distance', () => {
    for (const [name, c] of SAMPLES) {
      expect(hazeColor(c, ANNIVERSARY.startDistance - 0.01, ANNIVERSARY), name).toEqual(c)
    }
  })

  it('is the full desaturation and the full tint at start + range', () => {
    const full = ANNIVERSARY.startDistance + ANNIVERSARY.range
    for (const [name, c] of SAMPLES) {
      const lum = c[0] * HAZE_LUMA[0] + c[1] * HAZE_LUMA[1] + c[2] * HAZE_LUMA[2]
      const got = hazeColor(c, full, ANNIVERSARY)
      for (let i = 0; i < 3; i++) {
        // Desaturate by `desaturate`, then move `strength` of the way to the
        // tint. Written out as two lerps rather than as one folded expression,
        // so this is the row's sentence and not the implementation's algebra.
        const greyed =
          (c[i] as number) * (1 - ANNIVERSARY.desaturate) + lum * ANNIVERSARY.desaturate
        const want =
          greyed * (1 - ANNIVERSARY.strength) +
          (ANNIVERSARY.tint[i] as number) * ANNIVERSARY.strength
        expect(got[i], `${name} channel ${i}`).toBeCloseTo(want, 12)
      }
    }
  })

  it('stays at full strength past start + range — it does not keep going', () => {
    const full = ANNIVERSARY.startDistance + ANNIVERSARY.range
    for (const [name, c] of SAMPLES) {
      expect(hazeColor(c, full + 2400, ANNIVERSARY), name).toEqual(hazeColor(c, full, ANNIVERSARY))
    }
  })

  it('desaturates monotonically when only the desaturation is on', () => {
    // Saturation as max - min across the channels, which is the quantity the
    // eye reads as "this is washing out". With the tint off the term is a
    // single lerp toward a grey, so this one IS monotone and is asserted as
    // such rather than at its endpoints.
    const only: HazeSettings = { ...ANNIVERSARY, strength: 0 }
    for (const [name, c] of SAMPLES) {
      let previous = Number.POSITIVE_INFINITY
      for (let d = 0; d <= 5000; d += 50) {
        const got = hazeColor(c, d, only)
        const sat = Math.max(...got) - Math.min(...got)
        expect(sat, `${name} at ${d} m`).toBeLessThanOrEqual(previous + 1e-12)
        previous = sat
      }
      // And it never reaches grey, because `desaturate` is less than 1.
      const far = hazeColor(c, 6000, only)
      expect(Math.max(...far) - Math.min(...far), name).toBeGreaterThan(0)
    }
  })

  it('moves monotonically toward the tint when only the tint is on', () => {
    const only: HazeSettings = { ...ANNIVERSARY, desaturate: 0 }
    for (const [name, c] of SAMPLES) {
      let previous = -1
      for (let d = 0; d <= 5000; d += 50) {
        const got = hazeColor(c, d, only)
        const moved = Math.hypot(got[0] - c[0], got[1] - c[1], got[2] - c[2])
        expect(moved, `${name} at ${d} m`).toBeGreaterThanOrEqual(previous - 1e-12)
        previous = moved
      }
    }
  })

  it('cools: the blue channel gains on the red one with distance', () => {
    // The direction of the whole feature, stated as something an eye could
    // check, rather than as the tint's own numbers. Aerial perspective is a
    // blue shift; if this ever goes the other way the term has been retuned
    // into something else and should get its own row.
    const full = ANNIVERSARY.startDistance + ANNIVERSARY.range
    for (const [name, c] of SAMPLES) {
      const got = hazeColor(c, full, ANNIVERSARY)
      expect(got[2] - got[0], name).toBeGreaterThan(c[2] - c[0])
    }
  })
})

describe('Classic contributes nothing', () => {
  const off = classic.render.haze as unknown as HazeTuning
  // Written out rather than spread, because `off` also carries `enabled` and
  // `note` and this has to be the shape the shader is handed, not a superset.
  const asSettings: HazeSettings = {
    startDistance: off.startDistance,
    range: off.range,
    strength: off.strength,
    desaturate: off.desaturate,
    tint: [0, 0, 0],
  }

  it('has strength and desaturate at zero in the shipped preset', () => {
    expect(off.strength).toBe(0)
    expect(off.desaturate).toBe(0)
    // Not zero, because the shader is handed 1/range.
    expect(off.range).toBeGreaterThan(0)
  })

  it('is the EXACT identity at every distance, on both the preset and HAZE_OFF', () => {
    // `toBe` on the floats, not `toBeCloseTo`. GLSL's `mix(x, y, 0.0)` is
    // `x * 1.0 + y * 0.0`, which is `x` exactly for any finite y, and the
    // TypeScript mirror spells `mix` out the same way — so "Classic renders
    // what it rendered" is a promise this can keep rather than approximate.
    for (const settings of [asSettings, HAZE_OFF]) {
      for (const [name, c] of SAMPLES) {
        for (const d of [0, 1, 400, 1000, 2000, 4000, 6000]) {
          const got = hazeColor(c, d, settings)
          expect(got[0], `${name} r at ${d} m`).toBe(c[0])
          expect(got[1], `${name} g at ${d} m`).toBe(c[1])
          expect(got[2], `${name} b at ${d} m`).toBe(c[2])
        }
      }
    }
  })

  it('is the identity even with a tint set, as long as both amounts are zero', () => {
    // Belt and braces on the thing that actually gates it. If someone later
    // gives Classic a tint "for documentation", it still has to render the
    // same frame.
    const tinted: HazeSettings = { ...asSettings, tint: [1, 0, 0] }
    for (const [name, c] of SAMPLES) {
      expect(hazeColor(c, 5000, tinted), name).toEqual(c)
    }
  })
})

// ── the shader, as text ──────────────────────────────────────────────────
//
// No GL context, so what is checkable is the SOURCE the fog injects. Two
// claims: the fog chunk is the one that shipped, and there is exactly one
// variant of the whole thing.

const FOG_PARAMS: UnityFogParams = {
  mode: 2,
  density: 0.00025,
  linearStart: 0,
  linearEnd: 300,
  color: [0.867, 0.659, 0.698],
  distanceFog: true,
  heightFog: true,
  useRadialDistance: true,
  height: 500,
  heightDensity: 0.015,
  startDistance: 0,
}

/**
 * Run a material through `applyTo` and hand back the fragment source three
 * would have compiled.
 *
 * `onBeforeCompile` is called by hand with a stub `shader`, which is all three
 * ever passes it. No renderer is needed: the only thing this file does with the
 * second argument is forward it to whatever was chained before.
 */
const patchedFragment = (fog: ReturnType<typeof createUnityFog>): string => {
  const material = new THREE.MeshStandardMaterial()
  fog.applyTo(material)
  const shader = {
    uniforms: {} as Record<string, unknown>,
    vertexShader: '#include <begin_vertex>',
    fragmentShader: '#include <opaque_fragment>',
  }
  ;(material.onBeforeCompile as unknown as (s: typeof shader, r: unknown) => void)(
    shader,
    undefined,
  )
  return shader.fragmentShader
}

/**
 * The fog's fragment chunk, verbatim from `src/render/unity-fog.ts` at commit
 * 2b2bb93 — the preset scaffold, before this feature existed.
 *
 * `${FRAGMENT_HOOK}` and the leading brace are left off because they are the
 * seams either side of it; everything between is the fog, and if a line of it
 * moves, this fails and somebody has to say so in DEV-018's row rather than in
 * a diff nobody reads.
 */
const SHIPPED_FOG_CHUNK = `  vec3 wsDir = vUnityFogWorldPos - cameraPosition;
  float g = uFogDistance.x;
  if (uFogFlags.x > 0.5) {
    // Radial: true distance. Otherwise view depth along the camera's forward.
    float d = uFogRadial > 0.5
      ? length(wsDir)
      : abs(dot(wsDir, normalize(vec3(viewMatrix[0].z, viewMatrix[1].z, viewMatrix[2].z))));
    g += d - uFogDistance.y;
  }
  if (uFogFlags.y > 0.5) {
    g += unityHalfSpace(wsDir, vUnityFogWorldPos);
  }
  g = max(0.0, g);

  float fogFac;
  if (uFogMode == 1) {
    fogFac = g * uFogScene.z + uFogScene.w;
  } else if (uFogMode == 2) {
    fogFac = exp2(-(uFogScene.y * g));
  } else {
    float f = uFogScene.x * g;
    fogFac = exp2(-f * f);
  }
  fogFac = clamp(fogFac, 0.0, 1.0);

  // The colour fogged TOWARD. Flat in 2016; the sky's own colour along this
  // ray when the mission has a decoded sky, which is what closes the seam at
  // the skyline. See the note at the top of unity-fog.ts.
  vec3 fogTint = uFogSkyMode > 0.5 ? unityFogSkyColor(normalize(wsDir)) : uFogColor;

  // The blend is LINEAR. See the note on colour space in unity-fog.ts —
  // this line used to round-trip through sRGB on a premise that turned out
  // to be false, and that is what made the fog a milky sheet.
  outgoingLight = mix(fogTint, outgoingLight, fogFac);`

describe('the injected shader source', () => {
  it('still carries the fog chunk that shipped, byte for byte', () => {
    const source = patchedFragment(createUnityFog(FOG_PARAMS))
    expect(source).toContain(SHIPPED_FOG_CHUNK)
  })

  it('applies the haze BEFORE the fog, which is the order the physics runs in', () => {
    const source = patchedFragment(createUnityFog(FOG_PARAMS))
    const haze = source.indexOf('outgoingLight = ff2AerialHaze(')
    const fogMix = source.indexOf('outgoingLight = mix(fogTint, outgoingLight, fogFac);')
    expect(haze).toBeGreaterThan(-1)
    expect(fogMix).toBeGreaterThan(-1)
    // Light leaves the ridge, the air takes some of it out of the ray, THEN
    // skylight is scattered in. Reverse these and the haze would be tinting the
    // sky rather than the surface.
    expect(haze).toBeLessThan(fogMix)
  })

  it('is ONE variant: the same source whether the haze is on or off', () => {
    // The whole reason this feature is uniforms and not a `#define`. If it ever
    // becomes two sources, `render/program-cache-key.ts`'s rule applies and the
    // `unity-fog` tag has to name the difference — this is the test that would
    // notice.
    const on = createUnityFog(FOG_PARAMS)
    on.setHaze(tuning)
    const offFog = createUnityFog(FOG_PARAMS)
    offFog.setHaze(null)
    expect(patchedFragment(on)).toBe(patchedFragment(offFog))
  })

  it('declares the haze uniforms it reads', () => {
    // A GLSL compile would catch an undeclared uniform; nothing here would, and
    // the symptom is a black terrain on the day somebody flips the preset.
    const source = patchedFragment(createUnityFog(FOG_PARAMS))
    expect(source).toContain('uniform vec4 uHaze;')
    expect(source).toContain('uniform vec3 uHazeTint;')
  })
})

describe('setHaze, on the fog that owns the uniforms', () => {
  it('starts zeroed, whatever preset is live', () => {
    // The fog is built from the LEVEL, before the edition is asked. A term that
    // defaulted to ON would put the order of two unrelated boot steps into the
    // picture.
    const fog = createUnityFog(FOG_PARAMS)
    expect(fog.uniforms.uHaze.value.z).toBe(0)
    expect(fog.uniforms.uHaze.value.w).toBe(0)
  })

  it('linearises the tint, the same way the fog colour is linearised', () => {
    const fog = createUnityFog(FOG_PARAMS)
    fog.setHaze(tuning)
    const t = fog.uniforms.uHazeTint.value
    // The preset carries (0.66, 0.74, 0.85) sRGB. Through IEC 61966-2-1's EOTF
    // that is (0.393123, 0.507079, 0.692071) — pinned as numbers, computed
    // outside this repo, rather than as a call to the port's own converter. It
    // earned its keep on its first run: the literals here were a hand
    // arithmetic error and the code was right, which is the direction a pinned
    // expectation is supposed to fail in.
    expect(t.r).toBeCloseTo(0.393123, 6)
    expect(t.g).toBeCloseTo(0.507079, 6)
    expect(t.b).toBeCloseTo(0.692071, 6)
    // And it is NOT the raw sRGB triple, which is the bug this guards.
    expect(t.r).not.toBeCloseTo(tuning.tint[0], 3)
  })

  it('packs the preset into uHaze in the order the GLSL reads it', () => {
    const fog = createUnityFog(FOG_PARAMS)
    fog.setHaze(tuning)
    const v = fog.uniforms.uHaze.value
    expect(v.x).toBe(tuning.startDistance)
    expect(v.y).toBeCloseTo(1 / tuning.range, 15)
    expect(v.z).toBe(tuning.strength)
    expect(v.w).toBe(tuning.desaturate)
  })

  it('null puts it back to nothing', () => {
    const fog = createUnityFog(FOG_PARAMS)
    fog.setHaze(tuning)
    fog.setHaze(null)
    expect(fog.uniforms.uHaze.value.z).toBe(0)
    expect(fog.uniforms.uHaze.value.w).toBe(0)
    expect(fog.uniforms.uHazeTint.value.getHex()).toBe(0x000000)
  })

  it('reaches every material at once, because they share the uniform block', () => {
    // `applyTo` hands each material THE SAME uniform objects rather than
    // copies, which is why a preset flip mid-flight needs no rebuild and no
    // per-material walk. If that ever became a copy, a flip would move the
    // terrain and leave the ocean behind — and that is the shape of half the
    // bugs in this ledger.
    const fog = createUnityFog(FOG_PARAMS)
    const seen: Record<string, unknown>[] = []
    for (let i = 0; i < 3; i++) {
      const material = new THREE.MeshStandardMaterial()
      fog.applyTo(material)
      const shader = {
        uniforms: {} as Record<string, unknown>,
        vertexShader: '#include <begin_vertex>',
        fragmentShader: '#include <opaque_fragment>',
      }
      ;(material.onBeforeCompile as unknown as (s: typeof shader, r: unknown) => void)(
        shader,
        undefined,
      )
      seen.push(shader.uniforms)
    }
    fog.setHaze(tuning)
    for (const uniforms of seen) {
      expect(uniforms.uHaze).toBe(fog.uniforms.uHaze)
      expect((uniforms.uHaze as { value: THREE.Vector4 }).value.z).toBe(tuning.strength)
    }
  })
})
