/**
 * tests/e2e/production-bundle.spec.ts — the BUILT bundle boots.
 *
 * ── The gap this closes ──────────────────────────────────────────────────
 *
 * Every other spec in this directory runs against the Vite DEV server that
 * `playwright.config.ts` starts, and `pnpm build` only proves the bundle
 * COMPILES. Until this file nothing ever served the bundle and loaded it, so
 * the whole class of dev-only-works bugs — a `import.meta.env.DEV` branch that
 * disappears, a side-effecting import tree-shaken away, a worker URL that does
 * not survive chunking, a JSON default import that does not — was unwatched.
 *
 * This repo has already paid that bill at full price. The one time the build
 * was worn (2026-09-09, commit `5313a49`) it reached a pink sky and nothing
 * else: `VITE_ASSET_BASE_URL` was unset, not one asset loaded, and every e2e
 * screenshot in the suite rendered terrain perfectly the whole time because
 * Playwright's own config sets that variable itself. *The one path nobody had
 * run was the one a human uses.*
 *
 * ── What this proves, and what it does NOT ───────────────────────────────
 *
 * It proves: `vite build` produces a bundle that a static server can serve, and
 * that the bundle boots, reaches the title world, fetches its content, logs
 * nothing alarming, and has no dev handles left in it.
 *
 * It does NOT prove the DEPLOY is configured. `VITE_ASSET_BASE_URL` is inlined
 * at build time, so a spec has to pick one, and this one picks the same value
 * `playwright.config.ts` gives the dev server (`/`, the hydrated `public/`
 * tree) for the same reason: it is the only base that is answerable offline,
 * and with it the built `dist/` carries the assets, so the preview server is
 * self-contained. The real deploy takes its value from the Cloudflare Pages
 * project settings, and nothing here can see that. **Setting it in the harness
 * is what hid the 2026-09-09 bug; the honest thing is not to pretend otherwise
 * but to say which claim is being made.** The claim is *the bundle works when a
 * base is configured*, and `body[data-asset-base-missing]` below is asserted
 * explicitly so that the OTHER failure is named rather than timed out on.
 *
 * ── Two traps, both of which cost time the day this was written ──────────
 *
 * 1. **`__ff2` DOES NOT EXIST IN A PRODUCTION BUILD.** `src/main.ts` assigns it
 *    inside `if (import.meta.env.DEV)`, which is statically false in a build,
 *    so the assignment is dropped entirely. Every scene-graph probe in this
 *    suite goes through that handle, and reaching for one here returns
 *    `undefined` and fails in a way that reads exactly like a broken bundle.
 *    Use the body dataset — `data-title-ready` and `data-boot-world` are set by
 *    `boot/app.ts` in every build. The absence is asserted below rather than
 *    only described, because a trap written down as prose is a trap somebody
 *    walks into again.
 * 2. **`__ff2perf` exists only under `?perf=1`.** `main.ts` gates it on
 *    `app.perfSurface`, which `boot/app.ts` builds only for that switch.
 *    Asserting it on a visitor URL is the same mistake one level along, so it
 *    is asserted absent here too.
 *
 * ── The quality pin, and the half of it that cannot run here ─────────────
 *
 * The load carries `PINNED` (`tests/e2e/fixtures/quality-pin.ts`) because this
 * spec photographs the page and `render/quality.ts` drops a tier on a starved
 * box. The pin's second half — `drawState`, which reads what is ACTUALLY in
 * force and makes the pin a fact rather than an intention — reads `__ff2`, so
 * it is trap 1 again and is unavailable in a production build.
 *
 * That costs this spec nothing, because **this spec decides nothing from
 * pixels**: the picture is evidence for a human that the bundle painted a
 * valley rather than a pink sky, and every assertion here is about boot state,
 * network and globals. It would cost a lot for a future production spec that
 * judges a look, and that spec has no way to verify its pin — worth knowing
 * before writing one.
 *
 * ── Mechanics ────────────────────────────────────────────────────────────
 *
 * The build and the preview server belong to this file rather than to
 * `playwright.config.ts`'s `webServer`, which is global: an entry there would
 * build and serve the bundle on every invocation of every spec. Measured
 * 2026-09-21, three fresh processes each: **`build()` 1058/1117/1111 ms,
 * `preview()` 36/35/37 ms** — rolldown, with the 36 MB copy of `public/` inside
 * that figure (47 GLBs land in the out dir). So the whole `beforeAll` is ~1.15 s
 * and a spec-owned one costs nothing when this file is not selected. The
 * dev server still starts for the run — that is the global `webServer` and this
 * spec simply does not talk to it; `page.goto` takes an absolute URL, which
 * overrides `baseURL`.
 *
 * The one cost this file imposes on runs that DO NOT select it is the `vite`
 * import at the top: **~125 ms** (7 fresh processes, 120.8–129.6 ms), paid once
 * when Playwright loads the spec files to enumerate tests and again in whatever
 * worker runs this one. Measured directly rather than differenced out of a
 * whole run, because that difference is not measurable on this box — three
 * `--list` timings with the file gave 3.57/5.22/10.97 s and three without gave
 * 8.64/6.45/2.76 s, which is two overlapping clouds and no signal. **A
 * whole-suite wall-time delta for one test in a 221-test, four-worker run is
 * not claimed here, because nothing measured it.**
 *
 * `outDir` is under `dist/` on purpose. `.gitignore`, `biome.json`,
 * `tsconfig.json` and `vite.config.ts` already each know to leave `dist/`
 * alone; a new top-level directory would be four more places to remember, three
 * of which nobody would.
 *
 * The port is pinned and `strictPort` is on, for `playwright.config.ts`'s
 * stated reason: a collision must error out rather than silently attach the
 * spec to something else. The hashed-script assertion is the premise check for
 * the same worry — `/assets/index-<hash>.js` is the built entry and
 * `/src/main.ts` is the dev one, so a load that somehow reached the dev server
 * fails here saying so instead of passing as a production run.
 *
 * `@gpu`: a real world, a real compiler, and a hydrated `public/assets`.
 *
 * ── ONE UNEXPLAINED FAILURE, and it is recorded rather than explained ────
 *
 * On 2026-09-21, during development, this spec failed once and the cause was
 * lost: the output had been filtered to four lines and `test-results/` is
 * wiped at the start of every run, so the error context went with it. The
 * author's unconfirmed guess was an `emptyOutDir` race on Windows — that run
 * followed 54 MB being written and deleted twice in the same tree.
 *
 * It has not recurred in **28 consecutive runs with `--retries=0`**: 12 by the
 * author, then 10 on an idle box, then **6 while a full `pnpm check` ran
 * alongside it** — that last set on purpose, because contention was the
 * hypothesis and a quiet box cannot test it. No reproduction, at all, in
 * either condition.
 *
 * **So it is written down instead of hardened against.** A fix for a cause
 * nobody can demonstrate is a change nobody can evaluate, and this file's own
 * config gives it `retries: 1` locally and `2` in CI, which is the tolerance
 * a once-in-thirty event should be met with. What the next person needs is not
 * a guess: **if this fails, capture the FULL output before anything else** —
 * `--reporter=list`, no `grep`, and copy `test-results/` out of the way before
 * re-running. That is the piece that was thrown away, and it is the only
 * reason this paragraph is a mystery rather than a diagnosis.
 */

import { fileURLToPath, URL } from 'node:url'
import { build, type PreviewServer, preview } from 'vite'
import { watchPageErrors } from './fixtures/page-errors'
import { PINNED } from './fixtures/quality-pin'
import { expect, test } from './fixtures/test'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Under `dist/`, so every config that already ignores `dist/` ignores this. */
const OUT_DIR = 'dist/e2e-preview'

/** Not 5273 — that is the dev server's, pinned by `playwright.config.ts`. */
const PORT = Number(process.env.E2E_PREVIEW_PORT ?? 5274)

/**
 * The base baked into the bundle. Same default and same reason as the dev
 * server's (`playwright.config.ts`'s `webServer.env`): `/` serves the hydrated
 * `public/` tree, which `vite.config.ts` then copies into `dist/`, so the
 * preview server has the content as well as the code.
 *
 * Read from `process.env` rather than left to `.env`, so the spec means the
 * same thing on a machine that has one and a machine that does not — Vite's
 * `loadEnv` lets `process.env` win over a `.env` file, deliberately, for
 * exactly this.
 */
const ASSET_BASE = process.env.VITE_ASSET_BASE_URL ?? '/'

/**
 * The built entry Vite emits: a content-hashed file under `/assets/`. The
 * premise is "built, not the dev server", which is the hash and the directory,
 * not the chunk's name: the making-of site's plugin keys the game's input
 * `main` (tools/making-of/plugin.ts), so the entry is `main-<hash>.js`, and a
 * single-input build would call it `index-<hash>.js`. `/src/main.ts` is what the
 * DEV server serves, and matches neither.
 */
const BUILT_ENTRY = /^\/assets\/[A-Za-z0-9_]+-[A-Za-z0-9_-]{6,}\.js$/

/** The tab icon, once the bundler has hashed it. `./icon.svg` is the source. */
const BUILT_ICON = /^\/assets\/icon-[A-Za-z0-9_-]+\.svg$/

/** The frame this run painted. `test-results/` is wiped at the start of a run. */
const SHOT = 'test-results/production-bundle.png'

let server: PreviewServer | null = null
let origin = ''

test.describe('@gpu the production bundle', () => {
  test.beforeAll(async () => {
    // A build and a cold preview server. The default hook timeout is the test
    // timeout, which is 30 s.
    test.setTimeout(300_000)

    // Vite inlines `import.meta.env.VITE_ASSET_BASE_URL` from `process.env` at
    // config-resolve time, and `vite.config.ts` reads the same variable to
    // decide whether to copy `public/` — so it has to be in the environment
    // before `build()`, not passed to it. Restored afterwards: a Playwright
    // worker runs more than one file.
    const previous = process.env.VITE_ASSET_BASE_URL
    process.env.VITE_ASSET_BASE_URL = ASSET_BASE
    try {
      await build({
        root: REPO_ROOT,
        logLevel: 'warn',
        build: { outDir: OUT_DIR, emptyOutDir: true },
      })
    } finally {
      if (previous === undefined) delete process.env.VITE_ASSET_BASE_URL
      else process.env.VITE_ASSET_BASE_URL = previous
    }

    server = await preview({
      root: REPO_ROOT,
      logLevel: 'warn',
      build: { outDir: OUT_DIR },
      // Loopback only. `vite.config.ts` puts the DEV server on 0.0.0.0 so a
      // headset on the LAN can reach it; a test fixture has no such need and
      // should not publish a build to the network to serve one browser.
      preview: { host: 'localhost', port: PORT, strictPort: true },
    })

    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error(`preview server bound no local URL on port ${PORT}`)
    origin = url.replace(/\/$/, '')
  })

  test.afterAll(async () => {
    test.setTimeout(60_000)
    await server?.close()
    server = null
  })

  test('serves the built bundle, which boots to the title world and stays quiet', async ({
    page,
  }, testInfo) => {
    // The terrain generator's budget on a cold cache, as everywhere else in
    // this suite. The per-test default is 30 s and an inline timeout on one
    // assertion cannot raise it — the test is killed before the expect budget
    // is spent (see `boot.spec.ts`).
    test.setTimeout(180_000)
    const problems = watchPageErrors(page)

    // `?xr=off` so `isSessionSupported('immersive-vr')` is never asked and this
    // box's OpenXR runtime — SteamVR — is not launched by a smoke test.
    await page.goto(`${origin}/?xr=off&${PINNED}`)

    // ── The premise, before anything is concluded from it ────────────────
    // A hashed entry means this really is the build. `/src/main.ts` would mean
    // a load had reached the dev server, and every assertion below would then
    // be true of the wrong thing.
    const entry = await page.locator('script[type="module"]').first().getAttribute('src')
    expect(entry, 'not the built bundle — this looks like the dev server').toMatch(BUILT_ENTRY)

    // ── The tab icon is IN the bundle ────────────────────────────────────
    // Matt, 2026-09-21: ship one, keep the `/favicon.ico` allowance. The
    // allowance means a missing icon cannot show up as a failed request, so it
    // is asserted here instead, and asserted twice over because the two ways it
    // breaks are different:
    //
    //   - the HASHED path proves it went through the bundler. `public/icon.svg`
    //     would work on every local build and ship on none of them —
    //     `vite.config.ts` turns `publicDir` off whenever the content base
    //     points off-origin, which is every deploy. That regression leaves the
    //     tag in place and is invisible to a page that renders fine.
    //   - the FETCH proves the emission is really there. A declared icon the
    //     browser happens not to request is a 404 nobody sees, and a check that
    //     only sometimes runs is not a check.
    //
    // **What decides it is where the FILE is, not how the href is spelled.**
    // The obvious probe — rewrite `./icon.svg` to `/icon.svg` and expect red —
    // stays green, because Vite resolves a root-relative href against the
    // project root and hashes that too; checked, and it cost a wrong comment
    // before it was. What does separate them is a target inside `publicDir`:
    // `/assets/particles/tri-particle.png` came back at exactly that path,
    // unhashed, and failed this line. Public files are copied, never fingerprinted,
    // which is the whole reason the pattern below is a guard and not decoration.
    const icon = await page.locator('link[rel="icon"]').first().getAttribute('href')
    expect(icon, 'the tab icon is missing, or is not a bundled emission').toMatch(BUILT_ICON)
    const iconResponse = await page.request.get(new URL(icon ?? '', `${origin}/`).href)
    expect(iconResponse.status(), `the icon 404s at ${icon}`).toBe(200)

    // The 2026-09-09 failure, named. `main.ts` sets this synchronously, before
    // its top-level `await bootApp()`, so it is in the DOM by `load` — which
    // makes this a one-second, legible failure instead of a 180-second timeout
    // on `data-title-ready` that says only that something did not happen.
    await expect(
      page.locator('body'),
      `the bundle booted with no asset base: VITE_ASSET_BASE_URL (${ASSET_BASE}) ` +
        'did not reach the build',
    ).not.toHaveAttribute('data-asset-base-missing', 'true')

    // Boot reached the title valley. `data-title-ready` is `boot/app.ts`'s, set
    // in every build; `__ff2` is not (trap 1).
    //
    // Waited on TOGETHER with the failure attribute, which is
    // `fixtures/boot.ts`'s reason one level along: `watchWorld` sets
    // `data-terrain-error` when the world promise rejects, and the two are
    // alternatives, so polling only for the good one spends the whole 180 s on
    // a boot that was never going to set it and then reports a timeout instead
    // of the reason. A bundle built against a base that RESOLVES TO NOTHING —
    // a stale bucket URL, a `/` with no hydrated `public/` — fails exactly
    // there, and it should say so in a second.
    await page.waitForSelector('body[data-title-ready="true"], body[data-terrain-error]', {
      timeout: 180_000,
    })
    expect(
      await page.getAttribute('body', 'data-terrain-error'),
      'the world promise rejected — the bundle booted but could not load its content',
    ).toBeNull()
    await expect(page.locator('body')).toHaveAttribute('data-title-ready', 'true')
    await expect(page.locator('body')).toHaveAttribute('data-boot-world', 'title')

    // The landing page came up too, and `BUILD_VERSION` survived the bundler —
    // it is `package.json`'s `version` through a JSON default import, which is
    // a real thing for a build to get wrong and for the dev server not to.
    // `body[data-build]` since DEV-614 (the footer's `#build-version` went).
    await expect(page.locator('body')).toHaveAttribute('data-build', /^v\d+\.\d+\.\d+$/)
    await expect(page.locator('#viewport')).toBeVisible()

    // ── The dev handles are GONE ─────────────────────────────────────────
    // Traps 1 and 2 as assertions rather than as prose. `__ff2` holds the whole
    // scene graph, so a build that shipped it would be a real (small) defect as
    // well as a sign that the `import.meta.env.DEV` gate had stopped working.
    const handles = await page.evaluate(() => ({
      ff2: '__ff2' in globalThis,
      perf: '__ff2perf' in globalThis,
    }))
    expect(handles.ff2, '__ff2 leaked into a production build').toBe(false)
    expect(handles.perf, '__ff2perf exists without ?perf=1').toBe(false)

    // Evidence a human can look at: a valley, not a pink sky. Nothing is
    // asserted from these pixels — see the header on the pin.
    //
    // A PATH as well as an attachment, and the path is the half that works.
    // `testInfo.attach` with a `body` leaves nothing on disk under the `list`
    // reporter this suite runs by default — checked, and the output directory
    // came back empty on a green run — so a picture that exists only as an
    // attachment is a picture nobody can look at unless they remember to ask
    // for the HTML report. `test-results/` is wiped at the start of every run,
    // which is right for evidence about the run that just happened.
    const shot = await page.screenshot({ path: SHOT })
    await testInfo.attach('production-bundle.png', { body: shot, contentType: 'image/png' })

    // Console errors, uncaught exceptions, 4xx/5xx responses by URL, and failed
    // requests. `/favicon.ico` is allowed BY NAME in `fixtures/page-errors.ts`
    // — the browser asks for that legacy path unprompted and this app never
    // references it, so a 404 there says nothing about the build. Everything
    // else stays strict: a missing GLB fails here, and so does the icon this
    // page DOES declare, which is checked above by name and by fetch.
    expect(problems.list(), problems.list().join('\n')).toEqual([])
  })
})
