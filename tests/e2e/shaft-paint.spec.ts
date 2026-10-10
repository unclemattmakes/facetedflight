/**
 * tests/e2e/shaft-paint.spec.ts — the elevator shaft keeps the hangar's colours (DEV-456).
 *
 * Matt, 2026-09-27, watching headed runs: *"it looks like the elevator shaft
 * stops using it's vertex colors when just above the hangar"*; told why:
 * *"shaft should keep it's hangar colors - consider it a decade old bug fix."*
 *
 * `shaft-paint.test.ts` owns the colours, off the files. What only a browser can
 * say is that the paint ARRIVES, on the route a player takes, in both rooms the
 * shaft stands in: the level-select room (`hangar-2016-shaft`, lit at run time
 * on DEV-439's reflective material) and the launch (`elevator-shaft-2016`,
 * baked, DEV-438, cut at the rim by DEV-443). Both looks: the paint is not a
 * look's, it is a fix.
 *
 * The count is of the mesh's own colour attribute: 2016's flat shaft carries
 * one colour and the painted one a few hundred, so it cannot pass on a shaft
 * that did not get the paint, and a shaft that is not in the scene fails the
 * premise first.
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/shaft-paint.spec.ts
 *
 * `@gpu`: a real world and hydrated `public/assets`.
 */

import { bootReady, switchSettled } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { board, INT_01_HOVERJET } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

test.describe.configure({ timeout: 420_000 })

/** The named mesh on the stage on screen: drawn, its material's flag, and its distinct colours. */
const shaftOf = (page: Page, name: string) =>
  page.evaluate((name) => {
    type Attr = {
      count: number
      getX(i: number): number
      getY(i: number): number
      getZ(i: number): number
    }
    type Node = {
      name?: string
      isMesh?: boolean
      visible?: boolean
      parent?: Node | null
      material?: { vertexColors?: boolean }
      geometry?: { getAttribute(n: string): Attr | undefined }
      traverse(f: (n: Node) => void): void
    }
    const stage = (globalThis as unknown as { __ff2: { stage: () => Node } }).__ff2.stage()
    let found: Node | null = null
    stage.traverse((n) => {
      if (!found && n.isMesh && n.name === name) found = n
    })
    const mesh = found as Node | null
    if (!mesh) return null
    let drawn = true
    for (let p: Node | null | undefined = mesh; p; p = p.parent)
      if (p.visible === false) drawn = false
    const c = mesh.geometry?.getAttribute('color')
    const distinct = new Set<string>()
    for (let i = 0; c && i < c.count; i++)
      distinct.add(`${c.getX(i).toFixed(4)},${c.getY(i).toFixed(4)},${c.getZ(i).toFixed(4)}`)
    return { drawn, vertexColors: mesh.material?.vertexColors === true, colours: distinct.size }
  }, name)

for (const edition of ['anniversary', 'classic']) {
  test(`@gpu the shaft wears the hangar's colours in both rooms, from the title, ${edition}`, async ({
    page,
  }) => {
    const lines: string[] = []
    page.on('console', (msg) => {
      if (/shaft's paint|2016's room|launch:/.test(msg.text())) lines.push(msg.text())
    })
    await page.goto(`/?xr=off&${PINNED}&edition=${edition}`)
    await firstPress(page)
    await bootReady(page, 240_000)
    await dropFocus(page)
    await pressTitleRow(page, TITLE_ROW.hangar)
    // The level-select room: its art lands after the room's first frame.
    await expect
      .poll(async () => (await shaftOf(page, 'hangar-2016-shaft'))?.drawn ?? false, {
        message: "2016's room stands in the level select",
        timeout: 60_000,
      })
      .toBe(true)
    const menu = await shaftOf(page, 'hangar-2016-shaft')
    console.info(`DEV-456 ${edition} level select: ${JSON.stringify(menu)}`)
    expect(menu?.vertexColors, 'the menu shaft reads its colours').toBe(true)
    expect(menu?.colours, 'the menu shaft is painted').toBeGreaterThan(100)

    await board(page, INT_01_HOVERJET, 1_000)
    await switchSettled(page, 240_000)
    expect(lines.join(' / '), "2016's launch rig stood").toContain("2016's room and shaft stand")
    const launch = await shaftOf(page, 'elevator-shaft-2016')
    console.info(`DEV-456 ${edition} launch: ${JSON.stringify(launch)}`)
    expect(launch?.drawn, 'the launch shaft is drawn').toBe(true)
    expect(launch?.vertexColors, 'the launch shaft reads its colours').toBe(true)
    expect(launch?.colours, 'the launch shaft is painted, through the cut').toBeGreaterThan(100)
    expect(lines.join(' / '), 'the paint landed').not.toContain("shaft's paint did not land")
  })
}
