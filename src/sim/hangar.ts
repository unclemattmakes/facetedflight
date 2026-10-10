// src/sim/hangar.ts — the room at the bottom of the shaft.
//
// Matt: *"you started in an underground hangar and rode the shaft up. Very
// inspired by Evangelion."* `docs/research/_ui-flow.md` §5 found that 2016 built
// exactly that and used it as the MENU: `setGameplayOptions` is an
// `Environment_Hangar.prefab` instance at the base of an 8-segment shaft, with
// the player seated in a commander chair and holotables ringing the seat at
// 1.35–1.56 m. The menu and the launch were always one room.
//
// ── Why this was generated, and why it stays ──────────────────────────────
//
// 2016's hangar is `MM_Commander_Chair_01` over **SLK Sci-Fi Level Kit**, plus
// `botfloor_room` / `botfloor_startingArea` — combined meshes in
// `FF_WorldTour/meshes/combined/`, bought Asset Store geometry. This file was
// written when CLAUDE.md's rule 7 said none of that could ship, so it made the
// room the way the clouds (DEV-028) and the sky (DEV-029) were made: from the
// measurements, which here are FF2's own anyway — the platform is 9.35 × 9.28 m
// and the shaft ring is 1.45 platform radii, both already in `spawn.launch`.
//
// Rule 7 was revised on 2026-09-23: bought geometry ships to players from R2,
// and only git is closed to it. So 2016's own room is DRAWN now — the menu's
// since DEV-430 and the launch's since DEV-438 (`render/hangar-art.ts`, out of
// `hangar-room.glb`). This room is kept, by choice and not by licence: it is
// what stands until that file lands and for good if it never does, the tables,
// the seat and the jet are still placed in its frame, and its bore sizes the
// shaft's numbers (`shaftSpecFor`, the sea's hole, the reveal).
//
// ── The shape ─────────────────────────────────────────────────────────────
//
// A revolved well: a floor, a wall, and a ceiling that closes in to the bore the
// platform rises through. Faceted and jittered, because that is the house style
// and because a smooth revolve reads as a programmer cylinder — the same lesson
// the clouds taught, where lobes alone gave a pillow until every shared vertex
// was displaced inside a small ball.
//
// SIM LAYER: pure. No three, no DOM, no `Math.random` — the seed goes in and the
// same room comes out, on every machine and in a test.

import { writeFlatTri } from './math/flat-tri'
import { makeRandom } from './terrain/faceted'

export interface HangarMesh {
  /** 9 floats per triangle. */
  readonly positions: Float32Array
  /** 9 floats per triangle, one face normal repeated three times. */
  readonly normals: Float32Array
  /** 9 floats per triangle — linear RGB, one colour repeated three times. */
  readonly colors: Float32Array
  readonly triangleCount: number
}

export interface HangarSpec {
  /**
   * The hole the platform rises through, in metres.
   *
   * Not invented: `render/elevator.ts` rings its shaft pillars at 1.45 platform
   * radii, so the bore has to clear that or the platform would rise into its
   * own shaft. The caller passes the same number.
   */
  readonly boreRadius: number
  /** The room's own radius. Wider than the bore, or it is a tube, not a room. */
  readonly roomRadius: number
  /** Floor height, relative to the platform's RESTING position. Negative. */
  readonly floorY: number
  /** Where the wall stops and the ceiling starts closing in. */
  readonly wallTopY: number
  /** Where the ceiling meets the bore. Above this is open shaft. */
  readonly ceilingY: number
  /**
   * Sides of the revolve.
   *
   * Twelve is the smallest count that reads as a ROOM rather than as a polygon
   * at the distance you see it from — six is visibly hexagonal from the middle,
   * and you are in the middle.
   */
  readonly sides: number
  /**
   * Metres each shared vertex is displaced by, before the split.
   *
   * `FacetedTerrain` displaces every grid vertex by
   * `Random.insideUnitSphere * RandomOffset` before triangulating, and that is
   * why the island reads as carved. Applied to the SHARED vertices: after the
   * split each face's copy would move separately and the room would come apart.
   */
  readonly jitter: number
}

/**
 * A room roughly a segment tall and twice the bore across.
 *
 * `segmentSpacing` is 12 m on `int_01` and the wall is one segment, so the room
 * is the height of the structure the platform passes on the way out. Everything
 * else is a ratio off the bore, which is itself off the platform.
 */
/**
 * The launch platform every shipped mission that HAS one uses, in metres.
 *
 * All seven HoverJet missions carry `platform.size` `[9.35, 1.75, 9.28]`,
 * `shaft.segmentSpacing` 12 and `rise` 106.647018 — the same three numbers,
 * because 2016 authored one launch rig and instanced it. So the room these size
 * has always been ONE room; deriving it per mission was a no-op that read like a
 * dependency, and `tests/unit/hangar.test.ts` now asserts the agreement rather
 * than letting a future mission change the menu by accident.
 *
 * They are the defaults because **six missions have no launch rig at all**. The
 * JumpSeat spawns on its own sprung legs with no elevator, so `spawn.launch` is
 * null on all six — and the level select used to be built inside
 * `if (launchArt?.platform && launchArt.shaft)`, which meant those six booted
 * into a menu screen with no room, no chair, no tables and no way out of it.
 * Half the game was unreachable. (`tests/e2e/completion.spec.ts`.)
 */
export const LAUNCH_PLATFORM = { width: 9.35, depth: 9.28 } as const
export const SHAFT_SEGMENT_SPACING = 12
/**
 * How far BELOW the ship's spawn the room sits when there is no shaft to
 * measure — 2016's own rise, so a JumpSeat's room is as deep as a HoverJet's.
 *
 * The room is a closed revolve and the eye never leaves it before boarding, so
 * what is outside it does not matter; what does is that it is nowhere near the
 * ship, the terrain or the water.
 */
export const DEFAULT_HANGAR_DROP = 106.647018

/**
 * `platformRadius` and `segmentSpacing` default to the shipped rig above, which
 * is what every mission with a rig uses and what every mission without one gets.
 */
export const hangarSpecFor = (
  platformRadius: number = Math.max(LAUNCH_PLATFORM.width, LAUNCH_PLATFORM.depth) / 2,
  segmentSpacing: number = SHAFT_SEGMENT_SPACING,
): HangarSpec => ({
  boreRadius: platformRadius * 1.45,
  roomRadius: platformRadius * 2.75,
  floorY: -1.8,
  wallTopY: segmentSpacing * 0.82,
  ceilingY: segmentSpacing * 1.25,
  sides: 12,
  jitter: 0.34,
})

/** Floor, wall and ceiling get different greys so the room has a top and a bottom. */
const FLOOR_RGB = [0.052, 0.058, 0.068] as const
const WALL_RGB = [0.079, 0.086, 0.099] as const
const CEILING_RGB = [0.035, 0.039, 0.047] as const

/**
 * Build the room.
 *
 * Rings of vertices at four heights, quads between them, then split for flat
 * shading. The floor is a fan rather than a disc so its facets run outward from
 * under the platform, which is the only part of the floor anyone ever sees.
 */
export const generateHangar = (spec: HangarSpec, seed: number): HangarMesh => {
  const rnd = makeRandom(seed)
  const n = spec.sides

  // ── the shared vertex rings ─────────────────────────────────────────────
  //
  // Shared, and jittered while they still are. Ring 0 is the floor's centre
  // point, which is one vertex rather than a ring.
  const rings: { radius: number; y: number; rgb: readonly number[] }[] = [
    { radius: spec.roomRadius, y: spec.floorY, rgb: FLOOR_RGB },
    { radius: spec.roomRadius, y: spec.wallTopY, rgb: WALL_RGB },
    { radius: spec.boreRadius, y: spec.ceilingY, rgb: CEILING_RGB },
  ]

  const ringXYZ: Float32Array[] = rings.map((ring) => {
    const out = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      out[i * 3] = Math.cos(a) * ring.radius + (rnd() * 2 - 1) * spec.jitter
      out[i * 3 + 1] = ring.y + (rnd() * 2 - 1) * spec.jitter
      out[i * 3 + 2] = Math.sin(a) * ring.radius + (rnd() * 2 - 1) * spec.jitter
    }
    return out
  })
  const centre = [0, spec.floorY + (rnd() * 2 - 1) * spec.jitter * 0.5, 0] as const

  // floor fan (n) + two quad bands (2 * n * 2 triangles)
  const triangleCount = n + n * 4
  const positions = new Float32Array(triangleCount * 9)
  const normals = new Float32Array(triangleCount * 9)
  const colors = new Float32Array(triangleCount * 9)
  let t = 0

  const emit = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    rgb: readonly number[],
  ) => {
    const o = t * 9
    // Positions and the face normal, repeated three times. Flat shading is the
    // whole style, and doing it here rather than with a renderer flag keeps the
    // generator's output a complete mesh that a test can measure.
    writeFlatTri(positions, normals, o, ax, ay, az, bx, by, bz, cx, cy, cz)
    // Per-face shade, so neighbouring facets separate without a light on them.
    // The room is indoors and `int_01`'s sun is 4 degrees above the horizon, so
    // there is almost nothing to catch a crease otherwise.
    const shade = 0.82 + rnd() * 0.36
    for (let k = 0; k < 3; k++) {
      colors[o + k * 3] = (rgb[0] as number) * shade
      colors[o + k * 3 + 1] = (rgb[1] as number) * shade
      colors[o + k * 3 + 2] = (rgb[2] as number) * shade
    }
    t++
  }

  const at = (ring: number, i: number): [number, number, number] => {
    const r = ringXYZ[ring] as Float32Array
    const j = (i % n) * 3
    return [r[j] as number, r[j + 1] as number, r[j + 2] as number]
  }

  // ── the floor, as a fan ─────────────────────────────────────────────────
  //
  // Wound so the normals point UP, into the room: you stand on this, and a
  // floor lit from underneath is a floor you cannot see.
  for (let i = 0; i < n; i++) {
    const a = at(0, i)
    const b = at(0, i + 1)
    emit(centre[0], centre[1], centre[2], b[0], b[1], b[2], a[0], a[1], a[2], FLOOR_RGB)
  }

  // ── the wall, and the ceiling closing in to the bore ────────────────────
  //
  // Wound so the normals point INWARD, for the same reason: the room is only
  // ever seen from inside it, and a back-faced wall is a hole in the world.
  for (let band = 0; band < 2; band++) {
    const rgb = band === 0 ? WALL_RGB : CEILING_RGB
    for (let i = 0; i < n; i++) {
      const lo0 = at(band, i)
      const lo1 = at(band, i + 1)
      const hi0 = at(band + 1, i)
      const hi1 = at(band + 1, i + 1)
      emit(lo0[0], lo0[1], lo0[2], hi1[0], hi1[1], hi1[2], hi0[0], hi0[1], hi0[2], rgb)
      emit(lo0[0], lo0[1], lo0[2], lo1[0], lo1[1], lo1[2], hi1[0], hi1[1], hi1[2], rgb)
    }
  }

  return { positions, normals, colors, triangleCount }
}

// ══ THE SHAFT'S WALLS ═════════════════════════════════════════════════════
//
// Matt, 2026-09-14: *"our 'elevator ride' isn't enclosed, and players can see
// the world as they rise. please implement sides of the elevator shaft."*
//
// The room above closes at `ceilingY` to a bore the platform rises through,
// and until now the bore opened onto pillars and collars with nothing between
// them — six posts a segment, 79 m of them, and daylight in every gap. 2016's
// shaft segments were `walls_and_pillars_pwn` (the name says it) and the port
// drew the pillars without the walls. This is the walls.
//
// Same bargain as the room, struck when rule 7 still barred 2016's PolyWorld
// conversions: the SIZE is the room's own bore, and the art is a jittered
// faceted revolve in the house style. Since DEV-438 the tube a player rides
// past is 2016's own eight segments (`render/hangar-art.ts`), which seal the
// ride the same way; this one is kept, by choice, as what stands when that
// art does not land, and as the tube the bore's numbers and the specs that
// measure the bore are read off. It is a separate generator
// rather than more rings on `generateHangar` because the two have different
// lifetimes on screen — the room is switched off when the world arrives
// (2016's `disableAfterTriggered`) and the shaft has to outlive that moment by
// three metres of climb, or the tube vanishes around you with the eye still in
// it. `render/elevator.ts` owns the reason and the number.

export interface ShaftSpec {
  /** The bore, in metres — `HangarSpec.boreRadius`, so the tube fits the hole. */
  readonly radius: number
  /**
   * Where the tube starts, in the platform's resting frame.
   *
   * BELOW the room's ceiling, on purpose. The ceiling's bore ring is jittered
   * by up to `jitter` in every axis, and a tube whose foot sat exactly at
   * `ceilingY` would meet it with a ring of gaps the sky shows through. Sunk a
   * few jitters into the room instead, the foot overlaps the ceiling however
   * the dice fell, and what you see from the chair is a collar coming down
   * through the ceiling — which is what a lift shaft entering a room looks
   * like.
   */
  readonly footY: number
  /**
   * The mouth, in the same frame. Where the platform's top surface arrives.
   *
   * Not a segment top and not a trigger height: the lift stops with its deck
   * flush with this rim, like a lift arriving at a floor, and the eye leaves
   * the tube on the way there. `render/elevator.ts` derives it from the rise
   * and the platform offsets and says why the world has to be on before the
   * eye gets here.
   */
  readonly rimY: number
  /** Vertical facet band, in metres. A third of a segment, so the crunch is readable at speed. */
  readonly ringSpacing: number
  /** How far the mouth's collar reaches outward from the wall, in metres. */
  readonly lip: number
  readonly sides: number
  readonly jitter: number
}

/**
 * A shaft to fit a room: the bore's radius, the room's sides and jitter, and a
 * foot sunk five jitters below the ceiling so no roll of the dice opens a gap.
 */
export const shaftSpecFor = (hangar: HangarSpec, rimY: number): ShaftSpec => ({
  radius: hangar.boreRadius,
  footY: hangar.ceilingY - hangar.jitter * 5,
  rimY,
  ringSpacing: SHAFT_SEGMENT_SPACING / 3,
  lip: hangar.boreRadius * 0.25,
  sides: hangar.sides,
  jitter: hangar.jitter,
})

/** Every third band — one per 12 m segment — is the ceiling's darker grey, so the tube reads as JOINED segments rather than one pipe. */
const SHAFT_BANDS_PER_SEGMENT = 3

/**
 * Build the tube.
 *
 * Rings of shared, jittered vertices from the foot to the rim, quad bands
 * between them wound INWARD like the room's wall — you are inside this for
 * fifteen seconds and outside it for the rest of the run, so the renderer draws
 * both sides — and a flat collar at the mouth wound to face UP.
 *
 * The rim ring is NOT jittered in y. The deck arrives flush with it, and a rim
 * that wandered a third of a metre would have the platform stopping visibly
 * above the lip on one side and below it on the other.
 */
export const generateShaft = (spec: ShaftSpec, seed: number): HangarMesh => {
  const rnd = makeRandom(seed)
  const n = spec.sides

  // ── the rings ───────────────────────────────────────────────────────────
  //
  // Evenly spaced from the foot, with the last one pinned to the rim: the
  // topmost band is whatever is left over rather than the rim drifting.
  const ys: number[] = []
  for (let y = spec.footY; y < spec.rimY - spec.ringSpacing * 0.5; y += spec.ringSpacing) ys.push(y)
  ys.push(spec.rimY)
  const rimRing = ys.length - 1

  const ring = (radius: number, y: number, jitterY: number): Float32Array => {
    const out = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      out[i * 3] = Math.cos(a) * radius + (rnd() * 2 - 1) * spec.jitter
      out[i * 3 + 1] = y + (rnd() * 2 - 1) * jitterY
      out[i * 3 + 2] = Math.sin(a) * radius + (rnd() * 2 - 1) * spec.jitter
    }
    return out
  }
  const wallRings = ys.map((y, k) => ring(spec.radius, y, k === rimRing ? 0 : spec.jitter))
  // The collar's outer edge, flat, at the rim.
  const lipRing = ring(spec.radius + spec.lip, spec.rimY, 0)

  // (rings - 1) wall bands of 2n triangles, plus a collar of 2n.
  const triangleCount = (ys.length - 1) * n * 2 + n * 2
  const positions = new Float32Array(triangleCount * 9)
  const normals = new Float32Array(triangleCount * 9)
  const colors = new Float32Array(triangleCount * 9)
  let t = 0

  const emit = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    rgb: readonly number[],
  ) => {
    const o = t * 9
    writeFlatTri(positions, normals, o, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
    // The room's per-face shade, for the room's reason: there is no sun in
    // here, and the strips alone would leave the facets one flat grey.
    const shade = 0.82 + rnd() * 0.36
    for (let k = 0; k < 3; k++) {
      colors[o + k * 3] = (rgb[0] as number) * shade
      colors[o + k * 3 + 1] = (rgb[1] as number) * shade
      colors[o + k * 3 + 2] = (rgb[2] as number) * shade
    }
    t++
  }
  const at = (r: Float32Array, i: number): [number, number, number] => {
    const j = (i % n) * 3
    return [r[j] as number, r[j + 1] as number, r[j + 2] as number]
  }

  // ── the wall bands, wound inward ────────────────────────────────────────
  for (let band = 0; band < ys.length - 1; band++) {
    const lo = wallRings[band] as Float32Array
    const hi = wallRings[band + 1] as Float32Array
    const rgb =
      band % SHAFT_BANDS_PER_SEGMENT === SHAFT_BANDS_PER_SEGMENT - 1 ? CEILING_RGB : WALL_RGB
    for (let i = 0; i < n; i++) {
      emit(at(lo, i), at(hi, i + 1), at(hi, i), rgb)
      emit(at(lo, i), at(lo, i + 1), at(hi, i + 1), rgb)
    }
  }

  // ── the collar at the mouth, wound to face up ───────────────────────────
  //
  // Seen from above once you are out, and from below while you are not — the
  // renderer draws both sides. Up is the side the sun can reach.
  const rim = wallRings[rimRing] as Float32Array
  for (let i = 0; i < n; i++) {
    emit(at(rim, i), at(lipRing, i + 1), at(lipRing, i), WALL_RGB)
    emit(at(rim, i), at(rim, i + 1), at(lipRing, i + 1), WALL_RGB)
  }

  return { positions, normals, colors, triangleCount }
}

// ══ THE ROOM'S DRESSING ═══════════════════════════════════════════════════
//
// Matt, 2026-09-16: *"let's spruce up the underground hangar a bit."*
//
// What 2016's room had, counted off `Prefabs/Environment_Hangar.prefab` on
// 2026-09-16 (144 GameObjects, 63 renderers, no nested prefabs): it is a
// COMBINED-MESH room, not a dressed set. `botfloor_room.asset` is the whole
// shell in one mesh (AABB 43.4 x 7.2 x 40.7 units), `botfloor_startingArea`
// and `botfloor_startingArea2` are the stepped block the ships stand on, and
// each of the eight shaft segments carries one `walls_and_pillars_pwn`, one
// `pipes_LOD3_pwn` cluster (AABB extent (5.55, 6.04, 3.79) at scale 0.2326 —
// **2.6 x 2.8 x 1.8 m** of pipe per segment) and one `vent`. Two lights: a
// 72-degree spot straight down over the jet and a directional key. No lamps
// as objects, no crates, no signage: the signage is the floating labels.
//
// The 2016 gameplay video (youtu.be/1-Sf7TiHPsg, 0:25–0:45, 4:40–4:52 and
// 9:20–9:40) shows what the combined meshes were: heavy dark GIRDERS overhead
// in a truss, dark vertical PIPES on the walls with yellow valve handles, and
// the two ships standing on a lit, two-tier PLINTH of warm tan facets. Those
// three are what this generates — in the house register (one colour a face,
// no texture, nothing glowing but a lamp), in the room's frame, from the room's
// own numbers, and pure. It was written when rule 7 barred the 2016 geometry
// (the `_pwn` conversions are PolyWorld, `botfloor_*` is combined from bought
// packs), so it was built from the COUNTS and SIZES above, and where a number
// below is 2016's it says so. Since the rule was revised (2026-09-23) the
// combined meshes themselves are drawn over it — DEV-430 in the menu, DEV-438
// in the launch — and this dressing stays as what stands until they land.
//
// The LAMPS are not moved: the menu room's on the axis at +5.9 m, the launch
// room's at (0.7 R, wallTopY − 1.2, 0) (DEV-115). Girders start at the wall
// top and rise inward, so over the launch lamp they are metres above it;
// pipes stand in the bays BETWEEN the strip bars at the wall; the plinth is
// on the floor. `tests/unit/hangar-dressing.test.ts` measures the clearances.

export interface DressingOptions {
  /**
   * The stepped plinth under the parked ship. The MENU room has it — that is
   * where 2016 stood its jets. The LAUNCH room does not: the platform rises
   * through the same footprint, and a plinth under a platform is two floors.
   */
  readonly plinth: boolean
}

/**
 * The plinth's two tiers, as ratios of the bore and metres of rise.
 *
 * The upper tier has to carry the parked HoverJet (hull ±3.65 m, span ±3.08 m,
 * measured off `hoverjet-exterior.glb` on the DEV-139 sweep) with a margin;
 * the lower tier stays inside the bore so the floor around the bore is the
 * floor it was. 0.28 + 0.30 m is a step and a step — the video's plinth is
 * knee-high against the pilot standing beside it (0:30).
 */
export const PLINTH = {
  lowerRadiusOfBore: 0.92,
  lowerRise: 0.28,
  upperRadiusOfBore: 0.72,
  upperRise: 0.3,
} as const

/** Where the parked ship's wheels go when the plinth is present: the upper tier's top. */
export const plinthTopY = (spec: HangarSpec): number =>
  spec.floorY + PLINTH.lowerRise + PLINTH.upperRise

/** The pipe cluster's footprint, 2016's own: `pipes_LOD3_pwn` extents x 0.2326. */
export const PIPE_CLUSTER = { width: 2.58, depth: 1.76 } as const

/** Which of the room's `sides` bays carry a pipe cluster. Four, off the seat's own bay. */
export const PIPE_BAYS: readonly number[] = [1, 4, 7, 10]

/** Warm tan, the video's plinth. Top faces and risers, two shades, linear RGB. */
const PLINTH_TOP_RGB = [0.26, 0.19, 0.13] as const
const PLINTH_RISER_RGB = [0.19, 0.135, 0.095] as const
/** Girders: a mid grey a step above the wall, so they read against the dark ceiling. */
const GIRDER_RGB = [0.11, 0.115, 0.125] as const
/** Pipes: a dark, slightly green-grey iron. */
const PIPE_RGB = [0.058, 0.064, 0.06] as const
/** The valve handle — 2016's pipes carried yellow ones (video 4:40). One face, one colour, no glow. */
const VALVE_RGB = [0.55, 0.4, 0.06] as const

type P3 = readonly [number, number, number]

/**
 * A flat-shaded triangle writer with the room's own per-face shade, sized up
 * front. `generateHangar` and `generateShaft` keep their own closures (they
 * predate it, count their triangles up front, and are pinned by tests to the
 * byte); all three now write positions and normals through `writeFlatTri`.
 */
const builder = (capacity: number, rnd: () => number) => {
  const positions = new Float32Array(capacity * 9)
  const normals = new Float32Array(capacity * 9)
  const colors = new Float32Array(capacity * 9)
  let t = 0
  const tri = (a: P3, b: P3, c: P3, rgb: readonly number[]) => {
    if (t >= capacity) throw new Error(`hangar dressing: more than ${capacity} triangles`)
    const o = t * 9
    writeFlatTri(positions, normals, o, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
    const shade = 0.82 + rnd() * 0.36
    for (let k = 0; k < 3; k++) {
      colors[o + k * 3] = (rgb[0] as number) * shade
      colors[o + k * 3 + 1] = (rgb[1] as number) * shade
      colors[o + k * 3 + 2] = (rgb[2] as number) * shade
    }
    t++
  }
  /**
   * A prism between two rings of equal length, wound so its sides face OUT
   * (a thing seen from outside — the opposite of the room's wall). Rings run
   * with increasing angle about the prism's axis; `hi` is the far end. Caps
   * are fans.
   */
  const prism = (lo: readonly P3[], hi: readonly P3[], rgb: readonly number[], caps: boolean) => {
    const n = lo.length
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      tri(lo[i] as P3, hi[j] as P3, lo[j] as P3, rgb)
      tri(lo[i] as P3, hi[i] as P3, hi[j] as P3, rgb)
    }
    if (!caps) return
    const centre = (r: readonly P3[]): P3 => {
      let x = 0
      let y = 0
      let z = 0
      for (const p of r) {
        x += p[0]
        y += p[1]
        z += p[2]
      }
      return [x / n, y / n, z / n]
    }
    const ct = centre(hi)
    const cb = centre(lo)
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      tri(ct, hi[j] as P3, hi[i] as P3, rgb)
      tri(cb, lo[i] as P3, lo[j] as P3, rgb)
    }
  }
  const finish = (): HangarMesh => ({
    positions: positions.subarray(0, t * 9),
    normals: normals.subarray(0, t * 9),
    colors: colors.subarray(0, t * 9),
    triangleCount: t,
  })
  return { tri, prism, finish }
}

/** A regular ring of `sides` points about the y axis at (cx, y, cz). */
const ring = (
  cx: number,
  y: number,
  cz: number,
  radius: number,
  sides: number,
  phase = 0,
): P3[] => {
  const out: P3[] = []
  for (let i = 0; i < sides; i++) {
    const a = phase + (i / sides) * Math.PI * 2
    out.push([cx + Math.cos(a) * radius, y, cz + Math.sin(a) * radius])
  }
  return out
}

/**
 * A rectangle of four points through `c` spanned by unit vectors `u` (half
 * `hw`) and `v` (half `hh`). A prism from one of these to another displaced
 * along `u x v` has outward sides.
 */
const rect = (c: P3, u: P3, hw: number, v: P3, hh: number): P3[] => [
  // Ordered NEGATIVE about `u x v` — the same sense `ring()` runs about +y
  // (x toward z is a negative turn about +y) — so `prism` winds both alike.
  [c[0] - u[0] * hw - v[0] * hh, c[1] - u[1] * hw - v[1] * hh, c[2] - u[2] * hw - v[2] * hh],
  [c[0] - u[0] * hw + v[0] * hh, c[1] - u[1] * hw + v[1] * hh, c[2] - u[2] * hw + v[2] * hh],
  [c[0] + u[0] * hw + v[0] * hh, c[1] + u[1] * hw + v[1] * hh, c[2] + u[2] * hw + v[2] * hh],
  [c[0] + u[0] * hw - v[0] * hh, c[1] + u[1] * hw - v[1] * hh, c[2] + u[2] * hw - v[2] * hh],
]

const cross = (a: P3, b: P3): P3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

/**
 * Girders, pipes and (optionally) the plinth, as one mesh in the room's frame.
 *
 * Deterministic: the seed drives the per-face shade and the plinth's small
 * jitter, and nothing else is random. The same seed is the same dressing.
 */
export const generateHangarDressing = (
  spec: HangarSpec,
  seed: number,
  opts: DressingOptions,
): HangarMesh => {
  const rnd = makeRandom(seed ^ 0x44524553)
  const n = spec.sides
  const b = builder(4096, rnd)

  // ── girders: one radial beam per crease, and the ring they bear on ────────
  //
  // From the wall top to the bore, at the room's own vertex angles so each
  // sits on a crease of the revolve. Section 0.45 x 0.7 m — heavy enough to
  // read as structure at 10 m, not so heavy as to roof the room over.
  const beamHalfWidth = 0.225
  const beamHalfDepth = 0.35
  const rOuter = spec.roomRadius - 0.3
  const rInner = spec.boreRadius + 0.3
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const cx = Math.cos(a)
    const cz = Math.sin(a)
    const lo: P3 = [cx * rOuter, spec.wallTopY, cz * rOuter]
    const hi: P3 = [cx * rInner, spec.ceilingY, cz * rInner]
    const d: P3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
    const dl = Math.hypot(d[0], d[1], d[2])
    const axis: P3 = [d[0] / dl, d[1] / dl, d[2] / dl]
    const tangent: P3 = [-cz, 0, cx]
    // `tangent x up` must point along the axis for outward sides: up = axis x tangent.
    const up = cross(axis, tangent)
    b.prism(
      rect(lo, tangent, beamHalfWidth, up, beamHalfDepth),
      rect(hi, tangent, beamHalfWidth, up, beamHalfDepth),
      GIRDER_RGB,
      true,
    )
  }
  // The bearing ring at the wall top: n straight segments, a box each.
  const ringR = spec.roomRadius - 0.35
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2
    const a1 = ((i + 1) / n) * Math.PI * 2
    const p0: P3 = [Math.cos(a0) * ringR, spec.wallTopY - 0.1, Math.sin(a0) * ringR]
    const p1: P3 = [Math.cos(a1) * ringR, spec.wallTopY - 0.1, Math.sin(a1) * ringR]
    const d: P3 = [p1[0] - p0[0], 0, p1[2] - p0[2]]
    const dl = Math.hypot(d[0], d[2])
    const axis: P3 = [d[0] / dl, 0, d[2] / dl]
    const upv: P3 = [0, 1, 0]
    // `radial x up` must point along the axis: radial = up x axis.
    const radial = cross(upv, axis)
    b.prism(rect(p0, radial, 0.25, upv, 0.25), rect(p1, radial, 0.25, upv, 0.25), GIRDER_RGB, false)
  }

  // ── pipes: a cluster in four bays, between the strip bars ─────────────────
  //
  // 2016's cluster footprint (2.58 x 1.76 m) stood 2.8 m tall per segment;
  // here the two big runs go floor to wall top, the register's vertical, and
  // the footprint is 2016's. Each: two tall hexagonal runs, a thin third, a
  // valve block on the tallest with a yellow handle, and an elbow into the wall.
  const pipeR = spec.roomRadius - 0.45
  for (const bay of PIPE_BAYS) {
    const a = ((bay + 0.5) / n) * Math.PI * 2
    const cx = Math.cos(a)
    const cz = Math.sin(a)
    const tx = -cz
    const tz = cx
    const at = (along: number, inward: number): [number, number] => [
      cx * (pipeR - inward) + tx * along,
      cz * (pipeR - inward) + tz * along,
    ]
    const runs = [
      { along: -PIPE_CLUSTER.width * 0.3, inward: 0.2, radius: 0.22, top: spec.wallTopY },
      { along: PIPE_CLUSTER.width * 0.12, inward: 0.28, radius: 0.16, top: spec.wallTopY },
      { along: PIPE_CLUSTER.width * 0.36, inward: 0.12, radius: 0.1, top: spec.wallTopY * 0.55 },
    ] as const
    for (const run of runs) {
      const [px, pz] = at(run.along, run.inward)
      b.prism(
        ring(px, spec.floorY, pz, run.radius, 6),
        ring(px, run.top, pz, run.radius, 6),
        PIPE_RGB,
        true,
      )
    }
    // Valve block on the big run, a third of the way up, with its handle facing the room.
    const big = runs[0]
    const [vx, vz] = at(big.along, big.inward + 0.05)
    const vy = spec.floorY + spec.wallTopY * 0.33
    b.prism(
      ring(vx, vy - 0.22, vz, 0.34, 6, Math.PI / 6),
      ring(vx, vy + 0.22, vz, 0.34, 6, Math.PI / 6),
      PIPE_RGB,
      true,
    )
    const [hx, hz] = at(big.along, big.inward + 0.55)
    b.prism(ring(hx, vy - 0.05, hz, 0.19, 8), ring(hx, vy + 0.05, hz, 0.19, 8), VALVE_RGB, true)
    // Elbow: a short horizontal stub from the second run into the wall, near the top.
    const mid = runs[1]
    const [ex, ez] = at(mid.along, mid.inward)
    const ey = spec.wallTopY - 1.9
    const r = mid.radius * 0.9
    const tangent: P3 = [tx, 0, tz]
    const upv: P3 = [0, 1, 0]
    // Displaced OUTWARD, into the wall, along up x tangent = (cx, 0, cz).
    b.prism(
      rect([ex, ey, ez], upv, r, tangent, r),
      rect([ex + cx * (mid.inward + 0.3), ey, ez + cz * (mid.inward + 0.3)], upv, r, tangent, r),
      PIPE_RGB,
      false,
    )
  }

  // ── the plinth ────────────────────────────────────────────────────────────
  if (opts.plinth) {
    const tiers = [
      {
        radius: spec.boreRadius * PLINTH.lowerRadiusOfBore,
        y0: spec.floorY,
        y1: spec.floorY + PLINTH.lowerRise,
      },
      {
        radius: spec.boreRadius * PLINTH.upperRadiusOfBore,
        y0: spec.floorY + PLINTH.lowerRise,
        y1: plinthTopY(spec),
      },
    ]
    for (const tier of tiers) {
      // Jittered in the plane only, a third of the room's, so the tiers read as
      // cut slabs and the top stays a flat surface a ship can stand on.
      const lo = ring(0, tier.y0, 0, tier.radius, n, Math.PI / n).map(
        (p): P3 => [
          p[0] + (rnd() * 2 - 1) * spec.jitter * 0.3,
          p[1],
          p[2] + (rnd() * 2 - 1) * spec.jitter * 0.3,
        ],
      )
      const hi = lo.map((p): P3 => [p[0], tier.y1, p[2]])
      // Risers in the darker shade, the top in the lighter: caps drawn separately.
      b.prism(lo, hi, PLINTH_RISER_RGB, false)
      const c: P3 = [0, tier.y1, 0]
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        b.tri(c, hi[j] as P3, hi[i] as P3, PLINTH_TOP_RGB)
      }
    }
  }

  return b.finish()
}
