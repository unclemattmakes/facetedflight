/**
 * The whole loop: title -> hangar -> mission -> back to the hangar.
 *
 * Every screen has its own spec, and each one proves its own claim. This proves
 * the thing none of them can: that the four screens HAND OVER to each other,
 * and that each one brings up exactly its own furniture and puts away everyone
 * else's. Those are two different failures and both are invisible from inside a
 * single screen.
 *
 * The title screen's monument is `title-screen`, not `title` — 2016's logo mesh
 * has a submesh called `title`, and a traverse looking for the screen found the
 * wordmark instead. Three's `visible` is not inherited by a child's own
 * property, so two specs passed a hidden screen as a visible one.
 */

import { bootReady, switchSettled } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { aimAtCourse, throughVariants } from './fixtures/hangar'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { pressPauseRow } from './fixtures/pause-menu'
import { expect, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

interface Beat {
  vis: Record<string, boolean>
  /**
   * Is the room you SIT in on screen?
   *
   * Asked of `__ff2.stage()` — the scene actually being rendered — and not of
   * the mission scene, because since DEV-076 the menu is its own `THREE.Scene`
   * and the level select is not in `render.scene` at all. This used to traverse
   * the mission scene for `hangar`, where the only object of that name is the
   * LAUNCH room at the base of the shaft, which nothing ever hid. So it was
   * asserting that a room had been BUILT — true in the cockpit too — and it went
   * on passing for the wrong reason until the launch room learned to hide
   * itself. `completion.spec.ts`'s probe warns about exactly this. DEV-094.
   */
  room: boolean
  elapsed: number
  rings: string | undefined
}

const PANELS = ['title-screen', 'hud', 'briefing', 'pause', 'results']

const beat = async (page: import('@playwright/test').Page): Promise<Beat> =>
  (await page.evaluate((names: string[]) => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    const vis: Record<string, boolean> = {}
    for (const n of names) vis[n] = false
    w.__ff2?.render.scene.traverse((o) => {
      if (o.name && names.includes(o.name)) vis[o.name] = o.visible === true
    })
    let room = false
    w.__ff2?.stage().traverse((o) => {
      if (o.name === 'hangar') room = room || o.visible === true
    })
    return {
      vis,
      room,
      elapsed: Number((w.__ff2?.mission.elapsed ?? 0).toFixed(1)),
      rings: document.body.dataset.rings,
    }
  }, PANELS)) as Beat

/**
 * Held, not tapped. Every confirm in this game is a LEVEL read once a frame, so
 * a press that lands between two frames is a press nothing saw — `lap.spec.ts`
 * and `pause.spec.ts` both carry the same note.
 */
const hold = (page: import('@playwright/test').Page, key: string): Promise<void> =>
  keysHold(page, key, { down: 200, settle: 300 })

/**
 * Which step of the level select the room is on: 'vehicles', 'modes', 'ranks'
 * or 'courses'. Four since DEV-203.
 */
const view = async (page: import('@playwright/test').Page): Promise<string | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()?.view ?? null)

/** The steps this room walks (DEV-382): five on Anniversary, 2016's four on Classic. */
const views = async (page: import('@playwright/test').Page): Promise<readonly string[]> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()?.views ?? [])

/**
 * The WHOLE aim, so a step can be aimed at a named thing and not merely at a
 * kind. Matched by a substring of its JSON rather than by reaching into a shape
 * this spec would then have to track: the ids, modes and difficulties are all
 * distinct strings, and a quoted match cannot collide `beginner` with anything
 * else on the arc.
 */
const aimOf = async (page: import('@playwright/test').Page): Promise<{ kind: string } | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()?.aim ?? null)

/**
 * Turn the seat until a table of `kind` is under the pointer, sweeping BOTH
 * ways, then press.
 *
 * ── Why the aiming, which this walk did not used to need (DEV-203) ──────
 *
 * Matt: *"these should be fixed, not randomly placed as they are now."* The arc
 * used to rotate so the option you arrived in sat under the resting pointer, so
 * a walk could press blind. Nothing rotates now, and a step's resting position
 * can be legitimately EMPTY — the flight-plan arc has one position per mode the
 * game has and the HoverJet flies two of three. A press there does nothing, on
 * purpose, and a player looks one table over. So does this.
 *
 * ── And `want`, which is not optional politeness ─────────────────────────
 *
 * A sweep with no target takes **whatever it reaches first**, and the sweep goes
 * right before it goes left. Under DEV-203's fixed slots the first aimable
 * flight plan to the right of the HoverJet's resting position is **Free
 * Flight**, not Ring Attack — so this walk silently stopped testing a race and
 * started testing the Kauai bonus level, proved by probe: every step landed,
 * and the mission it boarded was `hoverJet_kauai_beg`. Every assertion below is
 * written about a RACE — a briefing, a lift, a countdown, a clock that starts —
 * so the spec was describing one mission and flying another.
 *
 * That is the failure this whole spec exists to catch, turned on the spec
 * itself: **an instrument that agrees with itself.** `completion.spec.ts`'s
 * `pickAndBoard` was given an explicit target for the same reason on the same
 * day; this walk was not, and it is the one that found out why.
 */
const stepInto = async (
  page: import('@playwright/test').Page,
  kind: string,
  want?: string,
  steps = 32,
): Promise<boolean> => {
  const on = async () => {
    const aim = await aimOf(page)
    if (aim?.kind !== kind) return false
    if (want === undefined) return true
    return JSON.stringify(aim).includes(`"${want}"`)
  }
  for (const key of ['KeyD', 'KeyA'] as const) {
    for (let i = 0; i < (key === 'KeyA' ? steps * 2 : steps); i++) {
      if (await on()) break
      await page.keyboard.down(key)
      await page.waitForTimeout(80)
      await page.keyboard.up(key)
      await page.waitForTimeout(80)
    }
    if (await on()) break
  }
  if (!(await on())) return false
  await hold(page, 'Enter')
  return true
}

test.describe('@gpu the whole loop', () => {
  test.setTimeout(600_000)

  test('title -> hangar -> mission -> hangar', async ({ page }) => {
    await page.goto('/?xr=off')
    await firstPress(page)
    // `bootReady`, not `data-terrain-ready`: this URL boots the TITLE screen,
    // and since DEV-281 that builds no mission world. See `fixtures/boot.ts`.
    await bootReady(page, 180_000)
    // `dropFocus`, not `focusCanvas`: since DEV-301 a click on the TITLE is a
    // real press and starts the game, because the title never captures the
    // pointer and so has no capture to spend the click on. This walk has to
    // arrive at the title and stay there. `fixtures/canvas.ts` has the rule.
    await dropFocus(page)
    await page.waitForTimeout(2_000)

    // ── 1. the title ─────────────────────────────────────────────────────
    const title = await beat(page)
    expect(title.vis['title-screen'], 'the monument is up').toBe(true)
    for (const cockpit of ['hud', 'briefing', 'pause', 'results']) {
      expect(title.vis[cockpit], `${cockpit} is not on the title screen`).toBe(false)
    }
    expect(title.elapsed, 'the clock has not started').toBe(0)

    // ── 2. press A: the hangar ───────────────────────────────────────────
    //
    // Behind 2016's menu fade since DEV-427: the room comes up on the black
    // frame, about 0.64 s after the press, and this file's `hold` returns at
    // 0.5 s. So wait for the room, as a player does.
    await pressTitleRow(page, TITLE_ROW.hangar) // DEV-441: Single Player, then Hangar
    await expect.poll(async () => (await beat(page)).room, { timeout: 10_000 }).toBe(true)
    const hangar = await beat(page)
    expect(hangar.vis['title-screen'], 'the monument is gone').toBe(false)
    expect(hangar.room, 'the room is up').toBe(true)
    // Still no cockpit: you are in the chair, not the ship (DEV-036).
    for (const cockpit of ['hud', 'briefing', 'pause', 'results']) {
      expect(hangar.vis[cockpit], `${cockpit} is not in the hangar`).toBe(false)
    }
    expect(hangar.elapsed).toBe(0)

    // ── 2b. the room's FIRST step: SINGLE PLAYER (DEV-558) ───────────────
    //
    // Matt, 2026-10-01: *"Clicking either should take us to the Hangar, where
    // the first set of choices are: Single Player / Multiplayer / FFTV"*. A
    // door is not a mission either.
    expect(await view(page), 'the room opens on its doors').toBe('doors')
    expect(await stepInto(page, 'door', 'single-player'), 'found Single Player').toBe(true)
    expect((await beat(page)).vis.hud, 'a door is not a mission').toBe(false)
    expect(await view(page), 'Single Player opens the aircraft').toBe('vehicles')

    // ── 3. press A on the AIRCRAFT: its flight plans ─────────────────────
    //
    // The level select is FOUR steps, as 2016's was: `MenuManager` pages ship
    // -> mode -> rank -> challenge and `ChallengeSelection()` dispatches on all
    // three axes (DEV-105, DEV-203). Matt, from the headset: **"free flight
    // should be a mode. so aircraft > mode > difficulty > location."**
    //
    // None of these presses may board, which is what the assertions here are —
    // and since DEV-203 that is guaranteed by the STRUCTURE rather than by
    // three careful assertions: `choose()` returns null for anything but a
    // course, and a course only exists on the fourth step.
    expect(await stepInto(page, 'vehicle', 'hoverjet'), 'found the HoverJet').toBe(true)
    // ── 3b. on Anniversary, the aircraft's VARIANT (DEV-382) ─────────────
    //
    // Matt, 2026-09-24: *"a new selection after the aircraft type."* Standard
    // is 2016's machine and stands under the resting pointer. Classic's room
    // walks 2016's four and has no such step, which the room's own list says.
    if ((await views(page)).includes('variants')) {
      const variants = await beat(page)
      expect(variants.room, 'still in the room').toBe(true)
      expect(variants.vis.hud, 'an aircraft is not a mission').toBe(false)
      // By its id, exactly: a variant's JSON carries every bar's `standard`
      // value too, so `stepInto`'s substring match could take any table.
      await throughVariants(page, 'standard')
    }
    const modes = await beat(page)
    expect(modes.room, 'still in the room').toBe(true)
    expect(modes.vis.hud, 'an aircraft is not a mission — nothing has been boarded').toBe(false)
    expect(await view(page), 'the second step is up').toBe('modes')

    // ── 4. press A on the FLIGHT PLAN: Ring Attack's places ───────────────
    //
    // DEV-420 (Matt, 2026-09-26: *"ring attack > terrain"*): no rank page.
    // Each place's table carries its difficulty as a column of ski-map marks,
    // and LOOKING at a mark picks that course; the press boards it.
    expect(await stepInto(page, 'mode', 'ringAttack'), 'found Ring Attack').toBe(true)
    const courses = await beat(page)
    expect(courses.room, 'still in the room').toBe(true)
    expect(courses.vis.hud, 'a flight plan is not a mission either').toBe(false)
    expect(await view(page), 'the places are up, with no rank step between').toBe('courses')

    // ── 5. look at int_01's mark on the Simonet table, press A: aboard ────
    expect(await aimAtCourse(page, 'int_01_hoverJet'), 'found int_01_hoverJet').toBe(true)
    await hold(page, 'Enter')
    // And WAIT for it. Since DEV-281 that press is the load — boot built the
    // title valley and nothing else — so "the HUD is up" a beat later is a
    // question about a ship that is still being assembled. `data-switching` is
    // set synchronously at the press and cleared when the swap finishes; the
    // pair is what `fixtures/hangar.ts` waits on too.
    await switchSettled(page, 240_000)
    const pad = await beat(page)
    expect(pad.vis.hud, 'the HUD is up').toBe(true)
    expect(pad.vis.briefing, "and 2016's briefing with it").toBe(true)
    // Four presses, not one: the aircraft, the plan, the course (its rank is a
    // mark on the place, DEV-420), then
    // the lift — 2016's shape (`_ui-flow.md` sections 2, 4 and 5) less its rank
    // page. The variant step adds one on Anniversary.
    expect(pad.elapsed, 'the race has NOT started yet').toBe(0)

    // ── 7. press A again: the lift, the countdown, the run ───────────────
    await hold(page, 'Enter')
    await expect
      .poll(async () => (await beat(page)).elapsed, { timeout: 90_000, intervals: [500] })
      .toBeGreaterThan(3)
    const flying = await beat(page)
    expect(flying.vis.hud).toBe(true)
    expect(flying.vis.briefing, 'the briefing is down once you are flying').toBe(false)

    // ── 8. Backspace: paused, and the clock STOPS ────────────────────────
    await hold(page, 'Backspace')
    const paused = await beat(page)
    expect(paused.vis.pause, 'the menu is up').toBe(true)
    expect(paused.vis.hud, 'and the HUD is down under it').toBe(false)
    await page.waitForTimeout(2_500)
    // DEV-033: 2016's pause does not stop its race timer. Ours does.
    expect((await beat(page)).elapsed, 'frozen').toBeCloseTo(paused.elapsed, 3)

    // ── 9. EXIT, by name, and take it ─────────────────────────────────────
    //
    // This pressed down exactly twice when the pause menu had three rows, then
    // saturated with twelve; DEV-621 put the plate in pages, and a count of
    // presses is a POSITION where the code guarantees a NAME. The walk is
    // computed from `__ff2.pausePlate()` (`fixtures/pause-menu.ts`).
    await pressPauseRow(page, 'exit')
    await page.waitForTimeout(1_200)

    const back = await beat(page)
    expect(back.vis.pause, 'the menu is gone').toBe(false)
    expect(back.vis.hud, 'and so is the cockpit').toBe(false)
    // The run is RESET on the way out, not left half-flown: a mission you
    // return to mid-flight with a stopped clock is a state no other path can
    // produce.
    expect(back.elapsed, 'the clock is back to zero').toBe(0)
    expect(back.rings, 'and so is the score').toBe('0/21')
  })
})
