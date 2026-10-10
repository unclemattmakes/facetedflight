/**
 * DEV-897 (Matt, 2026-10-10, after wearing 0.28.0): the hangar's OPTIONS plate
 * "is positioned in an odd place - plz make sure it's positioned the same as in the
 * game (i noticed this especially in VR)".
 *
 * The cockpit's pause plate hangs 0.86 m ahead of the eye and 0.18 m below it, upright
 * and square to the view (`render/pause.ts` `pausePlateOffset`). So the plate's origin,
 * read in the CAMERA's own frame, is (0, -0.18, -0.86) there. This reads the hangar's
 * plate in the camera's frame the same way, flat and in an emulated headset, and
 * photographs both. Photographs are pinned (`PINNED`) and go to `OPTIONS_POSE_DIR` when it is
 * set, because Playwright wipes `test-results/` at the start of every run.
 *
 * The headset is IWER (`fixtures/emulated-xr.ts`): the page takes its real XR path. It
 * cannot say how the plate reads on a worn head; that is Matt's.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { bootReady } from './fixtures/boot'
import { emulatedXrInstalled, installEmulatedXr } from './fixtures/emulated-xr'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { pressDoor } from './fixtures/hangar'
import { enterVr, firstPress, loadSettled } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, test } from './fixtures/test'
import { toHangar } from './fixtures/title'

/** The pause plate's offset from the eye, metres: `PANEL_DROP` below, `PANEL_DISTANCE` ahead. */
const COCKPIT = { y: -0.18, z: -0.86 }
const TOLERANCE_M = 0.03

interface PlateInCameraFrame {
  up: boolean
  /** The plate's origin in the camera's frame. */
  at: [number, number, number]
  /** The plate's face (+z) in the camera's frame: toward the eye is +z. */
  facing: [number, number, number]
  /** The plate's up (+y) in the camera's frame. */
  upward: [number, number, number]
}

/** The hangar's OPTIONS plate, read in the camera's frame. */
const plateInCameraFrame = (page: Page): Promise<PlateInCameraFrame> =>
  page.evaluate(() => {
    const ff = (globalThis as unknown as Ff2GlobalMaybe).__ff2
    if (!ff) throw new Error('no __ff2')
    type V3 = { x: number; y: number; z: number }
    type Obj = {
      name: string
      visible: boolean
      traverse: (f: (o: Obj) => void) => void
      getWorldPosition: (t: unknown) => V3
      matrixWorld: { elements: number[] }
    }
    const stage = ff.stage() as unknown as Obj
    let plate: Obj | null = null
    stage.traverse((o) => {
      if (o.name === 'hangar-options-plate' && o.visible) plate = o
    })
    if (plate === null) return { up: false, at: [0, 0, 0], facing: [0, 0, 0], upward: [0, 0, 0] }
    const cam = ff.render.camera
    cam.updateWorldMatrix(true, false)
    // The camera's world matrix is a rigid transform: invert by transposing the rotation.
    const c = cam.matrixWorld.elements
    const p = (plate as Obj).matrixWorld.elements
    const toCam = (
      x: number,
      y: number,
      z: number,
      translate: boolean,
    ): [number, number, number] => {
      const dx = x - (translate ? (c[12] ?? 0) : 0)
      const dy = y - (translate ? (c[13] ?? 0) : 0)
      const dz = z - (translate ? (c[14] ?? 0) : 0)
      return [
        dx * (c[0] ?? 0) + dy * (c[1] ?? 0) + dz * (c[2] ?? 0),
        dx * (c[4] ?? 0) + dy * (c[5] ?? 0) + dz * (c[6] ?? 0),
        dx * (c[8] ?? 0) + dy * (c[9] ?? 0) + dz * (c[10] ?? 0),
      ]
    }
    const unit = (v: [number, number, number]): [number, number, number] => {
      const n = Math.hypot(v[0], v[1], v[2]) || 1
      return [v[0] / n, v[1] / n, v[2] / n]
    }
    return {
      up: true,
      at: toCam(p[12] ?? 0, p[13] ?? 0, p[14] ?? 0, true),
      facing: unit(toCam(p[8] ?? 0, p[9] ?? 0, p[10] ?? 0, false)),
      upward: unit(toCam(p[4] ?? 0, p[5] ?? 0, p[6] ?? 0, false)),
    }
  })

const shot = async (page: Page, name: string): Promise<void> => {
  const dir = process.env.OPTIONS_POSE_DIR
  if (!dir) return
  fs.mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: path.join(dir, name) })
}

type Emu = {
  __emulatedXR: {
    device: {
      controllers: Record<
        string,
        {
          quaternion: { set: (x: number, y: number, z: number, w: number) => void }
          updateButtonValue: (id: string, v: number) => void
        }
      >
    }
  }
}

/** Point the right controller: YAW about the vertical, then PITCH (negative is down), as xr-laser-pointer.spec.ts does. */
const aimRight = async (page: Page, yawDeg: number, pitchDeg: number): Promise<void> => {
  await page.evaluate(
    ({ yawDeg, pitchDeg }) => {
      const r = Math.PI / 360
      const cy = Math.cos(yawDeg * r)
      const sy = Math.sin(yawDeg * r)
      const cx = Math.cos(pitchDeg * r)
      const sx = Math.sin(pitchDeg * r)
      const c = (globalThis as unknown as Emu).__emulatedXR.device.controllers.right
      c?.quaternion.set(cy * sx, sy * cx, -sy * sx, cy * cx)
    },
    { yawDeg, pitchDeg },
  )
  await page.waitForTimeout(80)
}

/** Sweep the right hand until the beam is on the OPTIONS door, then pull the trigger. */
const triggerOptionsDoor = async (page: Page): Promise<void> => {
  const onOptions = async (): Promise<boolean> => {
    const aim = (await page.evaluate(
      () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()?.aim ?? null,
    )) as { kind: string; door?: { id: string } } | null
    return aim?.kind === 'door' && aim.door?.id === 'options'
  }
  const yaws = Array.from({ length: 31 }, (_, i) => (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 5)
  for (const yaw of yaws) {
    for (let pitch = -5; pitch >= -50; pitch -= 2.5) {
      await aimRight(page, yaw, pitch)
      if (await onOptions()) {
        const set = (v: number) =>
          page.evaluate((v) => {
            ;(
              globalThis as unknown as Emu
            ).__emulatedXR.device.controllers.right?.updateButtonValue('trigger', v)
          }, v)
        await set(1)
        await page.waitForTimeout(150)
        await set(0)
        return
      }
    }
  }
  throw new Error('the right controller never reached the OPTIONS door')
}

const openOptions = async (page: Page, headset = false): Promise<PlateInCameraFrame> => {
  if (headset) await triggerOptionsDoor(page)
  else await pressDoor(page, 'options')
  await expect.poll(async () => (await plateInCameraFrame(page)).up, { timeout: 30_000 }).toBe(true)
  await page.waitForTimeout(1_200)
  return plateInCameraFrame(page)
}

const expectCockpitPose = (read: PlateInCameraFrame, where: string): void => {
  const [x, y, z] = read.at
  console.log(`OPTIONS-POSE ${where} ${JSON.stringify(read)}`)
  expect(Math.abs(x), `${where}: dead ahead`).toBeLessThan(TOLERANCE_M)
  expect(y, `${where}: ${-COCKPIT.y} m below the eye`).toBeCloseTo(COCKPIT.y, 1)
  expect(Math.abs(y - COCKPIT.y), `${where}: height`).toBeLessThan(TOLERANCE_M)
  expect(Math.abs(z - COCKPIT.z), `${where}: ${-COCKPIT.z} m ahead`).toBeLessThan(TOLERANCE_M)
  // Square to the view: the face points back along the camera's +z, the card's top along +y.
  expect(read.facing[2], `${where}: faces the viewer`).toBeGreaterThan(0.99)
  expect(read.upward[1], `${where}: upright in the view`).toBeGreaterThan(0.99)
}

test.describe('@gpu the hangar OPTIONS plate stands where the pause plate does (DEV-897)', () => {
  test.setTimeout(420_000)

  test('flat', async ({ page }) => {
    await page.goto(`/?xr=off&${PINNED}`)
    await bootReady(page, 240_000)
    await firstPress(page)
    await toHangar(page)
    const read = await openOptions(page)
    await shot(page, 'flat-hangar-options.png')
    expectCockpitPose(read, 'flat')
  })

  test.describe('headset', () => {
    // 800 x 720 an eye: IWER sizes the canvas from the window.
    test.use({ viewport: { width: 1600, height: 720 }, deviceScaleFactor: 1 })
    test('in an emulated headset', async ({ page }) => {
      await installEmulatedXr(page, { fovyDeg: 90 })
      await page.goto(`/?title=0&${PINNED}`)
      await loadSettled(page, 240_000)
      expect(await emulatedXrInstalled(page), 'the emulated runtime took').toBe(true)
      await enterVr(page)
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (globalThis as unknown as Ff2GlobalMaybe).__ff2?.render.renderer.xr.isPresenting ??
                false,
            ),
          { timeout: 60_000 },
        )
        .toBe(true)
      const read = await openOptions(page, true)
      await shot(page, 'vr-hangar-options.png')
      expectCockpitPose(read, 'headset')
    })
  })
})
