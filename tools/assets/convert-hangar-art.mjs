#!/usr/bin/env node
// tools/assets/convert-hangar-art.mjs — 2016's level-select room, PORTED.
//
// DEV-430. Matt, 2026-09-26: *"would also like the original hangar art,
// holotable art, etc, ported so we can have better parity with the 2016
// version."* Until now the room was `sim/hangar.ts`'s generated revolve, on a
// reason — "bought geometry, cannot ship" — that hard rule 7 stopped being true
// of on 2026-09-23.
//
//   node tools/assets/convert-hangar-art.mjs            write the three GLBs into public/assets/hangar/
//   node tools/assets/convert-hangar-art.mjs --check    build them in memory, compare to the files on disk
//   node tools/assets/convert-hangar-art.mjs --report   print the inventory and write nothing
//
// READ-ONLY on `$FF2_LEGACY` (hard rule 1). Every output is bought Asset Store
// geometry or a derivative of it — SLK Sci-Fi Level Kit through VacuumShaders'
// Mesh Materializer, PolyWorld conversions, and kitbashes of them combined in
// Matt's own project — so it ships to players from R2 and NEVER goes in git
// (hard rule 7). `public/` is gitignored; the push is one `rclone copy` per file
// (docs/asset-storage.md §8), and it is not this tool's to make.
//
// ── Which scene: `setGameplayOptions`, not `main_menu` ────────────────────
//
// `main_menu` is the OUTDOOR alpine valley with three podiums in it
// (`_ui-flow.md` §5). The room you sit in and choose a mission from is
// `Scenes/setGameplayOptions.unity`: an `Environment_Hangar.prefab` instance at
// the scene origin, plus a scene-level `level_sel_room` that holds the chair,
// `MenuManager` and the pages of holotables.
//
// ── What 2016 draws there — the liveness walk, not the file list ─────────
//
// Every renderer whose GameObject and EVERY ancestor are `m_IsActive: 1` and
// whose `MeshRenderer` is `m_Enabled: 1`, read off the scene flattened with its
// prefabs EXPANDED: the hangar is a stripped `!u!1001` instance, so a scene read
// that stops at the instance boundary sees none of it (CLAUDE.md's stripped
// prefab trap). The pages are the one exception: every page is authored
// `m_IsActive: 0`, and `MenuManager.Start()` does `currentPage.SetActive(true)`
// with `currentPage` = `page_shipSelection`, so that page is walked as active.
//
// This tool REFUSES to write when the inventory moves: every live renderer under
// `Environment_Hangar` and `level_sel_room` must be one it has a rule for.
//
//   Environment_Hangar                                           → hangar-room.glb
//     …/startingArea_bottomFloor/botfloor_room                    part `room`
//     …/startingArea_bottomFloor/botfloor_startingArea2           part `roomLower`
//     …/startingArea_bottomFloor/botfloor_startingArea            part `lamps`
//     …/Elevator/Elevator_animator/Projector04-Faceted            part `platform`
//     …/ent_elevatorShaft_01..08/elev_shaft_01/{walls_and_pillars, pipes_LOD3, vent}
//                                                                 part `shaft` (segment 01) × 8
//     HoverJet/…                                                  NOT here: the parked jet is
//                                                                 `hoverjet-exterior.glb` + wings
//   level_sel_room/MM_Commander_Chair_01                          → commander-chair.glb
//   level_sel_room/MM_Commander_Chair_01/Cylinder (1)             Unity's OWN cylinder: not
//                                                                 copied, recorded as numbers
//   page_shipSelection/…/holotable_{canyon,islands,mid}           → commander-table.glb (one copy)
//
// ── The frames ────────────────────────────────────────────────────────────
//
// Everything is in three space: Unity z negated on positions, every triangle's
// winding reversed — a single negation is a mirror, and a mirror turns every
// face inside out (DEV-044). The normals are used to VERIFY the winding and then
// dropped: the room draws flat-shaded (`render/hangar.ts`'s shell material), so
// three derives each face's normal from the face itself, and 40 % of the bytes
// were a normal nobody reads.
//
//   hangar-room.glb   the ROOM frame. Origin on the lift's axis — the `Elevator`
//                     transform's x and z — at the floor, which is
//                     `Position_adjustment`'s y (the pivot every room mesh
//                     hangs off). Metres, unrotated from Unity's world. The
//                     renderer turns this frame about y and sets it on the
//                     port's floor; nothing else.
//   commander-chair   the chair's OWN frame at its 2016 world scale (1.7).
//   commander-table   the table's own frame at its 2016 world scale (1, 2.03, 1).
//
// The numbers the renderer places them by — the 2016 eye, its resting look,
// the jet, the lift's Unity-native deck box, the chair's disc — ride in each
// file's root-node extras, read off the scene here, so `src/` types none of them.
//
// ── Colour: what each MATERIAL does with the vertex colour ────────────────
//
// `COLOR_0` is the colour the face renders, linear, one float VEC3 per vertex:
//
//   Marmoset VertexColor Diffuse / Specular IBL   raw Color32 bytes / 255, times
//     (botfloor_*, the platform, the chair,        `_Color` through the sRGB
//      the table)                                  transfer function — the reading
//                                                  `render/hover-glow.ts` records
//                                                  for this shader family (DEV-014:
//                                                  the vertex bytes arrive RAW)
//   Marmoset Specular IBL (NOT the VertexColor    `_Color` alone. Its source has
//     variant: walls, pipes, vents)                `//#define MARMO_VERTEX_COLOR`
//                                                  COMMENTED OUT, so the shaft's
//                                                  PolyWorld colours never drew
//   SLK `Monitor_And_Stuff_Light_01`              the texture, averaged over each
//     (Legacy Self-Illumin, the light tubes)       face's UV triangle, times
//                                                  `_Color`: a Materialized-Mesh
//                                                  style bake, one colour a face,
//                                                  so no texture reaches the game
//
// Whether a shader reads the vertex colour is decided by READING the shader's
// source for an uncommented `#define MARMO_VERTEX_COLOR`, not by its name.

import { createHash } from 'node:crypto'
import { legacyPath, legacyRoot } from '../legacy-root.mjs'
import { decodePng } from '../terrain/png.mjs'
import { flatIsLive } from '../unity/graph.mjs'
import { loadGuidIndex } from '../unity/guid-index.mjs'
import { rawColour as sharedRawColour, rawTexEnv as sharedRawTexEnv } from '../unity/material.mjs'
import { prototypeTool, readUnityText } from '../unity/yaml.mjs'
import { buildGlb, worstWindingDisagreement } from './glb.mjs'
import { isMain, runConverter } from './glb-cli.mjs'
import { loadMeshAsset } from './unity-mesh-asset.mjs'

/** Where each GLB lands under `public/`, and what `src/render/hangar-art.ts` fetches. */
export const HANGAR_ART_OUT = Object.freeze({
  room: 'assets/hangar/hangar-room.glb',
  chair: 'assets/hangar/commander-chair.glb',
  table: 'assets/hangar/commander-table.glb',
  // DEV-456: the shaft segment in its OWN painted colours, which 2016's shader never read.
  shaftPainted: 'assets/hangar/hangar-shaft-painted.glb',
})

export const SCENE = 'Assets/Faceted Flight/Scenes/setGameplayOptions.unity'
const HANGAR_ROOT = 'Environment_Hangar'
const ADJUST = `${HANGAR_ROOT}/PlayerStart_ElevatorShaft_/Position_adjustment`
const ELEVATOR = `${ADJUST}/Elevator`
const ELEVATOR_CUBE = `${ELEVATOR}/Elevator_animator/Cube`
const CHAIR = 'level_sel_room/MM_Commander_Chair_01'
const CHAIR_DISC = `${CHAIR}/Cylinder (1)`
const EYE = 'Cameras/camRig_ovr/OVRCameraRig (1)/TrackingSpace/CenterEyeAnchor'
const JET = `${HANGAR_ROOT}/HoverJet`
const SHIP_PAGE = 'level_sel_room/page_group/page_shipSelection'

const MESH = {
  room: 'Assets/Faceted Flight/FF_WorldTour/meshes/combined/botfloor_room.asset',
  roomLower: 'Assets/Faceted Flight/FF_WorldTour/meshes/combined/botfloor_startingArea2.asset',
  lamps: 'Assets/Faceted Flight/FF_WorldTour/meshes/combined/botfloor_startingArea.asset',
  platform: 'Assets/Faceted Flight/Meshes/Converted_Faceted_Meshes/Projector04-Faceted.asset',
  walls: 'Assets/Faceted Flight/FF_WorldTour/meshes/converted/walls_and_pillars_pwn.asset',
  pipes: 'Assets/Faceted Flight/FF_WorldTour/meshes/converted/pipes_LOD3_pwn.asset',
  vent: 'Assets/Faceted Flight/FF_WorldTour/meshes/converted/elev_shaft_013_pwn.asset',
  chair: 'Assets/Faceted Flight/Materialized Mesh/MM_level_sel_room/MM_MM_Commander_Chair_01.asset',
  table: 'Assets/Faceted Flight/Materialized Mesh/MM_level_sel_room/MM_MM_Commander_Table_01.asset',
}

/** The parked jet's parts: already in the game as `hoverjet-exterior.glb` and the wing. */
const JET_MESHES = new Set([
  'Assets/Faceted Flight/Meshes/hoverJet_exterior_orange.fbx',
  'Assets/Faceted Flight/Meshes/combined/Mesh1-Combined.asset',
  'Assets/Faceted Flight/Meshes/combined/Mesh2-Combined.asset',
])

/** Unity's built-in cylinder: radius 0.5, height 2, about local y. A fact about Unity, not a mesh we copy. */
const UNITY_CYLINDER = Object.freeze({ fileID: '10206', radius: 0.5, halfHeight: 1 })

// ── Unity YAML, and the scene flattener ─────────────────────────────────────
//
// `tools/prototype/*.js` are CommonJS under a `"type": "module"` package, so
// they are evaluated in a CJS wrapper (tools/unity/yaml.mjs, TL-1: the one loader).

const sceneTool = () => prototypeTool('unity_scene_to_json.js')

/** The scene, flattened with its prefabs expanded. Cached: 60 MB of YAML. */
let flatCache = null
const flatScene = () => {
  if (flatCache) return flatCache
  const tool = sceneTool()
  const guids = loadGuidIndex().guidToPath
  const flat = tool.extract(legacyPath(SCENE), {
    project: legacyRoot(),
    guidIndex: guids,
    resolvePrefabs: true,
    expandPrefabs: true,
  })
  flatCache = { flat, guids }
  return flatCache
}

// ── Matrices (column-major, three's `Matrix4.elements` layout) ───────────────

const trs = (local) => {
  const { position: p, rotation: q, scale: s } = local
  const [x, y, z, w] = [q.x, q.y, q.z, q.w]
  const r = [
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
  ]
  return [
    r[0] * s.x,
    r[1] * s.x,
    r[2] * s.x,
    0,
    r[3] * s.y,
    r[4] * s.y,
    r[5] * s.y,
    0,
    r[6] * s.z,
    r[7] * s.z,
    r[8] * s.z,
    0,
    p.x,
    p.y,
    p.z,
    1,
  ]
}

const mul = (a, b) => {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let v = 0
      for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k]
      o[c * 4 + r] = v
    }
  }
  return o
}

const apply = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
]

const applyDir = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z,
  m[1] * x + m[5] * y + m[9] * z,
  m[2] * x + m[6] * y + m[10] * z,
]

const translation = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]

/** Inverse of a rigid-plus-scale matrix whose 3x3 is a rotation times a diagonal. */
const invert = (m) => {
  // General 4x4 inverse (affine), via the 3x3 cofactors.
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  const inv3 = [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ]
  // inv3 is row-major; write column-major.
  const t = [m[12], m[13], m[14]]
  const tx = -(inv3[0] * t[0] + inv3[1] * t[1] + inv3[2] * t[2])
  const ty = -(inv3[3] * t[0] + inv3[4] * t[1] + inv3[5] * t[2])
  const tz = -(inv3[6] * t[0] + inv3[7] * t[1] + inv3[8] * t[2])
  return [
    inv3[0],
    inv3[3],
    inv3[6],
    0,
    inv3[1],
    inv3[4],
    inv3[7],
    0,
    inv3[2],
    inv3[5],
    inv3[8],
    0,
    tx,
    ty,
    tz,
    1,
  ]
}

/** Unity point → three point: z negated. */
const toThree = ([x, y, z]) => [x, y, -z]

// ── The scene graph, with world matrices composed rather than decomposed ─────

const sceneGraph = () => {
  const { flat, guids } = flatScene()
  const byKey = new Map(flat.objects.map((o) => [o.key, o]))
  const byPath = new Map()
  for (const o of flat.objects) {
    if (!byPath.has(o.path)) byPath.set(o.path, [])
    byPath.get(o.path).push(o)
  }
  const worldMemo = new Map()
  const world = (o) => {
    if (worldMemo.has(o.key)) return worldMemo.get(o.key)
    const parent = byKey.get(o.parent)
    const m = parent ? mul(world(parent), trs(o.local)) : trs(o.local)
    worldMemo.set(o.key, m)
    return m
  }
  const one = (p) => {
    const hits = byPath.get(p) ?? []
    if (hits.length !== 1) {
      throw new Error(`convert-hangar-art: expected ONE object at ${p}, found ${hits.length}`)
    }
    return hits[0]
  }
  /** Active in hierarchy, with the given subtree roots forced on (MenuManager's page). */
  const liveWith = (forced) => {
    const memo = new Map()
    return (o) => {
      if (!memo.has(o.key)) {
        memo.set(
          o.key,
          flatIsLive(o, (n) => byKey.get(n.parent), { forced: (n) => forced.has(n.key) }),
        )
      }
      return memo.get(o.key)
    }
  }
  const under = (o, root) => {
    for (let n = o; n; n = byKey.get(n.parent)) if (n.key === root.key) return true
    return false
  }
  return { flat, guids, byKey, byPath, world, one, liveWith, under }
}

/** Every live, enabled mesh renderer under `root`, with its mesh and materials resolved. */
const liveRenderers = (g, root, live) => {
  const out = []
  for (const o of g.flat.objects) {
    if (!g.under(o, root) || !live(o)) continue
    const renderer = (o.components ?? []).find((c) => c.type === 'MeshRenderer')
    if (!renderer || Number(renderer.enabled) !== 1) continue
    const filter = (o.components ?? []).find((c) => c.type === 'MeshFilter')
    const meshRef = filter?.mesh ?? {}
    out.push({
      object: o,
      path: o.path,
      mesh: meshRef.guid ? (g.guids.get(meshRef.guid) ?? `guid:${meshRef.guid}`) : null,
      builtinMesh: meshRef.guid ? null : String(meshRef.fileID ?? ''),
      materials: (renderer.materials ?? []).map((m) =>
        m.guid && !/^0+f0+$/.test(m.guid)
          ? (g.guids.get(m.guid) ?? `guid:${m.guid}`)
          : `builtin:${m.fileID}`,
      ),
      matrix: g.world(o),
    })
  }
  return out
}

// ── Materials ───────────────────────────────────────────────────────────────

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** Does this shader's source read the vertex colour? Read, not guessed from the name. */
const shaderReadsVertexColour = (shaderRel) => {
  if (!shaderRel) return null
  const src = readUnityText(legacyPath(shaderRel), { lf: true })
  return /^[ \t]*#define[ \t]+MARMO_VERTEX_COLOR\b/m.test(src)
}

// ── Material properties, read off the RAW text ──────────────────────────────
//
// Three of this room's five materials are the OLD dialect: `m_Colors:` then
// repeated `data: first/second` blocks with no list marker. The YAML parser
// reads repeated `data` keys as ONE key — the last — so `botfloor_shaft_pwm_Mat`
// "has" a `_Color` only because `_Color` happens to be written last, and
// `convert-wings.mjs`'s `readMaterial` throws on it outright (it expects a
// list). CLAUDE.md's dialect trap, DEV-043. Both dialects write `name: <prop>`
// with `second:` on the next line, so the raw text answers for both.

// The readers are tools/unity/material.mjs's; these wrap them to throw on a missing property.

/** A colour property off a `.mat`/`.asset` material, either dialect, sRGB as written (rgb). */
const rawColour = (text, name, matRel) => {
  const c = sharedRawColour(text, name)
  if (!c) throw new Error(`convert-hangar-art: ${matRel} has no ${name}`)
  return c.value.slice(0, 3)
}

/** A texture slot off a material, either dialect: the guid, scale and offset. */
const rawTexEnv = (text, name, matRel) => {
  const t = sharedRawTexEnv(text, name)
  if (!t) throw new Error(`convert-hangar-art: ${matRel} has no ${name} slot`)
  return t
}

/** Name, shader (path, or the built-in fileID) and the raw text of a material. */
const materialHead = (matRel, guids) => {
  const text = readUnityText(legacyPath(matRel), { lf: true })
  const name = text.match(/^\s*m_Name: (.*)$/m)?.[1]?.trim() ?? ''
  const shader = text.match(/m_Shader: \{fileID: (\d+), guid: ([0-9a-f]+)/)
  if (!shader) throw new Error(`convert-hangar-art: ${matRel} has no m_Shader`)
  return {
    text,
    name,
    shaderFileID: shader[1],
    shader: /^0+f0+$/.test(shader[2]) ? null : (guids.get(shader[2]) ?? `guid:${shader[2]}`),
  }
}

/** A Marmoset material's colour rule: `_Color` (linear), and whether vertex colour multiplies it. */
const marmoset = (matRel, guids) => {
  const head = materialHead(matRel, guids)
  if (!head.shader || !/Marmoset/.test(head.shader)) {
    throw new Error(`convert-hangar-art: ${matRel} is not a Marmoset material (${head.shader})`)
  }
  const colorSrgb = rawColour(head.text, '_Color', matRel)
  return {
    record: { path: matRel, name: head.name, shader: head.shader, colorSrgb },
    linear: colorSrgb.map(srgbToLinear),
    vertexColour: shaderReadsVertexColour(head.shader),
  }
}

/** `_MainTex`'s texture, scale and offset, and `_Color`, off a legacy material. Both dialects. */
const texturedMaterial = (matRel, guids) => {
  const head = materialHead(matRel, guids)
  const tex = rawTexEnv(head.text, '_MainTex', matRel)
  const texture = tex.guid ? guids.get(tex.guid) : null
  if (!texture) throw new Error(`convert-hangar-art: ${matRel}'s _MainTex resolves to nothing`)
  return {
    name: head.name,
    shaderFileID: head.shaderFileID,
    texture,
    scale: tex.scale,
    offset: tex.offset,
    colorSrgb: rawColour(head.text, '_Color', matRel),
  }
}

/**
 * The texture as Unity held it: `nPOTScale: ToNearest` rescales a 2049-wide PNG
 * to 2048 at import (CLAUDE.md, "a Unity texture is not the PNG on disk"), and
 * the importer's `maxTextureSize` caps it. Linear-space texels out, sRGB in.
 */
const importedTexture = (textureRel) => {
  const meta = readUnityText(legacyPath(`${textureRel}.meta`), { lf: true })
  const npot = Number(meta.match(/nPOTScale:\s*(\d+)/)?.[1] ?? 1)
  const maxSize = Number(meta.match(/maxTextureSize:\s*(\d+)/)?.[1] ?? 2048)
  const linearTexture = Number(meta.match(/linearTexture:\s*(\d+)/)?.[1] ?? 0) === 1
  const png = decodePng(legacyPath(textureRel))
  const nearestPow2 = (n) => 2 ** Math.round(Math.log2(n))
  let w = png.width
  let h = png.height
  if (npot !== 0) {
    w = nearestPow2(w)
    h = nearestPow2(h)
  }
  w = Math.min(w, maxSize)
  h = Math.min(h, maxSize)
  const toLinear = (b) => (linearTexture ? b / 255 : srgbToLinear(b / 255))
  const src = (x, y, c) => toLinear(png.data[(y * png.width + x) * png.channels + c])
  // Bilinear resample to the imported size, texel centres aligned.
  const data = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    const fy = Math.min(png.height - 1, Math.max(0, ((y + 0.5) * png.height) / h - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(png.height - 1, y0 + 1)
    const ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(png.width - 1, Math.max(0, ((x + 0.5) * png.width) / w - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(png.width - 1, x0 + 1)
      const tx = fx - x0
      for (let c = 0; c < 3; c++) {
        const top = src(x0, y0, c) * (1 - tx) + src(x1, y0, c) * tx
        const bot = src(x0, y1, c) * (1 - tx) + src(x1, y1, c) * tx
        data[(y * w + x) * 3 + c] = top * (1 - ty) + bot * ty
      }
    }
  }
  /** GPU-style bilinear: texel centres at (i + 0.5) / w, v = 0 at the BOTTOM row, repeat wrap. */
  const sample = (u, v) => {
    const fu = (u - Math.floor(u)) * w - 0.5
    const fv = (1 - (v - Math.floor(v))) * h - 0.5
    const x0 = Math.floor(fu)
    const y0 = Math.floor(fv)
    const tx = fu - x0
    const ty = fv - y0
    const wrap = (i, n) => ((i % n) + n) % n
    const at = (x, y, c) => data[(wrap(y, h) * w + wrap(x, w)) * 3 + c]
    const out = [0, 0, 0]
    for (let c = 0; c < 3; c++) {
      const top = at(x0, y0, c) * (1 - tx) + at(x0 + 1, y0, c) * tx
      const bot = at(x0, y0 + 1, c) * (1 - tx) + at(x0 + 1, y0 + 1, c) * tx
      out[c] = top * (1 - ty) + bot * ty
    }
    return out
  }
  return { width: w, height: h, sourceWidth: png.width, sourceHeight: png.height, sample }
}

// ── Mesh assembly ────────────────────────────────────────────────────────────

/** Decode, and check the decode against Unity's own serialised bounds. */
const decoded = (meshRel) => {
  const { parsed, mesh } = loadMeshAsset(legacyPath(meshRel))
  const aabb = parsed.localAABB
  if (!aabb) throw new Error(`convert-hangar-art: ${meshRel} has no m_LocalAABB`)
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < mesh.position.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], mesh.position[i + k])
      max[k] = Math.max(max[k], mesh.position[i + k])
    }
  }
  const axes = ['x', 'y', 'z']
  const miss = Math.max(
    ...axes.map((a, k) =>
      Math.max(
        Math.abs(min[k] - (aabb.center[a] - aabb.extent[a])),
        Math.abs(max[k] - (aabb.center[a] + aabb.extent[a])),
      ),
    ),
  )
  if (miss > 1e-4) {
    throw new Error(`convert-hangar-art: ${meshRel} decodes ${miss} outside its m_LocalAABB`)
  }
  if (!mesh.normal) throw new Error(`convert-hangar-art: ${meshRel} carries no normals`)
  if (!mesh.color) throw new Error(`convert-hangar-art: ${meshRel} carries no vertex colour`)
  if (parsed.subMeshes.length !== 1) {
    throw new Error(`convert-hangar-art: ${meshRel} has ${parsed.subMeshes.length} submeshes`)
  }
  return { parsed, mesh, localAABB: aabb, vertexCount: parsed.vertexCount }
}

/**
 * How much of a mesh's AREA is wound the way its own normals point.
 *
 * `worstWindingDisagreement` (DEV-322) asks every vertex normal to match its
 * face, which is right for a faceted mesh and wrong for a SMOOTHED one: the
 * Materialized-Mesh chair averages its normals across a 90-degree edge, so its
 * worst vertex reads 1.0 with the winding perfectly right. The question that
 * separates a right winding from a reversed one on both is area: a reversed
 * mesh agrees on ~0 % of it, a right one on ~100 %.
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
    for (const v of [a, b, c]) {
      d += f[0] * normal[v * 3] + f[1] * normal[v * 3 + 1] + f[2] * normal[v * 3 + 2]
    }
    total += area
    if (d > 0) agree += area
  }
  return total > 0 ? agree / total : 0
}

/**
 * One mesh through `matrix` (Unity → the target Unity frame), then to three
 * space, with its winding checked against its own normals and its colour taken
 * by `colourOf(vertex, face)`.
 *
 * `perFace` splits every triangle onto its own three vertices first, so a
 * colour chosen PER FACE (the lamps' texture bake) cannot be overwritten by the
 * next face sharing a corner.
 */
const place = ({ mesh: source }, matrix, colourOf, { perFace = false } = {}) => {
  const mesh = perFace ? unshare(source) : source
  const n = mesh.position.length / 3
  const position = new Float32Array(n * 3)
  const normal = new Float32Array(n * 3)
  // Inverse-transpose for the normals (non-uniform scales here: 0.85/0.733).
  const inv = invert(matrix)
  for (let v = 0; v < n; v++) {
    const p = toThree(
      apply(matrix, [mesh.position[v * 3], mesh.position[v * 3 + 1], mesh.position[v * 3 + 2]]),
    )
    position.set(p, v * 3)
    const [a, b, c] = [mesh.normal[v * 3], mesh.normal[v * 3 + 1], mesh.normal[v * 3 + 2]]
    // (M^-1)^T n: the transpose of inv's 3x3 applied — inv is column-major, so
    // row r of (inv)^T is column r of inv.
    const nx = inv[0] * a + inv[1] * b + inv[2] * c
    const ny = inv[4] * a + inv[5] * b + inv[6] * c
    const nz = inv[8] * a + inv[9] * b + inv[10] * c
    const len = Math.hypot(nx, ny, nz) || 1
    normal.set([nx / len, ny / len, -nz / len], v * 3)
  }
  const indices = new Uint32Array(mesh.indices.length)
  for (let i = 0; i < indices.length; i += 3) {
    indices[i] = mesh.indices[i]
    indices[i + 1] = mesh.indices[i + 2]
    indices[i + 2] = mesh.indices[i + 1]
  }
  const winding = {
    worstVertex: worstWindingDisagreement({ position, normal, indices }),
    areaAgreeing: windingAgreement({ position, normal, indices }),
  }
  const color = new Float32Array(n * 3)
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const v = indices[t + k]
      color.set(colourOf(mesh.sourceVertex ? mesh.sourceVertex[v] : v, t / 3), v * 3)
    }
  }
  return { position, indices, color, winding }
}

/** Every triangle on its own three vertices; `sourceVertex` maps each back. */
const unshare = (mesh) => {
  const count = mesh.indices.length
  const position = new Float32Array(count * 3)
  const normal = new Float32Array(count * 3)
  const sourceVertex = new Uint32Array(count)
  const indices = new Uint32Array(count)
  for (let i = 0; i < count; i++) {
    const v = mesh.indices[i]
    position.set(mesh.position.subarray(v * 3, v * 3 + 3), i * 3)
    normal.set(mesh.normal.subarray(v * 3, v * 3 + 3), i * 3)
    sourceVertex[i] = v
    indices[i] = i
  }
  return { ...mesh, position, normal, indices, sourceVertex }
}

/** Concatenate placed meshes into one part (same material rule, u16 indices). */
const merge = (pieces) => {
  const verts = pieces.reduce((s, p) => s + p.position.length / 3, 0)
  if (verts > 65535)
    throw new Error(`convert-hangar-art: a part of ${verts} verts needs u32 indices`)
  const position = new Float32Array(verts * 3)
  const color = new Float32Array(verts * 3)
  const indices = new Uint16Array(pieces.reduce((s, p) => s + p.indices.length, 0))
  let v = 0
  let i = 0
  for (const p of pieces) {
    position.set(p.position, v * 3)
    color.set(p.color, v * 3)
    for (let k = 0; k < p.indices.length; k++) indices[i + k] = p.indices[k] + v
    v += p.position.length / 3
    i += p.indices.length
  }
  return { position, color, indices }
}

const bounds = (position) => {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < position.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], position[i + k])
      max[k] = Math.max(max[k], position[i + k])
    }
  }
  return { min, max }
}

const round = (v, d = 5) => Number(v.toFixed(d))
const r3 = (a) => a.map((v) => round(v))

/** Colour by a Marmoset rule: raw vertex bytes (or 1) times linear `_Color`. */
const byMarmoset = (mesh, rule) => (v) =>
  rule.linear.map((c, k) => (rule.vertexColour ? vertexColour(mesh, v, k) * c : c))

/**
 * One vertex's colour channel, 0..1, as stored: the FLOAT a Mesh Materializer
 * bake writes (`MM_*`: the chair, the table), else the Color32 byte over 255.
 * Read as bytes, the floats came out as a rainbow — `unity-mesh-asset.mjs`'s
 * `colorFloat` note.
 */
const vertexColour = (mesh, v, k) =>
  mesh.colorFloat ? mesh.colorFloat[v * 4 + k] : mesh.color[v * 4 + k] / 255

// ── The build ────────────────────────────────────────────────────────────────

export const buildHangarArt = () => {
  const g = sceneGraph()
  const guids = g.guids
  const hangar = g.one(HANGAR_ROOT)
  const room = g.one('level_sel_room')
  const shipPage = g.one(SHIP_PAGE)

  // The instance must sit at the scene origin, unrotated, unscaled — the whole
  // reason `Environment_Hangar`-local IS world here. (DEV-139 counted it so.)
  const hm = g.world(hangar)
  const identityMiss = Math.max(...hm.map((v, k) => Math.abs(v - (k % 5 === 0 ? 1 : 0))))
  if (identityMiss > 1e-6) {
    throw new Error(`convert-hangar-art: Environment_Hangar is not at identity (${identityMiss})`)
  }

  const live = g.liveWith(new Set([shipPage.key]))
  const hangarRenderers = liveRenderers(g, hangar, live)
  const roomRenderers = liveRenderers(g, room, live).filter(
    (r) => !g.under(r.object, shipPage) || /holotable_(canyon|islands|mid)$/.test(r.path),
  )

  // ── The frame ────────────────────────────────────────────────────────────
  const elevator = g.world(g.one(ELEVATOR))
  const floorY = g.world(g.one(ADJUST))[13]
  const anchor = [elevator[12], floorY, elevator[14]]
  const toRoom = translation(-anchor[0], -anchor[1], -anchor[2])
  const roomPoint = (unityWorld) => toThree(apply(toRoom, unityWorld))

  // ── Classify every live renderer, or refuse ──────────────────────────────
  const buckets = { room: [], roomLower: [], lamps: [], platform: [], shaft: [], jet: [] }
  const unclassified = []
  for (const r of hangarRenderers) {
    if (r.mesh === MESH.room) buckets.room.push(r)
    else if (r.mesh === MESH.roomLower) buckets.roomLower.push(r)
    else if (r.mesh === MESH.lamps) buckets.lamps.push(r)
    else if (r.mesh === MESH.platform && r.path.startsWith(ELEVATOR)) buckets.platform.push(r)
    else if ([MESH.walls, MESH.pipes, MESH.vent].includes(r.mesh)) buckets.shaft.push(r)
    else if (r.path.startsWith(`${JET}/`) && JET_MESHES.has(r.mesh)) buckets.jet.push(r)
    else unclassified.push(`${r.path} (${r.mesh ?? r.builtinMesh})`)
  }
  const chairRenderers = roomRenderers.filter((r) => r.path === CHAIR)
  const discRenderers = roomRenderers.filter((r) => r.path === CHAIR_DISC)
  const tableRenderers = roomRenderers.filter((r) => g.under(r.object, shipPage))
  for (const r of roomRenderers) {
    if (r.path === CHAIR || r.path === CHAIR_DISC || g.under(r.object, shipPage)) continue
    unclassified.push(`${r.path} (${r.mesh ?? r.builtinMesh})`)
  }
  const counts = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]))
  const checks = [
    [unclassified.length === 0, `live renderers with no rule: ${unclassified.join(' ; ')}`],
    [
      counts.room === 1 && counts.roomLower === 1 && counts.lamps === 1,
      `the shell moved: ${JSON.stringify(counts)}`,
    ],
    [counts.platform === 1, `expected one live lift platform, found ${counts.platform}`],
    [counts.shaft === 24, `expected 8 shaft segments x 3 meshes live, found ${counts.shaft}`],
    [counts.jet === 3, `expected the parked jet's three meshes, found ${counts.jet}`],
    [chairRenderers.length === 1 && chairRenderers[0].mesh === MESH.chair, 'the chair moved'],
    [
      discRenderers.length === 1 && discRenderers[0].builtinMesh === UNITY_CYLINDER.fileID,
      "the chair's disc is not Unity's built-in cylinder",
    ],
    [
      tableRenderers.length === 3 && tableRenderers.every((r) => r.mesh === MESH.table),
      `expected three Commander_Table_01 holotables on page_shipSelection, found ${tableRenderers.map((r) => r.mesh).join(', ')}`,
    ],
  ]
  for (const [ok, what] of checks) if (!ok) throw new Error(`convert-hangar-art: ${what}`)
  // ── DEV-437: the room's LIGHT, counted over the whole scene ─────────────
  //
  // `tools/extract/constants.mjs` reads the values of `light_ship`, `light_env`
  // and `ibl_sky` off the prefab (`PROPS.hangar`); this is the census that says
  // those are ALL of it. Every live, enabled Light and Skyshop Sky anywhere in
  // the scene, with the ship page walked as active, the way MenuManager starts
  // it — and no live renderer in the room on layer 8 (`Vehicles`), the one layer
  // `light_env`'s culling mask leaves out.
  const liveOf = (o, type) =>
    live(o) && (o.components ?? []).some((c) => c.type === type && Number(c.enabled) === 1)
  const liveLights = g.flat.objects.filter((o) => liveOf(o, 'Light')).map((o) => o.path)
  const liveSkies = g.flat.objects
    .filter(
      (o) =>
        live(o) &&
        (o.components ?? []).some((c) => c.scriptName === 'Sky' && Number(c.enabled) === 1),
    )
    .map((o) => o.path)
  const onVehicles = [...hangarRenderers, ...roomRenderers].filter((r) => r.object.layer === 8)
  const lightChecks = [
    [
      JSON.stringify(liveLights.sort()) ===
        JSON.stringify([`${HANGAR_ROOT}/light_ship`, `${HANGAR_ROOT}/sky/ibl_sky/light_env`]),
      `the room's live lights moved: ${JSON.stringify(liveLights)}`,
    ],
    [
      JSON.stringify(liveSkies) === JSON.stringify([`${HANGAR_ROOT}/sky/ibl_sky`]),
      `the room's live Skyshop skies moved: ${JSON.stringify(liveSkies)}`,
    ],
    [
      onVehicles.length === 0,
      `live renderers on layer 8, which light_env does not light: ${onVehicles.map((r) => r.path).join(', ')}`,
    ],
  ]
  for (const [ok, what] of lightChecks) if (!ok) throw new Error(`convert-hangar-art: ${what}`)

  const one = (bucket) => {
    const r = bucket[0]
    if (r.materials.length !== 1)
      throw new Error(`convert-hangar-art: ${r.path} wears ${r.materials.length} materials`)
    return r
  }
  const windings = {}

  // ── room + roomLower: Marmoset VertexColor Diffuse ───────────────────────
  const piece = (r, meshRel) => {
    const d = decoded(meshRel)
    const rule = marmoset(r.materials[0], guids)
    const placed = place(d, mul(toRoom, r.matrix), byMarmoset(d.mesh, rule))
    windings[r.path] = placed.winding
    return { placed, rule, d }
  }
  const roomPiece = piece(one(buckets.room), MESH.room)
  const lowerPiece = piece(one(buckets.roomLower), MESH.roomLower)
  const platformPiece = piece(one(buckets.platform), MESH.platform)

  // ── lamps: SLK self-illum, the texture baked to one colour a face ─────────
  const lampR = one(buckets.lamps)
  const lampMat = texturedMaterial(lampR.materials[0], guids)
  const tex = importedTexture(lampMat.texture)
  const lampD = decoded(MESH.lamps)
  const lampColour = lampMat.colorSrgb.map(srgbToLinear)
  const faceColour = []
  {
    const { mesh } = lampD
    const uv = (v) => [
      mesh.uv0[v * 2] * lampMat.scale[0] + lampMat.offset[0],
      mesh.uv0[v * 2 + 1] * lampMat.scale[1] + lampMat.offset[1],
    ]
    // Fifteen barycentric points over each face's UV triangle — the texture
    // the face would have shown, reduced to the one colour a facet gets.
    const bary = []
    for (let a = 0; a <= 4; a++)
      for (let b = 0; b <= 4 - a; b++) bary.push([a / 4, b / 4, (4 - a - b) / 4])
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [A, B, C] = [uv(mesh.indices[t]), uv(mesh.indices[t + 1]), uv(mesh.indices[t + 2])]
      const sum = [0, 0, 0]
      for (const [wa, wb, wc] of bary) {
        const s = tex.sample(wa * A[0] + wb * B[0] + wc * C[0], wa * A[1] + wb * B[1] + wc * C[1])
        for (let c = 0; c < 3; c++) sum[c] += s[c] / bary.length
      }
      faceColour.push(sum.map((s, c) => s * lampColour[c]))
    }
  }
  const lampPlaced = place(lampD, mul(toRoom, lampR.matrix), (_v, face) => faceColour[face], {
    perFace: true,
  })
  windings[lampR.path] = lampPlaced.winding

  // ── the shaft: segment 01's three meshes, and seven pure lifts of it ─────
  const segmentOf = (r) => r.path.match(/ent_elevatorShaft_(\d+)\//)?.[1]
  const segments = [...new Set(buckets.shaft.map(segmentOf))].sort()
  if (segments.length !== 8)
    throw new Error(`convert-hangar-art: ${segments.length} shaft segments, not 8`)
  const first = buckets.shaft.filter((r) => segmentOf(r) === segments[0])
  const shaftPieces = []
  let shaftRule = null
  for (const r of first) {
    const d = decoded(r.mesh)
    const rule = marmoset(r.materials[0], guids)
    shaftRule = rule
    const placed = place(d, mul(toRoom, r.matrix), byMarmoset(d.mesh, rule))
    windings[r.path] = placed.winding
    shaftPieces.push(placed)
  }
  const repeats = segments.map((s) => {
    const lifts = buckets.shaft
      .filter((r) => segmentOf(r) === s)
      .map((r) => {
        const base = first.find((f) => f.mesh === r.mesh)
        const rotScaleMiss = Math.max(
          ...[0, 1, 2, 4, 5, 6, 8, 9, 10].map((k) => Math.abs(r.matrix[k] - base.matrix[k])),
        )
        const d = [
          r.matrix[12] - base.matrix[12],
          r.matrix[13] - base.matrix[13],
          r.matrix[14] - base.matrix[14],
        ]
        if (rotScaleMiss > 1e-5 || Math.abs(d[0]) > 1e-4 || Math.abs(d[2]) > 1e-4) {
          throw new Error(
            `convert-hangar-art: shaft segment ${s} is not a pure lift of segment ${segments[0]}`,
          )
        }
        return d[1]
      })
    if (Math.max(...lifts) - Math.min(...lifts) > 1e-4) {
      throw new Error(
        `convert-hangar-art: shaft segment ${s}'s three meshes lift by different amounts`,
      )
    }
    return round(lifts[0])
  })

  // ── the room frame's own facts, for the renderer and the tests ───────────
  const eyeObj = g.one(EYE)
  const eyeM = g.world(eyeObj)
  const eyeUnity = [eyeM[12], eyeM[13], eyeM[14]]
  const lookUnity = applyDir(eyeM, [0, 0, 1])
  const lookLen = Math.hypot(...lookUnity)
  const cube = g.one(ELEVATOR_CUBE)
  const cubeM = g.world(cube)
  const cubeCorners = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ].map(([x, z]) => r3(roomPoint(apply(cubeM, [x, 0.5, z]))))
  const jetM = g.world(g.one(JET))

  const roomGlb = buildGlb({
    root: 'hangar-room',
    extras: {
      dev: 'DEV-430',
      source: `${SCENE}: Environment_Hangar.prefab (the instance at identity) — ${[MESH.room, MESH.roomLower, MESH.lamps, MESH.platform, MESH.walls, MESH.pipes, MESH.vent].join(' ; ')}`,
      frame:
        "ROOM frame, three space, metres: origin on the Elevator's x/z at Position_adjustment's y (the floor); Unity z negated, winding reversed; unrotated from Unity world",
      flatShadedOnly:
        'no NORMAL: the winding was verified against Unity normals and they were dropped',
      anchorUnity: r3(anchor),
      eye: r3(roomPoint(eyeUnity)),
      look: r3(toThree(lookUnity.map((v) => v / lookLen))),
      jet: r3(roomPoint([jetM[12], jetM[13], jetM[14]])),
      chairPivot: r3(
        roomPoint([
          g.world(g.one(CHAIR))[12],
          g.world(g.one(CHAIR))[13],
          g.world(g.one(CHAIR))[14],
        ]),
      ),
      elevatorDeck: {
        note: "Unity's own Cube under Elevator_animator (renderer off, BoxCollider on): its top face's corners",
        corners: cubeCorners,
      },
      shaftRepeats: repeats,
    },
    parts: [
      {
        name: 'room',
        ...merge([roomPiece.placed]),
        material: roomMaterial('botfloor_shaft_pwm_Mat', roomPiece.rule),
        extras: { unity: { mesh: MESH.room, vertexCount: roomPiece.d.vertexCount } },
      },
      {
        name: 'roomLower',
        ...merge([lowerPiece.placed]),
        material: roomMaterial('botfloor_shaft_pwm_Mat', lowerPiece.rule),
        extras: { unity: { mesh: MESH.roomLower, vertexCount: lowerPiece.d.vertexCount } },
      },
      {
        name: 'platform',
        ...merge([platformPiece.placed]),
        material: roomMaterial('lambert1', platformPiece.rule),
        extras: { unity: { mesh: MESH.platform, vertexCount: platformPiece.d.vertexCount } },
      },
      {
        name: 'shaft',
        ...merge(shaftPieces),
        material: roomMaterial('ent_elevatorShaft_pwn_Mat', shaftRule),
        extras: { unity: { meshes: [MESH.walls, MESH.pipes, MESH.vent], segment: segments[0] } },
      },
      {
        name: 'lamps',
        ...merge([lampPlaced]),
        material: {
          name: lampMat.name,
          pbrMetallicRoughness: {
            baseColorFactor: [1, 1, 1, 1],
            metallicFactor: 0,
            roughnessFactor: 1,
          },
          extras: {
            emissive: true,
            unity: {
              ...lampMat,
              importedSize: [tex.width, tex.height],
              pngSize: [tex.sourceWidth, tex.sourceHeight],
            },
          },
        },
        extras: { unity: { mesh: MESH.lamps, vertexCount: lampD.vertexCount } },
      },
    ],
  })

  // ── the chair, in its own frame at its 2016 world scale ──────────────────
  const chairR = chairRenderers[0]
  const chairD = decoded(MESH.chair)
  const chairRule = marmoset(chairR.materials[0], guids)
  const chairM = chairR.matrix
  // Its own frame: the world matrix with the rotation and translation taken out,
  // the SCALE left in — 1.7 in the scene (level_sel_room 2 x chair 0.85).
  const chairScale = [0, 1, 2].map((c) =>
    Math.hypot(chairM[c * 4], chairM[c * 4 + 1], chairM[c * 4 + 2]),
  )
  const chairRot = [
    chairM[0] / chairScale[0],
    chairM[1] / chairScale[0],
    chairM[2] / chairScale[0],
    0,
    chairM[4] / chairScale[1],
    chairM[5] / chairScale[1],
    chairM[6] / chairScale[1],
    0,
    chairM[8] / chairScale[2],
    chairM[9] / chairScale[2],
    chairM[10] / chairScale[2],
    0,
    chairM[12],
    chairM[13],
    chairM[14],
    1,
  ]
  const toChair = invert(chairRot)
  const chairPlaced = place(chairD, mul(toChair, chairM), byMarmoset(chairD.mesh, chairRule))
  windings[chairR.path] = chairPlaced.winding
  const discM = mul(toChair, discRenderers[0].matrix)
  const discScale = [0, 1, 2].map((c) =>
    Math.hypot(discM[c * 4], discM[c * 4 + 1], discM[c * 4 + 2]),
  )
  const inChair = (unityWorld) => r3(toThree(apply(toChair, unityWorld)))
  const chairGlb = buildGlb({
    root: 'commander-chair',
    extras: {
      dev: 'DEV-430',
      source: `${SCENE}: ${CHAIR} (${MESH.chair}, ${chairR.materials[0]})`,
      frame:
        "the CHAIR's own frame at its 2016 world scale (1.7), three space; flat-shaded only (no NORMAL)",
      scale: r3(chairScale),
      eye: inChair(eyeUnity),
      look: r3(
        toThree(
          applyDir(
            toChair,
            lookUnity.map((v) => v / lookLen),
          ),
        ),
      ),
      floor: round(floorY - chairM[13]),
      disc: {
        note: "Unity's OWN built-in cylinder (fileID 10206, Default-Material): not copied, drawn from these numbers",
        centre: inChair(apply(discRenderers[0].matrix, [0, 0, 0])),
        radius: round(UNITY_CYLINDER.radius * Math.max(discScale[0], discScale[2])),
        halfHeight: round(UNITY_CYLINDER.halfHeight * discScale[1]),
      },
    },
    parts: [
      {
        name: 'chair',
        ...merge([chairPlaced]),
        material: roomMaterial('MM_level_sel_room', chairRule),
        extras: { unity: { mesh: MESH.chair, vertexCount: chairD.vertexCount } },
      },
    ],
  })

  // ── the holotable: ONE copy, its own frame, at 2016's world scale ────────
  const tableD = decoded(MESH.table)
  const tableRule = marmoset(tableRenderers[0].materials[0], guids)
  const tableScales = tableRenderers.map((r) =>
    [0, 1, 2].map((c) => Math.hypot(r.matrix[c * 4], r.matrix[c * 4 + 1], r.matrix[c * 4 + 2])),
  )
  const scaleMiss = Math.max(
    ...tableScales.flatMap((s) => s.map((v, k) => Math.abs(v - tableScales[0][k]))),
  )
  if (scaleMiss > 1e-4) throw new Error('convert-hangar-art: the three holotables differ in scale')
  const s = tableScales[0]
  const tableScaleM = [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1]
  const tablePlaced = place(tableD, tableScaleM, byMarmoset(tableD.mesh, tableRule))
  windings[tableRenderers[0].path] = tablePlaced.winding
  // Which way a 2016 table's own frame faced the eye: the eye in each table's
  // frame, horizontal and unit. Measured over all three, reported separately.
  const toSeat = tableRenderers.map((r) => {
    const m = r.matrix
    const sc = [0, 1, 2].map((c) => Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]))
    const rot = [...m]
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) rot[c * 4 + k] = m[c * 4 + k] / sc[c]
    const e = toThree(apply(invert(rot), eyeUnity))
    const len = Math.hypot(e[0], e[2])
    return {
      table: r.path.split('/').pop(),
      direction: r3([e[0] / len, 0, e[2] / len]),
      distance: round(len),
    }
  })
  const tableGlb = buildGlb({
    root: 'commander-table',
    extras: {
      dev: 'DEV-430',
      source: `${SCENE}: ${SHIP_PAGE} holotable_{canyon,islands,mid} (${MESH.table}, ${tableRenderers[0].materials[0]})`,
      frame:
        "the TABLE's own frame at its 2016 world scale, three space; flat-shaded only (no NORMAL)",
      scale: r3(s),
      toSeat,
    },
    parts: [
      {
        name: 'table',
        ...merge([tablePlaced]),
        material: roomMaterial('MM_level_sel_room', tableRule),
        extras: { unity: { mesh: MESH.table, vertexCount: tableD.vertexCount } },
      },
    ],
  })

  // A reversed winding agrees on ~0 % of the area; see `windingAgreement`.
  const worst = Math.min(...Object.values(windings).map((w) => w.areaAgreeing))
  if (worst < 0.99) {
    throw new Error(
      `convert-hangar-art: a winding disagrees with its own normals over ${((1 - worst) * 100).toFixed(1)} % of its area: ${JSON.stringify(windings)}`,
    )
  }

  // ── DEV-456: the shaft's OWN painted colours, a second file ──────────────
  //
  // Matt, 2026-09-27: *"it looks like the elevator shaft stops using it's vertex
  // colors when just above the hangar."* It does, and 2016 is why: the three
  // shaft meshes are PolyWorld conversions that CARRY vertex colours (walls 156
  // distinct, pipes 109, vent 33), but `ent_elevatorShaft_pwn_Mat` is Marmoset's
  // plain Specular IBL, whose `#define MARMO_VERTEX_COLOR` is commented out — so
  // 2016 drew the shaft in `_Color` alone, and so does `hangar-room.glb` above.
  // The room and the stepped lower shaft wear the Vertex Color variant, so the
  // paint stops exactly where their mesh does.
  //
  // Matt, told why: *"shaft should keep it's hangar colors - consider it a decade
  // old bug fix."* So the shaft segment is written a second time into a NEW file
  // (`hangar-room.glb` keeps 2016's bytes): the same vertices in the same order
  // and the same ROOM frame, so the renderer swaps COLOR_0 and nothing else —
  // painted as the HANGAR is, its own vertex colours times the room's
  // `botfloor_shaft_pwm_Mat` `_Color`, as if it wore the room's material. Its
  // own `_Color` instead (the Vertex Color variant of its own material) came out
  // maroon, chroma r:g:b 0.41:0.28:0.31 against the room's 0.27:0.30:0.43, and
  // was not the room's colour; this one is 0.28:0.30:0.43.
  const paintedRoom = []
  const asRoom = { ...roomPiece.rule, vertexColour: true }
  for (const r of first) {
    const d = decoded(r.mesh)
    paintedRoom.push(place(d, mul(toRoom, r.matrix), byMarmoset(d.mesh, asRoom)))
  }
  const paintedMaterial = (name, rule) => ({
    name,
    pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
    extras: {
      baked: 'COLOR_0 carries the mesh vertex colour x linear _Color, whatever the shader read',
      unity: { ...rule.record, readsVertexColour: rule.vertexColour, paintedBy: 'DEV-456' },
    },
  })
  const paintedGlb = buildGlb({
    root: 'hangar-shaft-painted',
    extras: {
      dev: 'DEV-456',
      source: `${SCENE}: ${[MESH.walls, MESH.pipes, MESH.vent].join(' ; ')} of ent_elevatorShaft_${segments[0]}, painted`,
      frame: "hangar-room.glb's ROOM frame; the same vertices in the same order as its `shaft`",
      shaftRepeats: repeats,
    },
    parts: [
      {
        name: 'shaft',
        ...merge(paintedRoom),
        material: paintedMaterial('botfloor_shaft_pwm_Mat', asRoom),
        extras: { unity: { meshes: [MESH.walls, MESH.pipes, MESH.vent], segment: segments[0] } },
      },
    ],
  })

  const files = {
    room: roomGlb,
    chair: chairGlb,
    table: tableGlb,
    shaftPainted: paintedGlb,
  }
  const sha = (b) => createHash('sha256').update(b).digest('hex')
  return {
    files,
    report: {
      anchorUnity: anchor,
      counts: { ...counts, chair: 1, disc: 1, tables: tableRenderers.length },
      shaftRepeats: repeats,
      roomBounds: bounds(roomPiece.placed.position),
      lamps: {
        texture: lampMat.texture,
        imported: [tex.width, tex.height],
        png: [tex.sourceWidth, tex.sourceHeight],
      },
      shaderReadsVertexColour: {
        room: roomPiece.rule.vertexColour,
        platform: platformPiece.rule.vertexColour,
        shaft: shaftRule.vertexColour,
        chair: chairRule.vertexColour,
        table: tableRule.vertexColour,
      },
      tableToSeat: toSeat,
      winding: { leastAreaAgreeing: worst, byRenderer: windings },
      outputs: Object.fromEntries(
        Object.entries(files).map(([k, b]) => [
          HANGAR_ART_OUT[k],
          { bytes: b.length, sha256: sha(b) },
        ]),
      ),
    },
  }
}

/** A glTF material for a baked-colour part: white, the source's numbers in extras. */
function roomMaterial(name, rule) {
  return {
    name,
    pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
    extras: {
      baked: 'COLOR_0 already carries (vertex colour, if the shader reads it) x linear _Color',
      unity: { ...rule.record, readsVertexColour: rule.vertexColour },
    },
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

// The tail (report, --report, --check, the --force refusal, write, exit codes
// 0/3/4) is glb-cli.mjs's, shared with the other converters. Four outputs, so
// no --out here.
if (isMain(import.meta.url)) runConverter({ build: buildHangarArt, outputs: HANGAR_ART_OUT })
