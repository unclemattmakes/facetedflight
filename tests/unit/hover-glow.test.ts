// tests/unit/hover-glow.test.ts — the HoverJet's anti-grav wing, PORTED (DEV-322,
// superseding DEV-310's strips).
//
// Orientation bugs are a CLASS here and there have been four, three caught by
// Matt from a screenshot rather than by 400 green tests. So nothing below
// asserts a quaternion — that is the belief written twice. Every claim is a
// COUNT, a DISTANCE or a SIZE, measured against something authored
// independently of the code under test:
//
//   * the READER against hand-built fixtures in BOTH of 2016's mesh dialects —
//     the old one reads as garbage, not as absence, under the wrong slot table;
//   * the PARSE against the prefab's own UNITY-NATIVE witnesses: the ten
//     `glowyBit` transforms, and the six loose `Projector04-Faceted` GameObjects
//     the combined mesh was built from — switched off, and still exact numbers;
//   * the MIRROR against the one asymmetry the part has. The inboard pair of
//     projectors are authored at scale 0.1496 and 0.1632, so the small one has
//     a SIDE, and a GLB converted without the z negation puts it on the wrong
//     one. The expected side is computed through `render/unity-space.ts`'s
//     `unityPose` — the port's own, separately verified conversion — not
//     through the converter's arithmetic (trap 24);
//   * the PLACEMENT against DEV-310's envelope, which was composed from
//     `m_LocalAABB` by different arithmetic on the same prefab (a wrong chain
//     or scale), and against the real hull GLB — where the SHAPES of the
//     pieces, an engine disc in the tail and a round one at the nose, are what
//     catch a fore-aft flip. The envelope cannot: measured with a half-turned
//     GLB, it passes.
//
// Everything that needs the read-only Unity project or the gitignored GLB is
// guarded, with the disk work INSIDE the `it` (`describe.skipIf` skips the
// tests, not the describe body), and each guarded block has a loud counterpart
// so it cannot rot green in CI for months.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { ART_POSITION, ART_SCALE, SHIP_MODEL_YAW } from '@/game/flight'
import { trailEmitterOffset } from '@/game/racers'
import { SHIP_MESH_WINGS } from '@/game/ship-wings'
import { PROPS } from '@/generated/constants.generated'
import {
  attachHoverGlow,
  GLOW_ENVELOPE_2016,
  HOVER_GLOW_NAMES,
  HULL_EXTENTS,
  projectorMaterial,
  WING_PARTS,
} from '@/render/hover-glow'
import { shininessToRoughness } from '@/render/terrain-mesh'
import { srgbToLinear, unityPose } from '@/render/unity-space'
import { measureWingTips } from '@/render/wing-trails'
import {
  buildWings,
  GHOST_RACER,
  liveWingRenderers,
  PROJECTOR_ASSET,
  type Prefab,
  readPrefab,
  type UnityDoc,
} from '../../tools/assets/convert-wings.mjs'
import {
  connectedParts,
  decodeMesh,
  loadMeshAsset,
  parseMeshAsset,
} from '../../tools/assets/unity-mesh-asset.mjs'
import { legacyAvailable, legacyPath } from '../../tools/legacy-root.mjs'

const WINGS_GLB = `public/${SHIP_MESH_WINGS}`
const HULL_GLB = 'public/assets/ships/hoverjet-exterior.glb'
const haveWings = fs.existsSync(WINGS_GLB)
const haveHull = fs.existsSync(HULL_GLB)
const haveLegacy = legacyAvailable()

// ── helpers ──────────────────────────────────────────────────────────────

const f32hex = (...v: number[]): string => Buffer.from(new Float32Array(v).buffer).toString('hex')
const u8hex = (...v: number[]): string => Buffer.from(Uint8Array.from(v)).toString('hex')

/** A minimal `Mesh` document around a vertex block, in 2016's own layout. */
const meshYaml = (o: {
  name: string
  channels: [number, number, number][] // offset, format, dimension
  currentChannels: number
  streams?: string
  vertexCount: number
  dataSize: number
  data: string
  indices: string
  indexCount: number
}): string =>
  [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    '--- !u!43 &4300000',
    'Mesh:',
    '  m_ObjectHideFlags: 0',
    `  m_Name: ${o.name}`,
    '  serializedVersion: 8',
    '  m_SubMeshes:',
    '  - serializedVersion: 2',
    '    firstByte: 0',
    `    indexCount: ${o.indexCount}`,
    '    topology: 0',
    '    firstVertex: 0',
    `    vertexCount: ${o.vertexCount}`,
    '  m_Shapes:',
    '    vertices: []',
    '  m_MeshCompression: 0',
    `  m_IndexBuffer: ${o.indices}`,
    '  m_Skin: []',
    '  m_VertexData:',
    `    m_CurrentChannels: ${o.currentChannels}`,
    `    m_VertexCount: ${o.vertexCount}`,
    '    m_Channels:',
    ...o.channels.flatMap(([offset, format, dimension]) => [
      '    - stream: 0',
      `      offset: ${offset}`,
      `      format: ${format}`,
      `      dimension: ${dimension}`,
    ]),
    ...(o.streams ? [o.streams] : []),
    `    m_DataSize: ${o.dataSize}`,
    `    _typelessdata: ${o.data}`,
    '  m_CompressedMesh:',
    '    m_Vertices:',
    '      m_NumItems: 0',
    '  m_LocalAABB:',
    '    m_Center: {x: 0, y: .5, z: 0}',
    '    m_Extent: {x: 1, y: .5, z: 0}',
    '  m_MeshUsageFlags: 0',
    '',
  ].join('\n')

/** Three vertices: a right triangle in the xy plane, +z normals. */
const TRI = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
] as const

/** Unity 5: eight slots, colour as four bytes, stride from the channels. */
const unity5Fixture = (dataSize = 84): string =>
  meshYaml({
    name: 'fixture5',
    currentChannels: 0b111,
    channels: [
      [0, 0, 3],
      [12, 0, 3],
      [24, 2, 4],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    vertexCount: 3,
    dataSize,
    data: TRI.map((p, i) => f32hex(...p) + f32hex(0, 0, 1) + u8hex(10 + i, 20, 30, 1)).join(''),
    indices: '000001000200',
    indexCount: 3,
  })

/** Unity 4: six slots, colour PACKED (`dimension: 1`), a tangent in slot 5, `m_Streams`. */
const unity4Fixture = (stride = 44): string =>
  meshYaml({
    name: 'fixture4',
    currentChannels: 0b100111,
    channels: [
      [0, 0, 3],
      [12, 0, 3],
      [24, 2, 1],
      [0, 0, 0],
      [0, 0, 0],
      [28, 0, 4],
    ],
    streams: [
      '    m_Streams:',
      '    - channelMask: 39',
      '      offset: 0',
      `      stride: ${stride}`,
      '      dividerOp: 0',
      '      frequency: 0',
    ].join('\n'),
    vertexCount: 3,
    dataSize: 132,
    data: TRI.map(
      (p, i) => f32hex(...p) + f32hex(0, 0, 1) + u8hex(200, 100 + i, 50, 255) + f32hex(1, 0, 0, -1),
    ).join(''),
    indices: '000001000200',
    indexCount: 3,
  })

const loadGlb = async (file: string): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(file)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (g) => resolve(g.scene), reject)
  })
}

/** A hull art object carrying the three `ART_*` lines every consumer applies. */
const artObject = (): { ship: THREE.Group; art: THREE.Object3D } => {
  const ship = new THREE.Group()
  const art = new THREE.Object3D()
  art.position.copy(ART_POSITION)
  art.rotation.y = SHIP_MODEL_YAW
  art.scale.copy(ART_SCALE)
  ship.add(art)
  return { ship, art }
}

/** Vertices of one mesh, in whatever frame its matrixWorld says. */
const worldVertices = (mesh: THREE.Mesh): THREE.Vector3[] => {
  mesh.updateWorldMatrix(true, false)
  const p = mesh.geometry.getAttribute('position')
  const out: THREE.Vector3[] = []
  for (let i = 0; i < p.count; i++) {
    out.push(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(mesh.matrixWorld))
  }
  return out
}

interface Part {
  readonly centroid: THREE.Vector3
  /** Root-mean-square distance from the centroid: a SIZE no rotation changes. */
  readonly gyration: number
  /** Axis-aligned extent, in whatever frame the points were in. */
  readonly size: THREE.Vector3
}

const partOf = (pts: readonly THREE.Vector3[]): Part => {
  const centroid = new THREE.Vector3()
  for (const p of pts) centroid.add(p)
  centroid.divideScalar(pts.length)
  let s = 0
  for (const p of pts) s += p.distanceToSquared(centroid)
  const size = new THREE.Box3().setFromPoints(pts as THREE.Vector3[]).getSize(new THREE.Vector3())
  return { centroid, gyration: Math.sqrt(s / pts.length), size }
}

/** Split a mesh's (already transformed) vertices into its connected parts. */
const partsOf = (pts: readonly THREE.Vector3[], indices: ArrayLike<number>): Part[] => {
  const flat = new Float32Array(pts.length * 3)
  pts.forEach((p, i) => {
    flat.set([p.x, p.y, p.z], i * 3)
  })
  return connectedParts(flat, indices, 1e-4).map((q) =>
    partOf(q.map((v) => pts[v] as THREE.Vector3)),
  )
}

/** Pair every witness with its nearest part, and insist the pairing is one-to-one. */
const pair = (witnesses: readonly Part[], parts: readonly Part[]) => {
  const rows = witnesses.map((w) => {
    let best = -1
    let d = Infinity
    parts.forEach((p, i) => {
      const e = p.centroid.distanceTo(w.centroid)
      if (e < d) {
        d = e
        best = i
      }
    })
    return { witness: w, part: parts[best] as Part, index: best, distance: d }
  })
  return rows
}

const docByName = (prefab: Prefab, name: string): UnityDoc[] =>
  prefab.docs.filter((d) => d.classId === 1 && prefab.nameOf(d) === name)

const vec = (o: { x: unknown; y: unknown; z: unknown }): number[] => [
  Number(o.x),
  Number(o.y),
  Number(o.z),
]
const quat = (o: { x: unknown; y: unknown; z: unknown; w: unknown }): number[] => [
  Number(o.x),
  Number(o.y),
  Number(o.z),
  Number(o.w),
]
/** A transform's Unity TRS as `render/unity-space.ts` converts it: three space. */
const poseOf = (tf: UnityDoc): THREE.Matrix4 =>
  unityPose(vec(tf.data.m_LocalPosition), quat(tf.data.m_LocalRotation), vec(tf.data.m_LocalScale))

/** A Unity-space vertex array into three space, the one flip. */
const flipped = (position: Float32Array): THREE.Vector3[] => {
  const out: THREE.Vector3[] = []
  for (let i = 0; i < position.length; i += 3) {
    out.push(new THREE.Vector3(position[i], position[i + 1], -(position[i + 2] as number)))
  }
  return out
}

// ── A. The reader ────────────────────────────────────────────────────────

describe('reading a text-YAML Unity mesh, in both of 2016’s dialects', () => {
  it('decodes the Unity 5 layout — eight slots, colour as four bytes', () => {
    const parsed = parseMeshAsset(unity5Fixture())
    expect(parsed.dialect).toBe('unity5')
    expect(parsed.strides[0], 'stride summed from the live channels').toBe(28)
    const mesh = decodeMesh(parsed)
    expect(Array.from(mesh.position)).toEqual(TRI.flat())
    expect(Array.from(mesh.normal ?? [])).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1])
    expect(Array.from(mesh.color ?? [])).toEqual([10, 20, 30, 1, 11, 20, 30, 1, 12, 20, 30, 1])
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2])
  })

  it('decodes the Unity 4 layout — six slots, a PACKED colour, the tangent in slot 5', () => {
    // Under Unity 5's eight-slot table slot 5 is `uv2`, and a packed colour is
    // one byte wide: `tools/prototype/unity_mesh_to_obj.js` reads exactly that,
    // with no error. `Mesh1-Combined.asset` is this dialect.
    const parsed = parseMeshAsset(unity4Fixture())
    expect(parsed.dialect).toBe('unity4')
    expect(parsed.channels.map((c) => c.name)).toEqual(['position', 'normal', 'color', 'tangent'])
    const mesh = decodeMesh(parsed)
    expect(Array.from(mesh.color ?? [])).toEqual([
      200, 100, 50, 255, 200, 101, 50, 255, 200, 102, 50, 255,
    ])
    expect(Array.from(mesh.tangent ?? [])).toEqual([1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1])
    expect(Array.from(mesh.position)).toEqual(TRI.flat())
  })

  it('refuses a layout that does not account for every byte', () => {
    // The identity `stride x vertexCount = m_DataSize` is the check that the
    // channels were read right; a wrong stride cannot satisfy it.
    expect(() => parseMeshAsset(unity5Fixture(96))).toThrow(/m_DataSize/)
    expect(() => parseMeshAsset(unity4Fixture(48))).toThrow(/declares stride 48/)
  })

  it('welds a triangle soup by POSITION when it splits it into parts', () => {
    // A faceted mesh shares no index between two faces of one object — only a
    // position. Two triangles on one edge are one part; a third apart is not.
    const positions = [
      0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 5, 5, 5, 6, 5, 5, 5, 6, 5,
    ]
    const parts = connectedParts(positions, [0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(parts.map((p) => p.length)).toEqual([6, 3])
  })
})

// ── B. The 2016 files ─────────────────────────────────────────────────────

describe.skipIf(!haveLegacy)('the 2016 files, against the prefab’s own witnesses', () => {
  const COMBINED = 'Assets/Faceted Flight/Meshes/combined'

  it('counts: six projectors of Projector04’s own size, and TEN glow pieces, not six', () => {
    const projector = loadMeshAsset(legacyPath(PROJECTOR_ASSET)).parsed.vertexCount
    const m1 = loadMeshAsset(legacyPath(`${COMBINED}/Mesh1-Combined.asset`))
    const m2 = loadMeshAsset(legacyPath(`${COMBINED}/Mesh2-Combined.asset`))
    expect(m1.parsed.dialect, 'Mesh1 is the OLD dialect').toBe('unity4')
    expect(m2.parsed.dialect).toBe('unity5')
    expect(projector).toBe(936)
    expect(m1.parsed.vertexCount).toBe(6 * projector)
    const p1 = connectedParts(m1.mesh.position, m1.mesh.indices, 1e-4)
    expect(p1.map((q) => q.length)).toEqual(new Array(6).fill(projector))
    expect(m2.parsed.vertexCount).toBe(1806)
    expect(m2.mesh.indices.length).toBe(3480)
    // NEXT.md's #23-art row read 1,806 as "6 x a 301-vert part". It divides; it
    // is not what the file holds.
    const p2 = connectedParts(m2.mesh.position, m2.mesh.indices, 1e-4)
    expect(p2.length).toBe(10)
    expect(p2.reduce((n, q) => n + q.length, 0)).toBe(1806)
  })

  it('the ten glow pieces ARE GhostRacer’s ten glowyBits, to a few centimetres', () => {
    // `glowyBits` and the combined mesh's inner node share a frame, so a part's
    // centroid and a glowyBit's authored position are the same kind of number.
    const prefab = readPrefab(GHOST_RACER)
    const bits = docByName(prefab, 'glowyBit')
    expect(bits.length).toBe(10)
    const witnesses = bits.map((go) => {
      const tf = prefab.tfOf(go) as UnityDoc
      const p = vec(tf.data.m_LocalPosition)
      return partOf([new THREE.Vector3(p[0], p[1], p[2])])
    })
    const m2 = loadMeshAsset(legacyPath(`${COMBINED}/Mesh2-Combined.asset`))
    const parts = partsOf(
      Array.from(
        { length: m2.parsed.vertexCount },
        (_, v) =>
          new THREE.Vector3(
            m2.mesh.position[v * 3],
            m2.mesh.position[v * 3 + 1],
            m2.mesh.position[v * 3 + 2],
          ),
      ),
      m2.mesh.indices,
    )
    const rows = pair(witnesses, parts)
    expect(new Set(rows.map((r) => r.index)).size, 'one piece per glowyBit').toBe(10)
    const worst = Math.max(...rows.map((r) => r.distance))
    console.info(`glowyBit -> glow piece, worst ${worst.toFixed(4)} m`)
    // Each piece is 0.4-0.8 m across and the nearest two sit ~0.9 m apart, so
    // 6 cm is a match and not a coincidence.
    expect(worst).toBeLessThan(0.06)
  })

  it('the six projectors ARE the six loose Projector04s, place AND size — the asymmetric witness', () => {
    const prefab = readPrefab(GHOST_RACER)
    const loose = docByName(prefab, 'Projector04-Faceted')
    expect(loose.length).toBe(6)
    const proj = loadMeshAsset(legacyPath(PROJECTOR_ASSET)).mesh
    // In UNITY space: the loose projector's own TRS applied to the projector
    // mesh, against the combined mesh's parts in its own local frame.
    const witnesses = loose.map((go) => {
      const tf = prefab.tfOf(go) as UnityDoc
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(...vec(tf.data.m_LocalPosition)),
        new THREE.Quaternion(...quat(tf.data.m_LocalRotation)),
        new THREE.Vector3(...vec(tf.data.m_LocalScale)),
      )
      const pts: THREE.Vector3[] = []
      for (let i = 0; i < proj.position.length; i += 3) {
        pts.push(
          new THREE.Vector3(
            proj.position[i],
            proj.position[i + 1],
            proj.position[i + 2],
          ).applyMatrix4(m),
        )
      }
      return {
        part: partOf(pts),
        scale: Number(tf.data.m_LocalScale.x),
        z: Number(tf.data.m_LocalPosition.z),
      }
    })
    // The premise: the set IS asymmetric, or no test of a mirror can use it.
    const inboard = witnesses.filter((w) => Math.abs(Math.abs(w.z) - 1.3048) < 0.01)
    expect(inboard.length).toBe(2)
    const [a, b] = inboard as [(typeof witnesses)[0], (typeof witnesses)[0]]
    expect(
      Math.abs(a.scale - b.scale) / Math.max(a.scale, b.scale),
      'the inboard pair differ',
    ).toBeGreaterThan(0.05)

    const m1 = loadMeshAsset(legacyPath(`${COMBINED}/Mesh1-Combined.asset`))
    const parts = partsOf(
      Array.from(
        { length: m1.parsed.vertexCount },
        (_, v) =>
          new THREE.Vector3(
            m1.mesh.position[v * 3],
            m1.mesh.position[v * 3 + 1],
            m1.mesh.position[v * 3 + 2],
          ),
      ),
      m1.mesh.indices,
    )
    const rows = pair(
      witnesses.map((w) => w.part),
      parts,
    )
    expect(new Set(rows.map((r) => r.index)).size, 'one part per loose projector').toBe(6)
    for (const r of rows) {
      const ratio = r.part.gyration / r.witness.gyration
      console.info(
        `loose projector -> part: ${r.distance.toFixed(4)} m apart, size ratio ${ratio.toFixed(4)}`,
      )
      expect(r.distance).toBeLessThan(0.03)
      expect(Math.abs(ratio - 1)).toBeLessThan(0.02)
    }
  })

  it('the converter finds exactly the two combined meshes live, and skips the six loose parts', () => {
    const { renderers, skipped } = liveWingRenderers()
    expect(renderers.map((r) => r.mesh.split('/').pop()).sort()).toEqual([
      'Mesh1-Combined.asset',
      'Mesh2-Combined.asset',
    ])
    expect(skipped.filter((s) => s.endsWith('/Projector04-Faceted')).length).toBe(6)
  })

  it('the player prefab’s mirrored second wing is EMPTY — one wing, not a pair', () => {
    // The #23-art row said to place a second wing at Unity scale (1, 1, -1).
    // There is such a node on the player's ThirdPerson branch, and it has no
    // children: each combined mesh already spans both sides of the ship.
    const prefab = readPrefab('Assets/Faceted Flight/Resources/PlayerShip_SR14_Photon.prefab')
    const wings = docByName(prefab, 'anti-grav_rightWing').map((go) => prefab.tfOf(go) as UnityDoc)
    const mirrored = wings.filter((tf) => Number(tf.data.m_LocalScale.z) === -1)
    expect(mirrored.length).toBe(1)
    expect(prefab.children(mirrored[0] as UnityDoc)).toEqual([])
    const drawn = wings.filter((tf) => prefab.children(tf).length > 0)
    expect(drawn.length, 'the wings that carry meshes are all unmirrored').toBeGreaterThan(0)
    for (const tf of drawn) expect(Number(tf.data.m_LocalScale.z)).toBe(1)
  })
})

// ── C. The GLB ────────────────────────────────────────────────────────────

describe.skipIf(!haveWings)('hoverjet-wings.glb, as converted', () => {
  it('holds the two parts, whole, with the projectors’ colour and material record', async () => {
    const scene = await loadGlb(WINGS_GLB)
    const projectors = scene.getObjectByName('projectors') as THREE.Mesh
    const glow = scene.getObjectByName('glow') as THREE.Mesh
    expect(projectors.geometry.getAttribute('position').count).toBe(5616)
    expect(glow.geometry.getAttribute('position').count).toBe(1806)
    expect(glow.geometry.index?.count).toBe(3480)
    const colour = projectors.geometry.getAttribute('color')
    // VEC3: the Color32 alpha byte is 1/255 in this file (the trap in
    // `render/load-mesh.ts`), so it is not carried at all.
    expect(colour?.itemSize).toBe(3)
    const record = (projectors.material as THREE.Material).userData.unity
    expect(record.name).toBe('Projector04_Mat')
    expect(record.shader).toMatch(/Marmoset\/Shader\/VertexColor\//)
  })

  it('winds every triangle the way its normal faces — not inside out', async () => {
    // A mirror reverses winding (DEV-044). Measured per triangle, from the
    // positions, against the normals the file carries.
    const scene = await loadGlb(WINGS_GLB)
    for (const name of WING_PARTS) {
      const mesh = scene.getObjectByName(name) as THREE.Mesh
      const p = mesh.geometry.getAttribute('position')
      const n = mesh.geometry.getAttribute('normal')
      const index = mesh.geometry.index as THREE.BufferAttribute
      let worst = 1
      const [a, b, c, face] = [0, 0, 0, 0].map(() => new THREE.Vector3())
      for (let i = 0; i < index.count; i += 3) {
        const [ia, ib, ic] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)]
        ;(a as THREE.Vector3).fromBufferAttribute(p, ia)
        ;(b as THREE.Vector3).fromBufferAttribute(p, ib)
        ;(c as THREE.Vector3).fromBufferAttribute(p, ic)
        ;(face as THREE.Vector3)
          .subVectors(b as THREE.Vector3, a as THREE.Vector3)
          .cross(new THREE.Vector3().subVectors(c as THREE.Vector3, a as THREE.Vector3))
        if ((face as THREE.Vector3).lengthSq() < 1e-16) continue
        ;(face as THREE.Vector3).normalize()
        for (const v of [ia, ib, ic]) {
          worst = Math.min(
            worst,
            (face as THREE.Vector3).dot(new THREE.Vector3().fromBufferAttribute(n, v)),
          )
        }
      }
      expect(worst, `${name}: the least-agreeing face`).toBeGreaterThan(0.999)
    }
  })

  it('sits where DEV-310’s envelope put the glow — two compositions of one prefab agreeing', async () => {
    // `GLOW_ENVELOPE_2016` is `m_LocalAABB` pushed through the prefab chain by
    // DEV-310's own arithmetic, before this converter existed. Its x and z
    // faces are tight; its y is a rotated box's box and is loose (header).
    // What this catches is a wrong CHAIN or SCALE — a dropped outer node, the
    // inner rotation missed. What it cannot catch is a flip: the part is
    // symmetric across the ship, and its fore-aft range sits symmetric about the
    // art origin to 2 cm, so a half-turned GLB passes here. Measured, not
    // assumed; the tail test below is the one that sees it.
    const { ship, art } = artObject()
    const scene = await loadGlb(WINGS_GLB)
    attachHoverGlow(art, scene)
    ship.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromPoints(
      worldVertices(ship.getObjectByName(HOVER_GLOW_NAMES[1]) as THREE.Mesh),
    )
    console.info(
      `glow in the ship frame: min ${box.min.toArray().map((v) => v.toFixed(3))} max ${box.max.toArray().map((v) => v.toFixed(3))}`,
    )
    for (const [axis, k] of [
      ['x', 0],
      ['z', 2],
    ] as const) {
      expect(Math.abs(box.min[axis] - GLOW_ENVELOPE_2016.min[k]), `min ${axis}`).toBeLessThan(0.05)
      expect(Math.abs(box.max[axis] - GLOW_ENVELOPE_2016.max[k]), `max ${axis}`).toBeLessThan(0.05)
    }
    expect(box.min.y).toBeGreaterThan(GLOW_ENVELOPE_2016.min[1])
    expect(box.max.y).toBeLessThan(GLOW_ENVELOPE_2016.max[1])
    // The correction to DEV-310's "hangs 0.607 m below the belly": the part is
    // 1.39 m tall inside a 2.84 m envelope.
    expect(box.max.y - box.min.y, 'the real glow is not the envelope’s height').toBeLessThan(1.5)
  })

  it.skipIf(!haveLegacy)(
    'puts the SMALL inboard projector on the side the prefab does — the mirror test',
    async () => {
      // The expected parts are the loose projectors composed through the combined
      // mesh's own outer and inner nodes (their local frame IS the loose parts'
      // wing frame — measured above) by `unityPose`, the port's conversion. The
      // GLB's parts are measured as it arrives. A GLB converted without the z
      // negation puts the 0.1496 projector where the 0.1632 one should be: 1.8 cm
      // off in place, which a distance cannot see, and 9 % off in SIZE, which the
      // gyration ratio can.
      const prefab = readPrefab(GHOST_RACER)
      const proj = loadMeshAsset(legacyPath(PROJECTOR_ASSET)).mesh
      const { renderers } = liveWingRenderers(prefab)
      const outerInner = (() => {
        const r = renderers.find((x) => x.mesh.endsWith('/Mesh1-Combined.asset'))
        if (!r) throw new Error('no Mesh1-Combined')
        const inner = docByName(prefab, 'Mesh1-Combined').map((go) => prefab.tfOf(go) as UnityDoc)
        const outer = inner.find(
          (tf) =>
            prefab.parentOf(tf) &&
            prefab.nameOf(prefab.goOf(prefab.parentOf(tf) as UnityDoc)) === 'anti-grav_rightWing',
        )
        const leaf = inner.find((tf) => tf !== outer)
        return poseOf(outer as UnityDoc).multiply(poseOf(leaf as UnityDoc))
      })()
      const expected = docByName(prefab, 'Projector04-Faceted').map((go) => {
        const m = outerInner.clone().multiply(poseOf(prefab.tfOf(go) as UnityDoc))
        return partOf(flipped(proj.position).map((v) => v.applyMatrix4(m)))
      })
      const scene = await loadGlb(WINGS_GLB)
      const mesh = scene.getObjectByName('projectors') as THREE.Mesh
      const got = partsOf(worldVertices(mesh), (mesh.geometry.index as THREE.BufferAttribute).array)
      const rows = pair(expected, got)
      expect(new Set(rows.map((r) => r.index)).size).toBe(6)
      for (const r of rows) {
        const ratio = r.part.gyration / r.witness.gyration
        console.info(
          `projector: ${r.distance.toFixed(4)} m from the prefab's, size ratio ${ratio.toFixed(4)}`,
        )
        expect(r.distance).toBeLessThan(0.05)
        expect(
          Math.abs(ratio - 1),
          'the part is the SIZE the prefab says, on this side',
        ).toBeLessThan(0.03)
      }
    },
  )

  it.skipIf(!haveLegacy)('is exactly the bytes the converter makes today', () => {
    // `convert-wings.mjs --check` as a test: the file on disk is this tool's
    // output from the Unity project on this machine, not a stale or hand-made
    // copy. `pnpm assets:check` then holds the manifest's sha to these bytes.
    const { glb, report } = buildWings()
    expect(Buffer.compare(Buffer.from(glb), fs.readFileSync(WINGS_GLB))).toBe(0)
    expect(report.glowParts.length).toBe(10)
  })

  it('starts the racers’ trail at the centre engine’s glow — DEV-311’s emitter, met by the art', async () => {
    // DEV-311 composed the trail emitter off GhostRacer's `trails` node and
    // checked it against the aft FACE of DEV-310's envelope. The real part
    // answers what that face was: the centre engine's disc. Two nodes of one
    // prefab, composed by two different routes, meeting at the engine.
    const { ship, art } = artObject()
    attachHoverGlow(art, await loadGlb(WINGS_GLB))
    ship.updateWorldMatrix(true, true)
    const glow = ship.getObjectByName(HOVER_GLOW_NAMES[1]) as THREE.Mesh
    const pieces = partsOf(
      worldVertices(glow),
      (glow.geometry.index as THREE.BufferAttribute).array,
    )
    const emitter = trailEmitterOffset()
    const nearest = pieces.reduce((m, p) =>
      p.centroid.distanceTo(emitter) < m.centroid.distanceTo(emitter) ? p : m,
    )
    const aft = pieces.reduce((m, p) => (p.centroid.z > m.centroid.z ? p : m))
    console.info(
      `trail emitter ${nearest.centroid.distanceTo(emitter).toFixed(3)} m from a glow piece`,
    )
    expect(nearest, 'the piece the trail leaves from is the aft-most one').toBe(aft)
    // The next-nearest piece, a side engine, is over a metre away.
    expect(nearest.centroid.distanceTo(emitter)).toBeLessThan(0.1)
  })
})

describe.skipIf(!(haveWings && haveHull))('the wing against the real hull', () => {
  const hullVertices = async (): Promise<THREE.Vector3[]> => {
    const { ship, art } = artObject()
    art.add(await loadGlb(HULL_GLB))
    ship.updateWorldMatrix(true, true)
    const pts: THREE.Vector3[] = []
    art.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) pts.push(...worldVertices(n as THREE.Mesh))
    })
    return pts
  }
  const wingParts = async (): Promise<Record<string, THREE.Vector3[]>> => {
    const { ship, art } = artObject()
    attachHoverGlow(art, await loadGlb(WINGS_GLB))
    ship.updateWorldMatrix(true, true)
    return Object.fromEntries(
      HOVER_GLOW_NAMES.map((n) => [n, worldVertices(ship.getObjectByName(n) as THREE.Mesh)]),
    )
  }

  it('measures the hull to the extents quoted in hover-glow.ts', async () => {
    const box = new THREE.Box3().setFromPoints(await hullVertices())
    for (const [axis, k] of [
      ['x', 0],
      ['y', 1],
      ['z', 2],
    ] as const) {
      expect(box.min[axis], `hull min ${axis}`).toBeCloseTo(HULL_EXTENTS.min[k], 2)
      expect(box.max[axis], `hull max ${axis}`).toBeCloseTo(HULL_EXTENTS.max[k], 2)
    }
  })

  it('stays inside the hull’s silhouette and never below its lowest vertex', async () => {
    // DEV-310 read "0.607 m below the belly" off the envelope. The real part
    // hangs nowhere below the hull: the projectors are under the wings, the
    // glow is in them and in the engines.
    const hull = new THREE.Box3().setFromPoints(await hullVertices())
    const parts = await wingParts()
    for (const [name, pts] of Object.entries(parts)) {
      const box = new THREE.Box3().setFromPoints(pts)
      expect(box.min.y, `${name} bottom`).toBeGreaterThan(hull.min.y)
      expect(box.min.x, `${name} port`).toBeGreaterThan(hull.min.x)
      expect(box.max.x, `${name} starboard`).toBeLessThan(hull.max.x)
      expect(box.min.z, `${name} nose`).toBeGreaterThan(hull.min.z)
      expect(box.max.z, `${name} tail`).toBeLessThan(hull.max.z)
    }
  })

  it('puts an engine DISC in the tail and a round piece at the nose — the fore-aft test', async () => {
    // "spheres stuffed in the engines to glow". The aft-most glow piece is the
    // centre engine's disc — thin fore-aft, facing the chase camera — and
    // DEV-311's trail emitter leaves from it. The fore-most is a round piece
    // under the nose.
    //
    // This is the test that catches a FORE-AFT flip, and the envelope above
    // cannot: the part's fore-aft extent sits symmetric about the art origin to
    // 2 cm, so a half-turned GLB lands inside the same box (measured — DEV-322).
    // The SHAPES are not symmetric: flipped, the aft-most piece is the round
    // one, 0.58 m from the tail instead of 0.40.
    const hull = new THREE.Box3().setFromPoints(await hullVertices())
    const { ship, art } = artObject()
    attachHoverGlow(art, await loadGlb(WINGS_GLB))
    ship.updateWorldMatrix(true, true)
    const glow = ship.getObjectByName(HOVER_GLOW_NAMES[1]) as THREE.Mesh
    const pieces = partsOf(
      worldVertices(glow),
      (glow.geometry.index as THREE.BufferAttribute).array,
    )
    const aft = pieces.reduce((m, p) => (p.centroid.z > m.centroid.z ? p : m))
    const fore = pieces.reduce((m, p) => (p.centroid.z < m.centroid.z ? p : m))
    console.info(
      `aft piece ${aft.size.toArray().map((v) => v.toFixed(3))} at z ${aft.centroid.z.toFixed(3)}; fore piece ${fore.size.toArray().map((v) => v.toFixed(3))}`,
    )
    expect(Math.abs(aft.centroid.x), 'on the centreline').toBeLessThan(0.05)
    expect(hull.max.z - aft.centroid.z, 'in the tail').toBeLessThan(0.5)
    expect(aft.size.z / aft.size.x, 'a DISC facing aft, not a ball').toBeLessThan(0.5)
    expect(fore.size.z / fore.size.x, 'the nose piece is round').toBeGreaterThan(0.8)
  })
})

// ── DEV-358: the wing TIPS, off the shipped hull ─────────────────────────
//
// `render/wing-trails.ts`'s rule, run on the real GLB through the same three
// `ART_*` lines every consumer applies. The numbers are the ones its header,
// the preset note and the DEVIATIONS row quote; the other assertions are
// relationships to things measured some OTHER way (trap 24): the art's own
// centreline offset, the hull's extents, and DEV-311's engine emitter.
describe.skipIf(!haveHull)('DEV-358: the wing tips, off the real hull', () => {
  const tipsAndHull = async () => {
    const { art } = artObject()
    art.add(await loadGlb(HULL_GLB))
    const tips = measureWingTips(art)
    const pts: THREE.Vector3[] = []
    art.updateWorldMatrix(true, true)
    art.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) pts.push(...worldVertices(n as THREE.Mesh))
    })
    return { ...tips, pts }
  }

  it('leaves from the trailing corner of each tip chord, where the quoted numbers say', async () => {
    const { port, starboard } = await tipsAndHull()
    console.info(
      `wing tips: port ${port.toArray().map((v) => v.toFixed(3))} starboard ${starboard.toArray().map((v) => v.toFixed(3))}`,
    )
    expect(port.x).toBeCloseTo(-2.719, 2)
    expect(port.y).toBeCloseTo(-0.222, 2)
    expect(port.z).toBeCloseTo(2.048, 2)
    expect(starboard.x).toBeCloseTo(2.707, 2)
    expect(starboard.y).toBeCloseTo(-0.222, 2)
    expect(starboard.z).toBeCloseTo(2.048, 2)
  })

  it('is one symmetric pair, centred on the ART offset rather than on zero', async () => {
    // The midpoint lands on `ART_POSITION.x` (-0.006), the art's own offset off
    // the ship's centreline: reached by a different road, and a pair that were
    // not the same feature on both wings would not find it.
    const { port, starboard } = await tipsAndHull()
    expect(port.y).toBeCloseTo(starboard.y, 4)
    expect(port.z).toBeCloseTo(starboard.z, 4)
    expect((port.x + starboard.x) / 2).toBeCloseTo(ART_POSITION.x, 3)
  })

  it('are TIPS: out at the span, aft of the outermost vertex, on the engine side', async () => {
    const { port, starboard, pts } = await tipsAndHull()
    const halfSpan = (HULL_EXTENTS.max[0] - HULL_EXTENTS.min[0]) / 2
    for (const [tip, sign] of [
      [port, -1],
      [starboard, 1],
    ] as const) {
      expect(Math.abs(tip.x - ART_POSITION.x) / halfSpan).toBeGreaterThan(0.9)
      const outermost = pts.reduce((m, p) => (p.x * sign > m.x * sign ? p : m))
      // The chord runs AFT from the outermost vertex, and aft is where DEV-311
      // composed the engine emitter independently: the same side of the tip.
      const emitter = trailEmitterOffset()
      expect(Math.sign(tip.z - outermost.z)).toBe(Math.sign(emitter.z - outermost.z))
      expect(tip.z - outermost.z).toBeGreaterThan(0.5)
      expect(tip.z).toBeLessThan(HULL_EXTENTS.max[2])
    }
  })
})

// The loud counterpart, ONE for all four guards: on a machine with the Unity
// project and both GLBs it is the only skip in this file, and anywhere else it
// runs and says why the halves above did not. (One rather than one per guard
// keeps the file's skip count at the single counterpart DEV-310's version had,
// so a hydrated tree's suite-wide skip total does not move. DEV-358's guard is
// `haveHull` alone, which `haveEverything` already contains.)
const haveEverything = haveLegacy && haveWings && haveHull
describe.skipIf(haveEverything)('the guarded halves of this file', () => {
  it('are skipped only because the Unity project or a gitignored GLB is absent', () => {
    expect(haveEverything).toBe(false)
  })
})

// ── D. Hanging it on a hull (no GLB needed) ───────────────────────────────

/** A stand-in for the loaded GLB: the two named meshes, as `convert-wings` writes them. */
const fakeWings = (): THREE.Group => {
  const root = new THREE.Group()
  const record = {
    name: 'Projector04_Mat',
    shader: 'Assets/Marmoset/Shader/VertexColor/Marmoset Specular IBL.shader',
    colorSrgb: [0.9264706, 0.9264706, 0.9264706],
    shininess: 4,
    specInt: 0.25,
  }
  for (const name of WING_PARTS) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([1, 2, 3, 1, 2, 4, 1, 3, 3], 3),
    )
    const material = new THREE.MeshStandardMaterial()
    if (name === 'projectors') material.userData.unity = record
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = name
    root.add(mesh)
  }
  return root
}

describe('hanging the wing on a hull', () => {
  it('adds it to the art AT IDENTITY, so the hull’s own transform carries it', () => {
    // The GLB is in the hull GLB's frame, so a vertex at p must land where the
    // hull's own vertex at p would: art.matrixWorld x p. DEV-310's version
    // needed an inverse-matrix group here; this must need nothing.
    const { ship, art } = artObject()
    const glow = attachHoverGlow(art, fakeWings())
    ship.updateWorldMatrix(true, true)
    expect(glow.object.parent).toBe(art)
    const mesh = ship.getObjectByName(HOVER_GLOW_NAMES[0]) as THREE.Mesh
    const got = worldVertices(mesh)[0] as THREE.Vector3
    const want = new THREE.Vector3(1, 2, 3).applyMatrix4(art.matrixWorld)
    expect(got.distanceTo(want)).toBeLessThan(1e-9)
    glow.dispose()
  })

  it('is hidden with the hull, because it is a CHILD of the hull’s art', () => {
    const art = new THREE.Object3D()
    const glow = attachHoverGlow(art, fakeWings())
    art.visible = false
    let seen = false
    art.traverseVisible((node) => {
      if (node === glow.object) seen = true
    })
    expect(seen, 'an invisible hull draws no wing').toBe(false)
    glow.dispose()
  })

  it('paints the glow with the SHEET’s stud colours, not a typed-in cyan', () => {
    // `glowyMaterial.mat` is the gate stud material byte for byte, and the
    // trail's colour is pinned to it in `ghost-trail.test.ts` (DEV-069: a
    // generated constant nothing reads is documentation, not a guard).
    const glow = attachHoverGlow(new THREE.Object3D(), fakeWings())
    const material = (glow.object.getObjectByName(HOVER_GLOW_NAMES[1]) as THREE.Mesh)
      .material as THREE.MeshStandardMaterial
    const ring = PROPS.checkpointRing
    const lin = (c: readonly number[]) =>
      new THREE.Color(
        srgbToLinear(c[0] as number),
        srgbToLinear(c[1] as number),
        srgbToLinear(c[2] as number),
      )
    expect(material.color.getHex()).toBe(lin(ring.studColor).getHex())
    expect(material.emissive.getHex()).toBe(lin(ring.studGlowColor).getHex())
    expect(material.emissiveIntensity).toBe(ring.studGlowStrength)
    // Opaque, for the reason `rings.ts` gives: no `_ALPHABLEND_ON`.
    expect(material.transparent).toBe(false)
    expect(PROPS.ghostTrail.color).toEqual(ring.studColor)
    glow.dispose()
  })

  it('paints the projectors with Projector04_Mat, from the record the GLB carries', () => {
    const glow = attachHoverGlow(new THREE.Object3D(), fakeWings())
    const material = (glow.object.getObjectByName(HOVER_GLOW_NAMES[0]) as THREE.Mesh)
      .material as THREE.MeshStandardMaterial
    expect(material.vertexColors, 'Marmoset VERTEX COLOR: the colour is in the mesh').toBe(true)
    // Back to the `.mat`'s own sRGB number, so this is against Unity's file and
    // not our arithmetic twice (lambert1's precedent).
    const srgb = material.color.clone().convertLinearToSRGB()
    expect(srgb.r).toBeCloseTo(0.9264706, 5)
    expect(material.roughness).toBe(
      shininessToRoughness('Assets/Marmoset/Shader/VertexColor/Marmoset Specular IBL.shader', 4),
    )
    expect(material.metalness).toBe(0)
    glow.dispose()
  })

  it('wears the hull’s hologram on a ghost or a racer, and never disposes the caller’s material', () => {
    const holo = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.72 })
    let disposed = false
    holo.addEventListener('dispose', () => {
      disposed = true
    })
    const glow = attachHoverGlow(new THREE.Object3D(), fakeWings(), { projectorMaterial: holo })
    const projectors = glow.object.getObjectByName(HOVER_GLOW_NAMES[0]) as THREE.Mesh
    const lit = glow.object.getObjectByName(HOVER_GLOW_NAMES[1]) as THREE.Mesh
    expect(projectors.material).toBe(holo)
    expect((lit.material as THREE.MeshStandardMaterial).name, 'the glow keeps its own').toBe(
      'hover-glow',
    )
    glow.dispose()
    expect(disposed).toBe(false)
  })

  it('refuses to guess the projectors’ material when the GLB carried no record', () => {
    expect(() => projectorMaterial(new THREE.MeshStandardMaterial())).toThrow(/Projector04_Mat/)
  })

  it('flies without the wing when the fetch failed — a missing part, not a broken mission', () => {
    const art = new THREE.Object3D()
    const glow = attachHoverGlow(art, null)
    expect(glow.object.children.length).toBe(0)
    expect(glow.object.parent).toBe(art)
    glow.dispose()
    expect(art.children.length).toBe(0)
  })

  it('asks for the file the manifest hashes, and the manifest classes it LICENSED', () => {
    // DEV-266's lesson in the form an asset takes: ONE exported name, and the
    // manifest row `pnpm assets:check` verifies has to be for that exact path —
    // or the check hashes a file the game never loads.
    const manifest = JSON.parse(fs.readFileSync('tools/assets/required-assets.json', 'utf8')) as {
      assets: { path: string; sha256?: string; licence: string }[]
    }
    const row = manifest.assets.find((a) => a.path === SHIP_MESH_WINGS)
    expect(row, `${SHIP_MESH_WINGS} is in required-assets.json`).toBeDefined()
    expect(row?.sha256).toMatch(/^[0-9a-f]{64}$/)
    // Bought geometry, Matt's kitbash: ships from R2, never in git (hard rule 7).
    expect(row?.licence).toBe('LICENSED')
  })
})
