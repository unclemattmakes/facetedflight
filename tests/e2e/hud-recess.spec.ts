/**
 * tests/e2e/hud-recess.spec.ts — DEV-362. The readout sits IN the dashboard,
 * in the running game, on both editions, and the chase camera's readout does
 * not change.
 *
 *   E2E_PORT=<yours> HUD_RECESS_DIR=<dir> \
 *     pnpm exec playwright test tests/e2e/hud-recess.spec.ts --workers 1 --retries 0
 *
 * `tests/unit/hud-recess.test.ts` measures the placement against the shipped
 * mesh with rays from the eye. This file measures what node cannot: that the
 * BUILD put it there. Read off the live scene:
 *
 *  1. **Mounted in the dash**: the panel reports `mount: 'dash'`, hangs on the
 *     ART PIVOT at `eye + cockpit.placement.hud` — in the pivot's own frame
 *     `eye - pivot + offset`, since DEV-365 stood the pivot at 2016's
 *     `art_pivot` (`__ff2.flight().pivot`) — and is depth-TESTED.
 *  2. **It stays in its bezel while the cockpit leans.** The pose that matters
 *     is the panel's in the COCKPIT MESH's frame. At the frozen tick the
 *     autopilot is turning and the pivot leans; the panel's pose relative to
 *     `ship_first_person` is read, then the pivot is put level for one
 *     synchronous read and put back — and the two must agree. A panel on the
 *     ship's group would differ by the lean. The lean is printed, so a reader
 *     can see the check was not taken on a level ship.
 *  3. **The chase camera's panel is the one it always was**: V puts it on the
 *     lens (one flat 0.4 m quad, `depthTest` off); V again puts it back.
 *
 * And the JumpSeat, which the lead required not to move: on a JumpSeat mission
 * the panel is on the lens, on the ship's own group, at
 * `eye + cockpit.placement.jumpSeatHud` — which `tests/unit/hud-dash.test.ts`
 * pins to the pose both vehicles had before this row.
 *
 * No import reaches `game/flight.ts` (it pulls in a Vite-only glob, and one
 * such edge empties the whole Playwright collection): the eye is read off the
 * live flight, `__ff2.flight().eye`.
 *
 * The photographs are the deliverable for Matt: from the seat, pinned
 * `adaptive=0&quality=high` (in every file name), full frame and a crop of the
 * recess, on both editions.
 */
import fs from 'node:fs'
import path from 'node:path'
import { WIDTH } from '@/render/hud'
import { DASH_SCREEN } from '@/render/hud-dash'
import { focusCanvas } from './fixtures/canvas'
import { flyToFreeze, hold } from './fixtures/freeze'
import { viewportPhotographer } from './fixtures/photo'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.HUD_RECESS_DIR ?? path.join('test-results', 'hud-recess')
const MISSION = 'int_01_hoverJet'
const AT = Number(process.env.HUD_RECESS_AT ?? '25')
const PIN_PARAMS: Readonly<Record<string, string>> = Object.fromEntries(new URLSearchParams(PINNED))
const PIN_TAG = PINNED.replace(/[=&]/g, '')

interface Mounted {
  readonly mount: string | null
  readonly parent: string | null
  readonly depthTest: boolean | null
  readonly quads: number
  readonly width: number | null
  /** The panel's LOCAL position and x-rotation, the flight's eye, and where its pivot rests. */
  readonly local: number[] | null
  readonly tilt: number | null
  readonly eye: number[] | null
  readonly pivot: number[] | null
  /** The panel's pose in the cockpit mesh's frame, as leaning and as levelled. */
  readonly inCockpit: { leaning: number[]; level: number[] } | null
  /** The art pivot's rotation, degrees — the lean at the freeze. */
  readonly lean: number[] | null
}

const mounted = (page: Page): Promise<Mounted> =>
  page.evaluate(() => {
    type M = { elements: number[]; clone(): M; invert(): M; multiply(m: M): M }
    type E = {
      x: number
      y: number
      z: number
      clone(): E
      copy(e: E): E
      set(x: number, y: number, z: number): E
    }
    type O = {
      name?: string
      type?: string
      parent?: O | null
      rotation: E
      position: E
      matrixWorld: M
      updateWorldMatrix(p: boolean, c: boolean): void
      material?: { depthTest?: boolean }
      geometry?: { parameters?: { width: number }; getAttribute(n: string): { count: number } }
    }
    const w = globalThis as unknown as {
      __ff2: {
        hud: () => { mount?: string } | null
        flight: () => {
          eye: { x: number; y: number; z: number }
          pivot: { x: number; y: number; z: number }
        } | null
        stage: () => { getObjectByName(n: string): O | undefined }
      }
    }
    const stage = w.__ff2.stage()
    const hud = stage.getObjectByName('hud')
    const cockpit = stage.getObjectByName('ship_first_person')
    const pivot = stage.getObjectByName('art_pivot')
    const eye = w.__ff2.flight()?.eye
    const at = w.__ff2.flight()?.pivot
    if (!hud) {
      return {
        mount: null,
        parent: null,
        depthTest: null,
        quads: 0,
        width: null,
        local: null,
        tilt: null,
        eye: null,
        pivot: null,
        inCockpit: null,
        lean: null,
      }
    }
    /** The panel's matrix in the cockpit mesh's frame, flattened. */
    const rel = (): number[] => {
      hud.updateWorldMatrix(true, false)
      cockpit?.updateWorldMatrix(true, false)
      return cockpit ? cockpit.matrixWorld.clone().invert().multiply(hud.matrixWorld).elements : []
    }
    let inCockpit: Mounted['inCockpit'] = null
    let lean: number[] | null = null
    if (cockpit && pivot) {
      const deg = 180 / Math.PI
      lean = [pivot.rotation.x * deg, pivot.rotation.y * deg, pivot.rotation.z * deg]
      const leaning = rel()
      // Level the pivot for ONE synchronous read — at REST, where it stands
      // unleant (DEV-365) — and put it back before the next frame could see it.
      const r = pivot.rotation.clone()
      const p = pivot.position.clone()
      pivot.rotation.set(0, 0, 0)
      pivot.position.set(at?.x ?? 0, at?.y ?? 0, at?.z ?? 0)
      const level = rel()
      pivot.rotation.copy(r)
      pivot.position.copy(p)
      inCockpit = { leaning, level }
    }
    return {
      mount: w.__ff2.hud()?.mount ?? null,
      // The chase camera has no name; its TYPE says what it is.
      parent: hud.parent ? hud.parent.name || hud.parent.type || null : null,
      depthTest: hud.material?.depthTest ?? null,
      quads: (hud.geometry?.getAttribute('position').count ?? 0) / 4,
      width: hud.geometry?.parameters?.width ?? null,
      local: [hud.position.x, hud.position.y, hud.position.z],
      tilt: hud.rotation.x,
      eye: eye ? [eye.x, eye.y, eye.z] : null,
      pivot: at ? [at.x, at.y, at.z] : null,
      inCockpit,
      lean,
    }
  })

/** The recess, from the seat: the upper screen and the strip below it, padded. */
const recessClip = (page: Page) =>
  page.evaluate(() => {
    type V = {
      x: number
      y: number
      applyMatrix4(m: unknown): V
      project(c: unknown): V
      fromBufferAttribute(a: unknown, i: number): V
    }
    const w = globalThis as unknown as {
      __ff2: {
        render: {
          scene: {
            getObjectByName(n: string):
              | {
                  matrixWorld: unknown
                  updateWorldMatrix(p: boolean, c: boolean): void
                  geometry: { getAttribute(n: string): { count: number } }
                }
              | undefined
          }
          camera: {
            position: { constructor: new () => V }
            matrixWorld: { clone(): unknown }
            matrixWorldInverse: { copy(m: unknown): { invert(): unknown } }
            updateMatrixWorld(f: boolean): void
          }
        }
      }
    }
    const { scene, camera } = w.__ff2.render
    const hud = scene.getObjectByName('hud')
    const canvas = document.getElementById('viewport') as HTMLCanvasElement | null
    if (!hud || !canvas) return null
    hud.updateWorldMatrix(true, false)
    camera.updateMatrixWorld(true)
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
    const Vec = camera.position.constructor
    const pos = hud.geometry.getAttribute('position')
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < pos.count; i++) {
      const v = new Vec().fromBufferAttribute(pos, i).applyMatrix4(hud.matrixWorld).project(camera)
      xs.push((v.x * 0.5 + 0.5) * canvas.clientWidth)
      ys.push((1 - (v.y * 0.5 + 0.5)) * canvas.clientHeight)
    }
    // Generous: the bezel and the struts are the point of the picture.
    const padX = (Math.max(...xs) - Math.min(...xs)) * 0.45
    const padY = (Math.max(...ys) - Math.min(...ys)) * 0.6
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - padX))
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - padY))
    const x1 = Math.min(canvas.clientWidth, Math.ceil(Math.max(...xs) + padX))
    const y1 = Math.min(canvas.clientHeight, Math.ceil(Math.max(...ys) + padY))
    const box = canvas.getBoundingClientRect()
    return { x: box.x + x0, y: box.y + y0, width: x1 - x0, height: y1 - y0 }
  })

const shootViewport = viewportPhotographer(OUT, PIN_TAG)
const shoot = async (page: Page, name: string): Promise<void> => {
  await shootViewport(page, name)
  const clip = await recessClip(page)
  expect(clip, `${name}: the recess projects onto the screen`).not.toBeNull()
  if (clip) {
    fs.writeFileSync(
      path.join(OUT, `${name}-recess-${PIN_TAG}.png`),
      await page.screenshot({ clip }),
    )
  }
}

/** DEV-362 follow-up: where the readout's face stands — `loaded` is CRYSTAL. */
const hudFont = (page: Page): Promise<string> =>
  page.evaluate(() =>
    (globalThis as unknown as { __ff2: { hudFont: () => string } }).__ff2.hudFont(),
  )

const near = (a: readonly number[], b: readonly number[], tol: number) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) <= tol)

type Placement = { offset: number[]; tilt: number }
const placementOf = (edition: string, key: 'hud' | 'jumpSeatHud'): Placement =>
  (
    JSON.parse(fs.readFileSync(`content/editions/${edition}.json`, 'utf8')) as {
      cockpit: { placement: Record<string, Placement> }
    }
  ).cockpit.placement[key] as Placement

test.describe('@gpu DEV-362: the readout set into the dash', () => {
  test.setTimeout(600_000)

  for (const edition of ['classic', 'anniversary'] as const) {
    test(`${edition}: in the recess, leaning with it, from the seat · ${MISSION}`, async ({
      page,
    }) => {
      await flyToFreeze(page, { mission: MISSION, edition, snapAt: AT, params: PIN_PARAMS })
      const pinned = await drawState(page)
      const m = await mounted(page)
      const placement = placementOf(edition, 'hud')
      console.info(
        `DEV-362 ${edition} @ ${AT}s: mount ${m.mount} on ${m.parent}, depthTest ${m.depthTest}, ` +
          `${m.quads} quads, upper ${m.width} m, at ${m.local?.map((v) => v.toFixed(4)).join(', ')} ` +
          `tilt ${m.tilt?.toFixed(4)} · lean ${m.lean?.map((d) => d.toFixed(2)).join(', ')} deg · ` +
          `${drawStateLine(pinned)}`,
      )
      expect(m.mount, 'the HoverJet’s panel is set into the dash').toBe('dash')
      expect(m.parent, 'on the art pivot, so it leans with the dash it is set in').toBe('art_pivot')
      expect(m.depthTest, 'depth TESTED in the recess').toBe(true)
      expect(m.quads, 'the upper screen, the speed card and the strip').toBe(3)
      expect(m.width).toBeCloseTo(DASH_SCREEN.width, 6)
      // The preset's numbers reached the panel, from THIS vehicle's eye, in
      // the frame of the pivot it hangs on (DEV-365: the pivot rests at
      // 2016's `art_pivot`, not the ship's origin).
      const eye = m.eye as number[]
      const pivotAt = m.pivot as number[]
      expect(pivotAt, 'no pivot on the flight').not.toBeNull()
      expect(
        near(
          m.local as number[],
          eye.map((e, i) => e - (pivotAt[i] ?? Number.NaN) + (placement.offset[i] ?? 0)),
          1e-6,
        ),
      ).toBe(true)
      expect(m.tilt).toBeCloseTo(placement.tilt, 9)
      // And it leans WITH the dash: the same pose in the cockpit's frame,
      // leaning and levelled. Float32 through an inversion: 1e-5.
      const c = m.inCockpit as NonNullable<Mounted['inCockpit']>
      expect(c, 'no cockpit mesh to measure against').not.toBeNull()
      expect(
        near(c.leaning, c.level, 1e-5),
        'the panel slid in its bezel as the cockpit leaned',
      ).toBe(true)

      // DEV-362 follow-up: a photograph of the panel is a photograph of CRYSTAL
      // only if the face had landed first.
      expect(await hudFont(page), 'the HUD font did not load').toBe('loaded')
      await shoot(page, `seat-${edition}-${AT}s`)
      expect(drawStateDiff(pinned, await drawState(page)), 'the tier held').toEqual([])
    })
  }

  test('the chase camera’s panel is the flat plate it always was, and V puts it back', async ({
    page,
  }) => {
    await flyToFreeze(page, {
      mission: MISSION,
      edition: 'anniversary',
      snapAt: AT,
      params: PIN_PARAMS,
    })
    const lines: string[] = []
    page.on('console', (msg) => lines.push(msg.text()))
    await hold(page, 'v')
    await expect.poll(() => lines.includes('camera: third person'), { timeout: 15_000 }).toBe(true)
    await page.waitForTimeout(3_000)
    const out = await mounted(page)
    expect(out.mount).toBe('lens')
    expect(out.parent ?? '', 'on the lens').toMatch(/camera/i)
    expect(out.depthTest).toBe(false)
    expect(out.quads, 'one flat quad').toBe(1)
    expect(out.width).toBeCloseTo(WIDTH, 6)
    await shoot(page, `third-anniversary-${AT}s`)
    await focusCanvas(page)
    await hold(page, 'v')
    await expect.poll(async () => (await mounted(page)).mount, { timeout: 15_000 }).toBe('dash')
    const back = await mounted(page)
    expect(back.parent).toBe('art_pivot')
    expect(back.quads).toBe(3)
  })

  test('the JumpSeat’s panel does not move: on the lens, on the ship, at jumpSeatHud', async ({
    page,
  }) => {
    // Flown and frozen like the HoverJet arms: a bare `?mission=` boots to
    // the title, and the panel belongs to a flight.
    await flyToFreeze(page, {
      mission: 'rookie_01_jumpSeat',
      edition: 'anniversary',
      snapAt: 5,
      params: PIN_PARAMS,
    })
    const j = await mounted(page)
    console.info(`DEV-362 JumpSeat: ${JSON.stringify(j)}`)
    const placement = placementOf('anniversary', 'jumpSeatHud')
    expect(j.mount).toBe('lens')
    expect(j.parent).toBe('jumpseat')
    expect(j.eye, 'no flight').not.toBeNull()
    expect(
      near(
        j.local as number[],
        (j.eye as number[]).map((e, i) => e + (placement.offset[i] ?? 0)),
        1e-6,
      ),
      `the JumpSeat's panel is not at its own block: ${j.local?.join(', ')}`,
    ).toBe(true)
    expect(j.tilt).toBeCloseTo(placement.tilt, 9)
    // DEV-360's fuel dome, in 2016's face since the DEV-362 follow-up.
    expect(await hudFont(page), 'the HUD font did not load').toBe('loaded')
    await shoot(page, 'jumpseat-anniversary-5s')
  })
})
