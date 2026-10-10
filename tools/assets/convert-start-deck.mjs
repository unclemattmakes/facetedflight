#!/usr/bin/env node
// tools/assets/convert-start-deck.mjs — 2016's race start deck, PORTED.
//
// DEV-549. Matt, 2026-09-30, answering DEV-461's call to *"port 2016's deck
// with an opening per pad"*: *"sure"*. Until now the deck was FF2's three grey
// slabs — 2016's invisible collision boxes, drawn — on a reason ("PolyWorld,
// cannot ship") that hard rule 7 stopped saying on 2026-09-23.
//
//   node tools/assets/convert-start-deck.mjs            write public/assets/hangar/start-deck.glb
//   node tools/assets/convert-start-deck.mjs --check    build it in memory, compare to the file on disk
//   node tools/assets/convert-start-deck.mjs --out <f>  write somewhere else
//
// READ-ONLY on `$FF2_LEGACY` (hard rule 1). Both sources are bought Asset Store
// geometry — PolyWorld Woodland's floor tiles, and a Materialized-Mesh kitbash
// in Matt's project — so the GLB ships to players from R2 and NEVER goes in git
// (hard rule 7). `public/` is gitignored; the push is one `rclone copy` of this
// file (docs/asset-storage.md §8), and it is not this tool's to make.
//
// ── What 2016's deck is ──────────────────────────────────────────────────
//
// Read off the six decks by `tools/extract/level.mjs` (`startGridSpec`'s `art`):
// every live renderer under `starting_platform` that is not a pad —
//
//   Floor_A / B / C / D   `Quantum Theory/Polyworld/Woodland/Meshes/Flooring/`,
//                         binary FBX 7400, nine tiles a deck at node scale 6.857,
//                         `PW-Woodland.mat`
//   MM_moulding           `Materialized Mesh/MM_moulding/MM_Corner_Short_01.asset`,
//                         a TEXT-YAML Unity mesh, one a deck at scale 1: the
//                         97 x 22 x 62 m frame and footings under the tiles,
//                         `MM_moulding.mat`
//
// Both materials are `Marmoset/Shader/VertexColor/Marmoset Diffuse IBL`, so the
// colour a face renders is its vertex colour times `_Color` (convert-hangar-art's
// reading for the same shader family): `COLOR_0` here is exactly that, linear.
//
// ── The frames: each part MESH-LOCAL, in three space ─────────────────────
//
// One copy of each mesh in its own frame; the renderer places them from the
// level JSON's placements by the Unity->three rule (position z negated,
// quaternion (-x, -y, z, w), scale as is), as `start-grid.ts` places the pads.
//
//   * the moulding is a Unity mesh already: z negated, winding reversed
//     (`toThreeHullFrame`), as every `.asset` this repo converts.
//   * a tile is an FBX, and Unity's importer stands between the file and the
//     scene: it scales by the `.meta`'s `globalScale` (0.01; Unity 5.4's
//     importer ignores the file's own `UnitScaleFactor` of 1 here — the tiles
//     abut at that scale, which `tests/unit/start-deck.test.ts` measures) and
//     takes the right-handed file to Unity's left hand by negating x, reversing
//     the winding. Then three negates z and reverses it back. The two mirrors
//     compose to a half-turn about y: (x, y, z) -> (-x, y, -z) in the file's
//     own winding. The model's `PreRotation` (-90 about x: the tile is z-up in
//     its file) is NOT baked: Unity puts it on the GameObject, and the scene's
//     placements carry it.
//
//     WHICH axis Unity negates is read off the files, not remembered: the
//     file's `PreRotation` is -90 about x and every placed tile's node reads
//     -89.9 to -90.2 about x. A mirror in x leaves a turn about x as it is; a
//     mirror in z (or y) would have turned it to +90. And it MATTERS here: three
//     of the four tiles stand off their pivots (`floor-b`'s footprint runs
//     -0.85 to +1.65 in x), so a wrong mirror moves them 5.5 m across the deck —
//     `tests/unit/start-deck.test.ts` measures the tiles against 2016's own
//     collision cubes and reads it.
//
// Both are checked: every triangle's winding against the file's own normals
// carried through the same map, and the moulding's decode against its
// `m_LocalAABB`. No NORMAL ships: the deck draws flat-shaded.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { parseFbx } from '../extract/fbx-bounds.mjs'
import { legacyPath } from '../legacy-root.mjs'
import { rawColour, shaderGuidOf } from '../unity/material.mjs'
import { readUnityText } from '../unity/yaml.mjs'
import { buildGlb, toThreeHullFrame, worstWindingDisagreement } from './glb.mjs'
import { isMain, runConverter } from './glb-cli.mjs'
import { loadMeshAsset } from './unity-mesh-asset.mjs'

export const DECK_OUT = 'assets/hangar/start-deck.glb'

const FLOORS = 'Assets/Quantum Theory/Polyworld/Woodland/Meshes/Flooring'
const PW_MAT = 'Assets/Quantum Theory/Polyworld/Materials/PW-Woodland.mat'
const MM_MESH = 'Assets/Faceted Flight/Materialized Mesh/MM_moulding/MM_Corner_Short_01.asset'
const MM_MAT = 'Assets/Faceted Flight/Materialized Mesh/MM_moulding/MM_moulding.mat'
const MARMOSET_DIFFUSE = 'Assets/Marmoset/Shader/VertexColor/Marmoset Diffuse IBL.shader'
const MARMOSET_DIFFUSE_GUID = '61e49ff08961c074095e833cb87a691b'

/** The parts, in the names `tools/extract/level.mjs`'s `DECK_ART_PARTS` gives them. */
export const DECK_PARTS = Object.freeze([
  { name: 'floor-a', fbx: `${FLOORS}/Floor_A.fbx`, material: PW_MAT },
  { name: 'floor-b', fbx: `${FLOORS}/Floor_B.fbx`, material: PW_MAT },
  { name: 'floor-c', fbx: `${FLOORS}/Floor_C.fbx`, material: PW_MAT },
  { name: 'floor-d', fbx: `${FLOORS}/Floor_D.fbx`, material: PW_MAT },
  { name: 'moulding', asset: MM_MESH, material: MM_MAT },
])

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** `_Color` and the shader guid off a material's raw text: both YAML dialects (DEV-043). */
const readDiffuse = (matRel) => {
  const text = readUnityText(legacyPath(matRel), { lf: true })
  const shader = shaderGuidOf(text) ?? undefined
  const c = rawColour(text, '_Color')
  if (!c) throw new Error(`convert-start-deck: ${matRel} has no _Color`)
  if (shader !== MARMOSET_DIFFUSE_GUID)
    throw new Error(`convert-start-deck: ${matRel} is not ${MARMOSET_DIFFUSE} (${shader})`)
  const name = /^\s*m_Name: (.*)$/m.exec(text)?.[1]?.trim() ?? ''
  const colorSrgb = c.value.slice(0, 3)
  return { path: matRel, name, shader: MARMOSET_DIFFUSE, colorSrgb }
}

/** Does Marmoset's Diffuse IBL read the vertex colour? Read, not assumed. */
const readsVertexColour = () =>
  /^[ \t]*#define[ \t]+MARMO_VERTEX_COLOR\b/m.test(
    readUnityText(legacyPath(MARMOSET_DIFFUSE), { lf: true }),
  )

/** Every node called `name`, depth-first. */
const findAll = (nodes, name, out = []) => {
  for (const n of nodes) {
    if (n.name === name) out.push(n)
    findAll(n.children, name, out)
  }
  return out
}
const child = (node, name) => node.children.find((c) => c.name === name)

/** The `.meta`'s `globalScale` — the whole of Unity 5.4's import scale for these files. */
const globalScaleOf = (absFbx) => {
  const text = fs.readFileSync(`${absFbx}.meta`, 'utf8')
  const g = /^\s*globalScale:\s*([\d.eE+-]+)/m.exec(text)
  if (!g) throw new Error(`convert-start-deck: ${absFbx}.meta has no globalScale`)
  return Number(g[1])
}

/**
 * One PolyWorld tile, MESH-LOCAL in three space: the file's polygons fanned into
 * triangles, a vertex per polygon corner (the deck is flat-shaded), each corner
 * coloured by the file's own `LayerElementColor` as Unity stores it (Color32).
 */
export const readTile = (fbxRel) => {
  const abs = legacyPath(fbxRel)
  const { version, roots } = parseFbx(abs)
  const geometries = findAll(roots, 'Geometry').filter((g) => child(g, 'Vertices'))
  if (geometries.length !== 1)
    throw new Error(`convert-start-deck: ${fbxRel} holds ${geometries.length} mesh geometries`)
  const g = geometries[0]
  const raw = child(g, 'Vertices').props[0]
  const polys = child(g, 'PolygonVertexIndex').props[0]
  const colorEl = child(g, 'LayerElementColor')
  const normalEl = child(g, 'LayerElementNormal')
  if (!colorEl || !normalEl)
    throw new Error(`convert-start-deck: ${fbxRel} has no colour or normal`)
  const mapping = (el) => [
    child(el, 'MappingInformationType').props[0],
    child(el, 'ReferenceInformationType').props[0],
  ]
  const [cMap, cRef] = mapping(colorEl)
  const [nMap, nRef] = mapping(normalEl)
  if (cMap !== 'ByPolygonVertex' || cRef !== 'IndexToDirect')
    throw new Error(`convert-start-deck: ${fbxRel} colour is ${cMap}/${cRef}`)
  if (nMap !== 'ByPolygonVertex' || nRef !== 'Direct')
    throw new Error(`convert-start-deck: ${fbxRel} normals are ${nMap}/${nRef}`)
  const colors = child(colorEl, 'Colors').props[0]
  const colorIndex = child(colorEl, 'ColorIndex').props[0]
  const normals = child(normalEl, 'Normals').props[0]
  const k = globalScaleOf(abs)

  const position = []
  const normal = []
  const color = []
  const indices = []
  // FBX -> Unity (x negated, scaled) -> three (z negated): (-x, y, -z) * k, a
  // half-turn, so the file's winding stands.
  const put = (corner) => {
    const v = polys[corner] < 0 ? -polys[corner] - 1 : polys[corner]
    position.push(-raw[v * 3] * k, raw[v * 3 + 1] * k, -raw[v * 3 + 2] * k)
    normal.push(-normals[corner * 3], normals[corner * 3 + 1], -normals[corner * 3 + 2])
    const ci = colorIndex[corner]
    // Unity keeps an FBX's vertex colour as Color32: a byte a channel.
    for (let c = 0; c < 3; c++) color.push(Math.round(colors[ci * 4 + c] * 255) / 255)
    return position.length / 3 - 1
  }
  let start = 0
  let polygons = 0
  for (let i = 0; i < polys.length; i++) {
    if (polys[i] >= 0) continue
    const n = i - start + 1
    if (n < 3) throw new Error(`convert-start-deck: ${fbxRel} has a ${n}-gon`)
    const ids = []
    for (let c = start; c <= i; c++) ids.push(put(c))
    for (let t = 1; t + 1 < ids.length; t++) indices.push(ids[0], ids[t], ids[t + 1])
    polygons++
    start = i + 1
  }
  if (start !== polys.length) throw new Error(`convert-start-deck: ${fbxRel} ends mid-polygon`)
  return {
    fbxVersion: version,
    importScale: k,
    polygons,
    position: new Float32Array(position),
    normal: new Float32Array(normal),
    color: new Float32Array(color),
    indices: new Uint16Array(indices),
  }
}

/** The moulding, MESH-LOCAL in three space, with its Mesh Materializer float colours. */
export const readMoulding = () => {
  const { parsed, mesh } = loadMeshAsset(legacyPath(MM_MESH))
  if (!mesh.colorFloat) throw new Error('convert-start-deck: the moulding carries no float colour')
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < mesh.position.length; i += 3)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], mesh.position[i + a])
      max[a] = Math.max(max[a], mesh.position[i + a])
    }
  const aabb = parsed.localAABB
  const axes = ['x', 'y', 'z']
  const miss = aabb
    ? Math.max(
        ...axes.map((a, k) =>
          Math.max(
            Math.abs(min[k] - (aabb.center[a] - aabb.extent[a])),
            Math.abs(max[k] - (aabb.center[a] + aabb.extent[a])),
          ),
        ),
      )
    : Infinity
  if (!(miss < 1e-3))
    throw new Error(`convert-start-deck: the moulding misses m_LocalAABB by ${miss}`)
  const three = toThreeHullFrame(mesh, IDENTITY)
  const n = mesh.position.length / 3
  const color = new Float32Array(n * 3)
  for (let v = 0; v < n; v++)
    for (let c = 0; c < 3; c++) color[v * 3 + c] = mesh.colorFloat[v * 4 + c]
  return { ...three, color, localAABB: aabb, vertexCount: n }
}

/**
 * How much of a mesh's AREA is wound the way its own normals point:
 * `convert-hangar-art.mjs`'s test, because the Materializer SMOOTHS its normals
 * across edges, and a per-vertex test then reads a right winding as wrong. A
 * reversed mesh agrees on ~0 % of its area, a right one on ~100 %.
 */
const windingAgreement = ({ position, normal, indices }) => {
  let agree = 0
  let total = 0
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]]
    const u = [0, 1, 2].map((k) => position[b * 3 + k] - position[a * 3 + k])
    const w = [0, 1, 2].map((k) => position[c * 3 + k] - position[a * 3 + k])
    const f = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
    const area = Math.hypot(...f) / 2
    if (area < 1e-12) continue
    let d = 0
    for (const v of [a, b, c])
      d += f[0] * normal[v * 3] + f[1] * normal[v * 3 + 1] + f[2] * normal[v * 3 + 2]
    total += area
    if (d > 0) agree += area
  }
  return total > 0 ? agree / total : 0
}

const boundsOf = (position) => {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < position.length; i += 3)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], position[i + a])
      max[a] = Math.max(max[a], position[i + a])
    }
  return { min: min.map((x) => +x.toFixed(5)), max: max.map((x) => +x.toFixed(5)) }
}

/** Build the deck, verified, as GLB bytes plus a report. Reads Unity; writes nothing. */
export const buildStartDeck = () => {
  if (!readsVertexColour())
    throw new Error(`convert-start-deck: ${MARMOSET_DIFFUSE} no longer reads the vertex colour`)
  const parts = []
  const report = []
  for (const spec of DECK_PARTS) {
    const geometry = spec.fbx ? readTile(spec.fbx) : readMoulding()
    // The tiles are faceted, so every vertex normal is its face's; the moulding
    // is smoothed, so the question is how much of its area agrees.
    const worst = worstWindingDisagreement(geometry)
    const agreeing = windingAgreement(geometry)
    if (spec.fbx ? worst > 1e-3 : agreeing < 0.99)
      throw new Error(
        `convert-start-deck: ${spec.name}'s winding disagrees with its normals (worst vertex ${worst}, area agreeing ${agreeing})`,
      )
    const mat = readDiffuse(spec.material)
    const linear = mat.colorSrgb.map(srgbToLinear)
    const color = new Float32Array(geometry.color.length)
    for (let i = 0; i < color.length; i++) color[i] = geometry.color[i] * (linear[i % 3] ?? 1)
    const bounds = boundsOf(geometry.position)
    parts.push({
      name: spec.name,
      position: geometry.position,
      normal: null,
      color,
      indices: geometry.indices,
      material: {
        name: mat.name,
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        extras: { unity: mat },
      },
      extras: { unity: { mesh: spec.fbx ?? spec.asset, bounds } },
    })
    report.push({
      part: spec.name,
      source: spec.fbx ?? spec.asset,
      vertices: geometry.position.length / 3,
      triangles: geometry.indices.length / 3,
      importScale: geometry.importScale ?? 1,
      bounds,
      winding: { worstVertex: +worst.toFixed(6), areaAgreeing: +agreeing.toFixed(6) },
      material: mat,
    })
  }
  const glb = buildGlb({
    root: 'start-deck',
    extras: {
      dev: 'DEV-549',
      frame:
        'each part MESH-LOCAL, three space; place with the Unity->three rule from the level JSON (spawn.startGrid.art)',
      colour:
        'COLOR_0 = vertex colour (Color32, or the Materializer float) x linear _Color: the colour the face renders',
    },
    parts,
  })
  return {
    glb,
    report: {
      parts: report,
      bytes: glb.length,
      sha256: createHash('sha256').update(glb).digest('hex'),
    },
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

// The tail (report, --check, the --force refusal, write, exit codes 0/3/4) is
// glb-cli.mjs's, shared with the other converters.
if (isMain(import.meta.url)) {
  runConverter({
    build: () => {
      const { glb, report } = buildStartDeck()
      return { files: { glb }, report }
    },
    outputs: { glb: DECK_OUT },
  })
}
