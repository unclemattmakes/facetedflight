/**
 * tests/e2e/frame-trace.spec.ts: a Chrome trace of a flown stretch, reduced to
 * a per-frame critical path. DEV-970.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * On the VRto3D rig our timed GPU work is about 2.5 ms and `frame()` about
 * 4 ms, yet the build holds only about 86 of 90 fps, so about 4.5 ms of each
 * 11.1 ms frame is owned by no timer we have (`ANNIVERSARY-VR-FRAMERATE.md`
 * 1.4, `PROJECT-EVAL-2026-10-13.md` 1). This records Chrome's own trace, which
 * sees every process on one clock, and `tools/perf/trace-frame.mjs` turns it
 * into one row per frame: rAF start, our JS end, command-buffer flushes, the
 * GPU process's work, the swap, and the gap nobody owns.
 *
 * ── Flat here, on the rig by one env var ─────────────────────────────────
 *
 * This spec is the FLAT version: a large fixed canvas (one worn eye, as
 * `perf-trace.spec.ts` explains), `?adaptive=0&quality=high`, vsync off. The
 * same recorder rides on `xr-vrto3d-trace.spec.ts` under
 * `VRTO3D_CHROME_TRACE=<dir>`, which is the rig version (TO BE TAKEN ON THE
 * RIG: it needs VRto3D installed and SteamVR running).
 *
 *   FRAME_TRACE_SECONDS=10 FRAME_TRACE_ARM=off FRAME_TRACE_DIR=<dir> E2E_PORT=<yours> \
 *     bash tools/agent/gpu.sh run <name> 15 -- pnpm exec playwright test \
 *       tests/e2e/frame-trace.spec.ts --workers 1
 *
 * `FRAME_TRACE_QUERY` is appended to the URL: the submit-early arms are
 * `FRAME_TRACE_QUERY=submit=flush` and `submit=reorder`. The spec asserts
 * MECHANISMS only (the trace has frames, the reducer found rAFs, the pin said
 * what it was told to); not one millisecond is gated.
 *
 * No `src/` imports: one import edge from a spec to `import.meta.glob` kills
 * the whole Playwright collection (MEMORY: e2e can collect zero tests).
 */
import fs from 'node:fs'
import path from 'node:path'
import { machineLoad } from '../../tools/perf/measure-queue.mjs'
import { reduceFrameTrace, renderFrameTable } from '../../tools/perf/trace-frame.mjs'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { startChromeTrace } from './fixtures/chrome-trace'
import { hold } from './fixtures/freeze'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

const MISSION = process.env.FRAME_TRACE_MISSION ?? 'int_02_hoverJet'
const EDITION = process.env.FRAME_TRACE_EDITION ?? 'anniversary'
const SECONDS = Number(process.env.FRAME_TRACE_SECONDS ?? '10')
const ARM = process.env.FRAME_TRACE_ARM ?? 'off'
const EXTRA_QUERY = (process.env.FRAME_TRACE_QUERY ?? '').replace(/^[?&]+/, '')
const OUT_DIR = process.env.FRAME_TRACE_DIR ?? path.join('perf-out', 'frame-trace')
/** One worn eye, 2516 px, as `perf-trace.spec.ts` does and for the same reason. */
const PX = Number(process.env.FRAME_TRACE_PX ?? '2516')
const DPR = Number(process.env.FRAME_TRACE_DPR ?? '2')

test.use({
  viewport: { width: Math.round(PX / DPR), height: Math.round(PX / DPR) },
  deviceScaleFactor: DPR,
  launchOptions: { args: ['--disable-gpu-vsync'] },
})

const traceStatus = (page: Page): Promise<string> =>
  page.evaluate(() =>
    (
      globalThis as unknown as { __ff2perf: { trace: { status: () => string } } }
    ).__ff2perf.trace.status(),
  )

const traceSummary = (page: Page): Promise<Record<string, unknown>> =>
  page.evaluate(() =>
    (
      globalThis as unknown as { __ff2perf: { trace: { summary: () => Record<string, unknown> } } }
    ).__ff2perf.trace.summary(),
  )

test.describe('@measure @gpu the frame critical path: DEV-970', () => {
  test.setTimeout(600_000)

  test('multiview extensions on this Chrome and ANGLE build', async ({ page }) => {
    await page.goto('/?xr=off')
    const probe = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl2')
      if (!gl) return null
      const names = ['OVR_multiview2', 'OCULUS_multiview', 'OVR_multiview', 'WEBGL_multiview']
      const found: Record<string, boolean> = {}
      for (const n of names) found[n] = gl.getExtension(n) !== null
      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      return {
        found,
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
        ua: navigator.userAgent,
      }
    })
    expect(probe, 'a webgl2 context').not.toBeNull()
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(path.join(OUT_DIR, 'multiview-probe.json'), JSON.stringify(probe, null, 2))
    console.info(`multiview probe: ${JSON.stringify(probe)}`)
  })

  test(`${MISSION} ${EDITION} arm=${ARM}: ${SECONDS} s traced`, async ({ page }) => {
    const before = machineLoad()
    await page.goto(
      `/?perf=1&autopilot=1&xr=off&${PINNED}&mission=${MISSION}&edition=${EDITION}` +
        `&trace=${SECONDS}${EXTRA_QUERY ? `&${EXTRA_QUERY}` : ''}`,
    )
    await firstPress(page)
    await missionReady(page, 240_000)
    await focusCanvas(page)
    await hold(page, 'Enter')
    await expect
      .poll(() => traceStatus(page), { timeout: 120_000, intervals: [250] })
      .toBe('recording')

    // The Chrome trace covers exactly the window the in-page recorder covers.
    const chrome = await startChromeTrace(page)
    await expect.poll(() => traceStatus(page), { timeout: 300_000, intervals: [500] }).toBe('done')
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const stem = `${MISSION}-${EDITION}-${ARM}`
    const rawFile = path.join(OUT_DIR, `${stem}.chrome-trace.json`)
    const bytes = await chrome.stop(rawFile)
    const after = machineLoad()

    const summary = await traceSummary(page)
    const reduced = reduceFrameTrace(JSON.parse(fs.readFileSync(rawFile, 'utf8')))
    fs.writeFileSync(path.join(OUT_DIR, `${stem}.frames.json`), JSON.stringify(reduced, null, 1))
    fs.writeFileSync(path.join(OUT_DIR, `${stem}.summary.json`), JSON.stringify(summary, null, 1))
    fs.writeFileSync(path.join(OUT_DIR, `${stem}.table.md`), renderFrameTable(reduced))
    fs.writeFileSync(
      path.join(OUT_DIR, `${stem}.load.json`),
      JSON.stringify({ before, after, arm: ARM, query: EXTRA_QUERY }, null, 1),
    )
    console.info(
      `frame-trace ${stem}: ${bytes} bytes, ${reduced.frames.length} frames reduced; ` +
        `load before ${JSON.stringify(before)} after ${JSON.stringify(after)}\n` +
        renderFrameTable(reduced),
    )

    // Mechanisms only. A trace with no rAF events is a trace of nothing.
    expect(summary.status).toBe('done')
    expect(reduced.frames.length, 'rAF callbacks found in the trace').toBeGreaterThan(100)
    expect(reduced.rendererPid, 'the renderer process was identified').not.toBeNull()
    expect(reduced.gpuPid, 'the GPU process was identified').not.toBeNull()
  })
})
