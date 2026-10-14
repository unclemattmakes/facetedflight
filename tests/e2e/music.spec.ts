/**
 * DEV-247 — a track from the shipped soundtrack actually DECODES in a browser.
 *
 * ── Why this spec exists ─────────────────────────────────────────────────
 *
 * The soundtrack landed on 2026-09-13 with 85 unit tests behind it, and not
 * one of them fetches a byte: they run against a recording backend in node,
 * where "loaded" means an object was returned. Everything downstream of the
 * URL — whether the asset base resolves, whether the server answers with audio
 * or with a page, whether this browser's `decodeAudioData` will take Ogg Opus
 * — lived in a gap between a node test that cannot fetch and an e2e suite that
 * never listened.
 *
 * What was in that gap: `music.ts` was the one loader in the game that did not
 * go through `assetUrl()`, so it fetched a path relative to the DOCUMENT. In
 * dev that is the same URL by accident (`VITE_ASSET_BASE_URL=/`, page at `/`).
 * On the deployed site it is `ff-10yr.pages.dev/assets/audio/music/*.opus`,
 * which the Pages SPA fallback answers `200 text/html` — so the game fetched
 * its own index page six times, failed to decode it six times, and printed
 * *"no playable tracks (6 tried)"*. Measured 2026-09-20, live.
 *
 * ── What it asserts, and why that and not something easier ───────────────
 *
 * `seconds`, from `__ff2.music()`, is the decoded length off the
 * `AudioBuffer`. It is the only observable here that a BROKEN soundtrack
 * cannot produce. Each of the easier ones was true throughout:
 *
 *   - `data-audio="running"`   — the device was fine; the files never arrived.
 *   - a track is `playing`     — the shuffle picks before a byte is fetched.
 *   - no page error            — a failed load is a warning, by design.
 *   - the `.opus` files exist  — they do, and `assets:check` verifies them.
 *
 * ── What this spec canNOT separate, and where that is done instead ──────
 *
 * It does not prove the `assetUrl()` half of DEV-247. The suite runs with
 * `VITE_ASSET_BASE_URL=/` and the page is at `/`, so the resolved URL and the
 * old bare relative one are **the same string** — bug and fix agree here, and
 * CLAUDE.md's agreement lesson says a rule tested only where two explanations
 * agree has not been tested. Separating them needs a base on its own origin,
 * which is the deployed configuration and not this one.
 *
 * That half is asserted against the SOURCE in
 * `tests/unit/soundtrack-assets.test.ts`, which does go red on the pre-fix
 * wiring. What this spec adds is everything downstream of the URL, which no
 * node test can reach: a real fetch, a real `decodeAudioData`, a real codec.
 *
 * ── The path is the player's ─────────────────────────────────────────────
 *
 * Nothing here is stubbed and no switch changes the build (CLAUDE.md). Start
 * is a real click, the confirm is a real key press — a user activation in
 * Chrome, which is what unlocks the `AudioContext` for a player too — and the
 * music starts off `launch.start`, the same event `app.ts` already sends. The
 * harness only reads.
 *
 * Tagged `@gpu`: it drives terrain and the autopilot for real.
 */

import { SOUNDTRACK } from '@/content/soundtrack'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { expect, test } from './fixtures/test'

/** What `__ff2.music()` answers. Mirrors the accessor in `boot/app.ts`. */
interface MusicProbe {
  readonly tracks: number
  readonly track: string | null
  readonly seconds: number | null
  readonly running: boolean
}

const probe = async (page: import('@playwright/test').Page): Promise<MusicProbe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    return w.__ff2?.music() ?? { tracks: 0, track: null, seconds: null, running: false }
  })

/**
 * The shortest track in the set is a little over two minutes, so any decode
 * that really happened clears this by 70 s. A page of HTML, a truncated file
 * or a 404 body cannot reach it at all — most cannot be decoded into anything.
 *
 * A floor rather than a per-track length: which track comes up is a shuffle,
 * and pinning the expected duration to it would make this spec a second copy
 * of the manifest instead of a question about the browser.
 */
const DECODED_FLOOR_SECONDS = 60

/** Held for a few frames — the confirm input is a level, read once a frame. */
const confirmPress = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.keyboard.down('Enter')
  await page.waitForTimeout(200)
  await page.keyboard.up('Enter')
}

test.describe('@gpu the soundtrack in a real browser', () => {
  test.setTimeout(600_000)

  test('a shipped track is fetched, decoded, and sounding', async ({ page }) => {
    const problems = watchPageErrors(page)
    const warnings: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text())
    })

    await page.goto('/?autopilot=1&xr=off&mission=int_01_hoverJet')
    await firstPress(page)
    await missionReady(page, 180_000)
    await focusCanvas(page)

    // The gesture that builds the `AudioContext`, exactly as a player's does.
    await confirmPress(page)
    await expect(page.locator('body')).toHaveAttribute('data-audio', 'running', {
      timeout: 20_000,
    })

    // The playlist is installed at boot, before any of this. If it is empty
    // the rest of the test is vacuous, so say so here rather than time out
    // below on a mystery.
    expect((await probe(page)).tracks, 'no soundtrack is installed').toBe(SOUNDTRACK.length)

    // `launch.start` fires when the ship goes; the decode follows it.
    await expect
      .poll(async () => (await probe(page)).seconds, {
        timeout: 120_000,
        message: 'no track ever reported a decoded length — nothing was fetched or nothing decoded',
      })
      .not.toBeNull()

    const music = await probe(page)
    expect(music.seconds ?? 0).toBeGreaterThan(DECODED_FLOOR_SECONDS)
    expect(
      SOUNDTRACK.map((t) => t.id),
      `the playlist is sounding "${music.track}", which is not in the shipped set`,
    ).toContain(music.track)

    // The symptom itself, as a regression guard: this line is what every perf
    // run printed, and it is what a wrong asset base prints again.
    expect(
      warnings.filter((w) => w.includes('no playable tracks')),
      'the playlist gave up on the whole soundtrack',
    ).toEqual([])
    expect(
      warnings.filter((w) => w.includes('did not load')),
      'a track failed to load, and the backend said why',
    ).toEqual([])

    expect(problems.list(), problems.list().join('\n')).toEqual([])
  })

  // DEV-962: the soundtrack is STREAMED, not decoded to PCM. A decoded track
  // is raw float samples (about 86 MB for the biggest, twice that across a
  // crossfade); an element holds the compressed bytes. The observer below only
  // counts what the page asks Web Audio for, and the flow is the player's.
  test('DEV-962: a track streams through an element, and GO crossfades into another', async ({
    page,
  }) => {
    const problems = watchPageErrors(page)
    const warnings: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text())
    })
    await page.addInitScript(() => {
      const stats = { decodes: 0, decodedBytes: 0, mediaNodes: 0, mediaSrcs: [] as string[] }
      ;(globalThis as unknown as { __musicStats: typeof stats }).__musicStats = stats
      const decode = AudioContext.prototype.decodeAudioData
      AudioContext.prototype.decodeAudioData = function (
        this: AudioContext,
        ...args: Parameters<AudioContext['decodeAudioData']>
      ) {
        return decode.apply(this, args).then((b) => {
          stats.decodes += 1
          stats.decodedBytes += b.length * b.numberOfChannels * 4
          return b
        })
      } as typeof decode
      const media = AudioContext.prototype.createMediaElementSource
      AudioContext.prototype.createMediaElementSource = function (
        this: AudioContext,
        element: HTMLMediaElement,
      ) {
        stats.mediaNodes += 1
        stats.mediaSrcs.push(element.currentSrc)
        return media.call(this, element)
      }
    })
    const stats = () =>
      page.evaluate(
        () =>
          (
            globalThis as unknown as {
              __musicStats: {
                decodes: number
                decodedBytes: number
                mediaNodes: number
                mediaSrcs: string[]
              }
            }
          ).__musicStats,
      )

    await page.goto('/?autopilot=1&xr=off&mission=int_01_hoverJet')
    await firstPress(page)
    await missionReady(page, 180_000)
    await focusCanvas(page)
    await confirmPress(page)
    await expect(page.locator('body')).toHaveAttribute('data-audio', 'running', {
      timeout: 20_000,
    })
    await expect.poll(async () => (await probe(page)).seconds, { timeout: 120_000 }).not.toBeNull()
    const first = await probe(page)
    expect(first.seconds ?? 0).toBeGreaterThan(DECODED_FLOOR_SECONDS)
    const afterFirst = await stats()
    // The count, for whoever reads the run: PCM bytes the page decoded, which
    // is what the heap held for music (0 when streaming).
    console.log(`music memory after the first track: ${JSON.stringify(afterFirst)}`)
    expect(afterFirst.decodes, 'the first track was decoded to PCM instead of streamed').toBe(0)
    expect(afterFirst.decodedBytes).toBe(0)
    expect(afterFirst.mediaNodes).toBe(1)

    // GO brings in a NEW track over the lift's (DEV-423): a second element,
    // alongside the first for the length of the cut, still nothing decoded.
    await expect
      .poll(async () => (await probe(page)).track, {
        // GO is the end of the lift ride and the countdown; measured at about
        // 150 s from the first track on a shared box, so well clear of it.
        timeout: 300_000,
        message: 'GO never brought in a second track',
      })
      .not.toBe(first.track)
    await expect.poll(async () => (await stats()).mediaNodes, { timeout: 30_000 }).toBe(2)
    const afterGo = await stats()
    expect(afterGo.decodes).toBe(0)
    expect(new Set(afterGo.mediaSrcs).size, 'two different files streamed').toBe(2)
    expect(warnings.filter((w) => w.includes('would not stream'))).toEqual([])
    expect(warnings.filter((w) => w.includes('no playable tracks'))).toEqual([])
    expect(problems.list(), problems.list().join('\n')).toEqual([])
  })
})
