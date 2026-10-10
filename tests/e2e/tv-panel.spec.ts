/**
 * DEV-482: TV's on-screen layer in the browser, photographed.
 *
 * plan/FF-TV.md §5.2. The door is DEV-480's, so this enters as
 * `tv-exhibition.spec.ts` does: from the TITLE, after the card's Start, through
 * the dev handle (`__ff2.exhibition.start`), which calls the same
 * `startExhibition` the door will. The live race's feed is DEV-480's to fill;
 * `__ff2.tvPanel.feed(f)` stands in for it here, writing the same
 * `TvPanelInput.live` the TV block will. Nothing about the game is different
 * under test.
 *
 *   1. LANDSCAPE, the exhibition: the ident over the countdown, the lower third
 *      in flight (the five tuned names, the camera's racer marked), a press on
 *      a name that moves the camera onto that racer, and the results card at
 *      the finish. Each photographed from its own texture (the canvas-panel
 *      recipe) and in the frame.
 *   2. A LIVE feed with handle-shaped names: the panel draws Racer N, marks the
 *      racer a link follows, and says how many rooms are getting ready.
 *   3. PORTRAIT, a phone held upright: the ident wraps, the lower third spans
 *      the width; photographed the same two ways.
 *
 * Run (the GPU lease first, AGENT-NOTES §1):
 *
 *   E2E_PORT=5482 npx playwright test tv-panel
 */

import fs from 'node:fs'
import path from 'node:path'
import { CALLSIGNS, callsignDisplay } from '@/content/callsigns'
import { LOWER_THIRD_CANVAS, type TvPanelFeed, tvLiveRow } from '@/render/tv-panel-layout'
import { bootReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { titleRowsUp } from './fixtures/title'

/** Playwright wipes `test-results/` on every run, so the photographs go somewhere else. */
const OUT = process.env.TV_PANEL_DIR ?? path.join('test-results', 'tv-panel')
const PIN_TAG = PINNED.replace(/[=&]/g, '')
/** The shortest race in the pool: the quickest way to a results card. */
const FIRST = 'rookie_01_hoverJet'

interface PanelProbe {
  shown: { ident: boolean; lowerThird: boolean; results: boolean }
  portrait: boolean
  presenting: boolean
  ident: string
  rows: string[]
  followed: string | null
  cuts: number
  picks: number
  lastPick: number | null
  map: boolean
  layout: { top: number; rows: { follow: number; y: number; h: number }[] } | null
}
type Handle = {
  exhibition: { start(o?: unknown): unknown; probe(): { phase: string }; stop(): void }
  tvPanel: { probe(): PanelProbe; feed(f: unknown): void; lobbies(n: number | null): void }
}

const panel = (page: Page): Promise<PanelProbe> =>
  page.evaluate(() => (globalThis as unknown as { __ff2: Handle }).__ff2.tvPanel.probe())

const openTitle = async (page: Page): Promise<void> => {
  await page.goto(`/?xr=off&${PINNED}`)
  await bootReady(page, 240_000)
  await firstPress(page)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await titleRowsUp(page)
}

/** A panel from its own texture, full resolution, no framing; and the frame it stands in. */
const photograph = async (page: Page, mesh: string, name: string): Promise<void> => {
  fs.mkdirSync(OUT, { recursive: true })
  const url = await page.evaluate((want) => {
    type O = {
      name: string
      material?: { map?: { image?: { toDataURL?: () => string } } }
      traverse: (f: (o: O) => void) => void
    }
    const scene = (globalThis as unknown as { __ff2: { stage: () => O } }).__ff2.stage()
    let data = null as string | null
    scene.traverse((o) => {
      if (o.name === want && !data) data = o.material?.map?.image?.toDataURL?.() ?? null
    })
    return data
  }, mesh)
  expect(url, `${mesh} has a canvas`).not.toBeNull()
  const texture = path.join(OUT, `${name}-texture-${PIN_TAG}.png`)
  fs.writeFileSync(texture, Buffer.from((url as string).split(',')[1] as string, 'base64'))
  const frame = path.join(OUT, `${name}-frame-${PIN_TAG}.png`)
  fs.writeFileSync(frame, await page.locator('#viewport').screenshot())
  console.info(`tv-panel: ${texture}\ntv-panel: ${frame}`)
}

/** Where on the page a lower-third row's middle is drawn, client px. */
const rowOnScreen = (page: Page, y: number): Promise<{ x: number; y: number }> =>
  page.evaluate(
    ({ v, canvasH }) => {
      type V = {
        set(x: number, y: number, z: number): V
        project(c: unknown): V
        x: number
        y: number
      }
      type O = {
        name: string
        parent: O | null
        position: { clone(): V }
        localToWorld(v: V): V
        traverse: (f: (o: O) => void) => void
        isCamera?: boolean
      }
      const scene = (globalThis as unknown as { __ff2: { stage: () => O } }).__ff2.stage()
      let mesh: O | null = null
      scene.traverse((o) => {
        if (o.name === 'tv-panel-lower-third') mesh = o
      })
      const m = mesh as O | null
      if (!m) throw new Error('no lower third')
      let camera = m.parent
      while (camera && !camera.isCamera) camera = camera.parent
      // A third of the way in from the left, at the row's middle (the plane is 1 x 1, scaled).
      const p = m.localToWorld(m.position.clone().set(-0.5 + 0.35, 0.5 - v / canvasH, 0))
      p.project(camera)
      const rect = (document.getElementById('viewport') as HTMLElement).getBoundingClientRect()
      return {
        x: rect.left + ((p.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - p.y) / 2) * rect.height,
      }
    },
    { v: y, canvasH: LOWER_THIRD_CANVAS.height },
  )

/** A live room's race, with names a hand-made client might send in every field a name could ride. */
const liveFeed = (phase: TvPanelFeed['phase']): TvPanelFeed => ({
  show: 'live',
  phase,
  course: 'Simonet Islands · Ring Attack',
  racers: 4,
  rows: [
    {
      ...tvLiveRow({
        slot: 2,
        colour: '#1ad132',
        place: 1,
        status: 'flying',
        seconds: null,
        rings: 9,
      }),
      name: 'SwiftFalcon42',
    },
    {
      ...tvLiveRow({
        slot: 0,
        colour: '#ff1f4b',
        place: 2,
        status: 'flying',
        seconds: null,
        rings: 8,
      }),
      name: 'MattS',
    },
    {
      ...tvLiveRow({
        slot: 3,
        colour: '#129fde',
        place: 3,
        status: 'flying',
        seconds: null,
        rings: 8,
      }),
      name: 'Racer 9 lol',
    },
    {
      ...tvLiveRow({
        slot: 1,
        colour: '#eef91f',
        place: 4,
        status: 'flying',
        seconds: null,
        rings: 6,
      }),
      name: 'x',
    },
  ],
  gates: 21,
  followed: 'slot:0',
  linkFollows: 4,
  lobbies: 2,
  raceSeconds: 67.4,
})

test.describe('@gpu TV panels: the ident, the lower third, the results (DEV-482)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(600_000)

  test('landscape: the exhibition through ident, flight, a press on a name, and the results', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await openTitle(page)
    await page.evaluate(
      (course) => (globalThis as unknown as { __ff2: Handle }).__ff2.exhibition.start({ course }),
      FIRST,
    )

    // The ident, over the countdown.
    await expect
      .poll(async () => (await panel(page)).shown.ident, {
        message: 'the ident comes up',
        timeout: 240_000,
      })
      .toBe(true)
    await expect
      .poll(async () => (await panel(page)).ident, { timeout: 30_000 })
      .toMatch(/Ring Attack/)
    const ident = await panel(page)
    expect(ident.ident).toBe('EXHIBITION · Alpine Forest · Ring Attack · AI racers')
    await photograph(page, 'tv-panel-ident', 'ident-exhibition-landscape')

    // The lower third, in flight.
    await expect
      .poll(async () => (await panel(page)).shown.lowerThird, {
        message: 'the lower third',
        timeout: 60_000,
      })
      .toBe(true)
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { __ff2: Handle }).__ff2.exhibition.probe() as unknown as {
                raceSeconds: number
              },
          ),
        { timeout: 60_000 },
      )
      .toMatchObject({ raceSeconds: expect.any(Number) })
    await page.waitForTimeout(6000)
    // DEV-653: the board shows for a few seconds after a change, then fades; a
    // viewer who wants it presses a name or moves the camera. Move it to the
    // next racer (the right arrow, the hint's own words) and the board is back.
    await page.keyboard.press('ArrowRight')
    await expect
      .poll(async () => (await panel(page)).shown.lowerThird, {
        message: 'the board comes back when the camera moves to another racer',
        timeout: 10_000,
      })
      .toBe(true)
    const flying = await panel(page)
    expect(flying.rows).toHaveLength(5)
    // DEV-651: callsigns from the pool, in capitals, no two alike.
    for (const n of flying.rows) expect(CALLSIGNS.map(callsignDisplay)).toContain(n)
    expect(new Set(flying.rows).size).toBe(flying.rows.length)
    expect(flying.followed, 'the Director is on somebody, and the panel marks it').toMatch(
      /^racer:/,
    )
    await photograph(page, 'tv-panel-lower-third', 'lower-third-exhibition-landscape')
    // DEV-866: the mini-map and the followed racer's numbers stand through the flight.
    await expect
      .poll(async () => (await panel(page)).map, {
        message: 'the mini-map plate stands in flight',
        timeout: 10_000,
      })
      .toBe(true)
    await photograph(page, 'tv-panel-map', 'map-exhibition-landscape')

    // A press on the THIRD name: the camera follows that racer.
    const third = flying.layout?.rows[2]
    expect(third).toBeDefined()
    const at = await rowOnScreen(page, (third?.y ?? 0) + (third?.h ?? 0) / 2)
    await page.mouse.click(at.x, at.y)
    await expect.poll(async () => (await panel(page)).picks, { timeout: 5000 }).toBe(1)
    const picked = await panel(page)
    expect(picked.lastPick).toBe(3)
    // DEV-616: TV takes no pointer lock, so there is no capture to let go of.
    // (This pressed Escape to release one; with none, Escape is the pause,
    // and a paused exhibition never reaches its finish.)
    expect(
      await page.evaluate(() => document.pointerLockElement === null),
      'the press took no pointer lock',
    ).toBe(true)

    // The results card, at the finish.
    await expect
      .poll(async () => (await panel(page)).shown.results, {
        message: 'the race reaches its finish',
        timeout: 300_000,
      })
      .toBe(true)
    await photograph(page, 'tv-panel-results', 'results-exhibition-landscape')
    const done = await panel(page)
    expect(done.rows).toHaveLength(5)

    // A live room's race, as DEV-480's TV block will feed it: no handle drawn.
    await page.evaluate(
      (f) => (globalThis as unknown as { __ff2: Handle }).__ff2.tvPanel.feed(f),
      liveFeed('racing'),
    )
    await expect
      .poll(async () => (await panel(page)).rows, { timeout: 5000 })
      .toEqual(['Racer 3', 'Racer 1', 'Racer 4', 'Racer 2'])
    await expect
      .poll(async () => (await panel(page)).shown.lowerThird, { timeout: 10_000 })
      .toBe(true)
    await photograph(page, 'tv-panel-lower-third', 'lower-third-live-landscape')
    await page.evaluate(
      (f) => (globalThis as unknown as { __ff2: Handle }).__ff2.tvPanel.feed(f),
      liveFeed('ident'),
    )
    await expect.poll(async () => (await panel(page)).shown.ident, { timeout: 5000 }).toBe(true)
    expect((await panel(page)).ident).toBe('LIVE · Simonet Islands · Ring Attack · 4 racers')
    await photograph(page, 'tv-panel-ident', 'ident-live-landscape')

    // PORTRAIT, a phone held upright.
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(async () => (await panel(page)).portrait, { timeout: 10_000 }).toBe(true)
    await page.waitForTimeout(500)
    await photograph(page, 'tv-panel-ident', 'ident-live-portrait')
    await page.evaluate(
      (f) => (globalThis as unknown as { __ff2: Handle }).__ff2.tvPanel.feed(f),
      liveFeed('racing'),
    )
    await expect
      .poll(async () => (await panel(page)).shown.lowerThird, { timeout: 10_000 })
      .toBe(true)
    await page.waitForTimeout(500)
    await photograph(page, 'tv-panel-lower-third', 'lower-third-live-portrait')
    await page.evaluate((f) => (globalThis as unknown as { __ff2: Handle }).__ff2.tvPanel.feed(f), {
      ...liveFeed('results'),
      rows: liveFeed('results').rows.map((r, i) => ({
        ...r,
        status: 'finished',
        seconds: 88 + i * 3.7,
      })),
    })
    await expect.poll(async () => (await panel(page)).shown.results, { timeout: 10_000 }).toBe(true)
    await page.waitForTimeout(500)
    await photograph(page, 'tv-panel-results', 'results-live-portrait')

    // Back to the exhibition's own feed; then off.
    await page.evaluate(() => {
      const h = (globalThis as unknown as { __ff2: Handle }).__ff2
      h.tvPanel.feed(null)
      h.exhibition.stop()
    })
    await expect
      .poll(
        async () => {
          const p = await panel(page)
          return p.shown.ident || p.shown.lowerThird || p.shown.results
        },
        { timeout: 10_000 },
      )
      .toBe(false)
  })
})
