// tests/unit/ambient-traffic-content.test.ts — DEV-146's CONTENT, checked
// against the generated tree rather than against the code that wrote it.
//
// `validateLevel` sees one level and can only ask whether the field is
// well-formed. The three claims that make ambient traffic a feature rather than
// three ships over open sea are all CROSS-FILE, so they live here:
//
//   · the donor mission exists;
//   · it is over the same island;
//   · its racing line actually passes NEAR where this mission is played.
//
// The third one is the one that matters and the one nothing else asserts. The
// pairing was chosen on a measurement — median 452 m from this mission's own
// anchors to `int_01_hoverJet`'s route, against 853 m for the pairing that was
// rejected — and DEV-027 is the standing reminder that a number computed in a
// scratch script and then quoted in a comment is a number with no provenance.
// So it is recomputed here, from the shipped JSON, every run.
//
// The last `it` is the LOUD COUNTERPART: a suite that checks "every level with
// traffic is coherent" passes perfectly on a tree where the table has silently
// emptied and no level has any.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AMBIENT_TRAFFIC_MAX, type Level } from '@/content/level-schema'

const DIR = 'content/levels'

const levels: Level[] = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Level)

const byId = new Map(levels.map((l) => [l.id, l]))
const withTraffic = levels.filter((l) => l.ambientTraffic)

/**
 * Every place the player will be on this course: the spawn, the pads, the orbs,
 * the rings and the finish. All of them in the level's own THREE space.
 *
 * Not the boundary sphere and not the terrain: this is "where the mission is
 * played", and a mission is played at its collectibles.
 */
const anchorsOf = (level: Level): number[][] => {
  const out: number[][] = [level.spawn.pos as number[]]
  for (const p of level.pads ?? []) out.push(p.pos as unknown as number[])
  for (const o of level.orbs ?? []) out.push((o as { pos: number[] }).pos)
  for (const r of level.routes ?? []) for (const ring of r.rings) out.push(ring.pos as number[])
  if (level.finish) out.push(level.finish.pos as number[])
  return out
}

/**
 * Metres from each anchor to the nearest POINT of the donor's route polyline.
 *
 * To a point, not to the line — and that is the DEV-027 sentence written into
 * the test rather than into a comment somewhere else. The polyline's spacing is
 * about 27 m, so every figure below is an UPPER BOUND on the distance to the
 * line by at most half a segment. An upper bound is the safe direction here:
 * the claim being made is "the traffic comes close", so over-stating the
 * distance can only make the test harder to pass.
 */
const anchorDistances = (level: Level, donor: Level): number[] => {
  const route = (donor as unknown as { route: number[][] | null }).route ?? []
  return anchorsOf(level).map((a) => {
    let best = Number.POSITIVE_INFINITY
    for (const q of route) {
      const dx = (a[0] as number) - (q[0] as number)
      const dy = (a[1] as number) - (q[1] as number)
      const dz = (a[2] as number) - (q[2] as number)
      const d = Math.hypot(dx, dy, dz)
      if (d < best) best = d
    }
    return best
  })
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] as number
}

describe('ambient traffic content (DEV-146)', () => {
  it('names a donor that exists, over the same island, with a line to fly', () => {
    for (const level of withTraffic) {
      const traffic = level.ambientTraffic as NonNullable<Level['ambientTraffic']>
      const donor = byId.get(traffic.mission)
      expect(donor, `${level.id} borrows "${traffic.mission}"`).toBeDefined()
      const d = donor as Level
      expect(d.environment, `${level.id} -> ${d.id}`).toBe(level.environment)
      expect(d.id).not.toBe(level.id)
      const route = (d as unknown as { route: number[][] | null }).route
      expect(route, `${d.id} has no authored route`).toBeTruthy()
      expect((route as number[][]).length).toBeGreaterThan(1)
      expect(traffic.count).toBeGreaterThanOrEqual(1)
      expect(traffic.count).toBeLessThanOrEqual(AMBIENT_TRAFFIC_MAX)
    }
  })

  it('the donor line passes near where the mission is actually played', () => {
    // The claim the pairing was chosen on. Recomputed from the shipped JSON,
    // with the figures printed so a failure says how far it moved rather than
    // just that it did.
    for (const level of withTraffic) {
      const traffic = level.ambientTraffic as NonNullable<Level['ambientTraffic']>
      const donor = byId.get(traffic.mission) as Level
      const d = anchorDistances(level, donor)
      const min = Math.min(...d)
      const med = median(d)
      const where = `${level.id} <- ${donor.id}: ${d.length} anchors, min ${min.toFixed(0)} m, median ${med.toFixed(0)} m, max ${Math.max(...d).toFixed(0)} m`
      // 300 m: the line comes at least this close to SOMETHING the player is
      // sent to, so the traffic passes rather than orbits the far side.
      expect(min, where).toBeLessThan(300)
      // 600 m: and it is not a one-off. A 6 m hull at 600 m is about 10-14
      // pixels on a Quest 3 (6/600 rad at 20-25 px/degree) — small, but well
      // clear of DEV-044's "four pixels across, therefore rendered rather than
      // seen". The rejected pairing (rookie_02_jumpSeat) is at 853 m.
      expect(med, where).toBeLessThan(600)
    }
  })

  it('every other mission has none, and says so with a null rather than a hole', () => {
    for (const level of levels) {
      expect(
        Object.hasOwn(level as unknown as Record<string, unknown>, 'ambientTraffic'),
        `${level.id} is missing the key entirely`,
      ).toBe(true)
      if (!withTraffic.includes(level)) expect(level.ambientTraffic).toBeNull()
    }
  })

  it('AT LEAST ONE mission has traffic — the loud counterpart', () => {
    // Without this, an extractor table that silently emptied would leave every
    // assertion above vacuously green and the feature quietly gone. Named
    // rather than counted: the count is Matt's to change, the existence is not
    // something to lose by accident.
    expect(withTraffic.map((l) => l.id)).toContain('int_01_jumpSeat')
  })
})
