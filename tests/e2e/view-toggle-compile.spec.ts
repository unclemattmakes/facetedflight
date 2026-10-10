/**
 * tests/e2e/view-toggle-compile.spec.ts — changing view must compile nothing.
 *
 * DEV-186, and the mechanism is DEV-117's one step sideways.
 *
 * ── The bug ──────────────────────────────────────────────────────────────
 *
 * `game/flight.ts`'s `setView` hides the cabin with
 * `interior.object.visible = view === 'first'`. The two `PointLight`s that
 * light the cockpit — `cockpit_fill` and `cockpit_dash`, built by
 * `render/cockpit-interior.ts` — hang under that same node, and three's
 * `projectObject` opens with `if ( object.visible === false ) return;`
 * (`three.module.js:17827`): an invisible subtree contributes no lights.
 *
 * So pressing V moves `numPointLights` 2 → 0 for the whole scene. That bumps
 * `WebGLLights`' `state.version`, which is the branch of `needsProgramChange`
 * at `:18386` that re-fetches a program for **every lit material in the
 * frame** — and `numPointLights` is in the program cache key, so the first
 * press of a session compiles the island, the sea, the props and the ship all
 * over again.
 *
 * `render/warm-up.ts` cannot help: it warms the count that is live when it
 * runs, and that is 2.
 *
 * ── Why the gate is a COUNT ──────────────────────────────────────────────
 *
 * VR-PERF §0: *print, don't gate; if you must gate, gate a MECHANISM*. A
 * millisecond belongs to a machine, and this suite shares a GPU with whatever
 * else is on the box (`docs/testing/perf-protocol.md` §3a). A program count
 * does not: it is the same integer on a quiet machine and a busy one, which is
 * exactly the property `ride-hitch.spec.ts` was built on.
 *
 * ── Third person is FLAT-ONLY, and that bounds this ──────────────────────
 *
 * DEV-128 refuses the third-person rig in a session — in a headset the camera
 * IS the head — and `render/controls-menu.ts` hides the row there. So this is
 * a monitor defect, not a headset one. It is still a real hitch on the one
 * press a flat player makes to see their own ship.
 */

import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold } from './fixtures/freeze'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

const MISSION = process.env.VIEW_MISSION ?? 'int_01_hoverJet'
const EDITION = process.env.VIEW_EDITION ?? 'anniversary'

type Page = import('@playwright/test').Page

interface Snapshot {
  readonly programs: number
  readonly pointLights: number
  /** Is the CABIN showing? The node `setShown` hides — the lamps are elsewhere now. */
  readonly interior: boolean
}

/**
 * The program count, and the light count that drives it.
 *
 * `renderer.info.programs` is three's own cache — one entry per distinct cache
 * key that has been compiled this session. Reading the LIGHT count beside it is
 * what makes a green meaningful: if the lights never changed, a constant
 * program count proves nothing about the thing this file is named after.
 */
const snapshot = (page: Page): Promise<Snapshot> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: {
        render: {
          renderer: { info: { programs: unknown[] } }
        }
        stage: () => {
          traverse: (
            fn: (o: {
              isPointLight?: boolean
              visible: boolean
              name: string
              parent?: unknown
            }) => void,
          ) => void
        }
      }
    }
    let pointLights = 0
    let interior = false
    // EFFECTIVE visibility, walking the parent chain — three's `projectObject`
    // returns at the first invisible ancestor, so a light whose own flag is
    // true under a hidden parent is not in the scene's light list. The first
    // run of this file counted `o.visible` alone and read 3 → 3 → 3 while the
    // program count went 100 → 115, which is the counter disagreeing with the
    // thing it exists to explain.
    const lit = (o: { visible: boolean; parent?: unknown }): boolean => {
      let n: { visible: boolean; parent?: unknown } | undefined = o
      while (n) {
        if (!n.visible) return false
        n = n.parent as { visible: boolean; parent?: unknown } | undefined
      }
      return true
    }
    w.__ff2.stage().traverse((o) => {
      if (o.isPointLight && lit(o)) pointLights++
      if (o.name === 'cockpit_cabin') interior = lit(o)
    })
    return { programs: w.__ff2.render.renderer.info.programs.length, pointLights, interior }
  })

test.describe('@gpu changing view compiles nothing — DEV-186', () => {
  test.setTimeout(420_000)

  test(`${MISSION} ${EDITION}: programs constant across a view toggle and back`, async ({
    page,
  }) => {
    // ── `?feature=cockpit.lighting:on` — DEV-263, and why it is here ───────
    //
    // Anniversary stopped shipping the cabin lamps on 2026-09-21 (Matt: *"we
    // don't need the cockpit point lights"*), and this spec went red on the
    // premise assertion twelve lines below, with `first.pointLights` at 0.
    //
    // Note WHICH way that failed, because it decides the right fix. The preset
    // moving did not change this test's answer — it removed its question. The
    // invariant is still real, the code that can break it is still here, and
    // the comment below already said what a green would mean without it.
    //
    // So the pin restores the premise rather than the spec lowering its bar.
    // It configures the game into a state the game supports, through the same
    // code, exactly as `?edition=` on this same line does — not a switch that
    // makes the build skip what is under test, which is the thing CLAUDE.md
    // forbids.
    //
    // The honest caveat: this now exercises a configuration nobody ships. The
    // shipped-off claim is asserted separately in `edition-content.test.ts`
    // ("the cockpit point lights are off in BOTH presets"), and the unit half
    // of this same re-pointing is `cockpit-interior.test.ts`'s ANNIVERSARY_LIT.
    await page.goto(
      `/?mission=${MISSION}&xr=off&title=0&menu=0&autopilot=1&edition=${EDITION}` +
        `&feature=cockpit.lighting:on`,
    )
    await firstPress(page)
    await missionReady(page, 240_000)
    await focusCanvas(page)
    // Let the launch ride finish and the world settle: the ride compiles the
    // shaft's own variants (its lamp is a third point light) and those are
    // DEV-117's subject, not this one.
    await page.waitForTimeout(25_000)

    const first = await snapshot(page)
    // The premise. If the cockpit's lamps are not lit there is nothing here to
    // test, and a green would mean "the preset was Classic", not "no compile".
    expect(first.pointLights, 'the cockpit is lit in first person').toBeGreaterThan(0)

    // V is the flat binding — 2016 put CHANGE VIEW on X, and
    // `render/controls-menu.ts` names both.
    //
    // HELD, not tapped, and the first run of this file is why: `press()` is a
    // keydown and a keyup a few milliseconds apart, the loop edge-detects
    // `wantCamera && !cameraKeyHeld` from an instantaneous read, and at 60 Hz a
    // 10 ms press can fall entirely between two frames. It did — the run came
    // back `cabin true -> true -> true` with the programs dutifully constant.
    // `hold()` is `pause.spec.ts`'s 200 ms, for the same reason.
    //
    // The toggle also fades (0.12 s out, 0.25 s in, `FADE.cameraSwitch*`) and
    // `goToScreen` ignores a second press while one is running, so the waits
    // below are not padding.
    await hold(page, 'v')
    await page.waitForTimeout(3_000)
    const third = await snapshot(page)

    await hold(page, 'v')
    await page.waitForTimeout(3_000)
    const back = await snapshot(page)

    console.info(
      `DEV-186 view toggle — ${MISSION} ${EDITION}: ` +
        `programs ${first.programs} -> ${third.programs} -> ${back.programs}; ` +
        `point lights ${first.pointLights} -> ${third.pointLights} -> ${back.pointLights}; ` +
        `cabin ${first.interior} -> ${third.interior} -> ${back.interior}`,
    )

    // ── THE PREMISE, and the first run of this file did not have it ──────
    //
    // It came back `programs 100 -> 100 -> 100, point lights 3 -> 3 -> 3` and
    // that green meant nothing, because nothing in it said the VIEW had
    // changed. A key that did not register — no focus, a pointer lock, a
    // branch that ignores it under the autopilot — produces exactly the same
    // three numbers. `setView` writes `interior.object.visible`, so that flag
    // is the toggle actually happening.
    expect(first.interior, 'starts in first person, cabin shown').toBe(true)
    expect(third.interior, 'V put the camera outside').toBe(false)
    expect(back.interior, 'V brought it back').toBe(true)

    // The gate. Two halves, and both matter:
    //
    //  1. the program count does not move — nothing compiled;
    //  2. the LIGHT count does not move either — which is the only way (1) can
    //     be true for the right reason. A fix that hid the lamps some other way
    //     would pass (1) on the second press and fail it on the first.
    expect(third.pointLights, 'the lamps survive third person').toBe(first.pointLights)
    expect(third.programs, 'no compile on the way out').toBe(first.programs)
    expect(back.programs, 'no compile on the way back').toBe(first.programs)
  })
})
