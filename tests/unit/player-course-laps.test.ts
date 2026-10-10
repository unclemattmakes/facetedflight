// tests/unit/player-course-laps.test.ts — DEV-467, step 6: laps on a player
// course are LOCAL ONLY.
//
// The premise, as lines rather than as a green run:
//   - `boot/app.ts` hands the lap run `lapRules(mission, edition, variant) ??
//     LOCAL_LAP_RULES`, and `lapRules` answers only for a course in
//     `content/lap-courses.json` (`net/lap-courses.ts`, `lapCourse`), which a
//     `pc_` id can never be: that file is generated from the shipped levels.
//   - `shareable` refuses a lap whose rules are `LOCAL_LAP_RULES`
//     (`game/lap-share.ts`), and `shareOffered` is `shareable(lapRun.last)`, so
//     the panel never offers Share and a press of it posts nothing.
//   - the results board's key is null where `lapRules` is (`resultsBoardKey`),
//     so no board is fetched.
// What this file adds is the thing that has to WORK on top of that: a lap
// flown on an expanded player course is kept as the local best under the
// course's id, and the next run races it.

import { describe, expect, it } from 'vitest'
import { STANDARD_VARIANT_ID } from '@/content/aircraft-schema'
import type { Level } from '@/content/level-schema'
import { validateLevel } from '@/content/level-schema'
import { expandPlayerCourse, type PlayerCourse, playerCourseId } from '@/content/player-course'
import { ghostKey, LOCAL_LAP_RULES, readLap } from '@/game/ghost-store'
import { createLapRun } from '@/game/lap-run'
import { shareable } from '@/game/lap-share'
import { startMission, stepMission } from '@/game/mission'
import { validateModeContent } from '@/game/modes'
import { LAP_COURSES, lapCourse, lapRules } from '@/net/lap-courses'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { autopilotActions, nextGate } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import { createHoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import int01 from '../../content/levels/int_01_hoverJet.json'

type V = [number, number, number]
const DONOR = validateLevel(int01 as unknown as Level)
const ED = 'anniversary'

/** Twelve points along 2016's own route, inside the boundary, rings every 400 m. */
const COURSE: PlayerCourse = (() => {
  const route = DONOR.route as V[]
  const points: V[] = []
  for (let i = 0; i < 12; i++) points.push(route[Math.round((i * (route.length - 1)) / 11)] as V)
  return {
    v: 2,
    island: 'simonet',
    sky: DONOR.id,
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    path: { points, gap: 400 },
    rings: [],
    start: { pos: points[0] as V, yaw: 0 },
    finish: { t: 0.9 },
    timeLimit: 240,
    name: ['Amber', 'Heron'],
  }
})()

const memory = (): Pick<Storage, 'getItem' | 'setItem'> & { map: Map<string, string> } => {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

describe('DEV-467 — a player course keeps its laps on this device, and offers them nowhere', () => {
  const level = validateModeContent(validateLevel(expandPlayerCourse(COURSE, DONOR)))

  it('the lap server has no board for it, under any preset or aircraft', () => {
    expect(level.id).toBe(playerCourseId(COURSE))
    expect(lapCourse(level.id)).toBeNull()
    // Every preset and variant a shipped course has a board under.
    const editions = new Set<string>()
    const variants = new Set<string>()
    for (const c of Object.values(LAP_COURSES.courses)) {
      for (const [e, r] of Object.entries(c.editions)) {
        editions.add(e)
        for (const v of Object.keys(r.variants)) variants.add(v)
      }
    }
    expect(editions.size, 'the premise: lap-courses.json has presets to ask about').toBeGreaterThan(
      0,
    )
    for (const e of editions) for (const v of variants) expect(lapRules(level.id, e, v)).toBeNull()
  })

  it('a lap flown on it carries the LOCAL rules, is kept under its id, is raced next, and is never shareable', () => {
    const storage = memory()
    const variant = STANDARD_VARIANT_ID
    const run = createLapRun({
      level,
      worldOffset: level.worldOffset as [number, number, number],
      mode: 'ringAttack',
      build: 'unit',
      // `boot/app.ts`'s own expression for the lap run's rules.
      rulesFor: (edition) => lapRules(level.id, edition, variant) ?? LOCAL_LAP_RULES,
      vehicle: `hoverjet:${variant}`,
      variant,
      urlTaint: [],
      storage,
    })
    expect(run.newRun(ED)).toBeNull()

    // The autopilot, as `lap-run.test.ts` flies it. A direct start: no rise.
    const jet = createHoverJet()
    jet.launched = true
    threeTupleToUnity(jet.body.position, level.spawn.pos as number[])
    threeQuatTupleToUnity(jet.body.orientation, level.spawn.quat as number[])
    const mission = startMission(level)
    run.release(jet.body, ED)
    let lap: ReturnType<typeof run.step> = null
    const steps = Math.ceil(level.timer.timeLimit / FIXED_DT)
    for (let tick = 1; tick <= steps && !lap; tick++) {
      const input = noInput()
      const gates = mission.course.gates
      const target = nextGate(gates, mission.course.passed)
      const finish = mission.finishGate as NonNullable<typeof mission.finishGate>
      const aim = target >= 0 ? (gates[target] as (typeof gates)[number]).centre : finish
      const beyond = target >= 0 ? (gates[target + 1]?.centre ?? finish) : null
      autopilotActions(jet.body, aim, input, undefined, [], Number.POSITIVE_INFINITY, beyond)
      stepHoverJet(jet, input)
      const ring = stepMission(mission, level, jet.body.position, FIXED_DT)
      lap = run.step(
        FIXED_DT,
        jet.body,
        { ring, finishCrossed: mission.finishCrossed, finished: mission.finished },
        ED,
      )
    }
    expect(lap, 'the autopilot finishes the course').not.toBeNull()
    expect(mission.ringsTotal).toBeGreaterThan(0)
    expect(lap?.gates).toBe(mission.ringsTotal)
    expect(lap?.doc.rules).toBe(LOCAL_LAP_RULES)
    expect(lap?.doc.mission).toBe(level.id)
    expect(lap).toMatchObject({ improved: true, stored: true, tainted: false })

    // Kept under the course's own id, and read back as that lap.
    expect([...storage.map.keys()]).toEqual([ghostKey(level.id, 'ringAttack', ED, variant)])
    const kept = readLap(
      {
        mission: level.id,
        mode: 'ringAttack',
        edition: ED,
        rules: LOCAL_LAP_RULES,
        vehicle: `hoverjet:${variant}`,
        variant,
      },
      storage,
    )
    expect(kept?.seconds).toBe(lap?.seconds)

    // The next run races it: your best, by default.
    expect(run.newRun(ED)?.source).toBe('best')

    // And the panel's Share is never offered for it.
    expect(shareable(lap)).toBe(false)
    expect(shareable(lap ? { ...lap, doc: { ...lap.doc, rules: 'x' } } : null)).toBe(true)
  })
})
