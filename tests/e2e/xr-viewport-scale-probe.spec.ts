/**
 * tests/e2e/xr-viewport-scale-probe.spec.ts — did the resolution request reach
 * an `XRView`, and did the runtime honour it? One reading, told apart.
 *
 * DEV-236's refusal fired on its first run: `asked median 0.600, eye width
 * 2016–2016 px`. The refusal's own text names the two explanations and says
 * one reading separates them; the trace header does not carry that reading,
 * so this spec takes it inside a live session.
 *
 * The method on the page's own `XRView.prototype` is wrapped to COUNT calls
 * and remember the last scale asked — harness-side, in the page, touching no
 * `src/`. Then, once a second:
 *
 *   calls        how many times the app asked, since the wrap
 *   last         the scale it asked for
 *   proto        whether `XRView.prototype.requestViewportScale` exists at all
 *   applied      `__ff2perf.quality().viewportScale` — the app's own record
 *   recommended  `__ff2perf.session().views[0].recommendedViewportScale`, the UA's hint
 *   eyeWidth     `renderer.xr.getCamera().cameras[0].viewport.z`, what three drew
 *
 * `calls === 0` with `proto` present is OUR defect: the loop never reaches a
 * view. `calls > 0` with `eyeWidth` pinned at the header is the RUNTIME
 * declining, which the spec permits. Counts and states, never a millisecond.
 *
 *   VRTO3D_MISSION=int_02_hoverJet pnpm exec playwright test \
 *     tests/e2e/xr-viewport-scale-probe.spec.ts --workers 1 --retries 0
 */

import { knownRed } from './fixtures/known-red'
import { enterVr, loadSettled } from './fixtures/landing'
import { expect, requireImmersiveDevice, test } from './fixtures/xr-browser'

const MISSION = process.env.VRTO3D_MISSION ?? 'int_02_hoverJet'
const SAMPLES = Number(process.env.PROBE_SAMPLES ?? '15')

test.describe('@measure @gpu vrto3d viewport-scale probe', () => {
  test.setTimeout(420_000)

  test('reads whether requestViewportScale reached a view and whether the eye shrank', async ({
    page,
  }) => {
    knownRed('KR-12')
    await page.goto(`/?perf=1&mission=${MISSION}&autopilot=1`)
    // DEV-265: say it now, with the rig named, rather than spending the wait
    // below proving a fact the capability probe already had.
    await requireImmersiveDevice(page)
    await loadSettled(page, 120_000)

    // Wrap BEFORE the session so the very first presenting frame is counted.
    const wrapped = await page.evaluate(() => {
      const g = globalThis as unknown as {
        XRView?: { prototype: { requestViewportScale?: (s: number) => void } }
        __probeVs?: { calls: number; last: number | null; proto: boolean; threw: string | null }
      }
      const proto = g.XRView?.prototype
      const original = proto?.requestViewportScale
      const state = {
        calls: 0,
        last: null as number | null,
        proto: typeof original === 'function',
        threw: null as string | null,
      }
      g.__probeVs = state
      if (proto && typeof original === 'function') {
        proto.requestViewportScale = function (this: unknown, s: number) {
          state.calls += 1
          state.last = s
          try {
            return original.call(this, s)
          } catch (e) {
            state.threw = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
            throw e
          }
        }
      }
      return state
    })
    console.info(`  probe: XRView.prototype.requestViewportScale present = ${wrapped.proto}`)

    // ── PROBE_NO_LAYERS=1: force three onto the `XRWebGLLayer` path ────────
    //
    // three 0.185.1 picks the projection-layer path on
    // `'createProjectionLayer' in XRWebGLBinding.prototype` alone
    // (WebXRManager.js:426), and the session's `layers` feature cannot be
    // dropped to reach the other path: with the feature absent three still
    // calls `updateRenderState({ layers })` and the session rejects before
    // its first frame (main.ts, DEV-160). Removing the method from the page's
    // prototype is the one switch that reaches `getViewport(view)` instead of
    // `getViewSubImage(...).viewport`, which is the reading this run needs:
    // whether the runtime declines the requested scale on BOTH paths or on
    // the Layers path only. Harness-side, in the page, before the session.
    if (process.env.PROBE_NO_LAYERS === '1') {
      const removed = await page.evaluate(() => {
        const g = globalThis as unknown as {
          XRWebGLBinding?: { prototype: { createProjectionLayer?: unknown } }
        }
        const proto = g.XRWebGLBinding?.prototype
        if (!proto || !('createProjectionLayer' in proto)) return false
        // biome-ignore lint/performance/noDelete: the point is that `in` must read false
        delete proto.createProjectionLayer
        return !('createProjectionLayer' in proto)
      })
      console.info(
        `  probe: createProjectionLayer removed from XRWebGLBinding.prototype = ${removed}`,
      )
    }

    await enterVr(page)
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const w = globalThis as unknown as {
              __ff2?: { render?: { renderer?: { xr?: { isPresenting?: boolean } } } }
            }
            return w.__ff2?.render?.renderer?.xr?.isPresenting ?? false
          }),
        { timeout: 120_000, intervals: [500] },
      )
      .toBe(true)

    const rows: string[] = []
    for (let i = 0; i < SAMPLES; i++) {
      await page.waitForTimeout(1000)
      const r = await page.evaluate(() => {
        const w = globalThis as unknown as {
          __probeVs?: { calls: number; last: number | null; proto: boolean; threw: string | null }
          __ff2perf?: {
            quality?: () => { viewportScale?: number | null; scale?: number }
            session?: () => {
              layer?: string | null
              views?: { recommendedViewportScale?: number | null }[]
            } | null
          }
          __ff2?: {
            render?: {
              renderer?: { xr?: { getCamera?: () => { cameras?: { viewport?: { z: number } }[] } } }
            }
          }
        }
        const q = w.__ff2perf?.quality?.()
        const x = w.__ff2perf?.session?.()
        const cams = w.__ff2?.render?.renderer?.xr?.getCamera?.()?.cameras ?? []
        return {
          calls: w.__probeVs?.calls ?? -1,
          last: w.__probeVs?.last ?? null,
          threw: w.__probeVs?.threw ?? null,
          applied: q?.viewportScale ?? null,
          step: q?.scale ?? null,
          recommended: x?.views?.[0]?.recommendedViewportScale ?? null,
          layer: x?.layer ?? null,
          eyeWidth: cams[0]?.viewport?.z ?? null,
        }
      })
      rows.push(
        `  t+${String(i + 1).padStart(2)}s  calls ${r.calls}  last ${r.last}  applied ${r.applied}  step ${r.step}  recommended ${r.recommended}  layer ${r.layer}  eyeWidth ${r.eyeWidth}${r.threw ? `  THREW ${r.threw}` : ''}`,
      )
    }
    console.info(
      `\nviewport-scale probe — ${MISSION}, ${SAMPLES} samples in session\n${rows.join('\n')}`,
    )

    const last = await page.evaluate(
      () => (globalThis as unknown as { __probeVs?: { calls: number } }).__probeVs?.calls ?? -1,
    )
    // The one assertion: the probe itself worked. The verdict is in the rows.
    expect(
      last,
      'the wrap never saw the page; the probe is broken, not the app',
    ).toBeGreaterThanOrEqual(0)
  })
})
