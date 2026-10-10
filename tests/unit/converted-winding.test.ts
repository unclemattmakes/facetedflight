// tests/unit/converted-winding.test.ts — every GLB `convert-fbx.py` makes is
// wound OUTWARD. DEV-328.
//
// ── The bug this exists to not have again ─────────────────────────────────
//
// From 2026-09-10 until DEV-327/328, every mesh through `convert()` shipped
// INSIDE-OUT: Blender 5.1's negative-scale `transform_apply` already reverses
// the winding, and `unmirror_x` reversed it again with `flip_normals()`. The
// stored normals were flipped with the faces, so they agreed with the wrong
// winding, and every GLB carries glTF `doubleSided: true`, so three drew the
// back faces and flipped their normals — and the gate, the turn indicator,
// both hulls and the logo looked right for two weeks. Where it did NOT look
// right nobody noticed: `title.ts` and `medal.ts` draw the logo `FrontSide`,
// so the title screen and every hangar medal were showing the logo's FAR
// faces, and the medal's inverted-hull outline (`BackSide`) its near ones.
// Nothing in this suite read the winding: every test that loads these files
// passed the same cases on the old bytes and the new.
//
// ── What is asserted, and why it is not the converter's own arithmetic ────
//
// A closed surface wound outward has positive signed volume
// (Σ A·(B×C)/6 over its triangles) — a property of the surface, not of how
// the converter reasons about mirrors. The FBX files are wound that way as
// authored (measured in Blender on import, DEV-328: 9.864, 41.713, 7.735,
// 3.439 / 50.395 / 8.003, 11.238, the same magnitudes these files hold), so a
// file that keeps its source's side is positive and one that turned over is
// negative by exactly as much. Some of these meshes are open (the cockpit, the
// gate, the hulls have boundary edges), which makes the volume depend a little
// on where the origin is; every one of them sits at least 0.15 m³ clear of
// zero, which no plausible re-centring moves.
//
// And the stored normals must agree with the winding in aggregate — the
// area-weighted sum of (stored normal · face normal) is positive. That is the
// half the old files got right while being wrong, so on its own it proves
// nothing; together with the volume it says the faces AND the shading both
// point out. It is an aggregate rather than per-triangle because 2016 authored
// odd normals on a handful of corners (the JumpSeat's seat has one triangle
// whose normals oppose its face, as the FBX has it).
//
// The job list is read out of `convert-fbx.py` itself, so a new job is covered
// the day it is added and this file never holds a count of its own.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'

const CONVERTER = fs.readFileSync('tools/assets/convert-fbx.py', 'utf8')
const MANIFEST = JSON.parse(fs.readFileSync('tools/assets/required-assets.json', 'utf8')) as {
  assets: { id: string; path: string }[]
}

/** `"stem": ("ship_as", ...` inside `TABLE = { ... }` — the converter's job tables. */
const jobsIn = (table: string): string[] => {
  const start = CONVERTER.indexOf(`\n${table} = {`)
  if (start < 0) return []
  const end = CONVERTER.indexOf('\n}', start)
  const body = CONVERTER.slice(start, end)
  return [...body.matchAll(/^\s*"[^"]+":\s*\(\s*"([^"]+)"/gm)].map((m) => m[1] as string)
}

const TABLES = ['JOBS', 'MESH_JOBS', 'ASSEMBLY_JOBS'] as const
const SHIPPED = TABLES.flatMap(jobsIn)

/** The manifest row each job's output ships as, found by file name. */
const pathOf = (shipAs: string): string | undefined =>
  MANIFEST.assets.find((a) => a.path.endsWith(`/${shipAs}.glb`))?.path

describe('the converter job tables, as this file reads them', () => {
  it('finds jobs in all three tables', () => {
    // If the table syntax changes and the regex stops matching, the guarded
    // block below would sweep nothing and pass. This is what stops that.
    for (const table of TABLES) expect(jobsIn(table), table).not.toHaveLength(0)
  })

  it('has a manifest row for every job it ships', () => {
    for (const shipAs of SHIPPED) expect(pathOf(shipAs), shipAs).toBeDefined()
  })
})

const FILES = SHIPPED.map((shipAs) => ({ shipAs, file: `public/${pathOf(shipAs) ?? ''}` }))
// `public/assets/**` is gitignored (CLAUDE.md hard rule 7), so CI has none of
// these. Only the existence check runs at collection; the reading is in `it`.
const AVAILABLE = FILES.every(({ file }) => fs.existsSync(file))

const parse = async (file: string): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(file)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

/** Per mesh, in the file's own scene frame: signed volume and normal agreement. */
const winding = (root: THREE.Object3D) => {
  root.updateMatrixWorld(true)
  const out: { name: string; volume: number; agreement: number }[] = []
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const geometry = mesh.geometry
    const pos = geometry.getAttribute('position')
    const nor = geometry.getAttribute('normal')
    const index = geometry.getIndex()
    const count = index ? index.count : pos.count
    const at = (k: number) => (index ? index.getX(k) : k)
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)
    const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
    const n = new THREE.Vector3()
    const face = new THREE.Vector3()
    const e1 = new THREE.Vector3()
    const e2 = new THREE.Vector3()
    let volume = 0
    let agreement = 0
    for (let t = 0; t < count; t += 3) {
      n.set(0, 0, 0)
      for (let c = 0; c < 3; c++) {
        const v = at(t + c)
        p[c]?.fromBufferAttribute(pos, v).applyMatrix4(mesh.matrixWorld)
        n.add(new THREE.Vector3().fromBufferAttribute(nor, v).applyMatrix3(normalMatrix))
      }
      const [a, b, c] = p as [THREE.Vector3, THREE.Vector3, THREE.Vector3]
      volume += a.dot(new THREE.Vector3().crossVectors(b, c)) / 6
      face.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a))
      agreement += face.dot(n.normalize())
    }
    out.push({ name: mesh.name, volume, agreement })
  })
  return out
}

describe.skipIf(!AVAILABLE)('every converted GLB is wound outward', () => {
  it.each(FILES)('$shipAs', async ({ file }) => {
    const meshes = winding(await parse(file))
    expect(meshes.length).toBeGreaterThan(0)
    for (const m of meshes) {
      expect(m.volume, `${m.name}: signed volume`).toBeGreaterThan(0.1)
      expect(m.agreement, `${m.name}: stored normals against the winding`).toBeGreaterThan(0)
    }
  })

  it('would FAIL on a file wound the other way — the state five of them shipped in', async () => {
    // The other half of the claim: the same measurement on the same bytes with
    // every triangle reversed must come out negative, or the test above is not
    // measuring winding at all.
    const root = await parse(FILES[0]?.file ?? '')
    root.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      const index = mesh.geometry.getIndex()
      if (!index) return
      for (let t = 0; t < index.count; t += 3) {
        const b = index.getX(t + 1)
        index.setX(t + 1, index.getX(t + 2))
        index.setX(t + 2, b)
      }
      const nor = mesh.geometry.getAttribute('normal')
      for (let i = 0; i < nor.count; i++) nor.setXYZ(i, -nor.getX(i), -nor.getY(i), -nor.getZ(i))
    })
    for (const m of winding(root)) {
      expect(m.volume, `${m.name}: reversed volume`).toBeLessThan(-0.1)
      // ...and the normals still agree with it, which is exactly why the old
      // files looked right under doubleSided: only the volume can tell.
      expect(m.agreement, `${m.name}: reversed normals`).toBeGreaterThan(0)
    }
  })
})

describe.skipIf(AVAILABLE)('every converted GLB is wound outward — assets not hydrated', () => {
  it('is skipped loudly rather than passing vacuously', () => {
    expect(AVAILABLE).toBe(false)
  })
})
