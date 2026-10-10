/**
 * tests/e2e/baked-light-probe.spec.ts — did the baked-light arm actually fire?
 *
 * DEV-232's A/B came back at 0.025 ms against a 0.05 ms bracket, with the
 * program count IDENTICAL across all three arms (median 95, distinct
 * {78, 94, 95}). A define changes three's program cache key, so an arm that
 * really set `FF2_BAKED_LIGHT` cannot leave the program count untouched. The
 * arm did not fire and the millisecond was not a result.
 *
 * `__ff2.bakedLight()` was built to answer exactly this and the A/B skipped it:
 * it reports `baked`, *"the number of chunk geometries currently holding a baked
 * colour buffer"*, because — its own words — *"a define with no baked buffer
 * behind it is the failure this reports rather than hides"*.
 *
 * So this compares the two routes that are supposed to be equivalent:
 *
 *   1. the EDITION flag, `terrain.bakedLight` — what `VRTO3D_FLAGS_ON` drives,
 *      and the route the A/B used;
 *   2. the DIRECT handle, `__ff2.bakedLight(true)` — the within-run A-B-A
 *      toggle DEV-232's report recommends.
 *
 * If they disagree, the A/B mechanism is broken rather than the idea. Flat
 * path on purpose: whether a define lands is not an XR question, and a flat
 * load costs a tenth of a session.
 *
 * ── DEV-286: and "flat path on purpose" was not true of the WAIT ─────────
 *
 * Both tests used to hold on `#enter-vr` going enabled, under a comment
 * reading *"the land has to exist before a define on its material means
 * anything"*. That button is not the land. `src/main.ts` only ever clears its
 * `disabled` inside `if (app.capabilities.immersiveVr)`, and the `else` branch
 * pins it disabled for the life of the page — so it is a CONJUNCTION, *a
 * headset is present* AND *the world is ready*, and the comment named one half
 * of it. On a box with no VR runtime the other half is never true, so both
 * tests burned 120 s and failed a file whose own header says it is flat on
 * purpose.
 *
 * It read as correct for as long as the box had a headset. That is the general
 * shape and the reason this has a number: **a spec that waits on a conjunction
 * gets the conjunction, and a comment naming one half of it will read as
 * correct for exactly as long as the other half happens to be true.** The
 * remedy is not a longer timeout or `?xr=off` — which would skip the
 * capability probe rather than answer it, and a `?perf=1` run wants the
 * probe's real answer — but waiting on the signal that means what the comment
 * says. `data-terrain-ready` is set at the end of `buildWorld`, and these URLs
 * carry `autopilot=1`, which `boot/app.ts` resolves to `bootWorld: 'mission'`.
 */

import { missionReady } from './fixtures/boot'
import { expect, test } from './fixtures/test'

const MISSION = process.env.BAKED_MISSION ?? 'adv_02_jumpSeat'

test.describe('@measure @gpu baked light', () => {
  test.setTimeout(180_000)

  test('reports whether each route actually bakes anything', async ({ page }) => {
    await page.goto(`/?perf=1&mission=${MISSION}&autopilot=1`)
    await page.waitForFunction(
      () => {
        const w = globalThis as unknown as { __ff2?: { bakedLight?: unknown } }
        return typeof w.__ff2?.bakedLight === 'function'
      },
      { timeout: 120_000 },
    )
    // The land has to exist before a define on its material means anything —
    // and THIS is that, where `#enter-vr` was a headset question wearing the
    // same clothes. See DEV-286 in the header.
    //
    // Keeping the old 120 s rather than taking `missionReady`'s 180 s default,
    // because that default IS this file's `test.setTimeout` — a wait that
    // expires at the same moment as its test reports an unattributed test
    // timeout instead of naming the thing that never arrived.
    await missionReady(page, 120_000)

    // DEV-232's report, after the two defects this probe found were fixed.
    // `wanted` is what was asked for and `on` is what is true; the first
    // version had only the second, so "off, correctly" and "on, and it reached
    // nothing" were the same answer.
    type Report = {
      wanted: boolean
      on: boolean
      reason: string | null
      define: string
      baked: number
      materials: number
      refusals: number
    }
    const read = () =>
      page.evaluate(() => {
        const w = globalThis as unknown as { __ff2: { bakedLight: (on?: boolean) => unknown } }
        return w.__ff2.bakedLight() as Report
      })

    const shipped = await read()

    // Route 1 — the edition flag, exactly as `VRTO3D_FLAGS_ON` sets it.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __ff2: { edition: { current: Record<string, unknown>; setPreset: (e: unknown) => void } }
      }
      const e = structuredClone(w.__ff2.edition.current) as Record<string, unknown>
      const block = e.terrain as Record<string, unknown>
      block.bakedLight = { ...(block.bakedLight as Record<string, unknown>), enabled: true }
      w.__ff2.edition.setPreset(e)
    })
    await page.waitForTimeout(1500)
    const viaEdition = await read()

    // Route 2 — the direct handle DEV-232's report recommends.
    await page.evaluate(() => {
      const w = globalThis as unknown as { __ff2: { bakedLight: (on?: boolean) => unknown } }
      w.__ff2.bakedLight(true)
    })
    await page.waitForTimeout(1500)
    const viaHandle = await read()

    const fmt = (label: string, r: Report) =>
      `  ${label.padEnd(16)} wanted=${String(r.wanted).padEnd(5)} on=${String(r.on).padEnd(5)} ` +
      `baked=${String(r.baked).padStart(4)} materials=${String(r.materials).padStart(3)} ` +
      `refusals=${String(r.refusals).padStart(3)} reason=${r.reason ?? '-'}`
    console.info(
      `\nbaked-light probe — ${MISSION}, flat path\n` +
        `${fmt('shipped', shipped)}\n${fmt('via edition flag', viaEdition)}\n${fmt('via __ff2 handle', viaHandle)}\n` +
        `  define: ${shipped.define}`,
    )

    // The two routes must agree — which one is right is a separate question,
    // and that they disagree would be the bug this was written for.
    expect(
      { on: viaEdition.on, baked: viaEdition.baked > 0 },
      'the edition flag and the direct handle disagree about whether the land is baked',
    ).toEqual({ on: viaHandle.on, baked: viaHandle.baked > 0 })

    // And, now that the report can say so: agreeing on FALSE is not a pass.
    // The first run of this probe would have been satisfied by both routes
    // doing nothing, which is exactly what one of them was doing.
    expect(
      { on: viaEdition.on, reason: viaEdition.reason },
      'the edition flag did not actually bake the land',
    ).toEqual({ on: true, reason: null })

    // Nothing but a terrain chunk may reach the bake. A refusal means something
    // else got into its scope — the defect that put a vec4-colour prop through
    // it and threw (6384, 4788, 6384).
    expect(viaEdition.refusals, 'the bake was offered a geometry it could not use').toBe(0)
  })

  /**
   * DEV-237 — and the RUNG moves within one page load.
   *
   * The reason this is a separate test rather than three more lines on the one
   * above: the rung's whole value to a measurement is that the coordinator can
   * read rung 1, rung 3 and off **on one load**, which is the only comparison
   * `docs/testing/perf-protocol.md` §3a-ter says this machine can make of a
   * fill-dominated cost. If the rung needed a reload it would be `?terrainLit=`
   * again — an instrument whose every reading that protocol voids.
   *
   * It asserts on `liveRung` and `defines`, which are read back off the
   * terrain's materials, never on the intent. DEV-232 §10b is the whole reason
   * that distinction exists: an intent that reached nothing recorded sixty
   * seconds and a number.
   */
  test('flips the rung within one load, and the materials follow', async ({ page }) => {
    await page.goto(`/?perf=1&mission=${MISSION}&autopilot=1`)
    await page.waitForFunction(
      () => {
        const w = globalThis as unknown as { __ff2?: { bakedLight?: unknown } }
        return typeof w.__ff2?.bakedLight === 'function'
      },
      { timeout: 120_000 },
    )
    // The mission world, not the headset gate. DEV-286, as above — and the
    // same 120 s, for the same reason.
    await missionReady(page, 120_000)

    type RungReport = {
      wanted: boolean
      on: boolean
      rung: number
      liveRung: number | null
      defines: string[]
      baked: number
    }
    const set = (on: boolean, rung?: 1 | 3) =>
      page.evaluate(
        ({ on, rung }) => {
          const w = globalThis as unknown as {
            __ff2: { bakedLight: (on?: boolean, rung?: number) => unknown }
          }
          return w.__ff2.bakedLight(on, rung) as RungReport
        },
        { on, rung },
      )

    // A — the shipped build. Off, and carrying neither define.
    const off = await set(false)
    // B — rung 1: baked, shadow multiply kept.
    const one = await set(true, 1)
    // C — rung 3: baked, shadow multiply gone. DEV-232's measured arm.
    const three = await set(true, 3)
    // A again — the bracket, and it has to come back to exactly A.
    const offAgain = await set(false)

    const fmt = (label: string, r: RungReport) =>
      `  ${label.padEnd(10)} on=${String(r.on).padEnd(5)} rung=${r.rung} live=${String(r.liveRung)} ` +
      `baked=${String(r.baked).padStart(4)} defines=[${r.defines.join(', ')}]`
    console.info(
      `\nDEV-237 rung flip — ${MISSION}, flat path\n${fmt('A off', off)}\n${fmt('B rung 1', one)}\n` +
        `${fmt('C rung 3', three)}\n${fmt('A off', offAgain)}`,
    )

    expect(off.defines, 'the shipped build carries neither define').toEqual([])
    expect(
      { on: one.on, live: one.liveRung },
      'rung 1 did not reach the terrain materials',
    ).toEqual({ on: true, live: 1 })
    expect(one.defines, 'rung 1 must carry BOTH defines, in this order').toEqual([
      'FF2_BAKED_LIGHT',
      'FF2_BAKED_RUNG1',
    ])
    expect(
      { on: three.on, live: three.liveRung },
      'rung 3 did not reach the terrain materials',
    ).toEqual({ on: true, live: 3 })
    // Rung 3 is the arm DEV-232 measured and it must carry exactly what it
    // carried then — one define, not two with one of them empty.
    expect(three.defines, 'rung 3 must carry only the light define').toEqual(['FF2_BAKED_LIGHT'])
    // The bracket. Anything left behind here is a baseline that depends on
    // which treatment ran before it.
    expect(offAgain.defines, 'the OFF arm did not come back to the shipped state').toEqual([])
    expect(offAgain.baked, 'the OFF arm left baked colour buffers behind').toBe(0)
  })
})
