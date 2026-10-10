// tests/unit/hangar-emblem.test.ts: the game's emblem, in the room. DEV-573.
//
// Matt, 2026-10-02: *"need the game logo in the hangar (otherwise the room
// we're in the most has no info about the game we're playing"*.
// `render/hangar-art.ts` stands the title's own logo in the level-select room,
// on the room's shell material. Every claim here is about where it ENDS UP,
// measured on the real files through three's own matrices (the orientation
// lesson: test the geometry, not the rotation):
//
//   * it is IN the flat frame a player sits in, projected through a camera
//     posed as the seat poses it;
//   * it covers no table: every point of it is ABOVE the eye line, and every
//     table, label, door and plate the room stands is below it;
//   * it reads from the chair: the word space falls right of centre (FACETED
//     is the longer word), which only the logo's front shows;
//   * it stands in clear air: no wall of 2016's room between the eye and it;
//   * it compiles nothing: the shell's material and the shell's attributes.
//
// The logo and the room are bought geometry, never in git (hard rule 7), so
// the half that reads them is guarded, its disk work inside each `it`, and the
// guard has a loud counterpart.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { HOLO_REACH, seatEyeLocal, seatPitchLocal, seatYawLocal, TABLE_TOP } from '@/render/hangar'
import {
  assembleRoomEmblem,
  createHangarArt,
  HANGAR_CHAIR_MESH,
  HANGAR_ROOM_MESH,
  HANGAR_TABLE_MESH,
  ROOM_EMBLEM,
  roomFactsOf,
  roomMatrix,
  TITLE_LOGO_MESH,
} from '@/render/hangar-art'
import { EMBLEM_GOLD } from '@/render/loading-scene'
import { hangarSpecFor } from '@/sim/hangar'
import { appSource } from './helpers/app-source'
import { REPO as ROOT } from './helpers/repo-root'

const LOGO = path.join(ROOT, 'public', TITLE_LOGO_MESH)
const ROOM = path.join(ROOT, 'public', HANGAR_ROOM_MESH)
const available = fs.existsSync(LOGO) && fs.existsSync(ROOM)

const spec = hangarSpecFor()
const seat = seatEyeLocal(spec)
const eye = new THREE.Vector3(seat.x, seat.y, seat.z)

const parse = async (file: string): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(file)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

const pointsOf = (geometry: THREE.BufferGeometry): THREE.Vector3[] => {
  const p = geometry.getAttribute('position')
  const out: THREE.Vector3[] = []
  for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(p, i))
  return out
}

/** The flat camera as the room poses it: the renderer's lens, the seat's yaw and pitch. */
const flatCamera = (): THREE.PerspectiveCamera => {
  const renderer = fs.readFileSync(path.join(ROOT, 'src/render/renderer.ts'), 'utf8')
  const fov = Number(/new THREE\.PerspectiveCamera\(\s*(\d+),/.exec(renderer)?.[1])
  expect(fov, "the renderer's lens, read from its source").toBeGreaterThan(0)
  const camera = new THREE.PerspectiveCamera(fov, 1280 / 720, 0.08, 1000)
  camera.position.copy(eye)
  camera.rotation.order = 'YXZ'
  camera.rotation.set(seatPitchLocal(), seatYawLocal(), 0)
  camera.updateMatrixWorld(true)
  return camera
}

describe.skipIf(!available)(
  "the room's emblem lies where it reads (DEV-573, moved by DEV-839)",
  () => {
    const build = async () =>
      assembleRoomEmblem(await parse(LOGO), seat, spec.floorY) as THREE.BufferGeometry

    it('is in the flat frame from the chair, and fills a fair part of it', async () => {
      const geometry = await build()
      expect(geometry).not.toBeNull()
      const camera = flatCamera()
      const ndc = pointsOf(geometry).map((p) => p.clone().project(camera))
      for (const q of ndc) {
        expect(Math.abs(q.x), 'inside the frame across').toBeLessThan(1)
        expect(Math.abs(q.y), 'inside the frame up and down').toBeLessThan(1)
      }
      // Too small to see has been rendered, not reviewed (orientation lesson §5c):
      // at least a tenth of the frame's width.
      const xs = ndc.map((q) => q.x)
      expect((Math.max(...xs) - Math.min(...xs)) / 2).toBeGreaterThan(0.1)
    })

    it('lies flat on the floor, ahead of the chair and short of the tables', async () => {
      const points = pointsOf(await build())
      const ys = points.map((p) => p.y)
      // Flat: the relief of a sign, a few centimetres, just over the floor.
      expect(Math.max(...ys) - Math.min(...ys), 'flat, metres of relief').toBeLessThan(0.05)
      expect(Math.min(...ys) - spec.floorY, 'over the floor, metres').toBeCloseTo(
        ROOM_EMBLEM.lift,
        3,
      )
      // Ahead of the chair along the resting look, not beside or behind it.
      const b = (ROOM_EMBLEM.bearingDeg * Math.PI) / 180
      const away = new THREE.Vector3(Math.sin(b), 0, -Math.cos(b))
      expect(ROOM_EMBLEM.bearingDeg, 'the chair is aimed at it').toBeCloseTo(
        (-seatYawLocal() * 180) / Math.PI,
        6,
      )
      const reach = points.map((p) => p.clone().sub(eye).setY(0).dot(away))
      expect(Math.min(...reach), 'its near edge is in front of the chair').toBeGreaterThan(0.3)
      expect(Math.max(...reach), 'its far edge stops short of the tables').toBeLessThan(
        HOLO_REACH - 0.1,
      )
    })

    it('reads from the chair: the word space is right of centre, as only the front shows it', async () => {
      const logo = await parse(LOGO)
      const geometry = assembleRoomEmblem(logo, seat, spec.floorY) as THREE.BufferGeometry
      // The wordmark's own vertices: the logo's `title` mesh is appended in
      // traversal order, so find its range by counting the meshes before it.
      let start = 0
      let count = 0
      let seen = 0
      logo.traverse((n) => {
        const m = n as THREE.Mesh
        if (!m.isMesh) return
        const c = m.geometry.getAttribute('position').count
        if (/^title/i.test(m.name)) {
          start = seen
          count = c
        }
        seen += c
      })
      expect(count, 'the logo has a wordmark').toBeGreaterThan(0)
      const points = pointsOf(geometry).slice(start, start + count)
      const centre = points.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(count)
      const forward = centre.clone().sub(eye).setY(0).normalize()
      const right = forward
        .clone()
        .cross(new THREE.Vector3(0, 1, 0))
        .normalize()
      const us = points.map((p) => p.clone().sub(centre).dot(right)).sort((a, b) => a - b)
      let gapAt = 0
      let widest = 0
      for (let i = 1; i < us.length; i++) {
        const w = (us[i] as number) - (us[i - 1] as number)
        if (w > widest) {
          widest = w
          gapAt = ((us[i] as number) + (us[i - 1] as number)) / 2
        }
      }
      const mid = ((us[0] as number) + (us[us.length - 1] as number)) / 2
      expect(gapAt - mid, 'the word space is right of centre, seen from the chair').toBeGreaterThan(
        0,
      )
    })

    it("rests on 2016's deck: a ray down from every point meets it within a hand's breadth", async () => {
      const geometry = await build()
      const room = await parse(ROOM)
      const facts = roomFactsOf(room.getObjectByName('hangar-room') as THREE.Object3D)
      const m = roomMatrix(facts, seat, spec.floorY)
      const group = new THREE.Group()
      room.traverse((n) => {
        const mesh = n as THREE.Mesh
        if (!mesh.isMesh) return
        const placed = new THREE.Mesh(
          mesh.geometry,
          new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
        )
        placed.applyMatrix4(m)
        group.add(placed)
      })
      group.updateMatrixWorld(true)
      const ray = new THREE.Raycaster()
      const down = new THREE.Vector3(0, -1, 0)
      let worst = 0
      let missed = 0
      const points = pointsOf(geometry)
      for (let i = 0; i < points.length; i += 5) {
        const p = points[i] as THREE.Vector3
        ray.set(p, down)
        const hit = ray.intersectObject(group, true)[0]
        if (!hit) missed++
        else worst = Math.max(worst, Math.abs(p.y - hit.distance - spec.floorY))
      }
      expect(missed, 'every point has deck beneath it').toBe(0)
      expect(worst, 'the deck is where the floor is, metres out').toBeLessThan(0.05)
    })
  },
)

describe("the room's emblem compiles nothing, and the room stands without it", () => {
  it('wears the shell material, with the shell attributes, and casts no shadow', async () => {
    if (!available) return
    const shell = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true })
    const room = new THREE.Group()
    const art = createHangarArt({
      room,
      material: shell,
      replaces: [],
      tables: [],
      plinth: new THREE.BufferGeometry(),
      seat,
      floorY: spec.floorY,
      parkY: spec.floorY,
      tableTop: TABLE_TOP,
      alive: () => true,
      load: async (p) => parse(path.join(ROOT, 'public', p)),
    })
    expect(await art.ready).toBe(true)
    const emblem = room.getObjectByName('hangar-emblem') as THREE.Mesh
    expect(emblem, 'the emblem stands in the room').toBeDefined()
    expect(emblem.material).toBe(shell)
    const shellMesh = room.getObjectByName('hangar-2016-shell') as THREE.Mesh
    expect(Object.keys(emblem.geometry.attributes).sort()).toEqual(
      Object.keys(shellMesh.geometry.attributes).sort(),
    )
    expect(emblem.userData.castShadow).toBe(false)
    // In the title's colours: gold for most of it, linear like the room's own.
    const c = emblem.geometry.getAttribute('color')
    const gold = new THREE.Color(EMBLEM_GOLD)
    let golden = 0
    for (let i = 0; i < c.count; i++) {
      if (Math.abs(c.getX(i) - gold.r) < 1e-6 && Math.abs(c.getZ(i) - gold.b) < 1e-6) golden++
    }
    expect(golden / c.count).toBeGreaterThan(0.3)
  })

  it('a logo that does not load leaves the room standing, without it', async () => {
    if (!fs.existsSync(ROOM)) return
    const room = new THREE.Group()
    const art = createHangarArt({
      room,
      material: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true }),
      replaces: [],
      tables: [],
      plinth: new THREE.BufferGeometry(),
      seat,
      floorY: spec.floorY,
      parkY: spec.floorY,
      tableTop: TABLE_TOP,
      alive: () => true,
      load: async (p) => {
        if (p === TITLE_LOGO_MESH) throw new Error('no logo')
        return parse(path.join(ROOT, 'public', p))
      },
    })
    expect(await art.ready).toBe(true)
    expect(room.getObjectByName('hangar-2016-shell')).toBeDefined()
    expect(room.getObjectByName('hangar-emblem')).toBeUndefined()
  })
})

describe.skipIf(available)('title-logo.glb or hangar-room.glb is not on disk', () => {
  it("so the room's emblem tests above were SKIPPED, not passed", () => {
    expect(available).toBe(false)
  })
})

// The paths the room loads are the title's and the room's own.
it('loads the same logo file the title loads', () => {
  const app = appSource()
  expect(app).toContain(`assetUrl('${TITLE_LOGO_MESH}')`)
  expect([HANGAR_ROOM_MESH, HANGAR_CHAIR_MESH, HANGAR_TABLE_MESH]).not.toContain(TITLE_LOGO_MESH)
})
