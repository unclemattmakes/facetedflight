/**
 * tests/e2e/ocean-shaft.spec.ts — what the launch shaft's hole costs the sea
 * for the rest of the mission.
 *
 * ── The hypothesis, from reading rather than from measuring ───────────────
 *
 * `render/water.ts` punches the launch shaft through the ocean with a
 * `discard`, behind `FF2_WATER_SHAFT`:
 *
 *     #ifdef FF2_WATER_SHAFT
 *       if (uShaftBore.z > 0.0 && ... ) discard;
 *     #endif
 *
 * A `discard` anywhere in a fragment shader disables early-Z for the whole
 * draw, and this draw is a **262 km plate covering the horizon**. The bore is
 * needed while the ship is inside the tube — the water plane is horizontal and
 * the shaft walls are vertical, so without the hole there is a ceiling of sea
 * above you on the ride (DEV-106 sealed the tube; `shaft-walls.test.ts`).
 *
 * **`clearShaftBore()` exists and `boot/app.ts` never calls it.** Only four
 * unit tests do. `water-fog-flag.test.ts` even says so in a comment. So the
 * define is live for every frame of every mission, long after the ship has
 * left the shaft.
 *
 * (DEV-460, later: `boot/app.ts` now clears it once the lift plugs the shaft's
 * hatch, at the top of the ride, so a mission past its launch runs without it.
 * This spec sets its own bore on a live page, so it measures the same arm.)
 *
 * This matters because it is **DEV-184's exact class**, and DEV-184 — a
 * `discard` removed from the terrain — was the single biggest win of the perf
 * programme at **1.33 ms/eye**.
 *
 * And there is a reasoning slip in `water.ts` that explains how it survived.
 * The comment beside the shaft test says it *"costs a subtraction and a
 * compare, not early-z"*, which is true only while `FF2_WATER_TWO_SIDED` is
 * ALSO on — and that one is set from `setEyeHeight`, i.e. near the surface. In
 * ordinary flight the shaft `discard` is the only one, so it is not riding
 * along free: it is the thing paying.
 *
 * ── Why this is an A-B-A on ONE load ──────────────────────────────────────
 *
 * `perf-protocol.md` §3a-ter: this laptop cannot compare two LOADS of a
 * fill-dominated cost, because the GPU throttles inside the reading window.
 * So the bore is cleared and restored on a live page — §3d's "make the thing
 * switchable live" — and the run brackets itself.
 *
 * Nothing needs adding to `src/` to do it: `__ff2.terrain().ocean.water` is
 * already the live `Water`, and `clearShaftBore()` / `setShaftBore()` are on
 * its public surface. **The arm proves itself in a COUNT before any
 * millisecond is believed** — the program cache key must actually lose
 * `FF2_WATER_SHAFT`, or the define never left the shader and the two readings
 * are of one thing.
 *
 * All four variants are warmed at load (`for side × for cut` in `water.ts`),
 * so the flip costs no compile — which is what makes this safe to do in flight
 * as well as safe to measure.
 *
 *   OCEAN_SHAFT_MISSION=int_01_hoverJet OCEAN_SHAFT_AT=20 \
 *     E2E_PORT=<yours> pnpm exec playwright test tests/e2e/ocean-shaft.spec.ts --workers 1
 */

import type { Ff2Global } from './fixtures/ff2'
import { flyToFreeze } from './fixtures/freeze'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

const EYE_PX = Number(process.env.OCEAN_SHAFT_EYE ?? '2516')
const DPR = Number(process.env.OCEAN_SHAFT_DPR ?? '2')
const VIEWPORT = Math.round(EYE_PX / DPR)
const MISSION = process.env.OCEAN_SHAFT_MISSION ?? 'int_01_hoverJet'
const SNAP_AT = Number(process.env.OCEAN_SHAFT_AT ?? '20')
const SETTLE_MS = 1_500
const READ_MS = Number(process.env.OCEAN_SHAFT_READ_MS ?? '3000')
const RETRIES = 3

/** `perf-fill.spec.ts`'s reader, unchanged: an empty ring reads n/a, never 0. */
const gpuMs = async (page: Page): Promise<number | null> => {
  const supported = await page.evaluate(() => {
    const g = (globalThis as unknown as Ff2Global).__ff2.gpu
    g.enable()
    return g.supported
  })
  if (!supported) return null
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    await page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.gpu.reset())
    await page.waitForTimeout(READ_MS * (attempt + 1))
    const read = await page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.gpu.stats())
    if (read.frames >= 30) return read.medianMs
  }
  return null
}

/**
 * How many of the OCEAN's live materials still carry the shaft define.
 *
 * Read off the materials, NOT off `renderer.info.programs`. That list is
 * three's program CACHE, and `water.ts` warms all four variants at load, so
 * every one of them sits in it for the life of the page whether or not anything
 * draws with it. The first version of this arm counted cache entries, found the
 * warmed ones, and reported that clearing the bore had changed nothing — which
 * is this repo's own lesson arriving from a third direction: *an instrument
 * that agrees with itself has not been tested.* `perf-scale.spec.ts`'s header
 * says the same thing in the other direction — counting programs does not work,
 * because three releases one as it creates one.
 *
 * The material's `defines` is the state the next compile is keyed on, and it is
 * what `applyVariant` actually writes.
 */
const shaftMaterials = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const group = w.__ff2.terrain()?.ocean?.group as
      | { traverse: (fn: (o: unknown) => void) => void }
      | undefined
    if (!group) return -1
    let carrying = 0
    group.traverse((node) => {
      const mesh = node as { material?: unknown }
      const mats = Array.isArray(mesh.material)
        ? (mesh.material as { defines?: Record<string, unknown> }[])
        : mesh.material
          ? [mesh.material as { defines?: Record<string, unknown> }]
          : []
      for (const m of mats) {
        if (m.defines && Object.hasOwn(m.defines, 'FF2_WATER_SHAFT')) carrying++
      }
    })
    return carrying
  })

/** Clear the bore, or put it back where `boot/app.ts` left it. */
const setBore = (page: Page, on: boolean): Promise<boolean> =>
  page.evaluate((want) => {
    const w = globalThis as unknown as Ff2Global
    const water = w.__ff2.terrain()?.ocean?.water
    if (!water) return false
    // The exact bore boot/app.ts sets is not reachable from here, and does not
    // need to be: this measures whether the DEFINE is in the shader, and any
    // live radius puts it there. Restoring a bore of the same shape is what the
    // bracket needs — not the same numbers.
    if (want) water.setShaftBore(0, 0, 60, 120)
    else water.clearShaftBore()
    return true
  }, on)

test.use({
  viewport: { width: VIEWPORT, height: VIEWPORT },
  deviceScaleFactor: DPR,
  launchOptions: { args: ['--disable-gpu-vsync'] },
})

test.describe('@measure @gpu the shaft hole, after the ship has left the shaft', () => {
  test.setTimeout(1_800_000)

  test(`${MISSION} at ${SNAP_AT} s, ${EYE_PX}px square`, async ({ page }) => {
    await flyToFreeze(page, {
      mission: MISSION,
      edition: 'anniversary',
      snapAt: SNAP_AT,
      params: { adaptive: '0', quality: 'high' },
    })
    // `perf-fill.spec.ts`'s bounce, for its stated reason.
    await page.setViewportSize({ width: Math.round(VIEWPORT / 2), height: VIEWPORT })
    await page.waitForTimeout(SETTLE_MS)
    await page.setViewportSize({ width: VIEWPORT, height: VIEWPORT })
    await page.waitForTimeout(SETTLE_MS)

    const lines: string[] = []
    const reachable = await setBore(page, true)
    expect(reachable, 'no live ocean water on this mission — nothing to measure').toBe(true)
    await page.waitForTimeout(SETTLE_MS)

    // ── the arm proves itself in a COUNT, first ────────────────────────
    const boreKeys = await shaftMaterials(page)
    await setBore(page, false)
    await page.waitForTimeout(SETTLE_MS)
    const clearedKeys = await shaftMaterials(page)
    lines.push(
      `  arm: ocean materials carrying FF2_WATER_SHAFT — with bore ${boreKeys}, cleared ${clearedKeys}`,
    )
    expect(boreKeys, 'no ocean material reachable, or the bore was never set').toBeGreaterThan(0)
    expect(clearedKeys, 'clearShaftBore did not take the define off the materials').toBe(0)

    // A throwaway read after the arm change, like every other arm in this
    // suite: the first window after a variant swap pays for it.
    await setBore(page, true)
    await page.waitForTimeout(SETTLE_MS)
    await gpuMs(page)

    // ── A - B - A ──────────────────────────────────────────────────────
    await setBore(page, true)
    await page.waitForTimeout(SETTLE_MS)
    const a1 = await gpuMs(page)
    await setBore(page, false)
    await page.waitForTimeout(SETTLE_MS)
    const b = await gpuMs(page)
    await setBore(page, true)
    await page.waitForTimeout(SETTLE_MS)
    const a2 = await gpuMs(page)

    const fmt = (v: number | null) => (v === null ? '  n/a' : v.toFixed(2))
    if (a1 !== null && b !== null && a2 !== null) {
      const on = (a1 + a2) / 2
      lines.push(
        '',
        `  bore ON  ${fmt(a1)} ms   OFF ${fmt(b)} ms   ON ${fmt(a2)} ms` +
          `   drift ${Math.abs(a2 - a1).toFixed(2)}`,
        `  the discard costs ${(on - b).toFixed(2)} ms at one worn eye` +
          ` (${EYE_PX}px, ${((EYE_PX * EYE_PX) / 1e6).toFixed(2)} Mpx)`,
        '',
        '  §3c: worn ~= 2 x fill + 2 x (A - shadow) + 1 x shadow. A discard is a',
        '  FILL term, so the worn cost is about twice the number above.',
      )
      // The bracket is the evidence, not the difference. A drift larger than
      // the effect means the machine moved more than the arm did.
      const drift = Math.abs(a2 - a1)
      const effect = Math.abs(on - b)
      lines.push(
        drift < effect / 2
          ? '  bracket holds: the drift is under half the effect.'
          : '  <<< BRACKET TOO WIDE — the machine moved as much as the arm. Re-take on a quiet box.',
      )
    } else {
      lines.push('  GPU timer gave no usable window — nothing to report.')
    }
    console.info(
      [`\nocean-shaft — ${MISSION} anniversary, frozen at ${SNAP_AT} s`, ...lines].join('\n'),
    )
  })
})
