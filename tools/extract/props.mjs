// tools/extract/props.mjs — the environment prop layer, as data.
//
//   node tools/extract/props.mjs            # all four shipped environments
//   node tools/extract/props.mjs --check    # verify, write nothing
//   node tools/extract/props.mjs --env alpine
//
// Writes content/environments/<id>.json. One file per ENVIRONMENT, not per
// mission: thirteen missions share four environments, and duplicating 6,000
// trees thirteen times would be an architecture bug (rule 6).
//
// ── What the prop layer actually is ───────────────────────────────────────
//
// It is not hand placement. `FacetedTerrainObjectGenerator.cs` (first-party,
// `[RequireComponent(typeof(FacetedTerrain))]`) walks every texel of a World
// Machine density map and rolls
//
//     Random.Range(0,1) < grayscale(texel) * ObjectProbabilityScale
//
// placing a uniformly-chosen entry of `ObjectPrefabs` at
//
//     x = tx * TerrainSize / map.width
//     y = heightMap(uv).grayscale * TerrainHeight - ObjectHeightOffset
//     z = ty * TerrainSize / map.height
//
// with a random yaw and a uniform scale in [ObjectScaleMin, ObjectScaleMax].
// So 10,700 objects are a map, seven numbers and a prefab list.
//
// `ObjectPrefabs` IS A WEIGHTED LIST. The pick is `Random.Range(0, Length)`,
// uniform over INDICES, so desert's `bush_desert_01` appearing 8 times in 13
// makes bushes 8/13 of the scatter. The order and the duplicates are the
// weighting — this tool emits the array verbatim and never de-duplicates it.
//
// ── Three traps this tool exists to not fall into ─────────────────────────
//
// 1. THE SOURCE FILE IS NOT ALWAYS THE PREFAB. The four environments are
//    authored two ways, and the split is not the one `CLAUDE.md` records:
//
//      desert, simonet  -> a 6 KB / 44 KB scene that INSTANTIATES
//                          Prefabs/Levels/LevelArt_<env>.prefab
//      alpine, kauai    -> a 36.9 MB / 17.2 MB SCENE holding the art directly
//
//    Alpine has it BOTH ways — a 36.9 MB scene AND a 36.7 MB prefab, each with
//    two generator components — and THEY DISAGREE: the small-tree pass has
//    `ObjectHeightOffset: 5` in the scene and `-1` in the prefab. The offset is
//    SUBTRACTED, so that is six metres on trees scaled 1.4x-5.5x. The scene is
//    what `LoadLevelArt.levelName` loads, so the scene wins. Reading prefabs is
//    right for two environments out of four and floats alpine's forest.
//
//    Hence: resolve the chain, never the filename. Scene first; follow into the
//    prefab only when the scene instantiates one and carries no generator.
//
// 2. THE DENSITY MAPS ARE UNITY TEXTURES. Both are 1025x1025 with
//    `nPOTScale: 1`, so Unity rescales to 1024 at import and the generator's
//    step is TerrainSize/1024 = 4.0 m exactly, not TerrainSize/1025. Same
//    arithmetic that cost 30 m of terrain height in DEV-007. This tool records
//    the map PATH and the on-disk size; the runtime reproduces the importer
//    through `importUnityTexture()`, exactly as extract-terrain-maps.mjs does.
//    One implementation, one test.
//
// 3. A GENERATOR COMPONENT IS NOT A GENERATED FOREST. `GenerateObjects()` is
//    `#if UNITY_EDITOR` and only the inspector button ever calls it, so what
//    2016 DREW is whatever a person baked into the file — and each component
//    serialises the answer as `_StoredChunks[*].Objects`, the fileIDs of the
//    clones it placed. Read against the six shipped-or-nearly files (DEV-102):
//
//      alpine  Tree_Organic pass  m_Enabled 1  6,097 objects   <- the forest
//      alpine  Tree Pack pass     m_Enabled 0  _StoredChunks: []   never run
//      desert                     m_Enabled 1  5,948 objects
//      simonet                    m_Enabled 1  _StoredChunks: []   never run
//      kauai                      m_Enabled 1  _StoredChunks: []   never run
//
//    So 2016 scattered props in TWO environments, and alpine's 40-78 m big-tree
//    pass, simonet's palms and kauai's palms are draws this port makes that the
//    2016 build never did. This tool still emits every component it finds —
//    the parameters are Matt's and whether to draw them is a look decision, not
//    an extraction one — but each `scatter[]` entry now carries a `shipped2016`
//    receipt saying what the source file holds, and
//    `tests/unit/props-2016-bake.test.ts` checks that receipt against the
//    clones by an independent route. Whether the never-baked passes stay is
//    DEV-102's open question; the data no longer pretends it is settled.
//
// ── Provenance ────────────────────────────────────────────────────────────
//
// Everything emitted here is Matt's: generator parameters he tuned, and the
// path of a map he produced. NO GEOMETRY IS EMITTED OR COPIED. Each palette
// entry is classified so the licence gate is visible in the data rather than
// remembered: every prop mesh in every shipped environment is bought or a bake
// of bought geometry, including the ones behind first-party prefab paths
// (`Prefabs/Environment/Trees/Tree_Organic_*` wraps `MM_Tree*`, which is Tree
// Pack; `Prefabs/Environment/desert/Cactus_*` wraps `MM_Cactus_*`, CactusPack).
//
// The legacy Unity project is READ-ONLY. This reads and never writes there.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertOutsideLegacy, legacyRoot } from '../legacy-root.mjs'
import { loadGuidIndex } from '../unity/guid-index.mjs'
import { readUnityText } from '../unity/yaml.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LEGACY = legacyRoot()
const GUID_INDEX = path.join(REPO, 'docs', 'research', '_guid_index.tsv')
const OUT_DIR = path.join(REPO, 'content', 'environments')

const GENERATOR_CS = 'Assets/Faceted Flight/Scripts/FacetedTerrainObjectGenerator.cs'

/**
 * LoadLevelArt.levelName -> FF2 environment id. Mirrors `ENVIRONMENT_ID` in
 * tools/extract/constants.mjs and `ENV_ID` in tools/extract/level.mjs; the same
 * four ids content/levels/*.json already uses.
 */
const ENVIRONMENT_SCENE = {
  alpine: 'LevelArt_AlpineForest',
  menu: 'main_menu',
  desert: 'LevelArt_Desert',
  kauai: 'LevelArt_Kauai',
  simonet: 'LevelArt_SimonetIslands',
}

/**
 * Environments whose scene is NOT under `Scenes/environments/`, and what that
 * costs them. DEV-155.
 *
 * `menu` is the fifth environment and the only one no MISSION uses: it is the
 * ground the TITLE SCREEN stands on, and the id is the one the generated
 * constants sheet already calls it (`model.terrain.menu`, whose `levelArt` is
 * `AlpineTerrain_menu`). 2016 built the menu's valley from
 * `AlpineTerrain_menu`, a second `FacetedTerrain` inside `main_menu.unity` that
 * carries the same height map, terrain size, chunk size and LOD ladder as
 * `LevelArt_AlpineForest` — and **a different scatter**. Its enabled pass is
 * BAKED (3,999 objects, `ObjectScaleMin 6` .. `ObjectScaleMax 20`,
 * `ObjectProbabilityScale 0.02`, `ObjectHeightOffset -5`), where the mission
 * environment's big-tree pass is `m_Enabled: 0` with an empty `_StoredChunks`
 * and its SMALL pass is the one 2016 ran. So the two files disagree about which
 * pass shipped, `shipped2016` is per source file, and pointing the title screen
 * at `alpine.json` would have drawn the mission's 1.4..5.5 m trees on a screen
 * that shipped 40..78 m ones. One id per source file is the only shape that
 * keeps DEV-102's receipt honest.
 *
 * **And the SCENE is the source, not `Prefabs/Menus/AlpineTerrain_menu.prefab`**
 * — trap 1 in this file's header, in its sharpest form yet. The prefab carries
 * ONE generator, `m_Enabled: 1`, 1.4..4, `ObjectHeightOffset 0`, **4,204** baked
 * objects. The scene carries TWO, and the one that matches the prefab's is
 * `m_Enabled: 0` with an EMPTY `_StoredChunks` while a second, scene-native one
 * (`m_PrefabParentObject: {fileID: 0}`) holds the 3,999 big trees. The scene's
 * terrain is a DISCONNECTED copy — `m_PrefabInternal: 0` on every component —
 * so the prefab is a stale ancestor, exactly like the mission suns CLAUDE.md
 * warns about. Read the prefab and you get a forest of the wrong size, the
 * wrong count and the wrong height offset, and every one of those numbers looks
 * plausible.
 *
 * `landmarks: false` because `main_menu.unity` is not an environment scene: its
 * hand-placed art is the TITLE SCENE — a chair, a parked SR9, three podiums, a
 * projector — 21,230 objects of it, all bought or derived from bought geometry.
 * Emitting that here would put hundreds of unpublished, unlicensable meshes in
 * a file whose whole job is the scatter. Whatever of it ships is its own row.
 */
const SCENE_SOURCE = {
  menu: {
    rel: 'Assets/Faceted Flight/Scenes/main_menu.unity',
    landmarks: false,
    note: 'the TITLE SCREEN terrain — AlpineTerrain_menu inside main_menu.unity (DEV-155)',
  },
}

/** Emitted name, YAML field, and whether a missing value is fatal. */
const SCATTER_FIELDS = [
  ['probabilityScale', 'ObjectProbabilityScale'],
  ['heightOffset', 'ObjectHeightOffset'],
  ['scaleMin', 'ObjectScaleMin'],
  ['scaleMax', 'ObjectScaleMax'],
  ['lodDistance', 'LODDistance'],
  ['lodTransitionTime', 'LODTransitionTime'],
  ['flipFlopPercent', 'FlipFlopPercent'],
]

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const onlyEnv = args.includes('--env') ? args[args.indexOf('--env') + 1] : null

function die(msg) {
  console.error(`extract:props: ${msg}`)
  process.exit(1)
}

// ── guid index ────────────────────────────────────────────────────────────

const { guidToPath, pathToGuid } = loadGuidIndex(GUID_INDEX)

const GENERATOR_GUID = pathToGuid.get(GENERATOR_CS)
if (!GENERATOR_GUID) die(`${GENERATOR_CS}: not in the guid index`)

const unityPath = (rel) => path.join(LEGACY, rel)
const readUnity = (rel) => readUnityText(unityPath(rel))
const existsUnity = (rel) => fs.existsSync(unityPath(rel))

// ── YAML documents, the cheap way ─────────────────────────────────────────
//
// Full parsing is not needed and 2016's two dialects make it risky. Splitting
// on the document header is exact, and the generator's fields are flat scalars.

function documents(text) {
  const out = []
  const parts = text.split(/\n--- /)
  for (const part of parts) {
    const m = /^!u!(\d+) &(-?\d+)( stripped)?/.exec(part)
    out.push({ classId: m ? Number(m[1]) : null, fileId: m ? m[2] : null, text: part })
  }
  return out
}

const scalar = (text, field) => {
  const m = new RegExp(`^\\s{2,4}${field}: (-?[\\d.eE+-]+)\\s*$`, 'm').exec(text)
  return m ? Number(m[1]) : null
}

const guidOf = (text, field) => {
  const m = new RegExp(`${field}: \\{fileID: -?\\d+, guid: ([0-9a-f]{32})`).exec(text)
  return m ? m[1] : null
}

/** Ordered guid list of `ObjectPrefabs`, duplicates INTACT — they are the weights. */
function objectPrefabGuids(text) {
  const m = /ObjectPrefabs:\s*\n((?:\s*- \{fileID:[^\n]*\n)+)/.exec(text)
  if (!m) return []
  return [...m[1].matchAll(/guid: ([0-9a-f]{32})/g)].map((x) => x[1])
}

// ── palette classification ────────────────────────────────────────────────
//
// A prop prefab under `Assets/Faceted Flight/` is a WRAPPER, not evidence of
// first-party geometry. Resolve one level down to the mesh it actually holds
// and classify THAT.

const PACK_OF_BAKE = {
  MM_Tree: 'Tree Pack',
  MM_Cactus: 'CactusPack',
  MM_GL: 'Geometric-Landscape-Tropic-Island',
  MM_TI: 'Geometric-Landscape-Tropic-Island (Tropic Island)',
  MM_Rock: 'CactusPack',
}

// ── bucket paths, so the renderer re-derives nothing ──────────────────────
//
// `content/environments/*.json` names the LEGACY path of every map and mesh,
// which is the provenance. The runtime needs the BUCKET path, and the mapping
// between them is a fact these tools already know. Emitting it here keeps rule
// 6 honest: adding an environment must not require touching `src/`.
//
// These must agree with `tools/assets/extract-terrain-maps.mjs` (PROP_MAP_TARGETS)
// and `tools/assets/extract-props.mjs` (assetId), which is why both are named.

const PLACEMENT_MAP_ASSET = {
  'Assets/Faceted Flight/World Machine Content/forest_02/forest_02_trees.tga':
    'assets/terrain/alpine/forest_02-trees.png',
  'Assets/Faceted Flight/World Machine Content/canyon_04/canyon_04_trees.tga':
    'assets/terrain/desert/canyon_04-trees.png',
  'Assets/Faceted Flight/World Machine Content/island_group_02/islands_02_trees.png':
    'assets/terrain/simonet/islands_02-trees.png',
}

/** `Tree1_MM` / `tree01_LOD0` -> `tree1-mm` / `tree01-lod0`, stable and URL-safe. */
const slug = (stem) =>
  stem
    .replace(/^MM_/, '')
    .replace(/_MM$/, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()

/**
 * Mirrors `assetId()` in tools/assets/extract-props.mjs. Keep them together.
 *
 * `node` is the SUB-MESH name inside a multi-mesh FBX, and when there is one it
 * — not the file — names the asset. See `fbxMeshTable` for why that matters:
 * `trees_03.fbx` holds twenty trees at three LODs, so ten different prefabs
 * were all resolving to one `trees-03.glb` and the loader, which instances
 * every mesh it finds, drew all sixty at every scatter point (DEV-099).
 */
const meshAssetPath = (mesh, node = null) => {
  if (!mesh) return null
  const stem = mesh
    .split('/')
    .pop()
    .replace(/\.(asset|fbx)$/i, '')
  return `assets/props/${slug(node ?? stem)}.glb`
}

/**
 * Unity's own fileID -> sub-asset name table, out of the `.fbx.meta`.
 *
 * An FBX is a CONTAINER. `m_Mesh: {fileID: 4300104, guid: bfcd…}` names one
 * mesh inside `trees_03.fbx`, and the guid alone — which is all the extractor
 * used to capture — identifies the file, not the mesh. The importer writes the
 * mapping into `fileIDToRecycleName` in the sibling `.meta`, so this is Unity's
 * answer rather than ours.
 *
 * Returns `{ names, meshCount }`, or null when there is no meta to read. Mesh
 * fileIDs are class 43: `43 * 100000 + n`, i.e. 4300000..4399999.
 */
function fbxMeshTable(fbxRel) {
  const metaRel = `${fbxRel}.meta`
  if (!existsUnity(metaRel)) return null
  const names = new Map()
  let meshCount = 0
  for (const m of readUnity(metaRel).matchAll(/^\s+(\d+): (.+)$/gm)) {
    const id = Number(m[1])
    names.set(m[1], m[2].trim())
    if (id >= 4300000 && id < 4400000) meshCount++
  }
  return { names, meshCount }
}

/**
 * The mesh Unity RENDERS at close range, resolved through the LODGroup.
 *
 * ── Why the LODGroup and not a heuristic ─────────────────────────────────
 *
 * `Tree10.prefab` carries FOUR MeshFilters — `tree10_LOD0/1/2` and a `collider`
 * node that has a MeshCollider, a MeshFilter AND a MeshRenderer and reuses
 * LOD0's mesh at scale 0.9. So "has a filter", "has a renderer" and "has both"
 * all match several nodes, and which one wins comes down to document order:
 * the palette ended up with scale 1.0 for eight of the trees and the
 * COLLIDER's 0.9 for `Tree3` and `Tree7`, from the same loop, in the same
 * directory. That is a coin toss wearing a rule.
 *
 * `m_LODs[0].renderers[0]` is not a heuristic. It is the renderer Unity itself
 * shows at the highest screen size, authored in the prefab, and the first entry
 * is LOD0 by the format's own ordering (its `screenRelativeHeight` is the
 * largest — 0.351 > 0.119 > 0.009 on every tree here).
 *
 * Returns `{ guid, fileId, go }` or null when the prefab has no LODGroup, in
 * which case the caller keeps its existing behaviour — every such prefab in
 * this project has exactly one renderable mesh, so there is nothing to choose.
 *
 * `go` is the GameObject the LOD0 renderer sits on, and it is the ONLY thing
 * that separates `tree10_LOD0` from `collider`: the collider node reuses LOD0's
 * mesh, so guid and fileID match it just as well and `find` then returns
 * whichever comes first in the file. It did, at scale 0.9.
 */
function lod0Mesh(prefabRel) {
  if (!existsUnity(prefabRel)) return null
  const docs = documents(readUnity(prefabRel))
  const lod = docs.find((d) => d.classId === 205)
  if (!lod) return null
  const first =
    /m_LODs:\s*\n\s*- screenRelativeHeight:[\s\S]*?renderers:\s*\n\s*- renderer: \{fileID: (-?\d+)\}/.exec(
      lod.text,
    )
  if (!first) return null
  const renderer = docs.find((d) => d.classId === 23 && d.fileId === first[1])
  if (!renderer) return null
  const owner = /m_GameObject: \{fileID: (-?\d+)\}/.exec(renderer.text)?.[1]
  if (!owner) return null
  for (const d of docs) {
    if (d.classId !== 33) continue
    if (/m_GameObject: \{fileID: (-?\d+)\}/.exec(d.text)?.[1] !== owner) continue
    const m = /m_Mesh: \{fileID: (-?\d+), guid: ([0-9a-f]{32})/.exec(d.text)
    if (m) return { fileId: m[1], guid: m[2], go: owner }
  }
  return null
}

// ── the wrapper prefab's own transform chain ──────────────────────────────
//
// A palette entry is a PREFAB, and the mesh inside it is almost never at the
// prefab's origin. `Tree_Organic_00` is a root plus a child `MM_Tree1` at
// (63.23, -0.7, 15.22) with scale 0.2217 — and that child transform is exactly
// what cancels the world-space offset baked into `Tree1_MM.asset` (§3.2 of
// docs/private/PROP-AUDIT.md) and brings a 25x17x50 mesh down to tree size.
//
// `GenerateObjects()` overrides the ROOT's position, rotation and scale and
// nothing else, so everything BELOW the root survives into the placed object.
// That subtree transform is therefore part of the prop's definition and has to
// travel with it. Carrying it is also what makes the raw-FBX entries work: the
// pack prefabs compensate their own unit scale the same way.
//
// Composed root-exclusive, mesh-node-inclusive. Rotations are composed as
// quaternions because a parent rotation turns a child's offset.

const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]

const qRot = (q, v) => {
  const [x, y, z, w] = q
  const [vx, vy, vz] = v
  const tx = 2 * (y * vz - z * vy)
  const ty = 2 * (z * vx - x * vz)
  const tz = 2 * (x * vy - y * vx)
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ]
}

const num3 = (m) => [Number(m[1]), Number(m[2]), Number(m[3])]

/**
 * A GameObject document's `m_IsActive`: 1, 0, or -1 when the document has none.
 *
 * Every real GameObject carries the field (all 432,538 non-stripped ones in the legacy project
 * do); the only documents without it are STRIPPED placeholders for a prefab instance's object,
 * whose state lives in the prefab asset and the instance's modifications, which this tool does
 * not apply. So "absent" is unknown, and an unknown is NOT a veto: only an explicit 0 kills
 * something. Two sites here used to disagree (`landmarksIn` read absent as active, `livenessIndex`
 * as inactive); neither was ever exercised by shipped data, and both now use this one rule.
 * `tools/unity/graph.mjs` says the same for the parsed walks (TL-4).
 */
const goActivity = (text) => {
  const a = /m_IsActive: (\d)/.exec(text)
  return a ? Number(a[1]) : -1
}
const vetoes = (state) => state === 0

/**
 * The transform of the mesh-bearing node inside a prop prefab, relative to the
 * prefab root. Returns null when the prefab has no MeshFilter at all.
 */
function meshTransformOf(prefabRel, meshGuid, meshFileId = null, meshOwner = null) {
  if (!existsUnity(prefabRel)) return null
  const docs = documents(readUnity(prefabRel))

  // THE DISCRIMINATOR IS THE MESH GUID, and nothing weaker works.
  //
  // `Tree_Organic_00` holds a `collider` child AND an `MM_Tree1` child, and the
  // collider node carries a CapsuleCollider, a MeshFilter AND a MeshRenderer —
  // so "has a filter" picks it, and so does "has a renderer". Which one wins
  // then comes down to document order, which differs between `Tree_Organic_00`
  // and `_01` in the same directory: 00 returned the collider's (0, 4.89, 0) at
  // scale 1 while 01 returned the real (47.52, -0.1, 6.96) at 0.167. A mesh
  // left at scale 1 still carries its whole baked world offset.
  //
  // The palette entry already resolved WHICH mesh it uses, so match on that.
  const filterMesh = new Map()
  const renderOwner = new Set()
  const filterOwner = new Set()
  const transforms = new Map()
  let rootId = null

  for (const d of docs) {
    if (d.classId === 23 || d.classId === 33) {
      const go = /m_GameObject: \{fileID: (-?\d+)\}/.exec(d.text)
      if (go) {
        ;(d.classId === 23 ? renderOwner : filterOwner).add(go[1])
        if (d.classId === 33) {
          // BOTH halves. The guid says which FILE and the fileID says which
          // mesh inside it — and on `Tree10.prefab` four nodes share the guid,
          // so the guid alone picks by document order. DEV-099.
          const mg = /m_Mesh: \{fileID: (-?\d+), guid: ([0-9a-f]{32})/.exec(d.text)
          if (mg) filterMesh.set(go[1], { fileId: mg[1], guid: mg[2] })
        }
      }
    } else if (d.classId === 4 && d.fileId) {
      const go = /m_GameObject: \{fileID: (-?\d+)\}/.exec(d.text)
      const pos =
        /m_LocalPosition: \{x: (-?[\d.eE+-]+), y: (-?[\d.eE+-]+), z: (-?[\d.eE+-]+)\}/.exec(d.text)
      const rot =
        /m_LocalRotation: \{x: (-?[\d.eE+-]+), y: (-?[\d.eE+-]+), z: (-?[\d.eE+-]+), w: (-?[\d.eE+-]+)\}/.exec(
          d.text,
        )
      const scl = /m_LocalScale: \{x: (-?[\d.eE+-]+), y: (-?[\d.eE+-]+), z: (-?[\d.eE+-]+)\}/.exec(
        d.text,
      )
      const fa = /m_Father: \{fileID: (-?\d+)\}/.exec(d.text)
      const father = fa ? fa[1] : '0'
      transforms.set(d.fileId, {
        id: d.fileId,
        go: go ? go[1] : null,
        father,
        p: pos ? num3(pos) : [0, 0, 0],
        q: rot ? [Number(rot[1]), Number(rot[2]), Number(rot[3]), Number(rot[4])] : [0, 0, 0, 1],
        s: scl ? num3(scl) : [1, 1, 1],
      })
      if (father === '0') rootId = d.fileId
    }
  }

  const all = [...transforms.values()]
  const hit = (t) => (t.go ? filterMesh.get(t.go) : null)
  const target =
    // Exact: the very NODE the LODGroup renders at LOD0. Not "a node holding
    // that mesh" — `collider` holds it too, and answered first.
    (meshOwner ? all.find((t) => t.go === meshOwner) : null) ??
    (meshGuid && meshFileId
      ? all.find((t) => hit(t)?.guid === meshGuid && hit(t)?.fileId === meshFileId)
      : null) ??
    (meshGuid ? all.find((t) => hit(t)?.guid === meshGuid) : null) ??
    all.find((t) => t.go && renderOwner.has(t.go) && filterOwner.has(t.go)) ??
    all.find((t) => t.go && renderOwner.has(t.go))
  if (!target || rootId === null) return null

  // Walk target -> root, collecting the chain, then compose downward EXCLUDING
  // the root (the generator overwrites it).
  const chain = []
  for (let cur = target, hops = 0; cur && hops < 32; hops++) {
    if (cur.id === rootId) break
    chain.unshift(cur)
    cur = transforms.get(cur.father)
  }
  if (chain.length === 0) return { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }

  let p = [0, 0, 0]
  let q = [0, 0, 0, 1]
  let s = [1, 1, 1]
  for (const node of chain) {
    const scaled = [node.p[0] * s[0], node.p[1] * s[1], node.p[2] * s[2]]
    const rotated = qRot(q, scaled)
    p = [p[0] + rotated[0], p[1] + rotated[1], p[2] + rotated[2]]
    q = qMul(q, node.q)
    s = [s[0] * node.s[0], s[1] * node.s[1], s[2] * node.s[2]]
  }
  return { position: p, rotation: q, scale: s }
}

function classifyPrefab(guid) {
  const rel = guidToPath.get(guid) ?? null
  if (!rel) return { prefab: null, guid, mesh: null, origin: 'unknown', licence: 'CONFIRM' }

  const top = rel.split('/')[1] ?? ''
  let mesh = null
  let meshGuid = null
  let meshFileId = null
  // The LODGroup's own answer, where there is one. Checked against all 23
  // palette prefabs before it landed: not one of them changes which FILE it
  // resolves to, so this is strictly a finer answer to the same question.
  const lod0 = lod0Mesh(rel)
  let meshOwner = null
  if (lod0 && guidToPath.has(lod0.guid)) {
    mesh = guidToPath.get(lod0.guid)
    meshGuid = lod0.guid
    meshFileId = lod0.fileId
    meshOwner = lod0.go
  } else if (existsUnity(rel)) {
    const text = readUnity(rel)
    for (const g of [...text.matchAll(/guid: ([0-9a-f]{32})/g)].map((x) => x[1])) {
      const p = guidToPath.get(g)
      if (!p) continue
      if (p.endsWith('.asset') || p.endsWith('.fbx')) {
        mesh = p
        meshGuid = g
        break
      }
    }
  }

  // Which mesh INSIDE the file, when the file holds more than one. Only
  // `trees_03.fbx` does (60); every other source here is a single mesh, so
  // `meshNode` is null for them and the asset is still named after the file.
  let meshNode = null
  if (mesh?.toLowerCase().endsWith('.fbx') && meshFileId) {
    const table = fbxMeshTable(mesh)
    if (table && table.meshCount > 1) meshNode = table.names.get(meshFileId) ?? null
  }

  // The wrapper is first-party; the mesh decides.
  const { origin, licence } = provenanceOf(mesh, top)

  return {
    prefab: rel,
    guid,
    mesh,
    /** The sub-mesh inside `mesh`, when `mesh` is a container. Usually null. */
    meshNode,
    meshAsset: meshAssetPath(mesh, meshNode),
    origin,
    licence,
    kind: kindOf(rel, mesh),
    meshTransform: meshTransformOf(rel, meshGuid, meshFileId, meshOwner),
  }
}

/**
 * Where a mesh came from and whether it may ship — the D26 classification.
 *
 * `LICENSED`, not `REPLACE`, for bought geometry and bakes of it:
 * content/MANIFEST.md's legend, corrected 2026-09-13 on Matt's call. An Asset
 * Store purchase grants USE in the buyer's own products, not restricted to
 * Unity; what it withholds is redistribution in an extractable form, which is
 * why these never enter git and are never offered as a download. This file
 * said `REPLACE` for a session after the manifest stopped saying it, which is
 * two sources disagreeing about whether the game may draw a tree (DEV-135).
 */
function provenanceOf(mesh, top) {
  const meshTop = mesh ? (mesh.split('/')[1] ?? '') : top
  let origin = meshTop
  let licence = 'LICENSED'
  if (mesh?.includes('/Materialized Mesh/')) {
    const stem = mesh.split('/Materialized Mesh/')[1].split('/')[0]
    const key = Object.keys(PACK_OF_BAKE).find((k) => stem.startsWith(k))
    origin = key ? `${PACK_OF_BAKE[key]} (baked as ${stem})` : `bake of bought geometry (${stem})`
    licence = 'LICENSED'
  } else if (meshTop === 'Faceted Flight' || meshTop === 'FF_GearVR') {
    origin = 'first-party'
    licence = 'KEEP'
  }
  return { origin, licence }
}

/**
 * What a prop IS, from its pack and its name: `tree`, `cactus`, `bush`,
 * `palm`, `spire`, `rock`. The key `edition.props.scale` multiplies by
 * (DEV-134), and the class DEV-135's audit counts. Names first, because the
 * packs are not one thing each — AxeyWorks holds a palm and a bush, and the
 * pack's own `rocks_small.prefab` is a `Bush_Large_02` mesh (the name is the
 * pack's joke, the geometry is a bush, and it is classified by the geometry).
 */
function kindOf(prefabRel, meshRel) {
  const s = `${meshRel ?? ''} ${prefabRel ?? ''}`.toLowerCase()
  if (/spire/.test(s)) return 'spire'
  if (/cactus/.test(s)) return 'cactus'
  if (/palm/.test(s)) return 'palm'
  if (/bush|plant/.test(s)) return 'bush'
  if (/rock|roca|boulder|stone|cliff/.test(s)) return 'rock'
  if (/tree/.test(s)) return 'tree'
  return null
}

// ── resolve one environment to its generator documents ────────────────────

function resolveSource(envId) {
  const sceneName = ENVIRONMENT_SCENE[envId]
  const sceneRel =
    SCENE_SOURCE[envId]?.rel ?? `Assets/Faceted Flight/Scenes/environments/${sceneName}.unity`
  if (!existsUnity(sceneRel)) die(`${envId}: ${sceneRel} is not on disk`)

  const sceneText = readUnity(sceneRel)
  const sceneAll = documents(sceneText)
  const sceneDocs = sceneAll.filter((d) => d.classId === 114 && d.text.includes(GENERATOR_GUID))
  if (sceneDocs.length > 0) {
    // A scene can hold its art AND be a giant modification set over another
    // environment's prefab. Kauai is: it references LevelArt_SimonetIslands
    // .prefab 28,022 times, which is why its landmarks come out byte-identical
    // to simonet's. That is honest inheritance, not a bug — but this tool does
    // NOT apply `m_Modifications`, so an inherited value it reports is the
    // PREFAB BASE and the scene may override it. Say so in the output rather
    // than let a base value be read as a shipped one (rule 2).
    let inheritsFrom = null
    for (const [rel, guid] of pathToGuid) {
      if (!rel.startsWith('Assets/Faceted Flight/Prefabs/Levels/LevelArt_')) continue
      if (rel === `Assets/Faceted Flight/Prefabs/Levels/${sceneName}.prefab`) continue
      const n = sceneText.split(guid).length - 1
      if (n > 100) inheritsFrom = { prefab: rel, references: n }
    }
    return {
      kind: 'scene',
      rel: sceneRel,
      docs: sceneDocs,
      all: sceneAll,
      inheritsFrom,
      note: SCENE_SOURCE[envId]?.note ?? 'art lives in the scene',
    }
  }

  // No generator in the scene: it must instantiate a LevelArt prefab.
  const prefabRel = `Assets/Faceted Flight/Prefabs/Levels/${sceneName}.prefab`
  if (!existsUnity(prefabRel)) {
    die(`${envId}: no generator in ${sceneRel} and no ${prefabRel} to follow into`)
  }
  const prefabGuid = pathToGuid.get(prefabRel)
  if (prefabGuid && !sceneText.includes(prefabGuid)) {
    die(`${envId}: ${sceneRel} does not instantiate ${prefabRel} — the chain is not what we think`)
  }
  const all = documents(readUnity(prefabRel))
  const docs = all.filter((d) => d.classId === 114 && d.text.includes(GENERATOR_GUID))
  if (docs.length === 0) die(`${envId}: no generator in ${prefabRel} either`)
  return {
    kind: 'prefab',
    rel: prefabRel,
    docs,
    all,
    note: `instantiated by ${sceneRel}`,
  }
}

// ── hand-placed landmarks ─────────────────────────────────────────────────
//
// The part of the environment that genuinely WAS authored by hand: desert's
// canyon spires and a handful of rocks and palms. Sixteen `Spire_*` among 9,600
// generated props.
//
// The test for "hand-placed" is PARENTAGE, not position. `GenerateObjects()`
// parents everything it makes under a per-chunk `Objects Root`
// (FacetedTerrainObjectGenerator.cs:307-317), so anything carrying a mesh that
// is NOT under one is authored. A grid test works too — and was how this was
// first found — but it needs TerrainSize and the post-import map width, which
// is two numbers to get wrong for a fact the hierarchy states outright.
//
// Excluded deliberately:
//
//   - CLOUDS. `tools/extract/level.mjs` already reads desert's and simonet's
//     background clouds out of this same prefab into the level JSON's `clouds`.
//     Emitting them here as well would place every cloud twice.
//   - Anything with no MeshFilter: 26 `Capsule` colliders, `MM_BigRock_collider`
//     and the `terrain` root itself, whose transform the constants sheet already
//     carries. A collider is not art and this file is about what you can see.

const CLOUD_MESH = /GL-Cloud/i

/**
 * The 2016 BAKED TERRAIN chunks — `*_FacetedChunks.asset`, 7.15 GB of Unity
 * binary across the four environments, and precisely what this port replaces
 * with the runtime generator. They are meshes hanging off the environment root
 * with no `Objects Root` above them, so the parentage test admits all 6,912 of
 * them unless they are named out. Excluding them here rather than by size or by
 * count, because the reason is what they ARE, not how many.
 */
const TERRAIN_BAKE_MESH = /FacetedChunks/i

function landmarksIn(docs, rootName) {
  const names = new Map()
  // `m_IsActive` per GameObject. DEV-135: a landmark under an inactive parent
  // was not drawn in 2016 — every palm in every environment sits under an
  // `art/trees` that is OFF, and so does desert's big rock — and the first cut
  // of this function emitted all of them as if they were.
  const active = new Map()
  const meshOfGameObject = new Map()
  const transforms = []

  for (const d of docs) {
    if (d.classId === 1 && d.fileId) {
      const n = /m_Name: (.*)/.exec(d.text)
      names.set(d.fileId, n ? n[1].trim() : '?')
      active.set(d.fileId, goActivity(d.text))
    } else if (d.classId === 33) {
      const go = /m_GameObject: \{fileID: (-?\d+)\}/.exec(d.text)
      const mg = /m_Mesh: \{fileID: -?\d+, guid: ([0-9a-f]{32})/.exec(d.text)
      if (go && mg) meshOfGameObject.set(go[1], mg[1])
    } else if (d.classId === 4 && d.fileId) {
      const go = /m_GameObject: \{fileID: (-?\d+)\}/.exec(d.text)
      const pos =
        /m_LocalPosition: \{x: (-?[\d.eE+-]+), y: (-?[\d.eE+-]+), z: (-?[\d.eE+-]+)\}/.exec(d.text)
      const rot =
        /m_LocalRotation: \{x: (-?[\d.eE+-]+), y: (-?[\d.eE+-]+), z: (-?[\d.eE+-]+), w: (-?[\d.eE+-]+)\}/.exec(
          d.text,
        )
      const scl = /m_LocalScale: \{x: (-?[\d.eE+-]+), y: (-?[\d.eE+-]+), z: (-?[\d.eE+-]+)\}/.exec(
        d.text,
      )
      const father = /m_Father: \{fileID: (-?\d+)\}/.exec(d.text)
      if (go && pos) {
        transforms.push({
          fileId: d.fileId,
          go: go[1],
          father: father ? father[1] : '0',
          position: [Number(pos[1]), Number(pos[2]), Number(pos[3])],
          rotation: rot ? [Number(rot[1]), Number(rot[2]), Number(rot[3]), Number(rot[4])] : null,
          scale: scl ? [Number(scl[1]), Number(scl[2]), Number(scl[3])] : null,
        })
      }
    }
  }

  const byFileId = new Map(transforms.map((t) => [t.fileId, t]))
  const generated = (t) => {
    // Walk up; bail on a cycle rather than hanging on malformed YAML.
    for (let cur = t, hops = 0; cur && hops < 64; hops++) {
      if (names.get(cur.go) === 'Objects Root') return true
      cur = byFileId.get(cur.father)
    }
    return false
  }

  /**
   * COMPOSE the chain from the mesh node up to — and excluding — the
   * environment root, and walk the liveness at the same time. DEV-135.
   *
   * The root is excluded because it is the LevelArt instance's own transform,
   * which the runtime already composes as `worldOffset + local + envRoot`
   * (DEV-042); a landmark that carried it too would be placed twice over. What
   * comes out is the same frame the terrain's transform in the constants sheet
   * is written in, so `load-props.ts` subtracts that one transform to reach the
   * terrain's mesh frame. The first cut recorded the mesh node's LOCAL
   * transform: for the 26 AxeyWorks palms that was `(0, 0, 0) x 1`, under a
   * `tree_palm_01` node that held the real placement.
   */
  const compose = (t) => {
    let p = t.position
    let q = t.rotation ?? [0, 0, 0, 1]
    let s = t.scale ?? [1, 1, 1]
    let live = !vetoes(active.get(t.go))
    const chain = [names.get(t.go) ?? '?']
    for (let cur = byFileId.get(t.father), hops = 0; cur && hops < 64; hops++) {
      chain.unshift(names.get(cur.go) ?? '?')
      if (vetoes(active.get(cur.go))) live = false
      // The LevelArt node is the environment root whether it is the prefab's
      // own root (desert, simonet) or sits under a scene's `levelOffset`
      // (alpine, kauai); its transform and everything above it is the
      // `worldOffset + local + envRoot` sum the runtime already composes.
      if (cur.father === '0' || names.get(cur.go) === rootName) break
      const cq = cur.rotation ?? [0, 0, 0, 1]
      const cs = cur.scale ?? [1, 1, 1]
      const scaled = [p[0] * cs[0], p[1] * cs[1], p[2] * cs[2]]
      const rotated = qRot(cq, scaled)
      p = [cur.position[0] + rotated[0], cur.position[1] + rotated[1], cur.position[2] + rotated[2]]
      q = qMul(cq, q)
      s = [s[0] * cs[0], s[1] * cs[1], s[2] * cs[2]]
      cur = byFileId.get(cur.father)
    }
    return { position: p, rotation: q, scale: s, live, path: chain.join('/') }
  }

  const out = []
  for (const t of transforms) {
    const meshGuid = meshOfGameObject.get(t.go)
    if (!meshGuid) continue
    const mesh = guidToPath.get(meshGuid) ?? null
    if (!mesh || CLOUD_MESH.test(mesh) || TERRAIN_BAKE_MESH.test(mesh)) continue
    if (generated(t)) continue
    // Unity's built-in primitives (the spires' `Capsule` colliders) resolve to
    // the engine's own guid, which the index maps to nothing meaningful; they
    // carry a MeshFilter and are not art. `guidToPath` has no entry for them,
    // so they were already skipped above — said here so nobody re-adds them.
    const { origin, licence } = provenanceOf(mesh, mesh.split('/')[1] ?? '')
    const c = compose(t)
    out.push({
      name: names.get(t.go) ?? '?',
      mesh,
      meshAsset: meshAssetPath(mesh),
      kind: kindOf(null, mesh),
      origin,
      licence,
      live: c.live,
      path: c.path,
      position: c.position,
      rotation: c.rotation,
      scale: c.scale,
    })
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}

// ── what 2016 actually baked ──────────────────────────────────────────────
//
// The component's `_StoredChunks` is `[SerializeField]`, so the editor bake's
// output list is in the file: one entry per terrain chunk, each holding the
// `Objects` the pass placed there. An empty list is a pass nobody ran; a
// `m_Enabled: 0` is a pass switched off. Both are cheap to read and neither is
// the same question as "is there a component" — which is all this tool used
// to ask. Resolving each fileID to a GameObject in the same document set is
// the check that the references are real rather than dangling.

function livenessIndex(docs) {
  const goActive = new Map()
  const goName = new Map()
  const transformOfGo = new Map()
  const transforms = new Map()
  for (const d of docs) {
    if (d.classId === 1 && d.fileId) {
      goName.set(d.fileId, (/m_Name: (.*)/.exec(d.text)?.[1] ?? '?').trim())
      goActive.set(d.fileId, goActivity(d.text))
    } else if (d.classId === 4 && d.fileId) {
      const go = /m_GameObject: \{fileID: (-?\d+)\}/.exec(d.text)?.[1] ?? null
      const father = /m_Father: \{fileID: (-?\d+)\}/.exec(d.text)?.[1] ?? '0'
      transforms.set(d.fileId, { go, father })
      if (go) transformOfGo.set(go, d.fileId)
    }
  }
  /** `m_IsActive` on the GameObject AND on every ancestor — CLAUDE.md's liveness walk. */
  const isLive = (goId) => {
    if (vetoes(goActive.get(goId))) return false
    let t = transforms.get(transformOfGo.get(goId))
    for (let hops = 0; t && t.father !== '0' && hops < 64; hops++) {
      const parent = transforms.get(t.father)
      // A father that is not in this file is a stripped prefab-instance parent: the file cannot
      // answer for it, and an unknown is not a veto (see `goActivity`).
      if (!parent) return true
      if (parent.go && vetoes(goActive.get(parent.go))) return false
      t = parent
    }
    return true
  }
  return { goName, isLive }
}

function bakeReceipt(doc, live, envId, i) {
  const enabled = /\n {2}m_Enabled: (\d)/.exec(doc.text)?.[1]
  if (enabled === undefined) {
    die(
      `${envId}: generator ${i} has no m_Enabled — check the YAML dialect before believing it (DEV-043)`,
    )
  }
  const owner = /m_GameObject: \{fileID: (-?\d+)\}/.exec(doc.text)?.[1] ?? null
  const block = /\n {2}_StoredChunks:([\s\S]*?)(?=\n {2}\w|$)/.exec(doc.text)
  if (!block)
    die(
      `${envId}: generator ${i} has no _StoredChunks field — the dialect trap, or a different script`,
    )
  let bakedObjects = 0
  let unresolved = 0
  for (const m of block[1].matchAll(/- \{fileID: (-?\d+)\}/g)) {
    if (m[1] === '0') continue
    if (live.goName.has(m[1])) bakedObjects++
    else unresolved++
  }
  if (unresolved > 0) {
    die(
      `${envId}: generator ${i} references ${unresolved} baked object(s) that are not GameObjects in the same file`,
    )
  }
  const componentEnabled = enabled === '1' && owner !== null && live.isLive(owner)
  const note =
    bakedObjects > 0
      ? componentEnabled
        ? `2016 baked ${bakedObjects.toLocaleString()} objects from this pass; they are in the source file, one GameObject each.`
        : `2016 baked ${bakedObjects.toLocaleString()} objects and then disabled the component; the clones still ship, only their LOD toggling is off.`
      : componentEnabled
        ? 'NEVER BAKED. The component is enabled but its editor-only GenerateObjects() was never run, so the shipped 2016 build drew none of this pass. Drawing it is a deviation — DEV-102.'
        : 'DISABLED (m_Enabled: 0) AND NEVER BAKED. The shipped 2016 build drew none of this pass. Drawing it is a deviation — DEV-102.'
  return { componentEnabled, bakedObjects, note }
}

function buildEnvironment(envId) {
  const src = resolveSource(envId)
  const live = livenessIndex(src.all)
  const scatter = src.docs.map((doc, i) => {
    const mapGuid = guidOf(doc.text, 'ObjectPlacementMap')
    const mapRel = mapGuid ? (guidToPath.get(mapGuid) ?? null) : null
    if (!mapRel) die(`${envId}: generator ${i} has no resolvable ObjectPlacementMap`)

    const placementMapAsset = PLACEMENT_MAP_ASSET[mapRel] ?? null
    if (!placementMapAsset) die(`${envId}: no bucket path for placement map ${mapRel}`)
    const entry = { index: i, placementMap: mapRel, placementMapAsset }
    for (const [out, field] of SCATTER_FIELDS) {
      const v = scalar(doc.text, field)
      if (v === null) die(`${envId}: generator ${i} is missing ${field}`)
      entry[out] = v
    }
    const guids = objectPrefabGuids(doc.text)
    if (guids.length === 0) die(`${envId}: generator ${i} has an empty ObjectPrefabs`)
    entry.palette = guids.map(classifyPrefab)
    entry.paletteNote =
      'ORDERED, DUPLICATES INTACT. Random.Range(0, length) is uniform over indices, ' +
      'so repetition is the weighting. Never de-duplicate this array.'
    // What the 2016 file holds for this pass. Read by nothing at runtime — on
    // purpose, until DEV-102 is decided — and checked against the clones by
    // tests/unit/props-2016-bake.test.ts, so it cannot rot the way DEV-069's
    // unread constant did.
    entry.shipped2016 = bakeReceipt(doc, live, envId, i)
    return entry
  })

  return {
    $schema: './_schema.json',
    id: envId,
    environmentScene: ENVIRONMENT_SCENE[envId],
    source: { kind: src.kind, path: src.rel, note: src.note },
    scatter,
    // `landmarks: false` means the source is not an environment scene and its
    // hand-placed art belongs to something else — see `SCENE_SOURCE`.
    landmarks:
      SCENE_SOURCE[envId]?.landmarks === false
        ? []
        : landmarksIn(src.all, ENVIRONMENT_SCENE[envId]),
    landmarksConfidence:
      SCENE_SOURCE[envId]?.landmarks === false
        ? 'NOT EXTRACTED. This source is not an environment scene — see `source.note`. ' +
          'Its hand-placed art belongs to the screen the scene draws, not to the terrain, ' +
          'and none of it is emitted here. An empty array here is a DECISION, not a finding.'
        : src.inheritsFrom
          ? `UNVERIFIED. ${src.rel} is largely a modification set over ` +
            `${src.inheritsFrom.prefab} (${src.inheritsFrom.references} references), and this ` +
            'tool does not apply m_Modifications. These are PREFAB BASE values; the scene may ' +
            'override any of them. Treat as a hypothesis until the modification pass lands.'
          : 'verified — read directly from the shipped source, no prefab inheritance detected',
    landmarksNote:
      'Hand-authored placements: everything carrying a mesh that is NOT parented under a ' +
      "generator's `Objects Root`. Transforms are COMPOSED down the parent chain to the " +
      'environment root (exclusive), Unity space — the frame the terrain transform in the ' +
      'constants sheet is written in (DEV-135; they used to be the mesh node’s LOCAL ' +
      'transform, which for a palm under a `tree_palm_01` node was the origin). `live` is the ' +
      'm_IsActive walk: false means 2016 did not draw it, and Classic does not either. ' +
      'Clouds are excluded — tools/extract/level.mjs already reads them into the level ' +
      "JSON's `clouds` — and so is anything with no MeshFilter (colliders, the terrain root). " +
      'NOT here: props a MISSION scene places as stripped prefab instances. Those live in the ' +
      'LEVEL JSON now, as `props` in content/levels/*.json, in this same schema and this same ' +
      'frame (DEV-218, DEV-219). Three missions place any: adv_01_jumpSeat 1 live, ' +
      'int_01_jumpSeat 11 live palms, rookie_02_jumpSeat 12 live of 16 authored. This note ' +
      'used to name two of the three and describe rookie_02 as two objects, which is how a ' +
      '96-reference guid count got read as one prop: count the 1001 blocks, never the ' +
      'references.',
    _meta: {
      generator: GENERATOR_CS,
      generatedBy: 'tools/extract/props.mjs',
      geometry:
        'NONE. This file carries parameters and paths only. Every prop mesh in every ' +
        'shipped environment is bought or a bake of bought geometry — see the per-entry ' +
        'licence field, and docs/private/PROP-AUDIT.md.',
      grid:
        'Placement step is TerrainSize / map.width AFTER Unity import rescale. Both shipped ' +
        'maps are 1025x1025 with nPOTScale: 1, so width is 1024 and the step is 4.0 m on a ' +
        '4096 m terrain. Go through importUnityTexture(), never the raw PNG (DEV-007).',
      scatterIsNotReproducible:
        "2016's scatter used an UNSEEDED UnityEngine.Random inside an editor-only " +
        'GenerateObjects(), so the shipped layout cannot be regenerated. It was verified to be ' +
        'pure generator output (grid test, docs/private/PROP-AUDIT.md §4): desert is 9,600 on-grid ' +
        'against 53 hand-placed landmarks, and alpine is on-grid once the Tree Pack prefab ' +
        'offsets are accounted for. Nothing was hand-tuned, so re-rolling with a SEEDED prng ' +
        'loses no authored intent.',
      shipped2016:
        'A component is not a bake. Only two passes were ever RUN in 2016 — alpine’s ' +
        'Tree_Organic pass and desert’s — and each scatter[] entry’s `shipped2016` says ' +
        'what its source file holds. A pass with bakedObjects 0 is one the 2016 build never ' +
        'drew; this port draws it anyway until DEV-102 is decided.',
    },
  }
}

// ── main ──────────────────────────────────────────────────────────────────

const ids = onlyEnv ? [onlyEnv] : Object.keys(ENVIRONMENT_SCENE)
for (const id of ids) {
  if (!ENVIRONMENT_SCENE[id])
    die(`unknown environment '${id}' — try ${Object.keys(ENVIRONMENT_SCENE).join(', ')}`)
}

assertOutsideLegacy(OUT_DIR)
fs.mkdirSync(OUT_DIR, { recursive: true })
let changed = 0
for (const id of ids) {
  const env = buildEnvironment(id)
  const out = path.join(OUT_DIR, `${id}.json`)
  const text = `${JSON.stringify(env, null, 2)}\n`
  const prev = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null
  const differs = prev !== text
  if (differs) changed++
  if (!checkOnly && differs) fs.writeFileSync(out, text)

  const packs = env.scatter.flatMap((s) => s.palette.map((p) => p.licence))
  const blocked = packs.filter((l) => l !== 'KEEP').length
  // Say what 2016 baked, per pass, every run — so a never-run pass is a line
  // somebody reads rather than a field somebody has to know to look for.
  const baked = env.scatter
    .map((s) =>
      s.shipped2016.bakedObjects > 0
        ? `[${s.index}] ${s.shipped2016.bakedObjects.toLocaleString()} baked`
        : `[${s.index}] ${s.shipped2016.componentEnabled ? 'NEVER BAKED' : 'DISABLED, never baked'}`,
    )
    .join(', ')
  console.log(
    `  ${id.padEnd(8)} ${env.source.kind.padEnd(6)} ${String(env.scatter.length)} generator(s), ` +
      `${packs.length} palette entries (${blocked} not KEEP)` +
      (differs ? (checkOnly ? '   CHANGED' : '   written') : '   unchanged') +
      `\n           2016: ${baked}`,
  )
}

if (checkOnly && changed > 0) {
  console.error(`extract:props: ${changed} file(s) would change. Run \`pnpm extract:props\`.`)
  process.exit(1)
}
console.log(`extract:props: ${ids.length} environment(s), ${changed} changed.`)
