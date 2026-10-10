/**
 * tests/e2e/xr-laser-pointer.spec.ts — a motion controller aims the menus.
 * DEV-321, NEXT.md #40. Matt, 2026-09-23: *"laser pointer from motion
 * controller plz"*.
 *
 * ── The headset is JavaScript, and the game does not know ────────────────
 *
 * `fixtures/emulated-xr.ts` installs IWER before the first script runs, and the
 * app then takes its real XR path — `requestSession`, the reference space, the
 * input sources, `select` — against a runtime that is not a headset. Nothing
 * under `src/` knows. The controllers are IWER's Quest 3 pair, moved and
 * pressed from here exactly as a hand would move and press them.
 *
 * ── What separates the laser from the head, which is the whole premise ───
 *
 * The HEAD never moves in this file, and that is asserted. IWER starts it at the
 * identity, and a level head in the hangar looks OVER the holotables — they sit
 * 22.8° below the eye, and looking down at them is the neck's job (DEV-264) —
 * while on the pause plate a level head lands on the title band, which by
 * `PANEL_DROP`'s design selects nothing. Both hands start RAISED, on nothing,
 * and the menus are asserted un-aimed in that state. So every selection below
 * moved while the head did not: the controller made it.
 *
 * ── What it proves ────────────────────────────────────────────────────────
 *
 *   1. the room: the right controller, swept, lands on a holotable, the beam
 *      ends on it, and the trigger descends into it. Then the LEFT trigger
 *      takes the laser and — while the right hand is still resting on a table
 *      — descends into NOTHING, because the pull that moves the laser is spent
 *      on moving it. The left hand then aims and commits on its own.
 *   2. the pause plate: no beam in flight; the plate comes up on the left
 *      D-pad button, the right controller picks the COMFORT row the head
 *      cannot reach, and the trigger opens that page.
 *
 * Both take a pinned photograph of the beam, to be LOOKED AT: a beam can be
 * `visible` and pointing at the floor. Set `LASER_SHOTS_DIR` to keep them past
 * the next run — Playwright wipes `test-results/` at the start of every run.
 *
 * ── What IWER cannot tell you ─────────────────────────────────────────────
 *
 * Whether the beam READS in a headset: its width at 1.5 m, the reticle's size,
 * whether depth-test-off over a cockpit strut is comfortable. That is the worn
 * check in DEV-321, and it is why this row is not done until somebody wears it.
 *
 * Tagged `@gpu`: it needs a world, and a world needs a real GPU.
 */
import fs from 'node:fs'
import path from 'node:path'
import { emulatedXrInstalled, installEmulatedXr } from './fixtures/emulated-xr'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { enterVr, loadSettled } from './fixtures/landing'
import { drawState, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

/** 800 x 720 an eye — IWER sizes the canvas from the window (see the fixture). */
test.use({ viewport: { width: 1600, height: 720 }, deviceScaleFactor: 1 })

type Hand = 'left' | 'right'

interface PointerState {
  visible: boolean
  hand: Hand | null
  hit: boolean
  distance: number | null
}

/** The beam as the page has it: `render/xr-pointer.ts` publishes on `userData`. */
const pointer = (page: Page): Promise<PointerState> =>
  page.evaluate(() => {
    const ff = (globalThis as unknown as Ff2GlobalMaybe).__ff2
    const o = ff?.render.rig.getObjectByName('xr-pointer')
    return {
      visible: o?.visible ?? false,
      hand: (o?.userData.hand ?? null) as Hand | null,
      hit: o?.userData.hit === true,
      distance: (o?.userData.distance ?? null) as number | null,
    }
  })

const presenting = (page: Page): Promise<boolean> =>
  page.evaluate(
    () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.render.renderer.xr.isPresenting ?? false,
  )

interface Aim {
  aim: { kind: string } | null
  view: string
  /** The steps this room walks (DEV-382): the variant step is Anniversary's. */
  views: string[]
  vehicles: unknown[]
}
const hangarAim = (page: Page): Promise<Aim | null> =>
  page.evaluate(
    () => ((globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim() ?? null) as Aim | null,
  )

interface Plate {
  open: boolean
  selected: number
  page: string
  rows: { id: string }[]
}
const pausePlate = (page: Page): Promise<Plate | null> =>
  page.evaluate(
    () => ((globalThis as unknown as Ff2GlobalMaybe).__ff2?.pausePlate() ?? null) as Plate | null,
  )

const elapsed = (page: Page): Promise<number> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.mission.elapsed ?? 0)

/** The emulated head's orientation — asserted untouched, because it is the premise. */
const headQuaternion = (page: Page): Promise<number[]> =>
  page.evaluate(() => {
    const q = (
      globalThis as unknown as {
        __emulatedXR: { device: { quaternion: { x: number; y: number; z: number; w: number } } }
      }
    ).__emulatedXR.device.quaternion
    return [q.x, q.y, q.z, q.w]
  })

/**
 * Turn a controller: YAW about the vertical (positive is LEFT, three's
 * convention), then PITCH about the controller's own x (negative is DOWN).
 * The quaternion is `q_yaw * q_pitch`, written out, because the page has no
 * three to borrow and borrowing the port's would be testing it with itself.
 */
const aimController = async (page: Page, hand: Hand, yawDeg: number, pitchDeg: number) => {
  await page.evaluate(
    ({ hand, yawDeg, pitchDeg }) => {
      const r = Math.PI / 360 // half-angle, in radians per degree
      const cy = Math.cos(yawDeg * r)
      const sy = Math.sin(yawDeg * r)
      const cx = Math.cos(pitchDeg * r)
      const sx = Math.sin(pitchDeg * r)
      const c = (
        globalThis as unknown as {
          __emulatedXR: {
            device: {
              controllers: Record<
                string,
                { quaternion: { set: (x: number, y: number, z: number, w: number) => void } }
              >
            }
          }
        }
      ).__emulatedXR.device.controllers[hand]
      c?.quaternion.set(cy * sx, sy * cx, -sy * sx, cy * cx)
    },
    { hand, yawDeg, pitchDeg },
  )
  // Two frames: IWER applies the pose at the next frame start, and the aim is
  // written in the render block of the frame after that.
  await page.waitForTimeout(80)
}

/** Press and release a controller button, the way a finger does it. */
const press = async (page: Page, hand: Hand, button: string) => {
  const set = (value: number) =>
    page.evaluate(
      ({ hand, button, value }) => {
        const c = (
          globalThis as unknown as {
            __emulatedXR: {
              device: {
                controllers: Record<string, { updateButtonValue: (id: string, v: number) => void }>
              }
            }
          }
        ).__emulatedXR.device.controllers[hand]
        c?.updateButtonValue(button, value)
      },
      { hand, button, value },
    )
  await set(1)
  await page.waitForTimeout(150)
  await set(0)
  await page.waitForTimeout(150)
}

/**
 * Sweep a controller until `done` says yes. A SEARCH, not a computed angle —
 * `menu-screen.spec.ts`'s argument: the table layout, the plate's drop and the
 * hand's resting offset are three numbers in three files, and a hard-coded
 * angle would have to be re-derived by whoever moves one of them.
 */
const sweep = async (
  page: Page,
  hand: Hand,
  done: () => Promise<boolean>,
  yaws: readonly number[],
  pitches: readonly number[],
): Promise<{ yaw: number; pitch: number } | null> => {
  for (const yaw of yaws) {
    for (const pitch of pitches) {
      await aimController(page, hand, yaw, pitch)
      if (await done()) return { yaw, pitch }
    }
  }
  return null
}

const range = (from: number, to: number, step: number): number[] => {
  const out: number[] = []
  for (let x = from; step > 0 ? x <= to : x >= to; x += step) out.push(x)
  return out
}

/** Where the photographs go. See the header. */
const shotPath = (name: string, fallback: string): string => {
  const dir = process.env.LASER_SHOTS_DIR
  if (!dir) return fallback
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, name)
}

/** Load, enter the session through the button a player presses, and wait for frames. */
const enterSession = async (page: Page, url: string): Promise<void> => {
  await installEmulatedXr(page, { fovyDeg: 90 })
  await page.goto(url)
  // `#enter-vr` waits for a world as well as a headset (DEV-107).
  await loadSettled(page, 240_000)
  expect(await emulatedXrInstalled(page), 'the emulated runtime took').toBe(true)
  await enterVr(page)
  await expect.poll(() => presenting(page), { timeout: 60_000 }).toBe(true)
}

test.describe('@gpu the laser pointer', () => {
  test.setTimeout(480_000)

  test('the room: a controller aims a holotable, the trigger takes it, the other trigger takes the laser', async ({
    page,
  }, testInfo) => {
    await enterSession(page, `/?title=0&${PINNED}`)
    await expect
      .poll(async () => (await hangarAim(page))?.vehicles.length ?? 0, { timeout: 60_000 })
      .toBeGreaterThan(0)
    const head = await headQuaternion(page)

    // ── the premise: nothing is aimed with the hands raised ─────────────
    await aimController(page, 'right', 0, 30)
    await aimController(page, 'left', 0, 30)
    await page.waitForTimeout(300)
    const rest = await hangarAim(page)
    // DEV-558: the room opens on its doors, in front of the aircraft.
    expect(rest?.view, 'the room opens on its doors').toBe('doors')
    expect(rest?.aim, 'with both hands raised, nothing is aimed').toBe(null)
    const idle = await pointer(page)
    expect(idle.visible, 'the beam is up in the room').toBe(true)
    expect(idle.hand, 'from the right hand, by default').toBe('right')
    expect(idle.hit, 'and on nothing').toBe(false)

    // ── DEV-558: the beam takes SINGLE PLAYER, as it takes every table ───
    //
    // In a headset the hangar is the whole UI, so the first step has to work
    // by the controller's ray exactly as the steps under it do.
    const onKind = (kind: string) => async () => (await hangarAim(page))?.aim?.kind === kind
    const onDoor = (id: string) => async () => {
      const aim = (await hangarAim(page))?.aim as { kind: string; door?: { id: string } } | null
      return aim?.kind === 'door' && aim.door?.id === id
    }
    // DEV-565: to 75 either side. Four doors stand centred on the resting
    // look, so SINGLE PLAYER is 45 degrees left of the HEAD (it was 30 of
    // three), and wider than that from the right hand, which sits right of it.
    const yaws = Array.from({ length: 31 }, (_, i) => (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 5)
    const pitches = range(-5, -50, -2.5)
    const onSingle = await sweep(page, 'right', onDoor('single-player'), yaws, pitches)
    expect(onSingle, 'the right controller reached SINGLE PLAYER').not.toBeNull()
    expect((await pointer(page)).hit, 'the beam is ON the door table').toBe(true)
    await press(page, 'right', 'trigger')
    await expect
      .poll(async () => (await hangarAim(page))?.view, { timeout: 10_000 })
      .toBe('vehicles')

    // ── the right hand finds an aircraft ─────────────────────────────────
    const found = await sweep(page, 'right', onKind('vehicle'), yaws, pitches)
    expect(found, 'the right controller reached an aircraft table').not.toBeNull()
    const on = await pointer(page)
    expect(on.hand).toBe('right')
    expect(on.hit, 'the beam is ON the table').toBe(true)
    // Where the reticle sits: the table's gaze window is ~1.5 m from the eye and
    // the hand starts 0.4 m in front of it. A beam ending at 0.1 m or at 10 m is
    // a distance measured in the wrong frame.
    expect(on.distance ?? 0).toBeGreaterThan(0.6)
    expect(on.distance ?? 99).toBeLessThan(2.5)
    expect(await headQuaternion(page), 'the head never moved').toEqual(head)
    console.info(
      `DEV-321 room: right hand on an aircraft at yaw ${found?.yaw}°, pitch ${found?.pitch}° — ` +
        `beam ${on.distance?.toFixed(3)} m`,
    )

    // ── the photograph, pinned ───────────────────────────────────────────
    console.info(`  draw state: ${drawStateLine(await drawState(page))}`)
    await page.screenshot({
      path: shotPath('laser-room.png', testInfo.outputPath('laser-room.png')),
    })

    // ── the trigger takes it ─────────────────────────────────────────────
    await press(page, 'right', 'trigger')
    // DEV-382: on Anniversary the aircraft opens its VARIANTS, and the beam
    // takes one of those the same way before the plans are up.
    if (rest?.views.includes('variants')) {
      await expect
        .poll(async () => (await hangarAim(page))?.view, { timeout: 10_000 })
        .toBe('variants')
      const onVariant = await sweep(page, 'right', onKind('variant'), yaws, pitches)
      expect(onVariant, 'the right controller reached a variant table').not.toBeNull()
      await press(page, 'right', 'trigger')
    }
    await expect.poll(async () => (await hangarAim(page))?.view, { timeout: 10_000 }).toBe('modes')

    // ── the OTHER trigger takes the laser, and presses nothing ───────────
    //
    // Put the right hand ON a flight-plan table first. That is what makes the
    // next pull a real test: were the moving pull also a commit, it would
    // descend into the table the right hand is resting on.
    const onMode = await sweep(page, 'right', onKind('mode'), yaws, pitches)
    expect(onMode, 'the right hand rests on a flight plan').not.toBeNull()
    await press(page, 'left', 'trigger')
    await expect.poll(async () => (await pointer(page)).hand, { timeout: 5_000 }).toBe('left')
    await page.waitForTimeout(300)
    expect((await hangarAim(page))?.view, 'the pull that moved the laser pressed nothing').toBe(
      'modes',
    )

    // ── and the left hand aims and commits on its own ────────────────────
    const leftFound = await sweep(page, 'left', onKind('mode'), yaws, pitches)
    expect(leftFound, 'the left controller reached a flight plan').not.toBeNull()
    expect((await pointer(page)).hand).toBe('left')
    await press(page, 'left', 'trigger')
    // Down a step: a plan's ranks — or, where the plan's place carries its
    // difficulty (Ring Attack, DEV-420), straight to its places. Which plan the
    // sweep met first is not this test's business; that the commit landed is.
    await expect
      .poll(async () => (await hangarAim(page))?.view, { timeout: 10_000 })
      .toMatch(/^(ranks|courses)$/)
    expect(await headQuaternion(page), 'the head never moved').toEqual(head)
  })

  test('the pause plate: no beam in flight; a controller picks the row the head cannot, and the trigger opens it', async ({
    page,
  }, testInfo) => {
    await enterSession(page, `/?autopilot=1&mission=rookie_01_hoverJet&${PINNED}`)
    // A with the right hand is launch, as on a pad (`input/xr.ts`). The
    // autopilot may already have started it; `startLaunch` is idempotent.
    await press(page, 'right', 'a-button')
    await expect
      .poll(() => elapsed(page), { timeout: 120_000, intervals: [500] })
      .toBeGreaterThan(2)
    const head = await headQuaternion(page)

    // ── no beam while flying ─────────────────────────────────────────────
    for (let i = 0; i < 5; i++) {
      expect((await pointer(page)).visible, 'no beam in flight').toBe(false)
      await page.waitForTimeout(100)
    }

    // ── the plate comes up on the left D-pad button (DEV-207) ─────────────
    //
    // Both hands raised first, so the laser is on nothing when the plate
    // arrives — the premise the row sweep below is measured against.
    await aimController(page, 'right', 0, 30)
    await aimController(page, 'left', 0, 30)
    await press(page, 'left', 'x-button')
    await expect.poll(async () => (await pausePlate(page))?.open, { timeout: 5_000 }).toBe(true)
    await page.waitForTimeout(300)
    const opened = (await pausePlate(page)) as Plate
    // DEV-621: COMFORT is on OPTIONS now; OPTIONS is the root row the hand finds.
    const comfort = opened.rows.findIndex((r) => r.id === 'options')
    expect(comfort, 'the plate has an OPTIONS row').toBeGreaterThan(0)
    expect(opened.selected, 'the plate opens on RESUME, and a raised hand moves nothing').toBe(0)
    const up = await pointer(page)
    expect(up.visible, 'the beam is up with the plate').toBe(true)
    expect(up.hit, 'and on nothing').toBe(false)

    // ── the right hand finds COMFORT ─────────────────────────────────────
    const onComfort = async () => {
      const p = await pausePlate(page)
      return p?.selected === comfort && (await pointer(page)).hit
    }
    const found = await sweep(
      page,
      'right',
      onComfort,
      [0, 5, 10, 15, 20, 25, 30, -5, -10],
      range(10, -60, -2.5),
    )
    expect(found, 'the right controller reached the COMFORT row').not.toBeNull()
    const on = await pointer(page)
    expect(on.hand).toBe('right')
    // The plate is 0.86 m in front of the eye and the hand starts 0.4 m in
    // front of it, so the beam is well under a metre — and never zero.
    expect(on.distance ?? 0).toBeGreaterThan(0.2)
    expect(on.distance ?? 99).toBeLessThan(1.2)
    expect(await headQuaternion(page), 'the head never moved').toEqual(head)
    console.info(
      `DEV-321 plate: right hand on COMFORT (row ${comfort}) at yaw ${found?.yaw}°, ` +
        `pitch ${found?.pitch}° — beam ${on.distance?.toFixed(3)} m`,
    )

    // For the photograph, walk the beam in from the plate's edge toward the
    // row's middle while it stays on COMFORT. The sweep stops at the FIRST hit,
    // which from a hand 0.25 m right of centre is the row's right end — where
    // the ring sits on the row's own gold outline and cannot be seen. The first
    // pinned photo showed exactly that.
    const yaw0 = found?.yaw ?? 0
    const pitch0 = found?.pitch ?? 0
    let photoYaw = yaw0
    for (const step of [4, 8, 12, 16, 20]) {
      await aimController(page, 'right', yaw0 + step, pitch0)
      if (!(await onComfort())) break
      photoYaw = yaw0 + step
    }
    await aimController(page, 'right', photoYaw, pitch0)
    expect(await onComfort(), 'still on COMFORT for the photograph').toBe(true)

    console.info(
      `  photographed at yaw ${photoYaw}° — draw state: ${drawStateLine(await drawState(page))}`,
    )
    await page.screenshot({
      path: shotPath('laser-plate.png', testInfo.outputPath('laser-plate.png')),
    })

    // ── the trigger opens it ─────────────────────────────────────────────
    await press(page, 'right', 'trigger')
    await expect
      .poll(async () => (await pausePlate(page))?.page, { timeout: 5_000 })
      .toBe('options')
  })
})
