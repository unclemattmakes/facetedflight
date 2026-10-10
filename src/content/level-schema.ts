// src/content/level-schema.ts — the runtime's view of a level.
//
// **This file follows `tools/extract/level.mjs`, not the other way round.** The
// extractor reads the shipped 2016 scenes and emits `content/levels/*.json`
// with provenance in a `_meta` sidecar; these types describe what it actually
// emits. If the two ever disagree, the JSON is right and this file is stale.
//
// One schema for extracted, hand-authored and procedurally generated courses —
// they differ only by the nullable `generated` field (DECISIONS D19). That is
// why the level editor and endless mode are later JSON rather than a rewrite.
//
// CONTENT IS DATA: adding a mission must never require touching `src/`. If it
// does, that is an architecture bug, not a task.

import { isRecord } from '@/net/validate-kit'

/**
 * The three 2016 shipped, and two FF2 added.
 *
 * `energyRace` is DEV-144 — Ring Attack with a tank under it that only a gate
 * refills. It is a fourth ROW in `game/modes.ts` and nothing else, which is the
 * claim `tests/unit/mode-rules.test.ts` makes checkable by refusing any file
 * under `src/game/**` or `src/sim/**` that spells a mode name.
 *
 * **No shipped level selects it and none can**, which is worth knowing before
 * you look for one: `content/levels/` is a GENERATED, sha256-guarded tree, and
 * its `_schema.json` — itself in that manifest — enumerates the three 2016
 * modes. `runningMode(level, requested)` is the door it ships through.
 *
 * `lesson` is DEV-375 — the flight instructor's mode (Flight School in the
 * hangar): rings live and counted, no clock, no opponents, no medal, and one
 * field no other row sets, `teaches`. Unlike `energyRace` it IS selected by a
 * level, and only by a hand-authored one: `content/authored/` is the tree a
 * course that 2016 never had lives in (DEV-145), and a level whose mode
 * teaches must carry a {@link Lesson} block (`game/modes.ts`'s
 * `validateModeContent`, which `loadLevel` runs).
 */
export type GameMode = 'ringAttack' | 'targetPractice' | 'freeFlight' | 'energyRace' | 'lesson'
/**
 * The aircraft a course is flown in. 2016 shipped the first two; the glider
 * (DEV-145, wired as a third aircraft by DEV-399) is Anniversary's, stands
 * behind `gameplay.glider` in the edition, and only a hand-authored course
 * names it — the extractor never writes it, because no shipped scene does.
 */
export type VehicleId = 'hoverjet' | 'jumpseat' | 'glider'

/**
 * 2016's three mission ranks, in 2016's own words.
 *
 * `Button_Look_Simple.missionRank` on `page_rankSelection`'s three live buttons
 * writes exactly these strings into `PlayerPrefs["MissionRank"]`, and
 * `MenuManager.ChallengeSelection()` switches on them. A fourth, `training`,
 * sits on an `m_IsActive: 0` button and never shipped.
 *
 * The level select's MIDDLE step (DEV-105). Extracted per mission, never
 * parsed out of an id in `src/` — see `difficultyFor` in
 * `tools/extract/level.mjs` for the two sources and the check between them.
 */
export type Difficulty = 'beginner' | 'intermediate' | 'professional'

/** The order the ranks are offered in — easiest first. Not alphabetical. */
export const DIFFICULTY_ORDER: readonly Difficulty[] = ['beginner', 'intermediate', 'professional']

export type Vec3Tuple = [number, number, number]
/** xyzw, three.js order. */
export type QuatTuple = [number, number, number, number]

export interface RingScoring {
  /** Points are `addScore * scoring.gateMultiplier`, NOT `addScore` alone. */
  addScore: number
  energyBoost: boolean
  energyBoostAmount: number
  triggerOnce: boolean
  silent: boolean
  triggerNextRoute: boolean
}

export interface RingTriggerSphere {
  radius: number
  center: Vec3Tuple
}

export interface RingTrigger {
  pos: Vec3Tuple
  quat: QuatTuple
  radius: number
  /** The 2016 gate is a compound of spheres, not one torus test. */
  spheres: RingTriggerSphere[]
}

export interface Ring {
  i: number
  order: number
  name: string
  pos: Vec3Tuple
  quat: QuatTuple
  scale: Vec3Tuple
  trigger: RingTrigger
  scoring: RingScoring
}

/**
 * A course may carry more than one route — `adv_01_hoverJet` ships two 22-ring
 * alternates. Every ring in this array is ALREADY live: the extractor applied
 * the liveness rule (`m_Enabled: 1`, `addScore != 0`, and the entire `m_Father`
 * chain `m_IsActive: 1`) before emitting. Skip that walk and you get 77 rings
 * for `int_02` instead of 21, because dead route versions
 * (`CurvyClonePath[OFF]`, `original[OFF]`) are still serialised.
 */
export interface Route {
  id: string
  rings: Ring[]
}

export interface SpawnPoint {
  pos: Vec3Tuple
  quat: QuatTuple
  yaw: number
  /**
   * `'elevator'` when this mission's SHIP can start one, else `'direct'`.
   *
   * It used to read "when the mission has a `LaunchElevator`", which is a
   * property of the scene and not of the ship. `LaunchElevator.StartLaunch()`
   * has exactly three call sites and all three are in `Input_Ship*.cs`; the
   * JumpSeat prefab carries no `Input_Ship`, so it cannot start one however many
   * elevators stand around it — and five of the six JumpSeat scenes contain one,
   * because `playerstart_jumpSeat.prefab` has an elevator of its own.
   *
   * `int_01_jumpSeat` is the case that makes a distance heuristic useless: the
   * HoverJet's `PlayerStart_ElevatorShaft_Photon` is 1 m from the JumpSeat's
   * spawn and its own start prefab is 2.8 km away, so "the nearest elevator"
   * would have picked the wrong one with complete confidence. `launchTrace`
   * carries the receipt.
   */
  launchKind?: 'elevator' | 'direct' | null

  /**
   * The launch elevator's motion, read from `elevator_up.anim`.
   *
   * The spawn marker is at the BOTTOM of the shaft. On `int_01` that is 19.8 m —
   * roughly 95 m under the ocean surface, and deep inside the 164 m fog plane
   * where horizontal visibility is under 2% at a kilometre. A port that spawns
   * there and skips the ride starts the player underwater in total fog, which
   * reads as broken fog rather than as a missing animation. It did, twice.
   *
   * `keys` is a Unity `AnimationCurve`: evaluate as cubic Hermite, do not lerp.
   */
  launch?: {
    readonly clip: string
    readonly keys: readonly {
      readonly time: number
      readonly value: number
      readonly inSlope: number
      readonly outSlope: number
    }[]
    /** Total metres risen — 106.647 on `int_01`. */
    readonly rise: number
    /** `m_StopTime` of the clip. */
    readonly duration: number
    /** When the platform stops moving, which is 1.5 s before the clip ends. */
    readonly settledAtSeconds: number
    /** When the ship is let go. INFERRED — see `releaseInferred`. */
    readonly releaseAtSeconds: number
    /**
     * True because `LaunchElevator.FinishLaunch()` has no live caller in the
     * 2016 project: the clip has no animation events, the controller has no
     * state-machine behaviours, and the only call site anywhere is inside a
     * commented-out block. The release moment is taken as the end of the clip.
     */
    readonly releaseInferred: boolean
    /**
     * The deck you ride, MEASURED. `size` is the 2016 mesh's own `m_LocalAABB`
     * times its prefab scale; the mesh itself is licence-blocked and FF2 draws
     * its own (see `render/elevator.ts`).
     */
    readonly platform?: {
      readonly mesh: string
      readonly meshShippable: boolean
      readonly size: readonly number[]
      readonly offset: readonly number[]
      readonly scale: number
      readonly shipOffset: readonly number[]
    } | null
    /**
     * Eight segments are authored and SEVEN ARE DISABLED. The ride is 106 m of
     * open air with a collar of structure near the top, and filling in the other
     * seven would invent a tunnel the game never had.
     */
    readonly shaft?: {
      readonly meshes: readonly string[]
      readonly meshShippable: boolean
      readonly segmentsAuthored: number
      readonly segmentSpacing: number
      readonly liveSegmentLocalY: readonly number[]
      readonly deadSegmentLocalY: readonly number[]
    } | null
  } | null

  /**
   * `Mover_Lift.amplitude`, kept ONLY as evidence. Not the release height.
   *
   * It sits on the same GameObject as the real Animator, is tuned to 108.5, and
   * never ran: its `move` flag is 0 and nothing in the 2016 codebase sets it.
   * Two metres from the truth, which is close enough to look like rounding.
   */
  deadMoverLiftAmplitude?: number | null
  /**
   * `Trigger_EnableShip.delay` — null when the mission's ship has no
   * `Ship_HoverShip`, because `EnableShip()` is guarded on exactly that and does
   * nothing at all without it. Null is therefore "this cannot happen here",
   * not "not extracted".
   */
  enableShipDelay?: number | null
  /** `Trigger_EnableShip.enableGravity`, null for the same reason. */
  enableGravityOnLaunch?: boolean | null
  /**
   * The JumpSeat's start sequence, and null wherever the elevator does the job.
   *
   * `Trigger_EnableJumpShip` lives inside `playerstart_jumpSeat.prefab` — a
   * stripped instance, so invisible to an unexpanded scene read, which is why
   * six missions were credited with an elevator ride they never had. On entering
   * it the ship stays inert for `triggerDelay` plus `countdownSteps` beats of
   * one second, then `Input_Manager`, `HoverMotor` and `Thruster` switch on.
   * 3.5 + 4 = 7.5 s on all six.
   */
  jumpStart?: {
    readonly pos: Vec3Tuple
    /** Off the shipped prefab. The C# initialiser agrees, which proves nothing. */
    readonly triggerDelay: number
    /** A bare literal in `Countdown_JumpSeat(4)`; nothing serialises it. */
    readonly countdownSteps: number
    readonly seconds: number
  } | null
  /**
   * Why `launchKind` says what it says — a structural claim's receipt (§4.7).
   * `starterScriptsInProject` is every MonoBehaviour that calls
   * `LaunchElevator.StartLaunch()`, scanned from the 2016 source rather than
   * listed, and `starterScriptsOnShip` is the intersection with this mission's
   * own ship prefab. Empty means the ride is impossible.
   */
  launchTrace?: {
    readonly canStartElevator: boolean
    readonly starterScriptsInProject: readonly string[]
    readonly starterScriptsOnShip: readonly string[]
    readonly enableShipGuardComponent: string
    readonly enableShipApplies: boolean
  }
  marker?: string
  /**
   * DEV-101. Where the pre-launch pose came from, and what
   * `Level.SinglePlayerSpawnPosition` said instead.
   *
   * On a rigged mission the pose is the elevator's own seat —
   * `LaunchElevator.PlayerShipRoot`, the node 2016's `StartLaunch()` parents the
   * ship to with `localPosition = Vector3.zero`. It used to be the Level field,
   * which is the same node on six of the seven rigs and, on
   * `rookie_02_hoverJet`, the RESPAWN marker 107.010 m up the shaft. 2016 cannot
   * see that: `Level.respawning` is serialised 1 in all thirteen scenes, so
   * `Level.cs:287-294` reads the respawn marker and the spawn field is dead YAML.
   *
   * Null where there is no rideable elevator.
   */
  seatTrace?: {
    readonly node: string
    readonly seatRef: string | null
    /** Null where the rig is a prefab instance and the field is prefab-internal. */
    readonly seatRefAgrees: boolean | null
    readonly spawnFieldNode: string | null
    readonly spawnFieldAgrees: boolean | null
    readonly spawnFieldAboveSeat: number | null
  } | null
}

/**
 * BOTH fields are required and there is NO global fallback for a loader to fall
 * back *to*. A missing `boundary` block is a schema error, not a silent
 * 10-second death timer.
 *
 * `PlayerBoundary` is DISABLED in 6 of the 13 shipped missions (no
 * out-of-bounds death at all — a player feels that immediately), and where it
 * is enabled `resetDelay` is **13** in all 13 scenes. The C# initialiser says
 * 10. That is the third time a C# default has been caught standing in for
 * shipped behaviour, and this schema is where it stops.
 */
export interface Boundary {
  enabled: boolean
  resetDelay: number
  present: boolean
  /**
   * The region you must stay INSIDE. `PlayerBoundary` is a trigger and the clock
   * starts on `OnTriggerExit`, so this is a volume, not a wall.
   *
   * Every shipped one is a sphere, sized per COURSE — 2918.7 m on `int_01`,
   * 1797.5 on `rookie_01`. Null when the mission has no boundary component.
   */
  volume?: {
    readonly shape: 'sphere' | 'box'
    readonly centre: Vec3Tuple
    readonly radius?: number
    readonly half?: readonly number[]
    readonly isTrigger: boolean
    readonly gameObject: string
  } | null
  /** `Trigger_Kill`'s fade before the reload. 2.5 s, and it is the death beat. */
  resetFadeSeconds?: number
}

/** 5 of 13 missions override fog, spanning 0.03–0.2. Simonet and Kauai use 164 / 0.2. */
export interface Fog {
  height: number
  heightDensity: number
  startDistance: number
  distanceFog: boolean
  heightFog: boolean
  color: [number, number, number, number]
  density: number
  /** Unity `FogMode`: 1 linear, 2 exponential, 3 exponential squared. */
  mode: number
  /** Only meaningful when `mode` is 1. */
  linearStart: number
  linearEnd: number
  /** `RenderSettings.m_Fog`. The post-process runs regardless; this gates the distance term. */
  sceneFogEnabled: boolean
  /** Fog by true distance rather than view depth. */
  radial: boolean
  excludeFarPixels: boolean
}

/**
 * The sun, and the ambient it sits in — a PER-MISSION constant.
 *
 * `Prefabs/Levels/LevelArt_<env>.prefab` carries a GameObject called
 * "Directional light" and it is `m_IsActive: 0`. What actually lights the world
 * is a disconnected copy of it in each mission scene, pointing elsewhere. So
 * lighting is not a property of the environment: across the 13 shipped levels
 * the sun runs from 0.1 deg of elevation (`int_02_hoverJet`, effectively sunset)
 * to 56.8 deg (`rookie_01_jumpSeat`), intensity 0.5 to 1.3, colour warm orange
 * to near-white. Two missions on the same island look nothing alike.
 */
export interface SunLight {
  name: string
  kind: 'directional' | 'spot' | 'point' | 'area' | string
  /**
   * LINEAR rgb per unit of intensity: `colorLinear × intensity` is what 2016's
   * shader received, Unity 5.4's `GammaToLinearSpace(m_Color × m_Intensity)`
   * (DEV-454, `tools/extract/unity-light.mjs`). This said *"Unity serialises
   * light colour in linear space already"* until DEV-454, and the field held
   * the raw `m_Color` — so every mission's sun was drawn paler than 2016's.
   */
  colorLinear: [number, number, number]
  /**
   * The raw `m_Color`, GAMMA, as the inspector shows it and the YAML stores
   * it. Provenance, and what `?sunlight=port` draws as if it were linear (the
   * port's rule before DEV-454, kept for A/B).
   */
  colorGamma: [number, number, number]
  /** `m_Intensity`, as authored. */
  intensity: number
  /** Unity shadow type: 0 none, 1 hard, 2 soft. */
  shadows: number
  /** Unit vector the light TRAVELS along, three.js space. */
  direction: [number, number, number]
  /** Degrees above the horizon. 0 is sunset; 90 is overhead. */
  elevationDeg: number
}

export interface Ambient {
  /** Unity `m_AmbientMode`: 0 skybox, 1 gradient, 3 flat. */
  mode: number
  modeName: 'skybox' | 'gradient' | 'flat' | null
  intensity: number
  skyColor: [number, number, number]
  equatorColor: [number, number, number]
  groundColor: [number, number, number]
}

export interface Lighting {
  /** Null only if a mission ships with no live light at all. None do. */
  sun: SunLight | null
  ambient: Ambient
  /** Path to the skybox material in the 2016 project. Third-party; do not ship. */
  skyboxMaterial: string | null
  /** The skybox's own colour as SH. See `MissionSky`. */
  sky: MissionSky | null
  /** Liveness receipts, not values to render with. */
  liveLightCount: number
  /**
   * Lights contributed by the additively loaded environment scene. **Must be 0.**
   * A second directional light would double the effective sun, and the
   * environment scene is exactly where one would come from.
   */
  environmentSceneLiveLights: number
  disabledLightCount: number
}

/**
 * FF2's ring thresholds — what a Ring Attack run is actually awarded against.
 *
 * `Level.medals` stays exactly as 2016 shipped it, so the ledger keeps a
 * faithful record. This is the working curve. Bronze, silver and gold are
 * 2016's; PLATINUM IS EVERY RING, the ring ceiling (Matt, 2026-09-25: *"gold
 * medal = 90, plat = 100"*, the DEV-393 follow-up). A missed ring forfeits the
 * time bonus (DEV-393), so a run reaches platinum exactly when it takes every
 * ring. That keeps DEV-003's fix: `rookie_01_hoverJet`'s 2016 platinum of 1700
 * is above its 16 x 100.
 *
 * DEV-004 introduced the field with a platinum ABOVE the ceiling, priced at a
 * reference pace nobody reached; that is retired.
 *
 * A copy of `medals` (no ring ceiling to hold it to) on a mission with no live
 * rings, and `null` where 2016's own are null.
 */
export interface MedalsFf2 extends Medals {
  _meta?: Record<string, unknown>
}

/**
 * DEV-061 — FF2's own forcing decision, where it differs from 2016's.
 *
 * `Level.forcedMode` stays exactly what the 2016 scene says. This is the
 * separate field the game reads, the same deal `medalsFf2` makes with `medals`
 * (DEV-004) and `posFf2` with `pos` (DEV-067): the ledger keeps a faithful
 * record and the game keeps working content.
 *
 * **It is an object and not a bare `GameMode | null`, and that is the point.**
 * The value FF2 wants for `int_02_jumpSeat` IS null — *force nothing* — which
 * under this repo's `xFf2 ?? x` idiom would be indistinguishable from "no
 * deviation" and would silently fall back through to 2016's forcing. Wrapping it
 * makes `level.forcedModeFf2 ?? level.forcedMode` a **type error** instead of a
 * quiet bug. Read it only through `game/modes.ts`'s `runningMode`.
 */
export interface ForcedModeFf2 {
  /** What FF2 forces. **Null means FF2 forces NOTHING**, not "no opinion". */
  mode: GameMode | null
  _meta?: Record<string, unknown>
}

export interface Medals {
  bronze: number
  silver: number
  gold: number
  platinum: number
}

export interface Timer {
  timeLimit: number
  bonusParTime: number
  shadowedParTime: number
  /**
   * The 3-2-1-GO after the elevator reaches the top — and 2016 really did run
   * it, which is DEV-048 and supersedes DEV-015.
   *
   * This block used to carry one boolean, `shipped`, read straight off
   * `Timer_Race.useCountdown` — 0 on all thirteen — and the port concluded the
   * countdown had been built, tuned and switched off. It had not. `useCountdown`
   * gates exactly ONE caller, `Timer_Race.OnEnable`. `StartCountdown()` is
   * public, and `Trigger_EnableShip.DelayedEnable()` calls it after its own
   * `delay` with no reference to the flag. Six of the seven HoverJet missions
   * wire a live trigger to the live timer, and so does `int_01_jumpSeat` (which
   * places the HoverJet's whole elevator shaft). The race clock starts there
   * too: `useRaceTimer = true` is set at the end of the same coroutine.
   *
   * So the two facts are separate and `shipped` is DERIVED from them — the
   * point of the finding is that the flag and the behaviour disagree, and a
   * single boolean is what hid it. `rookie_01_hoverJet` is the one HoverJet
   * mission with no `Trigger_EnableShip` at all, and is the case that a flag
   * could never have told apart from the other six.
   *
   * The numbers are the shipped component's, not invented. `seconds` is
   * `(steps + 1) * stepSeconds`, because `Timer_Race.Countdown()` fires GO on
   * the beat AFTER the last number: four beats for a 3-2-1-GO, not three. Note
   * `stepSeconds` is 1 where the C# initialiser says 0.5 — the cardinal rule
   * earning its keep on a feature whose own flag was off.
   */
  countdown?: {
    /** Derived: `useCountdownFlag || startedByTrigger`. Does a countdown happen. */
    readonly shipped: boolean
    /** `Timer_Race.useCountdown`. False in all thirteen; it only gates `OnEnable`. */
    readonly useCountdownFlag: boolean
    /** A live `Trigger_EnableShip` wired to the live `Timer_Race`. The real route. */
    readonly startedByTrigger: boolean
    /** `Trigger_EnableShip.delay` — the wait before the countdown begins. 2 s, 4 s on `rookie_02_hoverJet`. */
    readonly triggerDelay: number | null
    readonly steps: number
    readonly stepSeconds: number
    readonly seconds: number
  } | null
}

export interface Scoring {
  /** 100 in every shipped mission. A ring's points are `addScore * this`. */
  gateMultiplier: number
  levelDelay: number
  timePenalty: number
  timeBonusMultiplier: number
  fuelPenaltyEnabled: boolean
  /**
   * 2016 ignored time for medals (rings × 100). FF2's slice weights it and
   * races a personal-best ghost — a deliberate, logged deviation (D25).
   */
  timeAffectsMedal: boolean
}

export interface Orb {
  i: number
  live: boolean
  /** Where 2016 put it. Faithful, and not always where the game flies it — see `posFf2`. */
  pos: Vec3Tuple
  /**
   * DEV-067: where FF2 actually puts it, or null to use `pos`.
   *
   * Non-null on exactly the five `hoverJet_kauai_beg` orbs 2016 left inside the
   * mountain. Read it through `game/orbs.ts`'s `orbPos`, never directly — the
   * sim's hit test and the art must not be able to disagree about where an orb
   * is. Same shape as `medalsFf2`.
   */
  posFf2: Vec3Tuple | null
  speed: number
}

export interface GhostRef {
  /** Baked Animator clip name. Ghosts were NEVER physics replays (D20). */
  clip: string
  spawn: Vec3Tuple
  quat: QuatTuple
  startTime: number
  /**
   * DEV-442: where the recording BEGINS, THREE world space: the clip's first
   * root key through the ghost's parent. `spawn` is the object's own transform,
   * which is not where the ship was (on `rookie_02` it is 440 m away). Absent on
   * a hand-authored level; null where the extractor could not read the clip.
   */
  start?: Vec3Tuple | null
}

export interface Generated {
  seed: number
  generator: string
}

/**
 * A cyan chevron marking a turn in the course.
 *
 * Placed in TRIOS — nine on `int_01` is three turns, not nine turns. Kept in
 * authored order because the trio order is the reading order. HoverJet only:
 * every JumpSeat mission carries zero.
 *
 * `live` is already applied by the extractor's hierarchy walk, but it is kept
 * on the row rather than filtered out, so `adv_01`'s three dead markers stay
 * visible as data.
 */
export interface TurnIndicator {
  i: number
  name: string
  live: boolean
  /** THREE space, world. */
  pos: Vec3Tuple
  quat: QuatTuple
  scale: Vec3Tuple
  /**
   * DEV-198. The arrow child's own pose, when THIS scene re-aimed it. `null`
   * on 87 of the 114 live markers, where {@link TurnIndicatorArt} says what to
   * use instead.
   */
  art: TurnIndicatorArt | null
}

/**
 * `turnIndicator_art (2)` — the arrow mesh inside the prefab — as one shipped
 * scene overrode it (DEV-198).
 *
 * ── UNITY SPACE, and prefab-LOCAL ─────────────────────────────────────────
 *
 * Unlike `pos`/`quat` on the row above, which are three-space WORLD poses the
 * extractor already converted, this is the same quantity and the same space as
 * `PROPS.turnIndicator.arrow` in the constants sheet — because it is literally
 * that node's transform, read from the scene instead of from the prefab. It
 * replaces the sheet's entry for this one placement and goes through
 * `unityPose` exactly as the sheet's does.
 *
 * Two of the thirteen scenes carry these, both in Mesa Canyon: `rookie_02` on
 * all 21 placements and `adv_01` on 6 of 21. Everywhere else the sheet's own
 * value — identity — is the shipped one, and this is `null`.
 *
 * `position` and `scale` come back as the prefab's own (nothing in 2016 moves
 * or resizes the arrow), and `turn-indicator.test.ts` asserts that against the
 * sheet rather than assuming it.
 */
export interface TurnIndicatorArt {
  name: string
  position: Vec3Tuple
  rotation: QuatTuple
  scale: Vec3Tuple
}

/**
 * One of the environment's background clouds — a PLACEMENT, not an asset.
 *
 * The 2016 meshes are `Assets/Geometric-Landscape-Tropic-Island`, a bought
 * pack, so they are `licence: REPLACE` and can never ship (D26). What comes
 * across is where each cloud is, how big, which way up, and which of three
 * silhouettes the artist reached for; the geometry is generated first-party.
 *
 * NEVER empty for a shipped environment, and it used to be for two of them.
 * The four environments are authored two different ways: simonet and desert
 * place a `Prefabs/Levels/LevelArt_<env>.prefab` and their clouds have to be
 * composed through the instance, while alpine and kauai bake the whole level
 * art into the environment SCENE and instantiate nothing. The extractor knew
 * only the first shape, so alpine and kauai reported zero — and the comment
 * that justified it said an environment which stopped instantiating the prefab
 * "would simply stop reporting clouds", which described the bug as if it were a
 * property. Live counts are simonet 19, alpine 8 (of 11 authored), desert 3
 * (of 6) and kauai 19; `_structural-assertions.json` pins all four.
 */
export interface CloudPlacement {
  i: number
  name: string
  /** THREE space, world. Already composed through the prefab instance. */
  pos: Vec3Tuple
  quat: QuatTuple
  /**
   * Non-uniform, and that IS the variety: 182 m to 893 m across, with y
   * typically 40-50% of x, so they read as flattened slabs rather than balls.
   */
  scale: Vec3Tuple
  /** `"01"` | `"02"` | `"03"` — which source silhouette, or null if unresolved. */
  shape: string | null
}

/**
 * One piece of scenery a MISSION scene places — DEV-218, DEV-219.
 *
 * Structurally a {@link PropLandmark} in `src/content/load-environment.ts`, in
 * the same Unity-space frame, which is the point: `load-props.ts` concatenates
 * mission props with environment landmarks and draws both through one path.
 *
 * Whether it is scenery at all was decided by the ENVIRONMENT's own prop
 * vocabulary — the mesh is named by one of its landmarks or scatter-palette
 * entries — because nothing cheaper separates it from gameplay geometry. "The
 * mesh appears in the environment's art tree" admits the ghost racer's meshes
 * and a light projector on five missions and misses every palm; provenance
 * cannot tell `MM_RocaGrandeLOW` (scenery) from `MM_Corner_Short_01` (the
 * launch platform), both `LICENSED` bakes in the same directory. The rule that
 * works selects 1 / 11 / 12 on three missions and zero on the other ten.
 */
export interface MissionProp {
  name: string
  /** The LEGACY mesh path — the provenance, not something to load. */
  mesh: string
  /** Bucket path, e.g. `assets/props/spire-b.glb`. Null when unresolved. */
  meshAsset: string | null
  /** `spire`, `rock`, `palm` — the environment layer's own classification. */
  kind: string | null
  origin: string
  licence: string
  /**
   * The full `m_IsActive` walk — the object AND every ancestor, the ring-count
   * rule. A dead instance is not content, and there are five of them:
   * `rookie_02_jumpSeat` authors four dead spires and `int_01_jumpSeat` one
   * dead palm.
   */
  live: boolean
  /**
   * Whether 2016 gave it an enabled, non-trigger collider — and this is NOT
   * derivable from the name. `MM_BigRock_collider` has **no collider at all**
   * (classes 1/4/23/33/95, no 64/65/135/136) while `Spire_B_w_Collision` has
   * one, so the name told the truth in one case and lied in the other; neither
   * is evidence. `Spire_C` and `Spire_D` carry none either.
   */
  solid: boolean
  /** GameObject chain from the scene root, for a reader. */
  path: string
  /** Unity space, composed to `levelOffset` (exclusive). */
  position: Vec3Tuple
  rotation: QuatTuple
  scale: Vec3Tuple
}

/**
 * One trigger volume inside a jump pad, in WORLD space and at its real size.
 *
 * Unity sizes a collider by the transform's scale, and never the way the three
 * numbers look: a box's half-extent is `size/2 * |scale|` component-wise, a
 * sphere's radius is `radius * max|scale|`, and a capsule's radius uses the two
 * axes PERPENDICULAR to the one it runs along. Those products are already done
 * here — the fields below are metres, ready to test a point against.
 *
 * `pos` is the collider's centre, not the GameObject's origin: `m_Center` has
 * been scaled and rotated into the world. Two of the pad's volumes carry a
 * non-zero one.
 */
export interface PadVolumeBase {
  /**
   * What the volume is for, from the SCRIPT on it, never the name — eight
   * objects called `collider_ground (N)` are one ring of the target.
   *
   * `landing` is `Trigger_JumpPad`, `refuel` is `Trigger_Refuel`, `score` is
   * `Trigger_JumpTarget`. What a `score` hit is WORTH is the JumpSeat mode's
   * business, not this file's; the pad's own `canvas_scoreLabels` reads
   * 100 / 50 / 50 / 25 / 25, which is a lead, not a rule.
   */
  role: 'landing' | 'refuel' | 'score'
  /** The GameObject's name inside the pad prefab. */
  name: string
  /** Path relative to the pad root — `jumpPad 1/trigger_large_section (1)/…`. */
  path: string
  /** False when an ancestor is inactive. Kept rather than filtered, like a dead pad. */
  live: boolean
  /** World centre, THREE space. */
  pos: Vec3Tuple
  quat: QuatTuple
}

export interface PadBoxVolume extends PadVolumeBase {
  kind: 'box'
  /** Half extents in metres, world-scaled. */
  half: Vec3Tuple
  /**
   * `Trigger_JumpTarget.val_score` — 100 / 50 / 25 — read off the expanded
   * instance (DEV-121). Present on every `score` volume. `game/targets.ts`'s
   * `TIER_POINTS` is the game's reading of the tier; this is 2016's number on
   * the plate, and the two are held equal by `pad-zones.test.ts`.
   */
  points?: number
  /**
   * `Trigger_JumpTarget.refuelMultiplier` — 3 on the bullseye, 1.5 on the mid
   * ring, 1 on the outer — and `giveRefuelBonus`, which is **false on every
   * shipped plate**: `Trigger_JumpTarget.cs:60-63` only multiplies the pad's
   * `refuelRate` by this when the flag is set, so 2016 refuelled at a flat
   * 10/s wherever you landed. The tiered reward was authored and switched off.
   */
  refuelMultiplier?: number
  giveRefuelBonus?: boolean
  /** `trigger_once`. 1 everywhere. */
  triggerOnce?: boolean
}

export interface PadSphereVolume extends PadVolumeBase {
  kind: 'sphere'
  radius: number
}

export interface PadCapsuleVolume extends PadVolumeBase {
  kind: 'capsule'
  /** The LOCAL axis the capsule runs along. `y` on every shipped pad. */
  axis: 'x' | 'y' | 'z'
  radius: number
  /** Total length, already clamped to Unity's minimum of `2 * radius`. */
  height: number
  /**
   * True when that clamp swallowed the cylinder, so the volume IS a sphere.
   *
   * Every shipped pad is in this state: the landing capsule is r 0.951 x 29.83 =
   * 28.4 m against h 0.5 x 21.1 = 10.6 m. A port that draws a tall capsule is
   * drawing something the 2016 physics never had.
   */
  degenerateToSphere: boolean
  /**
   * `Trigger_Refuel.refuelRate`, units per second, off the expanded instance
   * (DEV-121). 10 on every shipped pad; present on every `refuel` volume. The
   * number `game/jumpseat-flight.ts` hand-carried until the extractor read it.
   */
  rate?: number
}

export type PadVolume = PadBoxVolume | PadSphereVolume | PadCapsuleVolume

/**
 * The surface the seat LANDS on (DEV-120) — `target_jumppad.prefab`'s one live
 * solid collider, the non-trigger `MeshCollider` on `jumpPad_04_collider`
 * (layer 0, which the HoverMotor's mask hits), as a RADIAL PROFILE.
 *
 * The mesh is a stepped octagonal bowl, centre lowest: at the shipped scale the
 * bullseye floor is 1.78 m below the pad root, the mid ring 0.35 m below and
 * the outer ring 0.97 m above, 40.6 m across. `profile` walks from the centre
 * to `outer` as `[radius, height]` pairs in metres, radius in the n-gon norm
 * (`sim/pad-surface.ts`), height above `pos[1]`; a vertical wall is two points
 * at one radius. `tools/extract/pad-solid.mjs` reads it off the FBX and refuses
 * a mesh whose vertex and edge rays disagree.
 */
export interface PadSolid {
  kind: 'radialProfile'
  name: string
  /** Path relative to the pad root. `jumpPad_04_collider` on every shipped pad. */
  path: string
  live: boolean
  /** The 2016 mesh asset, for the ledger. Not loaded by the game. */
  mesh: string
  /** The collider NODE's world transform, THREE space. NOT the pad root's. */
  pos: Vec3Tuple
  quat: QuatTuple
  /** Rotational symmetry: 8. A vertex lies on the node's local +x. */
  symmetry: number
  profile: [number, number][]
  /** Last radius with surface under it, metres. */
  outer: number
  /** Highest surface height above `pos[1]`, metres. Derivable from `profile`. */
  top: number
  /**
   * The mesh's LOWEST point above `pos[1]`, metres: the pad's underside
   * (`pad-solid.mjs` writes `bounds.min[1]`). NOT derivable from `profile`,
   * which is the top surface only, and below every profile height (-0.71 against
   * a 0.71 bullseye floor on the shipped pad). `game/pad-art.ts` draws the
   * underside here, and the collision treats the pad as absent below it:
   * `buildPadField`'s `underside`, read through `belowField` by the hull, the
   * legs, the hover ray (DEV-383) and the head strike (DEV-403).
   */
  bottom: number
}

/**
 * A JumpSeat landing target — `target_jumppad.prefab`, placed.
 *
 * Six of the thirteen missions carry them, 5 to 13 each; `rookie_02_jumpSeat`
 * carries 11 pads AND 29 rings, so a pad mission is not automatically ringless.
 *
 * **`scale` is not an extent — it is a multiplier.** Eleven pads ship at scale
 * 1 and the largest at 18.6, while the landing volume they describe runs from
 * 28.4 m to 527 m: measured across all 57 shipped pads, the landing radius is
 * exactly `28.3695 * max|scale|`, because the trigger child carries its own
 * 29.83 scale and a 0.951 collider radius on top. So reading `scale` as a size
 * does not give an obviously silly number — it gives a plausible one, 28 times
 * too small. Use `landing` / `refuel` / `zones`, which are already in metres.
 * Same trap as `FinishGate`, one prefab layer deeper.
 *
 * `live` is already the liveness walk's answer and is kept rather than filtered:
 * `rookie_02_jumpSeat` places 11 pads with four of them under a GameObject
 * called `GameObject` whose `m_IsActive` is 0, so seven are reachable. A dead
 * pad is data — it says where the level designer stopped.
 */
export interface Pad {
  i: number
  name: string
  live: boolean
  /** THREE space, world. */
  pos: Vec3Tuple
  quat: QuatTuple
  /** The instance's transform scale. NOT a collider extent — see above. */
  scale: Vec3Tuple
  /**
   * The volume that says you landed on the pad (`Trigger_JumpPad`).
   *
   * Null only if the extractor could not read the pad's interior, which
   * `pnpm extract:levels --check` turns into an exit 1: a pad the game cannot
   * detect a hit on is not content.
   */
  landing: PadCapsuleVolume | null
  /** `Trigger_Refuel` — a second, smaller capsule concentric with the landing one. */
  refuel: PadCapsuleVolume | null
  /**
   * The scoring rings, 17 on every shipped pad: one `trigger_bullseye` box and
   * eight each under `trigger_mid_section` and `trigger_large_section`. Their
   * `path` says which ring; their point value does not live here.
   */
  zones: PadBoxVolume[]
  /**
   * The landing surface (DEV-120). Null only if the extractor could not read
   * the collider, which `pnpm extract:levels --check` turns into an exit 1: a
   * pad the seat falls through is not content.
   */
  solid: PadSolid | null
}

/**
 * What the mission says, in 2016's own words.
 *
 * Read from the prefab `Level.ShipPrefab` names — the same reference that
 * decides the vehicle — because that is where a Unity UI label lives:
 * `UnityEngine.UI.Text.m_Text`, on the HUD inside the ship. So the HoverJet
 * missions and the JumpSeat missions carry different sets, and a mission that
 * ever shipped its own wording would simply differ.
 *
 * **Byte-exact, including the capitalisation.** 2016's HUD is inconsistent on
 * purpose-by-accident and the port must not tidy it: `Speed :` has a space
 * before the colon, `Orbs FounD:` and `Exploration EnDing...` carry a stray
 * capital D, and the medal banner is `________ medal AwarDeD!` — eight
 * underscores and a lower-case `medal`, not the `<medal> Medal AwarDeD!` the
 * research corpus quotes.
 */
export interface LevelUi {
  /**
   * The mission briefing. `panel_mission` is killed 3.8 s after it goes live,
   * by its own `disableAfterDelay` on the ship prefab — not by `HUD_Ship`,
   * whose separate 4.12 s hide lands on an already-inactive panel (DEV-217).
   * Whether it is live AT SPAWN differs by vehicle, exactly as the sets above
   * do: it is on the HoverJet and is not on the JumpSeat, so the per-level
   * `ui._meta.briefing.liveAtSpawn` is the authority and this line is not.
   * **Ends in a newline** — that is in the shipped bytes, not an artefact, and
   * the straight apostrophe in `Don't` is U+0027.
   */
  briefing: string
  /**
   * The HUD's fixed labels. Present keys differ by vehicle: the HoverJet set
   * has the gate/time/speed instruments and the end-of-run panel, the JumpSeat
   * set has a fuel gauge instead.
   */
  strings: Record<string, string>
}

/**
 * The mission's visible skybox, projected to spherical harmonics.
 *
 * Nine coefficients per channel in UNITY space, three.js `SphericalHarmonics3`
 * order. `available` is false for the ten missions whose skybox is a Unity
 * `.cubemap` binary the extractor cannot decode; those fall back to a gradient.
 * The three that decode are the `Skybox/6 Sided` SkyJ missions.
 *
 * `sunAngleDeg` is the receipt: the angle between the sky's brightest direction
 * and the mission's own sun, two numbers the projection never mixes. 1.5° on
 * `int_01_hoverJet`, which is what validates the skybox face mapping.
 */
export type MissionSky =
  | {
      available: true
      material: string
      faces: Record<string, string>
      sh: number[][]
      bands: number
      residual: number
      sampleCount: number
      peakDirectionUnity: number[]
      sunAngleDeg: number
      reason?: undefined
    }
  | { available: false; material: string | null; reason: string; sh?: undefined }

/**
 * The gate that ENDS a run. Non-scoring, and not one of the rings.
 *
 * 2016 does not end a Ring Attack run when you take the last ring: a separate
 * `Trigger_FinishLine` sits beyond it, and its `OnTriggerEnter` on the player
 * calls `finaleLogic.StartEnd()`. On `int_01` that gate is **234.6 m past ring
 * 21**, so a port that stops at the last ring stops a quarter of a kilometre
 * early — and DEV-004's platinum was derived at a reference pace over the
 * course length, which is the number that has to move with it.
 *
 * **It is a union of SPHERES, not a plane.** `radius` is the big one (68.59 m
 * on every shipped mission); `spheres` is all three, the other two being 32.06 m
 * balls offset inside it. The transform's world scale is (65.7, 74.6, 4.2),
 * which LOOKS like a thin gate and is not a collider extent at all — Unity
 * sizes a SphereCollider by `radius * max|lossyScale|`. Treating those three
 * numbers as a box is how you build a plane the player can fly around.
 */
export interface FinishGateSphereUnion {
  shape: 'sphereUnion'
  pos: Vec3Tuple
  quat: QuatTuple
  /**
   * The largest trigger sphere, in metres, centred on `pos`. THE gate: the run
   * ends when you are inside it.
   */
  radius: number
  /** Every trigger sphere, with its centre in the gate's own local space. */
  spheres: { radius: number; center: Vec3Tuple }[]
  /**
   * What the finish gate LOOKS like — DEV-123. Absent on levels extracted
   * before the finish had art; the game draws nothing for those.
   */
  art?: FinishGateArt
}

/** One renderer's world pose, THREE space. */
export interface WorldPose {
  pos: Vec3Tuple
  quat: QuatTuple
  scale: Vec3Tuple
}

/**
 * The finish gate's renderers, as WORLD poses (DEV-123).
 *
 * 2016's finish is the ring's own `jumpGate_diamond` mesh at world scale
 * **23.56** — three times a ring's 7.77 — wearing `checkpoint_finish.mat`
 * (orange, where a ring is green), inside a cage of **40** built-in cubes on
 * `glowyMaterial` where a ring has 18 — 24 around the frame and four groups of
 * four 84-102 m bars fanned from its corners. Emitted composed rather than as a
 * prefab-local chain like `PROPS.checkpointRing`: the cubes hang under four
 * intermediate pivots with rotations of their own, and the expanded scene has
 * already multiplied every one of them out along with any instance override.
 * The material paths travel so the game can assert the colour it draws is the
 * finish's.
 */
export interface FinishGateArt {
  frame: WorldPose & { mesh: string; material: string }
  studMaterial: string
  studs: WorldPose[]
  _meta?: Record<string, unknown>
}

/**
 * The JumpSeat's finish gate — a convex mesh, and the third victim of the
 * stripped-prefab trap.
 *
 * It is not a scene object. `Trigger_Finish_JumpSeat` lives inside
 * `target_jumppad.prefab`, on `finale_jumpSeat (1)/trigger_finishLevel`, which
 * ships **inactive**; exactly one pad instance per mission carries the
 * `m_IsActive` override that switches it on. `adv_02_jumpSeat` serialises 26 of
 * them and one is live. So `finish: null` on the six JumpSeat missions was the
 * extractor not looking, not the object being absent.
 *
 * **A different SHAPE, which is why this is a discriminated union and not two
 * optional fields.** The HoverJet's gate is a sphere union; this is a convex
 * `MeshCollider` over `hexTile.fbx` — a 30.345 × 5.653 × 28.860 m slab, measured
 * by decoding the FBX (`tools/extract/fbx-bounds.mjs`) at Unity's own 0.1 import
 * scale, not by reading the transform. Giving the two one field called `radius`
 * that means a sphere here and a half-extent there is how the 65.7 / 74.6 / 4.2
 * mistake happened the first time.
 */
export interface FinishGateConvexMesh {
  shape: 'convexMesh'
  /**
   * The COLLIDER's centre — the mesh's own AABB centre, scaled and rotated into
   * the world. `hexTile`'s bounds are not centred on its origin, so this sits
   * 2.86 m above and 1.5 m in front of the GameObject (`_meta.originPos`).
   */
  pos: Vec3Tuple
  quat: QuatTuple
  /**
   * **BROAD PHASE ONLY.** The bounding sphere of the hull, 21.13 m — bigger
   * than the gate in every direction. It exists so a caller that only wants a
   * cheap "am I anywhere near the finish" test has one, and so that code
   * written against `FinishGateSphereUnion.radius` degrades safely rather than
   * silently treating a half-extent as a radius. The GATE is `half` / `hull`.
   */
  radius: number
  /** The 2016 mesh asset. Third-party geometry; a placement, not something to ship. */
  mesh: string
  convex: true
  /**
   * Half extents in metres, in the gate's OWN frame — apply `quat` to orient
   * them. Not a world AABB: two of the six pads carry a yaw.
   */
  half: Vec3Tuple
  /**
   * The hull's ten vertices, in the gate's own local frame — scaled, relative
   * to `pos`, unrotated, exactly like `spheres[].center` on the other variant.
   * A world point is `pos + quat * hull[i]`.
   *
   * They are here because the collider is CONVEX: `half` is the bounding box of
   * a hull and therefore an over-approximation, and these are the true shape.
   */
  hull: Vec3Tuple[]
}

/**
 * What ends a run. Narrow on `shape` before reading anything but `pos`, `quat`
 * and `radius` — and read the warning on `FinishGateConvexMesh.radius` before
 * relying on that one either.
 */
export type FinishGate = FinishGateSphereUnion | FinishGateConvexMesh

/**
 * DEV-146 — **ambient traffic**: other ships flying ANOTHER mission's course
 * over the island you are on, while you fly this one.
 *
 * Matt's triage, 2026-09-16: *"Interleaved modes: see HoverJets fly while on a
 * JumpSeat course."* The AI racers already fly a route headless and a JumpSeat
 * course shares its environment with a HoverJet one, so the whole feature is a
 * pair of numbers on a level plus a loader that reads them (hard rule 6).
 *
 * ── Why it is on the LEVEL and not on the preset ──────────────────────────
 *
 * Which course the traffic flies is a property of the island and of what is
 * near it, and it differs per mission — `int_01_jumpSeat`'s targets sit a
 * median of 452 m from `int_01_hoverJet`'s racing line, while
 * `rookie_02_jumpSeat`'s sit a median of 853 m from its neighbour's and would
 * read as specks. That is not something one preset number can say. The preset
 * carries the SWITCH (`gameplay.ambientTraffic`) and the frame budget; the
 * level carries the pairing.
 *
 * ── How an authored field lives in a GENERATED file ───────────────────────
 *
 * `content/levels/*.json` is generated and hash-guarded, so this is not
 * hand-edited into the JSON — it is emitted by `DEV_146_AMBIENT_TRAFFIC` in
 * `tools/extract/level.mjs`, the same way `forcedModeFf2` (DEV-061),
 * `medalsFf2` (DEV-004) and `orbs[].posFf2` (DEV-067) are. Turning it on for
 * another mission is a row in that table and `pnpm extract:levels` followed by
 * `pnpm extract:manifest`; it survives `pnpm extract:check` because it IS what
 * the extractor emits.
 */
export interface AmbientTraffic {
  /**
   * The mission whose COURSE the traffic flies. Must exist and must share this
   * level's `environment` — otherwise the ships are over a different island and
   * nobody sees them. Asserted by the extractor and by
   * `tests/unit/ambient-traffic-content.test.ts`.
   */
  mission: string
  /** How many ships. `1..AMBIENT_TRAFFIC_MAX`, and the preset may lower it further. */
  count: number
  /** Provenance, as every FF2-authored level field carries. */
  _meta?: { deviation: string; note: string }
}

/**
 * The structural ceiling on {@link AmbientTraffic.count}.
 *
 * NOT the frame budget — that is `gameplay.ambientTraffic.maxCount` in the
 * preset, which is the dial a headset pass turns and which Anniversary sets to
 * 4. This number has one job: make `"count": 30` a loud failure at load rather
 * than thirty GLB loads and thirty trails on a Quest. It is deliberately well
 * above any value anyone would author, because a schema cap that is also a
 * tuning value is a cap nobody dares lower.
 */
export const AMBIENT_TRAFFIC_MAX = 8

// ═══════════════════════════ DEV-375: THE LESSON BLOCK ═══════════════════════
//
// The flight instructor's course, as DATA (`docs/plan/FLIGHT-INSTRUCTOR.md`
// §6). A lesson is the instructor's pacing, an ordered list of steps that each
// end on a TRIGGER, and interrupts that can hold any step and hand it back. A
// second course is a second JSON file: nothing in `src/` names a step, a ring or
// a mission, which is hard rule 6's allowance and the reason every vocabulary
// below is an exported constant rather than a string the runner happens to
// compare against.
//
// **The vocabularies are CLOSED, and the validator is what closes them.** An
// unknown trigger `kind`, a missing field, an extra field, a `passGate.ring`
// past the course or a `{token}` nobody resolves is a load error — because the
// alternative is a step whose condition can never come true, which a player
// meets as a lesson that stops teaching and never says why. The typo is caught
// where it was typed.
//
// The same shape is also a JSON Schema, `content/authored/_lesson.schema.json`,
// run over every authored file by `tests/unit/lesson-schema.test.ts` with the
// hand-rolled validator the level and edition schemas share. That test also
// holds the schema's trigger list equal to {@link LESSON_TRIGGERS}, so the two
// descriptions cannot drift apart.
//
// Numbers in this section: none is a tuning value. The instructor's pacing all
// arrives from content; what is here is the SHAPE — positive, non-negative, an
// index into the course — and one angle bound, a roll measured from level,
// which cannot exceed a half turn.

/**
 * The instructor: an `AiRacer` that leads and waits (plan §4). Every number is
 * the course's, like the glider's tuning, because it is Anniversary design and
 * not extracted 2016 data. DEV-376 reads it.
 */
export interface LessonInstructor {
  /** A key of `sim/ai-racer.ts`'s `AI_RACER_TUNINGS`: the controller's gains. Checked where the racer is built, as `game/racers.ts` checks an edition's. */
  readonly tuning: string
  /** Its livery, `#rrggbb` — clear of the player's orange and the racer palette. */
  readonly colour: string
  /** Where it waits along the racing line, metres from its start. */
  readonly startArcMetres: number
  /** The gap it holds ahead of the player, along the line. */
  readonly leadMetres: number
  /** Metres per second of target speed per metre of gap error. */
  readonly gain: number
  /** Further behind than this and it HOLDS. Must exceed {@link resumeWithinMetres}. */
  readonly waitBeyondMetres: number
  /** Closer than this and it goes again. */
  readonly resumeWithinMetres: number
  /** How far off the line it hovers while holding, so it is never a wall in a ring. */
  readonly holdAsideMetres: number
  /** The default speed cap, m/s; a step may override it. */
  readonly maxSpeed: number
  readonly boost: boolean
}

/** How the instructor paces a step: lead and wait for you, or race you home. */
export const LESSON_PACES = ['lead', 'race'] as const
export type LessonPace = (typeof LESSON_PACES)[number]

/** A step's overrides of the instructor's defaults. Every key optional; no other key allowed. */
export interface LessonStepInstructor {
  readonly maxSpeed?: number
  readonly boost?: boolean
  readonly leadMetres?: number
  /** `'race'` switches the pacing off and flies the tuning flat out (plan §4.1 item 4). */
  readonly pace?: LessonPace
}

/** What an `input` trigger can watch being held. */
export const LESSON_INPUT_ACTIONS = ['throttle', 'boost', 'brake', 'airbrake'] as const
export type LessonInputAction = (typeof LESSON_INPUT_ACTIONS)[number]

/**
 * When a step ends, or an interrupt fires — plan §6.2's table, one member per
 * row. `ring` is a 0-based index into the course's live rings (`liveRings`,
 * the course `game/mission.ts` builds); `{nextRing}` is the 1-based one a
 * player reads.
 */
export type LessonTrigger =
  /** The launch phase has left `waiting`. */
  | { readonly kind: 'launched' }
  /** Airspeed held at or above `mps` for `forSeconds`. */
  | { readonly kind: 'speedAtLeast'; readonly mps: number; readonly forSeconds: number }
  /** Airspeed held at or below `mps` for `forSeconds`. */
  | { readonly kind: 'speedAtMost'; readonly mps: number; readonly forSeconds: number }
  /** `course.passed[ring]`; with `clean`, a CLEAN gate event where the preset has them. */
  | { readonly kind: 'passGate'; readonly ring: number; readonly clean?: boolean }
  /** The wings are rolled at least `degrees` from level. */
  | { readonly kind: 'bankAtLeast'; readonly degrees: number }
  /** Within `degrees` of level for `seconds`. */
  | { readonly kind: 'levelFor'; readonly degrees: number; readonly seconds: number }
  /** An action held for `forSeconds`. */
  | { readonly kind: 'input'; readonly action: LessonInputAction; readonly forSeconds: number }
  /** Cross-track distance to the racing line at most `metres`. */
  | { readonly kind: 'onLineWithin'; readonly metres: number }
  /** Cross-track distance to the racing line beyond `metres`. */
  | { readonly kind: 'offLineBeyond'; readonly metres: number }
  /** The nose is more than `degrees` ABOVE the horizon (DEV-892). */
  | { readonly kind: 'noseAbove'; readonly degrees: number }
  /** The nose is at most `degrees` above the horizon, or below it (DEV-892). */
  | { readonly kind: 'noseBelow'; readonly degrees: number }
  /** The finish gate crossed. */
  | { readonly kind: 'finish' }
  /** The step has been up `n` seconds — a step that only reads. */
  | { readonly kind: 'seconds'; readonly n: number }
  /** Each in turn. Its members may not be interrupt-only kinds. */
  | { readonly kind: 'sequence'; readonly of: readonly LessonTrigger[] }
  /** INTERRUPTS ONLY: the crash rule fired (Anniversary, DEV-126). */
  | { readonly kind: 'crash' }
  /** INTERRUPTS ONLY: a contact took `mps` off you (Classic's bounce, `Flash()`). */
  | { readonly kind: 'contact'; readonly mps: number }

export type LessonTriggerKind = LessonTrigger['kind']

/**
 * How one trigger field is checked.
 *
 * - `positive`    finite and above zero — a speed, a distance, a duration
 * - `nonNegative` finite and zero or more — a hold of 0 s is "the moment it is true"
 * - `angle`       finite, above zero, at most a half turn from level
 * - `ring`        an integer index into the course's live rings
 * - `boolean`
 * - `inputAction` one of {@link LESSON_INPUT_ACTIONS}
 * - `triggers`    a non-empty list of triggers, none interrupt-only
 */
export type LessonFieldRule =
  | 'positive'
  | 'nonNegative'
  | 'angle'
  | 'ring'
  | 'boolean'
  | 'inputAction'
  | 'triggers'

type TriggerOf<K extends LessonTriggerKind> = Extract<LessonTrigger, { kind: K }>
type TriggerField<K extends LessonTriggerKind> = Exclude<keyof TriggerOf<K>, 'kind'>

/**
 * One field's rule, and whether it may be left out. `optional` is typed off the
 * union above, so the compiler refuses a table row that disagrees with the type
 * about which fields are required.
 */
interface LessonFieldSpec<K extends LessonTriggerKind, F extends TriggerField<K>> {
  readonly rule: LessonFieldRule
  readonly optional: Record<never, never> extends Pick<TriggerOf<K>, F> ? true : false
}

export interface LessonTriggerSpec<K extends LessonTriggerKind> {
  readonly fields: { readonly [F in TriggerField<K>]: LessonFieldSpec<K, F> }
  /** True for `crash` and `contact`: an interrupt's `on`, never a step's `until`. */
  readonly interruptOnly: boolean
}

/**
 * THE trigger vocabulary. The validator walks this and nothing else, and its
 * type is a mapped type over {@link LessonTrigger}, so a kind added to the
 * union without a row here — or a row whose fields differ from the union's —
 * does not compile. DEV-377's runner implements one case per key.
 */
export const LESSON_TRIGGERS: { readonly [K in LessonTriggerKind]: LessonTriggerSpec<K> } = {
  launched: { fields: {}, interruptOnly: false },
  speedAtLeast: {
    fields: {
      mps: { rule: 'positive', optional: false },
      forSeconds: { rule: 'nonNegative', optional: false },
    },
    interruptOnly: false,
  },
  speedAtMost: {
    fields: {
      mps: { rule: 'positive', optional: false },
      forSeconds: { rule: 'nonNegative', optional: false },
    },
    interruptOnly: false,
  },
  passGate: {
    fields: { ring: { rule: 'ring', optional: false }, clean: { rule: 'boolean', optional: true } },
    interruptOnly: false,
  },
  bankAtLeast: { fields: { degrees: { rule: 'angle', optional: false } }, interruptOnly: false },
  levelFor: {
    fields: {
      degrees: { rule: 'angle', optional: false },
      seconds: { rule: 'positive', optional: false },
    },
    interruptOnly: false,
  },
  input: {
    fields: {
      action: { rule: 'inputAction', optional: false },
      forSeconds: { rule: 'nonNegative', optional: false },
    },
    interruptOnly: false,
  },
  onLineWithin: { fields: { metres: { rule: 'positive', optional: false } }, interruptOnly: false },
  offLineBeyond: {
    fields: { metres: { rule: 'positive', optional: false } },
    interruptOnly: false,
  },
  noseAbove: { fields: { degrees: { rule: 'angle', optional: false } }, interruptOnly: false },
  noseBelow: { fields: { degrees: { rule: 'angle', optional: false } }, interruptOnly: false },
  finish: { fields: {}, interruptOnly: false },
  seconds: { fields: { n: { rule: 'positive', optional: false } }, interruptOnly: false },
  sequence: { fields: { of: { rule: 'triggers', optional: false } }, interruptOnly: false },
  crash: { fields: {}, interruptOnly: true },
  contact: { fields: { mps: { rule: 'positive', optional: false } }, interruptOnly: true },
}

/**
 * The words a prompt may put in braces. The first eight become the device's own
 * control name (`right trigger`, `R2`, `Space`…) through DEV-377's resolver,
 * which reads `render/controls-menu.ts`'s rows so the plate and the Controls
 * page cannot disagree; `{pitchUp}`/`{pitchDown}` follow `invertPitch` (D16).
 * `{nextRing}` is 1-based and `{speed}` is the live airspeed.
 *
 * `{target}` is the speed the prompt's OWN `until` asks for — see
 * {@link lessonSpeedTarget} — printed as the dash prints `{speed}` (DEV-378).
 * A lesson file is shared by both editions and the dash's unit is the
 * preset's (`hud.speedUnit`: km/h on Anniversary, a bare m/s on Classic), so a
 * number typed into a prompt is wrong in one of them; and a number typed
 * beside a threshold can drift from it. The validator refuses `{target}` in a
 * prompt whose `until` asks for no speed.
 */
export const LESSON_CONTROL_TOKENS = [
  'launch',
  'throttle',
  'boost',
  'slow',
  'fly',
  'roll',
  'pitchUp',
  'pitchDown',
] as const
export const LESSON_VALUE_TOKENS = ['nextRing', 'speed', 'target'] as const
export const LESSON_TOKENS: readonly string[] = [...LESSON_CONTROL_TOKENS, ...LESSON_VALUE_TOKENS]

/**
 * The speed a prompt's `{target}` prints, m/s: its trigger's own threshold.
 * A `speedAtLeast` or `speedAtMost` is its `mps`; a `sequence` is its first
 * member that has one; anything else asks for no speed and is null.
 *
 * Read off the trigger rather than typed beside it, so the plate and the rule
 * that ends the step cannot disagree about the number.
 */
export const lessonSpeedTarget = (t: LessonTrigger): number | null => {
  if (t.kind === 'speedAtLeast' || t.kind === 'speedAtMost') return t.mps
  if (t.kind === 'sequence') {
    for (const member of t.of) {
      const v = lessonSpeedTarget(member)
      if (v !== null) return v
    }
  }
  return null
}

/**
 * What a step holds the STUDENT to (DEV-790). Absent, the student flies as fast
 * as the stick takes the ship. `maxSpeed` is a ceiling in m/s: the lesson cuts
 * the throttle and the boost while the ship is at or past it, so a student
 * holding full throttle settles there instead of at the jet's terminal speed.
 */
export interface LessonStepStudent {
  readonly maxSpeed: number
}

export interface LessonStep {
  /** Unique across the lesson's steps AND interrupts. */
  readonly id: string
  /** The plate's heading. May carry `{tokens}`. */
  readonly title: string
  /** The plate's body: the prompt, which in a lesson IS the task. */
  readonly say: string
  /** Never an interrupt-only kind. */
  readonly until: LessonTrigger
  readonly instructor?: LessonStepInstructor
  /** DEV-790: a speed ceiling on the student for this step. */
  readonly student?: LessonStepStudent
}

export interface LessonInterrupt {
  /** Unique across the lesson's steps AND interrupts. */
  readonly id: string
  /** Any kind, including the interrupt-only two. */
  readonly on: LessonTrigger
  readonly say: string
  /** Never an interrupt-only kind. */
  readonly until: LessonTrigger
}

export interface Lesson {
  readonly instructor: LessonInstructor
  /** In order; at least one. */
  readonly steps: readonly LessonStep[]
  /** May be empty; must be present, so an author says so. */
  readonly interrupts: readonly LessonInterrupt[]
  readonly _meta?: { readonly deviation: string; readonly note: string }
}

/** Every key {@link LessonInstructor} requires, and every one it allows. */
export const LESSON_INSTRUCTOR_KEYS: readonly (keyof LessonInstructor)[] = [
  'tuning',
  'colour',
  'startArcMetres',
  'leadMetres',
  'gain',
  'waitBeyondMetres',
  'resumeWithinMetres',
  'holdAsideMetres',
  'maxSpeed',
  'boost',
]

/** Every key a step's {@link LessonStepInstructor} may carry. */
export const LESSON_STEP_INSTRUCTOR_KEYS: readonly (keyof LessonStepInstructor)[] = [
  'maxSpeed',
  'boost',
  'leadMetres',
  'pace',
]

const LESSON_KEYS: readonly string[] = ['instructor', 'steps', 'interrupts', '_meta']
const LESSON_STEP_KEYS: readonly string[] = ['id', 'title', 'say', 'until', 'instructor', 'student']

/** Every key a step's {@link LessonStepStudent} may carry (DEV-790). */
export const LESSON_STEP_STUDENT_KEYS: readonly (keyof LessonStepStudent)[] = ['maxSpeed']
const LESSON_INTERRUPT_KEYS: readonly string[] = ['id', 'on', 'say', 'until']

/** A roll measured from level is at most a half turn. The `angle` rule's bound. */
const HALF_TURN_DEGREES = 180

export interface Level {
  id: string
  title: string
  vehicle: VehicleId
  environment: string
  environmentScene: string
  /**
   * Which of 2016's three ranks this course is filed under — the middle step of
   * the level select.
   *
   * Extracted, not derived here: ten of the thirteen are read off the
   * `missionSel_<ship>_<rank>` page their holotable stands on in
   * `setGameplayOptions.unity`, and the other three fall back to the mission
   * id because this backup has no table for them. {@link Level.difficultySource}
   * says which, per mission, so a reader can tell a reading from a fallback.
   */
  difficulty: Difficulty
  /** `'menu'` — read off a 2016 rank page. `'id'` — inferred from the mission id. */
  difficultySource: 'menu' | 'id'
  /**
   * Where this course sits in 2016's campaign chain — 0 to 11 — or `null` for a
   * course that is not in it.
   *
   * `Scripts/Button_Next.cs` is the only sequencer in the game (`_ui-flow.md`
   * §3): twelve `case` labels, one chain, ending in `credits`.
   * `hoverJet_kauai_beg` is the one `null`, because it shipped after the backup
   * this port reads and never joined the chain.
   *
   * The level select's LAST step orders its tables by this, so 2016's own
   * running order is what a player reads down the arc. It is deliberately
   * nullable rather than defaulted: a course outside the chain sorting to the
   * end is the correct place for it, and `chainIndex ?? Infinity` says so where
   * `chainIndex ?? 0` would put the bonus course first.
   */
  chainIndex: number | null
  /**
   * The mode a run boots in when nothing asks for one.
   *
   * DERIVED by the extractor: the vehicle's default — HoverJet Ring Attack,
   * JumpSeat Target Practice — unless a forcing FF2 honours overrides it. Never
   * the 2016 record of a forcing; that is `forcedMode`.
   */
  mode: GameMode
  /**
   * 2016's `Level.ForceGameMode`/`ForcedGameMode`, untouched. **The record, not
   * the rule** — `runningMode` reads {@link Level.forcedModeFf2} first.
   */
  forcedMode: GameMode | null
  /**
   * DEV-061. Use `runningMode`; this is not something to read directly.
   *
   * Null on twelve of thirteen missions, meaning 2016's `forcedMode` stands.
   * See {@link ForcedModeFf2}.
   */
  forcedModeFf2: ForcedModeFf2 | null
  worldOffset: Vec3Tuple
  spawn: SpawnPoint
  respawn: SpawnPoint
  routes: Route[]
  /**
   * What ends a run. Every shipped mission has exactly one — the seven HoverJet
   * ones a sphere union, the six JumpSeat ones a convex mesh inside a jump pad.
   * Nullable only for a hand-authored or generated course that has none yet.
   */
  finish: FinishGate | null
  orbs: Orb[]
  /** JumpSeat landing targets, with their trigger volumes. Empty on a HoverJet mission. */
  pads: Pad[]
  /** Cyan turn chevrons. Empty on every JumpSeat mission. */
  turnIndicators: TurnIndicator[]
  /** Background clouds. Placements only — the geometry is generated. */
  clouds: CloudPlacement[]
  /**
   * Scenery THIS MISSION places itself — DEV-218, and DEV-219 for the palms.
   *
   * Empty on ten of the thirteen. The three that are not are `adv_01_jumpSeat`
   * (1 live spire), `int_01_jumpSeat` (11 live palms) and `rookie_02_jumpSeat`
   * (12 live of 16 authored). They are placed as Unity 5 stripped prefab
   * instances, so a name grep over the scene finds nothing and the extractor's
   * ordinary `expandPrefabs: false` read cannot see them at all — DEV-045's
   * trap, for the fourth time in this port.
   *
   * Same shape and same frame as a {@link PropLandmark}: `position` is composed
   * to the mission's `levelOffset`, which is where the environment's LevelArt
   * root sits (verified at 0.000 m against desert.json's own landmarks). So
   * `load-props.ts` concatenates these with `env.landmarks` and draws them
   * through one path — adding a mission's props needs no code (rule 6).
   */
  props: MissionProp[]
  /** 2016's own UI strings, read from this mission's ship prefab. */
  ui: LevelUi
  timer: Timer
  medals: Medals
  /** Use THIS to award a medal; `medals` is the 2016 record. See {@link MedalsFf2}. */
  medalsFf2: MedalsFf2 | null
  scoring: Scoring
  boundary: Boundary
  fog: Fog
  lighting: Lighting
  ghosts: GhostRef[]
  /**
   * DEV-146. Null on every mission the extractor's table does not name, which
   * is twelve of thirteen. See {@link AmbientTraffic}.
   */
  ambientTraffic: AmbientTraffic | null
  /** Null for extracted 2016 courses; set for procedural ones. Same loader either way. */
  generated: Generated | null
  /**
   * DEV-466. The racing line: the polyline the course was built around, THREE
   * space, in flying order. 2016's is `CurvyClonePath`'s approximation (the
   * Curvy spline the rings were cloned along, ~16–27 m between points) and it
   * runs on PAST the finish gate; a player course's is its own spline, sampled
   * (`content/player-course.ts`). The AI racers fly it, and so do the guide,
   * the traffic and the lap server's course arc.
   *
   * Null on the six JumpSeat missions, which have no path, and absent on a
   * hand-authored file that has none. It was in the JSON for months before it
   * was on this type: six call sites cast `(level as { route? }).route`.
   */
  route?: Vec3Tuple[] | null
  /**
   * DEV-375. Is this course on the menus — the hangar's tables, and every pool
   * built from the index (Quick Race's, and Learn to Fly's)?
   *
   * **Authored files only**, and absent means NO: `content/authored/` holds perf
   * fixtures as well as courses (the two `dev230_*` crossings), so "every
   * authored file" is the wrong switch and an author opts a course in. The
   * generated tree is the shipped thirteen and is always listed; `loadLevel`
   * refuses the field there, because a hand edit to a generated file is the
   * thing `pnpm extract:check` exists to stop. See `load-level.ts`'s `levelIds`.
   */
  listed?: boolean
  /**
   * DEV-375. The instructor's course — required exactly where the level's
   * running mode teaches, refused everywhere else (`game/modes.ts`'s
   * `validateModeContent`). Absent on everything the extractor writes. See
   * {@link Lesson}.
   */
  lesson?: Lesson | null
  /**
   * DEV-145 / ANNIVERSARY. The counterpart to a generated level's `_meta`:
   * where a hand-authored course's numbers came from, and which of its blocks
   * were copied out of a generated one.
   *
   * Absent on everything under `content/levels/`. Typed loosely on purpose —
   * it is a note to a reader and to `tests/unit/glider-mission.test.ts`, not a
   * contract the game reads.
   */
  _authored?: {
    by: string
    kind: string
    note: string
    geometry?: Record<string, unknown>
    copiedFrom?: { level: string; fields: string[]; why: string }
    speedChain?: string
  }
  /**
   * DEV-538. Set by `applyOverride` (`content/level-override.ts`) on a shipped
   * mission loaded through `content/overrides/<id>.json`: the sha256 of the
   * generated file the override was made against, and its notes. Absent on
   * every file on disk — `loadLevel` refuses it there — and on a mission with
   * no override. A note to a reader, like `_authored`; nothing plays by it.
   */
  _override?: { base: string; notes: readonly { at: string; what: string }[] }
  /**
   * DEV-538, plan/SHIPPED-COURSE-EDITS §6.2. Eight hex digits naming the
   * course a best is judged on, present ONLY when an override changed that
   * course from 2016's. `game/personal-best.ts` puts it in the key, so an
   * edited course starts fresh bests (Matt's call 3) and an unedited one keeps
   * today's key byte for byte. Refused on a file on disk, like `_override`.
   */
  courseKey?: string
}

export class LevelSchemaError extends Error {
  constructor(levelId: string, problem: string) {
    super(`level "${levelId}": ${problem}`)
    this.name = 'LevelSchemaError'
  }
}

/** Every ring on every route. The extractor has already filtered out dead ones. */
export const allRings = (level: Level): Ring[] => level.routes.flatMap((r) => r.rings)

/**
 * Rings that actually score. `addScore` is a MULTIPLIER (1), not a point value
 * — the points come from `scoring.gateMultiplier` (100). `TriggerCheckpoint`'s
 * `speedBoost` / `boostForce` do not exist at all; no shipped ring gives an
 * impulse boost.
 */
export const liveRings = (level: Level): Ring[] =>
  allRings(level).filter((r) => r.scoring.addScore !== 0)

/** The maximum score a perfect run can reach from rings alone, before time bonus. */
export const maxRingScore = (level: Level): number =>
  liveRings(level).reduce((sum, r) => sum + r.scoring.addScore * level.scoring.gateMultiplier, 0)

/**
 * Medal coherence. `platinum === maxRingScore` for five of the seven HoverJet
 * missions. Where it does not, a row in `docs/DEVIATIONS.md` must say so out
 * loud — `rookie_01_hoverJet` ships 16 rings against a platinum of 1700, which
 * makes platinum mathematically unreachable, and FF2 fixes that one (Matt's
 * decision, 2026-09-09: arithmetic bug, not character).
 */
export const platinumIsReachable = (level: Level): boolean =>
  level.medals.platinum <= maxRingScore(level)

/**
 * Every `{…}` in `text` must be a known token, and no brace may stand alone —
 * an unclosed `{throttle` would reach the plate verbatim.
 */
const unknownTokens = (text: string): string[] => {
  const bad: string[] = []
  const rest = text.replace(/\{([^{}]*)\}/g, (whole, name: string) => {
    if (!LESSON_TOKENS.includes(name)) bad.push(whole)
    return ''
  })
  if (/[{}]/.test(rest)) bad.push('an unmatched brace')
  return bad
}

/**
 * Throws on a malformed lesson block. Called by {@link validateLevel} when the
 * level carries one; whether it SHOULD carry one is the running mode's
 * question, answered in `game/modes.ts` (`validateModeContent`).
 */
const validateLesson = (level: Level, lesson: unknown): void => {
  const bad = (at: string, problem: string): LevelSchemaError =>
    new LevelSchemaError(level.id, `lesson${at}: ${problem}`)
  const onlyKeys = (at: string, obj: Record<string, unknown>, allowed: readonly string[]): void => {
    const extra = Object.keys(obj).filter((k) => !allowed.includes(k))
    if (extra.length > 0) throw bad(at, `unknown key(s) ${extra.join(', ')}`)
  }
  const text = (at: string, v: unknown): void => {
    if (typeof v !== 'string' || v.trim().length === 0) throw bad(at, 'must be a non-empty string')
    const unknown = unknownTokens(v)
    if (unknown.length > 0) {
      throw bad(at, `unknown token(s) ${unknown.join(', ')}; known: {${LESSON_TOKENS.join('} {')}}`)
    }
  }
  const rings = liveRings(level).length

  const field = (at: string, rule: LessonFieldRule, v: unknown): void => {
    switch (rule) {
      case 'positive':
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
          throw bad(at, 'must be a finite number above zero')
        }
        return
      case 'nonNegative':
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          throw bad(at, 'must be a finite number, zero or more')
        }
        return
      case 'angle':
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > HALF_TURN_DEGREES) {
          throw bad(at, `must be degrees above zero and at most ${HALF_TURN_DEGREES}`)
        }
        return
      case 'ring':
        if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= rings) {
          throw bad(
            at,
            `ring ${JSON.stringify(v)} is not on this course; it has ${rings} live ring(s), ` +
              'numbered from 0',
          )
        }
        return
      case 'boolean':
        if (typeof v !== 'boolean') throw bad(at, 'must be true or false')
        return
      case 'inputAction':
        if (!(LESSON_INPUT_ACTIONS as readonly unknown[]).includes(v)) {
          throw bad(at, `must be one of ${LESSON_INPUT_ACTIONS.join(' | ')}`)
        }
        return
      case 'triggers':
        if (!Array.isArray(v) || v.length === 0)
          throw bad(at, 'must be a non-empty list of triggers')
        for (const [i, t] of (v as unknown[]).entries()) trigger(`${at}[${i}]`, t, false)
        return
    }
  }

  const trigger = (at: string, t: unknown, interrupt: boolean): void => {
    if (!isRecord(t)) throw bad(at, 'must be a trigger object with a kind')
    const kind = t.kind
    if (typeof kind !== 'string' || !Object.hasOwn(LESSON_TRIGGERS, kind)) {
      throw bad(
        at,
        `unknown trigger kind ${JSON.stringify(kind)}; known: ` +
          Object.keys(LESSON_TRIGGERS).join(', '),
      )
    }
    const spec = LESSON_TRIGGERS[kind as LessonTriggerKind]
    if (spec.interruptOnly && !interrupt) {
      throw bad(at, `"${kind}" can only start an interrupt (its "on"), never end a step`)
    }
    const fields = spec.fields as Readonly<
      Record<string, { rule: LessonFieldRule; optional: boolean }>
    >
    onlyKeys(at, t, ['kind', ...Object.keys(fields)])
    for (const [name, f] of Object.entries(fields)) {
      if (!(name in t)) {
        if (!f.optional) throw bad(`${at}.${name}`, `missing — "${kind}" requires it`)
        continue
      }
      field(`${at}.${name}`, f.rule, t[name])
    }
  }

  if (!isRecord(lesson)) throw bad('', 'must be an object')
  onlyKeys('', lesson, LESSON_KEYS)

  // ── The instructor ──────────────────────────────────────────────────────
  const inst = lesson.instructor
  if (!isRecord(inst)) throw bad('.instructor', 'missing')
  onlyKeys('.instructor', inst, LESSON_INSTRUCTOR_KEYS)
  for (const key of LESSON_INSTRUCTOR_KEYS) {
    if (!(key in inst)) throw bad(`.instructor.${key}`, 'missing — there is no default')
  }
  if (typeof inst.tuning !== 'string' || inst.tuning.length === 0) {
    throw bad('.instructor.tuning', 'must name a tuning')
  }
  if (typeof inst.colour !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(inst.colour)) {
    throw bad('.instructor.colour', 'must be #rrggbb')
  }
  field('.instructor.startArcMetres', 'nonNegative', inst.startArcMetres)
  field('.instructor.leadMetres', 'nonNegative', inst.leadMetres)
  field('.instructor.gain', 'positive', inst.gain)
  field('.instructor.waitBeyondMetres', 'positive', inst.waitBeyondMetres)
  field('.instructor.resumeWithinMetres', 'positive', inst.resumeWithinMetres)
  field('.instructor.holdAsideMetres', 'nonNegative', inst.holdAsideMetres)
  field('.instructor.maxSpeed', 'positive', inst.maxSpeed)
  field('.instructor.boost', 'boolean', inst.boost)
  // A resume radius at or past the wait radius is a HOLD that is left the tick
  // it is entered: the instructor would stutter on the spot.
  if ((inst.resumeWithinMetres as number) >= (inst.waitBeyondMetres as number)) {
    throw bad(
      '.instructor',
      `resumeWithinMetres (${inst.resumeWithinMetres}) must be less than waitBeyondMetres ` +
        `(${inst.waitBeyondMetres})`,
    )
  }

  // ── Steps and interrupts ────────────────────────────────────────────────
  // `{target}` prints the speed the prompt's own `until` asks for (DEV-378);
  // one whose `until` asks for none would print nothing a player could use.
  const target = (at: string, prompts: readonly unknown[], until: unknown): void => {
    if (!prompts.some((p) => typeof p === 'string' && p.includes('{target}'))) return
    if (lessonSpeedTarget(until as LessonTrigger) === null) {
      throw bad(
        at,
        `{target} prints the speed this prompt's "until" asks for, and it asks for none`,
      )
    }
  }
  const ids = new Set<string>()
  const id = (at: string, v: unknown): void => {
    if (typeof v !== 'string' || v.length === 0) throw bad(`${at}.id`, 'must be a non-empty string')
    if (ids.has(v as string))
      throw bad(`${at}.id`, `"${v}" is used twice; ids are unique across steps and interrupts`)
    ids.add(v as string)
  }

  if (!Array.isArray(lesson.steps) || lesson.steps.length === 0) {
    throw bad('.steps', 'must be a non-empty list')
  }
  for (const [i, step] of lesson.steps.entries()) {
    const at = `.steps[${i}]`
    if (!isRecord(step)) throw bad(at, 'must be an object')
    onlyKeys(at, step, LESSON_STEP_KEYS)
    id(at, step.id)
    text(`${at}.title`, step.title)
    text(`${at}.say`, step.say)
    trigger(`${at}.until`, step.until, false)
    target(at, [step.title, step.say], step.until)
    const over = step.instructor
    if (over !== undefined) {
      if (!isRecord(over)) throw bad(`${at}.instructor`, 'must be an object')
      onlyKeys(`${at}.instructor`, over, LESSON_STEP_INSTRUCTOR_KEYS)
      if ('maxSpeed' in over) field(`${at}.instructor.maxSpeed`, 'positive', over.maxSpeed)
      if ('boost' in over) field(`${at}.instructor.boost`, 'boolean', over.boost)
      if ('leadMetres' in over) field(`${at}.instructor.leadMetres`, 'nonNegative', over.leadMetres)
      if ('pace' in over && !(LESSON_PACES as readonly unknown[]).includes(over.pace)) {
        throw bad(`${at}.instructor.pace`, `must be one of ${LESSON_PACES.join(' | ')}`)
      }
    }
    // DEV-790: the student's own ceiling for the step.
    const cap = step.student
    if (cap !== undefined) {
      if (!isRecord(cap)) throw bad(`${at}.student`, 'must be an object')
      onlyKeys(`${at}.student`, cap, LESSON_STEP_STUDENT_KEYS)
      if (!('maxSpeed' in cap)) throw bad(`${at}.student.maxSpeed`, 'missing')
      field(`${at}.student.maxSpeed`, 'positive', cap.maxSpeed)
    }
  }

  if (!Array.isArray(lesson.interrupts)) {
    throw bad('.interrupts', 'must be a list (empty is fine; absent is not)')
  }
  for (const [i, int] of lesson.interrupts.entries()) {
    const at = `.interrupts[${i}]`
    if (!isRecord(int)) throw bad(at, 'must be an object')
    onlyKeys(at, int, LESSON_INTERRUPT_KEYS)
    id(at, int.id)
    trigger(`${at}.on`, int.on, true)
    text(`${at}.say`, int.say)
    trigger(`${at}.until`, int.until, false)
    target(at, [int.say], int.until)
  }
}

/** Throws on anything a level cannot silently get away with. */
export const validateLevel = (level: Level): Level => {
  if (!level.id) throw new LevelSchemaError('<unnamed>', 'missing id')
  if (!level.boundary || typeof level.boundary.enabled !== 'boolean') {
    throw new LevelSchemaError(level.id, 'missing boundary.enabled — there is no global default')
  }
  if (typeof level.boundary.resetDelay !== 'number') {
    throw new LevelSchemaError(level.id, 'missing boundary.resetDelay — there is no global default')
  }
  if (!level.fog || typeof level.fog.height !== 'number') {
    throw new LevelSchemaError(level.id, 'missing fog.height')
  }
  if (!level.lighting?.sun) {
    throw new LevelSchemaError(level.id, 'missing lighting.sun')
  }
  // A second live directional light doubles the sun. The environment scene is
  // where one would come from — the LevelArt prefab has a light, disabled, that
  // a careless re-enable would resurrect.
  if (level.lighting.environmentSceneLiveLights !== 0) {
    throw new LevelSchemaError(
      level.id,
      `the environment scene contributes ${level.lighting.environmentSceneLiveLights} live ` +
        'light(s); the shipped build has exactly one, from the mission scene',
    )
  }
  // The level select's middle step has no fallback: a course with no rank is a
  // course with no table, and a menu that silently drops a mission is the exact
  // failure `mission-index.ts`'s display-name table is written to avoid.
  if (!DIFFICULTY_ORDER.includes(level.difficulty)) {
    throw new LevelSchemaError(
      level.id,
      `difficulty is ${JSON.stringify(level.difficulty)}; expected one of ` +
        `${DIFFICULTY_ORDER.join(' | ')} — there is no global default`,
    )
  }
  if (!Array.isArray(level.routes)) throw new LevelSchemaError(level.id, 'missing routes[]')
  if (typeof level.scoring?.gateMultiplier !== 'number') {
    throw new LevelSchemaError(level.id, 'missing scoring.gateMultiplier')
  }
  // DEV-399. A flight model is the AIRCRAFT's, not the course's. DEV-145 put
  // the glider's tuning on its one course as `flightModel` and said it should
  // move to a shared vehicle file before a second course copied it; G1 moved
  // it to `content/aircraft/glider.json`, and a course says `vehicle: glider`.
  // Refused rather than ignored: a block nothing reads would look like the
  // place to retune the glider, and retuning it there would change nothing.
  if ((level as { flightModel?: unknown }).flightModel != null) {
    throw new LevelSchemaError(
      level.id,
      'flightModel moved to the aircraft (DEV-399): fly the glider with "vehicle": "glider", and tune it in content/aircraft/glider.json',
    )
  }

  // ── DEV-146: ambient traffic ────────────────────────────────────────────
  //
  // Nullable, so `undefined` is accepted as "none" and a level written before
  // this field existed still loads. What is NOT accepted is a half-filled one:
  // a missing `mission` is a `loadLevel(undefined)` at spawn time, and a count
  // of 0 or 30 is a number nobody meant. The donor mission's EXISTENCE cannot
  // be checked here — this validator sees one level — so it is checked by the
  // loader (`game/ambient-traffic.ts`, which is holding the level list) and by
  // `tests/unit/ambient-traffic-content.test.ts` over the whole tree.
  const traffic = level.ambientTraffic
  if (traffic !== null && traffic !== undefined) {
    if (typeof traffic.mission !== 'string' || traffic.mission.length === 0) {
      throw new LevelSchemaError(level.id, 'ambientTraffic.mission must be a non-empty level id')
    }
    if (traffic.mission === level.id) {
      throw new LevelSchemaError(
        level.id,
        'ambientTraffic.mission is this level — traffic flies ANOTHER course, or it is the race',
      )
    }
    if (!Number.isInteger(traffic.count) || traffic.count < 1) {
      throw new LevelSchemaError(level.id, 'ambientTraffic.count must be a positive integer')
    }
    if (traffic.count > AMBIENT_TRAFFIC_MAX) {
      throw new LevelSchemaError(
        level.id,
        `ambientTraffic.count is ${traffic.count}; the ceiling is ${AMBIENT_TRAFFIC_MAX}`,
      )
    }
  }

  // ── DEV-375: the menus, and the lesson ──────────────────────────────────
  if (level.listed !== undefined && typeof level.listed !== 'boolean') {
    throw new LevelSchemaError(level.id, 'listed must be true or false')
  }
  if (level.lesson !== null && level.lesson !== undefined) validateLesson(level, level.lesson)
  return level
}
