// tests/unit/hangar-tables.test.ts: the holotables' highlight and their
// pictures' turn (DEV-574), and the first step's new pictures (DEV-575).
//
// Matt, 2026-10-02, on 0.17.0: *"menu iconography - right now theres an
// octogon - make it a square instead (so it matches the table) - only show the
// 'highlight square' when a table is selected"*, and *"hangar: only rotate the
// models when we they're being 'hovered over'"*.
//
// Geometry, not rotation (the orientation lesson): the square is measured as
// laid, against the seat's direction, and against 2016's table GLB where it is
// hydrated; the rest pose is measured by where a stand-in's nose ends up.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SHIP_MODEL_YAW } from '@/game/flight'
import type { MissionCard } from '@/game/mission-index'
import { orbMaterial } from '@/game/orb-art'
import { ringFrameMaterial } from '@/game/rings'
import {
  createFormationMark,
  createScrollMark,
  createTvMark,
  FORMATION_SPACING,
  formationHull,
  scrollGeometry,
  scrollMaterials,
  tvMaterials,
} from '@/render/door-marks'
import {
  createHangar,
  DOORS_BEARING_STEP,
  type HangarArt,
  PICTURE_REST_TURN,
  PLATE_FILL_INNER,
  PLATE_FILL_OUTER,
  PLATE_HALF,
  plateSquareRadius,
  restYawFor,
  SEAT_REST_BEARING,
  seatEyeLocal,
  seatPitchLocal,
  seatYawLocal,
  stepBearings,
  TABLE_ART_HEIGHT,
  TABLE_ART_SCALE,
  TABLE_BEARING_STEP,
  TABLE_FRAME_RAW,
  TABLE_GLOW_BANDS,
  TABLE_GLOW_NAME,
  TABLE_HIGHLIGHT_NAME,
  TABLE_HIGHLIGHT_Y,
  TABLE_INSET_CENTRE,
  TABLE_INSET_RAW,
  TABLE_RIM_NAME,
  TABLE_SQUARE_BAR,
  TABLE_SQUARE_HALF,
  tableGazeLocal,
  tableGlowMaterial,
  tableLocal,
} from '@/render/hangar'
import { HANGAR_TABLE_MESH, pedestalYaw, tableFactsOf } from '@/render/hangar-art'
import { type DoorInput, type DoorStep, doorStepCards } from '@/render/hangar-doors'
import {
  aircraftFront,
  HOLO_SHIP_FRONT,
  HOVERJET_HULL_FRONT,
  SPIN_DEG_PER_SECOND,
} from '@/render/holo-ship'
import { instructorHull } from '@/render/mode-mark'
import { hexSrgb, LIVERY_PANEL_SRGB, type Srgb } from '@/render/racer-livery'
import {
  SETTLE_MAX_DEG_PER_SECOND,
  SETTLE_SECONDS,
  turntableYaw,
  wrapAngle,
} from '@/render/turntable'
import { srgbToLinear } from '@/render/unity-space'
import { hangarSpecFor } from '@/sim/hangar'

const SPEC = hangarSpecFor()
const DEG = Math.PI / 180
const SPIN = SPIN_DEG_PER_SECOND * DEG

/* ─────────────────────────────────────────────── the turntable rule ──── */

describe('DEV-574: a picture turns only while selected, and rests otherwise', () => {
  it('turns at its rate while spinning, whatever its rest', () => {
    expect(turntableYaw(0.3, 1, 2, true, SPIN)).toBeCloseTo(0.3 + 2 * SPIN, 12)
    expect(turntableYaw(0.3, null, 2, true, SPIN)).toBeCloseTo(0.3 + 2 * SPIN, 12)
  })

  it('holds still where nobody placed a rest', () => {
    expect(turntableYaw(0.3, null, 5, false, SPIN)).toBe(0.3)
  })

  it('goes back to rest the SHORT way, eased, and never faster than its cap', () => {
    // From 170 degrees past rest, the short way is back through 170, not on through 190.
    let yaw = 170 * DEG
    let worst = 0
    let previous = yaw
    for (let t = 0; t < 4; t += 1 / 90) {
      yaw = turntableYaw(yaw, 0, 1 / 90, false, SPIN)
      worst = Math.max(worst, Math.abs(yaw - previous) * 90)
      expect(yaw, 'never overshoots past rest').toBeGreaterThanOrEqual(-1e-9)
      previous = yaw
    }
    expect(Math.abs(wrapAngle(yaw))).toBeLessThan(1e-6)
    expect(worst).toBeLessThanOrEqual(SETTLE_MAX_DEG_PER_SECOND * DEG + 1e-9)
    // And from a full turn and a bit past rest, it takes the bit, not the turn.
    const near = turntableYaw(2 * Math.PI + 0.2, 0, 1 / 90, false, SPIN)
    expect(near).toBeLessThan(2 * Math.PI + 0.2)
    expect(near).toBeGreaterThan(2 * Math.PI)
  })

  it('is mostly there within three time constants of a small gap', () => {
    const yaw = turntableYaw(10 * DEG, 0, 3 * SETTLE_SECONDS, false, SPIN)
    expect(yaw).toBeLessThan(10 * DEG * 0.06)
  })
})

/* ──────────────────────────────────────────── the room, built for real ──── */

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

const GREY: Srgb = [0.35, 0.33, 0.31]

/**
 * A jet with a NOSE, laid as the HoverJet's GLB is: fore and aft along x
 * (6.82 m), the beam along z (6.17 m), and the nose out of its +x face (the
 * flight's `SHIP_MODEL_YAW` turns that to -z), vertex-coloured so a livery
 * paints it.
 */
const standInJet = (): THREE.Object3D => {
  const root = new THREE.Group()
  const body = new THREE.BoxGeometry(6.82, 2.01, 6.17)
  const nose = new THREE.ConeGeometry(0.5, 3, 4)
  nose.rotateZ(-Math.PI / 2)
  nose.translate(6.82 / 2 + 1.5, 0, 0)
  for (const g of [body, nose]) {
    const colours: number[] = []
    for (let i = 0; i < g.getAttribute('position').count; i++) {
      const c = i % 2 === 0 ? LIVERY_PANEL_SRGB : GREY
      colours.push(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]))
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3))
  }
  const material = new THREE.MeshStandardMaterial({ vertexColors: true })
  const bodyMesh = new THREE.Mesh(body, material)
  const noseMesh = new THREE.Mesh(nose, material)
  noseMesh.name = 'nose'
  root.add(bodyMesh, noseMesh)
  return root
}

/** A stand-in gate GLB root: one frame mesh, wide in x. */
const standInGate = (): THREE.Object3D => {
  const root = new THREE.Group()
  root.add(new THREE.Mesh(new THREE.TorusGeometry(1, 0.2, 3, 6), new THREE.MeshBasicMaterial()))
  return root
}

const card = (id: string, vehicle: string, environment: string): MissionCard =>
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

const LIVERIES = ['#ff1f4b', '#22aaff', '#ffd23f']
const INPUT: DoorInput = {
  rooms: true,
  tv: true,
  firstVisit: false,
  linkRoom: null,
  roomNotice: null,
  racerLiveries: LIVERIES,
}

const build = (): HangarArt => {
  const room = createHangar({
    spec: SPEC,
    seed: 0x48414e47,
    title: '',
    subtitle: '',
    level: null,
    missions: [card('hj_a', 'hoverjet', 'simonet'), card('js_a', 'jumpseat', 'alpine')],
    currentId: 'hj_a',
    shapeFor: () => new Promise(() => {}),
    doors: (step: DoorStep) => doorStepCards(step, INPUT),
    onDoor: () => {},
  })
  const jet = standInJet()
  room.ships({ hoverjet: jet, jumpseat: jet })
  room.gates(standInGate())
  return room
}

/** A head looking at `bearing` (radians) at table height, from the seat. */
const lookAt = (room: HangarArt, bearing: number): boolean => {
  room.object.updateWorldMatrix(true, true)
  const local = seatEyeLocal(SPEC)
  const from = new THREE.Vector3(local.x, local.y, local.z).applyMatrix4(room.object.matrixWorld)
  const c = tableGazeLocal(SPEC, bearing)
  const to = new THREE.Vector3(c.x, c.y, c.z).applyMatrix4(room.object.matrixWorld)
  return room.gaze(from, to.sub(from))
}

/** The drawn tables, each with its bearing (off its position) and its pieces. */
const tablesOf = (room: HangarArt) => {
  const seat = seatEyeLocal(SPEC)
  return room.object.children
    .filter((c) => c.name === 'hangar-holotable' && c.visible)
    .map((group) => {
      const bearing = Math.atan2(group.position.x - seat.x, seat.z - group.position.z)
      const highlight = group.getObjectByName(TABLE_HIGHLIGHT_NAME) as THREE.Object3D
      let spinner: THREE.Object3D | null = null
      group.traverse((o) => {
        if (!spinner && /spinner/.test(o.name)) spinner = o
      })
      return { group, bearing, highlight, spinner: spinner as THREE.Object3D | null }
    })
}

/**
 * A mesh's drawn extents in its TABLE's frame, along the line to the seat and
 * across it, about the extents' own middle: half the depth, half the width, the
 * middle, and the lowest and highest y.
 */
const extentsOnTable = (mesh: THREE.Mesh, table: THREE.Object3D, bearing: number) => {
  // The whole room: a sibling of `table` (the highlight beside a pedestal) moves too.
  let top: THREE.Object3D = table
  while (top.parent) top = top.parent
  top.updateWorldMatrix(false, true)
  const toSeat = new THREE.Vector3(-Math.sin(bearing), 0, Math.cos(bearing))
  const across = new THREE.Vector3(Math.cos(bearing), 0, Math.sin(bearing))
  const p = mesh.geometry.getAttribute('position')
  const v = new THREE.Vector3()
  const box = new THREE.Box3()
  const d = [Infinity, -Infinity]
  const w = [Infinity, -Infinity]
  for (let i = 0; i < p.count; i++) {
    table.worldToLocal(v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld))
    box.expandByPoint(v)
    const a = v.dot(toSeat)
    const b = v.dot(across)
    d[0] = Math.min(d[0] as number, a)
    d[1] = Math.max(d[1] as number, a)
    w[0] = Math.min(w[0] as number, b)
    w[1] = Math.max(w[1] as number, b)
  }
  const [d0, d1] = d as [number, number]
  const [w0, w1] = w as [number, number]
  return {
    deep: (d1 - d0) / 2,
    wide: (w1 - w0) / 2,
    middle: box.getCenter(new THREE.Vector3()).setY(0),
    low: box.min.y,
    high: box.max.y,
  }
}

describe('DEV-574: the highlight square, on the inset, glowing', () => {
  it('lies square to the seat on every table, the inset’s size, on its centre, at the frame’s lip', () => {
    const room = build()
    for (const t of tablesOf(room)) {
      lookAt(room, t.bearing)
      expect(t.highlight.visible).toBe(true)
      const rim = t.highlight.getObjectByName(TABLE_RIM_NAME) as THREE.Mesh
      const e = extentsOnTable(rim, t.group, t.bearing)
      // A diamond would reach the half side times root two along the seat line.
      expect(e.deep, `deep at ${t.bearing}`).toBeCloseTo(e.wide, 6)
      expect(e.deep).toBeGreaterThanOrEqual(TABLE_SQUARE_HALF)
      expect(e.deep).toBeLessThanOrEqual(TABLE_SQUARE_HALF + TABLE_SQUARE_BAR)
      // On the inset's centre, off the axis by its own offset.
      expect(e.middle.length()).toBeCloseTo(TABLE_INSET_CENTRE, 6)
      // Flat, at the frame's lip.
      expect(e.high - e.low).toBeLessThanOrEqual(2 * TABLE_SQUARE_BAR + 1e-9)
      expect((e.high + e.low) / 2).toBeCloseTo(TABLE_HIGHLIGHT_Y, 6)
    }
  })

  it('follows 2016’s pedestal: turned as it is, centred on its inset', () => {
    const room = build()
    const t = tablesOf(room)[2] as ReturnType<typeof tablesOf>[number]
    const pedestal = new THREE.Object3D()
    pedestal.name = 'holotable-pedestal'
    // An odd turn on purpose: the square must follow the pedestal, not the seat.
    pedestal.rotation.y = 0.4
    t.group.add(pedestal)
    lookAt(room, t.bearing)
    const rim = t.highlight.getObjectByName(TABLE_RIM_NAME) as THREE.Mesh
    // In the pedestal's frame: axis-aligned, centred on (0, 0, centre).
    const e = extentsOnTable(rim, pedestal, 0)
    const local = new THREE.Box3()
    const p = rim.geometry.getAttribute('position')
    const v = new THREE.Vector3()
    for (let i = 0; i < p.count; i++)
      local.expandByPoint(
        pedestal.worldToLocal(v.fromBufferAttribute(p, i).applyMatrix4(rim.matrixWorld)),
      )
    const centre = local.getCenter(new THREE.Vector3())
    expect(centre.x).toBeCloseTo(0, 6)
    expect(centre.z).toBeCloseTo(TABLE_INSET_CENTRE, 6)
    expect(e.deep).toBeCloseTo(e.wide, 6)
  })

  it('glows: three bands either side of the line, shown and hidden with it, widest 2.6 cm out', () => {
    const room = build()
    const t = tablesOf(room)[1] as ReturnType<typeof tablesOf>[number]
    const bands = t.highlight.children.filter((c) => c.name === TABLE_GLOW_NAME) as THREE.Mesh[]
    expect(bands).toHaveLength(TABLE_GLOW_BANDS.length)
    expect(t.highlight.visible).toBe(false)
    lookAt(room, t.bearing)
    expect(t.highlight.visible).toBe(true)
    const widest = Math.max(...TABLE_GLOW_BANDS.map((b) => b.reach))
    const outer = Math.max(...bands.map((b) => extentsOnTable(b, t.group, t.bearing).deep))
    expect(outer).toBeCloseTo(TABLE_SQUARE_HALF + widest, 6)
    // One set of materials for every table: nothing is built per table.
    const other = tablesOf(room)[0] as ReturnType<typeof tablesOf>[number]
    const otherBands = other.highlight.children.filter((c) => c.name === TABLE_GLOW_NAME)
    expect((otherBands[0] as THREE.Mesh).material).toBe((bands[0] as THREE.Mesh).material)
  })

  it('compiles no program of its own: every band is the gate’s material in every field a key reads', () => {
    const gate = ringFrameMaterial()
    const keyed = [
      'type',
      'flatShading',
      'transparent',
      'side',
      'vertexColors',
      'map',
      'emissiveMap',
      'normalMap',
      'alphaTest',
      'fog',
      'toneMapped',
      'premultipliedAlpha',
      'dithering',
      'alphaToCoverage',
    ] as const
    for (const b of TABLE_GLOW_BANDS) {
      const m = tableGlowMaterial(b.intensity)
      for (const k of keyed) expect(m[k], k).toEqual(gate[k])
      expect(m.defines).toEqual(gate.defines)
      expect(m.onBeforeCompile).toBe(gate.onBeforeCompile)
      // Additive, and the gate is transparent too, so both are "not opaque"
      // in three's key; blending and depth writes are state, not program.
      expect(gate.transparent).toBe(true)
      expect(m.blending).toBe(THREE.AdditiveBlending)
      expect(m.emissiveIntensity).toBe(b.intensity)
    }
  })

  it('shows on the selected table only, and on none when the pointer is between tables', () => {
    const room = build()
    expect(room.view).toBe('doors')
    const tables = tablesOf(room)
    // DEV-620: and CREDITS, the fifth, off the left end.
    expect(tables.length, 'the first step is five tables').toBe(5)
    for (const t of tables) expect(t.highlight.visible, 'nothing is lit before a look').toBe(false)
    for (const target of tables) {
      expect(lookAt(room, target.bearing)).toBe(true)
      for (const t of tables)
        expect(t.highlight.visible, `highlight at ${t.bearing}`).toBe(t === target)
    }
    // Half a step between two tables selects neither (the doors step is DEV-578's).
    lookAt(room, SEAT_REST_BEARING + DOORS_BEARING_STEP / 2)
    expect(room.aim).toBeNull()
    for (const t of tables) expect(t.highlight.visible).toBe(false)
  })
})

describe('DEV-574: the pictures rest, and only the selected one turns', () => {
  it('lays every picture at rest: its front to the seat, turned PICTURE_REST_TURN', () => {
    const room = build()
    room.update(0)
    for (const t of tablesOf(room)) {
      expect(t.spinner, `a picture on the table at ${t.bearing}`).not.toBeNull()
      const yaw = (t.spinner as THREE.Object3D).rotation.y
      // The gate and the set face +z at a yaw of 0; the jets and the formation -z.
      const fronts = [0, HOVERJET_HULL_FRONT]
      expect(
        fronts.some((f) => Math.abs(wrapAngle(yaw - restYawFor(t.bearing, f))) < 1e-9),
        `table at ${(t.bearing / DEG).toFixed(0)} rests at its rest yaw`,
      ).toBe(true)
    }
  })

  it('stands the aircraft nose toward the chair, turned 30 degrees: measured off the nose', () => {
    const room = build()
    // DEV-620: CREDITS is first, so SINGLE PLAYER is the third table.
    const single = tablesOf(room)[2]
    if (!single) throw new Error('no SINGLE PLAYER table')
    room.object.updateWorldMatrix(true, true)
    const nose = single.group.getObjectByName('nose') as THREE.Mesh
    const box = new THREE.Box3().setFromObject(nose)
    // In the ROOM's frame, where the seat and the bearings are: the room itself
    // is turned in the world (`HANGAR_SPIN`).
    const centre = room.object.worldToLocal(box.getCenter(new THREE.Vector3()))
    const out = centre.sub(single.group.position)
    const toSeat = new THREE.Vector3(-Math.sin(single.bearing), 0, Math.cos(single.bearing))
    const angle = Math.atan2(
      out.x * toSeat.z - out.z * toSeat.x,
      out.x * toSeat.x + out.z * toSeat.z,
    )
    expect(Math.abs(Math.abs(angle) - PICTURE_REST_TURN)).toBeLessThan(0.5 * DEG)
  })

  it('turns the selected picture at its rate; the others stay put; let go, it goes back', () => {
    const room = build()
    const tables = tablesOf(room)
    const yaws = () => tables.map((t) => (t.spinner as THREE.Object3D).rotation.y)
    const rest = yaws()
    const single = 1
    for (let i = 0; i < 90; i++) {
      lookAt(room, (tables[single] as (typeof tables)[number]).bearing)
      room.update(1 / 90)
    }
    const after = yaws()
    for (const [i, yaw] of after.entries()) {
      if (i === single) expect(yaw - (rest[i] as number)).toBeCloseTo(SPIN, 6)
      else expect(yaw, `table ${i} stays at rest`).toBe(rest[i])
    }
    // The pointer leaves (between two tables): it settles back, the short way.
    for (let i = 0; i < 270; i++) {
      lookAt(room, SEAT_REST_BEARING + DOORS_BEARING_STEP / 2)
      room.update(1 / 90)
    }
    for (const [i, yaw] of yaws().entries()) {
      expect(Math.abs(wrapAngle(yaw - (rest[i] as number))), `table ${i}`).toBeLessThan(1e-4)
    }
  })
})

/* ──────────────────────────────────────────── the first step's pictures ──── */

const meshesOf = (root: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = []
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh)
  })
  return out
}

describe('DEV-575: MULTIPLAYER stands three jets in a vic', () => {
  const hulls = () => LIVERIES.map((c) => instructorHull(standInJet(), hexSrgb(c)))

  it('faces the HoverJet hull the way the flight does: its nose is the GLB’s +x', () => {
    // `SHIP_MODEL_YAW` turns the hull's nose onto the body's -z in flight; a
    // half turn more puts it on +z, which is what `front` means.
    const quarter = wrapAngle(HOVERJET_HULL_FRONT - (SHIP_MODEL_YAW + Math.PI))
    expect(quarter).toBeCloseTo(0, 12)
    expect(aircraftFront('hoverjet')).toBe(HOVERJET_HULL_FRONT)
    expect(aircraftFront('glider'), 'the glider stands in the HoverJet’s hull').toBe(
      HOVERJET_HULL_FRONT,
    )
    expect(aircraftFront('jumpseat'), 'a three-space assembly, nose on -z').toBe(HOLO_SHIP_FRONT)
  })

  it('flies a leader ahead (along the nose) and two wingmen behind it, one each side, none overlapping', () => {
    const jets = hulls()
    const group = formationHull(jets)
    expect(group.children).toHaveLength(3)
    const boxes = group.children.map((c) => new THREE.Box3().setFromObject(c))
    const centres = boxes.map((b) => b.getCenter(new THREE.Vector3()))
    const [lead, left, right] = centres as [THREE.Vector3, THREE.Vector3, THREE.Vector3]
    // The HoverJet's nose is its +x: the leader furthest along it, the wingmen either side in z.
    expect(lead.x).toBeGreaterThan(left.x)
    expect(lead.x).toBeGreaterThan(right.x)
    expect(Math.sign(left.z - lead.z)).toBe(-Math.sign(right.z - lead.z))
    expect(Math.abs(left.z - lead.z)).toBeGreaterThan(1)
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++)
        expect(boxes[i]?.intersectsBox(boxes[j] as THREE.Box3), `${i} and ${j}`).toBe(false)
    expect(FORMATION_SPACING.back).toBeGreaterThan(0)
  })

  it('wears the hulls handed in: their materials, so their program, and a livery each', () => {
    const jets = hulls()
    const materials = new Set(jets.flatMap((j) => meshesOf(j).map((m) => m.material)))
    const mark = createFormationMark(jets, 0.52, 0.18)
    expect(mark.kind).toBe('formation')
    expect(mark.object.name).toBe('mode-mark')
    expect(mark.front).toBe(HOVERJET_HULL_FRONT)
    for (const m of meshesOf(mark.object)) expect(materials.has(m.material)).toBe(true)
    // Three scaled-down jets: each well under the size one stands at on SINGLE PLAYER.
    mark.object.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(mark.object)
    expect(box.max.y - box.min.y).toBeLessThanOrEqual(mark.bottom + mark.height + 1e-9)
    expect(mark.height).toBeLessThanOrEqual(0.18 + 1e-9)
  })
})

describe('DEV-620: CREDITS stands a scroll', () => {
  it('fits the mark cylinder and hovers, drawn out of view as the set is', () => {
    const mark = createScrollMark(0.52, 0.18)
    expect(mark.kind).toBe('scroll')
    expect(mark.height).toBeLessThanOrEqual(0.18 + 1e-9)
    expect(mark.reach * 2).toBeLessThanOrEqual(0.52 + 1e-9)
    expect(mark.bottom).toBeGreaterThan(0)
    const meshes = meshesOf(mark.object)
    expect(meshes.map((m) => m.name)).toEqual(['mode-mark-scroll', 'mode-mark-scroll-screen'])
    for (const m of meshes) expect(m.frustumCulled, m.name).toBe(false)
    mark.dispose()
  })

  it('is a sheet that faces +z, as the set does: wide and tall across, thin along its front', () => {
    // A picture that turns to the seat must have a front to turn. Measured on
    // the geometry, not on a rotation (the orientation lesson).
    const { body, screen } = scrollGeometry()
    const box = new THREE.Box3().setFromBufferAttribute(
      body.getAttribute('position') as THREE.BufferAttribute,
    )
    const size = box.getSize(new THREE.Vector3())
    expect(size.x).toBeGreaterThan(5 * size.z)
    expect(size.y).toBeGreaterThan(5 * size.z)
    // The writing lies on the sheet's +z face.
    const lines = new THREE.Box3().setFromBufferAttribute(
      screen.getAttribute('position') as THREE.BufferAttribute,
    )
    expect(lines.min.z).toBeGreaterThan(0)
  })

  it('compiles no program of its own: its materials are the set’s, the orb’s class', () => {
    const tv = tvMaterials()
    const scroll = scrollMaterials()
    for (const [a, b] of [
      [scroll.body, tv.body],
      [scroll.screen, tv.screen],
    ] as const) {
      expect(a.type).toBe(b.type)
      expect(a.defines).toEqual(b.defines)
      expect(a.flatShading).toBe(b.flatShading)
      expect(a.transparent).toBe(b.transparent)
      expect(a.side).toBe(b.side)
    }
  })
})

describe('DEV-575: FF-TV stands a set on a stand', () => {
  it('fits the mark cylinder and hovers, as every mark does', () => {
    const mark = createTvMark(0.52, 0.18)
    expect(mark.kind).toBe('tv')
    expect(mark.object.name).toBe('mode-mark')
    expect(mark.height).toBeLessThanOrEqual(0.18 + 1e-9)
    expect(mark.reach * 2).toBeLessThanOrEqual(0.52 + 1e-9)
    expect(mark.bottom).toBeGreaterThan(0)
    expect(meshesOf(mark.object).map((m) => m.name)).toEqual([
      'mode-mark-tv',
      'mode-mark-tv-screen',
    ])
    mark.dispose()
  })

  it('DEV-578: is drawn out of view too, so its program compiles with the room’s first frame', () => {
    // FF-TV stands at +46 degrees; a frame narrower than a flat 1280 culls it
    // at rest, and a culled mesh compiles nothing until it is first in view.
    const mark = createTvMark(0.52, 0.18)
    const meshes = meshesOf(mark.object)
    expect(meshes.length).toBe(2)
    for (const m of meshes) expect(m.frustumCulled, m.name).toBe(false)
    mark.dispose()
  })

  it('compiles no program of its own: both materials are the orb’s, in every field a key reads', () => {
    const orb = orbMaterial()
    const { body, screen } = tvMaterials()
    const keyed = [
      'type',
      'flatShading',
      'transparent',
      'side',
      'vertexColors',
      'map',
      'emissiveMap',
      'normalMap',
      'alphaTest',
      'fog',
      'toneMapped',
      'premultipliedAlpha',
      'dithering',
    ] as const
    for (const m of [body, screen]) {
      for (const k of keyed) expect(m[k], k).toEqual(orb[k])
      expect(m.defines).toEqual(orb.defines)
      expect(m.onBeforeCompile).toBe(orb.onBeforeCompile)
    }
    // And the screen glows; the cabinet does not.
    expect(screen.emissiveIntensity).toBeGreaterThan(0)
    expect(body.emissive.getHex()).toBe(0)
  })
})

/* ──────────────────────────────────── against 2016's table, if hydrated ──── */

const TABLE_FILE = `public/${HANGAR_TABLE_MESH}`
const HAVE_TABLE = fs.existsSync(TABLE_FILE)

const parse = async (file: string): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(file)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

describe.skipIf(!HAVE_TABLE)("DEV-574: the square traces 2016's table", () => {
  it('measures the inset off the mesh: its flat floor, its size, its centre, and the frame round it', async () => {
    const root = await parse(TABLE_FILE)
    const mesh = root.getObjectByName('table') as THREE.Mesh
    const g = mesh.geometry
    g.computeBoundingBox()
    const height = (g.boundingBox as THREE.Box3).max.y
    expect(height).toBeCloseTo(TABLE_ART_HEIGHT, 4)
    // Every upward-facing face in the table's top fifth, grouped by its height.
    const p = g.getAttribute('position')
    const index = g.index
    const tris = (index ? index.count : p.count) / 3
    const at = (t: number, k: number) => (index ? index.getX(3 * t + k) : 3 * t + k)
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    const levels = new Map<string, THREE.Box3>()
    for (let t = 0; t < tris; t++) {
      a.fromBufferAttribute(p, at(t, 0))
      b.fromBufferAttribute(p, at(t, 1))
      c.fromBufferAttribute(p, at(t, 2))
      if (Math.min(a.y, b.y, c.y) < height * 0.8) continue
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a))
      if (Math.abs(n.normalize().y) < 0.99) continue
      const key = ((a.y + b.y + c.y) / 3).toFixed(3)
      const box = levels.get(key) ?? new THREE.Box3()
      box.expandByPoint(a).expandByPoint(b).expandByPoint(c)
      levels.set(key, box)
    }
    // The inset is the LOWEST flat level up there: the recessed screen.
    const floor = Math.min(...[...levels.keys()].map(Number))
    expect(floor).toBeCloseTo(TABLE_INSET_RAW.floor, 3)
    const inset = levels.get(floor.toFixed(3)) as THREE.Box3
    const size = inset.getSize(new THREE.Vector3())
    const middle = inset.getCenter(new THREE.Vector3())
    expect(size.x / 2).toBeCloseTo(TABLE_INSET_RAW.half, 2)
    expect(size.z / 2).toBeCloseTo(TABLE_INSET_RAW.half, 2)
    expect(Math.abs(size.x - size.z), 'a square').toBeLessThan(0.005)
    expect(middle.x).toBeCloseTo(0, 2)
    expect(middle.z).toBeCloseTo(TABLE_INSET_RAW.centre, 2)
    // The frame round it: the next flat level up, wider than the inset.
    const frame = levels.get(TABLE_INSET_RAW.frame.toFixed(3)) as THREE.Box3
    expect(frame, 'a flat frame at the recorded height').toBeDefined()
    expect(frame.max.x).toBeGreaterThan(inset.max.x)
    // DEV-627: its outer sides, which bound the island (`TABLE_BOUND`).
    expect(Math.max(frame.max.x, -frame.min.x)).toBeCloseTo(TABLE_FRAME_RAW.half, 2)
    expect(frame.min.z).toBeCloseTo(TABLE_FRAME_RAW.zMin, 2)
    expect(frame.max.z).toBeCloseTo(TABLE_FRAME_RAW.zMax, 2)
    // And at the port's scale: the numbers the row quotes.
    expect(TABLE_SQUARE_HALF).toBeCloseTo(0.177, 3)
    expect(TABLE_INSET_CENTRE).toBeCloseTo(0.0157, 3)
    expect(TABLE_HIGHLIGHT_Y - TABLE_SQUARE_BAR).toBeCloseTo(0.423, 3)
  })

  it('lies as the pedestal does: one side to the seat, within a degree, at every bearing', async () => {
    const root = await parse(TABLE_FILE)
    const facts = tableFactsOf(root.getObjectByName('commander-table') as THREE.Object3D)
    for (const count of [1, 2, 3, 4]) {
      for (const bearing of stepBearings('doors', count)) {
        // The square's sides face the seat at a yaw of -bearing; the pedestal's
        // must too, to a quarter turn (a square is the same at each).
        const off = pedestalYaw(facts, bearing) + bearing
        const quarter = Math.PI / 2
        const rem = off - Math.round(off / quarter) * quarter
        expect(Math.abs(rem), `bearing ${bearing}`).toBeLessThan(1 * DEG)
      }
    }
  })
})

describe.skipIf(HAVE_TABLE)("DEV-574: the square traces 2016's table (not hydrated)", () => {
  it('says so, rather than passing silently', () => {
    expect(fs.existsSync(TABLE_FILE)).toBe(false)
  })
})

/* ───────────────── DEV-578: four doors, apart, and all in a flat frame ──── */
//
// Matt, 2026-10-03: *"FF-TV - move to production"*, so every build's first
// step is four tables, SINGLE PLAYER under the resting pointer (2026-10-02).
// Measured against 2016's table as the room hangs it: the footprint of every
// vertex, and every vertex through the resting camera.

/** The renderer's vertical field of view, read off `render/renderer.ts` (it is a literal there). */
const rendererFov = (): number => {
  const src = fs.readFileSync('src/render/renderer.ts', 'utf8')
  const m = /new THREE\.PerspectiveCamera\(\s*(\d+(?:\.\d+)?)/.exec(src)
  expect(m, 'the renderer builds its camera with a literal field of view').not.toBeNull()
  return Number((m as RegExpExecArray)[1])
}

/** 2016's table, hung at `bearing` as `hangar-art.ts` hangs it: its mesh's world matrix. */
const hungTable = (
  facts: ReturnType<typeof tableFactsOf>,
  mesh: THREE.Mesh,
  bearing: number,
): THREE.Matrix4 => {
  const at = tableLocal(SPEC, bearing)
  const group = new THREE.Group()
  group.position.set(at.x, at.y, at.z)
  const pedestal = new THREE.Object3D()
  pedestal.rotation.y = pedestalYaw(facts, bearing)
  pedestal.scale.setScalar(TABLE_ART_SCALE)
  group.add(pedestal)
  const m = new THREE.Object3D()
  m.position.copy(mesh.position)
  m.quaternion.copy(mesh.quaternion)
  m.scale.copy(mesh.scale)
  pedestal.add(m)
  group.updateMatrixWorld(true)
  return m.matrixWorld
}

/** The convex hull of points in the floor's plane (Andrew's monotone chain). */
const hull2 = (pts: readonly [number, number][]): [number, number][] => {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list: [number, number][]) => {
    const out: [number, number][] = []
    for (const q of list) {
      while (
        out.length >= 2 &&
        cross(
          out[out.length - 2] as [number, number],
          out[out.length - 1] as [number, number],
          q,
        ) <= 0
      )
        out.pop()
      out.push(q)
    }
    return out.slice(0, -1)
  }
  return [...half(p), ...half([...p].reverse())]
}

/** The widest gap between two convex outlines along any of their edges' normals; < 0 overlaps. */
const separation = (a: readonly [number, number][], b: readonly [number, number][]): number => {
  let best = Number.NEGATIVE_INFINITY
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i] as [number, number]
      const q = poly[(i + 1) % poly.length] as [number, number]
      const len = Math.hypot(q[0] - p[0], q[1] - p[1])
      const n = [(q[1] - p[1]) / len, -(q[0] - p[0]) / len]
      const pa = a.map((v) => v[0] * (n[0] as number) + v[1] * (n[1] as number))
      const pb = b.map((v) => v[0] * (n[0] as number) + v[1] * (n[1] as number))
      best = Math.max(best, Math.min(...pb) - Math.max(...pa), Math.min(...pa) - Math.max(...pb))
    }
  }
  return best
}

describe.skipIf(!HAVE_TABLE)("DEV-578: the first step's four tables, against 2016's table", () => {
  const load = async () => {
    const root = await parse(TABLE_FILE)
    const facts = tableFactsOf(root.getObjectByName('commander-table') as THREE.Object3D)
    const mesh = root.getObjectByName('table') as THREE.Mesh
    const position = mesh.geometry.getAttribute('position')
    const vertices = (m: THREE.Matrix4): THREE.Vector3[] =>
      Array.from({ length: position.count }, (_, i) =>
        new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(m),
      )
    return { facts, mesh, vertices }
  }

  it('keeps every two neighbours apart, by more than a centimetre, where 30 degrees left 18 cm', async () => {
    const { facts, mesh, vertices } = await load()
    const footprint = (bearing: number) =>
      hull2(vertices(hungTable(facts, mesh, bearing)).map((v) => [v.x, v.z] as [number, number]))
    // DEV-620: five, CREDITS first and far out; every neighbour apart.
    const at = stepBearings('doors', 5)
    const gaps = at.slice(1).map((b, i) => separation(footprint(at[i] as number), footprint(b)))
    for (const g of gaps) expect(g, 'metres between neighbouring tables').toBeGreaterThan(0.01)
    // The step is the narrowest whole degree that does: one less and they touch.
    const tighter = DOORS_BEARING_STEP - DEG
    const touching = separation(
      footprint(SEAT_REST_BEARING),
      footprint(SEAT_REST_BEARING + tighter),
    )
    expect(touching, 'a degree tighter, the tables meet').toBeLessThan(0)
    // The other steps keep their 30 degrees.
    expect(TABLE_BEARING_STEP).toBeCloseTo(30 * DEG, 12)
  })

  it('stands all four in a flat 1280 x 720 frame and a phone in landscape, SINGLE PLAYER under the pointer', async () => {
    const { facts, mesh, vertices } = await load()
    const fov = rendererFov()
    const eye = seatEyeLocal(SPEC)
    // DEV-858: OPTIONS is the arc's first table, in frame with the four after it.
    const at = stepBearings('doors', 5)
    // SINGLE PLAYER, the third of the five, is the home table.
    expect(at[2] as number).toBeCloseTo(SEAT_REST_BEARING, 12)
    for (const [w, h] of [
      [1280, 720],
      [915, 412],
    ] as const) {
      const camera = new THREE.PerspectiveCamera(fov, w / h, 0.05, 100)
      camera.position.set(eye.x, eye.y, eye.z)
      camera.rotation.order = 'YXZ'
      camera.rotation.set(seatPitchLocal(), seatYawLocal(), 0)
      camera.updateMatrixWorld(true)
      for (const bearing of at) {
        for (const v of vertices(hungTable(facts, mesh, bearing))) {
          const p = v.project(camera)
          expect(Math.abs(p.x), `${w} x ${h}, table at ${(bearing / DEG).toFixed(1)}`).toBeLessThan(
            1,
          )
        }
      }
      // And the resting pointer is on SINGLE PLAYER's gaze sphere, dead centre.
      const g = tableGazeLocal(SPEC, at[2] as number)
      const c = new THREE.Vector3(g.x, g.y, g.z).project(camera)
      expect(Math.hypot(c.x, c.y)).toBeLessThan(1e-9)
    }
  })
})

/* ───────────────────── DEV-580: square plates, and one mark, the reticle ──── */
//
// Matt, 2026-10-03, on 0.18.0: the BACK and PAGE plates become squares to
// match the tables, and 2016's cursor sphere over the selected table goes
// (the triangle reticle, DEV-572, is the one mark). Geometry, not rotation:
// the plate's corners are measured where they land, against the seat.

describe('DEV-580: the lap plates are squares, one side to the seat', () => {
  /** A mesh's vertices in the ROOM's frame (the room is turned in the world). */
  const inRoom = (room: HangarArt, mesh: THREE.Mesh): THREE.Vector3[] => {
    room.object.updateMatrixWorld(true)
    const p = mesh.geometry.getAttribute('position')
    return Array.from({ length: p.count }, (_, i) =>
      room.object.worldToLocal(
        new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld),
      ),
    )
  }
  /** The points of `pts` furthest from `c`, deduplicated: a polygon's corners. */
  const corners = (pts: THREE.Vector3[], c: THREE.Vector3): THREE.Vector3[] => {
    const far = Math.max(...pts.map((v) => v.distanceTo(c)))
    const out: THREE.Vector3[] = []
    for (const v of pts) {
      if (Math.abs(v.distanceTo(c) - far) > 1e-6) continue
      if (!out.some((o) => o.distanceTo(v) < 1e-6)) out.push(v)
    }
    return out
  }
  /** A flat square's corners: four, its sides equal to `2 * half`, one side square on to the seat. */
  const expectSquareToSeat = (
    cs: THREE.Vector3[],
    c: THREE.Vector3,
    half: number,
    what: string,
  ) => {
    expect(cs.length, `${what}: four corners`).toBe(4)
    for (const v of cs) expect(v.y, `${what}: flat`).toBeCloseTo(c.y, 6)
    // Order round the centre, then every side is 2 * half.
    const ordered = [...cs].sort(
      (a, b) => Math.atan2(a.z - c.z, a.x - c.x) - Math.atan2(b.z - c.z, b.x - c.x),
    )
    const seat = seatEyeLocal(SPEC)
    const toSeat = new THREE.Vector3(seat.x - c.x, 0, seat.z - c.z).normalize()
    let facing = 0
    for (let i = 0; i < 4; i++) {
      const a = ordered[i] as THREE.Vector3
      const b = ordered[(i + 1) % 4] as THREE.Vector3
      expect(a.distanceTo(b), `${what}: a side`).toBeCloseTo(2 * half, 6)
      // A side whose outward normal points at the seat.
      const mid = a.clone().add(b).multiplyScalar(0.5).sub(c).setY(0).normalize()
      if (mid.dot(toSeat) > 1 - 1e-6) facing++
    }
    expect(facing, `${what}: one side square on to the seat`).toBe(1)
  }

  it('BACK and PAGE: a four-cornered plate and a four-cornered fill, square on to the seat', () => {
    const room = build()
    for (const name of ['hangar-page-prev', 'hangar-page-next']) {
      const group = room.object.getObjectByName(name) as THREE.Group
      expect(group, name).toBeDefined()
      const meshes = group.children.filter((m) => (m as THREE.Mesh).isMesh) as THREE.Mesh[]
      const circles = meshes.filter((m) => m.geometry.type === 'CircleGeometry')
      // The plate and the arrowhead: four sides and three, and no octagon.
      expect(
        circles.map((m) => (m.geometry as THREE.CircleGeometry).parameters.segments).sort(),
        name,
      ).toEqual([3, 4])
      const plate = circles.find(
        (m) => (m.geometry as THREE.CircleGeometry).parameters.segments === 4,
      ) as THREE.Mesh
      const centre = room.object.worldToLocal(group.getWorldPosition(new THREE.Vector3()))
      expectSquareToSeat(corners(inRoom(room, plate), centre), centre, PLATE_HALF, `${name} plate`)
      // The dwell's fill frame: its outer edge a square too, the same way round.
      const fill = meshes.find((m) => m.geometry.type === 'RingGeometry') as THREE.Mesh
      fill.scale.setScalar(1)
      const fc = centre.clone().setY(centre.y + fill.position.y)
      expectSquareToSeat(corners(inRoom(room, fill), fc), fc, PLATE_FILL_OUTER, `${name} fill`)
    }
  })

  it('keeps the plate the size the octagon read: its half side within a few mm of the octagon’s apothem', () => {
    // The octagon was 0.11 m to a corner: 0.1016 m to a side.
    expect(Math.abs(PLATE_HALF - 0.11 * Math.cos(Math.PI / 8))).toBeLessThan(0.005)
    expect(PLATE_FILL_OUTER - PLATE_FILL_INNER).toBeCloseTo(0.02, 9)
    expect(PLATE_FILL_INNER).toBeGreaterThan(PLATE_HALF)
    expect(plateSquareRadius(PLATE_FILL_OUTER) * Math.SQRT1_2).toBeCloseTo(PLATE_FILL_OUTER, 12)
  })
})

describe('DEV-580: no cursor sphere; the reticle is the one mark', () => {
  it('stands no sphere on any table, selected or not, on any step', () => {
    const room = build()
    const spheres = () => {
      let n = 0
      for (const g of room.object.children.filter((c) => c.name === 'hangar-holotable'))
        g.traverse((o) => {
          if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.type === 'SphereGeometry') n++
        })
      return n
    }
    expect(spheres(), 'the doors, nothing selected').toBe(0)
    for (const t of tablesOf(room)) {
      expect(lookAt(room, t.bearing)).toBe(true)
      expect(spheres(), `selected at ${(t.bearing / DEG).toFixed(0)}`).toBe(0)
    }
    // And the aircraft step: SINGLE PLAYER, the home table.
    lookAt(room, SEAT_REST_BEARING)
    room.choose()
    expect(room.view).toBe('vehicles')
    lookAt(room, SEAT_REST_BEARING)
    expect(room.aim, 'the premise: a table is selected').not.toBeNull()
    expect(spheres()).toBe(0)
  })
})

describe('DEV-574: a pedestal turns with its table', () => {
  it('keeps pedestalYaw for whatever bearing the table moves to', () => {
    const room = build()
    // A stand-in pedestal hung as `hangar-art.ts` hangs it: turned for the bearing
    // the table has when the art lands.
    const az = -89.7 * DEG
    const groups = room.object.children.filter((c) => c.name === 'hangar-holotable')
    const seat = seatEyeLocal(SPEC)
    const bearingOf = (g: THREE.Object3D) =>
      Math.atan2(g.position.x - seat.x, seat.z - g.position.z)
    for (const g of groups) {
      const pedestal = new THREE.Object3D()
      pedestal.name = 'holotable-pedestal'
      pedestal.rotation.y = -bearingOf(g) - az
      g.add(pedestal)
    }
    // Walk to a step with a different count: SINGLE PLAYER, two aircraft.
    lookAt(room, doorBearing(room, 'single-player'))
    room.choose()
    expect(room.view).toBe('vehicles')
    for (const g of groups) {
      if (!g.visible) continue
      const pedestal = g.getObjectByName('holotable-pedestal') as THREE.Object3D
      expect(wrapAngle(pedestal.rotation.y - (-bearingOf(g) - az))).toBeCloseTo(0, 9)
    }
  })
})

/** The bearing of door `id`'s table on the step that is up. */
const doorBearing = (room: HangarArt, id: string): number => {
  const at = room.doors.findIndex((d) => d.id === id)
  expect(at, `the step offers ${id}`).toBeGreaterThanOrEqual(0)
  return stepBearings(room.view, room.doors.length)[at] as number
}
