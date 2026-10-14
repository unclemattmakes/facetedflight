/**
 * tests/e2e/fixtures/chrome-trace.ts: record Chrome's OWN trace (the Perfetto
 * JSON that chrome://tracing reads) around a stretch of a spec. DEV-970.
 *
 * ── What it is for ───────────────────────────────────────────────────────
 *
 * Every timer this repo has (`__ff2perf`, `gpu-timer.ts`) is OURS: it sees the
 * main thread's JS and the GPU time of our own draws. On the VRto3D rig those
 * add to about 6.5 ms of an 11.1 ms frame and the frame still misses 90 Hz,
 * so about 4.5 ms is owned by something no timer of ours sees: the command
 * buffer, the GPU process, the swapchain copy, the compositor. Chrome's trace
 * sees all of those, in every process, on one clock. `tools/perf/trace-frame.mjs`
 * reduces the file this writes to a per-frame critical path.
 *
 * ── Why the page's CDP session ───────────────────────────────────────────
 *
 * `browser.startTracing` needs a `Browser`, and the XR specs run in a
 * persistent context where `context.browser()` is null. The Tracing domain on
 * a page target is process-wide in practice (it is what Puppeteer's
 * `page.tracing` does), so one code path serves both.
 *
 * The trace is a MEASUREMENT instrument and costs frame time of its own, so
 * every A/B that uses it runs both arms with it ON, or neither. Never compare
 * a traced run with an untraced one.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { CDPSession, Page } from '@playwright/test'

/**
 * The categories the critical path needs. `devtools.timeline` is where
 * `FireAnimationFrame` lives (the rAF callback); `gpu` and `gpu.service` the
 * command buffer and the GPU process's work; `viz` the display compositor's
 * draw and swap; `xr` the OpenXR render loop; `toplevel` every task. The
 * `disabled-by-default-` ones are the frame-lifecycle events and the GPU
 * service's decoder detail.
 */
export const FRAME_TRACE_CATEGORIES: readonly string[] = [
  'toplevel',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'gpu',
  'gpu.service',
  'disabled-by-default-gpu.service',
  'viz',
  'xr',
  'v8',
]

export interface ChromeTrace {
  /** Stop recording and write the file. Returns its size in bytes. */
  readonly stop: (file: string) => Promise<number>
}

/** Start recording. Call `stop(file)` on the result when the window is over. */
export const startChromeTrace = async (
  page: Page,
  categories: readonly string[] = FRAME_TRACE_CATEGORIES,
): Promise<ChromeTrace> => {
  const session: CDPSession = await page.context().newCDPSession(page)
  await session.send('Tracing.start', {
    traceConfig: {
      recordMode: 'recordContinuously',
      includedCategories: [...categories],
    },
    transferMode: 'ReturnAsStream',
    streamFormat: 'json',
  } as never)
  return {
    stop: async (file: string): Promise<number> => {
      const done = new Promise<{ stream?: string }>((resolve) => {
        session.once('Tracing.tracingComplete', resolve as never)
      })
      await session.send('Tracing.end')
      const { stream } = await done
      if (!stream) throw new Error('chrome-trace: Tracing.tracingComplete carried no stream')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const fd = fs.openSync(file, 'w')
      let bytes = 0
      try {
        for (;;) {
          const chunk = (await session.send('IO.read', {
            handle: stream,
            size: 8 * 1024 * 1024,
          })) as {
            data: string
            eof?: boolean
          }
          bytes += fs.writeSync(fd, chunk.data)
          if (chunk.eof === true) break
        }
      } finally {
        fs.closeSync(fd)
      }
      await session.send('IO.close', { handle: stream })
      await session.detach()
      return bytes
    },
  }
}
