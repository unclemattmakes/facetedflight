// tests/unit/far-shadow-beyond.test.ts — the far-field term past the field's
// edge (DEV-497).
//
// The field covers the land terrain only, and until DEV-497 everything off it
// was lit, so the islands' long shadows stopped in a straight line on the sea
// at the field's edge. The claim is that off the field the top is exactly the
// entry point's top less the ray's fall, because nothing off the field casts.
//
// The ORACLE is outside the thing under test: a LARGER field that contains the
// small one and is flat sea floor everywhere else, marched by the same
// `buildSunHeight` from scratch. Its tops off the small field are the truth
// the extrapolation has to reproduce; it knows nothing about entry points.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { type Edition, validateEdition } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import { createFarShadow, SUN_HEIGHT_GLSL, SUN_HEIGHT_INCLUDE } from '@/render/far-shadow'
import type { HeightField } from '@/sim/terrain/height-field'
import {
  buildSunHeight,
  outsideSunHeight,
  sunEntryOf,
  sunReachOf,
  sunTopAt,
  sunTopBeyond,
  sunVisibilityAt,
} from '@/sim/terrain/sun-height'
import anniversaryJson from '../../content/editions/anniversary.json'

const TERRAIN_HEIGHT = 1000
const FLOOR = 10

/** `n` samples on `step` metres at `origin`, heights in metres. */
const fieldOf = (
  n: number,
  step: number,
  origin: [number, number],
  metres: (i: number, j: number) => number,
  scale: [number, number] = [1, 1],
): HeightField => {
  const heights = new Float32Array(n * n)
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) heights[j * n + i] = metres(i, j) / TERRAIN_HEIGHT
  return {
    vertPerSide: n,
    heights,
    step,
    terrainSize: (n - 1) * step,
    terrainHeight: TERRAIN_HEIGHT,
    originX: origin[0],
    originY: 0,
    originZ: origin[1],
    scaleX: scale[0],
    scaleY: 1,
    scaleZ: scale[1],
  }
}

/** Deterministic islands: 0..`amp` metres of relief over the floor. */
const islands = (seed: number, amp: number): ((i: number, j: number) => number) => {
  const cells = new Map<string, number>()
  let s = seed
  return (i, j) => {
    const k = `${i},${j}`
    let v = cells.get(k)
    if (v === undefined) {
      s = (s * 1664525 + 1013904223) >>> 0
      // A dome with noise on it, so rays graze real ridges, falling to the
      // flat floor well inside the rim: every shipped land field ends in open
      // sea floor, and the rim is where the extrapolation reads.
      const d = Math.hypot(i - 16, j - 16) / 12
      const dome = Math.max(0, 1 - d)
      v = FLOOR + dome * amp * (1 + (s / 4294967296) * 0.3)
      cells.set(k, v)
    }
    return v
  }
}

const toward = (azimuthDeg: number, elevationDeg: number): [number, number, number] => {
  const a = (azimuthDeg * Math.PI) / 180
  const e = (elevationDeg * Math.PI) / 180
  return [Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)]
}

/**
 * The small field (33² on 8 m, the massif), and the big one (129² on 8 m) that
 * holds it at an offset of 48 texels and is floor everywhere else — the same
 * heights texel for texel where the two overlap.
 */
const pair = (scale: [number, number] = [1, 1]) => {
  const step = 8
  const off = 48
  const massif = islands(20160101, 400)
  const small = fieldOf(33, step, [off * step * scale[0], off * step * scale[1]], massif, scale)
  const big = fieldOf(
    129,
    step,
    [0, 0],
    (i, j) => {
      const a = i - off
      const b = j - off
      return a >= 0 && b >= 0 && a <= 32 && b <= 32 ? massif(a, b) : FLOOR
    },
    scale,
  )
  return { small, big }
}

describe('the top past the field, against a march over a field that contains it (DEV-497)', () => {
  const cases: [number, number][] = [
    [0, 4],
    [37, 4],
    [135, 8],
    [-100, 15],
    [210, 30],
  ]
  for (const scale of [
    [1, 1],
    [2, 1],
  ] as [number, number][]) {
    for (const [az, el] of cases) {
      it(`azimuth ${az}°, elevation ${el}°, scale ${scale.join('x')}`, () => {
        const { small, big } = pair(scale)
        const sun = toward(az, el)
        const shS = buildSunHeight(small, sun)
        const shB = buildSunHeight(big, sun)
        const truthAt = (i: number, j: number): number =>
          Math.max(sunTopAt(shB, i * 8 * scale[0], j * 8 * scale[1]), FLOOR)
        let shadowed = 0
        let exact = 0
        let checked = 0
        let worstOutsideBracket = 0
        for (let j = 1; j < 128; j++) {
          for (let i = 1; i < 128; i++) {
            const x = i * 8 * scale[0]
            const z = j * 8 * scale[1]
            if (!outsideSunHeight(shS, x, z)) continue
            const truth = truthAt(i, j)
            const got = Math.max(sunTopBeyond(shS, x, z) ?? Number.NEGATIVE_INFINITY, FLOOR)
            if (truth > FLOOR + 5) shadowed++
            if (Math.abs(got - truth) < 1) exact++
            // Within one texel: the shadow's own silhouette is a jump of
            // hundreds of metres across one texel of the rim, and a bilinear
            // field puts that edge somewhere inside the texel, off the field
            // exactly as on it. So the claim is that every answer lies inside
            // the range the truth takes one texel either way.
            let lo = Number.POSITIVE_INFINITY
            let hi = Number.NEGATIVE_INFINITY
            for (let b = -1; b <= 1; b++)
              for (let a = -1; a <= 1; a++) {
                const t = truthAt(i + a, j + b)
                lo = Math.min(lo, t)
                hi = Math.max(hi, t)
              }
            worstOutsideBracket = Math.max(worstOutsideBracket, lo - got, got - hi)
            checked++
          }
        }
        // The premise first: this sample CAN separate the rules. Off the
        // field, the old rule reads every one of these as lit.
        expect(checked).toBeGreaterThan(10_000)
        expect(shadowed, 'the massif shades points off the small field').toBeGreaterThan(200)
        expect(worstOutsideBracket, 'and within one texel of it everywhere').toBeLessThan(1)
        // First run: 0.949 to 1.000 over the ten cases, 0.000 m outside the bracket.
        expect(exact / checked, 'and to a metre almost everywhere').toBeGreaterThan(0.93)
      })
    }
  }
})

describe('the sim mirror (DEV-497)', () => {
  it('a point in a long shadow off the field is in shadow; up-sun of the field it is lit', () => {
    const { small } = pair()
    // Sun toward +x, 4°: shadows run toward −x, off the field's low-x side.
    const sh = buildSunHeight(small, toward(0, 4))
    const zMid = small.originZ + small.terrainSize / 2
    const downSun = small.originX - 500
    const upSun = small.originX + small.terrainSize + 500
    expect(outsideSunHeight(sh, downSun, zMid)).toBe(true)
    expect(sunVisibilityAt(sh, downSun, FLOOR, zMid, 3)).toBe(0)
    expect(sunVisibilityAt(sh, upSun, FLOOR, zMid, 3)).toBe(1)
    expect(sunTopBeyond(sh, upSun, zMid)).toBeNull()
  })

  it('the top falls by tan(elevation) per metre off the field', () => {
    const { small } = pair()
    const sh = buildSunHeight(small, toward(0, 4))
    const zMid = small.originZ + small.terrainSize / 2
    const a = sunTopBeyond(sh, small.originX - 100, zMid) as number
    const b = sunTopBeyond(sh, small.originX - 1100, zMid) as number
    expect(a - b).toBeCloseTo(1000 * Math.tan((4 * Math.PI) / 180), 3)
  })

  it('a degenerate field continues nothing', () => {
    const { small } = pair()
    // A sun ON the horizon. 0.1° was degenerate until DEV-527, which marches a
    // sun between the horizon and the 0.5° floor at the floor.
    const sh = buildSunHeight(small, toward(0, 0))
    expect(sh.degenerate).toBe(true)
    expect(sunReachOf(sh)).toBeNull()
    expect(sunTopBeyond(sh, small.originX - 500, small.originZ + 10)).toBeNull()
  })

  it('the slab test: on the field is t 0 at the point; a ray pointing away misses', () => {
    const reach = { ux: 1, uz: 0, dropPerMetre: 0.1 }
    expect(sunEntryOf(reach, 100, 40, 60)).toEqual({ mx: 40, mz: 60, t: 0 })
    expect(sunEntryOf(reach, 100, -30, 60)).toEqual({ mx: 0, mz: 60, t: 30 })
    expect(sunEntryOf(reach, 100, 130, 60)).toBeNull()
    expect(sunEntryOf(reach, 100, -30, 160)).toBeNull()
  })
})

describe('the shader takes the same ray (DEV-497)', () => {
  const code = SUN_HEIGHT_GLSL.replace(/\/\/[^\n]*/g, '')

  it('reads the map at the entry point and lowers the top by the fall, object path only', () => {
    expect(code).toContain('uniform vec4 uSunTopF;')
    expect(code).toContain('vec2 uv = ff2At * uSunTopB.y * uSunTopB.z + uSunTopB.w;')
    expect(code).toContain('swept.r - ff2Fall - uSunTopC.z')
    // The continuation sits under the object path's guard; the ground keeps
    // its box, because there is no land off the field.
    const start = code.indexOf('#ifndef FF2_SUN_GROUND')
    expect(start).toBeGreaterThan(-1)
    expect(code.indexOf('uSunTopF.xy')).toBeGreaterThan(start)
    // Lit by the TERRAIN off the field; DEV-585's cloud term still applies there.
    expect(code).toContain('if ( !ff2On && ff2Meets < 0.5 ) return ff2Cloud;')
  })

  it('uploads the field’s own ray, and none without a field', () => {
    const state = createEditionState(
      validateEdition(anniversaryJson as unknown as Edition),
      DEFAULT_SETTINGS,
    )
    const fs = createFarShadow(state)
    const sea = new THREE.MeshStandardMaterial()
    fs.applyTo(sea)
    const shader = {
      uniforms: {} as Record<string, { value: THREE.Vector4 }>,
      vertexShader: 'void main() {\n#include <begin_vertex>\n}',
      fragmentShader: `void main() {\n${SUN_HEIGHT_INCLUDE}\n}`,
    }
    sea.onBeforeCompile?.(shader as never, {} as never)
    const { small } = pair([2, 1])
    // three space: the sun TRAVELS down and toward −x (the direction the
    // field marches is its negation, in sim space).
    const sh = fs.setWorld(small, [-0.99, -0.07, 0.1])
    expect(sh).not.toBeNull()
    const reach = sunReachOf(sh as NonNullable<typeof sh>)
    expect(reach).not.toBeNull()
    const f = shader.uniforms.uSunTopF?.value as THREE.Vector4
    expect(f.x).toBeCloseTo(reach?.ux as number, 6)
    expect(f.y).toBeCloseTo(reach?.uz as number, 6)
    expect(f.z).toBeCloseTo(reach?.dropPerMetre as number, 6)
    expect(f.w).toBe(1)
    fs.setWorld(null, null)
    expect(f.w).toBe(0)
    fs.dispose()
  })
})
