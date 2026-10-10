/**
 * A tree breaks, and the frame shows it. DEV-136.
 *
 * Flies `int_02_hoverJet` (alpine, ~8,400 trees on Anniversary since DEV-356)
 * on the autopilot, with the debug chase camera on the `fast` racer, and
 * waits for the app's own `prop hit: racer fast … broke` line. The first break is
 * photographed three times, a few frames apart, into a directory Playwright
 * does NOT wipe (`BREAK_DIR`), the way `anniversary-ab.spec.ts` keeps its pairs.
 *
 * ── Why a RACER's break, and why the camera rides it ────────────────────
 *
 * This spec used to watch the PLAYER: the autopilot's first break was
 * `tree#10418 broke at 46 m/s`, two seconds off the pad, in the trees between
 * the launch deck and gate 0. DEV-287 cleared exactly that ground (alpine's
 * `launch-corridor`, 72 trees), and since then the player's autopilot flies
 * rookie_01 without touching a prop at all: probed 2026-09-23 over 200 s, zero
 * player hits, while the racers broke eight trees (`fast` first, tree#1793 at
 * ~60 s). int_02 and rookie_02 were zero too, and adv_01's player breaks a
 * spire at ~140 s, too close to the poll below to be a fixture.
 *
 * **And DEV-356 moved it again, off rookie_01 entirely.** `props.maxSlope`
 * leaves every alpine facet steeper than 44 degrees bare, 3,683 of alpine's
 * 12,085 placements, and rookie_01's racers were breaking trees on exactly
 * that ground: probed 2026-09-24 over 150 s, 13 racer hits with the limit off
 * (`fast`'s tree#1793 first, the old fixture) and NONE with it on. The same
 * probe on int_02 with the limit on: `cutter` breaks tree#4299 at 60 m/s,
 * inside the window; rookie_02's only contact was a cactus bounce. So the
 * default was int_02 and `cutter`.
 *
 * **And DEV-364 moved it off `cutter`.** The racers fly their own lanes now,
 * and `cutter`'s no longer runs through tree#4299: the spec timed out on the
 * empty string, exactly as the paragraph below says it will. Probed headless
 * over 150 s with the lanes on, `cutter` breaks nothing on int_02 and `fast`
 * breaks first (tree#5148 at ~75 s); in the game, with the player in the air
 * beside them, `fast` broke tree#3837 at 63 m/s inside the window. So the
 * default is int_02 and `fast`. If a later change clears that tree too,
 * the break poll below times out on an EMPTY string (that is what this row's
 * first run looked like); read it as a moved fixture, probe who still breaks
 * something, and move the default again rather than growing the poll. A racer's
 * break has run the same code since DEV-147 (`breakProps` in `boot/app.ts` is
 * one function for every hitter), so it is the same test of the mechanism.
 *
 * The camera goes WITH the racer for a reason beyond the photograph: the
 * fracture starts from the instance as drawn (`drawn(id)` in
 * `game/props/load-props.ts`), so a break the camera is nowhere near is the
 * wrong sample for DEV-148's "the pieces land" below. `?view=chase` is the
 * game's own debug view and moves only the camera.
 *
 * The assertions are on the app's console rather than on pixels: the collider
 * count line proves the layer was built for THIS world, and a break line
 * proves a contact above `breakSpeed` happened and was resolved (or a held
 * racer was freed, DEV-180). If nobody breaks a tree in the window, that is a
 * finding about the route, and the spec says so rather than timing out
 * silently.
 *
 *   BREAK_DIR=<dir> E2E_PORT=<yours> pnpm exec playwright test tests/e2e/prop-break.spec.ts
 *
 * `BREAK_MISSION` and `BREAK_WHO` (`fast`, `steady`, … or `player`) pick
 * another course and another hitter; the camera follows the hitter.
 *
 * ── DEV-428: the preset's tree STANDS now, and bursts ───────────────────
 *
 * `gameplay.propCollision.strike` keeps a struck tree's collider and its
 * drawing, and throws a burst in the tree's own colours instead of DEV-136's
 * fracture — so on the shipped preset the app says `struck`, not `broke`, and
 * no piece ever flies. By DEFAULT this spec photographs that: the strike line,
 * the burst in the air (`__ff2.propStrike()`), and nothing fractured.
 *
 * `BREAK_FRACTURE=1` pins the strike OFF (`?feature=…strike:off`, DEV-263),
 * which is DEV-136's response, and runs DEV-148's "the pieces land" below as
 * it always ran. The fracture is still live code: it is what a tree does
 * whenever its collider IS removed — the strike off, or DEV-180's escape.
 *
 * Tagged `@gpu` with the other flying specs: it needs the hydrated assets.
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, test } from './fixtures/test'

const BREAK_DIR = process.env.BREAK_DIR ?? 'test-results/prop-break'
const MISSION = process.env.BREAK_MISSION ?? 'int_02_hoverJet'
const WHO = process.env.BREAK_WHO ?? 'fast'
const HITTER = WHO === 'player' ? 'player' : `racer ${WHO}`
/** DEV-428: `1` is DEV-136's fracture (the strike pinned off); unset is what ships. */
const FRACTURE = process.env.BREAK_FRACTURE === '1'
/** What the app's `prop hit:` line says for the contact this spec waits on. */
const WORD = FRACTURE ? 'broke' : 'struck'

test.describe('@gpu a tree breaks', () => {
  test.setTimeout(300_000)

  test(`${MISSION}: the first prop ${HITTER} ${FRACTURE ? 'breaks' : 'strikes'} is photographed`, async ({
    page,
  }, testInfo) => {
    const logs: string[] = []
    page.on('console', (m) => logs.push(m.text()))
    await page.goto(
      `/?mission=${MISSION}&autopilot=1&xr=off&edition=anniversary&view=chase&chase=${WHO}` +
        `&${PINNED}` +
        (FRACTURE ? '&feature=gameplay.propCollision.strike:off' : ''),
    )
    await firstPress(page)
    await missionReady(page, 180_000)
    await focusCanvas(page)

    // The layer was built for this world, with a number.
    await expect
      .poll(() => logs.find((l) => /^props: \d+ colliders in \d+ cells/.test(l)) ?? '', {
        timeout: 30_000,
      })
      .toMatch(/^props: \d+ colliders/)
    const colliderLine = logs.find((l) => /^props: \d+ colliders/.test(l)) as string
    const colliders = Number(/^props: (\d+) colliders/.exec(colliderLine)?.[1])
    expect(colliders).toBeGreaterThan(1000)

    // Wait for the hitter's first break, up to a lap and a half. Only the
    // one the camera is on: the others break trees too (DEV-147), off-frame.
    let broke: string | undefined
    await expect
      .poll(
        () => {
          broke = logs.find((l) => l.startsWith(`prop hit: ${HITTER} `) && l.includes(WORD))
          return broke ?? ''
        },
        { timeout: 150_000, intervals: [100] },
      )
      .toContain(WORD)

    // DEV-428: the burst is in the air NOW — asked before the photographs,
    // which take long enough that a short burst could be over by the last one.
    const strikeNow = await page.evaluate(() => {
      const w = window as unknown as {
        __ff2?: { propStrike?: () => { bursts: number; alive: number } | null }
      }
      return w.__ff2?.propStrike?.() ?? null
    })

    fs.mkdirSync(BREAK_DIR, { recursive: true })
    for (let i = 0; i < 3; i++) {
      const shot = await page.locator('#viewport').screenshot()
      const name = `${MISSION}-${WORD}-${i}.png`
      fs.writeFileSync(path.join(BREAK_DIR, name), shot)
      await testInfo.attach(name, { body: shot, contentType: 'image/png' })
      await page.waitForTimeout(150)
    }
    testInfo.annotations.push({ type: 'first break', description: broke as string })
    const hits = logs.filter((l) => l.startsWith(`prop hit: ${HITTER} `))
    testInfo.annotations.push({ type: 'hits so far', description: String(hits.length) })

    if (!FRACTURE) {
      // ── DEV-428: it STANDS, and it burst ─────────────────────────────────
      //
      // The strike field was built for this world and threw at least one
      // burst, which had pieces in the air when the line landed. And nothing
      // came apart: a standing tree throws no fracture, and `fracture()` —
      // still built, for DEV-180's escape — has no piece in the air.
      expect(strikeNow, '`__ff2.propStrike()` is null: no strike field was built').not.toBeNull()
      const strike = strikeNow as unknown as { bursts: number; alive: number }
      expect(strike.bursts).toBeGreaterThan(0)
      expect(
        strike.alive,
        'the burst was already over when the strike line landed',
      ).toBeGreaterThan(0)
      const pieces = await page.evaluate(() => {
        const w = window as unknown as {
          __ff2?: { fracture: () => { live: number; landed: number } | null }
        }
        return w.__ff2?.fracture()?.live ?? -1
      })
      expect(pieces, 'a struck tree came apart as well as standing').toBe(0)
      testInfo.annotations.push({
        type: 'DEV-428 strike',
        description: `${strike.bursts} bursts, ${strike.alive} pieces in the air at the line`,
      })
      console.log(
        `DEV-428 ${MISSION}: ${colliderLine}; first strike "${broke}"; ${hits.length} hit lines; ` +
          `${strike.bursts} bursts, ${strike.alive} pieces in the air; 0 fractured`,
      )
      return
    }

    // ── DEV-148: and the pieces LAND ─────────────────────────────────────
    //
    // Asked of the page rather than of a screenshot, and that is the point: a
    // piece below the ground is HIDDEN BY the ground, so the bug and the fix
    // photograph identically. `__ff2.fracture()` reports how many pieces are
    // in the air and how many have come to rest on the rendered surface.
    // Before this, `landed` was structurally always zero — nothing here asked
    // where the hill was (DEV-136 §4, *"they fall through it and fade first"*).
    let fracture: { live: number; landed: number } | null = null
    await expect
      .poll(
        async () => {
          fracture = await page.evaluate(() => {
            const w = window as unknown as {
              __ff2?: { fracture: () => { live: number; landed: number } | null }
            }
            return w.__ff2?.fracture() ?? null
          })
          return fracture?.landed ?? 0
        },
        { timeout: 120_000, intervals: [100] },
      )
      .toBeGreaterThan(0)
    const landed = fracture as unknown as { live: number; landed: number }
    testInfo.annotations.push({
      type: 'DEV-148 fracture',
      description: `${landed.landed} of ${landed.live} pieces resting on the ground`,
    })
    console.log(
      `DEV-136 ${MISSION}: ${colliderLine}; first break "${broke}"; ${hits.length} hit lines; ` +
        `DEV-148: ${landed.landed}/${landed.live} pieces landed`,
    )
  })
})
