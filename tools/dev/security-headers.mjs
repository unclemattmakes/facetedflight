// tools/dev/security-headers.mjs: the site's `_headers` file, in every build.
// S-05, docs/SECURITY-AUDIT.md (2026-10-08).
//
// Cloudflare Pages reads a top-level `_headers` in the build output and adds
// its headers to every STATIC response it matches (Functions answer for
// themselves: `src/net/http.ts`). The file cannot live in `public/`: a
// Cloudflare build sets `publicDir: false` (vite.config.ts) because the assets
// come from R2, so `public/_headers` would never reach `dist/`. Emitted here,
// the same way `not-found.mjs` emits the 404 page.
//
// What Pages sends without this (curl, 2026-10-08): `x-content-type-options:
// nosniff` and `referrer-policy: strict-origin-when-cross-origin`, and nothing
// else. What this adds, and why each is safe for THIS game:
//
//   Strict-Transport-Security  one year. No `includeSubDomains` and no
//       `preload`: both bind hostnames this repo does not own the list of.
//   X-Frame-Options / CSP frame-ancestors  'self' only. The making-of page
//       frames the game (`src/making-of/toys/live-window.ts`), which is the
//       same origin; any other site framing the game is refused. A CSP that
//       says ONLY `frame-ancestors` restricts nothing else.
//   Permissions-Policy  denies what the game never asks for (camera,
//       microphone, geolocation, payment, usb). It names nothing the game
//       uses: WebXR, gamepads, fullscreen, device orientation and the
//       clipboard stay at the browser's default. Every name here is one
//       Chrome recognises, so it logs no warning.
//
// NOT here, on purpose: COOP and COEP (hard rule 8: no SharedArrayBuffer, and
// COEP would block the R2 assets), and a full Content-Security-Policy (S-10:
// the inline boot script, Cloudflare's injected analytics beacon and the R2
// origin make a wrong policy a broken game; after launch, Report-Only first).
//
// `pnpm audit:security` asserts these lines on a built `dist/_headers`.

/** The file name Pages looks for at the top of the build output. */
export const HEADERS_FILE = '_headers'

/** Header name to value, applied to every path. */
export const SECURITY_HEADERS = Object.freeze({
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "frame-ancestors 'self'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
})

/** The file's text: one rule, every path. */
export const headersFile = () =>
  `/*\n${Object.entries(SECURITY_HEADERS)
    .map(([name, value]) => `  ${name}: ${value}\n`)
    .join('')}`

/** The Vite plugin: emit `_headers` in a build. Nothing in dev (hard rule 8 forbids `server.headers`). */
export const securityHeaders = () => ({
  name: 'ff2-security-headers',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: HEADERS_FILE, source: headersFile() })
  },
})
