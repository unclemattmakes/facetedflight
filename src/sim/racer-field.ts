// src/sim/racer-field.ts — every racer, one tick, sharing the air. DEV-364.
//
// `stepAiRacer` steps ONE racer and knows nothing about any other craft, which
// is why five of them flew one line and passed through each other and through
// the player. This is the one place a tick of the whole field is written:
//
//   1. where every craft IS, before anybody moves — the racers, then the player;
//   2. each racer, in racer order, steering off that one picture (its lane and
//      its avoidance: `gameplay.racers.separation`);
//   3. every pair pushed apart where they touch (`gameplay.racers.contact`);
//   4. the player, if a racer struck it hard enough, takes a hit on top of the
//      push: its speed scrubbed and its nose and wings knocked
//      (`gameplay.racers.hit`, `sim/craft-hit.ts`; the DEV-364 follow-up).
//
// `game/racers.ts` calls it from the running game and the tests call it
// headless, so the rule a test proves is the rule that flies. With both rules
// off it is the plain loop it replaced, stepping for stepping — Classic's
// racers do not move by a bit (`racer-contact.test.ts` holds that).
//
// The player takes part as a BODY and nothing else: it is avoided, and pushed,
// but it is flown by `boot/app.ts` before this runs, so its position here is
// where the flight model has just put it. It holds no lane — the player flies
// wherever the player flies.
//
// SIM LAYER: no three, no DOM, no wall clock, no `Math.random()`.

import {
  type AiRacer,
  assignLanes,
  type RacerSeparationSpec,
  type RacerTraffic,
  stepAiRacer,
} from './ai-racer'
import { FIXED_DT } from './constants'
import type { Gate } from './course'
import {
  type CraftContactReport,
  type CraftContactSpec,
  type CraftVolume,
  createCraftContactReport,
  HOVERJET_CRAFT_VOLUME,
  resolveCraftContacts,
} from './craft-contact'
import {
  applyCraftHit,
  type CraftHitReport,
  type CraftHitSpec,
  createCraftHitReport,
} from './craft-hit'
import { type CrashSpec, crashHoldsShip } from './crash'
import { readStudent, type StudentInput } from './instructor'
import { v3 } from './math/vec3'
import type { PropColliders, PropCollisionSpec } from './props/collision'
import type { RigidBody } from './rigidbody'
import type { Route } from './route'
import type { HeightField } from './terrain/height-field'

/** The field's own state: the scratch one tick needs, allocated once. */
export interface RacerField {
  /** The picture every racer steers off: racers, then the player. */
  readonly traffic: RacerTraffic
  /** The contact pass's list, same order; null for a craft out of play. */
  readonly bodies: (RigidBody | null)[]
  /** What the last contact pass did. A reading, for probes and tests. */
  readonly contact: CraftContactReport
  /**
   * What the last step's hit rule did to the PLAYER (DEV-364 follow-up): the
   * render side plays the sound and jolts the cockpit off `struck`.
   */
  readonly hit: CraftHitReport
  /** The craft volume every hull is. */
  readonly volume: CraftVolume
}

/** The rules for one tick, read off the live preset by the caller. */
export interface RacerFieldRules {
  readonly separation: RacerSeparationSpec | null
  readonly contact: CraftContactSpec | null
  /** The player's body while it is flying; null on the lift or held by a crash. */
  readonly player: RigidBody | null
  /**
   * DEV-391: the OTHER players in a room, where each is drawn, SIM space —
   * avoided like the player, never pushed and never pushing (a room has no
   * contact, plan/MULTIPLAYER.md §6.7: a pose is 26+ m stale at speed). At
   * most the field's `others` (`createRacerField`); absent or empty in single
   * player, where the picture is exactly what it was.
   */
  readonly others?: readonly { readonly x: number; readonly y: number; readonly z: number }[] | null
  /**
   * DEV-364 follow-up: what a racer's hit costs the PLAYER (`sim/craft-hit.ts`).
   * Composed with `contact`: nothing touches, nothing is hit. Absent or null:
   * the push alone, as DEV-364 shipped it.
   */
  readonly hit?: CraftHitSpec | null
  /**
   * DEV-376: the student, as a flight instructor reads it — the player's arc
   * along the racing line (`game/race-place.ts`'s `raceProgress`), speed,
   * position and whether they are held. Copied into every racer that HAS a
   * pace before any racer steps, so the instructor paces off the same picture
   * the lane rule steers off. Absent or null: nothing is read, and no racer
   * without a pace ever reads it.
   */
  readonly student?: StudentInput | null
}

/** No rule at all: the one line and the ghosts' intangibility. What Classic is. */
export const NO_FIELD_RULES: RacerFieldRules = { separation: null, contact: null, player: null }

/**
 * Build the field for these racers, and give each its lane off `route`.
 *
 * The lanes are ASSIGNED here whatever the preset says, so a flip to a preset
 * with separation on mid-run has lanes to fly; whether they are FLOWN is the
 * live rule's, every tick.
 */
export const createRacerField = (
  racers: readonly AiRacer[],
  route: Route | null,
  volume: CraftVolume = HOVERJET_CRAFT_VOLUME,
  /** DEV-391: room for this many other players in the picture (a room's humans). */
  others = 0,
): RacerField => {
  assignLanes(racers, route)
  const craft = Array.from({ length: racers.length + 1 + others }, () => v3())
  // The player, and anybody else in the air, holds no lane: rank 0.
  const ranks = [...racers.map((r) => r.laneRank), ...Array.from({ length: 1 + others }, () => 0)]
  const widestRank = racers.reduce((w, r) => Math.max(w, Math.abs(r.laneRank)), 0)
  return {
    traffic: {
      // Placeholder until the first step writes the live rule in.
      spec: null as unknown as RacerSeparationSpec,
      craft,
      ranks,
      count: 0,
      self: 0,
      widestRank,
      hullRadius: volume.radius,
    },
    bodies: Array.from({ length: racers.length + 1 }, () => null),
    contact: createCraftContactReport(),
    hit: createCraftHitReport(),
    volume,
  }
}

/**
 * One fixed step of every racer, and of the air they share.
 *
 * The first eight arguments are `stepAiRacer`'s, passed through unchanged to
 * every racer; `rules` is the only new thing. With both rules off this is
 * exactly `for (const r of racers) stepAiRacer(r, ...)`.
 */
export const stepRacerField = (
  field: RacerField,
  racers: readonly AiRacer[],
  gates: readonly Gate[],
  terrain: readonly HeightField[],
  dt: number = FIXED_DT,
  guide: { route: Route; gateArc: readonly number[] } | null = null,
  ground: readonly HeightField[] = terrain,
  crash: CrashSpec | null = null,
  props: { readonly colliders: PropColliders; readonly spec: PropCollisionSpec } | null = null,
  rules: RacerFieldRules = NO_FIELD_RULES,
): void => {
  const separation = rules.separation?.enabled ? rules.separation : null
  const traffic = field.traffic
  if (separation) {
    // ── 1. the picture, before anybody moves ─────────────────────────────
    traffic.spec = separation
    const craft = traffic.craft
    for (let i = 0; i < racers.length; i++) {
      const p = (racers[i] as AiRacer).jet.body.position
      const c = craft[i] as (typeof craft)[number]
      c.x = p.x
      c.y = p.y
      c.z = p.z
    }
    traffic.count = racers.length
    if (rules.player) {
      const c = craft[racers.length] as (typeof craft)[number]
      c.x = rules.player.position.x
      c.y = rules.player.position.y
      c.z = rules.player.position.z
      traffic.count = racers.length + 1
    }
    // DEV-391: a room's other players, after the player, as far as there is room.
    const others = rules.others
    if (others) {
      for (const o of others) {
        if (traffic.count >= craft.length) break
        const c = craft[traffic.count] as (typeof craft)[number]
        c.x = o.x
        c.y = o.y
        c.z = o.z
        traffic.count++
      }
    }
  }
  // ── 1b. the student, for an instructor (DEV-376) ───────────────────────
  const student = rules.student
  if (student) {
    for (const r of racers) if (r.pace) readStudent(r.pace, student)
  }
  // ── 2. every racer, off that one picture ───────────────────────────────
  for (let i = 0; i < racers.length; i++) {
    traffic.self = i
    stepAiRacer(
      racers[i] as AiRacer,
      gates,
      terrain,
      dt,
      guide,
      ground,
      crash,
      props,
      separation ? traffic : null,
    )
  }
  // ── 3. nobody inside anybody ───────────────────────────────────────────
  field.hit.struck = false
  field.hit.speed = 0
  field.hit.strength = 0
  const contact = rules.contact?.enabled ? rules.contact : null
  if (!contact) {
    field.contact.contacts = 0
    field.contact.hardest = 0
    return
  }
  const bodies = field.bodies
  for (let i = 0; i < racers.length; i++) {
    const r = racers[i] as AiRacer
    // A racer held where it crashed is a wreck under a hold, not a ship in the
    // air: it neither pushes nor is pushed until its reset.
    bodies[i] = crashHoldsShip(r.crash) ? null : r.jet.body
  }
  bodies[racers.length] = rules.player
  resolveCraftContacts(bodies, field.volume, contact, field.contact)
  // ── 4. and a hit costs the player something (DEV-364 follow-up) ────────
  //
  // The player's own entry in the report, after every pass: how hard it was
  // struck and which way it went. A racer takes the push alone.
  const hit = rules.hit?.enabled ? rules.hit : null
  const p = racers.length
  const closing = field.contact.impact[p] ?? 0
  if (hit && rules.player && closing > 0) {
    const away = field.contact.away
    applyCraftHit(
      rules.player,
      closing,
      away[p * 3] as number,
      away[p * 3 + 1] as number,
      away[p * 3 + 2] as number,
      hit,
      field.hit,
    )
  }
}
