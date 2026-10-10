// tests/unit/helpers/override-race.ts — the AI racers, flown headlessly on a
// level as the game flies them, and the proof a shipped-course override must
// pass. DEV-541 (plan/SHIPPED-COURSE-EDITS.md §6.3).
//
// NOT a `.test.ts`, so vitest does not collect it. `override-racers.test.ts`
// runs every override in `content/overrides/` through `proveCourse`. The model
// is DEV-494's `ai-racer-hairpin.test.ts` (`flyGrid`), and the setup is the
// game's own, step for step:
//
//   the grid      `racerStarts(level, rules.racers)` and `assignTunings`: what
//                 `game/racers.ts`'s `loadRacers` builds from the live preset's
//                 `gameplay.racers`
//   the racer     `createAiRacer` from THREE space to SIM (`threeTupleToUnity`),
//                 its tuning out of `AI_RACER_TUNINGS` as shipped, so the
//                 DEV-494 aim floor is whatever `DEFAULT_AUTOPILOT` ships (the
//                 test asserts it is on rather than setting it)
//   the line      `createRoute(level.route)` and `gateArcLengths`: `loadRacers`
//   a step        `stepRacerField` with the preset's crash rule and its
//                 separation, contact and hit blocks, as `boot/app.ts` hands
//                 them to `liveRacers.step`
//
// What is NOT the game's: the player (none; the racers race each other), the
// props (none), and, unless one is handed in, the ground. Without it the race
// is in the air, as DEV-494's is; with it the racers fly over the mission's own
// height field and crash into it under a preset that crashes.
//
// ── What "flies the line and takes every ring" means, measured ─────────────
//
// Taking every ring is not enough. A racer that passes a ring's place on the
// line without scoring it is handed the RING as its aim (`routeGuidance`, "The
// only case the line cannot help with"), turns back and takes it. Measured on
// `int_01` with the line pushed 30 to 120 m off ring 6 or ring 11: every racer
// still took every ring and finished inside the time limit. So the proof also
// asks WHERE each ring was taken: the racer's cursor on the line must not yet
// have passed the ring's own place on it (`gateArcLengths`). On the six racing
// HoverJet courses as 2016 shipped them, and on the line "Edit the line"
// seeds for each, the least margin over every ring but the first, every racer
// and both rule sets was 12.2 m before the ring's place (adv_01, ring 15,
// `fast`); ring 1 is taken at exactly 0 (the line begins at it, and every
// racer leaves the grid flying AT it: `sim/route.ts`, gate 0). With the line's
// control point nearest ring 6 or ring 11 pushed 30 m sideways, the worst
// racer took the ring 67 to 142 m PAST its place. And with it pushed 20 m,
// ring 11's trigger still 19.8 m off the line (inside its 22.6 m radius, so
// the desk's `ring-off-line` is silent), one Anniversary racer in an outer
// lane missed it and came back from 141 m on: the proof sees what the warning
// cannot. That gap is the rule. The numbers are a measurement at DEV-541's
// commit, not a constant: the test holds the premise (2016's courses pass)
// rather than these figures.

import type { Edition } from '@/content/edition-schema'
import { type Level, liveRings } from '@/content/level-schema'
import { distanceToLine } from '@/editor/core/shipped'
import { courseGates } from '@/game/mission'
import { rulesFor, runningMode } from '@/game/modes'
import { racerStarts } from '@/game/racer-grid'
import { assignTunings } from '@/game/racers'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { AI_RACER_TUNINGS, type AiRacer, createAiRacer, gateArcLengths } from '@/sim/ai-racer'
import type { AutopilotTuning } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import { v3 } from '@/sim/math/vec3'
import { createRacerField, stepRacerField } from '@/sim/racer-field'
import { createRoute, routeDistance } from '@/sim/route'
import type { HeightField } from '@/sim/terrain/height-field'

type V = [number, number, number]

/** A preset, as far as a race reads one: its name and its `gameplay`. */
export type RaceRules = Pick<Edition, 'id' | 'gameplay'>

/** What one racer did. */
export interface RacerOutcome {
  readonly id: string
  readonly tuning: string
  /** Rings taken. */
  readonly rings: number
  readonly finished: boolean
  /** Seconds from the start, or null for a racer that did not finish. */
  readonly seconds: number | null
  /** The first ring it still owed, 1-based, or null when it took them all. */
  readonly owed: number | null
  /**
   * Per ring, in ring order (NaN for a ring not taken): metres BEFORE the
   * ring's own place on the line that the racer's cursor stood at the step it
   * scored. Negative: it had passed the ring's place and turned back for it.
   */
  readonly takenBefore: readonly number[]
  /** Per ring: metres from the line the racer was at that step. For the message. */
  readonly takenOffLine: readonly number[]
}

export interface RaceOutcome {
  readonly level: string
  readonly rules: string
  readonly rings: number
  readonly racers: readonly RacerOutcome[]
}

/**
 * The grid of `rules` flown on `level` for at most `seconds`, or until every
 * racer has finished. `ground`, when given, is the terrain the racers fly over
 * and, under a preset that crashes, crash into.
 */
export const flyRace = (
  level: Level,
  rules: RaceRules,
  seconds: number,
  ground: readonly HeightField[] = [],
): RaceOutcome => {
  const gates = courseGates(level)
  const route = createRoute((level.route ?? []) as V[])
  const guide = { route, gateArc: gateArcLengths(route, gates) }
  const starts = racerStarts(level, rules.gameplay.racers)
  const assigned = assignTunings(starts)
  const finish = level.finish
    ? {
        x: level.finish.pos[0] as number,
        y: level.finish.pos[1] as number,
        z: -(level.finish.pos[2] as number),
        radius: level.finish.radius,
      }
    : null
  const racers: AiRacer[] = starts.map((start, i) => {
    const { id, tuning } = assigned[i] as { id: string; tuning: string }
    const spawn = threeTupleToUnity(v3(), [start.pos[0], start.pos[1], start.pos[2]])
    const q = { x: 0, y: 0, z: 0, w: 1 }
    threeQuatTupleToUnity(q, start.quat as unknown as number[])
    return createAiRacer(
      {
        id,
        spawn,
        orientation: [q.x, q.y, q.z, q.w],
        tuning: AI_RACER_TUNINGS[tuning] as AutopilotTuning,
      },
      gates,
      finish,
    )
  })
  const field = createRacerField(racers, route)
  const g = rules.gameplay
  const takenBefore = racers.map(() => gates.map(() => Number.NaN))
  const takenOffLine = racers.map(() => gates.map(() => Number.NaN))
  const seen = racers.map(() => gates.map(() => false))
  for (let t = 0; t < Math.round(seconds / FIXED_DT) && !racers.every((r) => r.finished); t++) {
    stepRacerField(field, racers, gates, ground, FIXED_DT, guide, ground, g.crash, null, {
      separation: g.racers.separation,
      contact: g.racers.contact,
      player: null,
      hit: g.racers.hit,
    })
    racers.forEach((r, i) => {
      const was = seen[i] as boolean[]
      r.course.passed.forEach((passed, k) => {
        if (!passed || was[k]) return
        was[k] = true
        ;(takenBefore[i] as number[])[k] = (guide.gateArc[k] as number) - r.cursor.s
        ;(takenOffLine[i] as number[])[k] = routeDistance(route, r.jet.body.position)
      })
    })
  }
  return {
    level: level.id,
    rules: rules.id,
    rings: gates.length,
    racers: racers.map((r, i) => {
      const owed = r.course.passed.findIndex((p) => !p)
      return {
        id: r.spec.id,
        tuning: (assigned[i] as { tuning: string }).tuning,
        rings: r.gates,
        finished: r.finished,
        seconds: r.finished ? r.finishedAt : null,
        owed: owed < 0 ? null : owed + 1,
        takenBefore: takenBefore[i] as number[],
        takenOffLine: takenOffLine[i] as number[],
      }
    }),
  }
}

/** What is wrong with one race, one line per fault; empty is a pass. */
export const raceProblems = (race: RaceOutcome): string[] => {
  const out: string[] = []
  const where = `${race.level} under ${race.rules}'s rules`
  for (const r of race.racers) {
    if (r.rings !== race.rings) {
      out.push(
        `${where}: ${r.id} took ${r.rings} of ${race.rings} rings and never took ring ${r.owed}`,
      )
    } else if (!r.finished) {
      out.push(
        `${where}: ${r.id} took every ring but did not reach the finish inside the time limit`,
      )
    }
    r.takenBefore.forEach((m, k) => {
      if (!(m < 0)) return
      out.push(
        `${where}: ${r.id} took ring ${k + 1} ${(-m).toFixed(0)} m PAST its place on the line, ` +
          `${(r.takenOffLine[k] ?? 0).toFixed(0)} m off the line: the line misses the ring, ` +
          'and the racer turned back for it',
      )
    })
  }
  return out
}

/**
 * The proof a shipped course must pass (plan §6.3, DEV-541).
 *
 * On a mission whose mode RACES (`rulesFor(runningMode(level)).opponents`),
 * the AI racers of every preset in `presets` fly the course inside its own
 * time limit, and every racer takes every ring from the line, not by turning
 * back for it, and finishes. On a mission nobody races (`hoverJet_kauai_beg`
 * is Free Flight), the line is held to its geometry instead: every live ring's
 * trigger within its own radius of the line (`ring-off-line`'s rule), because
 * a racer flown where no racer flies proves nothing about the game.
 */
export const proveCourse = (
  level: Level,
  presets: readonly RaceRules[],
  ground: readonly HeightField[] = [],
): string[] => {
  if (!rulesFor(runningMode(level)).opponents) {
    const line = level.route ?? []
    return liveRings(level).flatMap((ring, k) => {
      const off = distanceToLine(ring.trigger.pos, line)
      return off > ring.trigger.radius
        ? [
            `${level.id} (${runningMode(level)}, no racers): ring ${k + 1}'s trigger is ` +
              `${off.toFixed(1)} m off the line, past its ${ring.trigger.radius.toFixed(1)} m radius`,
          ]
        : []
    })
  }
  return presets.flatMap((rules) =>
    raceProblems(flyRace(level, rules, level.timer.timeLimit, ground)),
  )
}
