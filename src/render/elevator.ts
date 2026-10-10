// src/render/elevator.ts — the platform you ride, and the shaft you ride past.
//
// ── 2016's geometry when it lands, and FF2's until then ───────────────────
//
// The platform is `Converted_Faceted_Meshes/Projector04-Faceted.asset` and the
// shaft is `_pwn` conversions under `FF_WorldTour/meshes/converted/` —
// PolyWorld derivatives, bought Asset Store geometry. This file was written
// when CLAUDE.md's rule 7 said bought geometry could not ship, so it built its
// own at 2016's measurements: `spawn.launch.platform.size` is the mesh's own
// `m_LocalAABB` times its prefab scale — 9.35 x 1.75 x 9.28 m — and the offsets
// are the prefab's transforms.
//
// Rule 7 was revised on 2026-09-23: bought geometry ships to players from R2,
// and only git is closed to it. So since DEV-438 the lift and the shaft you see
// are 2016's own — `render/hangar-art.ts`'s `createLaunchArt` builds them out of
// `hangar-room.glb`, the level-select room's file, and hands them to `dress()`.
// Everything generated below STAYS, by choice: it is what stands when that
// file does not load (an offline R2, a missing asset), it is what the collars
// that place the whoosh belong to, and it is the tube the bore's numbers
// (`rimY`, `boreRadius`) and the specs that measure the bore are read off.
//
// ── The shaft SHIPPED as one segment, not eight ───────────────────────────
//
// `PlayerStart_ElevatorShaft_Photon` authors eight, spaced 12 m apart from y=12
// to y=96, and **seven are `m_IsActive: 0`**. Only `ent_elevatorShaft_08` at the
// top ships. So 2016's 106 m ride is mostly open air with a collar of structure
// near the end. The port builds all eight (DEV-024c, below) and, since DEV-106,
// the WALLS between them — 2016's segment mesh is `walls_and_pillars_pwn`, and
// for four sessions this file drew the pillars and not the walls, so the ride
// was a climb past posts with the world showing through every gap. See the
// walls block in `createElevator` for the geometry and `revealRiseFor` for what
// a sealed tube changes about the reveal.
//
// ── What it is MEANT to be ────────────────────────────────────────────────
//
// Matt, 2026-09-10: "you started in an underground hangar and rode the shaft up.
// Very inspired by Evangelion."
//
// So the ride is the mission's establishing shot, not filler — which is also why
// the spawn marker is 95 m underwater and why its absence read as a fog bug
// twice. The shipped one segment does not deliver that; seven more are sitting
// right there, disabled. Restoring them would be a deliberate deviation TOWARD
// the intent and AWAY from the shipped build, and that is a call for the
// creative director rather than for this file.

import * as THREE from 'three'
import { LAUNCH } from '@/generated/constants.generated'
import { generateShaft, type HangarSpec, shaftSpecFor } from '@/sim/hangar'
import { INSTRUMENT_ACCENT } from './instrument-colour'
import { disposeTree } from './scene-walk'

/**
 * Metres of rise at which the world is drawn: 2016's `trigger_enableTerrain`.
 *
 * ── The mechanism, which is 2016's and not an invention ───────────────────
 *
 * `FF_WorldTour/scripts/Trigger_EnableTerrain.cs`
 * (guid `6a3ed645b3295b74cb5875765964ee28`):
 *
 *     public GameObject   disabledUntilTriggered;   // the TERRAIN
 *     public Collider     disabledCollision;
 *     public GameObject[] disableAfterTriggered;    // the shaft and the room
 *     void Start(){ if (multiplayer || PlayerPrefs["Respawning"] == "true")
 *                     disabledUntilTriggered.SetActive(true); }
 *     void OnTriggerEnter(Collider other){ if (other.CompareTag("Player")) {
 *         disabledUntilTriggered.SetActive(true);
 *         disabledCollision.enabled = true;
 *         foreach (var o in disableAfterTriggered) o.SetActive(false);
 *         this.gameObject.SetActive(false); } }
 *
 * So the environment is **inactive while you are in the shaft**, and the lift
 * breaking the surface is what switches it on and the shaft off. That is how a
 * 106 m climb through solid rock is a shot rather than a bug: in 2016 there was
 * no rock in the scene to climb through.
 *
 * ── The height, EXTRACTED ─────────────────────────────────────────────────
 *
 * `LAUNCH.reveal.triggerLocalY`, generated: the `m_LocalPosition.y` of
 * `trigger_enableTerrain`'s Transform `&453144` on
 * `Prefabs/PlayerStart_ElevatorShaft_Photon_02.prefab` (guid
 * `5f39b378daf6487449c9bb0c16e3f712`), whose parent `&489640` is
 * `Position_adjustment` at y −100. The trigger is a `BoxCollider`
 * `m_IsTrigger: 1` of 1 m cubed scaled to 20.12 x 2.38 x 17.50 m with its
 * `MeshRenderer` `m_Enabled: 0`, so nothing draws it. It was a hand-typed
 * `100.4` here for four sessions; DEV-094 §6 flagged that and this is the
 * promotion. **Never edit the number — run `pnpm extract:constants`.**
 *
 * `Position_adjustment` is the frame the shaft segments and the launch clip are
 * already authored in, so a height in it is directly comparable with a rise.
 * The reveal lands 6.247 m below the 106.647 m release, with the platform
 * easing to a stop: the eye clears the ground and the world is there.
 *
 * ── What this number is NOT, stated because it reads like it is ───────────
 *
 * It is the trigger BOX CENTRE's height in that frame, and **not a rise.** The
 * clip drives `Elevator_animator`, which rests at
 * `LAUNCH.reveal.animatedNodeRestY` = 1.32 m up in the same frame, so comparing
 * `rise` straight against the centre fires **1.32 m late** — and against the
 * box's lower face, which is what Unity's `OnTriggerEnter` would actually see,
 * 2.51 m late. Ridden on the fixed step that is **98 ms** of a 15.47 s climb
 * (12.407 s against 12.310 s on `int_01_hoverJet`), which is why closing it
 * would be a gameplay call with a row of its own rather than part of a
 * promotion. `launch-reveal.test.ts` pins the gap so it cannot drift unnoticed.
 *
 * ── Why the port has to finish the sentence ───────────────────────────────
 *
 * Resolved through `m_Modifications` in all thirteen shipped scenes,
 * `disabledUntilTriggered` is **null in every one** — only
 * `rookie_01_hoverJet.unity` even carries the override and its value is
 * `objectReference: {fileID: 0}`. Where it IS wired, in
 * `FF_WorldTour/scenes/experimental/elevator_shaft_workshop.unity`, it points at
 * `_sw_elevtest_terrain-Scene-Chunk11`, a terrain GameObject authored
 * `m_IsActive: 0`. The duplicated scenes (`*_b`, the gliders, `recordNPCs`)
 * carry references that now land on one arbitrary active chunk. So the
 * mechanism, the placement and the intent are 2016's; the terrain half of the
 * wiring had rotted by the 2016-12-30 backup. DEV-094.
 *
 * And it had rotted further than that row knew. Of the seven rigs, only FOUR
 * carry a live copy of the trigger — `adv_02_hoverJet` has `m_IsActive: 0` on
 * the GameObject and `hoverJet_kauai_beg` and `int_01_hoverJet` have
 * `m_Enabled: 0` on the component, all three sitting 95 m lower in the rig
 * root's frame from an older generation of the prefab. The four that are live
 * agree to a float32 ulp, which is what makes this ONE constant rather than
 * thirteen rows of level data. `STRUCTURAL.launchReveal` is the census.
 */
export const REVEAL_RISE: number = LAUNCH.reveal.triggerLocalY

/**
 * Whether the mission's world may be drawn yet.
 *
 * `hasLaunch` false — the six JumpSeat missions, which spawn on their own
 * sprung legs with no shaft — is always revealed: there is no ride to be inside
 * of, and a predicate that forgot that would hide the world for a whole
 * mission.
 *
 * Note what falls out rather than being written: with the ride skipped
 * (`?ride=0`, and every retry after the first launch) `createLaunch` and
 * `resetLaunch` both put `rise` at `topRise` on the FIRST frame, so this is true
 * before anything is pressed. That is `Trigger_EnableTerrain.Start()`'s
 * `PlayerPrefs["Respawning"] == "true"` branch exactly — 2016 turns the terrain
 * straight back on for a respawn, because a respawn does not ride.
 */
export const worldRevealed = (
  rise: number,
  hasLaunch: boolean,
  revealRise: number = REVEAL_RISE,
): boolean => !hasLaunch || rise >= revealRise

/**
 * The rise the LAND comes on at, for a shaft whose walls are sealed.
 *
 * ── Why 2016's number is a floor and not the answer ───────────────────────
 *
 * `REVEAL_RISE` was authored against an open shaft: the trigger sits where the
 * eye clears the ground, and what the ground does INSIDE the bore did not
 * matter because there was no bore, only pillars. With walls (DEV-106) the
 * shaft is a sealed tube and the only world the eye can see from inside it is
 * whatever crosses the tube's own volume — and on `rookie_01_hoverJet` the
 * hillside crosses it at 98.84 m in the platform's frame, which is **0.6 m
 * above the deck** at the moment 2016's trigger fires (deck top = rise − 2.2).
 * Add the generator's ±`randomOffset` jitter and the facets stand 1.4 m proud
 * of the deck, at the ship's belly, for a third of a second. Censused across
 * all seven rigs over a 24 × 7 polar sample of the bore (2026-09-14):
 *
 *     rookie_01  alpine   98.84 .. 98.84     int_02  alpine   95.42 .. 95.62
 *     rookie_02  desert   93.20 .. 94.62     adv_01  desert   93.20 .. 94.62
 *     kauai      kauai    82.42 .. 95.40     int_01 / adv_02  seabed, −35 / −42
 *
 * So the land waits until the deck is above the highest ground in the bore,
 * plus the jitter, and on six of the seven that is 2016's own 100.4 exactly.
 * On rookie_01 it is 101.84 — 1.4 m and about 0.3 s later, with the eye still
 * 1.7 m under the rim, so nobody sees the difference. The sea is handled the
 * other way, in the water shader: `render/water.ts` `setShaftBore`.
 *
 * `boreGroundTop` is the highest collision-surface height under the bore, in
 * the platform's RESTING frame (world height minus the anchor's), or null for
 * a mission whose bore has no ground in it. `deckDrop` is how far the deck's
 * top sits below the ship's origin (`shipOffset.y − platform.offset.y`, 2.2 m
 * on every rig), and `jitter` is the terrain generator's `randomOffset`.
 */
export const revealRiseFor = (
  boreGroundTop: number | null,
  deckDrop: number,
  jitter: number,
): number =>
  boreGroundTop === null ? REVEAL_RISE : Math.max(REVEAL_RISE, boreGroundTop + jitter + deckDrop)

// ── The light blocker (DEV-564) ──────────────────────────────────────────
//
// Matt, 2026-10-01: *"can you add a "light blocker" to the elevator shaft in
// all missions? right now the sun is affecting the cockpit when the ship is
// underground."* It was. The mission has ONE sun (`boot/app/lighting.ts`), and
// nothing between it and the ship at the bottom of a 106 m shaft: Classic draws
// no shadows at all, and Anniversary's map is fitted round the camera for the
// world, not for a tube 100 m under it. The shaft itself is unlit and baked
// (DEV-438), so the sun showed on exactly two things down there, the hull and
// the cockpit, lit from four degrees above a horizon they were 100 m below.
//
// So the sun's contribution FADES with the eye's depth in the shaft, by
// intensity, which is a uniform: no light leaves the scene (a light's COUNT is
// in every lit program's key, CLAUDE.md, DEV-186) and nothing recompiles. That
// is right in a headset too: it is one number on one light, the same in both
// eyes, where an occluder would be a shadow that exists only inside the shadow
// camera's box and on Anniversary only.
//
// The geometry is the bore's. Looking from the shaft's axis toward the sun, the
// wall is `boreRadius` away, so a sun at elevation `e` reaches an eye at most
// `boreRadius * tan(e)` under the rim: about 0.5 m on `int_01` (4 degrees) and
// 7 m on `rookie_01` (46.5). Below that the sun is blocked. And then a soft
// edge, `SHAFT_SUN_EDGE`, so the light comes on over the last metres of the
// climb rather than in one frame, which the hull's own size argues for as well:
// the canopy and the tail clear the rim before and after the eye does.

/**
 * Metres of climb over which the sun comes on, below the deepest point it can
 * reach. A comfort and hull-size margin, not a measurement: at the clip's
 * closing speed on `int_01` it is about a third of a second.
 */
export const SHAFT_SUN_EDGE = 2

/**
 * How much of the sun reaches the ship at `rise` (0 blocked, 1 full), for a
 * shaft whose rim is at `rimY` and whose bore is `boreRadius`, both in the
 * platform's RESTING frame, where the ship's origin stands at `rise` and the
 * eye `eyeY` above it. `sunDirection` is the level's: the way the light
 * TRAVELS. A mission with no shaft (`rim` null) is never blocked.
 */
export const shaftSunGain = (
  rise: number,
  rim: { readonly rimY: number; readonly boreRadius: number } | null,
  eyeY: number,
  sunDirection: readonly number[],
): number => {
  if (!rim) return 1
  const depth = rim.rimY - (rise + eyeY)
  const elevation = Math.asin(Math.min(1, Math.max(-1, -(sunDirection[1] ?? 0))))
  const reach = elevation > 0 ? rim.boreRadius * Math.tan(elevation) : 0
  return 1 - THREE.MathUtils.smoothstep(depth, reach, reach + SHAFT_SUN_EDGE)
}

export interface ElevatorSpec {
  readonly platform: {
    readonly size: readonly number[]
    readonly offset: readonly number[]
    readonly shipOffset: readonly number[]
  }
  readonly shaft: {
    readonly liveSegmentLocalY: readonly number[]
    /**
     * The seven segments 2016 authored and then DISABLED, y = 12..84.
     *
     * Built anyway. See the note in the constructor: DEV-024c.
     */
    readonly deadSegmentLocalY?: readonly number[]
    readonly segmentSpacing: number
  }
  /** Metres the platform travels. The shaft is drawn against this. */
  readonly rise: number
  /**
   * The room the shaft rises out of. Its bore is the tube's radius, its sides
   * and jitter are the tube's, and its ceiling is where the tube's foot goes.
   */
  readonly hangar: HangarSpec
  /** Seed for the walls' jitter. The room's, so the two crunch alike. */
  readonly seed: number
}

export interface Elevator {
  readonly object: THREE.Object3D
  /**
   * The shaft collars, lowest first — the lips the platform rises through.
   *
   * Exposed because they are where 2016's whoosh comes FROM. `Trigger_PlaySound`
   * boxes sit one per shaft segment in `PlayerStart_ElevatorShaft_Photon.prefab`
   * — eight of them, all live, all `soundName: whoosh`, 12 m apart and sharing
   * one x/z, i.e. a vertical column on the shaft axis — and
   * `Trigger_PlaySound.cs:12` emits at `this.transform.position` through
   * `PlaySound3DAtVector3`. So the cue sweeps from overhead to underfoot as you
   * climb, and it needs a world point rather than a cue id. AUD-5.
   *
   * These are the live scene objects, so `getWorldPosition()` on one is correct
   * after the anchor has been placed. Nothing else may write to them.
   */
  readonly collars: readonly THREE.Object3D[]
  /**
   * The mouth of the shaft, in the platform's resting frame — where the deck's
   * top surface arrives at the end of the ride. `rise + offset.y − shipOffset.y`.
   */
  readonly rimY: number
  /** The bore, in metres. The walls' radius and the sea's hole. */
  readonly boreRadius: number
  /**
   * The platform's rise on this FIXED STEP, in metres above its resting place.
   *
   * Places it there at once, so a caller that never renders sees the sim's own
   * number, and keeps the step before so `render` can draw between the two.
   * The first call after construction has no step before it and collapses onto
   * itself, as the ship's first pose does: a lift built at the top (`?ride=0`)
   * does not streak up from the floor on its first frame.
   */
  setRise(rise: number): void
  /**
   * Draw the platform `alpha` of the way from the last step's rise to this
   * one's — the frame's interpolation, the same number `flight.render` draws
   * the ship and the eye with. Once per rendered frame, after the fixed steps.
   *
   * ── DEV-445: why the platform needs a render half at all ────────────────
   *
   * Matt, 2026-09-27: *"the "elevator" model is very jittery during the
   * elevator ride up."* It was. `setRise` is called on the fixed step and was
   * the only thing that placed the platform, so the deck was drawn at the
   * sim's CURRENT step while the ship on it — and the eye in the ship — was
   * drawn `1 - alpha` of a step behind, interpolated (CLAUDE.md rule 5). The
   * eye's height over the deck therefore moved by `(1 - alpha)` of one step's
   * climb every frame: up to 0.20 m, one step at the clip's 16.6 m/s peak
   * (the Hermite overshoots its keys' 14.57), sawing as `alpha` beat against
   * the display. At 81.967 Hz, where
   * `alpha` holds still, it did not; at 60, 90 and 120 Hz it did. It had done
   * so since the ride was written — the fixed-step `setRise` is in `e5c89af`,
   * the tree's first commit — and under the generated deck exactly as under
   * 2016's, since both ride this one group. Why it was first reported the day
   * after DEV-438 stood 2016's deck here is not established.
   *
   * `tests/e2e/lift-judder.spec.ts` measures it; the player's ghost had the
   * same shape and the same cure (DEV-371, in `boot/app.ts`).
   */
  render(alpha: number): void
  /**
   * The ride is over and the ship has flown.
   *
   * 2016's `disableAfterTriggered`: the seven segments it authored and
   * disabled go off, the live one stays, and so do the walls — the shaft head
   * is a structure you can see from the air on five of the seven rigs, and a
   * tube that vanished at release would vanish under the ship. The platform
   * goes too: on four rigs the start grid draws its own pad in the same place.
   */
  setReleased(released: boolean): void
  /**
   * 2016's shaft and deck in place of the generated ones (DEV-438,
   * `render/hangar-art.ts`'s `createLaunchArt`).
   *
   * `shaft` is in this object's frame — the platform's resting place, which is
   * `launch-anchor`'s — and is static; `deck` is in the same frame AT REST and
   * rides with the platform from here on. Everything generated that they stand
   * in for is hidden, never removed, so the collars keep their world positions
   * for the whoosh, `elevator-shaft-wall` keeps its geometry for the specs that
   * measure the bore by it, and nothing here moves `rimY` or `boreRadius`.
   *
   * 2016's shaft does the walls' job, so it outlives the release the way the
   * walls did; the deck goes with the platform.
   *
   * `lid` (DEV-460, `render/lift-seal.ts`): the lift's column closed at the
   * shaft's hatch, static like the shaft, and drawn only while the platform is
   * not — the deck plugs the hatch until the release, and the lid from then on.
   */
  dress(art: {
    readonly shaft: THREE.Object3D
    readonly deck: THREE.Object3D
    readonly lid?: THREE.Object3D | null
  }): void
  dispose(): void
}

/**
 * The faceted look, in one place.
 *
 * `flatShading` is the whole art style: one normal per face, hard creases, no
 * smoothing. The terrain gets it from fully split vertices; a primitive gets it
 * from this flag, which is the same result by a cheaper route.
 */
const facetedMaterial = (color: number, roughness: number): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, flatShading: true })

/**
 * Build the platform and the one live shaft segment.
 *
 * Everything is positioned in THREE space relative to the SHIP: the caller has
 * already placed the ship, and `shipOffset` is what the prefab puts between the
 * animated node and `PlayerShipRoot`. So the platform hangs below the ship by
 * `offset - shipOffset` and rides with it.
 */
export const createElevator = (spec: ElevatorSpec): Elevator => {
  const object = new THREE.Group()
  object.name = 'launch-elevator'

  const [width, thickness, depth] = spec.platform.size as [number, number, number]
  const radius = Math.max(width, depth) / 2

  // ── the platform ────────────────────────────────────────────────────────
  //
  // An octagonal slab rather than a box. The 2016 mesh is a "projector" prop
  // whose footprint is near-square but chamfered, and eight sides read as
  // machined at the distance you see it from — a plain cube reads as a
  // programmer placeholder, which is what it would be.
  const platform = new THREE.Group()
  platform.name = 'elevator-platform'

  const deck = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 0.94, thickness, 8),
    facetedMaterial(0x6f7783, 0.72),
  )
  // The mesh's AABB centre sits half a thickness above its origin, so the slab
  // hangs BELOW the offset rather than straddling it.
  deck.position.y = -thickness / 2
  platform.add(deck)

  // A rim, so the edge catches the sun and the deck reads as a surface you are
  // standing on rather than a floating disc.
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 0.99, thickness * 0.16, 4, 8),
    facetedMaterial(0x39404b, 0.6),
  )
  rim.rotation.x = Math.PI / 2
  rim.position.y = -thickness * 0.12
  platform.add(rim)

  const [ox, oy, oz] = spec.platform.offset as [number, number, number]
  const [sx, sy, sz] = spec.platform.shipOffset as [number, number, number]
  // Unity -> three on the way in: z negates. The ship is the origin here, so the
  // platform sits at the prefab's offset MINUS where the ship is parented.
  platform.position.set(ox - sx, oy - sy, -(oz - sz))
  object.add(platform)

  // ── the shaft ───────────────────────────────────────────────────────────
  //
  // Static: it does not ride. Positioned relative to the platform's RESTING
  // place, so it stays put while the platform climbs past it.
  const shaft = new THREE.Group()
  shaft.name = 'elevator-shaft'
  const pillarMaterial = facetedMaterial(0x4a515c, 0.85)
  const collarMaterial = facetedMaterial(0x2b313a, 0.7)

  // ── which segments to build ──────────────────────────────────────────
  //
  // The shipped build has ONE, at the top. That was fine while the ride was cut
  // and you started at the pad: nobody ever looked down the shaft.
  //
  // With the hangar at the bottom (DEV-035) it stops being fine. The room's
  // ceiling closes at local y = 15 and the next structure is at 96, so you sit
  // in an "underground hangar" and look up through the bore into **open sky** —
  // 79 m of nothing, then the start grid and a gate hanging in daylight. It is
  // the single thing that stops the room reading as underground, and it is also
  // why the spawn looked wrong from the air: the hangar is a box at y = 18 over
  // a seabed at y = -15, with nothing around it.
  //
  // So all eight are built, live and dead alike. That is a deviation TOWARD
  // Matt's stated intent and AWAY from the shipped build — *"you started in an
  // underground hangar and rode the shaft up"* — which this file has been
  // flagging as his call since 2026-09-10. DEV-024c.
  //
  // Unconditional rather than a flag: the level JSON already carries both lists
  // (`liveSegmentLocalY` and `deadSegmentLocalY`), every mission that has a
  // shaft wants it filled, and a switch nobody would ever turn off is a switch
  // that only exists to be tested.
  const segmentYs = [...spec.shaft.liveSegmentLocalY, ...(spec.shaft.deadSegmentLocalY ?? [])].sort(
    (a, b) => a - b,
  )

  // Lowest first, because the caller walks them in the order the lift meets
  // them. `segmentYs` is already sorted, so pushing in loop order keeps it.
  const collars: THREE.Object3D[] = []
  const liveYs = new Set(spec.shaft.liveSegmentLocalY)
  const deadSegments: THREE.Object3D[] = []

  for (const localY of segmentYs) {
    const segment = new THREE.Group()
    if (!liveYs.has(localY)) deadSegments.push(segment)
    // The authored Ys are relative to `Position_adjustment`, which is where the
    // platform rests. Same frame as the platform, so the same offset applies.
    segment.position.y = localY + (oy - sy)

    // Six pillars around the shaft, outside the platform's footprint so the
    // platform passes through rather than into them.
    const ringRadius = radius * 1.45
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      const pillar = new THREE.Mesh(
        new THREE.BoxGeometry(1.1, spec.shaft.segmentSpacing, 1.1),
        pillarMaterial,
      )
      pillar.position.set(Math.cos(a) * ringRadius, 0, Math.sin(a) * ringRadius)
      pillar.rotation.y = a
      segment.add(pillar)
    }

    // A collar at the top of the segment — the lip you rise through.
    const collar = new THREE.Mesh(new THREE.TorusGeometry(ringRadius, 0.75, 4, 6), collarMaterial)
    collar.rotation.x = Math.PI / 2
    collar.position.y = spec.shaft.segmentSpacing / 2
    segment.add(collar)
    collars.push(collar)

    shaft.add(segment)
  }
  object.add(shaft)

  // ── the walls ───────────────────────────────────────────────────────────
  //
  // Matt, 2026-09-14: *"our 'elevator ride' isn't enclosed, and players can
  // see the world as they rise."* They could: six posts a segment and daylight
  // between them, which is the shipped build's one open collar repeated eight
  // times. 2016's segment mesh is `walls_and_pillars_pwn`, and the port had
  // ported the second noun. DEV-106.
  //
  // Generated in `sim/hangar.ts` like the room, from the room's own bore, and
  // in the same frame as everything else here: the platform's resting place.
  // The tube runs from a foot sunk into the room's ceiling to a rim the deck
  // arrives flush with —
  //
  //     rimY = rise + offset.y − shipOffset.y = 106.647 − 2.2 = 104.447
  //
  // — which is a DERIVED height and not a segment top, because it is the one
  // that makes the mouth a floor the lift stops at. The eye (`flight.ts`'s
  // `EYE`, 0.86 m over the ship's origin) clears that rim at rise 103.59, and
  // the world comes on at `REVEAL_RISE` = 100.4, so there are 3.2 m of climb —
  // most of a second at the clip's closing speed — in which the terrain is on
  // and the eye is still inside the tube. That order is the whole design: the
  // pop-in happens where no one can see it. `launch-reveal.test.ts` pins it.
  //
  // `DoubleSide`, unlike the room. The room is only ever seen from inside; the
  // shaft head stands 5–12 m proud of the ground on five rigs and 100 m proud
  // of the desert on `rookie_02`, and after release you can fly round it.
  const rimY = spec.rise + (oy - sy)
  const wallSpec = shaftSpecFor(spec.hangar, rimY)
  const wallMesh = generateShaft(wallSpec, spec.seed)
  const wallGeometry = new THREE.BufferGeometry()
  wallGeometry.setAttribute('position', new THREE.BufferAttribute(wallMesh.positions, 3))
  wallGeometry.setAttribute('normal', new THREE.BufferAttribute(wallMesh.normals, 3))
  wallGeometry.setAttribute('color', new THREE.BufferAttribute(wallMesh.colors, 3))
  wallGeometry.computeBoundingSphere()
  const wallMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    flatShading: true,
    side: THREE.DoubleSide,
  })
  const wall = new THREE.Mesh(wallGeometry, wallMaterial)
  wall.name = 'elevator-shaft-wall'
  object.add(wall)

  // ── the strips ──────────────────────────────────────────────────────────
  //
  // The room's strip lights, continued up the tube: one ring per segment at
  // the collar's height, six bars in the six corners the pillars leave free.
  // `MeshBasicMaterial` for the room's reason — there is no sun down here and
  // the walls are 8 % grey, so the bars are the light — and ONE instanced
  // draw for all forty-eight, because they outlive the ride.
  //
  // They are also the sense of speed. A sealed tube with nothing on the wall
  // is a tube you cannot tell you are moving in; a lit bar every twelve metres
  // is a bar a second at the clip's 14.6 m/s.
  const stripMaterial = new THREE.MeshBasicMaterial({ color: INSTRUMENT_ACCENT })
  const stripGeometry = new THREE.BoxGeometry(0.3, 2.4, 0.3)
  const STRIPS_PER_RING = 6
  const strips = new THREE.InstancedMesh(
    stripGeometry,
    stripMaterial,
    segmentYs.length * STRIPS_PER_RING,
  )
  strips.name = 'elevator-shaft-strips'
  {
    const m = new THREE.Matrix4()
    // Just inside the corner. The walls' vertices sit at `radius` on the
    // 12-gon's corners and the pillars take every other corner.
    const r = wallSpec.radius - 0.45
    let k = 0
    for (const localY of segmentYs) {
      const y = localY + (oy - sy) + spec.shaft.segmentSpacing / 2
      for (let i = 0; i < STRIPS_PER_RING; i++) {
        const a = ((i + 0.5) / STRIPS_PER_RING) * Math.PI * 2
        m.makeRotationY(-a).setPosition(Math.cos(a) * r, y, Math.sin(a) * r)
        strips.setMatrixAt(k++, m)
      }
    }
    strips.instanceMatrix.needsUpdate = true
  }
  object.add(strips)

  // ── the last two fixed steps, for the frame to draw between (DEV-445) ────
  //
  // The ship keeps the same pair (`flight.ts`'s `previous` / `current`) and is
  // advanced on the same step by `rideElevator`, the line beside the one that
  // calls `setRise`. Two pairs advanced together and drawn with one `alpha`
  // cannot disagree about where the deck is under the ship.
  let previousRise = 0
  let currentRise = 0
  let stepped = false
  /** DEV-460: the column's lid, drawn while the platform is not. See `dress`. */
  let lid: THREE.Object3D | null = null

  return {
    object,
    collars,
    rimY,
    boreRadius: wallSpec.radius,
    setRise(rise: number) {
      previousRise = stepped ? currentRise : rise
      currentRise = rise
      stepped = true
      platform.position.y = oy - sy + rise
    },
    render(alpha: number) {
      platform.position.y = oy - sy + previousRise + (currentRise - previousRise) * alpha
    },
    setReleased(released: boolean) {
      platform.visible = !released
      for (const segment of deadSegments) segment.visible = !released
      if (lid) lid.visible = released
    },
    dress(art) {
      object.add(art.shaft)
      if (art.lid) {
        lid = art.lid
        lid.visible = !platform.visible
        object.add(lid)
      }
      // The platform group is this frame moved to the resting place, and it is
      // never turned, so the deck goes in moved back by exactly that much.
      art.deck.position.set(-(ox - sx), -(oy - sy), oz - sz)
      platform.add(art.deck)
      deck.visible = false
      rim.visible = false
      // The whole generated shaft group: `setReleased` toggles its segments'
      // own flags, and a hidden parent keeps every one of them off whatever
      // those say. Their matrices still update, so the collars still place
      // the whoosh.
      shaft.visible = false
      wall.visible = false
      strips.visible = false
    },
    dispose() {
      disposeTree(object, { materials: false })
      for (const m of [pillarMaterial, collarMaterial, wallMaterial, stripMaterial]) m.dispose()
      ;(deck.material as THREE.Material).dispose()
      ;(rim.material as THREE.Material).dispose()
    },
  }
}
