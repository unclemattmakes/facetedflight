// src/game/props/cells.ts — the culling grid a scatter is split into.
//
// DEV-118. A leaf on purpose: `tests/e2e/props.spec.ts` imports the cell
// count, and an e2e spec may only reach a `src/` module that pulls in no
// `import.meta` (`tests/unit/e2e-import-graph.test.ts`). Pure arithmetic, no
// three, so `load-props.ts` and a unit test read the same function.
//
// ── Why the grid exists, and why it ships at ONE ────────────────────────
//
// `load-props.ts` used to build one `InstancedMesh` per palette entry with
// `frustumCulled = false`, because a single bounding sphere around a 4 km
// scatter is the whole island. On `int_01` that is 8 draws and 899 k
// triangles — half the world pass — drawn again in the shadow pass, from every
// angle. The obvious fix is a grid of cells, each its own mesh with a sphere
// three can cull. It was built, and then MEASURED on one frozen cockpit frame
// (`int_01_hoverJet`, `?snap=20`, 1280x720, `?propCells=`, GPU time from
// `boot/gpu-timer.ts`, two readings each):
//
//     cells   gpu median ms    frame calls / tris     props calls / tris
//     1x1     15.50 / 16.52    245 / 2.91 M           8 / 899 k
//     2x2     16.17 / 15.12    288 / 2.82 M          27 / 806 k
//     3x3     17.16 / 17.07    353 / 2.60 M          60 / 760 k
//     4x4     17.25 / 17.13    383 / 2.41 M          78 / 731 k
//
// From a seat INSIDE the island a 70-degree lens keeps most cells in view —
// a 1.4 km cell's sphere reaches 1 km past its edges — so the grid culls a
// sixth of the triangles and multiplies the draw calls by seven, and the GPU
// is slower, not faster. The triangles were never the cost; the state changes
// per draw are. So the grid ships at ONE cell: the old layout, but with a real
// bounding sphere instead of `frustumCulled = false`, so the whole scatter
// still culls when you look out to sea. The switch stays for the next
// measurement, and the real prop saving is LOD (`docs/private/PROP-AUDIT.md`
// §5), which is a different change. DEV-118 §3.

/**
 * Cells per axis the scatter is split into for culling. ONE — see above for
 * the table that put it there. `?propCells=<n>` overrides it for a measurement.
 */
export const PROP_CELLS_PER_AXIS = 1

export interface ScatterExtent {
  readonly minX: number
  readonly minZ: number
  readonly sizeX: number
  readonly sizeZ: number
}

/** The x/z box of every placement, in the bake's own (Unity) frame. */
export const scatterExtent = (positions: ArrayLike<number>, count: number): ScatterExtent => {
  let minX = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3] ?? 0
    const z = positions[i * 3 + 2] ?? 0
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  if (count === 0) return { minX: 0, minZ: 0, sizeX: 1, sizeZ: 1 }
  return { minX, minZ, sizeX: Math.max(maxX - minX, 1e-6), sizeZ: Math.max(maxZ - minZ, 1e-6) }
}

/**
 * Split placement indices into `perAxis`² cells over `extent`.
 *
 * Returns only the non-empty cells, each as the indices it holds, in cell
 * order. Pure and deterministic, so the same bake always gives the same cells
 * and the same instance order inside each — a frame drawn from these is the
 * frame drawn from one mesh, in a different draw order.
 */
export const cellIndices = (
  indices: readonly number[],
  positions: ArrayLike<number>,
  extent: ScatterExtent,
  perAxis: number = PROP_CELLS_PER_AXIS,
): number[][] => {
  const cells: number[][] = Array.from({ length: perAxis * perAxis }, () => [])
  for (const i of indices) {
    const u = ((positions[i * 3] ?? 0) - extent.minX) / extent.sizeX
    const v = ((positions[i * 3 + 2] ?? 0) - extent.minZ) / extent.sizeZ
    const cx = Math.min(perAxis - 1, Math.max(0, Math.floor(u * perAxis)))
    const cz = Math.min(perAxis - 1, Math.max(0, Math.floor(v * perAxis)))
    ;(cells[cz * perAxis + cx] as number[]).push(i)
  }
  return cells.filter((c) => c.length > 0)
}
