// tests/unit/sun-height.test.ts — the baked terrain-shadow field (DEV-116).
//
// The sweep is compared against the brute-force ray march EXHAUSTIVELY on a
// small field at several azimuths, not spot-checked — CLAUDE.md's oracle
// lesson: chunk (0,0) matched to 4 mm with two real bugs live.

import { describe, expect, it } from 'vitest'
import { sunTravelOf } from '@/content/player-course-light'
import { towardSunSim } from '@/render/far-shadow'
import type { HeightField } from '@/sim/terrain/height-field'
import { outsideField, terrainHeightAt } from '@/sim/terrain/height-field'
import {
  buildSunHeight,
  MIN_SUN_HEIGHT_SIN,
  shadowedByMarch,
  smoothstep,
  sunDepthAt,
  sunGroundVisibilityAt,
  sunReachOf,
  sunTopAt,
  sunVisibilityAt,
} from '@/sim/terrain/sun-height'
import { fieldFor, haveMaps, loadLevelJson } from './helpers/terrain-field'

/** A synthetic field: `n` samples on `step` metres, heights in METRES via a fn. */
const fieldOf = (
  n: number,
  step: number,
  metres: (x: number, z: number) => number,
  extra: Partial<HeightField> = {},
): HeightField => {
  const terrainHeight = 1000
  const heights = new Float32Array(n * n)
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) heights[z * n + x] = metres(x, z) / terrainHeight
  return {
    vertPerSide: n,
    heights,
    step,
    terrainSize: (n - 1) * step,
    terrainHeight,
    originX: 0,
    originY: 0,
    originZ: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    ...extra,
  }
}

/** A deterministic pseudo-random field — no Math.random in a test either. */
const noisy = (n: number, step: number, amplitude: number): HeightField => {
  let s = 20160101
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
  const cells: number[] = []
  for (let i = 0; i < n * n; i++) cells.push(rnd() * amplitude)
  return fieldOf(n, step, (x, z) => cells[z * n + x] as number)
}

const toward = (azimuthDeg: number, elevationDeg: number): [number, number, number] => {
  const a = (azimuthDeg * Math.PI) / 180
  const e = (elevationDeg * Math.PI) / 180
  return [Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)]
}

describe('buildSunHeight — a flat field', () => {
  it('has tops equal to the terrain everywhere and zero depth', () => {
    const f = fieldOf(17, 8, () => 50)
    const sh = buildSunHeight(f, toward(30, 4))
    for (let i = 0; i < sh.tops.length; i++) expect(sh.tops[i]).toBeCloseTo(50, 6)
    expect(sh.maxDepth).toBe(0)
    expect(sh.degenerate).toBe(false)
  })
})

describe('buildSunHeight — one spike', () => {
  // A 100 m post in the middle of a 33-grid on 8 m. At 4° the shadow is
  // 100 / tan(4°) = 1,430 m long, which runs off the 256 m map — so measure at
  // 45°, where it is 100 m: 12.5 texels.
  const n = 33
  const mid = 16
  const f = fieldOf(n, 8, (x, z) => (x === mid && z === mid ? 100 : 0))

  it('shadows DOWN-sun of the spike for h / tan(elevation) metres, and nothing up-sun', () => {
    // Sun toward +x: the shadow lies toward -x.
    const sh = buildSunHeight(f, toward(0, 45))
    const expectLen = 100 / Math.tan(Math.PI / 4)
    for (let x = 0; x < n; x++) {
      const top = sh.tops[mid * n + x] as number
      const dist = (mid - x) * 8
      if (x > mid) expect(top, `up-sun x=${x}`).toBe(0)
      else if (x < mid && dist < expectLen)
        expect(top, `down-sun x=${x}`).toBeCloseTo(100 - dist, 3)
      else if (x < mid) expect(top, `beyond x=${x}`).toBe(0)
    }
  })

  it('the shadow follows the azimuth, not the grid: sun toward +z shadows -z', () => {
    const sh = buildSunHeight(f, toward(90, 45))
    expect(sh.tops[(mid - 1) * n + mid]).toBeCloseTo(92, 3)
    expect(sh.tops[(mid + 1) * n + mid]).toBe(0)
    expect(sh.tops[mid * n + mid - 1]).toBe(0)
    expect(sh.tops[mid * n + mid + 1]).toBe(0)
  })

  it('a point in the AIR above the top is lit where the ground below it is not', () => {
    const sh = buildSunHeight(f, toward(0, 45))
    const x = (mid - 4) * 8 // 32 m down-sun: top = 68 m
    const z = mid * 8
    expect(sunTopAt(sh, x, z)).toBeCloseTo(68, 3)
    expect(sunVisibilityAt(sh, x, 0, z, 0)).toBe(0)
    expect(sunVisibilityAt(sh, x, 67, z, 0)).toBe(0)
    expect(sunVisibilityAt(sh, x, 69, z, 0)).toBe(1)
    // Soft: 4 m, ONE-SIDED below the top (DEV-133). A point at the top is fully
    // lit; the fade runs down from it. DEV-116 centred it, which put the
    // midpoint on the terrain itself wherever the ground was lit.
    expect(sunVisibilityAt(sh, x, 68, z, 4)).toBe(1)
    expect(sunVisibilityAt(sh, x, 66, z, 4)).toBeCloseTo(0.5, 6)
    expect(sunVisibilityAt(sh, x, 64, z, 4)).toBe(0)
    expect(sunVisibilityAt(sh, x, 70, z, 4)).toBe(1)
    // A lift lowers the edge by that much, for a prop's foot on a jittered facet.
    expect(sunVisibilityAt(sh, x, 66, z, 0, 2)).toBe(1)
    expect(sunVisibilityAt(sh, x, 65.9, z, 0, 2)).toBe(0)
  })

  it('the GROUND is judged by its texel depth, exactly lit where the top is the terrain', () => {
    const sh = buildSunHeight(f, toward(0, 45))
    // Every texel: where the ground is shaded, depth is top minus terrain;
    // where it is lit the top IS the terrain and the depth is the (negative)
    // clearance, so `tops` never dips and `depths` carries the sign.
    for (let i = 0; i < n * n; i++) {
      const h = i === mid * n + mid ? 100 : 0
      expect(sh.tops[i]).toBeGreaterThanOrEqual(h)
      const d = sh.depths[i] as number
      if (d > 0) expect(d).toBeCloseTo((sh.tops[i] as number) - h, 5)
      else expect(sh.tops[i]).toBeCloseTo(h, 5)
    }
    const z = mid * 8
    // 32 m down-sun the ground (0 m) sits 68 m under its top.
    expect(sunDepthAt(sh, (mid - 4) * 8, z)).toBeCloseTo(68, 3)
    expect(sunGroundVisibilityAt(sh, (mid - 4) * 8, z, 0)).toBe(0)
    expect(sunGroundVisibilityAt(sh, (mid - 4) * 8, z, 3)).toBe(0)
    // Up-sun of the spike nothing shades the ground: the ray, marched from one
    // grid step out, clears flat ground by one step's rise — 8 m at 45° — so
    // the depth is NEGATIVE and the ground is lit exactly, whatever the drawn
    // mesh's height would have been.
    expect(sunDepthAt(sh, (mid + 4) * 8, z)).toBeCloseTo(-8, 3)
    expect(sunGroundVisibilityAt(sh, (mid + 4) * 8, z, 0)).toBe(1)
    expect(sunGroundVisibilityAt(sh, (mid + 4) * 8, z, 3)).toBe(1)
    // The signed field crosses zero INSIDE the texel between the last shaded
    // texel and the first lit one — which is what puts the edge off the grid.
    // Down-sun the spike's shadow ends where 100 − 8·t = 0, t = 12.5 steps.
    expect(sunDepthAt(sh, (mid - 12) * 8, z)).toBeGreaterThan(0)
    expect(sunDepthAt(sh, (mid - 13) * 8, z)).toBeLessThan(0)
    const edge = (mid - 12.5) * 8
    expect(Math.abs(sunDepthAt(sh, edge, z))).toBeLessThan(2)
    // The spike's own texel is lit (its top is itself).
    expect(sunGroundVisibilityAt(sh, mid * 8, z, 3)).toBe(1)
    // Off the field: lit.
    expect(sunGroundVisibilityAt(sh, -10, 0, 3)).toBe(1)
  })

  it('outside the field is lit', () => {
    const sh = buildSunHeight(f, toward(0, 45))
    expect(sunVisibilityAt(sh, -10, 0, 0, 4)).toBe(1)
    expect(sunVisibilityAt(sh, 0, 0, 999, 4)).toBe(1)
  })
})

/**
 * The exact top at a texel: march toward the sun and take the highest point
 * any terrain sample puts the ray at. What the sweep approximates.
 */
const exactTop = (
  f: HeightField,
  x: number,
  z: number,
  dir: readonly [number, number, number],
  stepMetres: number,
): number => {
  const len = Math.hypot(dir[0], dir[1], dir[2])
  const sx = dir[0] / len
  const sy = dir[1] / len
  const sz = dir[2] / len
  const horiz = Math.hypot(sx, sz)
  const tanE = sy / horiz
  let top = terrainHeightAt(f, x, z)
  let px = x
  let pz = z
  let dist = 0
  for (let k = 0; k < 100_000; k++) {
    px += (sx / horiz) * stepMetres
    pz += (sz / horiz) * stepMetres
    dist += stepMetres
    if (outsideField(f, px, pz)) break
    const ray = terrainHeightAt(f, px, pz) - dist * tanE
    if (ray > top) top = ray
  }
  return top
}

/** Error of the sweep against the exact march, in METRES, over every interior texel. */
const sweepError = (
  f: HeightField,
  dir: readonly [number, number, number],
): { p50: number; p95: number; max: number; count: number } => {
  const sh = buildSunHeight(f, dir)
  const n = f.vertPerSide
  const errs: number[] = []
  for (let z = 1; z < n - 1; z++) {
    for (let x = 1; x < n - 1; x++) {
      const wx = f.originX + x * f.step
      const wz = f.originZ + z * f.step
      errs.push(Math.abs(sunTopAt(sh, wx, wz) - exactTop(f, wx, wz, dir, f.step / 16)))
    }
  }
  errs.sort((a, b) => a - b)
  const q = (p: number): number =>
    errs[Math.min(errs.length - 1, Math.floor(p * errs.length))] as number
  return { p50: q(0.5), p95: q(0.95), max: errs[errs.length - 1] as number, count: errs.length }
}

const AZIMUTHS = [
  [0, 30],
  [17, 20],
  [45, 25],
  [113, 35],
  [200, 15],
  [290, 40],
  [359, 22],
] as const

describe('buildSunHeight — against the exact ray march, every interior texel', () => {
  // A smooth field — three sines, 150 m of relief over 100-300 m wavelengths,
  // which is what an 8 m sample of a real 1025-map looks like. The march takes
  // the exact maximum of the bilinear surface per cell, so what is measured here
  // is mostly the ORACLE's own half-metre sampling: slope × 0.25 m.
  const smooth = fieldOf(
    41,
    8,
    (x, z) =>
      80 +
      40 * Math.sin(x * 0.21) * Math.cos(z * 0.17) +
      35 * Math.sin((x + z) * 0.09) +
      25 * Math.cos(x * 0.05 - z * 0.13),
  )
  for (const [az, el] of AZIMUTHS) {
    it(`smooth field, azimuth ${az}°, elevation ${el}°: p95 under 0.3 m, max under 1.5 m`, () => {
      const e = sweepError(smooth, toward(az, el))
      expect(e.count).toBe(39 * 39)
      expect(e.p95, `p95 ${e.p95.toFixed(3)} max ${e.max.toFixed(3)}`).toBeLessThan(0.3)
      expect(e.max, `max ${e.max.toFixed(3)}`).toBeLessThan(1.5)
    })
  }

  // A pathological field — 120 m of white noise per 8 m texel, cliffs on every
  // side of every sample, slopes of 15:1. The oracle samples every half metre
  // and so can miss up to slope × 0.25 m ≈ 4 m of a ridge; the bound is the
  // oracle's, and the point is that the march stays inside it.
  const rough = noisy(33, 8, 120)
  for (const [az, el] of AZIMUTHS) {
    it(`noise field, azimuth ${az}°, elevation ${el}°: within the oracle's own sampling`, () => {
      const e = sweepError(rough, toward(az, el))
      expect(e.p95, `p95 ${e.p95.toFixed(2)} max ${e.max.toFixed(2)}`).toBeLessThan(4)
      expect(e.max, `max ${e.max.toFixed(2)}`).toBeLessThan(12)
    })
  }

  it('still agrees with the march on WHETHER a point is shadowed, off the edges', () => {
    const dir = toward(113, 35)
    const sh = buildSunHeight(smooth, dir)
    let disagree = 0
    let count = 0
    for (let z = 1; z < 40; z++) {
      for (let x = 1; x < 40; x++) {
        const wx = x * 8
        const wz = z * 8
        for (const lift of [0.05, 20]) {
          const y = terrainHeightAt(smooth, wx, wz) + lift
          const top = sunTopAt(sh, wx, wz)
          if (Math.abs(y - top) < 1) continue // on the edge: either answer is right
          count++
          if (shadowedByMarch(smooth, wx, y, wz, dir, 1, terrainHeightAt, outsideField) !== y < top)
            disagree++
        }
      }
    }
    expect(count).toBeGreaterThan(1000)
    expect(disagree, `${disagree}/${count}`).toBe(0)
  })

  it('takes a bounded number of traversal steps per ray', () => {
    const sh = buildSunHeight(smooth, toward(200, 15))
    // A naive march is up to 40 samples a ray on a 41-grid; the mipmap should
    // do better than that on average even with long 15-degree shadows.
    expect(sh.steps / (41 * 41)).toBeLessThan(40)
    expect(sh.steps).toBeGreaterThan(0)
  })

  it('is deterministic', () => {
    const f = rough
    const a = buildSunHeight(f, toward(45, 25))
    const b = buildSunHeight(f, toward(45, 25))
    expect(Array.from(a.tops)).toEqual(Array.from(b.tops))
    expect(a.maxDepth).toBe(b.maxDepth)
  })

  it('tops never fall below the terrain', () => {
    const f = rough
    const sh = buildSunHeight(f, toward(200, 15))
    for (let i = 0; i < sh.tops.length; i++) {
      const h = (f.heights[i] as number) * f.terrainHeight
      // Float32 storage against a float64 terrain: a few ppm, never more.
      expect(sh.tops[i]).toBeGreaterThanOrEqual(h - 1e-3)
    }
    expect(sh.maxDepth).toBeGreaterThan(0)
    expect(sh.minTop).toBeLessThanOrEqual(sh.maxTop)
  })
})

describe('buildSunHeight — the field transform', () => {
  it('honours the origin and scale the way terrainHeightAt does', () => {
    const f = fieldOf(17, 8, (x) => (x === 8 ? 40 : 0), { originX: -2048, originZ: -2048 })
    const sh = buildSunHeight(f, toward(0, 45))
    // Spike at mesh x = 64 → world x = -1984. One texel down-sun (-1992): 32 m.
    expect(sunTopAt(sh, -1992, -2048 + 64)).toBeCloseTo(32, 3)
    expect(sunVisibilityAt(sh, -1992, 10, -2048 + 64, 0)).toBe(0)
    expect(sunVisibilityAt(sh, -1976, 10, -2048 + 64, 0)).toBe(1)
  })
})

describe('buildSunHeight — degenerate suns', () => {
  const f = fieldOf(9, 8, (x) => (x === 4 ? 30 : 0))
  it('a sun on or under the horizon sweeps nothing rather than blackening the map', () => {
    for (const sy of [0, -0.01]) {
      const sh = buildSunHeight(f, [1, sy, 0])
      expect(sh.degenerate).toBe(true)
      expect(sh.maxDepth).toBe(0)
      expect(sh.tops[4 * 9 + 3]).toBe(0)
      // Nothing to lift: a sun at or under the horizon is not raised to the floor.
      expect(sh.marchedSun).toEqual(sh.towardSun)
    }
  })
  it('a sun dead overhead casts nothing', () => {
    const sh = buildSunHeight(f, [0, 1, 0])
    expect(sh.degenerate).toBe(true)
    expect(sh.maxDepth).toBe(0)
  })
  it('the 4-degree shipped sun is above the floor', () => {
    expect(Math.sin((4 * Math.PI) / 180)).toBeGreaterThan(MIN_SUN_HEIGHT_SIN)
  })
})

// ── A sun under the floor is marched AT it (DEV-527) ───────────────────────
//
// Matt's option C of DEV-495: `int_02_hoverJet`'s 0.083° sun gets far shadows,
// marched at the 0.5° floor on its own heading. Only the march is lifted.

describe('buildSunHeight — a sun between the horizon and the floor (DEV-527)', () => {
  const f = fieldOf(9, 8, (x) => (x === 4 ? 30 : 0))
  const floorSun = (az: number): [number, number, number] => {
    const c = Math.sqrt(1 - MIN_SUN_HEIGHT_SIN * MIN_SUN_HEIGHT_SIN)
    return [c * Math.cos(az), MIN_SUN_HEIGHT_SIN, c * Math.sin(az)]
  }
  const low = (az: number, sin: number): [number, number, number] => {
    const c = Math.sqrt(1 - sin * sin)
    return [c * Math.cos(az), sin, c * Math.sin(az)]
  }

  it('is marched, and casts: the spike shades the texel down-sun of it', () => {
    const sh = buildSunHeight(f, [1, MIN_SUN_HEIGHT_SIN * 0.5, 0])
    expect(sh.degenerate).toBe(false)
    // Toward the sun is +x, so x = 3 is down-sun of the 30 m spike at x = 4.
    expect(sh.depths[4 * 9 + 3] as number).toBeGreaterThan(29)
  })

  it('gives the floor sun on the same heading, texel for texel', () => {
    const smooth = fieldOf(33, 8, (x, z) => 60 + 40 * Math.sin(x * 0.3) * Math.cos(z * 0.23))
    for (const az of [0.4, 2.1, -1.3]) {
      // int_02's own 0.083°, and one a hair above the horizon.
      for (const sin of [Math.sin((0.083423 * Math.PI) / 180), 1e-6]) {
        const lifted = buildSunHeight(smooth, low(az, sin))
        const atFloor = buildSunHeight(smooth, floorSun(az))
        expect(lifted.degenerate).toBe(false)
        let worst = 0
        for (let i = 0; i < lifted.tops.length; i++) {
          worst = Math.max(
            worst,
            Math.abs((lifted.tops[i] as number) - (atFloor.tops[i] as number)),
          )
          worst = Math.max(
            worst,
            Math.abs((lifted.depths[i] as number) - (atFloor.depths[i] as number)),
          )
        }
        // The lifted vector and `floorSun` are the same ray up to roundoff in
        // the last bits of x and z; float32 storage absorbs it.
        expect(worst).toBeLessThan(1e-3)
      }
    }
  })

  it('keeps the GIVEN sun as `towardSun`, and marches the lifted one', () => {
    const sin = Math.sin((0.083423 * Math.PI) / 180)
    const sh = buildSunHeight(f, low(0.4, sin))
    expect(sh.towardSun[1]).toBeCloseTo(sin, 12)
    expect(sh.marchedSun[1]).toBe(MIN_SUN_HEIGHT_SIN)
    expect(Math.hypot(...sh.marchedSun)).toBeCloseTo(1, 12)
    // Same heading.
    expect(Math.atan2(sh.marchedSun[2], sh.marchedSun[0])).toBeCloseTo(
      Math.atan2(sh.towardSun[2], sh.towardSun[0]),
      12,
    )
    // The ray past the field's edge falls at the MARCHED rate (DEV-497).
    const reach = sunReachOf(sh)
    expect(reach?.dropPerMetre).toBeCloseTo(Math.tan(Math.asin(MIN_SUN_HEIGHT_SIN)), 9)
  })

  it('a sun at or above the floor marches its own vector: `marchedSun` is `towardSun`', () => {
    for (const sin of [MIN_SUN_HEIGHT_SIN, Math.sin((4 * Math.PI) / 180), 0.6]) {
      const sh = buildSunHeight(f, low(1.1, sin))
      expect(sh.marchedSun).toEqual(sh.towardSun)
    }
  })
})

// ── A sun ON a grid axis (DEV-496) ─────────────────────────────────────────
//
// A heading of exactly 0, ±90 or 180° reaches the march with its other
// horizontal component as trig ROUNDOFF, ~1e-16, which never moves the ray off
// the grid line it starts on. Negative, the DDA sat in the cell behind that
// line with nothing to cross; positive, it sat on the map's far row. Both crept
// at EPS a step to the million-step guard: 5 s on int_01, and the rays were cut
// short. AZIMUTHS' own 0° never saw it: `toward(0, …)` gives an EXACT zero.
// The steps are the measure — a count cannot be slowed by a busy box.

/** FNV-1a over the bytes of every array, for pinning a march's output exactly. */
const fnv1a = (...arrays: Float32Array[]): string => {
  let h = 0x811c9dc5
  for (const a of arrays) {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ (bytes[i] as number), 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

describe('buildSunHeight — a sun on a grid axis (DEV-496)', () => {
  const smooth = fieldOf(
    41,
    8,
    (x, z) =>
      80 +
      40 * Math.sin(x * 0.21) * Math.cos(z * 0.17) +
      35 * Math.sin((x + z) * 0.09) +
      25 * Math.cos(x * 0.05 - z * 0.13),
  )
  // Each carries the roundoff on a different axis with a different sign. The
  // editor's own route in (`sunTravelOf` → `towardSunSim`) is the set a player
  // reaches with the 0.1° slider; `toward` is this file's.
  const cases: [string, [number, number, number]][] = [
    ['toward 90° (+x roundoff)', toward(90, 4)],
    ['toward 180° (+z roundoff)', toward(180, 4)],
    ['toward 270° (−x roundoff)', toward(270, 4)],
    ...[0, 90, -90, 180].map((az): [string, [number, number, number]] => [
      `editor heading ${az}°`,
      towardSunSim(sunTravelOf(az, 4)),
    ]),
  ]

  it('the cases really are roundoff, not zero — else they test nothing', () => {
    let tiny = 0
    for (const [, d] of cases) {
      for (const c of [d[0], d[2]]) if (c !== 0 && Math.abs(c) < 1e-12) tiny++
    }
    // Three from `toward` and at least two from the editor's route.
    expect(tiny).toBeGreaterThanOrEqual(5)
  })

  for (const [name, dir] of cases) {
    it(`${name}: an ordinary sun's steps a ray, and every ray its whole length`, () => {
      const sh = buildSunHeight(smooth, dir)
      expect(sh.degenerate).toBe(false)
      // The same bound 'takes a bounded number of traversal steps' holds an
      // ordinary sun to. Before DEV-496, on a 33-grid at 4°, the ±90° editor
      // headings took 29,400 a ray and 180° took 905,800.
      expect(sh.steps / (41 * 41)).toBeLessThan(40)
      // And the rays ran their whole length: the exact march agrees, interior.
      const e = sweepError(smooth, dir)
      expect(e.p95, `p95 ${e.p95.toFixed(3)} max ${e.max.toFixed(3)}`).toBeLessThan(0.3)
      expect(e.max, `max ${e.max.toFixed(3)}`).toBeLessThan(1.5)
    })
  }

  it('an axis sun is marched as exactly the axis: roundoff and zero give one field', () => {
    const exact = buildSunHeight(smooth, [-Math.cos(0.07), Math.sin(0.07), 0])
    const roundoff = buildSunHeight(smooth, [-Math.cos(0.07), Math.sin(0.07), -1.8e-16])
    expect(fnv1a(roundoff.tops, roundoff.depths)).toBe(fnv1a(exact.tops, exact.depths))
  })

  // What DEV-496 must NOT move: every sun off an axis. These pins were taken
  // from the march BEFORE the change and hold after it, byte for byte; so did
  // 3,084 suns swept every 0.7° at three elevations, and all thirteen shipped
  // missions' own bakes (docs/DEVIATIONS.md, DEV-496). Change one only on
  // purpose, and say in the ledger what moved.
  it("int_01's own sun over a synthetic field: the bytes before DEV-496", () => {
    const level = loadLevelJson('int_01_hoverJet') as { lighting: { sun: { direction: number[] } } }
    const sh = buildSunHeight(smooth, towardSunSim(level.lighting.sun.direction))
    expect(fnv1a(sh.tops, sh.depths)).toBe('944774bc')
  })
})

describe('smoothstep', () => {
  it('matches GLSL at the ends and the middle', () => {
    expect(smoothstep(0, 1, -1)).toBe(0)
    expect(smoothstep(0, 1, 0.5)).toBe(0.5)
    expect(smoothstep(0, 1, 2)).toBe(1)
  })
})

// ── The real thing ─────────────────────────────────────────────────────────
//
// Simonet's own 513-grid under int_01's 4-degree sun. Guarded on the gitignored
// maps (`haveMaps`), with the loud counterpart below so the guard cannot rot.
// The disk work is INSIDE the `it` (CLAUDE.md: `describe.skipIf` skips the
// tests, not the describe body).

describe.skipIf(!haveMaps)("buildSunHeight — Simonet Islands under int_01's sun", () => {
  it('marches the whole island and agrees with a fine ray march at sampled texels', () => {
    const level = loadLevelJson('int_01_hoverJet') as {
      environment: string
      worldOffset: number[]
      lighting: { sun: { direction: number[] } }
    }
    const f = fieldFor(level)
    const dir = towardSunSim(level.lighting.sun.direction)
    const t0 = Date.now()
    const sh = buildSunHeight(f, dir)
    const ms = Date.now() - t0
    expect(sh.degenerate).toBe(false)
    expect(sh.vertPerSide).toBe(513)
    // A 4-degree sun over 1,500 m of relief: shadows run off the map, so the
    // deepest shadow is most of the terrain height.
    expect(sh.maxDepth).toBeGreaterThan(300)
    // 200 texels spread across the island, deterministic, none on the edge.
    let seed = 7
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    const errs: number[] = []
    for (let i = 0; i < 200; i++) {
      const x = 1 + Math.floor(rnd() * 511)
      const z = 1 + Math.floor(rnd() * 511)
      const wx = f.originX + x * f.step * (f.scaleX || 1)
      const wz = f.originZ + z * f.step * (f.scaleZ || 1)
      errs.push(Math.abs(sunTopAt(sh, wx, wz) - exactTop(f, wx, wz, dir, 0.5)))
    }
    errs.sort((a, b) => a - b)
    const p95 = errs[Math.floor(0.95 * errs.length)] as number
    const max = errs[errs.length - 1] as number
    console.info(
      `sun-height simonet: ${ms} ms, ${(sh.steps / (513 * 513)).toFixed(1)} steps/ray, ` +
        `deepest ${sh.maxDepth.toFixed(1)} m, p95 err ${p95.toFixed(3)} m, max ${max.toFixed(3)} m`,
    )
    expect(p95).toBeLessThan(0.3)
    expect(max).toBeLessThan(2)
  })

  it("int_01's own bake is byte-for-byte the one before DEV-496", () => {
    const level = loadLevelJson('int_01_hoverJet') as {
      environment: string
      worldOffset: number[]
      lighting: { sun: { direction: number[] } }
    }
    const sh = buildSunHeight(fieldFor(level), towardSunSim(level.lighting.sun.direction))
    expect(fnv1a(sh.tops, sh.depths)).toBe('69d88478')
  })

  it("int_02_hoverJet's 0.083° sun is marched at the floor over alpine (DEV-527)", () => {
    // Before DEV-527 this bake was degenerate: no far term on int_02 at all.
    // The other twelve missions' bakes were byte-identical across the change
    // (docs/DEVIATIONS.md, DEV-527); this pins the one that moved.
    const level = loadLevelJson('int_02_hoverJet') as {
      environment: string
      worldOffset: number[]
      lighting: { sun: { direction: number[] } }
    }
    const sh = buildSunHeight(fieldFor(level), towardSunSim(level.lighting.sun.direction))
    expect(sh.degenerate).toBe(false)
    expect(sh.marchedSun[1]).toBe(MIN_SUN_HEIGHT_SIN)
    expect(fnv1a(sh.tops, sh.depths)).toBe('e96eb832')
  })

  it('lit ground is LIT — the centred fade DEV-116 shipped halved it, per vertex, with noise (DEV-133)', () => {
    const level = loadLevelJson('int_01_hoverJet') as {
      environment: string
      worldOffset: number[]
      lighting: { sun: { direction: number[] } }
    }
    const f = fieldFor(level)
    const sh = buildSunHeight(f, towardSunSim(level.lighting.sun.direction))
    const n = f.vertPerSide
    // The drawn mesh: `sim/terrain/faceted.ts` adds `jitter.y * randomOffset`
    // to every vertex, jitter inside the unit sphere. Simonet's randomOffset
    // is 1.3 (the sheet). A deterministic stand-in for it here.
    const jitter = 1.3
    let seed = 11
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296 - 0.5
    }
    // DEV-116's term, as shipped: smoothstep centred on the top, 3 m wide.
    const centred = (top: number, y: number): number => smoothstep(top - 1.5, top + 1.5, y)
    let lit = 0
    let sumOld = 0
    let sumNew = 0
    let minNew = 1
    for (let z = 2; z < n - 2; z += 3) {
      for (let x = 2; x < n - 2; x += 3) {
        const i = z * n + x
        if ((sh.depths[i] as number) > 0) continue // shaded ground; we want the lit
        const h = f.originY + (f.heights[i] as number) * f.terrainHeight * (f.scaleY || 1)
        if (h < 120) continue // the seabed is not ground anyone sees
        lit++
        const yDrawn = h + rnd() * 2 * jitter
        sumOld += centred(sh.tops[i] as number, yDrawn)
        const wx = f.originX + x * f.step * (f.scaleX || 1)
        const wz = f.originZ + z * f.step * (f.scaleZ || 1)
        const v = sunGroundVisibilityAt(sh, wx, wz, 3)
        sumNew += v
        if (v < minNew) minNew = v
      }
    }
    expect(lit).toBeGreaterThan(2000)
    const meanOld = sumOld / lit
    const meanNew = sumNew / lit
    console.info(
      `sun-height simonet lit ground (${lit} texels): centred fade mean ${meanOld.toFixed(3)}, ` +
        `ground path mean ${meanNew.toFixed(3)} min ${minNew.toFixed(3)}`,
    )
    // The bug, measured: a lit facet saw about half the sun on average.
    expect(meanOld).toBeGreaterThan(0.4)
    expect(meanOld).toBeLessThan(0.6)
    // The fix: every lit texel sees all of it, exactly.
    expect(minNew).toBe(1)
  })
})

describe.skipIf(haveMaps)('buildSunHeight — Simonet maps not mounted', () => {
  it('is skipping the real-field check, loudly', () => {
    expect(haveMaps).toBe(false)
  })
})
