// tests/unit/lap-share.test.ts: posting a lap, as states and words. DEV-373;
// a question on the results panel's menu since DEV-571.
//
// PLAYER-GHOSTS §8 call 9: posting is explicit. So these hold the two things a
// careless Share gets wrong: that a lap which may not be posted is never
// posted (a tainted one above all: D30's `runTainted`, DEV-371), and that
// nothing posts without the press on POST TO LEADERBOARD?, whose name is on
// screen before it (DEV-571: the row's note).

import { describe, expect, it } from 'vitest'
import { LOCAL_LAP_RULES } from '@/game/ghost-store'
import {
  boardedLap,
  deleteFailed,
  keepPosted,
  linkDetail,
  pressShare,
  rerollShare,
  SHARE_IDLE,
  type ShareState,
  shareAsking,
  shareable,
  shareBlock,
  shareDeleted,
  shareFailed,
  sharePosted,
} from '@/game/lap-share'

const clean = { seconds: 61.4, tainted: false, doc: { rules: '1.1cf62dd1' } }
const asking = shareAsking('Swift Kestrel 42')

describe('which laps may be posted', () => {
  it('a finished, clean lap with a leaderboard’s rules', () => {
    expect(shareable(clean)).toBe(true)
    expect(boardedLap(clean)).toBe(true)
  })

  it('never a TAINTED one (the autopilot, a URL switch, a preset flipped mid-lap), though its course has a leaderboard', () => {
    expect(shareable({ ...clean, tainted: true })).toBe(false)
    expect(boardedLap({ ...clean, tainted: true }), 'so the panel can say why not').toBe(true)
  })

  it('never one the server keeps no leaderboard for, nor one that did not finish, nor none', () => {
    expect(shareable({ ...clean, doc: { rules: LOCAL_LAP_RULES } })).toBe(false)
    expect(boardedLap({ ...clean, doc: { rules: LOCAL_LAP_RULES } })).toBe(false)
    expect(shareable({ ...clean, seconds: null })).toBe(false)
    expect(shareable(null)).toBe(false)
  })
})

describe('the presses', () => {
  it('starts as a question with the name it would post under, and nothing sent', () => {
    expect(asking.phase).toBe('idle')
    expect(asking.handle).toBe('Swift Kestrel 42')
  })

  it('posts on the press on its row, under the name on screen', () => {
    const one = pressShare(asking, true)
    expect(one.post).toBe(true)
    expect(one.next.phase).toBe('posting')
    expect(one.next.handle).toBe('Swift Kestrel 42')
  })

  it('posts nothing with no name to post under', () => {
    expect(pressShare(SHARE_IDLE, true)).toEqual({ next: SHARE_IDLE, post: false })
  })

  it('does nothing at all for a lap that may not be posted', () => {
    for (const state of [SHARE_IDLE, asking]) {
      const r = pressShare(state, false)
      expect(r.post).toBe(false)
      expect(r.next).toBe(state)
    }
  })

  it('never posts twice: a press while posting, or once posted, posts nothing', () => {
    const posting: ShareState = { ...asking, phase: 'posting' }
    expect(pressShare(posting, true)).toEqual({ next: posting, post: false })
    const posted = sharePosted(posting, {
      id: 'AbCdEf1234',
      link: 'h/?ghost=AbCdEf1234',
      board: true,
      rank: 3,
      boardReason: null,
    })
    // Once posted the press asks to take it back (DEV-374, below); it never posts.
    const after = pressShare(posted, true)
    expect(after.post).toBe(false)
    expect(after.remove).toBeFalsy()
    expect(after.next.id).toBe('AbCdEf1234')
  })

  it('a refusal is tried again by the same press, under the same name', () => {
    const failed = shareFailed({ ...asking, phase: 'posting' }, 'no')
    const again = pressShare(failed, true)
    expect(again.post).toBe(true)
    expect(again.next.handle).toBe('Swift Kestrel 42')
    expect(again.next.reason).toBeNull()
  })

  it('ANOTHER NAME rerolls it before the post (and after a refusal), and only then', () => {
    expect(rerollShare(asking, () => 'Bold Heron 77')?.handle).toBe('Bold Heron 77')
    expect(rerollShare(shareFailed(asking, 'no'), () => 'Bold Heron 77')?.handle).toBe(
      'Bold Heron 77',
    )
    for (const phase of ['posting', 'posted', 'confirm-delete', 'deleted'] as const) {
      expect(
        rerollShare({ ...asking, phase }, () => 'Bold Heron 77'),
        phase,
      ).toBeNull()
    }
  })
})

describe('what the panel says in place of the standings', () => {
  it('nothing while it only asks, and nothing for a lap that may not be posted', () => {
    expect(shareBlock(asking, true, true)).toBeNull()
    expect(shareBlock({ ...asking, phase: 'posting' }, false, true)).toBeNull()
  })

  it('the link once it is posted, where the lap stands, and what the link does', () => {
    const posted = sharePosted(
      { ...asking, phase: 'posting' },
      {
        id: 'AbCdEf1234',
        link: 'ff-10yr.pages.dev/?ghost=AbCdEf1234',
        board: false,
        rank: null,
        boardReason: 'a ring was missed',
      },
    )
    const block = shareBlock(posted, true, true)
    expect(block?.line).toBe('ff-10yr.pages.dev/?ghost=AbCdEf1234')
    expect(block?.heading).toBe('POSTED AS SWIFT KESTREL 42 · NOT RANKED')
    expect(block?.detail).toBe('ANYONE WITH THIS LINK CAN WATCH OR RACE THIS LAP')
    const ranked = shareBlock({ ...posted, board: true, rank: 3, copied: true }, true, false)
    expect(ranked?.heading).toBe('POSTED AS SWIFT KESTREL 42 · #3 ON THE LEADERBOARD · LINK COPIED')
    expect(ranked?.detail, 'a build without TV: the link races').toBe(linkDetail(false))
    expect(linkDetail(false)).toBe('ANYONE WITH THIS LINK CAN RACE THIS LAP')
  })

  it('never the word BOARD alone, nor SHARE: the leaderboard and posting, as the menu says', () => {
    const states: ShareState[] = [
      { ...asking, phase: 'posting' },
      { ...asking, phase: 'posted', link: 'h/?ghost=x', board: true, rank: 1 },
      { ...asking, phase: 'posted', link: 'h/?ghost=x' },
      shareFailed(asking, 'offline'),
      { ...asking, phase: 'confirm-delete', link: 'h/?ghost=x' },
      { ...asking, phase: 'deleting', link: 'h/?ghost=x' },
      shareDeleted(asking),
      deleteFailed(asking, 'no'),
    ]
    for (const s of states) {
      const b = shareBlock(s, true, true)
      const words = `${b?.heading} ${b?.detail ?? ''}`
      expect(words, s.phase).not.toMatch(/\bBOARD\b|SHARE/)
    }
  })
})

// ── DEV-374: taking the posted lap down ───────────────────────────────────
//
// §8 call 6, "deletable by their owner". The same row, the same rule as a
// post: a delete is as final, so no single press sends one.

describe('taking a posted lap down (DEV-374)', () => {
  const posted = sharePosted(
    { ...asking, phase: 'posting' },
    {
      id: 'AbCdEf1234',
      link: 'ff-10yr.pages.dev/?ghost=AbCdEf1234',
      board: true,
      rank: 3,
      boardReason: null,
    },
  )

  it('deletes on the SECOND press after posting, never the first', () => {
    const ask = pressShare(posted, true)
    expect(ask.next.phase).toBe('confirm-delete')
    expect(ask.post).toBe(false)
    expect(ask.remove).toBeFalsy()
    const send = pressShare(ask.next, true)
    expect(send.next.phase).toBe('deleting')
    expect(send.remove).toBe(true)
    expect(send.post).toBe(false)
    expect(send.next.id).toBe('AbCdEf1234')
    // In flight, and once deleted: nothing more, and never a post.
    for (const state of [send.next, shareDeleted(send.next)]) {
      const again = pressShare(state, true)
      expect(again.next).toBe(state)
      expect(again.post || again.remove === true).toBe(false)
    }
  })

  it('any other press KEEPS it while the delete is being asked, and a refusal is tried again', () => {
    const ask = pressShare(posted, true).next
    expect(keepPosted(ask)).toEqual(posted)
    expect(keepPosted(posted), 'nothing was being asked').toBeNull()
    const failed = deleteFailed({ ...ask, phase: 'deleting' }, 'no such lap of yours')
    const retry = pressShare(failed, true)
    expect(retry.remove).toBe(true)
    expect(retry.next.reason).toBeNull()
  })

  it('says what is being asked, and what came of it', () => {
    const ask = pressShare(posted, true).next
    expect(shareBlock(ask, true, true)).toEqual({
      heading: 'TAKE THIS LAP DOWN?',
      line: 'ff-10yr.pages.dev/?ghost=AbCdEf1234',
      tone: 'accent',
      detail: 'IT LEAVES THE LEADERBOARD AND THE LINK STOPS WORKING',
    })
    expect(shareBlock(shareDeleted({ ...ask, phase: 'deleting' }), true, true)).toEqual({
      heading: 'TAKEN DOWN',
      line: 'THE LINK NO LONGER WORKS',
      tone: 'dim',
    })
    expect(
      shareBlock(deleteFailed({ ...ask, phase: 'deleting' }, 'no such lap of yours'), true, true),
    ).toEqual({ heading: 'NOT TAKEN DOWN', line: 'no such lap of yours', tone: 'dim' })
  })
})
