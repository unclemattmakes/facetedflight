/**
 * The first thing you see.
 *
 * Matt, 2026-09-11: *"the title screen in the original FF started with the
 * player in a field, the 3D logo giant out front, and the ai racers on a
 * predetermined path. (press A to start)"* — then underground for the menus,
 * then the missions.
 *
 * The claims a screenshot cannot make: that it is the DEFAULT screen, that A
 * leaves it for the hangar, and that the racers are being flown by the title
 * rather than by the sim — which is the part that could silently regress into
 * two writers fighting over one transform.
 */

import { bootReady, missionReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { knownRed } from './fixtures/known-red'
import { firstPress, loadSettled } from './fixtures/landing'
import { expect, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW, titleRowsUp } from './fixtures/title'

const state = async (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: {
        stage: () => { traverse: (f: (o: { name?: string; visible?: boolean }) => void) => void }
        render: {
          scene: {
            traverse: (f: (o: { name?: string; visible?: boolean }) => void) => void
            getObjectByName: (n: string) =>
              | {
                  children: {
                    name?: string
                    position: { x: number; y: number; z: number }
                    visible: boolean
                  }[]
                }
              | undefined
          }
        }
      }
    }
    let title = false
    let hangar = false
    w.__ff2?.render.scene.traverse((o) => {
      // `title-screen`, not `title`: 2016's logo mesh carries a submesh called
      // `title` and it matched that instead — which is always visible on its
      // own flag, so both specs passed a hidden screen as a visible one.
      if (o.name === 'title-screen') title = o.visible === true
    })
    // The room is in the SCENE ON SCREEN, not in the mission's. Since DEV-076
    // the level select is its own `THREE.Scene`, and the only `hangar` in the
    // mission scene is the LAUNCH room at the base of the shaft — which nothing
    // ever hid, so this read "a room exists" and called it "you are in it".
    // It went on passing for the wrong reason until that room learned to hide
    // itself. DEV-094.
    w.__ff2?.stage().traverse((o) => {
      if (o.name === 'hangar') hangar = hangar || o.visible === true
    })
    // ── the flypast's ships, which are the TITLE's own since DEV-281 ──────
    //
    // They were the mission racers' meshes on loan, found through
    // `getObjectByName('racers')` and filtered for `racer:<id>` because that
    // group also holds a world-space trail per racer. There is no mission to
    // borrow from any more — boot builds the valley and nothing else — so the
    // title loads its two, names them `title-jet:<i>`, and parents them under
    // its own group.
    //
    // A traverse rather than `getObjectByName`, because the thing being counted
    // is "how many ships is the flypast flying" and a name search for a group
    // would answer a different question — the one DEV-215 got wrong by reading
    // `group.children` and finding ribbons.
    const jets: { x: number; y: number; z: number; visible: boolean; under: boolean }[] = []
    w.__ff2?.render.scene.traverse((o) => {
      if (!(o.name ?? '').startsWith('title-jet:')) return
      const j = o as unknown as {
        position: { x: number; y: number; z: number }
        visible: boolean
        parent: { name?: string; visible: boolean; parent: unknown } | null
      }
      // EFFECTIVE visibility, walked up the chain — three's `visible` is not
      // inherited as a property, so a jet whose own flag is true is still not
      // drawn under a hidden parent. Reading the own flag alone is the trap the
      // `title-screen` / `title` name collision already cost two specs: a thing
      // that is always true of itself looks like an answer.
      let visible = j.visible
      let under = false
      for (
        let node = j.parent;
        node !== null;
        node = node.parent as { name?: string; visible: boolean; parent: unknown } | null
      ) {
        if (node.name === 'title-screen') under = true
        if (!node.visible) visible = false
      }
      jets.push({ ...j.position, visible, under })
    })
    // Whatever the MISSION has, for the assertions about the world the title
    // hands over to. Empty on the title screen, which is the point.
    const racers = w.__ff2?.render.scene.getObjectByName('racers')
    return {
      title,
      hangar,
      jets,
      racers: (racers?.children ?? [])
        .filter((c) => (c.name ?? '').startsWith('racer:'))
        .map((c) => ({ ...c.position, visible: c.visible })),
    }
  })

/** The terrain groups in the drawn scene, by name. DEV-281's acceptance test. */
const terrains = async (page: import('@playwright/test').Page): Promise<string[]> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: { render: { scene: { traverse: (f: (o: { name?: string }) => void) => void } } }
    }
    const names: string[] = []
    w.__ff2?.render.scene.traverse((o) => {
      if (o.name === 'world-terrain' || o.name === 'title-valley') names.push(o.name)
    })
    return names.sort()
  })

test.describe('@gpu the title screen', () => {
  test.setTimeout(300_000)

  test('is where you start, and A leaves it', async ({ page }) => {
    await page.goto('/?xr=off')
    await firstPress(page)
    // `bootReady`, not `data-terrain-ready`: this URL boots the TITLE screen,
    // and since DEV-281 that builds no mission world. See `fixtures/boot.ts`.
    await bootReady(page, 180_000)
    // `dropFocus`, not `focusCanvas`: since DEV-301 a click on the TITLE is a
    // real press and starts the game, because the title never captures the
    // pointer and so has no capture to spend the click on. This test needs the
    // monument to still be there. `fixtures/canvas.ts` has the rule.
    await dropFocus(page)
    await page.waitForTimeout(1_500)

    const opening = await state(page)
    expect(opening.title, 'the monument is up').toBe(true)

    // ── the world you are looking at is the ONLY one loaded (DEV-281) ─────
    //
    // Matt's acceptance test, in his own words: *"you must never see two
    // worlds."* It is a claim about the SCENE and not about a promise, which is
    // the distinction DEV-280 got wrong — it released the curtain on a terrain
    // being ready while the other world was the one being drawn. So this asks
    // the scene: the title valley is in it and no mission land is.
    //
    // `world-terrain` is the name `buildWorld` gives the island's group, and it
    // exists for exactly this question (`completion.spec.ts` asks its own half
    // of it). A rename that lost it would show up here as a vacuous pass, which
    // is why the valley is asserted PRESENT in the same breath: if the naming
    // convention moved, both halves go, and one of them is red.
    const built = await terrains(page)
    expect(built, 'the title valley, and nothing else').toEqual(['title-valley'])

    // TWO jets, since DEV-215: `main_menu.unity` has two `SplineWalker`s
    // carrying ships — `npc_aiShip` on `path_ai_02` and `npc_aiShip_02` on
    // `path_ai`. They were borrowed racer meshes until DEV-281 and are the
    // title's own now, because there is no mission to borrow from.
    //
    // It was ONE for DEV-155, which had measured a spline nobody walks and
    // reasoned (correctly, for that case) that two ships on ONE path read
    // nose-to-tail. On two paths they never come within 344 m of each other.
    // Before DEV-155 this asserted `Math.min(...moved) > 1` — EVERY jet flying —
    // which is the right claim for a circuit and the wrong one for a flypast.
    //
    // The jets MOVE, and nothing but the title is moving them: the sim has not
    // been started and there are no racers in the scene at all. Two samples a
    // second apart is enough to tell flying from parked.
    const before = opening.jets
    expect(before.length, "the title's own two ships are in the scene").toBe(2)
    expect(opening.racers, 'and no mission racers to borrow from').toEqual([])
    await page.waitForTimeout(1_200)
    const after = (await state(page)).jets
    const moved = before.map((p, i) => {
      const q = after[i] as { x: number; y: number; z: number }
      return Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z)
    })
    // The slower of the two covers 1,703 m in 23.8 s, so 1.2 s of flying is
    // ~86 m — a metre is nowhere near the line between flying and parked.
    expect(moved.filter((m) => m > 1).length, 'both of 2016 title ships are flying').toBe(2)

    // A starts the game: down into the hangar. Behind 2016's menu fade since
    // DEV-427, so the monument goes on the black frame, about 0.64 s after the
    // press — later than this file's `hold` returns. Wait for the SCREEN, as a
    // player does, rather than for a number that was the old fade's.
    await pressTitleRow(page, TITLE_ROW.hangar) // DEV-441: Single Player, then Hangar
    await expect.poll(async () => (await state(page)).title, { timeout: 10_000 }).toBe(false)
    const started = await state(page)
    expect(started.title, 'the monument is gone').toBe(false)
    // And the ships go down with the screen. They are children of
    // `title.object`, so one `setVisible(false)` takes the lot — the borrowed
    // meshes DEV-155 had to hand back are gone, and with them the failure mode
    // that a mission could inherit an invisible opponent.
    //
    // Both halves, because either alone passes for the wrong reason: `under`
    // is the structural claim that ONE call can hide them, and `visible` is the
    // effective answer that it did.
    for (const jet of started.jets) {
      expect(jet.under, 'a title jet hangs off the title screen').toBe(true)
      expect(jet.visible, 'a title jet is not left flying over the hangar').toBe(false)
    }
  })

  test("DEV-610, DEV-619: the rows' words are centred, there is no heading, and the HUD's face has loaded", async ({
    page,
  }) => {
    knownRed('KR-16')
    // Matt, 2026-10-03: "center the text on their buttons (start, vr)". Read
    // off the plate's own canvas, one LINE OF TYPE at a time: the scanlines
    // that carry ink, grouped into runs of touching lines, each run's
    // leftmost and rightmost ink either side of the middle. Whole runs, not
    // single scanlines, because a scanline through descenders alone ("p" and
    // "g" of "plug") is lopsided on a centred line (the first version of this
    // check failed that way, by 49 px). The plate's edge and the selection's
    // box are symmetric, and their full-width strokes are dropped; a label
    // drawn from the left edge moves its run by a third of the plate.
    await page.goto('/?xr=off')
    await loadSettled(page)
    const menu = await titleRowsUp(page)
    await page.waitForTimeout(500)
    const read = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __ff2: {
          hudFont: () => string
          render: { scene: { traverse: (f: (o: unknown) => void) => void } }
        }
      }
      let image: HTMLCanvasElement | null = null
      w.__ff2.render.scene.traverse((o) => {
        const m = o as { name?: string; material?: { map?: { image?: unknown } } }
        const img = m.material?.map?.image
        if (m.name === 'title-menu' && img instanceof HTMLCanvasElement) image = img
      })
      if (image === null) return { font: w.__ff2.hudFont(), width: 0, lines: [] as number[][] }
      const c = image as HTMLCanvasElement
      const ctx = c.getContext('2d') as CanvasRenderingContext2D
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      const lines: number[][] = []
      // Inside the selection box's side strokes, which stand at half the pad.
      const inset = Math.round(c.width * 0.05)
      for (let y = 0; y < c.height; y++) {
        let min = -1
        let max = -1
        for (let x = inset; x < c.width - inset; x++) {
          const i = (y * c.width + x) * 4
          const lum = ((d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0)) / 3
          if ((d[i + 3] ?? 0) > 200 && lum > 150) {
            if (min < 0) min = x
            max = x
          }
        }
        // A full-width stroke (the box's top or bottom edge) is not type.
        if (min >= 0 && max - min < c.width * 0.8) lines.push([y, min, max])
      }
      return { font: w.__ff2.hudFont(), width: c.width, lines }
    })
    expect(read.width, 'the title plate was found').toBeGreaterThan(0)
    expect(read.lines.length, 'the plate carries ink').toBeGreaterThan(20)
    // Runs of touching scanlines: one line of type each.
    const runs: { top: number; min: number; max: number }[] = []
    let last = -2
    for (const [y = 0, a = 0, b = 0] of read.lines) {
      const run = runs.at(-1)
      if (run && y === last + 1) {
        run.min = Math.min(run.min, a)
        run.max = Math.max(run.max, b)
      } else runs.push({ top: y, min: a, max: b })
      last = y
    }
    // DEV-619 (Matt: "let's remove "-Fly-" from the title screen menu
    // panel"): a label and a note per row, and the footer. A heading would be
    // one more line.
    expect(runs.length, `lines of type: ${JSON.stringify(runs)}`).toBe(menu.rows.length * 2 + 1)
    for (const r of runs) {
      expect(
        Math.abs((r.min + r.max) / 2 - read.width / 2),
        `the line of type at y ${r.top} (${r.min}..${r.max}) sits off the plate centre by`,
      ).toBeLessThan(read.width * 0.02)
    }
    // And the edition's line has its face: the HUD's loader reached CRYSTAL
    // on the page, which is what `subtitleFont` waits for (unit-tested in
    // `title-type.test.ts`).
    expect(read.font).toBe('loaded')
  })

  test('?title=0 goes straight to the hangar', async ({ page }) => {
    await page.goto('/?xr=off&title=0')
    await firstPress(page)
    await missionReady(page, 180_000)
    await page.waitForTimeout(1_500)
    const s = await state(page)
    expect(s.title).toBe(false)
    expect(s.hangar).toBe(true)
  })
})
