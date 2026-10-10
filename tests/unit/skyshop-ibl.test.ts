// tests/unit/skyshop-ibl.test.ts — the 2016 ambient light, checked against Marmoset's own maths.
//
// The claim under test is narrow and total: for EVERY direction, three's evaluation of our
// converted coefficients equals Marmoset's `SHLookup` of the original ones at the corresponding
// direction. Not "close in the average", not "right on the axes" — everywhere, to float precision.
//
// It has to be that strong, because the three failure modes are all silent:
//
//   * skip the Lambert division and the sky is 1.5x/4x flat but still plausible
//   * skip the z mirror and the light comes from the wrong side, which looks like art direction
//   * skip `ibl_sky`'s 139 degrees of yaw and it comes from a different wrong side
//
// A test that only checked the average colour would pass all three.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { TERRAIN } from '@/generated/constants.generated'
import {
  createSkyshopProbe,
  MARMOSET_DIRECT_SCALE,
  marmosetShLookup,
  marmosetSunIntensity,
  probeFromSkyRadiance,
  SH_BASIS_CONSTANT,
  shTriples,
  skyshopCoefficients,
} from '@/render/skyshop-ibl'
import int01 from '../../content/levels/int_01_hoverJet.json'

const IBL = TERRAIN.simonet.ibl

/** A deterministic spread over the sphere. Fibonacci, so no clustering at the poles. */
const sphere = (n: number): [number, number, number][] => {
  const golden = Math.PI * (3 - Math.sqrt(5))
  return Array.from({ length: n }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / n
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const a = golden * i
    return [Math.cos(a) * r, y, Math.sin(a) * r] as [number, number, number]
  })
}

/**
 * `skyRotate(_SkyMatrix, N)` — the shader's own transform, done the long way.
 *
 * Takes a THREE-space normal, mirrors it into Unity space, then applies the TRANSPOSE of
 * `ibl_sky`'s rotation. This is deliberately written out rather than shared with the module: an
 * oracle that imports the thing it is checking proves nothing.
 */
const toSkySpace = (n: readonly [number, number, number]): [number, number, number] => {
  const [qx, qy, qz, qw] = IBL.rotationUnity as unknown as [number, number, number, number]
  const unity = new THREE.Vector3(n[0], n[1], -n[2])
  const inverse = new THREE.Quaternion(qx, qy, qz, qw).invert()
  const v = unity.applyQuaternion(inverse)
  return [v.x, v.y, v.z]
}

describe('the sheet carries a real Skyshop bake', () => {
  it('has 27 coefficients from a live component', () => {
    expect(IBL.sh.length).toBe(27)
    expect(IBL.enabled).toBe(true)
    expect(IBL.gameObject).toBe('ibl_sky')
  })

  it('agrees with the serialised cBuffer, which is the shader uniform', () => {
    // `copyToBuffer()` does `cBuffer[i] = c[i] * sEquationConstants[i]`. If that identity holds
    // against numbers Unity wrote independently, these ARE textbook SH coefficients and every
    // conversion below is licensed. If it ever stops holding, nothing downstream is trustworthy.
    const c = shTriples(IBL.sh as unknown as number[])
    for (let i = 0; i < 9; i++) {
      for (let k = 0; k < 3; k++) {
        const want = ((c[i] as number[])[k] as number) * (SH_BASIS_CONSTANT[i] as number)
        expect((IBL.shBuffer[i] as unknown as number[])[k] as number).toBeCloseTo(want, 6)
      }
    }
  })

  it('is not the identity sky — the bake carries real directional structure', () => {
    // A probe whose bands 1 and 2 were zero would pass every conversion test below while carrying
    // no light direction at all. Band 1 alone is ~45% of the DC term here.
    const c = shTriples(IBL.sh as unknown as number[])
    const dc = Math.hypot(...(c[0] as number[]))
    const band1 = Math.hypot(...[1, 2, 3].flatMap((i) => c[i] as number[]))
    expect(band1 / dc).toBeGreaterThan(0.2)
  })

  it('reads the sky as rotated, because it is', () => {
    // 139 degrees of yaw on `ibl_sky`. A test that assumed identity would still see plausible
    // light, just from the wrong quarter of the sky.
    const yaw = (2 * Math.acos(IBL.rotationUnity[3] as number) * 180) / Math.PI
    expect(yaw).toBeGreaterThan(100)
    expect(IBL.rotationUnity[0]).toBe(0)
    expect(IBL.rotationUnity[2]).toBe(0)
  })
})

describe('three reproduces Marmoset exactly', () => {
  const sh = skyshopCoefficients({
    sh: IBL.sh as unknown as number[],
    rotationUnity: IBL.rotationUnity as unknown as number[],
    exposure: IBL.exposure,
  })

  it('matches SHLookup at 512 directions, to float precision', () => {
    const target = new THREE.Vector3()
    let worst = 0
    for (const n of sphere(512)) {
      // three's own evaluator, not a transcription of it: `getIrradianceAt` is the JS twin of
      // `shGetIrradianceAt` in the shader, so this checks the code path the GPU will run.
      sh.getIrradianceAt(new THREE.Vector3(n[0], n[1], n[2]), target)
      const mine = [target.x / Math.PI, target.y / Math.PI, target.z / Math.PI]
      const theirs = marmosetShLookup(IBL.sh as unknown as number[], toSkySpace(n))
      for (let k = 0; k < 3; k++) {
        worst = Math.max(worst, Math.abs((mine[k] as number) - (theirs[k] as number)))
      }
    }
    expect(worst).toBeLessThan(1e-6)
  })

  it('never needs Marmoset’s abs(), so the match is not an accident of clamping', () => {
    // `SHLookup` ends in `abs()`. That is NOT a linear operation, so if this sky's reconstruction
    // dipped below zero anywhere, no set of coefficients could reproduce it and the test above
    // would be measuring a coincidence. It does not: the darkest direction is still positive.
    let min = Number.POSITIVE_INFINITY
    const triples = shTriples(IBL.sh as unknown as number[])
    for (const n of sphere(4096)) {
      const [x, y, z] = toSkySpace(n)
      const basis = [1, y, z, x, x * y, y * z, 3 * z * z - 1, x * z, x * x - y * y]
      for (let k = 0; k < 3; k++) {
        let v = 0
        for (let i = 0; i < 9; i++) {
          v +=
            ((triples[i] as number[])[k] as number) *
            (SH_BASIS_CONSTANT[i] as number) *
            (basis[i] as number)
        }
        min = Math.min(min, v)
      }
    }
    expect(min).toBeGreaterThan(0)
  })
})

describe('the three corrections, each proved on its own', () => {
  const evaluate = (coefficients: THREE.SphericalHarmonics3, n: [number, number, number]) => {
    const t = new THREE.Vector3()
    coefficients.getIrradianceAt(new THREE.Vector3(...n), t)
    return [t.x / Math.PI, t.y / Math.PI, t.z / Math.PI]
  }

  it('divides out the Lambert lobe, not just the DC term', () => {
    // The failure this catches: hand three the raw coefficients. The average is right — band 0's
    // A_l is 1 — so a mean-colour check passes while every direction is wrong.
    const raw = new THREE.SphericalHarmonics3()
    const triples = shTriples(IBL.sh as unknown as number[])
    for (let i = 0; i < 9; i++) {
      const t = triples[i] as number[]
      ;(raw.coefficients[i] as THREE.Vector3).set(t[0] as number, t[1] as number, t[2] as number)
    }
    const ours = skyshopCoefficients({
      sh: IBL.sh as unknown as number[],
      rotationUnity: [0, 0, 0, 1],
      exposure: IBL.exposure,
    })
    // Band 0 is untouched by the lobe, so the two agree on the average...
    expect((ours.coefficients[0] as THREE.Vector3).x).toBeCloseTo(
      (raw.coefficients[0] as THREE.Vector3).x,
      6,
    )
    // ...and disagree by exactly 1.5x and 4x everywhere else.
    expect((ours.coefficients[1] as THREE.Vector3).x).toBeCloseTo(
      (raw.coefficients[1] as THREE.Vector3).x * 1.5,
      6,
    )
    expect((ours.coefficients[4] as THREE.Vector3).x).toBeCloseTo(
      (raw.coefficients[4] as THREE.Vector3).x * 4,
      6,
    )
  })

  it('mirrors z, so a sky bright on one side stays bright on the SAME side of the world', () => {
    // An identity-rotation probe. Marmoset's +z is our -z; if the mirror were missing these two
    // would be equal instead of swapped.
    const noYaw = skyshopCoefficients({
      sh: IBL.sh as unknown as number[],
      rotationUnity: [0, 0, 0, 1],
      exposure: IBL.exposure,
    })
    const front = evaluate(noYaw, [0, 0, 1])
    const back = evaluate(noYaw, [0, 0, -1])
    const unityFront = marmosetShLookup(IBL.sh as unknown as number[], [0, 0, 1])
    const unityBack = marmosetShLookup(IBL.sh as unknown as number[], [0, 0, -1])

    // The sky is genuinely asymmetric about that plane, or this proves nothing.
    expect(Math.abs((unityFront[0] as number) - (unityBack[0] as number))).toBeGreaterThan(0.05)

    expect(front[0] as number).toBeCloseTo(unityBack[0] as number, 6)
    expect(back[0] as number).toBeCloseTo(unityFront[0] as number, 6)
  })

  it('applies ibl_sky’s yaw, and it moves the light appreciably', () => {
    const yawed = skyshopCoefficients({
      sh: IBL.sh as unknown as number[],
      rotationUnity: IBL.rotationUnity as unknown as number[],
      exposure: IBL.exposure,
    })
    const flat = skyshopCoefficients({
      sh: IBL.sh as unknown as number[],
      rotationUnity: [0, 0, 0, 1],
      exposure: IBL.exposure,
    })
    // Same total light...
    expect((yawed.coefficients[0] as THREE.Vector3).x).toBeCloseTo(
      (flat.coefficients[0] as THREE.Vector3).x,
      6,
    )
    // ...pointing somewhere else. 139 degrees is most of a half-turn; a chunk of the sky's
    // directional energy has to move.
    let moved = 0
    for (const n of sphere(128)) {
      const a = evaluate(yawed, n)
      const b = evaluate(flat, n)
      moved = Math.max(moved, Math.abs((a[0] as number) - (b[0] as number)))
    }
    expect(moved).toBeGreaterThan(0.1)
  })

  it('is a no-op when there is nothing to correct but the mirror', () => {
    // Identity rotation, and evaluate at a z-free direction: the only remaining transform is the
    // Lambert division, so this isolates it. Catches a botched basis substitution that happens to
    // be self-consistent.
    const flat = skyshopCoefficients({
      sh: IBL.sh as unknown as number[],
      rotationUnity: [0, 0, 0, 1],
      exposure: IBL.exposure,
    })
    for (const n of [
      [1, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
      [0, -1, 0],
      [Math.SQRT1_2, Math.SQRT1_2, 0],
    ] as [number, number, number][]) {
      const ours = evaluate(flat, n)
      const theirs = marmosetShLookup(IBL.sh as unknown as number[], n)
      expect(ours[0] as number).toBeCloseTo(theirs[0] as number, 6)
      expect(ours[1] as number).toBeCloseTo(theirs[1] as number, 6)
      expect(ours[2] as number).toBeCloseTo(theirs[2] as number, 6)
    }
  })
})

describe('the probe', () => {
  it('carries the diffuse exposure, not the specular one', () => {
    // _ExposureIBL.x = masterIntensity * diffIntensity. Taking .y instead would be 1.72x too
    // bright, which is exactly the kind of error that gets "corrected" by eye later.
    const probe = createSkyshopProbe({
      sh: IBL.sh as unknown as number[],
      rotationUnity: IBL.rotationUnity as unknown as number[],
      exposure: IBL.exposure,
    })
    expect(probe.intensity).toBeCloseTo(IBL.masterIntensity * IBL.diffIntensity, 6)
    expect(probe.intensity).not.toBeCloseTo(IBL.exposure.specular, 3)
  })
})

// ── DEV-022: the OTHER ambient, the one baked from the sky you can see ─────
//
// `probeFromSkyRadiance` is off by default and that is exactly why it needs a
// test: an unlit code path rots silently. It does two of the three corrections
// above — the z mirror and the Lambert lobe — and skips the third, because
// `tools/extract/sky.mjs` projects the skybox in world space and there is no
// `ibl_sky` yaw to undo.
describe('the sky-radiance probe (DEV-022)', () => {
  const SKY = int01.lighting.sky.sh as unknown as number[][]

  /**
   * The radiance those coefficients encode, at a UNITY-space direction.
   *
   * Transcribed rather than imported, for the same reason `toSkySpace` is: an
   * oracle that calls the thing it is checking checks nothing. This is the same
   * nine basis functions `tools/extract/sky.mjs` projected with — which is also,
   * term for term, `THREE.SphericalHarmonics3.getBasisAt`.
   */
  const radianceUnity = (n: readonly [number, number, number]): number[] => {
    const [x, y, z] = n
    const basis = [
      0.282095,
      0.488603 * y,
      0.488603 * z,
      0.488603 * x,
      1.092548 * x * y,
      1.092548 * y * z,
      0.315392 * (3 * z * z - 1),
      1.092548 * x * z,
      0.546274 * (x * x - y * y),
    ]
    const out = [0, 0, 0]
    for (let i = 0; i < 9; i++) {
      for (let k = 0; k < 3; k++) {
        out[k] = (out[k] as number) + ((SKY[i] as number[])[k] as number) * (basis[i] as number)
      }
    }
    return out
  }

  it('reproduces the projected sky at 512 directions, to float precision', () => {
    // The whole claim, and it is total: for EVERY three-space direction, the
    // probe's irradiance equals the sky's radiance at the MIRRORED direction.
    // Divide by pi because `getIrradianceAt` carries the pi that
    // `BRDF_Lambert` later divides back out.
    const probe = probeFromSkyRadiance(SKY, 1)
    const target = new THREE.Vector3()
    let worst = 0
    for (const n of sphere(512)) {
      probe.sh.getIrradianceAt(new THREE.Vector3(n[0], n[1], n[2]), target)
      const mine = [target.x / Math.PI, target.y / Math.PI, target.z / Math.PI]
      const theirs = radianceUnity([n[0], n[1], -n[2]])
      for (let k = 0; k < 3; k++) {
        worst = Math.max(worst, Math.abs((mine[k] as number) - (theirs[k] as number)))
      }
    }
    expect(worst).toBeLessThan(1e-6)
  })

  it('flips 2, 5 and 7 — and NOT 6, which is the one that gets it wrong', () => {
    // Index 6 is `3z^2 - 1`: even in z, so it must NOT change sign. A
    // hand-written "flip everything with a z in it" flips it, and the result is
    // a sky whose vertical gradient is inverted while every axis test still
    // passes.
    const probe = probeFromSkyRadiance(SKY, 1)
    const A = [1, 2 / 3, 2 / 3, 2 / 3, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4]
    for (let i = 0; i < 9; i++) {
      const expected =
        (((SKY[i] as number[])[0] as number) / (A[i] as number)) * ([2, 5, 7].includes(i) ? -1 : 1)
      expect((probe.sh.coefficients[i] as THREE.Vector3).x).toBeCloseTo(expected, 6)
    }
    // And the three that flip are not all ~0, or the assertion above is vacuous.
    for (const i of [2, 5, 7]) {
      expect(Math.abs((SKY[i] as number[])[0] as number)).toBeGreaterThan(0.01)
    }
  })

  it('carries the exposure it is handed, so the switch changes colour not brightness', () => {
    const probe = probeFromSkyRadiance(SKY, TERRAIN.simonet.ibl.exposure.diffuse)
    expect(probe.intensity).toBeCloseTo(TERRAIN.simonet.ibl.exposure.diffuse, 6)
  })

  it('is a DIFFERENT sky from the baked one — which is the finding itself', () => {
    // If these ever agreed, DEV-022 would be pointless and the row should go.
    // The baked ambient is near-neutral; the visible sky is an orange sunset.
    const baked = shTriples(IBL.sh as unknown as number[])[0] as number[]
    const visible = SKY[0] as number[]
    const chroma = (c: number[]) => (c[0] as number) / (c[2] as number)
    expect(chroma(baked)).toBeLessThan(1.15)
    expect(chroma(visible)).toBeGreaterThan(1.5)
  })
})

// ── The direct light, which was running 2 pi too weak ─────────────────────
//
// The ambient above is exact to float precision and always was. The SUN was
// not, and the two errors are the same shape: three carries a `1/pi` in
// `BRDF_Lambert` that Marmoset does not, and the ambient path happens to carry
// a matching `pi` on the way in while the direct path does not.
//
// These tests pin BOTH halves — the constant, and three's own shader source.
// A three upgrade that changed either would otherwise silently re-break the
// look, and the failure mode is "the mountains go flat", which reads as art.
describe('the direct light (Marmoset is 2x, three is 1/pi)', () => {
  it('is 2 pi, and int_01 ends up at 8.17', () => {
    expect(MARMOSET_DIRECT_SCALE).toBeCloseTo(6.283185307, 9)
    // `MarmosetDirect.cginc`: `half3 diff = (2.0 * dp) * s.Albedo.rgb;`
    expect(marmosetSunIntensity(1)).toBeCloseTo(2 * Math.PI, 12)
    expect(marmosetSunIntensity(int01.lighting.sun.intensity)).toBeCloseTo(8.16814, 4)
  })

  it("still matches three's OWN shader source, which is where the pi comes from", () => {
    // Not a transcription of three's maths — the strings out of the build we
    // are pinned to. If a release changes the Lambert BRDF or stops scaling
    // irradiance by `dotNL * directLight.color`, this fails loudly instead of
    // the terrain quietly going flat.
    const common = THREE.ShaderChunk.common
    expect(common).toContain('#define RECIPROCAL_PI 0.3183098861837907')
    expect(common.replace(/\s+/g, ' ')).toContain(
      'vec3 BRDF_Lambert( const in vec3 diffuseColor ) { return RECIPROCAL_PI * diffuseColor; }',
    )
    const physical = THREE.ShaderChunk.lights_physical_pars_fragment.replace(/\s+/g, ' ')
    expect(physical).toContain('vec3 irradiance = dotNL * directLight.color;')
    // r185 calls the field `diffuseContribution`; older builds called it
    // `diffuseColor`. The name is not the claim — `irradiance * BRDF_Lambert`
    // is — so match the shape and let the field name be either.
    expect(physical).toMatch(
      /reflectedLight\.directDiffuse \+= irradiance \* BRDF_Lambert\( material\.\w+ \);/,
    )
    // And the INDIRECT half, which is why the ambient needs no factor: the same
    // `BRDF_Lambert` divides out the pi that `shGetIrradianceAt` puts in.
    expect(physical).toMatch(/vec3 diffuse = irradiance \* BRDF_Lambert\( material\.\w+ \);/)
    expect(THREE.ShaderChunk.lights_pars_begin.replace(/\s+/g, ' ')).toContain(
      'vec3 irradiance = shGetIrradianceAt( worldNormal, lightProbe );',
    )
    // The pi lives here: `shGetIrradianceAt`'s band-0 term is `0.886227`, which
    // is `0.282095 * pi`. That is the pi `BRDF_Lambert` takes back out.
    expect(THREE.ShaderChunk.lights_pars_begin).toContain('0.886227')
  })

  it('does NOT apply to the ambient, which needs no correction at all', () => {
    // `getLightProbeIrradiance` returns `shGetIrradianceAt(...) * intensity`,
    // and that function carries the pi `BRDF_Lambert` then divides out. The
    // probe's intensity is therefore the raw Skyshop exposure, untouched.
    const ibl = TERRAIN.simonet.ibl
    const probe = createSkyshopProbe({
      sh: ibl.sh as unknown as number[],
      rotationUnity: ibl.rotationUnity as unknown as number[],
      exposure: ibl.exposure,
    })
    expect(probe.intensity).toBeCloseTo(ibl.exposure.diffuse, 9)
    expect(probe.intensity).not.toBeCloseTo(ibl.exposure.diffuse * MARMOSET_DIRECT_SCALE, 3)
  })

  it('leaves the WATER alone, because its shader has no 2x', () => {
    // The sea is Unity's stock `LightingBlinnPhong` — `s.Albedo *
    // gi.light.color * diff`, no doubling — and it is drawn by our own
    // ShaderMaterial from `sun.colorLinear` and `sun.intensity` directly rather
    // than by the scene light. Applying the Marmoset factor there would be 2 pi
    // too bright, so the level's raw number is what water.ts must see.
    expect(int01.lighting.sun.intensity).toBe(1.3)
    expect(marmosetSunIntensity(int01.lighting.sun.intensity)).not.toBe(1.3)
  })
})
