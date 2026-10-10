/**
 * DEV-875 / DEV-876: Matt, in the editor: "I can't seem to build a course on
 * Mesa Canyon nor Alpine", and "courses with water don't have the water
 * checkbox checked by default, causing the level to reload once they check it."
 *
 * The Base picker listed only the draft's own island's bases, and nothing
 * changed the island, so a course begun over Simonet (the default) could never
 * reach the desert or the alpine forest. It now lists every island's bases,
 * grouped by place; choosing one on another island begins a new course over it.
 * And a base with a sea of its own (Simonet) shows the water switch ON, fixed,
 * so there is nothing to check and no world rebuilt by checking it.
 *
 * In by `?edit=1` (the default base is Simonet's). Tagged `@gpu`, tier pinned.
 */
import { missionReady } from './fixtures/boot'
import { collectPageErrors, openEditor, waitForEditor } from './fixtures/editor-boot'
import type { Ff2Global } from './fixtures/ff2'
import { expect, type Page, test } from './fixtures/test'

const island = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    return (w.__ff2.editor().desk as { island?: string } | null)?.island
  })

test.describe('@gpu the editor reaches every island (DEV-875, DEV-876)', () => {
  test.setTimeout(600_000)

  test('Simonet shows its sea as water already on; the picker reaches Mesa Canyon and Alpine', async ({
    page,
  }) => {
    const errors = collectPageErrors(page)
    await openEditor(page, { mission: 'int_01_hoverJet' })

    // DEV-876: the sea is there, so the switch says so, and cannot reload the world.
    const water = page.locator('[data-editor="water"]')
    await expect(water).toBeChecked()
    await expect(water).toBeDisabled()
    await expect(page.locator('[data-editor="water-readout"]')).toContainText('The water stands')

    // DEV-875: all four places are in the picker.
    const sky = page.locator('[data-editor="sky"]')
    const groups = await sky
      .locator('optgroup')
      .evaluateAll((els) => els.map((e) => (e as HTMLOptGroupElement).label))
    expect(groups).toEqual(
      expect.arrayContaining(['Mesa Canyon', 'Alpine Forest', 'Simonet Islands', 'Kauai']),
    )

    for (const [group, env] of [
      ['Mesa Canyon', 'desert'],
      ['Alpine Forest', 'alpine'],
    ] as const) {
      const value = await sky
        .locator(`optgroup[label="${group}"] option`)
        .first()
        .getAttribute('value')
      expect(value).toBeTruthy()
      await sky.selectOption(value as string)
      await expect(page.locator('body')).toHaveAttribute('data-editor', 'switching', {
        timeout: 30_000,
      })
      await missionReady(page)
      await waitForEditor(page)
      expect(await island(page)).toBe(env)
      // No sea of its own: the switch is off and free.
      await expect(water).not.toBeChecked()
      await expect(water).toBeEnabled()
    }
    expect(errors).toEqual([])
  })
})
