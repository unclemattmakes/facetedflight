/**
 * tests/e2e/launch-art.spec.ts — 2016's launch room and shaft, ridden (DEV-438).
 *
 * Matt, 2026-09-26: *"port the launch room."* `render/hangar-art.ts`'s
 * `createLaunchArt` stands the level-select room's own file under a mission's
 * ship at a mission rig's size, and `render/elevator.ts`'s `dress()` swaps the
 * shaft and the deck. The unit suite owns the geometry (`launch-art.test.ts`:
 * the segments 12 m apart, the deck where the mission stands it, a sealed ride).
 * What only a browser can say is that it ARRIVES — before the warm-up, on the
 * two routes a player boots by — that the generated rig steps aside, and what
 * a frame costs.
 *
 *   `photographs the launch` asserts nothing about the art: it reads the frame
 *     both ways and, with `LAUNCH_ART_SHOT_DIR` set, photographs the pad, the
 *     room from behind the jet, the climb and the release — the last to set
 *     beside 2016's own frame of it (video f0055).
 *   `stands 2016's launch rig in place of the generated one` is the gate: the
 *     art is drawn, every generated piece it replaces is not, the room keeps its
 *     lamp, nothing of the world is inside 2016's room, and the draw calls went
 *     DOWN.
 *   `stands it on the route a player takes` walks title -> room -> course.
 *
 * Counts are of ONE FRAME (`renderer.info.render`, median over 30), which is
 * contention-proof (AGENT-NOTES §1). The program count is a count SO FAR and is
 * printed, never asserted — `ride-hitch.spec.ts` is the ride's program guard.
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/launch-art.spec.ts
 *
 * `@gpu`: a real world and hydrated `public/assets`.
 */

import { bootReady, missionReady } from './fixtures/boot'
import { dropFocus, focusCanvas } from './fixtures/canvas'
import { board, hangarAim, hold, INT_01_HOVERJET, throughDoors } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { drawState, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

test.describe.configure({ timeout: 420_000 })

const PIN_TAG = PINNED.replace(/[=&]/g, '-')
const MISSION = process.env.LAUNCH_ART_MISSION ?? 'int_01_hoverJet'
/** The chosen edition: the launch follows it, as the room does. Unset is the build's default. */
const EDITION = process.env.LAUNCH_ART_EDITION ?? null
const EDITION_Q = EDITION ? `&edition=${EDITION}` : ''

/** 2016's four pieces, and the generated ones each stands in for. */
const ART = [
  'launch-room-2016',
  'launch-room-2016-lamps',
  'elevator-shaft-2016',
  'elevator-deck-2016',
]
const GENERATED = [
  'hangar-shell',
  'hangar-floor',
  'hangar-strips',
  'hangar-dressing',
  'elevator-shaft',
  'elevator-shaft-wall',
  'elevator-shaft-strips',
]

const bootMission = async (page: Page) => {
  await page.goto(`/?mission=${MISSION}&xr=off&title=0&menu=0&${PINNED}${EDITION_Q}`)
  await firstPress(page)
  await missionReady(page, 240_000)
  await focusCanvas(page)
  await page.waitForTimeout(2_000)
}

const launch = (page: Page): Promise<{ phase: string; rise: number }> =>
  page.evaluate(() => {
    const l = (
      globalThis as unknown as { __ff2: { launch: () => { phase: string; rise: number } } }
    ).__ff2.launch()
    return { phase: l.phase, rise: l.rise }
  })

interface Census {
  readonly calls: number
  readonly triangles: number
  readonly programs: number
}

const census = async (page: Page): Promise<Census> => {
  const s = await page.evaluate(async () => {
    const w = globalThis as unknown as {
      __ff2: {
        render: {
          renderer: {
            info: { render: { calls: number; triangles: number }; programs: unknown[] | null }
          }
        }
      }
    }
    const info = w.__ff2.render.renderer.info
    const calls: number[] = []
    const tris: number[] = []
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      calls.push(info.render.calls)
      tris.push(info.render.triangles)
    }
    return { calls, tris, programs: info.programs?.length ?? -1 }
  })
  const mid = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number
  return { calls: mid(s.calls), triangles: mid(s.tris), programs: s.programs }
}

/** What the launch is drawing, by name, off the stage on screen. */
const launchState = async (page: Page) =>
  page.evaluate(() => {
    interface Node {
      name: string
      visible: boolean
      parent: Node | null
      traverse: (fn: (o: Node) => void) => void
    }
    const ff = (globalThis as unknown as { __ff2?: { stage: () => Node } }).__ff2
    if (!ff) return null
    const drawn = (o: Node): boolean => {
      for (let n: Node | null = o; n; n = n.parent) if (!n.visible) return false
      return true
    }
    const names: Record<string, number> = {}
    const present: Record<string, number> = {}
    ff.stage().traverse((o) => {
      if (!o.name) return
      present[o.name] = (present[o.name] ?? 0) + 1
      if (drawn(o)) names[o.name] = (names[o.name] ?? 0) + 1
    })
    return { names, present }
  })

/**
 * Show the generated rig (true) or 2016's (false), by visibility alone — the
 * build's own objects, both sets of which are in the scene; a harness
 * measurement, not a different build. Returns how many objects it touched.
 */
const showGenerated = async (page: Page, generated: boolean): Promise<number> =>
  page.evaluate(
    ({ generated, art, gen }) => {
      interface Node {
        name: string
        visible: boolean
        isMesh?: boolean
        children: Node[]
        traverse: (fn: (o: Node) => void) => void
      }
      const ff = (globalThis as unknown as { __ff2?: { stage: () => Node } }).__ff2
      if (!ff) return 0
      let touched = 0
      ff.stage().traverse((o) => {
        if (art.includes(o.name)) {
          o.visible = !generated
          touched++
        } else if (gen.includes(o.name)) {
          o.visible = generated
          touched++
        } else if (o.name === 'elevator-platform') {
          // The generated slab and its rim are the platform's unnamed meshes.
          for (const c of o.children) {
            if (c.name === 'elevator-deck-2016' || !c.isMesh) continue
            c.visible = generated
            touched++
          }
        }
      })
      return touched
    },
    { generated, art: ART, gen: GENERATED },
  )

/**
 * World vertices inside 2016's ROOM, by the room mesh's own extent: a cylinder
 * about the lift's axis out to its widest vertex, floor to top. The TUBE above
 * is `launch-ride-on-switch.spec.ts`'s scan, whose bore (6.78 m about the ship)
 * contains 2016's (under 5.3 m about an axis 1.3 m away) — see DEVIATIONS DEV-438.
 */
const worldInRoom2016 = (page: Page) =>
  page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    const ff = (globalThis as any).__ff2
    const scene = ff.render.scene
    scene.updateMatrixWorld(true)
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    let anchor: any = null
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    let room: any = null
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    let deck: any = null
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    scene.traverse((o: any) => {
      if (o.name === 'launch-anchor') anchor = o
      if (o.name === 'launch-room-2016') room = o
      if (o.name === 'elevator-deck-2016') deck = o
    })
    if (!anchor || !room || !deck) return null
    const inv = anchor.matrixWorld.clone().invert()
    // The axis: the deck's centre, which rides the lift (unit suite: within 0.6 m).
    if (!deck.geometry.boundingBox) deck.geometry.computeBoundingBox()
    const axis = deck.geometry.boundingBox
      .getCenter(deck.position.clone())
      .applyMatrix4(deck.matrixWorld)
      .applyMatrix4(inv)
    const toAnchor = room.matrixWorld.clone().premultiply(inv)
    const p = room.geometry.attributes.position
    const v = axis.clone()
    let radius = 0
    let bottom = Number.POSITIVE_INFINITY
    let top = Number.NEGATIVE_INFINITY
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(toAnchor)
      radius = Math.max(radius, Math.hypot(v.x - axis.x, v.z - axis.z))
      bottom = Math.min(bottom, v.y)
      top = Math.max(top, v.y)
    }
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    const drawn = (o: any): boolean => {
      for (let n = o; n; n = n.parent) if (n.visible === false) return false
      return true
    }
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    const under = (o: any, name: string): boolean => {
      for (let n = o; n; n = n.parent) if (n.name === name) return true
      return false
    }
    let inside = 0
    const offenders: string[] = []
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    scene.traverse((o: any) => {
      if (!o.isMesh || !o.geometry?.attributes?.position || !drawn(o)) return
      if (under(o, 'launch-anchor') || under(o, 'hoverjet') || under(o, 'jumpseat')) return
      const m = o.matrixWorld.clone().premultiply(inv)
      const q = o.geometry.attributes.position
      let hits = 0
      for (let i = 0; i < q.count; i++) {
        v.fromBufferAttribute(q, i).applyMatrix4(m)
        if (v.y < bottom || v.y > top) continue
        if (Math.hypot(v.x - axis.x, v.z - axis.z) > radius) continue
        hits++
      }
      if (hits) {
        inside += hits
        offenders.push(`${o.name || o.parent?.name || o.type}:${hits}`)
      }
    })
    return { radius, bottom, top, inside, offenders: offenders.slice(0, 8) }
  })

const shoot = async (page: Page, file: string) => {
  const state = await drawState(page)
  await page.screenshot({ path: file })
  console.log(`[DEV-438] ${file.split('/').at(-1)} · ${drawStateLine(state)}`)
}

test.describe('@gpu the launch room and shaft (DEV-438)', () => {
  test('photographs the launch: the pad, the room, the climb, the release', async ({ page }) => {
    await bootMission(page)
    const state = await launchState(page)
    const ported = (state?.names['launch-room-2016'] ?? 0) > 0
    const at = await census(page)
    console.log(
      `[DEV-438] ${MISSION} on the pad: ${at.calls} draw calls · ${at.triangles} triangles · ${at.programs} programs so far · 2016's launch rig ${ported ? 'DRAWN' : 'absent'}`,
    )
    const dir = process.env.LAUNCH_ART_SHOT_DIR
    if (!dir) return
    const tag = `${MISSION}${EDITION ? `-${EDITION}` : ''}-${PIN_TAG}`
    await shoot(page, `${dir}/launch-pad-${ported ? 'after' : 'before'}-${tag}.png`)
    if (ported) {
      await showGenerated(page, true)
      await page.waitForTimeout(300)
      await shoot(page, `${dir}/launch-pad-generated-${tag}.png`)
      await showGenerated(page, false)
      await page.waitForTimeout(300)
    }
    // Behind the jet: the player's own third-person view (V), the room round it.
    await hold(page, 'KeyV', 800)
    await shoot(page, `${dir}/launch-room-${ported ? 'after' : 'before'}-${tag}.png`)
    if (ported) {
      await showGenerated(page, true)
      await page.waitForTimeout(300)
      await shoot(page, `${dir}/launch-room-generated-${tag}.png`)
      await showGenerated(page, false)
      await page.waitForTimeout(300)
    }
    await hold(page, 'KeyV', 800)
    // Up the shaft. Frames lag the probe by ~0.5 s, so each mark is read, then shot.
    await hold(page, 'Enter', 100)
    for (const mark of [30, 80, 98, 106.5]) {
      await expect
        .poll(async () => (await launch(page)).rise, { timeout: 60_000, intervals: [100] })
        .toBeGreaterThanOrEqual(mark)
      await shoot(
        page,
        `${dir}/launch-rise${Math.round(mark)}-${ported ? 'after' : 'before'}-${tag}.png`,
      )
    }
    // And from behind the jet at the top: the shaft head round the lift, the way
    // anyone watching the release from outside sees it.
    await hold(page, 'KeyV', 800)
    await shoot(page, `${dir}/launch-top-third-${ported ? 'after' : 'before'}-${tag}.png`)
    await hold(page, 'KeyV', 400)
  })

  test("stands 2016's launch rig in place of the generated one", async ({ page }) => {
    const lines: string[] = []
    page.on('console', (m) => {
      if (m.text().startsWith('launch:')) lines.push(m.text())
    })
    await bootMission(page)
    const state = await launchState(page)
    expect(state, 'the stage is readable').not.toBeNull()
    const names = state?.names ?? {}
    expect(lines.join(' / '), 'the build says it stood').toContain("2016's room and shaft stand")
    for (const piece of ART) expect(names[piece], `${piece} is drawn`).toBe(1)
    for (const piece of GENERATED) {
      expect(state?.present[piece] ?? 0, `${piece} is still in the scene`).toBeGreaterThan(0)
      expect(names[piece] ?? 0, `${piece} is not drawn`).toBe(0)
    }
    expect(names['launch-room-lamp'], 'the room keeps its lamp').toBe(1)
    expect((await launch(page)).phase, 'on the pad').toBe('waiting')

    const room = await worldInRoom2016(page)
    expect(room, "2016's room is measurable").not.toBeNull()
    console.log(
      `[DEV-438] 2016's room about the lift: r ${room?.radius.toFixed(2)} m, y ${room?.bottom.toFixed(2)}..${room?.top.toFixed(2)}`,
    )
    expect(room?.inside, `nothing of the world in 2016's room: ${room?.offenders.join(', ')}`).toBe(
      0,
    )

    const ported = await census(page)
    expect(await showGenerated(page, true), 'the swap is reversible').toBeGreaterThan(0)
    const generated = await census(page)
    await showGenerated(page, false)
    const again = await census(page)
    console.log(
      `[DEV-438] one frame on the pad — generated rig: ${generated.calls} draw calls · ${generated.triangles} triangles; 2016's: ${ported.calls} draw calls · ${ported.triangles} triangles (${again.calls} after the flip back); ${again.programs} programs so far`,
    )
    expect(ported.calls, "2016's rig draws in fewer calls than the generated one").toBeLessThan(
      generated.calls,
    )
    expect(again.calls, 'and still does after the flip back').toBeLessThan(generated.calls)
  })

  test('stands it on the route a player takes: title, room, course', async ({ page }) => {
    const lines: string[] = []
    page.on('console', (m) => {
      if (m.text().startsWith('launch:')) lines.push(m.text())
    })
    await page.goto(`/?xr=off&${PINNED}${EDITION_Q}`)
    await firstPress(page)
    await bootReady(page, 240_000)
    await dropFocus(page)
    await page.waitForTimeout(1_200)
    await pressTitleRow(page, TITLE_ROW.hangar) // DEV-558: START, the hangar's doors
    await throughDoors(page) // and SINGLE PLAYER, to the aircraft
    expect((await hangarAim(page))?.view, 'in the room').toBe('vehicles')
    await board(page, INT_01_HOVERJET)
    await page.waitForTimeout(1_000)
    const names = (await launchState(page))?.names ?? {}
    expect(lines.join(' / '), 'the build says it stood').toContain("2016's room and shaft stand")
    for (const piece of ART) expect(names[piece], `${piece} is drawn`).toBe(1)
    expect((await launch(page)).phase, 'on the pad').toBe('waiting')
  })
})
