/**
 * tests/e2e/ship-shadow-air.spec.ts — the ship's shadow with the ship IN THE
 * AIR: the hull casts onto the ground (DEV-305) and the cockpit receives it
 * (DEV-306). Wishlist #29 / #30; NEXT.md's action 3 of 2026-09-23.
 *
 * ── Why a photograph, and why it was not taken sooner ────────────────────
 *
 * DEV-305 shipped dead once under nineteen green tests: the shadow map was
 * handed a glTF scene root, three reads `castShadow` on the MESH, and every
 * unit test asserted the table rather than the picture. The ledger's own §2g
 * says a screenshot is the verification for this row. Four were taken, and all
 * four had the ship inside the elevator shaft (trap 23: the sample that could
 * never separate anything), because every HoverJet mission spawns underground.
 *
 * `?snap=` freezes the autopilot mid-course, which puts the ship where a
 * player has it. Then it took eight MORE samples that could not separate —
 * too high, a foot in a ridge's shade, a foot on a tree — before one that
 * could. The sample has to be **low, LIT and open**, and this file checks the
 * premise (`sunlit`) rather than trusting the tick: a shadow cast into a
 * shadow changes no pixel, and a small number from that is not a small shadow.
 *
 * ── The measurement ──────────────────────────────────────────────────────
 *
 * `hover-glow.spec.ts`'s recipe: OFF, ON, ON-again at one frozen tick, the
 * control (motes, the HUD's clock — everything on a wall clock) subtracted,
 * the largest 4-connected patch sized. Plus one thing that spec did not need:
 * the patch has to be NEAR THE PREDICTED FOOT, projected through the camera's
 * own matrices — otherwise "something changed" passes for "the ship's shadow".
 *
 * ── What is toggled, and why it differs by arm ──────────────────────────
 *
 * From OUTSIDE the ship `render.shipShadow` is inert: `shadowFlagsFor
 * ('ship-exterior')` is `cast: true` whenever the map is on, and the flag only
 * governs the colourless first-person draw. So the ground arm flips the
 * player hull MESH's `castShadow` — the player's, because four meshes carry
 * that name and the other three are AI racers whose flag is false. From the
 * SEAT the two edition flags are exactly the question, and they are set per
 * arm through `__ff2.edition.set`, the route the Advanced page takes.
 *
 * ── DEV-323: the near map, and why the DEV-306 arms pin it off ───────────
 *
 * The cockpit now shadows ITSELF through a second map over the ship
 * (`render/cockpit-self-shadow.ts`), and while it is on the shell's lookup
 * into the sun's map skips the ship's own occluders — which is what takes the
 * blob away, because the blob is the hull's closed canopy glass. So the
 * DEV-306 test pins `render.cockpitSelfShadow` OFF to keep measuring the blob
 * it was written for, and the third test photographs the shipped state: the
 * near map alone, the flag's effect, and the receive pair with and without
 * the skip. It also carries the positive shader check — draw calls, programs,
 * the tagged program's LINK_STATUS — because no gate here compiles a shader.
 *
 * ── Same build, same code path ───────────────────────────────────────────
 *
 * A viewpoint URL, the autopilot and `?snap=` are things the game does; the
 * toggles move fields on the objects the build made, through the dev handle
 * every photo spec here reads. `@gpu`, and PINNED (DEV-245): a tier drop moves
 * the shadow map, and a picture across a tier change is a picture of two
 * builds. Output goes to SHADOW_SHOT_DIR because Playwright wipes
 * `test-results/` at the start of every run.
 */

import fs from 'node:fs'
import path from 'node:path'
import { type HeightField, terrainHeightAt } from '@/sim/terrain/height-field'
import { blobStats, decodePng } from '../../tools/perf/png-diff.mjs'
import { encodePng } from '../../tools/terrain/png.mjs'
import { flyToFreeze } from './fixtures/freeze'
import { knownRed } from './fixtures/known-red'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import {
  describeConsoleFailure,
  describeFailedProgram,
  sweepPrograms,
  watchShaderConsole,
} from './fixtures/shader-link'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.SHADOW_SHOT_DIR ?? path.join('test-results', 'ship-shadow-air')

/**
 * GL errors the console reports that `classifyConsole` files under "webgl" and
 * does not fail on in `shader-link.spec.ts`. This spec has always failed on
 * them (it asserts the near map's draws are clean), so it keeps that and takes
 * the link-failure half, and the benign `Program Info Log`, from the fixture.
 */
const GL_ERROR_LINE = /GL_INVALID|INVALID_OPERATION|RENDER WARNING/i

/**
 * Alpine, on purpose. The sun is 46.5 degrees up, so a shadow lies 0.95 m
 * downsun per metre of altitude and lands beside the ship. On Simonet's
 * 4-degree sun it is 14 m per metre: a ship 50 m up casts 700 m away, at the
 * edge of the 700 m box, where no camera near the ship can see it.
 */
const MISSION = 'rookie_01_hoverJet'

/**
 * 17.3 s of mission time: 53 m over open meadow on the descent from ring 3,
 * the foot 25 m off and lit. Found by a probe that logged altitude, foot and
 * `sunlit` every half second of a flight; 4.0/4.5 s are lit but on the tree
 * line (~100 px), 20 s is 101 m up (15 px), 3.0 s is in the ridge's shade (0).
 */
const GROUND_TICK = 17.3

/**
 * 45 s: 38 m up, heading (0.86, -0.17, -0.48) with the sun behind, to
 * STARBOARD and above — the geometry that puts an airframe's shadow forward
 * onto its own dashboard, which is the interaction DEV-306 named and could not
 * measure. (This said "to port" until DEV-323 read the sun off the live ship:
 * toward-sun (0.57, 0.61, 0.54) in the ship's frame, where +x is starboard.)
 */
const SEAT_TICK = 45

type Vec = [number, number, number]

const level = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'content', 'levels', `${MISSION}.json`), 'utf8'),
) as { lighting: { sun: { direction: Vec } } }

/** The direction the light TRAVELS, unit, THREE space (as `viewpoints.ts` reads it). */
const sunDir: Vec = (() => {
  const d = level.lighting.sun.direction
  const n = Math.hypot(d[0], d[1], d[2])
  return [d[0] / n, d[1] / n, d[2] / n]
})()

/** The horizontal direction a shadow lies in, unit. */
const shadowDirH: [number, number] = (() => {
  const n = Math.hypot(sunDir[0], sunDir[2])
  return [sunDir[0] / n, sunDir[2] / n]
})()

/**
 * The LIVE collision surface, read out of the page once.
 *
 * Not `tests/unit/helpers/terrain-field.ts`: that helper reaches
 * `src/content/holo-palette.ts`'s `import.meta.glob` through
 * `game/terrain/load-terrain`, and one such edge in a spec's import graph
 * makes Playwright collect zero tests. The page already holds the field the
 * game collides against, and the sim's own `terrainHeightAt` samples it here.
 */
const readField = (page: Page): Promise<HeightField> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2?: { heightFields: () => { autopilot: readonly Record<string, unknown>[] } }
    }
    const f = w.__ff2?.heightFields().autopilot[0]
    if (!f) throw new Error('ship-shadow-air: no autopilot height field — the island is not in')
    return {
      vertPerSide: f.vertPerSide,
      heights: Array.from(f.heights as Float32Array),
      step: f.step,
      terrainSize: f.terrainSize,
      terrainHeight: f.terrainHeight,
      originX: f.originX,
      originY: f.originY,
      originZ: f.originZ,
      scaleX: f.scaleX,
      scaleY: f.scaleY,
      scaleZ: f.scaleZ,
    } as unknown as HeightField
  })

/** Ground under a THREE-space point. The field is SIM space: z mirrors. */
const groundAt = (field: HeightField, x: number, z: number): number => terrainHeightAt(field, x, -z)

/** Where the ship's shadow lands: walk the sun ray down to the surface. */
const shadowFoot = (field: HeightField, ship: Vec): { foot: Vec; altitude: number } => {
  const altitude = ship[1] - groundAt(field, ship[0], ship[2])
  let t = altitude / -sunDir[1]
  let foot: Vec = ship
  for (let i = 0; i < 6; i++) {
    foot = [ship[0] + sunDir[0] * t, ship[1] + sunDir[1] * t, ship[2] + sunDir[2] * t]
    t += (foot[1] - groundAt(field, foot[0], foot[2])) / -sunDir[1]
  }
  return { foot, altitude }
}

/**
 * Is a ground point in the sun? March up-sun over the field; a ridge higher
 * than the ray shades it. The premise check: a foot in shade cannot separate.
 */
const sunlit = (field: HeightField, foot: Vec): boolean => {
  for (let s = 4; s < 2200; s += 4) {
    const x = foot[0] - sunDir[0] * s
    const y = foot[1] - sunDir[1] * s + 1
    const z = foot[2] - sunDir[2] * s
    if (groundAt(field, x, z) > y) return false
  }
  return true
}

// ── page probes ──────────────────────────────────────────────────────────

interface Facts {
  elapsed: number
  frozen: boolean
  /** The player's body position, SIM space. */
  shipSim: Vec | null
  hull: {
    found: boolean
    cast: boolean | null
    colorWrite: boolean | null
    depthWrite: boolean | null
  }
  cockpit: { meshes: number; receive: boolean[] }
  shadowMapOn: boolean
  camera: { worldInverse: number[]; projection: number[] }
}

const facts = (page: Page): Promise<Facts> =>
  page.evaluate(() => {
    type O = {
      name?: string
      isMesh?: boolean
      castShadow?: boolean
      receiveShadow?: boolean
      material?: { colorWrite?: boolean; depthWrite?: boolean }
      parent?: O
      traverse?: (fn: (o: O) => void) => void
    }
    const w = globalThis as unknown as {
      __ff2?: {
        render: {
          scene: O
          renderer: { shadowMap: { enabled: boolean } }
          camera: {
            matrixWorldInverse: { elements: ArrayLike<number> }
            projectionMatrix: { elements: ArrayLike<number> }
          }
        }
        mission: { elapsed: number }
        snap: () => { frozen: boolean }
        flight: () => { jet: { body: { position: { x: number; y: number; z: number } } } } | null
      }
    }
    const h = w.__ff2
    if (!h) throw new Error('ship-shadow-air: no __ff2')
    // The PLAYER's hull: the AI racers load the same GLB (`game/racers.ts`),
    // so four meshes carry its name. The player's sits under `hoverjet`.
    const underPlayer = (o: O): boolean => {
      let n: O | undefined = o
      while (n) {
        if (n.name === 'hoverjet') return true
        n = n.parent
      }
      return false
    }
    const out: Facts = {
      elapsed: h.mission.elapsed,
      frozen: h.snap().frozen,
      shipSim: null,
      hull: { found: false, cast: null, colorWrite: null, depthWrite: null },
      cockpit: { meshes: 0, receive: [] },
      shadowMapOn: h.render.renderer.shadowMap.enabled,
      camera: {
        worldInverse: Array.from(h.render.camera.matrixWorldInverse.elements),
        projection: Array.from(h.render.camera.projectionMatrix.elements),
      },
    }
    const p = h.flight()?.jet.body.position
    if (p) out.shipSim = [p.x, p.y, p.z]
    let cockpitRoot: O | null = null
    h.render.scene.traverse?.((o) => {
      if (o.name === 'ship_ext_orange' && o.isMesh && underPlayer(o)) {
        out.hull = {
          found: true,
          cast: o.castShadow ?? null,
          colorWrite: o.material?.colorWrite ?? null,
          depthWrite: o.material?.depthWrite ?? null,
        }
      }
      if (o.name === 'ship_first_person' && underPlayer(o)) cockpitRoot = o
    })
    ;(cockpitRoot as O | null)?.traverse?.((o) => {
      if (!o.isMesh) return
      out.cockpit.meshes++
      out.cockpit.receive.push(o.receiveShadow === true)
    })
    return out
  })

/** Flip the player hull MESH's own `castShadow` — the arm for a camera outside the ship. */
const setHullCast = (page: Page, on: boolean): Promise<number> =>
  page.evaluate((cast) => {
    type O = { name?: string; isMesh?: boolean; castShadow?: boolean; parent?: O }
    const w = globalThis as unknown as {
      __ff2?: { render: { scene: { traverse(fn: (o: unknown) => void): void } } }
    }
    const underPlayer = (o: O): boolean => {
      let x: O | undefined = o
      while (x) {
        if (x.name === 'hoverjet') return true
        x = x.parent
      }
      return false
    }
    let n = 0
    w.__ff2?.render.scene.traverse((node) => {
      const o = node as O
      if (o.name === 'ship_ext_orange' && o.isMesh && underPlayer(o)) {
        o.castShadow = cast
        n++
      }
    })
    return n
  }, on)

/**
 * The three edition flags, through the route the Advanced page uses.
 *
 * `self` is REQUIRED rather than defaulted (DEV-323): the near map takes the
 * ship's own occluders out of the shell's lookup into the sun's map, so every
 * arm below means something different with it on — and a default would let
 * the DEV-306 arms quietly measure the shipped state instead of the blob.
 */
const setFlags = (
  page: Page,
  flags: { ship: boolean; cockpit: boolean; self: boolean },
): Promise<void> =>
  page.evaluate((f) => {
    const w = globalThis as unknown as {
      __ff2: { edition: { current: Record<string, unknown>; setPreset: (e: unknown) => void } }
    }
    const e = structuredClone(w.__ff2.edition.current) as Record<string, unknown>
    const render = e.render as Record<string, Record<string, unknown>>
    render.shipShadow = { ...render.shipShadow, enabled: f.ship }
    render.cockpitShadow = { ...render.cockpitShadow, enabled: f.cockpit }
    render.cockpitSelfShadow = { ...render.cockpitSelfShadow, enabled: f.self }
    w.__ff2.edition.setPreset(e)
  }, flags)

/**
 * The near map's own report, off the shell it shadows (`userData`, DEV-323) —
 * the PLAYER's shell, for the same four-meshes reason as the hull.
 */
interface NearReport {
  on: boolean
  patched: number
  casters: number
  calls: number
  triangles: number
  passes: number
  radius: number
  texelSize: number
  skipMetres: number
  skipNormalised: number
  mapSize: number
}

const nearReport = (page: Page): Promise<NearReport | null> =>
  page.evaluate(() => {
    type O = {
      name?: string
      parent?: O
      userData?: Record<string, unknown>
      traverse?: (fn: (o: O) => void) => void
    }
    const w = globalThis as unknown as { __ff2?: { render: { scene: O } } }
    let found: (() => NearReport) | null = null
    w.__ff2?.render.scene.traverse?.((o) => {
      let n: O | undefined = o
      let player = false
      while (n) {
        if (n.name === 'hoverjet') player = true
        n = n.parent
      }
      const fn = o.userData?.cockpitSelfShadow
      if (o.name === 'ship_first_person' && player && typeof fn === 'function') {
        found = fn as () => NearReport
      }
    })
    return found ? (found as () => NearReport)() : null
  })

// ── frames and statistics ────────────────────────────────────────────────

interface Frame {
  readonly w: number
  readonly h: number
  readonly ch: number
  readonly data: Uint8Array
}

const shoot = async (page: Page, name: string): Promise<Frame> => {
  fs.mkdirSync(OUT, { recursive: true })
  const buf = await page.locator('#viewport').screenshot({ path: path.join(OUT, `${name}.png`) })
  return decodePng(buf) as Frame
}

/** Per-pixel "moved by more than 24 levels on some channel" — png-diff's bar. */
const movedMask = (x: Frame, y: Frame): Uint8Array => {
  if (x.w !== y.w || x.h !== y.h) throw new Error('ship-shadow-air: frame sizes differ')
  const keep = new Uint8Array(x.w * x.h)
  const rgb = Math.min(3, x.ch, y.ch)
  for (let p = 0; p < x.w * x.h; p++) {
    let d = 0
    for (let k = 0; k < rgb; k++) {
      d = Math.max(d, Math.abs((x.data[p * x.ch + k] as number) - (y.data[p * y.ch + k] as number)))
    }
    keep[p] = d > 24 ? 1 : 0
  }
  return keep
}

const subtract = (signal: Uint8Array, control: Uint8Array): Uint8Array => {
  const out = new Uint8Array(signal.length)
  for (let p = 0; p < signal.length; p++) out[p] = signal[p] && !control[p] ? 1 : 0
  return out
}

interface Blob {
  size: number
  x0: number
  y0: number
  x1: number
  y1: number
  cx: number
  cy: number
}

/** The largest 4-connected component of a mask, with its box and centroid. */
const largestBlob = (keep: Uint8Array, w: number, h: number): Blob | null => {
  const n = w * h
  const seen = new Uint8Array(n)
  const stack = new Int32Array(n)
  let best: Blob | null = null
  for (let start = 0; start < n; start++) {
    if (!keep[start] || seen[start]) continue
    let top = 0
    stack[top++] = start
    seen[start] = 1
    const b: Blob = { size: 0, x0: w, y0: h, x1: -1, y1: -1, cx: 0, cy: 0 }
    while (top > 0) {
      const p = stack[--top] as number
      const x = p % w
      const y = (p - x) / w
      b.size++
      b.cx += x
      b.cy += y
      if (x < b.x0) b.x0 = x
      if (x > b.x1) b.x1 = x
      if (y < b.y0) b.y0 = y
      if (y > b.y1) b.y1 = y
      if (x > 0 && keep[p - 1] && !seen[p - 1]) {
        seen[p - 1] = 1
        stack[top++] = p - 1
      }
      if (x + 1 < w && keep[p + 1] && !seen[p + 1]) {
        seen[p + 1] = 1
        stack[top++] = p + 1
      }
      if (p >= w && keep[p - w] && !seen[p - w]) {
        seen[p - w] = 1
        stack[top++] = p - w
      }
      if (p + w < n && keep[p + w] && !seen[p + w]) {
        seen[p + w] = 1
        stack[top++] = p + w
      }
    }
    b.cx /= b.size
    b.cy /= b.size
    if (!best || b.size > best.size) best = b
  }
  return best
}

/** Share of the moved pixels in the lower half of the frame — the dashboard, from the seat. */
const lowerShare = (keep: Uint8Array, w: number, h: number): number => {
  let moved = 0
  let lower = 0
  for (let p = 0; p < keep.length; p++) {
    if (!keep[p]) continue
    moved++
    if (Math.floor(p / w) >= h / 2) lower++
  }
  return moved ? lower / moved : 0
}

interface PairStats {
  moved: number
  largest: number
  share: number
  blob: Blob | null
  lower: number
}

const statsOf = (keep: Uint8Array, w: number, h: number): PairStats => {
  const s = blobStats(keep, w, h)
  if (!s) throw new Error('ship-shadow-air: blobStats refused the mask')
  return {
    moved: s.moved,
    largest: s.largest,
    share: s.moved / (w * h),
    blob: largestBlob(keep, w, h),
    lower: lowerShare(keep, w, h),
  }
}

const fmt = (label: string, s: PairStats): string => {
  const b = s.blob
  const box = b
    ? `box ${b.x0},${b.y0}-${b.x1},${b.y1} centre ${b.cx.toFixed(0)},${b.cy.toFixed(0)}`
    : 'no blob'
  return (
    `  ${label.padEnd(44)} ${String(s.moved).padStart(7)} px (${(s.share * 100).toFixed(3)} %)` +
    `  largest ${String(s.largest).padStart(6)}  ${box}  lower-half ${(s.lower * 100).toFixed(0)} %`
  )
}

/** The ON frame dimmed, signal pixels red, control pixels blue. */
const saveDiff = (name: string, base: Frame, signal: Uint8Array, control: Uint8Array): void => {
  const data = new Uint8Array(base.w * base.h * 3)
  for (let p = 0; p < base.w * base.h; p++) {
    data[p * 3] = signal[p] ? 255 : (base.data[p * base.ch] as number) * 0.4
    data[p * 3 + 1] = (base.data[p * base.ch + 1] as number) * 0.4
    data[p * 3 + 2] = control[p] ? 255 : (base.data[p * base.ch + 2] as number) * 0.4
  }
  fs.writeFileSync(
    path.join(OUT, `${name}.png`),
    encodePng({ width: base.w, height: base.h, channels: 3, data }),
  )
}

/** THREE-space point → screenshot pixel, through the camera's own matrices. */
const project = (p: Vec, cam: Facts['camera'], w: number, h: number): { x: number; y: number } => {
  const mul = (
    e: number[],
    v: [number, number, number, number],
  ): [number, number, number, number] => [
    (e[0] as number) * v[0] +
      (e[4] as number) * v[1] +
      (e[8] as number) * v[2] +
      (e[12] as number) * v[3],
    (e[1] as number) * v[0] +
      (e[5] as number) * v[1] +
      (e[9] as number) * v[2] +
      (e[13] as number) * v[3],
    (e[2] as number) * v[0] +
      (e[6] as number) * v[1] +
      (e[10] as number) * v[2] +
      (e[14] as number) * v[3],
    (e[3] as number) * v[0] +
      (e[7] as number) * v[1] +
      (e[11] as number) * v[2] +
      (e[15] as number) * v[3],
  ]
  const clip = mul(cam.projection, mul(cam.worldInverse, [p[0], p[1], p[2], 1]))
  return { x: ((clip[0] / clip[3] + 1) / 2) * w, y: ((1 - clip[1] / clip[3]) / 2) * h }
}

const toThree = (sim: Vec): Vec => [sim[0], sim[1], -sim[2]]
const t3 = (v: Vec) => v.map((n) => n.toFixed(1)).join(',')

const pinHeld = async (
  page: Page,
  start: Promise<Awaited<ReturnType<typeof drawState>>>,
): Promise<void> => {
  const drift = drawStateDiff(await start, await drawState(page))
  expect(drift, `the tier moved mid-run: ${drift.join(', ')}`).toEqual([])
}

const pinned = Object.fromEntries(new URLSearchParams(PINNED))

test.describe('@gpu the ship in the air: it casts, and the cockpit receives', () => {
  test.setTimeout(420_000)

  test("the hull's shadow is on the ground beside the ship (DEV-305)", async ({ page }) => {
    knownRed('KR-06')
    // Pointer lock is refused on an unfocused document, and parallel headed
    // workers guarantee one. The harness doing what a player does.
    await page.bringToFront()

    // Stage 1: freeze at the tick in the seat and read where the ship is, so
    // the camera is computed from the tick rather than typed from a table.
    await flyToFreeze(page, {
      mission: MISSION,
      edition: 'anniversary',
      snapAt: GROUND_TICK,
      settleMs: 500,
      params: pinned,
    })
    const f1 = await facts(page)
    const field = await readField(page)
    if (!f1.shipSim) throw new Error('ship-shadow-air: no flight at the freeze')
    const ship = toThree(f1.shipSim)
    const { foot, altitude } = shadowFoot(field, ship)
    // The premise, checked: a foot in shade cannot separate, and a small
    // number from a shaded foot is not a small shadow.
    expect(
      sunlit(field, foot),
      `the foot at ${t3(foot)} is in a ridge's shade — pick another tick`,
    ).toBe(true)
    // Perpendicular to the shadow's lie, so ship and foot sit side by side;
    // high, so the ground is seen at ~45 degrees and a tree hides less of it;
    // aimed at the midpoint, so both are near the centre.
    const perp: [number, number] = [-shadowDirH[1], shadowDirH[0]]
    const mid: Vec = [(ship[0] + foot[0]) / 2, (ship[1] + foot[1]) / 2, (ship[2] + foot[2]) / 2]
    const range = Math.max(
      45,
      1.4 * Math.hypot(foot[0] - ship[0], foot[1] - ship[1], foot[2] - ship[2]),
    )
    const eye = t3([mid[0] + perp[0] * range, mid[1] + range * 0.9, mid[2] + perp[1] * range])
    const look = t3(mid)

    // Stage 2: the same tick from the fixed camera. The autopilot is
    // deterministic on the fixed step (DEV-027), so the two loads agree.
    // (`?view=cam` draws the cockpit shell at the ship, not the hull:
    // `thirdPersonLive` needs `wantsFly`. The hull casts colourless, which is
    // DEV-305's whole mechanism, so the measurement does not care.)
    await flyToFreeze(page, {
      mission: MISSION,
      edition: 'anniversary',
      snapAt: GROUND_TICK,
      params: { view: 'cam', eye, look, ...pinned },
    })
    const pin = drawState(page)
    await page.waitForTimeout(1_500)
    const f0 = await facts(page)
    expect(f0.frozen, 'the sim is frozen').toBe(true)
    expect(f0.hull.found, "the player's hull mesh is in the scene").toBe(true)
    expect(f0.shadowMapOn, 'the shadow map is on').toBe(true)
    expect(f0.hull.cast, 'the hull casts before the arm starts').toBe(true)

    expect(await setHullCast(page, false), "one hull mesh — the player's").toBe(1)
    await page.waitForTimeout(500)
    const off = await shoot(page, 'ground-off')
    await setHullCast(page, true)
    await page.waitForTimeout(500)
    const on = await shoot(page, 'ground-on')
    await page.waitForTimeout(500)
    const again = await shoot(page, 'ground-on-control')

    const signal = movedMask(off, on)
    const control = movedMask(on, again)
    const shadow = subtract(signal, control)
    saveDiff('ground-diff', on, shadow, control)
    const raw = statsOf(signal, off.w, off.h)
    const ctl = statsOf(control, off.w, off.h)
    const s = statsOf(shadow, off.w, off.h)
    const footPx = project(foot, f0.camera, off.w, off.h)
    const shipPx = project(ship, f0.camera, off.w, off.h)
    console.info(
      `\nship-shadow-air · ground, ${MISSION} at ${GROUND_TICK} s (elapsed ${f0.elapsed.toFixed(2)}), ${drawStateLine(await pin)}\n` +
        `  ship ${t3(ship)}, ${altitude.toFixed(1)} m over the ground; foot ${t3(foot)}, lit; eye ${eye} look ${look}\n` +
        `  on screen: ship ${shipPx.x.toFixed(0)},${shipPx.y.toFixed(0)}  foot ${footPx.x.toFixed(0)},${footPx.y.toFixed(0)}\n` +
        `${fmt('off->on', raw)}\n${fmt('control (on->on)', ctl)}\n${fmt('THE SHADOW', s)}\n  frames in ${path.resolve(OUT)}`,
    )

    // 2026-09-23 measured 951 px moved, largest 787 (30 x 42), control 366/15,
    // the patch 71 px from the projected foot. The bars sit well under those:
    // a mote crossing the patch in the control can split it, and a split patch
    // is still the shadow.
    expect(s.moved, 'the shadow moves pixels after its control is subtracted').toBeGreaterThan(500)
    expect(s.largest, 'one connected patch of shadow, not scattered noise').toBeGreaterThan(300)
    expect(s.moved / Math.max(1, raw.moved), 'the shadow survives its own control').toBeGreaterThan(
      0.2,
    )
    const b = s.blob
    expect(b, 'a largest patch exists').not.toBeNull()
    const off_px = Math.hypot((b as Blob).cx - footPx.x, (b as Blob).cy - footPx.y)
    expect(
      off_px,
      `the largest patch is ${off_px.toFixed(0)} px from the predicted foot — something else changed`,
    ).toBeLessThan(150)
    await pinHeld(page, pin)
  })

  test("from the seat: the airframe's shadow across the dashboard, four ways (DEV-306)", async ({
    page,
  }) => {
    knownRed('KR-07')
    await page.bringToFront()
    await flyToFreeze(page, {
      mission: MISSION,
      edition: 'anniversary',
      snapAt: SEAT_TICK,
      params: pinned,
    })
    const pin = drawState(page)
    await page.waitForTimeout(1_500)
    const f0 = await facts(page)
    expect(f0.frozen, 'the sim is frozen').toBe(true)
    expect(f0.cockpit.meshes, 'the cockpit shell has meshes').toBeGreaterThan(0)
    expect(f0.shadowMapOn, 'the shadow map is on').toBe(true)

    // Every arm pins the near map OFF (DEV-323). The blob this test measures
    // is the shell receiving the hull's canopy glass through the SUN's map, and
    // the near map removes exactly that on purpose — so with it on, this test
    // would be measuring the fix instead of the thing look call 6 was about.
    // The shipped state is the next test's.
    const arms = [
      { name: 'both', ship: true, cockpit: true },
      { name: 'receiveOff', ship: true, cockpit: false },
      { name: 'castOff', ship: false, cockpit: true },
      { name: 'neither', ship: false, cockpit: false },
      { name: 'both-again', ship: true, cockpit: true },
    ] as const
    const frames: Partial<Record<(typeof arms)[number]['name'], Frame>> = {}
    const flagLines: string[] = []
    for (const arm of arms) {
      await setFlags(page, { ship: arm.ship, cockpit: arm.cockpit, self: false })
      await page.waitForTimeout(1_200)
      const f = await facts(page)
      flagLines.push(
        `  ${arm.name.padEnd(12)} hull cast=${f.hull.cast} cw=${f.hull.colorWrite} dw=${f.hull.depthWrite}` +
          `  cockpit receive=[${f.cockpit.receive.join(',')}]`,
      )
      // The flags reached the meshes, or the frames are of nothing. The shell
      // receives exactly when asked; the hull is colourless exactly when it
      // is in the map from the seat (DEV-305), and drawn again when it is not.
      expect(
        f.cockpit.receive.every((r) => r === arm.cockpit),
        `${arm.name}: the shell's receive flag`,
      ).toBe(true)
      expect(
        f.hull.colorWrite,
        `${arm.name}: the hull's colour write follows render.shipShadow`,
      ).toBe(!arm.ship)
      expect(
        f.hull.depthWrite,
        `${arm.name}: the hull's depth write follows render.shipShadow`,
      ).toBe(!arm.ship)
      frames[arm.name] = await shoot(page, `seat-${arm.name}`)
    }
    const F = frames as Record<(typeof arms)[number]['name'], Frame>
    const control = movedMask(F.both, F['both-again'])
    const pair = (a: Frame, b: Frame, tag: string): PairStats => {
      const clean = subtract(movedMask(a, b), control)
      saveDiff(`seat-diff-${tag}`, a, clean, control)
      return statsOf(clean, a.w, a.h)
    }
    const withHull = pair(F.both, F.receiveOff, 'receive-with-hull')
    const withoutHull = pair(F.castOff, F.neither, 'receive-without-hull')
    const hullCast = pair(F.both, F.castOff, 'hull-cast-from-seat')
    console.info(
      `\nship-shadow-air · seat, ${MISSION} at ${SEAT_TICK} s (elapsed ${f0.elapsed.toFixed(2)}), ${drawStateLine(await pin)}\n` +
        `${flagLines.join('\n')}\n${fmt('control (both->both)', statsOf(control, F.both.w, F.both.h))}\n` +
        `${fmt('receive, hull casting (both->receiveOff)', withHull)}\n` +
        `${fmt('receive, hull NOT casting (castOff->neither)', withoutHull)}\n` +
        `${fmt('the hull cast, from the seat (both->castOff)', hullCast)}\n  frames in ${path.resolve(OUT)}`,
    )

    // 2026-09-23: 13,444 connected px with the hull casting against 489
    // without, 97 % of them in the lower half — the airframe's shadow across
    // the nose is the whole of what receiving shows in open sun, and it is
    // NEXT.md's look call 6. The relationship is what is pinned, not the size.
    //
    // **DEV-328 shrank it ~8x, and that is the fix, not a regression.** Most of
    // that blob was the INSIDE-OUT hull: three picks the faces a mesh casts
    // from its winding, and the inverted canopy glass cast a sheet across the
    // nose. With the winding corrected the largest patch reads 1,451-1,665 px,
    // a strip along the bottom edge (box y 697-719 of 720), against 406-520
    // without the hull. So the second assertion judges WHERE THE PATCH IS, not
    // the share of every moved pixel: at this size the noise pixels the control
    // does not cancel are a fifth of the mask, and the old share bound (0.8)
    // read 0.79 and 0.90 on two runs of one build.
    expect(
      withHull.largest,
      "with the hull casting, receiving changes the dashboard more than the world's shadows do",
    ).toBeGreaterThan(withoutHull.largest)
    expect(
      withHull.blob?.cy ?? 0,
      "the hull's shadow lands on the dashboard, in the lower half",
    ).toBeGreaterThan(F.both.h / 2)

    // Back to the shipped flags before the pin is read, so the last frame is the build.
    await setFlags(page, { ship: true, cockpit: true, self: true })
    await pinHeld(page, pin)
  })

  test('from the seat: the canopy bars across the console, and the blob gone (DEV-323)', async ({
    page,
  }) => {
    knownRed('KR-08')
    // Every console line from the first byte, because a program that fails to
    // link says so ONCE, at compile, and the compile is under the curtain.
    const shaderConsole = watchShaderConsole(page)

    await page.bringToFront()
    await flyToFreeze(page, {
      mission: MISSION,
      edition: 'anniversary',
      snapAt: SEAT_TICK,
      params: pinned,
    })
    const pin = drawState(page)
    await page.waitForTimeout(1_500)
    const f0 = await facts(page)
    expect(f0.frozen, 'the sim is frozen').toBe(true)
    expect(f0.shadowMapOn, 'the sun map is on').toBe(true)

    // ── the pass exists, at the shipped flags, and costs what it says ──────
    const shipped = await nearReport(page)
    expect(shipped, "the shell carries the near map's report").not.toBeNull()
    const r = shipped as NearReport
    expect(r.on, 'the near map is on at the shipped flags').toBe(true)
    expect(r.passes, 'and has drawn').toBeGreaterThan(0)
    expect(r.patched, 'one material: the shell').toBe(1)
    expect(r.casters, 'one caster: the shell, never the hull').toBe(1)
    // Counts OF A FRAME (AGENT-NOTES §1): immune to a busy box.
    expect(r.calls, 'the pass is one draw call').toBe(1)
    expect(r.triangles, "the pass is the shell's triangles").toBe(1182)
    expect(r.radius).toBeCloseTo(3.382, 2)

    // ── no gate compiles a shader: the positive check, then the absence ───
    // `sweepPrograms` asks GL for LINK_STATUS of EVERY program three holds (the
    // near map's own, tagged `cockpit-self-shadow` in the cache key, are among
    // them), and the console is classified by three's exact prefixes, so a
    // linked program's benign `Program Info Log` (HLSL X4122) is not a failure.
    const gl = await sweepPrograms(page)
    expect(gl.calls, 'the frame drew').toBeGreaterThan(0)
    expect(gl.programs, 'programs exist').toBeGreaterThan(0)
    const nearKeys = gl.keys.filter((k) => k.includes('cockpit-self-shadow'))
    expect(nearKeys.length, 'a program carries the near map').toBeGreaterThan(0)
    expect(gl.failed.map(describeFailedProgram), 'every program three holds linked').toEqual([])
    const bad = [
      ...shaderConsole
        .lines()
        .filter((l) => l.kind === 'link-failure' || GL_ERROR_LINE.test(l.text))
        .map((l) => describeConsoleFailure(l.text)),
      ...shaderConsole.pageErrors().map((e) => `pageerror: ${e}`),
    ]
    expect(bad, 'shader or GL errors in the console').toEqual([])

    // ── the arms ─────────────────────────────────────────────────────────
    //
    // `near-only` against `neither` is the near map ALONE: nothing of the
    // sun's map reaches the shell in either. `shipped` against `blob` is what
    // the flag changes in the build. And the receive pairs with and without
    // the near map are the claim about the SKIP: with it on, the hull's glass
    // no longer paints the dashboard through the sun's map.
    const arms = [
      { name: 'shipped', ship: true, cockpit: true, self: true },
      { name: 'blob', ship: true, cockpit: true, self: false },
      { name: 'near-only', ship: false, cockpit: false, self: true },
      { name: 'neither', ship: false, cockpit: false, self: false },
      { name: 'shipped-receiveOff', ship: true, cockpit: false, self: true },
      { name: 'blob-receiveOff', ship: true, cockpit: false, self: false },
      { name: 'shipped-again', ship: true, cockpit: true, self: true },
    ] as const
    const frames: Partial<Record<(typeof arms)[number]['name'], Frame>> = {}
    const lines: string[] = []
    for (const arm of arms) {
      await setFlags(page, { ship: arm.ship, cockpit: arm.cockpit, self: arm.self })
      await page.waitForTimeout(1_200)
      const nr = await nearReport(page)
      lines.push(
        `  ${arm.name.padEnd(20)} near on=${nr?.on} passes=${nr?.passes} skip=${nr?.skipMetres.toFixed(3)} m`,
      )
      expect(nr?.on, `${arm.name}: the flag reached the pass`).toBe(arm.self)
      frames[arm.name] = await shoot(page, `near-${arm.name}`)
    }
    const F = frames as Record<(typeof arms)[number]['name'], Frame>
    const control = movedMask(F.shipped, F['shipped-again'])
    const pair = (a: Frame, b: Frame, tag: string): PairStats => {
      const clean = subtract(movedMask(a, b), control)
      saveDiff(`near-diff-${tag}`, a, clean, control)
      return statsOf(clean, a.w, a.h)
    }
    const nearAlone = pair(F['near-only'], F.neither, 'near-map-alone')
    const shippedVsBlob = pair(F.shipped, F.blob, 'shipped-vs-blob')
    const receiveWithNear = pair(F.shipped, F['shipped-receiveOff'], 'receive-with-near')
    const receiveWithout = pair(F.blob, F['blob-receiveOff'], 'receive-without-near')
    console.info(
      `\nship-shadow-air · near map, ${MISSION} at ${SEAT_TICK} s (elapsed ${f0.elapsed.toFixed(2)}), ${drawStateLine(await pin)}\n` +
        `  pass: ${r.calls} call, ${r.triangles} triangles, ${r.casters} caster, r=${r.radius.toFixed(3)} m, ` +
        `texel ${(r.texelSize * 1000).toFixed(2)} mm at ${r.mapSize}, skip ${r.skipMetres.toFixed(3)} m ` +
        `(${r.skipNormalised.toExponential(3)} of the sun map)\n` +
        `  frame: ${gl.calls} calls, ${gl.triangles} triangles, ${gl.programs} programs; near-map programs ` +
        `${nearKeys.length}, ${gl.linked} of ${gl.programs} linked; ${shaderConsole.lines().length} console lines, ${bad.length} bad\n` +
        `${lines.join('\n')}\n${fmt('control (shipped->shipped)', statsOf(control, F.shipped.w, F.shipped.h))}\n` +
        `${fmt('the near map alone (near-only->neither)', nearAlone)}\n` +
        `${fmt('the flag, shipped (shipped->blob)', shippedVsBlob)}\n` +
        `${fmt('receive, near map ON (skip)', receiveWithNear)}\n` +
        `${fmt('receive, near map OFF (the blob)', receiveWithout)}\n  frames in ${path.resolve(OUT)}`,
    )

    // The near map moves the dashboard on its own, and the moved pixels are
    // the cockpit's — the lower half, from the seat.
    expect(nearAlone.moved, 'the near map alone moves pixels').toBeGreaterThan(1_000)
    expect(nearAlone.lower, 'on the dashboard, in the lower half').toBeGreaterThan(0.6)
    // The skip: with the near map on, receiving the sun's map no longer puts
    // the hull's glass on the shell.
    //
    // This was a RATIO, `< 0.25 x` the blob, and DEV-328 took away its
    // premise: with the hull's winding fixed, the blob it measured is a
    // 1,700 px strip along the bottom edge rather than an 11,470 px sheet, so a
    // quarter of it (425) is inside the control's own noise (largest patch
    // 311), and the near-on arm's largest patch (498) was a noise speck mid
    // frame. What still separates is WHERE: without the near map the hull's
    // shadow is the strip at the nose's bottom edge (DEV-306's seat test pins
    // the same strip), and with it the strip is gone.
    const edge = F.shipped.h * 0.9
    expect(
      receiveWithout.blob?.cy ?? 0,
      "without the near map, the hull's shadow is the strip along the bottom edge",
    ).toBeGreaterThan(edge)
    expect(
      receiveWithNear.blob?.cy ?? 0,
      "with the near map on, the sun's map no longer paints the hull on the shell",
    ).toBeLessThan(edge)
    expect(receiveWithNear.largest, 'and what is left is smaller').toBeLessThan(
      receiveWithout.largest,
    )

    // ── the cost in milliseconds, ONLY on a quiet box and only when asked ──
    //
    // A duration taken while anything else drives the GPU is a reading of the
    // other thing (AGENT-NOTES §1), so this is off unless `NEAR_GPU_MS=1`, and
    // `E2E_NO_VSYNC=1` takes the vsync ceiling off the GPU timer the way
    // `perf-fill.spec.ts` needs it. Alternating arms, because a single baseline
    // drifts. One 1280x720 frame of fragment work, not a worn eye: the pass
    // itself is resolution-free, and the nine taps scale with the pixels the
    // shell covers.
    if (process.env.NEAR_GPU_MS === '1') {
      const gpuMedian = async (): Promise<number | null> => {
        type Gpu = {
          supported: boolean
          enable: () => void
          reset: () => void
          stats: () => { medianMs: number; frames: number }
        }
        const ok = await page.evaluate(() => {
          const h = (globalThis as unknown as { __ff2: { gpu: Gpu } }).__ff2.gpu
          h.enable()
          return h.supported
        })
        if (!ok) return null
        // perf-fill's retry: a busy GPU drops queries on GPU_DISJOINT, and a
        // window that comes back short must read n/a, never 0.00. The first
        // contended run of this block read n/a on four arms of five.
        for (let attempt = 0; attempt < 3; attempt++) {
          await page.evaluate(() =>
            (globalThis as unknown as { __ff2: { gpu: Gpu } }).__ff2.gpu.reset(),
          )
          await page.waitForTimeout(3_000 * (attempt + 1))
          const s = await page.evaluate(() =>
            (globalThis as unknown as { __ff2: { gpu: Gpu } }).__ff2.gpu.stats(),
          )
          if (s.frames >= 30) return s.medianMs
        }
        return null
      }
      const readings: string[] = []
      for (const self of [true, false, true, false, true]) {
        await setFlags(page, { ship: true, cockpit: true, self })
        await page.waitForTimeout(1_500)
        const ms = await gpuMedian()
        readings.push(`${self ? 'on ' : 'off'} ${ms === null ? 'n/a' : ms.toFixed(3)}`)
      }
      console.info(
        `\nship-shadow-air · near map GPU ms (median, 3 s each): ${readings.join(' · ')}`,
      )
    }

    await setFlags(page, { ship: true, cockpit: true, self: true })
    await pinHeld(page, pin)
  })
})
