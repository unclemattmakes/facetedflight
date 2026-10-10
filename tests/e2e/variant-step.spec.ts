/**
 * The aircraft VARIANT step, on the route a player takes. DEV-382.
 *
 * Matt, 2026-09-24: *"a new selection after the aircraft type."* The plan is
 * `docs/plan/AIRCRAFT-VARIANTS.md` §6 and its §9 DEV-382. This spec walks the
 * one path that matters, from the TITLE — never `?mission=`, which boots
 * straight into a world and cannot see what the hangar hands the flight
 * (`docs/AGENT-NOTES.md` §8) — through the aircraft, the variant, the flight
 * plan, the rank and the course, and then asks the page which machine it is
 * flying and which machine the racers are flying.
 *
 * ── Only `standard` ships today, so the walk is taken twice ──────────────
 *
 * 1. Over the SHIPPED files: the step is there on Anniversary with one table
 *    (no skip — Matt's rule for a one-table page), standard under the resting
 *    pointer, and standard flies.
 * 2. Over a FIXTURE: the plan's own three HoverJet variants, served in place of
 *    `content/aircraft/hoverjet.json` when the dev server is asked for it. That
 *    is data, handed to the same build through the same import — no switch in
 *    the game, no second code path — and it is the only way to prove, before
 *    DEV-381 lands, that a variant chosen at the tables is the one that flies:
 *    with one variant, "the choice was dropped" and "the choice was kept" fly
 *    the same machine. The acrobat's roll torque is 1.8 x the sheet's, and the
 *    assertion is that the JET's torque is that — read off the page, against
 *    the generated sheet imported here, not against anything the page says
 *    about itself.
 * 3. On Classic the step does not exist: the aircraft press opens its plans.
 *
 * Photographs, when `VARIANT_STEP_SHOT_DIR` is set, of the step from the seat,
 * flat, with the tier pinned and read back beside each frame: the shipped
 * one-table step and the fixture's three tables (named `fixture` in the file,
 * because those variants do not exist yet), both aircraft, plus each label's
 * own canvas, which is where the bars are.
 *
 * Proved red: with `boot/app.ts` boarding every course in `standard` (a hangar
 * that drops the choice) the fixture walk flies roll torque 3, not 5.4; with
 * the racers built without the player's sheet they fly 3 while the player
 * flies 5.4.
 */
import fs from 'node:fs'
import path from 'node:path'
import { HOVERJET } from '@/generated/constants.generated'
import { bootReady, switchSettled } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { aimAtCourse, hangarAim, hold, lookUntilAimed, throughDoors } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

test.describe.configure({ timeout: 360_000 })

/** The pin as it goes in a file name. */
const PIN_TAG = PINNED.replace(/[=&]/g, '-')
const SHOTS = process.env.VARIANT_STEP_SHOT_DIR ?? null

/**
 * AIRCRAFT-VARIANTS §2.2's HoverJet, verbatim: its first guesses. A FIXTURE —
 * DEV-381 owns the real file and may land other numbers.
 */
const HOVERJET_FIXTURE = {
  vehicle: 'hoverjet',
  note: 'e2e fixture, variant-step.spec.ts: the plan section 2.2 guesses, served in place of the shipped file.',
  variants: [
    {
      id: 'acrobat',
      name: 'Acrobat',
      blurb: 'More nimble',
      scale: {
        'ship.rollRate': 1.8,
        'ship.pitchRate': 1.6,
        'ship.yawRate': 1.5,
        'rigidbody.angularDrag': 1.3,
        'ship.driftMultiplier': 1.3,
        'ship.liftMultiplier': 1.3,
        'ship.acceleration': 1.25,
        'ship.maxSpeed': 0.92,
      },
    },
    { id: 'standard', name: 'Standard', blurb: "2016's HoverJet", scale: {} },
    {
      id: 'speed',
      name: 'Speed',
      blurb: 'Faster top speed. Insane boost',
      scale: {
        'ship.maxSpeed': 1.2,
        'ship.boostMultiplier': 1.5,
        'energy.BoostBurnrate': 1.5,
        'ship.rollRate': 0.9,
        'ship.pitchRate': 0.9,
        'ship.driftMultiplier': 0.85,
        'ship.liftMultiplier': 0.85,
      },
    },
  ],
} as const

/** §3.2's JumpSeat, scales only: the spider's jump and overclocked's gravity are mechanics nothing runs yet. */
const JUMPSEAT_FIXTURE = {
  vehicle: 'jumpseat',
  note: 'e2e fixture, variant-step.spec.ts: the plan section 3.2 scales, served in place of the shipped file.',
  variants: [
    {
      id: 'spider',
      name: 'Spider',
      blurb: 'Charge a jump; the jet only slows the fall',
      scale: { 'thruster.thrustForce': 0.6, 'fuel.burnRate': 0.6 },
    },
    { id: 'standard', name: 'Standard', blurb: "2016's JumpSeat", scale: {} },
    {
      id: 'overclocked',
      name: 'Overclocked',
      blurb: 'Much stronger. Falls faster',
      scale: { 'thruster.thrustForce': 1.5, 'fuel.burnRate': 1.3, 'hoverMotor.hoverForce': 1.4 },
    },
  ],
} as const

/**
 * Serve the fixtures where the build imports the aircraft files. The dev server
 * hands a JSON import to the page as a JS module (`…/hoverjet.json?import`), so
 * the fixture goes back as one. Registered before the page loads, because the
 * files are EAGER imports and are read once, at module evaluation.
 */
const serveFixtures = async (page: Page): Promise<string[]> => {
  const served: string[] = []
  for (const fixture of [HOVERJET_FIXTURE, JUMPSEAT_FIXTURE]) {
    await page.route(`**/content/aircraft/${fixture.vehicle}.json*`, async (route) => {
      served.push(route.request().url())
      await route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        body: `export default ${JSON.stringify(fixture)}`,
      })
    })
  }
  return served
}

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

/** What the hangar says about the variant step that is up. */
const variantStep = async (page: Page) =>
  page.evaluate(() => {
    const h = (
      globalThis as unknown as {
        __ff2?: {
          hangarAim: () => {
            view: string
            views: string[]
            variants: { id: string; name: string; lastFlown: boolean }[]
          } | null
        }
      }
    ).__ff2?.hangarAim()
    return h ? { view: h.view, views: h.views, variants: h.variants } : null
  })

/** Which machine the player and every racer are flying, off the live objects. */
const machines = async (page: Page) =>
  page.evaluate(() => {
    interface Jet {
      tuning: { rollRate: number; maxSpeed: number }
    }
    const ff = (
      globalThis as unknown as {
        __ff2?: {
          flight: () => { variant: string; jet: Jet } | null
          racers: () => { racers: { spec: { id: string }; jet: Jet }[] } | null
        }
      }
    ).__ff2
    const flight = ff?.flight() ?? null
    const racers = ff?.racers()?.racers ?? []
    return {
      variant: flight?.variant ?? null,
      rollRate: flight?.jet.tuning.rollRate ?? null,
      maxSpeed: flight?.jet.tuning.maxSpeed ?? null,
      racers: racers.map((r) => ({
        id: r.spec.id,
        rollRate: r.jet.tuning.rollRate,
        maxSpeed: r.jet.tuning.maxSpeed,
      })),
      stored: localStorage.getItem('ff2.variant.v1'),
    }
  })

/** Down the rest of the menu to `int_01_hoverJet`, and wait until aboard. */
const planRankCourse = async (page: Page): Promise<void> => {
  for (const [view, want] of [
    ['modes', 'ringAttack'],
    ['ranks', 'intermediate'],
    ['courses', 'int_01_hoverJet'],
  ] as const) {
    // DEV-420: Ring Attack walks no rank step (its place carries it), which
    // the room says once the plan is open.
    if (!((await hangarAim(page))?.views ?? []).includes(view)) continue
    expect((await hangarAim(page))?.view, `on the ${view} step`).toBe(view)
    const found =
      view === 'courses' ? await aimAtCourse(page, want) : await lookUntilAimed(page, want)
    expect(found, `found ${want}`).toBe(true)
    await hold(page, 'Enter')
  }
  await switchSettled(page, 240_000)
}

/**
 * The step, photographed from the seat: a burst (the aircraft turn at 27.5
 * deg/s, so one frame is one face), the tier read back beside each and held
 * across the burst, and every live table's label straight off its canvas.
 */
const photograph = async (page: Page, name: string): Promise<void> => {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  // The aircraft GLBs land on their own clock; wait for one on every live table.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          let ships = 0
          ;(
            globalThis as unknown as {
              __ff2?: { stage: () => { traverse: (f: (o: { name: string }) => void) => void } }
            }
          ).__ff2
            ?.stage()
            .traverse((o) => {
              if (/^holo-ship-(?!spinner-)/.test(o.name)) ships++
            })
          return ships
        }),
      { timeout: 60_000, message: 'the aircraft reach the variant tables' },
    )
    .toBeGreaterThan(0)
  await page.waitForTimeout(1_500)
  const states: Awaited<ReturnType<typeof drawState>>[] = []
  for (let i = 0; i < 4; i++) {
    const state = await drawState(page)
    states.push(state)
    const file = path.join(SHOTS, `variant-step-${name}-${PIN_TAG}-${i}.png`)
    await page.screenshot({ path: file })
    console.log(`[DEV-382] ${path.basename(file)} · ${drawStateLine(state)}`)
    await page.waitForTimeout(800)
  }
  const first = states[0] as (typeof states)[number]
  for (const s of states.slice(1)) expect(drawStateDiff(first, s), 'the tier moved').toEqual([])
  // Each drawn label, off its own canvas: the bars at full resolution.
  const labels = await page.evaluate(() => {
    interface Node {
      name: string
      visible: boolean
      parent: Node | null
      userData: { aimable?: boolean }
      children: Node[]
      material?: { map?: { image?: HTMLCanvasElement } }
    }
    const out: string[] = []
    const stage = (
      globalThis as unknown as {
        __ff2?: { stage: () => { traverse: (f: (o: Node) => void) => void } }
      }
    ).__ff2?.stage()
    stage?.traverse((o) => {
      if (o.name !== 'hangar-holotable' || !o.visible || o.userData.aimable !== true) return
      for (const child of o.children) {
        const image = child.material?.map?.image
        if (image instanceof HTMLCanvasElement && image.width === 1024 && image.height === 256) {
          out.push(image.toDataURL('image/png'))
        }
      }
    })
    return out
  })
  labels.forEach((data, i) => {
    const file = path.join(SHOTS, `variant-step-${name}-label-${i}.png`)
    fs.writeFileSync(file, Buffer.from(data.replace(/^data:image\/png;base64,/, ''), 'base64'))
  })
}

test.describe('the aircraft variant step (DEV-382)', () => {
  test.use({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 })

  test('the shipped files: title → HoverJet → standard → int_01, flown in standard, racers too', async ({
    page,
  }) => {
    await intoTheRoom(page)
    const top = await variantStep(page)
    expect(top?.views, 'Anniversary has the variant step').toEqual([
      // DEV-558: the hangar's doors stand in front of the walk.
      'doors',
      'vehicles',
      'variants',
      'modes',
      'ranks',
      'courses',
    ])
    expect(await lookUntilAimed(page, 'hoverjet'), 'found the HoverJet').toBe(true)
    await hold(page, 'Enter')

    const step = await variantStep(page)
    expect(step?.view, 'a press on an aircraft opens its variants').toBe('variants')
    expect(step?.variants.map((v) => v.id)).toContain('standard')
    // Standard is under the RESTING pointer: no turn has been made since the
    // press, so whatever is aimed now is what rests there.
    expect((await hangarAim(page))?.aimName, 'standard rests under the pointer').toBe('standard')
    // A fresh profile has flown nothing, so no table may say LAST FLOWN. The
    // first photographs of this step said it of standard: the label was
    // reading the flight's fallback, not a flight.
    expect(
      step?.variants.filter((v) => v.lastFlown).map((v) => v.id),
      'LAST FLOWN on a first visit',
    ).toEqual([])
    await photograph(page, 'hoverjet-shipped')

    await hold(page, 'Enter')
    await planRankCourse(page)

    const flying = await machines(page)
    console.log(`[DEV-382] shipped walk: ${JSON.stringify(flying)}`)
    expect(flying.variant, 'the flight is the standard').toBe('standard')
    expect(flying.rollRate, "2016's roll torque").toBe(HOVERJET.ship.rollRate)
    expect(flying.racers.length, 'the premise: racers on the grid').toBeGreaterThan(0)
    for (const r of flying.racers) {
      expect(r.rollRate, `${r.id} flies the player's machine`).toBe(flying.rollRate)
      expect(r.maxSpeed, `${r.id} flies the player's machine`).toBe(flying.maxSpeed)
    }
    expect(JSON.parse(flying.stored ?? '{}'), 'the choice is remembered').toEqual({
      hoverjet: 'standard',
    })
  })

  test('a variant chosen at the tables is the one that flies, and the racers fly it too', async ({
    page,
  }) => {
    const served = await serveFixtures(page)
    await intoTheRoom(page)
    expect(served.length, 'the premise: the build asked for the aircraft files').toBeGreaterThan(0)
    expect(await lookUntilAimed(page, 'hoverjet'), 'found the HoverJet').toBe(true)
    await hold(page, 'Enter')

    const step = await variantStep(page)
    expect(step?.view).toBe('variants')
    expect(
      step?.variants.map((v) => v.id),
      'the fixture, in file order',
    ).toEqual(['acrobat', 'standard', 'speed'])
    expect((await hangarAim(page))?.aimName, 'standard rests under the pointer').toBe('standard')
    await photograph(page, 'hoverjet-fixture')

    expect(await lookUntilAimed(page, 'acrobat'), 'found the acrobat, to the left').toBe(true)
    await hold(page, 'Enter')
    await planRankCourse(page)

    const flying = await machines(page)
    console.log(`[DEV-382] fixture walk: ${JSON.stringify(flying)}`)
    const acrobat = HOVERJET_FIXTURE.variants[0].scale
    expect(flying.variant, 'the flight is the acrobat').toBe('acrobat')
    expect(flying.rollRate, "the acrobat's roll torque, off 2016's sheet").toBeCloseTo(
      HOVERJET.ship.rollRate * acrobat['ship.rollRate'],
      9,
    )
    expect(flying.maxSpeed).toBeCloseTo(HOVERJET.ship.maxSpeed * acrobat['ship.maxSpeed'], 9)
    expect(flying.racers.length, 'the premise: racers on the grid').toBeGreaterThan(0)
    for (const r of flying.racers) {
      expect(r.rollRate, `${r.id} flies the acrobat too`).toBe(flying.rollRate)
      expect(r.maxSpeed, `${r.id} flies the acrobat too`).toBe(flying.maxSpeed)
    }
    expect(JSON.parse(flying.stored ?? '{}'), 'and it is remembered').toEqual({
      hoverjet: 'acrobat',
    })
  })

  test('the JumpSeat asks too: the shipped step and the fixture, photographed', async ({
    page,
  }) => {
    // The photographs' second aircraft. No flight: the HoverJet walks above
    // already fly the choice, and a JumpSeat course races nobody.
    await serveFixtures(page)
    await intoTheRoom(page)
    expect(await lookUntilAimed(page, 'jumpseat'), 'found the JumpSeat').toBe(true)
    await hold(page, 'Enter')
    const step = await variantStep(page)
    expect(step?.view).toBe('variants')
    expect(step?.variants.map((v) => v.id)).toEqual(['spider', 'standard', 'overclocked'])
    // Face the step square, from the resting bearing, where standard stands.
    expect(await lookUntilAimed(page, 'standard'), 'standard rests under the pointer').toBe(true)
    await photograph(page, 'jumpseat-fixture')
  })

  test('the shipped JumpSeat step is one table, standard, at rest', async ({ page }) => {
    await intoTheRoom(page)
    expect(await lookUntilAimed(page, 'jumpseat'), 'found the JumpSeat').toBe(true)
    await hold(page, 'Enter')
    const step = await variantStep(page)
    expect(step?.view).toBe('variants')
    expect(step?.variants.map((v) => v.id)).toContain('standard')
    expect(await lookUntilAimed(page, 'standard'), 'standard is on the arc').toBe(true)
    await photograph(page, 'jumpseat-shipped')
  })

  test('Classic chosen, the room still asks for the variant: the menus are Anniversary’s', async ({
    page,
  }) => {
    // DEV-451: every menu wears and offers Anniversary; a Classic choice is
    // worn inside a mission only. This case read "Classic has no variant
    // step" until then, which was the room following the choice.
    await intoTheRoom(page, '&edition=classic')
    expect((await variantStep(page))?.views, 'the same five steps as Anniversary').toEqual([
      // DEV-558: the hangar's doors stand in front of the walk.
      'doors',
      'vehicles',
      'variants',
      'modes',
      'ranks',
      'courses',
    ])
    expect(await lookUntilAimed(page, 'hoverjet'), 'found the HoverJet').toBe(true)
    await hold(page, 'Enter')
    expect((await hangarAim(page))?.view, 'a press on an aircraft opens its variants').toBe(
      'variants',
    )
  })
})
