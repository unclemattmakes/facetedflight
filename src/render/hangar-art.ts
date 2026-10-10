// src/render/hangar-art.ts — 2016's level-select room, drawn (DEV-430).
//
// Matt, 2026-09-26: *"would also like the original hangar art, holotable art,
// etc, ported so we can have better parity with the 2016 version."*
//
// Until now the room you choose a mission in was `sim/hangar.ts`'s generated
// revolve: a twelve-sided well, strip lights, girders and a plinth made to the
// video's frames, because the meshes 2016 drew were "bought geometry, cannot
// ship". Hard rule 7 stopped saying that on 2026-09-23. So this draws the room
// 2016 drew, out of `setGameplayOptions.unity` by way of
// `tools/assets/convert-hangar-art.mjs`:
//
//   hangar-room.glb     the shell (`botfloor_room`), the stepped lower shaft
//                       (`botfloor_startingArea2`), the lift's deck under the
//                       jet (`Projector04-Faceted`), ONE shaft segment (walls,
//                       pipes, vent) that 2016 stacks eight high, and the cyan
//                       light tubes (`botfloor_startingArea`)
//   commander-chair.glb `MM_Commander_Chair_01`, the chair you sit in
//   commander-table.glb `MM_Commander_Table_01`, every holotable's pedestal
//
// It is furniture and nothing else. `render/hangar.ts` keeps every table, every
// step, the pointer, the seat and the parked jet exactly where they were; one
// block there hands this file the room's group and the pieces the art stands in
// for, and when the three GLBs land those pieces are HIDDEN — not removed, so a
// failed load (a missing asset, an offline R2) leaves the generated room
// standing, which is the room the game had yesterday.
//
// ── Where 2016's room goes: the lift's axis, the floor, and the SEAT's bearing ──
//
// 2016's room and shaft are both centred on the lift — `botfloor_room`'s bounds
// centre sits 0.1 m off the `Elevator` transform, the shaft 0.4 m — and so is
// the port's, whose origin IS the platform's axis. So the converter writes the
// room in a frame whose origin is the lift's axis at the floor, and the only
// thing left to choose is the turn about that axis. It is chosen so that 2016's
// EYE — `CenterEyeAnchor`, 9.97 m from the axis — lands on the bearing of the
// port's seat, 8.48 m from it. The view from the chair therefore has 2016's room
// behind the jet, turned the way 2016 turned it; the chair itself sits 1.49 m
// nearer the jet than 2016's did, because the SEAT is gameplay and stays put.
// Scale is never touched: the metre is sacred (ART_DIRECTION pillar 3).
//
// ── Three placements that are not the room's frame ───────────────────────
//
//   the CHAIR   anchored to the EYE. 2016's eye sits 1.04 m above the chair's
//               pivot and 0.16 m in front of it; those numbers ride in the
//               chair GLB and the chair is placed so the port's eye lands on
//               them, facing the arc's centre the way 2016's camera faced its
//               middle table. The port's eye is 0.13 m lower than 2016's, so the
//               chair hovers 0.11 m off the floor — 2016's hovered 0.23.
//   no DISC     Unity's own built-in cylinder under the chair (a live renderer,
//               `Cylinder (1)`, in Unity's white Default-Material) is NOT
//               drawn. Unity's mesh could not cross anyway (hard rule 7's
//               exception); its numbers could — radius 0.68 m, its top 4.5 cm
//               proud of the floor — and the chair GLB carries them. Drawn from
//               them, it was a white disc filling the bottom of the resting view:
//               2016's tables stood 1.2 m from the eye and hid it, the port's
//               stand at 1.43 m and do not, and it is the only white surface in
//               the room, in Unity's placeholder material. Matt's call (DEV-430).
//   the DECK    anchored to the JET: its top at `parkY`, where the generated
//               plinth's top was and the parked jet stands. That is 0.11 m
//               lower than 2016's deck stood over its floor; its base was 0.53 m
//               under 2016's floor already, so nothing new shows.
//   PEDESTALS   2016's table, scaled UNIFORMLY so its top lands at `TABLE_TOP` —
//               0.48 of 2016's size, a footprint of 0.48 x 0.53 m under the
//               port's 0.52 m rim — and turned so the side 2016 turned
//               toward its eye faces the port's seat. A child of each table's
//               group, so it shows and hides with the table.
//
// ── What it costs ─────────────────────────────────────────────────────────
//
// TWO draws for the whole room: the shell, the lower shaft, the deck, all eight
// shaft segments and the chair merged into one geometry on the
// shell's own material (one program the room already compiled), and the light
// tubes on a vertex-coloured `MeshBasicMaterial`. Plus one per drawn table for
// its pedestal. Against that it hides the generated shell, floor, dressing and
// chair, and 36 separate strip and pod bars. `tests/e2e/hangar-art.spec.ts`
// reads the frame both ways.
//
// ── What may glow ─────────────────────────────────────────────────────────
//
// The tubes, and only the tubes: they are 2016's `Monitor_And_Stuff_Light_01`,
// a self-illuminated SLK material — lamps, which is what ART_DIRECTION lets
// glow. Everything else is tone-mapped: it is a thing in the world.
//
// ── What lights it (DEV-437) ──────────────────────────────────────────────
//
// 2016's own three: the spot over the jet, the key, and the Skyshop ambient,
// read by the generated sheet and built by `hangar-light.ts`. They are in the
// room from the first frame at zero, and come up when the art lands — the
// port's point lamp and the menu scene's flat ambient go to zero at the same
// moment. Until then, and for good if the art never lands, the generated room
// keeps the light it was tuned under.
//
// ── The shaft wears the launch's light (DEV-561) ─────────────────────────
//
// Matt, 2026-10-01, in the hangar: *"fix the lighting in the elevator shaft
// (match the same colors as the in-game elevator)."* The two shafts are the
// same segment out of the same file, and they had been drawn two ways: here on
// DEV-439's reflective material under the room's live lights, which turned the
// bore over the jet near-white and blue with the reflected sky; in the launch
// (`assembleLaunchArt`, below) baked under the same three lights into vertex
// colours, diffuse only. So the menu's shaft now takes the launch's bake, face
// for face (`appendLit` under `roomLightSampler`, in the ROOM frame at the
// menu's size, where both are lit): `hangar-art.test.ts` holds the two colour
// arrays equal. It wears the tubes' unlit material (one program the room
// already compiles) and gives up the reflected sky and the key's shadow ON it,
// neither of which the launch has. It still CASTS: it is the bore the key comes
// down, and the room's shadow is unchanged. And since DEV-568 they share the
// curve too: the menu is always Anniversary (D35), and the launch rig draws
// the menu's curve into its own colours on a look whose curve is not it
// (Classic's none), so on both looks the two shafts read alike ("the rig
// wears the HANGAR's curve", below).

import * as THREE from 'three'
import { assetUrl } from '@/content/asset-url'
import { PROPS } from '@/generated/constants.generated'
import {
  bareHangarLightRig,
  configureReflective,
  createHangarLight,
  fillReflectiveSky,
  HANGAR_LIGHT_SHEET,
  type HangarLight,
  turnReflectiveSky,
} from './hangar-light'
import { HOVER_GLOW_NAMES } from './hover-glow'
import { LAMBERT1_COLOR_SRGB } from './lambert1'
import { loadMesh } from './load-mesh'
import { EMBLEM_GOLD } from './loading-scene'
import { disposeTree } from './scene-walk'
import { HANGAR_SHAFT_PAINTED_MESH, paintShaft, shaftPaint } from './shaft-paint'
import { type ToneLook, toneColoursFor } from './tone'

/** The three GLBs, as `tools/assets/convert-hangar-art.mjs` writes them. */
export const HANGAR_ROOM_MESH = 'assets/hangar/hangar-room.glb'
export const HANGAR_CHAIR_MESH = 'assets/hangar/commander-chair.glb'
export const HANGAR_TABLE_MESH = 'assets/hangar/commander-table.glb'

type V3 = readonly [number, number, number]

/** `hangar-room.glb`'s root extras, in the ROOM frame (the lift's axis, at the floor). */
export interface RoomFacts {
  /** 2016's eye, `CenterEyeAnchor`. */
  readonly eye: V3
  /** Its resting look, a unit vector. */
  readonly look: V3
  /** The `HoverJet` object's origin. */
  readonly jet: V3
  /** The top face of Unity's own `Cube` under `Elevator_animator`: the lift's deck box. */
  readonly elevatorDeck: { readonly corners: readonly V3[] }
  /** How far up each of the eight shaft segments sits from the first. */
  readonly shaftRepeats: readonly number[]
}

/** `commander-chair.glb`'s root extras, in the CHAIR's own frame. */
export interface ChairFacts {
  /** 2016's eye, `CenterEyeAnchor`, in the chair's frame. */
  readonly eye: V3
  /** Its resting look, a unit vector in the chair's frame. */
  readonly look: V3
}

/** `commander-table.glb`'s root extras, in the TABLE's own frame. */
export interface TableFacts {
  /** Per 2016 table: the horizontal direction to 2016's eye. */
  readonly toSeat: readonly { readonly direction: V3 }[]
}

const isV3 = (v: unknown): v is V3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number')

const refuse = (what: string): never => {
  throw new Error(`hangar-art: ${what} (re-run tools/assets/convert-hangar-art.mjs)`)
}

/** Read and check a root's extras. Throws on anything missing: a guess would place the room. */
export const roomFactsOf = (root: THREE.Object3D): RoomFacts => {
  const u = root.userData as Partial<Record<keyof RoomFacts, unknown>>
  if (!isV3(u.eye) || !isV3(u.look) || !isV3(u.jet))
    refuse('hangar-room.glb carries no eye/look/jet')
  const deck = u.elevatorDeck as { corners?: unknown[] } | undefined
  if (!deck?.corners?.every(isV3) || deck.corners.length !== 4) refuse('no elevator deck corners')
  const repeats = u.shaftRepeats
  if (
    !Array.isArray(repeats) ||
    repeats.length === 0 ||
    !repeats.every((n) => typeof n === 'number')
  )
    refuse('no shaft repeats')
  return u as unknown as RoomFacts
}

export const chairFactsOf = (root: THREE.Object3D): ChairFacts => {
  const u = root.userData as Partial<Record<keyof ChairFacts, unknown>>
  if (!isV3(u.eye) || !isV3(u.look)) refuse('the chair has no eye/look')
  return u as unknown as ChairFacts
}

export const tableFactsOf = (root: THREE.Object3D): TableFacts => {
  const u = root.userData as { toSeat?: { direction?: unknown }[] }
  if (!u.toSeat?.length || !u.toSeat.every((t) => isV3(t.direction)))
    refuse('the table has no toSeat')
  return u as unknown as TableFacts
}

// ── The placements, pure ─────────────────────────────────────────────────────
//
// Every angle below is an AZIMUTH in three's own convention, `atan2(x, z)`, the
// quantity a turn about +y adds to: `rotation.y = ψ` takes (sin a, ·, cos a) to
// (sin(a + ψ), ·, cos(a + ψ)). `hangar-art.test.ts` checks each placement by
// where it PUTS things, with three's own matrices, never by the angle.

const azimuth = (x: number, z: number): number => Math.atan2(x, z)

/**
 * The turn about the lift's axis that puts 2016's eye on the seat's bearing.
 *
 * The seat is `seatEyeLocal`, in the room group's frame, whose origin is the
 * same axis. Only the bearing is matched, never the distance (see the header).
 */
export const roomYaw = (eye: V3, seat: { readonly x: number; readonly z: number }): number =>
  azimuth(seat.x, seat.z) - azimuth(eye[0], eye[2])

/** The ROOM frame → the room group's frame: turn about the axis, then stand on the floor. */
export const roomMatrix = (
  facts: Pick<RoomFacts, 'eye'>,
  seat: { readonly x: number; readonly z: number },
  floorY: number,
): THREE.Matrix4 =>
  new THREE.Matrix4().makeRotationY(roomYaw(facts.eye, seat)).setPosition(0, floorY, 0)

/**
 * The CHAIR frame → the room group's frame.
 *
 * Turned so 2016's resting look (in the chair's frame) points down the port's
 * arc — the room group's −z, azimuth π — and moved so 2016's eye point lands on
 * the port's eye. Both numbers are the chair GLB's own.
 *
 * DEV-858: the port's eye does not rest on −z. It rests `restBearing` radians
 * off it (`SEAT_REST_BEARING`, positive to the right), and a chair square to
 * −z sat 15 degrees askew of where its sitter looks ("the chair seems to be at
 * an odd angle"). A bearing θ is azimuth π − θ, so the chair is turned to that.
 * Default 0, the chair as it stood.
 */
export const chairMatrix = (
  chair: Pick<ChairFacts, 'eye' | 'look'>,
  seatEye: { readonly x: number; readonly y: number; readonly z: number },
  restBearing = 0,
): THREE.Matrix4 => {
  const turn = new THREE.Matrix4().makeRotationY(
    Math.PI - restBearing - azimuth(chair.look[0], chair.look[2]),
  )
  const eye = new THREE.Vector3(...chair.eye).applyMatrix4(turn)
  return turn.setPosition(seatEye.x - eye.x, seatEye.y - eye.y, seatEye.z - eye.z)
}

/**
 * A pedestal's turn inside its table's group, whose frame is the room group's,
 * unrotated (`render/hangar.ts`: *"the group is NEVER yawed"*). The side 2016's
 * tables turned toward their eye — the mean of the three on `page_shipSelection`
 * — faces the port's seat, which from a table at `bearing` is azimuth −bearing.
 */
export const pedestalYaw = (table: TableFacts, bearing: number): number => {
  let x = 0
  let z = 0
  for (const t of table.toSeat) {
    x += t.direction[0]
    z += t.direction[2]
  }
  return -bearing - azimuth(x, z)
}

/** Seat-local helper for a caller: the room group's floor under a point. */
export interface HangarArtPlacement {
  /** `seatEyeLocal(spec)`: the eye, in the room group's frame. */
  readonly seat: { readonly x: number; readonly y: number; readonly z: number }
  /** `spec.floorY`. */
  readonly floorY: number
  /** Where the parked jet stands: the generated plinth's top (`plinthTopY`). */
  readonly parkY: number
  /** `TABLE_TOP`: a table's top over the floor. The pedestal's top lands on it. */
  readonly tableTop: number
  /** DEV-858: where the eye rests, radians off the room's forward (`SEAT_REST_BEARING`); the chair faces it. Default 0. */
  readonly restBearing?: number
}

/** Everything the three GLBs make, in the room group's frame, not yet in any scene. */
export interface HangarArtMeshes {
  /** The lower shaft and the chair: ONE draw, Diffuse IBL. Casts (DEV-440). */
  readonly room: THREE.Mesh
  /** The shell, `botfloor_room`: receives and does not cast, as 2016's scene set it (DEV-440). */
  readonly shell: THREE.Mesh
  /** The lift's deck: 2016's `lambert1`, one of the two reflective materials (DEV-439). */
  readonly deck: THREE.Mesh
  /**
   * The eight shaft segments, baked under 2016's room light as the launch's are
   * and drawn on the tubes' unlit material (DEV-561; DEV-439 drew them lit and
   * reflective). Casts.
   */
  readonly shaft: THREE.Mesh
  /** The light tubes: one draw, their own light. */
  readonly lamps: THREE.Mesh
  /** One pedestal's geometry, sized to `tableTop`; the caller turns it per table. */
  readonly pedestal: THREE.BufferGeometry
  readonly facts: {
    readonly room: RoomFacts
    readonly chair: ChairFacts
    readonly table: TableFacts
  }
}

const meshNamed = (root: THREE.Object3D, name: string): THREE.Mesh => {
  const mesh = root.getObjectByName(name) as THREE.Mesh | undefined
  if (!mesh?.isMesh) return refuse(`no mesh named ${name}`)
  return mesh
}

/** Append `geometry` (position + color, indexed) to the running arrays through `matrix`. */
const appendTo = (
  out: { positions: number[]; colors: number[]; indices: number[] },
  geometry: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
): void => {
  const p = geometry.getAttribute('position')
  const c = geometry.getAttribute('color')
  if (!p || !c) refuse('a part without position and colour')
  const base = out.positions.length / 3
  const v = new THREE.Vector3()
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(matrix)
    out.positions.push(v.x, v.y, v.z)
    out.colors.push(c.getX(i), c.getY(i), c.getZ(i))
  }
  const index = geometry.getIndex()
  if (index) for (let i = 0; i < index.count; i++) out.indices.push(base + index.getX(i))
  else for (let i = 0; i < p.count; i++) out.indices.push(base + i)
}

const geometryOf = (arrays: { positions: number[]; colors: number[]; indices: number[] }) => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(arrays.positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(arrays.colors, 3))
  geometry.setIndex(arrays.indices)
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * Turn three loaded GLB scenes into the room's meshes. Pure of any scene: the
 * unit suite calls this on the files parsed off disk.
 *
 * `material` is the room's OWN shell material — vertex colours, lit, flat — so
 * the merged room compiles nothing the generated one had not. `light` is what
 * the shaft is baked under: the launch's own sampler (DEV-561).
 */
export const assembleHangarArt = (
  loaded: {
    readonly room: THREE.Object3D
    readonly chair: THREE.Object3D
    readonly table: THREE.Object3D
  },
  at: HangarArtPlacement,
  material: THREE.Material,
  reflective?: { readonly deck: THREE.Material },
  light: RoomLight = roomLightSampler(),
): HangarArtMeshes => {
  const roomRoot = loaded.room.getObjectByName('hangar-room') ?? refuse('no hangar-room node')
  const chairRoot =
    loaded.chair.getObjectByName('commander-chair') ?? refuse('no commander-chair node')
  const tableRoot =
    loaded.table.getObjectByName('commander-table') ?? refuse('no commander-table node')
  const facts = {
    room: roomFactsOf(roomRoot),
    chair: chairFactsOf(chairRoot),
    table: tableFactsOf(tableRoot),
  }

  const toRoom = roomMatrix(facts.room, at.seat, at.floorY)
  const arrays = { positions: [] as number[], colors: [] as number[], indices: [] as number[] }

  // The SHELL on its own since DEV-440: `setGameplayOptions` switches its
  // shadow off (`m_CastShadows: 0` on `botfloor_room`, a scene override), so
  // 2016's key reached the room through its ceiling and was stopped only by
  // what stands in it. It receives; it does not cast.
  const shellArrays = { positions: [] as number[], colors: [] as number[], indices: [] as number[] }
  appendTo(shellArrays, meshNamed(loaded.room, 'room').geometry, toRoom)
  const shell = new THREE.Mesh(geometryOf(shellArrays), material)
  shell.name = 'hangar-2016-shell'
  shell.userData.castShadow = false
  appendTo(arrays, meshNamed(loaded.room, 'roomLower').geometry, toRoom)

  // The deck: its top on `parkY`, where the jet stands. Its OWN draw since
  // DEV-439: it is one of the room's two reflective materials.
  const deckArrays = { positions: [] as number[], colors: [] as number[], indices: [] as number[] }
  const deckPart = meshNamed(loaded.room, 'platform').geometry
  deckPart.computeBoundingBox()
  const deckTop = (deckPart.boundingBox as THREE.Box3).max.y
  const drop = at.parkY - at.floorY - deckTop
  appendTo(
    deckArrays,
    deckPart,
    new THREE.Matrix4().makeTranslation(0, drop, 0).premultiply(toRoom),
  )
  const deck = new THREE.Mesh(geometryOf(deckArrays), reflective?.deck ?? material)
  deck.name = 'hangar-2016-deck'

  // A lamp's material: its own light, in 2016's colours (ART_DIRECTION, "what
  // may glow"). The tubes wear it, and since DEV-561 so does the shaft.
  const unlit = new THREE.MeshBasicMaterial({ vertexColors: true })

  // The shaft: one segment, stacked where 2016 stacked its eight, and BAKED as
  // the launch bakes it (DEV-561, "the shaft wears the launch's light" below):
  // the same faces, the same room light, the same colours, on the tubes'
  // unlit material. Its own draw.
  const shaftArrays = { positions: [] as number[], colors: [] as number[] }
  const segment = meshNamed(loaded.room, 'shaft').geometry
  for (const lift of facts.room.shaftRepeats) {
    appendLit(shaftArrays, segment, new THREE.Matrix4().makeTranslation(0, lift, 0), toRoom, light)
  }
  const shaft = new THREE.Mesh(unindexedOf(shaftArrays), unlit)
  shaft.name = 'hangar-2016-shaft'
  // Unlit, and still a caster: it is the bore 2016's key comes down, so it
  // stays in the key's fit and its shadow (`hangar-light.ts`, `createRoomShadows`).
  shaft.userData.castShadow = true

  // The chair, on the eye.
  const toChair = chairMatrix(facts.chair, at.seat, at.restBearing ?? 0)
  appendTo(arrays, meshNamed(loaded.chair, 'chair').geometry, toChair)
  // No disc under it: see the header ("no DISC").

  const room = new THREE.Mesh(geometryOf(arrays), material)
  room.name = 'hangar-2016'

  const tubes = { positions: [] as number[], colors: [] as number[], indices: [] as number[] }
  appendTo(tubes, meshNamed(loaded.room, 'lamps').geometry, toRoom)
  const lamps = new THREE.Mesh(geometryOf(tubes), unlit)
  lamps.name = 'hangar-2016-lamps'

  // One pedestal, scaled uniformly so 2016's table top lands on `tableTop`.
  const tableGeometry = meshNamed(loaded.table, 'table').geometry.clone()
  tableGeometry.computeBoundingBox()
  const tableHeight = (tableGeometry.boundingBox as THREE.Box3).max.y
  tableGeometry.scale(
    at.tableTop / tableHeight,
    at.tableTop / tableHeight,
    at.tableTop / tableHeight,
  )
  tableGeometry.computeBoundingSphere()

  return { room, shell, deck, shaft, lamps, pedestal: tableGeometry, facts }
}

// ── The parked jet wears the deck's material (DEV-531) ──────────────────────
//
// Matt, 2026-09-29: *"the jet in the hangar stands out as not being lit like
// everything else."* It was not. Every lit surface in the room took 2016's
// light through the room's own materials; the parked jet took it through the
// glTF's — Maya's `lambert1` at 0.5 grey (a third of 2016's albedo in linear:
// 0.214 against `lambert1.mat`'s 0.64), three's default specular (F90 1 at
// roughness 0.55), smooth-shaded, and NO reflected sky. That last one is most
// of it: the jet's sides and belly face away from the spot and the key, and in
// 2016 they were lit by the same Skyshop reflection that turns the deck tan
// (DEV-439) — the jet is Marmoset Vertex Color Specular IBL too. Without it
// the jet read near-black over a white deck (`hangar-jet-before-*.png`).
//
// And it is not a guess which material that is: the jet's `lambert1.mat`
// (`render/lambert1.ts`) IS the deck's — the sheet reads the deck's record off
// `lowPolyArt/Materials/lambert1.mat` (`PROPS.hangar.specular.deck`). So the
// jet wears the deck's material, configured from the deck's record, with one
// difference: the deck's converter baked `_Color` into its vertex colours and
// the jet's GLB did not, so the jet's copy carries `_Color` on `color`
// (`applyLambert1`'s own number). A CLONE of the class the room has drawn
// since its first frame, and the jet's colour narrowed to RGB like the room's,
// so it shares the deck's program: the jet's landing compiles nothing, where
// the glTF material it replaces compiled a program of its own.
//
// `FrontSide`, where the glTF said double-sided: 2016's Marmoset shaders cull
// back faces, and the jet's winding agrees with its normals on 1,339 of its
// 1,341 corners (read off the GLB), so the faces you see are the front ones.

/** DEV-546: the one mesh of a parked jet that keeps its own material — the wing's glow. */
export const PARKED_JET_KEEPS: string = HOVER_GLOW_NAMES[1]

/**
 * DEV-546's follow-up: the wing's projectors, which wear their OWN copy of the
 * hull's material, in `Projector04_Mat`'s `_Color` rather than `lambert1.mat`'s.
 */
export const PARKED_JET_PROJECTORS: string = HOVER_GLOW_NAMES[0]

/** The deck's record, read off `lambert1.mat` — the jet's own material in 2016. */
export const JET_MATERIAL_RECORD = HANGAR_LIGHT_SHEET.specular.deck

/**
 * Configure the parked jet's material: the deck's reflective recipe
 * (`configureReflective`, lambert1's record) with `lambert1.mat`'s `_Color` on
 * `color`, and the reflected sky turned to the room. Uniforms only.
 */
export const configureParkedJet = (
  material: THREE.MeshPhysicalMaterial,
  roomWorld: THREE.Quaternion,
): THREE.MeshPhysicalMaterial => {
  configureReflective(material, JET_MATERIAL_RECORD)
  material.color.setRGB(
    LAMBERT1_COLOR_SRGB[0],
    LAMBERT1_COLOR_SRGB[1],
    LAMBERT1_COLOR_SRGB[2],
    THREE.SRGBColorSpace,
  )
  turnReflectiveSky(material, roomWorld)
  return material
}

/**
 * Put `material` on every mesh under `ship`, narrowing a four-wide colour to
 * RGB (three keys `vertexAlphas` on the width; the room's colours are RGB, and
 * `load-mesh.ts` has already forced every alpha to 1). Returns how many meshes
 * it dressed. The materials it replaces are the loaded glTF's own, and are
 * disposed; the geometry stays the ship's (`parkShip` disposes that).
 *
 * DEV-546: the parked jet carries 2016's anti-grav wing (`game/ship-wings.ts`),
 * as `Environment_Hangar.prefab` hangs it beside `hoverJet_exterior_orange`.
 * Its GLOW keeps its own material — it is the blue of f0030's orbs, and the
 * deck's would put it out. Its PROJECTORS take the hull's, as the racers'
 * projectors take their hull's (DEV-322): Marmoset vertex colour lit by the
 * same Skyshop sky, one program with the deck's, where `Projector04_Mat` alone
 * read black under the wing exactly as the hull did before DEV-531.
 *
 * Matt, 2026-09-30: *"match 2016's projector colour."* So the projectors wear
 * `projectors`, a second clone of the deck's class configured as the hull's is
 * (`configureParkedJet`), and painted here with `Projector04_Mat`'s `_Color`:
 * read off the record the projectors arrived carrying
 * (`material.userData.unity`, which `convert-wings.mjs` read off the `.mat` and
 * `hover-glow.ts`'s `projectorMaterial` keeps), before that material is freed.
 * A colour is a uniform, so the clone shares the deck's program: nothing new
 * compiles. Without the record, or without `projectors`, the projectors keep
 * the hull's colour, as DEV-546 first shipped them.
 */
export const dressParkedJet = (
  ship: THREE.Object3D,
  material: THREE.Material,
  projectors: THREE.Material = material,
): number => {
  let dressed = 0
  ship.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || mesh.material === material || mesh.material === projectors) return
    if (mesh.name === PARKED_JET_KEEPS) return
    const wears = mesh.name === PARKED_JET_PROJECTORS ? projectors : material
    const colour = mesh.geometry.getAttribute('color')
    if (colour && colour.itemSize === 4) {
      const rgb = new Float32Array(colour.count * 3)
      for (let i = 0; i < colour.count; i++) {
        rgb[i * 3] = colour.getX(i)
        rgb[i * 3 + 1] = colour.getY(i)
        rgb[i * 3 + 2] = colour.getZ(i)
      }
      mesh.geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3))
    }
    // And no NORMAL: three keys `vertexNormals` on the attribute's presence,
    // and the room's geometry carries none. The material is flat-shaded (face
    // normals from derivatives), so the GLB's normals were read by nothing —
    // measured: with them, the jet compiled a program of its own that differed
    // from the deck's in that one bit.
    if (mesh.geometry.getAttribute('normal')) mesh.geometry.deleteAttribute('normal')
    const old = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    if (wears !== material) {
      const record = (old[0]?.userData as { unity?: { colorSrgb?: unknown } } | undefined)?.unity
      const srgb = record?.colorSrgb
      const painted = wears as THREE.Material & { color?: THREE.Color }
      if (painted.color && Array.isArray(srgb) && srgb.length >= 3) {
        painted.color.setRGB(
          Number(srgb[0]),
          Number(srgb[1]),
          Number(srgb[2]),
          THREE.SRGBColorSpace,
        )
      }
    }
    for (const m of old) m?.dispose()
    mesh.material = wears
    dressed++
  })
  return dressed
}

// ── The hook ─────────────────────────────────────────────────────────────────

export interface HangarArtOptions extends HangarArtPlacement {
  /** The room's group: the frame `seat`, `floorY` and the tables live in. */
  readonly room: THREE.Object3D
  /** The shell's own material, shared so nothing new compiles. */
  readonly material: THREE.Material
  /** The generated pieces 2016's art stands in for. Hidden, never removed. */
  readonly replaces: readonly THREE.Object3D[]
  /** Every table's group and its bearing: a pedestal goes into each. */
  readonly tables: readonly { readonly group: THREE.Object3D; readonly bearing: number }[]
  /** The generated plinth's geometry: the mesh wearing it in each table is hidden. */
  readonly plinth: THREE.BufferGeometry
  /** False once the room is disposed, so a late load drops what it brought. */
  readonly alive: () => boolean
  /** Fetch a GLB scene. Defaults to `loadMesh(assetUrl(path))`. */
  readonly load?: (path: string) => Promise<THREE.Object3D>
  /**
   * The port's own lights for this room (its point lamp), turned to zero when
   * 2016's come up (DEV-437). Kept in the scene: a light's COUNT is in every
   * lit program's key, so it goes dark rather than away.
   */
  readonly portLights?: readonly THREE.Light[]
  /**
   * The bare rig `render/hangar.ts` built with the room — a spot, a directional
   * light and a probe at zero, already in the scene (`bareHangarLightRig`).
   * Absent, one is built here, which is only early enough when this module was
   * imported before the room's first frame (the unit tests).
   */
  readonly lightRig?: THREE.Group
  /**
   * DEV-439's reflective ambient, as `render/hangar.ts` built it with the room:
   * the EMPTY sky texture, the one reflective material class wearing it, and
   * the primer that draws that material from the room's first frame so its
   * program is compiled by then. Absent, the deck and the shaft wear the
   * shell's material, as before.
   */
  readonly reflective?: {
    readonly texture: THREE.DataTexture
    readonly material: THREE.MeshPhysicalMaterial
    readonly primer: THREE.Mesh
    /**
     * DEV-531: the parked jet's material, a clone of `material` made with the
     * room (so it shares its program). Configured from the deck's record when
     * the art lands; the caller dresses the jet in it once `ready` is true.
     */
    readonly jet?: THREE.MeshPhysicalMaterial
    /**
     * DEV-546's follow-up: the wing projectors' material, a second clone made
     * with the room for the same reason. Configured as `jet` is; the dress
     * paints it `Projector04_Mat`'s `_Color` (`dressParkedJet`).
     */
    readonly projectors?: THREE.MeshPhysicalMaterial
  }
}

export interface HangarArt {
  /** True once 2016's room stands; false if it never will (a failed load keeps the generated one). */
  readonly ready: Promise<boolean>
  /** 2016's three lights: in the room from the first frame, dark until `ready` (DEV-437). */
  readonly light: HangarLight
}

/**
 * The flat ambient the menu scene gives the port's room (`boot/app.ts`: *"the
 * bounce that lamp cannot fake"*). A Marmoset surface takes no Unity ambient —
 * its ambient is the Skyshop SH, which `hangar-light.ts` now carries — so with
 * 2016's light up it is counted twice and goes to zero. Found on the room's
 * PARENT (the menu scene) rather than handed in, because it belongs to the
 * scene and `render/hangar.ts` never sees it; only direct children, so nothing
 * a table or a ship brought is touched. Unlit things (the labels, the islands,
 * the loading plate) never read it.
 */
const sceneAmbientsOf = (room: THREE.Object3D): THREE.AmbientLight[] =>
  (room.parent?.children ?? []).filter(
    (c): c is THREE.AmbientLight => (c as THREE.AmbientLight).isAmbientLight === true,
  )

/**
 * Fetch a GLB scene through `fetch` — and, for `hangar-room.glb`, paint its
 * shaft (DEV-456, `render/shaft-paint.ts`) before anything assembles it, so the
 * level-select room and the launch both get the shaft in the hangar's colours.
 * A painted file that does not land leaves 2016's flat shaft and says so.
 * Exported so the unit suite runs THIS composition on the files off disk.
 */
export const loadRoomArt = async (
  path: string,
  fetch: (path: string) => Promise<THREE.Object3D>,
  paint = shaftPaint(),
): Promise<THREE.Object3D> => {
  const root = await fetch(path)
  if (path !== HANGAR_ROOM_MESH || paint === '2016') return root
  try {
    const painted = await fetch(HANGAR_SHAFT_PAINTED_MESH)
    try {
      paintShaft(root, painted)
    } finally {
      disposeLoaded(painted)
    }
  } catch (error) {
    console.warn("hangar-art: the shaft's paint did not land; 2016's flat shaft stands —", error)
  }
  return root
}

const defaultLoad = (path: string): Promise<THREE.Object3D> =>
  loadRoomArt(path, async (p) => (await loadMesh(assetUrl(p))).object)

/** Drop every geometry and material a loaded GLB brought, once its parts are copied. */
const disposeLoaded = (root: THREE.Object3D): void => disposeTree(root)

/**
 * Load 2016's room and, when it lands, stand it in place of the generated one.
 *
 * Unawaited by the room, the way the parked jet is: *"a room with no jet in it
 * yet is a room, and a boot that blocks on a mesh is not"* (`boot/app.ts`).
 */
export const createHangarArt = (opts: HangarArtOptions): HangarArt => {
  const load = opts.load ?? defaultLoad
  // 2016's light, built NOW and dark: see `hangar-light.ts`, "present from the
  // first frame". Its frame is the room art's, which needs 2016's eye out of the
  // GLB, so it is placed when the art lands.
  const light = createHangarLight(opts.lightRig)
  if (light.group.parent !== opts.room) opts.room.add(light.group)
  const ready = (async (): Promise<boolean> => {
    let loaded: { room: THREE.Object3D; chair: THREE.Object3D; table: THREE.Object3D }
    // DEV-573: the title's emblem, alongside, and not required either.
    const logoLoad = Promise.resolve()
      .then(() => load(TITLE_LOGO_MESH))
      .catch((error: unknown) => {
        console.warn(
          "hangar-art: the title's logo did not load; the room stands without it:",
          error,
        )
        return null
      })
    try {
      const [room, chair, table] = await Promise.all([
        load(HANGAR_ROOM_MESH),
        load(HANGAR_CHAIR_MESH),
        load(HANGAR_TABLE_MESH),
      ])
      loaded = { room, chair, table }
    } catch (error) {
      console.warn("hangar-art: 2016's room did not load; the generated room stays —", error)
      return false
    }
    // The room lands before anything is swapped, so no frame shows the art under an empty sky.
    const logo = await logoLoad
    try {
      if (!opts.alive()) return false
      // DEV-439: the deck's reflective material, of the class the room has
      // been drawing since its first frame, so it compiles nothing here. The
      // shaft wore a second one until DEV-561 baked it as the launch does.
      const reflective = opts.reflective
        ? {
            deck: configureReflective(opts.reflective.material, HANGAR_LIGHT_SHEET.specular.deck),
          }
        : undefined
      const art = assembleHangarArt(loaded, opts, opts.material, reflective)
      opts.room.add(art.shell, art.room, art.deck, art.shaft)
      opts.room.add(art.lamps)
      // DEV-573: the emblem, on the shell's material (see "THE GAME'S EMBLEM").
      const emblem = logo ? assembleRoomEmblem(logo, opts.seat, opts.floorY) : null
      if (emblem) {
        const mesh = new THREE.Mesh(emblem, opts.material)
        mesh.name = 'hangar-emblem'
        mesh.userData.castShadow = false
        opts.room.add(mesh)
      }
      for (const table of opts.tables) {
        const pedestal = new THREE.Mesh(art.pedestal, opts.material)
        pedestal.name = 'holotable-pedestal'
        pedestal.rotation.y = pedestalYaw(art.facts.table, table.bearing)
        table.group.add(pedestal)
        table.group.traverse((node) => {
          const mesh = node as THREE.Mesh
          if (mesh.isMesh && mesh.geometry === opts.plinth) mesh.visible = false
        })
      }
      for (const piece of opts.replaces) piece.visible = false
      // DEV-437: the light goes where the room went, and 2016's comes up in
      // place of the port's. Counts never move; only intensities.
      roomMatrix(art.facts.room, opts.seat, opts.floorY).decompose(
        light.group.position,
        light.group.quaternion,
        light.group.scale,
      )
      light.setOn(true)
      for (const port of opts.portLights ?? []) port.intensity = 0
      for (const ambient of sceneAmbientsOf(opts.room)) ambient.intensity = 0
      // DEV-439: the reflected sky, written now and turned to where the room
      // stands. `dispose` drops the prefilter three made from the empty
      // texture on the room's first frame; the next draw makes it again from
      // this, at the same size, so the program does not move.
      if (opts.reflective && reflective) {
        // DEV-899: the sky is the first-party nine-coefficient one, and the
        // only one. 2016's own cube was Marmoset Skyshop's example sky and is
        // no longer shipped or fetched.
        fillReflectiveSky(opts.reflective.texture)
        opts.reflective.texture.userData.sky = 'sh'
        opts.reflective.texture.dispose()
        light.group.updateWorldMatrix(true, false)
        const world = light.group.getWorldQuaternion(new THREE.Quaternion())
        turnReflectiveSky(reflective.deck, world)
        if (opts.reflective.jet) configureParkedJet(opts.reflective.jet, world)
        if (opts.reflective.projectors) configureParkedJet(opts.reflective.projectors, world)
        opts.reflective.primer.removeFromParent()
        opts.reflective.primer.geometry.dispose()
      }
      return true
    } catch (error) {
      console.warn("hangar-art: 2016's room would not assemble; the generated room stays —", error)
      return false
    } finally {
      for (const root of Object.values(loaded)) disposeLoaded(root)
      if (logo) disposeLoaded(logo)
    }
  })()
  return { ready, light }
}

// ══ THE GAME'S EMBLEM, IN THE ROOM (DEV-573) ═════════════════════════════════
//
// Matt, 2026-10-02, on 0.17.0: *"need the game logo in the hangar (otherwise
// the room we're in the most has no info about the game we're playing"*. 2016's
// level-select room carried none, and nor did the port's.
//
// ── The same art ─────────────────────────────────────────────────────────
//
// The title's emblem: `assets/props/title-logo.glb`, 2016's `logo_polys`, the
// three meshes the title and the loading plate draw (`logo_top` and the
// FACETED FLIGHT wordmark `title` in the title's gold, `logo_bottom` in its
// silver; `render/loading-scene.ts` says where each colour comes from). Its own
// copy, loaded with the room's three GLBs, so the room never waits on the title
// and the title never on the room; a logo that does not land leaves the room
// standing without it.
//
// ── Where it stands: on the floor, in front of the chair (DEV-839) ───────
//
// DEV-573 hung it on the wall, upper left. Matt, 2026-10-08 (playtest):
// *"move the hangar's logo to the floor in front of the player's chair."* So
// it lies flat on the deck between the chair and the tables, centred on the
// resting look ({@link ROOM_EMBLEM}`.bearingDeg`, the seat's own aim), its
// readable side up and its top edge AWAY from the seat, so the wordmark reads
// left to right as the player looks down at it. The chair looks 22.8 degrees
// down through a 70-degree lens, so the floor a metre ahead is in the lower
// part of the flat frame, and a head-down glance in a headset finds it. The
// tables stand 1.43 m out and 0.7 m under the eye, so a logo that ends short
// of them (its far edge at most `HOLO_REACH` less a margin) lies under the
// lap of the tables, not under their legs.
//
// ── Lit as the room is ───────────────────────────────────────────────────
//
// It wears the room's OWN shell material, as the pedestals do: 2016's three
// lights, the Skyshop ambient and the room's shadow fall on it as on the walls,
// so it is a thing in the room rather than a sticker over it, and it carries
// exactly the shell's attributes (a position and a three-channel colour, no
// normal: the material is flat-shaded) so it shares the shell's program and
// compiles nothing. It receives the room's shadow and casts none: it is a sign,
// and a shadow of it across the tables would be a new thing to read there.

/** The title's logo, the same file the title and the loading plate load. */
export const TITLE_LOGO_MESH = 'assets/props/title-logo.glb'

/**
 * Where the room's emblem lies, from the seat, in the room's frame.
 *
 * `bearingDeg` off the room's forward (positive is the viewer's right; the
 * resting look is -15, `SEAT_REST_BEARING`), `distance` metres from the seat
 * along it to the emblem's centre, `widthM` its width, and `lift` how far over
 * the floor it lies (clear of the deck, which z-fights a flat shape at 0).
 * Taste, chosen on the flat frame; the numbers to argue with.
 */
export interface RoomEmblemPlacement {
  readonly bearingDeg: number
  readonly distance: number
  readonly widthM: number
  readonly lift: number
}
export const ROOM_EMBLEM: RoomEmblemPlacement = {
  bearingDeg: -15,
  distance: 1.08,
  widthM: 0.5,
  lift: 0.03,
}

/**
 * The emblem's pose in the room's frame: lying flat on the floor
 * {@link ROOM_EMBLEM} puts it over, centred where it says, its readable side
 * (the logo's own -z, see `render/loading-scene.ts`'s `FRONT_TO_EYE`) UP and
 * its top edge pointing away from the seat.
 */
export const roomEmblemMatrix = (
  seat: { readonly x: number; readonly y: number; readonly z: number },
  floorY: number,
  logoBox: THREE.Box3,
  at: RoomEmblemPlacement = ROOM_EMBLEM,
): THREE.Matrix4 => {
  const b = (at.bearingDeg * Math.PI) / 180
  const away = new THREE.Vector3(Math.sin(b), 0, -Math.cos(b))
  const centre = new THREE.Vector3(
    seat.x + away.x * at.distance,
    floorY + at.lift,
    seat.z + away.z * at.distance,
  )
  const size = logoBox.getSize(new THREE.Vector3())
  const middle = logoBox.getCenter(new THREE.Vector3())
  // After the half turn about y the logo's front is +z, +y is up and +x is the
  // viewer's right (as the wall version stood it). Lay that frame down: its
  // +z becomes world up, its +y becomes `away`, and +x = away x up is the
  // seat's right, so the front reads from the chair.
  const up = new THREE.Vector3(0, 1, 0)
  const lay = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(away, up), away, up)
  const k = at.widthM / size.x
  return (
    new THREE.Matrix4()
      // The logo's back (its max z) goes to the origin, so the whole relief
      // stands over `lift` and none of it sinks into the deck.
      .makeTranslation(-middle.x, -middle.y, -logoBox.max.z)
      .premultiply(new THREE.Matrix4().makeRotationY(Math.PI))
      .premultiply(new THREE.Matrix4().makeScale(k, k, k))
      .premultiply(lay)
      .premultiply(new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z))
  )
}

/**
 * The logo as one geometry in the room's frame: every mesh's triangles through
 * its own transform and {@link roomEmblemMatrix}, coloured by name as the title
 * paints them (`logo_bottom` silver, the rest gold, in linear like the room's
 * own vertex colours), position and colour only. Pure: the unit suite builds it
 * from the file on disk. Null when the logo holds no mesh.
 */
export const assembleRoomEmblem = (
  logo: THREE.Object3D,
  seat: { readonly x: number; readonly y: number; readonly z: number },
  floorY: number,
  at: RoomEmblemPlacement = ROOM_EMBLEM,
): THREE.BufferGeometry | null => {
  logo.updateMatrixWorld(true)
  const root = new THREE.Matrix4().copy(logo.matrixWorld).invert()
  const parts: { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[] = []
  const box = new THREE.Box3()
  logo.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const matrix = new THREE.Matrix4().multiplyMatrices(root, mesh.matrixWorld)
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    box.union((mesh.geometry.boundingBox as THREE.Box3).clone().applyMatrix4(matrix))
    parts.push({ mesh, matrix })
  })
  if (parts.length === 0 || box.isEmpty()) return null
  const place = roomEmblemMatrix(seat, floorY, box, at)
  const gold = new THREE.Color(EMBLEM_GOLD)
  const s = PROPS.medals.colors.silver
  const silver = new THREE.Color().setRGB(s[0], s[1], s[2], THREE.SRGBColorSpace)
  const arrays = { positions: [] as number[], colors: [] as number[], indices: [] as number[] }
  const v = new THREE.Vector3()
  for (const { mesh, matrix } of parts) {
    const colour = /bottom/i.test(mesh.name) ? silver : gold
    const p = mesh.geometry.getAttribute('position')
    const base = arrays.positions.length / 3
    const m = new THREE.Matrix4().multiplyMatrices(place, matrix)
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m)
      arrays.positions.push(v.x, v.y, v.z)
      arrays.colors.push(colour.r, colour.g, colour.b)
    }
    const index = mesh.geometry.getIndex()
    if (index) for (let i = 0; i < index.count; i++) arrays.indices.push(base + index.getX(i))
    else for (let i = 0; i < p.count; i++) arrays.indices.push(base + i)
  }
  return geometryOf(arrays)
}

// ══ THE LAUNCH ROOM (DEV-438) ════════════════════════════════════════════════
//
// Matt, 2026-09-26: *"port the launch room."* Every HoverJet mission starts at
// the bottom of a shaft, in `createHangar`'s unfurnished room, and rides 106 m up
// through `render/elevator.ts`'s generated tube. 2016's rig carries the same
// room this file already draws for the menu — so the launch draws it too, from
// the same `hangar-room.glb`, with no new asset.
//
// ── The same room, at a different SIZE ────────────────────────────────────
//
// The level-select room is a scaled copy: `Environment_Hangar`'s rig carries
// (0.85, 0.733, 0.85), and the GLB is written in its metres. A mission's rig is
// at scale 1. So the launch is 2016's room at full size — 18 % wider and 36 %
// taller than the one you chose the mission in — and one matrix, generated
// (`PROPS.launchRoom.fromRoom`, `tools/extract/constants.mjs` §13g), takes the
// GLB's ROOM frame to `launch-anchor`'s: the ship at rest. The metre is sacred;
// here that means UNDOING the menu's scale, not keeping it.
//
// ── What 2016 SHIPPED of it, and what this draws ──────────────────────────
//
// Censused over the seven HoverJet missions with the liveness walk: the room
// (`startingArea_bottomFloor`) is `m_IsActive: 0` in all seven; the deck under
// the lift is live in four; segment 08, the top of the shaft, in six; segments
// 01–07 in none. 2016 never drew a launch room. The port has drawn one since
// DEV-035 and all eight segments since DEV-024c, on Matt's *"you started in an
// underground hangar and rode the shaft up"* — so this row changes what that
// room and that shaft LOOK like, and nothing about whether they exist:
//
//   the room    `room` + `roomLower`, one draw, and the tubes, one more.
//               Children of the launch room's group, so they hide with it when
//               the world comes on.
//   the shaft   eight segments, one draw. `render/elevator.ts` takes them in
//               place of its pillars, collars, walls and strips. 2016's segment
//               is SEALED — cast from the eye at every rise, no ray gets out
//               sideways — so it does the walls' job (DEV-106).
//   the deck    2016's lift deck, riding in the platform group.
//
// All four on ONE unlit material with 2016's room light baked into it — the
// next block says why the mission's own lights are the wrong ones down here.
//
// Placed from the same anchor as everything else in the launch, so it cannot
// disagree with the lift about where the lift is.

/** `PROPS.launchRoom`: the generated placement. */
interface LaunchRoomSheet {
  /** ROOM frame -> `launch-anchor`'s frame, three space, column-major. */
  readonly fromRoom: readonly number[]
  /** The level-select rig's scale, which `fromRoom` undoes. */
  readonly menuRigScale: readonly number[]
  /**
   * Metres to raise the GLB's deck after `fromRoom`. The one piece the two rigs
   * place differently: the menu's deck sits this much lower under its animator.
   */
  readonly deckLift: number
}

export const LAUNCH_ROOM_SHEET = PROPS.launchRoom as unknown as LaunchRoomSheet

/** The sheet's matrix, as three wants it. Refuses anything that is not sixteen numbers. */
export const launchFromRoom = (sheet: LaunchRoomSheet = LAUNCH_ROOM_SHEET): THREE.Matrix4 => {
  const m = sheet?.fromRoom
  if (!Array.isArray(m) || m.length !== 16 || !m.every(Number.isFinite))
    refuse('PROPS.launchRoom.fromRoom is not a 4x4 (re-run pnpm extract:constants)')
  return new THREE.Matrix4().fromArray(m as number[])
}

// ── Lit as the room is lit in the menu, and baked (DEV-437's light, per face) ──
//
// The first build drew the launch rig on the launch shell's own material, lit
// by whatever lights the MISSION scene holds — and 2016's shaft is near-white
// (`ent_elevatorShaft_pwn_Mat`'s `_Color`, 0.83/0.83/0.91), so a four-degree
// sun with nothing to cast a shadow turned the whole climb white: photographed
// at rises 30 and 98 on `int_01`. The generated tube never had the problem
// because it was painted 8 % grey on purpose (*"there is no sun down here"*).
// Shadows would fix it on Anniversary only; Classic draws none.
//
// So the launch rig takes the light 2016 authored for THIS room — the spot, the
// key and the Skyshop ambient that `hangar-light.ts` stands in the level-select
// room (DEV-437) — evaluated once per face as three's lit material would, and
// baked into the vertex colours of an unlit material. The launch room then
// looks like the room you chose the mission in, because it is the same room
// under the same light; no light is added to the mission scene (a light's
// COUNT is in every lit program's key), and the whole rig compiles one program,
// the tubes' own. It is evaluated in the ROOM frame at the menu's size, where
// those lights live, before `fromRoom` moves and stretches the result.

/** What 2016's room light gives a face: linear radiance per unit albedo, per channel. */
export type RoomLight = (
  centroid: THREE.Vector3,
  normal: THREE.Vector3,
  target: THREE.Color,
) => THREE.Color

/**
 * `hangar-light.ts`'s three lights, turned up in the ROOM frame, as a function:
 * the probe's irradiance, the key's N.L and the spot's cone and falloff, summed
 * and divided by pi — three's `BRDF_Lambert`, so an albedo times this is what a
 * rough lit material draws under them, specular aside.
 */
export const roomLightSampler = (): RoomLight => {
  const light = createHangarLight(bareHangarLightRig())
  light.group.updateMatrixWorld(true)
  light.setOn(true)
  const spot = light.spot
  const spotAt = spot.position.clone()
  // Target to light, as three's `spotLight.direction` is.
  const spotAxis = spot.position.clone().sub(spot.target.position).normalize()
  const coneCos = Math.cos(spot.angle)
  const penumbraCos = Math.cos(spot.angle * (1 - spot.penumbra))
  const spotColour = spot.color.clone().multiplyScalar(spot.intensity)
  const keyToward = light.key.position.clone().sub(light.key.target.position).normalize()
  const keyColour = light.key.color.clone().multiplyScalar(light.key.intensity)
  const sh = light.probe.sh.clone()
  const probeIntensity = light.probe.intensity
  light.dispose()
  const irradiance = new THREE.Vector3()
  const toLight = new THREE.Vector3()
  return (centroid, normal, target) => {
    sh.getIrradianceAt(normal, irradiance).multiplyScalar(probeIntensity)
    const key = Math.max(0, normal.dot(keyToward))
    let r = irradiance.x + keyColour.r * key
    let g = irradiance.y + keyColour.g * key
    let b = irradiance.z + keyColour.b * key
    toLight.copy(spotAt).sub(centroid)
    const d = toLight.length()
    if (d > 0) {
      toLight.divideScalar(d)
      const facing = Math.max(0, normal.dot(toLight))
      const cone = THREE.MathUtils.smoothstep(toLight.dot(spotAxis), coneCos, penumbraCos)
      const falloff = 1 / Math.max(d * d, 0.01)
      const s = facing * cone * falloff
      r += spotColour.r * s
      g += spotColour.g * s
      b += spotColour.b * s
    }
    return target.setRGB(r / Math.PI, g / Math.PI, b / Math.PI)
  }
}

/**
 * Append `geometry`'s triangles, lit: placed in the ROOM frame by `inRoom`, each
 * face's light taken there by `light`, its corners' albedo multiplied by it,
 * and the result moved by `out`. De-indexed, so every face keeps its own light.
 */
const appendLit = (
  to: { positions: number[]; colors: number[] },
  geometry: THREE.BufferGeometry,
  inRoom: THREE.Matrix4,
  out: THREE.Matrix4,
  light: RoomLight,
): void => {
  const p = geometry.getAttribute('position')
  const c = geometry.getAttribute('color')
  if (!p || !c) refuse('a part without position and colour')
  const index = geometry.getIndex()
  const count = index ? index.count : p.count
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const d = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const edge = new THREE.Vector3()
  const centroid = new THREE.Vector3()
  const lit = new THREE.Color()
  const at = (k: number) => (index ? index.getX(k) : k)
  const push = (v: THREE.Vector3, i: number) => {
    const placed = v.applyMatrix4(out)
    to.positions.push(placed.x, placed.y, placed.z)
    to.colors.push(c.getX(i) * lit.r, c.getY(i) * lit.g, c.getZ(i) * lit.b)
  }
  for (let t = 0; t + 2 < count; t += 3) {
    const [ia, ib, id] = [at(t), at(t + 1), at(t + 2)]
    a.fromBufferAttribute(p, ia).applyMatrix4(inRoom)
    b.fromBufferAttribute(p, ib).applyMatrix4(inRoom)
    d.fromBufferAttribute(p, id).applyMatrix4(inRoom)
    normal.subVectors(b, a).cross(edge.subVectors(d, a))
    if (normal.lengthSq() === 0) normal.set(0, 1, 0)
    else normal.normalize()
    centroid.copy(a).add(b).add(d).divideScalar(3)
    light(centroid, normal, lit)
    push(a, ia)
    push(b, ib)
    push(d, id)
  }
}

const unindexedOf = (arrays: { positions: number[]; colors: number[] }) => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(arrays.positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(arrays.colors, 3))
  geometry.computeBoundingSphere()
  return geometry
}

/** 2016's launch rig, in `launch-anchor`'s frame (the ship at rest), not yet in any scene. */
export interface LaunchArtMeshes {
  /** Shell and lower shaft: one draw. */
  readonly room: THREE.Mesh
  /** The light tubes: one draw, their own light. */
  readonly lamps: THREE.Mesh
  /** All eight segments: one draw. */
  readonly shaft: THREE.Mesh
  /** The lift's deck, at rest. */
  readonly deck: THREE.Mesh
  /** The highest point of the shaft, over the ship at rest. */
  readonly shaftTopY: number
}

/**
 * `hangar-room.glb`'s scene, as 2016's LAUNCH rig. Pure of any scene: the unit
 * suite calls this on the file parsed off disk.
 *
 * Every piece wears ONE unlit vertex-colour material: the tubes are lamps, and
 * the rest carries 2016's room light baked in (see above).
 */
export const assembleLaunchArt = (
  loadedRoom: THREE.Object3D,
  sheet: LaunchRoomSheet = LAUNCH_ROOM_SHEET,
  light: RoomLight = roomLightSampler(),
): LaunchArtMeshes => {
  const fromRoom = launchFromRoom(sheet)
  if (!Number.isFinite(sheet.deckLift)) refuse('PROPS.launchRoom.deckLift is missing')
  const roomRoot = loadedRoom.getObjectByName('hangar-room') ?? refuse('no hangar-room node')
  const facts = roomFactsOf(roomRoot)
  // Both faces, since DEV-460. The shaft is CUT twice — at the rim (DEV-443)
  // and down the lift's column (`render/lift-seal.ts`) — and a cut solid is an
  // open shell: one-sided, the inside of a catwalk shows the wall behind it
  // through the cut (3.7 % of the sightlines across a catwalk band, measured).
  // Drawn both sides it reads as the solid it is. One material still, so still
  // one program; the room's own back faces are all behind its front ones.
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
  const none = new THREE.Matrix4()

  const shell = { positions: [] as number[], colors: [] as number[] }
  appendLit(shell, meshNamed(loadedRoom, 'room').geometry, none, fromRoom, light)
  appendLit(shell, meshNamed(loadedRoom, 'roomLower').geometry, none, fromRoom, light)
  const room = new THREE.Mesh(unindexedOf(shell), material)
  room.name = 'launch-room-2016'

  // A lamp: its own light, in 2016's colours (ART_DIRECTION, "what may glow").
  const tubes = { positions: [] as number[], colors: [] as number[], indices: [] as number[] }
  appendTo(tubes, meshNamed(loadedRoom, 'lamps').geometry, fromRoom)
  const lamps = new THREE.Mesh(geometryOf(tubes), material)
  lamps.name = 'launch-room-2016-lamps'

  // The segment's lifts are in the ROOM frame, at the menu's scale — so each
  // goes in BEFORE `fromRoom`, which stretches 8.8 m back to 2016's 12. Lit
  // where it stands in the menu, so the spot over the lift falls off up it.
  const segments = { positions: [] as number[], colors: [] as number[] }
  const segment = meshNamed(loadedRoom, 'shaft').geometry
  for (const lift of facts.shaftRepeats) {
    const up = new THREE.Matrix4().makeTranslation(0, lift, 0)
    appendLit(segments, segment, up, fromRoom, light)
  }
  const shaftGeometry = unindexedOf(segments)
  shaftGeometry.computeBoundingBox()
  const shaft = new THREE.Mesh(shaftGeometry, material)
  shaft.name = 'elevator-shaft-2016'

  // 2016's own deck, where the MISSION rig stands it. The same `Projector04`
  // in both rigs, but the menu's sits lower under its animator, and the GLB
  // carries the menu's — so `fromRoom` lands it low by `deckLift`, which the
  // sheet reads as the difference of the two prefabs' own numbers. Lit where
  // the menu stands it, under the spot.
  const deckArrays = { positions: [] as number[], colors: [] as number[] }
  appendLit(
    deckArrays,
    meshNamed(loadedRoom, 'platform').geometry,
    none,
    new THREE.Matrix4().makeTranslation(0, sheet.deckLift, 0).multiply(fromRoom),
    light,
  )
  const deck = new THREE.Mesh(unindexedOf(deckArrays), material)
  deck.name = 'elevator-deck-2016'

  return {
    room,
    lamps,
    shaft,
    deck,
    shaftTopY: (shaftGeometry.boundingBox as THREE.Box3).max.y,
  }
}

/**
 * The generated launch room's pieces 2016's stands in for, by `createHangar`'s
 * own names. Hidden, never removed; `launch-room-lamp` is not among them — its
 * COUNT is in every lit program's key, and the room still needs a light.
 */
export const LAUNCH_ROOM_REPLACES = [
  'hangar-shell',
  'hangar-floor',
  'hangar-strips',
  'hangar-dressing',
] as const

/** What `render/elevator.ts` does with 2016's shaft and deck. */
export interface LaunchLift {
  dress(art: { readonly shaft: THREE.Mesh; readonly deck: THREE.Mesh }): void
}

export interface LaunchArtOptions {
  /**
   * The launch room's group — `createHangar({ furnished: false })`, already on
   * `launch-anchor`. Spun about the anchor by the room's own turn, which is
   * read off its matrix rather than assumed.
   */
  readonly room: THREE.Object3D
  /** The lift: it takes the shaft and the deck, and hides its own. */
  readonly lift: LaunchLift
  /**
   * False once the mission's warm-up has run (a late landing would compile in
   * the ride) or the world has gone. A load that lands after that drops what
   * it brought, and the generated room and shaft stay.
   */
  readonly alive: () => boolean
  /** Fetch a GLB scene. Defaults to `loadMesh(assetUrl(path))`. */
  readonly load?: (path: string) => Promise<THREE.Object3D>
  /**
   * DEV-568: the hangar's curve, which the rig wears whatever the mission's
   * (`wearHangarLook`), and the curve the renderer is on now. Absent, the rig
   * is drawn under the renderer's curve, as it was before.
   */
  readonly look?:
    | {
        readonly hangar: ToneLook
        readonly live: () => ToneLook
      }
    | undefined
}

// ── The rig wears the HANGAR's curve (DEV-568) ──────────────────────────────
//
// Matt, 2026-10-02, on DEV-561's call that Classic's launch shaft should match
// the hangar's: *"yes plz."* After DEV-561 the two shafts carry the same
// colours, face for face, and differ in one thing: the curve they are drawn
// under. The hangar is a menu and always wears Anniversary's ACES (D35); the
// launch wore the mission's, and Classic's is none, a clamp. ACES at exposure
// 1 takes a dark slate of 0.05 to 0.03, so on Classic the same room read a
// lighter, flatter grey all the way up (`DEV-561-classic-*.png`).
//
// The rig is the hangar's own room at the bottom of the mission, so it wears
// the hangar's curve, drawn INTO its vertex colours (`toneColoursFor`): under
// a renderer on none, the colours carry ACES already and the clamp leaves
// them alone; under the hangar's own curve they are the bake as it stands.
// Nothing about the MATERIAL moves: it stays tone-mapped (`render/bloom.ts`
// re-layers a `toneMapped: false` mesh as UI), no define, no flag, no hook, so
// no program changes on either look and nothing compiles in the ride. Only
// the colour attribute is rewritten: at the stand, before the warm-up, and on
// a flip from the pause plate (`boot/app.ts`'s `liveLaunchLook`). Everything
// else in a Classic mission, the cockpit, the ship and the world over the rim,
// stays under Classic's curve.

/** One piece of the rig, and its colours as baked (linear, under 2016's room light). */
export interface LaunchLookPiece {
  readonly mesh: THREE.Mesh
  readonly base: Float32Array
}

/** Every mesh under `roots` wearing `material`, with its colours as they are now. */
export const launchLookPieces = (
  roots: readonly THREE.Object3D[],
  material: THREE.Material,
): LaunchLookPiece[] => {
  const seen = new Set<THREE.Mesh>()
  const out: LaunchLookPiece[] = []
  for (const root of roots) {
    root.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh || mesh.material !== material || seen.has(mesh)) return
      const colour = mesh.geometry.getAttribute('color')
      if (!colour) return
      seen.add(mesh)
      out.push({ mesh, base: Float32Array.from(colour.array as ArrayLike<number>) })
    })
  }
  return out
}

/**
 * Put the hangar's curve on the rig's colours for the renderer's curve now.
 * Writes in place and flags the upload; returns false where no colour can
 * (a lookdev curve that is neither), leaving the bake as it was.
 */
export const wearHangarLook = (
  pieces: readonly LaunchLookPiece[],
  hangar: ToneLook,
  live: ToneLook,
): boolean => {
  let exact = true
  for (const { mesh, base } of pieces) {
    // Never throw: this runs inside the edition's notify loop, which has no
    // guard, and a throw there would starve every later subscriber.
    const colour = mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined
    if (!colour || colour.array.length !== base.length) continue
    exact = toneColoursFor(base, hangar, live, colour.array as Float32Array) && exact
    colour.needsUpdate = true
  }
  return exact
}

/** What `createLaunchArt` hands back. */
export interface LaunchArt {
  /** True once 2016's rig stands; false if it never will. */
  readonly ready: Promise<boolean>
  /** DEV-568: re-read `look.live` and redraw the rig's colours for it. A no-op before the stand. */
  retone(): void
}

/**
 * Load 2016's launch rig and, when it lands, stand it in place of the generated
 * room and shaft. Resolves true once it stands, false if it never will.
 */
export const createLaunchArt = (opts: LaunchArtOptions): LaunchArt => {
  const load = opts.load ?? defaultLoad
  let pieces: LaunchLookPiece[] = []
  const retone = (): void => {
    if (!opts.look || pieces.length === 0) return
    if (!wearHangarLook(pieces, opts.look.hangar, opts.look.live())) {
      console.info(
        `launch: the hangar's curve cannot be drawn under ${opts.look.live().curve}; the rig takes the renderer's (DEV-568)`,
      )
    }
  }
  const ready = (async (): Promise<boolean> => {
    let loaded: THREE.Object3D
    try {
      loaded = await load(HANGAR_ROOM_MESH)
    } catch (error) {
      console.warn("hangar-art: 2016's launch rig did not load; the generated one stays —", error)
      return false
    }
    try {
      if (!opts.alive()) return false
      const generated = LAUNCH_ROOM_REPLACES.map(
        (name) => opts.room.getObjectByName(name) ?? refuse(`the launch room has no ${name}`),
      )
      const art = assembleLaunchArt(loaded)
      // The art is in the ANCHOR's frame; the room group is turned inside it.
      opts.room.updateMatrix()
      const intoRoom = opts.room.matrix.clone().invert()
      art.room.geometry.applyMatrix4(intoRoom)
      art.lamps.geometry.applyMatrix4(intoRoom)
      opts.room.add(art.room, art.lamps)
      for (const piece of generated) piece.visible = false
      opts.lift.dress({ shaft: art.shaft, deck: art.deck })
      // DEV-568: after the dress, which cuts the shaft and adds its caps, the
      // hatch and the lid, all on the rig's one material.
      if (opts.look) {
        pieces = launchLookPieces(
          [opts.room, art.shaft.parent ?? art.shaft, art.deck],
          art.shaft.material as THREE.Material,
        )
        retone()
      }
      return true
    } catch (error) {
      console.warn(
        "hangar-art: 2016's launch rig would not assemble; the generated one stays —",
        error,
      )
      return false
    } finally {
      disposeLoaded(loaded)
    }
  })()
  return { ready, retone }
}
