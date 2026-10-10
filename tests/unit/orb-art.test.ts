// tests/unit/orb-art.test.ts — 2016's energy orb, ported (DEV-327).
//
// Orientation bugs are a class here and a ball is the most bug-friendly shape
// there is, so nothing below asserts a rotation. Every claim is a COUNT, a
// DISTANCE or a COLOUR, against something authored apart from the code:
//
//   * the SHEET against the prefab and the .mat, as `tools/extract` read them —
//     including the receipt that the parser reads the old dialect as absence;
//   * the MATERIAL against the sheet, through three's own sRGB conversion,
//     which is not the route the code takes;
//   * the GLB against the FBX it came from: a truncated icosahedron (twelve
//     pentagons, twenty hexagons), every corner 1 m from the centre, every
//     face wound outward — the three ways a conversion goes wrong (a stand-in
//     mesh, a unit or node scale, the mirror's winding) each have a test;
//   * the MIRROR, which cannot be seen on this mesh, and the reason is a
//     measured property rather than a belief: the vertex set is centrally
//     symmetric, so negating x is a half-turn of the same ball.
//
// The GLB is gitignored, so its half is guarded with the disk work inside each
// `it`, and has a loud counterpart.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachOrbArt,
  loadOrbs,
  ORB_ART_NAME,
  ORB_MESH,
  ORB_MESH_NODE,
  ORB_MESH_RADIUS,
  ORB_STAND_IN_NAME,
  orbArtGeometry,
  orbMaterial,
  orbStandInGeometry,
} from '@/game/orb-art'
import { ORB_COLLECT_RADIUS } from '@/game/orbs'
import { bakedGeometry } from '@/game/rings'
import { PROPS } from '@/generated/constants.generated'
import type { LoadedMesh } from '@/render/load-mesh'
import { orbMarkGeometry } from '@/render/mode-mark'
import { levelJson as level } from './helpers/content'
import { REPO as ROOT } from './helpers/repo-root'

const GLB = path.join(ROOT, 'public', ORB_MESH)
const haveOrb = fs.existsSync(GLB)
const ORB = PROPS.energyOrb

/** Parse the GLB straight out of the file, so no server or fetch is involved. */
const parse = async (): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(GLB)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

/** Every vertex's distance from the origin — the ball's centre in every frame used here. */
const radii = (geometry: THREE.BufferGeometry): number[] => {
  const p = geometry.getAttribute('position')
  return Array.from({ length: p.count }, (_, i) => Math.hypot(p.getX(i), p.getY(i), p.getZ(i)))
}

/** Triangles as corner positions, index or not. */
const triangles = (geometry: THREE.BufferGeometry): THREE.Vector3[][] => {
  const p = geometry.getAttribute('position')
  const index = geometry.getIndex()
  const n = index ? index.count : p.count
  const out: THREE.Vector3[][] = []
  for (let t = 0; t < n; t += 3) {
    out.push(
      [0, 1, 2].map((k) => {
        const i = index ? index.getX(t + k) : t + k
        return new THREE.Vector3().fromBufferAttribute(p, i)
      }),
    )
  }
  return out
}

/** A stand-in for the loaded GLB: a unit ball under a node transform, as glTF carries one. */
const fakeGlb = (nodeScale: number): THREE.Group => {
  const root = new THREE.Group()
  const node = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial())
  node.scale.setScalar(nodeScale)
  node.rotation.set(Math.PI / 2, 0, 0)
  root.add(node)
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
})

/* ═══════════════════════ A. the sheet (no disk needed) ═════════════════════ */

describe('the sheet carries 2016’s orb (props.energyOrb)', () => {
  it('names the mesh the prefab draws, and no shipped scene overrides its art', () => {
    // `EnergyOrb.prefab` -> `sphere_fancy_lod_01` -> MeshFilter mesh 4300000,
    // which the .fbx.meta names `pSolid2`: the file's only mesh. Hard rule 2
    // for a prefab interior is the scene sweep — 181 instances, and not one
    // modification touches the art's GameObject, Transform, filter, renderer
    // or Halo.
    expect(ORB.art.mesh).toBe('Assets/Faceted Flight/Meshes/sphere_fancy_lod_01.fbx')
    expect(ORB.art.meshFileId).toBe('4300000')
    expect(ORB.art.meshNode).toBe('pSolid2')
    expect(ORB.art.material).toBe('Assets/Faceted Flight/energy_orb.mat')
    expect(ORB.art.live).toBe(true)
    expect(ORB.sceneInstances).toBeGreaterThan(100)
    expect(ORB.sceneArtOverrides).toHaveLength(0)
    // Eight missions restate the trigger's radius, and every one says 3.
    expect(ORB.sceneTriggerRadii).toEqual([3])
  })

  it('reads energy_orb.mat through the OLD dialect, which the parser reads as absence', () => {
    // DEV-043's trap on one more file. The raw text says
    // `_Color {r: .742697775, g: 1, b: .566176474, a: .843137264}`,
    // `_GlowColor {r: .741176486, g: 1, b: .564705908, a: 1}`, `_GlowStrength .629999995`.
    expect(ORB.materialDialect).toBe('old')
    expect(ORB.parserSawColour, 'the receipt: the YAML parser alone sees no colour').toBe(false)
    expect(ORB.color).toEqual([0.742698, 1, 0.566176, 0.843137])
    expect(ORB.glowColor).toEqual([0.741176, 1, 0.564706, 1])
    expect(ORB.glowStrength).toBe(0.63)
    // `Marmoset/Self-Illumin/Diffuse IBL` is Opaque and carries no blend
    // keyword, so the 0.843 alpha never reached a framebuffer.
    expect(ORB.shaderRenderType).toBe('Opaque')
    expect(ORB.blends).toBe(false)
  })

  it('collects at the radius it always did — now read off the sheet', () => {
    // `game/orbs.ts` typed `3 * 1.6284006` while the prefab interior was not
    // in the sheet. The product must not move by a bit now that it is.
    expect(ORB_COLLECT_RADIUS).toBe(3 * 1.6284006)
    expect(ORB_COLLECT_RADIUS).toBeCloseTo(4.885, 3)
  })
})

/* ════════════════ B. the material the world wears (no disk) ═══════════════ */

describe('energy_orb.mat, as the world wears it', () => {
  it('is the sheet’s colour and glow, in linear, and opaque on one side', () => {
    const m = orbMaterial()
    const srgb = (c: readonly number[]) =>
      new THREE.Color().setRGB(c[0] as number, c[1] as number, c[2] as number, THREE.SRGBColorSpace)
    const colour = srgb(ORB.color)
    const glow = srgb(ORB.glowColor)
    expect(m.color.r).toBeCloseTo(colour.r, 6)
    expect(m.color.g).toBeCloseTo(colour.g, 6)
    expect(m.color.b).toBeCloseTo(colour.b, 6)
    expect(m.emissive.r).toBeCloseTo(glow.r, 6)
    expect(m.emissive.g).toBeCloseTo(glow.g, 6)
    expect(m.emissive.b).toBeCloseTo(glow.b, 6)
    expect(m.emissiveIntensity).toBe(ORB.glowStrength)
    expect(m.transparent).toBe(false)
    expect(m.opacity).toBe(1)
    // Diffuse IBL: no specular term in the shader at all.
    expect(m.roughness).toBe(1)
    expect(m.metalness).toBe(0)
    // The GLB is wound outward (section E), so it needs only its front.
    expect(m.side).toBe(THREE.FrontSide)
    m.dispose()
  })
})

/* ════════════════ C. the art, posed as the prefab poses it ════════════════ */

describe('the orb’s art, posed as EnergyOrb.prefab poses it', () => {
  it('keeps the glTF node’s own transform and adds the prefab’s 1.6284', () => {
    // A dropped node transform would draw this ball 1.6284 across; a dropped
    // prefab pose, 2. Only both give 2 x 1.6284.
    const geometry = orbArtGeometry(fakeGlb(2)) as THREE.BufferGeometry
    expect(Math.max(...radii(geometry))).toBeCloseTo(2 * 1.6284006, 5)
    expect(geometry.name).toBe(ORB_ART_NAME)
    expect(geometry.getAttribute('uv')).toBeUndefined()
  })

  it('has a stand-in exactly the size of the ball it stands in for', () => {
    const geometry = orbStandInGeometry()
    expect(Math.max(...radii(geometry))).toBeCloseTo(ORB_MESH_RADIUS * 1.6284006, 5)
    expect(geometry.name).toBe(ORB_STAND_IN_NAME)
  })
})

/* ════════════ D. a failed fetch is a stand-in, not a missing orb ══════════ */

describe('fetching the orb (attachOrbArt)', () => {
  const L = level('hoverJet_kauai_beg')

  it('warns ONCE, naming the file, and flies the stand-in — it does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const orbs = loadOrbs(L)
    await attachOrbArt(orbs, () => Promise.reject(new Error('404')))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain(ORB_MESH)
    expect(orbs.art).toBe('stand-in')
    const mesh = orbs.object.getObjectByName(ORB_MESH_NODE) as THREE.InstancedMesh
    expect(mesh.count).toBe(11)
    expect(mesh.geometry.name).toBe(ORB_STAND_IN_NAME)
    orbs.dispose()
  })

  it('hangs the fetched art on, and frees the load it copied from', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const orbs = loadOrbs(L)
    let freed = 0
    const loaded: LoadedMesh = {
      object: fakeGlb(1),
      meshCount: 1,
      vertexCount: 0,
      dispose: () => {
        freed++
      },
    }
    await attachOrbArt(orbs, () => Promise.resolve(loaded))
    expect(warn).not.toHaveBeenCalled()
    expect(orbs.art).toBe('energy-orb')
    expect(freed).toBe(1)
    orbs.dispose()
  })

  it('does nothing to a mission that was swapped out before the fetch landed', async () => {
    const orbs = loadOrbs(L)
    orbs.dispose()
    await attachOrbArt(orbs, () =>
      Promise.resolve({ object: fakeGlb(1), meshCount: 1, vertexCount: 0, dispose() {} }),
    )
    expect(orbs.art).toBeNull()
    expect(orbs.object.children).toHaveLength(0)
  })
})

/* ═══════════════════ E. energy-orb.glb, as converted ══════════════════════ */

describe.skipIf(!haveOrb)('energy-orb.glb is sphere_fancy_lod_01', () => {
  it('is ONE mesh of 116 triangles on 60 corners: 12 pentagons and 20 hexagons', async () => {
    // Not an icosphere and not somebody else's ball. A face is the triangles
    // sharing a normal; a truncated icosahedron fans each pentagon into 3 and
    // each hexagon into 4.
    const root = await parse()
    let meshes = 0
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++
    })
    expect(meshes).toBe(1)
    const geometry = bakedGeometry(root) as THREE.BufferGeometry
    const tris = triangles(geometry)
    expect(tris).toHaveLength(116)
    const corners: THREE.Vector3[] = []
    for (const t of tris) {
      for (const v of t) if (!corners.some((c) => c.distanceTo(v) < 1e-5)) corners.push(v)
    }
    expect(corners).toHaveLength(60)
    const faces = new Map<string, number>()
    for (const [a, b, c] of tris as [THREE.Vector3, THREE.Vector3, THREE.Vector3][]) {
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a))
      n.normalize()
      const key = `${n.x.toFixed(3)},${n.y.toFixed(3)},${n.z.toFixed(3)}`
      faces.set(key, (faces.get(key) ?? 0) + 1)
    }
    const sizes = [...faces.values()]
    expect(sizes).toHaveLength(32)
    expect(sizes.filter((s) => s === 3)).toHaveLength(12)
    expect(sizes.filter((s) => s === 4)).toHaveLength(20)
  })

  it('is in METRES: every corner 1 m from the centre, the node scale dropped', async () => {
    // The two scale traps, both measured: a baked centimetre compensation puts
    // every corner at 0.01, and baking the FBX node's own Lcl Scaling (15.2987,
    // which the prefab never sees — it references the MESH) puts them at 15.3.
    const geometry = bakedGeometry(await parse()) as THREE.BufferGeometry
    const r = radii(geometry)
    expect(Math.min(...r)).toBeCloseTo(ORB_MESH_RADIUS, 4)
    expect(Math.max(...r)).toBeCloseTo(ORB_MESH_RADIUS, 4)
  })

  it('is wound OUTWARD, and its normals agree — the first mesh out of this converter that is', async () => {
    // `unmirror_x` used to flip every face inward after Blender's own flip.
    // Every triangle's front must face away from the centre, and the stored
    // normal must say the same.
    const geometry = bakedGeometry(await parse()) as THREE.BufferGeometry
    const normals = geometry.getAttribute('normal')
    const index = geometry.getIndex()
    let outward = 0
    let agree = 0
    let volume = 0
    const tris = triangles(geometry)
    tris.forEach(([a, b, c], t) => {
      const A = a as THREE.Vector3
      const B = b as THREE.Vector3
      const C = c as THREE.Vector3
      const n = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A))
      const centroid = A.clone().add(B).add(C).divideScalar(3)
      if (n.dot(centroid) > 0) outward++
      const i = index ? index.getX(t * 3) : t * 3
      if (new THREE.Vector3().fromBufferAttribute(normals, i).dot(n) > 0) agree++
      volume += A.dot(new THREE.Vector3().crossVectors(B, C)) / 6
    })
    expect(outward).toBe(tris.length)
    expect(agree).toBe(tris.length)
    // A closed ball: the signed volume is the solid's, a little under 4/3 pi.
    expect(volume).toBeGreaterThan(3.5)
    expect(volume).toBeLessThan((4 / 3) * Math.PI)
  })

  it('is centrally symmetric — so the x mirror is a half-turn of the same ball', async () => {
    // Why the mirror cannot matter on this mesh, as a measurement: every corner
    // has its opposite, so negating x is a half-turn about x followed by the
    // inversion that maps the ball onto itself. And the premise that the
    // mirror MOVES corners at all — this orientation is not mirror-symmetric in
    // x — so the claim is not vacuous.
    const geometry = bakedGeometry(await parse()) as THREE.BufferGeometry
    const p = geometry.getAttribute('position')
    const corners = Array.from({ length: p.count }, (_, i) =>
      new THREE.Vector3().fromBufferAttribute(p, i),
    )
    const has = (q: THREE.Vector3) => corners.some((c) => c.distanceTo(q) < 1e-5)
    expect(corners.every((c) => has(c.clone().negate()))).toBe(true)
    expect(corners.every((c) => has(new THREE.Vector3(-c.x, c.y, c.z)))).toBe(false)
  })

  it('stands 1.6284 m in the world, reaches exactly 1 on the table, and flies as the art', async () => {
    const root = await parse()
    const world = orbArtGeometry(root) as THREE.BufferGeometry
    expect(Math.max(...radii(world))).toBeCloseTo(1.6284006, 4)
    expect(Math.min(...radii(world))).toBeCloseTo(1.6284, 3)
    const mark = orbMarkGeometry(root) as THREE.BufferGeometry
    expect(Math.max(...radii(mark))).toBeCloseTo(1, 6)
    const orbs = loadOrbs(level('hoverJet_kauai_beg'))
    orbs.setArt(root)
    expect(orbs.art).toBe('energy-orb')
    const mesh = orbs.object.getObjectByName(ORB_MESH_NODE) as THREE.InstancedMesh
    expect(mesh.geometry.name).toBe(ORB_ART_NAME)
    expect(triangles(mesh.geometry)).toHaveLength(116)
    orbs.dispose()
  })
})

describe.skipIf(haveOrb)('energy-orb.glb — not hydrated', () => {
  it('is skipped loudly rather than passing vacuously', () => {
    expect(haveOrb).toBe(false)
  })
})
