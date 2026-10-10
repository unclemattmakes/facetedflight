#!/usr/bin/env node
// tools/assets/convert-jumpseat-cone.mjs — the JumpSeat's engine cones, PORTED.
//
// DEV-433. Matt, 2026-09-26: *"plz verify that the jumpseat art matches the old
// jumpseat prefab exactly."* It did not: under each of the seat's three hover
// engines 2016 draws an upturned `Projector04` holo-table around the glowing
// disc, and the port skipped all three on a reason — "bought geometry, cannot
// ship" — that hard rule 7 stopped being true of on 2026-09-23.
//
//   node tools/assets/convert-jumpseat-cone.mjs            write public/assets/ships/projector04-faceted.glb
//   node tools/assets/convert-jumpseat-cone.mjs --check    build it in memory, compare to the file on disk
//   node tools/assets/convert-jumpseat-cone.mjs --out <f>  write somewhere else
//
// READ-ONLY on `$FF2_LEGACY` (hard rule 1). The GLB is bought Asset Store
// geometry put through a VacuumShaders faceting pass: it ships to players from
// R2 and it NEVER goes in git (hard rule 7). `public/` is gitignored; the push
// is one `rclone copy` of this file (docs/asset-storage.md §8), and it is not
// this tool's to make.
//
// ── Why this is not `convert-fbx.py` ─────────────────────────────────────
//
// The cone is `Meshes/Converted_Faceted_Meshes/Projector04-Faceted.asset`: a
// Unity TEXT-YAML `Mesh` asset (the faceting pass's output), not an FBX. Blender
// cannot open it, and UnityPy returns NOTHING for a text asset — an empty parse
// that reads exactly like a missing file. `unity-mesh-asset.mjs` (DEV-322) is
// the reader, and `convert-wings.mjs` already reads this very mesh: the
// HoverJet's wing is six copies of it, combined.
//
// ── What 2016 draws, from the prefab ─────────────────────────────────────
//
// `JumpSeat_Photon.prefab`, the liveness walk (every ancestor `m_IsActive: 1`
// and the renderer's own `m_Enabled: 1`):
//
//     offset/art_pivot (1)/art_firstPerson/testArt (2)/
//       hover_engine (1..3)/                        uniform scale 0.465
//         Sphere (1)                                the glowing disc (built-in)
//         Projector04-Faceted (2)                   THIS mesh, Projector04_Mat,
//                                                   local y +0.2, turned over
//
// Exactly three, one per engine, and this tool REFUSES to write if that moves.
// (`art_thirdPerson/testArt (3)` holds a second three, identical to 4e-8, which
// `CamChanger` switches on in the chase view in place of these; authored off, so
// the walk does not count them. DEV-433's row has the comparison.)
//
// ── The frame: MESH-LOCAL, in three space ────────────────────────────────
//
// ONE copy of the mesh, in its own frame, with Unity's z negated on positions
// and normals and every triangle's winding reversed — a single negation is a
// mirror, and a mirror turns every face inside out (DEV-044). That is the
// frame the renderer's Unity->three rule expects of a mesh it then places with
// a Unity transform: position z negated, quaternion (-x, -y, z, w), scale as
// is. `game/jumpseat-art.ts` places it three times from the sheet's
// `JUMPSEAT.art.engines[].projector.composed`, by exactly the rule its discs
// already use, and `tests/unit/jumpseat-art.test.ts` measures each cone
// against its own disc.
//
// ── What the file carries besides geometry ───────────────────────────────
//
// Vertex colour as float VEC3, the raw Color32 bytes over 255 — the alpha byte
// is 1/255 (CLAUDE.md's Color32 trap) and is dropped rather than carried.
// `Projector04_Mat`'s own numbers ride in the material's `extras.unity`, read
// from the `.asset`, and `render/hover-glow.ts`'s `projectorMaterial` builds
// the material from them — the same material the wing's projectors wear. And
// the root node's extras carry the mesh's own `m_LocalAABB`, Unity's number,
// which the refusal below checks the decode against and the unit test checks
// the three-space vertices against.

import { createHash } from 'node:crypto'
import { legacyPath } from '../legacy-root.mjs'
import { chainIsLive, chainUp } from '../unity/graph.mjs'
import { loadGuidIndex } from '../unity/guid-index.mjs'
import { PROJECTOR_ASSET, readMaterial, readPrefab } from './convert-wings.mjs'
import { buildGlb, toThreeHullFrame, worstWindingDisagreement } from './glb.mjs'
import { isMain, runConverter } from './glb-cli.mjs'
import { connectedParts, loadMeshAsset } from './unity-mesh-asset.mjs'

export const CONE_OUT = 'assets/ships/projector04-faceted.glb'
export const JUMPSEAT_PREFAB = 'Assets/Faceted Flight/Resources/JumpSeat_Photon.prefab'
const PROJECTOR_MAT = 'Assets/Faceted Flight/Meshes/Converted_Faceted_Meshes/Projector04_Mat.asset'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

const guidIndex = () => loadGuidIndex().guidToPath

/**
 * Every LIVE renderer in the JumpSeat prefab whose mesh is `Projector04-Faceted`.
 *
 * Live is the full walk: the GameObject and every ancestor to the prefab root
 * `m_IsActive: 1`, and the `MeshRenderer` `m_Enabled: 1`. Both component-list
 * dialects are handled by `readPrefab` (CLAUDE.md, DEV-043).
 */
export const liveCones = (prefab = readPrefab(JUMPSEAT_PREFAB), guids = guidIndex()) => {
  const transforms = prefab.docs.filter((d) => d.classId === 4)
  const root = transforms.find((t) => String(t.data.m_Father?.fileID ?? 0) === '0')
  const chainOf = (tf) => {
    const out = []
    for (let cur = tf; cur && cur !== root; cur = prefab.parentOf(cur)) out.unshift(cur)
    return out
  }
  const out = []
  for (const tf of transforms) {
    const go = prefab.goOf(tf)
    const comps = prefab.componentsOf(go)
    const filter = comps.find((d) => d.classId === 33)
    const renderer = comps.find((d) => d.classId === 23)
    const mesh = guids.get(String(filter?.data?.m_Mesh?.guid ?? ''))
    if (mesh !== PROJECTOR_ASSET) continue
    const chain = chainOf(tf)
    const active = chainIsLive(chainUp(prefab.byId, tf).nodes)
    if (!active || Number(renderer?.data?.m_Enabled) !== 1) continue
    out.push({
      path: chain.map((t) => prefab.nameOf(prefab.goOf(t))).join('/'),
      materials: (renderer.data.m_Materials ?? []).map((m) => guids.get(m.guid) ?? m.guid),
    })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1))
}

/** Build the cone, verified, as GLB bytes plus a report. Reads Unity; writes nothing. */
export const buildCone = () => {
  const guids = guidIndex()
  const cones = liveCones(readPrefab(JUMPSEAT_PREFAB), guids)
  const { parsed, mesh } = loadMeshAsset(legacyPath(PROJECTOR_ASSET))
  const parts = connectedParts(mesh.position, mesh.indices, 1e-4)

  // The decode, checked against Unity's own serialised bounds: a wrong stride
  // or a wrong channel offset cannot land every vertex inside m_LocalAABB AND
  // touch all six faces of it.
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < mesh.position.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], mesh.position[i + k])
      max[k] = Math.max(max[k], mesh.position[i + k])
    }
  }
  const aabb = parsed.localAABB
  const axes = ['x', 'y', 'z']
  const aabbMiss = aabb
    ? Math.max(
        ...axes.map((a, k) =>
          Math.max(
            Math.abs(min[k] - (aabb.center[a] - aabb.extent[a])),
            Math.abs(max[k] - (aabb.center[a] + aabb.extent[a])),
          ),
        ),
      )
    : Infinity

  const checks = [
    [
      cones.length === 3,
      `expected three live Projector04-Faceted renderers, found ${cones.length}: ${cones.map((c) => c.path).join(', ')}`,
    ],
    [
      cones.every((c) => /\/hover_engine \([123]\)\/Projector04-Faceted \(2\)$/.test(c.path)),
      `a live cone is not under a hover_engine: ${cones.map((c) => c.path).join(', ')}`,
    ],
    [
      cones.every((c) => c.materials.length === 1 && c.materials[0] === PROJECTOR_MAT),
      `a live cone does not wear Projector04_Mat alone: ${cones.map((c) => c.materials).join(' | ')}`,
    ],
    [parsed.vertexCount === 936, `Projector04-Faceted has ${parsed.vertexCount} verts, not 936`],
    [parts.length === 1, `Projector04-Faceted has ${parts.length} connected parts, not 1`],
    [Boolean(mesh.normal), 'Projector04-Faceted carries no normals'],
    [Boolean(mesh.color), 'Projector04-Faceted carries no vertex colour'],
    [aabbMiss < 1e-5, `the decoded vertices miss m_LocalAABB by ${aabbMiss}`],
  ]
  for (const [ok, what] of checks) if (!ok) throw new Error(`convert-jumpseat-cone: ${what}`)

  const three = toThreeHullFrame(mesh, IDENTITY)
  const worst = worstWindingDisagreement(three)
  if (worst > 1e-3) {
    throw new Error(`convert-jumpseat-cone: winding disagrees with the normals by ${worst}`)
  }
  // Raw bytes, alpha dropped: the Color32 alpha here is 1/255 (see header).
  const colour = new Float32Array(parsed.vertexCount * 3)
  for (let v = 0; v < parsed.vertexCount; v++) {
    for (let k = 0; k < 3; k++) colour[v * 3 + k] = mesh.color[v * 4 + k] / 255
  }
  const mat = readMaterial(PROJECTOR_MAT, guids)
  const linear = mat.colorSrgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  const glb = buildGlb({
    root: 'projector04-faceted',
    extras: {
      dev: 'DEV-433',
      source: `${PROJECTOR_ASSET}, via ${JUMPSEAT_PREFAB} ${cones.map((c) => c.path).join(' ; ')}`,
      frame:
        'MESH-LOCAL, three space (Unity z negated, winding reversed); place with the Unity->three rule',
      unityLocalAABB: aabb,
    },
    parts: [
      {
        name: 'cone',
        ...three,
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
        extras: { unity: { mesh: PROJECTOR_ASSET, vertexCount: parsed.vertexCount } },
      },
    ],
  })
  return {
    glb,
    report: {
      cones,
      vertexCount: parsed.vertexCount,
      unityBounds: { min, max },
      localAABB: aabb,
      winding: worst,
      material: mat,
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
      const { glb, report } = buildCone()
      return { files: { glb }, report }
    },
    outputs: { glb: CONE_OUT },
  })
}
