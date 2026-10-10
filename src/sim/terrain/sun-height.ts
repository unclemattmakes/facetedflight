// src/sim/terrain/sun-height.ts — the height below which the sun cannot reach.
//
// ── The problem this answers ──────────────────────────────────────────────
//
// Matt, 2026-09-15: *"my problem with the shadows is how they're different
// far vs near. an island that looks lit from far away is actually in shadow
// when inspected up close. it was hard in the original unity project to
// balance cockpit shadows with world shadows."*
//
// DEV-086's shadow map is one orthographic box, ±700 m around the camera
// (`render/shadows.ts`), and three's `getShadow` answers "lit" for every
// fragment outside it. So a far island is lit BY DEFINITION, and turns
// shadowed the moment you fly into the box — which is exactly the report.
// Unity's `shadowDistance` was the same shape with a smaller number (384), and
// the reason it was hard to balance there is that one map cannot hold both a
// cockpit's metres and an island's kilometres at once. That is not a tuning
// problem; it is a resolution budget with two customers.
//
// ── The answer: a SECOND term, exact at every distance, computed once ─────
//
// The mission sun never moves (`lighting.sun` is per mission, extracted), and
// the ground is a height field. So the question "is this point in the shadow
// of some terrain?" has a closed answer that needs no per-frame work at all:
// for every ground texel, record the height the sun ray has there after
// clearing everything up-sun of it — the SHADOW TOP. A point at (x, y, z) is
// in terrain shadow exactly when `y < top(x, z)`.
//
// That one field answers the question for everything: the terrain (its own
// height against the top), the sea (y ≈ 0 against a mountain's ray across the
// bay), the scattered props, the AI racers, and — the half Unity could never
// balance — the COCKPIT, whose fragments simply compare their world height to
// the top under them. The realtime map keeps doing what only it can do (a
// boulder's shadow on the ground, the ship's on the pad, the detail ring's own
// facets); `render/far-shadow.ts` takes the minimum of the two where both
// exist, and the baked term alone beyond the box. A far island and a near one
// are then shadowed by the same rule.
//
// ── The march: one exact ray per texel, over a maximum mipmap ─────────────
//
// `top(x, z) = max over t of terrain(p + t·u) − t·k`, the ray toward the sun
// with `k` the drop per grid unit. Marched naively that is 263 k rays × up to
// 512 samples on Simonet's 513-grid, and at 4° every ray runs off the map.
//
// Two cheaper shapes were tried first and both are wrong in ways a test found:
//
//   * A single sweep along the dominant axis, each texel's ray interpolated
//     from the two neighbours on the line just finished. The interpolation is
//     a blur applied ONCE PER STEP, so it compounds along the ray: p95 4.2 m,
//     worst 9.6 m at 15° on a smooth 150 m field — and int_01's sun is 4°,
//     where shadows are ten times longer.
//   * Parallel lines half a texel apart, marched exactly, with each sample's
//     shadow depth splatted onto the nearest texel. No compounding, but the
//     splat carries a depth measured up to a third of a texel sideways, and
//     beside a peak that is a lit texel reading 21 m of shadow.
//
// So this is the textbook exact traversal instead: a MAXIMUM MIPMAP over the
// height field's cells, and per texel a DDA up the sun ray that skips any cell
// whose maximum, at the ray's height on entry, could not beat the top found so
// far — descending a level when it could, and at level 0 taking the exact
// maximum of (bilinear terrain − ray), which is a quadratic along the segment.
// Nothing is interpolated but the terrain itself, exactly as the collision
// query interpolates it, so `sun-height.test.ts` can hold every interior texel
// to a fine ray march at seven azimuths to centimetres.
//
// ── DEV-027: what each number is OF ──────────────────────────────────────
//
// `tops` are world-y METRES in SIM space, `[z * vertPerSide + x]`, on the same
// grid and the same origin as the `HeightField` they were marched from — the
// COLLISION field, without the mesh's ±1.3 m jitter, which is why the render
// term is soft over a few metres rather than a step.
//
// SIM LAYER: no three, no DOM, no wall clock, no Math.random.

import { smoothstep } from '../math/scalar'
import { runSteps, type Steps } from '../steps'
import type { HeightField } from './height-field'

export interface SunHeightField {
  /** Samples per side. The height field's own. */
  readonly vertPerSide: number
  /**
   * World-y METRES, sim space, `[z * vertPerSide + x]`: a point at this texel
   * with `y < tops[i]` is in terrain shadow. Never below the terrain itself.
   */
  readonly tops: Float32Array
  /**
   * SIGNED metres, per texel: positive is how far the GROUND here sits below
   * its shadow top; negative is how far the sun ray, marched from one grid
   * step out, CLEARED the ground — a lit texel with margin. Zero is the edge.
   *
   * The render side judges a TERRAIN fragment by this rather than by its own
   * height (DEV-133). The mesh it draws carries ±`randomOffset` of vertex
   * jitter the field does not, and its coarse LODs cut 16 and 32 m facets
   * across 8 m relief; a lit texel's `top` IS the terrain, so a fragment
   * compared against it by height lands on either side of the edge at random
   * and lit ground averaged half-lit, per vertex, with noise. Signed rather
   * than clamped at 0 so the bilinear zero crossing falls INSIDE a texel: a
   * field that is exactly 0 on every lit texel has its edge on the grid.
   */
  readonly depths: Float32Array
  /** Metres per grid step. */
  readonly step: number
  readonly terrainSize: number
  readonly originX: number
  readonly originY: number
  readonly originZ: number
  readonly scaleX: number
  readonly scaleY: number
  readonly scaleZ: number
  /**
   * Unit vector TOWARD the sun, sim space: the sun the march was GIVEN,
   * normalised. What a consumer lighting by N·L reads (the sky-visibility
   * bounce). Equal to `marchedSun` except for a sun under the floor (DEV-527).
   */
  readonly towardSun: readonly [number, number, number]
  /**
   * Unit vector along which the rays were MARCHED, sim space. The given sun on
   * its own heading, lifted to `MIN_SUN_HEIGHT_SIN` when it sat between the
   * horizon and that floor (DEV-527: `int_02_hoverJet`, 0.083°); otherwise
   * `towardSun` exactly. What continues a ray past the field (`sunReachOf`).
   */
  readonly marchedSun: readonly [number, number, number]
  /** Deepest shadow anywhere — `max(top − terrain)`, metres. Diagnostic. */
  readonly maxDepth: number
  /** Range of `tops`, metres. What a texture encoder needs. */
  readonly minTop: number
  readonly maxTop: number
  /**
   * True when the sun was at or under the horizon, or dead overhead, and was
   * not marched; `tops` = terrain. A sun just above the horizon is marched at
   * the floor instead (DEV-527).
   */
  readonly degenerate: boolean
  /** Traversal steps taken, all rays. Diagnostic; the test bounds it. */
  readonly steps: number
}

/**
 * The smallest `sin(elevation)` the march runs at — 0.5°, the same floor
 * `render/shadows.ts` puts under its caster-span diagnostic.
 *
 * A sun BETWEEN the horizon and this floor is marched AT the floor, on its own
 * heading (DEV-527, Matt's option C of DEV-495). Only the march is lifted: the
 * field's `towardSun` stays the sun it was given, so nothing that lights by
 * N·L moves. A sun at or below the horizon, or dead overhead, still gets no
 * baked term (`degenerate`).
 *
 * ONE shipped mission is under it: `int_02_hoverJet`, whose extracted sun is
 * 0.083° above the horizon. Until DEV-527 that bought it no far field at all,
 * only the shadow map's box (DEV-453 found it, DEV-495 photographed it and
 * measured 0.5° and 0.083° as the same picture within pixel noise). 4.00° is
 * the NEXT lowest, the one sun every Simonet and Kauai mission shares.
 * `sun-floor-missions.test.ts` derives the list from the level JSON, so a
 * second mission under the floor turns it red instead of going unseen.
 *
 * The course editor's lowest sun (`SUN_ELEVATION_FLOOR`) is derived from this
 * and pinned at 0.5° by `player-course-light.test.ts`, so the editor offers no
 * sun the march would have to lift.
 */
export const MIN_SUN_HEIGHT_SIN = 0.0087265

/** Terrain height at a grid index, metres, sim space. */
const terrainAt = (field: HeightField, i: number): number =>
  field.originY + (field.heights[i] as number) * field.terrainHeight * (field.scaleY || 1)

/**
 * Maximum mipmap over the field's CELLS. Level 0 has (n−1)² cells, cell (i, j)
 * covering grid [i, i+1] × [j, j+1] with the max of its four corners — an upper
 * bound on the bilinear surface inside it. Each level above is the 2×2 max of
 * the one below; the top level is one cell.
 */
export const buildMaxMips = (field: HeightField): { levels: Float32Array[]; sizes: number[] } => {
  const n = field.vertPerSide
  const m0 = n - 1
  const levels: Float32Array[] = []
  const sizes: number[] = []
  const l0 = new Float32Array(m0 * m0)
  for (let j = 0; j < m0; j++) {
    for (let i = 0; i < m0; i++) {
      const a = terrainAt(field, j * n + i)
      const b = terrainAt(field, j * n + i + 1)
      const c = terrainAt(field, (j + 1) * n + i)
      const d = terrainAt(field, (j + 1) * n + i + 1)
      l0[j * m0 + i] = Math.max(a, b, c, d)
    }
  }
  levels.push(l0)
  sizes.push(m0)
  let size = m0
  while (size > 1) {
    const prev = levels[levels.length - 1] as Float32Array
    const next = Math.ceil(size / 2)
    const l = new Float32Array(next * next)
    for (let j = 0; j < next; j++) {
      for (let i = 0; i < next; i++) {
        const i0 = 2 * i
        const j0 = 2 * j
        const i1 = Math.min(i0 + 1, size - 1)
        const j1 = Math.min(j0 + 1, size - 1)
        l[j * next + i] = Math.max(
          prev[j0 * size + i0] as number,
          prev[j0 * size + i1] as number,
          prev[j1 * size + i0] as number,
          prev[j1 * size + i1] as number,
        )
      }
    }
    levels.push(l)
    sizes.push(next)
    size = next
  }
  return { levels, sizes }
}

/** Nudge past a cell boundary, in grid units. */
const EPS = 1e-6

/**
 * A horizontal ray component below this is roundoff from a sun on a grid axis
 * and is marched as exactly zero (DEV-496): six orders under the 1.7e-3 a
 * 0.1° heading produces, seven over the ~1e-16 an axis heading leaves.
 */
const AXIS_SNAP = 1e-9

/**
 * March the field. `towardSun` is a vector TOWARD the sun in SIM space — the
 * negation of `lighting.sun.direction` (which is where light TRAVELS, three
 * space), z-flipped. `render/far-shadow.ts` does that conversion in one place.
 */
export const buildSunHeight = (
  field: HeightField,
  towardSun: readonly [number, number, number],
): SunHeightField => runSteps(sunHeightSteps(field, towardSun))

/**
 * `buildSunHeight`, able to stop after every row of texels (DEV-355).
 *
 * The one body both paths run: `buildSunHeight` drains it in one go and
 * `boot/slice.ts` drains it a frame's budget at a time. A row is ~0.5 ms on
 * Simonet's 1025² grid, so a slice never overruns its budget by more than that.
 */
export function* sunHeightSteps(
  field: HeightField,
  towardSun: readonly [number, number, number],
): Steps<SunHeightField> {
  const n = field.vertPerSide
  const count = n * n
  const tops = new Float32Array(count)
  // Zero-filled, which is the right answer for every texel the march leaves
  // lit and for the whole degenerate field.
  const depths = new Float32Array(count)
  const len = Math.hypot(towardSun[0], towardSun[1], towardSun[2]) || 1
  const sx = towardSun[0] / len
  const sy = towardSun[1] / len
  const sz = towardSun[2] / len
  const scaleX = field.scaleX || 1
  const scaleZ = field.scaleZ || 1

  // Grid-space horizontal direction toward the sun. Grid axes are world axes
  // over the transform's scale, so a non-uniform scale bends the azimuth.
  let ux = sx / scaleX
  let uz = sz / scaleZ
  const horiz = Math.hypot(ux, uz)
  const overhead = horiz < 1e-9
  // DEV-527: a sun between the horizon and the floor is marched AT the floor,
  // on its own heading. Scaling x and z by one factor leaves `ux`/`uz` (the
  // heading) where they were; only the ray's rise per grid unit, `k`, changes.
  // Any other sun takes the `else` and marches its own components, untouched.
  let msx = sx
  let msy = sy
  let msz = sz
  if (!overhead && sy > 0 && sy < MIN_SUN_HEIGHT_SIN) {
    const c = Math.sqrt(1 - MIN_SUN_HEIGHT_SIN * MIN_SUN_HEIGHT_SIN) / Math.hypot(sx, sz)
    msx = sx * c
    msy = MIN_SUN_HEIGHT_SIN
    msz = sz * c
  }
  const degenerate = overhead || msy < MIN_SUN_HEIGHT_SIN

  const base = {
    vertPerSide: n,
    step: field.step,
    terrainSize: field.terrainSize,
    originX: field.originX,
    originY: field.originY,
    originZ: field.originZ,
    scaleX: field.scaleX,
    scaleY: field.scaleY,
    scaleZ: field.scaleZ,
    towardSun: [sx, sy, sz] as const,
    marchedSun: [msx, msy, msz] as const,
  }

  let minTop = Number.POSITIVE_INFINITY
  let maxTop = Number.NEGATIVE_INFINITY

  if (degenerate) {
    for (let i = 0; i < count; i++) {
      const h = terrainAt(field, i)
      tops[i] = h
      if (h < minTop) minTop = h
      if (h > maxTop) maxTop = h
    }
    return { ...base, tops, depths, maxDepth: 0, minTop, maxTop, degenerate: true, steps: 0 }
  }

  ux /= horiz
  uz /= horiz
  // A sun ON a grid axis arrives with its other component as trig roundoff —
  // `cos(90°)` is 6.1e-17, `sin(180°)` 1.2e-16 — which never moves `px` off
  // the grid line it starts on. Negative, the DDA below found no way out of the
  // cell behind that line; positive, none out of the far row. Either way it
  // crept at EPS a step to the guard: 4.9–5.2 s on int_01, and a truncated ray
  // (DEV-496). Make it the exact zero it means. The nearest heading a player
  // can pick off an axis is 0.1°, a component of 1.7e-3.
  if (Math.abs(ux) < AXIS_SNAP) ux = 0
  if (Math.abs(uz) < AXIS_SNAP) uz = 0
  // The ray rises `k` world metres per GRID UNIT of travel toward the sun:
  // tan(elevation) times the world metres one grid unit covers along the ray.
  const tanE = msy / Math.hypot(msx, msz)
  const k = tanE * field.step * Math.hypot(ux * scaleX, uz * scaleZ)

  const { levels, sizes } = buildMaxMips(field)
  const topLevel = levels.length - 1
  const m0 = n - 1
  const heights = field.heights
  const hScale = field.terrainHeight * (field.scaleY || 1)
  const hBase = field.originY

  let maxDepth = 0
  let steps = 0

  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i0 = z * n + x
      const h0 = terrainAt(field, i0)
      // UNCLAMPED, and not counting the texel's own height (DEV-133): so a lit
      // texel records how far the ray CLEARED the ground beyond itself, not
      // merely "lit". Started at the texel's own height the maximum could
      // never fall below it, every lit texel read exactly 0 depth, and the
      // bilinear zero crossing between a lit texel and a shaded neighbour
      // hugged the lit one — the shadow's edge on the ground stair-stepped
      // along the 8 m grid. With a signed clearance the crossing lands inside
      // the texel, at the first-order position of the true edge. The floor is
      // one terrain height below the ground: finite, so a ray that runs
      // straight off the map cannot put an infinity into a bilinear filter.
      // The march still starts AT the texel — starting a grid step out walks
      // the texel beside the border straight off the map and misses the
      // neighbour on the last grid line, which the oracle test caught at 93 m.
      let top = h0 - hScale
      let first = true
      let t = 0
      let level = topLevel
      // Start a hair up the ray so the DDA's cell is unambiguous on a corner.
      let px = x + ux * EPS
      let pz = z + uz * EPS
      for (let guard = 0; guard < 1_000_000; guard++) {
        if (px < 0 || pz < 0 || px > m0 || pz > m0) break
        steps++
        const size = 1 << level
        // Cell at this level, clamped so a point on the far edge stays inside.
        // A point ON a boundary belongs to the cell AHEAD of the ray: moving
        // negative that is the one below it, and `floor` picks the one behind,
        // whose exit is where the point already is — a zero-length step. Off a
        // boundary `ceil − 1` IS `floor`. An ordinary sun lands on one about
        // once a ray (the start's EPS nudge is not in `t`, so the first
        // crossing's EPS cancels it: 292,844 on int_01), and there the wasted
        // step cost nothing but itself, as the next exit is measured from `px`
        // — the bytes out are unchanged. An axis sun's roundoff made it repeat
        // for ever (DEV-496). At 0 moving negative there is no cell ahead: the
        // ray is leaving the map.
        let cx = ux < 0 ? Math.ceil(px / size) - 1 : Math.floor(px / size)
        let cz = uz < 0 ? Math.ceil(pz / size) - 1 : Math.floor(pz / size)
        if (cx < 0 || cz < 0) break
        const lsize = sizes[level] as number
        if (cx > lsize - 1) cx = lsize - 1
        if (cz > lsize - 1) cz = lsize - 1
        // Where the ray leaves this cell.
        const tx =
          ux > 0
            ? ((cx + 1) * size - px) / ux
            : ux < 0
              ? (cx * size - px) / ux
              : Number.POSITIVE_INFINITY
        const tz =
          uz > 0
            ? ((cz + 1) * size - pz) / uz
            : uz < 0
              ? (cz * size - pz) / uz
              : Number.POSITIVE_INFINITY
        const dt = Math.min(tx, tz)
        const cellMax = (levels[level] as Float32Array)[cz * lsize + cx] as number
        if (cellMax - k * t <= top) {
          // Nothing in here can raise the top: skip the whole cell.
          t += dt + EPS
          px = x + ux * t
          pz = z + uz * t
          if (level < topLevel) level++
          continue
        }
        if (level > 0) {
          level--
          continue
        }
        // Level 0: the exact maximum of (bilinear − ray) over this segment.
        // Fractions within the cell at the segment's start, and their rates.
        const fx0 = px - cx
        const fz0 = pz - cz
        const h00 = hBase + (heights[cz * n + cx] as number) * hScale
        const h10 = hBase + (heights[cz * n + cx + 1] as number) * hScale
        const h01 = hBase + (heights[(cz + 1) * n + cx] as number) * hScale
        const h11 = hBase + (heights[(cz + 1) * n + cx + 1] as number) * hScale
        const a = h10 - h00
        const b = h01 - h00
        const d = h11 - h10 - h01 + h00
        // v(τ) = C2 τ² + C1 τ + C0 − k(t + τ), τ in [0, dt]
        const c2 = d * ux * uz
        const c1 = a * ux + b * uz + d * (fx0 * uz + fz0 * ux) - k
        const c0 = h00 + a * fx0 + b * fz0 + d * fx0 * fz0 - k * t
        // The first segment starts ON the texel, and its own height is not an
        // obstacle: leave c0 out of that one so a lit texel's value is the
        // clearance beyond it (the supremum as τ→0 is c0 itself, never attained).
        let best = first ? Number.NEGATIVE_INFINITY : c0
        first = false
        const vEnd = c2 * dt * dt + c1 * dt + c0
        if (vEnd > best) best = vEnd
        if (c2 < 0) {
          const tv = -c1 / (2 * c2)
          if (tv > 0 && tv < dt) {
            const vv = c2 * tv * tv + c1 * tv + c0
            if (vv > best) best = vv
          }
        }
        if (best > top) top = best
        t += dt + EPS
        px = x + ux * t
        pz = z + uz * t
        if (level < topLevel) level++
      }
      // Signed: positive is depth in shadow, negative is clearance in the sun.
      depths[i0] = top - h0
      // The top itself is never below the terrain (the object path compares
      // heights against it and a lit texel's top IS the ground).
      if (top < h0) top = h0
      tops[i0] = top
      const depth = top - h0
      if (depth > maxDepth) maxDepth = depth
      if (top < minTop) minTop = top
      if (top > maxTop) maxTop = top
    }
    yield (z + 1) / n
  }

  return { ...base, tops, depths, maxDepth, minTop, maxTop, degenerate: false, steps }
}

const sampleTop = (sh: SunHeightField, ix: number, iz: number): number => {
  const n = sh.vertPerSide
  const cx = ix < 0 ? 0 : ix > n - 1 ? n - 1 : ix
  const cz = iz < 0 ? 0 : iz > n - 1 ? n - 1 : iz
  return sh.tops[cz * n + cx] as number
}

/** Is this world point off the marched field entirely? Mirrors `outsideField`. */
export const outsideSunHeight = (sh: SunHeightField, x: number, z: number): boolean => {
  const mx = (x - sh.originX) / (sh.scaleX || 1)
  const mz = (z - sh.originZ) / (sh.scaleZ || 1)
  return mx < 0 || mz < 0 || mx > sh.terrainSize || mz > sh.terrainSize
}

/**
 * The shadow top at a world point, SIM space, metres. Bilinear between grid
 * samples — the same mapping `terrainHeightAt` uses, so the two agree about
 * where a texel is.
 */
export const sunTopAt = (sh: SunHeightField, x: number, z: number): number => {
  const mx = (x - sh.originX) / (sh.scaleX || 1)
  const mz = (z - sh.originZ) / (sh.scaleZ || 1)
  const gx = mx / sh.step
  const gz = mz / sh.step
  const ix = Math.floor(gx)
  const iz = Math.floor(gz)
  const fx = gx - ix
  const fz = gz - iz
  const h00 = sampleTop(sh, ix, iz)
  const h10 = sampleTop(sh, ix + 1, iz)
  const h01 = sampleTop(sh, ix, iz + 1)
  const h11 = sampleTop(sh, ix + 1, iz + 1)
  const a = h00 + (h10 - h00) * fx
  const b = h01 + (h11 - h01) * fx
  return a + (b - a) * fz
}

// ── Past the field's edge (DEV-497) ───────────────────────────────────────
//
// The field covers the LAND terrain and nothing else, and until DEV-497 a
// point off it was lit by definition. On Simonet that is a 4.1 km square in
// a sea that runs to the horizon, and a 4-degree sun casts a 500 m peak's
// shadow 7 km: the islands' shadows ran east across the bay and stopped in a
// straight line at the field's edge. From the course editor's height it read
// as a darker square round the islands; from the seat, as the near map's box
// (render/shadows.ts) drawing shadows on the sea that the far term did not.
//
// Off the field there is nothing to cast: every environment's land IS its
// field (`load-terrain.ts` marches the land terrain), and the sea is not a
// caster. So the top at a point off the field is exactly the top where its
// ray toward the sun ENTERS the field, lowered by the ray's fall over the
// distance between them — the march's own recursion, continued with no
// terrain in it. A ray that never meets the field sees the sun.

/**
 * The ray toward the sun in the field's MESH metres, for continuing it past
 * the edge: the horizontal unit direction, and the world metres it falls per
 * mesh metre travelled. Null for a degenerate field (no march, nothing to
 * continue).
 */
export interface SunReach {
  readonly ux: number
  readonly uz: number
  readonly dropPerMetre: number
}

export const sunReachOf = (sh: SunHeightField): SunReach | null => {
  if (sh.degenerate) return null
  // The MARCHED sun (DEV-527), so a ray continued past the edge falls at the
  // rate the rays on the field did.
  const [sx, sy, sz] = sh.marchedSun
  const scaleX = sh.scaleX || 1
  const scaleZ = sh.scaleZ || 1
  // The march's own direction (`sunHeightSteps`): grid axes are world axes over
  // the transform's scale, and mesh metres are grid units times the step.
  const hx = sx / scaleX
  const hz = sz / scaleZ
  const horiz = Math.hypot(hx, hz)
  const flat = Math.hypot(sx, sz)
  if (horiz < 1e-9 || flat < 1e-9) return null
  const ux = hx / horiz
  const uz = hz / horiz
  return { ux, uz, dropPerMetre: (sy / flat) * Math.hypot(ux * scaleX, uz * scaleZ) }
}

/**
 * Where a MESH point's ray toward the sun meets the field `[0, size]²`, and
 * how far it travelled to get there (mesh metres; 0 for a point on the field),
 * or null when it never does. The shader's slab test, mirrored.
 */
export const sunEntryOf = (
  reach: SunReach,
  size: number,
  mx: number,
  mz: number,
): { mx: number; mz: number; t: number } | null => {
  let t0 = 0
  let t1 = Number.POSITIVE_INFINITY
  for (const [p, u] of [
    [mx, reach.ux],
    [mz, reach.uz],
  ] as const) {
    if (Math.abs(u) < 1e-9) {
      if (p < 0 || p > size) return null
      continue
    }
    const a = (0 - p) / u
    const b = (size - p) / u
    t0 = Math.max(t0, Math.min(a, b))
    t1 = Math.min(t1, Math.max(a, b))
  }
  if (t1 < t0) return null
  const clamp = (v: number): number => (v < 0 ? 0 : v > size ? size : v)
  return { mx: clamp(mx + reach.ux * t0), mz: clamp(mz + reach.uz * t0), t: t0 }
}

/**
 * The shadow top at ANY world point, sim space: `sunTopAt` on the field, the
 * entry point's top less the ray's fall off it, and null where the ray toward
 * the sun misses the field (lit).
 */
export const sunTopBeyond = (sh: SunHeightField, x: number, z: number): number | null => {
  if (!outsideSunHeight(sh, x, z)) return sunTopAt(sh, x, z)
  const reach = sunReachOf(sh)
  if (!reach) return null
  const mx = (x - sh.originX) / (sh.scaleX || 1)
  const mz = (z - sh.originZ) / (sh.scaleZ || 1)
  const entry = sunEntryOf(reach, sh.terrainSize, mx, mz)
  if (!entry) return null
  const top = sunTopAt(
    sh,
    sh.originX + entry.mx * (sh.scaleX || 1),
    sh.originZ + entry.mz * (sh.scaleZ || 1),
  )
  return top - entry.t * reach.dropPerMetre
}

/**
 * GLSL `smoothstep`, so the CPU and the shader agree about the edge. Lived
 * here until the scalar kit (code-reuse audit RC-4); the kit's body clamps
 * with a ternary where this one used `Math.min/max`, and the two return the
 * same bits for every input because the clamped value is squared.
 */
export { smoothstep } from '../math/scalar'

/**
 * How much of the sun a point at (x, y, z) sees, 0..1, SIM space.
 *
 * 1 outside the field entirely (nothing up-sun of a point off the map is
 * known), and a `smoothstep` over `softMetres` centred on the top — soft
 * because the render mesh carries ±1.3 m of jitter the collision field does
 * not, and a hard step would stair every shadow edge along the facets.
 */
/**
 * How much of the sun a point OFF the ground sees — the sea, a prop, a racer,
 * the cockpit. The sim mirror of the render term's object path (DEV-116,
 * DEV-133), bilinear like the GPU's sampler.
 *
 * One-sided, below the top: a point AT the swept top is fully lit and the fade
 * runs `softMetres` DOWN from it, so the edge sits where the field says it
 * does rather than straddling it. `liftMetres` lowers the edge further — the
 * render mesh a prop stands on carries `randomOffset` of jitter the field does
 * not, so a palm's foot on a lit texel can be under the field's own top by that
 * much and must still be lit (render/far-shadow.ts derives it; here it is a
 * number). Zero softness is a step.
 */
export const sunVisibilityAt = (
  sh: SunHeightField,
  x: number,
  y: number,
  z: number,
  softMetres: number,
  liftMetres = 0,
): number => {
  // DEV-497: off the field, the top the ray carries in from it.
  const top = sunTopBeyond(sh, x, z)
  if (top === null) return 1
  const edge = top - Math.max(liftMetres, 0)
  const soft = Math.max(softMetres, 0)
  if (soft === 0) return y < edge ? 0 : 1
  return smoothstep(edge - soft, edge, y)
}

/**
 * Bilinear `depths` at a world point, sim space: signed metres, positive in
 * shadow, negative in the sun. Crosses zero at the shadow's edge on the ground.
 */
export const sunDepthAt = (sh: SunHeightField, x: number, z: number): number => {
  const mx = (x - sh.originX) / (sh.scaleX || 1)
  const mz = (z - sh.originZ) / (sh.scaleZ || 1)
  const gx = mx / sh.step
  const gz = mz / sh.step
  const ix = Math.floor(gx)
  const iz = Math.floor(gz)
  const fx = gx - ix
  const fz = gz - iz
  const n = sh.vertPerSide
  const at = (cx: number, cz: number): number => {
    const kx = cx < 0 ? 0 : cx > n - 1 ? n - 1 : cx
    const kz = cz < 0 ? 0 : cz > n - 1 ? n - 1 : cz
    return sh.depths[kz * n + kx] as number
  }
  const a = at(ix, iz) + (at(ix + 1, iz) - at(ix, iz)) * fx
  const b = at(ix, iz + 1) + (at(ix + 1, iz + 1) - at(ix, iz + 1)) * fx
  return a + (b - a) * fz
}

/**
 * How much of the sun the GROUND at a world point sees — the render term's
 * terrain path (DEV-133). Judged by the texel's own signed depth, never by the
 * fragment's height: lit ground has depth at or below 0 and returns exactly 1,
 * whatever the drawn mesh's jitter or LOD did to its height. The fade runs
 * over the first `softMetres` of depth, which along flat ground under a sun at
 * elevation `e` is `softMetres / tan(e)` of penumbra at a shadow's tip.
 */
export const sunGroundVisibilityAt = (
  sh: SunHeightField,
  x: number,
  z: number,
  softMetres: number,
): number => {
  if (outsideSunHeight(sh, x, z)) return 1
  const d = sunDepthAt(sh, x, z)
  const soft = Math.max(softMetres, 0)
  if (soft === 0) return d > 0 ? 0 : 1
  return 1 - smoothstep(0, soft, d)
}

/**
 * The brute-force answer, for the test and for nothing else: march from the
 * point toward the sun in `stepMetres` steps and report whether any terrain
 * sample rises above the ray. O(steps) per call.
 */
export const shadowedByMarch = (
  field: HeightField,
  x: number,
  y: number,
  z: number,
  towardSun: readonly [number, number, number],
  stepMetres: number,
  heightAt: (field: HeightField, x: number, z: number) => number,
  outside: (field: HeightField, x: number, z: number) => boolean,
): boolean => {
  const len = Math.hypot(towardSun[0], towardSun[1], towardSun[2]) || 1
  const sx = towardSun[0] / len
  const sy = towardSun[1] / len
  const sz = towardSun[2] / len
  let px = x
  let py = y
  let pz = z
  for (let k = 0; k < 100_000; k++) {
    px += sx * stepMetres
    py += sy * stepMetres
    pz += sz * stepMetres
    if (outside(field, px, pz)) return false
    if (heightAt(field, px, pz) > py) return true
  }
  return false
}
