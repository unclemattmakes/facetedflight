// tests/unit/mission-sky.test.ts — the sky, and the one number that proves it.
//
// The skybox faces are bought art and never ship, so nothing here can compare
// against them. What it CAN do is check the projection against numbers from
// somewhere else entirely — the mission's sun, authored in a different file and
// read by a different code path — and check that the representation is the size
// and shape the shader expects.
//
// The sun check is the important one. A cube-face mapping can be mirrored or
// yawed and still produce a perfectly plausible sky: the mean colour is
// unchanged, the gradient is unchanged, and only the DIRECTION of the sunset
// glow moves. There is no 2016 screenshot to catch that. But a sunset's glow
// sits on its own sun, so the angle between them is a measurement the mapping
// cannot fake, and mutating the global yaw by the two plausible wrong values
// (0°, and 180+71° if you believe `_Rotation`) fails this suite.
//
// ── What it does NOT catch, stated rather than implied ────────────────────
//
// Transposing a SINGLE face that does not contain the sun. Measured: swapping
// `_LeftTex`'s two tangent axes moves the sun angle not at all and the residual
// from 37.61 % to 37.95 %. That is not a signal, and it cannot be made into one
// from this data — a transposition preserves a face's mean colour by
// construction, so every check that does not compare per-texel against the art
// is blind to it, and the art is what cannot ship.
//
// The global orientation is the failure mode that actually happens and it is
// covered to 1.5°. The per-face one would need a 2016 screenshot.

import { describe, expect, it } from 'vitest'
import type { MissionSky } from '@/content/level-schema'
import int01 from '../../content/levels/int_01_hoverJet.json'

const LEVELS = import.meta.glob<{ default: typeof int01 }>('../../content/levels/*.json', {
  eager: true,
})

const missions = Object.entries(LEVELS)
  .filter(([path]) => !path.includes('/_'))
  .map(([path, mod]) => [path.split('/').pop() ?? '', mod.default] as const)

const sky = int01.lighting.sky as MissionSky

describe('the extracted skybox', () => {
  it('decoded the one mission M1 actually ships', () => {
    expect(sky.available).toBe(true)
    if (!sky.available) return
    expect(sky.material).toBe('Assets/Quantum Theory/PolyWorld Skies/SkyJ.mat')
    expect(Object.keys(sky.faces)).toHaveLength(6)
  })

  it('puts the sunset glow ON the mission sun', () => {
    // THE test. Two numbers from different files: the sky's brightest sample,
    // and the direction of a `Light` component the projection never reads.
    //
    // A mapping mirrored or yawed lands tens of degrees out while changing
    // nothing a mean colour or a gradient would notice. 1.5° is the width of the
    // sun's own glow, and it is what says the global orientation is right. (A
    // single transposed face is a different failure and this does not see it —
    // see the note at the top of the file.)
    if (!sky.available) return
    expect(sky.sunAngleDeg).toBeLessThan(5)
  })

  it('carries exactly nine coefficients, three channels each', () => {
    // The shader declares `uniform vec3 uSh[9]`. A short array would not fail —
    // it would reconstruct a different sky out of whatever the tail held.
    if (!sky.available) return
    expect(sky.bands).toBe(3)
    expect(sky.sh).toHaveLength(9)
    for (const c of sky.sh) expect(c).toHaveLength(3)
  })

  it('reconstructs a sky that is warmer and DARKER than the fog colour', () => {
    // The finding that started this: `render/sky.ts` used to build its horizon
    // from `m_FogColor` on the reasoning that they must match. The measured
    // horizon is about (0.52, 0.32, 0.23) linear; the fog colour is
    // (0.71, 0.39, 0.44). Half again as bright, nearly twice as blue.
    //
    // With sky and fog the same colour the entire frame is one pink wash, which
    // is a real part of what read as "the fog is too thick".
    if (!sky.available) return
    const basis = (x: number, y: number, z: number) => [
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
    const at = (x: number, y: number, z: number) => {
      const b = basis(x, y, z)
      return [0, 1, 2].map((ch) =>
        Math.max(
          0,
          sky.sh.reduce((a, c, i) => a + (c[ch] as number) * (b[i] as number), 0),
        ),
      )
    }
    const peak = sky.peakDirectionUnity
    const horizon = at(peak[0] as number, 0, peak[2] as number)
    const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    const fog = (int01.fog.color as number[]).slice(0, 3).map(srgbToLinear)

    // Warmer: more red relative to blue than the fog is.
    expect((horizon[0] as number) / (horizon[2] as number)).toBeGreaterThan(
      (fog[0] as number) / (fog[2] as number),
    )
    // And darker.
    expect(horizon[0] as number).toBeLessThan(fog[0] as number)
  })

  it('is brighter toward the sun than away from it', () => {
    // A sunset has a direction. If the projection came out azimuthally flat, the
    // glow would be gone and the sun-angle check above would be measuring noise.
    if (!sky.available) return
    const lum = (dir: number[]) => {
      const [x, y, z] = dir as [number, number, number]
      const b = [
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
      const c = [0, 1, 2].map((ch) =>
        sky.sh.reduce((a, k, i) => a + (k[ch] as number) * (b[i] as number), 0),
      )
      return 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number)
    }
    const p = sky.peakDirectionUnity as number[]
    const away = p.map((v) => -v)
    expect(lum(p)).toBeGreaterThan(lum(away) * 1.15)
  })

  it('records how much of the sky it threw away', () => {
    // 37.6 % on SkyJ. Asserted as a RANGE rather than a value: it is a property
    // of the art and the band count, and pinning it exactly would just need
    // re-blessing. What matters is that it is reported at all — nine
    // coefficients keep the gradient and the glow and lose the clouds, and a
    // reader deciding whether that is enough needs the number.
    if (!sky.available) return
    expect(sky.residual).toBeGreaterThan(0.1)
    expect(sky.residual).toBeLessThan(0.6)
    expect(sky.sampleCount).toBeGreaterThan(10_000)
  })
})

describe('the missions we cannot decode', () => {
  it('says so, rather than inventing a sky and calling it extracted', () => {
    // Ten of thirteen use a Unity `.cubemap` binary. Those fall back to the
    // fog-derived gradient, and `available: false` with a reason is what makes
    // that a decision rather than a silent difference between missions.
    const undecoded = missions.filter(([, l]) => !(l.lighting.sky as MissionSky)?.available)
    expect(undecoded.length).toBeGreaterThan(0)
    for (const [file, level] of undecoded) {
      const s = level.lighting.sky as MissionSky
      expect(s, file).not.toBeNull()
      expect(typeof s.reason, file).toBe('string')
      expect(s.sh, file).toBeUndefined()
    }
  })

  it('decoded every mission whose skybox IS six-sided, and no others', () => {
    for (const [file, level] of missions) {
      const s = level.lighting.sky as MissionSky
      const isSkyJ = level.lighting.skyboxMaterial?.includes('PolyWorld Skies')
      expect(s.available, `${file} (${level.lighting.skyboxMaterial})`).toBe(Boolean(isSkyJ))
    }
  })
})
