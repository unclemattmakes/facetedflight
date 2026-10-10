// tests/unit/title-placement.test.ts — where the title screen STANDS.
//
// DEV-042 shipped 2016's logo at 2016's framing and got the place wrong twice,
// in the same way both times: it composed the rig against the terrain's LOCAL
// prefab transform while `main_menu.unity` hangs that prefab under two rotated
// parents. The first version was 2,896 m out and was "fixed" with an invented
// centre/corner convention; the second was 1,022 m out and 86.94 degrees off
// bearing, and was propped up by a 410 m lift that made it look fine.
//
// Both survived a full green suite, because everything that was tested was
// tested in the frame that was wrong. So this file tests the two things that
// are true independently of any frame anybody believed in:
//
//   1. the rig's geometry against 2016's own numbers — a RANGE, a RISE and a
//      BEARING between two known landmarks, never a quaternion. CLAUDE.md's
//      orientation lesson: "a distance or an aspect ratio is true independently
//      of what you believed; a quaternion assertion is your belief written
//      twice."
//   2. the rig and 2016's airborne landmarks against the HEIGHT FIELD, which is
//      a completely separate artifact from the transform chain. A wrong frame
//      puts the camera underground and it cannot hide that. Two sets of them,
//      since DEV-215: the 23 the scene authors over the valley (`FLIGHT_PATH`),
//      and the 16 a ship is actually flown through (`WALKED_PATHS`).
//
// ── Why the bearing test pins the ROTATION without asserting one ──────────
//
// `terrainMeshToWorld` maps mesh -> world through the group, so the world
// vector from camera to logo is `R · (logoMesh - cameraMesh)`. 2016 measured
// that vector as **25.797 m out, 4.946 m up, bearing 33.233 deg**, and 2016's
// camera yaw is 33.3461 — the self-check DEV-042 leans on, because 2016 pointed
// the camera at the logo.
//
// Every wrong rotation breaks at least one of those three, and these rows are
// MEASURED off the mutants rather than reasoned about:
//
//   group rotation                range     rise    bearing
//   shipped, 2016's own           25.797    4.946    33.23   <- all three
//   identity (no rotation)        25.244    7.261   119.04   <- all three
//   yaw only, valley levelled     25.244    7.261    33.23   <- range and rise
//
// The last row is the option Matt rejected, and the 2.3 m of rise between it and
// the shipped row IS the 6.671 degree tilt, stated as something you can measure.
//
// **What this does not catch, said out loud.** A levelled valley with the RIG
// re-placed to compensate would hold all three of those numbers, because it
// holds the camera-to-logo relationship by construction; what it changes is the
// backdrop. That difference is 20.3 % of pixels and it is settled by the
// screenshots in DEV-042, not here. A test should say where it stops.
//
// SKIPS without `public/assets/` (gitignored for licensing, `pnpm assets:pull`).

import fs from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { terrainParams } from '@/game/terrain/load-terrain'
import { TERRAIN } from '@/generated/constants.generated'
import { flypastFractions, levelGaze, TITLE_2016, terrainMeshToWorld } from '@/render/title'
import { buildHeightField, terrainHeightAt } from '@/sim/terrain/height-field'
import { type ImageData8, importUnityTexture } from '@/sim/terrain/image-sampler'
import { chunkFootprintDistance, initialLod, lodBands } from '@/sim/terrain/lod'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { appSourceThroughCtx } from './helpers/app-source'

const HEIGHT_MAP = 'public/assets/terrain/alpine/forest_02-height.png'
const AVAILABLE = fs.existsSync(HEIGHT_MAP)

const DEG = 180 / Math.PI

/**
 * The alpine collision surface in the terrain's OWN MESH FRAME.
 *
 * Origin (0, 0, 0) and scale 1 on purpose: the field's coordinates are then the
 * mesh coordinates `TITLE_2016` is expressed in, with no placement arithmetic
 * in between to get wrong. DEV-007's trap still applies — `importUnityTexture`,
 * never the bare sampler, because the map is 1025x1025 with `nPOTScale: 1` and
 * Unity resampled it to 1024 at import.
 */
const meshField = () =>
  buildHeightField(
    importUnityTexture(decodePngBuffer(fs.readFileSync(HEIGHT_MAP)) as ImageData8),
    terrainParams('alpine.forest'),
    { position: [0, 0, 0], scale: [1, 1, 1] },
  )

/**
 * The title valley's group, built exactly as `boot/app.ts` has it.
 *
 * Position from `loadTerrain`'s own rule (`worldOffset + local + envRoot`, with
 * z negated on the way into three) and rotation from the shipped constant. The
 * point of building it rather than stubbing it is that the test then measures
 * the same composition the game does, through the same function.
 */
const TITLE_VALLEY_OFFSET = [30_000, 0, 0] as const
const titleGroup = (): THREE.Group => {
  const t = TERRAIN.alpine.terrains.forest.transform
  const g = new THREE.Group()
  g.position.set(
    TITLE_VALLEY_OFFSET[0] + t.position[0] + t.envRoot[0],
    TITLE_VALLEY_OFFSET[1] + t.position[1] + t.envRoot[1],
    TITLE_VALLEY_OFFSET[2] - (t.position[2] + t.envRoot[2]),
  )
  g.quaternion.fromArray([...TITLE_2016.terrainQuaternion])
  return g
}

/**
 * 23 landmarks `main_menu.unity` authors ABOVE the valley floor.
 *
 * They are the nine control points of the scene's root `Curvy Spline` and the
 * fourteen rings its `SplinePathCloneBuilder` laid along it. **Nothing walks
 * that spline** — DEV-215; the builder is the only reference to it and carries
 * `m_Enabled: 0`. This block used to say "2016's AI racers walk a closed Curvy
 * spline", which is where the port got the idea, and it was wrong for the life
 * of the port.
 *
 * It is still exactly as good for what this file uses it for, and that is worth
 * being clear about rather than quietly deleting: the claim these support is
 * *"an author placed 23 things in the air over this valley"*, and an author
 * placing a course he later switched off placed it in the air just the same. The
 * spline's ENABLEDNESS was never in the argument. What IS in the argument, and
 * is now stronger, is `WALKED_PATHS` below — points a ship actually flies
 * through, which cannot be underground without the ship being underground.
 *
 * Measured through a SECOND code path — `tools/prototype/unity_scene_to_json.js`
 * composing the full parent chain of `main_menu.unity` — rather than by
 * re-running the composition under test. Two independent routes is the point;
 * one route is a belief. Same discipline as `terrain-env-root.test.ts`.
 *
 * UNITY world space, the scene's own frame.
 */
const FLIGHT_PATH: readonly (readonly [number, number, number])[] = [
  [52.6, 150.6, -22.9], // CP000
  [-125.2, 28.4, 48.41681], // CP001
  [-160.7, 2.9, 155.55429], // CP002
  [-162.9, 73.18856, 210.47208], // CP003
  [-103.73591, 19.488068, 329.24777], // CP004
  [22.94049, 30.3961, 354.4131], // CP005
  [225, 97, 409], // CP006
  [199.3, 214, 282], // CP007
  [148.51814, 214.8, 49.309917], // CP008
  [-166.28738, 7.694132, 140.76874], // ring 0003
  [-2.800918, -0.955255, 17.33009], // ring 0000
  [-82.954384, 11.491352, 24.834143], // ring 0001
  [-152.01677, 22.270107, 61.49319], // ring 0002
  [-177.18275, 65.1836, 193.88628], // ring 0005
  [-150.5318, 53.342083, 264.35675], // ring 0006
  [-108.37578, 20.776798, 325.5318], // ring 0007
  [-33.590023, 23.735525, 353.922], // ring 0008
  [46.632057, 28.726768, 348.7197], // ring 0009
  [107.389244, 15.991677, 298.19388], // ring 0010
  [136.79591, 7.498391, 222.78195], // ring 0011
  [153.96315, 2.134377, 143.21019], // ring 0012
  [89.25018, 2.31219, 26.411674], // ring 0013
  [158.81598, 6.499081, 63.086903], // ring 0013b
]

/**
 * The control points of the two splines a SHIP actually walks — DEV-215.
 *
 * `npc_stuff/path_ai_02` (`npc_aiShip`) and `npc_stuff/path_ai`
 * (`npc_aiShip_02`), in Curvy's own order, which is by NAME and not by sibling
 * index (`CurvySpline.cs:1421`). UNITY world space, the same second route as
 * `FLIGHT_PATH`: composed with each spline's own transform, which is why the
 * round numbers in the scene are not the round numbers here.
 *
 * These are the strongest form of the airborne claim this file leans on. A
 * control point of a spline a ship is flown along is in the air because the ship
 * is, and 16 of 16 clear the collision surface in the shipped frame while 13 of
 * 16 are buried in the frame DEV-042 retracted.
 */
const WALKED_PATHS: readonly (readonly (readonly [number, number, number])[])[] = [
  [
    [-77.2, 96.280874, -11.049232], // path_ai_02 CP000
    [-157.2, 1.650874, 120.550768], // CP001
    [-163.7, 73.980874, 261.550768], // CP002
    [-75.8, 178.880874, 451.650768], // CP003
    [107.16068, 121.280874, 486.550768], // CP004
    [214, 366.280874, 143.508918], // CP005
  ],
  [
    [49, 405.426321, -233.341413], // path_ai CP000
    [-119.9, 65.626321, -1.241413], // CP001
    [-167.8, 9.326321, 170.358587], // CP002
    [-242, 93.426321, 279.658587], // CP003
    [-243, 341.426321, 412.658587], // CP004
    [22.94049, 36.822421, 356.071687], // CP005
    [278, 69.426321, 450.658587], // CP006
    [574, 8.770765, 399.658587], // CP007
    [658, 539.426321, 132.658587], // CP008
    [469, 587.426321, -146.341413], // CP009
  ],
]

/** The terrain's own WORLD transform in `main_menu.unity`, same measurement. */
const TERRAIN_WORLD_POS = [2382.7355, -274.397, -2733.9726] as const
/** The LOCAL prefab transform, which is what the retracted frame subtracted. */
const TERRAIN_LOCAL_POS = [-109.919624, 15.881851, 180.85846] as const
/** `TitleScene/Cameras`, world, same measurement. The RAW number behind `cameraMesh`. */
const CAMERA_WORLD_2016 = [-166.1991, 3.5874, 95.3571] as const

/**
 * A 2016 world point into the terrain's mesh frame, through the SHIPPED
 * rotation.
 *
 * `TITLE_2016.terrainQuaternion` is three-space, and the z-mirror that produced
 * it is its own inverse, so mirroring it back gives the Unity rotation the
 * scene actually has. Driving the conversion off the shipped constant is
 * deliberate: change that constant and every clearance below moves, which is
 * how a rotation gets tested by its consequences instead of by restating it.
 */
const worldToMesh = (p: readonly [number, number, number]): THREE.Vector3 => {
  const [x, y, z, w] = TITLE_2016.terrainQuaternion
  const unity = new THREE.Quaternion(-x, -y, z, w)
  return new THREE.Vector3(
    p[0] - TERRAIN_WORLD_POS[0],
    p[1] - TERRAIN_WORLD_POS[1],
    p[2] - TERRAIN_WORLD_POS[2],
  ).applyQuaternion(unity.conjugate())
}

/** The retracted frame: `world - localPrefab`, then the invented +half-map. */
const retractedMesh = (p: readonly [number, number, number]): THREE.Vector3 =>
  new THREE.Vector3(
    2048 + p[0] - TERRAIN_LOCAL_POS[0],
    p[1] - TERRAIN_LOCAL_POS[1],
    2048 + p[2] - TERRAIN_LOCAL_POS[2],
  )

describe.skipIf(!AVAILABLE)('the title rig stands where 2016 stood', () => {
  it('puts the camera 6.17 m above its OWN ground, with nothing to tune', () => {
    const field = meshField()
    const [mx, my, mz] = TITLE_2016.cameraMesh
    const ground = terrainHeightAt(field, mx as number, mz as number)
    const clearance = (my as number) - ground

    // 2016's own number. `TITLE_GROUND_CLEARANCE = 6` used to be an INPUT that
    // rescued a wrong placement; it is an OUTPUT now, and it came out 0.17 m
    // from the value somebody guessed for it. Two routes that never met.
    expect(ground).toBeCloseTo(92.361, 2)
    expect(clearance).toBeCloseTo(6.172, 2)

    // The margin that matters in the picture rather than in the arithmetic: the
    // rendered facets stand proud of the collision field by up to `randomOffset`
    // (0.8 m here), so a camera this close to the surface still has to clear it.
    expect(clearance).toBeGreaterThan(terrainParams('alpine.forest').randomOffset * 2)

    // ── and the same camera in the frame this replaces ──────────────────
    //
    // 409.7 m of solid rock. Worth asserting rather than just remembering,
    // because the clearance above ALONE is a weak test — 2016 stands on a
    // valley floor and a floor is flat, so sliding the camera 50 m sideways
    // barely moves the ground under it. What is not weak is the difference
    // between the two frames, and it is four hundred metres.
    const old = retractedMesh(CAMERA_WORLD_2016)
    const buried = old.y - terrainHeightAt(field, old.x, old.z)
    expect(buried).toBeCloseTo(-409.707, 2)
  })

  it('derives its mesh coordinates from the RAW flattener measurement', () => {
    // `cameraMesh` is a DERIVED number and D10's machine guards nothing it did
    // not read out of the Unity project, so per DEV-027 it needs a test that
    // takes it back to the measurement it came from. Phrased as a distance:
    // the shipped constant and the composed one must be the same POINT.
    const composed = worldToMesh(CAMERA_WORLD_2016)
    const shipped = new THREE.Vector3().fromArray([...TITLE_2016.cameraMesh])
    // 10 mm, and the bound is the ORACLE's precision rather than a shrug: the
    // scene flattener writes quaternion components to 6 dp and the camera is
    // 3,818 m from the terrain's origin, so one ulp of that rounding is 3.8 mm
    // of position. Tightening this below ~4 mm would be asserting more accuracy
    // than the measurement has, which is its own kind of wrong.
    expect(composed.distanceTo(shipped)).toBeLessThan(0.01)
  })

  it('stands the logo clear of the ground it is planted on', () => {
    const field = meshField()
    const [lx, ly, lz] = TITLE_2016.logoMesh
    const clearance = (ly as number) - terrainHeightAt(field, lx as number, lz as number)
    // 2016 hangs the emblem 13.4 m over the floor — it is a monument you look
    // UP at, and the number is worth pinning because a logo that sinks into the
    // hillside is the first thing a wrong frame does to this screen.
    expect(clearance).toBeCloseTo(13.432, 2)
  })

  it('frames the logo at 2016 range, rise and bearing — which pins the rotation', () => {
    const group = titleGroup()
    const eye = terrainMeshToWorld(TITLE_2016.cameraMesh, group)
    const logo = terrainMeshToWorld(TITLE_2016.logoMesh, group)

    const range = Math.hypot(logo.x - eye.x, logo.z - eye.z)
    const rise = logo.y - eye.y
    // Unity's own compass bearing, `atan2(dx, dz)`, read off the rendered
    // vector: the z-mirror means `dz_unity` is `-(logo.z - eye.z)` and x is
    // untouched. Written as the conversion rather than as a remembered sign —
    // the first pass negated the whole thing and produced -33.233, which is the
    // right BEARING reflected, and is exactly the shape of mistake this file is
    // about.
    const bearing = Math.atan2(logo.x - eye.x, -(logo.z - eye.z)) * DEG

    // DEV-042's table: 25.80 m horizontal, 4.95 m up.
    expect(range).toBeCloseTo(25.797, 2)
    expect(rise).toBeCloseTo(4.946, 2)

    // "2016 pointed the camera at the logo": the bearing and the camera's own
    // yaw agree to a ninth of a degree, and that agreement is what proves the
    // whole chain — the modifications, the parents, the rotation and the
    // Unity-to-three flip. It is also what separates this from the two rejected
    // options: unrotated gives 119.04, and a levelled valley moves the RISE to
    // 7.26 m while leaving the bearing alone.
    expect(bearing).toBeCloseTo(33.233, 2)
    expect(Math.abs(bearing - TITLE_2016.cameraYaw)).toBeLessThan(0.2)

    // The tilt, stated as the thing you can see rather than as a quaternion: a
    // levelled valley would put the emblem 7.26 m up instead of 4.95 m, which
    // is 5.2 degrees higher in the frame.
    expect(rise).toBeLessThan(6)
  })

  it('keeps the key light 2016 distance from the emblem', () => {
    const group = titleGroup()
    const logo = terrainMeshToWorld(TITLE_2016.logoMesh, group)
    const spot = terrainMeshToWorld(TITLE_2016.spotMesh, group)
    // DEV-042: "the light sits 22.18 m from the logo with a 37.3 m range". The
    // range is a shipped constant; the distance is geometry, and it has to stay
    // inside the range or the emblem goes dark.
    const d = spot.distanceTo(logo)
    expect(d).toBeCloseTo(22.18, 1)
    expect(d).toBeLessThan(TITLE_2016.spotRange)
  })

  it('flies the WALKED splines through the air, where the retracted frame buries them', () => {
    // The sharpest form of the frame check, and it did not exist until DEV-215
    // found the paths a ship is actually on. These 16 points have a HoverJet
    // flown through them, so "in the air" is not an inference about authoring
    // intent — it is a consequence of the ship not being underground.
    //
    // Measured: 16 of 16 clear the collision surface in the shipped frame, by
    // 6.2 m at the lowest (path_ai_02's CP001, the close pass) and 89 m on
    // average. In the frame DEV-042 retracted, 13 of the 16 are buried and the
    // means are −362 m and −230 m. Unlike `FLIGHT_PATH` below there is no "not
    // all of them" caveat to make, because a ship cannot fly through rock.
    const field = meshField()
    const clearanceIn = (mesh: THREE.Vector3) => mesh.y - terrainHeightAt(field, mesh.x, mesh.z)
    const all = WALKED_PATHS.flat()
    const shipped = all.map((p) => clearanceIn(worldToMesh(p)))
    const retracted = all.map((p) => clearanceIn(retractedMesh(p)))

    expect(all).toHaveLength(16)
    expect(shipped.filter((c) => c > 0)).toHaveLength(16)
    expect(Math.min(...shipped)).toBeGreaterThan(5)
    expect(retracted.filter((c) => c > 0).length).toBeLessThanOrEqual(3)
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
    expect(mean(retracted)).toBeLessThan(-200)
  })

  it("flies 2016's authored spline through the AIR, where the retracted frame buried all of it", () => {
    const field = meshField()
    const clearanceIn = (mesh: THREE.Vector3) => mesh.y - terrainHeightAt(field, mesh.x, mesh.z)

    const shipped = FLIGHT_PATH.map((p) => clearanceIn(worldToMesh(p)))
    const retracted = FLIGHT_PATH.map((p) => clearanceIn(retractedMesh(p)))
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
    const airborne = (a: number[]) => a.filter((c) => c > 0).length

    // 23 landmarks that are in the air by construction, and the two frames
    // disagree about every single one of them. This is the case that makes the
    // rule and its alternative disagree — the thing the agreement lesson says
    // to go and find before believing either.
    expect(airborne(shipped)).toBeGreaterThanOrEqual(15)
    expect(mean(shipped)).toBeGreaterThan(0)
    expect(airborne(retracted)).toBe(0)
    expect(mean(retracted)).toBeLessThan(-300)

    // Not all 23, and that is FAITHFUL rather than sloppy: the far end of the
    // spline runs into the mountains. 2016 ships content inside terrain in
    // several places — DEV-062 found five of kauai's eleven live orbs in there
    // too — so a test demanding 23/23 would be demanding the port be tidier
    // than the game it is porting.
    expect(airborne(shipped)).toBeLessThan(23)
  })
})

/**
 * DEV-068 — the rig is LEVEL, and the emblem sits high in the frame.
 *
 * **Not skipped when the assets are absent**, unlike everything above: nothing
 * here reads the height map. It is the transform chain and the camera frame,
 * both of which exist on a bare clone and on CI.
 *
 * ── What each of these is the angle OF ────────────────────────────────────
 *
 * DEV-027's rule, because "10.86° above centre" was carried out of DEV-042 as a
 * bare number. It is the ELEVATION OF `logo_polys`' TRANSFORM ORIGIN above the
 * horizontal plane through the eye, measured at the eye:
 * `atan(rise / horizontal range)` = `atan(4.94623 / 25.79715)` = 10.8539°. It is
 * not the angle to the emblem's top, it is not measured from the emblem's
 * bounding box, and it is not a pixel offset — an angle is the same at every
 * field of view, and only where it LANDS in the frame changes.
 *
 * The origin happens to be the emblem's geometric centre as well, and that is
 * measured rather than assumed: composing `title-logo.glb`'s node rotations
 * (`logo` +90° about x, each mesh child 180° about x, so `(x, y, z) -> (x, z,
 * -y)`) gives a local box of x [-8.9857, 8.9857], y [-7.5043, 7.3981], z
 * [-0.8248, 0.8248]. The x span is **17.9714 m**, which is the 17.97 m the
 * converter asserts on every run — so the composition is right. The box centre
 * is 0.0531 m BELOW the origin, 0.0435 m at the scene's 0.8184 scale, which at
 * 25.8 m is 0.10° of the 10.85. Origin and visual centre are the same answer.
 */
describe('the title rig is level, and the emblem sits high — DEV-068', () => {
  const DEG_OUT = 180 / Math.PI
  /** 2016's own camera yaw, through `boot/app.ts`'s conversion. */
  const facing = -(TITLE_2016.cameraYaw * Math.PI) / 180
  /** The one expression `title.ts` has for "which way you are facing". */
  const forward = () => new THREE.Vector3(-Math.sin(facing), 0, -Math.cos(facing))

  /**
   * Scaled half-extents of the emblem, from the glb bounds above.
   *
   * Carried here with the measurement written out rather than read off disk,
   * because `public/assets/` is gitignored (licensing, D12) and this block is
   * deliberately the part that still runs without it.
   */
  const EMBLEM_TOP = 7.3981 * TITLE_2016.logoScale
  const EMBLEM_BOTTOM = -7.5043 * TITLE_2016.logoScale
  /** `src/render/renderer.ts` builds the camera at 70° VERTICAL. Half of it. */
  const HALF_FOV_DEG = 35

  const framing = () => {
    const group = titleGroup()
    const eye = terrainMeshToWorld(TITLE_2016.cameraMesh, group)
    const logo = terrainMeshToWorld(TITLE_2016.logoMesh, group)
    const q = levelGaze(forward())
    return { eye, logo, q, to: logo.clone().sub(eye) }
  }

  it('points the rig along 2016 bearing with ZERO pitch and ZERO roll', () => {
    const { q } = framing()
    // Measured off the resulting BASIS, not off the quaternion's components —
    // "a quaternion assertion is your belief written twice" (CLAUDE.md).
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q)

    // Level: the forward axis has no vertical component at all.
    expect(Math.asin(fwd.y) * DEG_OUT).toBeCloseTo(0, 9)
    // Unrolled: the right axis is horizontal, so the horizon is horizontal. A
    // rolled horizon in a headset is worse than a pitched one, and this is the
    // half of the pose nobody had checked — 2016's camera quaternion has x = 0
    // AND z = 0, and both halves of that ship here.
    expect(right.y).toBeCloseTo(0, 9)
    expect(Math.atan2(right.y, up.y) * DEG_OUT).toBeCloseTo(0, 9)

    // And it still faces where 2016 faced. Unity's compass bearing, through the
    // SAME `atan2(dx, -dz)` conversion the range/rise/bearing test uses — the
    // first version of this line wrote `atan2(-dx, dz)`, which is a different
    // quantity that happens to agree on some headings and not this one.
    expect(Math.atan2(fwd.x, -fwd.z) * DEG_OUT).toBeCloseTo(TITLE_2016.cameraYaw, 4)
  })

  it('frames the emblem 10.854° ABOVE centre, which is what 2016 did', () => {
    const { q, to } = framing()
    const inCam = to.clone().applyQuaternion(q.clone().invert())
    const vertical = Math.atan2(inCam.y, -inCam.z) * DEG_OUT
    const horizontal = Math.atan2(inCam.x, -inCam.z) * DEG_OUT

    // THE number, re-derived here rather than inherited: the elevation of the
    // logo's transform origin above a level eye.
    expect(vertical).toBeCloseTo(10.8539, 3)
    // And the same thing stated as the arithmetic it is, so the assertion above
    // cannot quietly become a constant that agrees with itself.
    //
    // To 4 dp and not 9, and the residual is real rather than float noise: the
    // camera-space angle divides by the AXIAL distance `-inCam.z` while the
    // elevation divides by the HORIZONTAL range, and the emblem is 0.1127° off
    // the axis, so the axial distance is shorter by a factor of cos(0.1127°).
    // That is 2.1e-5 degrees. Written down because the first version asserted
    // these were the same number to 9 places and they are not.
    expect(vertical).toBeCloseTo(Math.atan2(to.y, Math.hypot(to.x, to.z)) * DEG_OUT, 4)

    // Horizontally the emblem is 0.11° off the axis, and that residual is
    // 2016's: its camera yaw is 33.3461° while the bearing to its own logo is
    // 33.2334°. A port that centred the emblem horizontally would be tidier
    // than the game. DEV-042 measured this as the 1.19 % of pixels between the
    // preview and the landed build.
    expect(horizontal).toBeCloseTo(-0.1127, 3)
    expect(Math.abs(horizontal)).toBeLessThan(0.2)
  })

  it('changes the pitch by 10.854° and the yaw by 2016 own 0.113°', () => {
    const { eye, logo, q } = framing()
    // The pose this replaces: `lookAt` the emblem. Built here so the change is
    // stated as an angle between two frames — geometry — rather than as a
    // remembered "it used to be pitched".
    const old = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(eye, logo, new THREE.Vector3(0, 1, 0)),
    )
    const oldFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(old)
    const newFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q)

    // The pitch, which is the change everyone means.
    expect(Math.asin(oldFwd.y) * DEG_OUT).toBeCloseTo(10.8539, 3)

    // **And a yaw of 0.1127°, which nobody meant.** This test was first written
    // as "a PITCH change and nothing else" and it went red: `lookAt(logo)`
    // aimed at the BEARING TO THE EMBLEM (33.2334°) rather than at 2016's own
    // CAMERA yaw (33.3461°), so it was quietly centring the emblem horizontally
    // too — tidier than the game, in the same 0.11° DEV-042 measured as the
    // 1.19 % of pixels between its preview and its landed build. Levelling the
    // rig hands that residual back.
    const oldYaw = Math.atan2(oldFwd.x, -oldFwd.z) * DEG_OUT
    const newYaw = Math.atan2(newFwd.x, -newFwd.z) * DEG_OUT
    expect(oldYaw).toBeCloseTo(33.2334, 3)
    expect(newYaw).toBeCloseTo(TITLE_2016.cameraYaw, 4)
    expect(newYaw - oldYaw).toBeCloseTo(0.1127, 3)

    // The two together, as the single angle between the frames. sqrt(10.8539² +
    // (0.1127·cos 10.8539)²) = 10.8545 — so the pitch is 99.99 % of the move.
    expect(q.angleTo(old) * DEG_OUT).toBeCloseTo(10.8545, 3)

    // The old pose was pitched and NOT rolled, so this fixes one axis and must
    // not have introduced the other. Both frames' right vectors are horizontal.
    const oldRight = new THREE.Vector3(1, 0, 0).applyQuaternion(old)
    expect(oldRight.y).toBeCloseTo(0, 9)
  })

  it('still fits the whole emblem in the frame with the rig level', () => {
    const { to } = framing()
    const range = Math.hypot(to.x, to.z)
    const elev = (dy: number) => Math.atan2(dy, range) * DEG_OUT

    // The emblem runs from 2.65° BELOW the level axis to 23.10° above it:
    // 25.75° of vertical subtense, against a 14.708 m width that subtends 31.8°.
    // *"the 3D logo giant out front"* (Matt).
    expect(elev(to.y + EMBLEM_TOP)).toBeCloseTo(23.0951, 3)
    expect(elev(to.y + EMBLEM_BOTTOM)).toBeCloseTo(-2.6529, 3)

    // The claim levelling has to survive: the top of the emblem is still inside
    // the frame. 23.10° against a 35° half-FOV leaves 11.9° of sky above it.
    // **If `renderer.ts`'s 70 changes, this number changes with it** — that
    // coupling is the price of the assertion and it is worth paying, because
    // the failure it guards against is an emblem cropped off the top.
    expect(elev(to.y + EMBLEM_TOP)).toBeLessThan(HALF_FOV_DEG)
  })

  it('puts the prompt below centre rather than at the bottom of the frame', () => {
    const { to } = framing()
    const range = Math.hypot(to.x, to.z)
    // `title.ts` places the plate at `sightPitch - PROMPT_BELOW_SIGHTLINE`, and
    // the sightline is 10.854° above a level axis — so the plate's WORLD
    // position is untouched by DEV-068 and only its place in the picture moves.
    const sightPitch = Math.atan2(to.y, range) * DEG_OUT
    const promptElevation = sightPitch - 17.5
    expect(promptElevation).toBeCloseTo(-6.6461, 3)

    // Stated as the fraction of the lower half-frame it occupies, which is the
    // thing a person actually sees: 20 % down, where it used to be 49 % down.
    const frac = (deg: number) => Math.tan(deg / DEG_OUT) / Math.tan(HALF_FOV_DEG / DEG_OUT)
    expect(Math.abs(frac(promptElevation))).toBeCloseTo(0.1664, 3)
    expect(Math.abs(frac(-19))).toBeCloseTo(0.4918, 3)

    // And it does not collide with the emblem: 3.4° of clear sky between the
    // emblem's bottom edge and the top of the plate (the plate is 0.77 m tall
    // at 10.8 m, so 2.0° of half-angle).
    expect(
      Math.atan2(to.y + EMBLEM_BOTTOM, range) * DEG_OUT - (promptElevation + 2.05),
    ).toBeGreaterThan(1)
  })
})

describe.skipIf(AVAILABLE)('title placement — assets not hydrated', () => {
  it('says so rather than passing silently', () => {
    // A suite that goes quietly green on a machine with no assets is how
    // "nothing has ever been WORN" stayed true for a milestone. Say it.
    expect(AVAILABLE).toBe(false)
  })
})

/**
 * 2016's flypast, and whether you can SEE it — DEV-155, corrected by DEV-215.
 *
 * The bug this exists for is DEV-044's: the title jets flew backwards at four
 * pixels across, through a session of Matt looking at the screen, and every e2e
 * assertion on it was about positions and counts and all of them were correct.
 * *"Too small, too dark, too fast or off-screen has not been reviewed; it has
 * been rendered."* So these are ANGLES — how much of the frame a ship fills and
 * how much of the lap it is in the frame for — which is the claim that was
 * missing, stated in the unit a person perceives.
 *
 * DEV-215 changed WHICH spline and HOW MANY ships, and not one assertion in here
 * had to be weakened to take it: every one is an angle or a distance against the
 * measured camera, so they transferred to the real paths intact. What they could
 * NOT catch is the thing that was wrong — that the path belonged to a
 * `SplineWalker` nobody has. An angle cannot tell you the spline is the wrong
 * object; only the liveness walk can, and that is now `WALKED_PATHS`.
 *
 * No height map needed, so no skip: sixteen measured control points against the
 * measured camera.
 */
describe("the title flypast is 2016's, and it is big enough to see", () => {
  const DEG_OUT = 180 / Math.PI
  /** `renderer.ts`'s flat FOV, and the same 35 the emblem is checked against. */
  const HALF_FOV_DEG = 35
  /** 16:9 at 70 vertical: `atan(tan(35) * 16/9)`. The frame is WIDER than tall. */
  const HALF_FOV_H_DEG = Math.atan(Math.tan(35 / DEG_OUT) * (16 / 9)) * DEG_OUT
  /** `hoverjet-exterior.glb` is 6.8 m nose to tail — the thing being measured. */
  const SHIP_LENGTH = 6.8
  /** 1080p at the shipped 70 deg vertical. DEV-044's four pixels, in degrees. */
  const PX_PER_DEG = 1080 / 70

  /** One lane's curve in the PORT's world frame, and the eye beside it. */
  const laneInWorld = (index: number) => {
    const lane = TITLE_2016.flypaths[index] as (typeof TITLE_2016.flypaths)[number]
    const group = titleGroup()
    const world = (p: readonly number[]) => terrainMeshToWorld(p, group)
    // NOT in the mesh frame: the rotations telescope only for an object's WORLD
    // orientation (`R_group · R⁻¹ · q_2016` collapses to `q_2016`), so the
    // camera's yaw in MESH space is not 33.3461 at all. The first cut of this
    // test assumed it was and reported 4 % of the lap on screen, which is the
    // shape of an azimuth measured in the wrong frame rather than of a flypast.
    const curve = new THREE.CatmullRomCurve3(
      lane.mesh.map((p) => world(p as readonly number[])),
      true,
      'catmullrom',
      0.5,
    )
    const eye = world(TITLE_2016.cameraMesh)
    const facing = -(TITLE_2016.cameraYaw / DEG_OUT)
    const forward = new THREE.Vector3(-Math.sin(facing), 0, -Math.cos(facing))
    // The rig's pose, and its inverse takes a world offset into camera space,
    // where the camera looks along its own −z.
    const toCamera = levelGaze(forward).clone().invert()
    return { lane, curve, eye, toCamera }
  }

  /** Is a world point inside the flat frame? The yardstick, in one place. */
  const inFrame = (p: THREE.Vector3, eye: THREE.Vector3, toCamera: THREE.Quaternion) => {
    const d = p.clone().sub(eye).applyQuaternion(toCamera)
    if (d.z >= 0) return false // behind the eye
    const az = Math.atan2(d.x, -d.z) * DEG_OUT
    const el = Math.atan2(d.y, Math.hypot(d.x, d.z)) * DEG_OUT
    return Math.abs(az) < HALF_FOV_H_DEG && Math.abs(el) < HALF_FOV_DEG
  }

  it('carries the same sixteen control points the scene does, by a second route', () => {
    // `flypaths[*].mesh` was composed by `unity_scene_to_json.js` walking the
    // parent chain; `worldToMesh` above rebuilds the frame from the SHIPPED
    // quaternion and the terrain's world position. Two routes that never met —
    // the same discipline `FLIGHT_PATH` itself is here for, and the assertion
    // that fails if either the constants or the rotation is re-measured wrong.
    expect(TITLE_2016.flypaths).toHaveLength(2)
    expect(TITLE_2016.flypaths.map((l) => l.mesh.length)).toEqual([6, 10])
    for (const [i, lane] of TITLE_2016.flypaths.entries()) {
      const raw = WALKED_PATHS[i] as readonly (readonly [number, number, number])[]
      expect(lane.mesh).toHaveLength(raw.length)
      for (let k = 0; k < raw.length; k++) {
        const mesh = worldToMesh(raw[k] as readonly [number, number, number])
        const shipped = lane.mesh[k] as readonly number[]
        expect(mesh.distanceTo(new THREE.Vector3(...shipped))).toBeLessThan(0.01)
      }
    }
  })

  it('clears the eye at every control point but the close pass, which grazes it', () => {
    // The cheap frame check, and the one that caught DEV-042: in the retracted
    // frame these nodes averaged hundreds of metres UNDERGROUND.
    //
    // NOT "all above the eye" any more, and the exception is a measurement
    // rather than a slackening: `path_ai_02`'s CP001 sits **0.01 m** below the
    // camera in mesh coordinates — 2016 brought the near ship past the player's
    // face at exactly eye height, 6.2 m over the valley floor. `path_ai`'s
    // lowest is 8.3 m up. A wrong frame does not produce a 1 cm graze; it
    // produces 400 m of rock, which the clearance test above is for.
    const eyeY = TITLE_2016.cameraMesh[1] as number
    const rises = TITLE_2016.flypaths.map((lane) => lane.mesh.map((p) => (p[1] as number) - eyeY))
    expect(Math.min(...(rises[0] as number[]))).toBeGreaterThan(-0.05)
    expect(Math.min(...(rises[0] as number[]))).toBeLessThan(0.05)
    expect(Math.min(...(rises[1] as number[]))).toBeGreaterThan(0)
    for (const lane of rises) expect(Math.max(...lane)).toBeGreaterThan(100)
  })

  it.each([
    { index: 0, spline: 'path_ai_02' },
    { index: 1, spline: 'path_ai' },
  ])('comes close enough to read as a jet, and stays in frame — $spline', ({ index }) => {
    // In the PORT's world frame, through the same calls `boot/app.ts` makes,
    // because a frame test wants the frame the player is actually in.
    //
    // Measured, on the yardstick that recorded DEV-155's 65.8 % so the two are
    // comparable numbers rather than two rulers:
    //
    //   path_ai_02   1,703 m   54.7 % of the lap in frame   15.17 m at the pass (25.3 deg)
    //   path_ai      3,574 m   43.0 %                       16.86 m           (22.8 deg)
    //
    // Both are real flypasts: the circuit this replaced held ONE distance for a
    // whole lap, and the version before that put the jets at four pixels
    // (DEV-044). A floor on the ANGLE is the assertion that would have gone red
    // then and did not exist.
    const { curve, eye, toCamera } = laneInWorld(index)
    let nearest = Number.POSITIVE_INFINITY
    let smallestSeen = Number.POSITIVE_INFINITY
    let seen = 0
    const SAMPLES = 2000
    for (let i = 0; i < SAMPLES; i++) {
      const p = curve.getPointAt(i / SAMPLES, new THREE.Vector3())
      const range = p.distanceTo(eye)
      nearest = Math.min(nearest, range)
      if (!inFrame(p, eye, toCamera)) continue
      seen++
      smallestSeen = Math.min(smallestSeen, 2 * Math.atan(SHIP_LENGTH / 2 / range) * DEG_OUT)
    }

    const widest = 2 * Math.atan(SHIP_LENGTH / 2 / nearest) * DEG_OUT
    expect(nearest).toBeLessThan(40)
    expect(nearest).toBeGreaterThan(5)
    expect(widest).toBeGreaterThan(8)
    expect(seen / SAMPLES).toBeGreaterThan(0.35)

    // DEV-044's floor, and the reason the far path is allowed to be long: the
    // smallest either ship ever gets **while it is on screen** is 11.9 px on
    // `path_ai_02` and 6.3 px on `path_ai`, at 1080p. Four is where a thing has
    // been rendered rather than reviewed. Nothing is ever four pixels in shot.
    expect(smallestSeen * PX_PER_DEG).toBeGreaterThan(4)
  })

  it('puts SOMETHING in frame for more of the lap than one ship ever did', () => {
    // The argument for flying both. DEV-155 flew one because two ships on ONE
    // path read nose-to-tail; two ships on TWO paths do not, and measured they
    // are never within **344 m** of one another.
    //
    // At least one in frame **68.4 %** of the lap, both at once **29.3 %** —
    // against **65.8 %** for the single ship on the spline nobody walks. The
    // floor below is under the measurement so a re-measure has room to move.
    const lanes = TITLE_2016.flypaths.map((_, i) => laneInWorld(i))
    const SAMPLES = 2000
    const lap = TITLE_2016.flypathLapSeconds
    let either = 0
    let both = 0
    let closestPair = Number.POSITIVE_INFINITY
    for (let i = 0; i < SAMPLES; i++) {
      const clock = (i / SAMPLES) * lap
      const at = lanes.map(({ lane, curve }) =>
        curve.getPointAt(flypastFractions(clock, lap, lane.initialF).at, new THREE.Vector3()),
      )
      const visible = at.filter((p, k) =>
        inFrame(p, lanes[k]?.eye as THREE.Vector3, lanes[k]?.toCamera as THREE.Quaternion),
      ).length
      if (visible >= 1) either++
      if (visible === 2) both++
      closestPair = Math.min(
        closestPair,
        (at[0] as THREE.Vector3).distanceTo(at[1] as THREE.Vector3),
      )
    }
    expect(either / SAMPLES).toBeGreaterThan(0.6)
    expect(both / SAMPLES).toBeGreaterThan(0.2)
    // The nose-to-tail objection, killed by a number rather than by an opinion.
    expect(closestPair).toBeGreaterThan(200)
  })

  it('takes 2016 own lap time, from a SplineWalker fraction rather than a guess', () => {
    // `Speed: 0.042` with `MoveByWorldUnits: 0` is a fraction of the spline a
    // second, so the lap is its reciprocal. Asserted as the relationship, not
    // as 23.8: the number in the file is the speed.
    //
    // ONE lap time for two ships is only correct because both walkers carry the
    // same `Speed` — 0.042 on `npc_aiShip` and on `npc_aiShip_02`, against
    // 0.0435 and 0.043 on the two `ai_target`s that lead them. That is a fact
    // about the scene and it is why `flypathLapSeconds` is a single constant, so
    // it is asserted rather than left in prose.
    expect(TITLE_2016.flypathLapSeconds * 0.042).toBeCloseTo(1, 9)
    for (const lane of TITLE_2016.flypaths) {
      expect(lane.initialF).toBeGreaterThanOrEqual(0)
      expect(lane.initialF).toBeLessThan(1)
    }
  })
})

/**
 * 2016's OWN LOD LADDER, on the screen that never had one — DEV-282.
 *
 * The valley was built with every one of its 64 chunks at LOD 0: 4,096 m of
 * alpine forest at full facet density, for one camera bolted to the valley
 * floor. That is not what 2016 does. `AlpineTerrain_menu`'s `FacetedTerrain`
 * carries `LODLevels: 3` and `LODDistance: 700` — checked in the prefab AND in
 * `main_menu.unity`'s own inline copy, because a disconnected copy is what the
 * scene actually loads — and `FacetedTerrain.Start()` assigns each chunk its
 * level by distance before the first frame draws. The port's all-LOD-0 build
 * was the deviation; this is the restoration.
 *
 * ── What is actually at risk here, and it is a SIGN ──────────────────────
 *
 * `loadTerrain` takes the eye as `cameraMesh` — a point in the terrain's own
 * mesh frame — and converts it where the group placement is known. That
 * conversion carries the z FLIP `chunkGeometry` applies on the way in
 * (`world.z = position.z - scale.z * mesh.z`), and getting that sign wrong is
 * silent: you still get a plausible ladder, mirrored about the terrain's z
 * axis, with the fine chunks behind the far ridge and the coarse ones under
 * the logo. Nothing in a screenshot of a valley says which.
 *
 * So the assertions are RELATIONSHIPS, not values (the orientation lesson):
 * the chunk the eye stands over is the finest there is, the far corner is the
 * coarsest, and the mirrored point is NOT also fine — which is the one a wrong
 * sign cannot satisfy.
 *
 * Pure arithmetic: `chunkFootprintDistance`, `lodBands` and `initialLod` are
 * the same `src/sim/terrain/lod.ts` functions the loader calls, and the
 * placement comes from the sheet. No assets, no DOM, no renderer.
 */
describe('the title valley builds at 2016’s LOD ladder (DEV-282)', () => {
  const t = TERRAIN.alpine.terrains.forest
  const params = terrainParams('alpine.forest')
  const perSide = params.terrainSize / params.chunkSize

  /** The group's placement BEFORE 2016's rotation — the frame the loader picks chunks in. */
  const placed = () => {
    const g = titleGroup()
    // `chunkFootprintDistance` builds axis-aligned boxes out of position and
    // scale and never consults the quaternion, so this is the frame it measures
    // in whatever the group is rotated to afterwards. See `cameraMesh`'s note.
    return { originX: g.position.x, originZ: g.position.z, scaleX: 1, scaleZ: 1 }
  }

  /** The loader's own conversion, mesh x/z -> the footprint frame. */
  const eyeWorld = (meshX: number, meshZ: number) => {
    const f = placed()
    return [f.originX + f.scaleX * meshX, f.originZ - f.scaleZ * meshZ] as const
  }

  const bands = () => lodBands(t.lodDistance, t.lodLevels, t.flipFlopPercent)

  const lodAt = (cx: number, cy: number, eye: readonly [number, number]) =>
    initialLod(
      bands(),
      chunkFootprintDistance({ ...placed(), chunkSize: params.chunkSize }, cx, cy, eye[0], eye[1]),
    )

  /** Which chunk a mesh point falls in. The mesh frame runs 0..terrainSize. */
  const chunkOf = (meshX: number, meshZ: number) =>
    [Math.floor(meshX / params.chunkSize), Math.floor(meshZ / params.chunkSize)] as const

  it('agrees with `terrainMeshToWorld` on where the eye is, before the rotation', () => {
    // TWO ROUTES to one point. `terrainMeshToWorld` goes through the group's
    // `matrixWorld`; the loader composes from `position` and `scale` directly,
    // because it has to answer before anything is rotated. They must agree on
    // an unrotated group or the loader is picking chunks around somewhere else.
    const g = titleGroup()
    g.quaternion.identity()
    const viaMatrix = terrainMeshToWorld(TITLE_2016.cameraMesh, g)
    const [x, z] = eyeWorld(TITLE_2016.cameraMesh[0], TITLE_2016.cameraMesh[2])
    expect(x).toBeCloseTo(viaMatrix.x, 6)
    expect(z).toBeCloseTo(viaMatrix.z, 6)
  })

  it('lands the eye inside the map, not off the side of it', () => {
    // The cheapest thing a sign error breaks. `cameraMesh` is 2,674.8 / 2,723.1
    // in a 0..4,096 map, so the chunk it falls in is an interior one — and the
    // chunk the arithmetic picks has to be that one.
    const [cx, cy] = chunkOf(TITLE_2016.cameraMesh[0], TITLE_2016.cameraMesh[2])
    expect(cx).toBeGreaterThanOrEqual(0)
    expect(cx).toBeLessThan(perSide)
    expect(cy).toBeGreaterThanOrEqual(0)
    expect(cy).toBeLessThan(perSide)
    const eye = eyeWorld(TITLE_2016.cameraMesh[0], TITLE_2016.cameraMesh[2])
    expect(lodAt(cx, cy, eye), 'the chunk under the eye is the finest there is').toBe(0)
  })

  it('refuses the MIRRORED eye, which is what a wrong z sign produces', () => {
    // The mutant: `position.z + scale.z * meshZ` instead of minus. It reflects
    // the eye about the terrain's own z axis, and every other assertion in this
    // file still passes — the ladder is still a ladder, the map is still
    // covered, the count of fine chunks is identical. What changes is WHICH
    // chunks are fine.
    const f = placed()
    const mirrored = [
      f.originX + TITLE_2016.cameraMesh[0],
      f.originZ + TITLE_2016.cameraMesh[2],
    ] as const
    const [cx, cy] = chunkOf(TITLE_2016.cameraMesh[0], TITLE_2016.cameraMesh[2])
    expect(lodAt(cx, cy, mirrored), 'the mirrored eye does not see the eye’s own chunk').toBe(
      t.lodLevels - 1,
    )
  })

  it('coarsens with distance, and the far corner is the coarsest band', () => {
    const eye = eyeWorld(TITLE_2016.cameraMesh[0], TITLE_2016.cameraMesh[2])
    const [cx, cy] = chunkOf(TITLE_2016.cameraMesh[0], TITLE_2016.cameraMesh[2])
    // The corner furthest from the eye in chunk space, whichever it is.
    const far = [cx < perSide / 2 ? perSide - 1 : 0, cy < perSide / 2 ? perSide - 1 : 0] as const
    expect(lodAt(far[0], far[1], eye)).toBe(t.lodLevels - 1)

    // And the whole grid, as a shape: every level is reachable, nothing is
    // outside the ladder, and it is a LADDER — a chunk further away is never
    // finer than one nearer. Counted rather than pinned, so a sheet change
    // moves the histogram without moving this test.
    const seen = new Set<number>()
    const rows: { d: number; lod: number }[] = []
    for (let x = 0; x < perSide; x++) {
      for (let y = 0; y < perSide; y++) {
        const lod = lodAt(x, y, eye)
        seen.add(lod)
        rows.push({
          d: chunkFootprintDistance(
            { ...placed(), chunkSize: params.chunkSize },
            x,
            y,
            eye[0],
            eye[1],
          ),
          lod,
        })
      }
    }
    expect([...seen].sort()).toEqual([0, 1, 2])
    rows.sort((a, b) => a.d - b.d)
    for (let i = 1; i < rows.length; i++) {
      expect(
        (rows[i] as { lod: number }).lod,
        'a chunk further from the eye is never finer than a nearer one',
      ).toBeGreaterThanOrEqual((rows[i - 1] as { lod: number }).lod)
    }

    // The size of the win, as a RATIO rather than a vertex count: a vertex
    // count would be a number to keep in step with the generator. LOD n has a
    // quarter of the quads of LOD n-1, so the ladder's cost against all-LOD-0
    // is the mean of 4^-lod.
    const cost = rows.reduce((a, r) => a + 4 ** -r.lod, 0) / rows.length
    expect(cost, 'the ladder is worth having').toBeLessThan(0.5)
  })
})

/**
 * WHICH objects the flypast flies — DEV-215's bug, and DEV-281's answer to it.
 *
 * `title.update` flies `jets[i]` for `i < flown`. For the life of DEV-155
 * `flown` was 1, and `boot/app.ts` handed it `liveRacers.group.children` behind
 * a comment saying *"the group's children are the per-racer nodes"*. They are
 * not: `game/racers.ts` adds a `racer:<id>` node **and a world-space trail** per
 * racer to the same group, so the children alternate. `children[0]` is a racer,
 * which is the only reason one ship ever worked — `children[1]` is a ribbon.
 *
 * Flying two turned that latent bug into a visible one, and only a screenshot
 * found it: the suite was green, because "a jet is flying" is true when one of
 * the two things you flew is a jet.
 *
 * **DEV-281 removes the class rather than the instance.** Boot no longer builds
 * a mission at all, so there is nothing to borrow: the title loads its own ship
 * per lane and parents them under its own group — which is also what
 * `main_menu.unity` does, its two `SplineWalker`s carrying ships that have
 * nothing to do with a level's grid. So the claim guarded here is no longer
 * *"take the ships, not the group"* but *"one jet per 2016 lane, built here"*.
 *
 * Source-level, in the shape `xr-eye-layers.test.ts` uses — read the file and
 * require the wiring, because the alternative needs a GLB, a level and a
 * renderer. No assets and no DOM: this reads two files off disk.
 */
describe('the flypast flies the title screen’s OWN ships, one per 2016 lane', () => {
  const read = (p: string) => fs.readFileSync(p, 'utf8')

  it('hands `title.update` the jets the title built, and nothing else', () => {
    const app = appSourceThroughCtx()
    const call = /title\.update\(\s*frameSeconds\s*,\s*([^)]*)\)/.exec(app)
    expect(call, 'boot/app.ts still calls title.update(frameSeconds, ...)').not.toBeNull()
    const jets = (call?.[1] ?? '').trim()
    expect(jets, 'the title flies its own ships').toBe('liveTitleJets')
    // The original defect, still refused: whatever is handed over must never be
    // the raw child list of a group that holds more than ships.
    expect(jets).not.toContain('group.children')
  })

  it('builds one jet per 2016 flypath, and nothing decides the count twice', () => {
    const app = appSourceThroughCtx()
    // The loop bound IS the lane list, so *"two ships"* is a fact about
    // `TITLE_2016.flypaths` rather than a number typed beside it — the same
    // rule the checklist count lives under. `Title.update` then clamps to
    // `min(lanes.length, jets.length)`, so a third lane would fly a third ship
    // with no edit here at all.
    expect(app).toMatch(/for \(let i = 0; i < TITLE_2016\.flypaths\.length; i\+\+\)/)
    // And they are the title's children, which is what makes one `setVisible`
    // take the whole screen down and `title.dispose()` free them.
    expect(app).toContain('title.object.add(jet)')
  })

  it('keeps `ships` one-per-racer while the racers group holds twice that', () => {
    const racers = read('src/game/racers.ts')
    // Still true and still worth pinning: `LoadedRacers.ships` is the accessor
    // anything wanting per-racer nodes must use, and the reason it exists is
    // that the group is not that list.
    expect(racers).toMatch(/ships:\s*loaded\.map\(\(l\)\s*=>\s*l\.object\)/)
    expect(racers).toMatch(/racers\s*=\s*loaded\.map\(\(l\)\s*=>\s*l\.racer\)/)
    // Two `group.add` calls per racer, one of them the trail. If that ever
    // becomes one, this test is the place to find out why the rule changed.
    // And a THIRD call, once and not per racer: DEV-358's wing-tip trails,
    // every racer's in one batch — one more non-racer child in the group,
    // which is this test's point made again.
    const adds = racers.match(/group\.add\(/g) ?? []
    expect(
      adds.length,
      'two group.add per racer — the ship and its trail — and one wing-trail batch',
    ).toBe(3)
    expect(racers).toMatch(/if \(wingTrails\) group\.add\(wingTrails\.trails\.object\)/)
  })
})
