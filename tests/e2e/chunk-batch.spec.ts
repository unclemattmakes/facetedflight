/**
 * tests/e2e/chunk-batch.spec.ts — DEV-193's spike, counted on a frozen frame.
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/chunk-batch.spec.ts --workers 1
 *
 * ── It takes COUNTS and it takes no clocks, on purpose ───────────────────
 *
 * `docs/testing/perf-protocol.md` §3a: a fan-out and a GPU measurement cannot
 * share this box — six agents on one RTX 5050 took the A/B drift column from
 * 0.01-0.19 ms to 6.37 and two conclusions had to be withdrawn. What survives
 * contention is `renderer.info.render.calls`, triangle counts, program counts
 * and cache keys. §11.11 adds a second reason: this rig's FIXED term steps
 * ~2 ms late in a run and stays, with no explanation yet, so even a quiet box
 * cannot currently produce a timing on demand.
 *
 * A draw count is not a clock. It is the same integer on a busy machine and an
 * idle one, which is why DEV-193's deliverable is a count and its timing half is
 * a row in `docs/DEVIATIONS.md` marked TO BE TAKEN.
 *
 * ── The two numbers, and why the SHADOW half needs both of them ──────────
 *
 * `renderer.info.render.calls` is the whole frame: the shadow pass and the
 * colour pass. `__ff2perf.census()` reads three's render list for the scene,
 * which is the COLOUR pass alone — `render-census.ts` draws the scene into a
 * small target and reads `renderer.renderLists.get(scene, 0)`, and the shadow
 * map keeps its own lists. So
 *
 *     shadow calls  =  info.render.calls  -  census.calls
 *
 * which is the same subtraction §11.9 used to get "the shadow pass is 1.26 ms
 * an eye and 64 draws" out of a `render.shadows` off row. Both halves are read
 * here, before and after the fold, so the chunk grid's share of each is a
 * difference within ONE load — never a cross-run pin (§3a-ter).
 *
 * ORDER MATTERS: `census()` renders five extra frames of its own, so the
 * `info` sampling has to come first or it reads the census's own draw.
 *
 * ── The bracket is an EQUALITY, which a millisecond could never be ───────
 *
 * Every arm in §11 is read against a baseline swept next to it because the
 * clock drifts. A count does not drift, so this spec asserts something
 * stronger: unfold and the frame goes back to **exactly** the integer it
 * started on. If it does not, the fold changed something it does not own and
 * every number below it is about that instead.
 *
 * ── What is asserted and what is only printed ────────────────────────────
 *
 * ASSERTED — mechanism, reproducible anywhere:
 *   * `WEBGL_multi_draw` is present. Without it three loops the sub-draws in JS
 *     (`WebGLRenderer.js:1303-1319`) and every one of them calls `info.update`,
 *     so the call count goes straight back to today's and the whole spike is
 *     answering a question about a different code path.
 *   * the fold REDUCED the frame's calls, and the `world-terrain/chunks` census
 *     row fell to the number of bands that row's meshes were folded into;
 *   * nothing was left behind (`skipped`), and the frame's triangle count did
 *     not move — a batch that dropped geometry would also drop draws. Asked of
 *     `renderer.info.render.triangles` and NOT of the census, which reports a
 *     `BatchedMesh`'s whole reserved buffer rather than what it submitted;
 *   * the unfold restores the exact starting count;
 *   * **the PIXELS do not move**, as an A-B-A-B bracket: the difference ACROSS
 *     the fold against the difference WITHIN one state over the same gap. That
 *     is the half a draw count cannot see — the base material carries a stack of
 *     `onBeforeCompile` patches whose install order matters, and a batch that
 *     lost one would draw the same number of calls and a different island.
 *     `?snap=` freezes the SIM and not the wall clock, so `clouds`,
 *     `particle-fx` and `motes` keep moving and a single control pair taken
 *     adjacent measures a smaller gap than the arm does: that first version read
 *     control 0.70 against arm 2.35 and the ratio was a fact about the GAP.
 *
 * PRINTED — the deliverable:
 *   * colour, shadow and total calls before and after, and the band table.
 *
 * `@gpu`, hydrated assets, a real compiler, headed. Run by hand, like
 * `census-baseline.spec.ts` and `ride-hitch.spec.ts`; `pnpm e2e` never runs in
 * CI.
 */

import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { flyToFreeze, frozenSim, missionTickOf } from './fixtures/freeze'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

const MISSION = process.env.CHUNK_BATCH_MISSION ?? 'int_01_hoverJet'
const EDITION = process.env.CHUNK_BATCH_EDITION ?? 'anniversary'
const SNAP_AT = Number(process.env.CHUNK_BATCH_AT ?? '20')

/** Frames to sample `renderer.info` over. A count should not move across them. */
const FRAMES = 30

interface CensusRow {
  readonly group: string
  readonly calls: number
  readonly triangles: number
}

interface Reading {
  /** `renderer.info.render.calls` — the WHOLE frame, shadow pass included. */
  readonly frameCalls: number
  readonly frameTriangles: number
  /** How many distinct values `frameCalls` took over the sample. 1 is a still frame. */
  readonly frameCallsSpread: number
  /** The COLOUR pass alone, from three's render list. */
  readonly colourCalls: number
  readonly colourTriangles: number
  readonly programs: number
  readonly rows: readonly CensusRow[]
}

const shadowCalls = (r: Reading): number => r.frameCalls - r.colourCalls

const rowOf = (r: Reading, group: string): CensusRow | undefined =>
  r.rows.find((x) => x.group === group)

/** The chunk grid's own census row, whatever environment it is suffixed with. */
const chunkRow = (r: Reading): CensusRow | undefined => rowOf(r, 'world-terrain/chunks')

/** Every row whose calls are the batches this spike made. */
const batchRows = (r: Reading): readonly CensusRow[] =>
  r.rows.filter((x) => x.group.startsWith('world-terrain/chunks'))

/**
 * Sample `renderer.info` over `FRAMES` frames, then take the census.
 *
 * The MODE, not the median: these are integers that should not move on a frozen
 * frame, and the count of distinct values is reported so a reader can see
 * whether that held. A median hides a frame that drew something else.
 */
const read = async (page: Page): Promise<Reading> => {
  const info = await page.evaluate(async (n) => {
    const w = globalThis as unknown as {
      __ff2: { render: { renderer: { info: { render: { calls: number; triangles: number } } } } }
    }
    const calls: number[] = []
    const tris: number[] = []
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      calls.push(w.__ff2.render.renderer.info.render.calls)
      tris.push(w.__ff2.render.renderer.info.render.triangles)
    }
    return { calls, tris }
  }, FRAMES)
  const mode = (xs: readonly number[]): number => {
    const counts = new Map<number, number>()
    for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
  }
  // AFTER the sampling: `census()` draws five frames of its own and would be
  // the last thing `info.render` had seen.
  const c = await page.evaluate(() =>
    (
      globalThis as unknown as {
        __ff2perf: {
          census: () => {
            calls: number
            triangles: number
            programs: number
            rows: readonly CensusRow[]
          }
        }
      }
    ).__ff2perf.census(),
  )
  return {
    frameCalls: mode(info.calls),
    frameTriangles: mode(info.tris),
    frameCallsSpread: new Set(info.calls).size,
    colourCalls: c.calls,
    colourTriangles: c.triangles,
    programs: c.programs,
    rows: c.rows,
  }
}

interface Band {
  readonly key: string
  readonly vertexCount: number
  readonly triangles: number
  readonly members: number
  readonly slots: number
  readonly bytes: number
  readonly castShadow: boolean
  readonly receiveShadow: boolean
}

interface Plan {
  readonly on: boolean
  readonly terrains: readonly {
    terrain: string
    folded: number
    skipped: number
    bytes: number
    bands: readonly Band[]
  }[]
}

const setBatch = (page: Page, on: boolean): Promise<Plan> =>
  page.evaluate(
    (v) =>
      (globalThis as unknown as { __ff2: { chunkBatch: (on: boolean) => Plan } }).__ff2.chunkBatch(
        v,
      ),
    on,
  )

/**
 * Is `WEBGL_multi_draw` there?
 *
 * The one capability the whole design rests on. Asked of the live context, not
 * assumed from the platform — a software fallback, a driver flag or a headless
 * run are all ways to lose it, and losing it silently turns the batch back into
 * 146 draws in a JS loop with a `_gl_DrawID` uniform set between each.
 */
const multiDraw = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const gl = (
      globalThis as unknown as {
        __ff2: { render: { renderer: { getContext: () => WebGL2RenderingContext } } }
      }
    ).__ff2.render.renderer.getContext()
    return gl.getSupportedExtensions()?.includes('WEBGL_multi_draw') ?? false
  })

const k = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${(n / 1e3).toFixed(0)}k`

/**
 * Mean absolute difference between two screenshots, per sample, 0..255.
 *
 * **DECODED, and the first version of this was not.** Comparing the PNG BYTES
 * looks cheaper and is worthless: PNG is deflate-compressed, so any difference
 * in content changes the compressed LENGTH, and a length guard that returns
 * `Infinity` made both the control pair and the arm infinite — an assertion of
 * the form `Infinity <= max(3 * Infinity, 0.5)` that passes for every input.
 * A test that cannot fail is the thing CLAUDE.md's "verify before you claim"
 * section is about, and this one shipped green on its first run.
 *
 * `tools/terrain/png.mjs` is the repo's own decoder — the one `lod-pop.spec.ts`
 * and `terrain-screenshot.spec.ts` already photograph frames through.
 */
const pixelDiff = (a: Buffer, b: Buffer): number => {
  const x = decodePngBuffer(a, 'a')
  const y = decodePngBuffer(b, 'b')
  if (x.width !== y.width || x.height !== y.height || x.channels !== y.channels) {
    return Number.POSITIVE_INFINITY
  }
  let sum = 0
  for (let i = 0; i < x.data.length; i++) {
    sum += Math.abs((x.data[i] as number) - (y.data[i] as number))
  }
  return sum / x.data.length
}

const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`

const summary = (label: string, r: Reading): string =>
  `  ${label.padEnd(10)} colour ${String(r.colourCalls).padStart(4)} · shadow ${String(
    shadowCalls(r),
  ).padStart(4)} · TOTAL ${String(r.frameCalls).padStart(4)} · ${k(r.frameTriangles)} tris · ${
    r.programs
  } programs${r.frameCallsSpread === 1 ? '' : `  (frame calls took ${r.frameCallsSpread} values)`}`

const rowTable = (r: Reading): string =>
  r.rows
    .filter((x) => x.calls > 0)
    .map(
      (x) =>
        `      ${x.group.padEnd(34)} ${String(x.calls).padStart(4)} calls ${k(x.triangles).padStart(8)} tris`,
    )
    .join('\n')

const planTable = (plan: Plan): string =>
  plan.terrains
    .flatMap((t) => [
      `    ${t.terrain}: folded ${t.folded}, refused ${t.skipped}, reserved ${mb(t.bytes)}`,
      ...t.bands.map(
        (b) =>
          `      ${b.key.padEnd(24)} ${String(b.members).padStart(4)} chunks × ${String(
            b.vertexCount,
          ).padStart(5)} verts = ${k(b.triangles).padStart(7)} tris  ${
            b.castShadow ? 'CASTS' : '     '
          }  ${mb(b.bytes)}`,
      ),
    ])
    .join('\n')

test.describe('@measure @gpu DEV-193: the chunk grid as one BatchedMesh per LOD band', () => {
  test.setTimeout(900_000)

  test(`${MISSION}/${EDITION}@${SNAP_AT}: what the draw count becomes`, async ({ page }) => {
    await flyToFreeze(page, {
      mission: MISSION,
      edition: EDITION,
      snapAt: SNAP_AT,
      params: { perf: '1' },
    })
    const sim = await frozenSim(page)

    // The capability first. Everything below is about a different code path
    // without it, so it is a hard failure rather than a printed caveat.
    expect(
      await multiDraw(page),
      'WEBGL_multi_draw is absent — three would loop the sub-draws in JS and ' +
        'the call count would not move. This spec is measuring nothing.',
    ).toBe(true)

    // ── the pixels, as an A-B-A-B bracket ─────────────────────────────────
    //
    // The pixels are the half of "what must keep working" that a count cannot
    // see. The terrain's base material carries a stack of `onBeforeCompile`
    // patches whose install order matters — Unity fog, `far-shadow.ts`'s
    // far-field sun term, the illustrative warp, the surface gloss,
    // `lod-fade.ts`'s gated `discard`, DEV-191's gates, DEV-192's point-light
    // scope — and a batch that lost any of them would draw the same NUMBER of
    // calls and a different island. The spike reuses the material OBJECT so none
    // of it can be lost; this is the assertion that says so rather than the
    // paragraph.
    //
    // **`?snap=` freezes the SIM and not the wall clock** (`boot/snap.ts` says
    // so), and `census-baseline.spec.ts` names the three groups that ride the
    // render clock: `clouds`, `particle-fx` and `motes`. So two shots of the
    // same configuration are never identical, and how unidentical they are
    // depends on the GAP between them.
    //
    // The first version of this took one adjacent control pair and compared it
    // against an arm three seconds later. It came back control 0.70, arm 2.35 —
    // and that ratio is a fact about the gap, not about the fold. Same trap as
    // §11's fixed-term drift, one layer down.
    //
    // So: A-B-A-B, each shot separated by the same work, and the comparison is
    // WITHIN-STATE against ACROSS-STATE. If |A1-A2| and |B1-B2| are the same
    // size as |A1-B1| and |A2-B2|, the difference is the clock and the fold
    // moved nothing. That is the bracket §11 uses for milliseconds, applied to
    // pixels.
    const shoot = (): Promise<Buffer> => page.locator('#viewport').screenshot()
    const before = await read(page)
    const a1 = await shoot()
    const plan = await setBatch(page, true)
    const b1 = await shoot()
    const after = await read(page)
    const restored = await setBatch(page, false)
    const a2 = await shoot()
    const back = await read(page)
    await setBatch(page, true)
    const b2 = await shoot()
    await setBatch(page, false)

    const beforeChunks = chunkRow(before)
    const afterChunks = batchRows(after)
    const bands = plan.terrains.reduce((n, t) => n + t.bands.length, 0)
    const folded = plan.terrains.reduce((n, t) => n + t.folded, 0)
    const refused = plan.terrains.reduce((n, t) => n + t.skipped, 0)
    // WITHIN a state: the render clock alone, over the same gap the arms span.
    const withinOff = pixelDiff(a1, a2)
    const withinOn = pixelDiff(b1, b2)
    // ACROSS states, each pair adjacent so neither carries an extra fold's gap.
    const acrossEarly = pixelDiff(a1, b1)
    const acrossLate = pixelDiff(a2, b2)
    const within = Math.max(withinOff, withinOn)
    const across = Math.max(acrossEarly, acrossLate)

    console.info(
      [
        '',
        `DEV-193 — ${MISSION}/${EDITION}, frozen at ${SNAP_AT} s` +
          (sim ? ` (mission tick ${missionTickOf(sim)}, elapsed ${sim.elapsed.toFixed(3)} s)` : ''),
        '',
        '  THE FRAME',
        summary('before', before),
        summary('batched', after),
        summary('restored', back),
        '',
        '  PIXELS — mean absolute difference per decoded sample, 0..255',
        `    WITHIN a state (the render clock alone):  off/off ${withinOff.toFixed(3)} · ` +
          `on/on ${withinOn.toFixed(3)}`,
        `    ACROSS states (the fold, if any):         early ${acrossEarly.toFixed(3)} · ` +
          `late ${acrossLate.toFixed(3)}`,
        '',
        `  the fold: ${bands} bands over ${plan.terrains.length} terrains, ` +
          `${folded} chunks folded, ${refused} refused`,
        planTable(plan),
        '',
        '  ROWS — before',
        rowTable(before),
        '  ROWS — batched',
        rowTable(after),
        '',
      ].join('\n'),
    )

    // ── the assertions, and every one of them is a mechanism ──────────────

    expect(restored.on, 'chunkBatch(false) did not unfold').toBe(false)
    expect(folded, 'nothing was folded — is the terrain there?').toBeGreaterThan(0)
    expect(
      refused,
      'chunks were refused. On a frozen frame nothing should be mid-fade, so this is a shape ' +
        'this module does not recognise rather than the §9 constraint it is meant to catch.',
    ).toBe(0)

    // The census row for the chunks became the BATCHES, one call each.
    expect(beforeChunks, 'no world-terrain/chunks row before the fold').toBeDefined()
    const beforeCalls = (beforeChunks as CensusRow).calls
    const afterCalls = afterChunks.reduce((n, r) => n + r.calls, 0)
    expect(beforeCalls).toBeGreaterThan(bands)
    expect(
      afterCalls,
      `the chunk rows should draw at most one call per band (${bands}); they drew ${afterCalls}`,
    ).toBeLessThanOrEqual(bands)

    // ── geometry did not go missing, and the counter to ask is `info` ─────
    //
    // A batch that dropped a chunk would also drop a draw, so the call count
    // would look better for the wrong reason. But the CENSUS cannot answer it:
    // `render-census.ts`'s `itemTriangles` reads `geometry.attributes.position
    // .count` and a `BatchedMesh`'s geometry is the whole RESERVED buffer — so
    // the census reports every chunk in the batch while the pre-fold rows
    // reported only the ~146 that survived frustum culling. Two different
    // quantities with the same name.
    //
    // `renderer.info.render.triangles` is the right one: `renderMultiDraw` sums
    // the counts of the sub-draws it actually issued
    // (`WebGLBufferRenderer.js:36-42`), so it is what reached the GPU, and the
    // per-instance cull uses the same bounding sphere the mesh was culled by —
    // `setGeometryAt` clones `geometry.boundingSphere` and `chunkGeometry`
    // computes one. The two cull sets are therefore the same set, and the frame
    // should carry the same triangles either way.
    const triangleDrift = Math.abs(after.frameTriangles - before.frameTriangles)
    expect(
      triangleDrift / Math.max(1, before.frameTriangles),
      `the frame carried ${k(after.frameTriangles)} triangles batched against ` +
        `${k(before.frameTriangles)} before — a batch that drops geometry also drops draws`,
    ).toBeLessThan(0.01)

    // And nothing was left out of the fold itself.
    const planMembers = plan.terrains.reduce(
      (n, t) => n + t.bands.reduce((m, b) => m + b.members, 0),
      0,
    )
    expect(planMembers, 'the bands do not add up to what was folded').toBe(folded)

    // The whole frame, both passes.
    expect(after.frameCalls, 'the fold did not reduce the frame').toBeLessThan(before.frameCalls)
    expect(shadowCalls(after), 'the shadow pass did not shrink').toBeLessThan(shadowCalls(before))

    // The bracket, and it is an EQUALITY because a count does not drift.
    expect(
      back.frameCalls,
      'unfolding did not return the frame to the integer it started on — the fold moved ' +
        'something it does not own',
    ).toBe(before.frameCalls)
    expect(back.colourCalls).toBe(before.colourCalls)

    // ── and the pixels, against the control rather than against a taste ───
    //
    // The patch stack is the thing a draw count cannot see. If the batched
    // program had lost Unity's fog, or the far-field sun term, or the warp, the
    // island would be a different colour at the same call count.
    //
    // Judged against the CONTROL pair, not a number this file chose. If the
    // control is 0 the frame is deterministic and the arm must be 0 too; if the
    // control is not 0 the harness has noise of its own and the arm is allowed
    // the same. Three times the control plus a floor is the allowance, and the
    // floor exists so a control of exactly 0 does not make the assertion
    // infinitely strict about a PNG encoder.
    expect(
      across,
      `the frames differ ACROSS the fold by ${across.toFixed(3)} against ${within.toFixed(3)} ` +
        'WITHIN a state over the same gap — if the across figure is the larger, something in ' +
        "the material's onBeforeCompile stack did not reach the batched program",
    ).toBeLessThanOrEqual(Math.max(1.5 * within, 0.05))
  })
})
