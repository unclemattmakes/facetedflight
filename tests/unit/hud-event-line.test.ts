// tests/unit/hud-event-line.test.ts — bonus text beside the count, not on it. DEV-397.
//
// `docs/BUGS.md`, 2026-09-24: *"`CLEAN X3  LOW +10`, `+3 AUTO` and `BOOST READY`
// are drawn on the GATES / PADS row, on top of the numerator they annotate …
// After the finish the row still says `BOOST READY` and `+4 AUTO`."*
//
// Held as GEOMETRY, on both mounts, through the real drawings: every run of
// text becomes the box it may occupy — its cap height above its baseline, and
// across, the span `fillText` allows it. `fillText` never draws past its
// `maxWidth` (the canvas spec's rule), so a bounded run's box is its bound; an
// unbounded run's is its measured width. Two boxes that do not meet are two
// runs that cannot overlap, in CRYSTAL, in the italic stack, at any length.
// The widths here are a stand-in font's (0.55 em a glyph); the claim does not
// rest on them, because every placement it checks is itself measured.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHud,
  dashContent,
  HEIGHT,
  type HudState,
  hudBadges,
  hudCanvasOps,
  PIXELS_PER_METRE,
  WIDTH,
} from '@/render/hud'
import { type DashContent, dashSideInsetPx, drawDash } from '@/render/hud-dash'
import { fuelBadges } from '@/render/hud-fuel'

const W = Math.round(WIDTH * PIXELS_PER_METRE)
const H = Math.round(HEIGHT * PIXELS_PER_METRE)
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

interface Box {
  readonly text: string
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

/** A 2-D context that records every run of text as the device-space box it may occupy. */
const recorder = () => {
  const boxes: Box[] = []
  let sx = 1
  const noop = () => {}
  const px = () => Number(/(\d+(?:\.\d+)?)px/.exec(context.font)?.[1] ?? 10)
  const width = (s: string) => s.length * 0.55 * px()
  const context = {
    fillStyle: '',
    strokeStyle: '',
    font: '10px x',
    lineWidth: 0,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    clearRect: noop,
    fillRect: noop,
    beginPath: noop,
    roundRect: noop,
    fill: noop,
    stroke: noop,
    setTransform: (a: number) => {
      sx = a
    },
    fillText(text: string, x: number, y: number, maxWidth?: number) {
      const reach = maxWidth === undefined ? width(text) : Math.min(maxWidth, width(text))
      const a = context.textAlign
      const left = a === 'left' ? x : a === 'right' ? x - reach : x - reach / 2
      // Caps and figures stand ~0.7 em above the baseline in both faces.
      boxes.push({
        text,
        left: left * sx,
        right: (left + reach) * sx,
        top: y - 0.72 * px(),
        bottom: y,
      })
    },
    measureText: (s: string) => ({ width: width(s) }),
  }
  return { context, boxes }
}

/** Every pair of boxes that meet, as readable lines. */
const collisions = (boxes: readonly Box[]): string[] => {
  const out: string[] = []
  boxes.forEach((a, i) => {
    for (const b of boxes.slice(i + 1)) {
      const across = a.left < b.right - 0.5 && b.left < a.right - 0.5
      const down = a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
      if (across && down) out.push(`"${a.text}" meets "${b.text}"`)
    }
  })
  return out
}

const state = (over: Partial<HudState> = {}): HudState => ({
  ringsPassed: 13,
  ringsTotal: 21,
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

/** The frames the row was written about, and their neighbours. */
const FRAMES: Record<string, HudState> = {
  busy: state({
    speedUnit: 'kmh',
    award: 'CLEAN x3  LOW +10',
    awardTone: 'gain',
    multiplier: 3,
    autopilot: true,
    chain: { stacks: 3, fraction: 0.5 },
    energy: { fraction: 0.7, available: true },
  }),
  boostReady: state({ award: 'BOOST READY', autopilot: true, chain: { stacks: 3, fraction: 1 } }),
  badgesOnly: state({ autopilot: true, multiplier: 4, chain: { stacks: 4, fraction: 1 } }),
  midRunMedal: state({ award: 'gold medal AwarDeD!', countLabel: 'ORBS' }),
  finished: state({ finished: true, medal: 'gold', autopilot: true, multiplier: 3 }),
}

const drawDashBoxes = (content: DashContent, inset = 0): Box[] => {
  const { context, boxes } = recorder()
  drawDash(context as never, W, H, content, INKS, inset)
  return boxes
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('the dash: an event and the badges beside the count, never on it', () => {
  it('draws the count’s number while an event is up, the event in the label’s slot', () => {
    for (const award of ['CLEAN x3  LOW +10', 'BOOST READY', 'gold medal AwarDeD!', '+60']) {
      const texts = drawDashBoxes(dashContent(state({ award }))).map((b) => b.text)
      expect(texts, award).toContain('13/21')
      expect(texts, award).toContain(award.toUpperCase())
      expect(texts, award).not.toContain('GATES:')
    }
  })

  it('no two runs of text meet, with and without the race map', () => {
    for (const inset of [0, dashSideInsetPx(0.11, W)]) {
      for (const [name, s] of Object.entries(FRAMES)) {
        expect(collisions(drawDashBoxes(dashContent(s), inset)), `${name}, inset ${inset}`).toEqual(
          [],
        )
      }
    }
  })
})

describe('the chase camera’s plate: the same rule', () => {
  /** The lens panel's real `draw()`, through `createHud`, on a recording canvas. */
  const drawLens = (s: HudState): Box[] => {
    const { context, boxes } = recorder()
    const element = { width: 0, height: 0, getContext: () => context }
    vi.stubGlobal('document', { createElement: () => element })
    const hud = createHud()
    expect(hud.mount).toBe('lens')
    hud.update(s, 0)
    // The prediction the upload ledger reads, held against this very draw.
    expect(hud.report().canvasOps).toEqual(hudCanvasOps(s))
    return boxes
  }

  it('keeps the count’s number up under an event, and moves the badges off it', () => {
    const texts = drawLens(FRAMES.busy as HudState).map((b) => b.text)
    expect(texts).toContain('13/21')
    expect(texts).toContain('CLEAN X3  LOW +10')
  })

  it('no two runs of text meet', () => {
    for (const [name, s] of Object.entries(FRAMES)) {
      expect(collisions(drawLens(s)), name).toEqual([])
    }
  })
})

describe('after the finish: the medal, and no badges', () => {
  const done = state({
    finished: true,
    medal: 'gold',
    autopilot: true,
    multiplier: 3,
    chain: { stacks: 4, fraction: 0 },
  })

  it('carries no badges on either mount once the run is over', () => {
    expect(hudBadges(done)).toEqual([])
    expect(dashContent(done).badges).toEqual([])
    // The same state one tick earlier carried all three.
    expect(hudBadges({ ...done, finished: false })).toEqual(['AUTO', 'x3', '+4'])
  })

  it('nor does the JumpSeat’s dome', () => {
    expect(fuelBadges(done)).toBe('')
    expect(fuelBadges({ ...done, finished: false })).toBe('AUTO  x3')
  })
})
