// src/sim/terrain/ocean-ring-layout.ts: where the sea's rings stand, and what a
// ring vertex is. The TypeScript twin of the GLSL in `render/ocean-rings.ts`.
//
// DEV-339. A geometry clipmap (Losasso & Hoppe 2004): concentric square windows
// around the eye, each level's cell twice the one inside it. Every window is a
// FULL n x n grid of cells that is drawn whole; a cell that lies inside the next
// finer window is collapsed to a point in the vertex shader (a hole is a
// decision per cell, so all six of its vertices agree and no triangle is half
// there). Nothing in the mesh ever changes: the eye moves and a few uniforms do.
//
// Lattice indices are the baked lattice's (`ocean-ring-lattice.ts`): integer
// steps along the plate's MESH x and MESH z. The three-space z is the negation
// of mesh z, and the baked texels already carry it.
//
// SIM LAYER: pure.

/** A level's window in its own lattice indices: min corner, `cells` per side. */
export interface RingLevelFrame {
  readonly wx: number
  readonly wz: number
  /** The next finer window as a hole in THIS level's cells, or null (finest). */
  readonly hole: {
    readonly x0: number
    readonly z0: number
    readonly x1: number
    readonly z1: number
  } | null
}

/**
 * The window origin along one axis for an eye at lattice position `eye` (a
 * fraction of a step): centred, then snapped to an EVEN index, which is the
 * next coarser level's cell. Even is the whole of what keeps the finer window
 * on the coarser lattice, so its hole lines up with whole coarse cells and its
 * perimeter vertices (all even) land on coarse vertices or their midpoints.
 */
export const ringWindowOrigin = (eye: number, cells: number): number =>
  2 * Math.floor((eye - cells / 2) / 2)

/**
 * The frame of every level for an eye at MESH (x, z). `steps[k]` is level k's
 * lattice step in mesh units.
 */
export const ringFrame = (
  eyeMeshX: number,
  eyeMeshZ: number,
  steps: readonly number[],
  cells: number,
): RingLevelFrame[] => {
  const frames: RingLevelFrame[] = []
  for (let k = 0; k < steps.length; k++) {
    const step = steps[k] as number
    const wx = ringWindowOrigin(eyeMeshX / step, cells)
    const wz = ringWindowOrigin(eyeMeshZ / step, cells)
    let hole: RingLevelFrame['hole'] = null
    if (k > 0) {
      const fine = frames[k - 1] as RingLevelFrame
      const x0 = fine.wx / 2
      const z0 = fine.wz / 2
      hole = { x0, z0, x1: x0 + cells / 2, z1: z0 + cells / 2 }
    }
    frames.push({ wx, wz, hole })
  }
  return frames
}

/** Is the cell with min corner (gx, gz) inside this level's hole? */
export const ringCellInHole = (frame: RingLevelFrame, gx: number, gz: number): boolean => {
  const h = frame.hole
  return h !== null && gx >= h.x0 && gx < h.x1 && gz >= h.z0 && gz < h.z1
}

/**
 * Corner offsets (du, dv) along mesh (x, z) for the six vertices of a cell, in
 * the order the vertex layout emits them, CCW seen from above in THREE space
 * (where z is negated; `ocean-rings.test.ts` measures the normal, it does not
 * trust this sentence).
 *
 * `diag` is the plate's `topLeftToBottomRight`: the 0-1-2 / 2-1-3 split, whose
 * shared edge runs from (x0, z1) to (x1, z0). Corner 0 = (0,0), 1 = (0,1),
 * 2 = (1,0), 3 = (1,1).
 */
export const RING_CELL_CORNERS_DIAG: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 0],
  [1, 1],
  [0, 1],
]
/** The other split, 0-1-3 / 0-3-2: the edge runs (x0, z0) to (x1, z1). */
export const RING_CELL_CORNERS_ANTI: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 1],
  [0, 1],
  [0, 0],
  [1, 0],
  [1, 1],
]

export const ringCellCorner = (diag: boolean, slot: number): readonly [number, number] =>
  (diag ? RING_CELL_CORNERS_DIAG : RING_CELL_CORNERS_ANTI)[slot] as readonly [number, number]

/**
 * A perimeter vertex's coarse neighbours: the fine lattice index (gx, gz) sits
 * on the coarse lattice (halved) when both are even, and half way between two
 * coarse points when one is odd. Returns the two coarse indices (equal when the
 * vertex coincides with one).
 */
export const ringCoarseNeighbours = (
  gx: number,
  gz: number,
): readonly [readonly [number, number], readonly [number, number]] => {
  const bx = Math.floor(gx / 2)
  const bz = Math.floor(gz / 2)
  return [
    [bx, bz],
    [bx + (gx & 1), bz + (gz & 1)],
  ]
}

/** Is window-relative vertex (a, b) on the window's outer edge? */
export const ringOnPerimeter = (a: number, b: number, cells: number): boolean =>
  a === 0 || b === 0 || a === cells || b === cells
