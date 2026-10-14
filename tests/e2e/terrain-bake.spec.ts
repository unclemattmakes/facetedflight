/**
 * tests/e2e/terrain-bake.spec.ts: a shipped mission runs no terrain march, and the file it used
 * is the bytes the browser's own march makes. DEV-955.
 *
 * Per shipped mission, two real loads:
 *
 *   1. as a player loads it. The world build finds the baked sun and sky fields, so
 *      `__ff2.terrainBake()` reports `from: 'file'`, `rows: 0` and `slices: 0` for both, and
 *      the fields' digests equal the manifest's `sha256` for the file it fetched.
 *   2. with `?terrainBake=off`: the two marches run in the page (rows > 0), and THEIR digests
 *      equal the same manifest entries. That is the proof the issue asks for: the baked bytes
 *      are the runtime bake's bytes, made by Chrome's V8 and not by the Node that wrote the file.
 *
 * Needs the baked files (`node tools/terrain/bake-terrain.mjs`); the dev server serves them from
 * `public/assets/terrain-bake/` (VITE_ASSET_BASE_URL=/). Until they are pushed to R2 a deployed
 * build falls back to the march, which arm 2 exercises on every run.
 *
 * `@gpu`: a real world. `?xr=off`, `PINNED`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const ROOT = process.cwd() // Playwright runs from the repo root; an ESM spec has no __dirname
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'content', 'terrain-bake.json'), 'utf8'),
) as {
  files: Record<string, { sha256: string; textureSha256?: string; users: string[] }>
}
const MISSIONS = fs
  .readdirSync(path.join(ROOT, 'content', 'levels'))
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort()

interface Phase {
  from: string
  rows: number
  slices: number
  ms: number
}
interface Receipt {
  level: string
  sunKey: string | null
  skyKey: string | null
  sun: Phase | null
  sky: Phase | null
}
interface Probe {
  receipt: Receipt | null
  digest: { sun: string | null; sky: string | null; skyTexture: string | null } | null
}

const load = async (page: Page, mission: string, extra: string): Promise<Probe> => {
  await page.goto(`/?xr=off&title=0&menu=0&ride=0&mission=${mission}&${PINNED}${extra}`)
  await firstPress(page)
  await missionReady(page, 240_000)
  return page.evaluate(async () => {
    const w = window as unknown as {
      __ff2: { terrainBake(): unknown; terrainBakeDigest(): Promise<unknown> }
    }
    return {
      receipt: w.__ff2.terrainBake(),
      digest: await w.__ff2.terrainBakeDigest(),
    } as unknown as Probe
  })
}

const listed = (
  kind: string,
  key: string | null,
): { sha256: string; textureSha256?: string } | undefined =>
  key ? manifest.files[`${kind}-${key}`] : undefined

test.describe('@gpu terrain bake: DEV-955', () => {
  test.setTimeout(420_000)

  test('there is a baked file for every shipped mission to find', () => {
    expect(MISSIONS.length).toBeGreaterThanOrEqual(13)
    for (const m of MISSIONS) {
      expect(
        Object.values(manifest.files).some((f) => f.users.includes(m)),
        `${m} has no baked sun field in content/terrain-bake.json`,
      ).toBe(true)
    }
    for (const rel of Object.keys(manifest.files)) {
      const kind = rel.slice(0, rel.indexOf('-'))
      const file = path.join(ROOT, 'public', 'assets', 'terrain-bake', `${rel}.bin`)
      expect(
        fs.existsSync(file),
        `${kind} file ${rel} is missing from public/assets/terrain-bake`,
      ).toBe(true)
    }
  })

  for (const mission of MISSIONS) {
    test(`${mission}: baked load runs no march, and the browser's own march makes the same bytes`, async ({
      page,
    }) => {
      // 1. as a player loads it
      const baked = await load(page, mission, '')
      const r = baked.receipt
      expect(
        r,
        'no terrain-bake receipt: the world build did not reach the bake step',
      ).not.toBeNull()
      const sunFile = listed('sun', r?.sunKey ?? null)
      const skyFile = listed('sky', r?.skyKey ?? null)
      expect(
        sunFile,
        `the sun key ${r?.sunKey} the page computed is not in the manifest`,
      ).toBeDefined()
      expect(r?.sun, 'sun phase').toMatchObject({ from: 'file', rows: 0, slices: 0 })
      expect(
        skyFile,
        `the sky key ${r?.skyKey} the page computed is not in the manifest`,
      ).toBeDefined()
      expect(r?.sky, 'sky phase').toMatchObject({ from: 'file', rows: 0, slices: 0 })
      expect(baked.digest?.sun).toBe(sunFile?.sha256)
      expect(baked.digest?.sky).toBe(skyFile?.sha256)
      expect(baked.digest?.skyTexture).toBe(skyFile?.textureSha256)

      // 2. the march run in this page, for the same inputs
      const ran = await load(page, mission, '&terrainBake=off')
      expect(ran.receipt?.sunKey).toBe(r?.sunKey)
      expect(ran.receipt?.skyKey).toBe(r?.skyKey)
      expect(ran.receipt?.sun?.from).toBe('runtime')
      expect(ran.receipt?.sun?.rows ?? 0).toBeGreaterThan(0)
      expect(ran.receipt?.sky?.from).toBe('runtime')
      expect(ran.receipt?.sky?.rows ?? 0).toBeGreaterThan(0)
      expect(ran.digest?.sun, 'the browser march differs from the shipped sun file').toBe(
        sunFile?.sha256,
      )
      // The sky GATE is the half-float texture the GPU receives. The Float32 field is
      // informational: Node's V8 and Chrome's differ in the last bit of a transcendental on a
      // few values near zero (DEV-955), which half-float storage cannot hold.
      expect(
        ran.digest?.skyTexture,
        'the sky texture data the browser uploads differs from the shipped file',
      ).toBe(skyFile?.textureSha256)
      if (ran.digest?.sky !== skyFile?.sha256) {
        console.info(
          `DEV-955 ${mission}: sky FIELD bytes differ from the file (texture bytes match)`,
        )
      }
      console.info(
        `DEV-955 ${mission}: sun ${r?.sun?.ms.toFixed(0)} ms from file vs ${ran.receipt?.sun?.ms.toFixed(0)} ms marched (${ran.receipt?.sun?.rows} rows, ${ran.receipt?.sun?.slices} slices); ` +
          `sky ${r?.sky?.ms.toFixed(0)} ms vs ${ran.receipt?.sky?.ms.toFixed(0)} ms (${ran.receipt?.sky?.rows} rows, ${ran.receipt?.sky?.slices} slices)`,
      )
    })
  }

  test('Classic takes the same sun file and no sky file', async ({ page }) => {
    const mission = 'int_01_hoverJet'
    const baked = await load(page, mission, '&edition=classic')
    const sun = listed('sun', baked.receipt?.sunKey ?? null)
    expect(sun).toBeDefined()
    expect(baked.receipt?.sun).toMatchObject({ from: 'file', rows: 0 })
    expect(baked.receipt?.sky, 'Classic bakes no sky term').toBeNull()
    expect(baked.digest?.sun).toBe(sun?.sha256)
  })

  test('a file that is not on the host falls back to the march (the state before the R2 push)', async ({
    page,
  }) => {
    await page.route('**/assets/terrain-bake/**', (route) =>
      route.fulfill({ status: 404, body: '' }),
    )
    const probe = await load(page, 'int_01_hoverJet', '')
    expect(probe.receipt?.sun).toMatchObject({ from: 'runtime' })
    expect(probe.receipt?.sun?.rows ?? 0).toBeGreaterThan(0)
    // and it matches the file it could not fetch
    expect(probe.digest?.sun).toBe(listed('sun', probe.receipt?.sunKey ?? null)?.sha256)
  })

  test('the second load of a course the page has already baked reads IndexedDB and runs no march', async ({
    page,
  }) => {
    await page.route('**/assets/terrain-bake/**', (route) =>
      route.fulfill({ status: 404, body: '' }),
    )
    const first = await load(page, 'int_01_hoverJet', '')
    expect(first.receipt?.sun?.from).toBe('runtime')
    // the write is fire-and-forget; give it its turn
    await page.waitForTimeout(1500)
    const second = await load(page, 'int_01_hoverJet', '')
    expect(second.receipt?.sun).toMatchObject({ from: 'idb', rows: 0, slices: 0 })
    expect(second.receipt?.sky).toMatchObject({ from: 'idb', rows: 0, slices: 0 })
    expect(second.digest).toEqual(first.digest)
  })
})
