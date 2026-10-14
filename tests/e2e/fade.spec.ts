/**
 * The transition fade, and the one thing about it a unit test cannot see.
 *
 * `tests/unit/fade.test.ts` owns the schedule — the ramp, the clamp, the hold.
 * What it cannot own is WHERE the curtain is drawn, and that is the trap
 * `docs/plan/LOADING.md` L2 named before a line of this was written:
 *
 *   > the vignette lives in `render.scene` and the hangar draws from
 *   > `menuScene`. A fade that covers the cockpit and not the room is worse
 *   > than no fade at all, because the transition it is most needed for is the
 *   > one INTO the room. [...] a test must assert the fade is visible on
 *   > **both** stages, because a spec that only checked the mission scene would
 *   > be green and wrong.
 *
 * So every assertion below is about the object's PARENT relative to the stage
 * being rendered, which is a relationship rather than a value (trap 24). A
 * spec that asserted "the vignette is in `render.scene`" would pass on the
 * broken build.
 *
 * The other half is L4: the canvas is solid black from boot and the first frame
 * a visitor sees is a finished one. That is checked from the DOM before the
 * card is ever dismissed, which is the only moment it is observable.
 */

import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { board, INT_01_HOVERJET } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { expect, type Page, test } from './fixtures/test'
import { titleRowsUp } from './fixtures/title'

interface FadeProbe {
  amount: number
  phase: string
  busy: boolean
}

/** The race clock. It goes back to zero when a boundary death restarts the run. */
const elapsedOf = async (page: Page): Promise<number> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.mission.elapsed ?? 0)

interface BoundaryProbe {
  phase: string
  outsideFor: number
  progress: number
  /** The vignette's live static alpha — what is DRAWN (DEV-127). */
  fuzz: number
}

const boundaryOf = async (page: Page): Promise<BoundaryProbe | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.boundary() ?? null)

const fadeOf = async (page: Page): Promise<FadeProbe | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.fade() ?? null)

/**
 * Is the curtain parented into the scene currently being drawn?
 *
 * `stage()` is the app's own answer to "which `THREE.Scene` is on screen", and
 * the vignette carries a stable name. Walking from the stage DOWN is what makes
 * this a relationship: it is true of whichever scene is live rather than of one
 * named scene.
 */
const curtainOnStage = async (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const app = (globalThis as unknown as Ff2GlobalMaybe).__ff2
    if (!app) return false
    let found = false
    app.stage().traverse((o) => {
      if (o.name === 'comfort-vignette') found = true
    })
    return found
  })

/** The screen the app believes it is on, derived from what it is drawing. */
const screenName = async (page: Page): Promise<string> =>
  page.evaluate(
    () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.stage().name?.toString() ?? '',
  )

test.describe('@gpu the transition fade', () => {
  test.setTimeout(300_000)

  // DEV-872 made the suite's own `test` press Enter to skip the developer
  // splash (`fixtures/test.ts`), and headless Chrome already reports the page
  // as user-activated, so `main.ts` takes that synthetic Enter as the first
  // input. Every other spec presses anyway; this one is the player who never
  // does, so it meets the splash as that player does and lets it leave on its
  // own (load, then the typed name's hold).
  test.describe('with nobody pressing', () => {
    test.use({ skipsSplash: false })

    test('lifts as soon as the world settles, WITHOUT waiting for a press', async ({ page }) => {
      // ── What this pins, and what DEV-279 changed ──────────────────────────
      //
      // It used to be called "boots solid black, and lifts only when the card is
      // dismissed", and it asserted `amount === 1` while the Start button was
      // already enabled. That was a true description of the old build and it is
      // the exact behaviour Matt asked to change: the canvas stayed black until a
      // human pressed something, so the landing card had to be an opaque curtain
      // to have anything to be.
      //
      // **L4's guarantee is NOT what changed and is still pinned below.** The
      // fade releases on `revealRequested && firstWorldSettled`; DEV-279 moved
      // only the first half to boot. A half-built world still assembles behind
      // black. What went is the extra wait for a human, which L4 never argued for.
      await page.goto('/?xr=off')

      // The world is ready at `data-load="ready"`, the `phase: 'ready'` the
      // landing card's button used to light up on. By then the curtain must be
      // GONE, with nobody having touched anything.
      await expect(page.locator('body')).toHaveAttribute('data-load', 'ready', { timeout: 180_000 })
      await expect(page.locator('body')).toHaveAttribute('data-fade', 'idle', { timeout: 30_000 })
      expect((await fadeOf(page))?.amount, 'the valley is on screen before the press').toBe(0)

      // DEV-557: and the title's rows are up over it with no press at all. The
      // landing card that used to stand here with the controls on it is gone
      // (Matt, 2026-10-01: "let's get rid of the html curtain"); the controls
      // ARE the title now. The splash goes first, by itself: it is a loading
      // screen with a fixed life, not a curtain waiting on a human (DEV-611).
      await expect(page.locator('body')).toHaveAttribute('data-splash', 'gone', { timeout: 30_000 })
      await titleRowsUp(page)
      expect(
        await page.evaluate(() => document.body.hasAttribute('data-first-input')),
        'nobody has pressed anything yet',
      ).toBe(false)

      // The first press then changes nothing on screen: the curtain was already
      // lifted and must stay lifted. A press that re-blacked the screen would be
      // the old bug wearing the new flow.
      await firstPress(page)
      expect((await fadeOf(page))?.amount).toBe(0)
    })
  })

  test('draws the curtain on whichever stage is live — the room included', async ({ page }) => {
    // The trap, tested from both sides. `title=0` boots straight into the menu
    // world, which is the scene the naive implementation does NOT cover.
    await page.goto('/?xr=off&title=0')
    await firstPress(page)
    await missionReady(page, 180_000)
    await expect(page.locator('body')).toHaveAttribute('data-fade', 'idle', { timeout: 30_000 })
    await focusCanvas(page)

    const inRoom = await screenName(page)
    expect(await curtainOnStage(page), `the curtain is in the ${inRoom} stage`).toBe(true)

    // Board. FOUR steps, every one of them aimed — see `fixtures/hangar.ts`.
    //
    // This said *"THREE presses from the room … the resting pointer is on the
    // loaded mission's own row at every step, so none of them needs aiming"*,
    // and in the same breath *"`walkthrough.spec.ts` walks the same four"* —
    // a comment that had been half-updated for DEV-203 and contradicted itself
    // across two lines. The presses were never updated, so this test sat red
    // for a day: it pressed three times, stayed in the room, and failed on
    // *"boarding changed the stage"* — which is exactly what it should say
    // about a walk that never boarded.
    // No settle on the boarding press: the poll below is looking for the
    // curtain reaching solid black, and waiting first is how you miss it.
    await board(page, INT_01_HOVERJET, 0)

    // The stage changed underneath the curtain, and the transition has to have
    // been SOLID at some point in between — or the cut it exists to hide
    // happened in plain view. Polled sequentially rather than on a timer: a
    // `setInterval` firing async probes races the assertions that follow it and
    // can report a `sawBlack` that arrived after the test read it.
    let sawBlack = false
    for (let i = 0; i < 120; i++) {
      const f = await fadeOf(page)
      if (f && f.amount >= 1) sawBlack = true
      if (f && f.phase === 'idle' && sawBlack) break
      await page.waitForTimeout(50)
    }

    const inMission = await screenName(page)
    expect(inMission, 'boarding changed the stage').not.toBe(inRoom)
    expect(await curtainOnStage(page), 'the curtain followed to the mission stage').toBe(true)
    expect(sawBlack, 'the transition passed THROUGH solid black').toBe(true)
  })

  test('a boundary death snaps to black, moves the ship behind it, and eases back', async ({
    page,
  }) => {
    // ── Why this one is an e2e and not a unit test ────────────────────────
    //
    // The schedule is unit tested and the two durations are extracted. What
    // NEITHER can see is the thing the feature exists for: that the screen is
    // actually solid at the moment `sim/boundary.ts` moves the ship. That is a
    // sim clock and a render clock agreeing across three layers, and the only
    // place they are both real is a browser.
    //
    // ── Why the teleport is legitimate here, and was not in DEV-074 ───────
    //
    // Seventeen unit tests once "proved" the boundary by starting the ship
    // inside the sphere and teleporting it out — a sequence Unity cannot
    // produce, which is exactly why they all missed that two missions spawn
    // outside their own play area and reset every 15.5 s for ever. The
    // difference is what is under test. That bug was about `OnTriggerExit`
    // being an EDGE, so the entry history was the whole question. This is about
    // the curtain, the ship is genuinely armed (it spawns inside `int_01` and
    // flies from there), and the jump only saves the ninety seconds it would
    // take to fly 12 km. Nothing here reads `armed`.
    await page.goto('/?mission=int_01_hoverJet&xr=off&title=0&menu=0&autopilot=1')
    await firstPress(page)
    await missionReady(page, 180_000)
    await expect(page.locator('body')).toHaveAttribute('data-fade', 'idle', { timeout: 30_000 })
    await focusCanvas(page)

    // Let the autopilot actually get it flying, so the death interrupts a run
    // rather than a launch.
    await expect
      .poll(async () => elapsedOf(page), { timeout: 120_000, intervals: [500] })
      .toBeGreaterThan(3)
    expect((await fadeOf(page))?.amount, 'clear before the death').toBe(0)

    // 12 km out on x. `int_01`'s sphere is 2,918 m, and the HoverJet tops out
    // at 437.5 m/s — so the autopilot turning round and flying back cannot
    // re-enter inside the 13 s countdown and cancel it. The margin is the
    // point: a nearer jump would make this spec a race.
    await page.evaluate(() => {
      const jet = (globalThis as unknown as Ff2GlobalMaybe).__ff2?.flight()
      if (jet) jet.jet.body.position.x += 12_000
    })

    // The countdown is 13 s and the hold 2.5 s on every shipped mission. Poll
    // for the ORDER of three events rather than for three timings: black, then
    // the run restarting, then clear again.
    //
    // And, riding on the same loop, DEV-127: while the clock runs the static
    // is ON SCREEN and GROWING. `fuzz` is the vignette's live edge alpha — the
    // thing drawn, not the thing asked for — sampled before the black so a
    // curtain cannot stand in for it. The default preset is Anniversary, which
    // is the one that draws it; `boundary-fuzz.test.ts` holds Classic to zero.
    let blackAt: number | null = null
    let restartAt: number | null = null
    let clearAt: number | null = null
    const fuzzSeen: number[] = []
    let lastElapsed = await elapsedOf(page)
    for (let i = 0; i < 400; i++) {
      const f = await fadeOf(page)
      const now = await elapsedOf(page)
      if (blackAt === null) fuzzSeen.push((await boundaryOf(page))?.fuzz ?? 0)
      if (f && f.amount >= 1 && blackAt === null) blackAt = i
      // The restart resets the run: 2016 reloads the scene, so the clock, the
      // score and the rings all go back to zero.
      if (restartAt === null && now < lastElapsed - 0.5) restartAt = i
      lastElapsed = now
      if (restartAt !== null && f && f.amount === 0 && clearAt === null) {
        clearAt = i
        break
      }
      await page.waitForTimeout(100)
    }

    expect(blackAt, 'the screen went solid black').not.toBeNull()
    expect(restartAt, 'the run restarted').not.toBeNull()
    expect(clearAt, 'and the curtain came back up').not.toBeNull()
    // The claim, and the only one that matters: the ship moved BEHIND the
    // curtain. A respawn visible on screen is the defect this row exists to
    // remove, and it is an ordering fact rather than a timing one.
    expect(blackAt ?? 0, 'black BEFORE the ship moved').toBeLessThan(restartAt ?? 0)
    expect(restartAt ?? 0, 'and clear only after it').toBeLessThan(clearAt ?? 0)

    // DEV-127. The static was drawn during the countdown, and it grew: the
    // last reading before the curtain is above the first non-zero one, and the
    // level never fell while the ship stayed outside (it is a clock, not a
    // flicker). Then, after the restart, it is gone.
    const on = fuzzSeen.filter((v) => v > 0)
    expect(on.length, 'the static was on screen before the curtain').toBeGreaterThan(5)
    expect(on[on.length - 1] ?? 0, 'and it grew with the clock').toBeGreaterThan((on[0] ?? 0) * 1.5)
    for (let i = 1; i < on.length; i++) {
      expect(on[i] ?? 0, `sample ${i} did not fall`).toBeGreaterThanOrEqual((on[i - 1] ?? 0) - 1e-6)
    }
    expect((await boundaryOf(page))?.fuzz ?? 1, 'gone once the run restarted').toBe(0)
  })
})
