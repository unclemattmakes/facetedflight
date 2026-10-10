// tests/unit/mission-shape.test.ts — the course on the table is the real course.
//
// A holotable's diorama is the level's own height field at 1:6600, with the
// level's own racing line flown over it. It cannot drift from the mission,
// because there is nothing to keep in sync — as long as the ISLAND is placed
// where the course thinks it is. Get that wrong by a constant and the craft
// flies off the coast, which reads as an extraction bug and is a placement bug.
//
// ── Why this test exists at all ──────────────────────────────────────────
//
// `mission-shape.ts` writes the placement rule (`local + envRoot + worldOffset`)
// a SECOND time, because `load-terrain.ts` keeps its copy behind a private
// `terrainEntry` and this agent may not edit that file. Orientation lesson §5:
// *two constants that must stay equal should be the same object* — `game/ghosts.ts`
// held a verbatim copy of the ship's art constants, the ship's yaw was corrected,
// the copy was not, and every ghost flew backwards from that commit onward.
//
// It cannot be the same object here, so it gets the other half of the bargain.
// The oracle is not `load-terrain.ts` — copying a rule and then asserting it
// against itself proves nothing — it is the world positions
// `terrain-env-root.test.ts` measured through the SCENE FLATTENER, a third code
// path that resolves the whole parent chain. Including kauai, the environment
// where the naive rule is wrong by 2.2 km and where "checked" was true
// everywhere anyone had looked (DEV-042, the agreement lesson).

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { levelIds, loadLevel } from '@/content/load-level'
import { missionPad, missionTour, terrainOriginSim } from '@/game/mission-shape'
import { runningMode, scores } from '@/game/modes'
import { environmentTerrains } from '@/game/terrain/load-terrain'
import { REPO as ROOT } from './helpers/repo-root'

/**
 * Measured through `tools/prototype/unity_scene_to_json.js`, the scene
 * flattener — see `tests/unit/terrain-env-root.test.ts`, which is where these
 * numbers are established and argued. Unity (sim) space.
 */
const MEASURED: Record<string, readonly [number, number, number]> = {
  'alpine.forest': [-2157.919624, 15.881851, -1867.14154],
  'desert.canyon': [-2157.919624, 15.881851, -1867.14154],
  'kauai.terrain': [-4266, 68, -3739],
  'simonet.islands': [-2157.91968, -81.69, -1867.1416],
}

/** Every shipped level's `worldOffset`, THREE space, as the JSON stores it. */
const WORLD_OFFSET_THREE = [-2048, 0, 2048] as const

describe('a diorama stands its island where the gates think it is', () => {
  it('reproduces four independently measured world positions', () => {
    for (const [key, world] of Object.entries(MEASURED)) {
      const origin = terrainOriginSim(key, WORLD_OFFSET_THREE).position
      for (let i = 0; i < 3; i++) {
        expect(origin[i] as number, `${key} axis ${'xyz'[i]}`).toBeCloseTo(world[i] as number, 3)
      }
    }
  })

  it('gets KAUAI right, which is the case the naive rule fails', () => {
    // Said on its own because the loop above passes on three environments with
    // `envRoot` dropped entirely. Simonet was the only environment this port
    // had ever loaded, and one island silently underwrote the whole
    // world-placement layer.
    const naive = terrainOriginSim('simonet.islands', WORLD_OFFSET_THREE).position
    const kauai = terrainOriginSim('kauai.terrain', WORLD_OFFSET_THREE).position
    expect(Math.hypot(kauai[0] - naive[0], kauai[2] - naive[2])).toBeGreaterThan(2000)
  })

  it('moves the island when the level moves, and in the right direction in z', () => {
    // The z term SUBTRACTS the world offset where x and y add it, because the
    // level JSON stores the offset in three space and a height field is sim
    // space. Leaving the flip out puts the collision surface 4 km from the
    // terrain you can see, and the ship sails through the island.
    const a = terrainOriginSim('simonet.islands', [0, 0, 0]).position
    const b = terrainOriginSim('simonet.islands', [100, 0, 100]).position
    expect(b[0] - (a[0] as number)).toBeCloseTo(100, 6)
    expect(b[2] - (a[2] as number)).toBeCloseTo(-100, 6)
  })

  it('names the terrain and the file to fix when an environment is unknown', () => {
    expect(() => terrainOriginSim('atlantis.reef', WORLD_OFFSET_THREE)).toThrow(/unknown terrain/)
  })
})

/* ═══ the craft's tour: the pads only where the pads are the point (DEV-354) ═══
 *
 * `missionTour` was `missionMarks` until DEV-354 and handed over the objective's
 * gates, pads and orbs for the table to draw. Matt, 2026-09-24: *"level select -
 * show terrain diorama, no gates."* Nothing on a level table is drawn from it
 * now, so the sweeps that counted gates and orbs on a table went with them.
 * What survives is the one judgement a table still uses — which missions' craft
 * lob pad to pad — and it still turns on all three kinds, because a Ring Attack
 * mission keeps its pads LIVE and must not tour them.
 */
describe('a table’s craft tours the pads only where the pads are the point', () => {
  it('keeps every ring-scoring mission’s craft on its racing line', async () => {
    // `ringAttack` keeps `padZone` live (`MODES.live`), so a rule of "tour the
    // live pads" would put a JumpSeat's lob on a HoverJet race wherever a Ring
    // Attack scene carries pads. It is the RING count that decides.
    let checked = 0
    for (const id of await levelIds()) {
      const level = await loadLevel(id)
      if (!scores(runningMode(level), 'ring')) continue
      checked++
      expect(missionTour(level).pads, `${id} tours pads it is not scored on`).toHaveLength(0)
    }
    expect(checked, 'no shipped mission scores rings — the sweep is vacuous').toBeGreaterThan(0)
  })

  it('falls back to a live landmark where the mode’s objective is EMPTY', async () => {
    // `int_02_jumpSeat` used to be this case in the shipped content: Free Flight
    // with every `EnergyOrb` switched off — a legal course with nothing to
    // collect, because 2016's Free Flight ends from the menu rather than from a
    // target. **DEV-061 removed the shipped instance**, so the sweep below now
    // finds nothing and the fallback is exercised on a level built here instead.
    //
    // Kept rather than deleted, and in two halves, because the rule outlived its
    // one example: a generated or hand-authored Free Flight course with no orbs
    // yet is the same shape, and the day one ships the sweep sees it.
    let checked = 0
    for (const id of await levelIds()) {
      const level = await loadLevel(id)
      // The RUNNING mode. `level.forcedMode` is still `freeFlight` on
      // `int_02_jumpSeat` — it is 2016's record — so a filter on it would put
      // that mission back in this arm and the test would pass by testing the
      // record instead of the rule.
      const scoredKindIsEmpty =
        runningMode(level) === 'freeFlight' && level.orbs.filter((o) => o.live).length === 0
      if (!scoredKindIsEmpty) continue
      checked++
      expect(missionTour(level).pads.length, `${id} fell back to nothing`).toBeGreaterThan(0)
    }
    expect(checked, 'no shipped mission has an empty objective since DEV-061').toBe(0)

    // The rule itself, on the case the content no longer supplies: take a real
    // mission with live pads, run it in Free Flight, and kill every orb. Its
    // craft tours the pads, the only landmarks out there.
    const base = await loadLevel('int_02_jumpSeat')
    const empty = {
      ...base,
      forcedModeFf2: { mode: 'freeFlight' as const },
      orbs: base.orbs.map((o) => ({ ...o, live: false })),
    }
    expect(runningMode(empty)).toBe('freeFlight')
    expect(empty.orbs.filter((o) => o.live)).toHaveLength(0)
    expect(missionTour(empty).pads.length, 'the fallback toured nothing').toBeGreaterThan(0)
  })
})

/* ════════ every table has something MOVING on it (DEV-313 #41c) ════════════ */
//
// `render/diorama.ts` flies the craft along whatever this file hands it — the
// racing line, or a lob between the pads. These are the properties the renderer
// relies on, asserted against all thirteen shipped missions rather than against
// the one anybody opened.

describe('every level table has a path for its craft (#41c)', () => {
  it('gives EVERY mission a path for its craft to fly', async () => {
    // The bug #41c is really about. Five of the six Target Practice missions
    // carry `route: null`, so `createDiorama`'s `line.length > 1` was false and
    // those five tables built no jets at all — nothing moved on them, ever.
    //
    // Stated as the invariant rather than as the count of missions that were
    // broken: a table needs a route OR at least two pads to tour, and a
    // fourteenth mission with neither would be a static table again.
    for (const id of await levelIds()) {
      const level = await loadLevel(id)
      const tour = missionTour(level)
      const canTour = (tour.route?.length ?? 0) > 1 || tour.pads.length >= 2
      expect(canTour, `${id} has nothing for a craft to follow`).toBe(true)
    }
  })

  it('is the PADS, not a racing line, that a Target Practice table flies', async () => {
    // `rookie_02_jumpSeat` is the one pad mission that DOES carry a route, and
    // it is a HoverJet racing line on a mission you fly in hops — so a rule of
    // *"use the route when there is one"* would have made exactly one of the six
    // tables disagree with the other five. The renderer prefers the pads
    // whenever there are pads; this is the content half of that claim.
    const withRoute: string[] = []
    for (const id of await levelIds()) {
      const level = await loadLevel(id)
      const tour = missionTour(level)
      if (tour.pads.length > 0 && (tour.route?.length ?? 0) > 1) withRoute.push(id)
    }
    expect(withRoute, 'the mixed case is no longer in the content').toContain('rookie_02_jumpSeat')
  })
})

/* ═══════ the one pad a Target Practice FLIGHT PLAN stands (DEV-354) ════════ */

describe('a pad-scoring flight plan has a pad to stand', () => {
  it('finds a live landing surface on every mission that scores its pads', async () => {
    // The flight-plan table lathes its one large target from its signature
    // course's pad (`render/hangar.ts`). Which course is the signature is the
    // index's business, so every candidate is held to it: a pad mission with no
    // live surface would leave its plan's table empty.
    let checked = 0
    for (const id of await levelIds()) {
      const level = await loadLevel(id)
      if (!scores(runningMode(level), 'padZone')) continue
      checked++
      const pad = missionPad(level)
      expect(pad, `${id} has no pad for its plan to stand`).not.toBeNull()
      expect(pad?.live, `${id}'s pad is not live`).toBe(true)
      // And it is one the WORLD stands: the surface of one of the level's own
      // live pads, not a description of a pad.
      expect(
        level.pads.some((p) => p.live && p.solid === pad),
        `${id}: the plan's pad is not one of its pads`,
      ).toBe(true)
    }
    expect(checked, 'no shipped mission scores pads — the sweep is vacuous').toBeGreaterThan(0)
  })

  it('stands nothing, rather than a stand-in, where no pad is live', async () => {
    // A mission that HAS a pad to stand, with every pad switched off — so the
    // null is the rule's, not the content's.
    let base: Awaited<ReturnType<typeof loadLevel>> | null = null
    for (const id of await levelIds()) {
      const level = await loadLevel(id)
      if (missionPad(level)) {
        base = level
        break
      }
    }
    expect(base, 'no shipped mission has a live pad').not.toBeNull()
    const dark = base as NonNullable<typeof base>
    expect(missionPad({ ...dark, pads: dark.pads.map((p) => ({ ...p, live: false })) })).toBeNull()
  })
})

describe('the height map path comes from the asset manifest', () => {
  it('resolves `terrain.<environment>.height` for every environment in use', async () => {
    // The picker looks the path up by `terrain.<env>.height` instead of keeping
    // its own table, so a fifth environment costs this layer nothing. That only
    // holds while the manifest keeps the convention — and a renamed id would
    // otherwise surface as "the diorama never appears", at runtime, on one page.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'tools', 'assets', 'required-assets.json'), 'utf8'),
    ) as { assets: { id: string; path: string }[] }
    const ids = new Map(manifest.assets.map((a) => [a.id, a.path]))
    const environments = new Set<string>()
    for (const id of await levelIds()) environments.add((await loadLevel(id)).environment)
    expect(environments.size).toBeGreaterThan(1)
    for (const env of environments) {
      const key = `terrain.${env}.height`
      expect(ids.get(key), `${key} missing from required-assets.json`).toBeTruthy()
      // And the environment is one `environmentTerrains` can name a land for,
      // which is the other half of the lookup.
      expect(environmentTerrains(env).land.startsWith(`${env}.`)).toBe(true)
    }
  })
})
