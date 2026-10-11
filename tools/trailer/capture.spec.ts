// tools/trailer/capture.spec.ts: footage capture for trailers. Not a test.
//
// Run it through `tools/trailer/capture.sh`, which copies this file to
// `tests/e2e/_trailer-capture-<pid>.spec.ts` (gitignored by the `_` prefix,
// inside Playwright's testDir, beside the fixtures it imports), runs it (under
// the GPU lease where there is one), and removes the copy on exit.
// tools/trailer/README.md is the manual.
//
// Each shot in `tools/trailer/shots.json` boots the game the way the specs do,
// then records it to `$TRAILER_WORK/clips/<name>/` as numbered JPEG frames plus
// an ffmpeg concat list.
//
// VIRTUAL TIME is the point of this file. Real-time capture of this game drops
// frames (MediaRecorder kept 294 of 361 in flight, and nothing says which), so
// an init script takes over `requestAnimationFrame` and `performance.now`: once
// recording starts, game time advances exactly 1/60 s per pumped frame, each
// frame is copied while its drawing buffer is still valid, and the clock WAITS
// until Node has written it. The footage is smooth however slowly the box
// draws, and a missing frame is impossible rather than unlikely. The game's own
// code is untouched; only the page's clock is the harness's.
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { bootReady, missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { openEditor } from './fixtures/editor-boot'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { titleRowsUp } from './fixtures/title'

interface Shot {
  name: string
  /** mission: `?mission=` on autopilot. exhibition: FF-TV's AI race. title: the title screen. editor: `?edit=1`. */
  kind: 'mission' | 'exhibition' | 'title' | 'editor'
  mission?: string
  /** The exhibition's course. */
  course?: string
  /** Extra query: `&camera=third`, `&edition=classic`, `&view=wide`... */
  query?: string
  /** Start once mission.elapsed (or the exhibition's raceSeconds) passes this. -1: record from the launch press. */
  from?: number
  /** Seconds of GAME time to record. */
  dur: number
  /** frames (virtual time, the default) or screen (CDP screencast, real time, includes DOM). */
  rec?: 'frames' | 'screen'
  /** Real frames per game frame while recording. Higher is slower and never drops; 4 is plenty. */
  skip?: number
  /** Keys held during the shot: [atSeconds, key, holdMs]. */
  keys?: [number, string, number][]
  /** Canvas clicks, each followed by Escape (the editor places a point): [atSeconds, x, y]. */
  clicks?: [number, number, number][]
  /** Mouse drags from screen centre: [atSeconds, dx, dy, ms]. */
  drags?: [number, number, number, number][]
  /** Scene objects to hide by name before recording (`title-menu` for a clean title). */
  hide?: string[]
  /** JS evaluated in the page before recording. */
  prep?: string
}

const WORK = process.env.TRAILER_WORK ?? 'docs/private/trailer'
const OUT = path.resolve(WORK, 'clips')
const shots: Shot[] = JSON.parse(
  fs.readFileSync(process.env.TRAILER_SHOTS ?? 'tools/trailer/shots.json', 'utf8'),
)
const only = process.env.TRAILER_ONLY?.split(',') ?? null

const ff2 = (page: Page, expr: string): Promise<unknown> =>
  page.evaluate(`(() => { const f = globalThis.__ff2; return ${expr} })()`)

const VT_SHIM = `(() => {
  const realRaf = window.requestAnimationFrame.bind(window)
  const realCancel = window.cancelAnimationFrame.bind(window)
  const realNow = performance.now.bind(performance)
  const vt = { on: false, busy: false, base: 0, frames: 0, skip: 4, count: 0, pushed: 0, grab: null, off: null }
  globalThis.__vt = vt
  performance.now = () => (vt.on ? vt.base + (vt.frames * 1000) / 60 : realNow())
  let pending = new Map()
  let id = 1e9
  window.requestAnimationFrame = (cb) => {
    if (!vt.on) return realRaf(cb)
    const h = ++id
    pending.set(h, cb)
    return h
  }
  window.cancelAnimationFrame = (h) => {
    if (h > 1e9) pending.delete(h)
    else realCancel(h)
  }
  vt.start = () => { vt.base = realNow(); vt.frames = 0; vt.on = true }
  vt.stop = () => {
    vt.on = false
    const cbs = pending
    pending = new Map()
    for (const cb of cbs.values()) realRaf(cb)
  }
  const pump = () => {
    realRaf(pump)
    if (!vt.on || vt.busy) return
    if (++vt.count % vt.skip) return
    vt.frames++
    const t = performance.now()
    const cbs = pending
    pending = new Map()
    for (const cb of cbs.values()) {
      try { cb(t) } catch (e) { console.error(e) }
    }
    if (!vt.grab) return
    vt.busy = true
    const c = document.querySelector('canvas')
    if (!vt.off) vt.off = new OffscreenCanvas(c.width, c.height)
    vt.off.getContext('2d').drawImage(c, 0, 0, vt.off.width, vt.off.height)
    const n = vt.pushed++
    vt.off.convertToBlob({ type: 'image/jpeg', quality: 0.95 })
      .then((b) => new Promise((res) => {
        const r = new FileReader()
        r.onload = () => res(r.result.split(',')[1])
        r.readAsDataURL(b)
      }))
      .then((b64) => vt.grab(n, b64))
      .then(() => { vt.busy = false }, (e) => { console.error(e); vt.busy = false })
  }
  realRaf(pump)
})()`

type Vt = {
  grab: unknown
  busy: boolean
  frames: number
  skip: number
  start(): void
  stop(): void
}
const pad = (n: number): string => `f${String(n).padStart(5, '0')}.jpg`

const recordFrames = async (page: Page, dir: string, act: () => Promise<void>) => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  let count = 0
  await page.exposeBinding('__trailerFrame', (_s, n: number, b64: string) => {
    fs.writeFileSync(path.join(dir, pad(n)), Buffer.from(b64, 'base64'))
    count = Math.max(count, n + 1)
  })
  await page.evaluate(() => {
    const g = globalThis as unknown as {
      __vt: Vt
      __trailerFrame: (n: number, b: string) => Promise<void>
    }
    g.__vt.grab = (n: number, b64: string) => g.__trailerFrame(n, b64)
    g.__vt.start()
  })
  await act()
  await page.evaluate(async () => {
    const vt = (globalThis as unknown as { __vt: Vt }).__vt
    while (vt.busy) await new Promise((r) => setTimeout(r, 10))
    vt.grab = null
    vt.stop()
  })
  const lines: string[] = []
  for (let i = 0; i < count; i++) lines.push(`file '${pad(i)}'`, 'duration 0.0166667')
  fs.writeFileSync(path.join(dir, 'list.txt'), lines.join('\n'))
  const missing = Array.from({ length: count }, (_, i) => i).filter(
    (i) => !fs.existsSync(path.join(dir, pad(i))),
  )
  return `${count} frames, ${missing.length} missing`
}

// Real time, whole page (DOM included): for the editor, whose panels are DOM.
// About 25-70 fps depending on load; the concat list carries real durations.
const recordScreen = async (page: Page, dir: string, act: () => Promise<void>) => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  const frames: [string, number][] = []
  let n = 0
  cdp.on('Page.screencastFrame', (f) => {
    const name = pad(n++)
    fs.writeFileSync(path.join(dir, name), Buffer.from(f.data, 'base64'))
    frames.push([name, f.metadata.timestamp ?? Date.now() / 1000])
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 92,
    maxWidth: 1920,
    maxHeight: 1080,
  })
  await act()
  await cdp.send('Page.stopScreencast')
  const lines: string[] = []
  frames.forEach(([name, at], i) => {
    const next = frames[i + 1]
    lines.push(`file '${name}'`, `duration ${(next ? next[1] - at : 1 / 60).toFixed(5)}`)
  })
  fs.writeFileSync(path.join(dir, 'list.txt'), lines.join('\n'))
  return `${frames.length} frames`
}

const launch = async (page: Page) => {
  await focusCanvas(page)
  // Held, not tapped: every confirm here is a level read once a frame.
  await page.keyboard.down('Enter')
  await page.waitForTimeout(200)
  await page.keyboard.up('Enter')
}

test.use({ viewport: { width: 1920, height: 1080 } })

for (const shot of shots) {
  if (only && !only.includes(shot.name)) continue
  test(`trailer shot ${shot.name}`, async ({ page }) => {
    test.setTimeout(600_000)
    page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[${shot.name}] console error: ${m.text()}`)
    })
    await page.addInitScript(VT_SHIM)
    let clock = async (): Promise<number> => 0
    if (shot.kind === 'mission') {
      await page.goto(
        `/?mission=${shot.mission}&xr=off&audio=off&title=0&menu=0&autopilot=1&${PINNED}${shot.query ?? ''}`,
      )
      await firstPress(page)
      await missionReady(page, 240_000)
      clock = async () => Number(await ff2(page, 'f.mission.elapsed'))
    } else if (shot.kind === 'exhibition') {
      await page.goto(`/?xr=off&audio=off&${PINNED}${shot.query ?? ''}`)
      await bootReady(page, 240_000)
      await firstPress(page)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await titleRowsUp(page)
      await page.evaluate(`globalThis.__ff2.exhibition.start({ course: '${shot.course}' })`)
      await expect
        .poll(() => ff2(page, 'f.exhibition.probe().phase'), { timeout: 240_000 })
        .toBe('racing')
      clock = async () => Number(await ff2(page, 'f.exhibition.probe().raceSeconds'))
    } else if (shot.kind === 'editor') {
      await openEditor(page, shot.mission ? { mission: shot.mission } : {})
    } else {
      await page.goto(`/?xr=off&audio=off&${PINNED}${shot.query ?? ''}`)
      await bootReady(page, 240_000)
    }
    const from = shot.from ?? 0
    if (shot.kind === 'mission' && from >= 0) {
      await launch(page)
      await expect.poll(clock, { timeout: 180_000, intervals: [50] }).toBeGreaterThan(from)
    }
    const virtual = (shot.rec ?? 'frames') === 'frames'
    const act = async () => {
      if (shot.kind === 'mission' && from < 0) await launch(page)
      if (shot.kind === 'title') await firstPress(page)
      const t0 = Date.now()
      const until = async (sec: number) => {
        if (virtual) {
          await expect
            .poll(() => page.evaluate(() => (globalThis as unknown as { __vt: Vt }).__vt.frames), {
              timeout: 900_000,
              intervals: [20],
            })
            .toBeGreaterThanOrEqual(Math.round(sec * 60))
        } else {
          const wait = t0 + sec * 1000 - Date.now()
          if (wait > 0) await page.waitForTimeout(wait)
        }
      }
      const events: [number, () => Promise<void>][] = []
      for (const [at, key, ms] of shot.keys ?? [])
        events.push([
          at,
          async () => {
            await page.keyboard.down(key)
            await page.waitForTimeout(ms)
            await page.keyboard.up(key)
          },
        ])
      for (const [at, x, y] of shot.clicks ?? [])
        events.push([
          at,
          async () => {
            await page.mouse.click(x, y)
            await page.waitForTimeout(120)
            await page.keyboard.press('Escape')
          },
        ])
      for (const [at, dx, dy, ms] of shot.drags ?? [])
        events.push([
          at,
          async () => {
            const steps = Math.max(1, Math.round(ms / 16))
            await page.mouse.move(960, 540)
            await page.mouse.down()
            for (let i = 1; i <= steps; i++) {
              await page.mouse.move(960 + (dx * i) / steps, 540 + (dy * i) / steps)
              await page.waitForTimeout(16)
            }
            await page.mouse.up()
          },
        ])
      events.sort((a, b) => a[0] - b[0])
      for (const [at, run] of events) {
        await until(at)
        await run()
      }
      await until(shot.dur)
    }
    await page.evaluate((k) => {
      ;(globalThis as unknown as { __vt: Vt }).__vt.skip = k
    }, shot.skip ?? 4)
    for (const name of shot.hide ?? [])
      await page.evaluate(
        `(() => { const o = globalThis.__ff2.render.scene.getObjectByName('${name}'); if (!o) return 'missing'; o.visible = false; Object.defineProperty(o, 'visible', { get: () => false, set: () => {}, configurable: true }); return 'hidden' })()`,
      )
    if (shot.prep) console.log(`[${shot.name}] prep:`, await page.evaluate(shot.prep))
    const startClock = await clock()
    const result = virtual
      ? await recordFrames(page, path.join(OUT, shot.name), act)
      : await recordScreen(page, path.join(OUT, shot.name), act)
    const endClock = await clock()
    // startClock is what aligns two runs of one course (a matched wipe): the
    // poll that waits for `from` overshoots by a few hundredths, differently
    // per run.
    fs.writeFileSync(
      path.join(OUT, `${shot.name}.json`),
      JSON.stringify({ shot, result, startClock, endClock }, null, 2),
    )
    console.log(`[${shot.name}] ${result} clock ${startClock.toFixed(2)} -> ${endClock.toFixed(2)}`)
  })
}
