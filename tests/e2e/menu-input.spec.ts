/**
 * The menus respond when you do the obvious thing — DEV-299, DEV-300, DEV-301.
 *
 * Five wishlist rows, one sitting, and every one of them is an INPUT reaching a
 * MENU through `boot/app.ts`'s frame loop. That path is outside the unit tests
 * by construction: `menu-tap.test.ts` owns the arithmetic of the tap and
 * `look.test.ts` owns the held view, and neither of them can say whether an
 * arrow key or a mouse button arrives at all.
 *
 * ── What is measured, rather than observed ───────────────────────────────
 *
 *  · #39 — not "the menu moved", which was green for a 200 ms press on the
 *    build that shipped. The variable is the TAP DURATION, measured IN THE
 *    PAGE off the real key events, and the claim is three short taps, three
 *    rows. The old build could not do that at any tap length: the ramp's decay
 *    held the edge detector for ~90 ms after the key came up.
 *  · #38 — an ANGLE, after an idle five times `FREE_LOOK_HOLD`. The view is
 *    where the player left it, and the same stillness unpaused brings it back,
 *    which is the control that stops the first claim being true of a build
 *    whose free look was deleted.
 *  · #35/#36/#37 — a click does what the A button does, and **the click that
 *    captures the pointer does nothing at all**. That second half is the
 *    safety property the whole design rests on, and it is why ~50 specs can go
 *    on clicking the canvas for focus without pressing a button.
 *  · DEV-418 — the title captures and looks like the hangar, and a CURSOR click
 *    on one of its rows is still a press of that row: one click still leaves
 *    the title, on the row you clicked.
 *
 * ── The pointer lock is untouched, and this spec proves it ───────────────
 *
 * No `?pointerlock=0`, no stub, no switch. The game a player runs is the game
 * this drives; `tests/e2e/fixtures/canvas.ts` says why that matters and what it
 * cost to learn. Escape here is a player pressing Escape.
 *
 * Tagged `@gpu` with the rest: it needs a world and a real GPU to reach one.
 */

import { bootReady, missionReady } from './fixtures/boot'
import { CANVAS, pointerIsLocked, releasePointer } from './fixtures/canvas'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { lookUntilAimed } from './fixtures/hangar'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { expect, type Page, test } from './fixtures/test'

/** Pinned, so the build under test is the same build every run (TEAM §1). */
const PIN = 'adaptive=0&quality=high&xr=off'

type Quat = readonly [number, number, number, number]
const STRAIGHT_AHEAD: Quat = [0, 0, 0, 1]

interface Plate {
  open: boolean
  selected: number
  rows: number
}

const plate = async (page: Page): Promise<Plate> =>
  (await page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    const p = w.__ff2?.pausePlate()
    return { open: p?.open ?? false, selected: p?.selected ?? -1, rows: p?.rows.length ?? 0 }
  })) as Plate

const elapsed = async (page: Page): Promise<number> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.mission.elapsed ?? 0)

/**
 * The camera's LOCAL orientation — which in the cockpit is the free look and
 * nothing else.
 *
 * `flight.render` zeroes this every frame and the seat look is the only thing
 * that writes it, so reading the local quaternion asks about the free look
 * directly rather than about the rig, which is where the ship's attitude lives.
 * A camera's pose being LOCAL has bitten this project before (trap 18); here it
 * is the property being relied on, deliberately.
 */
const headQuat = async (page: Page): Promise<Quat> =>
  (await page.evaluate(() => {
    const q = (globalThis as unknown as Ff2GlobalMaybe).__ff2?.render.camera.quaternion
    return [q?.x ?? 0, q?.y ?? 0, q?.z ?? 0, q?.w ?? 1]
  })) as Quat

/** Angle between two orientations, in degrees. A relationship, not a value. */
const between = (a: Quat, b: Quat): number => {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI
}

/** Whether the monument is in the drawn scene. */
const titleUp = async (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    let up = false
    ;(globalThis as unknown as Ff2GlobalMaybe).__ff2?.render.scene.traverse((o) => {
      if (o.name === 'title-screen') up = o.visible === true
    })
    return up
  })

interface TitleMenuProbe {
  up: boolean
  selected: number
  rows: string[]
  rowsAt: { x: number; y: number }[] | null
  /** DEV-441: the page that is up, and every page's rows. */
  page?: string
  pages?: Record<string, string[]>
}

/** The title's rows — `__ff2.titleMenu()` (DEV-353): up, the row a press takes, where each is drawn. */
const titleMenuProbe = async (page: Page): Promise<TitleMenuProbe> =>
  (await page.evaluate(
    () =>
      (globalThis as unknown as Ff2GlobalMaybe).__ff2?.titleMenu?.() ?? {
        up: false,
        selected: -1,
        rows: [],
        rowsAt: null,
      },
  )) as TitleMenuProbe

/**
 * To the title with its rows up — the valley in, the card gone — and the
 * window in front, because Pointer Lock is refused on an UNFOCUSED document
 * (`input/look.ts` says so at the request) and a headed run with several
 * windows open has only one of them focused. A player always has the window
 * they are playing in.
 */
const toTheTitle = async (page: Page): Promise<TitleMenuProbe> => {
  await page.goto(`/?${PIN}`)
  await page.bringToFront()
  await bootReady(page)
  await firstPress(page)
  await expect
    .poll(async () => (await titleMenuProbe(page)).up, {
      message: 'the title offers its rows once the valley is in and the card is gone',
      timeout: 60_000,
    })
    .toBe(true)
  await expect(page.locator('body')).toHaveAttribute('data-fade', 'idle', { timeout: 30_000 })
  expect(await titleUp(page), 'the monument is up').toBe(true)
  return titleMenuProbe(page)
}

/**
 * Which step of the level select is open, and what the pointer is on.
 *
 * `view` and a KIND, never a plate count or an index into a dealt page: which
 * combinations get a plate at all is somebody else's change this week, and the
 * claim here is only that a click does what Enter does.
 */
const hangar = async (page: Page): Promise<{ view: string; kind: string | null }> =>
  (await page.evaluate(() => {
    const a = (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()
    return { view: a?.view ?? '', kind: a?.aim?.kind ?? null }
  })) as { view: string; kind: string | null }

/**
 * Held, not tapped — for the PAUSE key and for Enter.
 *
 * Every confirm and the pause toggle are LEVEL reads once a frame, so a press
 * that lands between two frames is a press nothing saw. `pause.spec.ts`,
 * `lap.spec.ts` and `walkthrough.spec.ts` all carry the same note. It is
 * deliberately NOT what this spec does to the ARROW keys, which is #39.
 */
const hold = (page: Page, key: string): Promise<void> =>
  keysHold(page, key, { down: 200, settle: 250 })

/**
 * One tap of `code`, short enough to be a TAP and long enough to be a frame.
 *
 * `press` with a delay, not `down` / `waitForTimeout` / `up`: each of those is
 * its own round trip and the pair measured **96 ms in the page** for a 40 ms
 * wait — over the ~90 ms the ramped axis needed, which would have made this
 * spec unable to tell the fix from the bug. The precondition below caught it,
 * which is what it is for.
 *
 * 40 ms is the floor, not a preference: the pause selection is a LEVEL read
 * once a frame, so a tap has to span a frame boundary to be seen at all —
 * ~11 ms at 90 Hz, ~17 at 60. The unit test owns the shorter durations, where
 * the frame rate is a parameter instead of the weather.
 */
const tap = async (page: Page, code: string): Promise<void> => {
  await page.keyboard.press(code, { delay: 40 })
  await page.waitForTimeout(90)
}

/** Click near the TOP of the canvas: the hangar's roof, where no table, mark or plate is. */
const clickBareRoom = async (page: Page): Promise<void> => {
  const box = await page.locator(CANVAS).boundingBox()
  if (!box) throw new Error('no canvas')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.06)
  await page.waitForTimeout(250)
}

/** Click the middle of the canvas. */
const clickCanvas = async (page: Page): Promise<void> => {
  const box = await page.locator(CANVAS).boundingBox()
  if (!box) throw new Error('no canvas')
  // `page.mouse`, not `locator.click()`: while the pointer is captured the
  // canvas is the only thing on the page that receives events, and an
  // actionability check on it is a retry loop waiting for a state the feature
  // will never leave. That is what pointer lock MEANS.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(250)
}

/**
 * Click where the mouse ALREADY IS.
 *
 * Under pointer lock there is no cursor and a `move` is a LOOK — so a click
 * that repositions first would swing the gaze, and on the pause plate the gaze
 * picks the row. `page.mouse.click(x, y)` moves first, so it cannot be used for
 * a click whose aim is the point of the test. Cost: one run, and it is exactly
 * the class of thing the wishlist's own trap is about.
 */
const clickInPlace = async (page: Page): Promise<void> => {
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(250)
}

/**
 * A captured mouse, glided by a DELTA, six steps, tracking where it is.
 *
 * Relative rather than absolute because a look is a sum of `movementX/Y`: two
 * opposite glides must cancel exactly, and `move(0, 0)` from an unknown
 * position does not. The first version of this spec had that bug.
 */
const tracker = (start: { x: number; y: number }) => {
  const at = { ...start }
  return async (page: Page, dx: number, dy: number): Promise<void> => {
    for (let i = 1; i <= 6; i++) await page.mouse.move(at.x + (dx * i) / 6, at.y + (dy * i) / 6)
    at.x += dx
    at.y += dy
    await page.waitForTimeout(200)
  }
}

/** Where `clickCanvas` leaves the mouse. */
const canvasCentre = async (page: Page): Promise<{ x: number; y: number }> => {
  const box = await page.locator(CANVAS).boundingBox()
  if (!box) throw new Error('no canvas')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Install a listener that records the real key timings, in the page. */
const watchTaps = async (page: Page, code: string): Promise<void> => {
  await page.evaluate((c: string) => {
    const w = globalThis as unknown as { __taps?: { kind: string; at: number }[] }
    w.__taps = []
    addEventListener('keydown', (e) => {
      const k = e as KeyboardEvent
      if (k.code === c && !k.repeat) w.__taps?.push({ kind: 'down', at: performance.now() })
    })
    addEventListener('keyup', (e) => {
      if ((e as KeyboardEvent).code === c) w.__taps?.push({ kind: 'up', at: performance.now() })
    })
  }, code)
}

/** The longest hold and the shortest gap the page actually saw, in ms. */
const tapTimings = async (page: Page): Promise<{ hold: number; gap: number; count: number }> =>
  (await page.evaluate(() => {
    const taps = (globalThis as unknown as { __taps?: { kind: string; at: number }[] }).__taps ?? []
    let longest = 0
    let gap = Number.POSITIVE_INFINITY
    let count = 0
    for (let i = 1; i < taps.length; i++) {
      const d = (taps[i]?.at ?? 0) - (taps[i - 1]?.at ?? 0)
      if (taps[i]?.kind === 'up') {
        longest = Math.max(longest, d)
        count++
      } else gap = Math.min(gap, d)
    }
    return { hold: longest, gap: Number.isFinite(gap) ? gap : 0, count }
  })) as { hold: number; gap: number; count: number }

test.describe('@gpu the menus respond when you do the obvious thing', () => {
  test.setTimeout(300_000)

  test('DEV-299/300/301: the pause plate answers a tap, holds still, and takes a click', async ({
    page,
  }) => {
    await page.goto(`/?autopilot=1&${PIN}`)
    // Pointer Lock is refused on an UNFOCUSED document — `input/look.ts` says
    // so at the request — and a headed run with several windows open has only
    // one of them focused. A player always has the window they are playing in.
    await page.bringToFront()
    await firstPress(page)
    await missionReady(page)
    // The capture, which is also the first half of DEV-301's rule: this click
    // buys the pointer and presses nothing. Enter launches, below.
    await clickCanvas(page)
    expect(await pointerIsLocked(page), 'the mouse is the neck now').toBe(true)
    await hold(page, 'Enter')
    // Wait for the run to be genuinely under way rather than for a fixed time:
    // the elevator ride skips `stepFixed`, so a fixed wait can land mid-lift.
    await expect
      .poll(async () => elapsed(page), { timeout: 90_000, intervals: [500] })
      .toBeGreaterThan(2)

    await hold(page, 'Backspace')
    const opened = await plate(page)
    expect(opened.open, 'the plate is up').toBe(true)
    expect(opened.selected, 'and it opens on RESUME').toBe(0)
    expect(opened.rows, 'with rows to walk').toBeGreaterThan(2)
    const lastRow = Math.min(3, opened.rows - 1)

    // ── #39: short taps, one row each ────────────────────────────────────
    await watchTaps(page, 'ArrowDown')
    for (let i = 0; i < lastRow; i++) await tap(page, 'ArrowDown')
    await page.waitForTimeout(250)
    const down = await tapTimings(page)
    // Stated out loud rather than assumed. If a slow harness stretched these
    // taps past the ~90 ms the old ramped axis needed, this spec would pass for
    // the wrong reason — so the precondition fails loudly instead of passing
    // quietly. `menu-tap.test.ts` owns the duration sweep with exact control.
    expect(down.count, 'every tap reached the page').toBe(lastRow)
    expect(
      down.hold,
      `each tap was under the ~90 ms the ramped axis needed (longest ${down.hold.toFixed(0)} ms)`,
    ).toBeLessThan(90)
    expect(
      (await plate(page)).selected,
      `${lastRow} taps of ${down.hold.toFixed(0)} ms, gaps of ${down.gap.toFixed(0)} ms`,
    ).toBe(lastRow)
    // Printed, like the receipts the terrain and shade passes print: the
    // numbers are the evidence, and an assertion message is only visible when
    // it fails. A run that passes should still say what it measured.
    console.info(
      `DEV-299: ${lastRow} taps — longest ${down.hold.toFixed(0)} ms in the page, ` +
        `shortest gap ${down.gap.toFixed(0)} ms — walked to row ${lastRow}`,
    )

    // ── #38: the view does not drift while the plate is up ───────────────
    //
    // Look somewhere first — a centred view cannot drift, so measuring one
    // would be a claim about nothing. The mouse is captured, so this is the
    // real control and not a synthesised event. 240 px of yaw and 72 of pitch
    // is 0.6 rad and 0.18 rad, both well inside the free look's own clamps, so
    // the drag back below is exact.
    const glide = tracker(await canvasCentre(page))
    const centred = await headQuat(page)
    await glide(page, 240, 72)
    const aimedAt = await headQuat(page)
    expect(between(centred, aimedAt), 'the mouse moved the view').toBeGreaterThan(5)
    // Five times `FREE_LOOK_HOLD`, and sixteen time constants. Anything that
    // decayed at all would be gone.
    await page.waitForTimeout(3_000)
    const stillAimed = await headQuat(page)
    const drift = between(aimedAt, stillAimed)
    expect(drift, `the view stayed where it was put (moved ${drift.toFixed(2)}°)`).toBeLessThan(0.5)
    expect((await plate(page)).open, 'and the plate is still up').toBe(true)
    console.info(
      `DEV-300: aimed ${between(centred, aimedAt).toFixed(1)}° off centre, ` +
        `drifted ${drift.toFixed(2)}° over 3 s with the plate up`,
    )

    // Put the aim back where it started, so the gaze is off the rows again and
    // the selection below is the TAPS' choice rather than whatever the drag
    // happened to be pointing at. The plate hangs so that a ray along the eye
    // line lands in the title band — `render/pause.ts`'s `PANEL_DROP` — which
    // is what makes that true.
    await glide(page, -240, -72)
    expect(between(await headQuat(page), centred), 'the drag is undone').toBeLessThan(1)

    // ── #37: a click commits the aimed row ───────────────────────────────
    //
    // Walked back to RESUME, which is the one row whose outcome is unambiguous
    // from outside: the plate closes. A press is the only thing that can
    // produce that, and it is the same `confirm` the A button rides.
    for (let i = 0; i < lastRow; i++) await tap(page, 'ArrowUp')
    await page.waitForTimeout(250)
    const onResume = await plate(page)
    expect(onResume.selected, 'ArrowUp walks back up, a row a tap').toBe(0)
    expect(onResume.open).toBe(true)
    // In place: a click that moved the mouse first would swing the gaze, and
    // the gaze picks the row. See `clickInPlace`.
    await clickInPlace(page)
    await page.waitForTimeout(400)
    expect((await plate(page)).open, 'the click chose RESUME and the plate is gone').toBe(false)

    // And the free look behaves exactly as it always did once the menu is not
    // up: the SAME stillness brings the view back. Without this the claim above
    // is equally true of a build with no free look at all.
    await glide(page, 240, 72)
    expect(between(centred, await headQuat(page)), 'looked away again').toBeGreaterThan(5)
    await page.waitForTimeout(3_000)
    const recentred = between(await headQuat(page), STRAIGHT_AHEAD)
    expect(
      recentred,
      `unpaused, the same stillness recentres (${recentred.toFixed(2)}°)`,
    ).toBeLessThan(1)
    console.info(
      `DEV-300 control: unpaused, the same 3 s of stillness left ${recentred.toFixed(2)}°`,
    )
  })

  // ── The title (DEV-418, which replaces DEV-301's #35 test) ───────────────
  //
  // DEV-301 pinned "the title never takes the pointer", because the title threw
  // `look` away and a capture there bought nothing. Matt, 2026-09-26: *"title-
  // screen: enable look just like the other menus"*. So the capture has a
  // consumer now, and the three tests below are the hangar's rule on the
  // title, plus the one thing the hangar does not have: rows a CURSOR can click.

  test('DEV-418: on the title a click on the WORLD takes the pointer, turns the view, and presses nothing', async ({
    page,
  }) => {
    const rows = await toTheTitle(page)
    const box = await page.locator(CANVAS).boundingBox()
    if (!box) throw new Error('no canvas')
    // High on the glass: the monument and the sky. The rows hang in the lower
    // half (`rowsAt`), so this is a point on the WORLD, not on a row.
    const at = { x: box.x + box.width / 2, y: box.y + box.height * 0.2 }
    expect(
      Math.min(...(rows.rowsAt ?? []).map((r) => r.y)),
      'the rows are below it',
    ).toBeGreaterThan(at.y + 40)
    const resting = await headQuat(page)

    await page.mouse.click(at.x, at.y)
    await expect.poll(() => pointerIsLocked(page), { timeout: 5_000 }).toBe(true)
    await page.waitForTimeout(600)
    expect(await titleUp(page), 'the capture pressed nothing: still on the title').toBe(true)

    // A look, with the captured mouse: 200 px right is 0.5 rad at
    // `MOUSE_SENSITIVITY`, about 29 degrees.
    const glide = tracker(at)
    await glide(page, 200, 0)
    const turned = between(resting, await headQuat(page))
    console.info(`DEV-418: a 200 px glide on the title turned the view ${turned.toFixed(1)}°`)
    expect(turned, 'the title looks around').toBeGreaterThan(15)
    expect(await titleUp(page), 'and looking is not leaving').toBe(true)
  })

  test('DEV-418: a CURSOR click on a row still presses that row, in one click, taking nothing', async ({
    page,
  }) => {
    // The press that leaves the title is not eaten by the capture: DEV-353's
    // rows are clickable with the cursor, and a click ON one is a press of it.
    // DEV-558: the title is one page, START (the hangar row) and ENTER VR.
    const rows = await toTheTitle(page)
    const hangarRow = rows.rowsAt?.[rows.rows.indexOf('hangar')]
    expect(hangarRow, 'the hangar row is on screen').toBeDefined()
    if (!hangarRow) return
    await page.mouse.click(hangarRow.x, hangarRow.y)
    await page.waitForTimeout(300)
    expect(await pointerIsLocked(page), 'a click on a row is not a capture').toBe(false)
    await expect.poll(() => titleUp(page), { timeout: 10_000 }).toBe(false)
  })

  test('DEV-418: captured on the title, the NOSE picks a row and a click presses it', async ({
    page,
  }) => {
    // The hangar's model whole: look at it, click. ENTER VR (DEV-558: the
    // title is START and ENTER VR), because it is not the row a press takes by
    // default: a click that pressed the highlighted row without the nose would
    // go to the hangar instead. Under `xr=off` ENTER VR asks nothing, so the
    // proof is the title still up after the click.
    const rows = await toTheTitle(page)
    const want = rows.rows.indexOf('enter-vr')
    expect(want, 'ENTER VR is a title row').toBeGreaterThan(0)
    expect(rows.selected, 'and not the one a press takes today').not.toBe(want)
    const box = await page.locator(CANVAS).boundingBox()
    if (!box) throw new Error('no canvas')
    const at = { x: box.x + box.width / 2, y: box.y + box.height * 0.2 }
    await page.mouse.click(at.x, at.y)
    await expect.poll(() => pointerIsLocked(page), { timeout: 5_000 }).toBe(true)

    // Look DOWN until the nose is on it. The rows are below the resting view,
    // and the first row the nose meets is the hangar's, so `selected` only
    // reaches ENTER VR by the nose travelling onto it.
    const glide = tracker(at)
    let on = false
    for (let i = 0; i < 90 && !on; i++) {
      await glide(page, 0, 6)
      on = (await titleMenuProbe(page)).selected === want
    }
    // The precondition, out loud. Chrome gives the pointer back when the window
    // loses focus, and two headed workers take it from each other; without this
    // line that reads as "the nose never reached the row" (the DEV-301 row has
    // the same trap from the other side).
    const pitched = between(STRAIGHT_AHEAD, await headQuat(page))
    console.info(`DEV-418: the nose looked ${pitched.toFixed(1)}° down to reach the row: ${on}`)
    expect(await pointerIsLocked(page), 'the capture held through the look').toBe(true)
    expect(on, 'the nose reached the ENTER VR row').toBe(true)

    await clickInPlace(page)
    await page.waitForTimeout(1_500)
    expect(await titleUp(page), 'the click pressed ENTER VR, not START: still on the title').toBe(
      true,
    )
    expect((await titleMenuProbe(page)).selected, 'and the aim stayed on it').toBe(want)
  })

  test('DEV-301 #36, DEV-604: in the hangar a click ON a table presses it; a click on the room captures and presses nothing; the next one does', async ({
    page,
  }) => {
    // Both halves of the rule, on the screen where getting it wrong would cost
    // something: a click that boarded a course the player had not chosen.
    await page.goto(`/?title=0&${PIN}`)
    // Pointer Lock is refused on an UNFOCUSED document — `input/look.ts` says
    // so at the request — and a headed run with several windows open has only
    // one of them focused. A player always has the window they are playing in.
    await page.bringToFront()
    await firstPress(page)
    await missionReady(page)
    await page.waitForTimeout(1_500)

    // DEV-558: the room opens on its doors. DEV-565: four of them on this
    // (preview) build, laid centred, so the resting pointer falls between
    // Quick Race and Multiplayer and aims nothing; the seat turns to
    // SINGLE PLAYER first (by the keyboard, before any capture), as a player
    // looks at the table they mean to click. Not Multiplayer: its first table
    // would host a room, which needs the rooms server.
    expect(await lookUntilAimed(page, 'single-player'), 'found Single Player').toBe(true)
    const resting = await hangar(page)
    expect(resting.kind, 'the pointer is on a holotable').toBe('door')

    // DEV-604: the free cursor's click ON the table under it presses it, as on
    // the title's rows (DEV-418), and does not take the pointer.
    await clickCanvas(page)
    await page.waitForTimeout(600)
    const pressed = await hangar(page)
    expect(await pointerIsLocked(page), 'a click on a table is a press, not a capture').toBe(false)
    expect(pressed.view, 'and it stepped into the aircraft').not.toBe(resting.view)

    // The capture. A click on the bare room (its roof) is DEV-301's: it takes
    // the pointer and selects nothing, wherever the gaze is resting.
    const before = await hangar(page)
    await clickBareRoom(page)
    expect(await pointerIsLocked(page), 'it took the pointer').toBe(true)
    expect((await hangar(page)).view, 'and stepped into nothing').toBe(before.view)

    // The next one is the neck clicking, and it does what A does: the gaze rests
    // on an aircraft (DEV-606 rests the seat on a new step), and it opens it.
    // In place: under the capture a move is a LOOK (`clickInPlace`), and a
    // click that first travelled from the roof to the centre looked 40 degrees
    // down on the frame the step changed, so the new step opened that far off
    // rest and the re-capture's roof below landed on a VARIANT table.
    await clickInPlace(page)
    await page.waitForTimeout(600)
    const stepped = await hangar(page)
    expect(stepped.view, 'a captured click presses, exactly as Enter does').not.toBe(before.view)

    // Escape is a player pressing Escape, and coming back is a capture like the
    // first one — so it presses nothing either.
    await releasePointer(page)
    expect(await pointerIsLocked(page), 'the pointer is free').toBe(false)
    await clickBareRoom(page)
    expect(await pointerIsLocked(page), 're-captured').toBe(true)
    expect((await hangar(page)).view, 'and the re-capture stepped into nothing').toBe(stepped.view)
  })
})
