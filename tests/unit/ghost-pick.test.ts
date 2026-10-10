// tests/unit/ghost-pick.test.ts — the hangar's ghost line on a course card. DEV-373.
//
// PLAYER-GHOSTS §4.2 door 2 and §8 call 8: your best by default, an online
// ghost only when a press asks for one. So the cycle opens on `best`, and
// "the lap just above yours" is held to its meaning — the NEXT lap to beat,
// the slowest of the faster ones — against a board built so that the fastest
// and the next-faster disagree.

import { describe, expect, it } from 'vitest'
import {
  type BoardView,
  DEFAULT_GHOST_PICK,
  GHOST_PICKS,
  ghostLine,
  lapAbove,
  nextGhostPick,
  pickEntry,
  pickNeedsBoard,
} from '@/game/ghost-pick'
import type { BoardEntry } from '@/net/lap-client'
import { lapRules } from '@/net/lap-courses'

const entry = (
  rank: number,
  seconds: number,
  handle = `Swift Kestrel ${10 + rank}`,
): BoardEntry => ({
  rank,
  id: `Lap${String(rank).padStart(7, '0')}`,
  handle,
  seconds,
  rings: 21,
})
const BOARD: BoardView = {
  status: 'ready',
  entries: [entry(1, 58.2, 'Bold Heron 77'), entry(2, 61.0), entry(3, 64.5), entry(4, 70.1)],
}

describe('the cycle', () => {
  it('opens on your best, and goes best → world #1 → above yours → none → best', () => {
    expect(DEFAULT_GHOST_PICK).toBe('best')
    const seen = [DEFAULT_GHOST_PICK]
    for (let i = 0; i < GHOST_PICKS.length; i++) seen.push(nextGhostPick(seen.at(-1) as never))
    expect(seen).toEqual(['best', 'world', 'above', 'none', 'best'])
  })

  it('a link’s pick leaves the cycle on the next press, back to your best', () => {
    expect(nextGhostPick('link')).toBe('best')
  })

  it('DEV-488 follow-up: a course with no board cycles best → none, and never names the board', () => {
    // A player course: its `pc_` id is a hash of the course, and the lap
    // server knows no rules for it, so no pick may ask for its board (/privacy).
    const pc = 'pc_0123456789ab'
    expect(lapRules(pc, 'anniversary', 'standard'), 'the premise: no board').toBeNull()
    for (const from of [...GHOST_PICKS, 'link'] as const) {
      const next = nextGhostPick(from, false)
      expect(pickNeedsBoard(next), `${from} → ${next}`).toBe(false)
    }
    const seen = [DEFAULT_GHOST_PICK]
    for (let i = 0; i < 4; i++) seen.push(nextGhostPick(seen.at(-1) as never, false))
    expect(seen).toEqual(['best', 'none', 'best', 'none', 'best'])
    // A shipped course's cycle is untouched.
    expect(lapRules('int_01_hoverJet', 'anniversary', 'standard')).not.toBeNull()
    expect(nextGhostPick('best', true)).toBe('world')
  })

  it('fetches only for the two picks that name a board lap (§8 call 8: online is opt-in)', () => {
    expect(GHOST_PICKS.filter(pickNeedsBoard)).toEqual(['world', 'above'])
    expect(pickNeedsBoard(DEFAULT_GHOST_PICK)).toBe(false)
  })
})

describe('the lap just above yours', () => {
  it('is the SLOWEST lap still faster than yours: the next one to beat', () => {
    expect(lapAbove(BOARD.status === 'ready' ? BOARD.entries : [], 66.0)?.rank).toBe(3)
    expect(pickEntry('above', BOARD, 66.0)?.rank).toBe(3)
    // Not the fastest, which is world #1's pick.
    expect(pickEntry('world', BOARD, 66.0)?.rank).toBe(1)
  })

  it('is nothing with no time of yours, when you are first, or when level with the next', () => {
    expect(pickEntry('above', BOARD, null)).toBeNull()
    expect(pickEntry('above', BOARD, 50.0)).toBeNull()
    expect(pickEntry('above', BOARD, 58.2)).toBeNull()
  })

  it('names nothing while the board is loading or failed', () => {
    expect(pickEntry('world', { status: 'loading' }, 66)).toBeNull()
    expect(pickEntry('world', { status: 'failed', reason: 'x' }, 66)).toBeNull()
    expect(pickEntry('world', null, 66)).toBeNull()
  })
})

describe('the line', () => {
  it('says whose lap, and how fast, for every pick', () => {
    expect(ghostLine('best', { mine: 77.54, board: null })).toBe('GHOST: YOUR SAVED LAP 77.5s')
    expect(ghostLine('best', { mine: null, board: null })).toBe('GHOST: NONE SAVED YET')
    expect(ghostLine('world', { mine: 77.5, board: BOARD })).toBe('GHOST: #1 BOLD HERON 77 58.2s')
    expect(ghostLine('above', { mine: 66, board: BOARD })).toBe('GHOST: #3 SWIFT KESTREL 13 64.5s')
    expect(ghostLine('none', { mine: 66, board: BOARD })).toBe('GHOST: OFF')
    expect(
      ghostLine('link', {
        mine: null,
        board: null,
        link: { handle: 'Bold Heron 77', seconds: 61.44 },
      }),
    ).toBe('GHOST: BOLD HERON 77 61.4s')
  })

  it('says why when a pick names nothing', () => {
    expect(ghostLine('world', { mine: null, board: { status: 'loading' } })).toBe(
      'GHOST: LEADERBOARD #1 · LOADING',
    )
    expect(ghostLine('world', { mine: null, board: { status: 'failed', reason: 'x' } })).toBe(
      'GHOST: LEADERBOARD #1 · OFFLINE',
    )
    expect(ghostLine('world', { mine: null, board: { status: 'ready', entries: [] } })).toBe(
      'GHOST: LEADERBOARD #1 · NO LAPS YET',
    )
    expect(ghostLine('above', { mine: null, board: BOARD })).toBe(
      'GHOST: NEXT ONE UP · SAVE A LAP FIRST',
    )
    expect(ghostLine('above', { mine: 40, board: BOARD })).toBe('GHOST: NEXT ONE UP · NONE FASTER')
  })

  it('fits the card: the longest line, with its button, in the 49 characters a card holds', () => {
    const long = entry(100, 188.84, 'Crimson Albatross 99')
    const line = `${ghostLine('world', { mine: null, board: { status: 'ready', entries: [long] } })} [R STICK]`
    expect(line.length).toBeLessThanOrEqual(49)
  })
})
