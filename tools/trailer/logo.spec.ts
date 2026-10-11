// tools/trailer/logo.spec.ts: the game's emblem alone, on transparency, for a
// trailer's corner bug. Not a test. `bash tools/trailer/logo.sh` copies it into
// tests/e2e as a gitignored `_` spec and runs it; tools/trailer/README.md is the manual.
//
// Why a page of its own: hiding everything but `title-logo` in the running
// title and setting a green background drew NOTHING where the logo was (cause
// not established), and a difference matte (title with and without the logo)
// carried the logo's glow on the trees around it. Rendering the glb alone,
// painted with `paintLogo`'s values, is clean.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const WORK = process.env.TRAILER_WORK ?? 'docs/private/trailer'
const W = 1600
const H = 1200

test.use({ viewport: { width: W, height: H } })

test('trailer logo', async ({ page }) => {
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
  await page.goto('/tools/trailer/logo.html')
  await expect
    .poll(() => page.evaluate('globalThis.__done ?? null'), { timeout: 60_000 })
    .not.toBeNull()
  fs.mkdirSync(WORK, { recursive: true })
  const raw = path.resolve(WORK, 'logo-raw.png')
  await page.screenshot({ path: raw, omitBackground: true })
  // Crop to the alpha's bounds plus a margin.
  const alpha = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', raw, '-vf', 'alphaextract', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { maxBuffer: 1 << 26 },
  )
  let [x0, y0, x1, y1] = [W, H, 0, 0]
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if ((alpha[y * W + x] ?? 0) > 8) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
  expect(x1, 'the logo drew nothing').toBeGreaterThan(x0)
  const m = 12
  const crop = `crop=${x1 - x0 + 1 + 2 * m}:${y1 - y0 + 1 + 2 * m}:${x0 - m}:${y0 - m}`
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    raw,
    '-vf',
    crop,
    path.resolve(WORK, 'logo.png'),
  ])
  console.log(`[logo] ${WORK}/logo.png (${crop})`)
})
