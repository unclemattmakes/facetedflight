/**
 * The gate on DEV-192's MECHANISM — *"every material this world draws has had
 * the point-light loop cut out of it, or is on a named list of the ones that
 * must not or cannot"*.
 *
 * **Not a millisecond.** `VR-PERF-WAVE-2-WORK.md` §0 and CLAUDE.md say why: a
 * frame time on this box is a measurement, not a guard, and a guard that goes
 * red when the machine is warm teaches everyone to ignore it. What this asserts
 * is the thing that would actually rot — the NEXT material somebody adds to the
 * world silently missing the sweep, which costs two `RE_Direct_Physical`
 * evaluations per fragment for ever and is invisible in every screenshot.
 *
 * ── Why the rule is written HERE and not asked for ───────────────────────
 *
 * `__ff2.pointLightScope()` returns rows and no verdict. The exemptions below
 * are this file's own reading of the rule, written out longhand; the engine's
 * is `boot/app.ts`'s `scopeWorldPointLights(render.scene, [loadedFlight.object])`.
 * If the two ever disagree — a new near-eye instrument parented outside the
 * ship group, a lamp given a bigger `distance`, a fifth vehicle — this spec
 * fails. A spec that asked the page *"is everything fine?"* would be asserting
 * a conclusion the implementation reached, and would agree with itself for ever
 * (CLAUDE.md trap 24).
 *
 * Tagged `@gpu`: it needs a real world, which needs the hydrated `public/`.
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/point-light-scope.spec.ts
 */

import { missionReady } from './fixtures/boot'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { expect, test } from './fixtures/test'

type ScopeRow = {
  path: string
  material: string
  name: string
  drawn: boolean
  scoped: boolean
  scope: string | null
}

/**
 * The ONE exemption, spelled as the two vehicle groups because there are two
 * vehicles.
 *
 * `render/cockpit-interior.ts` hangs both lamps off `art_pivot` AT THE EYE, so
 * the geometry inside their 3 m and 1.8 m cutoffs is the cockpit shell, the
 * cabin body, the exterior hull (its inner faces, in third person) and the dash
 * instruments — and all of those are under the ship group. The lamps are for
 * the cabin; the cabin is the ship.
 *
 * The JumpSeat is here for completeness rather than need: `jumpseat-flight.ts`
 * never calls `createCockpitInterior`, so six of the thirteen missions have no
 * point lights at all and have always drawn the world with the loop compiled
 * out. That is worth knowing — *the world without these lamps is not a
 * hypothetical, it is what half the game already renders.*
 */
const CABIN_ROOTS = ['/mission/hoverjet/', '/mission/jumpseat/'] as const

/**
 * Material classes with no direct-lighting stack, so there is nothing for the
 * cut to remove and no cost for them to pay.
 *
 * This is not a convenience list: three's own
 * `#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )` — the very statement
 * DEV-192 rewrites — already removes the loop for any shader that does not
 * define `RE_Direct`, and `meshbasic.glsl.js` contains none of the lighting
 * chunks. `tests/unit/point-light-scope.test.ts` asserts that against three's
 * own `ShaderLib` rather than against this list.
 */
const UNLIT_CLASSES = new Set([
  'MeshBasicMaterial',
  'ShaderMaterial',
  'RawShaderMaterial',
  'MeshDepthMaterial',
  'MeshNormalMaterial',
  'PointsMaterial',
  'SpriteMaterial',
  'LineBasicMaterial',
  'LineDashedMaterial',
])

const isCabin = (row: ScopeRow): boolean => CABIN_ROOTS.some((root) => row.path.includes(root))

const read = async (page: import('@playwright/test').Page): Promise<ScopeRow[]> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    const fn = w.__ff2?.pointLightScope
    if (typeof fn !== 'function') throw new Error('__ff2.pointLightScope() is missing')
    return fn() as ScopeRow[]
  })

/**
 * Two missions, and they disagree about everything this gate can be wrong
 * about: `int_01_hoverJet` is Simonet, a HoverJet with both cabin lamps, an
 * ocean and a launch ride; `rookie_02_hoverJet` is the desert, no ocean, a
 * different prop set and a different sun. One environment silently underwriting
 * a rule about the whole world is how the env-root bug survived for months
 * (CLAUDE.md, the agreement lesson).
 */
const MISSIONS = ['int_01_hoverJet', 'rookie_02_hoverJet'] as const

test.describe('@gpu DEV-192 — the point-light cut reaches every material the world draws', () => {
  test.setTimeout(600_000)

  for (const mission of MISSIONS) {
    test(`every lit material outside the cabin carries the cut — ${mission}`, async ({ page }) => {
      const problems = watchPageErrors(page)
      // `title=0&menu=0`: this spec sweeps THE MISSION WORLD's materials, and
      // since DEV-281 a bare boot stands on the title screen and builds no
      // mission at all. Two shipped switches that mean "go straight to the
      // cockpit" — not a test path; a player can type either.
      //
      // What leaves the sweep with them is the TITLE valley's own materials,
      // which used to be in this scene because boot built both worlds. Nothing
      // is lost: the cut being swept is `NUM_POINT_LIGHTS`, the only point
      // lights in the game are the cockpit's two lamps, and a title screen has
      // no cockpit — so three never emits the loop there and there is nothing
      // to cut.
      await page.goto(`/?xr=off&title=0&menu=0&ride=0&edition=anniversary&mission=${mission}`)
      await firstPress(page)
      await missionReady(page, 180_000)
      // The sweep runs at the end of the world build and the materials only
      // record what the cut DID once they have compiled, so let the world
      // actually draw for a few frames before reading.
      await page.waitForTimeout(4_000)

      const rows = await read(page)
      expect(rows.length, 'the scene walk found no materials at all').toBeGreaterThan(50)

      // ── the gate ────────────────────────────────────────────────────────
      const missed = rows.filter((r) => !r.scoped && !isCabin(r) && !UNLIT_CLASSES.has(r.material))
      expect(
        missed.map((r) => `${r.material} @ ${r.path}`),
        'lit world materials the point-light cut never reached — either sweep them in ' +
          "boot/app.ts or add them to this spec's named exemptions with a reason",
      ).toEqual([])

      // ── and the cut LANDED, rather than being installed and inert ───────
      //
      // `scoped` says the patch was installed; `scope` says what it did when
      // the shader compiled. A lit material that came back `'unlit'` means the
      // anchor was not there — a no-op wearing a feature's clothes, which is
      // the failure mode this whole family of files keeps paying for.
      const inert = rows.filter(
        (r) => r.scoped && r.scope === 'unlit' && !UNLIT_CLASSES.has(r.material),
      )
      expect(
        inert.map((r) => `${r.material} @ ${r.path}`),
        'materials that were swept but whose shader had no point-light loop to cut',
      ).toEqual([])

      // ── the exemption is REAL, not vacuous ──────────────────────────────
      //
      // If the cabin ever stopped being exempt — a refactor that renamed the
      // ship group, say — every assertion above would still pass while the
      // lamps quietly stopped lighting the thing they exist for. So assert the
      // other side: the cockpit shell is present, lit, and NOT cut.
      const cabin = rows.filter((r) => isCabin(r) && !UNLIT_CLASSES.has(r.material))
      expect(
        cabin.length,
        'no lit cabin material found — has the ship group been renamed?',
      ).toBeGreaterThan(0)
      expect(
        cabin.filter((r) => r.scoped).map((r) => r.path),
        'the cabin lost the lamps it exists to be lit by',
      ).toEqual([])

      // ── and the world really was swept ──────────────────────────────────
      const cut = rows.filter((r) => r.scope === 'cut')
      expect(cut.length, 'nothing in this world had the loop cut out of it').toBeGreaterThan(20)
      console.info(
        `${mission}: ${rows.length} materials — ${cut.length} cut, ` +
          `${cabin.length} lit cabin materials exempt, ` +
          `${rows.filter((r) => UNLIT_CLASSES.has(r.material)).length} unlit, ` +
          `${rows.filter((r) => !r.drawn).length} not drawn on this frame`,
      )

      expect(problems.list(), 'page errors (a shader that failed to compile lands here)').toEqual(
        [],
      )
    })
  }
})
