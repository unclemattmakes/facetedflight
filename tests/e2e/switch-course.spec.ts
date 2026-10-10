/**
 * tests/e2e/switch-course.spec.ts — **where do you ARRIVE when you change course?**
 *
 * DEV-077 made picking a course in another world a swap in place rather than a
 * document reload. This asks the one question that swap has to get right and
 * that nothing else asks: after the swap, is the player ON the launch platform,
 * or somewhere else entirely?
 *
 * It was asked on 2026-09-14 and the answer was **107 metres above it**, for
 * every course except the one the page happened to boot into. Matt reported it
 * as *"our mesa canyon and alpine forest maps don't seem to load"* — those two
 * worlds hold no boot mission, so they were the two that were ALWAYS wrong, and
 * what you saw was a briefing card and `Press A to launch` on a sheet of flat
 * fog colour with the hangar, the shaft and the terrain all far below.
 *
 * ── Why the whole suite stayed green ─────────────────────────────────────
 *
 * `completion.spec.ts` flies all thirteen, and it flies them with the AUTOPILOT,
 * which presses A on the first frame. A launch from the wrong altitude is still
 * a launch: the ship leaves the platform, the gates score, the mission finishes,
 * and the run it proves is a run nobody could tell was broken. Every assertion
 * in that file is about what the mission DID, and this is a question about where
 * it began.
 *
 * `walkthrough.spec.ts` stops at boarding, and boarding is exactly the path that
 * worked — it is the one case with no swap in it.
 *
 * ── What it measures, and why it is a RELATIONSHIP ───────────────────────
 *
 * The ship's altitude against the launch anchor's, and nothing else. That
 * difference is zero on every mission in the game by construction — the anchor
 * IS the platform's resting place, and the ship rests on the platform — so the
 * assertion needs no per-mission number, no spawn table, and nothing that has to
 * be updated when a fourteenth course lands. It is the orientation lesson's
 * rule applied to a height: assert the relationship, not the value. A test that
 * re-derived the expected altitude the way `app.ts` derives it would have agreed
 * with the bug.
 *
 * The boot mission is measured the same way in the same file, deliberately. It
 * is the case that was already right, and it is the LOUD COUNTERPART: if the two
 * ever stop being measured identically, the swapped one can rot while the suite
 * stays green.
 */

import { bootReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { aimAtCourse, throughDoors, throughVariants } from './fixtures/hangar'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

test.describe.configure({ timeout: 300_000 })

/**
 * Held, not tapped.
 *
 * Every confirm in this game is a LEVEL read once a frame, so a press that lands
 * between two frames is a press nothing saw. `completion.spec.ts`, `lap.spec.ts`
 * and `walkthrough.spec.ts` all carry the same note.
 */
const hold = (page: import('@playwright/test').Page, key: string, settle = 600) =>
  keysHold(page, key, { down: 200, settle })

/** One notch of seat yaw. `KeyD`/`KeyA`'s directions are pinned by `mouse-look.spec.ts`. */
const turn = async (page: import('@playwright/test').Page, key: 'KeyA' | 'KeyD' = 'KeyD') => {
  await page.keyboard.down(key)
  await page.waitForTimeout(80)
  await page.keyboard.up(key)
  await page.waitForTimeout(80)
}

const aim = async (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const h = (
      globalThis as unknown as {
        __ff2?: {
          hangarAim: () => {
            view: string
            aim: {
              kind: string
              vehicle?: { vehicle: string }
              mode?: { mode: string }
              rank?: { difficulty: string }
              mission?: { id: string }
            } | null
          } | null
        }
      }
    ).__ff2?.hangarAim()
    if (!h) return null
    const named =
      h.aim?.kind === 'vehicle'
        ? (h.aim.vehicle?.vehicle ?? null)
        : h.aim?.kind === 'mode'
          ? (h.aim.mode?.mode ?? null)
          : h.aim?.kind === 'rank'
            ? (h.aim.rank?.difficulty ?? null)
            : h.aim?.kind === 'mission'
              ? (h.aim.mission?.id ?? null)
              : null
    return { view: h.view, kind: h.aim?.kind ?? null, named }
  })

/**
 * Turn the seat right until `want` is under the nose pointer.
 *
 * A SEARCH, not a computed yaw. It used to be one because the bearings depended
 * on how many tables there were and on which one the loaded mission sat in —
 * both of which DEV-203 removed. It stays one for a better reason: a search is
 * what a player does, and a spec that computed the bearing would be asserting
 * the layout twice rather than driving it once.
 *
 * `want` is whatever the step under the pointer names: an aircraft key, a
 * flight-plan key, a rank key, or a mission id.
 *
 * ── And it sweeps BOTH WAYS, which it did not have to before ────────────
 *
 * The arc is 90 degrees wide and the room is 360, so turning one way from a
 * table at one end takes you the long way round — 270 degrees of empty room
 * before the table you wanted. Measured on the ranks step: a notch turns the
 * seat about 3.7 degrees, so a one-directional search needs ~90 of them to come
 * back round, and 60 was not enough. Sweeping right and then left is both
 * quicker and what a person does when they overshoot.
 *
 * ── And the budget is 32, not 20 (DEV-203) ──────────────────────────────
 *
 * "N right then 2N left" covers a window CENTRED on where you started, `N x
 * notch` each way — 74 degrees at 20. That sounds like plenty against a
 * 90-degree arc and is not: crossing from one END of the arc to the other is a
 * full 90 in ONE direction. It never mattered while `restFirst` rotated the
 * table you wanted under the pointer; with fixed slots it does, and
 * `menu-screen.spec.ts` failed exactly there — HoverJet · Free Flight ·
 * Beginner, Kauai at +45 reached from Beginner at -45. 32 gives 118 degrees
 * each way. The search exits the moment it finds the target, so the larger
 * budget costs nothing on the common path.
 */
const lookUntil = async (
  page: import('@playwright/test').Page,
  want: string,
  steps = 32,
): Promise<boolean> => {
  const on = async () => (await aim(page))?.named === want
  for (let i = 0; i < steps; i++) {
    if (await on()) return true
    await turn(page)
  }
  // Back past home and out the other side. Twice the budget, because the sweep
  // above has already spent one arc's worth going the wrong way.
  for (let i = 0; i < steps * 2; i++) {
    if (await on()) return true
    await turn(page, 'KeyA')
  }
  return on()
}

/**
 * Where the ship is, and where the room it launches from is.
 *
 * The ship comes from the SIM body (Unity space) and the anchor from the scene
 * graph (three space), so only `y` is compared — it is the one axis the two
 * conventions agree on, and it is the axis the defect moved.
 */
const arrival = async (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    interface Vec3 {
      x: number
      y: number
      z: number
    }
    const ff = (
      globalThis as unknown as {
        __ff2?: {
          render: {
            camera: { position: Vec3 }
            scene: { children: { name: string; getWorldPosition: (v: Vec3) => void }[] }
          }
          flight: () => { jet: { body: { position: { y: number } } } } | null
        }
      }
    ).__ff2
    if (!ff) return null
    const anchor = ff.render.scene.children.find((c) => c.name === 'launch-anchor')
    if (!anchor) return null
    // A real `THREE.Vector3`, borrowed off the camera: `getWorldPosition` calls
    // `setFromMatrixPosition` on whatever it is handed, so a plain object throws.
    // The spec has no `three` import — `@/` is a Vite alias the runner does not
    // have — so the constructor comes from an object the page already owns.
    const Vector3 = ff.render.camera.position.constructor as new () => Vec3
    const out = new Vector3()
    anchor.getWorldPosition(out)
    const ship = ff.flight()?.jet.body.position.y
    return ship === undefined ? null : { shipY: ship, anchorY: out.y }
  })

/** Boot, clear the gesture card, and wait for a world. */
const boot = async (page: import('@playwright/test').Page, query: string) => {
  await page.goto(query)
  await firstPress(page)
  // `bootReady`, not `data-terrain-ready`: this spec walks the title screen into
  // the room and boards from there, and since DEV-281 a bare boot builds no
  // mission world — the press at the end of the walk is what generates the
  // island. The poll on `now flying` below is what waits for THAT.
  await bootReady(page, 240_000)
  // `dropFocus`, not `focusCanvas`: a click on the TITLE is a real press since
  // DEV-301, so the focusing click used to leave the title itself and the
  // Enter below then chose an aircraft (the room read `modes`). Same fix as
  // `ship-select.spec.ts`; `fixtures/canvas.ts` has the rule.
  await dropFocus(page)
  await page.waitForTimeout(1_200)
}

/**
 * The two arrivals, measured identically.
 *
 * `boarded` is the boot mission: the room is already built around it and no swap
 * happens. `swapped` is any other course, which tears the world down and builds
 * the next one. Both must put the ship on the platform.
 */
const CASES = [
  {
    label: 'the boot mission, boarded',
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    rank: 'intermediate',
    course: 'int_01_hoverJet',
  },
  {
    label: 'another world, swapped in',
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    rank: 'beginner',
    course: 'rookie_01_hoverJet',
  },
  {
    label: 'the same world, swapped in',
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    rank: 'professional',
    course: 'adv_02_hoverJet',
  },
  {
    // The FLIGHT PLAN step earning its place (DEV-203). Kauai is the one Free
    // Flight course, and until this step existed it had nowhere of its own —
    // it sat on the HoverJet's Beginner rank page, which is exactly the
    // "beginner flow is odd" Matt reported. It is also the only case here that
    // reaches a different branch of the menu, so it is the only one that would
    // catch a mode step wired to the wrong cell.
    label: 'the free-flight course, under its own plan',
    vehicle: 'hoverjet',
    mode: 'freeFlight',
    rank: 'beginner',
    course: 'hoverJet_kauai_beg',
  },
] as const

for (const { label, vehicle, mode, rank, course } of CASES) {
  test(`you arrive on the launch platform — ${label}`, async ({ page }) => {
    test.setTimeout(300_000)
    const logs: string[] = []
    page.on('console', (m) => logs.push(m.text()))

    await boot(page, '/?xr=off')

    // Title -> the room, which opens on the aircraft.
    await pressTitleRow(page, TITLE_ROW.hangar) // DEV-558: START, the hangar's doors
    await throughDoors(page) // and SINGLE PLAYER, to the aircraft
    expect((await aim(page))?.view, 'Single Player opens the aircraft').toBe('vehicles')

    expect(await lookUntil(page, vehicle), `${vehicle} is reachable on the arc`).toBe(true)
    await hold(page, 'Enter')
    // DEV-382: Anniversary asks for the VARIANT next; standard, under the pointer.
    await throughVariants(page)
    expect((await aim(page))?.view, 'a press on an aircraft opens its plans').toBe('modes')

    expect(await lookUntil(page, mode), `${mode} is reachable on the arc`).toBe(true)
    await hold(page, 'Enter')
    // DEV-420: Ring Attack's place carries its rank, so its plan opens the
    // PLACES and the rank is a mark on the table; every other plan still opens
    // its ranks. The room says which, and the walk takes whichever is up.
    // DEV-800: and Free Flight's, which skips the rank step (2016 did).
    if (mode === 'ringAttack' || mode === 'freeFlight') {
      expect((await aim(page))?.view, `a press on ${mode} opens its places`).toBe('courses')
    } else {
      expect((await aim(page))?.view, 'a press on a plan opens its ranks').toBe('ranks')
      expect(await lookUntil(page, rank), `${rank} is reachable on the arc`).toBe(true)
      await hold(page, 'Enter')
      expect((await aim(page))?.view, 'a press on a rank opens its places').toBe('courses')
    }

    expect(await aimAtCourse(page, course), `${course} is reachable on its page`).toBe(true)
    await hold(page, 'Enter', 1_000)

    // Boarding is immediate; a swap loads a level, tears a world down and builds
    // another, which is seconds of work on a cold cache.
    await expect
      .poll(() => logs.some((l) => l.includes('now flying') || l.includes('boarding:')), {
        timeout: 180_000,
        message: 'the pick reaches a mission',
      })
      .toBe(true)
    await page.waitForTimeout(2_000)

    expect(
      await page.evaluate(() => document.body.dataset.terrainError ?? null),
      'the world built',
    ).toBeNull()

    const at = await arrival(page)
    expect(at, 'the ship and the launch room both exist').not.toBeNull()
    const { shipY, anchorY } = at as { shipY: number; anchorY: number }
    // ── the assertion ──────────────────────────────────────────────────────
    //
    // One metre, against a defect that was 106.647 — the elevator's full rise.
    // The two numbers are the same place expressed twice, so the tolerance is
    // for float and for interpolation, not for a difference anybody expects.
    expect(
      Math.abs(shipY - anchorY),
      'the ship rests on the launch platform, not a shaft-height above it',
    ).toBeLessThan(1)
  })
}
