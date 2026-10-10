// tests/unit/particles.test.ts — the particles, and what is actually live.
//
// Two halves. The first is the extraction: 25 particle systems on the shipped
// gate and ship, and the interesting number is how few of them draw anything.
// The second is `MinMaxCurve`, which is the arithmetic a Shuriken port gets
// wrong in a way that produces a plausible system rather than a broken one.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { type Level, liveRings } from '@/content/level-schema'
import { type ExtractedParticle, emitterLocalMatrix } from '@/game/particle-fx'
import { HOVERJET, PROPS } from '@/generated/constants.generated'
import {
  createParticleField,
  evaluateGradient,
  evaluateMinMax,
  type MinMaxCurveLike,
  type MinMaxGradientLike,
  type ParticleSpec,
  ridesWithEmitter,
  SIMULATION_SPACES_HANDLED,
} from '@/render/particles'
import { unityPose } from '@/render/unity-space'
import int01 from '../../content/levels/int_01_hoverJet.json'

interface Row {
  name: string
  active: boolean
  emits: boolean
  playOnAwake: boolean
  looping: boolean
  ancestors: readonly { name: string; active: boolean }[]
  initial: { lifetime: MinMaxCurveLike; speed: MinMaxCurveLike; maxParticles: number } | null
  emission: { enabled: boolean; rate: MinMaxCurveLike; bursts: readonly unknown[] } | null
  renderer: { mode: string } | null
}

const RING = PROPS.checkpointRing.particles as unknown as Row[]
const SHIP = HOVERJET.particles as unknown as Row[]

describe('what is actually live', () => {
  it('finds 25 particle systems and far fewer that draw', () => {
    expect(RING).toHaveLength(8)
    expect(SHIP).toHaveLength(17)
    // The number that matters. `playOnAwake` and the GameObject's own
    // `m_IsActive` both say more systems than this.
    expect(RING.filter((p) => p.emits)).toHaveLength(6)
    // Seven, not six: there are THREE `effect_orbCollect` systems, and the
    // ship script names only one of them.
    expect(SHIP.filter((p) => p.emits)).toHaveLength(7)
  })

  it('has NO afterburner or thruster in the shipped first-person game', () => {
    // All ten hang under `ThirdPerson` or `playbackGhost`, both of which are
    // switched off. Drawing them would be inventing an effect the game did not
    // have — and they are the effects a port reaches for first, because they are
    // the ones with the obvious names.
    const engines = SHIP.filter((p) => /afterburner|thruster/i.test(p.name))
    expect(engines.length).toBe(10)
    for (const p of engines) {
      expect(p.emits, p.name).toBe(false)
      // SOMETHING in the chain is off, and the chain passes through one of the
      // two branches that are off at the root. The nearest dead ancestor is
      // often another nested afterburner rather than the branch root, so
      // asserting on `find()` alone would be asserting the wrong thing.
      expect(
        p.ancestors.some((a) => !a.active),
        `${p.name} has no disabled ancestor`,
      ).toBe(true)
      expect(
        p.ancestors.some((a) => /ThirdPerson|playbackGhost/.test(a.name)),
        `${p.name} is not under ThirdPerson or playbackGhost`,
      ).toBe(true)
    }
  })

  it('has a gate that does not idle — only bursts', () => {
    // `ringIdle` plays, loops, and has a DISABLED EmissionModule. It exists as a
    // transform its children hang off, nothing more. A port that drew it would
    // give every gate a sparkle 2016 never had.
    const idle = RING.find((p) => p.name === 'ringIdle')
    expect(idle).toBeDefined()
    expect(idle?.playOnAwake).toBe(true)
    expect(idle?.looping).toBe(true)
    expect(idle?.emission?.enabled).toBe(false)
    expect(idle?.emits).toBe(false)
  })

  it('splits the gate into four CONTINUOUS sprays and two one-shots', () => {
    const live = RING.filter((p) => p.emits)
    const continuous = live.filter((p) => p.playOnAwake)
    const oneShot = live.filter((p) => !p.playOnAwake)
    expect(continuous).toHaveLength(4)
    expect(oneShot).toHaveLength(2)
    // The continuous ones loop and emit by RATE; the one-shots do not loop and
    // carry a burst table. That is the whole distinction the wiring reads.
    for (const p of continuous) {
      expect(p.looping, p.name).toBe(true)
      expect(p.emission?.rate.scalar, p.name).toBeGreaterThan(0)
    }
    for (const p of oneShot) {
      expect(p.looping, p.name).toBe(false)
      expect(p.emission?.bursts.length, p.name).toBeGreaterThan(0)
    }
  })

  it('stays inside a budget that lets every gate run at once', () => {
    // ~123 particles per gate at steady state, ~2,570 over 21. Asserted because
    // the alternative — distance-culling the gates — would be a deviation, and
    // this is the number that says it is not needed.
    let perGate = 0
    for (const p of RING.filter((x) => x.emits)) {
      const life = p.initial?.lifetime
      const maxLife = life ? life.scalar * (life.mode === 0 ? 1 : life.max) : 0
      perGate += Math.min(p.initial?.maxParticles ?? 0, (p.emission?.rate.scalar ?? 0) * maxLife)
    }
    expect(perGate).toBeLessThan(200)
    expect(perGate * 21).toBeLessThan(4000)
  })

  it('renders every system with the same first-party material', () => {
    // All 25 use `TriParticle.mat`, which is why the port needs one texture and
    // one shader rather than a material system.
    const modes = new Set([...RING, ...SHIP].map((p) => p.renderer?.mode))
    expect([...modes].sort()).toEqual(['billboard', 'stretch'])
  })
})

describe('the ship thresholds', () => {
  const S = HOVERJET.ship as unknown as Record<string, number>

  it('come off the PREFAB, not the C# initialisers', () => {
    // `Ship_HoverShip.cs` initialises `minEffectsSpeed = 5` and
    // `minBoostEffectsSpeed = 32`. The shipped prefab says 25 and 120 — a factor
    // of four on when the boost effect appears. Cardinal rule, again.
    expect(S.minEffectsSpeed).toBe(25)
    expect(S.minBoostEffectsSpeed).toBe(120)
    expect(S.minBoostEffect_stage2_speed).toBe(240)
    expect(S.minBoostEffect_stage3_speed).toBe(350)
  })

  it('are ordered, and the top stage is the top of the envelope', () => {
    expect(S.minEffectsSpeed).toBeLessThan(S.minBoostEffectsSpeed as number)
    expect(S.minBoostEffectsSpeed).toBeLessThan(S.minBoostEffect_stage2_speed as number)
    expect(S.minBoostEffect_stage2_speed).toBeLessThan(S.minBoostEffect_stage3_speed as number)
    // 350 of a 437.5 top speed: the last 20 %.
    expect((S.minBoostEffect_stage3_speed as number) / (S.maxSpeed as number)).toBeCloseTo(0.8, 1)
  })
})

describe('MinMaxCurve', () => {
  // `scalar` is a MULTIPLIER, not the value, and mode 3 is the common one. Read
  // `scalar` as the answer and a 100 m/s spray becomes a 1 m/s dribble.
  const curve = (over: Partial<MinMaxCurveLike>): MinMaxCurveLike => ({
    mode: 0,
    scalar: 1,
    min: 0,
    max: 1,
    minCurve: null,
    maxCurve: null,
    ...over,
  })

  it('mode 0 is the scalar itself', () => {
    expect(evaluateMinMax(curve({ mode: 0, scalar: 3 }), 0.5, 0.5)).toBe(3)
  })

  it('mode 3 is scalar x lerp(min, max, r) — BOTH factors', () => {
    const c = curve({ mode: 3, scalar: 100, min: 0.6, max: 1 })
    expect(evaluateMinMax(c, 0, 0)).toBeCloseTo(60, 9)
    expect(evaluateMinMax(c, 0, 1)).toBeCloseTo(100, 9)
    expect(evaluateMinMax(c, 0, 0.5)).toBeCloseTo(80, 9)
  })

  it('mode 1 multiplies the curve by the scalar', () => {
    const c = curve({
      mode: 1,
      scalar: 4,
      maxCurve: [
        { time: 0, value: 1, inSlope: 0, outSlope: 0 },
        { time: 1, value: 0, inSlope: 0, outSlope: 0 },
      ],
    })
    expect(evaluateMinMax(c, 0, 0)).toBeCloseTo(4, 6)
    expect(evaluateMinMax(c, 1, 0)).toBeCloseTo(0, 6)
  })

  it('reads the REAL gate burst at 100 m/s, not at 1', () => {
    // The concrete case. Every continuous `ringBurst` is mode 3 with scalar 100
    // over [1, 1]: a 100 m/s spray whose scalar and whose constants both have to
    // be read to get there.
    const spray = RING.filter((p) => p.emits && p.playOnAwake)
    expect(spray.length).toBe(4)
    for (const p of spray) {
      const v = evaluateMinMax(p.initial?.speed, 0, 0.5)
      expect(v, p.name).toBeGreaterThan(50)
    }
  })
})

describe('gradients', () => {
  const solid = (r: number, g: number, b: number, a: number): MinMaxGradientLike => ({
    mode: 0,
    max: {
      colours: [
        { time: 0, color: [r, g, b] },
        { time: 1, color: [r, g, b] },
      ],
      alphas: [
        { time: 0, alpha: a },
        { time: 1, alpha: a },
      ],
    },
    min: null,
  })

  it('reads a flat colour at any time', () => {
    const out = new THREE.Vector4()
    evaluateGradient(solid(0.2, 0.4, 0.6, 0.8), 0.37, 0.5, out)
    expect([out.x, out.y, out.z, out.w]).toEqual([0.2, 0.4, 0.6, 0.8])
  })

  it('interpolates alpha over lifetime, which is what makes a particle fade', () => {
    const fade: MinMaxGradientLike = {
      mode: 0,
      max: {
        colours: [{ time: 0, color: [1, 1, 1] }],
        alphas: [
          { time: 0, alpha: 1 },
          { time: 1, alpha: 0 },
        ],
      },
      min: null,
    }
    const out = new THREE.Vector4()
    expect(evaluateGradient(fade, 0, 0, out).w).toBeCloseTo(1, 6)
    expect(evaluateGradient(fade, 0.5, 0, out).w).toBeCloseTo(0.5, 6)
    expect(evaluateGradient(fade, 1, 0, out).w).toBeCloseTo(0, 6)
  })
})

// ── DEV-271: which way a particle actually goes ───────────────────────────
//
// Everything above this line is about the census, the prefab thresholds,
// MinMaxCurve and gradients — fifteen tests, and NOT ONE about direction, which
// is why a handedness bug lived in `spawn()` for the life of the port.
//
// The orientation lesson's rule is to test the GEOMETRY rather than the
// rotation: a quaternion assertion is your belief written twice. So neither
// assertion below states a convention. They compute the answer a SECOND,
// independent way and check the two agree.
//
//   Route A (the engine): `unityPose` flips every link of the chain, then
//     `spawn()` flips the shape's local vector — `M_three . F . v`.
//   Route B (this test): stay in Unity's frame the whole way, applying the raw
//     Unity quaternion to Unity's own +Z, and flip ONCE at the very end.
//
// They agree only if the local flip is present.
describe('which way a particle actually goes (DEV-271)', () => {
  const curve = (scalar: number): MinMaxCurveLike => ({
    mode: 0,
    scalar,
    min: scalar,
    max: scalar,
    minCurve: null,
    maxCurve: null,
  })

  const SPEED = 10

  /**
   * A ZERO-ANGLE cone, which is exactly what `boost_particles`, `fasterBoost`
   * and `ludacrisSpeed` are: a straight beam along the emitter's Z. Chosen
   * deliberately — it turns a handedness mistake into a clean 180 rather than a
   * small error a loose tolerance would swallow.
   */
  const beam: ParticleSpec = {
    name: 'test_beam',
    lengthSeconds: 10,
    looping: true,
    simulationSpace: 'world',
    simulationSpeed: 1,
    randomSeed: 1,
    initial: {
      lifetime: curve(5),
      speed: curve(SPEED),
      size: curve(1),
      rotationDeg: curve(0),
      colour: { mode: 0, max: null, min: null },
      gravityModifier: 0,
      maxParticles: 64,
    },
    emission: { enabled: true, type: 0, rate: curve(100), bursts: [] },
    shape: {
      enabled: true,
      type: 'coneVolumeShell',
      radius: 0,
      angleDeg: 0,
      length: 0,
      box: [1, 1, 1],
      randomDirection: false,
    },
    sizeOverLifetime: null,
    rotationOverLifetime: null,
    colourOverLifetime: null,
    clampVelocity: null,
    renderer: null,
    emits: true,
  }

  // An awkward pose on purpose — yawed, pitched AND rolled — so there is no
  // axis left where a flip would be invisible. A z-aligned emitter agrees with
  // the bug about everything but the sign; an x- or y-aligned one agrees about
  // everything full stop. That is the agreement lesson, applied to the fixture.
  const ROT = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.42, -0.93, 0.31)).normalize()
  const POS: readonly number[] = [12, -3, 40]
  const pose = (): THREE.Matrix4 => unityPose([...POS], [ROT.x, ROT.y, ROT.z, ROT.w], [1, 1, 1])

  /** The velocity the ENGINE gives the first particle, read off the buffer. */
  const spawnVelocity = (): THREE.Vector3 => {
    const field = createParticleField(beam, new THREE.Texture(), { capacity: 64 })
    const emitter = field.addEmitter()
    emitter.matrix.copy(pose())
    emitter.play()
    field.update(0.1, new THREE.PerspectiveCamera())
    expect(field.alive).toBeGreaterThan(0)
    const attr = (field.object as THREE.Mesh).geometry.getAttribute('iVelocity')
    const out = new THREE.Vector3(attr.getX(0), attr.getY(0), attr.getZ(0))
    field.dispose()
    return out
  }

  it('sends a zero-angle cone along the emitter axis, handed over exactly once', () => {
    // Route B, which never touches `unityPose`.
    const inUnity = new THREE.Vector3(0, 0, 1).applyQuaternion(ROT)
    const want = new THREE.Vector3(inUnity.x, inUnity.y, -inUnity.z).multiplyScalar(SPEED)
    const got = spawnVelocity()
    expect(got.x).toBeCloseTo(want.x, 4)
    expect(got.y).toBeCloseTo(want.y, 4)
    expect(got.z).toBeCloseTo(want.z, 4)
  })

  it('DISAGREES with the unflipped answer, so the assertion above can fail', () => {
    // What the code computed before DEV-271: the three-space matrix applied to a
    // Unity-frame vector, with no flip on the local half. A guard that agrees
    // with the bug is not a guard — this is the loud counterpart.
    const unflipped = new THREE.Vector3(0, 0, 1).transformDirection(pose()).multiplyScalar(SPEED)
    expect(spawnVelocity().angleTo(unflipped)).toBeGreaterThan(0.5)
  })
})

// ── DEV-272: the gate burst keeps its cone ────────────────────────────────
//
// The gate's cone emitters carry `randomDirection`, which the port read as
// "throw the cone away". The assertions are about SOLID ANGLE, not about a
// vector: how tightly the spray clusters around the emitter's axis is true
// whatever anyone believes about frames, and it is the quantity the complaint
// was actually about.
//
// ── CORRECTED 2026-09-23 (DEV-308's census): the fixture below is a system
//    that DOES NOT DRAW ──
//
// The 7.78° `coneShell` these numbers came from is `ringBurst`, and it is
// `active: false, emits: false` — it draws nothing, and neither does
// `ringIdle`. The wishlist section this work came from, and
// `anniversary.json`'s note, both build the solid-angle argument on it.
//
// **The argument survives and gets stronger** — two of the LIVE cone systems
// are authored at ZERO degrees, and a 0° cone against a whole sphere is a worse
// ratio than 7.78° — so the fixture is left standing as an engine test of the
// blend arithmetic, with its provenance now stated. What was missing is a claim
// about the SHIPPED geometry, and `§1b` below is it: the same question asked of
// the live six rather than of a spec nobody flies. Without it this block was a
// generated constant nobody reads, in test form.
describe('the gate burst keeps its cone (DEV-272)', () => {
  const curve = (scalar: number): MinMaxCurveLike => ({
    mode: 0,
    scalar,
    min: scalar,
    max: scalar,
    minCurve: null,
    maxCurve: null,
  })

  /** A 7.78° cone shell — `ringBurst`'s numbers, and `ringBurst` is NOT live. */
  const RING_ANGLE_DEG = 7.78

  const burst: ParticleSpec = {
    name: 'test_ringBurst',
    lengthSeconds: 10,
    looping: true,
    simulationSpace: 'world',
    simulationSpeed: 1,
    randomSeed: 7,
    initial: {
      lifetime: curve(5),
      speed: curve(10),
      size: curve(1),
      rotationDeg: curve(0),
      colour: { mode: 0, max: null, min: null },
      gravityModifier: 0,
      maxParticles: 400,
    },
    emission: { enabled: true, type: 0, rate: curve(2000), bursts: [] },
    shape: {
      enabled: true,
      type: 'coneShell',
      radius: 6.823587,
      angleDeg: RING_ANGLE_DEG,
      length: 5,
      box: [1, 1, 1],
      randomDirection: true,
    },
    sizeOverLifetime: null,
    rotationOverLifetime: null,
    colourOverLifetime: null,
    clampVelocity: null,
    renderer: null,
    emits: true,
  }

  /**
   * The fraction of the spray landing within 30 degrees of the emitter's axis.
   * The emitter is left at the identity, so the axis is three's -Z: the cone is
   * Unity +Z and DEV-271's flip is what puts it there. Using the ENGINE's own
   * convention here is deliberate and safe, because the claim is a RATIO
   * between two runs of the same code, not a direction.
   */
  const forwardFraction = (randomDirection: number): number => {
    const field = createParticleField(burst, new THREE.Texture(), {
      capacity: 400,
      randomDirection,
    })
    field.addEmitter().play()
    field.update(0.1, new THREE.PerspectiveCamera())
    const attr = (field.object as THREE.Mesh).geometry.getAttribute('iVelocity')
    const axis = new THREE.Vector3(0, 0, -1)
    const v = new THREE.Vector3()
    let near = 0
    const n = field.alive
    expect(n).toBeGreaterThan(50)
    for (let i = 0; i < n; i++) {
      v.set(attr.getX(i), attr.getY(i), attr.getZ(i)).normalize()
      if (v.angleTo(axis) < Math.PI / 6) near += 1
    }
    field.dispose()
    return near / n
  }

  it('sprays over the WHOLE SPHERE at 1, which is what the port has always done', () => {
    // A 30 degree cap is (1 - cos 30) / 2 = 6.7 % of a sphere. Anything near
    // that is a uniform sphere, and a uniform sphere is the bug Matt could not
    // see. This pins the Classic answer so a change to it has to be deliberate.
    const f = forwardFraction(1)
    expect(f).toBeGreaterThan(0.01)
    expect(f).toBeLessThan(0.2)
  })

  it('puts most of the spray in front of you at the Anniversary value', () => {
    // 0.25 is `anniversary.json`'s first guess. The assertion is the ORDER OF
    // MAGNITUDE, not the number: the point is that the burst is aimed.
    expect(forwardFraction(0.25)).toBeGreaterThan(0.9)
  })

  it('is the authored cone exactly at 0', () => {
    // 7.78 degrees is well inside the 30 degree cap, so every particle counts.
    expect(forwardFraction(0)).toBe(1)
  })

  it('is monotone, so the flag is a dial and not a switch', () => {
    const tight = forwardFraction(0.25)
    const loose = forwardFraction(0.75)
    expect(tight).toBeGreaterThan(loose)
    expect(loose).toBeGreaterThan(forwardFraction(1))
  })
})

// ── §1b DEV-272, asked of the SHIPPED gate ────────────────────────────────
//
// Everything above runs a hand-built spec. This runs the six the game draws,
// straight off the sheet, so the claim is about the gate a player flies through
// rather than about the engine's arithmetic. It is the same correction DEV-308
// made to `simulationSpace`: a number the port holds and never consults is
// documentation, and so is a fixture nobody ships.
describe('§1b the SHIPPED gate, not a fixture (DEV-272 / DEV-308)', () => {
  const GATE = (PROPS.checkpointRing.particles as unknown as ExtractedParticle[]).filter(
    (p) => p.active && p.emits,
  )

  it('is six, and NOT the 7.78 degree shell the argument was built on', () => {
    // The census, pinned where the reasoning can see it. `ringBurst` and
    // `ringIdle` are both dead; anything that cites either as a live emitter is
    // citing a system that draws nothing.
    expect(GATE).toHaveLength(6)
    const dead = (PROPS.checkpointRing.particles as unknown as ExtractedParticle[]).filter(
      (p) => !(p.active && p.emits),
    )
    expect(dead.map((p) => p.name).sort()).toEqual(['ringBurst', 'ringIdle'])
    expect(GATE.some((p) => p.shape?.angleDeg === 7.78)).toBe(false)
  })

  it('is FOUR continuous sprays and two one-shots, and the sprays carry the flag', () => {
    // The part that changes what to look at. DEV-272 was written about the
    // fly-through flash; four of the six it actually moves are the gate's
    // PERMANENT spray, which is what makes a course readable from a distance —
    // and a permanent spray is a great deal easier to judge from the cockpit
    // than a quarter-second flash you are already leaving.
    const continuous = GATE.filter((p) => p.playOnAwake)
    const oneShot = GATE.filter((p) => !p.playOnAwake)
    expect(continuous).toHaveLength(4)
    expect(oneShot).toHaveLength(2)
    for (const p of continuous) expect(p.shape?.randomDirection, p.name).toBe(true)
    // Two of the four are ZERO-degree cones, which is the strongest form of the
    // solid-angle argument available: a beam, replaced by a whole sphere.
    expect(continuous.filter((p) => p.shape?.angleDeg === 0)).toHaveLength(2)
  })

  it('tightens every live cone that carries the flag, and leaves the radial one', () => {
    // The behavioural half, on the real specs. `tightness` is the length of the
    // mean unit velocity: 1 is a beam, 0 is a uniform sphere.
    const identity = new THREE.Matrix4()
    for (const spec of GATE) {
      const flagged = spec.shape?.randomDirection === true
      const classic = spray(spec, identity, 1).tightness
      const anniversary = spray(spec, identity, 0.25).tightness
      if (flagged) {
        expect(anniversary, `${spec.name} at 0.25`).toBeGreaterThan(classic)
        expect(anniversary, `${spec.name} at 0.25`).toBeGreaterThan(0.9)
      } else {
        // `ringBurst (2)`, the circleEdge: radial in the plane of the ring BY
        // DESIGN, and the flag must not touch it at any value. Part of what
        // reads as sideways is 2016 and it stays.
        expect(anniversary, `${spec.name} is not on the flag`).toBeCloseTo(classic, 12)
      }
    }
  })
})

// ── DEV-309: the particle layer gets a DIRECTION guard ────────────────────
//
// Three direction bugs sat under this suite while every test above it stayed
// green, because every test above it is about a census, a threshold, a curve or
// a gradient. Nothing asked which way a particle goes.
//
// The three blocks below do, and each one measures against something OUTSIDE
// the port so that it cannot agree with the thing it is checking:
//
//   §1 the COURSE. A gate's spray is compared with the direction of travel
//      through that gate — a central difference over the ring positions, taken
//      straight out of the level JSON. No quaternion convention appears in it.
//   §2 the EMITTER'S OWN POSITION, and then the renderer's stated frame. The
//      speed tube is authored 100 m ahead of the ship and fires back at it, so
//      "does the spray come toward the ship or go away from it" is a relation
//      between two things the chain computes by different arithmetic.
//   §3 the SHEET. Every live system is driven through the engine and asked
//      whether it behaves the way its own `simulationSpace` says it should.
//
// All three are relationships rather than values, which is the orientation
// lesson: a distance, a ratio or a sign is true independently of what anyone
// believed; a quaternion assertion is the belief written twice.

/** The gate and ship rows as engine specs — `particle-fx.ts`'s `isLive`, exactly. */
const LIVE_SPECS: readonly ExtractedParticle[] = [
  ...(PROPS.checkpointRing.particles as unknown as ExtractedParticle[]),
  ...(HOVERJET.particles as unknown as ExtractedParticle[]),
].filter((p) => p.active && p.emits)

/**
 * Run a real spec at a real pose and return the MEAN UNIT velocity of the live
 * particles, plus how many there were.
 *
 * The mean of unit vectors is the useful quantity twice over: its DIRECTION is
 * where the spray points, and its LENGTH is how tightly it is bundled — 1 is a
 * beam and 0 is a uniform sphere. Both are needed, because a direction read off
 * a spray that has no direction is noise, and at Classic's `randomDirection: 1`
 * that is exactly what it is (see the loud counterpart in §1).
 */
const spray = (
  spec: ParticleSpec,
  matrix: THREE.Matrix4,
  randomDirection = 1,
): { readonly mean: THREE.Vector3; readonly tightness: number; readonly n: number } => {
  const field = createParticleField(spec, new THREE.Texture(), {
    capacity: 3000,
    randomDirection,
  })
  const e = field.addEmitter()
  e.matrix.copy(matrix)
  e.play()
  const camera = new THREE.PerspectiveCamera()
  // Run until the pool has FILLED, not until it is non-empty. A mean direction
  // needs a spray: one particle is a draw, and at the Anniversary blend a
  // single draw off a gate whose axis is 60 degrees from the course tangent
  // lands either side of it. The callers assert `n` as well, so a degenerate
  // sample cannot quietly satisfy a claim about a mean.
  for (let k = 0; k < 60 && field.alive < 300; k++) field.update(0.02, camera)
  const attr = (field.object as THREE.Mesh).geometry.getAttribute('iVelocity')
  const n = field.alive
  const mean = new THREE.Vector3()
  const v = new THREE.Vector3()
  for (let i = 0; i < n; i++) mean.add(v.set(attr.getX(i), attr.getY(i), attr.getZ(i)).normalize())
  if (n > 0) mean.divideScalar(n)
  field.dispose()
  return { mean, tightness: mean.length(), n }
}

describe('§1 a gate sprays ALONG the course, not across it (DEV-309)', () => {
  // The reference is the route, not the gate's quaternion: the course's own
  // tangent at this gate, out of the level the game ships. That is the
  // "direction of travel" Matt's complaint was about, and it is a difference of
  // two positions — nothing in it can agree with a handedness mistake.
  // `routeDirection` below says why it is a CENTRAL difference and not a chord.
  const rings = liveRings(int01 as unknown as Level)
  const GATE_SPECS = (PROPS.checkpointRing.particles as unknown as ExtractedParticle[]).filter(
    (p) => p.active && p.emits,
  )
  const CONES = GATE_SPECS.filter((p) => (p.shape?.type ?? '').startsWith('cone'))

  /** Gate `i`'s world matrix, composed the way `loadParticleFx` composes it. */
  const gateMatrix = (i: number): THREE.Matrix4 => {
    const r = rings[i] as (typeof rings)[number]
    return new THREE.Matrix4().compose(
      new THREE.Vector3(...(r.pos as number[])),
      new THREE.Quaternion(...(r.quat as number[])),
      new THREE.Vector3(...(r.scale as number[])),
    )
  }

  /**
   * Unit direction of travel THROUGH gate `i`, from the course itself.
   *
   * A CENTRAL difference — gate i+1 minus gate i−1 — because the chord to the
   * next gate alone is not the tangent, and on this course that is worth up to
   * 70 degrees. Gate 18 of `int_01` is the case: the chord out of it turns hard,
   * so `ringBurst (3)` reads 0.16 against the chord and 0.83 against the
   * tangent, and the gate is authored on the tangent. Measured, not assumed —
   * the same sweep prints both columns for all 21 gates.
   */
  const routeDirection = (i: number): THREE.Vector3 => {
    const a = rings[Math.max(0, i - 1)] as (typeof rings)[number]
    const b = rings[Math.min(rings.length - 1, i + 1)] as (typeof rings)[number]
    return new THREE.Vector3(...(b.pos as number[]))
      .sub(new THREE.Vector3(...(a.pos as number[])))
      .normalize()
  }

  it('has five live CONE emitters and one that is radial by design', () => {
    // The split matters for everything below: the `circleEdge` one sprays
    // outward in the PLANE of the ring, so it is excluded from the forward
    // claim rather than exempted from it quietly. Part of what reads as
    // sideways is 2016 and it stays.
    expect(GATE_SPECS).toHaveLength(6)
    expect(CONES).toHaveLength(5)
    const radial = GATE_SPECS.filter((p) => p.shape?.type === 'circleEdge')
    expect(radial).toHaveLength(1)
    expect(radial[0]?.shape?.randomDirection).toBe(false)
  })

  it('points every cone down the course at EVERY gate, at the authored angle', () => {
    // 21 gates x 5 systems. `randomDirection: 0` is the authored cone exactly —
    // the sampler's own shape with nothing blended in — so this is a statement
    // about what 2016 authored and where the port puts it.
    expect(rings.length).toBeGreaterThan(10)
    const bad: string[] = []
    let worst = 1
    for (const spec of CONES) {
      for (let i = 0; i < rings.length; i++) {
        const world = new THREE.Matrix4().multiplyMatrices(gateMatrix(i), emitterLocalMatrix(spec))
        const { mean, tightness, n } = spray(spec, world, 0)
        // Enough of a spray to have a mean at all. The smallest live gate
        // system saturates in single figures, so this is low on purpose — it is
        // a floor against measuring one draw, not a population claim.
        expect(n, `${spec.name} @ gate ${i}`).toBeGreaterThanOrEqual(5)
        // Tight first: a direction read off an untightened spray means nothing.
        expect(tightness, `${spec.name} @ gate ${i} tightness`).toBeGreaterThan(0.9)
        const dot = mean.normalize().dot(routeDirection(i))
        worst = Math.min(worst, dot)
        if (!(dot > 0)) bad.push(`${spec.name} @ gate ${i}: ${dot.toFixed(3)}`)
      }
    }
    expect(bad, 'gates whose spray runs against the course').toEqual([])
    // Not a pinned sample — a margin. The sign is the claim; this says the
    // 105 measurements are not sitting on the boundary of it. The worst of them
    // is `ringBurst (3)`, whose cone really is ~58 degrees off the tangent at
    // one gate; that is authoring, and it is a long way from the wrong side.
    expect(worst).toBeGreaterThan(0.2)
  })

  it('still points down the course at the Anniversary blend', () => {
    // 0.25 is what `anniversary.json` ships. The claim has to survive the
    // number the player actually flies, or it is a claim about a lab setting.
    for (const spec of CONES) {
      for (let i = 0; i < rings.length; i++) {
        const world = new THREE.Matrix4().multiplyMatrices(gateMatrix(i), emitterLocalMatrix(spec))
        const { mean, tightness } = spray(spec, world, 0.25)
        expect(tightness, `${spec.name} @ gate ${i}`).toBeGreaterThan(0.9)
        expect(mean.normalize().dot(routeDirection(i)), `${spec.name} @ gate ${i}`).toBeGreaterThan(
          0,
        )
      }
    }
  })

  it('does NOT point anywhere at Classic, which is the whole of DEV-272', () => {
    // The loud counterpart, and it is also the finding. At `randomDirection: 1`
    // the sampler throws the cone away, so the best-sampled system on the gate
    // has a mean of near zero LENGTH: there is no direction to be right or
    // wrong about. Anybody reading the two tests above as "the shipped gate is
    // aimed" has to get past this one first.
    const best = CONES.reduce((a, b) =>
      (a.initial?.maxParticles ?? 0) > (b.initial?.maxParticles ?? 0) ? a : b,
    )
    const world = new THREE.Matrix4().multiplyMatrices(gateMatrix(0), emitterLocalMatrix(best))
    const classic = spray(best, world, 1)
    expect(classic.n).toBeGreaterThan(100)
    expect(classic.tightness).toBeLessThan(0.2)
    // And the same emitter, same gate, same code, with the cone honoured.
    expect(spray(best, world, 0).tightness).toBeGreaterThan(0.9)
  })
})

describe('§2 the ship fires its speed tubes BACK at the cockpit (DEV-309)', () => {
  /** `boost_particles`, `fasterBoost`, `ludacrisSpeed` — the zero-angle cones. */
  const TUBES = (HOVERJET.particles as unknown as ExtractedParticle[]).filter(
    (p) => p.active && p.emits && p.shape?.angleDeg === 0,
  )

  // Awkward on purpose, and several of them: a ship pointing down an axis
  // agrees with a mirror about most things. Rigid, because a ship is.
  const POSES: readonly THREE.Matrix4[] = [
    new THREE.Matrix4(),
    new THREE.Matrix4().compose(
      new THREE.Vector3(120, -40, 380),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.42, -0.93, 0.31)),
      new THREE.Vector3(1, 1, 1),
    ),
    new THREE.Matrix4().compose(
      new THREE.Vector3(-300, 200, -50),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-1.1, 2.4, -0.7)),
      new THREE.Vector3(1, 1, 1),
    ),
    new THREE.Matrix4().compose(
      new THREE.Vector3(7, 7, 7),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(1.57, 0, 0)),
      new THREE.Vector3(1, 1, 1),
    ),
  ]

  it('is three systems, and all three are a straight beam', () => {
    // Zero-angle is what makes this test sharp: a handedness mistake becomes a
    // clean 180 rather than a small error a loose tolerance would swallow.
    expect(TUBES.map((p) => p.name).sort()).toEqual([
      'boost_particles',
      'fasterBoost',
      'ludacrisSpeed',
    ])
    for (const p of TUBES) expect(p.shape?.randomDirection, p.name).toBe(false)
  })

  it('spawns the tube AHEAD of the ship and sends it back toward the ship', () => {
    // The primary claim, and it names no convention at all: the spray's
    // direction versus the direction from the emitter to the ship. Those two
    // come out of different arithmetic — the emitter's offset is the pose chain
    // composed by `unityPose`, the spray is that chain applied to a shape-local
    // vector that is handed over once more on the way (DEV-271) — so the
    // missing flip separates them and this goes to -1.
    for (const spec of TUBES) {
      for (const [i, ship] of POSES.entries()) {
        const world = new THREE.Matrix4().multiplyMatrices(ship, emitterLocalMatrix(spec))
        const emitterAt = new THREE.Vector3().setFromMatrixPosition(world)
        const shipAt = new THREE.Vector3().setFromMatrixPosition(ship)
        const toShip = shipAt.clone().sub(emitterAt)
        // 2016 authors the tube 100 m out. If that ever stops being true the
        // rest of this test is measuring a 0 m baseline, so it is asserted.
        expect(toShip.length(), `${spec.name} @ pose ${i}`).toBeGreaterThan(50)
        const { mean, tightness } = spray(spec, world)
        expect(tightness, `${spec.name} @ pose ${i}`).toBeGreaterThan(0.95)
        expect(
          mean.normalize().dot(toShip.normalize()),
          `${spec.name} @ pose ${i}`,
        ).toBeGreaterThan(0.9)
      }
    }
  })

  it('and the tube is ahead in the FRAME the renderer says is forward', () => {
    // The blind spot of the test above, closed. "Comes back at the ship" is a
    // relation, so a chain that mirrored the emitter AND the spray together
    // would satisfy it — the 224/224 front-facing trap, in this layer. This
    // half is absolute, and the thing it is absolute against is
    // `render/unity-space.ts`'s stated convention (three space, -Z forward),
    // which is the project's definition rather than this file's opinion.
    const forward = new THREE.Vector3(0, 0, -1)
    for (const spec of TUBES) {
      for (const [i, ship] of POSES.entries()) {
        const world = new THREE.Matrix4().multiplyMatrices(ship, emitterLocalMatrix(spec))
        const ahead = new THREE.Vector3()
          .setFromMatrixPosition(world)
          .sub(new THREE.Vector3().setFromMatrixPosition(ship))
          .normalize()
        const shipForward = forward.clone().transformDirection(ship)
        expect(ahead.dot(shipForward), `${spec.name} @ pose ${i}`).toBeGreaterThan(0.9)
      }
    }
  })

  it('therefore streams BACKWARD in the ship frame, which is what §2 asked', () => {
    // The two halves above, multiplied out: the form the wishlist named.
    const forward = new THREE.Vector3(0, 0, -1)
    for (const spec of TUBES) {
      for (const [i, ship] of POSES.entries()) {
        const world = new THREE.Matrix4().multiplyMatrices(ship, emitterLocalMatrix(spec))
        const { mean } = spray(spec, world)
        const shipForward = forward.clone().transformDirection(ship)
        expect(mean.normalize().dot(shipForward), `${spec.name} @ pose ${i}`).toBeLessThan(-0.9)
      }
    }
  })
})

describe('§3 every live system’s simulationSpace has a reader (DEV-308)', () => {
  // The structural guard, in the manner of `xr-eye-layers.test.ts`: it sweeps
  // the sheet rather than pinning today's list, so the day a new system arrives
  // it is covered without anybody remembering to cover it.
  //
  // It is BEHAVIOURAL and not textual on purpose. A `toContain('simulationSpace')`
  // over `src/` is satisfied by the field's own type declaration — which is
  // precisely the state this guard exists to forbid, so it would have been green
  // for the entire life of the bug.

  /** Two poses that share no axis, so "rode with the emitter" cannot be luck. */
  const POSE_A = new THREE.Matrix4().compose(
    new THREE.Vector3(137, -42, 311),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.31, 1.17, -0.52)),
    new THREE.Vector3(1, 1, 1),
  )
  const POSE_B = new THREE.Matrix4().compose(
    new THREE.Vector3(-90, 15, 220),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.84, 0.22, 2.01)),
    new THREE.Vector3(1, 1, 1),
  )

  /**
   * What the SHEET says, which is what Unity said: `moveWithTransform: 1`, and
   * the field's own name is the semantics.
   *
   * Deliberately not `ridesWithEmitter`. A guard that asks the port's own
   * predicate what to expect is a test comparing two of the port's devices —
   * flip the predicate and the engine and the expectation move together, and
   * every assertion below stays green while the game does the opposite. That
   * failure has happened here twice (DEV-069, DEV-071). One test, and one only,
   * holds the predicate to this, and somebody has to edit it on purpose.
   */
  const sheetSaysLocal = (spec: ExtractedParticle): boolean => spec.simulationSpace === 'local'

  /** Read every live particle's position and velocity out of the draw buffers. */
  const readBuffers = (field: {
    object: THREE.Object3D
    alive: number
  }): { p: THREE.Vector3[]; v: THREE.Vector3[] } => {
    const g = (field.object as THREE.Mesh).geometry
    const pa = g.getAttribute('iPosition')
    const va = g.getAttribute('iVelocity')
    const p: THREE.Vector3[] = []
    const v: THREE.Vector3[] = []
    for (let i = 0; i < field.alive; i++) {
      p.push(new THREE.Vector3(pa.getX(i), pa.getY(i), pa.getZ(i)))
      v.push(new THREE.Vector3(va.getX(i), va.getY(i), va.getZ(i)))
    }
    return { p, v }
  }

  it('is 13 live systems, 10 of them local, and the sheet is not all one value', () => {
    // A guard over a column that is constant proves nothing, so the split is
    // asserted before anything is built on it.
    expect(LIVE_SPECS).toHaveLength(13)
    expect(LIVE_SPECS.filter(sheetSaysLocal)).toHaveLength(10)
    expect(LIVE_SPECS.filter((p) => !sheetSaysLocal(p))).toHaveLength(3)
    // 2016 split the three boost stages: stage 1 rides, stages 2 and 3 do not.
    // That is an authoring choice and reading it wrong in either direction is a
    // deviation, so both sides are named.
    const by = (n: string) => LIVE_SPECS.find((p) => p.name === n)
    expect(by('boost_particles')?.simulationSpace).toBe('local')
    expect(by('fasterBoost')?.simulationSpace).toBe('world')
    expect(by('ludacrisSpeed')?.simulationSpace).toBe('world')
    expect(by('flight_particles')?.simulationSpace).toBe('world')
  })

  it('reads the sheet the way Unity wrote it, in ONE place', () => {
    // The single pin between the sheet's string and the engine's predicate.
    // Everything below asks the sheet; this asks whether the engine agrees with
    // it, so flipping `ridesWithEmitter` goes red HERE and stays red in the
    // behavioural tests rather than silently taking them with it.
    for (const spec of LIVE_SPECS) {
      expect(ridesWithEmitter(spec), spec.name).toBe(sheetSaysLocal(spec))
    }
  })

  it('carries no live value the engine has no answer for', () => {
    // Unity has a third, `custom`, which needs a transform reference the sheet
    // does not carry. No shipped system uses it. If one ever does, this is the
    // line that says so instead of it silently behaving like `world`.
    for (const spec of LIVE_SPECS) {
      expect(SIMULATION_SPACES_HANDLED as readonly string[], spec.name).toContain(
        spec.simulationSpace,
      )
    }
  })

  it('moves a local system with its emitter and leaves a world one behind', () => {
    // The claim is stated the way Unity states it, and with no reference to how
    // the engine computes it: a LOCAL particle's position in the EMITTER'S
    // FRAME does not change when the emitter moves. `M^-1 . p` before equals
    // `M^-1 . p` after. A WORLD particle's WORLD position does not change.
    //
    // The step is `update(0)`: zero seconds emits nothing (the rate term is
    // `rate * step`, and `carry` is always left below 1), ages nothing and
    // integrates nothing, so the only thing in the engine that can move a
    // particle on that call is the one under test.
    const camera = new THREE.PerspectiveCamera()
    const invA = POSE_A.clone().invert()
    const invB = POSE_B.clone().invert()
    for (const spec of LIVE_SPECS) {
      const field = createParticleField(spec, new THREE.Texture(), { capacity: 500 })
      const e = field.addEmitter()
      e.matrix.copy(POSE_A)
      e.play()
      for (let k = 0; k < 200 && field.alive === 0; k++) field.update(0.02, camera)
      expect(field.alive, `${spec.name} produced nothing to measure`).toBeGreaterThan(0)
      const before = readBuffers(field)

      e.matrix.copy(POSE_B)
      field.update(0, camera)
      const after = readBuffers(field)
      expect(after.p, spec.name).toHaveLength(before.p.length)

      const rides = sheetSaysLocal(spec)
      for (let i = 0; i < before.p.length; i++) {
        const was = rides
          ? (before.p[i] as THREE.Vector3).clone().applyMatrix4(invA)
          : (before.p[i] as THREE.Vector3)
        const now = rides
          ? (after.p[i] as THREE.Vector3).clone().applyMatrix4(invB)
          : (after.p[i] as THREE.Vector3)
        expect(now.distanceTo(was), `${spec.name} [${i}] position`).toBeLessThan(0.02)
        const vWas = rides
          ? (before.v[i] as THREE.Vector3).clone().transformDirection(invA)
          : (before.v[i] as THREE.Vector3).clone().normalize()
        const vNow = rides
          ? (after.v[i] as THREE.Vector3).clone().transformDirection(invB)
          : (after.v[i] as THREE.Vector3).clone().normalize()
        expect(vNow.distanceTo(vWas), `${spec.name} [${i}] velocity`).toBeLessThan(0.002)
        // A ride must not change a particle's SPEED, only its heading. The
        // delta's linear part reaches the velocity, and `transformDirection`
        // would have normalised every one of them to 1 m/s.
        expect((after.v[i] as THREE.Vector3).length(), `${spec.name} [${i}] speed`).toBeCloseTo(
          (before.v[i] as THREE.Vector3).length(),
          2,
        )
      }
      field.dispose()
    }
  })

  it('separates the two values — a world system is provably NOT carried', () => {
    // The loud counterpart of the test above. If the engine carried everything,
    // or carried nothing, the pair of assertions up there would still pass for
    // one of the two groups and the file would look fine. This asserts that the
    // groups actually DISAGREE, on the same emitter motion.
    const camera = new THREE.PerspectiveCamera()
    const moved = (spec: ParticleSpec): number => {
      const field = createParticleField(spec, new THREE.Texture(), { capacity: 500 })
      const e = field.addEmitter()
      e.matrix.copy(POSE_A)
      e.play()
      for (let k = 0; k < 200 && field.alive === 0; k++) field.update(0.02, camera)
      const before = readBuffers(field)
      e.matrix.copy(POSE_B)
      field.update(0, camera)
      const after = readBuffers(field)
      let worst = 0
      for (let i = 0; i < before.p.length; i++) {
        worst = Math.max(
          worst,
          (after.p[i] as THREE.Vector3).distanceTo(before.p[i] as THREE.Vector3),
        )
      }
      field.dispose()
      return worst
    }
    // The two poses are ~440 m apart, so "rode with it" is hundreds of metres
    // of world movement and "left behind" is zero. Nothing in between.
    for (const spec of LIVE_SPECS.filter(sheetSaysLocal)) {
      expect(moved(spec), `${spec.name} should have ridden`).toBeGreaterThan(100)
    }
    for (const spec of LIVE_SPECS.filter((p) => !sheetSaysLocal(p))) {
      expect(moved(spec), `${spec.name} should have stayed`).toBe(0)
    }
  })
})
