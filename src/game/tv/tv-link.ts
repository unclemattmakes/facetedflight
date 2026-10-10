// src/game/tv/tv-link.ts, Faceted Flight TV's links, parsed and built. DEV-480.
//
// docs/plan/FF-TV.md §2.6. Matt, 2026-09-30: *"easy to share links to view
// self, others, or random rooms."* Every link is a plain URL on the game's own
// origin, carries neither a room's code nor a name, and opens TV once the
// page has had its first press (the first gesture, which audio needs; the
// landing card's Start until DEV-557, any key, click or touch since):
//
//   /?tv                      a live race at random; the exhibition if none
//   /?tv=<tvId>               that room's race
//   /?tv=<tvId>&follow=<n>    the same, the camera following Racer n
//   /?tv=lap:<lapId>          that board lap, flown among the AI racers (call 2)
//
// and the short forms a person types or reads aloud, `/tv`, `/tv/<tvId>`,
// `/tv/<tvId>?follow=<n>`, `/tv/lap/<lapId>`, which DEV-479's Function answers
// with a 302 to the query forms. Both are read here, so a short link works on a
// host that serves the page for any path without the 302 (Vite's dev server).
//
// `follow` is a camera hint the client reads and never sends anywhere: the
// link never joins (§2.6). Pure: no DOM, no three.

import { isLapId } from '@/net/lap-client'
import { ROOM_MAX_SEATS } from '@/net/room-protocol'
import { TV_ID_SHAPE } from '@/net/tv-protocol'

/** The query switch. One name, read in one place (`boot/app.ts`). */
export const TV_SWITCH = 'tv'
/** The camera hint beside it. */
export const TV_FOLLOW_SWITCH = 'follow'
/** A lap link's value: `lap:<lapId>`. The colon is outside `TV_ID_SHAPE`. */
export const TV_LAP_PREFIX = 'lap:'

/** What a TV link asks for. */
export type TvLink =
  | { readonly kind: 'random' }
  | { readonly kind: 'race'; readonly tv: string; readonly follow: number | null }
  | { readonly kind: 'lap'; readonly lap: string }

/** A link as read: what it asks for, and why it was read as `/tv` instead, if it was. */
export interface ParsedTvLink {
  readonly link: TvLink
  /** A link that named something this game cannot read: TV opens on `/tv`'s choice and says so. */
  readonly refused: string | null
}

/** What the card says when a link was not one TV can read. */
export const TV_LINK_REFUSED = 'That TV link could not be read, so here is what is on.'

const RANDOM: TvLink = { kind: 'random' }

/** Racer n: 1 to the most seats a room has. Anything else is no hint. */
const followOf = (text: string | null): number | null => {
  if (text === null || !/^[1-9][0-9]?$/.test(text)) return null
  const n = Number(text)
  return n >= 1 && n <= ROOM_MAX_SEATS ? n : null
}

/** One value of `tv` (or one short path's tail) to a link. */
const linkOf = (value: string, follow: string | null): ParsedTvLink => {
  if (value === '') return { link: RANDOM, refused: null }
  if (TV_ID_SHAPE.test(value)) {
    return { link: { kind: 'race', tv: value, follow: followOf(follow) }, refused: null }
  }
  if (value.startsWith(TV_LAP_PREFIX) && isLapId(value.slice(TV_LAP_PREFIX.length))) {
    return { link: { kind: 'lap', lap: value.slice(TV_LAP_PREFIX.length) }, refused: null }
  }
  return { link: RANDOM, refused: TV_LINK_REFUSED }
}

/**
 * The page's TV link, or null when it has none. `search` is `location.search`
 * (with or without its `?`), `pathname` `location.pathname`. The query wins
 * over the path when both say something.
 */
export const parseTvLink = (where: {
  readonly pathname: string
  readonly search: string
}): ParsedTvLink | null => {
  const params = new URLSearchParams(where.search)
  const follow = params.get(TV_FOLLOW_SWITCH)
  const value = params.get(TV_SWITCH)
  if (value !== null) return linkOf(value, follow)
  const path = /^\/tv(?:\/(.*?))?\/?$/.exec(where.pathname)
  if (path === null) return null
  const tail = path[1] ?? ''
  if (tail.startsWith('lap/')) return linkOf(`${TV_LAP_PREFIX}${tail.slice(4)}`, null)
  return linkOf(tail, follow)
}

/** The query form of `link`: what the page reads. Starts with `?`. */
export const tvQuery = (link: TvLink): string => {
  switch (link.kind) {
    case 'random':
      return `?${TV_SWITCH}`
    case 'race':
      return link.follow === null
        ? `?${TV_SWITCH}=${link.tv}`
        : `?${TV_SWITCH}=${link.tv}&${TV_FOLLOW_SWITCH}=${link.follow}`
    case 'lap':
      return `?${TV_SWITCH}=${TV_LAP_PREFIX}${link.lap}`
  }
}

/**
 * The short form, as a person reads it off a plate: the host and `/tv…`, no
 * scheme (every browser adds `https://` to a bare host, as `shareLink` says of
 * a lap's). `host` is `location.host`, so a preview names the preview.
 */
export const tvShortLink = (host: string, link: TvLink): string => {
  switch (link.kind) {
    case 'random':
      return `${host}/tv`
    case 'race':
      return link.follow === null
        ? `${host}/tv/${link.tv}`
        : `${host}/tv/${link.tv}?${TV_FOLLOW_SWITCH}=${link.follow}`
    case 'lap':
      return `${host}/tv/lap/${link.lap}`
  }
}

/**
 * `search` without TV's two switches, for leaving TV: everything else the page
 * was opened with (a spec's `xr=off`, a quality pin) stays. Starts with `?`, or
 * is empty.
 */
export const withoutTv = (search: string): string => {
  const params = new URLSearchParams(search)
  params.delete(TV_SWITCH)
  params.delete(TV_FOLLOW_SWITCH)
  const rest = params.toString()
  return rest === '' ? '' : `?${rest}`
}
