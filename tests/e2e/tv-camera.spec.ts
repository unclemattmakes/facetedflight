/**
 * DEV-481's gates in the browser (plan/FF-TV.md §5.3, §9): TV's camera on a
 * real watched race, room-watch's: two autopilot players in node race one
 * room in the sidecar, and the page watches it through the broadcaster.
 *
 *   1. FLAT: each mode, photographed: the Director (opens on its own), Follow
 *      (→), Free (C, then W held: the eye flies; that it stays above the
 *      ground is the unit sweep's, `tv-camera.test.ts`, on steep ground),
 *      and C cycles back to the Director.
 *   2. AN EMULATED HEADSET (IWER, `fixtures/emulated-xr.ts`; nothing under
 *      `src/` knows it is there) gets the SAME camera as flat (DEV-481
 *      follow-up, Matt, 2026-10-01: "let's keep it functionally identical to
 *      flat at launch"): every animation frame for 15 s of the race, the rig
 *      moves with the chase, 24 m behind and 7 m above the racer the camera is
 *      on as the flat eye is, level, with no cut; and C cycles the same three
 *      modes. The comfort cuts (`gameplay.tv.headsetCuts`, off) are held by
 *      `tests/unit/tv-camera.test.ts`.
 *
 *   3. THE EXHIBITION (DEV-483, no sidecar): the same camera over its AI racers
 *      (one camera path for live and exhibition), photographed on the
 *      Director, and → is Follow.
 *
 *   FF2_API_PROXY=http://127.0.0.1:6481 E2E_PORT=5481 npx playwright test tv-camera
 *
 * Photos go to `TV_PHOTO_DIR` when set (Playwright wipes `test-results/`).
 */

import { bootReady, missionReady } from './fixtures/boot'
import { emulatedXrInstalled, installEmulatedXr } from './fixtures/emulated-xr'
import type { Ff2Global, Ff2GlobalMaybe } from './fixtures/ff2'
import { DOOR_TV, hold } from './fixtures/hangar'
import { enterVr, firstPress, loadSettled } from './fixtures/landing'
import { photographer } from './fixtures/photo'
import { PINNED } from './fixtures/quality-pin'
import { type Crowd, loadLevel, startCrowd } from './fixtures/room-crowd'
import { type RoomSidecar, startRoomSidecar } from './fixtures/room-sidecar'
import { E2E_BASE as BASE, E2E_CHANNEL as CHANNEL } from './fixtures/server'
import { type Browser, chromium, expect, type Page, skipSplash, test } from './fixtures/test'
import { hangarDoors, titleRowsUp } from './fixtures/title'
import { tvProbe } from './fixtures/tv'

/**
 * A `?tv` link boards on the page's FIRST PRESS (`linkWaiting`, DEV-557). Since
 * DEV-872 the splash shows on every load and the suite skips it with an Enter, which
 * IS that first press (`main.ts`'s first gesture rides the skip), so a player's
 * link boards at the skip and no title is ever offered: `firstPress` waited 60 s
 * for title rows that never came. Wait for the gesture, as a player's skip makes it.
 */
const boardedByLink = async (page: Page): Promise<void> => {
  await loadSettled(page)
  await expect(page.locator('body')).toHaveAttribute('data-first-input', 'true', {
    timeout: 60_000,
  })
}

const PROXY = process.env.FF2_API_PROXY ?? ''
const PHOTOS = process.env.TV_PHOTO_DIR ?? ''

interface CamReport {
  mode: string
  shot: string | null
  following: string | null
  presenting: boolean
  vantage: number
  cuts: number
  black: number
  vantages: number
  liftedVantages: number
  orbit?: [number, number, number] | null
  framing?: string | null
}
interface Pose {
  p: [number, number, number]
  q: [number, number, number, number]
  cam: CamReport | null
}

const pose = (page: Page): Promise<Pose> =>
  page.evaluate(() => {
    const ff = (globalThis as unknown as Ff2GlobalMaybe).__ff2
    const rig = ff?.render.rig
    if (!rig) return { p: [0, 0, 0], q: [0, 0, 0, 1], cam: null } as Pose
    return {
      p: [rig.position.x, rig.position.y, rig.position.z],
      q: [rig.quaternion.x, rig.quaternion.y, rig.quaternion.z, rig.quaternion.w],
      cam: (rig.userData.tvCamera ?? null) as CamReport | null,
    } as Pose
  })

const visibleShips = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    return w.__ff2?.watch()?.ships.filter((s) => s.visible).length ?? 0
  })

const takePhoto = photographer(PHOTOS, PINNED.replace(/[=&]/g, '-'))
const photo = async (page: Page, name: string): Promise<void> => {
  if (!PHOTOS) return
  await takePhoto(page, name)
}

const newRoomId = (tag: string): string =>
  `${tag}${Date.now().toString(32)}abcdefghijklm`.slice(0, 16).replace(/[^a-z2-7]/g, 'a')

test.describe('@gpu TV camera on a watched race (DEV-481)', () => {
  test.skip(
    !PROXY,
    'set FF2_API_PROXY=http://127.0.0.1:<port> so Vite forwards /api to the room sidecar',
  )
  test.setTimeout(480_000)

  let sidecar: RoomSidecar
  test.beforeAll(async () => {
    test.setTimeout(360_000)
    sidecar = await startRoomSidecar(Number(new URL(PROXY).port))
    const answer = await fetch(`${PROXY}/api/room-sidecar`).then((r) => r.text())
    expect(answer, 'a stale sidecar is answering on this port').toBe(sidecar.nonce)
  })
  test.afterAll(async () => {
    await sidecar?.close()
  })

  test('flat: the Director, Follow and Free, photographed; C cycles them', async () => {
    const roomId = newRoomId('tvf')
    const level = loadLevel('int_01_hoverJet')
    let crowd: Crowd | null = null
    let browser: Browser | null = null
    try {
      browser = await chromium.launch({
        headless: false,
        ...(CHANNEL ? { channel: CHANNEL } : {}),
        args: ['--window-position=0,0', '--window-size=1300,780'],
      })
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 720 },
      })
      await skipSplash(context)
      const page = await context.newPage()
      page.on('console', (m) => {
        const t = m.text()
        if (/^watch|^tv camera/.test(t)) console.log(`[viewer] ${t}`)
      })
      await page.goto(`${BASE}/?watch=${roomId}&mission=${level.id}&menu=0&xr=off&${PINNED}`)
      await missionReady(page, 240_000)
      await firstPress(page)
      crowd = await startCrowd({
        url: `${PROXY.replace(/^http/, 'ws')}/api/room/${roomId}`,
        level,
        count: 2,
        players: 2,
      })
      await expect.poll(() => visibleShips(page), { timeout: 240_000 }).toBe(2)

      // ── the Director, on its own ───────────────────────────────────────
      await expect
        .poll(async () => (await pose(page)).cam?.following ?? null, { timeout: 60_000 })
        .not.toBeNull()
      const director = (await pose(page)).cam as CamReport
      expect(director.mode).toBe('director')
      expect(director.presenting).toBe(false)
      expect(director.vantages, 'trackside vantages were built').toBeGreaterThan(10)
      // Let the race get away from the grid so the shot is a racing one.
      await page.waitForTimeout(6000)
      await photo(page, 'tv-director')
      console.info(`DEV-481 flat director: ${JSON.stringify((await pose(page)).cam)}`)

      // ── Follow: → is the next racer ────────────────────────────────────
      const before = (await pose(page)).cam?.following
      await page.keyboard.press('ArrowRight')
      await expect.poll(async () => (await pose(page)).cam?.mode).toBe('follow')
      const followed = (await pose(page)).cam?.following
      expect(followed).not.toBeNull()
      expect(followed, 'the next racer after the Director’s subject').not.toBe(before)
      await page.waitForTimeout(2500)
      await photo(page, 'tv-follow')
      await page.keyboard.press('ArrowRight')
      await expect.poll(async () => (await pose(page)).cam?.following).toBe(before)

      // ── Free: C, then W and Q held: the eye flies ──────────────────────
      await page.keyboard.press('KeyC')
      await expect.poll(async () => (await pose(page)).cam?.mode).toBe('free')
      const start = (await pose(page)).p
      await page.keyboard.down('KeyW')
      await page.keyboard.down('KeyQ')
      await page.waitForTimeout(2500)
      await page.keyboard.up('KeyQ')
      await page.keyboard.up('KeyW')
      const end = (await pose(page)).p
      const moved = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2])
      console.info(`DEV-481 flat free: moved ${moved.toFixed(1)} m, eye y ${end[1].toFixed(1)}`)
      expect(moved, 'W/Q flew the free eye').toBeGreaterThan(5)
      await photo(page, 'tv-free')

      // ── C cycles back to the Director ──────────────────────────────────
      await page.keyboard.press('KeyC')
      await expect.poll(async () => (await pose(page)).cam?.mode).toBe('director')
    } finally {
      crowd?.stop()
      await browser?.close()
    }
  })

  test('an emulated headset: the same camera as flat (DEV-481 follow-up)', async () => {
    const roomId = newRoomId('tvx')
    const level = loadLevel('int_01_hoverJet')
    let crowd: Crowd | null = null
    let browser: Browser | null = null
    try {
      browser = await chromium.launch({
        headless: false,
        ...(CHANNEL ? { channel: CHANNEL } : {}),
        args: ['--window-position=0,0', '--window-size=1620,800'],
      })
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1600, height: 720 },
        deviceScaleFactor: 1,
      })
      await skipSplash(context)
      const page = await context.newPage()
      page.on('console', (m) => {
        const t = m.text()
        if (/^watch|^tv camera/.test(t)) console.log(`[viewer] ${t}`)
      })
      await installEmulatedXr(page, { fovyDeg: 90 })
      await page.goto(`${BASE}/?watch=${roomId}&mission=${level.id}&menu=0&${PINNED}`)
      await loadSettled(page, 240_000)
      expect(await emulatedXrInstalled(page), 'the emulated runtime took').toBe(true)
      await enterVr(page)
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (globalThis as unknown as Ff2GlobalMaybe).__ff2?.render.renderer.xr.isPresenting ??
                false,
            ),
          { timeout: 60_000 },
        )
        .toBe(true)
      crowd = await startCrowd({
        url: `${PROXY.replace(/^http/, 'ws')}/api/room/${roomId}`,
        level,
        count: 2,
        players: 2,
      })
      await expect.poll(() => visibleShips(page), { timeout: 240_000 }).toBe(2)
      await expect
        .poll(async () => (await pose(page)).cam?.presenting ?? false, { timeout: 30_000 })
        .toBe(true)

      // Past the Director's opening WIDE shot (90 m back and 35 m up, on flat
      // too), so the frames compare against the chase.
      await expect
        .poll(async () => (await pose(page)).cam?.shot ?? 'start', { timeout: 120_000 })
        .not.toBe('start')
      // And onto its chase framing (DEV-618: the Director films more ways than
      // the chase), so the trace opens on the eye path it compares.
      await expect
        .poll(async () => (await pose(page)).cam?.framing ?? null, {
          timeout: 120_000,
          intervals: [100],
        })
        .toBe('chase')
      // Every animation frame for 15 s of the Director: the rig, the camera's
      // report, and the racer it is on.
      const trace = await page.evaluate(async () => {
        const ff = (globalThis as unknown as Ff2Global).__ff2
        const rows: {
          p: number[]
          q: number[]
          cuts: number
          mode: string
          headsetCuts: boolean
          framing: string | null
          ship: number[] | null
        }[] = []
        const until = performance.now() + 15_000
        await new Promise<void>((done) => {
          const tick = (): void => {
            const r = ff.render.rig
            const c = r.userData.tvCamera
            const ship =
              ff.watch()?.ships.find((s) => s.handle === c?.following && s.position)?.position ??
              null
            rows.push({
              p: [r.position.x, r.position.y, r.position.z],
              q: [r.quaternion.x, r.quaternion.y, r.quaternion.z, r.quaternion.w],
              cuts: c?.cuts ?? -1,
              mode: c?.mode ?? '',
              headsetCuts: c?.headsetCuts ?? true,
              framing: c?.framing ?? null,
              ship: ship ? [...ship] : null,
            })
            if (performance.now() < until) requestAnimationFrame(tick)
            else done()
          }
          requestAnimationFrame(tick)
        })
        return rows
      })
      let moves = 0
      const bad: string[] = []
      const dist: number[] = []
      const above: number[] = []
      for (let i = 1; i < trace.length; i++) {
        const a = trace[i - 1] as (typeof trace)[number]
        const b = trace[i] as (typeof trace)[number]
        // A move is the rig placed anew: its position, or its facing (DEV-618's
        // fixed framings stand and pan, on a flat screen as in a headset).
        if (a.p.some((v, k) => v !== b.p[k]) || a.q.some((v, k) => v !== b.q[k])) moves++
        if (Math.abs(b.q[0] as number) > 1e-9 || Math.abs(b.q[2] as number) > 1e-9)
          bad.push(`frame ${i}: the rig is not level`)
        if (b.headsetCuts) bad.push(`frame ${i}: the comfort cuts are on`)
        // The chase's eye path is measured on the Director's chase framing (DEV-618).
        if (b.ship && b.framing === 'chase') {
          const [x, y, z] = b.ship as [number, number, number]
          dist.push(
            Math.hypot((b.p[0] as number) - x, (b.p[1] as number) - y, (b.p[2] as number) - z),
          )
          above.push((b.p[1] as number) - y)
        }
      }
      dist.sort((m, n) => m - n)
      above.sort((m, n) => m - n)
      const mid = (xs: number[]) => xs[Math.floor(xs.length / 2)] as number
      const cuts = (trace.at(-1)?.cuts ?? 0) - (trace[0]?.cuts ?? 0)
      console.info(
        `DEV-481 follow-up emulated XR: ${trace.length} frames over 15 s, ${moves} rig moves, ${cuts} cuts, ` +
          `eye to racer p50 ${mid(dist).toFixed(1)} m (flat: 25.0, 24 back and 7 up), above it p50 ${mid(above).toFixed(1)} m`,
      )
      expect(trace.length, 'frames were sampled').toBeGreaterThan(200)
      expect(bad.slice(0, 10)).toEqual([])
      // The flat camera's behaviour: the rig moves with the chase, and no cut is made.
      expect(cuts).toBe(0)
      // (A sample is an animation frame, and IWER's XR frames ride the same
      // clock, so some samples see one XR frame twice: the half is the floor.)
      expect(moves).toBeGreaterThan(trace.length * 0.5)
      // The flat camera's eye path: 24 m behind and 7 m above the racer it is on.
      // The Director opens its racing on the chase (`TV_FRAMING_POOLS.leader`'s first) and holds it seconds.
      expect(dist.length).toBeGreaterThan(200)
      expect(mid(dist)).toBeGreaterThan(20)
      expect(mid(dist)).toBeLessThan(30)
      expect(mid(above)).toBeGreaterThan(4)
      expect(mid(above)).toBeLessThan(12)

      // The same modes as flat: C cycles Director, Follow, Free and back.
      for (const want of ['follow', 'free', 'director']) {
        await page.keyboard.press('KeyC')
        await expect.poll(async () => (await pose(page)).cam?.mode).toBe(want)
      }
    } finally {
      crowd?.stop()
      await browser?.close()
    }
  })
})

interface ExhibitionProbe {
  phase: string
  raceSeconds: number
  craft: { name: string }[]
}
/** DEV-628: the eye's distance to the racer the camera follows, and how far off the view's axis it is. */
const orbitGeometry = (page: Page): Promise<{ distance: number; offAxisDegrees: number } | null> =>
  page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: the dev handle, read in the page
    const ff = (globalThis as unknown as { __ff2: any }).__ff2
    const rig = ff.render.rig
    const following = rig.userData.tvCamera?.following ?? null
    const craft = ff.exhibition.probe().craft.find((c: { name: string }) => c.name === following) as
      | { at: [number, number, number] }
      | undefined
    if (!craft) return null
    const p = rig.position
    const dx = craft.at[0] - p.x
    const dy = craft.at[1] - p.y
    const dz = craft.at[2] - p.z
    const distance = Math.hypot(dx, dy, dz)
    // The view's axis: -Z through the rig's quaternion (the camera's local pose is identity, flat).
    const { x, y, z, w } = rig.quaternion
    const fx = -(2 * (x * z + w * y))
    const fy = -(2 * (y * z - w * x))
    const fz = -(1 - 2 * (x * x + y * y))
    const dot = (fx * dx + fy * dy + fz * dz) / distance
    return { distance, offAxisDegrees: (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI }
  })

/** DEV-628: FF-TV's EXIT, MENU and hint. */
const tvControls = (page: Page): Promise<{ shown: boolean; hint: string; exits: number }> =>
  page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.tvPanel.controls())

const exhibitionProbe = (page: Page): Promise<ExhibitionProbe> =>
  page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.exhibition.probe())

test.describe('@gpu TV camera on the exhibition (DEV-481 over DEV-483)', () => {
  test.setTimeout(480_000)

  test('the Director over the AI racers, photographed; → is Follow', async ({ page }) => {
    // DEV-618: room for every framing to come round (up to 300 s of racing).
    test.setTimeout(720_000)
    page.on('console', (m) => {
      const t = m.text()
      if (/^tv camera|^exhibition/.test(t)) console.log(`[page] ${t}`)
    })
    // The title the way a player reaches it, then the exhibition's own entry.
    await page.goto(`/?xr=off&${PINNED}`)
    await bootReady(page, 240_000)
    await firstPress(page)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await titleRowsUp(page)
    await page.evaluate(() =>
      (globalThis as unknown as Ff2Global).__ff2.exhibition.start({ course: 'int_01_hoverJet' }),
    )
    await expect
      .poll(async () => (await exhibitionProbe(page)).phase, { timeout: 240_000 })
      .toBe('racing')
    await expect
      .poll(async () => (await exhibitionProbe(page)).raceSeconds, { timeout: 60_000 })
      .toBeGreaterThan(14)
    const cam = (await pose(page)).cam as CamReport
    console.info(`DEV-481 exhibition director: ${JSON.stringify(cam)}`)
    expect(cam.mode).toBe('director')
    expect(cam.vantages).toBeGreaterThan(10)
    const names = (await exhibitionProbe(page)).craft.map((c) => c.name)
    expect(names, 'the Director is on one of the exhibition’s racers').toContain(cam.following)
    await photo(page, 'tv-exhibition-director')

    // DEV-617: the bug, the game's emblem in the corner, stands while TV is on.
    await expect
      .poll(
        () => page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.tvPanel.probe().bug),
        { message: 'the bug stands in its corner' },
      )
      .toBe(true)

    // DEV-618: every framing the Director has, met in the browser and photographed.
    const framings = new Set<string>()
    const want = ['chase', 'side', 'trackside', 'aerial', 'flyby']
    const until = Date.now() + 300_000
    while (want.some((f) => !framings.has(f)) && Date.now() < until) {
      const f = (await pose(page)).cam?.framing ?? null
      if (f && !framings.has(f)) {
        framings.add(f)
        await page.waitForTimeout(700)
        await photo(page, `tv-framing-${f}`)
      }
      await page.waitForTimeout(100)
    }
    console.info(`DEV-618 framings met: ${[...framings].join(', ')}`)
    for (const f of want) expect([...framings], `the Director filmed ${f}`).toContain(f)

    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await pose(page)).cam?.mode).toBe('follow')
    // The names are read AGAIN, not reused from the top: the framing loop above
    // can run past the race's end into the next course, and since DEV-651 each
    // course draws its own callsigns (before it, a racer's name was its tuning
    // id, the same in every race).
    const after = (await exhibitionProbe(page)).craft.map((c) => c.name)
    expect(after).toContain((await pose(page)).cam?.following)
    await page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.exhibition.stop())
  })

  // ── DEV-617: the bug on a phone ─────────────────────────────────────────
  // Turned sideways: held upright, TV asks to be turned (DEV-595's card), as
  // the game does. The upright placement (top right) is the unit test's.
  test('the bug stands on a phone turned sideways (DEV-617)', async ({ browser }) => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 844, height: 390 },
      hasTouch: true,
    })
    await skipSplash(context)
    const page = await context.newPage()
    try {
      await page.goto(`${BASE}/?tv&xr=off&${PINNED}`)
      await bootReady(page, 240_000)
      await boardedByLink(page)
      await expect
        .poll(async () => (await exhibitionProbe(page)).phase, { timeout: 240_000 })
        .toBe('racing')
      const panel = (): Promise<{ bug: boolean; portrait: boolean }> =>
        page.evaluate(() => {
          const p = (globalThis as unknown as Ff2Global).__ff2.tvPanel.probe()
          return { bug: p.bug, portrait: p.portrait }
        })
      await expect
        .poll(async () => JSON.stringify(await panel()))
        .toBe(JSON.stringify({ bug: true, portrait: false }))
      await page.waitForTimeout(1500)
      await photo(page, 'tv-bug-phone')
      // DEV-628: on a phone the race is the glass: EXIT, MENU and the hint
      // over it, a tap is the next racer, and EXIT is the hangar.
      const controls = await tvControls(page)
      expect(controls.shown).toBe(true)
      expect(controls.hint).toMatch(/TAP next racer/)
      await photo(page, 'tv-controls-phone')
      const before = (await pose(page)).cam?.following ?? null
      await page.touchscreen.tap(422, 200)
      await expect
        .poll(async () => (await pose(page)).cam?.following ?? null, {
          message: 'a tap follows the next racer',
        })
        .not.toBe(before)
      expect((await pose(page)).cam?.mode).toBe('follow')
      // DEV-792: with TV's plate up the touch overlay is back, for the plate's
      // taps, and it offers nothing to fly a ship nobody flies: no BRAKE,
      // BOOST, AUTO, camera, pause or LAUNCH chip.
      await page.locator('#tv-controls button[data-act="menu"]').tap()
      await expect.poll(async () => (await tvProbe(page))?.plate.up, { timeout: 10_000 }).toBe(true)
      await expect(page.locator('#touch-controls')).toBeVisible()
      for (const act of ['brake', 'boost', 'auto', 'cam', 'tilt', 'pause', 'confirm']) {
        await expect(
          page.locator(`#touch-controls [data-act="${act}"]`),
          `the ${act} chip is not offered on TV`,
        ).toBeHidden()
      }
      await page.locator('#tv-controls button[data-act="exit"]').tap()
      await expect.poll(() => tvProbe(page), { timeout: 30_000 }).toBeNull()
      expect((await tvControls(page)).exits).toBe(1)
      await expect
        .poll(() => hangarDoors(page), { timeout: 60_000, message: 'back in the hangar' })
        .toContain(DOOR_TV)
    } finally {
      await context.close()
    }
  })

  // ── DEV-616: the mouse, with no capture ──────────────────────────────────
  // Matt, 2026-10-03: "fftv seems to capture my cursor. in practice, i'm going
  // to have a tab running fftv running on a monitor while i do work elsewhere -
  // so don't capture the cursor plz. if i do click and drag, i want to orbit
  // (in chase cam)". By TV's own link (`/?tv&follow=1`: nothing live here, so
  // the exhibition, following Racer 1), the way a player opens one.
  test('TV takes no pointer lock; a click-drag orbits the chase and lets go (DEV-616)', async ({
    page,
  }) => {
    await page.goto(`/?tv&follow=1&xr=off&${PINNED}`)
    await bootReady(page, 240_000)
    await boardedByLink(page)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await expect
      .poll(async () => (await exhibitionProbe(page)).phase, { timeout: 240_000 })
      .toBe('racing')
    await expect
      .poll(async () => (await exhibitionProbe(page)).raceSeconds, { timeout: 60_000 })
      .toBeGreaterThan(8)
    await expect.poll(async () => (await pose(page)).cam?.mode).toBe('follow')
    const locked = (): Promise<boolean> => page.evaluate(() => document.pointerLockElement !== null)
    const box = page.viewportSize() ?? { width: 1280, height: 720 }
    const x0 = Math.round(box.width * 0.45)
    const y0 = Math.round(box.height * 0.35)
    // A click: no capture. DEV-628 (QUESTIONS item 10): a plain click is the next racer.
    const before = (await pose(page)).cam?.following
    await page.mouse.click(x0, y0)
    await page.waitForTimeout(400)
    expect(await locked(), 'a click on TV takes no pointer lock').toBe(false)
    const clicked = (await pose(page)).cam
    expect(clicked?.following, 'a plain click follows the next racer (DEV-628)').not.toBe(before)
    expect(clicked?.mode).toBe('follow')
    // A drag: the chase swings about the racer, still in Follow, on the same racer.
    // DEV-628: tested as GEOMETRY, every step of the drag: the eye is the
    // orbit's radius from the racer it follows, and that racer is in frame.
    const reach = Math.hypot(24, 7) // TV_CAMERA_POLICY.chaseBehind, chaseAbove
    await page.mouse.move(x0, y0)
    await page.mouse.down()
    // The near-plane rule (USER_LIMITS in tv-framing.ts) pulls the eye in on the
    // frames where a gate solid is within 3 m of it or the ground within 2 m,
    // and the chase lifts off the ground by 3 m: about 1 to 5 % of frames, so
    // one frame cannot be asserted exactly. Every frame is no FARTHER than the
    // radius (a hold only brings the eye in), and most hold it.
    const distances: number[] = []
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(x0 + i * 25, y0 - i * 4)
      const g = await orbitGeometry(page)
      expect(g, 'the followed racer is on the course').not.toBeNull()
      distances.push(g?.distance ?? Number.NaN)
      expect(g?.distance ?? Number.NaN, 'a hold never pushes the eye past the radius').toBeLessThan(
        reach + 0.05,
      )
      expect(g?.offAxisDegrees, 'the racer is in frame').toBeLessThan(30)
    }
    const atRadius = distances.filter((d) => Math.abs(d - reach) < 0.05).length
    expect(
      atRadius,
      `the eye is the orbit radius from the racer on most frames: ${JSON.stringify(distances)}`,
    ).toBeGreaterThanOrEqual(9)
    const during = (await pose(page)).cam
    await photo(page, 'tv-orbit')
    await page.mouse.up()
    console.info(`DEV-616 orbit: ${JSON.stringify(during?.orbit)} on ${during?.following}`)
    expect(during?.orbit, 'the drag swung the chase').toBeTruthy()
    expect(during?.mode).toBe('follow')
    await page.waitForTimeout(300)
    expect(await locked(), 'nor does a drag').toBe(false)
    expect((await pose(page)).cam?.following, 'the drag’s own click is not a press').toBe(
      during?.following,
    )
    expect(before).toBeTruthy()
    // Let go: after the hold it eases back onto the chase.
    await expect
      .poll(async () => (await pose(page)).cam?.orbit ?? null, {
        timeout: 12_000,
        message: 'let go, the orbit eases back to the chase',
      })
      .toBeNull()

    // DEV-628: Matt, "moving the camera takes me to a first person cam at
    // launch position". Free took its first pose from the rig, which the
    // mission's camera had just set to the hidden craft's cockpit on the pad.
    // It starts where the chase was now.
    const chase = (await pose(page)).p
    await page.keyboard.press('KeyC')
    await expect.poll(async () => (await pose(page)).cam?.mode).toBe('free')
    const free = (await pose(page)).p
    const moved = Math.hypot(free[0] - chase[0], free[1] - chase[1], free[2] - chase[2])
    console.info(`DEV-628 Free: ${moved.toFixed(2)} m from the chase eye`)
    expect(moved, 'Free starts at the chase eye, not on the launch pad').toBeLessThan(40)

    // The hint, and the way out: a free Escape leaves for the hangar.
    const controls = await tvControls(page)
    expect(controls.shown).toBe(true)
    expect(controls.hint).toMatch(/CLICK follow a racer/)
    await page.keyboard.press('KeyC') // back to the Director: the hint as most viewers see it
    await expect.poll(async () => (await tvControls(page)).hint).toMatch(/CLICK next racer/)
    await photo(page, 'tv-controls-flat')
    // Held for a frame, as a player's is: the game reads Escape as a held state, and a press
    // with no delay can fall between two frames and never be seen.
    await hold(page, 'Escape', 0)
    await expect.poll(() => tvProbe(page), { timeout: 30_000 }).toBeNull()
    expect(new URL(page.url()).searchParams.has('tv'), 'the link is spent').toBe(false)
    await expect
      .poll(() => hangarDoors(page), { timeout: 60_000, message: 'back in the hangar' })
      .toContain(DOOR_TV)
    expect((await tvControls(page)).shown).toBe(false)
  })
})
