// tests/unit/mission-props.test.ts — the scenery a MISSION places, DEV-218/DEV-219.
//
// Three of the thirteen place props in their own scene as Unity 5 STRIPPED
// PREFAB INSTANCES: a `!u!1001` block plus a stripped Transform, with the names
// and the colliders living in the `.prefab`. A name grep over the scene finds
// nothing, a sweep of the scene's materialised colliders finds nothing, and the
// extractor's ordinary `expandPrefabs: false` read cannot see them at all. All
// three negatives are real and all three are wrong — DEV-045's trap, for the
// fourth time in this port.
//
// The DATA half runs off the COMMITTED JSON, so CI runs all of it: no Unity
// project, no gitignored assets, no guard that could rot into a silent skip.
// The GEOMETRY half at the bottom needs the bucket's GLBs and the density maps,
// so it is guarded — with a loud counterpart, because a skipped gate reads as a
// pass in a summary line and this project has had one rot for months behind
// exactly that. That counterpart is the one deliberate skip this file adds.
//
// What it holds, and why each one is the assertion it is:
//
//  1. THE COUNTS, with the negative control. 1 / 11 / 12 live on three missions
//     and ZERO on the other ten. The zero is the half that matters: a selection
//     rule that finds something everywhere it looks has not been tested, and
//     the two rules tried before this one both failed here rather than on the
//     positives (one admitted the ghost racer's meshes and a light projector on
//     five missions; the other missed every palm).
//
//  2. THE FRAME, as a SEPARATING assertion. A mission prop's `position` is
//     claimed to be in the same frame as an environment landmark's. Five of
//     rookie_02's spires are the same authored objects as desert's, so they
//     must land at 0.000 m — and a wrong `levelOffset` misses by ~2048 m. The
//     two candidate explanations disagree by three orders of magnitude, which
//     is what makes agreement evidence rather than coincidence. DEV-042 cost a
//     day by testing a frame only where the right story and the wrong one
//     agreed; this is the shape that would have caught it.
//
//  3. `solid` IS NOT THE NAME. `MM_BigRock_collider` has no collider at all
//     (classes 1/4/23/33/95 — no 64/65/135/136) and `Spire_B_w_Collision` has
//     one. The name told the truth in one case and lied in the other, so
//     neither is evidence, and a reader who trusts it gets a phantom rock.
//
//  4. NO DOUBLE-EMISSION. With `expandPrefabs: true` a prefab instance root
//     arrives twice — `kind: 'stripped'` and `kind: 'prefabAncestor'` — same
//     path, same transform, same mesh, different key. Two rows at one place is
//     the signature, so the test is on (path, position) being unique.
//
//  5. NO LOD CHILDREN. Each palm carries an LODGroup with `-LOD2`/`-LOD3`
//     children at the SAME transform. They are variants Unity picks between by
//     distance, not extra geometry; emitting them would triple-draw every palm.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { MissionProp } from '@/content/level-schema'
import type { PropLandmark } from '@/content/load-environment'
import { COINCIDENT_PROP_METRES, drawnLandmarks, landmarkMatrixOf } from '@/game/props/load-props'
import {
  environmentTerrains,
  terrainLocalPosition,
  terrainParams,
} from '@/game/terrain/load-terrain'
import { buildVertexGrid } from '@/sim/terrain/faceted'
import { type ImageData8, importUnityTexture } from '@/sim/terrain/image-sampler'
import { renderSurfaceHeightAt } from '@/sim/terrain/surface'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import {
  environmentJson as environment,
  levelJson as level,
  shippedLevelIds as missionIds,
} from './helpers/content'
import { glbShapeOf } from './helpers/prop-forest'
import { REPO as ROOT } from './helpers/repo-root'
import { MAPS } from './helpers/terrain-field'

/** `noUncheckedIndexedAccess` is on: a tuple read is `number | undefined`. */
const at = (v: readonly number[], i: number): number => v[i] ?? Number.NaN
const distance = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(at(a, 0) - at(b, 0), at(a, 1) - at(b, 1), at(a, 2) - at(b, 2))

const props = (id: string): MissionProp[] => level(id).props ?? []
const liveProps = (id: string): MissionProp[] => props(id).filter((p) => p.live)

/**
 * The three that place scenery, and what they place. Written out rather than
 * derived, because a test that re-derives its expectation the way the code does
 * has not tested the code (trap 24).
 */
const PLACERS: Record<string, { authored: number; live: number; liveSolid: number }> = {
  adv_01_jumpSeat: { authored: 1, live: 1, liveSolid: 1 },
  int_01_jumpSeat: { authored: 12, live: 11, liveSolid: 11 },
  rookie_02_jumpSeat: { authored: 16, live: 12, liveSolid: 9 },
}

describe('mission props — the counts, and the ten that have none', () => {
  it('finds all thirteen missions', () => {
    expect(missionIds()).toHaveLength(13)
  })

  it('places exactly the counted props on the three that place any', () => {
    for (const [id, want] of Object.entries(PLACERS)) {
      const all = props(id)
      expect(
        { id, authored: all.length, live: all.filter((p) => p.live).length },
        `${id} authored/live`,
      ).toEqual({ id, authored: want.authored, live: want.live })
      expect(
        all.filter((p) => p.live && p.solid),
        `${id} live solid`,
      ).toHaveLength(want.liveSolid)
    }
  })

  // THE NEGATIVE CONTROL. Ten missions place nothing, and this is the half of
  // the rule that the two rejected candidates failed.
  it('places NOTHING on the other ten', () => {
    const others = missionIds().filter((id) => !(id in PLACERS))
    expect(others).toHaveLength(10)
    for (const id of others) {
      expect(props(id), `${id} should place no props`).toHaveLength(0)
    }
  })

  it('draws no dead instance — five are authored and switched off', () => {
    const dead = missionIds().flatMap((id) => props(id).filter((p) => !p.live))
    expect(dead).toHaveLength(5)
    expect(dead.filter((p) => p.name.startsWith('Spire_B_w_Collision'))).toHaveLength(4)
    expect(dead.filter((p) => /Palmtree/.test(p.name))).toHaveLength(1)
  })
})

describe('mission props — the frame, as a separating assertion', () => {
  /**
   * rookie_02 re-instantiates `DesertSpires.prefab`, and desert's LevelArt
   * prefab carries its OWN embedded copy of the same authored field. Five of
   * them were never moved, so mission and environment must agree EXACTLY.
   *
   * 0.000 m against a ~2048 m error if `levelOffset` were not subtracted: the
   * tolerance below is 1 mm, which no wrong frame can pass by luck.
   */
  const EXACT_TWINS = ['Spire_B_w_Collision', 'Spire_C', 'Spire_C (1)', 'Spire_C (2)', 'Spire_D']

  it('puts a mission prop in the same frame as the environment landmark it duplicates', () => {
    const desert = environment('desert')
    const mission = props('rookie_02_jumpSeat')
    const seen: string[] = []
    for (const name of EXACT_TWINS) {
      const m = mission.find((p) => p.path === `levelOffset/DesertSpires/${name}`)
      const e = desert.landmarks.find((l) => l.path === `LevelArt_Desert/art/DesertSpires/${name}`)
      expect(m, `mission prop ${name}`).toBeDefined()
      expect(e, `desert landmark ${name}`).toBeDefined()
      const d = distance((m as MissionProp).position, (e as PropLandmark).position)
      expect(d, `${name} mission-vs-environment distance`).toBeLessThan(0.001)
      seen.push(name)
    }
    expect(seen).toHaveLength(EXACT_TWINS.length)
  })

  it('agrees on scale too, so the match is the object and not just the spot', () => {
    const desert = environment('desert')
    const m = props('rookie_02_jumpSeat').find(
      (p) => p.path === 'levelOffset/DesertSpires/Spire_B_w_Collision',
    ) as MissionProp
    const e = desert.landmarks.find(
      (l) => l.path === 'LevelArt_Desert/art/DesertSpires/Spire_B_w_Collision',
    ) as PropLandmark
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(at(m.scale, i) - at(e.scale ?? [], i)), `scale[${i}]`).toBeLessThan(0.001)
    }
  })

  // Every prop must land inside the 4096 m terrain square. A prop left in
  // mission-world space without the levelOffset subtraction goes negative —
  // rookie_02's first spire would sit at x = -778.
  it('lands every prop inside the terrain square', () => {
    for (const id of Object.keys(PLACERS)) {
      for (const p of props(id)) {
        expect(p.position[0], `${id} ${p.name} x`).toBeGreaterThanOrEqual(0)
        expect(p.position[0], `${id} ${p.name} x`).toBeLessThanOrEqual(4096)
        expect(p.position[2], `${id} ${p.name} z`).toBeGreaterThanOrEqual(0)
        expect(p.position[2], `${id} ${p.name} z`).toBeLessThanOrEqual(4096)
      }
    }
  })
})

describe('mission props — the traps', () => {
  // 3. The name is not evidence, in either direction.
  it('reads `solid` off the components, not off the name', () => {
    const r2 = props('rookie_02_jumpSeat')
    const bigRock = r2.find((p) => p.name === 'RocaGrandeLOW')
    expect(bigRock, 'the big rock').toBeDefined()
    // Placed under a node called MM_BigRock_collider, and it has NO collider.
    expect((bigRock as MissionProp).solid, 'MM_BigRock_collider has no collider').toBe(false)
    // Named ..._w_Collision, and it does have one.
    const spire = r2.find((p) => p.path === 'levelOffset/Spire_B_w_Collision')
    expect((spire as MissionProp).solid, 'Spire_B_w_Collision has one').toBe(true)
    // And two more collider-less ones whose names promise nothing either way.
    expect(r2.find((p) => p.name === 'Spire_C')?.solid).toBe(false)
    expect(r2.find((p) => p.name === 'Spire_D')?.solid).toBe(false)
  })

  // 4. The `expandPrefabs: true` double-emission.
  it('emits each placed object once, not twice', () => {
    for (const id of Object.keys(PLACERS)) {
      const keys = props(id).map((p) => `${p.path}@${p.position.join(',')}`)
      expect(new Set(keys).size, `${id} has a duplicated instance root`).toBe(keys.length)
    }
  })

  // 5. LOD variants are not extra geometry.
  it('emits no LOD child — a palm is one prop, not three', () => {
    const palms = props('int_01_jumpSeat')
    expect(palms.every((p) => !/-LOD\d+$/i.test(p.name))).toBe(true)
    // 12 authored roots, and every one of them a root: no `/GL-Palmtree-03-LOD2`
    // anywhere in a path's LAST segment.
    expect(palms).toHaveLength(12)
    for (const p of palms) {
      expect(p.mesh, `${p.name} draws LOD0`).toMatch(/GL-Palmtree-03\.fbx$/)
    }
  })
})

describe('mission props — how the renderer takes them', () => {
  // Rule 6: concatenated, not a second path. `drawnLandmarks` is the ONE filter
  // the renderer and the collider builder both go through, so proving the join
  // here proves it for both.
  it('concatenates mission props with environment landmarks through one filter', () => {
    const desert = environment('desert')
    const envOnly = drawnLandmarks(desert)
    const withMission = drawnLandmarks(desert, props('rookie_02_jumpSeat') as PropLandmark[])
    const live = liveProps('rookie_02_jumpSeat').filter((p) => !!p.meshAsset).length
    expect(live, 'live props with a mesh').toBe(12)
    // Twelve live, five of them coincident with rock the environment already
    // draws (DEV-218a), so seven reach the screen.
    expect(withMission.length - envOnly.length).toBe(7)
  })

  it('draws nothing extra for a mission that places none', () => {
    const desert = environment('desert')
    expect(drawnLandmarks(desert, props('adv_01_hoverJet') as PropLandmark[])).toHaveLength(
      drawnLandmarks(desert).length,
    )
  })

  it('gives every live prop a bucket asset, so nothing is dropped silently', () => {
    for (const id of Object.keys(PLACERS)) {
      for (const p of liveProps(id)) {
        expect(p.meshAsset, `${id} ${p.name} has no meshAsset`).toBeTruthy()
      }
    }
  })
})

describe('mission props — DEV-219, Simonet had vegetation and the port drew none', () => {
  /**
   * DEV-102 concluded "2016 scattered props in TWO environments" from the
   * generators being enabled-and-empty. That was right about the generators and
   * blind to this path: Simonet's vegetation was HAND-PLACED, in one mission
   * scene, so no generator census could have found it.
   */
  it('has every Simonet environment palm switched off', () => {
    const simonet = environment('simonet')
    const palms = simonet.landmarks.filter((l) => /palm/i.test(l.kind ?? l.name))
    expect(palms.length).toBeGreaterThan(0)
    expect(
      palms.every((l) => l.live !== true),
      'a live Simonet env palm',
    ).toBe(true)
  })

  it('places the only palms Simonet ever drew in int_01_jumpSeat', () => {
    const simonetMissions = missionIds().filter((id) => level(id).environment === 'simonet')
    const withPalms = simonetMissions.filter((id) => liveProps(id).some((p) => p.kind === 'palm'))
    expect(withPalms).toEqual(['int_01_jumpSeat'])
    expect(liveProps('int_01_jumpSeat').filter((p) => p.kind === 'palm')).toHaveLength(11)
  })
})

/**
 * THE GEOMETRY — where a mission prop actually ENDS UP, under the renderer's own
 * `landmarkMatrixOf`. Guarded on the gitignored assets, so it does not run in
 * CI, with a loud counterpart below: a skipped gate reads as a pass in a summary
 * line, and this project has had one rot for months behind exactly that.
 *
 * **Every disk read is INSIDE the `it`.** `describe.skipIf` skips the TESTS, not
 * the describe BODY, so anything above the guard runs during COLLECTION and
 * throws ENOENT precisely where the assets are absent — which is CI and only CI.
 *
 * Why a base/top relationship and not a quaternion: the orientation lesson. A
 * relationship with the RENDERED ground is true independently of what anyone
 * believed the rotation was, and this port has shipped a mirrored mesh, a
 * backwards ship, rolled gates and backwards ghosts — three of the four caught
 * by Matt from a screenshot rather than by four hundred green tests.
 */
const haveAssets = (): boolean =>
  fs.existsSync(path.join(ROOT, 'public', 'assets', 'props', 'spire-b.glb')) &&
  fs.existsSync(path.join(ROOT, 'public', 'assets', 'props', 'gl-palmtree-03.glb')) &&
  fs.existsSync(path.join(ROOT, MAPS.simonet as string)) &&
  fs.existsSync(path.join(ROOT, MAPS.desert as string))

interface GroundRow {
  name: string
  base: number
  top: number
  ground: number
}

/** Each live prop's drawn y-range against the rendered surface under it. */
const groundRows = (mission: string, env: 'simonet' | 'desert'): GroundRow[] => {
  const land = environmentTerrains(env).land
  const params = terrainParams(land)
  const tpos = terrainLocalPosition(land)
  const heightMap = importUnityTexture(
    decodePngBuffer(fs.readFileSync(path.join(ROOT, MAPS[env] as string)), env) as ImageData8,
  )
  const grid = buildVertexGrid(heightMap, params)
  const out: GroundRow[] = []
  const m = new THREE.Matrix4()
  const c = new THREE.Vector3()
  for (const l of liveProps(mission).filter((p) => !!p.meshAsset)) {
    const g = glbShapeOf(l.meshAsset as string)
    landmarkMatrixOf(l as PropLandmark, tpos, m)
    let base = Number.POSITIVE_INFINITY
    let top = Number.NEGATIVE_INFINITY
    for (const x of [g.min.x, g.max.x])
      for (const y of [g.min.y, g.max.y])
        for (const z of [g.min.z, g.max.z]) {
          c.set(x, y, z).applyMatrix4(m)
          base = Math.min(base, c.y)
          top = Math.max(top, c.y)
        }
    // The matrix is three space (z flipped); the surface wants mesh space.
    const mx = at(l.position, 0) - (tpos[0] ?? 0)
    const mz = at(l.position, 2) - (tpos[2] ?? 0)
    out.push({
      name: l.name,
      base,
      top,
      ground: renderSurfaceHeightAt(grid, heightMap, params, mx, mz),
    })
  }
  return out
}

describe.skipIf(!haveAssets())('mission props — the geometry, against the rendered ground', () => {
  it('stands all eleven palms on Simonet and buries none of them', () => {
    const rows = groundRows('int_01_jumpSeat', 'simonet')
    expect(rows).toHaveLength(11)
    for (const r of rows) {
      // A palm is 10-38 m tall. Base at or just under the surface, top above it.
      expect(r.base - r.ground, `${r.name} base floats`).toBeLessThan(5)
      expect(r.base - r.ground, `${r.name} base is buried`).toBeGreaterThan(-20)
      expect(r.top - r.ground, `${r.name} top is under the ground`).toBeGreaterThan(5)
    }
  })

  /**
   * The exact duplicates must land exactly where their environment twins land,
   * and `Spire_C (2)` is the one `landmarks.test.ts` already records as having
   * *"its top 53 m under the ground it stands in"* — 2016 authored five of
   * desert's spires INTO mesas. If the mission copy read anything else the
   * frame would be wrong in a way a position comparison cannot see, because
   * both copies would move together. It reads 53 m under as well.
   */
  it('buries `Spire_C (2)` exactly as deep as the environment does', () => {
    const c2 = groundRows('rookie_02_jumpSeat', 'desert').find((r) => r.name === 'Spire_C (2)')
    expect(c2, 'Spire_C (2)').toBeDefined()
    const under = (c2 as GroundRow).ground - (c2 as GroundRow).top
    expect(under, 'top below ground').toBeGreaterThan(50)
    expect(under, 'top below ground').toBeLessThan(56)
  })
})

describe.skipIf(haveAssets())('mission props — the loud counterpart', () => {
  it('says the geometry half did NOT run', () => {
    expect(haveAssets()).toBe(false)
  })
})

describe('mission props — DEV-218a, the duplicates 2016 drew on top of themselves', () => {
  /**
   * The five `rookie_02_jumpSeat` re-places exactly where desert's own LevelArt
   * prefab already has them. Named, not counted, so that if a different five
   * ever start matching the test says which.
   */
  const COINCIDENT = [
    'levelOffset/DesertSpires/Spire_B_w_Collision',
    'levelOffset/DesertSpires/Spire_C',
    'levelOffset/DesertSpires/Spire_C (1)',
    'levelOffset/DesertSpires/Spire_C (2)',
    'levelOffset/DesertSpires/Spire_D',
  ]

  // PATHS, not names. `Spire_B_w_Collision` names TWO different props here — the
  // DesertSpires child that is coincident and the standalone one 522 m away that
  // is not — so a name is ambiguous exactly where the answer differs.
  it('drops exactly the five coincident copies and keeps the seven that are real', () => {
    const desert = environment('desert')
    // Parsed ONCE: `props()` re-reads the file, and two parses give two object
    // identities, so an identity test against a second parse matches nothing.
    const mission = props('rookie_02_jumpSeat') as PropLandmark[]
    const drawn = drawnLandmarks(desert, mission)
    const live = mission.filter((m) => m.live === true && !!m.meshAsset)
    const kept = live.filter((m) => drawn.includes(m))
    const dropped = live.filter((m) => !drawn.includes(m))
    expect(dropped.map((d) => d.path).sort()).toEqual([...COINCIDENT].sort())
    expect(kept, 'mission props that reach the screen').toHaveLength(7)
  })

  /**
   * WHY THE THRESHOLD IS SAFE, held as the thing that actually matters: the
   * SEPARATION. Coincident pairs are at 0.000 m and the closest pair that is
   * genuinely two rocks is 13.7 m apart, so every threshold in that gap gives
   * the same answer. Asserting the gap rather than the constant means a future
   * mission authored 0.4 m off turns this red instead of silently vanishing.
   */
  it('separates coincident from merely nearby by three orders of magnitude', () => {
    const desert = environment('desert')
    const envDrawn = drawnLandmarks(desert)
    let worstCoincident = 0
    let closestDistinct = Number.POSITIVE_INFINITY
    for (const m of liveProps('rookie_02_jumpSeat')) {
      if (!m.meshAsset) continue
      let best = Number.POSITIVE_INFINITY
      for (const e of envDrawn) {
        if (e.mesh !== m.mesh) continue
        best = Math.min(best, distance(m.position, e.position))
      }
      if (!Number.isFinite(best)) continue
      if (COINCIDENT.includes(m.path)) worstCoincident = Math.max(worstCoincident, best)
      else closestDistinct = Math.min(closestDistinct, best)
    }
    expect(worstCoincident, 'the furthest "coincident" pair').toBeLessThan(0.001)
    expect(closestDistinct, 'the closest pair that is really two rocks').toBeGreaterThan(13)
    expect(COINCIDENT_PROP_METRES).toBeGreaterThan(worstCoincident)
    expect(COINCIDENT_PROP_METRES).toBeLessThan(closestDistinct)
  })

  it('never drops a mission prop that only a MISSION draws', () => {
    // Two are live here and switched OFF in the environment, so the environment
    // contributes nothing at those spots and dropping them would delete rock.
    const desert = environment('desert')
    const drawn = drawnLandmarks(desert, props('rookie_02_jumpSeat') as PropLandmark[])
    for (const p of [
      'levelOffset/DesertSpires/Spire_B_w_Collision (3)',
      'levelOffset/MM_BigRock_collider/RocaGrandeLOW',
      'levelOffset/Spire_B_w_Collision',
    ]) {
      expect(
        drawn.some((d) => d.path === p),
        `${p} is not a duplicate and must survive`,
      ).toBe(true)
    }
  })

  it('leaves the other two missions untouched — neither duplicates anything', () => {
    for (const [mission, env] of [
      ['adv_01_jumpSeat', 'desert'],
      ['int_01_jumpSeat', 'simonet'],
    ] as const) {
      const e = environment(env)
      const added =
        drawnLandmarks(e, props(mission) as PropLandmark[]).length - drawnLandmarks(e).length
      expect(added, `${mission} keeps every live prop`).toBe(
        liveProps(mission).filter((p) => !!p.meshAsset).length,
      )
    }
  })
})
