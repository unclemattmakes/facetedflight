// tools/dev/not-found.mjs: the site's 404 page, emitted into every build. DEV-602.
//
// Cloudflare Pages serves `index.html` for a path it has no file for, UNLESS the
// build has a top-level `404.html`, in which case it serves that with status
// 404. With none, `facetedflight.net/anything-at-all` answered 200 and booted
// the whole game (the 2026-10-03 persona playtest's journalist: a typo'd link
// looked like a working one, and a crawler indexed every path as the game).
//
// Safe for every route the game has: the shared links are QUERY strings on the
// root (`?room=`, `?watch=`, `?ghost=`, `?tv`) or a fragment (`#c=`), and the
// paths that are not files (`/tv`, `/privacy`, `/api/...`) are Pages Functions,
// which run before the static fallback is consulted.
//
// Emitted by the build rather than kept in `public/`, because `vite.config.ts`
// turns `publicDir` off on every deploy that fetches content off-origin, which
// is every real one. Plain HTML, no script, the privacy page's colours.

/** The file name Pages looks for at the top of the build output. */
export const NOT_FOUND_PAGE = '404.html'

/** The page itself. */
export const notFoundHtml = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Not found · Faceted Flight: 10th Anniversary Edition</title>
<style>
  :root { color-scheme: light dark; --fg: #1d2330; --bg: #f6f4ef; --muted: #5a6273; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e8e6e1; --bg: #12151c; --muted: #a3a9b6; } }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 17px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 42rem; margin: 0 auto; padding: 2.5rem 1rem 4rem; }
  h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 .5rem; }
  p { color: var(--muted); }
  a { color: inherit; }
</style>
</head>
<body>
<main>
<h1>There is nothing at this address</h1>
<p>The link may have a typo in it, or the page has moved.</p>
<p><a href="/">Play Faceted Flight: 10th Anniversary Edition</a></p>
</main>
</body>
</html>
`

/** The Vite plugin: emit the page in a build. Nothing in dev, where Vite answers its own way. */
export const notFound = () => ({
  name: 'ff2-not-found',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: NOT_FOUND_PAGE, source: notFoundHtml() })
  },
})
