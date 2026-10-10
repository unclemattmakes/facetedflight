// tests/unit/next-medal.test.ts: what the next medal takes, and the lap to beat. DEV-650.
//
// Two lines on the results panel. Bronze to gold are RINGS, because no speed buys
// a ring. Platinum is every ring plus half of a bounded clock term (DEV-846), so
// its line names the rings still to take AND a fast lap, or, once every ring is
// taken, the seconds the lap must lose. The test that matters is the one that
// flies the arithmetic through `awardMedal`, so the line is checked against the
// medal the game would award and not against a second copy of it.

import { describe, expect, it } from 'vitest'
import { retryGhost } from '@/game/ghost-pick'
import { pointsPerSecond, timeTermFor } from '@/game/medal-time'
import { awardMedal, medalThresholds } from '@/game/mission'
import { nextMedal, nextMedalLine } from '@/game/next-medal'
import { nextBeat, nextBeatLine } from '@/game/results-board'
import type { BoardEntry } from '@/net/lap-client'
import { levelJson as level } from './helpers/content'

const INT01 = level('int_01_hoverJet')

describe('the next medal', () => {
  it('names the rings still to take for the next band: int_01 at 1700 points is 2 rings from gold', () => {
    // 900 / 1400 / 1900 / 2100: 17 rings is past silver, 2 rings short of gold.
    expect(nextMedalLine(INT01, 'ringAttack', 1700)).toBe('2 MORE RINGS FOR GOLD')
  })

  it('says RING, not RINGS, at one', () => {
    expect(nextMedalLine(INT01, 'ringAttack', 1800)).toBe('1 MORE RING FOR GOLD')
  })

  it('DEV-846: platinum with rings left asks for a fast lap as well', () => {
    expect(nextMedalLine(INT01, 'ringAttack', 2000)).toBe('1 MORE RING AND A FAST LAP FOR PLATINUM')
    expect(nextMedalLine(INT01, 'ringAttack', 1950)).toBe(
      '2 MORE RINGS AND A FAST LAP FOR PLATINUM',
    )
  })

  it('DEV-846: with every ring taken, platinum is only seconds away, and the seconds are honest', () => {
    const term = timeTermFor(INT01) as NonNullable<ReturnType<typeof timeTermFor>>
    const curve = medalThresholds(INT01, 'ringAttack') as NonNullable<
      ReturnType<typeof medalThresholds>
    >
    // Every ring and none of the clock term: the whole platinum share is still to earn.
    const next = nextMedal(INT01, 'ringAttack', 2100)
    expect(next).toMatchObject({ band: 'platinum', units: 0, needsTime: true })
    const wanted = curve.platinum - 2100
    expect(wanted).toBe(term.platinumPoints)
    expect(next?.seconds).toBeCloseTo(wanted / pointsPerSecond(term), 0)
    expect(nextMedalLine(INT01, 'ringAttack', 2100)).toBe(
      `${next?.seconds?.toFixed(1)} S FASTER FOR PLATINUM`,
    )
    // Gaining exactly those seconds earns platinum: pace up by the stated time.
    const gained = Math.ceil((next?.seconds ?? 0) * pointsPerSecond(term))
    expect(awardMedal(2100 + gained, curve)).toBe('platinum')
    // One point short of the bar is still a few tenths of a second away.
    expect(nextMedal(INT01, 'ringAttack', curve.platinum - 1)?.seconds).toBeGreaterThan(0)
  })

  it('starts at bronze for a run with nothing', () => {
    expect(nextMedalLine(INT01, 'ringAttack', 0)).toBe('9 MORE RINGS FOR BRONZE')
  })

  it('has nothing to say at platinum', () => {
    const bar = (
      medalThresholds(INT01, 'ringAttack') as NonNullable<ReturnType<typeof medalThresholds>>
    ).platinum
    expect(nextMedalLine(INT01, 'ringAttack', bar)).toBeNull()
    expect(nextMedalLine(INT01, 'ringAttack', 2500)).toBeNull()
  })

  it('has nothing to say where the mode awards no medal (a lesson)', () => {
    expect(nextMedal(INT01, 'lesson', 0)).toBeNull()
  })

  it('counts orbs in Free Flight, in the mode own word', () => {
    // Free Flight's curve is a raw orb count, 3 / 5 / 9 / 12 held to what is live.
    const line = nextMedalLine(INT01, 'freeFlight', 4)
    expect(line).toMatch(/^\d+ MORE ORBS? FOR (SILVER|GOLD|PLATINUM|BRONZE)$/)
  })

  it('agrees with awardMedal: taking the rings it names earns the band it names', () => {
    const curve = medalThresholds(INT01, 'ringAttack')
    expect(curve).not.toBeNull()
    // Platinum is not a ring count any more (DEV-846): its line is tested above.
    for (const score of [0, 300, 900, 1300, 1700, 1800]) {
      const next = nextMedal(INT01, 'ringAttack', score)
      expect(next).not.toBeNull()
      if (!next) continue
      const after = score + next.units * INT01.scoring.gateMultiplier
      expect(awardMedal(after, curve as NonNullable<typeof curve>)).toBe(next.band)
      // And one ring fewer would not have been enough, unless it was one ring.
      if (next.units > 1) {
        const short = score + (next.units - 1) * INT01.scoring.gateMultiplier
        expect(awardMedal(short, curve as NonNullable<typeof curve>)).not.toBe(next.band)
      }
    }
  })
})

const lap = (id: string, handle: string, seconds: number, rank: number): BoardEntry =>
  ({ id, handle, seconds, rank }) as unknown as BoardEntry

const BOARD: BoardEntry[] = [
  lap('a', 'ace', 50.0, 1),
  lap('b', 'bob', 54.2, 2),
  lap('c', 'cat', 58.1, 3),
  lap('d', 'dan', 63.0, 4),
]
const NOBODY = { posted: new Set<string>(), handle: null }

describe('the lap to beat', () => {
  it('is the slowest board lap still faster than the lap on the panel', () => {
    const beat = nextBeat(BOARD, { ...NOBODY, eligible: 60.5 })
    expect(beat?.entry.handle).toBe('cat')
    expect(beat?.gap).toBeCloseTo(2.4, 9)
    expect(beat && nextBeatLine(beat)).toBe('NEXT: BEAT CAT, 2.4s FASTER')
  })

  it('is null for the fastest lap on the board: there is nothing above', () => {
    expect(nextBeat(BOARD, { ...NOBODY, eligible: 49 })).toBeNull()
  })

  it('is null with no lap of yours to measure from', () => {
    expect(nextBeat(BOARD, { ...NOBODY, eligible: null })).toBeNull()
  })

  it('measures from your own posted lap when that is faster than the lap on the panel', () => {
    const mine = lap('m', 'me', 56.0, 3)
    const beat = nextBeat([...BOARD, mine], {
      posted: new Set(['m']),
      handle: 'me',
      eligible: 61.0,
    })
    // Faster of the two is 56.0, and the lap above THAT is bob at 54.2.
    expect(beat?.entry.handle).toBe('bob')
    expect(beat?.mine).toBe(56.0)
  })

  it('never names your own line as the lap to beat', () => {
    const mine = lap('m', 'me', 52.0, 2)
    const beat = nextBeat([...BOARD, mine], { posted: new Set(['m']), handle: 'me', eligible: 70 })
    expect(beat?.entry.id).not.toBe('m')
    // Your best is 52.0, so the rival above it is ace.
    expect(beat?.entry.handle).toBe('ace')
  })

  it('reads a gap under half a tenth in hundredths, never as 0.0s', () => {
    const beat = nextBeat([lap('x', 'xan', 59.97, 1)], { ...NOBODY, eligible: 60.0 })
    expect(beat && nextBeatLine(beat)).toBe('NEXT: BEAT XAN, 0.03s FASTER')
  })
})

describe('a repeat attempt defaults its ghost', () => {
  it('to the lap above, when the player has not chosen one', () => {
    expect(retryGhost(false, BOARD, 60.5)?.handle).toBe('cat')
  })

  it('leaves a chosen ghost alone', () => {
    expect(retryGhost(true, BOARD, 60.5)).toBeNull()
  })

  it('leaves the default (your best) when nothing is faster', () => {
    expect(retryGhost(false, BOARD, 49)).toBeNull()
    expect(retryGhost(false, BOARD, null)).toBeNull()
  })
})
