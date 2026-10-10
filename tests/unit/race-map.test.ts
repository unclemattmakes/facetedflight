// tests/unit/race-map.test.ts — the race map beside the readout. DEV-361.
//
// `render/race-map.ts` is one merged geometry on the panel: a plate, the
// course from above, a hexagon per ship and a segment-glyph `#2/6`. Every
// test here reads GEOMETRY back — where a vertex landed, what colour it is,
// what range an update asked to send — rather than a transform or a flag,
// because the orientation lesson is that a rotation asserted is a belief
// written twice, and AGENT-NOTES §4 is that a flag has been green in a unit
// test while it was dead in the frame.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { editionFeatures } from '@/content/edition-schema'
import type { RaceLine } from '@/game/race-place'
import { isUiObject } from '@/render/bloom'
import { HEIGHT, WIDTH } from '@/render/hud'
import { parseColour } from '@/render/hud-gauges'
import {
  courseOutline,
  createRaceMap,
  fitMap,
  GLYPH_BARS,
  glyphQuads,
  mapPoint,
  placeText,
  playerMark,
  RACE_MAP_INKS,
  type RaceMapFeed,
  raceMapLayout,
  simplifyPolyline,
} from '@/render/race-map'
import { LIVERY_PANEL_SRGB, srgbHex } from '@/render/racer-livery'
import { lookAlong, mul, quat } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'
import { createRoute } from '@/sim/route'
import { editionJson as edition } from './helpers/content'

const SIZE = edition('anniversary').hud.raceMap

describe('the preset', () => {
  it('is on in Anniversary and off in Classic, which differs by that key alone', () => {
    const a = edition('anniversary').hud.raceMap
    const c = edition('classic').hud.raceMap
    expect(a.enabled).toBe(true)
    expect(c.enabled).toBe(false)
    const { enabled: _a, note: _an, ...aSizes } = a
    const { enabled: _c, note: _cn, ...cSizes } = c
    expect(cSizes).toEqual(aSizes)
  })

  it('is a registered feature, so Classic-all-off and `vr.disable` can see it', () => {
    const paths = editionFeatures(edition('anniversary')).map(([p]) => p)
    expect(paths).toContain('hud.raceMap')
  })
})

describe('the readout', () => {
  it('reads #2/6, and nothing where there is no place', () => {
    expect(placeText({ place: 2, field: 6 })).toBe('#2/6')
    expect(placeText({ place: 12, field: 13 })).toBe('#12/13')
    expect(placeText(null)).toBe('')
    expect(placeText({ place: null, field: 6 })).toBe('')
    expect(placeText({ place: null, field: 0 })).toBe('')
  })

  it("draws the place mark as a hash, not a digit's bars (Matt saw Y3/6)", () => {
    const bars = GLYPH_BARS['#'] ?? ''
    expect(bars).toBe('hijk')
    for (const seg of 'abcdefg') expect(bars.includes(seg), seg).toBe(false)
  })

  it('draws every digit as a subset of 8, and no two alike', () => {
    const key = (q: number[][]) =>
      q
        .map((k) => k.map((v) => v.toFixed(6)).join(','))
        .sort()
        .join('|')
    const eight = new Set(glyphQuads('8', 0, 0, 1).map((k) => key([k])))
    const seen = new Set<string>()
    for (const ch of Object.keys(GLYPH_BARS)) {
      const quads = glyphQuads(ch, 0, 0, 1)
      expect(quads.length, `${ch} draws something`).toBeGreaterThan(0)
      if (ch !== 'P' && ch !== '#')
        for (const k of quads) expect(eight.has(key([k])), `${ch} ⊂ 8`).toBe(true)
      const whole = key(quads)
      expect(seen.has(whole), `${ch} is unlike every other glyph`).toBe(false)
      seen.add(whole)
    }
  })

  it('keeps every bar inside its cell, and the slash leans FORWARD', () => {
    for (const ch of [...Object.keys(GLYPH_BARS), '/']) {
      for (const k of glyphQuads(ch, 10, 20, 2)) {
        for (let i = 0; i < 8; i += 2) {
          expect(k[i]).toBeGreaterThanOrEqual(10)
          expect(k[i]).toBeLessThanOrEqual(12)
          expect(k[i + 1]).toBeGreaterThanOrEqual(20)
          expect(k[i + 1]).toBeLessThanOrEqual(22)
        }
      }
    }
    // A slash, not a backslash: its top is to the RIGHT of its foot.
    const [slash] = glyphQuads('/', 0, 0, 1) as [number[]]
    const foot = ((slash[0] as number) + (slash[2] as number)) / 2
    const top = ((slash[4] as number) + (slash[6] as number)) / 2
    expect(top).toBeGreaterThan(foot)
  })
})

describe('the projection', () => {
  const area = { minX: -1, maxX: 1, minY: -1, maxY: 1 }

  it('keeps the course’s shape: a 2:1 course is a 2:1 map, centred', () => {
    const fit = fitMap(
      [
        { x: 100, z: 100 },
        { x: 2100, z: 1100 },
      ],
      area,
    )
    const a = mapPoint(fit, 100, 100)
    const b = mapPoint(fit, 2100, 1100)
    expect((b.x - a.x) / (b.y - a.y)).toBeCloseTo(2, 9)
    expect(a.x).toBeCloseTo(-1, 9)
    expect(b.x).toBeCloseTo(1, 9)
    expect((a.y + b.y) / 2).toBeCloseTo(0, 9)
  })

  it('puts east to the RIGHT and north UP, so a right turn stays a right turn', () => {
    const fit = fitMap(
      [
        { x: -500, z: -500 },
        { x: 500, z: 500 },
      ],
      area,
    )
    const o = { ...mapPoint(fit, 0, 0) }
    expect(mapPoint(fit, 100, 0).x).toBeGreaterThan(o.x) // east
    expect(mapPoint(fit, 0, 100).y).toBeGreaterThan(o.y) // north
    // Fly north, then turn to the east. In Unity's frame, facing +z, +x is on
    // your right, so that is a RIGHT turn — clockwise seen from above, which on
    // a y-up plate is a negative cross product. A mirrored map would say left.
    const a = { ...mapPoint(fit, 0, 0) }
    const b = { ...mapPoint(fit, 0, 100) }
    const c = { ...mapPoint(fit, 100, 100) }
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    expect(cross).toBeLessThan(0)
  })
})

describe('the outline', () => {
  it('drops what lies inside the stroke and keeps the ends', () => {
    const line = Array.from({ length: 100 }, (_, i) => ({ x: i * 10, z: 0 }))
    const out = simplifyPolyline(line, 0.5)
    expect(out).toEqual([line[0], line[99]])
  })

  it('keeps a hairpin’s tip, which lies on the line through its two ends', () => {
    const hairpin = [
      { x: 0, z: 0 },
      { x: 500, z: 0 },
      { x: 1000, z: 0 },
      { x: 500, z: 1 },
      { x: 0, z: 1 },
    ]
    const out = simplifyPolyline(hairpin, 0.5)
    expect(out).toContainEqual({ x: 1000, z: 0 })
  })

  it('stops at the FINISH, not where the authored line runs out', () => {
    // 2 km of line, the last gate at 1200 m and the finish at x = 1500.
    const pts: number[][] = []
    for (let x = 0; x <= 2000; x += 50) pts.push([x, 0, 0])
    const line: RaceLine = { route: createRoute(pts), gateArc: [600, 1200] }
    const { points, finishArc } = courseOutline(line, { x: 1500, y: 0, z: 0 })
    expect(finishArc).toBeCloseTo(1500, 6)
    expect(points.at(-1)?.x).toBeCloseTo(1500, 6)
    expect(points.every((p) => p.x <= 1500 + 1e-6)).toBe(true)
    // With no finish it runs to the end of the line.
    expect(courseOutline(line, null).points.at(-1)?.x).toBeCloseTo(2000, 6)
  })
})

// ── The mesh ────────────────────────────────────────────────────────────

/** A 2 km × 1 km loop, THREE space in; sim space is the same with z mirrored. */
const loop = (): RaceLine => {
  const pts: number[][] = []
  for (let x = 0; x <= 2000; x += 100) pts.push([x, 0, 0])
  for (let z = 100; z <= 1000; z += 100) pts.push([2000, 0, z])
  for (let x = 1900; x >= 0; x -= 100) pts.push([x, 0, 1000])
  const route = createRoute(pts)
  return { route, gateArc: [1000, 2500, 4000] }
}
const COLOURS = ['#316fb4', '#8ccf3a', null]
const build = (hz = 10) =>
  createRaceMap({
    line: loop(),
    finish: { x: 0, y: 0, z: -1000 },
    racerColours: COLOURS,
    size: SIZE,
    redraw: { kind: 'budget', hz },
  })
/** Sim positions: the loop runs along z = 0 and z = −1000 in sim space. */
const feed = (over: Partial<RaceMapFeed> = {}): RaceMapFeed => ({
  player: { x: 500, z: 0 },
  racers: [
    { x: 700, z: 0 },
    { x: 2000, z: -300 },
    { x: 1500, z: -1000 },
  ],
  place: { place: 2, field: 4 },
  ...over,
})

type Attr = { array: Float32Array; updateRanges: { start: number; count: number }[] }
const attrs = (map: ReturnType<typeof build>) => ({
  position: map.object.geometry.getAttribute('position') as unknown as Attr,
  colour: map.object.geometry.getAttribute('color') as unknown as Attr,
})

/** Triangles whose colour is `css` and which are not collapsed. */
const trianglesInk = (map: ReturnType<typeof build>, css: string): number => {
  const want = parseColour(css)
  const c = attrs(map).colour.array
  let n = 0
  for (let t = 0; t < c.length / 12; t += 1) {
    const q = t * 12
    if ((c[q + 3] as number) === 0) continue
    const same =
      Math.abs((c[q] as number) - want.r) < 1e-6 &&
      Math.abs((c[q + 1] as number) - want.g) < 1e-6 &&
      Math.abs((c[q + 2] as number) - want.b) < 1e-6
    if (same) n += 1
  }
  return n
}

/** Corner `v` of triangle `t`, plate metres. */
const corner = (p: Float32Array, t: number, v: number): [number, number] => [
  p[t * 9 + v * 3] as number,
  p[t * 9 + v * 3 + 1] as number,
]

/** Is (x, y) inside triangle `t`, edges included? Sign of the three edge crosses. */
const inside = (p: Float32Array, t: number, x: number, y: number): boolean => {
  const [a, b, c] = [corner(p, t, 0), corner(p, t, 1), corner(p, t, 2)]
  const s = (u: [number, number], w: [number, number]) =>
    (u[0] - x) * (w[1] - y) - (w[0] - x) * (u[1] - y)
  const s1 = s(a, b)
  const s2 = s(b, c)
  const s3 = s(c, a)
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)
}

describe('createRaceMap', () => {
  it('is a UI surface: not tone-mapped, never depth-tested, one mesh', () => {
    const map = build()
    expect(map.object.name).toBe('race-map')
    // `bloom.ts`'s `classify()` moves exactly what this accepts onto UI_LAYER.
    expect(isUiObject(map.object)).toBe(true)
    const m = map.object.material as THREE.Material & { vertexColors: boolean }
    expect(m.depthTest).toBe(false)
    expect(m.vertexColors).toBe(true)
    expect(map.object.children).toHaveLength(0)
    // ONE draw, and the condition three splits a draw on is read here rather
    // than assumed: `WebGLRenderer` renders a transparent DoubleSide material
    // twice unless `forceSinglePass`. The first e2e run counted 2 without it.
    const twoPass = m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass
    expect(twoPass, 'three would draw this mesh twice').toBe(false)
    map.dispose()
  })

  it('sits on the panel’s RIGHT, its left edge one gap past the panel’s', () => {
    const map = build()
    const layout = raceMapLayout(SIZE, WIDTH, 1)
    expect(map.object.position.x - layout.width / 2).toBeCloseTo(WIDTH / 2 + SIZE.gapMetres, 9)
    expect(map.object.position.y).toBe(0)
    map.dispose()
  })

  it('writes only when a dot moves a texel or the text changes, at the panel’s cadence', () => {
    const map = build(10)
    map.update(feed(), 0)
    expect(map.report().writes).toBe(1)
    // The same feed: nothing to say.
    map.update(feed(), 10)
    expect(map.report().unchanged).toBe(1)
    // A tenth of a metre on a map of kilometres is well under a texel.
    map.update(feed({ player: { x: 500.1, z: 0 } }), 20)
    expect(map.report().unchanged).toBe(2)
    // A real move, inside 100 ms of the last write: the cadence withholds it.
    map.update(feed({ player: { x: 900, z: 0 } }), 50)
    expect(map.report()).toMatchObject({ writes: 1, skipped: 1 })
    // And lets it through once the interval is up.
    map.update(feed({ player: { x: 900, z: 0 } }), 150)
    expect(map.report().writes).toBe(2)
    map.dispose()
  })

  it('never re-sends the plate and the line: only the tail is in the update range', () => {
    const map = build(1000)
    const { position } = attrs(map)
    position.updateRanges.length = 0
    map.update(feed(), 0)
    const first = position.updateRanges[0] as { start: number; count: number }
    expect(first.start).toBeGreaterThan(0)
    expect(first.start + first.count).toBe(position.array.length)
    // A dot-only write sends LESS than a write that also changed the text.
    position.updateRanges.length = 0
    map.update(feed({ player: { x: 1200, z: 0 } }), 10)
    const dotsOnly = position.updateRanges[0] as { start: number; count: number }
    expect(dotsOnly.start).toBeGreaterThan(first.start)
    expect(dotsOnly.start + dotsOnly.count).toBe(position.array.length)
    map.dispose()
  })

  it('keeps every dot on the plate, even a ship that has left the course’s box', () => {
    const map = build()
    map.update(
      feed({
        racers: [
          { x: 90_000, z: 90_000 },
          { x: 0, z: 0 },
          { x: 0, z: 0 },
        ],
      }),
      0,
    )
    const { dots, layout } = map.report()
    for (const d of dots) {
      expect(d.x).toBeGreaterThanOrEqual(layout.area.minX)
      expect(d.x).toBeLessThanOrEqual(layout.area.maxX)
      expect(d.y).toBeGreaterThanOrEqual(layout.area.minY)
      expect(d.y).toBeLessThanOrEqual(layout.area.maxY)
    }
    map.dispose()
  })

  it('draws the player LAST and bigger than a racer, in the player’s own orange, ringed', () => {
    const map = build()
    map.update(feed(), 0)
    const p = attrs(map).position.array
    const tris = p.length / 9
    /** The longest distance between two corners of the triangles from `fromTri`. */
    const span = (fromTri: number, count: number): number => {
      const pts: [number, number][] = []
      for (let t = fromTri; t < fromTri + count; t += 1) {
        for (let v = 0; v < 3; v += 1) pts.push(corner(p, t, v))
      }
      let most = 0
      for (const a of pts)
        for (const b of pts) most = Math.max(most, Math.hypot(a[0] - b[0], a[1] - b[1]))
      return most
    }
    // DEV-432: the last triangle is the player's mark, the one before it its
    // ring; the first racer's hexagon is four before those again, times the field.
    const player = span(tris - 1, 1)
    const ring = span(tris - 2, 1)
    const racer = span(tris - 2 - 4 * COLOURS.length, 4)
    expect(player).toBeGreaterThan(racer)
    expect(ring).toBeGreaterThan(player)
    // The ring is AROUND the mark: every corner of the triangle is inside it.
    for (let v = 0; v < 3; v += 1) {
      const [x, y] = corner(p, tris - 1, v)
      expect(inside(p, tris - 2, x, y), `mark corner ${v} inside its ring`).toBe(true)
    }
    // The colour of the last triangle is the player's hull, the one before the ring's ink.
    const c = attrs(map).colour.array
    const last = parseColour(srgbHex(LIVERY_PANEL_SRGB))
    expect(c[c.length - 4]).toBeCloseTo(last.r, 6)
    expect(c[c.length - 3]).toBeCloseTo(last.g, 6)
    expect(c[c.length - 2]).toBeCloseTo(last.b, 6)
    const ringInk = parseColour(RACE_MAP_INKS.ring)
    expect(c[c.length - 16]).toBeCloseTo(ringInk.r, 6)
    expect(c[c.length - 15]).toBeCloseTo(ringInk.g, 6)
    expect(c[c.length - 14]).toBeCloseTo(ringInk.b, 6)
    map.dispose()
  })

  it('paints each racer the colour it wears, and invents no colour', () => {
    const map = build()
    map.update(feed(), 0)
    expect(trianglesInk(map, '#316fb4')).toBe(4)
    expect(trianglesInk(map, '#8ccf3a')).toBe(4)
    // Every lit triangle wears one of the declared inks or a racer's livery.
    const allowed = [...Object.values(RACE_MAP_INKS), '#316fb4', '#8ccf3a'].map(parseColour)
    const c = attrs(map).colour.array
    for (let t = 0; t < c.length / 12; t += 1) {
      const q = t * 12
      if ((c[q + 3] as number) === 0) continue
      const known = allowed.some(
        (k) =>
          Math.abs(k.r - (c[q] as number)) < 1e-6 &&
          Math.abs(k.g - (c[q + 1] as number)) < 1e-6 &&
          Math.abs(k.b - (c[q + 2] as number)) < 1e-6,
      )
      expect(known, `triangle ${t} wears a colour nobody declared`).toBe(true)
    }
    map.dispose()
  })

  it('DEV-373: draws the ghost as a HOLLOW dot, and nothing at all when there is none', () => {
    const map = build(1000)
    const ink = RACE_MAP_INKS.ghost
    map.update(feed(), 0)
    const without = trianglesInk(map, ink)
    expect(map.report().ghost).toBeNull()
    // East of the player along the loop's south leg (sim z = 0), clear of every dot.
    map.update(feed({ ghost: { x: 1000, z: 0 } }), 10)
    const report = map.report()
    const at = report.ghost as { x: number; y: number }
    expect(at).not.toBeNull()
    const player = report.dots.at(-1) as { x: number; y: number }
    expect(at.x).toBeGreaterThan(player.x)
    expect(at.y).toBeCloseTo(player.y, 9)
    expect(trianglesInk(map, ink) - without).toBe(12)
    // Hollow: of the triangles drawn round it, none covers its own centre —
    // and they reach out to a racer's dot size, so it reads as one more ship.
    const p = attrs(map).position.array
    const c = attrs(map).colour.array
    const want = parseColour(ink)
    let ring = 0
    let reach = 0
    const covers = (t: number, x: number, y: number): boolean => {
      const v = (k: number): [number, number] => [
        p[t * 9 + k * 3] as number,
        p[t * 9 + k * 3 + 1] as number,
      ]
      const a = v(0)
      const b = v(1)
      const d = v(2)
      const s = (u: [number, number], w: [number, number]) =>
        (u[0] - x) * (w[1] - y) - (w[0] - x) * (u[1] - y)
      const s1 = s(a, b)
      const s2 = s(b, d)
      const s3 = s(d, a)
      return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)
    }
    for (let t = 0; t < p.length / 9; t += 1) {
      if ((c[t * 12 + 3] as number) === 0) continue
      if (Math.abs((c[t * 12] as number) - want.r) > 1e-6) continue
      let near = true
      for (let k = 0; k < 3; k += 1) {
        const d = Math.hypot(
          (p[t * 9 + k * 3] as number) - at.x,
          (p[t * 9 + k * 3 + 1] as number) - at.y,
        )
        if (d > SIZE.dotMetres) near = false
        else reach = Math.max(reach, d)
      }
      if (!near) continue
      ring += 1
      expect(covers(t, at.x, at.y), `ghost triangle ${t} fills the centre`).toBe(false)
    }
    expect(ring).toBe(12)
    expect(reach).toBeCloseTo(SIZE.dotMetres / 2, 6)
    // And gone again when the ghost is.
    map.update(feed({ ghost: null }), 20)
    expect(map.report().ghost).toBeNull()
    expect(trianglesInk(map, ink)).toBe(without)
    map.dispose()
  })

  it('lights the place in the accent, and draws no readout before the race', () => {
    const map = build(1000)
    const finishTick = 2
    map.update(feed({ place: null }), 0)
    expect(map.report().text).toBe('')
    expect(trianglesInk(map, RACE_MAP_INKS.place)).toBe(finishTick)
    map.update(feed({ place: { place: 2, field: 6 } }), 10)
    expect(map.report().text).toBe('#2/6')
    expect(trianglesInk(map, RACE_MAP_INKS.place)).toBe(
      finishTick + 2 * glyphQuads('2', 0, 0, 1).length,
    )
    map.dispose()
  })
})

// ── DEV-432: the player's mark is a triangle along the nose ──────────────
//
// Matt, 2026-09-26: "it'd be nice if the player indicator in the mini-map was a
// triangle instead of circle". Every direction here is MEASURED on the drawn
// triangle — its apex against the midpoint of the side it faces — and compared
// with a nose built by `lookAlong` (whose own sweep, `quat-look.test.ts`, holds
// it to the direction it was given) or by a raw yaw quaternion. Never a
// rotation restated: the orientation lesson.

/** The player's triangle as DRAWN: the last one in the buffer. */
const drawnMark = (map: ReturnType<typeof build>) => {
  const p = attrs(map).position.array
  const t = p.length / 9 - 1
  const k = [corner(p, t, 0), corner(p, t, 1), corner(p, t, 2)]
  const side = (i: number) => {
    const a = k[(i + 1) % 3] as [number, number]
    const b = k[(i + 2) % 3] as [number, number]
    return Math.hypot(a[0] - b[0], a[1] - b[1])
  }
  const sides = [side(0), side(1), side(2)]
  // The apex is the corner facing the SHORTEST side: the triangle is narrow.
  const i = sides.indexOf(Math.min(...sides))
  const apex = k[i] as [number, number]
  const a = k[(i + 1) % 3] as [number, number]
  const b = k[(i + 2) % 3] as [number, number]
  const base = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const
  const length = Math.hypot(apex[0] - base[0], apex[1] - base[1])
  return {
    apex,
    centre: [(apex[0] + a[0] + b[0]) / 3, (apex[1] + a[1] + b[1]) / 3] as const,
    axis: [(apex[0] - base[0]) / length, (apex[1] - base[1]) / length] as const,
    length,
    width: Math.min(...sides),
  }
}

/** A nose along `dir` (sim space), wings level. */
const nose = (x: number, y: number, z: number) => lookAlong(quat(), v3(x, y, z))

/** The angle between two plate directions, radians. */
const between = (a: readonly [number, number], b: readonly [number, number]): number =>
  Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]))

describe('DEV-432: the player’s mark is a triangle along the nose', () => {
  it('points along the nose’s ground track at every bearing, pitched or rolled', () => {
    const map = build(1000)
    let now = 0
    for (let bearing = 0; bearing < 360; bearing += 15) {
      for (const pitch of [0, 35, -60]) {
        const b = THREE.MathUtils.degToRad(bearing)
        const e = THREE.MathUtils.degToRad(pitch)
        const q = nose(Math.sin(b) * Math.cos(e), Math.sin(e), Math.cos(b) * Math.cos(e))
        // A roll about the nose changes nothing about where it points.
        const rolled = mul(quat(), q, quat(0, 0, Math.sin(0.35), Math.cos(0.35)))
        for (const orientation of [q, rolled]) {
          now += 10
          map.update(feed({ playerOrientation: orientation }), now)
          const m = drawnMark(map)
          const track = [Math.sin(b), Math.cos(b)] as const
          expect(between(m.axis, track), `bearing ${bearing} pitch ${pitch}`).toBeLessThan(1e-5)
        }
      }
    }
    map.dispose()
  })

  it('puts a nose EAST to the right and a nose NORTH up, in plain words', () => {
    const map = build(1000)
    map.update(feed({ playerOrientation: nose(1, 0, 0) }), 0)
    const east = drawnMark(map)
    expect(east.apex[0] - east.centre[0]).toBeGreaterThan(0.004)
    expect(Math.abs(east.apex[1] - east.centre[1])).toBeLessThan(1e-6)
    map.update(feed({ playerOrientation: nose(0, 0, 1) }), 10)
    const north = drawnMark(map)
    expect(north.apex[1] - north.centre[1]).toBeGreaterThan(0.004)
    expect(Math.abs(north.apex[0] - north.centre[0])).toBeLessThan(1e-6)
    map.dispose()
  })

  it('turns CLOCKWISE on the plate for a right turn, so the mark is not a mirror', () => {
    // A raw yaw about +Y, not `lookAlong`: in Unity's frame a positive yaw
    // carries the nose from +z toward +x, which is a right turn. From above,
    // on a y-up plate, that is clockwise: a negative cross product.
    const map = build(1000)
    let last: readonly [number, number] | null = null
    for (let deg = 0; deg <= 90; deg += 10) {
      const h = THREE.MathUtils.degToRad(deg) / 2
      map.update(feed({ playerOrientation: quat(0, Math.sin(h), 0, Math.cos(h)) }), deg * 10)
      const { axis } = drawnMark(map)
      if (last) expect(last[0] * axis[1] - last[1] * axis[0]).toBeLessThan(0)
      last = axis
    }
    // Ninety degrees of right turn from north is east.
    expect(last?.[0]).toBeCloseTo(1, 6)
    map.dispose()
  })

  it('sits the ship at the middle of its mark, and keeps the mark its size', () => {
    const map = build(1000)
    map.update(feed({ playerOrientation: nose(0.6, 0, -0.8) }), 0)
    const m = drawnMark(map)
    const player = map.report().dots.at(-1) as { x: number; y: number }
    expect(m.centre[0]).toBeCloseTo(player.x, 9)
    expect(m.centre[1]).toBeCloseTo(player.y, 9)
    // The shape changed and the weight did not: the triangle covers what the
    // hexagon `playerDotMetres` across did — six equilateral triangles of side
    // half that — and it is narrower than long, so it points one way, not three.
    const r = SIZE.playerDotMetres / 2
    const hexagon = 6 * (Math.sqrt(3) / 4) * r * r
    expect((m.length * m.width) / 2 / hexagon).toBeCloseTo(1, 5)
    expect(m.width).toBeLessThan(m.length)
    // And more of the plate than a racer's dot, read off the buffer: the first
    // racer's four fan triangles.
    const p = attrs(map).position.array
    const tris = p.length / 9
    const areaOf = (t: number) => {
      const [a, b, c] = [corner(p, t, 0), corner(p, t, 1), corner(p, t, 2)]
      return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2
    }
    const firstRacer = tris - 2 - 4 * COLOURS.length
    let racer = 0
    for (let t = firstRacer; t < firstRacer + 4; t += 1) racer += areaOf(t)
    expect(areaOf(tris - 1)).toBeGreaterThan(racer * 1.5)
    map.dispose()
  })

  it('keeps the last heading when the nose points straight up or down, with no NaN', () => {
    const map = build(1000)
    map.update(feed({ playerOrientation: nose(1, 0, 0) }), 0)
    map.update(feed({ playerOrientation: nose(0, 1, 0), player: { x: 900, z: 0 } }), 10)
    map.update(feed({ playerOrientation: nose(0, -1, 0), player: { x: 950, z: 0 } }), 20)
    const m = drawnMark(map)
    expect(m.axis[0]).toBeCloseTo(1, 6)
    expect(map.report().playerHeading.x).toBeCloseTo(1, 9)
    const p = attrs(map).position.array
    expect(p.every((v) => Number.isFinite(v))).toBe(true)
    // Nothing at all fed is north, the map's own up.
    const fresh = build(1000)
    fresh.update(feed(), 0)
    expect(drawnMark(fresh).axis[1]).toBeCloseTo(1, 6)
    fresh.dispose()
    map.dispose()
  })

  it('writes a turn in place once the tip moves a texel, and not before', () => {
    const map = build(1000)
    map.update(feed({ playerOrientation: nose(0, 0, 1) }), 0)
    expect(map.report().writes).toBe(1)
    // A thousandth of a radian moves a tip a few millimetres out by a few
    // micrometres: no pixel changes, so nothing is written.
    map.update(feed({ playerOrientation: nose(Math.sin(0.001), 0, Math.cos(0.001)) }), 10)
    expect(map.report()).toMatchObject({ writes: 1, unchanged: 1 })
    // Thirty degrees, standing still: the only thing that moved is the tip.
    map.update(feed({ playerOrientation: nose(0.5, 0, Math.sqrt(3) / 2) }), 20)
    expect(map.report().writes).toBe(2)
    expect(map.report().playerHeading.x).toBeCloseTo(0.5, 9)
    map.dispose()
  })

  it('rings the mark with ONE width all round: every ring edge parallel to its own, as far out', () => {
    const layout = raceMapLayout(SIZE, WIDTH, HEIGHT)
    const { fill, ring } = playerMark(SIZE, layout.stroke)
    const gaps: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const a = fill[i] as readonly [number, number]
      const b = fill[(i + 1) % 3] as readonly [number, number]
      const ra = ring[i] as readonly [number, number]
      const rb = ring[(i + 1) % 3] as readonly [number, number]
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const len = Math.hypot(dx, dy)
      // Parallel: the ring edge's direction crossed with the fill edge's is 0.
      expect(Math.abs((rb[0] - ra[0]) * dy - (rb[1] - ra[1]) * dx) / len).toBeLessThan(1e-12)
      // Outward: the opposite fill corner and the ring edge are on OPPOSITE
      // sides of the fill edge; the distance between the two lines is the gap.
      const o = fill[(i + 2) % 3] as readonly [number, number]
      const sideOf = (p: readonly [number, number]) =>
        ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len
      expect(Math.sign(sideOf(ra))).toBe(-Math.sign(sideOf(o)))
      gaps.push(Math.abs(sideOf(ra)))
    }
    expect(gaps[0]).toBeGreaterThan(0)
    expect(gaps[1]).toBeCloseTo(gaps[0] as number, 12)
    expect(gaps[2]).toBeCloseTo(gaps[0] as number, 12)
    // Half the ring the hexagon wore (`PLAYER_RING_PER_STROKE` says why).
    expect(gaps[0]).toBeCloseTo(layout.stroke / 2, 12)
  })

  it('stays on the plate and clear of the readout, anywhere on the course at any heading', () => {
    // The fit keeps the hexagon's margin (the course did not shrink for the
    // triangle), so the tip may reach into the inset: never off the plate,
    // never into the glyphs. A ship far off the course sits clamped on the
    // area's rim, which is exactly where this could fail.
    const map = build(1000)
    const { layout } = map.report()
    let now = 0
    for (const [x, z] of [
      [90_000, 90_000],
      [-90_000, 90_000],
      [90_000, -90_000],
      [-90_000, -90_000],
    ] as const) {
      for (let bearing = 0; bearing < 360; bearing += 10) {
        const b = THREE.MathUtils.degToRad(bearing)
        now += 10
        map.update(
          feed({ player: { x, z }, playerOrientation: nose(Math.sin(b), 0, Math.cos(b)) }),
          now,
        )
        const p = attrs(map).position.array
        const ringTri = p.length / 9 - 2
        for (let v = 0; v < 3; v += 1) {
          const [cx, cy] = corner(p, ringTri, v)
          expect(Math.abs(cx)).toBeLessThan(layout.width / 2)
          expect(Math.abs(cy)).toBeLessThan(layout.height / 2)
          expect(cy).toBeLessThan(layout.glyphBottom)
        }
      }
    }
    map.dispose()
  })
})
