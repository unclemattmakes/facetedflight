/**
 * tests/e2e/racer-contact.spec.ts — the racers keep apart, and you can push
 * them, in the running game. DEV-364.
 *
 * Matt, 2026-09-24: *"right now our ai racers tend to converge on the same path
 * - can you have them avoid each other (or give collision so we can push them)
 * - right now players can fly straight into them and through them."*
 *
 * `racer-contact.test.ts` proves the rule headless. What it cannot see is that
 * `boot/app.ts` hands the live preset and the player's body to the racers every
 * fixed step — the one wire this row adds to the game — so this flies it:
 *
 *   1. THE PACK. The autopilot, on `int_01`, from GO through the first corners,
 *      the chase camera behind the player. Every frame, the closest two craft —
 *      five racers and you — are measured centre to centre. Two capsules of
 *      the sheet's hull cannot overlap while their centres are more than a
 *      beam less the capsule's axis apart (3.97 m), so the floor asserted is
 *      that: geometry, not the rule's own report. Before DEV-364 pairs flew
 *      0.15 m apart.
 *   2. THE RAM. The player's own autopilot flies the line, and the racer on
 *      the centre lane, slower and ahead of it on the same line, does not get
 *      out of the way of what comes up behind it. The player must reach it
 *      (touching distance), contact must FIRE (the running total the racers
 *      report), nobody may overlap, and nobody crashes. Burst close. Since the
 *      DEV-364 follow-up the player must also take a HIT for it (the sim's
 *      count, and the game's `data-racer-hits` receipt written beside the
 *      `ship.hit` cue).
 *
 * `RACER_CONTACT_DIR` bursts both flights, pinned, with the pin in every name —
 * a still misses motion. Playwright wipes `test-results/` on every run.
 *
 *   RACER_CONTACT_DIR=<dir> E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/racer-contact.spec.ts --workers 1
 *
 * Same build, same code path: the autopilot, the keys and `?view=chase` are
 * the game's own. `@gpu`, headed, hydrated assets.
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold } from './fixtures/freeze'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const MISSION = 'int_01_hoverJet'
const OUT = process.env.RACER_CONTACT_DIR ?? ''
const PIN_TAG = PINNED.replace(/[=&]/g, '')
/** Two capsules (radius 2.217, axis 0.46 m) cannot overlap with centres further apart than this. */
const NO_OVERLAP_FLOOR = 3.97

interface Probe {
  readonly phase: string
  readonly elapsed: number
  readonly minCentre: number
  readonly minPair: string
  /** The player's own closest racer, centre to centre, and who. */
  readonly minPlayer: number
  readonly minPlayerId: string
  readonly frames: number
  readonly total: number
  readonly hardestEver: number
  readonly crashes: number
  readonly racerCrashes: number
  /** DEV-364 follow-up: hits the PLAYER took, by the sim's count and the game's receipt. */
  readonly hits: number
  readonly strongest: number
  readonly hitReceipt: number
}

/** Install a per-frame collector of the closest two craft, once. */
const installCollector = (page: Page) =>
  page.evaluate(() => {
    type Body = { position: { x: number; y: number; z: number } }
    const w = globalThis as unknown as {
      __ff2: {
        racers: () => { racers: { spec: { id: string }; jet: { body: Body } }[] } | null
        flight: () => { jet: { body: Body } } | null
      }
      __rc?: {
        minCentre: number
        minPair: string
        minPlayer: number
        minPlayerId: string
        frames: number
      }
    }
    if (w.__rc) return
    const rc = {
      minCentre: Number.POSITIVE_INFINITY,
      minPair: '',
      minPlayer: Number.POSITIVE_INFINITY,
      minPlayerId: '',
      frames: 0,
    }
    w.__rc = rc
    const loop = () => {
      const racers = w.__ff2.racers()?.racers ?? []
      const player = w.__ff2.flight()?.jet?.body
      const craft = racers.map((r) => ({ id: r.spec.id, p: r.jet.body.position }))
      if (player) craft.push({ id: 'player', p: player.position })
      for (let i = 0; i < craft.length; i++) {
        for (let j = i + 1; j < craft.length; j++) {
          const a = craft[i] as (typeof craft)[number]
          const b = craft[j] as (typeof craft)[number]
          const d = Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y, a.p.z - b.p.z)
          if (d < rc.minCentre) {
            rc.minCentre = d
            rc.minPair = `${a.id}-${b.id}`
          }
          if (b.id === 'player' && d < rc.minPlayer) {
            rc.minPlayer = d
            rc.minPlayerId = a.id
          }
        }
      }
      rc.frames++
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })

const probe = (page: Page): Promise<Probe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: {
        launch: () => { phase: string }
        mission: { elapsed: number }
        racers: () => {
          contact: { total: number; hardestEver: number }
          hit: { total: number; strongest: number }
          racers: { crash: { count: number } }[]
        } | null
      }
      __rc?: {
        minCentre: number
        minPair: string
        minPlayer: number
        minPlayerId: string
        frames: number
      }
    }
    const r = w.__ff2.racers()
    return {
      phase: w.__ff2.launch().phase,
      elapsed: w.__ff2.mission.elapsed,
      minCentre: w.__rc?.minCentre ?? Number.POSITIVE_INFINITY,
      minPair: w.__rc?.minPair ?? '',
      minPlayer: w.__rc?.minPlayer ?? Number.POSITIVE_INFINITY,
      minPlayerId: w.__rc?.minPlayerId ?? '',
      frames: w.__rc?.frames ?? 0,
      total: r?.contact.total ?? 0,
      hardestEver: r?.contact.hardestEver ?? 0,
      crashes: Number(document.body.dataset.crashes ?? '0'),
      racerCrashes: (r?.racers ?? []).reduce((n, x) => n + x.crash.count, 0),
      hits: r?.hit.total ?? 0,
      strongest: r?.hit.strongest ?? 0,
      hitReceipt: Number(document.body.dataset.racerHits ?? '0'),
    }
  })

/** Load, launch, and wait for the lift to let go. */
const launch = async (page: Page, query: string): Promise<void> => {
  await page.goto(`/?${query}&${PINNED}`)
  await firstPress(page)
  await missionReady(page, 240_000)
  await focusCanvas(page)
  await hold(page, 'Enter')
  await expect
    .poll(async () => (await probe(page)).phase, { timeout: 120_000, intervals: [100] })
    .toBe('flying')
  await installCollector(page)
}

/** Screenshots every `everyMs` for `seconds`, into `RACER_CONTACT_DIR` when set. */
const burst = async (
  page: Page,
  name: string,
  seconds: number,
  everyMs: number,
  onFrame?: () => Promise<void>,
) => {
  const end = Date.now() + seconds * 1000
  let i = 0
  while (Date.now() < end) {
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true })
      const shot = await page.locator('#viewport').screenshot()
      fs.writeFileSync(path.join(OUT, `${name}-${PIN_TAG}-${String(i).padStart(3, '0')}.png`), shot)
    }
    i++
    await onFrame?.()
    await page.waitForTimeout(everyMs)
  }
}

test.describe('@gpu DEV-364: the racers keep apart, and you can push them', () => {
  test.setTimeout(600_000)

  test(`the pack through ${MISSION}'s first corners, nobody inside anybody`, async ({ page }) => {
    await launch(
      page,
      `autopilot=1&xr=off&edition=anniversary&mission=${MISSION}&view=chase&chase=player&chaseOffset=0,12,36`,
    )
    await burst(page, 'pack', 22, 250)
    const p = await probe(page)
    console.info(
      `racer-contact pack: ${p.frames} frames to ${p.elapsed.toFixed(1)} s · closest ${p.minCentre.toFixed(2)} m (${p.minPair}) · contacts ${p.total}, hardest ${p.hardestEver.toFixed(1)} m/s · crashes ${p.crashes} player, ${p.racerCrashes} racers`,
    )
    expect(p.frames, 'the collector ran').toBeGreaterThan(100)
    expect(p.minCentre, `closest pair ${p.minPair}`).toBeGreaterThan(NO_OVERLAP_FLOOR)
  })

  test('the player flies into the racer on its line: it is pushed, nobody passes through, nobody crashes', async ({
    page,
  }) => {
    // The player's own autopilot (P — a player's feature, not a harness
    // switch) flies the racing line, and the racer on the CENTRE lane leaves
    // the grid 27.5 m ahead of it on the same line, slower. Racers keep off
    // what is ahead of them and not what is behind, so the player comes up
    // behind it and hits it: measured headless on the shipped preset, 1.26 s
    // after GO at 20.9 m/s of closing speed. Before DEV-364 the player flew
    // straight through the same ship.
    //
    // A KEYBOARD pilot scripted into this spec was tried four times first and
    // is not what flies here: from the back of the grid, on/off keys either
    // lost the target or flew into the sea ten metres under the start line.
    // The burst is the same meeting from a closer camera.
    await launch(
      page,
      `autopilot=1&xr=off&edition=anniversary&mission=${MISSION}&view=chase&chase=player&chaseOffset=3,4,16`,
    )
    await burst(page, 'ram', 6, 100)
    const p = await probe(page)
    console.info(
      `racer-contact ram: closest to the player ${p.minPlayer.toFixed(2)} m (${p.minPlayerId}) · ${p.frames} frames to ${p.elapsed.toFixed(1)} s · closest pair ${p.minCentre.toFixed(2)} m (${p.minPair}) · contacts ${p.total}, hardest ${p.hardestEver.toFixed(1)} m/s · hits on the player ${p.hits} (receipt ${p.hitReceipt}), strongest ${p.strongest.toFixed(2)} · crashes ${p.crashes} player, ${p.racerCrashes} racers`,
    )
    // The player reached a racer — touching distance: one hull length nose to
    // tail (4.435 m beam + 0.46 m axis), one beam abreast …
    expect(p.minPlayer, `the player's closest racer, ${p.minPlayerId}`).toBeLessThan(4.95)
    // … the push fired …
    expect(p.total, 'the push fired').toBeGreaterThan(0)
    // … and it COST the player something (the DEV-364 follow-up): the sim's hit
    // rule fired, and the game took it off the report and played the cue —
    // `data-racer-hits` is written beside the `ship.hit` event, as `crashes` is
    // beside the crash's.
    expect(p.hits, 'the player took a hit').toBeGreaterThan(0)
    expect(p.hitReceipt, "the game's receipt: the cue was played").toBe(p.hits)
    // … nobody was ever inside anybody …
    expect(p.minCentre, `closest pair ${p.minPair}`).toBeGreaterThan(NO_OVERLAP_FLOOR)
    // … and nobody crashed.
    expect(p.crashes, 'the player did not crash').toBe(0)
    expect(p.racerCrashes, 'no racer crashed').toBe(0)
  })
})
