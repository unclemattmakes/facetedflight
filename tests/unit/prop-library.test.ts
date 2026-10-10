// tests/unit/prop-library.test.ts — the prop library, regenerated and compared.
// DEV-504 (docs/plan/EDITOR-PROPS.md, "The library").
//
// `src/content/prop-library.generated.ts` is built from `content/environments/*.json` by
// `buildPropLibrary`; this file builds it again and compares the BYTES, so the
// table is the environments' own vocabulary and not a list somebody typed.
// `PROP_LIBRARY_WRITE=1` writes the bytes first, and is the only way the file
// should change.
//
// The other assertions hold the table to things OUTSIDE the builder (trap 24):
// the islands a shipped mission flies over, the environment's own placement
// matrix (`instanceMatrixOf`, the scatter's function), and the glTF files'
// own node transforms, which the landmark path does not draw (DEV-196).

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { generatedLevelIds, loadLevel } from '@/content/load-level'
import {
  buildPropLibrary,
  PROP_LIBRARY,
  type PropLibrarySource,
  propDisplayName,
  propEntry,
  propGroups,
  serialisePropLibrary,
} from '@/content/prop-library'
import { REPO as ROOT } from './helpers/repo-root'

const FILE = path.join(ROOT, 'src', 'content', 'prop-library.generated.ts')
const ENV_DIR = path.join(ROOT, 'content', 'environments')

/** The islands a shipped mission flies over, alphabetically: the table's places. */
const islands = async (): Promise<string[]> => {
  const envs = new Set<string>()
  for (const id of generatedLevelIds()) envs.add((await loadLevel(id)).environment)
  return [...envs].sort()
}

const sourceOf = (id: string): PropLibrarySource =>
  JSON.parse(fs.readFileSync(path.join(ENV_DIR, `${id}.json`), 'utf8')) as PropLibrarySource

describe('DEV-504 — src/content/prop-library.generated.ts', () => {
  it('regenerates byte-identical from the islands’ environment files', async () => {
    const built = serialisePropLibrary(buildPropLibrary((await islands()).map(sourceOf)))
    if (process.env.PROP_LIBRARY_WRITE === '1') fs.writeFileSync(FILE, built)
    const committed = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n')
    if (committed !== built) {
      const a = committed.split('\n')
      const b = built.split('\n')
      const at = a.findIndex((line, i) => line !== b[i])
      expect.fail(
        `src/content/prop-library.generated.ts is stale at line ${at + 1}:\n  committed: ${a[at]}\n  built:     ${b[at]}\n` +
          'Rebuild with `PROP_LIBRARY_WRITE=1 npx vitest run tests/unit/prop-library.test.ts` and commit it.',
      )
    }
  })

  it('its places are the four islands, and the menu valley is not one', async () => {
    expect(PROP_LIBRARY.places).toEqual(await islands())
    expect(PROP_LIBRARY.places).toEqual(['alpine', 'desert', 'kauai', 'simonet'])
  })

  it('holds every mesh an island draws or authors, once', () => {
    const want = new Set<string>()
    for (const id of PROP_LIBRARY.places) {
      const env = sourceOf(id)
      for (const pass of env.scatter)
        for (const p of pass.palette) if (p.meshAsset) want.add(p.meshAsset)
      for (const l of env.landmarks) if (l.meshAsset) want.add(l.meshAsset)
    }
    const have = PROP_LIBRARY.entries.map((e) => e.asset)
    expect(new Set(have).size).toBe(have.length)
    expect([...have].sort()).toEqual([...want].sort())
    // The ids and the names are unique, so a list and a course can name one.
    const ids = PROP_LIBRARY.entries.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    const names = PROP_LIBRARY.entries.map((e) => e.name)
    expect(new Set(names).size).toBe(names.length)
    for (const e of PROP_LIBRARY.entries) expect(propEntry(e.id)).toBe(e)
  })

  it('a scattered mesh keeps its palette’s wrapper transform and its pass’s scale range', () => {
    for (const id of PROP_LIBRARY.places) {
      for (const pass of sourceOf(id).scatter) {
        for (const p of pass.palette) {
          if (!p.meshAsset) continue
          const e = PROP_LIBRARY.entries.find((x) => x.asset === p.meshAsset)
          expect(e?.from).toBe('scatter')
          expect(e?.places).toContain(id)
          expect(e?.scale.min).toBeLessThanOrEqual(pass.scaleMin + 1e-9)
          expect(e?.scale.max).toBeGreaterThanOrEqual(pass.scaleMax - 1e-9)
          const mt = p.meshTransform
          for (let k = 0; k < 3; k++) {
            expect(e?.rest.position[k]).toBeCloseTo(mt?.position[k] ?? 0, 6)
            expect(e?.rest.scale[k]).toBeCloseTo(mt?.scale[k] ?? 1, 6)
          }
          for (let k = 0; k < 4; k++) {
            expect(e?.rest.rotation[k]).toBeCloseTo(mt?.rotation[k] ?? (k === 3 ? 1 : 0), 6)
          }
        }
      }
    }
  })

  it('a hand-placed mesh rests as the first instance an island DRAWS', () => {
    const spire = propEntry('spire-b')
    expect(spire?.from).toBe('landmark')
    // Desert's first live Spire_B, in the table's island order.
    const desert = sourceOf('desert').landmarks.find(
      (l) => l.meshAsset === 'assets/props/spire-b.glb' && l.live === true,
    )
    expect(spire?.rest.rotation).toEqual(desert?.rotation?.map((v) => Math.round(v * 1e6) / 1e6))
    expect(spire?.rest.scale).toEqual(desert?.scale?.map((v) => Math.round(v * 1e6) / 1e6))
    expect(spire?.scale).toEqual({ min: 1, max: 1, default: 1 })
    // Simonet draws its one spire too (DEV-135), so it is one of the spire's places.
    expect(spire?.places).toEqual(['desert', 'simonet'])
    // The big rock no island draws: it rests where desert authored it.
    expect(propEntry('rocagrandelow')?.places).toEqual(['desert'])
    // A palm the palettes draw on the two tropical islands is theirs, not the
    // desert's, whose copy of it is switched off.
    expect(propEntry('gl-palmtree-01')?.places).toEqual(['kauai', 'simonet'])
  })

  it('names come from the assets’ own names', () => {
    expect(propDisplayName('Assets/X/Prefabs/Cactus_Tall_01.prefab')).toBe('Cactus tall 01')
    expect(propDisplayName('Spire_B_w_Collision')).toBe('Spire B')
    expect(propDisplayName('RocaGrandeLOW')).toBe('Roca grande low')
    expect(propDisplayName('Tree10.prefab')).toBe('Tree 10')
    expect(propEntry('tree-palm-01')?.name).toBe('Tree palm 01')
  })

  it('groups by place, the base’s own island first, each mesh once', () => {
    for (const first of PROP_LIBRARY.places) {
      const groups = propGroups(first)
      expect(groups[0]?.place).toBe(first)
      const listed = groups.flatMap((g) => g.entries.map((e) => e.id))
      expect(new Set(listed).size).toBe(listed.length)
      expect(listed.length).toBe(PROP_LIBRARY.entries.length)
      // The base's group is everything its island uses.
      const own = PROP_LIBRARY.entries.filter((e) => e.places.includes(first)).map((e) => e.id)
      expect(groups[0]?.entries.map((e) => e.id).sort()).toEqual(own.sort())
    }
  })
})

// ── The glTF nodes the landmark path does not draw ────────────────────────

const glbNodes = (
  file: string,
): {
  mesh?: number
  matrix?: number[]
  translation?: number[]
  rotation?: number[]
  scale?: number[]
}[] => {
  const b = fs.readFileSync(file)
  const len = b.readUInt32LE(12)
  return (JSON.parse(b.subarray(20, 20 + len).toString('utf8')) as { nodes: [] }).nodes
}

const ASSETS = path.join(ROOT, 'public')
const haveAssets = fs.existsSync(path.join(ASSETS, 'assets', 'props', 'cactus-tall-01.glb'))

describe.skipIf(!haveAssets)('DEV-504 — every scattered mesh has an identity mesh node', () => {
  it('so the landmark path, which draws no node, draws it as the scatter does', () => {
    for (const e of PROP_LIBRARY.entries) {
      if (e.from !== 'scatter') continue
      for (const n of glbNodes(path.join(ASSETS, e.asset))) {
        if (n.mesh === undefined) continue
        const m = new THREE.Matrix4()
        if (n.matrix) m.fromArray(n.matrix)
        else {
          m.compose(
            new THREE.Vector3(...((n.translation ?? [0, 0, 0]) as [number, number, number])),
            new THREE.Quaternion(
              ...((n.rotation ?? [0, 0, 0, 1]) as [number, number, number, number]),
            ),
            new THREE.Vector3(...((n.scale ?? [1, 1, 1]) as [number, number, number])),
          )
        }
        expect(m.equals(new THREE.Matrix4()), `${e.asset}'s mesh node`).toBe(true)
      }
    }
  })
})

describe.skipIf(haveAssets)('DEV-504 — the node check above is skipped here', () => {
  it('because public/assets is not hydrated (CI); the main checkout runs it', () => {
    expect(haveAssets).toBe(false)
  })
})
