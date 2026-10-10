/**
 * Where the suite's dev server is, and which browser binary the suite drives.
 *
 * ONE copy, read by `playwright.config.ts` and by every spec that opens its own
 * browser (the room and TV specs launch a second `chromium` of their own and
 * need the same origin and the same channel the config gives the first). Nine
 * specs and the XR fixture each carried a private copy of these three lines,
 * and the copies drifted: they dropped the config's `!process.env.CI` half of
 * the channel rule, so a CI run would have launched `chrome` where the config
 * launches the bundled build.
 *
 * Imports nothing, so the config can import it and a spec can import it
 * without either pulling the other into test collection.
 *
 * Overrides, all environment variables:
 *
 *   E2E_HOST     the host the server answers on (default `localhost`)
 *   E2E_PORT     the pinned port (default `5273`); give every session its own
 *   E2E_CHANNEL  `msedge` for Edge, empty for Playwright's bundled Chromium
 *
 * Playwright's bundled Chrome-for-Testing build does not start on the Windows
 * dev box (verified 2026-09-09: `spawn UNKNOWN` on every spec), so on Windows
 * the default is the installed system Chrome, same engine and a real GPU. CI
 * (Linux) keeps the bundled build, which is the point of bundling it.
 */

export const E2E_HOST: string = process.env.E2E_HOST ?? 'localhost'
export const E2E_PORT: string = process.env.E2E_PORT ?? '5273'

/** The dev server's origin, no trailing slash. */
export const E2E_BASE = `https://${E2E_HOST}:${E2E_PORT}`

const defaultChannel = process.platform === 'win32' && !process.env.CI ? 'chrome' : undefined

/**
 * The browser channel, or `undefined` for the bundled build. An explicitly
 * EMPTY `E2E_CHANNEL` stays the empty string (falsy), which every caller
 * treats as "no channel" with `channel ? { channel } : {}`.
 */
export const E2E_CHANNEL: string | undefined = process.env.E2E_CHANNEL ?? defaultChannel
