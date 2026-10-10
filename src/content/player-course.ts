// src/content/player-course.ts — the player-course format, v2. DEV-466, E0;
// v2 and its start pad, DEV-475.
//
// docs/plan/EDITOR.md §5.1: **a player course is a recipe, not a level.** It
// stores what the author made — a spline, a spacing, a start pad, a finish, a
// time limit and a sky — and `expandPlayerCourse` turns it into an ordinary `Level`
// against a DONOR: a shipped mission on the same island, which supplies every
// environmental fact (sun, fog, boundary, scoring, HUD strings, clouds) so no
// environment fact is ever retyped (hard rule 3). The rings, the finish, the
// spawn and the racing line all derive from the spline.
//
// ── What lives here, and what does not ───────────────────────────────────
//
//   PlayerCourse            the type, as EDITOR.md §5.1 shows it, `v: 1`
//   PLAYER_COURSE_LIMITS    every policy bound, under ONE name (the
//   PLAYER_COURSE_SHAPE     HUD_RASTER_SHIPPED pattern), pinned by value in
//                           tests/unit/player-course.test.ts
//   canonicalPlayerCourse   the one canonical JSON string
//   playerCourseId          `pc_` + a SHA-256 prefix of it
//   validatePlayerCourse    `unknown` in, errors with paths out; never throws
//   expandPlayerCourse      course + donor -> Level, pure and synchronous
//
// `loadPlayerCourse` — the async door that loads the donor — is in
// `load-player-course.ts`, NOT here, on purpose: `load-level.ts` uses
// `import.meta.glob`, and a Playwright spec that imports anything reaching it
// collects zero tests (`tests/unit/e2e-import-graph.test.ts`). DEV-467's e2e
// builds a course in code, so this module must stay importable from a spec.
//
// ── Untrusted input (EDITOR.md §5.8) ─────────────────────────────────────
//
// A course arrives from a link or a file somebody sent. Only this validator
// stands between that and a deterministic sim, so it is strict: every key is
// known (an unknown one is refused, not ignored), every number is finite and
// bounded, every array's LENGTH is checked before it is walked, and a message
// never echoes more than a few characters of what it was given. Terrain
// clearance is NOT checked here: it needs the loaded ground, and DEV-468 makes
// it a warning in the editor rather than a refusal.
//
// ── Coordinates ──────────────────────────────────────────────────────────
//
// `path.points` are in the LEVEL JSON's frame — THREE space, metres, the frame
// `Ring.pos` and `Level.route` are written in — so a point the editor places on
// the rendered terrain is stored as it is. So is the start pad's `pos`.
//
// ── v2: the start is a PAD (DEV-475) ─────────────────────────────────────
//
// Matt, 2026-09-27: *"have each custom level always have a starting
// point/launch area that players can re-position"*, and of the options, a
// draggable start PAD: *"the ship starts on it and lifts off, the racers on
// slots beside it. No underground shaft. It replaces the Start slider."*
//
// So v1's `start: { t }` (a place on the line) is v2's `start: { pos, yaw }`:
// the pad's FOOT, where its dish stands on the ground, and the heading the
// ship faces on it. The ground is the editor's to know (it seats the pad on
// what you can see); this file never sees a terrain, because the expansion is
// pure and synchronous and nothing it reads is async. So a pad is stored at
// the height the editor put it.
//
// The rings and the racing line no longer start at the start: they run from
// the line's FIRST POINT, one gap past it, whatever the pad does — so dragging
// the pad never moves a ring. The racing line begins at the ship on the pad and
// joins the line there.
//
// **A v1 course still reads.** `validatePlayerCourse` takes `v: 1` and returns
// the v2 course (`migrateV1`), so every link and file made before v2 keeps
// working. What that does to ids is in `legacyPlayerCourseId`'s comment.
//
// ── Extending v2 (DEV-476's `light`) ─────────────────────────────────────
//
// An OPTIONAL block is added in three places: `COURSE_KEYS` and
// `OPTIONAL_KEYS` (below), `parseCourse`, and `canonicalPlayerCourse`, which
// writes it ONLY when it is present — so a course without it keeps the bytes,
// and so the id, it had before the block existed. No version bump for that.
//
// ── `light` (DEV-476) ────────────────────────────────────────────────────
//
// The first such block: `{ sunAzimuth, sunElevation, tint, tintAmount }`, the
// sun's two angles and DEV-446's scene tint, saved in the course. Absent is
// the sky mission's own. The expansion overrides `lighting.sun` and nothing
// else (the sky, its SH and the ambient stay the donor's); the tint is not a
// level fact at all and never reaches the `Level` — the game reads it off the
// course it is flying (`boot/app.ts`, DEV-476). The arithmetic and the sky's
// clamp are `player-course-light.ts`.

import { TERRAIN } from '@/generated/constants.generated'
import { HANDLE_ADJECTIVES, HANDLE_NOUNS } from '@/net/handles'
import { IssueList, isRecord, shownValue } from '@/net/validate-kit'
import { conjugate, mul, normalizeQ, type Quat, quat, rotateVec3 } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'
import {
  ISLAND_SYNTH,
  ISLAND_SYNTH_VERSION,
  ISLAND_SYNTH_VERSIONS,
  type IslandShape,
  type IslandSynthVersion,
} from '@/sim/terrain/island-synth'
import {
  buildCourseSpline,
  type CourseSpline,
  resampleByArcLength,
  splinePointAt,
  splineTangentAt,
} from './course-spline'
import {
  type FinishGate,
  type FinishGateSphereUnion,
  type Level,
  liveRings,
  type Medals,
  maxRingScore,
  type QuatTuple,
  type Ring,
  type SpawnPoint,
  type Vec3Tuple,
} from './level-schema'
import { type PlayerCourseLight, playerCourseSun, quantiseLight } from './player-course-light'
import { type PlacedProp, type PropFrame, placedLandmark, propEntry } from './prop-library'
import { normaliseDegreesOnGrid, quantise } from './quantise'
import { sha256Hex } from './sha256'

export type { PlayerCourseLight } from './player-course-light'
/** DEV-504: one hand-placed prop (`prop-library.ts`). */
export type PlayerCourseProp = PlacedProp

// ── The type ──────────────────────────────────────────────────────────────

/**
 * The format version this build WRITES. It reads this and every version before
 * it, one migration per bump: v1 → v2 is `migrateV1` (DEV-475).
 */
export const PLAYER_COURSE_VERSION = 2

export type PlayerCourseVehicle = 'hoverjet'
export type PlayerCourseMode = 'ringAttack'

export interface PlayerCourseRingOverride {
  /** Path parameter (arc-length fraction) of the ring this names. */
  readonly t: number
  /** v1 has one override: leave this ring out. */
  readonly skip: true
}

/**
 * The start pad. DEV-475.
 *
 * `pos` is the pad's FOOT in THREE space: the bottom of 2016's dish
 * (`render/start-grid.ts`: a pad's node origin is the mesh's foot), which the
 * editor seats on the ground you can see. The ship is held over it at the
 * height 2016's lift holds a ship over its own dish (`startStandUp`).
 *
 * `yaw` is the ship's heading on the pad, degrees, 2016's spawn convention —
 * the nose is local −z turned by `(0, sin(yaw/2), 0, cos(yaw/2))` about +y — in
 * [−180, 180), to a tenth of a degree.
 */
export interface PlayerCourseStart {
  readonly pos: Vec3Tuple
  readonly yaw: number
}

/**
 * DEV-501: the line's first point is the PAD's, not the author's. Matt,
 * 2026-09-28: *"dead-center to the launch platform, at the max ring-distance
 * from the launch platform … as if i constrained the first point in a spline
 * to a control object."*
 *
 * The first point is DERIVED: the pad's pose times a local offset — `h` metres
 * over the pad's foot and one `gap` ahead along its heading (`anchorPoint`) —
 * and the curve leaves it along that heading (`playerCourseSpline`), so the
 * first ring stands there, square to the pad. The pad is the one source of
 * truth: `quantised` derives the point before a course is written, and the
 * reader derives it AGAIN and never reads the copy in the file, so a course
 * cannot say one thing in its pad and another in its first point (a file whose
 * pad was moved by hand carries its ring with it). The copy stays in `points`
 * so that a course has ONE shape in memory and on the wire: every reader of
 * `points` — the spline, the warnings, the bench, the desk — reads the same
 * array either way, and `validatePlayerCourse` is not asked to tell two
 * spellings apart.
 *
 * OPTIONAL, on the island.v pattern (DEV-499): absent is a free first point,
 * and a course without it has the bytes and the id it always had.
 */
export interface PlayerCourseAnchor {
  /** Metres from the pad's FOOT up to the first point (the first ring's centre). */
  readonly h: number
}

export interface PlayerCourse {
  readonly v: typeof PLAYER_COURSE_VERSION
  /**
   * An environment id (`simonet`, `kauai`, `alpine`, `desert`), and it must be
   * the donor's. EDITOR.md §5.4 reserves two object shapes for later tiers —
   * `{ seed, … }` (T1) and `{ map, … }` (T1.5). DEV-490 reads the map shape
   * into `ground` (below), with this name inside it as `colours`; the seed
   * shape is still REFUSED, so a course written by a later build says so.
   * **No version bump:** a course on a shipped island writes the bytes, and
   * has the id, it always had; an older build refuses an imported island by
   * the sentence E0 reserved for it.
   */
  readonly island: string
  /** The donor: a shipped mission id, on this island, flown by this vehicle. */
  readonly sky: string
  readonly vehicle: PlayerCourseVehicle
  readonly mode: PlayerCourseMode
  readonly path: {
    /** Control points, THREE space. The curve passes through every one. */
    readonly points: readonly Vec3Tuple[]
    /** Metres of path between rings. */
    readonly gap: number
    /**
     * DEV-501: present, `points[0]` is the pad's (`anchorPoint`): kept equal
     * to it in memory by `anchored`, derived by `quantised` before it is
     * written, and derived again (never read) by the validator.
     */
    readonly anchor?: PlayerCourseAnchor
  }
  /** Overrides by path parameter; sorted by `t` in the canonical form. */
  readonly rings: readonly PlayerCourseRingOverride[]
  /** The start pad (v2, DEV-475): the ship stands on it and lifts off from it. */
  readonly start: PlayerCourseStart
  /**
   * A path parameter, 0 .. 1 by ARC LENGTH along the whole curve: 0 is the
   * first control point, 1 the last. Rings run from one `gap` past the first
   * point, and the finish gate stands at `finish`.
   */
  readonly finish: { readonly t: number }
  /** Seconds. Also the time bonus's par, as on every shipped HoverJet mission. */
  readonly timeLimit: number
  /** Two words from `net/handles.ts`'s lists: an adjective and a noun (D30). */
  readonly name: readonly [string, string]
  /**
   * The sun and the tint (DEV-476, `player-course-light.ts`). OPTIONAL: absent
   * is the sky mission's own light, and a course without it has the bytes and
   * the id it had before the block existed.
   */
  readonly light?: PlayerCourseLight
  /**
   * DEV-500: a water level, on any base. OPTIONAL: absent is the base's own sea
   * (or none, on desert and alpine), and a course without it has the bytes and
   * the id it had before the block existed.
   */
  readonly water?: PlayerCourseWater
  /**
   * DEV-490: the course's OWN ground, when it has one; absent is `island`'s
   * shipped terrain. `island` stays the environment id either way (the one the
   * sky must be on, and whose colours, props and grain the ground wears), so
   * every reader of `island` keeps reading a name.
   *
   * **This is the in-memory spelling.** The canonical form — what a link, a
   * file and the id carry — writes it INSIDE `island`, as EDITOR.md §5.4
   * reserved: `island: { map, size, height, sea, colours: <island id> }`.
   * `validatePlayerCourse` reads both spellings and returns this one.
   */
  readonly ground?: PlayerCourseGround
  /**
   * DEV-504: props the author placed, each a library id (`prop-library.ts`)
   * and a quantised pivot, yaw and scale. OPTIONAL, on the `light` pattern:
   * absent — or empty, which is written as absent — keeps the bytes and the
   * id a course had before the block existed. They expand into `level.props`
   * and are drawn and collide as landmarks (DEV-218); no clearing removes one.
   */
  readonly props?: readonly PlayerCourseProp[]
}

/**
 * DEV-490 (T1.5): an island made from an imported heightmap. The map's bytes
 * are not in the course; they ride beside it in the `.ffcourse` file
 * (`player-course-wire.ts`), and `map` is their SHA-256, so a course cannot be
 * paired with the wrong map and its id covers the ground too.
 */
export interface PlayerCourseMapIsland {
  /** SHA-256 of the map FILE's bytes (`content/island-map.ts`'s `heightmapSha`), lower-case hex. */
  readonly map: string
  /** The side, metres: a whole number of the island's chunks (`islandChunkMetres`). */
  readonly size: number
  /** Metres from the WATERLINE to the map's white (`islandWaterline`). */
  readonly height: number
  /**
   * The map's grey, 0..1, that stands at the waterline: Matt's call 1 on
   * DEV-489 ("0 is the waterline"), made a number so any map reads right —
   * black a sea floor or black a beach. Below it the ground runs on under the
   * sea at the same scale, down to the island's floor.
   */
  readonly sea: number
}

/**
 * DEV-493 (T1): an island made from a seed and four sliders
 * (`sim/terrain/island-synth.ts`). Tiny, so it rides in a LINK: the ground is
 * made again from these numbers wherever the course is opened.
 */
export interface PlayerCourseSeedIsland {
  /**
   * DEV-499: the generator version (`ISLAND_SYNTH_VERSIONS`). ABSENT means 1,
   * the generator every seed course before DEV-499 was made with, and 1 is
   * never written: so those courses keep their bytes and their ids. A new
   * island names `ISLAND_SYNTH_VERSION`.
   */
  readonly v?: IslandSynthVersion
  /** A non-negative 31-bit integer (`ISLAND_SYNTH.seedMax`). */
  readonly seed: number
  /** Size and height as an imported map's; rugged and sea 0..1 (`IslandShape`). */
  readonly shape: IslandShape
}

/**
 * DEV-500: one flat water surface, the base's sea moved to `level` (or, on a
 * base with no sea, a sea brought in at it). `level` is metres above the
 * island's land floor: the MESH frame DEV-490's `island.height` and
 * `islandWaterline` are in, so it is checked against the sheet with no level
 * loaded. `game/terrain/course-water.ts` puts it in the world.
 */
export interface PlayerCourseWater {
  readonly level: number
}

/** A course's own ground: an imported map (DEV-490) or a seed (DEV-493). */
export type PlayerCourseGround = PlayerCourseMapIsland | PlayerCourseSeedIsland

/** DEV-499: the generator a seeded island names; absent is 1. */
export const seedVersion = (g: PlayerCourseSeedIsland): IslandSynthVersion => g.v ?? 1

/** Is `g` a seeded island? */
export const isSeedIsland = (
  g: PlayerCourseGround | undefined | null,
): g is PlayerCourseSeedIsland => !!g && typeof (g as PlayerCourseSeedIsland).seed === 'number'

/** The side and the summit of a course's own island, whichever kind it is. */
export const groundExtent = (g: PlayerCourseGround): { size: number; height: number } =>
  isSeedIsland(g)
    ? { size: g.shape.size, height: g.shape.height }
    : { size: g.size, height: g.height }

/**
 * One string per island a course can stand on: `''` for its shipped island's
 * own terrain, else the quantised numbers of its own. What the editor compares
 * to know whether the world built is the draft's, and what a `CustomGround`
 * built for a course carries as its `key`.
 */
export const groundKey = (g: PlayerCourseGround | undefined | null): string => {
  if (!g) return ''
  const q = quantiseGround(g)
  if (isSeedIsland(q)) {
    const h = q.shape
    // DEV-499: a v1 island keeps the key it always had.
    const v = seedVersion(q)
    return `seed:${q.seed}:${h.size}:${h.height}:${h.rugged}:${h.sea}${v === 1 ? '' : `:v${v}`}`
  }
  return `map:${q.map}:${q.size}:${q.height}:${q.sea}`
}

/** Is `g` an imported map? */
export const isMapIsland = (g: PlayerCourseGround | undefined | null): g is PlayerCourseMapIsland =>
  !!g && typeof (g as PlayerCourseMapIsland).map === 'string'

// ── Policy, in one place ──────────────────────────────────────────────────

/**
 * Every bound the validator enforces. Policy, not physics: each is a Matt call
 * (DEVIATIONS DEV-466), and the reason sits beside it. **Pinned by value** in
 * `tests/unit/player-course.test.ts`, so moving one is an edit made on purpose.
 */
export const PLAYER_COURSE_LIMITS = {
  /** Control points. Two is a straight line; 64 keeps a link near EDITOR.md §5.1's size estimate. */
  points: { min: 2, max: 64 },
  /**
   * Metres between neighbouring control points, after quantising. Below this a
   * segment is a kink, not a path, and the curve's direction there means little.
   */
  pointSpacingMetres: { min: 5 },
  /**
   * Metres between rings. The floor is above TWICE a shipped ring's trigger
   * radius (22.62 m on all seven HoverJet missions, asserted in the test) so no
   * two ring triggers overlap; 2016 itself spaced them 397–522 m, inside the
   * range with room either side.
   */
  gapMetres: { min: 60, max: 1000 },
  /** Seconds. 2016's HoverJet missions run 120 and 180. */
  timeLimitSeconds: { min: 30, max: 900 },
  /** Rings after expansion (before skips for `max`, after skips for `min`). 2016's most is 28. */
  rings: { min: 1, max: 100 },
  /**
   * A structural bound on any coordinate, metres, applied before the donor is
   * known: four times the largest island (kauai's 8,192 m land). It keeps
   * garbage out of the arithmetic; the donor's play area is the real bound.
   */
  coordinateMetres: 32_768,
  /**
   * Where the donor's boundary is DISABLED the play area is the island's
   * terrain extent, and this is how far above the terrain's top a point may
   * sit. 2016's boundary spheres reach 1,750–2,900 m above their centres.
   */
  airAboveTerrainMetres: 1000,
  /**
   * DEV-501: an anchored first point's height over the pad's foot. A
   * structural bound, as `airAboveTerrainMetres` is (and the same number): the
   * play-area check on the derived point is the real one.
   */
  anchorHeightMetres: { min: 0, max: 1000 },
  /**
   * DEV-504: hand-placed props. DEV-533 (Matt: *"128 for links. as much as
   * needed for save files."*): this is the COURSE's ceiling, the `.ffcourse`
   * file's, and it is set by what the props COST, not by how long they are.
   * The link has a lower one of its own (`PLAYER_COURSE_WIRE.linkMaxProps`).
   *
   * A placed prop is a landmark: instanced, but never culled and never
   * LOD'd, drawn in the shadow pass too, and solid through its mesh's hull
   * and triangles, which the flight builds for every prop at load and the
   * desk for every prop it has not seen. The heaviest library kinds measure
   * 2,464 triangles (a palm) and ~2.4 ms of hull and triangles (the tall
   * cactus), so at 1,024 a course of the heaviest kind adds ~2.5 M triangles,
   * about a whole frame of the island under it, and ~2.5 s to a load: past
   * that a course costs more than the ground it stands on. DEVIATIONS DEV-533
   * has the table. A structural bound too: the file's inflated size is capped
   * for this many (`PLAYER_COURSE_WIRE.maxInflatedBytes`, the test).
   *
   * Raising it moves no course's id: the canonical bytes do not hold the cap.
   */
  props: { max: 1024 },
  /**
   * DEV-504: a prop's scale, as a multiple of its library default: a quarter
   * to four times the size the island draws it at. Structural, like the
   * coordinate bound: it keeps a spire from being scaled to the sky.
   */
  propScaleRatio: { min: 0.25, max: 4 },
  /**
   * DEV-504: two props of one kind nearer than this are refused. The renderer
   * draws one copy of a mesh standing within `COINCIDENT_PROP_METRES` (0.5 m)
   * of another (`load-props.ts`, DEV-218a), so a course may not hold a prop
   * that would not be drawn; `prop-library.test.ts` holds this above that.
   */
  propSpacingMetres: 1,
  /** Characters in `island` or `sky`. The longest shipped id is 18. */
  idLength: 64,
  /** How many errors one refusal reports. Garbage gets a sample, not a novel. */
  errorsReported: 32,
} as const

/**
 * The format's fixed shape: quanta, the curve's sampling, the id length and
 * the racing line's spacing. Pinned by value beside the limits.
 */
export const PLAYER_COURSE_SHAPE = {
  /** A point is stored to 10 cm (EDITOR.md §5.1's estimate assumed it). */
  pointQuantumMetres: 0.1,
  /** A path parameter to 1e-4: 1 m on a 10 km course. */
  tQuantum: 0.0001,
  /**
   * The start pad's heading to a tenth of a degree (DEV-475): 0.17 m of
   * sideways drift per 100 m flown, far inside a ring's 22.6 m opening.
   */
  yawQuantumDegrees: 0.1,
  /** A gap to the metre. */
  gapQuantumMetres: 1,
  /** A time limit to the second. */
  timeLimitQuantumSeconds: 1,
  /** DEV-504: a prop's yaw to the degree: 1.7 m at the tip of a 100 m spire. */
  propYawQuantumDegrees: 1,
  /** DEV-504: a prop's scale to a hundredth. */
  propScaleQuantum: 0.01,
  /** Samples per control-point segment when the curve is measured. */
  divisionsPerSegment: 64,
  /** Canonical uniform Catmull-Rom. */
  tension: 0.5,
  /**
   * Spacing of the `route` handed to the AI, metres: inside the 16.5–26.8 m
   * 2016's own `CurvyClonePath`s were written at (asserted in the test).
   */
  routeSpacingMetres: 25,
  /**
   * Hex digits of the SHA-256 kept in the id: 48 bits, so `generated.seed`
   * (an INTEGER in `content/levels/_schema.json`) holds the same number exactly.
   */
  idHexDigits: 12,
} as const

// ── DEV-490: an island of the course's own ────────────────────────────────

interface SheetLand {
  readonly terrainSize: number
  readonly terrainHeight: number
  readonly chunkSize: number
  readonly transform?: {
    readonly position?: readonly number[]
    readonly envRoot?: readonly number[]
  }
}
type IslandSheet = Record<string, { readonly terrains: Record<string, SheetLand> }>
const SHEET = TERRAIN as unknown as IslandSheet
const landsOf = (): SheetLand[] =>
  Object.values(SHEET).flatMap((env) =>
    Object.entries(env.terrains)
      .filter(([n]) => n !== 'ocean')
      .map(([, t]) => t),
  )
const landOf = (island: string): SheetLand | null => {
  const env = Object.hasOwn(SHEET, island) ? SHEET[island] : undefined
  const name = env ? Object.keys(env.terrains).find((n) => n !== 'ocean') : undefined
  return env && name ? (env.terrains[name] as SheetLand) : null
}

/**
 * The sea's surface near Simonet's map origin, world metres: `boot/viewpoints.ts`'s
 * 116.6, the spot value DEV-489's `PREVIEW_SHORE` stands on too. The ocean's
 * own map moves it about ±1.2 m (115.29 to 117.63) and the waves ±4, so this
 * is the waterline to within a wave — what "0 is the waterline" needs.
 */
const OCEAN_SURFACE_SIMONET = 116.6

/**
 * Where the sea stands in `island`'s land MESH frame, metres: the height a
 * custom ground must reach to be dry. Derived: the surface above the ocean
 * plate's origin (Simonet's, where the spot value was read), carried to the
 * island's own plate, minus the land's origin, each composed with its
 * `envRoot`. Simonet 198.3, kauai 48.6 (the two wear the same ocean files).
 * **0 on an island with no sea** (desert, alpine): there the map's `sea` grey
 * stands at the valley floor. Pinned in `tests/unit/island-map.test.ts`.
 */
export const islandWaterline = (island: string): number => {
  const ocean = Object.hasOwn(SHEET, island) ? SHEET[island]?.terrains.ocean : undefined
  return ocean ? seaInLandFrame(island, island) : 0
}

/**
 * DEV-500: where `seaIsland`'s sea plate, placed as the sheet places it, has its
 * surface in `landIsland`'s land MESH frame, metres — `islandWaterline`'s
 * arithmetic with the plate and the land allowed to differ, so a base with no
 * sea can borrow one. Both terrains share the level's `worldOffset`, which
 * cancels. 0 when either is missing.
 */
export const seaInLandFrame = (seaIsland: string, landIsland: string): number => {
  const ocean = Object.hasOwn(SHEET, seaIsland) ? SHEET[seaIsland]?.terrains.ocean : undefined
  const land = landOf(landIsland)
  const simonetOcean = SHEET.simonet?.terrains.ocean
  if (!ocean || !land || !simonetOcean) return 0
  const y = (t: SheetLand): number =>
    (t.transform?.position?.[1] ?? 0) + (t.transform?.envRoot?.[1] ?? 0)
  return y(ocean) + (OCEAN_SURFACE_SIMONET - y(simonetOcean)) - y(land)
}

/**
 * DEV-499: `island`'s own height SCALE above its waterline, metres: the
 * sheet's `terrainHeight` (2016's full white) less `islandWaterline`, to the
 * metre below. Simonet 1,337, kauai 975, desert and alpine 1,024. The import
 * and seed dialogs' CEILING for "highest point above the sea"; since DEV-534
 * they start at the measured summit (`islandPeakHeight`), which three of the
 * four 2016 maps put within 3 % of this and Simonet at 67 % of it (DEV-499's
 * row measures them). Null for no such island.
 */
export const islandHeightScale = (island: string): number | null => {
  const land = landOf(island)
  return land ? Math.floor(land.terrainHeight - islandWaterline(island)) : null
}

/**
 * DEV-534: the brightest grey (0–255) in each island's shipped height map, the
 * MEASUREMENT behind `islandPeakHeight`. Pinned here because the sheet holds
 * the map's path and scale, not its pixels, and the dialogs have no map to
 * read. `island-map.test.ts` decodes the four PNGs and compares, where the
 * gitignored maps are hydrated (and says so loudly where they are not).
 */
export const ISLAND_MAP_PEAK_GREY: Readonly<Record<string, number>> = {
  simonet: 181,
  kauai: 248,
  desert: 254,
  alpine: 249,
}

/**
 * DEV-534: `island`'s measured SUMMIT above its waterline, metres, to the
 * nearest: its map's brightest grey (`ISLAND_MAP_PEAK_GREY`) times the sheet's
 * `terrainHeight`, less `islandWaterline`. Simonet 892, kauai 947, desert
 * 1,020, alpine 1,000. The import and seed dialogs START here (Matt, 2026-09-29:
 * *"measured peak"*), so a normalised map stands a creator's summit where
 * 2016's own stood; `islandHeightScale` stays the ceiling. Never above the
 * scale. Null for an island with no land or no measured map.
 */
export const islandPeakHeight = (island: string): number | null => {
  const land = landOf(island)
  const scale = islandHeightScale(island)
  const grey = Object.hasOwn(ISLAND_MAP_PEAK_GREY, island)
    ? ISLAND_MAP_PEAK_GREY[island]
    : undefined
  if (!land || scale === null || grey === undefined) return null
  return Math.min(scale, Math.round((grey / 255) * land.terrainHeight - islandWaterline(island)))
}

/** The chunk a custom island's side is a whole number of, metres: its island's. Null for none. */
export const islandChunkMetres = (island: string): number | null =>
  landOf(island)?.chunkSize ?? null

/**
 * The bounds on a course's own island. Policy; **pinned by value** in
 * `tests/unit/island-map.test.ts`, which also holds the two extents equal to
 * DEV-489's `CUSTOM_GROUND_LIMITS` (derived the same way from the sheet): as
 * wide as kauai, and — waterline included — as tall as Simonet.
 */
export const PLAYER_COURSE_ISLAND = {
  /** The widest shipped land, metres. */
  maxSize: Math.max(...landsOf().map((t) => t.terrainSize)),
  /** The tallest shipped land, metres: the waterline plus `height` may not pass it. */
  maxTerrainHeight: Math.max(...landsOf().map((t) => t.terrainHeight)),
  /** The lowest white above the waterline, metres: under this a map is a reef. */
  minHeight: 20,
  /** `height` to the metre. */
  heightQuantumMetres: 1,
  /** `sea`, the grey at the waterline: at most this, so there is land above it. */
  seaMax: 0.9,
  /** `sea` to a thousandth. */
  seaQuantum: 0.001,
  /** DEV-493: a seeded island's `rugged` and `sea` sliders, to a hundredth. */
  shapeQuantum: 0.01,
} as const

/**
 * DEV-500: the water block's policy. Pinned by value in
 * `tests/unit/course-water.test.ts`.
 */
export const PLAYER_COURSE_WATER = {
  /** `level` to the metre, as `island.height` is. */
  levelQuantumMetres: 1,
  /**
   * A new water switched on over a base with no sea stands this far above the
   * lowest ground in the course's box, and at most this far under the pad's
   * foot: a flooded valley floor that leaves the pad dry. On a base with a sea
   * it starts at that sea.
   */
  defaultDepthMetres: 20,
  /** The editor samples the course's box on this many cells a side to find its lowest ground. */
  firstLevelSamples: 16,
  /**
   * DEV-877 (Matt: "raise default seeded island water height to 140m"): a
   * water over a SEEDED island starts this high, under the island's ceiling.
   * DEV-888: in WORLD metres, the frame the editor's readout shows ("The
   * water stands at 140 m"), NOT the frame of `level` (above the land
   * floor): the playtester saw 156 because 140 was read as a level and the
   * floor adds its 16. `seededWaterLevel` converts.
   */
  seededDefaultLevelMetres: 140,
} as const

/**
 * DEV-888: the `level` a seeded island's water starts at, so that the editor's
 * readout (world metres: `floorY` + level) reads `seededDefaultLevelMetres`;
 * never over the island's ceiling, never under 0. `floorY` is the land floor
 * in world metres (`waterWorldY(donor, { level: 0 })`).
 */
export const seededWaterLevel = (
  island: string,
  ground: PlayerCourseGround | null,
  floorY: number,
): number => {
  const top = waterCeiling(island, ground) ?? Number.POSITIVE_INFINITY
  return Math.max(0, Math.min(PLAYER_COURSE_WATER.seededDefaultLevelMetres - floorY, top))
}

/**
 * DEV-500: the highest a course's water may stand, metres above `island`'s
 * floor: the top of what its land can reach — the sheet's `terrainHeight`, or a
 * course's own ground's waterline plus its height. Null for no such island.
 */
export const waterCeiling = (island: string, ground: PlayerCourseGround | null): number | null => {
  const land = landOf(island)
  if (!land) return null
  return ground
    ? Math.floor(islandWaterline(island) + groundExtent(ground).height)
    : land.terrainHeight
}

/**
 * DEV-500: where `island`'s own sea stands in its land's mesh frame, or null
 * when it has none — so a course switching water on starts there.
 */
export const islandSeaLevel = (island: string): number | null =>
  Object.hasOwn(SHEET, island) && SHEET[island]?.terrains.ocean ? islandWaterline(island) : null

const MAP_SHA = /^[0-9a-f]{64}$/

/** The generator tag a player course's `Level.generated` carries. */
export const PLAYER_COURSE_GENERATOR = 'player-v1'

/** A validation error: a JSON path, and what is wrong there. */
export type PlayerCourseIssue = readonly [path: string, message: string]

export type PlayerCourseResult =
  | { readonly ok: true; readonly course: PlayerCourse }
  | { readonly ok: false; readonly errors: readonly PlayerCourseIssue[] }

/** Thrown by `expandPlayerCourse` / `loadPlayerCourse` on a course that does not validate. */
export class PlayerCourseError extends Error {
  readonly errors: readonly PlayerCourseIssue[]
  constructor(errors: readonly PlayerCourseIssue[]) {
    super(
      `player course refused: ${errors
        .slice(0, 3)
        .map(([p, m]) => `${p}: ${m}`)
        .join('; ')}${errors.length > 3 ? ` (+${errors.length - 3} more)` : ''}`,
    )
    this.name = 'PlayerCourseError'
    this.errors = errors
  }
}

// ── Quantising and the canonical form ─────────────────────────────────────

export { quantise }

const qPoint = (p: readonly number[]): Vec3Tuple => [
  quantise(p[0] as number, PLAYER_COURSE_SHAPE.pointQuantumMetres),
  quantise(p[1] as number, PLAYER_COURSE_SHAPE.pointQuantumMetres),
  quantise(p[2] as number, PLAYER_COURSE_SHAPE.pointQuantumMetres),
]
const qT = (t: number): number => quantise(t, PLAYER_COURSE_SHAPE.tQuantum)
const qGap = (g: number): number => quantise(g, PLAYER_COURSE_SHAPE.gapQuantumMetres)
const qTime = (s: number): number => quantise(s, PLAYER_COURSE_SHAPE.timeLimitQuantumSeconds)

/** A pad heading on its grid, in [-180, 180). See `normaliseDegreesOnGrid`. */
export const normaliseYaw = (yaw: number): number =>
  normaliseDegreesOnGrid(yaw, PLAYER_COURSE_SHAPE.yawQuantumDegrees)

/** DEV-504: a prop's yaw on its grid, in [-180, 180), as `normaliseYaw` does the pad's. */
export const normalisePropYaw = (yaw: number): number =>
  normaliseDegreesOnGrid(yaw, PLAYER_COURSE_SHAPE.propYawQuantumDegrees)

/** DEV-504: a placed prop on its grids. */
export const quantiseProp = (p: PlayerCourseProp): PlayerCourseProp => ({
  kind: p.kind,
  pos: qPoint(p.pos),
  yaw: normalisePropYaw(p.yaw),
  scale: quantise(p.scale, PLAYER_COURSE_SHAPE.propScaleQuantum),
})

/**
 * DEV-504: the props in their canonical ORDER — by kind, then x, z, y, yaw and
 * scale — so two courses holding the same props in another order are one
 * course with one id. Only the canonical bytes are sorted: the draft, and the
 * validator's answer, keep the author's order, so an index means one prop
 * everywhere the editor uses it.
 */
const sortedProps = (props: readonly PlayerCourseProp[]): PlayerCourseProp[] =>
  [...props].sort(
    (a, b) =>
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
      a.pos[0] - b.pos[0] ||
      a.pos[2] - b.pos[2] ||
      a.pos[1] - b.pos[1] ||
      a.yaw - b.yaw ||
      a.scale - b.scale,
  )

const qStart = (s: PlayerCourseStart): PlayerCourseStart => ({
  pos: qPoint(s.pos),
  yaw: normaliseYaw(s.yaw),
})

const qAnchor = (a: PlayerCourseAnchor): PlayerCourseAnchor => ({
  h: quantise(a.h, PLAYER_COURSE_SHAPE.pointQuantumMetres),
})

/**
 * DEV-501: the pad's point — the pad's pose times the local offset (0, h, gap):
 * `h` over its foot, `gap` ahead along its heading (the nose, local −z turned
 * by `yaw`), on the point grid. The inputs are taken as given; `quantised`
 * hands it gridded ones, so the canonical point is a function of the canonical
 * pad, gap and height alone.
 */
export const anchorPoint = (
  start: PlayerCourseStart,
  gap: number,
  anchor: PlayerCourseAnchor,
): Vec3Tuple => {
  const f = yawForward(start.yaw)
  return qPoint([
    (start.pos[0] as number) + f.x * gap,
    (start.pos[1] as number) + anchor.h,
    (start.pos[2] as number) + f.z * gap,
  ])
}

/**
 * DEV-501: the course with its first point where its anchor puts it (put in
 * front when the line has none yet). A free course is returned as it is, the
 * same object; so is an anchored one whose point is already there.
 */
export const anchored = (c: PlayerCourse): PlayerCourse => {
  const a = c.path.anchor
  if (!a) return c
  const p = anchorPoint(c.start, c.path.gap, a)
  const old = c.path.points[0]
  if (old && old[0] === p[0] && old[1] === p[1] && old[2] === p[2]) return c
  return { ...c, path: { ...c.path, points: [p, ...c.path.points.slice(1)] } }
}

/** The path on its grid; an anchored one's first point derived from the gridded pad, gap and height. */
const qPath = (c: PlayerCourse): PlayerCourse['path'] => {
  const gap = qGap(c.path.gap)
  const a = c.path.anchor
  if (!a) return { points: c.path.points.map(qPoint), gap }
  const anchor = qAnchor(a)
  const first = anchorPoint(qStart(c.start), gap, anchor)
  return { points: [first, ...c.path.points.slice(1).map(qPoint)], gap, anchor }
}

/** A course with every number on its grid and the overrides sorted. Idempotent. */
const quantised = (c: PlayerCourse): PlayerCourse => ({
  v: PLAYER_COURSE_VERSION,
  island: c.island,
  sky: c.sky,
  vehicle: c.vehicle,
  mode: c.mode,
  path: qPath(c),
  rings: c.rings.map((r) => ({ t: qT(r.t), skip: true as const })).sort((a, b) => a.t - b.t),
  start: qStart(c.start),
  finish: { t: qT(c.finish.t) },
  timeLimit: qTime(c.timeLimit),
  name: [c.name[0], c.name[1]],
  // DEV-476: only when present, so an absent block stays absent.
  ...(c.light ? { light: quantiseLight(c.light) } : {}),
  // DEV-490: only when present, so a course on a shipped island keeps its bytes.
  ...(c.ground ? { ground: quantiseGround(c.ground) } : {}),
  // DEV-500: only when present, so a course with no water keeps its bytes.
  ...(c.water
    ? { water: { level: quantise(c.water.level, PLAYER_COURSE_WATER.levelQuantumMetres) } }
    : {}),
  // DEV-504: only when there is one, so an empty list is the absent block.
  ...(c.props && c.props.length > 0 ? { props: c.props.map(quantiseProp) } : {}),
})

/** DEV-490: an island's numbers on their grids. */
const quantiseGround = (g: PlayerCourseGround): PlayerCourseGround =>
  isSeedIsland(g)
    ? {
        // DEV-493; DEV-499's version only when it is not 1
        ...(seedVersion(g) === 1 ? {} : { v: seedVersion(g) }),
        seed: g.seed,
        shape: {
          size: quantise(g.shape.size, 1),
          height: quantise(g.shape.height, PLAYER_COURSE_ISLAND.heightQuantumMetres),
          rugged: quantise(g.shape.rugged, PLAYER_COURSE_ISLAND.shapeQuantum),
          sea: quantise(g.shape.sea, PLAYER_COURSE_ISLAND.shapeQuantum),
        },
      }
    : {
        map: g.map,
        size: quantise(g.size, 1),
        height: quantise(g.height, PLAYER_COURSE_ISLAND.heightQuantumMetres),
        sea: quantise(g.sea, PLAYER_COURSE_ISLAND.seaQuantum),
      }

/**
 * The ONE canonical JSON string of a course: fixed key order, every number
 * quantised, the overrides sorted by `t`. Two courses that mean the same thing
 * — keys in another order, a point 3 cm off its grid — produce the same bytes,
 * and so the same id.
 */
export const canonicalPlayerCourse = (c: PlayerCourse): string => {
  const q = quantised(c)
  // Written key by key: `JSON.stringify` keeps insertion order, and this
  // object literal IS the order. An optional block (DEV-476's `light`) goes
  // in only when present — see the header.
  return JSON.stringify({
    v: q.v,
    // DEV-490: a course's own ground is written INSIDE `island`, with the
    // island it wears as `colours` (EDITOR.md §5.4's reserved shape).
    island: isSeedIsland(q.ground)
      ? {
          // DEV-493. DEV-499: the generator version first, and only when it is
          // not 1, so every seed course made before it keeps its bytes and id.
          ...(seedVersion(q.ground) === 1 ? {} : { v: seedVersion(q.ground) }),
          seed: q.ground.seed,
          shape: {
            size: q.ground.shape.size,
            height: q.ground.shape.height,
            rugged: q.ground.shape.rugged,
            sea: q.ground.shape.sea,
          },
          colours: q.island,
        }
      : q.ground
        ? {
            map: q.ground.map,
            size: q.ground.size,
            height: q.ground.height,
            sea: q.ground.sea,
            colours: q.island,
          }
        : q.island,
    sky: q.sky,
    vehicle: q.vehicle,
    mode: q.mode,
    // DEV-501: an anchored path adds its anchor (its first point is the pad's,
    // derived by `quantised`); a free one writes what it always wrote.
    path: q.path.anchor
      ? { points: q.path.points, gap: q.path.gap, anchor: { h: q.path.anchor.h } }
      : { points: q.path.points, gap: q.path.gap },
    rings: q.rings.map((r) => ({ t: r.t, skip: r.skip })),
    start: { pos: q.start.pos, yaw: q.start.yaw },
    finish: { t: q.finish.t },
    timeLimit: q.timeLimit,
    name: q.name,
    // DEV-476: written only when present — see the header.
    ...(q.light
      ? {
          light: {
            sunAzimuth: q.light.sunAzimuth,
            sunElevation: q.light.sunElevation,
            tint: [q.light.tint[0], q.light.tint[1], q.light.tint[2]],
            tintAmount: q.light.tintAmount,
          },
        }
      : {}),
    // DEV-500: written only when present — a course with no water keeps its id.
    ...(q.water ? { water: { level: q.water.level } } : {}),
    // DEV-504: written only when there is one, sorted (`sortedProps`).
    ...(q.props
      ? {
          props: sortedProps(q.props).map((p) => ({
            kind: p.kind,
            pos: [p.pos[0], p.pos[1], p.pos[2]],
            yaw: p.yaw,
            scale: p.scale,
          })),
        }
      : {}),
  })
}

const hexOf = (canonical: string): string =>
  sha256Hex(new TextEncoder().encode(canonical)).slice(0, PLAYER_COURSE_SHAPE.idHexDigits)

/** `pc_` + a SHA-256 prefix of the canonical string. The course's identity everywhere. */
export const playerCourseId = (c: PlayerCourse): string => `pc_${hexOf(canonicalPlayerCourse(c))}`

// ── Validation ────────────────────────────────────────────────────────────

const COURSE_KEYS = [
  'v',
  'island',
  'sky',
  'vehicle',
  'mode',
  'path',
  'rings',
  'start',
  'finish',
  'timeLimit',
  'name',
  'light',
  'ground',
  'water',
  'props',
] as const
/**
 * `rings` may be absent (no overrides), and so may `light` (DEV-476: the sky's
 * own), `ground`, `water` and `props` (DEV-504); everything else is required.
 */
const OPTIONAL_KEYS: ReadonlySet<string> = new Set(['rings', 'light', 'ground', 'water', 'props'])

const ENV_ID = /^[a-z][a-z0-9_]*$/
const MISSION_ID = /^[A-Za-z][A-Za-z0-9_]*$/

/** A short, safe rendering of something hostile, for a message. Never throws. */
const shown = (v: unknown): string => shownValue(v, 24, '...', 21)

const ADJECTIVES: ReadonlySet<string> = new Set(HANDLE_ADJECTIVES)
const NOUNS: ReadonlySet<string> = new Set(HANDLE_NOUNS)

/**
 * Is this a course name the lists could have generated? `isHandle`'s grammar
 * without the number: `[adjective, noun]`, each exactly as the list spells it.
 * No free text anywhere in the format (D30), so a shared course cannot carry a
 * word nobody chose from the list.
 */
export const isCourseName = (name: unknown): name is readonly [string, string] =>
  Array.isArray(name) &&
  name.length === 2 &&
  typeof name[0] === 'string' &&
  typeof name[1] === 'string' &&
  ADJECTIVES.has(name[0]) &&
  NOUNS.has(name[1])

/** A course name from a source of uniform integers in `[0, n)` — the reroll. */
export const randomCourseName = (randomInt: (n: number) => number): [string, string] => [
  HANDLE_ADJECTIVES[randomInt(HANDLE_ADJECTIVES.length)] as string,
  HANDLE_NOUNS[randomInt(HANDLE_NOUNS.length)] as string,
]

class Issues extends IssueList<PlayerCourseIssue> {
  constructor() {
    super(PLAYER_COURSE_LIMITS.errorsReported)
  }
}

const finiteIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max

/** v1's start: a place on the line (DEV-466). Read only to be migrated. */
interface StartV1 {
  readonly t: number
}

/**
 * A course as read, before migration: the fields of whichever version it was,
 * each on its grid. `start` is v1's `{ t }` or v2's pad.
 */
interface Parsed {
  readonly v: 1 | 2
  readonly island: string
  readonly sky: string
  /** Every point, an anchored course's derived first one included. */
  readonly points: readonly Vec3Tuple[]
  readonly gap: number
  /** DEV-501. v2 only. */
  readonly anchor: PlayerCourseAnchor | null
  readonly rings: readonly PlayerCourseRingOverride[]
  readonly start: StartV1 | PlayerCourseStart
  readonly finish: number
  readonly timeLimit: number
  readonly name: readonly [string, string]
  /** DEV-476. v2 only. */
  readonly light: PlayerCourseLight | null
  /** DEV-490. */
  readonly ground: PlayerCourseGround | null
  /** DEV-500. v2 only. */
  readonly water: PlayerCourseWater | null
  /** DEV-504. v2 only; in the order written. */
  readonly props: readonly PlayerCourseProp[]
}

/**
 * DEV-504: the props block, read structurally: `[{ kind, pos, yaw, scale }]`,
 * every kind in the library, every scale within `propScaleRatio` of its kind's
 * default, and no two of one kind nearer than `propSpacingMetres`. Quantised,
 * in the order written.
 */
const parseProps = (raw: unknown, issues: Issues): PlayerCourseProp[] => {
  const L = PLAYER_COURSE_LIMITS
  if (!Array.isArray(raw)) {
    issues.add('props', 'must be an array of { kind, pos, yaw, scale }')
    return []
  }
  if (raw.length > L.props.max) {
    issues.add('props', `holds ${raw.length} props; a course has at most ${L.props.max}`)
    return []
  }
  const out: PlayerCourseProp[] = []
  raw.forEach((p: unknown, i) => {
    const at = `props[${i}]`
    if (!isRecord(p)) {
      issues.add(at, 'must be { kind, pos, yaw, scale }')
      return
    }
    for (const k of Object.keys(p)) {
      if (k !== 'kind' && k !== 'pos' && k !== 'yaw' && k !== 'scale')
        issues.add(`${at}.${shown(k)}`, 'is not a field of a prop')
    }
    const entry = typeof p.kind === 'string' ? propEntry(p.kind) : null
    if (!entry) issues.add(`${at}.kind`, `names no prop this build has: ${shown(p.kind)}`)
    const pos = p.pos
    const posOk =
      Array.isArray(pos) &&
      pos.length === 3 &&
      pos.every((c) => finiteIn(c, -L.coordinateMetres, L.coordinateMetres))
    if (!posOk)
      issues.add(`${at}.pos`, `must be three finite numbers within ±${L.coordinateMetres} m`)
    const yawOk = finiteIn(p.yaw, -180, 180)
    if (!yawOk) issues.add(`${at}.yaw`, 'must be degrees from -180 to 180')
    const R = L.propScaleRatio
    const d = entry?.scale.default ?? 1
    const lo = quantise(d * R.min, PLAYER_COURSE_SHAPE.propScaleQuantum)
    const hi = quantise(d * R.max, PLAYER_COURSE_SHAPE.propScaleQuantum)
    const scaleOk = finiteIn(p.scale, lo, hi)
    if (!scaleOk) issues.add(`${at}.scale`, `must be ${lo} to ${hi} for this prop`)
    if (entry && posOk && yawOk && scaleOk) {
      out.push(
        quantiseProp({
          kind: entry.id,
          pos: pos as unknown as Vec3Tuple,
          yaw: p.yaw as number,
          scale: p.scale as number,
        }),
      )
    }
  })
  if (out.length === raw.length) {
    for (let i = 0; i < out.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = out[i] as PlayerCourseProp
        const b = out[j] as PlayerCourseProp
        if (a.kind !== b.kind) continue
        const d = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2])
        if (d < L.propSpacingMetres) {
          issues.add(
            `props[${i}]`,
            `stands ${d.toFixed(1)} m from props[${j}], the same prop; the least is ${L.propSpacingMetres} m`,
          )
        }
      }
    }
  }
  return out
}

const isV1Start = (s: StartV1 | PlayerCourseStart): s is StartV1 => 't' in s

/** Structural validation: everything that needs no donor. */
const parseCourse = (input: unknown, issues: Issues): Parsed | null => {
  if (!isRecord(input)) {
    issues.add('', 'a course must be a JSON object')
    return null
  }

  // v, first: the other fields are read as that version's.
  const v = input.v
  const version = v === 1 || v === PLAYER_COURSE_VERSION ? v : null
  if (version === null) {
    if (typeof v === 'number' && Number.isFinite(v) && v > PLAYER_COURSE_VERSION) {
      issues.add(
        'v',
        `format ${shown(v)} is newer than this build, which reads 1 to ${PLAYER_COURSE_VERSION}`,
      )
    } else if (Object.hasOwn(input, 'v')) {
      issues.add('v', `must be 1 or ${PLAYER_COURSE_VERSION}`)
    }
  }

  const keys = Object.keys(input)
  for (const key of keys) {
    if (!(COURSE_KEYS as readonly string[]).includes(key)) {
      issues.add(shown(key), `is not a field of a v${version ?? PLAYER_COURSE_VERSION} course`)
    }
  }
  for (const key of COURSE_KEYS) {
    if (!OPTIONAL_KEYS.has(key) && !Object.hasOwn(input, key)) issues.add(key, 'is missing')
  }

  // island: a name, or (DEV-490) an island of the course's own with the name
  // inside it as `colours`. `ground` is the same island in memory's spelling
  // (`PlayerCourse.ground`); one or the other, never both.
  let island: unknown = input.island
  let ground: PlayerCourseGround | null = null
  if (isRecord(island)) {
    if (Object.hasOwn(island, 'seed') || Object.hasOwn(island, 'map')) {
      if (Object.hasOwn(input, 'ground')) issues.add('ground', 'is written inside island')
      ground = parseGround(island, 'island', issues, true)
      island = island.colours
      if (isRecord(island)) issues.add('island.colours', 'must be an environment id')
    } else issues.add('island', 'must be an environment id')
  } else if (Object.hasOwn(input, 'ground')) {
    ground = parseGround(input.ground, 'ground', issues, false)
  }
  if (typeof island === 'string' && ground && landOf(island)) {
    const chunk = islandChunkMetres(island) as number
    const I = PLAYER_COURSE_ISLAND
    const extent = groundExtent(ground)
    if (extent.size % chunk !== 0) {
      issues.add('island.size', `must be a whole number of ${island}'s ${chunk} m chunks`)
    }
    if (islandWaterline(island) + extent.height > I.maxTerrainHeight) {
      issues.add(
        'island.height',
        `reaches past ${I.maxTerrainHeight} m of ground on ${island}, whose waterline is ${Math.round(islandWaterline(island))} m up`,
      )
    }
  }
  if (isRecord(island)) {
    // Refused above.
  } else if (Object.hasOwn(input, 'island')) {
    if (
      typeof island !== 'string' ||
      island.length > PLAYER_COURSE_LIMITS.idLength ||
      !ENV_ID.test(island)
    ) {
      issues.add('island', `must be an environment id, not ${shown(island)}`)
    }
  }

  // sky
  const sky = input.sky
  if (Object.hasOwn(input, 'sky')) {
    if (
      typeof sky !== 'string' ||
      sky.length > PLAYER_COURSE_LIMITS.idLength ||
      !MISSION_ID.test(sky)
    ) {
      issues.add('sky', `must be a shipped mission id, not ${shown(sky)}`)
    }
  }

  // vehicle, mode
  if (Object.hasOwn(input, 'vehicle') && input.vehicle !== 'hoverjet') {
    issues.add('vehicle', `only "hoverjet" is in this version, not ${shown(input.vehicle)}`)
  }
  if (Object.hasOwn(input, 'mode') && input.mode !== 'ringAttack') {
    issues.add('mode', `only "ringAttack" is in this version, not ${shown(input.mode)}`)
  }

  // path
  const L = PLAYER_COURSE_LIMITS
  let points: Vec3Tuple[] | null = null
  let gap: number | null = null
  // DEV-501: `anchor: { h }` — the first point is the pad's, and not written.
  let anchor: PlayerCourseAnchor | null = null
  const path = input.path
  if (Object.hasOwn(input, 'path')) {
    if (!isRecord(path)) {
      issues.add('path', 'must be an object with points and gap')
    } else {
      for (const key of Object.keys(path)) {
        if (key !== 'points' && key !== 'gap' && !(key === 'anchor' && version === 2))
          issues.add(`path.${shown(key)}`, 'is not a field of a path')
      }
      if (version === 2 && Object.hasOwn(path, 'anchor')) {
        const a = path.anchor
        const H = L.anchorHeightMetres
        const keysOk = isRecord(a) && Object.keys(a).every((k) => k === 'h')
        if (!keysOk || !finiteIn(a.h, H.min, H.max)) {
          issues.add('path.anchor', `must be { h }, h from ${H.min} to ${H.max} m`)
        } else {
          anchor = qAnchor({ h: a.h as number })
        }
      }
      const raw = path.points
      if (!Array.isArray(raw)) {
        issues.add('path.points', 'must be an array of [x, y, z]')
      } else if (raw.length < L.points.min || raw.length > L.points.max) {
        issues.add(
          'path.points',
          `must hold ${L.points.min} to ${L.points.max} points, not ${raw.length}`,
        )
      } else {
        const out: Vec3Tuple[] = []
        raw.forEach((p: unknown, i) => {
          if (
            !Array.isArray(p) ||
            p.length !== 3 ||
            !p.every((c) => finiteIn(c, -L.coordinateMetres, L.coordinateMetres))
          ) {
            issues.add(
              `path.points[${i}]`,
              `must be three finite numbers within ±${L.coordinateMetres} m`,
            )
            return
          }
          out.push(qPoint(p as number[]))
        })
        if (out.length === raw.length) {
          for (let i = 1; i < out.length; i++) {
            const a = out[i - 1] as Vec3Tuple
            const b = out[i] as Vec3Tuple
            const d = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2)
            if (d < L.pointSpacingMetres.min) {
              issues.add(
                `path.points[${i}]`,
                `is ${d.toFixed(1)} m from the point before it; the least is ${L.pointSpacingMetres.min} m`,
              )
            }
          }
          points = out
        }
      }
      if (!finiteIn(path.gap, L.gapMetres.min, L.gapMetres.max)) {
        issues.add(
          'path.gap',
          `must be ${L.gapMetres.min} to ${L.gapMetres.max} m, not ${shown(path.gap)}`,
        )
      } else {
        gap = qGap(path.gap)
      }
    }
  }

  // rings
  const rings: PlayerCourseRingOverride[] = []
  if (Object.hasOwn(input, 'rings')) {
    const raw = input.rings
    if (!Array.isArray(raw)) {
      issues.add('rings', 'must be an array of { t, skip }')
    } else if (raw.length > L.rings.max) {
      issues.add(
        'rings',
        `holds ${raw.length} overrides; a course has at most ${L.rings.max} rings`,
      )
    } else {
      raw.forEach((r: unknown, i) => {
        if (!isRecord(r)) {
          issues.add(`rings[${i}]`, 'must be { t, skip: true }')
          return
        }
        for (const key of Object.keys(r)) {
          if (key !== 't' && key !== 'skip')
            issues.add(`rings[${i}].${shown(key)}`, 'is not a field of a ring override')
        }
        if (!finiteIn(r.t, 0, 1)) issues.add(`rings[${i}].t`, 'must be a number from 0 to 1')
        if (r.skip !== true)
          issues.add(`rings[${i}].skip`, 'must be true (the only override in this version)')
        if (finiteIn(r.t, 0, 1) && r.skip === true) rings.push({ t: qT(r.t), skip: true })
      })
      const seen = new Set<number>()
      for (const r of rings) {
        if (seen.has(r.t)) issues.add('rings', `names t = ${r.t} twice`)
        seen.add(r.t)
      }
    }
  }

  // start, finish
  const tOf = (key: 'start' | 'finish'): number | null => {
    if (!Object.hasOwn(input, key)) return null
    const block = input[key]
    if (!isRecord(block)) {
      issues.add(key, 'must be { t }')
      return null
    }
    for (const k of Object.keys(block))
      if (k !== 't') issues.add(`${key}.${shown(k)}`, `is not a field of ${key}`)
    if (!finiteIn(block.t, 0, 1)) {
      issues.add(`${key}.t`, 'must be a number from 0 to 1')
      return null
    }
    return qT(block.t)
  }
  // v2's start pad (DEV-475): `{ pos: [x, y, z], yaw }`.
  const padOf = (): PlayerCourseStart | null => {
    if (!Object.hasOwn(input, 'start')) return null
    const block = input.start
    if (!isRecord(block)) {
      issues.add('start', 'must be a pad, { pos: [x, y, z], yaw }')
      return null
    }
    for (const k of Object.keys(block))
      if (k !== 'pos' && k !== 'yaw') issues.add(`start.${shown(k)}`, 'is not a field of a pad')
    const pos = block.pos
    const posOk =
      Array.isArray(pos) &&
      pos.length === 3 &&
      pos.every((c) => finiteIn(c, -L.coordinateMetres, L.coordinateMetres))
    if (!posOk) {
      issues.add('start.pos', `must be three finite numbers within ±${L.coordinateMetres} m`)
    }
    const yawOk = finiteIn(block.yaw, -180, 180)
    if (!yawOk) issues.add('start.yaw', 'must be degrees from -180 to 180')
    if (!posOk || !yawOk) return null
    return qStart({ pos: pos as unknown as Vec3Tuple, yaw: block.yaw as number })
  }
  let start: StartV1 | PlayerCourseStart | null = null
  if (version === 1) {
    const t = tOf('start')
    start = t === null ? null : { t }
  } else if (version !== null) {
    start = padOf()
  }
  const finish = tOf('finish')
  if (start !== null && isV1Start(start) && finish !== null && !(start.t < finish)) {
    issues.add('finish.t', 'must be after start.t')
  }
  if (version === PLAYER_COURSE_VERSION && finish !== null && !(finish > 0)) {
    issues.add('finish.t', "must be past the line's first point")
  }
  // DEV-501: the first point is the pad's, derived again here: the copy the
  // file holds is never read. Held to the spacing every other pair is.
  if (anchor && points && gap !== null && start !== null && !isV1Start(start)) {
    const first = anchorPoint(start, gap, anchor)
    const next = points[1] as Vec3Tuple
    const d = Math.sqrt(
      (next[0] - first[0]) ** 2 + (next[1] - first[1]) ** 2 + (next[2] - first[2]) ** 2,
    )
    if (d < L.pointSpacingMetres.min) {
      issues.add(
        'path.points[1]',
        `is ${d.toFixed(1)} m from the pad's point; the least is ${L.pointSpacingMetres.min} m`,
      )
    }
    points = [first, ...points.slice(1)]
  }

  // timeLimit
  let timeLimit: number | null = null
  if (Object.hasOwn(input, 'timeLimit')) {
    const T = L.timeLimitSeconds
    if (!finiteIn(input.timeLimit, T.min, T.max)) {
      issues.add('timeLimit', `must be ${T.min} to ${T.max} seconds, not ${shown(input.timeLimit)}`)
    } else {
      timeLimit = qTime(input.timeLimit)
    }
  }

  // name
  if (Object.hasOwn(input, 'name') && !isCourseName(input.name)) {
    issues.add('name', 'must be [adjective, noun] from the handle lists')
  }

  // light (DEV-476): structural bounds here; the sky's band is the expansion's.
  let light: PlayerCourseLight | null = null
  if (Object.hasOwn(input, 'light')) {
    const block = input.light
    if (version === 1) {
      issues.add('light', 'is not a field of a v1 course')
    } else if (!isRecord(block)) {
      issues.add('light', 'must be { sunAzimuth, sunElevation, tint: [r, g, b], tintAmount }')
    } else {
      for (const k of Object.keys(block)) {
        if (k !== 'sunAzimuth' && k !== 'sunElevation' && k !== 'tint' && k !== 'tintAmount') {
          issues.add(`light.${shown(k)}`, 'is not a field of a light')
        }
      }
      const az = finiteIn(block.sunAzimuth, -180, 180)
      if (!az) issues.add('light.sunAzimuth', 'must be degrees from -180 to 180')
      const el = finiteIn(block.sunElevation, 0, 90)
      if (!el) issues.add('light.sunElevation', 'must be degrees from 0 to 90')
      const t = block.tint
      const tint = Array.isArray(t) && t.length === 3 && t.every((c) => finiteIn(c, 0, 1))
      if (!tint) issues.add('light.tint', 'must be three numbers from 0 to 1 (sRGB)')
      const amount = finiteIn(block.tintAmount, 0, 1)
      if (!amount) issues.add('light.tintAmount', 'must be a number from 0 to 1')
      if (az && el && tint && amount) {
        const c = t as number[]
        light = quantiseLight({
          sunAzimuth: block.sunAzimuth as number,
          sunElevation: block.sunElevation as number,
          tint: [c[0] as number, c[1] as number, c[2] as number],
          tintAmount: block.tintAmount as number,
        })
      }
    }
  }

  // water (DEV-500): a level on the island's own scale. v2 only, like `light`.
  let water: PlayerCourseWater | null = null
  if (Object.hasOwn(input, 'water')) {
    const block = input.water
    if (version === 1) {
      issues.add('water', 'is not a field of a v1 course')
    } else if (!isRecord(block)) {
      issues.add('water', 'must be { level }')
    } else {
      for (const k of Object.keys(block)) {
        if (k !== 'level') issues.add(`water.${shown(k)}`, 'is not a field of the water')
      }
      const top = typeof island === 'string' ? waterCeiling(island, ground) : null
      const ok = top !== null && finiteIn(block.level, 0, top)
      if (!ok) {
        issues.add(
          'water.level',
          top === null
            ? 'needs an island to stand on'
            : `must be metres from 0 to ${top} above the island's floor`,
        )
      } else {
        water = { level: quantise(block.level as number, PLAYER_COURSE_WATER.levelQuantumMetres) }
      }
    }
  }

  // props (DEV-504): v2 only, like `light`.
  let props: PlayerCourseProp[] = []
  if (Object.hasOwn(input, 'props')) {
    if (version === 1) issues.add('props', 'is not a field of a v1 course')
    else props = parseProps(input.props, issues)
  }

  if (
    issues.any ||
    version === null ||
    points === null ||
    gap === null ||
    start === null ||
    finish === null ||
    timeLimit === null
  ) {
    return null
  }
  const name = input.name as readonly [string, string]
  return {
    v: version,
    island: island as string,
    sky: sky as string,
    points,
    gap,
    anchor,
    rings: rings.sort((a, b) => a.t - b.t),
    start,
    finish,
    timeLimit,
    name: [name[0], name[1]],
    light,
    ground,
    water,
    props,
  }
}

/**
 * DEV-490: an island of the course's own, read structurally: `{ map, size,
 * height, sea }`, plus `colours` in the canonical spelling. The chunk the size
 * must be a whole number of, and the height's ceiling, need the island's
 * name, and are checked beside it in `parseCourse`.
 */
const parseGround = (
  v: unknown,
  at: string,
  issues: Issues,
  withColours: boolean,
): PlayerCourseGround | null => {
  if (!isRecord(v)) {
    issues.add(at, 'must be an island object')
    return null
  }
  if (Object.hasOwn(v, 'seed')) return parseSeedGround(v, at, issues, withColours)
  const keys = ['map', 'size', 'height', 'sea', ...(withColours ? ['colours'] : [])]
  for (const k of Object.keys(v)) {
    if (!keys.includes(k)) issues.add(`${at}.${shown(k)}`, 'is not a field of an imported island')
  }
  const I = PLAYER_COURSE_ISLAND
  const map = typeof v.map === 'string' && MAP_SHA.test(v.map)
  if (!map) issues.add(`${at}.map`, 'must be a SHA-256, 64 lower-case hex digits')
  const size = finiteIn(v.size, 1, I.maxSize)
  if (!size) issues.add(`${at}.size`, `must be metres from 1 to ${I.maxSize}`)
  const height = finiteIn(v.height, I.minHeight, I.maxTerrainHeight)
  if (!height) {
    issues.add(`${at}.height`, `must be metres from ${I.minHeight} to ${I.maxTerrainHeight}`)
  }
  const sea = finiteIn(v.sea, 0, I.seaMax)
  if (!sea) issues.add(`${at}.sea`, `must be a grey from 0 to ${I.seaMax}`)
  if (withColours && !Object.hasOwn(v, 'colours')) issues.add(`${at}.colours`, 'is missing')
  if (!(map && size && height && sea)) return null
  return quantiseGround({
    map: v.map as string,
    size: v.size as number,
    height: v.height as number,
    sea: v.sea as number,
  })
}

/** DEV-493: a seeded island, `{ v?, seed, shape: { size, height, rugged, sea } }` (DEV-499's `v`). */
const parseSeedGround = (
  v: Record<string, unknown>,
  at: string,
  issues: Issues,
  withColours: boolean,
): PlayerCourseGround | null => {
  const keys = ['v', 'seed', 'shape', ...(withColours ? ['colours'] : [])]
  for (const k of Object.keys(v)) {
    if (!keys.includes(k)) issues.add(`${at}.${shown(k)}`, 'is not a field of a seeded island')
  }
  // DEV-499: absent is 1; a version this build does not have is a later build's island.
  const known =
    !Object.hasOwn(v, 'v') || (ISLAND_SYNTH_VERSIONS as readonly unknown[]).includes(v.v)
  if (!known) {
    issues.add(
      `${at}.v`,
      Number.isInteger(v.v) && (v.v as number) > ISLAND_SYNTH_VERSION
        ? `was made by a newer build (island generator ${v.v as number}): update the game to open it`
        : `must be an island generator version: ${ISLAND_SYNTH_VERSIONS.join(' or ')}`,
    )
  }
  const I = PLAYER_COURSE_ISLAND
  const seed = Number.isInteger(v.seed) && finiteIn(v.seed, 0, ISLAND_SYNTH.seedMax)
  if (!seed) issues.add(`${at}.seed`, `must be a whole number from 0 to ${ISLAND_SYNTH.seedMax}`)
  if (withColours && !Object.hasOwn(v, 'colours')) issues.add(`${at}.colours`, 'is missing')
  const shape = v.shape
  if (!isRecord(shape)) {
    issues.add(`${at}.shape`, 'must be { size, height, rugged, sea }')
    return null
  }
  for (const k of Object.keys(shape)) {
    if (!['size', 'height', 'rugged', 'sea'].includes(k)) {
      issues.add(`${at}.shape.${shown(k)}`, 'is not a slider of a seeded island')
    }
  }
  const size = finiteIn(shape.size, 1, I.maxSize)
  if (!size) issues.add(`${at}.shape.size`, `must be metres from 1 to ${I.maxSize}`)
  const height = finiteIn(shape.height, I.minHeight, I.maxTerrainHeight)
  if (!height) {
    issues.add(`${at}.shape.height`, `must be metres from ${I.minHeight} to ${I.maxTerrainHeight}`)
  }
  const rugged = finiteIn(shape.rugged, 0, 1)
  if (!rugged) issues.add(`${at}.shape.rugged`, 'must be from 0 to 1')
  const sea = finiteIn(shape.sea, 0, 1)
  if (!sea) issues.add(`${at}.shape.sea`, 'must be from 0 to 1')
  if (!(known && seed && size && height && rugged && sea)) return null
  return quantiseGround({
    ...(Object.hasOwn(v, 'v') ? { v: v.v as IslandSynthVersion } : {}),
    seed: v.seed as number,
    shape: {
      size: shape.size as number,
      height: shape.height as number,
      rugged: shape.rugged as number,
      sea: shape.sea as number,
    },
  })
}

/**
 * DEV-490: an island read back from a DRAFT (`editor/core/drafts.ts`), which
 * stores the in-memory spelling. Null for anything that is not one.
 */
export const readCourseGround = (v: unknown): PlayerCourseGround | null => {
  const issues = new Issues()
  const g = parseGround(v, 'ground', issues, false)
  return issues.any ? null : g
}

// ── v1 → v2 (DEV-475) ─────────────────────────────────────────────────────

/**
 * A v1 course as v2. The brief (EDITOR-PLAYTEST-2026-09-27, DEV-475): *"the pad
 * at the old t's point on the line, on the ground, yawed along the tangent"* —
 * and the ground is the one part of that this file cannot do, since it never
 * sees a terrain. So the pad stands AT the old start's point on the line (the
 * ship a lift's stand-up over it), headed along the line there, and the
 * editor seats it on the ground the first time it opens the course
 * (`desk/index.ts`). A migrated course flown straight from its link starts
 * where its v1 self started, on a pad in the air.
 *
 * The rings run from the line's first point in v2. For a v1 start at `t = 0`
 * — where every draft began, and where it stayed unless the Start slider was
 * moved — that is v1's own placement, ring for ring. A later v1 start had its
 * rings from one gap past it; so every v2 ring at or behind the old start is
 * SKIPPED, and the run still begins at the pad. The rings after it keep v1's
 * spacing and shift by less than one gap. Past the format's override limit
 * the skips are left out and every ring stands.
 *
 * Pure: the same v1 input gives the same v2 course, byte for byte.
 */
const migrateV1 = (p: Parsed & { readonly start: StartV1 }): PlayerCourse => {
  const moved = migrateV1Start(p.points, p.gap, p.rings, p.start.t)
  return {
    v: PLAYER_COURSE_VERSION,
    island: p.island,
    sky: p.sky,
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    path: { points: [...p.points], gap: p.gap },
    rings: moved.rings,
    start: moved.start,
    finish: { t: p.finish },
    timeLimit: p.timeLimit,
    name: [p.name[0], p.name[1]],
  }
}

/**
 * The two parts of a v1 course that v2 changes, from its line, its gap, its
 * overrides and its start's `t`: the pad, and the overrides with the rings
 * behind the old start skipped (`migrateV1`'s rule). Exported for the
 * editor's drafts, which may hold fewer than two points: with one, the pad
 * stands at it, headed as yaw 0; with none there is nothing to stand it on,
 * and it is null.
 */
export const migrateV1Start = (
  points: readonly Vec3Tuple[],
  gap: number,
  rings: readonly PlayerCourseRingOverride[],
  t: number,
): { start: PlayerCourseStart; rings: PlayerCourseRingOverride[] } => {
  if (points.length < 2) {
    const only = points[0] ?? ([0, 0, 0] as Vec3Tuple)
    return { start: qStart({ pos: only, yaw: 0 }), rings: [...rings] }
  }
  const spline = buildCourseSpline(points.map(vec), {
    divisionsPerSegment: PLAYER_COURSE_SHAPE.divisionsPerSegment,
    tension: PLAYER_COURSE_SHAPE.tension,
  })
  const L = spline.length
  const sStart = t * L
  const at = splinePointAt(spline, sStart)
  const start = qStart({ pos: tuple(at), yaw: yawAlong(splineTangentAt(spline, sStart)) })
  let out = [...rings]
  if (sStart > 0 && L > 0 && gap > 0) {
    const behind: PlayerCourseRingOverride[] = []
    for (let k = 1; k * gap <= sStart; k++) behind.push({ t: qT((k * gap) / L), skip: true })
    const merged = [...out, ...behind.filter((b) => !out.some((r) => r.t === b.t))]
    if (merged.length <= PLAYER_COURSE_LIMITS.rings.max) out = merged.sort((x, y) => x.t - y.t)
  }
  return { start, rings: out }
}

/** The course a parse describes, in the version this build writes. */
const courseOf = (p: Parsed): PlayerCourse =>
  isV1Start(p.start)
    ? migrateV1(p as Parsed & { readonly start: StartV1 })
    : {
        v: PLAYER_COURSE_VERSION,
        island: p.island,
        sky: p.sky,
        vehicle: 'hoverjet',
        mode: 'ringAttack',
        path: p.anchor
          ? { points: [...p.points], gap: p.gap, anchor: p.anchor }
          : { points: [...p.points], gap: p.gap },
        rings: [...p.rings],
        start: p.start,
        finish: { t: p.finish },
        timeLimit: p.timeLimit,
        name: [p.name[0], p.name[1]],
        ...(p.light ? { light: p.light } : {}),
        ...(p.ground ? { ground: p.ground } : {}),
        ...(p.water ? { water: p.water } : {}),
        ...(p.props.length > 0 ? { props: [...p.props] } : {}),
      }

/**
 * The id a v1 course had, or null when `input` is not one. DEV-475.
 *
 * **v2 changes every id.** The id is a hash of the canonical bytes, v2's bytes
 * are not v1's (the version, and the start), so a migrated course has a NEW
 * id — the only honest answer, since two builds must agree on what a course's
 * id is, and a v2 course whose id were its v1 hash would be a course with two
 * ids. What keeps its place: the library entry, which `course-library.ts`
 * reads back under the v1 id this gives and writes again under the new one.
 * What does not: a local best and a ghost, kept by id (`ghost-store.ts`,
 * `personal-best.ts`), stay under the v1 id — they were flown from a flying
 * start with three racers, and v2's lap begins at GO from a pad with five.
 */
export const legacyPlayerCourseId = (input: unknown): string | null => {
  if (!isRecord(input) || input.v !== 1) return null
  const issues = new Issues()
  let parsed: Parsed | null = null
  try {
    parsed = parseCourse(input, issues)
  } catch {
    return null
  }
  if (!parsed || issues.any || !isV1Start(parsed.start)) return null
  // DEV-466's canonical v1 bytes, key for key.
  const canonical = JSON.stringify({
    v: 1,
    island: parsed.island,
    sky: parsed.sky,
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    path: { points: parsed.points, gap: parsed.gap },
    rings: parsed.rings.map((r) => ({ t: r.t, skip: r.skip })),
    start: { t: parsed.start.t },
    finish: { t: parsed.finish },
    timeLimit: parsed.timeLimit,
    name: parsed.name,
  })
  return `pc_${hexOf(canonical)}`
}

// ── The play area ─────────────────────────────────────────────────────────

/** Where a course may go: the donor's boundary, or its island's terrain. THREE space. */
export type PlayerCourseArea =
  | { readonly kind: 'sphere'; readonly centre: Vec3Tuple; readonly radius: number }
  | { readonly kind: 'box'; readonly min: Vec3Tuple; readonly max: Vec3Tuple }

interface SheetTerrain {
  readonly terrainSize: number
  readonly terrainHeight: number
  readonly transform?: {
    readonly position: readonly number[]
    readonly envRoot?: readonly number[]
    readonly scale: readonly number[]
  }
}

/**
 * The island's land terrain as a THREE-space box, from the generated sheet.
 *
 * The same composition `game/terrain/load-terrain.ts` places the terrain group
 * with — the level's `worldOffset`, plus the terrain's local position and its
 * `envRoot` (DEV-042: kauai's LevelArt root is not at the offset), the mesh
 * running 0..`terrainSize` from that corner and mirrored in z into three — and
 * "the land is the terrain that is not the ocean", as `environmentTerrains`
 * reads it. Written out here because `load-terrain.ts` imports the renderer;
 * the test checks the corners against the scene flattener's measured world
 * positions (`terrain-env-root.test.ts`'s oracle), not against this sum.
 */
export const islandExtent = (
  environment: string,
  worldOffset: readonly number[],
): { min: Vec3Tuple; max: Vec3Tuple } | null => {
  const env = (TERRAIN as unknown as Record<string, { terrains?: Record<string, SheetTerrain> }>)[
    environment
  ]
  const names = Object.keys(env?.terrains ?? {})
  const land = names.find((n) => n !== 'ocean')
  const t = land ? env?.terrains?.[land] : undefined
  if (!t) return null
  const pos = t.transform?.position ?? [0, 0, 0]
  const root = t.transform?.envRoot ?? [0, 0, 0]
  const scale = t.transform?.scale ?? [1, 1, 1]
  // Unity-space corner: worldOffset is THREE, so its z flips back.
  const cx = (worldOffset[0] as number) + (pos[0] as number) + (root[0] as number)
  const cy = (worldOffset[1] as number) + (pos[1] as number) + (root[1] as number)
  const cz = -(worldOffset[2] as number) + (pos[2] as number) + (root[2] as number)
  const sx = t.terrainSize * (scale[0] as number)
  const sz = t.terrainSize * (scale[2] as number)
  const top = t.terrainHeight * (scale[1] as number)
  return {
    min: [cx, cy, -(cz + sz)],
    max: [cx + sx, cy + top, -cz],
  }
}

/**
 * DEV-504: the landmark frame a course's placed props are written into
 * (`prop-library.ts`'s `PropFrame`): Unity space, composed to the island's
 * LevelArt root, the frame `PropLandmark.position` is in.
 *
 * `load-props.ts` draws a landmark at `landmark − terrainLocal` (z flipped)
 * under the terrain GROUP, and `load-terrain.ts` stands that group at
 * `worldOffset + terrainLocal + envRoot`, mirrored in z; on a course's own
 * island the group is centred on the donor's land by `customTerrainLocal`,
 * which adds half the difference of the two sides to x and z. The terrain's
 * local position cancels, and what is left is the level's `worldOffset`, the
 * LevelArt root's `envRoot` (DEV-042: not zero on kauai) and that centring.
 * The corner is `islandExtent`'s, which `terrain-env-root.test.ts` holds to
 * the scene flattener; `player-course-props.test.ts` holds this frame to the
 * renderer's own `landmarkMatrixOf` under that corner.
 */
export const propFrameOf = (c: PlayerCourse, donor: Level): PropFrame => {
  const land = landOf(donor.environment)
  const root = land?.transform?.envRoot ?? [0, 0, 0]
  const shift = c.ground && land ? (land.terrainSize - groundExtent(c.ground).size) / 2 : 0
  const wo = donor.worldOffset
  return {
    x0: (wo[0] as number) + (root[0] as number) + shift,
    y0: (wo[1] as number) + (root[1] as number),
    z0: (wo[2] as number) - (root[2] as number) - shift,
  }
}

/** DEV-504: a course's placed props as the landmarks `level.props` holds. */
export const playerCourseProps = (c: PlayerCourse, donor: Level): Level['props'] => {
  const frame = propFrameOf(c, donor)
  const out: Level['props'] = []
  ;(c.props ?? []).forEach((p, i) => {
    const entry = propEntry(p.kind)
    if (entry) out.push(placedLandmark(p, entry, frame, i))
  })
  return out
}

/**
 * The volume a course must stay inside. The donor's boundary where it kills
 * (a trigger volume, so leaving it starts the countdown); where the boundary is
 * DISABLED — six shipped missions have none — the island's terrain extent,
 * from the terrain's own base up to `airAboveTerrainMetres` over its top.
 */
export const playerCourseArea = (donor: Level): PlayerCourseArea | null => {
  const b = donor.boundary
  const volume = b?.volume
  if (b?.enabled && volume) {
    if (volume.shape === 'sphere' && typeof volume.radius === 'number') {
      return { kind: 'sphere', centre: [...volume.centre] as Vec3Tuple, radius: volume.radius }
    }
    if (volume.shape === 'box' && volume.half) {
      const c = volume.centre
      const h = volume.half
      return {
        kind: 'box',
        min: [c[0] - (h[0] as number), c[1] - (h[1] as number), c[2] - (h[2] as number)],
        max: [c[0] + (h[0] as number), c[1] + (h[1] as number), c[2] + (h[2] as number)],
      }
    }
  }
  const extent = islandExtent(donor.environment, donor.worldOffset)
  if (!extent) return null
  return {
    kind: 'box',
    min: extent.min,
    max: [extent.max[0], extent.max[1] + PLAYER_COURSE_LIMITS.airAboveTerrainMetres, extent.max[2]],
  }
}

/** Is `p` inside `area`? */
export const insideArea = (area: PlayerCourseArea, p: Vec3): boolean => {
  if (area.kind === 'sphere') {
    const dx = p.x - area.centre[0]
    const dy = p.y - area.centre[1]
    const dz = p.z - area.centre[2]
    return dx * dx + dy * dy + dz * dz <= area.radius * area.radius
  }
  return (
    p.x >= area.min[0] &&
    p.x <= area.max[0] &&
    p.y >= area.min[1] &&
    p.y <= area.max[1] &&
    p.z >= area.min[2] &&
    p.z <= area.max[2]
  )
}

// ── The course's geometry, shared by validation and expansion ─────────────

const vec = (p: readonly number[]): Vec3 => v3(p[0] as number, p[1] as number, p[2] as number)
const tuple = (p: Vec3): Vec3Tuple => [p.x, p.y, p.z]

/** The course's curve, measured. */
export const playerCourseSpline = (c: PlayerCourse): CourseSpline =>
  buildCourseSpline(c.path.points.map(vec), {
    divisionsPerSegment: PLAYER_COURSE_SHAPE.divisionsPerSegment,
    tension: PLAYER_COURSE_SHAPE.tension,
    // DEV-501: an anchored line leaves its first point along the pad's heading,
    // so the first ring stands square to the pad and the run-in is one straight.
    ...(c.path.anchor ? { startTangent: yawForward(c.start.yaw) } : {}),
  })

/** What a course copies off its donor: the first live ring, and the finish if it is a gate. */
interface Templates {
  readonly ring: Ring
  readonly finish: FinishGateSphereUnion | null
}

const templatesOf = (donor: Level): Templates | null => {
  const ring = liveRings(donor)[0]
  if (!ring) return null
  const finish = donor.finish?.shape === 'sphereUnion' ? donor.finish : null
  return { ring, finish }
}

/** One placed ring: its arc distance, and its path parameter. */
interface Placement {
  readonly s: number
  readonly t: number
  readonly skipped: boolean
}

/**
 * Where the rings go, before and after skips.
 *
 * One `gap` past the line's FIRST POINT (v2: the pad is off the line, and
 * dragging it moves no ring), then every `gap`, up to the finish's APRON: a ring
 * stops `ring trigger radius + finish radius` of path short of the finish, so
 * its trigger can never sit inside the gate that ends the run (entering that
 * ends it, and the ring would be uncollectable). Both radii are the donor's.
 * With no finish gate the run ends on the last ring, and the rings run to the
 * finish point.
 */
const placements = (c: PlayerCourse, spline: CourseSpline, t: Templates): Placement[] => {
  const L = spline.length
  if (!(L > 0)) return []
  const sFinish = c.finish.t * L
  const apron = t.ring.trigger.radius + (t.finish ? t.finish.radius : 0)
  const arcs = resampleByArcLength(0, sFinish - apron, c.path.gap)
  // DEV-501: an anchored line's first point is ITSELF one gap past the pad, so
  // its first ring stands there (a free line's first ring is one gap past it).
  if (c.path.anchor && sFinish - apron >= 0) arcs.unshift(0)
  const halfGap = c.path.gap / 2
  return arcs.map((s) => ({
    s,
    t: s / L,
    skipped: c.rings.some((r) => Math.abs(r.t * L - s) <= halfGap),
  }))
}

// ── Validation, with the donor ────────────────────────────────────────────

const checkAgainstDonor = (c: PlayerCourse, donor: Level, issues: Issues): void => {
  if (donor.id !== c.sky) {
    issues.add('sky', `names ${shown(c.sky)} but the donor given is ${shown(donor.id)}`)
    return
  }
  if (donor.vehicle !== c.vehicle) {
    issues.add(
      'sky',
      `${shown(c.sky)} is flown by the ${donor.vehicle}; a v1 course's sky must be a ${c.vehicle} mission`,
    )
  }
  if (donor.environment !== c.island) {
    issues.add(
      'island',
      `must be the base's island, ${shown(donor.environment)}, not ${shown(c.island)}`,
    )
  }
  const templates = templatesOf(donor)
  if (!templates) {
    issues.add('sky', `${shown(c.sky)} has no live ring to copy`)
    return
  }
  const area = playerCourseArea(donor)
  if (!area) {
    issues.add('island', `the sheet has no land terrain for ${shown(donor.environment)}`)
    return
  }
  const where = area.kind === 'sphere' ? "the base's boundary" : "the island's terrain"
  c.path.points.forEach((p, i) => {
    if (!insideArea(area, vec(p))) issues.add(`path.points[${i}]`, `is outside ${where}`)
  })
  // DEV-475: the pad stands inside it too, and the sky has a lift to copy.
  if (!insideArea(area, vec(c.start.pos)))
    issues.add('start.pos', `is outside ${where}`)
    // DEV-504: and so does every placed prop's pivot.
  ;(c.props ?? []).forEach((p, i) => {
    if (!insideArea(area, vec(p.pos))) issues.add(`props[${i}]`, `is outside ${where}`)
  })
  if (!donor.spawn.launch?.platform) {
    issues.add('sky', `${shown(c.sky)} has no launch pad to copy`)
  }
  const spline = playerCourseSpline(c)
  // The curve between the points can swing wider than the points do.
  if (!issues.any) {
    const outside = spline.samples.findIndex((p) => !insideArea(area, p))
    if (outside >= 0) {
      const t = qT((spline.arc[outside] as number) / spline.length)
      issues.add('path', `the curve leaves ${where} near t = ${t}`)
    }
  }
  const placed = placements(c, spline, templates)
  const kept = placed.filter((p) => !p.skipped).length
  const R = PLAYER_COURSE_LIMITS.rings
  if (placed.length > R.max) {
    issues.add('path.gap', `lays ${placed.length} rings; a course has at most ${R.max}`)
  }
  if (kept < R.min) {
    issues.add(
      'finish.t',
      `leaves ${kept} ring${kept === 1 ? '' : 's'} before the finish; a course needs at least ${R.min}`,
    )
  }
  const L = spline.length
  c.rings.forEach((r, i) => {
    if (!placed.some((p) => Math.abs(r.t * L - p.s) <= c.path.gap / 2)) {
      issues.add(`rings[${i}].t`, 'names no ring: none lies within half a gap of it')
    }
  })
}

/**
 * Validate a course. Never throws, whatever `input` is.
 *
 * Without `donor`, the structural half: every field's shape, type, bounds and
 * quanta. With `donor` — the level `sky` names, which `loadPlayerCourse`
 * loads — also everything that needs it: the island is the donor's, the donor
 * flies this vehicle and has a ring to copy, every point and the curve between
 * them stay inside the play area, and the ring count is within bounds.
 *
 * `course` on success is QUANTISED: its numbers are the canonical ones.
 */
export const validatePlayerCourse = (input: unknown, donor?: Level): PlayerCourseResult => {
  const issues = new Issues()
  let course: PlayerCourse | null = null
  try {
    const parsed = parseCourse(input, issues)
    course = parsed ? courseOf(parsed) : null
    if (course && donor) checkAgainstDonor(course, donor, issues)
  } catch (error) {
    // Nothing above should throw on any input; if something does, it is a
    // refusal rather than a crash, and it says so.
    issues.add('', `could not be read (${error instanceof Error ? error.name : typeof error})`)
  }
  if (issues.any || !course) {
    if (!issues.any) issues.add('', 'could not be read')
    return { ok: false, errors: issues.list }
  }
  return { ok: true, course }
}

// ── Expansion ─────────────────────────────────────────────────────────────

/**
 * A rotation that takes a "facing" frame to another: the local basis whose
 * −z is `facing` and whose +y is world up made perpendicular to it.
 *
 * −z is the facing axis of every shipped ring, measured, not assumed: on all
 * seven HoverJet missions each ring's −z lies within 4.5° of its route's
 * tangent, and its +y within 1.2° of up (`player-course.test.ts` asserts it
 * against 2016's data). The finish gate is the same `jumpGate_diamond` mesh at
 * three times the scale, and the test holds it to the same axis.
 */
const facingBasis = (facing: Vec3): Quat => {
  const f = facing
  // z axis = -facing; y axis = up with its facing part removed; x = y × z.
  const zx = -f.x
  const zy = -f.y
  const zz = -f.z
  let yx = -f.y * f.x
  let yy = 1 - f.y * f.y
  let yz = -f.y * f.z
  let yl = Math.sqrt(yx * yx + yy * yy + yz * yz)
  if (!(yl > 1e-6)) {
    // Straight up or down: any horizontal up will do, and +z is horizontal.
    yx = 0
    yy = 0
    yz = 1
    yl = 1
  }
  yx /= yl
  yy /= yl
  yz /= yl
  const xx = yy * zz - yz * zy
  const xy = yz * zx - yx * zz
  const xz = yx * zy - yy * zx
  return quatFromBasis(xx, xy, xz, yx, yy, yz, zx, zy, zz)
}

/** The quaternion of the rotation matrix with these COLUMNS (Shepperd's method). */
const quatFromBasis = (
  m00: number,
  m10: number,
  m20: number,
  m01: number,
  m11: number,
  m21: number,
  m02: number,
  m12: number,
  m22: number,
): Quat => {
  const trace = m00 + m11 + m22
  const out = quat()
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    out.w = 0.25 / s
    out.x = (m21 - m12) * s
    out.y = (m02 - m20) * s
    out.z = (m10 - m01) * s
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    out.w = (m21 - m12) / s
    out.x = 0.25 * s
    out.y = (m01 + m10) / s
    out.z = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    out.w = (m02 - m20) / s
    out.x = (m01 + m10) / s
    out.y = 0.25 * s
    out.z = (m12 + m21) / s
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
    out.w = (m10 - m01) / s
    out.x = (m02 + m20) / s
    out.y = (m12 + m21) / s
    out.z = 0.25 * s
  }
  return normalizeQ(out, out)
}

const qOf = (q: readonly number[]): Quat =>
  quat(q[0] as number, q[1] as number, q[2] as number, q[3] as number)
const qTuple = (q: Quat): QuatTuple => [q.x, q.y, q.z, q.w]

/** Local −z, rotated into the world: a ring's facing. */
export const ringFacing = (q: readonly number[]): Vec3 => rotateVec3(v3(), qOf(q), v3(0, 0, -1))

/**
 * The rigid motion that carries a template, facing `from` about `pivotFrom`,
 * to face `to` about `pivotTo`. Applied to a template's every pose, it keeps
 * the template's own shape — the trigger's offset from the ring, the finish's
 * frame and its forty studs — exactly as 2016 built it.
 */
export interface Motion {
  readonly delta: Quat
  readonly pivotFrom: Vec3
  readonly pivotTo: Vec3
}

const motion = (from: Vec3, pivotFrom: Vec3, to: Vec3, pivotTo: Vec3): Motion => {
  const a = facingBasis(from)
  const b = facingBasis(to)
  return { delta: normalizeQ(quat(), mul(quat(), b, conjugate(quat(), a))), pivotFrom, pivotTo }
}

/**
 * DEV-538: the same rigid motion, named by two whole POSES rather than two
 * facings: whatever turns `fromQuat` into `toQuat`, about `fromPos` carried to
 * `toPos`. A shipped-course override moves a 2016 ring, turn indicator or
 * finish by giving its new pose, so its roll is the author's and not
 * `facingBasis`'s "up stays up".
 */
export const poseMotion = (
  fromPos: readonly number[],
  fromQuat: readonly number[],
  toPos: readonly number[],
  toQuat: readonly number[],
): Motion => ({
  delta: normalizeQ(quat(), mul(quat(), qOf(toQuat), conjugate(quat(), qOf(fromQuat)))),
  pivotFrom: vec(fromPos),
  pivotTo: vec(toPos),
})

const movePos = (m: Motion, p: readonly number[]): Vec3Tuple => {
  const local = v3(
    (p[0] as number) - m.pivotFrom.x,
    (p[1] as number) - m.pivotFrom.y,
    (p[2] as number) - m.pivotFrom.z,
  )
  const r = rotateVec3(v3(), m.delta, local)
  return [m.pivotTo.x + r.x, m.pivotTo.y + r.y, m.pivotTo.z + r.z]
}

const moveQuat = (m: Motion, q: readonly number[]): QuatTuple =>
  qTuple(normalizeQ(quat(), mul(quat(), m.delta, qOf(q))))

/**
 * The spawn's yaw, degrees, for a direction of travel: 2016's convention,
 * where the ship's nose is its local −z turned by `(0, sin(yaw/2), 0,
 * cos(yaw/2))`. Checked against `int_01_hoverJet`'s own spawn, which faces its
 * first ring (`player-course.test.ts`).
 */
const yawAlong = (tangent: Vec3): number => (Math.atan2(-tangent.x, -tangent.z) * 180) / Math.PI

/** The rotation of a heading, three space: `(0, sin(yaw/2), 0, cos(yaw/2))`. */
const yawQuat = (yaw: number): QuatTuple => {
  const half = (yaw * Math.PI) / 360
  return [0, Math.sin(half), 0, Math.cos(half)]
}

/** The horizontal unit vector a heading points the nose along: local −z turned by `yaw`. */
export const yawForward = (yaw: number): Vec3 => {
  const r = (yaw * Math.PI) / 180
  return v3(-Math.sin(r), 0, -Math.cos(r))
}

// ── The start pad (DEV-475) ───────────────────────────────────────────────
//
// Matt's answer: *"a visible hover-pad marker dragged anywhere on the island
// and aimed; the ship starts on it and lifts off, the racers on slots beside
// it. No underground shaft."*
//
// ── The launch: the lift, already at the top ──────────────────────────────
//
// The closest launch the game has to "stands on a hover pad and lifts off" is
// its own: every shipped HoverJet mission holds the ship over the dish of the
// lift it rode (`render/start-grid.ts`, `releasePadOf`), counts 3-2-1 and lets
// go on GO (`sim/launch.ts`), and the racers leave on the same tick. `direct`,
// v1's, is a ship already flying in mid-air. So a player course's spawn is that
// launch with the ride taken out — a lift whose clip rises NOTHING and
// releases at once, and no shaft — and the rest is the game's own: the press,
// the countdown, the hold, the release, the racers held until GO, the clock
// from GO (D35: Anniversary's rules). `boot/app.ts`'s DEV-475 blocks keep the
// three things a SHAFT did from happening where there is none: the world
// hidden until the ride clears the ground, the launch room hung one rise
// under the ship, and a deck drawn only where 2016 authored slabs.
//
// Everything the pad is made of is the SKY's: the lift's platform (its size,
// and how far over its dish it holds a ship), and the two `ai` pads 2016 put
// beside the player on that mission's deck, carried across by the rigid motion
// that takes the sky's start to this one. So the grid round a player's pad is
// the grid 2016 built round its own — and the preset's slots (DEV-125's
// chevron) stand where they stand on every course, through `racerStarts`.
// A sky with no `ai` pads (the two rookie courses) races the slots alone.

/** Metres from a pad's foot up to the ship its lift holds: the sky's platform, `shipOffset` over `offset`. */
export const startStandUp = (donor: Level): number | null => {
  const platform = donor.spawn.launch?.platform
  if (!platform) return null
  return (platform.shipOffset[1] as number) - (platform.offset[1] as number)
}

/** One pad of a player course's start deck: `render/start-grid.ts`'s `StartGridPad`, as data. */
export interface PlayerCourseDeckPad {
  readonly role: 'player' | 'ai'
  readonly pos: Vec3Tuple
  readonly quat: QuatTuple
  readonly size: Vec3Tuple
}

/** The spawn a player course launches from: the SpawnPoint, with its deck. */
export interface PlayerCourseSpawn extends SpawnPoint {
  readonly startGrid: {
    readonly slabs: readonly never[]
    readonly lightBar: null
    readonly pads: readonly PlayerCourseDeckPad[]
  }
}

/**
 * The spawn for a start pad over `donor`: the ship held over the pad's dish,
 * facing `start.yaw`, on the lift-with-no-ride above, and the deck — the
 * player's pad and the sky's own `ai` pads moved beside it. Null where the sky
 * has no lift to copy (the validator refuses such a sky).
 */
export const playerCourseSpawn = (
  start: PlayerCourseStart,
  donor: Level,
): PlayerCourseSpawn | null => {
  const launch = donor.spawn.launch
  const platform = launch?.platform
  const standUp = startStandUp(donor)
  if (!launch || !platform || standUp === null) return null
  const foot = start.pos
  const quat = yawQuat(start.yaw)
  const pos: Vec3Tuple = [foot[0], foot[1] + standUp, foot[2]]

  // The sky's `ai` pads, in its own start's frame, carried to this one: the
  // same metres ahead and to the right, the same height over the release, the
  // same turn relative to the heading.
  const skyPos = donor.spawn.pos as number[]
  const skyRelease = v3(
    skyPos[0] as number,
    (skyPos[1] as number) + launch.rise,
    skyPos[2] as number,
  )
  const skyFacing = rotateVec3(v3(), qOf(donor.spawn.quat), v3(0, 0, -1))
  const skyYaw = yawAlong(v3(skyFacing.x, 0, skyFacing.z))
  const skyForward = yawForward(skyYaw)
  const forward = yawForward(start.yaw)
  // forward × up: the right hand, as `game/racer-grid.ts`'s `spawnFrame` has it.
  const rightOf = (f: Vec3): Vec3 => v3(-f.z, 0, f.x)
  const skyRight = rightOf(skyForward)
  const right = rightOf(forward)
  const turn = qOf(yawQuat(start.yaw - skyYaw))
  const grid = (donor.spawn as { startGrid?: { pads?: readonly Record<string, unknown>[] } })
    .startGrid
  const ai: PlayerCourseDeckPad[] = []
  for (const pad of grid?.pads ?? []) {
    if (pad.role !== 'ai') continue
    const p = pad.pos as number[]
    const dx = (p[0] as number) - skyRelease.x
    const dz = (p[2] as number) - skyRelease.z
    const ahead = dx * skyForward.x + dz * skyForward.z
    const across = dx * skyRight.x + dz * skyRight.z
    ai.push({
      role: 'ai',
      pos: [
        pos[0] + forward.x * ahead + right.x * across,
        pos[1] + ((p[1] as number) - skyRelease.y),
        pos[2] + forward.z * ahead + right.z * across,
      ],
      quat: moveQuat({ delta: turn, pivotFrom: v3(), pivotTo: v3() }, pad.quat as number[]),
      size: [...(pad.size as number[])] as Vec3Tuple,
    })
  }
  return {
    pos,
    quat,
    yaw: start.yaw,
    launchKind: 'elevator',
    launch: {
      clip: launch.clip,
      // A lift at the top: no rise at any time, released at once.
      keys: [{ time: 0, value: 0, inSlope: 0, outSlope: 0 }],
      rise: 0,
      duration: 0,
      settledAtSeconds: 0,
      releaseAtSeconds: 0,
      releaseInferred: false,
      platform: clone(platform),
      shaft: null,
    },
    startGrid: {
      slabs: [],
      lightBar: null,
      pads: [
        {
          role: 'player',
          pos: [foot[0], foot[1], foot[2]],
          quat,
          size: [...(platform.size as number[])] as Vec3Tuple,
        },
        ...ai,
      ],
    },
  }
}

/**
 * The medal curve on `rings` rings, carrying the donor's own bands.
 *
 * FF2's ring medals are SCORE thresholds (`medalsFf2`, DEV-393): bronze,
 * silver and gold are 2016's, a fraction of the ring ceiling each, and
 * platinum is every ring. So a player course keeps its donor's fractions,
 * rounded to whole rings (an incomplete run scores rings alone), and platinum
 * is its own ceiling. On the donor's own ring count this gives back the
 * donor's own curve, exactly, on all seven HoverJet missions — the test's
 * outside check. No medal number is typed.
 */
export const playerCourseMedals = (donor: Level, rings: number, perRing: number): Medals => {
  const curve = donor.medalsFf2 ?? donor.medals
  const ceiling = maxRingScore(donor)
  const band = (value: number, floor: number): number =>
    Math.min(rings, Math.max(floor, Math.round((value / ceiling) * rings)))
  const bronze = band(curve.bronze, 1)
  const silver = band(curve.silver, bronze)
  const gold = band(curve.gold, silver)
  return {
    bronze: bronze * perRing,
    silver: silver * perRing,
    gold: gold * perRing,
    platinum: rings * perRing,
  }
}

const clone = <T>(v: T): T => structuredClone(v)

/** 2016's clone naming, `0000Checkpoint_Ring(Clone)`, with a player course's tag. */
const ringName = (i: number): string => `${String(i).padStart(4, '0')}Checkpoint_Ring(Player)`

/**
 * Ring `i`: the donor's ring `template`, moved to stand at `pos` facing along
 * `tangent` — its trigger's offset from the ring, and its facing, kept exactly
 * as 2016 built them. Every ring a course expands to is placed by this.
 */
const placeRing = (template: Ring, i: number, pos: Vec3, tangent: Vec3): Ring => {
  const m = motion(ringFacing(template.quat), vec(template.pos), tangent, pos)
  return {
    i,
    order: i,
    name: ringName(i),
    pos: tuple(pos),
    quat: moveQuat(m, template.quat),
    scale: [...template.scale] as Vec3Tuple,
    trigger: moveTrigger(m, template.trigger),
    scoring: { ...template.scoring },
  }
}

/** A ring's trigger carried by `m`: its offset from the ring and its spheres, as 2016 built them. */
const moveTrigger = (m: Motion, trigger: Ring['trigger']): Ring['trigger'] => ({
  pos: movePos(m, trigger.pos),
  quat: moveQuat(m, trigger.quat),
  radius: trigger.radius,
  spheres: trigger.spheres.map((s) => ({
    radius: s.radius,
    center: [...s.center] as Vec3Tuple,
  })),
})

/**
 * DEV-538: `ring` carried rigidly by `m` — the ring, its trigger and its
 * facing together, everything else about it (its name, scoring, provenance)
 * kept. `placeRing`'s motion applied to a ring that is already placed.
 */
export const moveRingRigid = <R extends Ring>(ring: R, m: Motion): R => ({
  ...ring,
  pos: movePos(m, ring.pos),
  quat: moveQuat(m, ring.quat),
  trigger: moveTrigger(m, ring.trigger),
})

/**
 * DEV-541: the pose `placeRing` gives `ring` standing at `pos` and facing
 * along `tangent` — its own facing turned onto the tangent, up kept up
 * (`facingBasis`). The shipped desk's "Snap ring to line" places a 2016 ring
 * with it, so a snapped ring stands on the line exactly as every ring of a
 * player course does (plan/SHIPPED-COURSE-EDITS.md §4.4: "DEV-466's
 * `placeRing` again"). `moveRingRigid` then carries its trigger.
 */
export const ringPoseAlong = (
  ring: Pick<Ring, 'pos' | 'quat'>,
  pos: readonly number[],
  tangent: readonly number[],
): { pos: Vec3Tuple; quat: QuatTuple } => {
  const at = vec(pos)
  // `facingBasis` reads a UNIT facing (its up is `1 - f.y²`).
  const t = vec(tangent)
  const n = Math.hypot(t.x, t.y, t.z) || 1
  const m = motion(ringFacing(ring.quat), vec(ring.pos), v3(t.x / n, t.y / n, t.z / n), at)
  return { pos: tuple(at), quat: moveQuat(m, ring.quat) }
}

/**
 * DEV-501 follow-up: the ring an anchored course's pad holds — its ring 1,
 * exactly as `expandPlayerCourse` places it (the expansion calls this for
 * it): the donor's ring on the anchored point of the GRIDDED pad, gap and
 * height, facing the pad's heading (the line's `startTangent`). Its trigger
 * sphere is the template's, carried along, so it stands off the point by the
 * template's own offset. Null for a free course or a donor with no ring.
 *
 * Needs no second point: the editor's heading search (`anchorHeading`) judges
 * a new draft's ring 1 with it before the line exists.
 */
export const anchoredRing = (c: PlayerCourse, donor: Level): Ring | null => {
  const a = c.path.anchor
  const template = liveRings(donor)[0]
  if (!a || !template) return null
  const start = qStart(c.start)
  const p = anchorPoint(start, qGap(c.path.gap), qAnchor(a))
  return placeRing(template, 0, vec(p), yawForward(start.yaw))
}

const expandFinish = (template: FinishGateSphereUnion, pos: Vec3, tangent: Vec3): FinishGate => {
  // The gate's facing: its art frame's −z (the ring's mesh, three times the
  // size), or the trigger's +z where there is no art (the two agree on all
  // seven shipped finishes).
  const facing = template.art
    ? ringFacing(template.art.frame.quat)
    : rotateVec3(v3(), qOf(template.quat), v3(0, 0, 1))
  return moveFinishRigid(template, motion(facing, vec(template.pos), tangent, pos))
}

/**
 * DEV-538: a sphere-union finish carried rigidly by `m` — the trigger, its
 * frame and its forty studs together. `expandFinish` is this with the motion
 * that stands the template on a player course's line.
 */
export const moveFinishRigid = (template: FinishGateSphereUnion, m: Motion): FinishGate => {
  const gate: FinishGateSphereUnion = {
    shape: 'sphereUnion',
    pos: movePos(m, template.pos),
    quat: moveQuat(m, template.quat),
    radius: template.radius,
    spheres: template.spheres.map((s) => ({
      radius: s.radius,
      center: [...s.center] as Vec3Tuple,
    })),
  }
  if (template.art) {
    const art = template.art
    return {
      ...gate,
      art: {
        frame: {
          mesh: art.frame.mesh,
          material: art.frame.material,
          pos: movePos(m, art.frame.pos),
          quat: moveQuat(m, art.frame.quat),
          scale: [...art.frame.scale] as Vec3Tuple,
        },
        studMaterial: art.studMaterial,
        studs: art.studs.map((s) => ({
          pos: movePos(m, s.pos),
          quat: moveQuat(m, s.quat),
          scale: [...s.scale] as Vec3Tuple,
        })),
      },
    }
  }
  return gate
}

/**
 * Turn a course into a level, against its donor. Pure and synchronous: the
 * same course and donor give the same level, byte for byte.
 *
 * Throws `PlayerCourseError` when the course does not validate against this
 * donor — the only way a course becomes a level is through the validator.
 */
export const expandPlayerCourse = (input: PlayerCourse, donor: Level): Level => {
  const checked = validatePlayerCourse(input, donor)
  if (!checked.ok) throw new PlayerCourseError(checked.errors)
  const c = checked.course
  const templates = templatesOf(donor) as Templates
  const spline = playerCourseSpline(c)
  const L = spline.length
  const id = playerCourseId(c)

  // ── Rings: the template, moved to each placement ────────────────────────
  // DEV-501 follow-up: an anchored line's ring at its first point is
  // `anchoredRing`'s — the one the editor's heading search judges — so the two
  // cannot disagree about where it stands or which way it faces.
  const template = templates.ring
  const rings: Ring[] = []
  const onPad = c.path.anchor ? anchoredRing(c, donor) : null
  for (const p of placements(c, spline, templates)) {
    if (p.skipped) continue
    const i = rings.length
    rings.push(
      onPad && p.s === 0
        ? { ...onPad, i, order: i, name: ringName(i) }
        : placeRing(template, i, splinePointAt(spline, p.s), splineTangentAt(spline, p.s)),
    )
  }

  // ── Start, finish and the racing line ───────────────────────────────────
  const sFinish = c.finish.t * L
  // DEV-475: the ship on its pad, held there until GO (`playerCourseSpawn`).
  const spawn = playerCourseSpawn(c.start, donor) as SpawnPoint
  const release = vec(spawn.pos)
  const pose: SpawnPoint = { pos: [...spawn.pos], quat: [...spawn.quat], yaw: spawn.yaw }
  const finish = templates.finish
    ? expandFinish(
        templates.finish,
        splinePointAt(spline, sFinish),
        splineTangentAt(spline, sFinish),
      )
    : null
  // From the ship on the pad to the line's first point, then along the line to
  // its END, past the finish when there is curve beyond it — as 2016's own
  // routes run on past their finish gates, so a racer flies through the gate
  // rather than stopping at its centre.
  const route: Vec3Tuple[] = [tuple(release)]
  const first = splinePointAt(spline, 0)
  if (
    Math.hypot(first.x - release.x, first.y - release.y, first.z - release.z) >
    PLAYER_COURSE_SHAPE.pointQuantumMetres
  ) {
    route.push(tuple(first))
  }
  const steps = resampleByArcLength(0, L, PLAYER_COURSE_SHAPE.routeSpacingMetres)
  for (const s of steps) route.push(tuple(splinePointAt(spline, s)))
  // And the curve's own end, unless the last step already landed on it.
  if ((steps[steps.length - 1] ?? 0) < L) route.push(tuple(splinePointAt(spline, L)))

  const perRing = template.scoring.addScore * donor.scoring.gateMultiplier
  const medals = playerCourseMedals(donor, rings.length, perRing)

  return {
    id,
    title: `${c.name[0]} ${c.name[1]}`,
    vehicle: c.vehicle,
    environment: donor.environment,
    environmentScene: donor.environmentScene,
    // A player course is on no rank page; it wears its sky's, which only the
    // level select reads and which never lists it (`listed` is absent).
    difficulty: donor.difficulty,
    difficultySource: donor.difficultySource,
    chainIndex: null,
    mode: c.mode,
    forcedMode: null,
    forcedModeFf2: null,
    worldOffset: clone(donor.worldOffset),
    spawn,
    respawn: clone(pose),
    routes: [{ id: PLAYER_COURSE_GENERATOR, rings }],
    finish,
    orbs: [],
    pads: [],
    turnIndicators: [],
    clouds: clone(donor.clouds),
    // DEV-504: the author's props, as landmarks. The sky's own mission props
    // stay the sky's: a course is its own scenery, as its rings are.
    props: playerCourseProps(c, donor),
    ui: clone(donor.ui),
    timer: {
      timeLimit: c.timeLimit,
      // Par for the time bonus is the time limit: it is on every shipped
      // HoverJet mission (180/180, and rookie_01's 120/120).
      bonusParTime: c.timeLimit,
      shadowedParTime: donor.timer.shadowedParTime,
      countdown: clone(donor.timer.countdown ?? null),
    },
    medals: { ...medals },
    medalsFf2: { ...medals },
    scoring: clone(donor.scoring),
    boundary: clone(donor.boundary),
    fog: clone(donor.fog),
    // DEV-476: the course's sun, inside the sky's band, and nothing else of
    // the light. Absent, the donor's lighting exactly as it was.
    lighting: c.light
      ? { ...clone(donor.lighting), sun: clone(playerCourseSun(donor, c.light)) }
      : clone(donor.lighting),
    ghosts: [],
    ambientTraffic: null,
    generated: {
      generator: PLAYER_COURSE_GENERATOR,
      // The id's own 48 bits, as the integer the schema asks for.
      seed: Number.parseInt(id.slice('pc_'.length), 16),
    },
    // NOT LISTED, by absence: `listed` is an authored file's opt-in and absent
    // means no (`Level.listed`), and `content/levels/_schema.json`, which a
    // player course is held to, has no such key.
    route,
  }
}
