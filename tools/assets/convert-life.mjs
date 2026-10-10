#!/usr/bin/env node
// tools/assets/convert-life.mjs — the life pass's meshes, PORTED. DEV-447 …
//
//   node tools/assets/convert-life.mjs            write public/assets/life/*.glb
//   node tools/assets/convert-life.mjs --check    rebuild into a temp dir, compare bytes to public/
//   node tools/assets/convert-life.mjs --out <d>  write into <d>/public/assets/life/ instead
//   --force                                       overwrite a file whose bytes differ (else exit 4, nothing written)
//
// READ-ONLY on `$FF2_LEGACY` (hard rule 1): Blender reads the FBX and the
// atlas, and writes only the GLB this tool names.
//
// ── What is ported, and from where ───────────────────────────────────────
//
// 2016 had BOATS and never placed one. `Geometric-Landscape-Tropic-Island` is a
// bought Asset Store pack the shipped game already draws from — Simonet's live
// palms are its `GL-Palmtree-03` — and its "Manmade" set holds a sailing dinghy
// (`GL-Manmade-08`) and a rowing boat (`GL-Manmade-13`), placed only in the
// pack's own example scene. Hard rule 7: bought geometry may ship to players
// from R2 and never enters git. So these GLBs are gitignored under `public/`,
// recorded in `required-assets.json`, and pushed by the lead by name.
//
// ── How ──────────────────────────────────────────────────────────────────
//
// `convert-fbx.py`'s single-file path, unchanged in what it already did: the
// pack's FBX is binary 6100, which only Blender 5's built-in `wm.fbx_import`
// opens, and `orient_prop` is the rotation that path was CALIBRATED to on this
// same pack (GL-Palmtree-01 through both converters, DEV-099's twin). The one
// thing added is `--atlas`: the pack is coloured by a twelve-swatch gradient
// atlas, and the port's register is one colour per face and never a texture,
// so each polygon takes the texel under its UV centroid, decoded to linear and
// multiplied by the material's own `_Color` — which is read out of the `.mat`
// here, not typed (hard rule 3's spirit).
//
// ── What is checked, on the bytes ────────────────────────────────────────
//
// Each GLB, as written: COLOR_0 on every vertex and opaque; no UVs, no image,
// no texture (nothing can sample the atlas downstream); positive signed volume
// (outward winding — a mirror would be inside-out, DEV-044's class); the keel
// at y = 0 and the mast UP (the sail's max y is the mesh's), and the size the
// FBX's own vertices have. Any miss refuses the file.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { assertOutsideLegacy, legacyPath, refPath } from '../legacy-root.mjs'
import { rawColour } from '../unity/material.mjs'
import { buildGlb } from './glb.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const BLENDER =
  process.env.FF2_BLENDER ?? 'C:/Program Files/Blender Foundation/Blender 5.1/blender.exe'
const SCRIPT = path.join(HERE, 'convert-fbx.py')

const GL = 'Assets/Geometric-Landscape-Tropic-Island'
const GL_ATLAS = `${GL}/Textures/GL-Tex-01.jpg`
const GL_MAT = `${GL}/Materials/GL-Tex-01.mat`

/**
 * The jobs. `size` is the FBX's OWN vertex extent (x, y, z) in metres once the
 * pack's `useFileScale: 0` import is reproduced — measured off the file, not
 * chosen — and the check the output must meet to 1 %.
 */
export const LIFE_JOBS = [
  {
    id: 'life.boat-row',
    out: 'assets/life/boat-row.glb',
    src: `${GL}/FBX/GL-Manmade-13.fbx`,
    atlas: GL_ATLAS,
    material: GL_MAT,
    size: [3.168, 1.132, 1.226],
  },
  {
    id: 'life.boat-sail',
    out: 'assets/life/boat-sail.glb',
    src: `${GL}/FBX/GL-Manmade-08.fbx`,
    atlas: GL_ATLAS,
    material: GL_MAT,
    size: [1.706, 2.57, 2.486],
  },
]

/** `_Color` out of a Unity `.mat`, gamma-space rgb. Both YAML dialects (DEV-043). */
export const materialColour = (matText) => {
  const c = rawColour(matText, '_Color')
  if (!c) throw new Error('convert-life: no _Color in the material')
  return c.value.slice(0, 3)
}

/** A GLB's JSON and binary chunk, and a typed view of an accessor. */
export const readGlb = (bytes) => {
  const len = bytes.readUInt32LE(12)
  const json = JSON.parse(bytes.subarray(20, 20 + len).toString('utf8'))
  const bin = bytes.subarray(20 + len + 8)
  const accessor = (i) => {
    const a = json.accessors[i]
    const view = json.bufferViews[a.bufferView]
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type]
    const T = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[
      a.componentType
    ]
    const off = bin.byteOffset + (view.byteOffset ?? 0) + (a.byteOffset ?? 0)
    const scale = a.normalized ? { 5123: 65535, 5121: 255 }[a.componentType] : 1
    const raw = new T(bin.buffer.slice(off, off + a.count * n * T.BYTES_PER_ELEMENT))
    return { n, count: a.count, at: (i2) => raw[i2] / scale }
  }
  return { json, accessor }
}

/** The checks on one GLB's bytes. Throws with every miss named. */
export const verifyLifeGlb = (bytes, job) => {
  const { json, accessor } = readGlb(bytes)
  const misses = []
  if ((json.images ?? []).length || (json.textures ?? []).length) misses.push('carries a texture')
  const prims = json.meshes.flatMap((m) => m.primitives)
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let volume = 0
  let colours = 0
  let verts = 0
  for (const p of prims) {
    if (p.attributes.TEXCOORD_0 !== undefined) misses.push('carries UVs')
    if (p.attributes.COLOR_0 === undefined) {
      misses.push('has no COLOR_0')
      continue
    }
    const P = accessor(p.attributes.POSITION)
    const C = accessor(p.attributes.COLOR_0)
    const I = p.indices !== undefined ? accessor(p.indices) : null
    verts += P.count
    for (let v = 0; v < P.count; v++) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], P.at(v * 3 + k))
        max[k] = Math.max(max[k], P.at(v * 3 + k))
      }
      if (C.n === 4 && C.at(v * 4 + 3) < 1) misses.push(`vertex ${v} is not opaque`)
      colours++
    }
    const tri = I ? I.count / 3 : P.count / 3
    for (let t = 0; t < tri; t++) {
      const id = [0, 1, 2].map((k) => (I ? I.at(t * 3 + k) : t * 3 + k))
      const [a, b, c] = id.map((i) => [P.at(i * 3), P.at(i * 3 + 1), P.at(i * 3 + 2)])
      volume +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6
    }
  }
  if (colours !== verts) misses.push('a vertex has no colour')
  if (!(volume > 0)) misses.push(`signed volume ${volume.toFixed(4)} is not positive (inside out)`)
  if (Math.abs(min[1]) > 0.01) misses.push(`the keel is at y = ${min[1].toFixed(3)}, not 0`)
  const size = max.map((v, k) => v - min[k])
  for (const k of [0, 1, 2]) {
    if (Math.abs(size[k] - job.size[k]) > job.size[k] * 0.01) {
      misses.push(
        `size ${size.map((s) => s.toFixed(3)).join(' x ')} is not ${job.size.join(' x ')}`,
      )
      break
    }
  }
  if (misses.length) throw new Error(`convert-life: ${job.out}: ${[...new Set(misses)].join('; ')}`)
  return { size, volume, verts }
}

// DEV-682: Blender used to write straight into `<root>/public/<job.out>`, so a run
// replaced the shared `public/` file with whatever it made, with no `--force`
// refusal (the three single-GLB converters have one, and so does convert-wings
// since DEV-680). It now writes into a scratch directory and `main` decides.
const convertOne = (job) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-life-job-'))
  const dest = path.join(scratch, 'public', job.out)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tint = materialColour(fs.readFileSync(legacyPath(job.material), 'utf8'))
  execFileSync(
    BLENDER,
    [
      '--background',
      '--python',
      SCRIPT,
      '--',
      '--src',
      legacyPath(job.src),
      '--dest',
      dest,
      '--atlas',
      legacyPath(job.atlas),
      '--tint',
      tint.join(','),
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  const bytes = fs.readFileSync(dest)
  fs.rmSync(scratch, { recursive: true, force: true })
  const report = verifyLifeGlb(bytes, job)
  return { bytes, report, tint }
}

// ── The creatures (DEV-449): polyfish's, baked still ──────────────────────
//
// `polyfish` is Matt's own game (MIT, © Matt Scott) and its dolphin and fish
// are his own low-poly models: first-party, so they may cross (and, being
// binaries, still live on R2 rather than in git). They are SKINNED — a rig
// swims them in polyfish — and the life pass leaps them whole, so this bakes
// the REST pose (three's own `getVertexPosition`, which applies the bind
// matrices and the bones) into a still mesh: one colour a face, COLOR_0 the
// vertex colour times the material's own linear colour (polyfish's `bcbcbc`),
// the Color32 alpha dropped (one vertex group carries 0; CLAUDE.md's trap).
//
// The frame is polyfish's, untouched: the nose on +z, the tail on −z, which
// the tool REFUSES to write unless the rig's own tail bone agrees — the
// orientation lesson: measure against something in the asset's own file.
// Size is the preset's (`scale`): polyfish's units are not metres.

// DEV-545 (Matt, 2026-09-30: "kill the fish"): the fish's job is gone with the
// fish; its GLB stays on R2, unreferenced, until someone deletes it.
export const CREATURE_JOBS = [
  {
    id: 'life.dolphin',
    out: 'assets/life/dolphin.glb',
    src: ['polyfish', 'assets', 'models', 'dolphin_rigged.glb'],
    tailBone: 'end',
  },
]

/** Bake one rigged polyfish model to a still, flat, vertex-coloured GLB. */
export const bakeCreature = async (job) => {
  const buf = fs.readFileSync(refPath(...job.src))
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej))
  gltf.scene.updateMatrixWorld(true)
  const skinned = []
  let tail = null
  gltf.scene.traverse((o) => {
    if (o.isSkinnedMesh) skinned.push(o)
    if (o.isBone && o.name === job.tailBone) tail = o.getWorldPosition(new THREE.Vector3())
  })
  if (skinned.length !== 1)
    throw new Error(`convert-life: ${job.id} has ${skinned.length} skinned meshes, not 1`)
  if (!tail) throw new Error(`convert-life: ${job.id} has no bone '${job.tailBone}'`)
  const mesh = skinned[0]
  const g = mesh.geometry
  const pos = g.getAttribute('position')
  const nor = g.getAttribute('normal')
  const col = g.getAttribute('color')
  const index = g.index
  if (!col) throw new Error(`convert-life: ${job.id} carries no vertex colour`)
  const tint = mesh.material.color
  const triCount = (index ? index.count : pos.count) / 3
  const position = new Float32Array(triCount * 9)
  const normal = new Float32Array(triCount * 9)
  const color = new Float32Array(triCount * 9)
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  const n = new THREE.Vector3()
  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  let agree = 0
  for (let t = 0; t < triCount; t++) {
    const ids = [0, 1, 2].map((k) => (index ? index.getX(t * 3 + k) : t * 3 + k))
    for (let k = 0; k < 3; k++) {
      mesh.getVertexPosition(ids[k], v[k])
      v[k].applyMatrix4(mesh.matrixWorld)
    }
    e1.subVectors(v[1], v[0])
    e2.subVectors(v[2], v[0])
    n.crossVectors(e1, e2).normalize()
    // The file's own normals, averaged: a face wound the other way from them
    // is inside out. Counted, and refused below if the file disagrees.
    let sx = 0
    let sy = 0
    let sz = 0
    for (const id of ids) {
      sx += nor ? nor.getX(id) : 0
      sy += nor ? nor.getY(id) : 0
      sz += nor ? nor.getZ(id) : 0
    }
    if (n.x * sx + n.y * sy + n.z * sz > 0) agree++
    // One colour a face: the three corners' mean, times the material.
    let r = 0
    let gg = 0
    let b = 0
    for (const id of ids) {
      r += col.getX(id) / 3
      gg += col.getY(id) / 3
      b += col.getZ(id) / 3
    }
    for (let k = 0; k < 3; k++) {
      position.set([v[k].x, v[k].y, v[k].z], t * 9 + k * 3)
      normal.set([n.x, n.y, n.z], t * 9 + k * 3)
      color.set([r * tint.r, gg * tint.g, b * tint.b], t * 9 + k * 3)
    }
  }
  const box = new THREE.Box3().setFromArray(position)
  const misses = []
  if (!(tail.z < 0))
    misses.push(`the tail bone is at z ${tail.z.toFixed(4)}, not behind the origin`)
  if (!(box.max.z > 0 && box.min.z < 0 && -box.min.z > box.max.z)) {
    misses.push('the body does not run tail -z to nose +z')
  }
  if (nor && agree / triCount < 0.9) {
    misses.push(`only ${agree} of ${triCount} faces agree with the file's normals`)
  }
  if (misses.length) throw new Error(`convert-life: ${job.id}: ${misses.join('; ')}`)
  const indices = new Uint16Array(triCount * 3).map((_, i) => i)
  const bytes = buildGlb({
    root: job.id,
    extras: {
      dev: 'DEV-449',
      source: `$FF2_REF/${job.src.join('/')} (polyfish, Matt's own, MIT) rest pose`,
      frame: 'polyfish model frame: nose +z, tail -z, up +y; size is the preset scale',
      tail: tail.toArray(),
    },
    parts: [
      {
        name: job.id.replace('life.', ''),
        position,
        normal,
        color,
        indices,
        material: {
          name: 'vertexColour',
          pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 },
        },
      },
    ],
  })
  return {
    bytes,
    report: { tris: triCount, agree, size: box.getSize(new THREE.Vector3()).toArray() },
  }
}

const main = async () => {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const force = argv.includes('--force')
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null
  const wanted = (id) => !only || only.includes(id)
  const outRoot = argv.includes('--out') ? path.resolve(argv[argv.indexOf('--out') + 1]) : REPO
  let failed = 0
  const results = []
  const take = (job, bytes, line) => {
    const sha = createHash('sha256').update(bytes).digest('hex')
    if (check) {
      const disk = path.join(REPO, 'public', job.out)
      if (!(fs.existsSync(disk) && fs.readFileSync(disk).equals(bytes))) {
        console.error(`  DIFFERS from ${disk}`)
        failed++
      }
    }
    results.push({ job, bytes })
    console.log(line(sha))
  }
  for (const job of LIFE_JOBS.filter((j) => wanted(j.id))) {
    const { bytes, report, tint } = convertOne(job)
    take(
      job,
      bytes,
      (sha) =>
        `${job.id}: ${job.out} ${bytes.length} bytes sha256 ${sha}: ${report.verts} verts, ` +
        `${report.size.map((s) => s.toFixed(3)).join(' x ')} m, _Color ${tint.join(',')}`,
    )
  }
  for (const job of CREATURE_JOBS.filter((j) => wanted(j.id))) {
    const { bytes, report } = await bakeCreature(job)
    take(
      job,
      bytes,
      (sha) =>
        `${job.id}: ${job.out} ${bytes.length} bytes sha256 ${sha}: ${report.tris} tris, ` +
        `${report.size.map((s) => s.toFixed(4)).join(' x ')} (polyfish units), ` +
        `${report.agree}/${report.tris} faces agree with the file's normals`,
    )
  }
  if (failed) process.exit(1)
  if (check) return
  // Refuse before writing anything: `public/` is shared by every checkout (AGENT-NOTES section 2).
  const refused = results.filter(({ job, bytes }) => {
    const dest = path.join(outRoot, 'public', job.out)
    return fs.existsSync(dest) && !fs.readFileSync(dest).equals(bytes)
  })
  if (refused.length && !force) {
    for (const { job } of refused) {
      console.error(
        `REFUSING to overwrite ${path.join(outRoot, 'public', job.out)} with different bytes; pass --force if you mean it`,
      )
    }
    process.exit(4)
  }
  for (const { job, bytes } of results) {
    const dest = path.join(outRoot, 'public', job.out)
    assertOutsideLegacy(dest)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, bytes)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
