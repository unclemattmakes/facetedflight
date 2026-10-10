/**
 * Your best lap, kept locally, and "race this lap" — on the route a player
 * takes. DEV-371.
 *
 * From the title, through the hangar's four aimed presses, onto `int_01`'s pad
 * (`fixtures/hangar.ts`), never `?mission=`: AGENT-NOTES §8's first bullet.
 * The autopilot flies (P, which is also what launches it), so every lap here
 * is TAINTED, and a tainted lap is exactly what the store must still keep and
 * race locally. Since DEV-601 it keeps one only when ASKED: an autopilot lap
 * is not saved as your ghost of its own accord, so each lap here is kept by
 * the panel's SAVE AS YOUR GHOST? row, pressed with the arrow keys and Enter.
 *
 *   1. Lap one finishes. The lap it keeps is its own poses, rescored, and its
 *      time IS the live `finishAt`, to the bit. Tainted by the autopilot and by
 *      nothing in this URL: the pins below are on the presentation allowlist.
 *   2. BACKSPACE flies again (A/ENTER goes home since DEV-406), and lap two races your best: a ghost whose standing
 *      is lap one's time. It is not a racer — the field is the preset's grid
 *      and the ghost hangs under its own group, not under `racers`.
 *   3. After lap two, R ("race this lap") restarts with lap TWO as the ghost.
 *   4. A reload: the kept lap is the ghost at world build (on by default),
 *      and the burst — the ghost beside the racers, from a chase camera behind
 *      `fast`, with the player idle on the line. Both presets.
 *
 * Every assertion reads `__ff2.laps()`, the controller's own state; the panel
 * is photographed from its texture (`results`), full resolution. Nothing here
 * imports `src/`: `game/ghosts.ts` reaches `import.meta.glob`, and one such
 * edge collects zero Playwright tests.
 *
 *   GHOST_LOCAL_DIR=<dir> E2E_PORT=<yours> pnpm exec playwright test tests/e2e/ghost-local.spec.ts
 *
 * Tagged `@gpu`. Pinned `adaptive=0&quality=high`, and the pin is in every file name.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bootReady, missionReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { board, hold, INT_01_HOVERJET } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

/** Playwright wipes `test-results/` on every run, so a burst goes somewhere else. */
const OUT = process.env.GHOST_LOCAL_DIR ?? path.join('test-results', 'ghost-local')
const PIN_TAG = PINNED.replace(/[=&]/g, '')

/** What `App.laps()` returns (DEV-371); written out here rather than imported. */
interface LapsReport {
  run: { tick: number; clock: number; taint: string[] }
  last: {
    seconds: number | null
    gates: number
    keys: number
    finishTick: number
    rules: string
    vehicle: string
    tainted: boolean
    reasons: string[]
    improved: boolean
    stored: boolean
    keptMs: number
  } | null
  ghost: {
    source: 'best' | 'this-lap'
    seconds: number | null
    gates: number
    keys: number
    tainted: boolean
    visible: boolean
    at: [number, number, number]
  } | null
  stored: { seconds: number; gates: number; keys: number; tainted: boolean } | null
}

const laps = async (page: Page): Promise<LapsReport | null> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __ff2: { laps: () => LapsReport | null } }).__ff2.laps() ?? null,
  )

const finishAt = async (page: Page): Promise<number | null> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __ff2: { mission: { finishAt: number | null } } }).__ff2.mission
        .finishAt,
  )

/** The field, and which group the player's ghost hangs under. */
const field = async (page: Page): Promise<{ racers: number; ghostRoot: string | null }> =>
  page.evaluate(() => {
    type O = { name: string; parent: O | null; traverse: (f: (o: O) => void) => void }
    const app = (
      globalThis as unknown as {
        __ff2: { racers: () => { count: number } | null; stage: () => O }
      }
    ).__ff2
    const scene = app.stage()
    let ghostRoot: string | null = null
    scene.traverse((o) => {
      if (o.name !== 'ghost:player') return
      let p: O = o
      while (p.parent && p.parent !== scene) p = p.parent
      ghostRoot = p.name
    })
    return { racers: app.racers()?.count ?? 0, ghostRoot }
  })

/**
 * The rules string DEV-372 boards this course under, out of the GENERATED
 * artefact on disk — not out of the game, which is what is under test.
 */
const boardRules = (mission: string, edition: string, variant = 'standard'): string => {
  const file = path.join(process.cwd(), 'content', 'lap-courses.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    courses: Record<
      string,
      { editions: Record<string, { variants: Record<string, { rules: string }> }> }
    >
  }
  const rules = data.courses[mission]?.editions[edition]?.variants[variant]?.rules
  if (!rules) throw new Error(`no board for ${mission} on ${edition} in the ${variant}`)
  return rules
}

/** The title is up, its valley is in, and the card is gone. */
const toTheTitle = async (page: Page, query: string): Promise<void> => {
  await page.goto(`/?xr=off&${PINNED}${query}`)
  await firstPress(page)
  await bootReady(page, 240_000)
  await dropFocus(page)
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            (
              globalThis as unknown as {
                __ff2?: { titleMenu?: () => { up: boolean } | null }
              }
            ).__ff2?.titleMenu?.()?.up ?? false,
        ),
      { message: 'the title offers its rows', timeout: 60_000 },
    )
    .toBe(true)
}

/** The menu under the panel (DEV-571), as `__ff2.share()` reports it: what DEV-601 needs of it. */
interface AskReport {
  readonly ask: {
    readonly up: boolean
    readonly aim: string | null
    readonly rows: readonly { readonly id: string; readonly value?: string }[]
  } | null
}
const ask = async (page: Page): Promise<AskReport['ask']> =>
  (
    await page.evaluate(() =>
      (globalThis as unknown as { __ff2: { share: () => AskReport } }).__ff2.share(),
    )
  ).ask

/**
 * DEV-601: SAVE AS YOUR GHOST?, answered YES, the way a player answers it:
 * the arrow keys to the row, Enter to press it. An autopilot lap starts at NO.
 */
const keepThisLap = async (page: Page): Promise<void> => {
  await expect.poll(async () => (await ask(page))?.up ?? false, { timeout: 10_000 }).toBe(true)
  const keep = 'lap-keep'
  expect(
    (await ask(page))?.rows.find((r) => r.id === keep)?.value,
    'an autopilot lap starts unsaved',
  ).toBe('No')
  for (let i = 0; i < 8; i++) {
    const a = await ask(page)
    if (!a || a.aim === keep) break
    const want = a.rows.findIndex((r) => r.id === keep)
    const now = a.rows.findIndex((r) => r.id === a.aim)
    await hold(page, want < now ? 'ArrowUp' : 'ArrowDown', 250)
  }
  expect((await ask(page))?.aim, 'aimed at SAVE AS YOUR GHOST').toBe(keep)
  await hold(page, 'Enter')
  await expect
    .poll(async () => (await ask(page))?.rows.find((r) => r.id === keep)?.value)
    .toBe('Yes')
}

const finished = async (page: Page, label: string): Promise<void> => {
  await page.waitForSelector('body[data-finished="true"]', { timeout: 240_000 })
  // The panel is drawn on the frame after; nothing below reads it sooner.
  await page.waitForTimeout(500)
  console.info(`ghost-local ${label}: finished at ${(await finishAt(page))?.toFixed(4)} s`)
}

/** The results panel, from its own texture: full resolution, no framing. */
const photographPanel = async (page: Page, name: string): Promise<void> => {
  // DEV-650: the panel animates in (3.15 s at the longest, `render/results-anim.ts`),
  // so a photograph of its texture waits for the end state or it shows a headline
  // that has not stamped yet and numbers that are still counting.
  await page.waitForTimeout(3_400)
  const url = await page.evaluate(() => {
    type O = {
      name: string
      material?: { map?: { image?: { toDataURL?: () => string } } }
      traverse: (f: (o: O) => void) => void
    }
    const scene = (globalThis as unknown as { __ff2: { stage: () => O } }).__ff2.stage()
    let data: string | null = null
    scene.traverse((o) => {
      if (o.name === 'results' && !data) data = o.material?.map?.image?.toDataURL?.() ?? null
    })
    return data as string | null
  })
  expect(url, 'the results panel has a canvas').not.toBeNull()
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${name}-${PIN_TAG}.png`)
  fs.writeFileSync(file, Buffer.from((url as string).split(',')[1] as string, 'base64'))
  console.info(`ghost-local: ${file}`)
}

/**
 * The burst: the ghost beside the racers, close enough to see.
 *
 * From the pit, the pack is ~20 px across a second after GO, which is a frame
 * nobody can review. So the page is RELOADED behind `fast` (`?view=chase`, a
 * presentation switch, so it taints nothing) and the kept lap comes back out of
 * the store at world build — the "your best is on by default" half, across a
 * page load. The player is launched with ENTER and left idle on the line, so
 * the ghost is never inside the near-hide radius of a ship flying its own lap.
 * Frames back to back from GO, then every 0.4 s, each named by the lap clock.
 */
const burst = async (
  page: Page,
  edition: string,
  keptSeconds: number | null,
  /** DEV-452: `&rules=classic` for a lap kept under 2016's rules, or its board is another. */
  rules = '',
): Promise<void> => {
  await page.goto(
    `/?mission=int_01_hoverJet&menu=0&ride=0&xr=off&edition=${edition}${rules}` +
      `&view=chase&chase=fast&chaseOffset=4,5,26&${PINNED}`,
  )
  await firstPress(page)
  await bootReady(page, 240_000)
  await dropFocus(page)
  await missionReady(page, 240_000)
  const aboard = await laps(page)
  console.info(`ghost-local ${edition} after a reload: ${JSON.stringify(aboard?.ghost)}`)
  expect(aboard?.ghost?.source, `${edition}: the kept lap is the ghost after a reload`).toBe('best')
  expect(aboard?.ghost?.seconds).toBe(keptSeconds)
  expect(aboard?.run.taint, `${edition}: a chase view taints nothing`).toEqual([])
  await hold(page, 'Enter', 0)
  await expect
    .poll(async () => (await laps(page))?.run.tick ?? -1, {
      message: `${edition}: released`,
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(0)
  fs.mkdirSync(OUT, { recursive: true })
  let seen = false
  for (let i = 0; i < 10; i++) {
    const r = await laps(page)
    seen ||= r?.ghost?.visible === true
    const clock = r?.run.clock ?? 0
    const file = path.join(OUT, `${edition}-burst-${i}-t${clock.toFixed(1)}-${PIN_TAG}.png`)
    fs.writeFileSync(file, await page.locator('#viewport').screenshot())
    console.info(
      `ghost-local burst ${edition} ${i}: clock ${clock.toFixed(2)} s, ghost ` +
        `${r?.ghost?.visible ? 'drawn' : 'hidden'} at ${r?.ghost?.at.map((v) => v.toFixed(0)).join(',')}`,
    )
    if (i >= 4) await page.waitForTimeout(400)
  }
  expect(seen, `${edition}: the ghost is drawn beside the racers`).toBe(true)
}

test.describe('@gpu your lap, kept and raced (DEV-371)', () => {
  test.setTimeout(900_000)

  test('Anniversary: lap two races lap one; "race this lap" races lap two', async ({ page }) => {
    const problems = watchPageErrors(page)
    // The autopilot's state, off its own console line (`learn-to-fly` reads it
    // the same way): walking the menu under the panel with the arrow keys is a
    // hand on the flight keys, which takes the stick back (DEV-601's keep).
    const pilot = { on: false }
    page.on('console', (m) => {
      const t = m.text()
      if (t.startsWith('autopilot ON')) pilot.on = true
      else if (t.startsWith('autopilot off')) pilot.on = false
    })
    await toTheTitle(page, '&edition=anniversary')
    await pressTitleRow(page, TITLE_ROW.hangar) // DEV-441: Single Player, then Hangar
    await board(page, INT_01_HOVERJET, 1_000)

    const aboard = await laps(page)
    expect(aboard, 'Ring Attack keeps laps').not.toBeNull()
    expect(aboard?.ghost, 'a fresh browser has nothing to race').toBeNull()
    expect(aboard?.stored).toBeNull()
    // The harness's own pins are presentation: nothing in the URL taints.
    expect(aboard?.run.taint).toEqual([])

    // ── lap one ─────────────────────────────────────────────────────────
    await hold(page, 'KeyP', 300)
    await finished(page, 'lap one')
    const one = await laps(page)
    const oneAt = await finishAt(page)
    console.info(`ghost-local lap one: ${JSON.stringify(one?.last)}`)
    expect(one?.last?.seconds, 'the kept lap is the live finish, to the bit').toBe(oneAt)
    expect(one?.last?.gates).toBe(21)
    expect(one?.last?.keys).toBeLessThan((one?.last?.finishTick ?? 0) + 1)
    expect(one?.last?.tainted).toBe(true)
    expect(one?.last?.reasons).toEqual(['autopilot'])
    // DEV-372's fields: the board's rules for this course, preset and variant,
    // and the standard HoverJet (a fresh browser has chosen no other), so a
    // clean lap like it would be accepted at both.
    expect(one?.last?.rules).toBe(boardRules('int_01_hoverJet', 'anniversary'))
    expect(one?.last?.vehicle).toBe('hoverjet:standard')
    // DEV-601: not kept of its own accord; kept when asked, tainted as it is,
    // because racing it locally is allowed.
    expect(one?.last?.stored, 'an autopilot lap is not saved unasked').toBe(false)
    expect(one?.stored, 'nothing in the store yet').toBeNull()
    await keepThisLap(page)
    expect((await laps(page))?.stored?.seconds, 'kept when asked').toBe(oneAt)

    // ── lap two: BACKSPACE (DEV-406), and your best is the ghost ────────
    await hold(page, 'Backspace', 600)
    // P again if the keep's arrow keys took the stick (see `pilot` above).
    if (!pilot.on) await hold(page, 'KeyP', 300)
    const two = await laps(page)
    console.info(`ghost-local lap two races: ${JSON.stringify(two?.ghost)}`)
    expect(two?.ghost?.source).toBe('best')
    expect(two?.ghost?.seconds, "lap two's ghost stands at lap one's time").toBe(oneAt)
    expect(two?.ghost?.keys).toBe(one?.last?.keys)
    expect(two?.last, 'a new run has no lap yet').toBeNull()
    // Not a racer (DEV-364): the grid is the preset's five, and the ghost hangs
    // under its own group, never under `racers`, whose step is the only thing
    // that pushes anybody.
    const grid = await field(page)
    expect(grid.racers).toBe(5)
    expect(grid.ghostRoot).toBe('player-ghost')
    await finished(page, 'lap two')
    const twoDone = await laps(page)
    console.info(`ghost-local lap two: ${JSON.stringify(twoDone?.last)}`)
    expect(twoDone?.last?.seconds).toBe(await finishAt(page))
    await photographPanel(page, 'anniversary-panel-lap-two')

    // ── "race this lap": R, and lap TWO is the ghost ────────────────────
    await hold(page, 'KeyR', 600)
    const three = await laps(page)
    console.info(`ghost-local race this lap: ${JSON.stringify(three?.ghost)}`)
    expect(three?.ghost?.source).toBe('this-lap')
    expect(three?.ghost?.seconds).toBe(twoDone?.last?.seconds)
    expect(three?.ghost?.keys).toBe(twoDone?.last?.keys)

    // The store kept lap one (lap two was slower), so lap one comes back.
    await burst(page, 'anniversary', oneAt)
    expect(problems.list(), 'page errors').toEqual([])
  })

  test('Classic: the ghost flies with 2016’s two racers', async ({ page }) => {
    const problems = watchPageErrors(page)
    // DEV-452 (D35): 2016's rules — two racers, Classic's board rules — are
    // the development switch's now; a player's Classic is a look over
    // Anniversary's, which `results-board.spec.ts` flies.
    await toTheTitle(page, '&edition=classic&rules=classic')
    await pressTitleRow(page, TITLE_ROW.hangar) // DEV-441: Single Player, then Hangar
    await board(page, INT_01_HOVERJET, 1_000)
    // `?rules=` is on the taint allowlist as `edition` was before D35: the lap
    // records its rules and is kept and raced by them; it is never shared.
    expect((await laps(page))?.run.taint).toEqual([])

    await hold(page, 'KeyP', 300)
    await finished(page, 'classic lap')
    const one = await laps(page)
    console.info(`ghost-local classic lap: ${JSON.stringify(one?.last)}`)
    expect(one?.last?.seconds).toBe(await finishAt(page))
    // DEV-601: kept when asked, as in the first test.
    expect(one?.last?.stored).toBe(false)
    await keepThisLap(page)
    expect((await laps(page))?.stored?.seconds).toBe(one?.last?.seconds)
    expect(one?.last?.rules).toBe(boardRules('int_01_hoverJet', 'classic'))
    await photographPanel(page, 'classic-panel-lap-one')

    await hold(page, 'KeyR', 600)
    const raced = await laps(page)
    expect(raced?.ghost?.source).toBe('this-lap')
    expect(raced?.ghost?.seconds).toBe(one?.last?.seconds)
    const grid = await field(page)
    expect(grid.racers).toBe(2)
    expect(grid.ghostRoot).toBe('player-ghost')

    await burst(page, 'classic', one?.last?.seconds ?? null, '&rules=classic')
    expect(problems.list(), 'page errors').toEqual([])
  })
})
