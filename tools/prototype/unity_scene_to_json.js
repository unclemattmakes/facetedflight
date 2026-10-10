#!/usr/bin/env node
/**
 * unity_scene_to_json.js -- flatten a Unity 5.4 ForceText .unity scene (or .prefab) into JSON
 * that a three.js port can consume directly.
 *
 * Usage:
 *   node unity_scene_to_json.js <scene.unity> [options]
 *
 * Options:
 *   --out <file.json>     output path (default: <prototype>/out/<sceneBaseName>.scene.json)
 *   --project <dir>       Unity project root containing "Assets" (auto-detected from the scene path)
 *   --guid-index <tsv>    guid<TAB>Assets/relative/path (default: docs/research/_guid_index.tsv)
 *   --expand-prefabs      also emit every GameObject *inside* each prefab instance
 *   --no-prefab-resolve   do not open prefab files; prefab-instance transforms then come only from
 *                         m_Modifications (missing overrides fall back to identity)
 *   --pretty              pretty-print the JSON (default is compact; the summary is always printed)
 *   --summary-only        print the summary, write no file
 *   --filter <substr>     only emit objects whose name OR script name contains <substr>
 *
 * NEVER writes into the Unity project. Output always goes to --out or <prototype>/out/.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IT SOLVES
 *
 * Unity 5.4 scenes store *local* transforms plus a parent chain, and prefab instances are NOT
 * expanded into the scene file. A naive "grep m_LocalPosition" gives you numbers that are wrong for
 * every nested object and missing entirely for every prefab. This tool:
 *
 *   1. Parses the multi-document YAML with ../unity_yaml.js (fileIDs kept as STRINGS -- they
 *      exceed Number.MAX_SAFE_INTEGER).
 *   2. Builds fileId -> document and gameObject -> components maps.
 *   3. Handles the three kinds of transform node found in a 5.4 scene:
 *        a. a plain "--- !u!4 &id  Transform" with m_Father,
 *        b. a "--- !u!4 &id stripped  Transform" whose real data lives in a prefab asset
 *           (m_PrefabParentObject {fileID,guid}) and whose instance overrides live in the
 *           "--- !u!1001 Prefab" document named by m_PrefabInternal,
 *        c. the "--- !u!1001 Prefab" document itself, which is the instance root; its parent is
 *           m_Modification.m_TransformParent and its local TRS comes from m_Modifications
 *           (propertyPath m_LocalPosition.x etc.) layered over the prefab asset's own values.
 *   4. Composes world matrices down the chain and decomposes them back to position / quaternion /
 *      scale, in RAW UNITY SPACE, and additionally emits `worldThree` in three.js/glTF space
 *      (see COORDINATE CONVENTION below).
 *   5. Attaches every MonoBehaviour with its resolved script NAME and its full raw serialized
 *      fields, plus MeshFilter/MeshRenderer/Collider/Light/Camera/Rigidbody summaries.
 *
 * COORDINATE CONVENTION
 *   Unity is left-handed, Y-up, +Z forward. glTF/three.js is right-handed, Y-up, -Z forward.
 *   The mapping used here (and by unity_mesh_to_obj.js --three) is "negate Z":
 *       position  (x, y, z)     -> (x, y, -z)
 *       quaternion(x, y, z, w)  -> (-x, -y, z, w)
 *       scale     (x, y, z)     -> (x, y, z)          [unchanged]
 *       euler XYZ (x, y, z)deg  -> (-x, -y, z)deg
 *       triangle winding        -> reversed
 *   This is a mirror, so a mesh converted this way and a transform converted this way stay
 *   consistent with each other. See docs/research/07-asset-pipeline.md "Coordinate conversion rule".
 */
'use strict';
const fs = require('fs');
const path = require('path');
// This repo's root, derived from __dirname rather than hard-coded. These two
// scripts defaulted to an absolute path INSIDE this repository, which is a
// worse version of the $FF2_LEGACY problem: it hard-codes where the CHECKOUT
// lives, so the default was wrong for every clone but one.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { parseDocuments } = require('./unity_yaml.js');

/* ------------------------------------------------------------------ math -- */

function quatToMat(q) { // column-major-agnostic: returns row-major 3x3 flattened in a 4x4
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    1 - (yy + zz), xy - wz, xz + wy, 0,
    xy + wz, 1 - (xx + zz), yz - wx, 0,
    xz - wy, yz + wx, 1 - (xx + yy), 0,
    0, 0, 0, 1,
  ];
}
function compose(t, q, s) {
  const m = quatToMat(q);
  m[0] *= s.x; m[1] *= s.y; m[2] *= s.z;
  m[4] *= s.x; m[5] *= s.y; m[6] *= s.z;
  m[8] *= s.x; m[9] *= s.y; m[10] *= s.z;
  m[3] = t.x; m[7] = t.y; m[11] = t.z;
  return m;
}
function mul(a, b) { // row-major 4x4
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    let v = 0; for (let k = 0; k < 4; k++) v += a[r * 4 + k] * b[k * 4 + c];
    o[r * 4 + c] = v;
  }
  return o;
}
function decompose(m) {
  const pos = { x: m[3], y: m[7], z: m[11] };
  let sx = Math.hypot(m[0], m[4], m[8]);
  const sy = Math.hypot(m[1], m[5], m[9]);
  const sz = Math.hypot(m[2], m[6], m[10]);
  // negative determinant -> mirror; fold the sign into X (Unity's own convention)
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
  if (det < 0) sx = -sx;
  const r = [m[0] / sx, m[1] / sy, m[2] / sz, m[4] / sx, m[5] / sy, m[6] / sz, m[8] / sx, m[9] / sy, m[10] / sz];
  const tr = r[0] + r[4] + r[8];
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = { w: s / 4, x: (r[7] - r[5]) / s, y: (r[2] - r[6]) / s, z: (r[3] - r[1]) / s }; }
  else if (r[0] > r[4] && r[0] > r[8]) { const s = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2; q = { w: (r[7] - r[5]) / s, x: s / 4, y: (r[1] + r[3]) / s, z: (r[2] + r[6]) / s }; }
  else if (r[4] > r[8]) { const s = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2; q = { w: (r[2] - r[6]) / s, x: (r[1] + r[3]) / s, y: s / 4, z: (r[5] + r[7]) / s }; }
  else { const s = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2; q = { w: (r[3] - r[1]) / s, x: (r[2] + r[6]) / s, y: (r[5] + r[7]) / s, z: s / 4 }; }
  return { position: pos, quaternion: q, scale: { x: sx, y: sy, z: sz } };
}
/** Unity quaternion -> Euler XYZ degrees (three.js 'XYZ' order, applied to the CONVERTED quat). */
function quatToEulerXYZ(q) {
  const m = quatToMat(q);
  const clamp = (v) => Math.min(1, Math.max(-1, v));
  const y = Math.asin(clamp(m[2]));
  let x, z;
  if (Math.abs(m[2]) < 0.9999999) { x = Math.atan2(-m[6], m[10]); z = Math.atan2(-m[1], m[0]); }
  else { x = Math.atan2(m[9], m[5]); z = 0; }
  const D = 180 / Math.PI;
  return { x: x * D, y: y * D, z: z * D };
}
const R6 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(6)) : v);
const rv = (o) => (o ? { x: R6(o.x), y: R6(o.y), z: R6(o.z), ...(o.w !== undefined ? { w: R6(o.w) } : {}) } : o);

/** Unity (LH, +Z forward) -> three.js/glTF (RH, -Z forward): negate Z. */
const toThreePos = (p) => ({ x: R6(p.x), y: R6(p.y), z: R6(-p.z) });
const toThreeQuat = (q) => ({ x: R6(-q.x), y: R6(-q.y), z: R6(q.z), w: R6(q.w) });

/* --------------------------------------------------------------- helpers -- */

const num = (v) => (typeof v === 'number' ? v : (typeof v === 'string' && v !== '' && !isNaN(Number(v)) ? Number(v) : 0));
const V3 = (o, d = 0) => ({ x: o ? num(o.x) : d, y: o ? num(o.y) : d, z: o ? num(o.z) : d });
const Q4 = (o) => (o ? { x: num(o.x), y: num(o.y), z: num(o.z), w: o.w === undefined ? 1 : num(o.w) } : { x: 0, y: 0, z: 0, w: 1 });
const fid = (ref) => (ref && ref.fileID !== undefined && ref.fileID !== null ? String(ref.fileID) : null);
const isRef = (v) => v && typeof v === 'object' && v.fileID !== undefined;

const CLASS_NAMES = {
  1: 'GameObject', 4: 'Transform', 20: 'Camera', 21: 'Material', 23: 'MeshRenderer', 25: 'Renderer',
  28: 'Texture2D', 29: 'SceneSettings', 33: 'MeshFilter', 43: 'Mesh', 45: 'Skybox', 54: 'Rigidbody',
  56: 'Joint', 64: 'MeshCollider', 65: 'BoxCollider', 81: 'AudioListener', 82: 'AudioSource',
  92: 'Behaviour', 95: 'Animator', 104: 'RenderSettings', 108: 'Light', 111: 'Animation',
  114: 'MonoBehaviour', 115: 'MonoScript', 120: 'LineRenderer', 122: 'ParticleAnimator',
  124: 'Behaviour', 135: 'SphereCollider', 136: 'CapsuleCollider', 157: 'LightmapSettings',
  196: 'NavMeshSettings', 198: 'ParticleSystem', 199: 'ParticleSystemRenderer', 212: 'SpriteRenderer',
  220: 'LightProbeGroup', 221: 'AnimatorOverrideController', 222: 'CanvasRenderer', 223: 'Canvas',
  224: 'RectTransform', 225: 'CanvasGroup', 1001: 'Prefab', 1002: 'EditorExtensionImpl',
};

/** Built-in engine assemblies: their MonoScript guid is constant across all Unity 5.x projects and
 *  never appears in Assets/, so the project guid index cannot resolve them. fileIDs below were
 *  observed in this project's shipped scenes. */
const BUILTIN_SCRIPTS = {
  f5f67c52d1564df4a8936ccd202a3bd8: {
    _asm: 'UnityEngine.UI',
    '-619905303': 'EventSystem',
    '1077351063': 'StandaloneInputModule',
    '-1077751063': 'TouchInputModule',
    '1980459831': 'CanvasScaler',
    '1301386320': 'GraphicRaycaster',
    '-765806418': 'Image',
    '708705254': 'Text',
    '1344253309': 'RawImage',
    '1392445389': 'Button',
    '-1072084488': 'Toggle',
    '-813898774': 'Slider',
    '1741964061': 'Mask',
    '-2061169968': 'ContentSizeFitter',
    '-405508275': 'LayoutElement',
    '1741964060': 'Outline',
    '-2013507442': 'Shadow',
  },
};

/* ------------------------------------------------------------ guid index -- */

function loadGuidIndex(p) {
  const map = new Map();
  if (!p) return map;
  // DEV-681: a missing index used to return an empty map, which reads as "no MonoBehaviour matches its
  // script" ("no Level in <scene>", "scripts: (none)") instead of as a missing file. The repo-owned
  // loader is tools/unity/guid-index.mjs; this copy only serves the CLI and ff_route_report.js.
  if (!fs.existsSync(p)) {
    throw new Error('guid index missing: ' + p + ' (gitignored; tools/agent/hydrate.ps1 copies it from the main checkout, see tools/unity/guid-index.mjs for how to rebuild it)');
  }
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('\t');
    if (i > 0) map.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return map;
}

/** Find the Unity project root (the dir containing "Assets") from any path inside it. */
function findProjectRoot(p) {
  let d = path.resolve(p);
  for (let i = 0; i < 12; i++) {
    d = path.dirname(d);
    if (path.basename(d) === 'Assets') return path.dirname(d);
    if (fs.existsSync(path.join(d, 'Assets')) && fs.existsSync(path.join(d, 'ProjectSettings'))) return d;
  }
  return null;
}

/* ------------------------------------------------------------ asset cache -- */

class Project {
  constructor(root, guidIndex) { this.root = root; this.guids = guidIndex; this.cache = new Map(); }
  pathFor(guid) { return this.guids.get(guid) || null; }
  absFor(guid) { const r = this.pathFor(guid); return r && this.root ? path.join(this.root, r) : null; }
  /** Parse an asset by guid; returns {byId:Map, docs:[]} or null. Cached. */
  load(guid) {
    if (this.cache.has(guid)) return this.cache.get(guid);
    let res = null;
    const abs = this.absFor(guid);
    if (abs && fs.existsSync(abs) && /\.(prefab|unity|asset|controller)$/i.test(abs)) {
      try {
        let t = fs.readFileSync(abs, 'utf8');
        if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
        if (t.startsWith('%YAML')) {
          const docs = parseDocuments(t);
          const byId = new Map();
          for (const d of docs) byId.set(String(d.fileId), d);
          res = { path: this.pathFor(guid), docs, byId };
        }
      } catch (e) { res = null; }
    }
    this.cache.set(guid, res);
    return res;
  }
}

/* --------------------------------------------------------------- extract -- */

function extract(scenePath, opts) {
  let text = fs.readFileSync(scenePath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const docs = parseDocuments(text);

  const byId = new Map();            // fileId(string) -> doc
  const classCounts = {};
  for (const d of docs) {
    byId.set(String(d.fileId), d);
    const n = CLASS_NAMES[d.classId] || `class${d.classId}`;
    classCounts[n] = (classCounts[n] || 0) + 1;
  }

  const project = opts.project ? new Project(opts.project, opts.guidIndex) : new Project(null, opts.guidIndex);

  /* --- index prefab instances (1001) ------------------------------------ */
  // instanceId -> { parentTransformId, mods:Map("<targetFileId>|<propertyPath>" -> {value,objectReference}),
  //                 prefabGuid, prefabPath, rootObjects:[] }
  const instances = new Map();
  for (const d of docs) {
    if (d.classId !== 1001) continue;
    const m = d.data.m_Modification || {};
    const mods = new Map();
    for (const mod of (m.m_Modifications || [])) {
      if (!mod || !mod.propertyPath) continue;
      mods.set(`${fid(mod.target)}|${mod.propertyPath}`, { value: mod.value, objectReference: mod.objectReference });
    }
    instances.set(String(d.fileId), {
      id: String(d.fileId),
      parentTransformId: fid(m.m_TransformParent),
      mods,
      prefabGuid: (d.data.m_ParentPrefab && d.data.m_ParentPrefab.guid) || (mod0Guid(m.m_Modifications)) || null,
      isPrefabParent: num(d.data.m_IsPrefabParent),
    });
  }
  function mod0Guid(list) { for (const x of (list || [])) if (x && x.target && x.target.guid) return x.target.guid; return null; }
  for (const inst of instances.values()) inst.prefabPath = inst.prefabGuid ? project.pathFor(inst.prefabGuid) : null;

  /* --- transform nodes -------------------------------------------------- */
  // Every node gets: { key, kind, name, parentKey, local:{t,q,s}, srcDoc }
  // key is "<sceneFileId>" for scene transforms, or "<instanceId>:<prefabFileId>" for prefab-internal.
  const nodes = new Map();

  function prefabTransform(instId, prefabGuid, prefabFileId) {
    // returns {t,q,s,parentPrefabFileId,goFileId} for a transform inside the prefab asset,
    // with instance modifications applied.
    const inst = instances.get(instId);
    const asset = opts.resolvePrefabs && prefabGuid ? project.load(prefabGuid) : null;
    const doc = asset ? asset.byId.get(String(prefabFileId)) : null;
    const base = doc && doc.data ? doc.data : {};
    let t = V3(base.m_LocalPosition), q = Q4(base.m_LocalRotation), s = base.m_LocalScale ? V3(base.m_LocalScale) : { x: 1, y: 1, z: 1 };
    if (!base.m_LocalScale) s = { x: 1, y: 1, z: 1 };
    const get = (pp) => (inst ? inst.mods.get(`${prefabFileId}|${pp}`) : undefined);
    for (const [comp, obj] of [['x', t], ['y', t], ['z', t]]) { const m = get('m_LocalPosition.' + comp); if (m) obj[comp] = num(m.value); }
    for (const comp of ['x', 'y', 'z', 'w']) { const m = get('m_LocalRotation.' + comp); if (m) q[comp] = num(m.value); }
    for (const comp of ['x', 'y', 'z']) { const m = get('m_LocalScale.' + comp); if (m) s[comp] = num(m.value); }
    const parentPrefabFileId = doc ? fid(doc.data.m_Father) : null;
    return { t, q, s, parentPrefabFileId: parentPrefabFileId === '0' ? null : parentPrefabFileId,
      goFileId: doc ? fid(doc.data.m_GameObject) : null, prefabDoc: doc, asset };
  }

  function instMod(instId, targetFileId, pp) {
    const inst = instances.get(instId); if (!inst) return undefined;
    const m = inst.mods.get(`${targetFileId}|${pp}`); return m ? m.value : undefined;
  }

  // 1. plain + stripped scene transforms (classId 4 and 224 RectTransform)
  for (const d of docs) {
    if (d.classId !== 4 && d.classId !== 224) continue;
    const key = String(d.fileId);
    if (d.stripped) {
      const ppo = d.data.m_PrefabParentObject || {};
      const instId = fid(d.data.m_PrefabInternal);
      const pf = prefabTransform(instId, ppo.guid, fid(ppo));
      const inst = instances.get(instId);
      nodes.set(key, {
        key, kind: 'stripped', sceneFileId: key, instanceId: instId,
        prefabGuid: ppo.guid || null, prefabFileId: fid(ppo),
        prefabPath: inst ? inst.prefabPath : (ppo.guid ? project.pathFor(ppo.guid) : null),
        local: { t: pf.t, q: pf.q, s: pf.s },
        parentKey: pf.parentPrefabFileId ? `${instId}:${pf.parentPrefabFileId}` : (inst ? inst.parentTransformId : null),
        goFileId: pf.goFileId, goPrefabFileId: pf.goFileId, doc: d, prefabDoc: pf.prefabDoc,
      });
    } else {
      const father = fid(d.data.m_Father);
      nodes.set(key, {
        key, kind: 'scene', sceneFileId: key,
        local: { t: V3(d.data.m_LocalPosition), q: Q4(d.data.m_LocalRotation), s: V3(d.data.m_LocalScale) },
        parentKey: father && father !== '0' ? father : null,
        goFileId: fid(d.data.m_GameObject), rootOrder: num(d.data.m_RootOrder),
        eulerHint: d.data.m_LocalEulerAnglesHint ? V3(d.data.m_LocalEulerAnglesHint) : null,
        doc: d, isRect: d.classId === 224,
      });
    }
  }

  // 2. prefab instances that have NO stripped transform in the scene: synthesise a root node.
  //    Unity always writes a stripped root transform when something references it; when nothing
  //    does, the instance root exists only in the 1001 doc.
  const strippedByInstance = new Map();
  for (const n of nodes.values()) if (n.kind === 'stripped') {
    if (!strippedByInstance.has(n.instanceId)) strippedByInstance.set(n.instanceId, []);
    strippedByInstance.get(n.instanceId).push(n);
  }
  for (const inst of instances.values()) {
    // the transform fileIds this instance modifies
    const touched = new Set();
    for (const k of inst.mods.keys()) { const [tid, pp] = k.split('|'); if (pp.startsWith('m_Local') || pp === 'm_RootOrder') touched.add(tid); }
    const have = new Set((strippedByInstance.get(inst.id) || []).map(n => n.prefabFileId));
    for (const tid of touched) {
      if (have.has(tid)) continue;
      const key = `${inst.id}:${tid}`;
      if (nodes.has(key)) continue;
      const pf = prefabTransform(inst.id, inst.prefabGuid, tid);
      nodes.set(key, {
        key, kind: 'prefabRoot', instanceId: inst.id, prefabGuid: inst.prefabGuid, prefabFileId: tid,
        prefabPath: inst.prefabPath,
        local: { t: pf.t, q: pf.q, s: pf.s },
        parentKey: pf.parentPrefabFileId ? `${inst.id}:${pf.parentPrefabFileId}` : inst.parentTransformId,
        goFileId: pf.goFileId, prefabDoc: pf.prefabDoc,
      });
    }
  }

  // 2b. CLOSE THE PARENT CHAIN. A stripped transform's father may be another transform *inside* the
  //     prefab that the scene never mentions (Unity only writes stripped stubs for transforms the
  //     scene actually references). Without these intermediate nodes the world transform silently
  //     collapses to the local one -- which is how the player spawn point came out at (0, 0.67, 1.3)
  //     instead of its real world position. Walk each chain up to the prefab root and synthesise
  //     every missing link.
  {
    let added = true, rounds = 0;
    while (added && rounds++ < 64) {
      added = false;
      for (const n of [...nodes.values()]) {
        const pk = n.parentKey;
        if (!pk || nodes.has(pk) || !pk.includes(':')) continue;
        const [instId, tid] = pk.split(':');
        const inst = instances.get(instId);
        if (!inst) continue;
        const pf = prefabTransform(instId, inst.prefabGuid, tid);
        nodes.set(pk, {
          key: pk, kind: 'prefabAncestor', instanceId: instId, prefabGuid: inst.prefabGuid,
          prefabFileId: tid, prefabPath: inst.prefabPath,
          local: { t: pf.t, q: pf.q, s: pf.s },
          parentKey: pf.parentPrefabFileId ? `${instId}:${pf.parentPrefabFileId}` : inst.parentTransformId,
          goFileId: pf.goFileId, prefabDoc: pf.prefabDoc,
        });
        added = true;
      }
    }
  }

  // 3. optional: expand every transform inside every prefab instance
  if (opts.expandPrefabs) {
    for (const inst of instances.values()) {
      const asset = inst.prefabGuid ? project.load(inst.prefabGuid) : null;
      if (!asset) continue;
      for (const d of asset.docs) {
        if (d.classId !== 4 && d.classId !== 224) continue;
        const key = `${inst.id}:${d.fileId}`;
        if (nodes.has(key)) continue;
        const pf = prefabTransform(inst.id, inst.prefabGuid, String(d.fileId));
        nodes.set(key, {
          key, kind: 'prefabChild', instanceId: inst.id, prefabGuid: inst.prefabGuid, prefabFileId: String(d.fileId),
          prefabPath: inst.prefabPath, local: { t: pf.t, q: pf.q, s: pf.s },
          parentKey: pf.parentPrefabFileId ? `${inst.id}:${pf.parentPrefabFileId}` : inst.parentTransformId,
          goFileId: pf.goFileId, prefabDoc: pf.prefabDoc,
        });
      }
    }
  }

  /* --- world matrices --------------------------------------------------- */
  const worldCache = new Map();
  function world(key, guard = 0) {
    if (worldCache.has(key)) return worldCache.get(key);
    const n = nodes.get(key);
    if (!n || guard > 64) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const local = compose(n.local.t, n.local.q, n.local.s);
    const m = n.parentKey && nodes.has(n.parentKey) ? mul(world(n.parentKey, guard + 1), local) : local;
    worldCache.set(key, m);
    return m;
  }

  /* --- components ------------------------------------------------------- */
  // scene GameObjects -> component docs
  const compsOfGo = new Map();
  for (const d of docs) {
    if (d.classId !== 1) continue;
    const list = [];
    for (const entry of (d.data.m_Component || [])) {
      // entry is {"<classId>": {fileID: n}} in 5.4
      for (const k of Object.keys(entry)) { const r = entry[k]; if (isRef(r)) list.push({ classId: Number(k), fileId: fid(r) }); }
    }
    compsOfGo.set(String(d.fileId), list);
  }

  const scriptNameCache = new Map();
  function scriptName(guid, fileID) {
    // Built-in engine assemblies are not in Assets/, so they are not in the guid index.
    const b = BUILTIN_SCRIPTS[guid];
    if (b) return b[String(fileID)] || `${b._asm}:${fileID}`;
    if (!guid) return null;
    if (scriptNameCache.has(guid)) return scriptNameCache.get(guid);
    const p = project.pathFor(guid);
    const n = p ? path.basename(p).replace(/\.cs$/i, '') : null;
    scriptNameCache.set(guid, n);
    return n;
  }

  function refInfo(r) {
    if (!isRef(r)) return null;
    const o = { fileID: String(r.fileID) };
    if (r.guid) { o.guid = r.guid; const p = project.pathFor(r.guid); if (p) o.path = p; }
    if (r.type !== undefined) o.type = r.type;
    return o;
  }

  function describeComponent(doc, sourceLabel) {
    const cn = CLASS_NAMES[doc.classId] || `class${doc.classId}`;
    const c = { classId: doc.classId, type: cn, fileID: String(doc.fileId) };
    if (sourceLabel) c.source = sourceLabel;
    const d = doc.data || {};
    if (d.m_Enabled !== undefined) c.enabled = num(d.m_Enabled);
    switch (doc.classId) {
      case 114: {
        c.script = refInfo(d.m_Script);
        c.scriptName = c.script ? scriptName(c.script.guid, c.script.fileID) : null;
        if (!c.script || String(c.script.fileID) === '0') c.MISSING_SCRIPT = true;
        const fields = {};
        for (const [k, v] of Object.entries(d)) {
          if (['m_ObjectHideFlags', 'm_PrefabParentObject', 'm_PrefabInternal', 'm_GameObject', 'm_Enabled', 'm_EditorHideFlags', 'm_Script', 'm_Name', 'm_EditorClassIdentifier'].includes(k)) continue;
          fields[k] = isRef(v) ? refInfo(v) : v;
        }
        c.fields = fields;
        break;
      }
      case 33: c.mesh = refInfo(d.m_Mesh); break;
      case 23: case 199: case 212: case 120:
        c.materials = (d.m_Materials || []).map(refInfo);
        c.castShadows = d.m_CastShadows; c.receiveShadows = d.m_ReceiveShadows;
        c.lightmapIndex = d.m_LightmapIndex;
        break;
      case 65: c.isTrigger = num(d.m_IsTrigger); c.size = rv(V3(d.m_Size)); c.center = rv(V3(d.m_Center)); break;
      case 135: c.isTrigger = num(d.m_IsTrigger); c.radius = R6(num(d.m_Radius)); c.center = rv(V3(d.m_Center)); break;
      case 136: c.isTrigger = num(d.m_IsTrigger); c.radius = R6(num(d.m_Radius)); c.height = R6(num(d.m_Height)); c.direction = num(d.m_Direction); c.center = rv(V3(d.m_Center)); break;
      case 64: c.isTrigger = num(d.m_IsTrigger); c.convex = num(d.m_Convex); c.mesh = refInfo(d.m_Mesh); break;
      case 54: c.mass = num(d.m_Mass); c.drag = num(d.m_Drag); c.angularDrag = num(d.m_AngularDrag); c.useGravity = num(d.m_UseGravity); c.isKinematic = num(d.m_IsKinematic); c.constraints = num(d.m_Constraints); c.interpolate = num(d.m_Interpolate); c.collisionDetection = num(d.m_CollisionDetection); break;
      case 108: c.lightType = num(d.m_Type); c.color = d.m_Color; c.intensity = num(d.m_Intensity); c.range = num(d.m_Range); c.spotAngle = num(d.m_SpotAngle); c.shadows = d.m_Shadows ? num(d.m_Shadows.m_Type) : 0; c.cullingMask = d.m_CullingMask; break;
      case 20: c.fov = num(d.field_of_view); c.near = num(d.near_clip_plane); c.far = num(d.far_clip_plane); c.clearFlags = num(d.m_ClearFlags); c.backGroundColor = d.m_BackGroundColor; c.cullingMask = d.m_CullingMask; c.depth = num(d.m_Depth); c.orthographic = num(d.orthographic); break;
      case 82: c.audioClip = refInfo(d.m_audioClip); c.playOnAwake = num(d.m_PlayOnAwake); c.volume = num(d.m_Volume); c.pitch = num(d.m_Pitch); c.loop = num(d.Loop); c.spatialBlend = num(d.panLevelCustomCurve ? 1 : 0); c.minDistance = num(d.MinDistance); c.maxDistance = num(d.MaxDistance); break;
      case 95: c.controller = refInfo(d.m_Controller); c.applyRootMotion = num(d.m_ApplyRootMotion); c.cullingMode = num(d.m_CullingMode); break;
      case 111: c.animation = refInfo(d.m_Animation); c.animations = (d.m_Animations || []).map(refInfo); c.playAutomatically = num(d.m_PlayAutomatically); c.wrapMode = num(d.m_WrapMode); break;
      case 198: c.lengthInSec = num(d.lengthInSec); c.looping = num(d.looping); c.prewarm = num(d.prewarm); break;
      case 223: c.renderMode = num(d.m_RenderMode); c.planeDistance = num(d.m_PlaneDistance); c.worldCamera = refInfo(d.m_Camera); break;
    }
    return c;
  }

  /* --- assemble objects ------------------------------------------------- */
  const objects = [];
  const nameOf = new Map();

  function goData(n) {
    // returns {name, tag, layer, active, components:[docs], scriptSource}
    if (n.kind === 'scene') {
      const go = n.goFileId ? byId.get(n.goFileId) : null;
      if (!go) return null;
      return {
        name: String(go.data.m_Name === undefined ? '' : go.data.m_Name),
        tag: go.data.m_TagString, layer: num(go.data.m_Layer), active: num(go.data.m_IsActive),
        staticFlags: num(go.data.m_StaticEditorFlags),
        comps: (compsOfGo.get(n.goFileId) || []).map(c => byId.get(c.fileId)).filter(Boolean).map(d => describeComponent(d, 'scene')),
      };
    }
    // prefab-backed
    const instId = n.instanceId;
    const goPrefabId = n.goFileId;
    const asset = n.prefabGuid ? project.load(n.prefabGuid) : null;
    const goDoc = asset && goPrefabId ? asset.byId.get(String(goPrefabId)) : null;
    const gd = goDoc ? goDoc.data : {};
    const ov = (pp, dflt) => { const v = instMod(instId, goPrefabId, pp); return v !== undefined ? v : dflt; };
    const comps = [];
    if (goDoc) {
      for (const entry of (gd.m_Component || [])) {
        for (const k of Object.keys(entry)) {
          const r = entry[k]; if (!isRef(r)) continue;
          const cd = asset.byId.get(String(r.fileID));
          if (!cd) continue;
          const desc = describeComponent(cd, 'prefab');
          // apply instance overrides to this component
          const pre = `${String(r.fileID)}|`;
          const inst = instances.get(instId);
          if (inst) {
            const over = {};
            for (const [mk, mv] of inst.mods) if (mk.startsWith(pre)) over[mk.slice(pre.length)] = mv.objectReference && String(mv.objectReference.fileID) !== '0' ? refInfo(mv.objectReference) : mv.value;
            if (Object.keys(over).length) desc.instanceOverrides = over;
          }
          comps.push(desc);
        }
      }
    }
    return {
      name: String(ov('m_Name', gd.m_Name === undefined ? '' : gd.m_Name)),
      tag: ov('m_TagString', gd.m_TagString),
      layer: num(ov('m_Layer', gd.m_Layer)),
      active: num(ov('m_IsActive', gd.m_IsActive === undefined ? 1 : gd.m_IsActive)),
      staticFlags: num(ov('m_StaticEditorFlags', gd.m_StaticEditorFlags)),
      comps,
    };
  }

  for (const n of nodes.values()) {
    const g = goData(n);
    nameOf.set(n.key, g ? g.name : (n.kind === 'stripped' ? '(prefab)' : '(unknown)'));
  }
  function fullPath(key, guard = 0) {
    const n = nodes.get(key);
    if (!n || guard > 64) return nameOf.get(key) || '?';
    const me = nameOf.get(key) || '?';
    return n.parentKey && nodes.has(n.parentKey) ? fullPath(n.parentKey, guard + 1) + '/' + me : me;
  }
  function activeInHierarchy(key, g, guard = 0) {
    const n = nodes.get(key);
    if (!n || guard > 64) return !!(g && g.active);
    if (g && !g.active) return false;
    if (!n.parentKey || !nodes.has(n.parentKey)) return true;
    const pg = goData(nodes.get(n.parentKey));
    return activeInHierarchy(n.parentKey, pg, guard + 1);
  }

  for (const n of nodes.values()) {
    const g = goData(n);
    const m = world(n.key);
    const d = decompose(m);
    const o = {
      key: n.key, kind: n.kind,
      name: g ? g.name : null,
      path: fullPath(n.key),
      tag: g ? g.tag : null, layer: g ? g.layer : null,
      active: g ? !!g.active : null,
      activeInHierarchy: activeInHierarchy(n.key, g),
      staticFlags: g ? g.staticFlags : null,
      parent: n.parentKey,
      rootOrder: n.rootOrder,
      local: { position: rv(n.local.t), rotation: rv(n.local.q), scale: rv(n.local.s), eulerHint: n.eulerHint ? rv(n.eulerHint) : undefined },
      world: { position: rv(d.position), rotation: rv(d.quaternion), scale: rv(d.scale), eulerDeg: rv(quatToEulerXYZ(d.quaternion)) },
      worldThree: { position: toThreePos(d.position), quaternion: toThreeQuat(d.quaternion), scale: rv(d.scale) },
      components: g ? g.comps : [],
    };
    if (n.prefabGuid) o.prefab = { guid: n.prefabGuid, path: n.prefabPath, instanceId: n.instanceId, prefabFileId: n.prefabFileId };
    o.scripts = o.components.filter(c => c.classId === 114).map(c => ({ name: c.scriptName, guid: c.script && c.script.guid, fileID: c.fileID, enabled: c.enabled, fields: c.fields, instanceOverrides: c.instanceOverrides }));
    objects.push(o);
  }

  objects.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  /* --- scene-level settings --------------------------------------------- */
  const rsDoc = docs.find(d => d.classId === 104);
  const lmDoc = docs.find(d => d.classId === 157);
  const nmDoc = docs.find(d => d.classId === 196);

  /* --- summary ---------------------------------------------------------- */
  const scriptCounts = {};
  for (const o of objects) for (const s of o.scripts) { const k = s.name || `guid:${s.guid}`; scriptCounts[k] = (scriptCounts[k] || 0) + 1; }
  const compCounts = {};
  for (const o of objects) for (const c of o.components) compCounts[c.type] = (compCounts[c.type] || 0) + 1;

  return {
    meta: {
      source: scenePath.replace(/\\/g, '/'),
      generatedBy: 'unity_scene_to_json.js',
      generatedAt: new Date().toISOString(),
      projectRoot: project.root ? project.root.replace(/\\/g, '/') : null,
      prefabsResolved: !!opts.resolvePrefabs,
      prefabsExpanded: !!opts.expandPrefabs,
      coordinateSpace: 'world/local are RAW UNITY (left-handed, +Z forward); worldThree is three.js/glTF (negate Z, quat -> (-x,-y,z,w))',
      documentCount: docs.length,
      unityClassCounts: classCounts,
      gameObjectCount: classCounts.GameObject || 0,
      prefabInstanceCount: instances.size,
      nodeCount: nodes.size,
      scriptCounts: Object.fromEntries(Object.entries(scriptCounts).sort((a, b) => b[1] - a[1])),
      componentCounts: Object.fromEntries(Object.entries(compCounts).sort((a, b) => b[1] - a[1])),
    },
    renderSettings: rsDoc ? rsDoc.data : null,
    lightmapSettings: lmDoc ? { m_GISettings: lmDoc.data.m_GISettings, m_LightmapEditorSettings: lmDoc.data.m_LightmapEditorSettings, m_LightmapsMode: lmDoc.data.m_LightmapsMode, m_UseShadowmask: lmDoc.data.m_UseShadowmask } : null,
    navMeshSettings: nmDoc ? nmDoc.data : null,
    prefabInstances: [...instances.values()].map(i => ({ id: i.id, prefabGuid: i.prefabGuid, prefabPath: i.prefabPath, parentTransformId: i.parentTransformId, modificationCount: i.mods.size })),
    objects,
  };
}

/* ------------------------------------------------------------------ CLI -- */

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
  const has = (flag) => argv.includes(flag);
  const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && ['--out', '--project', '--guid-index', '--filter'].includes(argv[i - 1])));
  if (!files.length) {
    console.error('usage: node unity_scene_to_json.js <scene.unity> [--out f.json] [--project dir] [--guid-index tsv] [--expand-prefabs] [--no-prefab-resolve] [--pretty] [--summary-only] [--filter substr]');
    process.exit(1);
  }
  const scenePath = files[0];
  const DEFAULT_OUT_DIR = path.join(__dirname, 'out');
  const defaultGuidIndex = path.join(REPO_ROOT, 'docs', 'research', '_guid_index.tsv');
  const opts = {
    project: get('--project', findProjectRoot(scenePath)),
    guidIndex: loadGuidIndex(get('--guid-index', defaultGuidIndex)),
    expandPrefabs: has('--expand-prefabs'),
    resolvePrefabs: !has('--no-prefab-resolve'),
  };
  const result = extract(scenePath, opts);

  const filter = get('--filter', null);
  if (filter) {
    const f = filter.toLowerCase();
    result.objects = result.objects.filter(o => (o.name || '').toLowerCase().includes(f) || o.scripts.some(s => (s.name || '').toLowerCase().includes(f)));
    result.meta.filter = filter;
    result.meta.filteredObjectCount = result.objects.length;
  }

  const m = result.meta;
  console.log(`scene: ${m.source}`);
  console.log(`projectRoot: ${m.projectRoot}   prefabsResolved=${m.prefabsResolved} expanded=${m.prefabsExpanded}`);
  console.log(`documents=${m.documentCount} gameObjects=${m.gameObjectCount} prefabInstances=${m.prefabInstanceCount} transformNodes=${m.nodeCount} emitted=${result.objects.length}`);
  console.log('unity classes: ' + Object.entries(m.unityClassCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));
  console.log('scripts:');
  for (const [k, v] of Object.entries(m.scriptCounts)) console.log(`  ${String(v).padStart(4)}  ${k}`);

  if (!has('--summary-only')) {
    fs.mkdirSync(DEFAULT_OUT_DIR, { recursive: true });
    const out = get('--out', path.join(DEFAULT_OUT_DIR, path.basename(scenePath).replace(/\.(unity|prefab)$/i, '') + '.scene.json'));
    fs.writeFileSync(out, JSON.stringify(result, null, has('--pretty') ? 2 : 0));
    console.log(`wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
  }
}

module.exports = { extract, loadGuidIndex, findProjectRoot, compose, mul, decompose, quatToEulerXYZ, CLASS_NAMES };
