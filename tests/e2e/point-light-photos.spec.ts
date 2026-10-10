/**
 * DEV-192's photographs — *"does cutting the cabin lamps out of the world's
 * shaders move a single pixel?"*
 *
 * The row's claim is that it cannot, because both lamps carry a `distance`
 * (3 m and 1.8 m) and three's `getDistanceAttenuation` multiplies by exactly
 * zero past the cutoff. A claim of the form "this changes nothing" is the one
 * kind that must be photographed rather than reasoned about, and these stands
 * are chosen to be the ones most likely to prove it WRONG:
 *
 *  - `pad` — in the seat, on the start pad, before the launch. The pad is
 *    directly under the skids and the eye is 1.3 m above the cockpit floor, so
 *    if anything in the world is inside a 3 m lamp it is this.
 *  - `shaft` — mid-ride, in the elevator. The shaft wall is the closest world
 *    geometry the game ever puts to the pilot.
 *  - `gate` — frozen a few seconds into the run, flying at a ring. A gate is
 *    the one world object you deliberately pass THROUGH.
 *  - `cruise` — frozen well into the flight, the ordinary case, and the one
 *    the −0.38 ms was measured on.
 *
 * ── Two arms and a CONTROL, or it is not evidence ────────────────────────
 *
 * `tools/perf/png-diff.mjs`'s own header: a single run of one build against
 * itself once reported 60 % of a frame's pixels moving. So this shoots the same
 * stands three times — the cut build twice and `?pointLights=keep` once — and
 * the two cut runs ARE the noise floor the pair is read against.
 *
 * Frozen at a mission-clock mark through `fixtures/freeze.ts`, so both arms
 * reach the same tick with the ship, the racers and the course in the same
 * place (DEV-027). The cockpit shakes with speed and the HUD animates, which is
 * why a wall-clock wait would never have matched.
 *
 *   ARM=cut   PHOTO_DIR=perf-out/dev192/cut-1  E2E_PORT=<n> pnpm exec playwright test tests/e2e/point-light-photos.spec.ts
 *   ARM=cut   PHOTO_DIR=perf-out/dev192/cut-2  E2E_PORT=<n> pnpm exec playwright test tests/e2e/point-light-photos.spec.ts
 *   ARM=keep  PHOTO_DIR=perf-out/dev192/keep-1 E2E_PORT=<n> pnpm exec playwright test tests/e2e/point-light-photos.spec.ts
 *   node tools/perf/png-diff.mjs perf-out/dev192/cut-1 perf-out/dev192/keep-1 \
 *                                perf-out/dev192/cut-1 perf-out/dev192/cut-2
 *
 * `PHOTO_DIR` is outside `test-results/` on purpose: Playwright wipes that at
 * the start of every run, so a pair shot across two runs loses its first half.
 *
 * Tagged `@gpu`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { flyToFreeze } from './fixtures/freeze'
import { watchPageErrors } from './fixtures/page-errors'
import { expect, test } from './fixtures/test'

const OUT_DIR = process.env.PHOTO_DIR ?? 'perf-out/dev192/cut-1'
/** `cut` is the shipped build; `keep` pins the loop back in. */
const ARM = process.env.PHOTO_ARM ?? process.env.ARM ?? 'cut'
const EDITION = process.env.PHOTO_EDITION ?? 'anniversary'

/**
 * `snapAt` is MISSION seconds, so 0 is the moment the clock starts — the ship
 * on the pad with the launch behind it — and the ride happens before the
 * mission clock runs at all. `?ride=1` keeps the elevator so the shaft stand
 * has a shaft to be in.
 */
const STANDS = [
  { name: 'pad', mission: 'int_01_hoverJet', snapAt: 0.1 },
  { name: 'gate', mission: 'int_01_hoverJet', snapAt: 6 },
  { name: 'cruise', mission: 'int_01_hoverJet', snapAt: 20 },
  { name: 'desert-cruise', mission: 'rookie_02_hoverJet', snapAt: 20 },
] as const

/**
 * Comma-separated stand names; empty means all four. A question that only needs
 * one stand — *"does the cut move the program count?"* — should not pay for
 * four loads and a desert build.
 */
const ONLY = (process.env.PHOTO_STANDS ?? '').split(',').filter((s) => s.length > 0)

test.describe('@measure @gpu DEV-192: the photographs', () => {
  test.setTimeout(900_000)

  test(`shoots every stand — ${ARM}`, async ({ page }) => {
    const problems = watchPageErrors(page)
    fs.mkdirSync(OUT_DIR, { recursive: true })
    for (const stand of STANDS) {
      if (ONLY.length > 0 && !ONLY.includes(stand.name)) continue
      await flyToFreeze(page, {
        mission: stand.mission,
        edition: EDITION,
        snapAt: stand.snapAt,
        params: ARM === 'keep' ? { pointLights: 'keep' } : {},
      })
      // The arm actually reached the page. A photograph pair whose two halves
      // are the same build is the failure `png-diff.mjs` was written for, and
      // an ignored query parameter is the quietest way to produce one.
      const scoped = await page.evaluate(() => {
        const w = globalThis as unknown as {
          __ff2?: { pointLightScope?: () => { scoped: boolean; material: string }[] }
        }
        const rows = w.__ff2?.pointLightScope?.() ?? []
        return rows.filter((r) => r.scoped).length
      })
      if (ARM === 'keep') {
        expect(scoped, '?pointLights=keep did not reach the page — this arm is not an arm').toBe(0)
      } else {
        expect(scoped, 'the cut arm swept nothing').toBeGreaterThan(20)
      }
      // Program COUNT, which is the one perf number a shared box cannot spoil
      // (CLAUDE.md: counts, defines and cache keys survive contention;
      // durations do not). It is here because a cut that collapsed two
      // materials onto one program — or split one into two — would be a real
      // change wearing this row's clothes, and DEV-177 measured a single extra
      // program at 200 ms in the seat.
      const programs = await page.evaluate(() => {
        const w = globalThis as unknown as {
          __ff2?: { render: { renderer: { info: { programs?: unknown[] } } } }
        }
        return w.__ff2?.render.renderer.info.programs?.length ?? -1
      })
      console.info(`${ARM}/${stand.name}: ${programs} programs, ${scoped} materials scoped`)
      const shot = await page.locator('#viewport').screenshot()
      fs.writeFileSync(path.join(OUT_DIR, `${stand.name}.png`), shot)
    }
    expect(problems.list(), 'page errors (a shader that failed to compile lands here)').toEqual([])
  })
})
