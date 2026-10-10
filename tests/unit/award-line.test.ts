// tests/unit/award-line.test.ts — the event line after the finish. DEV-397.
//
// `docs/BUGS.md`: *"After the finish the row still says `BOOST READY`."* The
// premise is the first block, read off the real mission step rather than
// restated: the run's clock STOPS at the finish, so an award timed in it cannot
// expire there. The rule is `game/award-line.ts`'s; the last block holds
// `boot/app.ts` to calling it before the panel is fed.

import { describe, expect, it } from 'vitest'
import { type Award, type FinishLatch, settleAward } from '@/game/award-line'
import { startMission, stepMission } from '@/game/mission'
import { FIXED_DT } from '@/sim/constants'
import { v3 } from '@/sim/math/vec3'
import { appFileThroughWith, inOrder } from './helpers/app-source'
import { levelJson as level } from './helpers/content'

describe('the premise: the run clock stops at the finish', () => {
  it('a finished mission steps without advancing `elapsed`', () => {
    const L = level('int_01_hoverJet')
    const s = startMission(L)
    const at = v3(0, 500, 0)
    for (let i = 0; i < 10; i++) stepMission(s, L, at, FIXED_DT)
    const before = s.elapsed
    expect(before).toBeGreaterThan(0)
    s.finished = true
    for (let i = 0; i < 1000; i++) stepMission(s, L, at, FIXED_DT)
    // So `elapsed < award.until` can never turn false once the run is over.
    expect(s.elapsed).toBe(before)
  })
})

/** The frames after a finish at run second 80, on a frame clock in ms. */
const settleFrames = (
  awards: readonly (Award | null)[],
  run: { elapsed: number; finished: boolean },
  frameMs: readonly number[],
): (string | null)[] => {
  let latch: FinishLatch | null = null
  return frameMs.map((now, i) => {
    const out = settleAward(awards[i] ?? null, run, latch, now)
    latch = out.latch
    return out.award?.text ?? null
  })
}

describe('settleAward', () => {
  const RUN = { elapsed: 80, finished: false }
  const DONE = { elapsed: 80, finished: true }

  it('changes nothing while the run is live', () => {
    const a: Award = { text: 'CLEAN x3', until: 81.6 }
    expect(settleAward(a, RUN, null, 0)).toEqual({ award: a, latch: null })
    // Even an expired one: its own `until` against a running clock is the rule.
    const old: Award = { text: 'LOW +10', until: 79 }
    expect(settleAward(old, RUN, null, 0).award).toBe(old)
  })

  it('keeps the award live AT the finish for the rest of its dwell, on the frame clock', () => {
    // Raised 0.4 s before the finish with 1.6 s of dwell: 1.2 s left.
    const gate: Award = { text: 'CLEAN x3  LOW +10', until: 81.2 }
    const shown = settleFrames([gate, gate, gate, gate], DONE, [1000, 1500, 2150, 2250])
    expect(shown).toEqual(['CLEAN x3  LOW +10', 'CLEAN x3  LOW +10', 'CLEAN x3  LOW +10', null])
  })

  it('drops anything raised AFTER the finish — the boost edge that stuck for good', () => {
    const ready: Award = { text: 'BOOST READY', until: 81.5 }
    // Nothing live at the finish; the tank then recharges and the edge fires.
    const shown = settleFrames([null, ready, ready, ready], DONE, [0, 100, 2000, 60_000])
    expect(shown).toEqual([null, null, null, null])
  })

  it('drops an award that had already expired when the run finished', () => {
    const stale: Award = { text: 'CLOSE  +25', until: 79.9 }
    expect(settleFrames([stale, stale], DONE, [0, 16])).toEqual([null, null])
  })

  it('lets go of the latch when a new run starts', () => {
    const gate: Award = { text: 'CLEAN', until: 81 }
    const done = settleAward(gate, DONE, null, 0)
    expect(done.latch).not.toBeNull()
    const again = settleAward(gate, { elapsed: 0.5, finished: false }, done.latch, 10)
    expect(again.latch).toBeNull()
    expect(again.award).toBe(gate)
  })
})

describe('boot/app.ts settles the award before it feeds the panel', () => {
  it('calls settleAward on every frame the HUD is fed, ahead of the update', () => {
    // One file, and both anchors in it in order: `inOrder` throws on a miss, so
    // this cannot pass on a -1 (APP-SPLIT phase 0).
    const settle = 'settleAward(award, mission, awardLatch, frameT0)'
    const app = appFileThroughWith(settle).text
    const [settleAt, updateAt] = inOrder(app, [settle, 'flight.hud.update(']) as [number, number]
    // With nothing between them that could raise a new award.
    expect(app.slice(settleAt, updateAt)).not.toMatch(/award = \{/)
  })
})
