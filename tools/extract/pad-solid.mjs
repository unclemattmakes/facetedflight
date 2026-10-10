/**
 * tools/extract/pad-solid.mjs -- the surface a JumpSeat LANDS on, read off the
 * collider mesh. (DEV-120.)
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * `target_jumppad.prefab` carries exactly one live SOLID collider: a non-trigger,
 * non-convex `MeshCollider` on `jumpPad_04_collider` over
 * `Assets/Faceted Flight/Meshes/jumpPad_04_collider.fbx`, layer 0, which the
 * JumpSeat's `HoverMotor` mask (bit 0 set) hits and its four `Player`-tagged leg
 * capsules stand on. Every other collider in the prefab is a trigger, or hangs
 * under an inactive object (the `hexTile` towers and `Cylinder` struts of the
 * finale rig). So this one mesh IS the pad, and until DEV-120 the port had none
 * of it: the seat fell through every pad on all six missions.
 *
 * ── What the mesh is ──────────────────────────────────────────────────────
 *
 * 254 vertices, 187 polygons, and 8-fold symmetric about +y with its vertices
 * on the local ±x/±z axes and the diagonals (measured: the outer rim's eight
 * vertices sit at 0°, 45°, ... 315°). It is a stepped OCTAGONAL bowl -- three
 * flat tiers, the centre LOWEST, each step about 1.4 m tall at the shipped
 * scale, with a short lip on each step and an outer skirt down to an underside.
 * `docs/DEVIATIONS.md` DEV-120 has the measured numbers.
 *
 * ── Why a RADIAL PROFILE and not the triangles ────────────────────────────
 *
 * A mesh collider in the sim would mean a triangle soup in the level JSON and a
 * BVH in `src/sim/`. The shape does not need it: for a regular n-gon with a
 * vertex on +x, "how far out is this point" has a closed form (the n-gon norm,
 * `src/sim/pad-surface.ts`), and the top surface is then ONE function of that
 * radius. So this module casts a vertical ray through every polygon along the
 * local +x axis -- a vertex direction, where n-gon radius and Euclidean radius
 * coincide -- records the highest surface at each radius, and simplifies the
 * result to a polyline. Steps come out as two points at the same radius, which
 * is exactly a vertical wall.
 *
 * Measured against the mesh rather than believed: `resampleError` is the largest
 * disagreement between the simplified polyline and the dense scan, and the
 * extractor refuses a profile whose error exceeds `tolerance`.
 *
 * Reads the legacy project, never writes it.
 */

import { fbxMeshBounds, parseFbx } from './fbx-bounds.mjs'

/** How many radii the dense scan samples between the centre and the rim. */
const SCAN_SAMPLES = 4096

/**
 * Rotational symmetry the profile assumes. Checked, not assumed: `symmetryError`
 * casts the same rays along the first edge-midpoint direction, maps them
 * through the n-gon norm, and reports the worst height disagreement.
 */
const SYMMETRY = 8

const findAll = (nodes, name, out = []) => {
  for (const n of nodes) {
    if (n.name === name) out.push(n)
    findAll(n.children || [], name, out)
  }
  return out
}

/** Fan-triangulate the FBX polygon list. Returns index triples. */
const triangles = (polygonVertexIndex) => {
  const tris = []
  let poly = []
  for (const raw of polygonVertexIndex) {
    const last = raw < 0
    poly.push(last ? ~raw : raw)
    if (last) {
      for (let i = 1; i + 1 < poly.length; i++) tris.push([poly[0], poly[i], poly[i + 1]])
      poly = []
    }
  }
  return tris
}

/**
 * The highest point of the mesh's surface directly above/below `(x, z)`, in
 * mesh-local (import-scaled) units, or -Infinity where no polygon covers it.
 * Polygons with no footprint in xz (vertical walls) cannot be under a point.
 */
const topAt = (vertices, tris, x, z) => {
  let best = Number.NEGATIVE_INFINITY
  for (const [ia, ib, ic] of tris) {
    const a = vertices[ia]
    const b = vertices[ib]
    const c = vertices[ic]
    const det = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])
    if (Math.abs(det) < 1e-12) continue
    const l1 = ((b[0] - x) * (c[2] - z) - (c[0] - x) * (b[2] - z)) / det
    const l2 = ((c[0] - x) * (a[2] - z) - (a[0] - x) * (c[2] - z)) / det
    const l3 = 1 - l1 - l2
    const eps = -1e-9
    if (l1 < eps || l2 < eps || l3 < eps) continue
    const y = l1 * a[1] + l2 * b[1] + l3 * c[1]
    if (y > best) best = y
  }
  return best
}

/**
 * Greedy polyline simplification of a dense `(r, y)` scan. Keeps a sample when
 * the straight line from the last kept point to the next sample would miss any
 * intermediate sample by more than `tol`. A vertical step survives as two points
 * at (almost) the same radius, which is the wall.
 */
const simplify = (rs, ys, tol) => {
  const n = rs.length
  // Every sample strictly between a and b lies within `tol` of the chord a -> b?
  const chordCovers = (a, b) => {
    const r0 = rs[a]
    const y0 = ys[a]
    const r1 = rs[b]
    const y1 = ys[b]
    for (let k = a + 1; k < b; k++) {
      const t = r1 === r0 ? 0 : (rs[k] - r0) / (r1 - r0)
      if (Math.abs(y0 + (y1 - y0) * t - ys[k]) > tol) return false
    }
    return true
  }
  const out = [[rs[0], ys[0]]]
  let anchor = 0
  while (anchor < n - 1) {
    let j = anchor + 1
    while (j + 1 < n && chordCovers(anchor, j + 1)) j++
    out.push([rs[j], ys[j]])
    anchor = j
  }
  return out
}

/** Piecewise-linear read of a profile; a step (two equal radii) reads its higher point AT the step. */
export const profileHeightAt = (profile, r) => {
  if (r <= profile[0][0]) return profile[0][1]
  for (let i = 1; i < profile.length; i++) {
    const [r0, y0] = profile[i - 1]
    const [r1, y1] = profile[i]
    if (r > r1) continue
    if (r1 === r0) return Math.max(y0, y1)
    return y0 + ((y1 - y0) * (r - r0)) / (r1 - r0)
  }
  return Number.NEGATIVE_INFINITY
}

const profileCache = new Map()

/**
 * The top-surface radial profile of a rotationally symmetric collider mesh, in
 * mesh-local (import-scaled) units. `profile[i] = [radius, height]`, radius in
 * the n-gon norm (equal to Euclidean radius along a vertex direction), height
 * along +y. `outer` is the last radius that has any surface under it.
 *
 * `tolerance` is in the same local units.
 */
export function fbxRadialProfile(absFbxPath, tolerance = 1e-4) {
  const key = `${absFbxPath.replace(/\\/g, '/')}|${tolerance}`
  if (profileCache.has(key)) return profileCache.get(key)

  const bounds = fbxMeshBounds(absFbxPath)
  const { roots } = parseFbx(absFbxPath)
  const geometry = findAll(roots, 'Geometry').find((g) =>
    g.children.some((c) => c.name === 'Vertices'),
  )
  const pvi = geometry.children.find((c) => c.name === 'PolygonVertexIndex')
  if (!pvi) throw new Error(`pad-solid: ${absFbxPath} has no PolygonVertexIndex`)
  const tris = triangles(pvi.props[0])
  const vertices = bounds.vertices

  // The mesh's own footprint radius: the furthest vertex from the axis.
  let maxR = 0
  for (const v of vertices) maxR = Math.max(maxR, Math.hypot(v[0], v[2]))

  // Dense scan along +x (a vertex direction), a hair past the rim so the last
  // covered radius is found rather than assumed.
  const rs = []
  const ys = []
  let outer = 0
  for (let i = 0; i <= SCAN_SAMPLES; i++) {
    const r = (maxR * 1.001 * i) / SCAN_SAMPLES
    const y = topAt(vertices, tris, r, 0)
    if (!Number.isFinite(y)) {
      if (rs.length) break
      continue
    }
    rs.push(r)
    ys.push(y)
    outer = r
  }
  if (rs.length < 4) throw new Error(`pad-solid: ${absFbxPath} has no top surface along +x`)

  const profile = simplify(rs, ys, tolerance)

  let resampleError = 0
  for (let i = 0; i < rs.length; i++) {
    resampleError = Math.max(resampleError, Math.abs(profileHeightAt(profile, rs[i]) - ys[i]))
  }

  // Symmetry check: the same radii along the first EDGE-MIDPOINT direction,
  // where the n-gon norm says a point at Euclidean radius e sits at n-gon radius
  // e / cos(pi/n). Sampled coarsely; the walls are excluded by tolerance.
  const phi = Math.PI / SYMMETRY
  let symmetryError = 0
  for (let i = 0; i < rs.length; i += 16) {
    const rOct = rs[i]
    const e = rOct * Math.cos(phi)
    const y = topAt(vertices, tris, e * Math.cos(phi), e * Math.sin(phi))
    if (!Number.isFinite(y)) continue
    // Ignore samples within one scan step of a wall, where the two rays
    // legitimately straddle it.
    const yPrev = profileHeightAt(profile, rs[Math.max(0, i - 1)])
    const yNext = profileHeightAt(profile, rs[Math.min(rs.length - 1, i + 1)])
    if (Math.abs(yNext - yPrev) > tolerance * 10) continue
    symmetryError = Math.max(symmetryError, Math.abs(y - ys[i]))
  }

  const out = {
    symmetry: SYMMETRY,
    profile,
    outer,
    top: Math.max(...ys),
    bottom: bounds.min[1],
    resampleError,
    symmetryError,
    vertexCount: bounds.vertexCount,
    triangleCount: tris.length,
    importScale: bounds.importScale,
    meshLocalSize: bounds.size,
  }
  profileCache.set(key, out)
  return out
}
