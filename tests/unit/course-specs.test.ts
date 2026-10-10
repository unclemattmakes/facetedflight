// tests/unit/course-specs.test.ts — what a level asks of the run around it
// (APP-SPLIT 2.2). `game/course-specs.ts` lifted these out of `boot/app.ts`,
// where a mission swap called them and nothing else could.
//
// Checked against facts that come from OUTSIDE this code wherever there is
// one: CLAUDE.md's census of the shipped boundaries (disabled in 6 of 13,
// `resetDelay` 13 s in every one), and the level JSON itself.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { boundarySpecOf, crashLineOf, guideFor, launchSpecOf } from '@/game/course-specs'
import { startMission } from '@/game/mission'
import { hoverJetView } from '@/sim/hoverjet'
import { levelJson as level } from './helpers/content'

const LEVELS = path.join(process.cwd(), 'content', 'levels')
const shipped = (): Level[] =>
  fs
    .readdirSync(LEVELS)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(LEVELS, f), 'utf8')) as Level)

describe('boundarySpecOf', () => {
  it('builds a spec for every shipped mission, disabled in exactly six (CLAUDE.md)', () => {
    const all = shipped()
    expect(all).toHaveLength(13)
    const specs = all.map((l) => boundarySpecOf(l))
    expect(specs.every((s) => s !== null)).toBe(true)
    expect(specs.filter((s) => s?.enabled === false)).toHaveLength(6)
  })

  it("carries 2016's 13 s reset, not the C# initialiser's 10, on every mission", () => {
    for (const l of shipped()) expect(boundarySpecOf(l)?.resetDelaySeconds, l.id).toBe(13)
  })

  it('is null where the level has no volume, with no fallback sphere', () => {
    const l = level('int_01_hoverJet')
    expect(boundarySpecOf({ ...l, boundary: { ...l.boundary, volume: null } } as Level)).toBeNull()
  })
})

describe('launchSpecOf', () => {
  it("is the level's own lift and countdown, with the ride as asked", () => {
    const l = level('int_01_hoverJet')
    const spec = launchSpecOf(l, false)
    expect(spec?.keys).toBe(l.spawn.launch?.keys)
    expect(spec?.releaseAtSeconds).toBe(l.spawn.launch?.releaseAtSeconds)
    expect(spec?.countdownSteps).toBe(3)
    expect(spec?.countdownStepSeconds).toBe(1)
    expect(spec?.skipRide).toBe(false)
    expect(launchSpecOf(l, true)?.skipRide).toBe(true)
  })

  it('is null for a mission with no lift', () => {
    const l = level('adv_01_jumpSeat')
    expect(l.spawn.launch, 'the premise: this mission has no lift').toBeFalsy()
    expect(launchSpecOf(l, false)).toBeNull()
  })
})

describe('guideFor and crashLineOf', () => {
  const l = level('int_01_hoverJet')
  const mission = startMission(l)

  it('has no guide without a line to follow', () => {
    expect(guideFor(null, mission, undefined, 162)).toBeNull()
    expect(guideFor([[0, 0, 0]], mission, undefined, 162)).toBeNull()
  })

  it('places every gate on the line, in course order, and profiles it for the jet', () => {
    const sheet = hoverJetView({})
    const guide = guideFor(l.route ?? null, mission, sheet, 162)
    expect(guide).not.toBeNull()
    const arcs = guide?.gateArc ?? []
    expect(arcs).toHaveLength(mission.course.gates.length)
    for (let i = 1; i < arcs.length; i++) {
      expect(arcs[i] as number, `gate ${i} after gate ${i - 1}`).toBeGreaterThanOrEqual(
        arcs[i - 1] as number,
      )
    }
    expect(guide?.profiledFor).toBe(sheet)
    expect(guide?.route.speedLimit, 'the velocity profile is on the line').not.toBeNull()
  })

  it("puts a crash back on the guide's own line when there is one", () => {
    const guide = guideFor(l.route ?? null, mission, undefined, 162)
    const line = crashLineOf(guide, l, mission.course.gates)
    expect(line.route).toBe(guide?.route)
    expect(line.gateArc).toBe(guide?.gateArc)
  })

  it('without one, runs from the release point (spawn + rise, z mirrored) through every gate', () => {
    const line = crashLineOf(null, l, mission.course.gates)
    const pos = l.spawn.pos as number[]
    expect(line.route.points[0]).toBeCloseTo(pos[0] as number, 2)
    expect(line.route.points[1]).toBeCloseTo((pos[1] as number) + (l.spawn.launch?.rise ?? 0), 2)
    expect(line.route.points[2]).toBeCloseTo(-(pos[2] as number), 2)
    expect(line.gateArc).toHaveLength(mission.course.gates.length)
    for (let i = 0; i < line.gateArc.length; i++) {
      expect(line.gateArc[i] as number, `gate ${i} is past the start`).toBeGreaterThan(0)
    }
  })
})
