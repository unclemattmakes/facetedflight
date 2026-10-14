/**
 * tests/e2e/contamination.spec.ts: the game flags a starved frame. DEV-915.
 *
 * The unit tests drive the controller with synthetic traces. This is the other
 * half, the one nothing synthetic can reach: the real dev server's
 * `/__ff2/box`, the real poll in a real page, and a host genuinely out of CPU.
 *
 * It saturates every core for a few seconds with worker threads and asks the
 * page, through the `__ff2perf` handle that ships, whether the quality
 * controller reported the HOST_CPU reason (bit 4 of `render/contamination.ts`)
 * while it was starved and stopped reporting it after. It runs `adaptive=0`:
 * the FLAG is recorded in the measuring configuration, and whether the
 * controller then declines to decide is the unit tests' claim, held against a
 * trace, because a GPU that can be made to struggle on demand is exactly what
 * CI does not have.
 *
 * Takes the box to its knees on purpose, so run it under the GPU lease like any
 * browser run. No `src/` imports (one such edge kills the whole collection).
 */
import os from 'node:os'
import { Worker } from 'node:worker_threads'
import { bootReady } from './fixtures/boot'
import { expect, test } from './fixtures/test'

const HOST_CPU = 4

type Page = import('@playwright/test').Page

const report = (page: Page) =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2perf?: { quality: () => { contamination: number; contaminatedFrames: number } }
    }
    const q = w.__ff2perf?.quality()
    return q ? { mask: q.contamination, frames: q.contaminatedFrames } : null
  })

const burn = (): (() => Promise<void>) => {
  const workers = Array.from(
    { length: os.cpus().length },
    () => new Worker('const t = Date.now() + 120000; while (Date.now() < t) {}', { eval: true }),
  )
  return async () => {
    await Promise.all(workers.map((w) => w.terminate()))
  }
}

test.describe('@measure @gpu the game flags a starved frame', () => {
  test.setTimeout(240_000)

  test('a saturated host raises HOST_CPU, and it clears when the host does', async ({ page }) => {
    await page.goto('/?perf=1&xr=off&adaptive=0&quality=high')
    await bootReady(page)
    await expect.poll(() => report(page).then((r) => r !== null), { timeout: 30_000 }).toBe(true)

    // The endpoint is the dev server's, and it answers with the box.
    const box = await page.evaluate(async () => (await fetch('/__ff2/box')).json())
    expect(box.cpu.cores).toBeGreaterThan(0)

    // Precondition, stated rather than assumed: a host that is already busy
    // would make "it raised the flag" true for the wrong reason.
    await expect
      .poll(() => report(page).then((r) => (r?.mask ?? 0) & HOST_CPU), {
        timeout: 60_000,
        message: 'the host was already busy before the test starved it; re-run on a quiet box',
      })
      .toBe(0)
    const before = (await report(page))?.frames ?? 0

    const stop = burn()
    try {
      await expect
        .poll(() => report(page).then((r) => (r?.mask ?? 0) & HOST_CPU), { timeout: 30_000 })
        .toBe(HOST_CPU)
    } finally {
      await stop()
    }

    await expect
      .poll(() => report(page).then((r) => (r?.mask ?? 0) & HOST_CPU), { timeout: 30_000 })
      .toBe(0)
    const after = await report(page)
    expect(after?.frames ?? 0).toBeGreaterThan(before)
  })
})
