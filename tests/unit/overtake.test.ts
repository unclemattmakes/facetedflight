// tests/unit/overtake.test.ts: a place gained or lost, and a ship going by (DEV-641).
//
// The watch reads `race-place.ts`'s own rule (`racerAhead`), so these tests
// build readings the way `placeNow` does and let the REAL rule decide who is
// ahead: the claim is that the event follows the number the race map shows, not
// a second opinion of ours.

import { describe, expect, it } from 'vitest'
import { actionsForEvent } from '@/audio/events'
import { createFlybyTracker } from '@/game/flyby'
import {
  createOvertakeWatch,
  FLYBY_WHOOSH_FLOOR,
  flybyWhooshGain,
  OVERTAKE,
  type OvertakeEvent,
  overtakeLabel,
} from '@/game/overtake'
import { livePlace, type RacerPlaceReading } from '@/game/race-place'
import { TRAUMA } from '@/render/camera-shake'

const racer = (name: string, reached: number, arc: number): RacerPlaceReading => ({
  standing: { name, seconds: null, status: 'flying' },
  progress: { reached, arc },
})

const DT = 1 / 60

/** Step `seconds` of frames with the same readings, collecting every event. */
const run = (
  watch: ReturnType<typeof createOvertakeWatch>,
  readings: readonly RacerPlaceReading[],
  player: { reached: number; arc: number },
  seconds: number,
  live = true,
): OvertakeEvent[] => {
  const events: OvertakeEvent[] = []
  for (let i = 0; i < Math.ceil(seconds / DT); i++) {
    const e = watch.step(readings, player, live, DT)
    if (e) events.push({ ...e })
  }
  return events
}

describe('a place changing', () => {
  const field = [racer('fast', 5, 900), racer('steady', 5, 700), racer('cutter', 4, 500)]

  it('says nothing for the first reading and nothing while the place holds', () => {
    const watch = createOvertakeWatch()
    expect(run(watch, field, { reached: 5, arc: 800 }, 3)).toEqual([])
    expect(watch.place).toBe(2)
  })

  it('reports a gain once it has held, and names the racer just passed', () => {
    const watch = createOvertakeWatch()
    run(watch, field, { reached: 5, arc: 800 }, 1)
    const events = run(watch, field, { reached: 5, arc: 950 }, 1)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ gained: true, from: 2, to: 1, name: 'fast' })
  })

  it('reports a loss and names the racer that passed the player', () => {
    const watch = createOvertakeWatch()
    run(watch, field, { reached: 5, arc: 800 }, 1)
    const events = run(watch, field, { reached: 5, arc: 600 }, 1)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ gained: false, from: 2, to: 3, name: 'steady' })
  })

  it('agrees with the live place the race map shows, at every step', () => {
    const watch = createOvertakeWatch()
    for (const arc of [100, 600, 800, 950, 1000]) {
      run(watch, field, { reached: 5, arc }, 1)
      expect(watch.place).toBe(livePlace(null, { reached: 5, arc }, field).place)
    }
  })

  it('ignores a swap that does not hold (two ships brushing)', () => {
    const watch = createOvertakeWatch()
    run(watch, field, { reached: 5, arc: 800 }, 1)
    // Three frames ahead of `fast`, then back: shorter than the hold.
    const blip = run(watch, field, { reached: 5, arc: 950 }, OVERTAKE.holdSeconds * 0.5)
    const back = run(watch, field, { reached: 5, arc: 800 }, 2)
    expect([...blip, ...back]).toEqual([])
    expect(watch.place).toBe(2)
  })

  it('two reports are at least a cooldown apart, and the second still lands', () => {
    const watch = createOvertakeWatch()
    run(watch, field, { reached: 5, arc: 800 }, 1)
    const first = run(watch, field, { reached: 5, arc: 950 }, OVERTAKE.holdSeconds + 0.1)
    expect(first).toHaveLength(1)
    // Straight back behind two of them: pending until the cooldown is served.
    const second = run(watch, field, { reached: 5, arc: 600 }, 3)
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({ gained: false, from: 1, to: 3 })
  })

  it('forgets everything when the race is not live (the line, a restart, the results)', () => {
    const watch = createOvertakeWatch()
    run(watch, field, { reached: 5, arc: 800 }, 1)
    expect(run(watch, field, { reached: 5, arc: 950 }, 1, false)).toEqual([])
    expect(watch.place).toBeNull()
    // And the first live reading afterwards is a baseline, not a change.
    expect(run(watch, field, { reached: 5, arc: 950 }, 1)).toEqual([])
    expect(watch.place).toBe(1)
  })

  it('no opposition is no race: no place, no event', () => {
    const watch = createOvertakeWatch()
    expect(run(watch, [], { reached: 3, arc: 100 }, 2)).toEqual([])
    expect(watch.place).toBeNull()
  })

  it('trap 19: stepping a second watch does not move the first', () => {
    const a = createOvertakeWatch()
    const b = createOvertakeWatch()
    run(a, field, { reached: 5, arc: 800 }, 1)
    run(b, field, { reached: 5, arc: 100 }, 1)
    expect(a.place).toBe(2)
    expect(b.place).toBe(3)
  })
})

describe('the event row and the cues', () => {
  it('words a gain and a loss with the place and the racer, in caps', () => {
    expect(overtakeLabel({ gained: true, from: 3, to: 2, name: 'cutter' })).toBe(
      '#2  PASSED CUTTER',
    )
    expect(overtakeLabel({ gained: false, from: 2, to: 3, name: 'fast' })).toBe('#3  FAST PASSES')
    expect(overtakeLabel({ gained: true, from: 2, to: 1, name: null })).toBe('#1')
  })

  it('a gain rises and a loss falls, and they are different cues', () => {
    const cue = (gained: boolean) => actionsForEvent({ type: 'race.position', gained }, [])[0]?.cue
    expect(cue(true)).toBe('race.gain')
    expect(cue(false)).toBe('race.loss')
  })

  it('the name stays up for two seconds', () => {
    expect(OVERTAKE.nameSeconds).toBe(2)
  })
})

describe('the flyby whoosh', () => {
  it('is louder for a harder pass, never silent, never past 1', () => {
    expect(flybyWhooshGain(0)).toBe(FLYBY_WHOOSH_FLOOR)
    expect(flybyWhooshGain(TRAUMA.flyby * 0.5)).toBeGreaterThan(FLYBY_WHOOSH_FLOOR)
    expect(flybyWhooshGain(TRAUMA.flyby)).toBe(1)
    expect(flybyWhooshGain(TRAUMA.flyby * 10)).toBe(1)
    expect(flybyWhooshGain(Number.NaN)).toBe(FLYBY_WHOOSH_FLOOR)
  })

  it('pans to the side the ship went by on, because it is played at where it WAS', () => {
    // The tracker's own pass, fed a ship that closes on the player and goes by on
    // the right; the cue is positioned at that ship, so the right-hand side is
    // the side heard. `side` and the cue's position must tell the same story.
    const tracker = createFlybyTracker()
    let pass = null as ReturnType<typeof tracker.step>
    let at = [0, 0, 0]
    for (let i = 0; i < 80; i++) {
      // Right of the player (right vector = +x), 10 m abeam, closing along z at 120 m/s.
      const z = 150 - i * 2
      const p = tracker.step('r', { dx: 10, dy: 0, dz: z, rx: 1, ry: 0, rz: 0 }, 1 / 60)
      if (p && !pass) {
        pass = { ...p }
        at = [10, 0, z]
      }
    }
    expect(pass).not.toBeNull()
    expect(pass?.side).toBe(1)
    const [action] = actionsForEvent(
      {
        type: 'ship.flyby',
        at: at as [number, number, number],
        gain: flybyWhooshGain(pass?.trauma ?? 0),
      },
      [],
    )
    expect(action).toMatchObject({ kind: 'play', cue: 'flyby.whoosh', at })
    expect(at[0]).toBeGreaterThan(0)
  })
})
