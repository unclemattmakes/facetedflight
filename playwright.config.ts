import fs from 'node:fs'
import { defineConfig, devices } from '@playwright/test'
import { E2E_CHANNEL, E2E_HOST, E2E_PORT } from './tests/e2e/fixtures/server'

// Faceted Flight 2 — Playwright config.
//
// The suite owns its own dev server on a pinned port and talks to it over
// HTTPS. Both of those are deliberate; see the notes below and
// docs/vr-testing.md.

// ── Headless on the real GPU by default, headed for measurements ─────────
// Bundled Chromium headless falls back to SwiftShader (software WebGL2), about
// 1 fps on this game, which is why the suite ran headed. SYSTEM Chrome (the
// default channel) headless does not: measured 2026-10-07 (TIERS.md, "Headless
// on the real GPU") it reports the RTX 5050 through ANGLE D3D11, the same p50
// frame time as headed, a heavier tail, and pointer lock and focus specs pass.
// So (Matt, 2026-10-07: the suite "hogs my machine") a BEHAVIOUR run is
// headless and no window takes focus; a MEASURE run (`E2E_MEASURE=1`, or a
// named @measure spec) stays headed, because its numbers are frame times; and
// an empty E2E_CHANNEL (bundled Chromium) is always headed, never SwiftShader.
// E2E_HEADLESS=0 or 1 overrides.

// One copy of host, port and channel, shared with the specs that open their own
// browser: tests/e2e/fixtures/server.ts.
const host = E2E_HOST
const port = E2E_PORT

// ── Which browser binary ─────────────────────────────────────────────────
// Playwright's bundled Chrome-for-Testing build does not start on this
// machine. Verified 2026-09-09 by running it directly:
//
//   chrome.exe --version
//   -> "The application has failed to start because its side-by-side
//       configuration is incorrect."
//
// and via Playwright as `browserType.launch: spawn UNKNOWN` on all 14 specs.
// king-tide hit the same class of failure on Windows. So on Windows we default
// to the installed system Chrome — same engine, real GPU. Overrides:
//
//   E2E_CHANNEL=msedge   use Edge instead
//   E2E_CHANNEL=         (empty) force Playwright's bundled Chromium
//
// CI (Linux) keeps the bundled build, which is the point of bundling it.
const channel = E2E_CHANNEL

// ── E2E_NO_VSYNC=1 — lift the refresh cap, for MEASUREMENT RUNS ONLY ─────
//
// DEV-255. This box presents at 180 Hz and Chrome honours it, so **every `dt`
// this project has ever taken flat is quantised to 5.55 ms**: over 3,969
// frames of `perf-out/reveal-2026-09-20/rookie01-ticks.csv`, 3,961 are exactly
// one interval and the mean deviation from a multiple of 5.55 ms is 0.066.
// A cost smaller than the interval cannot appear in a frame delta at all — the
// HUD's steady-state cost reads as **0.00 ms** flat, with p50 5.60 and p95
// 5.70 on BOTH arms of a live-vs-freeze pair, purely because the frame has
// ~3.5 ms of slack for it to hide in.
//
// **Off by default, and it must stay off by default**, for a reason that is
// not caution: a headset is vsync-locked too, so the capped regime is the one
// a player is in and an uncapped number does not describe it. What uncapping
// buys is RESOLUTION — and the regime it creates is arguably the nearer of the
// two to worn, because a worn frame is 11.51 ms against a 90 Hz budget of
// 11.11 and therefore has no slack either.
//
// So it is an instrument, switched on deliberately for a row that needs
// sub-interval resolution, and **any number taken under it is labelled**. It
// changes nothing about the build: the GAME is byte-identical and every
// measuring row already pins `?adaptive=0`, so `quality.ts` cannot react to
// the different pacing. That is the line CLAUDE.md draws — the harness may do
// something extra, the game may not be different.
const noVsyncArgs =
  process.env.E2E_NO_VSYNC === '1' ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []

// ── CI vs local ──────────────────────────────────────────────────────────
// Specs that need a real GPU (frame timing, shader output, screenshot diffs)
// must be tagged `@gpu` in their title or `test.describe` tag, because a
// GitHub-hosted runner has no GPU and would only produce red noise — the exact
// trap king-tide documented. A CI job then runs:
//
//   E2E_HEADLESS=1 E2E_SKIP_GPU=1 pnpm e2e
//
// **That was written on 2026-09-09 when no spec carried the tag, and it said
// "E2E_SKIP_GPU is a no-op today and the whole suite is CI-safe". Both halves
// are now false and the sentence was still here on 2026-09-13.**
//
// Measured that day: `pnpm exec playwright test --list` gives **52 tests in 18
// files**, and with `E2E_SKIP_GPU=1` it gives **17 tests in 4 files**. The flag
// removes 67% of the tests and 78% of the spec files, because 15 of the 18
// now need a GPU, hydrated `public/assets/`, or both.
//
// So `E2E_SKIP_GPU=1` is a CI-shaped subset, NOT a full run, and a green one
// proves much less than it looks like it proves. A session nearly shipped on a
// 17-test run believing it had done 52. **Before quoting an e2e number, derive
// it:**
//
//   pnpm exec playwright test --list | tail -1
//   E2E_SKIP_GPU=1 pnpm exec playwright test --list | tail -1
//
// This is the same failure the repo keeps paying for — a comment that goes on
// answering the question it was written for. It is prose, so nothing tests it;
// the derivation above is the only authority.

// ── Two tiers: BEHAVIOUR runs always, @measure runs on demand ────────────
//
// Matt, 2026-10-07: "our e2e testing feels excessive to me in terms of how long
// it takes and how much it hogs my machine." Every test is one of two kinds
// (docs/testing/TIERS.md has the table, a row per spec, and a unit test holds
// the table to the tags):
//
//   BEHAVIOUR  presses or drives something and asserts what the game did.
//              Runs in every gate.
//   @measure   a measurement, a census, an A/B, a photograph taken to make a
//              look call, or a one-question investigation. Skipped unless
//              E2E_MEASURE=1 (`pnpm e2e:all`, `pnpm e2e:measure`, the release
//              gate), or unless you NAME the spec: `playwright test perf-fill`
//              runs it, because a spec asked for by name that silently
//              collects zero tests would read as a pass.
//
// The tag is in the test.describe title, like @gpu, so `--list` and
// `--grep @measure` see it. Nothing about the game or any assertion changes.
const namedMeasureSpec = (): boolean => {
  const args = process.argv.slice(2)
  const at = args.indexOf('test')
  if (at < 0) return false
  const asked = args.slice(at + 1).filter((a) => a && !a.startsWith('-'))
  if (asked.length === 0) return false
  const dir = './tests/e2e'
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.spec.ts'))
    .some(
      (f) =>
        asked.some((a) => f.includes(a)) &&
        fs.readFileSync(`${dir}/${f}`, 'utf8').includes('@measure'),
    )
}
const wantMeasure = process.env.E2E_MEASURE === '1' || namedMeasureSpec()
const headless =
  process.env.E2E_HEADLESS === '1'
    ? true
    : process.env.E2E_HEADLESS === '0'
      ? false
      : !wantMeasure && channel !== undefined && channel !== ''
const skipped = [
  ...(process.env.E2E_SKIP_GPU === '1' ? ['@gpu'] : []),
  ...(wantMeasure ? [] : ['@measure']),
]
const grepInvert = skipped.length ? new RegExp(skipped.join('|')) : undefined

// ── The XR specs share ONE Chrome profile, and one virtual headset ───────
//
// DEV-265. `tests/e2e/fixtures/xr-browser.ts` launches a PERSISTENT context on
// `%TEMP%\ff2-xr-profile`, because Chrome's immersive-session consent is
// browser chrome that no automation can click and the only way through it
// unattended is to pre-grant the `vr` content setting in a profile on disk.
// Chrome allows exactly one instance per profile directory, so under
// `workers: 4` every spec but the first dies at launch with
//
//     browserType.launchPersistentContext: Opening in existing browser
//     session. This usually means that the profile is already in use by
//     another instance of Chromium.
//
// Observed 2026-09-21 in a full `pnpm e2e` run — 218 tests, 4 workers. They
// were green before that only when the scheduler happened to keep them apart,
// which is luck and not a property.
//
// **The fix is serialization. Giving each spec its own profile directory would
// be the wrong one** — it looks cleaner and it is worse. The directory is not
// the scarce thing: it is a throwaway holding one content-setting grant, and
// `writeXrGrant` rewrites it on every launch. The scarce thing is BEHIND it.
// These specs drive a VRto3D virtual HMD, which is machine-global — one
// registered OpenXR runtime (`forcedDriver: "vrto3d"`), one SteamVR
// compositor, one GPU. Per-spec profiles would let two Chromes past the launch
// and set them fighting over the runtime instead, which turns a loud failure at
// second zero into a `NotSupportedError` mid-session — or, worse, into a perf
// number that is merely wrong. Duplicating the profile hides the singleton; it
// does not remove it.
//
// `test.describe.configure({ mode: 'serial' })` cannot reach this either: it
// orders tests WITHIN one file, and these are five files, which Playwright
// hands to five workers. `testProject.workers` does reach it, and Playwright's
// own documentation for that option describes this exact case — *"when all
// tests from a project share a single resource ... limiting workers to one for
// such a project will prevent simultaneous use of the shared resource."* The
// global cap still applies, so `xr-serial` takes one of the four workers and
// the rest of the suite keeps running four-wide beside it.
//
// Membership is one sentence with no exceptions: **a spec that imports
// `fixtures/xr-browser` is in this project.** `inflight-compile.spec.ts` takes
// that browser only under `COMPILE_XR=1` and the flat browser otherwise — the
// config could read that env var, and deliberately does not, because a rule
// that holds on Tuesdays is not a rule. `tests/unit/e2e-xr-serial.test.ts`
// derives the set from the imports on disk and fails when this list and the
// tree disagree, because a hand-kept list of filenames is exactly the thing
// this repo keeps paying for.
//
// Bare basenames are the right pattern: `createFileMatcher` prefixes `**/` to
// any string that does not already start with it, then minimatches the native
// path.
export const XR_SERIAL_SPECS = [
  'inflight-compile.spec.ts',
  'xr-eye-height.spec.ts',
  'xr-viewport-scale-probe.spec.ts',
  'xr-vrto3d-probe.spec.ts',
  'xr-vrto3d-trace.spec.ts',
  'xr-multiview.spec.ts',
]

export default defineConfig({
  testDir: './tests/e2e',
  // Fail fast (Matt, 2026-10-07): a test that has not finished in 90 s is hung,
  // not slow. A spec that really needs longer says so itself with
  // test.setTimeout / describe.configure({ timeout }), which wins over this.
  timeout: 90_000,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? 'github' : 'list',
  ...(grepInvert ? { grepInvert } : {}),
  use: {
    // https, not http: the dev server runs behind @vitejs/plugin-basic-ssl so
    // that WebXR works from the LAN. The cert is self-signed, hence
    // ignoreHTTPSErrors.
    baseURL: `https://${host}:${port}`,
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
    headless,
  },
  projects: [
    {
      name: 'chromium',
      // Not merely "these run elsewhere too": without the ignore they would run
      // in BOTH projects, which is the collision again with an extra copy of it.
      testIgnore: XR_SERIAL_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        ...(channel ? { channel } : {}),
        // Empty unless `E2E_NO_VSYNC=1`, so the default launch is untouched.
        ...(noVsyncArgs.length ? { launchOptions: { args: noVsyncArgs } } : {}),
      },
    },
    {
      // One worker, one profile, one virtual headset — see XR_SERIAL_SPECS.
      name: 'xr-serial',
      testMatch: XR_SERIAL_SPECS,
      workers: 1,
      // The same `use` as `chromium`, because `baseURL` and `viewport` are read
      // from it by the fixture. `channel` and `launchOptions` are NOT: the
      // fixture builds its own launch, and carries its own copy of the channel
      // rule. Kept here anyway so the two projects do not read as different
      // browsers — and so that when the fixture stops building its own launch,
      // this project is already right.
      use: {
        ...devices['Desktop Chrome'],
        ...(channel ? { channel } : {}),
        ...(noVsyncArgs.length ? { launchOptions: { args: noVsyncArgs } } : {}),
      },
    },
  ],
  webServer: {
    // A dedicated port, pinned with --strictPort, so a collision errors out
    // instead of silently attaching the suite to a `pnpm dev` already running.
    command: `pnpm dev --port ${port} --strictPort --host`,
    // Serve content out of the local `public/` tree rather than the R2 custom
    // domain. `assetUrl()` throws at boot when this is unset (deliberately —
    // a loud error beats a black screen), so without it every spec fails on a
    // missing env var rather than on anything it meant to test.
    //
    // Hydrate the tree first: `pnpm assets:pull`, or for terrain specifically
    // `node tools/assets/extract-terrain-maps.mjs`.
    env: { VITE_ASSET_BASE_URL: process.env.VITE_ASSET_BASE_URL ?? '/' },
    url: `https://${host}:${port}`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
