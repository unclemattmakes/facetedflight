// src/game/particle-fx.ts — where the 2016 particles actually go.
//
// `render/particles.ts` is the engine; this is the wiring, and the wiring is
// where the port decisions live.
//
// ── The gate ──────────────────────────────────────────────────────────────
//
// Six live emitters, all called `ringBurst`, in two kinds:
//
//   FOUR are `looping` + `playOnAwake` at 50/s. They run CONTINUOUSLY, from
//   every gate, for the whole mission. That is not a burst despite the name —
//   a gate is permanently spraying, which is what makes the course readable
//   from a distance.
//
//   TWO are one-shot: `playOnAwake: 0`, `looping: 0`, 0.25 s long, two bursts
//   each, at 100-450 m/s. Those are the flash when you fly through.
//
// `ringIdle` is NOT one of them. Its EmissionModule is disabled, so it emits
// nothing at all — it exists only as a transform its children hang off.
//
// Budget, measured rather than feared: ~123 particles per gate at steady state,
// ~2,570 across all 21. That is small enough to run every gate at once, which is
// what 2016 did, so no distance culling and no deviation.
//
// ── The ship ──────────────────────────────────────────────────────────────
//
// Four speed-driven systems, and the thresholds come off the PREFAB because the
// C# initialisers are wrong by a factor of four:
//
//                        prefab   C# initialiser
//   flightEffects          25            5
//   boostEffects          120           32
//   boostEffects_stage2   240            -
//   boostEffects_stage3   350            -
//
// `Ship_HoverShip.Update()` plays exactly ONE boost stage at a time and stops
// the other two, so the three are mutually exclusive rather than layered. Top
// speed is 437.5, so stage 3 is the top 20 % of the envelope.
//
// That is what Classic runs, to the bit. Anniversary's `fx.speedRamp` crossfades
// the three by emission rate and ramps the first one in instead, because the
// cuts read as a switch (DEV-351). The arithmetic, and why each speed in it is
// 2016's own, is `game/speed-line-ramp.ts`; this file only applies it.
//
// Seven of the ship's seventeen are live — the four above, plus THREE
// `effect_orbCollect` systems, of which the script names one.
//
// The afterburner and thruster systems are absent from the cockpit view: all ten
// hang under `ThirdPerson` (`m_IsActive: 0`) or `playbackGhost` (also off), so
// the shipped first-person game never drew them. The six under the player's own
// `ThirdPerson` are what `updateExternal` plays once the camera is outside
// (DEV-836); the four under `playbackGhost` stay unbuilt.
//
// ── Composing the emitter transforms ──────────────────────────────────────
//
// Several emitters are nested three deep — `ringBurst (5)` sits under
// `ringBurst (2)` under `ringIdle` under `offset` — and `ringIdle` is scaled
// 1.667, so skipping the chain puts the spray in the wrong place at the wrong
// size. The extractor records every ancestor's transform; this composes them
// with `unityPose`, which is safe to do link by link because the handedness flip
// is a conjugation (see `render/unity-space.ts`).
//
// The LAST ancestor is the prefab root, and it is dropped: the gate's own world
// matrix from the level JSON replaces it.
//
// ── Two that are not 2016's (DEV-428, DEV-429, Anniversary) ───────────────
//
// A struck prop that STANDS throws a burst in its own colours, and the sea
// throws spray at a HoverJet skimming it. No 2016 system did either, so their
// specs are AUTHORED here from the preset (`propStrikeSpec`, `waterSpraySpec`)
// rather than read off the sheet, one field — one draw call — each, and both
// are `look: 'paper'`: leaves and water are not light (ART_DIRECTION).
//
// The burst's colours are the struck prop's OWN faces — the vertex colours of
// the geometry it was drawn with, area-weighted, from the faces within
// `colourBand` of the height it was struck at (`strikePalette`). The brief that
// asked for this pointed at `render/dressing.ts`'s `instanceColor`; the dressing
// has no colliders, and everything that can be struck is a vertex-coloured glTF
// from `game/props/load-props.ts`.
//
// ── And a third: the SPLASH (DEV-613, Anniversary) ────────────────────────
//
// Matt, 2026-10-03: *"can you spawn a "splash" particle fx when anything goes
// in or out of the water? i'm thinking i'd see it the most w/ dolphins land in
// the water, and if jets crash into the water"*. Two authored specs, a CROWN
// (a ring of spray off the rim of a disc, `coneShell`) and DROPS (a narrower,
// faster `cone` from its middle), paper like the spray, each a field with a
// FIXED pool of emitters that every splash in the world shares: `splash()`
// takes the pair with the fewest pieces in the air, so a pod landing at once
// recycles splashes rather than adding to the frame. How big each one is rides
// on the emitter (`ParticleEmitter.scale`, gravity's similarity), so one field
// serves a dolphin and a jet going in at 150 m/s. Who calls it: the dolphins'
// field at each leap's two ends (`render/life-leapers.ts`), and the jets' step
// through `game/splash-crossing.ts`. 2016 threw none.

import * as THREE from 'three'
import { assetUrl } from '@/content/asset-url'
import type {
  Edition,
  EditionPropBurst,
  EditionSpeedLines,
  EditionSplash,
  EditionSplashPart,
  EditionWaterSpray,
} from '@/content/edition-schema'
import { type Level, liveRings } from '@/content/level-schema'
import { GATE_FEEL } from '@/game/gate-feel'
import type { SeatEffects } from '@/game/jumpseat-flight'
import {
  boostStageAt,
  hoverJetSpeedLineStages,
  type SpeedLineDrive,
  type SpeedLineRamp,
  type SpeedLineStages,
  speedLineDrives,
} from '@/game/speed-line-ramp'
import { livePads } from '@/game/targets'
import { HOVERJET, JUMPSEAT, PROPS } from '@/generated/constants.generated'
import {
  createParticleField,
  MAX_PALETTE,
  type MinMaxCurveLike,
  type MinMaxGradientLike,
  NO_OVERRIDE,
  type ParticleEmitter,
  type ParticleField,
  type ParticleOverride,
  type ParticleSpec,
} from '@/render/particles'
import { srgbToLinear, unityPose } from '@/render/unity-space'
import { xorshift32 } from '@/sim/math/rng'
import type { PropColliders, PropHit } from '@/sim/props/collision'
import { type HeightField, outsideField, terrainHeightAt } from '@/sim/terrain/height-field'

// The ramp's resolver sits beside S2's two, so the one place that wires the
// speed lines to the preset imports all three from one door. DEV-351.
export { speedLineRamp } from '@/game/speed-line-ramp'

const PARTICLE_TEXTURE = 'assets/particles/tri-particle.png'

/** A hard ceiling, so a future spec with maxParticles 100000 cannot hang a frame. */
const FIELD_CAPACITY_CEILING = 8192

/**
 * A row of `PROPS.checkpointRing.particles` / `HOVERJET.particles`: the engine's
 * `ParticleSpec` plus the liveness and pose-chain fields only the wiring reads.
 *
 * Exported so `tests/unit/particles.test.ts` can drive the REAL sheet rows
 * through `emitterLocalMatrix` and `createParticleField` without re-describing
 * their shape — the direction guards are only worth anything if the thing they
 * measure is the thing the game builds.
 */
export interface ExtractedParticle extends ParticleSpec {
  readonly fileId: string
  readonly active: boolean
  readonly playOnAwake: boolean
  readonly ancestors: readonly {
    readonly name: string
    readonly active: boolean
    readonly position: readonly number[]
    readonly rotation: readonly number[]
    readonly scale: readonly number[]
  }[]
  readonly position: readonly number[]
  readonly rotation: readonly number[]
  readonly scale: readonly number[]
}

/**
 * The emitter's pose relative to the PREFAB ROOT, in three space.
 *
 * `ancestors` is nearest-first and ends with the prefab root, which is dropped —
 * the caller supplies the instance's own world matrix in its place.
 */
export const emitterLocalMatrix = (p: ExtractedParticle): THREE.Matrix4 => {
  const out = new THREE.Matrix4()
  const chain = p.ancestors.slice(0, -1)
  // Outermost first: offset, then ringIdle, then ringBurst (2), then self.
  for (let i = chain.length - 1; i >= 0; i--) {
    const a = chain[i]
    if (!a) continue
    out.multiply(unityPose(a.position, a.rotation, a.scale))
  }
  out.multiply(unityPose(p.position, p.rotation, p.scale))
  return out
}

interface FieldSlot {
  readonly spec: ParticleSpec
  readonly field: ParticleField
  readonly emitters: ParticleEmitter[]
  readonly local: THREE.Matrix4
}

/**
 * S2, as arithmetic. ANNIVERSARY.md §2.5 / DEV-079.
 *
 * `null` means "2016, exactly" — the flag off, or the comfort slider at zero,
 * which is the same answer for the same reason: a speed effect is vection
 * (§2.6), and a player who has turned vection off has turned this off.
 *
 * In between, `speedFx` INTERPOLATES from the authored identity toward the
 * preset's numbers, so `light` is half the extra width rather than half the
 * width. The streak's length, speed, rate and lifetime are not here and never
 * will be: they are generated (hard rule 3), and the 100 m tube streaming back
 * is the authored design.
 */
export const speedLineOverride = (
  lines: EditionSpeedLines,
  speedFx: number,
): ParticleOverride | null => {
  if (!lines.enabled || speedFx <= 0) return null
  const k = Math.min(1, Math.max(0, speedFx))
  const toward = (full: number): number => NO_OVERRIDE.widthScale + (full - 1) * k
  return {
    widthScale: toward(lines.widthScale),
    alphaScale: toward(lines.alphaScale),
    softEdge: lines.softEdge,
    coreDarkness: lines.coreDarkness * k,
  }
}

/**
 * How far the three BOOST tubes are lifted toward the eye, metres in the SHIP
 * frame. 0 on Classic, off, and for every other system.
 *
 * ── Why a lift at all, measured ──────────────────────────────────────────
 *
 * The same-tick A/B frames at 40 s (`tests/e2e/anniversary-ab.spec.ts`, stage 1
 * at 154 m/s) showed the re-authored streaks as a faint convergence low in the
 * centre of the view and nothing passing the canopy — and the prefab says why.
 * The three tubes are authored at `(0, -5.6, 100)` under `Effects` (0, 0, 1.45)
 * under `shipOffset` (0, -0.17, 0): an axis **6.6 m below the eye** at
 * (0, 0.86, 1.27). Stage 1's shell radius is 4.63 m, so its TOP passes 2 m
 * under the cockpit floor; only stages 2 and 3 (8.07 m) ever reach the glass.
 * Whatever 2016 was aiming at, a first-person player at 120-240 m/s — most of
 * a lap — is looking at the far end of a tube that runs under the seat.
 *
 * A lift of the whole axis to the eye puts stage 1 around the canopy at 4.6 m
 * and stages 2-3 at 8 m, which is where a streak has an angular rate worth
 * seeing (ANNIVERSARY.md §2.1: v/d, and d is the whole game). It is a TRANSFORM
 * on the emitter, not a change to the spec — rate, speed, lifetime and shape
 * stay generated — and like the width it scales with the comfort slider: half
 * the lift at `light`, so the tube's top just clears the glass rather than
 * ringing it. DEV-079, second pass.
 */
export const speedLineLift = (lines: EditionSpeedLines, speedFx: number): number => {
  if (!lines.enabled || speedFx <= 0) return 0
  return lines.tubeLift * Math.min(1, Math.max(0, speedFx))
}

// ── DEV-428 / DEV-429: the authored specs ────────────────────────────────
//
// Shuriken's own vocabulary, so the engine runs them exactly as it runs a 2016
// system. The shape constants below are the AUTHORING — how a draw is spread
// about the preset's number, how a piece grows in and shrinks out — and not
// tuning: the numbers a person argues with are the preset's.

/** A Shuriken constant. */
const constantCurve = (v: number): MinMaxCurveLike => ({
  mode: 0,
  scalar: v,
  min: v,
  max: v,
  minCurve: null,
  maxCurve: null,
})

/** Shuriken's "random between two constants": `scalar * [lo, hi]`, per particle. */
const betweenCurve = (scalar: number, lo: number, hi: number): MinMaxCurveLike => ({
  mode: 3,
  scalar,
  min: lo,
  max: hi,
  minCurve: null,
  maxCurve: null,
})

/** One flat colour for the whole life — linear rgb, alpha 1. */
const solidGradient = (r: number, g: number, b: number): MinMaxGradientLike => ({
  mode: 0,
  max: { colours: [{ time: 0, color: [r, g, b] }], alphas: [{ time: 0, alpha: 1 }] },
  min: null,
})

/**
 * Size over life: grow in over the first 8 %, hold, shrink away over the last
 * 40 %. A paper field cannot fade (it is cut, not blended), so SIZE is how a
 * piece arrives without a pop and leaves without one. Zero slopes: Hermite
 * eases between the keys.
 */
const GROW_HOLD_SHRINK: MinMaxCurveLike = {
  mode: 1,
  scalar: 1,
  min: 0,
  max: 1,
  minCurve: null,
  maxCurve: [
    { time: 0, value: 0, inSlope: 0, outSlope: 0 },
    { time: 0.08, value: 1, inSlope: 0, outSlope: 0 },
    { time: 0.6, value: 1, inSlope: 0, outSlope: 0 },
    { time: 1, value: 0, inSlope: 0, outSlope: 0 },
  ],
}

/** Every draw lands in 60-100 % of the preset's number: a spread, not a clone. */
const DRAW_LO = 0.6

/**
 * The struck prop's burst, as a spec. DEV-428.
 *
 * ONE burst of `count` at time 0 from a ball of `radius`, every direction
 * (`sphere`), at up to `spread` m/s — the hitter's velocity is not here, it
 * rides on the EMITTER (`velocity`) so one field serves every hitter. World
 * space, because the pieces are left in the air where the tree was. The pieces
 * tumble (a paper triangle turning over) and the air takes their speed
 * (`drag`), so what the carry throws forward settles and falls.
 */
export const propStrikeSpec = (s: EditionPropBurst): ParticleSpec => ({
  name: 'propStrike',
  lengthSeconds: 0.05,
  looping: false,
  simulationSpace: 'world',
  simulationSpeed: 1,
  randomSeed: 428,
  initial: {
    lifetime: betweenCurve(s.lifetime, DRAW_LO, 1),
    speed: betweenCurve(s.spread, 0.25, 1),
    size: betweenCurve(s.size, DRAW_LO, 1),
    rotationDeg: betweenCurve(1, 0, 360),
    colour: solidGradient(1, 1, 1),
    gravityModifier: s.gravity,
    maxParticles: s.count,
  },
  emission: {
    enabled: true,
    type: 0,
    rate: constantCurve(0),
    bursts: [{ time: 0, min: s.count, max: s.count }],
  },
  shape: {
    enabled: true,
    type: 'sphere',
    radius: s.radius,
    angleDeg: 0,
    length: 0,
    box: [0, 0, 0],
    randomDirection: false,
  },
  sizeOverLifetime: { enabled: true, curve: GROW_HOLD_SHRINK },
  rotationOverLifetime: { enabled: true, curve: betweenCurve(1, -540, 540) },
  colourOverLifetime: null,
  clampVelocity: { enabled: s.drag > 0, magnitude: constantCurve(0), dampen: s.drag },
  renderer: { mode: 'billboard', lengthScale: 0, velocityScale: 0 },
  emits: true,
})

/**
 * The sea's spray, as a spec. DEV-429.
 *
 * A continuous cone of `angleDeg` about the emitter's axis — posed straight
 * UP at the water under the ship — from a disc of `radius`, at up to `lift`
 * m/s; the ship's carried velocity rides on the emitter. `rate` is the spec's,
 * and `sprayStrength` scales it every frame through the field's drive. Its
 * colour is the preset's, linear and shaded, baked in: one colour, no palette.
 */
export const waterSpraySpec = (s: EditionWaterSpray): ParticleSpec => {
  const [r, g, b] = s.colour.map((c) => srgbToLinear(c) * s.shade) as [number, number, number]
  return {
    name: 'waterSpray',
    lengthSeconds: 1,
    looping: true,
    simulationSpace: 'world',
    simulationSpeed: 1,
    randomSeed: 429,
    initial: {
      lifetime: betweenCurve(s.lifetime, DRAW_LO, 1),
      speed: betweenCurve(s.lift, 0.5, 1),
      size: betweenCurve(s.size, DRAW_LO, 1),
      rotationDeg: betweenCurve(1, 0, 360),
      colour: solidGradient(r, g, b),
      gravityModifier: s.gravity,
      // A second of the full rate, rounded up: what one emitter can have alive.
      maxParticles: Math.max(1, Math.ceil(s.rate * s.lifetime)),
    },
    emission: { enabled: true, type: 0, rate: constantCurve(s.rate), bursts: [] },
    shape: {
      enabled: true,
      type: 'cone',
      radius: s.radius,
      angleDeg: s.angleDeg,
      length: 0,
      box: [0, 0, 0],
      randomDirection: false,
    },
    sizeOverLifetime: { enabled: true, curve: GROW_HOLD_SHRINK },
    rotationOverLifetime: { enabled: true, curve: betweenCurve(1, -360, 360) },
    colourOverLifetime: null,
    clampVelocity: { enabled: s.drag > 0, magnitude: constantCurve(0), dampen: s.drag },
    renderer: { mode: 'billboard', lengthScale: 0, velocityScale: 0 },
    emits: true,
  }
}

/**
 * One part of a splash, as a spec. DEV-613.
 *
 * ONE burst of `count` at time 0, up a cone of `angleDeg` about the emitter's
 * axis (posed straight UP at the water, `SPRAY_UP`), from a disc of `radius`:
 * from its RIM for the crown (`coneShell`, every piece at the full angle, which
 * is what makes a ring), across it for the drops (`cone`, steeper toward the
 * middle). World space, because the water stays where it was thrown. Its
 * colour is the preset's, linear and shaded, baked in. The size of the splash
 * is not here: it rides on the emitter (`ParticleEmitter.scale`).
 */
const splashPartSpec = (
  name: string,
  seed: number,
  part: EditionSplashPart,
  s: EditionSplash,
  rim: boolean,
): ParticleSpec => {
  const [r, g, b] = part.colour.map((c) => srgbToLinear(c) * s.shade) as [number, number, number]
  return {
    name,
    lengthSeconds: 0.05,
    looping: false,
    simulationSpace: 'world',
    simulationSpeed: 1,
    randomSeed: seed,
    initial: {
      lifetime: betweenCurve(part.lifetime, DRAW_LO, 1),
      speed: betweenCurve(part.lift, 0.5, 1),
      size: betweenCurve(part.size, DRAW_LO, 1),
      rotationDeg: betweenCurve(1, 0, 360),
      colour: solidGradient(r, g, b),
      gravityModifier: s.gravity,
      maxParticles: part.count,
    },
    emission: {
      enabled: true,
      type: 0,
      rate: constantCurve(0),
      bursts: [{ time: 0, min: part.count, max: part.count }],
    },
    shape: {
      enabled: true,
      type: rim ? 'coneShell' : 'cone',
      radius: part.radius,
      angleDeg: part.angleDeg,
      length: 0,
      box: [0, 0, 0],
      randomDirection: false,
    },
    sizeOverLifetime: { enabled: true, curve: GROW_HOLD_SHRINK },
    rotationOverLifetime: { enabled: true, curve: betweenCurve(1, -540, 540) },
    colourOverLifetime: null,
    clampVelocity: { enabled: s.drag > 0, magnitude: constantCurve(0), dampen: s.drag },
    renderer: { mode: 'billboard', lengthScale: 0, velocityScale: 0 },
    emits: true,
  }
}

/** The splash's ring of spray. DEV-613. */
export const splashCrownSpec = (s: EditionSplash): ParticleSpec =>
  splashPartSpec('splashCrown', 6131, s.crown, s, true)

/** The splash's droplets. DEV-613. */
export const splashDropsSpec = (s: EditionSplash): ParticleSpec =>
  splashPartSpec('splashDrops', 6132, s.drops, s, false)

/**
 * How big a splash is: `body` times the square root of `speed` over the
 * preset's `refSpeed`, within `minScale`..`maxScale`. DEV-613.
 *
 * The square root because the splash's every length goes as its scale, and a
 * body thrown into water throws it to a height that goes as its speed: the
 * root keeps a jet at 150 m/s from being twenty dolphins. `body` is the
 * crosser's (`jetBody`, `dolphinBody`); a non-finite speed is the smallest
 * splash, not a NaN one.
 */
export const splashScale = (s: EditionSplash, body: number, speed: number): number => {
  const k = body * Math.sqrt(Math.max(0, speed) / s.refSpeed)
  return Math.min(s.maxScale, Math.max(s.minScale, Number.isFinite(k) ? k : s.minScale))
}

/**
 * How much of the spray's `rate` runs this frame, 0-1. DEV-429.
 *
 * `height` is the ship above the VISIBLE sea, metres — null when there is no
 * sea under it at all. `depth` is the water column there (the sea's surface
 * minus the island's), so zero and below is a beach or a hill the land mesh is
 * drawn over, and throws nothing. Under the surface (`height` below zero) is a
 * ship the chop has swallowed, which throws nothing either.
 *
 * Closeness is linear from the water to `heightMetres` (a square was tried
 * first and left a ship at 2 m with a third of the rate, which photographed as
 * nothing); the speed ramps in on a smoothstep from `minSpeed` to `fullSpeed`;
 * and the comfort slider multiplies the lot, 0 being none (ART_DIRECTION:
 * vection answers to the slider).
 */
export const sprayStrength = (
  s: EditionWaterSpray,
  height: number | null,
  depth: number,
  speed: number,
  speedFx: number,
): number => {
  if (!s.enabled || speedFx <= 0 || height === null || !(depth > 0)) return 0
  if (!(height >= 0) || height >= s.heightMetres) return 0
  const near = 1 - height / s.heightMetres
  const t = Math.min(1, Math.max(0, (speed - s.minSpeed) / (s.fullSpeed - s.minSpeed)))
  return near * (t * t * (3 - 2 * t)) * Math.min(1, speedFx)
}

/**
 * One prop geometry's faces, for its colours: each face's centroid height in
 * the mesh's own frame, its area, and its colour (the vertex colours' mean).
 * Built once per geometry and cached — every tree of a kind shares one.
 */
export interface FaceTable {
  readonly count: number
  readonly y: Float32Array
  readonly area: Float32Array
  readonly rgb: Float32Array
  readonly minY: number
  readonly maxY: number
}

const faceTables = new WeakMap<THREE.BufferGeometry, FaceTable>()

export const propFaceTable = (geometry: THREE.BufferGeometry): FaceTable => {
  const cached = faceTables.get(geometry)
  if (cached) return cached
  const pos = geometry.getAttribute('position')
  const col = geometry.getAttribute('color') ?? null
  const index = geometry.getIndex()
  const count = Math.floor((index ? index.count : (pos?.count ?? 0)) / 3)
  const y = new Float32Array(count)
  const area = new Float32Array(count)
  const rgb = new Float32Array(count * 3)
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let f = 0; f < count; f++) {
    const i0 = index ? index.getX(f * 3) : f * 3
    const i1 = index ? index.getX(f * 3 + 1) : f * 3 + 1
    const i2 = index ? index.getX(f * 3 + 2) : f * 3 + 2
    if (pos) {
      a.fromBufferAttribute(pos, i0)
      b.fromBufferAttribute(pos, i1)
      c.fromBufferAttribute(pos, i2)
    }
    y[f] = (a.y + b.y + c.y) / 3
    minY = Math.min(minY, a.y, b.y, c.y)
    maxY = Math.max(maxY, a.y, b.y, c.y)
    area[f] = b.sub(a).cross(c.sub(a)).length() / 2
    for (let k = 0; k < 3; k++) {
      const get = k === 0 ? 'getX' : k === 1 ? 'getY' : 'getZ'
      rgb[f * 3 + k] = col ? (col[get](i0) + col[get](i1) + col[get](i2)) / 3 : 1
    }
  }
  const table: FaceTable = {
    count,
    y,
    area,
    rgb,
    minY: Number.isFinite(minY) ? minY : 0,
    maxY: Number.isFinite(maxY) ? maxY : 0,
  }
  faceTables.set(geometry, table)
  return table
}

/**
 * Fill `out` with `n` colours for a strike at `heightFraction` of the prop (0
 * its foot, 1 its top): faces within `band` of that height, picked by AREA —
 * a big leaf is more of the crown than a small one — times `tint` (the
 * material's own colour, white on a vertex-coloured prop) and `shade`. No face
 * in the band (a thin prop, a band of 0) is every face. Deterministic in
 * `seed`, so the same strike photographs the same. Returns how many it wrote.
 */
export const strikePalette = (
  table: FaceTable,
  heightFraction: number,
  band: number,
  n: number,
  seed: number,
  tint: { readonly r: number; readonly g: number; readonly b: number },
  shade: number,
  out: Float32Array,
): number => {
  const span = table.maxY - table.minY
  const inBand = (f: number): boolean =>
    span <= 0 || Math.abs(((table.y[f] as number) - table.minY) / span - heightFraction) <= band
  let total = 0
  for (let f = 0; f < table.count; f++) if (inBand(f)) total += table.area[f] as number
  const every = !(total > 0)
  if (every) for (let f = 0; f < table.count; f++) total += table.area[f] as number
  const want = Math.min(n, Math.floor(out.length / 3))
  if (!(total > 0) || table.count === 0) {
    for (let k = 0; k < want; k++) {
      out[k * 3] = tint.r * shade
      out[k * 3 + 1] = tint.g * shade
      out[k * 3 + 2] = tint.b * shade
    }
    return want
  }
  const rnd = xorshift32(seed)
  for (let k = 0; k < want; k++) {
    let u = rnd() * total
    let f = 0
    for (; f < table.count - 1; f++) {
      if (!every && !inBand(f)) continue
      u -= table.area[f] as number
      if (u <= 0) break
    }
    // The loop's last index is taken without its own test: land it on a face
    // that is in the band, walking back if the final one is not.
    while (!every && f > 0 && !inBand(f)) f--
    out[k * 3] = (table.rgb[f * 3] as number) * tint.r * shade
    out[k * 3 + 1] = (table.rgb[f * 3 + 1] as number) * tint.g * shade
    out[k * 3 + 2] = (table.rgb[f * 3 + 2] as number) * tint.b * shade
  }
  return want
}

/**
 * A strike the renderer turns into a burst. DEV-428.
 *
 * **This is the seam P4's sway plugs into.** Everything an `aSway` impulse
 * needs is here: which instance (`id`), where it was hit, and how hard and in
 * which direction (`velocity`). `boot/app.ts`'s `breakProps` builds ONE of
 * these per strike and hands it to `strikeProp`; the sway is a second consumer
 * of the same object beside it, not a second derivation.
 */
export interface PropStrike {
  /** The collider id, which is also the drawn instance's id (`load-props.ts`). */
  readonly id: number
  /** Where the hull met the prop, THREE world space. */
  readonly point: { readonly x: number; readonly y: number; readonly z: number }
  /** The HITTER's velocity, THREE world space, m/s. */
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number }
  /** 0 at the prop's foot, 1 at its top: where on it the contact was. */
  readonly heightFraction: number
  /** What the instance is drawn with, for its colours. Null: a flat fallback. */
  readonly geometry: THREE.BufferGeometry | null
  /** The material's own colour, linear; white on a vertex-coloured prop. */
  readonly tint: { readonly r: number; readonly g: number; readonly b: number }
}

/**
 * Does this contact leave its prop STANDING? DEV-428.
 *
 * The renderer draws what the sim has: a contact that struck (`broken`) and
 * left the collider in place is a standing tree, and throws a burst; one whose
 * collider is gone — `strike` off, or DEV-180's escape — is DEV-136's fracture.
 * A drawn tree is always a solid one and a solid one always drawn, whichever
 * of the two the preset or the escape chose.
 */
export const strikeStands = (
  hit: Pick<PropHit, 'id' | 'broken'>,
  colliders: Pick<PropColliders, 'broken'>,
): boolean => hit.broken && colliders.broken[hit.id] === 0

/**
 * The burst a world builds at load, or null for none. DEV-428, DEV-464.
 *
 * Built only when the colliders, the standing strike and the burst are all on
 * at load: a world with no standing strike compiles no paper program. `boot/
 * app.ts` hands the LIVE preset here — the composed one, the chosen look laid
 * over the rules (D35) — and DEV-464 is why that matters: until the burst was
 * put on the RULES side of D35's key table, a Classic-look run kept the tree
 * standing (Anniversary's strike) and built no burst (Classic's look), so the
 * ship went through a solid tree and nothing on screen said so.
 */
export const propBurstAtLoad = (
  edition: Pick<Edition, 'gameplay' | 'fx'>,
): EditionPropBurst | null => {
  const pc = edition.gameplay.propCollision
  return pc.enabled && pc.strike.enabled && edition.fx.propBurst.enabled
    ? edition.fx.propBurst
    : null
}

/**
 * The one `PropStrike` a contact makes. SIM in, THREE out: z flips, for the
 * point and the velocity alike. The height fraction is the contact's place on
 * the collider's own span — the DRAWN bounds (DEV-136), so 1 is the crown's top.
 */
export const propStrikeOf = (
  hit: Pick<PropHit, 'id' | 'point'>,
  velocity: { readonly x: number; readonly y: number; readonly z: number },
  colliders: Pick<PropColliders, 'bottom' | 'top'>,
  drawn: { readonly geometry: THREE.BufferGeometry; readonly material: THREE.Material } | null,
): PropStrike => {
  const bottom = colliders.bottom[hit.id] ?? hit.point.y
  const top = colliders.top[hit.id] ?? hit.point.y
  const span = top - bottom
  const colour = (drawn?.material as { color?: THREE.Color } | undefined)?.color
  return {
    id: hit.id,
    point: { x: hit.point.x, y: hit.point.y, z: -hit.point.z },
    velocity: { x: velocity.x, y: velocity.y, z: -velocity.z },
    heightFraction: span > 0 ? Math.min(1, Math.max(0, (hit.point.y - bottom) / span)) : 0.5,
    geometry: drawn?.geometry ?? null,
    tint: colour ? { r: colour.r, g: colour.g, b: colour.b } : { r: 1, g: 1, b: 1 },
  }
}

/**
 * Where the sea is, for the spray. DEV-429. SIM space, like the fields.
 *
 * `bob` is the ocean group's travel from where it was built — this frame's
 * `LowPoly_Displace` bob, which moves the whole visible plate by up to its
 * amplitude while the collision field stays put. The spray is judged against
 * the sea you can SEE (DEV-148's lesson, a layer up).
 */
export interface SeaSource {
  readonly ocean: HeightField
  readonly land: HeightField | null
  bob(): number
}

/**
 * The VISIBLE sea's height under a SIM (x, z), and the water column there (the
 * sea's surface minus the island's). DEV-429. Off the island's footprint is
 * open water, as deep as it gets. Into `out`, so a frame allocates nothing.
 */
export const seaUnder = (
  sea: SeaSource,
  x: number,
  z: number,
  out: { seaY: number; depth: number },
): { seaY: number; depth: number } => {
  const seaY = terrainHeightAt(sea.ocean, x, z) + sea.bob()
  const land = sea.land
  const landY =
    !land || outsideField(land, x, z) ? Number.NEGATIVE_INFINITY : terrainHeightAt(land, x, z)
  out.seaY = seaY
  out.depth = seaY - landY
  return out
}

/**
 * Unity forward (+Z, where a Shuriken cone points) turned to world up. The
 * engine flips a spawn's local z before the emitter matrix (DEV-271), so this
 * is +90 degrees about x: `(0, 0, -1)` lands on `(0, 1, 0)`. Copied from, never
 * written.
 */
const SPRAY_UP = new THREE.Matrix4().makeRotationX(Math.PI / 2)

/**
 * Pose the spray's emitter: at the HULL, its cone up, carrying `carry` of the
 * ship's velocity. SIM in, THREE out — z flips, for the place and the velocity
 * alike. DEV-429.
 *
 * At the hull and not at the sea, and that was measured. The sea's plate plus
 * its bob is the sea as modelled; the drawn surface also carries a per-vertex
 * chop of up to 4 m, which nothing on the CPU reproduces. Spray born at the
 * modelled sea under a ship 2 m above it was BURIED — 98 droplets alive within
 * 30 m of the hull, none on screen (int_01, 46 s, chase view). A ship this
 * low is skimming the water you can see, so its hull is the best estimate of
 * where that water is; how near the sea is, `sprayStrength` already says.
 */
export const poseSprayEmitter = (
  e: Pick<ParticleEmitter, 'matrix' | 'velocity'>,
  position: { readonly x: number; readonly y: number; readonly z: number },
  velocity: { readonly x: number; readonly y: number; readonly z: number },
  carry: number,
): void => {
  e.matrix.copy(SPRAY_UP).setPosition(position.x, position.y, -position.z)
  e.velocity.set(velocity.x * carry, velocity.y * carry, -velocity.z * carry)
}

/** The spray's per-frame input. SIM space: the body's own numbers. */
export interface SprayInput {
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number }
  /** Flying: not paused, not in the hangar, not on the lift. */
  readonly active: boolean
  readonly speedFx: number
  readonly spec: EditionWaterSpray
}

/**
 * DEV-638: the clean gate's sparkle, LINEAR rgb triples (white, a pale gold, a
 * deeper gold). A palette copied by `setPalette`, never mutated.
 */
const SPARKLE_PALETTE: readonly number[] = [1, 0.95, 0.7, 1, 1, 1, 1, 0.8, 0.35]
/** DEV-639: the missed gate's flash, LINEAR rgb: a mid grey, a pale grey, a cool grey. */
const MISS_PALETTE: readonly number[] = [0.32, 0.34, 0.36, 0.5, 0.52, 0.54, 0.24, 0.27, 0.3]

/** DEV-836: the exterior engines' look. Linear RGB triples, warm engine colours. */
export const EXTERNAL_FLAME = {
  scale: 0.45,
  alpha: 0.4,
  palette: [1, 0.55, 0.2, 1, 0.4, 0.12, 1, 0.7, 0.35] as readonly number[],
} as const

export interface ParticleFx {
  readonly object: THREE.Object3D
  /** Total live particles, for the HUD and for tests. */
  readonly alive: number
  /**
   * Re-author the three BOOST systems, or (`null`) put them back to 2016.
   * `flight_particles` is not one of them — those are motes, and the near-field
   * air is DEV-080's business.
   */
  setSpeedLines(override: ParticleOverride | null): void
  /** What the boost systems are carrying, for the tests. */
  readonly speedLineFields: readonly ParticleField[]
  /**
   * Lift the three BOOST tubes toward the eye by this many metres in the ship
   * frame — `speedLineLift(...)`. 0 is 2016's placement. Applied when the
   * emitters are next posed (`updateShip`), so a flip lands on the next frame.
   */
  setSpeedLineLift(metres: number): void
  /**
   * How much of a `randomDirection` shape's direction is random, 0-1, from
   * `edition.fx.ringBurst`. DEV-272. Lands on the next SPAWN, so a preset flip
   * is visible within a frame and particles already in the air are untouched.
   */
  setRingBurstRandomDirection(amount: number): void
  /** The lift in force, for the tests. */
  readonly speedLineLift: number
  /**
   * Ramp the three boost stages, or (`null`) put 2016's three cuts back —
   * `speedLineRamp(edition.fx.speedRamp, speedFx)`. DEV-351. Lands on the next
   * `updateShip`; a flip back to `null` hands every boost field back to the
   * spec at once, so no stage is left half-driven under the cut logic.
   */
  setSpeedRamp(ramp: SpeedLineRamp | null): void
  /** The ramp in force, for the tests and the probes. `null` is 2016. */
  readonly speedRamp: SpeedLineRamp | null
  /** 2016's cuts and the envelope's top, off the sheet — what the ramp is built on. */
  readonly speedLineStages: SpeedLineStages
  /** Fire the gate's one-shot burst at `ringIndex`. */
  burstRing(ringIndex: number): void
  /**
   * DEV-638: a CLEAN gate's second layer, over `burstRing`'s: the same one-shot
   * systems again as a smaller, faster, whiter spray. Call it beside
   * `burstRing`, never instead of it. DEV-639: `'miss'` is the same layer in
   * grey and smaller, the flash of a gate that was not flown clean.
   */
  burstRingSparkle(ringIndex: number, tone: 'clean' | 'miss'): void
  /**
   * The JumpSeat's own effects (DEV-416), once a frame with the seat's world
   * matrix. Inert on any other vehicle, which builds none of them.
   */
  updateSeat(matrix: THREE.Matrix4, fx: SeatEffects): void
  /**
   * DEV-836: the HoverJet's `Art/ThirdPerson` engines, once a frame with the
   * ship's world matrix. `external` is true while the camera is outside the
   * hull; `thrusting` is 2016's `gasPressed` and `boosting` its `boostPressed`
   * (`Input_Ship.cs`). Inert on a JumpSeat, which has its own (`updateSeat`).
   */
  updateExternal(
    matrix: THREE.Matrix4,
    external: boolean,
    thrusting: boolean,
    boosting: boolean,
  ): void
  /** Called once a frame with the ship's world matrix and forward speed (m/s). */
  updateShip(matrix: THREE.Matrix4, forwardSpeed: number): void
  /**
   * Fire the landing burst at live pad `padIndex` (`TargetZone.pad`), unless it
   * is already playing. DEV-415.
   */
  burstPad(padIndex: number): void
  /** The orb-collect one-shot. */
  collectOrb(): void
  /**
   * DEV-428: a struck prop that STANDS throws a burst at the contact in its own
   * colours, carrying `carry` of the hitter's velocity. `eye` is the camera's
   * world position, for `maxMetres`. False when nothing was thrown — no strike
   * field was built (the flag was off at load), or the strike was out of range.
   */
  strikeProp(
    strike: PropStrike,
    spec: EditionPropBurst,
    eye: { readonly x: number; readonly y: number; readonly z: number },
  ): boolean
  /** Bursts thrown this world, and pieces in the air. Null: no strike field. DEV-428. */
  readonly strike: { readonly bursts: number; readonly alive: number } | null
  /**
   * DEV-613: throw a splash at `point` (THREE world, the water's surface), of
   * `splashScale`'s `scale`, carrying the preset's `carry` of `velocity` (THREE
   * world, m/s). `eye` is the head's world position, for `maxMetres`. False
   * when nothing was thrown: no splash field was built (the flag was off at
   * load), or the eye is too far. Past the pool, the splash with the fewest
   * pieces in the air gives way.
   */
  splash(
    point: { readonly x: number; readonly y: number; readonly z: number },
    velocity: { readonly x: number; readonly y: number; readonly z: number },
    scale: number,
    eye: { readonly x: number; readonly y: number; readonly z: number },
  ): boolean
  /**
   * DEV-613: splashes thrown this world, pieces in the air (both parts), the
   * pool's size and the most pieces it can hold, and where the last one was
   * thrown (THREE world) at what scale. Null: no splash field.
   */
  readonly splashes: {
    readonly thrown: number
    readonly alive: number
    readonly emitters: number
    readonly capacity: number
    readonly last: {
      readonly x: number
      readonly y: number
      readonly z: number
      readonly scale: number
    } | null
  } | null
  /** Where the sea is, once the world has loaded; null takes it away. DEV-429. */
  setSea(sea: SeaSource | null): void
  /** Once a frame with the player's body. Inert with no spray field or no sea. DEV-429. */
  updateSpray(input: SprayInput): void
  /**
   * The spray's last reading: `strength` 0-1 of the rate, `height` over the
   * visible sea and `depth` of water under the ship (both null: no sea read
   * this frame), droplets alive. Null: no spray field. DEV-429.
   */
  readonly spray: {
    readonly strength: number
    readonly height: number | null
    readonly depth: number | null
    readonly alive: number
  } | null
  update(dt: number, camera: THREE.Camera): void
  dispose(): void
}

const isLive = (p: ExtractedParticle): boolean => p.active && p.emits

/**
 * The systems a scored pad fires, the burst itself first (DEV-415).
 *
 * `Trigger_JumpTarget.cs:57-59` plays `jumpPad_fx`, and Unity 5's
 * `ParticleSystem.Play()` takes the system's CHILDREN with it: `jumpPad_fx (1)`
 * and `(2)` hang under it, so a scored pad fires all three. Which system the
 * plates name is `burstFileId`, read off the triggers by the extractor rather
 * than chosen here by name.
 */
export const padBurstSpecs = (): ExtractedParticle[] => {
  const pad = PROPS.jumpPad as unknown as {
    readonly burstFileId: string | null
    readonly particles: readonly ExtractedParticle[]
  } | null
  return pad ? withChildren(pad.particles, pad.burstFileId) : []
}

/**
 * The system `fileId` names and every live system under it, the named one
 * first: what Unity 5's `ParticleSystem.Play()` starts, since it plays
 * children by default. Empty if the system is absent or dead.
 */
const withChildren = (
  particles: readonly ExtractedParticle[],
  fileId: string | null | undefined,
): ExtractedParticle[] => {
  const lead = particles.find((p) => p.fileId === fileId)
  if (!lead || !isLive(lead)) return []
  const children = particles.filter(
    (p) => p !== lead && isLive(p) && p.ancestors.some((a) => a.name === lead.name),
  )
  return [lead, ...children]
}

type SheetRef = { readonly ref?: { readonly fileID?: string } | null } | null | undefined

/** The JumpSeat's own four effects, each a system and its children (DEV-416). */
export interface SeatEffectSpecs {
  /** `Thruster.thruster_fx`, while the throttle is open. */
  readonly thruster: ExtractedParticle[]
  /** `Thruster.boost_fx`, while boosting. */
  readonly boost: ExtractedParticle[]
  /** `HoverMotor.ground_fx`, at the hover ray's hit. */
  readonly ground: ExtractedParticle[]
  /** `JumpSeat_EffectsManager.windEffects`, above `minWindEffectSpeed`. */
  readonly wind: ExtractedParticle[]
}

export const jumpSeatEffectSpecs = (): SeatEffectSpecs => {
  const seat = JUMPSEAT as unknown as {
    readonly particles: readonly ExtractedParticle[]
    readonly thruster: { readonly thruster_fx: SheetRef; readonly boost_fx: SheetRef }
    readonly hoverMotor: { readonly ground_fx: SheetRef }
    readonly effects: { readonly windEffects: SheetRef }
  }
  const id = (r: SheetRef) => r?.ref?.fileID ?? null
  return {
    thruster: withChildren(seat.particles, id(seat.thruster.thruster_fx)),
    boost: withChildren(seat.particles, id(seat.thruster.boost_fx)),
    ground: withChildren(seat.particles, id(seat.hoverMotor.ground_fx)),
    wind: withChildren(seat.particles, id(seat.effects.windEffects)),
  }
}

/**
 * DEV-836: a system and its children under `Art/ThirdPerson`, the exterior hull
 * the camera wears outside. That node ships `m_IsActive: 0` and 2016 switches it
 * on with the camera (`CamChanger.shipArt`), so `active` is false on every
 * system under it and `isLive` would drop them all. The liveness here keeps the
 * rest of the walk: the system's own emitter is on and no ancestor but
 * `ThirdPerson` is off. `playbackGhost` carries a second copy under the ghost,
 * which is not the player's.
 */
export const thirdPersonGroup = (
  particles: readonly ExtractedParticle[],
  fileId: string | null | undefined,
): ExtractedParticle[] => {
  // `emits` folds in `active`, which is false for all of these, so the
  // extractor's own emission test is repeated here without it.
  const emitting = (p: ExtractedParticle): boolean =>
    Boolean(p.emission?.enabled) &&
    ((p.emission?.bursts.length ?? 0) > 0 ||
      (p.emission?.rate.scalar ?? 0) > 0 ||
      (p.emission?.rate.max ?? 0) > 0)
  const ours = (p: ExtractedParticle): boolean =>
    emitting(p) &&
    p.ancestors.every((a) => a.name !== 'playbackGhost') &&
    p.ancestors.every((a) => a.active || a.name === 'ThirdPerson')
  const lead = particles.find((p) => p.fileId === fileId)
  if (!lead || !ours(lead)) return []
  const kids = particles.filter(
    (p) => p !== lead && ours(p) && p.ancestors.some((a) => a.name === lead.name),
  )
  return [lead, ...kids]
}

/** `JumpSeat_EffectsManager.minWindEffectSpeed`, off the prefab. */
const seatMinWindSpeed = (): number =>
  (JUMPSEAT as unknown as { readonly effects: { readonly minWindEffectSpeed: number } }).effects
    .minWindEffectSpeed

export interface ParticleFxOptions {
  /**
   * The S2 re-authoring to build the boost systems WITH, from
   * `speedLineOverride(edition.fx.speedLines, editionState.speedFx)`. `null`
   * (and the default) is 2016. Handed in at construction rather than set after
   * so that a preset that is already Anniversary at boot never draws one frame
   * of hairlines; a flip later goes through `setSpeedLines`.
   */
  readonly speedLines?: ParticleOverride | null
  /** The tube lift to start with, metres — `speedLineLift(...)`. Default 0, 2016. */
  readonly speedLineLift?: number
  /**
   * The ramp to start with — `speedLineRamp(...)`. DEV-351. Default `null`,
   * 2016's three cuts. Handed in at construction for the same reason as
   * `speedLines`: an Anniversary boot never flies one frame on the cuts.
   */
  readonly speedRamp?: SpeedLineRamp | null
  /**
   * How much of a `randomDirection` shape's direction is random, 0-1, from
   * `edition.fx.ringBurst`. DEV-272. Default 1, which is the port's own
   * long-standing behaviour to the bit.
   */
  readonly ringBurstRandomDirection?: number
  /**
   * DEV-867: false builds no gate particles at all. Free Flight has no rings,
   * and the four continuous `ringBurst` systems spray from every gate for the
   * whole mission, so a mode that does not draw the gates must not build them
   * either. Default true, which is every mode with rings.
   */
  readonly rings?: boolean
  /**
   * DEV-428: build the struck-prop burst from this. Null (the default) builds
   * nothing — Classic, and any world whose prop collision or strike was off at
   * load, carries no extra field and no extra program.
   */
  readonly propBurst?: EditionPropBurst | null
  /**
   * DEV-429: build the spray from this. Null (the default) builds nothing —
   * Classic, a world with no sea, and a JumpSeat course.
   */
  readonly waterSpray?: EditionWaterSpray | null
  /**
   * DEV-613: build the splash from this. Null (the default) builds nothing,
   * Classic among them, so a world without it carries no field.
   */
  readonly splash?: EditionSplash | null
}

/**
 * How many strikes can be in the air at once before the oldest gives up its
 * pieces. The player and the five racers are six hitters; a burst lives
 * `lifetime` (1.4 s), and two strikes by one flier inside that are rare — so
 * eight is the six plus slack. One field, one draw call, whatever this is.
 */
const STRIKE_EMITTERS = 8

export const loadParticleFx = async (
  level: Level,
  options: ParticleFxOptions = {},
): Promise<ParticleFx> => {
  const texture = await new THREE.TextureLoader().loadAsync(assetUrl(PARTICLE_TEXTURE))
  texture.colorSpace = THREE.SRGBColorSpace
  // The triangle is a hard-edged shape on a 64x64 matte; letting it go blurry at
  // distance is right, letting it wrap is not.
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping

  const group = new THREE.Group()
  group.name = 'particle-fx'
  const slots: FieldSlot[] = []

  // DEV-272 — read once, here, so every field is built with it. 1 is the
  // port's own long-standing behaviour and is what Classic asks for.
  const ringBurstRandomDirection = options.ringBurstRandomDirection ?? 1

  const addField = (
    spec: ExtractedParticle,
    emitterCount: number,
    override: ParticleOverride | null = null,
  ): FieldSlot => {
    const want = (spec.initial?.maxParticles ?? 100) * emitterCount
    const field = createParticleField(spec, texture, {
      capacity: Math.min(FIELD_CAPACITY_CEILING, want),
      override,
      // DEV-272. Handed in at CONSTRUCTION for the same reason `speedLines` is:
      // a preset that is already Anniversary at boot must not draw one frame of
      // the other answer. Every field takes it, and it is inert on the twenty
      // systems whose shape has `randomDirection: false`.
      randomDirection: ringBurstRandomDirection,
    })
    group.add(field.object)
    const local = emitterLocalMatrix(spec)
    const emitters: ParticleEmitter[] = []
    for (let i = 0; i < emitterCount; i++) emitters.push(field.addEmitter())
    const slot: FieldSlot = { spec, field, emitters, local }
    slots.push(slot)
    return slot
  }

  // ── the gates ──────────────────────────────────────────────────────────
  // `liveRings`, not `routes[0].rings`: the gates that get particles are the gates the
  // course scores and `game/rings.ts` draws, from one shared expression (DEV-210).
  const rings = options.rings === false ? [] : liveRings(level)
  const ringSpecs = (PROPS.checkpointRing.particles as unknown as ExtractedParticle[]).filter(
    isLive,
  )
  const ringContinuous: FieldSlot[] = []
  const ringOneShot: FieldSlot[] = []
  /** DEV-638: the one-shots again, as the clean gate's sparkle layer. */
  const ringSparkle: FieldSlot[] = []
  const gateMatrix = new THREE.Matrix4()

  for (const spec of rings.length === 0 ? [] : ringSpecs) {
    const slot = addField(spec, rings.length)
    rings.forEach((ring, i) => {
      const p = ring.pos as number[]
      const q = ring.quat as number[]
      const s = ring.scale as number[]
      gateMatrix.compose(
        new THREE.Vector3(p[0] as number, p[1] as number, p[2] as number),
        new THREE.Quaternion(q[0] as number, q[1] as number, q[2] as number, q[3] as number),
        new THREE.Vector3(s[0] as number, s[1] as number, s[2] as number),
      )
      // The gate does not move, so the emitter matrix is written once.
      slot.emitters[i]?.matrix.multiplyMatrices(gateMatrix, slot.local)
    })
    // `playOnAwake` is the 2016 distinction between the four that spray for the
    // whole mission and the two that fire when you fly through.
    if (spec.playOnAwake) {
      ringContinuous.push(slot)
      for (const e of slot.emitters) e.play()
    } else {
      ringOneShot.push(slot)
      // DEV-638: the same system a second time per gate, drawn smaller, faster
      // and in a white-gold palette. It is only ever fired on a clean gate, so
      // it sits idle (no live particles, nothing emitting) the rest of the run.
      const spark = addField(spec, rings.length)
      spark.field.setDrive({ rate: 1, alpha: 1, speed: GATE_FEEL.sparkleSpeed })
      for (let i = 0; i < rings.length; i++) {
        const e = spark.emitters[i]
        if (!e) continue
        e.matrix.copy(slot.emitters[i]?.matrix ?? e.matrix)
        e.scale = GATE_FEEL.sparkleScale
        e.setPalette(SPARKLE_PALETTE)
      }
      ringSparkle.push(spark)
    }
  }

  // ── the pads (DEV-415) ─────────────────────────────────────────────────
  // One emitter per LIVE pad, the index `TargetZone.pad` uses. Posed by the
  // pad's position and turn only: all three systems are `scalingMode` 1,
  // Unity's Local, which ignores the pad instance's scale.
  const pads = livePads(level)
  const padSlots: FieldSlot[] = []
  const padMatrix = new THREE.Matrix4()
  const unitScale = new THREE.Vector3(1, 1, 1)
  for (const spec of pads.length === 0 ? [] : padBurstSpecs()) {
    const slot = addField(spec, pads.length)
    pads.forEach((pad, i) => {
      padMatrix.compose(
        new THREE.Vector3(pad.pos[0], pad.pos[1], pad.pos[2]),
        new THREE.Quaternion(pad.quat[0], pad.quat[1], pad.quat[2], pad.quat[3]),
        unitScale,
      )
      slot.emitters[i]?.matrix.multiplyMatrices(padMatrix, slot.local)
    })
    padSlots.push(slot)
  }

  // ── the ship ───────────────────────────────────────────────────────────
  const shipSpecs = HOVERJET.particles as unknown as ExtractedParticle[]
  const byFileId = (ref: { ref?: { fileID?: string } | null } | null | undefined) => {
    const id = ref?.ref?.fileID
    if (!id) return null
    const spec = shipSpecs.find((p) => p.fileId === id)
    return spec && isLive(spec) ? spec : null
  }
  const ship = HOVERJET.ship as unknown as Record<string, { ref?: { fileID?: string } | null }>

  // DEV-416: a JumpSeat flies with its OWN systems (below), not the HoverJet's.
  const seatVehicle = level.vehicle === 'jumpseat'
  const shipSlot = (key: string, override: ParticleOverride | null = null): FieldSlot | null => {
    if (seatVehicle) return null
    const spec = byFileId(ship[key])
    return spec ? addField(spec, 1, override) : null
  }
  // The three boost stages take the S2 re-authoring; nothing else in the game
  // does. See `speedLineOverride`.
  const speedLines = options.speedLines ?? null
  const flight = shipSlot('flightEffects')
  const boost1 = shipSlot('boostEffects', speedLines)
  const boost2 = shipSlot('boostEffects_stage2', speedLines)
  const boost3 = shipSlot('boostEffects_stage3', speedLines)
  const orb = shipSlot('orbEffects')

  const S = HOVERJET.ship as unknown as Record<string, number>
  const MIN_FLIGHT = S.minEffectsSpeed ?? 25
  // The three boost cuts and the envelope's top, off the sheet. The Classic
  // path compares against these with `<`, exactly as it always did; the ramp
  // is built on the same four numbers (DEV-351).
  const stages = hoverJetSpeedLineStages()

  const shipSlots = [flight, boost1, boost2, boost3, orb].filter(Boolean) as FieldSlot[]

  // ── DEV-836: the exterior hull's engines ───────────────────────────────
  // `Input_Ship.jetFX` plays on the throttle and `afterburnerFX` on the boost
  // (`GasPressed` / `BoostPressed`), both under `Art/ThirdPerson`. Read off the
  // prefab's `Input_Ship`, not named here.
  const shipInput = HOVERJET.input as unknown as Record<string, SheetRef>
  const extId = (key: string): string | null => shipInput[key]?.ref?.fileID ?? null
  const extGroup = (key: string): FieldSlot[] =>
    seatVehicle ? [] : thirdPersonGroup(shipSpecs, extId(key)).map((s) => addField(s, 1))
  const extThruster = extGroup('jetFX')
  const extBoost = extGroup('afterburnerFX')
  const extSlots = [...extThruster, ...extBoost]
  // A deliberate departure from 2016's values (DEV-836, Matt's lead, 2016's
  // five additive white systems stack into a bloom the size of the ship from
  // the chase camera): the same systems, smaller, warm and dimmer. `scale`
  // multiplies size and reach at spawn, the palette tints, `alpha` thins the
  // additive sum. The values are looks, tuned from photographs.
  for (const slot of extSlots) {
    slot.field.setDrive({ rate: 1, alpha: EXTERNAL_FLAME.alpha, speed: 1 })
    const e = slot.emitters[0]
    if (!e) continue
    e.scale = EXTERNAL_FLAME.scale
    e.setPalette(EXTERNAL_FLAME.palette)
  }

  // ── DEV-428 / DEV-429: the authored two ────────────────────────────────
  // Built only when asked for at load, so a world without them carries no
  // field and compiles no paper program. The emitter matrices are written per
  // event (the strike) or per frame (the spray); the local pose is identity.
  const addAuthored = (spec: ParticleSpec, emitterCount: number): FieldSlot => {
    const field = createParticleField(spec, texture, {
      capacity: Math.min(
        FIELD_CAPACITY_CEILING,
        (spec.initial?.maxParticles ?? 100) * emitterCount,
      ),
      look: 'paper',
    })
    group.add(field.object)
    const emitters: ParticleEmitter[] = []
    for (let i = 0; i < emitterCount; i++) emitters.push(field.addEmitter())
    const slot: FieldSlot = { spec, field, emitters, local: new THREE.Matrix4() }
    slots.push(slot)
    return slot
  }
  const strikeSlot = options.propBurst
    ? addAuthored(propStrikeSpec(options.propBurst), STRIKE_EMITTERS)
    : null
  let strikeBursts = 0
  /** Written per strike and COPIED into the emitter (`setPalette` copies). Trap 19. */
  const strikeColours = new Float32Array(MAX_PALETTE * 3)
  const sprayWanted = options.waterSpray && !seatVehicle ? options.waterSpray : null
  const spraySlot = sprayWanted ? addAuthored(waterSpraySpec(sprayWanted), 1) : null
  let sea: SeaSource | null = null
  let sprayStrengthNow = 0
  let sprayHeightNow: number | null = null
  let sprayDepthNow: number | null = null
  /** The spray's drive, reused every frame; `setDrive` copies it (trap 19). */
  const sprayDrive = { rate: 0, alpha: 1, speed: 1 }
  /** `seaUnder`'s answer, reused every frame. */
  const seaNow = { seaY: 0, depth: 0 }
  // DEV-613: the splash's two parts, a fixed pool of `emitters` each, paired by
  // index: one splash is crown i and drops i, posed together.
  const splashSpec = options.splash ?? null
  const crownSlot = splashSpec
    ? addAuthored(splashCrownSpec(splashSpec), splashSpec.emitters)
    : null
  const dropsSlot = splashSpec
    ? addAuthored(splashDropsSpec(splashSpec), splashSpec.emitters)
    : null
  let splashesThrown = 0
  let lastSplash: { x: number; y: number; z: number; scale: number } | null = null

  // ── the JumpSeat's own (DEV-416) ───────────────────────────────────────
  const seatSpecs = seatVehicle ? jumpSeatEffectSpecs() : null
  const seatGroup = (specs: readonly ExtractedParticle[] | undefined): FieldSlot[] =>
    (specs ?? []).map((s) => addField(s, 1))
  const seatThruster = seatGroup(seatSpecs?.thruster)
  const seatBoost = seatGroup(seatSpecs?.boost)
  const seatGround = seatGroup(seatSpecs?.ground)
  const seatWind = seatGroup(seatSpecs?.wind)
  const seatRidesShip = [...seatThruster, ...seatBoost, ...seatWind]
  const minWind = seatVehicle ? seatMinWindSpeed() : Number.POSITIVE_INFINITY
  const seatOrigin = new THREE.Vector3()
  const seatUp = new THREE.Vector3()
  const groundShift = new THREE.Vector3()
  const leadAt = new THREE.Vector3()
  /** Play a group on the lead's rising edge, stop it on the falling one — 2016's toggles. */
  const driveGroup = (group: readonly FieldSlot[], on: boolean): void => {
    const lead = group[0]?.emitters[0]
    if (!lead) return
    if (on && !lead.playing) for (const s of group) s.emitters[0]?.play()
    else if (!on && lead.playing) for (const s of group) s.emitters[0]?.stop()
  }
  // The three the eye is supposed to read as wind. Not `flight_particles`: it
  // is a stretch-mode system too, but with `velocityScale` 0 and `lengthScale`
  // 1 its length IS its size — a mote, not a streak — and the near field is
  // DEV-080's problem, not this one.
  const speedLineFields = [boost1, boost2, boost3]
    .filter(Boolean)
    .map((s) => (s as FieldSlot).field)
  // The same three, as slots, because the lift is a TRANSFORM on the emitter and
  // the override is a material on the field — two different things that happen
  // to name the same systems. See `speedLineLift`.
  const boostSlots = [boost1, boost2, boost3].filter(Boolean) as FieldSlot[]
  let speedLineLift = options.speedLineLift ?? 0
  /** Scratch for the lift, composed fresh every pose. Never stored (trap 19). */
  const liftMatrix = new THREE.Matrix4()
  // DEV-351. In stage order, nulls kept, so index i is stage i + 1 — the same
  // array the cut logic walks, hoisted out of the per-frame call.
  const boostStages = [boost1, boost2, boost3] as const
  let speedRamp: SpeedLineRamp | null = options.speedRamp ?? null
  /** Written by `speedLineDrives` every frame and COPIED by `setDrive`. Trap 19. */
  const driveScratch: [SpeedLineDrive, SpeedLineDrive, SpeedLineDrive] = [
    { rate: 0, alpha: 0, speed: 0 },
    { rate: 0, alpha: 0, speed: 0 },
    { rate: 0, alpha: 0, speed: 0 },
  ]

  const fx: ParticleFx = {
    object: group,
    get alive() {
      let n = 0
      for (const s of slots) n += s.field.alive
      return n
    },
    speedLineFields,
    get speedLineLift() {
      return speedLineLift
    },
    get speedRamp() {
      return speedRamp
    },
    speedLineStages: stages,

    setSpeedRamp(ramp: SpeedLineRamp | null): void {
      speedRamp = ramp
      // Back to the cuts: every boost field goes back to the spec NOW, so the
      // cut logic below never inherits a half-faded alpha or a slowed spawn.
      if (!ramp) for (const slot of boostSlots) slot.field.setDrive(null)
    },

    setSpeedLines(override: ParticleOverride | null): void {
      for (const field of speedLineFields) field.setOverride(override)
    },

    setSpeedLineLift(metres: number): void {
      speedLineLift = Number.isFinite(metres) ? metres : 0
    },

    setRingBurstRandomDirection(amount: number): void {
      // EVERY field, not just the gate's: the flag is about a shape module, and
      // which systems have `randomDirection: true` is the sheet's business, not
      // this function's. It is inert on the twenty that do not.
      for (const slot of slots) slot.field.setRandomDirection(amount)
    },

    burstRing(ringIndex: number): void {
      for (const slot of ringOneShot) {
        const e = slot.emitters[ringIndex]
        if (!e) continue
        // `play()` is idempotent while playing, and these are 0.25 s one-shots
        // that stop themselves — so re-flying a gate re-fires it.
        e.stop()
        e.play()
      }
    },

    burstRingSparkle(ringIndex: number, tone: 'clean' | 'miss'): void {
      const miss = tone === 'miss'
      for (const slot of ringSparkle) {
        const e = slot.emitters[ringIndex]
        if (!e) continue
        e.stop()
        // Set before `play()`: a spawned particle takes its tint when it is born.
        e.setPalette(miss ? MISS_PALETTE : SPARKLE_PALETTE)
        e.scale = miss ? GATE_FEEL.missScale : GATE_FEEL.sparkleScale
        e.play()
      }
    },

    updateSeat(matrix: THREE.Matrix4, fx: SeatEffects): void {
      for (const slot of seatRidesShip) {
        slot.emitters[0]?.matrix.multiplyMatrices(matrix, slot.local)
      }
      // `HoverMotor.cs:71-76`: `ground_fx.transform.position = hit.point` while
      // thrusting over ground within twice `hoverHeight`. The lead's world
      // position moves to the hit and its child rides with it. Not grounded, it
      // is left where it was, as 2016 left it.
      const grounded = fx.thrusting && fx.hoverActive && Number.isFinite(fx.hoverDistance)
      const lead = seatGround[0]?.emitters[0]
      if (grounded && lead) {
        for (const slot of seatGround) {
          slot.emitters[0]?.matrix.multiplyMatrices(matrix, slot.local)
        }
        seatOrigin.setFromMatrixPosition(matrix)
        seatUp.setFromMatrixColumn(matrix, 1).normalize()
        groundShift
          .copy(seatOrigin)
          .addScaledVector(seatUp, -fx.hoverDistance)
          .sub(leadAt.setFromMatrixPosition(lead.matrix))
        for (const slot of seatGround) {
          const m = slot.emitters[0]?.matrix
          if (!m) continue
          m.elements[12] = (m.elements[12] ?? 0) + groundShift.x
          m.elements[13] = (m.elements[13] ?? 0) + groundShift.y
          m.elements[14] = (m.elements[14] ?? 0) + groundShift.z
        }
      }
      driveGroup(seatThruster, fx.thrusting)
      driveGroup(seatBoost, fx.boosting)
      driveGroup(seatGround, grounded)
      driveGroup(seatWind, fx.speed >= minWind)
    },

    updateExternal(matrix, external, thrusting, boosting): void {
      for (const slot of extSlots) {
        slot.emitters[0]?.matrix.multiplyMatrices(matrix, slot.local)
      }
      driveGroup(extThruster, external && thrusting)
      driveGroup(extBoost, external && boosting)
    },

    updateShip(matrix: THREE.Matrix4, forwardSpeed: number): void {
      for (const slot of shipSlots) {
        slot.emitters[0]?.matrix.multiplyMatrices(matrix, slot.local)
      }
      // The boost tubes, lifted toward the eye in the SHIP's frame — ship, then
      // the lift along the ship's own up, then the authored local pose — so the
      // tube rides the bank with the cockpit rather than sliding off it. At 0
      // this is the loop above, exactly.
      if (speedLineLift !== 0) {
        liftMatrix.makeTranslation(0, speedLineLift, 0)
        for (const slot of boostSlots) {
          const m = slot.emitters[0]?.matrix
          if (m) m.multiplyMatrices(matrix, liftMatrix).multiply(slot.local)
        }
      }
      // `Ship_HoverShip.Update()`: above the threshold it plays, below it stops.
      const wantFlight = forwardSpeed > MIN_FLIGHT
      if (flight) {
        if (wantFlight && !flight.emitters[0]?.playing) flight.emitters[0]?.play()
        if (!wantFlight && flight.emitters[0]?.playing) flight.emitters[0]?.stop()
      }
      // DEV-351, Anniversary: the stages crossfade and the first ramps in. A
      // stage plays while its rate is above zero and stops when it reaches it,
      // so a stage that has handed over lets its streaks finish their lives the
      // way 2016's `Stop()` did.
      if (speedRamp) {
        speedLineDrives(forwardSpeed, stages, speedRamp, driveScratch)
        boostStages.forEach((slot, i) => {
          if (!slot) return
          const e = slot.emitters[0]
          const d = driveScratch[i]
          if (!e || !d) return
          slot.field.setDrive(d)
          if (d.rate > 0) {
            if (!e.playing) e.play()
          } else if (e.playing) {
            e.stop()
          }
        })
        return
      }
      // Exactly ONE boost stage at a time — 2016 stops the other two explicitly,
      // so they are mutually exclusive rather than layered. Classic, to the bit:
      // no field on this path is ever driven.
      const stage = boostStageAt(forwardSpeed, stages)
      boostStages.forEach((slot, i) => {
        if (!slot) return
        const e = slot.emitters[0]
        if (!e) return
        if (stage === i + 1) {
          if (!e.playing) e.play()
        } else if (e.playing) {
          e.stop()
        }
      })
    },

    burstPad(padIndex: number): void {
      // 2016 plays it only if the burst is not already playing, so a bullseye
      // and then a mid plate within its half second is one burst, not two.
      const lead = padSlots[0]?.emitters[padIndex]
      if (!lead || lead.playing) return
      for (const slot of padSlots) slot.emitters[padIndex]?.play()
    },

    collectOrb(): void {
      const e = orb?.emitters[0]
      if (!e) return
      e.stop()
      e.play()
    },

    strikeProp(strike, spec, eye): boolean {
      if (!strikeSlot) return false
      const dx = strike.point.x - eye.x
      const dy = strike.point.y - eye.y
      const dz = strike.point.z - eye.z
      if (dx * dx + dy * dy + dz * dz > spec.maxMetres * spec.maxMetres) return false
      // The emitter with the fewest pieces still in the air — an idle one when
      // there is one, and otherwise the oldest burst gives way. Its cap is
      // per EMITTER (DEV-417), so a burst on a busy emitter would be short.
      let e = strikeSlot.emitters[0] as ParticleEmitter
      for (const c of strikeSlot.emitters) if (c.alive < e.alive) e = c
      e.matrix.makeTranslation(strike.point.x, strike.point.y, strike.point.z)
      e.velocity.set(
        strike.velocity.x * spec.carry,
        strike.velocity.y * spec.carry,
        strike.velocity.z * spec.carry,
      )
      const n = strike.geometry
        ? strikePalette(
            propFaceTable(strike.geometry),
            strike.heightFraction,
            spec.colourBand,
            MAX_PALETTE,
            strike.id * 2654435761 + strikeBursts,
            strike.tint,
            spec.shade,
            strikeColours,
          )
        : 0
      if (n === 0) {
        strikeColours[0] = strike.tint.r * spec.shade
        strikeColours[1] = strike.tint.g * spec.shade
        strikeColours[2] = strike.tint.b * spec.shade
      }
      e.setPalette(strikeColours.subarray(0, Math.max(1, n) * 3))
      e.stop()
      e.play()
      strikeBursts++
      return true
    },

    get strike() {
      return strikeSlot ? { bursts: strikeBursts, alive: strikeSlot.field.alive } : null
    },

    splash(point, velocity, scale, eye): boolean {
      if (!crownSlot || !dropsSlot || !splashSpec) return false
      const dx = point.x - eye.x
      const dy = point.y - eye.y
      const dz = point.z - eye.z
      if (dx * dx + dy * dy + dz * dz > splashSpec.maxMetres * splashSpec.maxMetres) return false
      // The pair with the fewest pieces in the air, an idle one first: a pair
      // fired this frame has not spawned yet and reads as empty, so `playing`
      // is what keeps two splashes in one frame from landing on one pair.
      let best = 0
      let bestScore = Number.POSITIVE_INFINITY
      for (let i = 0; i < crownSlot.emitters.length; i++) {
        const c = crownSlot.emitters[i] as ParticleEmitter
        const d = dropsSlot.emitters[i] as ParticleEmitter
        const score = c.alive + d.alive + (c.playing || d.playing ? 1e6 : 0)
        if (score < bestScore) {
          bestScore = score
          best = i
        }
      }
      const carry = splashSpec.carry
      for (const slot of [crownSlot, dropsSlot]) {
        const e = slot.emitters[best] as ParticleEmitter
        e.matrix.copy(SPRAY_UP).setPosition(point.x, point.y, point.z)
        e.velocity.set(velocity.x * carry, velocity.y * carry, velocity.z * carry)
        e.scale = scale
        e.stop()
        e.play()
      }
      splashesThrown++
      lastSplash = { x: point.x, y: point.y, z: point.z, scale }
      return true
    },

    get splashes() {
      return crownSlot && dropsSlot && splashSpec
        ? {
            thrown: splashesThrown,
            alive: crownSlot.field.alive + dropsSlot.field.alive,
            emitters: splashSpec.emitters,
            capacity: (splashSpec.crown.count + splashSpec.drops.count) * splashSpec.emitters,
            last: lastSplash,
          }
        : null
    },

    setSea(next: SeaSource | null): void {
      sea = next
    },

    updateSpray(input: SprayInput): void {
      const e = spraySlot?.emitters[0]
      if (!spraySlot || !e) return
      sprayStrengthNow = 0
      sprayHeightNow = null
      sprayDepthNow = null
      if (sea && input.active) {
        const p = input.position
        const v = input.velocity
        seaUnder(sea, p.x, p.z, seaNow)
        sprayHeightNow = p.y - seaNow.seaY
        sprayDepthNow = seaNow.depth
        sprayStrengthNow = sprayStrength(
          input.spec,
          sprayHeightNow,
          seaNow.depth,
          Math.hypot(v.x, v.y, v.z),
          input.speedFx,
        )
        poseSprayEmitter(e, p, v, input.spec.carry)
      }
      if (sprayStrengthNow > 0) {
        sprayDrive.rate = sprayStrengthNow
        spraySlot.field.setDrive(sprayDrive)
        if (!e.playing) e.play()
      } else if (e.playing) {
        e.stop()
      }
    },

    get spray() {
      return spraySlot
        ? {
            strength: sprayStrengthNow,
            height: sprayHeightNow,
            depth: sprayDepthNow,
            alive: spraySlot.field.alive,
          }
        : null
    },

    update(dt: number, camera: THREE.Camera): void {
      for (const slot of slots) slot.field.update(dt, camera)
    },

    dispose(): void {
      for (const slot of slots) slot.field.dispose()
      texture.dispose()
    },
  }

  void ringContinuous
  return fx
}
