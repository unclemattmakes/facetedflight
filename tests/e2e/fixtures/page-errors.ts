/**
 * tests/e2e/fixtures/page-errors.ts — "did the page misbehave?", in one place.
 *
 * Every spec here asserts that a run produced no console errors and no
 * uncaught exceptions. Doing that naively has one trap, and this file exists
 * because we walked into it: Chrome logs a bare
 *
 *   Failed to load resource: the server responded with a status of 404 ()
 *
 * with **no URL** for the favicon it requests on its own, and the scaffold
 * ships no favicon. Six specs failed on it the first time the suite was ever
 * executed (2026-09-09).
 *
 * The wrong fix is to mute "Failed to load resource" and move on — that also
 * mutes a missing level JSON, a missing GLB, a dead R2 URL. So instead:
 *
 *   - console messages that are *just* the resource-load notice are dropped,
 *     because they carry no information;
 *   - every HTTP response of 400+ is recorded **with its URL and status**, and
 *     fails the assertion unless its path is on a short, explicit ignore list.
 *
 * Net effect: strictly more signal than watching the console alone, and a
 * failure now tells you *which* URL broke.
 *
 * ── 2026-09-21: the build now HAS an icon, and the entry stays ───────────
 *
 * `index.html` declares `<link rel="icon" type="image/svg+xml" href="./icon.svg">`
 * (Matt's call, made against `production-bundle.spec.ts`: *ship one, keep the
 * allowance*). A declared icon normally stops the browser probing the legacy
 * path at all, so the entry below is expected to be dead most of the time —
 * and it stays, for the reason it would be wrong to remove it: the probe still
 * turns up in some contexts, and a 404 on a path THIS APP NEVER REFERENCES is
 * not an app failure however it arrives.
 *
 * What is not weakened by any of that: the icon's own URL is not on the list.
 * Vite emits it as `/assets/icon-<hash>.svg`, so an icon that stops being
 * bundled fails the assertion like any other missing asset, and
 * `production-bundle.spec.ts` asserts the response is a 200 besides.
 *
 * The paragraph above this one is left standing rather than rewritten: it is
 * the account of what happened on 2026-09-09 and it is still true of that day.
 */
import type { Page } from '@playwright/test'

/**
 * Paths whose 4xx/5xx responses are not app failures. Keep this list short and
 * justify every entry — it is the only thing standing between the suite and a
 * silently broken asset.
 */
const IGNORABLE_PATHS: RegExp[] = [
  // Requested by the browser on its own, never by this app. index.html has
  // declared an SVG icon since 2026-09-21, which normally suppresses this
  // probe; the entry stays because the probe is the browser's business either
  // way. The icon's OWN url is deliberately not here — see the header.
  /\/favicon\.ico$/,
]

/** The bare Chrome notice that a subresource failed; the response hook has the detail. */
const RESOURCE_NOTICE = /^Failed to load resource:/

export interface PageErrorWatcher {
  /** Everything worth failing a test over, newest last. */
  list(): string[]
}

/**
 * Start watching a page for console errors, uncaught exceptions and failed
 * HTTP responses. Call before `page.goto()`.
 */
export const watchPageErrors = (page: Page): PageErrorWatcher => {
  const problems: string[] = []

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (RESOURCE_NOTICE.test(text)) return
    problems.push(`console.error: ${text}`)
  })

  page.on('pageerror', (err) => {
    problems.push(`pageerror: ${err.message}`)
  })

  page.on('response', (res) => {
    if (res.status() < 400) return
    let path = res.url()
    try {
      path = new URL(res.url()).pathname
    } catch {
      // Non-URL scheme (data:, blob:) — keep the raw string.
    }
    if (IGNORABLE_PATHS.some((re) => re.test(path))) return
    problems.push(`http ${res.status()}: ${res.url()}`)
  })

  page.on('requestfailed', (req) => {
    const failure = req.failure()?.errorText ?? 'unknown'
    // Aborted requests are normal during navigation teardown.
    if (failure.includes('ERR_ABORTED')) return
    problems.push(`requestfailed: ${req.url()} — ${failure}`)
  })

  return {
    list: () => [...problems],
  }
}
