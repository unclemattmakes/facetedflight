/**
 * tests/e2e/lift-seal.spec.ts — riding up, nothing of the world is inside the
 * shaft (DEV-460).
 *
 * Matt, 2026-09-27: *"right now player eyes visibly collde through geo (like the
 * ocean)"*. On `int_01_hoverJet` the sea stood in the corners of 2016's shaft
 * and met the eye at eye level; on `rookie_01_hoverJet` the meadow came on
 * inside the shaft at the reveal and was seen down the gap round the lift.
 *
 * ── The claim, as a picture ───────────────────────────────────────────────
 *
 * While the eye is below the shaft's rim, the shaft is sealed (DEV-106/438) and
 * the only way out is up, through the mouth, where the sea never is and the
 * ground is only above the rim. So:
 *
 *   the SEA   drawn or not drawn, the frame is the same, all of it;
 *   the LAND  drawn or not drawn, the frame below the horizon is the same.
 *
 * "Not drawn" is the surface's materials writing neither colour nor depth — GL
 * state, not a program, and not `visible`, which the frame loop writes every
 * frame for the land and which would also take the land out of the shadow
 * pass. Everything else in the frame stands still: the ride is frozen on a
 * paced clock (`lift-judder.spec.ts`'s pacer, with a stop), so two shots of
 * one state differ only by the surface under test. Each state is also shot
 * twice as it is, and that difference is the noise floor the comparison
 * stands on.
 *
 * `@gpu`: a real world and a GPU that is not SwiftShader.
 *
 *   LIFT_SEAL_OUT=<dir> E2E_PORT=<yours> npx playwright test tests/e2e/lift-seal.spec.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { missionReady } from './fixtures/boot'
import { captureCanvas, focusCanvas } from './fixtures/canvas'
import { hold } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

test.describe.configure({ timeout: 420_000 })

const OUT = process.env.LIFT_SEAL_OUT ?? ''

/** A channel step bigger than this is a pixel that changed. */
const STEP = 12
/** Pixels a surface may change beyond the noise floor before it is "in the shaft". */
const SLACK = 25

/** `lift-judder.spec.ts`'s pacer, with a STOP: while `frozen` the clock stands still. */
const installPacer = () => {
  const realRaf = window.requestAnimationFrame.bind(window)
  const queue = new Map<number, FrameRequestCallback>()
  let nextId = 1
  let pending = 0
  let synth = 0
  let started = false
  const pace = {
    hz: 60,
    frozen: false,
    after: null as ((time: number) => void) | null,
  }
  const tick = (real: number) => {
    pending = 0
    if (!started) {
      synth = real
      started = true
    }
    if (!pace.frozen) synth += 1000 / pace.hz
    const time = synth
    const due = [...queue.values()]
    queue.clear()
    for (const cb of due) {
      try {
        cb(time)
      } catch (error) {
        setTimeout(() => {
          throw error
        })
      }
    }
    pace.after?.(time)
    if (!pending && (queue.size > 0 || pace.after)) pending = realRaf(tick)
  }
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = nextId++
    queue.set(id, cb)
    if (!pending) pending = realRaf(tick)
    return id
  }
  window.cancelAnimationFrame = (id: number) => {
    queue.delete(id)
  }
  ;(globalThis as unknown as { __pace: typeof pace }).__pace = pace
}

/** Stop the clock at each of `rises` (ascending) as the lift passes it. */
const armStops = (page: Page, rises: readonly number[]): Promise<boolean> =>
  page.evaluate((targets) => {
    // biome-ignore lint/suspicious/noExplicitAny: the dev handle and the pacer
    const w = globalThis as any
    const queue = [...targets]
    w.__stop = { at: null as number | null, rimClearedAt: null as number | null }
    w.__pace.after = () => {
      const l = w.__ff2.launch()
      if (!w.__pace.frozen && queue.length > 0 && l.rise >= (queue[0] as number)) {
        w.__pace.frozen = true
        w.__stop.at = queue.shift()
      }
      if (queue.length === 0 && !w.__pace.frozen) w.__pace.after = null
    }
    return typeof w.__ff2?.launch === 'function'
  }, rises)

const stoppedAt = (page: Page): Promise<number | null> =>
  page.evaluate(() => (globalThis as unknown as { __stop: { at: number | null } }).__stop.at)

const resume = (page: Page): Promise<void> =>
  page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: the pacer
    const w = globalThis as any
    w.__stop.at = null
    w.__pace.frozen = false
  })

/**
 * The eye's world height, the shaft's rim (the top of 2016's shaft as drawn:
 * DEV-443 holds it to the rim), and which way the camera looks (y of its
 * forward).
 */
const probe = (page: Page) =>
  page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: the dev handle
    const ff = (globalThis as any).__ff2
    const cam = ff.render.camera
    const eye = cam.getWorldPosition(cam.position.clone())
    const fwd = cam.getWorldDirection(cam.position.clone())
    // biome-ignore lint/suspicious/noExplicitAny: scene nodes
    let shaft: any = null
    // biome-ignore lint/suspicious/noExplicitAny: scene nodes
    ff.render.scene.traverse((o: any) => {
      if (o.name === 'elevator-shaft-2016') shaft = o
    })
    let rimY = Number.NaN
    if (shaft) {
      shaft.updateWorldMatrix(true, false)
      shaft.geometry.computeBoundingBox()
      const top = shaft.geometry.boundingBox.max.clone().applyMatrix4(shaft.matrixWorld)
      rimY = top.y
    }
    return {
      rise: ff.launch().rise as number,
      eyeY: eye.y as number,
      rimY,
      lookY: fwd.y as number,
    }
  })

/**
 * Turn a surface's colour and depth writes off, or back on: `ocean`, or the
 * land's `chunk_` meshes. Returns how many materials it touched, so a spec that
 * found nothing says so rather than comparing a frame with itself.
 */
const setDrawn = (page: Page, which: 'ocean' | 'land', drawn: boolean): Promise<number> =>
  page.evaluate(
    ({ which, drawn }) => {
      // biome-ignore lint/suspicious/noExplicitAny: the dev handle
      const t = (globalThis as any).__ff2.terrain()
      const group = which === 'ocean' ? t?.ocean?.group : t?.terrain?.group
      if (!group) return 0
      let n = 0
      // biome-ignore lint/suspicious/noExplicitAny: scene nodes
      group.traverse((o: any) => {
        if (!o.isMesh) return
        if (which === 'land' && !String(o.name).startsWith('chunk_')) return
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          m.colorWrite = drawn
          m.depthWrite = drawn
          n++
        }
      })
      return n
    },
    { which, drawn },
  )

interface Diff {
  readonly changed: number
  readonly noise: number
  readonly pixels: number
}

/** Pixels whose largest channel step is over `STEP`, in rows `fromRow`..end. */
const changedIn = (a: Buffer, b: Buffer, fromRow: number): number => {
  const x = decodePngBuffer(a, 'a')
  const y = decodePngBuffer(b, 'b')
  if (x.width !== y.width || x.height !== y.height) throw new Error('frames differ in size')
  let n = 0
  for (let row = fromRow; row < x.height; row++) {
    for (let col = 0; col < x.width; col++) {
      const i = row * x.width + col
      let worst = 0
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(
          (x.data[i * x.channels + c] as number) - (y.data[i * y.channels + c] as number),
        )
        if (d > worst) worst = d
      }
      if (worst > STEP) n++
    }
  }
  return n
}

/** Shoot the frame as it is twice, and without `which`; compare from `fromRow`. */
const compare = async (
  page: Page,
  which: 'ocean' | 'land',
  lowerHalfOnly: boolean,
  name: string,
): Promise<Diff> => {
  await page.waitForTimeout(400)
  const a = await page.screenshot()
  await page.waitForTimeout(200)
  const a2 = await page.screenshot()
  const touched = await setDrawn(page, which, false)
  expect(touched, `${which} has materials to turn off`).toBeGreaterThan(0)
  await page.waitForTimeout(400)
  const b = await page.screenshot()
  await setDrawn(page, which, true)
  const height = decodePngBuffer(a, 'a').height
  const fromRow = lowerHalfOnly ? Math.ceil(height / 2) + 8 : 0
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, `${name}-drawn-${PINNED.replace(/[=&]/g, '_')}.png`), a)
    fs.writeFileSync(path.join(OUT, `${name}-no-${which}-${PINNED.replace(/[=&]/g, '_')}.png`), b)
  }
  const width = decodePngBuffer(a, 'a').width
  return {
    changed: changedIn(a, b, fromRow),
    noise: changedIn(a, a2, fromRow),
    pixels: width * (height - fromRow),
  }
}

/**
 * Turn the seat's look by mouse, the pointer held: to `dy` pixels below where
 * the capture's click left it (the canvas's middle), in small steps as a hand
 * moves. `MOUSE_SENSITIVITY` is 0.0025 rad a pixel and the pitch stops at one
 * radian, so 260 px is 37 degrees down and never at the stop.
 */
const lookDown = async (page: Page, dy: number): Promise<void> => {
  await page.mouse.move(640, 360 + dy, { steps: 8 })
  await page.waitForTimeout(300)
}

const ride = async (page: Page, mission: string, edition: string, rises: readonly number[]) => {
  await page.addInitScript(installPacer)
  await page.goto(`/?mission=${mission}&xr=off&title=0&menu=0&edition=${edition}&${PINNED}`)
  await firstPress(page)
  await missionReady(page, 240_000)
  await focusCanvas(page)
  await page.waitForTimeout(2_000)
  expect(await armStops(page, rises), 'the dev handle is up').toBe(true)
  await hold(page, 'Enter', 100)
}

test.describe('@gpu nothing of the world inside the shaft on the ride (DEV-460)', () => {
  for (const edition of ['anniversary', 'classic']) {
    test(`int_01_hoverJet, ${edition}: the sea is never inside the shaft`, async ({ page }) => {
      // The eye crosses Simonet's sea between rises ~86 and ~102 and clears
      // the rim at 103.59; every stop is under the rim.
      const rises = [86, 89, 92, 95, 98, 101, 103]
      await ride(page, 'int_01_hoverJet', edition, rises)
      await captureCanvas(page)
      for (let i = 0; i < rises.length; i++) {
        await expect
          .poll(() => stoppedAt(page), { timeout: 120_000, intervals: [100] })
          .not.toBeNull()
        const at = (await stoppedAt(page)) as number
        const p = await probe(page)
        expect(p.eyeY, `rise ${at}: the eye is under the rim`).toBeLessThan(p.rimY)
        // Ahead, and down and up into the shaft's corners, where the sea stood.
        for (const [look, dy] of [
          ['fwd', 0],
          ['down', 260],
          ['up', -260],
        ] as const) {
          await lookDown(page, dy)
          const d = await compare(page, 'ocean', false, `int_01-${edition}-rise${at}-${look}`)
          console.log(
            `[DEV-460] int_01 ${edition} rise ${p.rise.toFixed(2)} eye ${p.eyeY.toFixed(2)} ` +
              `rim ${p.rimY.toFixed(2)} ${look}: the sea changes ${d.changed} px (noise ${d.noise})`,
          )
          expect(
            d.changed - d.noise,
            `rise ${at} ${look}: pixels the sea draws inside the shaft`,
          ).toBeLessThanOrEqual(SLACK)
        }
        await lookDown(page, 0)
        await resume(page)
      }
    })

    test(`rookie_01_hoverJet, ${edition}: no ground in the shaft after the reveal`, async ({
      page,
    }) => {
      // The land comes on at 101.84 here; the eye clears the rim at 103.59.
      const rises = [102.0, 102.6, 103.2]
      await ride(page, 'rookie_01_hoverJet', edition, rises)
      await captureCanvas(page)
      for (let i = 0; i < rises.length; i++) {
        await expect
          .poll(() => stoppedAt(page), { timeout: 120_000, intervals: [100] })
          .not.toBeNull()
        const at = (await stoppedAt(page)) as number
        const p = await probe(page)
        expect(p.eyeY, `rise ${at}: the eye is under the rim`).toBeLessThan(p.rimY)
        const fwd = await compare(page, 'land', true, `rookie_01-${edition}-rise${at}-fwd`)
        await lookDown(page, 260)
        const down = await probe(page)
        const low = await compare(page, 'land', false, `rookie_01-${edition}-rise${at}-down`)
        await lookDown(page, 0)
        console.log(
          `[DEV-460] rookie_01 ${edition} rise ${p.rise.toFixed(2)} eye ${p.eyeY.toFixed(2)} ` +
            `rim ${p.rimY.toFixed(2)}: the ground changes ${fwd.changed} px under the horizon ` +
            `(noise ${fwd.noise}), ${low.changed} px looking down ${down.lookY.toFixed(2)} ` +
            `(noise ${low.noise})`,
        )
        expect(
          down.lookY,
          'the look went down, so the whole frame is under the horizon',
        ).toBeLessThan(-0.45)
        expect(
          fwd.changed - fwd.noise,
          `rise ${at}: ground in the shaft, ahead`,
        ).toBeLessThanOrEqual(SLACK)
        expect(
          low.changed - low.noise,
          `rise ${at}: ground in the shaft, below`,
        ).toBeLessThanOrEqual(SLACK)
        await resume(page)
      }
    })
  }
})
