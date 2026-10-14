// tests/unit/terrain-bake-shipped.test.ts: the shipped terrain bakes are what the code makes today. DEV-955.
//
// SLOW TIER (tests/slow.list.json): it marches every shipped mission's terrain, about 20 s
// of CPU. It is the guard `TERRAIN_BAKE_VERSION` leans on: the key hashes the INPUTS, so a
// change to the marching code itself moves no key, and this is what goes red when the code
// moves and the files (or the version) did not.
//
// Needs the terrain maps (`pnpm assets:pull`) and the baked files (`node
// tools/terrain/bake-terrain.mjs`). Where the maps are absent the tests skip, and the loud
// counterpart says so in a hydrated maintainer checkout.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { editionIds, loadEdition } from '@/content/load-edition'
import { levelIds, loadLevel } from '@/content/load-level'
import { skyBakeWantedBy } from '@/render/sky-visibility'
import { bakeShipped, terrainMapsPresent } from '../../tools/terrain/terrain-bake-lib'
import { HYDRATED_MAINTAINER_CHECKOUT } from './helpers/checkout'
import { REPO } from './helpers/repo-root'

const HAVE = terrainMapsPresent()
const manifestPath = path.join(REPO, 'content', 'terrain-bake.json')

describe.skipIf(!HAVE)('the shipped terrain bakes', () => {
  it('are byte-identical to a fresh bake, and the manifest lists exactly them', async () => {
    const files = await bakeShipped()
    expect(files.length).toBeGreaterThan(0)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      files: Record<string, { bytes: number; sha256: string; users: string[] }>
    }
    expect(Object.keys(manifest.files).sort()).toEqual(
      files.map((f) => `${f.kind}-${f.key}`).sort(),
    )
    for (const f of files) {
      const onDisk = fs.readFileSync(path.join(REPO, 'public', f.asset))
      expect(
        Buffer.compare(onDisk, Buffer.from(f.bytes)),
        `${f.asset} differs from a fresh bake: run node tools/terrain/bake-terrain.mjs (and bump TERRAIN_BAKE_VERSION if the marching code changed)`,
      ).toBe(0)
      const entry = manifest.files[`${f.kind}-${f.key}`]
      expect(entry?.sha256).toBe(f.sha256)
      expect(entry?.bytes).toBe(f.bytes.length)
    }
  }, 300_000)

  it('cover every shipped level, and every level under every preset that bakes the sky', async () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      files: Record<string, { users: string[] }>
    }
    const users = (kind: string) =>
      new Set(
        Object.entries(manifest.files)
          .filter(([k]) => k.startsWith(`${kind}-`))
          .flatMap(([, v]) => v.users),
      )
    const sunUsers = users('sun')
    const skyUsers = users('sky')
    const editions = await Promise.all(
      editionIds().map(async (id) => ({ id, e: await loadEdition(id) })),
    )
    let withSun = 0
    for (const id of await levelIds(() => true)) {
      const level = await loadLevel(id)
      if (!level.lighting?.sun?.direction) continue
      withSun++
      expect(sunUsers.has(id), `${id} has no baked sun field`).toBe(true)
      for (const { id: eid, e } of editions) {
        if (skyBakeWantedBy(e.render.skyVisibility)) {
          expect(skyUsers.has(`${id}@${eid}`), `${id}@${eid} has no baked sky field`).toBe(true)
        }
      }
    }
    expect(withSun).toBeGreaterThan(10)
  }, 120_000)
})

describe.skipIf(HAVE || !HYDRATED_MAINTAINER_CHECKOUT)('the terrain maps are missing', () => {
  it('says so: a hydrated maintainer checkout has them', () => {
    expect(HAVE).toBe(true)
  })
})
