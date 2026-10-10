// tests/unit/sky-dome.test.ts — the sky as geometry.
//
// Matt: *"i thought visually, we were rendering a lowpoly skybox?"* We were
// not: `render/sky.ts` drew a smooth 64x32 sphere shaded per fragment. The 2016
// sky is `PolyWorld Skies/SkyJ`, and its six faces are unambiguous — flat
// polygons everywhere, chunky cloud masses, and the sun as a bright hexagon.
//
// These pin the three properties that make a dome a sky rather than a sphere,
// and the one that stops it being a visible artifact.

import { describe, expect, it } from 'vitest'
import { icosphere } from '@/sim/clouds'
import {
  DOME_JITTER,
  generateSkyDome,
  generateSunCap,
  shRadiance,
  skyCloudLobes,
  skyCloudMask,
  sunCapTriangles,
} from '@/sim/sky-dome'

const SUBDIVISIONS = 4

describe('the sky dome', () => {
  const dome = generateSkyDome(SUBDIVISIONS, 1)

  it('is one facet per face, at the density SkyJ reads at', () => {
    // Mean cell size is `sqrt(4*pi / faces)`. SkyJ's cells span roughly a tenth
    // of a cube face, 6 to 11 degrees, which is subdivision 3; the shipped dome
    // is 4, at 2.8, because Matt asked for four times the density after seeing
    // 3 — a headset resolves a 5.7 degree facet as a wall.
    //
    // The band is wide on purpose: this guards the ORDER of magnitude, not the
    // art choice. Below a degree the sky is smooth again, which is where this
    // started; above ten it is a gradient with banding.
    expect(dome.triangleCount).toBe(20 * 4 ** SUBDIVISIONS)
    const meanDegrees = Math.sqrt((4 * Math.PI) / dome.triangleCount) * (180 / Math.PI)
    expect(meanDegrees).toBeGreaterThan(1)
    expect(meanDegrees).toBeLessThan(10)
  })

  it('stays watertight: the jitter moves SHARED vertices', () => {
    // Jitter after the split and every face's copy of a vertex goes somewhere
    // different — the dome opens into gaps, and because it is drawn with depth
    // testing off those gaps show the CLEAR colour, i.e. a sky full of holes
    // that still renders and still looks like a sky in a thumbnail.
    const distinct = new Set<string>()
    for (let i = 0; i < dome.positions.length; i += 3) {
      distinct.add(`${dome.positions[i]},${dome.positions[i + 1]},${dome.positions[i + 2]}`)
    }
    expect(distinct.size).toBe(10 * 4 ** SUBDIVISIONS + 2)
  })

  it('keeps every vertex on the unit sphere', () => {
    // The jitter is ANGULAR. Letting the radius vary makes the dome lumpy, and
    // a lumpy sky at a finite radius parallaxes against itself as you turn —
    // which reads as the sky sliding, and is the one way this can look broken
    // in motion rather than in a screenshot.
    for (let i = 0; i < dome.positions.length; i += 3) {
      const r = Math.hypot(
        dome.positions[i] as number,
        dome.positions[i + 1] as number,
        dome.positions[i + 2] as number,
      )
      expect(r).toBeCloseTo(1, 6)
    }
  })

  it('breaks the icosahedral regularity, which is what makes facets visible', () => {
    // A subdivided icosahedron has near-identical faces, so a smooth field
    // sampled per face reads as a smooth sphere with faint banding. The measure
    // is the SPREAD of face areas: regular is near zero, jittered is not.
    const areaSpread = (positions: Float32Array, triangleCount: number) => {
      const areas: number[] = []
      for (let f = 0; f < triangleCount; f++) {
        const b = f * 9
        const e1 = [
          (positions[b + 3] as number) - (positions[b] as number),
          (positions[b + 4] as number) - (positions[b + 1] as number),
          (positions[b + 5] as number) - (positions[b + 2] as number),
        ]
        const e2 = [
          (positions[b + 6] as number) - (positions[b] as number),
          (positions[b + 7] as number) - (positions[b + 1] as number),
          (positions[b + 8] as number) - (positions[b + 2] as number),
        ]
        areas.push(
          Math.hypot(
            (e1[1] as number) * (e2[2] as number) - (e1[2] as number) * (e2[1] as number),
            (e1[2] as number) * (e2[0] as number) - (e1[0] as number) * (e2[2] as number),
            (e1[0] as number) * (e2[1] as number) - (e1[1] as number) * (e2[0] as number),
          ) / 2,
        )
      }
      const mean = areas.reduce((a, b) => a + b, 0) / areas.length
      const variance = areas.reduce((a, b) => a + (b - mean) ** 2, 0) / areas.length
      return Math.sqrt(variance) / mean
    }

    // The bare icosphere, split the same way, for the control.
    const { vertices, faces } = icosphere(SUBDIVISIONS)
    const regular = new Float32Array(faces.length * 3)
    for (let f = 0; f < faces.length / 3; f++) {
      for (let k = 0; k < 3; k++) {
        const i = (faces[f * 3 + k] as number) * 3
        regular[f * 9 + k * 3] = vertices[i] as number
        regular[f * 9 + k * 3 + 1] = vertices[i + 1] as number
        regular[f * 9 + k * 3 + 2] = vertices[i + 2] as number
      }
    }
    const plain = areaSpread(regular, faces.length / 3)
    const jittered = areaSpread(dome.positions, dome.triangleCount)
    expect(plain).toBeLessThan(0.1)
    expect(jittered).toBeGreaterThan(plain * 2)
  })

  it('gives each face a unit direction through its own centre', () => {
    for (let f = 0; f < dome.triangleCount; f += 97) {
      const b = f * 9
      const cx =
        ((dome.positions[b] as number) +
          (dome.positions[b + 3] as number) +
          (dome.positions[b + 6] as number)) /
        3
      const cy =
        ((dome.positions[b + 1] as number) +
          (dome.positions[b + 4] as number) +
          (dome.positions[b + 7] as number)) /
        3
      const cz =
        ((dome.positions[b + 2] as number) +
          (dome.positions[b + 5] as number) +
          (dome.positions[b + 8] as number)) /
        3
      const l = Math.hypot(cx, cy, cz)
      const d = [
        dome.faceDirections[f * 3] as number,
        dome.faceDirections[f * 3 + 1] as number,
        dome.faceDirections[f * 3 + 2] as number,
      ]
      expect(Math.hypot(d[0] as number, d[1] as number, d[2] as number)).toBeCloseTo(1, 6)
      expect(d[0]).toBeCloseTo(cx / l, 6)
      expect(d[1]).toBeCloseTo(cy / l, 6)
      expect(d[2]).toBeCloseTo(cz / l, 6)
    }
  })

  it('is deterministic — same seed, same sky', () => {
    const a = generateSkyDome(2, 7)
    const b = generateSkyDome(2, 7)
    const c = generateSkyDome(2, 8)
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(Array.from(a.positions)).not.toEqual(Array.from(c.positions))
  })

  it('keeps the jitter small enough not to fold a facet through its neighbour', () => {
    // DOME_JITTER is an angular perturbation of a few degrees. Much more and a
    // vertex can cross an edge, which turns the sun's hexagon inside out.
    expect(DOME_JITTER).toBeLessThan(0.1)
  })
})

describe('the sky colour lookup', () => {
  const out = { r: 0, g: 0, b: 0 }

  it('reconstructs a constant sky from the band-0 coefficient alone', () => {
    // Band 0 times its basis constant IS the average radiance. Getting the
    // 0.282095 wrong scales the whole sky, which reads as an exposure choice
    // rather than as a bug.
    const sh = [[2, 4, 6], ...Array.from({ length: 8 }, () => [0, 0, 0])]
    shRadiance(sh, 0.3, -0.5, 0.81, out)
    expect(out.r).toBeCloseTo(2 * 0.282095, 9)
    expect(out.g).toBeCloseTo(4 * 0.282095, 9)
    expect(out.b).toBeCloseTo(6 * 0.282095, 9)
  })

  it('clamps at zero, because a negative radiance is not a colour', () => {
    // SH rings where the real sky has a hard edge, and a sunset horizon is one.
    // The clamp is the visible half of the extractor's 37.6% residual.
    const sh = [[-10, -10, -10], ...Array.from({ length: 8 }, () => [0, 0, 0])]
    shRadiance(sh, 0, 1, 0, out)
    expect(out.r).toBe(0)
    expect(out.g).toBe(0)
    expect(out.b).toBe(0)
  })

  it('varies with direction, or it is not a sky', () => {
    // A linear band alone: bright one way, dark the other.
    const sh = [[0, 0, 0], [1, 1, 1], ...Array.from({ length: 7 }, () => [0, 0, 0])]
    shRadiance(sh, 0, 1, 0, out)
    const up = out.r
    shRadiance(sh, 0, -1, 0, out)
    expect(up).toBeGreaterThan(0)
    expect(out.r).toBe(0) // clamped from negative
  })
})

describe('the sky cloud banks', () => {
  it('sits above the horizon, where SkyJ puts them', () => {
    // The banks are in the upper sky and the band along the horizon is clear.
    // Drawn isotropically they would sit as often below the horizon as above,
    // where nothing can see them and the sky above stays empty.
    const lobes = skyCloudLobes(200, 3)
    let above = 0
    for (let i = 0; i < 200; i++) if ((lobes[i * 4 + 1] as number) > 0) above++
    expect(above / 200).toBeGreaterThan(0.6)
  })

  it('produces unit directions', () => {
    const lobes = skyCloudLobes(64, 11)
    for (let i = 0; i < 64; i++) {
      expect(
        Math.hypot(lobes[i * 4] as number, lobes[i * 4 + 1] as number, lobes[i * 4 + 2] as number),
      ).toBeCloseTo(1, 6)
    }
  })

  it('is strongest toward a bank and zero away from every one', () => {
    // One lobe, pointing straight up.
    const lobes = new Float32Array([0, 1, 0, 1])
    expect(skyCloudMask(lobes, 1, 0, 1, 0)).toBeCloseTo(1, 6)
    expect(skyCloudMask(lobes, 1, 0, -1, 0)).toBe(0)
    expect(skyCloudMask(lobes, 1, 1, 0, 0)).toBe(0)
    // And it falls off between.
    const half = skyCloudMask(lobes, 1, 0, Math.SQRT1_2, Math.SQRT1_2)
    expect(half).toBeGreaterThan(0)
    expect(half).toBeLessThan(0.5)
  })

  it('never exceeds one, so a bank cannot invert the sky', () => {
    // The mask is a lerp weight. Overlapping lobes sum, and without the clamp
    // three banks on top of each other would push past the tint and out the
    // other side into a colour nothing authored.
    const lobes = new Float32Array([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1])
    expect(skyCloudMask(lobes, 3, 0, 1, 0)).toBe(1)
  })
})

// ── the sun's own surface ────────────────────────────────────────────────
//
// DEV-293, wishlist #22b. The sun used to be a term inside the dome's per-FACE
// colour, and a 1.8-degree feature on a 1.4-degree triangulation is three or
// four polygons whose union is a shard. The cap is the surface that can hold
// it.
//
// Everything below is a RELATIONSHIP — the cap against the dome, the cap
// against its own stated radius, the cap against the area a cap of that radius
// must have. None of it is a quaternion, a winding convention or a vertex
// position written down twice, because this repo's orientation lesson says
// that form of assertion is the belief restated rather than tested.

/** `dot(cross(b - a, c - a), centroid)` — positive when the face looks OUTWARD. */
const outwardness = (positions: Float32Array, t: number): number => {
  const p = t * 9
  const ax = positions[p] as number
  const ay = positions[p + 1] as number
  const az = positions[p + 2] as number
  const bx = positions[p + 3] as number
  const by = positions[p + 4] as number
  const bz = positions[p + 5] as number
  const cx = positions[p + 6] as number
  const cy = positions[p + 7] as number
  const cz = positions[p + 8] as number
  const ux = bx - ax
  const uy = by - ay
  const uz = bz - az
  const vx = cx - ax
  const vy = cy - ay
  const vz = cz - az
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  return (nx * (ax + bx + cx) + ny * (ay + by + cy) + nz * (az + bz + cz)) / 3
}

const cross3 = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

describe('the sun cap', () => {
  const RINGS = 10
  const SEGMENTS = 32
  const OUTER = Math.acos(0.9995)
  // Deliberately not an axis and not a unit vector: the caller hands this a
  // mission's sun, and `int_01_hoverJet`'s points nowhere convenient.
  const DIR: readonly [number, number, number] = [-1.9245, 0.13951, -0.52612]
  const cap = generateSunCap(DIR, OUTER, RINGS, SEGMENTS)

  const centre = ((): readonly [number, number, number] => {
    const l = Math.hypot(DIR[0], DIR[1], DIR[2])
    return [DIR[0] / l, DIR[1] / l, DIR[2] / l] as const
  })()

  it('has the triangles its own formula promises, counted independently', () => {
    // One fan plus `rings - 1` quad bands, counted the long way rather than by
    // re-running the formula the code used (trap 24).
    let byHand = SEGMENTS
    for (let r = 1; r < RINGS; r++) byHand += 2 * SEGMENTS
    expect(cap.triangleCount).toBe(byHand)
    expect(cap.triangleCount).toBe(sunCapTriangles(RINGS, SEGMENTS))
    expect(cap.positions).toHaveLength(cap.triangleCount * 9)
    expect(cap.vertexCosines).toHaveLength(cap.triangleCount * 3)
  })

  it('is wound the way the dome is, and the dome is measured in the same test', () => {
    // The claim is not "counter-clockwise" — that is a convention, and writing
    // it here would be writing it twice. The claim is that the cap agrees with
    // the surface it is welded into, so `side: BackSide` shows both or neither.
    const dome = generateSkyDome(2, 7)
    for (let f = 0; f < dome.triangleCount; f++) {
      expect(outwardness(dome.positions, f), `dome face ${f}`).toBeGreaterThan(0)
    }
    for (let t = 0; t < cap.triangleCount; t++) {
      expect(outwardness(cap.positions, t), `cap triangle ${t}`).toBeGreaterThan(0)
    }
  })

  it('sits on the unit sphere, and reaches both ends of its own radius', () => {
    let minCos = 1
    let maxCos = -1
    for (let v = 0; v < cap.triangleCount * 3; v++) {
      const x = cap.positions[v * 3] as number
      const y = cap.positions[v * 3 + 1] as number
      const z = cap.positions[v * 3 + 2] as number
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6)
      // The stored cosine is the angle from the centre and nothing else — the
      // one place the cap's parameter could drift from its geometry, and the
      // colour is a function of the parameter.
      const measured = x * centre[0] + y * centre[1] + z * centre[2]
      expect(measured).toBeCloseTo(cap.vertexCosines[v] as number, 6)
      if (measured < minCos) minCos = measured
      if (measured > maxCos) maxCos = measured
    }
    // It covers the sun exactly: the apex is ON it, and the rim is AT the
    // radius asked for — not inside, which clips the falloff back into a
    // polygon, and not outside, which spends rings on nothing.
    expect(Math.acos(Math.min(1, maxCos))).toBeCloseTo(0, 6)
    // Relative, not absolute, and the tolerance is derived rather than tuned:
    // positions are `Float32Array`, so a cosine carries ~6e-8 of error, and
    // `acos` amplifies it by `1 / sin(OUTER)` — a factor of 31 at this radius.
    // An absolute `toBeCloseTo(OUTER, 9)` fails on that alone, which is a test
    // measuring float32 rather than measuring the cap.
    expect(Math.abs(Math.acos(minCos) / OUTER - 1)).toBeLessThan(1e-4)
  })

  it('tiles the cap once — no gap, no overlap, no folded wedge', () => {
    // Project every triangle onto the plane the cap faces and sum the SIGNED
    // areas. A tessellated disc projects to the inscribed polygon exactly, so
    // this one number carries "covers it", "covers it once" and "covers it all
    // the same way round" at the same time. Exhaustive where a spot check on
    // one wedge would have been a smoke test.
    const ax = Math.abs(centre[0])
    const ay = Math.abs(centre[1])
    const az = Math.abs(centre[2])
    const seed: readonly [number, number, number] =
      ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1]
    const raw = cross3(centre, seed)
    const rl = Math.hypot(raw[0], raw[1], raw[2])
    const u: readonly [number, number, number] = [raw[0] / rl, raw[1] / rl, raw[2] / rl]
    // (u, v, centre) right-handed, so a positive sum is the same handedness the
    // winding test measured.
    const v = cross3(centre, u)

    let signed = 0
    for (let t = 0; t < cap.triangleCount; t++) {
      const p = t * 9
      const px: number[] = []
      const py: number[] = []
      for (let k = 0; k < 3; k++) {
        const x = cap.positions[p + k * 3] as number
        const y = cap.positions[p + k * 3 + 1] as number
        const z = cap.positions[p + k * 3 + 2] as number
        px.push(x * u[0] + y * u[1] + z * u[2])
        py.push(x * v[0] + y * v[1] + z * v[2])
      }
      const x0 = px[0] as number
      const x1 = px[1] as number
      const x2 = px[2] as number
      const y0 = py[0] as number
      const y1 = py[1] as number
      const y2 = py[2] as number
      signed += 0.5 * (x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1))
    }
    // A regular n-gon inscribed in radius R has area `n/2 * R^2 * sin(2*pi/n)`.
    const radius = Math.sin(OUTER)
    const expected = (SEGMENTS / 2) * radius * radius * Math.sin((Math.PI * 2) / SEGMENTS)
    expect(signed / expected).toBeCloseTo(1, 6)
  })

  it('is the same cap wherever it is pointed, including across its own branch', () => {
    // The basis `generateSunCap` picks is seeded off whichever axis the centre
    // is LEAST aligned with, which is a branch — so directions either side of
    // it must still give the same cap, turned. Checked as a distribution
    // rather than vertex by vertex, because "turned" is what is allowed to
    // differ.
    const mine = Array.from(cap.vertexCosines, (c) => c.toFixed(6)).sort()
    for (const dir of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0.577, 0.577, 0.577],
      [-0.1, 0.99, 0.02],
    ] as const) {
      const other = generateSunCap(dir, OUTER, RINGS, SEGMENTS)
      expect(other.triangleCount).toBe(cap.triangleCount)
      expect(Array.from(other.vertexCosines, (c) => c.toFixed(6)).sort()).toEqual(mine)
      for (let t = 0; t < other.triangleCount; t++) {
        expect(outwardness(other.positions, t), `${dir.join()} triangle ${t}`).toBeGreaterThan(0)
      }
    }
  })
})
