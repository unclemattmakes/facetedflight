/**
 * tests/e2e/xr-emulated-perf.spec.ts — does a headset made of JavaScript
 * measure the same frame a worn one does?
 *
 * ── The question, and why it is answerable today ─────────────────────────
 *
 * Every performance number this port has is either flat-screen (mono, one
 * camera, half the geometry) or worn (stereo, and only while somebody is
 * wearing it). The first is cheap and measures a frame nobody plays; the
 * second is the truth and costs a human being an evening.
 *
 * ── The anchor, and why it is a FILE and not this spec's own other arm ───
 *
 * CLAUDE.md: *a test that compares two of your own devices has not tested
 * either of them.* An emulated-mono against an emulated-stereo arm is exactly
 * that shape — it would stay green with both wrong. So the comparison is
 * against `tools/perf/census-baseline.json`, which was recorded by a different
 * spec, on the flat path, at a pinned mission tick, and lives on disk:
 *
 *   rookie_01_hoverJet / anniversary @ 20 s, FLAT and mono:
 *   **96 draw calls, 4,822,795 triangles**
 *
 * and the worn capture of 2026-09-19 (2763 frames, `perf-out/capture/`) read
 * **calls p50 198, ~9.69 M triangles** — the flat frame doubled, because stereo
 * draws the world twice.
 *
 * ── Matching the frustum, which is the whole of the setup ────────────────
 *
 * IWER builds each eye as `perspective(fovy, aspect)` with
 * `aspect = width x (stereo ? 0.5 : 1) / height` over a canvas it sets to
 * `innerWidth x innerHeight`. The census ran at Playwright's default
 * **1280 x 720** with the app's own **70 deg** vertical FOV. So a **2560 x 720**
 * viewport gives each eye exactly 1280 x 720 at aspect 1.778, and `fovyDeg: 70`
 * makes the per-eye frustum the census's frustum. Then the stereo count should
 * be two of the number in that file, and any drift is the emulator's.
 *
 * A first run at `fovyDeg: 90` read **2.93x** instead of 2x — a wider cone
 * passes more world through the frustum cull. That is not a bug in the route,
 * it is the route being sensitive to exactly the parameter it should be
 * sensitive to, and it is why the FOV and the per-eye size are asserted here
 * rather than assumed.
 *
 * ── The half this route cannot see ───────────────────────────────────────
 *
 * IWER has no compositor. The worn capture's defining features — dt quantised
 * to 2x and 3x the display interval, a 45 Hz reprojection tier, and a mean
 * 20.9 ms per hitch frame outside anything we instrument — are all the
 * compositor's, and none of them appear here. A GPU time from this route is the
 * app's own submission cost and nothing else. The VRto3D route in splattool's
 * `docs/fake-headset.md` is the one that covers both halves.
 */
import fs from 'node:fs'
import path from 'node:path'
import { emulatedXrInstalled, installEmulatedXr, perEyeSize } from './fixtures/emulated-xr'
import type { Ff2PerfGlobalMaybe } from './fixtures/ff2'
import { flyToFreeze } from './fixtures/freeze'
import { enterVr, titleVr } from './fixtures/landing'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

const MISSION = 'rookie_01_hoverJet'
const EDITION = 'anniversary'
const SNAP_AT = 20

/** The app's own flat vertical FOV (`render/renderer.ts`: `new PerspectiveCamera(70, ...)`). */
const FOVY_DEG = 70

/** 2560 / 2 = 1280 per eye, x 720 — the census's own frame. */
const VIEWPORT = { width: 2560, height: 720 }

test.use({ viewport: VIEWPORT, deviceScaleFactor: 1 })

interface Info {
  readonly calls: number
  readonly triangles: number
  readonly programs: number
}

const readInfo = (page: Page): Promise<Info | null> =>
  page.evaluate(() => {
    const perf = (globalThis as unknown as Ff2PerfGlobalMaybe).__ff2perf
    return (perf?.info?.() ?? null) as Info | null
  })

/** The stored flat census for this mission, read rather than restated. */
const censusBaseline = (): { calls: number; triangles: number } => {
  const file = path.resolve('tools/perf/census-baseline.json')
  const all = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
    string,
    { totalCalls: number; triangles: number }
  >
  const entry = all[`${MISSION}/${EDITION}@${SNAP_AT}`]
  if (!entry) throw new Error(`no census baseline for ${MISSION}/${EDITION}@${SNAP_AT} in ${file}`)
  return { calls: entry.totalCalls, triangles: entry.triangles }
}

test.describe('@measure @gpu emulated headset', () => {
  // A launch, a flight to the 20 s mark, a session handshake and a settle. The
  // 30 s default is not close.
  test.setTimeout(240_000)

  test('a stereo session draws the census frame twice', async ({ page }) => {
    const log: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') log.push(m.text())
    })

    // Before any navigation: FF2 probes `isSessionSupported` during boot, and a
    // runtime installed after that is a runtime the app never saw. `addInitScript`
    // survives the navigation `flyToFreeze` does.
    await installEmulatedXr(page, { ipd: 0.063, fovyDeg: FOVY_DEG })
    await flyToFreeze(page, {
      mission: MISSION,
      edition: EDITION,
      snapAt: SNAP_AT,
      params: { perf: '1' },
      // ── DEV-265: without this the button below can NEVER enable ──────────
      //
      // `flyToFreeze` loads with `xr=off` by default, and `xr=off` does not
      // answer the capability question — it SKIPS it. `capability-gate.ts`
      // then leaves `immersiveVr` false, `main.ts` only registers the
      // `onLoadProgress` handler that clears `#enter-vr`'s `disabled` inside
      // `if (app.capabilities.immersiveVr)`, and the button stays greyed with
      // the title *"This browser reports no immersive-vr support."* for the
      // life of the page. So this spec installed a working headset and then
      // told the page not to look for one, and waited 90 s for a button that
      // was never going to move. It had never passed.
      //
      // Safe here and nowhere else in this suite: `installEmulatedXr` above
      // replaced `navigator.xr` with IWER's, so the probe is JavaScript and
      // does not start this box's OpenXR runtime.
      xrProbe: true,
    })

    expect(
      await emulatedXrInstalled(page),
      `the emulated runtime did not take; the page is still on Chrome's own WebXR.\n${log.join('\n')}`,
    ).toBe(true)

    // The runtime, not the renderer, picks the resolution — so if the window
    // could not be made this wide, every count below is of a different frustum
    // and the run is void rather than merely odd.
    const inner = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    expect(
      inner,
      `the viewport did not land: IWER sizes the canvas from innerWidth/innerHeight, so a clamped ` +
        `window silently changes the per-eye frustum. wanted ${VIEWPORT.width}x${VIEWPORT.height}`,
    ).toEqual({ w: VIEWPORT.width, h: VIEWPORT.height })

    // FLAT, on the frozen frame, before the session exists. Same page, same
    // world, one camera.
    const flat = await readInfo(page)
    expect(flat, 'no flat reading through __ff2perf.info()').not.toBeNull()

    // ── say the precondition out loud, rather than time out on it ─────────
    //
    // A page that offers no way into a session has two causes that want
    // opposite fixes: it was told not to probe, or it probed and the runtime
    // said no. Ninety seconds of waiting distinguishes neither, so this reads
    // them first. Since DEV-557 the answer is the ENTER VR state
    // (`__ff2.titleMenu().vr.state`), which lives for the whole page and not
    // only on the title: `off` under `?xr=off`, `connect` for a no.
    const gate = await page.evaluate(() => ({ search: globalThis.location.search }))
    expect(
      gate.search.includes('xr=off'),
      `loaded with xr=off (${gate.search}): the capability probe was skipped, so there is no ` +
        'headset for the life of the page and no timeout will change that. Pass `xrProbe: true` ' +
        'to `flyToFreeze`; see DEV-265.',
    ).toBe(false)
    await expect
      .poll(async () => (await titleVr(page))?.state ?? null, {
        message:
          'ENTER VR never said a headset is there. The probe DID run, so the emulated runtime ' +
          "answered no to isSessionSupported('immersive-vr'); check that installEmulatedXr took " +
          'before the navigation.',
        timeout: 90_000,
      })
      .toBe('enter')

    // ── and the way in is reachable from here, which it never was ─────────
    //
    // DEV-265 measured this spec's second precondition FALSE: `flyToFreeze`
    // pressed the landing card's Start, which hid the card the Enter VR button
    // lived in, and nothing but `sessionend` put it back (DEV-206), so a page
    // that had pressed Start could not enter a session without a reload. The
    // card is gone (DEV-557), and the way in from a course is H, the ENTER VR
    // plate's key hint, from any flat screen: what `enterVr` presses here,
    // with no reload and the frozen frame kept.
    await enterVr(page)

    // `renderer.xr.setAnimationLoop` replaces the flat loop; until frames come
    // from the SESSION's loop, `renderer.info` still holds the last flat frame.
    // Poll for the count to CHANGE rather than merely to exist.
    await expect
      .poll(async () => (await readInfo(page))?.calls ?? 0, { timeout: 60_000 })
      .not.toBe(flat?.calls)

    // Settle, then take a median: the world is frozen but the render clock is
    // not, so clouds, motes and LOD fades still move a little.
    await page.waitForTimeout(2000)
    const samples: Info[] = []
    for (let i = 0; i < 9; i++) {
      const info = await readInfo(page)
      if (info) samples.push(info)
      await page.waitForTimeout(200)
    }
    expect(samples.length, 'no frames arrived from the session loop').toBeGreaterThan(6)

    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
    const calls = median(samples.map((s) => s.calls))
    const triangles = median(samples.map((s) => s.triangles))
    const programs = median(samples.map((s) => s.programs))
    const base = censusBaseline()
    const eye = perEyeSize(VIEWPORT)

    console.info(
      `\nemulated headset — ${MISSION} ${EDITION}, frozen at ${SNAP_AT} s, ` +
        `${eye.width} x ${eye.height} per eye at ${FOVY_DEG} deg\n` +
        `  stored flat census   ${String(base.calls).padStart(4)} calls   ${(base.triangles / 1e6).toFixed(2)} M tris\n` +
        `  this page, flat      ${String(flat?.calls).padStart(4)} calls   ${((flat?.triangles ?? 0) / 1e6).toFixed(2)} M tris   (${VIEWPORT.width}x${VIEWPORT.height}, one camera)\n` +
        `  this page, STEREO    ${String(calls).padStart(4)} calls   ${(triangles / 1e6).toFixed(2)} M tris   ${programs} programs\n` +
        `  stereo / census      x${(calls / base.calls).toFixed(2)} calls   x${(triangles / base.triangles).toFixed(2)} tris\n` +
        `  worn capture 2026-09-19:  198 calls   9.69 M tris   78 programs`,
    )

    // ── The gate: two of the census frame ─────────────────────────────────
    //
    // A mono session lands near 1.0 and is the failure this exists to catch —
    // IWER's default is `stereoEnabled: false` and it reports two views either
    // way, the right one merely zero-width. The band is generous because the
    // census is a different run: `?snap=` pins the sim, not the render clock,
    // so cloud, mote and LOD-fade draws differ by a few calls between runs.
    expect(triangles / base.triangles, 'stereo should draw the census frame twice').toBeGreaterThan(
      1.85,
    )
    expect(triangles / base.triangles).toBeLessThan(2.15)
    expect(calls / base.calls, 'stereo should issue twice the census draw calls').toBeGreaterThan(
      1.7,
    )
    expect(calls / base.calls).toBeLessThan(2.4)
  })
})
