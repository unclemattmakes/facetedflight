/**
 * An island from a seed, previewed on the dialog's diorama and built once.
 * DEV-493 (docs/plan/EDITOR-WAVE-3.md, T1).
 *
 * In by COURSES → MAKE A COURSE; "New island from a seed"; Reroll a few times
 * (each redraws the diorama from the preview grid, timed in the page), then
 * three fixed seeds are each USED — the world built over them, the pad found
 * on dry land — and photographed. (That a seeded course fits in a link is
 * `tests/unit/island-synth.test.ts`'s.)
 *
 * Photos go to `EDITOR_PHOTO_DIR` (default `test-results/editor-seed`).
 * Tagged `@gpu`, tier pinned (`PINNED`).
 */

import path from 'node:path'
import { groundKey, islandPeakHeight } from '../../src/content/player-course'
import { ISLAND_SYNTH_VERSION } from '../../src/sim/terrain/island-synth'
import { missionReady } from './fixtures/boot'
import { collectPageErrors, openEditorFromTitle, waitForEditor } from './fixtures/editor-boot'
import type { Ff2Global } from './fixtures/ff2'
import { photographer } from './fixtures/photo'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.EDITOR_PHOTO_DIR ?? path.join('test-results', 'editor-seed')

interface DeskProbe {
  groundReady: boolean
  ground: string
  worldGround: string
  pad: [number, number, number]
  warnings: string[]
}

/** The pad's own warnings: in the water, on a slope, or in the ground. */
const PAD_TROUBLE = new Set(['pad-in-water', 'pad-slope', 'pad-in-ground'])
const desk = (page: Page): Promise<DeskProbe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const d = w.__ff2.editor().desk
    if (!d) throw new Error('the desk has not loaded')
    return d
  }) as Promise<DeskProbe>

const photo = photographer(OUT)

/** The three seeds photographed: one broad and smooth, one rugged, one small in open sea. */
/** DEV-499, DEV-534: the seed dialog's height starts at Simonet's measured summit above its sea. */
const HEIGHT = islandPeakHeight('simonet') as number

const SEEDS = [
  { seed: 1, rugged: '0.25', sea: '0.2' },
  { seed: 490, rugged: '0.75', sea: '0.45' },
  { seed: 2026, rugged: '0.5', sea: '0.8' },
] as const

test.describe('@gpu an island from a seed (DEV-493)', () => {
  test.setTimeout(900_000)

  test('rerolls preview on the diorama, and three seeds each build a world once', async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page)
    // The desk's own receipt that a new draft's pad was seated on dry, flat ground.
    let seated = 0
    page.on('console', (m) => {
      if (m.text().startsWith('editor: the start pad stands on dry, flat ground')) seated++
    })
    await openEditorFromTitle(page)

    // ── Reroll: the diorama redraws from the preview grid ───────────────
    await page.locator('[data-editor="island-seed"]').click()
    const dialog = page.locator('#island-dialog')
    await expect(dialog).toHaveAttribute('data-state', 'ready')
    const times: number[] = []
    for (let i = 0; i < 4; i++) {
      const before = await dialog.getAttribute('data-preview')
      await page.locator('[data-editor="island-reroll"]').click()
      await expect(dialog).not.toHaveAttribute('data-preview', before as string)
      times.push(Number(await dialog.getAttribute('data-preview-ms')))
    }
    console.log(`[DEV-493] reroll previews (synthesis + diorama), ms: ${times.join(', ')}`)
    expect(Math.max(...times), 'a reroll is a preview, not a world build').toBeLessThan(250)
    await page.locator('[data-editor="island-cancel"]').click()
    await expect(dialog).toHaveCount(0)

    // ── three seeds, each used: the world built once over it ────────────
    for (const s of SEEDS) {
      await page.locator('[data-editor="island-seed"]').click()
      await dialog.locator('[data-editor="island-seed-number"]').fill(String(s.seed))
      await dialog.locator('[data-editor="island-seed-number"]').press('Enter')
      await dialog.locator('[data-editor="island-rugged"]').fill(s.rugged)
      await dialog.locator('[data-editor="island-sea"]').fill(s.sea)
      await expect(dialog).toHaveAttribute(
        'data-preview',
        // DEV-499: the height starts at the island's own sheet scale.
        `${s.seed}:4096:${HEIGHT}:${Number(s.rugged)}:${Number(s.sea)}`,
      )
      await page.waitForTimeout(800)
      await photo(page, `seed-${s.seed}-preview.png`)
      const seatedBefore = seated
      await dialog.locator('[data-editor="island-use"]').click()
      await expect(dialog).toHaveCount(0)
      // The switch runs behind a fade: wait for it to BEGIN, so what follows reads the new world.
      await expect(page.locator('body')).toHaveAttribute('data-editor', 'switching', {
        timeout: 30_000,
      })
      await expect
        .poll(async () => (await desk(page)).worldGround, { timeout: 60_000 })
        .toMatch(new RegExp(`^seed:${s.seed}:`))
      await missionReady(page)
      await waitForEditor(page)
      // The new draft's pad is seated once its world is here (the desk says so),
      // on dry, flat ground: judged by the editor's own pad warnings, not by a
      // sea height. (This compared `pad[1]` with 116.6 until the DEV-501
      // follow-up: a seeded island's flat shore stands at 115–117 m over a sea
      // drawn at ~116.1, dry by every check the pad has, and failed it.)
      await expect.poll(() => seated, { timeout: 20_000 }).toBeGreaterThan(seatedBefore)
      const after = await desk(page)
      expect(after.warnings.filter((k) => PAD_TROUBLE.has(k))).toEqual([])
      await page.waitForTimeout(1_500)
      await photo(page, `seed-${s.seed}-editor.png`)
    }

    // ── the draft names the seed it stands on ───────────────────────────
    const d = await desk(page)
    expect(d.ground).toBe(d.worldGround)
    expect(d.ground).toBe(
      groundKey({
        v: ISLAND_SYNTH_VERSION,
        seed: 2026,
        shape: { size: 4096, height: HEIGHT, rugged: 0.5, sea: 0.8 },
      }),
    )

    expect(pageErrors, 'no uncaught page errors').toEqual([])
  })
})
