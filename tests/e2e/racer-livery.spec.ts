/**
 * tests/e2e/racer-livery.spec.ts — the AI racers are solid, and each wears its
 * own colour. DEV-350.
 *
 * Matt, 2026-09-24: *"replace ai 'ghosts' as ai 'racers' - solid shaded,
 * different coloration than the player's orange hoverjet."*
 *
 * ── Why here and not only in `racer-livery.test.ts` ─────────────────────
 *
 * The unit file proves the paint on the shipped GLB, the look switch and the
 * shadow row. What it cannot see is the BUILD: that `loadRacers` was handed
 * the preset, that every hull in the live scene wears the livery on
 * Anniversary and the hologram on Classic, that the sun's map was handed the
 * racer meshes, that the player's own hull is still orange, and that a flip
 * moves all of it. A flag has been green in a unit test while it was dead in
 * the frame here before (AGENT-NOTES §4), so this reads the live scene graph,
 * and then photographs it.
 *
 * ── The photographs ──────────────────────────────────────────────────────
 *
 * The start grid on `int_01_hoverJet`, from the seat and from third person;
 * the player's third-person view as the pack leaves the grid; and one frame
 * mid-race from the chase camera behind `steady`, the pad racer both presets
 * fly. On both presets — the brief's gate.
 * `LIVERY_DIR` because Playwright wipes `test-results/` at the start of every
 * run, and a Classic/Anniversary pair taken in two runs would lose half.
 * PINNED (DEV-245) and the pin is in every file name: a tier drop moves the
 * shadow map, and the shadow is part of this row.
 *
 *   LIVERY_DIR=<dir> E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/racer-livery.spec.ts --workers 1
 *
 * `LIVERY_MISSION` flies another course (default `int_01_hoverJet`). DEV-462
 * photographed the palette on `rookie_01_hoverJet` too: its sun is the one
 * with almost no blue in it, where green and cyan used to merge.
 *
 * ── Where the racers ARE, which decided the two freezes ──────────────────
 *
 * Probed second by second from the player's third-person camera, autopilot
 * flying: on Anniversary four racers are in frame at 1.1 s (18-30 m) and by
 * 2.6 s none is; the leader comes back into frame from 8 s at 30-270 m. On
 * Classic the one racer in frame is `fast`, from 1.0 to 3.0 s, and NONE
 * after — the autopilot is slower than both. So a mid-race frame from the
 * player's seat photographs an empty sky on Classic, and the only frame that
 * shows several colours beside the player's orange is the pack leaving the
 * grid. `LIVERY_PACK_AT` (default 1.2 s) and `LIVERY_AT` (default 10 s, for
 * the chase camera, which has its racer in frame by construction) move them.
 *
 * ── Same build, same code path ───────────────────────────────────────────
 *
 * The autopilot, `?snap=`, `?ride=0` and V are things the game does. The flip
 * goes through `__ff2.edition.set`, the route the Advanced page takes.
 * `@gpu`, headed, hydrated assets.
 */

import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { flyToFreeze, hold } from './fixtures/freeze'
import { firstPress } from './fixtures/landing'
import { viewportPhotographer } from './fixtures/photo'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.LIVERY_DIR ?? path.join('test-results', 'racer-livery')
const MISSION = process.env.LIVERY_MISSION ?? 'int_01_hoverJet'
const CHASE_AT = Number(process.env.LIVERY_AT ?? '10')
const PACK_AT = Number(process.env.LIVERY_PACK_AT ?? '1.2')
/** `?view=chase` — the dev camera behind one racer (`boot/app.ts`, `CHASE_TARGET`). */
const CHASED = 'steady'
const PIN_PARAMS: Readonly<Record<string, string>> = Object.fromEntries(new URLSearchParams(PINNED))
/** In every file name, so a picture says which tier it was taken on. */
const PIN_TAG = PINNED.replace(/[=&]/g, '')

type Rgb = [number, number, number]

interface Hull {
  readonly id: string
  readonly transparent: boolean
  readonly opacity: number
  readonly vertexColors: boolean
  readonly cast: boolean
  /** The most saturated vertex colour on the hull, LINEAR, as the GPU gets it. */
  readonly panel: Rgb | null
}

interface Facts {
  readonly solid: boolean | null
  readonly colours: (string | null)[]
  readonly racers: Hull[]
  readonly player: Hull | null
  readonly shadowMapOn: boolean
  /** Racers whose origin projects inside the frame, in front of the camera. */
  readonly onScreen: number
}

const facts = (page: Page): Promise<Facts> =>
  page.evaluate(() => {
    type Attr = {
      count: number
      getX(i: number): number
      getY(i: number): number
      getZ(i: number): number
    }
    type O = {
      name?: string
      isMesh?: boolean
      castShadow?: boolean
      position?: { constructor: new () => V }
      material?: { transparent?: boolean; opacity?: number; vertexColors?: boolean }
      geometry?: { getAttribute(n: string): Attr | undefined }
      children?: O[]
      traverse?: (fn: (o: O) => void) => void
      getWorldPosition?: (v: V) => V
    }
    type V = { x: number; y: number; z: number; project(c: unknown): V }
    const w = globalThis as unknown as {
      __ff2?: {
        render: { scene: O; camera: unknown; renderer: { shadowMap: { enabled: boolean } } }
        racers: () => {
          solid?: boolean
          racers: { spec: { id: string; colour?: string | null } }[]
        } | null
      }
    }
    const h = w.__ff2
    if (!h) throw new Error('racer-livery: no __ff2')
    const hullOf = (root: O, id: string): Hull | null => {
      let out: Hull | null = null
      root.traverse?.((o) => {
        if (out || !o.isMesh || o.name !== 'ship_ext_orange') return
        const colour = o.geometry?.getAttribute('color')
        let panel: Rgb | null = null
        let best = -1
        for (let i = 0; colour && i < colour.count; i++) {
          const c: Rgb = [colour.getX(i), colour.getY(i), colour.getZ(i)]
          const chroma = Math.max(...c) - Math.min(...c)
          if (chroma > best) {
            best = chroma
            panel = c
          }
        }
        out = {
          id,
          transparent: o.material?.transparent === true,
          opacity: o.material?.opacity ?? 1,
          vertexColors: o.material?.vertexColors === true,
          cast: o.castShadow === true,
          panel,
        }
      })
      return out
    }
    const racers: Hull[] = []
    let player: Hull | null = null
    let onScreen = 0
    h.render.scene.traverse?.((o) => {
      const name = o.name ?? ''
      if (name === 'hoverjet') player = hullOf(o, 'player')
      if (!name.startsWith('racer:')) return
      const hull = hullOf(o, name.slice('racer:'.length))
      if (hull) racers.push(hull)
      const Vec = o.position?.constructor
      if (Vec && o.getWorldPosition) {
        const p = o.getWorldPosition(new Vec()).project(h.render.camera)
        if (Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && p.z < 1) onScreen++
      }
    })
    const live = h.racers()
    return {
      solid: live?.solid ?? null,
      colours: (live?.racers ?? []).map((r) => r.spec.colour ?? null),
      racers,
      player,
      shadowMapOn: h.render.renderer.shadowMap.enabled,
      onScreen,
    }
  })

/** HSL hue and saturation of a LINEAR colour, read in sRGB as the livery is authored. */
const hueSat = (lin: Rgb): { hue: number; sat: number } => {
  const s = lin.map((c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)) as Rgb
  const max = Math.max(...s)
  const min = Math.min(...s)
  const d = max - min
  const l = (max + min) / 2
  if (d === 0) return { hue: 0, sat: 0 }
  const sat = d / (1 - Math.abs(2 * l - 1))
  const [r, g, b] = s
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { hue: (h * 60 + 360) % 360, sat }
}

/** Degrees from the player's orange panel, 25.2 (`render/racer-livery.ts`). */
const offOrange = (lin: Rgb): number => {
  const d = Math.abs(hueSat(lin).hue - 25.2) % 360
  return d > 180 ? 360 - d : d
}

/**
 * The assertions each preset makes about what the hulls WEAR.
 *
 * The HULLS first, then the flag and the colours that report them: a red run
 * should name the pixels before it names the bookkeeping.
 */
const expectLook = (f: Facts, edition: 'anniversary' | 'classic'): void => {
  // The premise, loud: a scene with no racers passes every loop below.
  expect(f.racers.length, 'racer hulls in the scene').toBeGreaterThanOrEqual(2)
  expect(f.player, "the player's hull").not.toBeNull()
  // The CONTROL: the player is orange on both presets, whatever the racers did.
  expect(offOrange(f.player?.panel as Rgb), 'the player is still orange').toBeLessThan(10)
  if (edition === 'anniversary') {
    for (const r of f.racers) {
      expect(r.transparent, `${r.id} is opaque`).toBe(false)
      expect(r.opacity, `${r.id} opacity`).toBe(1)
      expect(r.vertexColors, `${r.id} reads its livery`).toBe(true)
      const { sat } = hueSat(r.panel as Rgb)
      // A coloured hull must be clear of the orange by the painter's own band
      // (`LIVERY_HUE_TOLERANCE_DEG`, 30): what it would take for livery is what
      // a player could take for their own ship. This was 60 until the DEV-350
      // follow-up's rainbow put red and yellow either side of the orange; how
      // far they sit from it as an EYE sees it, under every racing mission's
      // sun (DEV-462), is `racer-livery.test.ts`'s OKLab test.
      if (sat >= 0.1) expect(offOrange(r.panel as Rgb), `${r.id} is not orange`).toBeGreaterThan(30)
      expect(r.cast, `${r.id} casts (shadows ${f.shadowMapOn})`).toBe(f.shadowMapOn)
    }
    expect(f.solid).toBe(true)
  } else {
    for (const r of f.racers) {
      expect(r.transparent, `${r.id} is the hologram`).toBe(true)
      expect(r.opacity, `${r.id} opacity`).toBeCloseTo(0.72, 6)
      expect(r.vertexColors, `${r.id} ignores the livery`).toBe(false)
      expect(r.cast, `${r.id} casts nothing`).toBe(false)
    }
    expect(f.solid).toBe(false)
  }
  // The palette is read at load on BOTH presets — it is what a flip paints.
  expect(f.colours.length, 'one colour per racer on the spec').toBe(f.racers.length)
  for (const c of f.colours) expect(c).toMatch(/^#[0-9a-f]{6}$/)
  expect(new Set(f.colours).size, 'no two racers share a colour').toBe(f.colours.length)
}

const shoot = viewportPhotographer(OUT, PIN_TAG)

/** V, and wait for the game to say it moved the camera out. */
const toThirdPerson = async (page: Page): Promise<void> => {
  const lines: string[] = []
  page.on('console', (m) => lines.push(m.text()))
  await hold(page, 'v')
  await expect
    .poll(() => lines.includes('camera: third person'), {
      timeout: 15_000,
      message: 'V never reached the camera',
    })
    .toBe(true)
  // The switch fades out and back in; let it land.
  await page.waitForTimeout(3_000)
}

test.describe('@gpu DEV-350: the racers are solid, and each wears its own colour', () => {
  test.setTimeout(600_000)

  for (const edition of ['anniversary', 'classic'] as const) {
    test(`the start grid · ${edition}`, async ({ page }) => {
      await page.goto(`/?mission=${MISSION}&xr=off&ride=0&menu=0&edition=${edition}&${PINNED}`)
      await firstPress(page)
      await missionReady(page, 240_000)
      await page.waitForTimeout(1_500)
      const pinned = await drawState(page)
      console.info(`racer-livery grid ${edition}: ${drawStateLine(pinned)}`)
      const f = await facts(page)
      console.info(
        `racer-livery grid ${edition}: ${f.racers.length} racers ${f.colours.join(' ')}, ` +
          `solid ${f.solid}, shadow map ${f.shadowMapOn}`,
      )
      expectLook(f, edition)
      await shoot(page, `grid-seat-${edition}`)
      await focusCanvas(page)
      await toThirdPerson(page)
      await shoot(page, `grid-third-${edition}`)
      expect(drawStateDiff(pinned, await drawState(page)), 'the tier held').toEqual([])
    })

    test(`the pack leaving the grid, third person · ${edition}`, async ({ page }) => {
      await flyToFreeze(page, { mission: MISSION, edition, snapAt: PACK_AT, params: PIN_PARAMS })
      const pinned = await drawState(page)
      await toThirdPerson(page)
      const f = await facts(page)
      console.info(
        `racer-livery pack ${edition} @ ${PACK_AT}s: ${f.onScreen} of ${f.racers.length} ` +
          `racers on screen · ${drawStateLine(pinned)}`,
      )
      expectLook(f, edition)
      // A frame with no racer in it cannot show a colour: the sample's premise.
      expect(f.onScreen, 'racers in the frame').toBeGreaterThanOrEqual(1)
      await shoot(page, `pack-third-${edition}-${PACK_AT}s`)
      expect(drawStateDiff(pinned, await drawState(page)), 'the tier held').toEqual([])
    })

    test(`mid-race, chase camera · ${edition}`, async ({ page }) => {
      await flyToFreeze(page, {
        mission: MISSION,
        edition,
        snapAt: CHASE_AT,
        params: { ...PIN_PARAMS, view: 'chase', chase: CHASED },
      })
      const pinned = await drawState(page)
      const f = await facts(page)
      console.info(
        `racer-livery chase ${edition} @ ${CHASE_AT}s behind ${CHASED}: ${f.onScreen} of ` +
          `${f.racers.length} racers on screen · ${drawStateLine(pinned)}`,
      )
      expectLook(f, edition)
      expect(f.onScreen, 'the chased racer is in its own camera').toBeGreaterThanOrEqual(1)
      await shoot(page, `chase-${CHASED}-${edition}-${CHASE_AT}s`)
      expect(drawStateDiff(pinned, await drawState(page)), 'the tier held').toEqual([])

      if (edition !== 'anniversary') return
      // ── the flip, both ways, through the route the Edition page takes ──
      const setLivery = (on: boolean) =>
        page.evaluate((enabled) => {
          const w = globalThis as unknown as {
            __ff2: { edition: { current: unknown; setPreset(e: unknown): void } }
          }
          const next = structuredClone(w.__ff2.edition.current) as {
            render: { racerLivery: { enabled: boolean } }
          }
          next.render.racerLivery.enabled = enabled
          w.__ff2.edition.setPreset(next)
        }, on)
      await setLivery(false)
      await page.waitForTimeout(500)
      expectLook(await facts(page), 'classic')
      await setLivery(true)
      await page.waitForTimeout(500)
      expectLook(await facts(page), 'anniversary')

      // ── what the shadow costs, as a count of ONE frame ─────────────────
      //
      // A frozen frame drawn three times, shadow ON, OFF, ON: the difference
      // in draw calls and triangles is the racers' depth pass and nothing
      // else, and a count of a frame is immune to a busy box where a
      // millisecond is not (AGENT-NOTES §1). It is also DEV-305's premise,
      // checked positively: meshes whose flag never reached three would add
      // nothing here.
      const cost = await page.evaluate(() => {
        type Info = { render: { calls: number; triangles: number } }
        const w = globalThis as unknown as {
          __ff2: {
            render: {
              renderer: { info: Info; render(s: unknown, c: unknown): void }
              scene: unknown
              camera: unknown
            }
            edition: { current: unknown; setPreset(e: unknown): void }
          }
        }
        const { renderer, scene, camera } = w.__ff2.render
        const shadow = (enabled: boolean): void => {
          const next = structuredClone(w.__ff2.edition.current) as {
            render: { racerLivery: { shadow: { enabled: boolean } } }
          }
          next.render.racerLivery.shadow.enabled = enabled
          w.__ff2.edition.setPreset(next)
        }
        const draw = () => {
          renderer.render(scene, camera)
          return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }
        }
        const on = draw()
        shadow(false)
        const off = draw()
        shadow(true)
        return { on, off, again: draw() }
      })
      console.info(
        `racer-livery shadow cost @ ${CHASE_AT}s: ON ${cost.on.calls} calls / ${cost.on.triangles} tris · ` +
          `OFF ${cost.off.calls} / ${cost.off.triangles} · ON ${cost.again.calls} / ${cost.again.triangles}`,
      )
      // Both arms, because the frozen frame is not QUITE frozen: one draw on
      // the render clock moved between two identical ON draws in the first
      // run (234 then 233). The racers' share is the gap, and it must be there
      // in both.
      expect(cost.on.calls - cost.off.calls, 'the racers are in the depth pass').toBeGreaterThan(0)
      expect(cost.again.calls - cost.off.calls, 'and still, after a flip back').toBeGreaterThan(0)
    })
  }
})
