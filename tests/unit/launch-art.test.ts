// tests/unit/launch-art.test.ts — 2016's launch room and shaft, placed (DEV-438).
//
// `render/hangar-art.ts`'s `createLaunchArt` stands the level-select room's own
// file under a mission's ship, at the size a MISSION's rig is: the level-select
// copy is scaled (0.85, 0.733, 0.85) and the launch is not, so the one matrix
// that places it (`PROPS.launchRoom.fromRoom`) has to undo a scale as well as
// move and turn. Every claim here is held against a number that did NOT come
// through that matrix — the level JSON's platform offsets, size and segment
// Ys (`tools/extract/level.mjs`), the reveal's animator height (a different
// block of the sheet), and Unity's own box under the lift — and each is one a
// wrong matrix would fail: an un-undone scale, a dropped deck lift, a room left
// turned by the launch room's own spin.
//
// The GLB is bought geometry and never in git (hard rule 7), so the half that
// reads it is guarded, the disk work is inside each `it`, and the guard has a
// loud counterpart.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it, vi } from 'vitest'
import { EYE } from '@/game/flight'
import { LAUNCH } from '@/generated/constants.generated'
import { createElevator, REVEAL_RISE } from '@/render/elevator'
import { createHangar } from '@/render/hangar'
import {
  assembleLaunchArt,
  createLaunchArt,
  HANGAR_ROOM_MESH,
  LAUNCH_ROOM_REPLACES,
  LAUNCH_ROOM_SHEET,
  launchFromRoom,
  roomFactsOf,
  roomLightSampler,
} from '@/render/hangar-art'
import { hangarSpecFor } from '@/sim/hangar'
import { HYDRATED_MAINTAINER_CHECKOUT } from './helpers/checkout'

const FILE = `public/${HANGAR_ROOM_MESH}`
const AVAILABLE = fs.existsSync(FILE)

/** Every HoverJet mission with a lift, straight off the extracted level JSON. */
const RIGS = fs
  .readdirSync('content/levels')
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => JSON.parse(fs.readFileSync(`content/levels/${f}`, 'utf8')))
  .filter((l) => l.spawn?.launch?.platform && l.spawn.launch.shaft)
  .map((l) => ({ id: l.id as string, launch: l.spawn.launch }))

const int01 = RIGS.find((r) => r.id === 'int_01_hoverJet')?.launch
if (!int01) throw new Error('no int_01_hoverJet launch in content/levels')

const parse = async (): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(FILE)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

const pointsOf = (geometry: THREE.BufferGeometry, matrix = new THREE.Matrix4()) => {
  const p = geometry.getAttribute('position')
  const out: THREE.Vector3[] = []
  for (let i = 0; i < p.count; i++)
    out.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(matrix))
  return out
}

const buildElevator = () =>
  createElevator({
    platform: int01.platform,
    shaft: int01.shaft,
    rise: int01.rise,
    hangar: hangarSpecFor(),
    seed: 0x48414e47,
  })

// ── The placement, by where it puts the lift — no files needed ───────────────

describe("the launch placement, against the level JSON's own lift", () => {
  it("puts the ROOM frame's origin on the lift's axis, at the rig's floor, for every rig", () => {
    // The ROOM frame's origin is the `Elevator`'s x/z at `Position_adjustment`'s
    // y. In the anchor's frame the level JSON says where the lift's axis is —
    // the platform at `offset - shipOffset` (`render/elevator.ts`) — and the
    // floor is the ship's height over the animator plus the animator's rest
    // height over `Position_adjustment`, a different block of the sheet.
    const origin = new THREE.Vector3().applyMatrix4(launchFromRoom())
    for (const { id, launch } of RIGS) {
      const [ox, , oz] = launch.platform.offset as [number, number, number]
      const [sx, sy, sz] = launch.platform.shipOffset as [number, number, number]
      expect(origin.x, `${id} axis x`).toBeCloseTo(ox - sx, 3)
      expect(origin.z, `${id} axis z`).toBeCloseTo(-(oz - sz), 3)
      expect(origin.y, `${id} floor`).toBeCloseTo(-(sy + LAUNCH.reveal.animatedNodeRestY), 3)
    }
  })

  it('keeps up UP and the floor level: a turn about y and a stretch, nothing else', () => {
    const m = launchFromRoom()
    const up = new THREE.Vector3(0, 1, 0).transformDirection(m)
    expect(up.y, 'y stays vertical').toBeCloseTo(1, 9)
    const across = new THREE.Vector3(1, 0, 0)
      .applyMatrix4(m)
      .sub(new THREE.Vector3().applyMatrix4(m))
    expect(Math.abs(across.y), 'a level line stays level').toBeLessThan(1e-9)
  })

  it('refuses a sheet without a 4x4 in it', () => {
    expect(() => launchFromRoom({ ...LAUNCH_ROOM_SHEET, fromRoom: [1, 0, 0] })).toThrow(/not a 4x4/)
  })
})

// ── The dressed lift — no files needed ───────────────────────────────────────

describe('a lift dressed in 2016', () => {
  const dressed = () => {
    const elevator = buildElevator()
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    shaft.name = 'elevator-shaft-2016'
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    deck.name = 'elevator-deck-2016'
    // The deck arrives in the anchor frame AT REST: put it where the platform rests.
    const rest = new THREE.Vector3()
    const platform = elevator.object.getObjectByName('elevator-platform') as THREE.Object3D
    platform.getWorldPosition(rest)
    deck.geometry.translate(rest.x, rest.y, rest.z)
    return { elevator, shaft, deck, platform, rest }
  }

  it('hides every generated piece it stands in for, and removes none', () => {
    const { elevator, shaft, deck } = dressed()
    const before: string[] = []
    elevator.object.traverse((o) => before.push(o.name))
    elevator.dress({ shaft, deck })
    const named = (n: string) => elevator.object.getObjectByName(n) as THREE.Object3D
    for (const n of ['elevator-shaft', 'elevator-shaft-wall', 'elevator-shaft-strips'])
      expect(named(n)?.visible, `${n} hidden`).toBe(false)
    const platform = named('elevator-platform')
    const generatedDeck = platform.children.filter((c) => c !== deck)
    expect(generatedDeck.length, 'the slab and its rim are still there').toBe(2)
    for (const c of generatedDeck) expect(c.visible, 'and hidden').toBe(false)
    const after: string[] = []
    elevator.object.traverse((o) => after.push(o.name))
    for (const n of before) expect(after, `${n || '(unnamed)'} still in the lift`).toContain(n)
  })

  it('keeps the collars where the whoosh comes from', () => {
    const { elevator, shaft, deck } = dressed()
    elevator.object.updateWorldMatrix(true, true)
    const where = () =>
      elevator.collars.map((c) => {
        c.updateWorldMatrix(true, false)
        return c.getWorldPosition(new THREE.Vector3()).toArray()
      })
    const before = where()
    elevator.dress({ shaft, deck })
    elevator.object.updateWorldMatrix(true, true)
    expect(where()).toEqual(before)
    expect(elevator.collars.length).toBe(8)
  })

  it('rides the deck with the lift, from where the platform rests', () => {
    const { elevator, shaft, deck, rest } = dressed()
    elevator.dress({ shaft, deck })
    for (const rise of [0, 50, int01.rise]) {
      elevator.setRise(rise)
      elevator.object.updateWorldMatrix(true, true)
      deck.geometry.computeBoundingBox()
      const centre = (deck.geometry.boundingBox as THREE.Box3)
        .getCenter(new THREE.Vector3())
        .applyMatrix4(deck.matrixWorld)
      expect(centre.x, `x at rise ${rise}`).toBeCloseTo(rest.x, 6)
      expect(centre.y, `y at rise ${rise}`).toBeCloseTo(rest.y + rise, 6)
      expect(centre.z, `z at rise ${rise}`).toBeCloseTo(rest.z, 6)
    }
  })

  it("keeps 2016's shaft standing through the release, as the walls did, and the deck goes with the lift", () => {
    const { elevator, shaft, deck } = dressed()
    elevator.dress({ shaft, deck })
    const visibleInWorld = (o: THREE.Object3D) => {
      for (let n: THREE.Object3D | null = o; n; n = n.parent) if (!n.visible) return false
      return true
    }
    elevator.setReleased(true)
    expect(visibleInWorld(shaft), 'shaft after release').toBe(true)
    expect(visibleInWorld(deck), 'deck after release').toBe(false)
    // A retry un-releases: the GENERATED dead segments' own flags come back on,
    // and must still not draw.
    elevator.setReleased(false)
    const generated = elevator.object.getObjectByName('elevator-shaft') as THREE.Object3D
    for (const segment of generated.children)
      expect(visibleInWorld(segment), 'a generated segment after a retry').toBe(false)
    expect(visibleInWorld(deck), 'deck after a retry').toBe(true)
  })
})

// ── 2016's rig, from the real file ───────────────────────────────────────────

describe.skipIf(!AVAILABLE)("2016's launch rig, from hangar-room.glb", () => {
  it('wears ONE unlit material, so no light in the mission scene reaches it and it compiles one program', async () => {
    // The first build lit it with the mission's own lights, and 2016's
    // near-white shaft went white for the whole climb under a four-degree sun.
    const art = assembleLaunchArt(await parse())
    const pieces = [art.room, art.lamps, art.shaft, art.deck]
    const materials = new Set(pieces.map((m) => m.material))
    expect(materials.size, 'one material for the whole rig').toBe(1)
    const [material] = [...materials] as THREE.Material[]
    expect((material as THREE.MeshBasicMaterial).isMeshBasicMaterial, 'unlit').toBe(true)
    expect((material as THREE.MeshBasicMaterial).vertexColors, 'its light is in the vertices').toBe(
      true,
    )
  })

  it("bakes 2016's room light in, the spot over the lift included, face by face", async () => {
    const art = assembleLaunchArt(await parse())
    // The same file with every face moved a thousand kilometres from the spot
    // before it is lit — the key is a direction and the ambient a sky, so only
    // the spot's term changes. The deck stands under it in the menu, where it is
    // lit: its up-facing faces must come out brighter with the spot in reach.
    const sampler = roomLightSampler()
    const far = new THREE.Vector3(1e6, 0, 1e6)
    const noSpot = (c: THREE.Vector3, n: THREE.Vector3, t: THREE.Color) =>
      sampler(c.clone().add(far), n, t)
    const dimmer = assembleLaunchArt(await parse(), undefined, noSpot)
    const a = art.deck.geometry.getAttribute('color')
    const b = dimmer.deck.geometry.getAttribute('color')
    let brighter = 0
    let darker = 0
    for (let i = 0; i < a.count; i++) {
      const d = a.getX(i) + a.getY(i) + a.getZ(i) - (b.getX(i) + b.getY(i) + b.getZ(i))
      if (d > 1e-6) brighter++
      if (d < -1e-6) darker++
    }
    expect(darker, 'no face loses light').toBe(0)
    expect(brighter, 'and the faces the spot reaches gain it').toBeGreaterThan(a.count / 4)
  })

  it('stacks the eight segments 12 m apart, as the MISSION rig does — not 8.8 as the menu does', async () => {
    const art = assembleLaunchArt(await parse())
    const facts = roomFactsOf((await parse()).getObjectByName('hangar-room') as THREE.Object3D)
    const ys = [...int01.shaft.liveSegmentLocalY, ...int01.shaft.deadSegmentLocalY].sort(
      (a: number, b: number) => a - b,
    )
    expect(facts.shaftRepeats.length).toBe(ys.length)
    // appendTo stacks one segment after another, vertex for vertex, so vertex i
    // of segment k+1 is vertex i of segment k moved by one spacing.
    const p = art.shaft.geometry.getAttribute('position')
    const n = p.count / ys.length
    for (let k = 0; k + 1 < ys.length; k++) {
      for (const i of [0, Math.floor(n / 3), n - 1]) {
        const a = new THREE.Vector3().fromBufferAttribute(p, k * n + i)
        const b = new THREE.Vector3().fromBufferAttribute(p, (k + 1) * n + i)
        expect(b.y - a.y, `segment ${k + 2} over ${k + 1}`).toBeCloseTo(ys[k + 1] - ys[k], 3)
        expect(Math.hypot(b.x - a.x, b.z - a.z), 'straight up').toBeLessThan(1e-3)
      }
    }
    // And the lowest one starts where the level JSON's lowest segment is, in
    // `Position_adjustment`'s frame moved to the ship's.
    const floor = -(int01.platform.shipOffset[1] + LAUNCH.reveal.animatedNodeRestY)
    art.shaft.geometry.computeBoundingBox()
    expect((art.shaft.geometry.boundingBox as THREE.Box3).min.y).toBeCloseTo(ys[0] + floor, 1)
  })

  it("stands the deck where the mission rig does, round Unity's own deck box, at full size", async () => {
    const loaded = await parse()
    const art = assembleLaunchArt(loaded)
    const facts = roomFactsOf(loaded.getObjectByName('hangar-room') as THREE.Object3D)
    const deck = pointsOf(art.deck.geometry)
    const bottom = Math.min(...deck.map((p) => p.y))
    const top = Math.max(...deck.map((p) => p.y))
    // The dish's mesh starts at its own origin (its AABB runs 0 .. 2 x extent
    // in y), and the level JSON places that origin at `offset - shipOffset`:
    // `tools/extract/level.mjs`'s reading of the MISSION's Projector, which
    // never went through `fromRoom`. The menu's deck, un-lifted, is 0.51 m low.
    const [, oy] = int01.platform.offset as [number, number, number]
    const [, sy] = int01.platform.shipOffset as [number, number, number]
    expect(bottom, "the deck's foot, where the mission stands it").toBeCloseTo(oy - sy, 2)
    // Unity's `Cube` under `Elevator_animator` — a unit box placed by its
    // transform alone, through no importer — stands at the same local place in
    // both rigs, so `fromRoom` alone takes the menu's to the mission's. The
    // collider's top lies inside the dish's thickness, and the dish round it.
    const box = facts.elevatorDeck.corners.map((c) =>
      new THREE.Vector3(...c).applyMatrix4(launchFromRoom()),
    )
    const boxTop = box.reduce((s, c) => s + c.y, 0) / box.length
    expect(boxTop, "Unity's box top, inside the dish").toBeGreaterThan(bottom)
    expect(boxTop).toBeLessThan(top)
    const boxCentre = box
      .reduce((s, c) => s.add(c), new THREE.Vector3())
      .multiplyScalar(1 / box.length)
    // Full size: the dish reaches the level JSON's half-width (the mesh's own
    // AABB times its prefab scale) — at the menu's 0.85 it would fall short.
    const centre = new THREE.Box3().setFromPoints(deck).getCenter(new THREE.Vector3())
    // A faceted dish and a collider drawn round it: 0.34 m here, 0.20 in the
    // menu's frame — an axis-aligned box's centre moves when the dish turns
    // under it, and this frame is turned 7.9 degrees from that one.
    expect(Math.hypot(centre.x - boxCentre.x, centre.z - boxCentre.z), 'deck to box').toBeLessThan(
      0.4,
    )
    const reach = Math.max(...deck.map((p) => Math.hypot(p.x - centre.x, p.z - centre.z)))
    const [w, , d] = int01.platform.size as [number, number, number]
    expect(reach).toBeGreaterThan(Math.max(w, d) / 2 - 0.05)
    expect(reach).toBeLessThan(Math.hypot(w, d) / 2 + 0.05)
    // Under the ship, and under the lift's axis.
    expect(top, 'the deck is under the ship').toBeLessThan(0)
    const axis = new THREE.Vector3().applyMatrix4(launchFromRoom())
    expect(Math.hypot(centre.x - axis.x, centre.z - axis.z), 'centred on the lift').toBeLessThan(
      0.6,
    )
  })

  it('seals the ride: nothing sideways gets out of the shaft until the world is already on', async () => {
    const art = assembleLaunchArt(await parse())
    const shaft = new THREE.Mesh(
      art.shaft.geometry,
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    )
    shaft.updateMatrixWorld(true)
    const ray = new THREE.Raycaster()
    ray.far = 14
    const escaping = (rise: number) => {
      const eye = new THREE.Vector3(EYE.x, EYE.y + rise, EYE.z)
      let out = 0
      for (let a = 0; a < 360; a += 5) {
        const r = (a * Math.PI) / 180
        ray.set(eye, new THREE.Vector3(Math.cos(r), 0, Math.sin(r)))
        if (ray.intersectObject(shaft).length === 0) out++
      }
      return out / 72
    }
    // Inside the shaft (it starts over the room), every sideways look meets a wall.
    for (const rise of [12, 30, 60, 90, REVEAL_RISE]) expect(escaping(rise), `rise ${rise}`).toBe(0)
    // And the eye does clear it — before the ride ends: 2016's last frame, the
    // shaft head just under the eye (video f0055).
    expect(escaping(int01.rise), 'at the release').toBeGreaterThan(0.5)
    // Where it clears, the world is already drawn: DEV-106's order, kept.
    let clears = REVEAL_RISE
    while (clears < int01.rise && escaping(clears) < 0.5) clears += 0.25
    expect(clears, 'the eye clears the rim after the reveal').toBeGreaterThan(REVEAL_RISE + 2)
  }, 60_000)

  it('closes the room round the eye at rest: only the bore looks out', async () => {
    const art = assembleLaunchArt(await parse())
    const group = new THREE.Group()
    for (const m of [art.room, art.shaft, art.deck])
      group.add(new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })))
    group.updateMatrixWorld(true)
    const ray = new THREE.Raycaster()
    ray.far = 60
    const eye = EYE.clone()
    const escaped: number[] = []
    for (let el = -80; el <= 70; el += 10) {
      for (let az = 0; az < 360; az += 10) {
        const e = (el * Math.PI) / 180
        const a = (az * Math.PI) / 180
        ray.set(
          eye,
          new THREE.Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)),
        )
        if (ray.intersectObject(group, true).length === 0) escaped.push(el)
      }
    }
    expect(escaped, 'directions below 70 degrees that leave the room').toEqual([])
  })
})

// ── The hook, on the real room group ──────────────────────────────────────────

describe.skipIf(!AVAILABLE)('createLaunchArt, in the launch room', () => {
  const launchRoom = () =>
    createHangar({
      spec: hangarSpecFor(),
      seed: 0x48414e47,
      furnished: false,
      title: '',
      subtitle: '',
      level: null,
    })

  it("stands 2016's room in the anchor's frame, whatever the launch room's own turn", async () => {
    const room = launchRoom()
    expect(room.object.rotation.y, 'the room group IS turned').not.toBe(0)
    const anchor = new THREE.Group()
    anchor.add(room.object)
    const elevator = buildElevator()
    anchor.add(elevator.object)
    const loaded = await parse()
    const ok = await createLaunchArt({
      room: room.object,
      lift: elevator,
      alive: () => true,
      load: async () => loaded,
    }).ready
    expect(ok).toBe(true)
    anchor.updateMatrixWorld(true)
    const placed = room.object.getObjectByName('launch-room-2016') as THREE.Mesh
    const direct = assembleLaunchArt(await parse())
    const a = pointsOf(placed.geometry, placed.matrixWorld)
    const b = pointsOf(direct.room.geometry)
    for (const i of [0, Math.floor(a.length / 2), a.length - 1])
      expect((a[i] as THREE.Vector3).distanceTo(b[i] as THREE.Vector3), `vertex ${i}`).toBeLessThan(
        1e-3,
      )
    for (const name of LAUNCH_ROOM_REPLACES)
      expect(room.object.getObjectByName(name)?.visible, `${name} hidden`).toBe(false)
    expect(room.object.getObjectByName('launch-room-lamp')?.visible, 'the lamp stays').toBe(true)
    expect(elevator.object.getObjectByName('elevator-shaft-2016')).toBeDefined()
  })

  it('drops a landing that comes after the gate, and a load that fails, leaving the generated rig', async () => {
    for (const how of ['late', 'failed'] as const) {
      const room = launchRoom()
      const elevator = buildElevator()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ok = await createLaunchArt({
        room: room.object,
        lift: elevator,
        alive: () => how !== 'late',
        load: how === 'failed' ? async () => Promise.reject(new Error('404')) : parse,
      }).ready
      warn.mockRestore()
      expect(ok, how).toBe(false)
      expect(room.object.getObjectByName('launch-room-2016'), how).toBeUndefined()
      for (const name of LAUNCH_ROOM_REPLACES)
        expect(room.object.getObjectByName(name)?.visible, `${how}: ${name}`).toBe(true)
      expect(elevator.object.getObjectByName('elevator-shaft-wall')?.visible, how).toBe(true)
    }
  })
})

// The loud counterpart asserts only in a HYDRATED maintainer checkout: these are BOUGHT assets,
// which the public export and its content pack never carry (plan/PUBLIC-REPO-facetedflight.md
// §4.3, Matt M4), and a plain clone of this repo (its CI runner) never pulls them: both
// skip both halves. tests/unit/helpers/checkout.ts.
describe.skipIf(AVAILABLE || !HYDRATED_MAINTAINER_CHECKOUT)(
  "2016's launch rig: hangar-room.glb is not hydrated",
  () => {
    it('says so, rather than passing quietly', () => {
      expect(
        fs.existsSync(FILE),
        'run tools/assets/convert-hangar-art.mjs (or pnpm assets:pull) to measure the launch rig',
      ).toBe(true)
    })
  },
)
