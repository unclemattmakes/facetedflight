/**
 * The picture-taking half of a photo spec: write one PNG into a directory.
 *
 * Roughly thirty specs wrote this by hand (a directory made on demand, a
 * screenshot into it) and the identical ones now share it. What stays in each
 * spec is the part that differs: WHERE the pictures go, which is a directory
 * (and an env var that overrides it) the spec names itself, and the page load
 * with its tier pin. `tests/unit/e2e-photo-pin-debt.test.ts` finds a photo
 * spec by the capture call in the spec's own text, and since the call lives
 * here it also knows this file by name (its list of photographer fixtures):
 * a new helper that takes pictures belongs in that list or the specs that use
 * it fall out of the pin ledger without a sound.
 *
 * Playwright wipes `test-results/` at the start of every run, so a comparison
 * across two runs needs a directory outside it, set through the spec's env var.
 * The directory is made on every call rather than once, because the wipe can
 * land between a spec's first picture and its second on a retry.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'

/** The file a picture is written to: `name` as given, or `name-tag.png`. */
const fileFor = (dir: string, name: string, tag: string | undefined): string =>
  path.join(dir, tag === undefined ? name : `${name}-${tag}.png`)

/**
 * A function that photographs the whole page into `dir`. With a `tag` the file
 * is `<name>-<tag>.png`; without one the caller's `name` is the file name.
 * Resolves to the path it wrote.
 */
export const photographer =
  (dir: string, tag?: string) =>
  async (page: Page, name: string): Promise<string> => {
    fs.mkdirSync(dir, { recursive: true })
    const file = fileFor(dir, name, tag)
    await page.screenshot({ path: file })
    return file
  }

/**
 * The same for the render canvas alone (`#viewport`), resolving to the PNG's
 * bytes so a spec can decode it. The file is always `<name>-<tag>.png`.
 */
export const viewportPhotographer =
  (dir: string, tag: string) =>
  async (page: Page, name: string): Promise<Buffer> => {
    fs.mkdirSync(dir, { recursive: true })
    const shot = await page.locator('#viewport').screenshot()
    fs.writeFileSync(fileFor(dir, name, tag), shot)
    return shot
  }
