// tests/e2e/gates-photos.spec.ts — photographs for DEV-122 and DEV-123.
//
// Two things a unit test cannot see and a screenshot can:
//
//  · **The finish gate reads as THE finish** (DEV-123). From the approach side,
//    500 m and 100 m out, under both presets — Classic is 2016's orange frame
//    at three times a ring, Anniversary adds the chequered band. The 500 m
//    frame also has the last ring in it, 234.6 m nearer, so the two are
//    compared in one picture. `tools/gates/cutout.py` turns these into pillar
//    1's black cut-outs.
//  · **A passed gate goes away, on the preset's clock** (DEV-122). A FIXED
//    camera beside gate 0 while the autopilot flies through it: before the
//    pass both presets show the gate; 1.0 s after, Classic still does (2016's
//    2 s hold) and Anniversary does not (0.3 s shrink); 3 s after, neither does.
//    The camera is pinned by `?view=cam`, so the three frames of one preset are
//    the same picture with one thing changed.
//
// Same build, same code: a viewpoint URL and the autopilot are things the
// game already does. Output goes to GATES_DIR, because Playwright wipes
// `test-results/` at the start of every run.

import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.GATES_DIR ?? 'test-results/gates'
const MISSION = 'int_01_hoverJet'

type Vec = [number, number, number]
const level = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'content', 'levels', `${MISSION}.json`), 'utf8'),
) as {
  routes: { rings: { pos: Vec; quat: [number, number, number, number] }[] }[]
  finish: { art: { frame: { pos: Vec; quat: [number, number, number, number] } } }
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
  await page.goto(`/?xr=off&ride=0&mission=${MISSION}&${query}`)
  await firstPress(page)
  await missionReady(page, 180_000)
}

/** Held, not tapped — `pause.spec.ts` says why. */
const holdKey = (page: Page, key: string): Promise<void> =>
  keysHold(page, key, { down: 200, settle: 200 })

interface Probe {
  elapsed: number
  passed: number
}
const probe = (page: Page): Promise<Probe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: { mission: { elapsed: number; ringsPassed: number } }
    }
    return { elapsed: w.__ff2?.mission.elapsed ?? 0, passed: w.__ff2?.mission.ringsPassed ?? 0 }
  })

test.describe('@measure @gpu the finish gate, from the approach (DEV-123)', () => {
  test.setTimeout(300_000)
  const frame = level.finish.art.frame
  const n = normalOf(frame.quat)
  for (const edition of ['classic', 'anniversary'] as const) {
    for (const metres of [500, 100]) {
      test(`${edition} at ${metres} m`, async ({ page }, testInfo) => {
        // The approach side is +normal: the last ring lies that way. Eye a
        // little above the frame's centre so the ground does not cut it.
        const eye = add(add(frame.pos, n, metres), [0, 30, 0])
        await boot(page, `view=cam&edition=${edition}&eye=${triple(eye)}&look=${triple(frame.pos)}`)
        await page.waitForTimeout(2_000)
        await save(page, `finish-${metres}m-${edition}.png`, testInfo)
      })
    }
  }
})

test.describe('@measure @gpu a passed gate goes away (DEV-122)', () => {
  test.setTimeout(420_000)
  const gate = level.routes[0]?.rings[0]
  if (!gate) throw new Error('int_01 has no ring 0')
  const n = normalOf(gate.quat)
  // Beside the gate, in its own plane: perpendicular to the normal, level, up a bit.
  const side: Vec = [n[2], 0, -n[0]]
  const eye = add(add(gate.pos, side, 170), [0, 60, 0])

  for (const edition of ['classic', 'anniversary'] as const) {
    test(`${edition}: before, 1 s after, 3 s after the pass`, async ({ page }, testInfo) => {
      await boot(
        page,
        `view=cam&autopilot=1&edition=${edition}&eye=${triple(eye)}&look=${triple(gate.pos)}`,
      )
      await focusCanvas(page)
      await holdKey(page, 'Enter')
      // Before: the run is under way and no ring has gone yet.
      await expect
        .poll(async () => (await probe(page)).elapsed, { timeout: 60_000, intervals: [250] })
        .toBeGreaterThan(0.5)
      expect((await probe(page)).passed).toBe(0)
      await save(page, `passed-gate-before-${edition}.png`, testInfo)

      // The pass. Poll for it, then note the run clock.
      await expect
        .poll(async () => (await probe(page)).passed, { timeout: 120_000, intervals: [100] })
        .toBeGreaterThanOrEqual(1)
      const at = (await probe(page)).elapsed
      testInfo.annotations.push({ type: 'pass', description: `ring 0 at ${at.toFixed(2)} s` })

      // 1.0 s after: inside 2016's 2 s hold, past Anniversary's 0.3 s shrink.
      await expect
        .poll(async () => (await probe(page)).elapsed, { timeout: 30_000, intervals: [50] })
        .toBeGreaterThan(at + 1.0)
      await save(page, `passed-gate-1s-${edition}.png`, testInfo)

      // 3 s after: gone on both.
      await expect
        .poll(async () => (await probe(page)).elapsed, { timeout: 30_000, intervals: [50] })
        .toBeGreaterThan(at + 3.0)
      await save(page, `passed-gate-3s-${edition}.png`, testInfo)
    })
  }
})
