// tests/unit/player-course-light.test.ts — a player course's sun and tint.
// DEV-476 (docs/plan/EDITOR-PLAYTEST-2026-09-27.md).
//
// What is held here:
//   1. the light block's policy numbers, by value;
//   2. the angles against the shipped suns (the extractor's own `elevationDeg`
//      is the outside witness), and the azimuth against the start pad's
//      heading convention (`yawForward`);
//   3. an ABSENT light expands byte for byte as the build before DEV-476 did,
//      and keeps its id — against bytes that build wrote itself
//      (`fixtures/player-course-v2-expansions.json`);
//   4. the expansion's sun is the sliders' sun, and nothing else in the level
//      moves;
//   5. the format: canonical, round trip, refusals;
//   6. the sky's band: measured on SkyJ, and free on the gradient skies.

import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import {
  canonicalPlayerCourse,
  expandPlayerCourse,
  type PlayerCourse,
  playerCourseId,
  validatePlayerCourse,
  yawForward,
} from '@/content/player-course'
import {
  clampLight,
  clampSunToSky,
  normaliseAzimuth,
  PLAYER_COURSE_LIGHT,
  type PlayerCourseLight,
  playerCourseSun,
  SUN_ELEVATION_FLOOR,
  skyAgreementAt,
  skyLight,
  sunAnglesOf,
  sunTravelOf,
  towardSunOf,
} from '@/content/player-course-light'
import { sha256Hex } from '@/content/sha256'
import { MIN_SUN_HEIGHT_SIN } from '@/sim/terrain/sun-height'
import fixture from './fixtures/player-course-v2-expansions.json'
import { shippedLevels } from './helpers/content'

const shipped: Level[] = shippedLevels()
const byId = (id: string): Level => shipped.find((l) => l.id === id) as Level
const hoverjets = shipped.filter((l) => l.vehicle === 'hoverjet')
const decoded = hoverjets.filter((l) => l.lighting.sky?.available)
const gradient = hoverjets.filter((l) => !l.lighting.sky?.available)

const DEG = Math.PI / 180
const angleBetween = (a: readonly number[], b: readonly number[]): number => {
  const la = Math.hypot(a[0] as number, a[1] as number, a[2] as number)
  const lb = Math.hypot(b[0] as number, b[1] as number, b[2] as number)
  const c =
    ((a[0] as number) * (b[0] as number) +
      (a[1] as number) * (b[1] as number) +
      (a[2] as number) * (b[2] as number)) /
    (la * lb)
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG
}

type Entry = (typeof fixture.courses)[number]
const courseOf = (e: Entry): PlayerCourse => e.course as unknown as PlayerCourse
const bytesSha = (level: Level): string =>
  sha256Hex(new TextEncoder().encode(JSON.stringify(level)))

const LIGHT: PlayerCourseLight = {
  sunAzimuth: -120,
  sunElevation: 30,
  tint: [1, 0.8, 0.6],
  tintAmount: 0.35,
}

describe('DEV-476 — the policy numbers, pinned by value', () => {
  it('holds the light grid and bounds', () => {
    expect(PLAYER_COURSE_LIGHT).toEqual({
      angleQuantumDegrees: 0.1,
      tintQuantum: 0.001,
      tintAmountQuantum: 0.01,
      elevationMaxDegrees: 90,
      skyAgreement: 1,
      skyMeanStepDegrees: 1,
    })
  })

  it("floors the sun at the far-shadow march's own floor, the least grid value it still runs at", () => {
    expect(SUN_ELEVATION_FLOOR).toBe(0.5)
    expect(Math.sin(SUN_ELEVATION_FLOOR * DEG)).toBeGreaterThanOrEqual(MIN_SUN_HEIGHT_SIN)
    expect(Math.sin((SUN_ELEVATION_FLOOR - 0.1) * DEG)).toBeLessThan(MIN_SUN_HEIGHT_SIN)
  })

  it('keeps a picked 8-bit colour through the tint grid', () => {
    for (let v = 0; v <= 255; v++) {
      const stored = clampLight(byId('int_01_hoverJet'), { ...LIGHT, tint: [v / 255, 0, 1] })
      expect(Math.round(stored.tint[0] * 255)).toBe(v)
    }
  })
})

describe('DEV-476 — the angles', () => {
  it("reads every shipped sun's elevation as the extractor wrote it, and rebuilds its direction", () => {
    for (const l of shipped) {
      const sun = l.lighting.sun
      if (!sun) continue
      const a = sunAnglesOf(sun.direction)
      // The extractor's own field: an outside witness to the convention.
      expect(Math.abs(a.elevation - sun.elevationDeg), l.id).toBeLessThan(0.01)
      // To a ten-thousandth of a degree: the stored vectors are float32-ish unit vectors.
      expect(angleBetween(sunTravelOf(a.azimuth, a.elevation), sun.direction), l.id).toBeLessThan(
        1e-4,
      )
    }
  })

  it("puts the sun AT its azimuth in the start pad's heading convention", () => {
    for (const az of [-180, -135, -90, -30, 0, 45, 90, 179.9]) {
      const t = towardSunOf(az, 20)
      const f = yawForward(az)
      // The horizontal part of "toward the sun" is the pad's nose at that yaw.
      expect(angleBetween([t[0], 0, t[2]], [f.x, 0, f.z]), String(az)).toBeLessThan(1e-9)
      expect(t[1]).toBeCloseTo(Math.sin(20 * DEG), 12)
      // And the light travels the other way.
      expect(angleBetween(sunTravelOf(az, 20), [-t[0], -t[1], -t[2]])).toBeLessThan(1e-9)
    }
  })

  it('wraps an azimuth to [-180, 180) on the grid', () => {
    expect(normaliseAzimuth(180)).toBe(-180)
    expect(normaliseAzimuth(179.96)).toBe(-180)
    expect(normaliseAzimuth(-190)).toBe(170)
    expect(normaliseAzimuth(540.04)).toBe(-180)
    expect(Object.is(normaliseAzimuth(-0.01), -0)).toBe(false)
  })
})

describe('DEV-476 — an absent light is the build before it, byte for byte', () => {
  it('covers every HoverJet sky', () => {
    expect(fixture.courses.map((e) => e.donor).sort()).toEqual(hoverjets.map((l) => l.id).sort())
  })

  for (const e of fixture.courses) {
    it(`${e.donor}: the same id, and the same level bytes`, () => {
      const donor = byId(e.donor)
      const course = courseOf(e)
      expect('light' in course).toBe(false)
      const checked = validatePlayerCourse(course, donor)
      expect(checked.ok).toBe(true)
      if (!checked.ok) return
      expect('light' in checked.course).toBe(false)
      expect(canonicalPlayerCourse(checked.course)).not.toContain('light')
      expect(playerCourseId(checked.course)).toBe(e.id)
      const level = expandPlayerCourse(checked.course, donor)
      expect(JSON.stringify(level).length).toBe(e.levelBytes)
      expect(bytesSha(level)).toBe(e.levelSha256)
    })
  }
})

describe("DEV-476 — the expansion's sun is the sliders' sun", () => {
  for (const e of fixture.courses) {
    it(`${e.donor}: lighting.sun moves, and nothing else in the level does`, () => {
      const donor = byId(e.donor)
      const plain = courseOf(e)
      const lit: PlayerCourse = { ...plain, light: LIGHT }
      const before = expandPlayerCourse(plain, donor)
      const after = expandPlayerCourse(lit, donor)
      const want = clampSunToSky(donor, LIGHT.sunAzimuth, LIGHT.sunElevation)
      const sun = after.lighting.sun
      if (!sun) throw new Error('no sun')
      // Its direction, as a geometry: the angle to the travel the sliders make.
      expect(angleBetween(sun.direction, sunTravelOf(want.azimuth, want.elevation))).toBeLessThan(
        1e-9,
      )
      expect(sun.elevationDeg).toBe(want.elevation)
      // Read back through the level's own field, independently of the module.
      const toward = [-sun.direction[0], -sun.direction[1], -sun.direction[2]]
      expect(Math.asin(toward[1] as number) / DEG).toBeCloseTo(want.elevation, 9)
      // The donor's colour, intensity and shadows ride along unchanged.
      const own = donor.lighting.sun
      expect(sun.colorLinear).toEqual(own?.colorLinear)
      expect(sun.intensity).toBe(own?.intensity)
      expect(sun.shadows).toBe(own?.shadows)
      // Everything but the sun, the id and the seed is the unlit level's.
      const strip = (l: Level) => ({
        ...l,
        id: '',
        generated: null,
        lighting: { ...l.lighting, sun: null },
      })
      expect(JSON.stringify(strip(after))).toBe(JSON.stringify(strip(before)))
      expect(after.id).not.toBe(before.id)
      // And the tint is not a level fact: it never reaches the Level.
      expect(JSON.stringify(after)).not.toContain('tint')
    })
  }

  it('is the donor itself (the same object) when there is no light', () => {
    const d = byId('int_01_hoverJet')
    expect(playerCourseSun(d, undefined)).toBe(d.lighting.sun)
  })
})

describe('DEV-476 — the format', () => {
  const e = fixture.courses.find((c) => c.donor === 'int_01_hoverJet') as Entry
  const base = courseOf(e)

  it('writes light LAST, on its grid, and reads back to the same bytes', () => {
    const noisy: PlayerCourse = {
      ...base,
      light: {
        sunAzimuth: 200.04,
        sunElevation: 12.3456,
        tint: [0.12345, 1, 0],
        tintAmount: 0.333,
      },
    }
    const canonical = canonicalPlayerCourse(noisy)
    const keys = Object.keys(JSON.parse(canonical) as object)
    expect(keys[keys.length - 1]).toBe('light')
    const parsed = JSON.parse(canonical) as { light: PlayerCourseLight }
    expect(parsed.light).toEqual({
      sunAzimuth: -160,
      sunElevation: 12.3,
      tint: [0.123, 1, 0],
      tintAmount: 0.33,
    })
    const back = validatePlayerCourse(JSON.parse(canonical))
    expect(back.ok).toBe(true)
    if (back.ok) expect(canonicalPlayerCourse(back.course)).toBe(canonical)
    // A light is part of what a course IS: it changes the id.
    expect(playerCourseId(noisy)).not.toBe(playerCourseId(base))
  })

  it('refuses a light that is not one', () => {
    const bad = (light: unknown): string[] => {
      const r = validatePlayerCourse({ ...base, light })
      return r.ok ? [] : r.errors.map(([p]) => p)
    }
    expect(bad('noon')).toContain('light')
    expect(bad({ ...LIGHT, extra: 1 }).some((p) => p.startsWith('light.'))).toBe(true)
    expect(bad({ ...LIGHT, sunAzimuth: 181 })).toContain('light.sunAzimuth')
    expect(bad({ ...LIGHT, sunElevation: -1 })).toContain('light.sunElevation')
    expect(bad({ ...LIGHT, sunElevation: 91 })).toContain('light.sunElevation')
    expect(bad({ ...LIGHT, tint: [1, 1] })).toContain('light.tint')
    expect(bad({ ...LIGHT, tint: [1, 1, 2] })).toContain('light.tint')
    expect(bad({ ...LIGHT, tintAmount: Number.NaN })).toContain('light.tintAmount')
    const { tintAmount: _, ...short } = LIGHT
    expect(bad(short)).toContain('light.tintAmount')
  })

  it('refuses a light on a v1 course, which never had one', () => {
    const v1 = {
      ...base,
      v: 1,
      start: { t: 0 },
      light: LIGHT,
    }
    const r = validatePlayerCourse(v1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map(([p]) => p)).toContain('light')
  })
})

describe("DEV-476 — the sky's band", () => {
  it('lets a gradient sky turn the sun all the way round, between the floor and overhead', () => {
    expect(gradient.length).toBeGreaterThan(0)
    for (const l of gradient) {
      expect(skyAgreementAt(l, 0, 10)).toBeNull()
      for (const az of [-180, -91.3, 0, 45.6, 179.9]) {
        expect(clampSunToSky(l, az, 30)).toEqual({ azimuth: az, elevation: 30, held: false })
      }
      expect(clampSunToSky(l, 10, 0).elevation).toBe(SUN_ELEVATION_FLOOR)
      expect(clampSunToSky(l, 10, 90)).toEqual({ azimuth: 10, elevation: 90, held: false })
    }
  })

  it("agrees with every decoded sky's own 2016 sun", () => {
    expect(decoded.map((l) => l.id).sort()).toEqual([
      'adv_02_hoverJet',
      'hoverJet_kauai_beg',
      'int_01_hoverJet',
    ])
    for (const l of decoded) {
      const own = sunAnglesOf(l.lighting.sun?.direction as number[])
      expect(skyAgreementAt(l, own.azimuth, own.elevation), l.id).toBeGreaterThan(1)
      // So the sky's own light, as a course's, is 2016's sun, unmoved.
      const s = skyLight(l)
      expect(
        angleBetween(
          sunTravelOf(s.sunAzimuth, s.sunElevation),
          l.lighting.sun?.direction as number[],
        ),
      ).toBeLessThan(0.1)
    }
  })

  it("measures SkyJ's band: 58° one way round the horizon, 198° the other, 58° up", () => {
    const l = byId('int_01_hoverJet')
    const own = sunAnglesOf(l.lighting.sun?.direction as number[])
    const walk = (sign: 1 | -1): number => {
      let reach = 0
      for (let d = 0; d < 360; d += 0.1) {
        if ((skyAgreementAt(l, own.azimuth + sign * d, own.elevation) as number) < 1) break
        reach = d
      }
      return reach
    }
    // The header's three numbers, measured, to half a degree.
    expect(Math.abs(walk(-1) - 58.4)).toBeLessThan(0.5)
    expect(Math.abs(walk(1) - 197.6)).toBeLessThan(0.5)
    let up = 0
    for (let e = 0; e <= 90; e += 0.1)
      if ((skyAgreementAt(l, own.azimuth, e) as number) >= 1) up = e
    expect(Math.abs(up - 58.3)).toBeLessThan(0.5)
    // And the zenith is darker than the mean, from every heading.
    expect(skyAgreementAt(l, 0, 90) as number).toBeLessThan(1)
  })

  it('moves a sun out of the dark sector to the NEAREST direction the sky agrees with', () => {
    const l = byId('int_01_hoverJet')
    const own = sunAnglesOf(l.lighting.sun?.direction as number[])
    for (const [da, e] of [
      [-110, 4],
      [-100, 30],
      [-80, 10],
      [0, 90],
    ] as const) {
      const asked = { azimuth: own.azimuth + da, elevation: e }
      expect(skyAgreementAt(l, asked.azimuth, asked.elevation) as number).toBeLessThan(1)
      const c = clampSunToSky(l, asked.azimuth, asked.elevation)
      expect(c.held).toBe(true)
      expect(skyAgreementAt(l, c.azimuth, c.elevation) as number).toBeGreaterThanOrEqual(1)
      // Nearest: no agreeing direction on a half-degree sweep is closer.
      const moved = angleBetween(
        towardSunOf(c.azimuth, c.elevation),
        towardSunOf(asked.azimuth, asked.elevation),
      )
      for (let a = -180; a < 180; a += 0.5) {
        for (let el = SUN_ELEVATION_FLOOR; el <= 90; el += 0.5) {
          if ((skyAgreementAt(l, a, el) as number) < 1) continue
          const d = angleBetween(towardSunOf(a, el), towardSunOf(asked.azimuth, asked.elevation))
          expect(d).toBeGreaterThan(moved - 0.2)
        }
      }
      // And a clamped light clamps to itself.
      expect(clampSunToSky(l, c.azimuth, c.elevation)).toEqual({ ...c, held: false })
    }
  })

  it('clamps a hand-written light in the expansion rather than refusing it', () => {
    const e = fixture.courses.find((c) => c.donor === 'int_01_hoverJet') as Entry
    const donor = byId('int_01_hoverJet')
    const own = sunAnglesOf(donor.lighting.sun?.direction as number[])
    const dark: PlayerCourse = {
      ...courseOf(e),
      light: { ...LIGHT, sunAzimuth: normaliseAzimuth(own.azimuth - 110), sunElevation: 4 },
    }
    expect(validatePlayerCourse(dark, donor).ok).toBe(true)
    const sun = expandPlayerCourse(dark, donor).lighting.sun
    const a = sunAnglesOf(sun?.direction as number[])
    expect(skyAgreementAt(donor, a.azimuth, a.elevation) as number).toBeGreaterThanOrEqual(1)
  })
})
