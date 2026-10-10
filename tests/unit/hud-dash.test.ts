// tests/unit/hud-dash.test.ts — DEV-362: the readout set into the dash.
//
// No disk here: the mesh and the prefab are `hud-recess.test.ts`'s. This file
// holds the parts a node suite can reach — the drawing's prediction against
// the drawing (trap 24: measure the code, not a second reading of it), the
// panel's two mounts through the REAL `createHud`, the race map moving inside
// the upper screen, and the JumpSeat's panel NOT moving (the lead's condition).

import fs from 'node:fs'
import * as THREE from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type EditionCockpitPlacement,
  hudPlacementFor,
  hudPlacementKey,
} from '@/content/edition-schema'
import { EYE } from '@/game/flight'
import { JUMPSEAT_EYE } from '@/game/jumpseat-flight'
import {
  createHud,
  dashContent,
  HEIGHT,
  HUD_GAUGE_PALETTE,
  type HudState,
  PIXELS_PER_METRE,
  WIDTH,
} from '@/render/hud'
import {
  createDashGeometry,
  DASH_CARD,
  DASH_PLATE_STRIP,
  DASH_PLATE_UPPER,
  DASH_POSE_2016,
  DASH_SCREEN,
  DASH_STRIP,
  DASH_TANK_HEIGHT,
  DASH_TANK_LIFT,
  type DashContent,
  dashCanvasOps,
  dashLayout,
  dashSideInsetPx,
  dashSidePlateX,
  dashSplitRow,
  drawDash,
  placeHudAt,
  tankMark,
  tankWord,
} from '@/render/hud-dash'
import { HUD_LAYOUT_JUMPSEAT } from '@/render/hud-fuel'
import anniversary from '../../content/editions/anniversary.json'

const CANVAS_W = Math.round(WIDTH * PIXELS_PER_METRE)
const CANVAS_H = Math.round(HEIGHT * PIXELS_PER_METRE)

// ── A counting 2-D context, with the one call the lens panel never makes ────

interface Drawn {
  readonly text: string
  /** Device-space left edge and the widest it may reach, px. */
  readonly left: number
  readonly right: number
  readonly align: string
  /** The y it was drawn at, the baseline in force, and the font. */
  readonly y: number
  readonly baseline: string
  readonly font: string
  readonly ink: string
}
interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly ink: string
}
interface Recorder {
  ops: { total: number; texts: number; measures: number }
  drawn: Drawn[]
  rects: Rect[]
}

const recordingContext = () => {
  const rec: Recorder = { ops: { total: 0, texts: 0, measures: 0 }, drawn: [], rects: [] }
  let sx = 1
  const call = () => {
    rec.ops.total += 1
  }
  const context = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 0,
    textAlign: 'left',
    textBaseline: '',
    clearRect: call,
    fillRect(x: number, y: number, w: number, h: number) {
      rec.ops.total += 1
      rec.rects.push({ x: x * sx, y, w: w * sx, h, ink: context.fillStyle })
    },
    beginPath: call,
    roundRect: call,
    fill: call,
    stroke: call,
    setTransform: (a: number) => {
      rec.ops.total += 1
      sx = a
    },
    fillText(text: string, x: number, y: number, maxWidth?: number) {
      rec.ops.total += 1
      rec.ops.texts += 1
      // Where a left-aligned run may reach, in DEVICE px: `maxWidth` bounds it.
      const reach = maxWidth ?? text.length * 30
      const align = context.textAlign
      const left =
        align === 'left' ? x * sx : align === 'right' ? (x - reach) * sx : (x - reach / 2) * sx
      rec.drawn.push({
        text,
        left,
        right: left + reach * sx,
        align,
        y,
        baseline: context.textBaseline,
        font: context.font,
        ink: context.fillStyle,
      })
    },
    measureText: (s: string) => {
      rec.ops.total += 1
      rec.ops.measures += 1
      return { width: s.length * 8 }
    },
  }
  return { context, rec }
}

const installCanvas = () => {
  const { context, rec } = recordingContext()
  const element = { width: 0, height: 0, getContext: () => context }
  vi.stubGlobal('document', { createElement: () => element })
  return rec
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

const INKS = {
  ink: '#fff',
  accent: '#fc0',
  muted: '#888',
  charge: '#0ff',
  tankTrack: '#022',
  plateEdge: '#9cc',
  boostOut: '#f85',
  boostOutTrack: '#410',
}

const state = (over: Partial<HudState> = {}): HudState => ({
  ringsPassed: 13,
  ringsTotal: 28,
  score: 0,
  elapsed: 44,
  timeLimit: 180,
  timeCountsDown: true,
  speed: 150,
  medal: '',
  finished: false,
  countLabel: 'GATES',
  timeLabel: 'TIME',
  speedLabel: 'SPEED',
  banner: null,
  autopilot: false,
  ...over,
})

/** Every shape of content the dash can be asked for. */
const CONTENTS: Record<string, DashContent> = {
  classic: dashContent(state()),
  banner: dashContent(state({ banner: 'PRESS A TO LAUNCH' })),
  countdown: dashContent(state({ banner: '3' })),
  medal: dashContent(state({ finished: true, medal: 'gold' })),
  anniversary: dashContent(
    state({
      speedUnit: 'kmh',
      chain: { stacks: 3, fraction: 0.5 },
      energy: { fraction: 0.7, available: true },
      autopilot: true,
    }),
  ),
  emptyBars: dashContent(
    state({
      chain: { stacks: 1, fraction: 0 },
      energy: { fraction: 0, available: false },
    }),
  ),
  loss: dashContent(state({ award: 'STREAK LOST', awardTone: 'loss', multiplier: 3 })),
  // DEV-567: the boost tank out and refilling, which draws the quarter mark.
  boostOut: dashContent(
    state({ energy: { fraction: 0.15, available: false, burning: false, reengage: 0.25 } }),
  ),
}

describe('drawDash — the prediction against the drawing', () => {
  for (const [name, content] of Object.entries(CONTENTS)) {
    it(`${name}: dashCanvasOps matches what drawDash asked of the context`, () => {
      const { context, rec } = recordingContext()
      drawDash(context as never, CANVAS_W, CANVAS_H, content, INKS)
      expect(rec.ops).toEqual(dashCanvasOps(content))
    })
  }

  it('Classic draws 2016’s five words and nothing else: two screens, no bars, no badges', () => {
    const { context, rec } = recordingContext()
    drawDash(context as never, CANVAS_W, CANVAS_H, CONTENTS.classic as DashContent, INKS)
    expect(rec.drawn.map((d) => d.text)).toEqual([
      'GATES:',
      '13/28',
      'TIME:',
      '136',
      'SPEED:',
      '150',
    ])
    // clearRect, the upper plate, the swatch: three rectangles and no bar.
    const ops = dashCanvasOps(CONTENTS.classic as DashContent)
    expect(ops.total - ops.texts).toBe(3 + 4)
  })

  it('every run of text stays on its screen, and clear of a side plate', () => {
    for (const inset of [0, dashSideInsetPx(0.11, CANVAS_W)]) {
      for (const [name, content] of Object.entries(CONTENTS)) {
        const { context, rec } = recordingContext()
        drawDash(context as never, CANVAS_W, CANVAS_H, content, INKS, inset)
        const L = dashLayout(CANVAS_W, CANVAS_H, inset)
        for (const d of rec.drawn) {
          expect(d.left, `${name} "${d.text}" starts off the canvas`).toBeGreaterThanOrEqual(-0.5)
          // The upper screen's text must not run under the map; the card's
          // (the speed line) has the whole width, because the map is not on it.
          const onCard = d.text === content.speedLabel || d.text === content.speedValue
          const limit = onCard ? CANVAS_W : L.area
          expect(
            d.right,
            `${name} "${d.text}" runs past ${limit} with inset ${inset}`,
          ).toBeLessThanOrEqual(limit + 0.5)
        }
      }
    }
  })
})

// ── DEV-615: just boost and gates ────────────────────────────────────────
//
// Matt, 2026-10-03: *"in flight hud - let's remove the bars from speed and
// time. just boost and gates. (to show the gate combo countdown)"*. Measured
// on the drawing, both mounts: where every bar rect lands, against the lines
// it belongs to.
describe('DEV-615: two bars, the gate combo under GATES and the tank', () => {
  const live = state({
    chain: { stacks: 3, fraction: 0.4 },
    energy: { fraction: 0.7, available: true, burning: false, reengage: 0.25 },
  })
  const dashRects = (s: HudState) => {
    const { context, rec } = recordingContext()
    const content = dashContent(s)
    drawDash(context as never, CANVAS_W, CANVAS_H, content, INKS)
    const L = dashLayout(CANVAS_W, CANVAS_H, 0, content.energy !== undefined)
    // Every fillRect but the two plates (the swatch is the strip's).
    const bars = rec.rects.filter((r) => r.ink !== DASH_PLATE_UPPER && r.ink !== DASH_PLATE_STRIP)
    return { bars, L }
  }

  it('the dash: the combo sits between the GATES and TIME lines, the tank under TIME', () => {
    const { bars, L } = dashRects(live)
    const [b0, b1] = L.upperBaselines
    const tank = bars.filter((r) => r.y >= L.tankY - 0.01 && r.y < L.tankY + L.tankH)
    const combo = bars.filter((r) => r.y > b0 && r.y < b1 && !tank.includes(r))
    // The track and a 40 % fill, in the panel's own inks.
    expect(combo.map((r) => r.ink)).toEqual([INKS.plateEdge, INKS.accent])
    expect((combo[1]?.w ?? 0) / (combo[0]?.w ?? 1)).toBeCloseTo(0.4, 9)
    expect(tank.length).toBeGreaterThan(0)
    // Nothing else: every bar rect is one of the two.
    expect(bars.length).toBe(combo.length + tank.length)
  })

  it('the dash: no bar on the speed card', () => {
    const { bars, L } = dashRects(live)
    expect(bars.filter((r) => r.y >= L.split)).toEqual([])
  })

  it('no combo banked: no combo bar at all, and no track standing in for one', () => {
    const { bars, L } = dashRects(state({ chain: { stacks: 0, fraction: 0 } }))
    const [b0, b1] = L.upperBaselines
    expect(bars.filter((r) => r.y > b0 && r.y < b1)).toEqual([])
  })

  it('the lens: the combo on the GATES row, the tank on TIME, nothing on SPEED', () => {
    const rec = installCanvas()
    const hud = createHud()
    hud.update(live, 0)
    hud.dispose()
    // Three rows, each a third of the panel near enough. Every fillRect on
    // the lens is a bar: its plates are rounded paths.
    const row = (y: number) => Math.floor((y / CANVAS_H) * 3)
    const combo = rec.rects.filter(
      (r) => r.ink === HUD_GAUGE_PALETTE.accent || r.ink === HUD_GAUGE_PALETTE.plateEdge,
    )
    expect(combo.map((r) => r.ink)).toEqual([HUD_GAUGE_PALETTE.plateEdge, HUD_GAUGE_PALETTE.accent])
    expect(combo.map((r) => row(r.y))).toEqual([0, 0])
    expect(rec.rects.filter((r) => row(r.y) === 1).length).toBeGreaterThan(0)
    expect(rec.rects.filter((r) => row(r.y) === 2)).toEqual([])
  })
})

describe('the dash geometry — three quads, one draw', () => {
  const geometry = createDashGeometry(CANVAS_H)
  const pos = geometry.getAttribute('position')
  const uv = geometry.getAttribute('uv')
  const index = geometry.getIndex()

  it('is three quads, strip first and the upper screen last (draw order: no depth write)', () => {
    expect(pos.count).toBe(12)
    expect(index?.count).toBe(18)
    // The last quad is the upper screen, centred on the panel's origin and flat.
    const centre = new THREE.Vector3()
    for (let i = 8; i < 12; i++) centre.add(new THREE.Vector3().fromBufferAttribute(pos, i))
    centre.divideScalar(4)
    expect(centre.length()).toBeLessThan(1e-6)
    for (let i = 8; i < 12; i++) expect(Math.abs(pos.getZ(i))).toBeLessThan(1e-9)
  })

  it('each quad is its 2016 rectangle — measured off the vertices, not the transform', () => {
    const size = (q: number) => {
      const a = new THREE.Vector3().fromBufferAttribute(pos, q * 4)
      const b = new THREE.Vector3().fromBufferAttribute(pos, q * 4 + 1)
      const c = new THREE.Vector3().fromBufferAttribute(pos, q * 4 + 2)
      return {
        w: a.distanceTo(b),
        h: a.distanceTo(c),
        right: b.clone().sub(a).dot(c.clone().sub(a)),
      }
    }
    for (const [q, want] of [
      [0, DASH_STRIP],
      [1, DASH_CARD],
      [2, DASH_SCREEN],
    ] as const) {
      const s = size(q)
      expect(s.w).toBeCloseTo(want.width, 6)
      expect(s.h).toBeCloseTo(want.height, 6)
      expect(Math.abs(s.right), 'a rectangle, not a parallelogram').toBeLessThan(1e-9)
    }
  })

  it('maps the upper band, the card band and the swatch — the three never overlap', () => {
    const split = dashSplitRow(CANVAS_H)
    const v = (row: number) => 1 - row / CANVAS_H
    const vs = (q: number) => [0, 1, 2, 3].map((k) => uv.getY(q * 4 + k))
    // Strip: one v, inside the swatch.
    const strip = vs(0)
    expect(new Set(strip.map((x) => x.toFixed(9))).size).toBe(1)
    expect(strip[0]).toBeLessThan(v(CANVAS_H - 4))
    // Card: [split, swatch). Upper: [0, split). Float32 attributes, so six places.
    expect(Math.max(...vs(1))).toBeCloseTo(v(split), 6)
    expect(Math.min(...vs(1))).toBeCloseTo(v(CANVAS_H - 4), 6)
    expect(Math.max(...vs(2))).toBeCloseTo(1, 6)
    expect(Math.min(...vs(2))).toBeCloseTo(v(split), 6)
  })

  it('carries the upper screen as its `parameters`, which the HUD pixel specs read', () => {
    const p = (geometry as THREE.BufferGeometry & { parameters: Record<string, number> }).parameters
    expect(p.width).toBe(DASH_SCREEN.width)
    expect(p.height).toBe(DASH_SCREEN.height)
    expect(p.upperShare).toBeCloseTo(dashSplitRow(CANVAS_H) / CANVAS_H, 12)
  })
})

describe('createHud’s two mounts', () => {
  it('is born on the lens: the flat plate, depthTest off — the panel as it was', () => {
    installCanvas()
    const hud = createHud()
    const mesh = hud.object as THREE.Mesh
    expect(hud.mount).toBe('lens')
    expect(mesh.geometry).toBeInstanceOf(THREE.PlaneGeometry)
    expect((mesh.material as THREE.Material).depthTest).toBe(false)
  })

  it('in the dash: three quads, depth TESTED, and the repaint is the dash drawing', () => {
    const rec = installCanvas()
    const hud = createHud()
    hud.setMount('dash')
    const mesh = hud.object as THREE.Mesh
    expect(mesh.geometry.getAttribute('position').count).toBe(12)
    expect((mesh.material as THREE.Material).depthTest).toBe(true)
    const s = state()
    hud.update(s, 0)
    expect(hud.report().canvasOps).toEqual(dashCanvasOps(dashContent(s)))
    expect(hud.report().mount).toBe('dash')
    expect(rec.drawn.map((d) => d.text)).toContain('SPEED:')
  })

  it('back on the lens it is the ORIGINAL plane, and a mount change is a repaint owed', () => {
    const rec = installCanvas()
    const hud = createHud()
    const lens = (hud.object as THREE.Mesh).geometry
    hud.setMount('dash')
    hud.update(state(), 0)
    const paints = hud.paints
    hud.setMount('lens')
    expect((hud.object as THREE.Mesh).geometry).toBe(lens)
    expect(((hud.object as THREE.Mesh).material as THREE.Material).depthTest).toBe(false)
    // Same state, 200 ms on: past the 10 Hz interval, so the owed paint lands.
    rec.drawn.length = 0
    hud.update(state(), 200)
    expect(hud.paints).toBe(paints + 1)
    // The lens drawing's plates carry the label and value on one row each.
    expect(rec.drawn.map((d) => d.text)).toContain('GATES:')
  })

  it('the JumpSeat’s fuel dome (DEV-360) is never set into a dash — it stood free in 2016', () => {
    installCanvas()
    const hud = createHud({ layout: HUD_LAYOUT_JUMPSEAT })
    const geometry = (hud.object as THREE.Mesh).geometry
    hud.setMount('dash')
    expect(hud.mount).toBe('lens')
    expect((hud.object as THREE.Mesh).geometry).toBe(geometry)
    expect(((hud.object as THREE.Mesh).material as THREE.Material).depthTest).toBe(false)
  })

  it('setMount is guarded — asserting the mount it is in changes nothing', () => {
    installCanvas()
    const hud = createHud()
    hud.setMount('dash')
    hud.update(state(), 0)
    const paints = hud.paints
    hud.setMount('dash')
    hud.update(state(), 200)
    expect(hud.paints).toBe(paints)
  })
})

describe('DEV-555: the tank names itself in the dash, as it does on the lens', () => {
  // The emulated-headset pass (2026-10-01, problem 1): the dash returned into
  // `drawDash` before the lens draw's DEV-410 word, so a headset never showed
  // BOOST or EMPTY. The lens drawing is the oracle here, measured through the
  // real `createHud`, and the literals pin it so the comparison cannot pass
  // with both sides drawing nothing.
  const TANK_WORDS = new Set(['BOOST', 'EMPTY'])
  const tankWords = (rec: Recorder) => rec.drawn.filter((d) => TANK_WORDS.has(d.text))
  const paint = (mount: 'lens' | 'dash', s: HudState) => {
    const rec = installCanvas()
    const hud = createHud()
    if (mount === 'dash') hud.setMount('dash')
    hud.update(s, 0)
    hud.dispose()
    return rec
  }
  const CASES: readonly [string, { fraction: number; available: boolean }, string][] = [
    ['full', { fraction: 1, available: true }, 'BOOST'],
    ['half', { fraction: 0.5, available: true }, 'BOOST'],
    ['empty', { fraction: 0, available: false }, 'EMPTY'],
    ['refilling, still locked out', { fraction: 0.2, available: false }, 'EMPTY'],
  ]

  for (const [name, energy, expected] of CASES) {
    it(`${name}: the dash draws ${expected}, the word the lens draws`, () => {
      const s = state({ energy })
      const lens = tankWords(paint('lens', s)).map((d) => d.text)
      const dash = tankWords(paint('dash', s)).map((d) => d.text)
      expect(lens).toEqual([expected])
      expect(dash).toEqual(lens)
    })
  }

  it('no tank, no word: Classic and the gauges port draw none in the dash', () => {
    expect(tankWords(paint('dash', state()))).toEqual([])
  })

  it('the word sits inside the tank track, at its left end, as tall as the track allows', () => {
    for (const inset of [0, dashSideInsetPx(0.11, CANVAS_W)]) {
      for (const [name, energy] of CASES) {
        const { context, rec } = recordingContext()
        drawDash(context as never, CANVAS_W, CANVAS_H, dashContent(state({ energy })), INKS, inset)
        // The track is the first rectangle in a track's ink (DEV-567: the warm
        // one while boost is out); the fill comes after it.
        const track = rec.rects.find(
          (r) => r.ink === INKS.tankTrack || r.ink === INKS.boostOutTrack,
        )
        const [word] = tankWords(rec)
        expect(track, name).toBeDefined()
        expect(word, name).toBeDefined()
        if (!track || !word) continue
        const px = Number(/(\d+(?:\.\d+)?)px/.exec(word.font)?.[1])
        // CRYSTAL's caps are 0.70 em (hud-dash.ts, BASELINE), and so are the
        // fallback's near enough: the caps stand on the baseline and reach up.
        const cap = px * 0.7
        expect(word.baseline, name).toBe('alphabetic')
        expect(word.y, `${name}: baseline below the track`).toBeLessThanOrEqual(
          track.y + track.h + 0.5,
        )
        expect(word.y - cap, `${name}: caps above the track`).toBeGreaterThanOrEqual(track.y - 0.5)
        expect(cap, `${name}: caps under 60 % of the track`).toBeGreaterThanOrEqual(track.h * 0.6)
        expect(word.left, name).toBeGreaterThanOrEqual(track.x)
        expect(word.left - track.x, `${name}: not at the left end`).toBeLessThan(track.h)
        expect(word.right, `${name}: runs off the track`).toBeLessThanOrEqual(
          track.x + track.w + 0.5,
        )
      }
    }
  })

  it('dark ink where the charge covers the word, light ink on the bare track', () => {
    const inkAt = (fraction: number, available: boolean) => {
      const { context, rec } = recordingContext()
      const content = dashContent(state({ energy: { fraction, available } }))
      drawDash(context as never, CANVAS_W, CANVAS_H, content, INKS)
      return tankWords(rec)[0]?.ink
    }
    expect(inkAt(1, true)).toBe(INKS.tankTrack)
    expect(inkAt(0, false)).toBe(INKS.ink)
    expect(inkAt(0.02, true)).toBe(INKS.ink)
  })
})

describe('DEV-567: the boost tank says READY, BOOST or EMPTY, and the out state is a hue', () => {
  // The five places `sim/energy.ts` puts a player (DEVIATIONS DEV-567's
  // table), as the boost tank reports them: `burning` and `reengage` set.
  // Anniversary's quarter is read from the edition rather than typed.
  const quarter = anniversary.gameplay.energy.reengage
  const TANK = (fraction: number, available: boolean, burning: boolean) => ({
    fraction,
    available,
    burning,
    reengage: quarter,
  })
  const STATES = {
    full: TANK(1, true, false),
    boosting: TANK(0.6, true, true),
    'ready, low': TANK(0.12, true, false),
    'out, empty': TANK(0, false, false),
    'out, refilling': TANK(0.18, false, false),
  } as const
  const WORDS: Record<keyof typeof STATES, string> = {
    full: 'READY',
    boosting: 'BOOST',
    'ready, low': 'READY',
    'out, empty': 'EMPTY',
    'out, refilling': 'EMPTY',
  }
  const TANK_WORDS = new Set(['READY', 'BOOST', 'EMPTY'])
  const dash = (energy: (typeof STATES)[keyof typeof STATES], inset = 0) => {
    const { context, rec } = recordingContext()
    drawDash(context as never, CANVAS_W, CANVAS_H, dashContent(state({ energy })), INKS, inset)
    const L = dashLayout(CANVAS_W, CANVAS_H, inset, true)
    // The tank's rects are the ones in its band; the combo's bar is not there.
    const inBand = rec.rects.filter((r) => r.y >= L.tankY - 0.01 && r.y < L.tankY + L.tankH)
    const word = rec.drawn.find((d) => TANK_WORDS.has(d.text))
    return { rec, L, rects: inBand, word }
  }

  it('the quarter is the edition’s, and it is 0.25 (a number Matt can argue with)', () => {
    expect(quarter).toBe(0.25)
  })

  for (const [name, energy] of Object.entries(STATES) as [keyof typeof STATES, never][]) {
    it(`${name}: the word is ${WORDS[name]}, on the dash and on the lens alike`, () => {
      expect(tankWord(energy)).toBe(WORDS[name])
      expect(dash(energy).word?.text).toBe(WORDS[name])
      const rec = installCanvas()
      const hud = createHud()
      hud.update(state({ energy }), 0)
      hud.dispose()
      expect(rec.drawn.filter((d) => TANK_WORDS.has(d.text)).map((d) => d.text)).toEqual([
        WORDS[name],
      ])
    })
  }

  it('available is cool and out is warm, track and fill both: the trap pair differs by HUE', () => {
    // States 4 and 5 of the row: both a short bar below the quarter. One boosts
    // and one does not, and the only difference used to be two pale cyans.
    const low = dash(STATES['ready, low']).rects
    const out = dash(STATES['out, refilling']).rects
    expect(low.map((r) => r.ink)).toEqual([INKS.tankTrack, INKS.charge])
    expect(out[0]?.ink).toBe(INKS.boostOutTrack)
    expect(out[1]?.ink).toBe(INKS.boostOut)
    // And an empty tank, with nothing to fill, is still warm by its track.
    expect(dash(STATES['out, empty']).rects[0]?.ink).toBe(INKS.boostOutTrack)
    for (const s of ['full', 'boosting'] as const) {
      expect(dash(STATES[s]).rects.map((r) => r.ink)).toEqual([INKS.tankTrack, INKS.charge])
    }
  })

  it('the quarter mark is drawn only while boost is out, at the quarter, inside the track', () => {
    for (const s of ['full', 'boosting', 'ready, low'] as const) {
      expect(
        dash(STATES[s]).rects.filter((r) => r.ink === INKS.ink),
        s,
      ).toEqual([])
    }
    for (const inset of [0, dashSideInsetPx(0.11, CANVAS_W)]) {
      for (const s of ['out, empty', 'out, refilling'] as const) {
        const { rects } = dash(STATES[s], inset)
        const track = rects[0]
        const marks = rects.filter((r) => r.ink === INKS.ink)
        expect(marks, s).toHaveLength(1)
        const [m] = marks
        if (!track || !m) continue
        expect(m.x + m.w / 2).toBeCloseTo(track.x + track.w * quarter, 6)
        expect(m.y).toBeCloseTo(track.y, 6)
        expect(m.h).toBeCloseTo(track.h, 6)
        expect(m.w).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it('no reengage, no mark: the energy race and the glider read as before', () => {
    expect(tankMark({ fraction: 0.1, available: false })).toBeNull()
    expect(tankWord({ fraction: 1, available: true })).toBe('BOOST')
    expect(tankWord({ fraction: 0, available: false })).toBe('EMPTY')
  })

  it('the tank is twice DEV-143’s height, and the lines ride up only where it is drawn', () => {
    // Pinned as VALUES (DEV-266's rule): the shares a person edits on purpose.
    expect(DASH_TANK_HEIGHT).toBe(0.14)
    expect(DASH_TANK_LIFT).toBe(0.07)
    const plain = dashLayout(CANVAS_W, CANVAS_H)
    const tank = dashLayout(CANVAS_W, CANVAS_H, 0, true)
    // DEV-143's dash track was 0.07 of the upper screen.
    expect(tank.tankH).toBeGreaterThanOrEqual(2 * 0.07 * tank.split - 1e-9)
    // Classic (no tank): 2016's baselines, untouched.
    expect(plain.upperBaselines[0]).toBeCloseTo((0.0803 + 0.4155) * plain.split, 9)
    expect(plain.upperBaselines[1]).toBeCloseTo((0.4596 + 0.4155) * plain.split, 9)
    // With the tank: both lines up by the same lift, the type the same size.
    expect(plain.upperBaselines[0] - tank.upperBaselines[0]).toBeCloseTo(
      DASH_TANK_LIFT * tank.split,
      9,
    )
    expect(plain.upperBaselines[1] - tank.upperBaselines[1]).toBeCloseTo(
      DASH_TANK_LIFT * tank.split,
      9,
    )
    expect(tank.upperFont).toBe(plain.upperFont)
    // The tank sits under the time line and inside the upper screen.
    expect(tank.tankY).toBeGreaterThan(tank.upperBaselines[1])
    expect(tank.tankY + tank.tankH).toBeLessThanOrEqual(tank.split)
    // The count's caps (0.7 em) still start inside the screen.
    expect(tank.upperBaselines[0] - 0.7 * tank.upperFont).toBeGreaterThan(0)
  })

  it('Classic’s dash draws its lines where 2016 put them (no tank, no lift)', () => {
    const { context, rec } = recordingContext()
    drawDash(context as never, CANVAS_W, CANVAS_H, CONTENTS.classic as DashContent, INKS)
    const L = dashLayout(CANVAS_W, CANVAS_H)
    const time = rec.drawn.find((d) => d.text === 'TIME:')
    expect(time?.y).toBeCloseTo(L.upperBaselines[1], 9)
  })
})

describe('DEV-361’s race map, inside the dash', () => {
  const plate = () => {
    const object = new THREE.Mesh(
      new THREE.PlaneGeometry(0.11, 0.145),
      new THREE.MeshBasicMaterial({ depthTest: false }),
    )
    // Where race-map.ts puts itself: beside the lens panel.
    object.position.x = WIDTH / 2 + 0.03 + 0.11 / 2
    return object
  }

  it('moves inside the upper screen in the dash, and back beside the plate on the lens', () => {
    installCanvas()
    const hud = createHud()
    const map = plate()
    const lensX = map.position.x
    hud.object.add(map)
    hud.setSidePlate(map, 0.11)
    expect(map.position.x).toBe(lensX)
    hud.setMount('dash')
    expect(map.position.x).toBeCloseTo(dashSidePlateX(0.11), 12)
    // Inside: the plate's right edge is inside the screen's.
    expect(map.position.x + 0.11 / 2).toBeLessThan(DASH_SCREEN.width / 2)
    expect((map.material as THREE.Material).depthTest).toBe(true)
    hud.setMount('lens')
    expect(map.position.x).toBe(lensX)
    expect((map.material as THREE.Material).depthTest).toBe(false)
  })

  it('narrows the upper screen’s text for it, and only in the dash', () => {
    const rec = installCanvas()
    const hud = createHud()
    hud.setMount('dash')
    const map = plate()
    hud.object.add(map)
    hud.setSidePlate(map, 0.11)
    hud.update(state(), 0)
    const area = dashLayout(CANVAS_W, CANVAS_H, dashSideInsetPx(0.11, CANVAS_W)).area
    const count = rec.drawn.find((d) => d.text === '13/28')
    expect(count).toBeDefined()
    expect((count as Drawn).right).toBeLessThanOrEqual(area + 0.5)
  })
})

describe('the placement blocks — one per vehicle, and the JumpSeat does not move', () => {
  const editions = ['anniversary', 'classic'].map((id) => ({
    id,
    placement: (
      JSON.parse(fs.readFileSync(`content/editions/${id}.json`, 'utf8')) as {
        cockpit: { placement: EditionCockpitPlacement }
      }
    ).cockpit.placement,
  }))

  it('the JumpSeat reads its own block, and it is the pose both vehicles had before DEV-362', () => {
    // Pinned as VALUES, on purpose (DEV-266's rule): this is the number that
    // must not move, and a test that derived it would move with it.
    for (const { id, placement } of editions) {
      const p = hudPlacementFor(placement, 'jumpseat')
      expect(p, id).toBe(placement.jumpSeatHud)
      expect(p.offset, id).toEqual([0, -0.3, -0.72])
      expect(p.tilt, id).toBe(-0.42)
      expect(p.scale, id).toBe(1)
      // And through the one rule both vehicles place with, from ITS eye:
      const o = new THREE.Object3D()
      placeHudAt(o, p, JUMPSEAT_EYE)
      expect(o.position.x).toBeCloseTo(JUMPSEAT_EYE.x, 12)
      expect(o.position.y).toBeCloseTo(JUMPSEAT_EYE.y - 0.3, 12)
      expect(o.position.z).toBeCloseTo(JUMPSEAT_EYE.z - 0.72, 12)
      expect(o.rotation.x).toBe(-0.42)
    }
  })

  it('the HoverJet reads `hud`, which is 2016’s upper screen', () => {
    for (const { id, placement } of editions) {
      const p = hudPlacementFor(placement, 'hoverjet')
      expect(p, id).toBe(placement.hud)
      expect(p.offset, id).toEqual([...DASH_POSE_2016.offset])
      expect(p.tilt, id).toBe(DASH_POSE_2016.tilt)
      expect(p.scale, id).toBe(1)
    }
  })

  it('the lookdev folder pastes back under the key the vehicle reads', () => {
    expect(hudPlacementKey('hoverjet')).toBe('hud')
    expect(hudPlacementKey('jumpseat')).toBe('jumpSeatHud')
  })

  it('the HoverJet’s placement puts the upper screen where 2016’s was, from ITS eye', () => {
    const o = new THREE.Object3D()
    placeHudAt(o, { offset: DASH_POSE_2016.offset, tilt: DASH_POSE_2016.tilt, scale: 1 }, EYE)
    // 2016's `panel_shipUI` centre, composed in `render/hud-dash.ts`'s header.
    expect(o.position.x).toBeCloseTo(-0.0044, 4)
    expect(o.position.y).toBeCloseTo(0.486, 3)
    expect(o.position.z).toBeCloseTo(0.4239, 3)
  })
})
