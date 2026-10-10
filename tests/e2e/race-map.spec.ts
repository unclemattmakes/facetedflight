/**
 * tests/e2e/race-map.spec.ts — the race map beside the readout, and your place
 * on it, read from the live build. DEV-361.
 *
 * Matt, 2026-09-24: *"simplified race mini map hud to understand your position
 * relative to others - grab from king-tide"*.
 *
 * ── What only the build can say ─────────────────────────────────────────
 *
 * `race-place.test.ts` pins the ordering and `race-map.test.ts` the geometry.
 * Neither can see that `boot/app.ts` built the map where the racers are, hung
 * it on the panel, fed it the live racers and the live mission, and kept it on
 * the panel's cadence — a flag has been green in a unit test while it was dead
 * in the frame here before (AGENT-NOTES §4). So this flies `int_01_hoverJet`,
 * freezes it mid-race and reads `__ff2.raceMap()`:
 *
 *   · the PLACE it shows sits inside the bracket the racers' own gate state
 *     allows — crossed racers ahead, and the flying ones ahead or behind by
 *     the furthest gate each has reached, whatever their arcs say;
 *   · the field is the racers plus you, and the text says the same numbers;
 *   · the map is ONE node, a child of the panel, visible, drawing ONE call —
 *     counted by drawing the frozen frame with it and without it, which is a
 *     count of a frame and survives a busy box (AGENT-NOTES §1);
 *   · DEV-432: the player's mark is a triangle, and the one DRAWN — read out of
 *     the map's own vertex buffer — points along the ship's nose and along
 *     where the ship is actually going. The nose goes through three's
 *     quaternion algebra, not the port's, so the compare shares no code with
 *     the thing it checks;
 *   · Classic has none of it.
 *
 * ── The photographs ─────────────────────────────────────────────────────
 *
 * From the seat and from third person, the whole frame and a crop of the panel
 * and the map together, pinned (DEV-245) with the pin in every name.
 * `RACE_MAP_DIR` because Playwright wipes `test-results/` at the start of
 * every run. `RACE_MAP_AT` moves the freeze (default 25 s, when the field has
 * spread out along the first legs).
 *
 *   RACE_MAP_DIR=<dir> E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/race-map.spec.ts --workers 1
 *
 * ── Same build, same code path ──────────────────────────────────────────
 *
 * The autopilot, `?snap=` and V are things the game does. Hiding the map for
 * one draw is a measurement on a frozen frame, restored before anything else
 * reads it. `@gpu`, headed, hydrated assets.
 */
import fs from 'node:fs'
import path from 'node:path'
import { flyToFreeze, hold } from './fixtures/freeze'
import { viewportPhotographer } from './fixtures/photo'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.RACE_MAP_DIR ?? path.join('test-results', 'race-map')
const MISSION = 'int_01_hoverJet'
const AT = Number(process.env.RACE_MAP_AT ?? '25')
const PIN_PARAMS: Readonly<Record<string, string>> = Object.fromEntries(new URLSearchParams(PINNED))
/** In every file name, so a picture says which tier it was taken on. */
const PIN_TAG = PINNED.replace(/[=&]/g, '')

interface MapFacts {
  readonly map: {
    text: string
    place: number | null
    field: number
    racers: number
    cadence: string
    writes: number
    unchanged: number
    skipped: number
    triangles: number
    bytesPerWrite: number
    routePoints: number
    outlinePoints: number
    metresPerPlateMetre: number
    dots: { x: number; y: number }[]
    playerHeading?: { x: number; y: number }
    layout: {
      width: number
      height: number
      area: { minX: number; maxX: number; minY: number; maxY: number }
    }
  } | null
  /** What the panel beside it is on — the map must be on the same cadence. */
  readonly hudCadence: string | null
  readonly racers: { id: string; finished: boolean; reached: number }[]
  readonly playerReached: number
  readonly playerCrossed: boolean
  readonly nodes: number
  readonly parent: string | null
  readonly visible: boolean
}

const facts = (page: Page): Promise<MapFacts> =>
  page.evaluate(() => {
    type O = { name?: string; visible?: boolean; parent?: O | null }
    const w = globalThis as unknown as {
      __ff2: {
        raceMap: () => MapFacts['map']
        hud: () => { cadence: string } | null
        racers: () => {
          racers: { spec: { id: string }; finished: boolean; course: { passed: boolean[] } }[]
        } | null
        mission: { course: { passed: boolean[] }; finishCrossed: boolean }
        stage: () => { traverse: (f: (o: O) => void) => void }
      }
    }
    const h = w.__ff2
    // 1 + the furthest gate taken — the racers' raw state, read here rather
    // than through the build's own ordering so the bracket is independent.
    const reachedOf = (passed: boolean[]): number => {
      for (let i = passed.length - 1; i >= 0; i -= 1) if (passed[i]) return i + 1
      return 0
    }
    let nodes = 0
    let parent: string | null = null
    let visible = false
    h.stage().traverse((o) => {
      if (o.name !== 'race-map') return
      nodes += 1
      parent = o.parent?.name ?? null
      let v = true
      for (let p: O | null | undefined = o; p; p = p.parent) v = v && p.visible !== false
      visible = v
    })
    return {
      map: h.raceMap(),
      hudCadence: h.hud()?.cadence ?? null,
      racers: (h.racers()?.racers ?? []).map((r) => ({
        id: r.spec.id,
        finished: r.finished,
        reached: reachedOf(r.course.passed),
      })),
      playerReached: reachedOf(h.mission.course.passed),
      playerCrossed: h.mission.finishCrossed,
      nodes,
      parent,
      visible,
    }
  })

/**
 * Draw calls in the frozen frame with the map, without it, and with it again.
 * The node is hidden for exactly one `renderer.render` and put back.
 */
const mapCalls = (page: Page) =>
  page.evaluate(() => {
    type O = { name?: string; visible: boolean }
    const w = globalThis as unknown as {
      __ff2: {
        render: {
          renderer: { info: { render: { calls: number } }; render(s: unknown, c: unknown): void }
          scene: { getObjectByName: (n: string) => O | undefined }
          camera: unknown
        }
      }
    }
    const { renderer, scene, camera } = w.__ff2.render
    const node = scene.getObjectByName('race-map')
    if (!node) return null
    const draw = () => {
      renderer.render(scene, camera)
      return renderer.info.render.calls
    }
    const on = draw()
    node.visible = false
    const off = draw()
    node.visible = true
    return { on, off, again: draw() }
  })

/**
 * DEV-432: the player's mark as DRAWN — the last triangle in the map's own
 * position buffer — and the ship's nose and velocity, both on the map's axes
 * (sim x right, sim z up). The nose is body +Z turned by three's `Quaternion`,
 * which has the sim's component order and handedness (`sim/math/quat.ts`).
 */
const markAgainstShip = (page: Page) =>
  page.evaluate(() => {
    type V = { x: number; y: number; z: number; applyQuaternion: (q: unknown) => V }
    const w = globalThis as unknown as {
      __ff2: {
        render: {
          scene: { getObjectByName: (n: string) => unknown }
          camera: { position: object; quaternion: object }
        }
        flight: () => {
          jet: {
            body: {
              orientation: { x: number; y: number; z: number; w: number }
              velocity: { x: number; y: number; z: number }
            }
          }
        } | null
      }
    }
    const node = w.__ff2.render.scene.getObjectByName('race-map') as
      | { geometry: { getAttribute: (n: string) => { array: ArrayLike<number> } } }
      | undefined
    const flight = w.__ff2.flight()
    if (!node || !flight) return null
    const a = node.geometry.getAttribute('position').array
    const t = a.length / 9 - 1
    const corners = [0, 1, 2].map((k) => [a[t * 9 + k * 3] ?? 0, a[t * 9 + k * 3 + 1] ?? 0])
    const { camera } = w.__ff2.render
    const Vec = camera.position.constructor as new (x: number, y: number, z: number) => V
    const Quat = camera.quaternion.constructor as new (
      x: number,
      y: number,
      z: number,
      w: number,
    ) => unknown
    const q = flight.jet.body.orientation
    const n = new Vec(0, 0, 1).applyQuaternion(new Quat(q.x, q.y, q.z, q.w))
    const v = flight.jet.body.velocity
    return { corners, nose: [n.x, n.z], velocity: [v.x, v.z] }
  })

/** The drawn triangle's axis: from the midpoint of its shortest side to the corner facing it. */
const markAxis = (corners: number[][]): [number, number] => {
  const k = corners as [number, number][]
  const side = (i: number) => {
    const a = k[(i + 1) % 3] as [number, number]
    const b = k[(i + 2) % 3] as [number, number]
    return Math.hypot(a[0] - b[0], a[1] - b[1])
  }
  const sides = [side(0), side(1), side(2)]
  const i = sides.indexOf(Math.min(...sides))
  const apex = k[i] as [number, number]
  const a = k[(i + 1) % 3] as [number, number]
  const b = k[(i + 2) % 3] as [number, number]
  return [apex[0] - (a[0] + b[0]) / 2, apex[1] - (a[1] + b[1]) / 2]
}

/** Degrees between two plate directions. */
const degreesBetween = (a: readonly number[], b: readonly number[]): number => {
  const [ax = 0, ay = 0] = a
  const [bx = 0, by = 0] = b
  return (Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)) * 180) / Math.PI
}

/** The screen rect around the panel and the map together, in page CSS pixels. */
const panelAndMapClip = (page: Page) =>
  page.evaluate(() => {
    type V3 = { x: number; y: number; z: number }
    interface Cam {
      position: V3
      matrixWorld: unknown
      matrixWorldInverse: { copy: (m: unknown) => { invert: () => unknown } }
      updateMatrixWorld: (force?: boolean) => void
    }
    interface Mesh {
      matrixWorld: unknown
      updateWorldMatrix: (parents: boolean, children: boolean) => void
      geometry?: { parameters?: { width: number; height: number } }
    }
    const w = globalThis as unknown as {
      __ff2: {
        render: { scene: { getObjectByName: (n: string) => Mesh | undefined }; camera: Cam }
        raceMap: () => { layout: { width: number; height: number } } | null
      }
    }
    const { scene, camera } = w.__ff2.render
    const panel = scene.getObjectByName('hud')
    const map = scene.getObjectByName('race-map')
    const plate = w.__ff2.raceMap()?.layout
    const size = panel?.geometry?.parameters
    const canvas = document.getElementById('viewport') as HTMLCanvasElement | null
    if (!panel || !map || !plate || !size || !canvas) return null
    panel.updateWorldMatrix(true, false)
    map.updateWorldMatrix(true, false)
    camera.updateMatrixWorld(true)
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
    const V = camera.position.constructor as new (
      x: number,
      y: number,
      z: number,
    ) => { x: number; y: number; applyMatrix4: (m: unknown) => void; project: (c: Cam) => void }
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    const xs: number[] = []
    const ys: number[] = []
    const corners = (m: Mesh, w2: number, h2: number) => {
      for (const [lx, ly] of [
        [-w2, h2],
        [w2, h2],
        [-w2, -h2],
        [w2, -h2],
      ] as const) {
        const v = new V(lx, ly, 0)
        v.applyMatrix4(m.matrixWorld)
        v.project(camera)
        xs.push((v.x * 0.5 + 0.5) * cssW)
        ys.push((1 - (v.y * 0.5 + 0.5)) * cssH)
      }
    }
    corners(panel, size.width / 2, size.height / 2)
    corners(map, plate.width / 2, plate.height / 2)
    const pad = 16
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad))
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad))
    const x1 = Math.min(cssW, Math.ceil(Math.max(...xs) + pad))
    const y1 = Math.min(cssH, Math.ceil(Math.max(...ys) + pad))
    const box = canvas.getBoundingClientRect()
    return {
      x: box.x + x0,
      y: box.y + y0,
      width: Math.max(1, x1 - x0),
      height: Math.max(1, y1 - y0),
    }
  })

const shootViewport = viewportPhotographer(OUT, PIN_TAG)
const shoot = async (page: Page, name: string): Promise<void> => {
  await shootViewport(page, name)
  const clip = await panelAndMapClip(page)
  expect(clip, `${name}: the panel and the map project onto the screen`).not.toBeNull()
  if (clip) {
    fs.writeFileSync(path.join(OUT, `${name}-crop-${PIN_TAG}.png`), await page.screenshot({ clip }))
  }
}

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

test.describe('@gpu DEV-361: the race map, and your place on it', () => {
  test.setTimeout(600_000)

  test(`mid-race on ${MISSION} · anniversary`, async ({ page }) => {
    await flyToFreeze(page, {
      mission: MISSION,
      edition: 'anniversary',
      snapAt: AT,
      params: PIN_PARAMS,
    })
    const pinned = await drawState(page)
    const f = await facts(page)
    console.info(
      `race-map @ ${AT}s: ${JSON.stringify(f.map?.text)} place ${f.map?.place}/${f.map?.field} · ` +
        `you reached ${f.playerReached} · racers ${f.racers
          .map((r) => `${r.id}:${r.finished ? 'done' : r.reached}`)
          .join(' ')} · writes ${f.map?.writes} · ${drawStateLine(pinned)}`,
    )

    // ── the map is there, on the panel, and on the panel's cadence ────────
    expect(f.map, '__ff2.raceMap() answered nothing — no map was built').not.toBeNull()
    const map = f.map as NonNullable<MapFacts['map']>
    expect(f.racers.length, 'the premise: racers are flying').toBeGreaterThanOrEqual(2)
    expect(f.nodes, 'exactly one race-map in the stage').toBe(1)
    expect(f.parent, 'hung on the panel').toBe('hud')
    expect(f.visible, 'and visible from the seat').toBe(true)
    expect(map.cadence).toBe(f.hudCadence)
    expect(map.writes, 'the map was written at least once').toBeGreaterThan(0)
    expect(map.racers).toBe(f.racers.length)
    expect(map.dots).toHaveLength(f.racers.length + 1)
    for (const d of map.dots) {
      expect(d.x).toBeGreaterThanOrEqual(map.layout.area.minX - 1e-9)
      expect(d.x).toBeLessThanOrEqual(map.layout.area.maxX + 1e-9)
      expect(d.y).toBeGreaterThanOrEqual(map.layout.area.minY - 1e-9)
      expect(d.y).toBeLessThanOrEqual(map.layout.area.maxY + 1e-9)
    }

    // ── the place, against the racers' own state ─────────────────────────
    expect(f.playerCrossed, 'the premise: still racing at the freeze').toBe(false)
    expect(map.field).toBe(f.racers.length + 1)
    expect(map.place).not.toBeNull()
    expect(map.text).toBe(`#${map.place}/${map.field}`)
    const crossed = f.racers.filter((r) => r.finished).length
    const clearlyAhead = f.racers.filter((r) => !r.finished && r.reached > f.playerReached).length
    const level = f.racers.filter((r) => !r.finished && r.reached === f.playerReached).length
    const place = map.place as number
    // Everyone who crossed, and every flying racer a gate or more further round,
    // is ahead; a racer on the same gate may be either side, by metres.
    expect(place).toBeGreaterThanOrEqual(1 + crossed + clearlyAhead)
    expect(place).toBeLessThanOrEqual(1 + crossed + clearlyAhead + level)

    // ── one draw call, counted on the frozen frame ────────────────────────
    const calls = await mapCalls(page)
    console.info(
      `race-map draw calls: with ${calls?.on} · without ${calls?.off} · with ${calls?.again} · ` +
        `${map.triangles} triangles · ${map.bytesPerWrite} B a write at most · ` +
        `writes ${map.writes} / unchanged ${map.unchanged} / skipped ${map.skipped} · ` +
        `line ${map.routePoints} -> ${map.outlinePoints} points · ` +
        `${map.metresPerPlateMetre.toFixed(0)} m per plate metre`,
    )
    expect(calls).not.toBeNull()
    const c = calls as NonNullable<typeof calls>
    expect(c.on - c.off, 'the map is one draw').toBe(1)
    expect(c.again - c.off, 'and still one after it is put back').toBe(1)

    // ── DEV-432: the mark points where the ship does ─────────────────────
    //
    // The frozen frame keeps feeding the map, so what is drawn is within the
    // map's own write threshold of the frozen ship: a texel at the mark's tip,
    // about 5 degrees at this size (7 on the texel's diagonal). The track is
    // a looser check with an independent source — the ship's velocity, not
    // its orientation — which is what would catch a nose read off the wrong
    // body axis. SOFT, so a red run still takes its photographs.
    const mark = await markAgainstShip(page)
    expect(mark, 'the map and the flight both answered').not.toBeNull()
    if (mark) {
      const axis = markAxis(mark.corners)
      const offNose = degreesBetween(axis, mark.nose)
      const offTrack = degreesBetween(axis, mark.velocity)
      const speed = Math.hypot(mark.velocity[0] ?? 0, mark.velocity[1] ?? 0)
      console.info(
        `race-map mark: ${offNose.toFixed(2)} deg off the nose · ${offTrack.toFixed(2)} deg off ` +
          `the track at ${speed.toFixed(0)} m/s · written heading ${JSON.stringify(map.playerHeading)}`,
      )
      expect.soft(offNose, 'the triangle points along the nose').toBeLessThan(12)
      expect.soft(speed, 'the premise: moving, so the track has a direction').toBeGreaterThan(50)
      expect.soft(offTrack, 'and along where the ship is going').toBeLessThan(25)
    }

    // ── the photographs ───────────────────────────────────────────────────
    await shoot(page, `cockpit-anniversary-${AT}s`)
    await toThirdPerson(page)
    const outside = await facts(page)
    expect(outside.visible, 'the map follows the panel onto the chase camera').toBe(true)
    await shoot(page, `third-anniversary-${AT}s`)
    expect(drawStateDiff(pinned, await drawState(page)), 'the tier held').toEqual([])
  })

  test(`classic has no map and no place · ${MISSION}`, async ({ page }) => {
    await flyToFreeze(page, {
      mission: MISSION,
      edition: 'classic',
      snapAt: AT,
      params: PIN_PARAMS,
    })
    const f = await facts(page)
    // The premise first: Classic races too, so an absent map is the flag.
    expect(f.racers.length, 'Classic flies racers').toBeGreaterThanOrEqual(1)
    expect(f.map).toBeNull()
    expect(f.nodes).toBe(0)
  })
})
