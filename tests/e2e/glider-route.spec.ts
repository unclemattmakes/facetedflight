/**
 * The glider, on the route a player takes. DEV-399 (AIRCRAFT-VARIANTS §5, G1).
 *
 * From the TITLE — never `?mission=`, which boots straight into a world and
 * cannot see what the hangar hands the flight (`docs/AGENT-NOTES.md` §8) —
 * into the room, to the glider's table (the third aircraft, Anniversary's),
 * its one-variant page, Ring Attack, Intermediate and its one course; then the
 * glider's own autopilot (P, as a player hands the stick over) flies it
 * through every ring to the finish and the run ends.
 *
 * What it asks the PAGE, off the live objects:
 *
 *  · the aircraft step has three tables and the glider is one of them; the
 *    variant step is there with ONE table (no skip, §6.2);
 *  · the flight is the glider's seam (`object.name`, the stall reading the
 *    HoverJet does not have), in `standard`, and races nobody;
 *  · it GLIDES: the body descends while the HoverJet's gravity would be off;
 *  · the run ENDS with every ring taken and no crash.
 *
 * And that Classic has no glider: two aircraft, and none of them it.
 *
 * Photographs, when `GLIDER_SHOT_DIR` is set: the aircraft step with the
 * glider's table aimed, its variant page, a burst from the seat with the dash
 * (the stall bar and the rocket's tank) — every file named with the pin — and
 * the dash's own canvas at full resolution.
 *
 * Proved red: with the course's `vehicle` back at `hoverjet` there is no
 * glider table to find, and with `flightSeamFor` sending the glider to the
 * HoverJet's arm the flight has no stall reading and does not descend.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bootReady, switchSettled } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { aimAtCourse, hangarAim, hold, lookUntilAimed, throughDoors } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

test.describe.configure({ timeout: 480_000 })

const PIN_TAG = PINNED.replace(/[=&]/g, '-')
const SHOTS = process.env.GLIDER_SHOT_DIR ?? null
const COURSE = 'anniv_01_glider'

/** Title -> the room, as a player: Start, the title, then A on HANGAR. */
const intoTheRoom = async (page: Page, query = ''): Promise<void> => {
  await page.goto(`/?xr=off&${PINNED}${query}`)
  await firstPress(page)
  await bootReady(page, 240_000)
  // A click on the TITLE is a real press since DEV-301; leave it with ENTER.
  await dropFocus(page)
  await page.waitForTimeout(1_200)
  await pressTitleRow(page, TITLE_ROW.hangar) // DEV-558: START, the hangar's doors
  await throughDoors(page) // and SINGLE PLAYER, to the aircraft
  expect((await hangarAim(page))?.view, 'Single Player opens the aircraft').toBe('vehicles')
}

/** The aircraft (or variants) on the step that is up, off the room's own report. */
const stepTables = async (page: Page) =>
  page.evaluate(() => {
    const h = (
      globalThis as unknown as {
        __ff2?: {
          hangarAim: () => {
            view: string
            views: string[]
            variants: { id: string }[]
          } | null
          stage: () => {
            traverse: (
              f: (o: {
                name: string
                visible: boolean
                parent: { visible: boolean } | null
              }) => void,
            ) => void
          }
        }
      }
    ).__ff2
    const aim = h?.hangarAim()
    const ships: string[] = []
    h?.stage().traverse((o) => {
      const m = /^holo-ship-(?!spinner-)(.+)$/.exec(o.name)
      if (m && o.visible && o.parent?.visible !== false) ships.push(m[1] as string)
    })
    return {
      view: aim?.view ?? null,
      views: aim?.views ?? [],
      variants: aim?.variants.map((v) => v.id) ?? [],
      ships,
    }
  })

/** What the flight is, off the live object. */
const theFlight = async (page: Page) =>
  page.evaluate(() => {
    const f = (
      globalThis as unknown as {
        __ff2?: {
          flight: () => {
            variant: string
            object: { name: string }
            jet: {
              body: { position: { y: number }; velocity: { x: number; y: number; z: number } }
            }
            stall?: { margin: number; stalling: boolean }
            fuel?: { fraction: number; lit: boolean }
          } | null
        }
      }
    ).__ff2?.flight()
    if (!f) return null
    const v = f.jet.body.velocity
    return {
      name: f.object.name,
      variant: f.variant,
      y: f.jet.body.position.y,
      speed: Math.hypot(v.x, v.y, v.z),
      stall: f.stall ?? null,
      fuel: f.fuel ?? null,
      finished: document.body.dataset.finished === 'true',
      rings: document.body.dataset.rings ?? null,
      crashes: Number(document.body.dataset.crashes ?? 0),
      opponents: document.body.dataset.opponents ?? null,
    }
  })

/** A burst, pinned and held: the tier read beside each frame, and asserted not to move. */
const burst = async (page: Page, name: string, frames = 4, gapMs = 800): Promise<void> => {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  const states: Awaited<ReturnType<typeof drawState>>[] = []
  for (let i = 0; i < frames; i++) {
    const state = await drawState(page)
    states.push(state)
    const file = path.join(SHOTS, `glider-${name}-${PIN_TAG}-${i}.png`)
    await page.screenshot({ path: file })
    console.log(`[DEV-399] ${path.basename(file)} · ${drawStateLine(state)}`)
    await page.waitForTimeout(gapMs)
  }
  const first = states[0] as (typeof states)[number]
  for (const s of states.slice(1)) expect(drawStateDiff(first, s), 'the tier moved').toEqual([])
}

/** The dash's own canvas, full resolution — the stall bar and the tank as drawn. */
const dashCanvas = async (page: Page, name: string): Promise<void> => {
  if (!SHOTS) return
  const data = await page.evaluate(() => {
    let out: string | null = null
    ;(
      globalThis as unknown as {
        __ff2?: {
          stage: () => {
            traverse: (
              f: (o: { name: string; material?: { map?: { image?: unknown } } }) => void,
            ) => void
          }
        }
      }
    ).__ff2
      ?.stage()
      .traverse((o) => {
        const image = o.material?.map?.image
        if (o.name === 'hud' && image instanceof HTMLCanvasElement)
          out = image.toDataURL('image/png')
      })
    return out as string | null
  })
  if (!data) return
  const file = path.join(SHOTS, `glider-${name}-canvas.png`)
  fs.writeFileSync(file, Buffer.from(data.replace(/^data:image\/png;base64,/, ''), 'base64'))
}

/**
 * Wait for `count` aircraft models on the step's tables. The HoverJet's GLB
 * (which the glider's table borrows) and the JumpSeat's land on their own
 * clocks, so a census taken at the first one is a census of half the room.
 */
const shipsLanded = async (page: Page, count: number): Promise<void> => {
  await expect
    .poll(async () => (await stepTables(page)).ships.length, {
      timeout: 90_000,
      message: 'the aircraft reach their tables',
    })
    .toBeGreaterThanOrEqual(count)
  await page.waitForTimeout(1_500)
}

test.describe('the glider, a third aircraft (DEV-399)', () => {
  test.use({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })

  test('title → hangar → glider → standard → its course, flown by its autopilot to the finish', async ({
    page,
  }) => {
    await intoTheRoom(page)

    // ── the aircraft step: three tables, the glider on the LEFT ─────────────
    await shipsLanded(page, 3)
    const aircraft = await stepTables(page)
    expect(aircraft.views, 'Anniversary has the variant step').toContain('variants')
    expect(new Set(aircraft.ships), 'three aircraft on their tables').toEqual(
      new Set(['hoverjet', 'jumpseat', 'glider']),
    )
    expect(await lookUntilAimed(page, 'glider'), 'found the glider').toBe(true)
    await burst(page, 'aircraft-step', 2)
    await hold(page, 'Enter')

    // ── its variant page: one table, standard (no skip) ──────────────────
    const variants = await stepTables(page)
    expect(variants.view, 'a press on the glider opens its variants').toBe('variants')
    expect(variants.variants, 'one variant until G5').toEqual(['standard'])
    expect(await lookUntilAimed(page, 'standard'), 'standard is on the arc').toBe(true)
    await shipsLanded(page, 1)
    await burst(page, 'variant-step', 2)
    await hold(page, 'Enter')

    // ── plan, then place (DEV-420: Ring Attack's place carries its rank) ──
    for (const [view, want] of [
      ['modes', 'ringAttack'],
      ['ranks', 'intermediate'],
      ['courses', COURSE],
    ] as const) {
      if (!((await hangarAim(page))?.views ?? []).includes(view)) continue
      expect((await hangarAim(page))?.view, `on the ${view} step`).toBe(view)
      const found =
        view === 'courses' ? await aimAtCourse(page, want) : await lookUntilAimed(page, want)
      expect(found, `found ${want}`).toBe(true)
      await hold(page, 'Enter')
    }
    await switchSettled(page, 240_000)

    // ── aboard: the glider's seam, gliding ───────────────────────────────
    await expect.poll(async () => (await theFlight(page))?.name, { timeout: 60_000 }).toBe('glider')
    const aboard = await theFlight(page)
    console.log(`[DEV-399] aboard: ${JSON.stringify(aboard)}`)
    expect(aboard?.variant, 'in standard').toBe('standard')
    expect(aboard?.stall, 'the stall reading only a glider has').not.toBeNull()
    expect(aboard?.fuel?.fraction, 'a full rocket').toBe(1)
    expect(aboard?.opponents, 'no racer flies a glider').toBe('0')
    // It GLIDES: two seconds hands-off and it has come down, where a launched
    // HoverJet with the throttle shut holds its height (gravity off).
    // Polled, not timed: the boarding curtain holds the mission screen for a
    // moment, and the run does not step until it is up.
    const y0 = aboard?.y ?? 0
    await expect
      .poll(async () => (await theFlight(page))?.y ?? y0, {
        timeout: 30_000,
        message: 'a glider comes down',
      })
      .toBeLessThan(y0 - 5)
    const later = await theFlight(page)
    expect(later?.speed ?? 0, 'at flying speed').toBeGreaterThan(40)
    await burst(page, 'seat', 4, 600)
    await dashCanvas(page, 'seat-dash')

    // ── hand the stick over, and fly it home ─────────────────────────────
    await hold(page, 'KeyP')
    let last = await theFlight(page)
    await expect
      .poll(
        async () => {
          last = await theFlight(page)
          return last?.finished ?? false
        },
        { timeout: 240_000, intervals: [2_000] },
      )
      .toBe(true)
    console.log(`[DEV-399] done: ${JSON.stringify(last)}`)
    const [taken, total] = (last?.rings ?? '0/0').split('/').map(Number)
    expect(total, 'the course has rings').toBeGreaterThan(0)
    expect(taken, 'and the glider took every one').toBe(total)
    expect(last?.crashes, 'without a crash').toBe(0)
    await burst(page, 'finished', 1)
  })

  test('Classic chosen, the room is still Anniversary’s: the glider stands with 2016’s two', async ({
    page,
  }) => {
    // DEV-451: the menus always wear and offer Anniversary; a Classic choice is
    // worn inside a mission only. This case read "Classic has no glider" until
    // then, which was the room following the choice.
    await intoTheRoom(page, '&edition=classic')
    await shipsLanded(page, 3)
    const aircraft = await stepTables(page)
    expect(aircraft.views, 'the variant step, as on Anniversary').toContain('variants')
    expect(new Set(aircraft.ships), 'the glider beside 2016’s two').toEqual(
      new Set(['glider', 'hoverjet', 'jumpseat']),
    )
  })
})
