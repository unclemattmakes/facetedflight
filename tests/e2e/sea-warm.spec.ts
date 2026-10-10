/**
 * tests/e2e/sea-warm.spec.ts — the sea is warmed with the binding it is drawn
 * with, and nothing about it compiles in the air.
 *
 * The DEV-186 follow-up, gated. `water.ts`'s `warmVariants` compiles the sea's
 * four shader variants under the loading curtain so the ride and the breach do
 * not pay for them (DEV-167 / W6). Until `warmWorld` grew `duringWarm` it was
 * called just AFTER `warmWorld` returned, and that `finally` has by then put
 * the canvas back and the launch room's lamp back — both of which three hashes
 * into the program cache key. So all four were built against a key nothing ever
 * asks for, and the real ones still compiled in flight.
 *
 * ── Why the existing specs could not have caught it ──────────────────────
 *
 * `ride-hitch.spec.ts` counts programs across the ride and was green through
 * the whole life of the bug, honestly: it holds Enter and never touches the
 * stick, so the ship hovers 11.3 m over a sea whose variant threshold is at 11.
 * **Inside the hysteresis, by 0.3 m.** The sea never leaves the two-sided
 * variant, so nothing compiles, so the count never moves. `lod-fade-hitch.spec`
 * and `lod-pop.spec` stand a `?view=cam` eye at a fixed height, which is the
 * same blind spot from the other side. **The bug needs the ship to FLY**, and
 * `?autopilot=1` is the entire difference between a spec that sees it and one
 * that does not.
 *
 * ── What is asserted, and why it is not a frame time ─────────────────────
 *
 * Both assertions are read off three's OWN program cache keys, so they are
 * machine-independent the way `ride-hitch.spec.ts`'s are — a wrongly-keyed
 * program is the bug at whatever speed this GPU compiles it, and a count needs
 * no quiet machine (`docs/testing/perf-protocol.md` §3a).
 *
 *   1. Every water program in the cache shares ONE `outputColorSpace`. A
 *      RELATIONSHIP, not a value: it holds on Classic (canvas, `srgb`) and on
 *      Anniversary (composer target, `srgb-linear`) and fails exactly when the
 *      warm and the draw disagree about which is bound. Measured on the old
 *      placement: four `srgb` programs beside four `srgb-linear` ones, and this
 *      assertion is red in 9.6 s — before the ride even starts.
 *   2. From the release to thirty seconds of flight, the number of water
 *      programs does not move. On the old placement it went 8 -> 10 on
 *      `int_01`, the two arriving at about 2.5 s and 15 s — compiles in the
 *      clear, which is the stall class DEV-177 is about.
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/sea-warm.spec.ts
 *
 * `@gpu`: a real world and a real compiler.
 */

import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

const MISSION = process.env.SEA_MISSION ?? 'int_01_hoverJet'
const EDITION = process.env.SEA_EDITION ?? 'anniversary'

/**
 * Whether this edition's sea carries the mirror at all. DEV-837 (Matt, 2026-10-08) turned
 * Anniversary's off, so the ultra arm's premise is read from the edition, not assumed.
 */
const MIRROR_ON =
  (
    JSON.parse(fs.readFileSync(path.resolve(`content/editions/${EDITION}.json`), 'utf8')) as {
      render?: { seaReflection?: { enabled?: boolean } }
    }
  ).render?.seaReflection?.enabled === true

/**
 * Every water program three is holding, as `outputColorSpace|numPointLights`.
 *
 * Identified by the `water:` token `render/water.ts` puts in the key with
 * `tagProgramCacheKey`. The DEFINES cannot do it — three writes
 * `customProgramCacheKey` into the key too, and for these materials that is a
 * chain of tags rather than the shader text, so `FF2_WATER_TWO_SIDED` appears
 * in the key of a variant that does not have it. The fields are read
 * positionally instead, from `getProgramCacheKeyParameters`' own order:
 * `precision` first, then `outputColorSpace`, and `numPointLights` 33 later.
 */
const waterPrograms = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const cache = (
      globalThis as unknown as {
        __ff2: { render: { renderer: { info: { programs: { cacheKey: string }[] } } } }
      }
    ).__ff2.render.renderer.info.programs
    return cache
      .map((p) => p.cacheKey)
      .filter((k) => k.includes('water:'))
      .map((k) => {
        const t = k.split(',')
        const i = t.findIndex((x) => x === 'highp' || x === 'mediump' || x === 'lowp')
        // The head is the DEFINES, which three pushes before `precision`. Those
        // three say which sea this is: its two variant axes and whether it is a
        // `lod-fade` clone, which carries its own define and is therefore its
        // own program (DEV-184). Named here so a failure says WHICH variant
        // went unwarmed rather than only that one did.
        const head = t.slice(0, i)
        const tag = [
          head.includes('FF2_WATER_TWO_SIDED') ? 'twoSided' : 'above',
          head.includes('FF2_WATER_SHAFT') ? 'bore' : 'noBore',
          head.includes('FF2_LOD_FADE') ? 'fadeClone' : 'base',
          // DEV-583: the flat ultra mirror is a third axis.
          head.includes('FF2_WATER_MIRROR') ? 'mirror' : 'sky',
        ].join('/')
        return `${t[i + 1]}|pl${t[i + 33]}|${tag}`
      })
  })

const launchPhase = (page: Page): Promise<string> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __ff2: { launch: () => { phase: string } } }).__ff2.launch()
        .phase,
  )

/** Held, not tapped — every confirm is a level read once a frame. */
const hold = (page: Page, key: string): Promise<void> =>
  keysHold(page, key, { down: 200, settle: 0 })

/**
 * The tiers the sea is flown at: the stored default, and DEV-583's `ultra`,
 * under which an Anniversary sea carries the mirror's define and
 * `warmVariants` warms both of its states. The ride is under water with the
 * mirror's variant already in force, and the breach must not compile either.
 */
const QUALITY_ARMS = [
  { label: 'the default tier', param: '', mirror: false },
  { label: 'ultra, with the mirror', param: '&quality=ultra&adaptive=0', mirror: true },
] as const

test.describe('@gpu the sea is warmed with the binding it is drawn with — DEV-186', () => {
  test.setTimeout(420_000)

  for (const arm of QUALITY_ARMS) {
    test(`${MISSION} ${EDITION} · ${arm.label}: one colour space, and no compile in flight`, async ({
      page,
    }) => {
      const warmLine: string[] = []
      page.on('console', (m) => {
        if (m.text().includes('warm-up:')) warmLine.push(m.text())
      })
      await page.goto(
        `/?mission=${MISSION}&xr=off&title=0&menu=0&autopilot=1&edition=${EDITION}${arm.param}`,
      )
      await firstPress(page)
      await missionReady(page, 240_000)

      const warmed = await waterPrograms(page)
      console.info(`\nDEV-186: at terrain-ready: ${JSON.stringify(warmed)}`)
      expect(warmed.length, 'this environment has a sea and it was warmed').toBeGreaterThan(0)
      // DEV-583: the ultra arm's premise is that the mirror's variants exist
      // (Anniversary only; Classic never has the mirror).
      if (arm.mirror && MIRROR_ON) {
        expect(
          warmed.some((k) => k.endsWith('/mirror')),
          'under ultra the Anniversary sea was warmed with the mirror',
        ).toBe(true)
      } else {
        // And with the mirror off, nothing warms (or later compiles) a variant nobody draws.
        expect(warmed.filter((k) => k.endsWith('/mirror'))).toEqual([])
      }
      const spaces = [...new Set(warmed.map((k) => k.split('|')[0]))]
      expect(
        spaces,
        'the warm and the draw agree about what is bound, see the header',
      ).toHaveLength(1)

      await focusCanvas(page)
      await page.waitForTimeout(2_000)
      await hold(page, 'Enter')
      await expect
        .poll(() => launchPhase(page), { timeout: 90_000, intervals: [250] })
        .toBe('flying')
      const atRelease = await waterPrograms(page)
      await page.waitForTimeout(30_000)
      const after = await waterPrograms(page)
      console.info(
        `DEV-186: water programs at release ${atRelease.length} -> +30 s ${after.length}\n` +
          `  release: ${JSON.stringify(atRelease)}\n` +
          `  +30 s:   ${JSON.stringify(after)}\n` +
          `  ${warmLine.join('\n  ')}\n`,
      )
      expect(warmLine.length, 'the warm-up ran at world build').toBeGreaterThan(0)
      expect(after, 'no sea variant compiled in the air').toEqual(atRelease)
    })
  }
})
