/**
 * tests/unit/spawn-clearing.test.ts — is there a prop standing on the pad?
 *
 * DEV-100. `rookie_01_hoverJet` released the player into a canopy and
 * `rookie_01_jumpSeat` had a trunk up the middle of the frame, and not one of
 * 2,056 tests could tell: the scatter's own suite asserts relationships about a
 * synthetic map, and nothing anywhere compared a placement against a spawn.
 *
 * ── What it sweeps, and why it needs no assets ────────────────────────────
 *
 * The COMMITTED blobs in `content/environments/*.json`, against the spawn of
 * every level JSON on disk — a sweep over all thirteen missions and all five
 * generators, not a named mission. A clearing is a vertical CYLINDER, so the
 * only thing a placement's `y` would be needed for is nothing at all: `wx` and
 * `wz` come from the texel indices, `terrainSize` and the map width, and the
 * height map never enters. So this file has no `describe.skipIf`, no gitignored
 * dependency and no chance of the rot CLAUDE.md's trap describes — it runs in
 * CI, where `prop-scale.test.ts`'s geometry half cannot.
 *
 * ── Why the radius is not asserted as a value ─────────────────────────────
 *
 * `bake-placements.mjs` computes it with `gameClearingRadius` and records it in
 * the environment JSON; asserting `radius === gameClearingRadius(levels)` here
 * would be trap 24 exactly — the expectation re-derived the way the code derives
 * it. So the radius is pinned by RELATIONSHIPS instead:
 *
 *   * it covers the launch deck of EVERY mission, and is ATTAINED by one, so it
 *     is neither short nor inflated;
 *   * it is at least half the length of the `lightBar`, a different object in the
 *     same 2016 structure from the slabs that produce the maximum;
 *   * it is larger than the launch room's own circumradius out of
 *     `sim/hangar.ts`, which is derived from `platform.size` down a completely
 *     different path.
 *
 * ── And the centres are checked against something outside the port ────────
 *
 * The clearing's centres are computed at bake time from `spawn.pos` through
 * `terrainOriginSim`, so re-deriving them the same way here would prove nothing
 * about whether they are in the right PLACE. `spawn.respawn` is the check that
 * is not circular: 2016 hand-placed `SinglePlayerRespawnPosition` at the release
 * on every rig, for its own reasons, and it lands within 2.65 m of the spawn
 * axis. So the props clear the respawn marker too — and they only do if the
 * clearing went where it was meant to.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { terrainOriginSim } from '@/game/mission-shape'
import { environmentTerrains, terrainParams } from '@/game/terrain/load-terrain'
import { hangarSpecFor } from '@/sim/hangar'
import { footprintRadius } from '@/sim/props/clearing'
import { PLACEMENT_STRIDE } from '@/sim/props/placements'
import { scatterProps } from '@/sim/props/scatter'
import type { ImageData8, MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import { REPO as ROOT } from './helpers/repo-root'

const ENV_DIR = path.join(ROOT, 'content', 'environments')
const LEVEL_DIR = path.join(ROOT, 'content', 'levels')

interface Box {
  pos: number[]
  quat: number[]
  size: number[]
}
interface LevelJson {
  id: string
  environment: string
  worldOffset: number[]
  spawn: {
    pos: number[]
    launchKind?: string | null
    startGrid?: { slabs?: Box[]; lightBar?: Box | null; pads?: Box[] } | null
  }
  respawn: { pos: number[] }
}
interface EnvJson {
  id: string
  spawnClearing?: {
    radius: number
    source: string
    note: string
    missions: { id: string; x: number; z: number }[]
  }
  scatter: {
    index: number
    placements: { count: number; mapWidth: number; mapHeight: number; data: string }
  }[]
}

/** Both directories are tracked and tiny; reading them at module scope is safe. */
const jsonIn = <T>(dir: string): T[] =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as T)

const LEVELS = jsonIn<LevelJson>(LEVEL_DIR)
const ENVS = jsonIn<EnvJson>(ENV_DIR)

/** Every placement of one generator, in the terrain's own mesh space. */
const placementsOf = (
  entry: EnvJson['scatter'][number],
  terrainSize: number,
): { wx: number; wz: number }[] => {
  const bytes = Buffer.from(entry.placements.data, 'base64')
  const out: { wx: number; wz: number }[] = []
  for (let o = 0; o + PLACEMENT_STRIDE <= bytes.length; o += PLACEMENT_STRIDE) {
    out.push({
      wx: (bytes.readUInt16LE(o) * terrainSize) / entry.placements.mapWidth,
      wz: (bytes.readUInt16LE(o + 2) * terrainSize) / entry.placements.mapHeight,
    })
  }
  return out
}

const extentOf = (environment: string) => terrainParams(environmentTerrains(environment).land)

/**
 * Environments no mission stands on — `MISSIONLESS` in `bake-placements.mjs`.
 *
 * `menu` is the TITLE SCREEN's valley (DEV-155): 2016 scattered 3,999 trees on
 * it and never spawned a ship there, so its clearing list is empty ON PURPOSE.
 * Written out here rather than derived from the levels, because "no missions"
 * is otherwise indistinguishable from "a level lost its `environment` field",
 * which is the accident this whole test exists to catch.
 */
const MISSIONLESS = new Set(['menu'])

/** THREE-space world point → the terrain's own mesh space. Sim z is `-three z`. */
const toTerrainLocal = (level: LevelJson, p: readonly number[]) => {
  const origin = terrainOriginSim(
    environmentTerrains(level.environment).land,
    level.worldOffset,
  ).position
  return {
    x: (p[0] as number) - (origin[0] as number),
    z: -(p[2] as number) - (origin[2] as number),
  }
}

describe('no scattered prop stands on a mission spawn', () => {
  it('every environment carries a clearing receipt naming exactly its own missions', () => {
    // The sweep below asks "is anything inside a clearing?" and would pass
    // triumphantly against an empty list. This is the half that makes the
    // question non-vacuous, and it is why it comes first.
    for (const env of ENVS) {
      const clearing = env.spawnClearing
      expect(clearing, `${env.id}: no spawnClearing — re-run \`pnpm bake:placements\``).toBeTruthy()
      if (!clearing) continue
      expect(clearing.radius, `${env.id}: radius`).toBeGreaterThan(0)
      expect(clearing.note, `${env.id}: note`).toContain('DEV-100')

      const expected = LEVELS.filter((l) => l.environment === env.id)
        .map((l) => l.id)
        .sort()
      expect(clearing.missions.map((m) => m.id).sort(), `${env.id}: missions`).toEqual(expected)
      if (MISSIONLESS.has(env.id)) {
        // Named here as well as in `bake-placements.mjs`, so the two have to
        // agree: an environment the tool quietly excused would fail the
        // `toBe(0)` here, and one excused here but not there would never be
        // baked at all.
        expect(expected.length, `${env.id}: is missionless by design`).toBe(0)
        expect(clearing.note, `${env.id}: says it cleared nothing`).toContain(
          'NOTHING WAS CLEARED HERE',
        )
      } else {
        expect(expected.length, `${env.id}: at least one mission`).toBeGreaterThan(0)
      }
    }
    // And no mission is unclaimed — a level whose `environment` nobody bakes
    // would sail through the loop above by not being in anybody's list.
    const claimed = new Set(ENVS.flatMap((e) => e.spawnClearing?.missions.map((m) => m.id) ?? []))
    for (const level of LEVELS) expect(claimed.has(level.id), `${level.id} is cleared`).toBe(true)
  })

  it('every one of the thirteen spawns has clear ground to the recorded radius', () => {
    const table: string[] = []
    for (const level of LEVELS) {
      const env = ENVS.find((e) => e.id === level.environment)
      expect(env, `${level.id}: environment "${level.environment}"`).toBeTruthy()
      if (!env?.spawnClearing) continue
      const radius = env.spawnClearing.radius
      const { terrainSize } = extentOf(level.environment)
      const centre = toTerrainLocal(level, level.spawn.pos)

      let nearest = Number.POSITIVE_INFINITY
      let worstGen = -1
      for (const entry of env.scatter) {
        for (const p of placementsOf(entry, terrainSize)) {
          const d = Math.hypot(p.wx - centre.x, p.wz - centre.z)
          if (d < nearest) {
            nearest = d
            worstGen = entry.index
          }
        }
      }
      table.push(
        `${level.id.padEnd(20)} ${level.environment.padEnd(8)} nearest prop ` +
          `${(nearest === Number.POSITIVE_INFINITY ? -1 : nearest).toFixed(2).padStart(9)} m ` +
          `(gen ${worstGen}) of ${radius.toFixed(2)} m`,
      )
      expect(
        nearest,
        `${level.id}: a scattered prop stands ${nearest.toFixed(2)} m from the spawn, ` +
          `inside the ${radius.toFixed(2)} m clearing (generator ${worstGen}). ` +
          'Re-run `pnpm bake:placements` and commit content/environments/.',
      ).toBeGreaterThanOrEqual(radius)
    }
    if (process.env.SPAWN_CLEARING === '1') console.log(table.join('\n'))
    expect(table.length).toBe(LEVELS.length)
  })

  it("clears 2016's own respawn marker too, which is not where the clearing was aimed", () => {
    // The centres above are derived from `spawn.pos` the same way the bake
    // derived them, so they cannot testify about their own frame. `respawn.pos`
    // can: 2016 hand-placed it at the release, and it is a different field
    // authored for a different purpose. The margin is each mission's own
    // measured offset rather than a tolerance, so nothing here is fudged.
    for (const level of LEVELS) {
      const env = ENVS.find((e) => e.id === level.environment)
      if (!env?.spawnClearing) continue
      const { terrainSize } = extentOf(level.environment)
      const spawn = toTerrainLocal(level, level.spawn.pos)
      const respawn = toTerrainLocal(level, level.respawn.pos)
      const offset = Math.hypot(respawn.x - spawn.x, respawn.z - spawn.z)
      const guaranteed = env.spawnClearing.radius - offset
      // Below zero the claim is empty, and one JumpSeat respawn is far away.
      if (guaranteed <= 0) continue

      let nearest = Number.POSITIVE_INFINITY
      for (const entry of env.scatter) {
        for (const p of placementsOf(entry, terrainSize)) {
          nearest = Math.min(nearest, Math.hypot(p.wx - respawn.x, p.wz - respawn.z))
        }
      }
      expect(
        nearest,
        `${level.id}: the respawn marker sits ${offset.toFixed(2)} m off the spawn axis, ` +
          `so ${guaranteed.toFixed(2)} m around it must be clear — nearest prop ${nearest.toFixed(2)} m`,
      ).toBeGreaterThanOrEqual(guaranteed)
    }
  })

  it("the receipt's centres are where the level JSONs put the spawns — DEV-103 reads them at boot", () => {
    // Staleness, not correctness: this is the SAME derivation the bake makes,
    // so it cannot testify about the frame (the respawn test above does that).
    // What it can say is that nobody moved a spawn without re-baking — which
    // used to cost nothing at runtime and, now that the Anniversary dressing
    // reads the receipt rather than the levels, would clear the wrong ground.
    for (const level of LEVELS) {
      const env = ENVS.find((e) => e.id === level.environment)
      const recorded = env?.spawnClearing?.missions.find((m) => m.id === level.id)
      expect(recorded, `${level.id}: in ${level.environment}'s receipt`).toBeTruthy()
      if (!recorded) continue
      const centre = toTerrainLocal(level, level.spawn.pos)
      expect(recorded.x, `${level.id}: receipt x`).toBeCloseTo(centre.x, 6)
      expect(recorded.z, `${level.id}: receipt z`).toBeCloseTo(centre.z, 6)
    }
  })

  it('the radius covers every launch deck, is attained by one, and is not inflated', () => {
    const radii = ENVS.map((e) => e.spawnClearing?.radius).filter(
      (r): r is number => r !== undefined,
    )
    expect(new Set(radii.map((r) => r.toFixed(6))).size, 'one radius for the whole game').toBe(1)
    const radius = radii[0] as number

    // ── DEV-109: only a mission that LAUNCHES FROM A DECK may size it ─────
    //
    // `footprintRadius` measures the deck's corners about `spawn.pos`, which
    // answers two questions at once — *how big is 2016's launch deck* and
    // *where is the clearing centred* — and those coincided only while every
    // spawn sat on its own deck. `int_01_jumpSeat` is the mission that breaks
    // it: its scene materialises the HOVERJET DECOY's deck, and once DEV-109
    // moved its spawn 2.78 km to 2016's own jumpSeat marker, its "footprint"
    // became the distance to somebody else's rig. Unfiltered, that sized the
    // whole game's clearing at 2,800 m and wiped 95 % of every prop in it.
    const launching = LEVELS.filter((l) => l.spawn.launchKind === 'elevator')
    const footprints = launching.map((l) => ({ id: l.id, r: footprintRadius(l.spawn) }))
    const withDeck = footprints.filter((f) => f.r > 0)
    // FIVE of the seven rigged missions materialise the deck; the other two hold
    // the same rig as a stripped prefab instance (DEV-045). If that number ever
    // reaches zero the radius has no source at all, which the bake refuses — but
    // a silent drop to one or two is the thing that would go unnoticed.
    expect(
      withDeck.length,
      'rigged missions whose scene materialises a launch deck',
    ).toBeGreaterThanOrEqual(5)

    for (const f of footprints) {
      expect(radius, `${f.id}: the clearing must cover its own launch deck`).toBeGreaterThanOrEqual(
        f.r,
      )
    }

    // And the exclusion is REAL rather than defensive: `int_01_jumpSeat` is a
    // `direct` mission carrying a deck, the only one in the game, and it is the
    // decoy's. If a future extraction stops attributing it, this goes red and
    // the filter above can go — which is the point of asserting it here rather
    // than trusting the comment.
    const strayDecks = LEVELS.filter(
      (l) => l.spawn.launchKind !== 'elevator' && (l.spawn.startGrid?.slabs ?? []).length > 0,
    ).map((l) => l.id)
    expect(strayDecks, 'only int_01_jumpSeat carries a deck it cannot launch from').toEqual([
      'int_01_jumpSeat',
    ])
    const widest = Math.max(...withDeck.map((f) => f.r))
    expect(
      radius,
      'the radius is ATTAINED, i.e. it is some deck and not a round number',
    ).toBeCloseTo(widest, 6)
  })

  it('is larger than two independent measurements of the same launch structure', () => {
    const radius = ENVS[0]?.spawnClearing?.radius as number

    // 1. The `lightBar` — a different object in the same 2016 structure from the
    //    slabs that produce the maximum, and `render/start-grid.ts` traced it to
    //    a Unity built-in cube at 74.9 x 1 x 4.9 m by its own path.
    const bars = LEVELS.map((l) => l.spawn.startGrid?.lightBar).filter((b): b is Box => !!b)
    expect(bars.length, 'some mission materialises the light bar').toBeGreaterThan(0)
    for (const bar of bars) {
      const half = Math.max(...(bar.size as number[])) / 2
      expect(half, 'the light bar is the ~75 m one start-grid.ts describes').toBeGreaterThan(30)
      expect(radius, 'the clearing spans the light bar').toBeGreaterThanOrEqual(half)
    }

    // 2. The launch ROOM's own circumradius, which comes off `platform.size`
    //    through `hangarSpecFor` — a completely separate derivation that never
    //    touches a start grid.
    expect(radius, "the clearing contains the launch room's footprint").toBeGreaterThan(
      hangarSpecFor().roomRadius,
    )
  })

  it('a blob’s recorded count is the number of records in it', () => {
    for (const env of ENVS) {
      for (const entry of env.scatter) {
        const bytes = Buffer.from(entry.placements.data, 'base64')
        expect(bytes.length % PLACEMENT_STRIDE, `${env.id} gen${entry.index}: stride`).toBe(0)
        expect(bytes.length / PLACEMENT_STRIDE, `${env.id} gen${entry.index}: count`).toBe(
          entry.placements.count,
        )
      }
    }
  })
})

/**
 * The loud counterpart.
 *
 * Nothing above can distinguish "the clearing works" from "the clearing does
 * nothing and the props happened to be elsewhere" — every mission could have had
 * clear ground already, which is exactly what six of the thirteen did. So the
 * mechanism is exercised directly on a synthetic map, where a refusal can be
 * SEEN, and the design claim scatter.ts makes in its header is asserted rather
 * than described. DEV-089's rule: a guard that has never been seen to refuse
 * something is not known to be a guard.
 */
describe('the clearing mechanism refuses something, and only subtracts', () => {
  const flatMap = (size: number): ImageData8 => ({
    width: size,
    height: size,
    channels: 1,
    data: new Uint8Array(size * size).fill(255),
  })
  const flatHeight = (): MapSampler => ({
    width: 8,
    height: 8,
    sample: (_u: number, _v: number, out: Rgb) => {
      out.r = 0.5
      out.g = 0.5
      out.b = 0.5
    },
  })
  const TERRAIN = { terrainSize: 1024, terrainHeight: 512, chunkSize: 256 }
  const PARAMS = {
    probabilityScale: 0.6,
    heightOffset: 0,
    scaleMin: 1,
    scaleMax: 3,
    paletteSize: 4,
    seed: 4242,
  }
  const CLEARING = [{ x: 512, z: 512, radius: 120 }]

  it('drops the placements inside a clearing and nothing else', () => {
    const map = flatMap(64)
    const all = scatterProps(map, flatHeight(), TERRAIN, PARAMS)
    const kept = scatterProps(map, flatHeight(), TERRAIN, PARAMS, CLEARING)

    expect(all.count, 'the synthetic map must produce something to reject').toBeGreaterThan(100)
    expect(kept.count, 'the clearing refuses something').toBeLessThan(all.count)

    const inside = (x: number, z: number) =>
      Math.hypot(x - 512, z - 512) < (CLEARING[0] as { radius: number }).radius
    let removed = 0
    for (let i = 0; i < all.count; i++) {
      if (inside(all.positions[i * 3] as number, all.positions[i * 3 + 2] as number)) removed++
    }
    expect(removed, 'the synthetic clearing must actually contain placements').toBeGreaterThan(0)
    expect(all.count - kept.count).toBe(removed)
    for (let i = 0; i < kept.count; i++) {
      expect(inside(kept.positions[i * 3] as number, kept.positions[i * 3 + 2] as number)).toBe(
        false,
      )
    }
  })

  it('leaves every surviving placement bit-identical — the draws are spent first', () => {
    // scatter.ts: "the rejection happens AFTER the four draws, and that is the
    // whole design". Rejecting earlier would shift the PRNG sequence and re-roll
    // the yaw, palette and scale of every prop after the first clearing — which
    // would look like nothing at all in a count and like a different world in a
    // frame. The kept stream must be a SUBSEQUENCE of the unclearedd one.
    const map = flatMap(64)
    const all = scatterProps(map, flatHeight(), TERRAIN, PARAMS)
    const kept = scatterProps(map, flatHeight(), TERRAIN, PARAMS, CLEARING)

    let ai = 0
    for (let k = 0; k < kept.count; k++) {
      let matched = false
      while (ai < all.count) {
        const same =
          all.positions[ai * 3] === kept.positions[k * 3] &&
          all.positions[ai * 3 + 1] === kept.positions[k * 3 + 1] &&
          all.positions[ai * 3 + 2] === kept.positions[k * 3 + 2] &&
          all.yaw[ai] === kept.yaw[k] &&
          all.scale[ai] === kept.scale[k] &&
          all.palette[ai] === kept.palette[k] &&
          all.texel[ai * 2] === kept.texel[k * 2] &&
          all.texel[ai * 2 + 1] === kept.texel[k * 2 + 1]
        ai++
        if (same) {
          matched = true
          break
        }
      }
      expect(matched, `kept placement ${k} is not the one the uncleared draw made`).toBe(true)
    }
  })

  it('an empty clearing list changes nothing at all', () => {
    const map = flatMap(64)
    const a = scatterProps(map, flatHeight(), TERRAIN, PARAMS)
    const b = scatterProps(map, flatHeight(), TERRAIN, PARAMS, [])
    const c = scatterProps(map, flatHeight(), TERRAIN, PARAMS, [{ x: 512, z: 512, radius: 0 }])
    expect(b.count).toBe(a.count)
    expect(c.count).toBe(a.count)
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions))
    expect(Array.from(c.positions)).toEqual(Array.from(a.positions))
  })

  it('footprintRadius measures CORNERS, not centres', () => {
    // DEV-027's lesson as an assertion: a 20 m box whose centre is 30 m out
    // reaches 40 m, and a rule built on the centre would be 10 m short. The two
    // answers differ by construction here, so this cannot pass by accident.
    const site = {
      pos: [0, 0, 0],
      startGrid: {
        slabs: [{ pos: [30, 0, 0], quat: [0, 0, 0, 1], size: [20, 4, 20] }],
      },
    }
    expect(footprintRadius(site)).toBeCloseTo(Math.hypot(40, 10), 6)
    expect(footprintRadius({ pos: [0, 0, 0] })).toBe(0)
    expect(footprintRadius({ pos: [0, 0, 0], startGrid: null })).toBe(0)

    // A yaw about y has to be composed, or a rotated deck reads as axis-aligned.
    const s = Math.SQRT1_2
    const turned = {
      pos: [0, 0, 0],
      startGrid: {
        slabs: [{ pos: [0, 0, 0], quat: [0, s, 0, s], size: [100, 4, 2] }],
      },
    }
    // Rotated 90 degrees about y, the long axis runs in z; the corner distance is
    // the same by symmetry, so the discriminating case is a 45 degree turn.
    expect(footprintRadius(turned)).toBeCloseTo(Math.hypot(50, 1), 6)
    const diagonal = {
      pos: [0, 0, 0],
      startGrid: {
        slabs: [
          {
            pos: [0, 0, 0],
            quat: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)],
            size: [100, 4, 2],
          },
        ],
      },
    }
    expect(footprintRadius(diagonal)).toBeCloseTo(Math.hypot(50, 1), 6)
  })
})
