// tests/unit/prop-collision.test.ts — the trees are solid, and they break. DEV-136.
//
// Pure sim: a hull of one sphere, a handful of capsules, no terrain. Above the
// break speed a contact breaks the prop, removes its collider and reports it;
// below it the hull is pushed out and bounced and the prop stands; a prop
// nowhere near the hull is never touched (trap 19's guard: step a SECOND one
// and assert it did not move).

import { describe, expect, it } from 'vitest'
import {
  buildPropColliders,
  createPropCollision,
  type PropCollisionSpec,
  type PropPlacementInput,
  stepPropCollision,
} from '@/sim/props/collision'
import { createRigidBody } from '@/sim/rigidbody'
import type { HullSphere } from '@/sim/terrain-collision'

const SPEC: PropCollisionSpec = {
  breakSpeed: 40,
  breakSlowdown: 0.05,
  bounceRestitution: 0.2,
  radiusFraction: 0.3,
  cellMetres: 64,
  // `stepPropCollision` never reads it — DEV-180's escape is the racer's, and
  // `racer-props.test.ts` is where it is exercised. Stated rather than omitted
  // so this literal stays a whole spec.
  racerStuckSeconds: 1,
}

/** A 30 m tree, 6 m wide, base 0.5 m under its placement — one metre wide at scale 1. */
const tree = (x: number, z: number, y = 0): PropPlacementInput => ({
  x,
  y,
  z,
  scale: 6,
  dims: { height: 5, base: -0.083, width: 1 },
  kind: 'tree',
})

const HULL: readonly HullSphere[] = [{ x: 0, y: 0, z: 0, radius: 1.5 }]
const ORIGIN = { x: 0, y: 0, z: 0 }

describe('DEV-136: prop collision', () => {
  it('builds capsules in sim space from the drawn dims times the placement scale', () => {
    const props = buildPropColliders([tree(100, 200)], { x: 10, y: 5, z: -20 }, SPEC)
    expect(props.count).toBe(1)
    expect(props.x[0]).toBeCloseTo(110)
    expect(props.z[0]).toBeCloseTo(180)
    expect(props.bottom[0]).toBeCloseTo(5 - 0.083 * 6, 3)
    expect(props.top[0]).toBeCloseTo(5 + 30)
    expect(props.radius[0]).toBeCloseTo(6 * 0.3)
    expect(props.kind[0]).toBe('tree')
  })

  it('breaks a tree hit above the break speed, removes its collider, reports it, and leaves the next tree standing', () => {
    const props = buildPropColliders([tree(100, 100), tree(100, 130)], ORIGIN, SPEC)
    const state = createPropCollision()
    const body = createRigidBody({ mass: 4 })
    body.position.x = 100.5
    body.position.y = 12
    body.position.z = 100
    body.velocity.z = 90 // straight at the trunk, fast

    const n = stepPropCollision(state, body, HULL, props, SPEC)
    expect(n).toBe(1)
    const hit = state.hits[0]
    expect(hit?.id).toBe(0)
    expect(hit?.broken).toBe(true)
    expect(hit?.kind).toBe('tree')
    expect(hit?.speed).toBeCloseTo(90)
    expect(props.broken[0]).toBe(1)
    expect(props.broken[1]).toBe(0)
    expect(state.brokenCount).toBe(1)
    // A break costs `breakSlowdown` of the speed and nothing else: no push-out.
    expect(body.velocity.z).toBeCloseTo(90 * 0.95)
    expect(body.position.x).toBeCloseTo(100.5)

    // Next tick, still inside the broken one: nothing. It is gone.
    expect(stepPropCollision(state, body, HULL, props, SPEC)).toBe(0)
    expect(state.hits).toHaveLength(0)
  })

  it('bounces off a tree hit below the break speed and the tree stands', () => {
    const props = buildPropColliders([tree(100, 100)], ORIGIN, SPEC)
    const state = createPropCollision()
    const body = createRigidBody({ mass: 4 })
    // Hull centre 2 m from the axis in +x: radius 1.8 + 1.5 = 3.3, so 1.3 m in.
    body.position.x = 102
    body.position.y = 12
    body.position.z = 100
    body.velocity.x = -20 // into the trunk, slow

    const n = stepPropCollision(state, body, HULL, props, SPEC)
    expect(n).toBe(1)
    expect(state.hits[0]?.broken).toBe(false)
    expect(state.hits[0]?.normal.x).toBeCloseTo(1)
    expect(props.broken[0]).toBe(0)
    // Pushed out to touching, and the velocity into it reflected by 0.2.
    expect(body.position.x).toBeCloseTo(100 + 1.8 + 1.5, 5)
    expect(body.velocity.x).toBeCloseTo(20 * 0.2, 5)
  })

  it('never touches a prop above or below the hull, or in another cell', () => {
    const props = buildPropColliders([tree(100, 100), tree(1000, 1000)], ORIGIN, SPEC)
    const state = createPropCollision()
    const body = createRigidBody({ mass: 4 })
    body.position.x = 100
    body.position.y = 60 // 30 m over the 30 m tree
    body.position.z = 100
    body.velocity.z = 90
    expect(stepPropCollision(state, body, HULL, props, SPEC)).toBe(0)
    body.position.y = 12
    body.position.x = 500 // between the two, far from both
    body.position.z = 500
    expect(stepPropCollision(state, body, HULL, props, SPEC)).toBe(0)
    expect(props.broken[0]).toBe(0)
    expect(props.broken[1]).toBe(0)
  })

  it('reports each hit as its own object, not a shared scratch', () => {
    const props = buildPropColliders([tree(100, 100), tree(100, 102)], ORIGIN, SPEC)
    const state = createPropCollision()
    const body = createRigidBody({ mass: 4 })
    body.position.x = 100
    body.position.y = 12
    body.position.z = 101
    body.velocity.z = 90
    expect(stepPropCollision(state, body, HULL, props, SPEC)).toBe(2)
    expect(state.hits[0]).not.toBe(state.hits[1])
    expect(state.hits[0]?.point).not.toBe(state.hits[1]?.point)
    expect(new Set(state.hits.map((h) => h.id)).size).toBe(2)
  })
})
