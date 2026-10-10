// src/render/door-marks.ts: the hangar's first step's own pictures. DEV-575.
//
// Matt, 2026-10-02, on 0.17.0: *"icons: 'quick race' - use the ring;
// multipayer - show 3 scaled down hoverjet's in a triangle formation to
// symbolize; TV - take a stab at a TV icon"*.
//
// QUICK RACE's ring is the flight plans' gate (`render/mode-mark.ts`), so it
// needs nothing here. The other two are new, and both are built so that a
// step opening compiles nothing a step did not already compile:
//
//   FORMATION  three HoverJets, each in one AI racer's livery off the menus'
//              preset, flying a vic: a leader and two wingmen behind it, half
//              a length back and most of a wingspan out. The hulls are the
//              instructor's (`instructorHull`, DEV-379): the aircraft table's
//              own mesh and MATERIALS, repainted per vertex, so the program is
//              the one SINGLE PLAYER's jet on the same step compiles. Stood
//              through `createInstructorMark`, the aircraft's own display case,
//              so it hovers, turns and is lit as the aircraft does; at the
//              same swept disc, three jets are each about a third the size of
//              SINGLE PLAYER's one: the "scaled down" Matt asked for.
//   TV         a set on a stand: a faceted cabinet, a screen that glows (a
//              screen is a thing light comes out of, ART_DIRECTION's first
//              exception), a neck, a six-sided foot, and two rabbit ears, which
//              are what make a screen on a stand read as a TELEVISION rather
//              than a monitor. Flat faces, one colour each, no texture. Both
//              its materials are `orbMaterial()`'s class with other colours,
//              and colours are uniforms: one program, the one 2016's orb on
//              this table (DEV-558) compiled, and the one the Free Flight plan
//              still compiles.
//
// Front is +z for the set (the screen looks along it) and the HoverJet hull's +x
// for the jets (`HOVERJET_HULL_FRONT`), and each mark says which, so the room can rest
// it facing the chair (DEV-574).

import * as THREE from 'three'
import { orbMaterial } from '@/game/orb-art'
import type { CreditLine } from './credits-menu'
import { createCreditsRoll } from './credits-roll'
import { HOVER_FRACTION, HOVERJET_HULL_FRONT, holoShipLamps } from './holo-ship'
import { createInstructorMark, type ModeMark, spinnerMark } from './mode-mark'

/**
 * Where the two wingmen fly off the leader, as fractions of ONE jet's own
 * span (x) and length (z): a vic, the leader ahead, nobody overlapping.
 * The leader sits 0.6 of a length ahead of the middle and the wingmen 0.6
 * behind it, so a fifth of a length of air runs between the leader's tail
 * and the wingmen's noses, and no wingspan can cut another hull whatever the
 * sideways spacing; 0.62 of a span out keeps the three close enough to read
 * as one formation. Taste, and Matt's to move.
 */
export const FORMATION_SPACING = { out: 0.62, back: 0.6 } as const

/**
 * MULTIPLAYER's picture as a HULL for `createInstructorMark`: one copy of each
 * of `hulls` (painted, at identity; borrowed, never mutated), the first
 * leading and the next two its wingmen, left and right. Geometry and materials
 * are shared with the hulls handed in; the room frees those.
 *
 * `front` is the hulls' own (`aircraftFront`): the spinner yaw that turns a
 * nose to +z, so the nose lies along `(-sin front, 0, cos front)` in the hull's
 * frame. The HoverJet's is its +x (`HOVERJET_HULL_FRONT`); the first draft
 * assumed -z and its photograph flew the vic sideways.
 */
export const formationHull = (
  hulls: readonly THREE.Object3D[],
  front: number = HOVERJET_HULL_FRONT,
): THREE.Group => {
  const group = new THREE.Group()
  group.name = 'formation'
  const first = hulls[0]
  if (!first) return group
  const nose = new THREE.Vector3(-Math.sin(front), 0, Math.cos(front))
  const beam = new THREE.Vector3(nose.z, 0, -nose.x)
  const size = new THREE.Box3().setFromObject(first).getSize(new THREE.Vector3())
  const length = Math.abs(size.x * nose.x) + Math.abs(size.z * nose.z)
  const span = Math.abs(size.x * beam.x) + Math.abs(size.z * beam.z)
  // AHEAD is along the nose: the leader there, the wingmen behind, either side.
  const slots: readonly (readonly [number, number])[] = [
    [0, FORMATION_SPACING.back * length],
    [-FORMATION_SPACING.out * span, -FORMATION_SPACING.back * length],
    [FORMATION_SPACING.out * span, -FORMATION_SPACING.back * length],
  ]
  for (const [i, [side, ahead]] of slots.entries()) {
    const hull = hulls[i % hulls.length] as THREE.Object3D
    const copy = hull.clone(true)
    copy.position.copy(nose).multiplyScalar(ahead).addScaledVector(beam, side)
    copy.rotation.set(0, 0, 0)
    copy.scale.set(1, 1, 1)
    group.add(copy)
  }
  group.updateMatrixWorld(true)
  return group
}

/** MULTIPLAYER's formation on a table: {@link formationHull} through the aircraft's display case. */
export const createFormationMark = (
  hulls: readonly THREE.Object3D[],
  sweep: number,
  tall: number,
  front: number = HOVERJET_HULL_FRONT,
): ModeMark => createInstructorMark(formationHull(hulls, front), sweep, tall, 'formation', front)

/* ══════════════════════════════════════════════ the TV (FF-TV's table) ═══ */

/** The set's cabinet: a dark slate, the plinth's own ink (`render/hangar.ts`). */
const TV_BODY = 0x2a313c
/** The screen: the room's cyan, glowing. */
const TV_SCREEN = 0x8ad8e0
/** How much the screen glows, in `orbMaterial`'s emissive units. */
const TV_SCREEN_GLOW = 0.9

/** One part, placed: a geometry moved by `matrix`, flattened to bare positions. */
const placed = (geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): Float32Array => {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry
  flat.applyMatrix4(matrix)
  const out = new Float32Array(flat.getAttribute('position').array)
  if (flat !== geometry) flat.dispose()
  geometry.dispose()
  return out
}

/** Concatenate parts into one flat-faced geometry (normals per face, no UVs). */
const merged = (parts: readonly Float32Array[]): THREE.BufferGeometry => {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const positions = new Float32Array(total)
  let at = 0
  for (const p of parts) {
    positions.set(p, at)
    at += p.length
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

const at = (x: number, y: number, z: number, rz = 0): THREE.Matrix4 =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, rz)),
    new THREE.Vector3(1, 1, 1),
  )

/**
 * The set's two geometries, in its own units (the cabinet is 1.6 wide), the
 * foot on y = 0, the screen looking along +z. `body` is everything but the
 * glass; `screen` is the glass.
 */
export const tvGeometry = (): { body: THREE.BufferGeometry; screen: THREE.BufferGeometry } => {
  const cabinet = { w: 1.6, h: 1.0, d: 0.16, y: 0.3 }
  const top = cabinet.y + cabinet.h
  const foot = new THREE.CylinderGeometry(0.34, 0.44, 0.06, 6)
  foot.scale(1, 1, 0.55)
  const ear = (side: -1 | 1) =>
    placed(
      new THREE.BoxGeometry(0.035, 0.62, 0.035),
      at(side * 0.14, top + 0.27, -0.02, (-side * 28 * Math.PI) / 180),
    )
  const body = merged([
    placed(
      new THREE.BoxGeometry(cabinet.w, cabinet.h, cabinet.d),
      at(0, cabinet.y + cabinet.h / 2, 0),
    ),
    placed(new THREE.BoxGeometry(0.16, 0.26, 0.1), at(0, 0.17, 0)),
    placed(foot, at(0, 0.03, 0)),
    // The ears' hub, a small faceted knuckle on the cabinet's top.
    placed(new THREE.OctahedronGeometry(0.07), at(0, top + 0.02, -0.02)),
    ear(-1),
    ear(1),
  ])
  const screen = merged([
    placed(
      new THREE.BoxGeometry(cabinet.w - 0.2, cabinet.h - 0.2, 0.02),
      at(0, cabinet.y + cabinet.h / 2, cabinet.d / 2 + 0.006),
    ),
  ])
  return { body, screen }
}

/** The set's two materials: `orbMaterial()`'s class, so one program, the orb's. */
export const tvMaterials = (): {
  body: THREE.MeshStandardMaterial
  screen: THREE.MeshStandardMaterial
} => {
  const body = orbMaterial()
  body.color.setHex(TV_BODY)
  body.emissive.setHex(0x000000)
  const screen = orbMaterial()
  screen.color.setHex(0x0b1820)
  screen.emissive.setHex(TV_SCREEN)
  screen.emissiveIntensity = TV_SCREEN_GLOW
  return { body, screen }
}

/**
 * FF-TV's set on a table, sized by the flight-plan marks' one rule (the largest
 * whose swept disc fits `sweep` across and whose height fits `tall`), hovering
 * and lit as they are. It owns its geometry and materials and frees both.
 */
export const createTvMark = (sweep: number, tall: number): ModeMark =>
  createGlyphMark('tv', 'mode-mark-tv', tvGeometry(), tvMaterials(), sweep, tall)

/* ═══════════════════════════════════════ the scroll (CREDITS' table) ═══ */

/**
 * DEV-620: CREDITS' picture, a scroll hung open. Matt, 2026-10-03: *"add a
 * credits table in the hangar"*; the brief asked for a picture in the doors'
 * style, *"the logo, or a scroll"*. A scroll, because the emblem already
 * stands over the doors (DEV-573) and a second, smaller one under it would
 * read as a repeat. Two six-sided rollers, a sheet between them, and four
 * lines of writing that glow in the room's cyan, as the TV's screen does: the
 * same two materials of `orbMaterial()`'s class in other colours, so the same
 * one program, the orb's, and nothing compiled that the doors did not.
 * Built like the set: the foot on y = 0, the sheet looking along +z.
 */
export const scrollGeometry = (): { body: THREE.BufferGeometry; screen: THREE.BufferGeometry } => {
  const sheet = { w: 1.1, h: 1.2, d: 0.03, y: 0.3 }
  const roller = (y: number) => {
    const c = new THREE.CylinderGeometry(0.075, 0.075, sheet.w + 0.3, 6)
    c.rotateZ(Math.PI / 2)
    return placed(c, at(0, y, 0))
  }
  const top = sheet.y + sheet.h
  const body = merged([
    placed(new THREE.BoxGeometry(sheet.w, sheet.h, sheet.d), at(0, sheet.y + sheet.h / 2, 0)),
    roller(sheet.y),
    roller(top),
  ])
  const lines = [0.78, 0.62, 0.46, 0.3].map((f, i) =>
    placed(
      new THREE.BoxGeometry(sheet.w * (i === 3 ? 0.45 : 0.72), 0.045, 0.012),
      at(i === 3 ? -sheet.w * 0.13 : 0, sheet.y + sheet.h * f, sheet.d / 2 + 0.008),
    ),
  )
  return { body, screen: merged(lines) }
}

/** The scroll's two materials: the set's class, the sheet a pale slate, the lines its glow. */
export const scrollMaterials = (): {
  body: THREE.MeshStandardMaterial
  screen: THREE.MeshStandardMaterial
} => {
  const m = tvMaterials()
  m.body.color.setHex(0x9fb4c4)
  return m
}

/** CREDITS' scroll on a table, as FF-TV's set is stood (`createGlyphMark`). */
export const createScrollMark = (sweep: number, tall: number): ModeMark =>
  createGlyphMark('scroll', 'mode-mark-scroll', scrollGeometry(), scrollMaterials(), sweep, tall)

/* ═══════════════════════════════════════ the sliders (OPTIONS' table) ═══ */

/**
 * DEV-832: OPTIONS' picture, a small panel of three sliders: a slate plate, a
 * glowing groove each, and a knob on each at its own height of travel. The
 * scroll's two materials and the same glyph mark, so the same program and
 * nothing compiled that the doors did not. Built like the set: the foot on
 * y = 0, the panel looking along +z.
 */
export const optionsGeometry = (): { body: THREE.BufferGeometry; screen: THREE.BufferGeometry } => {
  const panel = { w: 1.1, h: 1.0, d: 0.06, y: 0.2 }
  const rows = [0.75, 0.5, 0.25]
  const knobAt = [-0.25, 0.2, -0.05]
  const body = merged([
    placed(new THREE.BoxGeometry(panel.w, panel.h, panel.d), at(0, panel.y + panel.h / 2, 0)),
    ...rows.map((f, i) =>
      placed(
        new THREE.BoxGeometry(0.1, 0.15, 0.05),
        at((knobAt[i] as number) * panel.w, panel.y + panel.h * f, panel.d / 2 + 0.03),
      ),
    ),
  ])
  const grooves = rows.map((f) =>
    placed(
      new THREE.BoxGeometry(panel.w * 0.8, 0.04, 0.012),
      at(0, panel.y + panel.h * f, panel.d / 2 + 0.008),
    ),
  )
  return { body, screen: merged(grooves) }
}

/** OPTIONS' sliders on a table, as the scroll is stood (`createGlyphMark`). */
export const createOptionsMark = (sweep: number, tall: number): ModeMark =>
  createGlyphMark('options', 'mode-mark-options', optionsGeometry(), scrollMaterials(), sweep, tall)

/* ═══════════════════════════════════════ the map (the COURSE EDITOR's table) ═══ */

/**
 * DEV-879: the editor's picture: a slate map with a route of four waypoints
 * stood on it and a pencil laid across a corner. The scroll's two materials and
 * the same glyph mark, so the same program and nothing compiled that the doors
 * did not. Built like the set: the foot on y = 0, the map looking along +z.
 */
export const editorGeometry = (): { body: THREE.BufferGeometry; screen: THREE.BufferGeometry } => {
  const map = { w: 1.1, h: 1.0, d: 0.05, y: 0.2 }
  const way: [number, number][] = [
    [-0.34, 0.25],
    [-0.1, 0.55],
    [0.15, 0.4],
    [0.38, 0.72],
  ]
  const pencil = new THREE.BoxGeometry(0.62, 0.07, 0.07)
  pencil.rotateZ(Math.PI / 4)
  const body = merged([
    placed(new THREE.BoxGeometry(map.w, map.h, map.d), at(0, map.y + map.h / 2, 0)),
    placed(pencil, at(0.3, map.y + 0.3, map.d / 2 + 0.06)),
  ])
  const dots = way.map(([x, f]) =>
    placed(
      new THREE.BoxGeometry(0.11, 0.11, 0.014),
      at(x * map.w, map.y + map.h * f, map.d / 2 + 0.008),
    ),
  )
  const legs = way.slice(1).map(([x, f], i) => {
    const [px, pf] = way[i] as [number, number]
    const dx = (x - px) * map.w
    const dy = (f - pf) * map.h
    const g = new THREE.BoxGeometry(Math.hypot(dx, dy), 0.035, 0.012)
    g.rotateZ(Math.atan2(dy, dx))
    return placed(g, at(((x + px) / 2) * map.w, map.y + map.h * ((f + pf) / 2), map.d / 2 + 0.008))
  })
  return { body, screen: merged([...dots, ...legs]) }
}

/** The editor's map on a table, as the scroll is stood (`createGlyphMark`). */
export const createEditorMark = (sweep: number, tall: number): ModeMark =>
  createGlyphMark('editor', 'mode-mark-editor', editorGeometry(), scrollMaterials(), sweep, tall)

/* ═══════════════════════════════════ the roll (the CREDITS step's table) ═══ */

/**
 * DEV-623: the credits ROLL on the CREDITS step's one table. Matt,
 * 2026-10-04: *"show this same panel in the hangar on a centered table,
 * instead of a table per credit like now"*. The sheet is the pause plate's
 * (`render/credits-roll.ts`, the text `creditsRoll`), standing upright over
 * the table's label, facing the seat and not turning: words that spin cannot
 * be read. It rolls whether or not the table is aimed.
 *
 * `lift` is how far above the model plane its bottom edge stands, so it
 * clears the table's own label.
 */
export const createRollMark = (
  lines: readonly CreditLine[],
  width: number,
  height: number,
  lift: number,
): ModeMark => {
  const object = new THREE.Group()
  object.name = 'mode-mark'
  object.userData.kind = 'roll'
  const spinner = new THREE.Group()
  spinner.name = 'mode-mark-spinner'
  object.add(spinner)
  // The 2016 label backing's ink (`hangar.ts`), lighter: the room shows through.
  const roll = createCreditsRoll({ lines, width, height, backing: 'rgba(4, 8, 14, 0.6)' })
  roll.object.position.y = lift + height / 2
  // Over the room's glass and haze, as the pause plate is over the cockpit.
  roll.object.renderOrder = 12
  roll.object.frustumCulled = false
  spinner.add(roll.object)
  return {
    object,
    kind: 'roll',
    lamps: holoShipLamps(width, lift),
    reach: width / 2,
    height,
    bottom: lift,
    front: 0,
    rest(yaw: number) {
      spinner.rotation.y = yaw
    },
    update(seconds: number) {
      roll.update(seconds, false)
    },
    dispose() {
      spinner.remove(roll.object)
      roll.dispose()
    },
  }
}

/**
 * A two-material picture on a table (the set, the scroll), sized by the
 * flight-plan marks' one rule, hovering, turning and lit as they are.
 */
const createGlyphMark = (
  kind: 'tv' | 'scroll' | 'options' | 'editor',
  name: string,
  geometry: { body: THREE.BufferGeometry; screen: THREE.BufferGeometry },
  materials: { body: THREE.MeshStandardMaterial; screen: THREE.MeshStandardMaterial },
  sweep: number,
  tall: number,
): ModeMark => {
  const object = new THREE.Group()
  object.name = 'mode-mark'
  object.userData.kind = kind
  const spinner = new THREE.Group()
  spinner.name = 'mode-mark-spinner'
  object.add(spinner)

  const box = new THREE.Box3()
    .setFromBufferAttribute(geometry.body.getAttribute('position') as THREE.BufferAttribute)
    .union(
      new THREE.Box3().setFromBufferAttribute(
        geometry.screen.getAttribute('position') as THREE.BufferAttribute,
      ),
    )
  let swept = 0
  for (const g of [geometry.body, geometry.screen]) {
    const p = g.getAttribute('position')
    for (let i = 0; i < p.count; i++) swept = Math.max(swept, Math.hypot(p.getX(i), p.getZ(i)))
  }
  const rawHeight = box.max.y - box.min.y
  const scale = Math.min(sweep / Math.max(2 * swept, 1e-9), tall / Math.max(rawHeight, 1e-9))
  const reach = swept * scale
  const height = rawHeight * scale
  const bottom = 2 * reach * HOVER_FRACTION

  const body = new THREE.Mesh(geometry.body, materials.body)
  body.name = name
  const screen = new THREE.Mesh(geometry.screen, materials.screen)
  screen.name = `${name}-screen`
  // DEV-578: drawn whether or not it is in view, as the room's reflective
  // primer is (`render/hangar.ts`). The orb's program is compiled on the first
  // frame something of its class is DRAWN, and three skips a mesh outside the
  // frustum. FF-TV is the first step's outermost table (+46 degrees), so in a
  // frame narrower than a flat 1280's (a 1200 square at the room's 70 degrees,
  // measured) it is culled at rest and the program compiled on the first head
  // turn toward it: 48 programs at rest, 49 after the sweep. Unculled, it
  // compiles with the room's first frame, with the room's others, on every
  // frame size. Two small draws while the doors stand.
  for (const mesh of [body, screen]) {
    mesh.scale.setScalar(scale)
    mesh.position.set(0, bottom - box.min.y * scale, 0)
    mesh.frustumCulled = false
    spinner.add(mesh)
  }

  return spinnerMark({
    object,
    kind,
    spinner,
    reach,
    height,
    bottom,
    dispose() {
      for (const mesh of [body, screen]) {
        spinner.remove(mesh)
        mesh.geometry.dispose()
        ;(mesh.material as THREE.Material).dispose()
      }
    },
  })
}
