// tests/unit/hud-fuel.test.ts — DEV-360: the JumpSeat's panel is 2016's fuel gauge.
//
// Four things are held here, and each one against something the port did not
// produce itself (CLAUDE.md, DEV-069's lesson):
//
//  1. WHICH panel the JumpSeat gets — one exported name, pinned by value.
//  2. The inventory in METRES, against the table in `DEVIATIONS.md` DEV-360,
//     which was worked from the prefab by hand, and the fill DIRECTION against
//     the 2016 capture (f0510: `FUEL : 75%`, the arc ends past the top on the
//     pilot's right). Geometry, not a rotation: an endpoint either is on the
//     right or it is not.
//  3. The DRAWING, through a recording canvas: what is shown, where, in which
//     ink — and what is NOT shown (no plates, no PADS, no TIME, no SPEED).
//  4. The inventory against the prefab BYTES, where `$FF2_LEGACY` exists. CI
//     has no Unity project, so that block skips there and says so loudly.

import fs from 'node:fs'
import type * as THREE from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jumpSeatHudOptions } from '@/game/jumpseat-flight'
import { JUMPSEAT } from '@/generated/constants.generated'
import { createHud, type HudState } from '@/render/hud'
import {
  FUEL_ARC_STEPS,
  FUEL_DOME,
  FUEL_EMPTY_TEXT,
  FUEL_GAUGE_2016,
  fuelBand,
  fuelCanvasOps,
  fuelRingCss,
  fuelSignature,
  fuelValueText,
  HUD_LAYOUT_JUMPSEAT,
} from '@/render/hud-fuel'
import { legacyAvailable, legacyPath } from '../../tools/legacy-root.mjs'
import { SPIDER_READY } from './helpers/spider-ready'

// ── A canvas that remembers what it was asked ─────────────────────────────

interface Call {
  readonly op: string
  readonly args: readonly unknown[]
  readonly fillStyle: string
  readonly strokeStyle: string
  readonly lineWidth: number
  readonly font: string
}

const installCanvas = () => {
  const calls: Call[] = []
  const size = { width: 0, height: 0 }
  const ctx: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    font: '',
    textAlign: '',
    textBaseline: '',
  }
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({
        op,
        args,
        fillStyle: String(ctx.fillStyle),
        strokeStyle: String(ctx.strokeStyle),
        lineWidth: Number(ctx.lineWidth),
        font: String(ctx.font),
      })
      return op === 'measureText' ? { width: String(args[0]).length * 8 } : undefined
    }
  for (const op of [
    'clearRect',
    'fillRect',
    'beginPath',
    'roundRect',
    'arc',
    'closePath',
    'fill',
    'stroke',
    'fillText',
    'measureText',
  ]) {
    ctx[op] = record(op)
  }
  const element = {
    get width() {
      return size.width
    },
    set width(v: number) {
      size.width = v
    },
    get height() {
      return size.height
    },
    set height(v: number) {
      size.height = v
    },
    getContext: () => ctx,
  }
  vi.stubGlobal('document', { createElement: () => element })
  return { calls, size }
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

const state = (over: Partial<HudState> = {}): HudState => ({
  ringsPassed: 3,
  ringsTotal: 11,
  score: 300,
  elapsed: 42.3,
  timeLimit: 180,
  speed: 37,
  medal: '',
  finished: false,
  countLabel: 'PADS',
  timeLabel: 'TIME',
  speedLabel: 'SPEED',
  fuelLabel: 'FUEL',
  energy: { fraction: 0.75, available: true },
  banner: null,
  autopilot: false,
  ...over,
})

/** Paint one state on a fresh JumpSeat panel and return what the canvas was asked. */
const paint = (s: HudState) => {
  const rec = installCanvas()
  const hud = createHud(jumpSeatHudOptions({}))
  rec.calls.length = 0
  hud.update(s, 0)
  return { ...rec, hud }
}

const PPM = 1400 // `PIXELS_PER_METRE`, restated: a test that imported it would move with it.

/** `arc(x, y, radius, start, end)`. */
type ArcArgs = [number, number, number, number, number]

// ── 1. Which panel ────────────────────────────────────────────────────────

describe('DEV-360: which panel a JumpSeat gets', () => {
  it('is the fuel dome, by one exported name, and the JumpSeat asks for it', () => {
    // Edit this on purpose or not at all: DEV-201 §4 recorded Matt keeping
    // PADS / TIME / SPEED on 2026-09-17, and DEV-360 is his later call.
    expect(HUD_LAYOUT_JUMPSEAT).toBe('fuel')
    expect(jumpSeatHudOptions({}).layout).toBe(HUD_LAYOUT_JUMPSEAT)
    // A pinned arm the caller passed survives the layout being set.
    expect(jumpSeatHudOptions({ raster: { kind: 'gpu' } }).raster).toEqual({ kind: 'gpu' })
  })

  it('leaves the HoverJet panel exactly as it was — rows, 560 × 203', () => {
    const rec = installCanvas()
    const hud = createHud()
    expect(hud.report().layout).toBe('rows')
    expect([rec.size.width, rec.size.height]).toEqual([560, 203])
    const geo = (hud.object as THREE.Mesh).geometry as THREE.PlaneGeometry
    expect(geo.parameters.width).toBeCloseTo(0.4, 9)
    expect(geo.parameters.height).toBeCloseTo(0.145, 9)
  })
})

// ── 2. The inventory, in metres ───────────────────────────────────────────

describe('DEV-360: the dome is 2016’s size, in 2016’s place on the panel', () => {
  // The DEV-360 table, worked from the prefab by hand: radius 107 of the
  // sprite's 128 half-texels, times `fuelGauge`'s local Y scale 0.318, times
  // `panel_jumpSeatUI`'s X scale 0.0053; the labels' anchors times the same
  // X scale; the text line lifted by the 4.8 panel units it sits nearer the eye.
  it('matches the table', () => {
    expect(FUEL_DOME.radiusM).toBeCloseTo(0.1805, 4)
    expect(FUEL_DOME.ringM).toBeCloseTo(0.0135, 4)
    expect(FUEL_DOME.labelXM).toBeCloseTo(-0.0594, 4)
    expect(FUEL_DOME.valueXM).toBeCloseTo(0.0833, 4)
    expect(FUEL_DOME.textYM).toBeGreaterThan(0.033)
    expect(FUEL_DOME.textYM).toBeLessThan(0.037)
    expect(FUEL_DOME.emM).toBeCloseTo(0.0452, 4)
    expect(FUEL_DOME.widthM).toBeCloseTo(FUEL_DOME.radiusM * 2, 9)
    expect(FUEL_DOME.heightM).toBeCloseTo(FUEL_DOME.radiusM, 9)
  })

  it('is asymmetric the way 2016 is: label LEFT of centre, value further RIGHT', () => {
    // A mirrored port would put `75%` on the left. The two anchors are not
    // symmetric about the centre (-11.2 against +15.7), so this separates.
    expect(FUEL_DOME.labelXM).toBeLessThan(0)
    expect(FUEL_DOME.valueXM).toBeGreaterThan(0)
    expect(Math.abs(FUEL_DOME.valueXM)).toBeGreaterThan(Math.abs(FUEL_DOME.labelXM))
  })

  it('keeps the text line inside the dome, low, where the capture has it', () => {
    const top = FUEL_DOME.textYM + FUEL_DOME.emM / 2
    expect(top).toBeLessThan(FUEL_DOME.radiusM * 0.35)
  })
})

// ── 3. The drawing ─────────────────────────────────────────────────────────

describe('DEV-360: what the JumpSeat panel draws', () => {
  it('is a canvas the size of the dome, at the panel’s density', () => {
    const { size, hud } = paint(state())
    expect(size.width).toBe(Math.round(FUEL_DOME.widthM * PPM))
    expect(size.height).toBe(Math.round(FUEL_DOME.heightM * PPM))
    expect(hud.report().layout).toBe('fuel')
    const geo = (hud.object as THREE.Mesh).geometry as THREE.PlaneGeometry
    expect(geo.parameters.width).toBeCloseTo(FUEL_DOME.widthM, 9)
    expect(geo.parameters.height).toBeCloseTo(FUEL_DOME.heightM, 9)
  })

  it('draws a half-disc on the flat bottom edge, then a ring that fills from the LEFT over the top', () => {
    const { calls, size } = paint(state())
    const arcs = calls.filter((c) => c.op === 'arc')
    expect(arcs).toHaveLength(2)
    const [disc, ring] = arcs as [Call, Call]
    const [dx, dy, dr, d0, d1] = disc.args as ArcArgs
    expect(dx).toBeCloseTo(size.width / 2, 6)
    expect(dy).toBe(size.height)
    expect(dr).toBeCloseTo(FUEL_DOME.radiusM * (size.width / FUEL_DOME.widthM), 6)
    expect([d0, d1]).toEqual([Math.PI, Math.PI * 2])

    // f0510, `FUEL : 75%`: the arc starts at the dome's left end and stops
    // past the top, on the right. Asserted on the ENDPOINTS in canvas space
    // (y down), not on an angle, so a flipped direction cannot pass.
    const [rx, ry, rr, r0, r1] = ring.args as ArcArgs
    const at = (a: number) => [rx + rr * Math.cos(a), ry + rr * Math.sin(a)] as const
    const [sx, sy] = at(r0)
    const [ex, ey] = at(r1)
    expect(sx).toBeLessThan(rx - rr * 0.99) // starts at the far left
    expect(Math.abs(sy - ry)).toBeLessThan(1e-6) // on the flat edge
    expect(ex).toBeGreaterThan(rx + rr * 0.6) // ends on the right...
    expect(ey).toBeLessThan(ry - rr * 0.6) // ...and above the flat edge
    expect(r1 - r0).toBeCloseTo(Math.PI * 0.75, 9)
    expect(ring.lineWidth).toBeCloseTo(FUEL_DOME.ringM * (size.width / FUEL_DOME.widthM), 6)
  })

  it('writes `FUEL :` and the percentage on their own anchors, on one line', () => {
    const { calls, size } = paint(state())
    const texts = calls.filter((c) => c.op === 'fillText')
    expect(texts.map((c) => c.args[0])).toEqual(['FUEL :', '75%'])
    const k = size.width / FUEL_DOME.widthM
    const [label, value] = texts as [Call, Call]
    expect(label.args[1]).toBeCloseTo(size.width / 2 + FUEL_DOME.labelXM * k, 6)
    expect(value.args[1]).toBeCloseTo(size.width / 2 + FUEL_DOME.valueXM * k, 6)
    expect(label.args[2]).toBeCloseTo(size.height - FUEL_DOME.textYM * k, 6)
    expect(value.args[2]).toBe(label.args[2])
    expect(label.font).toContain(`${Math.round(FUEL_DOME.emM * k)}px`)
  })

  it('shows 2016’s ONE instrument and none of the port’s old rows', () => {
    const { calls } = paint(state({ speed: 123, elapsed: 77.7, ringsPassed: 4 }))
    expect(calls.some((c) => c.op === 'roundRect')).toBe(false) // no plates
    const words = calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]))
    for (const gone of ['PADS', 'TIME', 'SPEED', '123', '77', '04/11']) {
      expect(
        words.some((w) => w.includes(gone)),
        gone,
      ).toBe(false)
    }
  })

  it('colours the ring by 2016’s thresholds and inks, by key', () => {
    const inkAt = (fraction: number) =>
      paint(state({ energy: { fraction, available: true } })).calls.find((c) => c.op === 'stroke')
        ?.strokeStyle
    expect(inkAt(0.75)).toBe(fuelRingCss('full'))
    expect(inkAt(0.5)).toBe(fuelRingCss('med'))
    expect(inkAt(0.3)).toBe(fuelRingCss('warning'))
    // The sheet's own colours, at the sprite's 183/255.
    expect(fuelRingCss('full')).toBe('rgba(108, 255, 88, 0.7176)')
    expect(fuelRingCss('warning')).toBe('rgba(255, 0, 0, 0.7176)')
    // FuelManager compares the UNROUNDED fraction with `>`.
    expect(fuelBand(JUMPSEAT.fuel.medPercent)).toBe('med')
    expect(fuelBand(JUMPSEAT.fuel.medPercent + 1e-6)).toBe('full')
    expect(fuelBand(JUMPSEAT.fuel.warningPercent)).toBe('warning')
  })

  it('reads EMPTY! and draws no ring at or below zero — the tank goes negative on purpose', () => {
    for (const fraction of [0, -0.4]) {
      const { calls } = paint(state({ energy: { fraction, available: false } }))
      expect(
        calls.filter((c) => c.op === 'arc'),
        String(fraction),
      ).toHaveLength(1) // the disc only
      expect(calls.filter((c) => c.op === 'fillText').map((c) => c.args[0])).toEqual([
        'FUEL :',
        FUEL_EMPTY_TEXT,
      ])
    }
  })

  it('truncates the percentage, as `(int)` does', () => {
    expect(fuelValueText(0.599)).toBe('59%')
    expect(fuelValueText(1)).toBe('100%')
    expect(fuelValueText(1.004)).toBe('100%')
    expect(fuelValueText(0.001)).toBe('0%')
    expect(fuelValueText(0)).toBe(FUEL_EMPTY_TEXT)
  })

  it('keeps the launch banner and the pad-hit line INSIDE the dome', () => {
    const banner = paint(state({ banner: '3' })).calls
    expect(banner.filter((c) => c.op === 'fillText').map((c) => c.args[0])).toEqual(['3'])
    expect(banner.filter((c) => c.op === 'arc')).toHaveLength(1)
    const hit = paint(state({ award: '+100', multiplier: 3, autopilot: true })).calls
    const words = hit.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]))
    expect(words).toEqual(['FUEL :', '75%', '+100', 'AUTO  x3'])
  })

  it('predicts its own canvas calls exactly', () => {
    for (const s of [
      state(),
      state({ energy: { fraction: 0, available: false } }),
      state({ energy: undefined }),
      state({ banner: 'Press A to launch' }),
      state({ award: '+100', awardTone: 'loss', multiplier: 2 }),
      state({ finished: true, medal: 'none' }),
    ]) {
      const { calls } = paint(s)
      const predicted = fuelCanvasOps(s)
      expect(calls.length, JSON.stringify(s.energy) + s.banner).toBe(predicted.total)
      expect(calls.filter((c) => c.op === 'fillText').length).toBe(predicted.texts)
    }
  })
})

describe('DEV-360: the dome repaints only for what it draws', () => {
  it('holds still for speed, the clock, the count and the HoverJet meters', () => {
    const base = fuelSignature(state())
    for (const over of [
      { speed: 180 },
      { elapsed: 99.9 },
      { ringsPassed: 9 },
      { chain: { stacks: 3, fraction: 0.2 } },
      { timeCountsDown: true },
    ] as Partial<HudState>[]) {
      expect(fuelSignature(state(over)), JSON.stringify(over)).toBe(base)
    }
  })

  it('moves for the tank, the band, the banner and the event line', () => {
    const base = fuelSignature(state())
    for (const over of [
      { energy: { fraction: 0.75 + 1 / FUEL_ARC_STEPS, available: true } },
      { energy: { fraction: 0.0, available: false } },
      { banner: '2' },
      { award: '+50' },
      { multiplier: 2 },
      { autopilot: true },
    ] as Partial<HudState>[]) {
      expect(fuelSignature(state(over)), JSON.stringify(over)).not.toBe(base)
    }
  })

  it('does not repaint a hovering seat whose speed is changing', () => {
    const rec = installCanvas()
    const hud = createHud(jumpSeatHudOptions({}))
    // `live`, so the ONLY thing that can withhold a paint is the signature.
    hud.setRedraw({ kind: 'live' })
    hud.update(state({ speed: 10 }), 0)
    hud.update(state({ speed: 11 }), 500)
    hud.update(state({ speed: 12 }), 1000)
    expect(hud.paints).toBe(1)
    expect(rec.calls.filter((c) => c.op === 'clearRect')).toHaveLength(1)
  })
})

// ── DEV-383: the jumping spider's charge, on the same dome ────────────────

// NOT READY TO SHIP (Matt, 2026-09-25, DEV-403): the spider is `listed: false`,
// and its tests skip on `SPIDER_READY` until it is ready (`variant-listed.test.ts`).
describe.skipIf(!SPIDER_READY)('DEV-383: the spider’s charge ring', () => {
  it('draws nothing and moves nothing on a seat that is not charging', () => {
    const base = paint(state()).calls
    for (const jumpCharge of [undefined, 0]) {
      const { calls } = paint(state({ jumpCharge }))
      expect(calls, String(jumpCharge)).toEqual(base)
      expect(fuelSignature(state({ jumpCharge }))).toBe(fuelSignature(state()))
    }
  })

  it('fills a third arc from the LEFT, inside the tank’s ring, in the accent and not a fuel band', () => {
    const { calls } = paint(state({ jumpCharge: 0.5, autopilot: true }))
    const arcs = calls.filter((c) => c.op === 'arc')
    const strokes = calls.filter((c) => c.op === 'stroke')
    expect(arcs).toHaveLength(3)
    expect(strokes).toHaveLength(2)
    const [tank, charge] = [arcs[1], arcs[2]] as [Call, Call]
    const [cx, cy, r, a0, a1] = charge.args as ArcArgs
    // Starts on the flat edge at the far left, and half a charge is a quarter
    // turn: straight up. Endpoints in canvas space, as the tank's test does.
    expect(cx + r * Math.cos(a0)).toBeLessThan(cx - r * 0.99)
    expect(Math.abs(cy + r * Math.sin(a0) - cy)).toBeLessThan(1e-6)
    expect(Math.abs(cx + r * Math.cos(a1) - cx)).toBeLessThan(1e-6)
    expect(cy + r * Math.sin(a1)).toBeLessThan(cy - r * 0.99)
    // Inside the tank's ring, never over it.
    const tankInner = (tank.args[2] as number) - tank.lineWidth / 2
    expect(r + charge.lineWidth / 2).toBeLessThanOrEqual(tankInner + 1e-9)
    // The accent — the ink the badges are written in — and no band's colour.
    const ink = (strokes[1] as Call).strokeStyle
    const badges = calls.find((c) => c.op === 'fillText' && c.args[0] === 'AUTO') as Call
    expect(ink).toBe(badges.fillStyle)
    for (const band of ['full', 'med', 'warning'] as const) expect(ink).not.toBe(fuelRingCss(band))
  })

  it('clears the AUTO line at the top of the dome, measured off the drawing', () => {
    // The spider's autopilot shows AUTO while it charges, so the one place the
    // ring could collide with text is the top of the dome. Canvas y runs DOWN.
    const { calls } = paint(state({ jumpCharge: 1, autopilot: true }))
    const charge = calls.filter((c) => c.op === 'arc')[2] as Call
    const [, cy, r] = charge.args as ArcArgs
    const ringInnerTop = cy - (r - charge.lineWidth / 2)
    const auto = calls.find((c) => c.op === 'fillText' && c.args[0] === 'AUTO') as Call
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(auto.font)?.[1])
    expect(px).toBeGreaterThan(0)
    const emBoxTop = (auto.args[2] as number) - px / 2
    expect(ringInnerTop).toBeLessThan(emBoxTop)
  })

  it('repaints as the charge builds, on the tank’s steps, and predicts its own calls', () => {
    const at = (jumpCharge: number) => fuelSignature(state({ jumpCharge }))
    expect(at(0.5)).not.toBe(at(0))
    expect(at(0.5 + 1 / FUEL_ARC_STEPS)).not.toBe(at(0.5))
    expect(at(0.5 + 0.2 / FUEL_ARC_STEPS)).toBe(at(0.5))
    for (const s of [
      state({ jumpCharge: 0.3 }),
      state({ jumpCharge: 1, autopilot: true, award: '+100' }),
      state({ jumpCharge: 0.6, energy: { fraction: 0, available: false } }),
    ]) {
      const { calls } = paint(s)
      expect(calls.length, String(s.jumpCharge)).toBe(fuelCanvasOps(s).total)
    }
  })
})

// ── 4. The inventory against the prefab bytes ─────────────────────────────

const haveLegacy = legacyAvailable()

/** One YAML document by its anchor, as text. */
const docOf = (text: string, id: string): string => {
  const m = new RegExp(`^--- !u!\\d+ &${id}\\s*$`, 'm').exec(text)
  if (!m) throw new Error(`no document &${id}`)
  const next = text.indexOf('\n--- ', m.index + 1)
  return text.slice(m.index, next < 0 ? undefined : next)
}
const field = (doc: string, key: string): string => {
  const m = new RegExp(`\\n\\s*${key}: (.*)`).exec(doc)
  if (!m?.[1]) throw new Error(`no ${key}`)
  return m[1].trim()
}
const vec = (doc: string, key: string): number[] => {
  const body = /\{(.*)\}/.exec(field(doc, key))?.[1] ?? ''
  return body.split(',').map((kv) => Number(kv.split(':')[1]))
}
/** The Transform/RectTransform that belongs to a GameObject — either YAML dialect. */
const transformOf = (text: string, go: string): string => {
  const ids = [...docOf(text, go).matchAll(/- (?:component|\d+): \{fileID: (\d+)\}/g)].map(
    (m) => m[1],
  )
  for (const id of ids) {
    const d = docOf(text, id as string)
    if (/\n(Rect)?Transform:/.test(d)) return d
  }
  throw new Error(`no transform on &${go}`)
}

describe.skipIf(!haveLegacy)(
  'DEV-360: the inventory against JumpSeat_Photon.prefab’s bytes',
  () => {
    it('every number in FUEL_GAUGE_2016 is the prefab’s', () => {
      const text = fs.readFileSync(legacyPath(FUEL_GAUGE_2016.prefab), 'utf8')
      const g = FUEL_GAUGE_2016

      const panel = transformOf(text, g.panel.gameObject)
      expect(vec(panel, 'm_LocalScale').slice(0, 3)).toEqual([...g.panel.scale])
      expect(field(docOf(text, g.panel.image), 'm_Enabled')).toBe('0')

      for (const part of [g.disc, g.ring] as const) {
        const rt = transformOf(text, part.gameObject)
        expect(vec(rt, 'm_AnchoredPosition')).toEqual([...part.anchored])
        expect(vec(rt, 'm_LocalPosition')[2]).toBe(part.z)
        expect(vec(rt, 'm_LocalScale')).toEqual([...part.scale])
        const img = docOf(text, part.image)
        expect(field(img, 'm_FillMethod')).toBe('4') // Radial360
        expect(field(img, 'm_FillOrigin')).toBe('0') // Bottom, which qz(-90°) makes the LEFT
        expect(field(img, 'm_FillClockwise')).toBe('1')
      }
      expect(vec(docOf(text, g.disc.image), 'm_Color')).toEqual([...g.disc.color])
      expect(field(docOf(text, g.disc.image), 'm_FillAmount')).toBe(String(g.disc.fillAmount))

      for (const part of [g.label, g.value] as const) {
        const rt = transformOf(text, part.gameObject)
        expect(vec(rt, 'm_AnchoredPosition')).toEqual([...part.anchored])
        expect(vec(rt, 'm_LocalPosition')[2]).toBe(part.z)
        expect(vec(rt, 'm_LocalScale')).toEqual([...part.scale])
        // The child tilt: qx(-30.07°) on both labels.
        const q = vec(rt, 'm_LocalRotation')
        expect((2 * Math.asin(-(q[0] as number)) * 180) / Math.PI).toBeCloseTo(
          g.childTiltDegrees,
          2,
        )
        const t = docOf(text, part.text)
        expect(field(t, 'm_MaxSize')).toBe(String(part.maxSize))
        expect(field(t, 'm_Alignment')).toBe('4') // MiddleCenter
      }
      // Single-quoted in the YAML, because a plain scalar may not hold `: `.
      expect(field(docOf(text, g.label.text), 'm_Text')).toBe("'Fuel :'")
    })

    it('the dome is live at spawn and the rows are not', () => {
      const text = fs.readFileSync(legacyPath(FUEL_GAUGE_2016.prefab), 'utf8')
      // The liveness walk: every GameObject from the gauge to the root is active.
      let rt = transformOf(text, FUEL_GAUGE_2016.ring.gameObject)
      let steps = 0
      for (;;) {
        const go = /m_GameObject: \{fileID: (\d+)\}/.exec(rt)?.[1] as string
        expect(field(docOf(text, go), 'm_IsActive'), go).toBe('1')
        const father = /m_Father: \{fileID: (\d+)\}/.exec(rt)?.[1]
        if (!father || father === '0') break
        rt = docOf(text, father)
        steps += 1
      }
      expect(
        steps,
        'fuelGauge → panel → Ship_HUD → art_firstPerson → art_pivot → offset → root',
      ).toBe(6)
      // `panel_shipUI` (gates, time, speed) is authored OFF beside it (DEV-201 §1).
      expect(field(docOf(text, '1000013827625082'), 'm_Name')).toBe('panel_shipUI')
      expect(field(docOf(text, '1000013827625082'), 'm_IsActive')).toBe('0')
    })
  },
)

describe.skipIf(haveLegacy)('DEV-360: the prefab-bytes check is skipped here', () => {
  it('says so, rather than reporting a pass', () => {
    // The loud counterpart. `$FF2_LEGACY` is a local Unity project CI does not
    // have; the metric and drawing blocks above still run everywhere.
    expect(haveLegacy).toBe(false)
    console.log('DEV-360: hud-fuel prefab-bytes check skipped — no $FF2_LEGACY on this host.')
  })
})
