// src/game/autopilot-lap.ts: a real `int_01` lap, flown and recorded. DEV-372.
//
// It lived in `tests/unit/helpers/` until DEV-521 moved it here, unchanged, so
// the making-of site's lap-server toy flies the same lap the unit tests judge
// rather than a second copy of this loop (docs/plan/MAKING-OF.md §2.3). The
// game itself does not call it.
//
// The lap the lap server's tests judge, and forge from. Flown the way
// `tests/unit/ghost-record.test.ts` flies DEV-370's — the autopilot, through
// `stepHoverJet` at the fixed step, from the lift's release, `stepMission`
// deciding rings and the finish, the pose recorded AFTER each step — with ONE
// difference: the speed chain is on. `chainGate` on every scored ring, as
// `boot/app.ts` does, so the lap reaches the chained speeds the ceiling exists
// to allow (DEV-370's harness never banked a ring and topped out at 179.5 m/s,
// under the UNCHAINED terminal, which could not tell a chain-aware ceiling
// from §7.1's flat 182).
//
// Besides the decimated lap it keeps the FULL-RATE recording, because every
// forgery in `lap-validate.test.ts` is made the way a cheat would make one: by
// editing poses and ticks and running them back through the real recorder.

import type { Level } from '@/content/level-schema'
import { startMission, stepMission } from '@/game/mission'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { autopilotActions, nextGate } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import { createLapRecorder, type LapRecorder, markLapEvent, recordPose } from '@/sim/ghost-record'
import { createHoverJet, type HoverJetSheet, noInput, stepHoverJet } from '@/sim/hoverjet'
import { chainGate } from '@/sim/speed-chain'

export interface AutopilotLap {
  /** Every tick from the release (tick 0) to the finish tick, and the events. */
  readonly rec: LapRecorder
  /** The live run's finish tick and `finishAt`, the mission clock's own sum. */
  readonly finishTick: number
  readonly finishAt: number
  readonly rings: number
  /** Gate index -> the tick the live run took it. */
  readonly ringTicks: ReadonlyMap<number, number>
  /** The fastest the body went, m/s. */
  readonly topSpeed: number
}

/**
 * `sheet` is the aircraft variant's view of the sheet (`hoverJetView(scale)`,
 * DEV-380): the default is 2016's HoverJet, `standard`.
 */
export const flyAutopilotLap = (
  level: Level,
  worldOffset: readonly [number, number, number],
  sheet?: HoverJetSheet,
  /**
   * DEV-389: where the lap is released, THREE space, AT the release altitude —
   * a room's row start (`roomRowStarts`). Absent: the pad, `spawn.pos` raised
   * by the launch's rise.
   */
  start?: readonly number[],
): AutopilotLap => {
  const jet = sheet ? createHoverJet(sheet) : createHoverJet()
  jet.launched = true
  threeQuatTupleToUnity(jet.body.orientation, level.spawn.quat as number[])
  if (start) threeTupleToUnity(jet.body.position, start as number[])
  else {
    threeTupleToUnity(jet.body.position, level.spawn.pos as number[])
    jet.body.position.y += level.spawn.launch?.rise ?? 0
  }

  const mission = startMission(level)
  const steps = Math.ceil(level.timer.timeLimit / FIXED_DT)
  const rec = createLapRecorder(worldOffset, steps)
  const input = noInput()
  const ringTicks = new Map<number, number>()
  let finishTick = -1
  let topSpeed = 0

  recordPose(rec, 0, jet.body.position, jet.body.orientation)
  for (let tick = 1; tick <= steps; tick++) {
    const gates = mission.course.gates
    const target = nextGate(gates, mission.course.passed)
    const finishGate = mission.finishGate as NonNullable<typeof mission.finishGate>
    const aim = target >= 0 ? (gates[target] as (typeof gates)[number]).centre : finishGate
    const after = target >= 0 ? (gates[target + 1]?.centre ?? finishGate) : null
    autopilotActions(jet.body, aim, input, undefined, [], Number.POSITIVE_INFINITY, after)
    stepHoverJet(jet, input)
    recordPose(rec, tick, jet.body.position, jet.body.orientation)
    const v = jet.body.velocity
    topSpeed = Math.max(topSpeed, Math.hypot(v.x, v.y, v.z))
    const ring = stepMission(mission, level, jet.body.position, FIXED_DT)
    if (ring >= 0) {
      chainGate(jet.chain)
      ringTicks.set(ring, tick)
      markLapEvent(rec, tick, 'gate')
    }
    if (mission.finishCrossed) {
      finishTick = tick
      markLapEvent(rec, tick, 'finish')
      break
    }
  }
  return {
    rec,
    finishTick,
    finishAt: mission.finishAt as number,
    rings: mission.ringsPassed,
    ringTicks,
    topSpeed,
  }
}
