// tests/unit/racer-hit.test.ts — a racer's hit COSTS the player something.
// The DEV-364 follow-up.
//
// Matt, 2026-09-25: *"sound and physics cost - nudge the players as if they got
// hit"*. Every property is measured against something outside the rule: the
// SAME flight with the hit switched off (for what the hit adds), the ship's own
// nose and canopy vectors after the fact (for which way it was knocked — the
// geometry, never a quaternion), the event map and the cue catalogue (for the
// sound), and the plain loop (for Classic).

import { describe, expect, it } from 'vitest'
import { CUES } from '@/audio/cues'
import { actionsForEvent } from '@/audio/events'
import { type Edition, validateEdition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { createShakeSample, sampleCockpitShake } from '@/game/cockpit-shake'
import { courseGates } from '@/game/mission'
import { createHitJolt, hitJoltGain, takeRacerHit } from '@/game/racer-hit'
import { AI_RACER_TUNINGS, createAiRacer, gateArcLengths, seedRacerAt } from '@/sim/ai-racer'
import { FIXED_DT } from '@/sim/constants'
import {
  type CraftContactSpec,
  craftGap,
  createCraftContactReport,
  HOVERJET_CRAFT_VOLUME,
  resolveCraftContacts,
} from '@/sim/craft-contact'
import {
  applyCraftHit,
  type CraftHitSpec,
  craftHitStrength,
  createCraftHitReport,
} from '@/sim/craft-hit'
import { createHoverJet, type HoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import { lookAlong, rotateVec3 } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { createRacerField, NO_FIELD_RULES, stepRacerField } from '@/sim/racer-field'
import type { RigidBody } from '@/sim/rigidbody'
import { createRoute, routeAt, routeTangentAt } from '@/sim/route'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

const ANNIVERSARY: Edition = validateEdition(anniversaryJson as unknown as Edition)
const CLASSIC: Edition = validateEdition(classicJson as unknown as Edition)
const CONTACT = ANNIVERSARY.gameplay.racers.contact
const HIT = ANNIVERSARY.gameplay.racers.hit
const CRASH = ANNIVERSARY.gameplay.crash
const SHAKE = ANNIVERSARY.cockpit.shake

const LEVEL = int01 as unknown as Level
const GATES = courseGates(LEVEL)
const ROUTE = createRoute((int01 as unknown as { route: number[][] }).route)
const GUIDE = { route: ROUTE, gateArc: gateArcLengths(ROUTE, GATES) }
const VOLUME = HOVERJET_CRAFT_VOLUME

const speedOf = (b: RigidBody): number => Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z)
/** The ship's own nose and canopy, world space. */
const nose = (b: RigidBody): Vec3 => rotateVec3(v3(), b.orientation, v3(0, 0, 1))
const canopy = (b: RigidBody): Vec3 => rotateVec3(v3(), b.orientation, v3(0, 1, 0))
const snapshot = (b: RigidBody) =>
  JSON.stringify([b.position, b.velocity, b.orientation, b.angularVelocity])

// ── 1. The law, on two bodies, measured as geometry ─────────────────────────

describe('a side hit: the speed scrubbed, the nose and the canopy knocked toward the push', () => {
  /**
   * The player cruising +z at 150 m/s and sliding RIGHT into a ship beside it
   * at 20 m/s of closing speed. The push throws the player LEFT (-x). Then
   * both fly on, hands off, for half a second; the same flight with the hit
   * off is the control.
   */
  const sideHit = (hit: CraftHitSpec | null) => {
    const player = createHoverJet()
    const other = createHoverJet()
    for (const j of [player, other]) {
      j.launched = true
      j.body.velocity.z = 150
    }
    other.body.position.x = VOLUME.radius * 2 - 0.2
    player.body.velocity.x = 15
    other.body.velocity.x = -5
    const report = createCraftContactReport()
    const hitReport = createCraftHitReport()
    resolveCraftContacts([player.body, other.body], VOLUME, CONTACT, report)
    const closing = report.impact[0] as number
    const pushed = v3(report.away[0], report.away[1], report.away[2])
    const speedAfterPush = speedOf(player.body)
    const s = hit
      ? applyCraftHit(player.body, closing, pushed.x, pushed.y, pushed.z, hit, hitReport)
      : 0
    const speedAfterHit = speedOf(player.body)
    const cruise = { ...noInput(), throttle: 1 }
    for (let t = 0; t < Math.round(0.5 / FIXED_DT); t++) stepHoverJet(player, cruise, FIXED_DT)
    return {
      closing,
      pushed,
      s,
      speedAfterPush,
      speedAfterHit,
      hitReport,
      nose: nose(player.body),
      canopy: canopy(player.body),
    }
  }

  it('is a hit: 20 m/s of closing speed, pushed straight left', () => {
    const { closing, pushed } = sideHit(null)
    expect(closing).toBeCloseTo(20, 9)
    expect(pushed.x).toBeCloseTo(-1, 9)
  })

  it('takes scrub x strength of the speed, on top of the push', () => {
    const on = sideHit(HIT)
    const off = sideHit(null)
    expect(on.s).toBeCloseTo(craftHitStrength(HIT, 20), 12)
    expect(on.s).toBeGreaterThan(0)
    expect(on.speedAfterPush).toBe(off.speedAfterPush)
    expect(on.speedAfterHit / on.speedAfterPush).toBeCloseTo(1 - HIT.scrub * on.s, 12)
    expect(on.hitReport.struck).toBe(true)
    expect(on.hitReport.total).toBe(1)
  })

  it('swings the nose toward the push (left) and tips the canopy the same way', () => {
    const on = sideHit(HIT)
    const off = sideHit(null)
    // Without the hit the ship flies on as the push left it: nose and canopy
    // where they were, to the float.
    expect(off.nose.x).toBeCloseTo(0, 9)
    expect(off.canopy.x).toBeCloseTo(0, 9)
    // With it, the nose has turned LEFT — a heading, in degrees — and the top
    // of the canopy has gone left too: the left wing is down, the right (the
    // struck side) up.
    const headingDeg = (Math.asin(-on.nose.x) * 180) / Math.PI
    const bankDeg = (Math.asin(-on.canopy.x) * 180) / Math.PI
    expect(headingDeg, `heading ${headingDeg.toFixed(2)} deg`).toBeGreaterThan(1)
    expect(bankDeg, `bank ${bankDeg.toFixed(2)} deg`).toBeGreaterThan(2)
    // And the nose hardly climbed or dived: a side hit KICKS no pitch. What
    // is there is the yaw and the roll composing (rotations do not commute),
    // and it is a small fraction of the heading.
    expect(Math.abs(on.nose.y)).toBeLessThan(Math.abs(on.nose.x) * 0.2)
    console.info(
      `side hit at 20 m/s: heading ${headingDeg.toFixed(2)} deg, bank ${bankDeg.toFixed(2)} deg, pitch ${((Math.asin(on.nose.y) * 180) / Math.PI).toFixed(2)} deg after 0.5 s`,
    )
  })

  it("the preset note's numbers: a straight rear-end at the game's measured 20.9 m/s", () => {
    // `anniversary.json` quotes these, so they are held here (DEV-027: a
    // derived number needs a test). The rammer, flying +z, pushed straight
    // back (-z), hands off for three seconds against the same flight unhit.
    const flown = (spec: CraftHitSpec | null) => {
      const jet = createHoverJet()
      jet.launched = true
      jet.body.velocity.z = 150
      const before = speedOf(jet.body)
      if (spec) applyCraftHit(jet.body, 20.9, 0, 0, -1, spec)
      const lost = 1 - speedOf(jet.body) / before
      const cruise = { ...noInput(), throttle: 1 }
      const half = Math.round(0.5 / FIXED_DT)
      let atHalf = 0
      for (let t = 0; t < Math.round(3 / FIXED_DT); t++) {
        stepHoverJet(jet, cruise, FIXED_DT)
        if (t + 1 === half) atHalf = Math.asin(nose(jet.body).y)
      }
      const deg = (r: number) => (r * 180) / Math.PI
      return { lost, upDeg: deg(Math.asin(nose(jet.body).y)), halfDeg: deg(atHalf) }
    }
    const hit = flown(HIT)
    expect(flown(null).upDeg).toBeCloseTo(0, 9)
    expect(hit.lost).toBeCloseTo(0.076, 3)
    expect(hit.upDeg, `nose up ${hit.upDeg.toFixed(2)} deg`).toBeGreaterThan(10)
    expect(hit.upDeg).toBeLessThan(12)
    // "Most of it inside half a second."
    expect(hit.halfDeg / hit.upDeg).toBeGreaterThan(0.5)
  })

  it('under minSpeed is a lean, not a hit: nothing written', () => {
    const body = createHoverJet().body
    body.velocity.z = 150
    const before = snapshot(body)
    const report = createCraftHitReport()
    expect(applyCraftHit(body, HIT.minSpeed, -1, 0, 0, HIT, report)).toBe(0)
    expect(snapshot(body)).toBe(before)
    expect(report.struck).toBe(false)
  })
})

// ── 2. In the field, as the game flies it: the player rams a racer ─────────

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

/**
 * `racer-contact.test.ts`'s ram: `steady` at 60 m/s past ring 1, the player
 * boosted at 160 m/s 60 m behind it on the same line. Separation off, so the
 * racer does not dodge. Returns the flight tick by tick.
 */
const ram = (rules: {
  contact: CraftContactSpec | null
  hit: CraftHitSpec | null
  plain?: boolean
}) => {
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
  const jolt = createHitJolt()
  const ticks: {
    player: string
    racer: string
    speed: number
    noseY: number
    event: ReturnType<typeof takeRacerHit>
    strength: number
    gap: number
  }[] = []
  for (let t = 0; t < Math.round(2 / FIXED_DT); t++) {
    stepHoverJet(player, input, FIXED_DT)
    stepRacerField(
      field,
      [racer],
      GATES,
      [],
      FIXED_DT,
      GUIDE,
      [],
      CRASH,
      null,
      rules.plain
        ? NO_FIELD_RULES
        : { separation: null, contact: rules.contact, player: player.body, hit: rules.hit },
    )
    ticks.push({
      player: snapshot(player.body),
      racer: snapshot(racer.jet.body),
      speed: speedOf(player.body),
      noseY: nose(player.body).y,
      event: takeRacerHit(field.hit, jolt, t * FIXED_DT),
      strength: field.hit.strength,
      gap: craftGap(player.body, racer.jet.body, VOLUME),
    })
  }
  return { ticks, field, racer, jolt }
}

describe('the player rams a racer: it is hit, it hears it, and the racer takes the push alone', () => {
  it('a hit nudges the player and plays the event', () => {
    const on = ram({ contact: CONTACT, hit: HIT })
    const off = ram({ contact: CONTACT, hit: null })
    const k = on.ticks.findIndex((t) => t.event !== null)
    expect(k, 'a hit landed').toBeGreaterThan(0)
    const hitTick = on.ticks[k] as (typeof on.ticks)[number]
    // Until the hit the two flights are one flight, bit for bit.
    expect(on.ticks.slice(0, k).map((t) => t.player)).toEqual(
      off.ticks.slice(0, k).map((t) => t.player),
    )
    // It was hard: 100 m/s of closing, full strength.
    expect(hitTick.strength).toBe(1)
    // The EVENT, and what the map makes of it: 2016's `hit` group.
    expect(hitTick.event).toEqual({ type: 'ship.hit' })
    expect(actionsForEvent(hitTick.event as NonNullable<typeof hitTick.event>, [])).toEqual([
      { kind: 'play', cue: 'ship.hit' },
    ])
    expect(CUES['ship.hit'].group).toBe('hit')
    // Heard ONCE: a push leaves them parting, and a lean is not a hit.
    expect(on.ticks.filter((t) => t.event !== null)).toHaveLength(1)
    expect(on.field.hit.total).toBe(1)
    // The speed, scrubbed on that tick, on top of the push.
    const offTick = off.ticks[k] as (typeof off.ticks)[number]
    expect(hitTick.speed / offTick.speed).toBeCloseTo(1 - HIT.scrub, 9)
    // The nose rides UP over the tail it hit, and keeps riding up a moment:
    // a quarter of a second on, the rammer's nose is measurably higher than
    // the same flight with no hit.
    const later = Math.round(0.25 / FIXED_DT)
    const riseDeg =
      ((Math.asin((on.ticks[k + later] as (typeof on.ticks)[number]).noseY) -
        Math.asin((off.ticks[k + later] as (typeof off.ticks)[number]).noseY)) *
        180) /
      Math.PI
    expect(riseDeg, `nose up ${riseDeg.toFixed(2)} deg`).toBeGreaterThan(3)
    // The racer took the push alone: on the hit tick its body is the push-only
    // flight's, to the bit.
    expect(hitTick.racer).toBe(offTick.racer)
    // And the push still does its job: nobody inside anybody, nobody crashed.
    expect(Math.min(...on.ticks.map((t) => t.gap))).toBeGreaterThanOrEqual(-1e-9)
    expect(on.racer.crash.count).toBe(0)
  })

  it('jolts the cockpit from the hit, and the jolt dies away', () => {
    const on = ram({ contact: CONTACT, hit: HIT })
    const at = on.jolt.at
    expect(Number.isFinite(at)).toBe(true)
    expect(hitJoltGain(HIT, on.jolt, at)).toBeCloseTo(HIT.shakeGain, 12)
    expect(hitJoltGain(HIT, on.jolt, at + HIT.shakeSeconds / 2)).toBeCloseTo(HIT.shakeGain / 4, 12)
    expect(hitJoltGain(HIT, on.jolt, at + HIT.shakeSeconds)).toBe(0)
    expect(hitJoltGain(HIT, on.jolt, at - 0.01)).toBe(0)
  })

  it('the same ram gives the same hit, to the last bit', () => {
    const one = ram({ contact: CONTACT, hit: HIT })
    const two = ram({ contact: CONTACT, hit: HIT })
    expect(two.ticks.map((t) => t.player)).toEqual(one.ticks.map((t) => t.player))
  })
})

// ── 3. The cockpit's jolt is the buffet's own waveform ─────────────────────

describe("the jolt rides cockpit.shake's waveform and its two hard offs", () => {
  const pose = (shake = SHAKE, scale = 1, jolt = HIT.shakeGain) => {
    const out = createShakeSample()
    // Parked-slow (under `startSpeed`): the buffet alone is nothing here.
    sampleCockpitShake(out, shake, scale, 0.123, 0, true, jolt)
    return Math.max(Math.abs(out.x), Math.abs(out.y), Math.abs(out.z), Math.abs(out.roll))
  }

  it('moves the cockpit where the buffet alone would not', () => {
    expect(pose(SHAKE, 1, 0)).toBe(0)
    expect(pose()).toBeGreaterThan(0)
    // Bounded by its own ceiling: the preset's amplitude times the gain.
    const out = createShakeSample()
    sampleCockpitShake(out, SHAKE, 1, 0.123, 0, true, HIT.shakeGain)
    expect(Math.abs(out.x)).toBeLessThanOrEqual(SHAKE.amplitude * HIT.shakeGain + 1e-15)
    expect(Math.abs(out.roll)).toBeLessThanOrEqual(SHAKE.angle * HIT.shakeGain + 1e-15)
  })

  it('is off with the shake off, and with the speed-effects slider at nothing', () => {
    expect(pose({ ...SHAKE, enabled: false })).toBe(0)
    expect(pose(SHAKE, 0)).toBe(0)
    // And linear in the slider, as the buffet is.
    expect(pose(SHAKE, 0.5)).toBeCloseTo(pose(SHAKE, 1) / 2, 12)
  })
})

// ── 4. Classic, and the flag ───────────────────────────────────────────────

describe('Classic is unchanged, and the flag is the whole switch', () => {
  it("Classic's preset: the player flies the ram exactly as with no rule at all", () => {
    const classic = ram({
      contact: CLASSIC.gameplay.racers.contact,
      hit: CLASSIC.gameplay.racers.hit,
    })
    const plain = ram({ contact: null, hit: null, plain: true })
    expect(classic.ticks.map((t) => t.player)).toEqual(plain.ticks.map((t) => t.player))
    expect(classic.field.hit.total).toBe(0)
    expect(classic.ticks.every((t) => t.event === null)).toBe(true)
  })

  it("with contact on and the hit's flag off, the push is DEV-364's and nothing more", () => {
    const flagOff = ram({ contact: CONTACT, hit: { ...HIT, enabled: false } })
    const pushOnly = ram({ contact: CONTACT, hit: null })
    expect(flagOff.ticks.map((t) => t.player)).toEqual(pushOnly.ticks.map((t) => t.player))
    expect(flagOff.field.hit.total).toBe(0)
  })

  it('ships on for Anniversary and off for Classic', () => {
    expect(ANNIVERSARY.gameplay.racers.hit.enabled).toBe(true)
    expect(CLASSIC.gameplay.racers.hit.enabled).toBe(false)
    expect(CLASSIC.gameplay.racers.contact.enabled).toBe(false)
  })

  it('refuses a block the law cannot use', () => {
    const bad = (hit: Partial<CraftHitSpec> & Record<string, unknown>) => () =>
      validateEdition({
        ...ANNIVERSARY,
        gameplay: {
          ...ANNIVERSARY.gameplay,
          racers: { ...ANNIVERSARY.gameplay.racers, hit: { ...HIT, ...hit } },
        },
      } as Edition)
    expect(bad({ fullSpeed: HIT.minSpeed })).toThrow(/fullSpeed must exceed minSpeed/)
    expect(bad({ scrub: 1.5 })).toThrow(/scrub must be 0..1/)
    expect(bad({ headingKick: Number.NaN })).toThrow(/headingKick/)
  })
})
