// tests/unit/course-shelf.test.ts: CUSTOM COURSES (YOUR COURSES until DEV-558)
// on the hangar's holotables. DEV-488.
//
// A REAL room (`createHangar`, the canvas stubbed as `hangar-load.test.ts`
// stubs it) wrapped by `withYourCourses`, with a library of real player
// courses expanded against `int_01_hoverJet`. Every claim is measured off the
// room's own meshes or through the wrapped room's own calls — the gaze a head
// makes, the press, `focus` as the app calls it — never read back off the
// shelf's own state alone.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { validateLevel } from '@/content/level-schema'
import { expandPlayerCourse, type PlayerCourse, playerCourseId } from '@/content/player-course'
import { courseTitle, type LibraryEntry } from '@/game/course-library'
import { cardFor, type MissionCard } from '@/game/mission-index'
import { validateModeContent } from '@/game/modes'
import {
  actionLines,
  byLocation,
  courseLines,
  doorBearing,
  doorLines,
  MAKE_A_COURSE_ACTION,
  OPEN_COURSE_FILE_ACTION,
  SHELF_LENT,
  SHELF_NAMES,
  type ShelfAction,
  shelfHeader,
  shelfItems,
  shelfPages,
  withYourCourses,
  YOUR_COURSES,
  type YourCourses,
} from '@/render/course-shelf'
import { baseFovFor } from '@/render/flat-fov'
import {
  BACK_WORDS,
  createHangar,
  GAZE_RADIUS,
  type HangarArt,
  HOLOTABLE_LOOK,
  PAGE_DWELL_SECONDS,
  SEAT_REST_BEARING,
  seatEyeLocal,
  seatPitchLocal,
  seatYawLocal,
  TABLE_HIGHLIGHT_NAME,
  TABLES_PER_PAGE,
  tableBearings,
  tableGazeLocal,
} from '@/render/hangar'
import { hangarSpecFor } from '@/sim/hangar'
import int01 from '../../content/levels/int_01_hoverJet.json'

const REPO = process.cwd()
const DEG = Math.PI / 180
const SPEC = hangarSpecFor()

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

beforeEach(() => {
  vi.unstubAllGlobals()
  stubCanvas()
})

const card = (id: string, vehicle: string, environment: string) =>
  ({
    id,
    title: id,
    vehicle: vehicle as MissionCard['vehicle'],
    difficulty: 'beginner',
    chainIndex: null,
    environment,
    mode: 'ringAttack',
    vehicleName: vehicle,
    difficultyName: 'Beginner',
    modeName: 'Ring Attack',
    environmentName: environment,
    best: null,
    medal: null,
  }) satisfies MissionCard

/**
 * Two LOCATIONS (DEV-880: the door stands on the place step now, where it stood
 * on the aircraft step): the HoverJet's Ring Attack over Simonet and over Alpine.
 */
const TWO = [card('hj_a', 'hoverjet', 'simonet'), card('hj_b', 'hoverjet', 'alpine')]
/** Three locations. */
const THREE_WIDE = [...TWO, card('hj_c', 'hoverjet', 'desert')]

type V = [number, number, number]
const DONOR = validateLevel(int01 as unknown as Level)

/** A course on 2016's own int_01 line, as `player-course-laps.test.ts` builds one. */
const course = (name: [string, string], every = 11): PlayerCourse => {
  const route = DONOR.route as V[]
  const points: V[] = []
  for (let i = 0; i < 12; i++) points.push(route[Math.round((i * (route.length - 1)) / every)] as V)
  return {
    v: 2,
    island: 'simonet',
    sky: DONOR.id,
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    path: { points: points.slice(0, 12), gap: 400 },
    rings: [],
    start: { pos: points[0] as V, yaw: 0 },
    finish: { t: 0.9 },
    timeLimit: 240,
    name,
  }
}

const entryOf = (c: PlayerCourse, date: number): LibraryEntry => ({
  id: playerCourseId(c),
  course: c,
  name: courseTitle(c),
  island: c.island,
  date,
  source: 'file',
})

const NAMES: [string, string][] = [
  ['Amber', 'Heron'],
  ['Bold', 'Comet'],
  ['Calm', 'Finch'],
  ['Deft', 'Falcon'],
  ['Eager', 'Gannet'],
]
const LIBRARY: LibraryEntry[] = NAMES.map((n, i) => entryOf(course(n), 100 - i))

interface Built {
  readonly room: HangarArt
  readonly shelf: YourCourses
  readonly base: HangarArt
  readonly boarded: string[]
  /** DEV-558: the action tables pressed, by id. */
  readonly acted: string[]
  editor: boolean
  entries: readonly LibraryEntry[]
}

const build = (
  cards = TWO,
  entries: readonly LibraryEntry[] = LIBRARY.slice(0, 2),
  actions: readonly ShelfAction[] = [],
  options: { readonly toPlaces?: boolean } = {},
): Built => {
  const base = createHangar({
    spec: SPEC,
    seed: 0x48414e47,
    title: '',
    subtitle: '',
    level: null,
    missions: cards,
    currentId: (cards[0] as MissionCard).id,
    shapeFor: () => new Promise(() => {}),
  })
  const built: Built = {
    base,
    boarded: [],
    acted: [],
    editor: true,
    entries,
    room: base,
    shelf: undefined as unknown as YourCourses,
  }
  const shelf = withYourCourses(base, {
    spec: SPEC,
    enabled: () => built.editor,
    entries: () => built.entries,
    levelFor: async (e) => validateModeContent(validateLevel(expandPlayerCourse(e.course, DONOR))),
    // No islands in node: a shape that never lands, as `hangar-load.test.ts` does.
    shapeOf: () => new Promise(() => {}),
    cardOf: (level) => cardFor(level, null),
    onBoard: (e) => built.boarded.push(e.id),
    actions: () => actions,
    onAction: (id) => built.acted.push(id),
  })
  // DEV-880: walk to the PLACE step (aircraft, then Ring Attack), where the door stands.
  if (options.toPlaces !== false) {
    shelf.hangar.openVehicle(0)
    shelf.hangar.openMode(0)
  }
  return Object.assign(built, { room: shelf.hangar, shelf })
}

const settle = () => new Promise((r) => setTimeout(r, 0))

/** The seat's eye in world space, the room where `boot/app.ts` leaves it. */
const eye = (room: HangarArt): THREE.Vector3 => {
  room.object.updateWorldMatrix(true, true)
  const local = seatEyeLocal(SPEC)
  return new THREE.Vector3(local.x, local.y, local.z).applyMatrix4(room.object.matrixWorld)
}

/** A head looking at the gaze sphere over a table at `bearing` (radians). */
const lookAtBearing = (room: HangarArt, bearing: number): boolean => {
  const from = eye(room)
  const c = tableGazeLocal(SPEC, bearing)
  const to = new THREE.Vector3(c.x, c.y, c.z).applyMatrix4(room.object.matrixWorld)
  return room.gaze(from, to.sub(from))
}

/** A head looking at a named object's origin. */
const lookAtObject = (room: HangarArt, name: string): boolean => {
  const target = room.object.getObjectByName(name) as THREE.Object3D
  target.updateWorldMatrix(true, false)
  const from = eye(room)
  const to = new THREE.Vector3().setFromMatrixPosition(target.matrixWorld)
  return room.gaze(from, to.sub(from))
}

const drawn = (o: THREE.Object3D | undefined): boolean => {
  for (let n: THREE.Object3D | null | undefined = o; n; n = n.parent) if (!n.visible) return false
  return o !== undefined
}

/** Every drawn holotable, the room's and the shelf's, by what it stands for. */
const drawnTables = (room: HangarArt): string[] => {
  const out: string[] = []
  room.object.traverse((o) => {
    if (o.name === 'hangar-holotable' && drawn(o)) out.push(String(o.userData.missionId ?? '?'))
  })
  return out
}

const door = (room: HangarArt) => room.object.getObjectByName(SHELF_NAMES.door) as THREE.Object3D

/** Open the shelf the way a head and a press do. */
const openShelf = async (b: Built): Promise<void> => {
  // One frame of the menu first: the door is laid on the frame it is looked for.
  lookAtBearing(b.room, 0)
  lookAtBearing(b.room, b.shelf.probe().door.bearing as number)
  expect(b.shelf.probe().door.aimed, 'the premise: the head is on the door').toBe(true)
  expect(b.room.choose(), 'the door descends, it does not board').toBeNull()
  expect(b.shelf.probe().open).toBe(true)
  await settle()
}

// ── the policy ────────────────────────────────────────────────────────────

describe('DEV-880: the library is grouped by location', () => {
  const at = (island: string, date: number): LibraryEntry => ({
    ...entryOf(course(['A', 'B'], 11), date),
    id: `pc_${island}_${date}`,
    island,
  })

  it('runs one location after another, the islands in order of their newest course, newest first within', () => {
    const list = [
      at('alpine', 90),
      at('simonet', 80),
      at('alpine', 70),
      at('desert', 60),
      at('simonet', 50),
    ]
    expect(byLocation(list).map((e) => e.id)).toEqual([
      'pc_alpine_90',
      'pc_alpine_70',
      'pc_simonet_80',
      'pc_simonet_50',
      'pc_desert_60',
    ])
    // Derived from the entries' own island, never a list of names: an unknown one groups too.
    expect(byLocation([at('zeta', 3), at('eta', 2), at('zeta', 1)]).map((e) => e.island)).toEqual([
      'zeta',
      'zeta',
      'eta',
    ])
    expect(byLocation([])).toEqual([])
  })

  it('is the order the shelf lays them in, after the actions', () => {
    const list = [at('alpine', 90), at('simonet', 80), at('alpine', 70)]
    const items = shelfItems([OPEN_COURSE_FILE_ACTION], list)
    expect(items.map((i) => (i.kind === 'action' ? i.action.id : i.entry.id))).toEqual([
      OPEN_COURSE_FILE_ACTION.id,
      'pc_alpine_90',
      'pc_alpine_70',
      'pc_simonet_80',
    ])
  })
})

describe('DEV-488 — the shelf’s policy, pinned', () => {
  it('pins every value, so moving one is an edit made on purpose', () => {
    expect(YOUR_COURSES).toEqual({
      doorStep: 'courses',
      perPage: TABLES_PER_PAGE,
      routeColour: HOLOTABLE_LOOK.rest,
      craftScale: 1.8,
      doorMinimum: 1,
    })
  })

  it('stands the door one table step past the arc end nearer the resting pointer', () => {
    // DEV-858: arcs are centred on the eye line (SEAT_REST_BEARING), so these are
    // offsets from it, and the door continues the arc rather than picking a slot.
    const off = (n: number) => ((doorBearing(tableBearings(n)) as number) - SEAT_REST_BEARING) / DEG
    // Two aircraft (-15, +15): -45 and +45 are equally far; a tie goes left.
    expect(off(2)).toBeCloseTo(-45, 9)
    // Three (-30, 0, +30): -60 and +60 tie, left again.
    expect(off(3)).toBeCloseTo(-60, 9)
    // One (0): -30 and +30 tie, left.
    expect(off(1)).toBeCloseTo(-30, 9)
    // A full arc has no room for it.
    expect(doorBearing(tableBearings(TABLES_PER_PAGE))).toBeNull()
    // Never on a used position, and one step from the end it continues.
    for (const n of [1, 2, 3]) {
      const used = tableBearings(n)
      const d = doorBearing(used) as number
      expect(used.some((u) => Math.abs(u - d) < 1e-9)).toBe(false)
      expect(Math.min(...used.map((u) => Math.abs(u - d)))).toBeCloseTo(30 * DEG, 9)
    }
  })

  it('deals the library into arcs of four, in its own order, every course reachable', () => {
    for (let n = 0; n <= 9; n++) {
      const items = Array.from({ length: n }, (_, i) => i)
      const pages = shelfPages(items)
      expect(pages.flat()).toEqual(items)
      for (const p of pages) expect(p.length).toBeLessThanOrEqual(TABLES_PER_PAGE)
    }
  })

  it('says what the door and a course table hold, in the room’s words', () => {
    // DEV-558: "Custom courses" (Matt, 2026-10-01: *"change "your courses" to
    // "custom courses""*).
    expect(doorLines(LIBRARY.slice(0, 1))).toEqual({
      title: 'Custom courses',
      detail: '1 course',
      best: 'newest · Amber Heron',
    })
    expect(doorLines(LIBRARY).detail).toBe('5 courses')
    expect(doorLines([]).best).toBe('none yet')
    expect(courseLines(LIBRARY[0] as LibraryEntry, null).title).toBe('Amber Heron')
    expect(shelfHeader(5, 1, 2)).toBe('CUSTOM COURSES · 5 · 2/2')
    expect(shelfHeader(2, 0, 1)).toBe('CUSTOM COURSES · 2')
  })

  it('DEV-558: stands the COURSES hub’s actions first, then the courses, newest first', () => {
    const items = shelfItems([MAKE_A_COURSE_ACTION, OPEN_COURSE_FILE_ACTION], LIBRARY)
    expect(items.map((i) => (i.kind === 'action' ? i.action.id : i.entry.id))).toEqual([
      'make-course',
      'open-course-file',
      ...LIBRARY.map((e) => e.id),
    ])
    expect(actionLines(OPEN_COURSE_FILE_ACTION)).toEqual({
      title: 'Open a Course File',
      detail: 'a .ffcourse somebody sent',
      best: 'or drop one on the window',
    })
    // No actions (a headset): the courses alone, as DEV-488 stood them.
    expect(shelfItems([], LIBRARY).every((i) => i.kind === 'course')).toBe(true)
  })
})

// ── the furniture ─────────────────────────────────────────────────────────

describe('DEV-488 — the shelf’s tables are the room’s tables', () => {
  it('stands on the ROOM’s own plinth, rim and label, and carries no light (and, DEV-580, no cursor)', () => {
    const b = build()
    lookAtBearing(b.room, 0) // one frame: the door is laid
    const roomTable = b.base.object.getObjectByName('hangar-holotable') as THREE.Group
    const ours = door(b.room) as THREE.Group
    expect(ours, 'the premise: the door stands').toBeDefined()
    const meshes = (g: THREE.Object3D) =>
      g.children.filter((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh[]
    const byType = (g: THREE.Object3D, type: string) =>
      meshes(g).find((m) => m.geometry.type === type) as THREE.Mesh
    // The SAME geometry objects as a room table: nothing is rebuilt to look alike.
    // DEV-580: neither carries 2016's cursor sphere; the reticle is the one mark.
    expect(byType(roomTable, 'SphereGeometry'), 'no cursor on the room').toBeUndefined()
    expect(byType(ours, 'SphereGeometry'), 'no cursor on the shelf').toBeUndefined()
    for (const type of ['CylinderGeometry', 'PlaneGeometry']) {
      expect(byType(ours, type)?.geometry, type).toBe(byType(roomTable, type)?.geometry)
      expect(byType(ours, type)?.position.y, `${type} height`).toBeCloseTo(
        byType(roomTable, type)?.position.y as number,
        9,
      )
    }
    // DEV-574: the highlight (the square and its glow) is the room's own, a
    // clone sharing every geometry and material, so the shelf compiles nothing.
    const highlightMeshes = (g: THREE.Object3D) => {
      const out: THREE.Mesh[] = []
      g.getObjectByName(TABLE_HIGHLIGHT_NAME)?.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh)
      })
      return out
    }
    const theirs = highlightMeshes(roomTable)
    expect(theirs.length, 'the premise: the room has a highlight').toBeGreaterThan(0)
    expect(highlightMeshes(ours).map((m) => [m.geometry, m.material])).toEqual(
      theirs.map((m) => [m.geometry, m.material]),
    )
    // The plinth's material too, shared.
    expect(byType(ours, 'CylinderGeometry').material).toBe(
      byType(roomTable, 'CylinderGeometry').material,
    )
    // No light in the shelf: the room's light count, in every lit program's
    // key, cannot move when it opens.
    const lights = (root: THREE.Object3D) => {
      let n = 0
      root.traverse((o) => {
        if ((o as THREE.Light).isLight) n++
      })
      return n
    }
    expect(lights(b.room.object.getObjectByName(SHELF_NAMES.root) as THREE.Object3D)).toBe(0)
  })

  it('wears 2016’s pedestal the moment the room does, turned to the seat as the room turns its own', () => {
    const b = build()
    lookAtBearing(b.room, 0)
    const ours = door(b.room) as THREE.Group
    expect(ours.getObjectByName('holotable-pedestal'), 'no art yet: no pedestal').toBeUndefined()
    // The art landing, as `render/hangar-art.ts` does it: a pedestal into every
    // ROOM table, turned by its bearing, and the plinth hidden.
    const geometry = new THREE.BoxGeometry(0.4, 0.45, 0.3)
    const material = new THREE.MeshStandardMaterial()
    const azimuth = 0.7
    const seat = seatEyeLocal(SPEC)
    for (const t of b.base.object.children.filter((c) => c.name === 'hangar-holotable')) {
      const bearing = Math.atan2(t.position.x - seat.x, seat.z - t.position.z)
      const pedestal = new THREE.Mesh(geometry, material)
      pedestal.name = 'holotable-pedestal'
      pedestal.rotation.y = -bearing - azimuth
      t.add(pedestal)
      for (const m of t.children)
        if ((m as THREE.Mesh).geometry?.type === 'CylinderGeometry') m.visible = false
    }
    lookAtBearing(b.room, 0)
    const pedestal = ours.getObjectByName('holotable-pedestal') as THREE.Mesh
    expect(pedestal, 'the door has its pedestal').toBeDefined()
    expect(pedestal.geometry).toBe(geometry)
    expect(pedestal.material).toBe(material)
    const doorBearingNow = b.shelf.probe().door.bearing as number
    expect(pedestal.rotation.y, 'the same side faces the seat').toBeCloseTo(
      -doorBearingNow - azimuth,
      9,
    )
    const plinth = ours.children.find(
      (c) => (c as THREE.Mesh).geometry?.type === 'CylinderGeometry',
    )
    expect(plinth?.visible, 'and the old plinth is put by, as the room’s is').toBe(false)
  })
})

// ── the door ──────────────────────────────────────────────────────────────

describe('DEV-488, DEV-880: the door on the place step', () => {
  it('stands at -45 off the eye line beside two locations, and -60 beside three', () => {
    const two = build(TWO)
    lookAtBearing(two.room, 0)
    expect(two.shelf.probe().door.up).toBe(true)
    expect(two.shelf.probe().door.bearing as number).toBeCloseTo(SEAT_REST_BEARING - 45 * DEG, 9)
    const three = build(THREE_WIDE)
    lookAtBearing(three.room, 0)
    expect(three.shelf.probe().door.bearing as number).toBeCloseTo(SEAT_REST_BEARING - 60 * DEG, 9)
  })

  it('stands only with the editor on, only with a course kept, only on the place step', () => {
    const b = build()
    lookAtBearing(b.room, 0)
    expect(drawn(door(b.room))).toBe(true)
    b.editor = false
    lookAtBearing(b.room, 0)
    expect(drawn(door(b.room)), 'no editor: no door (D35: the MENUS’ preset)').toBe(false)
    b.editor = true
    b.entries = []
    lookAtBearing(b.room, 0)
    expect(drawn(door(b.room)), 'an empty library: no door').toBe(false)
    b.entries = LIBRARY.slice(0, 1)
    lookAtBearing(b.room, 0)
    expect(drawn(door(b.room))).toBe(true)
    // Back up a step (the plans), and the door is not there: it is a LOCATION choice.
    b.room.goBack()
    lookAtBearing(b.room, 0)
    expect(b.room.view).toBe('modes')
    expect(drawn(door(b.room)), 'on the flight-plan step: no door').toBe(false)
    b.room.goBack()
    lookAtBearing(b.room, 0)
    expect(b.room.view).toBe('vehicles')
    expect(drawn(door(b.room)), 'DEV-880: and none on the aircraft step, where it was').toBe(false)
  })

  it('DEV-880: BACK from the shelf names the place step', async () => {
    const b = build()
    await openShelf(b)
    expect(BACK_WORDS[YOUR_COURSES.doorStep]).toBe('PLACE')
  })

  it('lights under the head, and a press opens the shelf rather than boarding', async () => {
    const b = build()
    lookAtBearing(b.room, 0)
    const bearing = b.shelf.probe().door.bearing as number
    expect(lookAtBearing(b.room, bearing), 'a thing a press acts on').toBe(true)
    expect(b.room.aim, 'the door has no kind in the room’s union').toBeNull()
    expect(b.room.aimDistance, 'but the reticle has somewhere to sit').toBeGreaterThan(1)
    expect(door(b.room).userData.aimed).toBe(true)
    await openShelf(b)
    expect(b.boarded).toEqual([])
  })

  it('goes down for a load from the ROOM’s own tables (DEV-465’s hide)', () => {
    const b = build()
    lookAtBearing(b.room, 0)
    expect(drawn(door(b.room))).toBe(true)
    b.room.focus('hj_a')
    lookAtBearing(b.room, 0)
    expect(drawn(door(b.room)), 'the door is put by with the rest').toBe(false)
    expect(b.room.focused).toBe('hj_a')
    b.room.focus(null)
    lookAtBearing(b.room, 0)
    expect(drawn(door(b.room)), 'and back with the step').toBe(true)
  })
})

// ── the flat frame, from rest ─────────────────────────────────────────────

describe('DEV-488 — the door from the seat at rest, on a flat 16:9 screen', () => {
  const edition = JSON.parse(
    fs.readFileSync(path.join(REPO, 'content/editions/anniversary.json'), 'utf8'),
  ) as Edition
  const rendererFov = (): number => {
    const source = fs.readFileSync(path.join(REPO, 'src/render/renderer.ts'), 'utf8')
    const match = /new THREE\.PerspectiveCamera\(\s*(\d+(?:\.\d+)?)\s*,/.exec(source)
    if (!match) throw new Error('renderer.ts no longer builds its camera with a literal lens')
    return Number(match[1])
  }
  /** As `flight-school-left.test.ts` builds it: the menus wear Anniversary (D35). */
  const resting = (): THREE.PerspectiveCamera => {
    const camera = new THREE.PerspectiveCamera(
      baseFovFor(edition.render.flatFov, rendererFov()),
      16 / 9,
      0.08,
      100,
    )
    const e = seatEyeLocal(SPEC)
    camera.position.set(e.x, e.y, e.z)
    camera.quaternion.setFromEuler(new THREE.Euler(seatPitchLocal(), seatYawLocal(), 0, 'YXZ'))
    camera.updateMatrixWorld()
    camera.updateProjectionMatrix()
    return camera
  }
  /** The gaze window's edges across the frame, NDC x. */
  const window = (bearing: number): { left: number; right: number; y: number } => {
    const camera = resting()
    const c = tableGazeLocal(SPEC, bearing)
    const centre = new THREE.Vector3(c.x, c.y, c.z)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
    const a = centre.clone().addScaledVector(right, -GAZE_RADIUS).project(camera)
    const z = centre.clone().addScaledVector(right, GAZE_RADIUS).project(camera)
    return { left: Math.min(a.x, z.x), right: Math.max(a.x, z.x), y: centre.project(camera).y }
  }

  it('on a release build’s two aircraft, the door’s whole window is in frame', () => {
    const w = window(doorBearing(tableBearings(2)) as number)
    console.info(
      `[DEV-488] door at -45°, rest frame NDC x ${w.left.toFixed(3)}..${w.right.toFixed(3)}`,
    )
    expect(w.left).toBeGreaterThan(-1)
    expect(w.right).toBeLessThan(1)
    expect(Math.abs(w.y)).toBeLessThan(1)
  })

  it('on preview’s three (the glider), the door is 60 off the eye, and it is OUT of frame (Matt’s call)', () => {
    const w = window(doorBearing(tableBearings(3)) as number)
    console.info(
      `[DEV-488] door at +45°, rest frame NDC x ${w.left.toFixed(3)}..${w.right.toFixed(3)}`,
    )
    // Written down so the day the glider ships (or leaves) this line moves on
    // purpose: the door is a turn of the head away, as the checklist plate is.
    expect(w.left < -1 || w.right > 1, 'out of the flat frame').toBe(true)
  })
})

// ── the shelf ─────────────────────────────────────────────────────────────

describe('DEV-488 — the shelf', () => {
  it('lends it the arc: the room’s tables and header put by, the courses stood in library order', async () => {
    const b = build(TWO, LIBRARY.slice(0, 3))
    await openShelf(b)
    lookAtBearing(b.room, 0)
    expect(drawnTables(b.room), 'only the shelf’s tables, newest first').toEqual(
      LIBRARY.slice(0, 3).map((e) => e.id),
    )
    expect(b.base.focused, 'the room’s arc is lent under the sentinel').toBe(SHELF_LENT)
    expect(b.room.focused, 'which the app never sees as a load').toBeNull()
    expect(drawn(b.room.object.getObjectByName('hangar-header'))).toBe(false)
    expect(drawn(b.room.object.getObjectByName(SHELF_NAMES.header))).toBe(true)
    expect(drawn(b.room.object.getObjectByName(SHELF_NAMES.back)), 'the way out').toBe(true)
    expect(drawn(b.room.object.getObjectByName(SHELF_NAMES.next)), 'one page: no PAGE').toBe(false)
    // Laid on the room's own arc for three: -45, -15, +15.
    expect(b.shelf.probe().tables).toEqual(LIBRARY.slice(0, 3).map((e) => e.id))
  })

  it('boards a course with ONE press: a real card, the course’s own id, and the level switchMission asks for', async () => {
    const b = build(TWO, LIBRARY.slice(0, 3))
    await openShelf(b)
    const target = LIBRARY[1] as LibraryEntry
    // Before its level is read, a shipped id and an unread one are null.
    expect(b.shelf.levelOf('int_01_hoverJet'), 'a shipped mission never resolves here').toBeNull()
    expect(
      b.shelf.levelOf((LIBRARY[4] as LibraryEntry).id),
      'nor a course the shelf has not read',
    ).toBeNull()
    // The middle of three is under the resting pointer, as any three-wide arc.
    expect(lookAtBearing(b.room, SEAT_REST_BEARING)).toBe(true)
    expect(b.shelf.probe().aimed).toBe(target.id)
    const aim = b.room.aim
    expect(aim?.kind === 'mission' && aim.mission.id).toBe(target.id)
    const picked = b.room.choose()
    expect(picked?.id).toBe(target.id)
    expect(picked?.vehicle).toBe('hoverjet')
    expect(b.boarded).toEqual([target.id])
    expect(b.shelf.levelOf(target.id)?.id, 'the switch finds its level').toBe(target.id)
  })

  it('levelOf never resolves a shipped id, even one a broken expansion handed it', async () => {
    const base = createHangar({
      spec: SPEC,
      seed: 1,
      title: '',
      subtitle: '',
      level: null,
      missions: TWO,
      shapeFor: () => new Promise(() => {}),
    })
    // An expansion that came back under a SHIPPED id: the lookup must not
    // become a second door to `int_01_hoverJet`'s level.
    const shelf = withYourCourses(base, {
      spec: SPEC,
      enabled: () => true,
      entries: () => LIBRARY.slice(0, 1),
      levelFor: async () => DONOR,
      shapeOf: () => new Promise(() => {}),
      cardOf: (level) => cardFor(level, null),
    })
    lookAtBearing(shelf.hangar, 0)
    await settle()
    expect(shelf.levelOf(DONOR.id)).toBeNull()
  })

  it('joins DEV-465’s hide on a load: one table kept, pressed; plates and headers down; back whole', async () => {
    const b = build(TWO, LIBRARY.slice(0, 3))
    await openShelf(b)
    const target = LIBRARY[1] as LibraryEntry
    lookAtBearing(b.room, SEAT_REST_BEARING)
    b.room.choose()
    b.room.setBusy('LOADING')
    b.room.focus(target.id)
    expect(b.room.focused).toBe(target.id)
    expect(drawnTables(b.room), 'every table but the pressed one is put by').toEqual([target.id])
    for (const n of [SHELF_NAMES.back, SHELF_NAMES.next, SHELF_NAMES.header, 'hangar-header'])
      expect(drawn(b.room.object.getObjectByName(n)), `${n} is down`).toBe(false)
    // Nothing is aimable while it holds, and a press boards nothing.
    lookAtBearing(b.room, SEAT_REST_BEARING - 30 * DEG)
    expect(b.room.aim).toBeNull()
    expect(b.room.choose()).toBeNull()
    // At the pad's black: the shelf back as it lays, the room's arc still lent.
    b.room.setBusy(null)
    b.room.focus(null)
    b.room.setCurrent(target.id)
    lookAtBearing(b.room, 0)
    expect(drawnTables(b.room)).toEqual(LIBRARY.slice(0, 3).map((e) => e.id))
    expect(b.base.focused).toBe(SHELF_LENT)
    expect(b.room.focused).toBeNull()
  })

  it('pages at five, and the BACK plate takes you to the places, by press or by dwell', async () => {
    const b = build(TWO, LIBRARY)
    await openShelf(b)
    lookAtBearing(b.room, 0)
    expect(b.shelf.probe().pageCount).toBe(2)
    expect(drawn(b.room.object.getObjectByName(SHELF_NAMES.next))).toBe(true)
    expect(b.room.turnPage(1)).toBe(1)
    expect(b.shelf.probe().tables).toEqual([(LIBRARY[4] as LibraryEntry).id])
    // BACK by dwell, as the room's own plates.
    lookAtObject(b.room, SHELF_NAMES.back)
    expect(b.shelf.probe().aimed).toBe('back')
    expect(b.room.aim).toEqual({ kind: 'back' })
    for (let t = 0; t <= PAGE_DWELL_SECONDS + 0.1; t += 0.05) {
      lookAtObject(b.room, SHELF_NAMES.back)
      b.room.update(0.05)
      if (!b.shelf.probe().open) break
    }
    expect(b.shelf.probe().open, 'the dwell took the plate').toBe(false)
    lookAtBearing(b.room, 0)
    expect(b.base.focused, 'the arc is the room’s again').toBeNull()
    expect(drawnTables(b.room).length, 'its places back').toBeGreaterThan(0)
    expect(b.room.view).toBe('courses')
    expect(drawn(door(b.room)), 'and the door with them').toBe(true)
    // And by goBack, which B would call.
    await openShelf(b)
    b.room.goBack()
    expect(b.shelf.probe().open).toBe(false)
  })
})

// ── DEV-558: the COURSES hub's actions, on the shelf ────────────────────────

describe('DEV-558: OPEN A COURSE FILE and MAKE A COURSE stand on the shelf', () => {
  it('stands the door with no course kept, when there is an action to offer', async () => {
    const b = build(TWO, [], [MAKE_A_COURSE_ACTION, OPEN_COURSE_FILE_ACTION])
    lookAtBearing(b.room, 0)
    expect(b.shelf.probe().door.up, 'the door stands for the actions alone').toBe(true)
    // And with no action and no course, it does not: nothing behind it.
    const none = build(TWO, [], [])
    lookAtBearing(none.room, 0)
    expect(none.shelf.probe().door.up).toBe(false)
  })

  it('puts the actions first on the shelf, and a press hands one to the app, boarding nothing', async () => {
    const b = build(TWO, LIBRARY.slice(0, 1), [MAKE_A_COURSE_ACTION, OPEN_COURSE_FILE_ACTION])
    await openShelf(b)
    expect(b.shelf.probe().tables).toEqual([
      MAKE_A_COURSE_ACTION.id,
      OPEN_COURSE_FILE_ACTION.id,
      (LIBRARY[0] as LibraryEntry).id,
    ])
    // The first table, at its bearing on a three-wide arc.
    const first = tableBearings(3)[0] as number
    expect(lookAtBearing(b.room, first), 'an action table is aimable').toBe(true)
    expect(b.shelf.probe().aimed).toBe(MAKE_A_COURSE_ACTION.id)
    expect(b.room.choose(), 'an action boards nothing').toBeNull()
    expect(b.acted).toEqual([MAKE_A_COURSE_ACTION.id])
    expect(b.boarded).toEqual([])
  })
})
