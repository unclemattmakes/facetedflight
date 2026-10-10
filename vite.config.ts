import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vite'
import { appIcon } from './tools/dev/app-icon.mjs'
import { notFound } from './tools/dev/not-found.mjs'
import { overrideWriter } from './tools/dev/override-writer.mjs'
import { securityHeaders } from './tools/dev/security-headers.mjs'
import { makingOfPlugin } from './tools/making-of/plugin'

// Faceted Flight 2 — Vite config.
//
// Two things here are load-bearing and should not be "tidied away":
//
//  1. `basicSsl()` + `host: '0.0.0.0'`. WebXR is a secure context: a Quest on
//     the LAN cannot enter an immersive session from `http://192.168.x.x`.
//     `pnpm dev` therefore serves HTTPS on every interface and prints a LAN
//     URL you open *in the headset browser*. You will get a self-signed-cert
//     interstitial on the Quest — accept it once per cert.
//  2. NO `server.headers` COOP/COEP block. FF2 uses no `SharedArrayBuffer`
//     anywhere (PORT_PLAN §2.4). Terrain generation goes to a plain Worker
//     with transferable `ArrayBuffer`s. Adding cross-origin isolation here
//     would buy nothing and would start breaking R2 asset fetches.
//  3. `publicDir` is OFF when the assets come from somewhere else — below.

const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url))
/** This checkout's root as a watcher glob wants it: forward slashes, no trailing one (DEV-540). */
const WATCH_ROOT = REPO_ROOT.replaceAll('\\', '/').replace(/\/+$/, '')

/**
 * `public/` holds ONE thing — `assets/`, hydrated from R2 by `pnpm assets:pull`
 * and gitignored in its entirety (hard rule 7). Vite copies `public/` into
 * `dist/` by default, so a production build was emitting **45 MB**: ~11 MB of
 * code and **34 MB of assets the built app never asks for**, because
 * `VITE_ASSET_BASE_URL` sends it to `ff2-content.mattscott.dev` instead.
 *
 * That is worse than waste. It puts the same bytes in two places with nothing
 * keeping them equal, and `pnpm assets:check --verify-hashes` only knows about
 * one of them — which is trap 21's exact shape: the HoverJet shipped backwards
 * for a session because two copies of a file disagreed and nothing compared
 * them.
 *
 * So when the base is external, do not copy `public/` at all. When it is `/` —
 * local dev, and Playwright, which sets it itself — copy it, because then those
 * files *are* the assets.
 */
const assetBase = process.env.VITE_ASSET_BASE_URL ?? ''
const assetsAreLocal = assetBase === '' || assetBase === '/'

/**
 * DEV-411: the build's channel. Cloudflare Pages names the branch it is
 * building in `CF_PAGES_BRANCH`, and only `release` is production. Everything
 * else, a local build included, is `preview`. `FF2_CHANNEL` overrides it, for
 * checking a release build by hand. `src/content/build-channel.ts` reads it.
 */
const channel =
  (process.env.FF2_CHANNEL ?? process.env.CF_PAGES_BRANCH) === 'release' ? 'release' : 'preview'

export default defineConfig({
  // `overrideWriter` (DEV-539): `PUT /__ff2/override/<id>` writes a shipped
  // mission's override into `content/overrides/`. `apply: 'serve'` — absent
  // from every build. See the plugin's header.
  // `appIcon` (DEV-595): the iPhone home-screen icon, rasterised from
  // `icon.svg` in the build and served from memory in dev, so no PNG is
  // committed. See the plugin's header. DEV-657: it also composes the designed
  // share card from a still that lives on R2, never in git.
  // `notFound` (DEV-602): a `404.html` in every build, so an unknown path
  // answers 404 instead of booting the game.
  // `securityHeaders` (S-05, docs/SECURITY-AUDIT.md): a `_headers` file in
  // every build (HSTS, framing, Permissions-Policy). Build only: hard rule 8.
  // `makingOfPlugin` (DEV-506): the making-of pages as extra build inputs, and
  // their nav, `data-const` and `data-snippet`. A release build leaves out
  // chapters still `draft`. See the plugin's header.
  plugins: [
    basicSsl(),
    overrideWriter(),
    appIcon(fileURLToPath(new URL('./icon.svg', import.meta.url)), {
      root: REPO_ROOT,
      layoutPath: fileURLToPath(new URL('./tools/dev/share-card.layout.json', import.meta.url)),
    }),
    notFound(),
    securityHeaders(),
    makingOfPlugin(channel),
  ],
  define: { __FF2_CHANNEL__: JSON.stringify(channel) },
  publicDir: assetsAreLocal ? 'public' : false,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Listen on every interface so a headset on the LAN can reach the dev
    // server. Vite prints the LAN URL under "Network:".
    host: '0.0.0.0',
    // `PORT` first, so a harness that assigns one is obeyed. Nothing here needs
    // 5173 specifically — WebXR needs HTTPS and a LAN URL, not a port number,
    // and Playwright pins its own via `E2E_PORT`.
    port: Number(process.env.PORT) || 5173,
    // strictPort off: a squatted port cascades to the next rather than failing.
    // Playwright pins its own port (see playwright.config.ts) so a parallel
    // session cannot silently attach you to a sibling's app.
    strictPort: false,
    fs: { allow: [REPO_ROOT] },
    // ── DEV-255: do NOT watch the agent worktrees ────────────────────────
    //
    // `.claude/worktrees/` holds one FULL COPY OF THIS REPO per background
    // agent — 28 of them on 2026-09-20 — and each carries its own
    // `tsconfig.json`, `index.html` and `dist/`. Vite's watcher walks the
    // project root, so anything that touches a sibling worktree (an agent
    // committing, the harness reclaiming a finished one, a `git worktree`
    // command) is a change inside the watched tree.
    //
    // **What that does is force a full page reload in the middle of a
    // measurement**, and it is invisible unless you read the dev server's own
    // log. Row 07 of the DEV-255 queue died exactly this way:
    //
    //     8:20:44 PM [vite] (client) page reload .claude/worktrees/agent-a147…/index.html
    //     8:20:44 PM [vite] changed tsconfig file detected: …/agent-a147…/tsconfig.json
    //                       — Clearing cache and forcing full-reload
    //
    // three of them inside two seconds, 4-6 s before the row ended, and the
    // spec then read `window.__ride` off a page that had been reloaded out
    // from under it: `TypeError: Cannot read properties of undefined`. The
    // trace had already been written, so the failure looked like a spec bug
    // rather than a contaminated run.
    //
    // The timestamps are what settled it. A file I wrote myself landed 15 s
    // into the same row and the correlation looked damning until the dev
    // server log named the real cause — which is `agent-team-fanout-recipe`'s
    // *"redirect every heavy run to a timestamped log; the mtimes are what let
    // you clear or convict yourself later"*, paid out.
    //
    // Harness scope, not game behaviour: nothing under `.claude/` is ever
    // imported by the app, so ignoring it changes no module graph. This is
    // NOT the `server.headers` line hard rule 8 forbids.
    //
    // DEV-540: ANCHORED to this checkout's root. It was `**/.claude/worktrees/**`,
    // which also matches every file of a server started INSIDE a worktree —
    // its own root is under `.claude/worktrees/` — so a worktree's dev server
    // watched nothing at all: `src/` edits never reached it (AGENT-NOTES §2's
    // "restart after every edit"), and DEV-539's "a Save does not reload the
    // page" passed VACUOUSLY there, because no write could reload anything.
    // Anchored, the main checkout still ignores every agent worktree under it,
    // exactly as DEV-255 asked, and a worktree's server watches its own tree,
    // as any checkout's does. `tests/e2e/editor-shipped.spec.ts`'s control arm
    // (a hand delete that MUST reload) is what shows it on the box that runs it.
    // A root with a glob character in its path cannot be anchored safely, and
    // keeps the old, blind pattern.
    watch: {
      ignored: [
        /[()[\]{}*?!+@|]/.test(WATCH_ROOT)
          ? '**/.claude/worktrees/**'
          : `${WATCH_ROOT}/.claude/worktrees/**`,
      ],
    },
    // ── DEV-388: `/api` to a local server, only when asked ──────────────────
    //
    // The game reaches its lap server and its rooms on its OWN origin
    // (`/api/laps`, `wss://<site>/api/room/<id>`), as on Cloudflare. Under
    // `pnpm dev` there is no `/api`, so `FF2_API_PROXY=http://127.0.0.1:<port>`
    // forwards it — sockets included — to a local server: the multiplayer
    // specs' room sidecar (`tests/e2e/fixtures/room-sidecar.ts`), or a
    // `wrangler pages dev`. Unset, nothing changes. The game's code path is the
    // same either way: this is the dev server's routing, not the build's. The
    // Origin is rewritten to the target's so a same-origin check behind this
    // HTTPS-terminating hop sees one origin, as it does in production.
    ...(process.env.FF2_API_PROXY
      ? {
          proxy: {
            '/api': {
              target: process.env.FF2_API_PROXY,
              changeOrigin: true,
              ws: true,
              headers: { origin: process.env.FF2_API_PROXY },
            },
          },
        }
      : {}),
  },
  build: {
    target: 'es2022',
    // NO source maps in a deployed build, unless `SOURCEMAP=1` asks for them
    // locally. This was `'hidden'`, on the premise that dropping the
    // sourceMappingURL comment kept the source private. It does not: the .map
    // files still land in dist/ and Pages serves them, so the private repo's
    // source was downloadable from the live site (found 2026-09-26, Matt:
    // "fix the source maps"). `tests/unit/no-public-sourcemaps.test.ts` pins it.
    sourcemap: process.env.SOURCEMAP === '1',
  },
})
