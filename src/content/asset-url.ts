// src/content/asset-url.ts — the one place an asset URL is constructed.
//
// Faceted Flight 2 ships **no binary content in git**. That is a licensing
// requirement, not a size convenience (PORT_PLAN §2.5, DECISIONS D12/D26): the
// 2016 project is built on ~55 Asset Store packs whose terms permit use inside
// a built product but not redistribution as source, and several `MM_*` meshes
// are derivative works of bought geometry. So compiled runtime content — GLBs,
// the terrain source maps, audio — lives in a Cloudflare R2 bucket and is
// fetched at runtime from `VITE_ASSET_BASE_URL`. See `docs/asset-storage.md`.
//
// Consequence: **there is no silent fallback.** king-tide's `assetUrl()` treats
// an unset base as "use the local `public/` copy", and it documents the cost of
// that (a stale R2 file was silently loaded for several verification runs while
// a rebuilt GLB sat unused in `public/`). FF2 inverts the default: an unset or
// blank `VITE_ASSET_BASE_URL` throws `MissingAssetBaseUrlError` naming the
// variable and pointing at `.env.example`, and local hydration is opted into
// *explicitly* by setting the base to `/`. A missing variable is then a loud,
// legible failure at boot instead of a black screen and a console 404.
//
// Zero dependencies, no `three`, no DOM — safe to import from anywhere,
// including the sim-purity-guarded modules and Node tooling under Vitest.

/** The single environment variable this module reads. Quoted in errors. */
export const ASSET_BASE_URL_ENV = 'VITE_ASSET_BASE_URL'

/**
 * The opt-in local value. `VITE_ASSET_BASE_URL=/` serves content from Vite's
 * own `public/` directory (hydrate it with `pnpm assets:pull`) — for working
 * offline, or for verifying a re-export *before* `pnpm assets:push`.
 */
export const LOCAL_ASSET_BASE = '/'

/** Thrown when the base URL is missing or blank. Fatal, and deliberately so. */
export class MissingAssetBaseUrlError extends Error {
  constructor() {
    super(
      `${ASSET_BASE_URL_ENV} is not set, so no game content can be located.\n` +
        'Faceted Flight: 10th Anniversary Edition keeps its compiled content (GLBs,\n' +
        'terrain maps, audio) out of ' +
        'git and serves it from Cloudflare R2 — see docs/asset-storage.md.\n' +
        'Fix (pick one):\n' +
        `  1. cp .env.example .env      # it already carries a working ${ASSET_BASE_URL_ENV}\n` +
        `  2. ${ASSET_BASE_URL_ENV}=${LOCAL_ASSET_BASE}  # serve a locally hydrated public/ (pnpm assets:pull)\n` +
        '  3. set it in the Cloudflare Pages project settings (Production + Preview).',
    )
    this.name = 'MissingAssetBaseUrlError'
  }
}

/**
 * True for URLs that already locate themselves: `https://…`, `data:`, `blob:`.
 * These pass through every join untouched, so a caller holding a full URL (a
 * signed link, an object URL from the level editor) never has to know whether a
 * base is configured.
 *
 * An explicit scheme is **required**. Protocol-relative `//host/path` is
 * deliberately not treated as absolute: FF2 never emits one, whereas a doubled
 * leading slash from a hand-built path is easy to produce, and silently
 * resolving `//assets/x.glb` against the page origin instead of the content
 * bucket is a 404 that looks like a bucket problem.
 */
function isAbsoluteUrl(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(path)
}

/** `assets/x.glb` and `/assets/x.glb` are the same asset. Normalise to one. */
function stripLeadingSlashes(path: string): string {
  return path.replace(/^\/+/, '')
}

/**
 * Join an asset base with a content path.
 *
 * Tolerates a trailing slash (or several) on the base and a missing or extra
 * leading slash on the path. `base === '/'` is local mode and yields an
 * app-absolute path. A blank base throws — callers must not paper over a
 * missing configuration by fetching a relative URL that 404s later.
 *
 * Exported for tests and for tooling that knows its base from somewhere other
 * than the environment; runtime code calls {@link assetUrl}.
 */
export function joinAssetUrl(base: string, path: string): string {
  if (isAbsoluteUrl(path)) return path

  const trimmed = base.trim()
  if (trimmed === '') throw new MissingAssetBaseUrlError()
  if (trimmed === LOCAL_ASSET_BASE) return `/${stripLeadingSlashes(path)}`

  const root = trimmed.replace(/\/+$/, '')
  return `${root}/${stripLeadingSlashes(path)}`
}

/**
 * Read the configured base, or `null` when it is absent or blank.
 *
 * Read on every call rather than cached at module load: Vite inlines the
 * literal at build time, so this costs nothing in the browser, and it keeps the
 * module honest under Vitest's `vi.stubEnv`.
 */
export function assetBaseUrlOrNull(): string | null {
  let raw: unknown
  try {
    // Static member access so Vite's define replacement fires.
    raw = import.meta.env.VITE_ASSET_BASE_URL
  } catch {
    return null
  }
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * The configured base, or throw. Call this once at boot (before the first
 * frame, before any loader) so a misconfigured deploy fails with this message
 * rather than with a wall of failed GLB fetches.
 */
export function assetBaseUrl(): string {
  const base = assetBaseUrlOrNull()
  if (base === null) throw new MissingAssetBaseUrlError()
  return base
}

/** Cheap boot-gate predicate: is content addressable at all? */
export function hasAssetBaseUrl(): boolean {
  return assetBaseUrlOrNull() !== null
}

/** True when content is being served from the local `public/` tree. */
export function isLocalAssetBase(): boolean {
  return assetBaseUrlOrNull() === LOCAL_ASSET_BASE
}

/**
 * Resolve a content path (`assets/ships/hoverjet.glb`) to the URL to fetch.
 *
 * Every asset load in the game goes through here. Absolute URLs pass through
 * unchanged; anything else requires `VITE_ASSET_BASE_URL` and throws without
 * it.
 */
export function assetUrl(path: string): string {
  if (isAbsoluteUrl(path)) return path
  return joinAssetUrl(assetBaseUrl(), path)
}
