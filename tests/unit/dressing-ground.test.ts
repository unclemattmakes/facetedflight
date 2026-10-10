/**
 * tests/unit/dressing-ground.test.ts — the dressing stands on what you SEE.
 *
 * Wishlist #20, DEV-288. Matt: *"props seem to hover or sink into the ground — trace
 * down to nearest vert and then down a lil more."*
 *
 * ── The defect, and the part the docs had wrong ──────────────────────────
 *
 * `placeDressing` takes each prop's y from `groundAt`, a bilinear read of the
 * height map. The mesh you SEE is that map sampled on the `baseResolution`
 * grid, jittered per vertex, and triangulated. The two disagree.
 *
 * CLAUDE.md, the wishlist and DEV-134's own preset note all blame the JITTER
 * (`RandomOffset`, 0.8 m on an 8 m grid). **Measured, the jitter is the small
 * term.** Rebuilding the vertex grid with `randomOffset: 0` and re-measuring
 * over 23,053 shipped placements moves the mean by 0.09–0.23 m and leaves the
 * rest standing:
 *
 *     alpine  boulder  shipped mean 1.488   no jitter 1.400
 *     desert  boulder  shipped mean 1.540   no jitter 1.442
 *     kauai   shrub    shipped mean 0.829   no jitter 0.657
 *
 * The big term is FACETISATION: the map is read bilinearly at 4 m texels and
 * the mesh is an 8 m triangulation of it, so on steep ground a flat facet and
 * the smooth curve through it are metres apart. The signature is in the shrub
 * row — shrubs are banded onto slope 0..0.4 and their no-jitter p50 is
 * **0.000**, because on flat ground a facet and the map agree exactly. Jitter
 * would not care about the slope; facetisation is all slope. That is the case
 * that separates the two explanations, and it came out unambiguous.
 *
 * ── What this file guards, and what it deliberately cannot ───────────────
 *
 * The MAGNITUDE needs the gitignored terrain maps, so it lives in the ledger
 * row where it can be a table. What lives here is the mechanism, on a
 * synthetic map, with no assets and no `describe.skipIf`:
 *
 *   1. unsnapped placements are NOT on the rendered surface (the must-fire —
 *      without it every assertion below passes on a flat map where the two
 *      surfaces agree, which is exactly the trap the shrub row describes);
 *   2. snapped ones are on it EXACTLY;
 *   3. the snap is a pure vertical move — nothing else about a placement changes;
 *   4. the sink is 0 ON PURPOSE, because the mesh buries itself.
 */
import { describe, expect, it } from 'vitest'
import anniversaryJson from '@/../content/editions/anniversary.json'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import type { Edition } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import { loadDressing } from '@/game/props/load-dressing'
import {
  type DressingBand,
  type DressingInput,
  type DressingSpec,
  placeDressing,
} from '@/sim/props/dressing'
import { generatePropVariants, PROP_KINDS } from '@/sim/props/generate-shapes'
import { buildVertexGrid, type FacetedTerrainParams } from '@/sim/terrain/faceted'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import { renderSurfaceHeightAt, snapToRenderSurface } from '@/sim/terrain/surface'

/**
 * A map with real RELIEF, and that is load-bearing.
 *
 * A flat map makes the facet and the bilinear read agree everywhere, and every
 * assertion here would pass against a build with the snap deleted. The ridges
 * are diagonal so no quad's diagonal choice is degenerate.
 */
const relief: MapSampler = {
  width: 256,
  height: 256,
  sample(u: number, v: number, out: Rgb): void {
    const h = 0.5 + 0.22 * Math.sin(u * 9.1) * Math.cos(v * 7.3) + 0.12 * Math.sin((u + v) * 21)
    out.r = h
    out.g = h
    out.b = h
  },
}

const PARAMS: FacetedTerrainParams = {
  terrainSize: 1024,
  terrainHeight: 600,
  chunkSize: 256,
  baseResolution: 8,
  randomOffset: 0.8,
  seed: 20260921,
}

const BANDS: readonly DressingBand[] = [
  {
    kind: 'boulder',
    density: 4000,
    scaleMin: 1.2,
    scaleMax: 3.2,
    slopeMin: 0,
    slopeMax: 1,
    altitudeMin: -1e6,
    altitudeMax: 1e6,
    nearWater: false,
    tint: 0,
    palette: [[0.5, 0.5, 0.5]],
  },
]

const SPEC: DressingSpec = { seed: 99, clearance: 0, variants: 4, bands: BANDS }

const inputOf = (): DressingInput => ({
  environmentId: 'synthetic',
  terrain: {
    terrainSize: PARAMS.terrainSize,
    terrainHeight: PARAMS.terrainHeight,
    step: PARAMS.baseResolution,
    originX: 0,
    originY: 0,
    originZ: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
  },
  heightMap: relief,
  colorMap: null,
  water: null,
  route: null,
  gates: [],
  spawnClearings: [],
  noPropVolumes: [],
  spec: SPEC,
})

const place = () => {
  const all = [...placeDressing(inputOf())]
  const boulders = all.find((p) => p.kind === 'boulder')
  expect(boulders, 'the synthetic band placed something').toBeTruthy()
  expect(boulders?.count ?? 0, 'enough placements to be a distribution').toBeGreaterThan(200)
  return boulders as NonNullable<typeof boulders>
}

const grid = () => buildVertexGrid(relief, PARAMS)

/** Signed gap from the RENDERED surface, per placement. Positive is floating. */
const gaps = (placements: ReturnType<typeof place>, g: ReturnType<typeof grid>): number[] => {
  const out: number[] = []
  for (let i = 0; i < placements.count; i++) {
    const x = placements.positions[i * 3] as number
    const y = placements.positions[i * 3 + 1] as number
    const z = placements.positions[i * 3 + 2] as number
    out.push(y - renderSurfaceHeightAt(g, relief, PARAMS, x, z))
  }
  return out
}

describe('DEV-288: the dressing is placed on the map, and drawn against the mesh', () => {
  it('MUST-FIRE: unsnapped placements are off the rendered surface', () => {
    // Without this the three tests below pass against a build with the snap
    // deleted, because on flat ground the two surfaces agree and every gap is
    // already zero. The relief map exists for this assertion.
    const g = grid()
    const d = gaps(place(), g)
    const off = d.filter((v) => Math.abs(v) > 0.3).length
    expect(off / d.length, 'a real share of them are more than 0.3 m out').toBeGreaterThan(0.2)
    expect(
      Math.max(...d.map(Math.abs)),
      'and the worst is metres, not millimetres',
    ).toBeGreaterThan(1)
    // Both signs, or "snap" could mean "always lower" and still pass.
    expect(Math.min(...d), 'some are buried').toBeLessThan(0)
    expect(Math.max(...d), 'some are floating').toBeGreaterThan(0)
  })

  it('after the snap every placement is ON the rendered surface, exactly', () => {
    const g = grid()
    const placements = place()
    snapToRenderSurface(placements.positions, placements.count, g, relief, PARAMS, 0, 0)
    const d = gaps(placements, g)
    // EXACTLY: the snap writes the same function's answer, so the residual is
    // float noise and nothing else. A tolerance of centimetres here would hide
    // a snap that used the collider grid or the wrong LOD.
    expect(Math.max(...d.map(Math.abs))).toBeLessThan(1e-4)
  })

  it('the snap is a VERTICAL move — it changes nothing else about a placement', () => {
    // A placement that shifted in x, or whose yaw or variant moved, would be a
    // re-roll wearing a snap's clothes. Same lesson as DEV-100's clearing
    // subtracting rather than perturbing.
    //
    // ── THIS ASSERTION IS LOAD-BEARING FOR ANOTHER FILE ─────────────────
    //
    // `tests/e2e/spawn-clearing.spec.ts` makes four claims about the dressing
    // across five missions — the instance count, the DEV-103 origin against
    // the environment's recorded clearing radius, the nearest vertex against
    // the launch room, and the preset pair. Every one of them survived DEV-288
    // **because the snap is vertical**: that file's two metrics are horizontal
    // (`at()` returns `hypot(wx - ax, wz - az)` and `nearestOrigin` is the same
    // in x and z), and a y translation is `e[13]`, which enters neither.
    //
    // So: **sinking a prop is free, moving one in x/z is not.** Relax this
    // test and those four go quietly exposed on five missions, with nothing in
    // either file connecting them — CLAUDE.md's *"ask what READS this
    // default"* across a file boundary. If a future placement rule has to move
    // a prop horizontally, that spec is the one to re-run, and it will say so
    // on five missions rather than one.
    //
    // The premise is checked at the source rather than inferred: `surface.ts`
    // reads `positions[i * 3]` and `positions[i * 3 + 2]` and assigns only
    // `positions[i * 3 + 1]`. The loop below is the same fact asserted over
    // real placements, which is what catches a caller that reaches for the
    // arrays itself.
    const g = grid()
    const before = place()
    const after = place()
    snapToRenderSurface(after.positions, after.count, g, relief, PARAMS, 0, 0)
    expect(after.count).toBe(before.count)
    for (let i = 0; i < before.count; i++) {
      expect(after.positions[i * 3], `x ${i}`).toBe(before.positions[i * 3])
      expect(after.positions[i * 3 + 2], `z ${i}`).toBe(before.positions[i * 3 + 2])
      expect(after.yaw[i], `yaw ${i}`).toBe(before.yaw[i])
      expect(after.tilt[i], `tilt ${i}`).toBe(before.tilt[i])
      expect(after.scale[i], `scale ${i}`).toBe(before.scale[i])
      expect(after.squash[i], `squash ${i}`).toBe(before.squash[i])
      expect(after.variant[i], `variant ${i}`).toBe(before.variant[i])
    }
  })

  it('needs NO sink, because the generated mesh already buries itself', () => {
    // DEV-134 sinks the SCATTER by a constant 0.6 m: a Tree Pack trunk's origin
    // is its base, so a tree standing exactly on a facet reads as standing on a
    // table. A generated prop solves the same problem in its GEOMETRY —
    // `generate-shapes.ts` puts `minY` at `-sink * fullHeight` — and that
    // scales with the instance where a constant does not.
    //
    // So the dressing's snap passes sink 0, and this is the assertion that says
    // why: adding DEV-134's constant on top would bury every prop twice.
    for (const kind of PROP_KINDS) {
      for (const mesh of generatePropVariants(kind, 4, 12345)) {
        expect(mesh.buried, `${kind}: is partly below y = 0 already`).toBeGreaterThan(0)
        expect(
          mesh.buried / (mesh.height + mesh.buried),
          `${kind}: buries a FRACTION of itself, so it scales with the instance`,
        ).toBeLessThan(0.5)
      }
    }
  })
})

// ── and the wiring, which the four above cannot see ───────────────────────

/**
 * Every assertion above drives `snapToRenderSurface` directly, so all four are
 * green against a build where `loadDressing` never calls it. That is the shape
 * of hole a peer session found in DEV-287 an hour before this was written — a
 * law that balances when the feature is off — and it is worth not repeating in
 * the same afternoon.
 *
 * So this drives the REAL loader, both arms, and asserts the receipt moves.
 */
describe('DEV-288: the loader actually applies it', () => {
  const editionState = () =>
    createEditionState(anniversaryJson as unknown as Edition, DEFAULT_SETTINGS)

  const load = (snap: boolean) =>
    loadDressing(editionState(), {
      // `alpine`, not `synthetic`: the SHIPPED preset's bands carry an
      // `environments` list and none of them names a made-up one, so a
      // synthetic id builds an empty dressing and both arms report 0 — which
      // is the vacuous pass this pair exists to avoid. The terrain under it is
      // still the synthetic relief map; only the id has to be real.
      environmentId: 'alpine',
      terrain: inputOf().terrain,
      heightMap: relief,
      colorMap: null,
      water: null,
      routePoints: null,
      gates: [],
      spawnClearings: [],
      noPropVolumes: [],
      groundSnap: snap ? { params: PARAMS } : null,
    })

  it('moves props when asked, and reports how many were in the air', () => {
    const on = load(true)
    expect(on.instanceCount, 'the loader built a dressing at all').toBeGreaterThan(0)
    expect(
      on.floatingFixed,
      'props were in the air and the loader brought them down — 0 here means the ' +
        'snap is not wired into loadDressing, which every test above would miss',
    ).toBeGreaterThan(0)
    on.dispose()
  })

  it('and leaves them alone when not — the arm that makes the number mean something', () => {
    const off = load(false)
    expect(off.instanceCount, 'same dressing, both arms').toBeGreaterThan(0)
    expect(off.floatingFixed, 'nothing measured, so nothing reported').toBe(0)
    off.dispose()
  })
})
