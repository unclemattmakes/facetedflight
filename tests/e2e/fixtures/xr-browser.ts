/**
 * tests/e2e/fixtures/xr-browser.ts — a Chrome that will enter VR unattended.
 *
 * ── The problem ──────────────────────────────────────────────────────────
 *
 * Chrome asks the user to allow an immersive session, and **that prompt is
 * browser chrome, not page content**. No locator reaches it, `page.click`
 * cannot dismiss it, and `page.bringToFront()` does not help — it only puts the
 * bubble somewhere a human can reach, which is exactly why it looked like a fix
 * on 2026-09-19 while a human was in fact pressing Allow each time. Left alone,
 * `requestSession('immersive-vr')` neither resolves nor rejects: it hangs, with
 * the page reporting `visibility: visible` and `focused: true` and nothing in
 * the console.
 *
 * ── What does not work, all verified on Chrome 152 ───────────────────────
 *
 *   * `context.grantPermissions(['xr-spatial-tracking'])` — Playwright keeps its
 *     own allow-list: `Unknown permission`.
 *   * `Browser.setPermission { name: 'xr-spatial-tracking' | 'vr' | 'sensors' }`
 *     — CDP: `Invalid PermissionDescriptor name`.
 *   * `navigator.permissions.query({ name: 'xr-spatial-tracking' })` — the page
 *     itself: `not a valid enum value of type PermissionName`.
 *   * `Browser.grantPermissions { permissions: ['vr'] }` — **accepted**, and
 *     still does not open the session. It is the right vocabulary and the wrong
 *     layer.
 *
 * ── What does ────────────────────────────────────────────────────────────
 *
 * Pre-grant the `vr` CONTENT SETTING for the origin in a Chrome profile on
 * disk, and launch a persistent context on it. Then there is no prompt to
 * answer. This is splattool's solution, arrived at for polyfish captures and
 * carried over here unchanged (`src/adapters/webxr/capture.ts`,
 * `test/integration/check-steamvr.mjs`): *"Pre-granting the `vr` content
 * setting for the origin in a profile is the only way through it unattended."*
 *
 * The profile is a throwaway under the temp dir, rewritten every run, and holds
 * nothing but that grant. It is HARNESS-SIDE: the page runs the same code and
 * takes the same path a player's browser takes, with one dialog already
 * answered the way a player would answer it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type BrowserContext, test as base, chromium, type Page } from '@playwright/test'
import { E2E_CHANNEL } from './server'
import { skipSplash } from './test'

/**
 * Where the pre-granted profile lives. **One per repo, and it must stay that
 * way — do not make this per-spec.** (DEV-265.)
 *
 * Chrome allows one instance per profile directory, so two specs that launch
 * here at once give `launchPersistentContext: Opening in existing browser
 * session`, and under `workers: 4` that is what a full `pnpm e2e` run does.
 * The obvious repair is a directory each. It is the wrong one.
 *
 * This directory is not the scarce resource. It is a throwaway holding a single
 * content-setting grant, rewritten by `writeXrGrant` on every launch — nothing
 * about it is worth protecting. What is scarce sits BEHIND it: every spec that
 * takes this browser drives the VRto3D virtual HMD, and that is machine-global
 * — one registered OpenXR runtime, one SteamVR compositor, one GPU. A
 * directory each would only move the collision from the launch (loud, at second
 * zero) to the runtime (quiet, mid-session, and sometimes just a wrong number).
 *
 * So the profile stays shared and the SCHEDULE is what changed: these specs are
 * the `xr-serial` project in `playwright.config.ts`, which has `workers: 1`.
 * Membership is "imports this file", and `tests/unit/e2e-xr-serial.test.ts`
 * fails when that list and the tree disagree.
 */
export const XR_PROFILE_DIR = path.join(os.tmpdir(), 'ff2-xr-profile')

/**
 * Write the grant. Chrome merges what it needs on top of this at startup, so a
 * minimal Preferences file is enough and is rewritten each run — the profile is
 * a fixture, not state anybody should accumulate.
 */
export const writeXrGrant = (origin: string): void => {
  fs.mkdirSync(path.join(XR_PROFILE_DIR, 'Default'), { recursive: true })
  fs.writeFileSync(
    path.join(XR_PROFILE_DIR, 'Default', 'Preferences'),
    JSON.stringify({
      profile: {
        content_settings: { exceptions: { vr: { [`${origin},*`]: { setting: 1 } } } },
      },
    }),
  )
}

/**
 * Fail NOW, with the rig named, instead of waiting out a `#enter-vr` that
 * already cannot move. (DEV-265.)
 *
 * Every spec that takes this browser then waits 90–120 s for that button. On a
 * box where the VRto3D rig is not installed — which is most of the time, since
 * the Steam Frame is offline while it is — the wait cannot end any other way:
 * `isSessionSupported('immersive-vr')` has already answered false at boot,
 * `main.ts` never registers the handler that clears `disabled`, and the suite
 * spends the timeout proving a fact it had before the first frame.
 *
 * That cost is the reason this exists. Serializing these specs (the `xr-serial`
 * project) was right for the profile and made this worse: three of them used to
 * die instantly at `launchPersistentContext` and now each runs its full wait, in
 * turn, twice under `retries: 1` — about 15 minutes of a 36-minute suite spent
 * discovering that a driver is not installed.
 *
 * **It still FAILS. It does not skip.** Whether a spec that needs a
 * machine-global driver should skip instead is a question about what a green
 * `pnpm e2e` means, and it is not this function's to answer. All this changes is
 * how long the same red takes and whether it says anything.
 *
 * The three outcomes are kept apart on purpose, because collapsing them is how
 * an environment story gets told about a code defect:
 *
 *   * no `navigator.xr` at all → the BROWSER or the build, not the rig;
 *   * the probe threw → reported verbatim, which is neither of the above;
 *   * the probe answered false → no device, and the rig is the first thing to
 *     check.
 */
export type ImmersiveProbe =
  | { readonly kind: 'no-xr' }
  | { readonly kind: 'threw'; readonly message: string }
  | { readonly kind: 'answered'; readonly supported: boolean }

/**
 * The reading half, split out so it can be tested without a browser, a rig, or
 * a headset — `tests/unit/xr-immersive-probe.test.ts` covers all three branches.
 * Entering a real session to check an error message is not a reasonable price,
 * and on a box with SteamVR up it would put one on somebody's actual headset.
 */
export const assertImmersiveProbe = (probe: ImmersiveProbe): void => {
  if (probe.kind === 'no-xr') {
    throw new Error(
      'navigator.xr is absent. That is the browser or the build, NOT the rig — this spec runs on ' +
        'the system Chrome over HTTPS, where WebXR should exist whether or not a headset does.',
    )
  }
  if (probe.kind === 'threw') {
    throw new Error(
      `isSessionSupported('immersive-vr') threw: ${probe.message}. Neither a missing rig nor a ` +
        'missing browser — read it before assuming either.',
    )
  }
  if (!probe.supported) {
    throw new Error(
      "isSessionSupported('immersive-vr') is false: no immersive device. #enter-vr will stay " +
        'greyed for the life of this page, so the wait below was going to time out. If this is ' +
        'the virtual-headset route, the rig is not installed — check it with\n' +
        '    node ../vr-browser/tools/steamvr-rig.mjs status vrto3d\n' +
        'and note that installing it takes the Steam Frame offline (forcedDriver). See DEV-265 ' +
        'and the vrto3d memory note.',
    )
  }
}

/** Read the page's own `navigator.xr`, then {@link assertImmersiveProbe} it. */
export const requireImmersiveDevice = async (page: Page): Promise<void> => {
  const probe: ImmersiveProbe = await page.evaluate(async () => {
    const xr = (navigator as unknown as { xr?: { isSessionSupported?: unknown } }).xr
    if (!xr || typeof xr.isSessionSupported !== 'function') return { kind: 'no-xr' as const }
    try {
      const supported = await (xr.isSessionSupported as (m: string) => Promise<boolean>)(
        'immersive-vr',
      )
      return { kind: 'answered' as const, supported }
    } catch (e) {
      return { kind: 'threw' as const, message: String((e as { message?: string })?.message ?? e) }
    }
  })
  assertImmersiveProbe(probe)
}

/**
 * `test`, but the browser is a persistent context with WebXR pre-granted.
 *
 * Use it in place of `@playwright/test`'s own `test` in any spec that enters an
 * immersive session. Everything else — `expect`, fixtures, `test.use` for the
 * viewport — behaves as usual.
 */
export const test = base.extend<{ context: BrowserContext; page: Page }>({
  context: async ({ baseURL, viewport }, use) => {
    const origin = new URL(baseURL ?? 'https://localhost:5273').origin
    writeXrGrant(origin)
    // Headed and on the system Chrome for the same reasons playwright.config.ts
    // gives: headless Chromium is SwiftShader, and the bundled build does not
    // start on this machine. Spread rather than assigned, because
    // `exactOptionalPropertyTypes` refuses an explicit `undefined`.
    const channel = E2E_CHANNEL
    const context = await chromium.launchPersistentContext(XR_PROFILE_DIR, {
      headless: false,
      ...(channel ? { channel } : {}),
      ignoreHTTPSErrors: true,
      viewport: viewport ?? null,
    })
    // DEV-611: a session that has seen the splash, as every spec's (./test.ts).
    await skipSplash(context)
    await use(context)
    await context.close()
  },
  page: async ({ context }, use) => {
    const page = context.pages()[0] ?? (await context.newPage())
    await use(page)
  },
})

export { expect } from '@playwright/test'
