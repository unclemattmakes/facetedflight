/**
 * tests/e2e/inflight-compile.spec.ts — does this mission compile a shader IN
 * THE AIR, and if so, WHICH one?
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * `docs/testing/perf-protocol.md` §0 says survey along a run before attributing
 * on a frame, and the first survey to be taken found this: of thirteen missions
 * flown for ninety seconds each, **eleven never compile a program after their
 * first frame** — and the two that do own the two worst frames in the game.
 *
 *     adv_02_hoverJet    programs 110 -> 112   frame  318.4 ms   at  5.0 s
 *     int_01_hoverJet    programs 110 -> 111   frame  178.6 ms   at 77.2 s
 *
 * A third of a second is not a hitch, it is a freeze. Worn, it is the
 * difference between a stutter and a lurch, and it happens five seconds into
 * `adv_02_hoverJet`.
 *
 * The trace can say a compile HAPPENED — `programs` is one of DEV-177's world
 * counters and it rides in every row — but it cannot say what compiled, and
 * "something in the terrain fade, probably" is not a thing anyone can fix.
 * `WebGLProgram.cacheKey` can: `WebGLPrograms.getProgramCacheKey` builds it from
 * the shader id, every name in `material.defines`, the boolean and numeric
 * parameters, the output colour space and `customProgramCacheKey()`. Diff the
 * live key set across the flight and the new one names itself.
 *
 * Since DEV-239 it is READ rather than printed raw:
 * `fixtures/program-key.ts` splits the key into its fields, names the variant
 * in one line, and diffs it against the nearest key the warm-up did build — so
 * the output says *which module to open* instead of handing over three hundred
 * commas.
 *
 * ── STEREO, which is the half that was missing (DEV-239) ─────────────────
 *
 * `COMPILE_XR=1` flies the same watch through a real immersive session — the
 * VRto3D rig, Chrome's own WebXR, SteamVR's compositor — instead of the flat
 * path. It is a different question and not a nicer harness:
 *
 *   * the flat path renders through the bloom composer into a linear render
 *     target; **in session three binds the XR layer's framebuffer**, and
 *     `renderer.outputColorSpace` is field 51 of the cache key;
 *   * the flat path draws one camera and a session draws an `ArrayCamera`;
 *   * and `render/warm-up.ts` runs under the loading curtain, which is BEFORE
 *     `#enter-vr` is pressed — so every program it builds is built against
 *     whatever the flat page had bound at that moment.
 *
 * `docs/plan/VR-PERF-TAIL.md` §4.6 is why it was asked for: the three worst
 * mid-flight frames in the thirteen-mission set each follow a `programs` +1 by
 * 122–135 ms, on two missions this gate already reported as clean — **and it had
 * only ever run flat.**
 *
 * ── Why it is a GATE and not just a probe ────────────────────────────────
 *
 * This project has built warm-up machinery for this exact system three times —
 * DEV-184's `warmLodFade`, DEV-186's resync, DEV-190's four-variant warm — and
 * it is still one variant short on two missions. Each of those rows was correct
 * about the case it was looking at. What was missing was something that FLIES
 * every mission and says "you missed one", which is the same shape as
 * `view-toggle-compile.spec.ts` (DEV-186) except that a view toggle is one
 * press and a lap is where the rare variants actually come up.
 *
 * It gates a MECHANISM — a program count — and never a millisecond
 * (`docs/testing/perf-protocol.md`, rule 1). The millisecond is a property of
 * the machine; the compile is a property of the build.
 *
 *   COMPILE_MISSION=adv_02_hoverJet COMPILE_SECONDS=120 E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/inflight-compile.spec.ts --workers 1
 *
 *   COMPILE_XR=1 COMPILE_MISSION=int_01_hoverJet COMPILE_SECONDS=45 \
 *     COMPILE_DIR=perf-out/dev239 E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/inflight-compile.spec.ts --workers 1
 *
 * `@gpu`, hydrated assets, a real compiler, headed. Slow: a full flight per
 * mission. The stereo mode additionally needs VRto3D installed and SteamVR up
 * (`node tools/steamvr-rig.mjs status` in `../vr-browser`), and **one immersive
 * session at a time** — `--workers 1`, always.
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold } from './fixtures/freeze'
import { enterVr, firstPress, loadSettled } from './fixtures/landing'
import {
  type DecodedProgramKey,
  decodeProgramCacheKey,
  describeProgramKey,
  nearestWarmKey,
} from './fixtures/program-key'
import { expect, test as flatTest } from './fixtures/test'
import { test as xrTest } from './fixtures/xr-browser'

type Page = import('@playwright/test').Page

const MISSION = process.env.COMPILE_MISSION ?? 'adv_02_hoverJet'
const EDITION = process.env.COMPILE_EDITION ?? 'anniversary'
/** How long to watch AFTER the launch lets go. */
const SECONDS = Number(process.env.COMPILE_SECONDS ?? '120')
/** Fly it through a real immersive session rather than the flat path. */
const XR = process.env.COMPILE_XR === '1'
/** Where to write the machine-readable record, if anywhere. */
const OUT_DIR = process.env.COMPILE_DIR ?? ''

/**
 * The XR mode needs a Chrome with the immersive-session consent pre-granted, so
 * it takes its `test` from `fixtures/xr-browser.ts`. The two `TestType`s are
 * structurally identical — that fixture overrides `context` and `page` with the
 * same types it found them at — so this is a choice of BROWSER and not of
 * harness, and the flat path is byte for byte the one DEV-194 shipped.
 */
const test = XR ? xrTest : flatTest

/**
 * How often to diff the key set.
 *
 * A compiled program STAYS in `info.programs` until its last user re-fetches,
 * so this does not have to catch the frame — it has to catch the program before
 * something else releases it. 250 ms is far below any release this flight does
 * and cheap enough not to be the thing that perturbs the flight.
 */
const POLL_MS = 250

/** Every live program's cache key. */
const keys = (page: Page): Promise<string[]> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2: { render: { renderer: { info: { programs?: { cacheKey: string }[] } } } }
        }
      ).__ff2.render.renderer.info.programs?.map((p) => String(p.cacheKey)) ?? [],
  )

/** Mission seconds, from the surface a headset session has. */
const elapsed = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __ff2perf?: { sim: () => { elapsed: number } } }).__ff2perf?.sim()
        .elapsed ?? 0,
  )

/**
 * The world counters at this instant, so a compile arrives with its context
 * rather than as a bare string. DEV-177's set, same as the trace's columns.
 *
 * `pieces` was missing until DEV-239 and it was the one that named a find:
 * `int_01_hoverJet` compiles a transparent flat-shaded variant at ~26 s, which
 * is `PropFracture`'s own material and DEV-177's own *"a racer clipped a palm
 * at ~26 s"*. Five of the six counters printed and the sixth was the answer.
 */
const world = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: {
        terrain: () => {
          terrain: { fadingChunks: number; pending: number; detailChunks: number }
          ocean: { fadingChunks: number; pending: number } | null
        } | null
        fracture: () => { live: number; landed: number } | null
      }
    }
    const t = w.__ff2.terrain()
    const f = w.__ff2.fracture()
    const pieces = f ? ` · pieces ${f.live} live / ${f.landed} landed` : ' · no fracture'
    if (!t) return `terrain: none${pieces}`
    return (
      `land fading ${t.terrain.fadingChunks} pending ${t.terrain.pending} detail ${t.terrain.detailChunks}` +
      (t.ocean ? ` · sea fading ${t.ocean.fadingChunks} pending ${t.ocean.pending}` : ' · no sea') +
      pieces
    )
  })

/** Is three presenting to a headset right now? Printed, so a run states its own mode. */
const presenting = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const r = (globalThis as unknown as { __ff2?: { render?: { renderer?: unknown } } }).__ff2
      ?.render?.renderer as { xr?: { isPresenting?: boolean } } | undefined
    return r?.xr?.isPresenting ?? false
  })

interface Fresh {
  readonly key: string
  readonly atSeconds: number
  readonly counters: string
  readonly decoded: DecodedProgramKey
}

/**
 * Get the flight to the point where the recorder arms, flat.
 *
 * Unchanged from DEV-194 — `#start`, the canvas, an Enter hold — because the
 * whole value of keeping this mode is that it is still the reading DEV-194
 * took.
 */
const flyFlat = async (page: Page): Promise<void> => {
  await page.goto(
    `/?perf=1&autopilot=1&xr=off&mission=${MISSION}&edition=${EDITION}&trace=${SECONDS}`,
  )
  await firstPress(page)
  await missionReady(page, 240_000)
  await focusCanvas(page)
  await hold(page, 'Enter')
}

/**
 * The same, through a real immersive session — `xr-vrto3d-trace.spec.ts`'s own
 * sequence, which is the one that is known to reach a presenting session on
 * this rig.
 *
 * No `#start` and no Enter hold: pressing `#enter-vr` is what boards the ship
 * on this path, and `autopilot=1` flies it. No `xr=off`, obviously — that is
 * the switch the flat mode uses to keep `isSessionSupported` from starting
 * SteamVR at all.
 */
const flyStereo = async (page: Page): Promise<void> => {
  await page.goto(`/?perf=1&autopilot=1&mission=${MISSION}&edition=${EDITION}&trace=${SECONDS}`)
  await loadSettled(page, 180_000)
  // A real user gesture, which is what `requestSession` wants. The consent
  // prompt is answered by the profile — see `fixtures/xr-browser.ts`.
  await enterVr(page)
  await expect.poll(async () => presenting(page), { timeout: 60_000 }).toBe(true)
}

test.describe('@gpu nothing compiles in the air', () => {
  test.setTimeout(900_000)

  test(`${MISSION} ${EDITION} ${XR ? 'STEREO' : 'flat'}: no program is created after the launch lets go`, async ({
    page,
  }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))

    if (XR) await flyStereo(page)
    else await flyFlat(page)

    // ── the baseline is taken when the RECORDER arms, not on a timer ──────
    //
    // `?trace=` arms from a STATE — a flight, on the mission screen, once the
    // launch has let go — which is exactly the boundary this spec is about.
    // Everything compiled before it is the warm-up's job and is allowed; the
    // first program after it is a frame the player sees. Both modes use it, so
    // the two runs are comparable at the only point that matters.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (
              globalThis as unknown as { __ff2perf: { trace: { status: () => string } } }
            ).__ff2perf.trace.status(),
          ),
        { timeout: 300_000, intervals: [500] },
      )
      .toBe('recording')

    // Asserted rather than assumed: a stereo run that quietly fell back to the
    // flat path would produce a clean sheet and read as a result, which is the
    // shape of every retraction in `VR-PERF-WAVE-2-WORK.md` §7.
    const wasPresenting = await presenting(page)
    expect(
      wasPresenting,
      'COMPILE_XR=1 but three is not presenting — this run is the FLAT path wearing a stereo label',
    ).toBe(XR)

    const warm = await keys(page)
    const before = new Set(warm)
    const found: Fresh[] = []
    const started = Date.now()
    while ((Date.now() - started) / 1000 < SECONDS) {
      await page.waitForTimeout(POLL_MS)
      const now = await keys(page)
      const fresh = now.filter((k) => !before.has(k))
      if (fresh.length === 0) continue
      const at = await elapsed(page)
      const counters = await world(page)
      for (const k of fresh) {
        before.add(k)
        found.push({ key: k, atSeconds: at, counters, decoded: decodeProgramCacheKey(k) })
      }
    }

    // ── name each one, and say what separates it from the nearest warm key ──
    //
    // The nearest neighbour is the whole of the fix: "a program appeared" is
    // not actionable and "the warm-up built this same variant at
    // numPointLights 3 and the flight wants 2" is. DEV-194 did this by hand.
    const lines = found.map((f) => {
      const near = nearestWarmKey(f.decoded, warm)
      // `sameMaterial` is printed because the two cases want opposite fixes.
      // The SAME material warmed at another variant is a warm-up that missed a
      // binding, a light count or a define; a different material entirely means
      // nothing warmed this one at all, and the nearest key is then a hint
      // rather than a diagnosis.
      const which = near?.sameMaterial === true ? 'the SAME material, warm at' : 'the nearest warm'
      const diff =
        near === null
          ? '       (no warm key to compare against)'
          : near.differences.length === 0
            ? '       identical to a warm key in every decoded field — see the raw key below'
            : `       differs from ${which} key in ${near.differences.length} field(s): ` +
              near.differences.map((d) => `${d.field} ${d.theirs} -> ${d.mine}`).join(', ')
      return [
        `  +1 at ${f.atSeconds.toFixed(1)} s — ${f.counters}`,
        `     ${describeProgramKey(f.decoded)}`,
        diff,
        near === null ? '' : `       nearest warm: ${describeProgramKey(near.nearest)}`,
        `       raw: ${f.key}`,
      ]
        .filter((s) => s.length > 0)
        .join('\n')
    })

    console.info(
      [
        `\nin-flight compiles — ${MISSION} ${EDITION}, ${XR ? 'STEREO (immersive session)' : 'FLAT'}, ${SECONDS} s after release`,
        `  programs at release: ${warm.length}`,
        found.length === 0 ? '  NONE — every program this flight draws was warm' : lines.join('\n'),
        '',
      ].join('\n'),
    )

    if (OUT_DIR) {
      fs.mkdirSync(OUT_DIR, { recursive: true })
      const stem = `${MISSION}-${EDITION}-${XR ? 'xr' : 'flat'}-${SECONDS}s`
      fs.writeFileSync(
        path.join(OUT_DIR, `${stem}.json`),
        `${JSON.stringify(
          {
            mission: MISSION,
            edition: EDITION,
            stereo: XR,
            seconds: SECONDS,
            presenting: wasPresenting,
            atRelease: warm.length,
            warm,
            found: found.map((f) => ({
              atSeconds: f.atSeconds,
              counters: f.counters,
              key: f.key,
              name: describeProgramKey(f.decoded),
            })),
          },
          null,
          2,
        )}\n`,
      )
      console.info(`  written to ${path.join(OUT_DIR, stem)}.json`)
    }

    expect(pageErrors, `page errors during the run:\n${pageErrors.join('\n')}`).toEqual([])

    // The gate, on the mechanism. A compile in the air is a defect whatever it
    // costs on the day, and what it costs on the day is a fact about the
    // machine (protocol rule 1).
    expect(
      found.map((f) => `${f.atSeconds.toFixed(1)} s · ${describeProgramKey(f.decoded)}`),
      `${found.length} program(s) compiled after the launch let go — each one is a frame the ` +
        'player sees stall. The line above names the variant the warm-up missed.',
    ).toEqual([])
  })
})
