// src/game/racers.ts — the opposition, flying rather than replaying.
//
// Matt: *"let's simplify and deviate from 2016 by giving our ghosts the same
// autopilot logic we're using for the player proxy."* DEV-026.
//
// The sim is `sim/ai-racer.ts`; this is the mesh, the pads they start on, and
// the interpolation. `game/ghosts.ts` is untouched and still runs the 2016
// recordings under `?opponents=ghosts`.
//
// ── They start on the AI PADS, which is the one thing tying this to 2016 ──
//
// `spawn.startGrid.pads` carries three, tagged `player` and `ai`, extracted from
// `starting_platform` in the mission scene. The two 2016 clips are named
// `leftSpawn` and `rightSpawn` and their first recorded samples land 1.5 m and
// 1.1 m from those same two pads — so the pads are where the opposition stood
// in 2016, whatever is flying off them now.
//
// Altitude is the PLAYER's release height rather than the recordings' hover, so
// all three leave from one line. That is the "simplify" half of the ask.
//
// ── And the rest of the grid is CONTENT (DEV-125) ─────────────────────────
//
// Matt, 2026-09-16: *"add 3 more racers to the hover jet. these should be
// aligned in front of the player at the race start."* How many stand on the
// grid and where is `gameplay.racers` in the edition preset, resolved by
// `game/racer-grid.ts` into one list of starts: the 2016 pads first, then the
// preset's slots, laid out ahead of the player in the spawn frame. Classic's
// preset has the feature off, which is exactly the two pads. This file does not
// know how many racers there are; it builds one per start.
//
// The tunings are handed out in `AI_RACER_TUNINGS` order, one per start, unless
// a slot names one. Five starts, five tunings; a sixth would wrap and get a
// numbered id, because two racers flying one tuning from two places is still a
// race and refusing it would make a content number a code limit.

import * as THREE from 'three'
import { assetUrl } from '@/content/asset-url'
import { drawCallsigns } from '@/content/callsigns'
import type { EditionRacerLivery, EditionRacers } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import type { EditionState } from '@/game/edition'
import { ART_POSITION, ART_SCALE, SHIP_MESH_EXTERIOR, SHIP_MODEL_YAW } from '@/game/flight'
import { type RacerStart, racerStarts } from '@/game/racer-grid'
import { attachShipWings } from '@/game/ship-wings'
import { trailTint } from '@/game/wing-trail-fade'
import { type CraftWingTrails, createCraftWingTrails } from '@/game/wing-trails'
import { PROPS } from '@/generated/constants.generated'
import type { HoverGlow } from '@/render/hover-glow'
import { applyInterpolated, copyPose, type Pose } from '@/render/interpolate-transforms'
import { applyLambert1 } from '@/render/lambert1'
import { loadMesh } from '@/render/load-mesh'
import {
  paintLivery,
  paletteColour,
  type RacerLook,
  racerLook,
  type Srgb,
  srgbHex,
} from '@/render/racer-livery'
import { shininessToRoughness } from '@/render/terrain-mesh'
import { createTrail } from '@/render/trail'
import {
  flipPosition,
  flipQuaternion,
  srgbToLinear,
  threeQuatTupleToUnity,
  threeTupleToUnity,
  unityPose,
} from '@/render/unity-space'
import { measureWingTips } from '@/render/wing-trails'
import { AI_RACER_TUNINGS, type AiRacer, createAiRacer, seedRacerAt } from '@/sim/ai-racer'
import type { Gate } from '@/sim/course'
import type { CraftContactReport } from '@/sim/craft-contact'
import type { CraftHitReport } from '@/sim/craft-hit'
import { type CourseLine, type CrashSpec, routeLineOf } from '@/sim/crash'
import type { HoverJetSheet } from '@/sim/hoverjet'
import { holdInstructorAt, type InstructorPace } from '@/sim/instructor'
import { v3 } from '@/sim/math/vec3'
import type { PropColliders, PropCollisionSpec } from '@/sim/props/collision'
import {
  createRacerField,
  NO_FIELD_RULES,
  type RacerFieldRules,
  stepRacerField,
} from '@/sim/racer-field'
import { type Route, routeArcLengthNear } from '@/sim/route'
import type { HeightField } from '@/sim/terrain/height-field'

// The AI racers wear the THIRD-PERSON hull, which is what 2016 puts on them and
// what you are always looking at from outside. Imported rather than spelled out:
// the path used to be written here AND in `ghosts.ts` AND in `flight.ts`.
const SHIP_MESH = SHIP_MESH_EXTERIOR

const TRAIL = PROPS.ghostTrail

/** Volatile. Valid only inside one synchronous `render`. */
const emitter = new THREE.Vector3()
/**
 * Volatile. Where the interpolated SIM-space pose lands before it is flipped.
 *
 * An `Object3D` rather than a plain pair because that is what
 * `applyInterpolated` writes into; it is never added to a scene.
 */
const interpolated = new THREE.Object3D()

/**
 * The engine trail, and why it is on these ships and not the player's.
 *
 * `GhostRacer.prefab` carries the only TrailRenderer in the shipped game;
 * `PlayerShip_SR14_Photon.prefab` has none. Matt: *"it'd be nice to get the vfx
 * trail from the ghost/ai engines we used to have (helped players see the ai
 * jets)."* It is a read on the opposition, not a jet effect — which is why it
 * belongs here rather than in `game/flight.ts`.
 *
 * The material is `glowyMaterial.mat`, byte for byte the one the checkpoint
 * rings' studs wear, so this is the stud treatment from `game/rings.ts`: opaque
 * (no `_ALPHABLEND_ON`), `_GlowStrength` 2, Marmoset sharpness mapped to
 * roughness. That shared material is why the trail reads as the same cyan-white
 * as the gates, and it is asserted in `tests/unit/ghost-trail.test.ts`.
 */
const trailMaterial = (): THREE.MeshStandardMaterial => {
  const linear = (c: readonly number[] | null) =>
    new THREE.Color(
      srgbToLinear((c?.[0] as number) ?? 1),
      srgbToLinear((c?.[1] as number) ?? 1),
      srgbToLinear((c?.[2] as number) ?? 1),
    )
  return new THREE.MeshStandardMaterial({
    color: linear(TRAIL.color),
    emissive: linear(TRAIL.glowColor),
    emissiveIntensity: TRAIL.glowStrength ?? 1,
    roughness: shininessToRoughness(TRAIL.shader, TRAIL.specular.shininess ?? 4),
    metalness: 0,
    // The ribbon is a flat strip with no thickness, so it is seen from both
    // sides as the racer turns.
    side: THREE.DoubleSide,
    transparent: TRAIL.blends ?? false,
  })
}

/**
 * DEV-407. Matt, 2026-09-25: *"racer's engine trail should be tinted to match
 * the racer's color - like the wingtips."* So it takes the wing trails' key
 * (`fx.wingTrails.tint`) and their rule (`trailTint`): the two trails on one
 * ship cannot disagree. Where the wing trails are off, which includes Classic,
 * the amount is 0 and the trail is 2016's glowyMaterial exactly.
 */
export const engineTrailTint = (
  wings: { readonly enabled: boolean; readonly tint: number } | undefined,
): number => (wings?.enabled ? wings.tint : 0)

/** The racers' engine trail's shape, off 2016's `GhostRacer` TrailRenderer. */
const engineTrailSpec = () => ({
  seconds: TRAIL.seconds ?? 0.14,
  startWidth: TRAIL.startWidth ?? 0.43,
  endWidth: TRAIL.endWidth ?? 0.01,
  minVertexDistance: TRAIL.minVertexDistance ?? 0.25,
})

/**
 * DEV-408: one engine trail exactly as a racer wears it, for a ship that is
 * not a racer: the player's ghost. Its own material, tinted by the same rule
 * (`engineTrailTint`), so a ghost's trail and a racer's cannot drift apart.
 * The caller owns all three and disposes them.
 */
export const createEngineTrail = (
  livery: Srgb | null,
  wings: { readonly enabled: boolean; readonly tint: number } | undefined,
): {
  trail: ReturnType<typeof createTrail>
  material: THREE.MeshStandardMaterial
  base: THREE.MeshStandardMaterial
} => {
  const base = trailMaterial()
  const material = base.clone()
  tintEngineTrail(material, base, livery, engineTrailTint(wings))
  return { trail: createTrail(engineTrailSpec(), material), material, base }
}

/** `mat` = `base`'s colour and glow, times the craft's trail tint (linear). */
export const tintEngineTrail = (
  mat: THREE.MeshStandardMaterial,
  base: THREE.MeshStandardMaterial,
  livery: Srgb | null,
  amount: number,
): void => {
  const [r, g, b] = trailTint(livery, amount)
  const tint = new THREE.Color(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b))
  mat.color.copy(base.color).multiply(tint)
  mat.emissive.copy(base.emissive).multiply(tint)
}

/**
 * Where on the ship the trail comes out, in THREE space. DEV-311.
 *
 * Matt, wishlist #31: *"gap between the engines and the trail FX"*. It was
 * **1.215 m of air** behind the hull's aft face, and the cause is that this
 * number and the ART were composed from TWO DIFFERENT PREFAB ROOTS.
 *
 * ── What 2016 authors ────────────────────────────────────────────────────
 *
 * `GhostRacer.prefab` hangs the hull, the anti-grav wings and the TrailRenderer
 * off ONE parent, `GhostRider_01`, with the hull AT that parent's origin and
 * identity rotation:
 *
 *     GhostRider_01 / hoverJet_exterior_blue   local (0, 0, 0), identity
 *     GhostRider_01 / trails                   local (-2.8267, 1.5028, 0.0016)
 *
 * So the emitter is authored **relative to the ART**, and `TRAIL.local` alone
 * is that relationship. `TRAIL.pivots` is the link ABOVE it — `GhostRider_01`'s
 * own transform under the `GhostRacer` wrapper, 2.789 m aft of it.
 *
 * ── What the port did, and why it looked reasonable ──────────────────────
 *
 * This composed `pivots x local`, which is the emitter measured from the
 * GhostRacer ROOT: (0, 0.573, 5.650). But the port does not put its art where
 * GhostRacer does — it uses `ART_POSITION`, which is `PlayerShip_SR14_Photon`'s
 * root-to-art offset, 1.336 m aft instead of 2.789 m. Two prefabs, two roots,
 * and **1.453 m** between them; 1.215 m of it showed as air behind the tail.
 * The sheet's own note even warns that composing by hand "is how a 5.65 m
 * offset becomes a 2.83 m one" — both numbers are right, in different frames,
 * and the port was mixing them.
 *
 * ── The fix, and how it is checked ───────────────────────────────────────
 *
 * Compose `TRAIL.local` through the SAME art transform the hull gets. That
 * lands the emitter at (-0.008, 0.442, 4.106): **0.33 m inside the hull's aft
 * face** (4.435) and **0.04 m inside the aft edge of the anti-grav wing part**
 * (`GLOW_ENVELOPE_2016.max` z = 4.150, composed independently off the SAME
 * prefab). Two numbers from two different objects agreeing that the trail comes
 * out of the glowing wing's tail is the evidence — not that a run came back
 * green. `tests/unit/ghost-trail.test.ts` holds both.
 *
 * Exported so the spec measures THIS function rather than re-deriving the
 * composition the way the code does, which would be a test of nothing
 * (trap 24).
 */
export const trailEmitterOffset = (): THREE.Vector3 => {
  // The art's own transform, the three lines every consumer of the exterior
  // hull applies. Built from the exported constants, never a second copy of the
  // numbers — that drift is what sent every ghost in the game flying backwards
  // once already.
  const artToShip = new THREE.Matrix4().compose(
    ART_POSITION,
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), SHIP_MODEL_YAW),
    ART_SCALE,
  )
  const local = unityPose(TRAIL.local.position, TRAIL.local.rotation, TRAIL.local.scale)
  return new THREE.Vector3().setFromMatrixPosition(artToShip.multiply(local))
}

/**
 * 2016's grid: 2016's own opposition, no slots — the `ai` pads, or on a course
 * that authored none, where its recordings began (DEV-442, `racer-grid.ts`).
 * What a caller that has no preset gets, and what Classic's preset says in as
 * many words.
 */
export const PADS_ONLY: EditionRacers = {
  enabled: false,
  usePads: true,
  slots: [],
  // DEV-364: neither rule, as 2016. The numbers are unread behind the flags.
  separation: {
    enabled: false,
    laneSpacing: 0,
    laneEaseMetres: 0,
    gateFraction: 0,
    gateFunnel: 0,
    avoidReach: 0,
    avoidClearance: 0,
    avoidGain: 0,
  },
  contact: { enabled: false, restitution: 0, restingSpeed: 0, passes: 1 },
  // DEV-364 follow-up: nothing touches, so nothing is hit. `fullSpeed` above
  // `minSpeed` only so the block would pass the validator's own rule.
  hit: {
    enabled: false,
    minSpeed: 0,
    fullSpeed: 1,
    scrub: 0,
    headingKick: 0,
    attitudeKick: 0,
    shakeSeconds: 0,
    shakeGain: 0,
  },
}

/**
 * The aircraft the AI grid races IN — DEV-399.
 *
 * The racers are HoverJets: `sim/ai-racer.ts` steps `stepHoverJet`, and since
 * DEV-382 they fly the player's own variant of it, so a race is between the
 * same machines. The GLIDER races nobody until a glider racer exists: five
 * jets at 90 m/s on a course laid out for a 55 m/s glide would be no race at
 * all, and `sim/glider-autopilot.ts` is the pilot such a racer would need
 * (DEV-145 §4 — it flies the line, it does not race it). The JumpSeat never
 * asks: no mode it flies races (`ModeRules.opponents`).
 */
export const racesIn = (vehicle: string): boolean => vehicle === 'hoverjet'

/**
 * The two things a caller may substitute for what this file would work out.
 *
 * DEV-146 (ambient traffic) flies a SECOND population over a DIFFERENT
 * mission's course while the player is on this one, and it wants its ships
 * spread round the circuit rather than stacked on a start deck. Both of these
 * are generic — "start them here" and "this is the line" — rather than anything
 * that knows what ambient traffic is, which is the point: `game/racers.ts`
 * still builds one racer per start and has no idea why there are two lots.
 */
export interface RacerOptions {
  /**
   * Where they start, INSTEAD of the grid. The `grid` argument is then unread.
   *
   * Still THREE space, still one entry per racer, still the same `RacerStart`
   * `racer-grid.ts` produces — so the pads and the traffic cannot drift into
   * two different ideas of what a start is.
   */
  readonly starts?: readonly RacerStart[]
  /**
   * The racing line, INSTEAD of `level.route`. `undefined` means "work it out";
   * `null` means "there isn't one", which is not the same thing.
   *
   * A caller that has already built the route (to lay the starts along it, say)
   * hands the same object over rather than making a second one — two `Route`s
   * for one course would be two sets of arc lengths for the seeder and the
   * follower to disagree about.
   */
  readonly guide?: { route: Route; gateArc: readonly number[] } | null
  /**
   * The live preset, for the LIVERY (DEV-350). Absent: the hologram, always,
   * and no colour on the spec — which is what DEV-146's traffic gets, because
   * those ships are not opponents and the row that made them never asked.
   *
   * The palette is read ONCE, at load, like the grid: a flip changes what the
   * hulls wear, not which colour each racer is. `render.racerLivery.enabled`
   * is followed live, so Classic is still one press away.
   *
   * And the WING-TIP TRAILS (DEV-358), which read `fx.wingTrails` and the
   * comfort slider every frame. Absent: no trails, which is DEV-146's traffic
   * again, for the reason the livery gives.
   */
  readonly edition?: Pick<EditionState, 'current' | 'subscribe' | 'speedFx'>
  /**
   * DEV-377: a flight instructor's pace per start (`sim/instructor.ts`), or
   * null for a racer — the fourth argument `createAiRacer` has had since
   * DEV-376. A paced racer needs the line: it starts SEEDED on it where its
   * start is (`seedRacerAt`), at rest and holding, and `reset` puts it back
   * there the same way.
   */
  readonly paces?: readonly (InstructorPace | null)[]
  /**
   * DEV-377: the livery palette INSTEAD of the preset's, one colour per racer,
   * wrapping. The instructor wears its own colour, from the lesson (plan §5.3,
   * call 5), and nothing else about the livery changes: `enabled` still follows
   * the preset, so Classic's instructor is a hologram as its racers are.
   */
  readonly palette?: readonly Srgb[]
  /**
   * The machine every racer flies: the RACE's view of the HoverJet sheet
   * (DEV-382). `boot/app.ts` hands over the player's own jet's sheet, so the
   * racers fly your variant (AIRCRAFT-VARIANTS §6.4, Matt's call: a race
   * between the same machines). Absent: 2016's sheet, which is what DEV-146's
   * traffic gets, because those ships are not racing you.
   *
   * Read ONCE, at load, onto each racer's spec, like the grid: a variant is
   * chosen at board time, and a reset rebuilds from the spec.
   */
  readonly sheet?: HoverJetSheet | undefined
  /**
   * DEV-651: name the racers. The seed of THIS race's draw from the callsign
   * pool (`game/race-callsigns.ts`: the course for single player and the
   * exhibition, the frozen race for a room), so every client reads the same
   * names. Absent: unnamed, and every board falls back to the tuning id, which
   * is what DEV-146's traffic and the lesson's instructor are.
   */
  readonly callsignSeed?: number
  /**
   * DEV-844: a seed for EACH ATTEMPT instead of one for the race. Asked once at
   * load and again on every whole-field `reset`, so a retry meets five new
   * names. Wins over `callsignSeed`. Single player and the exhibition pass one;
   * a room does not (its bots are named identically on every client, so its
   * names are a function of the frozen race, never of the attempt).
   */
  readonly attemptCallsignSeed?: () => number
  /**
   * DEV-391: how many OTHER players the racers must picture besides the player
   * — a room's humans, whose drawn poses the bot host hands each step as
   * `RacerFieldRules.others`. Absent: none, the single-player field exactly.
   */
  readonly others?: number
}

/**
 * A paced racer's START, on the line: its body seeded where its spawn is, at
 * rest, and its pace holding there for a student who has not launched
 * (DEV-376's §5: `seedRacerAt`, then `holdInstructorAt`). One door for the
 * first placement and every reset, so a restart is the same instructor.
 *
 * `seedRacerAt` marks the rings behind the start passed, which is what keeps an
 * instructor waiting 60 m up the line from turning back for ring 0.
 */
const startPaced = (
  racer: AiRacer,
  pace: InstructorPace,
  guide: { route: Route; gateArc: readonly number[] },
): void => {
  const arc = routeArcLengthNear(guide.route, racer.spec.spawn)
  seedRacerAt(racer, guide, arc, 0)
  holdInstructorAt(pace, racer.jet.body.position, arc)
}

/**
 * One tuning per start, in `AI_RACER_TUNINGS` order, unless the slot asked for
 * one by name. Ids are the tuning keys, numbered when a key repeats, so the
 * results panel and the engine map (`racer-engines.ts` keys by id) never see
 * two racers with one name.
 */
export const assignTunings = (starts: readonly RacerStart[]): { id: string; tuning: string }[] => {
  const keys = Object.keys(AI_RACER_TUNINGS)
  for (const start of starts) {
    if (start.tuning !== null && !(start.tuning in AI_RACER_TUNINGS)) {
      throw new Error(
        `racers: slot asks for tuning "${start.tuning}", which is not one of ${keys.join(', ')}`,
      )
    }
  }
  // The keys a slot claimed by name come out of the automatic rotation, so a
  // grid that names `fast` for its apex does not also get `fast` on a pad.
  const named = new Set(starts.map((s) => s.tuning).filter((t): t is string => t !== null))
  const rotation = keys.filter((k) => !named.has(k))
  const pool = rotation.length > 0 ? rotation : keys
  const counts = new Map<string, number>()
  let auto = 0
  return starts.map((start) => {
    const tuning = start.tuning ?? (pool[auto++ % pool.length] as string)
    const n = (counts.get(tuning) ?? 0) + 1
    counts.set(tuning, n)
    return { id: n === 1 ? tuning : `${tuning}-${n}`, tuning }
  })
}

export interface LoadedRacers {
  readonly group: THREE.Group
  /**
   * One node per racer, in racer order — the SHIPS, and nothing else.
   *
   * `group.children` is not this list and never was: every racer adds its
   * `racer:<id>` node **and a world-space trail** to the same group, so the
   * children alternate and `children[i]` is racer `i / 2`. A caller that wants
   * "the racers' meshes" wants this.
   *
   * Added by DEV-215, for the title screen, which borrows these to fly 2016's
   * flypast. It had been reaching into `group.children` behind a comment that
   * said they were the per-racer nodes, and got away with it only because it
   * flew exactly ONE: `children[0]` is a racer. `children[1]` is a trail.
   */
  readonly ships: readonly THREE.Object3D[]
  /** The authored line these racers follow, or null. Shared with the player proxy. */
  readonly guide: { route: Route; gateArc: readonly number[] } | null
  readonly count: number
  readonly racers: readonly AiRacer[]
  /** Where each racer started, THREE space, in racer order. For the pads under them. */
  readonly starts: readonly RacerStart[]
  /**
   * Whether the hulls wear their livery right now, or the hologram. DEV-350.
   * Follows `render.racerLivery.enabled` across a flip.
   */
  readonly solid: boolean
  /**
   * The solid look's materials, every racer's: the hull's own `lambert1` and
   * the wing's projectors. For the doors a world object goes through (the fog,
   * the far-field shadow) — handed out rather than walked for, because in
   * Classic they are on no mesh at all.
   */
  readonly solidMaterials: readonly THREE.Material[]
  /**
   * Every racer mesh, for the sun's map (`SunShadowScene.racers`). Whether they
   * cast is the preset's, through `shadowCastersFor`; a hologram never does.
   */
  readonly shadowMeshes: readonly THREE.Mesh[]
  /**
   * Every racer's wing-tip trails, ONE draw (DEV-358), advanced by `render`.
   * Null without a preset (DEV-146's traffic). Its object is already in
   * `group`; handed out for the fog's door and for the tests.
   */
  readonly wingTrails: CraftWingTrails | null
  /**
   * What the last step's contact pass did (DEV-364): pairs touching, the
   * hardest closing speed, and which craft touched — racers in racer order,
   * then the player. A reading, for `__ff2.racers()` and the specs.
   */
  readonly contact: CraftContactReport
  /**
   * What the last step's hit rule did to the player (DEV-364 follow-up):
   * `struck` on the tick a racer hit it, and running totals. `boot/app.ts`
   * plays the cue and jolts the cockpit off it (`game/racer-hit.ts`).
   */
  readonly hit: CraftHitReport
  /**
   * One fixed step for every racer.
   *
   * `terrain` is what they AVOID and `ground` is what they HIT, and the two are
   * different lists on purpose — see `stepAiRacer`. `ground` defaults to
   * `terrain`, so a caller that has not been updated gets island collision
   * rather than none; pass the ocean plate as well to give a racer exactly the
   * surfaces the player's `Flight.setTerrain` gets.
   */
  step(
    terrain: readonly HeightField[],
    dt: number,
    ground?: readonly HeightField[],
    /** The Anniversary crash rule (DEV-126), the same spec the player flies under. Null: 2016's bounce. */
    crash?: CrashSpec | null,
    /**
     * The forest (DEV-147): the SAME colliders the player tests against, and
     * the preset's spec. Null where the preset has no prop collision.
     *
     * What a racer BROKE this step is on `racer.props.hits`, which the caller
     * reads after this returns — the renderer owns the instance and the
     * fracture, so the swap cannot happen in here.
     */
    props?: { readonly colliders: PropColliders; readonly spec: PropCollisionSpec } | null,
    /**
     * DEV-364: the lanes, the contact and the player's body, off the live
     * preset. Absent is neither — the one line and 2016's intangible ghosts —
     * which is what DEV-146's traffic gets.
     */
    rules?: RacerFieldRules,
  ): void
  /**
   * Put every racer back on its pad for another run — or just the one at
   * `index`, which is how DEV-146 recycles a single ship without disturbing
   * the others flying beside it.
   *
   * The trails are reset too, and have to be: a ribbon is a world-space history
   * and a racer that teleports from the sea back to the start would otherwise
   * draw a two-kilometre streak across the map for the length of `seconds`.
   */
  reset(index?: number): void
  /**
   * Push the sim poses into the scene, and advance the engine trails.
   *
   * `alpha` is what `stepFixed` returned this frame — the racers interpolate
   * between their last two sim states exactly as the player's ship does. `eye`
   * is the camera's world position, because the trails are camera-facing
   * ribbons, and `dt` is a FRAME delta, not the fixed step: 2016 sampled its
   * TrailRenderer in `LateUpdate`.
   *
   * `wingDt` is the wing-tip trails' own frame delta (DEV-358), defaulting to
   * `dt`: the caller passes 0 while the sim is paused or snapped, which holds
   * the vapour where it is. The ENGINE trails keep `dt`, as they always have.
   *
   * It places every ship first (`place(alpha)`), so a caller that has already
   * placed them this frame gets the same pose written again: same `alpha`, same
   * two states, the same bits.
   */
  render(alpha: number, eye: THREE.Vector3, dt: number, wingDt?: number): void
  /**
   * DEV-612: only the poses, `alpha` of the way between the last two steps,
   * flipped into three space: the half of `render` a CAMERA needs. `boot/app.ts`
   * calls it straight after `stepFixed`, before any camera reads a racer (TV's,
   * `?view=chase&chase=<racer>`), so the camera sits on the pose THIS frame
   * draws. Placed by `render` alone, further down the frame than the cameras,
   * a camera read the PREVIOUS frame's pose and the hull led it by one frame's
   * travel, which every uneven frame changes: Matt's "juddery" on TV.
   */
  place(alpha: number): void
  dispose(): void
}

/**
 * The opponent look — the ghost's, so the two modes read the same. CLASSIC's
 * look since DEV-350: on Anniversary the racers wear the player's own hull,
 * repainted (`render/racer-livery.ts`), and this is what a flip back puts on.
 *
 * Exported since DEV-281, for the title screen's two flypast jets. They used to
 * BE racers, borrowed off the mission; now that boot builds no mission they are
 * the title's own, and the look has to stay the same object rather than become
 * a second copy of these nine fields (the orientation lesson, §5).
 *
 * No `vertexColors`: the cockpit GLB's own COLOR_0 is the near-black of an
 * interior, and a vertex colour multiplies. That is what made the ghosts
 * invisible for a session. Emissive so the canopy struts hold against both a
 * bright sea and a dark deck, and DoubleSide because a cockpit's faces point in.
 * No depth write: these overlap each other and the terrain constantly, and
 * writing depth would make them punch holes in one another.
 */
export const racerMaterial = (): THREE.Material =>
  new THREE.MeshStandardMaterial({
    vertexColors: false,
    color: new THREE.Color(0.42, 0.74, 0.95),
    emissive: new THREE.Color(0.1, 0.42, 0.62),
    emissiveIntensity: 1,
    roughness: 0.55,
    metalness: 0,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
    depthWrite: false,
  })

/**
 * Dress one loaded exterior hull as racer `index`. DEV-350.
 *
 * The player's material first — `applyLambert1`, exactly as `flight.ts`
 * dresses the hull you fly — then the livery in the palette's colour for
 * `index`, then the wing, then the look. The order is the whole of it: the
 * livery is painted before the wing arrives because the projectors carry
 * vertex colours of their own and are not livery, and the look is taken last
 * because it switches only the meshes present when it is taken. The glow
 * keeps `glowyMaterial` in both looks (DEV-322).
 *
 * `livery` null is a hull with no colour — the hologram, with nothing to flip
 * to (DEV-146's traffic). Otherwise the hull is painted whatever the flag
 * says, and wears the paint while `livery.enabled` does. `wings` false is the
 * title's flypast, which never carried the wing (DEV-310's scope, kept by
 * DEV-322).
 *
 * Exported for the title screen, which flies the same two looks and must not
 * become a second copy of this recipe (the orientation lesson, §5).
 */
export const dressRacerHull = async (
  art: THREE.Object3D,
  livery: EditionRacerLivery | null,
  index: number,
  hologram: THREE.Material,
  wings: boolean,
): Promise<{ look: RacerLook; glow: HoverGlow | null; colour: Srgb | null }> => {
  applyLambert1(art)
  const colour = livery ? paletteColour(livery.palette, index) : null
  if (colour) paintLivery(art, colour)
  // No `projectorMaterial`: the projectors arrive in `Projector04_Mat`, as the
  // player's do and as `GhostRacer.prefab`'s do, and the look below puts the
  // hologram on them for Classic — where they wore it before DEV-350, as
  // 2016's hologram ship's do.
  const glow = wings ? await attachShipWings(art) : null
  return { look: racerLook(art, hologram, livery?.enabled ?? false), glow, colour }
}

export const loadRacers = async (
  level: Level,
  gates: readonly Gate[],
  useRoute = false,
  /** The preset's grid. Defaults to 2016's pads, which is what Classic says. */
  grid: EditionRacers = PADS_ONLY,
  /** DEV-146's two substitutions. Empty by default — this file works it all out. */
  options: RacerOptions = {},
): Promise<LoadedRacers> => {
  // Where a racer's run ENDS, in sim space — the same gate the player's ends at
  // (DEV-045). Derived here rather than in the sim so `ai-racer.ts` stays free
  // of the level schema.
  const finishSphere = level.finish
    ? {
        x: level.finish.pos[0] as number,
        y: level.finish.pos[1] as number,
        z: -(level.finish.pos[2] as number),
        radius: level.finish.radius,
      }
    : null

  // The authored racing line, if this mission has one. `int_01` does:
  // `CurvyClonePath`, 421 points over 11.3 km, with every gate on it. A caller
  // that has already built it says so (DEV-146) — `undefined` is "work it out"
  // and `null` is "there isn't one", which a `??` would have collapsed.
  const points = useRoute ? (level.route ?? null) : null
  const guide: CourseLine | null =
    options.guide !== undefined
      ? options.guide
      : points && points.length > 1
        ? routeLineOf(points, gates)
        : null

  const group = new THREE.Group()
  group.name = 'racers'
  const material = racerMaterial()
  const trailMat = trailMaterial()
  const trailLocal = trailEmitterOffset()

  // The grid: 2016's pads, then the preset's slots, already at release height
  // and already in three space. `racer-grid.ts` is the one place that layout
  // is computed; the pads drawn under these racers come from the same list.
  // A caller may hand over its own starts instead (DEV-146).
  const starts = options.starts ?? racerStarts(level, grid)
  const assigned = assignTunings(starts)
  // DEV-651: what each is called, drawn for THIS race (distinct by construction).
  const firstSeed = options.attemptCallsignSeed?.() ?? options.callsignSeed
  const callsigns = firstSeed === undefined ? null : drawCallsigns(firstSeed, starts.length)

  // ── the livery (DEV-350) ────────────────────────────────────────────
  //
  // The palette at load, one colour per racer in racer order; the switch
  // live. No preset handed in is no livery at all.
  const preset = options.edition?.current.render.racerLivery ?? null
  // DEV-377: a caller's palette wins over the preset's (the instructor's colour).
  const livery = preset && options.palette ? { ...preset, palette: options.palette } : preset

  const loaded = await Promise.all(
    starts.map(async (start, i) => {
      const gltf = await loadMesh(assetUrl(SHIP_MESH))
      gltf.object.position.copy(ART_POSITION)
      gltf.object.rotation.y = SHIP_MODEL_YAW
      gltf.object.scale.copy(ART_SCALE)
      // DEV-358: the wing tips, off this hull, in the ship frame, before the
      // wing is hung on it. A walk of ~1,100 vertices, once, at load.
      const tips = measureWingTips(gltf.object)
      // The hull, its livery, the anti-grav wing and the look — see
      // `dressRacerHull` for why that order.
      const { look, glow, colour } = await dressRacerHull(gltf.object, livery, i, material, true)

      const { id, tuning } = assigned[i] as { id: string; tuning: string }
      const object = new THREE.Group()
      object.name = `racer:${id}`
      object.add(gltf.object)
      group.add(object)

      // The trail is WORLD space, so it hangs off the racers group rather than
      // off this racer — parented to the ship it would turn with the ship
      // instead of being left behind by it.
      //
      // DEV-407: one material per racer, so each can wear its own tint. They
      // differ only in colour and emissive, which are uniforms, so all of them
      // share one program.
      const engineMat = trailMat.clone()
      tintEngineTrail(
        engineMat,
        trailMat,
        colour,
        engineTrailTint(options.edition?.current.fx.wingTrails),
      )
      const trail = createTrail(engineTrailSpec(), engineMat)
      group.add(trail.object)

      // The start is THREE space and the sim is that mirrored in z.
      const spawn = threeTupleToUnity(v3(), [start.pos[0], start.pos[1], start.pos[2]])
      const q = { x: 0, y: 0, z: 0, w: 1 }
      threeQuatTupleToUnity(q, start.quat as unknown as number[])
      const racer = createAiRacer(
        {
          id,
          spawn,
          orientation: [q.x, q.y, q.z, q.w],
          tuning: AI_RACER_TUNINGS[tuning] as (typeof AI_RACER_TUNINGS)[string],
          // DEV-350: on the spec, where every consumer of a racer already looks.
          colour: colour ? srgbHex(colour) : null,
          callsign: callsigns?.[i] ?? null,
          // DEV-382: the race's view — the player's variant, or 2016's sheet.
          sheet: options.sheet,
        },
        gates,
        finishSphere,
        options.paces?.[i] ?? null,
      )
      if (racer.pace && guide) startPaced(racer, racer.pace, guide)
      // ── the previous sim pose, for interpolation ────────────────────
      //
      // The sim is 81.967 Hz and the display is 72, 90 or 144. Writing the
      // CURRENT pose straight to the scene beats against that at ~10 Hz, which
      // is exactly the band the eye hates: Matt saw it immediately once the
      // chase camera put a racer at 30 m instead of 300. The player's ship has
      // always interpolated (D4, CLAUDE.md rule 5); these did not.
      const previous: Pose = {
        position: { x: 0, y: 0, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      }
      copyPose(previous, racer.jet.body)
      return { racer, object, gltf, glow, look, trail, engineMat, previous, tips, colour }
    }),
  )

  const racers = loaded.map((l) => l.racer)
  // ── the air they share (DEV-364) ───────────────────────────────────
  //
  // The lanes are handed out here, off the grid as it stood, whatever the
  // preset says; whether they are flown is the live rule's, every step.
  const field = createRacerField(racers, guide?.route ?? null, undefined, options.others ?? 0)
  // ── the wing-tip trails (DEV-358) ──────────────────────────────────
  //
  // Every racer in ONE batch and one draw, in racer order. World-space like
  // the engine trails, so it hangs off the group at identity, never off a
  // ship. The preset and the slider are read every frame in `render`.
  const wingEdition = options.edition ?? null
  const wingTrails = wingEdition
    ? createCraftWingTrails(
        // Each racer's trails lean toward its own livery (DEV-358 follow-up):
        // the colour DEV-350 put on its spec, as the paint went on its hull.
        loaded.map((l) => ({
          tips: l.tips,
          frame: l.object,
          body: l.racer.jet.body,
          livery: l.colour,
        })),
        'wing-trails:racers',
      )
    : null
  if (wingTrails) group.add(wingTrails.trails.object)
  // A flip moves what the hulls WEAR. The sun's map follows by itself: the
  // racers' caster row composes `render.racerLivery.enabled` (`shadows.ts`),
  // so a hologram cannot cast whatever state the meshes were left in.
  const edition = livery ? options.edition : undefined
  const unsubscribe =
    edition?.subscribe(() => {
      const on = edition.current.render.racerLivery.enabled
      for (const l of loaded) l.look.setSolid(on)
      // DEV-407: the engine trails follow the wing trails' tint live, the way
      // the wing trails read it every frame.
      const amount = engineTrailTint(edition.current.fx.wingTrails)
      for (const l of loaded) tintEngineTrail(l.engineMat, trailMat, l.colour, amount)
    }) ?? null

  /** The poses alone (`LoadedRacers.place`); `render` begins with it. */
  const place = (alpha: number): void => {
    for (const { racer, object, previous } of loaded) {
      // Interpolate in SIM space, then flip once. `applyInterpolated` writes
      // straight into an Object3D, so it lands on a scratch object and the
      // flip carries it across: doing the flip first would mean mirroring
      // two poses per racer per frame instead of one.
      applyInterpolated(interpolated, previous, racer.jet.body, alpha)
      // The flip is its own inverse, so the same pair of helpers carries a
      // pose back out of sim space. Doing it by hand here is how the ship
      // ended up mirrored the first time.
      flipPosition(object.position, interpolated.position)
      flipQuaternion(object.quaternion, interpolated.quaternion)
    }
  }

  return {
    group,
    ships: loaded.map((l) => l.object),
    count: racers.length,
    racers,
    guide,
    starts,
    get solid() {
      return loaded[0]?.look.solid ?? false
    },
    solidMaterials: loaded.flatMap((l) => l.look.solidMaterials),
    shadowMeshes: loaded.flatMap((l) => l.look.shadowMeshes),
    wingTrails,
    contact: field.contact,
    hit: field.hit,

    reset(index?: number) {
      // One racer, or all of them. `index` out of range resets nothing rather
      // than throwing: the caller is a per-frame loop over its own list.
      const only = index === undefined ? loaded : loaded.slice(index, index + 1)
      // The vapour too, for the engine trail's reason below (DEV-358).
      wingTrails?.clear(index)
      // DEV-844: a whole-field reset is a new attempt, so a new set of names.
      // The spec is the one object every board reads a name from.
      if (index === undefined && options.attemptCallsignSeed) {
        const names = drawCallsigns(options.attemptCallsignSeed(), loaded.length)
        loaded.forEach((l, i) => {
          ;(l.racer.spec as { callsign?: string | null }).callsign = names[i] ?? null
        })
      }
      for (const l of only) {
        const fresh = createAiRacer(l.racer.spec, gates, finishSphere)
        // Copy INTO the existing racer: `step` and `render` both close over
        // these objects, so replacing them would leave the loop stepping the
        // previous run's.
        Object.assign(l.racer.jet.body, fresh.jet.body)
        Object.assign(l.racer.course, fresh.course)
        Object.assign(l.racer.cursor, fresh.cursor)
        // The ground state too, and it is not housekeeping: `flashFor` and
        // `depth` persist across ticks, so a racer restarted mid-scrape would
        // begin its new run with a third of a second of tripled angular drag and
        // a "already touching" flag that swallows the next real impact. The body
        // copy above already restores `angularDrag` itself, because `fresh`'s is
        // the sheet's resting value.
        Object.assign(l.racer.ground.collision, fresh.ground.collision)
        Object.assign(l.racer.ground.hover, fresh.ground.hover)
        // And the CRASH state, which this loop used to leave behind. `heldFor`
        // and the planned reset pose persist across ticks, and `crashHoldsShip`
        // is checked before anything else in `stepAiRacer` — so a racer that was
        // mid-hold when the run restarted came back frozen, waiting out a hold
        // for a crash that belonged to the previous run. It has no symptom with
        // one racer and no crash; DEV-146 recycles a ship on purpose and hits it
        // every time.
        Object.assign(l.racer.crash, fresh.crash)
        // And DEV-180's stuck counter, which is the same shape of state: a
        // running total across ticks. A racer restarted while resting on a palm
        // would carry most of a second of contact into a run that begins on the
        // deck, and break the first thing it brushed.
        l.racer.propStuckFor = 0
        l.racer.props.hits.length = 0
        l.racer.crashEvent = 'none'
        l.racer.elapsed = 0
        l.racer.gates = 0
        l.racer.finished = false
        l.racer.finishedAt = 0
        // Meaningless until `finished` — but leaving the last run's setpoint here
        // means a debugger reading it mid-run reads a lie.
        l.racer.holdAltitude = 0
        // DEV-377, the note DEV-376 left: a flight instructor's pace is state
        // that persists across ticks too — its mode, the hover point it latched
        // — and the copies above do not reach it, so a restarted lesson began
        // in the last run's HOLD, beside a ring half a course away. It is put
        // back where it started, holding, as it was built.
        if (l.racer.pace && guide) startPaced(l.racer, l.racer.pace, guide)
        copyPose(l.previous, l.racer.jet.body)
        l.trail.reset()
      }
    },

    step(terrain, dt, ground = terrain, crash = null, props = null, rules = NO_FIELD_RULES) {
      // Snapshot BEFORE advancing, or `previous` and `current` are the same
      // state and the interpolation below is an expensive no-op. All of them
      // first: the field steps every racer and then pushes them apart, so a
      // racer's pose can move after its own step (DEV-364).
      for (const l of loaded) copyPose(l.previous, l.racer.jet.body)
      stepRacerField(field, racers, gates, terrain, dt, guide, ground, crash, props, rules)
      for (let i = 0; i < loaded.length; i++) {
        const l = loaded[i] as (typeof loaded)[number]
        // A crash reset is a teleport: collapse the interpolation onto it, or
        // the next frame draws this racer as a streak from the wreck to the
        // line — the same reason `flight.respawn()` collapses its own.
        if (l.racer.crash.justReset) {
          copyPose(l.previous, l.racer.jet.body)
          l.trail.reset()
          wingTrails?.clear(i)
        }
      }
    },

    place,

    render(alpha, eye, dt, wingDt = dt) {
      place(alpha)
      for (const { object, trail } of loaded) {
        // The emitter, in world space: the ship's own pose applied to the
        // prefab offset.
        emitter.copy(trailLocal).applyQuaternion(object.quaternion).add(object.position)
        trail.update(emitter, eye, dt)
      }
      // DEV-358: every racer's wing-tip trails, from the poses just written,
      // in one draw. The preset and the slider are read HERE, every frame, so
      // a flip or a comfort change lands on the next one. Shown from every
      // view, the cockpit and the headset included: a racer is always somebody
      // else's ship. Only the player's own trails ask where you are sitting.
      if (wingTrails && wingEdition) {
        const look = wingEdition.current.fx.wingTrails
        wingTrails.update(eye, wingDt, look, wingEdition.speedFx, true)
      }
    },

    dispose() {
      unsubscribe?.()
      wingTrails?.dispose()
      for (const l of loaded) {
        l.glow?.dispose()
        l.gltf.dispose()
        l.trail.dispose()
        l.engineMat.dispose()
        // The solid materials, which `gltf.dispose` misses while the hologram
        // is on. Disposing one twice is a no-op in three.
        l.look.dispose()
      }
      material.dispose()
      trailMat.dispose()
      group.clear()
    },
  }
}
