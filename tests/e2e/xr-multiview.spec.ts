/**
 * tests/e2e/xr-multiview.spec.ts: `?multiview=1` in a REAL XR session, on the
 * VRto3D rig. DEV-989.
 *
 * `multiview-probe.spec.ts` proves the shaders flat; this proves the part only
 * a runtime has: Chrome hands the game a texture-array projection layer, the
 * multiview framebuffer on its textures is complete, three draws each frame
 * once into it, and what lands in each eye of the layer is the picture. One
 * browser, one page load per arm, the arms in `XR_MULTIVIEW_ARMS` order
 * (default `off,on,off`: the second `off` is the control, so an off-against-on
 * difference can be read against the run-to-run floor, which the render-clock
 * water and particles set; `tools/perf/png-diff.mjs` with four folders).
 *
 * Per arm, at a fixed tick (`?snap=`, frozen, pinned `adaptive=0&quality=high`
 * and `aa=0`, because multiview has no MSAA and a side-by-side read of an MSAA
 * target would read the unresolved buffer):
 *
 *   * draw calls of ten frames (`renderer.info.render.calls`, which three
 *     resets per `render`, and a session renders once a frame), and the
 *     program count;
 *   * the eye buffer of one frame, read INSIDE it (`__ff2.xrEyeCapture`), both
 *     eyes, to `XR_MULTIVIEW_DIR/<arm>-<n>/`;
 *   * on the multiview arm: the module's report (the layer, the framebuffer,
 *     the refusals), GL's error flag, and the in-session probe with the
 *     HEADSET'S own eyes (`multiviewProbe({ eyes: 'xr' })`).
 *
 * Needs the rig (KR-20): `requireImmersiveDevice` fails fast without it.
 *
 *   E2E_KNOWN_RED=KR-20 XR_MULTIVIEW_DIR=<dir> E2E_PORT=<port> \
 *     playwright test xr-multiview --workers 1
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Ff2Global } from './fixtures/ff2'
import { hold, isFrozen } from './fixtures/freeze'
import { knownRed } from './fixtures/known-red'
import { enterVr, loadSettled } from './fixtures/landing'
import { expect, requireImmersiveDevice, test } from './fixtures/xr-browser'

type Page = import('@playwright/test').Page

const OUT_DIR = process.env.XR_MULTIVIEW_DIR ?? path.join('perf-out', 'xr-multiview')
const ARMS = (process.env.XR_MULTIVIEW_ARMS ?? 'off,on,off').split(',').map((a) => a.trim())
const MISSION = process.env.XR_MULTIVIEW_MISSION ?? 'int_01_hoverJet'
const SNAP_AT = Number(process.env.XR_MULTIVIEW_AT ?? '20')
const QUERY = `edition=anniversary&mission=${MISSION}&autopilot=1&snap=${SNAP_AT}&adaptive=0&quality=high&aa=0`
/** Appended to every arm's query, e.g. `perf=1` (the GPU timer's queries around the draw). */
const EXTRA = process.env.XR_MULTIVIEW_EXTRA ?? ''

const presenting = (page: Page): Promise<boolean> =>
  page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.render.renderer.xr.isPresenting)

const programCount = (page: Page): Promise<number> =>
  page.evaluate(
    () => (globalThis as unknown as Ff2Global).__ff2.render.renderer.info.programs?.length ?? 0,
  )

const sampleCalls = async (page: Page, frames: number): Promise<number[]> => {
  const out: number[] = []
  for (let i = 0; i < frames; i++) {
    out.push(
      await page.evaluate(
        () => (globalThis as unknown as Ff2Global).__ff2.render.renderer.info.render.calls,
      ),
    )
    await page.waitForTimeout(100)
  }
  return out
}

const writePng = (dir: string, name: string, url: string): void => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), Buffer.from(url.split(',')[1] ?? '', 'base64'))
}

test.describe('@measure @gpu xr multiview on the rig: DEV-989', () => {
  test.setTimeout(240_000 * ARMS.length)

  test('each arm: a session, a frozen tick, draws and both eyes of the layer', async ({ page }) => {
    knownRed('KR-20')
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const rows: Record<string, unknown>[] = []
    for (const [n, arm] of ARMS.entries()) {
      const on = arm === 'on'
      await page.goto(
        `/?${QUERY}${on ? '&multiview=1' : '&multiview=0'}${EXTRA ? `&${EXTRA}` : ''}`,
      )
      await requireImmersiveDevice(page)
      await loadSettled(page, 180_000)
      // Programs three holds before the session: the warm-up's work. What the
      // count gains from here on was compiled in the session, in either arm.
      const programsBefore = await programCount(page)
      await enterVr(page)
      await expect.poll(() => presenting(page), { timeout: 60_000 }).toBe(true)
      // The launch, as `flyToFreeze` starts it, then the freeze.
      // Pressed again while the lift still waits: on the rig a press made in the
      // session's first second was lost once in four arms (the lift sat at
      // `waiting` for the whole 180 s). Only while `waiting`, so a press can
      // never land on a later phase.
      await expect
        .poll(
          async () => {
            const phase = await page.evaluate(
              () => (globalThis as unknown as Ff2Global).__ff2.launch().phase,
            )
            if (phase === 'waiting') await hold(page, 'Enter')
            return isFrozen(page)
          },
          { timeout: 180_000, intervals: [3_000] },
        )
        .toBe(true)
      await page.waitForTimeout(3_000)

      const calls = await sampleCalls(page, 10)
      const state = await page.evaluate(() => {
        const w = globalThis as unknown as Ff2Global
        const renderer = w.__ff2.render.renderer
        const gl = renderer.getContext()
        return {
          programs: renderer.info.programs?.length ?? 0,
          // The GPU timer under `perf=1`: how many frames it has timed.
          gpuHarvested: w.__ff2.gpu.enabled ? w.__ff2.gpu.harvested : null,
          glError: gl.getError(),
          report: w.__ff2.multiview(),
          layer: (renderer.xr.getBaseLayer() as { textureArrayLength?: number } | null)
            ?.textureArrayLength,
          // Every program three holds, by name and key, so a key the warm-up
          // missed can be read against the one it built.
          keys: (
            (renderer.info.programs ?? []) as unknown as { name: string; cacheKey: string }[]
          ).map((p) => `${p.name} :: ${p.cacheKey}`),
        }
      })
      const capture = await page.evaluate(() =>
        (globalThis as unknown as Ff2Global).__ff2.xrEyeCapture(2),
      )
      const dir = path.join(OUT_DIR, `${n}-${arm}`)
      writePng(dir, 'left.png', capture.png[0])
      writePng(dir, 'right.png', capture.png[1])
      const probe = on
        ? await page.evaluate(() =>
            (globalThis as unknown as Ff2Global).__ff2.multiviewProbe({ eyes: 'xr', png: true }),
          )
        : null
      if (probe?.png) {
        const names = ['reference-left', 'reference-right', 'multiview-left', 'multiview-right']
        for (const [i, url] of probe.png.entries()) writePng(dir, `probe-${names[i]}.png`, url)
      }
      const { png: _png, ...captureNumbers } = capture
      const { keys, ...shown } = state
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'program-keys.txt'), `${keys.join('\n')}\n`)
      const row = {
        arm,
        calls,
        programsBefore,
        ...shown,
        capture: captureNumbers,
        probe: probe ? { ...probe, png: undefined } : null,
      }
      rows.push(row)
      console.info(`xr-multiview ${n}-${arm}: ${JSON.stringify(row)}`)
    }
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(OUT_DIR, 'xr-multiview.json'),
      `${JSON.stringify({ query: QUERY, rows, errors }, null, 2)}\n`,
    )
    expect(errors, 'page errors').toEqual([])

    // ── the multiview arm: through the layer, nothing refused, one pass ───────
    const onRow = rows.find((r) => r.arm === 'on') as
      | { calls: number[]; glError: number; layer?: number; report: Record<string, unknown> }
      | undefined
    const offRow = rows.find((r) => r.arm === 'off') as { calls: number[] } | undefined
    if (onRow) {
      expect(onRow.layer, 'a texture-array projection layer').toBe(2)
      expect(onRow.report.active, 'multiview is drawing the session').toBe(true)
      expect(onRow.report.framebuffer).toBe('COMPLETE')
      expect(onRow.report.fallbacks).toEqual([])
      expect(onRow.glError).toBe(0)
      if (offRow) {
        const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0
        expect(median(onRow.calls), 'multiview draws fewer calls a frame').toBeLessThan(
          median(offRow.calls),
        )
      }
    }
  })
})
