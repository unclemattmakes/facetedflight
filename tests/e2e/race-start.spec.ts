/**
 * The moment a race starts. DEV-158 and DEV-159, and the deck it starts on
 * (DEV-443, DEV-444).
 *
 * Two notes from Matt, from a VR playthrough, both about the same instant:
 *
 *   DEV-158  *"the original game's hoverjets have a 'hover engine' that kept
 *            them off the ground. it kicked on when the race started (which i
 *            think didn't help with motion sickness to kick players up when
 *            they were expecting to go fwd) - instead of toggling it on, let's
 *            just start with it enabled. this way our player and ai jets don't
 *            start with their bellies on the pads."*
 *
 *   DEV-159  *"and only enable the 'next gate' arrow when the race has
 *            started"*
 *
 * And two from 2026-09-27, about the deck under it:
 *
 *   DEV-443  *"let's make sure that the starting platform (where all the racers
 *            start from) is there - i don't see it anymore."*
 *
 *   DEV-444  *"give the other planes the same "pad" art we had in the 2016
 *            game."*
 *
 * ── Why these claims are HERE and not in a unit test ─────────────────────
 *
 * Because both are about the drawn world. `racer-grid.ts`'s unit tests measure
 * the placement rule against the level JSON and against the 2016 recordings;
 * what they cannot see is the ART — the mesh, its own `ART_POSITION`, its
 * scale, the pad's rim — which is what Matt was actually looking at. So this
 * spec reads WORLD geometry out of the live scene graph and compares the lowest
 * point of each ship to the pad surface straight under it. A distance, measured
 * where the pixels are (the orientation lesson).
 *
 * Under it, and not the top of the pad's box: since DEV-444 a pad is 2016's
 * dish, a floor inside a rim, and a ship at the release altitude sits IN it —
 * over the floor, under the rim — as the player's did in 2016 (video f0055).
 * The box's top is the rim, which no belly is over. While the lift holds the
 * player, the player's pad is the lift's own dish (`elevator-deck-2016`), and
 * the grid's copy of it is off (`start-grid.ts`'s `setHeld`).
 *
 * And the comfort half of DEV-158 is a claim about a VELOCITY that only exists
 * while the game is running: the player's vertical speed must not STEP on the
 * tick the lift lets go. Measured at release, before and after: 0.00000 m/s,
 * both. The port never had 2016's kick — `HoverMotor` rays the terrain
 * heightfields and the start platform is not one of them, and the ship is held
 * kinematic until `flying` — and this is what keeps that true.
 *
 * DEV-443 and DEV-444 are also asked on the route a player takes, from the
 * title, on both editions (AGENT-NOTES §8): the deck is not walled off from the
 * seat by the shaft head, and every pad on it is 2016's.
 */

import { bootReady, missionReady, switchSettled } from './fixtures/boot'
import { dropFocus, focusCanvas } from './fixtures/canvas'
import { board, hold, INT_01_HOVERJET } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

/** Ships, by scene-graph name. */
const SHIPS = /^(racer:|hoverjet$)/
/** What a ship stands on: a grid pad, or the lift's own dish while it holds the player. */
const PADS = /^(start-pad-|elevator-deck-2016$|elevator-platform$)/

interface Ship {
  readonly key: string
  /** The ship's lowest drawn point, world. */
  readonly belly: readonly [number, number, number]
  /** The highest drawn pad surface straight under it, or null over none. */
  readonly surface: number | null
  /** Which pad that surface belongs to. */
  readonly pad: string | null
}

interface Measured {
  readonly ships: readonly Ship[]
  /** Pads drawn this frame, by name. */
  readonly pads: readonly string[]
  readonly phase: string
  readonly playerY: number | null
  /** Whether `next-gate-arrow` is currently drawn. */
  readonly arrowVisible: boolean | null
}

const measure = async (page: Page): Promise<Measured> =>
  page.evaluate(
    ({ ships, pads }) => {
      const w = globalThis as unknown as {
        __ff2?: {
          render: { scene: Record<string, unknown> }
          flight?: () => { jet: { body: { position: { y: number } } } } | null
          launch: () => { phase: string }
        }
      }
      type Attr = {
        count: number
        getX(i: number): number
        getY(i: number): number
        getZ(i: number): number
      }
      type Node = {
        name?: string
        visible?: boolean
        isMesh?: boolean
        parent?: Node | null
        geometry?: {
          getAttribute(n: string): Attr | undefined
          index?: { count: number; getX(i: number): number } | null
        }
        matrixWorld?: { elements: number[] }
        updateMatrixWorld?: (force: boolean) => void
        traverse?: (f: (n: Node) => void) => void
      }
      const scene = w.__ff2?.render.scene as unknown as Node
      scene.updateMatrixWorld?.(true)
      const drawn = (n: Node): boolean => {
        for (let p: Node | null | undefined = n; p; p = p.parent)
          if (p.visible === false) return false
        return true
      }
      const world = (n: Node, a: Attr, i: number): [number, number, number] => {
        const e = n.matrixWorld?.elements ?? []
        const x = a.getX(i)
        const y = a.getY(i)
        const z = a.getZ(i)
        return [
          (e[0] as number) * x + (e[4] as number) * y + (e[8] as number) * z + (e[12] as number),
          (e[1] as number) * x + (e[5] as number) * y + (e[9] as number) * z + (e[13] as number),
          (e[2] as number) * x + (e[6] as number) * y + (e[10] as number) * z + (e[14] as number),
        ]
      }
      const meshesOf = (root: Node): Node[] => {
        const out: Node[] = []
        root.traverse?.((n) => {
          if (n.isMesh && n.geometry?.getAttribute('position') && drawn(n)) out.push(n)
        })
        return out
      }
      // Every drawn pad triangle, in world space, once.
      const shipRe = new RegExp(ships)
      const padRe = new RegExp(pads)
      const tris: { pad: string; a: number[]; b: number[]; c: number[] }[] = []
      const padNames: string[] = []
      const shipRoots: Node[] = []
      let arrowVisible: boolean | null = null
      scene.traverse?.((n) => {
        const name = n.name ?? ''
        if (name === 'next-gate-arrow') arrowVisible = n.visible === true
        if (shipRe.test(name)) shipRoots.push(n)
        if (!padRe.test(name) || !drawn(n)) return
        const meshes = meshesOf(n)
        if (meshes.length === 0) return
        padNames.push(name)
        for (const m of meshes) {
          const p = m.geometry?.getAttribute('position') as Attr
          const index = m.geometry?.index
          const count = index ? index.count : p.count
          const at = (k: number) => (index ? index.getX(k) : k)
          for (let t = 0; t + 2 < count; t += 3)
            tris.push({
              pad: name,
              a: world(m, p, at(t)),
              b: world(m, p, at(t + 1)),
              c: world(m, p, at(t + 2)),
            })
        }
      })
      // The highest pad surface straight under (x, z): a vertical ray, by the
      // barycentric test in the ground plane.
      const under = (x: number, z: number): { y: number; pad: string } | null => {
        let best: { y: number; pad: string } | null = null
        for (const { pad, a, b, c } of tris) {
          const [ax, ay, az] = a as [number, number, number]
          const [bx, by, bz] = b as [number, number, number]
          const [cx, cy, cz] = c as [number, number, number]
          const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
          if (Math.abs(d) < 1e-12) continue
          const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d
          const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d
          const l3 = 1 - l1 - l2
          if (l1 < 0 || l2 < 0 || l3 < 0) continue
          const y = l1 * ay + l2 * by + l3 * cy
          if (!best || y > best.y) best = { y, pad }
        }
        return best
      }
      const out: Ship[] = []
      shipRoots.forEach((root, i) => {
        let low: [number, number, number] | null = null
        for (const m of meshesOf(root)) {
          const p = m.geometry?.getAttribute('position') as Attr
          for (let k = 0; k < p.count; k++) {
            const v = world(m, p, k)
            if (!low || v[1] < low[1]) low = v
          }
        }
        if (!low) return
        const hit = under(low[0], low[2])
        out.push({
          key: `${root.name}#${i}`,
          belly: low,
          surface: hit?.y ?? null,
          pad: hit?.pad ?? null,
        })
      })
      return {
        ships: out,
        pads: padNames,
        phase: w.__ff2?.launch().phase ?? 'none',
        playerY: w.__ff2?.flight?.()?.jet.body.position.y ?? null,
        arrowVisible,
      }
    },
    { ships: SHIPS.source, pads: PADS.source },
  )

const onPad = async (page: Page, url: string): Promise<Measured> => {
  await page.goto(url)
  await firstPress(page)
  await missionReady(page, 240_000)
  // A frame or two for the scene graph to carry the first poses.
  await page.waitForTimeout(1_500)
  return measure(page)
}

/** Every ship over a pad, with its lowest point clear of the surface under it. */
const expectBelliesClear = (m: Measured, label: string): void => {
  // The premise, loud: this frame has to HAVE a grid in it, or the sweep
  // below passes by finding nothing. Anniversary's int_01 grid is the player
  // plus five racers.
  expect(m.pads.length, `${label}: pads drawn`).toBeGreaterThanOrEqual(3)
  expect(m.ships.length, `${label}: ships drawn`).toBeGreaterThanOrEqual(3)
  for (const ship of m.ships) {
    expect(ship.surface, `${label}: ${ship.key} has a pad under it`).not.toBeNull()
    // THE CLAIM. Before DEV-158 one racer per course came out at -0.435 m
    // here, measured from the art: a ship whose hull is inside the plinth it
    // is standing on. Loose on purpose — the exact gap is a headset call
    // (the ledger row says so) and what must never come back is a negative.
    const clearance = (ship.belly[1] as number) - (ship.surface as number)
    console.info(`${label}: ${ship.key} over ${ship.pad} by ${clearance.toFixed(3)} m`)
    expect(clearance, `${label}: ${ship.key} belly over ${ship.pad}`).toBeGreaterThan(0.05)
  }
}

/**
 * DEV-443 and DEV-444, off the scene graph: nothing of the lift's shaft stands
 * over the deck's walking surface, and every grid pad draws 2016's dish and
 * nothing else.
 */
const deckCensus = async (page: Page) =>
  page.evaluate(() => {
    type Node = {
      name?: string
      visible?: boolean
      isMesh?: boolean
      parent?: Node | null
      children: Node[]
      geometry?: {
        getAttribute(n: string): {
          count: number
          getX(i: number): number
          getY(i: number): number
          getZ(i: number): number
        }
      }
      matrixWorld: { elements: number[] }
      updateMatrixWorld: (force: boolean) => void
      traverse: (f: (n: Node) => void) => void
    }
    const scene = (globalThis as unknown as { __ff2: { render: { scene: Node } } }).__ff2.render
      .scene
    scene.updateMatrixWorld(true)
    const extremeY = (n: Node, pick: (a: number, b: number) => number, seed: number): number => {
      const p = n.geometry?.getAttribute('position')
      const e = n.matrixWorld.elements
      let y = seed
      for (let i = 0; p && i < p.count; i++)
        y = pick(
          y,
          (e[1] as number) * p.getX(i) +
            (e[5] as number) * p.getY(i) +
            (e[9] as number) * p.getZ(i) +
            (e[13] as number),
        )
      return y
    }
    let shaftTop: number | null = null
    let deckTop: number | null = null
    let deck2016: boolean | null = null
    let slabsDrawn = 0
    const pads: { name: string; drawn: string[] }[] = []
    scene.traverse((n) => {
      if (n.name === 'elevator-shaft-2016' && n.isMesh) shaftTop = extremeY(n, Math.max, -Infinity)
      if (n.name === 'start-slab' && n.isMesh) {
        const top = extremeY(n, Math.max, -Infinity)
        deckTop = deckTop === null ? top : Math.min(deckTop, top)
        if (n.visible) slabsDrawn++
      }
      // DEV-549: 2016's deck, one mesh.
      if (n.name === 'start-deck-2016' && n.isMesh) deck2016 = n.visible === true
      if (/^start-pad-(player|ai|spare)$/.test(n.name ?? '') && !n.isMesh)
        pads.push({
          name: n.name as string,
          drawn: n.children.filter((c) => c.visible).map((c) => c.name ?? ''),
        })
    })
    // Widened by hand: TS reads the `let`s as the `null` they start as, not
    // seeing the callback write them.
    return {
      shaftTop: shaftTop as number | null,
      deckTop: deckTop as number | null,
      deck2016: deck2016 as boolean | null,
      slabsDrawn,
      pads,
    }
  })

const expectDeckInView = (c: Awaited<ReturnType<typeof deckCensus>>, label: string): void => {
  console.info(
    `${label}: shaft top ${c.shaftTop}, deck top ${c.deckTop}, pads ${JSON.stringify(c.pads)}`,
  )
  // The premise: 2016's shaft stands (DEV-438's art landed) and there is a deck.
  expect(c.shaftTop, `${label}: 2016's shaft is in the scene`).not.toBeNull()
  expect(c.deckTop, `${label}: the start deck is in the scene`).not.toBeNull()
  // DEV-443. Its head stood 1.65-1.96 m over this line and walled the deck off.
  expect(
    c.shaftTop as number,
    `${label}: the shaft head under the deck's walking surface`,
  ).toBeLessThan(c.deckTop as number)
  // DEV-444. Every pad on the deck is 2016's dish, and only that — and a
  // pad off the deck its hover glow under it (DEV-550).
  expect(c.pads.length, `${label}: pads on the deck`).toBeGreaterThanOrEqual(3)
  for (const pad of c.pads)
    expect(
      pad.drawn.filter((n) => n !== 'start-pad-glow'),
      `${label}: ${pad.name}`,
    ).toEqual(['start-pad-2016'])
  // DEV-549. 2016's deck stands where FF2's slabs stood, and they are off.
  expect(c.deck2016, `${label}: 2016's deck is drawn`).toBe(true)
  expect(c.slabsDrawn, `${label}: the slabs are off`).toBe(0)
}

test.describe('@gpu the start of a race', () => {
  test.setTimeout(420_000)

  test('DEV-158: no ship stands with its belly inside a pad', async ({ page }) => {
    const m = await onPad(page, '/?mission=int_01_hoverJet&xr=off&ride=0&menu=0')
    expectBelliesClear(m, 'int_01 on the pad')
  })

  // DEV-457. Matt: *"5 racers on rookie"*. The two rookie courses authored no
  // `ai` pad and no deck, so their five are 2016's two ghost starts and the
  // three slots, each on DEV-444's pad under the release.
  for (const mission of ['rookie_01_hoverJet', 'rookie_02_hoverJet']) {
    test(`DEV-457: ${mission} races five, each over a pad`, async ({ page }) => {
      const m = await onPad(page, `/?mission=${mission}&xr=off&ride=0&menu=0&${PINNED}`)
      const racers = m.ships.filter((s) => s.key.startsWith('racer:'))
      expect(racers.length, `${mission}: racers on the grid`).toBe(5)
      expectBelliesClear(m, `${mission} on the pad`)
    })
  }

  for (const edition of ['anniversary', 'classic']) {
    test(`DEV-443/444: from the title, ${edition} — the deck in view, 2016's pads on it`, async ({
      page,
    }) => {
      // The route a player takes: title, room, the course, the ride.
      const lines: string[] = []
      page.on('console', (msg) => {
        if (/start grid|start deck|launch:/.test(msg.text())) lines.push(msg.text())
      })
      await page.goto(`/?xr=off&${PINNED}&edition=${edition}`)
      await firstPress(page)
      await bootReady(page, 240_000)
      await dropFocus(page)
      // The room, named (DEV-441: behind the Single Player door).
      await pressTitleRow(page, TITLE_ROW.hangar)
      await board(page, INT_01_HOVERJET, 1_000)
      await switchSettled(page, 240_000)
      expect(lines.join(' / '), 'the pads landed before the warm').toContain(
        "start grid: 2016's pads stand (DEV-444)",
      )
      expect(lines.join(' / '), 'and the deck (DEV-549)').toContain(
        "start deck: 2016's deck stands (DEV-549)",
      )
      expectDeckInView(await deckCensus(page), `${edition} at the foot`)
      // Up the shaft to the top, where Matt was looking.
      await focusCanvas(page)
      await hold(page, 'Enter', 0)
      await expect
        .poll(
          async () =>
            page.evaluate(
              () =>
                (
                  globalThis as unknown as { __ff2: { launch: () => { phase: string } } }
                ).__ff2.launch().phase,
            ),
          { timeout: 60_000, intervals: [250] },
        )
        .toBe('countdown')
      expectDeckInView(await deckCensus(page), `${edition} at the top`)
      expectBelliesClear(await measure(page), `${edition} at the top`)
    })
  }

  test('DEV-158: the player does not get shoved upward on GO', async ({ page }) => {
    // The comfort half. In a headset a surprise on the VERTICAL axis, at the
    // instant you are braced to go forward, is the worst one there is.
    await page.goto('/?mission=int_01_hoverJet&xr=off&ride=0&menu=0')
    await firstPress(page)
    await missionReady(page, 240_000)
    await page.waitForTimeout(1_000)
    await focusCanvas(page)
    await page.keyboard.down('Enter')
    await page.waitForTimeout(150)
    await page.keyboard.up('Enter')

    // Sample every frame across the release and keep the worst vertical speed
    // seen from the last second of the countdown to a second past GO.
    const worst = await page.evaluate(
      async () =>
        await new Promise<{ before: number; after: number; sawFlying: boolean; frames: number }>(
          (resolve) => {
            const w = globalThis as unknown as {
              __ff2: {
                flight: () => { jet: { body: { velocity: { y: number } } } } | null
                launch: () => { phase: string }
              }
            }
            let before = 0
            let after = 0
            let flying = 0
            let frames = 0
            const tick = (): void => {
              frames++
              const vy = Math.abs(w.__ff2.flight()?.jet.body.velocity.y ?? 0)
              if (w.__ff2.launch().phase === 'flying') {
                flying++
                if (vy > after) after = vy
              } else if (vy > before) before = vy
              if (frames > 1_600 || flying > 120) {
                resolve({ before, after, sawFlying: flying > 0, frames })
              } else requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
          },
        ),
    )
    // The premise: the run actually started inside the window.
    expect(worst.sawFlying, 'reached the flying phase').toBe(true)
    // 2016 turned the hover engine loose the instant the lift let go, and the
    // port must not. Nothing touches the stick in this window, so anything
    // above a few cm/s is a shove. Measured: 0.00000 m/s on both sides.
    expect(worst.before, 'vertical speed while held').toBeLessThan(0.05)
    expect(worst.after, 'vertical speed on GO').toBeLessThan(0.05)
  })

  test('DEV-159: the next-gate arrow is down until the race is running', async ({ page }) => {
    // It pointed at gate 1 through the briefing, the lift and the 3-2-1 — noise
    // before it is information.
    const m = await onPad(page, '/?mission=int_01_hoverJet&xr=off&ride=0&menu=0')
    // The premise: the arrow EXISTS in the graph and the run has not started.
    expect(m.arrowVisible, 'arrow node present').not.toBeNull()
    expect(m.phase).not.toBe('flying')
    expect(m.arrowVisible, 'arrow hidden on the pad').toBe(false)

    await focusCanvas(page)
    await page.keyboard.down('Enter')
    await page.waitForTimeout(150)
    await page.keyboard.up('Enter')

    // It must stay down for the WHOLE countdown, not just on the first frame.
    const duringCountdown = await page.evaluate(
      async () =>
        await new Promise<{ everVisible: boolean; sawCountdown: boolean }>((resolve) => {
          const w = globalThis as unknown as {
            __ff2: {
              render: {
                scene: { traverse: (f: (o: { name?: string; visible?: boolean }) => void) => void }
              }
              launch: () => { phase: string }
            }
          }
          let everVisible = false
          let sawCountdown = false
          const tick = (): void => {
            const phase = w.__ff2.launch().phase
            if (phase === 'countdown') sawCountdown = true
            if (phase === 'flying') {
              resolve({ everVisible, sawCountdown })
              return
            }
            w.__ff2.render.scene.traverse((o) => {
              if (o.name === 'next-gate-arrow' && o.visible === true) everVisible = true
            })
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }),
    )
    expect(duringCountdown.sawCountdown, 'the countdown ran').toBe(true)
    expect(duringCountdown.everVisible, 'arrow stayed down through the countdown').toBe(false)
  })

  test('DEV-159: and it comes back UP once the run is under way', async ({ page }) => {
    // The other half, and the one that catches a gate stuck ON. "Down before
    // GO" is satisfied by an arrow that is broken outright, so the guard is
    // only worth having with this beside it.
    //
    // `?autopilot=1` flies the course, which is what makes this reliable: the
    // arrow hides inside a 10 degree cone of the nose and int_01's line folds
    // back on itself twice, so a target goes off the nose within the first few
    // corners. Nothing here asserts WHEN — only that it happens at all.
    await page.goto('/?mission=int_01_hoverJet&autopilot=1&xr=off&ride=0')
    await firstPress(page)
    await missionReady(page, 240_000)
    await expect
      .poll(async () => (await measure(page)).phase, { timeout: 120_000, intervals: [500] })
      .toBe('flying')
    await expect
      .poll(async () => (await measure(page)).arrowVisible, {
        timeout: 90_000,
        intervals: [500],
      })
      .toBe(true)
  })
})
