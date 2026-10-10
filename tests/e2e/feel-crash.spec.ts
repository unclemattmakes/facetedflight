/**
 * The crash's one timeline, and the feel layer in a live game (DEV-636, DEV-643,
 * DEV-797): hold, splash, curtain.
 *
 * On the crash tick the last frame is HELD for about 100 ms (a render hold: the
 * page's rAF keeps firing and the renderer does not draw, so
 * `renderer.info.render.frame` stands still while `performance.now()` moves),
 * the world then draws live while the sim's hold runs so the player sees their
 * own wreck, and the curtain starts about 0.4 s after the crash. The sim is
 * never paused: the crash's own `heldFor` keeps counting through the hold.
 *
 * Also asserted here, in the real build: a crash adds camera trauma and it
 * decays to exactly zero, and the shake leaves the camera's LOCAL pose where the
 * game put it (it is worn for one draw and taken off).
 *
 * The player is put into the ground by the harness the way `splash.spec.ts` puts
 * a jet into the sea: `flight.placeAt` with a velocity, then the sim does the
 * contact and the crash rule. Nothing about the game's path is switched.
 *
 * `@gpu`; headed; pinned `adaptive=0&quality=high` so the frame rate is not the
 * thing under test.
 */

import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import type { Ff2Global } from './fixtures/ff2'
import { hold } from './fixtures/freeze'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, test } from './fixtures/test'

const MISSION = 'int_01_hoverJet'

interface Sample {
  t: number
  frames: number
  fade: number
  count: number
  phase: string
  trauma: number
  camX: number
  camY: number
  camZ: number
}

test.describe('@gpu the crash timeline', () => {
  test.setTimeout(420_000)

  test(`hold, splash, curtain on ${MISSION}`, async ({ page }) => {
    await page.goto(
      `/?xr=off&title=0&menu=0&ride=0&mission=${MISSION}&edition=anniversary&${PINNED}`,
    )
    await firstPress(page)
    await missionReady(page, 240_000)
    await focusCanvas(page)
    await hold(page, 'Enter')
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.launch().phase), {
        timeout: 120_000,
      })
      .toBe('flying')

    // The recorder watches every page frame and changes nothing in the game.
    await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: the game's own handles
      const w = globalThis as any
      const log: Sample[] = []
      const watch = (): void => {
        const f = w.__ff2.fade()
        const cam = w.__ff2.render.camera
        log.push({
          t: performance.now(),
          frames: w.__ff2.render.renderer.info.render.frame,
          fade: f.amount,
          count: w.__ff2.crash().count,
          phase: w.__ff2.crash().phase,
          trauma: w.__ff2.feel().cameraShake.trauma,
          camX: cam.position.x,
          camY: cam.position.y,
          camZ: cam.position.z,
        })
        requestAnimationFrame(watch)
      }
      requestAnimationFrame(watch)
      w.__crashLog = log
    })
    // Let it settle in flight, then drive the ship into whatever is below.
    await page.waitForTimeout(1500)
    const before = await page.evaluate(
      () => (globalThis as unknown as Ff2Global).__ff2.crash().count,
    )
    const placed = await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: the game's own handles
      const w = globalThis as any
      const flight = w.__ff2.flight()
      if (!flight) return false
      const b = flight.jet.body
      flight.placeAt(
        { x: b.position.x, y: b.position.y, z: b.position.z },
        { x: 0, y: 0, z: 0, w: 1 },
        { x: 0, y: -260, z: 0 },
      )
      return true
    })
    expect(placed, 'no player ship to place').toBe(true)
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.crash().count), {
        timeout: 30_000,
        intervals: [20],
      })
      .toBeGreaterThan(before)
    // The whole beat: hold, splash, curtain, and back.
    await page.waitForTimeout(2500)

    const log = (await page.evaluate(
      () => (globalThis as unknown as { __crashLog: Sample[] }).__crashLog,
    )) as Sample[]
    const first = log.findIndex((s) => s.count > before)
    expect(first, 'the recorder saw the crash').toBeGreaterThan(0)
    const t0 = (log[first] as Sample).t

    // (1) The hit-stop: a run of page frames, right after the crash, in which the
    // renderer did not draw. Its length is the gap between the last frame that
    // advanced and the next one that did.
    let stillFrom = -1
    let stillTo = -1
    for (let i = first; i < log.length - 1; i++) {
      const a = log[i] as Sample
      const b = log[i + 1] as Sample
      if (b.frames === a.frames) {
        if (stillFrom < 0) stillFrom = i
        stillTo = i + 1
      } else if (stillFrom >= 0) break
    }
    expect(stillFrom, 'a frame was held after the crash').toBeGreaterThanOrEqual(first)
    const heldMs = (log[stillTo] as Sample).t - (log[stillFrom] as Sample).t
    console.log(
      `DEV-643 hit-stop: ${heldMs.toFixed(0)} ms held, begun ${((log[stillFrom] as Sample).t - t0).toFixed(0)} ms after the crash was seen`,
    )
    expect(heldMs, 'the hold is about 100 ms').toBeGreaterThanOrEqual(70)
    expect(heldMs, 'and not a freeze').toBeLessThan(300)

    // (2) The camera shake: trauma was added at the blow and decayed to zero.
    const peak = Math.max(...log.slice(first).map((s) => s.trauma))
    expect(peak, 'the crash shook the camera').toBeGreaterThan(0.5)
    expect((log[log.length - 1] as Sample).trauma, 'and it decayed to zero').toBe(0)

    // (3) The shake is worn for one draw and taken off: between frames the camera's
    // local position is exactly what the game put there (the cockpit rig has the
    // camera at its local origin).
    for (const s of log.slice(first)) {
      expect(Math.abs(s.camX) + Math.abs(s.camY) + Math.abs(s.camZ)).toBe(0)
    }

    // (4) The curtain waits: clear for about 0.4 s of the crash, then it comes
    // down, reaches solid black, and goes back to clear.
    const down = log.findIndex((s, i) => i >= first && s.fade > 0.01)
    expect(down, 'the curtain came down').toBeGreaterThan(first)
    const waitedMs = (log[down] as Sample).t - t0
    console.log(`DEV-797 curtain starts ${waitedMs.toFixed(0)} ms after the crash`)
    expect(waitedMs, 'the player watched the wreck first').toBeGreaterThan(300)
    expect(waitedMs, 'and not for ever').toBeLessThan(700)
    const solid = log.findIndex((s, i) => i >= down && s.fade >= 1)
    expect(solid, 'it reached solid black').toBeGreaterThan(down)
    const clear = log.findIndex((s, i) => i >= solid && s.fade <= 0)
    expect(clear, 'and came back to clear').toBeGreaterThan(solid)
  })
})
