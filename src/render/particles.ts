// src/render/particles.ts — Shuriken, reduced to the ten modules FF2 uses.
//
// ── Scope, and why it is this small ───────────────────────────────────────
//
// Unity's particle system has 22 modules. The shipped gate and the shipped ship
// between them enable exactly ten, and after the liveness walk the set that
// actually draws anything is smaller still. This is not a port of Shuriken; it
// is a port of the parts *Faceted Flight* uses. `tools/extract/particles.mjs`
// records the census that justifies the line.
//
// ── The liveness walk paid for itself here ───────────────────────────────
//
// The ship serialises 17 particle systems and 15 of them have an enabled
// EmissionModule. **Six** are live. All ten afterburner and thruster systems
// hang under `ThirdPerson`, which is `m_IsActive: 0`, or under `playbackGhost`,
// also off — so in the shipped first-person game the engines emit NOTHING, and
// a port that drew them would have been inventing an effect the game never had.
//
// What is left is exactly what `Ship_HoverShip` references:
//
//   flight_particles   flightEffects          above  25 m/s
//   boost_particles    boostEffects           above 120 m/s
//   fasterBoost        boostEffects_stage2    above 240 m/s
//   ludacrisSpeed      boostEffects_stage3    above 350 m/s
//   effect_orbCollect  orbEffects             on pickup
//
// Those four speeds are off the PREFAB. The C# initialisers say 5 and 32 — the
// cardinal rule again, and this time it is worth a factor of four on when the
// boost effect appears. Top speed is 437.5, so `ludacrisSpeed` is the top 20 %.
//
// On the gate: six live emitters, all `ringBurst`. `ringIdle` has a DISABLED
// EmissionModule, so a gate has no idle sparkle — it only bursts.
//
// ── MinMaxCurve ──────────────────────────────────────────────────────────
//
// Every scalar in Shuriken is `{scalar, min, max, mode}` and `scalar` is a
// MULTIPLIER, not the value. Mode 3 (random between two constants) is the common
// one, and it is worth a factor of 100 on a start speed if you read `scalar` as
// the answer. See `evaluateMinMax`.
//
// ── One material, and it is ours ─────────────────────────────────────────
//
// All 25 systems render with `TriParticle.mat`: Unity's built-in
// `Particles/Additive` over a 64x64 white DOWNWARD TRIANGLE with an alpha matte,
// from Matt's own `particles/` directory. 835 bytes as a PNG. The faceted
// world's particles are little triangles, and the tint is doubled because
// Unity's additive particle shader does `2.0 * color * _TintColor`.
//
// ── The one deviation this engine knows about: `ParticleOverride` ────────
//
// DEV-079 (ANNIVERSARY.md S2). The 2016 speed lines are authored 5–8 cm wide
// and render as 1–2 px hairlines, so the Anniversary preset re-authors what the
// eye can measure — width, alpha, and how the streak sits on its background —
// and NOTHING about the simulation. Positions, speeds, rates, lifetimes,
// shapes and the authored streak LENGTH all still come off the generated spec:
// the override is four numbers that reach the shader and nowhere else.
//
// `NO_OVERRIDE` is the identity, it is the default, and with it every uniform
// holds the value the shader used to hard-code — which is what lets the Classic
// path stay byte-identical rather than merely similar
// (`tests/unit/speed-lines.test.ts` asserts that, not this comment).
//
// ── And the second: `ParticleDrive` ───────────────────────────────────────
//
// DEV-351. The override is a LOOK and never touches the simulation; the drive
// is what the SPEED does to a field frame by frame — three multipliers, on the
// emission rate, the alpha, and the spawn speed — so the boost stages can ramp
// and crossfade instead of cutting. It is a separate type on purpose: the
// override's promise ("four numbers that reach the shader and nowhere else")
// stays true, and the drive makes the other promise instead. `NO_DRIVE` is the
// identity and the default, each multiplier is applied as `x * 1` when it is,
// and no `rand()` is added or moved — so an undriven field is the field it
// always was, to the bit (`tests/unit/speed-line-ramp.test.ts` asserts it).
//
// ── And two things no 2016 system needed: PAPER, and EVENTS ──────────────
//
// DEV-428 and DEV-429, both Anniversary. A struck prop bursts in its own
// colours, and the sea throws spray at a ship skimming it. Neither is a 2016
// system, so both specs are AUTHORED (`game/particle-fx.ts` builds them from
// the preset) and both needed three things this engine did not have:
//
//   `look: 'paper'`   ART_DIRECTION's glow rule: *"Nothing else glows: not
//                     terrain, not water, not rock, not paint, not a prop."*
//                     Additive leaves are glowing leaves. A paper field draws
//                     the same triangle matte OPAQUE — cut, not blended, and
//                     writing depth — in the particle's own colour, through
//                     three's tone curve and output encoding like any other
//                     thing in the world. A define, so the additive program's
//                     behaviour is untouched and only a paper field pays for it.
//   `emitter.velocity`  world m/s added to every particle the emitter spawns —
//                     Unity's Inherit Velocity module, reduced to a vector. The
//                     burst leaves with some of the hit; the spray with some
//                     of the ship.
//   `setPalette`      RGB triples; each particle takes one. The prop's own face
//                     colours, picked where it was struck.
//
// All three are INERT until asked for, and the inert path is the old path to
// the bit: a zero velocity is never added (so no `-0 + 0` changes a sign), and
// a palette's extra `rand()` is drawn only by an emitter that has one, so no
// existing field's random stream moves.
//
// ── And one more per emitter: SCALE (DEV-613) ─────────────────────────────
//
// A splash is one field drawn at many places, and what crossed the water says
// how big each one is: a dolphin's, or a jet's going in at 150 m/s. So an
// emitter carries a `scale`, and a particle it spawns is that many times the
// size, thrown from that many times the radius, at the square root of it the
// speed for the square root of it the time. That is Froude's similarity: under
// one gravity a splash k times the size rises and falls in sqrt(k) the time,
// so every length of it, its height included, is k times. 1 (the default) is
// never applied, so a field nobody scales is the old path to the bit, and no
// `rand()` is added or moved.

import * as THREE from 'three'
import { evaluateCurve } from '@/sim/art-lean'
import { fnv1a32 } from '@/sim/math/hash'

/** `_TintColor` on TriParticle.mat, and the x2 Particles/Additive applies. */
export const TRI_PARTICLE_TINT = [0.867647, 0.867647, 0.867647, 0.87] as const
export const ADDITIVE_TINT_GAIN = 2

/**
 * The `ParticleSystemSimulationSpace` values this engine implements, spelled the
 * way `tools/extract/particles.mjs` spells them (`SIMULATION_SPACE`, indexed by
 * Unity 5's `moveWithTransform`). DEV-308.
 *
 * Unity's third value, `custom`, is on none of the 25 shipped systems and has no
 * reader here. `tests/unit/particles.test.ts` fails if a LIVE system ever
 * carries a value that is not in this list, which is the point of exporting it:
 * the day somebody adds one, the arrival is loud rather than silent.
 */
export const SIMULATION_SPACES_HANDLED = ['world', 'local'] as const

/**
 * Does this spec's particles RIDE the emitter, or are they left behind?
 *
 * Unity's field is called `moveWithTransform` and that is exactly what it means:
 * a `local` system stores its particles in the emitter's frame, so moving the
 * emitter moves every live particle with it. A `world` one does not.
 *
 * Exported so a test can ask the engine the question rather than retyping the
 * string — CLAUDE.md's DEV-069 rule, *when you implement something the sheet has
 * a key for, import the key and assert against it*.
 */
export const ridesWithEmitter = (spec: { readonly simulationSpace: string }): boolean =>
  spec.simulationSpace === 'local'

/**
 * The re-authoring a field may be built with. ANNIVERSARY.md S2 / DEV-079.
 *
 * Every field is either at `NO_OVERRIDE` — the 2016 material, exactly — or
 * carrying one of these, and the four numbers reach the SHADER only. Nothing
 * here can move a particle, change how many there are, or change how long one
 * lives: a spec is generated (hard rule 3) and stays generated.
 */
export interface ParticleOverride {
  /**
   * Multiplies the rendered WIDTH. The authored streak LENGTH is deliberately
   * untouched — `iParams.z` is still `size * lengthScale + speed *
   * velocityScale` off the unscaled size, because the 100 m tube streaming back
   * is the authored design and S2 only makes it thick enough to see.
   */
  readonly widthScale: number
  /** Multiplies the particle's alpha, after the gradient and before the blend. */
  readonly alphaScale: number
  /**
   * Swap the hard triangle matte for a soft-edged streak, and lay it OVER the
   * background instead of adding to it. Additive white cannot darken, so on
   * 2016's bright mauve sky an additive streak has nowhere to go; this is what
   * makes `coreDarkness` mean anything.
   */
  readonly softEdge: boolean
  /** 0–1. How dark the streak's centreline goes. Needs `softEdge`. */
  readonly coreDarkness: number
}

/** The identity: the 2016 material, and the default everywhere. */
export const NO_OVERRIDE: ParticleOverride = Object.freeze({
  widthScale: 1,
  alphaScale: 1,
  softEdge: false,
  coreDarkness: 0,
})

/** Fill the gaps from `NO_OVERRIDE`. `null` is the identity, not a crash. */
export const resolveOverride = (o?: Partial<ParticleOverride> | null): ParticleOverride =>
  o ? Object.freeze({ ...NO_OVERRIDE, ...o }) : NO_OVERRIDE

/**
 * What the ship's speed does to a field, this frame. DEV-351.
 *
 * Unlike `ParticleOverride` this DOES reach the simulation: how many particles
 * are born and how fast they leave. It never reaches a particle already in the
 * air except through the alpha, so a crossfade lets the outgoing stage's
 * streaks finish their lives the way 2016's `Stop()` did.
 */
export interface ParticleDrive {
  /** Multiplies the emission rate. 0 emits nothing; 1 is the spec. */
  readonly rate: number
  /** Multiplies the particle alpha, on top of the override's `alphaScale`. */
  readonly alpha: number
  /**
   * Multiplies the SPAWN speed. The drawn streak length is computed from the
   * particle's velocity, so this scales the stretch with it.
   */
  readonly speed: number
}

/** The identity: the spec as generated, and the default everywhere. */
export const NO_DRIVE: ParticleDrive = Object.freeze({ rate: 1, alpha: 1, speed: 1 })

/**
 * How a field is drawn. DEV-428 / DEV-429.
 *
 * `additive` is every 2016 system: Unity's `Particles/Additive` over
 * `TriParticle.mat`, light added to the frame. `paper` is the same triangle
 * matte cut OPAQUE in the particle's own colour — for things that are not
 * light: a struck tree's leaves, the sea's spray.
 */
export type ParticleLook = 'additive' | 'paper'

/** The most colours an emitter's palette holds. `setPalette` keeps the first this many. */
export const MAX_PALETTE = 32

export interface CurveKeyLike {
  readonly time: number
  readonly value: number
  readonly inSlope: number
  readonly outSlope: number
}

export interface MinMaxCurveLike {
  readonly mode: number
  readonly scalar: number
  readonly min: number
  readonly max: number
  readonly minCurve: readonly CurveKeyLike[] | null
  readonly maxCurve: readonly CurveKeyLike[] | null
}

export interface GradientLike {
  readonly colours: readonly { time: number; color: readonly number[] }[]
  readonly alphas: readonly { time: number; alpha: number }[]
}

export interface MinMaxGradientLike {
  readonly mode: number
  readonly max: GradientLike | null
  readonly min: GradientLike | null
}

/**
 * Evaluate a Shuriken `MinMaxCurve`.
 *
 * `t` is normalised lifetime for the over-lifetime modes; `r` is a per-particle
 * random in [0, 1), held constant for that particle's whole life so a value does
 * not shimmer between frames.
 */
export const evaluateMinMax = (
  c: MinMaxCurveLike | null | undefined,
  t: number,
  r: number,
): number => {
  if (!c) return 0
  switch (c.mode) {
    case 1:
      return c.scalar * evaluateCurve({ keys: (c.maxCurve ?? []) as CurveKeyLike[] }, t)
    case 2: {
      const lo = evaluateCurve({ keys: (c.minCurve ?? []) as CurveKeyLike[] }, t)
      const hi = evaluateCurve({ keys: (c.maxCurve ?? []) as CurveKeyLike[] }, t)
      return c.scalar * (lo + (hi - lo) * r)
    }
    case 3:
      return c.scalar * (c.min + (c.max - c.min) * r)
    default:
      // Mode 0 is a plain constant, and the constant IS `scalar`.
      return c.scalar
  }
}

const sampleGradient = (g: GradientLike | null, t: number, out: THREE.Vector4): THREE.Vector4 => {
  if (!g) return out.set(1, 1, 1, 1)
  const at = <T extends { time: number }>(keys: readonly T[]): [T, T, number] => {
    if (keys.length === 0) throw new Error('gradient with no keys')
    let i = 0
    while (i < keys.length - 1 && (keys[i + 1] as T).time < t) i++
    const a = keys[i] as T
    const b = (keys[i + 1] ?? a) as T
    const span = b.time - a.time
    return [a, b, span > 1e-6 ? Math.min(1, Math.max(0, (t - a.time) / span)) : 0]
  }
  const [ca, cb, cf] = at(g.colours)
  const [aa, ab, af] = at(g.alphas)
  return out.set(
    (ca.color[0] as number) + ((cb.color[0] as number) - (ca.color[0] as number)) * cf,
    (ca.color[1] as number) + ((cb.color[1] as number) - (ca.color[1] as number)) * cf,
    (ca.color[2] as number) + ((cb.color[2] as number) - (ca.color[2] as number)) * cf,
    aa.alpha + (ab.alpha - aa.alpha) * af,
  )
}

/** Evaluate a `MinMaxGradient`. Modes 2 and 3 lerp the pair by `r`. */
export const evaluateGradient = (
  g: MinMaxGradientLike | null | undefined,
  t: number,
  r: number,
  out: THREE.Vector4,
): THREE.Vector4 => {
  if (!g) return out.set(1, 1, 1, 1)
  sampleGradient(g.max, t, out)
  if ((g.mode === 2 || g.mode === 3) && g.min) {
    const lo = sampleGradient(g.min, t, _gradScratch)
    out.lerp(lo, 1 - r)
  }
  return out
}
const _gradScratch = new THREE.Vector4()

/**
 * A small deterministic PRNG.
 *
 * Not for fidelity — Unity's own stream is not reproducible from the outside —
 * but so a screenshot test sees the same frame twice. `randomSeed: 0` in Unity
 * means "pick one at runtime", which is exactly what a golden image cannot have.
 */
const makeRandom = (seed: number) => {
  let s = (seed || 0x9e3779b9) >>> 0
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

/** The subset of the extracted spec this engine reads. */
export interface ParticleSpec {
  readonly name: string
  readonly lengthSeconds: number
  readonly looping: boolean
  readonly simulationSpace: string
  readonly simulationSpeed: number
  readonly randomSeed: number
  readonly initial: {
    readonly lifetime: MinMaxCurveLike
    readonly speed: MinMaxCurveLike
    readonly size: MinMaxCurveLike
    readonly rotationDeg: MinMaxCurveLike
    readonly colour: MinMaxGradientLike
    readonly gravityModifier: number
    readonly maxParticles: number
  } | null
  readonly emission: {
    readonly enabled: boolean
    readonly type: number
    readonly rate: MinMaxCurveLike
    readonly bursts: readonly { time: number; min: number; max: number }[]
  } | null
  readonly shape: {
    readonly enabled: boolean
    readonly type: string
    readonly radius: number
    readonly angleDeg: number
    readonly length: number
    readonly box: readonly number[]
    readonly randomDirection: boolean
  } | null
  readonly sizeOverLifetime: { readonly enabled: boolean; readonly curve: MinMaxCurveLike } | null
  readonly rotationOverLifetime: {
    readonly enabled: boolean
    readonly curve: MinMaxCurveLike
  } | null
  readonly colourOverLifetime: {
    readonly enabled: boolean
    readonly gradient: MinMaxGradientLike
  } | null
  readonly clampVelocity: {
    readonly enabled: boolean
    readonly magnitude: MinMaxCurveLike
    readonly dampen: number
  } | null
  readonly renderer: {
    readonly mode: string
    readonly lengthScale: number
    readonly velocityScale: number
  } | null
  readonly emits: boolean
}

/**
 * Pick a spawn position and direction for a shape.
 *
 * Unity's cone emits from a disc of `radius` at the apex plane and spreads by
 * `angle`; the shell variants emit from the EDGE of that disc rather than
 * across it, which is the difference between a spray and a ring of spray.
 *
 * Unity cones point along +Z (the transform's forward); so does this, and the
 * caller's emitter matrix is what aims it.
 */
const sampleShape = (
  shape: ParticleSpec['shape'],
  rand: () => number,
  position: THREE.Vector3,
  direction: THREE.Vector3,
  randomAmount: number,
): void => {
  position.set(0, 0, 0)
  direction.set(0, 0, 1)
  if (!shape?.enabled) return

  const theta = rand() * Math.PI * 2
  switch (shape.type) {
    case 'cone':
    case 'coneVolume': {
      const r = shape.radius * Math.sqrt(rand())
      position.set(Math.cos(theta) * r, Math.sin(theta) * r, 0)
      const spread = Math.tan((shape.angleDeg * Math.PI) / 180)
      direction
        .set(
          Math.cos(theta) * spread * (r / (shape.radius || 1)),
          Math.sin(theta) * spread * (r / (shape.radius || 1)),
          1,
        )
        .normalize()
      break
    }
    case 'coneShell':
    case 'coneVolumeShell': {
      // The EDGE of the disc, not across it.
      const r = shape.radius
      position.set(Math.cos(theta) * r, Math.sin(theta) * r, 0)
      const spread = Math.tan((shape.angleDeg * Math.PI) / 180)
      direction.set(Math.cos(theta) * spread, Math.sin(theta) * spread, 1).normalize()
      break
    }
    case 'sphere':
    case 'sphereShell': {
      const u = rand() * 2 - 1
      const s = Math.sqrt(Math.max(0, 1 - u * u))
      direction.set(s * Math.cos(theta), s * Math.sin(theta), u)
      const r = shape.type === 'sphereShell' ? shape.radius : shape.radius * Math.cbrt(rand())
      position.copy(direction).multiplyScalar(r)
      break
    }
    case 'hemisphere':
    case 'hemisphereShell': {
      const u = rand()
      const s = Math.sqrt(Math.max(0, 1 - u * u))
      direction.set(s * Math.cos(theta), s * Math.sin(theta), u)
      position.copy(direction).multiplyScalar(shape.radius)
      break
    }
    case 'circle':
    case 'circleEdge': {
      const r = shape.type === 'circleEdge' ? shape.radius : shape.radius * Math.sqrt(rand())
      position.set(Math.cos(theta) * r, Math.sin(theta) * r, 0)
      direction.set(Math.cos(theta), Math.sin(theta), 0)
      break
    }
    case 'box': {
      position.set(
        (rand() - 0.5) * (shape.box[0] as number),
        (rand() - 0.5) * (shape.box[1] as number),
        (rand() - 0.5) * (shape.box[2] as number),
      )
      direction.set(0, 0, 1)
      break
    }
    default:
      break
  }
  // ── DEV-272: BLEND toward random, do not replace with it ─────────────────
  //
  // Unity 5 serialises `randomDirection` as a bool and this read it as "throw
  // the shape's direction away". `randomAmount` 1 is that, to the bit — the
  // same three `rand()` calls in the same order, the same vector — so Classic
  // is unmoved and a seeded field reproduces. Below 1 the random direction is
  // blended toward the authored cone.
  //
  // The three `rand()` calls happen BEFORE the branch on purpose: a sampling
  // path whose random consumption depends on a tuning number is a field that
  // reseeds itself when you move a slider.
  if (shape.randomDirection && randomAmount > 0) {
    const u = rand() * 2 - 1
    const s = Math.sqrt(Math.max(0, 1 - u * u))
    const phi = rand() * Math.PI * 2
    if (randomAmount >= 1) {
      direction.set(s * Math.cos(phi), s * Math.sin(phi), u)
    } else {
      // Volatile, and valid only inside this synchronous call — which is the
      // whole of its life. Never store a reference to it (trap 19).
      _randomDirScratch.set(s * Math.cos(phi), s * Math.sin(phi), u)
      direction.lerp(_randomDirScratch, randomAmount).normalize()
    }
  }
}

/** See the note in `sampleShape`. One call's worth of scratch, nothing more. */
const _randomDirScratch = new THREE.Vector3()

/** One emitter: a place in the world that a field spawns particles from. */
export interface ParticleEmitter {
  /** Emitter pose, world space. Re-read every frame, so a moving emitter works. */
  readonly matrix: THREE.Matrix4
  /** Start (or restart) continuous emission and fire the burst table. */
  play(): void
  /** Stop emitting. Live particles finish their lives. */
  stop(): void
  readonly playing: boolean
  /**
   * World m/s added to every particle this emitter spawns from now on — Unity's
   * Inherit Velocity, as a vector the caller writes into, like `matrix`. Zero
   * (the default) is never added, so an emitter nobody sets is the old path.
   * DEV-428 / DEV-429.
   */
  readonly velocity: THREE.Vector3
  /**
   * RGB triples (linear), each spawned particle tinted by one picked at random.
   * COPIED, the first `MAX_PALETTE`; `null` or empty is none. DEV-428.
   */
  setPalette(rgb: ArrayLike<number> | null): void
  /**
   * DEV-613: how many times the spec's size the particles this emitter spawns
   * from now on are, by gravity's similarity: size and the shape's radius times
   * `scale`, speed and lifetime times its square root. 1 (the default) is never
   * applied. A non-finite or non-positive value is 1.
   */
  scale: number
  /** Live particles this emitter spawned. */
  readonly alive: number
  dispose(): void
}

export interface ParticleField {
  readonly object: THREE.Object3D
  readonly spec: ParticleSpec
  /** Live particle count, for tests and the HUD. */
  readonly alive: number
  /** What is re-authored right now. `NO_OVERRIDE` is the 2016 material. */
  readonly override: ParticleOverride
  /** Re-author, or (`null`) put it back to 2016. Safe on a preset flip. */
  setOverride(override: Partial<ParticleOverride> | null): void
  /** What the speed is doing to this field. `NO_DRIVE` is the spec as generated. */
  readonly drive: ParticleDrive
  /**
   * Drive the field, or (`null`) put it back to the spec. Cheap enough to call
   * every frame: the three numbers are COPIED, never the object (trap 19), and
   * the alpha lands in a uniform. DEV-351.
   */
  setDrive(drive: ParticleDrive | null): void
  /**
   * How much of a `randomDirection` shape's direction is random, 0-1. DEV-272.
   * 1 is the port's own long-standing behaviour. Lands on the NEXT spawn, so a
   * live flip is visible within a frame and never restyles particles already in
   * the air.
   */
  setRandomDirection(amount: number): void
  addEmitter(): ParticleEmitter
  update(dt: number, camera: THREE.Camera): void
  dispose(): void
}

const VERTEX = /* glsl */ `
attribute vec3 iPosition;
attribute vec4 iColor;
attribute vec3 iParams;   // size, rotation (radians), stretch length
attribute vec3 iVelocity;
uniform float uWidthScale;
varying vec4 vColor;
varying vec2 vUv;

void main() {
  vColor = iColor;
  vUv = uv;

  vec4 centre = modelViewMatrix * vec4(iPosition, 1.0);
  // WIDTH only. The stretch length arrives from the CPU already computed off
  // the UNSCALED size, so widening a streak never lengthens it (DEV-079).
  float size = iParams.x * uWidthScale;
  float rot = iParams.y;
  float stretch = iParams.z;

  vec2 corner = position.xy;
  if (stretch > 0.0) {
    // Stretched billboard, built in THREE dimensions and then projected — which
    // is what Unity's Stretch render mode does, and the reason a streak flying
    // down the line of sight converges on the vanishing point instead of
    // standing up (DEV-138).
    //
    // The quad's long axis is the particle's VELOCITY in view space, as a 3D
    // direction; its width axis is perpendicular to both that and the line of
    // sight, so the width faces the eye. The first version of this shader took
    // the velocity's 2D shadow on the screen (normalize of vView.xy) and fell
    // back to view-up when that shadow was short. The boost tubes fly straight
    // at the camera, so their shadow is ALWAYS short: every streak near the
    // tube's far end drew as a full-length vertical line, unforeshortened,
    // however the ship was banked. Unity's lengthScale * size and
    // velocityScale * speed arrive folded into stretch, as before.
    //
    // stretchedCorner() below is this arithmetic in TypeScript, and
    // stretched-billboard.test.ts projects it: the two ends of the quad land on
    // the screen along the projected velocity, and a streak aimed at the eye is
    // a point rather than a line. Change one and change the other.
    vec3 vView = (modelViewMatrix * vec4(iVelocity, 0.0)).xyz;
    float vLen = length(vView);
    vec3 along = vLen > 1e-5 ? vView / vLen : vec3(0.0, 1.0, 0.0);
    vec3 side = cross(along, centre.xyz);
    float sLen = length(side);
    if (sLen > 1e-5) {
      side /= sLen;
    } else {
      // The streak is on the line of sight. Its ends project to one point, so
      // any width axis perpendicular to it is as good as any other.
      vec3 ref = abs(along.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
      side = normalize(cross(along, ref));
    }
    centre.xyz += side * (corner.x * size) + along * (corner.y * stretch);
  } else {
    float s = sin(rot);
    float c = cos(rot);
    vec2 spun = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
    centre.xy += spun * size;
  }
  gl_Position = projectionMatrix * centre;
}
`

const FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec4 uTint;
uniform float uGain;
uniform float uAlphaScale;
uniform float uSoft;
uniform float uCore;
varying vec4 vColor;
varying vec2 vUv;

void main() {
  vec4 tex = texture2D(uMap, vUv);
#ifdef PAPER
  // DEV-428 / DEV-429: a paper facet, not light. The same triangle matte, CUT
  // rather than blended, in the particle's own colour, and then through the
  // tone curve and the output encoding every lit thing in the world takes —
  // both are no-ops into the bloom chain's linear target and real on the
  // canvas and in a headset. Size, not alpha, is how a paper field fades.
  if (tex.a < 0.5) discard;
  gl_FragColor = vec4(vColor.rgb * uTint.rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
#else
  // Across the quad and along it, 0 at the centre line and 1 at the edge. The
  // stretched billboard puts the streak's length on v, so across IS the width.
  float across = abs(vUv.x - 0.5) * 2.0;
  if (uSoft > 0.0) {
    // A soft-edged streak instead of the hard-matted triangle. Six centimetres
    // of hard triangle reads as a hairline; forty centimetres of hard triangle
    // reads as a triangle. See DEV-079.
    float along = abs(vUv.y - 0.5) * 2.0;
    float a = (1.0 - smoothstep(0.30, 1.0, across)) * (1.0 - smoothstep(0.20, 1.0, along));
    tex = mix(tex, vec4(1.0, 1.0, 1.0, a), uSoft);
  }
  // Unity's Particles/Additive is  2.0 * vertexColor * _TintColor * tex.
  // The x2 is in the shader, not in the material, and dropping it halves every
  // particle in the game — so uGain defaults to it, and only the over-blended
  // Anniversary path (where a doubled colour could not darken) drops to 1.
  vec4 c = uGain * vColor * uTint * tex;
  c.a *= uAlphaScale;
  if (uCore > 0.0) {
    // A faint dark core, so the streak reads against a bright sky as well as
    // dark terrain: the flanks stay light, the middle goes dark, and one of the
    // two always has contrast with whatever is behind it.
    c.rgb *= 1.0 - uCore * (1.0 - smoothstep(0.0, 0.45, across));
  }
  if (c.a <= 0.001) discard;
  gl_FragColor = vec4(c.rgb * c.a, c.a);
#endif
}
`

/** The vertex program, exported so a test can hold it to `stretchedCorner`. */
export const PARTICLE_VERTEX_SHADER = VERTEX

/**
 * One corner of a stretched billboard, in VIEW space — `VERTEX`'s stretch
 * branch, line for line, so the projection test can run it in node (DEV-138).
 *
 * `centre` and `velocity` are already in view space (the shader gets them
 * through `modelViewMatrix`); `corner` is the unit quad's (x, y) in ±0.5;
 * `size` is the rendered width and `stretch` the full length. Returns a NEW
 * vector: this is test scaffolding, not a per-frame path.
 */
export const stretchedCorner = (
  centre: THREE.Vector3,
  velocity: THREE.Vector3,
  corner: { x: number; y: number },
  size: number,
  stretch: number,
): THREE.Vector3 => {
  const vLen = velocity.length()
  const along = vLen > 1e-5 ? velocity.clone().divideScalar(vLen) : new THREE.Vector3(0, 1, 0)
  const side = new THREE.Vector3().crossVectors(along, centre)
  const sLen = side.length()
  if (sLen > 1e-5) {
    side.divideScalar(sLen)
  } else {
    const ref = Math.abs(along.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
    side.crossVectors(along, ref).normalize()
  }
  return centre
    .clone()
    .addScaledVector(side, corner.x * size)
    .addScaledVector(along, corner.y * stretch)
}

/**
 * One emitter's mutable state. The last five fields are DEV-308 and exist only
 * on a `local` field; on a `world` one they are `null`/`false` for ever and the
 * carry pass is never entered, so the Classic path is the code it always was.
 */
interface EmitterState {
  matrix: THREE.Matrix4
  playing: boolean
  time: number
  carry: number
  fired: boolean
  alive: boolean
  /** Live particles this emitter spawned, against the system's `maxParticles`. */
  count: number
  /** Last frame's pose, so this frame's motion can be read as a delta. */
  prev: THREE.Matrix4 | null
  /** False until `prev` holds a real pose. See `carryParticles`. */
  posed: boolean
  /** Did this emitter move since the last carry pass? */
  moved: boolean
  /** `matrix . prev^-1`, valid only while `moved`. */
  delta: THREE.Matrix4 | null
  /** `delta`'s upper 3x3, for velocities. */
  deltaLinear: THREE.Matrix3 | null
  /** DEV-428 / DEV-429: world m/s added at spawn. Never read while all three are 0. */
  inherit: THREE.Vector3
  /** DEV-428: `paletteSize` RGB triples, owned (copied in). */
  palette: Float32Array
  paletteSize: number
  /** DEV-613: the spawn scale. Never read while it is 1. */
  scale: number
}

interface Particle {
  age: number
  life: number
  /**
   * WORLD space, always — including on a `local` field, where the emitter's
   * motion is re-applied every frame as a delta instead (`carryParticles`).
   * One field is one draw call shared by every emitter, so there is no single
   * parent matrix a local pool could be stored under. DEV-308.
   */
  px: number
  py: number
  pz: number
  vx: number
  vy: number
  vz: number
  size: number
  rot: number
  spin: number
  /** The per-particle random, held for its whole life. */
  r: number
  emitter: number
  /**
   * DEV-428: this particle's palette colour, multiplied in after the gradient.
   * `tinted` false (every 2016 system) and the three are never read.
   */
  tinted: boolean
  tr: number
  tg: number
  tb: number
}

/**
 * Build a field: one draw call for every emitter sharing this spec.
 *
 * 21 gates x 6 systems would be 126 InstancedMeshes if each emitter owned one.
 * They share, because the spec is what decides the geometry and the material,
 * and the emitter only decides where a particle starts.
 */
export const createParticleField = (
  spec: ParticleSpec,
  map: THREE.Texture,
  {
    capacity = 0,
    override = null,
    randomDirection = 1,
    look = 'additive',
  }: {
    capacity?: number
    override?: Partial<ParticleOverride> | null
    /** DEV-272. 1 is the port's own long-standing behaviour, exactly. */
    randomDirection?: number
    /** DEV-428 / DEV-429. `additive`, the default, is every 2016 system. */
    look?: ParticleLook
  } = {},
): ParticleField => {
  const paper = look === 'paper'
  // Mutable so a preset flip lands LIVE. DEV-269's rule: a control that appears
  // to work and does not is worse than no control.
  let randomDirectionAmount = Math.min(1, Math.max(0, randomDirection))
  /**
   * DEV-308. `local` on 22 of the 25 shipped systems, and until now on none of
   * them: the sheet carried the value and nothing read it.
   */
  const rides = ridesWithEmitter(spec)
  const emitters: EmitterState[] = []
  const max = Math.max(
    16,
    capacity || Math.min(4096, Math.max(64, spec.initial?.maxParticles ?? 100)),
  )

  const pool: Particle[] = []
  // DEV-417: Unity caps each SYSTEM at `maxParticles`, and a field is one system
  // drawn at many emitters, so the cap is per emitter. The pool's `max` is only
  // the field's allocation. `jumpPad_fx (2)` bursts 300-600 against a cap of
  // 500 and reached 624 before this.
  const perEmitter = spec.initial?.maxParticles ?? Number.POSITIVE_INFINITY
  const rand = makeRandom(spec.randomSeed || hashName(spec.name))

  const geometry = new THREE.InstancedBufferGeometry()
  const quad = new THREE.PlaneGeometry(1, 1)
  geometry.index = quad.index
  geometry.attributes.position = quad.attributes.position as THREE.BufferAttribute
  geometry.attributes.uv = quad.attributes.uv as THREE.BufferAttribute
  quad.dispose()

  const iPosition = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3)
  const iColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4)
  const iParams = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3)
  const iVelocity = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3)
  for (const [name, attr] of [
    ['iPosition', iPosition],
    ['iColor', iColor],
    ['iParams', iParams],
    ['iVelocity', iVelocity],
  ] as const) {
    attr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute(name, attr)
  }
  geometry.instanceCount = 0

  const uniforms = {
    uMap: { value: map },
    uTint: {
      value: new THREE.Vector4(
        TRI_PARTICLE_TINT[0],
        TRI_PARTICLE_TINT[1],
        TRI_PARTICLE_TINT[2],
        TRI_PARTICLE_TINT[3],
      ),
    },
    // Every one of these holds the value the shader used to hard-code, so an
    // un-overridden field renders exactly what it rendered before DEV-079.
    uWidthScale: { value: NO_OVERRIDE.widthScale },
    uGain: { value: ADDITIVE_TINT_GAIN },
    uAlphaScale: { value: NO_OVERRIDE.alphaScale },
    uSoft: { value: 0 },
    uCore: { value: NO_OVERRIDE.coreDarkness },
  }

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    transparent: true,
    // Additive, and NOT writing depth — every 2016 particle material is
    // `Particles/Additive`, which is exactly this.
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  })
  if (paper) {
    // DEV-428 / DEV-429. OPAQUE: the matte is cut in the fragment, so a paper
    // facet writes depth and needs no sorting against its neighbours, and three
    // draws it with blending off. No `_TintColor` and no x2 — those are the
    // additive shader's, and a paper particle's colour is its own.
    material.defines = { PAPER: '' }
    material.transparent = false
    material.blending = THREE.NormalBlending
    material.depthWrite = true
    uniforms.uGain.value = 1
    uniforms.uTint.value.set(1, 1, 1, 1)
  }

  // DEV-351. Mutable, owned by the field, and only ever written by COPYING
  // numbers in (`setDrive`), so a caller's scratch object is never held.
  const drive = { rate: NO_DRIVE.rate, alpha: NO_DRIVE.alpha, speed: NO_DRIVE.speed }

  let live: ParticleOverride = NO_OVERRIDE
  const applyOverride = (next: ParticleOverride): void => {
    // S2's re-authoring is a look for LIGHT — a blend, a gain and a matte. A
    // paper field has none of the three, so it keeps its own.
    if (paper) return
    const wasSoft = live.softEdge
    live = next
    uniforms.uWidthScale.value = next.widthScale
    // The drive's alpha rides on the override's; at `NO_DRIVE` this is `x * 1`,
    // which is `x` to the bit.
    uniforms.uAlphaScale.value = next.alphaScale * drive.alpha
    uniforms.uSoft.value = next.softEdge ? 1 : 0
    uniforms.uCore.value = next.softEdge ? next.coreDarkness : 0
    // OVER rather than ADD, and the x2 of Unity's additive shader goes with it:
    // a doubled colour saturates to white and then a dark core cannot darken.
    uniforms.uGain.value = next.softEdge ? 1 : ADDITIVE_TINT_GAIN
    if (wasSoft === next.softEdge) return
    material.blending = next.softEdge ? THREE.NormalBlending : THREE.AdditiveBlending
    // The fragment writes premultiplied colour either way; this is what makes
    // three pick the matching blend equation for the normal path.
    material.premultipliedAlpha = next.softEdge
    // `premultipliedAlpha` is a program-cache parameter, so the material needs
    // to be re-derived when it moves. Once per preset flip, never per frame.
    material.needsUpdate = true
  }
  if (override) applyOverride(resolveOverride(override))

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = `particles:${spec.name}`
  // The pool holds world-space positions and the mesh sits at the origin, so
  // three's own bounding sphere is meaningless here.
  mesh.frustumCulled = false
  mesh.renderOrder = 10

  const colour = new THREE.Vector4()
  const pos = new THREE.Vector3()
  const dir = new THREE.Vector3()

  const spawn = (emitterIndex: number): void => {
    if (pool.length >= max) return
    const e = emitters[emitterIndex]
    if (!e || e.count >= perEmitter) return
    e.count++
    const r = rand()
    let life = Math.max(0.01, evaluateMinMax(spec.initial?.lifetime, 0, rand()))
    // DEV-351: the drive scales the spawn speed AFTER the draw, so the rand()
    // sequence is the one it always was.
    let speed = evaluateMinMax(spec.initial?.speed, 0, rand()) * drive.speed
    let size = evaluateMinMax(spec.initial?.size, 0, rand())
    sampleShape(spec.shape, rand, pos, dir, randomDirectionAmount)
    // DEV-613: the emitter's scale, after every draw and only where it is set.
    if (e.scale !== 1) {
      const root = Math.sqrt(e.scale)
      life *= root
      speed *= root
      size *= e.scale
      pos.multiplyScalar(e.scale)
    }
    // ── The handedness flip, which was missing for the life of the port ────
    //
    // `sampleShape` works in UNITY's frame and says so: its cones point along
    // +Z, because that is Unity forward. `e.matrix` is THREE-space — `unityPose`
    // has already applied the conjugation `F = diag(1, 1, -1)` to every link of
    // the chain, so `M_three = F . M_unity . F` (`render/unity-space.ts`).
    //
    // The world answer for a Unity-frame local vector `v` is therefore
    //
    //     M_three . (F . v)   =   F . M_unity . v     ✓
    //
    // and these two lines are the `F` on the LOCAL vector. Without them the
    // expression is `M_three . v`, which for `v = (0, 0, 1)` is exactly a
    // reversal along the emitter's axis.
    //
    // WHO THIS HIT: three of the ship's four speed systems — `boost_particles`,
    // `fasterBoost` and `ludacrisSpeed` — are ZERO-ANGLE cones, a straight beam
    // along the emitter's Z, so they fired precisely backwards. Those are S2's
    // speed streaks, the "100 m tube streaming back". Matt, 2026-09-21: *"it
    // seems like maybe some of these particle systems would rather go sideways
    // or downwards than along my path of travel."*
    //
    // WHY IT SURVIVED: it is a no-op on the gate's one-shot bursts, which is the
    // one place anyone would look. Two of the three are `randomDirection: true`
    // and a uniform sphere is flip-invariant; the third is a `circleEdge`, whose
    // direction is `(cos t, sin t, 0)` — z is zero, so the flip changes nothing.
    // The agreement lesson: a rule tested only where two explanations agree has
    // not been tested. DEV-271.
    pos.z = -pos.z
    dir.z = -dir.z
    pos.applyMatrix4(e.matrix)
    dir.transformDirection(e.matrix)
    const particle: Particle = {
      age: 0,
      life,
      px: pos.x,
      py: pos.y,
      pz: pos.z,
      vx: dir.x * speed,
      vy: dir.y * speed,
      vz: dir.z * speed,
      size,
      rot: (evaluateMinMax(spec.initial?.rotationDeg, 0, rand()) * Math.PI) / 180,
      spin: 0,
      r,
      emitter: emitterIndex,
      tinted: false,
      tr: 1,
      tg: 1,
      tb: 1,
    }
    // DEV-428 / DEV-429 — both AFTER every draw the old path makes, and both
    // skipped where unset, so a 2016 system's stream and sums are untouched.
    const inherit = e.inherit
    if (inherit.x !== 0 || inherit.y !== 0 || inherit.z !== 0) {
      particle.vx += inherit.x
      particle.vy += inherit.y
      particle.vz += inherit.z
    }
    if (e.paletteSize > 0) {
      const k = Math.min(e.paletteSize - 1, Math.floor(rand() * e.paletteSize)) * 3
      particle.tinted = true
      particle.tr = e.palette[k] as number
      particle.tg = e.palette[k + 1] as number
      particle.tb = e.palette[k + 2] as number
    }
    pool.push(particle)
  }

  // ── DEV-308: `simulationSpace: local` — the particles RIDE the emitter ─────
  //
  // Unity 5 calls the field `moveWithTransform`, and that IS the semantics: a
  // local-space system keeps its particles in the emitter's frame, so when the
  // emitter moves they all move with it. 22 of the 25 shipped systems say
  // `local`; the port spawned into world space and integrated there, so it
  // implemented `world` for all 25 and the value was documentation (CLAUDE.md's
  // DEV-069 trap, same file family).
  //
  // WHY A DELTA rather than storing local positions. One field is ONE draw call
  // shared by every emitter that uses the spec — 21 gates through one mesh — so
  // there is no single parent matrix a local pool could hang under. Re-applying
  // the emitter's FRAME-TO-FRAME motion is the same answer for a rigid pose:
  //
  //     local storage:  p_w(t+dt) = M(t+dt) . (p_l(t) + v_l.dt)
  //     this pass:      p_w(t+dt) = D . (p_w(t) + v_w(t).dt),  D = M(t+dt).M(t)^-1
  //
  // and substituting p_w(t) = M(t).p_l(t) and v_w(t) = R(t).v_l makes the two
  // identical. The rotation half of D must reach the VELOCITY too, or a banking
  // ship leaves its streaks pointing where it used to be.
  //
  // WHO THIS ACTUALLY HITS, from the sheet: the six live gate systems are all
  // `local`, and a gate NEVER MOVES — `game/particle-fx.ts` writes each gate
  // emitter's matrix once at load and no other line touches it — so `prev`
  // equals `matrix` for ever and the pool is not walked. The wired systems where
  // the delta is not the identity are `boost_particles` (boost stage 1) and
  // `effect_orbCollect`, both bolted to the ship. Stages 2 and 3 are `world` in
  // 2016 and stay left behind, which is an authoring split, not a mistake.
  //
  // A NON-RIGID emitter matrix (one carrying scale) would scale the velocity as
  // well as the position. No shipped chain does — every ancestor of every live
  // system is scale 1 except `ringIdle`'s 1.667, which is on a gate and so never
  // moves — and Unity would scale it too, so the arithmetic is left alone.
  const _carryInverse = new THREE.Matrix4()
  const _carryVec = new THREE.Vector3()

  const carryParticles = (): void => {
    let anyMoved = false
    for (const e of emitters) {
      e.moved = false
      const prev = e.prev
      if (!prev) continue
      if (!e.posed) {
        // The FIRST pose an emitter is given is not motion: there is no earlier
        // frame it could have moved from. Recorded and carried past, so this
        // does not have to rest on the pool happening to be empty.
        prev.copy(e.matrix)
        e.posed = true
        continue
      }
      if (prev.equals(e.matrix)) continue
      const delta = e.delta as THREE.Matrix4
      delta.multiplyMatrices(e.matrix, _carryInverse.copy(prev).invert())
      ;(e.deltaLinear as THREE.Matrix3).setFromMatrix4(delta)
      prev.copy(e.matrix)
      e.moved = true
      anyMoved = true
    }
    if (!anyMoved) return
    for (const p of pool) {
      const e = emitters[p.emitter]
      if (!e?.moved) continue
      _carryVec.set(p.px, p.py, p.pz).applyMatrix4(e.delta as THREE.Matrix4)
      p.px = _carryVec.x
      p.py = _carryVec.y
      p.pz = _carryVec.z
      // `applyMatrix3`, NOT `transformDirection` — the latter NORMALISES, which
      // would quietly set every particle in the game to 1 m/s.
      _carryVec.set(p.vx, p.vy, p.vz).applyMatrix3(e.deltaLinear as THREE.Matrix3)
      p.vx = _carryVec.x
      p.vy = _carryVec.y
      p.vz = _carryVec.z
    }
  }

  const field: ParticleField = {
    object: mesh,
    spec,
    get alive() {
      return pool.length
    },
    get override() {
      return live
    },

    setRandomDirection(amount: number): void {
      randomDirectionAmount = Math.min(1, Math.max(0, amount))
    },
    setOverride(next: Partial<ParticleOverride> | null): void {
      applyOverride(resolveOverride(next))
    },
    get drive() {
      return drive
    },
    setDrive(next: ParticleDrive | null): void {
      const d = next ?? NO_DRIVE
      // A non-finite multiplier falls back to the spec rather than to NaN in a
      // uniform; a negative one is nothing, not a reversed streak.
      const take = (x: number): number => (Number.isFinite(x) ? Math.max(0, x) : 1)
      drive.rate = take(d.rate)
      drive.speed = take(d.speed)
      const alpha = take(d.alpha)
      if (alpha !== drive.alpha) {
        drive.alpha = alpha
        uniforms.uAlphaScale.value = live.alphaScale * alpha
      }
    },

    addEmitter(): ParticleEmitter {
      const state: EmitterState = {
        matrix: new THREE.Matrix4(),
        playing: false,
        time: 0,
        carry: 0,
        fired: false,
        alive: true,
        count: 0,
        // DEV-308: allocated only where the spec asks for it, so a `world` field
        // carries no extra bytes and cannot enter the carry pass at all.
        prev: rides ? new THREE.Matrix4() : null,
        posed: false,
        moved: false,
        delta: rides ? new THREE.Matrix4() : null,
        deltaLinear: rides ? new THREE.Matrix3() : null,
        inherit: new THREE.Vector3(),
        palette: new Float32Array(MAX_PALETTE * 3),
        paletteSize: 0,
        scale: 1,
      }
      emitters.push(state)
      return {
        matrix: state.matrix,
        velocity: state.inherit,
        setPalette(rgb: ArrayLike<number> | null) {
          const n = rgb ? Math.min(MAX_PALETTE, Math.floor(rgb.length / 3)) : 0
          for (let i = 0; i < n * 3; i++) state.palette[i] = (rgb as ArrayLike<number>)[i] as number
          state.paletteSize = n
        },
        get scale() {
          return state.scale
        },
        set scale(k: number) {
          state.scale = Number.isFinite(k) && k > 0 ? k : 1
        },
        get alive() {
          return state.count
        },
        play() {
          if (state.playing) return
          state.playing = true
          state.time = 0
          state.carry = 0
          state.fired = false
        },
        stop() {
          state.playing = false
        },
        get playing() {
          return state.playing
        },
        dispose() {
          state.alive = false
          state.playing = false
        },
      }
    },

    update(dt: number, camera: THREE.Camera): void {
      const step = dt * (spec.simulationSpeed || 1)
      const gravity = spec.initial?.gravityModifier ?? 0

      // ── carry (DEV-308) ─────────────────────────────────────────────
      // BEFORE emission, so a particle spawned this frame — which already uses
      // the emitter's CURRENT matrix — is not moved a second time.
      if (rides) carryParticles()

      // ── emission ────────────────────────────────────────────────────
      if (spec.emission?.enabled) {
        for (let i = 0; i < emitters.length; i++) {
          const e = emitters[i]
          if (!e?.playing || !e.alive) continue
          const before = e.time
          e.time += step

          // The burst table fires once per play, at its own time offset.
          if (!e.fired) {
            for (const burst of spec.emission.bursts) {
              if (before <= burst.time && e.time > burst.time) {
                const n = Math.round(burst.min + (burst.max - burst.min) * rand())
                for (let k = 0; k < n; k++) spawn(i)
              }
            }
            if (
              spec.emission.bursts.length > 0 &&
              e.time > (spec.emission.bursts[spec.emission.bursts.length - 1]?.time ?? 0)
            ) {
              e.fired = true
            }
          }

          // Rate. `carry` keeps the fractional remainder so a rate of 10/s at
          // 90 fps emits 10 per second rather than zero.
          // DEV-351: the drive's rate multiplies AFTER the draw — same rand()
          // order, and `x * 1` at `NO_DRIVE`.
          const rate =
            evaluateMinMax(
              spec.emission.rate,
              spec.lengthSeconds > 0 ? (e.time % spec.lengthSeconds) / spec.lengthSeconds : 0,
              rand(),
            ) * drive.rate
          if (rate > 0) {
            e.carry += rate * step
            const n = Math.floor(e.carry)
            e.carry -= n
            for (let k = 0; k < n; k++) spawn(i)
          }

          // A non-looping system stops emitting at the end of its duration.
          if (!spec.looping && e.time >= spec.lengthSeconds) e.playing = false
        }
      }

      // ── simulate ────────────────────────────────────────────────────
      const damp = spec.clampVelocity?.enabled ? spec.clampVelocity.dampen : 0
      for (let i = pool.length - 1; i >= 0; i--) {
        const p = pool[i] as Particle
        p.age += step
        if (p.age >= p.life) {
          const owner = emitters[p.emitter]
          if (owner) owner.count--
          // Swap-remove: order does not matter for additive blending, and
          // splice on a few thousand particles every frame does.
          const last = pool.pop() as Particle
          if (i < pool.length) pool[i] = last
          continue
        }
        // Unity's gravityModifier is a multiple of the PROJECT's gravity, which
        // in this game is -32, not -9.81.
        if (gravity !== 0) p.vy -= 32 * gravity * step
        if (damp > 0) {
          const k = Math.max(0, 1 - damp * step)
          p.vx *= k
          p.vy *= k
          p.vz *= k
        }
        p.px += p.vx * step
        p.py += p.vy * step
        p.pz += p.vz * step
        if (spec.rotationOverLifetime?.enabled) {
          p.rot +=
            ((evaluateMinMax(spec.rotationOverLifetime.curve, p.age / p.life, p.r) * Math.PI) /
              180) *
            step
        }
      }

      // ── write the instance buffers ──────────────────────────────────
      const n = pool.length
      const posArr = iPosition.array as Float32Array
      const colArr = iColor.array as Float32Array
      const parArr = iParams.array as Float32Array
      const velArr = iVelocity.array as Float32Array
      const stretched = spec.renderer?.mode === 'stretch'
      for (let i = 0; i < n; i++) {
        const p = pool[i] as Particle
        const t = p.age / p.life
        posArr[i * 3] = p.px
        posArr[i * 3 + 1] = p.py
        posArr[i * 3 + 2] = p.pz
        velArr[i * 3] = p.vx
        velArr[i * 3 + 1] = p.vy
        velArr[i * 3 + 2] = p.vz

        evaluateGradient(spec.initial?.colour, 0, p.r, colour)
        if (spec.colourOverLifetime?.enabled) {
          const over = evaluateGradient(spec.colourOverLifetime.gradient, t, p.r, _gradScratch)
          colour.multiply(over)
        }
        if (p.tinted) {
          colour.x *= p.tr
          colour.y *= p.tg
          colour.z *= p.tb
        }
        colArr[i * 4] = colour.x
        colArr[i * 4 + 1] = colour.y
        colArr[i * 4 + 2] = colour.z
        colArr[i * 4 + 3] = colour.w

        const size = spec.sizeOverLifetime?.enabled
          ? p.size * evaluateMinMax(spec.sizeOverLifetime.curve, t, p.r)
          : p.size
        parArr[i * 3] = size
        parArr[i * 3 + 1] = p.rot
        parArr[i * 3 + 2] = stretched
          ? size * (spec.renderer?.lengthScale ?? 1) +
            Math.hypot(p.vx, p.vy, p.vz) * (spec.renderer?.velocityScale ?? 0)
          : 0
      }
      geometry.instanceCount = n
      iPosition.needsUpdate = true
      iColor.needsUpdate = true
      iParams.needsUpdate = true
      iVelocity.needsUpdate = true
      void camera
    },

    dispose(): void {
      geometry.dispose()
      material.dispose()
      pool.length = 0
    },
  }
  return field
}

/** Stable per-name seed, so an unseeded system still renders the same twice. */
const hashName = fnv1a32
