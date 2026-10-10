/**
 * tests/unit/hangar-load.test.ts — a course switch waited out IN the room.
 * DEV-465.
 *
 * Matt, 2026-09-27: *"would it be possible to stay in the hangar, but show the
 * loading indicator and spinning logo? (maybe hide the holo-tables that
 * weren't the last selected one)"*.
 *
 * Four pieces, each against something outside itself:
 *
 *   - `boot/load-place.ts`, the rule, as a table of cases. The case that
 *     matters is the LOOK: a Classic-look boarding must keep the loading
 *     scene, because DEV-451's flip needs a black and the room never wears
 *     Classic (D35).
 *   - the plate in the room as GEOMETRY: its lower edge, seen from the seat's
 *     eye, clears the tallest furniture on the tables' arc — measured off the
 *     ROOM'S OWN MESHES as `createHangar` builds them, never off this file's
 *     idea of where they are.
 *   - `HangarArt.focus`: one table left, the plates and the header down,
 *     nothing aimable, and it holds through a re-lay of the step.
 *   - the primer: zero-area, and in exactly the plate's materials with the
 *     attribute set of the mesh each one primes (two attributes are in three's
 *     program key).
 */
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type LoadPlaceQuestion, loadingPlaceFor } from '@/boot/load-place'
import type { Difficulty } from '@/content/level-schema'
import type { MissionCard } from '@/game/mission-index'
import { createHangar, type HangarArt, seatEyeLocal, seatPitchLocal } from '@/render/hangar'
import {
  createLoadingScene,
  LOADING_PLATE_PITCH_MAX,
  LOADING_ROOM_PITCH_MAX,
  LOADING_ROOM_PITCH_MIN,
  type LoadingPlace,
  plateElevation,
  yawFacing,
} from '@/render/loading-scene'
import { hangarSpecFor } from '@/sim/hangar'
import { appSource } from './helpers/app-source'
import { REPO as ROOT } from './helpers/repo-root'

// ── fixtures ──────────────────────────────────────────────────────────────

/** A 2d context that answers every call and measures every string as 10 px. */
const stubCanvas = (): void => {
  const ctx = new Proxy(
    {},
    {
      get: (_t, key) => (key === 'measureText' ? () => ({ width: 10 }) : () => undefined),
      set: () => true,
    },
  )
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx }),
  })
}

const TEXT = {
  kicker: 'HoverJet · Ring Attack · Intermediate',
  title: 'Intermediate 1 - HoverJet',
  status: 'Loading Simonet Islands…',
  fraction: 0.25,
}

const NAMES: Record<Difficulty, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  professional: 'Professional',
}

/** A Ring Attack course: its place table carries the difficulty as marks (DEV-420). */
const card = (id: string, environment: string, difficulty: Difficulty, chain: number) =>
  ({
    id,
    title: id,
    vehicle: 'hoverjet',
    difficulty,
    chainIndex: chain,
    environment,
    mode: 'ringAttack',
    vehicleName: 'HoverJet',
    difficultyName: NAMES[difficulty],
    modeName: 'Ring Attack',
    environmentName: environment,
    best: null,
    medal: null,
  }) satisfies MissionCard

/** Two places, three ranks each: two place tables with a column of three marks. */
const CARDS: readonly MissionCard[] = [
  card('simonet_b', 'simonetIslands', 'beginner', 0),
  card('simonet_i', 'simonetIslands', 'intermediate', 1),
  card('simonet_p', 'simonetIslands', 'professional', 2),
  card('alpine_b', 'alpineForest', 'beginner', 3),
  card('alpine_i', 'alpineForest', 'intermediate', 4),
  card('alpine_p', 'alpineForest', 'professional', 5),
]

/**
 * The room, on the Ring Attack PLACE step — the step a Ring Attack course is
 * boarded from, and the one with the tallest furniture on it (the marks).
 * No island is drawn: `shapeFor` never answers, and an island is 12° under
 * everything this measures anyway.
 */
const roomOnPlaces = (): HangarArt => {
  const room = createHangar({
    spec: hangarSpecFor(),
    seed: 0x48414e47,
    title: '',
    subtitle: '',
    level: null,
    missions: CARDS,
    currentId: 'simonet_i',
    shapeFor: () => new Promise(() => {}),
  })
  room.openVehicle(0)
  room.openMode(0)
  expect(room.view, 'the walk reached the place step').toBe('courses')
  return room
}

/** The table groups the room holds, by the course each stands for. */
const tablesOf = (room: HangarArt): THREE.Object3D[] => {
  const out: THREE.Object3D[] = []
  room.object.traverse((o) => {
    if (o.name === 'hangar-holotable') out.push(o)
  })
  return out
}

/** Is `o` drawn — itself and every ancestor visible, as three's `projectObject` asks? */
const drawn = (o: THREE.Object3D): boolean => {
  for (let n: THREE.Object3D | null = o; n; n = n.parent) if (!n.visible) return false
  return true
}

/** The seat's eye in world space, the room at the origin as `boot/app.ts` leaves it. */
const seatEye = (room: HangarArt): THREE.Vector3 => {
  room.object.updateWorldMatrix(true, true)
  const local = seatEyeLocal(hangarSpecFor())
  return new THREE.Vector3(local.x, local.y, local.z).applyMatrix4(room.object.matrixWorld)
}

/** Elevation of `p` from `eye`, radians. */
const elevation = (eye: THREE.Vector3, p: THREE.Vector3): number =>
  Math.asin((p.y - eye.y) / p.distanceTo(eye))

/** The highest any drawn vertex under `root` stands, as an elevation from `eye`. */
const topOf = (root: THREE.Object3D, eye: THREE.Vector3): number => {
  let top = Number.NEGATIVE_INFINITY
  const v = new THREE.Vector3()
  root.updateWorldMatrix(true, true)
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !drawn(mesh)) return
    const pos = mesh.geometry.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
      top = Math.max(top, elevation(eye, v))
    }
  })
  return top
}

/** The top of everything the drawn TABLES hold, as an elevation from `eye`. */
const arcTop = (room: HangarArt, eye: THREE.Vector3): number =>
  Math.max(
    ...tablesOf(room)
      .filter(drawn)
      .map((t) => topOf(t, eye)),
  )

/** The plate's LOWEST corner as an elevation from `eye`. */
const plateBottom = (
  loading: ReturnType<typeof createLoadingScene>,
  eye: THREE.Vector3,
): number => {
  const plate = loading.object.getObjectByName('loading-plate') as THREE.Mesh
  loading.object.updateWorldMatrix(true, true)
  const pos = plate.geometry.getAttribute('position')
  const v = new THREE.Vector3()
  let low = Number.POSITIVE_INFINITY
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(plate.matrixWorld)
    low = Math.min(low, elevation(eye, v))
  }
  return low
}

/** A head at `eye` looking at the gaze sphere over `table`, as the press needs it to. */
const lookingAt = (eye: THREE.Vector3, table: THREE.Object3D): THREE.Vector3 => {
  const at = table.getWorldPosition(new THREE.Vector3())
  const flat = new THREE.Vector3(at.x - eye.x, 0, at.z - eye.z).normalize()
  // The seat's own pitch: the one that lands on every table's gaze sphere.
  const pitch = seatPitchLocal()
  return new THREE.Vector3(flat.x * Math.cos(pitch), Math.sin(pitch), flat.z * Math.cos(pitch))
}

const DEG = Math.PI / 180

/**
 * The flat camera's vertical lens, degrees: `render/renderer.ts` builds it at
 * 70, and in the room nothing moves it (Anniversary's `flatFov` opens with
 * airspeed, and `base` is null). Read out of the renderer's source rather than
 * retyped, so a new lens moves this test with it.
 */
const FLAT_VFOV_DEG = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'src/render/renderer.ts'), 'utf8')
  const m = /new THREE\.PerspectiveCamera\(\s*(\d+(?:\.\d+)?)\s*,/.exec(src)
  if (!m) throw new Error('renderer.ts: no PerspectiveCamera(<fov>, …) to read the lens from')
  return Number(m[1])
})()

/** The title's logo, the emblem the plate stands (DEV-434). Gitignored, so optional. */
const LOGO = path.join(ROOT, 'public/assets/props/title-logo.glb')
const LOGO_ON_DISK = fs.existsSync(LOGO)
const parseLogo = async (): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(LOGO)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

beforeEach(() => {
  vi.unstubAllGlobals()
  stubCanvas()
})

// ── the rule ──────────────────────────────────────────────────────────────

describe('loadingPlaceFor — where a switch is waited out (DEV-465)', () => {
  const inRoom: LoadPlaceQuestion = {
    screen: 'menu',
    moving: false,
    roomUp: true,
    bound: false,
    worn: 'anniversary',
    mission: 'anniversary',
  }

  it('a press in the room, the look already the mission’s, waits in the room', () => {
    expect(loadingPlaceFor(inRoom)).toBe('room')
  })

  it('a CLASSIC look keeps the loading scene: its flip needs a black, and the room never wears it', () => {
    expect(loadingPlaceFor({ ...inRoom, mission: 'classic' })).toBe('scene')
    // And the other way round, which D35 makes unreachable but the rule must
    // not care about: whatever the room wears, a DIFFERENT look is a flip.
    expect(loadingPlaceFor({ ...inRoom, worn: 'classic', mission: 'anniversary' })).toBe('scene')
  })

  it('anywhere but the room — the title, a mission — or on the way somewhere, the scene', () => {
    const cases: [string, Partial<LoadPlaceQuestion>][] = [
      ['from the title', { screen: 'title' }],
      ['from inside a mission', { screen: 'mission' }],
      ['with a screen change queued', { moving: true }],
      ['with the room down', { roomUp: false }],
      ['bound for the scene already (Quick Race, Learn to Fly)', { bound: true }],
    ]
    for (const [why, change] of cases) {
      expect(loadingPlaceFor({ ...inRoom, ...change }), why).toBe('scene')
    }
  })
})

// ── the plate in the room, as geometry ────────────────────────────────────

describe('the plate in the room clears the tables (DEV-465)', () => {
  it('its lower edge stands above the tallest furniture on the arc, wherever the head looks', () => {
    const room = roomOnPlaces()
    const eye = seatEye(room)
    const tables = tablesOf(room).filter(drawn)
    expect(tables.length, 'two place tables are up').toBe(2)
    // What the tables hold on this step — plinth, rim, label, the column of
    // marks — measured off the meshes. The header is set aside: it is hidden
    // while the room loads (`focus`), and a test below says why.
    const furniture = arcTop(room, eye)
    // Sanity: the arc is below the eye, and it is not nothing (the marks and
    // labels stand ~10° under it).
    expect(furniture).toBeLessThan(0)
    expect(furniture).toBeGreaterThan(-15 * DEG)

    const loading = createLoadingScene()
    const heads: THREE.Vector3[] = [
      // At each table, as the press that boarded it did.
      ...tables.map((t) => lookingAt(eye, t)),
      // And the band's edges: straight down, straight ahead, well up.
      new THREE.Vector3(0.3, -0.99, -0.1),
      new THREE.Vector3(-0.6, 0, -0.8),
      new THREE.Vector3(0.2, 0.9, -0.4),
    ]
    for (const head of heads) {
      loading.show(eye, yawFacing(head), plateElevation(head, 'room'), TEXT, 'room')
      const bottom = plateBottom(loading, eye)
      // Two degrees of air at least: a plate resting on the marks would read
      // as the room's furniture, and the marks' own gaze windows are 2.2°.
      expect(
        bottom - furniture,
        `head ${head.toArray().map((n) => n.toFixed(2))}: the plate clears the arc`,
      ).toBeGreaterThan(2 * DEG)
    }
  })

  it('the scene’s band would not — which is why the room has its own', () => {
    // The loading scene's plate goes where the head looks, down to 30° under
    // the eye: at a table that is through its island. Held to the same
    // measurement, it fails, so the room band above is doing the work.
    const room = roomOnPlaces()
    const eye = seatEye(room)
    const table = tablesOf(room).filter(drawn)[0] as THREE.Object3D
    const furniture = arcTop(room, eye)
    const loading = createLoadingScene()
    const head = lookingAt(eye, table)
    loading.show(eye, yawFacing(head), plateElevation(head, 'scene'), TEXT, 'room')
    expect(plateBottom(loading, eye)).toBeLessThan(furniture)
  })

  it('the step header is inside the plate’s band, so the room hides it while it loads', () => {
    const room = roomOnPlaces()
    const eye = seatEye(room)
    const header = room.object.getObjectByName('hangar-header') as THREE.Object3D
    const withHeader = topOf(header, eye)
    const loading = createLoadingScene()
    const head = lookingAt(eye, tablesOf(room).filter(drawn)[0] as THREE.Object3D)
    loading.show(eye, yawFacing(head), plateElevation(head, 'room'), TEXT, 'room')
    // The header's top is above the plate's lower edge: left up, it would
    // stand in front of the plate. `focus` takes it down (below).
    expect(withHeader).toBeGreaterThan(plateBottom(loading, eye))
    room.focus('simonet_i')
    expect(header.visible).toBe(false)
  })

  describe.skipIf(!LOGO_ON_DISK)('with the real emblem over it', () => {
    it('the plate AND its emblem fit a flat frame looking at the pressed table', async () => {
      // Flat, the seat rests looking at the tables (`seatPitchLocal`, 22.8°
      // down) through the renderer's 70° lens, so the frame's top edge is
      // 12.2° above the eye line. The emblem stands over the plate, so it is
      // the stack's top that has to be in the frame — photographed cut off
      // at its top before this test existed.
      const room = roomOnPlaces()
      const eye = seatEye(room)
      const table = tablesOf(room).filter(drawn)[0] as THREE.Object3D
      const head = lookingAt(eye, table)
      const loading = createLoadingScene()
      expect(loading.emblem(await parseLogo())).toBe(true)
      loading.show(eye, yawFacing(head), plateElevation(head, 'room'), TEXT, 'room')
      const stackTop = Math.max(
        topOf(loading.object.getObjectByName('loading-emblem') as THREE.Object3D, eye),
        topOf(loading.object.getObjectByName('loading-wordmark') as THREE.Object3D, eye),
      )
      const frameTop = seatPitchLocal() + (FLAT_VFOV_DEG / 2) * DEG
      expect(frameTop - stackTop, 'a degree of frame above the emblem').toBeGreaterThan(1 * DEG)
      // And still clear of the tables below it.
      expect(plateBottom(loading, eye) - arcTop(room, eye)).toBeGreaterThan(2 * DEG)
    })
  })
  describe.skipIf(LOGO_ON_DISK)('without the logo on disk (gitignored, hard rule 7)', () => {
    it('says so, loudly: the emblem’s half of the frame fit is not measured here', () => {
      expect(LOGO_ON_DISK).toBe(false)
    })
  })

  it('the room band is narrow and about the eye line: a plate over the tables, never down at them', () => {
    // The two geometry tests above are what hold the numbers; this holds the
    // band's shape, so a head looking down cannot drag the plate after it.
    expect(LOADING_ROOM_PITCH_MIN).toBeGreaterThan(-3 * DEG)
    expect(LOADING_ROOM_PITCH_MAX).toBeLessThanOrEqual(LOADING_PLATE_PITCH_MAX)
    for (const y of [-1, -0.4, 0, 0.05, 0.5, 1]) {
      const e = plateElevation(new THREE.Vector3(0.3, y, -0.9), 'room')
      expect(e).toBeGreaterThanOrEqual(LOADING_ROOM_PITCH_MIN)
      expect(e).toBeLessThanOrEqual(LOADING_ROOM_PITCH_MAX)
    }
  })

  it('in the room the plate stands alone: the scene’s dome and ground stay down', () => {
    const loading = createLoadingScene()
    const dome = loading.object.getObjectByName('loading-dome') as THREE.Object3D
    const ground = loading.object.getObjectByName('loading-ground') as THREE.Object3D
    const plate = loading.object.getObjectByName('loading-plate') as THREE.Object3D
    const at = (where: LoadingPlace) => {
      loading.show(new THREE.Vector3(), 0, 0, TEXT, where)
      return {
        dome: dome.visible,
        ground: ground.visible,
        plate: drawn(plate),
        place: loading.place,
      }
    }
    expect(at('room')).toEqual({ dome: false, ground: false, plate: true, place: 'room' })
    expect(at('scene')).toEqual({ dome: true, ground: true, plate: true, place: 'scene' })
    loading.hide()
    expect(loading.place).toBeNull()
  })
})

// ── the room, focused ─────────────────────────────────────────────────────

describe('HangarArt.focus — one table left while the course loads (DEV-465)', () => {
  const shown = (room: HangarArt) =>
    tablesOf(room)
      .filter(drawn)
      .map((t) => t.userData.missionId as string)

  it('leaves the chosen course’s table and takes down the rest, the plates and the header', () => {
    const room = roomOnPlaces()
    expect(shown(room).sort()).toEqual(['alpine_b', 'simonet_i'])
    const plates = ['hangar-page-prev', 'hangar-page-next'].map(
      (n) => room.object.getObjectByName(n) as THREE.Object3D,
    )
    const platesBefore = plates.map((p) => p.visible)
    room.focus('simonet_i')
    expect(room.focused).toBe('simonet_i')
    expect(shown(room)).toEqual(['simonet_i'])
    expect(plates.map((p) => p.visible)).toEqual([false, false])
    expect((room.object.getObjectByName('hangar-header') as THREE.Object3D).visible).toBe(false)
    // And back, exactly as the step lays it.
    room.focus(null)
    expect(room.focused).toBeNull()
    expect(shown(room).sort()).toEqual(['alpine_b', 'simonet_i'])
    expect(plates.map((p) => p.visible)).toEqual(platesBefore)
    expect((room.object.getObjectByName('hangar-header') as THREE.Object3D).visible).toBe(true)
  })

  it('a course no table on the step stands for leaves none (a room’s START)', () => {
    const room = roomOnPlaces()
    room.focus('kauai_x')
    expect(shown(room)).toEqual([])
  })

  it('nothing is aimable while it holds — not even the chosen table, dead centre', () => {
    const room = roomOnPlaces()
    const eye = seatEye(room)
    const table = tablesOf(room).find((t) => t.userData.missionId === 'simonet_i') as THREE.Object3D
    const head = lookingAt(eye, table)
    expect(room.gaze(eye, head), 'the table is aimable before').toBe(true)
    room.focus('simonet_i')
    expect(room.gaze(eye, head)).toBe(false)
    expect(room.aim).toBeNull()
    expect(room.choose(), 'a press boards nothing').toBeNull()
  })

  it('holds through a re-lay of the step (`setCurrent`, a page)', () => {
    // The same current: during a load nothing can move a pick (the marks are
    // not aimable, and `boot/app.ts` moves `setCurrent` to the black).
    const room = roomOnPlaces()
    room.focus('simonet_i')
    room.setCurrent('simonet_i')
    expect(shown(room)).toEqual(['simonet_i'])
    room.turnPage(1)
    expect(shown(room)).toEqual(['simonet_i'])
  })

  it('moves no light: a table’s lamps are the room’s, focused or not', () => {
    const room = roomOnPlaces()
    const lights = (): number => {
      let n = 0
      room.object.traverse((o) => {
        if ((o as THREE.Light).isLight && drawn(o)) n++
      })
      return n
    }
    const before = lights()
    room.focus('simonet_i')
    expect(lights(), 'the light count is in every lit program’s key').toBe(before)
  })
})

// ── the primer ────────────────────────────────────────────────────────────

describe('the loading plate’s primer (DEV-465)', () => {
  it('draws nothing: every triangle has no area', () => {
    const loading = createLoadingScene()
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    let meshes = 0
    loading.primer.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      meshes++
      expect(mesh.frustumCulled, `${mesh.name} is never culled`).toBe(false)
      const pos = mesh.geometry.getAttribute('position')
      for (let i = 0; i + 2 < pos.count; i += 3) {
        a.fromBufferAttribute(pos, i)
        b.fromBufferAttribute(pos, i + 1).sub(a)
        c.fromBufferAttribute(pos, i + 2).sub(a)
        expect(b.cross(c).length()).toBe(0)
      }
    })
    expect(meshes).toBeGreaterThan(0)
  })

  it('is in every material the plate draws with past the gem, with that mesh’s attribute set', () => {
    const loading = createLoadingScene()
    const primed = new Map<THREE.Material, THREE.Mesh>()
    loading.primer.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh) primed.set(mesh.material as THREE.Material, mesh)
    })
    const signature = (g: THREE.BufferGeometry): string =>
      Object.entries(g.attributes)
        .map(([name, attr]) => `${name}:${attr.itemSize}`)
        .sort()
        .join(',')
    // The plate and everything on it, and the ground whose paper the emblem
    // shares. The gem is freed when the emblem arrives; its program is the
    // track's (both a plain colour, not tone-mapped).
    const drawnWith: THREE.Mesh[] = []
    const plate = loading.object.getObjectByName('loading-plate') as THREE.Object3D
    plate.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh && mesh.name !== 'loading-gem') drawnWith.push(mesh)
    })
    drawnWith.push(loading.object.getObjectByName('loading-ground') as THREE.Mesh)
    for (const mesh of drawnWith) {
      const primer = primed.get(mesh.material as THREE.Material)
      expect(primer, `${mesh.name}'s material is primed`).toBeDefined()
      expect(signature((primer as THREE.Mesh).geometry), `${mesh.name}: the same attributes`).toBe(
        signature(mesh.geometry),
      )
    }
  })

  it('app.ts hangs it in the ROOM’s scene, beside the loading scene', () => {
    const app = appSource()
    expect(app).toContain('menuScene.add(loadingScene.primer)')
  })
})

describe('the place step names what its marks are for (Flow A, DEV-858)', () => {
  it('stands one caption line under the header on the place step, and puts it away a step up', () => {
    const room = roomOnPlaces()
    const caption = (): THREE.Object3D | undefined => room.object.getObjectByName('hangar-caption')
    expect(caption(), 'the room built the caption for the place step').toBeDefined()
    expect(caption()?.visible, 'up where a place stands difficulty marks').toBe(true)
    const header = room.object.getObjectByName('hangar-header') as THREE.Object3D
    // Under the header: lower, on the same bearing.
    expect(caption()?.position.y, 'lower than the header').toBeLessThan(header.position.y)
    expect(caption()?.position.x).toBeCloseTo(header.position.x, 9)
    expect(caption()?.position.z).toBeCloseTo(header.position.z, 9)
    room.goBack()
    expect(room.view).not.toBe('courses')
    expect(caption()?.visible, 'gone a step up').toBe(false)
  })

  it('stands a LEGEND line OVER the header (DEV-884), in the caption group, so it hides with it', () => {
    const room = roomOnPlaces()
    const group = room.object.getObjectByName('hangar-caption') as THREE.Object3D
    const legend = room.object.getObjectByName('hangar-legend') as THREE.Object3D
    expect(legend, 'the legend line is built with the caption').toBeDefined()
    expect(legend.parent, 'in the caption group').toBe(group)
    // Over the header (the caption is under it, 0.075 m below; the legend 0.075 m above).
    expect(legend.position.y, 'above the caption line').toBeGreaterThan(0)
    const header = room.object.getObjectByName('hangar-header') as THREE.Object3D
    expect(group.position.y + legend.position.y, 'over the header').toBeGreaterThan(
      header.position.y,
    )
  })
})
