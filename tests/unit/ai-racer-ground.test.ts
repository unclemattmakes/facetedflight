// tests/unit/ai-racer-ground.test.ts — the AI racers meet the ground too.
//
// `stepHoverJet` has no terrain contact of its own. The player got one four
// lines at a time in `game/flight.ts`; an AI racer got none, which is why
// DEV-032's symptom was **the sea floor** rather than a hillside — with nothing
// to hit, a racer that lost its way simply kept going down past y = 0.
//
// The autopilot's clearance term is a different job. It *avoids* terrain, and it
// avoids it by looking along the velocity: knock the ship off that path, or put
// it somewhere the lookahead does not reach, and there was nothing underneath.
// Avoidance and contact are two jobs and only one of them existed.
//
// ── What these tests are careful about ────────────────────────────────────
//
// Every ground assertion here is DIFFERENTIAL — the same racer flown twice, once
// with a field and once without — because "it ended up at y = 51" is true of a
// racer that stopped on the ground and of a racer that never went anywhere. The
// pair says which.
//
// And every one of them has a TWO-OBJECT variant (trap 19). The ground state
// carries `flashFor` and `depth` across ticks, so a shared one would let the
// racer that clipped a ridge hand its turn penalty to a racer three kilometres
// away. With one racer there is nobody to inherit from, so a single-object test
// cannot see it — which is exactly how the last one of these shipped.

import { describe, expect, it } from 'vitest'
import { HOVERJET } from '@/generated/constants.generated'
import { AI_RACER_TUNINGS, type AiRacerSpec, createAiRacer, stepAiRacer } from '@/sim/ai-racer'
import { FIXED_DT } from '@/sim/constants'
import type { Gate } from '@/sim/course'
import { v3 } from '@/sim/math/vec3'
import { createRigidBody } from '@/sim/rigidbody'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import { buildHeightField, terrainHeightAt } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import {
  createGroundContact,
  HOVERJET_GROUND,
  hullFromColliders,
  stepGroundContact,
} from '@/sim/terrain-collision'

// A synthetic field rather than the shipped PNG, for the reason
// `terrain-collision.test.ts` gives: the maps are gitignored for licence
// reasons, and a unit test that needs `pnpm assets:pull` fails in CI.
const flatMap = (grey: number): MapSampler =>
  ({
    width: 256,
    height: 256,
    sample(_u: number, _v: number, out: Rgb): Rgb {
      out.r = grey
      out.g = grey
      out.b = grey
      return out
    },
  }) as unknown as MapSampler

const PARAMS = {
  terrainSize: 1024,
  terrainHeight: 100,
  baseResolution: 8,
  chunkSize: 256,
  randomOffset: 0,
  seed: 1,
} as unknown as FacetedTerrainParams

/** 8 km square of dead-flat ground at y = 50, centred on the origin. */
const FLAT = buildHeightField(flatMap(0.5), PARAMS, {
  position: [-4096, 0, -4096],
  scale: [8, 1, 8],
})
const GROUND_Y = 50

/** One gate, 200 m UNDERGROUND. The autopilot will fly at it; the ground won't let it. */
const buriedGate: Gate[] = [
  { centre: v3(0, -200, 800), radius: 22.6, points: 100, triggerOnce: true },
]
/** One gate high and far, for a racer that must stay in clear air. */
const skyGate: Gate[] = [
  { centre: v3(1500, 1200, 3000), radius: 22.6, points: 100, triggerOnce: true },
]

const spec = (id: string, spawn = v3(0, 120, 0)): AiRacerSpec => ({
  id,
  spawn,
  orientation: [0, 0, 0, 1],
  tuning: AI_RACER_TUNINGS.fast as never,
})

/**
 * Dive at the buried gate for `seconds`, over `ground`, and report the worst
 * clearance reached.
 *
 * `terrain` is left EMPTY on purpose: the autopilot must not be allowed to avoid
 * the thing this file is about. That is also what exercises `stepAiRacer`'s two
 * separate field lists — what it avoids and what it hits are not the same list
 * in the running game either, because the player collides with the ocean plate
 * and the controller must not see it.
 */
const dive = (ground: readonly (typeof FLAT)[], seconds = 30) => {
  const racer = createAiRacer(spec('a'), buriedGate)
  let worstClearance = Number.POSITIVE_INFINITY
  let struckAt = -1
  for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) {
    stepAiRacer(racer, buriedGate, [], FIXED_DT, null, ground)
    const p = racer.jet.body.position
    worstClearance = Math.min(worstClearance, p.y - terrainHeightAt(FLAT, p.x, p.z))
    if (struckAt < 0 && racer.ground.collision.struck) struckAt = i
  }
  return { racer, worstClearance, struckAt: struckAt < 0 ? null : struckAt * FIXED_DT }
}

describe('an AI racer flown at the ground', () => {
  it('goes STRAIGHT THROUGH IT when there is no field — the bug, stated', () => {
    // The control half of the pair. Without a collision surface the racer takes
    // a gate 200 m underground and ends 270 m below the terrain, which is
    // DEV-032's sea floor with the sea left out.
    const { racer, worstClearance, struckAt } = dive([])
    expect(struckAt).toBeNull()
    expect(worstClearance).toBeLessThan(-100)
    expect(racer.jet.body.position.y).toBeLessThan(0)
  })

  it('is STOPPED by it when there is one', () => {
    const { racer, worstClearance, struckAt } = dive([FLAT])
    // It touches, and it touches early — the dive starts immediately.
    expect(struckAt).not.toBeNull()
    expect(struckAt as number).toBeLessThan(5)
    // And it never gets below the surface. Not "not much" below: the hull's
    // lowest sphere keeps the body's own origin about a metre clear, so a
    // negative clearance here would mean the depenetration did not happen.
    expect(worstClearance).toBeGreaterThan(0)
    expect(racer.jet.body.position.y).toBeGreaterThan(GROUND_Y)
  })

  it('does NOT end its run on contact, because 2016 does not', () => {
    // `endOnCollide` is 0 on the shipped `PlayerShip_SR14_Photon.prefab`: the
    // ground costs you speed and the turn, the BOUNDARY is what kills you
    // (DEV-017) and it is disabled in 6 of the 13 missions anyway. A racer that
    // died on a hillside would be a rule the player does not play by.
    const { racer } = dive([FLAT])
    expect(racer.finished).toBe(false)
    expect(racer.gates).toBe(0)
    // The buried gate is still unreachable and still unscored — the racer was
    // stopped, not teleported.
    expect(racer.course.passed[0]).toBe(false)
  })

  it('costs it the turn for 0.3 s, which is what a contact is FOR', () => {
    // `Ship_HoverShip.Flash()`: angular drag x3 for `WaitForSeconds(0.3f)`.
    const racer = createAiRacer(spec('a'), buriedGate)
    const base = racer.ground.baseAngularDrag
    expect(base).toBe(HOVERJET.rigidbody.angularDrag)
    let firstHit = -1
    for (let i = 0; i < Math.round(30 / FIXED_DT); i++) {
      stepAiRacer(racer, buriedGate, [], FIXED_DT, null, [FLAT])
      if (racer.ground.collision.struck) {
        firstHit = i
        break
      }
    }
    expect(firstHit).toBeGreaterThan(0)
    expect(racer.ground.collision.flashFor).toBeCloseTo(0.3, 6)
    expect(racer.jet.body.angularDrag).toBeCloseTo(base * 3, 6)
  })
})

describe('two racers — trap 19', () => {
  /** Step A (diving at the ground) and B (high and clear) in one loop. */
  const pair = (seconds = 30) => {
    const a = createAiRacer(spec('a'), buriedGate)
    const b = createAiRacer(spec('b', v3(1500, 900, 0)), skyGate)
    let worstBFlash = 0
    let worstBDrag = 0
    let aEverStruck = false
    for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) {
      stepAiRacer(a, buriedGate, [], FIXED_DT, null, [FLAT])
      stepAiRacer(b, skyGate, [], FIXED_DT, null, [FLAT])
      aEverStruck = aEverStruck || a.ground.collision.struck
      worstBFlash = Math.max(worstBFlash, b.ground.collision.flashFor)
      worstBDrag = Math.max(worstBDrag, b.jet.body.angularDrag)
    }
    return { a, b, worstBFlash, worstBDrag, aEverStruck }
  }

  it('does not hand one racer the other racer’s collision', () => {
    // THE guard, in the shape trap 19 says to write it: step a SECOND one and
    // assert the first did not move. Here it is the other way round — A spends
    // the whole run in the dirt and B must come through untouched, which is the
    // assertion a single shared `TerrainCollisionState` would fail.
    const { a, b, worstBFlash, worstBDrag, aEverStruck } = pair()
    expect(aEverStruck).toBe(true)
    expect(a.ground.collision.depth).toBeGreaterThan(0)
    // B never touches anything, so nothing about B ever changes.
    expect(worstBFlash).toBe(0)
    expect(worstBDrag).toBe(b.ground.baseAngularDrag)
    expect(b.ground.collision.depth).toBe(0)
    expect(b.jet.body.position.y).toBeGreaterThan(GROUND_Y + 500)
  })

  it('flies A the same line whether or not B is stepped beside it', () => {
    // The other direction of the same channel: B's presence must not perturb A.
    const alone = dive([FLAT]).racer
    const beside = pair().a
    expect(beside.jet.body.position.x).toBeCloseTo(alone.jet.body.position.x, 6)
    expect(beside.jet.body.position.y).toBeCloseTo(alone.jet.body.position.y, 6)
    expect(beside.jet.body.position.z).toBeCloseTo(alone.jet.body.position.z, 6)
  })

  it('gives every racer its OWN ground state object', () => {
    // Cheap, and it is the thing the two tests above are really asserting.
    const a = createAiRacer(spec('a'), buriedGate)
    const b = createAiRacer(spec('b'), buriedGate)
    expect(a.ground).not.toBe(b.ground)
    expect(a.ground.collision).not.toBe(b.ground.collision)
    expect(a.ground.hover).not.toBe(b.ground.hover)
  })
})

describe('the rule itself', () => {
  it('hovers BEFORE it collides, and the order is measurable', () => {
    // Not a code-order assertion — a number that comes out different if the two
    // are swapped.
    //
    // A body sitting IN the ground with -10 m/s of descent. The hover ray from
    // inside the surface reports distance 0, so the motor fires at full
    // strength: an IMPULSE of `hoverForce / mass` = 0.875 m/s. Run first, that
    // impulse is then eaten by the depenetration, which removes the whole
    // into-surface component against a zero-bounciness material — so the ship
    // ends the tick at exactly **0**.
    //
    // Run the other way round, the collision would zero the -10 and the hover
    // would then add its push to a stationary ship: about **+0.6 m/s**, from a
    // ray that now starts outside the surface. Zero and 0.6 are not each other.
    const body = createRigidBody({
      mass: HOVERJET.rigidbody.mass,
      drag: HOVERJET.rigidbody.drag,
      angularDrag: HOVERJET.rigidbody.angularDrag,
      useGravity: false,
    })
    body.position.y = GROUND_Y
    body.velocity.y = -10
    const state = createGroundContact(body.angularDrag)
    const struck = stepGroundContact(state, body, [FLAT], HOVERJET_GROUND, FIXED_DT)
    expect(struck).toBe(true)
    expect(body.velocity.y).toBeCloseTo(0, 9)
    // And the push-out happened: the hull's deepest sphere is clear of the
    // surface, so the body's own origin is above it.
    expect(body.position.y).toBeGreaterThan(GROUND_Y)
    // `Flash()` applied on the same tick, not the next one.
    expect(body.angularDrag).toBeCloseTo(HOVERJET.rigidbody.angularDrag * 3, 9)
  })

  it('leaves a body in clear air completely alone', () => {
    const body = createRigidBody({
      mass: HOVERJET.rigidbody.mass,
      drag: HOVERJET.rigidbody.drag,
      angularDrag: HOVERJET.rigidbody.angularDrag,
      useGravity: false,
    })
    body.position.y = GROUND_Y + 500
    body.velocity.y = -50
    const state = createGroundContact(body.angularDrag)
    expect(stepGroundContact(state, body, [FLAT], HOVERJET_GROUND, FIXED_DT)).toBe(false)
    expect(body.position.y).toBe(GROUND_Y + 500)
    expect(body.velocity.y).toBe(-50)
    expect(body.angularDrag).toBe(HOVERJET.rigidbody.angularDrag)
  })

  it('does not let one body’s contact reach another’s — trap 19', () => {
    // The two-object variant of the rule itself, below the racer layer: two
    // states, two bodies, stepped alternately. A module-level `flashFor` or a
    // shared `baseAngularDrag` would show up here first.
    const make = (y: number) => {
      const body = createRigidBody({
        mass: HOVERJET.rigidbody.mass,
        drag: HOVERJET.rigidbody.drag,
        angularDrag: HOVERJET.rigidbody.angularDrag,
        useGravity: false,
      })
      body.position.y = y
      body.velocity.y = -10
      return { body, state: createGroundContact(body.angularDrag) }
    }
    const buried = make(GROUND_Y)
    const clear = make(GROUND_Y + 500)
    for (let i = 0; i < 10; i++) {
      stepGroundContact(buried.state, buried.body, [FLAT], HOVERJET_GROUND, FIXED_DT)
      stepGroundContact(clear.state, clear.body, [FLAT], HOVERJET_GROUND, FIXED_DT)
      expect(clear.state.collision.flashFor).toBe(0)
      expect(clear.body.angularDrag).toBe(HOVERJET.rigidbody.angularDrag)
    }
    expect(buried.state.collision.flashFor).toBeGreaterThan(0)
    expect(buried.body.angularDrag).toBeCloseTo(HOVERJET.rigidbody.angularDrag * 3, 9)
  })
})

describe('the spec the racers fly with', () => {
  it('is the SHIPPED prefab, off the sheet, not a second set of numbers', () => {
    // The five solid colliders of `PlayerShip_SR14_Photon.prefab`, each reduced
    // to one sphere (DEV-020). Derived, not written down — a hand-copied hull is
    // how the player and the opposition end up in two different worlds.
    expect(HOVERJET_GROUND.collision.hull).toEqual(
      hullFromColliders(
        HOVERJET.shipCollisionColliders as unknown as Parameters<typeof hullFromColliders>[0],
      ),
    )
    expect(HOVERJET_GROUND.collision.hull.length).toBe(5)
    expect(HOVERJET_GROUND.hover.hoverForce).toBe(HOVERJET.hoverMotor.hoverForce)
    expect(HOVERJET_GROUND.hover.hoverHeight).toBe(HOVERJET.hoverMotor.hoverHeight)
  })

  it('carries the four ENGINE defaults the sheet cannot hold', () => {
    // `m_Material: {fileID: 0}` is PhysX's built-in default — bounciness 0,
    // friction 0.6 — and `Flash()`'s 0.3 s / x3 are code constants in a
    // coroutine. Nothing in the Unity project serialises any of them, which is
    // why they are literals and why they are pinned here.
    //
    // Zero is the load-bearing one: a hull that bounced would turn every mistake
    // into a pinball, and 2016 deliberately did not have that.
    expect(HOVERJET_GROUND.collision.restitution).toBe(0)
    expect(HOVERJET_GROUND.collision.friction).toBe(0.6)
    expect(HOVERJET_GROUND.collision.flashSeconds).toBe(0.3)
    expect(HOVERJET_GROUND.collision.flashAngularDrag).toBe(3)
  })
})
