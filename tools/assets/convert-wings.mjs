#!/usr/bin/env node
// tools/assets/convert-wings.mjs — the HoverJet's anti-grav wings, PORTED.
//
// DEV-322. Matt, 2026-09-23, on DEV-310's first-party rebuild: *"right idea,
// but port the actual art from the other game as opposed to making your own."*
//
//   node tools/assets/convert-wings.mjs            write public/assets/ships/hoverjet-wings.glb
//   node tools/assets/convert-wings.mjs --check    build it in memory, compare to the file on disk
//   node tools/assets/convert-wings.mjs --out <f>  write somewhere else
//   node tools/assets/convert-wings.mjs --force    overwrite a file whose bytes differ (exit 4 otherwise)
//
// READ-ONLY on `$FF2_LEGACY` (hard rule 1). The GLB it writes is bought Asset
// Store geometry kitbashed by Matt: it ships to players from R2 and it NEVER
// goes in git (hard rule 7). `public/` is gitignored; `pnpm assets:push` is
// Matt's.
//
// ── What the part is, from the files ─────────────────────────────────────
//
// `GhostRacer.prefab` (the AI opposition's own prefab, every live node authored
// ACTIVE — DEV-310's reason for preferring it) hangs the hull and the wing off
// ONE parent, `GhostRider_01`, both at its origin and identity rotation:
//
//     GhostRider_01/
//       hoverJet_exterior_blue          identity             <- the hull
//       anti-grav_rightWing             identity
//         Projector04-Faceted  x6       m_IsActive 0         (the parts, switched off)
//         Mesh1-Combined/Mesh1-Combined Projector04_Mat      <- six projectors, combined
//         Mesh2-Combined/Mesh2-Combined glowyMaterial        <- ten glow pieces, combined
//       glowyBits/glowyBit x10          active, each a Unity Halo (not ported here)
//
// Matt's memory of it: *"holo-tables flipped upside down to look like anti-grav
// generators under the wings. spheres stuffed in the engines to glow."* Both
// are in the numbers below, and this tool REFUSES to write a file if any of
// them moves:
//
//   * `Mesh1-Combined` is 5,616 vertices in SIX connected parts, each exactly
//     `Projector04-Faceted.asset`'s own vertex count (936).
//   * `Mesh2-Combined` is 1,806 vertices / 3,480 indices in TEN parts — not the
//     "6 x 301" the NEXT.md row predicted, which is arithmetic that happens to
//     divide. Seven parts of 180 and three of 182, and their centroids are the
//     ten `glowyBit` positions of the same prefab to the millimetre: six discs
//     in the six projectors, three in the engines, one at the nose.
//
// **One wing node, not two.** `PlayerShip_SR14_Photon.prefab`'s ThirdPerson
// branch does carry a second `anti-grav_rightWing` at Unity scale (1, 1, -1) —
// and its `m_Children` is `[]`. It draws nothing. Both combined meshes already
// span both sides of the ship (Mesh1's local z runs -2.84..+2.88), so a
// mirrored second copy would double every piece, inside out.
//
// ── The frame, and the ONE mirror ────────────────────────────────────────
//
// Every vertex is composed through its own prefab chain (`Mesh*-Combined` outer
// then inner, read from the prefab, never typed) into the wing's parent frame —
// which is the HULL's frame, because the hull sits at that parent's origin. It
// is then taken to three space the way the rest of the port takes Unity data:
// **negate z** (positions and normals; `render/unity-space.ts`) and **reverse
// the winding**, because a single negation is a mirror and a mirror turns
// every face inside out (DEV-044, the orientation lesson).
//
// So the GLB's vertices are in the SAME frame as `hoverjet-exterior.glb`'s, and
// the renderer hangs the wing off the hull's art object at identity — exactly
// as both 2016 prefabs hang it off the hull's parent. `ART_POSITION`,
// `SHIP_MODEL_YAW` and `ART_SCALE` then reach the wing through the hull, and
// DEV-310's inverse-matrix group has nothing left to do.
//
// (The hull GLB is Unity's mesh-local frame WITHOUT the z negation —
// `convert-fbx.py`'s `unmirror_x` — and the two agree only because the hull is
// symmetric in its mesh-local z, which is the beam. The wing is NOT symmetric:
// the inboard pair of projectors are 0.1496 and 0.1632 in scale, so the frame
// this file writes is the one where the difference shows up on the right side.
// `tests/unit/hover-glow.test.ts` measures which side.)
//
// ── What the file carries besides geometry ───────────────────────────────
//
// Vertex colour on the projectors only, as float VEC3 — Unity `Color32` with an
// alpha byte of 1 (the 1/255 trap), so alpha is dropped rather than carried,
// and the bytes go in RAW, the reading `render/lambert1.ts` records for vertex
// colour on this shader family (DEV-014). `Projector04_Mat`'s own numbers ride
// in the material's `extras.unity`, read from the `.mat` — the renderer builds
// the material from them. The glow carries no colour: it wears
// `glowyMaterial`, which is the gate stud material and is already in the sheet.

import { createHash } from 'node:crypto'
import { legacyPath } from '../legacy-root.mjs'
import { activeOf, graphOf } from '../unity/graph.mjs'
import { loadGuidIndex } from '../unity/guid-index.mjs'
import { rawColour, rawFloat } from '../unity/material.mjs'
import { readUnityText, unityYaml } from '../unity/yaml.mjs'
import { buildGlb, toThreeHullFrame, worstWindingDisagreement } from './glb.mjs'
import { isMain, runConverter } from './glb-cli.mjs'
import { connectedParts, loadMeshAsset } from './unity-mesh-asset.mjs'

export const WINGS_OUT = 'assets/ships/hoverjet-wings.glb'
export const GHOST_RACER =
  'Assets/Faceted Flight/Prefabs/legacy_root_prefabs/PreFabs/GhostRacer.prefab'
export const PROJECTOR_ASSET =
  'Assets/Faceted Flight/Meshes/Converted_Faceted_Meshes/Projector04-Faceted.asset'

// ── Unity YAML ─────────────────────────────────────────────────────────────
//
// `tools/prototype/unity_yaml.js` is CommonJS under a `"type": "module"`
// package; tools/unity/yaml.mjs evaluates it in a CJS wrapper (TL-1: the one loader).

const { parseDocuments } = unityYaml()

const guidIndex = () => loadGuidIndex().guidToPath

/**
 * The prefab as a graph: GameObjects, their transforms, and their components.
 *
 * Handles both component-list dialects (`- component: {fileID}` and the old
 * `- 4: {fileID}`), because the old one reads as ABSENCE (CLAUDE.md, DEV-043).
 */
export const readPrefab = (relPath) =>
  graphOf(parseDocuments(readUnityText(legacyPath(relPath), { lf: true })))

/** A Unity TRS as a column-major 4x4 (same layout as three's `Matrix4.elements`). */
export const unityTrs = (tf) => {
  const p = tf.data.m_LocalPosition
  const q = tf.data.m_LocalRotation
  const s = tf.data.m_LocalScale
  const [x, y, z, w] = [Number(q.x), Number(q.y), Number(q.z), Number(q.w)]
  const [sx, sy, sz] = [Number(s.x), Number(s.y), Number(s.z)]
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
    r[0] * sx,
    r[1] * sx,
    r[2] * sx,
    0,
    r[3] * sy,
    r[4] * sy,
    r[5] * sy,
    0,
    r[6] * sz,
    r[7] * sz,
    r[8] * sz,
    0,
    Number(p.x),
    Number(p.y),
    Number(p.z),
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

/**
 * Every LIVE mesh renderer under `anti-grav_rightWing` in `GhostRider_01`.
 *
 * Live means the liveness walk CLAUDE.md asks for: the GameObject and every
 * ancestor below the wing `m_IsActive: 1`, and the `MeshRenderer` itself
 * `m_Enabled: 1`. The six loose `Projector04-Faceted` children fail it, which is
 * the point: they are the parts the combined mesh was built from.
 */
export const liveWingRenderers = (prefab = readPrefab(GHOST_RACER), guids = guidIndex()) => {
  const rider = prefab.docs.find((d) => d.classId === 1 && prefab.nameOf(d) === 'GhostRider_01')
  if (!rider) throw new Error('convert-wings: no GhostRider_01 in GhostRacer.prefab')
  const riderTf = prefab.tfOf(rider)
  const wingTf = prefab
    .children(riderTf)
    .find((tf) => prefab.nameOf(prefab.goOf(tf)) === 'anti-grav_rightWing')
  if (!wingTf) throw new Error('convert-wings: no anti-grav_rightWing under GhostRider_01')
  const wingGo = prefab.goOf(wingTf)
  if (activeOf(wingGo) !== 1) throw new Error('convert-wings: the wing is inactive')
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const wingPose = unityTrs(wingTf)
  const out = []
  const skipped = []
  const walk = (tf, toWing, path) => {
    for (const child of prefab.children(tf)) {
      const go = prefab.goOf(child)
      const name = prefab.nameOf(go)
      const here = `${path}/${name}`
      const matrix = mul(toWing, unityTrs(child))
      if (activeOf(go) !== 1) {
        skipped.push(here)
        continue
      }
      const comps = prefab.componentsOf(go)
      const filter = comps.find((d) => d.classId === 33)
      const renderer = comps.find((d) => d.classId === 23)
      if (filter && renderer && Number(renderer.data.m_Enabled) === 1) {
        const meshGuid = filter.data.m_Mesh?.guid
        const materials = (renderer.data.m_Materials ?? []).map((m) => guids.get(m.guid) ?? m.guid)
        out.push({ path: here, mesh: guids.get(meshGuid) ?? meshGuid, materials, matrix })
      }
      walk(child, matrix, here)
    }
  }
  walk(wingTf, identity, 'anti-grav_rightWing')
  return { renderers: out, skipped, wingPose }
}

/** `_Color`, `_Shininess`, `_SpecInt` and the shader path off a Unity material. */
export const readMaterial = (relPath, guids = guidIndex()) => {
  const text = readUnityText(legacyPath(relPath), { lf: true })
  const doc = parseDocuments(text).find((d) => d.classId === 21)
  if (!doc) throw new Error(`convert-wings: no Material in ${relPath}`)
  // The properties are read off the raw text (tools/unity/material.mjs): the parser reads the
  // old dialect's repeated `data:` keys as one (TL-7, DEV-043).
  const color = rawColour(text, '_Color')
  return {
    path: relPath,
    name: String(doc.data.m_Name),
    shader: guids.get(doc.data.m_Shader?.guid) ?? null,
    colorSrgb: color ? color.value.slice(0, 3) : null,
    shininess: Number(rawFloat(text, '_Shininess')?.value),
    specInt: Number(rawFloat(text, '_SpecInt')?.value),
  }
}

// ── The conversion ─────────────────────────────────────────────────────────

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** Build the wings, verified, as GLB bytes plus a report. Reads Unity; writes nothing. */
export const buildWings = () => {
  const guids = guidIndex()
  const { renderers, skipped } = liveWingRenderers(readPrefab(GHOST_RACER), guids)
  const byMesh = (suffix) => {
    const hits = renderers.filter((r) => r.mesh?.endsWith(suffix))
    if (hits.length !== 1) {
      throw new Error(`convert-wings: expected one live ${suffix}, found ${hits.length}`)
    }
    return hits[0]
  }
  if (renderers.length !== 2) {
    throw new Error(
      `convert-wings: expected exactly two live renderers under the wing, found ${renderers.length}: ${renderers.map((r) => r.path).join(', ')}`,
    )
  }
  const projectorsR = byMesh('/Mesh1-Combined.asset')
  const glowR = byMesh('/Mesh2-Combined.asset')

  const projectorPart = loadMeshAsset(legacyPath(PROJECTOR_ASSET)).parsed.vertexCount
  const m1 = loadMeshAsset(legacyPath(projectorsR.mesh))
  const m2 = loadMeshAsset(legacyPath(glowR.mesh))

  // ── the counts, as the refusal ──
  const p1 = connectedParts(m1.mesh.position, m1.mesh.indices, 1e-4)
  const p2 = connectedParts(m2.mesh.position, m2.mesh.indices, 1e-4)
  const checks = [
    [
      m1.parsed.vertexCount === 6 * projectorPart,
      `Mesh1 has ${m1.parsed.vertexCount} verts, not 6 x ${projectorPart}`,
    ],
    [
      p1.length === 6 && p1.every((q) => q.length === projectorPart),
      `Mesh1 parts ${p1.map((q) => q.length)}`,
    ],
    [m2.parsed.vertexCount === 1806, `Mesh2 has ${m2.parsed.vertexCount} verts`],
    [m2.mesh.indices.length === 3480, `Mesh2 has ${m2.mesh.indices.length} indices`],
    [p2.length === 10, `Mesh2 has ${p2.length} parts`],
    [
      projectorsR.materials[0]?.endsWith('/Projector04_Mat.asset'),
      `Mesh1 wears ${projectorsR.materials}`,
    ],
    [glowR.materials[0]?.endsWith('/glowyMaterial.mat'), `Mesh2 wears ${glowR.materials}`],
  ]
  for (const [ok, what] of checks) if (!ok) throw new Error(`convert-wings: ${what}`)

  const mat = readMaterial(projectorsR.materials[0], guids)
  const t1 = toThreeHullFrame(m1.mesh, projectorsR.matrix)
  const t2 = toThreeHullFrame(m2.mesh, glowR.matrix)
  for (const [name, t] of [
    ['projectors', t1],
    ['glow', t2],
  ]) {
    const worst = worstWindingDisagreement(t)
    if (worst > 1e-3)
      throw new Error(`convert-wings: ${name} winding disagrees with its normals by ${worst}`)
  }
  // Raw bytes, alpha dropped: the Color32 alpha here is 1/255 (see header).
  const colour = new Float32Array(m1.parsed.vertexCount * 3)
  for (let v = 0; v < m1.parsed.vertexCount; v++) {
    for (let k = 0; k < 3; k++) colour[v * 3 + k] = m1.mesh.color[v * 4 + k] / 255
  }
  const linear = mat.colorSrgb.map(srgbToLinear)
  const parts = [
    {
      name: 'projectors',
      ...t1,
      color: colour,
      material: {
        name: mat.name,
        pbrMetallicRoughness: {
          baseColorFactor: [...linear, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        extras: { unity: mat },
      },
      extras: { unity: { mesh: projectorsR.mesh, prefabPath: projectorsR.path, parts: p1.length } },
    },
    {
      name: 'glow',
      ...t2,
      material: {
        name: 'glowyMaterial',
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        extras: {
          unity: {
            path: glowR.materials[0],
            note: 'the gate stud material; the renderer paints it from the sheet',
          },
        },
      },
      extras: { unity: { mesh: glowR.mesh, prefabPath: glowR.path, parts: p2.length } },
    },
  ]
  const glb = buildGlb({
    parts,
    root: 'wings',
    extras: {
      dev: 'DEV-322',
      source: `${GHOST_RACER} GhostRider_01/anti-grav_rightWing`,
      frame: 'the hull GLB frame, three space (Unity z negated, winding reversed)',
    },
  })
  return {
    glb,
    report: {
      skipped,
      renderers: renderers.map((r) => ({ path: r.path, mesh: r.mesh, materials: r.materials })),
      projectorPart,
      projectorParts: p1.map((q) => q.length),
      glowParts: p2.map((q) => q.length),
      material: mat,
      bytes: glb.length,
      sha256: createHash('sha256').update(glb).digest('hex'),
    },
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

// The tail (report, --check, the --force refusal of DEV-680, write, exit codes
// 0/3/4) is glb-cli.mjs's, shared with the other converters.
if (isMain(import.meta.url)) {
  runConverter({
    build: () => {
      const { glb, report } = buildWings()
      return { files: { glb }, report }
    },
    outputs: { glb: WINGS_OUT },
  })
}
