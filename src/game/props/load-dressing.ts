// src/game/props/load-dressing.ts — the preset half of V9. DEV-089.
//
// `sim/props/dressing.ts` decides where, `render/dressing.ts` draws it, and this
// is the twenty lines that read `EditionProps` and join them up — the same split
// `game/air.ts` keeps between `EditionMotes` and `render/motes.ts`, and
// `game/props/load-props.ts` keeps between the environment JSON and the palms.
//
// ── Parented to the TERRAIN group, exactly like the palms ────────────────
//
// `loadProps` says why and it is worth saying twice: the group inherits
// `worldOffset + localPos + envRoot` from the terrain it hangs under, and the
// alternative is a second copy of a sum that has been wrong twice (DEV-042,
// DEV-047). **Compose the parent chain; do not re-derive it.** The placement
// pass works in the terrain's mesh-local frame for that reason and no other.
//
// ── What a preset flip does, and the one thing it does not ───────────────
//
// A flip toggles `group.visible`, which is free and takes the draw calls to
// zero — three skips an invisible object before it reaches the render list, so
// **Classic really does draw what it drew before**, not "the same thing with an
// empty instance count".
//
// A run that STARTS on Classic has nothing built, because building means a
// placement pass over a quarter of a million terrain cells. Flipping to
// Anniversary mid-run therefore builds it THEN, once, lazily — the flip happens
// on the pause plate, where the game is already stopped, which is the only
// reason that is an acceptable place to spend it.
//
// ── It leaves alone the ground the palms leave alone, off ONE list (DEV-103) ─
//
// DEV-100 baked a cylinder around every mission's spawn into the 2016 scatter
// and left a receipt of the radius and the centres in the environment JSON.
// The dressing reads that receipt — `spawnClearingsOf` — rather than deriving
// thirteen spawns through `terrainOriginSim` again at boot, so "the rocks and
// the palms clear the same ground" is a fact about one list and not an
// agreement between two derivations. Two derivations of one sum is exactly
// what DEV-042 cost a session to.

import * as THREE from 'three'
import type { EditionProps } from '@/content/edition-schema'
import type { SpawnClearing } from '@/content/load-environment'
import type { EditionState } from '@/game/edition'
import {
  createFlockField,
  createPropField,
  type FlockField,
  type PropField,
} from '@/render/dressing'
import type { Clearing } from '@/sim/props/clearing'
import {
  type DressingBand,
  type DressingInput,
  type DressingSpec,
  type PropTerrain,
  placeDressing,
  placeFlocks,
} from '@/sim/props/dressing'
import { type FlockPlacement, generateBird } from '@/sim/props/generate-bird'
import { generatePropVariants, PROP_KINDS } from '@/sim/props/generate-shapes'
import { createRoute, type Route } from '@/sim/route'
import { buildVertexGrid, type FacetedTerrainParams } from '@/sim/terrain/faceted'
import type { HeightField } from '@/sim/terrain/height-field'
import type { MapSampler } from '@/sim/terrain/image-sampler'
import { snapToRenderSurface } from '@/sim/terrain/surface'

export interface LoadDressingOptions {
  /** `simonet` / `kauai` / `desert` / `alpine`. A band's `environments` list is matched against it. */
  readonly environmentId: string
  /** The land terrain's own `HeightField` satisfies this as-is — it IS the transform. */
  readonly terrain: PropTerrain
  /** The height map as the generator sampled it. Never a bare sampler (DEV-007). */
  readonly heightMap: MapSampler
  /** The terrain's colour map, for the per-instance tint. Null skips the tint. */
  readonly colorMap: MapSampler | null
  /** The OCEAN's collision surface, or null. `nearWater` bands need it. */
  readonly water: HeightField | null
  /** The authored racing line as the level JSON carries it — THREE space; `createRoute` flips it. */
  readonly routePoints: readonly (readonly number[])[] | null
  /** Ring centres, SIM space. `Gate.centre` already is. */
  readonly gates: readonly { readonly x: number; readonly y: number; readonly z: number }[]
  /**
   * DEV-100's spawn cylinders for this environment, terrain mesh-local, off the
   * environment JSON's `spawnClearing` receipt — `spawnClearingsOf` maps it.
   * DEV-103.
   */
  readonly spawnClearings: readonly Clearing[]
  /**
   * DEV-287's authored volumes for this world, already resolved into the
   * terrain's mesh space by `game/props/no-prop-volumes.ts`. Empty is every
   * environment nobody has authored art direction for.
   */
  readonly noPropVolumes: readonly Clearing[]
  /**
   * Stand every prop on the surface you can SEE, not the one you HIT — DEV-288 (wishlist #20).
   *
   * `placeDressing` takes its y from `groundAt`, a bilinear read of the 4 m
   * height map, and the mesh is an 8 m triangulation of that map with a
   * per-vertex jitter on top. The two disagree, and MEASURED over 23,053
   * shipped placements the disagreement is 0.42 to 1.55 m in the mean and up
   * to 21.8 m at worst — see the ledger row. Passing the terrain's own
   * `FacetedTerrainParams` here re-queries `sim/terrain/surface.ts`'s copy of
   * the triangulation and moves each prop onto it.
   *
   * **There is no `sink` and there must not be one.** DEV-134 sinks the SCATTER
   * by a constant because a Tree Pack trunk's origin is its base; a generated
   * prop buries itself in its own GEOMETRY instead — `generate-shapes.ts`'s
   * `sink` puts `minY` at `-sink * fullHeight`, which scales with the instance
   * and is why a boulder does not read "as a prop sitting on a table". Adding
   * DEV-134's constant on top would bury every one of them twice.
   *
   * Null or absent leaves the placement on the height map, which is where it
   * has always been.
   */
  readonly groundSnap?: { readonly params: FacetedTerrainParams } | null
  /** The mission fog, applied to each material BEFORE the shader patch. See `render/dressing.ts`. */
  readonly applyFog?: (material: THREE.Material) => void
  /**
   * V7's illustrative diffuse warp (DEV-092), so a boulder is lit by the same
   * ramp as the ground it stands on. No flag of its own — see `createPropField`.
   */
  readonly applyIllustrative?: (material: THREE.Material) => void
}

export interface LoadedDressing {
  /** Parent this to the TERRAIN group, not to the scene. */
  readonly group: THREE.Group
  /** Instances built. Zero while Classic is live and nothing has been built yet. */
  readonly instanceCount: number
  /** One per kind, plus one for the birds. */
  readonly drawCalls: number
  readonly triangleCount: number
  readonly flockCount: number
  /**
   * DEV-288: placements that were in the AIR before the ground snap moved them.
   *
   * Zero when the snap is off, because then nothing was measured — the same
   * convention `LoadedProps.floatingFixed` uses. An accessor, because the
   * dressing is built lazily on the first Anniversary frame and a value read
   * at load would be a permanent zero.
   */
  readonly floatingFixed: number
  /** Whether the live preset is drawing it. */
  readonly visible: boolean
  /** One frame, RENDER clock. Birds only — the props never move. */
  update(seconds: number): void
  dispose(): void
}

/** The preset, resolved to what the pure layer takes. `null` is "draw nothing". */
export const dressingSpecFor = (props: EditionProps): DressingSpec | null => {
  if (!props.enabled || props.scatter.length === 0) return null
  const bands: DressingBand[] = props.scatter.map((b) => ({
    kind: b.kind,
    density: b.density,
    scaleMin: b.scaleMin,
    scaleMax: b.scaleMax,
    slopeMin: b.slopeMin,
    slopeMax: b.slopeMax,
    altitudeMin: b.altitudeMin,
    altitudeMax: b.altitudeMax,
    nearWater: b.nearWater,
    tint: b.tint,
    palette: b.palette,
    // Spread rather than assigned: `exactOptionalPropertyTypes` is on, so an
    // absent `environments` and one explicitly set to `undefined` are different
    // types — and "absent" is the one that means "every environment".
    ...(b.environments ? { environments: b.environments } : {}),
  }))
  return { seed: props.seed, clearance: props.clearance, variants: props.variants, bands }
}

/**
 * The spawn cylinders the dressing must stand off, read from the environment
 * JSON's own `spawnClearing` receipt (DEV-100) — the union of every mission of
 * that environment, already in the terrain's mesh space, and the SAME list the
 * 2016 scatter was baked against. Nothing is added, converted or dropped.
 *
 * Null, or a JSON baked before DEV-100, is an environment with no receipt:
 * nothing to clear against, returned as an empty list and reported by the
 * caller rather than invented here.
 */
export const spawnClearingsOf = (
  env: { readonly spawnClearing?: SpawnClearing } | null,
): readonly Clearing[] => {
  const receipt = env?.spawnClearing
  if (!receipt) return []
  return receipt.missions.map((m) => ({ x: m.x, z: m.z, radius: receipt.radius }))
}

/**
 * Build the scenery for one environment.
 *
 * Synchronous and deliberately so: everything it needs is already in memory —
 * the height map the terrain fetched, the colour map beside it, and the route
 * out of the level JSON. There is no asset to download, which is the whole point
 * of a generated palette (§1.5 item 6: *"the palette is the whole cost"*).
 */
export const loadDressing = (
  edition: EditionState,
  options: LoadDressingOptions,
): LoadedDressing => {
  const group = new THREE.Group()
  group.name = `dressing:${options.environmentId}`

  let fields: PropField[] = []
  let flock: FlockField | null = null
  let instanceCount = 0
  let drawCalls = 0
  let triangleCount = 0
  let flockCount = 0
  /** DEV-288: how many placements were in the AIR before the snap. See the loop. */
  let wereFloating = 0
  let built = false

  const route: Route | null =
    options.routePoints && options.routePoints.length > 1 ? createRoute(options.routePoints) : null

  const build = (props: EditionProps): void => {
    if (built) return
    const spec = dressingSpecFor(props)
    if (!spec) return
    built = true

    const input: DressingInput = {
      environmentId: options.environmentId,
      terrain: options.terrain,
      heightMap: options.heightMap,
      colorMap: options.colorMap,
      water: options.water,
      route,
      gates: options.gates,
      spawnClearings: options.spawnClearings,
      noPropVolumes: options.noPropVolumes,
      spec,
    }

    // ── DEV-288: the vertex grid, built HERE and dropped when this returns ────
    //
    // Not borrowed from `loadProps`, which builds the same grid for DEV-134 and
    // discards it. This `build()` is LAZY — a run that starts on Classic has no
    // dressing at all, and a flip to Anniversary on the pause plate builds it
    // then — so holding `loadProps`'s 3 MB of vertices alive for a flip that may
    // never happen would be a leak in the common case. Building it in the branch
    // that needs it keeps the cost where the feature is.
    const surface = options.groundSnap
      ? buildVertexGrid(options.heightMap, options.groundSnap.params)
      : null

    for (const placements of placeDressing(input)) {
      // DEV-288. AFTER the placement pass and BEFORE the field, so the y every
      // instance is drawn at is the rendered surface's. Sink 0 — the mesh
      // buries itself, see the option's note.
      //
      // The return counts placements that were ABOVE the surface, which is
      // only half of what was wrong: the other half were under it, and
      // `snapToRenderSurface` cannot report both without a second loop. So
      // this is *how many were in the air*, said plainly, and the full signed
      // distribution lives in the ledger row where it can be a table.
      if (surface && options.groundSnap) {
        wereFloating += snapToRenderSurface(
          placements.positions,
          placements.count,
          surface,
          options.heightMap,
          options.groundSnap.params,
          0,
          0,
        )
      }
      // The variants are generated ONLY for a kind that got placements, and
      // seeded off the placement seed and the kind — so two kinds never share a
      // silhouette and a preset that changes `seed` changes both the layout and
      // the shapes, which is what "same seed, same world" has to mean.
      const variants = generatePropVariants(
        placements.kind,
        spec.variants,
        (spec.seed + PROP_KINDS.indexOf(placements.kind) * 104_729) >>> 0,
      )
      const field = createPropField(
        variants,
        placements,
        options.applyFog,
        options.applyIllustrative,
      )
      group.add(field.object)
      fields.push(field)
      instanceCount += field.instances
      triangleCount += field.triangles
      drawCalls++
    }

    if (props.birds.enabled && props.birds.flocks > 0) {
      const placed: readonly FlockPlacement[] = placeFlocks(
        input,
        {
          flocks: props.birds.flocks,
          birdsPerFlock: props.birds.birdsPerFlock,
          altitude: props.birds.altitude,
          radius: props.birds.radius,
          speed: props.birds.speed,
          size: props.birds.size,
          palette: props.birds.palette,
        },
        (spec.seed + 0x0b18d) >>> 0,
      )
      if (placed.length > 0) {
        flock = createFlockField(
          generateBird(),
          placed,
          options.applyFog,
          options.applyIllustrative,
        )
        group.add(flock.object)
        instanceCount += flock.instances
        flockCount = placed.length
        drawCalls++
      }
    }
  }

  const apply = (): void => {
    const props = edition.current.props
    if (props.enabled) build(props)
    group.visible = props.enabled && built
  }

  apply()
  const unsubscribe = edition.subscribe(apply)

  return {
    group,
    get instanceCount() {
      return instanceCount
    },
    get drawCalls() {
      return drawCalls
    },
    get triangleCount() {
      return triangleCount
    },
    get flockCount() {
      return flockCount
    },
    get floatingFixed() {
      return wereFloating
    },
    get visible() {
      return group.visible
    },
    update(seconds: number): void {
      // Nothing to do for the props: they are static in the world and their
      // matrices were written once. A hidden group is skipped entirely, so a
      // Classic frame costs the birds nothing either.
      if (group.visible) flock?.update(seconds)
    },
    dispose(): void {
      unsubscribe()
      for (const f of fields) f.dispose()
      flock?.dispose()
      fields = []
      flock = null
    },
  }
}
