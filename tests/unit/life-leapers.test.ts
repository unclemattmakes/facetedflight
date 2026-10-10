// tests/unit/life-leapers.test.ts — DEV-449, the dolphins and the fish.
//
//  1. WHERE — `placePods` over the boats' synthetic island: every pod in water
//     at least `depth` deep (open ocean counts), off the keep-outs, apart; a
//     pod is several animals sharing a heading; deterministic.
//  2. WHEN — `leapAt` against the ballistics it claims: in the air for
//     2 sqrt(2H/g) of each period and no longer, the apex at H halfway, the
//     arc symmetric end to end, the nose up the arc going up and down it
//     coming down.
//  3. HOW — `leaperRotation` is a rotation (DEV-044's class: a mirror is
//     inside out), its +z the SIM heading `(sin, cos)` through the z flip,
//     and the field draws a leap from the DRAWN surface, hides an animal
//     under it, and puts the apex H above it; an RGB bake is drawn RGBA.
//  4. THE TWO SEA MISSIONS, on their real maps (at the end): int_01_hoverJet
//     gets pods of both kinds, and kauai's copy of the course gets none.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { type Edition, type EditionLifeLeapers, editionFeatures } from '@/content/edition-schema'
import { LEAPER_KINDS, type LeaperKind, leapersWanted, lifeWanted } from '@/game/life/load-life'
import { createLeaperField, leaperRotation } from '@/render/life-leapers'
import type { WaterDisplace } from '@/render/water'
import { seedOf, waterDepthAt } from '@/sim/life/boats'
import {
  airTime,
  type BreachSpec,
  breachDue,
  type Leaper,
  leapAt,
  leapPose,
  type PodInput,
  type PodSpec,
  placePods,
} from '@/sim/life/pods'
import { v3 } from '@/sim/math/vec3'
import { createRoute, routeAt } from '@/sim/route'
import type { FacetedTerrainParams, MapSampler } from '@/sim/terrain/faceted'
import { buildHeightField, outsideField, terrainHeightAt } from '@/sim/terrain/height-field'
import type { Rgb } from '@/sim/terrain/image-sampler'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'
import { fieldFor, haveMaps, loadLevelJson, oceanFieldFor } from './helpers/terrain-field'

const map = (f: (u: number, v: number) => number): MapSampler =>
  ({
    width: 128,
    height: 128,
    sample(u: number, v: number, out: Rgb): Rgb {
      const g = Math.min(1, Math.max(0, f(u, v)))
      out.r = g
      out.g = g
      out.b = g
      return out
    },
  }) as unknown as MapSampler

const LAND_PARAMS: FacetedTerrainParams = {
  terrainSize: 2048,
  terrainHeight: 400,
  chunkSize: 256,
  baseResolution: 8,
  randomOffset: 0,
  seed: 1,
}
const LAND = buildHeightField(
  map((u, v) => 0.25 + 0.5 * Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.5) * 2 * 1.6)),
  LAND_PARAMS,
  { position: [0, 0, 0], scale: [1, 1, 1] },
)
const SEA = buildHeightField(
  map(() => 0.29),
  { ...LAND_PARAMS, terrainSize: 1024, baseResolution: 32 },
  { position: [-2048, 0, -2048], scale: [6, 1, 6] },
)

const SPEC: PodSpec = {
  seed: 449,
  alongRoute: 6,
  atStart: 1,
  routeReach: [60, 900],
  startReach: [60, 600],
  depth: 8,
  spacing: 250,
  perPod: [2, 5],
  podRadius: 14,
  swing: 12,
  period: [5, 9],
  height: [1.2, 2.4],
  length: [5, 8],
  scale: [13, 16],
  search: { step: 10, angles: 24 },
}

const INPUT: PodInput = {
  spec: SPEC,
  courseSeed: seedOf('int_01_hoverJet'),
  line: createRoute(
    Array.from({ length: 64 }, (_, i) => {
      const a = (i / 63) * Math.PI * 2
      return [1024 + Math.cos(a) * 520, 150, -(1024 + Math.sin(a) * 520)]
    }),
  ),
  start: { x: 2948, z: 1024 },
  sea: SEA,
  land: LAND,
  keepOut: [{ x: 2948, z: 1024, radius: 52 }],
}

describe('placePods — the rule, measured on its output', () => {
  const animals = placePods(INPUT)

  it('places pods of several animals', () => {
    const pods = new Set(animals.map((a) => a.pod))
    expect(pods.size).toBeGreaterThanOrEqual(4)
    for (const p of pods) {
      const n = animals.filter((a) => a.pod === p).length
      expect(n).toBeGreaterThanOrEqual(1)
      expect(n).toBeLessThanOrEqual(SPEC.perPod[1])
    }
  })

  it('every animal is over water at least `depth` deep, off the keep-outs', () => {
    for (const a of animals) {
      expect(waterDepthAt(SEA, LAND, a.x, a.z)).toBeGreaterThanOrEqual(SPEC.depth)
      for (const k of INPUT.keepOut)
        expect(Math.hypot(a.x - k.x, a.z - k.z)).toBeGreaterThanOrEqual(k.radius - SPEC.podRadius)
    }
  })

  it('a pod travels together: headings within the swing of each other', () => {
    const swing = (SPEC.swing * Math.PI) / 180
    for (const p of new Set(animals.map((a) => a.pod))) {
      const hs = animals.filter((a) => a.pod === p).map((a) => a.heading)
      expect(Math.max(...hs) - Math.min(...hs)).toBeLessThanOrEqual(2 * swing + 1e-9)
    }
  })

  it('is deterministic, and draws its numbers inside the preset’s ranges', () => {
    expect(placePods(INPUT)).toEqual(animals)
    for (const a of animals) {
      expect(a.period).toBeGreaterThanOrEqual(SPEC.period[0])
      expect(a.period).toBeLessThanOrEqual(SPEC.period[1])
      expect(a.height).toBeGreaterThanOrEqual(SPEC.height[0])
      expect(a.height).toBeLessThanOrEqual(SPEC.height[1])
      expect(a.length).toBeGreaterThanOrEqual(SPEC.length[0])
      expect(a.length).toBeLessThanOrEqual(SPEC.length[1])
    }
  })

  it('open ocean counts as deep: a pod needs room, not a shore', () => {
    const deep = placePods({ ...INPUT, spec: { ...SPEC, depth: 1e6 } })
    expect(deep.length).toBeGreaterThan(0)
    for (const a of deep) expect(waterDepthAt(SEA, LAND, a.x, a.z)).toBe(Number.POSITIVE_INFINITY)
  })

  it('lineAbove: no route aim where the line flies higher over the sea (DEV-532)', () => {
    // The synthetic line flies at 150; the sea's base is 0.29 x 400 = 116.
    const all = placePods(INPUT)
    const low = placePods({ ...INPUT, spec: { ...SPEC, lineAbove: 40 } })
    const high = placePods({ ...INPUT, spec: { ...SPEC, lineAbove: 30 } })
    expect(low).toEqual(all)
    // Only the start's pod is left: every route aim stood 34 m over the sea.
    expect(new Set(high.map((a) => a.pod)).size).toBe(1)
    expect(high.every((a) => Math.hypot(a.x - INPUT.start.x, a.z - INPUT.start.z) < 700)).toBe(true)
  })

  it('aims that reach only land find no pods', () => {
    const inland = placePods({
      ...INPUT,
      start: { x: 1024, z: 1024 },
      spec: { ...SPEC, routeReach: [0, 20], startReach: [0, 20] },
    })
    expect(inland).toEqual([])
  })
})

const ONE: Leaper = {
  x: 0,
  z: 0,
  heading: 0.6,
  period: 8,
  phase: 0,
  height: 2,
  length: 6,
  scale: 14,
  pod: 0,
}
const G = 9.81

describe('leapAt — a thrown body, once a period', () => {
  const air = 2 * Math.sqrt((2 * ONE.height) / G)

  it('is in the air for 2 sqrt(2H/g) of every period and under for the rest', () => {
    const pose = leapPose()
    let inAir = 0
    const n = 8000
    for (let i = 0; i < n; i++) {
      if (leapAt(ONE, (i / n) * ONE.period * 3, G, pose).airborne) inAir++
    }
    expect(inAir / n).toBeCloseTo(air / ONE.period, 2)
  })

  it('peaks at H halfway, and starts and ends at the water', () => {
    const pose = leapPose()
    leapAt(ONE, air / 2, G, pose)
    expect(pose.up).toBeCloseTo(ONE.height, 9)
    expect(pose.along).toBeCloseTo(0, 9)
    leapAt(ONE, 1e-9, G, pose)
    expect(pose.up).toBeCloseTo(0, 6)
    expect(pose.along).toBeCloseTo(-ONE.length / 2, 6)
  })

  it('noses up the arc going up and down it coming down, symmetrically', () => {
    const a = leapAt(ONE, air * 0.1, G, leapPose())
    const b = leapAt(ONE, air * 0.9, G, leapPose())
    expect(a.pitch).toBeGreaterThan(0)
    expect(b.pitch).toBeLessThan(0)
    expect(a.pitch).toBeCloseTo(-b.pitch, 9)
    // The arc's own slope at the ends: atan(4H / L).
    const start = leapAt(ONE, 1e-9, G, leapPose())
    expect(start.pitch).toBeCloseTo(Math.atan2(4 * ONE.height, ONE.length), 6)
  })

  it('a phase shifts the leap in time and nothing else', () => {
    const p = leapAt({ ...ONE, phase: 3 }, air / 2 - 3, G, leapPose())
    expect(p.up).toBeCloseTo(ONE.height, 9)
  })
})

describe('leaperRotation — a nose along the heading, never a mirror', () => {
  const q = new THREE.Quaternion()

  it('is a rotation, and puts +z along the SIM heading through the z flip', () => {
    for (const [h, p] of [
      [0, 0],
      [0.6, 0.4],
      [2.3, -0.5],
      [-1.2, 0.2],
    ] as const) {
      leaperRotation(h, p, q)
      expect(new THREE.Matrix4().makeRotationFromQuaternion(q).determinant()).toBeCloseTo(1, 9)
      const nose = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
      // THREE (x, y, z) -> SIM (x, y, -z): (sin h cos p, sin p, cos h cos p).
      expect(nose.x).toBeCloseTo(Math.sin(h) * Math.cos(p), 9)
      expect(nose.y).toBeCloseTo(Math.sin(p), 9)
      expect(-nose.z).toBeCloseTo(Math.cos(h) * Math.cos(p), 9)
    }
  })

  it('keeps its back up on a level leap', () => {
    leaperRotation(1.1, 0, q)
    expect(new THREE.Vector3(0, 1, 0).applyQuaternion(q).y).toBeCloseTo(1, 9)
  })
})

describe('the field — hidden under the water, H over it at the apex', () => {
  const still: WaterDisplace = {
    live: true,
    direction: 0,
    speed: 0,
    amplitude: 0,
    frequency: 0,
    noise: 0,
  }
  // A flat drawn sea at 116: the leap's ends read it.
  const flat = {
    corners: new Float64Array([0, 116, 0, 1, 116, 0, 0, 116, 1]),
    weights: [1, 0, 0] as [number, number, number],
  }

  it('draws the apex at surface + bob + H, and nothing under the water', () => {
    const field = createLeaperField(
      'life:test',
      new THREE.BoxGeometry(1, 1, 1),
      [{ leaper: ONE, from: flat, to: flat }],
      G,
      still,
    )
    const air = 2 * Math.sqrt((2 * ONE.height) / G)
    const m = new THREE.Matrix4()
    const p = new THREE.Vector3()
    field.update(air / 2, 1.5)
    expect(field.airborne()).toBe(1)
    field.object.getMatrixAt(0, m)
    p.setFromMatrixPosition(m)
    expect(p.y).toBeCloseTo(116 + 1.5 + ONE.height, 9)
    field.update(air + 1, 1.5)
    expect(field.airborne()).toBe(0)
    field.object.getMatrixAt(0, m)
    expect(new THREE.Vector3().setFromMatrixScale(m).length()).toBe(0)
    field.dispose()
  })

  it('draws an RGB bake as RGBA, alpha 1 — the colour width the scatter program is keyed on', () => {
    // three keys `vertexAlphas` on a four-wide colour; the converted props
    // are RGBA, so an RGB creature compiled programs of its own (the e2e read
    // 161 programs against 158 pinned off, at one view, before this).
    const g = new THREE.BoxGeometry(1, 1, 1)
    const n = g.getAttribute('position').count
    const rgb = new Float32Array(n * 3).map((_, i) => (i % 3) * 0.25)
    g.setAttribute('color', new THREE.BufferAttribute(rgb, 3))
    const field = createLeaperField(
      'life:test',
      g,
      [{ leaper: ONE, from: flat, to: flat }],
      G,
      still,
    )
    const c = field.object.geometry.getAttribute('color')
    expect(c.itemSize).toBe(4)
    expect(c.count).toBe(n)
    for (let i = 0; i < n; i++) {
      expect([c.getX(i), c.getY(i), c.getZ(i)]).toEqual([0, 0.25, 0.5])
      expect(c.getW(i)).toBe(1)
    }
    field.dispose()
  })
})

// DEV-532: a pod leaps together as the player comes at it.
const BREACH: BreachSpec = {
  apexAhead: 110,
  below: 28,
  ahead: 35,
  reach: 600,
  minSpeed: 30,
  stagger: 0.2,
  rest: 8,
}

describe('breachDue — the cue, as geometry', () => {
  const air = airTime(3, G)

  it('cues a pod dead ahead at apexAhead + closing x air / 2, and not a metre before', () => {
    const lead = BREACH.apexAhead + (160 * air) / 2
    expect(breachDue(0, lead, 0, 0, 0, 160, air, BREACH)).toBe(true)
    expect(breachDue(0, lead + 1, 0, 0, 0, 160, air, BREACH)).toBe(false)
  })

  it('leads by the CLOSING speed: a pod off to the side is cued nearer', () => {
    // 30 degrees off the travel: closing is speed x cos 30.
    const a = (30 * Math.PI) / 180
    const lead = BREACH.apexAhead + (160 * Math.cos(a) * air) / 2
    const at = (d: number) => breachDue(Math.sin(a) * d, Math.cos(a) * d, 0, 0, 0, 160, air, BREACH)
    expect(at(lead - 0.5)).toBe(true)
    expect(at(lead + 0.5)).toBe(false)
  })

  it('never behind, outside the cone, too slow, or beyond reach', () => {
    expect(breachDue(0, -100, 0, 0, 0, 160, air, BREACH)).toBe(false)
    const off = ((BREACH.ahead + 1) * Math.PI) / 180
    expect(breachDue(Math.sin(off) * 100, Math.cos(off) * 100, 0, 0, 0, 160, air, BREACH)).toBe(
      false,
    )
    expect(breachDue(0, 50, 0, 0, 0, BREACH.minSpeed - 1, air, BREACH)).toBe(false)
    expect(breachDue(0, 590, 0, 0, 0, 5000, air, BREACH)).toBe(true)
    expect(breachDue(0, 610, 0, 0, 0, 5000, air, BREACH)).toBe(false)
  })
})

describe('the field — a breach, cued by the eye', () => {
  const still: WaterDisplace = {
    live: true,
    direction: 0,
    speed: 0,
    amplitude: 0,
    frequency: 0,
    noise: 0,
  }
  const flat = {
    corners: new Float64Array([0, 116, 0, 1, 116, 0, 0, 116, 1]),
    weights: [1, 0, 0] as [number, number, number],
  }
  // A pod of four at SIM (0, 1000), each with a period that keeps it under
  // for the whole run unless cued: phase puts the periodic leap far away.
  const pod: Leaper[] = [0, 1, 2, 3].map((k) => ({
    ...ONE,
    x: k * 3,
    z: 1000,
    height: 3,
    period: 1000,
    phase: 500,
    pod: 7,
  }))
  const build = (breach: BreachSpec | null) =>
    createLeaperField(
      'life:test',
      new THREE.BoxGeometry(1, 1, 1),
      pod.map((leaper) => ({ leaper, from: flat, to: flat })),
      G,
      still,
      undefined,
      breach,
    )
  // An eye flying SIM +z at 160 m/s from z = 0: THREE z is the negation.
  const fly = (field: ReturnType<typeof build>, seconds: number, dt = 1 / 90) => {
    const trace: { t: number; d: number; up: number }[] = []
    for (let t = 0; t <= seconds; t += dt) {
      const z = 160 * t
      field.update(t, 0, { x: 0, y: 0, z: -z })
      trace.push({ t, d: 1000 - z, up: field.airborne() })
    }
    return trace
  }

  it('every animal leaps once, staggered, and the first apex falls ~apexAhead off', () => {
    const field = build(BREACH)
    const trace = fly(field, 8)
    expect(field.breaches()).toBe(1)
    expect(Math.max(...trace.map((s) => s.up))).toBe(4)
    const first = trace.find((s) => s.up > 0) as { t: number; d: number }
    const air = airTime(3, G)
    // The first animal's apex is air / 2 after the cue.
    const apexAt = first.t + air / 2
    const dAtApex = 1000 - 160 * apexAt
    expect(Math.abs(dAtApex - BREACH.apexAhead)).toBeLessThan(160 / 90 + 1)
    // The last animal is back in by stagger x 3 + air after the cue.
    const last = [...trace].reverse().find((s) => s.up > 0) as { t: number }
    expect(last.t - first.t).toBeCloseTo(3 * BREACH.stagger + air, 1)
    field.dispose()
  })

  it('without a breach spec the eye changes nothing', () => {
    const field = build(null)
    const trace = fly(field, 6.5)
    expect(field.breaches()).toBe(0)
    expect(Math.max(...trace.map((s) => s.up))).toBe(0)
    field.dispose()
  })

  it('a stalled eye cues nothing', () => {
    const field = build(BREACH)
    // Hover 300 m short of the pod: speed 0, never cued.
    for (let t = 0; t < 3; t += 1 / 90) field.update(t, 0, { x: 0, y: 0, z: -700 })
    expect(field.breaches()).toBe(0)
    field.dispose()
  })
})

describe('leapersWanted — the preset and the comfort floor', () => {
  const ann = (anniversary as unknown as { life: { dolphins: EditionLifeLeapers } }).life
  const cls = (classic as unknown as { life: { dolphins: EditionLifeLeapers } }).life
  it('Anniversary leaps at its floor and above; low drops them; Classic never', () => {
    for (const k of LEAPER_KINDS) {
      expect(leapersWanted(ann[k], 'high')).toBe(true)
      expect(leapersWanted({ ...ann[k], minQuality: 'medium' }, 'low')).toBe(false)
      for (const q of ['low', 'medium', 'high']) expect(leapersWanted(cls[k], q)).toBe(false)
    }
  })
  it('lifeWanted answers for every kind', () => {
    const all = lifeWanted(
      (anniversary as unknown as { life: Parameters<typeof lifeWanted>[0] }).life,
      'high',
    )
    // No `spectators`: DEV-463 cut DEV-448's crowds. No `fish`: DEV-545 cut DEV-449's.
    expect(all).toEqual({ boats: true, dolphins: true })
  })
  // DEV-545, Matt 2026-09-30: "kill the fish". Gone from the kinds, from both
  // presets' `life` blocks, and from the feature registry the Advanced page
  // and `vr.disable` name paths from — the dolphins and the boats stay.
  it('DEV-545: the fish are gone, from the kinds, the presets and the feature paths', () => {
    expect(LEAPER_KINDS).toEqual(['dolphins'])
    for (const preset of [anniversary, classic]) {
      expect(Object.keys((preset as unknown as { life: object }).life).sort()).toEqual([
        'boats',
        'dolphins',
        'note',
      ])
    }
    const paths = editionFeatures(anniversary as unknown as Edition).map(([p]) => p)
    expect(paths).toContain('life.dolphins')
    expect(paths).toContain('life.boats')
    expect(paths.filter((p) => p.startsWith('life.'))).toEqual(['life.boats', 'life.dolphins'])
  })
})

// 4. The sea missions on their own maps (`helpers/terrain-field.ts` builds
//    them the way the game does). Keep-outs are left out: they only remove.
//    Kauai is the point: the same course authored over a second island runs
//    INLAND there — its spawn stands on a mountainside, ~178 m over the sea,
//    and no water inside either kind's reach is deep enough — so it has no
//    leapers, and `life-leapers.spec.ts` holds the built game to that.
const podsFor = (id: string, kind: LeaperKind) => {
  const spec = (anniversary as unknown as { life: Record<string, EditionLifeLeapers> }).life[
    kind
  ] as EditionLifeLeapers
  const level = loadLevelJson(id)
  const sea = oceanFieldFor(level)
  if (!sea) throw new Error(`${id} has no sea`)
  return placePods({
    spec,
    courseSeed: seedOf(id),
    line: createRoute(level.route),
    start: { x: level.spawn.pos[0], z: -level.spawn.pos[2] },
    sea,
    land: fieldFor(level),
    keepOut: [],
  })
}

describe.skipIf(!haveMaps)('DEV-449 — the sea missions, on their real maps', () => {
  it('int_01_hoverJet: pods of every kind, every animal in water its kind wants', () => {
    const level = loadLevelJson('int_01_hoverJet')
    const sea = oceanFieldFor(level)
    const land = fieldFor(level)
    for (const kind of LEAPER_KINDS) {
      const spec = (anniversary as unknown as { life: Record<string, EditionLifeLeapers> }).life[
        kind
      ] as EditionLifeLeapers
      const pods = podsFor('int_01_hoverJet', kind)
      expect(new Set(pods.map((a) => a.pod)).size).toBeGreaterThanOrEqual(3)
      for (const a of pods) {
        expect(waterDepthAt(sea as NonNullable<typeof sea>, land, a.x, a.z)).toBeGreaterThanOrEqual(
          spec.depth,
        )
      }
    }
  })

  // DEV-532, Matt: "i haven't seen the dolphins." The premise, measured on the
  // real maps rather than argued: an eye flown along int_01's racing line at
  // 160 m/s (~576 km/h, under the autopilot's lap), 1.9 m over it, through the
  // SHIPPED preset's field. A dolphin counts as SEEN on a frame when it is in
  // the air, inside a 45-degree cone of the travel (the cockpit's 70-degree
  // vertical and ~100-degree horizontal view), with no land between it and the
  // eye (the island's own height field, marched), and its length spans at
  // least 16 px at 1280 x 720 (focal 514 px). Run on DEV-449's preset (the
  // commit before DEV-532), this read 0 breaches, 0.0 s, 0 pods: shown RED.
  it('int_01_hoverJet: from the line, dolphins are seen breaching, big enough to read', () => {
    const level = loadLevelJson('int_01_hoverJet')
    const sea = oceanFieldFor(level) as NonNullable<ReturnType<typeof oceanFieldFor>>
    const land = fieldFor(level)
    const spec = (anniversary as unknown as { life: Record<string, EditionLifeLeapers> }).life
      .dolphins as EditionLifeLeapers
    const line = createRoute(level.route)
    const animals = placePods({
      spec,
      courseSeed: seedOf('int_01_hoverJet'),
      line,
      start: { x: level.spawn.pos[0], z: -level.spawn.pos[2] },
      sea,
      land,
      keepOut: [],
    })
    const still: WaterDisplace = {
      live: true,
      direction: 0,
      speed: 0,
      amplitude: 0,
      frequency: 0,
      noise: 0,
    }
    // Each leap rides the sea's own base height under it (the wave is metres,
    // the question is kilometres).
    const at = (l: Leaper) => {
      const y = terrainHeightAt(sea, l.x, l.z)
      return {
        corners: new Float64Array([l.x, y, -l.z, l.x + 1, y, -l.z, l.x, y, -l.z - 1]),
        weights: [1, 0, 0] as [number, number, number],
      }
    }
    const field = createLeaperField(
      'life:dolphins',
      new THREE.BoxGeometry(1, 1, 1),
      animals.map((leaper) => ({ leaper, from: at(leaper), to: at(leaper) })),
      spec.gravity,
      still,
      undefined,
      spec.breach ?? null,
    )
    const clear = (e: THREE.Vector3, t: THREE.Vector3) => {
      for (let i = 1; i < 64; i++) {
        const s = i / 64
        const x = e.x + (t.x - e.x) * s
        const simZ = -(e.z + (t.z - e.z) * s)
        if (outsideField(land, x, simZ)) continue
        if (terrainHeightAt(land, x, simZ) > e.y + (t.y - e.y) * s) return false
      }
      return true
    }
    const speed = 160
    const dt = 1 / 30
    const p = v3()
    const q = v3()
    const eye = new THREE.Vector3()
    const fwd = new THREE.Vector3()
    const m = new THREE.Matrix4()
    const pos = new THREE.Vector3()
    const to = new THREE.Vector3()
    let seenSeconds = 0
    const seenPods = new Set<number>()
    let biggest = 0
    // The lap ends at the FINISH, not at the line's end: the authored route
    // runs on ~1 km past it. The finish is where the line's second half passes
    // nearest the finish gate (level JSON, THREE -> SIM through the z flip).
    const [fx, , fz] = level.finish.pos as [number, number, number]
    let finishAt = line.length
    let nearest = Number.POSITIVE_INFINITY
    for (let s = line.length / 2; s < line.length; s += 5) {
      routeAt(line, s, p)
      const d = Math.hypot(p.x - fx, p.z + fz)
      if (d < nearest) {
        nearest = d
        finishAt = s
      }
    }
    for (let t = 0; t * speed < finishAt; t += dt) {
      routeAt(line, t * speed, p)
      routeAt(line, t * speed + 5, q)
      eye.set(p.x, p.y + 1.9, -p.z)
      fwd.set(q.x - p.x, q.y - p.y, -(q.z - p.z)).normalize()
      field.update(t, 0, eye)
      let frame = 0
      for (let i = 0; i < field.count; i++) {
        field.object.getMatrixAt(i, m)
        pos.setFromMatrixPosition(m)
        const scale = new THREE.Vector3().setFromMatrixScale(m).x
        if (scale === 0) continue
        to.copy(pos).sub(eye)
        const d = to.length()
        if (to.dot(fwd) / d < Math.cos(Math.PI / 4)) continue
        const px = (0.1725 * scale * 514) / d
        if (px < 16 || !clear(eye, pos)) continue
        frame = 1
        biggest = Math.max(biggest, px)
        seenPods.add((field.animals[i] as { leaper: Leaper }).leaper.pod)
      }
      seenSeconds += frame * dt
    }
    const pods = new Set(animals.map((a) => a.pod)).size
    console.log(
      `DEV-532 int_01 dolphins from the line: ${animals.length} in ${pods} pods, ` +
        `${field.breaches()} breaches cued over ${(finishAt / 1000).toFixed(2)} km to the finish, ` +
        `seen >= 16 px for ${seenSeconds.toFixed(1)} s a lap from ${seenPods.size} pods, ` +
        `biggest ${biggest.toFixed(0)} px`,
    )
    expect(field.breaches()).toBeGreaterThanOrEqual(6)
    expect(seenPods.size).toBeGreaterThanOrEqual(5)
    expect(seenSeconds).toBeGreaterThanOrEqual(2)
    field.dispose()
  })

  it('hoverJet_kauai_beg: none — the course keeps inland', () => {
    const level = loadLevelJson('hoverJet_kauai_beg')
    const sea = oceanFieldFor(level)
    const s = { x: level.spawn.pos[0], z: -level.spawn.pos[2] }
    expect(waterDepthAt(sea as NonNullable<typeof sea>, fieldFor(level), s.x, s.z)).toBeLessThan(
      -100,
    )
    for (const kind of LEAPER_KINDS) expect(podsFor('hoverJet_kauai_beg', kind)).toEqual([])
  })
})

describe.skipIf(haveMaps)('DEV-449 — terrain maps not present', () => {
  it('the guard is false here, so the real-maps tests above are skipped, not passing', () => {
    expect(haveMaps).toBe(false)
  })
})
