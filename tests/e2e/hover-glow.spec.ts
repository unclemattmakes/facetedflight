/**
 * tests/e2e/hover-glow.spec.ts — the anti-grav wing, 2016's own art, from the
 * chase camera (DEV-322, superseding DEV-310's first-party strips).
 *
 * ── What changed, and what did not ───────────────────────────────────────
 *
 * DEV-310 SWEPT a placement, because its strips were first-party and had to be
 * put somewhere: six arms, one frame each, DEV-040's recipe. There is nothing
 * left to sweep. The wing is `hoverjet-wings.glb`, converted from
 * `GhostRacer.prefab` into the hull GLB's own frame and hung off the hull at
 * identity — the placement is the prefab's, and `tests/unit/hover-glow.test.ts`
 * measures it against the prefab's own witnesses and the real hull. So the arms
 * are gone and this keeps the two things only a frame can answer: **does it
 * read, and how many pixels is it.**
 *
 * ── The measurement ──────────────────────────────────────────────────────
 *
 * A visual bug needs enough pixels to be visible (DEV-044's four-pixel jets).
 * So the A/B is the part switched OFF against the part switched ON at the SAME
 * frozen tick, with a CONTROL pair — OFF, ON, ON-again — because a frozen sim
 * is not a frozen frame: the waves and the gate particles run off a wall
 * clock. The part's own pixels are the ones that changed between the arms and
 * NOT in the control.
 *
 * ── Same build, same code path ───────────────────────────────────────────
 *
 * The spec presses V — the CHANGE VIEW key a player presses — and toggles the
 * `hover-glow` group through `__ff2.render.scene`, the dev-only handle every
 * screenshot spec here reads. No query flag, no variant build, no mock.
 *
 * ── The V-press wait, fixed ──────────────────────────────────────────────
 *
 * DEV-305's follow-up found DEV-310's poll vacuous: it waited for
 * `ship_third_person` to be VISIBLE, and with `render.shipShadow` on the
 * exterior is visible in the SEAT too — drawn colourless, for its shadow. So it
 * passed before the view had flipped. The wait here is on what the chase view
 * actually changes: the hull's material writing COLOUR.
 *
 * `@gpu`, and PINNED: `render/quality.ts` drops a tier on a starved box and a
 * tier drop moves MSAA, the framebuffer scale and the prop LOD — all of which
 * are in a picture (DEV-245).
 */

import path from 'node:path'
import { blobStats, decodePng } from '../../tools/perf/png-diff.mjs'
import { flyToFreeze, hold } from './fixtures/freeze'
import { watchPageErrors } from './fixtures/page-errors'
import { viewportPhotographer } from './fixtures/photo'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.GLOW_SHOT_DIR ?? path.join('test-results', 'hover-glow')

interface WingFacts {
  /** `hover-glow:projectors` meshes in the scene: one per ship that got its wing. */
  readonly projectors: number
  /** `hover-glow:glow` meshes: the same count, or a ship is half-dressed. */
  readonly glows: number
  /** The player's hull is drawn in COLOUR — the chase view, not the seat's shadow draw. */
  readonly hullInColour: boolean
  /** Draw calls and linked programs of the last frame: the positive half of "no errors". */
  readonly calls: number
  readonly programs: number
}

const wingFacts = (page: Page): Promise<WingFacts> =>
  page.evaluate(() => {
    interface Node {
      name?: string
      visible?: boolean
      isMesh?: boolean
      material?: { colorWrite?: boolean } | { colorWrite?: boolean }[]
      traverse(fn: (o: Node) => void): void
    }
    const w = globalThis as unknown as {
      __ff2?: {
        render: {
          scene: Node
          renderer: { info: { render: { calls: number }; programs?: unknown[] | null } }
        }
      }
    }
    const render = w.__ff2?.render
    if (!render) throw new Error('hover-glow: no __ff2.render')
    let projectors = 0
    let glows = 0
    let hullInColour = false
    render.scene.traverse((o) => {
      if (o.name === 'hover-glow:projectors') projectors++
      if (o.name === 'hover-glow:glow') glows++
      if (o.name === 'ship_third_person' && o.visible) {
        o.traverse((m) => {
          if (!m.isMesh) return
          const mats = Array.isArray(m.material) ? m.material : [m.material]
          if (mats.some((x) => x?.colorWrite === true)) hullInColour = true
        })
      }
    })
    return {
      projectors,
      glows,
      hullInColour,
      calls: render.renderer.info.render.calls,
      programs: render.renderer.info.programs?.length ?? 0,
    }
  })

/** Show or hide every wing in the scene. */
const setWings = (page: Page, on: boolean): Promise<void> =>
  page.evaluate((visible) => {
    const w = globalThis as unknown as {
      __ff2?: { render: { scene: { traverse(fn: (o: unknown) => void): void } } }
    }
    w.__ff2?.render.scene.traverse((node) => {
      const o = node as { name?: string; visible?: boolean }
      if (o.name === 'hover-glow') o.visible = visible
    })
  }, on)

const shoot = viewportPhotographer(OUT, 'adaptive0-qualityhigh')

interface Frame {
  readonly w: number
  readonly h: number
  readonly ch: number
  readonly data: Uint8Array
}

/**
 * Per-pixel mask of "this moved by more than 24 levels on some channel".
 *
 * 24 is `png-diff.mjs`'s own bar for a channel having moved, so the
 * measurement is in the units the rest of the repo argues in.
 */
const movedMask = (x: Frame, y: Frame): Uint8Array => {
  if (x.w !== y.w || x.h !== y.h) throw new Error('hover-glow: frame sizes differ')
  const keep = new Uint8Array(x.w * x.h)
  const rgb = Math.min(3, x.ch, y.ch)
  for (let p = 0; p < x.w * x.h; p++) {
    let d = 0
    for (let k = 0; k < rgb; k++) {
      const av = x.data[p * x.ch + k] as number
      const bv = y.data[p * y.ch + k] as number
      d = Math.max(d, Math.abs(av - bv))
    }
    keep[p] = d > 24 ? 1 : 0
  }
  return keep
}

const statsOf = (
  keep: Uint8Array,
  w: number,
  h: number,
): { moved: number; largest: number; share: number } => {
  const s = blobStats(keep, w, h)
  if (!s) throw new Error('hover-glow: blobStats refused the mask')
  return { moved: s.moved, largest: s.largest, share: s.moved / (w * h) }
}

test.describe('@gpu the anti-grav wing, from the chase camera', () => {
  test.setTimeout(600_000)

  test('is 2016’s part, on every ship, and it reads at flight framing', async ({ page }) => {
    const errors = watchPageErrors(page)
    // A wing that failed to load is WARNED, not thrown (`game/ship-wings.ts`),
    // so one ship flying without it while the others have theirs would pass
    // every pixel gate below. Count the warning.
    const wingWarnings: string[] = []
    page.on('console', (msg) => {
      if (msg.text().includes('[ship-wings]')) wingWarnings.push(msg.text())
    })
    // Pointer lock is REFUSED on an unfocused document, and parallel headed
    // workers guarantee an unfocused one. This is the harness doing what a
    // player does — bringing the window forward before clicking in it.
    await page.bringToFront()
    await flyToFreeze(page, {
      mission: 'int_01_hoverJet',
      edition: 'anniversary',
      // 20 s, as every freeze spec here: clear of the launch elevator (trap 23).
      snapAt: 20,
      params: Object.fromEntries(new URLSearchParams(PINNED)),
    })
    const pinAtStart = await drawState(page)

    // CHANGE VIEW. The wing lives on the exterior hull, which the seat draws
    // colourless at most, so this is the whole audience.
    await hold(page, 'KeyV')
    await expect
      .poll(async () => (await wingFacts(page)).hullInColour, { timeout: 15_000 })
      .toBe(true)
    // Let the chase arm settle onto the frozen ship.
    await page.waitForTimeout(3_000)

    const facts = await wingFacts(page)
    console.info(
      `hover-glow: ${facts.projectors} wings live · ${facts.calls} calls · ${facts.programs} programs · ${drawStateLine(pinAtStart)}`,
    )
    // The positive half first: a frame that drew nothing reports no errors too.
    expect(facts.calls, 'the frame drew').toBeGreaterThan(0)
    expect(facts.programs, 'programs linked').toBeGreaterThan(0)
    // The player's own, plus one per AI racer and ghost — each with BOTH parts.
    expect(facts.projectors, 'the player at least, and the racers ahead').toBeGreaterThanOrEqual(2)
    expect(facts.glows, 'every wing has its glow').toBe(facts.projectors)
    expect(wingWarnings, 'the wing GLB loaded for every ship').toEqual([])

    // ── the A/B, at one frozen tick, WITH A CONTROL ────────────────────
    await setWings(page, false)
    await page.waitForTimeout(400)
    const off = decodePng(await shoot(page, 'ab-off')) as Frame
    await setWings(page, true)
    await page.waitForTimeout(400)
    const on = decodePng(await shoot(page, 'ab-on')) as Frame
    await page.waitForTimeout(400)
    const again = decodePng(await shoot(page, 'ab-on-control')) as Frame

    const signalMask = movedMask(off, on)
    const controlMask = movedMask(on, again)
    const wingMask = new Uint8Array(signalMask.length)
    for (let p = 0; p < signalMask.length; p++) {
      wingMask[p] = signalMask[p] && !controlMask[p] ? 1 : 0
    }
    const raw = statsOf(signalMask, off.w, off.h)
    const control = statsOf(controlMask, off.w, off.h)
    const wing = statsOf(wingMask, off.w, off.h)
    console.info(
      `hover-glow A/B at ${off.w}x${off.h}:\n` +
        `  off->on   ${raw.moved} px (${(raw.share * 100).toFixed(3)} %), largest patch ${raw.largest}\n` +
        `  control   ${control.moved} px (${(control.share * 100).toFixed(3)} %), largest patch ${control.largest}  <- waves, particles\n` +
        `  THE WING  ${wing.moved} px (${(wing.share * 100).toFixed(3)} %), largest patch ${wing.largest}`,
    )

    // The bar is DEV-044's: four pixels across is not a review, it is a render.
    // 800 px of connected change is a 28x28 patch at 1280x720.
    expect(wing.largest, 'one connected patch of wing, not scattered noise').toBeGreaterThan(800)
    expect(wing.moved, 'and the rest of it').toBeGreaterThan(2_000)
    // Not one piece doing all the work: two wings and an engine on one hull,
    // and the racers' beyond it, are several patches.
    expect(wing.largest, 'more than one patch').toBeLessThan(wing.moved)
    // The control is SUBTRACTED, then printed — DEV-310 found comparing its
    // size to the part's compared a wave to a wing. What is gated is that
    // subtracting it left something.
    expect(
      wing.moved / Math.max(1, raw.moved),
      'the wing survives its own control',
    ).toBeGreaterThan(0.2)

    // The pin has to have HELD, or the frames above are of a different build.
    const pinAtEnd = await drawState(page)
    const drift = drawStateDiff(pinAtStart, pinAtEnd)
    expect(drift, `the tier moved mid-run: ${drift.join(', ')}`).toEqual([])
    expect(errors.list(), 'console errors, page errors or failed requests').toEqual([])
  })
})
