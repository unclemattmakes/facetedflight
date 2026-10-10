/**
 * tests/e2e/phone-refit.spec.ts: a phone turned, and the picture still the
 * shape of the glass. DEV-595.
 *
 * Matt, 2026-10-03, on his phone: *"phone - camera aspect is squished after
 * rotating. doesn't go into full screen"*.
 *
 * ── What is asserted, and why it is GEOMETRY ─────────────────────────────
 *
 * A squished picture is three numbers disagreeing: the canvas's box (css px),
 * its drawing buffer (device px, the box times the renderer's pixel ratio,
 * floored as three floors it) and the camera's aspect. A screenshot needs an
 * eye to tell a stretched frame from a wide lens; these do not. So every view
 * a player can turn the phone on (the title, the hangar, the cockpit, the
 * chase camera, the results) is checked the same way after each turn: the box
 * fills the window, the buffer is the box at the pixel ratio, and the aspect
 * is the box's. One camera serves all of them, so this is one rule read five
 * times, not five rules.
 *
 * TURNING is `setViewportSize` with the sides swapped, which is Chromium's
 * own rotation under device emulation (`mobile-controls.spec.ts` says the
 * same). It changes the viewport and sends `resize` in one step, which is the
 * kind case: the handler this row replaced passed it too. The unkind case, a
 * box that moves with no `resize` after it (what a phone does when its event
 * fires ahead of the layout), cannot be produced by emulation, so the second
 * block makes the box move by restyling the canvas, which sends no event at
 * all. The game's code path is the same either way; only how the box moved
 * differs. That block is the one that was RED before the fix.
 *
 * ── Fullscreen ──────────────────────────────────────────────────────────
 *
 * A real tap (`touchscreen.tap`, a CDP touch: a real user activation) on the
 * emulated Pixel 7 must put the page in fullscreen, and the picture must fit
 * on the way in and on the way out. Matt's phone is an iPhone 13 Pro, which
 * has no element fullscreen at all; no WebKit is installed here, so the iPhone
 * blocks are Chromium wearing that descriptor's numbers with the API taken out
 * of the browser before the page loads (an init script, the same kind of thing
 * device emulation does to `maxTouchPoints`): the title re-fits through a
 * Safari-sized turn, and the turn screen shows the home-screen line once. The
 * game reads the platform either way; nothing in it is switched by the test.
 *
 * Photographs go to `PHONE_REFIT_DIR` (default `test-results/phone-refit`).
 */

import { TURN_HOME_SCREEN_NOTE, TURN_ROOT_ID } from '@/input/turn-phone'
import { switchSettled } from './fixtures/boot'
import type { Ff2Global, Ff2GlobalMaybe } from './fixtures/ff2'
import { firstPress, loadSettled } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { devices, expect, type Page, test } from './fixtures/test'
import { TITLE_ROW, tapTitleRow } from './fixtures/title'

const READY = { timeout: 180_000 }
const FLAT = '/?xr=off'

/** A Pixel 7 held sideways, field by field for `mobile-controls.spec.ts`'s reason. */
const PHONE = {
  viewport: { width: 915, height: 412 },
  deviceScaleFactor: devices['Pixel 7'].deviceScaleFactor,
  userAgent: devices['Pixel 7'].userAgent,
  isMobile: true,
  hasTouch: true,
}
/** The same phone held upright. */
const UPRIGHT = { width: PHONE.viewport.height, height: PHONE.viewport.width }

const chip = (act: string) => `#touch-controls [data-act="${act}"]`
const TURN = `#${TURN_ROOT_ID}`

interface Fit {
  readonly inner: readonly [number, number]
  readonly box: readonly [number, number]
  readonly buffer: readonly [number, number]
  readonly ratio: number
  readonly aspect: number
}

/** The three numbers a squish is made of, and the window they should match. */
const readFit = (page: Page): Promise<Fit> =>
  page.evaluate(() => {
    const canvas = document.getElementById('viewport') as HTMLCanvasElement
    const r = (globalThis as unknown as Ff2Global).__ff2.render
    return {
      inner: [innerWidth, innerHeight] as const,
      box: [canvas.clientWidth, canvas.clientHeight] as const,
      buffer: [canvas.width, canvas.height] as const,
      ratio: r.renderer.getPixelRatio(),
      aspect: r.camera.aspect,
    }
  })

/**
 * What is wrong with a fit, as words; empty when nothing is. `fillsWindow`
 * is false for the restyled-canvas block, where the box is deliberately not
 * the window's.
 */
const misfit = (f: Fit, fillsWindow = true): string => {
  const wrong: string[] = []
  if (fillsWindow && (f.box[0] !== f.inner[0] || f.box[1] !== f.inner[1])) {
    wrong.push(`box ${f.box.join('x')} is not the window ${f.inner.join('x')}`)
  }
  const want = [Math.floor(f.box[0] * f.ratio), Math.floor(f.box[1] * f.ratio)]
  if (f.buffer[0] !== want[0] || f.buffer[1] !== want[1]) {
    wrong.push(`buffer ${f.buffer.join('x')} is not the box at ${f.ratio} (${want.join('x')})`)
  }
  const aspect = f.box[0] / f.box[1]
  if (Math.abs(f.aspect - aspect) > 1e-9) {
    wrong.push(`camera aspect ${f.aspect.toFixed(4)} is not the box's ${aspect.toFixed(4)}`)
  }
  return wrong.join('; ')
}

/** Fitted within a second: the follow-up frames and the observer are both well inside it. */
const expectFitted = async (page: Page, where: string, fillsWindow = true): Promise<Fit> => {
  await expect
    .poll(async () => misfit(await readFit(page), fillsWindow), {
      message: `${where}: the picture fits its glass`,
      timeout: 1_000,
      intervals: [50],
    })
    .toBe('')
  const f = await readFit(page)
  console.info(
    `${where}: window ${f.inner.join('x')} · buffer ${f.buffer.join('x')} · aspect ${f.aspect.toFixed(4)}`,
  )
  return f
}

const turnState = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.body.dataset.turnPhone ?? null)

interface Size {
  readonly width: number
  readonly height: number
}

/** Turn the phone upright and back, asserting the fit at each end. */
const turnAndBack = async (
  page: Page,
  where: string,
  shot: (name: string) => Promise<void>,
  sides: { readonly sideways: Size; readonly upright: Size } = {
    sideways: PHONE.viewport,
    upright: UPRIGHT,
  },
) => {
  const before = await expectFitted(page, `${where}, sideways`)
  expect(before.aspect, `${where}: sideways is wide`).toBeGreaterThan(1)
  await shot(`${where}-1-sideways`)
  await page.setViewportSize(sides.upright)
  await expect.poll(() => turnState(page), { timeout: 10_000 }).toBe('up')
  const upright = await expectFitted(page, `${where}, upright`)
  expect(upright.aspect, `${where}: upright is tall`).toBeLessThan(1)
  await shot(`${where}-2-upright`)
  await page.setViewportSize(sides.sideways)
  await expect.poll(() => turnState(page), { timeout: 10_000 }).toBe('down')
  const after = await expectFitted(page, `${where}, sideways again`)
  expect(after.aspect).toBeCloseTo(before.aspect, 9)
  // Give the frame the turn screen covered a moment to draw before the photo.
  await page.waitForTimeout(400)
  await shot(`${where}-3-sideways-again`)
}

const plateOpen = (page: Page): Promise<boolean> =>
  page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.pausePlate().open)

/** The run waits behind the pause plate after a turn (DEV-566); RESUME is the hamburger. */
const resume = async (page: Page) => {
  await expect.poll(() => plateOpen(page), { timeout: 10_000 }).toBe(true)
  await page.locator(chip('pause')).tap()
  await expect.poll(() => plateOpen(page), { timeout: 10_000 }).toBe(false)
}

const appScreen = (page: Page): Promise<string | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()?.screen ?? null)

test.describe('every view re-fits after a turn (DEV-595) @gpu', () => {
  test.use(PHONE)
  test.setTimeout(600_000)

  const dir = process.env.PHONE_REFIT_DIR ?? 'test-results/phone-refit'
  const shooter = (page: Page) => (name: string) =>
    page
      .screenshot({ path: `${dir}/${name}-${PINNED.replace(/[=&]/g, '')}.png` })
      .then(() => undefined)

  test('the title and the hangar', async ({ page }) => {
    const shot = shooter(page)
    await page.goto(`${FLAT}&${PINNED}`)
    await firstPress(page, { tap: true })
    await turnAndBack(page, 'title', shot)

    // DEV-619: the plate's START row is the button on a phone.
    await tapTitleRow(page, TITLE_ROW.hangar)
    await expect.poll(() => appScreen(page), { timeout: 10_000 }).toBe('menu')
    await page.waitForTimeout(1_500)
    await turnAndBack(page, 'hangar', shot)
  })

  test('the cockpit, the chase camera and the results', async ({ page }) => {
    const shot = shooter(page)
    const said: string[] = []
    page.on('console', (m) => said.push(m.text()))
    await page.goto(`/?autopilot=1&ride=0&mission=int_01_hoverJet&xr=off&${PINNED}`)
    await firstPress(page, { tap: true })
    await switchSettled(page, READY.timeout)
    await page.waitForTimeout(2_000)
    await turnAndBack(page, 'flight-cockpit', shot)
    await resume(page)

    // The chase camera: the chip a thumb uses, and the game's own line for it.
    await page.locator(chip('cam')).tap()
    await expect.poll(() => said.some((s) => s.includes('camera: third person'))).toBe(true)
    await page.waitForTimeout(1_500)
    await turnAndBack(page, 'flight-chase', shot)
    await resume(page)

    await page.waitForSelector('body[data-finished="true"]', { timeout: 360_000 })
    await page.waitForTimeout(1_500)
    await turnAndBack(page, 'results', shot)
  })
})

test.describe('the box moves with no resize after it (DEV-595) @gpu', () => {
  test.use(PHONE)

  test('the picture follows the canvas box, not the window event', async ({ page }) => {
    await page.goto(`${FLAT}&${PINNED}`)
    await loadSettled(page, READY.timeout)
    await expectFitted(page, 'booted')
    // A layout that lands after the event: the canvas takes a new shape and
    // the window sends nothing. Only the canvas's own observer can see this.
    await page.evaluate(() => {
      const canvas = document.getElementById('viewport') as HTMLCanvasElement
      canvas.style.height = '60%'
    })
    const moved = await expectFitted(page, 'box restyled, no event', false)
    expect(moved.box[1], 'the premise: the box really moved').toBeLessThan(moved.inner[1])
    await page.evaluate(() => {
      const canvas = document.getElementById('viewport') as HTMLCanvasElement
      canvas.style.height = ''
    })
    await expectFitted(page, 'restored')
  })
})

test.describe('a phone goes fullscreen on its first tap (DEV-595) @gpu', () => {
  test.use(PHONE)

  test('a real tap on a Pixel 7: fullscreen, and the picture fits in and out', async ({ page }) => {
    const said: string[] = []
    page.on('console', (m) => said.push(m.text()))
    await page.goto(`${FLAT}&${PINNED}`)
    await firstPress(page, { tap: true })
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement !== null), {
        message: `fullscreen after the first tap (console: ${said.filter((s) => s.includes('fullscreen') || s.includes('orientation')).join(' | ')})`,
        timeout: 5_000,
      })
      .toBe(true)
    await expectFitted(page, 'fullscreen')
    console.info(
      said.filter((s) => s.includes('fullscreen') || s.includes('orientation')).join('\n'),
    )
    // Leaving it, as the back gesture does.
    await page.evaluate(() => document.exitFullscreen())
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
    await expectFitted(page, 'left fullscreen')
    // And the next tap does not pull the player back in.
    await page.touchscreen.tap(PHONE.viewport.width / 2, PHONE.viewport.height / 2)
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
  })
})

// ── Matt's phone: an iPhone 13 Pro (the lead, 2026-10-03) ────────────────
//
// No WebKit is installed here, so this is Chromium wearing the iPhone 13 Pro
// descriptor's numbers, spelled out for PHONE's reason: Safari's viewport with
// its bars (390 x 664 upright, 750 x 342 sideways), the SCREEN iOS reports
// (390 x 844, portrait whichever way it is held, which is what `isPhone`
// reads), a device pixel ratio of 3 and the iPhone's user agent. And with no
// element fullscreen: the init script takes `requestFullscreen` off the
// browser before the page loads, which is the API an iPhone's Safari does not
// have. The game reads the platform; nothing in it is switched by the test.
const IPHONE = {
  viewport: { width: 750, height: 342 },
  screen: { width: 390, height: 844 },
  deviceScaleFactor: devices['iPhone 13 Pro'].deviceScaleFactor,
  userAgent: devices['iPhone 13 Pro'].userAgent,
  isMobile: true,
  hasTouch: true,
}
const IPHONE_UPRIGHT = { width: 390, height: 664 }
const noElementFullscreen = (page: Page) =>
  page.addInitScript(() => {
    Reflect.deleteProperty(Element.prototype, 'requestFullscreen')
  })

test.describe('an iPhone 13 Pro re-fits after a turn (DEV-595) @gpu', () => {
  test.use(IPHONE)
  test.setTimeout(300_000)

  test('the title, turned upright and back, with Safari-sized viewports', async ({ page }) => {
    const dir = process.env.PHONE_REFIT_DIR ?? 'test-results/phone-refit'
    const shot = (name: string) =>
      page
        .screenshot({ path: `${dir}/iphone13pro-${name}-${PINNED.replace(/[=&]/g, '')}.png` })
        .then(() => undefined)
    await noElementFullscreen(page)
    await page.goto(`${FLAT}&${PINNED}`)
    await firstPress(page, { tap: true })
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
    await turnAndBack(page, 'title', shot, { sideways: IPHONE.viewport, upright: IPHONE_UPRIGHT })
  })
})

test.describe('an iPhone is told its route to full screen, once (DEV-595)', () => {
  test.use({ ...IPHONE, viewport: IPHONE_UPRIGHT })

  test('the turn screen says Add to Home Screen on the first load, and never again', async ({
    page,
  }) => {
    await noElementFullscreen(page)
    await page.goto(FLAT)
    await expect.poll(() => turnState(page), { timeout: 60_000 }).toBe('up')
    await expect(page.locator(TURN).getByText(TURN_HOME_SCREEN_NOTE)).toBeVisible()
    // A tap asks nothing the phone cannot do, and throws nothing.
    await page.touchscreen.tap(195, 332)
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
    // The next visit: the turn screen, without the line. A hint, not a nag.
    await page.reload()
    await expect.poll(() => turnState(page), { timeout: 60_000 }).toBe('up')
    await expect(page.locator(TURN)).toBeVisible()
    await expect(page.locator(TURN).getByText(TURN_HOME_SCREEN_NOTE)).toBeHidden()
  })

  test('not once it runs from the home screen', async ({ page }) => {
    await noElementFullscreen(page)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
    })
    await page.goto(FLAT)
    await expect.poll(() => turnState(page), { timeout: 60_000 }).toBe('up')
    await expect(page.locator(TURN).getByText(TURN_HOME_SCREEN_NOTE)).toBeHidden()
  })
})

test.describe('an iPhone opened sideways is told on the title, once (DEV-795)', () => {
  // Matt, 2026-10-07 (go with your recs, QUESTIONS item 21): a player who never
  // meets the turn screen reads the same line on the title's credit line.
  test.use(IPHONE)
  test.setTimeout(300_000)

  test('the credit line says it on the first load, and not on the next', async ({ page }) => {
    await noElementFullscreen(page)
    await page.goto(`${FLAT}&${PINNED}`)
    await firstPress(page, { tap: true })
    await expect(page.locator('#title-line')).toHaveText(TURN_HOME_SCREEN_NOTE, {
      timeout: 60_000,
    })
    await page.reload()
    await firstPress(page, { tap: true })
    await expect(page.locator('body')).toHaveAttribute('data-title-up', '', { timeout: 60_000 })
    await expect(page.locator('#title-line')).not.toHaveText(TURN_HOME_SCREEN_NOTE)
    await expect(page.locator('#title-line')).toContainText('Uncle Matt Makes')
  })
})

test.describe('an Android phone is not told it (DEV-595)', () => {
  test.use({ ...PHONE, viewport: UPRIGHT })

  test('it has fullscreen, so the turn screen carries no home-screen line', async ({ page }) => {
    await page.goto(FLAT)
    await expect.poll(() => turnState(page), { timeout: 60_000 }).toBe('up')
    await expect(page.locator(TURN)).toBeVisible()
    await expect(page.locator(TURN).getByText(TURN_HOME_SCREEN_NOTE)).toBeHidden()
  })
})

test.describe('a tablet never goes fullscreen (DEV-595)', () => {
  // An iPad Air held upright, under the same emulation a phone gets.
  test.use({ ...PHONE, viewport: { width: 820, height: 1180 } })

  test('a tap on a tablet is a tap', async ({ page }) => {
    await page.goto(FLAT)
    await expect.poll(() => turnState(page), { timeout: 60_000 }).toBe('down')
    await page.touchscreen.tap(410, 590)
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
  })
})

test.describe('a desktop never goes fullscreen (DEV-595)', () => {
  test('the first press is a press, and there is no turn screen', async ({ page }) => {
    await page.goto(FLAT)
    await firstPress(page)
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
    await expect(page.locator(TURN)).toHaveCount(0)
  })
})
