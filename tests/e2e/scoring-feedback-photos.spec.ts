// tests/e2e/scoring-feedback-photos.spec.ts — photographs for DEV-153 and
// DEV-154.
//
// Two things a unit test cannot see and a screenshot can:
//
//  · **The reticle reads, in the hole, at the distance you commit from**
//    (DEV-153). A fixed eye on the gate's own axis at 300 m, 120 m and 40 m,
//    under BOTH presets — Classic is the bare 2016 frame, Anniversary has the
//    four marks and the pip. Three ranges because DEV-044's lesson is that a
//    thing too small has not been reviewed, it has been rendered, and the
//    range at which it stops reading is the whole question.
//  · **The low line says something** (DEV-154). The autopilot flies `int_01`
//    and the cockpit panel is photographed on a frame the event row is
//    carrying a `LOW +N`, with the meter's new track under GATES.
//
// Same build, same code: a viewpoint URL and the autopilot are things the game
// already does. Output goes to SCORING_DIR, because Playwright wipes
// `test-results/` at the start of every run.

import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.SCORING_DIR ?? 'test-results/scoring'
const MISSION = 'int_01_hoverJet'

type Vec = [number, number, number]
const level = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'content', 'levels', `${MISSION}.json`), 'utf8'),
) as {
  routes: {
    rings: { pos: Vec; quat: [number, number, number, number]; trigger: { pos: Vec } }[]
  }[]
}

/** The gate plane's normal: its local +z, in three space. */
const normalOf = (q: [number, number, number, number]): Vec => {
  const [x, y, z, w] = q
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)]
}
const add = (a: Vec, b: Vec, k = 1): Vec => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
const triple = (v: Vec) => v.map((n) => n.toFixed(2)).join(',')

const save = async (page: Page, name: string, testInfo: { attach: Function }) => {
  const shot = await page.locator('#viewport').screenshot()
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, name), shot)
  await testInfo.attach(name, { body: shot, contentType: 'image/png' })
}

const boot = async (page: Page, query: string) => {
  // `?adaptive=0&quality=high` — DEV-245. `render/quality.ts` drops a tier on a
  // starved frame and a tier drop moves MSAA, the framebuffer scale, the
  // shadow map and the prop LOD, all of which are in a screenshot. This is a
  // photo spec, so it carries the pin; the coordinator's sweep named three
  // specs and this is the fourth. See `fixtures/quality-pin.ts`.
  //
  // It matters most here of anywhere: DEV-153's question is *at what range
  // does the reticle stop reading*, and MSAA is the difference between a thin
  // mark reading and not.
  await page.goto(`/?xr=off&ride=0&mission=${MISSION}&${PINNED}&${query}`)
  await firstPress(page)
  await missionReady(page, 180_000)
}

/** Held, not tapped — `pause.spec.ts` says why. */
const holdKey = (page: Page, key: string): Promise<void> =>
  keysHold(page, key, { down: 200, settle: 200 })

test.describe('@measure @gpu DEV-153: the aim reticle, head-on, at three ranges', () => {
  test.setTimeout(420_000)
  const gate = level.routes[0]?.rings[0]
  if (!gate) throw new Error('int_01 has no ring 0')
  const n = normalOf(gate.quat)
  // ON the gate's own axis, through the TRIGGER's centre — which is where the
  // reticle is drawn and where the CLEAN rule measures from, 2.38 m off the
  // frame's origin. A head-on eye is the one a pilot lining a gate up has.
  const aim = gate.trigger.pos
  // DEV-421 turned the reticle OFF on Anniversary (Matt: *"remove 'crosshair'
  // from the ring art"*), so the shipped preset draws none and this capture
  // would photograph two bare gates. The DEV-263 feature pin puts the reticle
  // back for these frames only — the configuration DEV-153 is about, which
  // nobody ships now. The shipped-off claim is `gate-bullseye.test.ts`'s
  // DEV-421 describe, not these pictures. On Classic the pin still draws
  // nothing: `cleanCentredness` 1 makes the radius 0 whatever the flag says.
  const reticle = 'feature=gameplay.gateBullseye:on'

  for (const edition of ['classic', 'anniversary'] as const) {
    for (const metres of [300, 120, 40]) {
      test(`${edition} at ${metres} m`, async ({ page }, testInfo) => {
        const eye = add(aim, n, metres)
        await boot(
          page,
          `view=cam&edition=${edition}&${reticle}&eye=${triple(eye)}&look=${triple(aim)}`,
        )
        await page.waitForTimeout(2_000)
        await save(page, `bullseye-${metres}m-${edition}.png`, testInfo)
      })
    }
  }
})

test.describe('@measure @gpu DEV-154: the low line, said out loud', () => {
  test.setTimeout(420_000)

  test('the panel carries a LOW banner and the meter has a track', async ({ page }, testInfo) => {
    // The cockpit, not `?view=cam`: the panel is IN the ship, and the whole
    // point of this row is what the player reads while flying. The autopilot
    // flies the same code a player does.
    //
    // The banner is CANVAS, so a screenshot can show it and nothing can assert
    // it. What is asserted is the console line the same branch prints — if
    // `low +N` never appears, the announcement never ran and the pictures are
    // of a feature that is not there.
    const lows: string[] = []
    page.on('console', (m) => {
      const t = m.text()
      if (t.includes('low +')) lows.push(t)
    })
    await boot(page, `autopilot=1&edition=anniversary`)
    await focusCanvas(page)
    await holdKey(page, 'Enter')

    // Poll the run until the event row is carrying a LOW. `__ff2` exposes the
    // mission; the banner itself is canvas, so what is polled is the SIM state
    // that raises it — the pool moving — and the picture is then taken while
    // the 0.8 s banner is up.
    const pool = (): Promise<number> =>
      page.evaluate(() => {
        const w = globalThis as unknown as {
          __ff2?: { mission: { proximity?: { bonus: number } } }
        }
        return w.__ff2?.mission.proximity?.bonus ?? 0
      })
    await expect.poll(pool, { timeout: 180_000, intervals: [100] }).toBeGreaterThanOrEqual(25)
    // The pool moves in 25-point announcements, so shoot a short burst and keep
    // them all: a 0.8 s banner at ~10 fps of screenshots is caught several
    // times over, and one of the frames will have it.
    for (let i = 0; i < 12; i++) {
      await save(page, `low-banner-${String(i).padStart(2, '0')}.png`, testInfo)
      await page.waitForTimeout(220)
    }
    // Long enough for the LOW banner to find a window the gate banners are not
    // holding: the autopilot takes a gate about every 4.7 s and a gate banner
    // is up for 1.6 s of that, so roughly two thirds of announcements land free.
    await expect
      .poll(() => lows.length, { timeout: 180_000, intervals: [250] })
      .toBeGreaterThanOrEqual(3)
    for (let i = 12; i < 20; i++) {
      await save(page, `low-banner-${String(i).padStart(2, '0')}.png`, testInfo)
      await page.waitForTimeout(400)
    }
    const banked = await pool()
    testInfo.annotations.push({ type: 'pool', description: `proximity pool ${banked}` })
    testInfo.annotations.push({ type: 'low', description: lows.slice(0, 8).join(' | ') })
    expect(banked).toBeGreaterThan(0)
  })

  test('Classic draws no meter at all, on the same flight', async ({ page }, testInfo) => {
    // The A/B. Classic's `proximity` is `undefined` on the HUD state, so there
    // is no track and no bar — the panel is the one that shipped.
    await boot(page, `autopilot=1&edition=classic`)
    await focusCanvas(page)
    await holdKey(page, 'Enter')
    await page.waitForTimeout(6_000)
    await save(page, 'low-banner-classic.png', testInfo)
  })
})
