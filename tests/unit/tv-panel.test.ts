// DEV-482: TV's on-screen layer, feed to panel (`render/tv-panel-layout.ts`).
//
// The paint is run against a fake 2D context that keeps every string it was
// asked to draw, so "is this name on the panel" is answered by what was DRAWN,
// not by what a helper returned. The handle test feeds a handle-shaped name
// through every row kind and every panel and reads the drawn strings back.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TV_LAP_NAME } from '@/game/tv/exhibition'
import {
  createTvCutAnchor,
  type ExhibitionPanelSource,
  identCanvas,
  LOWER_THIRD_CANVAS,
  layoutLowerThird,
  lowerThirdKey,
  lowerThirdRowAt,
  paintIdent,
  paintLowerThird,
  paintResults,
  stepTvPanel,
  TV_IDENT_SECONDS,
  TV_LINK_LEGEND,
  TV_LINK_MARK,
  TV_PANEL_IDLE,
  TV_PANEL_LAP_NAME,
  TV_TITLE,
  type TvCtx,
  type TvPanelFeed,
  type TvPanelRow,
  tvCourseLabel,
  tvDrawnName,
  tvFeedFromExhibition,
  tvFlatPlacement,
  tvFollowedKey,
  tvHeadsetPlacement,
  tvIdentLine,
  tvLiveRow,
} from '@/render/tv-panel-layout'
import { UI_ACCENT } from '@/render/ui-tokens'

/** A 2D context that records each `fillText`, in order, with its y and fill. */
const fakeCtx = () => {
  const drawn: { text: string; x: number; y: number; fill: string }[] = []
  const ctx: TvCtx = {
    font: '10px monospace',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    clearRect: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    fillText(text, x, y) {
      drawn.push({ text, x, y, fill: String(this.fillStyle) })
    },
    measureText(text) {
      const px = Number(/(\d+)px/.exec(this.font)?.[1] ?? 10)
      return { width: text.length * px * 0.6 }
    },
  }
  return { ctx, drawn, texts: () => drawn.map((d) => d.text) }
}

const COURSE = tvCourseLabel('Simonet Islands', 'Ring Attack')

const live = (slot: number, place: number, rings: number, colour = '#ff1f4b'): TvPanelRow =>
  tvLiveRow({ slot, colour, place, status: 'flying', seconds: null, rings })

const liveFeed = (over: Partial<TvPanelFeed> = {}): TvPanelFeed => ({
  show: 'live',
  phase: 'racing',
  course: COURSE,
  racers: 4,
  rows: [
    live(2, 1, 9),
    live(0, 2, 8, '#eef91f'),
    live(3, 3, 8, '#1ad132'),
    live(1, 4, 6, '#129fde'),
  ],
  gates: 21,
  followed: 'slot:0',
  linkFollows: null,
  lobbies: 2,
  raceSeconds: 67.4,
  ...over,
})

const exhibitionSource = (over: Partial<ExhibitionPanelSource> = {}): ExhibitionPanelSource => ({
  phase: 'racing',
  course: 'int_01_hoverJet',
  raceSeconds: 31,
  craft: [
    { kind: 'racer', name: 'fast', place: 1, status: 'flying', seconds: null },
    { kind: 'racer', name: 'cutter', place: 2, status: 'flying', seconds: null },
    { kind: 'racer', name: 'steady', place: 3, status: 'flying', seconds: null },
  ],
  ...over,
})

const exhibitionContext = {
  course: COURSE,
  colourOf: (n: string) => ({ fast: '#ff1f4b', steady: '#eef91f', cutter: '#1ad132' })[n] ?? null,
  ringsOf: (n: string) => ({ fast: 7, steady: 5, cutter: 6 })[n] ?? null,
  gates: 21,
  following: 'cutter',
  linkFollows: null,
  lobbies: 0,
}

describe('the ident', () => {
  it('names the show, the course and the field', () => {
    expect(tvIdentLine(liveFeed({ phase: 'ident' }))).toBe(
      'LIVE · Simonet Islands · Ring Attack · 4 racers',
    )
    expect(tvIdentLine(tvFeedFromExhibition(exhibitionSource(), exhibitionContext))).toBe(
      'EXHIBITION · Simonet Islands · Ring Attack · AI racers',
    )
    const lap = exhibitionSource({
      craft: [
        { kind: 'ghost', name: TV_LAP_NAME, place: 1, status: 'flying', seconds: null },
        { kind: 'racer', name: 'fast', place: 2, status: 'flying', seconds: null },
      ],
    })
    expect(tvIdentLine(tvFeedFromExhibition(lap, exhibitionContext))).toBe(
      'SHARED LAP · Simonet Islands · Ring Attack',
    )
    // One racer is a racer.
    expect(tvIdentLine(liveFeed({ racers: 1 }))).toBe(
      'LIVE · Simonet Islands · Ring Attack · 1 racer',
    )
  })

  it('draws the title over the line, and wraps the line at its separators in portrait', () => {
    const wide = fakeCtx()
    paintIdent(wide.ctx, liveFeed({ phase: 'ident' }), false)
    expect(wide.texts()).toEqual([TV_TITLE, 'LIVE · Simonet Islands · Ring Attack · 4 racers'])
    const tall = fakeCtx()
    paintIdent(tall.ctx, liveFeed({ phase: 'ident' }), true)
    expect(tall.texts()[0]).toBe(TV_TITLE)
    const lines = tall.texts().slice(1)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join(' · ')).toBe('LIVE · Simonet Islands · Ring Attack · 4 racers')
    // Each line fits the portrait canvas at the font it was drawn in.
    for (const l of lines)
      expect(l.length * 40 * 0.6).toBeLessThanOrEqual(identCanvas(true).width - 80)
  })
})

describe('the lower third', () => {
  it('draws the bug, the course, the clock, then the standings in place order', () => {
    const f = fakeCtx()
    paintLowerThird(f.ctx, liveFeed())
    // DEV-848: the clock's digits are seated one by one in cells (`ui-digits.ts`), so
    // the recorder sees its glyphs separately: fold the run between the bug and the
    // gate back into the one string the player reads.
    const raw = f.texts()
    const gateAt = raw.indexOf('GATE 8/21')
    const t = ['LIVE', raw.slice(1, gateAt).join(''), ...raw.slice(gateAt)]
    // DEV-653: the header is the bug, the clock and the gate the camera's racer is on;
    // the course is the ident's and the results' line.
    expect(t.slice(0, 3)).toEqual(['LIVE', '1:07', 'GATE 8/21'])
    const names = t.filter((s) => s.startsWith('Racer '))
    // Place order: slot 2 leads, then 0, 3, 1. The NAME is the slot plus one.
    expect(names).toEqual(['Racer 3', 'Racer 1', 'Racer 4', 'Racer 2'])
    expect(t).toContain('9/21')
    expect(t).toContain('2 rooms getting ready')
  })

  it('marks the racer the camera is on, and only that one', () => {
    const f = fakeCtx()
    paintLowerThird(f.ctx, liveFeed({ followed: 'slot:3' }))
    // DEV-653: the followed row's PLACE is drawn in the accent (with an accent
    // edge), no other row's is. Slot 3 is Racer 4, third by place.
    const placeNumbers = ['1', '2', '3', '4']
    const inAccent = f.drawn.filter((d) => placeNumbers.includes(d.text) && d.fill === UI_ACCENT)
    expect(inAccent.map((d) => d.text)).toEqual(['3'])
    const racer4 = f.drawn.find((d) => d.text === 'Racer 4')
    expect(racer4?.y).toBe(inAccent[0]?.y)
    const none = fakeCtx()
    paintLowerThird(none.ctx, liveFeed({ followed: null }))
    expect(none.drawn.filter((d) => d.fill === UI_ACCENT && placeNumbers.includes(d.text))).toEqual(
      [],
    )
  })

  it('marks the racer a link follows, and says what the mark means', () => {
    const f = fakeCtx()
    paintLowerThird(f.ctx, liveFeed({ linkFollows: 4 }))
    const mark = f.drawn.filter((d) => d.text === TV_LINK_MARK)
    expect(mark).toHaveLength(1)
    expect(mark[0]?.y).toBe(f.drawn.find((d) => d.text === 'Racer 4')?.y)
    expect(f.texts()).toContain(TV_LINK_LEGEND)
    // A link naming nobody on screen marks nothing and explains nothing.
    const g = fakeCtx()
    paintLowerThird(g.ctx, liveFeed({ linkFollows: 6 }))
    expect(g.texts()).not.toContain(TV_LINK_MARK)
    expect(g.texts()).not.toContain(TV_LINK_LEGEND)
  })

  it('reads the exhibition: tuned names, colours, rings, the camera by name', () => {
    const feed = tvFeedFromExhibition(exhibitionSource(), exhibitionContext)
    expect(feed.show).toBe('exhibition')
    expect(feed.phase).toBe('racing')
    expect(feed.rows.map(tvDrawnName)).toEqual(['fast', 'cutter', 'steady'])
    expect(feed.rows.map((r) => r.colour)).toEqual(['#ff1f4b', '#1ad132', '#eef91f'])
    expect(feed.rows.map((r) => r.follow)).toEqual([1, 2, 3])
    expect(feed.followed).toBe('racer:cutter')
    const f = fakeCtx()
    paintLowerThird(f.ctx, feed)
    expect(f.texts().slice(0, 1)).toEqual(['EXHIBITION'])
    expect(f.texts()).toContain('6/21')
    // No rooms getting ready says nothing.
    expect(f.texts().some((s) => s.includes('getting ready'))).toBe(false)
  })

  it('maps the exhibition phases: boarding and the countdown are the ident', () => {
    for (const [phase, want] of [
      ['boarding', 'ident'],
      ['countdown', 'ident'],
      ['racing', 'racing'],
      ['results', 'results'],
      ['stopped', 'off'],
    ] as const) {
      expect(tvFeedFromExhibition(exhibitionSource({ phase }), exhibitionContext).phase).toBe(want)
    }
  })

  it('finds the row a press lands on, for Follow', () => {
    const feed = liveFeed()
    const layout = layoutLowerThird(feed)
    const second = layout.rows[1]
    expect(second).toBeDefined()
    if (!second) return
    expect(lowerThirdRowAt(layout, 300, second.y + second.h / 2)?.follow).toBe(1)
    expect(lowerThirdRowAt(layout, 300, layout.top + 10)).toBeNull()
    expect(lowerThirdRowAt(layout, LOWER_THIRD_CANVAS.width + 1, second.y + 1)).toBeNull()
    // The plate is bottom-aligned: its last line ends at the canvas's bottom.
    expect(layout.top).toBeGreaterThan(0)
  })

  it('repaints when what it says changes, and not otherwise', () => {
    const a = liveFeed()
    expect(lowerThirdKey(a)).toBe(lowerThirdKey({ ...a, raceSeconds: 67.9 }))
    expect(lowerThirdKey(a)).not.toBe(lowerThirdKey({ ...a, raceSeconds: 68.1 }))
    expect(lowerThirdKey(a)).not.toBe(lowerThirdKey({ ...a, followed: 'slot:1' }))
  })
})

describe('the results card', () => {
  it('places the finishers by time, shows the time, and DNF without a place', () => {
    const rows: TvPanelRow[] = [
      { ...live(1, 1, 21), status: 'finished', seconds: 88.04 },
      { ...live(0, 2, 21), status: 'finished', seconds: 90.5 },
      { ...live(2, 3, 12), status: 'dnf', seconds: null },
    ]
    const f = fakeCtx()
    paintResults(f.ctx, liveFeed({ phase: 'results', rows, lobbies: 1 }))
    const t = f.texts()
    expect(t[0]).toBe('RESULTS')
    expect(t).toContain(COURSE)
    const at = (s: string) => t.indexOf(s)
    expect(at('1ST')).toBeLessThan(at('Racer 2'))
    expect(at('Racer 2')).toBeLessThan(at('88.0s'))
    expect(at('2ND')).toBeLessThan(at('Racer 1'))
    expect(t).toContain('DNF')
    expect(t).not.toContain('3RD')
    expect(t).toContain('1 room getting ready')
  })
})

describe('no names on TV, ever', () => {
  // Shaped like a handle the lists generate, and like free text a hand-made client could send.
  const HANDLES = ['SwiftFalcon42', 'MattS', 'fast_racer', 'cutter-x', 'Racer 9 lol']

  it('draws no handle from any row kind, on any panel', () => {
    for (const handle of HANDLES) {
      const rows: TvPanelRow[] = [
        { ...live(0, 1, 3), name: handle },
        {
          key: 'racer:x',
          kind: 'racer',
          racer: null,
          follow: 2,
          name: handle,
          colour: '#ff1f4b',
          place: 2,
          status: 'flying',
          seconds: null,
          rings: 2,
        },
        {
          key: 'ghost',
          kind: 'ghost',
          racer: null,
          follow: 3,
          name: handle,
          colour: null,
          place: 3,
          status: 'finished',
          seconds: 90,
          rings: null,
        },
      ]
      const feed = liveFeed({ rows, show: 'lap' })
      for (const paint of [
        (c: TvCtx) => paintLowerThird(c, feed),
        (c: TvCtx) => paintResults(c, { ...feed, phase: 'results' }),
        (c: TvCtx) => paintIdent(c, { ...feed, phase: 'ident' }, false),
        (c: TvCtx) => paintIdent(c, { ...feed, phase: 'ident' }, true),
      ]) {
        const f = fakeCtx()
        paint(f.ctx)
        for (const s of f.texts()) expect(s, `${handle} drawn as "${s}"`).not.toContain(handle)
      }
      expect(rows.map(tvDrawnName)).toEqual(['Racer 1', 'Racer 2', TV_PANEL_LAP_NAME])
    }
  })

  it('names a shared lap the way the exhibition does', () => {
    expect(TV_PANEL_LAP_NAME).toBe(TV_LAP_NAME)
  })

  it('keeps every tuned name a race would show', () => {
    for (const n of ['fast', 'steady', 'cutter', 'wide', 'cruiser', 'fast-2']) {
      expect(tvDrawnName({ ...live(0, 1, 0), kind: 'racer', racer: null, name: n })).toBe(n)
    }
  })
})

describe('the camera, as the panel reads it', () => {
  it('finds the followed row by racer number live, by name otherwise', () => {
    const rows = liveFeed().rows
    expect(tvFollowedKey({ following: 'Racer 4', racer: 4 }, rows)).toBe('slot:3')
    expect(tvFollowedKey({ following: null, racer: null }, rows)).toBeNull()
    expect(tvFollowedKey(null, rows)).toBeNull()
    const ex = tvFeedFromExhibition(
      exhibitionSource({
        craft: [
          { kind: 'ghost', name: TV_LAP_NAME, place: 1, status: 'flying', seconds: null },
          { kind: 'racer', name: 'fast', place: 2, status: 'flying', seconds: null },
        ],
      }),
      { ...exhibitionContext, following: TV_LAP_NAME },
    )
    expect(ex.followed).toBe('ghost')
    expect(ex.show).toBe('lap')
  })
})

describe('which panel stands, and the sound', () => {
  it('stings once per show, holds the ident, and cuts the song at GO', () => {
    const ident = liveFeed({ phase: 'ident' })
    let s = stepTvPanel(TV_PANEL_IDLE, ident, 0.016)
    expect(s.cues).toEqual(['sting', 'music.lift'])
    expect(s.shown).toEqual({ ident: true, lowerThird: false, results: false })
    s = stepTvPanel(s.state, ident, 0.016)
    expect(s.cues).toEqual([])
    // GO: a new song, and the ident stands out its minimum before the lower third.
    s = stepTvPanel(s.state, liveFeed(), 0.5)
    expect(s.cues).toEqual(['music.go'])
    expect(s.shown.ident).toBe(true)
    s = stepTvPanel(s.state, liveFeed(), TV_IDENT_SECONDS)
    expect(s.shown).toEqual({ ident: false, lowerThird: true, results: false })
    s = stepTvPanel(s.state, liveFeed({ phase: 'results' }), 0.016)
    expect(s.shown).toEqual({ ident: false, lowerThird: false, results: true })
    expect(s.cues).toEqual([])
    // The next course is a new show.
    s = stepTvPanel(
      s.state,
      liveFeed({ phase: 'ident', course: 'Mesa Canyon · Ring Attack' }),
      0.016,
    )
    expect(s.cues).toEqual(['sting', 'music.lift'])
    // A label arriving under an ident already up is the same show.
    let u = stepTvPanel(TV_PANEL_IDLE, liveFeed({ phase: 'ident', course: '' }), 0.016)
    expect(u.cues).toEqual(['sting', 'music.lift'])
    u = stepTvPanel(u.state, liveFeed({ phase: 'ident' }), 0.016)
    expect(u.cues).toEqual([])
    // TV off: nothing stands.
    s = stepTvPanel(s.state, null, 0.016)
    expect(s.shown).toEqual({ ident: false, lowerThird: false, results: false })
  })

  it('does not cut the song when TV opens on a race already running', () => {
    const s = stepTvPanel(TV_PANEL_IDLE, liveFeed(), 0.016)
    expect(s.cues).toEqual([])
    expect(s.shown.lowerThird).toBe(true)
  })
})

describe('where the panels stand', () => {
  const inside = (p: ReturnType<typeof tvFlatPlacement>, fovDeg: number, aspect: number) => {
    const hh = Math.tan(((fovDeg / 2) * Math.PI) / 180) * -p.position[2]
    const hw = hh * aspect
    expect(Math.abs(p.position[0]) + p.width / 2).toBeLessThanOrEqual(hw + 1e-9)
    expect(Math.abs(p.position[1]) + p.height / 2).toBeLessThanOrEqual(hh + 1e-9)
  }
  const ltAspect = LOWER_THIRD_CANVAS.width / LOWER_THIRD_CANVAS.height

  it('fits every panel inside the flat frustum, landscape and portrait', () => {
    for (const [fov, aspect] of [
      [60, 16 / 9],
      [75, 21 / 9],
      [70, 9 / 19.5],
      [60, 3 / 4],
    ] as const) {
      inside(tvFlatPlacement('lowerThird', { fovDeg: fov, aspect }, ltAspect), fov, aspect)
      inside(tvFlatPlacement('ident', { fovDeg: fov, aspect }, 1400 / 360), fov, aspect)
      inside(tvFlatPlacement('results', { fovDeg: fov, aspect }, 1000 / 772), fov, aspect)
    }
  })

  it('puts the board in the top-right corner on a landscape screen (DEV-653) and across the width at the bottom in portrait', () => {
    const wide = tvFlatPlacement('lowerThird', { fovDeg: 60, aspect: 16 / 9 }, ltAspect)
    // Top right: clear of the controls (top left), the bug (bottom right) and the subject (centre).
    expect(wide.position[0]).toBeGreaterThan(0)
    expect(wide.position[1]).toBeGreaterThan(0)
    // And small: under a quarter of the frame's width (it was a third).
    const wideHalfW = Math.tan((30 * Math.PI) / 180) * (16 / 9)
    expect(wide.width / (2 * wideHalfW)).toBeLessThanOrEqual(0.22 + 1e-9)
    const tall = tvFlatPlacement('lowerThird', { fovDeg: 70, aspect: 9 / 19.5 }, ltAspect)
    expect(tall.position[0]).toBe(0)
    const hw = Math.tan((35 * Math.PI) / 180) * (9 / 19.5)
    expect(tall.width).toBeGreaterThan(hw * 2 * 0.8)
    expect(tall.position[1]).toBeLessThan(0)
  })

  it('hangs the board from its margin whatever it holds: the empty top of its canvas is shifted off', () => {
    const view = { fovDeg: 60, aspect: 16 / 9 }
    const flush = tvFlatPlacement('lowerThird', view, ltAspect, 0)
    const half = tvFlatPlacement('lowerThird', view, ltAspect, 0.5)
    expect(half.position[1] - flush.position[1]).toBeCloseTo(0.5 * flush.height, 9)
  })

  // DEV-617, Matt: "show the faceted flight logo in the bottom right of the screen".
  it('stands the bug in the bottom-right corner (top-right in portrait), clear of every panel', () => {
    /** The rectangle a placement covers on its plane: [left, bottom, right, top]. */
    const rect = (p: ReturnType<typeof tvFlatPlacement>): [number, number, number, number] => [
      p.position[0] - p.width / 2,
      p.position[1] - p.height / 2,
      p.position[0] + p.width / 2,
      p.position[1] + p.height / 2,
    ]
    const clear = (a: number[], b: number[]): boolean =>
      (a[2] as number) <= (b[0] as number) ||
      (b[2] as number) <= (a[0] as number) ||
      (a[3] as number) <= (b[1] as number) ||
      (b[3] as number) <= (a[1] as number)
    const BUG_ASPECT = 1.05 // the emblem with its wordmark: about as wide as tall
    for (const [fov, aspect] of [
      [60, 16 / 9],
      [75, 21 / 9],
      [70, 9 / 19.5],
      [60, 3 / 4],
    ] as const) {
      const view = { fovDeg: fov, aspect }
      const bug = tvFlatPlacement('bug', view, BUG_ASPECT)
      inside(bug, fov, aspect)
      const hh = Math.tan(((fov / 2) * Math.PI) / 180)
      const hw = hh * aspect
      // Hard into the right edge, a margin off it; bottom in landscape, top in portrait.
      expect(bug.position[0] + bug.width / 2).toBeGreaterThan(hw * 0.85)
      if (aspect < 1) expect(bug.position[1]).toBeGreaterThan(hh * 0.5)
      else expect(bug.position[1]).toBeLessThan(-hh * 0.5)
      const b = rect(bug)
      expect(clear(b, rect(tvFlatPlacement('lowerThird', view, ltAspect)))).toBe(true)
      expect(clear(b, rect(tvFlatPlacement('ident', view, 1400 / 360)))).toBe(true)
      expect(clear(b, rect(tvFlatPlacement('results', view, 1000 / 772)))).toBe(true)
      // Small: a broadcast bug, not a panel.
      expect(bug.width).toBeLessThan(2 * hw * 0.2)
    }
    // In a headset, low and right, facing the eye, and not on the lower third's side.
    const xr = tvHeadsetPlacement('bug', [0, 1.6, 0], BUG_ASPECT)
    expect(xr.position[0]).toBeGreaterThan(0)
    expect(xr.position[1]).toBeLessThan(1.6)
    expect(tvHeadsetPlacement('lowerThird', [0, 1.6, 0], ltAspect).position[0]).toBeLessThan(0)
  })

  it('places a headset panel against the head at the cut, facing it', () => {
    const p = tvHeadsetPlacement('lowerThird', [0.1, 1.6, -0.2], ltAspect)
    expect(p.position[1]).toBeLessThan(1.6)
    expect(p.position[2]).toBeLessThan(-0.2 - 1)
    // Tipped back toward an eye above it, and turned toward an eye to its right.
    expect(p.pitch).toBeGreaterThan(0)
    expect(p.yaw).toBeGreaterThan(0)
  })

  it('never moves a headset panel between cuts, however the head moves', () => {
    const anchor = createTvCutAnchor()
    const rig = [10, 50, -20, 0, 0.38, 0, 0.92] as const
    const first = anchor.update(rig, [0, 1.6, 0])
    expect(first.cut).toBe(true)
    for (let i = 0; i < 100; i++) {
      const a = anchor.update(rig, [Math.sin(i) * 0.3, 1.6 + Math.cos(i) * 0.1, i * 0.01])
      expect(a.cut).toBe(false)
      expect(a.head).toEqual([0, 1.6, 0])
    }
    // A cut: the rig moved. Placed afresh, against the head as it is now.
    const cut = anchor.update([200, 60, -80, 0, 0.9, 0, 0.43], [0.2, 1.5, 0.1])
    expect(cut.cut).toBe(true)
    expect(cut.head).toEqual([0.2, 1.5, 0.1])
    expect(anchor.cuts).toBe(2)
  })

  it('at launch, rig-locked: a moving rig carries the panel; a mode change or a head drift re-places it', () => {
    // DEV-481 follow-up: the headset's rig moves as the flat camera does, so
    // re-placing on every rig move would hang the panel on the head.
    const anchor = createTvCutAnchor()
    const launch = { perCut: false, key: 'director' }
    expect(anchor.update([0, 0, 0, 0, 0, 0, 1], [0, 1.6, 0], launch).cut).toBe(true)
    for (let i = 1; i < 200; i++) {
      // The chase: the rig moves and turns every frame; the head looks round a little.
      const a = anchor.update(
        [i * 2, 100, -i * 3, 0, Math.sin(i / 50), 0, Math.cos(i / 50)],
        [Math.sin(i) * 0.2, 1.6, Math.cos(i) * 0.2],
        launch,
      )
      expect(a.cut, `frame ${i}`).toBe(false)
      expect(a.head).toEqual([0, 1.6, 0])
    }
    // The viewer changes mode: placed again, against the head as it is now.
    const mode = anchor.update([400, 100, -600, 0, 0, 0, 1], [0.1, 1.6, 0.1], {
      perCut: false,
      key: 'follow',
    })
    expect(mode.cut).toBe(true)
    expect(mode.head).toEqual([0.1, 1.6, 0.1])
    // The wearer stands up: the head is far from where the panel was placed.
    const stood = anchor.update([410, 100, -610, 0, 0, 0, 1], [0.1, 2.4, 0.1], {
      perCut: false,
      key: 'follow',
    })
    expect(stood.cut).toBe(true)
    expect(anchor.cuts).toBe(3)
  })
})

// DEV-792, QUESTIONS item 11: Matt, 2026-10-07 ("go with your recs", whose rec was
// "keep the size, not in VR"): the bug is not drawn in a headset, which has no
// screen corner for a broadcast bug to stand in. DEV-617 had shown it low and
// right; the panel is built from a canvas and a GL context, so the rule is read
// as source (`tv-camera.spec.ts`'s probe reads `bug` on a flat screen).
describe('the bug is not drawn in a headset (DEV-792, item 11)', () => {
  it('is shown only while the headset is NOT presenting', () => {
    const src = fs
      .readFileSync('src/render/tv-panel.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/\s+/g, ' ')
    expect(src).toMatch(/bugShown = feed !== null && onScreen && bugBuilt && !presentingNow/)
    // And `presentingNow` is the session's own flag, set before it is read.
    expect(src).toMatch(
      /presentingNow = o\.xr\.isPresenting .*?bugShown = feed !== null && onScreen && bugBuilt && !presentingNow/,
    )
  })
})
