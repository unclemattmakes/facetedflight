// tests/unit/terrain-env-root.test.ts — where an environment's terrain really sits.
//
// `transform.position` in the generated sheet is LOCAL to the LevelArt root, and
// for a day the sheet's own note claimed the environment scene "instantiates at
// the origin with no overrides (checked)". That is true for simonet, alpine and
// desert and FALSE for kauai, whose `LevelArt_Kauai` is an unpacked copy sitting
// at (-2218, 0, -1691) under `levelOffset`. It was checked where the wrong
// answer and the right one agree — the same failure as the centre/corner rule in
// DEV-042.
//
// `transform.envRoot` is the fix, and it is DERIVED, which per DEV-027 means it
// needs a test: nothing in D10's machine guards a number the extractor computes
// for itself.
//
// The oracle is a SECOND code path. These values were measured by composing the
// full parent chain with `tools/prototype/unity_scene_to_json.js` — the scene
// flattener, which resolves prefabs — and reading each terrain's world position
// directly, rather than by re-running the summation this is testing:
//
//   alpine  terrain world (-2157.919624, 15.881851, -1867.14154)
//   desert  terrain world (-2157.919624, 15.881851, -1867.14154)
//   kauai   terrain world (-4266, 68, -3739)
//   kauai   water   world (-19215, -46.08, -17431)
//
// Subtract each terrain's own local position and the level's worldOffset
// (-2048, 0, -2048) and what is left is `envRoot`. Two independent routes to the
// same numbers is the point; one route is a belief.
//
// ── The half that was missing: a SUM is not a COMPOSITION ─────────────────
//
// `envRoot` adds local positions up the father chain. That equals composing the
// chain as matrices only while every node in it is unrotated and unit-scaled —
// and for as long as `envRoot` existed, nothing said so. A rotated parent would
// have produced an `envRoot` that is silently wrong, in the shape this project
// keeps getting caught by: the two readings agree on every case that exists, so
// the weaker one looks proven.
//
// It is not hypothetical. Measured through the flattener, `AlpineTerrain_menu`'s
// terrain has LOCAL rotation identity and WORLD rotation
// {0.008479, 0.865218, 0.05756, -0.498009} — its own prefab ROOT is rotated, and
// `main_menu.unity` hangs that prefab under two more rotated parents at yaw
// -86.92 (DEV-042). The root is the walk's stop node and is deliberately not
// counted, so the menu terrain is fine; but the rotated node is one level away
// from a chain the walk WOULD count.
//
// So `transform.envRootRigid` now records it, and the oracle below is the same
// second code path: for a rigid chain the flattener's composed WORLD rotation
// and scale must equal the terrain's OWN LOCAL rotation and scale, because a
// rigid chain contributes nothing but translation. Menu is the measured
// counter-example that proves the check can fail.

import { describe, expect, it } from 'vitest'
import { TERRAIN } from '@/generated/constants.generated'

type Entry = {
  transform: {
    position: number[]
    envRoot: number[]
    envRootRigid?: boolean
    /** xyzw, the terrain's OWN local rotation. */
    rotation?: number[]
    scale?: number[]
  }
}
type Sheet = Record<string, { terrains: Record<string, Entry> }>
const sheet = TERRAIN as unknown as Sheet

/** Every level's `worldOffset`, in UNITY space. The `levelOffset` GameObject. */
const WORLD_OFFSET = [-2048, 0, -2048] as const

/** Unity's identity quaternion, xyzw — the order the sheet stores rotations in. */
const IDENTITY = [0, 0, 0, 1] as const

/** Measured through the flattener. See the header. */
const WORLD = {
  'alpine.forest': [-2157.919624, 15.881851, -1867.14154],
  'desert.canyon': [-2157.919624, 15.881851, -1867.14154],
  'kauai.terrain': [-4266, 68, -3739],
  'kauai.ocean': [-19215, -46.08, -17431],
  'simonet.islands': [-2157.91968, -81.69, -1867.1416],
} as const

describe('a terrain knows where it actually is', () => {
  it('envRoot + worldOffset + local reproduces the measured world position', () => {
    for (const [key, world] of Object.entries(WORLD)) {
      const [env, leaf] = key.split('.') as [string, string]
      const t = sheet[env]?.terrains?.[leaf]
      expect(t, `${key} missing from the sheet`).toBeDefined()
      const local = t?.transform.position as number[]
      const root = t?.transform.envRoot as number[]
      for (let i = 0; i < 3; i++) {
        expect(
          (local[i] as number) + (root[i] as number) + (WORLD_OFFSET[i] as number),
          `${key} axis ${'xyz'[i]}`,
        ).toBeCloseTo(world[i] as number, 3)
      }
    }
  })

  it('only kauai is displaced — which is why "(checked)" survived on the others', () => {
    // The structural claim, stated separately from the numbers. If a future
    // environment lands with a non-zero envRoot this SHOULD fail and be read,
    // not silently widened.
    const displaced: string[] = []
    for (const [env, v] of Object.entries(sheet)) {
      for (const [leaf, t] of Object.entries(v.terrains)) {
        const r = t.transform.envRoot
        if (r.some((n) => Math.abs(n) > 1e-6)) displaced.push(`${env}.${leaf}`)
      }
    }
    expect(displaced.sort()).toEqual(['kauai.ocean', 'kauai.terrain'])
  })

  it('kauai carries the SAME displacement on both of its terrains', () => {
    // Land and water are siblings under one moved root, so a value that differs
    // between them would mean the walk picked up something else on the way.
    const land = sheet.kauai?.terrains?.terrain?.transform.envRoot
    const water = sheet.kauai?.terrains?.ocean?.transform.envRoot
    expect(land).toEqual(water)
    expect(land).toEqual([-2218, 0, -1691])
  })

  it('every terrain in the sheet has an envRoot at all', () => {
    for (const [env, v] of Object.entries(sheet)) {
      for (const [leaf, t] of Object.entries(v.terrains)) {
        expect(Array.isArray(t.transform.envRoot), `${env}.${leaf}`).toBe(true)
        expect(t.transform.envRoot).toHaveLength(3)
      }
    }
  })

  it('every counted chain is RIGID, so the sum is a composition', () => {
    // If this ever fails, `envRoot` is a number that does not compose and
    // nothing may add it to anything — read the extractor's warning, do not
    // widen the tolerance.
    for (const [env, v] of Object.entries(sheet)) {
      for (const [leaf, t] of Object.entries(v.terrains)) {
        expect(t.transform.envRootRigid, `${env}.${leaf} envRootRigid`).toBe(true)
      }
    }
  })

  it('the flattener agrees: a rigid chain adds no rotation and no scale', () => {
    // Measured through `tools/prototype/unity_scene_to_json.js`, which composes
    // the chain as 4x4 matrices and decomposes the result — the second code
    // path again, and this time for the half of the transform `envRoot` cannot
    // carry. LOCAL is what the sheet records; WORLD is what the chain produces.
    const MEASURED = {
      'alpine.forest': { local: IDENTITY, world: IDENTITY, scale: [1, 1, 1] },
      'desert.canyon': { local: IDENTITY, world: IDENTITY, scale: [1, 1, 1] },
      'kauai.terrain': { local: IDENTITY, world: IDENTITY, scale: [1, 1, 1] },
      'kauai.ocean': { local: IDENTITY, world: IDENTITY, scale: [8, 1, 8] },
      'simonet.islands': { local: IDENTITY, world: IDENTITY, scale: [1, 1, 1] },
      'simonet.ocean': { local: IDENTITY, world: IDENTITY, scale: [8, 1, 8] },
    } as const
    for (const [key, m] of Object.entries(MEASURED)) {
      const [env, leaf] = key.split('.') as [string, string]
      const t = sheet[env]?.terrains?.[leaf]
      expect(t, `${key} missing from the sheet`).toBeDefined()
      expect(m.world, `${key}: the chain rotated the terrain`).toEqual(m.local)
      expect(t?.transform.rotation, `${key} rotation`).toEqual([...m.local])
      expect(t?.transform.scale, `${key} scale`).toEqual([...m.scale])
    }
  })

  it('the menu prefab ROOT is rotated — the case that proves the check bites', () => {
    // `AlpineTerrain_menu/terrain (1)`: LOCAL rotation identity, WORLD rotation
    // {0.008479, 0.865218, 0.05756, -0.498009}, measured through the flattener.
    // The root is the stop node, so it is not counted and `menu.forest` stays
    // rigid — but this is a real rotated node one link outside the walk, and it
    // is why `envRootRigid` is not an assertion about nothing. The title screen
    // never uses this placement: `src/boot/app.ts` frames the valley in
    // TERRAIN-RELATIVE coordinates and parks it 30 km away (DEV-042).
    const menuTerrainWorldRotation = [0.008479, 0.865218, 0.05756, -0.498009] as const
    expect(menuTerrainWorldRotation).not.toEqual([...IDENTITY])
    expect(sheet.menu?.terrains?.forest?.transform.rotation).toEqual([...IDENTITY])
    expect(sheet.menu?.terrains?.forest?.transform.envRootRigid).toBe(true)
    expect(sheet.menu?.terrains?.forest?.transform.envRoot).toEqual([0, 0, 0])
  })
})
