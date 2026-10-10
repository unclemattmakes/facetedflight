/**
 * tests/unit/no-prop-volumes.test.ts — DEV-287, the authored volumes.
 *
 * Matt: *"in unity i used to place geo where i didn't want props to be, so it
 * would make sure the flight paths were clear."* Three things have to hold or
 * that sentence is not true of this build, and they fail in three different
 * ways:
 *
 *   1. **The SHAPE.** A capsule is a segment with round caps, not an infinite
 *      slab; get the clamp wrong and a corridor from the pad to the first gate
 *      shaves a strip off the whole map. The test for that is a point that a
 *      LINE would catch and a SEGMENT must not.
 *   2. **The FRAME.** A volume is written in the terrain's mesh space and an
 *      anchor arrives in sim space, so exactly one subtraction stands between
 *      the JSON and the test. That subtraction is checked against DEV-100's
 *      own receipt, which `tools/assets/bake-placements.mjs` computed by a
 *      different route for a different reason — an oracle outside this code,
 *      which is the whole of the DEV-042 / trap 24 lesson.
 *   3. **The EFFECT.** A volume that resolves to somewhere there was never a
 *      tree is indistinguishable, from every angle except a photograph, from
 *      one that works. So the two shipped volumes are swept against the
 *      COMMITTED placement blobs and their counts are pinned.
 *
 * ── It needs no gitignored assets, and that is not luck ──────────────────
 *
 * A volume is unbounded in y, so a placement's height never enters: `wx` and
 * `wz` come from the texel indices, `terrainSize` and the map width, exactly as
 * `spawn-clearing.test.ts` says. No `describe.skipIf`, nothing to rot, and it
 * runs in CI.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NoPropVolumeFile } from '@/content/no-prop-volumes'
import { courseGates } from '@/game/mission'
import { terrainOriginSim } from '@/game/mission-shape'
import { resolveNoPropVolumes } from '@/game/props/no-prop-volumes'
import { environmentTerrains, terrainParams } from '@/game/terrain/load-terrain'
import { type Clearing, insideAnyClearing } from '@/sim/props/clearing'
import { PLACEMENT_STRIDE } from '@/sim/props/placements'
import type { ScatteredProps } from '@/sim/props/scatter'
import { withoutVolumes } from '@/sim/props/scatter'
import {
  CLIMB_OUT_CLEARS,
  CORRIDOR_CLEARS,
  CORRIDOR_CLEARS_INT_02,
  CORRIDOR_MISSION,
  CORRIDOR_MISSION_CLEARS,
} from '../e2e/fixtures/no-prop-volumes'
import { REPO as ROOT } from './helpers/repo-root'

const ENV_DIR = path.join(ROOT, 'content', 'environments')
const LEVEL_DIR = path.join(ROOT, 'content', 'levels')
const FILE = path.join(ROOT, 'content', 'no-prop-volumes.json')

interface EnvJson {
  id: string
  spawnClearing?: { radius: number; missions: { id: string; x: number; z: number }[] }
  scatter: { index: number; placements: { mapWidth: number; mapHeight: number; data: string } }[]
}

const jsonIn = <T>(dir: string): T[] =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as T)

// Cast at the edge: these are the shipped files and the loader's own types
// describe them. A structural mismatch is what the suite below is for.
// biome-ignore lint/suspicious/noExplicitAny: level JSON, read as data
const LEVELS = jsonIn<any>(LEVEL_DIR)
const ENVS = jsonIn<EnvJson>(ENV_DIR)
const VOLUMES = JSON.parse(fs.readFileSync(FILE, 'utf8')) as NoPropVolumeFile

/** The authored file with only the named alpine volume, so one volume's count is its own. */
const onlyAlpine = (id: string): NoPropVolumeFile => ({
  ...VOLUMES,
  environments: {
    ...VOLUMES.environments,
    alpine: (VOLUMES.environments.alpine ?? []).filter((v) => v.id === id),
  },
})

/** Every placement of one generator, in the terrain's own mesh space. */
const placementsOf = (
  entry: EnvJson['scatter'][number],
  terrainSize: number,
): { x: number; z: number }[] => {
  const bytes = Buffer.from(entry.placements.data, 'base64')
  const out: { x: number; z: number }[] = []
  for (let o = 0; o + PLACEMENT_STRIDE <= bytes.length; o += PLACEMENT_STRIDE) {
    out.push({
      x: (bytes.readUInt16LE(o) * terrainSize) / entry.placements.mapWidth,
      z: (bytes.readUInt16LE(o + 2) * terrainSize) / entry.placements.mapHeight,
    })
  }
  return out
}

/** `boot/app.ts`'s own anchor table for one level. Copied here on purpose — */
/* it is four lines, and a test that imported it could not catch it changing. */
// biome-ignore lint/suspicious/noExplicitAny: level JSON, read as data
const contextFor = (level: any) => ({
  environmentId: level.environment as string,
  missionId: level.id as string,
  origin: terrainOriginSim(environmentTerrains(level.environment).land, level.worldOffset).position,
  anchors: {
    spawn: { x: level.spawn.pos[0] as number, z: -(level.spawn.pos[2] as number) },
    gates: courseGates(level).map((g) => ({ x: g.centre.x, z: g.centre.z })),
  },
})

// ── 1. the shape ──────────────────────────────────────────────────────────

describe('a clearing is a capsule, and a spawn cylinder is the degenerate one', () => {
  it('a second endpoint equal to the first is the cylinder, point for point', () => {
    // A RELATIONSHIP, not a value: whatever the cylinder answers, the
    // zero-length capsule must answer the same, or DEV-100's thirteen spawns
    // start behaving differently for having grown two optional fields.
    const cylinder: Clearing = { x: 100, z: 200, radius: 30 }
    const degenerate: Clearing = { x: 100, z: 200, radius: 30, x2: 100, z2: 200 }
    for (let x = 40; x <= 160; x += 7) {
      for (let z = 140; z <= 260; z += 7) {
        expect(
          insideAnyClearing(x, z, [degenerate]),
          `(${x}, ${z}) must agree with the cylinder`,
        ).toBe(insideAnyClearing(x, z, [cylinder]))
      }
    }
  })

  it('half an endpoint is no endpoint — `x2` without `z2` stays a cylinder', () => {
    // `exactOptionalPropertyTypes` cannot stop a hand-written JSON file from
    // carrying one of the pair, and silently reading the missing half as 0
    // would put the far end on the terrain's edge.
    const half: Clearing = { x: 100, z: 200, radius: 10, x2: 900 }
    expect(insideAnyClearing(500, 200, [half])).toBe(false)
    expect(insideAnyClearing(100, 205, [half])).toBe(true)
  })

  it('the END CAPS are round: a point past the end is out, though the LINE is close', () => {
    // The separating case. `(260, 100)` is 0 m from the infinite line through
    // the segment and 60 m past its end, so a slab says yes and a capsule says
    // no. Without this the alpine corridor would not stop at the first gate.
    const capsule: Clearing = { x: 0, z: 100, radius: 50, x2: 200, z2: 100 }
    expect(insideAnyClearing(100, 100, [capsule]), 'beside the middle').toBe(true)
    expect(insideAnyClearing(200, 100, [capsule]), 'on the far end').toBe(true)
    expect(insideAnyClearing(240, 100, [capsule]), '40 m past the end, inside the cap').toBe(true)
    expect(insideAnyClearing(260, 100, [capsule]), '60 m past the end, outside the cap').toBe(false)
    expect(insideAnyClearing(-60, 100, [capsule]), '60 m behind the start').toBe(false)
    expect(insideAnyClearing(100, 151, [capsule]), '51 m to the side').toBe(false)
  })
})

// ── 2. the subtraction ────────────────────────────────────────────────────

const scatteredOf = (points: readonly (readonly [number, number])[]): ScatteredProps => ({
  count: points.length,
  positions: Float32Array.from(points.flatMap(([x, z], i) => [x, i * 10, z])),
  yaw: Float32Array.from(points.map((_, i) => i * 0.1)),
  scale: Float32Array.from(points.map((_, i) => 1 + i)),
  palette: Uint8Array.from(points.map((_, i) => i % 4)),
  chunk: Uint16Array.from(points.map((_, i) => i % 3)),
  texel: Uint16Array.from(points.flatMap((_, i) => [i, i * 2])),
  chunkPerSide: 8,
})

describe('a no-prop volume SUBTRACTS and moves nothing', () => {
  it('every survivor keeps its own position, yaw, scale, palette, chunk and texel', () => {
    const props = scatteredOf([
      [0, 0],
      [100, 100],
      [10, 10],
      [300, 300],
      [12, 8],
    ])
    const { props: kept, removed } = withoutVolumes(props, [{ x: 8, z: 8, radius: 9 }])
    // (0,0) is 11.3 m out, (10,10) is 2.8 m in, (12,8) is 4 m in.
    expect(removed).toBe(2)
    expect(kept.count).toBe(3)
    for (const [k, i] of [
      [0, 0],
      [1, 1],
      [2, 3],
    ] as const) {
      expect(kept.positions[k * 3], `survivor ${k} x`).toBe(props.positions[i * 3])
      expect(kept.positions[k * 3 + 1], `survivor ${k} y`).toBe(props.positions[i * 3 + 1])
      expect(kept.positions[k * 3 + 2], `survivor ${k} z`).toBe(props.positions[i * 3 + 2])
      expect(kept.yaw[k], `survivor ${k} yaw`).toBe(props.yaw[i])
      expect(kept.scale[k], `survivor ${k} scale`).toBe(props.scale[i])
      expect(kept.palette[k], `survivor ${k} palette`).toBe(props.palette[i])
      expect(kept.chunk[k], `survivor ${k} chunk`).toBe(props.chunk[i])
      expect(kept.texel[k * 2], `survivor ${k} texel x`).toBe(props.texel[i * 2])
      expect(kept.texel[k * 2 + 1], `survivor ${k} texel y`).toBe(props.texel[i * 2 + 1])
    }
    expect(kept.chunkPerSide).toBe(props.chunkPerSide)
  })

  it('hands back the SAME object when nothing matched', () => {
    // The common case is every environment nobody has authored volumes for,
    // and a copy of 6,000 placements per pass per world build to change
    // nothing is a cost with no buyer.
    const props = scatteredOf([
      [0, 0],
      [100, 100],
    ])
    expect(withoutVolumes(props, []).props).toBe(props)
    expect(withoutVolumes(props, [{ x: 900, z: 900, radius: 5 }]).props).toBe(props)
  })
})

// ── 3. the frame ──────────────────────────────────────────────────────────

describe('an anchor lands where DEV-100 independently says it should', () => {
  it("the `spawn` anchor equals the environment JSON's own clearing centre", () => {
    // THE ORACLE. `bake-placements.mjs` wrote those centres from `spawn.pos`
    // through `terrainOriginSim` for DEV-100, before this feature existed and
    // for another purpose. If `no-prop-volumes.ts` flips a sign or forgets the
    // origin, these two numbers part company; a test that re-derived the
    // expectation the way the code does would agree with the bug (trap 24).
    let checked = 0
    for (const level of LEVELS) {
      const receipt = ENVS.find((e) => e.id === level.environment)?.spawnClearing
      const mission = receipt?.missions.find((m) => m.id === level.id)
      if (!mission) continue
      const { volumes } = resolveNoPropVolumes(
        {
          environments: {
            [level.environment]: [{ id: 'probe', why: 'the oracle', radius: 1, ends: ['spawn'] }],
          },
        },
        contextFor(level),
      )
      expect(volumes, `${level.id}: one volume`).toHaveLength(1)
      expect(volumes[0]?.x, `${level.id}: x`).toBeCloseTo(mission.x, 6)
      expect(volumes[0]?.z, `${level.id}: z`).toBeCloseTo(mission.z, 6)
      checked++
    }
    // Loud counterpart: a `continue` that swallowed every mission would leave
    // the loop green and prove nothing. Thirteen missions ship.
    expect(checked, 'missions checked against the receipt').toBe(13)
  })

  it('an explicit end is passed through untouched — that is why the frame is the mesh', () => {
    const level = LEVELS.find((l) => l.id === 'rookie_01_hoverJet')
    const { volumes } = resolveNoPropVolumes(
      {
        environments: {
          alpine: [{ id: 'probe', why: 'literal', radius: 5, ends: [[1234.5, 678.25]] }],
        },
      },
      contextFor(level),
    )
    expect(volumes[0]).toEqual({ x: 1234.5, z: 678.25, radius: 5 })
  })
})

describe('a volume that cannot be resolved is DROPPED, with a reason', () => {
  const level = () => LEVELS.find((l) => l.id === 'rookie_01_hoverJet')
  const resolve = (spec: unknown) =>
    resolveNoPropVolumes(
      { environments: { alpine: [spec] } } as unknown as NoPropVolumeFile,
      contextFor(level()),
    )

  it('a gate index the course does not have', () => {
    const r = resolve({ id: 'far', why: 'x', radius: 9, ends: ['spawn', 'gate:99'] })
    expect(r.volumes).toHaveLength(0)
    expect(r.dropped[0]?.reason).toContain('gate:99')
  })

  it('an anchor nobody defined', () => {
    const r = resolve({ id: 'odd', why: 'x', radius: 9, ends: ['finish'] })
    expect(r.volumes).toHaveLength(0)
    expect(r.dropped[0]?.reason).toContain('finish')
  })

  it('a mission list this mission is not on', () => {
    const r = resolve({
      id: 'other',
      why: 'x',
      radius: 9,
      ends: [[0, 0]],
      missions: ['int_02_hoverJet'],
    })
    expect(r.volumes).toHaveLength(0)
    expect(r.dropped[0]?.reason).toContain('not for mission rookie_01_hoverJet')
  })

  it('three ends, which is a polyline and a different shape', () => {
    const r = resolve({
      id: 'poly',
      why: 'x',
      radius: 9,
      ends: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
    })
    expect(r.volumes).toHaveLength(0)
    expect(r.dropped[0]?.reason).toContain('3 ends')
  })

  it('a radius of zero, which would clear nothing and read as working', () => {
    const r = resolve({ id: 'flat', why: 'x', radius: 0, ends: [[0, 0]] })
    expect(r.volumes).toHaveLength(0)
    expect(r.dropped[0]?.reason).toContain('not positive')
  })
})

// ── 4. the file that ships ────────────────────────────────────────────────

describe('the authored file', () => {
  it('names real environments and says why every volume exists', () => {
    const known = new Set(ENVS.map((e) => e.id))
    const ids = Object.keys(VOLUMES.environments)
    expect(ids.length, 'at least one environment is authored').toBeGreaterThan(0)
    for (const id of ids) {
      expect(known.has(id), `"${id}" is an environment`).toBe(true)
      for (const spec of VOLUMES.environments[id] ?? []) {
        expect(spec.id, `${id}: every volume is named`).toBeTruthy()
        // A volume with no reasoning is a number somebody will be afraid to
        // change. Hard rule 9: this file is art direction, and art direction
        // that cannot say what it is for is indistinguishable from a mistake.
        expect(spec.why.length, `${id}/${spec.id}: why`).toBeGreaterThan(40)
        expect(spec.radius, `${id}/${spec.id}: radius`).toBeGreaterThan(0)
        expect(spec.ends.length, `${id}/${spec.id}: ends`).toBeGreaterThanOrEqual(1)
        expect(spec.ends.length, `${id}/${spec.id}: ends`).toBeLessThanOrEqual(2)
      }
    }
  })

  it("the title screen's volume takes out exactly the one tree it names", () => {
    // PINNED, and somebody has to edit it on purpose. The volume is a 3 m
    // circle on a 4 m texel grid, so "1" is the only answer that means it hit
    // what it was aimed at: 0 is a volume that resolved to bare ground and 2+
    // is a radius that has grown past its own justification.
    const env = ENVS.find((e) => e.id === 'menu')
    expect(env, 'menu environment').toBeTruthy()
    const { terrainSize } = terrainParams(environmentTerrains('menu').land)
    const { volumes } = resolveNoPropVolumes(VOLUMES, {
      environmentId: 'menu',
      missionId: null,
      origin: [0, 0, 0],
      anchors: { gates: [] },
    })
    expect(volumes.length, 'menu authors a volume').toBe(1)

    let removed = 0
    for (const entry of env?.scatter ?? []) {
      for (const p of placementsOf(entry, terrainSize)) {
        if (insideAnyClearing(p.x, p.z, volumes)) removed++
      }
    }
    expect(removed, 'placements the title volume removes').toBe(1)
  })

  it("alpine's launch corridor clears rookie_01's start and leaves int_02 alone", () => {
    // Two facts in one assertion on purpose. 72 is the art direction and is
    // pinned so a radius change is deliberate; **0 for `int_02_hoverJet` is
    // the more interesting half** — it is the same authored volume resolving
    // against another mission's pad and another mission's first gate, and it
    // is what says this is a rule about launch sites rather than a number
    // tuned until one screenshot looked right.
    const env = ENVS.find((e) => e.id === 'alpine')
    const { terrainSize } = terrainParams(environmentTerrains('alpine').land)
    const all = (env?.scatter ?? []).flatMap((entry) => placementsOf(entry, terrainSize))
    expect(all.length, 'alpine placements').toBeGreaterThan(10_000)

    const counts: Record<string, number> = {}
    for (const id of [CORRIDOR_MISSION, 'int_02_hoverJet']) {
      const level = LEVELS.find((l) => l.id === id)
      // The corridor ALONE: rookie_01 also carries `rookie-01-climb-out` (the
      // DEV-364 follow-up), whose count is its own, below.
      const { volumes, dropped } = resolveNoPropVolumes(
        onlyAlpine('launch-corridor'),
        contextFor(level),
      )
      expect(volumes.length, `${id}: the corridor resolves (${JSON.stringify(dropped)})`).toBe(1)
      counts[id] = all.filter((p) => insideAnyClearing(p.x, p.z, volumes)).length
    }
    // The VALUE lives in `tests/e2e/fixtures/no-prop-volumes.ts` under one
    // name, and `spawn-clearing.spec.ts` compares the BROWSER's load-path
    // receipt against the same name. This half is the content walk; that half
    // is the runtime. Neither re-derives the other, and their agreement is what
    // catches `app.ts` resolving the volume against a different context — which
    // would cull a different set, report it honestly, and satisfy that spec's
    // conservation law at any magnitude. (CLAUDE.md's `HUD_RASTER_SHIPPED`
    // lesson: one exported name, its value pinned where somebody has to edit it
    // on purpose.)
    expect(counts).toEqual({
      [CORRIDOR_MISSION]: CORRIDOR_CLEARS,
      int_02_hoverJet: CORRIDOR_CLEARS_INT_02,
    })
  })

  it("rookie_01's climb-out is rookie_01's alone, and the mission's total is what the runtime must report", () => {
    // DEV-364 follow-up (Matt, call 8). The volume's far end is an explicit
    // coordinate, so `missions` scopes it: on int_02 it must not resolve at
    // all. Its own count and the mission's total are both pinned in the e2e
    // fixture — the total is what `spawn-clearing.spec.ts` compares the
    // BROWSER's receipt against, and it is not the sum of the two, because a
    // placement inside both is removed once.
    const env = ENVS.find((e) => e.id === 'alpine')
    const { terrainSize } = terrainParams(environmentTerrains('alpine').land)
    const all = (env?.scatter ?? []).flatMap((entry) => placementsOf(entry, terrainSize))
    const rookie = LEVELS.find((l) => l.id === CORRIDOR_MISSION)
    const own = resolveNoPropVolumes(onlyAlpine('rookie-01-climb-out'), contextFor(rookie))
    expect(own.volumes, `${JSON.stringify(own.dropped)}`).toHaveLength(1)
    const int02 = resolveNoPropVolumes(
      onlyAlpine('rookie-01-climb-out'),
      contextFor(LEVELS.find((l) => l.id === 'int_02_hoverJet')),
    )
    expect(int02.volumes).toHaveLength(0)
    expect(int02.dropped[0]?.reason).toContain('not for mission int_02_hoverJet')
    const every = resolveNoPropVolumes(VOLUMES, contextFor(rookie))
    expect(every.volumes, 'rookie_01 resolves both alpine volumes').toHaveLength(2)
    expect({
      climbOut: all.filter((p) => insideAnyClearing(p.x, p.z, own.volumes)).length,
      total: all.filter((p) => insideAnyClearing(p.x, p.z, every.volumes)).length,
    }).toEqual({ climbOut: CLIMB_OUT_CLEARS, total: CORRIDOR_MISSION_CLEARS })
  })

  it('the corridor does not resolve on a mission with no gates', () => {
    // `gate:0` on a Target Practice course is an anchor with nothing behind
    // it, and the answer must be "no volume" rather than "a volume somewhere".
    for (const id of ['rookie_01_jumpSeat', 'int_02_jumpSeat']) {
      const level = LEVELS.find((l) => l.id === id)
      const r = resolveNoPropVolumes(VOLUMES, contextFor(level))
      expect(r.volumes, `${id}`).toHaveLength(0)
      expect(r.dropped[0]?.id, `${id}`).toBe('launch-corridor')
    }
  })
})
