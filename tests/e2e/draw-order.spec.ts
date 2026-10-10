/**
 * tests/e2e/draw-order.spec.ts — DEV-238, inverted by DEV-241. The order the
 * world is actually submitted in, and whether the A/B arms take it back.
 *
 * **Both switches are the SHIPPED order now** (DEV-241): the sea after the
 * land, the dome last at the far plane. So the mission rows assert the
 * DEFAULT in a real frame, and the two switch tests assert that `false`
 * restores the pre-DEV-241 frame and `true` puts the default back — a sweep
 * that could not close its own bracket would leave the page measuring an old
 * build for the rest of the session.
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/draw-order.spec.ts --workers 1
 *
 * ── It takes SEQUENCES and it takes no clocks ────────────────────────────
 *
 * `docs/testing/perf-protocol.md` §3a: a fan-out and a GPU measurement cannot
 * share this box. What survives contention is counts, defines, cache keys and
 * ORDER — the same argument `chunk-batch.spec.ts`'s header makes, and order is
 * the purest case of it: the sequence three hands the driver is the same
 * sequence on a busy machine and an idle one. The milliseconds are a row in
 * `docs/DEVIATIONS.md` marked TO BE TAKEN.
 *
 * ── What the question is ─────────────────────────────────────────────────
 *
 * `VR-PERF-WAVE-3.md` §10.3 brackets every group from both directions and every
 * one diverges, so each cost is mostly **occlusion relationship**; and
 * PERF-JOURNEY §3 measured hiding the terrain as making the frame 0.52 ms
 * SLOWER, because the island occludes the sea. Both of those are statements
 * about draw ORDER, and nobody had ever looked at what the order IS.
 *
 * It is not what the intuition says. three's `painterSortStable` compares
 * `groupOrder -> renderOrder -> material.id -> materialVariant -> z`, so
 * `material.id` outranks depth and "opaques are drawn front to back" holds only
 * WITHIN one material. Across the island's chunk material and the sea's band
 * clones the order is decided by which was constructed first.
 * `tests/unit/draw-order.test.ts` reads that out of three's own build; this
 * spec reads what it produces in a real frame.
 *
 * ── Two missions, on purpose ─────────────────────────────────────────────
 *
 * `adv_02_jumpSeat` is §10.3's own mission — the cheapest in the game, and the
 * one every ocean number in this wave is quoted against. `int_02_hoverJet` is
 * the WORST on GPU p95 (§10.2) and is alpine rather than Simonet. A claim about
 * submission order taken on one environment is a claim about one environment;
 * CLAUDE.md's agreement lesson is the whole of why there are two here.
 *
 * `?view=cam` and a flat page are enough: the order does not depend on stereo,
 * and three sorts the render list once per `render()` whatever camera is in it.
 */

import { flyToFreeze } from './fixtures/freeze'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

interface DrawRun {
  readonly group: string
  readonly pass: 'shadow' | 'color'
  readonly calls: number
  readonly triangles: number
  readonly from: number
  readonly renderOrder: number | null
}

interface DrawFrameReport {
  readonly calls: number
  readonly runs: readonly DrawRun[]
  readonly samples: readonly {
    readonly group: string
    readonly name: string
    readonly material: string
    readonly materialId: number
    readonly renderOrder: number
    readonly depthWrite: boolean
    readonly depthTest: boolean
    readonly transparent: boolean
  }[]
}

/**
 * ── `hasOcean` is a FINDING, not a parameter ─────────────────────────────
 *
 * Only `simonet` and `kauai` carry a water terrain — `game/terrain/load-terrain
 * .ts`'s `ocean: names.includes('ocean') ? … : null`, and the generated
 * constants have `simonet.ocean` and `kauai.ocean` and nothing else. **Alpine
 * and desert have no ocean at all.**
 *
 * Which means the four worst missions on §10.2's table — `int_02_hoverJet` and
 * `rookie_01_hoverJet` (alpine), `adv_01_hoverJet` and `rookie_02_hoverJet`
 * (desert) — pay none of the ocean's 1.16–1.89 ms. The sea is a cost on the
 * RELEASE mission and on §10.3's own sweep mission, and not on the missions
 * that miss the budget by the most.
 *
 * So the alpine row here is a NEGATIVE CONTROL and is kept for that: it is the
 * case where the ordering claims and "this is really a fact about Simonet" give
 * different answers, which is the only kind of case that tests a rule
 * (CLAUDE.md, the agreement lesson).
 */
const MISSIONS = [
  {
    id: 'adv_02_jumpSeat',
    why: '§10.3’s own mission, the cheapest in the game — simonet, WITH an ocean',
    hasOcean: true,
  },
  {
    id: 'int_02_hoverJet',
    why: 'the worst on GPU p95 (§10.2) — alpine, and alpine has NO ocean',
    hasOcean: false,
  },
] as const

const capture = (page: Page, frames = 1): Promise<DrawFrameReport[]> =>
  page.evaluate(async (n) => {
    const w = globalThis as unknown as {
      __ff2?: { drawOrder?: (frames?: number) => Promise<DrawFrameReport[]> }
    }
    return (await w.__ff2?.drawOrder?.(n)) ?? []
  }, frames) as Promise<DrawFrameReport[]>

const setSwitch = (
  page: Page,
  which: 'ocean' | 'sky',
  on: boolean,
): Promise<{ moved: number; seen: number; on: boolean } | null> =>
  page.evaluate(
    ([w, o]) => {
      const g = globalThis as unknown as {
        __ff2?: {
          drawOrderSwitch?: (
            which: string,
            on?: boolean,
          ) => { moved: number; seen: number; on: boolean }
        }
      }
      return g.__ff2?.drawOrderSwitch?.(w as string, o as boolean) ?? null
    },
    [which, on] as const,
  )

/** The COLOUR pass's runs, which is what "draw order" means to a reader. */
const colour = (frame: DrawFrameReport): DrawRun[] => frame.runs.filter((r) => r.pass === 'color')

/** Where a group first appears in the colour pass, or -1. */
const firstAt = (frame: DrawFrameReport, prefix: string): number => {
  const run = colour(frame).find((r) => r.group === prefix || r.group.startsWith(`${prefix}/`))
  return run ? run.from : -1
}

const table = (frame: DrawFrameReport): string =>
  colour(frame)
    .map(
      (r) =>
        `    ${String(r.from).padStart(4)}  ${r.group.padEnd(28)} ` +
        `${String(r.calls).padStart(4)} calls  ${String(r.triangles).padStart(8)} tris  ` +
        `order ${r.renderOrder === null ? 'mixed' : r.renderOrder}`,
    )
    .join('\n')

test.describe('@gpu draw order', () => {
  test.setTimeout(600_000)

  for (const mission of MISSIONS) {
    test(`records the real submission sequence on ${mission.id}`, async ({ page }) => {
      await flyToFreeze(page, {
        mission: mission.id,
        edition: 'anniversary',
        snapAt: 20,
        params: { view: 'cam' },
      })

      const frames = await capture(page, 3)
      expect(frames.length, 'the recorder saw no frames — is the loop running?').toBeGreaterThan(0)
      const frame = frames[frames.length - 1] as DrawFrameReport

      console.info(`\n  ${mission.id} — ${mission.why}`)
      console.info(`  ${frame.calls} submissions this frame (shadow pass included)`)
      console.info(`  colour pass, in order:\n${table(frame)}`)
      const sea = frame.samples.filter((s) => s.group.startsWith('world-ocean'))[0]
      if (sea) {
        console.info(
          `  first ocean draw: ${sea.name} / ${sea.material} (material.id ${sea.materialId}), ` +
            `renderOrder ${sea.renderOrder}, depthWrite ${sea.depthWrite}, ` +
            `depthTest ${sea.depthTest}, transparent ${sea.transparent}`,
        )
      }

      // ── The three ASSERTIONS, all of them relationships ─────────────────
      //
      // The table above is the deliverable and it is printed rather than
      // asserted, because its exact contents are a fact about one mission on
      // one day. What is asserted is what a reader of that table has to be able
      // to trust about it.

      // 1. The sky goes LAST among the world's opaques, and the sea after the
      //    land — the two DEV-241 defaults, in the frame, on a real GPU.
      //
      //    Asserted against the other RUNS rather than against a renderOrder
      //    literal, and the difference is the point: the numbers 1 and 2 are
      //    this port's arbitrary choice and the submission sequence is what the
      //    driver sees. `tests/unit/draw-order.test.ts` holds the numbers; this
      //    holds what they produce.
      //
      //    The comparison is against every run BEFORE the transparent pass,
      //    because three keeps two lists and draws every opaque before every
      //    transparent whatever its `renderOrder` — so the HUD, the vignette,
      //    the gate spray and the comfort horizon are all after the dome by
      //    construction and are not evidence for or against it. The world's
      //    opaques are the ones this claim is about.
      const skyAt = firstAt(frame, 'sky-dome')
      expect(skyAt, 'the frame drew no sky at all').toBeGreaterThanOrEqual(0)
      const landEnd = Math.max(
        ...colour(frame)
          .filter((r) => r.group.startsWith('world-terrain'))
          .map((r) => r.from + r.calls - 1),
      )
      expect(
        skyAt,
        'the sky dome is still submitted before the land — DEV-241 draws it last',
      ).toBeGreaterThan(landEnd)
      if (mission.hasOcean) {
        const seaStart = firstAt(frame, 'world-ocean')
        const seaEnd = Math.max(
          ...colour(frame)
            .filter((r) => r.group.startsWith('world-ocean'))
            .map((r) => r.from + r.calls - 1),
        )
        expect(
          seaStart,
          'the sea is still submitted before some of the land — DEV-241 draws it after',
        ).toBeGreaterThan(landEnd)
        expect(skyAt, 'the sky dome is drawn before the sea').toBeGreaterThan(seaEnd)
      }
      // And the dome carries the pin's depth state, which is the half a
      // sequence cannot show: without `depthTest` back on, a dome submitted
      // last would paint over the whole world.
      const dome = frame.samples.find((r) => r.group === 'sky-dome')
      if (dome) {
        expect(dome.depthTest, 'the dome is drawn last with no depth test').toBe(true)
        expect(dome.depthWrite, 'the dome writes depth, which would z-fight').toBe(false)
      }

      // 2. The land is in the frame, and the sea is there exactly where the
      //    environment has one. A missing group reads as a system that costs
      //    nothing, which is rule 1 of the SOLO comment in
      //    `xr-vrto3d-trace.spec.ts` and the shape of three retractions — and
      //    the alpine row asserts the ABSENCE for the same reason, because an
      //    expectation of "there is always an ocean" would have been true on
      //    every mission anyone had looked at and false on four of thirteen.
      expect(firstAt(frame, 'world-terrain'), 'no terrain in the frame').toBeGreaterThanOrEqual(0)
      if (mission.hasOcean) {
        expect(
          firstAt(frame, 'world-ocean'),
          'no ocean in a frame on an environment that has one',
        ).toBeGreaterThanOrEqual(0)
      } else {
        expect(
          firstAt(frame, 'world-ocean'),
          `${mission.id}'s environment has no water terrain, so an ocean in the frame means ` +
            'this spec is measuring something it does not understand',
        ).toBe(-1)
      }

      // 3. The ORDER is stable across frames on a frozen sim. If it is not, the
      //    table above is a snapshot of something that moves and every
      //    conclusion drawn from it is about one frame.
      //
      //    The group SEQUENCE, not the call counts. `?snap=` freezes the sim,
      //    not the terrain streamer, and a chunk arriving or a LOD settling
      //    moves a count without moving an order — which is a fact about the
      //    world rather than about the instrument, and asserting it here would
      //    make this spec red for the wrong reason. The claim is the sequence.
      const signature = (f: DrawFrameReport): string =>
        colour(f)
          .map((r) => r.group)
          .join('|')
      const signatures = new Set(frames.map(signature))
      expect(
        [...signatures],
        'the submission ORDER moved between frames on a FROZEN sim',
      ).toHaveLength(1)
    })
  }

  test('the ocean-late A/B arm puts the sea back before the land, and back again', async ({
    page,
  }) => {
    // DEV-241 inverted this test with the default. `true` is now the shipped
    // frame and `false` is the ARM, so what has to be proved is the arm's
    // RESTORE: a sweep that could not put the default back would leave the page
    // measuring an old build for the rest of the session.
    await flyToFreeze(page, {
      mission: 'adv_02_jumpSeat',
      edition: 'anniversary',
      snapAt: 20,
      params: { view: 'cam' },
    })

    const shipped = (await capture(page, 1))[0] as DrawFrameReport
    const landEndOf = (f: DrawFrameReport): number =>
      Math.max(
        ...colour(f)
          .filter((r) => r.group.startsWith('world-terrain'))
          .map((r) => r.from + r.calls - 1),
      )
    expect(
      firstAt(shipped, 'world-ocean'),
      'the SHIPPED frame does not draw the sea after the land - DEV-241 did not reach it',
    ).toBeGreaterThan(landEndOf(shipped))

    const off = await setSwitch(page, 'ocean', false)
    expect(off, 'the page exposes no __ff2.drawOrderSwitch').not.toBeNull()
    expect(
      off?.seen,
      'ARM DID NOT FIRE: the ocean switch saw no meshes. A switch that reached nothing ' +
        'reads as a change that costs nothing, which is not a result.',
    ).toBeGreaterThan(0)
    expect(off?.on).toBe(false)
    expect(off?.moved, 'the OFF arm moved no mesh, so it was already off').toBeGreaterThan(0)

    const during = (await capture(page, 1))[0] as DrawFrameReport
    console.info(`\n  ocean EARLY (the A/B arm) - colour pass:\n${table(during)}`)

    // The arm really is the pre-DEV-241 frame: the sea is back among the land,
    // which is what `material.id` decides when nothing else does. Asserted as a
    // relationship over the runs rather than against a renderOrder literal,
    // because the literal is this file's own belief written twice.
    expect(
      firstAt(during, 'world-ocean'),
      'the OFF arm left the sea after the land - it is not the pre-DEV-241 frame',
    ).toBeLessThan(landEndOf(during))

    // Nothing was lost. A reorder that dropped a draw would also look like a
    // faster frame, which is the most expensive kind of wrong here.
    expect(during.calls, 'the arm changed how many draws the frame makes').toBe(shipped.calls)

    const back = await setSwitch(page, 'ocean', true)
    expect(back?.on).toBe(true)
    const after = (await capture(page, 1))[0] as DrawFrameReport
    const sig = (f: DrawFrameReport): string =>
      colour(f)
        .map((r) => `${r.group}:${r.calls}:${r.renderOrder}`)
        .join('|')
    expect(sig(after), 'the ocean arm did not restore the order it found').toBe(sig(shipped))
  })

  test('the sky-last A/B arm puts the dome back first, and back again', async ({ page }) => {
    await flyToFreeze(page, {
      mission: 'adv_02_jumpSeat',
      edition: 'anniversary',
      snapAt: 20,
      params: { view: 'cam' },
    })

    const shipped = (await capture(page, 1))[0] as DrawFrameReport
    const skyShipped = firstAt(shipped, 'sky-dome')
    expect(skyShipped, 'the frame drew no sky at all').toBeGreaterThanOrEqual(0)
    expect(
      skyShipped,
      'the SHIPPED frame draws the dome first - DEV-241 did not reach it',
    ).toBeGreaterThan(0)

    const off = await setSwitch(page, 'sky', false)
    expect(off?.seen, 'ARM DID NOT FIRE: the sky switch found no dome').toBeGreaterThan(0)
    // **The OFF arm is the one that compiles now**, and that is DEV-241
    // flipping DEV-238's note rather than deleting it: the far-plane pin is in
    // the shipped program and the warm-up builds it under the curtain, so
    // REMOVING the define is the key with no warmed variant - and there cannot
    // be one, because warming a program the game never draws with is what
    // DEV-177(b) measured as building the wrong one. Let frames pass.
    await page.waitForTimeout(1000)

    const during = (await capture(page, 1))[0] as DrawFrameReport
    console.info(`\n  sky FIRST (the A/B arm) - colour pass:\n${table(during)}`)
    const skyDuring = firstAt(during, 'sky-dome')
    expect(skyDuring, 'no sky under the arm').toBeGreaterThanOrEqual(0)
    for (const run of colour(during)) {
      if (run.group === 'sky-dome') continue
      expect(
        run.from,
        `${run.group} was submitted before the dome under the OFF arm, which is the ` +
          'pre-DEV-241 frame and drew it first',
      ).toBeGreaterThan(skyDuring)
    }
    const domeOff = during.samples.find((r) => r.group === 'sky-dome')
    if (domeOff) {
      expect(domeOff.depthTest, 'the OFF arm left the depth test on').toBe(false)
    }
    expect(during.calls, 'the arm changed how many draws the frame makes').toBe(shipped.calls)

    await setSwitch(page, 'sky', true)
    await page.waitForTimeout(500)
    const after = (await capture(page, 1))[0] as DrawFrameReport
    expect(firstAt(after, 'sky-dome'), 'the sky arm did not put the dome back').toBe(skyShipped)
    const domeBack = after.samples.find((r) => r.group === 'sky-dome')
    if (domeBack) expect(domeBack.depthTest, 'the depth test did not come back').toBe(true)
  })
})
