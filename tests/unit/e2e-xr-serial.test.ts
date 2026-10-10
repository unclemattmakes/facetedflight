/**
 * tests/unit/e2e-xr-serial.test.ts — every spec that takes the pre-granted XR
 * browser must be in the one-worker project, and the profile must stay shared.
 *
 * ── What went wrong (DEV-265) ────────────────────────────────────────────
 *
 * `tests/e2e/fixtures/xr-browser.ts` launches a PERSISTENT Chrome context on
 * `%TEMP%\ff2-xr-profile`, because the immersive-session consent is browser
 * chrome and the only unattended way past it is a `vr` content grant written
 * into a profile on disk. Chrome allows one instance per profile directory. So
 * under `playwright.config.ts`'s `workers: 4` the second spec to start dies:
 *
 *     browserType.launchPersistentContext: Opening in existing browser
 *     session. This usually means that the profile is already in use by
 *     another instance of Chromium.
 *
 * Four specs did exactly that in a full `pnpm e2e` run on 2026-09-21. They had
 * been green whenever the scheduler happened to keep them apart, which is luck
 * and not a property — and luck of that kind gets quieter as the suite grows,
 * not louder.
 *
 * ── Why this is a test and not a comment ─────────────────────────────────
 *
 * The fix is `XR_SERIAL_SPECS` in `playwright.config.ts`: a list of filenames
 * that the `xr-serial` project matches and the `chromium` project ignores. **A
 * hand-kept list of filenames is precisely the thing this repo keeps paying
 * for** — the next spec to `import { test } from './fixtures/xr-browser'` will
 * not add itself, it will simply rejoin the parallel pool and be flaky. So the
 * membership rule is derived here from the imports on disk and compared against
 * the config, which is an oracle outside the config rather than the config
 * agreeing with itself.
 *
 * `inflight-compile.spec.ts` is why the rule has no exceptions. It takes that
 * browser only under `COMPILE_XR=1` and the flat one otherwise; the config
 * could read that variable and deliberately does not, because a rule that holds
 * on Tuesdays is not a rule.
 *
 * ── And the guard against the tempting repair ────────────────────────────
 *
 * The obvious fix is a directory per spec, and it is the wrong one: the
 * directory is a throwaway holding one grant, while the thing actually being
 * shared is the VRto3D virtual HMD behind it — one OpenXR runtime, one SteamVR
 * compositor, one GPU. Per-spec profiles would move the collision from the
 * launch, where it is loud, to the runtime, where it is a `NotSupportedError`
 * mid-session or just a wrong number. `profile is not per-worker` below fails
 * if somebody reaches for it anyway, and sends them here for the reason.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import config, { XR_SERIAL_SPECS } from '../../playwright.config'
import { REPO as ROOT } from './helpers/repo-root'

const E2E_DIR = path.join(ROOT, 'tests', 'e2e')
const FIXTURE = path.join(E2E_DIR, 'fixtures', 'xr-browser.ts')

/** Strip comments so a spec that merely MENTIONS the fixture is not counted. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** Every `*.spec.ts` directly under `tests/e2e/`. */
const specFiles = (): string[] =>
  fs
    .readdirSync(E2E_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.spec.ts'))
    .map((e) => e.name)
    .sort()

/**
 * The specs that import the persistent-profile fixture — matched on the module
 * SPECIFIER, not on a binding name, because `inflight-compile.spec.ts` imports
 * it as `test as xrTest` and the next one will pick its own alias.
 */
const specsImportingXrBrowser = (): string[] =>
  specFiles().filter((name) =>
    /from\s*['"]\.\/fixtures\/xr-browser['"]/.test(
      stripComments(fs.readFileSync(path.join(E2E_DIR, name), 'utf8')),
    ),
  )

const projectNamed = (name: string) => config.projects?.find((p) => p.name === name)

/** `testMatch` / `testIgnore` are `string | RegExp | (string|RegExp)[]`. */
const asPatternList = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string').sort()

describe('the XR e2e specs run one at a time', () => {
  it('the fixture this is all about still exists', () => {
    // The loud counterpart: every assertion below is vacuously true if the
    // fixture was renamed and the import regex stopped matching anything, and a
    // guard that can pass by finding nothing is the shape that rots for months.
    expect(fs.existsSync(FIXTURE), `${FIXTURE} is gone — this guard is now blind`).toBe(true)
    expect(specsImportingXrBrowser().length).toBeGreaterThan(0)
  })

  it('every spec that imports the fixture is in XR_SERIAL_SPECS', () => {
    const derived = specsImportingXrBrowser()
    const configured = [...XR_SERIAL_SPECS].sort()
    expect(
      derived,
      'a spec imports tests/e2e/fixtures/xr-browser but is not in XR_SERIAL_SPECS in ' +
        'playwright.config.ts, so it is back in the four-worker pool and will fight the other ' +
        'XR specs for %TEMP%\\ff2-xr-profile. Add it to that list. Membership is "imports the ' +
        'fixture", with no exceptions — see the list\'s comment for why COMPILE_XR is not one.',
    ).toEqual(configured)
  })

  it('the xr-serial project is limited to one worker', () => {
    const xr = projectNamed('xr-serial')
    expect(xr, 'no project named xr-serial in playwright.config.ts').toBeDefined()
    expect(
      xr?.workers,
      'xr-serial exists but is not limited to one worker, which is the whole of the fix',
    ).toBe(1)
    // Against the DERIVED set, not against `XR_SERIAL_SPECS` — comparing the
    // project to the constant it was built from is the config agreeing with
    // itself, and would stay green with a hand-typed list beside it.
    expect(
      asPatternList(xr?.testMatch),
      'xr-serial matches a different set of files than the specs that import the fixture',
    ).toEqual(specsImportingXrBrowser())
  })

  it('the chromium project ignores them, so they cannot also run in parallel', () => {
    const chromium = projectNamed('chromium')
    expect(chromium, 'no project named chromium in playwright.config.ts').toBeDefined()
    expect(
      asPatternList(chromium?.testIgnore),
      'chromium does not ignore the XR specs, so each one runs in BOTH projects — which is the ' +
        'original collision plus a second copy of every test',
    ).toEqual(specsImportingXrBrowser())
  })

  it('the profile is not per-worker', () => {
    const src = stripComments(fs.readFileSync(FIXTURE, 'utf8'))
    for (const token of ['workerIndex', 'parallelIndex', 'mkdtemp', 'randomUUID']) {
      expect(
        src.includes(token),
        `xr-browser.ts uses ${token}: a profile directory per worker makes the launch error go ` +
          'away without removing what is actually shared — one OpenXR runtime, one SteamVR ' +
          "compositor, one GPU. Serialize instead; see this file's header.",
      ).toBe(false)
    }
  })
})
