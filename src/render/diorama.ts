// src/render/diorama.ts — the level, in miniature, on the table.
//
// Matt, 2026-09-11: *"levels were presented as mini-dioramas of the actual
// level, with tiny jets flying around em."*
//
// 2016: `MissionSelector.cs:17-23` instantiates `levelSelArt_prefab` at **0.5
// scale** onto `levelArt_spawnPos`, and the table also carries
// `animatedObjects`: an `npc_aiShip` walking a Curvy spline, checkpoint rings,
// and `Projector04-Faceted` glow projectors. A holotable is not a label with a
// picture on it; it is the course, running.
//
// ── What 2016's miniature WAS, which is not the level's own art (DEV-576) ──
//
// This header said 2016 instantiated "the level's own art prefab". It did not.
// `levelSelArt_prefab` is one of three purpose-built `art_levelSel_*.prefab`
// miniatures, each its own `FacetedTerrain` over its OWN maps, made in World
// Machine in December 2016: `forest_levelSel_*` (alpine) and
// `mesaCanyon_levelSel_*` (desert) are the level's map re-run and cut to a
// dome-topped block with cliff walls, and the Simonet table's
// `islands_02_height.png` is a DIFFERENT archipelago (island_group_02), not
// the islands the missions fly. So this file is not 2016's miniature: it is
// the level's own field, read live, which is what Matt asked for and what a
// fifth environment gets for free. The full comparison (map, crop, relief,
// sea, size, heading) and the calls it left for Matt are DEV-576's row.
//
// ── A table's island is a solid, in its own colours (DEV-579) ────────────
//
// Matt, 2026-10-03: *"use the real colors for the menu dioramas"*, and *"the
// edge just stops and we can see under the diorama, making it look
// wafer-thin."* So the colour map shows as its own byte under a baked relief
// light, the sea stands at the ocean's own surface, and a table's island has a
// {@link DioramaBody}: its outline snapped to a circle and a faceted wall down
// to a foot on the table. All of it vertex colour in the island's one mesh and
// one program. DEV-579's row has the frames and the numbers.
//
// ── Why this is the real terrain and not a prop ──────────────────────────
//
// We generate each environment from its 2016 heightmap, and `terrainHeightAt`
// samples exactly the surface the player will fly over. So the diorama is the
// same island, read off the same field, at roughly 1:8000 — and it cannot drift
// from the level, because there is nothing to keep in sync. The jets fly the
// mission's own racing line.
//
// That also means it costs nothing to author: a fourteenth mission gets a
// diorama by existing, which is rule 6 (content is data) applied to the menu.
// `game/mission-shape.ts` is what feeds this for a mission that is not running,
// and the level select draws four of them at once.
//
// ── A level table shows the LAND, and nothing marked on it (DEV-354) ──────
//
// Matt, 2026-09-24: *"level select - show terrain diorama, no gates. (this was
// a previous misunderstanding i think on both our counts)"*. And of the step
// before it: *"mode select - this should be a single rotating ring/gate for
// ring attack, a single jump pad for target practice. a single orb for free
// flight."*
//
// This file used to draw the mission's objective on its island — 2016's own
// gate frames standing along the course, its red-and-white targets, its orbs
// (DEV-326, DEV-327) — and since DEV-313 a Ring Attack table dropped the island
// altogether and was a circuit of gates. That was the MODE, said on the step
// that chooses a PLACE. The mode now has its own step and its own picture
// (`render/mode-mark.ts`: one mark, large, turning), so this file is back to
// what its first line says: the level, in miniature. The island, and the tiny
// jets.
//
// **The jets stay**, and so does DEV-313's #41c: a table whose mission is about
// its pads flies a JumpSeat lobbing pad to pad ({@link padHopPath}), because
// five of the six Target Practice missions have no racing line and their tables
// would otherwise have nothing moving on them. The pads are the craft's PATH
// now and are never drawn: the targets are not on the table, and the craft
// still comes down on their landing centres. `game/mission-shape.ts`'s
// `missionTour` decides which missions those are, off the mode's own `scores`.
//
// What left with the marks, and why none of it is kept dormant: the gates, pads
// and orbs themselves; `gateArt`/`orbArt` and their late setters; `courseAxes`
// (DEV-275's facing along the course — a lone turning gate has no course to
// face); and `tableCourse` with `CIRCUIT_HIDES_TERRAIN`, the one-line switch
// DEV-313 built for taking #41a back. It was taken back by removing its input
// rather than by flipping it: with no gates handed in, the switch had nothing
// left to read. `gateMarkGeometry` and `orbMarkGeometry` moved to
// `render/mode-mark.ts`, the one thing that still draws them.

import * as THREE from 'three'
import { facetHash01 } from '@/sim/math/scalar'
import type { HeightField } from '@/sim/terrain/height-field'
import { terrainHeightAt } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import { disposeTree } from './scene-walk'

/**
 * The port's tell that the island is a PROJECTION (DEV-140). Content:
 * `menu.holoTerrainColours` in the edition preset; the shape is the schema's.
 * Every number 0 and brightness 1 is 2016's plain miniature.
 */
export interface HoloLook {
  readonly brightness: number
  readonly holoMix: number
  readonly rim: number
  readonly scanline: number
}

export interface DioramaOptions {
  readonly field: HeightField
  /**
   * The environment's colour map, thumbnailed (`content/holo-palette.ts`), or
   * null for the old holo-cyan ramp. Sampled once per CELL at its centre, the
   * way the terrain generator samples its colour map once per face — one
   * colour a face, 2016's own rule (DEV-014). Shown as the map's own byte,
   * shaded by a baked relief light (DEV-579): 2016's miniature was a lit,
   * vertex-painted, full-colour terrain (of its own maps, DEV-576).
   */
  readonly palette?: MapSampler | null
  /** How much of a hologram to make it. Null or all-zero is a plain model. */
  readonly holo?: HoloLook | null
  /** The authored racing line, THREE-space triples as the level stores them. */
  readonly route: readonly (readonly number[])[] | null
  /** How wide the model is, in metres. Sized to the table it sits on. */
  readonly size: number
  /**
   * Jump-pad landing centres, THREE space: the TOUR the craft lobs along, pad
   * to pad, in place of the route ({@link padHopPath}, DEV-313 #41c). Handed
   * over only where the pads are the mission's objective
   * (`game/mission-shape.ts`'s `missionTour`). **Not drawn** since DEV-354: a
   * level table shows the land and nothing marked on it.
   */
  readonly pads?: readonly (readonly number[])[]
  /**
   * Multiplier on the CRAFT, leaving the island alone. It was `markScale` and
   * reached the rings, the plates and the orbs as well; the craft is the one
   * mark a level table still carries (DEV-354).
   *
   * Default 1, which is the single 0.62 m holotable this file was written for.
   * The level select's tables are 0.50 m and further from the eye, and at that
   * size a craft drawn to the old proportion is **4 pixels** across on a Quest 3
   * — which is the title jets all over again (orientation lesson §5c: *a thing
   * that is too small has not been reviewed, it has been rendered*). A craft is
   * a symbol, not a scale model, so it is allowed to be out of scale; the
   * island underneath is not.
   */
  readonly craftScale?: number
  /**
   * DEV-420: DRAW the route, as a line on the island in this colour, as well as
   * flying the craft along it. Null or absent draws nothing, which is every
   * level table since DEV-354 except a place that carries its difficulty (Matt,
   * 2026-09-26: *"the changing difficulty should change which path is drawn on
   * the terrain"*). See {@link routeLine}.
   */
  readonly routeColour?: number | null
  /**
   * DEV-492: cells across the model. Default {@link DEFAULT_GRID}, sized for a 0.5 m
   * table; the bench's two-metre island asks for more, so a facet stays about
   * a centimetre.
   */
  readonly grid?: number
  /**
   * DEV-492: vertical exaggeration. Default {@link DEFAULT_RELIEF}. The bench asks
   * for 1, so a point's height over the island reads true.
   */
  readonly relief?: number
  /**
   * DEV-579: the waterline, SIM y: the sea's surface over the island
   * (`game/mission-shape.ts`'s `missionSeaLevel`). Everything at or under it
   * is sea, flat, in {@link SEA_TINT}, and it is the model's origin. Null or
   * absent is the land field's own origin, which is the waterline only where
   * there is no water: on Simonet it is 198 m under the sea, and the table drew
   * the seabed as land.
   */
  readonly seaLevel?: number | null
  /**
   * DEV-579: give the disc a BODY, so its edge is not a paper-thin cut with the
   * table showing under it. Null or absent is the bare surface (the editor's
   * bench and island dialog). See {@link DioramaBody}.
   */
  readonly body?: DioramaBody | null
}

/**
 * DEV-579: the solid under a table's island. Matt, 2026-10-03: *"something i
 * really don't like about the current dioramas is how the edge just stops and
 * we can see under the diorama, making it look wafer-thin."*
 *
 * A faceted wall from the island's own rim, which is snapped to a true circle
 * so the wall is a drum and not a staircase, straight down `lip` metres, then
 * leaning in to a foot of radius `foot` at `depth` metres under the waterline,
 * closed by a flat underside. All in the model's own metres (the island is
 * `size` across). Every face is part of the island's ONE mesh in the island's
 * ONE material, so a body costs no draw and no program; its colour is baked
 * like the land's ({@link bodyEarth}, {@link BODY_ROWS}).
 */
export interface DioramaBody {
  /** The foot's depth under the waterline, metres. */
  readonly depth: number
  /** The straight wall under the rim before the lean begins, metres. */
  readonly lip: number
  /** The foot's radius, metres. The disc's own radius is a straight drum. */
  readonly foot: number
  /**
   * Ease the land down toward the model's origin near the rim, so the wall
   * comes out low and the body reads as a plinth (DEV-579 follow-up). Null or
   * absent leaves the land as the field has it. See {@link DioramaEase}.
   */
  readonly ease?: DioramaEase | null
  /**
   * DEV-627: on a table with a sea (`seaLevel` given), how much of the radius,
   * from the rim inward, is open sea: the land is drawn inside `1 - seaRing`
   * of the radius, its ease (if any) running all the way down to the
   * waterline at that circle, and everything outside it is water. So no land
   * reaches the rim and every edge of the wall is the water's section. Matt,
   * 2026-10-04: *"scale the oceans up just a bit since the terrain pokes out of
   * the sides of the ocean"*. Ignored where there is no sea. Null or absent: 0.
   */
  readonly seaRing?: number | null
}

/**
 * DEV-579 follow-up. Matt, 2026-10-03, on the walls of alpine's and the
 * canyon's tables where their mountains run to the edge: *"yes, ease the
 * alpine and canyon edges plz"*.
 *
 * Over the outer `band` of the disc's radius, every height above the model's
 * origin is scaled down by a smoothstep toward `keep` of itself at the rim:
 * `h' = base + (h - base) * (1 - s * (1 - keep))`, `s` rising 0 to 1 across
 * the band. So the land leans down to the rim the way a relief model's does,
 * the wall under it is short, and nothing moves inside the band. A height at
 * or under the origin (the sea) is untouched, and so is a land height's sign:
 * eased land never sinks under the waterline, it flattens toward it.
 */
export interface DioramaEase {
  /** How much of the radius, from the rim inward, is eased: 0..1. */
  readonly band: number
  /** What fraction of its height over the origin the land keeps AT the rim: 0..1. */
  readonly keep: number
}

/** DEV-579 follow-up: the smoothstep `s` of {@link DioramaEase} at radius fraction `t`. */
export const easeAt = (ease: DioramaEase, t: number): number => {
  const band = Math.min(1, Math.max(1e-6, ease.band))
  const x = Math.min(1, Math.max(0, (t - (1 - band)) / band))
  return x * x * (3 - 2 * x)
}

/**
 * DEV-579: how dark each band of the body is, as a fraction of its earth
 * colour before the relief shade: the cut under the rim, the two leaning
 * bands, and the underside. Darkening toward the bottom is what makes it read
 * as a solid lit from above rather than as a painted band; 2016's level-select
 * blocks had cliff walls to a flat base (DEV-576), and its earlier podiums
 * were rock (DEV-577). **The numbers to argue with.**
 */
export const BODY_ROWS = { cut: 0.95, upper: 0.62, lower: 0.42, underside: 0.25 } as const
/** The water's section where the rim is sea: the sea tint, this much darker. */
export const BODY_WATER = 0.78

/**
 * DEV-492: how the model maps THREE space onto its own local frame, as it
 * built the island: `local = ((x - centreX) * scale, (y - seaY) * scale *
 * relief, (z - centreZ) * scale)` for a THREE-space `(x, y, z)`. The numbers
 * the island was built with, handed out, so a reader (the bench) cannot
 * restate them and drift.
 */
export interface DioramaFrame {
  readonly centreX: number
  readonly centreZ: number
  readonly seaY: number
  readonly scale: number
  readonly relief: number
}

/** The drawn route's name, for anything reading the scene from outside. */
export const ROUTE_LINE_NAME = 'diorama-route'

/**
 * How thick the drawn route is, in metres at the table: the coloured core and
 * the white casing round it. **These are the numbers to argue with.**
 *
 * 4 mm across at 1.5 m is 0.15 degrees, about three pixels a side on a flat
 * 1600-wide frame and on a headset's ~20 px a degree: the smallest line that
 * reads as a line rather than a scratch (orientation lesson §5c, *too small
 * has not been reviewed*). The casing is the ski map's own trick for a line
 * that has to read on any ground: a black run is drawn on white snow, and this
 * island is pale land on dark sea, so every colour gets a white edge.
 */
export const ROUTE_CORE_RADIUS = 0.002
export const ROUTE_CASING_RADIUS = 0.0034

/** The most samples a drawn route keeps. A 661-point racing line at 1:8000 is sub-pixel between points. */
const ROUTE_SAMPLES = 180
const ROUTE_CASING_COLOUR = 0xf4f6f8

/**
 * The route, drawn: a thin tube in `colour` inside a wider white casing.
 *
 * ── How the casing reads as an EDGE, with no new shader ─────────────────
 *
 * The usual outline is an inverted hull, a `BackSide` copy, and a side is part
 * of three's program key — a second program for a line (CLAUDE.md, the cache
 * key). So both tubes are front-faced `MeshBasicMaterial`, the program the
 * room's rims and craft already use, and the order does the work instead: the
 * casing draws after the island (`renderOrder` 1) WITHOUT writing depth, so it
 * is still hidden behind a ridge but leaves no depth of its own; the core draws
 * last (2), tests depth against the island alone, and so paints over the
 * casing's middle. What is left of the casing is a white rim either side.
 *
 * Tone-mapped, like the island it lies on: it is a thing on the projection,
 * not the room's UI (`ART_DIRECTION.md`, what may glow). Unlit, like the island.
 */
export const routeLine = (points: readonly THREE.Vector3[], colour: number): THREE.Group | null => {
  if (points.length < 2) return null
  const step = Math.max(1, Math.ceil(points.length / ROUTE_SAMPLES))
  const kept: THREE.Vector3[] = []
  for (let i = 0; i < points.length; i += step) kept.push(points[i] as THREE.Vector3)
  const last = points[points.length - 1] as THREE.Vector3
  if (kept[kept.length - 1] !== last) kept.push(last)
  if (kept.length < 2) return null
  const curve = new THREE.CatmullRomCurve3(kept, false, 'centripetal')
  const segments = kept.length * 2
  const group = new THREE.Group()
  group.name = ROUTE_LINE_NAME
  const casing = new THREE.Mesh(
    new THREE.TubeGeometry(curve, segments, ROUTE_CASING_RADIUS, 5, false),
    new THREE.MeshBasicMaterial({ color: ROUTE_CASING_COLOUR, depthWrite: false }),
  )
  casing.name = `${ROUTE_LINE_NAME}-casing`
  casing.renderOrder = 1
  const core = new THREE.Mesh(
    new THREE.TubeGeometry(curve, segments, ROUTE_CORE_RADIUS, 5, false),
    new THREE.MeshBasicMaterial({ color: colour }),
  )
  core.name = `${ROUTE_LINE_NAME}-core`
  core.renderOrder = 2
  group.add(casing)
  group.add(core)
  return group
}

const disposeRouteLine = (line: THREE.Object3D | null): void => disposeTree(line)

export interface Diorama {
  readonly object: THREE.Object3D
  /** Advance the tiny jets. Render time, not sim time — this is decoration. */
  update(seconds: number): void
  /**
   * DEV-420: fly the craft along `route` instead, and draw it in `colour` (null
   * draws nothing). The ISLAND is not rebuilt — a place table's courses share
   * it — so a new pick costs one line, not a terrain resample. `pads` wins over
   * the route as it does at creation.
   */
  setRoute(
    route: readonly (readonly number[])[] | null,
    colour: number | null,
    pads?: readonly (readonly number[])[],
  ): void
  /**
   * The highest point of the ISLAND within `radius` of `(x, z)`, in the
   * diorama's own local frame (metres above its origin, which is the
   * waterline). The mesh's own vertices, not a resample of the field — so it is
   * exactly what is drawn, waterline clamp included. `-Infinity` when no
   * vertex is inside the circle (a footprint off the disc).
   *
   * For the medal (DEV-140): 2016's slot stood at a fixed height over a table
   * whose miniature never reached it; the port's island is exaggerated 1.35x
   * and its peaks reach 0.15 m, so the emblem has to know where the ground is.
   */
  peakUnder(x: number, z: number, radius: number): number
  /** DEV-492: the THREE-space → local mapping the island was built in. */
  readonly frame: DioramaFrame
  dispose(): void
}

/**
 * Grid resolution of the miniature.
 *
 * 56 across a 0.5 m model is a 9 mm facet — about 0.33 degrees at the 1.55 m a
 * holotable sits from the eye, which is roughly the smallest triangle worth
 * drawing. The island's silhouette is what carries the read, not its detail.
 * The real terrain is 257 samples a side.
 *
 * Per table, so a page of four costs 4 x ~2,400 triangles. The island is 115,648
 * on its own; the menu is not where the frame goes.
 */
const DEFAULT_GRID = 56

/**
 * Vertical exaggeration.
 *
 * Simonet's peaks are ~900 m over a 4 km span, so at true scale the model is
 * a fifth of its width worth of relief — it reads as a puddle. Relief maps have
 * exaggerated height since the first one.
 *
 * 2.4 was the first try and it was too much: the islands came out as a ring of
 * spikes, which is not what you see from the cockpit and not what you fly
 * through. 1.35 keeps the ridge line legible while the thing still reads as an
 * archipelago you could put a course through.
 *
 * **Not 2016's number** (DEV-576): 2016's alpine and canyon miniatures stood at
 * about 0.8 to 1.1 of true relief, measured off their bakes against the level's
 * own maps. This is the port's, tuned on frames, and the row leaves it to Matt.
 */
const DEFAULT_RELIEF = 1.35

/** Tiny jets, and how fast they get round. Three is a grid, one is a demo. */
const JET_COUNT = 3
const LAP_SECONDS = 26

const HOLO_LOW = new THREE.Color(0x16404a)
const HOLO_HIGH = new THREE.Color(0x9fe8d8)
/**
 * The waterline colour, as an sRGB byte. The sea is part of the mesh, not a
 * disc under it.
 *
 * DEV-579 (Matt, 2026-10-03: *"use the real colors for the menu dioramas"*):
 * 2016's Simonet table had a sea of its own, `Water_levelSel.mat`, and its
 * vertex colour mean times the material's `_Color` is about (0.14, 0.42, 0.58)
 * before its reflection (DEV-576 §3). This is that, as a byte: (36, 107, 148).
 * It was 0x0d3546, (0.05, 0.21, 0.27), a dark teal that went black beside the
 * land once the land showed its own colours. **The number to argue with**;
 * pinned in `diorama-look.test.ts` so a change to it is made on purpose.
 */
export const SEA_TINT = 0x246b94

/**
 * DEV-579: the light the island's faces are shaded by, BAKED into the vertex
 * colours, as a shaded relief map is. From the map's north-west (three -x,
 * -z: north is away from the seat), 45 degrees up, which is the cartographer's
 * convention because a relief lit from the top-left of the sheet reads as
 * ridges and not as trenches.
 *
 * Baked rather than lit, for three reasons. The island is unlit and must stay
 * so (DEV-188: a light in the room is a program key for every lit material in
 * it). A baked shade is ONE program for every table, the same program as
 * before, so selecting a table or opening a step compiles nothing. And it
 * is the same in both eyes by construction. The cost: a table's picture turns
 * while it is selected (DEV-574) and its light turns with it, which a painted
 * relief model does too.
 *
 * `HILLSHADE_FLOOR + HILLSHADE_GAIN * max(0, n . light)`, applied to the
 * colour map's own byte, so a face turned from the light shows 0.55 of the
 * map's colour and one square to it 1.10: the spread DEV-576's comparison
 * sheet rendered 2016's bake and ours with, which read in colour.
 */
export const HILLSHADE_LIGHT: Readonly<THREE.Vector3> = new THREE.Vector3(
  -1,
  Math.SQRT2,
  -1,
).normalize()
export const HILLSHADE_FLOOR = 0.55
export const HILLSHADE_GAIN = 0.55

/**
 * DEV-579: a body's earth where the table has no land to read it from (all
 * sea, or no palette): a dark umber, as an sRGB byte triple.
 */
const EARTH_FALLBACK = { r: 0.36, g: 0.3, b: 0.24 } as const

/**
 * DEV-579: the colour of the ground a body is cut through: the colour map's
 * own byte on the table's land, weighted by how STEEP each face is (`(1 - n.y)`
 * squared), so it is the colour the map paints its cliffs, which is the colour
 * a cut through the island would show: grey rock on alpine, rust on the
 * canyon. sRGB, as the palette is read. A pure function of the faces, for the
 * test.
 */
export const bodyEarth = (
  faces: readonly {
    readonly r: number
    readonly g: number
    readonly b: number
    readonly ny: number
  }[],
): { r: number; g: number; b: number } => {
  let r = 0
  let g = 0
  let b = 0
  let w = 0
  for (const f of faces) {
    const s = (1 - Math.min(1, Math.abs(f.ny))) ** 2
    r += f.r * s
    g += f.g * s
    b += f.b * s
    w += s
  }
  if (w <= 1e-9) return { ...EARTH_FALLBACK }
  r /= w
  g /= w
  b /= w
  // Greyed toward its own luma by EARTH_GREY: a cliff's colour on a map
  // carries the vegetation painted over it (alpine's read olive), and a cut
  // through the island is rock.
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return {
    r: r + (luma - r) * EARTH_GREY,
    g: g + (luma - g) * EARTH_GREY,
    b: b + (luma - b) * EARTH_GREY,
  }
}

/** DEV-579: how far a body's earth is greyed toward its own luma. */
export const EARTH_GREY = 0.7

/**
 * DEV-579: the body's wall is broken into this many facets round the disc,
 * each a little lighter or darker ({@link WALL_FACET_JITTER}), so it reads as
 * cut stone in a faceted game and not as a smooth painted band.
 */
const WALL_FACETS = 40
export const WALL_FACET_JITTER = 0.12

/**
 * DEV-579: a land-only table's origin, under its lowest ground, as a fraction
 * of the field's height (9 m of alpine's 900, 1.5 mm on the table).
 */
const LAND_BASE_MARGIN = 0.01

const JET_COLOUR = 0xbdf3ff

/**
 * How many points a single pad-to-pad hop is sampled at.
 *
 * Twelve is enough that the arc reads as a curve rather than as a tent at the
 * ~20 px a hop spans on a 0.5 m table, and the cost is nothing: the whole tour
 * of the longest mission (12 pads) is 145 points against the 421–661 a racing
 * line already carries.
 */
const HOP_SAMPLES = 12

/**
 * The apex of a hop, as a fraction of its horizontal range.
 *
 * **Not a taste number: it is the 45-degree launch.** For a ballistic throw at
 * angle θ the range is `v² sin2θ / g` and the apex is `v² sin²θ / 2g`, so
 * `apex / range = tan θ / 4` — and at 45 degrees, the angle that throws
 * furthest for a given launch speed, that is exactly a quarter. Pinned in
 * `diorama-look.test.ts` by measuring the arc rather than by restating this.
 */
const HOP_APEX_OVER_RANGE = 0.25

/**
 * A JumpSeat's tour of the targets: a 45-degree lob from each pad to the next,
 * and round to the first. #41c.
 *
 * ── Why this exists at all, which is not what the wishlist row said ───────
 *
 * The row reads *"a little JumpSeat hopping pad to pad"*, as though the craft
 * were flying the wrong path. It was not flying at all: **five of the six
 * Target Practice missions have `route: null`** in their level JSON, so
 * `line.length > 1` is false and `createDiorama` builds ZERO jets. Those five
 * tables had nothing moving on them from the day the file was written. Only
 * `rookie_02_jumpSeat` has a route (321 points), and it is a HoverJet racing
 * line on a mission you fly in hops.
 *
 * So the pads are the only path a Target Practice table has, and they are
 * already in `MissionShape`. Since DEV-354 they are ONLY a path: the targets
 * are not drawn, and the craft is the one thing on the land that says where
 * they are.
 *
 * ── The order is the AUTHORED one, and it zigzags ────────────────────────
 *
 * `level.pads` order, filtered to live. Consecutive hops run 288 m to 2,510 m
 * (median ~900), so the tour crosses the island rather than walking round it —
 * and that is the data rather than a bug. A nearest-neighbour tour would read
 * tidier and would be a route this project invented, with no provenance and
 * nothing to check it against; 2016 scores the pads in any order, so there is
 * no authored tour to port. If a zigzag ever reads badly, that is the place to
 * argue, and the argument needs a screenshot.
 *
 * ── Sampled in equal TIME, which is what makes it look thrown ────────────
 *
 * `update` walks the polyline at one index per equal slice of the lap, so the
 * SPACING of the samples is the speed. Sampling the parabola uniformly in the
 * ballistic parameter puts them far apart near the pads and close together at
 * the apex — which is the real trajectory, fast off the pad and slow over the
 * top, for free. Sampling by arc length would have cost the same and produced a
 * craft cruising round a curve.
 *
 * Returns THREE-space triples, exactly as `route` does, so the caller maps them
 * through the same two flips and no frame can diverge.
 */
export const padHopPath = (pads: readonly (readonly number[])[]): number[][] => {
  if (pads.length < 2) return []
  const path: number[][] = []
  for (let i = 0; i < pads.length; i++) {
    const a = pads[i] as readonly number[]
    const b = pads[(i + 1) % pads.length] as readonly number[]
    const ax = a[0] as number
    const ay = a[1] as number
    const az = a[2] as number
    const dx = (b[0] as number) - ax
    const dy = (b[1] as number) - ay
    const dz = (b[2] as number) - az
    // HORIZONTAL range: the apex of a lob is measured over the ground it
    // covers, and two pads at different heights would otherwise get an arc
    // scaled by how far apart they are vertically.
    const apex = Math.hypot(dx, dz) * HOP_APEX_OVER_RANGE
    for (let k = 0; k < HOP_SAMPLES; k++) {
      const t = k / HOP_SAMPLES
      // `4 * apex * t * (1 - t)` peaks at exactly `apex` over the CHORD at
      // t = 0.5. Uneven pad heights make the true flight asymmetric; at 1:8000
      // that is well under a pixel and this stays one term.
      path.push([ax + dx * t, ay + dy * t + 4 * apex * t * (1 - t), az + dz * t])
    }
  }
  // Close the tour on the first pad, so the last hop LANDS rather than being
  // cut off one sample short of its target.
  path.push([pads[0]?.[0] as number, pads[0]?.[1] as number, pads[0]?.[2] as number])
  return path
}

export const createDiorama = (opts: DioramaOptions): Diorama => {
  const object = new THREE.Group()
  object.name = 'diorama'

  const { field, size } = opts
  // World extent of the heightfield, in SIM space.
  const spanX = field.terrainSize * (field.scaleX || 1)
  const spanZ = field.terrainSize * (field.scaleZ || 1)
  const span = Math.max(spanX, spanZ)
  const scale = size / span
  // `let`: a land-only table with a body stands on its own lowest ground,
  // settled below once the disc is known (DEV-579).
  let seaY = opts.seaLevel ?? field.originY
  const GRID = Math.max(1, Math.round(opts.grid ?? DEFAULT_GRID))
  const RELIEF = opts.relief ?? DEFAULT_RELIEF

  /**
   * SIM world -> diorama local.
   *
   * The z flip is the same one the whole render layer does on the way out of
   * sim space, and it has to happen HERE rather than at the call sites: the
   * heightfield is sampled in sim space and the mesh is built in three space,
   * so this function is the only place both are true at once.
   */
  const toLocalX = (worldX: number) => (worldX - (field.originX + spanX / 2)) * scale
  const toLocalZ = (worldZ: number) => -(worldZ - (field.originZ + spanZ / 2)) * scale
  const toLocalY = (worldY: number) => (worldY - seaY) * scale * RELIEF

  // ── the island ──────────────────────────────────────────────────────────
  //
  // Flat-shaded and split, like everything else in this game. Sampling the real
  // field rather than approximating it: it is a table lookup, and a miniature
  // that disagrees with the terrain is worse than no miniature.
  //
  // On EVERY table since DEV-354. DEV-313's #41a skipped it on a Ring Attack
  // table, which then stood its gate circuit on nothing; see the header.
  const positions: number[] = []
  const colors: number[] = []
  const cell = span / GRID
  const colour = new THREE.Color()
  const palette = opts.palette ?? null
  const holo = opts.holo ?? null
  const brightness = holo?.brightness ?? 1
  const holoMix = holo?.holoMix ?? 0
  const sampled: Rgb = { r: 0, g: 0, b: 0 }

  const heightAt = (gx: number, gz: number) => {
    const wx = field.originX + gx * cell
    const wz = field.originZ + gz * cell
    return terrainHeightAt(field, wx, wz)
  }

  /**
   * What the cell IS, judged at its centre: sea, the colour map's own byte
   * there, or (with no palette) a step up the holo ramp. One sample a cell, as
   * the terrain generator samples its colour map once a face (DEV-014).
   *
   * With a palette: the colour map at the cell's centre, in the same (u, v)
   * `terrainHeightAt` maps the world to. DEV-579 changed how that byte is
   * READ: it is the colour on screen, an sRGB byte, where it used to be taken
   * raw as linear the way the world reads its vertex colours. The world is lit
   * by a sun and fogged; this island is unlit, and raw-as-linear on an unlit
   * face is the byte pushed through the sRGB encode, every colour lifted
   * toward white and greyed (DEV-576: all three islands photographed chalk).
   * 2016 drew its miniature in gamma space, which is the byte times its
   * lighting on screen; so does this. Sea cells keep the sea tint: the map
   * paints the seabed, and a miniature that shows the seabed is a chart.
   */
  const SEA = 0
  const LAND = 1
  const RAMP = 2
  const cellKind = (gx: number, gz: number, h: number): number => {
    if (h <= seaY) return SEA
    if (palette) {
      palette.sample(((gx + 0.5) * cell) / spanX, ((gz + 0.5) * cell) / spanZ, sampled)
      return LAND
    }
    // Underwater goes SEA, and above it climbs from the shallows to the peaks.
    // Two tints rather than one ramp, so the coastline is a hard edge — which
    // is what makes an archipelago legible at 1:6600.
    const t = Math.min(1, Math.max(0, (h - seaY) / (field.terrainHeight || 1)))
    colour.copy(HOLO_LOW).lerp(HOLO_HIGH, t ** 0.7)
    return RAMP
  }

  /** One vertex's local position, into `corner`. Grid units, fractional allowed. */
  const corner = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] as const
  const toCorner = (out: THREE.Vector3, gx: number, gz: number, h: number) =>
    out.set(
      toLocalX(field.originX + gx * cell),
      // CLAMPED at the waterline. The field carries real depths below sea
      // level, and a miniature that renders the sea floor is a bathymetric
      // chart — the first build read as a teal slab with spikes on it, because
      // that is exactly what it was. Flattening to the waterline gives the one
      // thing a relief model needs: a sea you can see the islands sit in.
      toLocalY(Math.max(h, seaY)),
      toLocalZ(field.originZ + gz * cell),
    )
  const _ab = new THREE.Vector3()
  const _ac = new THREE.Vector3()

  /**
   * One triangle, its three corners already in `corner`. A land face takes the
   * cell's byte times its own shade under {@link HILLSHADE_LIGHT}, so the two
   * triangles of a folded cell differ and the crease between them reads; then
   * the look's brightness and lean, as before. Sea and ramp faces are one
   * flat colour.
   */
  /** The face normal of `corner`, into `_ab`, turned to face `side` (+1 up, -1 down, 0 as wound). */
  const faceNormal = (side: number): THREE.Vector3 => {
    _ab.subVectors(corner[1], corner[0])
    _ac.subVectors(corner[2], corner[0])
    _ab.cross(_ac).normalize()
    if (side !== 0 && _ab.y * side < 0) _ab.negate()
    return _ab
  }
  const shadeOf = (n: THREE.Vector3): number =>
    HILLSHADE_FLOOR + HILLSHADE_GAIN * Math.max(0, n.dot(HILLSHADE_LIGHT))
  /** `colour` from an sRGB byte triple, then the look's brightness and lean. */
  const paint = (r: number, g: number, b: number) => {
    colour.setRGB(Math.min(1, r), Math.min(1, g), Math.min(1, b), THREE.SRGBColorSpace)
    if (brightness !== 1) colour.multiplyScalar(brightness)
    if (holoMix > 0) colour.lerp(HOLO_HIGH, holoMix)
  }
  const emit = () => {
    for (const p of corner) {
      positions.push(p.x, p.y, p.z)
      colors.push(colour.r, colour.g, colour.b)
    }
  }

  /**
   * The land's faces as the body's earth reads them ({@link bodyEarth}): the
   * byte and the face's up-ness. Collected only when a body is asked for.
   */
  const earthFaces: { r: number; g: number; b: number; ny: number }[] = []

  const pushTriangle = (kind: number) => {
    if (kind === LAND) {
      // Facing up whichever way it was wound: the island is double-sided.
      const n = faceNormal(1)
      const shade = shadeOf(n)
      paint(sampled.r * shade, sampled.g * shade, sampled.b * shade)
      if (opts.body) earthFaces.push({ r: sampled.r, g: sampled.g, b: sampled.b, ny: n.y })
    } else if (kind === SEA) {
      colour.set(SEA_TINT)
    }
    emit()
  }

  // Clipped to a disc, so the model sits INSIDE the projector rim rather than
  // overhanging it as a square. Measured at the cell's centre: a cell that is
  // mostly in is in.
  const clipRadius = span * 0.5
  const inside = (gx: number, gz: number) => {
    if (gx < 0 || gz < 0 || gx >= GRID || gz >= GRID) return false
    const dx = (gx + 0.5) * cell - spanX / 2
    const dz = (gz + 0.5) * cell - spanZ / 2
    return Math.hypot(dx, dz) <= clipRadius
  }

  // ── a land-only table stands on its lowest ground (DEV-579) ─────────────
  //
  // With no sea handed in, the waterline is the land field's origin: the
  // bottom of its height map. On alpine and the canyon that is far under the
  // lowest ground on the disc, which a bare surface never showed (it floated)
  // and a body does: the first frames stood both islands on a smooth band of
  // earth deeper than their mountains, a bucket with a forest in it. So where
  // NOTHING on the disc is at or under the origin (no cell would have been
  // sea), the model's origin rises to the lowest ground on the disc, less
  // {@link LAND_BASE_MARGIN} of the field's height so no cell turns sea. A
  // table with any sea on it, and every table without a body, is unchanged.
  if (opts.body && (opts.seaLevel ?? null) === null) {
    let lowest = Infinity
    for (let gz = 0; gz <= GRID; gz++) {
      for (let gx = 0; gx <= GRID; gx++) {
        if (inside(gx, gz) || inside(gx - 1, gz) || inside(gx, gz - 1) || inside(gx - 1, gz - 1)) {
          lowest = Math.min(lowest, heightAt(gx, gz))
        }
        if (inside(gx, gz)) lowest = Math.min(lowest, heightAt(gx + 0.5, gz + 0.5))
      }
    }
    const base = lowest - LAND_BASE_MARGIN * (field.terrainHeight || 1)
    if (Number.isFinite(base) && base > seaY) seaY = base
  }

  // ── the land eased down to the rim (DEV-579 follow-up) ──────────────────
  //
  // `groundAt` is the field as this table draws it: `heightAt`, with the
  // body's ease applied by the point's distance from the centre. Every vertex,
  // every cell's sea-or-land judgement and every point of the craft's path
  // reads it, so the island, its coastline, its medal (`peakUnder` reads the
  // drawn vertices) and its route all agree about where the ground is.
  const ease = opts.body?.ease ?? null
  // DEV-627: a sea table's land stops short of the rim, inside `landR` of the
  // radius, and its ease reaches the waterline there (keep 0), so the sea runs
  // on to the rim all round. Zero on a table with no sea, which is unchanged.
  const seaRing =
    opts.body && (opts.seaLevel ?? null) !== null
      ? Math.min(0.9, Math.max(0, opts.body.seaRing ?? 0))
      : 0
  const landR = 1 - seaRing
  const radiusAt = (gx: number, gz: number) =>
    Math.hypot(gx * cell - spanX / 2, gz * cell - spanZ / 2) / (span * 0.5)
  const easeDrop = (gx: number, gz: number, h: number): number => {
    if (!ease || h <= seaY) return 0
    const t = radiusAt(gx, gz) / landR
    const s = easeAt(ease, t)
    if (s <= 0) return 0
    const keep = seaRing > 0 ? 0 : Math.min(1, Math.max(0, ease.keep))
    return (h - seaY) * s * (1 - keep)
  }
  const groundAt = (gx: number, gz: number): number => {
    const h = heightAt(gx, gz)
    if (seaRing > 0 && radiusAt(gx, gz) >= landR) return Math.min(h, seaY)
    return h - easeDrop(gx, gz, h)
  }

  // ── the vertex grid, and the rim snapped to a circle (DEV-579) ──────────
  //
  // Cells in or out by their centre leave a STAIRCASE of an outline, 9 mm
  // steps, which was fine for a bare surface and is not for a wall: a wall
  // down a staircase is a crenellation, its faces alternately lit and not. So
  // where the island has a body, every vertex on the outline is moved along
  // its own radius onto the circle (at most ~0.7 of a cell) and its height
  // read there, and the wall stands on a true faceted circle. A vertex is on
  // the outline when it ends an edge whose other cell is out. Interior
  // vertices never move; the unit test checks no face folds over.
  const V = GRID + 1
  const vU = new Float64Array(V * V)
  const vW = new Float64Array(V * V)
  const vH = new Float64Array(V * V)
  const onRim = new Uint8Array(V * V)
  /** The outline: [vertex a, vertex b, the kind of the cell inside it]. */
  const rim: [number, number, number][] = []
  const kinds = new Int8Array(GRID * GRID).fill(-1)
  const sampledR = new Float32Array(GRID * GRID)
  const sampledG = new Float32Array(GRID * GRID)
  const sampledB = new Float32Array(GRID * GRID)
  const vid = (gx: number, gz: number) => gz * V + gx
  for (let gz = 0; gz < GRID; gz++) {
    for (let gx = 0; gx < GRID; gx++) {
      if (!inside(gx, gz)) continue
      // The cell's one colour, judged sea or land at its centre.
      const kind = cellKind(gx, gz, groundAt(gx + 0.5, gz + 0.5))
      const c = gz * GRID + gx
      kinds[c] = kind
      sampledR[c] = sampled.r
      sampledG[c] = sampled.g
      sampledB[c] = sampled.b
      if (!opts.body) continue
      const edges: [number, number, number, number, number, number][] = [
        [gx, gz, gx + 1, gz, gx, gz - 1],
        [gx + 1, gz + 1, gx, gz + 1, gx, gz + 1],
        [gx, gz + 1, gx, gz, gx - 1, gz],
        [gx + 1, gz, gx + 1, gz + 1, gx + 1, gz],
      ]
      for (const [ax, az, bx, bz, nx, nz] of edges) {
        if (inside(nx, nz)) continue
        const a = vid(ax, az)
        const b = vid(bx, bz)
        onRim[a] = 1
        onRim[b] = 1
        rim.push([a, b, kind])
      }
    }
  }
  for (let gz = 0; gz < V; gz++) {
    for (let gx = 0; gx < V; gx++) {
      const v = vid(gx, gz)
      let u = gx
      let w = gz
      if (onRim[v]) {
        const dx = gx * cell - spanX / 2
        const dz = gz * cell - spanZ / 2
        const d = Math.hypot(dx, dz) || 1
        u = (spanX / 2 + (dx * clipRadius) / d) / cell
        w = (spanZ / 2 + (dz * clipRadius) / d) / cell
      }
      vU[v] = u
      vW[v] = w
      vH[v] = groundAt(u, w)
    }
  }
  const vertexCorner = (out: THREE.Vector3, v: number) =>
    toCorner(out, vU[v] as number, vW[v] as number, vH[v] as number)

  for (let gz = 0; gz < GRID; gz++) {
    for (let gx = 0; gx < GRID; gx++) {
      const c = gz * GRID + gx
      const kind = kinds[c] as number
      if (kind < 0) continue
      sampled.r = sampledR[c] as number
      sampled.g = sampledG[c] as number
      sampled.b = sampledB[c] as number
      if (kind === RAMP) {
        const t = Math.min(
          1,
          Math.max(0, (groundAt(gx + 0.5, gz + 0.5) - seaY) / (field.terrainHeight || 1)),
        )
        colour.copy(HOLO_LOW).lerp(HOLO_HIGH, t ** 0.7)
      }
      // Wound so the normals point UP once the z flip is applied. Two triangles
      // a cell, split — no shared vertices, so every facet keeps its own normal.
      vertexCorner(corner[0], vid(gx, gz))
      vertexCorner(corner[1], vid(gx, gz + 1))
      vertexCorner(corner[2], vid(gx + 1, gz))
      pushTriangle(kind)
      vertexCorner(corner[0], vid(gx + 1, gz))
      vertexCorner(corner[1], vid(gx, gz + 1))
      vertexCorner(corner[2], vid(gx + 1, gz + 1))
      pushTriangle(kind)
    }
  }

  // ── the body (DEV-579) ──────────────────────────────────────────────────
  //
  // Down from every outline edge in four rings: the rim itself (the land's own
  // height there, or the waterline), straight down to `-lip`, leaning in
  // through a middle ring to the foot, then a fan to the centre for the
  // underside. The cut under a SEA edge is the water's section, in the sea
  // tint darkened; under land it is the earth. Each band darker than the one
  // above it, and every face shaded by the island's own baked light, so the
  // wall the seat sees (the south one, away from a north-west light) sits in
  // its own shade the way a lit model's would.
  if (opts.body) {
    const body = opts.body
    const R = size / 2
    const earth = bodyEarth(earthFaces)
    const seaByte = new THREE.Color(SEA_TINT)
    const sea = { r: 0, g: 0, b: 0 }
    seaByte.getRGB(sea, THREE.SRGBColorSpace)
    const footScale = Math.min(1, Math.max(0, body.foot / R))
    const midScale = (1 + footScale) / 2
    const lipY = -Math.max(0, body.lip)
    const footY = -Math.max(body.depth, body.lip)
    const midY = (lipY + footY) / 2
    const a0 = new THREE.Vector3()
    const b0 = new THREE.Vector3()
    /** This rim edge's facet shade, by the angle of its midpoint. */
    let facet = 1
    /** One band: the quad between two rings, each given as (scale, y), y null for the rim's own. */
    const band = (
      sa: number,
      ya: number | null,
      sb: number,
      yb: number,
      tint: { r: number; g: number; b: number },
      k: number,
    ) => {
      const ax = a0.x * sa
      const az = a0.z * sa
      const bx = b0.x * sa
      const bz = b0.z * sa
      const ay = ya ?? a0.y
      const by = ya ?? b0.y
      const lax = a0.x * sb
      const laz = a0.z * sb
      const lbx = b0.x * sb
      const lbz = b0.z * sb
      // Outward: the quad's horizontal normal agrees with its midpoint's radius.
      const mx = (ax + bx) / 2
      const mz = (az + bz) / 2
      const tri = (p: number[], q: number[], r: number[]) => {
        corner[0].set(p[0] as number, p[1] as number, p[2] as number)
        corner[1].set(q[0] as number, q[1] as number, q[2] as number)
        corner[2].set(r[0] as number, r[1] as number, r[2] as number)
        const n = faceNormal(0)
        if (n.x * mx + n.z * mz < 0) n.negate()
        const shade = shadeOf(n) * k * facet
        paint(tint.r * shade, tint.g * shade, tint.b * shade)
        emit()
      }
      tri([ax, ay, az], [bx, by, bz], [lax, yb, laz])
      tri([bx, by, bz], [lbx, yb, lbz], [lax, yb, laz])
    }
    for (const [a, b, kind] of rim) {
      vertexCorner(a0, a)
      vertexCorner(b0, b)
      if (Math.hypot(a0.x - b0.x, a0.z - b0.z) < R * 1e-6) continue
      const turn = Math.atan2(a0.z + b0.z, a0.x + b0.x) / (2 * Math.PI) + 0.5
      facet =
        1 + WALL_FACET_JITTER * (facetHash01(Math.floor(turn * WALL_FACETS) % WALL_FACETS) * 2 - 1)
      // The rim's own corners sit on the circle; scale 1 is the rim.
      const cut =
        kind === SEA
          ? { r: sea.r * BODY_WATER, g: sea.g * BODY_WATER, b: sea.b * BODY_WATER }
          : earth
      band(1, null, 1, lipY, cut, BODY_ROWS.cut)
      band(1, lipY, midScale, midY, earth, BODY_ROWS.upper)
      band(midScale, midY, footScale, footY, earth, BODY_ROWS.lower)
      // The underside: a fan to the centre, facing down.
      corner[0].set(a0.x * footScale, footY, a0.z * footScale)
      corner[1].set(b0.x * footScale, footY, b0.z * footScale)
      corner[2].set(0, footY, 0)
      const shade = shadeOf(faceNormal(-1)) * BODY_ROWS.underside
      paint(earth.r * shade, earth.g * shade, earth.b * shade)
      emit()
    }
  }

  const islandGeometry = new THREE.BufferGeometry()
  islandGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  islandGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  islandGeometry.computeVertexNormals()
  // Its own light, like the strip lights: this is a projection, and a
  // projection that goes dark when the room does is a screen, not a hologram.
  // Its relief, and its body, are the shade baked into its vertex colours above
  // (DEV-579), so no material here changed with them. With a tell on, the same
  // unlit vertex colour plus a rim where the facets turn from the eye and
  // faint scanlines up the model, both in the holo tint, both zero in Classic. Tone-mapped like everything else in the room
  // (ART_DIRECTION: a thing in the world is tone-mapped; the UI is not).
  const tell = holo !== null && (holo.rim > 0 || holo.scanline > 0)
  const islandMaterial: THREE.Material = tell
    ? new THREE.ShaderMaterial({
        uniforms: {
          uRim: { value: holo.rim },
          uScan: { value: holo.scanline },
          // Bands 2 cm apart: about seven across a 0.15 m peak, read as bands
          // from the seat. 6 mm was tried first and read as dither on a pane.
          uScanPerMetre: { value: 1 / 0.02 },
          uHolo: { value: HOLO_HIGH.clone() },
        },
        vertexShader: /* glsl */ `
          varying vec3 vColor;
          varying vec3 vNormalW;
          varying vec3 vPosW;
          varying float vLocalY;
          void main() {
            vColor = color;
            vNormalW = normalize(mat3(modelMatrix) * normal);
            vec4 world = modelMatrix * vec4(position, 1.0);
            vPosW = world.xyz;
            vLocalY = position.y;
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: /* glsl */ `
          // No <colorspace_pars_fragment> and NO <tonemapping_pars_fragment>:
          // three's program prefix already declares both for every material,
          // and a second body fails to compile ("function already has a body").
          //
          // (No backticks in this comment. It lives INSIDE a template literal
          // and one would end the string - which cost a typecheck cycle.)
          //
          // The colorspace half was found and fixed when this was written. The
          // tonemapping half survived, because it is only a duplicate SOME of
          // the time: WebGLProgram.js:772 inserts the chunk only when
          // parameters.toneMapping !== NoToneMapping. On the flat Anniversary
          // build the scene renders into the COMPOSER's target, where three
          // applies no tone mapping at all - content/editions/anniversary.json
          // says exactly that, about the bloom threshold - and Classic is
          // toneMapping "none" and never had it either.
          //
          // IN A HEADSET the destination is an XR target, three applies ACES,
          // the prefix declares the functions, and this compiled a second body
          // of every one of them. From Matt's first Frame session:
          // "LinearToneMapping : function already has a body" and ten more,
          // VALIDATE_STATUS false, then "useProgram: program not valid" two
          // hundred times a frame. Invisible to every flat test, every
          // screenshot and both presets - DEV-141's shape one layer down.
          //
          // <tonemapping_fragment> in main() STAYS: it is guarded by
          // "#if defined( TONE_MAPPING )", which three defines only when tone
          // mapping is on, so it is a no-op rather than a second copy.
          #include <common>
          uniform float uRim;
          uniform float uScan;
          uniform float uScanPerMetre;
          uniform vec3 uHolo;
          varying vec3 vColor;
          varying vec3 vNormalW;
          varying vec3 vPosW;
          varying float vLocalY;
          void main() {
            vec3 n = normalize(vNormalW);
            vec3 v = normalize(cameraPosition - vPosW);
            // Double-sided: the back face's normal points away; the rim is about grazing either way.
            float grazing = 1.0 - abs(dot(n, v));
            vec3 c = vColor + uHolo * (uRim * grazing * grazing * grazing);
            // DEV-798: the bands are for the land and stop at the waterline (local
            // y 0): below it is the pedestal's wall, which scanlines banded like
            // rock layers (Matt, 2026-10-07, QUESTIONS item 26).
            float band = step(0.5, fract(vLocalY * uScanPerMetre)) * step(0.0, vLocalY);
            c *= 1.0 - uScan * band;
            gl_FragColor = vec4(c, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
        vertexColors: true,
        side: THREE.DoubleSide,
      })
    : new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
      })
  const island = new THREE.Mesh(islandGeometry, islandMaterial)
  island.name = 'diorama-island'
  object.add(island)

  // ── the tiny jets ───────────────────────────────────────────────────────
  //
  // Following the mission's own racing line. `SplineWalker` in 2016; an arc
  // length lookup here, which is the same idea with the spline already sampled.
  //
  // **A table handed PADS flies them instead** (#41c), because five of the six
  // Target Practice missions have no racing line at all and so had no craft at
  // all. `padHopPath` builds the tour in THREE space, exactly the space a route
  // arrives in, so the mapping below is one code path for both and neither can
  // end up in the other's frame.
  //
  // The level stores the route in THREE space, so unlike the island it needs no
  // z flip — it needs the OPPOSITE, because `toLocalZ` applies one.
  /**
   * A route or a pad tour, THREE space, into the diorama's frame.
   *
   * Where the land is eased (DEV-579 follow-up) a point comes down by exactly
   * what the ground under it came down, so it keeps its height OVER the land:
   * the eased band cannot stay clear of the routes, because shipped racing
   * lines run past the disc's edge (alpine's `int_02` to 1.085 of its radius,
   * the canyon's `adv_01` to 1.062, Simonet's `int_01` to 1.115).
   */
  const localPath = (
    route: readonly (readonly number[])[] | null,
    pads: readonly (readonly number[])[],
  ): THREE.Vector3[] =>
    (pads.length > 0 ? padHopPath(pads) : (route ?? [])).map((p) => {
      const x = p[0] as number
      // Back to sim space so `toLocalZ`'s flip lands it where the island is.
      const z = -(p[2] as number)
      const gx = (x - field.originX) / cell
      const gz = (z - field.originZ) / cell
      const drop = ease ? easeDrop(gx, gz, heightAt(gx, gz)) : 0
      return new THREE.Vector3(toLocalX(x), toLocalY((p[1] as number) - drop), toLocalZ(z))
    })
  let line: THREE.Vector3[] = localPath(opts.route, opts.pads ?? [])

  // ── the drawn route (DEV-420) ────────────────────────────────────────────
  //
  // Only where asked: a place whose table carries its difficulty draws the
  // picked course's route, in that difficulty's ski-map colour. The same
  // points the craft flies, so the line and the jets cannot disagree.
  let drawn: THREE.Group | null = null
  const drawRoute = (colour: number | null | undefined) => {
    if (drawn) {
      object.remove(drawn)
      disposeRouteLine(drawn)
      drawn = null
    }
    if (colour === null || colour === undefined) return
    drawn = routeLine(line, colour)
    if (drawn) object.add(drawn)
  }
  drawRoute(opts.routeColour)

  // ── the craft is out of scale on purpose ────────────────────────────────
  //
  // `craftScale` (then `markScale`) went on the rings, the plates and the orbs
  // and **not on this** for a while, so the aircraft on every holotable stayed
  // at the proportion the option's own note calls the failure: 0.014 m long at
  // `MODEL_SIZE` — 0.52 degrees from the 1.551 m a table sits at, the figure
  // that note prices at *"4 pixels across on a Quest 3"*, and the title jets all
  // over again one screen over (orientation lesson §5c: a thing that is too
  // small has not been reviewed, it has been rendered).
  //
  // Found by photographing it: five frames of the JumpSeat's tour differ in
  // every byte, so the craft was moving the whole time and could not be SEEN.
  // The count of pixels is the whole bug; the motion was already right.
  const craft = Math.max(0, opts.craftScale ?? 1)
  const jetGeometry = new THREE.ConeGeometry(size * 0.008 * craft, size * 0.028 * craft, 4)
  // Nose along +z, so `lookAt` points it where it is going rather than up.
  jetGeometry.rotateX(Math.PI / 2)
  const jetMaterial = new THREE.MeshBasicMaterial({ color: JET_COLOUR })
  const jets: THREE.Mesh[] = []
  /** Craft exactly while there is a path to fly: none on a table with no route. */
  const fitJets = () => {
    const want = line.length > 1 ? JET_COUNT : 0
    while (jets.length < want) {
      const jet = new THREE.Mesh(jetGeometry, jetMaterial)
      object.add(jet)
      jets.push(jet)
    }
    while (jets.length > want) object.remove(jets.pop() as THREE.Mesh)
  }
  fitJets()

  const _look = new THREE.Vector3()
  let clock = 0

  return {
    object,
    // DEV-492: `toLocalX/Y/Z` above, as numbers. THREE z is sim −z, so the
    // THREE-space centre is the negated sim one.
    frame: {
      centreX: field.originX + spanX / 2,
      centreZ: -(field.originZ + spanZ / 2),
      seaY,
      scale,
      relief: RELIEF,
    },
    peakUnder(x: number, z: number, radius: number): number {
      const r2 = radius * radius
      let peak = -Infinity
      for (let i = 0; i < positions.length; i += 3) {
        const dx = (positions[i] as number) - x
        const dz = (positions[i + 2] as number) - z
        if (dx * dx + dz * dz > r2) continue
        const y = positions[i + 1] as number
        if (y > peak) peak = y
      }
      return peak
    },
    setRoute(route, colour, pads = []) {
      line = localPath(route, pads)
      fitJets()
      drawRoute(colour)
    },
    update(seconds: number) {
      if (line.length < 2) return
      clock += seconds
      for (let i = 0; i < jets.length; i++) {
        // Evenly spaced around the lap, so it reads as a race rather than a
        // formation. `+ i / count` rather than a per-jet speed: different speeds
        // drift into a clump and then stay there.
        const t = ((clock / LAP_SECONDS + i / jets.length) % 1) * (line.length - 1)
        const index = Math.floor(t)
        const frac = t - index
        const a = line[index] as THREE.Vector3
        const b = line[Math.min(line.length - 1, index + 1)] as THREE.Vector3
        const jet = jets[i] as THREE.Mesh
        jet.position.lerpVectors(a, b, frac)
        // Aim a little further along, or a jet sitting exactly on a vertex has
        // a zero-length direction and snaps to whatever it had last frame.
        const ahead = line[Math.min(line.length - 1, index + 2)] as THREE.Vector3
        _look.copy(ahead)
        if (_look.distanceToSquared(jet.position) > 1e-12) jet.lookAt(_look)
      }
    },
    dispose() {
      islandGeometry.dispose()
      islandMaterial.dispose()
      jetGeometry.dispose()
      jetMaterial.dispose()
      disposeRouteLine(drawn)
      drawn = null
    },
  }
}
