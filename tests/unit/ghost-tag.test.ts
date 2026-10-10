// tests/unit/ghost-tag.test.ts: DEV-856, the ghost named where it happens.
//
// The tag over the ghost's ship ("YOUR GHOST 61.2"), the words on a split and
// the results plate's keep row. Pure: strings and a distance fade.

import { describe, expect, it } from 'vitest'
import {
  GHOST_TAG_FAR_M,
  GHOST_TAG_FULL_M,
  GHOST_TAG_GONE_M,
  GHOST_TAG_HIDE_M,
  ghostTagAlpha,
} from '@/game/ghosts'
import { LAP_ASK_NOTE_MAX, LAP_ASK_ROW, type LapAskFacts, lapAskRows } from '@/game/lap-ask'
import { ghostName, ghostTagText, type RaceGhost } from '@/game/lap-run'
import { SHARE_IDLE } from '@/game/lap-share'
import { gapText } from '@/game/split-times'

const ghost = (handle: string | null, seconds: number | null): RaceGhost =>
  ({ handle, result: { seconds, gates: 0, ringTimes: [] } }) as unknown as RaceGhost

describe('the ghost is called YOUR GHOST', () => {
  it('names your own lap, and a shared one by its poster', () => {
    expect(ghostName(ghost(null, 61.24))).toBe('YOUR GHOST')
    expect(ghostName(ghost('Bold Heron 77', 58.2))).toBe('BOLD HERON 77')
  })

  it('tags it with the lap it flies, in tenths', () => {
    expect(ghostTagText(ghost(null, 61.24))).toBe('YOUR GHOST 61.2')
    expect(ghostTagText(ghost('Bold Heron 77', 58.2))).toBe('BOLD HERON 77 58.2')
    expect(ghostTagText(ghost(null, null))).toBe('YOUR GHOST')
    expect(ghostTagText(null)).toBeNull()
  })

  it('reads on a split as YOUR GHOST +1.4 and YOUR GHOST -0.8', () => {
    const line = (g: number): string => `${ghostName(ghost(null, 60))} ${gapText(g)}`
    expect(line(1.4)).toBe('YOUR GHOST +1.4')
    expect(line(-0.8)).toBe('YOUR GHOST -0.8')
  })
})

describe('the tag fades with distance and never sits in the cockpit', () => {
  it('is gone close in, full in the middle, gone far out', () => {
    expect(ghostTagAlpha(0)).toBe(0)
    expect(ghostTagAlpha(GHOST_TAG_HIDE_M)).toBe(0)
    expect(ghostTagAlpha(GHOST_TAG_FULL_M)).toBe(1)
    expect(ghostTagAlpha(100)).toBe(1)
    expect(ghostTagAlpha(GHOST_TAG_FAR_M)).toBe(1)
    expect(ghostTagAlpha(GHOST_TAG_GONE_M)).toBe(0)
    expect(ghostTagAlpha(5000)).toBe(0)
  })

  it('ramps monotonically on both sides', () => {
    let prev = 0
    for (let d = GHOST_TAG_HIDE_M; d <= GHOST_TAG_FULL_M; d += 1) {
      const a = ghostTagAlpha(d)
      expect(a).toBeGreaterThanOrEqual(prev)
      prev = a
    }
    for (let d = GHOST_TAG_FAR_M; d <= GHOST_TAG_GONE_M; d += 10) {
      const a = ghostTagAlpha(d)
      expect(a).toBeLessThanOrEqual(prev)
      prev = a
    }
  })

  it('starts further out than the hull is hidden', () => {
    // PLAYER_GHOST_NEAR_M is 6: a tag 4 m above a hull 7 m away is in the eye.
    expect(GHOST_TAG_HIDE_M).toBeGreaterThan(6)
  })
})

describe('the results plate says SAVED AS YOUR GHOST', () => {
  const facts = (over: Partial<LapAskFacts>): LapAskFacts => ({
    share: SHARE_IDLE,
    boarded: false,
    postable: false,
    taint: [],
    kept: true,
    savedBefore: null,
    home: 'hangar',
    ...over,
  })
  const keep = (over: Partial<LapAskFacts>) =>
    lapAskRows(facts(over)).find((r) => r.id === LAP_ASK_ROW.keep)

  it('names the save and what it means, once it is true', () => {
    expect(keep({ kept: true })).toMatchObject({
      label: 'Saved as your ghost',
      value: 'Yes',
      note: 'it flies with you next time on this course',
    })
  })

  it('is a question again when the answer is no', () => {
    expect(keep({ kept: false })?.label).toBe('Save as your ghost?')
  })

  it('every note fits the plate', () => {
    for (const row of [
      keep({ kept: true }),
      keep({ kept: true, savedBefore: 61.2 }),
      keep({ kept: true, savedBefore: 161.2 }),
      keep({ kept: false, savedBefore: 61.2 }),
    ])
      expect(row?.note.length).toBeLessThanOrEqual(LAP_ASK_NOTE_MAX)
  })
})
