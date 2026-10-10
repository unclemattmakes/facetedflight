/**
 * tests/e2e/fixtures/freeze.ts — fly to a `?snap=` mark and wait for the frozen
 * frame.
 *
 * ── What this is, and why it is a fixture ────────────────────────────────
 *
 * `?snap=<seconds>` freezes the SIM at a mission-clock mark and keeps
 * rendering. That is the same-tick A/B harness the whole measurement programme
 * rests on: two loads reach the same tick with the ship, the racers and the
 * course in the same place, because the autopilot decides on the fixed step
 * (DEV-027). One flag, one frozen frame, an exact delta — the lesson
 * `bloom-perf.spec.ts`'s header paid for, which is that *a delta between two
 * flights measures the flights*.
 *
 * Getting there is eight lines of Playwright and every one of them has a
 * reason. They were copied between `bloom-perf.spec.ts` and
 * `render-census.spec.ts` with the timeouts already diverged, and VR-PERF
 * §5.9 H2 adds a third consumer (`census-baseline.spec.ts`) that must land on
 * the SAME tick as a stored baseline — so a copy that drifts is a spec that
 * gates against a frame nobody else can reach. Hence one fixture.
 *
 * ── The harness does what a player does, and nothing else ────────────────
 *
 * `focusCanvas` (see `fixtures/canvas.ts`) clicks `#viewport` and then presses
 * the Escape the browser would perform, because the game really does capture
 * the pointer on that click and a captured pointer really does swallow every
 * other click on the page. `hold` presses Enter for 200 ms rather than tapping
 * it, which is what `pause.spec.ts` found the launch confirm wants. No switch
 * makes the build behave differently under test; there is nothing here a hand
 * could not do.
 *
 * ── The tick is BOUNDED, not pinned ──────────────────────────────────────
 *
 * `?snap=` fires on the first fixed step at or past the mark, and which step
 * that is depends on how many ticks the frame before it ran — so a load lands
 * on one of two adjacent ticks. Good enough for an A/B pair (both sides of a
 * pair are one load) and NOT good enough for a stored baseline, which is why
 * H2's spec reads `__ff2perf.sim().tick` and retries the load until it matches.
 * `frozenTick` is here so it does not have to reimplement the read.
 */
import { expect } from '@playwright/test'
import { focusCanvas } from './canvas'
import { hold as keysHold } from './keys'
import { firstPress } from './landing'

type Page = import('@playwright/test').Page

export interface FreezeOptions {
  /** Level id, e.g. `int_01_hoverJet`. */
  readonly mission: string
  /** `classic` or `anniversary`. */
  readonly edition: string
  /** Mission seconds at which the sim freezes. */
  readonly snapAt: number
  /**
   * How long to wait for `data-terrain-ready`. Alpine and the desert generate
   * more than Simonet does, and a cold `pnpm dev` compiles on the first load;
   * 240 s is the ceiling `render-census.spec.ts` measured it wanting.
   */
  readonly terrainTimeoutMs?: number
  /**
   * How long to sit on the frozen frame before reading anything. The default
   * 5 s is `boot/perf-recorder.ts`'s 3 s window plus margin, so the
   * percentiles that come back belong to the frozen frame and not to the
   * flight that reached it.
   */
  readonly settleMs?: number
  /**
   * Extra query parameters, e.g. `perf=1`. `autopilot=1` and `xr=off` are
   * DEFAULTS, not fixtures — the spread puts these last, so a spec can override
   * either. (This said "always set" until DEV-265, and a spec believed it.)
   */
  readonly params?: Readonly<Record<string, string>>
  /**
   * Let the page probe `isSessionSupported('immersive-vr')` — omit `xr=off`.
   *
   * **Only for a spec that has already installed an emulated runtime** (see
   * `fixtures/emulated-xr.ts`). The default is off because the probe is not a
   * passive query: it starts the machine's OpenXR runtime, and on a box whose
   * registered runtime is SteamVR that launches Steam on every page load.
   * IWER replaces `navigator.xr` outright with `forceInstall: true`, so under
   * it the probe is pure JavaScript and starts nothing.
   *
   * It is not optional for such a spec, it is REQUIRED: under `xr=off` the
   * capability gate reports no headset, `main.ts` never registers the handler
   * that enables `#enter-vr`, and the button can never come out of `disabled`.
   * That is DEV-265 — `xr-emulated-perf.spec.ts` installed a working emulated
   * headset and then told the page not to look for one.
   */
  readonly xrProbe?: boolean
}

/** Held, not tapped — `pause.spec.ts` says why. */
export const hold = (page: Page, key: string): Promise<void> =>
  keysHold(page, key, { down: 200, settle: 200 })

/**
 * Load the mission with the autopilot flying, launch it, and return once the
 * sim has frozen at the mark and the frame-time window has refilled.
 *
 * `xr=off` skips `isSessionSupported('immersive-vr')`, which starts this
 * machine's OpenXR runtime — on a box where that is SteamVR, every page load
 * would launch Steam (CLAUDE.md). Pass `xrProbe: true` to lift it; nothing else
 * should.
 */
export const flyToFreeze = async (page: Page, options: FreezeOptions): Promise<void> => {
  const query = new URLSearchParams({
    autopilot: '1',
    ...(options.xrProbe ? {} : { xr: 'off' }),
    snap: String(options.snapAt),
    edition: options.edition,
    mission: options.mission,
    ...(options.params ?? {}),
  })
  await page.goto(`/?${query.toString()}`)
  await firstPress(page)
  await expect(page.locator('body')).toHaveAttribute('data-terrain-ready', 'true', {
    timeout: options.terrainTimeoutMs ?? 240_000,
  })
  await focusCanvas(page)
  await hold(page, 'Enter')
  await expect.poll(() => isFrozen(page), { timeout: 180_000, intervals: [250] }).toBe(true)
  await page.waitForTimeout(options.settleMs ?? 5_000)
}

/** Whether the sim has reached the mark and stopped. */
export const isFrozen = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const w = globalThis as unknown as { __ff2?: { snap: () => { frozen: boolean } } }
    return w.__ff2?.snap().frozen ?? false
  })

export interface FrozenSim {
  /** Fixed steps since BOOT — the ride is in it. See `missionTick` below. */
  readonly tick: number
  /** MISSION seconds: the clock `?snap=` compares against. */
  readonly elapsed: number
  readonly ticksPerSecond: number
  readonly snapped: boolean
}

/**
 * The sim's clock at the frozen frame, from the production perf surface.
 *
 * `__ff2perf` rather than `__ff2` on purpose (VR-PERF §5.4): it is the handle
 * that exists on a deployed build, so a spec that reads it is exercising the
 * surface a headset session has. Returns null where the surface is absent —
 * a build without `?perf=1`, or one from before the surface landed.
 */
export const frozenSim = (page: Page): Promise<FrozenSim | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as { __ff2perf?: { sim: () => FrozenSim } }
    const sim = w.__ff2perf?.sim()
    return sim && typeof sim.tick === 'number' ? sim : null
  })

/**
 * The fixed step index WITHIN THE MISSION — what `?snap=` actually pins.
 *
 * **`sim().tick` counts from BOOT and is the wrong key for a baseline**, and
 * this is measured rather than reasoned: `census-baseline.spec.ts` wrote
 * `int_01` at tick 3380 and then, on three fresh loads of the same build at
 * the same `?snap=20`, saw 3362, 3360 and 3362. `rookie_01` wrote 3350 and saw
 * 3362, 3341, 3343. The spread is ~20 ticks — a quarter of a second — and it
 * is **the launch ride**, whose wall-clock length varies from load to load and
 * which the boot counter carries into every frozen frame.
 *
 * The mission clock does not. `?snap=<s>` fires on the first fixed step where
 * mission elapsed >= s, so the step INDEX is `ceil(s / dt)` — the same integer
 * on every load, whatever the ride did. `elapsed` accumulates `dt` per tick, so
 * `round(elapsed x ticksPerSecond)` recovers that index; rounding absorbs the
 * float drift of a few thousand additions.
 *
 * Derived here rather than in the spec so the next consumer cannot key on the
 * boot tick by accident, the way the first one did.
 */
export const missionTickOf = (sim: FrozenSim): number =>
  Math.round(sim.elapsed * sim.ticksPerSecond)
