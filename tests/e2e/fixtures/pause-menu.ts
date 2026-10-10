// tests/e2e/fixtures/pause-menu.ts: walk the pause plate BY NAME. DEV-621.
//
// Since DEV-621 the plate has pages: the root (resume, restart, options,
// exit, and EXIT or ENTER VR) and OPTIONS (DEV-859: mute, volume, invert pitch,
// look, comfort, controls, more, back), with MORE (quality, race strip, effects,
// credits, report bug) one page further in. A spec that counted
// ArrowDowns to a row ran into a different row the day the pages came in,
// which is the reason this file exists: every helper here names its target
// and computes the walk from `__ff2.pausePlate()`, the same value the painter
// and the A press read.
//
// The ids are literals, not imports: one import edge from here into `src/`
// reaches `import.meta.glob` and takes the whole e2e collection to zero.

import { expect, type Page } from '@playwright/test'
import type { Ff2Global } from './ff2'
import { hold } from './hangar'

/** The plate as `__ff2.pausePlate()` reports it. */
export interface PausePlateState {
  readonly open: boolean
  readonly page: string
  readonly title: string
  readonly rows: readonly {
    readonly id: string
    readonly label: string
    readonly value: string | null
  }[]
  readonly selected: number
  /** DEV-623: sheet-widths the credits roll has climbed since it opened, or null before it ever has. */
  readonly rolled?: number | null
  /** DEV-796: the panel's top and bottom edges on the glass, css px, and the glass height. */
  readonly edges?: {
    readonly top: number
    readonly bottom: number
    readonly glass: number
    readonly x: number
    readonly rowY: readonly number[]
  } | null
}

/** The rows that live on OPTIONS, not on the root (DEV-859: LOOK is the row id 'edition'). */
export const OPTIONS_PAGE_ROWS: ReadonlySet<string> = new Set([
  'mute',
  'volume',
  'invert',
  'edition',
  'comfort',
  'controls',
  'more',
])

/** The rows that live on MORE, one page further in (DEV-859). */
export const MORE_PAGE_ROWS: ReadonlySet<string> = new Set([
  'quality',
  'racestrip',
  'advanced',
  'credits',
  'reportbug',
])

/** `__ff2.pausePlate()`. */
export const pausePlateState = (page: Page): Promise<PausePlateState> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    return w.__ff2.pausePlate()
  })

/**
 * Step the selection to the row `id` on the page that is up, with the arrow
 * keys, reading the plate after every step. Fails if the row is not there.
 */
export const selectPauseRow = async (page: Page, id: string): Promise<void> => {
  await expect
    .poll(
      async () => {
        const p = await pausePlateState(page)
        const want = p.rows.findIndex((r) => r.id === id)
        if (want < 0) return `no ${id} row on the ${p.page} page`
        if (p.selected === want) return 'selected'
        await hold(page, p.selected < want ? 'ArrowDown' : 'ArrowUp', 200)
        return `at ${p.selected}, want ${want}`
      },
      { message: `the ${id} row is selected`, timeout: 20_000 },
    )
    .toBe('selected')
}

/**
 * Press the row `id`, on whichever page holds it: on the root, or on OPTIONS
 * by way of OPTIONS. The plate must already be up. Returns once the press is
 * sent; the caller waits on whatever the row does.
 */
export const pressPauseRow = async (page: Page, id: string, settle = 600): Promise<void> => {
  const p = await pausePlateState(page)
  expect(p.open, 'the pause plate is up').toBe(true)
  const here = p.rows.some((r) => r.id === id)
  const deep = MORE_PAGE_ROWS.has(id)
  if (!here && (OPTIONS_PAGE_ROWS.has(id) || deep) && p.page === 'pause') {
    await selectPauseRow(page, 'options')
    await hold(page, 'Enter', 400)
    await expect.poll(async () => (await pausePlateState(page)).page).toBe('options')
  }
  // DEV-859: quality, race strip, effects, credits and report bug are one page in.
  if (deep && !(await pausePlateState(page)).rows.some((r) => r.id === id)) {
    await selectPauseRow(page, 'more')
    await hold(page, 'Enter', 400)
    await expect.poll(async () => (await pausePlateState(page)).page).toBe('more')
  }
  await selectPauseRow(page, id)
  await hold(page, 'Enter', settle)
}

/** Open the OPTIONS page from the root plate. */
export const openOptions = async (page: Page): Promise<void> => {
  await pressPauseRow(page, 'options', 400)
  await expect.poll(async () => (await pausePlateState(page)).page).toBe('options')
}

/** The ids on the root plate and on OPTIONS, opening and leaving OPTIONS to read it. */
export const allPauseRowIds = async (page: Page): Promise<string[]> => {
  const root = await pausePlateState(page)
  if (root.page !== 'pause') return root.rows.map((r) => r.id)
  await openOptions(page)
  const options = await pausePlateState(page)
  await hold(page, 'Backspace', 400)
  await expect.poll(async () => (await pausePlateState(page)).page).toBe('pause')
  return [...root.rows.map((r) => r.id), ...options.rows.map((r) => r.id)]
}
