// src/sim/props/dressing.ts — familiar-size objects, placed by RULE.
//
// ANNIVERSARY.md §1.5 item 6 / §3.2 V9, DEV-089. The meshes are
// `generate-shapes.ts` and `generate-bird.ts`; this is where they go.
//
// ── Why a rule and not a density map ─────────────────────────────────────
//
// `sim/props/scatter.ts` is 2016's generator and it reads a World Machine
// density map: one roll per texel against `grayscale * probabilityScale`. Those
// maps are the PALMS' — `islands_02_trees.png` is a painted forest mask, and
// PROP-AUDIT §4 established the palms' placements are pure generator output
// baked once. They say where 2016 wanted trees. They say nothing about where a
// boulder goes, and there is no second map to read: a boulder goes on a steep
// slope or at the foot of a cliff, a shrub goes on gentle ground, a rock goes
// near the shoreline. Those are statements about the TERRAIN, and the terrain is
// already in memory.
//
// So this is a second, independent placement pass with the same guarantees as
// the first — seeded, pure, deterministic — and a different input: the height
// map instead of a density map.
//
// ── What the rules are ───────────────────────────────────────────────────
//
// One Bernoulli roll per cell of the terrain's own grid (`step`, the
// `baseResolution` the collider and the mesh are both built on — 8 m on every
// shipped environment). Using the terrain's lattice rather than an invented one
// echoes 2016's one-roll-per-texel and needs no constant of its own. `density`
// is per SQUARE KILOMETRE of terrain, so the probability per cell is
// `density * step² / 1e6` and the number in the preset is a quantity a person
// can picture. A hit is then jittered inside its cell, so nothing reads as a
// grid.
//
// Then five gates. The first four are in the order that rejects the most for the
// least work; the fifth comes AFTER the appearance draws, on purpose (see it):
//
//   1. SLOPE — `sin` of the ground's angle, 0 flat and 1 vertical. Boulders
//      live on steep ground and at cliff feet; shrubs on gentle ground.
//   2. ALTITUDE — world metres, or metres above the LOCAL water surface when
//      `nearWater` is set. One flag, one meaning: it changes what the band is
//      measured FROM, which is how a shoreline band gets written without a
//      second pair of keys.
//   3. ROUTE CLEARANCE — `routeDistance`, which is metres from the LINE and not
//      from the nearest control point (DEV-027, and see that function).
//   4. GATE CLEARANCE — the same radius against every ring centre. Belt and
//      braces: the gates sit ON the line to 0.4 m so rule 3 already covers them
//      on every shipped course, and a rule that is only true because of a
//      measurement someone else made is a rule worth stating separately.
//   5. SPAWN CLEARANCE — DEV-100's cylinders, the ones the 2016 scatter was
//      baked against, read off the environment JSON's own receipt (DEV-103).
//      TWO dimensions where rule 3 is three, and both are right: a route is
//      hundreds of points and a horizontal rule there carves a bald corridor
//      down the course; a spawn is one point per mission, and what is kept off
//      it is the launch structure's footprint, which a 0.5 m rock stands on as
//      surely as a 60 m tree. Checked AFTER the seven appearance draws, so a
//      placement cleared off a pad leaves every other one bit-identical — the
//      clearing SUBTRACTS and moves nothing, which is the design `scatter.ts`
//      states for DEV-100 and `dressing.test.ts` asserts here.
//   6. NO-PROP VOLUMES — DEV-287's AUTHORED capsules, in the same frame and
//      through the same test as rule 5, from a list of their own because the
//      two have different provenance. Matt places them where he does not want
//      scenery: a corridor off the launch pad, a tree out of the title
//      screen's foreground. They clear the ROCKS as well as the trees, because
//      a boulder in the flight path is the same problem as a tree is.
//
// ── The frame everything is in, and why ──────────────────────────────────
//
// Placements come out in TERRAIN MESH-LOCAL metres: x and z run 0..terrainSize,
// y is metres above the terrain's own origin. That is the frame
// `game/props/load-props.ts` already works in, and it is what lets the finished
// group be parented to the terrain group and inherit `worldOffset + localPos +
// envRoot` for free. DEV-042 cost a session to the alternative — a second copy
// of that sum, which drifts the moment one copy learns about a parent the other
// does not. **Compose the parent chain; do not re-derive it.**
//
// The route and the gates arrive in SIM WORLD space, because that is what
// `createRoute` produces, so the conversion happens HERE, once, in `meshToSim`.
// The transform comes off the terrain's own `HeightField`, which is the object
// that owns it — `PropTerrain` is a structural subset of that interface, so the
// caller passes `terrain.heightField` and there is nothing to get wrong.
//
// ── Two sources, two questions, no overlap ───────────────────────────────
//
// `heightMap` answers *how high is the ground*: the unjittered source map,
// sampled bilinearly, exactly as `scatter.ts` samples it for the palms and as
// `GenerateObjects` sampled it in 2016 (PROP-AUDIT §3.3 — props sit on the
// smooth surface and ignore the mesh's ±0.8 m `RandomOffset`; `sink` on each
// shape is what hides the difference). `terrain` answers *where is the
// terrain*, and carries no heights at all. Neither can disagree with the other
// because neither holds the other's quantity.
//
// SIM LAYER: pure. No three, no DOM, no `Math.random`, no wall clock.

import { v3 } from '@/sim/math/vec3'
import { type Clearing, insideAnyClearing } from '@/sim/props/clearing'
import {
  type BirdPlacement,
  birdAt,
  birdPose,
  type FlockPlacement,
  flockPeriod,
} from '@/sim/props/generate-bird'
import { PROP_KINDS, type PropKind } from '@/sim/props/generate-shapes'
import { type Route, routeAt, routeDistance } from '@/sim/route'
import { grayscale, makeRandom } from '@/sim/terrain/faceted'
import { type HeightField, terrainHeightAt } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'

/**
 * Where the terrain is and how big it is — and NOT how high it is.
 *
 * A structural subset of `HeightField`, so `terrain.heightField` satisfies it
 * as-is. Written as its own interface rather than taking a `HeightField`
 * because this module must not be able to ask that object for a height: it has
 * one (the collider grid, at `step` metres) and the props use the other (the
 * source map, bilinear), and an interface that offers both is an interface
 * somebody will read the wrong one out of.
 */
export interface PropTerrain {
  /** `TerrainSize`, metres. 4096 on three environments, 8192 on kauai. */
  readonly terrainSize: number
  /** `TerrainHeight`, metres. */
  readonly terrainHeight: number
  /** Metres per grid step — `baseResolution`. The lattice a roll happens on. */
  readonly step: number
  /** The terrain transform, SIM (Unity) space. Mesh space is 0..terrainSize. */
  readonly originX: number
  readonly originY: number
  readonly originZ: number
  readonly scaleX: number
  readonly scaleY: number
  readonly scaleZ: number
}

/** One class of object, and the band of ground it belongs on. */
export interface DressingBand {
  readonly kind: PropKind
  /** Instances per square kilometre of TERRAIN, before the bands reject any. */
  readonly density: number
  /** Metres ACROSS, at the low end. The mesh is 1 m wide, so this multiplies directly. */
  readonly scaleMin: number
  readonly scaleMax: number
  /** `sin` of the ground's angle: 0 is flat, 0.5 is 30°, 1 is a cliff. */
  readonly slopeMin: number
  readonly slopeMax: number
  /** Metres. World y, or metres above the local water surface when `nearWater`. */
  readonly altitudeMin: number
  readonly altitudeMax: number
  /**
   * Measure the altitude band from the WATER rather than from world zero.
   *
   * One flag with one meaning, and it is what writes a shoreline band without a
   * second pair of keys. An environment with no ocean — desert — places nothing
   * from a `nearWater` band at all, which is right: there is no shore in a
   * canyon.
   */
  readonly nearWater: boolean
  /** 0..1: how far the instance colour is pulled toward the ground's own colour. */
  readonly tint: number
  /** Linear RGB triples. The instance picks one uniformly. */
  readonly palette: readonly (readonly number[])[]
  /** Environment ids this band applies to. Empty or absent means every environment. */
  readonly environments?: readonly string[]
}

export interface DressingSpec {
  readonly seed: number
  /**
   * Metres of clear air around the racing line and every gate centre.
   *
   * Measured in THREE dimensions to the LINE, so a boulder on the ground under a
   * route point 300 m up is not in the way and is not rejected.
   */
  readonly clearance: number
  /**
   * How many seeded mesh variants each kind draws from.
   *
   * Here rather than left to the renderer because a placement stores a variant
   * INDEX, and an index whose range the producer does not know is an index the
   * consumer has to take modulo something — which is how a layout silently
   * changes when somebody adds a fifth boulder.
   */
  readonly variants: number
  readonly bands: readonly DressingBand[]
}

/** One kind's placements, flat and transferable — the shape an InstancedMesh wants. */
export interface DressingPlacements {
  readonly kind: PropKind
  readonly count: number
  /** `count * 3`, TERRAIN MESH-LOCAL metres. */
  readonly positions: Float32Array
  /** `count`, radians about the vertical. */
  readonly yaw: Float32Array
  /** `count`, radians the prop leans out of vertical. A rock does not stand up straight. */
  readonly tilt: Float32Array
  /** `count`, radians: which way it leans. */
  readonly tiltDir: Float32Array
  /** `count`, metres across — inside `[scaleMin, scaleMax]` by construction. */
  readonly scale: Float32Array
  /** `count`, the vertical multiplier on top of `scale`. Squat ones and tall ones. */
  readonly squash: Float32Array
  /** `count`, which generated variant to draw. */
  readonly variant: Uint8Array
  /** `count * 3`, linear RGB: the palette colour pulled `tint` of the way to the ground's. */
  readonly color: Float32Array
}

const TAU = Math.PI * 2

/** Mesh-local x,z to SIM world. The ONE conversion, and it is the terrain's own transform. */
export const meshToSim = (
  terrain: PropTerrain,
  mx: number,
  my: number,
  mz: number,
): { x: number; y: number; z: number } => ({
  x: terrain.originX + mx * terrain.scaleX,
  y: terrain.originY + my * terrain.scaleY,
  z: terrain.originZ + mz * terrain.scaleZ,
})

/**
 * Module-level scratch, one per QUESTION rather than one shared.
 *
 * Trap 19: a volatile scratch is valid only inside one synchronous call, and the
 * failure mode is reading one a previous call left behind. Two of them, named
 * for what they hold, costs nothing and makes "the ground sample" and "the
 * colour sample" impossible to confuse for each other.
 */
const _ground: Rgb = { r: 0, g: 0, b: 0 }
const _tint: Rgb = { r: 0, g: 0, b: 0 }
const _here = v3()

/**
 * Ground height at a mesh-local point, in mesh-local metres.
 *
 * `u = mx / terrainSize` is `scatter.ts`'s `u = x / width` written in metres:
 * that loop's `wx = x * terrainSize / width`, so the two are the same number and
 * this is the same bilinear sample of the same imported texture.
 */
export const groundAt = (
  heightMap: MapSampler,
  terrain: PropTerrain,
  mx: number,
  mz: number,
): number => {
  heightMap.sample(mx / terrain.terrainSize, mz / terrain.terrainSize, _ground)
  return grayscale(_ground.r, _ground.g, _ground.b) * terrain.terrainHeight
}

/**
 * `sin` of the ground's angle at a mesh-local point: 0 flat, 1 vertical.
 *
 * A central difference over one grid step, converted into WORLD units before
 * the angle is taken — `scaleY / scaleX` — so "slope 0.5" means thirty degrees
 * of real hillside rather than thirty degrees of some mesh-space quantity that
 * happens to coincide when the scale is 1. Every shipped environment has a unit
 * scale today, so the two agree everywhere anyone would look; that is exactly
 * the case the agreement lesson says to write out rather than assume.
 */
export const slopeAt = (
  heightMap: MapSampler,
  terrain: PropTerrain,
  mx: number,
  mz: number,
): number => {
  const d = terrain.step
  const hl = groundAt(heightMap, terrain, mx - d, mz)
  const hr = groundAt(heightMap, terrain, mx + d, mz)
  const hd = groundAt(heightMap, terrain, mx, mz - d)
  const hu = groundAt(heightMap, terrain, mx, mz + d)
  const gx = (((hr - hl) / (2 * d)) * terrain.scaleY) / (terrain.scaleX || 1)
  const gz = (((hu - hd) / (2 * d)) * terrain.scaleY) / (terrain.scaleZ || 1)
  const g = Math.hypot(gx, gz)
  // tan -> sin. Bounded in 0..1 whatever the gradient does, which is what makes
  // `slopeMin`/`slopeMax` readable numbers in a JSON file.
  return g / Math.sqrt(1 + g * g)
}

/** Does this band apply to this environment? An absent or empty list means all of them. */
export const bandApplies = (band: DressingBand, environmentId: string): boolean =>
  !band.environments || band.environments.length === 0 || band.environments.includes(environmentId)

/** Everything a placement pass needs. */
export interface DressingInput {
  readonly environmentId: string
  readonly terrain: PropTerrain
  /** The height map as `importUnityTexture` built it — never a bare sampler (DEV-007). */
  readonly heightMap: MapSampler
  /** The terrain's colour map, for the per-instance tint. Null skips the tint. */
  readonly colorMap: MapSampler | null
  /** The OCEAN's collision surface, or null where there is no sea. `nearWater` bands need it. */
  readonly water: HeightField | null
  /** The authored racing line, SIM world space. Null on a course that has none. */
  readonly route: Route | null
  /** Ring centres, SIM world space. `Gate.centre` is already this. */
  readonly gates: readonly { readonly x: number; readonly y: number; readonly z: number }[]
  /**
   * DEV-100's spawn cylinders — TERRAIN MESH-LOCAL, the frame `positions` is
   * in and the frame `content/environments/*.json` records them in, so no
   * conversion happens between the receipt and the test. Empty clears nothing.
   * DEV-103.
   */
  readonly spawnClearings: readonly Clearing[]
  /**
   * DEV-287's AUTHORED volumes, same frame and same test, separate list.
   *
   * Separate because the two have different provenance — one is derived from
   * a launch deck by a tool, the other is art direction in
   * `content/no-prop-volumes.json` — and because a receipt that said
   * "5 clearings" over a mix of the two could not tell you which had done the
   * clearing. Empty on every environment nobody has authored volumes for.
   */
  readonly noPropVolumes: readonly Clearing[]
  readonly spec: DressingSpec
}

/** Is this SIM-world point far enough from everything the player flies through? */
const isClear = (input: DressingInput, x: number, y: number, z: number): boolean => {
  const c = input.spec.clearance
  if (!(c > 0)) return true
  if (input.route && routeDistance(input.route, { x, y, z }) < c) return false
  for (const g of input.gates) {
    const dx = g.x - x
    const dy = g.y - y
    const dz = g.z - z
    if (dx * dx + dy * dy + dz * dz < c * c) return false
  }
  return true
}

/**
 * Place one band's props.
 *
 * Exported on its own so a test can drive a single rule against a synthetic
 * height map without building a whole environment.
 */
export const placeBand = (input: DressingInput, band: DressingBand): DressingPlacements => {
  const { terrain, heightMap, colorMap } = input
  const empty = {
    kind: band.kind,
    count: 0,
    positions: new Float32Array(0),
    yaw: new Float32Array(0),
    tilt: new Float32Array(0),
    tiltDir: new Float32Array(0),
    scale: new Float32Array(0),
    squash: new Float32Array(0),
    variant: new Uint8Array(0),
    color: new Float32Array(0),
  }
  if (!bandApplies(band, input.environmentId)) return empty
  // A shoreline band with no shore. Not an error — desert has no ocean and
  // `environmentTerrains` returns null for it, so the rule simply has no ground
  // to stand on.
  if (band.nearWater && !input.water) return empty
  if (!(band.density > 0) || band.palette.length === 0) return empty

  const step = terrain.step
  const cells = Math.max(1, Math.floor(terrain.terrainSize / step))
  // `density` is per km²; a cell is `step²` m². 8 m cells cap a band at 15,625
  // per km², which is two orders above anything anyone would author.
  const probability = Math.min(1, (band.density * step * step) / 1e6)

  // ONE stream, walked in a fixed order. The seed folds in the kind's index so
  // two bands of the same density do not land on identical cells — the same
  // trap `load-props.ts` names for alpine's two generators over one map.
  const rnd = makeRandom((input.spec.seed + PROP_KINDS.indexOf(band.kind) * 0x9e37 + 1) >>> 0)
  const scaleSpan = band.scaleMax - band.scaleMin
  const variants = Math.max(1, Math.floor(input.spec.variants))

  const pos: number[] = []
  const yaw: number[] = []
  const tilt: number[] = []
  const tiltDir: number[] = []
  const scale: number[] = []
  const squash: number[] = []
  const variant: number[] = []
  const color: number[] = []

  for (let cx = 0; cx < cells; cx++) {
    for (let cz = 0; cz < cells; cz++) {
      // The roll comes FIRST and always consumes exactly one number, so the
      // stream does not depend on how many cells the bands reject — which is
      // what makes "same seed, same layout" true across a terrain edit.
      if (rnd() >= probability) continue
      // Jittered inside the cell, so nothing reads as a lattice. Two draws,
      // taken whether or not the candidate survives, for the same reason.
      const jx = rnd()
      const jz = rnd()
      const mx = (cx + jx) * step
      const mz = (cz + jz) * step

      const my = groundAt(heightMap, terrain, mx, mz)
      const world = meshToSim(terrain, mx, my, mz)

      const altitude = band.nearWater
        ? world.y - terrainHeightAt(input.water as HeightField, world.x, world.z)
        : world.y
      if (altitude < band.altitudeMin || altitude > band.altitudeMax) continue

      const slope = slopeAt(heightMap, terrain, mx, mz)
      if (slope < band.slopeMin || slope > band.slopeMax) continue

      if (!isClear(input, world.x, world.y, world.z)) continue

      // Draw order, fixed: yaw, tilt, tilt direction, scale, squash, variant,
      // palette. Every one of them is taken for a placement the four gates
      // above ACCEPTED, so the layout above is independent of them — and all of
      // them are taken BEFORE the spawn gate below, so its rejections are
      // independent of them too.
      const yawDraw = rnd() * TAU
      // The lean is proportional to the slope: a rock on a cliff face leans off
      // it, a rock on the flat sits square. Half the slope angle, so it tips
      // toward the hill's own plane without lying down on it.
      const tiltDraw = Math.asin(Math.min(1, slope)) * 0.5 * rnd()
      const tiltDirDraw = rnd() * TAU
      const scaleDraw = band.scaleMin + rnd() * scaleSpan
      const squashDraw = 0.78 + rnd() * 0.44
      const variantDraw = Math.min(variants - 1, Math.floor(rnd() * variants))
      const pick = band.palette[
        Math.min(band.palette.length - 1, Math.floor(rnd() * band.palette.length))
      ] as readonly number[]

      // 5. DEV-103, and deliberately DOWN HERE: the seven draws above are spent
      // either way, so dropping this placement leaves every other one
      // bit-identical. In MESH space, the frame the cylinders are recorded in,
      // and a vertical cylinder needs no height. See the header.
      if (insideAnyClearing(mx, mz, input.spawnClearings)) continue

      // 6. DEV-287, right beside rule 5 and after the draws for the same
      // reason: the rocks leave alone the ground the trees leave alone, which
      // is what "no props here" has to mean or it is a rule about trees.
      if (insideAnyClearing(mx, mz, input.noPropVolumes)) continue

      yaw.push(yawDraw)
      tilt.push(tiltDraw)
      tiltDir.push(tiltDirDraw)
      scale.push(scaleDraw)
      squash.push(squashDraw)
      variant.push(variantDraw)

      let r = pick[0] ?? 1
      let g = pick[1] ?? 1
      let b = pick[2] ?? 1
      if (colorMap && band.tint > 0) {
        // The GROUND's own colour, raw.
        //
        // NOT converted out of sRGB, and that is deliberate: `render/
        // terrain-mesh.ts` writes the colour map's bytes straight into the
        // terrain's vertex colours because 2016's shader did (`baseColor *=
        // IN.color` multiplied an sRGB number into a linear albedo). A prop
        // that linearised first would be a different green from the hillside it
        // is standing on, which is the one thing this tint exists to avoid.
        colorMap.sample(mx / terrain.terrainSize, mz / terrain.terrainSize, _tint)
        const t = Math.min(1, Math.max(0, band.tint))
        r += (_tint.r - r) * t
        g += (_tint.g - g) * t
        b += (_tint.b - b) * t
      }
      color.push(r, g, b)
      pos.push(mx, my, mz)
    }
  }

  return {
    kind: band.kind,
    count: yaw.length,
    positions: Float32Array.from(pos),
    yaw: Float32Array.from(yaw),
    tilt: Float32Array.from(tilt),
    tiltDir: Float32Array.from(tiltDir),
    scale: Float32Array.from(scale),
    squash: Float32Array.from(squash),
    variant: Uint8Array.from(variant),
    color: Float32Array.from(color),
  }
}

/**
 * Every band, merged into ONE set of placements per KIND.
 *
 * Per kind and not per band, because the draw-call budget is per kind
 * (ANNIVERSARY.md §5's *Measure* column for V9 is "draw calls") and two bands of
 * boulders — a steep one and a shoreline one — must not cost two. A kind that
 * ends up with nothing is omitted entirely rather than returned empty, so a
 * caller cannot build a zero-instance mesh for it.
 */
export const placeDressing = (input: DressingInput): readonly DressingPlacements[] => {
  const byKind = new Map<PropKind, DressingPlacements[]>()
  for (const band of input.spec.bands) {
    const placed = placeBand(input, band)
    if (placed.count === 0) continue
    const list = byKind.get(band.kind)
    if (list) list.push(placed)
    else byKind.set(band.kind, [placed])
  }
  const out: DressingPlacements[] = []
  // In `PROP_KINDS` order rather than in encounter order, so the draw list is
  // stable whatever order the preset happens to author its bands in.
  for (const kind of PROP_KINDS) {
    const parts = byKind.get(kind)
    if (!parts || parts.length === 0) continue
    out.push(parts.length === 1 ? (parts[0] as DressingPlacements) : mergePlacements(kind, parts))
  }
  return out
}

const mergePlacements = (
  kind: PropKind,
  parts: readonly DressingPlacements[],
): DressingPlacements => {
  let count = 0
  for (const p of parts) count += p.count
  const positions = new Float32Array(count * 3)
  const yaw = new Float32Array(count)
  const tilt = new Float32Array(count)
  const tiltDir = new Float32Array(count)
  const scale = new Float32Array(count)
  const squash = new Float32Array(count)
  const variant = new Uint8Array(count)
  const color = new Float32Array(count * 3)
  let at = 0
  for (const p of parts) {
    positions.set(p.positions, at * 3)
    color.set(p.color, at * 3)
    yaw.set(p.yaw, at)
    tilt.set(p.tilt, at)
    tiltDir.set(p.tiltDir, at)
    scale.set(p.scale, at)
    squash.set(p.squash, at)
    variant.set(p.variant, at)
    at += p.count
  }
  return { kind, count, positions, yaw, tilt, tiltDir, scale, squash, variant, color }
}

// ── Flocks ────────────────────────────────────────────────────────────────

export interface FlockSpec {
  readonly flocks: number
  readonly birdsPerFlock: number
  /** Metres above the ground under the loop's centre. */
  readonly altitude: number
  /** Metres, the loop's mean radius. */
  readonly radius: number
  /** Metres per second at that radius. */
  readonly speed: number
  /** Metres, wing tip to wing tip. A gull is about one. */
  readonly size: number
  /** Linear RGB triples. */
  readonly palette: readonly (readonly number[])[]
}

/**
 * Put the flocks on the course.
 *
 * **Near gate N, for several N, and off the line.** The gates sit ON the racing
 * line to within 0.4 m and are evenly spaced (DEV-027, `sim/route.ts`'s header),
 * so "beside gate N" and "beside the line at arc length s" are the same place —
 * and the second form works on a course whose gates this module was never handed.
 * The flocks are spread evenly along the arc so they are met one at a time
 * rather than all at once.
 *
 * The loop centre is pushed sideways until every bird on it clears
 * `spec.clearance`, and that is CHECKED rather than argued: the offset starts at
 * `clearance + radius` — which would be enough on a straight line — and the loop
 * is sampled all the way round against `routeDistance`, pushing out and trying
 * again while any sample is inside. The line bends, so the arithmetic answer is
 * not always the true one, and this is the difference between a guarantee and an
 * assumption.
 *
 * Returns fewer flocks than asked for if a course cannot fit them; zero on a
 * course with no route at all, because there is then no "beside the line".
 */
export const placeFlocks = (
  input: DressingInput,
  spec: FlockSpec,
  seed: number,
): readonly FlockPlacement[] => {
  const { route, terrain, heightMap } = input
  if (!route || spec.flocks <= 0 || spec.birdsPerFlock <= 0 || spec.palette.length === 0) return []

  const rnd = makeRandom(seed >>> 0)
  const clearance = input.spec.clearance
  const out: FlockPlacement[] = []
  const pose = birdPose()

  for (let f = 0; f < spec.flocks; f++) {
    // Evenly along the line, offset by half a step so no flock sits on the start
    // gate — which is the one place the player is guaranteed to be looking at a
    // countdown rather than at the scenery.
    const s = ((f + 0.5) / spec.flocks) * route.length
    const anchor = { ...routeAt(route, s, _here) }
    // The line's local direction, from a short chord. Its perpendicular in the
    // horizontal plane is the direction to push the flock.
    const ahead = routeAt(route, Math.min(route.length, s + terrain.step), _here)
    let tx = ahead.x - anchor.x
    let tz = ahead.z - anchor.z
    const tl = Math.hypot(tx, tz) || 1
    tx /= tl
    tz /= tl
    // Left or right, seeded, then out until it is clear.
    const side = rnd() < 0.5 ? 1 : -1

    const radiusX = spec.radius * (0.8 + rnd() * 0.4)
    const radiusZ = spec.radius * (0.8 + rnd() * 0.4)
    const heading = rnd() * TAU
    const tilt = (rnd() * 2 - 1) * 0.25
    const speed = spec.speed * (rnd() < 0.5 ? 1 : -1)

    const birds: BirdPlacement[] = []
    for (let b = 0; b < spec.birdsPerFlock; b++) {
      const pick = spec.palette[
        Math.min(spec.palette.length - 1, Math.floor(rnd() * spec.palette.length))
      ] as readonly number[]
      birds.push({
        phase: rnd(),
        spread: (rnd() * 2 - 1) * spec.radius * 0.22,
        rise: (rnd() * 2 - 1) * spec.radius * 0.12,
        size: spec.size * (0.8 + rnd() * 0.4),
        wingPhase: rnd() * TAU,
        color: [pick[0] ?? 0, pick[1] ?? 0, pick[2] ?? 0],
      })
    }

    // Push out until the whole loop is clear. Each attempt is a full sample of
    // the circuit, because the line curves and "centre is far enough" is only
    // true where it is straight.
    let placed: FlockPlacement | null = null
    for (let attempt = 0; attempt < 6; attempt++) {
      // Alternating sides as well as pushing out: a course that runs along the
      // coast has one side over open water and the other over the island, and a
      // rule that only ever goes one way loses half its flocks off the map.
      const flip = attempt % 2 === 0 ? side : -side
      const px = -tz * flip
      const pz = tx * flip
      const out0 = clearance + spec.radius * 1.6 + Math.floor(attempt / 2) * spec.radius
      const cx = anchor.x + px * out0
      const cz = anchor.z + pz * out0
      // Mesh-local, because that is the frame a placement lives in.
      const mesh = simToMesh(terrain, cx, 0, cz)
      if (
        mesh.x < 0 ||
        mesh.z < 0 ||
        mesh.x > terrain.terrainSize ||
        mesh.z > terrain.terrainSize
      ) {
        continue
      }
      const ground = groundAt(heightMap, terrain, mesh.x, mesh.z)
      const candidate: FlockPlacement = {
        centre: [mesh.x, ground + spec.altitude, mesh.z],
        radiusX,
        radiusZ,
        heading,
        tilt,
        speed,
        birds,
      }
      if (flockIsClear(input, candidate, pose)) {
        placed = candidate
        break
      }
    }
    if (placed) out.push(placed)
  }
  return out
}

/** How many samples of a lap the clearance check takes. Sixteen is every 22.5°. */
export const FLOCK_SAMPLES = 16

/** Every bird, sampled all the way round, against the line and the gates. */
export const flockIsClear = (
  input: DressingInput,
  flock: FlockPlacement,
  pose = birdPose(),
): boolean => {
  const period = flockPeriod(flock)
  if (!(period > 0)) return false
  for (const bird of flock.birds) {
    for (let i = 0; i < FLOCK_SAMPLES; i++) {
      birdAt(flock, bird, (i / FLOCK_SAMPLES) * period, pose)
      const world = meshToSim(input.terrain, pose.x, pose.y, pose.z)
      if (!isClear(input, world.x, world.y, world.z)) return false
    }
  }
  return true
}

/** SIM world back to mesh-local. The inverse of `meshToSim`, in the same file. */
export const simToMesh = (
  terrain: PropTerrain,
  x: number,
  y: number,
  z: number,
): { x: number; y: number; z: number } => ({
  x: (x - terrain.originX) / (terrain.scaleX || 1),
  y: (y - terrain.originY) / (terrain.scaleY || 1),
  z: (z - terrain.originZ) / (terrain.scaleZ || 1),
})
