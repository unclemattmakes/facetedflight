// src/game/life/load-life.ts — the preset half of the life pass. DEV-447.
//
// `sim/life/boats.ts` says where, `sim/life/sea-facet.ts` what each hull sits
// on, `render/life-boats.ts` draws and moves them. This is the part that knows
// about the edition, the comfort quality, the level and the two terrains, and
// joins them — the split `game/props/load-dressing.ts` keeps for V9.
//
// ── Built lazily, shown by a getter ───────────────────────────────────────
//
// `sync(wanted)` is called every frame with the live answer to "should boats
// be drawn" (the preset flag AND the comfort quality — `boatsWanted` below).
// The first `true` starts the build — two small GLBs and a placement pass of a
// few hundred height reads — and every `false` after that only hides the
// group. So a run that starts on Classic fetches nothing, a flip to
// Anniversary on the pause plate builds once, and a quality change back and
// forth never rebuilds (`editionState` is a getter; see `game/edition.ts`'s
// standing rule, *"a getter, cheap, and always the live one"*).
//
// ── Where the fleet is in the world ───────────────────────────────────────
//
// At the SCENE root, in THREE world, because a boat rides the ocean plate and
// the ocean plate is its own group at the root (not the island's). The rest
// transform is the ocean's `HeightField`'s — the object that owns it — and the
// bob is how far the plate's group stands above that this frame, which is the
// line `LoadedTerrain.setWaveTime` writes.
//
// ── No crowds (DEV-463) ───────────────────────────────────────────────────
//
// DEV-448 built generated spectators on the shore here, beside the boats. Matt
// cut them (*"the spectators kinda worry me. let's cut them and just go with
// things like the boats and sea life"*): the life pass is the boats and the
// leapers.

import * as THREE from 'three'
import { QUALITIES, type QualitySetting } from '@/boot/settings'
import { assetUrl } from '@/content/asset-url'
import type {
  EditionLife,
  EditionLifeBoats,
  EditionLifeLeapers,
  LifeQuality,
} from '@/content/edition-schema'
import { isMeshLoadError, warnMissingAssetOnce } from '@/game/missing-asset'
import type { LoadedTerrain } from '@/game/terrain/load-terrain'
import {
  type BoatFleet,
  type BoatKindMesh,
  type BoatPose,
  createBoatFleet,
  type HullSample,
} from '@/render/life-boats'
import { createLeaperField, type LeaperField, type LeapSplash } from '@/render/life-leapers'
import { type LoadedMesh, loadMesh } from '@/render/load-mesh'
import { type BoatKindSpec, type KeepOut, placeBoats, seedOf } from '@/sim/life/boats'
import { placePods } from '@/sim/life/pods'
import { planWeights, seaFacetAt } from '@/sim/life/sea-facet'
import { createRoute, type Route } from '@/sim/route'

/**
 * Is `quality` at or above `min`? The comfort ladder, low < medium < high <
 * ultra, read from `boot/settings.ts`'s own `QUALITIES` (DEV-581). It used to
 * index `LIFE_QUALITIES`, the three FLOORS an edition may name, and `ultra` is
 * not one of them, so ultra read as index -1 and turned every boat off: the
 * best tier drawing less than `high`. A floor is still one of the three; the
 * ladder it is compared on is the whole one. An unknown string is below
 * everything, as it was.
 */
export const qualityAtLeast = (quality: string, min: LifeQuality): boolean => {
  const at = QUALITIES.indexOf(quality as QualitySetting)
  return at >= 0 && at >= QUALITIES.indexOf(min)
}

/**
 * Should the boats be drawn NOW? The preset's flag, and the comfort quality at
 * or above the kind's floor. Pure, so the whole rule is a unit test.
 */
export const boatsWanted = (boats: EditionLifeBoats, quality: string): boolean =>
  boats.enabled && qualityAtLeast(quality, boats.minQuality)

/** The same rule for a leaping kind (DEV-449). */
export const leapersWanted = (l: EditionLifeLeapers, quality: string): boolean =>
  l.enabled && qualityAtLeast(quality, l.minQuality)

/**
 * The leaping kinds, by their key in the `life` block. One since DEV-545 (Matt,
 * 2026-09-30: *"kill the fish"*); the machinery stays a list, so a kind is a
 * key here and a block in the edition, not a new code path.
 */
export const LEAPER_KINDS = ['dolphins'] as const
export type LeaperKind = (typeof LEAPER_KINDS)[number]

/** Each kind's answer, for `Life.sync`. */
export interface LifeWanted {
  readonly boats: boolean
  readonly dolphins: boolean
}

export const lifeWanted = (life: EditionLife, quality: string): LifeWanted => ({
  boats: boatsWanted(life.boats, quality),
  dolphins: leapersWanted(life.dolphins, quality),
})

export interface LifeWorld {
  /** For the course seed and the console line. */
  readonly levelId: string
  /** The racing line as the level JSON carries it — THREE space. Null: use the gates. */
  readonly routePoints: readonly (readonly number[])[] | null
  /** The spawn, THREE space (the level JSON's `spawn.pos`). */
  readonly spawn: readonly number[]
  /** Ring or pad centres, SIM space (`Gate.centre`). The line where there is no route. */
  readonly gates: readonly { readonly x: number; readonly y: number; readonly z: number }[]
  readonly land: LoadedTerrain
  /** Null on an environment with no sea — which then gets no boats, by the rule. */
  readonly ocean: LoadedTerrain | null
  /**
   * The spawn clearings (DEV-100) as the environment JSON records them —
   * the LAND terrain's mesh-local frame. Converted here, once.
   */
  readonly spawnClearings: readonly {
    readonly x: number
    readonly z: number
    readonly radius: number
  }[]
  /** The mission fog and the far shadow, as the scatter props get them. */
  readonly applyFog?: (material: THREE.Material) => void
  /**
   * DEV-613: told each time a leaper leaves the water or lands in it, on the
   * drawn wave. The object is reused: copy what is kept.
   */
  readonly splash?: (s: LeapSplash) => void
}

/** What the probe and a spec can read. THREE world. */
export interface LifeBoatProbe {
  readonly kind: string
  readonly x: number
  readonly z: number
  readonly scale: number
  /** The drawn sea's height under the boat's centre this frame. */
  readonly surface: number
  /** Where the instance stands: the keel's height. */
  readonly keel: number
  /** Heading of the hull's long axis, radians about +y. */
  readonly yaw: number
  /**
   * The drawn sea triangle under the BOW, three corners, THREE world with the
   * plate at rest — what a spec looks up in the ocean's own chunk geometry.
   */
  readonly bowFacet: readonly number[]
}

export interface LifeProbe {
  readonly wanted: boolean
  readonly built: boolean
  readonly visible: boolean
  readonly boats: readonly LifeBoatProbe[]
  readonly drawCalls: number
  readonly triangles: number
  /** The ocean plate's rest height: its `HeightField`'s origin y. Null with no sea. */
  readonly seaRestY: number | null
  /** The dolphins (DEV-449; the fish went with DEV-545). */
  readonly leapers: Readonly<Record<LeaperKind, LeaperProbe>>
}

export interface LeaperProbe {
  readonly wanted: boolean
  readonly built: boolean
  readonly visible: boolean
  readonly count: number
  readonly drawCalls: number
  readonly triangles: number
  /** In the air at the last frame. */
  readonly airborne: number
  /** Pod breaches cued since the build (DEV-532): 0 on a kind with no `breach`. */
  readonly breaches: number
  /** Every animal's leap middle, THREE world plan, and its pod. */
  readonly animals: readonly { x: number; z: number; pod: number }[]
}

export interface Life {
  /** Add this to the scene root. Named `life`. */
  readonly group: THREE.Group
  /** Called each frame with `lifeWanted(...)`. Each kind builds on its first true. */
  sync(wanted: LifeWanted): void
  /**
   * The sea's clock this frame — the value handed to `setWaveTime` — and the
   * head's world position, which cues a pod's breach (DEV-532).
   */
  update(seconds: number, eye?: { x: number; y: number; z: number } | null): void
  /** Resolves when a build started by `sync` has finished (or at once). */
  ready(): Promise<void>
  probe(): LifeProbe
  dispose(): void
}

/** Scratch for the facet search. Never stored. */
const _facet = new Float64Array(9)
const _w = [0, 0, 0]

/** The line the fleet spreads along: the route, else spawn then the gates. */
const lineOf = (world: LifeWorld): Route | null => {
  if (world.routePoints && world.routePoints.length >= 2) return createRoute(world.routePoints)
  // Gates are SIM; `createRoute` takes THREE and flips, so flip them back.
  const pts = [world.spawn, ...world.gates.map((g) => [g.x, g.y, -g.z])]
  return pts.length >= 2 ? createRoute(pts) : null
}

/**
 * A THREE plan point's drawn sea triangle — `sim/life/sea-facet.ts`'s, at the
 * ocean's own LOD 0 split and jitter — in THREE world with the plate at rest,
 * and the point's weights in it. What a hull (DEV-447) and a leap's ends
 * (DEV-449) read the wave through.
 */
const seaSampler = (ocean: LoadedTerrain) => {
  const sea = ocean.heightField
  const subdivide = ocean.subdivisionAt(0)
  const jitter = ocean.params.randomOffset
  return (tx: number, tz: number): HullSample => {
    const mx = (tx - sea.originX) / sea.scaleX
    const mz = (-tz - sea.originZ) / sea.scaleZ
    seaFacetAt(ocean.surfaceGrid, ocean.heightMap, ocean.params, subdivide, jitter, mx, mz, _facet)
    planWeights(_facet, mx, mz, _w)
    const corners = new Float64Array(9)
    for (let k = 0; k < 3; k++) {
      corners[k * 3] = sea.originX + (_facet[k * 3] as number) * sea.scaleX
      corners[k * 3 + 1] = sea.originY + (_facet[k * 3 + 1] as number) * sea.scaleY
      corners[k * 3 + 2] = -(sea.originZ + (_facet[k * 3 + 2] as number) * sea.scaleZ)
    }
    return { corners, weights: [_w[0] as number, _w[1] as number, _w[2] as number] }
  }
}

/**
 * Build one leaping kind: fetch its mesh, place its pods, read the drawn sea
 * at each leap's two ends. Null with no sea or no water deep enough.
 */
const buildLeapers = async (
  kind: LeaperKind,
  spec: EditionLifeLeapers,
  world: LifeWorld,
): Promise<{ field: LeaperField; dispose(): void } | null> => {
  const ocean = world.ocean
  const water = ocean?.water ?? null
  if (!ocean || !water) return null
  const animals = placePods({
    spec,
    courseSeed: seedOf(world.levelId),
    line: lineOf(world),
    start: { x: world.spawn[0] as number, z: -(world.spawn[2] as number) },
    sea: ocean.heightField,
    land: world.land.heightField,
    keepOut: keepOutOf(world),
  })
  if (animals.length === 0) return null
  const loaded = await loadMesh(assetUrl(spec.mesh))
  let geometry: THREE.BufferGeometry | null = null
  loaded.object.traverse((node) => {
    const m = node as THREE.Mesh
    if (!geometry && m.isMesh && m.geometry) geometry = m.geometry
  })
  if (!geometry) {
    loaded.dispose()
    throw new Error(`life: ${spec.mesh} holds no mesh`)
  }
  const sample = seaSampler(ocean)
  const poses = animals.map((l) => {
    // The leap's two ends, SIM -> THREE: along the heading, half a length out.
    const dx = Math.sin(l.heading) * (l.length / 2)
    const dz = Math.cos(l.heading) * (l.length / 2)
    return { leaper: l, from: sample(l.x - dx, -(l.z - dz)), to: sample(l.x + dx, -(l.z + dz)) }
  })
  const field = createLeaperField(
    `life:${kind}`,
    geometry,
    poses,
    spec.gravity,
    water.displace,
    world.applyFog,
    spec.breach ?? null,
    world.splash ?? null,
  )
  return {
    field,
    dispose() {
      field.dispose()
      loaded.dispose()
    },
  }
}

/**
 * Build the fleet: fetch the meshes, measure them, place, find every hull
 * point's facet. Null when there is no sea or no boat fits.
 */
const buildFleet = async (spec: EditionLifeBoats, world: LifeWorld): Promise<BoatFleet | null> => {
  const ocean = world.ocean
  const water = ocean?.water ?? null
  if (!ocean || !water) return null

  // DEV-898: a boat kind whose mesh will not load is dropped with one warning; the other kind
  // still sails. (Both missing is no fleet, which the caller already handles as null.)
  const settled = await Promise.allSettled(spec.kinds.map((k) => loadMesh(assetUrl(k.mesh))))
  const loaded: LoadedMesh[] = []
  const kindMeshes: BoatKindMesh[] = []
  const kindSpecs: BoatKindSpec[] = []
  const halfBeams: number[] = []
  for (const [i, k] of spec.kinds.entries()) {
    const result = settled[i]
    if (!result || result.status === 'rejected') {
      if (result && !isMeshLoadError(result.reason)) throw result.reason
      warnMissingAssetOnce(k.mesh, 'the boat', result?.reason)
      continue
    }
    const mesh = result.value
    loaded.push(mesh)
    let geometry: THREE.BufferGeometry | null = null
    mesh?.object.traverse((node) => {
      const m = node as THREE.Mesh
      if (!geometry && m.isMesh && m.geometry) geometry = m.geometry
    })
    if (!geometry) throw new Error(`life: ${k.mesh} holds no mesh`)
    const g = geometry as THREE.BufferGeometry
    g.computeBoundingBox()
    const box = g.boundingBox as THREE.Box3
    const ex = Math.max(Math.abs(box.min.x), Math.abs(box.max.x))
    const ez = Math.max(Math.abs(box.min.z), Math.abs(box.max.z))
    // The LONG axis is measured, never assumed: the rowboat was modelled
    // along x and the sailboat along z. A quarter turn about +y takes +z to +x.
    const alongZ = ez > ex
    const align = new THREE.Quaternion()
    if (alongZ) align.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    kindMeshes.push({ id: k.id, geometry: g, draft: k.draft, align })
    kindSpecs.push({ id: k.id, weight: k.weight, scale: k.scale, halfLength: alongZ ? ez : ex })
    halfBeams.push(alongZ ? ex : ez)
  }

  const land = world.land.heightField
  const sea = ocean.heightField
  const keepOut: KeepOut[] = world.spawnClearings.map((c) => ({
    x: land.originX + c.x * land.scaleX,
    z: land.originZ + c.z * land.scaleZ,
    radius: c.radius * Math.max(land.scaleX, land.scaleZ),
  }))
  if (kindSpecs.length === 0) return null
  const placements = placeBoats({
    spec: { ...spec, kinds: kindSpecs },
    courseSeed: seedOf(world.levelId),
    line: lineOf(world),
    start: { x: world.spawn[0] as number, z: -(world.spawn[2] as number) },
    sea,
    land,
    keepOut,
  })
  if (placements.length === 0) {
    for (const l of loaded) l.dispose()
    return null
  }

  const sample = seaSampler(ocean)

  const poses: BoatPose[] = placements.map((p) => {
    const tx = p.x
    const tz = -p.z
    // SIM yaw about +y is the THREE yaw about +y: the long axis is
    // (cos, sin) in SIM plan and (cos, -sin) in THREE, which is the same
    // direction through the z flip (`render/life-boats.ts`'s `hullRotation`).
    const c = Math.cos(p.yaw)
    const s = Math.sin(p.yaw)
    const hl = ((kindSpecs[p.kind] as BoatKindSpec).halfLength * p.scale) as number
    const hb = (halfBeams[p.kind] as number) * p.scale
    const hull: BoatPose['hull'] = [
      sample(tx + c * hl, tz - s * hl),
      sample(tx - c * hl, tz + s * hl),
      sample(tx + s * hb, tz + c * hb),
      sample(tx - s * hb, tz - c * hb),
    ]
    return { kind: p.kind, x: tx, z: tz, yaw: p.yaw, scale: p.scale, span: [2 * hl, 2 * hb], hull }
  })

  const fleet = createBoatFleet(kindMeshes, poses, water.displace, world.applyFog)
  const dispose = fleet.dispose
  return {
    ...fleet,
    dispose() {
      dispose()
      for (const l of loaded) l.dispose()
    },
  }
}

/** Keep-outs in SIM plan, off the environment's spawn clearings (LAND mesh-local). */
const keepOutOf = (world: LifeWorld): KeepOut[] => {
  const land = world.land.heightField
  return world.spawnClearings.map((c) => ({
    x: land.originX + c.x * land.scaleX,
    z: land.originZ + c.z * land.scaleZ,
    radius: c.radius * Math.max(land.scaleX, land.scaleZ),
  }))
}

/**
 * The life pass for one world. Nothing is fetched until `sync` wants boats.
 */
export const createLife = (spec: () => EditionLife, world: LifeWorld): Life => {
  const group = new THREE.Group()
  group.name = 'life'
  // Each kind hangs under a switch of its own, so the preset's flag and a
  // probe that hides the kind's own object (a spec measuring its cost) never
  // write the same `visible`.
  const boatSwitch = new THREE.Group()
  boatSwitch.name = 'life:boats-switch'
  group.add(boatSwitch)
  const leaperSwitch = Object.fromEntries(
    LEAPER_KINDS.map((k) => {
      const g = new THREE.Group()
      g.name = `life:${k}-switch`
      group.add(g)
      return [k, g]
    }),
  ) as Record<LeaperKind, THREE.Group>
  let fleet: BoatFleet | null = null
  let building: Promise<void> | null = null
  let disposed = false
  let wanted: LifeWanted = { boats: false, dolphins: false }
  let lastSeconds = 0
  const ocean = world.ocean
  const leapers: Partial<Record<LeaperKind, { field: LeaperField; dispose(): void } | null>> = {}
  const leaperBuilds: Partial<Record<LeaperKind, Promise<void>>> = {}

  const bob = (): number => (ocean ? ocean.group.position.y - ocean.heightField.originY : 0)

  const startLeapers = (kind: LeaperKind): void => {
    if (leaperBuilds[kind]) return
    leaperBuilds[kind] = buildLeapers(kind, spec()[kind], world)
      .then((built) => {
        if (disposed) {
          built?.dispose()
          return
        }
        leapers[kind] = built
        if (built) {
          leaperSwitch[kind].add(built.field.object)
          built.field.update(lastSeconds, bob())
          console.info(
            `life: ${built.field.count} ${kind} in 1 draw call, ${built.field.triangles} ` +
              `triangles (${world.levelId})`,
          )
        } else {
          console.info(`life: no ${kind} on ${world.levelId} (no sea, or no water deep enough)`)
        }
      })
      .catch((err: unknown) => {
        console.warn(
          `life: ${kind} not drawn — ${err instanceof Error ? err.message : String(err)}. ` +
            'Run `pnpm assets:pull`, or `node tools/assets/convert-life.mjs`.',
        )
      })
  }

  const leaperProbe = (kind: LeaperKind): LeaperProbe => {
    const built = leapers[kind] ?? null
    const shown = built !== null && leaperSwitch[kind].visible && built.field.object.visible
    return {
      wanted: wanted[kind],
      built: built !== null,
      visible: shown,
      count: built?.field.count ?? 0,
      drawCalls: shown ? 1 : 0,
      triangles: shown && built ? built.field.triangles : 0,
      airborne: built ? built.field.airborne() : 0,
      breaches: built ? built.field.breaches() : 0,
      // THREE plan of each leap's middle: SIM (x, z) with z flipped.
      animals:
        built?.field.animals.map((a) => ({ x: a.leaper.x, z: -a.leaper.z, pod: a.leaper.pod })) ??
        [],
    }
  }

  const start = (): void => {
    if (building) return
    building = buildFleet(spec().boats, world)
      .then((f) => {
        if (disposed) {
          f?.dispose()
          return
        }
        fleet = f
        if (f) {
          boatSwitch.add(f.group)
          f.update(lastSeconds, bob())
          console.info(
            `life: ${f.count} boat(s) in ${f.meshes.length} draw call(s), ` +
              `${f.triangles} triangles (${world.levelId})`,
          )
        } else {
          console.info(`life: no boats on ${world.levelId} (no sea, or no water fits the rule)`)
        }
      })
      .catch((err: unknown) => {
        console.warn(
          `life: boats not drawn — ${err instanceof Error ? err.message : String(err)}. ` +
            'Run `pnpm assets:pull`, or `node tools/assets/convert-life.mjs` with $FF2_LEGACY set.',
        )
      })
  }

  return {
    group,
    sync(on) {
      wanted = on
      boatSwitch.visible = on.boats
      if (on.boats) start()
      for (const kind of LEAPER_KINDS) {
        leaperSwitch[kind].visible = on[kind]
        if (on[kind]) startLeapers(kind)
      }
    },
    update(seconds, eye) {
      lastSeconds = seconds
      if (fleet && boatSwitch.visible) fleet.update(seconds, bob())
      for (const kind of LEAPER_KINDS) {
        const built = leapers[kind]
        if (built && leaperSwitch[kind].visible) built.field.update(seconds, bob(), eye)
      }
    },
    ready: async () => {
      await (building ?? Promise.resolve())
      await Promise.all(LEAPER_KINDS.map((k) => leaperBuilds[k] ?? Promise.resolve()))
    },
    probe() {
      const boats: LifeBoatProbe[] = []
      if (fleet) {
        const m = new THREE.Matrix4()
        const p = new THREE.Vector3()
        const s = new THREE.Vector3()
        for (const [k, mesh] of fleet.meshes.entries()) {
          const list = fleet.slots[k] ?? []
          for (let slot = 0; slot < mesh.count; slot++) {
            const i = list[slot] as number
            const pose = fleet.poses[i]
            mesh.getMatrixAt(slot, m)
            p.setFromMatrixPosition(m)
            boats.push({
              kind: mesh.name.replace('life:boats:', ''),
              x: p.x,
              z: p.z,
              scale: s.setFromMatrixScale(m).x,
              surface: fleet.surfaceAt(i),
              keel: p.y,
              yaw: pose?.yaw ?? 0,
              bowFacet: pose ? Array.from(pose.hull[0].corners) : [],
            })
          }
        }
      }
      const boatsShown = fleet !== null && boatSwitch.visible && fleet.group.visible
      return {
        wanted: wanted.boats,
        built: fleet !== null,
        visible: boatsShown,
        boats,
        drawCalls: boatsShown && fleet ? fleet.meshes.length : 0,
        triangles: boatsShown && fleet ? fleet.triangles : 0,
        seaRestY: ocean ? ocean.heightField.originY : null,
        leapers: { dolphins: leaperProbe('dolphins') },
      }
    },
    dispose() {
      disposed = true
      fleet?.dispose()
      fleet = null
      group.removeFromParent()
      for (const kind of LEAPER_KINDS) {
        leapers[kind]?.dispose()
        leapers[kind] = null
      }
    },
  }
}
