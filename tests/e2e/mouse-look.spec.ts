/**
 * Mouse look, end to end — the control nothing automated has ever driven.
 *
 * ── Why this is worth a spec ─────────────────────────────────────────────
 *
 * `look.test.ts` pins the signs, the consuming read and the capture rules, and
 * it does all of that against a fake with three methods on it. What it cannot
 * say is whether the mouse reaches the CAMERA: the path from a `mousemove` to
 * a rotated view runs through `boot/app.ts`'s frame loop, the seat look and the
 * XR rig, and every one of those is outside the unit tests.
 *
 * It is possible because `page.mouse.move()` delivers `movementX/Y` while the
 * pointer is captured — measured, 701 px over five events — which is not
 * obvious and was worth finding out. So the real control can be driven here
 * rather than approximated.
 *
 * ── In the hangar, on purpose ────────────────────────────────────────────
 *
 * The seat look KEEPS what you give it: you turned to face a holotable and you
 * want to still be facing it. The cockpit's free look eases back to centre
 * after `FREE_LOOK_HOLD`, which is right for flying and miserable to assert —
 * the reading would depend on how fast the assertion ran.
 *
 * ── What it asserts, and what it deliberately does not ───────────────────
 *
 * Not "the view yawed by 0.42 radians": that is the implementation's own
 * arithmetic written down twice. It asserts RELATIONSHIPS — that the mouse
 * turns the view at all, that left and right are opposites, that the mouse
 * agrees with the keyboard about which way is right, and that releasing the
 * pointer stops it. The last one is the integration claim that matters: the
 * capture is what gates the control.
 *
 * Tagged `@gpu` with the other specs that need a world.
 */

import { missionReady } from './fixtures/boot'
import { CANVAS, pointerIsLocked, releasePointer } from './fixtures/canvas'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

/**
 * The camera's heading, radians, from its world matrix.
 *
 * Read off `matrixWorld`'s third column — the camera's own +Z in world space,
 * so forward is its negation — rather than through three's API, which keeps the
 * probe to arithmetic the page cannot get wrong on our behalf. `matrixWorld` is
 * fresh: `setAnimationLoop` has rendered since the last mouse event.
 */
const heading = async (page: import('@playwright/test').Page): Promise<number> =>
  (await page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: { render: { camera: { matrixWorld: { elements: number[] } } } }
    }
    const m = w.__ff2?.render.camera.matrixWorld.elements
    if (!m) return Number.NaN
    // Forward = −Z of the camera basis.
    return Math.atan2(-(m[8] ?? 0), -(m[10] ?? 0))
  })) as number

/** Signed change in heading, unwrapped so a turn across ±π does not read backwards. */
const turn = (from: number, to: number): number => {
  let d = to - from
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return d
}

/** Held, not tapped — the same reason `pause.spec.ts` holds its keys. */
const holdKey = (page: import('@playwright/test').Page, key: string): Promise<void> =>
  keysHold(page, key, { down: 250, settle: 150 })

/**
 * Where the capture clicks, as a fraction of the canvas's height: the hangar's
 * roof, on the centre column. Since DEV-604 a click from the free cursor that
 * lands ON a table presses it rather than capturing, and at rest a table
 * stands under the canvas's centre (`fixtures/canvas.ts` says so), so the
 * capture is a click on the bare room, as `menu-input.spec.ts`'s DEV-604 test
 * makes it. A player who wants the mouse clicks the room, not a table.
 */
const ROOF = 0.06

const dragMouse = async (
  page: import('@playwright/test').Page,
  from: { x: number; y: number },
  dx: number,
): Promise<void> => {
  // Several small steps rather than one jump: `movementX` is per event, and a
  // single teleport is not what a hand does. Along the row the capture clicked
  // on, so a step carries no vertical movement into the look.
  for (let i = 1; i <= 4; i++) await page.mouse.move(from.x + (dx * i) / 4, from.y)
  await page.waitForTimeout(250)
}

test.describe('@gpu mouse look', () => {
  test.setTimeout(300_000)

  test('turns the seat, agrees with the keyboard, and stops when the pointer is free', async ({
    page,
  }) => {
    // `?title=0` lands in the hangar, which is where the look persists.
    await page.goto('/?title=0&xr=off')
    await firstPress(page)
    await missionReady(page, 180_000)
    await page.waitForTimeout(1_000)

    // ── the capture itself ────────────────────────────────────────────────
    expect(await pointerIsLocked(page), 'not captured before anyone clicks').toBe(false)
    const box = await page.locator(CANVAS).boundingBox()
    if (!box) throw new Error('no canvas')
    const at = { x: box.x + box.width / 2, y: box.y + box.height * ROOF }
    await page.mouse.click(at.x, at.y)
    expect(await pointerIsLocked(page), 'a click on the bare room captures it').toBe(true)

    // ── right, then left ──────────────────────────────────────────────────
    const start = await heading(page)
    expect(Number.isNaN(start), 'the dev handle is up').toBe(false)
    await dragMouse(page, at, 240)
    const afterRight = await heading(page)
    const right = turn(start, afterRight)
    expect(Math.abs(right), 'the mouse moved the view at all').toBeGreaterThan(0.05)

    await dragMouse(page, at, -240)
    const left = turn(afterRight, await heading(page))
    // Opposites, which is a claim about the control rather than about a number.
    expect(Math.sign(left), 'left undoes right').toBe(-Math.sign(right))

    // ── and it agrees with the keyboard about which way is right ──────────
    //
    // `look.test.ts` already pins D as "look right" against the pad's right
    // stick. Chaining to that here means this spec never has to assert a sign
    // of its own — which is the assertion that would be wrong if the whole
    // convention were flipped.
    const beforeKey = await heading(page)
    await holdKey(page, 'KeyD')
    const byKeyboard = turn(beforeKey, await heading(page))
    expect(Math.abs(byKeyboard), 'D turned the seat').toBeGreaterThan(0.02)
    expect(Math.sign(byKeyboard), 'mouse-right and D agree').toBe(Math.sign(right))

    // ── release, and the mouse stops meaning anything ─────────────────────
    //
    // The integration claim. `input/look.ts` reads nothing while the pointer is
    // free, and this is the only place that is true end to end rather than
    // against a fake.
    await releasePointer(page)
    expect(await pointerIsLocked(page)).toBe(false)
    const settled = await heading(page)
    await dragMouse(page, at, 300)
    expect(turn(settled, await heading(page)), 'a free pointer does not look').toBeCloseTo(0, 3)
  })
})
