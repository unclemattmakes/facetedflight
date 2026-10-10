// src/game/ambient-traffic.ts — the OTHER mission's ships, in your sky.
//
// Matt's triage, 2026-09-16: *"Interleaved modes: see HoverJets fly while on a
// JumpSeat course."* DEV-146.
//
// ── What this is, and what it is not ──────────────────────────────────────
//
// It is not opponents. These ships are flying a course you are not on, they
// score nothing, they end nothing, they are in no standings, and they cannot
// touch you — `stepAiRacer` has terrain contact and no ship-to-ship collision
// at all, so there is no path by which traffic ends a run. The one thing they
// do is exist: an island with a race going on across the bay is a place, and
// an island with one ship on it is a level.
//
// ── Content is data (hard rule 6), and this is what that cost ─────────────
//
// WHICH course flies over WHICH mission is `Level.ambientTraffic`, emitted into
// the generated level JSON from an authored table in `tools/extract/level.mjs`
// (see that table for the six measured candidate pairings and why one was
// taken). WHETHER it is drawn is `gameplay.ambientTraffic` in the edition
// preset — 2016 never did this, so Classic is off.
//
// So `src/` gained: a nullable field on the schema, a feature block on the
// preset, and this file. Adding traffic to a second mission is a row in that
// table and `pnpm extract:levels`; nothing here knows the name of any mission.
//
// ── Why they are SPREAD round the line rather than sat on a start deck ────
//
// Both halves matter and both are the difference between traffic and a
// cutscene. Spawned together at the donor's start they leave as a bunch, from
// a place the player is not, and a lap later the sky is empty for good. So
// each ship is seeded at its own fraction of the route's arc length — DEV-146's
// `seedRacerAt` in the sim — and when one finishes its lap it is put back at
// the fraction it began at, which keeps the spacing stable rather than letting
// them bunch up over a session.
//
// A recycle is a teleport, and `recycleClearMetres` is what makes it
// unwatchable rather than unlikely to be watched (DEV-041's distinction): a
// finished ship keeps flying out, climbing away exactly as any finished racer
// does, until it is further from the player than that, and only then goes back.
//
// ── Two populations, one set of module scratch (trap 19 / DEV-032) ────────
//
// This is the second population of `AiRacer`s to be stepped in one frame, and
// `sim/ai-racer.ts` steps every racer through ONE module-level `HoverJetInput`.
// That is exactly the shape that put a finished racer on another racer's
// frozen stick for a whole session. `tests/unit/ambient-traffic.test.ts` steps
// a traffic ship and a scoring racer alternately and asserts neither moves the
// other's body, cursor, course or input — the "step a SECOND one and assert the
// first did not move" guard, with the two sides now flying DIFFERENT courses,
// which is a harder version of the same question.

import type * as THREE from 'three'
import type { EditionAmbientTraffic } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { loadLevel } from '@/content/load-level'
import { courseGates } from '@/game/mission'
import type { RacerStart } from '@/game/racer-grid'
import { type LoadedRacers, loadRacers, PADS_ONLY } from '@/game/racers'
import { flipPosition, flipQuaternion } from '@/render/unity-space'
import { type AiRacer, seedRacerAt } from '@/sim/ai-racer'
import { type CrashSpec, routeLineOf } from '@/sim/crash'
import { lookAlong, quat } from '@/sim/math/quat'
import { distanceSq, type Vec3, v3 } from '@/sim/math/vec3'
import { type Route, routeAt, routeTangentAt } from '@/sim/route'
import type { HeightField } from '@/sim/terrain/height-field'

export interface LoadedTraffic {
  /** Add this to the scene. Named `traffic`, so a debugger can tell the two groups apart. */
  readonly group: THREE.Group
  /** The donor mission id — for the console line and the `__ff2` probe. */
  readonly mission: string
  readonly count: number
  readonly racers: readonly AiRacer[]
  /** Where each ship was seeded, as arc length along the donor's line. Metres. */
  readonly phases: readonly number[]
  /** Laps completed and put back, since load. A number a probe can watch. */
  readonly recycled: number
  /**
   * One fixed step for every traffic ship, and the lap recycle.
   *
   * `player` is the PLAYER's position in SIM space — the body `stepFlight` just
   * moved, not the rendered mesh — and it is read for one thing only: how far
   * away a ship that has finished its lap is, before it is put back.
   */
  step(
    terrain: readonly HeightField[],
    dt: number,
    ground: readonly HeightField[],
    crash: CrashSpec | null,
    player: Vec3,
  ): void
  render(alpha: number, eye: THREE.Vector3, dt: number): void
  dispose(): void
}

/**
 * Where each ship starts, as a fraction of the way round the line.
 *
 * `(i + 0.5) / n` rather than `i / n`: the first ship of the latter sits at
 * arc length zero, which is the donor's start deck — the one place on the
 * course where a ship is unambiguously *starting a race* rather than *flying
 * past*. Half-open spacing puts nobody there and keeps the gaps even.
 */
export const trafficPhases = (count: number, length: number): number[] =>
  Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * length)

/**
 * The starts, in THREE space, for ships laid along a line that is in SIM space.
 *
 * The flip is `render/unity-space.ts`'s, and it is done here so that
 * `game/racers.ts` needs no idea that these starts came from anywhere unusual —
 * it flips them straight back on the way into `createAiRacer`, exactly as it
 * does for a pad. Both helpers are their own inverse, so the round trip is an
 * identity and `tests/unit/ambient-traffic.test.ts` asserts that it lands on
 * the line rather than trusting it.
 */
export const trafficStarts = (route: Route, phases: readonly number[]): RacerStart[] => {
  const simPos = v3()
  const simDir = v3()
  const simQuat = quat()
  const threePos = v3()
  const threeQuat = quat()
  return phases.map((s, index) => {
    routeAt(route, s, simPos)
    routeTangentAt(route, s, simDir)
    lookAlong(simQuat, simDir)
    flipPosition(threePos, simPos)
    flipQuaternion(threeQuat, simQuat)
    return {
      pos: [threePos.x, threePos.y, threePos.z] as const,
      quat: [threeQuat.x, threeQuat.y, threeQuat.z, threeQuat.w] as const,
      // `slot`, because a pad is one of 2016's two AI pads and none of these is.
      from: { kind: 'slot', index } as const,
      tuning: null,
    }
  })
}

/**
 * Where a finished ship goes back to: the START of the line, every time.
 *
 * ── NOT its own phase, and that is a measured correction ──────────────────
 *
 * The first version put each ship back where it was seeded, on the reasoning
 * that keeping the phases fixed keeps the spacing even. It does — and it also
 * confines each ship to the arc between its phase and the finish, for ever. A
 * ship seeded at 83 % of `int_01_hoverJet` flew the last 17 % of the course,
 * finished in about twenty seconds, and went back to 83 % to fly the same
 * 1.9 km again; measured in the running build it recycled FOURTEEN times in
 * 100 seconds and the three ships between them never visited two thirds of the
 * island. The nearest one to the player never came inside 1.4 km, because the
 * three short arcs they were trapped on did not include the part of the route
 * that passes the JumpSeat course — which is the part the pairing was CHOSEN
 * for.
 *
 * So the phases are the opening stagger and nothing else. After that every
 * ship flies the whole circuit, and the spread comes from the tunings' own lap
 * times (66 s to 120 s on this course), which is drift rather than a formation
 * — what traffic looks like.
 */
export const RECYCLE_AT = 0

/**
 * Is this ship's lap over AND out of sight at both ends of the teleport?
 *
 * Three conditions, and the last one is the one that is easy to forget. A
 * recycle moves a ship from where it finished to {@link RECYCLE_AT}; a player
 * who cannot see the ship vanish can still see it APPEAR. So both the ship and
 * its destination have to be clear of the player, and a ship that cannot
 * satisfy that keeps flying out — climbing away, exactly as any finished racer
 * does — and comes back on a later tick.
 *
 * `clearMetres` is the distance at which a 6 m hull is about four to six pixels
 * on a Quest 3, which is DEV-044's own threshold for a thing that has been
 * rendered rather than seen. `>=` rather than `>`: at exactly the clearance the
 * ship is as invisible as the number claims.
 *
 * Exported, and pure, because the alternative is a rule that can only be tested
 * by loading three GLBs.
 */
export const recycleDue = (
  racer: AiRacer,
  player: Vec3,
  clearMetres: number,
  /** Where it would reappear, SIM space. */
  destination: Vec3,
): boolean => {
  if (!racer.finished) return false
  const clearSq = clearMetres * clearMetres
  const far = (p: Vec3): boolean => distanceSq(p, player) >= clearSq
  return far(racer.jet.body.position) && far(destination)
}

/**
 * Build the traffic for a level, or null when there is none to build.
 *
 * Null — not an empty object — for every reason there can be, because a caller
 * that has no traffic should do no work per frame rather than iterate an empty
 * list: the preset is off, the level names no donor, the budget is zero.
 *
 * The three refusals that are LOUD rather than silent are the ones that mean
 * somebody authored something that cannot work: a donor that does not exist, a
 * donor over a different island (the ships would be over the sea somewhere
 * nobody is), and a donor with no authored racing line to spread along. Each
 * one is a `console.error` and no traffic, rather than a throw — a mission that
 * still plays without its scenery is better than a mission that will not boot.
 */
export const loadAmbientTraffic = async (
  level: Level,
  spec: EditionAmbientTraffic,
  /** Injected so a unit test can hand over a course without `import.meta.glob`. */
  load: (id: string) => Promise<Level> = loadLevel,
): Promise<LoadedTraffic | null> => {
  const authored = level.ambientTraffic
  if (!spec.enabled || !authored) return null
  // The LEVEL says how many the course wants; the EDITION says how many fit in
  // a frame. The smaller wins, and zero means the preset has turned it off by
  // budget rather than by flag — which is a thing a headset pass will do.
  const count = Math.min(authored.count, spec.maxCount)
  if (count < 1) return null

  let donor: Level
  try {
    donor = await load(authored.mission)
  } catch (e) {
    console.error(
      `ambientTraffic: ${level.id} borrows "${authored.mission}", which will not load — ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return null
  }
  if (donor.environment !== level.environment) {
    console.error(
      `ambientTraffic: ${level.id} is over "${level.environment}" and "${authored.mission}" is ` +
        `over "${donor.environment}" — the traffic would be on a different island`,
    )
    return null
  }

  // The donor's authored racing line. Required, and not falling back to the
  // gate polyline on purpose: a polyline through ring centres is a line for a
  // ship that is RACING and being corrected by the gates it owes, and these
  // ships are corrected by nothing. All seven shipped HoverJet courses have a
  // route; a donor without one is a content error worth saying out loud.
  const points = donor.route ?? null
  if (!points || points.length < 2) {
    console.error(
      `ambientTraffic: "${authored.mission}" has no authored route to spread traffic along`,
    )
    return null
  }
  const gates = courseGates(donor)
  const guide = routeLineOf(points, gates)
  const route = guide.route
  const phases = trafficPhases(count, route.length)

  const inner: LoadedRacers = await loadRacers(donor, gates, true, PADS_ONLY, {
    starts: trafficStarts(route, phases),
    // The same `Route` the phases were measured on. Letting `loadRacers` build
    // its own from the same points would give two objects with two sets of
    // floating-point arc lengths for the seeder and the follower to disagree by.
    guide,
  })
  inner.group.name = 'traffic'
  // Position and nose are already right — `trafficStarts` put them there — so
  // this is the rest of what "as if it had flown here" means: cruise speed
  // along the line, the cursor at this arc length, and the gates behind it
  // marked passed so nobody turns round and flies back to ring one.
  inner.racers.forEach((racer, i) => {
    seedRacerAt(racer, guide, phases[i] as number)
  })

  // Where a finished ship reappears, worked out once. Both the recycle rule
  // and the reseed read it, so they cannot disagree about where "the start of
  // the line" is.
  const restart = routeAt(route, RECYCLE_AT, v3())
  let recycled = 0

  return {
    group: inner.group,
    mission: donor.id,
    count: inner.count,
    racers: inner.racers,
    phases,
    get recycled() {
      return recycled
    },

    step(terrain, dt, ground, crash, player) {
      inner.step(terrain, dt, ground, crash)
      for (let i = 0; i < inner.racers.length; i++) {
        const racer = inner.racers[i] as AiRacer
        if (!recycleDue(racer, player, spec.recycleClearMetres, restart)) continue
        // `reset` clears the trail, the contact state and the crash state, so
        // the recycled ship draws no streak from where it was and carries
        // nothing forward — but it puts the BODY back on the ship's own start,
        // which is its phase point. `seedRacerAt` overrides that with
        // `RECYCLE_AT` and restores the rest: the speed, the cursor and the
        // gates. Read `RECYCLE_AT` for why it is not the phase.
        inner.reset(i)
        seedRacerAt(racer, guide, RECYCLE_AT)
        recycled++
      }
    },

    render(alpha, eye, dt) {
      inner.render(alpha, eye, dt)
    },

    dispose() {
      inner.dispose()
    },
  }
}
