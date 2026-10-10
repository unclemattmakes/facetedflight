// DEV-866: the broadcast's mini-map and the followed racer's numbers.

import { describe, expect, it } from 'vitest'
import type { TvMapView } from '@/game/tv/tv-camera'
import {
  MAP_CANVAS,
  paintMapPlate,
  type TvMapCtx,
  tvMapKey,
  tvMapReadout,
  tvSpeedParts,
} from '@/render/tv-map-plate'
import {
  LOWER_THIRD_CANVAS,
  type TvPanelFeed,
  type TvPanelRow,
  tvFlatPlacement,
} from '@/render/tv-panel-layout'

const row = (n: number, over: Partial<TvPanelRow> = {}): TvPanelRow => ({
  key: `racer:fast-${n}`,
  kind: 'racer',
  racer: null,
  follow: n,
  name: 'fast',
  colour: '#ff8800',
  place: n,
  status: 'flying',
  seconds: null,
  rings: 8,
  ...over,
})

const feed = (over: Partial<TvPanelFeed> = {}): TvPanelFeed => ({
  show: 'exhibition',
  phase: 'racing',
  course: 'Test',
  racers: null,
  rows: [row(1, { gap: 0 }), row(2, { gap: 1.4 }), row(3, { gap: 3 })],
  gates: 21,
  followed: 'racer:fast-2',
  linkFollows: null,
  lobbies: null,
  raceSeconds: 67,
  split: { gate: 8, seconds: 1.4 },
  ...over,
})

const view: TvMapView = {
  outline: [
    { x: 0, z: 0 },
    { x: 500, z: 0 },
    { x: 500, z: -400 },
    { x: 0, z: -400 },
  ],
  finish: { x: 0, z: -400 },
  dots: [
    { id: 'a', name: 'fast', x: 100, z: 0, colour: '#ff8800', followed: false, finished: false },
    {
      id: 'b',
      name: 'fast-2',
      x: 500,
      z: -100,
      colour: '#00ccff',
      followed: true,
      finished: false,
    },
    { id: 'c', name: 'fast-3', x: 9000, z: 9000, colour: null, followed: false, finished: false },
  ],
  following: 'fast-2',
  speed: 114.4,
}

interface Fake extends TvMapCtx {
  texts: string[]
  arcs: number[][]
  strokes: number
}

const fake = (): Fake => {
  const f = {
    texts: [] as string[],
    arcs: [] as number[][],
    strokes: 0,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    lineJoin: 'miter' as CanvasLineJoin,
    lineCap: 'butt' as CanvasLineCap,
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    fillText(t: string) {
      f.texts.push(t)
    },
    measureText: (t: string) => ({ width: t.length * 10 }),
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arc(x: number, y: number, r: number) {
      f.arcs.push([x, y, r])
    },
    stroke() {
      f.strokes++
    },
    fill() {},
  }
  return f
}

describe('the followed racer readout', () => {
  it('speed follows the HUD unit', () => {
    expect(tvSpeedParts(100, 'kmh')).toEqual({ value: '360', unit: 'km/h' })
    expect(tvSpeedParts(100, 'ms')).toEqual({ value: '100', unit: 'm/s' })
  })

  it('names place, gate, gap to the leader, split and the clock', () => {
    const r = tvMapReadout(feed(), view, 'kmh')
    expect(r.speed?.value).toBe('412')
    expect(r.place).toBe('#2/3')
    expect(r.gate).toBe('GATE 8/21')
    expect(r.gap).toBe('+1.4 to leader')
    expect(r.gapKind).toBe('loss')
    expect(r.split).toContain('+1.4')
    expect(r.clock).toBe('1:07')
  })

  it('the leader reads LEADER, a finisher reads its time and no speed', () => {
    expect(tvMapReadout(feed({ followed: 'racer:fast-1' }), view, 'kmh').gap).toBe('LEADER')
    const home = feed({
      rows: [row(1), row(2, { status: 'finished', seconds: 74.3 })],
    })
    const r = tvMapReadout(home, view, 'kmh')
    expect(r.gap).toBe('74.3s')
    expect(r.speed).toBeNull()
  })

  it('a free camera follows nobody: no figures, still a map', () => {
    const r = tvMapReadout(
      feed({ followed: null }),
      { ...view, following: null, speed: null },
      'kmh',
    )
    expect(r.name).toBe('FREE CAMERA')
    expect(r.speed).toBeNull()
    expect(r.gap).toBeNull()
  })
})

describe('the plate', () => {
  it('draws every racer once, ringing the followed one, all inside the canvas', () => {
    const ctx = fake()
    paintMapPlate(ctx, feed(), view, 'kmh')
    // The followed racer: a backing disc, a ring and a hull-coloured core; the others one disc each.
    expect(ctx.arcs.length).toBe(2 + 3)
    for (const [x, y] of ctx.arcs) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(MAP_CANVAS.width)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(MAP_CANVAS.height)
    }
    expect(ctx.texts).toEqual(expect.arrayContaining(['412', 'km/h', '#2/3   GATE 8/21']))
  })

  it('repaints when a dot moves a pixel or the speed changes, not otherwise', () => {
    const k = tvMapKey(feed(), view, 'kmh')
    expect(tvMapKey(feed(), { ...view }, 'kmh')).toBe(k)
    const moved = { ...view, dots: view.dots.map((d) => (d.followed ? { ...d, z: d.z + 40 } : d)) }
    expect(tvMapKey(feed(), moved, 'kmh')).not.toBe(k)
    expect(tvMapKey(feed(), { ...view, speed: 120 }, 'kmh')).not.toBe(k)
  })
})

describe('where the plate stands', () => {
  const overlap = (
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ): boolean => Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2

  for (const aspect of [16 / 9, 21 / 9, 9 / 16]) {
    it(`clears the board and the bug at aspect ${aspect.toFixed(2)}`, () => {
      const view = { fovDeg: 60, aspect }
      const rect = (kind: 'map' | 'lowerThird' | 'bug', ca: number) => {
        const p = tvFlatPlacement(kind, view, ca)
        return { x: p.position[0], y: p.position[1], w: p.width, h: p.height }
      }
      const map = rect('map', MAP_CANVAS.width / MAP_CANVAS.height)
      const board = rect('lowerThird', LOWER_THIRD_CANVAS.width / LOWER_THIRD_CANVAS.height)
      const bug = rect('bug', 2)
      // The board's canvas is bottom-aligned and partly empty, so a full-canvas overlap is the worst case.
      expect(overlap(map, board)).toBe(false)
      expect(overlap(map, bug)).toBe(false)
    })
  }
})
