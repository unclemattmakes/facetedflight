// tests/unit/racer-contact.test.ts — the racers keep apart, and you can push
// them. DEV-364.
//
// Matt, 2026-09-24: *"right now our ai racers tend to converge on the same path
// - can you have them avoid each other (or give collision so we can push them)
// - right now players can fly straight into them and through them."*
//
// Every property here is measured against something OUTSIDE the rule — the
// line (for lanes), the hull on the constants sheet (for the volume), the sum
// of momentum (for the push), a second run (for determinism), and the plain
// per-racer loop the field replaced (for Classic). None of them compares the
// rule with a re-derivation of itself.
//
// Headless on `int_01`'s real course and line, with no terrain: the terrain
// changes where a racer can fly, not whether two of them separate.

import { describe, expect, it } from 'vitest'
import { type Edition, validateEdition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { courseGates } from '@/game/mission'
import { racerStarts } from '@/game/racer-grid'
import { assignTunings } from '@/game/racers'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import {
  AI_RACER_TUNINGS,
  type AiRacer,
  createAiRacer,
  gateArcLengths,
  seedRacerAt,
  stepAiRacer,
} from '@/sim/ai-racer'
import { FIXED_DT } from '@/sim/constants'
import {
  type CraftContactSpec,
  craftGap,
  HOVERJET_CRAFT_VOLUME,
  resolveCraftContacts,
} from '@/sim/craft-contact'
import { createHoverJet, type HoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import { lookAlong } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'
import { createRacerField, NO_FIELD_RULES, stepRacerField } from '@/sim/racer-field'
import { createRoute, routeAt, routeRightAt, routeTangentAt } from '@/sim/route'
import { HOVERJET_GROUND } from '@/sim/terrain-collision'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

const ANNIVERSARY: Edition = validateEdition(anniversaryJson as unknown as Edition)
const CLASSIC: Edition = validateEdition(classicJson as unknown as Edition)
const SEPARATION = ANNIVERSARY.gameplay.racers.separation
const CONTACT = ANNIVERSARY.gameplay.racers.contact
const CRASH = ANNIVERSARY.gameplay.crash

const LEVEL = int01 as unknown as Level
const GATES = courseGates(LEVEL)
const ROUTE = createRoute((int01 as unknown as { route: number[][] }).route)
const GUIDE = { route: ROUTE, gateArc: gateArcLengths(ROUTE, GATES) }
const VOLUME = HOVERJET_CRAFT_VOLUME

/** Where a body is across the LINE, metres right, at its own arc length. */
const lateralOf = (racer: AiRacer): number => {
  const s = racer.cursor.s
  const on = routeAt(ROUTE, s, v3())
  const right = routeRightAt(ROUTE, s, v3())
  const p = racer.jet.body.position
  return (p.x - on.x) * right.x + (p.z - on.z) * right.z
}

/** The player's spawn, launched, in sim space — a body placed where the game places it. */
const spawnPoint = () => {
  const p = threeTupleToUnity(v3(), LEVEL.spawn.pos as number[])
  p.y += LEVEL.spawn.launch?.rise ?? 0
  const q = { x: 0, y: 0, z: 0, w: 1 }
  threeQuatTupleToUnity(q, LEVEL.spawn.quat as number[])
  return { p, q }
}

/** The preset's grid on `int_01`, in sim space, with its finish — `racers.ts`'s recipe. */
const grid = (edition: Edition): AiRacer[] => {
  const starts = racerStarts(LEVEL, edition.gameplay.racers)
  const assigned = assignTunings(starts)
  return starts.map((start, i) => {
    const { id, tuning } = assigned[i] as { id: string; tuning: string }
    const spawn = threeTupleToUnity(v3(), [start.pos[0], start.pos[1], start.pos[2]])
    const q = { x: 0, y: 0, z: 0, w: 1 }
    threeQuatTupleToUnity(q, start.quat as unknown as number[])
    return createAiRacer(
      {
        id,
        spawn,
        orientation: [q.x, q.y, q.z, q.w],
        tuning: AI_RACER_TUNINGS[tuning] as (typeof AI_RACER_TUNINGS)[string],
      },
      GATES,
    )
  })
}

/** A HoverJet flying straight, nose down the line at arc length `s`, at `speed`. */
const playerOnLine = (s: number, speed: number): HoverJet => {
  const jet = createHoverJet()
  jet.launched = true
  routeAt(ROUTE, s, jet.body.position)
  const dir = routeTangentAt(ROUTE, s, v3())
  lookAlong(jet.body.orientation, dir)
  jet.body.velocity.x = dir.x * speed
  jet.body.velocity.y = dir.y * speed
  jet.body.velocity.z = dir.z * speed
  return jet
}

describe('the craft volume is the sheet’s hull', () => {
  it('is a capsule half the collider beam wide and the collider length long', () => {
    // Measured off `hoverjet.shipCollisionColliders`, composed: a 4.435 m beam
    // and a 4.893 m length (the row and `craft-contact.ts`'s header quote
    // these; this is the test that keeps them true).
    expect(VOLUME.radius * 2).toBeCloseTo(4.435, 2)
    expect(VOLUME.fore - VOLUME.aft + VOLUME.radius * 2).toBeCloseTo(4.893, 2)
    // And the header's tunnelling bound, `2r / dt`.
    expect((VOLUME.radius * 2) / FIXED_DT).toBeGreaterThan(363)
    expect((VOLUME.radius * 2) / FIXED_DT).toBeLessThan(364)
  })

  it('holds every sphere the ground and the forest meet — one hull, not two', () => {
    // A relationship, not a value: the capsule must contain the hull the
    // terrain rule already uses, or a ship could be touched by a hillside
    // somewhere another ship cannot touch it.
    for (const s of HOVERJET_GROUND.collision.hull) {
      const z = Math.max(VOLUME.aft, Math.min(VOLUME.fore, s.z))
      const d = Math.hypot(s.x - VOLUME.x, s.y - VOLUME.y, s.z - z)
      expect(d + s.radius).toBeLessThanOrEqual(VOLUME.radius + 1e-9)
    }
  })
})

describe('two racers on one line separate', () => {
  /** Two `steady`s, one 25 m behind the other on the same line; mean |dLat| once under way. */
  const pair = (rules: Parameters<typeof stepRacerField>[9]) => {
    const { p, q } = spawnPoint()
    const behind = routeTangentAt(ROUTE, 0, v3())
    const make = (back: number) =>
      createAiRacer(
        {
          id: `steady-${back}`,
          spawn: v3(p.x - behind.x * back, p.y, p.z - behind.z * back),
          orientation: [q.x, q.y, q.z, q.w],
          tuning: AI_RACER_TUNINGS.steady as (typeof AI_RACER_TUNINGS)[string],
        },
        GATES,
      )
    const racers = [make(0), make(25)]
    const field = createRacerField(racers, ROUTE)
    let sum = 0
    let n = 0
    for (let t = 0; t < Math.round(40 / FIXED_DT); t++) {
      stepRacerField(field, racers, GATES, [], FIXED_DT, GUIDE, [], null, null, rules)
      const [a, b] = racers as [AiRacer, AiRacer]
      // Once both are past the lane's ease, and while both are racing.
      if (a.cursor.s < SEPARATION.laneEaseMetres || b.cursor.s < SEPARATION.laneEaseMetres) continue
      if (a.finished || b.finished) continue
      sum += Math.abs(lateralOf(a) - lateralOf(b))
      n++
    }
    return { mean: sum / n, racers }
  }

  it('by LANES: a lane apart, where the one line kept them on top of each other', () => {
    const apart = pair({ separation: SEPARATION, contact: null, player: null })
    const together = pair(NO_FIELD_RULES)
    // The control first: without the rule they fly one path, a lag apart.
    expect(together.mean, `one line: ${together.mean.toFixed(2)} m`).toBeLessThan(2)
    // With it, ranks -1/2 and +1/2: one `laneSpacing` apart, less what the
    // rings take back.
    expect(apart.mean, `lanes: ${apart.mean.toFixed(2)} m`).toBeGreaterThan(
      SEPARATION.laneSpacing * 0.7,
    )
    expect(apart.racers.map((r) => r.laneRank).sort()).toEqual([-0.5, 0.5])
  })

  it('by AVOIDANCE alone: two racers given one lane still do not share it', () => {
    // Lane spacing zero puts both on the line; what separates them now is the
    // steering off each other, and nothing else.
    const apart = pair({
      separation: { ...SEPARATION, laneSpacing: 0 },
      contact: null,
      player: null,
    })
    expect(apart.mean, `avoidance: ${apart.mean.toFixed(2)} m`).toBeGreaterThan(3)
  })
})

describe('a racer keeps off what is AHEAD, and can be caught from behind', () => {
  /** One racer on the line past ring 1, a player body 20 m off its nose or its tail. */
  const avoidOf = (along: number): number => {
    const racer = createAiRacer(
      {
        id: 'steady',
        spawn: v3(),
        orientation: [0, 0, 0, 1],
        tuning: AI_RACER_TUNINGS.steady as (typeof AI_RACER_TUNINGS)[string],
      },
      GATES,
    )
    const s0 = (GUIDE.gateArc[1] as number) + 150
    seedRacerAt(racer, GUIDE, s0, 90)
    const player = playerOnLine(s0 + along, 90)
    const field = createRacerField([racer], ROUTE)
    stepRacerField(field, [racer], GATES, [], FIXED_DT, GUIDE, [], null, null, {
      separation: SEPARATION,
      contact: null,
      player: player.body,
    })
    return racer.avoid
  }

  it('steers off a craft on its line ahead, and not off the same craft behind', () => {
    // The car behind owns the pass. A racer that slid away from whatever came
    // up behind it could never be caught — the first in-game cut dodged the
    // player's every approach, and "so we can push them" is half of the ask.
    expect(Math.abs(avoidOf(20))).toBeGreaterThan(1)
    expect(avoidOf(-20)).toBe(0)
  })
})

describe('a player flying into a racer pushes it', () => {
  /**
   * `steady` put on the line at 60 m/s past ring 1, and a boosted player 60 m
   * behind it on the same line at 160 m/s, flying straight: 100 m/s of closing
   * speed, more than twice the crash rule's threshold. Separation OFF, so the
   * racer does not dodge — this is the contact alone.
   */
  const ram = (contact: CraftContactSpec | null) => {
    const racer = createAiRacer(
      {
        id: 'steady',
        spawn: v3(),
        orientation: [0, 0, 0, 1],
        tuning: AI_RACER_TUNINGS.steady as (typeof AI_RACER_TUNINGS)[string],
      },
      GATES,
    )
    const s0 = (GUIDE.gateArc[1] as number) + 90
    seedRacerAt(racer, GUIDE, s0, 60)
    const player = playerOnLine(s0 - 60, 160)
    const input = { ...noInput(), throttle: 1, boost: true }
    const field = createRacerField([racer], ROUTE)
    const heading = routeTangentAt(ROUTE, s0, v3())
    const log = {
      minGap: Number.POSITIVE_INFINITY,
      minAhead: Number.POSITIVE_INFINITY,
      hardest: 0,
      pushed: 0,
      crashed: 0,
    }
    for (let t = 0; t < Math.round(3 / FIXED_DT); t++) {
      const before = Math.hypot(
        racer.jet.body.velocity.x,
        racer.jet.body.velocity.y,
        racer.jet.body.velocity.z,
      )
      stepHoverJet(player, input, FIXED_DT)
      stepRacerField(field, [racer], GATES, [], FIXED_DT, GUIDE, [], CRASH, null, {
        separation: null,
        contact,
        player: player.body,
      })
      if (racer.crashEvent === 'crashed') log.crashed++
      const v = racer.jet.body.velocity
      log.pushed = Math.max(log.pushed, Math.hypot(v.x, v.y, v.z) - before)
      log.hardest = Math.max(log.hardest, field.contact.hardest)
      log.minGap = Math.min(log.minGap, craftGap(player.body, racer.jet.body, VOLUME))
      const r = racer.jet.body.position
      const p = player.body.position
      // How far AHEAD of the player the racer is, along the line — counted
      // only while their tracks overlap, a beam or less apart across it. A
      // player that passes a beam to one side has flown PAST, not through;
      // one that is ahead while still inside that beam came out the far side.
      const dx = r.x - p.x
      const dy = r.y - p.y
      const dz = r.z - p.z
      const along = dx * heading.x + dy * heading.y + dz * heading.z
      const across = Math.hypot(
        dx - along * heading.x,
        dy - along * heading.y,
        dz - along * heading.z,
      )
      if (across < VOLUME.radius * 2) log.minAhead = Math.min(log.minAhead, along)
    }
    return { log, racer, report: field.contact }
  }

  it('shoves it ahead, neither passes through the other, and nobody crashes', () => {
    const { log, racer, report } = ram(CONTACT)
    // It was a HARD hit — harder than the crash rule's threshold …
    expect(log.hardest).toBeGreaterThan(CRASH.minImpactSpeed)
    // … and the running totals a probe reads saw it (a frame spans more than
    // one tick, so the per-tick fields alone can miss it).
    expect(report.total).toBeGreaterThan(0)
    expect(report.hardestEver).toBe(log.hardest)
    // … and it pushed: the racer gained tens of m/s in one tick.
    expect(log.pushed).toBeGreaterThan(20)
    // Never inside each other, after the contact pass, on any tick.
    expect(log.minGap).toBeGreaterThanOrEqual(-1e-9)
    // And the player never came out the other side.
    expect(log.minAhead).toBeGreaterThan(0)
    // Nobody crashed: a craft contact is not a terrain impact.
    expect(log.crashed).toBe(0)
    expect(racer.crash.count).toBe(0)
  })

  it('without contact the player flies straight through it — the bug', () => {
    const { log } = ram(null)
    expect(log.minGap).toBeLessThan(-VOLUME.radius)
    expect(log.minAhead).toBeLessThan(0)
  })
})

describe('the push itself', () => {
  const two = () => {
    const a = createHoverJet().body
    const b = createHoverJet().body
    a.position.z = 0
    b.position.z = VOLUME.fore - VOLUME.aft + VOLUME.radius * 2 - 0.5
    b.position.x = 0.7
    a.velocity.z = 150
    b.velocity.z = 90
    b.velocity.x = -3
    return { a, b }
  }

  it('conserves momentum exactly, whatever the restitution', () => {
    for (const restitution of [0, 0.5, 1]) {
      const { a, b } = two()
      const before = {
        x: a.mass * a.velocity.x + b.mass * b.velocity.x,
        y: a.mass * a.velocity.y + b.mass * b.velocity.y,
        z: a.mass * a.velocity.z + b.mass * b.velocity.z,
      }
      const n = resolveCraftContacts([a, b], VOLUME, { ...CONTACT, restitution })
      expect(n).toBeGreaterThan(0)
      expect(a.mass * a.velocity.x + b.mass * b.velocity.x).toBeCloseTo(before.x, 9)
      expect(a.mass * a.velocity.y + b.mass * b.velocity.y).toBeCloseTo(before.y, 9)
      expect(a.mass * a.velocity.z + b.mass * b.velocity.z).toBeCloseTo(before.z, 9)
      expect(craftGap(a, b, VOLUME)).toBeGreaterThanOrEqual(-1e-9)
    }
  })

  it('parts two craft put on ONE point — a teleport — along +x, and fully', () => {
    // Coincident axes have no nearest-point direction; the rule falls back to
    // world +x rather than dividing by zero, and the overlap is the whole
    // diameter, not whatever the fallback's centre distance happens to be.
    const a = createHoverJet().body
    const b = createHoverJet().body
    resolveCraftContacts([a, b], VOLUME, CONTACT)
    expect(craftGap(a, b, VOLUME)).toBeGreaterThanOrEqual(-1e-9)
    expect(b.position.x - a.position.x).toBeCloseTo(VOLUME.radius * 2, 9)
    expect(Number.isFinite(a.position.x) && Number.isFinite(b.position.x)).toBe(true)
  })

  it('writes position and velocity, and NOTHING else — so it cannot reach a crash', () => {
    const { a, b } = two()
    const keep = (body: typeof a) =>
      JSON.stringify({
        o: body.orientation,
        w: body.angularVelocity,
        f: body.force,
        t: body.torque,
        m: body.mass,
        d: body.drag,
        ad: body.angularDrag,
        g: body.useGravity,
      })
    const beforeA = keep(a)
    const beforeB = keep(b)
    resolveCraftContacts([a, b], VOLUME, CONTACT)
    expect(keep(a)).toBe(beforeA)
    expect(keep(b)).toBe(beforeB)
  })
})

describe('two craft flying side by side, touching, stay put', () => {
  it('lean on each other at the fixed step: no bounce, no sinking, no jitter', () => {
    // Two HoverJets abreast at 150 m/s, a hair inside each other, each pushed
    // toward the other at 3 m/s^2 every tick the way a controller holding a
    // lane into its neighbour would. The contact must hold them touching —
    // not overlapping, not bouncing apart and back.
    const a = createHoverJet()
    const b = createHoverJet()
    for (const j of [a, b]) {
      j.launched = true
      j.body.velocity.z = 150
    }
    a.body.position.x = -VOLUME.radius + 0.1
    b.body.position.x = VOLUME.radius - 0.1
    // Closing at 4 m/s — a controller steering into its neighbour, and under
    // `restingSpeed`, which is the case the threshold exists for: without it
    // this bounces them apart and the squeeze brings them back, over and over.
    a.body.velocity.x = 2
    b.body.velocity.x = -2
    const cruise = { ...noInput(), throttle: 0.5 }
    const squeeze = 3
    const gaps: number[] = []
    const lateral: number[] = []
    for (let t = 0; t < Math.round(5 / FIXED_DT); t++) {
      stepHoverJet(a, cruise, FIXED_DT)
      stepHoverJet(b, cruise, FIXED_DT)
      a.body.velocity.x += squeeze * FIXED_DT
      b.body.velocity.x -= squeeze * FIXED_DT
      resolveCraftContacts([a.body, b.body], VOLUME, CONTACT)
      gaps.push(craftGap(a.body, b.body, VOLUME))
      lateral.push(b.body.velocity.x - a.body.velocity.x)
    }
    // Never inside each other …
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(-1e-9)
    // … and never bounced apart: the gap stays under a centimetre.
    expect(Math.max(...gaps)).toBeLessThan(0.01)
    // And the relative lateral speed never builds: no bounce, no chatter.
    expect(Math.max(...lateral.map(Math.abs))).toBeLessThan(CONTACT.restingSpeed)
  })
})

describe('the same inputs give the same race', () => {
  /** The Anniversary grid of five and a player body, 20 s, both rules on. */
  const run = () => {
    const racers = grid(ANNIVERSARY)
    const field = createRacerField(racers, ROUTE)
    const { p, q } = spawnPoint()
    const player = createHoverJet()
    player.launched = true
    player.body.position.x = p.x
    player.body.position.y = p.y
    player.body.position.z = p.z
    Object.assign(player.body.orientation, q)
    const input = { ...noInput(), throttle: 1, boost: true }
    let avoided = 0
    for (let t = 0; t < Math.round(20 / FIXED_DT); t++) {
      stepHoverJet(player, input, FIXED_DT)
      stepRacerField(field, racers, GATES, [], FIXED_DT, GUIDE, [], CRASH, null, {
        separation: SEPARATION,
        contact: CONTACT,
        player: player.body,
      })
      if (racers.some((r) => r.avoid !== 0)) avoided++
    }
    return {
      avoided,
      state: [...racers.map((r) => r.jet.body), player.body].map((b) => [
        b.position.x,
        b.position.y,
        b.position.z,
        b.velocity.x,
        b.velocity.y,
        b.velocity.z,
      ]),
    }
  }

  it('to the last bit, twice', () => {
    const one = run()
    const two = run()
    // The rule was exercised, or this proves nothing about it.
    expect(one.avoided).toBeGreaterThan(0)
    expect(two.state).toEqual(one.state)
  })
})

describe('Classic does not move by a bit', () => {
  it('with both rules off, the field IS the per-racer loop it replaced', () => {
    const plain = grid(CLASSIC)
    const fielded = grid(CLASSIC)
    const viaPreset = grid(CLASSIC)
    const field = createRacerField(fielded, ROUTE)
    const presetField = createRacerField(viaPreset, ROUTE)
    const bystander = createHoverJet()
    const { p } = spawnPoint()
    bystander.body.position.x = p.x
    bystander.body.position.y = p.y
    bystander.body.position.z = p.z
    for (let t = 0; t < Math.round(20 / FIXED_DT); t++) {
      for (const r of plain) stepAiRacer(r, GATES, [], FIXED_DT, GUIDE, [], null, null)
      stepRacerField(field, fielded, GATES, [], FIXED_DT, GUIDE, [], null, null, NO_FIELD_RULES)
      // Classic's own preset, with a player in the air: both flags are off.
      stepRacerField(presetField, viaPreset, GATES, [], FIXED_DT, GUIDE, [], null, null, {
        separation: CLASSIC.gameplay.racers.separation,
        contact: CLASSIC.gameplay.racers.contact,
        player: bystander.body,
      })
    }
    const state = (rs: AiRacer[]) => rs.map((r) => [r.jet.body.position, r.jet.body.velocity])
    expect(state(fielded)).toEqual(state(plain))
    expect(state(viaPreset)).toEqual(state(plain))
    expect(CLASSIC.gameplay.racers.separation.enabled).toBe(false)
    expect(CLASSIC.gameplay.racers.contact.enabled).toBe(false)
  })

  it('and Anniversary ships both on', () => {
    expect(ANNIVERSARY.gameplay.racers.separation.enabled).toBe(true)
    expect(ANNIVERSARY.gameplay.racers.contact.enabled).toBe(true)
  })
})

// ── DEV-391: a room's other players, in the racers' picture ─────────────────
//
// A room's bots are flown by one client, the host, off one picture — the host
// itself as `player`, every other human where the host draws them as
// `others` (plan/MULTIPLAYER.md §6.6). Avoided, never pushed: a room has no
// contact (§6.7). The first gate is the one the plan names: single player
// does not move by a bit (red: change the order the field steps in).
describe('DEV-391: other players in the picture', () => {
  const race = (others: number) => {
    const racers = grid(ANNIVERSARY)
    const field = createRacerField(racers, ROUTE, VOLUME, others)
    const { p, q } = spawnPoint()
    const player = createHoverJet()
    player.launched = true
    Object.assign(player.body.position, p)
    Object.assign(player.body.orientation, q)
    const input = { ...noInput(), throttle: 1, boost: true }
    for (let t = 0; t < Math.round(20 / FIXED_DT); t++) {
      stepHoverJet(player, input, FIXED_DT)
      stepRacerField(field, racers, GATES, [], FIXED_DT, GUIDE, [], CRASH, null, {
        separation: SEPARATION,
        contact: CONTACT,
        player: player.body,
      })
    }
    return racers.map((r) => [r.jet.body.position.x, r.jet.body.position.y, r.jet.body.position.z])
  }

  it('a field with room for five others and none in it races single player to the bit', () => {
    expect(race(5)).toEqual(race(0))
  })

  it('steers off another player ahead as off the player, and pushes neither', () => {
    const avoidOf = (who: 'player' | 'other') => {
      const racer = createAiRacer(
        {
          id: 'steady',
          spawn: v3(),
          orientation: [0, 0, 0, 1],
          tuning: AI_RACER_TUNINGS.steady as (typeof AI_RACER_TUNINGS)[string],
        },
        GATES,
      )
      const s0 = (GUIDE.gateArc[1] as number) + 150
      seedRacerAt(racer, GUIDE, s0, 90)
      const ahead = playerOnLine(s0 + 20, 90)
      const before = { ...ahead.body.position }
      const field = createRacerField([racer], ROUTE, VOLUME, 1)
      stepRacerField(field, [racer], GATES, [], FIXED_DT, GUIDE, [], null, null, {
        separation: SEPARATION,
        contact: null,
        player: who === 'player' ? ahead.body : null,
        others: who === 'other' ? [ahead.body.position] : null,
      })
      // A position in the picture, never a body: nothing moved it.
      expect(ahead.body.position).toEqual(before)
      return racer.avoid
    }
    const other = avoidOf('other')
    expect(Math.abs(other)).toBeGreaterThan(1)
    expect(other).toBe(avoidOf('player'))
  })
})
