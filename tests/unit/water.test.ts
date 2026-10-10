// tests/unit/water.test.ts — the ocean's wave.
//
// `src/render/water.ts` holds the wave TWICE: once in TypeScript, as
// `waterDisplacement`, and once in GLSL inside the vertex shader. The GLSL is
// what you see; the TypeScript is what drives the whole-plate bob and what this
// file can reach.
//
// That duplication is deliberate — the shader cannot be called from a node test
// and a GPU readback for four lines of arithmetic is not worth maintaining — but
// it means **this suite proves the FORMULA, not the shader**. The two are held
// in step by review, and the GLSL carries the same three trap comments so a
// future edit to one reads as obviously needing the other. Said plainly here
// rather than implied, because a test file named `water` that passes while the
// ocean is flat would otherwise be a lie.
//
// What it CAN do is pin the three details that are easy to get wrong, each of
// which produces a plausible wrong ocean rather than a broken one:
//
//   1. `dot(dir, _DisplaceFrequency)` is a float2 dotted with a SCALAR, which
//      HLSL promotes — so both components count.
//   2. `worldPos.xzz` uses z twice.
//   3. `_DisplaceNoiseCoef` is -1, so the noise SUBTRACTS amplitude and shifts
//      phase, rather than adding.
//
// The independent transliteration below is written from the HLSL directly and
// structured differently from the implementation, so it is an oracle rather than
// a copy of the thing it checks.

import { describe, expect, it } from 'vitest'
import { TERRAIN } from '@/generated/constants.generated'
import {
  FACET_METRES_DEFAULT,
  maxFacetTiltRadians,
  WAVE_GLSL,
  type WaterDisplace,
  waterDisplacement,
  waterNoise,
  waveAmplitudeAt,
  waveCeiling,
} from '@/render/water'

const OCEAN = TERRAIN.simonet.terrains.ocean
const WAVE = OCEAN.displace as unknown as WaterDisplace | null

/**
 * The HLSL, transliterated straight from `Core.cginc`, in one expression.
 *
 * Deliberately NOT factored the way the implementation is: it keeps the
 * original's matrix multiply and its `dot(float2, float2)` written out, so the
 * two disagree if either has been "tidied" into something that is not the same
 * arithmetic.
 */
const hlsl = (d: WaterDisplace, x: number, z: number, t: number): number => {
  const rad = (d.direction - 45) * 0.0174533
  const s = Math.sin(rad)
  const c = Math.cos(rad)
  // mul(float2x2(c, -s, s, c), worldPos.xz) — column vector.
  const dir: [number, number] = [c * x + -s * z, s * x + c * z]
  // frac(sin(dot(worldPos.xzz, float3(12.9898, 78.233, 63.9137))))
  const inner = x * 12.9898 + z * 78.233 + z * 63.9137
  const sinned = Math.sin(inner)
  let n = sinned - Math.floor(sinned)
  n *= d.noise
  // dot(dir, _DisplaceFrequency) — the scalar is promoted to float2(f, f).
  const freq: [number, number] = [d.frequency, d.frequency]
  const dotted = dir[0] * freq[0] + dir[1] * freq[1]
  return d.amplitude * (n + 1) * Math.sin(dotted + t * d.speed + n)
}

/**
 * A deterministic spread of places and times.
 *
 * Includes the origin ON PURPOSE, and one point out at the plate's corner where
 * the noise happens to crush the local amplitude to 0.53 m. Both are degenerate
 * for one assertion each, and both are handled by name below rather than by
 * quietly loosening a threshold until everything passes.
 *
 * (-14949, -13692) is the Simonet plate's own origin — the point the whole-plate
 * bob is evaluated at.
 */
const SAMPLES: [number, number, number][] = [
  [0, 0, 0],
  [12.5, -7.25, 0.5],
  [-14949, -13692, 1.75],
  [-14949, -13692, 9.5],
  [1024, 2048, 3.25],
  [-3300, 1157, 17.125],
  [131072, -131072, 41],
]

describe('what the extractor found', () => {
  it('found a LIVE wave driver on the ocean and none on the land', () => {
    // The component is the only thing that sets the shader's time — the
    // material has `_DisplaceScriptSynchronize: 1`, which makes the shader use
    // `_V_LP_Time` instead of Unity's own clock. A dead driver is a FROZEN
    // ocean, not a missing one, so liveness is the load-bearing field.
    expect(WAVE).not.toBeNull()
    expect(WAVE?.live).toBe(true)
    expect(TERRAIN.simonet.terrains.islands.displace).toBeNull()
  })

  it('agrees with the material it overwrites', () => {
    // `LowPoly_Displace.Update()` writes all five of these into the material
    // every frame, so the material's serialised copies are whatever the
    // inspector last left there. They happen to match here, which is a
    // cross-check worth asserting rather than a coincidence to lean on: if a
    // future extraction finds them diverged, the COMPONENT still wins, and this
    // failing is how anyone would find out.
    expect(WAVE?.direction).toBe(322)
    expect(WAVE?.speed).toBe(2)
    expect(WAVE?.amplitude).toBe(4)
    expect(WAVE?.frequency).toBeCloseTo(0.4, 6)
    expect(WAVE?.noise).toBe(-1)
  })

  it('drives the ocean in both water environments', () => {
    // Simonet and Kauai are the same course in two environments, so a wave on
    // one and not the other would be a visible difference between them.
    expect((TERRAIN.kauai.terrains.ocean.displace as unknown as WaterDisplace)?.live).toBe(true)
  })
})

describe('the wave', () => {
  const w = WAVE as WaterDisplace

  it('matches the HLSL, transliterated independently', () => {
    for (const [x, z, t] of SAMPLES) {
      expect(waterDisplacement(w, x, z, t), `(${x}, ${z}) @ ${t}s`).toBeCloseTo(hlsl(w, x, z, t), 6)
    }
  })

  it('stays inside +-amplitude, and the noise only ever SUBTRACTS', () => {
    // `noise` is -1, so `n` lands in (-1, 0] and `amplitude * (n + 1)` lands in
    // (0, 4]. A port that read the coefficient as +1 would swing to 8 m and read
    // as a storm.
    for (const [x, z, t] of SAMPLES) {
      const v = waterDisplacement(w, x, z, t)
      expect(Math.abs(v)).toBeLessThanOrEqual(w.amplitude + 1e-9)
    }
    // And the noise really is in that range at every sample.
    for (const [x, z] of SAMPLES) {
      const n = waterNoise(x, z) * w.noise
      expect(n).toBeLessThanOrEqual(0)
      expect(n).toBeGreaterThan(-1)
    }
  })

  it('sweeps its FULL local amplitude over one period, at every sample', () => {
    // The whole point, stated exactly rather than as "it moved by more than
    // some threshold". Counting samples over a threshold is the weaker test AND
    // the flakier one: at (131072, -131072) the noise crushes the local
    // amplitude to 0.53 m, so that point legitimately barely moves in a third of
    // a second, and a threshold test reads a correct wave as a broken one.
    //
    // Swept range is the property that has no such exception. At a fixed place
    // the wave is a pure sinusoid in time, so over one period it must cover
    // exactly `2 * amplitude * (n + 1)` — which also pins the noise's effect on
    // amplitude, not just on phase.
    const period = (2 * Math.PI) / w.speed
    for (const [x, z] of SAMPLES) {
      let lo = Number.POSITIVE_INFINITY
      let hi = Number.NEGATIVE_INFINITY
      for (let i = 0; i <= 400; i++) {
        const v = waterDisplacement(w, x, z, (i / 400) * period)
        lo = Math.min(lo, v)
        hi = Math.max(hi, v)
      }
      const local = w.amplitude * (waterNoise(x, z) * w.noise + 1)
      expect(hi - lo, `swept range at (${x}, ${z})`).toBeCloseTo(2 * local, 2)
    }
  })

  it('is not flat across space at a single moment', () => {
    // A wave that is constant in x and z is a plate going up and down, which is
    // what you get if the direction rotation or the frequency is dropped.
    const at = (x: number, z: number) => waterDisplacement(w, x, z, 4)
    const heights = [at(0, 0), at(50, 0), at(0, 50), at(120, -80), at(-200, 300)]
    const spread = Math.max(...heights) - Math.min(...heights)
    expect(spread).toBeGreaterThan(1)
  })

  it('uses BOTH rotated components, not just one', () => {
    // Trap 1. `dot(float2, scalar)` promotes the scalar, so the phase is
    // `(dir.x + dir.y) * f`. Dropping `dir.y` is the natural GLSL translation
    // and it produces a wave travelling at a different angle — which looks
    // completely fine on open water.
    const oneComponent = (x: number, z: number, t: number) => {
      const rad = (w.direction - 45) * (Math.PI / 180)
      const s = Math.sin(rad)
      const c = Math.cos(rad)
      const dirX = c * x - s * z
      const n = waterNoise(x, z) * w.noise
      return w.amplitude * (n + 1) * Math.sin(dirX * w.frequency + t * w.speed + n)
    }
    // Every sample EXCEPT the origin, where `dir` is (0, 0) and the two agree by
    // construction — a tie, not a pass, so it is excluded by name rather than
    // absorbed into a fudged count.
    const offOrigin = SAMPLES.filter(([x, z]) => x !== 0 || z !== 0)
    expect(offOrigin.length).toBe(SAMPLES.length - 1)
    for (const [x, z, t] of offOrigin) {
      const full = waterDisplacement(w, x, z, t)
      const half = oneComponent(x, z, t)
      // Relative to the LOCAL amplitude, so the sample whose noise crushed it to
      // 0.53 m is held to the same standard as the ones at 4 m.
      const local = w.amplitude * (waterNoise(x, z) * w.noise + 1)
      expect(Math.abs(full - half) / local, `(${x}, ${z}) @ ${t}s`).toBeGreaterThan(0.02)
    }
  })

  it('hashes z TWICE', () => {
    // Trap 2. `worldPos.xzz`. Reading it as `.xyz` — with y, which for a water
    // vertex is a near-constant — gives a different noise field entirely, and
    // one that is far too smooth.
    const asXyz = (x: number, z: number) => {
      const r = Math.sin(x * 12.9898 + z * 78.233 + z * 63.9137)
      return r - Math.floor(r)
    }
    // Same thing, stated as the fold the implementation uses.
    for (const [x, z] of SAMPLES) expect(waterNoise(x, z)).toBeCloseTo(asXyz(x, z), 12)
    // And it is NOT the single-z version.
    const singleZ = (x: number, z: number) => {
      const r = Math.sin(x * 12.9898 + z * 78.233)
      return r - Math.floor(r)
    }
    const differs = SAMPLES.filter(([x, z]) => Math.abs(waterNoise(x, z) - singleZ(x, z)) > 0.01)
    expect(differs.length).toBeGreaterThanOrEqual(SAMPLES.length - 2)
  })

  it('is periodic in time with period 2*PI/speed', () => {
    // A property rather than a value, and it is the one that says `speed`
    // reached the sine's argument rather than scaling its output.
    const period = (2 * Math.PI) / w.speed
    for (const [x, z, t] of SAMPLES) {
      expect(waterDisplacement(w, x, z, t)).toBeCloseTo(
        waterDisplacement(w, x, z, t + period),
        // Large coordinates cost float precision inside the sine; the assertion
        // is about periodicity, not about the last decimal place.
        3,
      )
    }
  })
})

describe('the GLSL twin', () => {
  // These cannot run the shader. What they can do is stop the two copies
  // drifting silently — each assertion below corresponds to one of the numeric
  // tests above, so a GLSL edit that breaks a trap fails here even though the
  // arithmetic it breaks lives on the GPU.
  //
  // Comments are stripped first, so a trap surviving only in a comment does not
  // count as the code still doing it.
  const code = WAVE_GLSL.split(/\r?\n/)
    .map((line) => {
      const at = line.indexOf('//')
      return at === -1 ? line : line.slice(0, at)
    })
    .join(' ')

  it('puts BOTH rotated components into the phase', () => {
    // Trap 1: `dot(float2, scalar)` promotes the scalar. Dropping `dir.y` is the
    // natural GLSL translation and gives a wave travelling at a different angle.
    expect(code).toMatch(/\(\s*dir\.x\s*\+\s*dir\.y\s*\)\s*\*/)
  })

  it('hashes z twice, as two separate terms', () => {
    // Trap 2: `.xzz`. And un-folded, because folding the constants moves the
    // result — see `waterNoise`.
    expect(code).toMatch(/uz\s*\*\s*78\.233/)
    expect(code).toMatch(/uz\s*\*\s*63\.9137/)
    // Not `uz * (78.233 + 63.9137)` and not `uz * 142.1467`.
    expect(code).not.toMatch(/142\.1467/)
    expect(code).not.toMatch(/78\.233\s*\+\s*63\.9137/)
  })

  it('scales the amplitude by (n + 1), so the noise can subtract', () => {
    // Trap 3. Without this the wave is a flat 4 m everywhere and reads as a
    // single coherent sheet rather than as water.
    expect(code).toMatch(/uWave\.z\s*\*\s*\(\s*n\s*\+\s*1\.0\s*\)/)
  })

  it('evaluates the wave in UNITY space', () => {
    // Our world is Unity mirrored in z. Skip the flip and the waves travel the
    // wrong way across the map — which on open water looks like nothing at all.
    expect(code).toMatch(/float\s+uz\s*=\s*-\s*wp\.z/)
  })

  it('does NOT convert degrees in the shader', () => {
    // The direction arrives pre-converted, with the shader's own rounded
    // `0.0174533` rather than a fresh `PI / 180`. A GLSL-side conversion would
    // reintroduce the 2e-5 the numeric suite exists to catch — and would be
    // invisible to it, because it would only be wrong on the GPU.
    expect(code).not.toMatch(/0\.0174533/)
    expect(code).not.toMatch(/3\.14159/)
    expect(code).not.toMatch(/radians\s*\(/)
  })

  it('does not use inverse(), which is GLSL ES 3.00 only', () => {
    // It compiled on the dev machine and would have failed elsewhere. The
    // y-scale divide replaces it.
    expect(code).not.toMatch(/inverse\s*\(/)
  })
})

describe('the grazing-angle normal, which is FF2s bug and not 2016s', () => {
  // ── What this guards ─────────────────────────────────────────────────────
  //
  // The shader derives its flat normal from `dFdx`/`dFdy` of the world
  // position. That measures the surface across ONE PIXEL — and looking ALONG
  // the sea rather than down at it, one pixel covers hundreds of metres, so
  // the 2x2 quad straddles several facets and several wave periods. What comes
  // back is not a facet normal, it is noise; the 25.7-exponent specular then
  // amplifies it into salt-and-pepper stipple across the water.
  //
  // Measured from mid-shaft on `int_01` at y = 60, as the fraction of pixels in
  // the band with a horizontal step over 24/255:
  //
  //     baseline                     9.04 %
  //     specular removed             6.49 %
  //     reflection removed           8.27 %
  //     specular AND reflection      6.37 %
  //     FLAT normal, everything on   0.80 %
  //
  // Neither lighting term is the cause — they only make it visible. `?znear=20`
  // (25x the depth precision) moved it 9.04 -> 7.50 and `?wire=ocean` showed
  // clean terrain behind, so it is neither z-fighting nor the submerged seabed.
  //
  // The fix is what a mip-map does for a texture: once a pixel covers a whole
  // facet, stop pretending to know which way that facet points.
  //
  // The blend itself is one line of GLSL and cannot be run here. What CAN be
  // pinned is the number it divides by, because that is the thing a refactor
  // gets wrong — `baseResolution` alone (32) and the world quad (256) differ by
  // exactly the transform scale, and picking the wrong one makes the fade fire
  // 8x too early or 8x too late.

  it('derives the world facet from baseResolution x the plate scale', () => {
    for (const key of ['simonet', 'kauai'] as const) {
      const ocean = TERRAIN[key].terrains.ocean
      expect(ocean.baseResolution).toBe(32)
      expect(ocean.transform.scale[0]).toBe(8)
      // What `load-terrain.ts` passes as `facetMetres` at `?ocean=1`.
      expect(ocean.baseResolution * ocean.transform.scale[0]).toBe(FACET_METRES_DEFAULT)
    }
  })

  it('is 32 m at the shipped ?ocean=8, not 256', () => {
    // The subdivision is what makes the default view sharp, and it is also why
    // `FACET_METRES_DEFAULT` is a FALLBACK rather than the answer: a caller that
    // subdivides and forgets to pass the smaller number relaxes to flat too
    // late, which loses no detail. The other way round would flatten the sea.
    const ocean = TERRAIN.simonet.terrains.ocean
    expect((ocean.baseResolution * ocean.transform.scale[0]) / 8).toBe(32)
  })

  it('keeps the fallback the COARSEST the mesh ever is', () => {
    // If this ever drops below a shipped subdivision's facet, the fallback
    // starts flattening water that is perfectly well resolved.
    for (const subdivide of [1, 2, 4, 8, 16]) {
      expect(
        (TERRAIN.simonet.terrains.ocean.baseResolution *
          TERRAIN.simonet.terrains.ocean.transform.scale[0]) /
          subdivide,
      ).toBeLessThanOrEqual(FACET_METRES_DEFAULT)
    }
  })
})

describe('the tilt clamp is derived, not tuned', () => {
  it('matches atan(1.5 * amplitude / facet) on the shipped numbers', () => {
    const amplitude = TERRAIN.simonet.terrains.ocean.displace.amplitude
    expect(amplitude).toBe(4)
    // The shipped `?ocean=8`: 32 m quads, so the steepest real facet is
    // atan(4/32) = 7.13 deg and the clamp sits at 1.5x that.
    expect((maxFacetTiltRadians(amplitude, 32) * 180) / Math.PI).toBeCloseTo(10.62, 2)
    // `?ocean=1`: 256 m quads, and the sea is nearly a plane.
    expect((maxFacetTiltRadians(amplitude, 256) * 180) / Math.PI).toBeCloseTo(1.3426, 3)
  })

  it('separates a real facet from a garbage normal by a wide margin', () => {
    // The point of the clamp: it has to pass everything the mesh can make and
    // stop everything it cannot. A degenerate cross product points anywhere on
    // the sphere, so the median garbage normal is ~60 deg off up — six times
    // the clamp at the shipped tessellation. There is no tuning in that gap.
    const clampDeg = (maxFacetTiltRadians(4, 32) * 180) / Math.PI
    expect(clampDeg).toBeGreaterThan((Math.atan(4 / 32) * 180) / Math.PI)
    expect(clampDeg).toBeLessThan(30)
  })

  it('never returns more than a right angle, however absurd the inputs', () => {
    for (const [a, f] of [
      [0, 32],
      [1e9, 1e-9],
      [-4, 32],
      [4, 0],
    ] as const) {
      const r = maxFacetTiltRadians(a, f)
      expect(Number.isFinite(r), `${a} / ${f}`).toBe(true)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(Math.PI / 2)
    }
  })
})

describe('DEV-501 follow-up — the wave’s envelope, for the editor’s high-water mark', () => {
  it('waveAmplitudeAt is the most the wave lifts a point over a cycle; waveCeiling bounds every point', () => {
    for (const env of ['simonet', 'kauai'] as const) {
      const d = TERRAIN[env].terrains.ocean.displace as unknown as WaterDisplace
      const period = (2 * Math.PI) / d.speed
      const ceiling = waveCeiling(d)
      for (let i = 0; i < 60; i++) {
        const x = -3000 + 97.3 * i
        const z = 2500 - 71.9 * i
        const envelope = waveAmplitudeAt(d, x, z)
        let top = 0
        for (let k = 0; k < 2000; k++) {
          top = Math.max(top, Math.abs(waterDisplacement(d, x, z, (k / 2000) * period)))
        }
        // Reached (to the sampling of the cycle) and never passed.
        expect(top).toBeLessThanOrEqual(envelope + 1e-9)
        expect(top).toBeGreaterThan(envelope * 0.9999)
        expect(envelope).toBeLessThanOrEqual(ceiling + 1e-12)
      }
    }
    // Simonet's bob, at its plate's own origin, is the 3.459 m this file's source states.
    const t = TERRAIN.simonet.terrains.ocean.transform as unknown as {
      position: number[]
      envRoot?: number[]
    }
    const origin = t.position.map((p, i) => p + (t.envRoot?.[i] ?? 0))
    const simonet = TERRAIN.simonet.terrains.ocean.displace as unknown as WaterDisplace
    expect(waveAmplitudeAt(simonet, origin[0] as number, origin[2] as number)).toBeCloseTo(3.459, 3)
    expect(waveCeiling(simonet)).toBe(4)
  })
})
