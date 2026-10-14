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

// ── Long cache for hashed output (DEV-945) ─────────────────────────────────
//
// Without a Cache-Control, Pages revalidates every JS chunk on every visit.
// Rollup writes the code, CSS, workers and imported assets of a build as
// `assets/<name>-<hash>.<ext>`, the hash being of the content, so a changed
// file is a new URL and the old one may be cached for a year. Everything else
// in `dist/` (`index.html`, `404.html`, the making-of pages, the icon, the
// share card, `_headers`) has a stable name and must keep revalidating, so the
// rule names the `/assets/` prefix and nothing broader, never `/*`.
//
// The premise is that NOTHING un-hashed lives under `/assets/`. It holds for a
// Cloudflare build, where `publicDir` is off (`vite.config.ts`). It does NOT
// hold for a local build, where `public/assets/` (the game's R2 assets,
// un-hashed names) is copied to `dist/assets/`: so the rule is emitted only
// when the caller says the public dir is off (`immutableAssets`), and when it
// is, every bundle file under `assets/` must carry a hash or the build fails
// rather than ship a year-long cache on a stable name. (`_headers` supports
// splats, not regexes, so the prefix is the narrowest rule there is.)

/** The prefix Rollup writes hashed output under. */
export const HASHED_PREFIX = '/assets/*'

/** One year, immutable: safe only for a name that changes when its bytes do. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'

/** `assets/name-AbCd_-12.js`: a name ending in an 8-character content hash. */
export const HASHED_ASSET = /^assets\/.+-[\w-]{8}\.[\w.]+$/

/** The file's text: the security rule for every path, then (optionally) the cache rule for the hashed prefix. */
export const headersFile = ({ immutableAssets = false } = {}) =>
  `/*\n${Object.entries(SECURITY_HEADERS)
    .map(([name, value]) => `  ${name}: ${value}\n`)
    .join('')}${immutableAssets ? `${HASHED_PREFIX}\n  Cache-Control: ${IMMUTABLE_CACHE}\n` : ''}`

/** Names in a bundle that sit under `assets/` without a hash in them. */
export const unhashedUnderAssets = (fileNames) =>
  fileNames.filter((n) => n.startsWith('assets/') && !HASHED_ASSET.test(n))

/**
 * The Vite plugin: emit `_headers` in a build. Nothing in dev (hard rule 8
 * forbids `server.headers`). `immutableAssets` adds the year-long cache for
 * `/assets/*`; pass `true` only when `publicDir` is off.
 */
export const securityHeaders = ({ immutableAssets = false } = {}) => ({
  name: 'ff2-security-headers',
  apply: 'build',
  generateBundle(_options, bundle) {
    if (immutableAssets) {
      const bad = unhashedUnderAssets(Object.keys(bundle ?? {}))
      if (bad.length > 0) {
        this.error(
          `_headers marks /assets/* immutable but these have no content hash: ${bad.join(', ')}`,
        )
      }
    }
    this.emitFile({
      type: 'asset',
      fileName: HEADERS_FILE,
      source: headersFile({ immutableAssets }),
    })
  },
})
