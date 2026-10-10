// tests/unit/watch-me.test.ts, WATCH ME's link. DEV-480.
//
// docs/plan/FF-TV.md §2.6. The link follows the player's own seat as the
// anonymised feed names it (Racer slot + 1), carries the room's TV id and
// never its code, and reads back through TV's own link parser as exactly that.

import { describe, expect, it } from 'vitest'
import { parseTvLink } from '@/game/tv/tv-link'
import { fetchWatchMe, watchMeLink, watchMePath } from '@/game/tv/watch-me'

const TV = 'tv_abcdefghijklmnop'
const CODE = 'K7QX4M2'

describe('WATCH ME', () => {
  it('asks the room by its code, on the page’s own origin', () => {
    expect(watchMePath(CODE)).toBe(`/api/room/${CODE}/tv`)
  })

  it('follows Racer slot + 1, and reads back as that link', () => {
    const link = watchMeLink('ff-10yr.pages.dev', TV, 2)
    expect(link).toBe(`ff-10yr.pages.dev/tv/${TV}?follow=3`)
    expect(link).not.toContain(CODE)
    const url = new URL(`https://${link}`)
    expect(parseTvLink({ pathname: url.pathname, search: url.search })?.link).toEqual({
      kind: 'race',
      tv: TV,
      follow: 3,
    })
  })

  it('takes a TV id from the room, and nothing else', async () => {
    const answer = (status: number, body: unknown) => async () => ({ status, body })
    expect(await fetchWatchMe(CODE, answer(200, { tv: TV }))).toBe(TV)
    expect(await fetchWatchMe(CODE, answer(404, null))).toBeNull()
    expect(await fetchWatchMe(CODE, answer(503, null))).toBeNull()
    expect(await fetchWatchMe(CODE, answer(200, { tv: CODE }))).toBeNull()
    expect(
      await fetchWatchMe(CODE, async () => {
        throw new Error('offline')
      }),
    ).toBeNull()
  })
})
