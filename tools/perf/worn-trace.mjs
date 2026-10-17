// tools/perf/worn-trace.mjs: a Chrome trace of a real worn flight, reduced to where the frame goes.
// DEV-993.
//
//   pnpm perf:worn-trace                                   # https://main.ff-10yr.pages.dev/?perf=1
//   pnpm perf:worn-trace "https://localhost:5173/?perf=1"  # a dev server
//   pnpm perf:worn-trace -- --seconds 120 --out perf-out/worn-trace/mine
//
// Options: [url]  --seconds N  hard stop (default 180)   --out DIR   --port N  (default 9333)
//          --chrome PATH   --lean  (no cc / benchmark categories)   --auto N  (no keyboard: trace
//          N seconds from the load, for testing on a flat page)   --start-now  (trace from launch)
//
// What it does, so the operator does not have to know any of it:
//   1. Launches the SYSTEM Chrome, headed, in a profile of its own with WebXR pre-granted for the
//      page's origin (the `vr` content setting, the same trick `tests/e2e/fixtures/xr-browser.ts`
//      uses, so the immersive prompt, which no automation can answer, never appears).
//   2. Attaches to the BROWSER target over CDP, so the trace holds every process: the renderer,
//      the GPU process, viz and the XR device service. The trace streams to a file
//      (`ReturnAsStream`), so 60 to 90 s does not live in memory.
//   3. Waits for the operator, who wears the headset: Enter in this terminal starts the trace,
//      Enter again (or the hard timeout) stops it. The game's own ?perf=1 recorder is armed with
//      `&trace=<seconds>` and its CSV and summary are read out of the page at the end.
//   4. Reduces the trace (`tools/perf/trace-frame.mjs`) and prints the per-frame table, including
//      slow frames against fast ones, what held the GPU process, and every XR-ish event name seen.
//
// Hard rule 13 is the operator's: nobody runs anything else on this machine, and nobody edits
// `src/`, while the headset is on a head. This tool is meant to be run BY the person wearing it.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { loadTraceFile, reduceFrameTrace, renderFrameTable } from './trace-frame.mjs'

export const DEFAULT_URL = 'https://main.ff-10yr.pages.dev/?perf=1'

/**
 * The categories asked of the BROWSER-target trace. `xr` and its disabled-by-default twin are the
 * OpenXR render loop; `gpu`, `gpu.service` and `gpu.capture` the command buffer and the GPU
 * process; `viz` and `cc` the compositor; `devtools.timeline` carries the rAF callback.
 * Categories Chrome does not know are ignored by Chrome, so the list can be generous. `v8` is
 * left out because it bloats and nothing here reads it.
 */
export const wornCategories = (lean) => [
  'toplevel',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'gpu',
  'gpu.service',
  'disabled-by-default-gpu.service',
  'gpu.capture',
  'viz',
  'xr',
  'disabled-by-default-xr',
  ...(lean ? [] : ['cc', 'benchmark']),
]

/** The `vr` content-setting grant for one origin, as Chrome's Preferences file. */
export const grantPreferences = (origin) => ({
  profile: { content_settings: { exceptions: { vr: { [`${origin},*`]: { setting: 1 } } } } },
})

/** Add `trace=<seconds>` to the page's query unless the operator already chose one. */
export const withTraceParam = (url, seconds) => {
  const u = new URL(url)
  if (!u.searchParams.has('trace')) u.searchParams.set('trace', String(seconds))
  return u.toString()
}

export const parseArgs = (argv) => {
  const o = {
    url: DEFAULT_URL,
    seconds: 180,
    out: null,
    port: 9333,
    chrome: null,
    lean: false,
    auto: null,
    startNow: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--seconds') o.seconds = Number(argv[++i])
    else if (a === '--out') o.out = argv[++i]
    else if (a === '--port') o.port = Number(argv[++i])
    else if (a === '--chrome') o.chrome = argv[++i]
    else if (a === '--lean') o.lean = true
    else if (a === '--auto') o.auto = Number(argv[++i])
    else if (a === '--start-now') o.startNow = true
    else if (a === '--') continue
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else o.url = a
  }
  if (!Number.isFinite(o.seconds) || o.seconds <= 0) throw new Error('--seconds must be positive')
  return o
}

const findChrome = (explicit) => {
  const candidates = [
    explicit,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  ].filter(Boolean)
  const hit = candidates.find((c) => fs.existsSync(c))
  if (!hit)
    throw new Error(`no system Chrome found; tried ${candidates.join(', ')}. Pass --chrome.`)
  return hit
}

const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

const waitForEnter = (limitMs) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin })
    const timer = limitMs
      ? setTimeout(() => {
          rl.close()
          resolve('timeout')
        }, limitMs)
      : null
    rl.once('line', () => {
      if (timer) clearTimeout(timer)
      rl.close()
      resolve('enter')
    })
    rl.once('close', () => {
      if (timer) clearTimeout(timer)
      resolve('closed')
    })
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const waitForDebugger = async (port) => {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) return
    } catch {
      // not up yet
    }
    await sleep(200)
  }
  throw new Error(`Chrome did not open its debugging port ${port} in 20 s`)
}

/** Stream a finished trace from the CDP IO handle to `file`; returns its size in bytes. */
const writeStream = async (cdp, stream, file) => {
  const fd = fs.openSync(file, 'w')
  let bytes = 0
  try {
    for (;;) {
      const chunk = await cdp.send('IO.read', { handle: stream, size: 8 * 1024 * 1024 })
      bytes += fs.writeSync(fd, chunk.data)
      if (chunk.eof === true) break
    }
  } finally {
    fs.closeSync(fd)
  }
  await cdp.send('IO.close', { handle: stream })
  return bytes
}

/** The game's own ?perf=1 recording, read out of the page. Never throws. */
const readGameCapture = async (page) =>
  page
    .evaluate(() => {
      const p = globalThis.__ff2perf
      if (!p) return { error: '__ff2perf is not on this page (the URL needs ?perf=1)' }
      const safe = (f) => {
        try {
          return f()
        } catch (e) {
          return { error: String(e) }
        }
      }
      safe(() => p.trace.stop())
      return {
        version: safe(() => p.version()),
        edition: safe(() => p.edition()),
        mission: safe(() => p.mission()),
        settings: safe(() => p.settings()),
        session: safe(() => p.session()),
        budget: safe(() => p.budget()),
        summary: safe(() => p.trace.summary()),
        csv: safe(() => p.trace.dump()),
        captureRuns: safe(() => p.capture.runs()),
        capture: safe(() => (p.capture.runs() > 0 ? p.capture.payload() : null)),
      }
    })
    .catch((e) => ({ error: String(e) }))

export const main = async (argv) => {
  const o = parseArgs(argv)
  const origin = new URL(o.url).origin
  const outDir = path.resolve(o.out ?? path.join('perf-out', 'worn-trace', stamp()))
  fs.mkdirSync(outDir, { recursive: true })
  // A trace runs about 20 MB a second (8 with --lean) and Chrome writes it at
  // the END, so a full disk loses the whole flight (2026-10-15: 0 bytes at
  // 420 MB free). Refuse before Matt puts the headset on, not after.
  const freeGb = (() => {
    try {
      const s = fs.statfsSync(outDir)
      return (s.bavail * s.bsize) / 1e9
    } catch {
      return Number.POSITIVE_INFINITY
    }
  })()
  const needGb = ((o.lean ? 8 : 20) * o.seconds * 2) / 1000
  if (freeGb < needGb) {
    console.error(
      `Only ${freeGb.toFixed(1)} GB free under ${outDir}; a ${o.seconds} s trace can need ${needGb.toFixed(1)} GB (trace plus reducer headroom). Free space, or pass --lean or a shorter --seconds.`,
    )
    process.exit(1)
  }

  // A profile of this tool's own, so a Chrome the operator already has open is never in the way
  // (Chrome allows one instance per profile directory) and the e2e profile is left alone.
  const profile = path.join(os.tmpdir(), 'ff2-worn-trace-profile')
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true })
  fs.writeFileSync(
    path.join(profile, 'Default', 'Preferences'),
    JSON.stringify(grantPreferences(origin)),
  )

  const url = withTraceParam(o.url, o.auto ?? o.seconds)
  const chromePath = findChrome(o.chrome)
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(o.url).hostname)
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${o.port}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(local ? ['--ignore-certificate-errors'] : []),
    url,
  ]
  console.log(`Launching ${chromePath}\n  page ${url}\n  output ${outDir}`)
  const child = spawn(chromePath, args, { stdio: 'ignore' })
  child.on('error', (e) => console.error(`Chrome failed to start: ${e.message}`))

  let browser = null
  try {
    await waitForDebugger(o.port)
    const { chromium } = await import('@playwright/test')
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${o.port}`)
    const context = browser.contexts()[0]
    const page = context?.pages()[0]
    if (!page) throw new Error('Chrome opened no page')
    const cdp = await browser.newBrowserCDPSession()

    if (o.auto === null && !o.startNow) {
      console.log(`
Chrome is open on the game. Do this, in order:

  1. Wait for the title, and pick the mission you want (or have it in the URL).
  2. When you are about to put the headset on, press ENTER in THIS terminal.
     That starts the Chrome trace. Do it now, not early: the trace is large.
  3. Put the headset on. Press ENTER VR (or H) in the Chrome window. Fly the mission,
     60 to 90 seconds is plenty.
  4. Take the headset off and press ENTER in this terminal again.
     (The trace also stops by itself after ${o.seconds} s.)
`)
      await waitForEnter(0)
    }

    await cdp.send('Tracing.start', {
      traceConfig: { recordMode: 'recordContinuously', includedCategories: wornCategories(o.lean) },
      transferMode: 'ReturnAsStream',
      streamFormat: 'json',
    })
    const t0 = Date.now()
    console.log(`Tracing. ${o.auto === null ? 'Wear the headset now.' : `Recording ${o.auto} s.`}`)

    if (o.auto !== null) await sleep(o.auto * 1000)
    else {
      const why = await waitForEnter(o.seconds * 1000)
      console.log(why === 'timeout' ? `Hard stop after ${o.seconds} s.` : 'Stopping.')
    }
    const seconds = (Date.now() - t0) / 1000

    const game = await readGameCapture(page)
    const complete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve))
    await cdp.send('Tracing.end')
    const { stream } = await complete
    const traceFile = path.join(outDir, 'worn.chrome-trace.json')
    const bytes = await writeStream(cdp, stream, traceFile)
    console.log(`Trace: ${(bytes / 1e6).toFixed(0)} MB, ${seconds.toFixed(0)} s, ${traceFile}`)

    const { csv, ...gameRest } = game
    fs.writeFileSync(path.join(outDir, 'game-perf.json'), JSON.stringify(gameRest, null, 1))
    if (typeof csv === 'string') fs.writeFileSync(path.join(outDir, 'game-perf.trace.csv'), csv)
    console.log(
      `Game ?perf=1 capture: ${gameRest.error ?? 'game-perf.json and game-perf.trace.csv'}` +
        (gameRest.captureRuns > 0
          ? ` (and ${gameRest.captureRuns} pause-plate capture run(s) inside)`
          : '') +
        '\n  If you flew several runs with the pause-plate capture row, its download also landed in your Downloads folder.',
    )
    await browser.close().catch(() => {})
    browser = null
    killTree(child)

    console.log('Reducing (this reads the whole trace twice; a minute for a big one)...')
    const reduced = reduceFrameTrace(await loadTraceFile(traceFile))
    const table = renderFrameTable(reduced)
    fs.writeFileSync(path.join(outDir, 'frames.json'), JSON.stringify(reduced, null, 1))
    fs.writeFileSync(path.join(outDir, 'table.md'), table)
    console.log(`\n${table}\nWritten to ${outDir}`)
    return { outDir, reduced }
  } finally {
    if (browser) await browser.close().catch(() => {})
    killTree(child)
  }
}

/** End Chrome and its children; `child.kill()` alone leaves the renderer on Windows. */
const killTree = (child) => {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else child.kill()
}

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop() ?? '')
if (isMain) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (e) => {
      console.error(e instanceof Error ? e.message : e)
      process.exit(1)
    },
  )
}
