// tests/unit/tv-link.test.ts, Faceted Flight TV's links. DEV-480.
//
// docs/plan/FF-TV.md §2.6. Two claims a reader could get wrong without a
// browser noticing:
//
//   1. Every link this game BUILDS reads back as the link it was built from,
//      the query form and the short form alike (the round trip).
//   2. A link that is not one TV can read is never a room's code or a join: it
//      opens `/tv`'s choice and says so, and a room's id is never taken for a
//      TV id (§2.2).

import { describe, expect, it } from 'vitest'
import {
  parseTvLink,
  TV_LINK_REFUSED,
  type TvLink,
  tvQuery,
  tvShortLink,
  withoutTv,
} from '@/game/tv/tv-link'

const TV = 'tv_abcdefghijklmnop'
const LAP = 'Ab3dE6gH9k'

const fromQuery = (q: string) => parseTvLink({ pathname: '/', search: q })
const fromUrl = (u: string) => {
  const url = new URL(`https://ff-10yr.pages.dev${u.startsWith('/') ? '' : '/'}${u}`)
  return parseTvLink({ pathname: url.pathname, search: url.search })
}

const LINKS: TvLink[] = [
  { kind: 'random' },
  { kind: 'race', tv: TV, follow: null },
  { kind: 'race', tv: TV, follow: 2 },
  { kind: 'race', tv: TV, follow: 6 },
  { kind: 'lap', lap: LAP },
]

describe('the round trip', () => {
  it('reads every query form back as the link it was built from', () => {
    for (const link of LINKS) {
      expect(fromQuery(tvQuery(link)), tvQuery(link)).toEqual({ link, refused: null })
    }
  })

  it('reads every short form back too: the address a person types', () => {
    for (const link of LINKS) {
      const short = tvShortLink('ff-10yr.pages.dev', link)
      expect(short.startsWith('ff-10yr.pages.dev/tv'), short).toBe(true)
      expect(fromUrl(short.slice('ff-10yr.pages.dev'.length)), short).toEqual({
        link,
        refused: null,
      })
    }
  })

  it('writes the forms the plan names, byte for byte', () => {
    expect(tvQuery({ kind: 'random' })).toBe('?tv')
    expect(tvQuery({ kind: 'race', tv: TV, follow: 2 })).toBe(`?tv=${TV}&follow=2`)
    expect(tvQuery({ kind: 'lap', lap: LAP })).toBe(`?tv=lap:${LAP}`)
    expect(tvShortLink('h', { kind: 'race', tv: TV, follow: 3 })).toBe(`h/tv/${TV}?follow=3`)
    expect(tvShortLink('h', { kind: 'lap', lap: LAP })).toBe(`h/tv/lap/${LAP}`)
    expect(tvShortLink('h', { kind: 'random' })).toBe('h/tv')
  })
})

describe('what is not a TV link', () => {
  it('is null on a page that names no TV', () => {
    expect(fromQuery('?mission=int_01_hoverJet')).toBeNull()
    expect(fromUrl('/')).toBeNull()
    expect(fromUrl('/tvx')).toBeNull()
    expect(fromUrl('/watch/tv')).toBeNull()
  })

  it('opens /tv’s choice, saying so, for anything it cannot read, a room code included', () => {
    for (const bad of ['K7QX4M2', 'abcdefghijklmnop', 'tv_ABCDEFGHIJKLMNOP', 'tv_short', 'lap:x']) {
      expect(fromQuery(`?tv=${bad}`), bad).toEqual({
        link: { kind: 'random' },
        refused: TV_LINK_REFUSED,
      })
    }
  })

  it('reads a follow hint only as Racer 1 to the most seats a room has', () => {
    for (const f of ['0', '-1', '1.5', 'two', '17', '99', '']) {
      expect(fromQuery(`?tv=${TV}&follow=${f}`)?.link, f).toEqual({
        kind: 'race',
        tv: TV,
        follow: null,
      })
    }
    // A hint on a link to no room is no hint: `/tv` follows nobody.
    expect(fromQuery('?tv&follow=2')?.link).toEqual({ kind: 'random' })
  })

  it('takes the query over the path when both say something', () => {
    expect(fromUrl(`/tv/${TV}?tv`)?.link).toEqual({ kind: 'random' })
  })
})

describe('leaving TV', () => {
  it('drops TV’s two switches and keeps everything else the page was opened with', () => {
    expect(withoutTv(`?tv=${TV}&follow=2&xr=off&quality=high`)).toBe('?xr=off&quality=high')
    expect(withoutTv('?tv')).toBe('')
    expect(withoutTv('')).toBe('')
  })
})
