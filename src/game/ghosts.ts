// src/game/ghosts.ts — the 2016 runs, flying alongside you.
//
// This is the hook the whole first release rests on (PORT_PLAN §3): you are not
// racing a time, you are racing two people who flew this course a decade ago and
// whose runs survived the engine they were recorded in.
//
// Each ghost is a recorded pose track (see `src/sim/ghost.ts`) plus the ship
// mesh, drawn translucent so it reads as a ghost rather than as traffic.
//
// ── Where a ghost is ──────────────────────────────────────────────────────
//
// Clip positions are relative to the level's `levelOffset` GameObject, which is
// exactly the `worldOffset` the level JSON already carries — the same offset the
// terrain is placed by. Verified: the first key of `int_01_leftSpawn_fast_01`
// plus `worldOffset` lands within 3 m of the ghost's own authored spawn
// transform, which is a good independent check that the clip and the world agree
// about where the start line is.
//
// ── Time ──────────────────────────────────────────────────────────────────
//
// Driven by the MISSION clock, which ticks in fixed steps — never by wall clock
// and never by frame time. A ghost that advances on frame time races a
// different course on a slow machine, and the whole point is that its run is
// comparable to yours.

import * as THREE from 'three'
import { assetUrl } from '@/content/asset-url'
import { globIds } from '@/content/glob-tree'
import type { Level } from '@/content/level-schema'
import type { EditionState } from '@/game/edition'
import { ART_POSITION, ART_SCALE, SHIP_MESH_EXTERIOR, SHIP_MODEL_YAW } from '@/game/flight'
import { ghostCourse } from '@/game/lap-run'
import { createEngineTrail, racerMaterial, trailEmitterOffset } from '@/game/racers'
import { NAME_TAG_LIFT_M, nameTag } from '@/game/remote-ships'
import { attachShipWings } from '@/game/ship-wings'
import { type CraftWingTrails, createCraftWingTrails } from '@/game/wing-trails'
import { loadMesh } from '@/render/load-mesh'
import { GHOST_RACER_BLUE_SRGB } from '@/render/racer-livery'
import { uiFontEpoch } from '@/render/ui-font'
import { measureWingTips, type WingTips } from '@/render/wing-trails'
import {
  decodeGhostClip,
  type GhostClip,
  type GhostDoc,
  type GhostPose,
  type GhostResult,
  type LapDoc,
  sampleGhost,
  scoreGhost,
} from '@/sim/ghost'

// The ghost wears the THIRD-PERSON hull — 2016's `playbackGhost/ThirdPerson (1)`
// carries exactly this mesh, and it is the whole reason the note below about
// invisible ghosts exists.
const SHIP_MESH = SHIP_MESH_EXTERIOR

/**
 * The art transform a ghost is drawn with — the SHIP's, by reference.
 *
 * Exported so a test can assert it is the same objects rather than the same
 * numbers. See the note above the import.
 */
export const GHOST_ART = {
  position: ART_POSITION,
  scale: ART_SCALE,
  yaw: SHIP_MODEL_YAW,
} as const

/**
 * Ghost recordings live in `content/ghosts/*.json` and come in the way levels
 * do — as Vite lazy imports, not through `assetUrl()`.
 *
 * They are in git, not in the R2 bucket: a ghost is small, first-party 2016
 * data that versions with the level referencing it (D12, content/MANIFEST.md
 * §3). So there is no hydration step and no 404 — a missing clip is a
 * build-time list you can print, exactly as with a mistyped level id.
 */
const clipModules = import.meta.glob<{ default: GhostDoc }>('/content/ghosts/*.json')

const clipPathFor = (clip: string): string => `/content/ghosts/${clip}.json`

/** Every ghost clip the build knows about. Sorted, so an error message is stable. */
export const ghostClipNames = (): string[] => globIds(clipModules, '/content/ghosts/')

const loadClip = async (clip: string): Promise<GhostClip> => {
  const load = clipModules[clipPathFor(clip)]
  if (!load) {
    throw new Error(
      `ghost "${clip}": no such clip in content/ghosts/. Known: ${ghostClipNames().join(', ') || '(none)'}`,
    )
  }
  return decodeGhostClip((await load()).default)
}

// The ship's art transform is `game/flight.ts`'s, IMPORTED rather than copied.
//
// It used to be copied — three identical constants in two files, with a comment
// calling an abstraction over them premature. Then `SHIP_MODEL_YAW` was
// corrected from -90 to +90 (see flight.ts for why the wrong one looked right)
// and this file's copy was not, so every ghost flew backwards for as long as
// that fix has been in. Matt spotted it exactly as he spotted the original:
// *"the ghosts are facing backwards it looks like."*
//
// The lesson is not "add an abstraction". It is that a duplicated constant has
// no way to tell you it has drifted, and a ghost pointing the wrong way looks
// like art direction.

/**
 * What a ghost DID, as opposed to where it went.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * A 2016 clip is a flight path and nothing else: the Motion Recorder saved
 * poses, not results. So under `?opponents=ghosts` the results panel had an
 * empty opponent list and the game could not say "you beat the fast ghost",
 * which is most of the point of racing a decade-old recording.
 *
 * `sim/ghost.ts` fills that in by flying the clip round the course at the sim's
 * own fixed step — no flight model, no renderer, nothing that could drift — and
 * reading off when it crosses the finish. Computed ONCE, here, at load. It must
 * never be a per-frame call, and it never needs to be: a recording's time is the
 * same on every frame of the run it is displayed on.
 */
export interface GhostStanding extends GhostResult {
  /** The clip id, e.g. `int_01_leftSpawn_fast_01`. */
  readonly clip: string
  /**
   * A label short enough for the results panel: `fast`, `slow`.
   *
   * Derived, not authored — the clip ids are `<mission>_<pad>_<pace>_<take>`, so
   * dropping a trailing take number and keeping the last segment gives the pace,
   * which is exactly the register the AI racers use (`fast`, `steady`). Falls
   * back to the whole clip id for anything that does not parse that way rather
   * than inventing a name for it.
   */
  readonly name: string
}

export interface LoadedGhosts {
  readonly group: THREE.Group
  readonly count: number
  /**
   * One standing per ghost, in clip order. Empty for `noGhosts()`.
   *
   * This is what the results panel's opponent list reads under
   * `?opponents=ghosts`, and it is the same `{ name, seconds }` shape the AI
   * racers already hand it — `seconds: null` prints DNF.
   */
  readonly standings: readonly GhostStanding[]
  /** Advance to a mission time, in seconds. */
  update(missionTime: number): void
  dispose(): void
}

/** See `GhostStanding.name`. Exported so the derivation can be pinned by a test. */
export const ghostShortName = (clip: string): string => {
  const parts = clip.split('_').filter((p) => p.length > 0)
  if (/^\d+$/.test(parts.at(-1) ?? '')) parts.pop()
  const last = parts.at(-1)
  return last === undefined || /^\d+$/.test(last) ? clip : last
}

interface GhostInstance {
  readonly clip: GhostClip
  readonly object: THREE.Object3D
  /** Seconds of mission time before this ghost starts moving. */
  readonly startTime: number
}

/**
 * A ghost you can actually see.
 *
 * Matt asked for the ghosts to be parked on the AI pads. They already were —
 * `int_01_leftSpawn_fast_01`'s first recorded sample is 1.53 m from one pad and
 * `rightSpawn`'s is 1.12 m from the other, which is the two clips telling us
 * where 2016 stood them. What was wrong is that you could not SEE them.
 *
 * ── Why they were invisible, which took three wrong guesses ───────────────
 *
 * Not culling, not the scene graph, not `visible`. Replacing the material with
 * opaque red put **1,975 pixels** on screen from the same camera that showed
 * nothing before, which settled it: they were drawing the whole time.
 *
 * The ghost wore `hoverjet-cockpit.glb`, and that mesh is a cockpit FRAME —
 * canopy struts and a dash, mostly open air. Its silhouette from outside is a
 * few thin bars, not a ship. At 42 % opacity, in pale blue, over a pale blue
 * sea, those bars carry no contrast at all.
 *
 * So: opaque enough to read, and EMISSIVE so the struts hold up against both
 * the bright sea and the dark deck rather than only one of them. Still
 * translucent, because a ghost must never be mistaken for something you can hit.
 *
 * ── And then the actual answer turned up ──────────────────────────────────
 *
 * A ghost was never meant to wear the cockpit. 2016's `playbackGhost` carries
 * its own `ThirdPerson (1)` subtree holding `hoverJet_exterior_orange` — the
 * solid outside of the same hull — and every fix above is a workaround for
 * wearing the wrong mesh. They are kept, because they were tuned by eye against
 * a ship in flight and the opacity and the emissive still do their own jobs,
 * but their REASONS have changed: this is now a solid silhouette that needs to
 * read as translucent, not a wireframe that needs to read at all.
 *
 * `DoubleSide` is the one that is now simply unnecessary — it was there because
 * the faces of a cockpit point INWARD, you sit in it, so a front-facing ghost
 * showed you its back faces. An exterior hull faces out. It is left on because
 * it is free insurance on a transparent object and taking it off is a visual
 * change nobody asked for, not because the original reason still holds.
 *
 * The ghost's look IS the racer's (`racers.ts`'s `racerMaterial`, whose header
 * says why the racers wear "the ghost's", and holds the vertex-colour and
 * depth-write reasoning that used to be repeated here). Two copies of nine
 * fields that must stay equal; code-reuse audit XC-17.
 */
const ghostMaterial = (): THREE.Material => racerMaterial()

/**
 * One ghost's ship: the exterior hull in the ghost material, wearing the ship's
 * own art transform, and its wing. Shared by the 2016 recordings and the
 * player's lap (DEV-371), so the two kinds of ghost cannot drift apart about
 * how a ghost looks — the `SHIP_MODEL_YAW` lesson above.
 */
const buildGhostObject = async (
  name: string,
  material: THREE.Material,
): Promise<{
  object: THREE.Group
  gltf: LoadedMeshHandle
  glow: { dispose(): void }
  tips: WingTips
}> => {
  const gltf = await loadMesh(assetUrl(SHIP_MESH))
  gltf.object.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (mesh.isMesh) mesh.material = material
  })
  gltf.object.position.copy(ART_POSITION)
  gltf.object.rotation.y = SHIP_MODEL_YAW
  gltf.object.scale.copy(ART_SCALE)
  // DEV-408: the wing tips, off this hull and before the wing is hung on it,
  // exactly as `racers.ts` measures its own.
  const tips = measureWingTips(gltf.object)
  // The anti-grav wing, AFTER the material traverse above, for the same
  // reason `racers.ts` puts it there: the glow's colours are the sheet's and
  // a later traverse would repaint them. The projectors wear the ghost's
  // own material — 2016's `playbackGhost` puts `holo_ghost 1.mat` on
  // `Mesh1-Combined` too (DEV-322).
  const glow = await attachShipWings(gltf.object, { projectorMaterial: material })
  const object = new THREE.Group()
  object.name = name
  object.add(gltf.object)
  return { object, gltf, glow, tips }
}

type LoadedMeshHandle = Awaited<ReturnType<typeof loadMesh>>

/**
 * Put a ghost where its clip says it is at `clipTime`. Clip positions are THREE
 * space relative to `worldOffset` for both formats (see the header).
 */
const placeGhost = (
  object: THREE.Object3D,
  clip: GhostClip,
  clipTime: number,
  worldOffset: readonly [number, number, number],
  pose: GhostPose,
): void => {
  sampleGhost(clip, clipTime, pose)
  object.position.set(worldOffset[0] + pose.px, worldOffset[1] + pose.py, worldOffset[2] + pose.pz)
  object.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw)
}

/**
 * Closer than this to the player's ship and the player's ghost is not drawn,
 * metres, centre to centre.
 *
 * Both start from ONE release pose, so at GO the ghost is exactly where you
 * are, and in the cockpit that puts the camera inside a translucent hull that
 * faces both ways (`DoubleSide`, above). It stays there for as long as the two
 * laps agree, which for a lap raced against itself is the whole lap. 6 m is
 * the hull's 4.9 m capsule (DEV-364) and a little air: the ghost appears when
 * it could no longer be touching you, if it were a thing that could touch.
 */
export const PLAYER_GHOST_NEAR_M = 6

/**
 * Seconds a player's ghost stays up after its lap ends. The lap stops on its
 * finish tick, and a ghost parked on it would hang in the finish sphere for as
 * long as the panel is up.
 */
export const PLAYER_GHOST_LINGER_S = 1

/**
 * DEV-856: the tag over a player's ghost ("YOUR GHOST 61.2") is READABLE
 * without cluttering. It is a screen-sized sprite (a fixed angle, so legible at
 * range), so it fades on distance from the player's ship: gone inside
 * {@link GHOST_TAG_HIDE_M} (it would hang in the cockpit's face; the hull
 * itself is hidden inside `PLAYER_GHOST_NEAR_M`), full by
 * {@link GHOST_TAG_FULL_M}, and fading out again past {@link GHOST_TAG_FAR_M}
 * to nothing at {@link GHOST_TAG_GONE_M}, where a ship is a dot and a label on
 * a dot is clutter. **Numbers to argue with.**
 */
export const GHOST_TAG_HIDE_M = 12
export const GHOST_TAG_FULL_M = 30
export const GHOST_TAG_FAR_M = 300
export const GHOST_TAG_GONE_M = 600

/** The tag's opacity at `distance` metres from the player: 0 near, 1 mid, 0 far. */
export const ghostTagAlpha = (distance: number): number => {
  if (distance <= GHOST_TAG_HIDE_M || distance >= GHOST_TAG_GONE_M) return 0
  if (distance < GHOST_TAG_FULL_M)
    return (distance - GHOST_TAG_HIDE_M) / (GHOST_TAG_FULL_M - GHOST_TAG_HIDE_M)
  if (distance <= GHOST_TAG_FAR_M) return 1
  return (GHOST_TAG_GONE_M - distance) / (GHOST_TAG_GONE_M - GHOST_TAG_FAR_M)
}

/** DEV-371: the player's own lap, flown as a ghost beside the racers. */
export interface PlayerGhost {
  readonly group: THREE.Group
  /**
   * The ship itself, under `group`: hidden while there is nothing to draw, so
   * the warm-up is handed THIS (its `show` makes a node visible, not its
   * children) to compile the ghost material under the curtain.
   */
  readonly object: THREE.Object3D
  /** The lap it flies, or null (then it is never drawn). */
  readonly lap: LapDoc | null
  /**
   * DEV-373: it has a pose this frame — released, and inside its lap plus the
   * linger — whether or not the near-hide took the mesh away. What the race
   * map's hollow dot follows: on the map the ghost is a place, not a hull
   * around your eye, so it stays on it when it is level with you.
   */
  readonly active: boolean
  /**
   * Fly another lap, or none. Decodes once; costs nothing per frame.
   * DEV-856: `label` is the tag over the ship (`ghostTagText`), or null for none.
   */
  setLap(doc: LapDoc | null, label?: string | null): void
  /** DEV-856: the tag over the ship, or null while there is none (for specs). */
  readonly tag: THREE.Sprite | null
  /**
   * `clock` is mission seconds since the release (`LapRun.clock`, which runs on
   * past the finish). `released` false hides it: before GO there is no race and
   * its first pose is the top of the lift you are riding. `near` is the
   * player's ship, THREE space.
   */
  update(clock: number, released: boolean, near: THREE.Vector3 | null): void
  /**
   * DEV-408: the racers' two trails, engine and wing tips, drawn from the pose
   * `update` just wrote. `dt` is the frame's, `wingDt` the wing trails' clock
   * (0 while the sim is held), as `LoadedRacers.render` takes them.
   */
  renderTrails(eye: THREE.Vector3, dt: number, wingDt: number): void
  /** The wing trails, so the caller can fog their material; null without an edition. */
  readonly wingTrails: CraftWingTrails | null
  dispose(): void
}

/**
 * The player's ghost. `doc` is an `ff2-ghost-2` lap (DEV-370), or null for a
 * course with nothing kept yet. The same instance, material and placement as a
 * 2016 recording's, and its OWN material instance, so nothing done to this one
 * reaches those.
 *
 * It is not a racer and nothing touches it: it is never handed to
 * `liveRacers.step`, so DEV-364's contact and the racers' separation never see
 * it (`sim/racer-field.ts` takes the racers and the player's body, and nothing
 * else).
 */
export const loadPlayerGhost = async (
  worldOffset: readonly [number, number, number],
  doc: LapDoc | null,
  edition?: EditionState,
): Promise<PlayerGhost> => {
  const group = new THREE.Group()
  group.name = 'player-ghost'
  const material = ghostMaterial()
  const built = await buildGhostObject('ghost:player', material)
  group.add(built.object)
  // -- DEV-408: the racers' trails, on your ghost --------------------------
  //
  // Matt, 2026-09-25: *"player ghosts should have wing-trails and engine
  // trails"*. The same factories the racers use, tinted toward 2016's
  // GhostRacer blue by the racers' rule. Both are world-space ribbons, and
  // this group sits at identity, so they hang off it. A ghost has no body,
  // only a pose clip, so the wing trails' speed fade reads a speed taken from
  // successive poses: scalar, along a unit orientation, because only its size
  // decides the fade.
  const engine = createEngineTrail(GHOST_RACER_BLUE_SRGB, edition?.current.fx.wingTrails)
  group.add(engine.trail.object)
  const body = { orientation: { x: 0, y: 0, z: 0, w: 1 }, velocity: { x: 0, y: 0, z: 0 } }
  const wingTrails = edition
    ? createCraftWingTrails(
        [{ tips: built.tips, frame: built.object, body, livery: GHOST_RACER_BLUE_SRGB }],
        'wing-trails:player-ghost',
      )
    : null
  if (wingTrails) group.add(wingTrails.trails.object)
  const trailLocal = trailEmitterOffset()
  const emitter = new THREE.Vector3()
  const lastPosition = new THREE.Vector3()
  let lastClock = -1
  const pose: GhostPose = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
  let lap: LapDoc | null = null
  let clip: GhostClip | null = null
  let active = false
  // -- DEV-856: the tag --------------------------------------------------
  //
  // Matt, 2026-10-08, the ghost named where it happens: a label floating over
  // the ship, "YOUR GHOST 61.2". The room name tag's own sprite
  // (`remote-ships.ts`), so one look and one occlusion rule: a thing IN THE
  // WORLD on layer 0 (both eyes; layers 1 and 2 are the WebXR eyes, DEV-141),
  // hidden by whatever stands in front of it. Redrawn when the text changes or
  // CRYSTAL lands, never per frame.
  let tag: THREE.Sprite | null = null
  let tagText: string | null = null
  let tagEpoch = -1
  const dropTag = (): void => {
    if (!tag) return
    group.remove(tag)
    tag.material.map?.dispose()
    tag.material.dispose()
    tag = null
  }
  const showTag = (text: string | null): void => {
    tagText = text
    dropTag()
    if (text === null) return
    tagEpoch = uiFontEpoch()
    tag = nameTag(text, GHOST_RACER_BLUE_SRGB)
    tag.name = 'player-ghost-tag'
    tag.userData.text = text
    tag.visible = false
    group.add(tag)
  }
  const setLap = (next: LapDoc | null, label: string | null = null): void => {
    showTag(next ? label : null)
    lap = next
    clip = next ? decodeGhostClip(next) : null
    built.object.visible = false
    active = false
  }
  setLap(doc)

  return {
    group,
    object: built.object,
    get lap() {
      return lap
    },
    get active() {
      return active
    },
    setLap,
    get tag() {
      return tag
    },
    update(clock, released, near) {
      if (!clip || !released || clock > clip.duration + PLAYER_GHOST_LINGER_S) {
        built.object.visible = false
        if (tag) tag.visible = false
        active = false
        lastClock = -1
        body.velocity.z = 0
        return
      }
      active = true
      // A lap starts at its release, so clip time IS mission time: no pad hold
      // to skip and no 2016 stagger.
      placeGhost(built.object, clip, clock, worldOffset, pose)
      // DEV-408: the speed the wing trails fade on, off the pose just placed.
      // A repeated clock (a held frame) keeps the last; a backwards one (a
      // restart) starts again from here.
      const step = clock - lastClock
      if (lastClock >= 0 && step > 0) {
        body.velocity.z = built.object.position.distanceTo(lastPosition) / step
      }
      if (lastClock < 0 || step !== 0) {
        lastPosition.copy(built.object.position)
        lastClock = clock
      }
      built.object.visible =
        near === null || built.object.position.distanceTo(near) > PLAYER_GHOST_NEAR_M
      if (tag) {
        if (tagEpoch !== uiFontEpoch()) showTag(tagText)
        const t = tag
        const alpha = near === null ? 1 : ghostTagAlpha(built.object.position.distanceTo(near))
        t.visible = built.object.visible && alpha > 0
        t.material.opacity = alpha
        t.position.copy(built.object.position)
        t.position.y += NAME_TAG_LIFT_M
      }
    },
    renderTrails(eye, dt, wingDt) {
      // No ghost drawn, no vapour: a hidden hull (off its lap, or around your
      // own eye) leaves nothing hanging in the air behind it.
      if (!built.object.visible) {
        engine.trail.reset()
        wingTrails?.clear()
        return
      }
      emitter.copy(trailLocal).applyQuaternion(built.object.quaternion).add(built.object.position)
      engine.trail.update(emitter, eye, dt)
      if (wingTrails && edition) {
        wingTrails.update(eye, wingDt, edition.current.fx.wingTrails, edition.speedFx, true)
      }
    },
    wingTrails,
    dispose() {
      dropTag()
      built.glow.dispose()
      built.gltf.dispose()
      material.dispose()
      engine.trail.dispose()
      engine.material.dispose()
      engine.base.dispose()
      wingTrails?.dispose()
      group.clear()
    },
  }
}

/**
 * An empty set of ghosts, for a mission that is not racing any.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * `DEV-026` made the AI racers the opponents and left the recordings behind
 * `?opponents=ghosts`. But `boot/app.ts` loaded them ANYWAY, every run, and
 * then called `dispose()` on them a few lines later when the switch was off —
 * so the default path paid for a fetch, a mesh and two clip decodes it threw
 * straight away.
 *
 * Wasteful is the smaller half. `loadGhosts` THROWS on a clip it cannot find,
 * and that throw is inside the world's `Promise.all` — so a mission whose
 * recordings have never been staged out of Unity does not quietly race nobody,
 * it fails to load at all. Eight of the thirteen shipped missions died exactly
 * there, on opponents the game was never going to show them. Matt, 2026-09-11:
 * *"on the ghosts - feel free to skip those. we're not using the ghost stuff,
 * right?"*
 *
 * Asking for them explicitly and finding them missing is still an ERROR, and
 * deliberately so: `?opponents=ghosts` on a mission with no staged clips should
 * say so rather than show an empty sky. What changes is that the default path
 * no longer depends on an asset it does not use.
 */
export const noGhosts = (): LoadedGhosts => {
  const group = new THREE.Group()
  group.name = 'ghosts'
  return {
    group,
    count: 0,
    standings: [],
    update() {},
    dispose() {},
  }
}

export const loadGhosts = async (
  level: Level,
  worldOffset: readonly [number, number, number],
): Promise<LoadedGhosts> => {
  const group = new THREE.Group()
  group.name = 'ghosts'

  const refs = level.ghosts ?? []
  const material = ghostMaterial()

  const loaded = await Promise.all(
    refs.map(async (ref) => {
      const clip = await loadClip(ref.clip)
      const built = await buildGhostObject(`ghost:${ref.clip}`, material)
      group.add(built.object)
      return { clip, clipName: ref.clip, startTime: ref.startTime ?? 0, ...built }
    }),
  )

  const instances: GhostInstance[] = loaded
  const pose: GhostPose = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }

  // ── The standings, computed ONCE ────────────────────────────────────────
  //
  // Renderer-free by construction: `scoreGhost` is a sim function and every
  // input here is level data. It runs at load, alongside the mesh fetch it is
  // three orders of magnitude cheaper than, and the answer is kept for the life
  // of the run.
  //
  // The course is `game/lap-run.ts`'s `ghostCourse`, the one the player's lap
  // is scored on too (DEV-371): the finish sphere flipped the way
  // `game/racers.ts` and `game/mission.ts` flip theirs, and a course without one
  // falling back to "every gate taken", which is `runIsOver`'s rule.
  const course = ghostCourse(level, worldOffset)
  const standings: GhostStanding[] = loaded.map((ghost) => ({
    clip: ghost.clipName,
    name: ghostShortName(ghost.clipName),
    ...scoreGhost(ghost.clip, { ...course, startTime: ghost.startTime }),
  }))

  return {
    group,
    count: instances.length,
    standings,

    update(missionTime: number) {
      for (const ghost of instances) {
        // DEV-025. `+ launchAt` skips the recording's own pre-race hold, so the
        // ghost leaves the line on the same tick the player does. Both `int_01`
        // clips sit on their pad for about seven seconds — 2016's pause, baked
        // in — and sampling from zero handed the player a seven-second lead on
        // both opponents. Matt: *"i didn't see those ghost racers at all."*
        //
        // `startTime` still applies on top: it is the shipped `GhostRacer`
        // component's own stagger (0.55 s on int_01) and it is a real 2016
        // number, where the hold is an artefact of how the runs were recorded.
        placeGhost(
          ghost.object,
          ghost.clip,
          missionTime + ghost.clip.launchAt - ghost.startTime,
          worldOffset,
          pose,
        )
      }
    },

    dispose() {
      for (const ghost of loaded) {
        ghost.glow.dispose()
        ghost.gltf.dispose()
      }
      material.dispose()
      group.clear()
    },
  }
}
