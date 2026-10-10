// tests/unit/racer-start-lowered.test.ts: the racers on 2016's two pads,
// lowered (DEV-554), still start, race and finish on every course they race.
//
// Matt, 2026-09-30: *"lower the racers"*. DEV-554 moves the two racers that
// start on 2016's own `ai` pads 0.959 m down on all five pad courses, so they
// sit in their (lift-sized, DEV-547) dishes as the player sits in the lift's.
// That is a SIM change: the racer is created at its start. So the claim is the
// race itself, flown both ways on one grid: every racer, from the preset's
// grid (`racerStarts`, `assignTunings`), takes every ring and finishes, with
// the lanes, the contact and the crash rule, under the shipped rule and under
// the old one (a launch with no `dish` falls back to DEV-158's stand-off). And
// what moved: how far, and what it did to each finish time. No terrain and no
// player, as `ai-racer-hairpin.test.ts`'s sweep flies them.

import { describe, expect, it } from 'vitest'
import { type Edition, validateEdition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { courseGates } from '@/game/mission'
import { racerStarts } from '@/game/racer-grid'
import { assignTunings } from '@/game/racers'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { AI_RACER_TUNINGS, type AiRacer, createAiRacer, gateArcLengths } from '@/sim/ai-racer'
import type { AutopilotTuning } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import { v3 } from '@/sim/math/vec3'
import { createRacerField, stepRacerField } from '@/sim/racer-field'
import { createRoute } from '@/sim/route'
import anniversaryJson from '../../content/editions/anniversary.json'
import adv01 from '../../content/levels/adv_01_hoverJet.json'
import adv02 from '../../content/levels/adv_02_hoverJet.json'
import int01 from '../../content/levels/int_01_hoverJet.json'
import int02 from '../../content/levels/int_02_hoverJet.json'

type V = [number, number, number]
const E: Edition = validateEdition(anniversaryJson as unknown as Edition)
const FIELD_RULES = {
  separation: E.gameplay.racers.separation,
  contact: E.gameplay.racers.contact,
  player: null,
  hit: null,
}

/** The four pad courses that race (Kauai is forced to Free Flight: no race). */
const COURSES = [adv01, adv02, int01, int02] as unknown as Level[]

/** `level` as it was before DEV-554: no `launch.dish`, so DEV-158's rule. */
const before = (level: Level): Level => {
  const copy = JSON.parse(JSON.stringify(level)) as Level
  delete (copy.spawn.launch as unknown as Record<string, unknown>).dish
  return copy
}

/** The grid flown to the finish; each racer with where it started. */
const fly = (level: Level): { racer: AiRacer; id: string; startY: number; from: string }[] => {
  const gates = courseGates(level)
  const route = createRoute(level.route as V[])
  const guide = { route, gateArc: gateArcLengths(route, gates) }
  const starts = racerStarts(level, E.gameplay.racers)
  const assigned = assignTunings(starts)
  const racers = starts.map((start, i) => {
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
      level.finish
        ? {
            x: level.finish.pos[0] as number,
            y: level.finish.pos[1] as number,
            z: -(level.finish.pos[2] as number),
            radius: level.finish.radius,
          }
        : null,
    )
  })
  const field = createRacerField(racers, route)
  for (let t = 0; t < Math.round(240 / FIXED_DT) && !racers.every((r) => r.finished); t++) {
    stepRacerField(
      field,
      racers,
      gates,
      [],
      FIXED_DT,
      guide,
      [],
      E.gameplay.crash,
      null,
      FIELD_RULES,
    )
  }
  return racers.map((racer, i) => ({
    racer,
    id: (assigned[i] as { id: string }).id,
    startY: starts[i]?.pos[1] as number,
    from: starts[i]?.from.kind as string,
  }))
}

describe('DEV-554: the lowered racers still start, race and finish', () => {
  for (const level of COURSES) {
    it(`${level.id}: every racer takes every ring and finishes, lowered and as before`, () => {
      const gates = courseGates(level).length
      const now = fly(level)
      const then = fly(before(level))
      const census: string[] = []
      now.forEach((r, i) => {
        const was = then[i] as (typeof then)[number]
        expect(r.racer.finished, `${level.id} ${r.id}: finished`).toBe(true)
        expect(r.racer.gates, `${level.id} ${r.id}: every ring`).toBe(gates)
        expect(was.racer.finished, `${level.id} ${r.id}: finished before too`).toBe(true)
        const moved = was.startY - r.startY
        if (r.from === 'pad') {
          // The two that moved: down 0.959 m, and nothing else of them.
          expect(moved, `${level.id} ${r.id}`).toBeCloseTo(0.959, 3)
        } else expect(moved, `${level.id} ${r.id}: did not move`).toBe(0)
        census.push(
          `${r.id}${r.from === 'pad' ? '*' : ''} ${(was.racer.finishedAt as number).toFixed(2)} -> ${(r.racer.finishedAt as number).toFixed(2)} s`,
        )
      })
      console.info(`DEV-554 ${level.id} finish times (* = moved): ${census.join(' / ')}`)
      expect(now.filter((r) => r.from === 'pad')).toHaveLength(2)
    }, 60_000)
  }
})
