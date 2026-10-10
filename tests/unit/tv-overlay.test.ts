// DEV-653: the TV overlay's logic. The ident stands 2.5 s of on-screen time; the
// standings board shows after it and on a change of place or of who the camera
// follows, then fades; a gap is measured at the SAME gate and a split is taken
// every fourth gate; the bug's TV word ends where the wordmark does; the hint
// fades after six seconds without input. And the overtake signal the Director
// and wave 2 read is debounced.

import { describe, expect, it } from 'vitest'
import { createStandingsTracker, placeGains, TV_ORDER_SETTLE_SECONDS } from '@/game/tv/tv-standings'
import { tvWordPlane } from '@/render/tv-bug'
import { createTvGaps, TV_SPLIT_EVERY, TV_SPLIT_SECONDS } from '@/render/tv-gaps'
import { TV_HINT_IDLE_MS, tvHintOpacity } from '@/render/tv-panel-controls'
import {
  stepTvPanel,
  TV_BOARD_FADE_SECONDS,
  TV_BOARD_SECONDS,
  TV_IDENT_SECONDS,
  TV_PANEL_IDLE,
  type TvPanelFeed,
  type TvPanelRow,
  tvBoardAlpha,
  tvCraftName,
  tvGateLine,
  tvRowDetail,
  tvSplitLine,
} from '@/render/tv-panel-layout'

const row = (
  key: string,
  place: number,
  rings: number,
  over: Partial<TvPanelRow> = {},
): TvPanelRow => ({
  key,
  kind: 'racer',
  racer: null,
  follow: place,
  name: key,
  colour: null,
  place,
  status: 'flying',
  seconds: null,
  rings,
  ...over,
})

const feed = (over: Partial<TvPanelFeed> = {}): TvPanelFeed => ({
  show: 'exhibition',
  phase: 'racing',
  course: 'Simonet Islands · Ring Attack',
  racers: null,
  rows: [row('a', 1, 3), row('b', 2, 3)],
  gates: 21,
  followed: 'a',
  linkFollows: null,
  lobbies: null,
  raceSeconds: 10,
  ...over,
})

describe('DEV-653: the ident stands 2.5 seconds of on-screen time', () => {
  it('is 2.5 s, not about twenty', () => {
    expect(TV_IDENT_SECONDS).toBe(2.5)
  })

  it('goes at 2.5 s whatever phase the show is in, and does not spend time under the loading scene', () => {
    let s = stepTvPanel(TV_PANEL_IDLE, feed({ phase: 'ident' }), 0)
    expect(s.shown.ident).toBe(true)
    // The loading scene covers it: the caller passes no time. Still up.
    for (let i = 0; i < 100; i++) s = stepTvPanel(s.state, feed({ phase: 'ident' }), 0)
    expect(s.shown.ident).toBe(true)
    // On screen: gone after 2.5 s, even though the countdown (a phase of the ident) runs on.
    s = stepTvPanel(s.state, feed({ phase: 'ident' }), TV_IDENT_SECONDS - 0.01)
    expect(s.shown.ident).toBe(true)
    s = stepTvPanel(s.state, feed({ phase: 'ident' }), 0.02)
    expect(s.shown.ident).toBe(false)
  })
})

describe('DEV-653: the standings board shows on a change and fades', () => {
  const settled = () => {
    let s = stepTvPanel(TV_PANEL_IDLE, feed({ phase: 'ident' }), 0)
    s = stepTvPanel(s.state, feed({ phase: 'ident' }), TV_IDENT_SECONDS + 0.1)
    s = stepTvPanel(s.state, feed(), 0.016)
    return s
  }

  it('comes up when the ident leaves, and is gone `TV_BOARD_SECONDS` later', () => {
    let s = settled()
    expect(s.shown.lowerThird).toBe(true)
    expect(s.board).toBe(1)
    s = stepTvPanel(s.state, feed(), TV_BOARD_SECONDS - TV_BOARD_FADE_SECONDS - 0.01)
    expect(s.board).toBe(1)
    // Fading over its last seconds.
    s = stepTvPanel(s.state, feed(), TV_BOARD_FADE_SECONDS / 2)
    expect(s.board).toBeGreaterThan(0)
    expect(s.board).toBeLessThan(1)
    s = stepTvPanel(s.state, feed(), TV_BOARD_SECONDS)
    expect(s.board).toBe(0)
    expect(s.shown.lowerThird).toBe(false)
  })

  it('comes back on a change of place, and on a change of who the camera is on, not otherwise', () => {
    let s = settled()
    s = stepTvPanel(s.state, feed(), TV_BOARD_SECONDS + 1)
    expect(s.shown.lowerThird).toBe(false)
    // Nothing changes: still hidden.
    s = stepTvPanel(s.state, feed(), 1)
    expect(s.shown.lowerThird).toBe(false)
    // An overtake.
    s = stepTvPanel(s.state, feed({ rows: [row('b', 1, 4), row('a', 2, 3)] }), 0.016)
    expect(s.shown.lowerThird).toBe(true)
    expect(s.board).toBe(1)
    s = stepTvPanel(s.state, feed({ rows: [row('b', 1, 4), row('a', 2, 3)] }), TV_BOARD_SECONDS + 1)
    expect(s.shown.lowerThird).toBe(false)
    // The camera moves to another racer.
    s = stepTvPanel(s.state, feed({ rows: [row('b', 1, 4), row('a', 2, 3)], followed: 'b' }), 0.016)
    expect(s.shown.lowerThird).toBe(true)
  })

  it('has an opacity that is 1 until its last fade seconds, then eases to 0', () => {
    expect(tvBoardAlpha(TV_BOARD_SECONDS)).toBe(1)
    expect(tvBoardAlpha(TV_BOARD_FADE_SECONDS)).toBe(1)
    expect(tvBoardAlpha(TV_BOARD_FADE_SECONDS / 2)).toBeCloseTo(0.5, 9)
    expect(tvBoardAlpha(0)).toBe(0)
  })
})

describe('DEV-653: the gap to the leader is measured at the same gate', () => {
  it('is the difference of the two clocks at which each was seen to cross the SAME gate', () => {
    const gaps = createTvGaps()
    // Leader crosses gate 1 at 10.0 s, gate 2 at 20.0 s; the follower crosses gate 1 at 11.5, gate 2 at 22.0.
    const at = (t: number, lead: number, follow: number): TvPanelFeed =>
      feed({
        raceSeconds: t,
        followed: 'b',
        rows: [row('a', 1, lead), row('b', 2, follow)],
      })
    gaps.observe(at(9, 0, 0))
    gaps.observe(at(10, 1, 0))
    let out = gaps.observe(at(11.5, 1, 1))
    expect(out.rows[0]?.gap).toBe(0)
    expect(out.rows[1]?.gap).toBeCloseTo(1.5, 9)
    gaps.observe(at(20, 2, 1))
    out = gaps.observe(at(22, 2, 2))
    // At gate 2: 22.0 - 20.0, not the 1.5 it was at gate 1, and not an estimate from speed.
    expect(out.rows[1]?.gap).toBeCloseTo(2, 9)
    expect(tvRowDetail(out.rows[1] as TvPanelRow, 21)).toBe('+2.0')
    expect(tvRowDetail(out.rows[0] as TvPanelRow, 21)).toBe('LEAD')
  })

  it('takes a split on the followed racer at every fourth gate, behind the one ahead, and lets it go', () => {
    const gaps = createTvGaps()
    let t = 0
    const frame = (lead: number, follow: number): TvPanelFeed =>
      gaps.observe(
        feed({ raceSeconds: t, followed: 'b', rows: [row('a', 1, lead), row('b', 2, follow)] }),
      )
    // Both cross gates 1..3, the follower 1.0 s behind each time.
    for (let g = 1; g < TV_SPLIT_EVERY; g++) {
      t = g * 10
      frame(g, g - 1)
      t += 1
      expect(frame(g, g).split ?? null).toBeNull()
    }
    // Gate 4: the leader at 40.0, the follower at 41.0.
    t = 40
    frame(TV_SPLIT_EVERY, TV_SPLIT_EVERY - 1)
    t = 41
    const got = frame(TV_SPLIT_EVERY, TV_SPLIT_EVERY)
    expect(got.split?.gate).toBe(TV_SPLIT_EVERY)
    expect(got.split?.seconds).toBeCloseTo(1, 9)
    expect(tvSplitLine(got.split as NonNullable<typeof got.split>)).toBe('SPLIT GATE 4  +1.0')
    // Stands its seconds, then goes.
    t += TV_SPLIT_SECONDS - 0.1
    expect(frame(TV_SPLIT_EVERY, TV_SPLIT_EVERY).split).toBeTruthy()
    t += 0.5
    expect(frame(TV_SPLIT_EVERY, TV_SPLIT_EVERY).split ?? null).toBeNull()
  })

  it('gives the leader a split against the racer behind it, negative (ahead)', () => {
    const gaps = createTvGaps()
    let t = 39
    const frame = (lead: number, follow: number): TvPanelFeed =>
      gaps.observe(
        feed({ raceSeconds: t, followed: 'a', rows: [row('a', 1, lead), row('b', 2, follow)] }),
      )
    frame(3, 3)
    t = 40
    frame(4, 3)
    t = 41.4
    const got = frame(4, 4)
    expect(got.split?.seconds).toBeCloseTo(-1.4, 9)
    expect(tvSplitLine(got.split as NonNullable<typeof got.split>)).toBe('SPLIT GATE 4  -1.4')
  })

  it('forgets everything on a new race', () => {
    const gaps = createTvGaps()
    gaps.observe(feed({ raceSeconds: 50, rows: [row('a', 1, 5), row('b', 2, 4)] }))
    const out = gaps.observe(feed({ raceSeconds: 1, rows: [row('a', 1, 0), row('b', 2, 0)] }))
    expect(out.rows.every((r) => r.gap == null || r.gap === 0)).toBe(true)
  })

  it('writes the header gate line from the followed racer', () => {
    expect(tvGateLine(feed({ followed: 'b', rows: [row('a', 1, 9), row('b', 2, 7)] }))).toBe(
      'GATE 7/21',
    )
  })
})

describe('DEV-652: who passed whom', () => {
  it('lists the racers that moved UP, and not a racer that joined', () => {
    expect(placeGains(['a', 'b', 'c'], ['b', 'a', 'c'])).toEqual([{ id: 'b', from: 2, to: 1 }])
    expect(placeGains(['a', 'b'], ['a', 'b', 'c'])).toEqual([])
    expect(placeGains(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual([{ id: 'c', from: 3, to: 1 }])
  })

  it('a racer that LEFT (crossed the line) lifts those behind it without anyone taking a place (DEV-886)', () => {
    expect(placeGains(['a', 'b', 'c'], ['b', 'c'])).toEqual([])
    // A real pass among the rest is still one, at its real place.
    expect(placeGains(['a', 'b', 'c'], ['c', 'b'])).toEqual([{ id: 'c', from: 3, to: 1 }])
  })

  it('adopts a new order only once it has stood, so two racers side by side are not forty overtakes', () => {
    const t = createStandingsTracker()
    t.step(['a', 'b'], 0.01)
    // Flickering every frame: never settles.
    for (let i = 0; i < 40; i++) expect(t.step(i % 2 ? ['a', 'b'] : ['b', 'a'], 0.01)).toEqual([])
    expect(t.overtakes).toBe(0)
    // Held: settles after TV_ORDER_SETTLE_SECONDS.
    let got: readonly { id: string }[] = []
    for (let s = 0; s < TV_ORDER_SETTLE_SECONDS + 0.05; s += 0.01) {
      const r = t.step(['b', 'a'], 0.01)
      if (r.length > 0) got = r
    }
    expect(got.map((g) => g.id)).toEqual(['b'])
    expect(t.overtakes).toBe(1)
  })
})

describe('DEV-653 and DEV-804: the TV word ends where the wordmark does, and stands on the point', () => {
  it('stands the V ink right edge exactly on the wordmark right edge, whatever the font measures', () => {
    for (const inkAspect of [0.9, 1.4, 2.1]) {
      const plane = tvWordPlane({
        wordRight: 8.468,
        logoBottom: -7.5,
        capHeight: 2.5,
        inkAspect,
        margin: 0.1,
      })
      expect(plane.inkRight).toBe(8.468)
      // The plane's own right edge is the ink's plus the margin; so the ink is flush.
      expect(plane.x + plane.width / 2 - 0.1).toBeCloseTo(8.468, 9)
      // DEV-804: the ink stands ON the emblem's lowest point, and rises from it.
      expect(plane.inkBottom).toBe(-7.5)
      expect(plane.y - plane.height / 2 + 0.1).toBeCloseTo(-7.5, 9)
      expect(plane.y + plane.height / 2 - 0.1).toBeCloseTo(-7.5 + 2.5, 9)
    }
  })

  it('projects to the same pixel at 1080p within a pixel, at the bug size the panel uses', () => {
    // The bug's group is scaled evenly, so edges that are equal in the logo's units are equal on screen;
    // the check is that the arithmetic survives the projection at the real size.
    const wordRight = 8.468
    const plane = tvWordPlane({
      wordRight,
      logoBottom: -7.504,
      capHeight: 2.5,
      inkAspect: 1.6,
      margin: 0.1,
    })
    const tvRight = plane.x + plane.width / 2 - 0.1
    const fov = 60
    const aspect = 16 / 9
    const hh = Math.tan((fov / 2) * (Math.PI / 180))
    const bugWidth = 2 * hh * aspect * 0.075 // TV_BUG_SHARE.landscape of the frame
    const scale = bugWidth / 17
    const px = (x: number): number => ((x * scale + 0.5) / (hh * aspect) + 1) * 960
    expect(Math.abs(px(wordRight) - px(tvRight))).toBeLessThan(1)
    // DEV-804: and the bottoms, the TV ink's and the point's, on the vertical axis.
    const tvBottom = plane.y - plane.height / 2 + 0.1
    const py = (y: number): number => ((y * scale + 0.5) / hh + 1) * 540
    expect(Math.abs(py(-7.504) - py(tvBottom))).toBeLessThan(1)
  })
})

describe('DEV-653: the marker over the followed racer says what the board would', () => {
  it('is Racer N for a live racer whatever handle it carries, a callsign in capitals for an AI racer', () => {
    expect(tvCraftName({ name: 'SwiftFalcon42', racer: 3 })).toBe('Racer 3')
    expect(tvCraftName({ name: 'lil bitey' })).toBe('LIL BITEY')
    // A name that is neither a callsign nor a tuning is never drawn.
    expect(tvCraftName({ name: 'SwiftFalcon42', place: 2 })).toBe('Racer 2')
    expect(tvCraftName({ name: 'Shared lap' })).toBe('Shared lap')
  })
})

describe('DEV-653: the hint fades after six seconds without input', () => {
  it('stands, then goes', () => {
    expect(TV_HINT_IDLE_MS).toBe(6000)
    expect(tvHintOpacity(0)).toBeGreaterThan(0)
    expect(tvHintOpacity(TV_HINT_IDLE_MS - 1)).toBeGreaterThan(0)
    expect(tvHintOpacity(TV_HINT_IDLE_MS)).toBe(0)
  })
})
