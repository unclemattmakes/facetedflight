/**
 * tests/e2e/shader-link.spec.ts — every GLSL program the game builds LINKS.
 * DEV-324.
 *
 * ── The gate nobody had ──────────────────────────────────────────────────
 *
 * `typecheck`, `lint`, `test`, `extract:check`, `assets:check` and `vite build`
 * can all be 0 while a program fails to link, because none of them compiles a
 * shader. It shipped twice in eight days; the second was DEV-298's `uSunTopXf`,
 * a uniform declared in the fragment prelude and used in the vertex shader —
 * two symbol tables, `VALIDATE_STATUS false`, GL 1282 on the title screen.
 *
 * This is that check made a spec. For each arm it reaches a real frame and
 * asserts, IN THIS ORDER:
 *
 *   1. **the frame drew something** — `renderer.info.render.calls > 0` and
 *      `renderer.info.programs.length > 0`. A frame that drew nothing reports
 *      zero errors too, and a zero read off it is not a pass;
 *   2. three is checking (`renderer.debug.checkShaderErrors`), so the console
 *      half is a detector at all;
 *   3. **no program failed to link**, by two detectors: `LINK_STATUS` asked of
 *      GL for EVERY program in three's cache, and three's own
 *      `THREE.WebGLProgram: Shader Error` console line, as an exact prefix:
 *      the benign `X4122` precision notes that programs which LINKED print
 *      share `THREE.WebGLProgram:` with it, and app lines mention shaders.
 *      `fixtures/shader-link.ts` says why both are needed — in short, three
 *      reports a failure only on a program's first DRAW, and the warm-up builds
 *      most programs without drawing them.
 *
 * A failure names the program: its material type, its decoded cache key (the
 * `tagProgramCacheKey` chain names the module), the meshes that hold it, and
 * the compiler's first `ERROR:` for each half.
 *
 * ── The arms, and why these ──────────────────────────────────────────────
 *
 * Coverage is the whole question — a program nobody built was not checked. The
 * cheap route to "every program" is NOT flying everywhere: `render/warm-up.ts`
 * compiles the whole mission scene under the loading curtain (DEV-117), and
 * `inflight-compile.spec.ts` measured eleven of thirteen missions compiling
 * nothing after their first frame. So one early frozen frame per world holds
 * nearly every program that world will ever build, and the GL sweep reads the
 * ones the warm-up compiled but the frame never drew. What the arms have to
 * vary is what goes INTO a program's source:
 *
 *   * **edition** — Anniversary and Classic build different variants and bind
 *     differently: Anniversary composites through a linear target, Classic
 *     draws to the canvas, and the program sets differ in size (102 against
 *     61 on `int_01`). Some patches compile in both — DEV-324's RED run broke
 *     the sun-height and fog patches and Classic went red too — so neither
 *     edition stands in for the other. Both, on every arm.
 *   * **world** — `int_01_hoverJet` (Simonet, HoverJet, elevator ride, the sea;
 *     the release mission) and `adv_01_jumpSeat` (desert, JumpSeat, direct
 *     launch) differ on every one of those axes at once. The alpine valley is
 *     covered by the TITLE arm, which builds it with its own forest and the
 *     far-field terms whose first build (DEV-298) failed to link exactly
 *     there. Kauai is not flown; that it
 *     adds no variant Simonet lacks is an assumption, not a measurement.
 *   * **view** — third person (V) draws the hull from outside and moves the
 *     camera out of the cabin; it is swept on every world arm after the
 *     cockpit, and the console's own `camera: third person` is the premise
 *     that the toggle happened (a key that did not register leaves the same
 *     counts).
 *   * **screen** — the title and the hangar are other scenes entirely: the
 *     monument, the flypast jets, the holotables.
 *   * **binding** — a headset SESSION draws every lit program at the canvas's
 *     colour space and tone mapping, which no flat Anniversary frame uses. The
 *     warm-up compiles those variants whenever the device can enter a session
 *     (`alsoDefaultTarget`, DEV-239), so the session arm installs the emulated
 *     runtime (`fixtures/emulated-xr.ts`, nothing under `src/` knows) and
 *     sweeps a flat frame. It does not enter a session: it does not need to,
 *     because `LINK_STATUS` is a property of the program and not of a draw.
 *
 * What is NOT covered, stated rather than discovered: Kauai, the other nine
 * missions, the two in-flight compiles `inflight-compile.spec.ts` names (at
 * 5 s and 77 s — past this snap or on other courses), the stereo draw itself,
 * programs built only by the pause or results plates, and a program that is
 * compiled, released and destroyed before the sweep without ever being drawn.
 * The quality tier is pinned, and it is not a coverage axis: `QUALITY` in
 * `render/quality.ts` moves the framebuffer scale, the pixel-ratio cap and
 * MSAA, and none of those is a field of three's program cache key.
 *
 * ── Running it ───────────────────────────────────────────────────────────
 *
 *   SHADER_LINK_DIR=<dir> E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/shader-link.spec.ts --workers 2
 *
 * `@gpu`, hydrated assets, a real compiler, headed. Every arm prints the
 * AGENT-NOTES §4 instrument line — draw calls, triangles, programs, console
 * messages, shader errors — and, with `SHADER_LINK_DIR` set, writes a JSON
 * record and a pinned screenshot per sweep there (Playwright wipes
 * `test-results/` at the start of every run).
 *
 * **From an agent worktree, verifying RED:** `pnpm dev` (Playwright's
 * `webServer`) cannot find vite there, so start `npx vite --port <E2E_PORT>
 * --strictPort --host` yourself. That server then IGNORES every edit you
 * make (`vite.config.ts`'s DEV-255 watch-ignore matches `.claude/worktrees/`,
 * which is its own root) and keeps serving the module it first transformed.
 * Restart it after breaking a shader and after reverting it, or the RED run
 * tests the green build. DEV-324's first attempt did exactly that.
 *
 * Counts only. No duration in this file means anything, and none is printed.
 * The program count is a count SO FAR, not a count of the frame
 * (`docs/AGENT-NOTES.md` §1): it is what the page built on the way there.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bootReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { emulatedXrInstalled, installEmulatedXr } from './fixtures/emulated-xr'
import type { Ff2Global, Ff2GlobalMaybe } from './fixtures/ff2'
import { flyToFreeze, hold } from './fixtures/freeze'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import {
  collapseRepeats,
  describeConsoleFailure,
  describeFailedProgram,
  type ProgramSweep,
  type ShaderConsole,
  sessionKeyedPhysical,
  sweepPrograms,
  watchShaderConsole,
} from './fixtures/shader-link'
import { expect, type TestInfo, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

type Page = import('@playwright/test').Page

const OUT_DIR = process.env.SHADER_LINK_DIR ?? ''
/**
 * Mission seconds at the freeze. 20 is `render-census.spec.ts`'s default: out
 * of the shaft, the course and the racers in view, several rings behind.
 */
const SNAP_AT = Number(process.env.SHADER_LINK_AT ?? '20')

/** The pin as query parameters, derived from the one constant. */
/**
 * DEV-988: `SHADER_LINK_MULTIVIEW=1` runs every arm with `?multiview=1` and,
 * before each sweep, `__ff2.multiviewProbe()`, which compiles AND draws the
 * stage's multiview programs (one pass into a two-layer target, the per-eye
 * block bound), so the sweep below holds them and checks their link like any
 * other. Flat: the XR layer is the rig's (`xr-multiview.spec.ts`). Unset, the
 * spec is byte for byte what it was.
 */
const MULTIVIEW = process.env.SHADER_LINK_MULTIVIEW === '1'
const PIN = MULTIVIEW ? `${PINNED}&multiview=1` : PINNED
const PIN_PARAMS: Readonly<Record<string, string>> = Object.fromEntries(new URLSearchParams(PIN))
/**
 * DEV-583's arm: the same pin with the tier at `ultra`, the only tier whose
 * Anniversary sea carries the mirror's define. Every photo's name carries the
 * pin it was taken under (`verify`), so no photo from here is mistaken for
 * unpinned or for `high`.
 */
// DEV-837 shipped the mirror off, so this arm pins it back on to keep its variants checked.
const ULTRA_PIN = `${PIN.replace('quality=high', 'quality=ultra')}&feature=render.seaReflection:on`
const ULTRA_PARAMS: Readonly<Record<string, string>> = Object.fromEntries(
  new URLSearchParams(ULTRA_PIN),
)

/** The mirror's own report (`render/sea-reflection.ts`), off the scene it draws. */
const seaMirror = (
  page: Page,
): Promise<{ on: boolean; passes: number; calls: number; triangles: number } | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    return w.__ff2?.render.scene.userData.seaReflection?.() ?? null
  })

const EDITIONS = ['anniversary', 'classic'] as const

const WORLDS = [
  { mission: 'int_01_hoverJet', note: 'simonet, hoverjet, elevator, the sea' },
  { mission: 'adv_01_jumpSeat', note: 'desert, jumpseat, direct launch' },
] as const

/** Which of the two menu-side screens is showing. `title-screen.spec.ts`'s probe. */
const screens = (page: Page): Promise<{ title: boolean; hangar: boolean }> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    let title = false
    let hangar = false
    w.__ff2?.render.scene.traverse((o) => {
      if (o.name === 'title-screen') title = o.visible === true
    })
    w.__ff2?.stage().traverse((o) => {
      if (o.name === 'hangar') hangar = hangar || o.visible === true
    })
    return { title, hangar }
  })

interface Reading {
  readonly sweep: ProgramSweep
  /** Console link failures so far, one line each. */
  readonly consoleFailures: readonly string[]
}

/**
 * Sweep, record, photograph, print — and then assert, positive half first.
 *
 * The assertions live here rather than in each test so that no arm can check
 * the error list without first checking that the frame drew.
 */
const verify = async (
  page: Page,
  ledger: ShaderConsole,
  testInfo: TestInfo,
  arm: string,
  view: string,
  /** The quality pin this arm loaded with, for the photo's name and the record. */
  pin: string = PIN,
): Promise<Reading> => {
  if (MULTIVIEW) {
    const probe = await page.evaluate(() => {
      const w = globalThis as unknown as Ff2Global
      const p = w.__ff2.multiviewProbe({ width: 256, height: 256 })
      return p ? { calls: p.multiview.calls, report: w.__ff2.multiview() } : null
    })
    console.info(`shader-link ${arm} · ${view}: multiview ${JSON.stringify(probe)}`)
    expect(probe, 'the page loaded with ?multiview=1').not.toBeNull()
    expect(probe?.calls ?? 0, 'the multiview pass drew').toBeGreaterThan(0)
    expect(probe?.report?.fallbacks, 'sources the multiview rewrite refused').toEqual([])
  }
  const sweep = await sweepPrograms(page)
  const lines = ledger.lines()
  const consoleFailures = collapseRepeats(
    lines.filter((l) => l.kind === 'link-failure').map((l) => describeConsoleFailure(l.text)),
  )
  const infoLogs = lines.filter((l) => l.kind === 'program-info-log').length
  const webgl = lines.filter((l) => l.kind === 'webgl')
  const label = `${arm} · ${view}`
  const slug = `${arm}-${view}`.replace(/[^a-z0-9_]+/gi, '-').replace(/-+$/, '')

  console.info(
    `shader-link ${label}: ${sweep.calls.toLocaleString('en-US')} draw calls · ` +
      `${sweep.triangles.toLocaleString('en-US')} triangles · ` +
      `${sweep.programs} programs (${sweep.linked} linked, ${sweep.compileOnly} never drawn, ` +
      `${sessionKeyedPhysical(sweep.keys)} physical@srgb) · ` +
      `${lines.length} messages captured (${infoLogs} program-info-log, ${webgl.length} webgl) · ` +
      `${sweep.failed.length} programs failed LINK_STATUS ` +
      `(${sweep.failed.filter((f) => !f.drawn).length} never drawn) · ` +
      `${lines.filter((l) => l.kind === 'link-failure').length} console shader errors`,
  )
  for (const w of webgl.slice(0, 5)) console.info(`shader-link ${label}:   webgl: ${w.text}`)
  for (const e of ledger.pageErrors().slice(0, 5))
    console.info(`shader-link ${label}:   pageerror: ${e}`)

  const dir = OUT_DIR || testInfo.outputPath()
  fs.mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: path.join(dir, `${slug}-${pin.replace(/[=&]/g, '')}.png`) })
  if (OUT_DIR) {
    fs.writeFileSync(
      path.join(OUT_DIR, `${slug}.json`),
      `${JSON.stringify(
        {
          arm,
          view,
          pin,
          ...sweep,
          keys: undefined,
          sessionKeyedPhysical: sessionKeyedPhysical(sweep.keys),
          messages: lines.length,
          programInfoLogs: infoLogs,
          // The benign ones, verbatim (first three, clipped): the evidence for
          // the classifier's "not a failure" case, from this box's compiler.
          programInfoLogSamples: lines
            .filter((l) => l.kind === 'program-info-log')
            .slice(0, 3)
            .map((l) => l.text.slice(0, 400)),
          webgl: webgl.map((w) => w.text),
          consoleFailures,
          pageErrors: ledger.pageErrors(),
        },
        null,
        2,
      )}\n`,
    )
  }

  // ── 1. positive: something was drawn and compiled ──────────────────────
  expect(
    sweep.calls,
    `${label}: the frame drew nothing, so "no errors" would be vacuous`,
  ).toBeGreaterThan(0)
  expect(sweep.programs, `${label}: three compiled no programs`).toBeGreaterThan(0)
  // ── 2. both detectors are live ─────────────────────────────────────────
  expect(
    sweep.checkShaderErrors,
    `${label}: renderer.debug.checkShaderErrors is off — three would print nothing`,
  ).toBe(true)
  expect(sweep.unreadable, `${label}: programs GL would not answer for`).toBe(0)
  // ── 3. and nothing failed to link ──────────────────────────────────────
  expect(
    [...sweep.failed.map(describeFailedProgram), ...consoleFailures.map((c) => `console: ${c}`)],
    `${label}: programs that did not link`,
  ).toEqual([])
  return { sweep, consoleFailures }
}

/** Press V, and wait for the game to SAY it moved the camera out. */
const toThirdPerson = async (page: Page, ledger: ShaderConsole): Promise<void> => {
  const said = (): boolean => ledger.lines().some((l) => l.text === 'camera: third person')
  expect(said(), 'already in third person before V').toBe(false)
  // Held, not tapped: the toggle is edge-detected once a frame
  // (`view-toggle-compile.spec.ts` has the run that proved it).
  await hold(page, 'v')
  await expect.poll(said, { timeout: 15_000, message: 'V never reached the camera' }).toBe(true)
  // The switch fades out and back in (`FADE.cameraSwitch*`); let it land and
  // draw the outside view for a few frames.
  await page.waitForTimeout(3_000)
}

test.describe('@measure @gpu every program links: DEV-324', () => {
  // A terrain load (up to 240 s cold), the freeze poll (up to 180 s) and two
  // sweeps. The default 30 s cut the scratch version of this off mid-poll and
  // reported a bare `toBe(true)` (AGENT-NOTES §4).
  test.setTimeout(600_000)

  for (const edition of EDITIONS) {
    test(`the title screen, then the hangar · ${edition}`, async ({ page }, testInfo) => {
      const ledger = watchShaderConsole(page)
      await page.goto(`/?xr=off&edition=${edition}&${PIN}`)
      await firstPress(page)
      await bootReady(page)
      // Not `focusCanvas`: a click on the title is a real press (DEV-301).
      await dropFocus(page)
      await page.waitForTimeout(3_000)
      expect((await screens(page)).title, 'the title screen is up').toBe(true)
      await verify(page, ledger, testInfo, `title ${edition}`, 'title')

      // A leaves the title for the hangar — one press, one screen.
      await pressTitleRow(page, TITLE_ROW.hangar) // DEV-441: Single Player, then Hangar
      await expect
        .poll(async () => (await screens(page)).hangar, {
          timeout: 60_000,
          message: 'the hangar never came up',
        })
        .toBe(true)
      await page.waitForTimeout(4_000)
      await verify(page, ledger, testInfo, `title ${edition}`, 'hangar')
    })

    for (const world of WORLDS) {
      test(`${world.mission} (${world.note}) · ${edition} · cockpit, then third person`, async ({
        page,
      }, testInfo) => {
        const ledger = watchShaderConsole(page)
        await flyToFreeze(page, {
          mission: world.mission,
          edition,
          snapAt: SNAP_AT,
          params: PIN_PARAMS,
        })
        const arm = `${world.mission} ${edition}`
        await verify(page, ledger, testInfo, arm, 'cockpit')
        await toThirdPerson(page, ledger)
        await verify(page, ledger, testInfo, arm, 'third')
      })
    }
  }

  // DEV-583: the sea's mirror compiles only under ultra on Anniversary, so no
  // arm above builds its variants, and a program nobody built was not checked.
  // The mirror's own pass is asserted to have DRAWN before the sweep, so a
  // green sweep is a sweep of a frame that had it.
  test('int_01_hoverJet · anniversary · ultra, the sea mirror (DEV-583) · cockpit, then third person', async ({
    page,
  }, testInfo) => {
    expect(ULTRA_PIN, 'the ultra pin differs from the pin it was cut from').not.toBe(PIN)
    const ledger = watchShaderConsole(page)
    await flyToFreeze(page, {
      mission: 'int_01_hoverJet',
      edition: 'anniversary',
      snapAt: SNAP_AT,
      params: ULTRA_PARAMS,
    })
    await expect
      .poll(async () => (await seaMirror(page))?.passes ?? 0, {
        timeout: 15_000,
        message: 'the mirror never drew a pass under ultra',
      })
      .toBeGreaterThan(0)
    const mirror = await seaMirror(page)
    console.info(`shader-link ultra: the mirror ${JSON.stringify(mirror)}`)
    expect(mirror?.on, 'ultra on Anniversary opened the mirror').toBe(true)
    expect(mirror?.calls ?? 0, 'the mirror pass drew something').toBeGreaterThan(0)
    const arm = 'int_01_hoverJet anniversary ultra'
    await verify(page, ledger, testInfo, arm, 'cockpit', ULTRA_PIN)
    await toThirdPerson(page, ledger)
    await verify(page, ledger, testInfo, arm, 'third', ULTRA_PIN)
  })

  test('int_01_hoverJet · anniversary · the headset SESSION binding, warmed', async ({
    page,
  }, testInfo) => {
    // Before `goto`: the emulated runtime must own `navigator.xr` before the
    // capability gate probes it during boot.
    await installEmulatedXr(page)
    const ledger = watchShaderConsole(page)
    await flyToFreeze(page, {
      mission: 'int_01_hoverJet',
      edition: 'anniversary',
      snapAt: SNAP_AT,
      params: PIN_PARAMS,
      // REQUIRED with an emulated runtime — `fixtures/freeze.ts` says why.
      xrProbe: true,
    })
    // The premise, in two halves: the page could open a session, and the
    // warm-up therefore built the session's variants. Without both this arm is
    // `int_01_hoverJet · anniversary` again.
    expect(await emulatedXrInstalled(page), 'the emulated runtime took').toBe(true)
    const immersive = await page.evaluate(
      () => (globalThis as unknown as Ff2Global).__ff2.capabilities.immersiveVr,
    )
    expect(immersive, 'the game saw a headset, so the warm-up compiled for one').toBe(true)
    // ── the photograph from this arm is BLACK, and that is not this row ────
    //
    // Under the emulated runtime the flat Anniversary frame draws its 326 calls
    // and shows only the bloom halos and the HUD — on the title as well as
    // here. It is not the session warm: DEV-324's probe switched
    // `alsoDefaultTarget` off and the title stayed black with a program set
    // identical to the `xr=off` one, while Classic under the same runtime
    // draws the valley. So it sits between IWER's in-page `navigator.xr` and
    // the bloom composer, and it is recorded, not fixed, here. It does not
    // touch this arm's question — `LINK_STATUS` is a property of the program,
    // not of a pixel — but it is why the positive half is draw calls and not
    // a picture: a frame can draw 326 calls and show nothing.
    const { sweep } = await verify(page, ledger, testInfo, 'int_01_hoverJet session', 'cockpit')
    expect(
      sessionKeyedPhysical(sweep.keys),
      'lit programs at the session colour space — the variants this arm exists to sweep',
    ).toBeGreaterThan(0)
  })
})
