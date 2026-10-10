// tests/unit/race-labels.test.ts: DEV-853, DEV-854, DEV-855 (Matt, 2026-10-08).
//
//  · DEV-853: Free Flight's boost never runs out. Asserted by STEPPING the tank
//    on Anniversary's own numbers, with the stick held, from an empty start.
//  · DEV-854: an AI rival is tagged wherever racers are listed; a human in a
//    room and a recording are not.
//  · DEV-855: the player's own line is `you`, carrying the callsign beside it.

import { describe, expect, it } from 'vitest'
import { MODES, rulesFor } from '@/game/modes'
import { racerStanding, withStandings } from '@/game/results-state'
import { createSplitTracker, splitLine } from '@/game/split-times'
import { FIXED_DT } from '@/sim/constants'
import { createEnergy, energySpec, fillEnergy, stepEnergy } from '@/sim/energy'
import anniversary from '../../content/editions/anniversary.json'

describe('DEV-853: Free Flight boost never runs out', () => {
  const spec = energySpec(
    anniversary.gameplay.energy.rechargeScale,
    undefined,
    anniversary.gameplay.energy.lockoutScale,
    anniversary.gameplay.energy.reengage,
  )

  it('only Free Flight carries the rule', () => {
    const on = Object.entries(MODES)
      .filter(([, rules]) => rules.infiniteBoost)
      .map(([mode]) => mode)
    expect(on).toEqual(['freeFlight'])
  })

  it('a held stick from an EMPTY start lights every tick for ten minutes', () => {
    const tank = createEnergy(spec, anniversary.gameplay.energy.startFill)
    let unlit = 0
    for (let i = 0; i < Math.ceil(600 / FIXED_DT); i++) {
      // The frame's order: fill, step, fill.
      fillEnergy(tank, spec)
      if (!stepEnergy(tank, spec, true, FIXED_DT)) unlit += 1
      fillEnergy(tank, spec)
    }
    expect(unlit).toBe(0)
    expect(tank.energy).toBe(spec.maxEnergy)
  })

  it('and the same stick, left to the tank, does run dry (the rule is the difference)', () => {
    const tank = createEnergy(spec, 1)
    let dry = false
    for (let i = 0; i < Math.ceil(30 / FIXED_DT) && !dry; i++) {
      stepEnergy(tank, spec, true, FIXED_DT)
      dry = tank.drained
    }
    expect(dry).toBe(true)
  })

  it('a forced mode follows the rule, through the descriptor', () => {
    expect(rulesFor('freeFlight').infiniteBoost).toBe(true)
    expect(rulesFor('ringAttack').infiniteBoost).toBe(false)
  })
})

describe('DEV-854 and DEV-855: who is listed, and who is you', () => {
  const racer = {
    spec: { id: 'fast', callsign: 'Crimson Falcon' },
    finished: true,
    finishedAt: 70,
    elapsed: 70,
  }

  it('a live racer is an AI on the board', () => {
    expect(racerStanding(racer, 0)).toMatchObject({ name: 'Crimson Falcon', ai: true })
    expect(racerStanding({ ...racer, finished: false }, 0)).toMatchObject({ ai: true })
  })

  it('the board tags the rivals and not the player, and carries the callsign on the you row', () => {
    const board = withStandings(
      {
        finishedAt: 75,
        // The rest of the summary is not read by the board.
      } as Parameters<typeof withStandings>[0],
      [racerStanding(racer, 0), { name: 'Swift Kestrel', seconds: 80, status: 'finished' }],
      [],
      'Bold Heron',
    )
    const me = board.standings.find((s) => s.you)
    expect(me).toMatchObject({ name: 'you', callsign: 'Bold Heron' })
    expect(me?.ai).toBeUndefined()
    expect(board.standings.filter((s) => s.ai).map((s) => s.name)).toEqual(['Crimson Falcon'])
    // A human in a room is not tagged.
    expect(board.standings.find((s) => s.name === 'Swift Kestrel')?.ai).toBeUndefined()
  })

  it('no callsign on the device leaves the you row bare', () => {
    const board = withStandings({ finishedAt: 75 } as Parameters<typeof withStandings>[0], [
      racerStanding(racer, 0),
    ])
    expect(board.standings.find((s) => s.you)).not.toHaveProperty('callsign')
  })

  it('a split against a racer is tagged AI and named as the results name it', () => {
    const tracker = createSplitTracker()
    const passed = [true, true, true, true]
    tracker.observe([{ spec: racer.spec, elapsed: 10, course: { passed } }])
    const split = tracker.playerPass(3, 11, 8, null)
    expect(split?.entries[0]).toMatchObject({ label: 'CRIMSON FALCON', ai: true })
    expect(split ? splitLine(split) : '').toContain('CRIMSON FALCON AI +')
  })
})
