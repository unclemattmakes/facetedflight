// tests/unit/hangar-art.test.ts — 2016's level-select room, placed (DEV-430).
//
// `render/hangar-art.ts` stands `setGameplayOptions`' own room around the port's
// seat, tables and parked jet. The orientation lesson decides how this is
// tested: every claim is about where a thing ENDS UP, measured with three's own
// matrices on the real GLBs — floor under the seat, nothing in the player's
// head, the jet in plain view, the chair's back behind the eye — and two of
// them are measured against something 2016's scene fixes independently of the
// converted mesh: a second mesh from a second asset through a second transform
// chain, and Unity's own box under the lift. No angle is asserted: an angle
// would be my belief written twice (DEV-040).
//
// The GLBs are bought geometry and never in git (hard rule 7), so the half that
// reads them is guarded, the disk work is inside each `it`, and the guard has a
// loud counterpart.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it, vi } from 'vitest'
import {
  seatEyeLocal,
  TABLE_RIM_RADIUS,
  TABLE_TOP,
  tableBearings,
  tableLocal,
} from '@/render/hangar'
import {
  assembleHangarArt,
  chairMatrix,
  configureParkedJet,
  createHangarArt,
  dressParkedJet,
  HANGAR_CHAIR_MESH,
  HANGAR_ROOM_MESH,
  HANGAR_TABLE_MESH,
  JET_MATERIAL_RECORD,
  PARKED_JET_KEEPS,
  PARKED_JET_PROJECTORS,
  pedestalYaw,
  roomFactsOf,
  roomMatrix,
} from '@/render/hangar-art'
import { bareHangarLightRig, configureReflective } from '@/render/hangar-light'
import { attachHoverGlow, HOVER_GLOW_NAMES } from '@/render/hover-glow'
import { LAMBERT1_COLOR_SRGB } from '@/render/lambert1'
import { hangarSpecFor, plinthTopY } from '@/sim/hangar'
import { decodeMesh, parseMeshAsset } from '../../tools/assets/unity-mesh-asset.mjs'
import { legacyAvailable } from '../../tools/legacy-root.mjs'

const FILES = {
  room: `public/${HANGAR_ROOM_MESH}`,
  chair: `public/${HANGAR_CHAIR_MESH}`,
  table: `public/${HANGAR_TABLE_MESH}`,
}
const AVAILABLE = Object.values(FILES).every((f) => fs.existsSync(f))
const haveLegacy = legacyAvailable()

const spec = hangarSpecFor()
const seat = seatEyeLocal(spec)
const placement = {
  seat,
  floorY: spec.floorY,
  parkY: plinthTopY(spec),
  tableTop: TABLE_TOP,
}

const parse = async (file: string): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(file)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

const loadAll = async () => ({
  room: await parse(FILES.room),
  chair: await parse(FILES.chair),
  table: await parse(FILES.table),
})

/** Every vertex of a geometry through a matrix. */
const pointsOf = (geometry: THREE.BufferGeometry, matrix = new THREE.Matrix4()) => {
  const p = geometry.getAttribute('position')
  const out: THREE.Vector3[] = []
  for (let i = 0; i < p.count; i++)
    out.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(matrix))
  return out
}

const partOf = (root: THREE.Object3D, name: string): THREE.BufferGeometry => {
  const mesh = root.getObjectByName(name) as THREE.Mesh | undefined
  if (!mesh?.isMesh) throw new Error(`no part ${name}`)
  return mesh.geometry
}

/** A mesh of the given parts, placed in the room group's frame, for raycasting. */
const placedMesh = (root: THREE.Object3D, names: readonly string[]): THREE.Mesh => {
  const facts = roomFactsOf(root.getObjectByName('hangar-room') as THREE.Object3D)
  const m = roomMatrix(facts, seat, spec.floorY)
  const group = new THREE.Group()
  for (const name of names) {
    const mesh = new THREE.Mesh(
      partOf(root, name),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    )
    mesh.applyMatrix4(m)
    group.add(mesh)
  }
  group.updateMatrixWorld(true)
  return group as unknown as THREE.Mesh
}

// ── DEV-531: the parked jet wears the deck's material — no files needed ─────
//
// Matt: "the jet in the hangar stands out as not being lit like everything
// else." The jet wore the glTF's Maya grey with three's default specular and no
// reflected sky; 2016 drew it in `lambert1.mat`, the same material as the deck.

describe("DEV-531 — the parked jet wears the deck's material", () => {
  const roomMaterial = () =>
    new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      flatShading: true,
      side: THREE.FrontSide,
      metalness: 0,
      envMap: new THREE.DataTexture(new Uint16Array(4 * 4 * 4), 4, 4),
    })

  it("the deck's record IS the jet's material: lambert1.mat, Marmoset Vertex Color Specular IBL", () => {
    // `render/lambert1.ts` names the ship's shipped material by this path; the
    // sheet read the deck's off the same file. Two readers, one file.
    expect(JET_MATERIAL_RECORD.material).toMatch(/lowPolyArt\/Materials\/lambert1\.mat$/)
    expect(JET_MATERIAL_RECORD.shader).toMatch(/VertexColor\/Marmoset Specular IBL\.shader$/)
  })

  it('configures the deck recipe with lambert1’s _Color on colour, the sky turned to the room', () => {
    const jet = configureParkedJet(
      roomMaterial(),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7),
    )
    const deck = configureReflective(roomMaterial(), JET_MATERIAL_RECORD)
    for (const k of ['roughness', 'metalness', 'specularIntensity', 'envMapIntensity'] as const)
      expect(jet[k]).toBe(deck[k])
    expect(jet.specularColor.equals(deck.specularColor)).toBe(true)
    const srgb = { r: 0, g: 0, b: 0 }
    jet.color.getRGB(srgb, THREE.SRGBColorSpace)
    // Through three's linear working space and back: float32 uniforms.
    for (const [k, v] of [srgb.r, srgb.g, srgb.b].entries())
      expect(v).toBeCloseTo(LAMBERT1_COLOR_SRGB[k] as number, 5)
    expect(jet.envMapRotation.y).toBeCloseTo(0.7, 9)
  })

  it('dresses every mesh, narrows RGBA to the same RGB, and frees the glTF material', () => {
    const ship = new THREE.Group()
    const olds: THREE.Material[] = []
    for (let k = 0; k < 2; k++) {
      const g = new THREE.BoxGeometry(1, 1, 1)
      const n = g.getAttribute('position').count
      // As GLTFLoader hands a Unity bake over: normalised uint16 RGBA.
      const c = new Uint16Array(n * 4).map(
        (_, i) => ((i * 977) % 65536) | (i % 4 === 3 ? 65535 : 0),
      )
      g.setAttribute('color', new THREE.BufferAttribute(c, 4, true))
      const old = new THREE.MeshStandardMaterial()
      olds.push(old)
      ship.add(new THREE.Mesh(g, old))
    }
    const before = (ship.children as THREE.Mesh[]).map((m) => {
      const a = m.geometry.getAttribute('color')
      return Array.from({ length: a.count }, (_, i) => [a.getX(i), a.getY(i), a.getZ(i)])
    })
    const spies = olds.map((m) => vi.spyOn(m, 'dispose'))
    const material = roomMaterial()
    expect(dressParkedJet(ship, material)).toBe(2)
    for (const [k, m] of (ship.children as THREE.Mesh[]).entries()) {
      expect(m.material).toBe(material)
      const a = m.geometry.getAttribute('color')
      // `vertexAlphas` is keyed on the width: RGB is the room's program.
      expect(a.itemSize).toBe(3)
      // `vertexNormals` is keyed on the attribute's presence, and the room's
      // geometry has none (the e2e read the jet's program differing in that bit).
      expect(m.geometry.getAttribute('normal')).toBeUndefined()
      // Float32 now, so equal to a float32's precision.
      for (let i = 0; i < a.count; i++) {
        const was = (before[k] as number[][])[i] as number[]
        expect(a.getX(i)).toBeCloseTo(was[0] as number, 6)
        expect(a.getY(i)).toBeCloseTo(was[1] as number, 6)
        expect(a.getZ(i)).toBeCloseTo(was[2] as number, 6)
      }
    }
    for (const s of spies) expect(s).toHaveBeenCalledOnce()
    // Idempotent: a second pass dresses nothing.
    expect(dressParkedJet(ship, material)).toBe(0)
  })

  // DEV-546: the parked jet wears 2016's anti-grav wing, hung by the flown
  // jet's own `attachHoverGlow`. The room's dress keeps the GLOW's material
  // (f0030's blue) and gives the projectors the hull's.
  it('DEV-546: a winged jet keeps its glow and dresses its projectors with the hull', () => {
    const ship = new THREE.Group()
    ship.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()))
    const wings = new THREE.Group()
    const projectorSource = new THREE.MeshStandardMaterial()
    projectorSource.userData.unity = {
      name: 'Projector04_Mat',
      shader: null,
      colorSrgb: [0.9265, 0.9265, 0.9265],
      shininess: 4,
      specInt: 1,
    }
    for (const [name, material] of [
      ['projectors', projectorSource],
      ['glow', new THREE.MeshStandardMaterial()],
    ] as const) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), material)
      mesh.name = name
      wings.add(mesh)
    }
    attachHoverGlow(ship, wings)
    const glow = ship.getObjectByName(PARKED_JET_KEEPS) as THREE.Mesh
    expect(glow?.isMesh, 'the glow is the mesh the dress keeps').toBe(true)
    const glowMaterial = glow.material
    const material = roomMaterial()
    expect(dressParkedJet(ship, material), 'the hull and the projectors').toBe(2)
    expect(glow.material, 'the glow keeps its own').toBe(glowMaterial)
    const projectors = ship.getObjectByName(HOVER_GLOW_NAMES[0]) as THREE.Mesh
    expect(projectors.material).toBe(material)
    expect(dressParkedJet(ship, material)).toBe(0)
  })

  // DEV-546's follow-up. Matt, 2026-09-30: "match 2016's projector colour."
  // `Projector04_Mat.asset`'s `_Color` is 0.9264706 grey, read off the `.mat`
  // (and the number `convert-wings.mjs` writes into the GLB's record, which
  // `hover-glow.test.ts` pins against the same file); the hull's is
  // `lambert1.mat`'s. The projectors get a second clone of the room's class,
  // and a colour is a uniform, so the clone's program is the room's.
  it("DEV-546: the projectors wear their own clone, in Projector04_Mat's _Color", () => {
    const PROJECTOR04_COLOR_SRGB = 0.9264706
    const ship = new THREE.Group()
    ship.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()))
    const wings = new THREE.Group()
    const projectorSource = new THREE.MeshStandardMaterial()
    projectorSource.userData.unity = {
      name: 'Projector04_Mat',
      shader: 'Assets/Marmoset/Shader/VertexColor/Marmoset Specular IBL.shader',
      colorSrgb: [PROJECTOR04_COLOR_SRGB, PROJECTOR04_COLOR_SRGB, PROJECTOR04_COLOR_SRGB],
      shininess: 4,
      specInt: 0.25,
    }
    for (const [name, material] of [
      ['projectors', projectorSource],
      ['glow', new THREE.MeshStandardMaterial()],
    ] as const) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), material)
      mesh.name = name
      wings.add(mesh)
    }
    attachHoverGlow(ship, wings)
    const base = roomMaterial()
    const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7)
    const hull = configureParkedJet(base.clone(), turned)
    const projectors = configureParkedJet(base.clone(), turned)
    expect(dressParkedJet(ship, hull, projectors), 'the hull and the projectors').toBe(2)

    const projectorMesh = ship.getObjectByName(PARKED_JET_PROJECTORS) as THREE.Mesh
    expect(projectorMesh.material, 'the projectors wear their own clone').toBe(projectors)
    const hullMesh = ship.children[0] as THREE.Mesh
    expect(hullMesh.material, 'the hull wears the hull clone').toBe(hull)

    const srgb = { r: 0, g: 0, b: 0 }
    projectors.color.getRGB(srgb, THREE.SRGBColorSpace)
    for (const v of [srgb.r, srgb.g, srgb.b]) expect(v).toBeCloseTo(PROJECTOR04_COLOR_SRGB, 5)
    hull.color.getRGB(srgb, THREE.SRGBColorSpace)
    for (const [k, v] of [srgb.r, srgb.g, srgb.b].entries())
      expect(v).toBeCloseTo(LAMBERT1_COLOR_SRGB[k] as number, 5)

    // Everything else is the hull's: the colour is the one difference.
    for (const k of ['roughness', 'metalness', 'specularIntensity', 'envMapIntensity'] as const)
      expect(projectors[k]).toBe(hull[k])
    expect(projectors.envMapRotation.y).toBeCloseTo(0.7, 9)
    // And the program is the room's: every field three keys one on is the base's.
    expect(projectors.type).toBe(base.type)
    expect(projectors.side).toBe(base.side)
    expect(projectors.flatShading).toBe(base.flatShading)
    expect(projectors.vertexColors).toBe(base.vertexColors)
    expect(projectors.envMap).toBe(base.envMap)
    expect(Object.keys(projectors.defines ?? {})).toEqual(Object.keys(base.defines ?? {}))
    expect(projectors.customProgramCacheKey()).toBe(base.customProgramCacheKey())

    // Idempotent, with two materials as with one.
    expect(dressParkedJet(ship, hull, projectors)).toBe(0)
  })

  it("a clone of the room's material keeps every field three keys a program on", () => {
    const base = roomMaterial()
    const jet = base.clone()
    expect(jet.type).toBe(base.type)
    expect(jet.side).toBe(base.side)
    expect(jet.flatShading).toBe(base.flatShading)
    expect(jet.vertexColors).toBe(base.vertexColors)
    expect(jet.envMap).toBe(base.envMap)
    expect(Object.keys(jet.defines ?? {})).toEqual(Object.keys(base.defines ?? {}))
    expect(jet.customProgramCacheKey()).toBe(base.customProgramCacheKey())
  })
})

// ── The placements, by where they put things — no files needed ───────────────

describe('the placements, by where they put things', () => {
  it("turns the room about the lift's axis until 2016's eye stands on the seat's bearing", () => {
    for (const eye of [
      [-9.776, 1.27, 1.939],
      [3, 0.5, -7],
      [0.2, 1, 9],
      [-5, 1, -5],
    ] as const) {
      for (const at of [seat, { x: 2, y: 0, z: -3 }, { x: -6, y: 0, z: 1 }]) {
        const m = roomMatrix({ eye }, at, spec.floorY)
        const moved = new THREE.Vector3(...eye).applyMatrix4(m)
        const onSeat = new THREE.Vector2(moved.x, moved.z)
        const seatDir = new THREE.Vector2(at.x, at.z).normalize()
        // On the seat's RAY from the axis: same direction, not merely the same line.
        expect(onSeat.clone().normalize().dot(seatDir)).toBeCloseTo(1, 9)
        // And never moved toward or away from the axis, or up or down but by the floor.
        expect(onSeat.length()).toBeCloseTo(Math.hypot(eye[0], eye[2]), 9)
        expect(moved.y).toBeCloseTo(eye[1] + spec.floorY, 9)
      }
    }
  })

  it('is a turn, never a mirror', () => {
    // A mirrored placement also lands a point on a ray; it reverses handedness,
    // which a determinant cannot hide (DEV-044's lesson, in one number).
    const m = roomMatrix({ eye: [-9.776, 1.27, 1.939] }, seat, spec.floorY)
    expect(m.determinant()).toBeCloseTo(1, 9)
  })

  it("puts 2016's eye point on the port's eye, looking down the arc", () => {
    const chair = { eye: [-0.162, 1.043, 0.005] as const, look: [-0.999, 0, 0.033] as const }
    const m = chairMatrix(chair, seat)
    const eye = new THREE.Vector3(...chair.eye).applyMatrix4(m)
    expect(eye.distanceTo(new THREE.Vector3(seat.x, seat.y, seat.z))).toBeLessThan(1e-9)
    const look = new THREE.Vector3(...chair.look).transformDirection(m)
    // The arc is in front of the seat, toward the lift: the room group's -z.
    expect(look.dot(new THREE.Vector3(0, 0, -1))).toBeCloseTo(1, 6)
  })

  it("turns each pedestal so 2016's seat-facing side faces the port's seat", () => {
    const table = {
      toSeat: [{ direction: [-0.94, 0, 0.34] as const }, { direction: [-0.95, 0, -0.32] as const }],
    }
    for (const bearing of tableBearings(4)) {
      const yaw = pedestalYaw(table, bearing)
      const mean = new THREE.Vector3(-0.94 - 0.95, 0, 0.34 - 0.32).normalize()
      const facing = mean.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
      const base = tableLocal(spec, bearing)
      const toSeat = new THREE.Vector3(seat.x - base.x, 0, seat.z - base.z).normalize()
      expect(facing.dot(toSeat)).toBeCloseTo(1, 9)
    }
  })

  it("reads a Mesh Materializer bake's FLOAT colour as floats, not as its low bytes", () => {
    // `format: 0, dimension: 4`: sixteen bytes a vertex. The stride always
    // counted them; the colour was read as the first four.
    const f32 = (...v: number[]) => Buffer.from(new Float32Array(v).buffer).toString('hex')
    const tri = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ]
    const colours = [
      [0.081, 0.1, 0.135, 1],
      [0.494, 0.304, 0.319, 1],
      [0, 0.01, 0.02, 1],
    ]
    const yaml = [
      '%YAML 1.1',
      '%TAG !u! tag:unity3d.com,2011:',
      '--- !u!43 &4300000',
      'Mesh:',
      '  m_Name: float_colour',
      '  serializedVersion: 8',
      '  m_SubMeshes:',
      '  - serializedVersion: 2',
      '    firstByte: 0',
      '    indexCount: 3',
      '    topology: 0',
      '    firstVertex: 0',
      '    vertexCount: 3',
      '  m_Shapes:',
      '    vertices: []',
      '  m_MeshCompression: 0',
      '  m_IndexBuffer: 000001000200',
      '  m_VertexData:',
      '    m_CurrentChannels: 5',
      '    m_VertexCount: 3',
      '    m_Channels:',
      ...[
        [0, 0, 3],
        [0, 0, 0],
        [12, 0, 4],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ].flatMap(([o, f, d]) => [
        '    - stream: 0',
        `      offset: ${o}`,
        `      format: ${f}`,
        `      dimension: ${d}`,
      ]),
      '    m_DataSize: 84',
      `    _typelessdata: ${tri.map((p, i) => f32(...p) + f32(...(colours[i] as number[]))).join('')}`,
      '  m_CompressedMesh:',
      '  m_LocalAABB:',
      '    m_Center: {x: .5, y: .5, z: 0}',
      '    m_Extent: {x: .5, y: .5, z: 0}',
      '  m_MeshUsageFlags: 0',
      '',
    ].join('\n')
    const mesh = decodeMesh(parseMeshAsset(yaml))
    expect(Array.from(mesh.colorFloat ?? []).map((v) => +v.toFixed(3))).toEqual(colours.flat())
    // The byte view, for the callers that read one, is the same colour quantised.
    expect(Array.from(mesh.color ?? []).slice(0, 4)).toEqual([21, 26, 34, 255])
  })

  it('keeps the generated room when a GLB does not arrive, and says so', async () => {
    const room = new THREE.Group()
    const shell = new THREE.Mesh()
    room.add(shell)
    const warn = console.warn
    console.warn = () => {}
    try {
      const art = createHangarArt({
        ...placement,
        room,
        material: new THREE.MeshBasicMaterial(),
        replaces: [shell],
        tables: [],
        plinth: new THREE.BufferGeometry(),
        alive: () => true,
        load: async () => {
          throw new Error('offline')
        },
      })
      expect(await art.ready).toBe(false)
    } finally {
      console.warn = warn
    }
    expect(shell.visible, 'the generated shell still stands').toBe(true)
    // DEV-437: the only thing added is 2016's light rig, and it stays DARK — a
    // failed load keeps the generated room under the light it was tuned in.
    expect(room.children.filter((c) => c !== shell).map((c) => c.name)).toEqual([
      'hangar-2016-light',
    ])
    const lit: string[] = []
    room.traverse((o) => {
      const l = o as THREE.Light
      if (l.isLight && l.intensity !== 0) lit.push(l.name)
    })
    expect(lit, '2016 lights on without their room').toEqual([])
  })
})

// ── The files, placed in the real room ───────────────────────────────────────

describe.skipIf(!AVAILABLE)("2016's room, placed around the port's seat", () => {
  const eye = new THREE.Vector3(seat.x, seat.y, seat.z)
  const STRUCTURE = ['room', 'roomLower', 'platform', 'shaft'] as const

  it('stands a floor under the seat and under every table, at the floor', async () => {
    const loaded = await loadAll()
    const shell = placedMesh(loaded.room, ['room'])
    const ray = new THREE.Raycaster()
    const down = new THREE.Vector3(0, -1, 0)
    const spots = [
      { what: 'the seat', x: seat.x, z: seat.z },
      ...tableBearings(4).map((b) => ({
        what: `the table at ${Math.round((b * 180) / Math.PI)} deg`,
        ...tableLocal(spec, b),
      })),
    ]
    for (const spot of spots) {
      ray.set(new THREE.Vector3(spot.x, spec.floorY + 1, spot.z), down)
      const hit = ray.intersectObject(shell, true)[0]
      expect(hit, `a floor under ${spot.what}`).toBeDefined()
      expect(
        Math.abs((hit?.point.y ?? Infinity) - spec.floorY),
        `${spot.what}'s floor is at the floor`,
      ).toBeLessThan(0.05)
    }
  })

  it("keeps out of the player's head and off the table arc", async () => {
    const loaded = await loadAll()
    const m = roomMatrix(
      roomFactsOf(loaded.room.getObjectByName('hangar-room') as THREE.Object3D),
      seat,
      spec.floorY,
    )
    let nearest = Infinity
    let inArc = 0
    for (const name of STRUCTURE) {
      for (const p of pointsOf(partOf(loaded.room, name), m)) {
        nearest = Math.min(nearest, p.distanceTo(eye))
        // The arc's volume: 0.9..1.9 m out from the seat's axis, +-60 deg of the
        // arc's centre (-z), from just off the floor to above the labels.
        const dx = p.x - seat.x
        const dz = p.z - seat.z
        const r = Math.hypot(dx, dz)
        const bearing = Math.atan2(dx, -dz)
        const h = p.y - spec.floorY
        if (r > 0.9 && r < 1.9 && Math.abs(bearing) < Math.PI / 3 && h > 0.05 && h < 1.4) inArc++
      }
    }
    // Measured 1.23 m, and it is the floor under the chair: nothing of 2016's
    // room is nearer the eye than the floor it sits over.
    expect(nearest, "the nearest of 2016's room to the eye").toBeGreaterThan(1.1)
    expect(inArc, "vertices of 2016's room standing among the tables").toBe(0)
  })

  it('leaves the parked jet in plain view from the seat', async () => {
    const loaded = await loadAll()
    const structure = placedMesh(loaded.room, STRUCTURE)
    const ray = new THREE.Raycaster()
    for (const lift of [0.3, 0.6, 1.0]) {
      for (const side of [-1.5, 0, 1.5]) {
        const target = new THREE.Vector3(side, placement.parkY + lift, 0)
        const to = target.clone().sub(eye)
        ray.set(eye, to.clone().normalize())
        ray.far = to.length() - 0.05
        const hits = ray.intersectObject(structure, true)
        expect(
          hits.map((h) => h.point.toArray().map((v) => +v.toFixed(2))),
          `eye to the jet at (${side}, +${lift})`,
        ).toEqual([])
      }
    }
  })

  it('agrees with ITSELF across two assets: the lower shaft and a shaft segment share one footprint', async () => {
    // `botfloor_startingArea2` (one combined mesh, through the room's 0.85/0.733
    // scale) and `walls_and_pillars_pwn` (another asset, through the segment's
    // 3.655 x 4.3) were built from the same walls in 2016. Converted separately,
    // they must land on one footprint — a scale, a frame or an anchor wrong in
    // either chain moves one and not the other.
    const loaded = await loadAll()
    const a = new THREE.Box3().setFromPoints(pointsOf(partOf(loaded.room, 'roomLower')))
    const b = new THREE.Box3().setFromPoints(pointsOf(partOf(loaded.room, 'shaft')))
    for (const k of ['x', 'z'] as const) {
      expect(Math.abs(a.min[k] - b.min[k]), `min ${k}`).toBeLessThan(0.02)
      expect(Math.abs(a.max[k] - b.max[k]), `max ${k}`).toBeLessThan(0.02)
    }
  })

  it("keeps 2016's handedness: from 2016's seat the parked jet stands RIGHT of the resting look", async () => {
    // The 2016 video's aircraft-select frame (`docs/private/ref-video-2016/
    // frames/f0030.jpg`, 0:12) is taken from that seat at rest: the tables at
    // the centre-left, the parked jet right of centre. A room converted
    // without its mirror — Unity's left-handed numbers read as three's
    // right-handed ones — puts the jet on the LEFT, and every angle and
    // distance in it stays exactly as plausible.
    const loaded = await loadAll()
    const facts = roomFactsOf(loaded.room.getObjectByName('hangar-room') as THREE.Object3D)
    const eye2016 = new THREE.Vector3(...facts.eye)
    const look = new THREE.Vector3(facts.look[0], 0, facts.look[2]).normalize()
    const toJet = new THREE.Vector3(...facts.jet).sub(eye2016).setY(0).normalize()
    // In three (right-handed, y up) a viewer's right is forward x up.
    const right = look.clone().cross(new THREE.Vector3(0, 1, 0))
    expect(toJet.dot(right), 'the jet is to the right of the resting look').toBeGreaterThan(0.3)
    expect(toJet.dot(look), 'and ahead of the seat, not behind it').toBeGreaterThan(0.5)
  })

  it("sits the lift's deck on Unity's own deck box", async () => {
    // The `Cube` under `Elevator_animator` is Unity-native — a unit box placed
    // by its transform alone, through no importer (the turn indicator's
    // witnesses did this job for DEV-044). The converted deck must cover it.
    const loaded = await loadAll()
    const facts = roomFactsOf(loaded.room.getObjectByName('hangar-room') as THREE.Object3D)
    const deck = pointsOf(partOf(loaded.room, 'platform'))
    const box = new THREE.Box3().setFromPoints(deck)
    const centre = box.getCenter(new THREE.Vector3())
    const corners = facts.elevatorDeck.corners.map((c) => new THREE.Vector3(...c))
    const cubeCentre = corners
      .reduce((s, c) => s.add(c), new THREE.Vector3())
      .multiplyScalar(1 / corners.length)
    const offset = Math.hypot(centre.x - cubeCentre.x, centre.z - cubeCentre.z)
    // Measured 0.20 m: the deck is a faceted dish, the box a collider drawn round it.
    expect(offset, 'deck centre to box centre').toBeLessThan(0.25)
    // The box's own cross — the midpoint of each edge — lies on the deck. (Its
    // CORNERS do not: a rectangle's corners stand 5 cm past a round dish.)
    const reach = Math.max(...deck.map((p) => Math.hypot(p.x - centre.x, p.z - centre.z)))
    for (let i = 0; i < 4; i++) {
      const a = corners[i] as THREE.Vector3
      const b = corners[(i + 1) % 4] as THREE.Vector3
      const mid = a.clone().add(b).multiplyScalar(0.5)
      expect(
        Math.hypot(mid.x - centre.x, mid.z - centre.z),
        "an edge of Unity's box, on the deck",
      ).toBeLessThan(reach)
    }
  })

  it('stands the deck under the parked jet, its top where the jet stands', async () => {
    const loaded = await loadAll()
    const art = assembleHangarArt(loaded, placement, new THREE.MeshBasicMaterial())
    const deck = pointsOf(partOf(loaded.room, 'platform'))
    const top = Math.max(...deck.map((p) => p.y))
    // The deck is its own mesh since DEV-439 (a reflective material): its top
    // at `parkY`, and nothing of it left in the room's merged draw.
    const placed = pointsOf(art.deck.geometry)
    expect(Math.max(...placed.map((p) => p.y)), "the deck's top").toBeCloseTo(placement.parkY, 5)
    const nearAxis = pointsOf(art.room.geometry).filter(
      (p) => Math.hypot(p.x, p.z) < 3 && p.y > spec.floorY + 0.05 && p.y < spec.floorY + 1,
    )
    expect(nearAxis.length, 'no deck in the merged room').toBe(0)
    expect(top).toBeGreaterThan(0)
  })

  it('faces the chair down the arc, its back behind the eye and its pan under it', async () => {
    const loaded = await loadAll()
    const chair = loaded.chair.getObjectByName('commander-chair') as THREE.Object3D
    const facts = chair.userData as {
      eye: [number, number, number]
      look: [number, number, number]
    }
    const pts = pointsOf(partOf(loaded.chair, 'chair'), chairMatrix(facts, seat))
    const centroid = pts
      .reduce((s, p) => s.add(p), new THREE.Vector3())
      .multiplyScalar(1 / pts.length)
    // The arc is toward -z; a chair facing it has its mass BEHIND the eye.
    expect(centroid.z - eye.z, "the chair's mass is behind the eye").toBeGreaterThan(0.05)
    const box = new THREE.Box3().setFromPoints(pts)
    expect(box.max.y, 'the headrest reaches past the eye').toBeGreaterThan(eye.y)
    expect(box.min.y, 'and the chair stands clear of the floor').toBeGreaterThan(spec.floorY)
    expect(eye.y - box.min.y, "2016's 1.04 m from the chair's foot to the eye").toBeCloseTo(
      1.043,
      2,
    )
  })

  it("draws nothing of Unity's own under the chair: no white disc", async () => {
    // 2016's `Cylinder (1)` is Unity's built-in mesh in Unity's white
    // Default-Material. Its numbers ride in the chair GLB; it is not drawn
    // (`render/hangar-art.ts`, "no DISC"). Between the floor and the chair's
    // foot, round the seat, the merged room holds nothing.
    const loaded = await loadAll()
    const art = assembleHangarArt(loaded, placement, new THREE.MeshBasicMaterial())
    const under = pointsOf(art.room.geometry).filter(
      (p) =>
        Math.hypot(p.x - seat.x, p.z - seat.z) < 0.75 &&
        p.y > spec.floorY + 0.01 &&
        p.y < spec.floorY + 0.08,
    )
    expect(
      under.map((p) => p.toArray()),
      'vertices between the floor and the chair',
    ).toEqual([])
    const chair = loaded.chair.getObjectByName('commander-chair') as THREE.Object3D
    const disc = (chair.userData as { disc?: { radius?: number } }).disc
    expect(disc?.radius, "2016's disc is still RECORDED, for the day it is wanted").toBeCloseTo(
      0.678,
      2,
    )
  })

  it("paints the chair and the pedestal in 2016's own colours, not a rainbow", async () => {
    // Mesh Materializer bakes its colour as four FLOATS. Read as four bytes (the
    // mesh reader's only path until DEV-430) they came out as the low bytes of
    // each float — magenta, lime, cyan, every one bright. The true bake is dark
    // (0 to 0.49 on any channel before `_Color`), which is what 2016 lit.
    const loaded = await loadAll()
    for (const [root, part] of [
      [loaded.chair, 'chair'],
      [loaded.table, 'table'],
    ] as const) {
      const colour = partOf(root, part).getAttribute('color')
      let brightest = 0
      for (let i = 0; i < colour.count; i++) {
        brightest = Math.max(brightest, colour.getX(i), colour.getY(i), colour.getZ(i))
      }
      expect(brightest, `${part}'s brightest channel`).toBeLessThan(0.5)
      expect(brightest, `${part} is not black`).toBeGreaterThan(0.2)
    }
  })

  it('sizes each pedestal to the table it stands under', async () => {
    const loaded = await loadAll()
    const art = assembleHangarArt(loaded, placement, new THREE.MeshBasicMaterial())
    const box = new THREE.Box3().setFromPoints(pointsOf(art.pedestal))
    expect(box.max.y, "the pedestal's top is the table's").toBeCloseTo(TABLE_TOP, 6)
    expect(box.min.y, 'standing on the floor').toBeCloseTo(0, 2)
    // Half its depth against the rim that marks the table (0.26 m): 2016's
    // proportions, scaled to the port's table height, land within 1.5 cm of it.
    const halfDepth = Math.max(-box.min.z, box.max.z, -box.min.x, box.max.x)
    expect(Math.abs(halfDepth - TABLE_RIM_RADIUS), 'half-depth against the rim').toBeLessThan(0.015)
  })

  it('swaps the generated room for 2016s when the files land', async () => {
    const loaded = await loadAll()
    const room = new THREE.Group()
    const shell = new THREE.Mesh()
    const chair = new THREE.Group()
    room.add(shell, chair)
    const plinth = new THREE.BufferGeometry()
    const tables = tableBearings(4).map((bearing) => {
      const group = new THREE.Group()
      const stand = new THREE.Mesh(plinth)
      const rim = new THREE.Mesh(new THREE.BufferGeometry())
      group.add(stand, rim)
      room.add(group)
      return { group, bearing, stand, rim }
    })
    const art = createHangarArt({
      ...placement,
      room,
      material: new THREE.MeshBasicMaterial(),
      replaces: [shell, chair],
      tables,
      plinth,
      alive: () => true,
      load: async (path) =>
        path === HANGAR_ROOM_MESH
          ? loaded.room
          : path === HANGAR_CHAIR_MESH
            ? loaded.chair
            : loaded.table,
    })
    expect(await art.ready).toBe(true)
    expect(shell.visible || chair.visible, 'the generated pieces are hidden').toBe(false)
    expect(room.getObjectByName('hangar-2016')).toBeDefined()
    expect(room.getObjectByName('hangar-2016-lamps')).toBeDefined()
    for (const t of tables) {
      expect(t.stand.visible, "a table's generated plinth").toBe(false)
      expect(t.rim.visible, "and its rim, which is the hover's, stays").toBe(true)
      expect(t.group.getObjectByName('holotable-pedestal')).toBeDefined()
    }
  })

  it("dresses the deck in the class the room drew from its first frame, the shaft in the tubes' (DEV-561), and writes the sky (DEV-439)", async () => {
    // What `render/hangar.ts`'s block builds: an EMPTY sky, the one reflective
    // material wearing it, and the primer drawing that material from frame one.
    {
      const loaded = await loadAll()
      const room = new THREE.Group()
      const texture = new THREE.DataTexture(
        new Uint16Array(512 * 256 * 4),
        512,
        256,
        THREE.RGBAFormat,
        THREE.HalfFloatType,
      )
      const material = new THREE.MeshPhysicalMaterial({
        vertexColors: true,
        flatShading: true,
        envMap: texture,
      })
      const primer = new THREE.Mesh(new THREE.BufferGeometry(), material)
      room.add(primer)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const art = createHangarArt({
        ...placement,
        room,
        material: new THREE.MeshBasicMaterial(),
        replaces: [],
        tables: [],
        plinth: new THREE.BufferGeometry(),
        alive: () => true,
        load: async (path) =>
          path === HANGAR_ROOM_MESH
            ? loaded.room
            : path === HANGAR_CHAIR_MESH
              ? loaded.chair
              : loaded.table,
        reflective: { texture, material, primer },
      })
      expect(await art.ready).toBe(true)
      warn.mockRestore()
      const deck = room.getObjectByName('hangar-2016-deck') as THREE.Mesh
      const shaft = room.getObjectByName('hangar-2016-shaft') as THREE.Mesh
      const lamps = room.getObjectByName('hangar-2016-lamps') as THREE.Mesh
      expect(deck.material, "the deck wears the primer's own material").toBe(material)
      // DEV-561: the shaft no longer reflects. It is baked, and wears the
      // tubes' own unlit material, so it compiles nothing the room does not.
      expect(shaft.material, "the shaft wears the tubes' material").toBe(lamps.material)
      expect((shaft.material as THREE.MeshBasicMaterial).vertexColors).toBe(true)
      expect(primer.parent, 'the primer is gone').toBe(null)
      // DEV-899: the nine-coefficient sky is the only one; 2016's picture is not shipped.
      expect(texture.userData.sky, 'which sky stands').toBe('sh')
      // Written: not the empty texture the room began with.
      expect((texture.image.data as Uint16Array).some((v) => v !== 0)).toBe(true)
    }
  })

  it("brings 2016's light up as the art lands, and the port's down, without adding or removing one", async () => {
    // DEV-437. The menu scene's flat ambient and the room's own point lamp go to
    // ZERO (not away: a light's count is in every lit program's key), and the
    // rig built with the room — dark until now — comes up.
    const loaded = await loadAll()
    const scene = new THREE.Scene()
    const ambient = new THREE.AmbientLight(0xa8bdd2, 1.35)
    const room = new THREE.Group()
    const lamp = new THREE.PointLight(0xbfe6ec, 90)
    room.add(lamp)
    scene.add(ambient, room)
    const rig = bareHangarLightRig()
    room.add(rig)
    const count = () => {
      let n = 0
      scene.traverse((o) => {
        if ((o as THREE.Light).isLight) n++
      })
      return n
    }
    const before = count()
    const art = createHangarArt({
      ...placement,
      room,
      material: new THREE.MeshBasicMaterial(),
      replaces: [],
      tables: [],
      plinth: new THREE.BufferGeometry(),
      alive: () => true,
      lightRig: rig,
      portLights: [lamp],
      load: async (path) =>
        path === HANGAR_ROOM_MESH
          ? loaded.room
          : path === HANGAR_CHAIR_MESH
            ? loaded.chair
            : loaded.table,
    })
    expect(art.light.group, 'the rig the room built is the one lit').toBe(rig)
    expect([art.light.spot.intensity, art.light.key.intensity, art.light.probe.intensity]).toEqual([
      0, 0, 0,
    ])
    expect(await art.ready).toBe(true)
    expect(count(), 'no light added or taken away').toBe(before)
    expect([lamp.intensity, ambient.intensity], "the port's lamp and ambient").toEqual([0, 0])
    expect(
      [art.light.spot.intensity, art.light.key.intensity, art.light.probe.intensity].every(
        (v) => v > 0,
      ),
      "2016's three",
    ).toBe(true)
  })

  it.skipIf(!haveLegacy)(
    'is exactly the bytes the converter makes today',
    async () => {
      const { buildHangarArt } = await import('../../tools/assets/convert-hangar-art.mjs')
      const { files } = buildHangarArt()
      expect(Buffer.compare(files.room, fs.readFileSync(FILES.room)), 'hangar-room.glb').toBe(0)
      expect(Buffer.compare(files.chair, fs.readFileSync(FILES.chair)), 'commander-chair.glb').toBe(
        0,
      )
      expect(Buffer.compare(files.table, fs.readFileSync(FILES.table)), 'commander-table.glb').toBe(
        0,
      )
    },
    120_000,
  )
})

describe.skipIf(AVAILABLE)("2016's room — the GLBs are not hydrated", () => {
  it('says so, rather than passing quietly', () => {
    expect(
      Object.values(FILES).filter((f) => fs.existsSync(f)),
      'run tools/assets/convert-hangar-art.mjs (or pnpm assets:pull) to measure the room',
    ).toEqual([])
  })
})
