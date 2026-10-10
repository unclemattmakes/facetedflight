// tests/unit/smoke-missions.test.ts — every shipped mission, flown for half a
// minute, headless. The widest single test in the suite, on purpose.
//
// ── What this is for ─────────────────────────────────────────────────────
//
// The smoke tier (`pnpm test:smoke`, docs/testing/TIERS.md) exists to answer
// "did I just break the game?" in a few seconds, and the honest way to ask
// that of a flight game is to fly it. Before this file the suite flew ONE
// HoverJet mission to completion (`autopilot.test.ts`) and the six JumpSeat
// missions over real terrain (`jumpseat-autopilot-missions.test.ts`, 1.8 s and
// skipped wherever `public/assets/` is absent — which is CI). Nothing put all
// thirteen through the scorer in one place, and nothing ran the Anniversary
// gameplay levers against a ship that was actually moving.
//
// So: every level JSON in `content/levels/`, loaded the way the game's loader
// checks it, stepped through the SAME functions `boot/app.ts` calls per tick —
// `autopilotActions` → `stepHoverJet` → `stepMission` with the preset's levers
// → `chainGate` on a scored ring → `stepBoundary` — under BOTH editions, for
// thirty seconds of sim time. The JumpSeat six go through
// `helpers/jumpseat-run.ts`, which is the same harness the six-mission test
// uses, with the ground taken away so no asset is needed.
//
// ── What is asserted ─────────────────────────────────────────────────────
//
// The SHAPE of a run that has not come apart, never its numbers:
//
//   * nothing throws, and no coordinate, velocity, clock or score is NaN or
//     infinite, on any tick of any run — the failure a sign flip in a sim
//     function produces first;
//   * the score never goes down in Ring Attack and is never negative anywhere;
//   * the medal arithmetic is reachable for every mission: `medalFor` answers
//     with a real band (or `null` where the mode awards none), and
//     `awardMedal` against the mission's own curve agrees with it at the end;
//   * the scorer is genuinely LIVE — the HoverJet autopilot takes at least one
//     ring on every Ring Attack course inside the window, so a scorer that
//     silently stopped counting cannot pass here by scoring nothing;
//   * Classic and Anniversary score the same rings in the same order — the
//     levers add a bonus, they do not change what a ring is (DEV-110).
//
// No golden trajectory. The controller is proportional and the exact scores
// belong to the narrow tests (`mission-run`, `pad-streak`, `gameplay-levers`),
// which is where the hone-in sends you when this goes red.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type Edition, validateEdition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import {
  awardMedal,
  courseGates,
  type Medal,
  type MissionLevers,
  medalFor,
  medalThresholds,
  missionScore,
  startMission,
  stepMission,
} from '@/game/mission'
import { medalCurve } from '@/game/modes'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { autopilotActions, nextGate } from '@/sim/autopilot'
import { type BoundarySpec, createBoundary, stepBoundary } from '@/sim/boundary'
import { FIXED_DT } from '@/sim/constants'
import { createHoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import { chainGate } from '@/sim/speed-chain'
import { flyJumpSeatMission } from './helpers/jumpseat-run'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Sim seconds per run. Enough for the HoverJet to take its first rings on every course. */
const WINDOW_SECONDS = 30

const MEDALS: readonly (Medal | null)[] = ['none', 'bronze', 'silver', 'gold', 'platinum', null]

/** Every shipped mission, from the JSON the game loads — not a hand-kept list. */
const LEVELS: Level[] = fs
  .readdirSync(path.join(ROOT, 'content/levels'))
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'content/levels', f), 'utf8')) as Level)

/** Both presets, through the check `content/load-edition.ts` runs on them. */
const EDITIONS: Edition[] = ['classic', 'anniversary'].map((id) =>
  validateEdition(
    JSON.parse(fs.readFileSync(path.join(ROOT, 'content/editions', `${id}.json`), 'utf8')),
  ),
)

const finite = (n: number): boolean => Number.isFinite(n)

interface HoverJetRun {
  readonly ringsPassed: number
  readonly order: readonly number[]
  readonly score: number
  readonly elapsed: number
  readonly finished: boolean
  readonly medal: Medal | null
  readonly maxSpeed: number
  readonly proximityBanked: number
}

/**
 * One HoverJet mission under one preset, exactly the per-tick sequence
 * `boot/app.ts` runs. There is no terrain, so the clearance the levers see is
 * height above the course FLOOR (see `floorY` below) rather than above the
 * ground — which keeps the proximity pool live, since the autopilot flies the
 * authored line, without needing `public/assets/`.
 */
const flyHoverJet = (level: Level, edition: Edition): HoverJetRun => {
  const jet = createHoverJet()
  jet.launched = true
  threeTupleToUnity(jet.body.position, level.spawn.pos as number[])
  threeQuatTupleToUnity(jet.body.orientation, level.spawn.quat as number[])
  jet.body.position.y += level.spawn.launch?.rise ?? 0

  const mission = startMission(level)
  const gates = courseGates(level)
  // No terrain here, so the course FLOOR — the lowest gate centre — stands in
  // for the ground when the levers ask how low the ship is. The autopilot flies
  // through the centres, so at the lowest gates the meter fills exactly as it
  // would over a ridge, and the proximity pool is genuinely exercised. Height
  // above the sea was tried first and the meter never moved: every course sits
  // well above `farMetres`, and a lever that is never demanded is not tested.
  const floorY = Math.min(...gates.map((g) => g.centre.y))
  const input = noInput()
  const boundary = createBoundary()
  const boundarySpec: BoundarySpec | null = level.boundary.volume?.radius
    ? {
        enabled: level.boundary.enabled,
        centre: threeTupleToUnity({ x: 0, y: 0, z: 0 }, level.boundary.volume.centre as number[]),
        radius: level.boundary.volume.radius,
        resetDelaySeconds: level.boundary.resetDelay,
        fadeSeconds: level.boundary.resetFadeSeconds ?? 2.5,
      }
    : null

  const order: number[] = []
  let lastScore = 0
  let maxSpeed = 0
  let proximityBanked = 0
  const steps = Math.ceil(WINDOW_SECONDS / FIXED_DT)
  for (let i = 0; i < steps && !mission.finished; i++) {
    const target = nextGate(mission.course.gates, mission.course.passed)
    const gate = target >= 0 ? gates[target] : undefined
    if (gate) {
      const after = gates[target + 1]?.centre ?? null
      autopilotActions(jet.body, gate.centre, input, undefined, [], Number.POSITIVE_INFINITY, after)
    }
    stepHoverJet(jet, input)

    const v = jet.body.velocity
    const speed = Math.hypot(v.x, v.y, v.z)
    const levers: MissionLevers = {
      clearance: jet.body.position.y - floorY,
      speed,
      struck: false,
      proximity: edition.gameplay.proximity,
      gateEvents: edition.gameplay.gateEvents,
    }
    const ring = stepMission(mission, level, jet.body.position, FIXED_DT, levers)
    if (ring >= 0) {
      order.push(ring)
      chainGate(jet.chain)
    }
    proximityBanked += mission.event.proximityBonus
    if (boundarySpec) stepBoundary(boundary, boundarySpec, jet.body.position, FIXED_DT)

    // Plain checks on the hot path — 2,460 ticks × 14 runs is too many for an
    // `expect` each — thrown as one assertion naming the tick that came apart.
    const p = jet.body.position
    const score = missionScore(mission)
    const fault = !(finite(p.x) && finite(p.y) && finite(p.z))
      ? `position ${p.x},${p.y},${p.z}`
      : !finite(speed)
        ? 'velocity'
        : !finite(mission.elapsed)
          ? 'clock'
          : !finite(score)
            ? `score ${score}`
            : score < 0
              ? `score went negative (${score})`
              : mission.mode === 'ringAttack' && score < lastScore
                ? `score went DOWN (${lastScore} -> ${score})`
                : null
    if (fault) {
      throw new Error(`${level.id}/${edition.id} at ${mission.elapsed.toFixed(2)} s: ${fault}`)
    }
    lastScore = score
    maxSpeed = Math.max(maxSpeed, speed)
  }
  return {
    ringsPassed: mission.ringsPassed,
    order,
    score: missionScore(mission),
    elapsed: mission.elapsed,
    finished: mission.finished,
    medal: medalFor(mission, level),
    maxSpeed,
    proximityBanked,
  }
}

const hoverJets = LEVELS.filter((l) => l.vehicle === 'hoverjet')
const jumpSeats = LEVELS.filter((l) => l.vehicle === 'jumpseat')

// Each run once; the table below reads the same runs the assertions did.
const hoverJetRuns = new Map<string, HoverJetRun>()
const hoverJetRun = (level: Level, edition: Edition): HoverJetRun => {
  const key = `${level.id}/${edition.id}`
  const hit = hoverJetRuns.get(key)
  if (hit) return hit
  const run = flyHoverJet(level, edition)
  hoverJetRuns.set(key, run)
  return run
}
const jumpSeatRuns = new Map<string, ReturnType<typeof flyJumpSeatMission>>()
const jumpSeatRun = (level: Level): ReturnType<typeof flyJumpSeatMission> => {
  const hit = jumpSeatRuns.get(level.id)
  if (hit) return hit
  const run = flyJumpSeatMission(level, { noTerrain: true, maxSeconds: WINDOW_SECONDS })
  jumpSeatRuns.set(level.id, run)
  return run
}

describe('smoke: all thirteen missions fly', () => {
  it('found the thirteen, seven HoverJet and six JumpSeat', () => {
    // A walk over an empty folder is a perfectly green nothing.
    expect(LEVELS.map((l) => l.id).length).toBe(13)
    expect(hoverJets.length).toBe(7)
    expect(jumpSeats.length).toBe(6)
    expect(EDITIONS.map((e) => e.id)).toEqual(['classic', 'anniversary'])
  })

  for (const level of hoverJets) {
    it(`${level.id}: the HoverJet flies it under both presets and the scorer is live`, () => {
      const runs = EDITIONS.map((edition) => hoverJetRun(level, edition))
      const [classic, anniversary] = runs
      if (!classic || !anniversary) throw new Error('two presets')

      for (const [i, run] of runs.entries()) {
        const tag = `${level.id}/${EDITIONS[i]?.id}`
        expect(run.elapsed, `${tag}: the clock never ran`).toBeGreaterThan(0)
        expect(run.maxSpeed, `${tag}: the ship never moved`).toBeGreaterThan(20)
        expect(MEDALS, `${tag}: medal ${String(run.medal)}`).toContain(run.medal)
      }

      // Rings are what a Ring Attack course IS. Free Flight (Kauai) has none
      // live, so it is held to "ran clean" above and to the orb scorer below.
      const mode = startMission(level).mode
      if (mode === 'ringAttack') {
        expect(
          classic.ringsPassed,
          `${level.id}: took no ring in ${WINDOW_SECONDS} s`,
        ).toBeGreaterThan(0)
        expect(classic.score, `${level.id}: rings scored nothing`).toBeGreaterThan(0)
        // The levers pay a bonus BESIDE the score; they do not change which ring
        // is which, and they go nowhere near `state.score` — the medal means
        // exactly what it meant in 2016, on the same flight (the preset's own
        // note on `maxBonus`, and DEV-110).
        expect(anniversary.order, `${level.id}: the presets disagree about the rings`).toEqual(
          classic.order,
        )
        expect(anniversary.score, `${level.id}: the levers moved the SCORE`).toBe(classic.score)
        // Classic's pool is dead twice over — `maxBonus` 0 — so it banks nothing;
        // Anniversary's is bounded by the design: at most `points × maxBonus`
        // per gate, rounded, so at most that plus a half-point of rounding each.
        expect(classic.proximityBanked, `${level.id}: Classic paid a proximity bonus`).toBe(0)
        const ceiling =
          classic.score * (EDITIONS[1]?.gameplay.proximity.maxBonus ?? Number.NaN) +
          0.5 * classic.ringsPassed
        expect(anniversary.proximityBanked, `${level.id}: bonus below zero`).toBeGreaterThanOrEqual(
          0,
        )
        expect(
          anniversary.proximityBanked,
          `${level.id}: bonus past its ceiling`,
        ).toBeLessThanOrEqual(ceiling)
      }

      // The medal arithmetic, end to end: what the run earned by the mission's
      // own curve is what `awardMedal` says that score is worth.
      const curve = medalCurve(level, mode)
      expect(medalThresholds(level, mode)).toEqual(curve)
      for (const run of runs) {
        if (curve) expect(run.medal).toBe(awardMedal(run.score, curve))
        else expect(run.medal).toBeNull()
      }
    })
  }

  for (const level of jumpSeats) {
    it(`${level.id}: the JumpSeat flies it and the pad scorer answers`, () => {
      const run = jumpSeatRun(level)
      const p = run.finalPosition
      expect(finite(p.x) && finite(p.y) && finite(p.z), `${level.id}: position`).toBe(true)
      expect(finite(run.score) && run.score >= 0, `${level.id}: score ${run.score}`).toBe(true)
      expect(finite(run.minFuel), `${level.id}: fuel`).toBe(true)
      expect(run.elapsed, `${level.id}: the clock never ran`).toBeGreaterThan(0)
      expect(run.maxSpeed, `${level.id}: the seat never moved`).toBeGreaterThan(5)
      expect(MEDALS, `${level.id}: medal ${String(run.medal)}`).toContain(run.medal)
      expect(run.pads, `${level.id}: no live pads`).toBeGreaterThan(0)
      // Half a minute is enough to take the first pad or two on every board;
      // a pad scorer that stopped listening would read zero here.
      expect(run.padsHit, `${level.id}: no pad hit in ${WINDOW_SECONDS} s`).toBeGreaterThan(0)
    })
  }

  it('prints the table', () => {
    // What a human reads when running this by hand — the assertions are above.
    const rows: string[] = []
    for (const level of hoverJets) {
      const run = hoverJetRun(level, EDITIONS[1] as Edition)
      rows.push(
        `${level.id.padEnd(19)} hoverjet  rings ${String(run.ringsPassed).padStart(2)}  score ${String(run.score).padStart(5)}  ${String(run.medal).padEnd(8)} ${run.elapsed.toFixed(1)} s`,
      )
    }
    for (const level of jumpSeats) {
      const run = jumpSeatRun(level)
      rows.push(
        `${level.id.padEnd(19)} jumpseat  pads  ${String(run.padsHit).padStart(2)}  score ${String(run.score).padStart(5)}  ${String(run.medal).padEnd(8)} ${run.elapsed.toFixed(1)} s`,
      )
    }
    console.info(`\n${rows.join('\n')}\n`)
    expect(rows).toHaveLength(13)
  })
})
