/**
 * tests/e2e/fixtures/emulated-xr.ts — a headset made of JavaScript.
 *
 * ── Why this is a fixture and not a `src/` switch ────────────────────────
 *
 * CLAUDE.md's hard line is that the harness may do extra things, but the GAME
 * may not take a different path to get green. This obeys it in the strongest
 * available form: **nothing under `src/` knows this exists.** IWER installs a
 * synthetic `navigator.xr` before the page's first script runs, and the app
 * then takes its own real XR path — `requestSession`, `XRWebGLLayer`, the two
 * eye cameras, `renderer.xr.setAnimationLoop` — against a runtime that happens
 * not to be a headset. It is the opposite of a test shortcut: every flat spec
 * in this suite drives the mono path that no player uses, and this one drives
 * the stereo path that every player does.
 *
 * ── What it can and cannot measure, which is the whole point ─────────────
 *
 * IWER is an in-page emulator. It renders to the canvas — `XRWebGLLayer`'s
 * `framebuffer` is null — and it drives frames from `globalThis.requestAnimationFrame`.
 * So it reproduces, faithfully:
 *
 *   * TWO views per frame, hence the real stereo draw-call and triangle count;
 *   * the real per-eye projection and viewport split;
 *   * the app's own CPU and GPU cost for submitting that frame.
 *
 * And it cannot see, at all:
 *
 *   * the compositor — no swapchain, no reprojection, no 45/30 Hz tier;
 *   * the Steam Frame's video encoder, which shares this laptop's GPU;
 *   * anything that happens between our last GL call and the photons.
 *
 * That gap is not a flaw to be worked around, it is the measurement's shape.
 * The worn capture of 2026-09-19 spent a mean of **20.9 ms per hitch frame**
 * outside anything `perf-trace.ts` instruments; none of that will appear here.
 * Read this route for the app's half and `docs/testing/perf-protocol.md` §4 —
 * SteamVR's own frame timing — for the other. The VRto3D route in splattool's
 * `docs/fake-headset.md` is the one that covers both.
 *
 * ── Three things that cost somebody an afternoon each ────────────────────
 *
 * 1. **`installRuntime()` does nothing in a real browser without
 *    `{ forceInstall: true }`.** IWER declines to replace a native
 *    `navigator.xr`, warns to the console, and returns. The page then talks to
 *    Chrome's own WebXR, which refuses an immersive session because no headset
 *    is attached — and the error names the session configuration, not the
 *    runtime, so it points in the wrong direction. Forced here, and then
 *    checked, because a silent failure earned the check.
 * 2. **The RUNTIME picks the resolution, not the renderer.** On session start
 *    IWER sets `canvas.width = window.innerWidth` and `canvas.height =
 *    window.innerHeight` — CSS pixels, ignoring `devicePixelRatio` — and builds
 *    both viewports from the canvas. So the per-eye size is
 *    `(viewport.width / 2) x viewport.height` and a `deviceScaleFactor` does
 *    NOT multiply it. Set the viewport to the side-by-side size you want.
 * 3. **Mono still reports two views**, the right one with a zero-width
 *    viewport. `stereoEnabled` is therefore not optional here: without it the
 *    frame is mono and the doubling this fixture exists to measure is absent.
 *
 * *(Mechanism read from `iwer@2.4.0` source and from splattool's
 * `docs/fake-headset.md`, which built and ran this route against polyfish on
 * 2026-09-09.)*
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type Page = import('@playwright/test').Page

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * The UMD build, which sets `globalThis.IWER`. The package's `main` is ESM
 * `lib/index.js`, which an init script cannot `import` — so the standalone
 * bundle is the one that goes in.
 */
export const IWER_BUNDLE = path.resolve(HERE, '../../../node_modules/iwer/build/iwer.js')

export interface EmulatedXrOptions {
  /**
   * Interpupillary distance, metres. IWER places the eyes at `+/- ipd/2` along
   * the view's X. 0.063 is its own default and the population median.
   */
  readonly ipd?: number
  /** Vertical field of view, DEGREES (IWER wants radians; converted here). */
  readonly fovyDeg?: number
  /**
   * Keep IWER's Quest 3 user agent instead of the browser's own. DEV-330.
   *
   * Off by default, because the target is the Steam Frame, which runs DESKTOP
   * Chrome, and a UA is not inert: three sniffs `OculusBrowser` and takes a
   * different framebuffer path on it (`supportsInvalidateFramebuffer`). With
   * IWER's UA every emulated run exercised the Quest path, and the flat
   * Anniversary frame rendered black for exactly that reason. On only for a
   * spec that means to test the Quest path.
   */
  readonly questUserAgent?: boolean
}

/**
 * Install the emulated runtime. **Call before `page.goto`** — IWER has to own
 * `navigator.xr` before the app's first script reads it, and FF2 reads it early
 * (the capability gate probes `isSessionSupported` during boot).
 */
export const installEmulatedXr = async (
  page: Page,
  opts: EmulatedXrOptions = {},
): Promise<void> => {
  await page.addInitScript({ path: IWER_BUNDLE })
  await page.addInitScript(
    ({ ipd, fovyDeg, questUserAgent }) => {
      const iwer = (globalThis as unknown as { IWER?: Record<string, unknown> }).IWER
      if (!iwer) throw new Error('emulated-xr: the IWER bundle did not define globalThis.IWER')
      const XRDevice = iwer.XRDevice as new (
        config: unknown,
        options: Record<string, unknown>,
      ) => Record<string, unknown>
      // The browser's own UA, read BEFORE the runtime installs and replaces it.
      const config = questUserAgent
        ? iwer.metaQuest3
        : { ...(iwer.metaQuest3 as Record<string, unknown>), userAgent: navigator.userAgent }
      const device = new XRDevice(config, {
        // Not optional: mono gives the right eye a zero-width viewport and the
        // frame draws once. The doubling is the measurement.
        stereoEnabled: true,
        ipd,
        fovy: (fovyDeg * Math.PI) / 180,
      })
      ;(device.installRuntime as (o: { forceInstall: boolean }) => void)({ forceInstall: true })
      // Hand the device to the spec so a pose can be driven, and record what we
      // asked for so a failure can say which knob was wrong.
      ;(globalThis as unknown as Record<string, unknown>).__emulatedXR = { device, ipd, fovyDeg }
    },
    {
      ipd: opts.ipd ?? 0.063,
      fovyDeg: opts.fovyDeg ?? 90,
      questUserAgent: opts.questUserAgent ?? false,
    },
  )
}

/**
 * Did the runtime actually take? Asks the question that matters — can this page
 * open an immersive session — rather than comparing object identities, because
 * the failure mode is a page quietly talking to Chrome's own WebXR.
 */
export const emulatedXrInstalled = async (page: Page): Promise<boolean> =>
  page.evaluate(async () => {
    const marked = (globalThis as unknown as Record<string, unknown>).__emulatedXR !== undefined
    const supported = await navigator.xr?.isSessionSupported?.('immersive-vr')
    return marked && supported === true
  })

/**
 * The per-eye size this viewport will produce, given IWER's rule that the
 * canvas becomes `innerWidth x innerHeight` and stereo splits it down the
 * middle. Stated as a function so a spec can assert against it rather than
 * restating the arithmetic — and so the one place that knows the rule is the
 * one place that documents it.
 */
export const perEyeSize = (viewport: { width: number; height: number }) => ({
  width: Math.floor(viewport.width / 2),
  height: viewport.height,
})
