// tests/unit/mode-mark.test.ts — the flight-plan table stands ONE mark (DEV-354).
//
// Matt, 2026-09-24: *"mode select - this should be a single rotating ring/gate
// for ring attack, a single jump pad for target practice. a single orb for free
// flight."*
//
// Every assertion is about what the mark DRAWS — a count of meshes, an extent,
// a colour read through a different route from the code's — never an option
// echoed back. The real GLBs are gitignored, so the gate and the orb here are
// stand-ins built the way `diorama-look.test.ts` built them before DEV-354,
// through the very normalisers the room uses; `checkpoint-ring-asset.test.ts`
// and `orb-art.test.ts` repeat the orientation claims on the real files
// wherever they are hydrated.

import fs from 'node:fs'
import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GameMode, PadSolid } from '@/content/level-schema'
import { loadMissionIndex } from '@/game/mission-index'
import { type CollectibleKind, MODES, rulesFor, scores } from '@/game/modes'
import { buildPadGeometry } from '@/game/pad-art'
import { PROPS } from '@/generated/constants.generated'
import { SPIN_DEG_PER_SECOND } from '@/render/holo-ship'
import {
  createInstructorMark,
  createModeMark,
  disposeInstructorHull,
  gateMarkGeometry,
  instructorHull,
  MARK_NAMES,
  type ModeMark,
  type ModeMarkKind,
  modeMarkKind,
  orbMarkGeometry,
} from '@/render/mode-mark'
import { hexSrgb, LIVERY_PANEL_SRGB, type Srgb } from '@/render/racer-livery'
import { srgbToLinear } from '@/render/unity-space'

/* ─────────────────────────────────────────────────────────── the fixtures ── */

/** `checkpoint-ring.glb`'s baked extents, opening along z. */
const BAKED = { x: 6.24, y: 9.074, z: 4.472 }

/**
 * A hexagonal frame with the GLB's own BAKED extents and its opening along z,
 * through `gateMarkGeometry` — so the prefab's 90-degree roll is applied by the
 * code under test, not by this file.
 */
const standInGate = (): THREE.BufferGeometry => {
  const frame = new THREE.TorusGeometry(1, 0.2, 3, 6)
  frame.computeBoundingBox()
  const s = (frame.boundingBox as THREE.Box3).getSize(new THREE.Vector3())
  frame.scale(BAKED.x / s.x, BAKED.y / s.y, BAKED.z / s.z)
  return gateMarkGeometry(new THREE.Mesh(frame)) as THREE.BufferGeometry
}

/** A 1 m faceted ball with a node transform on it, as a glTF scene carries one. */
const standInOrb = (): THREE.BufferGeometry => {
  const root = new THREE.Group()
  const node = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1))
  node.scale.setScalar(2.5)
  root.add(node)
  return orbMarkGeometry(root) as THREE.BufferGeometry
}

/** A live pad's landing surface off a shipped level — tracked JSON, so present in CI. */
const SOLID = (
  JSON.parse(fs.readFileSync('content/levels/rookie_01_jumpSeat.json', 'utf8')) as {
    pads: { live: boolean; solid: PadSolid | null }[]
  }
).pads.find((p) => p.live && p.solid?.live)?.solid as PadSolid

/** The cylinder `render/hangar.ts` sizes a mark into: the rim's diameter, and 0.18 m. */
const SWEEP = 0.52
const TALL = 0.18

const art = (kind: CollectibleKind): THREE.BufferGeometry =>
  kind === 'ring' ? standInGate() : kind === 'orb' ? standInOrb() : buildPadGeometry(SOLID).geometry

const KINDS: readonly CollectibleKind[] = ['ring', 'padZone', 'orb']

/** The one mesh a mark draws. */
const meshOf = (mark: ModeMark): THREE.Mesh => {
  const meshes: THREE.Mesh[] = []
  mark.object.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh)
  })
  return meshes[0] as THREE.Mesh
}

/** What the mark DRAWS, in its own frame: the disc it sweeps, its floor and top, x and z extents. */
const drawn = (mark: ModeMark) => {
  mark.object.updateWorldMatrix(true, true)
  const mesh = meshOf(mark)
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
  const v = new THREE.Vector3()
  const box = new THREE.Box3()
  let swept = 0
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
    box.expandByPoint(v)
    swept = Math.max(swept, Math.hypot(v.x, v.z))
  }
  return { swept, low: box.min.y, high: box.max.y, size: box.getSize(new THREE.Vector3()), box }
}

/** A material colour as three would take it from an sRGB `_Color` — a route the code does not use. */
const fromSheet = (c: readonly number[]) =>
  new THREE.Color().setRGB(c[0] as number, c[1] as number, c[2] as number, THREE.SRGBColorSpace)

afterEach(() => {
  vi.restoreAllMocks()
})

/* ═════════════════════════ the kind is the MODE'S own ═════════════════════ */

describe('a flight plan stands the thing it SCORES (DEV-354)', () => {
  it('stands, for every mode the game has, a kind that mode scores — or, where it teaches, the instructor', () => {
    // Read off the mode's row, never its name — so this is swept over MODES,
    // and a sixth mode is covered with no edit here. DEV-379: a mode that
    // TEACHES scores rings too, and stands the one thing no other plan has.
    for (const mode of Object.keys(MODES) as GameMode[]) {
      const kind = modeMarkKind(mode)
      expect(kind, `${mode} stands nothing`).not.toBeNull()
      if (rulesFor(mode).teaches) {
        expect(kind, `${mode} teaches`).toBe('instructor')
        continue
      }
      expect(
        scores(mode, kind as CollectibleKind),
        `${mode} stands a ${kind} it does not score`,
      ).toBe(true)
    }
  })

  it('is Matt’s sentence: a gate for Ring Attack, a pad for Target Practice, an orb for Free Flight', () => {
    // The outside source. *"a single rotating ring/gate for ring attack, a
    // single jump pad for target practice. a single orb for free flight."*
    expect(MARK_NAMES[modeMarkKind('ringAttack') as CollectibleKind]).toBe('gate')
    expect(MARK_NAMES[modeMarkKind('targetPractice') as CollectibleKind]).toBe('pad')
    expect(MARK_NAMES[modeMarkKind('freeFlight') as CollectibleKind]).toBe('orb')
  })

  it('gives every plan the SHIPPED content offers a different mark', async () => {
    // Three plans on the arc, three different things — which is the whole of
    // what the step is for. Swept over the real index, so a plan the content
    // adds is held to it too.
    const plans = [...new Set((await loadMissionIndex()).map((c) => c.mode))]
    expect(plans.length, 'the index offers no plans').toBeGreaterThanOrEqual(3)
    const kinds = plans.map((m) => modeMarkKind(m))
    expect(new Set(kinds).size, `two plans share a mark: ${plans.join(', ')}`).toBe(plans.length)
  })
})

/* ═════════════════ ONE thing, sized to the table, turning ═════════════════ */

describe('a flight-plan mark is ONE model on the table (DEV-354)', () => {
  it('draws exactly one mesh — no island, no course, no craft', () => {
    for (const kind of KINDS) {
      const mark = createModeMark(kind, art(kind), SWEEP, TALL)
      const meshes: THREE.Object3D[] = []
      mark.object.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes.push(o)
      })
      expect(
        meshes.map((m) => m.name),
        kind,
      ).toEqual([`mode-mark-${MARK_NAMES[kind]}`])
      expect(mark.object.name).toBe('mode-mark')
      expect(mark.object.userData.kind).toBe(kind)
      mark.dispose()
    }
  })

  it('fits the cylinder it is given, and fills it on one side', () => {
    for (const kind of KINDS) {
      const mark = createModeMark(kind, art(kind), SWEEP, TALL)
      const d = drawn(mark)
      const height = d.high - d.low
      expect(d.swept, `${kind} overhangs the table`).toBeLessThanOrEqual(SWEEP / 2 + 1e-9)
      expect(height, `${kind} is taller than the room under the label`).toBeLessThanOrEqual(
        TALL + 1e-9,
      )
      // The largest that fits: one of the two bounds is met exactly.
      expect(Math.max(d.swept / (SWEEP / 2), height / TALL), kind).toBeCloseTo(1, 6)
      // And what it reports is what it draws.
      expect(mark.reach).toBeCloseTo(d.swept, 9)
      expect(mark.height).toBeCloseTo(height, 9)
      mark.dispose()
    }
  })

  it('binds the gate and the orb by HEIGHT, and lays the pad flat to the rim', () => {
    const gate = drawn(createModeMark('ring', art('ring'), SWEEP, TALL))
    expect(gate.high - gate.low).toBeCloseTo(TALL, 9)
    const orb = drawn(createModeMark('orb', art('orb'), SWEEP, TALL))
    expect(orb.high - orb.low).toBeCloseTo(TALL, 9)
    // A ball: about as far across as it is tall (no facet sits exactly on the
    // pole, so not to the millimetre).
    expect((orb.swept * 2) / (orb.high - orb.low)).toBeGreaterThan(0.9)
    expect((orb.swept * 2) / (orb.high - orb.low)).toBeLessThan(1.3)
    const pad = drawn(createModeMark('padZone', art('padZone'), SWEEP, TALL))
    expect(pad.swept).toBeCloseTo(SWEEP / 2, 9)
    // A dish you land on, not a gate: far less tall than it is wide.
    expect(pad.high - pad.low, 'the pad stands up like a gate').toBeLessThan(pad.swept / 3)
  })

  it('floats over the table, as the aircraft does', () => {
    for (const kind of KINDS) {
      const mark = createModeMark(kind, art(kind), SWEEP, TALL)
      const d = drawn(mark)
      expect(d.low, `${kind} sits on or through the table`).toBeGreaterThan(0)
      expect(d.low).toBeCloseTo(mark.bottom, 9)
      mark.dispose()
    }
  })

  it('turns about the VERTICAL, at the aircraft’s own rate', () => {
    // Measured on the drawn extents, not on the spinner's angle: a quarter of a
    // turn swaps the gate's width between x and z, which is true only if it
    // turned about y by a quarter. Pinned to a zero start so the two readings
    // are the frame's face-on and edge-on, and do not depend on the dice.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const mark = createModeMark('ring', art('ring'), SWEEP, TALL)
    const before = drawn(mark).size
    mark.update(90 / SPIN_DEG_PER_SECOND)
    const after = drawn(mark).size
    // The premise: face-on, the frame is wider than it is deep.
    expect(before.x, 'the gate is as deep as it is wide').toBeGreaterThan(before.z * 1.5)
    expect(after.x).toBeCloseTo(before.z, 6)
    expect(after.z).toBeCloseTo(before.x, 6)
    // And its height never moves: a turn about the vertical.
    expect(after.y).toBeCloseTo(before.y, 9)
    mark.dispose()
  })

  it('wants the table’s two lamps lit, as an aircraft does', () => {
    for (const kind of KINDS) {
      const mark = createModeMark(kind, art(kind), SWEEP, TALL)
      expect(mark.lamps.key.intensity, kind).toBeGreaterThan(0)
      expect(mark.lamps.fill.intensity, kind).toBeGreaterThan(0)
      // And the object adds none of its own: the scene's light COUNT is in every
      // lit program's cache key (DEV-188).
      let lights = 0
      mark.object.traverse((o) => {
        if ((o as THREE.Light).isLight) lights++
      })
      expect(lights, kind).toBe(0)
      mark.dispose()
    }
  })

  it('frees its material and never the room’s geometry', () => {
    for (const kind of KINDS) {
      const geometry = art(kind)
      let geometryFreed = false
      let materialFreed = false
      geometry.addEventListener('dispose', () => {
        geometryFreed = true
      })
      const mark = createModeMark(kind, geometry, SWEEP, TALL)
      ;(meshOf(mark).material as THREE.Material).addEventListener('dispose', () => {
        materialFreed = true
      })
      mark.dispose()
      expect(geometryFreed, `${kind}: a table freed the room’s geometry`).toBe(false)
      expect(materialFreed, `${kind}: the mark leaked its material`).toBe(true)
    }
  })
})

/* ════════════ the WORLD'S art, in the world's own material ════════════════ */

describe('each mark is the world’s own, lit (DEV-354)', () => {
  it('stands the GATE upright, its opening to the side and never to the ceiling', () => {
    // The orientation lesson: test the geometry, not the rotation. A frame's
    // thinnest extent is its DEPTH, the way you fly through it — so upright,
    // the thin axis is horizontal and the opening is clear along it; lying
    // flat, the thin axis is the vertical and a horizontal look meets the rim.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const mark = createModeMark('ring', art('ring'), SWEEP, TALL)
    mark.object.updateWorldMatrix(true, true)
    const mesh = meshOf(mark)
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
    const pts: THREE.Vector3[] = []
    for (let i = 0; i < pos.count; i++) {
      pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld))
    }
    const box = new THREE.Box3().setFromPoints(pts)
    const c = box.getCenter(new THREE.Vector3())
    const s = box.getSize(new THREE.Vector3())
    const middle = (a: 'x' | 'y' | 'z', b: 'x' | 'y' | 'z') =>
      pts.filter((p) => Math.abs(p[a] - c[a]) < s[a] / 4 && Math.abs(p[b] - c[b]) < s[b] / 4).length
    expect(s.y, 'the gate is lying flat').toBeGreaterThan(Math.min(s.x, s.z))
    expect(middle('x', 'y'), 'looking along z, the opening is blocked').toBe(0)
    // The control: across the opening, edge-on, the side posts fill the middle.
    // Without it an empty mesh would pass the line above.
    expect(middle('z', 'y'), 'seen edge-on there is no frame at all').toBeGreaterThan(0)
    // The width is horizontal: wider across than tall.
    expect(s.x, 'the gate is on end').toBeGreaterThan(s.y)
    mark.dispose()
  })

  it('keeps the gate’s normals, because the world’s frame material derives none', () => {
    // The table's old marks were unlit and `gateMarkGeometry` dropped normals.
    // Lit, a frame with no normals is black — and the frame material has no
    // `flatShading` to recover them from.
    const geometry = standInGate()
    expect(geometry.getAttribute('normal'), 'the gate lost its normals').toBeDefined()
    const mark = createModeMark('ring', geometry, SWEEP, TALL)
    expect((meshOf(mark).material as THREE.MeshStandardMaterial).flatShading).toBe(false)
    mark.dispose()
  })

  it('wears the frame’s own translucent green on the gate — lit, off the sheet', () => {
    const mark = createModeMark('ring', art('ring'), SWEEP, TALL)
    const material = meshOf(mark).material as THREE.MeshStandardMaterial
    expect(material.isMeshStandardMaterial, 'the gate is unlit').toBe(true)
    const c = PROPS.checkpointRing.frameColor
    const want = fromSheet(c)
    expect(material.color.r).toBeCloseTo(want.r, 6)
    expect(material.color.g).toBeCloseTo(want.g, 6)
    expect(material.color.b).toBeCloseTo(want.b, 6)
    // Green, as a fact about the colour and not only about the arithmetic.
    expect(material.color.g).toBeGreaterThan(material.color.r * 4)
    expect(material.transparent).toBe(PROPS.checkpointRing.frameBlends)
    expect(material.opacity).toBeCloseTo(c[3] as number, 6)
    mark.dispose()
  })

  it('stands the pad the world stands: its lathed target, vertex-painted and lit', () => {
    const geometry = art('padZone')
    const mark = createModeMark('padZone', geometry, SWEEP, TALL)
    const mesh = meshOf(mark)
    // Borrowed, not copied: the very mesh `buildPadGeometry` lathed.
    expect(mesh.geometry).toBe(geometry)
    const material = mesh.material as THREE.MeshStandardMaterial
    expect(material.isMeshStandardMaterial, 'the pad is unlit').toBe(true)
    expect(material.vertexColors, 'the pad lost its paint').toBe(true)
    mark.dispose()
  })

  it('wears energy_orb.mat’s pale green on the orb — lit, off the sheet', () => {
    const mark = createModeMark('orb', art('orb'), SWEEP, TALL)
    const material = meshOf(mark).material as THREE.MeshStandardMaterial
    expect(material.isMeshStandardMaterial, 'the orb is unlit').toBe(true)
    const want = fromSheet(PROPS.energyOrb.color)
    expect(material.color.r).toBeCloseTo(want.r, 6)
    expect(material.color.g).toBeCloseTo(want.g, 6)
    expect(material.color.b).toBeCloseTo(want.b, 6)
    // Pale green: green leads, and red is not far behind.
    expect(material.color.g).toBeGreaterThan(material.color.r)
    expect(material.color.r).toBeGreaterThan(material.color.b)
    mark.dispose()
  })
})

/* ═══════════ the instructor, on Flight School's table (DEV-379) ═══════════ */

/**
 * A stand-in HoverJet: a delta's proportions (the exterior GLB is 6.82 x 2.01
 * x 6.17 m, `holo-ship.ts`), vertex-coloured half in the livery's panel orange
 * and half in a warm grey, under a node transform as a glTF scene carries one.
 * The real GLB is gitignored; `racer-livery.test.ts` paints the real hull.
 */
const GREY: Srgb = [0.35, 0.33, 0.31]
const standInJet = (): THREE.Object3D => {
  const root = new THREE.Group()
  const geometry = new THREE.BoxGeometry(6.82, 2.01, 6.17)
  const colours: number[] = []
  const count = geometry.getAttribute('position').count
  for (let i = 0; i < count; i++) {
    const c = i % 2 === 0 ? LIVERY_PANEL_SRGB : GREY
    colours.push(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]))
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3))
  const node = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true }))
  node.position.set(0.4, 1.4, -0.6)
  root.add(node)
  root.position.set(3, 0, 3)
  return root
}

/** The lesson files' colour, off the lesson file itself (a route the room does not take). */
const LESSON_COLOUR = (
  JSON.parse(fs.readFileSync('content/authored/lesson_01_canyon.json', 'utf8')) as {
    lesson: { instructor: { colour: string } }
  }
).lesson.instructor.colour

/** Every mesh under a root. */
const meshesOf = (root: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = []
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh)
  })
  return out
}

describe('a Flight School table stands the instructor (DEV-379)', () => {
  it('paints the hull in the lesson’s colour, and never the aircraft table’s', () => {
    const jet = standInJet()
    const colourOf = (root: THREE.Object3D) =>
      (meshesOf(root)[0] as THREE.Mesh).geometry.getAttribute('color') as THREE.BufferAttribute
    const before = Array.from(colourOf(jet).array)
    const hull = instructorHull(jet, hexSrgb(LESSON_COLOUR))
    const painted = colourOf(hull)
    // The panel lands ON the target (`repaintSrgb` of the panel is the target),
    // in linear, which is what the attribute holds.
    const target = hexSrgb(LESSON_COLOUR).map(srgbToLinear)
    expect(painted.getX(0)).toBeCloseTo(target[0] as number, 4)
    expect(painted.getY(0)).toBeCloseTo(target[1] as number, 4)
    expect(painted.getZ(0)).toBeCloseTo(target[2] as number, 4)
    // The grey is not livery, and keeps its exact bits.
    expect(painted.getX(1)).toBe(Math.fround(srgbToLinear(GREY[0])))
    // Trap 19: the prototype — the aircraft table's hull — is untouched.
    const after = Array.from(colourOf(jet).array)
    expect(after).toEqual(before)
    expect(meshesOf(hull)[0]?.geometry).not.toBe(meshesOf(jet)[0]?.geometry)
    // The materials are the aircraft's, so the program is the one it compiled.
    expect(meshesOf(hull)[0]?.material).toBe(meshesOf(jet)[0]?.material)
    disposeInstructorHull(hull)
  })

  it('is ONE mark, named as a mark and not as an aircraft to pick', () => {
    const mark = createInstructorMark(instructorHull(standInJet(), GREY), SWEEP, TALL)
    expect(mark.kind).toBe('instructor')
    expect(mark.object.name).toBe('mode-mark')
    expect(mark.object.userData.kind).toBe('instructor')
    // `ship-select.spec.ts` counts aircraft by this outer prefix.
    const aircraft: string[] = []
    mark.object.traverse((o) => {
      if (/^holo-ship-(?!spinner-)/.test(o.name)) aircraft.push(o.name)
    })
    expect(aircraft).toEqual([])
    expect(meshesOf(mark.object)).toHaveLength(1)
    expect(MARK_NAMES[mark.kind as ModeMarkKind]).toBe('instructor')
  })

  it('fits the flight-plan cylinder, bound by the sweep, and hovers as the aircraft does', () => {
    const mark = createInstructorMark(instructorHull(standInJet(), GREY), SWEEP, TALL)
    mark.object.updateWorldMatrix(true, true)
    const box = new THREE.Box3()
    let swept = 0
    const v = new THREE.Vector3()
    for (const mesh of meshesOf(mark.object)) {
      const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
        box.expandByPoint(v)
        swept = Math.max(swept, Math.hypot(v.x, v.z))
      }
    }
    const height = box.max.y - box.min.y
    expect(swept).toBeLessThanOrEqual(SWEEP / 2 + 1e-9)
    expect(height).toBeLessThanOrEqual(TALL + 1e-9)
    // A delta is wide and flat: the SWEEP binds, so it stands as large as the
    // aircraft does on the aircraft step.
    expect(swept).toBeCloseTo(SWEEP / 2, 6)
    expect(mark.reach).toBeCloseTo(swept, 6)
    expect(mark.height).toBeCloseTo(height, 6)
    expect(box.min.y).toBeGreaterThan(0)
    expect(box.min.y).toBeCloseTo(mark.bottom, 6)
  })

  it('binds by HEIGHT when a hull is tall, by the same rule as every mark', () => {
    const tallHull = new THREE.Mesh(new THREE.BoxGeometry(1, 3, 1), new THREE.MeshBasicMaterial())
    const mark = createInstructorMark(tallHull, SWEEP, TALL)
    expect(mark.height).toBeCloseTo(TALL, 6)
    expect(mark.reach).toBeLessThan(SWEEP / 2)
  })

  it('turns about the vertical, lit by the table’s two lamps and none of its own', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const mark = createInstructorMark(instructorHull(standInJet(), GREY), SWEEP, TALL)
    const size = () => {
      mark.object.updateWorldMatrix(true, true)
      return new THREE.Box3().setFromObject(mark.object).getSize(new THREE.Vector3())
    }
    const before = size()
    mark.update(90 / SPIN_DEG_PER_SECOND)
    const after = size()
    expect(after.x).toBeCloseTo(before.z, 6)
    expect(after.z).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 9)
    expect(mark.lamps.key.intensity).toBeGreaterThan(0)
    expect(mark.lamps.fill.intensity).toBeGreaterThan(0)
    let lights = 0
    mark.object.traverse((o) => {
      if ((o as THREE.Light).isLight) lights++
    })
    expect(lights).toBe(0)
  })

  it('frees nothing of the room’s: the hull is borrowed', () => {
    const hull = instructorHull(standInJet(), GREY)
    let freed = false
    for (const mesh of meshesOf(hull))
      mesh.geometry.addEventListener('dispose', () => {
        freed = true
      })
    createInstructorMark(hull, SWEEP, TALL).dispose()
    expect(freed).toBe(false)
    disposeInstructorHull(hull)
    expect(freed).toBe(true)
  })
})
