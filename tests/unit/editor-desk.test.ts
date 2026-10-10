// tests/unit/editor-desk.test.ts — the desktop course editor's node-testable
// half. DEV-469.
//
// What is held here:
//
//  1. DESK_POLICY, pinned by value (the HUD_RASTER_SHIPPED pattern).
//  2. A new point's height is DERIVED from the sky, and it does what it claims:
//     the sky's ring, centred on it over flat ground, clears the ground by the
//     core's clearance — on every HoverJet sky.
//  3. The RENDER surface in the level frame, against an outside oracle: the
//     chunk geometry the renderer draws (`chunkGeometry`, z flip and all), put
//     under a group that is offset AND scaled as the sea's is, read back as
//     world triangles. Not a re-derivation of the conversion `ground.ts` does.
//  4. Picking and keys, pure.
//  5. The camera frames the play area: the framed sphere fits the view.
//  6. The desk is LAZY: `boot/app.ts` reaches `src/editor/desk/` by a dynamic
//     import only, so the game's entry chunk cannot carry it.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { type Level, liveRings } from '@/content/level-schema'
import { playerCourseArea } from '@/content/player-course'
import { groundClearance } from '@/editor/core'
import { areaSphere, frameDistance } from '@/editor/desk/camera'
import {
  anglesOf,
  type FlyAngles,
  flyForward,
  flyLook,
  flyQuaternion,
  flyReleaseTarget,
  flyRight,
  flySpeed,
  flyStep,
  flyWheel,
} from '@/editor/desk/fly'
import { deskGround, landAndSea, terrainSurface } from '@/editor/desk/ground'
import { LEAVE_WORDS, leaveAsks } from '@/editor/desk/leave'
import { deskKeyAction, nearestOnPolyline, nearestWithin } from '@/editor/desk/pick'
import { DESK_CAMERA_POLICY, DESK_POLICY, deskNear, placeHeightFor } from '@/editor/desk/policy'
import { START_PAD_POLICY } from '@/editor/desk/start-pad'
import {
  DESK_KEY_LIST,
  DESK_TOOLS,
  type DeskPicked,
  gizmoFor,
  TOOL_KEYS,
  toolNote,
  uniformScaleOf,
} from '@/editor/desk/tools'
import type { LoadedTerrain } from '@/game/terrain/load-terrain'
import {
  MAKE_A_COURSE_ACTION,
  MAKE_A_COURSE_PHONE_ACTION,
  OPEN_COURSE_FILE_ACTION,
  shelfItems,
} from '@/render/course-shelf'
import { chunkGeometry } from '@/render/terrain-mesh'
import {
  buildVertexGrid,
  type FacetedTerrainParams,
  generateChunk,
  type MapSampler,
} from '@/sim/terrain/faceted'
import type { Rgb } from '@/sim/terrain/image-sampler'
import { appSource } from './helpers/app-source'
import { shippedLevels } from './helpers/content'
import { REPO } from './helpers/repo-root'
import { lcg } from './helpers/seeded'

const shipped: Level[] = shippedLevels()
const hoverjets = shipped.filter((l) => l.vehicle === 'hoverjet')

describe('DESK_POLICY', () => {
  it('is pinned by value: moving one is an edit made on purpose', () => {
    expect(DESK_POLICY).toEqual({
      pickPixels: 14,
      linePixels: 7,
      clickSlopPixels: 5,
      handleScreenFraction: 0.012,
      autosaveMs: 400,
      ringRebuildMs: 200,
      dragEvaluateMs: 120,
      fovDegrees: 50,
      frameMargin: 1.15,
      frameElevationDegrees: 50,
      maxPolarDegrees: 85,
    })
  })
  it('reaches a handle further than it reaches the line, so a click beside a handle picks it', () => {
    expect(DESK_POLICY.pickPixels).toBeGreaterThan(DESK_POLICY.linePixels)
  })
  it('DEV-475: the start pad’s overlay, pinned by value', () => {
    expect(START_PAD_POLICY).toEqual({ arrowHandles: 9, handleHandles: 1.6 })
  })
})

describe('the height a new point sits at', () => {
  it('is derived from each HoverJet sky, and its ring clears flat ground by the clearance', () => {
    expect(hoverjets.length).toBe(7)
    for (const sky of hoverjets) {
      const h = placeHeightFor(sky)
      const opening = (liveRings(sky)[0] as { trigger: { radius: number } }).trigger.radius
      // The ring's lowest point over flat ground, less the clearance: not negative.
      expect(h - opening - groundClearance(), sky.id).toBeGreaterThanOrEqual(0)
      // And no more than a metre over it: the least such height, not a guess.
      expect(h - opening - groundClearance(), sky.id).toBeLessThan(1)
    }
  })
})

// ── the render surface, in the level frame ───────────────────────────────

const relief = (u: number, v: number): number =>
  0.5 + 0.25 * Math.sin(u * 23.1 + 1.3) * Math.cos(v * 17.7 - 0.4) + 0.15 * Math.sin((u + v) * 41)
const mapOf = (f: (u: number, v: number) => number): MapSampler =>
  ({
    width: 128,
    height: 128,
    sample(u: number, v: number, out: Rgb): Rgb {
      const g = Math.min(1, Math.max(0, f(u, v)))
      out.r = g
      out.g = g
      out.b = g
      return out
    },
  }) as unknown as MapSampler
const PARAMS: FacetedTerrainParams = {
  terrainSize: 512,
  terrainHeight: 200,
  chunkSize: 128,
  baseResolution: 8,
  randomOffset: 1.3,
  seed: 20160101,
}
/** A terrain as `load-terrain.ts` leaves one: a group, offset and scaled, holding drawn chunks. */
const fakeTerrain = (
  position: [number, number, number],
  scale: number,
  f: (u: number, v: number) => number,
): { terrain: LoadedTerrain; drawn: THREE.Mesh[] } => {
  const height = mapOf(f)
  const colour = mapOf(() => 0.5)
  const grid = buildVertexGrid(height, PARAMS)
  const group = new THREE.Group()
  group.position.set(...position)
  group.scale.setScalar(scale)
  const drawn: THREE.Mesh[] = []
  for (let cy = 0; cy < 4; cy++) {
    for (let cx = 0; cx < 4; cx++) {
      const mesh = new THREE.Mesh(
        chunkGeometry(generateChunk(grid, colour, height, PARAMS, cx, cy)),
      )
      group.add(mesh)
      drawn.push(mesh)
    }
  }
  group.updateMatrixWorld(true)
  const terrain = {
    group,
    surfaceGrid: grid,
    heightMap: height,
    params: PARAMS,
  } as unknown as LoadedTerrain
  return { terrain, drawn }
}

/** The ORACLE: the height of the drawn triangle over world (x, z), from the geometry as drawn. */
const drawnHeightAt = (drawn: readonly THREE.Mesh[], x: number, z: number): number | null => {
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  for (const mesh of drawn) {
    const pos = mesh.geometry.getAttribute('position')
    for (let t = 0; t + 2 < pos.count; t += 3) {
      a.fromBufferAttribute(pos, t).applyMatrix4(mesh.matrixWorld)
      b.fromBufferAttribute(pos, t + 1).applyMatrix4(mesh.matrixWorld)
      c.fromBufferAttribute(pos, t + 2).applyMatrix4(mesh.matrixWorld)
      if (a.y === b.y && b.y === c.y && a.y === mesh.matrixWorld.elements[13]) continue
      const det = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)
      if (Math.abs(det) < 1e-9) continue
      const wb = ((x - a.x) * (c.z - a.z) - (c.x - a.x) * (z - a.z)) / det
      const wc = ((b.x - a.x) * (z - a.z) - (x - a.x) * (b.z - a.z)) / det
      const wa = 1 - wb - wc
      if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue
      return wa * a.y + wb * b.y + wc * c.y
    }
  }
  return null
}

describe('the ground: the RENDER surface, in the level frame', () => {
  it('agrees with the chunks as the renderer draws them, under an offset and scaled group', () => {
    // Offset like an island (a corner, not a centre, DEV-042) and scaled like the sea.
    const { terrain, drawn } = fakeTerrain([-300, 7, 450], 2, relief)
    const surface = terrainSurface(terrain)
    const rnd = lcg(3)
    let checked = 0
    let worst = 0
    for (let i = 0; i < 300; i++) {
      // The group spans x in [-300, 724] and z in [-574, 450] (mesh z runs to −z).
      const x = -300 + 40 + rnd() * (1024 - 80)
      const z = 450 - 40 - rnd() * (1024 - 80)
      const truth = drawnHeightAt(drawn, x, z)
      if (truth === null) continue
      worst = Math.max(worst, Math.abs(surface(x, z) - truth))
      checked++
    }
    expect(checked).toBeGreaterThan(250)
    expect(worst).toBeLessThan(1e-2)
  })

  it('measures the sea AT REST: the plate’s bob, at any phase, moves nothing (DEV-501 follow-up)', () => {
    // A seeded island's new pad stood on a shore in one run and 1.3 km inland
    // in the next: the ground was built from the plate's LIVE transform, which
    // carries 2016's whole-plate bob, so the sea over the shore came and went
    // with the frame the world arrived in.
    const { terrain: sea } = fakeTerrain([-256, 3, 256], 2, (u, v) => 0.4 + 0.1 * u * v)
    const rest = { ...sea, restY: 3 } as unknown as LoadedTerrain
    const still = terrainSurface(rest)
    const rnd = lcg(11)
    const at = Array.from({ length: 50 }, () => [rnd() * 400, -rnd() * 400] as const)
    const before = at.map(([x, z]) => still(x, z))
    expect(before.every(Number.isFinite)).toBe(true)
    for (const bob of [-3.459, -1, 2.2, 3.459]) {
      sea.group.position.y = 3 + bob
      sea.group.updateMatrixWorld(true)
      const bobbed = terrainSurface(rest)
      expect(at.map(([x, z]) => bobbed(x, z))).toEqual(before)
    }
    // And the live transform it used to read does move with the bob.
    expect(terrainSurface(sea)(at[0]?.[0] ?? 0, at[0]?.[1] ?? 0)).not.toBe(before[0])
  })

  it('judges water at the HIGH-water mark: the sea at rest plus the plate’s own `highWater`', () => {
    // The drawn sea bobs and chops up to `highWater` over its rest surface
    // (7.459 m on Simonet: the bob's 3.459 plus the wave's 4); a pad the sea
    // reaches at the top of a wave is in the sea. Pinned: rest + the mark, at
    // any phase of the bob, and water wherever that stands over the land.
    const { terrain: sea } = fakeTerrain([-256, 3, 256], 2, (u, v) => 0.4 + 0.1 * u * v)
    const MARK = 7.459
    const plate = { ...sea, restY: 3, highWater: MARK } as unknown as LoadedTerrain
    const rest = terrainSurface(plate)
    // Land a hair above the rest sea at one point, and far below it at another.
    const { terrain: land } = fakeTerrain([-256, 0, 256], 2, () => 0)
    const rnd = lcg(13)
    const at = Array.from({ length: 40 }, () => [rnd() * 400, -rnd() * 400] as const)
    for (const bob of [0, -3.459, 3.459]) {
      sea.group.position.y = 3 + bob
      sea.group.updateMatrixWorld(true)
      const g = deskGround({ land, ocean: plate } as Parameters<typeof deskGround>[0])
      for (const [x, z] of at) {
        expect(g.surfaceAt(x, z)).toBeCloseTo(rest(x, z) + MARK, 9)
        expect(g.waterAt?.(x, z)).toBe(true)
      }
    }
    // A shore the rest sea leaves dry but the mark covers is water.
    const [x0, z0] = at[0] as readonly [number, number]
    const shoreY = rest(x0, z0) + MARK / 2
    const shore = { surfaceAt: () => shoreY }
    const judged = landAndSea(shore.surfaceAt, (x, z) => rest(x, z) + MARK)
    expect(judged.waterAt?.(x0, z0)).toBe(true)
    expect(landAndSea(shore.surfaceAt, rest).waterAt?.(x0, z0)).toBe(false)
  })

  it('is nothing outside the terrain, and the higher of land and sea where both are', () => {
    const land = fakeTerrain([0, 0, 0], 1, relief).terrain
    // A flat sea above the lowest land: the land's relief pokes through it.
    const sea = fakeTerrain([-256, 0, 256], 2, () => 0.5).terrain
    expect(terrainSurface(land)(-10, -10)).toBe(Number.NEGATIVE_INFINITY)
    const g = deskGround({ land, ocean: sea })
    const l = terrainSurface(land)
    const s = terrainSurface(sea)
    const rnd = lcg(5)
    for (let i = 0; i < 100; i++) {
      const x = 10 + rnd() * 490
      const z = -10 - rnd() * 490
      expect(g.surfaceAt(x, z)).toBe(Math.max(l(x, z), s(x, z)))
    }
  })
})

// ── picking and keys ─────────────────────────────────────────────────────

describe('picking, in screen space', () => {
  it('takes the nearest point within reach, and nothing out of it or off screen', () => {
    const pts = [{ x: 0, y: 0 }, null, { x: 10, y: 0 }, { x: 5, y: 3 }]
    expect(nearestWithin(pts, 6, 2, 14)).toBe(3)
    expect(nearestWithin(pts, 100, 100, 14)).toBeNull()
    expect(nearestWithin([null], 0, 0, 14)).toBeNull()
  })
  it('finds the segment and how far along it a click lands, and breaks the line off screen', () => {
    const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }, null, { x: 200, y: 0 }, { x: 300, y: 0 }]
    const on = nearestOnPolyline(line, 25, 4, 7)
    expect(on?.segment).toBe(0)
    expect(on?.u).toBeCloseTo(0.25, 6)
    expect(on?.pixels).toBeCloseTo(4, 6)
    // Between 100 and 200 the line is broken (a point behind the eye): no hit.
    expect(nearestOnPolyline(line, 150, 0, 7)).toBeNull()
    expect(nearestOnPolyline(line, 250, 0, 7)?.segment).toBe(3)
    expect(nearestOnPolyline(line, 50, 20, 7)).toBeNull()
  })
})

describe("the desk's keys", () => {
  const k = (
    key: string,
    mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {},
  ) => ({
    key,
    ctrlKey: mods.ctrl === true,
    metaKey: mods.meta === true,
    shiftKey: mods.shift === true,
    altKey: mods.alt === true,
  })
  it('maps Delete, undo, both redos, Escape and T, on Ctrl or Cmd', () => {
    expect(deskKeyAction(k('Delete'))).toBe('delete')
    expect(deskKeyAction(k('Backspace'))).toBe('delete')
    expect(deskKeyAction(k('z', { ctrl: true }))).toBe('undo')
    expect(deskKeyAction(k('Z', { ctrl: true, shift: true }))).toBe('redo')
    expect(deskKeyAction(k('y', { ctrl: true }))).toBe('redo')
    expect(deskKeyAction(k('z', { meta: true }))).toBe('undo')
    expect(deskKeyAction(k('Escape'))).toBe('deselect')
    expect(deskKeyAction(k('t'))).toBe('top-down')
    // DEV-472: F frames the selection, as in Maya and Unreal.
    expect(deskKeyAction(k('f'))).toBe('frame')
    expect(deskKeyAction(k('F', { shift: true }))).toBeNull()
    // DEV-570: Maya's tools, Q W E R (R aimed the pad from DEV-475; E does now),
    // and A frames the island.
    expect(deskKeyAction(k('q'))).toBe('tool-select')
    expect(deskKeyAction(k('w'))).toBe('tool-move')
    expect(deskKeyAction(k('e'))).toBe('tool-rotate')
    expect(deskKeyAction(k('r'))).toBe('tool-scale')
    expect(deskKeyAction(k('E'))).toBe('tool-rotate') // Caps Lock on
    expect(deskKeyAction(k('a'))).toBe('frame-all')
    for (const key of ['q', 'w', 'e', 'r', 'a']) {
      expect(deskKeyAction(k(key.toUpperCase(), { shift: true })), `Shift+${key}`).toBeNull()
      expect(deskKeyAction(k(key, { ctrl: true })), `Ctrl+${key}`).toBeNull()
      expect(deskKeyAction(k(key, { alt: true })), `Alt+${key}`).toBeNull()
    }
  })
  it('leaves every other key alone, the game keys and the browser shortcuts among them', () => {
    for (const key of ['s', 'd', 'Enter', ' ', 'ArrowUp', 'v', 'p']) {
      expect(deskKeyAction(k(key)), key).toBeNull()
    }
    expect(deskKeyAction(k('c', { ctrl: true }))).toBeNull()
    expect(deskKeyAction(k('z', { ctrl: true, alt: true }))).toBeNull()
    expect(deskKeyAction(k('t', { shift: true }))).toBeNull()
  })
})

// ── DEV-570: Maya's tools ────────────────────────────────────────────────

describe("the desk's tools (DEV-570, Maya's Q W E R)", () => {
  const kinds: (DeskPicked | null)[] = [null, 'point', 'pad', 'prop']

  it('Select shows no gizmo on anything, and nothing picked shows none under any tool', () => {
    for (const kind of kinds) expect(gizmoFor(kind, 'select'), String(kind)).toBeNull()
    for (const t of DESK_TOOLS) expect(gizmoFor(null, t), t).toBeNull()
  })

  it('E turns the start pad about Y alone, which is the heading the course stores', () => {
    expect(gizmoFor('pad', 'rotate')).toEqual({
      mode: 'rotate',
      x: false,
      y: true,
      z: false,
      fallback: false,
    })
    expect(gizmoFor('prop', 'rotate')?.mode).toBe('rotate')
  })

  it('W moves the pad and a prop on the ground (X and Z), and a point on all three axes', () => {
    for (const kind of ['pad', 'prop'] as const) {
      expect(gizmoFor(kind, 'move')).toEqual({
        mode: 'translate',
        x: true,
        y: false,
        z: true,
        fallback: false,
      })
    }
    expect(gizmoFor('point', 'move')).toEqual({
      mode: 'translate',
      x: true,
      y: true,
      z: true,
      fallback: false,
    })
  })

  it('R sizes a prop; what cannot take a tool shows its arrows, and says so', () => {
    expect(gizmoFor('prop', 'scale')?.mode).toBe('scale')
    for (const [kind, t] of [
      ['pad', 'scale'],
      ['point', 'rotate'],
      ['point', 'scale'],
    ] as const) {
      const g = gizmoFor(kind, t)
      expect(g?.mode, `${kind} under ${t}`).toBe('translate')
      expect(g?.fallback, `${kind} under ${t}`).toBe(true)
      expect(toolNote(kind, t), `${kind} under ${t}`).toMatch(/does not (turn|scale)/)
    }
  })

  it('the note names the keys for what the picked thing can do', () => {
    expect(toolNote('pad', 'rotate')).toContain('E turns it')
    expect(toolNote('prop', 'move')).toContain('R sizes it')
    expect(toolNote(null, 'select')).toContain('Select (Q)')
    for (const kind of kinds) {
      for (const t of DESK_TOOLS) expect(toolNote(kind, t).length).toBeGreaterThan(10)
    }
  })

  it('a scale drag takes the axis pulled furthest, whichever handle it was', () => {
    expect(uniformScaleOf([1.5, 1, 1], 1)).toBe(1.5)
    expect(uniformScaleOf([1, 1, 0.5], 1)).toBe(0.5)
    expect(uniformScaleOf([2, 2, 2], 1)).toBe(2) // the centre handle
    expect(uniformScaleOf([1, 1, 1], 1)).toBe(1)
    expect(uniformScaleOf([Number.NaN, 1.2, 1], 1)).toBe(1.2)
  })

  it('every key the panel lists is a key the desk answers (one list, DESK_KEY_LIST)', () => {
    const single = DESK_KEY_LIST.filter((k) => /^[A-Z]$/.test(k.keys)).map((k) => k.keys)
    expect(single.sort()).toEqual(['A', 'E', 'F', 'Q', 'R', 'T', 'W'])
    for (const key of single) {
      expect(
        deskKeyAction({
          key: key.toLowerCase(),
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
          altKey: false,
        }),
        key,
      ).not.toBeNull()
    }
    // The tool keys are the ones TOOL_KEYS names, in Maya's order.
    expect(DESK_TOOLS.map((t) => TOOL_KEYS[t].key)).toEqual(['Q', 'W', 'E', 'R'])
    for (const t of DESK_TOOLS) {
      expect(
        DESK_KEY_LIST.some((k) => k.keys === TOOL_KEYS[t].key),
        t,
      ).toBe(true)
    }
  })
})

// ── DEV-569: the way back ───────────────────────────────────────────────

describe('Back to hangar (DEV-569)', () => {
  it('leaves at once when the draft is kept, and asks only when it is not', () => {
    expect(leaveAsks(true)).toBe(false)
    expect(leaveAsks(false)).toBe(true)
  })
  it('says what is lost and what keeps it, with a safe answer first', () => {
    expect(LEAVE_WORDS.body).toContain('Save file')
    expect(LEAVE_WORDS.stay).toBe('Keep editing')
  })
})

// ── the camera ───────────────────────────────────────────────────────────

describe('framing the play area', () => {
  it('stands back far enough that the framed sphere fits the view, on every HoverJet sky', () => {
    for (const sky of hoverjets) {
      const area = playerCourseArea(sky)
      if (!area) continue
      const { radius } = areaSphere(area)
      for (const aspect of [0.6, 1, 16 / 9]) {
        const d = frameDistance(radius, DESK_POLICY.fovDegrees, aspect)
        const v = THREE.MathUtils.degToRad(DESK_POLICY.fovDegrees) / 2
        const h = Math.atan(Math.tan(v) * aspect)
        // The sphere's angular radius from there, inside BOTH half-angles.
        const seen = Math.asin(radius / d)
        expect(seen, `${sky.id} at ${aspect}`).toBeLessThanOrEqual(Math.min(v, h) + 1e-9)
      }
    }
  })
  it('frames a box by its floor, and a sphere by itself', () => {
    const box = areaSphere({ kind: 'box', min: [0, -10, 0], max: [100, 990, 40] })
    expect(box.centre.toArray()).toEqual([50, -10, 20])
    expect(box.radius).toBeCloseTo(Math.hypot(50, 20), 9)
    const sphere = areaSphere({ kind: 'sphere', centre: [1, 2, 3], radius: 9 })
    expect(sphere.centre.toArray()).toEqual([1, 2, 3])
    expect(sphere.radius).toBe(9)
  })
})

// ── DEV-472: the depth range follows the orbit ──────────────────────────

describe('the desk camera’s near plane (DEV-472)', () => {
  // The game's own near plane, read out of the renderer's source rather than
  // imported: that module pulls the settings in, and this file stays in node.
  const gameNear = Number(
    /export const CAMERA_NEAR = ([0-9.]+)/.exec(
      fs.readFileSync(path.join(REPO, 'src', 'render', 'renderer.ts'), 'utf8'),
    )?.[1],
  )
  /** Metres of depth a 24-bit buffer resolves at distance z, far much larger than near. */
  const resolution = (z: number, near: number): number => (z * z) / (near * 2 ** 24)

  it('is pinned by value: moving one is an edit made on purpose', () => {
    expect(DESK_CAMERA_POLICY).toEqual({
      nearFraction: 0.005,
      farRadii: 2,
      focusSpanMetres: 400,
      flyLookDegreesPerPixel: 0.2,
      flyPitchLimitDegrees: 85,
      flySpeedPerMetre: 1,
      flySpeedMin: 20,
      flySpeedMax: 2000,
      flyWheelStep: 1.25,
      flyWheelRange: 8,
    })
  })
  it('never comes nearer than the game’s, and is a fixed fraction of the distance past that', () => {
    expect(gameNear).toBeGreaterThan(0)
    expect(deskNear(1, gameNear)).toBe(gameNear)
    expect(deskNear(4000, gameNear)).toBeCloseTo(4000 * DESK_CAMERA_POLICY.nearFraction, 9)
  })
  it('resolves depth far finer than a pixel of ground, where the game’s near plane was coarser than one, on every HoverJet sky', () => {
    // The ground one pixel covers at distance d, on a 1080-pixel-tall view:
    // what a depth error has to be smaller than to be invisible along a shore.
    const pixel = (d: number): number =>
      (2 * d * Math.tan(THREE.MathUtils.degToRad(DESK_POLICY.fovDegrees) / 2)) / 1080
    for (const sky of hoverjets) {
      const area = playerCourseArea(sky)
      if (!area) continue
      const framed = frameDistance(areaSphere(area).radius, DESK_POLICY.fovDegrees, 16 / 9)
      // From the framed view out to the farthest the orbit allows (twice it).
      for (const d of [framed, 2 * framed]) {
        const at = `${sky.id} at ${d.toFixed(0)} m`
        expect(resolution(d, gameNear) / pixel(d), `${at}, the game's`).toBeGreaterThan(1)
        expect(resolution(d, deskNear(d, gameNear)) / pixel(d), at).toBeLessThan(1 / 50)
      }
    }
  })
  it('stays far inside the lowest orbit’s height above its target, so it never clips the ground there', () => {
    const lowest = Math.cos(THREE.MathUtils.degToRad(DESK_POLICY.maxPolarDegrees))
    for (const d of [100, 1_000, 10_000, 30_000]) {
      expect(d * lowest).toBeGreaterThan(10 * deskNear(d, gameNear))
    }
  })
})

// ── DEV-472 follow-up: right-drag fly, Unreal's viewport ────────────────

describe('the fly’s look and move (DEV-472 follow-up)', () => {
  const start: FlyAngles = { yaw: 0.7, pitch: -0.4 }
  // The outside oracle for the conventions: three's own camera, turned by the
  // fly's quaternion, looks down its -Z and has its +X on screen-right.
  const cameraAxes = (a: FlyAngles) => {
    const q = flyQuaternion(a)
    return {
      forward: new THREE.Vector3(0, 0, -1).applyQuaternion(q),
      right: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
    }
  }

  it('agrees with three’s camera about which way is forward and which is right', () => {
    for (const a of [start, { yaw: -2.5, pitch: 0.9 }, { yaw: 0, pitch: 0 }]) {
      const { forward, right } = cameraAxes(a)
      expect(flyForward(a).distanceTo(forward)).toBeLessThan(1e-9)
      expect(flyRight(a).distanceTo(right)).toBeLessThan(1e-9)
      const back = anglesOf(forward)
      expect(back.yaw).toBeCloseTo(a.yaw, 9)
      expect(back.pitch).toBeCloseTo(a.pitch, 9)
    }
  })
  it('turns the view the way the hand moves: right is right, up is up', () => {
    const { right } = cameraAxes(start)
    const turned = flyLook(start, 40, 0)
    expect(flyForward(turned).dot(right), 'a move right turns right').toBeGreaterThan(0)
    expect(flyForward(turned).y).toBeCloseTo(flyForward(start).y, 9)
    const raised = flyLook(start, 0, -40)
    expect(flyForward(raised).y, 'a move up looks up').toBeGreaterThan(flyForward(start).y)
    // 40 px at the policy's rate, and no further.
    const k = THREE.MathUtils.degToRad(DESK_CAMERA_POLICY.flyLookDegreesPerPixel)
    expect(flyForward(turned).angleTo(flyForward(start))).toBeCloseTo(
      40 * k * Math.cos(start.pitch),
      3,
    )
  })
  it('stops the pitch short of straight up and straight down', () => {
    const limit = THREE.MathUtils.degToRad(DESK_CAMERA_POLICY.flyPitchLimitDegrees)
    expect(limit).toBeLessThan(Math.PI / 2)
    expect(flyLook(start, 0, -1e6).pitch).toBeCloseTo(limit, 12)
    expect(flyLook(start, 0, 1e6).pitch).toBeCloseTo(-limit, 12)
    expect(anglesOf(new THREE.Vector3(0, -1, 0)).pitch).toBeCloseTo(-limit, 12)
  })
  it('moves in the camera’s frame: W along the view, D to screen-right, E up the world, never faster on a diagonal', () => {
    const none = { forward: false, back: false, left: false, right: false, up: false, down: false }
    const { forward, right } = cameraAxes(start)
    const w = flyStep(start, { ...none, forward: true }, 50, 0.1)
    expect(w.length()).toBeCloseTo(5, 9)
    expect(w.clone().normalize().distanceTo(forward)).toBeLessThan(1e-9)
    const d = flyStep(start, { ...none, right: true }, 50, 0.1)
    expect(d.clone().normalize().distanceTo(right)).toBeLessThan(1e-9)
    const e = flyStep(start, { ...none, up: true }, 50, 0.1)
    expect(e.toArray()).toEqual([0, 5, 0])
    const q = flyStep(start, { ...none, down: true }, 50, 0.1)
    expect(q.y).toBeCloseTo(-5, 9)
    expect(flyStep(start, { ...none, forward: true, right: true }, 50, 0.1).length()).toBeCloseTo(
      5,
      9,
    )
    expect(flyStep(start, none, 50, 0.1).length()).toBe(0)
    expect(flyStep(start, { ...none, forward: true, back: true }, 50, 0.1).length()).toBe(0)
  })
  it('hands back to the orbit with no jump: the target is on the view ray, and looking at it is the view', () => {
    const eye = new THREE.Vector3(120, 340, -900)
    const target = flyReleaseTarget(eye, start, 2500)
    expect(target.distanceTo(eye)).toBeCloseTo(2500, 6)
    const cam = new THREE.PerspectiveCamera()
    cam.position.copy(eye)
    cam.quaternion.copy(flyQuaternion(start))
    const before = cam.quaternion.clone()
    cam.lookAt(target)
    expect(cam.quaternion.angleTo(before), 'the view did not turn').toBeLessThan(1e-6)
  })
  it('speeds up with height inside the policy’s range, and the wheel scales it within its own', () => {
    const p = DESK_CAMERA_POLICY
    expect(flySpeed(30, 1)).toBeCloseTo(30 * p.flySpeedPerMetre, 9)
    expect(flySpeed(0, 1)).toBe(p.flySpeedMin)
    expect(flySpeed(10_000, 1)).toBe(p.flySpeedMax)
    expect(flySpeed(500, 2)).toBeCloseTo(2 * flySpeed(500, 1), 9)
    expect(flyWheel(1, -100), 'away is faster').toBeGreaterThan(1)
    expect(flyWheel(1, 100)).toBeLessThan(1)
    let s = 1
    for (let i = 0; i < 100; i++) s = flyWheel(s, -100)
    expect(s).toBe(p.flyWheelRange)
    for (let i = 0; i < 200; i++) s = flyWheel(s, 100)
    expect(s).toBe(1 / p.flyWheelRange)
  })
})

// ── the lazy boundary ────────────────────────────────────────────────────

describe('the desk is lazy', () => {
  // The whole boot tree (APP-SPLIT phase 0): a static editor import in ANY
  // file of it would pull the desk into the boot chunk. The bundle-level
  // version of this claim is `editor-lazy-graph.test.ts`.
  const app = appSource()
  it('app.ts imports nothing from src/editor/ but types', () => {
    // Each `from '@/editor/…'`, and the import statement it closes: the text
    // from the last line-start `import` before it. Only `import type` may.
    const statics: string[] = []
    for (const m of app.matchAll(/from\s+'@\/editor\/[^']*'/g)) {
      const start = app.lastIndexOf('\nimport ', m.index) + 1
      const statement = app.slice(start, (m.index ?? 0) + m[0].length)
      if (!/^import type\b/.test(statement)) statics.push(statement)
    }
    expect(app).toMatch(/from\s+'@\/editor\//)
    expect(statics).toEqual([])
  })
  it('and reaches the desk by a dynamic import', () => {
    expect(app).toContain("import('@/editor/desk')")
  })
})

// ── the title's door ─────────────────────────────────────────────────────

describe('MAKE A COURSE on the Custom Courses shelf (the COURSES hub until DEV-558)', () => {
  it('is the shelf’s first table, before OPEN A COURSE FILE and the courses', () => {
    const items = shelfItems([MAKE_A_COURSE_ACTION, OPEN_COURSE_FILE_ACTION], [])
    expect(items.map((i) => (i.kind === 'action' ? i.action.id : i.entry.id))).toEqual([
      'make-course',
      'open-course-file',
    ])
    expect(MAKE_A_COURSE_ACTION.name).toBe('Make a Course')
  })
  it('is offered by the app only where the desk can be used (a desktop)', () => {
    // `boot/app.ts`'s `shelfActions`: not in a headset, not on a phone.
    const src = appSource()
    const at = src.indexOf('const shelfActions = ')
    expect(at).toBeGreaterThan(0)
    // APP-SPLIT 4.5a: `shelfActions` lives in `boot/app/title/player-courses.ts`,
    // which reads the closure's `capabilities` through its `ctx`: the same binding.
    // DEV-878 (decision 7): a phone is shown the row, refused, not left without it.
    expect(src.slice(at, at + 1100)).toMatch(
      /!presenting\s*\?\s*\[(?:ctx\.)?capabilities\.touch \? MAKE_A_COURSE_PHONE_ACTION : MAKE_A_COURSE_ACTION\]/,
    )
  })
  it('says on a phone that the editor needs a computer, and a press of it opens nothing', () => {
    expect(MAKE_A_COURSE_PHONE_ACTION.name).toBe('Make a Course')
    expect(MAKE_A_COURSE_PHONE_ACTION.detail).toContain('computer')
    expect(MAKE_A_COURSE_PHONE_ACTION.refused).toBe(true)
    // Another id, so the hangar's `onAction` (which matches `make-course`) never fires for it.
    expect(MAKE_A_COURSE_PHONE_ACTION.id).not.toBe(MAKE_A_COURSE_ACTION.id)
  })
})
