// tests/e2e/making-of.spec.ts: every making-of page loads, every toy mounts and
// draws, and the console stays clean. DEV-510 (docs/plan/MAKING-OF.md §2.9).
//
// No test loaded a page of either earlier making-of site, so a page could break
// for as long as nobody opened it. This one walks the pages that exist on disk,
// scrolls each toy into view, and asserts POSITIVELY: a canvas (or a table) with area and a
// readout row, because a toy that drew nothing reports zero errors too.
//
// The two behavioural tests are the chapter's claims, played: the edge
// semantics leave a ship that spawns outside alone, and the level test loops it
// through resets.

import { expect, type Page } from '@playwright/test'
import { pagesOnDisk } from '../../tools/making-of/plugin'
import { test } from './fixtures/test'

const slugs = pagesOnDisk(process.cwd())
const url = (slug: string) => (slug === 'index' ? '/making-of/' : `/making-of/${slug}/`)

const watchConsole = (page: Page) => {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(String(e)))
  return errors
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone portrait', width: 375, height: 812 },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    for (const slug of slugs) {
      test(`${slug}: loads, mounts its toys, console clean`, async ({ page }) => {
        const errors = watchConsole(page)
        await page.goto(url(slug))
        await expect(page.locator('nav.site-nav')).toBeVisible()
        const toys = page.locator('[data-toy]')
        const count = await toys.count()
        for (let i = 0; i < count; i++) {
          const toy = toys.nth(i)
          await toy.scrollIntoViewIfNeeded()
          const surface = toy.locator('canvas, table.const-table, .live-window').first()
          await expect(surface).toBeVisible()
          const box = await surface.boundingBox()
          expect(box?.width ?? 0).toBeGreaterThan(100)
          expect(box?.height ?? 0).toBeGreaterThan(100)
          await expect(toy.locator('.demo-readouts')).not.toBeEmpty()
          // A toy that mounted twice (a remount that did not clear its controls) shows two rows.
          await expect(toy.locator('.demo-controls')).toHaveCount(1)
        }
        // No horizontal page scroll, on a phone above all.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        )
        expect(overflow).toBeLessThanOrEqual(1)
        expect(errors).toEqual([])
      })
    }
  })
}

test('data-const and data-snippet were resolved into the page', async ({ page }) => {
  await page.goto(url('bugs'))
  await expect(page.locator('span.const').first()).toContainText('13')
  await expect(page.locator('figure.snippet').first()).toContainText('createBoundary')
  expect(await page.locator('[data-const], [data-snippet]').count()).toBe(0)
})

test('edge semantics leave a ship that spawns outside alone; the level test loops it', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.goto(url('bugs'))
  const toy = page.locator('[data-toy="edge-vs-level"]')
  await toy.scrollIntoViewIfNeeded()
  await expect(toy.locator('.demo-readouts')).toContainText('resets')
  const resets = async () =>
    Number(/resets\s*(\d+)/.exec((await toy.locator('.demo-readouts').textContent()) ?? '')?.[1])
  // Fastest clock, then wait well past resetDelay + fade (15.5 sim seconds).
  await toy.locator('input[type=range]').fill('8')
  await page.waitForTimeout(4000)
  expect(await resets()).toBe(0)
  await toy.getByRole('button', { name: 'level test' }).click()
  await expect.poll(resets, { timeout: 30_000 }).toBeGreaterThan(0)
})

test('without interpolation the ball judders at 60 Hz, with it the steps are even', async ({
  page,
}) => {
  await page.goto(url('archaeology'))
  const toy = page.locator('[data-toy="tick-vs-frame"]')
  await toy.scrollIntoViewIfNeeded()
  const ratio = async () =>
    Number(
      /step ratio\s*([\d.]+)x/.exec((await toy.locator('.demo-readouts').textContent()) ?? '')?.[1],
    )
  await expect.poll(ratio, { timeout: 10_000 }).toBeLessThan(1.05)
  await toy.getByRole('checkbox').uncheck()
  await expect.poll(ratio, { timeout: 10_000 }).toBeGreaterThan(1.05)
})

test('the gap under a steep probe is larger than under a flat one', async ({ page }) => {
  await page.goto(url('terrain'))
  const toy = page.locator('[data-toy="flat-vs-steep"]')
  await toy.scrollIntoViewIfNeeded()
  await expect(toy.locator('.demo-readouts')).toContainText('gap here')
  const gapAfter = async (button: string) => {
    await toy.getByRole('button', { name: button }).click()
    const text = (await toy.locator('.demo-readouts').textContent()) ?? ''
    return Number(/gap here\s*([\d.]+)\s*m/.exec(text)?.[1])
  }
  const flat = await gapAfter('flattest')
  const steep = await gapAfter('steepest')
  expect(steep).toBeGreaterThan(flat)
})

test('the diagonal bug flips a share of the quads, and turning it off flips none', async ({
  page,
}) => {
  await page.goto(url('terrain'))
  const toy = page.locator('[data-toy="facet-island"]')
  await toy.scrollIntoViewIfNeeded()
  const flipped = async () =>
    Number(
      /intended rule\s*(\d+)/.exec((await toy.locator('.demo-readouts').textContent()) ?? '')?.[1],
    )
  await expect.poll(flipped).toBeGreaterThan(0)
  await toy.getByLabel('2016 diagonal bug').uncheck()
  await expect.poll(flipped).toBe(0)
})

test('the flown speed settles on the model, and boost raises it', async ({ page }) => {
  await page.goto(url('flight'))
  const toy = page.locator('[data-toy="flight-bench"]')
  await toy.scrollIntoViewIfNeeded()
  const read = async () => {
    const text = (await toy.locator('.demo-readouts').textContent()) ?? ''
    return {
      speed: Number(/speed\s*([\d.]+)\s*m\/s/.exec(text)?.[1]),
      model: Number(/model settles at\s*([\d.]+)\s*m\/s/.exec(text)?.[1]),
    }
  }
  await expect
    .poll(
      async () => {
        const { speed, model } = await read()
        return Math.abs(speed - model) / model
      },
      { timeout: 30_000 },
    )
    .toBeLessThan(0.02)
  const cruise = (await read()).model
  await toy.getByLabel('boost').check()
  await expect.poll(async () => (await read()).model).toBeGreaterThan(cruise * 1.5)
  await toy.getByLabel('launched').uncheck()
  await expect(toy.locator('.demo-readouts')).toContainText('on (not launched)')
})

test('thinning the line balloons the corner distance far more than the line distance', async ({
  page,
}) => {
  await page.goto(url('opposition'))
  const toy = page.locator('[data-toy="route-ruler"]')
  await toy.scrollIntoViewIfNeeded()
  const read = async () => {
    const text = (await toy.locator('.demo-readouts').textContent()) ?? ''
    return {
      line: Number(/to the line\s*([\d.]+)\s*m/.exec(text)?.[1]),
      corner: Number(/nearest corner\s*([\d.]+)\s*m/.exec(text)?.[1]),
    }
  }
  await expect(toy.locator('.demo-readouts')).toContainText('to the line')
  await toy.locator('input[type=range]').nth(0).fill('5')
  await expect.poll(async () => (await read()).corner).toBeGreaterThan(5)
  const before = await read()
  await toy.locator('input[type=range]').nth(1).fill('6')
  await expect.poll(async () => (await read()).corner).toBeGreaterThan(before.corner * 2)
  const after = await read()
  expect(after.line).toBeLessThan(after.corner / 2)
  expect(before.corner).toBeGreaterThan(before.line)
})

test('the live window loads nothing until asked, and its link always says xr=off', async ({
  page,
}) => {
  await page.goto(url('why'))
  const toy = page.locator('[data-toy="live-window"]')
  await toy.scrollIntoViewIfNeeded()
  await expect(toy.getByRole('button', { name: 'Load the game here' })).toBeVisible()
  expect(await page.locator('iframe').count()).toBe(0)
  for (const choice of ['fly it yourself', 'Classic', 'watch the autopilot']) {
    await toy.getByRole('button', { name: choice }).click()
    await expect(toy.locator('.demo-readouts')).toContainText('xr=off')
  }
})

test('the engine voice runs the real director: idle on start, thrust with the throttle', async ({
  page,
}) => {
  await page.goto(url('sound'))
  const toy = page.locator('[data-toy="engine-voice"]')
  await toy.scrollIntoViewIfNeeded()
  await toy.getByRole('button', { name: 'start sound' }).click()
  await expect(toy.locator('.demo-readouts')).toContainText('engine.idle', { timeout: 10_000 })
  await toy.locator('input[type=range]').fill('1')
  await expect(toy.locator('.demo-readouts')).toContainText('engine.thrust', { timeout: 10_000 })
  await expect(toy.locator('.demo-readouts')).toContainText('wind.aircraft', { timeout: 20_000 })
})

test('the lap server accepts the honest lap and refuses each forgery at its own stage', async ({
  page,
}) => {
  await page.goto(url('racing'))
  const toy = page.locator('[data-toy="lap-judge"]')
  await toy.scrollIntoViewIfNeeded()
  const verdict = toy.locator('.demo-readouts')
  await expect(verdict).toContainText('ACCEPTED, on the board', { timeout: 20_000 })
  const expected: [string, string][] = [
    ['fly faster', 'REFUSED at speed'],
    ['teleport', 'REFUSED at continuity'],
    ['jump', 'REFUSED at continuity'],
    ['lie', 'REFUSED at claimed'],
    ['skip a ring', 'ACCEPTED, off the board'],
  ]
  for (const [button, text] of expected) {
    await toy.getByRole('button', { name: button, exact: true }).click()
    await expect(verdict).toContainText(text)
  }
})

test('the pocket editor expands points into rings and packs them into a link that grows', async ({
  page,
}) => {
  await page.goto(url('courses'))
  const toy = page.locator('[data-toy="pocket-editor"]')
  const canvas = toy.locator('canvas')
  await canvas.scrollIntoViewIfNeeded()
  const box = (await canvas.boundingBox()) as { width: number; height: number }
  const read = async () => {
    const text = (await toy.locator('.demo-readouts').textContent()) ?? ''
    return {
      rings: Number(/rings\s*(\d+)/.exec(text)?.[1] ?? 0),
      link: Number(/share link\s*(\d+) characters/.exec(text)?.[1] ?? 0),
    }
  }
  await expect(toy.locator('.demo-readouts')).toContainText('not shareable yet')
  await canvas.click({ position: { x: box.width * 0.3, y: box.height * 0.6 } })
  await expect.poll(async () => (await read()).link).toBeGreaterThan(0)
  const two = await read()
  expect(two.rings).toBeGreaterThan(0)
  await canvas.click({ position: { x: box.width * 0.6, y: box.height * 0.25 } })
  await expect.poll(async () => (await read()).link).toBeGreaterThan(two.link)
  expect((await read()).rings).toBeGreaterThan(two.rings)
})

test('the response curve: Classic is the plain response, Anniversary ships a warp', async ({
  page,
}) => {
  await page.goto(url('looks'))
  const toy = page.locator('[data-toy="response-curve"]')
  await toy.scrollIntoViewIfNeeded()
  const strength = async () =>
    Number(
      /warp strength\s*([\d.]+)/.exec(
        (await toy.locator('.demo-readouts').textContent()) ?? '',
      )?.[1],
    )
  expect(await strength()).toBeGreaterThan(0)
  await toy.getByRole('button', { name: 'Classic (off)' }).click()
  expect(await strength()).toBe(0)
})
