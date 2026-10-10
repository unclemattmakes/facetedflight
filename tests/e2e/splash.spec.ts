/**
 * tests/e2e/splash.spec.ts: DEV-613, a splash where anything crosses the sea,
 * in the real build.
 *
 * `tests/unit/splash.test.ts` holds the rule (when a dolphin and a jet cross),
 * the shapes (a ring and drops, up), the scale and the pool. What only the
 * running game can say:
 *
 *   · THE PROGRAM WAS BUILT BEFORE THE FIRST SPLASH: both parts' materials have
 *     a program before anything has been thrown (the warm-up drew the empty
 *     fields), the same program after, and the program count does not move
 *     across a still camera's first splash (a count, never a millisecond). A
 *     placed jet is not counted across: the place it is put brings its own
 *     terrain, so there the same-program check is the gate;
 *   · BOTH EYES: the two fields are on layer 0 alone, never the WebXR eye
 *     layers 1 or 2 (CLAUDE.md, DEV-141);
 *   · and what a splash LOOKS like: a dolphin's, from a still camera beside
 *     the last splash thrown, and a HoverJet's (the player's and a racer's),
 *     put over open water and flown into it by the sim, at a flat 1280 x 720
 *     and a 1200 square headset-sized frame.
 *
 * The jet is placed with the flight's own `placeAt`, the door the crash reset
 * uses, and the sim does the rest: the contact, the crash rule, the splash.
 *
 *   SPLASH_SHOT_DIR=<dir> E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/splash.spec.ts --workers 1
 *
 * `@gpu`, hydrated assets, pinned `adaptive=0&quality=high` (in every name).
 */

import type { Page } from '@playwright/test'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import type { Ff2Global } from './fixtures/ff2'
import { hold } from './fixtures/freeze'
import { firstPress } from './fixtures/landing'
import { bootStill, programCount, stand } from './fixtures/life'
import { photographer } from './fixtures/photo'
import { PINNED } from './fixtures/quality-pin'
import { expect, test } from './fixtures/test'

const SHOT_DIR = process.env.SPLASH_SHOT_DIR ?? 'test-results/splash'
const PIN_TAG = PINNED.replace(/[=&]/g, '_')
const MISSION = 'int_01_hoverJet'

interface SplashProbe {
  thrown: number
  alive: number
  emitters: number
  capacity: number
  last: { x: number; y: number; z: number; scale: number } | null
}

const splash = (page: Page): Promise<SplashProbe | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.splash())

/** Both parts' meshes: their layer masks, and whether their programs exist yet. */
const fields = (page: Page) =>
  page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: a probe of three's own objects
    const w = globalThis as any
    const { scene, renderer } = w.__ff2.render
    return ['particles:splashCrown', 'particles:splashDrops'].map((name) => {
      const mesh = scene.getObjectByName(name)
      const program = mesh ? renderer.properties.get(mesh.material)?.currentProgram : null
      return {
        name,
        found: Boolean(mesh),
        layers: mesh ? (mesh.layers.mask as number) : -1,
        compiled: Boolean(program),
        program: program ? (program.id as number) : -1,
      }
    })
  })

const shoot = photographer(SHOT_DIR, PIN_TAG)

const SIZES = [
  { tag: 'flat1280', viewport: { width: 1280, height: 720 } },
  { tag: 'head1200', viewport: { width: 1200, height: 1200 } },
] as const

for (const size of SIZES) {
  test.describe(`@gpu DEV-613: the splash, ${size.tag}`, () => {
    test.use({ viewport: size.viewport })
    test.setTimeout(600_000)

    test(`a dolphin's, from beside it, on ${MISSION}`, async ({ page }) => {
      await bootStill(page, MISSION, `edition=anniversary&${PINNED}`)
      const ready = await splash(page)
      expect(ready, 'no splash field: the flag was off at load').not.toBeNull()
      const parts = await fields(page)
      console.log(`DEV-613 ${size.tag} fields: ${JSON.stringify(parts)}`)
      for (const f of parts) {
        expect(f.found, `${f.name} is not in the scene`).toBe(true)
        // Layer 0 alone: drawn to both eyes, the same.
        expect(f.layers, `${f.name} layer mask`).toBe(1)
        expect(f.compiled, `${f.name} had no program before its first splash`).toBe(true)
      }
      const programsBefore = await programCount(page)
      // Wait for a dolphin to cross (periods of 4-7 s), the camera unmoved.
      await expect
        .poll(async () => (await splash(page))?.thrown ?? 0, { timeout: 60_000 })
        .toBeGreaterThan(0)
      await page.waitForTimeout(500)
      const programsAtFirst = await programCount(page)
      console.log(
        `  programs ${programsBefore} before any splash, ${programsAtFirst} after the first`,
      )
      expect(programsAtFirst, 'the first splash compiled a program').toBe(programsBefore)
      // Then stand beside the next ones.
      let shots = 0
      let seen = (await splash(page))?.thrown ?? 0
      for (let i = 0; i < 400 && shots < 2; i++) {
        await page.waitForTimeout(50)
        const s = await splash(page)
        if (!s?.last || s.thrown === seen) continue
        seen = s.thrown
        const p = s.last
        // Low and to one side, 9 m off, looking at the water where it crossed.
        await stand(page, [p.x + 7, p.y + 2.5, p.z + 5.5], [p.x, p.y + 1.2, p.z])
        const file = await shoot(page, `dolphin-${MISSION}-${size.tag}-${shots}`)
        console.log(
          `  ${file}: splash #${s.thrown} at scale ${p.scale.toFixed(2)}, ${s.alive} pieces up`,
        )
        shots++
        await page.waitForTimeout(1_500)
      }
      expect(shots).toBeGreaterThan(0)
      const after = (await splash(page)) as SplashProbe
      console.log(`  ${after.thrown} thrown; pieces ${after.alive} of ${after.capacity}`)
      expect(after.alive).toBeLessThanOrEqual(after.capacity)
      const same = await fields(page)
      expect(
        same.map((f) => f.program),
        'a splash part changed program',
      ).toEqual(parts.map((f) => f.program))
    })

    // The two jets, each put over open water by the harness and flown in by
    // the sim, photographed from a still camera beside where it goes in.
    // Measured: put in at 20, 38 and 70 m/s down from 14 m over the drawn sea,
    // neither threw a splash within the poll (why is not established, and the
    // track below is printed for the next reader if a dive stops landing; the
    // poll then read only the probe's newest splash, which a dolphin's can
    // replace a frame later, so that may be why, not re-measured); at
    // 160 m/s down from 20 m both went in at about 35 m/s, under DEV-126's
    // crash threshold, and splashed, on DEV-613's branch. Not reliably: the
    // HoverJet's drag takes a dive from 160 to nothing in about 17 to 19 m, the
    // racer's sooner (its autopilot pulls up), and `t.y` is a dolphin's splash
    // height, which a wave and the leap move by metres. Measured on 358e9a48
    // (w40): the sea's contact stands at y 117.4 there, the racer bottomed out
    // at 118.4 to 120.2 in eight runs of twelve and climbed away dry. From 12 m
    // both reach it. A crash's splash is the same contact, faster; the
    // player's is behind the crash rule's curtain, a racer's is not.
    for (const arm of [
      // THREE world: start this far back along -z from the target, this high,
      // moving this way.
      { name: 'player-dive', who: 'player', back: 8, up: 12, vy: -160, vz: -60 },
      { name: 'racer-dive', who: 'racer', back: 8, up: 12, vy: -160, vz: -60 },
    ] as const) {
      test(`a HoverJet's ${arm.name} into the sea, on ${MISSION}`, async ({ page }) => {
        await page.goto(
          `/?xr=off&title=0&menu=0&ride=0&mission=${MISSION}&edition=anniversary&${PINNED}` +
            '&view=cam&eye=0,300,0&look=100,116,0',
        )
        await firstPress(page)
        await missionReady(page, 240_000)
        await focusCanvas(page)
        await hold(page, 'Enter')
        await expect
          .poll(
            () => page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.launch().phase),
            { timeout: 120_000 },
          )
          .toBe('flying')
        // Open water, and its drawn height: where a dolphin last crossed it
        // (a pod wants 8 m of water under it). `seaRestY` is the ocean
        // field's origin, not the surface.
        await expect
          .poll(async () => (await splash(page))?.thrown ?? 0, { timeout: 60_000 })
          .toBeGreaterThan(0)
        const t = (await splash(page))?.last as { x: number; y: number; z: number }
        await stand(page, [t.x + 26, t.y + 7, t.z + 16], [t.x, t.y + 3, t.z])
        await page.waitForTimeout(1_000)
        const programsBefore = await programCount(page)
        const partsBefore = await fields(page)
        expect(
          partsBefore.every((f) => f.compiled),
          'no splash program before the first',
        ).toBe(true)
        // Every splash from here on, as the page sees it frame by frame. The
        // probe's `last` is only the newest, and the pod keeps leaping: read
        // once a poll, a dolphin's landing a frame after the jet's splash
        // took its place, and the jet's went unseen (measured on 358e9a48:
        // the jet's at scale 4.12 where it hit, then a dolphin's 0.82 some
        // 300 m away, one probe apart, and the arm failed with the splash on
        // screen). The recorder watches; it changes nothing in the game.
        await page.evaluate(() => {
          // biome-ignore lint/suspicious/noExplicitAny: the game's own handles
          const w = globalThis as any
          const log: SplashProbe['last'][] = []
          let seen = w.__ff2.splash()?.thrown ?? 0
          let skipped = 0
          const watch = (): void => {
            const s = w.__ff2.splash() as SplashProbe | null
            if (s && s.thrown !== seen) {
              // Two in one frame: only the newest is readable.
              skipped += Math.max(0, s.thrown - seen - 1)
              seen = s.thrown
              if (s.last) log.push({ ...s.last })
            }
            w.__splashLog = { log, skipped }
            requestAnimationFrame(watch)
          }
          requestAnimationFrame(watch)
        })
        const placed = await page.evaluate(
          ({ who, back, up, vy, vz, t: at }) => {
            // biome-ignore lint/suspicious/noExplicitAny: the game's own handles
            const w = globalThis as any
            // THREE -> SIM: z flips, for the place and the velocity.
            const pos = { x: at.x, y: at.y + up, z: -(at.z + back) }
            const vel = { x: 0, y: vy, z: -vz }
            if (who === 'player') {
              const flight = w.__ff2.flight()
              if (!flight) return false
              flight.placeAt(pos, { x: 0, y: 0, z: 0, w: 1 }, vel)
              return true
            }
            const racer = w.__ff2.racers()?.racers?.[0]
            if (!racer) return false
            Object.assign(racer.jet.body.position, pos)
            Object.assign(racer.jet.body.velocity, vel)
            return true
          },
          { who: arm.who, back: arm.back, up: arm.up, vy: arm.vy, vz: arm.vz, t },
        )
        expect(placed, `no ${arm.who} to place`).toBe(true)
        // A jet's splash is the one past scale 2 near the target: the pod's
        // dolphins splash there too, at about 1.
        let jet: SplashProbe['last'] = null
        // The craft's own track, for the failure message: SIM y, vy, contact.
        const track: string[] = []
        const logged = (): Promise<{ log: SplashProbe['last'][]; skipped: number }> =>
          page.evaluate(
            () =>
              (
                globalThis as unknown as {
                  __splashLog?: { log: SplashProbe['last'][]; skipped: number }
                }
              ).__splashLog ?? { log: [], skipped: 0 },
          )
        for (let i = 0; i < 300 && !jet; i++) {
          const seen = await logged()
          jet =
            seen.log.find(
              (l) => l !== null && l.scale > 2 && Math.hypot(l.x - t.x, l.z - t.z) < 120,
            ) ?? null
          if (!jet) {
            if (i < 40) {
              track.push(
                await page.evaluate((who) => {
                  // biome-ignore lint/suspicious/noExplicitAny: the game's own handles
                  const w = globalThis as any
                  const b =
                    who === 'player'
                      ? w.__ff2.flight()?.jet?.body
                      : w.__ff2.racers()?.racers?.[0]?.jet?.body
                  const struck =
                    who === 'player'
                      ? w.__ff2.flight()?.struck
                      : w.__ff2.racers()?.racers?.[0]?.ground?.collision?.struck
                  return b
                    ? `${b.position.y.toFixed(1)}/${b.velocity.y.toFixed(0)}${struck ? '*' : ''}`
                    : '-'
                }, arm.who),
              )
            }
            await page.waitForTimeout(10)
          }
        }
        expect(
          jet,
          `the ${arm.who} threw no splash going into the sea; water at ${t.y.toFixed(1)}, ` +
            `y/vy track: ${track.join(' ')}; splashes seen ${JSON.stringify(await logged())}`,
        ).not.toBeNull()
        const file = await shoot(page, `jet-${arm.name}-${MISSION}-${size.tag}`)
        await page.waitForTimeout(500)
        const later = await shoot(page, `jet-${arm.name}-${MISSION}-${size.tag}-later`)
        const crash = await page.evaluate(() => {
          // biome-ignore lint/suspicious/noExplicitAny: the game's own handles
          const w = globalThis as any
          const r = w.__ff2.racers()?.racers?.[0]
          return { player: w.__ff2.crash().count, racer: r ? r.crash.count : null }
        })
        const programsAfter = await programCount(page)
        const partsAfter = await fields(page)
        console.log(
          `DEV-613 ${size.tag} ${arm.name}: splash at scale ${jet?.scale.toFixed(2)}, ` +
            `${Math.hypot((jet?.x ?? 0) - t.x, (jet?.z ?? 0) - t.z).toFixed(0)} m from the target; ` +
            `crashes ${JSON.stringify(crash)}; ${file}, ${later}; programs ${programsBefore} -> ${programsAfter}`,
        )
        expect(
          partsAfter.map((f) => f.program),
          'a splash part changed program',
        ).toEqual(partsBefore.map((f) => f.program))
      })
    }
  })
}
