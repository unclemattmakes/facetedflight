// tests/unit/shaft-paint.test.ts — the elevator shaft keeps the hangar's colours (DEV-456).
//
// Matt, 2026-09-27: *"it looks like the elevator shaft stops using it's vertex
// colors when just above the hangar"*, and, told why, *"shaft should keep it's
// hangar colors - consider it a decade old bug fix."*
//
// The cause was 2016's: the shaft's meshes carry PolyWorld vertex colours and
// its material (`Marmoset/Specular IBL`, `MARMO_VERTEX_COLOR` commented out)
// never read them, so the shaft drew one flat `_Color` over a room that wears
// its paint. The claims here are held against things outside the port's own
// arithmetic: the room's colours, out of the same 2016 file, and the number of
// distinct colours the shaft carries.
//
// And the suspect the brief named first — DEV-443's `cutShaftAtRim` rebuilding
// the shaft and losing its colour — is closed by a vertex-for-vertex check: the
// cut keeps every position WITH the colour it had.
//
// The GLBs are bought geometry and never in git (hard rule 7), so the half that
// reads them is guarded, the disk work is inside each `it`, and the guard has a
// loud counterpart.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it, vi } from 'vitest'
import { seatEyeLocal, TABLE_TOP } from '@/render/hangar'
import {
  assembleHangarArt,
  assembleLaunchArt,
  HANGAR_CHAIR_MESH,
  HANGAR_ROOM_MESH,
  HANGAR_TABLE_MESH,
  loadRoomArt,
} from '@/render/hangar-art'
import {
  HANGAR_SHAFT_PAINTED_MESH,
  paintShaft,
  SHAFT_PAINT_SHIPPED,
  shaftPaintParam,
} from '@/render/shaft-paint'
import { trimAbove } from '@/render/start-grid'
import { hangarSpecFor, plinthTopY } from '@/sim/hangar'
import { HYDRATED_MAINTAINER_CHECKOUT } from './helpers/checkout'

const FILES = [HANGAR_ROOM_MESH, HANGAR_SHAFT_PAINTED_MESH, HANGAR_CHAIR_MESH, HANGAR_TABLE_MESH]
const AVAILABLE = FILES.every((f) => fs.existsSync(`public/${f}`))

const parse = async (file: string): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(`public/${file}`)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

const geometryOf = (root: THREE.Object3D, name: string): THREE.BufferGeometry =>
  (root.getObjectByName(name) as THREE.Mesh).geometry

/** Distinct colours, and the mean colour's luma and chromaticity (r, g, b over their sum). */
const colours = (g: THREE.BufferGeometry) => {
  const c = g.getAttribute('color')
  const distinct = new Set<string>()
  let r = 0
  let gr = 0
  let b = 0
  for (let i = 0; i < c.count; i++) {
    distinct.add(`${c.getX(i).toFixed(4)},${c.getY(i).toFixed(4)},${c.getZ(i).toFixed(4)}`)
    r += c.getX(i)
    gr += c.getY(i)
    b += c.getZ(i)
  }
  const mean: [number, number, number] = [r / c.count, gr / c.count, b / c.count]
  const total = mean[0] + mean[1] + mean[2]
  return {
    distinct: distinct.size,
    luma: 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2],
    chroma: mean.map((v) => v / total) as [number, number, number],
  }
}

const chromaGap = (a: readonly number[], b: readonly number[]) =>
  Math.max(...a.map((v, k) => Math.abs(v - (b[k] as number))))

/** A lone triangle, for the refusals. */
const triangleScene = (name: string, positions: number[], index?: number[]) => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(
      positions.map(() => 0.5),
      3,
    ),
  )
  if (index) g.setIndex(index)
  const root = new THREE.Group()
  const mesh = new THREE.Mesh(g)
  mesh.name = name
  root.add(mesh)
  return root
}

// ── No files needed ───────────────────────────────────────────────────────────

describe('the shaft paint, as the game ships it', () => {
  it('ships the hangar paint: the one assertion somebody has to edit on purpose', () => {
    expect(SHAFT_PAINT_SHIPPED).toBe('hangar')
  })

  it('reads ?shaftPaint= and says so when it cannot', () => {
    expect(shaftPaintParam(null)).toBeNull()
    expect(shaftPaintParam('hangar')).toBe('hangar')
    expect(shaftPaintParam('2016')).toBe('2016')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(shaftPaintParam('pink')).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('refuses paint for another mesh: other vertices, moved vertices, other triangles', () => {
    const room = () => triangleScene('shaft', [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2])
    expect(() =>
      paintShaft(room(), triangleScene('shaft', [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], [0, 1, 2])),
    ).toThrow(/not the same mesh/)
    expect(() =>
      paintShaft(room(), triangleScene('shaft', [0, 0, 0, 1, 0, 0, 0, 1.1, 0], [0, 1, 2])),
    ).toThrow(/off the room file/)
    expect(() =>
      paintShaft(room(), triangleScene('shaft', [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 2, 1])),
    ).toThrow(/other triangles/)
  })
})

// ── The files ─────────────────────────────────────────────────────────────────

describe.skipIf(!AVAILABLE)("the shaft in the hangar's colours, from the files", () => {
  it("is 2016's flat shaft in the room file, and the painted file carries the paint", async () => {
    // The finding, kept as the witness: one colour, 2016's `_Color`, on a mesh
    // whose own file holds a room of paint.
    const room = await parse(HANGAR_ROOM_MESH)
    expect(colours(geometryOf(room, 'shaft')).distinct, "2016's shaft").toBe(1)
    expect(colours(geometryOf(room, 'roomLower')).distinct, 'the room under it').toBeGreaterThan(
      100,
    )
    const painted = await parse(HANGAR_SHAFT_PAINTED_MESH)
    expect(colours(geometryOf(painted, 'shaft')).distinct, 'the painted shaft').toBeGreaterThan(100)
  })

  it('paints the shaft in the hangar colours through the loader both rooms use', async () => {
    const flat = await loadRoomArt(HANGAR_ROOM_MESH, parse, '2016')
    const room = await loadRoomArt(HANGAR_ROOM_MESH, parse, SHAFT_PAINT_SHIPPED)
    const lower = colours(geometryOf(room, 'roomLower'))
    const shaft = colours(geometryOf(room, 'shaft'))
    const before = colours(geometryOf(flat, 'shaft'))
    console.info(
      `DEV-456 raw: room ${lower.chroma.map((v) => v.toFixed(3))} luma ${lower.luma.toFixed(3)}; ` +
        `shaft ${shaft.chroma.map((v) => v.toFixed(3))} luma ${shaft.luma.toFixed(3)} (${shaft.distinct} colours); ` +
        `2016 ${before.chroma.map((v) => v.toFixed(3))} luma ${before.luma.toFixed(3)}`,
    )
    expect(before.distinct, "the A/B arm: ?shaftPaint=2016 is 2016's shaft").toBe(1)
    // THE CLAIM: painted, in the room's colour, at the room's brightness.
    expect(shaft.distinct, 'painted').toBeGreaterThan(100)
    expect(chromaGap(shaft.chroma, lower.chroma), "the hangar's hue").toBeLessThan(0.02)
    expect(shaft.luma / lower.luma, "the hangar's brightness").toBeGreaterThan(0.5)
    expect(shaft.luma / lower.luma).toBeLessThan(2)
    // And what 2016's flat shaft was against it: a pale band, 10x the room.
    expect(before.luma / lower.luma, "2016's jump at the room's top").toBeGreaterThan(5)
  })

  it('reaches both rooms baked, the same colours (DEV-561), and the launch through the cut', async () => {
    const room = await loadRoomArt(HANGAR_ROOM_MESH, parse, SHAFT_PAINT_SHIPPED)
    // The launch (DEV-438): baked under the room's light, as the room is.
    const launch = assembleLaunchArt(room)
    const baked = colours(launch.shaft.geometry)
    const bakedRoom = colours(launch.room.geometry)
    expect(baked.distinct, 'the launch shaft, baked').toBeGreaterThan(100)
    expect(
      chromaGap(baked.chroma, bakedRoom.chroma),
      'the launch shaft reads as its room',
    ).toBeLessThan(0.03)
    // DEV-443's cut: every vertex it keeps under the rim keeps its colour. A
    // re-indexed or rebuilt geometry that shuffled colour onto other positions
    // fails here, and so does one that dropped the attribute.
    const top = 104.447
    const cut = trimAbove(launch.shaft.geometry, top)
    const key = (g: THREE.BufferGeometry, i: number) => {
      const p = g.getAttribute('position')
      const c = g.getAttribute('color')
      return `${p.getX(i).toFixed(5)},${p.getY(i).toFixed(5)},${p.getZ(i).toFixed(5)}|${c.getX(i).toFixed(5)},${c.getY(i).toFixed(5)},${c.getZ(i).toFixed(5)}`
    }
    const kept = new Set<string>()
    const src = launch.shaft.geometry.getAttribute('position')
    for (let i = 0; i < src.count; i++)
      if (src.getY(i) <= top) kept.add(key(launch.shaft.geometry, i))
    const out = cut.getAttribute('position')
    let checked = 0
    for (let i = 0; i < out.count; i++) {
      // The new corners the cut makes sit ON the line (float32 of it): skip them.
      if (out.getY(i) >= top - 1e-3) continue
      expect(kept.has(key(cut, i)), `vertex ${i} keeps its colour through the cut`).toBe(true)
      checked++
    }
    expect(checked, 'the check saw the shaft').toBeGreaterThan(50_000)
    expect(colours(cut).distinct, 'the launch shaft after the cut').toBeGreaterThan(100)
    // The level-select room (DEV-430): the shaft keeps the paint on a
    // vertex-coloured material, baked as the launch's is since DEV-561.
    const spec = hangarSpecFor()
    const menu = assembleHangarArt(
      { room, chair: await parse(HANGAR_CHAIR_MESH), table: await parse(HANGAR_TABLE_MESH) },
      {
        seat: seatEyeLocal(spec),
        floorY: spec.floorY,
        parkY: plinthTopY(spec),
        tableTop: TABLE_TOP,
      },
      new THREE.MeshBasicMaterial({ vertexColors: true }),
      { deck: new THREE.MeshPhysicalMaterial({ vertexColors: true }) },
    )
    expect(colours(menu.shaft.geometry).distinct, 'the level-select shaft').toBeGreaterThan(100)
    expect((menu.shaft.material as THREE.MeshBasicMaterial).vertexColors).toBe(true)
    // DEV-561, Matt: *"match the same colors as the in-game elevator."* The two
    // shafts are one segment out of one file, and each is now baked by the
    // launch's own sampler in the ROOM frame, before its room's transform: so
    // their colours are not near each other, they are the SAME array, face for
    // face, while their positions are not (the launch's is 2016's mission rig,
    // 18 % wider and 36 % taller than the menu's).
    const menuColour = menu.shaft.geometry.getAttribute('color')
    const launchColour = launch.shaft.geometry.getAttribute('color')
    expect(menuColour.count, 'the same faces').toBe(launchColour.count)
    // Counted rather than `toEqual`: a diff of two arrays this long takes vitest minutes.
    let differ = 0
    for (let i = 0; i < menuColour.array.length; i++)
      if (menuColour.array[i] !== launchColour.array[i]) differ++
    expect(differ, 'the same colours, face for face').toBe(0)
    menu.shaft.geometry.computeBoundingBox()
    launch.shaft.geometry.computeBoundingBox()
    const menuSize = (menu.shaft.geometry.boundingBox as THREE.Box3).getSize(new THREE.Vector3())
    const launchSize = (launch.shaft.geometry.boundingBox as THREE.Box3).getSize(
      new THREE.Vector3(),
    )
    expect(
      launchSize.y / menuSize.y,
      'and not the same place: the mission rig is taller',
    ).toBeGreaterThan(1.2)
    // On the tubes' unlit material: one program the room compiles anyway.
    expect(menu.shaft.material, "the tubes' material").toBe(menu.lamps.material)
  }, 60_000)

  it("leaves 2016's shaft, and says so, when the paint does not land", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const room = await loadRoomArt(
      HANGAR_ROOM_MESH,
      async (path) =>
        path === HANGAR_SHAFT_PAINTED_MESH ? Promise.reject(new Error('404')) : parse(path),
      SHAFT_PAINT_SHIPPED,
    )
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
    expect(colours(geometryOf(room, 'shaft')).distinct).toBe(1)
  })
})

// The loud counterpart asserts only in a HYDRATED maintainer checkout: these are BOUGHT assets,
// which the public export and its content pack never carry (plan/PUBLIC-REPO-facetedflight.md
// §4.3, Matt M4), and a plain clone of this repo (its CI runner) never pulls them: both
// skip both halves. tests/unit/helpers/checkout.ts.
describe.skipIf(AVAILABLE || !HYDRATED_MAINTAINER_CHECKOUT)(
  "the shaft in the hangar's colours: the GLBs are not hydrated",
  () => {
    it('says so, rather than passing quietly', () => {
      expect(
        FILES.filter((f) => !fs.existsSync(`public/${f}`)),
        'run tools/assets/convert-hangar-art.mjs (or pnpm assets:pull) to measure the shaft',
      ).toEqual([])
    })
  },
)
