/**
 * tests/e2e/lod-fade-hitch.spec.ts — the first LOD cross-fade compiles nothing.
 *
 * DEV-184, and it is `ride-hitch.spec.ts`'s shape for a different first draw.
 *
 * ── Why this exists now and not with DEV-130 ─────────────────────────────
 *
 * The fade's clone used to be free: `cloneOf` gave it the BASE's program cache
 * key on purpose, so three handed back the program the base had already
 * compiled and a fade cost no compile at all. DEV-184 took the `discard` out of
 * the base's shader text and put it behind a `#define` the clones carry — which
 * makes the clone a SECOND program, and its first draw is a LOD change, in
 * flight, in the clear.
 *
 * `render/warm-up.ts` is where that program is meant to be built, from
 * `LoadedTerrain.warmLodFade()`. Nothing else can tell whether it worked: the
 * unit tests prove the clone's key differs from the base's (which is what makes
 * it a second program) and `ride-hitch.spec.ts` covers the ride, where no chunk
 * changes LOD. **A warm that compiled the wrong variant — the canvas's colour
 * space instead of the composer's, the launch room's light count instead of the
 * flight's, both of which are fields of three's program cache key — would leave
 * every one of those green and still hitch on the first fade.**
 *
 * ── What is asserted, and why it is not a frame time ─────────────────────
 *
 * The MECHANISM, like DEV-117's: `renderer.info.programs.length` must not move
 * across a fade. A frame-time threshold belongs to a machine; a program count
 * is the same number on every one of them.
 *
 * The fade is provoked the way `lod-pop.spec.ts` provokes a swap — a stand at a
 * `?view=cam` viewpoint with the look point exactly on the 1,024 m band, and
 * the eye stepped along the look bearing far enough to carry chunks across it.
 * Anniversary only: Classic has no `lodFade` preset, cuts no clone, and would
 * measure a fade that cannot happen.
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/lod-fade-hitch.spec.ts
 *
 * `@gpu`: a real world and a real shader compiler.
 */

import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { expect, type Page, test } from './fixtures/test'

const MISSION = process.env.FADE_HITCH_MISSION ?? 'int_01_hoverJet'
/** `lod-pop.spec.ts`'s `band1024` stand, unchanged — the look point is a lit face at 338 m. */
const EYE = [1196, 500, -795] as const
const LOOK = [522, 338, -1533] as const
const NUDGE = 250

const read = (page: Page): Promise<{ programs: number; fading: number; pending: number }> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: {
        render: { renderer: { info: { programs: unknown[] } } }
        terrain: () => { terrain: { fadingChunks: number; pending: number } } | null
      }
    }
    const t = w.__ff2.terrain()
    return {
      programs: w.__ff2.render.renderer.info.programs.length,
      fading: t?.terrain.fadingChunks ?? 0,
      pending: t?.terrain.pending ?? 0,
    }
  })

const setEye = (page: Page, eye: readonly number[]): Promise<void> =>
  page.evaluate(
    ([x, y, z]) => {
      const w = globalThis as unknown as {
        __ff2: { render: { camera: { position: { set(x: number, y: number, z: number): void } } } }
      }
      w.__ff2.render.camera.position.set(x as number, y as number, z as number)
    },
    eye as unknown as number[],
  )

/** Two render loops from now, so `updateLod` has run at least once. */
const twoFrames = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )

const settle = (page: Page): Promise<unknown> =>
  page.waitForFunction(
    () => {
      const t = (
        globalThis as unknown as {
          __ff2?: { terrain: () => { terrain: { pending: number; detailPending: number } } | null }
        }
      ).__ff2?.terrain?.()
      return !!t && t.terrain.pending === 0 && t.terrain.detailPending === 0
    },
    undefined,
    { timeout: 120_000 },
  )

test.describe('@gpu the first LOD cross-fade compiles nothing — DEV-184', () => {
  test.setTimeout(420_000)

  test(`${MISSION} anniversary: programs constant across a fade`, async ({ page }) => {
    const warmLines: string[] = []
    page.on('console', (m) => {
      if (m.text().includes('warm-up:')) warmLines.push(m.text())
    })
    await page.goto(
      `/?view=cam&xr=off&ride=0&eye=${EYE.join(',')}&look=${LOOK.join(',')}` +
        `&edition=anniversary&mission=${MISSION}`,
    )
    await firstPress(page)
    await missionReady(page, 240_000)
    await settle(page)
    // The detail ring fills in over the first frames and the stand's own chunks
    // may still be walking from the spawn's LOD to the eye's. All of that is
    // first-draw work and none of it is the subject.
    await page.waitForTimeout(3_000)
    await settle(page)

    // The warm-up must have reported a terrain warmed, or a green run below
    // could mean "no clone was ever cut" rather than "the clone was ready".
    expect(warmLines.length, 'the warm-up ran at world build').toBeGreaterThan(0)
    expect(warmLines.join(' '), 'warmLodFade put a clone in front of the warm-up draw').toMatch(
      /lod-fade clones warmed: [1-9]/,
    )

    const before = await read(page)
    expect(before.fading, 'settled: nothing is fading yet').toBe(0)

    // Step along the look bearing, horizontal, so chunks cross the 1,024 m band.
    const bx = LOOK[0] - EYE[0]
    const bz = LOOK[2] - EYE[2]
    const len = Math.hypot(bx, bz)
    await setEye(page, [EYE[0] + (bx / len) * NUDGE, EYE[1], EYE[2] + (bz / len) * NUDGE])
    await twoFrames(page)
    await setEye(page, EYE)
    await twoFrames(page)

    // The replies land over the next second or so and each one starts a fade.
    // Poll for the fade rather than sleeping for it: a fade that never happened
    // would otherwise pass this spec by doing nothing.
    await expect
      .poll(async () => (await read(page)).fading, { timeout: 60_000, intervals: [50] })
      .toBeGreaterThan(0)
    const mid = await read(page)
    // Let every fade start, run and finish. 2016 authored 1 s on Simonet's
    // islands and the nudge is larger than the hysteresis band, so the chunks
    // walk out and back: two transitions, plus slack.
    await page.waitForTimeout(6_000)
    const after = await read(page)

    console.info(
      `\nDEV-184 fade — ${MISSION} anniversary: fading peaked at ${mid.fading} chunks; ` +
        `programs ${before.programs} -> ${mid.programs} -> ${after.programs}\n  ${warmLines.join('\n  ')}\n`,
    )
    expect(mid.programs, 'no program was compiled when the fade started').toBe(before.programs)
    expect(after.programs, 'and none while it ran or when it ended').toBe(before.programs)
  })
})
