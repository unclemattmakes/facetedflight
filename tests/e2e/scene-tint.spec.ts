/**
 * tests/e2e/scene-tint.spec.ts — the scene tint, on a real frame, on both of
 * the frame's render paths. DEV-446.
 *
 * `tests/unit/scene-tint.test.ts` has the arithmetic and the structure. What
 * only a GPU can say, and this says:
 *
 *  1. **As shipped, nothing is drawn.** The preset's value is identity, so the
 *     quad is out of the draw list and the frame is the build's.
 *  2. **The premise the ordering rests on, read off the live scene.** Every
 *     UI surface (`toneMapped: false`) in the mission scene sorts AFTER the
 *     filter, and is transparent (an opaque one would draw before it in a
 *     single pass). The world transparents that sort after it are printed —
 *     the header of `render/scene-tint.ts` names them, and this is where that
 *     sentence is checked.
 *  3. **Its program links** — `LINK_STATUS` asked of GL for the filter's own
 *     program — and no `Shader Error` reaches the console, with draw calls and
 *     programs both above zero first so a frame that drew nothing cannot pass.
 *  4. **The pixels do what the maths says**: in the world band at the top of
 *     the frame, the tinted shot is the untinted one times the gain, to within
 *     the noise a second untinted shot of the same frozen frame shows — and in
 *     the middle of the cockpit HUD's panel, projected off the live mesh, the
 *     frame does NOT move by the gain.
 *  5. **The pin held** across the shots (`fixtures/quality-pin.ts`).
 *
 * Two arms, because the filter reaches the frame two ways (the header of
 * `render/scene-tint.ts`): Anniversary on a monitor goes through the bloom
 * composite and draws it in the UI pass; Classic — with the feature pinned on
 * by `?feature=`, the same switch the Advanced page uses — takes the single
 * pass a headset takes. The tint itself is authored through
 * `__ff2.sceneTint.setOverride`, which is the door `?lookdev=1`'s picker
 * uses: the harness does what the panel does and nothing else.
 *
 * A third test brackets the GPU cost, OFF / ON / OFF / ON / OFF on the frozen
 * frame, on each path. It prints; it does not gate — a monitor is not the
 * budget (ART_DIRECTION: say which machine a perf number is from).
 *
 *   TINT_DIR=<dir> E2E_PORT=<yours> pnpm exec playwright test tests/e2e/scene-tint.spec.ts
 *
 * Tagged `@gpu` with the rest of the flying specs.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { SceneTintValue } from '@/content/edition-schema'
import { sceneTintGain } from '@/render/scene-tint'
import { decodePng } from '../../tools/perf/png-diff.mjs'
import { flyToFreeze } from './fixtures/freeze'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import { SHADER_ERROR_PREFIX, sweepPrograms, watchShaderConsole } from './fixtures/shader-link'
import { expect, type Page, test } from './fixtures/test'

const MISSION = process.env.TINT_MISSION ?? 'int_01_hoverJet'
/** Mission seconds. `anniversary-ab.spec.ts`'s default frame. */
const AT = Number(process.env.TINT_AT ?? '20')
const OUT = process.env.TINT_DIR ?? 'test-results/scene-tint'

/**
 * A sunset lean, and strong enough to read in a thumbnail: gain ≈ (1.14, 0.98,
 * 0.81). Not a proposal for any mission — Matt authors those.
 */
const WARM: SceneTintValue = { color: [1, 0.78, 0.55], strength: 0.6 }

/** Levels a pixel may differ by and still count as "the same". */
const LEVELS = 3

type Decoded = ReturnType<typeof decodePng>

const params = (edition: string): Record<string, string> => ({
  ...Object.fromEntries(new URLSearchParams(PINNED)),
  // Classic ships the feature OFF, as 2016 had none; the pin turns it on so
  // this arm photographs the single-pass path a headset takes.
  ...(edition === 'classic' ? { feature: 'render.sceneTint:on' } : {}),
  // The authoring panel, which is DOM and hidden until L — so no shot sees it.
  // Anniversary only: on Classic the group is absent by design.
  ...(edition === 'anniversary' ? { lookdev: '1' } : {}),
})

interface TintReport {
  gain: [number, number, number]
  drawn: boolean
  override: SceneTintValue | null
}

const report = (page: Page): Promise<TintReport> =>
  page.evaluate(() => {
    const w = globalThis as unknown as { __ff2: { sceneTint: { report: TintReport } } }
    return w.__ff2.sceneTint.report
  })

const setTint = async (page: Page, value: SceneTintValue | null): Promise<void> => {
  await page.evaluate((v) => {
    const w = globalThis as unknown as {
      __ff2: { sceneTint: { setOverride: (x: SceneTintValue | null) => void } }
    }
    w.__ff2.sceneTint.setOverride(v)
  }, value)
  // Two frames at least; half a second is many.
  await page.waitForTimeout(500)
}

interface OrderSweep {
  readonly tint: { groupOrder: number; renderOrder: number } | null
  /** UI surfaces that would draw BEFORE the filter in a single pass. */
  readonly uiBefore: string[]
  /** UI surfaces that are opaque, which a single pass draws before every transparent. */
  readonly uiOpaque: string[]
  readonly uiAfter: number
  /** World transparents that draw AFTER the filter in a single pass. */
  readonly worldAfter: string[]
}

/**
 * three's transparent sort, read off the live scene: `groupOrder` (the nearest
 * `Group` ancestor's `renderOrder`) first, then `renderOrder`. Every object,
 * hidden or not — a plate that is hidden now is on screen later.
 */
const sweepOrder = (page: Page): Promise<OrderSweep> =>
  page.evaluate(() => {
    interface Mat {
      toneMapped?: boolean
      transparent?: boolean
      name?: string
      type?: string
    }
    interface Node {
      name: string
      type: string
      isGroup?: boolean
      isMesh?: boolean
      isPoints?: boolean
      isSprite?: boolean
      isLine?: boolean
      renderOrder: number
      parent: Node | null
      material?: Mat | Mat[]
      traverse: (fn: (o: Node) => void) => void
    }
    const w = globalThis as unknown as { __ff2: { render: { scene: Node } } }
    const groupOrderOf = (o: Node): number => {
      for (let p: Node | null = o.parent; p; p = p.parent) if (p.isGroup) return p.renderOrder
      return 0
    }
    const label = (o: Node): string => {
      const chain: string[] = []
      for (let p: Node | null = o; p && chain.length < 3; p = p.parent) {
        chain.push(p.name || p.type)
      }
      return `${chain.join(' < ')} @${groupOrderOf(o)}/${o.renderOrder}`
    }
    const out = {
      tint: null as { groupOrder: number; renderOrder: number } | null,
      uiBefore: [] as string[],
      uiOpaque: [] as string[],
      uiAfter: 0,
      worldAfter: [] as string[],
    }
    const rows: { o: Node; mats: Mat[] }[] = []
    w.__ff2.render.scene.traverse((o) => {
      if (!(o.isMesh || o.isPoints || o.isSprite || o.isLine) || !o.material) return
      rows.push({ o, mats: Array.isArray(o.material) ? o.material : [o.material] })
      if (o.name === 'scene-tint') {
        out.tint = { groupOrder: groupOrderOf(o), renderOrder: o.renderOrder }
      }
    })
    const t = out.tint
    if (!t) return out
    const after = (o: Node): boolean => {
      const g = groupOrderOf(o)
      return g !== t.groupOrder ? g > t.groupOrder : o.renderOrder > t.renderOrder
    }
    for (const { o, mats } of rows) {
      if (o.name === 'scene-tint') continue
      const ui = mats.some((m) => m.toneMapped === false)
      if (ui) {
        if (!mats.every((m) => m.transparent)) out.uiOpaque.push(label(o))
        if (after(o)) out.uiAfter += 1
        else out.uiBefore.push(label(o))
      } else if (mats.some((m) => m.transparent) && after(o)) {
        out.worldAfter.push(label(o))
      }
    }
    return out
  })

interface LinkRead {
  readonly programs: number
  readonly linked: number
}

/** The filter's OWN program(s), asked of GL. */
const tintLink = (page: Page): Promise<LinkRead> =>
  page.evaluate(() => {
    interface Gl {
      LINK_STATUS: number
      getProgramParameter: (p: unknown, pname: number) => unknown
    }
    interface Node {
      name: string
      material?: unknown
      traverse: (fn: (o: Node) => void) => void
    }
    const w = globalThis as unknown as {
      __ff2: {
        render: {
          scene: Node
          renderer: {
            getContext: () => Gl
            properties: { get: (m: unknown) => { programs?: Map<string, { program: unknown }> } }
          }
        }
      }
    }
    const { scene, renderer } = w.__ff2.render
    const gl = renderer.getContext()
    let tint: Node | null = null
    scene.traverse((o) => {
      if (o.name === 'scene-tint') tint = o
    })
    const found = tint as Node | null
    const held = found ? renderer.properties.get(found.material).programs : undefined
    let programs = 0
    let linked = 0
    for (const p of held?.values() ?? []) {
      programs += 1
      if (gl.getProgramParameter(p.program, gl.LINK_STATUS) === true) linked += 1
    }
    return { programs, linked }
  })

/** Share of samples in rows [y0, y1) of the frame where `pick(a, b, channel)` holds. */
const shareInBand = (
  a: Decoded,
  b: Decoded,
  y0: number,
  y1: number,
  pick: (x: number, y: number, c: number) => boolean,
  cols: readonly [number, number] = [0, a.w],
): number => {
  let ok = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = cols[0]; x < cols[1]; x++) {
      const i = (y * a.w + x) * a.ch
      for (let c = 0; c < 3; c++) {
        n += 1
        if (pick(a.data[i + c] as number, b.data[i + c] as number, c)) ok += 1
      }
    }
  }
  return n ? ok / n : 0
}

const meanChannel = (
  img: Decoded,
  y0: number,
  y1: number,
  c: number,
  x0 = 0,
  x1 = img.w,
): number => {
  let s = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      s += img.data[(y * img.w + x) * img.ch + c] as number
      n += 1
    }
  }
  return s / n
}

/**
 * The HUD's INK: the pixels of `rect` that are near-white in the untinted shot
 * (its digits and labels, drawn opaque), as the ratio of the tinted shot's sum
 * to the untinted one's per channel, with how many pixels that was.
 *
 * Why ink and not the box's mean: the panel is translucent, so the box's mean
 * is part HUD and part the tinted world behind it, and the share of each moves
 * whenever the HUD is redrawn (DEV-791 took Classic's bars off, DEV-647/649 the
 * Anniversary panels onto tokens). Opaque ink carries no world, so a filtered
 * HUD would put the gain on it (a ratio at the gain) and an unfiltered one
 * leaves it at 1.
 */
const INK_FLOOR = 190
const inkRatio = (
  a: Decoded,
  b: Decoded,
  rect: Rect,
): { readonly pixels: number; readonly ratio: readonly number[] } => {
  const sa = [0, 0, 0]
  const sb = [0, 0, 0]
  let pixels = 0
  for (let y = Math.max(0, Math.floor(rect.y0)); y < Math.min(a.h, Math.ceil(rect.y1)); y++) {
    for (let x = Math.max(0, Math.floor(rect.x0)); x < Math.min(a.w, Math.ceil(rect.x1)); x++) {
      const i = (y * a.w + x) * a.ch
      if (
        (a.data[i] as number) < INK_FLOOR ||
        (a.data[i + 1] as number) < INK_FLOOR ||
        (a.data[i + 2] as number) < INK_FLOOR
      ) {
        continue
      }
      pixels += 1
      for (let c = 0; c < 3; c++) {
        sa[c] = (sa[c] as number) + (a.data[i + c] as number)
        sb[c] = (sb[c] as number) + (b.data[i + c] as number)
      }
    }
  }
  return { pixels, ratio: sa.map((v, c) => (v > 0 ? (sb[c] as number) / v : Number.NaN)) }
}

interface Rect {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/**
 * The cockpit HUD's panel on screen, in canvas pixels, shrunk to its middle
 * half so a projection a pixel out cannot put the world in the box. Read off
 * the live mesh and camera, so the box follows the panel rather than a number
 * typed here.
 */
const hudRect = (page: Page): Promise<Rect | null> =>
  page.evaluate(() => {
    interface V3 {
      x: number
      y: number
      fromBufferAttribute: (a: unknown, i: number) => V3
      applyMatrix4: (m: unknown) => V3
      project: (c: unknown) => V3
    }
    interface Node {
      name: string
      position: { constructor: new () => V3 }
      matrixWorld: unknown
      geometry?: { getAttribute: (n: string) => { count: number } }
      traverse: (fn: (o: Node) => void) => void
    }
    const w = globalThis as unknown as {
      __ff2: { render: { scene: Node; camera: unknown } }
    }
    let hud: Node | null = null
    w.__ff2.render.scene.traverse((o) => {
      if (o.name === 'hud' && o.geometry) hud = o
    })
    const found = hud as Node | null
    const pos = found?.geometry?.getAttribute('position')
    if (!found || !pos) return null
    const canvas = document.querySelector('#viewport') as HTMLCanvasElement
    const Vec = found.position.constructor
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < pos.count; i++) {
      const p = new Vec()
        .fromBufferAttribute(pos, i)
        .applyMatrix4(found.matrixWorld)
        .project(w.__ff2.render.camera)
      xs.push(((p.x + 1) / 2) * canvas.clientWidth)
      ys.push(((1 - p.y) / 2) * canvas.clientHeight)
    }
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const qx = (x1 - x0) / 4
    const qy = (y1 - y0) / 4
    return {
      x0: Math.round(x0 + qx),
      x1: Math.round(x1 - qx),
      y0: Math.round(y0 + qy),
      y1: Math.round(y1 - qy),
    }
  })

const save = (name: string, png: Buffer): string => {
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, name)
  fs.writeFileSync(file, png)
  return file
}

test.describe('@gpu the scene tint (DEV-446)', () => {
  test.setTimeout(420_000)

  for (const edition of ['anniversary', 'classic'] as const) {
    test(`${MISSION} at ${AT} s — ${edition}`, async ({ page }) => {
      const shaderConsole = watchShaderConsole(page)
      await flyToFreeze(page, { mission: MISSION, edition, snapAt: AT, params: params(edition) })
      const pin = await drawState(page)
      console.info(`[scene-tint] ${edition}: ${drawStateLine(pin)}`)

      // 1. As shipped: identity, not drawn.
      const shipped = await report(page)
      expect(shipped.drawn, 'the shipped preset tints nothing').toBe(false)
      expect(shipped.gain).toEqual([1, 1, 1])

      // 2. The ordering premise, off the live scene.
      const order = await sweepOrder(page)
      expect(order.tint, 'the filter is in the mission scene').not.toBeNull()
      console.info(
        `[scene-tint] ${edition}: order ${JSON.stringify(order.tint)} · ${order.uiAfter} UI surfaces after it · world transparents after it: ${order.worldAfter.join(', ') || 'none'}`,
      )
      expect(order.uiBefore, 'every UI surface sorts after the filter').toEqual([])
      expect(order.uiOpaque, 'every UI surface is transparent').toEqual([])

      const suffix = `${PINNED.replace(/[=&]/g, '-')}`
      const shotA = await page.locator('#viewport').screenshot()
      await page.waitForTimeout(300)
      const shotA2 = await page.locator('#viewport').screenshot()
      save(`${MISSION}-${AT}s-${edition}-identity-${suffix}.png`, shotA)

      // 3. Author a tint the way the panel does, and read what is drawn.
      await setTint(page, WARM)
      const warm = await report(page)
      const gain = sceneTintGain(WARM)
      expect(warm.drawn, 'an authored tint is drawn').toBe(true)
      for (let c = 0; c < 3; c++) expect(warm.gain[c]).toBeCloseTo(gain[c] as number, 6)
      const shotB = await page.locator('#viewport').screenshot()
      const tintedPath = save(`${MISSION}-${AT}s-${edition}-warm-${suffix}.png`, shotB)

      const sweep = await sweepPrograms(page)
      expect(sweep.calls, 'the frame drew something').toBeGreaterThan(0)
      expect(sweep.programs, 'there are programs to check').toBeGreaterThan(0)
      const link = await tintLink(page)
      expect(link.programs, 'the filter has a program').toBeGreaterThan(0)
      expect(link.linked, 'and every one of them LINKED').toBe(link.programs)
      expect(sweep.failed.map((f) => f.id)).toEqual([])
      const errors = shaderConsole.lines().filter((l) => l.text.startsWith(SHADER_ERROR_PREFIX))
      expect(errors.map((l) => l.text)).toEqual([])
      console.info(
        `[scene-tint] ${edition}: ${sweep.calls} draw calls · ${sweep.programs} programs · ${sweep.linked} linked · filter ${link.linked}/${link.programs} linked · ${errors.length} shader errors`,
      )

      // 4. The pixels. The top of the frame is world — sky and terrain past
      // the canopy — and a frozen frame still moves a little (waves, drift),
      // so the bar is the SAME frame shot twice untinted, not zero.
      const a = decodePng(shotA)
      const a2 = decodePng(shotA2)
      const b = decodePng(shotB)
      const y0 = Math.round(a.h * 0.03)
      const y1 = Math.round(a.h * 0.3)
      // The middle three fifths of the width: the corner cards (position,
      // gates, time, score; DEV-647/649) sit inside this band's rows at both
      // edges, and they are HUD, which 4b below asserts is NOT filtered. Left
      // in, they are samples that cannot equal A x gain by design, and the
      // share drifts down with however big the cards are drawn.
      const cols: [number, number] = [Math.round(a.w * 0.2), Math.round(a.w * 0.8)]
      const control = shareInBand(a, a2, y0, y1, (p, q) => Math.abs(p - q) <= LEVELS, cols)
      const matches = shareInBand(
        a,
        b,
        y0,
        y1,
        (p, q, c) => Math.abs(Math.min(255, p * (gain[c] as number)) - q) <= LEVELS,
        cols,
      )
      const untouched = shareInBand(a, b, y0, y1, (p, q) => Math.abs(p - q) <= LEVELS, cols)
      const ratio = [0, 1, 2].map(
        (c) =>
          meanChannel(b, y0, y1, c, cols[0], cols[1]) / meanChannel(a, y0, y1, c, cols[0], cols[1]),
      )
      console.info(
        `[scene-tint] ${edition}: world band — B = A x gain on ${(matches * 100).toFixed(1)} % of samples (control A = A2 on ${(control * 100).toFixed(1)} %; B = A on ${(untouched * 100).toFixed(1)} %) · mean ratio ${ratio.map((r) => r.toFixed(3)).join(' / ')} against gain ${gain.map((g) => g.toFixed(3)).join(' / ')} · ${tintedPath}`,
      )
      expect(matches).toBeGreaterThan(control - 0.03)
      expect(matches).toBeGreaterThan(untouched + 0.1)

      // 4b. And the HUD is NOT filtered — the claim the ordering sweep makes,
      // measured, on the HUD's own ink (`inkRatio`): opaque, so it carries no
      // tinted world, and a filtered HUD would put the gain on it where an
      // unfiltered one leaves it at 1. The panel's MEAN is logged but is not
      // the claim: it is translucent over the tinted world, so it moves by
      // however much world its drawing leaves showing.
      const hud = await hudRect(page)
      expect(hud, 'the cockpit HUD is on screen').not.toBeNull()
      if (hud) {
        const hudRatio = [0, 1, 2].map(
          (c) =>
            meanChannel(b, hud.y0, hud.y1, c, hud.x0, hud.x1) /
            meanChannel(a, hud.y0, hud.y1, c, hud.x0, hud.x1),
        )
        const ink = inkRatio(a, b, hud)
        console.info(
          `[scene-tint] ${edition}: HUD box ${JSON.stringify(hud)}, mean ratio ${hudRatio.map((r) => r.toFixed(3)).join(' / ')} · ink ${ink.pixels} px, ratio ${ink.ratio.map((r) => r.toFixed(3)).join(' / ')}`,
        )
        expect(ink.pixels, 'the HUD box holds enough ink to measure').toBeGreaterThan(100)
        // The red-to-blue ratio rather than each channel against 1: the tint
        // is a CHANNEL-DEPENDENT gain, so a filtered HUD would put gain[0] /
        // gain[2] between its red and its blue, and an unfiltered one leaves
        // them level whatever its ink did on the whole (the Anniversary
        // panels' text breathes, about 4 % on all three channels together,
        // which is not the tint).
        const tilt = (ink.ratio[0] as number) / (ink.ratio[2] as number)
        const filtered = (gain[0] as number) / (gain[2] as number)
        expect(Math.abs(tilt - 1), 'HUD ink: red against blue').toBeLessThan(
          Math.abs(filtered - 1) / 3,
        )
      }

      // 5. The pin held across every shot.
      expect(drawStateDiff(pin, await drawState(page))).toEqual([])

      // And handing back leaves the frame the build's again.
      await setTint(page, null)
      expect((await report(page)).drawn).toBe(false)

      // 6. The authoring door itself, AFTER every shot (the panel is DOM over
      // the canvas): ?lookdev=1's picker and slider move the frame, and its
      // Copy JSON names this mission's row.
      if (edition === 'anniversary') {
        const panel = page.locator('.ff2-lookdev')
        await page.keyboard.press('KeyL')
        await expect(panel).toBeVisible()
        await expect(panel.locator('h3', { hasText: `scene tint — ${MISSION}` })).toHaveCount(1)
        // By its label: the fog group has a picker too since DEV-455.
        const picker = panel
          .locator('label')
          .filter({ hasText: 'colour (hue + saturation' })
          .locator('input[type=color]')
        await picker.fill('#ffc78c')
        await picker.dispatchEvent('input')
        const strength = panel
          .locator('label')
          .filter({ hasText: 'strength (0 none' })
          .locator('input[type=range]')
        await strength.fill('0.6')
        await strength.dispatchEvent('input')
        await page.waitForTimeout(500)
        const authored = await report(page)
        expect(authored.drawn, 'the panel drew a tint').toBe(true)
        expect(authored.override?.strength).toBeCloseTo(0.6, 6)
        expect(authored.override?.color[0]).toBeCloseTo(1, 6)
        await expect(
          panel.getByRole('button', {
            name: `Copy JSON → content/editions/anniversary.json render.sceneTint.missions.${MISSION}`,
          }),
        ).toHaveCount(1)
        await page.keyboard.press('KeyL')
        await expect(panel).toBeHidden()
        await setTint(page, null)
      }
    })
  }

  test(`${MISSION} at ${AT} s — what it costs, bracketed`, async ({ page }) => {
    const rows: string[] = []
    for (const edition of ['anniversary', 'classic'] as const) {
      await flyToFreeze(page, { mission: MISSION, edition, snapAt: AT, params: params(edition) })
      await page.evaluate(() => {
        const w = globalThis as unknown as { __ff2: { gpu: { enable: () => void } } }
        w.__ff2.gpu.enable()
      })
      const arm = async (on: boolean): Promise<number> => {
        await setTint(page, on ? WARM : null)
        await page.evaluate(() => {
          const w = globalThis as unknown as { __ff2: { gpu: { reset: () => void } } }
          w.__ff2.gpu.reset()
        })
        await page.waitForTimeout(4_000)
        const s = await page.evaluate(() => {
          const w = globalThis as unknown as {
            __ff2: {
              gpu: { supported: boolean; stats: () => { frames: number; medianMs: number } }
            }
          }
          return { supported: w.__ff2.gpu.supported, ...w.__ff2.gpu.stats() }
        })
        test.skip(!s.supported, 'no EXT_disjoint_timer_query_webgl2 on this GPU')
        expect(s.frames, 'the ring filled').toBeGreaterThan(60)
        return s.medianMs
      }
      const arms = [false, true, false, true, false]
      const ms: number[] = []
      for (const on of arms) ms.push(await arm(on))
      const calls = await page.evaluate(() => {
        const w = globalThis as unknown as {
          __ff2: { render: { renderer: { info: { render: { calls: number } } } } }
        }
        return w.__ff2.render.renderer.info.render.calls
      })
      const pin = await drawState(page)
      rows.push(
        `${edition}: OFF/ON/OFF/ON/OFF GPU p50 ${ms.map((m) => m.toFixed(3)).join(' / ')} ms · ${calls} calls (last arm, off) · ${drawStateLine(pin)}`,
      )
    }
    for (const r of rows) console.info(`[scene-tint cost] ${r}`)
  })
})
