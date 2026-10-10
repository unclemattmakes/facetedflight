// tests/unit/lap-courses.test.ts — the lap server's courses, regenerated and compared.
// DEV-372, `docs/plan/PLAYER-GHOSTS.md` §5; hard rule 3.
//
// `content/lap-courses.json` is what the Function scores a lap against. It is
// generated from the level, edition and aircraft files and the constants sheet
// by `src/net/lap-courses-build.ts`, and this file is the guard that makes
// "generated" true: it builds the artefact again and compares the BYTES with
// the committed ones. Anything that moves a gate, a finish, a release point, a
// speed constant, an aircraft variant or an edition's gameplay without
// rebuilding goes red here.
//
// `LAP_COURSES_WRITE=1` writes the bytes first; `node tools/net/write-lap-courses.mjs`
// is that, and the only way the file should ever change.
//
// The other assertions check the artefact against things OUTSIDE the builder
// (trap 24): the renderer's own THREE->SIM flip, the HUD's full-scale speed
// literal, the 21 rings `course-gate-count.test.ts` holds `int_01` to, and the
// aircraft file's own list of variants.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Aircraft } from '@/content/aircraft-schema'
import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { generatedLevelIds, loadLevel } from '@/content/load-level'
import { racerStarts } from '@/game/racer-grid'
import {
  LAP_COURSES,
  LAP_MODE,
  type LapCourse,
  lapCourse,
  lapRules,
  lapVariantRules,
} from '@/net/lap-courses'
import { buildLapCourses, rulesVersion, serialiseLapCourses } from '@/net/lap-courses-build'
import { threeTupleToUnity } from '@/render/unity-space'
import { terminalSpeed } from '@/sim/speed-chain'
import hoverjetJson from '../../content/aircraft/hoverjet.json'
import jumpseatJson from '../../content/aircraft/jumpseat.json'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import { FIXTURE_SPEED_SCALE, FIXTURE_VARIANT, variantCourses } from './helpers/lap-variant-courses'
import { REPO as ROOT } from './helpers/repo-root'

const FILE = path.join(ROOT, 'content', 'lap-courses.json')
const EDITIONS = [anniversaryJson, classicJson] as unknown as Edition[]
const AIRCRAFT = [hoverjetJson, jumpseatJson] as unknown as Aircraft[]
const INT01 = 'int_01_hoverJet'

/** Every shipped level, through the game's own loader. Built once, on first use. */
let levels: Level[] | null = null
const allLevels = async (): Promise<Level[]> => {
  levels ??= await Promise.all(generatedLevelIds().map((id) => loadLevel(id)))
  return levels
}

describe('content/lap-courses.json', () => {
  it('regenerates byte-identical', async () => {
    const built = serialiseLapCourses(buildLapCourses(await allLevels(), EDITIONS, AIRCRAFT))
    if (process.env.LAP_COURSES_WRITE === '1') fs.writeFileSync(FILE, built)
    const committed = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n')
    // Not `toBe` on 150 KB of JSON: the first differing line is the useful part.
    if (committed !== built) {
      const a = committed.split('\n')
      const b = built.split('\n')
      const at = a.findIndex((line, i) => line !== b[i])
      expect.fail(
        `content/lap-courses.json is stale at line ${at + 1}:\n  committed: ${a[at]}\n  built:     ${b[at]}\n` +
          'Rebuild with `node tools/net/write-lap-courses.mjs` and commit it.',
      )
    }
  })

  it('judges the Ring Attack HoverJet courses, and int_01 has its 21 rings', async () => {
    const ids = Object.keys(LAP_COURSES.courses)
    expect(ids).toContain(INT01)
    expect(lapCourse(INT01)?.gates).toHaveLength(21)
    // Kauai is int_01 authored again with the mode FORCED to Free Flight: a
    // course with rings and no race, so no board.
    expect(ids).not.toContain('hoverJet_kauai_beg')
    // JumpSeat missions are Target Practice: pads, not rings.
    expect(ids.some((id) => id.endsWith('_jumpSeat'))).toBe(false)
    for (const id of ids) {
      const c = lapCourse(id)
      expect(c?.mode).toBe(LAP_MODE)
      expect(c?.finish).not.toBeNull()
    }
  })

  it('puts the release where the game holds the ship: spawn, raised by the lift, flipped to SIM', async () => {
    const level = (await allLevels()).find((l) => l.id === INT01) as Level
    const sim = threeTupleToUnity({ x: 0, y: 0, z: 0 }, level.spawn.pos as number[])
    sim.y += level.spawn.launch?.rise ?? 0
    expect(lapCourse(INT01)?.release).toEqual([sim.x, sim.y, sim.z])
  })

  it("carries the standard HoverJet's own ceiling: the HUD's full-scale speed at 21 rings", () => {
    // `render/hud-gauges.ts` pins the full-scale speed as a LITERAL,
    // 339.79 m/s, which `hud-gauges.test.ts` holds to terminalSpeed(437.5 + 18
    // x 21, 2, 4, 1.2). The standard variant's numbers must reproduce it, on
    // both editions.
    for (const edition of ['anniversary', 'classic']) {
      const c = lapVariantRules(INT01, edition, 'standard')?.ceiling
      if (!c) throw new Error(`no standard ceiling on ${edition}`)
      expect(terminalSpeed(c.maxSpeed + c.increment * 21, c.boostMultiplier, c.mass, c.drag)).toBe(
        339.7916666666667,
      )
    }
  })

  it('keys a board per edition, with crash resets only where the edition has them', () => {
    const anniversary = lapRules(INT01, 'anniversary', 'standard')
    const classic = lapRules(INT01, 'classic', 'standard')
    expect(anniversary).toMatch(/^\d+\.[0-9a-f]{8}$/)
    expect(classic).toMatch(/^\d+\.[0-9a-f]{8}$/)
    expect(anniversary).not.toBe(classic)
    expect(lapCourse(INT01)?.editions.anniversary?.crash.enabled).toBe(true)
    expect(lapCourse(INT01)?.editions.classic?.crash.enabled).toBe(false)
    expect(lapRules(INT01, 'nonsense', 'standard')).toBeNull()
    expect(lapRules('no_such_mission', 'anniversary', 'standard')).toBeNull()
    expect(lapRules(INT01, 'anniversary', 'no-such-variant')).toBeNull()
  })

  it("keys a board per aircraft VARIANT: Anniversary flies the aircraft file's list, Classic standard alone", () => {
    const listed = (hoverjetJson as unknown as Aircraft).variants.map((v) => v.id)
    for (const course of Object.values(LAP_COURSES.courses) as LapCourse[]) {
      expect(Object.keys(course.editions.anniversary?.variants ?? {})).toEqual(listed)
      expect(Object.keys(course.editions.classic?.variants ?? {})).toEqual(['standard'])
    }
  })

  it('gives a variant its own ceiling and its own rules, and Classic never gets one', () => {
    // The committed aircraft file holds `standard` alone (DEV-381 adds the
    // others), so this builds the same artefact with one fixture variant.
    const courses = variantCourses()
    const standard = lapVariantRules(INT01, 'anniversary', 'standard', courses)
    const fixture = lapVariantRules(INT01, 'anniversary', FIXTURE_VARIANT, courses)
    if (!standard || !fixture) throw new Error('missing a variant board')
    expect(fixture.ceiling.maxSpeed).toBe(standard.ceiling.maxSpeed * FIXTURE_SPEED_SCALE)
    expect(fixture.ceiling.increment).toBe(standard.ceiling.increment)
    expect(fixture.rules).not.toBe(standard.rules)
    // Standard's board is unmoved by another variant existing beside it.
    expect(standard.rules).toBe(lapRules(INT01, 'anniversary', 'standard'))
    expect(lapVariantRules(INT01, 'classic', FIXTURE_VARIANT, courses)).toBeNull()
  })

  it('changes the rules version with a gameplay NUMBER, a variant scale or a gate, and not with a note', () => {
    // The hashed body is the course minus its editions, which the builder adds
    // AFTER hashing (DEV-477's room starts among them).
    const { editions: _drop, ...body } = lapCourse(INT01) as LapCourse
    const gameplay = (anniversaryJson as unknown as Edition).gameplay
    const ceiling = lapVariantRules(INT01, 'anniversary', 'standard')?.ceiling
    if (!ceiling) throw new Error('no ceiling')
    const variant = { id: 'standard', scale: {}, ceiling }
    const base = rulesVersion(body, variant, gameplay)
    expect(base).toBe(lapRules(INT01, 'anniversary', 'standard'))
    const renoted = structuredClone(gameplay) as unknown as { crash: { note: string } }
    renoted.crash.note = 'reworded'
    expect(rulesVersion(body, variant, renoted)).toBe(base)
    const retuned = structuredClone(gameplay) as unknown as { crash: { resetBackMetres: number } }
    retuned.crash.resetBackMetres += 1
    expect(rulesVersion(body, variant, retuned)).not.toBe(base)
    expect(rulesVersion(body, { ...variant, scale: { 'ship.rollRate': 1.1 } }, gameplay)).not.toBe(
      base,
    )
    // And a course change: one gate a millimetre over.
    const moved = structuredClone(body)
    const centre = moved.gates[0]?.centre as unknown as number[]
    centre[0] = (centre[0] as number) + 0.001
    expect(rulesVersion(moved, variant, gameplay)).not.toBe(base)
  })

  it('does NOT change with the rooms block: a room lap is off every solo board (DEV-389)', () => {
    const { editions: _drop, ...body } = lapCourse(INT01) as LapCourse
    const gameplay = (anniversaryJson as unknown as Edition).gameplay
    const ceiling = lapVariantRules(INT01, 'anniversary', 'standard')?.ceiling
    if (!ceiling) throw new Error('no ceiling')
    const variant = { id: 'standard', scale: {}, ceiling }
    const base = rulesVersion(body, variant, gameplay)
    const off = structuredClone(gameplay) as unknown as { rooms: { enabled: boolean } }
    off.rooms.enabled = false
    expect(rulesVersion(body, variant, off)).toBe(base)
  })

  it("carries a room's starts where the GAME stands its ships: the release first, flipped to SIM (DEV-477)", async () => {
    // The room judge's list against the renderer's own THREE->SIM flip, which
    // the builder does not use: entry 0 is the release point this file already
    // holds, and entries 1 on are the racers' own starts, the pads and slots
    // single player spawns from. Anniversary races rooms; Classic has none.
    const level = (await allLevels()).find((l) => l.id === INT01) as Level
    const course = lapCourse(INT01) as LapCourse
    const starts = course.editions.anniversary?.rooms?.starts ?? []
    expect(starts[0]).toEqual(course.release)
    const racers = racerStarts(level, (anniversaryJson as unknown as Edition).gameplay.racers)
    expect(starts).toHaveLength(racers.length + 1)
    racers.forEach((s, i) => {
      const sim = threeTupleToUnity({ x: 0, y: 0, z: 0 }, [...s.pos])
      expect(starts[i + 1], `start ${i + 1}`).toEqual([sim.x, sim.y, sim.z])
    })
    for (const c of Object.values(LAP_COURSES.courses) as LapCourse[]) {
      expect(c.editions.anniversary?.rooms?.starts.length, c.mission).toBe(6)
      expect(c.editions.classic?.rooms, c.mission).toBeUndefined()
    }
  })
})
