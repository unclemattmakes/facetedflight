// tests/unit/racer-props.test.ts — the racers hit the same trees you do. DEV-147.
//
// DEV-136 made the props solid for the PLAYER and left the racers flying
// through them, so on an alpine course you smash a tree while the racer beside
// you passes through it. These are the properties that says:
//
//   * a racer flying its own line into a trunk BREAKS it, at the preset's own
//     numbers, and loses the preset's own share of its speed;
//   * the colliders are ONE forest — what a racer knocks down is gone for the
//     player too, tested through a second, independent `PropCollisionState`;
//   * trap 19's guard, which this file exists for as much as for the feature:
//     **step a SECOND racer and assert the first did not move.** `ai-racer.ts`
//     has already shipped one cross-racer leak (DEV-032's frozen stick), and
//     `hits` is read by the renderer AFTER the step, so a shared one would
//     have the fracture drawn on the wrong ship — or twice.
//
// The tree is placed where the racer actually flies rather than where it
// "should": the line is recorded from a clean run and the trunk put on it, so
// the contact is produced by the controller and not by a teleport.

import { describe, expect, it } from 'vitest'
import { AI_RACER_TUNINGS, type AiRacerSpec, createAiRacer, stepAiRacer } from '@/sim/ai-racer'
import { FIXED_DT } from '@/sim/constants'
import type { Gate } from '@/sim/course'
import type { CrashSpec } from '@/sim/crash'
import { v3 } from '@/sim/math/vec3'
import {
  buildPropColliders,
  createPropCollision,
  type PropCollisionSpec,
  type PropPlacementInput,
  stepPropCollision,
} from '@/sim/props/collision'
import { createRigidBody } from '@/sim/rigidbody'
import { HOVERJET_GROUND } from '@/sim/terrain-collision'
import anniversary from '../../content/editions/anniversary.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

/** The PRESET's numbers, so the test argues with the ones the game ships. */
const SPEC = (anniversary as unknown as { gameplay: { propCollision: PropCollisionSpec } }).gameplay
  .propCollision
const CRASH = (anniversary as unknown as { gameplay: { crash: CrashSpec } }).gameplay.crash
/**
 * DEV-136's response — the collider REMOVED — which is the preset with its
 * DEV-428 strike off. The preset itself keeps a struck tree standing.
 */
const REMOVING: PropCollisionSpec = { ...SPEC, strike: { enabled: false } }

/** The real course, in sim space, the way `game/mission.ts` builds it. */
const gates: Gate[] = (
  int01.routes['0'] as { rings: { pos: number[]; trigger: { radius: number } }[] }
).rings.map((r) => ({
  centre: v3(r.pos[0] as number, r.pos[1] as number, -(r.pos[2] as number)),
  radius: r.trigger.radius,
  points: 100,
  triggerOnce: true,
}))

const SPAWN = v3(-857.8, 126.4, -2082.4)
const spec = (id: string, tuning = AI_RACER_TUNINGS.fast as never): AiRacerSpec => ({
  id,
  spawn: SPAWN,
  orientation: [0, 0, 0, 1],
  tuning,
})

/** A 30 m trunk, 1.8 m collider radius at this scale, standing at (x, z). */
const tree = (x: number, y: number, z: number): PropPlacementInput => ({
  x,
  y: y - 15,
  z,
  scale: 6,
  dims: { height: 5, base: -0.083, width: 1 },
  kind: 'tree',
})

const ORIGIN = { x: 0, y: 0, z: 0 }
const HULL = HOVERJET_GROUND.collision.hull

/** Where a clean racer is after `ticks` steps. Deterministic — no RNG in the sim. */
const positionAfter = (ticks: number, id = 'probe') => {
  const racer = createAiRacer(spec(id), gates)
  for (let i = 0; i < ticks; i++) stepAiRacer(racer, gates, [], FIXED_DT)
  const b = racer.jet.body
  return {
    x: b.position.x,
    y: b.position.y,
    z: b.position.z,
    speed: Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z),
  }
}

/** A forest of one, standing where the racer will be on tick `ticks`. */
const treeOnTheLine = (ticks: number) => {
  const at = positionAfter(ticks)
  return { at, props: buildPropColliders([tree(at.x, at.y, at.z)], ORIGIN, SPEC) }
}

describe('DEV-147: an AI racer meets the same forest the player does', () => {
  it('strikes a trunk standing on its own line, and pays the preset price for it', () => {
    const { at, props } = treeOnTheLine(200)
    // A racer is well over the break speed here — that is the point of the
    // decision, and it is asserted rather than assumed.
    expect(at.speed).toBeGreaterThan(SPEC.breakSpeed)

    const racer = createAiRacer(spec('fast'), gates)
    let broke = -1
    let speedBefore = 0
    for (let i = 0; i < 260 && broke < 0; i++) {
      const b = racer.jet.body
      speedBefore = Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z)
      stepAiRacer(racer, gates, [], FIXED_DT, null, [], null, {
        colliders: props,
        spec: SPEC,
      })
      if (racer.props.hits.length > 0) broke = i
    }
    expect(broke, 'the racer never reached the trunk on its own line').toBeGreaterThanOrEqual(0)
    const hit = racer.props.hits[0]
    expect(hit?.kind).toBe('tree')
    expect(hit?.broken).toBe(true)
    // DEV-428: the preset's strike — through it, and the trunk STANDS.
    expect(SPEC.strike?.enabled).toBe(true)
    expect(props.broken[0]).toBe(0)
    expect(racer.props.brokenCount).toBe(1)
    // The preset's own slowdown, off the speed the racer had going in.
    const after = Math.hypot(
      racer.jet.body.velocity.x,
      racer.jet.body.velocity.y,
      racer.jet.body.velocity.z,
    )
    expect(after).toBeLessThan(speedBefore)
  })

  it('ONE forest: what a racer struck is what the player meets — standing, or gone with the strike off', () => {
    // The preset (DEV-428) keeps it for the player; DEV-136's removal takes it
    // from the player too. Either way the colliders are shared, which is the
    // property: a second, independent `PropCollisionState` sees the racer's
    // forest.
    for (const [forest, playerMeets] of [
      [SPEC, 1],
      [REMOVING, 0],
    ] as const) {
      const { at, props } = treeOnTheLine(200)
      const racer = createAiRacer(spec('fast'), gates)
      for (let i = 0; i < 260 && racer.props.brokenCount === 0; i++) {
        stepAiRacer(racer, gates, [], FIXED_DT, null, [], null, { colliders: props, spec: forest })
      }
      expect(racer.props.brokenCount).toBe(1)
      expect(props.broken[0]).toBe(1 - playerMeets)

      // The player's own state, the player's own body, parked in the trunk.
      const playerState = createPropCollision()
      const body = createRigidBody({ mass: 4 })
      body.position.x = at.x
      body.position.y = at.y
      body.position.z = at.z
      body.velocity.z = 90
      expect(stepPropCollision(playerState, body, HULL, props, forest)).toBe(playerMeets)
      expect(playerState.hits).toHaveLength(playerMeets)
    }
  })

  it('trap 19: step a SECOND racer and the first has not moved and has not lost its hit', () => {
    const { props } = treeOnTheLine(200)
    const a = createAiRacer(spec('a'), gates)
    const b = createAiRacer(spec('b', AI_RACER_TUNINGS.steady as never), gates)
    const forest = { colliders: props, spec: SPEC }

    // Fly A into the trunk.
    for (let i = 0; i < 260 && a.props.hits.length === 0; i++) {
      stepAiRacer(a, gates, [], FIXED_DT, null, [], null, forest)
    }
    expect(a.props.hits).toHaveLength(1)
    const hit = a.props.hits[0]
    const pose = { ...a.jet.body.position }
    const vel = { ...a.jet.body.velocity }
    const broken = a.props.brokenCount

    // Now step B — a different racer, a different tuning, somewhere else
    // entirely. Nothing of A's may change, and B must report nothing: the
    // trunk is already down, and B is nowhere near it.
    for (let i = 0; i < 40; i++) {
      stepAiRacer(b, gates, [], FIXED_DT, null, [], null, forest)
    }
    expect(b.props.hits).toHaveLength(0)
    expect(b.props.brokenCount).toBe(0)
    expect(b.props).not.toBe(a.props)
    expect(a.props.hits).toHaveLength(1)
    expect(a.props.hits[0]).toBe(hit)
    expect(a.props.brokenCount).toBe(broken)
    expect(a.jet.body.position).toEqual(pose)
    expect(a.jet.body.velocity).toEqual(vel)
  })

  it('a HELD racer reports no hits, so the renderer cannot fracture the same trunk twice', () => {
    // The renderer reads `racer.props.hits` after every step and swaps the
    // instance for its pieces. A crashed racer takes an early return before
    // `stepPropCollision`, so last tick's hit has to be cleared above it —
    // otherwise the hold draws a fresh set of pieces every tick of its 0.55 s.
    const { props } = treeOnTheLine(200)
    const racer = createAiRacer(spec('fast'), gates)
    const forest = { colliders: props, spec: SPEC }
    for (let i = 0; i < 260 && racer.props.hits.length === 0; i++) {
      stepAiRacer(racer, gates, [], FIXED_DT, null, [], null, forest)
    }
    expect(racer.props.hits).toHaveLength(1)

    // What `stepCrash` does on the tick a crash begins.
    racer.crash.phase = 'crashed'
    racer.crash.heldFor = 0
    stepAiRacer(racer, gates, [], FIXED_DT, null, [], CRASH, forest)
    expect(racer.props.hits).toHaveLength(0)
  })

  it('no forest handed in is 2016: the racer flies through everything', () => {
    const { props } = treeOnTheLine(200)
    const racer = createAiRacer(spec('fast'), gates)
    for (let i = 0; i < 260; i++) stepAiRacer(racer, gates, [], FIXED_DT)
    expect(racer.props.hits).toHaveLength(0)
    expect(props.broken[0]).toBe(0)
  })
})

// ── DEV-180: and a racer that CANNOT break one gets off it anyway ──────────
//
// Matt, first worn session (VR-PERF-WAVE-2 F11): *"a racer broke a palm at
// 85 m/s. After a crash reset, racer `fast` bounced off the same palm ~20 times
// at 8-15 m/s, then another palm at 2 m/s"* — for minutes, with a console line
// for every tick of it.
//
// The state was not a mystery about guidance. It is arithmetic: the preset's
// `breakSpeed` is 45 m/s and the two states a racer ends a run in are both
// under it. The fly-out branch sets `throttle = minThrottle`, which cruises at
// 31.4 m/s on `fast` and `cutter` and 44.9 on `steady` and `cruiser`; a crash
// reset arrives at `crash.resetSpeed` 40 with `currentThrust` zeroed. So the
// break branch is CLOSED to that racer, the bounce pushes it out, the
// controller flies it back in, and neither of them is wrong.
//
// Every test below is an A/B against `racerStuckSeconds: 0`, because a racer
// that leaves a tree is not evidence on its own — that is what a racer does
// anyway. The pair is what says the escape did it. *(A rule tested only where
// two explanations agree has not been tested.)*

/** The escape switched OFF: what shipped before DEV-180, for the A/B. */
const NO_ESCAPE: PropCollisionSpec = { ...SPEC, racerStuckSeconds: 0 }

/**
 * A real `gl-palmtree-03` at the middle of its shipped 4-8 scale range: the
 * glTF's own bounds (5.446 tall, base -0.039, 3.286 wide) times 6, which is a
 * 32.7 m crown on a 5.9 m collider. Wider than the 1.8 m trunk above on
 * purpose — the Simonet forest's colliders run 3.9 to 8.9 m and the palm Matt
 * watched is one of them.
 */
const palm = (x: number, y: number, z: number): PropPlacementInput => ({
  x,
  y: y - 16,
  z,
  scale: 6,
  dims: { height: 5.446, base: -0.039, width: 3.286 },
  kind: 'palm',
})

/**
 * A racer with NO GATES is finished on its very first tick — `runIsOver` on a
 * course with no finish sphere is `passed.every(Boolean)`, which is vacuous on
 * an empty list. So this is the fly-out branch reached the way the game
 * reaches it, through `stepAiRacer`, and not by writing `finished = true`.
 */
const flownOut = (id: string, ticks: number, tuning = AI_RACER_TUNINGS.fast as never) => {
  const racer = createAiRacer(spec(id, tuning), [])
  for (let i = 0; i < ticks; i++) stepAiRacer(racer, [], [], FIXED_DT)
  return racer
}

/** Where a finished racer is, and how fast, after `ticks` of flying out. */
const flyOutState = (ticks: number, tuning = AI_RACER_TUNINGS.fast as never) => {
  const b = flownOut('probe', ticks, tuning).jet.body
  return {
    x: b.position.x,
    y: b.position.y,
    z: b.position.z,
    speed: Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z),
  }
}

/**
 * Fly a finished racer into a palm standing on its own fly-out track and
 * report what happened. `spec` is the only thing that differs between the two
 * halves of every A/B below.
 */
const flyOutIntoAPalm = (propSpec: PropCollisionSpec, seconds = 20, id = 'fast') => {
  const REACH = 500
  const at = flyOutState(REACH)
  const props = buildPropColliders([palm(at.x, at.y, at.z)], ORIGIN, propSpec)
  const racer = createAiRacer(spec(id), [])
  let contactTicks = 0
  let firstContact = -1
  let lastContact = -1
  let slowestContact = Number.POSITIVE_INFINITY
  let fastestContact = 0
  let run = 0
  let longestRun = 0
  const total = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < total; i++) {
    stepAiRacer(racer, [], [], FIXED_DT, null, [], null, { colliders: props, spec: propSpec })
    const hit = racer.props.hits[0]
    if (!hit) {
      run = 0
      continue
    }
    contactTicks++
    run++
    longestRun = Math.max(longestRun, run)
    if (firstContact < 0) firstContact = i
    lastContact = i
    slowestContact = Math.min(slowestContact, hit.speed)
    fastestContact = Math.max(fastestContact, hit.speed)
  }
  return {
    racer,
    props,
    at,
    contactTicks,
    firstContact,
    lastContact,
    slowestContact,
    fastestContact,
    /** The longest UNBROKEN contact. What the threshold is measured against. */
    longestRun,
    /** Seconds from the first contact to the last. The whole of the symptom. */
    heldFor: firstContact < 0 ? 0 : (lastContact - firstContact) * FIXED_DT,
    standing: props.broken[0] === 0,
  }
}

describe('DEV-180: the racer that cannot break a prop gets off it anyway', () => {
  it('THE PREMISE: a finished racer cruises below breakSpeed, so no prop can break', () => {
    // Not a detail — it is the whole mechanism, and it is asserted here so that
    // raising `minThrottle` (or lowering `breakSpeed`) says so out loud instead
    // of quietly retiring the tests below.
    const cruises: [string, number][] = []
    for (const [name, tuning] of Object.entries(AI_RACER_TUNINGS)) {
      const b = flownOut(name, 1200, tuning as never).jet.body
      cruises.push([name, Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z)])
    }
    const under = cruises.filter(([, v]) => v < SPEC.breakSpeed)
    expect(
      under.length,
      `no tuning cruises under breakSpeed any more — ${cruises.map(([n, v]) => `${n} ${v.toFixed(1)}`).join(', ')}`,
    ).toBeGreaterThanOrEqual(1)
    // And the one this file flies is one of them.
    const fast = cruises.find(([n]) => n === 'fast')?.[1] as number
    expect(fast).toBeLessThan(SPEC.breakSpeed)
    // The crash reset is under it too, and that one is a straight comparison
    // of two content numbers rather than a measurement.
    expect(CRASH.resetSpeed).toBeLessThan(SPEC.breakSpeed)
  })

  it('WITHOUT the escape it is GROUND TO A HALT: the palm stands and it is scrubbed to a crawl', () => {
    const off = flyOutIntoAPalm(NO_ESCAPE, 20)
    expect(
      off.firstContact,
      'the racer never reached the palm on its fly-out track',
    ).toBeGreaterThanOrEqual(0)
    // Below the break speed, every tick of it — which is why the palm stands.
    expect(off.fastestContact).toBeLessThan(SPEC.breakSpeed)
    expect(off.standing, 'the palm should be unbreakable for this racer').toBe(true)
    // The shape of the lock, and the number the threshold is chosen against: a
    // racer that cannot break a trunk does not glance off it, it LEANS on it
    // for half a second at a time while the bounce scrubs its speed away.
    // Measured at 46-51 consecutive ticks and a low of 0.8-3.4 m/s across four
    // tunings and four approach speeds; asserted loosely, because the point is
    // the order of magnitude against a break's ONE tick.
    expect(off.longestRun, 'the lock should be tens of ticks, not one').toBeGreaterThan(30)
    expect(off.contactTicks).toBeGreaterThan(40)
    expect(off.slowestContact, 'it should be scrubbed to a crawl').toBeLessThan(5)
  })

  it('WITH it the racer is free inside racerStuckSeconds, and the palm is down', () => {
    const on = flyOutIntoAPalm(SPEC, 20)
    expect(on.firstContact).toBeGreaterThanOrEqual(0)
    expect(on.standing, 'the palm should have come down').toBe(false)
    expect(on.racer.props.brokenCount).toBe(1)
    // The escape fires the tick the counter reaches the preset's seconds, so
    // no UNBROKEN contact can outlast it. Total contact can be a tick or two
    // longer than that — the approach clips the crown once or twice before the
    // racer settles against the trunk, and those ticks reset the counter.
    const allowed = Math.ceil(SPEC.racerStuckSeconds / FIXED_DT) + 1
    expect(on.longestRun).toBeLessThanOrEqual(allowed)
    // The A/B: the ONLY thing that differs between the two runs is the number,
    // and the racer meets the palm on the same tick either way — so nothing
    // about the approach changed, only what happened when it arrived.
    const off = flyOutIntoAPalm(NO_ESCAPE, 20)
    expect(on.firstContact).toBe(off.firstContact)
    expect(on.contactTicks).toBeLessThan(off.contactTicks)
  })

  it('A CRASH RESET arrives under the break speed too, and the same escape frees it', () => {
    // The other half of the state, and the one Matt named. A reset puts the
    // racer on its line at `crash.resetSpeed` with the engine cold, so the palm
    // it lands beside is unbreakable for as long as it takes to spool up.
    const at = positionAfter(200)
    const props = buildPropColliders([palm(at.x, at.y, at.z)], ORIGIN, SPEC)
    const racer = createAiRacer(spec('fast'), gates)
    const body = racer.jet.body
    // Exactly what `applyCrashReset` leaves: on the line, level, at resetSpeed,
    // nothing spinning, engine cold — beside the palm rather than through it.
    body.position.x = at.x
    body.position.y = at.y
    body.position.z = at.z
    body.velocity.x = 0
    body.velocity.y = 0
    body.velocity.z = CRASH.resetSpeed
    body.angularVelocity.x = 0
    body.angularVelocity.y = 0
    body.angularVelocity.z = 0
    racer.jet.currentThrust = 0

    let contactTicks = 0
    let maxSpeed = 0
    let run = 0
    let longestRun = 0
    for (let i = 0; i < Math.round(8 / FIXED_DT) && props.broken[0] === 0; i++) {
      stepAiRacer(racer, gates, [], FIXED_DT, null, [], null, { colliders: props, spec: SPEC })
      const hit = racer.props.hits[0]
      if (!hit) {
        run = 0
        continue
      }
      contactTicks++
      run++
      longestRun = Math.max(longestRun, run)
      maxSpeed = Math.max(maxSpeed, hit.speed)
    }
    expect(contactTicks, 'the reset never put the racer on the palm').toBeGreaterThan(0)
    expect(maxSpeed).toBeLessThan(SPEC.breakSpeed)
    expect(props.broken[0], 'the palm should have come down').toBe(1)
    expect(longestRun).toBeLessThanOrEqual(Math.ceil(SPEC.racerStuckSeconds / FIXED_DT) + 1)
  })

  it('a RACING racer is untouched: it breaks at speed, on the first tick, as before', () => {
    // The escape must not be reachable by a racer doing racing speed — it
    // breaks the trunk the tick it touches it, so the counter never gets past
    // one. That ONE tick against the lock's 46-51 is the gap the preset's
    // threshold sits in, and this is the end of it that must not move.
    const { at, props } = treeOnTheLine(200)
    expect(at.speed).toBeGreaterThan(SPEC.breakSpeed)
    // DEV-428: with the strike the trunk STANDS, so the racer is inside it for
    // several ticks rather than one — and none of them may count as a hold.
    // The pass-through is not a contact (`passing`), so the counter stays at 0
    // for the whole passage, and there is exactly one strike.
    const racer = createAiRacer(spec('fast'), gates)
    let strikes = 0
    let mostStuck = 0
    for (let i = 0; i < 260; i++) {
      stepAiRacer(racer, gates, [], FIXED_DT, null, [], null, { colliders: props, spec: SPEC })
      strikes += racer.props.hits.filter((h) => h.broken).length
      mostStuck = Math.max(mostStuck, racer.propStuckFor)
    }
    expect(strikes).toBe(1)
    expect(props.broken[0], 'the trunk stands').toBe(0)
    expect(mostStuck, 'a strike, and the passage after it, is not a hold').toBe(0)
    // And DEV-136's removal, as it always was.
    const removing = treeOnTheLine(200).props
    const other = createAiRacer(spec('fast'), gates)
    for (let i = 0; i < 260 && removing.broken[0] === 0; i++) {
      stepAiRacer(other, gates, [], FIXED_DT, null, [], null, {
        colliders: removing,
        spec: REMOVING,
      })
    }
    expect(removing.broken[0]).toBe(1)
    expect(other.propStuckFor, 'a break is not a hold').toBe(0)
  })

  it('trap 19: `propStuckFor` is PER RACER — step a SECOND one and the first keeps its count', () => {
    // A running total across ticks, which is the shape that has already leaked
    // three times in `ai-racer.ts`. The failure that hides is the one only two
    // objects can show: a SHARED counter is reset by every tick the other racer
    // spends in clear air, so the stuck one never reaches the threshold and
    // never escapes — exactly the bug this row is about, wearing a disguise.
    const at = flyOutState(500)
    const props = buildPropColliders([palm(at.x, at.y, at.z)], ORIGIN, SPEC)
    const forest = { colliders: props, spec: SPEC }
    const a = createAiRacer(spec('a'), [])
    // Somewhere else entirely, and it never touches anything.
    const b = createAiRacer(
      {
        ...spec('b', AI_RACER_TUNINGS.steady as never),
        spawn: v3(SPAWN.x + 4000, SPAWN.y, SPAWN.z),
      },
      [],
    )
    // Fly A onto the palm and stop the tick it is in contact.
    let i = 0
    for (; i < Math.round(20 / FIXED_DT) && a.props.hits.length === 0; i++) {
      stepAiRacer(a, [], [], FIXED_DT, null, [], null, forest)
    }
    expect(a.props.hits, 'A never reached the palm').toHaveLength(1)
    expect(a.propStuckFor).toBeCloseTo(FIXED_DT, 6)
    const held = a.propStuckFor
    const pose = { ...a.jet.body.position }

    // Now step B for a while. It is in clear air, so a SHARED counter would be
    // zeroed by it and A would never escape.
    for (let j = 0; j < 40; j++) stepAiRacer(b, [], [], FIXED_DT, null, [], null, forest)
    expect(b.props.hits).toHaveLength(0)
    expect(b.propStuckFor).toBe(0)
    expect(a.propStuckFor, 'B zeroed A’s counter — trap 19 again').toBe(held)
    expect(a.jet.body.position).toEqual(pose)
    expect(props.broken[0]).toBe(0)

    // And A still escapes, with B stepped between every one of its ticks —
    // the interleaving `game/racers.ts` actually runs. Well inside the 1.3 s
    // the lock takes when nothing frees it.
    for (let j = 0; j < Math.round(2 / FIXED_DT) && props.broken[0] === 0; j++) {
      stepAiRacer(a, [], [], FIXED_DT, null, [], null, forest)
      stepAiRacer(b, [], [], FIXED_DT, null, [], null, forest)
    }
    expect(props.broken[0], 'A never got off the palm with B stepping beside it').toBe(1)
    expect(a.props.brokenCount).toBe(1)
    expect(b.props.brokenCount, 'B was credited with A’s tree').toBe(0)
  })

  it('a reset clears the count, so the next prop is not broken early', () => {
    // `afterRacerReset` and `game/racers.ts`'s `reset` both clear it. Carried
    // over, it is most of a second of contact a racer would spend against
    // something it has not touched yet.
    const at = flyOutState(500)
    const props = buildPropColliders([palm(at.x, at.y, at.z)], ORIGIN, SPEC)
    const forest = { colliders: props, spec: SPEC }
    const racer = createAiRacer(spec('fast'), [])
    // Fly it until the counter has actually built up some contact — the
    // approach clips the crown a tick at a time before the racer settles, and
    // a single clipped tick is zeroed again on the next.
    for (let i = 0; i < Math.round(20 / FIXED_DT) && racer.propStuckFor < FIXED_DT * 3; i++) {
      stepAiRacer(racer, [], [], FIXED_DT, null, [], null, forest)
    }
    expect(racer.propStuckFor, 'the racer never settled on the palm').toBeGreaterThan(FIXED_DT)
    racer.crash.phase = 'crashed'
    racer.crash.heldFor = CRASH.holdSeconds
    stepAiRacer(racer, [], [], FIXED_DT, null, [], CRASH, forest)
    expect(racer.crashEvent).toBe('reset')
    expect(racer.propStuckFor).toBe(0)
  })
})
