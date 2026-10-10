// tests/unit/boundary.test.ts — the edge of the world.
//
// Two of these assertions exist because the numbers have been wrong before, in
// this exact place:
//
//   `resetDelay` initialises to 10 in C# and ships as **13** in all thirteen
//   scenes. That is the cardinal rule's third victim.
//
//   The component is **DISABLED in 6 of 13 missions**. A global fallback would
//   silently hand those six a boundary the game never had — which is why the
//   schema requires both fields and offers nothing to fall back to. The sixth,
//   `rookie_01_jumpSeat`, is a DEACTIVATED GameObject with `m_Enabled: 1` on it:
//   the liveness walk, not the flag.
//
// The rest is the shape of the rule: a region you are INSIDE (the collider is a
// trigger and the clock starts on `OnTriggerExit`), a countdown you can cancel
// by turning round, and a death you cannot.

import { describe, expect, it } from 'vitest'
import { threeTupleToUnity } from '@/render/unity-space'
import {
  type BoundarySpec,
  boundaryCountdown,
  createBoundary,
  isOutside,
  stepBoundary,
} from '@/sim/boundary'
import { FIXED_DT } from '@/sim/constants'
import { v3 } from '@/sim/math/vec3'
import adv02JumpSeat from '../../content/levels/adv_02_jumpSeat.json'
import int01 from '../../content/levels/int_01_hoverJet.json'
import int01JumpSeat from '../../content/levels/int_01_jumpSeat.json'
import rookie01 from '../../content/levels/rookie_01_hoverJet.json'

/** Just the fields a boundary needs, so HoverJet and JumpSeat levels both fit. */
interface BoundaryLevel {
  boundary: {
    enabled: boolean
    resetDelay: number
    resetFadeSeconds: number
    volume: unknown
  }
  respawn: { pos: number[] }
}

/** Build the sim-space spec the game would, from the level JSON. */
const specFor = (level: BoundaryLevel): BoundarySpec => {
  const v = level.boundary.volume as { centre: number[]; radius: number }
  return {
    enabled: level.boundary.enabled,
    centre: threeTupleToUnity(v3(), v.centre),
    radius: v.radius,
    resetDelaySeconds: level.boundary.resetDelay,
    fadeSeconds: level.boundary.resetFadeSeconds,
  }
}

const SPEC = specFor(int01)

/** Hold a position for `seconds` and report whether the run restarted. */
const hold = (
  state: ReturnType<typeof createBoundary>,
  at: ReturnType<typeof v3>,
  seconds: number,
) => {
  let restarts = 0
  const steps = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < steps; i++) if (stepBoundary(state, SPEC, at, FIXED_DT)) restarts++
  return restarts
}

/**
 * A boundary that has been ARMED — one frame inside, which is `OnTriggerEnter`.
 *
 * Every countdown test below needs this now, and that is the point rather than
 * an inconvenience: `OnTriggerExit` only fires for a collider that was inside,
 * so a state that has never been in the sphere has no exit to fire and no clock
 * to run. Before this, every test here started at `createBoundary()` and
 * teleported the ship outside — a sequence Unity cannot produce — and the
 * fiction hid a defect that made **two of the thirteen missions unplayable**.
 * See `sim/boundary.ts`'s header, and `tests/e2e/completion.spec.ts`.
 */
const armed = () => {
  const state = createBoundary()
  stepBoundary(state, SPEC, SPEC.centre, FIXED_DT)
  expect(state.armed, 'one frame inside arms it').toBe(true)
  return state
}

describe('what the extractor found', () => {
  it('is a sphere, and it is a TRIGGER — a region, not a wall', () => {
    const v = int01.boundary.volume as { shape: string; isTrigger: boolean; radius: number }
    expect(v.shape).toBe('sphere')
    // The whole rule depends on this. `PlayerBoundary` counts down on
    // `OnTriggerExit`, so a non-trigger collider would mean something else
    // entirely — a wall you bounce off.
    expect(v.isTrigger).toBe(true)
    // radius 0.5 on a transform scaled 5837.4233.
    expect(v.radius).toBeCloseTo(0.5 * 5837.4233, 2)
  })

  it('carries 13 seconds, not the 10 the C# says', () => {
    expect(int01.boundary.resetDelay).toBe(13)
  })

  it('sizes the sphere per COURSE, not once for the game', () => {
    // 2918.7 m on `int_01`, 1797.5 on `rookie_01`. A single global boundary
    // would be wrong on both.
    const a = (int01.boundary.volume as { radius: number }).radius
    const b = (rookie01.boundary.volume as { radius: number }).radius
    expect(a).toBeGreaterThan(2900)
    expect(b).toBeLessThan(1900)
    expect(a).not.toBeCloseTo(b, 0)
  })

  it('is big enough to hold the whole course', () => {
    // If any gate were outside the boundary, flying the course would kill you.
    // This is the check that the centre and radius were composed correctly —
    // a transform mistake puts the sphere somewhere plausible but wrong.
    const centre = SPEC.centre
    for (const ring of int01.routes[0]?.rings ?? []) {
      const p = threeTupleToUnity(v3(), ring.pos as number[])
      const d = Math.hypot(p.x - centre.x, p.y - centre.y, p.z - centre.z)
      expect(d, `ring ${ring.i} is ${Math.round(d)} m out`).toBeLessThan(SPEC.radius)
    }
  })

  it('contains the spawn and the respawn marker', () => {
    for (const [name, pos] of [
      ['spawn', int01.spawn.pos],
      ['respawn', int01.respawn.pos],
    ] as [string, number[]][]) {
      expect(isOutside(threeTupleToUnity(v3(), pos), SPEC), name).toBe(false)
    }
  })

  /**
   * **On two of the thirteen it does not** — and that is 2016's content rather
   * than a port bug. It is also what made the old rule a trap.
   *
   * `int_01_jumpSeat` and `adv_02_jumpSeat` both carry a 2,047 m sphere centred
   * 2.6 km from their own RESPAWN markers, which sit 2,629 m and 2,603 m from
   * its centre. The respawn marker is where every death puts you — so under a
   * LEVEL test the first death was unrecoverable: come back outside, start
   * another countdown, die again, for ever. Measured in a browser at 15.5 s a
   * cycle, which is `resetDelay` 13 plus `resetFadeSeconds` 2.5.
   *
   * 2016 shrugs at all of it, because a reload is a new trigger and a new ship
   * and `OnTriggerExit` fires for neither.
   *
   * Asserted rather than fixed in the content: the content is what shipped, and
   * moving either the marker or the sphere would be inventing a number for two
   * missions that play correctly without one. What it earns is this row, so that
   * `armed` can never be quietly removed as "defensive".
   */
  it('does NOT contain the RESPAWN marker on the two Simonet JumpSeat missions', () => {
    // Typed structurally rather than as `typeof int01`: the JumpSeat levels have
    // `spawn.launch: null` and the HoverJet ones do not, so the two JSON shapes
    // are not assignable to each other. The fields this needs are the only ones
    // it should be asking about anyway.
    const cases: [string, BoundaryLevel][] = [
      ['int_01_jumpSeat', int01JumpSeat],
      ['adv_02_jumpSeat', adv02JumpSeat],
    ]
    for (const [id, level] of cases) {
      const spec = specFor(level)
      expect(spec.enabled, `${id}: the boundary is live`).toBe(true)
      const at = threeTupleToUnity(v3(), level.respawn.pos as number[])
      expect(isOutside(at, spec), `${id}: respawns outside its own play area`).toBe(true)
    }
  })
})

describe('the countdown', () => {
  it('does nothing at all while you are inside', () => {
    const state = createBoundary()
    expect(hold(state, SPEC.centre, 30)).toBe(0)
    expect(state.phase).toBe('inside')
    expect(boundaryCountdown(state, SPEC)).toBeNull()
  })

  it('restarts the run after exactly resetDelay seconds outside', () => {
    const state = armed()
    const far = v3(SPEC.centre.x + SPEC.radius * 2, SPEC.centre.y, SPEC.centre.z)
    // Not yet — one tick short of the delay.
    expect(hold(state, far, SPEC.resetDelaySeconds - 0.5)).toBe(0)
    expect(state.phase).toBe('warning')
    // Over the line into the fade, but the restart is at the END of the fade.
    expect(hold(state, far, 1)).toBe(0)
    expect(state.phase).toBe('dying')
    expect(hold(state, far, SPEC.fadeSeconds)).toBe(1)
  })

  it('counts down in whole seconds, the way 2016 logged it', () => {
    const state = armed()
    const far = v3(SPEC.centre.x + SPEC.radius * 2, SPEC.centre.y, SPEC.centre.z)
    expect(boundaryCountdown(state, SPEC)).toBeNull()
    hold(state, far, 0.1)
    expect(boundaryCountdown(state, SPEC)).toBe(13)
    hold(state, far, 3)
    expect(boundaryCountdown(state, SPEC)).toBe(10)
    hold(state, far, 9)
    expect(boundaryCountdown(state, SPEC)).toBe(1)
    // Past the delay it is no longer a countdown — it is a death, and there is
    // nothing left to count.
    hold(state, far, 1)
    expect(state.phase).toBe('dying')
    expect(boundaryCountdown(state, SPEC)).toBeNull()
  })

  it('cancels the moment you turn round, and banks NOTHING', () => {
    // `OnTriggerEnter` zeroes the counter. So a run that crosses the line five
    // times for ten seconds each is not on borrowed time — it is fine.
    const state = armed()
    const far = v3(SPEC.centre.x + SPEC.radius * 2, SPEC.centre.y, SPEC.centre.z)
    for (let i = 0; i < 5; i++) {
      expect(hold(state, far, 10)).toBe(0)
      expect(state.phase).toBe('warning')
      hold(state, SPEC.centre, 0.5)
      expect(state.phase).toBe('inside')
      expect(state.outsideFor).toBe(0)
    }
    expect(hold(state, far, 10)).toBe(0)
  })

  it('cannot be cancelled once the fade has started', () => {
    // 2016 sets `restarting` and the coroutine is uninterruptible. That is what
    // makes it a death rather than a second warning.
    const state = armed()
    const far = v3(SPEC.centre.x + SPEC.radius * 2, SPEC.centre.y, SPEC.centre.z)
    hold(state, far, SPEC.resetDelaySeconds + 0.1)
    expect(state.phase).toBe('dying')
    // Fly all the way home. It does not help.
    expect(hold(state, SPEC.centre, SPEC.fadeSeconds + 0.1)).toBe(1)
  })

  it('reports the restart EXACTLY once per death', () => {
    // The caller resets the mission, the ghosts and the ship on this signal, so
    // firing twice for one death would restart a run that had already begun.
    const state = armed()
    const far = v3(SPEC.centre.x + SPEC.radius * 2, SPEC.centre.y, SPEC.centre.z)
    const cycle = SPEC.resetDelaySeconds + SPEC.fadeSeconds
    expect(hold(state, far, cycle + 1)).toBe(1)
  })

  it('does NOTHING to a ship that was never inside — the exit is an EDGE', () => {
    // **The regression that made two missions unplayable.** `int_01_jumpSeat`
    // spawns 581 m outside its own sphere and `adv_02_jumpSeat` 556 m outside
    // theirs; under a level test both began the countdown on frame one and reset
    // every 15.5 s for ever. 2016 does not, because `OnTriggerExit` never fires
    // for a collider that was never in the volume — there is no `OnTriggerStay`
    // and no distance check anywhere in `PlayerBoundary.cs`.
    //
    // Held for THREE full cycles, which is the shape of the bug rather than one
    // tick of it: the old code restarted the run three times here, and this same
    // assertion used to READ `.toBe(3)`.
    const state = createBoundary()
    const far = v3(SPEC.centre.x + SPEC.radius * 2, SPEC.centre.y, SPEC.centre.z)
    const cycle = SPEC.resetDelaySeconds + SPEC.fadeSeconds
    expect(hold(state, far, cycle * 3 + 1), 'never armed, never killed').toBe(0)
    expect(state.phase, 'and nothing is on screen about it').toBe('inside')
    expect(boundaryCountdown(state, SPEC)).toBeNull()
  })

  it('kills you once you HAVE been inside and then leave', () => {
    // The other half, so the test above cannot pass by the boundary being dead.
    // Fly in, fly out, and the clock is the clock.
    const state = armed()
    const far = v3(SPEC.centre.x + SPEC.radius * 2, SPEC.centre.y, SPEC.centre.z)
    const cycle = SPEC.resetDelaySeconds + SPEC.fadeSeconds
    expect(hold(state, far, cycle + 0.1), 'one excursion, one death').toBe(1)
  })

  it('re-arms only by going back inside, so a respawn OUTSIDE is survivable', () => {
    // 2016 reloads the scene on a death: a new trigger, a new ship, and nothing
    // has entered anything yet. So the loop only continues if the respawn puts
    // you back in — which is what the respawn marker is for (see "contains the
    // spawn and the respawn marker" above).
    const state = armed()
    const far = v3(SPEC.centre.x + SPEC.radius * 2, SPEC.centre.y, SPEC.centre.z)
    const cycle = SPEC.resetDelaySeconds + SPEC.fadeSeconds
    expect(hold(state, far, cycle + 0.1), 'the first death').toBe(1)
    expect(state.armed, 'and the reload disarms it').toBe(false)
    expect(hold(state, far, cycle * 2 + 1), 'no second death out here').toBe(0)
  })

  it('is exactly on the surface at the radius, and out just past it', () => {
    // The sphere test is `>`, matching a trigger that has not yet exited.
    const onIt = v3(SPEC.centre.x + SPEC.radius, SPEC.centre.y, SPEC.centre.z)
    expect(isOutside(onIt, SPEC)).toBe(false)
    const past = v3(SPEC.centre.x + SPEC.radius + 0.01, SPEC.centre.y, SPEC.centre.z)
    expect(isOutside(past, SPEC)).toBe(true)
  })
})

describe('the five missions with no boundary', () => {
  it('never counts down when the component is disabled', () => {
    // `PlayerBoundary` is disabled in 6 of 13. Those missions let you fly to the
    // horizon, and a port that helpfully applied a default would be inventing a
    // death the game never had.
    const off: BoundarySpec = { ...SPEC, enabled: false }
    const state = createBoundary()
    const far = v3(1e6, 1e6, 1e6)
    let restarts = 0
    for (let i = 0; i < 20000; i++) if (stepBoundary(state, off, far, FIXED_DT)) restarts++
    expect(restarts).toBe(0)
    expect(state.phase).toBe('inside')
    expect(boundaryCountdown(state, off)).toBeNull()
  })

  it('stands the clock down if the boundary is switched off mid-count', () => {
    const state = armed()
    const far = v3(SPEC.centre.x + SPEC.radius * 2, SPEC.centre.y, SPEC.centre.z)
    hold(state, far, 5)
    expect(state.phase).toBe('warning')
    stepBoundary(state, { ...SPEC, enabled: false }, far, FIXED_DT)
    expect(state.phase).toBe('inside')
    expect(state.outsideFor).toBe(0)
  })
})
