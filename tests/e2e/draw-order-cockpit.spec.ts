/**
 * tests/e2e/draw-order-cockpit.spec.ts — DEV-246. Where the VEHICLE is in the
 * submission sequence, per mission, and that the pin holds in a real frame.
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/draw-order-cockpit.spec.ts --workers 1
 *
 * ── The question, and the answer that was already half true ─────────────
 *
 * Matt: *"if ordering matters, would it make sense to draw the cockpit before
 * the environment so the pixels it blocks aren't drawn?"* The principle is
 * DEV-238's and it is right. What this spec found before anything moved is
 * that the vehicle was already mostly early — and that **nobody chose that**.
 * three sorts opaques `groupOrder → renderOrder → material.id →
 * materialVariant → z`, so with every `renderOrder` at 0 the sequence is the
 * order two materials happened to be CONSTRUCTED in, and on the HoverJet that
 * split the group in two: the hull at index 5, the cockpit INTERIOR at 323.
 *
 * ── It takes SEQUENCES and it takes no clocks ────────────────────────────
 *
 * `docs/testing/perf-protocol.md` §3a, and `draw-order.spec.ts`'s header makes
 * the argument in full: the sequence three hands the driver is the same
 * sequence on a busy box and an idle one. The milliseconds are a row in
 * `docs/DEVIATIONS.md` marked TO BE TAKEN.
 *
 * ── But a sequence IS a function of the TIER, and every table says which ─
 *
 * *"It does not care about the clock"* is true and *"it does not care about
 * the machine"* is not, and the difference is two lines of `src/`:
 * `game/terrain/detail-ring.ts:56` returns null at `low`, and
 * `render/shadows.ts:502` turns the shadow pass off at `low`. So a tier drop
 * removes a whole pass and a ring of chunks, every index after them moves, and
 * a table quoted without its tier is a table about a build the reader cannot
 * identify. `render/quality.ts` drops a tier when the CPU is starved — on a box
 * with a second session on it that is not a mismeasured build but a different
 * one (CLAUDE.md, perf-protocol §3a-quater). So `?adaptive=0&quality=high` is
 * pinned here, the live tier is printed above every table, and the last test
 * in this file shoots the same mission at `low` and says what moves.
 *
 * ── Three missions, on purpose ───────────────────────────────────────────
 *
 * `int_01_hoverJet` is the RELEASE mission and the one that has to be right.
 * `int_02_hoverJet` is the worst on GPU p95 and is alpine rather than simonet,
 * so a claim that held on one island is tested on another (CLAUDE.md's
 * agreement lesson). `adv_02_jumpSeat` is the CONTROL: its whole group was
 * already ahead of everything expensive, so the coordinator's A/B there should
 * read zero and a saving would be drift. A row that only ever measured a
 * mission the switch changes could not tell a real saving from one.
 *
 * **The control's first draft said the arm was a NO-OP there and that was
 * wrong.** It came from comparing two separate LOADS, both of which showed the
 * seat first; an A/B inside one page showed a single ring-stud draw crossing
 * from in front of the seat to behind it — and whether it was in front at all
 * varied load to load, because the stud material's id against the seat art's
 * depends on which asset promise resolved first. DEV-238's finding at its
 * sharpest: the old order was not merely unchosen, on this mission it was not
 * the same twice. The test now asserts what survives, and its own comment
 * carries the correction.
 *
 * `?view=cam` and a flat page are enough: the order does not depend on stereo,
 * and three sorts the render list once per `render()` whatever camera is in it.
 */

import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { flyToFreeze } from './fixtures/freeze'
import { knownRed } from './fixtures/known-red'
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
}

interface VehicleMesh {
  readonly path: string
  readonly name: string
  readonly material: string
  readonly materialId: number
  readonly renderOrder: number
  readonly transparent: boolean
  readonly depthWrite: boolean
  readonly depthTest: boolean
  /** `material.colorWrite` — false for DEV-305's shadow-only hull. */
  readonly colorWrite: boolean
  readonly triangles: number
  /** Visible WITH its ancestors — a mesh under a hidden group is not drawn. */
  readonly drawn: boolean
}

interface OrderReport {
  readonly which: string
  readonly moved: number
  readonly seen: number
  readonly skipped: number
  readonly on: boolean
}

const MISSIONS = [
  {
    id: 'int_01_hoverJet',
    vehicle: 'hoverjet',
    why: 'the RELEASE mission — simonet, HoverJet',
  },
  {
    id: 'adv_02_jumpSeat',
    vehicle: 'jumpseat',
    why: 'the CONTROL — simonet, JumpSeat, already ahead of everything expensive',
  },
  {
    id: 'int_02_hoverJet',
    vehicle: 'hoverjet',
    why: 'the worst on GPU p95 — alpine, HoverJet, and alpine has no ocean',
  },
] as const

const capture = (page: Page, frames = 1): Promise<DrawFrameReport[]> =>
  page.evaluate(async (n) => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    return (await w.__ff2?.drawOrder?.(n)) ?? []
  }, frames) as Promise<DrawFrameReport[]>

/**
 * The live tier, so no table in this file is quoted without the build it came
 * from.
 *
 * Off `__ff2.render.quality.report` and NOT off `__ff2perf.quality()`, which
 * would have been the obvious reach: the whole perf surface is built only
 * under `?perf=1` (`app.ts`'s `PERF_HUD ? createPerfSurface(...) : null`), and
 * `?perf=1` adds the GPU timer, the overlay and the perf PLATE — a group in
 * the very submission sequence this spec prints. An instrument that changes
 * the thing it measures is not one. The first run of this file read
 * `__ff2perf` and got `"unknown"` on all five tests, which is the honest
 * failure and the reason this note exists.
 *
 * `scale` is `ADAPTIVE_STEPS[stepIndex]`, so a controller that stepped shows
 * up here even though the adaptive SETTING itself is only readable through
 * the surface `?perf=1` builds.
 */
const tierOf = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    const q = w.__ff2?.render.quality.report
    return q ? `${q.quality} · scale ${q.scale}` : 'unknown'
  })

const setSwitch = (page: Page, on: boolean): Promise<OrderReport | null> =>
  page.evaluate((o) => {
    const g = globalThis as unknown as Ff2GlobalMaybe
    return g.__ff2?.drawOrderSwitch?.('cockpit', o as boolean) ?? null
  }, on) as Promise<OrderReport | null>

/**
 * Every drawable under the live vehicle group, with the material state three's
 * two render lists are split by.
 *
 * Read off `__ff2.flight().object` rather than off the capture's `samples`,
 * which is capped at 40 rows and cannot see a vehicle run at index 323. And
 * `drawn` composes the ancestors' `visible`, because
 * `WebGLRenderer.projectObject` returns on the first invisible node — the
 * exterior hull's own flag is true while `ship_third_person` is hidden, and a
 * row that read the mesh alone would report a draw the frame never makes.
 */
const vehicleMeshes = (page: Page): Promise<VehicleMesh[] | null> =>
  page.evaluate(() => {
    interface Obj3 {
      name: string
      type: string
      visible: boolean
      renderOrder: number
      parent: Obj3 | null
      children: Obj3[]
      isMesh?: boolean
      isBatchedMesh?: boolean
      material?: unknown
      geometry?: {
        index: { count: number } | null
        getAttribute: (n: string) => { count: number } | undefined
      }
    }
    const w = globalThis as unknown as Ff2GlobalMaybe
    const root = w.__ff2?.flight?.()?.object
    if (!root) return null
    const out: VehicleMesh[] = []
    const path = (o: Obj3): string => {
      const parts: string[] = []
      let n: Obj3 | null = o
      while (n && n !== root) {
        parts.unshift(n.name || n.type)
        n = n.parent
      }
      return parts.join('/')
    }
    const walk = (o: Obj3, drawn: boolean): void => {
      const here = drawn && o.visible
      if (o.isMesh === true || o.isBatchedMesh === true) {
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        const g = o.geometry
        const idx = g?.index
        const pos = g?.getAttribute('position')
        const total = idx ? idx.count : (pos?.count ?? 0)
        for (const raw of mats) {
          const m = raw as {
            id?: number
            name?: string
            type?: string
            transparent?: boolean
            depthWrite?: boolean
            depthTest?: boolean
            colorWrite?: boolean
          } | null
          if (!m) continue
          out.push({
            path: path(o),
            name: o.name || o.type,
            material: m.name || m.type || '?',
            materialId: m.id ?? -1,
            renderOrder: o.renderOrder,
            transparent: m.transparent === true,
            depthWrite: m.depthWrite !== false,
            depthTest: m.depthTest !== false,
            colorWrite: m.colorWrite !== false,
            triangles: Math.floor(total / 3),
            drawn: here,
          })
        }
      }
      for (const c of o.children) walk(c, here)
    }
    walk(root, true)
    return out
  }) as Promise<VehicleMesh[] | null>

const colour = (frame: DrawFrameReport): DrawRun[] => frame.runs.filter((r) => r.pass === 'color')

/** Where a group's FIRST colour run starts, or -1. */
const firstAt = (frame: DrawFrameReport, group: string): number =>
  colour(frame).find((r) => r.group === group || r.group.startsWith(`${group}/`))?.from ?? -1

/** The last call index of a group's LAST colour run, or -1. */
const lastAt = (frame: DrawFrameReport, group: string): number => {
  const runs = colour(frame).filter((r) => r.group === group || r.group.startsWith(`${group}/`))
  return runs.length === 0 ? -1 : Math.max(...runs.map((r) => r.from + r.calls - 1))
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

test.describe('@gpu draw order — the vehicle', () => {
  test.setTimeout(600_000)

  for (const mission of MISSIONS) {
    test(`the vehicle is submitted before the world on ${mission.id}`, async ({ page }) => {
      knownRed('KR-18', mission.vehicle === 'hoverjet')
      await flyToFreeze(page, {
        mission: mission.id,
        edition: 'anniversary',
        snapAt: 20,
        params: { view: 'cam', adaptive: '0', quality: 'high' },
      })

      const frames = await capture(page, 3)
      expect(frames.length, 'the recorder saw no frames — is the loop running?').toBeGreaterThan(0)
      const frame = frames[frames.length - 1] as DrawFrameReport
      const vehicle = mission.vehicle

      const tier = await tierOf(page)
      expect(
        tier,
        `the tier is "${tier}" and the table below would be a table about that build rather ` +
          'than about the shipped one — ?quality=high&adaptive=0 did not reach the runtime, ' +
          'or the controller dropped a step',
      ).toBe('high · scale 1')

      console.info(`\n  ${mission.id} — ${mission.why}`)
      console.info(`  tier ${tier}`)
      console.info(`  ${frame.calls} submissions this frame (shadow pass included)`)
      console.info(`  colour pass, in order:\n${table(frame)}`)

      const runs = colour(frame).filter((r) => r.group === vehicle)
      console.info(
        `\n  ${vehicle}: ${runs.length} run(s) — ${runs
          .map((r) => `${r.from} (${r.calls} calls, ${r.triangles} tris, order ${r.renderOrder})`)
          .join(' · ')}`,
      )

      const meshes = await vehicleMeshes(page)
      expect(meshes, 'no live flight object — __ff2.flight() is null').not.toBeNull()
      const rows = (meshes ?? []).filter((m) => m.drawn)
      console.info(`\n  ${vehicle} drawables in the frame, ${rows.length}:`)
      for (const m of rows) {
        console.info(
          `    ${m.path.padEnd(58)} ${m.material.padEnd(20)} id ${String(m.materialId).padStart(4)}` +
            `  order ${String(m.renderOrder).padStart(5)}` +
            `  ${m.transparent ? 'TRANSPARENT' : 'opaque     '}` +
            `  dw ${m.depthWrite ? 'on ' : 'off'}  dt ${m.depthTest ? 'on ' : 'off'}` +
            `  ${String(m.triangles).padStart(6)} tris`,
        )
      }
      const opaque = rows.filter((m) => !m.transparent)
      const clear = rows.filter((m) => m.transparent)
      console.info(
        `  opaque ${opaque.length} (${opaque.reduce((a, m) => a + m.triangles, 0)} tris) · ` +
          `transparent ${clear.length} (${clear.reduce((a, m) => a + m.triangles, 0)} tris)`,
      )

      // ── 1. Every OPAQUE vehicle draw is before the world ───────────────
      //
      // A relationship over the runs, not an index: the indices are a fact
      // about one mission on one day, and the claim is what a reader of the
      // table has to be able to trust about it. The comparison is against the
      // first terrain call, because the terrain is the thing the near field is
      // supposed to be rejecting — and the sea (order 1) and the dome (2) are
      // after the terrain by DEV-241, so clearing the terrain clears them.
      const vehicleEnd = lastAt(frame, vehicle)
      const terrainStart = firstAt(frame, 'world-terrain')
      expect(vehicleEnd, `no ${vehicle} in the colour pass`).toBeGreaterThanOrEqual(0)
      expect(terrainStart, 'no terrain in the frame').toBeGreaterThanOrEqual(0)
      expect(
        vehicleEnd,
        `a ${vehicle} draw is still submitted after the terrain starts — DEV-246 draws the ` +
          'vehicle first, and the cockpit interior was the half that used to land late',
      ).toBeLessThan(terrainStart)

      // ── 2. And it is ONE run, which is the fact that used to be false ──
      //
      // Before DEV-246 the HoverJet was two runs 318 submissions apart because
      // `material.id` decided it. Asserted as a count rather than as a
      // position: two runs at 3 and 5 would still satisfy (1) and would mean
      // the accident had come back in a smaller form.
      expect(
        runs.length,
        `${vehicle} is submitted as ${runs.length} separate runs — the group is being split ` +
          'by something the pin does not cover',
      ).toBe(1)

      // ── 3. The vehicle's own draws divide the way the switch says ──────
      //
      // Every opaque one writes depth and depth-tests, which is the condition
      // that makes it safe to draw before the world (`render/draw-order.ts`);
      // every transparent one is in three's other list and is after every
      // opaque whatever its renderOrder, so the HUD and the plates cannot be
      // dragged into the pin.
      for (const m of opaque) {
        // A draw that writes NEITHER colour nor depth puts nothing in either
        // buffer, so drawing it early cannot hide or break anything. It is
        // DEV-305's hull from the seat: kept in the draw only so it casts, with
        // `colorWrite` and `depthWrite` off. This test predates that row and
        // read it as an unsafe early draw.
        const writesNothing = !m.colorWrite && !m.depthWrite
        if (!writesNothing) {
          expect(m.depthWrite, `${m.path} is opaque, pinned early, and writes no depth`).toBe(true)
          expect(m.depthTest, `${m.path} is opaque, pinned early, and does not depth-test`).toBe(
            true,
          )
        }
        expect(m.renderOrder, `${m.path} is opaque and was not pinned`).toBeLessThan(0)
      }
      for (const m of clear) {
        expect(
          m.renderOrder,
          `${m.path} is transparent and was pinned early — it belongs in the UI stack`,
        ).toBeGreaterThanOrEqual(0)
      }

      // ── 4. The order is stable across frames on a frozen sim ───────────
      //
      // The group SEQUENCE, not the counts: `?snap=` freezes the sim and not
      // the terrain streamer, so a chunk arriving moves a count without moving
      // an order. `draw-order.spec.ts` makes the same distinction.
      const signature = (f: DrawFrameReport): string =>
        colour(f)
          .map((r) => r.group)
          .join('|')
      expect(
        [...new Set(frames.map(signature))],
        'the submission ORDER moved between frames on a FROZEN sim',
      ).toHaveLength(1)
    })
  }

  test('the A/B arm puts the HoverJet’s cabin back after the island, and back again', async ({
    page,
  }) => {
    // The arm's RESTORE is the thing that has to be proved, not the arm: a
    // sweep that could not put the default back would leave the page measuring
    // an old build for the rest of the session (DEV-241's inversion, here too).
    await flyToFreeze(page, {
      mission: 'int_01_hoverJet',
      edition: 'anniversary',
      snapAt: 20,
      params: { view: 'cam', adaptive: '0', quality: 'high' },
    })

    const shipped = (await capture(page, 1))[0] as DrawFrameReport
    expect(
      lastAt(shipped, 'hoverjet'),
      'the SHIPPED frame does not draw the whole vehicle before the terrain — DEV-246 did not ' +
        'reach it',
    ).toBeLessThan(firstAt(shipped, 'world-terrain'))

    const off = await setSwitch(page, false)
    expect(off, 'the page exposes no __ff2.drawOrderSwitch("cockpit")').not.toBeNull()
    expect(
      off?.seen,
      'ARM DID NOT FIRE: the cockpit switch owned no mesh. A switch that reached nothing ' +
        'reads as a change that costs nothing, which is not a result.',
    ).toBeGreaterThan(0)
    expect(off?.on).toBe(false)
    expect(off?.moved, 'the OFF arm moved no mesh, so it was already off').toBeGreaterThan(0)
    console.info(
      `\n  cockpit OFF — moved ${off?.moved} of ${off?.seen} owned, ${off?.skipped} skipped`,
    )

    const during = (await capture(page, 1))[0] as DrawFrameReport
    console.info(`  cockpit LATE (the A/B arm) — colour pass:\n${table(during)}`)

    // The arm really is the pre-DEV-246 frame: the cabin is back among the
    // island, which is what `material.id` decides when nothing else does.
    // Asserted as a relationship over the runs, not against a literal.
    expect(
      lastAt(during, 'hoverjet'),
      'the OFF arm left the whole vehicle before the terrain — it is not the pre-DEV-246 frame',
    ).toBeGreaterThan(firstAt(during, 'world-terrain'))

    // Nothing was lost. A reorder that dropped a draw would also look like a
    // faster frame, which is the most expensive kind of wrong here.
    expect(during.calls, 'the arm changed how many draws the frame makes').toBe(shipped.calls)

    const back = await setSwitch(page, true)
    expect(back?.on).toBe(true)
    const after = (await capture(page, 1))[0] as DrawFrameReport
    const sig = (f: DrawFrameReport): string =>
      colour(f)
        .map((r) => `${r.group}:${r.calls}:${r.renderOrder}`)
        .join('|')
    expect(sig(after), 'the cockpit arm did not restore the order it found').toBe(sig(shipped))
  })

  test('the JumpSeat control: the arm moves nothing PAST ANYTHING THAT COSTS', async ({ page }) => {
    // ── This test said NO-OP and the first run of it proved that wrong ───
    //
    // The claim was *"`adv_02_jumpSeat` was already the head of the colour
    // pass, so the pin cannot move the sequence there"*, and it came from
    // comparing two separate LOADS — the pre-change probe read
    // `jumpseat | turn-indicators | rings | chunks | …` and the post-change
    // one read `jumpseat | rings | turn-indicators | chunks | …`, both with
    // the seat first. An A/B inside ONE page said otherwise at once:
    //
    //     shipped   jumpseat | rings | turn-indicators | chunks | …
    //     OFF arm   rings | jumpseat | turn-indicators | chunks | …
    //
    // One ring-stud draw used to precede the whole seat, and whether it did
    // was **not even reproducible across loads** — the stud material's id
    // against the seat art's depends on which asset promise resolved first.
    // That is DEV-238's finding at its sharpest: the pre-DEV-246 order was not
    // merely unchosen, on this mission it was not the same twice. A
    // cross-LOAD comparison could never have seen it, which is the agreement
    // lesson in a new place (CLAUDE.md): two explanations agreed everywhere
    // anyone had looked.
    //
    // So what is asserted is the claim that survives, and it is the one the
    // MEASUREMENT rests on: the arm moves the seat past a single 12-triangle
    // ring stud and past nothing that costs anything. The seat is before the
    // terrain in BOTH arms, so the coordinator's A/B on this mission should
    // read ~0 and a saving there would be drift.
    await flyToFreeze(page, {
      mission: 'adv_02_jumpSeat',
      edition: 'anniversary',
      snapAt: 20,
      params: { view: 'cam', adaptive: '0', quality: 'high' },
    })

    const shipped = (await capture(page, 1))[0] as DrawFrameReport
    const off = await setSwitch(page, false)
    expect(
      off?.seen,
      'ARM DID NOT FIRE: the cockpit switch owned no JumpSeat mesh',
    ).toBeGreaterThan(0)
    const during = (await capture(page, 1))[0] as DrawFrameReport
    const sig = (f: DrawFrameReport): string =>
      colour(f)
        .map((r) => r.group)
        .join('|')
    console.info(
      `\n  adv_02_jumpSeat — cockpit OFF moved ${off?.moved} of ${off?.seen}` +
        `\n    shipped  ${sig(shipped)}` +
        `\n    OFF arm  ${sig(during)}` +
        `\n    ${sig(during) === sig(shipped) ? 'IDENTICAL' : 'the arm moved the seat past a small early group'}`,
    )

    // The invariant, in both arms: the seat is ahead of the terrain either
    // way, so nothing expensive changes side. THAT is what makes this mission
    // a control for a millisecond.
    for (const [name, frame] of [
      ['shipped', shipped],
      ['OFF arm', during],
    ] as const) {
      expect(
        lastAt(frame, 'jumpseat'),
        `the seat is drawn after the terrain starts in the ${name} frame, so this mission is ` +
          'not the control the measurement plan treats it as',
      ).toBeLessThan(firstAt(frame, 'world-terrain'))
    }

    // And what the arm DOES move is bounded: everything that changed sides is
    // a group of a few dozen triangles. A count rather than a name, so the
    // day a real group lands in that gap this goes red instead of passing on
    // a list somebody forgot to update.
    const before = (f: DrawFrameReport): DrawRun[] =>
      colour(f).filter((r) => r.from < (firstAt(f, 'jumpseat') as number) && r.group !== 'jumpseat')
    const crossed = before(during)
    console.info(
      `    groups the arm let ahead of the seat: ${
        crossed.map((r) => `${r.group} (${r.calls} calls, ${r.triangles} tris)`).join(', ') ||
        'none'
      }`,
    )
    const crossedTriangles = crossed.reduce((a, r) => a + r.triangles, 0)
    expect(
      crossedTriangles,
      'the cockpit pin moved the seat ahead of something substantial on the mission that is ' +
        'supposed to be the zero-reading control — the A/B there would then be measuring a ' +
        'real reorder and could not be read as drift',
    ).toBeLessThan(1_000)

    await setSwitch(page, true)
  })

  test('a submission index is only meaningful beside its TIER', async ({ page }) => {
    // The question the tables above cannot answer about themselves, asked
    // rather than reasoned: is an index a fact about the build, or a fact
    // about the build AT THIS TIER?
    //
    // Two lines of `src/` say it is the second — `detail-ring.ts:56` returns
    // null at `low` and `shadows.ts:502` turns the shadow pass off at `low` —
    // and a grep is a mechanism rather than a measurement, so this loads the
    // same mission at `low` and prints both sequences. `render/quality.ts`
    // drops a tier on a starved CPU, so this is not a hypothetical: the tier a
    // table was taken at is a property of the MACHINE, and a reader quoting an
    // index has to be told which one.
    //
    // What is ASSERTED is only the INVARIANT, because the row's claim is
    // supposed to be true of every build and not of one tier: the vehicle is
    // one run and it is before the terrain. The sequence comparison is
    // PRINTED, because whether it happens to match is a fact about today's
    // tier definitions and asserting it would make this test red the day
    // somebody changes what `low` means — which is a change, not a bug.
    await flyToFreeze(page, {
      mission: 'int_01_hoverJet',
      edition: 'anniversary',
      snapAt: 20,
      params: { view: 'cam', adaptive: '0', quality: 'low' },
    })
    const tier = await tierOf(page)
    expect(tier.startsWith('low'), `?quality=low did not reach the runtime — tier is ${tier}`).toBe(
      true,
    )
    const frames = await capture(page, 3)
    const frame = frames[frames.length - 1] as DrawFrameReport
    console.info(`\n  int_01_hoverJet at tier ${tier}`)
    console.info(`  ${frame.calls} submissions this frame (shadow pass included)`)
    console.info(`  colour pass, in order:\n${table(frame)}`)

    const vehicleEnd = lastAt(frame, 'hoverjet')
    const terrainStart = firstAt(frame, 'world-terrain')
    expect(vehicleEnd, 'no hoverjet in the colour pass at low').toBeGreaterThanOrEqual(0)
    expect(
      vehicleEnd,
      'the vehicle is not drawn before the terrain at the low tier — the pin is a property ' +
        'of the renderOrder and must hold at every tier',
    ).toBeLessThan(terrainStart)
    expect(
      colour(frame).filter((r) => r.group === 'hoverjet').length,
      'the vehicle is split into more than one run at the low tier',
    ).toBe(1)
  })
})
