// src/render/title.ts — the first thing you see.
//
// Matt, 2026-09-11: *"the title screen in the original FF started with the
// player in a field, the 3D logo giant out front, and the ai racers on a
// predetermined path. (press A to start)"* — then underground for the menus,
// then the missions.
//
// So: three things and a prompt. You are standing outside, there is a monument
// with the game's name on it, and jets go past.
//
// ── What is faithful here, and what is not ───────────────────────────────
//
// **Faithful:** the shape of the screen, and that it is IN THE WORLD rather
// than a menu drawn over one. `main_menu.unity` is a real scene you stand in.
// The place is 2016's own alpine valley, generated from
// `World Machine Content/forest_02/forest_02_height.tga` by this port's own
// `FacetedTerrain` (DEV-041), and the monument is 2016's own `logo_polys` mesh
// at the position, yaw and scale `main_menu.unity` gives it (DEV-042). The two
// stand-ins this header used to describe — Simonet standing in for the valley,
// and a canvas wordmark on a faceted slab standing in for the emblem — both
// shipped. The slab survives below only as the fallback for a missing `.glb`.
//
// **And WHERE IN THE VALLEY you stand is 2016's too**, since 2026-09-13. It was
// not: the rig was composed off the terrain's LOCAL prefab transform while
// `main_menu.unity` hangs that prefab under two rotated parents, which stood the
// port **1,022 m** from 2016's spot over the same height map, **86.94°** off its
// bearing, on a 397 m shoulder instead of the 92 m valley floor. `TITLE_2016`
// below is the corrected measurement and it is expressed in the terrain's own
// MESH frame, which is the only frame that survives re-placing the valley.
// Matt took the call — *"option 2 - let's be faithful to 2016"* — so the
// valley's 6.671° tilt ships with it. See `docs/DEVIATIONS.md` DEV-042.
//
// **And HOW YOU STAND is 2016's too, since 2026-09-13** — Matt, *"fix the
// pitch"*. The rig is LEVEL. It used to `lookAt` the emblem, which centres it by
// tipping the whole rig up 10.854°; 2016's camera has a pure-yaw world rotation
// and framed the emblem high instead. On a monitor that was a preference. In a
// headset the quaternion below lands on `render.rig`, so it decides whether the
// player's horizon is level for as long as the title screen is up — and the
// title screen is the first thing anyone wears. See `levelGaze` and DEV-068.

import * as THREE from 'three'
import { PROMPT_PHONE_BELOW_DEG, PROMPT_PHONE_SCALE, phoneUi } from '@/render/phone-floor'
import { UI_ACCENT as ACCENT, UI_INK as INK, uiFont } from '@/render/ui-tokens'
import { hudFace, whenHudFontSettles } from './hud-font'
import { disposeTree } from './scene-walk'

/**
 * 2016's title-screen layout, measured out of `main_menu.unity`.
 *
 * ── Why these are MESH coordinates and not offsets ───────────────────────
 *
 * The previous version of this block held `camera world MINUS terrain LOCAL`,
 * which is only a meaningful vector when the terrain's parent chain is
 * identity. It is not. Composed with `tools/prototype/unity_scene_to_json.js`:
 *
 *   TitleScene/Cameras                          (-166.1991, 3.5874,   95.3571)
 *   .../art/logo/logo_polys                     (-152.0610, 8.5336,  116.9350)
 *   Spotlight                                   (-159.4000, 12.6000,  96.4000)
 *   terrainPivot                                (-166.0066, 2.6668,   95.6520)
 *   terrainPivot/AlpineTerrain_menu/terrain (1) (2382.7355, -274.3970, -2733.9726)
 *
 * `terrainPivot` sits AT THE CAMERA: 2016 put a pivot where the player stands
 * and swung the whole 4 km valley around it until the skyline looked right.
 * That is why there is a rotation at all, and it is the tell that the rotation
 * is ART rather than an accident.
 *
 * So each point is carried here as `R⁻¹ · (P_world − T_world)` — its position in
 * the terrain's own mesh frame, where the map runs 0..4096 in x and z and the
 * height map's `u, v` address it directly. That frame is the only one the two
 * projects share, and it survives us parking the valley 30 km from Simonet.
 *
 * ── The numbers check each other, three ways ─────────────────────────────
 *
 *  1. The camera's own yaw is 33.3461°; the bearing from the camera to the logo
 *     is 33.2333°. 2016 pointed the camera at the logo, so a correct
 *     composition renders the emblem dead centre and an off-centre frame says
 *     so out loud.
 *  2. `terrainHeightAt` under `cameraMesh` is 92.361 m and the camera is at
 *     98.533 m: **6.172 m of clearance**, against the 6 m somebody had guessed
 *     for the lift this replaces. Two routes that never met, 0.17 m apart.
 *  3. 2016 authors 23 nodes along a Curvy spline that must be IN THE AIR — its
 *     nine control points and the fourteen rings cloned along it. In this frame
 *     they average +0.6 m of clearance; in the frame this replaces, all 23 are
 *     underground by an average of 408 m. (That spline turned out to be the one
 *     nobody walks — DEV-215 — which does not weaken the check: an author placed
 *     them in the air either way. The 16 control points of the two splines a
 *     SHIP does walk are all airborne in this frame, and 13 of 16 are buried in
 *     the other one.)
 *
 * All three are `tests/unit/title-placement.test.ts`, because a derived number
 * has no machine guarding it (DEV-027).
 */
export const TITLE_2016 = {
  /**
   * The terrain's WORLD rotation in `main_menu.unity`, THREE space, xyzw.
   *
   * Unity `{-0.024637, -0.685958, -0.052707, 0.725311}` through the z-mirror
   * (`x, y` negated). Yaw −86.922°, and **6.671° off vertical** — 479 m of rise
   * across the 4096 m map. That tilt is deliberate and it ships: Matt, on being
   * shown it beside a levelled version, *"option 2 - let's be faithful to
   * 2016"*. Do not level it and do not put a switch on it.
   */
  terrainQuaternion: [0.024637007, 0.685958194, -0.052707015, 0.725311205],
  /**
   * Camera, in the terrain's mesh frame. Unity handedness; z flips on the way out.
   *
   * Composed against the NORMALISED rotation. The flattener writes quaternion
   * components to 6 dp, and the camera sits **3,818 m** from the terrain's
   * origin, so one ulp of that rounding is **3.8 mm** of position here and
   * leaving `|q|` at 0.99999972 was worth 2.2 mm on its own. Neither matters to
   * anything you can see; both are recorded because the next person to check
   * these numbers against the scene will find that difference and need to know
   * it is the oracle's precision rather than a mistake.
   */
  cameraMesh: [2674.8323, 98.5326, 2723.0521],
  /** `logo_polys`, same frame. 25.797 m ahead of the camera and 4.946 m up. */
  logoMesh: [2696.9033, 105.7933, 2710.8001],
  /** The logo's own key light, same frame. 22.18 m from the emblem. */
  spotMesh: [2675.8512, 108.272, 2717.3382],
  /** Unity WORLD yaws, degrees — unchanged by the frame correction, see below. */
  cameraYaw: 33.3461,
  logoYaw: -150.0,
  /** The scene instance's uniform scale. 17.97 m of mesh becomes 14.7 m. */
  logoScale: 0.8184,
  /**
   * The logo's OWN light. `main_menu.unity` carries a white Spotlight with
   * `m_CullingMask.m_Bits: 8388608` — 2^23, a single layer, and layer 23 is
   * `SpecialLighting` in `ProjectSettings/TagManager.asset`. The logo instance
   * sets `m_Layer: 23` while the prefab's own objects are all layer 0, so the
   * SCENE puts it there deliberately: one light, one layer, one object on it.
   */
  spotIntensity: 1.54,
  spotRange: 37.346905,
  spotAngleDeg: 76.48524,
  /**
   * 2016's flypast: the TWO splines its two ships actually walk. DEV-215.
   *
   * Same mesh frame as everything above, one entry per `SplineWalker` that
   * carries a ship. Both walk at `Speed: 0.042` with `MoveByWorldUnits: 0`, so
   * the speed is a FRACTION of the spline per second and a lap is 23.8 s for
   * both — `flypathLapSeconds`. Both carry `Clamping: 1` (loop),
   * `SetOrientation: 1`, and `Forward: 0`; that last one is `FLYPAST_DIRECTION`
   * and DEV-202, and it is true of all four walkers in the scene.
   *
   * ── What was here before, and why it was wrong ────────────────────────────
   *
   * DEV-155 measured the root `Curvy Spline` — nine control points, at the
   * scene origin, Interpolation 1, Closed 1, TCB all zero, and **walked by
   * nobody**. It is referenced exactly ONCE in `main_menu.unity`, by the
   * `SplinePathCloneBuilder` on `npc_stuff/CurvyClonePath`, which carries
   * **`m_Enabled: 0`**; it is also the only one of the three splines with
   * `AutoRefresh: 0`. So for the life of the port the title screen flew a path
   * 2016 authored, kept, and switched off.
   *
   * That is CLAUDE.md's liveness walk applied to a COMPONENT REFERENCE rather
   * than to a GameObject, and it is a new face of a trap this repo already
   * knows three other ways (`m_IsActive` chains, stripped prefab instances,
   * `m_Enabled: 0` generators). The spline existed, it was tuned, it was
   * plausible, and every `m_Enabled`/`m_IsActive` flag on IT was green — the
   * disabled flag was on the other end of the reference. *"When a 2016
   * component's job is to PRODUCE objects, count the objects"* — and when its
   * job is to be WALKED, find the walker.
   *
   * ── Establishing the walkers, which is the whole of the fix ───────────────
   *
   * Four `SplineWalker`s, all `m_Enabled: 1`, all `activeInHierarchy`, all
   * under `npc_stuff` (identity, at the origin):
   *
   *   npc_stuff/npc_aiShip      -> path_ai_02   InitialF 0.43  Speed 0.042
   *   npc_stuff/ai_target       -> path_ai_02   InitialF 0.40  Speed 0.0435
   *   npc_stuff/npc_aiShip_02   -> path_ai      InitialF 0.78  Speed 0.042
   *   npc_stuff/ai_target_02    -> path_ai      InitialF 0.74  Speed 0.043
   *
   * **2016 flew two ships, not one.** `npc_aiShip_02` looked empty to the first
   * three passes over this scene because its `GhostRacer` is a STRIPPED PREFAB
   * INSTANCE — `--expand-prefabs` is what shows the `hoverJet_exterior_blue`
   * under it, active, renderer enabled, with trails. Same negative-that-is-wrong
   * that hid the finish gate for the life of the port (DEV-045).
   *
   * The two `ai_target`s are the HEADING, and they corroborate DEV-202 from a
   * direction nothing else looks at. `npc_aiShip`'s ship mesh (`SR9_rev4`)
   * carries a `SmoothLookAtConstraint` aimed at `ai_target` — `pointAxis
   * (1,0,0)`, `speed 90` — and `ai_target` sits 0.03 of the spline AHEAD of the
   * ship in the descending direction. So 2016 aimed its ship at a lead point
   * down-path, which is exactly what `FLYPAST_LEAD` does. (`ai_target_02` is
   * referenced by nothing at all; `npc_aiShip_02` takes the walker's own
   * `SetOrientation`. A dead field, like `Rotator_Input.yawMax`.)
   *
   * ── The curve is checked against 2016's OWN bake ──────────────────────────
   *
   * `CurvySplineSegment` serialises `Approximation`: `Granularity + 1` = 21
   * WORLD-space samples per segment, written by `_UpdateApproximation` as
   * `[0] = Position`, `[20] = NextTransform.position`, the rest
   * `Interpolate(i/20)`. That is an oracle outside the port for the curve
   * family, the closed wrap, the span parameterisation AND the control-point
   * order at once, and `flypastCurve`'s `CatmullRomCurve3` reproduces it to
   * **7.0e-5 m** on `path_ai`, 3.4e-5 m on `path_ai_02` and 3.2e-5 m on the
   * dead nine. That is float32 in the YAML, not a modelling difference.
   *
   * The ORDER is not the hierarchy's: `CurvySpline.cs:1421` sorts control
   * points **by NAME**, and both `path_ai` and the dead spline have a control
   * point whose sibling index disagrees with its name. Hierarchy order passes
   * every structural check and blows that diff up by hundreds of metres.
   *
   * ── Why BOTH, when DEV-155 deliberately flew one ─────────────────────────
   *
   * DEV-155 flew one because two ships nose-to-tail on ONE path is a formation
   * 2016 never made. With two separate paths that argument is dead by
   * measurement: the two ships never come within **344.2 m** of each other on
   * the whole lap, closest at t = 8.60 s.
   *
   * Framing, from 2016's own camera on `title-placement.test.ts`'s yardstick
   * (azimuth/elevation, 70° vertical at 16:9 — the same ruler that recorded
   * DEV-155's 65.8 %, so these are comparable numbers and not a new scale):
   *
   *   spline        walker          length   on screen  closest           smallest on screen
   *   path_ai_02    npc_aiShip      1703 m   54.7 %     15.17 m (25.3°)   0.77° = 11.9 px
   *   path_ai       npc_aiShip_02   3574 m   43.0 %     16.86 m (22.8°)   0.41° =  6.3 px
   *   Curvy Spline  nobody          1514 m   65.8 %     13.59 m (28.1°)   0.76° = 11.7 px
   *
   * Together the two real ships put something in frame **68.4 %** of the lap
   * and both at once **29.3 %** — more than the dead spline's single ship, with
   * a pass that is still a pass. And the DEV-044 floor holds: the pixel column
   * is the SMALLEST either ship ever gets **while it is on screen**, at 1080p,
   * and the worst of it is 6.3 px against the four that made the title jets
   * unreviewable. Nothing is ever four pixels in shot.
   *
   * ── What is measured here, and what is not ────────────────────────────────
   *
   * Measured: the control points, the 23.8 s lap, and `InitialF`. Not measured:
   * where a ship is at a given second. Curvy's `f` is a SPLINE PARAMETER and
   * `getPointAt` walks by ARC LENGTH, so `initialF` lands **201.7 m** from
   * Curvy's own point on `path_ai_02` and **156.0 m** on `path_ai` (DEV-202
   * recorded 74 m for the dead spline). Left alone on purpose: on a screen that
   * loops for ever it only sets the phase at boot, and it is a second axis on a
   * change that needs one look.
   */
  flypaths: [
    {
      /** `npc_stuff/npc_aiShip` — the ship with the `SmoothLookAtConstraint`. */
      walker: 'npc_aiShip',
      /** `npc_stuff/path_ai_02`, `&40779049`. Root at (0, 8.280874, -8.449232). */
      spline: 'path_ai_02',
      /** `SplineWalker.InitialF`. Where this ship is at t = 0. */
      initialF: 0.43,
      mesh: [
        [2569.4701, 196.52, 2638.598],
        [2700.53, 98.5227, 2715.3654],
        [2837.7682, 174.8029, 2737.7685],
        [3027.6401, 295.6364, 2672.8352],
        [3074.6796, 259.8755, 2487.0428],
        [2727.6898, 502.4515, 2387.6835],
      ],
    },
    {
      /** `npc_stuff/npc_aiShip_02` — the one the stripped prefab hid. */
      walker: 'npc_aiShip_02',
      /** `npc_stuff/path_ai`, `&1375526636`. Root at (0, 6.426321, 1.658587). */
      spline: 'path_ai',
      initialF: 0.78,
      mesh: [
        [2341.2446, 509.3577, 2533.9229],
        [2578.2839, 161.7237, 2678.2303],
        [2749.3283, 106.799, 2729.5892],
        [2850.8256, 186.1457, 2818.6249],
        [2972.8822, 437.2203, 2854.0887],
        [2943.6137, 161.9312, 2553.9734],
        [3050.2005, 225.8958, 2309.8159],
        [3017.7036, 196.4222, 2006.5481],
        [2733.1735, 722.9825, 1965.1091],
        [2442.6916, 739.6156, 2141.7714],
      ],
    },
  ],
  /**
   * `1 / SplineWalker.Speed`, seconds. 0.042 of the spline a second.
   *
   * One constant for both ships because both walkers carry the same `Speed`;
   * `title-placement.test.ts` asserts that rather than trusting this sentence.
   */
  flypathLapSeconds: 1 / 0.042,
} as const

/**
 * A point in the terrain's own MESH frame, into three world space.
 *
 * ── Why the yaws above did NOT have to change with the frame ─────────────
 *
 * Because the correction puts 2016's rotation on the TERRAIN and leaves the rig
 * upright, exactly as `main_menu.unity` has it — the camera there is a pure yaw
 * with no pitch or roll, and the valley is what is tipped. Compose it and the
 * rotations telescope: an object's world orientation is
 * `R_group · (R⁻¹ · q_2016)`, and `R_group` **is** `R`, so what is left is
 * `q_2016`. The camera's 33.3461° and the logo's −150° are 2016's world yaws
 * and they stay 2016's world yaws. Only the POSITIONS move.
 *
 * That is also why this takes the group rather than a copy of its transform:
 * the terrain's matrix is the single source of truth for where the valley is,
 * so the rig cannot drift from the ground it is standing on. `updateMatrixWorld`
 * because a group added to the scene this frame has not been through the
 * renderer yet, and `matrixWorld` would still be the identity.
 */
export const terrainMeshToWorld = (
  mesh: readonly number[],
  group: THREE.Object3D,
  out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 => {
  group.updateMatrixWorld(true)
  // `chunkGeometry` flips mesh z on its way into the group, so a Unity mesh
  // point sits at group-local (x, y, -z). One conversion, applied to the rig
  // and the vertices alike, or the camera stands in a mirrored valley.
  return out
    .set(mesh[0] as number, mesh[1] as number, -(mesh[2] as number))
    .applyMatrix4(group.matrixWorld)
}

export interface TitleOptions {
  /** Where the camera stands, world space. The monument is placed off this. */
  readonly eye: THREE.Vector3
  /** Compass direction the camera faces, radians. The monument goes there. */
  readonly facing: number
  /**
   * Ground height at a world x/z, or null to hang the monument at eye level.
   *
   * The monument stands ON the valley, so it has to ask. Passed as a function
   * rather than a number because the terrain under its base is not the terrain
   * under the camera — they are 95 m apart, which in an alpine valley is most
   * of a hillside.
   */
  readonly groundAt?: ((x: number, z: number) => number) | null
  /**
   * 2016's own logo mesh, already loaded, or null for the stand-in monument.
   *
   * Placed at the transform `main_menu.unity` gives it rather than anywhere
   * convenient: see `LOGO_2016` in `boot/app.ts`.
   */
  readonly logo?: THREE.Object3D | null
  /** Yaw and uniform scale for that mesh, from the scene. */
  readonly logoYaw?: number
  readonly logoScale?: number
  /**
   * Exactly where the logo goes, world space, overriding `MONUMENT_DISTANCE`.
   *
   * Used when the placement is MEASURED rather than composed — 2016 put the
   * logo 25.8 m ahead of the camera and 4.95 m above it, and that relationship
   * is the thing worth keeping.
   */
  readonly logoAt?: THREE.Vector3 | null
  /**
   * 2016's flypast paths, WORLD space, closed. Empty flies the old circuit.
   *
   * `TITLE_2016.flypaths` through `terrainMeshToWorld`, so the paths are the
   * valley's, not the scene's — re-park the valley and the ships still fly over
   * the same ground. ONE ship per entry, in this order, each starting at its own
   * walker's `initialF`; see `update`.
   */
  readonly flypaths?:
    | readonly {
        readonly path: readonly THREE.Vector3[]
        readonly initialF: number
      }[]
    | null
  /** The three layer the logo and its key light share. See `logoLight`. */
  readonly logoLayer?: number
  /**
   * 2016's dedicated logo spotlight, or null.
   *
   * `main_menu.unity` lights the emblem with a white Spotlight whose culling
   * mask is a single layer — `SpecialLighting`, layer 23 — that only the logo
   * is on. Without it the gold reads dull, because the menu's own sun is warm,
   * low and deliberately soft.
   */
  readonly logoLight?: {
    readonly position: THREE.Vector3
    readonly intensity: number
    readonly distance: number
    readonly angle: number
  } | null
  /** The name on the monument. Used only when there is no mesh. */
  readonly title: string
  readonly subtitle: string
  /**
   * The line under the emblem. Worded by the caller.
   *
   * **Still called `prompt` although it no longer prompts** (DEV-285): it said
   * `press A to start` until Matt moved the edition's name into this slot, and
   * it is the same plane, the same canvas, the same placement and the same two
   * constants (`PROMPT_RANGE_FRACTION`, `PROMPT_BELOW_SIGHTLINE`) either way.
   * Renaming it would touch nine identifiers to say nothing new, so the
   * name records what the plane IS rather than what it currently says.
   */
  readonly prompt: string
}

export interface Title {
  readonly object: THREE.Object3D
  /** Where the camera should sit and look. Composed once; never moves. */
  readonly eye: THREE.Vector3
  readonly quaternion: THREE.Quaternion
  /** Down once the game starts. The monument is a screen, not scenery. */
  setVisible(visible: boolean): void
  /**
   * Fly the jets past, and breathe the monument.
   *
   * `jets` are the racers' own render objects — the real meshes, borrowed. The
   * caller stops `racers.render()` while the title is up, so nothing here
   * fights the sim for them and nothing in the sim is touched.
   */
  update(seconds: number, jets: readonly THREE.Object3D[]): void
  dispose(): void
}

/** Metres from the eye to the monument, and how big it is. */
const MONUMENT_DISTANCE = 95
const MONUMENT_HEIGHT = 34
const MONUMENT_WIDTH = 78

/**
 * The flypast: the arc's radius and height as MULTIPLES OF THE ANCHOR DISTANCE,
 * and how long a lap takes.
 *
 * 150 m put the jets so far out they were four pixels. They are the only thing
 * moving on this screen, so they have to be big enough to read as jets — and
 * fixed metres cannot hold that, which this screen then proved: 78 m was picked
 * against a stand-in monument 95 m away, and when DEV-042 moved the framing to
 * 2016's own — a logo 25.8 m out — the same 78 m became three times the
 * subject's distance and the jets went back to four pixels.
 *
 * So they are fractions. At 2016's framing that is a 40 m circuit 16 m up,
 * where a 6.8 m ship subtends about 10 degrees: a jet, not a speck. The
 * proportion is what was being chosen all along.
 *
 * **Levelling the rig did not move a jet** (DEV-068) — the circuit is anchored
 * to the LOGO and the eye, and neither of those changed. What changed is where
 * it crosses. Sampled on the running app, 4 jets every 0.5 s over a whole lap
 * and re-projected into both frames:
 *
 *   pitched   26 of 112 samples on screen (23 %), elevation −1.7° .. 23.0°
 *   level     24 of 112 samples on screen (21 %), elevation  9.2° .. 27.9°
 *
 * So the flypast keeps its screen time and moves from straddling the centre to
 * crossing the upper third, topping out 7° inside the 35° half-frame. It stays
 * in the picture; whether it READS better up there is an eye's question and it
 * is left to a worn pass rather than settled here.
 */
const PASS_RADIUS = 1.55
const PASS_HEIGHT = 0.62
const PASS_SECONDS = 13

/**
 * Where the line under the emblem sits: on the valley floor in front of you.
 *
 * It read "PRESS A TO START" until DEV-285 and is the edition's name now; the
 * placement is unchanged and the numbers below were tuned against the longer
 * of the two strings, so nothing here moved with the words.
 *
 * Expressed against the SIGHTLINE to the logo — a fraction of the way along it,
 * and an angle below it — rather than as an offset from the logo, so it holds
 * its place in the picture whatever the rig's absolute height ends up being. At
 * 2016's framing (25.8 m to the logo, 4.95 m up) this puts it about 10.8 m out
 * and 1.5 m below the eye, which is open ground: the camera stands 6 m clear
 * of it.
 *
 * **The sightline is no longer the camera's axis** (DEV-068). It was, while the
 * rig pitched up to centre the emblem; with the rig level the sightline runs
 * 10.854° above the axis and this angle is measured off it, not off the frame.
 * So the plate's WORLD position did not move — it still stands on the same open
 * ground, which was the constraint that chose it — and what changed is where it
 * lands in the picture: from 19° below the centre of frame to **8.15°** below,
 * i.e. from 49 % of the way down the lower half to 20 %. Measured, not guessed:
 * the running app reports it, and `tests/unit/title-placement.test.ts` asserts
 * it against 2016's own numbers.
 */
const PROMPT_RANGE_FRACTION = 0.42
// DEV-648: 17.5 degrees (was 19), 1.5 degrees higher, so the line stands clear of the
// tree line on the snow below it (photographs in the DEVIATIONS row).
const PROMPT_BELOW_SIGHTLINE = (17.5 * Math.PI) / 180

/**
 * 2016's own world-space menu label, off `main_menu.unity`. DEV-155.
 *
 * `TitleScene/Canvas/play_grp/label_play` and `exit_grp/label_exit` — "Play"
 * and "Quit" — are `Text` at `m_Color` **(0.8857591, 0.91775966, 0.9485294)**
 * with a `Shadow` (`UnityEngine.UI` fileID 1573420865) at `m_EffectColor`
 * (0.38235295 grey, alpha 0.6901961) and `m_EffectDistance` (-2.4, -3) on a
 * 36-point font. `label_options` is the odd one out in gold, which is what a
 * selected entry looks like.
 *
 * The port's line is not one of 2016's words either way — it said *press A to
 * start* until DEV-285 and carries the edition's name now — but its COLOUR was
 * invented, and `ACCENT` gold on the menu valley's pale ground is a line you
 * cannot read. 2016's near-white with 2016's drop shadow is both the faithful
 * answer and the legible one, and that is a claim about the GROUND rather than
 * about the words, so it survives them changing.
 *
 * The shadow offset is carried as a FRACTION OF THE FONT SIZE rather than in
 * pixels: 2016's -2.4 / -3 are pixels of a 36-point glyph on a canvas whose
 * resolution is 2016's business, and this canvas is 64 px tall. A ratio is the
 * only part of that which transfers.
 *
 * The FONT: 2016's is `Fonts/CRYSTAL-Regular.ttf`. This comment said it had no
 * licence trail and could not transfer; it is CC BY-SA 4.0 by Felipe Munoz (its
 * own name table, and the licence file beside it), and since the DEV-362
 * follow-up it ships and the cockpit readout draws in it (`render/hud-font.ts`).
 * Since DEV-610 this line draws in it too: see `subtitleFont`.
 */
const LABEL_2016 = '#e2eaf2'
const LABEL_SHADOW_2016 = 'rgba(98, 98, 98, 0.69)'
const LABEL_SHADOW_X = -2.4 / 36
const LABEL_SHADOW_Y = -3 / 36

/**
 * The edition's line's type size on its 1024 x 128 canvas, unchanged by
 * DEV-610: the face changed, the size and the plane did not.
 */
export const TITLE_SUBTITLE_PX = 64

/** The stack the line drew in until DEV-610, and draws in until CRYSTAL lands. */
const subtitleFallback = (px: number): string => uiFont(px, 600)

/**
 * The CSS font for the "10th Anniversary Edition" line (DEV-610). Matt,
 * 2026-10-03: *"change the "10th Anniversary Edition" text to use the same
 * font as the hover-jet hud"*. That face is CRYSTAL, 2016's own HUD font
 * (CC BY-SA 4.0, Felipe Munoz), and this asks the HUD's own question of it:
 * `hudFace` names it once `loadHudFont` (started at boot, `boot/app.ts`) has
 * put it in `document.fonts`, at its one weight, and the old stack until then
 * or for good if the load fails. No second file and no second loader: the one
 * face the cockpit draws in, through the one path it loads by.
 */
export const subtitleFont = (px: number): string => hudFace(px, subtitleFallback)

/**
 * 2016's own materials for the logo, off `Prefabs/logo_polys.prefab`.
 *
 * The glTF carries the geometry and the vertex colours; it does not carry the
 * MATERIAL, and the material is where the colour lives — which is why the first
 * build rendered a gold-and-silver emblem as grey stone.
 *
 *   title      -> Materials/logo_gold.mat            _Color (0.978, 0.809, 0.388)
 *   logo_top   -> Materials/logo_gold.mat            same
 *   logo_bottom-> medals/medal_Silver.mat            _Color (0.7585, 0.7854, 0.8971)
 *
 * Both are `Marmoset Specular IBL` shaders, so their `_SpecInt` (3.63 and 0.58)
 * and `_Shininess` (6.0 and 6.13) are not portable — DEV-008 is where Marmoset's
 * specular gets ported for the terrain, the gates, the clouds and now this. What
 * carries is the base colour and the fact that these are METALS.
 *
 * Hand-carried with the file and field cited, like the UI strings: the
 * extractor reads terrain and vehicle materials, not arbitrary prefab ones.
 * `medal_Silver.mat` is also in the OLD Unity YAML shape (`data: first/second`
 * with no leading dash), which is the form CLAUDE.md notes the loader returns
 * `{}` for — it had to be read out of the raw text.
 */
const LOGO_GOLD = 0xfacf63
const LOGO_SILVER = 0xc2c8e5

/**
 * Paint the three submeshes the way the prefab does.
 *
 * Matched BY NAME rather than by index: a glTF exporter is free to reorder
 * primitives, and "the second one is the silver one" is the kind of assumption
 * that survives until it does not.
 */
const paintLogo = (root: THREE.Object3D): void => {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const silver = /bottom/i.test(mesh.name)
    mesh.material = new THREE.MeshStandardMaterial({
      color: silver ? LOGO_SILVER : LOGO_GOLD,
      // ── LOW metalness, and that is the faithful reading ────────────────
      //
      // The first build set 0.85, reasoning "gold and silver are metals". That
      // is the wrong shader model. `Marmoset Specular IBL` is a
      // SPECULAR/GLOSS workflow: `_Color` is the DIFFUSE albedo and the shine
      // is a separate `_SpecColor` x `_SpecInt`. Mapping `_Color` onto a
      // metalness base colour throws the diffuse away — a metal has almost
      // none — so the emblem went dull and, worse, 2016's dedicated key light
      // had nothing to light. It contributed a specular lobe and that lobe
      // missed the camera.
      //
      // A little metalness for the sheen, the gold as albedo, and the key light
      // does the rest. `_SpecInt` is 3.63 on the gold against 0.58 on the
      // silver, which is why the gold gets the tighter roughness.
      metalness: silver ? 0.25 : 0.18,
      roughness: silver ? 0.42 : 0.3,
      // A small floor only. With the key light restored this no longer has to
      // carry the emblem on its own.
      emissive: silver ? 0x191c26 : 0x241c0c,
      flatShading: true,
    })
  })
}

/**
 * Point a ship at where it is GOING, and bank it.
 *
 * `Object3D.lookAt` aims an object's **+z** at the target, and that is wrong for
 * every ship in this game by exactly 180 degrees. Matt: *"the ai jets in the
 * title screen seem to be flying backwards?"* They were.
 *
 * ── Why −z, and why this is arithmetic rather than an opinion ─────────────
 *
 * These jets are the racers' own render objects, borrowed. In flight their
 * orientation comes from `flipQuaternion` (`render/unity-space.ts`), and that
 * flip — negate x and y — is a CONJUGATION by the z-mirror. So for any sim pose
 * `q` and the mirror `F(v) = (vx, vy, −vz)`:
 *
 *     flip(q) · F(v) = F(q · v)
 *
 * A Unity body's forward is its local +z. Put `v = (0,0,1)` through that:
 * `F(v)` is `(0,0,−1)`, so the three object's local **−z** is its heading.
 * Worked concretely, a Unity yaw of +90 sends +z to +x; the flipped quaternion
 * is a three yaw of −90, which sends (0,0,−1) to (1,0,0). Same heading, and it
 * arrives on the opposite axis.
 *
 * So a racer travels along −z, `lookAt` aims +z, and the two disagree by a half
 * turn. The fix is to aim the far side: look at the point mirrored through the
 * ship's own position, which puts +z behind and −z on the heading.
 *
 * `render/diorama.ts` does NOT need this and must not use it — its jets are
 * cones whose geometry is explicitly rotated to put the nose on +z, so `lookAt`
 * is already right for them. The convention belongs to meshes that came through
 * the Unity mirror, not to every jet on screen.
 *
 * Exported, and `tests/unit/title-flypast.test.ts` checks it against
 * `flipQuaternion` on a real pose rather than against a quaternion I typed out
 * twice — which is the whole lesson of "the orientation lesson" in
 * `docs/DEVIATIONS.md`: test the geometry, not the rotation.
 */
export const aimShip = (ship: THREE.Object3D, target: THREE.Vector3, roll: number): void => {
  // Mirror the target through the ship: `lookAt(behind)` puts +z behind it and
  // therefore −z, the nose, on the heading.
  _behind.copy(ship.position).sub(target).add(ship.position)
  ship.lookAt(_behind)
  ship.rotateZ(roll)
}

/** Volatile. Valid only inside one synchronous `aimShip`. */
const _behind = new THREE.Vector3()

/**
 * Which way round the closed spline the ship flies. DEV-202.
 *
 * Matt, from the headset: *"titlescreen jet is flying it's path in reverse
 * (should be flying towards the camera, not away from it)"*.
 *
 * ── It is the TRAVEL, not the aim — and those have opposite fixes ─────────
 *
 * Two bugs make a jet look like it is going the wrong way and they are not the
 * same defect. Measured over 64 samples of the lap
 * (`tests/unit/title-flypast-direction.test.ts`):
 *
 *   * the AIM was never wrong. `nose · velocity` is **1.000 at all 64
 *     samples**, before this change and after it. `aimShip` above is right,
 *     `racers.render()` writes `flipQuaternion` to the same root group, and the
 *     two agree. DEV-044's bug is fixed and did not come back.
 *   * the TRAVEL was backwards. Of the 42 samples that are inside the frame,
 *     only **13** were closing on the camera. The screen OPENED with the ship
 *     at 278 m and receding, and it receded for **4.8 s** — and the one real
 *     approach on the lap, 209 m down to 14 m at `closing` 0.97, happened
 *     entirely **BEHIND the camera**: seven consecutive samples with the ship
 *     out of shot. You saw it leave, never arrive.
 *
 * Walk the same points the other way and the same 42 in-frame samples give
 * **29** closing instead of 13: 278 m to 14.2 m over the opening 5.6 s, in
 * frame the whole way, then past your ear. That is a flypast.
 *
 * ── And it is 2016's own direction, not a deviation ───────────────────────
 *
 * Checked in the scene rather than argued from the screen. `SplineWalker` has a
 * `Forward` flag, `main_menu.unity` sets it to **0** on `npc_aiShip`, and
 * `Assets/Curvy/Legacy/SplineWalker.cs:40-45` is
 * `Dir => (Forward) ? 1 : -1`. That `-1` reaches
 * `CurvySplineBase.MoveFast`'s `tf += fDistance * direction`, so **2016's `f`
 * DECREASES** — the ship walks its control points in descending index order.
 * `Clamping: 1` is Loop, which wraps without flipping `dir`; only `PingPong`
 * does that, and it is not selected. `Speed` is positive and `Start()` does
 * `Speed = Mathf.Abs(Speed)` anyway, so the sign lives only in `Forward`.
 * All four `SplineWalker`s in the scene carry `Forward: 0`.
 *
 * So this restores fidelity. It is not a call Matt had to make.
 *
 * The thing that pointed the other way, recorded because it will point that way
 * again: the scene's numbered rings run the OPPOSITE way, ring 0000 at the
 * lowest `f` to ring 0009 at the highest, monotonically. They are a
 * `SplinePathCloneBuilder`'s output and a clone path lays its copies down in
 * ASCENDING `f` whatever the walker later does — so clone order and travel
 * direction are two different facts about one spline, and reading the first as
 * the second gives exactly the wrong answer. `m_Enabled: 0` on that builder,
 * besides.
 *
 * ── Why this is a SIGN and not a reordering of the control points ─────────
 *
 * Each `TITLE_2016.flypaths` entry keeps its measured order, because `initialF`
 * is a position ON that spline and reversing the ARRAY would move it. Measured
 * on the paths that actually ship: reversing `path_ai_02` puts
 * `getPointAt(0.43)` **181.8 m** away, at the 0.312 mark of the original, and
 * reversing `path_ai` puts `getPointAt(0.78)` **852.0 m** away, at the 0.087
 * mark — so each constant would have had to be re-derived to go on meaning what
 * it was measured to mean, and the two paths would need DIFFERENT corrections
 * because the shift depends on the point count. Negating the time term instead
 * leaves every measured number saying exactly what it said: a ship starts where
 * its own `InitialF` puts it and flies the other way from there. It also
 * matches how 2016 expresses it — Curvy keeps `InitialF` and `Forward` as
 * separate fields for the same reason.
 *
 * And the order is 2016's, not the hierarchy's: `CurvySpline.cs:1421` sorts
 * control points by NAME. See `flypaths`.
 *
 * ── What it is NOT ────────────────────────────────────────────────────────
 *
 * Not a frame or mirror error. `terrainMeshToWorld` is a reflection composed
 * with a rigid placement, and a reflection preserves DISTANCE — so the range
 * from camera to ship over the lap is identical in the port's world frame and
 * in 2016's own Unity frame, sample for sample, and no placement bug can flip
 * approach into recede. The test asserts that equality directly.
 *
 * Not the start fraction either. Curvy's `f` is spline parameter and
 * `getPointAt` is arc length, so the port's `initialF` lands 201.7 m (on
 * `path_ai_02`) and 156.0 m (on `path_ai`) from 2016's own point — a real
 * infidelity, recorded in DEV-202 and re-measured against the true paths in
 * DEV-215, and left alone in both. It is not this bug: from EITHER start the
 * ship recedes at every sample of the opening under the old sign and closes
 * under the new one.
 *
 * Not the SPLINE either, though the port was flying the wrong one the whole
 * time DEV-202 was open. `Forward: 0` is on all four walkers, so descending is
 * right on every path in the scene and DEV-215 did not disturb this. That is
 * the useful shape of it: a sign read off the walker survives being wrong about
 * which spline the walker points at.
 */
export const FLYPAST_DIRECTION = -1

/**
 * The scripted bank, radians, and its sign belongs to `FLYPAST_DIRECTION`.
 *
 * Not physics — the path is scripted, so the roll is too, and a jet that
 * circles flat reads as a model on a string. A CONSTANT roll on a path that
 * turns both ways can only ever be into the turn most of the time: measured,
 * the inside wing is below the hull on **49 of the 62** samples that are
 * turning at all.
 *
 * Reversing the travel reverses the handedness of every turn, so this sign
 * reverses with it or the ship banks OUT of its turns for the whole lap — the
 * same 49 samples, wrong way up, which is what the measurement says (13/62
 * with the old roll against the new direction). Flip one, flip both.
 */
export const FLYPAST_ROLL = 0.5

/**
 * How far ahead the heading point is taken, as a fraction of the lap.
 *
 * "Ahead" is `FLYPAST_DIRECTION`'s ahead. Kept next to the direction rather than
 * at the call site because a lead that does not reverse with the travel is the
 * half-fix: the ship then flies the right way round the path facing backwards,
 * which looks worse than the bug and reads the same from a seat.
 */
const FLYPAST_LEAD = 0.01

/** The nine measured points as the closed curve the ship walks. */
export const flypastCurve = (points: readonly THREE.Vector3[]): THREE.CatmullRomCurve3 =>
  // `curveType: 'catmullrom'` with `tension: 0.5` is the uniform Catmull-Rom
  // `CurvySpline` runs at `Interpolation: 1` and TCB all zero; `closed` is its
  // `Closed: 1`.
  new THREE.CatmullRomCurve3(
    points.map((p) => p.clone()),
    true,
    'catmullrom',
    0.5,
  )

/**
 * Where on the lap a ship is, and where it is looking, at `clock` seconds.
 *
 * `startF` is the ship's own `SplineWalker.InitialF` when it is on one of
 * 2016's paths, and an even share of the circle when it is on the fallback
 * circuit — which is the whole of the difference between the two cases, and the
 * reason it is an ARGUMENT rather than a branch in here. Two ships on 2016's
 * paths are on DIFFERENT splines and each starts where its own walker says;
 * spreading them by index would be inventing a formation.
 *
 * Exported so the direction test drives the SHIPPED expression instead of
 * re-deriving it the way the code does, which CLAUDE.md's trap 24 says is not a
 * test of the code. Both fractions come out of one call because the lead has to
 * carry the direction's sign — see `FLYPAST_LEAD`.
 */
export const flypastFractions = (
  clock: number,
  lapSeconds: number,
  startF: number,
): { readonly at: number; readonly ahead: number } => {
  const wrap = (f: number) => ((f % 1) + 1) % 1
  const at = wrap(startF + FLYPAST_DIRECTION * (clock / lapSeconds))
  return { at, ahead: wrap(at + FLYPAST_DIRECTION * FLYPAST_LEAD) }
}

/**
 * The rig's orientation: 2016's compass bearing, and NOTHING ELSE.
 *
 * Matt, 2026-09-13: *"fix the pitch"*. DEV-068.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 *
 * This used to be `Matrix4().lookAt(eye, logo, +Y)`, which centres the emblem
 * by tipping the whole rig up **10.854°** — the elevation of `logo_polys`'
 * transform origin above the eye's horizontal plane, `atan(4.94623 / 25.79715)`.
 * 2016 does not do that. `main_menu.unity` gives `TitleScene/Cameras` the world
 * quaternion `(0, 0.286910, 0, 0.957958)`: **x and z are zero**, a pure yaw of
 * 33.3461°, and every one of the ninety nodes inside `PreFabs/Cameras.prefab` —
 * the flat camera, the Oculus `CenterEyeAnchor`, the SteamVR `[CameraRig]`, and
 * the `y_rot/x_rot` mouse-look chain — carries local rotation IDENTITY under it.
 * So 2016 stood level and let the emblem sit high in the frame; the port pitched
 * the player's head back instead.
 *
 * ── Why it matters here more than it did on a monitor ─────────────────────
 *
 * On a monitor this is a framing preference and it shipped for sessions without
 * anyone minding. In a headset it is not a preference: `boot/app.ts` copies this
 * quaternion onto **`render.rig`**, and the camera is a CHILD of the rig, so a
 * pitched rig tips the WORLD relative to the player's own gravity for as long as
 * the title screen is up — and the title screen is the first thing anyone wears.
 * A rig that is not level fights the vestibular sense whatever the player does
 * with their neck. DEV-042 already rejected tilting the camera for exactly this
 * reason and then left the `lookAt` doing a smaller version of it.
 *
 * ── The convention, because there are two live in this file ───────────────
 *
 * `Matrix4.lookAt(eye, target, up)` takes the EYE first and aims the frame's
 * **−z** at the target. That is the CAMERA convention, it is what this call site
 * already used, and it is unchanged — the only thing that moves is the target,
 * from the emblem to a point on the horizon. Trap 22 (`aimShip`, above) is about
 * MESHES out of the Unity converter and does not apply to a camera.
 *
 * The input is flattened here rather than at the call site, so "level" is a
 * property of this function and not a promise its caller has to keep.
 */
export const levelGaze = (
  forward: THREE.Vector3,
  out: THREE.Quaternion = new THREE.Quaternion(),
): THREE.Quaternion => {
  const flat = new THREE.Vector3(forward.x, 0, forward.z).normalize()
  return out.setFromRotationMatrix(
    new THREE.Matrix4().lookAt(new THREE.Vector3(), flat, new THREE.Vector3(0, 1, 0)),
  )
}

export const createTitle = (opts: TitleOptions): Title => {
  const object = new THREE.Group()
  // NOT `title`: 2016's logo mesh has a submesh of that name (`logo_top`,
  // `logo_bottom`, `title`), and a scene traverse looking for the screen found
  // the wordmark instead — which is always visible on its own flag, because
  // three's `visible` is not inherited by the child's own property. Two e2e
  // specs asserted the title screen was still up after it had gone.
  object.name = 'title-screen'

  const forward = new THREE.Vector3(-Math.sin(opts.facing), 0, -Math.cos(opts.facing))
  const centre = opts.eye.clone().addScaledVector(forward, MONUMENT_DISTANCE)
  // Sunk to the ground it is standing on, if there is any.
  if (opts.groundAt) centre.y = opts.groundAt(centre.x, centre.z)

  // ── 2016's logo, if we have it ──────────────────────────────────────────
  //
  // Three meshes — `logo_top`, `logo_bottom` and `title` — 17.97 m across,
  // placed at the position, yaw and scale `main_menu.unity` gives them. When
  // this is present the monument below is not built at all: a stand-in stops
  // being a stand-in the moment the real thing arrives.
  if (opts.logo) {
    const logo = opts.logo
    logo.name = 'title-logo'
    paintLogo(logo)
    logo.position.copy(opts.logoAt ?? centre)
    logo.rotation.y = opts.logoYaw ?? 0
    const k = opts.logoScale ?? 1
    logo.scale.setScalar(k)
    object.add(logo)

    // ── the logo's own key light ────────────────────────────────────────
    //
    // On a layer of its own, exactly as 2016 does it: the light is restricted
    // to `SpecialLighting` and the logo is the only thing on it, so this is a
    // key light for the emblem that touches nothing else in the valley.
    //
    // `enable`, not `set`: the logo needs layer 0 as well or the camera — which
    // only looks at 0 — stops seeing it.
    if (opts.logoLight && opts.logoLayer !== undefined) {
      const layer = opts.logoLayer
      logo.traverse((n) => {
        n.layers.enable(layer)
      })
      const key = new THREE.SpotLight(0xffffff, opts.logoLight.intensity)
      key.name = 'title-logo-key'
      key.position.copy(opts.logoLight.position)
      key.distance = opts.logoLight.distance
      key.angle = opts.logoLight.angle
      key.penumbra = 0.35
      // No inverse-square falloff. Unity's 2016 pipeline is not physical and
      // its intensity is a multiplier, so a physical decay over 37 m would
      // throw the number away and need a second one invented to undo it.
      key.decay = 0
      key.layers.set(layer)
      key.target.position.copy(opts.logoAt ?? centre)
      object.add(key)
      object.add(key.target)
    }
  }

  // ── the monument ────────────────────────────────────────────────────────
  //
  // The stand-in, for when the logo mesh is not on disk. A faceted slab on a
  // plinth, eight sides like the launch platform and the holotable plinth.
  const monument = new THREE.Group()
  monument.name = 'title-monument'
  monument.position.copy(centre)
  monument.rotation.y = opts.facing

  // Lit by its own emissive floor, not by the scene. `int_01`'s sun is 4
  // degrees above the horizon and the monument faces AWAY from it — the first
  // build came out a black trapezoid against a pink sky. The clouds took the
  // same fix for the same reason (DEV-028): a stylised sky needs a floor under
  // its shadows or everything facing away is a silhouette.
  const stoneMaterial = new THREE.MeshStandardMaterial({
    color: 0x4a5361,
    emissive: 0x222932,
    roughness: 0.88,
    metalness: 0,
    flatShading: true,
  })
  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(
      MONUMENT_WIDTH * 0.42,
      MONUMENT_WIDTH * 0.56,
      MONUMENT_HEIGHT * 0.3,
      8,
    ),
    stoneMaterial,
  )
  plinth.position.y = MONUMENT_HEIGHT * 0.15
  monument.add(plinth)
  monument.visible = !opts.logo

  // ── the wordmark ────────────────────────────────────────────────────────
  //
  // On a canvas, unlit, standing proud of the plinth. Unlit because a title is
  // a title: `int_01`'s sun is 4 degrees above the horizon and a lit sign at
  // this hour would be a dark sign.
  const canvas = document.createElement('canvas')
  canvas.width = 2048
  canvas.height = 512
  const ctx = canvas.getContext('2d')
  const paintWordmark = (ctx: CanvasRenderingContext2D) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = INK
    ctx.font = uiFont(168, 800)
    ctx.fillText(opts.title.toUpperCase(), canvas.width / 2, 190, canvas.width * 0.94)
    ctx.fillStyle = ACCENT
    // The edition's name, in the HUD's face like the prompt's (DEV-610).
    ctx.font = subtitleFont(78)
    ctx.fillText(opts.subtitle.toUpperCase(), canvas.width / 2, 340, canvas.width * 0.9)
  }
  if (ctx) paintWordmark(ctx)
  const wordTexture = new THREE.CanvasTexture(canvas)
  wordTexture.colorSpace = THREE.SRGBColorSpace
  wordTexture.anisotropy = 4
  const wordmark = new THREE.Mesh(
    new THREE.PlaneGeometry(MONUMENT_WIDTH, MONUMENT_WIDTH / 4),
    // `toneMapped: false` — the game's own name, drawn on a canvas in sRGB.
    // See `render/tone.ts` (DEV-081). The STONE it sits on is scene geometry
    // and keeps the curve.
    new THREE.MeshBasicMaterial({ map: wordTexture, transparent: true, toneMapped: false }),
  )
  // High enough that the plane's LOWER edge clears the prompt. The plane is a
  // quarter of its width tall, so its bottom sits 9.75 m below this - the first
  // build put it at 0.62 and the subtitle landed on top of "press A to start".
  wordmark.visible = !opts.logo
  wordmark.position.y = MONUMENT_HEIGHT * 0.82
  monument.add(wordmark)

  // The prompt, under the wordmark and smaller.
  const promptCanvas = document.createElement('canvas')
  promptCanvas.width = 1024
  promptCanvas.height = 128
  const pctx = promptCanvas.getContext('2d')
  const paintPrompt = (pctx: CanvasRenderingContext2D) => {
    const size = TITLE_SUBTITLE_PX
    pctx.clearRect(0, 0, promptCanvas.width, promptCanvas.height)
    pctx.textAlign = 'center'
    pctx.textBaseline = 'middle'
    // The HoverJet HUD's face, CRYSTAL, once it has loaded (DEV-610).
    pctx.font = subtitleFont(size)
    // 2016's drop shadow, drawn as a second pass rather than with
    // `ctx.shadowBlur`: Unity's `Shadow` is a hard copy of the glyph at an
    // offset, not a blur, and a blurred one under a low-contrast prompt is the
    // sludge ditch in miniature. See `LABEL_2016`.
    pctx.fillStyle = LABEL_SHADOW_2016
    pctx.fillText(
      opts.prompt.toUpperCase(),
      512 + LABEL_SHADOW_X * size,
      64 - LABEL_SHADOW_Y * size,
      980,
    )
    pctx.fillStyle = LABEL_2016
    pctx.fillText(opts.prompt.toUpperCase(), 512, 64, 980)
  }
  if (pctx) paintPrompt(pctx)
  const promptTexture = new THREE.CanvasTexture(promptCanvas)
  promptTexture.colorSpace = THREE.SRGBColorSpace
  // A canvas does not wait for a font. A title built while CRYSTAL is still on
  // its way draws in the fallback and owes itself one paint when it lands,
  // as the HUD's panels do (`render/hud-font.ts`). A re-upload of the same
  // texture, never a new program.
  let disposed = false
  whenHudFontSettles(() => {
    if (disposed) return
    if (pctx) paintPrompt(pctx)
    promptTexture.needsUpdate = true
    if (ctx) paintWordmark(ctx)
    wordTexture.needsUpdate = true
  })
  const prompt = new THREE.Mesh(
    new THREE.PlaneGeometry(MONUMENT_WIDTH * 0.7, MONUMENT_WIDTH * 0.0875),
    // The one line of type on the screen. Not tone-mapped — DEV-081.
    new THREE.MeshBasicMaterial({ map: promptTexture, transparent: true, toneMapped: false }),
  )
  // Between the wordmark and the monument's top, with clearance from both. The
  // first build sat it at 0.36 of the height, which is 12 m against a plinth
  // that tops out at 10 — close enough to read as part of the stone.
  // The prompt belongs to the SCREEN, not to the monument — it is the only
  // type on it, and hiding it with the stand-in left a title screen you
  // could not start. Parented to the group and placed under whichever of the
  // two is actually showing.
  const promptAnchor = opts.logoAt ?? centre
  // ── Down onto the valley floor, in front ─────────────────────────────────
  //
  // It used to sit ABOVE the emblem, on the reasoning that below the logo is
  // hillside — the valley closes in behind it — and a prompt inside a hillside
  // is a title screen nobody can start. That is true AT THE LOGO'S DISTANCE and
  // false nearer the camera, which is the part the first build missed: bring it
  // forward and there is open valley floor under it the whole way.
  //
  // Matt circled that foreground, low and centre, and asked for the prompt
  // there. So it is placed in the CAMERA's frame rather than the logo's —
  // a fraction of the way along the sightline, and a fixed angle below it —
  // which is what makes it land in the same part of the picture no matter what
  // the lift does to the absolute heights (see `TITLE_VALLEY_OFFSET` in
  // `boot/app.ts`; 2016's own camera y does not survive the trip).
  const toAnchor = new THREE.Vector3().copy(promptAnchor).sub(opts.eye)
  const flatRange = Math.hypot(toAnchor.x, toAnchor.z)
  const sightPitch = Math.atan2(toAnchor.y, flatRange)
  const promptRange = flatRange * PROMPT_RANGE_FRACTION
  prompt.position.set(
    opts.eye.x + (toAnchor.x / flatRange) * promptRange,
    opts.eye.y +
      Math.tan(
        sightPitch -
          (phoneUi.on ? (PROMPT_PHONE_BELOW_DEG * Math.PI) / 180 : PROMPT_BELOW_SIGHTLINE),
      ) *
        promptRange,
    opts.eye.z + (toAnchor.z / flatRange) * promptRange,
  )
  object.add(prompt)
  object.add(monument)

  // Turn the two canvases to face the eye, in WORLD space and after the group
  // is placed. The first build set a local `rotation.y = Math.PI` on each and
  // reasoned that the monument's own yaw would carry them round — it carried
  // them the other way and the title screen had no title on it. `lookAt`
  // composes through the parent; a hand-derived local yaw does not.
  object.updateMatrixWorld(true)
  for (const face of [wordmark, prompt]) {
    face.lookAt(opts.eye.x, face.getWorldPosition(new THREE.Vector3()).y, opts.eye.z)
  }
  // Sized to the LOGO, not to the monument. The plate is cut for something 95 m
  // away; 2016's logo is 25.8 m out and 14.7 m wide, so the prompt is matched
  // to that width — at full size it was a banner across the whole sky.
  //
  // `LOGO_MESH_WIDTH` is asserted by `convert-fbx.py` on every run as the
  // `logo_polys` job's expected size, so the two cannot drift.
  if (opts.logoAt) {
    // `* PROMPT_RANGE_FRACTION` because the plate moved CLOSER: holding its
    // metre size would have made it grow across the frame by exactly the amount
    // it came forward. Angular size is what was being chosen here.
    prompt.scale.setScalar(
      ((17.97 * (opts.logoScale ?? 1)) / (MONUMENT_WIDTH * 0.7)) * PROMPT_RANGE_FRACTION,
    )
  }

  // DEV-894: a phone's edition line is larger (`phone-floor.ts`).
  if (phoneUi.on) prompt.scale.multiplyScalar(PROMPT_PHONE_SCALE)

  // ── where the rig points: along the bearing, and LEVEL ──────────────────
  //
  // `forward` is the SAME vector the monument was placed along a hundred lines
  // up, so there is one expression in this file for "which way you are facing"
  // and the pose cannot drift from the layout. `levelGaze` says why this is not
  // a `lookAt` at the emblem any more (DEV-068).
  //
  // Both paths get the same pose. The stand-in monument used to be aimed at
  // `0.55 * MONUMENT_HEIGHT` up its own plinth; two poses for two paths is two
  // things to keep level, and the fallback is not the screen anyone ships.
  const quaternion = levelGaze(forward)

  let clock = 0
  /**
   * The jets `update` last touched, so `setVisible(false)` can un-hide them.
   *
   * Held rather than re-derived because the caller owns the array — it is
   * `racers.group.children` — and the title has no other route back to it. Read
   * ONLY on the way down, never across frames for a position: these are the
   * caller's objects, not a scratch vector (trap 19).
   */
  let lastJets: readonly THREE.Object3D[] = []
  const _pos = new THREE.Vector3()
  const _next = new THREE.Vector3()

  /**
   * The scripted path: a banked circuit around the monument.
   *
   * A circuit rather than a straight pass, because a straight pass has to be
   * respawned and a circuit does not — and because 2016's own menu ships
   * `npc_aiShip` walking a closed Curvy spline, which is the same answer.
   */
  // Around whatever the screen is actually about, at that thing's own scale.
  const passCentre = opts.logoAt ?? centre
  const passRange = Math.hypot(passCentre.x - opts.eye.x, passCentre.z - opts.eye.z)
  const passRadius = passRange * PASS_RADIUS
  const passHeight = passRange * PASS_HEIGHT
  // ── 2016's own paths, when we have them ─────────────────────────────────
  //
  // One LANE per ship: its curve and the `InitialF` its own walker carries.
  // `flypastCurve` above builds each one. `getPointAt` walks it by ARC LENGTH,
  // which is the one deliberate departure: Curvy's `f` is spline parameter
  // rather than distance, so a constant `f` rate slows in the long spans. Arc
  // length gives a constant SPEED, which is what a ship does, and the lap time
  // is 2016's either way. The cost is that `initialF` lands 201.7 m (path_ai_02)
  // and 156.0 m (path_ai) from Curvy's own point — DEV-215, left alone.
  const lanes = (opts.flypaths ?? [])
    .filter((lane) => lane.path.length > 0)
    .map((lane) => ({ curve: flypastCurve(lane.path), initialF: lane.initialF }))
  const at = (
    lane: { readonly curve: THREE.CatmullRomCurve3 } | undefined,
    t: number,
    out: THREE.Vector3,
  ): THREE.Vector3 => {
    if (lane) return lane.curve.getPointAt(((t % 1) + 1) % 1, out)
    const a = t * Math.PI * 2
    return out.set(
      passCentre.x + Math.cos(a) * passRadius,
      opts.eye.y + passHeight + Math.sin(a * 2) * passHeight * 0.35,
      passCentre.z + Math.sin(a) * passRadius,
    )
  }
  const lapSeconds = lanes.length ? TITLE_2016.flypathLapSeconds : PASS_SECONDS

  return {
    object,
    eye: opts.eye.clone(),
    quaternion,
    setVisible(visible: boolean) {
      object.visible = visible
      // Put every jet's own flag back. `update` hides each one past the number
      // 2016 flew, so a caller that LENDS its ships would otherwise get them
      // back hidden — which is what happened when these were the mission
      // racers' meshes and a mission raced an invisible opponent (DEV-155).
      //
      // The shipped caller does not lend any more: since DEV-281 the title
      // loads its own two and parents them under `object`, so this is restoring
      // flags on things their parent is about to hide anyway. Kept, because
      // `update`'s contract is still *"I fly what I am handed and own none of
      // it"* and the day something lends again is not a day to rediscover this.
      if (!visible) for (const jet of lastJets) jet.visible = true
    },
    update(seconds: number, jets: readonly THREE.Object3D[]) {
      clock += seconds
      // ── One ship per 2016 path, or all of them on the circuit ───────────
      //
      // `main_menu.unity` flies TWO ships on TWO splines — `npc_aiShip` on
      // `path_ai_02` and `npc_aiShip_02` on `path_ai` — so two jets get lanes
      // and anything past that is hidden. DEV-155 flew one because two ships on
      // ONE path read nose-to-tail; with a lane each, measured, they are never
      // within 344 m of one another. `visible` is restored the moment the screen
      // goes down — `setVisible(false)` above — because these are the RACERS'
      // meshes on loan and a mission that started with one of them hidden would
      // be missing an opponent.
      //
      // Fewer jets than lanes is the real case on a Classic rookie course, which
      // authors no AI pad at all: `min` means the lanes fill in 2016's own
      // order, and `path_ai_02` — `npc_aiShip`, the closer pass and the more
      // on-screen time — is first for exactly that reason.
      const flown = lanes.length ? Math.min(lanes.length, jets.length) : jets.length
      jets.forEach((jet, i) => {
        if (i >= flown) {
          jet.visible = false
          return
        }
        jet.visible = true
        const lane = lanes[i]
        // One call for both fractions, because "a little ahead, for the
        // heading" is ahead in the DIRECTION OF TRAVEL — a jet pointed at where
        // it IS has no heading at all (the bug the diorama's jets had first),
        // and a jet pointed at where it HAS BEEN flies tail-first, which is
        // worse. `FLYPAST_DIRECTION` owns both, so they cannot drift apart.
        //
        // On a lane the start is that walker's own `InitialF`; on the fallback
        // circle it is an even share, because a circle has no measured start and
        // jets stacked on one point are not a flypast.
        const f = flypastFractions(clock, lapSeconds, lane ? lane.initialF : i / Math.max(1, flown))
        at(lane, f.at, _pos)
        at(lane, f.ahead, _next)
        jet.position.copy(_pos)
        // Bank into the turn, with the sign that belongs to the direction.
        aimShip(jet, _next, FLYPAST_ROLL)
      })
      lastJets = jets
    },
    dispose() {
      disposed = true
      wordTexture.dispose()
      promptTexture.dispose()
      disposeTree(object)
    },
  }
}
