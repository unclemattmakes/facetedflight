/**
 * Walking the level select, for specs that only need to GET AIRBOARD.
 *
 * ── Why this exists, which is a defect report ────────────────────────────
 *
 * DEV-203 made the hangar's tables sit in fixed identity slots instead of
 * rotating the wanted one under the resting pointer. Matt, from the headset:
 * *"these should be fixed, not randomly placed as they are now."* Every spec
 * that boarded by pressing A three times had been leaning on that rotation
 * WITHOUT SAYING SO, and each of them broke in its own way — a sweep that took
 * the first thing it reached and boarded another environment, a walk that
 * pressed four times blind, two yaw sweeps centred on their own start.
 *
 * Five were fixed the night DEV-203 landed. The e2e run that cleared it was
 * FILTERED to the five specs the menu change was known to touch, so
 * `briefing.spec.ts` and `fade.spec.ts` stayed red for a day and nobody saw:
 * **CI runs `pnpm check` and not Playwright** (`.github/workflows/`), so a red
 * e2e spec is visible to whoever chooses to run that file and to nobody else.
 * A shared walk is the part of that which can be fixed in code — one place to
 * update the next time the menu's shape changes, instead of one per spec plus
 * the hope that somebody runs them all.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────
 *
 * `completion.spec.ts` and `walkthrough.spec.ts` keep their own walks, and that
 * is not an oversight to tidy away. Those two are ABOUT the level select — they
 * assert the step's shape as they descend it, which is the thing under test —
 * while everything here treats the menu as a corridor to the cockpit. Folding
 * them in would put assertions about the menu inside a helper whose callers do
 * not care about the menu, and the first spec to need a slightly different
 * assertion would fork it again.
 */

import { expect, type Page } from '@playwright/test'
import { switchSettled } from './boot'
import type { Ff2GlobalMaybe } from './ff2'
import { hold as keysHold } from './keys'

/**
 * Held, not tapped.
 *
 * Every confirm in this game is a LEVEL read once a frame, so a press that
 * lands between two frames is a press nothing saw. `lap.spec.ts`,
 * `pause.spec.ts` and `walkthrough.spec.ts` all carry the same note; it has
 * cost a run each time somebody reached for `page.keyboard.press`.
 */
export const hold = (page: Page, key: string, settle = 600): Promise<void> =>
  keysHold(page, key, { down: 200, settle })

/** The step that is up, and the name of the table under the pointer. */
export interface HangarAim {
  readonly view: string
  /**
   * The screen the app is on (DEV-558). The room lays its first step at boot,
   * under the title, so `view` alone does not say a press reaches the room.
   */
  readonly screen: string
  /**
   * The steps this room walks, in order: the room's own list (DEV-382). Five
   * on Anniversary, whose aircraft ask for a VARIANT before the plan; 2016's
   * four on Classic. Read off the page, never assumed from the edition.
   */
  readonly views: readonly string[]
  /**
   * One name per kind of table — an aircraft key, a mode key, a rank key or a
   * mission id — so one search works on every step. Null where the pointer
   * rests on a position nothing owns, which since DEV-203 is a real state and
   * not a bug: an arc is as wide as the KEYS the content offers, and a step
   * whose content does not fill it draws dead plates in the gaps.
   */
  readonly aimName: string | null
  /**
   * DEV-420: on a PLACE table — Ring Attack's last step, whose table carries
   * its difficulty — the ids of every course on that place, top of the column
   * first; null anywhere else. The table's own `aimName` is the course it has
   * PICKED, so a place holding the course you want is found by this, and the
   * course itself by looking at its mark ({@link aimAtMark}).
   */
  readonly place: readonly string[] | null
  /** DEV-420: the pointer is on a difficulty MARK, not on the table under it. */
  readonly mark: boolean
}

export const hangarAim = async (page: Page): Promise<HangarAim | null> =>
  page.evaluate(() => {
    const h = (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()
    if (!h) return null
    const a = h.aim
    return {
      view: h.view,
      screen: h.screen,
      views: h.views,
      place: a?.kind === 'mission' && a.place ? a.place.courses.map((c) => c.id) : null,
      mark: a?.kind === 'mission' && a.mark === true,
      aimName:
        // DEV-558: a door table (the first step, or Multiplayer's) by its id.
        a?.kind === 'door'
          ? (a.door?.id ?? null)
          : a?.kind === 'vehicle'
            ? (a.vehicle?.vehicle ?? null)
            : a?.kind === 'variant'
              ? (a.variant?.id ?? null)
              : a?.kind === 'mode'
                ? (a.mode?.mode ?? null)
                : a?.kind === 'rank'
                  ? (a.rank?.difficulty ?? null)
                  : a?.kind === 'mission'
                    ? (a.mission?.id ?? null)
                    : null,
    }
  })

/**
 * Turn the seat until `name` is the thing under the pointer — right, then twice
 * as far left.
 *
 * `KeyD` turns the seat right and `KeyA` left; `mouse-look.spec.ts` pins those
 * directions against the pad's own stick, so nothing here asserts a sign.
 *
 * BOTH ways, and the second sweep is twice the budget because the first has
 * already spent one arc's worth going the wrong way. The arc is 90 degrees
 * inside a 360-degree room, so from a table at one end, one direction is 270
 * degrees of empty room before the table you wanted. A notch is about 3.7
 * degrees on the ranks step, which is where the 32 comes from — an arc and a
 * half.
 */
export const lookUntilAimed = async (page: Page, name: string, steps = 32): Promise<boolean> =>
  lookUntil(page, (at) => at?.aimName === name, steps)

/**
 * How far either side of where it started a sweep reaches, in radians: 100
 * degrees, which covers the whole arc (its farthest table is 60 degrees from
 * the resting pointer) from wherever on it the seat stands.
 */
const SWEEP_REACH = (100 * Math.PI) / 180

/** A quiet notch is about 3.7 degrees; one past this (20 degrees) was a stalled frame, not a turn. */
const NOTCH_JUMP = (20 * Math.PI) / 180

/**
 * {@link lookUntilAimed}'s sweep, for any test of the aim.
 *
 * Measured by ANGLE, not by notch count (DEV-558). The seat turns by the
 * frame's clamped time, so on a loaded box a notch is a fraction of its quiet
 * 3.7 degrees, and a sweep counted in notches stopped short of a table 30
 * degrees off (SINGLE PLAYER, from MULTIPLAYER under the resting pointer) while
 * the same sweep alone reached it. Right until {@link SWEEP_REACH}, then left
 * until as far the other side. `steps` still bounds the notches, at four times
 * the quiet count, so a seat that does not turn ends the sweep.
 */
export const lookUntil = async (
  page: Page,
  done: (at: HangarAim | null) => boolean,
  steps = 32,
): Promise<boolean> => {
  const on = async () => done(await hangarAim(page))
  const start = await cameraYaw(page)
  const off = async (): Promise<number> => {
    const now = await cameraYaw(page)
    return start === null || now === null
      ? 0
      : Math.atan2(Math.sin(now - start), Math.cos(now - start))
  }
  let side = 0
  for (const key of ['KeyD', 'KeyA'] as const) {
    const budget = (key === 'KeyA' ? steps * 2 : steps) * 4
    for (let i = 0; i < budget; i++) {
      if (await on()) return true
      const o = await off()
      // The first leg ends at the reach, on whichever side KeyD went; the
      // second at the reach on the OTHER side. Without a yaw to read, the
      // notch count alone, as before.
      if (
        start === null
          ? i >= budget / 4
          : key === 'KeyD'
            ? Math.abs(o) >= SWEEP_REACH
            : o * side <= -SWEEP_REACH
      )
        break
      const before = await cameraYaw(page)
      await nudgeSeat(page, key)
      await page.waitForTimeout(80)
      // A held key turns the seat by the frame's time. A frame that stalls for
      // a second or two (three specs on one GPU) carries one notch through
      // radians, clean over a table's window: measured at 143 degrees in one
      // notch, with Flight School between. The sweep is for finding a table,
      // not for covering ground, so a notch that overshot is turned back to
      // where it started (closed loop, short holds) and the sweep goes on.
      const after = await cameraYaw(page)
      if (
        before !== null &&
        after !== null &&
        Math.abs(Math.atan2(Math.sin(after - before), Math.cos(after - before))) > NOTCH_JUMP
      ) {
        await turnSeatTo(page, before)
      }
    }
    if (key === 'KeyD') side = Math.sign(await off()) || 1
  }
  return on()
}

/**
 * One notch of the seat: `key` held for 80 ms, and then on until the seat has
 * actually TURNED (up to half a second more).
 *
 * The room reads a held key once a frame (`seatLookYaw += look.yaw`), so a tap
 * that goes down and up between two frames turns nothing. On a quiet box that
 * never happens; under four Playwright workers a frame can outlast the tap,
 * and a sweep of blank notches ends a table short. Holding until the yaw moves
 * is the player's own move (you hold the key until the chair turns), and it
 * gives every notch at least one frame. A notch can then be a little longer
 * than one 80 ms frame's worth, never shorter.
 */
const nudgeSeat = async (page: Page, key: 'KeyD' | 'KeyA'): Promise<void> => {
  const from = await cameraYaw(page)
  await page.keyboard.down(key)
  await page.waitForTimeout(80)
  for (let t = 0; t < 20 && from !== null; t++) {
    const now = await cameraYaw(page)
    if (now === null || Math.abs(Math.atan2(Math.sin(now - from), Math.cos(now - from))) > 0.005)
      break
    await page.waitForTimeout(25)
  }
  await page.keyboard.up(key)
}

/**
 * Where the difficulty mark that picks `missionId` is, from the eye: yaw right
 * and pitch up to it, in radians, and whether it is drawn. Null where no mark
 * for it is in the room. Read off the scene — the mark is an object with a
 * name and the course's id — the way `menu-light-compile.spec.ts` reads a lap
 * plate's.
 */
const markError = async (
  page: Page,
  missionId: string,
): Promise<{ dYaw: number; dPitch: number } | null> =>
  page.evaluate((id: string) => {
    interface Node {
      name: string
      visible: boolean
      parent: Node | null
      userData: { missionId?: string }
      matrixWorld: { elements: number[] }
      updateWorldMatrix: (a: boolean, b: boolean) => void
      traverse: (fn: (o: Node) => void) => void
    }
    const ff = (globalThis as unknown as Ff2GlobalMaybe).__ff2
    if (!ff) return null
    let found: Node | null = null
    ff.stage().traverse((o) => {
      if (o.name !== 'difficulty-mark' || o.userData.missionId !== id) return
      for (let n: Node | null = o; n; n = n.parent) if (!n.visible) return
      found = o
    })
    if (!found) return null
    const mark = found as Node
    mark.updateWorldMatrix(true, false)
    const cam = ff.render.camera
    cam.updateWorldMatrix(true, false)
    const m = cam.matrixWorld.elements
    const p = mark.matrixWorld.elements
    // A camera looks down its own -z, so its forward is the negated third axis.
    const fwd = [-(m[8] ?? 0), -(m[9] ?? 0), -(m[10] ?? 0)]
    const to = [
      (p[12] ?? 0) - (m[12] ?? 0),
      (p[13] ?? 0) - (m[13] ?? 0),
      (p[14] ?? 0) - (m[14] ?? 0),
    ]
    const yawOf = (v: number[]) => Math.atan2(v[0] ?? 0, -(v[2] ?? 0))
    const pitchOf = (v: number[]) => {
      const l = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0) || 1
      return Math.asin(Math.min(1, Math.max(-1, (v[1] ?? 0) / l)))
    }
    const d = yawOf(to) - yawOf(fwd)
    return { dYaw: Math.atan2(Math.sin(d), Math.cos(d)), dPitch: pitchOf(to) - pitchOf(fwd) }
  }, missionId)

/**
 * Look at the difficulty mark that picks `missionId` (DEV-420), as a player
 * does: turn toward it and raise the eyes to it. True once it is under the
 * pointer — which is also the moment it becomes its table's pick.
 *
 * It STEERS: measure the two angles, nudge the axis with the larger error,
 * repeat. **The key directions are discovered, not asserted** — `KeyD` is
 * believed to turn right and `KeyW` to raise the view (`menu-screen.spec.ts`
 * measured that one), and each belief is flipped if a nudge made its own axis
 * worse (the orientation lesson, applied to a helper).
 */
export const aimAtMark = async (page: Page, missionId: string, budget = 80): Promise<boolean> => {
  let rightKey: 'KeyD' | 'KeyA' = 'KeyD'
  let upKey: 'KeyW' | 'KeyS' = 'KeyW'
  let previous: { axis: 'yaw' | 'pitch'; size: number } | null = null
  for (let i = 0; i < budget; i++) {
    const at = await hangarAim(page)
    if (at?.aimName === missionId && at.mark) return true
    const e = await markError(page, missionId)
    if (!e) return false
    if (previous) {
      const now = previous.axis === 'yaw' ? Math.abs(e.dYaw) : Math.abs(e.dPitch)
      if (now > previous.size) {
        if (previous.axis === 'yaw') rightKey = rightKey === 'KeyD' ? 'KeyA' : 'KeyD'
        else upKey = upKey === 'KeyW' ? 'KeyS' : 'KeyW'
      }
    }
    const axis: 'yaw' | 'pitch' = Math.abs(e.dYaw) >= Math.abs(e.dPitch) ? 'yaw' : 'pitch'
    const key =
      axis === 'yaw'
        ? e.dYaw > 0
          ? rightKey
          : rightKey === 'KeyD'
            ? 'KeyA'
            : 'KeyD'
        : e.dPitch > 0
          ? upKey
          : upKey === 'KeyW'
            ? 'KeyS'
            : 'KeyW'
    previous = { axis, size: axis === 'yaw' ? Math.abs(e.dYaw) : Math.abs(e.dPitch) }
    await page.keyboard.down(key)
    await page.waitForTimeout(45)
    await page.keyboard.up(key)
    await page.waitForTimeout(60)
  }
  const at = await hangarAim(page)
  return at?.aimName === missionId && at.mark
}

/**
 * Put the pointer on the COURSE `missionId`, on the last step, however that
 * step is laid out.
 *
 * On a course arc (2016's walk, through a rank) the course is a table: turn to
 * it. On a PLACE arc (DEV-420, Ring Attack) the course is one mark in a place
 * table's column: turn to the place that holds it, then look at its mark,
 * which picks it — a press then boards exactly it. A place whose pick already
 * IS the course is aimed on arrival, as a player would find it.
 */
export const aimAtCourse = async (page: Page, missionId: string): Promise<boolean> => {
  const found = await lookUntil(
    page,
    (at) => at?.aimName === missionId || (at?.place?.includes(missionId) ?? false),
  )
  if (!found) return false
  if ((await hangarAim(page))?.aimName === missionId) return true
  return aimAtMark(page, missionId)
}

/**
 * Through DEV-382's VARIANT step, where the room has one — for the specs that
 * walk the menu by hand rather than with {@link board}.
 *
 * On Anniversary a press on an aircraft opens its variants, and the flight
 * plans are one more press away; this aims `variant` (`standard`, under the
 * resting pointer, by default) and presses, as a player does. On Classic the
 * aircraft press already opened the plans, and this does nothing. Which build
 * it is comes off the room's own step list, never off an assumption.
 */
export const throughVariants = async (page: Page, variant = 'standard'): Promise<void> => {
  const at = await hangarAim(page)
  if (!at?.views.includes('variants')) return
  expect(at.view, 'a press on an aircraft opens its variants').toBe('variants')
  expect(await lookUntilAimed(page, variant), `found the ${variant} variant`).toBe(true)
  await hold(page, 'Enter')
}

/** DEV-558: the first step's door ids (`render/hangar-doors.ts`'s, the title rows' own). */
export const DOOR_SINGLE = 'single-player'
export const DOOR_MULTIPLAYER = 'multiplayer'
export const DOOR_TV = 'tv'
/** DEV-565: QUICK RACE, beside SINGLE PLAYER (the title's old Quick Race row's id). */
export const DOOR_QUICK_RACE = 'quick-race'
/** And Multiplayer's step's (the title's Multiplayer page's rows, moved). */
export const DOOR_HOST = 'room'
export const DOOR_JOIN_CODE = 'room-code'
export const DOOR_JOIN_LINK = 'room-join'

/** Is a screen fade still running? `__ff2.fade()`'s own word. */
const fading = (page: Page): Promise<boolean> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.fade().busy ?? false)

/**
 * Wait for the hangar to be THE SCREEN, on `view`, with its fade done.
 *
 * The screen, not only the view (DEV-558): the room lays its first step at
 * boot, under the title, so `view === 'doors'` is true before START is pressed
 * and all through the black after it. A walk that aimed then was aiming a room
 * no press could reach, and lost the race only under load.
 */
export const hangarOn = async (page: Page, view: string, timeout = 60_000): Promise<void> => {
  await expect
    .poll(
      async () => {
        const at = await hangarAim(page)
        if (at?.screen !== 'menu' || (await fading(page))) return `${at?.screen ?? 'no room'}`
        return at.view
      },
      { message: `the hangar is the screen, on its ${view} step`, timeout },
    )
    .toBe(view)
}

/**
 * Press door `id` on the door step that is up (DEV-558): aim it, as a player
 * does, by turning the seat until it is under the pointer, then a held Enter.
 * Asserts the step and the aim, so a walk that lands somewhere unexpected says
 * where.
 */
export const pressDoor = async (page: Page, id: string, settle = 600): Promise<void> => {
  const at = await hangarAim(page)
  expect(['doors', 'multiplayer', 'options'], `a door step is up to press ${id} on`).toContain(
    at?.view,
  )
  expect(await lookUntilAimed(page, id), `found the ${id} table`).toBe(true)
  await hold(page, 'Enter', settle)
}

/** The camera's yaw in the world, radians, off its own matrix (forward is its −z). */
export const cameraYaw = (page: Page): Promise<number | null> =>
  page.evaluate(() => {
    const ff = (globalThis as unknown as Ff2GlobalMaybe).__ff2
    if (!ff) return null
    const cam = ff.render.camera
    cam.updateWorldMatrix(true, false)
    const m = cam.matrixWorld.elements
    return Math.atan2(-(m[8] ?? 0), m[10] ?? 0)
  })

/**
 * Turn the seat back to yaw `want` (radians, {@link cameraYaw}'s), as a player
 * does: nudge, measure, nudge. `KeyD` is believed to turn right; the belief is
 * flipped if a nudge made the error worse (the orientation lesson, applied to a
 * helper, as {@link aimAtMark} does).
 */
export const turnSeatTo = async (page: Page, want: number, budget = 120): Promise<void> => {
  let right: 'KeyD' | 'KeyA' = 'KeyD'
  let previous: number | null = null
  for (let i = 0; i < budget; i++) {
    const now = await cameraYaw(page)
    if (now === null) return
    const d = Math.atan2(Math.sin(want - now), Math.cos(want - now))
    if (Math.abs(d) < 0.01) return
    if (previous !== null && Math.abs(d) > previous + 1e-4)
      right = right === 'KeyD' ? 'KeyA' : 'KeyD'
    previous = Math.abs(d)
    // Positive `d` is a turn to the LEFT in three's yaw (about +y).
    const key = d < 0 ? right : right === 'KeyD' ? 'KeyA' : 'KeyD'
    await page.keyboard.down(key)
    await page.waitForTimeout(Math.abs(d) > 0.2 ? 80 : 35)
    await page.keyboard.up(key)
    await page.waitForTimeout(60)
  }
}

/**
 * From the hangar's FIRST step to the aircraft (DEV-558: SINGLE PLAYER), for
 * the specs that walk the menu by hand rather than with {@link board}. Waits
 * for the room to be up first; a room already below the doors (a spec that
 * came back from a run) is left where it is.
 *
 * And the seat goes back where it was: the turn to SINGLE PLAYER is the door's
 * business, and every spec written before DEV-558 meets the aircraft step from
 * the seat's resting look (an aircraft under the pointer, the room framed as
 * its photographs are framed). A player would look back too.
 */
export const throughDoors = async (page: Page): Promise<void> => {
  // The room is the SCREEN and its fade is done, not merely laid (see
  // {@link hangarOn}): it stands on its doors under the title too.
  await expect
    .poll(async () => (await hangarAim(page))?.screen === 'menu' && !(await fading(page)), {
      message: 'the hangar is the screen',
      timeout: 60_000,
    })
    .toBe(true)
  if ((await hangarAim(page))?.view !== 'doors') return
  const rest = await cameraYaw(page)
  await pressDoor(page, DOOR_SINGLE)
  await expect
    .poll(async () => (await hangarAim(page))?.view, {
      message: 'SINGLE PLAYER opened the aircraft',
    })
    .toBe('vehicles')
  if (rest !== null) await turnSeatTo(page, rest)
}

/** A course, named on all four axes. Nothing here reads a level JSON. */
export interface Course {
  readonly vehicle: string
  /**
   * The aircraft variant to fly it in (DEV-382), where the room asks. Absent
   * is `standard`, the table under the resting pointer and 2016's machine.
   */
  readonly variant?: string
  readonly mode: string
  readonly rank: string
  readonly id: string
}

/**
 * `int_01_hoverJet` — HoverJet, Ring Attack, Intermediate, over Simonet.
 *
 * The first public release's one mission, and the one a bare boot loads. A walk
 * that names it does NOT depend on that second fact, which is the whole reason
 * the names are written out: the day the boot default moves, a blind walk
 * quietly starts testing another mission and a named one goes red.
 */
export const INT_01_HOVERJET: Course = {
  vehicle: 'hoverjet',
  mode: 'ringAttack',
  rank: 'intermediate',
  id: 'int_01_hoverJet',
}

/**
 * From the room to the pad: four presses, every one of them aimed — five where
 * the room asks for the aircraft's VARIANT (DEV-382, Anniversary), and one
 * fewer on Ring Attack, whose place table carries the difficulty as ski-map
 * marks (DEV-420): there the last "aim" turns to the place and looks at the
 * course's mark, and `course.rank` is never pressed.
 *
 * Leaves you ABOARD and waiting — it does not call the lift. `MenuManager`
 * pages ship -> mode -> rank -> challenge (DEV-105, DEV-203), and each step is
 * asserted before it is walked, so a spec that lands somewhere unexpected says
 * which step lost it rather than failing later on a missing panel.
 *
 * `lastSettle` is how long to wait after the press that BOARDS, and it exists
 * for one caller: `fade.spec.ts` polls for the curtain reaching solid black
 * immediately afterwards, so a comfortable settle here would sit inside the
 * transition it is trying to measure and report that it never went black. Every
 * other caller wants the default, which is the room finishing its business
 * before anything is asked of it.
 */
export const board = async (page: Page, course: Course, lastSettle = 600): Promise<void> => {
  const steps = [
    // DEV-558: the hangar's first step, in front of the aircraft.
    ['doors', DOOR_SINGLE],
    ['vehicles', course.vehicle],
    ['variants', course.variant ?? 'standard'],
    ['modes', course.mode],
    ['ranks', course.rank],
    ['courses', course.id],
  ] as const
  // The steps THIS room walks, read off the room at EVERY step: the variant
  // step is Anniversary's (DEV-382), and since DEV-420 the rank step is not
  // walked under a plan whose place carries its difficulty (Ring Attack) —
  // which the room only knows once the plan is open. So a walk cannot press
  // through a step that is not there or skip one that is.
  //
  // DEV-558: and only once the room is the SCREEN, with its fade done; it
  // stands on its doors under the title too (see `hangarOn`).
  await expect
    .poll(async () => (await hangarAim(page))?.screen === 'menu' && !(await fading(page)), {
      message: `${course.id}: the hangar is the screen`,
      timeout: 60_000,
    })
    .toBe(true)
  for (const [view, want] of steps) {
    const at = await hangarAim(page)
    const views = at?.views ?? []
    if (!views.includes(view)) continue
    // DEV-558: a room already below its doors (a spec that walked through
    // them, or came back to the room from a run) is past that step.
    if (view === 'doors' && at?.view !== 'doors') continue
    expect(at?.view, `${course.id}: on the ${view} step`).toBe(view)
    const last = view === 'courses'
    expect(
      last ? await aimAtCourse(page, want) : await lookUntilAimed(page, want),
      `${course.id}: found ${want} on the ${view} arc`,
    ).toBe(true)
    await hold(page, 'Enter', last ? lastSettle : 600)
    // DEV-608: a lesson rank holds one lesson and BOARDS from the rank (the
    // room's `boardsFromRank`), so there is no PLACE step to walk after it.
    if (view === 'ranks' && (await hangarAim(page))?.view !== 'courses') break
  }
  // ── and the world the last press asked for is actually in (DEV-281) ─────
  //
  // That press USED to be a change of viewpoint — boot had already built the
  // island, whichever card you picked — and is now, on the route a player
  // takes, the load itself: nothing generates a 4,096 m terrain until a course
  // is chosen. So `board()` returning had quietly stopped meaning "you are
  // aboard" and started meaning "you asked to be".
  //
  // Here rather than in each caller, because every caller of this helper wants
  // the cockpit and none of them wants the moment before it. On a URL that
  // boots a mission (`?menu=0`, `?view=`, `?autopilot=1`) and a press that
  // boards the course already loaded, both halves are already true and this
  // returns immediately.
  //
  // BOTH halves, and the second is the one that is easy to leave out:
  // `data-terrain-ready` is deleted inside `teardownWorld`, which is behind a
  // `loadLevel` fetch, so for a few tens of milliseconds after the press it
  // still describes the world being thrown away. `data-switching` is set
  // synchronously at the press and is what closes that window.
  await switchSettled(page, 180_000)
}
