/**
 * The terrain-look frames — DEV-130, DEV-131, DEV-132.
 *
 * Fixed stands, both presets, saved where Playwright will not wipe them. Two
 * runs of this spec across a code change are a before/after pair at the same
 * pose; one run is a Classic/Anniversary pair. It exists so the three rows
 * carry photographs rather than adjectives (ART_DIRECTION: *"photograph the
 * thing, at the same tick, before believing it"*), and it fails on ANY page
 * error — which is how a shader that does not compile is caught: three logs
 * `THREE.WebGLProgram: Shader Error` to the console and draws nothing.
 *
 *   LOOK_DIR=<dir> E2E_PORT=<yours> pnpm exec playwright test tests/e2e/terrain-look-frames.spec.ts
 *
 * Tagged `@gpu`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { expect, test } from './fixtures/test'

const OUT_DIR = process.env.LOOK_DIR ?? 'test-results/terrain-look'
const EDITIONS = (process.env.LOOK_EDITIONS ?? 'classic,anniversary').split(',')
/**
 * Extra query parameters, `a=b&c=d`. Empty by default, so an ordinary run is
 * the run this spec has always taken.
 *
 * For a switch that can only be taken as two LOADS — `?terrainLit=` (DEV-182)
 * is the first, because a material CLASS is decided when the mesh is built and
 * there is no live setter for it. Two runs into two directories is then an A/B
 * pair at the same stand, which is what `tools/perf/png-diff.mjs` wants.
 */
const PARAMS = process.env.LOOK_PARAMS ?? ''
/**
 * Comma-separated stand names to shoot; empty means all of them. A pair that
 * only argues about one stand should not pay for four, and four times two
 * editions times a 2.5 s settle is most of a run.
 */
const ONLY = (process.env.LOOK_STANDS ?? '').split(',').filter((s) => s.length > 0)

/**
 * `int_01` is the 4-degree sun; `rookie_02` is the desert at 52.6 degrees. The
 * two Simonet stands are `lod-pop.spec.ts`'s: the lit hillside at 1 km and the
 * same slope from 320 m, inside the detail ring. The desert stands are the
 * route's 40th point raised, looking down the canyon, and a near view of the
 * same ground.
 */
const STANDS = [
  {
    name: 'int01-hillside-1km',
    mission: 'int_01_hoverJet',
    eye: [1196, 500, -795],
    look: [522, 338, -1533],
  },
  {
    name: 'int01-ring-320m',
    mission: 'int_01_hoverJet',
    eye: [738, 488, -1297],
    look: [522, 338, -1533],
  },
  {
    name: 'desert-canyon-high-sun',
    mission: 'rookie_02_hoverJet',
    eye: [459, 500, -1352],
    look: [50, 443, -1572],
  },
  {
    name: 'desert-ring-near',
    mission: 'rookie_02_hoverJet',
    eye: [540, 420, -1300],
    look: [459, 312, -1352],
  },
  /**
   * The REGISTERED `island-lit` stand — *"the massif with the sun across it —
   * terrain colour and shading"*, which is the frame `docs/ART_DIRECTION.md`'s
   * two ditches are both recognisable in.
   *
   * By NAME rather than by coordinates: `boot/viewpoints.ts` owns those three
   * numbers and a second copy here would be a second thing to keep in step. It
   * is a different eye from `int01-hillside-1km` above (700 m up and further
   * out, same look point), so both earn their place.
   */
  { name: 'int01-island-lit', mission: 'int_01_hoverJet', cam: 'island-lit' },
] as const

test.describe('@measure @gpu terrain look frames', () => {
  test.setTimeout(600_000)

  for (const edition of EDITIONS) {
    test(`photographs every stand — ${edition}`, async ({ page }) => {
      const problems = watchPageErrors(page)
      const dir = path.join(OUT_DIR, edition)
      fs.mkdirSync(dir, { recursive: true })
      for (const stand of STANDS) {
        if (ONLY.length > 0 && !ONLY.includes(stand.name)) continue
        // A registered `cam=` or an explicit eye/look; never both, and the
        // named one carries no copy of the numbers.
        const where =
          'cam' in stand
            ? `cam=${stand.cam}`
            : `eye=${stand.eye.join(',')}&look=${stand.look.join(',')}`
        await page.goto(
          `/?view=cam&xr=off&ride=0&${where}` +
            `&edition=${edition}&mission=${stand.mission}` +
            (PARAMS === '' ? '' : `&${PARAMS}`),
        )
        await firstPress(page)
        await missionReady(page, 120_000)
        // The ring fills in over the first frames and every fade must have run
        // its course: nothing in flight, then the length of the longest fade.
        await page.waitForFunction(
          () => {
            const w = globalThis as unknown as {
              __ff2?: {
                terrain: () => {
                  terrain: { pending: number; detailPending: number; fadingChunks: number }
                } | null
              }
            }
            const t = w.__ff2?.terrain?.()
            return (
              !!t &&
              t.terrain.pending === 0 &&
              t.terrain.detailPending === 0 &&
              t.terrain.fadingChunks === 0
            )
          },
          undefined,
          { timeout: 60_000 },
        )
        await page.waitForTimeout(2_500)
        const shot = await page.locator('#viewport').screenshot()
        fs.writeFileSync(path.join(dir, `${stand.name}.png`), shot)
      }
      expect(problems.list(), 'page errors (a shader that failed to compile lands here)').toEqual(
        [],
      )
    })
  }
})
