// src/game/clouds.ts: the environment's clouds, placed.
//
// `sim/clouds.ts` makes the geometry; this puts it where 2016 put it and gives
// it a material. The split is the terrain's: the generator is pure and headless
// and knows nothing about three, and the assembly lives here.
//
// ── A variant pool, instanced (DEV-785) ──────────────────────────────────
//
// Matt, 2026-10-07 ("Variant pool"). This header used to argue AGAINST
// instancing, and the argument was right about the naive version: only three
// SHAPES come across, so nineteen instances of three meshes read as the same
// cloud three times over, and a cloud is exactly the kind of thing the eye
// catches repeating. The pool is the answer to that argument:
//
//  * a POOL of unique blobs is generated, as many as the edition's `poolSize`
//    allows, shared out over the shapes by what the placements ask for
//    (`game/cloud-pool.ts` has the plan and the argument);
//  * each pool member is ONE `InstancedMesh`, so the sky is at most `poolSize`
//    draws however many clouds the level places, and it can grow past 19;
//  * a placement that owns its member keeps the blob it always had (the seed is
//    still its own index); only a placement that has to SHARE one is different,
//    and it is tinted a little so the repeat is a different value.
//
// The authored placement is the instance matrix, untouched: position,
// rotation and scale are 2016's, composed exactly as `Object3D.updateMatrix`
// composed them for the per-placement mesh. Instancing changes which geometry a
// placement uses and how it is submitted, and nothing else.
//
// ── The material is 2016's, minus the texture ────────────────────────────
//
// `GL-Tex-01.mat`: `_Color` (0.993, 0.883, 0.883): a warm near-white with the
// faintest pink, which is the sunset leaning on them, `_SpecColor` (0.816,
// 0.739, 0.642), `_SpecInt` 0.1, `_Shininess` 2.54. Those numbers are the
// authored LOOK and they carry across; `_MainTex` is a bought texture and does
// not, which costs nothing here because a faceted cloud is flat colour anyway.

import * as THREE from 'three'
import type { CloudPlacement, SunLight } from '@/content/level-schema'
import { type CloudPoolMember, planCloudPool } from '@/game/cloud-pool'
import type { EditionState } from '@/game/edition'
import {
  applyCloudLook,
  attachEditionClouds,
  CLOUD_DRIFT_OFF,
  CLOUD_PLACEMENT_OFF,
  type CloudDriftSettings,
  type CloudPlacementSettings,
  type CloudTuning,
  cloudDriftOffset,
  cloudDriftSettings,
  cloudLookSettings,
  cloudLookUniforms,
  cloudMaterialSide,
  cloudPlacementSettings,
  writeCloudLookUniforms,
} from '@/render/cloud-look'
import { srgbToLinear } from '@/render/unity-space'
import { generateCloud, insideCloudHull } from '@/sim/clouds'

/**
 * `GL-Tex-01.mat`'s `_Color`, sRGB.
 *
 * Hand-carried rather than extracted: the material belongs to a bought pack we
 * do not ship, and putting its path in `required-assets.json` to read three
 * numbers would claim an asset dependency the build does not have. The numbers
 * are in the commit message and in `docs/DEVIATIONS.md`.
 */
const CLOUD_COLOR = [0.99264705, 0.8831639, 0.8831639] as const
/** `_Shininess` 2.54 on Marmoset's 2..8 sharpness scale. */
const CLOUD_SHININESS = 2.54
/**
 * FF2's own: how much of the cloud's own colour survives facing away from the sun.
 *
 * The SHIPPED value, and therefore Classic's: `content/editions/classic.json`
 * carries 0.22 as its identity and the Anniversary preset lifts it (DEV-090).
 * It stays here rather than moving wholly into the presets because it is a
 * 2016-era deviation of its own (DEV-028) and a cloud field built with no
 * edition at all (which is what `tests/unit/clouds.test.ts` builds) has to
 * render what the port has always rendered.
 */
const CLOUD_EMISSIVE = 0.22
/**
 * A pool member's blob is generated from its OWNER placement's index plus this,
 * which is the seed the per-placement mesh used before the pool (DEV-785), so a
 * placement that does not share keeps the cloud it had.
 */
export const CLOUD_SEED_BASE = 0x1d0c

/**
 * What the pool is built from. Both numbers are the edition's
 * (`render.clouds.poolSize`, `render.clouds.tintSpread`) and both are read when
 * the sky is BUILT: a pool is geometry, so unlike the look uniforms it is not
 * pushed again on a preset flip.
 */
export interface CloudPoolTuning {
  /** The TOTAL number of unique blobs the sky may build. */
  readonly poolSize: number
  /** How far a sharing placement's value may stray from the authored colour, 0..1. */
  readonly tintSpread: number
}

/** One member of the pool as built: its draw, its blob, and who it draws. */
export interface CloudPoolDraw {
  readonly mesh: THREE.InstancedMesh
  readonly shape: CloudPoolMember['shape']
  /** Indices into the `placements` array this draw's instances are, in slot order. */
  readonly users: readonly number[]
}

export interface LoadedClouds {
  readonly group: THREE.Group
  readonly count: number
  /**
   * One frame, RENDER clock: wall time, like the waves and DEV-089's flocks.
   *
   * Drift only. Costs nothing on Classic (`speed` 0 returns early) and one
   * matrix write per placement on Anniversary, which is why `matrixAutoUpdate`
   * can stay off: the instance matrices are written when something moves.
   */
  /**
   * Is the eye inside any cloud's hull? DEV-277.
   *
   * WORLD space in, and the test runs in each placement's LOCAL frame so the
   * authored flattening (y is 40-50 % of x) is respected; see the body. A
   * bounding sphere is generous against a lobed blob, so this says yes slightly
   * before the white shell would fill the view; at 90 m/s that is a frame or
   * two, and erring early is the right way round for an effect whose whole
   * point is arriving on time.
   */
  insideCloud(eye: THREE.Vector3): boolean
  update(seconds: number): void
  /**
   * Push a preset block, or `null` for Classic. DEV-090.
   *
   * Exposed for two callers and no others: `attachEditionClouds`, which is wired
   * to the live preset inside `loadClouds`, and the lookdev panel, which needs to
   * move one number without going through `content/`. Everything it writes is a
   * uniform or a matrix, so there is no recompile and no rebuild.
   */
  setCloudLook(tuning: CloudTuning | null): void
  /**
   * DEV-585: each cloud's authored placement and its unit blob's triangle
   * soup, for `render/cloud-shadow.ts`'s raster. One entry per PLACEMENT, in
   * placement order, and the soup is the one its pool member draws (the same
   * soup the whiteout's hull test reads; nothing is copied).
   */
  readonly hulls: readonly {
    readonly placement: CloudPlacement
    readonly positions: Float32Array
  }[]
  /** DEV-585: the scale and lift in force right now (Classic's identity, or the preset's). */
  readonly placementInForce: CloudPlacementSettings
  /** DEV-585: where the wind has got to, metres, three space. Zeroes on a still sky. */
  readonly driftInForce: readonly [number, number, number]
  /** DEV-785: the pool, one draw per member. `group.children` are these meshes. */
  readonly pool: readonly CloudPoolDraw[]
  /**
   * DEV-785: placement `index`'s instance matrix as it stands in its member's
   * buffer (what the GPU is handed), written into `out`. Placement order.
   */
  matrixOf(index: number, out: THREE.Matrix4): THREE.Matrix4
  dispose(): void
}

/** What `loadClouds` needs beyond the placements. Everything here is optional. */
export interface LoadCloudsOptions {
  /** The live preset. Absent means Classic's numbers and no subscription. */
  readonly edition?: EditionState
  /**
   * The MISSION's sun: `level.lighting.sun`.
   *
   * Per-mission, not per-environment: `LevelArt_<env>.prefab`'s own directional
   * light is `m_IsActive: 0` and each mission scene carries its own copy
   * pointing somewhere else (CLAUDE.md). `int_01_hoverJet` is lit from 4 degrees
   * above the horizon, which is the whole reason a cloud needs a wrap at all.
   */
  readonly sun?: SunLight | null
  /**
   * The pool, when the caller wants to say so itself. Absent, it is the
   * edition's, and with no edition either it is "no sharing": one member per
   * placement and no tint, which is the sky the port drew before the pool.
   */
  readonly pool?: CloudPoolTuning
}

/**
 * A cloud is lit, but barely.
 *
 * `_SpecInt` is 0.1 and `_Shininess` 2.54, the softest end of Marmoset's
 * scale, so this is a diffuse body with a hint of sheen, not a glossy one.
 * Opaque: `GL-Tex-01` carries no `_ALPHABLEND_ON` and `_Color`'s alpha is 1, so
 * there is no fade to reproduce.
 *
 * `DoubleSide` because a lobed blob at a grazing angle shows its far side
 * through the gaps between knots, and a missing back face there reads as a hole
 * punched in the cloud.
 */
const cloudMaterial = (): THREE.MeshStandardMaterial => {
  const linear = (c: readonly number[]) =>
    new THREE.Color(
      srgbToLinear(c[0] as number),
      srgbToLinear(c[1] as number),
      srgbToLinear(c[2] as number),
    )
  return new THREE.MeshStandardMaterial({
    color: linear(CLOUD_COLOR),
    // ── the lift, which is FF2's own and not 2016's ────────────────────
    //
    // `int_01`'s sun is 4 degrees above the horizon, so a body this round has
    // most of itself facing away from it, and a purely lit cloud comes out with
    // a near-black underside. That reads as STONE: the first pass looked like
    // a row of floating boulders, and the give-away was that it looked exactly
    // like the terrain, which is lit by the same sun and is the same colour.
    //
    // Real cloud undersides are not black because light scatters through them.
    // Reproducing that properly is volumetrics; the stylised answer, which is
    // what every low-poly sky does, is a flat emissive floor. 0.22 is enough to
    // read as translucent and not enough to glow at dusk. A DEVIATIONS row.
    emissive: linear(CLOUD_COLOR),
    emissiveIntensity: CLOUD_EMISSIVE,
    // Marmoset's 2..8 sharpness, the same mapping the gates and terrain use.
    roughness: Math.min(1, Math.max(0.04, 1 - CLOUD_SHININESS / 10)),
    metalness: 0,
    side: THREE.DoubleSide,
    flatShading: false, // the normals are already per-face; this would re-derive them
  })
  // `_SpecColor` (0.816, 0.739, 0.642) is NOT reproduced. A
  // `MeshStandardMaterial` at metalness 0 has a fixed, uncoloured F0 of 0.04,
  // and `MeshPhysicalMaterial` just to tint a highlight of `_SpecInt` 0.1 is a
  // whole second shader for something at 400 m. Same approximation the terrain
  // and the gates already make; DEV-008 is where the Marmoset specular gets
  // ported properly, for all of them at once.
}

/**
 * Build the environment's clouds from the level's placements.
 *
 * Empty for an environment whose scene instantiates no level-art prefab:
 * Alpine and Kauai both extract to zero, and that is the right answer rather
 * than a reason to invent a sky.
 *
 * With an `edition` it also carries V5 (DEV-090): the look is uniforms on the
 * shared material, the placement is one matrix per cloud, and both are
 * re-applied on a preset flip. Without one it is the Classic field, exactly as
 * before.
 */
/** `insideCloud`'s scratch. Valid inside one synchronous call only (trap 19). */
const cloudLocal = new THREE.Vector3()
const cloudUnrotate = new THREE.Quaternion()
/** `writeMatrices`' scratch, same rule. */
const cloudMatrix = new THREE.Matrix4()
const cloudTint = new THREE.Color()

/** One placement as the field keeps it: the pose it is drawn at and the draw it is drawn by. */
interface PlacedCloud {
  readonly placement: CloudPlacement
  /** The blob's own triangle soup, for the whiteout's hull test (DEV-414). */
  readonly hull: Float32Array
  readonly sphere: THREE.Sphere
  /** The pose, composed from the AUTHORED placement every time (see `writeMatrices`). */
  readonly position: THREE.Vector3
  readonly quaternion: THREE.Quaternion
  readonly scale: THREE.Vector3
  /** The cloud's bounding sphere in WORLD space, rewritten with the matrix; what the draw's own cull reads. */
  readonly bounds: THREE.Sphere
  readonly mesh: THREE.InstancedMesh
  readonly slot: number
}

/** `cullMember`'s scratch. Valid inside one synchronous call only (trap 19). */
const cullFrustum = new THREE.Frustum()
const cullProjection = new THREE.Matrix4()

export const loadClouds = (
  placements: readonly CloudPlacement[],
  options: LoadCloudsOptions = {},
): LoadedClouds => {
  const group = new THREE.Group()
  group.name = 'clouds'
  const material = cloudMaterial()
  const geometries: THREE.BufferGeometry[] = []
  /**
   * 2016's placement, kept, because drift and the lift both compose onto it.
   *
   * Re-deriving a position from the current one would accumulate: a flip during
   * a drifting run would lift a cloud from wherever the wind had left it, and a
   * second flip would lift it again. Compose from the authored value every
   * time; never from the last answer.
   */
  const base: PlacedCloud[] = []

  // ── the Anniversary look (DEV-090) ─────────────────────────────────────
  //
  // Patched BEFORE `fog.applyTo` is called on this material by `boot/app.ts`,
  // which is what puts the fog last in the shader. `applyCloudLook`'s header is
  // the whole argument and the clouds block in `app.ts` repeats the warning.
  const lookUniforms = cloudLookUniforms()
  applyCloudLook(material, lookUniforms)

  let placementSettings: CloudPlacementSettings = CLOUD_PLACEMENT_OFF
  let drift: CloudDriftSettings = CLOUD_DRIFT_OFF
  /** Where the wind has got to, metres. Written by `update`, read by `writeMatrices`. */
  let driftOffset: [number, number, number] = [0, 0, 0]
  /**
   * The render clock at the FIRST update, so elapsed time is this field's own.
   *
   * A course switch no longer reloads the page (DEV-077) and the render clock
   * does not restart with it, so a drift phase taken from the app's clock would
   * put a freshly built sky wherever forty minutes of wind had left the last
   * one. `cloudDriftOffset`'s note says the rest.
   */
  let clockZero: number | null = null

  const pool: CloudPoolDraw[] = []

  const writeMatrices = (): void => {
    const m = placementSettings.scaleMultiplier
    for (const cloud of base) {
      const { placement } = cloud
      cloud.position.set(
        placement.pos[0] + driftOffset[0],
        placement.pos[1] + placementSettings.altitudeLift + driftOffset[1],
        placement.pos[2] + driftOffset[2],
      )
      // All three axes, so the authored flattening (y is 40-50 % of x) survives.
      // Scaling x and z alone would turn a slab into a pancake at 1.35 and
      // `sim/clouds.ts`'s `flatten` note says what that looked like the first
      // time somebody squashed twice.
      cloud.scale.set(placement.scale[0] * m, placement.scale[1] * m, placement.scale[2] * m)
      // `Object3D.updateMatrix`'s own composition: the instance matrix is the
      // matrix the per-placement mesh had.
      cloud.mesh.setMatrixAt(
        cloud.slot,
        cloudMatrix.compose(cloud.position, cloud.quaternion, cloud.scale),
      )
      cloud.bounds.center.copy(cloud.sphere.center).applyMatrix4(cloudMatrix)
      cloud.bounds.radius =
        cloud.sphere.radius * Math.max(cloud.scale.x, cloud.scale.y, cloud.scale.z)
    }
    for (const draw of pool) {
      draw.mesh.instanceMatrix.needsUpdate = true
      // The union of the instances. Three sorts an `InstancedMesh` by this
      // sphere's centre, and `computeBoundingSphere` walks `count` instances, so
      // the count is put back to all of them first: `cullMember` leaves it at 0
      // after a pass that saw none.
      draw.mesh.count = draw.users.length
      draw.mesh.computeBoundingSphere()
    }
  }

  /**
   * One member's own frustum cull, per RENDER PASS. DEV-785.
   *
   * Three culls an `InstancedMesh` by one sphere around ALL its instances, and a
   * member that two far-apart clouds share has a sphere that is in view whenever
   * either is: measured on `int_01`, the first pass of the pool drew nine calls
   * where the nineteen meshes had drawn six or seven. So after three's own test
   * (kept, as the cheap first reject) the member asks the question the old
   * meshes asked, per cloud: is ANY of mine in this camera's frustum? If not, the
   * draw count is 0 and three issues no draw (`WebGLBufferRenderer.
   * renderInstances` returns before it counts one), so a pass calls at most as
   * many members as clouds it can see, which is never more than the nineteen
   * meshes did.
   *
   * Three's test stays ON, and that is measured rather than tidy: with
   * `frustumCulled` false the members are in the render list on every frame, so
   * the material compiled in the first frames of a world, before
   * `scopeWorldPointLights` has patched it, in a mission whose clouds are never in
   * view (`adv_01_jumpSeat`: 97 programs against 96), which is one wasted program
   * and a compile under the curtain.
   *
   * Per PASS and not per frame, in `onBeforeRender`: the sea's mirror and each
   * XR eye are other cameras, and a cloud behind the player is in front of the
   * mirror. `camera` is the one this pass draws with (an XR eye, not the array
   * camera), and an array camera that does reach here is drawn in full.
   */
  const cullMember = (draw: CloudPoolDraw, members: readonly PlacedCloud[]) => {
    return (_renderer: unknown, _scene: unknown, camera: THREE.Camera): void => {
      const mesh = draw.mesh
      if ((camera as THREE.ArrayCamera).isArrayCamera === true) {
        mesh.count = draw.users.length
        return
      }
      cullProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      cullFrustum.setFromProjectionMatrix(
        cullProjection,
        THREE.WebGLCoordinateSystem,
        camera.reversedDepth,
      )
      let seen = false
      for (const cloud of members) {
        if (cullFrustum.intersectsSphere(cloud.bounds)) {
          seen = true
          break
        }
      }
      mesh.count = seen ? draw.users.length : 0
    }
  }

  // ── the pool ────────────────────────────────────────────────────────
  const poolTuning: CloudPoolTuning =
    options.pool ??
    (options.edition
      ? {
          poolSize: options.edition.current.render.clouds.poolSize,
          tintSpread: options.edition.current.render.clouds.tintSpread,
        }
      : { poolSize: placements.length, tintSpread: 0 })
  const plan = planCloudPool(placements, poolTuning.poolSize)
  const placed = new Array<PlacedCloud | undefined>(placements.length).fill(undefined)

  for (const member of plan.members) {
    const owner = placements[member.ownerIndex] as CloudPlacement
    // The owner's seed is the seed the per-placement mesh had, so a placement
    // that does not share is the cloud it always was.
    const blob = generateCloud(member.shape, CLOUD_SEED_BASE + owner.i)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(blob.positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(blob.normals, 3))
    // DEV-277 needs to know when the eye is inside a hull, and the sphere is
    // computed ONCE here rather than per frame. It is a generated blob that never
    // changes shape; only its transform moves.
    geometry.computeBoundingSphere()
    geometries.push(geometry)

    const mesh = new THREE.InstancedMesh(geometry, material, member.users.length)
    mesh.name = `cloud-pool:${member.ownerIndex}`
    // Rewritten whenever the wind moves a cloud.
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // The instances ARE the placements; the mesh itself is the origin.
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    member.users.forEach((placementIndex, slot) => {
      // EVERY member carries an instance colour, so the material compiles one
      // program (USE_INSTANCING_COLOR is in three's cache key and a member
      // without it would be a second variant of every patch on this material).
      // An owner is exactly white, which multiplies the albedo by 1.
      cloudTint.setScalar(1 + poolTuning.tintSpread * (plan.tintOf[placementIndex] as number))
      mesh.setColorAt(slot, cloudTint)
      const placement = placements[placementIndex] as CloudPlacement
      placed[placementIndex] = {
        placement,
        hull: blob.positions,
        sphere: geometry.boundingSphere as THREE.Sphere,
        position: new THREE.Vector3(placement.pos[0], placement.pos[1], placement.pos[2]),
        quaternion: new THREE.Quaternion(
          placement.quat[0],
          placement.quat[1],
          placement.quat[2],
          placement.quat[3],
        ),
        // The generator makes a UNIT blob; all the size is the placement's,
        // which is where the variety lives: 182 m to 893 m across.
        scale: new THREE.Vector3(placement.scale[0], placement.scale[1], placement.scale[2]),
        bounds: new THREE.Sphere(),
        mesh,
        slot,
      }
    })
    group.add(mesh)
    const draw: CloudPoolDraw = { mesh, shape: member.shape, users: member.users }
    pool.push(draw)
    // The member culls itself, per pass and per cloud: see `cullMember`.
    mesh.onBeforeRender = cullMember(
      draw,
      member.users.map((index) => placed[index] as PlacedCloud),
    )
  }
  for (const cloud of placed) if (cloud) base.push(cloud)

  const setCloudLook = (tuning: CloudTuning | null): void => {
    writeCloudLookUniforms(lookUniforms, cloudLookSettings(tuning, options.sun ?? null))
    // The emissive floor is material state rather than a uniform of ours, and
    // Classic's number is the one the port has always used (DEV-028). `null`
    // means the feature is off, which is what makes the preset's own value
    // unobservable on Classic.
    material.emissiveIntensity = tuning === null ? CLOUD_EMISSIVE : tuning.emissive
    // ── DEV-276: which faces a cloud draws ───────────────────────────────
    //
    // Matt, 2026-09-21: *"it'd be nice if ... the cloud geo would be hidden (or
    // at least not double-sided)."* This is the second half of that sentence,
    // and it delivers the first half for free: with the back faces culled, a
    // cloud you are INSIDE draws nothing at all, because every face between you
    // and the world is a back face.
    //
    // `DoubleSide` is not culling by accident. `cloudMaterial`'s note argues for
    // it: *"a lobed blob at a grazing angle shows its far side through the gaps
    // between knots, and a missing back face there reads as a hole punched in
    // the cloud."* That argument is about looking at a cloud from OUTSIDE and it
    // still stands, which is why this is a flag and why Classic keeps the
    // existing answer rather than the one that is probably more faithful.
    //
    // (Probably: Unity's opaque shaders cull back faces by default, so 2016 most
    // likely showed nothing from inside a cloud either. NOT verified: the
    // shader is bought Marmoset art and is not in the project, so the change
    // rests on Matt asking for it, not on a faithfulness claim.)
    //
    // It also halves what the rasteriser does on the clouds, which is worth
    // having on a frame that is 75 % fill.
    material.side = cloudMaterialSide(tuning)
    placementSettings = cloudPlacementSettings(tuning)
    drift = cloudDriftSettings(tuning)
    // ── a still sky must also be an UNMOVED one ──────────────────────────
    //
    // Found by reading this back rather than by a test, which is why it is
    // spelled out. `update` returns early when there is no wind, so without this
    // line a flip from Anniversary to Classic would leave every cloud wherever
    // the Anniversary wind had pushed it, and stay there, because nothing would
    // ever recompute it. Classic's promise is 2016's placements EXACTLY (§3.2
    // V5), and Classic after a flip back should be the game you wore before;
    // a sky four hundred metres downwind is not.
    //
    // Anniversary keeps its offset across a flip, and that is not an
    // inconsistency: the wind is a pure function of the clock, so flipping away
    // and back resumes where the CLOCK says rather than where the flip happened.
    // `clockZero` is untouched by either direction.
    if (!(drift.speed > 0)) driftOffset = [0, 0, 0]
    writeMatrices()
  }

  // With a preset: set it now and again on every flip. Without one, which is
  // what a unit test and any caller that predates V5 hand us, set it OFF once,
  // so the field is explicitly Classic rather than whatever the uniforms happened
  // to be built as.
  let unsubscribe: () => void = () => {}
  if (options.edition) {
    unsubscribe = attachEditionClouds({ setCloudLook }, options.edition)
  } else {
    setCloudLook(null)
  }

  const hulls = base.map(({ placement, hull }) => ({ placement, positions: hull }))

  return {
    group,
    count: placements.length,
    setCloudLook,
    hulls,
    pool,
    get placementInForce() {
      return placementSettings
    },
    get driftInForce() {
      return driftOffset
    },
    matrixOf(index: number, out: THREE.Matrix4): THREE.Matrix4 {
      const cloud = base[index] as PlacedCloud
      return out.fromArray(cloud.mesh.instanceMatrix.array, cloud.slot * 16)
    },
    insideCloud(eye: THREE.Vector3): boolean {
      for (const { position, quaternion, scale, sphere, hull } of base) {
        // ── local space, and why it is not a world-space radius ────────────
        //
        // These hulls are DELIBERATELY flattened -- `sim/clouds.ts` makes y
        // 40-50 % of x, and `scaleMultiplier` scales all three -- so a single
        // world radius is either too big (whiteout before you touch it) or too
        // small (you are inside and nothing happens). Taking the eye into the
        // placement's own frame puts the test where the blob was generated.
        //
        // DEV-414: that frame includes the ROTATION. This used to divide by
        // the scale alone, on the premise that `writeMatrices` sets only
        // position and scale. It does, but every cloud is built with its
        // placement's quaternion (72-124 degrees on `adv_02`) and the matrix
        // composes it. So: translate, un-rotate, unscale, which is the inverse
        // of the T·R·S that `Object3D.updateMatrix` builds. It is still composed
        // from the three fields rather than read off `matrixWorld`, which is
        // stale inside an XR frame callback, and this is called from one.
        cloudLocal.set(eye.x - position.x, eye.y - position.y, eye.z - position.z)
        cloudLocal.applyQuaternion(cloudUnrotate.copy(quaternion).invert())
        cloudLocal.set(cloudLocal.x / scale.x, cloudLocal.y / scale.y, cloudLocal.z / scale.z)
        // The sphere is now only the cheap reject. DEV-414: the whiteout is
        // the HULL you can see, not the sphere around its lobes.
        if (cloudLocal.distanceToSquared(sphere.center) >= sphere.radius * sphere.radius) continue
        if (insideCloudHull(hull, cloudLocal.x, cloudLocal.y, cloudLocal.z)) return true
      }
      return false
    },
    update(seconds: number): void {
      if (!(drift.speed > 0)) return
      if (clockZero === null) clockZero = seconds
      driftOffset = cloudDriftOffset(seconds - clockZero, drift)
      writeMatrices()
    },
    dispose() {
      unsubscribe()
      for (const draw of pool) draw.mesh.dispose()
      for (const g of geometries) g.dispose()
      material.dispose()
      group.clear()
    },
  }
}
