/**
 * tests/e2e/xr-vr-values.spec.ts: the headset's VR-only values reach what is
 * DRAWN. DEV-934 (lever 5 of docs/plan/ANNIVERSARY-VR-FRAMERATE.md, narrower
 * speed lines) and DEV-935 (lever 8, nearer `props.meshLod` rung edges).
 *
 * The unit tests (`edition-vr-values.test.ts`, `prop-mesh-lod-vr.test.ts`)
 * prove the preset layer and the pass in isolation. This proves the two
 * wirings nothing else covers, on the game's own XR path (IWER, no `src/`
 * switch): the boost fields' width uniform moves when the session starts
 * (`boot/app.ts` re-reads the streaks on every edition notify), and a forest
 * built at the monitor takes the headset's nearer edges on its next scan
 * (`world/build.ts` hands the pass a LIVE table).
 *
 * The forest is read at one pose, PAUSED, twice: with the shipped VR table,
 * then with the flat table put back through the development handle's
 * `setPreset` (the door the specs and perf tools use to move one key). So the
 * comparison is one camera, one world and two tables, and the only thing that
 * differs is the edge list. The relationship asserted is the coverage one: the
 * VR table draws the same props, on coarser meshes on the whole.
 *
 * No timing is read (the 2026-10-12 wave shares one GPU).
 */
import { emulatedXrInstalled, installEmulatedXr } from './fixtures/emulated-xr'
import { enterVr, loadSettled } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

test.use({ viewport: { width: 1600, height: 720 }, deviceScaleFactor: 1 })

interface Scene {
  traverse(f: (o: Obj) => void): void
}
interface Obj {
  name: string
  count?: number
  isInstancedMesh?: boolean
  parent?: Obj | null
  material?: { uniforms?: { uWidthScale?: { value: number } } }
}

/** The widest streak the boost fields carry: the S2 width, the only field above 1. */
const streakWidth = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const stage = (globalThis as unknown as { __ff2: { stage: () => Scene } }).__ff2.stage()
    let widest = 0
    stage.traverse((o) => {
      const w = o.material?.uniforms?.uWidthScale?.value
      if (o.name.startsWith('particles:') && typeof w === 'number') widest = Math.max(widest, w)
    })
    return widest
  })

/** How many scatter props each rung mesh draws: [full, lod1, lod2]. */
const rungCounts = (page: Page): Promise<number[]> =>
  page.evaluate(() => {
    const stage = (globalThis as unknown as { __ff2: { stage: () => Scene } }).__ff2.stage()
    const out = [0, 0, 0]
    stage.traverse((o) => {
      if (!o.isInstancedMesh || !o.parent?.name.startsWith('props:scatter:')) return
      const m = /:lod(\d)$/.exec(o.name)
      const rung = m ? Number(m[1]) : 0
      out[rung] = (out[rung] ?? 0) + (o.count ?? 0)
    })
    return out
  })

/** Wait until two readings a second apart agree: the staggered swap has finished. */
const settledCounts = async (page: Page): Promise<number[]> => {
  let last = await rungCounts(page)
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000)
    const now = await rungCounts(page)
    if (now.join() === last.join()) return now
    last = now
  }
  throw new Error(`the forest never settled: ${last.join()}`)
}

const presenting = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2?: { render: { renderer: { xr: { isPresenting: boolean } } } }
        }
      ).__ff2?.render.renderer.xr.isPresenting ?? false,
  )

test.describe('@gpu DEV-934/935: the VR values reach the frame', () => {
  test.setTimeout(480_000)

  test('narrower streaks, and the forest on coarser meshes nearer the seat', async ({ page }) => {
    await installEmulatedXr(page, { ipd: 0.063, fovyDeg: 90 })
    // rookie_01 is alpine: a forest with both rungs built. `?edition=` wins
    // over the headset's AUTO look (Classic, DEV-896), as a player's pick does.
    await page.goto(`/?autopilot=1&mission=rookie_01_hoverJet&edition=anniversary&${PINNED}`)
    await loadSettled(page, 240_000)
    expect(await emulatedXrInstalled(page), 'the emulated runtime took').toBe(true)

    const flatWidth = await streakWidth(page)
    expect(flatWidth, 'the premise: Anniversary streaks are wider than 2016 flat').toBeGreaterThan(
      1,
    )

    await enterVr(page)
    await expect.poll(() => presenting(page), { timeout: 60_000 }).toBe(true)

    // DEV-934: the boost fields re-read the width on the session's notify.
    await expect
      .poll(() => streakWidth(page), { timeout: 10_000, message: 'the streaks narrow in VR' })
      .toBeLessThan(flatWidth)
    expect(await streakWidth(page), 'and are still wider than the hairline').toBeGreaterThan(1)

    // DEV-935: fly a little, then hold one pose.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { __ff2?: { mission: { elapsed: number } } }).__ff2?.mission
                .elapsed ?? 0,
          ),
        { timeout: 120_000, intervals: [500] },
      )
      .toBeGreaterThan(5)
    await page.evaluate(() => {
      const c = (
        globalThis as unknown as {
          __emulatedXR: {
            device: {
              controllers: Record<string, { updateButtonValue: (id: string, v: number) => void }>
            }
          }
        }
      ).__emulatedXR.device.controllers.left
      c?.updateButtonValue('x-button', 1)
    })
    await page.waitForTimeout(150)
    await page.evaluate(() => {
      const c = (
        globalThis as unknown as {
          __emulatedXR: {
            device: {
              controllers: Record<string, { updateButtonValue: (id: string, v: number) => void }>
            }
          }
        }
      ).__emulatedXR.device.controllers.left
      c?.updateButtonValue('x-button', 0)
    })
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                globalThis as unknown as { __ff2?: { pausePlate: () => { open: boolean } | null } }
              ).__ff2?.pausePlate()?.open ?? false,
          ),
        { timeout: 5_000, message: 'paused, so the pose holds' },
      )
      .toBe(true)

    const vr = await settledCounts(page)

    // The flat table back, everything else as shipped.
    const swapped = await page.evaluate(() => {
      const ed = (
        globalThis as unknown as {
          __ff2: {
            edition: {
              current: Record<string, unknown>
              rules: { props: { meshLod: { rungs: unknown[] } } }
              setPreset: (e: unknown) => void
            }
          }
        }
      ).__ff2.edition
      const next = structuredClone(ed.current) as {
        props: { meshLod: { rungs: unknown[] } }
        vr?: { override?: Record<string, unknown> }
      }
      if (!next.vr?.override?.['props.meshLod']) return false
      delete next.vr.override['props.meshLod']
      next.props.meshLod.rungs = structuredClone(ed.rules.props.meshLod.rungs)
      ed.setPreset(next)
      return true
    })
    expect(swapped, 'the shipped preset has a VR mesh-LOD table').toBe(true)
    const flat = await settledCounts(page)

    console.info(
      `rung split [full, lod1, lod2]: VR ${vr.join(', ')} · flat table ${flat.join(', ')}`,
    )
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
    // The forest is there, and the same props are drawn either way.
    expect(sum(vr), 'a forest is drawn').toBeGreaterThan(0)
    expect(sum(vr), 'no prop lost or doubled by the swap').toBe(sum(flat))
    // Coarser on the whole in the headset: the mean rung index rises.
    const weight = (a: number[]) => (a[1] ?? 0) + 2 * (a[2] ?? 0)
    expect(weight(vr), 'the VR table draws more of the forest on coarser meshes').toBeGreaterThan(
      weight(flat),
    )
    expect(vr[0] ?? 0, 'and fewer on the full mesh').toBeLessThanOrEqual(flat[0] ?? 0)
  })
})
