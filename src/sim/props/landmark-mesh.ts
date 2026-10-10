// src/sim/props/landmark-mesh.ts — a landmark collides on its ROCK. DEV-345.
//
// DEV-213 made a landmark's collider the convex hull of its mesh, because 2016
// collided on the mesh and the hull was the tightest convex thing a hot loop
// could afford. **A hull is not the rock where the rock is concave**, and a
// JumpSeat pad stands in exactly that place: Simonet's sea stack
// (`Spire_B_w_Collision`) has a shoulder, `int_01_jumpSeat`'s pad 5 is built on
// it, and the hull wraps from the tall part of the stack out over the pad. The
// bullseye is 5.3 m clear of the rock and 22.4 m inside the hull, so neither a
// player nor the autopilot can land there — the seat is held off by stone that
// is not there.
//
// 2016's `MeshCollider` on that prefab is `m_Convex: 0`: the exact triangles.
// This module is that, for the few colliders that carry one. The hull stays in
// front of it as the broad phase — a sphere outside the hull is outside the
// rock by construction — so a ship pays for triangles only when it is already
// inside a rock's convex envelope, which on every authored line is a few
// hundred metres of a whole campaign.
//
// ── The two questions, and why each has its own structure ─────────────────
//
// A sphere touches the rock when its centre is within `radius` of the surface
// OR is inside the solid. Those are different questions:
//
//   near   the distance to the nearest triangle. Only triangles within
//          `radius` can matter, and each is binned by its x/z box into a
//          horizontal grid, so the sphere reads the one to four columns under
//          it and rejects the rest on their y span.
//   inside a winding count on the vertical ray upward: every triangle above
//          the point whose x/z projection contains it adds the sign of its
//          outward normal's y. Leaving a closed surface upward is +1, entering
//          it is −1, so inside is 1 and outside is 0. The ray is vertical so
//          that the SAME column the distance used holds every triangle it can
//          cross.
//
// The inside test is the one that matters for a fast ship. A sphere of 0.5 m
// moving 1.2 m a tick can step clean over a 1 m shell of "within radius", and a
// distance-only test then reports nothing while the centre sits in stone. PhysX
// has the same hole for a non-convex mesh and 2016 lived with it; this does not
// have to.
//
// ── Shared edges ──────────────────────────────────────────────────────────
//
// A point on the projection of an edge two triangles share must be counted by
// exactly one of them, or the winding goes to 2 or 0 on a seam and a column of
// air turns solid. Each projected triangle is put in counter-clockwise order and
// an edge on the boundary is OWNED by the triangle that traverses it with
// `dz < 0`, or `dz == 0 && dx > 0` — the rasteriser's top-left rule. Two
// neighbours in one sheet traverse their shared edge in opposite directions, so
// exactly one owns it. At a silhouette (an up-facing and a down-facing
// triangle folding over one edge) both lie on the same side of it and traverse
// it the same way, so their +1 and −1 arrive together or not at all.
//
// SIM LAYER: pure. No three, no DOM, no clock. The literals are geometry — the
// 1e-12 that stops a zero-area projection dividing, the nine floats of a
// triangle — and one cost, {@link LANDMARK_COLUMN_METRES}, justified where it
// is declared: no answer depends on it.

/**
 * The width of one x/z column, metres. **A cost, not a tuning** — hard rule 3
 * asks for the justification, and it is that no answer depends on it: the
 * distance is exact within reach at any width and the winding reads a whole
 * column at any width. Only how many triangles a query reads moves.
 *
 * Measured on all 17 live landmarks, five hull spheres a tick, node on the dev
 * box: at 8 m a ship in the hull's slack pays 1.0–2.5 µs and a ship touching
 * rock 3.6–8.8 µs (the hull's own planes cost 1.4–1.7). The mesh's own mean
 * triangle width — the obvious thing to derive it from — is 20–30 m on these
 * rocks and measured 2.5–9.4 / 10–28 µs, because a tall rock stacks its
 * triangles in a wide column. 7k–22k entries a landmark at 8 m.
 */
export const LANDMARK_COLUMN_METRES = 8

/** A landmark's triangles in SIM space, binned for the two queries above. */
export interface LandmarkMesh {
  /** Triangle count. */
  readonly count: number
  /** `count * 9` floats, SIM world space: ax ay az bx by bz cx cy cz. */
  readonly tris: Float32Array
  /** `count * 2` floats: each triangle's y span, lowest then highest. */
  readonly ySpan: Float32Array
  /** Per triangle: the sign of the OUTWARD normal's y — +1, −1, or 0 for a vertical wall. */
  readonly up: Int8Array
  readonly minX: number
  readonly minZ: number
  /** The mesh's lowest and highest y, for {@link meshSignedDistance}'s bound. */
  readonly minY: number
  readonly maxY: number
  readonly cellMetres: number
  readonly cols: number
  readonly rows: number
  /** CSR offsets into `cellTris`, `cols * rows + 1` of them. */
  readonly cellStart: Uint32Array
  readonly cellTris: Uint32Array
  /**
   * The mesh's own box diagonal: no point inside the mesh is further than this
   * from its surface, so it bounds {@link meshPenetration}'s widening search.
   */
  readonly diagonal: number
}

/**
 * Bin a closed triangle mesh for {@link meshPenetration}.
 *
 * `tris` is SIM space and already includes the terrain origin. Winding is
 * DISCOVERED, not assumed: the THREE → SIM mirror reverses every triangle, so
 * whether the file's winding faces out depends on how many mirrors it has been
 * through, and the signed volume answers that once for the whole mesh.
 */
export const buildLandmarkMesh = (
  tris: Float32Array,
  cellMetres: number = LANDMARK_COLUMN_METRES,
): LandmarkMesh => {
  const count = Math.floor(tris.length / 9)
  const ySpan = new Float32Array(count * 2)
  const up = new Int8Array(count)
  let minX = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let volume = 0
  for (let i = 0; i < count; i++) {
    const o = i * 9
    const ax = tris[o] as number
    const ay = tris[o + 1] as number
    const az = tris[o + 2] as number
    const bx = tris[o + 3] as number
    const by = tris[o + 4] as number
    const bz = tris[o + 5] as number
    const cx = tris[o + 6] as number
    const cy = tris[o + 7] as number
    const cz = tris[o + 8] as number
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
    // y of (b - a) x (c - a).
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
    up[i] = ny > 0 ? 1 : ny < 0 ? -1 : 0
    ySpan[i * 2] = Math.min(ay, by, cy)
    ySpan[i * 2 + 1] = Math.max(ay, by, cy)
    minY = Math.min(minY, ay, by, cy)
    maxY = Math.max(maxY, ay, by, cy)
    minX = Math.min(minX, ax, bx, cx)
    maxX = Math.max(maxX, ax, bx, cx)
    minZ = Math.min(minZ, az, bz, cz)
    maxZ = Math.max(maxZ, az, bz, cz)
  }
  // Inward winding: every normal flips, and so does every `up`.
  if (volume < 0) for (let i = 0; i < count; i++) up[i] = -(up[i] as number)

  const cols = Math.max(1, Math.ceil((maxX - minX) / cellMetres))
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / cellMetres))
  const cellOf = (v: number, lo: number, n: number): number =>
    Math.min(n - 1, Math.max(0, Math.floor((v - lo) / cellMetres)))
  // Two passes, count then fill: CSR, so a column is one contiguous run.
  const cellStart = new Uint32Array(cols * rows + 1)
  const span = (i: number): [number, number, number, number] => {
    const o = i * 9
    const x0 = Math.min(tris[o] as number, tris[o + 3] as number, tris[o + 6] as number)
    const x1 = Math.max(tris[o] as number, tris[o + 3] as number, tris[o + 6] as number)
    const z0 = Math.min(tris[o + 2] as number, tris[o + 5] as number, tris[o + 8] as number)
    const z1 = Math.max(tris[o + 2] as number, tris[o + 5] as number, tris[o + 8] as number)
    return [
      cellOf(x0, minX, cols),
      cellOf(x1, minX, cols),
      cellOf(z0, minZ, rows),
      cellOf(z1, minZ, rows),
    ]
  }
  for (let i = 0; i < count; i++) {
    const [c0, c1, r0, r1] = span(i)
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = r * cols + c + 1
        cellStart[k] = (cellStart[k] as number) + 1
      }
    }
  }
  for (let k = 1; k < cellStart.length; k++) {
    cellStart[k] = (cellStart[k] as number) + (cellStart[k - 1] as number)
  }
  const cellTris = new Uint32Array(cellStart[cellStart.length - 1] as number)
  const fill = cellStart.slice(0, cols * rows)
  for (let i = 0; i < count; i++) {
    const [c0, c1, r0, r1] = span(i)
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = r * cols + c
        cellTris[fill[k] as number] = i
        fill[k] = (fill[k] as number) + 1
      }
    }
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ)
  return {
    count,
    tris,
    ySpan,
    up,
    minX,
    minZ,
    minY,
    maxY,
    cellMetres,
    cols,
    rows,
    cellStart,
    cellTris,
    diagonal,
  }
}

/** Squared distance from `p` to triangle `i`. Ericson, *Real-Time Collision Detection* §5.1.5. */
const distanceSqToTriangle = (
  t: Float32Array,
  i: number,
  px: number,
  py: number,
  pz: number,
): number => {
  const o = i * 9
  const ax = t[o] as number
  const ay = t[o + 1] as number
  const az = t[o + 2] as number
  const abx = (t[o + 3] as number) - ax
  const aby = (t[o + 4] as number) - ay
  const abz = (t[o + 5] as number) - az
  const acx = (t[o + 6] as number) - ax
  const acy = (t[o + 7] as number) - ay
  const acz = (t[o + 8] as number) - az
  const apx = px - ax
  const apy = py - ay
  const apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  // The closest point as a + v*ab + w*ac; each region below sets (v, w).
  let v = 0
  let w = 0
  if (d1 <= 0 && d2 <= 0) {
    // vertex a
  } else {
    const d3 = d1 - (abx * abx + aby * aby + abz * abz)
    const d4 = d2 - (abx * acx + aby * acy + abz * acz)
    if (d3 >= 0 && d4 <= d3) {
      v = 1
    } else {
      const d5 = d1 - (abx * acx + aby * acy + abz * acz)
      const d6 = d2 - (acx * acx + acy * acy + acz * acz)
      if (d6 >= 0 && d5 <= d6) {
        w = 1
      } else {
        const vc = d1 * d4 - d3 * d2
        const vb = d5 * d2 - d1 * d6
        const va = d3 * d6 - d5 * d4
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
          v = d1 / (d1 - d3)
        } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
          w = d2 / (d2 - d6)
        } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
          w = (d4 - d3) / (d4 - d3 + (d5 - d6))
          v = 1 - w
        } else {
          const denom = 1 / (va + vb + vc)
          v = vb * denom
          w = vc * denom
        }
      }
    }
  }
  const dx = apx - abx * v - acx * w
  const dy = apy - aby * v - acy * w
  const dz = apz - abz * v - acz * w
  return dx * dx + dy * dy + dz * dz
}

/** The top-left rule: a CCW triangle owns the boundary edges it walks with `dz < 0`. */
const ownsEdge = (dx: number, dz: number): boolean => dz < 0 || (dz === 0 && dx > 0)

/**
 * Does the upward vertical ray from `p` cross triangle `i`, and which way?
 * Returns the triangle's `up` when it does and 0 when it does not. See the
 * header for the ownership rule on a shared edge.
 */
const crossingAbove = (m: LandmarkMesh, i: number, px: number, py: number, pz: number): number => {
  const s = m.up[i] as number
  if (s === 0 || (m.ySpan[i * 2 + 1] as number) <= py) return 0
  const t = m.tris
  const o = i * 9
  let x0 = t[o] as number
  let z0 = t[o + 2] as number
  let y0 = t[o + 1] as number
  let x1 = t[o + 3] as number
  let z1 = t[o + 5] as number
  let y1 = t[o + 4] as number
  const x2 = t[o + 6] as number
  const z2 = t[o + 8] as number
  const y2 = t[o + 7] as number
  let area = (x1 - x0) * (z2 - z0) - (z1 - z0) * (x2 - x0)
  if (Math.abs(area) < 1e-12) return 0
  if (area < 0) {
    // Counter-clockwise in (x, z), so the ownership rule reads one way.
    const tx = x0
    const tz = z0
    const ty = y0
    x0 = x1
    z0 = z1
    y0 = y1
    x1 = tx
    z1 = tz
    y1 = ty
    area = -area
  }
  // Edge functions: positive strictly inside a CCW triangle.
  const e0 = (x1 - x0) * (pz - z0) - (z1 - z0) * (px - x0)
  if (e0 < 0 || (e0 === 0 && !ownsEdge(x1 - x0, z1 - z0))) return 0
  const e1 = (x2 - x1) * (pz - z1) - (z2 - z1) * (px - x1)
  if (e1 < 0 || (e1 === 0 && !ownsEdge(x2 - x1, z2 - z1))) return 0
  const e2 = (x0 - x2) * (pz - z2) - (z0 - z2) * (px - x2)
  if (e2 < 0 || (e2 === 0 && !ownsEdge(x0 - x2, z0 - z2))) return 0
  // Barycentric height of the plane at (px, pz): e1 weights vertex 0, e2 vertex 1.
  const y = (e1 * y0 + e2 * y1 + e0 * y2) / area
  return y > py ? s : 0
}

/** Is `p` inside the closed mesh? The winding count on the upward ray. */
export const insideLandmarkMesh = (
  m: LandmarkMesh,
  px: number,
  py: number,
  pz: number,
): boolean => {
  const c = Math.floor((px - m.minX) / m.cellMetres)
  const r = Math.floor((pz - m.minZ) / m.cellMetres)
  if (c < 0 || r < 0 || c >= m.cols || r >= m.rows) return false
  const k = r * m.cols + c
  let winding = 0
  for (let j = m.cellStart[k] as number; j < (m.cellStart[k + 1] as number); j++) {
    winding += crossingAbove(m, m.cellTris[j] as number, px, py, pz)
  }
  return winding > 0
}

/**
 * The nearest triangle's squared distance, if one lies within `reach` of `p`;
 * otherwise `reach * reach` and nothing closer. Exact inside `reach`: a
 * triangle that close has an x/z box overlapping `p ± reach` and a y span
 * within `reach`, so it is in a column this walks and survives the reject.
 */
const nearestWithin = (
  m: LandmarkMesh,
  px: number,
  py: number,
  pz: number,
  reach: number,
): number => {
  const c0 = Math.max(0, Math.floor((px - reach - m.minX) / m.cellMetres))
  const c1 = Math.min(m.cols - 1, Math.floor((px + reach - m.minX) / m.cellMetres))
  const r0 = Math.max(0, Math.floor((pz - reach - m.minZ) / m.cellMetres))
  const r1 = Math.min(m.rows - 1, Math.floor((pz + reach - m.minZ) / m.cellMetres))
  let best = reach * reach
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const k = r * m.cols + c
      for (let j = m.cellStart[k] as number; j < (m.cellStart[k + 1] as number); j++) {
        const i = m.cellTris[j] as number
        if ((m.ySpan[i * 2] as number) > py + reach) continue
        if ((m.ySpan[i * 2 + 1] as number) < py - reach) continue
        const d = distanceSqToTriangle(m.tris, i, px, py, pz)
        if (d < best) best = d
      }
    }
  }
  return best
}

/**
 * How deep a sphere at `p` of `radius` is in the rock: <= 0 is clear, and a
 * positive number is what `stepPropCollision` pushes out by.
 *
 * `radius - distance` outside the solid, `radius + distance` inside it. Outside,
 * only a surface within `radius` can matter, so that is all it reads. Inside,
 * the depth is the TRUE distance to the surface however far that is: the reach
 * doubles, a cell at a time, until a triangle answers — a centre that deep in
 * stone has already tunnelled, and the answer has to be how far it is from
 * getting out rather than a guess at it.
 */
export const meshPenetration = (
  m: LandmarkMesh,
  px: number,
  py: number,
  pz: number,
  radius: number,
): number => {
  const inside = insideLandmarkMesh(m, px, py, pz)
  let reach = radius
  let best = nearestWithin(m, px, py, pz, reach)
  if (!inside) return best < reach * reach ? radius - Math.sqrt(best) : 0
  while (best >= reach * reach && reach < m.diagonal) {
    reach = Math.max(m.cellMetres, reach * 2)
    best = nearestWithin(m, px, py, pz, reach)
  }
  return radius + Math.sqrt(best)
}

/**
 * Signed distance from `p` to the rock, negative inside — UNBOUNDED, so it
 * answers for a point hundreds of metres off as well as one against the face.
 *
 * Not the per-tick path: {@link meshPenetration} reads only what a sphere can
 * touch. This widens until a triangle answers, which is what a measurement
 * ("how far is this pad from the rock?") wants and a hot loop does not.
 */
export const meshSignedDistance = (m: LandmarkMesh, px: number, py: number, pz: number): number => {
  // Nothing on the mesh is further than the diagonal from any point of its box,
  // so a point `outside` the box by some distance finds a triangle by then.
  const outside = Math.hypot(
    Math.max(0, m.minX - px, px - (m.minX + m.cols * m.cellMetres)),
    Math.max(0, m.minY - py, py - m.maxY),
    Math.max(0, m.minZ - pz, pz - (m.minZ + m.rows * m.cellMetres)),
  )
  const bound = outside + m.diagonal + m.cellMetres
  let reach = m.cellMetres
  let best = nearestWithin(m, px, py, pz, reach)
  while (best >= reach * reach && reach < bound) {
    reach *= 2
    best = nearestWithin(m, px, py, pz, reach)
  }
  const d = Math.sqrt(best)
  return insideLandmarkMesh(m, px, py, pz) ? -d : d
}
