/**
 * tests/e2e/xr-entry.spec.ts — the XR entry path, exercised with no headset.
 *
 * These specs drive FF2's real boot code against the WebXR **test double** in
 * `fixtures/fake-xr.ts`. What they prove:
 *
 *   - the capability gate believes `isSessionSupported`, in both directions;
 *   - a rejecting query (crbug 40727637) degrades instead of exploding;
 *   - clicking Enter VR requests a session, hands it to three.js, gets a
 *     reference space and a base layer, and runs XR frames — without throwing.
 *
 * What they cannot prove: anything about comfort, frame timing, reprojection,
 * ergonomics or how the cockpit reads at near 0.08. Those need a headset on a
 * head. docs/vr-testing.md says which is which.
 *
 * Safe to run headless and on a GPU-less CI box: no spec here asserts on
 * rendering output or frame rate.
 */

import { splashGone } from './fixtures/boot'
import { releasePointer } from './fixtures/canvas'
import { type FakeXrRecord, installFakeXr, installNoXr } from './fixtures/fake-xr'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { hold } from './fixtures/hangar'
import { knownRed } from './fixtures/known-red'
import { enterVr, loadSettled, titleVr } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { expect, type Page, test } from './fixtures/test'
import { titleMenu, titleRowsUp } from './fixtures/title'

/**
 * `#start` no longer enables when `bootApp()` resolves — it waits for the first
 * WORLD and counts on the way (DEV-107). That is 4.5 s on a warm local server
 * and longer on anything else, so a five-second default is a spec asserting a
 * contract the game no longer has. The number is the terrain generator's, the
 * same one every spec here gives `data-terrain-ready`.
 *
 * **`#enter-vr` carries that gate too, and this file did not know it.** DEV-107
 * put the VR button behind the same load state as Start and said why — *"the
 * headset is the one place a half-built world cannot be diagnosed"* — but the
 * sweep that followed (7c1c350) searched for `#start` and so fixed nine call
 * sites and missed the two below. Measured here 2026-09-17, three parallel
 * runs: `#enter-vr` enables at **15.8–17.0 s**, against a 5 s default. Both
 * `toBeEnabled` assertions in this file failed on both attempts of every run
 * measured that day — so the whole positive branch, this test and the session
 * test below, was proving nothing on the one path the headset pass depends on.
 *
 * How long it had been so is not something a run today can establish, but the
 * tell was in 7c1c350's own message on the day DEV-107 landed, filed as noise:
 * *"`xr-entry.spec.ts:93` went flaky on the re-run and passed."* That is this
 * bug, three days earlier, one slow world away from red — a race between the
 * terrain generator and a five-second default, not a flake.
 */
const READY = { timeout: 180_000 }

/**
 * For the things that are ready when `bootApp()` resolves and do NOT wait for a
 * world — here, the landing page's capability line. Measured at 2.2 s (stable
 * to ±20 ms over three parallel runs), so this is thirteen times the observed
 * cost and still six times under `READY`: enough that a slow box cannot make it
 * red, little enough that it can never be satisfied by a world arriving.
 *
 * It is deliberately not Playwright's five-second default. A 2.3x margin is how
 * this file got into trouble in the first place, and a spec that fails when boot
 * is slow is asserting a boot time nobody promised.
 */
const BOOTED = { timeout: 30_000 }

const readRecord = (page: Page): Promise<FakeXrRecord | undefined> =>
  page.evaluate(() => (globalThis as unknown as { __ff2FakeXr?: FakeXrRecord }).__ff2FakeXr)

test.describe('XR entry path', () => {
  // Without this, `READY` above is DECORATION. Playwright's per-test default is
  // 30 s and this config never overrides it, so a 180 s expect budget inside a
  // 30 s test cannot be spent: the test dies first, reporting its own timeout
  // rather than the assertion's, which names nothing. `mobile-controls.spec.ts`
  // hit exactly this and says so at its own `test.setTimeout`.
  //
  // It was not academic. Measured 2026-09-17 on this box: these tests take
  // 19–23 s of that 30 s, and `boot.spec.ts` — same missing line, same inline
  // 180 s — came in at 28.4 s. The suite was one slow run from going red again
  // for a second reason, immediately after being fixed for the first.
  test.setTimeout(180_000)

  // ── DEV-557: the button is a plate on the title, and "disabled" is a word ──
  //
  // Matt, 2026-10-01: "add an enter VR button to the title screen (or
  // "connect vr headset" if it can't find one)". So where these tests used to
  // read a DOM button's `disabled`, they read the title's ENTER VR plate
  // (`__ff2.titleMenu().vr`): `enter` where the platform says a headset is
  // there, `connect` (CONNECT VR HEADSET) where it says there is none. The
  // names below are kept so a baseline compares them; "stays disabled" now
  // means "offers to connect, and asks for no session".

  test('with no WebXR at all, Enter VR stays disabled and the page still boots', async ({
    page,
  }) => {
    const problems = watchPageErrors(page)
    await page.addInitScript(installNoXr)
    await page.goto('/')

    await loadSettled(page, READY.timeout)
    await titleRowsUp(page)
    await expect.poll(async () => (await titleVr(page))?.state ?? null, BOOTED).toBe('connect')
    expect((await titleVr(page))?.label).toBe('Connect VR headset')

    expect(problems.list(), problems.list().join('\n')).toEqual([])
  })

  test('when the runtime reports immersive-vr, Enter VR is enabled', async ({ page }) => {
    const problems = watchPageErrors(page)
    await page.addInitScript(installFakeXr, { supported: true })
    await page.goto('/')

    await loadSettled(page, READY.timeout)
    await titleRowsUp(page)
    await expect.poll(async () => (await titleVr(page))?.state ?? null, BOOTED).toBe('enter')
    const vr = await titleVr(page)
    expect(vr?.label).toBe('Enter VR')
    expect(vr?.shown, 'the plate is drawn beside the rows').toBe(true)

    const record = await readRecord(page)
    expect(record?.calls).toContain('isSessionSupported:immersive-vr')

    expect(problems.list(), problems.list().join('\n')).toEqual([])
  })

  test('when the runtime reports no support, Enter VR stays disabled', async ({ page }) => {
    const problems = watchPageErrors(page)
    await page.addInitScript(installFakeXr, { supported: false })
    await page.goto('/')

    await loadSettled(page, READY.timeout)
    await titleRowsUp(page)
    await expect.poll(async () => (await titleVr(page))?.state ?? null, BOOTED).toBe('connect')

    // And pressing CONNECT VR HEADSET asks the platform again (the player
    // asked, so starting the runtime is theirs to want) and requests NO
    // session: a "connect" that opened one would be the gate failing open.
    // DEV-872: a click inside the splash fade is the splash's.
    await splashGone(page)
    const at = (await titleVr(page))?.at as { x: number; y: number }
    await page.mouse.click(at.x, at.y)
    await releasePointer(page)
    await expect
      .poll(
        async () =>
          (await readRecord(page))?.calls.filter((c) => c === 'isSessionSupported:immersive-vr')
            .length ?? 0,
      )
      .toBeGreaterThan(1)
    const record = await readRecord(page)
    expect(record?.sessions).toBe(0)
    expect((await titleVr(page))?.state).toBe('connect')

    expect(problems.list(), problems.list().join('\n')).toEqual([])
  })

  test('a rejecting isSessionSupported degrades to flat instead of failing', async ({ page }) => {
    // crbug 40727637: Chrome + SteamVR where the runtime is installed but not
    // running. The query rejects rather than resolving false. Research doc 09
    // §3.2 / risk R14: never treat this as fatal.
    const problems = watchPageErrors(page)
    await page.addInitScript(installFakeXr, { rejectQuery: true })
    await page.goto('/')

    await loadSettled(page, READY.timeout)
    await titleRowsUp(page)
    await expect.poll(async () => (await titleVr(page))?.state ?? null, BOOTED).toBe('connect')

    expect(problems.list(), problems.list().join('\n')).toEqual([])
  })

  // ── DEV-992: the runtime that comes up AFTER the page loaded ───────────────
  //
  // Matt, 2026-10-14: the probe answered false in 4 ms (SteamVR still starting),
  // the page booted flat, SteamVR came up, and H did nothing until a reload. The
  // double says no at boot, then yes, with no `devicechange` (its listener is a
  // no-op, as a late SteamVR may not fire one).
  test('a headset that comes up after boot: H enters, with no reload', async ({ page }) => {
    const problems = watchPageErrors(page)
    await page.addInitScript(installFakeXr, { supported: false })
    await page.goto('/')
    await loadSettled(page, READY.timeout)
    await titleRowsUp(page)
    await expect.poll(async () => (await titleVr(page))?.state ?? null, BOOTED).toBe('connect')
    await splashGone(page)

    await page.evaluate(() => {
      ;(globalThis as unknown as { __ff2FakeXr: FakeXrRecord }).__ff2FakeXr.supported = true
    })
    await hold(page, 'h', 250)
    await expect
      .poll(async () => (await readRecord(page))?.frames ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(0)
    expect((await readRecord(page))?.sessions).toBe(1)
    expect(problems.list(), problems.list().join('\n')).toEqual([])
  })

  test('a headset that comes up after boot lights the row by itself', async ({ page }) => {
    const problems = watchPageErrors(page)
    await page.addInitScript(installFakeXr, { supported: false })
    await page.goto('/')
    await loadSettled(page, READY.timeout)
    await titleRowsUp(page)
    await expect.poll(async () => (await titleVr(page))?.state ?? null, BOOTED).toBe('connect')

    await page.evaluate(() => {
      ;(globalThis as unknown as { __ff2FakeXr: FakeXrRecord }).__ff2FakeXr.supported = true
    })
    // The page's own poll (every 10 s); nobody presses anything.
    await expect
      .poll(async () => (await titleVr(page))?.state ?? null, { timeout: 40_000 })
      .toBe('enter')
    expect((await readRecord(page))?.sessions).toBe(0)
    expect(problems.list(), problems.list().join('\n')).toEqual([])
  })

  test('entering a faked immersive session does not throw and runs XR frames', async ({ page }) => {
    const problems = watchPageErrors(page)
    await page.addInitScript(installFakeXr, { supported: true })
    await page.goto('/')

    // The player's path since DEV-557: the title's ENTER VR, clicked (a row
    // since DEV-558). A click is the transient activation `requestSession` needs.
    await enterVr(page, READY.timeout)

    // three.js's WebXRManager.setSession() is async: it creates the base
    // layer, pushes render state, awaits a reference space, then starts the
    // session's own frame loop. Poll until frames arrive rather than sleeping.
    await expect
      .poll(async () => (await readRecord(page))?.frames ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(0)

    const record = await readRecord(page)
    expect(record?.sessions).toBe(1)
    expect(record?.calls).toContain('requestSession:immersive-vr')
    expect(record?.calls).toContain('new XRWebGLLayer')
    expect(record?.calls).toContain('session.updateRenderState')
    expect(record?.calls).toContain('session.requestReferenceSpace')
    expect(record?.calls).toContain('frame.getViewerPose')

    // 'local', which FF2 asks for DELIBERATELY (renderer.ts). three's default is
    // 'local-floor', whose origin is the physical floor, so the headset pose
    // arrives 1.2 m seated to 1.7 m standing above it, and since the rig sits at
    // the ship's EYE point that would put the player's head through the canopy
    // roof. 'local' starts the origin at the viewer's head, which is what a
    // seated cockpit wants.
    //
    // Asserted rather than left to the default precisely because it is invisible
    // on a flat screen and obvious the moment you put the headset on.
    expect(record?.referenceSpaces).toContain('local')
    // And never 'viewer', which is head-locked: the world would ride your face.
    expect(record?.referenceSpaces).not.toContain('viewer')

    // Optional features only: a requiredFeatures entry the runtime lacks
    // fails the whole session (research doc 09 §3.8.3). 'local-floor' stays on
    // that list even though we ask for 'local' space: the list is about what
    // the runtime may offer, not about which space we bind.
    expect(record?.requestedFeatures).toContain('local-floor')

    // DEV-558: a session asked for on the title goes on to the hangar's first
    // step (Matt: *"Clicking either should take us to the Hangar"*), and the
    // ENTER VR row stands nowhere in a headset.
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()?.view ?? null,
          ),
        { timeout: 15_000 },
      )
      .toBe('doors')
    await expect.poll(async () => (await titleMenu(page))?.up ?? false).toBe(false)
    expect((await titleVr(page))?.shown, 'no ENTER VR row in a headset').toBe(false)

    expect(problems.list(), problems.list().join('\n')).toEqual([])
  })

  test('the keys reach the ENTER VR row, and Enter takes it', async ({ page }) => {
    knownRed('KR-17')
    // DEV-557's ENTER VR, a ROW since DEV-558 (the title is START and ENTER
    // VR), so the arrow keys and the stick reach it as they reach START, and
    // Enter on it requests the session, as a keyboard player does it. (A GAMEPAD's
    // press, which carries no user activation, is told what works instead:
    // that lives in the state machine and is pinned in `title-vr.test.ts`,
    // because a harness cannot press a real pad.)
    const problems = watchPageErrors(page)
    await page.addInitScript(installFakeXr, { supported: true })
    await page.goto('/')
    await loadSettled(page, READY.timeout)
    const menu = await titleRowsUp(page)
    await expect.poll(async () => (await titleVr(page))?.state ?? null, BOOTED).toBe('enter')
    for (let i = 0; i < menu.rows.length; i++) await hold(page, 'ArrowDown', 250)
    await expect.poll(async () => (await titleVr(page))?.aimed).toBe(true)
    await hold(page, 'Enter', 250)
    await expect
      .poll(async () => (await readRecord(page))?.frames ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(0)
    expect((await readRecord(page))?.sessions).toBe(1)
    expect(problems.list(), problems.list().join('\n')).toEqual([])
  })

  // ── Waiting on later milestones ────────────────────────────────────────
  // Written as skips, not as failing assertions, so the suite stays a signal
  // rather than a thing people learn to ignore.

  test.skip('the comfort menu applies vignette off/light/strong in session (M2)', () => {
    // PORT_PLAN §M2: comfort options do not exist yet. When they land, assert
    // the vignette mesh's opacity per setting with the double installed —
    // whether it *feels* right is a headset job, forever.
  })

  test.skip('a headset with no thumbsticks is refused after session start (M2)', () => {
    // capability-gate.ts `hasFlightSticks` exists; nothing calls it yet.
    // When boot wires it, drive it with installFakeXr({ sticks: false }) — the
    // Apple Vision Pro case: immersive-vr supported, nothing to fly with.
  })

  test.skip('recenter re-seats the rig without moving the world (M2)', () => {
    // Needs the XR rig to be parented to the ship (PORT_PLAN §M2). The double
    // reports a fixed identity head pose, so this is testable here only for
    // "does it throw"; the real check is manual, in a headset.
  })
})
