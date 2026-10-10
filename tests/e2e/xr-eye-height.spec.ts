/**
 * tests/e2e/xr-eye-height.spec.ts — where is the eye, actually?
 *
 * Matt asked whether the rig's measurements are skewed by the camera sitting at
 * pelvis level. Nothing on disk could answer it, and that is the point: every
 * screenshot spec in this suite uses `?view=cam` on the FLAT path, where local
 * and world are the same thing. **Nobody has ever measured what a session
 * renders from.** CLAUDE.md's trap 18 already says so — *"the cockpit, the only
 * path with a rig in it and the only path anyone plays, had no automated
 * coverage"* — and this is that gap, still open.
 *
 * The two facts that make it a real question rather than a worry:
 *
 *   * FF2 asks for the **`local`** reference space (`render/renderer.ts`), not
 *     `local-floor`. Under `local` the origin is the head pose at session start,
 *     so a constant device offset should cancel and the eye should land on the
 *     seat.
 *   * VRto3D's `default_config.json` carries **`hmd_height: -1`**, and it is not
 *     established whether that is a literal metre or a sentinel for "unset".
 *
 * So this reads the numbers rather than reasoning about them: the rig's world
 * position (which the app sets to the seat), the camera's world position (which
 * three overwrites from the XR pose every frame), and the difference. A healthy
 * session has the camera within a few centimetres of the rig in Y — the head
 * does not lean a metre.
 *
 * It ASSERTS nothing about the magnitude and prints everything. The number this
 * is for has never been observed, and a threshold invented before the first
 * reading is a guess wearing an assertion's clothes.
 */

import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { knownRed } from './fixtures/known-red'
import { enterVr, loadSettled } from './fixtures/landing'
import { expect, requireImmersiveDevice, test } from './fixtures/xr-browser'

const MISSION = process.env.EYE_MISSION ?? 'int_01_hoverJet'

test.describe('@measure @gpu xr eye height', () => {
  test.setTimeout(240_000)

  test('reports where the eye sits relative to the seat', async ({ page }) => {
    knownRed('KR-11')
    await page.goto(`/?perf=1&mission=${MISSION}&autopilot=1`)
    // DEV-265: say it now, with the rig named, rather than spending the wait
    // below proving a fact the capability probe already had.
    await requireImmersiveDevice(page)
    await loadSettled(page, 120_000)
    await enterVr(page)

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const w = globalThis as unknown as Ff2GlobalMaybe
            const r = w.__ff2?.render?.renderer as { xr?: { isPresenting?: boolean } } | undefined
            return r?.xr?.isPresenting ?? false
          }),
        { timeout: 60_000 },
      )
      .toBe(true)

    // Let the flight leave the launch so the seat is where a player flies from.
    await page.waitForTimeout(25_000)

    const read = await page.evaluate(() => {
      const w = globalThis as unknown as Ff2GlobalMaybe
      const R = w.__ff2?.render
      if (!R) return null
      const THREE_V = (o: unknown) =>
        o as {
          getWorldPosition: (v: unknown) => { x: number; y: number; z: number }
          position: { x: number; y: number; z: number }
        }
      // A real Vector3, cloned off one the scene already owns — `getWorldPosition`
      // calls `setFromMatrixPosition` on its argument, so a plain object throws.
      const mk = () =>
        (
          R.rig as { position: { clone: () => { x: number; y: number; z: number } } }
        ).position.clone()
      const rigW = THREE_V(R.rig).getWorldPosition(mk())
      const camW = THREE_V(R.camera).getWorldPosition(mk())
      const camL = THREE_V(R.camera).position
      const xr = (R.renderer as { xr?: { getCamera?: () => { cameras?: unknown[] } } }).xr
      const eyes = (xr?.getCamera?.()?.cameras ?? []).map((c) => THREE_V(c).getWorldPosition(mk()))
      return { rigW, camW, camL, eyes }
    })

    expect(read, 'no render handles — is this a dev build?').not.toBeNull()
    const r = read as NonNullable<typeof read>
    const f = (n: number) => n.toFixed(3)
    console.info(
      `\nxr eye height — ${MISSION}, in a live session\n` +
        `  rig    world  (${f(r.rigW.x)}, ${f(r.rigW.y)}, ${f(r.rigW.z)})   <- the app sets this to the seat\n` +
        `  camera world  (${f(r.camW.x)}, ${f(r.camW.y)}, ${f(r.camW.z)})\n` +
        `  camera LOCAL  (${f(r.camL.x)}, ${f(r.camL.y)}, ${f(r.camL.z)})   <- the XR head pose inside the rig\n` +
        `  eye - rig, Y  ${f(r.camW.y - r.rigW.y)} m\n` +
        r.eyes.map((e, i) => `  eye ${i} world  (${f(e.x)}, ${f(e.y)}, ${f(e.z)})`).join('\n'),
    )
  })
})
