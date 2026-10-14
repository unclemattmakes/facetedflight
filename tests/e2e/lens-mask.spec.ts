/**
 * tests/e2e/lens-mask.spec.ts: the app's lens mask, on the emulated headset.
 * DEV-930, lever 9 of `docs/plan/ANNIVERSARY-VR-FRAMERATE.md`.
 *
 * `render/lens-mask.ts` primes near-plane depth outside a circle in each eye,
 * drawn first, with colour writes off. Three claims, each proved here on the
 * app's own XR path (IWER, `fixtures/emulated-xr.ts`), none by "the mesh
 * exists":
 *
 *  1. **Depth is primed: what is outside is REJECTED.** With the mask on, every
 *     pixel outside the circle keeps one colour (the clear), in a frame whose
 *     same pixels with the mask off hold sky, land and cockpit. The sky dome is
 *     drawn LAST with its depth test on, so it is rejected there too.
 *  2. **Nothing inside changes.** The mask's one effect on a pixel is to leave
 *     it at the clear colour. In two on shots of the frozen frame (`?snap=`),
 *     no pixel inside the circle is at the clear colour where the off shots
 *     show anything else. (A frame difference cannot carry this claim: the
 *     render clock moves two off shots apart by themselves; see the test.)
 *  3. **It is first in each eye.** One frame's submissions, by eye camera: the
 *     first colour draw each eye makes is the mask.
 *
 * And the flat half: before the session it is in no scene and draws nothing.
 *
 * IPD 0, so the two eyes are one camera twice and each half of the canvas is
 * the same picture (`stereo-parity.spec.ts` says why that is IWER's geometry,
 * not ours). `@gpu`, pinned (DEV-245).
 */
import fs from 'node:fs'
import path from 'node:path'
import { decodePng } from '../../tools/perf/png-diff.mjs'
import { emulatedXrInstalled, installEmulatedXr } from './fixtures/emulated-xr'
import { enterVr, loadSettled } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

/** 800 x 720 an eye; the width is EVEN so the halves are equal. */
test.use({ viewport: { width: 1600, height: 720 }, deviceScaleFactor: 1 })

/** Pixels this close to the circle (in NDC) are in neither set: polygon and MSAA. */
const EDGE_MARGIN = 0.02

/** The mission second the sim freezes at, well into the flight. */
const SNAP_AT = 8

interface Decoded {
  readonly w: number
  readonly h: number
  readonly ch: number
  readonly data: Uint8Array
}

interface Report {
  readonly enabled: boolean
  readonly radius: number | null
  readonly attached: boolean
  readonly eyeDraws: number
}

type Ff2 = {
  lensMask: (r?: number | null) => Report
  render: {
    renderer: {
      info: { render: { calls: number } }
      xr: {
        isPresenting: boolean
        getCamera: () => { cameras: { projectionMatrix: { elements: number[] } }[] }
      }
    }
  }
  mission: { elapsed: number }
}

const lens = (page: Page, radius?: number | null): Promise<Report> =>
  page.evaluate(
    // `undefined` does not survive the trip into the page, so a read is a flag.
    ({ read, r }) => (globalThis as unknown as { __ff2: Ff2 }).__ff2.lensMask(read ? undefined : r),
    { read: radius === undefined, r: radius ?? null },
  )

const presenting = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __ff2?: Ff2 }).__ff2?.render.renderer.xr.isPresenting ?? false,
  )

/** Each eye's forward axis in NDC, read off its live projection. */
const centres = (page: Page): Promise<{ x: number; y: number }[]> =>
  page.evaluate(() =>
    (globalThis as unknown as { __ff2: Ff2 }).__ff2.render.renderer.xr
      .getCamera()
      .cameras.map((c) => ({
        x: -(c.projectionMatrix.elements[8] ?? 0),
        y: -(c.projectionMatrix.elements[9] ?? 0),
      })),
  )

const shoot = async (page: Page, name: string): Promise<Decoded> => {
  await page.waitForTimeout(600)
  const shot = await page.locator('#viewport').screenshot()
  const dir = process.env.LENS_MASK_SHOTS_DIR
  if (dir) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `lens-mask-${name}.png`), shot)
  }
  return decodePng(shot) as Decoded
}

/** 0 inside, 1 outside, -1 on the edge band; per pixel, per eye. */
const classify = (img: Decoded, radius: number, eyes: { x: number; y: number }[]): Int8Array => {
  const half = Math.floor(img.w / 2)
  const out = new Int8Array(img.w * img.h)
  for (let y = 0; y < img.h; y++) {
    const ny = 1 - ((y + 0.5) * 2) / img.h
    for (let x = 0; x < img.w; x++) {
      const eye = x < half ? 0 : 1
      const c = eyes[eye] ?? { x: 0, y: 0 }
      const nx = ((x - eye * half + 0.5) * 2) / half - 1
      const d = Math.hypot(nx - c.x, ny - c.y)
      out[y * img.w + x] = d < radius - EDGE_MARGIN ? 0 : d > radius + EDGE_MARGIN ? 1 : -1
    }
  }
  return out
}

/** Spread of luminance over a pixel set, and its largest channel range. */
const regionStats = (img: Decoded, cls: Int8Array, want: number) => {
  let n = 0
  let sum = 0
  let sum2 = 0
  const lo = [255, 255, 255]
  const hi = [0, 0, 0]
  for (let p = 0; p < img.w * img.h; p++) {
    if (cls[p] !== want) continue
    const i = p * img.ch
    for (let k = 0; k < 3; k++) {
      const v = img.data[i + k] as number
      if (v < (lo[k] as number)) lo[k] = v
      if (v > (hi[k] as number)) hi[k] = v
    }
    const l =
      ((img.data[i] as number) + (img.data[i + 1] as number) + (img.data[i + 2] as number)) / 3
    sum += l
    sum2 += l * l
    n++
  }
  const mean = n ? sum / n : 0
  return {
    n,
    spread: n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0,
    range: Math.max(...hi.map((h, k) => h - (lo[k] as number))),
  }
}

/**
 * Two shots over a pixel set: the mean absolute difference per decoded sample
 * (0..255, the measure `chunk-batch.spec.ts` gates on), and the pixels that
 * differ at all.
 */
const diffIn = (a: Decoded, b: Decoded, cls: Int8Array, want: number) => {
  let differing = 0
  let sum = 0
  let samples = 0
  for (let p = 0; p < a.w * a.h; p++) {
    if (cls[p] !== want) continue
    const i = p * a.ch
    let any = false
    for (let k = 0; k < 3; k++) {
      const d = Math.abs((a.data[i + k] as number) - (b.data[i + k] as number))
      sum += d
      samples++
      if (d > 0) any = true
    }
    if (any) differing++
  }
  return { differing, mean: samples ? sum / samples : 0 }
}

/**
 * Inside the circle, the pixels an ON shot leaves at exactly the clear colour
 * where NEITHER off shot shows that colour: a pixel the mask covered. Claim 2's
 * header says why this is the test and a frame difference is not.
 */
const coveredInside = (
  on: Decoded,
  off1: Decoded,
  off2: Decoded,
  cls: Int8Array,
  clear: number[],
) => {
  const isClear = (img: Decoded, i: number) =>
    img.data[i] === clear[0] && img.data[i + 1] === clear[1] && img.data[i + 2] === clear[2]
  let covered = 0
  let clearAnyway = 0
  const at: string[] = []
  for (let p = 0; p < on.w * on.h; p++) {
    if (cls[p] !== 0) continue
    const i = p * on.ch
    if (!isClear(on, i)) continue
    if (isClear(off1, i) || isClear(off2, i)) {
      clearAnyway++
      continue
    }
    covered++
    if (at.length < 8) at.push(`${p % on.w},${Math.floor(p / on.w)}`)
  }
  return { covered, clearAnyway, examples: at.join(' ') }
}

/** The colour of the first pixel of a set, as [r, g, b]. */
const firstColour = (img: Decoded, cls: Int8Array, want: number): number[] => {
  for (let p = 0; p < img.w * img.h; p++) {
    if (cls[p] !== want) continue
    const i = p * img.ch
    return [img.data[i] as number, img.data[i + 1] as number, img.data[i + 2] as number]
  }
  return []
}

/** One XR frame's colour submissions, each with the eye camera that made it (-1 for none). */
const submissionsByEye = (page: Page): Promise<{ name: string; eye: number }[]> =>
  page.evaluate(async () => {
    const r = (globalThis as unknown as { __ff2: Ff2 }).__ff2.render.renderer as unknown as {
      renderBufferDirect: (camera: unknown, ...rest: unknown[]) => void
      xr: { getCamera: () => { cameras: unknown[] } }
    }
    const prior = r.renderBufferDirect
    const rows: { name: string; eye: number }[] = []
    r.renderBufferDirect = function patched(camera, scene, geometry, material, object, group) {
      const m = material as { isMeshDepthMaterial?: boolean; isMeshDistanceMaterial?: boolean }
      if (!m.isMeshDepthMaterial && !m.isMeshDistanceMaterial) {
        rows.push({
          name: (object as { name?: string }).name ?? '',
          eye: r.xr.getCamera().cameras.indexOf(camera),
        })
      }
      return prior.call(this, camera, scene, geometry, material, object, group)
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
    r.renderBufferDirect = prior
    return rows
  })

test.describe('@gpu the app lens mask on the emulated headset (DEV-930)', () => {
  test.setTimeout(480_000)

  test('rejects what is outside, changes nothing inside, and draws first in each eye', async ({
    page,
  }) => {
    await installEmulatedXr(page, { ipd: 0, fovyDeg: 90 })
    await page.goto(`/?autopilot=1&mission=rookie_01_hoverJet&snap=${SNAP_AT}&${PINNED}`)
    await loadSettled(page, 240_000)
    expect(await emulatedXrInstalled(page), 'the emulated runtime took').toBe(true)

    // The flat half: on by default, and in no scene before a session.
    const flat = await lens(page)
    expect(flat.radius, 'on by default').not.toBeNull()
    expect(flat.attached, 'in no scene on a monitor').toBe(false)
    expect(flat.eyeDraws, 'never drawn on a monitor').toBe(0)
    const radius = flat.radius as number

    await enterVr(page)
    await expect.poll(() => presenting(page), { timeout: 60_000 }).toBe(true)
    // A on the right hand is launch (`input/xr.ts`); the autopilot flies it.
    await page.evaluate(() => {
      const c = (
        globalThis as unknown as {
          __emulatedXR: {
            device: {
              controllers: Record<string, { updateButtonValue: (id: string, v: number) => void }>
            }
          }
        }
      ).__emulatedXR.device.controllers.right
      c?.updateButtonValue('a-button', 1)
      setTimeout(() => c?.updateButtonValue('a-button', 0), 150)
    })
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (globalThis as unknown as { __ff2?: Ff2 }).__ff2?.mission.elapsed ?? 0,
          ),
        { timeout: 120_000, intervals: [500] },
      )
      .toBeGreaterThanOrEqual(SNAP_AT)
    await page.waitForTimeout(2_000)

    const live = await lens(page)
    expect(live.attached, 'attached in the session').toBe(true)
    expect(live.enabled).toBe(true)
    expect(live.eyeDraws, 'drawn by the eyes').toBeGreaterThan(0)

    // ── 3. first in each eye ──────────────────────────────────────────────
    const rows = await submissionsByEye(page)
    for (const eye of [0, 1]) {
      const mine = rows.filter((r) => r.eye === eye)
      expect(mine.length, `eye ${eye} drew`).toBeGreaterThan(10)
      expect(mine[0]?.name, `eye ${eye}: the first colour draw is the mask`).toBe('lens-mask')
    }
    expect(
      rows.filter((r) => r.name === 'lens-mask' && r.eye < 0),
      'no non-eye pass submits it',
    ).toEqual([])

    // ── 1 and 2: the frozen frame, on, off, on, off ──────────────────────
    //
    // `?snap=` freezes the SIM, not the render clock, so the speed lines, the
    // motes and the clouds still move between shots (`census-baseline.spec.ts`
    // names them), and two OFF shots differ by themselves: measured 2026-10-12,
    // 2,466 to 12,677 inside pixels "still" within a pair yet moved between two
    // off pairs, a third of them by one level along the canopy's edges, with no
    // mask in either. A frame difference cannot prove "no pixel inside changed"
    // on this frame. What can: the mask's only effect on a pixel is to leave it
    // at the CLEAR colour (its colour writes are off, and everything after it
    // that tests depth is rejected there). So claim 2 is that no inside pixel is
    // left at the clear colour where an off shot shows something else.
    const eyes = await centres(page)
    expect(eyes, 'two eyes').toHaveLength(2)
    const on1 = await shoot(page, 'on-1')
    await lens(page, 0)
    const off1 = await shoot(page, 'off-1')
    await lens(page, radius)
    const on2 = await shoot(page, 'on-2')
    await lens(page, 0)
    const off2 = await shoot(page, 'off-2')
    await lens(page, radius)
    const calls = await page.evaluate(
      () => (globalThis as unknown as { __ff2: Ff2 }).__ff2.render.renderer.info.render.calls,
    )
    expect(calls, 'the frame drew').toBeGreaterThan(0)

    const cls = classify(on1, radius, eyes)
    const outsideOff = regionStats(off1, cls, 1)
    const outsideOn = regionStats(on1, cls, 1)
    const outsideOn2 = regionStats(on2, cls, 1)
    const insideOn = regionStats(on1, cls, 0)
    const outsideChanged = diffIn(off1, on1, cls, 1)
    const clear = firstColour(on1, cls, 1)
    const covered = [
      coveredInside(on1, off1, off2, cls, clear),
      coveredInside(on2, off1, off2, cls, clear),
    ]
    console.info(
      `lens-mask r=${radius} centres ${JSON.stringify(eyes)} · outside ${outsideOn.n} px: ` +
        `off spread ${outsideOff.spread.toFixed(1)} range ${outsideOff.range} · ` +
        `on spread ${outsideOn.spread.toFixed(2)} range ${outsideOn.range}/${outsideOn2.range}, ` +
        `clear ${JSON.stringify(clear)} · outside changed ${outsideChanged.differing} px · ` +
        `inside ${insideOn.n} px, spread ${insideOn.spread.toFixed(1)} · inside left at the clear ` +
        `colour: ${JSON.stringify(covered)}`,
    )
    // The premise: there is a world in the corners to reject, and inside.
    expect(outsideOn.n, 'the region has pixels').toBeGreaterThan(1000)
    expect(outsideOff.spread, 'mask off: the corners hold a picture').toBeGreaterThan(5)
    expect(insideOn.spread, 'mask on: the middle holds a picture').toBeGreaterThan(5)
    // 1. Rejected: one flat colour, where the off shot had a picture.
    expect(outsideOn.range, 'mask on: the corners are one colour').toBeLessThanOrEqual(2)
    expect(outsideOn2.range, 'and again on the second shot').toBeLessThanOrEqual(2)
    expect(outsideChanged.differing, 'and most of them changed').toBeGreaterThan(outsideOn.n / 2)
    // 2. Inside: the mask covered no pixel, in either on shot.
    expect(clear, 'the clear colour was read').toHaveLength(3)
    for (const [k, c] of covered.entries()) {
      expect(c.covered, `on shot ${k + 1}: inside pixels the mask covered (${c.examples})`).toBe(0)
    }
  })
})
