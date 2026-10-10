// src/render/course-shelf.ts: CUSTOM COURSES, on the hangar's holotables. DEV-488.
//
// (YOUR COURSES until DEV-558. Matt, 2026-10-01: *"change "your courses" to
// "custom courses""*. The code keeps its names; every word a player reads
// changed. And the title's COURSES hub came here with DEV-558: its OPEN A
// COURSE FILE and MAKE A COURSE are the shelf's first tables, its ACTIONS,
// so the door stands whenever there is one to offer, courses kept or not.)
//
// DEV-467 put the course library (`game/course-library.ts`) on the title,
// under COURSES → YOUR COURSES, and left the hangar's holotables as a
// follow-up until DEV-465 (a course picked in the room is loaded IN the room)
// landed. This file is that follow-up. It adds two things to the room:
//
//   THE DOOR   one more holotable on the AIRCRAFT step, standing at the free
//              position on the arc nearest the resting pointer, reading
//              YOUR COURSES over the newest course's island. A press opens:
//   THE SHELF  the library's courses, newest first, four to an arc, each on
//              its own table as a diorama like a shipped course's: its island
//              read off the same height field, its line DRAWN on the island,
//              and its tiny jets flying it. A press BOARDS, through the
//              room's own switch, so the course is waited out in the room
//              (DEV-465) exactly as a shipped course is. The left lap plate
//              goes back to the aircraft; the right one pages.
//
// ── Why a wrapper, and not a fifth step inside `hangar.ts` ────────────────
//
// The fleet lead owns the hangar flow, and the brief allows this row a new
// module and one block in `hangar.ts`. The room's steps are a closed union
// (`HangarView`, `TableSlot`) walked by one layout path, and a player course
// has none of the identities that path is keyed on: a table's position there
// is a function of a SHIPPED key (DEV-203's fixed slots). So the shelf is
// its own set of tables in the room's frame, and `withYourCourses` wraps the
// `HangarArt` the room returns. `boot/app.ts` swaps its `hangar` for the
// wrapped one, and nothing else in the app has to know which it is holding.
//
// The wrapper puts the room's own arc by with `focus`, DEV-465's hide, under
// a sentinel no table stands for. That hide is visibility only: nothing is
// added or removed, no light moves, and nothing of the room is aimable, so
// the shelf has the arc to itself. A course load from the shelf joins the
// same hide the other way round: `focus(id)` keeps the pressed table and puts
// every other one by, with the plates and the header. The DOOR goes down for
// any load at all.
//
// ── The tables are the ROOM's tables ─────────────────────────────────────
//
// The shelf does not build lookalikes. The rim inks, the label painter, its
// lift and the turn to the seat are the room's own, lent by name from
// `hangar.ts`'s DEV-488 block. The few shapes still built here (the plinth,
// the rim's torus, the label's plane) are measured against a real
// room's tables by `tests/unit/course-shelf.test.ts`, so they cannot drift
// unnoticed. Nothing here carries a light: a table's lamps are for an
// AIRCRAFT (DEV-188), and the island is unlit. So the room's light count, and
// with it every lit program's key, is the same with the shelf up or down.
//
// ── Menus wear Anniversary (D35) ─────────────────────────────────────────
//
// The islands take the MENUS' holo look, through the same `holoLook`
// callback the room's tables use. Whether the door stands at all is the
// menus' preset's `gameplay.editor`, never the chosen edition's.

import * as THREE from 'three'
import { paletteFor } from '@/content/holo-palette'
import type { Level } from '@/content/level-schema'
import type { LibraryEntry } from '@/game/course-library'
import { bestLine, cardFor, environmentDisplayName, type MissionCard } from '@/game/mission-index'
import { type MissionShape, missionField, missionSeaLevel, missionTour } from '@/game/mission-shape'
import { UI_STACK as MONO, UI_DIM as PLATE_INK } from '@/render/ui-tokens'
import type { HangarSpec } from '@/sim/hangar'
import { createDiorama, type Diorama, type HoloLook } from './diorama'
import {
  ARROW_GAZE_RADIUS,
  advanceDwell,
  BACK_WORDS,
  backHolotableText,
  DIORAMA_LIFT,
  faceHolotableSeat,
  GAZE_RADIUS,
  type HangarAim,
  type HangarArt,
  HEADER_LIFT,
  HOLO_REACH,
  HOLOTABLE_LOOK,
  labelYaw,
  layHighlight,
  MODEL_SIZE,
  PAGE_DWELL_SECONDS,
  paintHolotableLabel,
  pickNearestSphere,
  SEAT_REST_BEARING,
  seatEyeLocal,
  stepBearings,
  TABLE_BEARING_STEP,
  TABLE_BODY,
  TABLE_HIGHLIGHT_NAME,
  TABLE_TOP,
  TABLES_PER_PAGE,
  tableBearings,
  tableGazeLocal,
  tableLocal,
  wrapPage,
} from './hangar'
import { disposeTree } from './scene-walk'

// ── Policy, in one place ──────────────────────────────────────────────────

/**
 * The shelf's policy: every number here is a call, and each is Matt's to move.
 * Pinned by value in `tests/unit/course-shelf.test.ts`.
 */
export const YOUR_COURSES = {
  /**
   * The step the door stands on: the PLACE step, beside the locations (DEV-880,
   * Matt: *"move custom courses from aircraft selection to location selection"*).
   * It was the aircraft step. Only a step whose tables are places has it: the
   * lesson's course step (reached by a rank) is not a location choice.
   */
  doorStep: 'courses',
  /** Courses to an arc: the room's own page. */
  perPage: TABLES_PER_PAGE,
  /**
   * The drawn line's colour: the room's accent, the rims' amber, which is
   * what this room already uses to say "this is live". A shipped course's
   * table draws no line (DEV-354); a player course's does, because two
   * courses on one island are otherwise the same picture.
   */
  routeColour: HOLOTABLE_LOOK.rest,
  /** The craft's size on the island, as the room's land tables draw it. */
  craftScale: 1.8,
  /**
   * The door stands only when the library holds at least this many, or (since
   * DEV-558) when there is an action to offer.
   */
  doorMinimum: 1,
} as const

/**
 * DEV-558: a shelf table that DOES something rather than boarding a course:
 * the title's COURSES hub, moved here. Its three lines, and whether the note
 * says the last try was refused (painted as a course that could not be read).
 */
export interface ShelfAction {
  readonly id: string
  readonly name: string
  readonly detail: string
  readonly note: string
  readonly refused?: boolean
}

/** DEV-469's editor, over an island: a desktop only (`boot/app.ts` decides). */
export const MAKE_A_COURSE_ACTION: ShelfAction = {
  id: 'make-course',
  name: 'Make a Course',
  detail: 'lay rings over an island',
  note: 'fly them, share them',
}

/**
 * DEV-878 (decision 7): on a phone the editor is not offered, and the shelf
 * says so rather than leaving the row out. A different id from
 * `MAKE_A_COURSE_ACTION`'s, so a press of it reaches no handler and opens
 * nothing: the desk has no touch input and a fixed side panel.
 */
export const MAKE_A_COURSE_PHONE_ACTION: ShelfAction = {
  id: 'make-course-phone',
  name: 'Make a Course',
  detail: 'needs a computer',
  note: 'open the game there',
  refused: true,
}

/** DEV-467's file picker: a `.ffcourse` somebody sent you. Not in a headset. */
export const OPEN_COURSE_FILE_ACTION: ShelfAction = {
  id: 'open-course-file',
  name: 'Open a Course File',
  detail: 'a .ffcourse somebody sent',
  note: 'or drop one on the window',
}

/** What stands on one shelf position: an action, or a kept course. */
export type ShelfItem =
  | { readonly kind: 'action'; readonly action: ShelfAction }
  | { readonly kind: 'course'; readonly entry: LibraryEntry }

/**
 * The library GROUPED BY LOCATION (DEV-880): one run per island, the islands in
 * the order of their newest course, each run newest first. The island is the
 * entry's own (`island`, an environment id), so nothing here names a location.
 */
export const byLocation = <T extends Pick<LibraryEntry, 'island'>>(
  entries: readonly T[],
): readonly T[] => {
  const order: string[] = []
  for (const e of entries) if (!order.includes(e.island)) order.push(e.island)
  return order.flatMap((island) => entries.filter((e) => e.island === island))
}

/**
 * The shelf's items, in order: the actions first, then the courses grouped by
 * location (DEV-880), newest first within one.
 */
export const shelfItems = (
  actions: readonly ShelfAction[],
  entries: readonly LibraryEntry[],
): readonly ShelfItem[] => [
  ...actions.map((action): ShelfItem => ({ kind: 'action', action })),
  ...byLocation(entries).map((entry): ShelfItem => ({ kind: 'course', entry })),
]

/** The sentinel the room's arc is focused on while the shelf is up. No table stands for it. */
export const SHELF_LENT = 'your-courses:shelf'

/** Names a spec finds the shelf's parts by. */
export const SHELF_NAMES = {
  root: 'your-courses',
  door: 'your-courses-door',
  shelf: 'your-courses-shelf',
  /** A course table is a holotable like any other, so DEV-465's count sees it. */
  table: 'hangar-holotable',
  header: 'your-courses-header',
  back: 'your-courses-back',
  next: 'your-courses-next',
} as const

/**
 * Where the door stands, given the bearings the step already uses: one table
 * step beyond the arc's left or right end, whichever is NEARER the resting
 * pointer, or null where the arc is full. (DEV-858: the arcs are centred on the
 * eye line, so a step's tables are not a subset of a four-wide arc's positions
 * and the door continues the arc it is on instead.) Ties go left, where the
 * arc reads from.
 */
export const doorBearing = (used: readonly number[]): number | null => {
  if (used.length === 0 || used.length >= TABLES_PER_PAGE) return null
  const lo = Math.min(...used) - TABLE_BEARING_STEP
  const hi = Math.max(...used) + TABLE_BEARING_STEP
  return Math.abs(lo - SEAT_REST_BEARING) <= Math.abs(hi - SEAT_REST_BEARING) + 1e-9 ? lo : hi
}

/** The library dealt into arcs, in its own order (newest first). */
export const shelfPages = <T>(entries: readonly T[], perPage: number = YOUR_COURSES.perPage) => {
  const pages: T[][] = []
  for (let i = 0; i < entries.length; i += perPage) pages.push(entries.slice(i, i + perPage))
  return pages
}

/** The door's three lines. */
export const doorLines = (
  entries: readonly Pick<LibraryEntry, 'name'>[],
): { title: string; detail: string; best: string } => ({
  title: 'Custom courses',
  detail: entries.length === 1 ? '1 course' : `${entries.length} courses`,
  best: entries[0] ? `newest · ${entries[0].name}` : 'none yet',
})

/** An action table's three lines (DEV-558). */
export const actionLines = (
  action: ShelfAction,
): { title: string; detail: string; best: string } => ({
  title: action.name,
  detail: action.detail,
  best: action.note,
})

/** A course table's three lines: its name, where and what, and its best. */
export const courseLines = (
  entry: Pick<LibraryEntry, 'name' | 'island'>,
  card: MissionCard | null,
): { title: string; detail: string; best: string } => ({
  title: entry.name,
  detail: card
    ? `${card.environmentName} · ${card.modeName}`
    : environmentDisplayName(entry.island),
  best: card ? bestLine(card.best) : 'reading…',
})

/** The shelf's header: what the arc holds, and which page. */
export const shelfHeader = (count: number, page: number, pages: number): string =>
  pages > 1 ? `CUSTOM COURSES · ${count} · ${page + 1}/${pages}` : `CUSTOM COURSES · ${count}`

// ── The wrapper ───────────────────────────────────────────────────────────

export interface YourCoursesOptions {
  readonly spec: HangarSpec
  /** Is the door offered at all: the MENUS' `gameplay.editor` (D35). */
  readonly enabled: () => boolean
  /**
   * The library's entries, newest first, read every frame. Returned by
   * reference: a new array is a new list, the same array is no change.
   */
  readonly entries: () => readonly LibraryEntry[]
  /** Expand a course against its donor (`loadPlayerCourse`). */
  readonly levelFor: (entry: LibraryEntry) => Promise<Level>
  /** The island and path for a level. Defaults to `missionShape`'s own reads. */
  readonly shapeOf?: (level: Level) => Promise<MissionShape>
  /** The card a level boards as. Defaults to `cardFor`. */
  readonly cardOf?: (level: Level) => MissionCard
  /** The menus' holo look, read when an island is built (DEV-140). */
  readonly holoLook?: () => HoloLook | null
  /** Fired when a shelf course is committed, before it is returned. */
  readonly onBoard?: (entry: LibraryEntry, level: Level) => void
  /**
   * DEV-558: the action tables to stand before the courses (the title's
   * COURSES hub, moved), read every frame like `entries`. Absent: none.
   */
  readonly actions?: () => readonly ShelfAction[]
  /** DEV-558: an action table was pressed. The shelf does nothing else with it. */
  readonly onAction?: (id: string) => void
}

/** What the shelf is doing, for a spec or `__ff2` to read. */
export interface YourCoursesProbe {
  readonly door: { readonly up: boolean; readonly bearing: number | null; readonly aimed: boolean }
  readonly open: boolean
  readonly page: number
  readonly pageCount: number
  /** The course ids on the arc that is up, left to right. */
  readonly tables: readonly string[]
  /** What the pointer is on: 'door', 'back', 'next', a course id, or null. */
  readonly aimed: string | null
  readonly focus: string | null
}

export interface YourCourses {
  /** The room, wrapped: every `HangarArt` call goes through here. */
  readonly hangar: HangarArt
  /**
   * The expanded level of a course the shelf has read, by its `pc_` id, or
   * null. SYNCHRONOUS and never anything else: a shipped mission's id, or a
   * course the shelf has not expanded, is null. `switchMission` asks it
   * before `loadLevel`, which cannot resolve a player course.
   */
  levelOf(id: string): Level | null
  probe(): YourCoursesProbe
}

/** One of the shelf's tables. Built once, relabelled per page. */
interface ShelfTable {
  readonly group: THREE.Group
  /** The room's plinth, shared; hidden when the room hides its own. */
  readonly plinth: THREE.Mesh
  /** 2016's pedestal, mirrored from the room's once the art lands (DEV-430). */
  pedestal: THREE.Mesh | null
  /**
   * DEV-574: the room's highlight (the square on the inset and its glow),
   * shown only while this table is aimed. Its geometry and materials are the
   * room's, shared, so the shelf neither builds nor frees them.
   */
  readonly highlight: THREE.Object3D
  readonly label: THREE.Mesh
  readonly canvas: HTMLCanvasElement
  readonly texture: THREE.CanvasTexture
  diorama: Diorama | null
  /** Which library entry stands here, or null. */
  entry: LibraryEntry | null
  /** DEV-558: which action stands here instead, or null. */
  action: ShelfAction | null
  bearing: number
  /** Bumped on every re-lay; a shape arriving for an old one is dropped. */
  generation: number
}

/** A lap plate: BACK on the left, PAGE on the right. */
interface ShelfPlate {
  readonly group: THREE.Object3D
  readonly material: THREE.MeshBasicMaterial
  readonly fill: THREE.Mesh
  readonly canvas: HTMLCanvasElement
  readonly texture: THREE.CanvasTexture
  readonly side: -1 | 1
}

type Aimed =
  | { readonly kind: 'door' }
  | { readonly kind: 'course'; readonly table: ShelfTable }
  | { readonly kind: 'plate'; readonly plate: ShelfPlate }

/** The ink the room's plates and header are painted in (`ui-tokens.ts`'s dim). */

/** The room's plate at rest and aimed, as `hangar.ts` colours its own. */
const PLATE_REST = 0x4d6272
const PLATE_AIMED = 0x6f8a9c

const defaultShape = async (level: Level): Promise<MissionShape> => ({
  field: await missionField(level),
  palette: paletteFor(level.environment),
  seaLevel: await missionSeaLevel(level),
  ...missionTour(level),
})

/**
 * Stand YOUR COURSES in `base`'s room. See the header. Returns the wrapped
 * room, the synchronous level lookup `switchMission` asks, and a probe.
 */
export const withYourCourses = (base: HangarArt, opts: YourCoursesOptions): YourCourses => {
  const spec = opts.spec
  const shapeOf = opts.shapeOf ?? defaultShape
  const cardOf = opts.cardOf ?? ((level: Level) => cardFor(level))

  const root = new THREE.Group()
  root.name = SHELF_NAMES.root
  base.object.add(root)
  const shelfGroup = new THREE.Group()
  shelfGroup.name = SHELF_NAMES.shelf
  shelfGroup.visible = false
  root.add(shelfGroup)

  // ── the furniture: the ROOM's own, live ─────────────────────────────────
  //
  // Every shape here is borrowed from the room as it stands: a room table's
  // plinth (geometry AND material, shared), its rim and label plane (no
  // cursor since DEV-580: the reticle is the one mark), the lap plates and the header. The shelf builds none of them. And 2016's
  // pedestal, which `render/hangar-art.ts` hangs in every ROOM table when the
  // art lands and under which it hides the plinth, is mirrored the same way
  // whenever it lands (`syncFurniture`), or never, if the art fails. So the
  // shelf's table is the room's table, whatever the room is wearing.
  const roomTable = base.object.children.find((c) => c.name === 'hangar-holotable')
  if (!roomTable) throw new Error('your courses: an unfurnished room has no table to stand beside')
  const roomPiece = (test: (mesh: THREE.Mesh) => boolean, what: string): THREE.Mesh => {
    const hit = roomTable.children.find((c) => (c as THREE.Mesh).isMesh && test(c as THREE.Mesh))
    if (!hit) throw new Error(`your courses: the room's table has no ${what}`)
    return hit as THREE.Mesh
  }
  const typeIs = (type: string) => (m: THREE.Mesh) => m.geometry.type === type
  const roomPlinth = roomPiece(typeIs('CylinderGeometry'), 'plinth')
  const roomHighlight = roomTable.getObjectByName(TABLE_HIGHLIGHT_NAME)
  if (!roomHighlight) throw new Error("your courses: the room's table has no highlight")
  const roomLabel = roomPiece(
    (m) => m.geometry.type === 'PlaneGeometry' && !!(m.material as THREE.MeshBasicMaterial).map,
    'label',
  )
  const roomCanvas = (roomLabel.material as THREE.MeshBasicMaterial).map?.image as HTMLCanvasElement
  /** The room table's bearing, off where it stands: the pedestal's yaw is relative to it. */
  const seat = seatEyeLocal(spec)
  const roomBearing = (): number =>
    Math.atan2(roomTable.position.x - seat.x, seat.z - roomTable.position.z)

  /** A new mesh wearing `from`'s geometry, its transform, and a copy of its material. */
  const likeRoom = (from: THREE.Mesh, material?: THREE.Material): THREE.Mesh => {
    const mesh = new THREE.Mesh(
      from.geometry,
      material ?? (from.material as THREE.Material).clone(),
    )
    mesh.position.copy(from.position)
    mesh.rotation.copy(from.rotation)
    mesh.scale.copy(from.scale)
    return mesh
  }

  /** A canvas the room's size, its words backed as the room's are (DEV-437). */
  const backedCanvas = (like: HTMLCanvasElement): HTMLCanvasElement => {
    const canvas = document.createElement('canvas')
    canvas.width = like.width
    canvas.height = like.height
    backHolotableText(canvas)
    return canvas
  }

  const makeTable = (name: string, parent: THREE.Object3D): ShelfTable => {
    const group = new THREE.Group()
    group.name = name
    // The plinth is SHARED with the room, material and all: it never changes.
    const plinth = likeRoom(roomPlinth, roomPlinth.material as THREE.Material)
    group.add(plinth)
    // DEV-574: the room's highlight, the square on the inset and its glow:
    // `clone` shares its geometry and materials, so it compiles nothing. Drawn
    // only on the aimed table (`aimedLook`), laid on the pedestal's inset.
    const highlight = roomHighlight.clone()
    highlight.visible = false
    group.add(highlight)
    const canvas = backedCanvas(roomCanvas)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const labelMaterial = (roomLabel.material as THREE.MeshBasicMaterial).clone()
    labelMaterial.map = texture
    const label = likeRoom(roomLabel, labelMaterial)
    group.add(label)
    group.visible = false
    parent.add(group)
    return {
      group,
      plinth,
      pedestal: null,
      highlight,
      label,
      canvas,
      texture,
      diorama: null,
      entry: null,
      action: null,
      bearing: 0,
      generation: 0,
    }
  }

  /** Mirror the room table's plinth and pedestal onto `table`, as they stand now. */
  const furnish = (table: ShelfTable): void => {
    table.plinth.visible = roomPlinth.visible
    const roomPedestal = roomTable.getObjectByName('holotable-pedestal') as THREE.Mesh | undefined
    if (roomPedestal && !table.pedestal) {
      const pedestal = likeRoom(roomPedestal, roomPedestal.material as THREE.Material)
      pedestal.name = 'holotable-pedestal'
      table.group.add(pedestal)
      table.pedestal = pedestal
    }
    if (roomPedestal && table.pedestal) {
      // `pedestalYaw` is `-bearing - azimuth`, so the azimuth is the room's.
      table.pedestal.rotation.y = roomPedestal.rotation.y + roomBearing() - table.bearing
    }
  }

  const place = (table: ShelfTable, bearing: number): void => {
    table.bearing = bearing
    const at = tableLocal(spec, bearing)
    table.group.position.set(at.x, at.y, at.z)
    faceHolotableSeat(table.label, bearing, TABLE_TOP + HOLOTABLE_LOOK.labelLift)
    furnish(table)
    layHighlight(table.highlight, bearing, table.pedestal?.rotation.y ?? null)
  }

  const paintTable = (
    table: ShelfTable,
    lines: { title: string; detail: string; best: string },
    dead = false,
  ): void => {
    paintHolotableLabel(table.canvas, lines.title, lines.detail, lines.best, dead)
    table.texture.needsUpdate = true
  }

  const door = makeTable(SHELF_NAMES.door, root)
  door.group.userData.yourCourses = 'door'
  door.group.userData.aimed = false
  const tables: ShelfTable[] = Array.from({ length: YOUR_COURSES.perPage }, () =>
    makeTable(SHELF_NAMES.table, shelfGroup),
  )
  /** Every frame: the art may have landed since the tables were placed. */
  const syncFurniture = (): void => {
    for (const table of [door, ...tables]) if (table.group.visible) furnish(table)
  }

  // The header: the room's, over the middle of the arc.
  const roomHeader = base.object.getObjectByName('hangar-header') as THREE.Mesh | undefined
  if (!roomHeader) throw new Error('your courses: the room has no header')
  const roomHeaderCanvas = (roomHeader.material as THREE.MeshBasicMaterial).map
    ?.image as HTMLCanvasElement
  const headerCanvas = backedCanvas(roomHeaderCanvas)
  const headerTexture = new THREE.CanvasTexture(headerCanvas)
  headerTexture.colorSpace = THREE.SRGBColorSpace
  const headerMaterial = (roomHeader.material as THREE.MeshBasicMaterial).clone()
  headerMaterial.map = headerTexture
  const header = likeRoom(roomHeader, headerMaterial)
  header.name = SHELF_NAMES.header
  shelfGroup.add(header)
  const placeHeader = (bearings: readonly number[]): void => {
    const mid = bearings.length
      ? ((bearings[0] as number) + (bearings[bearings.length - 1] as number)) / 2
      : SEAT_REST_BEARING
    header.position.set(
      seat.x + Math.sin(mid) * HOLO_REACH,
      spec.floorY + HEADER_LIFT,
      seat.z - Math.cos(mid) * HOLO_REACH,
    )
    header.rotation.order = 'YXZ'
    header.rotation.set(-0.1, labelYaw(mid), 0)
  }
  const paintHeader = (text: string): void => {
    const ctx = headerCanvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, headerCanvas.width, headerCanvas.height)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = PLATE_INK
    ctx.font = `600 48px ${MONO}`
    ctx.fillText(text, headerCanvas.width / 2, headerCanvas.height / 2, headerCanvas.width * 0.96)
    headerTexture.needsUpdate = true
  }

  // The two lap plates: the room's own, copied where they stand. Geometry is
  // shared; every material is the shelf's own, because a plate's colour and
  // its fill ring move with the aim.
  const plates: ShelfPlate[] = ([-1, 1] as const).map((side) => {
    const roomPlate = base.object.getObjectByName(
      side < 0 ? 'hangar-page-prev' : 'hangar-page-next',
    )
    if (!roomPlate) throw new Error('your courses: the room has no lap plates')
    const group = roomPlate.clone(true)
    group.name = side < 0 ? SHELF_NAMES.back : SHELF_NAMES.next
    let material: THREE.MeshBasicMaterial | null = null
    let fill: THREE.Mesh | null = null
    let label: THREE.Mesh | null = null
    for (const child of group.children) {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) continue
      mesh.material = (mesh.material as THREE.Material).clone()
      const type = mesh.geometry.type
      if (type === 'RingGeometry') fill = mesh
      else if (type === 'PlaneGeometry') label = mesh
      else if (
        type === 'CircleGeometry' &&
        (mesh.geometry as THREE.CircleGeometry).parameters.segments > 3
      )
        material = mesh.material as THREE.MeshBasicMaterial
    }
    if (!material || !fill || !label) throw new Error('your courses: a lap plate is not whole')
    const roomPlateCanvas = ((label as THREE.Mesh).material as THREE.MeshBasicMaterial).map
      ?.image as HTMLCanvasElement
    const canvas = backedCanvas(roomPlateCanvas)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    ;((label as THREE.Mesh).material as THREE.MeshBasicMaterial).map = texture
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = PLATE_INK
      ctx.font = `700 72px ${MONO}`
      // BACK names the step it takes you to, as the room's does: the door
      // stands on the place step, so that is where it goes.
      const word = side < 0 ? BACK_WORDS[YOUR_COURSES.doorStep] : 'PAGE'
      ctx.fillText(word, canvas.width / 2, canvas.height / 2, canvas.width * 0.94)
    }
    texture.needsUpdate = true
    ;(fill as THREE.Mesh).visible = false
    group.visible = false
    shelfGroup.add(group)
    return { group, material, fill, canvas, texture, side }
  })

  // ── state ──────────────────────────────────────────────────────────────
  let disposed = false
  /** The shelf is up, and the room's arc is lent to it. */
  let open = false
  let page = 0
  /** The course a load is focused on (DEV-465), as the app asked. */
  let loadFocus: string | null = null
  let busy: string | null = null
  let aimed: Aimed | null = null
  let aimAlong: number | null = null
  let dwell = 0
  let gazed = false
  let chosen: MissionCard | null = null
  /** The entries as last read, by reference. */
  let seen: readonly LibraryEntry[] = []
  /** DEV-558: the actions as last read, and what they said (a new note is a change). */
  let seenActions: readonly ShelfAction[] = []
  let seenActionsKey = ''
  /** The items the shelf is laid on: re-read only when it is safe to move a table. */
  let laid: readonly ShelfItem[] = []
  /** Expanded levels and their cards, by course id. Only what the shelf has read. */
  const levels = new Map<string, Level>()
  const cards = new Map<string, MissionCard>()
  const pending = new Map<string, Promise<Level | null>>()
  /** The door's bearing on the step that is up, or null where it stands nowhere. */
  let doorAt: number | null = null
  let doorShows: string | null = null

  const readLevel = (entry: LibraryEntry): Promise<Level | null> => {
    const hit = pending.get(entry.id)
    if (hit) return hit
    const read = opts
      .levelFor(entry)
      .then((level) => {
        levels.set(level.id, level)
        cards.set(level.id, cardOf(level))
        return level
      })
      .catch((error: unknown) => {
        console.warn(`your courses: ${entry.id} could not be read —`, error)
        return null
      })
    pending.set(entry.id, read)
    return read
  }

  const clearDiorama = (table: ShelfTable): void => {
    if (!table.diorama) return
    table.group.remove(table.diorama.object)
    table.diorama.dispose()
    table.diorama = null
  }

  /** Stand `entry`'s island on `table`, when its shape lands, if nothing moved meanwhile. */
  const dress = (table: ShelfTable, entry: LibraryEntry): void => {
    const generation = ++table.generation
    clearDiorama(table)
    void readLevel(entry).then(async (level) => {
      if (disposed || generation !== table.generation) return
      if (!level) {
        paintTable(table, { title: entry.name, detail: 'could not be read', best: '' }, true)
        return
      }
      if (table !== door) paintTable(table, courseLines(entry, cards.get(level.id) ?? null))
      let shape: MissionShape
      try {
        shape = await shapeOf(level)
      } catch (error: unknown) {
        console.warn(`your courses: no island for ${entry.id} —`, error)
        return
      }
      if (disposed || generation !== table.generation) return
      const diorama = createDiorama({
        field: shape.field,
        palette: shape.palette,
        holo: opts.holoLook?.() ?? null,
        seaLevel: shape.seaLevel ?? null,
        // A solid on the table, as the room's (DEV-579).
        body: TABLE_BODY,
        route: shape.route,
        pads: shape.pads,
        size: MODEL_SIZE,
        craftScale: YOUR_COURSES.craftScale,
        routeColour: YOUR_COURSES.routeColour,
      })
      diorama.object.position.y = DIORAMA_LIFT
      table.group.add(diorama.object)
      table.diorama = diorama
    })
  }

  const restLook = (table: ShelfTable): void => {
    // DEV-574: the highlight square only while aimed, as the room's tables.
    table.highlight.visible = false
    table.diorama?.object.scale.setScalar(1)
  }
  const aimedLook = (table: ShelfTable): void => {
    // Laid again as it shows: the pedestal may have landed since `place`.
    layHighlight(table.highlight, table.bearing, table.pedestal?.rotation.y ?? null)
    table.highlight.visible = true
    table.diorama?.object.scale.setScalar(1.1)
  }

  const pageCount = (): number => shelfPages(laid).length

  /** Lay the shelf's page on its tables. */
  const layShelf = (): void => {
    // A re-lay restyles every table, so whatever was aimed is aimed afresh.
    clearAim()
    laid = shelfItems(seenActions, seen)
    const pages = shelfPages(laid)
    page = pages.length ? wrapPage(page, 0, pages.length) : 0
    const row = pages[page] ?? []
    const bearings = tableBearings(row.length)
    for (const [i, table] of tables.entries()) {
      const item = row[i] ?? null
      const entry = item?.kind === 'course' ? item.entry : null
      const action = item?.kind === 'action' ? item.action : null
      table.entry = entry
      table.action = action
      table.group.visible = item !== null
      table.group.userData.missionId = entry?.id
      // DEV-558: an action table's id, for anything reading the scene.
      table.group.userData.action = action?.id
      restLook(table)
      if (!entry) {
        table.generation++
        clearDiorama(table)
        if (!action) continue
        // DEV-558: an action is a bare table, its three lines on it.
        place(table, bearings[i] as number)
        paintTable(table, actionLines(action), action.refused === true)
        continue
      }
      place(table, bearings[i] as number)
      paintTable(table, courseLines(entry, cards.get(entry.id) ?? null))
      dress(table, entry)
    }
    placeHeader(bearings)
    paintHeader(shelfHeader(seen.length, page, pages.length))
    header.visible = true
    ;(plates[0] as ShelfPlate).group.visible = true
    ;(plates[1] as ShelfPlate).group.visible = pages.length > 1
  }

  const clearAim = (): void => {
    if (aimed?.kind === 'course') restLook(aimed.table)
    if (aimed?.kind === 'door') restLook(door)
    aimed = null
    aimAlong = null
    door.group.userData.aimed = false
    dwell = 0
  }

  const openShelf = (): void => {
    open = true
    page = 0
    clearAim()
    door.group.visible = false
    shelfGroup.visible = true
    // The room's arc, lent: DEV-465's hide, under a sentinel no table stands for.
    base.focus(SHELF_LENT)
    layShelf()
  }

  const closeShelf = (): void => {
    if (!open) return
    open = false
    clearAim()
    shelfGroup.visible = false
    for (const table of tables) {
      table.generation++
      clearDiorama(table)
      table.entry = null
      table.action = null
      table.group.visible = false
    }
    if (loadFocus === null) base.focus(null)
  }

  /** The door: whether it stands, where, and what it shows. Every frame. */
  const syncDoor = (): void => {
    const list = opts.entries()
    // DEV-558: the actions, read as the entries are; a changed note is a change.
    const actions = opts.enabled() ? (opts.actions?.() ?? []) : []
    const actionsKey = actions.map((a) => `${a.id}:${a.note}`).join('|')
    if (list !== seen || actionsKey !== seenActionsKey) {
      seen = list
      seenActions = actions
      seenActionsKey = actionsKey
      // A new list moves tables only when nothing is aimed at or loading on them.
      if (open && loadFocus === null && aimed === null) layShelf()
    }
    const row = base.pages[base.page] ?? []
    const up =
      !open &&
      loadFocus === null &&
      base.focused === null &&
      base.view === YOUR_COURSES.doorStep &&
      row.length > 0 &&
      // DEV-880: a LOCATION step only (a lesson's course step is not one).
      row.some((slot) => slot?.kind === 'place') &&
      opts.enabled() &&
      (seen.length >= YOUR_COURSES.doorMinimum || seenActions.length > 0)
    doorAt = up ? doorBearing(stepBearings(base.view, row.length)) : null
    const shown = up && doorAt !== null
    if (!shown) {
      if (aimed?.kind === 'door') clearAim()
      door.group.visible = false
      return
    }
    if (door.bearing !== doorAt || !door.group.visible) place(door, doorAt as number)
    door.group.visible = true
    const newest = seen[0] ?? null
    const key = `${newest?.id ?? ''}|${seen.length}`
    if (doorShows !== key) {
      doorShows = key
      paintTable(door, doorLines(seen))
      if (newest === null) {
        // DEV-558: no course kept yet, only the actions: a bare door.
        door.generation++
        clearDiorama(door)
        door.entry = null
      } else if (door.diorama === null || door.entry?.id !== newest.id) {
        door.entry = newest
        dress(door, newest)
      }
    }
  }

  const _origin = new THREE.Vector3()
  const _direction = new THREE.Vector3()
  const _centre = new THREE.Vector3()
  const centres: [number, number, number][] = []

  const centreOf = (local: { x: number; y: number; z: number }): [number, number, number] => {
    _centre.set(local.x, local.y, local.z).applyMatrix4(root.matrixWorld)
    return [_centre.x, _centre.y, _centre.z]
  }
  const along = (c: readonly [number, number, number]): number | null => {
    const length = _direction.length()
    return length > 0
      ? ((c[0] - _origin.x) * _direction.x +
          (c[1] - _origin.y) * _direction.y +
          (c[2] - _origin.z) * _direction.z) /
          length
      : null
  }

  const setAim = (next: Aimed | null, at: readonly [number, number, number] | null): void => {
    const same =
      (next === null && aimed === null) ||
      (next !== null &&
        aimed !== null &&
        next.kind === aimed.kind &&
        (next.kind !== 'course' || (aimed.kind === 'course' && next.table === aimed.table)) &&
        (next.kind !== 'plate' || (aimed.kind === 'plate' && next.plate === aimed.plate)))
    if (!same) {
      // A dwell survives only an unbroken aim at the same plate (`clearAim`).
      clearAim()
      aimed = next
      if (next?.kind === 'course') aimedLook(next.table)
      if (next?.kind === 'door') {
        aimedLook(door)
        door.group.userData.aimed = true
      }
    }
    aimAlong = at ? along(at) : null
  }

  const aimFor = (a: Aimed | null): HangarAim | null => {
    if (a === null) return null
    if (a.kind === 'course') {
      const card = a.table.entry ? (cards.get(a.table.entry.id) ?? null) : null
      return card ? { kind: 'mission', mission: card } : null
    }
    if (a.kind === 'plate') return a.plate.side < 0 ? { kind: 'back' } : { kind: 'page', delta: 1 }
    // The door has no kind in the room's union; `gaze` still returns true for
    // it (a thing a press acts on), and the probe names it.
    return null
  }

  const turnShelf = (delta: number): number => {
    const count = pageCount()
    if (count === 0) return 0
    page = wrapPage(page, delta, count)
    clearAim()
    layShelf()
    return page
  }

  /** Put every shelf table but `id`'s by, with the plates and header. DEV-465. */
  const applyFocus = (id: string): void => {
    for (const table of tables) {
      const keep = table.group.visible && table.entry?.id === id
      table.group.visible = keep
      if (keep) aimedLook(table)
    }
    for (const plate of plates) plate.group.visible = false
    header.visible = false
  }

  const hangar: HangarArt = new Proxy(base, {
    get(target, key) {
      switch (key) {
        case 'update':
          return (seconds: number) => {
            target.update(seconds)
            for (const table of tables) table.diorama?.update(seconds)
            door.diorama?.update(seconds)
            const plate = aimed?.kind === 'plate' ? aimed.plate : null
            const stepped = advanceDwell(dwell, seconds, plate !== null, gazed)
            dwell = stepped.held
            if (!gazed) clearAim()
            gazed = false
            if (stepped.turn && plate) {
              if (plate.side < 0) closeShelf()
              else turnShelf(1)
            }
            for (const p of plates) {
              const active = p === plate
              p.fill.visible = active
              p.fill.scale.setScalar(active ? Math.max(0.001, dwell / PAGE_DWELL_SECONDS) : 0.001)
              p.material.color.set(active ? PLATE_AIMED : PLATE_REST)
            }
          }
        case 'gaze':
          return (origin: THREE.Vector3, direction: THREE.Vector3): boolean => {
            const roomHit = target.gaze(origin, direction)
            gazed = true
            syncDoor()
            syncFurniture()
            if (loadFocus !== null || disposed) {
              clearAim()
              return roomHit
            }
            _origin.copy(origin)
            _direction.copy(direction)
            root.updateWorldMatrix(true, false)
            if (!open) {
              if (roomHit || !door.group.visible || doorAt === null) {
                setAim(null, null)
                return roomHit
              }
              centres[0] = centreOf(tableGazeLocal(spec, doorAt))
              const hit = pickNearestSphere(
                _origin.x,
                _origin.y,
                _origin.z,
                _direction.x,
                _direction.y,
                _direction.z,
                centres,
                GAZE_RADIUS,
                1,
              )
              setAim(hit === 0 ? { kind: 'door' } : null, hit === 0 ? (centres[0] ?? null) : null)
              return hit === 0
            }
            // The shelf: its tables first, then its plates, as the room orders them.
            const live = tables.filter(
              (t) => t.group.visible && (t.entry !== null || t.action !== null),
            )
            for (const [i, t] of live.entries())
              centres[i] = centreOf(tableGazeLocal(spec, t.bearing))
            const tableHit = pickNearestSphere(
              _origin.x,
              _origin.y,
              _origin.z,
              _direction.x,
              _direction.y,
              _direction.z,
              centres,
              GAZE_RADIUS,
              live.length,
            )
            if (tableHit >= 0) {
              const table = live[tableHit] as ShelfTable
              setAim({ kind: 'course', table }, centres[tableHit] ?? null)
              // A table whose course has not been read yet is on screen and not
              // pressable: it lights, and `aim` stays null until its card lands.
              return true
            }
            const livePlates = plates.filter((p) => p.group.visible)
            for (const [i, p] of livePlates.entries()) {
              p.group.updateWorldMatrix(true, false)
              _centre.setFromMatrixPosition(p.group.matrixWorld)
              centres[i] = [_centre.x, _centre.y, _centre.z]
            }
            const plateHit = pickNearestSphere(
              _origin.x,
              _origin.y,
              _origin.z,
              _direction.x,
              _direction.y,
              _direction.z,
              centres,
              ARROW_GAZE_RADIUS,
              livePlates.length,
            )
            if (plateHit >= 0) {
              setAim(
                { kind: 'plate', plate: livePlates[plateHit] as ShelfPlate },
                centres[plateHit] ?? null,
              )
            } else setAim(null, null)
            return false
          }
        case 'aim':
          return aimed !== null ? aimFor(aimed) : open ? null : target.aim
        case 'aimDistance':
          return aimed !== null ? aimAlong : open ? null : target.aimDistance
        case 'chosen':
          return chosen ?? target.chosen
        case 'choose':
          return (): MissionCard | null => {
            if (busy !== null || loadFocus !== null) return null
            if (!open) {
              if (aimed?.kind === 'door') {
                openShelf()
                return null
              }
              const picked = target.choose()
              if (picked) chosen = null
              return picked
            }
            if (aimed?.kind === 'plate') {
              if (aimed.plate.side < 0) closeShelf()
              else turnShelf(1)
              return null
            }
            if (aimed?.kind === 'course' && aimed.table.action) {
              // DEV-558: an action is the app's to do (a file picker, the
              // editor); nothing boards from the shelf here.
              opts.onAction?.(aimed.table.action.id)
              return null
            }
            if (aimed?.kind === 'course' && aimed.table.entry) {
              const entry = aimed.table.entry
              const level = levels.get(entry.id)
              const card = cards.get(entry.id)
              if (!level || !card) return null
              chosen = card
              opts.onBoard?.(entry, level)
              return card
            }
            return null
          }
        case 'focus':
          return (id: string | null): void => {
            loadFocus = id
            clearAim()
            if (id !== null) {
              door.group.visible = false
              if (open) applyFocus(id)
              target.focus(id)
              return
            }
            if (open) {
              // Back as it lays; a list that moved under the load lays now.
              layShelf()
              target.focus(SHELF_LENT)
            } else target.focus(null)
          }
        case 'focused':
          return loadFocus
        case 'setBusy':
          return (text: string | null): void => {
            busy = text
            target.setBusy(text)
          }
        case 'goBack':
          return (): void => {
            if (open) closeShelf()
            else target.goBack()
          }
        case 'showVehicles':
          return (): void => {
            closeShelf()
            target.showVehicles()
          }
        // DEV-558: the doors are in front of the aircraft; the shelf goes too.
        case 'showDoors':
          return (): void => {
            closeShelf()
            target.showDoors()
          }
        case 'turnPage':
          return (delta: number): number => (open ? turnShelf(delta) : target.turnPage(delta))
        case 'refresh':
          return (): void => {
            target.refresh()
            // A run just flown is a best the cards were read without.
            for (const [id, level] of levels) cards.set(id, cardOf(level))
            // The holo look may have moved: every island is rebuilt.
            doorShows = null
            door.entry = null
            if (open && loadFocus === null) layShelf()
          }
        case 'relabel':
          return (): void => {
            target.relabel()
            for (const table of tables) {
              if (table.entry && table.group.visible)
                paintTable(table, courseLines(table.entry, cards.get(table.entry.id) ?? null))
            }
          }
        case 'dispose':
          return (): void => {
            disposed = true
            // The shelf owns its materials and canvases; every geometry is the
            // room's, shared, and the room frees it.
            for (const table of [...tables, door]) {
              clearDiorama(table)
              table.texture.dispose()
              ;(table.label.material as THREE.Material).dispose()
            }
            for (const plate of plates) {
              plate.texture.dispose()
              disposeTree(plate.group, { geometry: false })
            }
            headerTexture.dispose()
            headerMaterial.dispose()
            base.object.remove(root)
            target.dispose()
          }
        default:
          return Reflect.get(target, key, target)
      }
    },
  })

  return {
    hangar,
    levelOf(id: string): Level | null {
      if (!id.startsWith('pc_')) return null
      return levels.get(id) ?? null
    },
    probe(): YourCoursesProbe {
      const a = aimed
      return {
        door: { up: door.group.visible, bearing: doorAt, aimed: a?.kind === 'door' },
        open,
        page,
        pageCount: pageCount(),
        tables: tables
          .filter((t) => t.group.visible && (t.entry || t.action))
          .map((t) => (t.entry?.id ?? t.action?.id) as string),
        aimed:
          a === null
            ? null
            : a.kind === 'door'
              ? 'door'
              : a.kind === 'plate'
                ? a.plate.side < 0
                  ? 'back'
                  : 'next'
                : (a.table.entry?.id ?? a.table.action?.id ?? null),
        focus: loadFocus,
      }
    },
  }
}
