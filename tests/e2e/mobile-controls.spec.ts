/**
 * tests/e2e/mobile-controls.spec.ts — the thumbsticks, in a real browser
 * pretending to be a real phone.
 *
 * ── Why this cannot be a unit test ───────────────────────────────────────
 *
 * `tests/unit/touch-input.test.ts` owns the mapping and proves it agrees with
 * the pad. What it cannot prove is the thing the whole feature hangs off:
 * **does `(pointer: coarse)` actually match on a phone, and not on a desktop?**
 * That is a question about a browser, and a fake `matchMedia` answering it
 * would be the test asserting its own premise. So the detection runs here,
 * under Chromium's own mobile emulation — `isMobile`, `hasTouch`, a coarse
 * pointer and a real `maxTouchPoints` — which is the same machinery that makes
 * a page think it is on a Pixel.
 *
 * `capability-gate.ts` has a `?touch=1` switch and this spec deliberately does
 * NOT use it for the phone case. A switch that forced the controls on would
 * make the tested path and the played path different code, which is the one
 * thing CLAUDE.md says never to do — and it is the exact bill this project has
 * already paid: the first build anyone wore reached a pink sky because
 * `VITE_ASSET_BASE_URL` was set by Playwright's config and by no human being.
 * The override gets one test of its own, as a feature, at the bottom.
 *
 * ── What is tagged @gpu, and what has actually been run ──────────────────
 *
 * The first block needs nothing but a boot: no terrain, no GLBs, no GPU. It was
 * executed while this file was written, and it is deliberately the only spec
 * here that does NOT call `watchPageErrors` — every other one does, and that is
 * right, but on an un-hydrated tree the page's one console error is *"world
 * failed to load"*, which would couple an asset-INDEPENDENT test to the assets
 * for nothing. `boot.spec.ts` owns "the page boots clean"; this owns "the
 * overlay is there", and an overlay that threw on the way up would fail the
 * assertions below on its own.
 *
 * The second block flies, so it needs a hydrated `public/assets/` (`pnpm
 * assets:pull`) and is tagged `@gpu` with the rest of the suite's world-loading
 * specs. **It had not been run when it was written** — the session that added
 * the touch controls had no R2 credentials and no `public/` tree at all — so
 * treat a first red run here as a premise to check before believing it found a
 * regression. `docs/testing/mobile-checklist.md` is the by-hand version, and it
 * is the one that settles whether any of this is playable with real thumbs.
 */

// The words the game actually draws, rather than this file's memory of them.
// `touchConfirmLabel`'s comment calls this spec "the only check that can see
// these two lists disagreeing" — which was true while the spec held a THIRD
// copy of the words. It reads them from the source of them now, so the check is
// about the branch that fires and not about four string literals (DEV-205).
// `@/input/confirm` is a leaf: one type-only import and no Vite globals, which
// is the property `tests/unit/e2e-import-graph.test.ts` enforces.
import { CONFIRM_LABEL } from '@/input/confirm'
// Same rule, one module along: the two faces of the hamburger come from the
// file that draws them, so this spec cannot drift from the word on the button.
// `@/input/touch-overlay` is a leaf in the same sense `@/input/confirm` is —
// two type-only imports and no Vite globals, which is the property
// `tests/unit/e2e-import-graph.test.ts` enforces.
import { AGAIN_LABEL, MENU_CLOSE_LABEL, MENU_LABEL, RACE_LAP_LABEL } from '@/input/touch-overlay'
// DEV-566's words and element, from the file that draws them. A leaf: no
// imports at all, which is what `tests/unit/e2e-import-graph.test.ts` asks.
import { TURN_PAUSED_NOTE, TURN_ROOT_ID, TURN_TITLE } from '@/input/turn-phone'
import { bootReady, switchSettled } from './fixtures/boot'
import type { Ff2Global, Ff2GlobalMaybe } from './fixtures/ff2'
import { firstPress, loadSettled } from './fixtures/landing'
import { pausePlateState } from './fixtures/pause-menu'
import { PINNED } from './fixtures/quality-pin'
import { devices, expect, test } from './fixtures/test'
import { TITLE_ROW, tapTitleRow, titleMenu, titleRowsUp } from './fixtures/title'

/**
 * The page is not ready when `bootApp()` resolves: it waits for the first WORLD
 * (DEV-107; `data-load`, since DEV-557 took the landing card's Start away). That is 4.5 s on a warm local server
 * and longer on anything else, so a five-second default is a spec asserting a
 * contract the game no longer has. The number is the terrain generator's, the
 * same one every spec here gives `data-terrain-ready`.
 */
const READY = { timeout: 180_000 }

/** The overlay, and the five buttons on it. One selector each, so a rename is one edit. */
const ROOT = '#touch-controls'
const chip = (act: string) => `${ROOT} [data-act="${act}"]`

/**
 * `?xr=off` on every navigation here.
 *
 * `isSessionSupported('immersive-vr')` is not a passive query — it starts the
 * machine's OpenXR runtime, which on a Windows box means launching SteamVR on
 * every page load. The specs that exist to test the probe still make it.
 */
const FLAT = '/?xr=off'

/**
 * A phone, in landscape, which is how the controls are laid out to be held.
 *
 * Spelled out field by field rather than spread from `devices['Pixel 7']`,
 * because a device descriptor also carries `defaultBrowserType` and Playwright
 * refuses that inside a `describe` ("it forces a new worker"). Writing the four
 * that matter is not a workaround either — they ARE the premise of this file,
 * and `isMobile` is the one that makes Chromium report `(pointer: coarse)` and
 * a non-zero `maxTouchPoints`, which is exactly what `hasTouchscreen()` asks.
 */
const PHONE = {
  viewport: { width: 915, height: 412 },
  deviceScaleFactor: devices['Pixel 7'].deviceScaleFactor,
  userAgent: devices['Pixel 7'].userAgent,
  isMobile: true,
  hasTouch: true,
}

test.describe('a phone is offered the game, not the flyby', () => {
  test.use(PHONE)

  test('mounts the thumbsticks with the title, with no card to wait behind', async ({ page }) => {
    await page.goto(FLAT)
    await loadSettled(page, READY.timeout)

    // DEV-557. They used to wait behind the landing card, because controls
    // drawn over its Start button were controls for a game the visitor had
    // not started. The card is gone and the title IS the game (Matt,
    // 2026-10-01: "let's get rid of the html curtain"), so they are up with it,
    // before any touch: on the title the glass is taps for its rows.
    await expect(page.locator(ROOT)).toBeVisible()
    await titleRowsUp(page)

    // Every control the player is ever offered, present in the document. Their
    // VISIBILITY is per-screen and belongs to the block below; existence is
    // what says the touchscreen was detected at all.
    for (const act of ['brake', 'boost', 'auto', 'pause', 'confirm']) {
      await expect(page.locator(chip(act))).toHaveCount(1)
    }
  })

  test("the title's version line is centred at the bottom, clear of the plate (DEV-614 follow-up)", async ({
    page,
  }) => {
    // Matt, 2026-10-03: "show version number on the title screen, same line as
    // copyright". On a phone the foot of the title is free since DEV-619 took
    // the START chip off it; the line must stay clear of the plate above it
    // and inside the glass. A Pixel 7's landscape size, then an iPhone 13
    // Pro's (Matt's). Emulation reports no safe-area insets: those are the
    // CSS's `env()` terms.
    await page.goto(FLAT)
    await loadSettled(page, READY.timeout)
    await titleRowsUp(page)
    await expect(page.locator('#title-line')).toBeVisible()
    for (const size of [PHONE.viewport, { width: 844, height: 390 }, { width: 780, height: 360 }]) {
      await page.setViewportSize(size)
      await page.waitForTimeout(500)
      const m = await page.evaluate(() => {
        const range = document.createRange()
        range.selectNodeContents(document.getElementById('title-line') as HTMLElement)
        const t = range.getBoundingClientRect()
        return {
          left: t.left,
          right: t.right,
          top: t.top,
          bottom: t.bottom,
          w: innerWidth,
          h: innerHeight,
        }
      })
      const menu = await titleMenu(page)
      // The plate's rows and its bottom edge are read off the plate itself
      // (`titleMenu()`), so a taller plate (DEV-802's rows, DEV-859's OPTIONS)
      // moves the rule with it. A flat 10 % of the height, and then "a pitch
      // under the lowest row", both held only while the plate was short.
      const rowYs = (menu?.rowsAt ?? []).map((p) => p.y)
      const at = `${size.width} x ${size.height}: ${JSON.stringify({ m, rowYs })}`
      expect(rowYs.length, `the plate says where its rows are, ${at}`).toBeGreaterThan(0)
      expect(Math.abs((m.left + m.right) / 2 - m.w / 2), `centred, ${at}`).toBeLessThan(3)
      expect(m.left, `inside the glass, ${at}`).toBeGreaterThanOrEqual(0)
      expect(m.right, `inside the glass, ${at}`).toBeLessThanOrEqual(m.w)
      expect(m.bottom, `on the glass, ${at}`).toBeLessThanOrEqual(m.h)
      // DEV-895: read off the plate, not guessed from its rows: the plate has a footer margin under
      // the last row, so "a pitch under the lowest row" was a stand-in for its bottom edge.
      expect(menu?.plateBottom, `the plate says where its bottom edge is, ${at}`).not.toBeNull()
      expect(m.top, `under the plate's bottom edge, ${at}`).toBeGreaterThan(
        (menu?.plateBottom ?? Number.POSITIVE_INFINITY) + 4,
      )
    }
  })

  test('routes to flat rather than attract, which is the whole point', async ({ page }) => {
    await page.goto(FLAT)
    await loadSettled(page, READY.timeout)
    const caps = await page.evaluate(
      () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.capabilities ?? null,
    )
    expect(caps).not.toBeNull()
    // `hasKeyboard()` is false here — no hover, and touch points — so before
    // the touch reader existed this device had nothing and got the attract
    // route. That is the regression this line guards.
    expect(caps?.keyboard).toBe(false)
    expect(caps?.touch).toBe(true)
    expect(caps?.route).toBe('flat')
  })

  test('says so on the landing page instead of turning the visitor away', async ({ page }) => {
    await page.goto(FLAT)
    await loadSettled(page, READY.timeout)
    // There is no landing page any more (DEV-557): what a phone is offered is
    // the title, its rows up and tappable with no press first.
    await titleRowsUp(page)
    // The list used to read "Not supported: phones and tablets". It is not a
    // detail: it is the sentence that told a phone visitor to go away, and no
    // DOM on the page may say it.
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(
      'Not supported: phones and tablets',
    )
    // Nor is the page's one failure message up.
    await expect(page.locator('#boot-failure')).toBeHidden()
  })
})

test.describe('a desktop is left exactly as it was', () => {
  test('puts nothing over the canvas at all', async ({ page }) => {
    await page.goto(FLAT)
    await firstPress(page)
    // COUNT zero, not "hidden". `noTouchControls()` returns a stand-in that
    // builds no elements, so a desktop's DOM is unchanged — which matters
    // because a full-screen `pointer-events: auto` surface over the canvas
    // would eat the pointer-lock click that IS the desktop look control.
    await expect(page.locator(ROOT)).toHaveCount(0)
    // Nor TURN YOUR PHONE (DEV-566): a desktop is never asked to turn anything.
    await expect(page.locator(`#${TURN_ROOT_ID}`)).toHaveCount(0)
  })

  test('still reports the flat route by keyboard, not by touch', async ({ page }) => {
    await page.goto(FLAT)
    await loadSettled(page, READY.timeout)
    const caps = await page.evaluate(
      () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.capabilities ?? null,
    )
    expect(caps?.touch).toBe(false)
    expect(caps?.route).toBe('flat')
  })

  test('`?touch=1` mounts the same controls a phone gets', async ({ page }) => {
    // The documented escape hatch, tested as the feature it is: a touchscreen
    // laptop, an iPad with a trackpad (which reports a FINE pointer and still
    // has glass in front of it), and anyone who wants to look at the controls
    // on a monitor. Same elements, same code — that is the point of it.
    await page.goto('/?xr=off&touch=1')
    await firstPress(page)
    await expect(page.locator(ROOT)).toBeVisible()
    await expect(page.locator(chip('auto'))).toHaveCount(1)
  })
})

test.describe('the chip and the game cannot disagree about the word', () => {
  test('walks three labels that are three different words', async () => {
    // No page, no GPU: a property of the labels the block below WALKS.
    //
    // Reading the chip is only evidence while the word changes. This spec's
    // route is title -> hangar -> pad, and it asserts START, then SELECT, then
    // LAUNCH; if any two of those were the same string every assertion between
    // them would pass whether or not the tap did anything — the vacuous-pass
    // failure `menuView` already exists to avoid WITHIN the three SELECT steps.
    // Now that the words come from `CONFIRM_LABEL` rather than from this file,
    // a rename cannot break the spec, so this is the assertion that remains
    // worth making. DEV-205.
    const walked = [CONFIRM_LABEL.start, CONFIRM_LABEL.select, CONFIRM_LABEL.launch]
    expect(new Set(walked).size, walked.join(' -> ')).toBe(3)
    // And every branch has a word at all — a missing entry renders `undefined`
    // on the chip and fails nowhere else.
    for (const word of Object.values(CONFIRM_LABEL)) expect(word).toMatch(/^[A-Z]+$/)
  })
})

/**
 * Which step of the level select is up, or null once you are aboard.
 *
 * The level select is three steps and the confirm chip says **SELECT** on all
 * three, because they are one branch of `touchConfirmLabel`. So the chip's own
 * word cannot separate "the tap landed" from "the tap did nothing" between them
 * — and a spec that taps three times with only `toHaveText(CONFIRM_LABEL.select)` in
 * between passes its assertions instantly, taps again inside the same frame,
 * and loses a press to the latch `touch.confirm` is edge-detected through.
 * Measured: it lost exactly one, and boarded the ship never.
 *
 * So the wait is on the thing that DOES change. Same rule as everywhere else in
 * this suite: a confirm is a level read once a frame, so wait for the frame to
 * have read it.
 */
/**
 * Off the title with the chip, as a thumb does it, and through the hangar's
 * first step (DEV-558): a phone's title is START alone (no headset to connect,
 * DEV-557's call 2), so the chip takes it; the room opens on its doors, and a
 * drag and a tap take SINGLE PLAYER. Each tap is checked for what it did, so a
 * tap the title or the room dropped names itself.
 */
/**
 * DEV-607: a finger on the glass at the centre, on whatever the aim is on. The
 * gaze and the centre of the screen are one ray, so after `lookForTable` has
 * put a table under the aim this taps that table (DEV-604's tap-to-choose).
 * On the pad and on a results panel with no menu under it, a tap on the glass
 * is the press itself.
 */
const tapTheGlass = async (page: import('@playwright/test').Page): Promise<void> => {
  const size = page.viewportSize()
  expect(size, 'a viewport to tap').not.toBeNull()
  if (!size) return
  await page.touchscreen.tap(size.width / 2, size.height / 2)
}

/** The launch's phase, `__ff2.launch()`: `waiting` on the pad until the press. */
const launchPhase = (page: import('@playwright/test').Page): Promise<string | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.launch().phase ?? null)

const chipIntoTheHangar = async (
  page: import('@playwright/test').Page,
  confirm: import('@playwright/test').Locator,
): Promise<void> => {
  const menu = await titleRowsUp(page)
  // DEV-658: and the newsletter under it.
  expect(menu.rows, 'a phone’s title is START, OPTIONS, the making-of and the newsletter').toEqual([
    TITLE_ROW.hangar,
    TITLE_ROW.options,
    TITLE_ROW.makingOf,
    TITLE_ROW.newsletter,
  ])
  expect(menu.rows[menu.selected], 'the title opens on START').toBe(TITLE_ROW.hangar)
  // DEV-619: no chip on the title; the plate's START row is the button, and a
  // finger on it is the press (Matt: "just tap the panel start").
  await expect(confirm, 'no START chip on the title').toBeHidden()
  await tapTitleRow(page, TITLE_ROW.hangar)
  await expect.poll(() => menuView(page), { timeout: 10_000 }).toBe('doors')
  // DEV-607: no big button in the hangar; the table itself is tapped.
  await expect(confirm).toBeHidden()
  expect(await lookForTable(page, 'single-player'), 'found Single Player').toBe(true)
  await tapTheGlass(page)
}

const menuView = (page: import('@playwright/test').Page): Promise<string | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()?.view ?? null)

/**
 * The level select's walk below the aircraft, as [the step a tap opens, the
 * table tapped to open it], off the room's own step list (DEV-382). On
 * Anniversary a tap on the HoverJet opens its VARIANTS and a tap on the
 * standard one opens its plans; Classic's room walks 2016's four. The
 * standard table is named by its NAME, because a variant's JSON carries every
 * bar's `standard` value as a key and a match on the id would take any table.
 */
const menuWalk = async (
  page: import('@playwright/test').Page,
): Promise<readonly (readonly [string, string])[]> => {
  const views = await page.evaluate(
    () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()?.views ?? [],
  )
  // DEV-420: a tap on Ring Attack opens its PLACES — the rank is a mark on
  // each place's table, so there is no rank page between. The board tap below
  // then takes the Simonet table, whose pick is int_01 (the easiest there).
  const below: readonly (readonly [string, string])[] = [['courses', 'ringAttack']]
  return views.includes('variants')
    ? [['variants', 'hoverjet'], ['modes', 'Standard'], ...below]
    : [['modes', 'hoverjet'], ...below]
}

/**
 * The WHOLE aim, so a walk can be aimed at a NAMED option and not merely at a
 * kind. Matched as a substring of its own JSON: the ids, modes and difficulties
 * are distinct quoted strings and a quoted match cannot collide them.
 */
const menuAimFull = (page: import('@playwright/test').Page): Promise<{ kind: string } | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()?.aim ?? null)

/**
 * Drag the canvas until a TABLE is under the pointer, then say so.
 *
 * ── Why a phone now has to aim, and did not before (DEV-203) ────────────
 *
 * Matt: *"these should be fixed, not randomly placed as they are now."* The arc
 * used to rotate itself so something was always under the resting pointer, so
 * three blind taps walked the whole menu. Nothing rotates now, and a step's
 * resting position can be legitimately EMPTY — the flight-plan arc has one per
 * mode the game has and the HoverJet flies two of three.
 *
 * So this drags to look, which is the touch control this file is about anyway
 * (`chip('confirm')`'s own note: *"no ship — a drag looks around instead"*), and
 * it is exactly what a player with a phone does.
 */
const lookForTable = async (
  page: import('@playwright/test').Page,
  want?: string,
  steps = 16,
): Promise<boolean> => {
  // ── A TABLE, not merely something (DEV-203 follow-up) ─────────────────
  //
  // This used to accept any non-null aim, and the lap plates are aimable too.
  // A tap on one turns a page or steps BACK, so a walk that acquired a `back`
  // plate on the courses step pressed it, went up a level, and then reported
  // the confirm chip saying `SELECT` where the test expected `LAUNCH` — a
  // failure three assertions downstream of its cause, and one that reads as a
  // label bug rather than as an aiming one.
  //
  // It cannot have bitten before DEV-203: the arc rotated a table under the
  // resting pointer, so the very first check passed and the drag never ran.
  // Now the resting position can be empty, the search does run, and the lap
  // plates sit at bearing ∓20° with an 8.11° window — squarely inside a sweep
  // that steps 8.6° at a time.
  //
  // The four kinds here are exactly the ones `choose()` acts on to move
  // FORWARD; `back` and `page` are the two it uses to move sideways or out.
  //
  // And `want` names WHICH one, for the same reason `walkthrough.spec.ts` needed
  // it on the same day: a sweep with no target takes whatever it reaches first,
  // and the first advancing flight plan to the right of the HoverJet's resting
  // position is Free Flight. That boards Kauai — a DIFFERENT ENVIRONMENT, so a
  // full world swap — and the assertions after it then race a terrain build.
  // This file is about the chip's WORDS, so it does not care which course it
  // flies, but it does care that the walk is the same one every time.
  // DEV-558: and a door, the hangar's first step's own (Single Player).
  const ADVANCES = ['door', 'vehicle', 'variant', 'mode', 'rank', 'mission']
  const on = async () => {
    const aim = await menuAimFull(page)
    if (!ADVANCES.includes(aim?.kind ?? '')) return false
    return want === undefined || JSON.stringify(aim).includes(`"${want}"`)
  }
  const box = await page.locator('#viewport').boundingBox()
  if (!box) return on()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  // ── The budget, derived rather than picked ────────────────────────────
  //
  // `steps` right then `steps * 2` left, which is `turnUntil`'s 32/64 shape in
  // the drag axis and for the same reason. The old form was `i < steps / 2 ?
  // 60 : -60` — eight drags right and eight back — which is a window CENTRED ON
  // THE START: it returns to where it began and never travels left of it. That
  // is the third instance of this exact bug found tonight (the yaw search in
  // `menu-screen`, the pitch search in `menu-light-compile`, and here), and all
  // three were invisible until DEV-203 stopped rotating the wanted table under
  // the pointer.
  //
  // The numbers: a 60 px drag is `60 * MOUSE_SENSITIVITY` = 0.15 rad = **8.6
  // degrees**, so crossing the 90-degree arc end to end takes **11** drags. 16
  // right covers it with margin from any starting point inside the arc, and 32
  // left covers the far end after a full right-hand sweep has overshot.
  for (const dx of [60, -60] as const) {
    const legSteps = dx < 0 ? steps * 2 : steps
    for (let i = 0; i < legSteps; i++) {
      if (await on()) return true
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + dx, y, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(120)
    }
    if (await on()) return true
  }
  return on()
}

/**
 * Everything below needs the world: a hydrated `public/assets/`, and a GPU to
 * draw it with. See the file header — this block was written unrun.
 */
test.describe('the controls follow the screen you are on @gpu', () => {
  test.use(PHONE)
  // Each of these boots the app, builds an island, walks FOUR menu steps with a
  // look-drag at each one and — for the autopilot one — rides the 106 m lift
  // and flies. The default 30 s was already most of the way spent at two menu
  // steps; DEV-105's third tipped it over, and the symptom was a
  // `waitForFunction` reporting the TEST's timeout rather than its own 60 s
  // one. DEV-203 adds a fourth step and the drags, so the budget goes up again.
  test.setTimeout(240_000)

  test('names the branch that will actually fire, at every screen', async ({ page }) => {
    // The claim `boot/app.ts`'s `touchConfirmLabel` makes about itself: its
    // branches are the confirm handler's branches, in its order. A label that
    // names a different branch from the one that fires is a button you press,
    // disbelieve, and stop trusting — and nothing but pressing it can tell.
    await page.goto(FLAT)
    await firstPress(page, { tap: true })
    // `bootReady`, not `data-terrain-ready`: this URL boots the TITLE screen,
    // and since DEV-281 that builds no mission world. See `fixtures/boot.ts`.
    await bootReady(page, 120_000)

    const confirm = page.locator(chip('confirm'))
    // The title screen: a flypast, and one thing to do, which is its own
    // plate's START row since DEV-619: no chip over it.
    await expect(confirm).toBeHidden()
    // No ship, so no sticks and no shoulders.
    await expect(page.locator(chip('boost'))).toBeHidden()

    // Off the title and into the room, which opens on the AIRCRAFT.
    await chipIntoTheHangar(page, confirm)
    await expect.poll(() => menuView(page), { timeout: 10_000 }).toBe('vehicles')
    // Still no ship — a drag looks around instead.
    await expect(confirm, 'no big button in the hangar (DEV-607)').toBeHidden()
    await expect(page.locator(chip('boost'))).toBeHidden()

    // The level select's other three steps — the flight plan, the rank, then
    // the place (DEV-105, DEV-203). The chip says SELECT on all four, because
    // all four are one branch of `touchConfirmLabel`, so each step is waited
    // for by `menuView` and the chip is checked at each one.
    //
    // A drag before each tap since DEV-203: nothing rotates, so a step's
    // resting position can be empty and a blind tap would do nothing.
    for (const [step, want] of await menuWalk(page)) {
      expect(await lookForTable(page, want), `found ${want} to open ${step} with`).toBe(true)
      await tapTheGlass(page)
      await expect.poll(() => menuView(page), { timeout: 10_000 }).toBe(step)
      await expect(confirm, 'no big button in the hangar (DEV-607)').toBeHidden()
      await expect(page.locator(chip('boost'))).toBeHidden()
    }

    expect(await lookForTable(page, 'int_01_hoverJet'), 'found int_01 to board').toBe(true)
    await tapTheGlass(page)
    // That tap IS the load, since DEV-281: boot built the title valley and the
    // island is generated when a course is chosen. The chip cannot say LAUNCH
    // until there is a ship to launch, and `confirmMeans` says so — its
    // `worldLoaded` gate is the mission screen's and only the mission screen's.
    await switchSettled(page, 240_000)
    // Boarded: on the pad at the bottom of the shaft, waiting on A. No LAUNCH
    // chip (DEV-607): the glass is the press.
    await expect(confirm).toBeHidden()
    await expect(page.locator(chip('boost'))).toBeVisible()
    await expect(page.locator(chip('brake'))).toBeVisible()
    expect(await launchPhase(page), 'waiting on the pad').toBe('waiting')
    await tapTheGlass(page)
    await expect
      .poll(() => launchPhase(page), { message: 'a tap on the glass launched', timeout: 10_000 })
      .not.toBe('waiting')
  })

  test('hands the course to the autopilot when AUTO is tapped', async ({ page }) => {
    // The ask this feature exists for, and the only route to the autopilot on a
    // touchscreen: `P` needs a keyboard and `?autopilot=1` is a development
    // switch that skips both menus.
    //
    // The chip's own `data-on` is the observable, and it is not decoration: it
    // is written from `app.ts`'s live `autopilot` flag through `setContext`, so
    // it lights only if the tap reached the frame loop and came back.
    await page.goto(FLAT)
    await firstPress(page, { tap: true })
    // `bootReady`, not `data-terrain-ready`: this URL boots the TITLE screen,
    // and since DEV-281 that builds no mission world. See `fixtures/boot.ts`.
    await bootReady(page, 120_000)

    const confirm = page.locator(chip('confirm'))
    // DEV-619: no chip on the title; `chipIntoTheHangar` taps the plate's START.
    await expect(confirm).toBeHidden()
    // Four taps through the level select: aircraft, flight plan, rank, place
    // (DEV-105, DEV-203), each one aimed with a drag first — see
    // `lookForTable`. Waited on `menuView`, not on the chip — see its note.
    //
    // The expected WORDS come from `CONFIRM_LABEL` and not from literals
    // (DEV-205): the spec's list and the game's were a fourth copy of one
    // branch chain, and a spec that hard-codes the word it expects cannot fail
    // when the word and the branch drift apart — which is the only failure that
    // matters here. Both halves of this line are deliberate and they came from
    // different branches: the derived label, and the four-step walk.
    await chipIntoTheHangar(page, confirm)
    await expect.poll(() => menuView(page), { timeout: 10_000 }).toBe('vehicles')
    await expect(confirm, 'no big button in the hangar (DEV-607)').toBeHidden()
    for (const [step, want] of await menuWalk(page)) {
      expect(await lookForTable(page, want), `found ${want} to open ${step} with`).toBe(true)
      await tapTheGlass(page)
      await expect.poll(() => menuView(page), { timeout: 10_000 }).toBe(step)
    }
    expect(await lookForTable(page, 'int_01_hoverJet'), 'found int_01 to board').toBe(true)
    await tapTheGlass(page)
    // ── wait for the WORLD the tap just asked for ───────────────────────
    //
    // Since DEV-281 this tap IS the load: boot builds the title valley and the
    // island is generated when a course is chosen. So the chip cannot say
    // LAUNCH until there is a ship to launch, and asserting it on the default
    // 5 s was asserting that an island builds in five seconds.
    //
    // The sibling test above has always had this wait and says so in as many
    // words; this one never got it, and passed anyway for as long as this file
    // had one world-building test in it. Three more landed with DEV-290/291/292
    // and it started failing — **on ordering, not on anything either test
    // does**. Attributed rather than assumed: it passes alone in this tree, it
    // passes alone on a detached worktree at `main`, and it fails only when the
    // file's @gpu tests queue up behind one another. The defect is the missing
    // wait, which was latent and is now paid for.
    await switchSettled(page, READY.timeout)
    await expect(confirm, 'no LAUNCH chip (DEV-607)').toBeHidden()

    const auto = page.locator(chip('auto'))
    await expect(auto).not.toHaveAttribute('data-on', '1')
    await auto.tap()
    await expect(auto).toHaveAttribute('data-on', '1')

    // It flies. `?autopilot=1` presses A for itself; the chip does not, so the
    // launch is the autopilot's own `startLaunch` on the next frame.
    await page.waitForFunction(
      () => ((globalThis as unknown as Ff2GlobalMaybe).__ff2?.mission.elapsed ?? 0) > 3,
      undefined,
      { timeout: 60_000 },
    )

    // And it stands down when a thumb takes the stick — the same guard the
    // keyboard has, reached through the merged actions rather than a second
    // rule for a fourth device.
    const box = await page.locator(`${ROOT} .surface`).boundingBox()
    expect(box).not.toBeNull()
    if (box) {
      const x = box.x + box.width * 0.25
      const y = box.y + box.height * 0.7
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x, y - 90, { steps: 8 })
      await page.mouse.up()
    }
    await expect(auto).not.toHaveAttribute('data-on', '1')
  })
})

/**
 * Which rows the plate is drawing, whether it is UP, and which one a press
 * would take — `__ff2.pausePlate()`.
 *
 * `open` and `selected` are DEV-291's additions and the block below could not
 * be written without them. The first probe of this feature read `page:
 * "pause"` five times in a row over a ship that had been flying since the very
 * first tap, because `pausePlate()` describes what the plate WOULD draw and is
 * answered identically by a plate nobody can see. That is a spec unable to
 * tell "the tap did nothing" from "the tap chose RESUME and closed the menu",
 * which is the whole distinction this block is about.
 *
 * Written out as a literal rather than imported from `@/boot/app`, exactly as
 * `controls-page.spec.ts` does it and for its reason: one import edge from a
 * Playwright file into the BOOT graph reaches `import.meta.glob` and takes the
 * e2e collection to zero, which exits looking like a clean run.
 */
const plate = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.pausePlate())

/**
 * The chips on the top row, as boxes — skipping any that is not drawn.
 *
 * `tilt` is in the list and may legitimately be absent: DEV-292's chip is only
 * built where the device reports orientation, so a browser without it draws
 * five and a phone draws six. Both have to be laid out, and the list is the
 * union rather than the five that are always there — a layout test that
 * measured five boxes while six competed for the line would be blind to
 * exactly the collision it exists for. (It was, on its first run.)
 */
const topRowBoxes = async (page: import('@playwright/test').Page) => {
  const ids = ['brake', 'auto', 'pause', 'cam', 'tilt', 'boost'] as const
  const boxes: { id: string; box: { x: number; y: number; width: number; height: number } }[] = []
  for (const id of ids) {
    const box = await page.locator(chip(id)).boundingBox()
    if (box) boxes.push({ id, box })
  }
  return boxes
}

/**
 * The menu, on a phone, by thumb — DEV-290 and DEV-291.
 *
 * Matt, having played this build on a phone: *"i don't know how you're opening
 * the pause menu"*, then *"mobile menu should work w/ tap"*. Both are about one
 * screen, and neither was reachable by anything this suite had. The pause
 * control existed, the plate opened, the stick walked the rows — every one of
 * those facts was true and green while the feature was unusable by the person
 * who asked for it. What was missing was not coverage of a mechanism; it was
 * any assertion at all about whether a thumb could GET there.
 *
 * ── Why the layout check is GEOMETRY and not a screenshot ────────────────
 *
 * The defect was `BOOST` drawn on top of `CAM` with its own label clipped to
 * `OOST`, at 412 css px — a phone held PORTRAIT, which is how a phone is held
 * when a link opens on it. A picture would have shown it to anybody who
 * looked, and for the life of the feature nobody did: every automated look at
 * this overlay was 915 x 412, the one shape in which the five boxes happen to
 * clear each other. A screenshot needs an eye and this does not: *"no two of
 * these boxes intersect, and every one is on the glass"* is true at any width,
 * and is exactly the sentence that was false.
 */
test.describe('the menu is findable and tappable on a phone @gpu', () => {
  test.use(PHONE)
  test.setTimeout(240_000)

  test('the top row fits, on a big phone and a small one', async ({ page }) => {
    await page.goto('/?autopilot=1&xr=off')
    await firstPress(page, { tap: true })
    await switchSettled(page, READY.timeout)

    // DEV-566: a phone plays in landscape only, so these are three phones
    // held SIDEWAYS. The portrait widths this test was written for (412 and
    // 360, where DEV-290's BOOST once sat on CAM) are behind TURN YOUR PHONE
    // now and nothing on this row can be reached there; the narrow-width
    // rules in touch-overlay.ts stay, unreached on a phone, and say so.
    for (const [w, h] of [
      [915, 412], // a Pixel 7: the shape this was designed against
      [844, 390], // an iPhone 14
      [640, 360], // a small Android, so the rule is not tuned to one phone
    ] as const) {
      await page.setViewportSize({ width: w, height: h })
      // One beat for the media query and the flex pass.
      await page.waitForTimeout(250)
      const boxes = await topRowBoxes(page)
      // The five that exist on every device. `tilt` is the sixth and is
      // allowed to be missing — see `topRowBoxes`.
      for (const id of ['brake', 'auto', 'pause', 'cam', 'boost']) {
        expect(
          boxes.some((b) => b.id === id),
          `${w}x${h}: ${id} is drawn`,
        ).toBe(true)
      }

      for (const { id, box } of boxes) {
        expect(box.x, `${w}x${h}: ${id} starts on the glass`).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width, `${w}x${h}: ${id} ends on the glass`).toBeLessThanOrEqual(w)
        expect(box.y, `${w}x${h}: ${id} starts below the top edge`).toBeGreaterThanOrEqual(0)
        expect(box.y + box.height, `${w}x${h}: ${id} is not off the bottom`).toBeLessThanOrEqual(h)
      }

      // ── RECTANGLES, not spans ────────────────────────────────────────
      //
      // This compared x-extents only on its first draft, which is a test that
      // agrees with itself: it would have called a two-line layout a pile of
      // overlaps, and it would equally have missed a real collision between
      // two chips on different rows. Below 480 px the row deliberately wraps
      // — the mode chips take their own line — so the test has to speak in the
      // same dimensions the layout does.
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]
          const b = boxes[j]
          if (!a || !b) continue
          const gap = 0.5
          const apart =
            a.box.x + a.box.width <= b.box.x + gap ||
            b.box.x + b.box.width <= a.box.x + gap ||
            a.box.y + a.box.height <= b.box.y + gap ||
            b.box.y + b.box.height <= a.box.y + gap
          expect(apart, `${w}x${h}: ${a.id} and ${b.id} do not overlap`).toBe(true)
        }
      }
    }
  })

  test('the hamburger opens the plate, and a tap picks the row under it', async ({ page }) => {
    await page.goto('/?autopilot=1&xr=off')
    await firstPress(page, { tap: true })
    await switchSettled(page, READY.timeout)

    // Under way, rather than a fixed wait: the 15.5 s lift skips `stepFixed`,
    // so a sleep can land mid-ride with the clock unstarted. Same poll as
    // `controls-page.spec.ts`, for the same reason.
    await expect
      .poll(
        async () =>
          (await page.evaluate(
            () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.mission.elapsed ?? 0,
          )) as number,
        { timeout: 120_000, intervals: [500] },
      )
      .toBeGreaterThan(2)

    const menu = page.locator(chip('pause'))
    // The WORD. A bare glyph was the defect, so this is the assertion that
    // fails if somebody quietly takes it away again.
    await expect(menu).toHaveText(MENU_LABEL)
    expect((await plate(page)).open, 'nothing is up yet').toBe(false)

    await menu.tap()
    await expect.poll(async () => (await plate(page)).open, { timeout: 10_000 }).toBe(true)
    // It became the way OUT, and the flight controls left with the frozen sim.
    await expect(menu).toHaveText(MENU_CLOSE_LABEL)
    for (const id of ['brake', 'boost', 'auto', 'cam', 'confirm'] as const) {
      await expect(page.locator(chip(id)), `${id} while the plate is up`).toBeHidden()
    }

    const box = await page.locator('#viewport').boundingBox()
    expect(box).not.toBeNull()
    if (!box) return
    const tapAt = async (frac: number) => {
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * frac)
      await page.waitForTimeout(280)
      return await plate(page)
    }

    // ── a tap ABOVE the rows chooses nothing ────────────────────────────
    //
    // The non-vacuous half, and the one that separates a working picker from a
    // picker that hits SOMETHING. `PANEL_DROP` exists so that the eye line
    // lands in the TITLE band — a real region of the plate with no row in it —
    // and a ray that returned a row here would sail through every assertion
    // below while being wrong.
    // DEV-894: a phone's plate is scaled and centred, so the title band is wherever the
    // plate says it is: the middle of the strip between its top edge and its first row.
    const edges = (await pausePlateState(page)).edges
    const row0 = edges?.rowY[0]
    const pitch = (edges?.rowY[1] ?? 0) - (row0 ?? 0)
    const bandY =
      edges && row0 !== undefined ? (edges.top + (row0 - pitch / 2)) / 2 : box.height * 0.45
    const before = await tapAt(bandY / box.height)
    expect(before.open, 'a tap in the title band leaves the plate up').toBe(true)
    expect(before.page, 'and turns no page').toBe('pause')
    expect(before.selected, 'and moves nothing').toBe(0)

    // ── and a tap ON a row takes it ─────────────────────────────────────
    //
    // Swept rather than aimed at one pixel. Where a row lands on the glass is
    // a function of the fov, the aspect and `PANEL_DROP`, and a hard-coded
    // fraction would be this spec pinning arithmetic it did not do (DEV-027).
    // What is asserted is the claim the feature makes: a tap down the plate
    // reaches a row, and the plate ACTS on the row it reached.
    let reached: string | null = null
    for (let f = 0.55; f <= 0.95 && reached === null; f += 0.03) {
      const st = await tapAt(f)
      if (st.page !== 'pause') {
        reached = st.page
        break
      }
      if (!st.open) {
        // The tap took RESUME, which is row 0 and the right answer near the
        // top of the list. Re-open and carry on down.
        await menu.tap()
        await expect.poll(async () => (await plate(page)).open, { timeout: 10_000 }).toBe(true)
      }
    }
    // Every page the root plate can open is NAMED by the row that opens it
    // (DEV-223), so arriving on one is the proof that a finger picked that row
    // and the plate acted on it — a stronger statement than any index compare,
    // because it went through the whole ray → pick → activate chain.
    expect(reached, 'a tap down the plate opened one of its pages').not.toBeNull()

    // ── and the way out is the button that brought you in ───────────────
    await menu.tap()
    await expect.poll(async () => (await plate(page)).open, { timeout: 10_000 }).toBe(false)
    await expect(menu).toHaveText(MENU_LABEL)
  })

  /**
   * Turning the phone turns the view — DEV-292, end to end.
   *
   * ── What this adds over the unit test, and what it cannot ───────────────
   *
   * `tests/unit/device-orientation.test.ts` owns the TRANSFORM and checks it
   * against three's own `Quaternion`. What it cannot see is the wiring, which
   * is five joins long and every one of them silent if it is wrong: the chip's
   * release handler, the callback `app.ts` registers on it, `enable()` adding
   * the listener, the reading becoming a head pose, and that pose reaching
   * `render.camera.quaternion` in the branch that also has to not fight the
   * free look. A transform that is perfect and connected to nothing looks
   * exactly like a transform that is wrong.
   *
   * So the sensor is the only thing faked: a synthetic `deviceorientation` on
   * `window`, which is the same event and the same listener a real phone
   * reaches. That is the harness doing something extra rather than the GAME
   * taking a different path — CLAUDE.md's line — because no code here is
   * switched by whether the event was generated by hardware.
   *
   * ── The assertion is a YAW, not a quaternion ────────────────────────────
   *
   * *"Turn the phone 45 degrees and the view turns 45 degrees"* is true
   * independently of anybody's euler order, and it is the sentence a player
   * would use. A quaternion compare here would be the port's own belief
   * written twice, and would pass with the whole transform mirrored — which is
   * the orientation lesson, and this project has paid for it four times.
   */
  test('turning the phone turns the view, once TILT is on', async ({ page }) => {
    await page.goto('/?autopilot=1&xr=off')
    await firstPress(page, { tap: true })
    await switchSettled(page, READY.timeout)
    await expect
      .poll(
        async () =>
          (await page.evaluate(
            () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.mission.elapsed ?? 0,
          )) as number,
        { timeout: 120_000, intervals: [500] },
      )
      .toBeGreaterThan(2)

    /** One reading, delivered the way a phone delivers one. */
    const turnTo = async (alpha: number) => {
      await page.evaluate(
        ([a, b]) => {
          window.dispatchEvent(
            new DeviceOrientationEvent('deviceorientation', {
              alpha: a,
              beta: b,
              gamma: 0,
            }),
          )
        },
        [alpha, 80] as const,
      )
      await page.waitForTimeout(120)
    }

    /**
     * Where the HEAD is looking inside the ship, as a bearing in degrees.
     *
     * The camera's LOCAL quaternion, which in the cockpit is the head inside
     * the rig — world space would also swing with the aircraft, which under
     * the autopilot is turning the whole time and would swamp the signal.
     * Trap 18 in the direction nobody usually needs it.
     */
    const headBearing = async (): Promise<number> =>
      (await page.evaluate(() => {
        const cam = (globalThis as unknown as Ff2Global).__ff2.render.camera.quaternion
        // (0, 0, −1) rotated by the quaternion, expanded, then the same
        // `atan2(-x, -z)` `quatYaw` uses — which is what puts STRAIGHT AHEAD
        // at zero. Written the other way round on the first run and every
        // reading came back 180: a bearing convention is exactly the kind of
        // thing that is obvious once a number disagrees with you.
        const fx = -2 * (cam.x * cam.z + cam.w * cam.y)
        const fz = -(1 - 2 * (cam.x * cam.x + cam.y * cam.y))
        return (Math.atan2(-fx, -fz) * 180) / Math.PI
      })) as number

    const tilt = page.locator(chip('tilt'))
    await expect(tilt, 'the chip is offered on a device with sensors').toBeVisible()
    await expect(tilt).not.toHaveAttribute('data-on', '1')

    // Events before the chip is tapped must reach nothing at all: no listener
    // is attached, and a view that moved here would mean the game reads the
    // sensors of anybody who visits without being asked.
    await turnTo(0)
    await expect(tilt, 'unarmed, and stays unarmed').not.toHaveAttribute('data-on', '1')

    await tilt.tap()
    // It lights on the first READING, not on the tap — `deviceLook.active`.
    // Before that there is no pose, and a lit chip would be a control claiming
    // to work before it does.
    await turnTo(0)
    await expect(tilt).toHaveAttribute('data-on', '1')

    // Square ahead, because the first reading is taken as the reference: the
    // player is pointed wherever they were pointed, not at magnetic north.
    const straight = await headBearing()
    expect(
      Math.abs(straight),
      `enabling faces you forward, got ${straight.toFixed(2)}`,
    ).toBeLessThan(1)

    // ── the view FOLLOWS the phone, and does not mirror it ──────────────
    //
    // The sign is the whole assertion, not a detail. `alpha` increases
    // counter-clockwise seen from above — the phone turning LEFT — and a
    // positive Y-rotation of (0, 0, −1) gives exactly the bearing measured
    // above, which is also left. So `alpha + 45 -> bearing + 45` reads: turn
    // the phone left, the view goes left. The mirrored build passes every
    // magnitude check here and none of these, which is the whole reason the
    // expectations are signed.
    for (const [alpha, want] of [
      [45, 45],
      [-30, -30],
      [0, 0],
    ] as const) {
      await turnTo(alpha)
      const got = await headBearing()
      expect(got, `alpha ${alpha} -> bearing ${got.toFixed(2)}`).toBeCloseTo(want, 0)
    }

    // ── the CHASE CAMERA orbits with it too (DEV-292, second home) ──────
    //
    // Matt, having flown the cockpit one on a real phone: *"can you make the
    // tilt work for the chase-cam as well?"*
    //
    // Measured RELATIVE TO THE SHIP, which is the only honest frame here: the
    // arm orbits about the ship's own lagged rotation, and the autopilot is
    // turning the whole time, so a world bearing would be the phone's 45° plus
    // however far the aircraft came round between two samples. Subtracting the
    // ship's heading leaves the quantity the feature actually controls.
    await tilt.tap()
    await expect(tilt).not.toHaveAttribute('data-on', '1')
    const cam = page.locator(chip('cam'))
    await cam.tap()
    await expect(cam, 'the chase camera is live').toHaveAttribute('data-on', '1')
    await tilt.tap()
    await turnTo(0)
    await expect(tilt, 'and the phone is driving again').toHaveAttribute('data-on', '1')

    /** What the arm was HANDED last frame, degrees — or null if it is not live. */
    const orbitLook = async (): Promise<{
      yaw: number
      pitch: number
      fromDevice: boolean
    } | null> =>
      (await page.evaluate(() => {
        const l = (globalThis as unknown as Ff2Global).__ff2.orbitLook()
        return l === null
          ? null
          : {
              yaw: (l.yaw * 180) / Math.PI,
              pitch: (l.pitch * 180) / Math.PI,
              fromDevice: l.fromDevice,
            }
      })) as { yaw: number; pitch: number; fromDevice: boolean } | null

    /** Where the lens sits around the ship, in the SHIP's frame, degrees. */
    const orbitBearing = async (): Promise<number> =>
      (await page.evaluate(() => {
        const w = globalThis as unknown as Ff2Global
        const f = w.__ff2.flight()
        if (!f) return Number.NaN
        const lens = w.__ff2.render.rig.position
        const ship = f.object.position
        const q = f.object.quaternion
        // Into the SHIP'S OWN FRAME, by conjugate-rotating the offset. A
        // plain horizontal bearing is distorted by BANK, and the aircraft is
        // banking continuously under the autopilot: measured that way the same
        // sweep reads a slope of 0.70 instead of 0.75, for a reason that is
        // about the measurement and not about the camera.
        const vx = lens.x - ship.x
        const vy = lens.y - ship.y
        const vz = lens.z - ship.z
        const cx = -q.x
        const cy = -q.y
        const cz = -q.z
        const tx = 2 * (cy * vz - cz * vy)
        const ty = 2 * (cz * vx - cx * vz)
        const tz = 2 * (cx * vy - cy * vx)
        const lx = vx + q.w * tx + (cy * tz - cz * ty)
        const lz = vz + q.w * tz + (cx * ty - cy * tx)
        let rel = Math.atan2(lx, lz)
        while (rel > Math.PI) rel -= 2 * Math.PI
        while (rel < -Math.PI) rel += 2 * Math.PI
        return (rel * 180) / Math.PI
      })) as number

    // ── 1. the phone's angles REACH the arm, exactly ────────────────────
    //
    // The precise half. `orbitLook` is the pair the arm was handed, recorded
    // at the call site, so there is no lag between the phone and this number.
    const held = await orbitLook()
    expect(held, 'the chase camera is live and has been given a look').not.toBeNull()
    expect(held?.fromDevice, 'and the PHONE is the thing giving it').toBe(true)
    expect(held?.yaw ?? 999, 'square astern at the reference heading').toBeCloseTo(0, 0)

    await turnTo(45)
    const turned = await orbitLook()
    // Signed and tight. A mirrored build lands at −45 and would pass any check
    // written on the magnitude — which is the orientation lesson, and the
    // reason this is the assertion rather than a distance.
    expect(turned?.yaw ?? 999, `45° of phone -> ${turned?.yaw.toFixed(1)}° of arm`).toBeCloseTo(
      45,
      0,
    )

    // ── 2. and the arm actually MOVED the lens ──────────────────────────
    //
    // The loose half, and it is loose on purpose. Measured in the ship's own
    // frame, 45° of phone moves the lens by about 0.75 of that, consistently —
    // because the lens orbits a pivot that is metres behind the ship on a
    // rotation that is degrees behind it, which is what `positionLagSeconds`
    // and `rotationLagSeconds` are FOR. Asserting that 0.75 would pin two
    // tuning constants inside a test about an input, so what is asserted is
    // the direction and that it is substantial. `spring-arm.test.ts` pins the
    // exact geometry, on a stationary ship where there is no lag to fight.
    await turnTo(0)
    const astern = await orbitBearing()
    expect(Number.isNaN(astern), 'the lens is placed').toBe(false)
    await turnTo(45)
    let moved = (await orbitBearing()) - astern
    while (moved > 180) moved -= 360
    while (moved < -180) moved += 360
    expect(moved, `the lens swung ${moved.toFixed(1)}°`).toBeGreaterThan(15)
    expect(moved, `the lens swung ${moved.toFixed(1)}°`).toBeLessThan(75)

    // Back to the cockpit, so the teardown below is the state it expects.
    await cam.tap()
    await expect(cam).not.toHaveAttribute('data-on', '1')

    // ── and it gives the view back ──────────────────────────────────────
    //
    // Off, and the seat is square again rather than frozen at whatever angle
    // the phone was holding. A stuck view reads as the game having hung.
    await turnTo(60)
    expect(Math.abs(await headBearing())).toBeGreaterThan(30)
    await tilt.tap()
    await expect(tilt).not.toHaveAttribute('data-on', '1')
    await page.waitForTimeout(400)
    const after = await headBearing()
    expect(Math.abs(after), `the seat squares up, got ${after.toFixed(2)}`).toBeLessThan(2)
  })
})

// ── "race this lap", on glass (DEV-371 follow-up) ─────────────────────────
//
// Matt, 2026-09-25: *"a touch route to 'race this lap'"*. The results panel
// offered it by R, a pad's Y and the right stick's click in a headset, and a
// phone had none of them. The chip is offered on exactly the predicate the
// race handler acts on, so this flies a lap, finds the chip beside AGAIN, taps
// it, and reads the controller's own state (`__ff2.laps()`, DEV-371) to say the
// next run races the lap JUST flown rather than the kept best.
//
// LANDSCAPE since DEV-566 (Matt, 2026-10-02: "landscape only in phone mode").
// It was PORTRAIT, the way Matt held the phone and the shape this overlay was
// once broken at (DEV-290); a phone held upright now gets TURN YOUR PHONE and
// a paused run, so this lap would never finish. `?autopilot=1` flies the lap (it presses A for
// itself); the lap it leaves is tainted, and a tainted lap is exactly what is
// still kept and raced locally (DEV-371 §2).
test.describe('race this lap, on glass (DEV-371 follow-up) @gpu', () => {
  test.use(PHONE)
  test.setTimeout(480_000)

  interface LapsView {
    last: { seconds: number | null } | null
    ghost: { source: string; seconds: number | null } | null
  }
  const laps = (page: import('@playwright/test').Page): Promise<LapsView | null> =>
    page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.laps() ?? null)

  test('the panel offers RACE THIS LAP beside AGAIN, and a tap races that lap', async ({
    page,
  }) => {
    await page.goto(
      `/?autopilot=1&ride=0&mission=int_01_hoverJet&edition=anniversary&xr=off&${PINNED}`,
    )
    await firstPress(page, { tap: true })
    await switchSettled(page, READY.timeout)

    const race = page.locator(chip('race'))
    const again = page.locator(chip('confirm'))
    // Flying: nothing to race yet, so no chip.
    await expect(race).toBeHidden()

    await page.waitForSelector('body[data-finished="true"]', { timeout: 300_000 })
    await expect(race, 'offered once the lap is kept').toBeVisible({ timeout: 10_000 })
    await expect(race).toHaveText(RACE_LAP_LABEL)
    // DEV-607: no CONTINUE chip; the menu's BACK TO THE HANGAR row is home.
    await expect(again).toBeHidden()

    // On the glass: a rectangle, not a span.
    const raceBox = await race.boundingBox()
    expect(raceBox).not.toBeNull()
    const r = raceBox as NonNullable<typeof raceBox>
    const { width, height } = PHONE.viewport
    expect(r.x, 'starts on the glass').toBeGreaterThanOrEqual(0)
    expect(r.x + r.width, 'ends on the glass').toBeLessThanOrEqual(width)
    expect(r.width, 'a thumb-sized target').toBeGreaterThanOrEqual(44)
    expect(r.height, 'a thumb-sized target').toBeGreaterThanOrEqual(44)
    // DEV-406 follow-up (Matt: "continue. fly again."): FLY AGAIN, under RACE
    // THIS LAP, on the glass. (CONTINUE was the big button, gone with DEV-607.)
    const flyAgain = page.locator(chip('again'))
    await expect(flyAgain).toBeVisible()
    await expect(flyAgain).toHaveText(AGAIN_LABEL)
    const flyBox = await flyAgain.boundingBox()
    expect(flyBox).not.toBeNull()
    const g = flyBox as NonNullable<typeof flyBox>
    expect(g.x, 'FLY AGAIN starts on the glass').toBeGreaterThanOrEqual(0)
    expect(g.x + g.width, 'and ends on it').toBeLessThanOrEqual(width)
    expect(r.y + r.height, 'RACE THIS LAP above FLY AGAIN').toBeLessThanOrEqual(g.y)
    expect(g.height, 'a thumb-sized target').toBeGreaterThanOrEqual(44)
    console.info(
      `race chip ${JSON.stringify(r)} · fly again ${JSON.stringify(g)} · glass ${width} x ${height}`,
    )

    const dir = process.env.MOBILE_DIR ?? 'test-results/mobile-controls'
    await page.screenshot({
      path: `${dir}/race-this-lap-landscape-${PINNED.replace(/[=&]/g, '')}.png`,
    })

    // ── DEV-571: the menu under the panel, tapped as a finger does ──────
    //
    // The autopilot's lap is tainted, so the menu says why it cannot go on the
    // leaderboard and asks SAVE AS YOUR GHOST?. A tap on that row is a press of
    // it, and the aim goes back home, where CONTINUE (the confirm chip) goes.
    const ask = () => page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.share().ask)
    const asked = await ask()
    expect(asked?.up, 'the menu is up under the panel').toBe(true)
    expect(asked?.rows.map((r) => r.id)).toEqual(['lap-post', 'lap-keep', 'lap-home'])
    const keepAt = asked?.centres?.find((c) => c.id === 'lap-keep')
    expect(keepAt, 'the save row is on the glass').toBeDefined()
    const k = keepAt as NonNullable<typeof keepAt>
    expect(k.x).toBeGreaterThan(0)
    expect(k.x).toBeLessThan(width)
    expect(k.y).toBeGreaterThan(0)
    expect(k.y).toBeLessThan(height)
    const savedBefore = asked?.rows.find((r) => r.id === 'lap-keep')?.value
    await page.touchscreen.tap(k.x, k.y)
    await expect
      .poll(async () => (await ask())?.rows.find((r) => r.id === 'lap-keep')?.value, {
        message: 'a tap on SAVE AS YOUR GHOST? answers it',
        timeout: 10_000,
      })
      .toBe(savedBefore === 'Yes' ? 'No' : 'Yes')
    expect((await ask())?.aim, 'and the aim is home again').toBe('lap-home')
    await page.screenshot({
      path: `${dir}/lap-ask-landscape-${PINNED.replace(/[=&]/g, '')}.png`,
    })

    const flown = await laps(page)
    expect(flown?.last?.seconds, 'the run left a lap').not.toBeNull()
    await race.tap()
    await expect
      .poll(async () => (await laps(page))?.ghost?.source ?? null, {
        message: 'the next run races the lap just flown',
        timeout: 10_000,
      })
      .toBe('this-lap')
    expect((await laps(page))?.ghost?.seconds, 'that lap, by its time').toBe(flown?.last?.seconds)
    // A new run: the panel, and the chip with it, are gone.
    await expect(race).toBeHidden()
  })
})

// ── A phone plays sideways (DEV-566) ─────────────────────────────────────
//
// Matt, 2026-10-02: *"let's make it so it's landscape only in phone mode"*.
// A phone held upright gets TURN YOUR PHONE over everything, nothing behind it
// takes input, and a live run pauses and STAYS paused after the turn until the
// player resumes. `tests/unit/turn-phone.test.ts` owns the rule's arithmetic;
// this owns the part only a browser can answer: that Chromium's own phone
// emulation (`isMobile`, `hasTouch`, a real screen size) is read as a phone,
// that the element really stands over the glass, and that the frame loop
// really holds the run.
//
// TURNING is `setViewportSize` with the sides swapped, which is what Chromium's
// device emulation does for a rotation: the viewport, the screen and the
// orientation all change together, and the page gets the `resize` a real phone
// sends. Nothing in the game is switched by how the turn was made.

/** The turn screen's element. */
const TURN = `#${TURN_ROOT_ID}`
/** A Pixel 7 held upright: the PHONE above, its two sides swapped. */
const UPRIGHT = { width: PHONE.viewport.height, height: PHONE.viewport.width }

/** Which way round the page thinks the phone is, off the body (`turn-phone.ts`). */
const turnState = (page: import('@playwright/test').Page): Promise<string | null> =>
  page.evaluate(() => document.body.dataset.turnPhone ?? null)

/** Which screen the game is on (`__ff2.hangarAim().screen`): title, menu or mission. */
const appScreen = (page: import('@playwright/test').Page): Promise<string | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()?.screen ?? null)

/** The sim's own clock, `__ff2.mission.elapsed`. */
const missionElapsed = (page: import('@playwright/test').Page): Promise<number> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.mission.elapsed ?? 0)

/** Tap a chip by its box, THROUGH whatever stands over it: what a finger does. */
const tapWhereChipIs = async (page: import('@playwright/test').Page, act: string) => {
  const box = await page.locator(chip(act)).boundingBox()
  expect(box, `${act} has a box to tap at`).not.toBeNull()
  if (!box) return
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
}

test.describe('a phone held upright is asked to turn it (DEV-566)', () => {
  test.use({ ...PHONE, viewport: UPRIGHT })

  test('boots behind TURN YOUR PHONE, read as a phone off the emulated screen', async ({
    page,
  }) => {
    await page.goto(FLAT)
    // Set when the screen mounts, inside `bootApp`, long before any world.
    await expect.poll(() => turnState(page), { timeout: 60_000 }).toBe('up')
    await expect(page.locator(TURN)).toBeVisible()
    await expect(page.locator(`${TURN} h2`)).toHaveText(TURN_TITLE)
    // Nothing is paused on the title, so the line about a paused run is not up.
    await expect(page.locator(TURN).getByText(TURN_PAUSED_NOTE)).toBeHidden()
    // The premise, read rather than assumed: Chromium reports a phone-sized
    // SCREEN under this emulation, held upright.
    const shape = await page.evaluate(() => ({
      screen: Math.min(screen.width, screen.height),
      upright: innerHeight >= innerWidth,
    }))
    expect(shape.screen, 'a phone-sized screen').toBeLessThan(600)
    expect(shape.upright).toBe(true)
  })
})

test.describe('a tablet is left exactly as it was (DEV-566)', () => {
  // An iPad Air held upright, under the same emulation a phone gets.
  test.use({ ...PHONE, viewport: { width: 820, height: 1180 } })

  test('is in touch mode, upright, and never asked to turn', async ({ page }) => {
    await page.goto(FLAT)
    // The screen is mounted (touch mode) and stands down: a tablet is no phone.
    await expect.poll(() => turnState(page), { timeout: 60_000 }).toBe('down')
    await expect(page.locator(TURN)).toBeHidden()
    await expect(page.locator(ROOT)).toHaveCount(1)
  })
})

test.describe('turning a phone (DEV-566) @gpu', () => {
  test.use(PHONE)
  test.setTimeout(420_000)

  const dir = process.env.MOBILE_DIR ?? 'test-results/mobile-controls'
  const shot = (page: import('@playwright/test').Page, name: string) =>
    page.screenshot({ path: `${dir}/${name}-${PINNED.replace(/[=&]/g, '')}.png` })

  test('the title and the hangar take nothing from behind the screen', async ({ page }) => {
    await page.goto(`${FLAT}&${PINNED}`)
    await firstPress(page, { tap: true })
    await bootReady(page, 120_000)
    const confirm = page.locator(chip('confirm'))
    // DEV-619: no chip on the title; the plate's START row is the button.
    await expect(confirm).toBeHidden()
    expect(await turnState(page)).toBe('down')
    await shot(page, 'title-phone-landscape')

    // ── upright: the title is there, and nothing reaches it ─────────────
    await page.setViewportSize(UPRIGHT)
    await expect.poll(() => turnState(page), { timeout: 10_000 }).toBe('up')
    await expect(page.locator(TURN)).toBeVisible()
    await shot(page, 'title-phone-portrait')
    // A finger where START's row is lands on the screen, not the row.
    const upright = await titleMenu(page)
    const startAt = upright?.rowsAt?.[upright.rows.indexOf(TITLE_ROW.hangar)]
    expect(startAt, 'the title says where START is').toBeTruthy()
    // DEV-902: a phone's rows stand in the right half of a SIDEWAYS view, which an
    // upright one does not reach, so START is off the glass here; a finger goes as
    // near it as the glass allows. (A tap off the page is no finger at all, and it
    // left the hangar's aim on a point no screen has.)
    if (startAt) await page.touchscreen.tap(Math.min(startAt.x, UPRIGHT.width - 2), startAt.y)
    // A key (a phone with a keyboard paired) is stopped at the window.
    await page.keyboard.down('Enter')
    await page.waitForTimeout(200)
    await page.keyboard.up('Enter')
    await page.waitForTimeout(800)
    expect((await titleMenu(page))?.up, 'the title is still up').toBe(true)
    // The SCREEN, not the step: the room lays its doors at boot, under the
    // title (DEV-558), so `view` reads `doors` before anybody presses START.
    expect(await appScreen(page), 'and the room never became the screen').toBe('title')

    // ── sideways again: the same tap works ─────────────────────────────
    await page.setViewportSize(PHONE.viewport)
    await expect.poll(() => turnState(page), { timeout: 10_000 }).toBe('down')
    await expect(page.locator(TURN)).toBeHidden()
    await tapTitleRow(page, TITLE_ROW.hangar)
    await expect.poll(() => appScreen(page), { timeout: 10_000 }).toBe('menu')
    expect(await menuView(page), 'on the first step').toBe('doors')
    await page.waitForTimeout(1_500)
    await shot(page, 'hangar-doors-phone-landscape')

    // ── and in the hangar, the same ─────────────────────────────────────
    await page.setViewportSize(UPRIGHT)
    await expect.poll(() => turnState(page), { timeout: 10_000 }).toBe('up')
    await page.waitForTimeout(500)
    await shot(page, 'hangar-doors-phone-portrait')
    const aimBefore = JSON.stringify(await menuAimFull(page))
    // DEV-607: no chip in the hangar; a finger on the glass, where a table is.
    await tapTheGlass(page)
    // A drag on the glass, which would turn the seat on an open screen.
    await page.mouse.move(206, 450)
    await page.mouse.down()
    await page.mouse.move(326, 450, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(800)
    expect(await menuView(page), 'still the first step').toBe('doors')
    expect(await appScreen(page), 'and still the room').toBe('menu')
    expect(JSON.stringify(await menuAimFull(page)), 'and the seat never turned').toBe(aimBefore)
    await page.setViewportSize(PHONE.viewport)
    await expect.poll(() => turnState(page), { timeout: 10_000 }).toBe('down')
  })

  test('a live run pauses when the phone turns upright, and waits for RESUME', async ({ page }) => {
    await page.goto(`/?autopilot=1&ride=0&mission=int_01_hoverJet&xr=off&${PINNED}`)
    await firstPress(page, { tap: true })
    await switchSettled(page, READY.timeout)
    // Under way: the clock has started and is moving.
    await expect
      .poll(() => missionElapsed(page), { timeout: 120_000, intervals: [500] })
      .toBeGreaterThan(2)
    const mark = await missionElapsed(page)
    await expect.poll(() => missionElapsed(page), { timeout: 30_000 }).toBeGreaterThan(mark)
    expect((await plate(page)).open, 'flying, nothing up').toBe(false)
    await shot(page, 'mission-phone-landscape')

    // ── upright: paused, and saying so ──────────────────────────────────
    await page.setViewportSize(UPRIGHT)
    await expect.poll(() => turnState(page), { timeout: 10_000 }).toBe('up')
    await expect.poll(async () => (await plate(page)).open, { timeout: 10_000 }).toBe(true)
    await expect(page.locator(TURN).getByText(TURN_PAUSED_NOTE)).toBeVisible()
    await shot(page, 'mission-phone-portrait')
    const held = await missionElapsed(page)
    // The hamburger, under the screen, is a finger on the screen.
    await tapWhereChipIs(page, 'pause')
    await page.waitForTimeout(2_000)
    expect(await missionElapsed(page), 'the clock is stopped').toBeCloseTo(held, 3)
    expect((await plate(page)).open, 'and the plate stays up').toBe(true)

    // ── sideways again: STILL paused, the menu waiting on the player ────
    await page.setViewportSize(PHONE.viewport)
    await expect.poll(() => turnState(page), { timeout: 10_000 }).toBe('down')
    await expect(page.locator(TURN)).toBeHidden()
    await page.waitForTimeout(2_000)
    expect((await plate(page)).open, 'the menu is still up after the turn').toBe(true)
    expect(await missionElapsed(page), 'and the run did not fly on by itself').toBeCloseTo(held, 3)
    const menu = page.locator(chip('pause'))
    await expect(menu).toHaveText(MENU_CLOSE_LABEL)
    await shot(page, 'mission-phone-turned-back')

    // ── RESUME: the player's press, and the clock moves ─────────────────
    await menu.tap()
    await expect.poll(async () => (await plate(page)).open, { timeout: 10_000 }).toBe(false)
    await expect
      .poll(() => missionElapsed(page), { timeout: 10_000, intervals: [250] })
      .toBeGreaterThan(held + 0.5)
  })
})
