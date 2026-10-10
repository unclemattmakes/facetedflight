/**
 * DEV-651, DEV-652, DEV-653: a minute of the TV Director, photographed, and the
 * overlay's geometry measured on the real frame.
 *
 *   1. THE OPENING (DEV-652): through the countdown the Director stands in FRONT
 *      of the line looking back at the grid (`framing: 'opening'`).
 *   2. A MINUTE OF DIRECTOR on a 1080p screen, one frame every two seconds, each
 *      with the camera's own report: the framings it used, the racer's share of
 *      the frame (never a speck for long), and that the eye was never left in
 *      a gate's frame (`eyeProblem` is the proposal; the unit sweep holds the
 *      final eye). Compare `TV_DIRECTOR_DIR` of this run against a run of the
 *      base commit for the before and after.
 *   3. THE BUG (DEV-653): at 1080p the right edge of the TV word and the right
 *      edge of the wordmark's T are within a pixel on the real canvas.
 *   4. THE BOARD (DEV-653): up after the ident, gone a few seconds later, back
 *      on a change of the camera's racer; the racers carry callsigns (DEV-651).
 *   5. THE GATE COUNT (DEV-653 e): the board's `n/N` is the course's own live
 *      ring count, on the two Simonet Ring Attack courses (21 and 28).
 *
 * Run (the GPU lease first, AGENT-NOTES §1):
 *
 *   TV_DIRECTOR_DIR=scratchpad/p1-tv/after E2E_PORT=5651 npx playwright test tv-director-photos
 */

import fs from 'node:fs'
import path from 'node:path'
import { CALLSIGNS, callsignDisplay } from '@/content/callsigns'
import { type Level, liveRings } from '@/content/level-schema'
import { bootReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { viewportPhotographer } from './fixtures/photo'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { titleRowsUp } from './fixtures/title'

/** A level's live ring count off disk (Playwright's loader reads no JSON module). */
const ringsOf = (id: string): number =>
  liveRings(
    JSON.parse(fs.readFileSync(path.join('content', 'levels', `${id}.json`), 'utf8')) as Level,
  ).length

const OUT = process.env.TV_DIRECTOR_DIR ?? path.join('test-results', 'tv-director-photos')
/**
 * `TV_BASELINE=1`: photograph and log only, asserting none of what DEV-651 to
 * DEV-653 added, so the same minute can be taken on the commit before them. The
 * game is the same code either way; only what the spec CHECKS differs.
 */
const BASELINE = process.env.TV_BASELINE === '1'
const PIN_TAG = PINNED.replace(/[=&]/g, '')
const photograph = viewportPhotographer(OUT, PIN_TAG)

interface CamReport {
  mode: string
  shot: string | null
  framing: string | null
  following: string | null
  subjectShare?: number
  eyeProblem?: string | null
  eyeAdjusted?: number
  overtakes?: number
  gateCuts?: number
}
interface PanelProbe {
  shown: { ident: boolean; lowerThird: boolean; results: boolean }
  rows: string[]
  followed: string | null
  bug: boolean
  bugEdges?: { wordRightPx: number; tvRightPx: number } | null
}
type Handle = {
  exhibition: {
    start(o?: unknown): unknown
    probe(): { phase: string; course: string | null; raceSeconds: number }
    stop(): void
  }
  tvPanel: { probe(): PanelProbe }
  render: { rig: { userData: { tvCamera?: CamReport } } }
  racers(): {
    racers: { course: { passed: boolean[] }; spec: { callsign?: string | null } }[]
  } | null
}

const ff = <T>(page: Page, f: (h: Handle) => T): Promise<T> =>
  page.evaluate(`(${f.toString()})(globalThis.__ff2)`) as Promise<T>

const openTitle = async (page: Page): Promise<void> => {
  await page.goto(`/?xr=off&${PINNED}`)
  await bootReady(page, 240_000)
  await firstPress(page)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await titleRowsUp(page)
}

const phase = (page: Page): Promise<string> => ff(page, (h) => h.exhibition.probe().phase)
const cam = (page: Page): Promise<CamReport | null> =>
  ff(page, (h) => h.render.rig.userData.tvCamera ?? null)
const panel = (page: Page): Promise<PanelProbe> => ff(page, (h) => h.tvPanel.probe())

const startOn = async (page: Page, course: string): Promise<void> => {
  await page.evaluate((c) => {
    ;(globalThis as unknown as { __ff2: Handle }).__ff2.exhibition.start({ course: c })
  }, course)
}

test.describe('@measure @gpu TV Director: a minute, photographed (DEV-651, 652, 653)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(900_000)

  test('opening, a minute of director, the bug, the board, the gate count', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    await openTitle(page)
    await startOn(page, 'int_01_hoverJet')

    // ── 1. the opening, through the countdown ──
    let sawOpening = false
    const opening = Date.now()
    while (Date.now() - opening < 240_000) {
      const p = await phase(page)
      const c = await cam(page)
      if (p === 'countdown' && c?.framing === 'opening') {
        sawOpening = true
        await photograph(page, 'opening-countdown')
        break
      }
      if (p === 'racing') break
      await page.waitForTimeout(250)
    }
    if (!BASELINE)
      expect(sawOpening, 'the Director opens in front of the line, looking back at the grid').toBe(
        true,
      )

    await expect.poll(() => phase(page), { message: 'GO', timeout: 240_000 }).toBe('racing')

    // ── 3. the bug, on the real frame ──
    if (!BASELINE) {
      await expect
        .poll(async () => (await panel(page)).bugEdges ?? null, {
          message: 'the bug is up with its TV word',
          timeout: 60_000,
        })
        .not.toBeNull()
      const edges = (await panel(page)).bugEdges
      expect(edges).toBeTruthy()
      const dx = Math.abs((edges?.wordRightPx ?? 0) - (edges?.tvRightPx ?? 1e9))
      console.info(
        `tv-bug: wordmark right ${edges?.wordRightPx}, V right ${edges?.tvRightPx}, gap ${dx} px`,
      )
      expect(
        dx,
        'the right edge of the V is the right edge of the T in FLIGHT, within a pixel',
      ).toBeLessThan(1)
    }
    const shot = await photograph(page, 'bug-1080p')
    if (!BASELINE) {
      // The REAL pixels: the rightmost gold column of the wordmark (the first band of gold rows
      // in the bottom-right corner) against the V's (the last band), read off the screenshot.
      const png = shot.toString('base64')
      const edge = await page.evaluate(async (b64) => {
        const bitmap = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${b64}`)).blob(),
        )
        const c = document.createElement('canvas')
        c.width = bitmap.width
        c.height = bitmap.height
        const ctx = c.getContext('2d') as CanvasRenderingContext2D
        ctx.drawImage(bitmap, 0, 0)
        const x0 = bitmap.width - 260
        const y0 = bitmap.height - 220
        const data = ctx.getImageData(x0, y0, 260, 220).data
        const rows: { y: number; right: number }[] = []
        for (let y = 0; y < 220; y++) {
          let right = -1
          for (let x = 0; x < 260; x++) {
            const i = (y * 260 + x) * 4
            const r = data[i] as number
            const g = data[i + 1] as number
            const bl = data[i + 2] as number
            if (r > 190 && g > 150 && bl < 140 && r - bl > 90) right = x
          }
          if (right >= 0) rows.push({ y, right: x0 + right })
        }
        // Bands of rows, split where the gold stops for more than 2 rows (the wordmark, the gem and the TV word are 3 or more rows apart).
        const bands: { right: number }[] = []
        let last = -100
        for (const r of rows) {
          if (r.y - last > 2) bands.push({ right: r.right })
          const b = bands[bands.length - 1] as { right: number }
          b.right = Math.max(b.right, r.right)
          last = r.y
        }
        return { bands: bands.map((b) => b.right) }
      }, png)
      console.info(`tv-bug pixels: gold bands' right columns ${JSON.stringify(edge.bands)}`)
      expect(
        edge.bands.length,
        'the wordmark, the gem and the TV word are separate gold bands',
      ).toBeGreaterThanOrEqual(2)
      const word = edge.bands[0] as number
      const tv = edge.bands[edge.bands.length - 1] as number
      expect(
        Math.abs(word - tv),
        "the V's right edge is the T's, within two pixels of antialiasing",
      ).toBeLessThanOrEqual(2)
    }

    // ── 4/5. the board and the gate count, from the real probes ──
    if (!BASELINE) {
      const racers = await ff(
        page,
        (h) => h.racers()?.racers.map((r) => r.spec.callsign ?? null) ?? [],
      )
      expect(racers).toHaveLength(5)
      for (const c of racers) expect(CALLSIGNS).toContain(c)
      expect(new Set(racers).size, 'no callsign twice in a race').toBe(5)
    }
    const gates = await ff(page, (h) => h.racers()?.racers[0]?.course.passed.length ?? 0)
    expect(gates, 'the board counts the course live rings').toBe(ringsOf('int_01_hoverJet'))

    // ── 2. a minute of director, a frame every two seconds ──
    const seen = new Map<string, number>()
    const log: string[] = []
    let boardWasUp = false
    let boardWentDown = false
    for (let i = 0; i < 30; i++) {
      const c = await cam(page)
      const pn = await panel(page)
      if (c?.framing) seen.set(c.framing, (seen.get(c.framing) ?? 0) + 1)
      if (pn.shown.lowerThird) boardWasUp = true
      else if (boardWasUp) boardWentDown = true
      log.push(
        `${String(i * 2).padStart(2)} s  ${c?.shot}/${c?.framing}  on ${c?.following}  share ${((c?.subjectShare ?? 0) * 100).toFixed(1)} %  board ${pn.shown.lowerThird}  rows ${pn.rows.join(',')}`,
      )
      await photograph(page, `director-${String(i * 2).padStart(2, '0')}s`)
      await page.waitForTimeout(2000)
    }
    console.info(
      `tv-director minute:\n${log.join('\n')}\nframings: ${JSON.stringify(Object.fromEntries(seen))}`,
    )
    expect(seen.size, 'the Director used more than one framing in a minute').toBeGreaterThan(2)
    if (!BASELINE) {
      expect(boardWasUp && boardWentDown, 'the board comes up and fades').toBe(true)
      const rows = (await panel(page)).rows
      for (const r of rows) expect(CALLSIGNS.map(callsignDisplay)).toContain(r)
    }

    // ── 5. the other Simonet course: 28 rings ──
    await ff(page, (h) => h.exhibition.stop())
    await startOn(page, 'adv_02_hoverJet')
    await expect.poll(() => phase(page), { timeout: 300_000 }).toBe('racing')
    const gates2 = await ff(page, (h) => h.racers()?.racers[0]?.course.passed.length ?? 0)
    expect(gates2).toBe(ringsOf('adv_02_hoverJet'))
    console.info(`tv gate counts: int_01 ${gates}, adv_02 ${gates2}`)
    await photograph(page, 'adv02-board')
  })
})
