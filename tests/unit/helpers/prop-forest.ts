// tests/unit/helpers/prop-forest.ts — an environment's REAL forest, for a test.
//
// NOT a `.test.ts`, so vitest does not collect it. It is `terrain-field.ts`'s
// counterpart for the other thing you can fly into: where that one answers "is
// this point above the ground?", this one answers "is this point inside a
// tree?", with the same capsules `boot/app.ts` builds at world build.
//
// ── Why it goes through the RENDERER's own numbers ────────────────────────
//
// A collider's radius and height are the DRAWN bounds at scale 1 times the
// placement scale (`sim/props/collision.ts`), and the drawn bounds come off the
// glTF accessor through `instanceMatrixOf` — the same matrix the InstancedMesh
// is filled with. Reasoning them out of the prefab YAML instead is how the
// first estimate of tree1's base came out 12.5 m in the air (DEV-134). So this
// reads the GLB, exactly as `prop-ground.test.ts` does.
//
// ── The four things that change the answer, all of them live ──────────────
//
// `loadProps` composes more than `expandPlacements`, and every one of these
// moves a collider. A harness that drops one measures a forest nobody flies:
//
//   `unbakedPasses`  Anniversary draws all five scatter passes, Classic only
//                    the two 2016 BAKED (DEV-102). Alpine has two passes and
//                    only one shipped.
//   `props.scale`    per KIND, and it multiplies the placement scale, so it
//                    scales the collider's radius AND its height. Anniversary
//                    is `tree` 0.6 and `cactus` 0.35 (DEV-134): alpine's and
//                    desert's colliders are a THIRD to two thirds of what the
//                    raw placement says.
//   `groundSnap`     moves every floating instance down onto the rendered
//                    surface and 0.6 m into it (DEV-134), which is where the
//                    capsule's bottom and top both end up.
//   landmarks        the spires. 29 on Simonet, 20 on desert, and they are
//                    colliders too — `colliderInputs` is scatter then
//                    landmarks, in that order, and a sweep without them is
//                    blind to the biggest thing in the environment.
//
// Classic switches props, prop collision AND the crash rule off together, so
// the forest this file builds is by construction the Anniversary one.
//
// ── The gate ──────────────────────────────────────────────────────────────
//
// The height maps and the prop GLBs are gitignored and come from R2, so
// `haveForest` is false on CI. Every read is inside the exported functions and
// never at module scope — `describe.skipIf` skips the TESTS, not the describe
// body (CLAUDE.md), and a `const` up here would throw ENOENT during collection.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import type {
  MeshTransform,
  PropLandmark,
  PropPaletteEntry,
  PropScatter,
} from '@/content/load-environment'
import {
  childMatrixOf,
  drawnBoxOf,
  drawnBoxOfVertices,
  drawnLandmarks,
  FLOATING_METRES,
  instanceMatrixOf,
  landmarkColliderInput,
  landmarkHullPlanes,
  landmarkMatrixOf,
  landmarkTriangles,
  shippedIn2016,
} from '@/game/props/load-props'
import {
  environmentTerrains,
  terrainLocalPosition,
  terrainParams,
} from '@/game/terrain/load-terrain'
import { rotateVec3 } from '@/sim/math/quat'
import type { NoPropVolume } from '@/sim/props/clearing'
import {
  buildPropColliders,
  type PropColliders,
  type PropCollisionSpec,
  type PropPlacementInput,
  type PropShapeDims,
} from '@/sim/props/collision'
import { meshPenetration, meshSignedDistance } from '@/sim/props/landmark-mesh'
import { decodeBase64, expandPlacements } from '@/sim/props/placements'
import { withoutSteep, withoutVolumes } from '@/sim/props/scatter'
import { buildVertexGrid } from '@/sim/terrain/faceted'
import type { HeightField } from '@/sim/terrain/height-field'
import { type ImageData8, importUnityTexture } from '@/sim/terrain/image-sampler'
import { renderSurfaceSlopeAt, snapToRenderSurface } from '@/sim/terrain/surface'
import type { HullSphere } from '@/sim/terrain-collision'
import { decodePngBuffer } from '../../../tools/terrain/png.mjs'
import { environmentJson } from './content'
import { haveMaps, MAPS } from './terrain-field'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const PUBLIC = path.join(ROOT, 'public')

/** The four environments the thirteen missions are flown over. */
export const ENVIRONMENTS = ['simonet', 'kauai', 'desert', 'alpine'] as const

interface EnvJson {
  scatter?: PropScatter[]
  landmarks?: PropLandmark[]
}

const envJson = (name: string): EnvJson => environmentJson<EnvJson>(name)

/**
 * The live landmarks of an environment, in the order `forestFor` appends their
 * colliders — which is `colliderInputs`' order, which is the JSON's.
 *
 * Exported so a caller can line a collider id up with the MESH it was sized
 * from: `forestFor` puts the scatter first and the landmarks last, so landmark
 * `k` of this list is collider `count - length + k`. The pairing is checked by
 * `spire-line-attribution.test.ts` rather than trusted.
 */
export const envLandmarks = (name: string): PropLandmark[] => drawnLandmarksFor(name, null)

/**
 * The landmarks a build of `name` DRAWS, through the renderer's own filter.
 *
 * Not a second implementation of the join: DEV-218a drops a mission prop that is
 * coincident with one the environment already draws, and a harness that
 * concatenated the two lists itself would pair every collider id with the wrong
 * rock the moment that filter did anything. One function, both callers.
 */
export const drawnLandmarksFor = (
  name: string,
  missionProps: readonly PropLandmark[] | null,
): PropLandmark[] => drawnLandmarks(envJson(name), missionProps)

/** Every mesh a full Anniversary build of `name` would load. */
const meshesOf = (name: string): string[] => {
  const e = envJson(name)
  const out: string[] = []
  for (const s of e.scatter ?? []) for (const p of s.palette) if (p.meshAsset) out.push(p.meshAsset)
  for (const l of e.landmarks ?? []) if (l.live === true && l.meshAsset) out.push(l.meshAsset)
  return out
}

/**
 * Cheap existence check at collection time: the maps, plus every mesh of every
 * environment. Reads no pixels and no accessors.
 */
export const haveForest: boolean =
  haveMaps &&
  ENVIRONMENTS.every((e) => meshesOf(e).every((m) => fs.existsSync(path.join(PUBLIC, m))))

/** What one prop GLB carries: the POSITION bounds, the mesh node's own matrix. */
export interface GlbShape {
  readonly min: THREE.Vector3
  readonly max: THREE.Vector3
  readonly node: THREE.Matrix4 | null
  /**
   * Every POSITION vertex, xyz interleaved — the mesh itself, not a box round
   * it. `load-props.ts` sizes a collider off the BOX (eight corners through the
   * instance matrix), so anything measured from these is a fact the collider
   * builder never consulted, which is what makes it usable as a check on it.
   * Read lazily: the bounds are enough for most callers and this is ~3,000
   * vertices a spire.
   */
  verts(): Float32Array
  /**
   * The index into {@link verts}, or null for a mesh drawn without one —
   * DEV-345's triangles need it, because `load-props.ts` builds them off
   * `geometry.getIndex()` and a harness that guessed the topology would be a
   * second opinion about which corners make a triangle.
   */
  indices(): Uint32Array | null
}

/** glTF POSITION bounds and the mesh node's own matrix, straight off the file. */
const glbBounds = (file: string): GlbShape => {
  const buf = fs.readFileSync(file)
  const jsonLength = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8')) as {
    nodes?: {
      mesh?: number
      translation?: number[]
      rotation?: number[]
      scale?: number[]
      matrix?: number[]
    }[]
    meshes?: { primitives: { attributes: { POSITION: number }; indices?: number }[] }[]
    accessors: {
      min?: number[]
      max?: number[]
      count: number
      bufferView: number
      byteOffset?: number
      componentType?: number
    }[]
    bufferViews: { byteOffset?: number; byteStride?: number }[]
  }
  const min = new THREE.Vector3(Infinity, Infinity, Infinity)
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  let node: THREE.Matrix4 | null = null
  const positionAccessors: number[] = []
  const indexAccessors: (number | undefined)[] = []
  for (const n of json.nodes ?? []) {
    if (n.mesh === undefined) continue
    const mesh = json.meshes?.[n.mesh]
    for (const prim of mesh?.primitives ?? []) {
      positionAccessors.push(prim.attributes.POSITION)
      indexAccessors.push(prim.indices)
      const a = json.accessors[prim.attributes.POSITION]
      if (!a?.min || !a.max) continue
      min.min(new THREE.Vector3(...(a.min as [number, number, number])))
      max.max(new THREE.Vector3(...(a.max as [number, number, number])))
    }
    if (n.matrix) node = new THREE.Matrix4().fromArray(n.matrix)
    else if (n.translation || n.rotation || n.scale) {
      node = new THREE.Matrix4().compose(
        new THREE.Vector3(...((n.translation ?? [0, 0, 0]) as [number, number, number])),
        new THREE.Quaternion(...((n.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])),
        new THREE.Vector3(...((n.scale ?? [1, 1, 1]) as [number, number, number])),
      )
    }
  }
  const verts = (): Float32Array => {
    // Second GLB chunk is BIN; its header is 8 bytes.
    const binOffset = 20 + jsonLength
    const bin = buf.subarray(binOffset + 8, binOffset + 8 + buf.readUInt32LE(binOffset))
    const out: number[] = []
    for (const ai of positionAccessors) {
      const a = json.accessors[ai] as { count: number; bufferView: number; byteOffset?: number }
      const view = json.bufferViews[a.bufferView] as { byteOffset?: number; byteStride?: number }
      const base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0)
      const stride = view.byteStride ?? 12
      for (let i = 0; i < a.count; i++) {
        const o = base + i * stride
        out.push(bin.readFloatLE(o), bin.readFloatLE(o + 4), bin.readFloatLE(o + 8))
      }
    }
    return new Float32Array(out)
  }
  const indices = (): Uint32Array | null => {
    if (indexAccessors.every((a) => a === undefined)) return null
    const binOffset = 20 + jsonLength
    const bin = buf.subarray(binOffset + 8, binOffset + 8 + buf.readUInt32LE(binOffset))
    const out: number[] = []
    let base = 0
    positionAccessors.forEach((pa, p) => {
      const count = (json.accessors[pa] as { count: number }).count
      const ia = indexAccessors[p]
      if (ia === undefined) {
        for (let i = 0; i < count; i++) out.push(base + i)
      } else {
        const a = json.accessors[ia] as {
          count: number
          bufferView: number
          byteOffset?: number
          componentType?: number
        }
        const view = json.bufferViews[a.bufferView] as { byteOffset?: number }
        const o = (view.byteOffset ?? 0) + (a.byteOffset ?? 0)
        // 5121 UNSIGNED_BYTE, 5123 UNSIGNED_SHORT, 5125 UNSIGNED_INT.
        const width = a.componentType === 5125 ? 4 : a.componentType === 5123 ? 2 : 1
        for (let i = 0; i < a.count; i++) {
          const at = o + i * width
          out.push(
            base +
              (width === 4
                ? bin.readUInt32LE(at)
                : width === 2
                  ? bin.readUInt16LE(at)
                  : bin.readUInt8(at)),
          )
        }
      }
      base += count
    })
    return new Uint32Array(out)
  }
  return { min, max, node, verts, indices }
}

/** The GLB under `public/` for one asset path, as `forestFor` reads it. */
export const glbShapeOf = (asset: string): GlbShape => glbBounds(path.join(PUBLIC, asset))

/** One palette entry's DRAWN geometry at scale 1: the collider's dims. */
const dimsAtUnit = (spec: PropPaletteEntry): PropShapeDims => {
  const g = glbBounds(path.join(PUBLIC, spec.meshAsset as string))
  return drawnBoxOf(
    g.min,
    g.max,
    instanceMatrixOf(
      0,
      0,
      0,
      0,
      1,
      childMatrixOf(spec.meshTransform as MeshTransform | null, new THREE.Matrix4()),
      g.node,
      new THREE.Matrix4(),
    ),
  )
}

/** What the preset contributes. Everything else is the environment's own data. */
export interface ForestOptions {
  readonly spec: PropCollisionSpec
  /** `props.scale`, per kind. Anniversary's tree 0.6 / cactus 0.35 (DEV-134). */
  readonly scale?: Readonly<Record<string, unknown>>
  /** `props.unbakedPasses.enabled`. True on Anniversary, which is the only edition that crashes. */
  readonly unbakedPasses?: boolean
  /** `props.groundSnap`: the sink in metres, or null for off. */
  readonly groundSnapSink?: number | null
  /**
   * `props.maxSlope`: the sine of the steepest rendered facet a prop stands on,
   * or null/absent for 2016's forest (DEV-356). A prop it clears is a collider
   * that does not exist, so a sweep that left this out would measure trees the
   * game no longer builds.
   */
  readonly maxSlope?: number | null
  /** `props.landmarks`: the spires are colliders too. */
  readonly landmarks?: boolean
  /**
   * Scenery the MISSION places, on top of the environment's own — DEV-218 /
   * DEV-219. `level.props`, appended exactly the way `load-props.ts` appends
   * it, because a harness that re-derives the join is a second guess at it.
   *
   * Absent is the ten missions that place none, and leaving it absent
   * reproduces every number measured before this option existed.
   */
  readonly missionProps?: readonly PropLandmark[] | null
  /**
   * Ground the scatter leaves alone, in the terrain's MESH space — DEV-287's
   * authored volumes and DEV-345's pad clearings, already resolved, exactly
   * the list `boot/app.ts` hands `loadProps`. Through `sim/props/scatter.ts`'s
   * own `withoutVolumes`, at the point `load-props.ts` applies it: after the
   * expansion, before the snap and the colliders.
   *
   * Absent removes nothing, which reproduces every number measured before
   * this option existed.
   */
  readonly noPropVolumes?: readonly NoPropVolume[]
}

/** Decoding a 969 KB PNG and a dozen GLBs adds up; thirteen missions share four environments. */
const cache = new Map<string, PropColliders>()

/**
 * The environment's colliders in SIM space, built the way `boot/app.ts` builds
 * them. `field` supplies the terrain origin — pass the MISSION's own, because
 * `worldOffset` moves it.
 */
export const forestFor = (
  environment: string,
  field: HeightField,
  options: ForestOptions,
): PropColliders => {
  const key =
    `${environment}|${field.originX},${field.originY},${field.originZ}` +
    `|${options.spec.radiusFraction}|${options.spec.cellMetres}` +
    `|${JSON.stringify(options.scale ?? {})}|${options.unbakedPasses !== false}` +
    `|${options.groundSnapSink ?? 'off'}|${options.maxSlope ?? 'any'}|${options.landmarks !== false}` +
    `|${(options.missionProps ?? []).map((p) => `${p.path ?? p.name}@${(p.position ?? []).join(',')}`).join(';')}` +
    `|${(options.noPropVolumes ?? []).map((v) => `${v.x},${v.z},${v.radius},${v.x2 ?? ''},${v.z2 ?? ''}`).join(';')}`
  const hit = cache.get(key)
  if (hit) return hit

  const env = envJson(environment)
  const land = environmentTerrains(environment).land
  const params = terrainParams(land)
  const img = decodePngBuffer(
    fs.readFileSync(path.join(ROOT, MAPS[environment] as string)),
    environment,
  ) as ImageData8
  const heightMap = importUnityTexture(img)
  const terrain = {
    terrainSize: params.terrainSize,
    terrainHeight: params.terrainHeight,
    chunkSize: params.chunkSize,
  }
  const grid =
    options.groundSnapSink === null && options.maxSlope == null
      ? null
      : buildVertexGrid(heightMap, params)

  const inputs: PropPlacementInput[] = []
  const passes = (env.scatter ?? []).filter(
    (s) => options.unbakedPasses !== false || shippedIn2016(s),
  )
  for (const s of passes) {
    const expanded = expandPlacements(
      decodeBase64(s.placements.data),
      { width: s.placements.mapWidth, height: s.placements.mapHeight },
      heightMap,
      terrain,
      {
        probabilityScale: s.probabilityScale,
        heightOffset: s.heightOffset,
        scaleMin: s.scaleMin,
        scaleMax: s.scaleMax,
        paletteSize: s.palette.length,
        seed: s.placements.seed,
      },
    )
    // DEV-287 / DEV-345: the cleared ground, where `load-props.ts` clears it —
    // before the snap, so a removed prop never reaches a collider.
    const { props: unvolumed } = withoutVolumes(expanded, options.noPropVolumes ?? [])
    // DEV-356, where `load-props.ts` has it: after the volumes and before the
    // snap, so a prop on a facet over the limit never becomes a capsule. The
    // game's order, volumes then slope — the two never share a prop either way,
    // but the receipts are counted in this order.
    const maxSlope = options.maxSlope
    const placed =
      grid && maxSlope != null
        ? withoutSteep(unvolumed, maxSlope, (x, z) =>
            renderSurfaceSlopeAt(grid, heightMap, params, x, z),
          ).props
        : unvolumed
    // DEV-134, and it is a COLLIDER change as much as a render one: the snap
    // rewrites `placed.positions` in place, which is what the capsule's bottom
    // and top are measured from.
    if (grid && options.groundSnapSink != null) {
      snapToRenderSurface(
        placed.positions,
        placed.count,
        grid,
        heightMap,
        params,
        options.groundSnapSink,
        FLOATING_METRES,
      )
    }
    const dims = s.palette.map(dimsAtUnit)
    for (let i = 0; i < placed.count; i++) {
      const pal = placed.palette[i] as number
      const entry = s.palette[pal]
      if (!entry?.meshAsset) continue
      const kindScaleRaw = options.scale?.[entry.kind ?? '']
      const kindScale = typeof kindScaleRaw === 'number' ? kindScaleRaw : 1
      inputs.push({
        x: placed.positions[i * 3] as number,
        y: placed.positions[i * 3 + 1] as number,
        z: placed.positions[i * 3 + 2] as number,
        scale: (placed.scale[i] as number) * kindScale,
        dims: dims[pal] as PropShapeDims,
        kind: entry.kind ?? 'prop',
      })
    }
  }

  // The landmarks, after the scatter, exactly as `colliderInputs` orders them.
  // Through `load-props.ts`'s own `landmarkColliderInput`, not a second copy of
  // it: this helper used to hold a transcription, and a transcription is where
  // DEV-187's axis bug would have been fixed in the game and left in the
  // harness — a sweep then measures a forest nobody flies.
  if (options.landmarks !== false) {
    const local = terrainLocalPosition(land)
    const out = new THREE.Matrix4()
    for (const l of drawnLandmarks(env, options.missionProps ?? null)) {
      // `drawnLandmarks` has already filtered on it; the type cannot say so.
      const g = glbBounds(path.join(PUBLIC, l.meshAsset as string))
      // No `g.node` — DEV-196 took the argument away. While this helper and the
      // renderer both composed the GLB node's own translation, every spire
      // collider stood 238-684 m from the rock it belongs to, and so did the
      // rock: the two agreed, which is why a harness that mirrors the renderer
      // is worth having and is not by itself evidence.
      landmarkMatrixOf(l, local, out)
      // Off the VERTICES, as `load-props.ts` does for a landmark: under an
      // authored rotation the box round the mesh's box is up to 1.58x the box
      // round the mesh, and that difference is 56 m of solid air under a spire.
      const positions = new THREE.BufferAttribute(g.verts(), 3)
      const index = g.indices()
      inputs.push(
        landmarkColliderInput(
          l,
          drawnBoxOfVertices(positions, out),
          out,
          // DEV-213: the SHAPE, and through `load-props.ts`'s own function for
          // the reason the line above already exists — a transcription is
          // where a fix lands in the game and not in the harness.
          landmarkHullPlanes(positions, out),
          // DEV-345: the rock behind the hull, the same way.
          landmarkTriangles(positions, index ? new THREE.BufferAttribute(index, 1) : null, out),
        ),
      )
    }
  }

  const built = buildPropColliders(
    inputs,
    { x: field.originX, y: field.originY, z: field.originZ },
    options.spec,
  )
  cache.set(key, built)
  return built
}

/**
 * `max(n·p - d)` over a convex hull's planes: <= 0 is inside. DEV-213.
 *
 * The same arithmetic `sim/props/collision.ts` runs, spelled here so the
 * brute-force oracle differs from the hash in exactly ONE thing — which
 * colliders it looks at.
 */
const bruteHullGap = (planes: Float32Array, px: number, py: number, pz: number): number => {
  let worst = Number.NEGATIVE_INFINITY
  for (let i = 0; i < planes.length; i += 4) {
    const g =
      (planes[i] as number) * px +
      (planes[i + 1] as number) * py +
      (planes[i + 2] as number) * pz -
      (planes[i + 3] as number)
    if (g > worst) worst = g
  }
  return worst
}

/**
 * The SIGNED gap between a ship's hull centred at `p` and the nearest STANDING
 * prop: negative is inside one, and its magnitude is the depenetration
 * `stepPropCollision` would apply.
 *
 * The hull offsets are taken unrotated. A crash reset is level and yaw-only and
 * the five spheres are within 1.6 m of the origin, so this is a bound, not the
 * pose — a caller that needs the pose steps the real contact.
 */
export const gapToProps = (
  p: { readonly x: number; readonly y: number; readonly z: number },
  hull: readonly HullSphere[],
  props: PropColliders,
): { gap: number; id: number } => {
  let best = Number.POSITIVE_INFINITY
  let bestId = -1
  for (const sphere of hull) {
    const px = p.x + sphere.x
    const py = p.y + sphere.y
    const pz = p.z + sphere.z
    for (let id = 0; id < props.count; id++) {
      if (props.broken[id]) continue
      if (py + sphere.radius < (props.bottom[id] as number)) continue
      if (py - sphere.radius > (props.top[id] as number)) continue
      const d = Math.hypot(px - (props.x[id] as number), pz - (props.z[id] as number))
      const planes = props.hulls.get(id)
      const mesh = props.meshes.get(id)
      let g = planes
        ? bruteHullGap(planes, px, py, pz) - sphere.radius
        : d - (props.radius[id] as number) - sphere.radius
      // DEV-345: inside the hull, the rock decides. Outside it the hull's gap
      // is a true lower bound on the rock's, which is all a "nearest" needs.
      if (mesh && g <= 0) g = meshSignedDistance(mesh, px, py, pz) - sphere.radius
      if (g < best) {
        best = g
        bestId = id
      }
    }
  }
  return { gap: best, id: bestId }
}

/**
 * `propPenetrationAt` with the spatial hash taken out — every collider, tested.
 *
 * THE ORACLE for DEV-187. The hash is a device of the port's own, and a test
 * that asks it whether it found everything gets the same answer whatever it
 * missed: for four sessions every prop-collision test agreed with a structure
 * that could not reach seventeen of its own colliders, because they all asked
 * the structure. This asks the DATA — it walks `props.count` and consults
 * neither `cells` nor `oversized` — so the two disagree exactly where the hash
 * is incomplete, which is the case CLAUDE.md's agreement lesson says to test.
 *
 * Everything else is the same arithmetic, deliberately: the same `rotateVec3`,
 * the same broken skip, the same vertical span reject, the same
 * `radius + sphere.radius - distance`. The ONE difference is which colliders
 * get looked at, so a disagreement can only be about reach.
 */
export const propPenetrationBrute = (
  position: { readonly x: number; readonly y: number; readonly z: number },
  orientation: { readonly x: number; readonly y: number; readonly z: number; readonly w: number },
  hull: readonly HullSphere[],
  props: PropColliders,
): number => {
  let worst = 0
  const local = { x: 0, y: 0, z: 0 }
  const world = { x: 0, y: 0, z: 0 }
  for (const sphere of hull) {
    local.x = sphere.x
    local.y = sphere.y
    local.z = sphere.z
    rotateVec3(world, orientation, local)
    const px = position.x + world.x
    const py = position.y + world.y
    const pz = position.z + world.z
    for (let id = 0; id < props.count; id++) {
      if (props.broken[id]) continue
      if (py + sphere.radius < (props.bottom[id] as number)) continue
      if (py - sphere.radius > (props.top[id] as number)) continue
      const ox = px - (props.x[id] as number)
      const oz = pz - (props.z[id] as number)
      let penetration = (props.radius[id] as number) + sphere.radius - Math.hypot(ox, oz)
      if (penetration <= 0) continue
      // DEV-213: a hull collider is decided by its planes, and the oracle has
      // to know the same shape or it stops being about REACH. DEV-345: and
      // where the planes say inside, by the rock — through the sim's own
      // `meshPenetration`, so that too differs only in which colliders it sees.
      const planes = props.hulls.get(id)
      if (planes) penetration = sphere.radius - bruteHullGap(planes, px, py, pz)
      const mesh = props.meshes.get(id)
      if (mesh && penetration > 0) penetration = meshPenetration(mesh, px, py, pz, sphere.radius)
      if (penetration > worst) worst = penetration
    }
  }
  return worst
}

/** The ids the brute-force sweep says are in contact at this pose, sorted. */
export const propContactsBrute = (
  position: { readonly x: number; readonly y: number; readonly z: number },
  orientation: { readonly x: number; readonly y: number; readonly z: number; readonly w: number },
  hull: readonly HullSphere[],
  props: PropColliders,
): number[] => {
  const out = new Set<number>()
  const local = { x: 0, y: 0, z: 0 }
  const world = { x: 0, y: 0, z: 0 }
  for (const sphere of hull) {
    local.x = sphere.x
    local.y = sphere.y
    local.z = sphere.z
    rotateVec3(world, orientation, local)
    const px = position.x + world.x
    const py = position.y + world.y
    const pz = position.z + world.z
    for (let id = 0; id < props.count; id++) {
      if (props.broken[id]) continue
      if (py + sphere.radius < (props.bottom[id] as number)) continue
      if (py - sphere.radius > (props.top[id] as number)) continue
      const ox = px - (props.x[id] as number)
      const oz = pz - (props.z[id] as number)
      if ((props.radius[id] as number) + sphere.radius - Math.hypot(ox, oz) <= 0) continue
      const planes = props.hulls.get(id)
      if (planes && sphere.radius - bruteHullGap(planes, px, py, pz) <= 0) continue
      const mesh = props.meshes.get(id)
      if (mesh && meshPenetration(mesh, px, py, pz, sphere.radius) <= 0) continue
      out.add(id)
    }
  }
  return [...out].sort((a, b) => a - b)
}

/** `radius` / `top - bottom` / count, for a row in a ledger table. */
export const forestShape = (
  props: PropColliders,
): { count: number; maxRadius: number; maxHeight: number; medianHeight: number } => {
  let maxRadius = 0
  let maxHeight = 0
  const heights: number[] = []
  for (let i = 0; i < props.count; i++) {
    maxRadius = Math.max(maxRadius, props.radius[i] as number)
    const h = (props.top[i] as number) - (props.bottom[i] as number)
    maxHeight = Math.max(maxHeight, h)
    heights.push(h)
  }
  heights.sort((a, b) => a - b)
  return {
    count: props.count,
    maxRadius,
    maxHeight,
    medianHeight: heights[Math.floor(heights.length / 2)] ?? 0,
  }
}
