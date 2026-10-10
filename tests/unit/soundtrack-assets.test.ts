/**
 * tests/unit/soundtrack-assets.test.ts — the soundtrack the CODE asks for and
 * the files the MANIFEST promises are the same set. (DEV-247.)
 *
 * ── What this closes ─────────────────────────────────────────────────────
 *
 * `pnpm assets:check` already verifies, by sha256, that every `state: ready`
 * row in `required-assets.json` is on disk with the right bytes — the six
 * tracks included. It is a good gate and it was working the whole time the
 * game was silent, because it only ever looks in ONE direction: manifest →
 * disk. Nothing looked from `src/content/soundtrack.ts` → manifest, so a track
 * added, renamed or re-pathed in code was a file nothing required, nothing
 * pulled, and nothing verified. The game's own answer to that state is a
 * console line.
 *
 * This is the other direction, and it is deliberately the CHEAP half: pure
 * JSON against a pure module, no bytes, no disk beyond the manifest. That is
 * what lets it run in `pnpm check` and on a CI host that has never seen the
 * content tree — which is exactly where the expensive half cannot run.
 *
 * ── Why not check the bytes here too ─────────────────────────────────────
 *
 * Because `assets:check` does, and a second copy would be a second thing to
 * keep true. More to the point, a byte check here would have to be guarded on
 * a hydrated `public/` — and a guarded suite that nobody notices is skipped
 * reads as a pass in a summary line. CLAUDE.md has that trap twice over
 * (`describe.skipIf` evaluating its body, and the census baseline's silent
 * skip). One unconditional assertion beats two conditional ones.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SOUNDTRACK } from '@/content/soundtrack'
import { appSource } from './helpers/app-source'
import { REPO as ROOT } from './helpers/repo-root'

interface AssetRow {
  readonly id: string
  readonly path: string
  readonly state?: string
  readonly bytes?: number
  readonly sha256?: string
  readonly licence?: string
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'tools', 'assets', 'required-assets.json'), 'utf8'),
) as { assets: AssetRow[] }

/** The music FILES the manifest carries — the prefix row is not one of them. */
const musicRows = manifest.assets.filter((a) => a.path.endsWith('.opus'))

const rowFor = (src: string): AssetRow | undefined => manifest.assets.find((a) => a.path === src)

describe('the soundtrack the code asks for is the soundtrack the manifest promises', () => {
  it('every track has a manifest row at exactly the path the code fetches', () => {
    const missing = SOUNDTRACK.filter((t) => rowFor(t.src) === undefined).map(
      (t) => `${t.id} -> ${t.src}`,
    )
    expect(
      missing,
      'a track with no row is a file `assets:pull` will not fetch and `assets:check` will not verify',
    ).toEqual([])
  })

  it('and no row is orphaned by a track the code dropped', () => {
    const wanted = new Set(SOUNDTRACK.map((t) => t.src))
    const orphans = musicRows.filter((r) => !wanted.has(r.path)).map((r) => r.id)
    expect(
      orphans,
      'a row nothing references is a required download for a track that no longer plays',
    ).toEqual([])
  })

  it('every track is `ready` and verifiable by content, not just by name', () => {
    for (const track of SOUNDTRACK) {
      const row = rowFor(track.src)
      expect(row, `${track.id} has no manifest row`).toBeDefined()
      if (!row) continue
      // `ready` is what makes `check-assets-present.mjs` treat a missing file
      // as an ERROR rather than as a plan. A `staged` soundtrack would pass
      // that tool while absent.
      expect(row.state, `${track.id} must be ready, or a missing file is not an error`).toBe(
        'ready',
      )
      // Bytes and a name are what the pre-Trap-21 check compared, and the
      // HoverJet shipped backwards through both. Only the sha is evidence.
      expect(row.sha256 ?? '', `${track.id} has no sha256 — nothing verifies its content`).toMatch(
        /^[0-9a-f]{64}$/,
      )
      expect(row.bytes ?? 0, `${track.id} has no byte count`).toBeGreaterThan(0)
    }
  })

  it('every track carries a licence that can actually ship', () => {
    // Not a copy of `check-assets-present.mjs`'s rule (`ready` + `REPLACE` is
    // refused there): this asks the stronger question the soundtrack itself
    // has to answer, which is that the grant is affirmative rather than
    // merely not-yet-refused. D31 chose CC0 so that answer is easy.
    for (const track of SOUNDTRACK) {
      expect(rowFor(track.src)?.licence, `${track.id}`).toBe('KEEP')
      expect(track.licence, `${track.id} must name the grant it ships under`).not.toBe('')
    }
  })

  it('and the boot wiring resolves them, because nothing downstream does', () => {
    // ── Why this is a grep and not a call (DEV-247) ──────────────────────
    //
    // The bug was that `music.ts` fetched `track.src` verbatim, so the browser
    // resolved it against the document: correct in dev by coincidence, and
    // `200 text/html` from the Pages SPA fallback on the deployed site.
    //
    // The fix resolves at the wiring point in `boot/app.ts`, and it has to be
    // there rather than in `music.ts`: `assetUrl()` reads `import.meta.env`,
    // and a build-tool global anywhere under `src/audio/` makes that module
    // unreachable from Playwright, which then collects ZERO tests for the
    // whole suite (`tests/unit/e2e-import-graph.test.ts`, which refused this
    // exact edge when it was tried).
    //
    // That leaves one line in a 10,000-line file as the only thing standing
    // between the soundtrack and silence, with no unit test able to reach it
    // — `bootApp` needs a DOM, a renderer and a level. So this asserts the
    // SOURCE, in the idiom `xr-eye-layers.test.ts` and the program-cache-key
    // guard already use: cheaper than the bug, and it runs in CI.
    const app = appSource()
    const call = app.match(/audio\.music\.setTracks\([\s\S]{0,200}?\)\n/)
    expect(call, 'app.ts no longer installs the soundtrack').not.toBeNull()
    expect(
      call?.[0] ?? '',
      'the soundtrack must be resolved through assetUrl() on the way in, or every ' +
        'track is fetched relative to the document and the deployed game is silent',
    ).toContain('assetUrl(')
  })

  it('the paths are content-relative, so `assetUrl()` decides where they live', () => {
    // A leading slash or a scheme would pin the soundtrack to one origin and
    // walk straight past the asset base — which is the DEV-247 bug in the
    // shape it would come back in.
    for (const track of SOUNDTRACK) {
      expect(track.src, `${track.id}`).toMatch(/^assets\/audio\/music\/[a-z0-9-]+\.opus$/)
    }
  })
})
