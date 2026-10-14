// tests/unit/prop-strike.test.ts — a struck prop stands, and bursts in its own colours. DEV-428.
//
// Matt, 2026-09-26: *"instead of removing props that are collided with, spawn
// particle burst fx at the collision point, in the color of the collided prop,
// and give it some velocity from the collision"* — and of the tree, *"stay
// standing"*.
//
// Three halves, each measured against something the strike code did not make:
//
//  - the SIM keeps the collider: a second flier and a second pass both meet a
//    solid tree, and the one passing through pays for it once (the capsule and
//    the break speed are `buildPropColliders`' and the spec's);
//  - the burst LEAVES with the hitter: its mean launch velocity is `carry` of a
//    velocity the test chose, with gravity and drag zeroed on a copy, because a
//    piece that has been falling points down whatever threw it (DEV-416's
//    method);
//  - the colours are the PROP's: a two-colour tree's own vertex colours, and
//    the height it was struck at picks which.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { Edition, EditionPropBurst } from '@/content/edition-schema'
import { lookOnRules } from '@/content/edition-split'
import {
  propBurstAtLoad,
  propFaceTable,
  propStrikeOf,
  propStrikeSpec,
  strikePalette,
  strikeStands,
} from '@/game/particle-fx'
import { createParticleField, MAX_PALETTE, particleAttribute } from '@/render/particles'
import {
  buildPropColliders,
  createPropCollision,
  type PropCollisionSpec,
  type PropPlacementInput,
  stepPropCollision,
} from '@/sim/props/collision'
import { createRigidBody } from '@/sim/rigidbody'
import type { HullSphere } from '@/sim/terrain-collision'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const BASE: PropCollisionSpec = {
  breakSpeed: 40,
  breakSlowdown: 0.05,
  bounceRestitution: 0.2,
  radiusFraction: 0.3,
  cellMetres: 64,
  racerStuckSeconds: 1,
}
const STANDING: PropCollisionSpec = { ...BASE, strike: { enabled: true } }

/** A 30 m tree, 6 m wide — `prop-collision.test.ts`'s own. */
const tree = (x: number, z: number): PropPlacementInput => ({
  x,
  y: 0,
  z,
  scale: 6,
  dims: { height: 5, base: -0.083, width: 1 },
  kind: 'tree',
})
const HULL: readonly HullSphere[] = [{ x: 0, y: 0, z: 0, radius: 1.5 }]
const ORIGIN = { x: 0, y: 0, z: 0 }
/** The fixed step, in seconds. The sim's own number is the sheet's; any small one moves the body the same way here. */
const DT = 0.0122

/**
 * Fly a body straight along +z through the tree at (100, 100) from z = 90 to
 * z = 110, stepping the contact every tick. Returns every hit it reported.
 */
const flyThrough = (
  props: ReturnType<typeof buildPropColliders>,
  state: ReturnType<typeof createPropCollision>,
  spec: PropCollisionSpec,
  speed = 90,
) => {
  const body = createRigidBody({ mass: 4 })
  body.position.x = 100.5
  body.position.y = 12
  body.position.z = 90
  body.velocity.z = speed
  const hits: { broken: boolean; speed: number }[] = []
  for (let t = 0; t < 400 && body.position.z < 110; t++) {
    body.position.z += body.velocity.z * DT
    stepPropCollision(state, body, HULL, props, spec)
    for (const h of state.hits) hits.push({ broken: h.broken, speed: h.speed })
  }
  return { body, hits }
}

describe('DEV-428: the sim keeps a struck tree solid', () => {
  it('lets the hitter THROUGH once — one strike, one slowdown — and keeps the collider', () => {
    const props = buildPropColliders([tree(100, 100)], ORIGIN, STANDING)
    const state = createPropCollision()
    const { body, hits } = flyThrough(props, state, STANDING)
    // The capsule is 1.8 m, the hull 1.5: about 0.07 s of overlap at 90 m/s,
    // six ticks — and ONE of them is a strike.
    expect(hits).toEqual([{ broken: true, speed: expect.closeTo(90, 5) }])
    expect(body.velocity.z).toBeCloseTo(90 * (1 - BASE.breakSlowdown), 5)
    expect(body.position.z).toBeGreaterThan(105)
    expect(props.broken[0]).toBe(0)
    expect(state.brokenCount).toBe(1)
    // Out the far side: the pass is over, so nothing is remembered.
    expect(state.passing).toEqual([])
  })

  it('is solid to the NEXT flier, and to this one on its next pass', () => {
    const props = buildPropColliders([tree(100, 100)], ORIGIN, STANDING)
    const first = createPropCollision()
    expect(flyThrough(props, first, STANDING).hits).toHaveLength(1)
    // Another flier, its own state (DEV-147): the tree the first struck is there.
    const second = createPropCollision()
    expect(flyThrough(props, second, STANDING).hits).toHaveLength(1)
    // And the first again, from the start: a strike, not a ghost.
    expect(flyThrough(props, first, STANDING).hits).toHaveLength(1)
    expect(props.broken[0]).toBe(0)
  })

  it('with the strike off is DEV-136: removed, and the next flier passes a ghost', () => {
    const props = buildPropColliders([tree(100, 100)], ORIGIN, BASE)
    expect(flyThrough(props, createPropCollision(), BASE).hits).toHaveLength(1)
    expect(props.broken[0]).toBe(1)
    expect(flyThrough(props, createPropCollision(), BASE).hits).toHaveLength(0)
  })

  it('a LANDMARK (a rock with its own hull) is still removed: nobody flies through a standing spire', () => {
    // A 4 m box of rock, 20 m tall, as a convex hull — planes in the placement
    // frame, which is the terrain's mesh space and not the prop's own —
    // the shape every spire's collider carries (DEV-213), which is what makes
    // it a rock to the sim.
    const rock: PropPlacementInput = {
      x: 100,
      y: 0,
      z: 100,
      scale: 1,
      dims: { height: 20, base: 0, width: 4 },
      kind: 'spire',
      hull: new Float32Array([
        ...[1, 0, 0, 102],
        ...[-1, 0, 0, -98],
        ...[0, 0, 1, 102],
        ...[0, 0, -1, -98],
        ...[0, 1, 0, 20],
        ...[0, -1, 0, 0],
      ]),
    }
    const props = buildPropColliders([rock], ORIGIN, STANDING)
    expect(flyThrough(props, createPropCollision(), STANDING).hits).toHaveLength(1)
    expect(props.broken[0]).toBe(1)
  })

  it('still bounces below the break speed, standing or not', () => {
    const props = buildPropColliders([tree(100, 100)], ORIGIN, STANDING)
    const state = createPropCollision()
    const body = createRigidBody({ mass: 4 })
    body.position.x = 102
    body.position.y = 12
    body.position.z = 100
    body.velocity.x = -20
    stepPropCollision(state, body, HULL, props, STANDING)
    expect(state.hits[0]?.broken).toBe(false)
    expect(state.passing).toEqual([])
    expect(body.velocity.x).toBeCloseTo(20 * BASE.bounceRestitution, 5)
  })
})

describe('DEV-428: the renderer draws what the sim has', () => {
  it('a strike that kept its collider stands; one that lost it comes apart', () => {
    const colliders = { broken: new Uint8Array([0, 1]) }
    expect(strikeStands({ id: 0, broken: true }, colliders)).toBe(true)
    expect(strikeStands({ id: 1, broken: true }, colliders)).toBe(false)
    expect(strikeStands({ id: 0, broken: false }, colliders)).toBe(false)
  })

  it('a strike leaves the sim in three space: z flips for the point AND the velocity', () => {
    const s = propStrikeOf(
      { id: 0, point: { x: 3, y: 20, z: 7 } },
      { x: 1, y: 2, z: 90 },
      { bottom: new Float32Array([0]), top: new Float32Array([40]) },
      null,
    )
    expect(s.point).toEqual({ x: 3, y: 20, z: -7 })
    expect(s.velocity).toEqual({ x: 1, y: 2, z: -90 })
    expect(s.heightFraction).toBeCloseTo(0.5)
    expect(s.geometry).toBeNull()
  })
})

/** Anniversary's own numbers: the test measures the shipped spec. */
const SHIPPED: EditionPropBurst = (anniversaryJson as unknown as Edition).fx.propBurst

describe("DEV-428: the burst leaves with the hitter (geometry against the hitter's velocity)", () => {
  /** The mean LAUNCH velocity of one burst: gravity and drag zeroed on a copy. */
  const meanLaunch = (hitter: THREE.Vector3, carry: number) => {
    const spec = propStrikeSpec({ ...SHIPPED, gravity: 0, drag: 0 })
    const field = createParticleField(spec, new THREE.Texture(), {
      capacity: spec.initial?.maxParticles ?? 0,
      look: 'paper',
    })
    const e = field.addEmitter()
    e.matrix.makeTranslation(10, 20, 30)
    e.velocity.copy(hitter).multiplyScalar(carry)
    e.play()
    field.update(0.001, new THREE.PerspectiveCamera())
    const vel = particleAttribute(field, 'iVelocity')
    const pos = particleAttribute(field, 'iPosition')
    const mean = new THREE.Vector3()
    let farthest = 0
    for (let i = 0; i < field.alive; i++) {
      mean.x += vel.getX(i)
      mean.y += vel.getY(i)
      mean.z += vel.getZ(i)
      farthest = Math.max(
        farthest,
        Math.hypot(pos.getX(i) - 10, pos.getY(i) - 20, pos.getZ(i) - 30),
      )
    }
    const n = field.alive
    mean.divideScalar(Math.max(1, n))
    field.dispose()
    return { mean, n, farthest }
  }

  it(`carries ${SHIPPED.carry} of the hit, and the scatter averages out`, () => {
    const hitter = new THREE.Vector3(12, -3, -95)
    const { mean, n, farthest } = meanLaunch(hitter, SHIPPED.carry)
    expect(n).toBe(SHIPPED.count)
    const along = mean.dot(hitter.clone().normalize())
    expect(along / (SHIPPED.carry * hitter.length())).toBeGreaterThan(0.85)
    expect(along / (SHIPPED.carry * hitter.length())).toBeLessThan(1.15)
    // Across the hit, the ball's scatter: a few m/s of noise, not the hit.
    const across = mean.clone().addScaledVector(hitter.clone().normalize(), -along).length()
    expect(across).toBeLessThan(SHIPPED.spread * 0.5)
    // Born in the ball about the contact, and moved for the one millisecond
    // the update integrates: at most the fastest piece's speed times it.
    const fastest = SHIPPED.spread + SHIPPED.carry * hitter.length()
    expect(farthest).toBeLessThanOrEqual(SHIPPED.radius + fastest * 0.001 + 1e-3)
  })

  it('would not, with no velocity on the emitter — so the test can fail', () => {
    const hitter = new THREE.Vector3(12, -3, -95)
    const { mean } = meanLaunch(hitter, 0)
    expect(mean.dot(hitter.clone().normalize())).toBeLessThan(SHIPPED.spread * 0.5)
  })
})

/**
 * A two-colour tree: a trunk (bottom 40 %) in bark, a crown (top) in leaf,
 * vertex colours as a glTF carries them — NORMALISED bytes, split per face.
 */
const twoColourTree = (): THREE.BufferGeometry => {
  const BARK = [120, 70, 30]
  const LEAF = [40, 150, 50]
  const positions: number[] = []
  const colours: number[] = []
  const face = (y0: number, y1: number, rgb: number[], x: number) => {
    positions.push(x, y0, 0, x + 1, y0, 0, x, y1, 0)
    for (let k = 0; k < 3; k++) colours.push(...rgb)
  }
  for (let i = 0; i < 6; i++) face(0 + i, 1 + i, BARK, i % 2) // trunk: y 0..7
  for (let i = 0; i < 10; i++) face(10 + i, 11 + i, LEAF, i % 3) // crown: y 10..20
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(colours), 3, true))
  return g
}

const isLeaf = (r: number, g: number, b: number): boolean =>
  Math.abs(r - (40 / 255) * 0.6) < 1e-3 && Math.abs(g - (150 / 255) * 0.6) < 1e-3 && b < 0.2
const isBark = (r: number, g: number, b: number): boolean =>
  Math.abs(r - (120 / 255) * 0.6) < 1e-3 && Math.abs(g - (70 / 255) * 0.6) < 1e-3 && b < 0.1

describe("DEV-428: the burst is the PROP's colours, from where it was struck", () => {
  const WHITE = { r: 1, g: 1, b: 1 }
  const palette = (heightFraction: number, band: number) => {
    const out = new Float32Array(MAX_PALETTE * 3)
    const n = strikePalette(
      propFaceTable(twoColourTree()),
      heightFraction,
      band,
      MAX_PALETTE,
      7,
      WHITE,
      0.6,
      out,
    )
    return Array.from(
      { length: n },
      (_, k) => [out[k * 3], out[k * 3 + 1], out[k * 3 + 2]] as const,
    )
  }

  it('a strike in the crown throws leaves, and one at the foot throws bark', () => {
    const top = palette(0.9, SHIPPED.colourBand)
    expect(top).toHaveLength(MAX_PALETTE)
    expect(top.every(([r, g, b]) => isLeaf(r as number, g as number, b as number))).toBe(true)
    const foot = palette(0.1, SHIPPED.colourBand)
    expect(foot.every(([r, g, b]) => isBark(r as number, g as number, b as number))).toBe(true)
  })

  it('a band of the whole height throws both, by area — so the band is doing the work', () => {
    const all = palette(0.9, 1)
    expect(all.some(([r, g, b]) => isBark(r as number, g as number, b as number))).toBe(true)
    expect(all.some(([r, g, b]) => isLeaf(r as number, g as number, b as number))).toBe(true)
  })

  it('reaches the particles: every piece of a crown strike is a leaf', () => {
    const spec = propStrikeSpec(SHIPPED)
    const field = createParticleField(spec, new THREE.Texture(), {
      capacity: spec.initial?.maxParticles ?? 0,
      look: 'paper',
    })
    const e = field.addEmitter()
    const out = new Float32Array(MAX_PALETTE * 3)
    const n = strikePalette(
      propFaceTable(twoColourTree()),
      0.9,
      SHIPPED.colourBand,
      MAX_PALETTE,
      1,
      WHITE,
      0.6,
      out,
    )
    e.setPalette(out.subarray(0, n * 3))
    e.play()
    field.update(0.001, new THREE.PerspectiveCamera())
    const col = particleAttribute(field, 'iColor')
    expect(field.alive).toBe(SHIPPED.count)
    for (let i = 0; i < field.alive; i++) {
      expect(isLeaf(col.getX(i), col.getY(i), col.getZ(i)), `piece ${i}`).toBe(true)
    }
    field.dispose()
  })
})

describe('DEV-428: paper, not light', () => {
  it('a paper field is cut opaque and writes depth; the additive default is untouched', () => {
    const spec = propStrikeSpec(SHIPPED)
    const paper = createParticleField(spec, new THREE.Texture(), { look: 'paper' })
    const pm = (paper.object as THREE.Mesh).material as THREE.ShaderMaterial
    expect(pm.defines.PAPER).toBe('')
    expect(pm.transparent).toBe(false)
    expect(pm.depthWrite).toBe(true)
    const light = createParticleField(spec, new THREE.Texture())
    const lm = (light.object as THREE.Mesh).material as THREE.ShaderMaterial
    expect(lm.defines.PAPER).toBeUndefined()
    expect(lm.blending).toBe(THREE.AdditiveBlending)
    expect(lm.transparent).toBe(true)
    expect(lm.depthWrite).toBe(false)
  })
})

// ── DEV-464: the burst goes where the strike goes (D35) ──────────────────
//
// Matt: *"tbh i haven't seen the struck-tree burst (or any other prop
// burst)."* One reason was D35. A mission flies Anniversary's RULES on either
// look, and the strike that keeps a struck tree standing is one of them; the
// burst was on the LOOK side of the key table, and Classic's look has it off.
// So on the Classic look the tree stood, the ship went through it, and the
// world built no burst to say so: the one strike that drew nothing at all.
// Asked of `propBurstAtLoad` — the function the world build calls — on the
// preset the edition state composes, so it is the build's own answer.

const ANNIVERSARY = anniversaryJson as unknown as Edition
const CLASSIC = classicJson as unknown as Edition

describe('DEV-464: a standing strike builds its burst on either look', () => {
  it('builds the burst on the Classic look, whose struck trees stand by Anniversary’s rule', () => {
    const classicLook = lookOnRules(CLASSIC, ANNIVERSARY)
    // The premise, loud: on the Classic look a struck tree STANDS.
    expect(classicLook.gameplay.propCollision.enabled).toBe(true)
    expect(classicLook.gameplay.propCollision.strike.enabled).toBe(true)
    expect(propBurstAtLoad(classicLook)).toEqual(ANNIVERSARY.fx.propBurst)
  })

  it('wherever a struck tree stands a burst is built, and nowhere else: each look on each rules preset', () => {
    for (const look of [ANNIVERSARY, CLASSIC]) {
      for (const rules of [ANNIVERSARY, CLASSIC]) {
        const e = lookOnRules(look, rules)
        const stands = e.gameplay.propCollision.enabled && e.gameplay.propCollision.strike.enabled
        expect(propBurstAtLoad(e) !== null, `${look.id} look on ${rules.id} rules`).toBe(stands)
      }
    }
    // And the sweep reached both answers: `?rules=classic` has no prop
    // collision, so nothing stands and nothing is built.
    expect(propBurstAtLoad(lookOnRules(ANNIVERSARY, CLASSIC))).toBeNull()
  })
})
