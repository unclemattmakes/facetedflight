/**
 * tests/e2e/stereo-parity.spec.ts — with the eyes in one place, the two eyes
 * draw one picture.
 *
 * `docs/plan/VR-TEST-AUTOMATION.md`'s rank 1, "the cheapest thing with the
 * biggest catch". Nothing automated here compared the two eyes, and that is
 * why DEV-141 shipped: the whole readable UI sat on three's layer 1, which
 * `WebXRManager` builds as the LEFT eye only, and every screenshot this port
 * had ever taken went through one camera. A monocular bug cannot exist in a
 * monocular harness.
 *
 * ── Why the oracle is not our own belief ─────────────────────────────────
 *
 * In `iwer@2.4.0`, `session/XRSession.js` builds the left projection and
 * COPIES it to the right, and `device/XRDevice.js` offsets the eyes by
 * `-/+ ipd/2` and nothing else. So at `ipd: 0` the two views are the same
 * camera twice, and the halves of the canvas MUST match. That is IWER's
 * geometry, not a comparison of two of our own devices (the trap CLAUDE.md
 * names for `xr-input.test.ts`). Anything clocked per frame (water, particles,
 * motes) is shared between the two draws of one frame, so it cannot break it.
 *
 * ── What it catches, and what it cannot ──────────────────────────────────
 *
 * Catches: one-eyed drawing of any cause. A layer (DEV-141), a per-eye
 * viewport or scissor slip, per-camera state cached from the first eye, a
 * per-eye cull or sort difference, and anything that advances per RENDER CALL
 * rather than per frame (an `onBeforeRender` that steps an animation runs
 * twice in stereo, so the right eye would be one step ahead).
 * Cannot see: anything symmetric, anything in the compositor, and anything that
 * differs only when the eyes are APART.
 *
 * ── Positive before the absence ──────────────────────────────────────────
 *
 * Two black halves also match. So every arm first asserts the frame drew
 * (draw calls > 0), that each half has content (its pixels vary), that the
 * runtime really has the eyes together, and, for the HUD arm, that the thing
 * DEV-141 hid is on screen.
 *
 * ── The halves are NOT bit-identical, and why the bound is a patch size ─
 *
 * The survey said to write no tolerance before the first reading. The first
 * readings (2026-09-23, pinned, IPD 0) were not zero:
 *
 *   arm      differing px   largest patch   max diff
 *   hangar            11                1        57   (two runs)
 *   flight       465-869           70-142     21-45   (six runs)
 *   pause           1010              145        42
 *
 * Speckles and short thin lines along facet and tree edges, varying run to
 * run. Ruled out by measurement: the LOD-fade dither (`?feature=
 * terrain.lodFade:off` still read 465 px, patch 70), the motes (`fx.motes:off`
 * read 514 px, patch 79, and both off read 582 / 125), and three's
 * `dithering` (no material sets it). **The cause is not established.** The
 * leading suspect is rasterisation precision: the right eye's vertices land
 * 800 px further along in window space, and float rounding there can flip MSAA
 * coverage on edge pixels. That is not proven, and it is the thing to
 * settle if this bound ever bites.
 *
 * The bound is on the LARGEST CONNECTED PATCH, because that is what separates
 * noise from a one-eyed bug. With DEV-141 put back (`UI_LAYER = 1`) the red
 * run read a patch of **1,412 px** in the hangar and **15,687 px** in flight
 * (the whole HUD). `PATCH_LIMIT` = 400 sits ~2.8x above the noisiest clean
 * patch (145) and ~3.5x below the smallest red one (1,412).
 *
 * Tagged `@gpu`, and pinned (DEV-245). The frames go to `STEREO_SHOTS_DIR`
 * when it is set, because Playwright wipes `test-results/` at the start of
 * every run.
 */
import fs from 'node:fs'
import path from 'node:path'
import { blobStats, decodePng } from '../../tools/perf/png-diff.mjs'
import { emulatedXrInstalled, installEmulatedXr } from './fixtures/emulated-xr'
import { enterVr, loadSettled } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

/** 800 x 720 an eye. IWER sizes the canvas from the window; the width is EVEN. */
test.use({ viewport: { width: 1600, height: 720 }, deviceScaleFactor: 1 })

/**
 * The largest 4-connected patch of pixels allowed to differ between the eyes.
 * The header has the readings it sits between.
 */
const PATCH_LIMIT = 400

type Hand = 'left' | 'right'

interface Decoded {
  readonly w: number
  readonly h: number
  readonly ch: number
  readonly data: Uint8Array
}

interface Parity {
  /** Pixels (not channels) where the halves differ at all. */
  readonly differing: number
  /** The largest single-channel difference, levels of 255. */
  readonly maxDiff: number
  /** Standard deviation of each half's luminance: a blank half is ~0. */
  readonly leftSpread: number
  readonly rightSpread: number
  /** Bounding box of the differing pixels, in the LEFT half's coordinates. */
  readonly box: { x0: number; y0: number; x1: number; y1: number } | null
  /** The largest 4-connected patch of differing pixels. */
  readonly largestPatch: number
}

const compareHalves = (img: Decoded): Parity => {
  const half = Math.floor(img.w / 2)
  let differing = 0
  let maxDiff = 0
  let box: Parity['box'] = null
  const keep = new Uint8Array(Math.floor(img.w / 2) * img.h)
  const lum = [0, 0]
  const lum2 = [0, 0]
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < half; x++) {
      const a = (y * img.w + x) * img.ch
      const b = (y * img.w + x + half) * img.ch
      let d = 0
      for (let k = 0; k < 3; k++) {
        d = Math.max(d, Math.abs((img.data[a + k] as number) - (img.data[b + k] as number)))
      }
      if (d > 0) {
        keep[y * half + x] = 1
        differing++
        box = box
          ? {
              x0: Math.min(box.x0, x),
              y0: Math.min(box.y0, y),
              x1: Math.max(box.x1, x),
              y1: Math.max(box.y1, y),
            }
          : { x0: x, y0: y, x1: x, y1: y }
      }
      if (d > maxDiff) maxDiff = d
      for (const [side, i] of [
        [0, a],
        [1, b],
      ] as const) {
        const l =
          0.2126 * (img.data[i] as number) +
          0.7152 * (img.data[i + 1] as number) +
          0.0722 * (img.data[i + 2] as number)
        lum[side] = (lum[side] as number) + l
        lum2[side] = (lum2[side] as number) + l * l
      }
    }
  }
  const n = half * img.h
  const spread = (s: number) =>
    Math.sqrt(Math.max(0, (lum2[s] as number) / n - ((lum[s] as number) / n) ** 2))
  const patches = blobStats(keep, half, img.h, 0)
  return {
    differing,
    maxDiff,
    leftSpread: spread(0),
    rightSpread: spread(1),
    box,
    largestPatch: patches?.largest ?? 0,
  }
}

const presenting = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2?: { render: { renderer: { xr: { isPresenting: boolean } } } }
        }
      ).__ff2?.render.renderer.xr.isPresenting ?? false,
  )

/** The runtime's own eye offset, and the draw calls of the last frame. */
const facts = (page: Page): Promise<{ ipd: number; calls: number }> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __emulatedXR: { device: { ipd: number } }
      __ff2: { render: { renderer: { info: { render: { calls: number } } } } }
    }
    return { ipd: w.__emulatedXR.device.ipd, calls: w.__ff2.render.renderer.info.render.calls }
  })

/** Press and release a controller button, the way a finger does it. */
const press = async (page: Page, hand: Hand, button: string): Promise<void> => {
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

/** Load with the eyes together, and enter the session through the player's button. */
const enterSession = async (page: Page, url: string): Promise<void> => {
  await installEmulatedXr(page, { ipd: 0, fovyDeg: 90 })
  await page.goto(url)
  // `#enter-vr` waits for a world as well as a headset (DEV-107).
  await loadSettled(page, 240_000)
  expect(await emulatedXrInstalled(page), 'the emulated runtime took').toBe(true)
  await enterVr(page)
  await expect.poll(() => presenting(page), { timeout: 60_000 }).toBe(true)
}

/** Photograph the canvas and judge its halves, premise first. */
const judge = async (page: Page, name: string): Promise<Parity> => {
  const f = await facts(page)
  expect(f.ipd, 'the runtime has the eyes in one place').toBe(0)
  expect(f.calls, `${name}: the frame drew something`).toBeGreaterThan(0)
  const shot = await page.locator('#viewport').screenshot()
  const dir = process.env.STEREO_SHOTS_DIR
  if (dir) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `stereo-${name}.png`), shot)
  }
  const img = decodePng(shot) as Decoded
  expect(img.w % 2, 'an even canvas, so the halves are the same size').toBe(0)
  const p = compareHalves(img)
  console.info(
    `stereo-parity ${name}: ${img.w}x${img.h} · ${f.calls} draw calls · ` +
      `${p.differing} px differ, largest patch ${p.largestPatch} (max ${p.maxDiff}/255${p.box ? `, box ${JSON.stringify(p.box)}` : ''}) · ` +
      `spread L ${p.leftSpread.toFixed(1)} R ${p.rightSpread.toFixed(1)}`,
  )
  // Each half has content: a uniform half is a frame that drew nothing
  // worth comparing, and it would match its twin perfectly.
  expect(p.leftSpread, `${name}: the left half has content`).toBeGreaterThan(5)
  expect(p.rightSpread, `${name}: the right half has content`).toBeGreaterThan(5)
  return p
}

test.describe('@gpu stereo parity — at IPD 0 the two eyes draw one picture', () => {
  test.setTimeout(480_000)

  test('the hangar, where the holotable labels are UI', async ({ page }) => {
    await enterSession(page, `/?title=0&${PINNED}`)
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(() =>
              (
                globalThis as unknown as { __ff2?: { hangarAim: () => { vehicles: unknown[] } } }
              ).__ff2?.hangarAim(),
            )) as { vehicles: unknown[] } | undefined
          )?.vehicles.length ?? 0,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0)
    await page.waitForTimeout(1_000)
    // DEV-574: the selected table's highlight (the square and its additive
    // glow) is in the picture both eyes are compared on: a glow is a pixel the
    // two eyes must agree on. The room's laser takes the aim from a hand that
    // points (DEV-321), and the emulated hands point level, over the tables;
    // so the right hand is lowered toward them and swept until SINGLE PLAYER,
    // the middle of the frame, is taken, as a player points.
    const aimed = () =>
      page.evaluate(
        () =>
          (
            globalThis as unknown as {
              __ff2: { hangarAim: () => { aim: { door?: { id: string } } | null } | null }
            }
          ).__ff2.hangarAim()?.aim?.door?.id === 'single-player',
      )
    for (let yaw = -60; yaw <= 60 && !(await aimed()); yaw += 5) {
      await page.evaluate((yawDeg) => {
        const r = Math.PI / 360
        const cy = Math.cos(yawDeg * r)
        const sy = Math.sin(yawDeg * r)
        const cx = Math.cos(-30 * r)
        const sx = Math.sin(-30 * r)
        ;(
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
        ).__emulatedXR.device.controllers.right?.quaternion.set(cy * sx, sy * cx, -sy * sx, cy * cx)
      }, yaw)
      await page.waitForTimeout(120)
    }
    await page.waitForTimeout(1_000)
    const highlighted = await page.evaluate(() => {
      let n = 0
      ;(
        globalThis as unknown as {
          __ff2: {
            stage: () => {
              traverse: (
                f: (o: { name: string; visible: boolean; parent: unknown }) => void,
              ) => void
            }
          }
        }
      ).__ff2
        .stage()
        .traverse((o) => {
          if (o.name !== 'holotable-highlight') return
          for (let p = o as { visible: boolean; parent: unknown } | null; p; p = p.parent as never)
            if (!p.visible) return
          n++
        })
      return n
    })
    expect(highlighted, 'the premise: one table is selected, its glow drawn').toBe(1)
    const p = await judge(page, 'hangar')
    expect(p.largestPatch, 'no patch of the picture is in one eye only').toBeLessThan(PATCH_LIMIT)
  })

  test('flight, with the HUD DEV-141 hid from the right eye, and the pause plate', async ({
    page,
  }) => {
    await enterSession(page, `/?autopilot=1&mission=rookie_01_hoverJet&${PINNED}`)
    // A with the right hand is launch (`input/xr.ts`); idempotent if the
    // autopilot already started it.
    await press(page, 'right', 'a-button')
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { __ff2?: { mission: { elapsed: number } } }).__ff2?.mission
                .elapsed ?? 0,
          ),
        { timeout: 120_000, intervals: [500] },
      )
      .toBeGreaterThan(5)
    // The HUD is up: the premise the parity is about.
    const hudUp = await page.evaluate(() => {
      const f = (
        globalThis as unknown as {
          __ff2?: { flight: () => { hud: { object: { visible: boolean } } } | null }
        }
      ).__ff2?.flight()
      return f?.hud.object.visible ?? false
    })
    expect(hudUp, 'the cockpit HUD is up').toBe(true)
    const flying = await judge(page, 'flight')
    expect(flying.largestPatch, 'no patch is in one eye only, in flight').toBeLessThan(PATCH_LIMIT)

    await press(page, 'left', 'x-button')
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                globalThis as unknown as { __ff2?: { pausePlate: () => { open: boolean } | null } }
              ).__ff2?.pausePlate()?.open ?? false,
          ),
        { timeout: 5_000 },
      )
      .toBe(true)
    await page.waitForTimeout(500)
    const plate = await judge(page, 'pause')
    expect(plate.largestPatch, 'no patch is in one eye only, plate up').toBeLessThan(PATCH_LIMIT)
  })

  // DEV-583 (and DEV-581's promise): a player who chose ULTRA on the monitor
  // and then puts the headset on gets `high`'s frame, and the sea's mirror,
  // which is ultra's, neither renders nor keeps its target. The flat half of
  // the load is the premise: the same stored tier opened the mirror there.
  test('flight under a stored ultra: the headset renders high, with no sea mirror', async ({
    page,
  }) => {
    // DEV-837: the mirror ships off, so the premise pins it on.
    const ultraPin = `${PINNED.replace('quality=high', 'quality=ultra')}&feature=render.seaReflection:on`
    expect(ultraPin, 'the ultra pin differs from the pin it was cut from').not.toBe(PINNED)
    const mirror = () =>
      page.evaluate(() => {
        const w = globalThis as unknown as {
          __ff2?: {
            render: {
              scene: {
                userData: Record<
                  string,
                  (() => { on: boolean; width: number; passes: number; calls: number }) | undefined
                >
              }
            }
          }
        }
        return w.__ff2?.render.scene.userData.seaReflection?.() ?? null
      })
    await installEmulatedXr(page, { ipd: 0, fovyDeg: 90 })
    // int_01, not the flight arm's rookie_01: rookie_01 is the alpine valley,
    // which has no sea, so the flat premise below could never be met there.
    await page.goto(`/?autopilot=1&mission=int_01_hoverJet&${ultraPin}`)
    await loadSettled(page, 240_000)
    expect(await emulatedXrInstalled(page), 'the emulated runtime took').toBe(true)
    // The premise, on the monitor: ultra is in force and the mirror is open.
    await expect.poll(async () => (await mirror())?.on ?? false, { timeout: 60_000 }).toBe(true)
    await enterVr(page)
    await expect.poll(() => presenting(page), { timeout: 60_000 }).toBe(true)
    await press(page, 'right', 'a-button')
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { __ff2?: { mission: { elapsed: number } } }).__ff2?.mission
                .elapsed ?? 0,
          ),
        { timeout: 120_000, intervals: [500] },
      )
      .toBeGreaterThan(5)
    const inSession = await mirror()
    console.info(`stereo-parity ultra: the mirror in the session ${JSON.stringify(inSession)}`)
    expect(inSession?.on, 'no mirror while presenting').toBe(false)
    expect(inSession?.width, 'no mirror target kept alive in a session').toBe(0)
    expect(inSession?.passes, 'no mirror pass in a session').toBe(0)
    expect(inSession?.calls, 'and no draws reported for one').toBe(0)
    const flying = await judge(page, 'flight-ultra')
    expect(flying.largestPatch, 'no patch is in one eye only, under ultra').toBeLessThan(
      PATCH_LIMIT,
    )
  })
})
