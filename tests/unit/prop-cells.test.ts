/**
 * tests/unit/prop-cells.test.ts — the culling grid keeps every instance,
 * exactly once, in a cell whose ground it stands on.
 *
 * DEV-118. The property that makes the split pixel-identical is that it is a
 * PARTITION: the same indices come out that went in, each in one cell, and a
 * cell only holds placements inside its own square of the extent.
 */
import { describe, expect, it } from 'vitest'
import { cellIndices, PROP_CELLS_PER_AXIS, scatterExtent } from '../../src/game/props/cells'

/**
 * The grid these tests exercise. Three, so a split actually happens: the
 * SHIPPED value is one — measured slower at three, `cells.ts` has the table —
 * and the last test pins that.
 */
const GRID = 3

/** A deterministic scatter over a 4096 m square with a hole in the middle. */
const scatter = (n: number): { positions: Float32Array; indices: number[] } => {
  const positions = new Float32Array(n * 3)
  let s = 7
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  for (let i = 0; i < n; i++) {
    positions[i * 3] = rnd() * 4096
    positions[i * 3 + 1] = rnd() * 300
    positions[i * 3 + 2] = rnd() * 4096
  }
  return { positions, indices: Array.from({ length: n }, (_, i) => i) }
}

describe('prop culling cells — DEV-118', () => {
  it('partitions the indices: every one present exactly once, none invented', () => {
    const { positions, indices } = scatter(1000)
    const extent = scatterExtent(positions, 1000)
    const cells = cellIndices(indices, positions, extent, GRID)
    const flat = cells.flat().sort((a, b) => a - b)
    expect(flat).toEqual(indices)
    expect(cells.length).toBeLessThanOrEqual(GRID * GRID)
    expect(cells.length).toBeGreaterThan(1)
  })

  it('puts a placement in the cell whose square of the extent contains it', () => {
    const { positions, indices } = scatter(600)
    const extent = scatterExtent(positions, 600)
    const per = GRID
    for (const cell of cellIndices(indices, positions, extent, GRID)) {
      // Every member of a cell shares one (cx, cz) — derived independently of
      // the implementation from the extent, not read back from it.
      const keys = new Set(
        cell.map((i) => {
          const u = ((positions[i * 3] as number) - extent.minX) / extent.sizeX
          const v = ((positions[i * 3 + 2] as number) - extent.minZ) / extent.sizeZ
          return `${Math.min(per - 1, Math.floor(u * per))},${Math.min(per - 1, Math.floor(v * per))}`
        }),
      )
      expect(keys.size, `cell ${JSON.stringify([...keys])} spans one square`).toBe(1)
    }
  })

  it('works on a subset of the indices — one palette entry of a shared extent', () => {
    const { positions } = scatter(300)
    const extent = scatterExtent(positions, 300)
    const subset = [3, 17, 42, 99, 250]
    const cells = cellIndices(subset, positions, extent, GRID)
    expect(cells.flat().sort((a, b) => a - b)).toEqual(subset)
  })

  it('keeps the order inside a cell as the bake gave it — the draw order is the bake order', () => {
    const { positions, indices } = scatter(400)
    const extent = scatterExtent(positions, 400)
    for (const cell of cellIndices(indices, positions, extent, GRID)) {
      for (let k = 1; k < cell.length; k++) {
        expect(cell[k] as number).toBeGreaterThan(cell[k - 1] as number)
      }
    }
  })

  it('a degenerate extent — one placement, or none — does not divide by zero', () => {
    const one = new Float32Array([100, 5, 200])
    const e1 = scatterExtent(one, 1)
    expect(cellIndices([0], one, e1)).toEqual([[0]])
    const e0 = scatterExtent(new Float32Array(0), 0)
    expect(Number.isFinite(e0.sizeX) && e0.sizeX > 0).toBe(true)
    expect(cellIndices([], one, e0)).toEqual([])
  })

  it('ships as ONE cell — the whole scatter in one mesh, culled as a whole', () => {
    const { positions, indices } = scatter(200)
    const extent = scatterExtent(positions, 200)
    expect(PROP_CELLS_PER_AXIS).toBe(1)
    expect(cellIndices(indices, positions, extent)).toEqual([indices])
  })

  it('the extent is the box of the placements, x and z, in the frame they were given', () => {
    const p = new Float32Array([10, 0, -5, 30, 0, 25, 20, 0, 5])
    expect(scatterExtent(p, 3)).toEqual({ minX: 10, minZ: -5, sizeX: 20, sizeZ: 30 })
  })
})
