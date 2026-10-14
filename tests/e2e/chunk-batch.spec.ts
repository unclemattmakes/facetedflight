/**
 * tests/e2e/chunk-batch.spec.ts: the land's LOD batches (DEV-193's spike, made
 * the shipped path by DEV-904), counted on a frozen frame and exercised while
 * the LODs move.
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/chunk-batch.spec.ts --workers 1
 *
 * ── It takes COUNTS and it takes no clocks, on purpose ───────────────────
 *
 * `docs/testing/perf-protocol.md` section 3a: a fan-out and a GPU measurement
 * cannot share this box. What survives contention is `renderer.info.render.calls`,
 * triangle counts, program counts and cache keys. A draw count is not a clock;
 * it is the same integer on a busy machine and an idle one.
 *
 * ── The pin ──────────────────────────────────────────────────────────────
 *
 * `?adaptive=0&quality=high` (`fixtures/quality-pin.ts`). A tier drop moves
 * MSAA, the shadow map and the prop LOD, every one of which is in a screenshot
 * and in a draw count, so an unpinned run compares two builds.
 *
 * ── The shadow half needs two numbers ────────────────────────────────────
 *
 * `renderer.info.render.calls` is the whole frame (shadow pass and colour pass).
 * `__ff2perf.census()` reads three's render list for the scene, which is the
 * COLOUR pass alone. So shadow calls = info.render.calls - census.calls. ORDER
 * MATTERS: `census()` renders frames of its own, so `info` is sampled first.
 *
 * ── What is asserted ─────────────────────────────────────────────────────
 *
 * Test 1, a frozen frame, ON (the shipped default) against OFF (the live
 * switch), per mission:
 *   * `WEBGL_multi_draw` is present, or three loops the sub-draws in JS and the
 *     call count goes straight back to today's;
 *   * every chunk is in a band, none overflowed or mismatched;
 *   * **every band carries `ff2Direct` and it is NOT all zero.** three's
 *     `BatchedMesh` throws on a geometry missing an attribute the batch has, and
 *     a program reading an absent attribute draws the ground with no sun; this
 *     is the "ground reads zero sun" check, by data;
 *   * the frame has fewer calls, in both passes, and the same triangles;
 *   * switching off returns the frame to the integer it started on;
 *   * **the PIXELS do not move**, as an A-B-A-B bracket (`?snap=` freezes the
 *     sim and not the wall clock, so the difference ACROSS the switch is judged
 *     against the difference WITHIN a state over the same gap).
 *
 * Test 2, LODs and fades while batched, on a stand that works the 1,024 m band
 * the way `lod-pop.spec.ts` does:
 *   * a nudge swaps chunks, and while any chunk fades `placed + fading ==
 *     built` at EVERY frame: a fading chunk leaves its band, a finished one
 *     rejoins, none is in both and none is in neither;
 *   * no program compiles during the churn (DEV-194's lesson);
 *   * afterwards the batched frame matches the unbatched one at the same pose,
 *     which fails if any band slot holds a stale chunk.
 *
 * `@gpu`, hydrated assets, a real compiler. Run by hand like the other
 * measure-tier specs.
 */

import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { missionReady } from './fixtures/boot'
import { flyToFreeze, frozenSim, missionTickOf } from './fixtures/freeze'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

const MISSIONS = (process.env.CHUNK_BATCH_MISSIONS ?? 'int_01_hoverJet,rookie_01_hoverJet').split(
  ',',
)
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
  /** `renderer.info.render.calls`: the WHOLE frame, shadow pass included. */
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
const chunkRow = (r: Reading): CensusRow | undefined =>
  r.rows.find((x) => x.group === 'world-terrain/chunks')

/**
 * Sample `renderer.info` over `FRAMES` frames, then take the census. The MODE,
 * not the median: these are integers that should not move on a frozen frame, and
 * the count of distinct values is reported so a reader can see whether that held.
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

interface BandRow {
  readonly lod: number
  readonly name: string
  readonly vertexCount: number
  readonly slots: number
  readonly used: number
  readonly bytes: number
  readonly castShadow: boolean
}

interface Report {
  readonly bands: readonly BandRow[]
  readonly placed: number
  readonly bytes: number
  readonly overflows: number
  readonly mismatches: number
}

interface Plan {
  readonly on: boolean
  readonly available: boolean
  readonly report: Report | null
}

const setBatch = (page: Page, on: boolean): Promise<Plan> =>
  page.evaluate(
    (v) =>
      (globalThis as unknown as { __ff2: { chunkBatch: (on: boolean) => Plan } }).__ff2.chunkBatch(
        v,
      ),
    on,
  )

/** Chunks built, and chunks fading, off the live land. */
const landCounts = (page: Page): Promise<{ built: number; fading: number }> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: { terrain: () => { terrain: { chunkCount: number; fadingChunks: number } } }
    }
    const t = w.__ff2.terrain().terrain
    return { built: t.chunkCount, fading: t.fadingChunks }
  })

/**
 * What each band's batch really holds, read off the GPU-bound buffers: whether
 * `ff2Direct` is there and whether it is anything but zero.
 */
const bandData = (
  page: Page,
): Promise<readonly { name: string; hasDirect: boolean; nonZero: boolean; used: number }[]> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: {
        render: { scene: { traverse: (f: (o: unknown) => void) => void } }
        terrain: () => {
          terrain: { batching: { report: () => { bands: { name: string; used: number }[] } } }
        }
      }
    }
    const used = new Map(
      w.__ff2
        .terrain()
        .terrain.batching.report()
        ?.bands.map((b) => [b.name, b.used]) ?? [],
    )
    const rows: { name: string; hasDirect: boolean; nonZero: boolean; used: number }[] = []
    w.__ff2.render.scene.traverse((o) => {
      const batch = o as {
        isBatchedMesh?: boolean
        name: string
        geometry: { getAttribute: (n: string) => { array: Float32Array } | undefined }
      }
      if (!batch.isBatchedMesh || !batch.name.startsWith('chunks_batch_')) return
      const direct = batch.geometry.getAttribute('ff2Direct')
      let nonZero = false
      if (direct) {
        for (let i = 0; i < direct.array.length; i++) {
          if (direct.array[i] !== 0) {
            nonZero = true
            break
          }
        }
      }
      rows.push({ name: batch.name, hasDirect: !!direct, nonZero, used: used.get(batch.name) ?? 0 })
    })
    return rows
  })

const programCount = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2: { render: { renderer: { info: { programs: unknown[] | null } } } }
        }
      ).__ff2.render.renderer.info.programs?.length ?? 0,
  )

/** Cache keys of every live program, so a program that appears can be NAMED. */
const programKeys = (page: Page): Promise<string[]> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2: { render: { renderer: { info: { programs: { cacheKey: string }[] | null } } } }
        }
      ).__ff2.render.renderer.info.programs?.map((p) => p.cacheKey) ?? [],
  )

/** Is `WEBGL_multi_draw` there? Asked of the live context, not assumed. */
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
const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`

/**
 * Mean absolute difference between two screenshots, per DECODED sample, 0..255.
 * Comparing PNG bytes is worthless (deflate changes the length with the content,
 * and a length guard returning Infinity made both the control and the arm
 * infinite and the assertion pass for every input; DEV-193 section 3b).
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

const summary = (label: string, r: Reading): string =>
  `  ${label.padEnd(10)} colour ${String(r.colourCalls).padStart(4)} · shadow ${String(
    shadowCalls(r),
  ).padStart(4)} · TOTAL ${String(r.frameCalls).padStart(4)} · ${k(r.frameTriangles)} tris · ${
    r.programs
  } programs${r.frameCallsSpread === 1 ? '' : `  (frame calls took ${r.frameCallsSpread} values)`}`

const planTable = (report: Report): string =>
  report.bands
    .map(
      (b) =>
        `      LOD ${String(b.lod).padStart(2)}  ${b.name.padEnd(15)} ${String(b.used).padStart(
          4,
        )}/${String(b.slots).padEnd(4)} slots × ${String(b.vertexCount).padStart(5)} verts  ${
          b.castShadow ? 'CASTS' : '     '
        }  ${mb(b.bytes)}`,
    )
    .join('\n')

test.describe('@measure @gpu DEV-904: the land as one BatchedMesh per LOD', () => {
  test.setTimeout(900_000)

  for (const mission of MISSIONS) {
    test(`${mission}/${EDITION}@${SNAP_AT}: the draw count, the data and the pixels`, async ({
      page,
    }) => {
      await flyToFreeze(page, {
        mission,
        edition: EDITION,
        snapAt: SNAP_AT,
        params: { perf: '1', adaptive: '0', quality: 'high' },
      })
      const sim = await frozenSim(page)

      expect(
        await multiDraw(page),
        'WEBGL_multi_draw is absent: three would loop the sub-draws in JS and the call count ' +
          'would not move. This spec is measuring nothing.',
      ).toBe(true)

      // ── the shipped state: ON, with nothing asked for ─────────────────
      const shoot = (): Promise<Buffer> => page.locator('#viewport').screenshot()
      const on1 = await read(page)
      const b1 = await shoot()
      const plan = await setBatch(page, true)
      const counts = await landCounts(page)
      const data = await bandData(page)
      // A-B-A-B: on, off, on, off. Each shot separated by the same work.
      const off = await setBatch(page, false)
      const a1 = await shoot()
      const offRead = await read(page)
      await setBatch(page, true)
      const b2 = await shoot()
      const on2 = await read(page)
      await setBatch(page, false)
      const a2 = await shoot()
      await setBatch(page, true)

      const withinOn = pixelDiff(b1, b2)
      const withinOff = pixelDiff(a1, a2)
      const acrossEarly = pixelDiff(b1, a1)
      const acrossLate = pixelDiff(b2, a2)
      const within = Math.max(withinOn, withinOff)
      const across = Math.max(acrossEarly, acrossLate)
      const report = plan.report as Report

      console.info(
        [
          '',
          `DEV-904: ${mission}/${EDITION}, frozen at ${SNAP_AT} s` +
            (sim
              ? ` (mission tick ${missionTickOf(sim)}, elapsed ${sim.elapsed.toFixed(3)} s)`
              : ''),
          '',
          '  THE FRAME',
          summary('batched', on1),
          summary('off', offRead),
          summary('batched', on2),
          `  chunks row: ${chunkRow(offRead)?.calls ?? '?'} calls -> ${chunkRow(on1)?.calls ?? '?'} calls` +
            `, ${k(chunkRow(offRead)?.triangles ?? 0)} -> ${k(chunkRow(on1)?.triangles ?? 0)} tris`,
          `  frame draw calls: ${offRead.frameCalls} -> ${on1.frameCalls} ` +
            `(colour ${offRead.colourCalls} -> ${on1.colourCalls}, ` +
            `shadow ${shadowCalls(offRead)} -> ${shadowCalls(on1)})`,
          '',
          '  PIXELS (mean absolute difference per decoded sample, 0..255)',
          `    WITHIN a state (the render clock alone):  on/on ${withinOn.toFixed(3)} · off/off ${withinOff.toFixed(3)}`,
          `    ACROSS the switch:                        early ${acrossEarly.toFixed(3)} · late ${acrossLate.toFixed(3)}`,
          '',
          `  bands: ${report.placed} of ${counts.built} chunks placed, reserved ${mb(report.bytes)}, ` +
            `overflows ${report.overflows}, mismatches ${report.mismatches}`,
          planTable(report),
          `  ff2Direct per band: ${data.map((d) => `${d.name}=${d.hasDirect ? (d.nonZero ? 'lit' : 'ZERO') : 'ABSENT'}`).join(' ')}`,
          '',
        ].join('\n'),
      )

      // ── the mechanism ─────────────────────────────────────────────────
      expect(plan.available, 'the land is not batchable: was chunkBatch passed?').toBe(true)
      expect(plan.on).toBe(true)
      expect(off.on, 'chunkBatch(false) did not switch off').toBe(false)
      expect(report.overflows, 'a band was too small and a chunk drew alone').toBe(0)
      expect(report.mismatches, 'a chunk did not fit its band (layout or vertex count)').toBe(0)
      expect(counts.fading, 'a frozen frame has nothing mid-fade').toBe(0)
      // Every chunk is in a band, bar the launch bore's (`exclude`), which is a
      // handful and only where there is a rig.
      expect(report.placed).toBeGreaterThan(counts.built * 0.9)
      expect(report.bands.reduce((n, b) => n + b.used, 0)).toBe(report.placed)

      // The ground is LIT through the batch: every band that holds a chunk has
      // the attribute, and it is not all zero.
      expect(data.length).toBe(report.bands.length)
      for (const band of data) {
        expect(band.hasDirect, `${band.name} has no ff2Direct: the ground reads zero sun`).toBe(
          true,
        )
        if (band.used > 0) expect(band.nonZero, `${band.name}'s ff2Direct is all zero`).toBe(true)
      }

      // The census row for the chunks became the batches, one call each.
      const offCalls = chunkRow(offRead)?.calls ?? 0
      const onCalls = chunkRow(on1)?.calls ?? 0
      expect(offCalls).toBeGreaterThan(report.bands.length)
      expect(onCalls, 'the chunk row should draw at most one call per band').toBeLessThanOrEqual(
        report.bands.length,
      )
      // And the census counts what a batch SUBMITTED, not what it reserves
      // (DEV-193 section 4: 280 k against the 182 k a frame carried).
      const offTris = chunkRow(offRead)?.triangles ?? 0
      const onTris = chunkRow(on1)?.triangles ?? 0
      expect(onTris, 'the census counted the reserved buffer').toBeLessThanOrEqual(offTris * 1.01)
      expect(onTris).toBeGreaterThan(offTris * 0.5)

      // Geometry did not go missing: the whole frame carries the same triangles.
      expect(
        Math.abs(on1.frameTriangles - offRead.frameTriangles) / Math.max(1, offRead.frameTriangles),
        `the frame carried ${k(on1.frameTriangles)} batched against ${k(offRead.frameTriangles)}`,
      ).toBeLessThan(0.01)

      // The whole frame, both passes.
      expect(on1.frameCalls, 'batching did not reduce the frame').toBeLessThan(offRead.frameCalls)
      expect(shadowCalls(on1), 'the shadow pass did not shrink').toBeLessThan(shadowCalls(offRead))
      // A count does not drift: switching on again returns the integer.
      expect(on2.frameCalls).toBe(on1.frameCalls)
      expect(on2.colourCalls).toBe(on1.colourCalls)

      // ── the pixels, against the control rather than against a taste ───
      expect(
        across,
        `the frames differ ACROSS the switch by ${across.toFixed(3)} against ${within.toFixed(3)} ` +
          'WITHIN a state over the same gap: something in the material or the data did not reach the batch',
      ).toBeLessThanOrEqual(Math.max(1.5 * within, 0.05))
    })
  }

  test('LODs and fades work while batched: nothing is in two places, nothing in none', async ({
    page,
  }) => {
    // The stand `lod-pop.spec.ts` works: the look point sits on the 1,024 m
    // band, and a nudge toward the hillside carries chunks across it.
    const eye = [1196, 500, -795] as const
    const look = [522, 338, -1533] as const
    await page.goto(
      `/?view=cam&xr=off&ride=0&eye=${eye.join(',')}&look=${look.join(',')}` +
        `&edition=${EDITION}&mission=int_01_hoverJet&${PINNED}${process.env.CHUNK_BATCH_URL_EXTRA ?? ''}`,
    )
    await firstPress(page)
    await missionReady(page, 120_000)
    const settle = (): Promise<unknown> =>
      page.waitForFunction(
        () => {
          const t = (
            globalThis as unknown as {
              __ff2?: {
                terrain: () => { terrain: { pending: number; detailPending: number } } | null
              }
            }
          ).__ff2?.terrain?.()
          return !!t && t.terrain.pending === 0 && t.terrain.detailPending === 0
        },
        undefined,
        { timeout: 60_000 },
      )
    await settle()
    await page.waitForTimeout(2_500)
    await settle()

    const bx = look[0] - eye[0]
    const bz = look[2] - eye[2]
    const len = Math.hypot(bx, bz)
    const nudge = 250
    const toward = [(bx / len) * nudge, (bz / len) * nudge]

    const keysBefore = await programKeys(page)
    const programsBefore = await programCount(page)
    const liveBefore = await page.evaluate(
      () =>
        (
          globalThis as unknown as {
            __ff2: { terrain: () => { terrain: { lodLive: Record<string, number> } } }
          }
        ).__ff2.terrain().terrain.lodLive,
    )

    // Step the eye toward the hill for two loops, step back, and sample EVERY
    // frame of the replies landing and fading. One in-page loop: a Playwright
    // round trip per sample would miss most of a 1 s fade.
    const trace = await page.evaluate(
      async ([hx, hy, hz, ox, oz]) => {
        const w = globalThis as unknown as {
          __ff2: {
            render: { camera: { position: { set: (x: number, y: number, z: number) => void } } }
            terrain: () => {
              terrain: {
                chunkCount: number
                fadingChunks: number
                batching: {
                  report: () => { placed: number; overflows: number; mismatches: number } | null
                }
              }
            }
          }
        }
        const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))
        const rows: {
          built: number
          fading: number
          placed: number
          overflows: number
          mismatches: number
        }[] = []
        const sample = (): void => {
          const t = w.__ff2.terrain().terrain
          const r = t.batching.report()
          rows.push({
            built: t.chunkCount,
            fading: t.fadingChunks,
            placed: r?.placed ?? 0,
            overflows: r?.overflows ?? 0,
            mismatches: r?.mismatches ?? 0,
          })
        }
        w.__ff2.render.camera.position.set(hx + ox, hy, hz + oz)
        await frame()
        await frame()
        w.__ff2.render.camera.position.set(hx, hy, hz)
        for (let i = 0; i < 360; i++) {
          await frame()
          sample()
        }
        return rows
      },
      [eye[0], eye[1], eye[2], toward[0], toward[1]] as [number, number, number, number, number],
    )
    await settle()

    const peakFading = Math.max(...trace.map((r) => r.fading))
    const excluded = trace[0] ? trace[0].built - trace[0].placed - trace[0].fading : 0
    const liveAfter = await page.evaluate(
      () =>
        (
          globalThis as unknown as {
            __ff2: { terrain: () => { terrain: { lodLive: Record<string, number> } } }
          }
        ).__ff2.terrain().terrain.lodLive,
    )
    const programsAfter = await programCount(page)
    for (const key of (await programKeys(page)).filter((x) => !keysBefore.includes(x))) {
      console.info(`  NEW PROGRAM: ${key.slice(0, 700)}`)
    }
    console.info(
      [
        '',
        `DEV-904 LOD churn: LOD ${JSON.stringify(liveBefore)} -> ${JSON.stringify(liveAfter)}`,
        `  frames sampled ${trace.length}, peak fading ${peakFading}, programs ${programsBefore} -> ${programsAfter}`,
        `  unplaced and not fading (excluded or overflowed): ${excluded}`,
        '',
      ].join('\n'),
    )

    expect(
      JSON.stringify(liveAfter),
      'the nudge moved no chunk across a band, so this measured nothing',
    ).not.toBe(JSON.stringify(liveBefore))
    expect(peakFading, 'no chunk faded: is lodFade on in this edition?').toBeGreaterThan(0)
    for (const [i, row] of trace.entries()) {
      expect(
        row.placed + row.fading + excluded,
        `frame ${i}: ${row.placed} placed + ${row.fading} fading + ${excluded} excluded != ${row.built} built`,
      ).toBe(row.built)
      expect(row.overflows).toBe(0)
      expect(row.mismatches).toBe(0)
    }
    const last = trace[trace.length - 1]
    expect(last?.fading, 'a fade never finished').toBe(0)
    expect(programsAfter, 'a program compiled in flight').toBe(programsBefore)

    // ── and what is drawn is what is there ─────────────────────────────
    // A band slot holding a stale chunk is invisible to every count above. At
    // the same pose, the batched frame must match the unbatched one.
    const shoot = (): Promise<Buffer> => page.locator('#viewport').screenshot()
    const b1 = await shoot()
    await setBatch(page, false)
    const a1 = await shoot()
    await setBatch(page, true)
    const b2 = await shoot()
    await setBatch(page, false)
    const a2 = await shoot()
    await setBatch(page, true)
    const within = Math.max(pixelDiff(b1, b2), pixelDiff(a1, a2))
    const across = Math.max(pixelDiff(b1, a1), pixelDiff(b2, a2))
    console.info(`  pixels after churn: within ${within.toFixed(3)}, across ${across.toFixed(3)}`)
    expect(
      across,
      `after the churn the batched frame differs from the unbatched by ${across.toFixed(3)} ` +
        `against ${within.toFixed(3)} within a state: a slot holds a stale chunk`,
    ).toBeLessThanOrEqual(Math.max(1.5 * within, 0.05))
  })
})
