// tests/unit/dressing-shapes.test.ts — the generated props and the bird.
//
// V9, DEV-089. What these guard is the three properties the LOOK depends on and
// that nothing else would notice going wrong:
//
//   1. **Seeded.** Same seed, same bytes. A generator that drifted would change
//      the world on every load and no test that looked at one load would care.
//   2. **Faceted.** Split per triangle, ONE normal per face, and the jitter
//      applied BEFORE the split — `sim/clouds.ts` names the failure (jitter after
//      the split moves each face's copy independently and the prop comes apart
//      into confetti), and counting DISTINCT positions is what catches it.
//   3. **One metre wide.** The whole class exists because a familiar size is a
//      ruler (ANNIVERSARY.md §1.1), and that only works if the number in the
//      preset is metres. `scaleMin: 1` has to mean a one-metre boulder.
//
// Plus the contract the renderer rests on: every variant of a kind shares a
// topology, because they are packed into one geometry and swapped per instance.

import { describe, expect, it } from 'vitest'
import {
  type BirdPlacement,
  birdAt,
  birdPose,
  type FlockPlacement,
  flockOmega,
  flockPeriod,
  generateBird,
} from '@/sim/props/generate-bird'
import {
  generatePropMesh,
  generatePropVariants,
  PROP_KINDS,
  PROP_SHAPES,
  type PropKind,
  type PropMesh,
} from '@/sim/props/generate-shapes'

/** Positions rounded hard enough that float noise cannot invent a distinct vertex. */
const distinctPositions = (mesh: PropMesh): number => {
  const seen = new Set<string>()
  for (let i = 0; i < mesh.positions.length; i += 3) {
    seen.add(
      `${(mesh.positions[i] as number).toFixed(6)},` +
        `${(mesh.positions[i + 1] as number).toFixed(6)},` +
        `${(mesh.positions[i + 2] as number).toFixed(6)}`,
    )
  }
  return seen.size
}

/** The shared-vertex count of an icosphere at `n` subdivisions: 10*4^n + 2. */
const icosphereVertices = (subdivisions: number): number => 10 * 4 ** subdivisions + 2

const extent = (mesh: PropMesh, axis: 0 | 1 | 2): { min: number; max: number } => {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let i = axis; i < mesh.positions.length; i += 3) {
    const v = mesh.positions[i] as number
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max }
}

describe('the generated props', () => {
  it('is deterministic in its seed alone', () => {
    for (const kind of PROP_KINDS) {
      const a = generatePropMesh(PROP_SHAPES[kind], 1234)
      const b = generatePropMesh(PROP_SHAPES[kind], 1234)
      const c = generatePropMesh(PROP_SHAPES[kind], 1235)
      expect(Array.from(a.positions), `${kind} repeats`).toEqual(Array.from(b.positions))
      expect(Array.from(a.shades), `${kind} shades repeat`).toEqual(Array.from(b.shades))
      // And a different seed is a different prop — otherwise "seeded" would be
      // true and useless, which is the shape of a guard that is a restatement.
      expect(Array.from(a.positions), `${kind} varies`).not.toEqual(Array.from(c.positions))
    }
  })

  it('is a SPLIT soup with one flat normal per face', () => {
    for (const kind of PROP_KINDS) {
      const mesh = generatePropMesh(PROP_SHAPES[kind], 77)
      expect(mesh.positions.length, `${kind} positions`).toBe(mesh.triangleCount * 9)
      expect(mesh.normals.length, `${kind} normals`).toBe(mesh.triangleCount * 9)
      expect(mesh.shades.length, `${kind} shades`).toBe(mesh.triangleCount * 3)

      for (let f = 0; f < mesh.triangleCount; f++) {
        const p = f * 9
        const ax = mesh.positions[p] as number
        const ay = mesh.positions[p + 1] as number
        const az = mesh.positions[p + 2] as number
        const bx = mesh.positions[p + 3] as number
        const by = mesh.positions[p + 4] as number
        const bz = mesh.positions[p + 5] as number
        const cx = mesh.positions[p + 6] as number
        const cy = mesh.positions[p + 7] as number
        const cz = mesh.positions[p + 8] as number
        const e1 = [bx - ax, by - ay, bz - az] as const
        const e2 = [cx - ax, cy - ay, cz - az] as const
        const n = [
          e1[1] * e2[2] - e1[2] * e2[1],
          e1[2] * e2[0] - e1[0] * e2[2],
          e1[0] * e2[1] - e1[1] * e2[0],
        ]
        const len = Math.hypot(n[0] as number, n[1] as number, n[2] as number)
        expect(len, `${kind} face ${f} is degenerate`).toBeGreaterThan(1e-9)
        // Every one of the three stored normals is the FACE's own, computed
        // here from the positions rather than read back from the generator.
        for (let k = 0; k < 3; k++) {
          for (let axis = 0; axis < 3; axis++) {
            expect(mesh.normals[p + k * 3 + axis] as number).toBeCloseTo(
              (n[axis] as number) / len,
              6,
            )
          }
          expect(mesh.shades[f * 3 + k] as number).toBe(mesh.shades[f * 3] as number)
        }
      }
    }
  })

  it('jitters the SHARED vertices, so the prop does not come apart', () => {
    // The property, stated as a count: a split soup whose jitter went in BEFORE
    // the split still has exactly the icosphere's vertex positions, each
    // repeated once per face that touches it. Jitter after the split and every
    // one of `triangleCount * 3` positions is distinct — and the prop is
    // confetti. `sim/clouds.ts` names this exact failure; this is its guard.
    for (const kind of PROP_KINDS) {
      const shape = PROP_SHAPES[kind]
      const mesh = generatePropMesh(shape, 4242)
      expect(shape.jitter, `${kind} is meant to be crunchy`).toBeGreaterThan(0)
      expect(distinctPositions(mesh), `${kind} distinct vertices`).toBe(
        icosphereVertices(shape.subdivisions),
      )
    }
  })

  it('is exactly one metre across, so `scaleMin` means metres', () => {
    for (const kind of PROP_KINDS) {
      for (const seed of [1, 2, 3, 99]) {
        const mesh = generatePropMesh(PROP_SHAPES[kind], seed)
        const x = extent(mesh, 0)
        const z = extent(mesh, 2)
        const widest = Math.max(x.max - x.min, z.max - z.min)
        expect(widest, `${kind}@${seed} widest horizontal extent`).toBeCloseTo(1, 6)
        expect(mesh.width, `${kind}@${seed} reported width`).toBeCloseTo(1, 6)
      }
    }
  })

  it('stands on the ground with its base buried by `sink`', () => {
    for (const kind of PROP_KINDS) {
      const shape = PROP_SHAPES[kind]
      const mesh = generatePropMesh(shape, 8)
      const y = extent(mesh, 1)
      const full = y.max - y.min
      // The lowest vertex sits `sink` of the FULL height below y = 0 — the
      // relationship, not a number copied from the implementation.
      expect(y.min, `${kind} buried depth`).toBeCloseTo(-shape.sink * full, 6)
      expect(mesh.height, `${kind} height above ground`).toBeCloseTo(y.max, 6)
      expect(mesh.buried, `${kind} reported burial`).toBeCloseTo(-y.min, 6)
      expect(mesh.height, `${kind} shows above ground at all`).toBeGreaterThan(0)
    }
  })

  it('gives each kind the aspect its class needs', () => {
    // A shrub that is not taller than it is wide is a rock, and at 80 m the
    // silhouette is the only thing the eye has to tell them apart.
    const shrub = generatePropMesh(PROP_SHAPES.shrub, 5)
    const rock = generatePropMesh(PROP_SHAPES.rock, 5)
    const boulder = generatePropMesh(PROP_SHAPES.boulder, 5)
    const full = (m: PropMesh) => {
      const y = extent(m, 1)
      return y.max - y.min
    }
    expect(full(shrub), 'a shrub is taller than it is wide').toBeGreaterThan(1)
    expect(full(rock), 'a rock is flatter than it is wide').toBeLessThan(1)
    expect(full(boulder), 'a boulder is roughly equidimensional').toBeGreaterThan(0.55)
    expect(full(boulder)).toBeLessThan(1)
  })

  it('generates variants that SHARE a topology — the renderer packs them as one', () => {
    for (const kind of PROP_KINDS as readonly PropKind[]) {
      const variants = generatePropVariants(kind, 4, 1000)
      expect(variants).toHaveLength(4)
      const first = variants[0] as PropMesh
      for (const [i, v] of variants.entries()) {
        expect(v.triangleCount, `${kind} variant ${i} triangle count`).toBe(first.triangleCount)
        expect(v.positions.length, `${kind} variant ${i} buffer length`).toBe(
          first.positions.length,
        )
      }
      // And they are genuinely different props, not four copies.
      for (let i = 1; i < variants.length; i++) {
        expect(
          Array.from((variants[i] as PropMesh).positions),
          `${kind} variant ${i} differs from 0`,
        ).not.toEqual(Array.from(first.positions))
      }
    }
  })
})

describe('the bird and the loop it flies', () => {
  it('is two triangles, one metre across, with flat normals', () => {
    const bird = generateBird()
    expect(bird.triangleCount).toBe(2)
    expect(bird.positions.length).toBe(18)
    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    for (let i = 0; i < bird.positions.length; i += 3) {
      const x = bird.positions[i] as number
      if (x < minX) minX = x
      if (x > maxX) maxX = x
    }
    expect(maxX - minX, 'wing tip to wing tip').toBeCloseTo(1, 6)
    expect(bird.span).toBe(1)
    for (let f = 0; f < bird.triangleCount; f++) {
      const p = f * 9
      for (let k = 1; k < 3; k++) {
        for (let axis = 0; axis < 3; axis++) {
          expect(bird.normals[p + k * 3 + axis] as number).toBeCloseTo(
            bird.normals[p + axis] as number,
            9,
          )
        }
      }
    }
  })

  const flock = (over: Partial<FlockPlacement> = {}): FlockPlacement => ({
    centre: [100, 200, 300],
    radiusX: 60,
    radiusZ: 48,
    heading: 0.7,
    tilt: 0.2,
    speed: 11,
    birds: [
      { phase: 0, spread: 0, rise: 0, size: 1, wingPhase: 0, color: [0, 0, 0] },
      { phase: 0.31, spread: 6, rise: -3, size: 1.1, wingPhase: 1.7, color: [0, 0, 0] },
    ],
    ...over,
  })

  it('is periodic — exactly, not nearly', () => {
    // The property that matters: a bird that drifts by a metre a lap has left
    // its flock by the end of a mission. `flockPeriod` is 2*pi/omega and the
    // angle is taken modulo a turn, so this is exact rather than close.
    const f = flock()
    const period = flockPeriod(f)
    expect(period).toBeGreaterThan(0)
    const a = birdAt(f, f.birds[0] as BirdPlacement, 3.25, birdPose())
    const b = birdAt(f, f.birds[0] as BirdPlacement, 3.25 + period, birdPose())
    const c = birdAt(f, f.birds[0] as BirdPlacement, 3.25 + period * 7, birdPose())
    for (const key of ['x', 'y', 'z', 'dx', 'dy', 'dz'] as const) {
      expect(b[key], `one lap on: ${key}`).toBeCloseTo(a[key], 6)
      expect(c[key], `seven laps on: ${key}`).toBeCloseTo(a[key], 5)
    }
    // Half a lap is NOT the same pose — otherwise "periodic" would be satisfied
    // by a bird that never moves.
    const half = birdAt(f, f.birds[0] as BirdPlacement, 3.25 + period / 2, birdPose())
    expect(Math.hypot(half.x - a.x, half.y - a.y, half.z - a.z)).toBeGreaterThan(50)
  })

  it('flies a loop of the radius it was given, around the centre it was given', () => {
    const f = flock({ tilt: 0, heading: 0 })
    const period = flockPeriod(f)
    const lead = f.birds[0] as BirdPlacement
    let minR = Number.POSITIVE_INFINITY
    let maxR = Number.NEGATIVE_INFINITY
    for (let i = 0; i < 64; i++) {
      const p = birdAt(f, lead, (i / 64) * period, birdPose())
      // The lead bird has zero spread and zero rise, so on an untilted loop it
      // stays exactly in the plane of the centre.
      expect(p.y, 'an untilted loop is level').toBeCloseTo(f.centre[1], 9)
      const r = Math.hypot(p.x - f.centre[0], p.z - f.centre[2])
      minR = Math.min(minR, r)
      maxR = Math.max(maxR, r)
    }
    // An ellipse: between its two semi-axes, touching both.
    expect(minR).toBeCloseTo(Math.min(f.radiusX, f.radiusZ), 1)
    expect(maxR).toBeCloseTo(Math.max(f.radiusX, f.radiusZ), 1)
  })

  it('turns at `speed / meanRadius`, so a wide flock is not a slow one', () => {
    // Two flocks, one twice the size, the same `speed`. If the angular rate were
    // the constant instead, the wide one would be flying at twice the speed —
    // which is the reading `flockPeriod`'s own doc comment rejects.
    const tight = flock({ radiusX: 30, radiusZ: 30, tilt: 0, heading: 0 })
    const wide = flock({ radiusX: 60, radiusZ: 60, tilt: 0, heading: 0 })
    const step = 0.01
    const speedOf = (f: FlockPlacement): number => {
      const a = birdAt(f, f.birds[0] as BirdPlacement, 1, birdPose())
      const b = birdAt(f, f.birds[0] as BirdPlacement, 1 + step, birdPose())
      return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / step
    }
    expect(speedOf(tight)).toBeCloseTo(11, 1)
    expect(speedOf(wide)).toBeCloseTo(11, 1)
    expect(flockPeriod(wide)).toBeCloseTo(flockPeriod(tight) * 2, 6)
    expect(flockOmega(wide)).toBeCloseTo(flockOmega(tight) / 2, 9)
  })

  it('points where it is going', () => {
    const f = flock()
    const period = flockPeriod(f)
    const lead = f.birds[0] as BirdPlacement
    const dt = 0.005
    for (const t of [0, period * 0.17, period * 0.51, period * 0.83]) {
      const a = birdAt(f, lead, t, birdPose())
      const b = birdAt(f, lead, t + dt, birdPose())
      const mx = (b.x - a.x) / dt
      const my = (b.y - a.y) / dt
      const mz = (b.z - a.z) / dt
      const len = Math.hypot(mx, my, mz)
      // The reported heading against the MEASURED one — a finite difference of
      // the position function, which is a different calculation from the
      // analytic tangent the function returns.
      expect(a.dx, `heading x at ${t}`).toBeCloseTo(mx / len, 2)
      expect(a.dy, `heading y at ${t}`).toBeCloseTo(my / len, 2)
      expect(a.dz, `heading z at ${t}`).toBeCloseTo(mz / len, 2)
      expect(Math.hypot(a.dx, a.dy, a.dz), 'unit').toBeCloseTo(1, 9)
    }
  })

  it('turns the other way when `speed` is negative', () => {
    // At t = 0 both birds are at the SAME point of the loop, which is the only
    // moment the two headings are comparable — a second later they are at
    // different angles and their tangents have nothing to do with each other.
    // Half the flocks fly the loop backwards, and this is what says so.
    const right = flock({ tilt: 0, heading: 0, speed: 11 })
    const left = flock({ tilt: 0, heading: 0, speed: -11 })
    const a = birdAt(right, right.birds[0] as BirdPlacement, 0, birdPose())
    const b = birdAt(left, left.birds[0] as BirdPlacement, 0, birdPose())
    expect(b.x).toBeCloseTo(a.x, 9)
    expect(b.z).toBeCloseTo(a.z, 9)
    expect(a.dx).toBeCloseTo(-b.dx, 6)
    expect(a.dz).toBeCloseTo(-b.dz, 6)
  })
})
