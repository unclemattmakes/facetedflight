/**
 * CHANGE VIEW, in the real build, on the real camera (DEV-128).
 *
 * `spring-arm.test.ts` proves the arm's geometry against fake walls and
 * `third-person-input.test.ts` holds the bindings against 2016. What neither
 * can see is the WIRING — that V reaches the toggle, that the fade runs, that
 * the camera actually leaves the seat, that the player's own hull is what it
 * looks at, and that the readout comes with it — which is where every real
 * finding in this port has come from. So this presses V on a flying ship and
 * measures the frame through `__ff2`:
 *
 *   · the camera's WORLD position ends up metres behind the ship, not at the
 *     eye 1.27 m ahead of the origin;
 *   · the exterior hull is visible and the cockpit mesh is not (2016's
 *     `shipArt` swap);
 *   · the HUD's parent is the camera (the screen-space plate);
 *   · on Classic the toggle still works and the arm reports NO spring — the
 *     camera is 2016's OWN chase, which is not the parked `CamRoot_3rdPerson`
 *     and is not rigid: it damps toward a target 12.5 m back and TRAILS, so it
 *     sits further out the faster the ship goes (DEV-150, DEV-156);
 *   · pressing V again puts the eye back in the seat.
 *
 * And it photographs the view at three speeds into `CAMERA_SHOT_DIR` when that
 * is set — the row's frames — because a camera that is right by every number
 * and wrong to look at has happened here before (DEV-044).
 *
 * `@gpu`: it flies.
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { expect, type Page, test } from './fixtures/test'

/**
 * The shipped Anniversary arm, read from the preset rather than written here:
 * DEV-357 moved it in from 2016's 12.5 m to 8 m and this spec's old "> 10 m"
 * went stale with it. The VALUE is pinned once, in `spring-arm.test.ts`.
 */
const ANNIVERSARY_ARM: number = JSON.parse(
  fs.readFileSync(path.resolve('content/editions/anniversary.json'), 'utf8'),
).render.thirdPerson.armLength

interface Probe {
  elapsed: number
  edition: string
  fov: number
  speed: number
  wanted: boolean
  live: boolean
  spring: boolean
  armLength: number
  /** Camera WORLD position and the ship's, three space. */
  camera: [number, number, number]
  ship: [number, number, number]
  /** Metres from the camera to the ship origin. */
  distance: number
  cockpitVisible: boolean | null
  hullVisible: boolean | null
  /**
   * The hull is visible AND puts colour on screen. Since DEV-305 the seat keeps
   * the hull visible with `colorWrite` off so it can cast, so `hullVisible`
   * alone no longer means "you can see it".
   */
  hullColour: boolean | null
  hudParent: string | null
}

const probe = async (page: Page): Promise<Probe> =>
  (await page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: {
        mission: { elapsed: number }
        edition: { current: { id: string } }
        render: {
          camera: {
            fov: number
            /** Updated by every render; the translation column is the world position. */
            matrixWorld: { elements: ArrayLike<number> }
          }
        }
        flight: () => {
          object: {
            position: { x: number; y: number; z: number }
            getObjectByName(n: string):
              | {
                  visible: boolean
                  traverse(f: (o: { material?: { colorWrite?: boolean } }) => void): void
                }
              | undefined
          }
          hud: { object: { parent: { name?: string; type?: string } | null } }
          jet: { body: { velocity: { x: number; y: number; z: number } } }
        } | null
        thirdPerson: () => { wanted: boolean; live: boolean; spring: boolean; armLength: number }
      }
    }
    const app = w.__ff2
    const f = app?.flight() ?? null
    const m = app?.render.camera.matrixWorld.elements
    const cam = m ? { x: m[12] ?? 0, y: m[13] ?? 0, z: m[14] ?? 0 } : { x: 0, y: 0, z: 0 }
    const ship = f ? f.object.position : { x: 0, y: 0, z: 0 }
    const v = f?.jet.body.velocity
    const tp = app?.thirdPerson() ?? { wanted: false, live: false, spring: false, armLength: 0 }
    const parent = f?.hud.object.parent ?? null
    return {
      elapsed: app?.mission.elapsed ?? 0,
      edition: app?.edition.current.id ?? '',
      fov: app?.render.camera.fov ?? -1,
      speed: v ? Math.hypot(v.x, v.y, v.z) : 0,
      wanted: tp.wanted,
      live: tp.live,
      spring: tp.spring,
      armLength: tp.armLength,
      camera: [cam.x, cam.y, cam.z],
      ship: [ship.x, ship.y, ship.z],
      distance: Math.hypot(cam.x - ship.x, cam.y - ship.y, cam.z - ship.z),
      cockpitVisible: f?.object.getObjectByName('ship_first_person')?.visible ?? null,
      hullVisible: f?.object.getObjectByName('ship_third_person')?.visible ?? null,
      hullColour: (() => {
        const hull = f?.object.getObjectByName('ship_third_person')
        if (!hull) return null
        let colour = false
        hull.traverse((o) => {
          if (o.material && o.material.colorWrite !== false) colour = true
        })
        return hull.visible && colour
      })(),
      hudParent: parent ? parent.name || parent.type || null : null,
    }
  })) as Probe

/** Held, not tapped — `pause.spec.ts` says why, twice. */
const holdKey = (page: Page, key: string): Promise<void> =>
  keysHold(page, key, { down: 200, settle: 200 })

/** Boot, launch, and wait for the clock to be genuinely moving. */
const flyUntilRunning = async (page: Page, url: string) => {
  await page.goto(url)
  await firstPress(page)
  await missionReady(page, 180_000)
  await focusCanvas(page)
  await holdKey(page, 'Enter')
  await expect
    .poll(async () => (await probe(page)).elapsed, { timeout: 90_000, intervals: [500] })
    .toBeGreaterThan(2)
  const mark = (await probe(page)).elapsed
  await expect
    .poll(async () => (await probe(page)).elapsed, { timeout: 60_000, intervals: [250] })
    .toBeGreaterThan(mark)
}

const SHOT_DIR = process.env.CAMERA_SHOT_DIR

const shoot = async (page: Page, name: string): Promise<void> => {
  if (!SHOT_DIR) return
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const p = await probe(page)
  await page.locator('#viewport').screenshot({
    path: path.join(SHOT_DIR, `${name}-${p.edition}-${Math.round(p.speed)}mps.png`),
  })
}

test.describe('@gpu CHANGE VIEW — the third-person camera', () => {
  test.setTimeout(300_000)

  test('anniversary: V puts the spring arm behind the ship, the hull on, the HUD on the lens', async ({
    page,
  }) => {
    await flyUntilRunning(page, '/?autopilot=1&xr=off')
    const seat = await probe(page)
    expect(seat.edition).toBe('anniversary')
    expect(seat.live).toBe(false)
    // In the seat the eye is `EYE`, 1.27 m ahead of the ship origin and 0.86 up.
    expect(seat.distance).toBeLessThan(2)
    expect(seat.cockpitVisible).toBe(true)
    // DEV-305: from the seat the hull stays visible to cast, and draws no colour.
    expect(seat.hullColour).toBe(false)
    await shoot(page, 'seat')

    await holdKey(page, 'KeyV')
    // The flip happens under the 0.12 s curtain, so poll rather than assert.
    await expect.poll(async () => (await probe(page)).live, { timeout: 5_000 }).toBe(true)
    // Let the arm settle for a moment, then measure.
    await page.waitForTimeout(1_500)
    const out = await probe(page)
    expect(out.spring).toBe(true)
    // Behind the ship by the arm, give or take the lag and the pivot.
    // Metres behind, at least most of the arm. The old bound was 10 m
    // against a 12.5 m arm; this keeps that 0.8 of the arm as the margin.
    expect(out.distance).toBeGreaterThan(ANNIVERSARY_ARM * 0.8)
    expect(out.distance).toBeLessThan(60)
    expect(out.armLength).toBeGreaterThan(3)
    // 2016's shipArt swap: the exterior hull is what the lens sees.
    expect(out.cockpitVisible).toBe(false)
    expect(out.hullVisible).toBe(true)
    expect(out.hullColour, 'and out here it is drawn in colour').toBe(true)
    // The readout rides the lens.
    expect(out.hudParent).toMatch(/camera/i)
    await shoot(page, 'chase-early')

    // Two more frames as the autopilot gets going: the row's three speeds.
    await page.waitForTimeout(6_000)
    await shoot(page, 'chase-mid')
    await page.waitForTimeout(8_000)
    const fast = await probe(page)
    await shoot(page, 'chase-fast')
    expect(fast.live).toBe(true)
    expect(fast.distance).toBeGreaterThan(ANNIVERSARY_ARM * 0.8)

    // And back into the seat.
    await holdKey(page, 'KeyV')
    await expect.poll(async () => (await probe(page)).live, { timeout: 5_000 }).toBe(false)
    await page.waitForTimeout(500)
    const back = await probe(page)
    expect(back.distance).toBeLessThan(2)
    expect(back.cockpitVisible).toBe(true)
    expect(back.hullColour).toBe(false)
    expect(back.hudParent).not.toMatch(/camera/i)
  })

  test('classic: the toggle gives 2016’s OWN chase — 12.5 m plus a trail, no spring, one fov', async ({
    page,
  }) => {
    // This test used to assert 8.5–9.6 m and pass, which is how Classic shipped
    // the PARKED pose for four sessions: `CamRoot_3rdPerson` is where
    // `CamChanger` puts the rig, not where the constraint on it then flies the
    // rig to. The band below is the one thing the old camera could never
    // satisfy, and the second half of the test is the reason — a rigid mount is
    // the same distance at every speed. DEV-150 found it, DEV-156 fixed it.
    await flyUntilRunning(page, '/?autopilot=1&xr=off&edition=classic')
    expect((await probe(page)).edition).toBe('classic')
    await holdKey(page, 'KeyV')
    await expect.poll(async () => (await probe(page)).live, { timeout: 5_000 }).toBe(true)
    await page.waitForTimeout(1_000)
    const out = await probe(page)
    expect(out.spring).toBe(false)
    // The target is 12.62 m and the damp adds v·0.066 on top, so the camera is
    // past the target at any speed at all — and nowhere near the 9.06 m parking
    // space, which is the assertion that matters.
    expect(out.distance).toBeGreaterThan(12.6)
    expect(out.distance).toBeLessThan(40)
    expect(out.fov).toBe(70)
    expect(out.hullVisible).toBe(true)
    await shoot(page, 'classic-chase')
    // Fly on, and the autopilot speeds up. A TRAIL moves with the speed; the
    // parked pose did not, and could not have passed this.
    const before = await probe(page)
    await page.waitForTimeout(8_000)
    const later = await probe(page)
    expect(later.distance).toBeGreaterThan(12.6)
    expect(later.distance).toBeLessThan(40)
    expect(later.fov).toBe(70)
    // The camera's distance tracks the ship's speed, whichever way the speed
    // went between the two samples — an assertion about the RELATIONSHIP, so it
    // does not depend on the autopilot still accelerating at second 9.
    const dSpeed = later.speed - before.speed
    const dDistance = later.distance - before.distance
    if (Math.abs(dSpeed) > 10) expect(Math.sign(dDistance)).toBe(Math.sign(dSpeed))
    await shoot(page, 'classic-chase-fast')
  })

  test('?camera=third boots behind the ship, and the spectator views place the player’s ship', async ({
    page,
  }) => {
    // The DEV-114 fix rides along: `?view=chase&chase=player` is a spectator
    // view, and before this the player's art sat at the ORIGIN in every one
    // of them. Now `flight.render` runs there too, so the ship object is where
    // the sim has it — hundreds of metres from (0, 0, 0) on int_01.
    await page.goto('/?autopilot=1&xr=off&view=chase&chase=player')
    await firstPress(page)
    await missionReady(page, 180_000)
    await expect
      .poll(async () => (await probe(page)).elapsed, { timeout: 90_000, intervals: [500] })
      .toBeGreaterThan(2)
    const p = await probe(page)
    expect(Math.hypot(...p.ship)).toBeGreaterThan(100)

    await page.goto('/?autopilot=1&xr=off&camera=third')
    await firstPress(page)
    await missionReady(page, 180_000)
    await expect
      .poll(async () => (await probe(page)).live, { timeout: 90_000, intervals: [500] })
      .toBe(true)
    expect((await probe(page)).wanted).toBe(true)
  })
})
