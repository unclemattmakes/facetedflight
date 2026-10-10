#!/usr/bin/env node
/**
 * tools/extract/constants.mjs — the generated constants sheet.
 *
 * PORT_PLAN.md D4 / §4.1: "FF2 never hand-types a constant."
 *
 * Reads the READ-ONLY 2016 Unity project and emits, into src/generated/:
 *   constants.generated.ts      the typed sheet the sim/render/HUD import
 *   constants.generated.json    the same model, for the /constants page and CI diffing
 *   constants.generated.sha256  a hash of the JSON, so CI can prove the constants have not drifted
 *
 * THE CARDINAL RULE, encoded:
 *   A Unity serialized `public` field's C# initialiser is NOT shipped behaviour. Every value here is
 *   resolved shipped scene -> Level.ShipPrefab guid -> guid index -> that prefab's component ->
 *   per-scene m_Modifications. Nothing is read from a .cs file except where a YAML key is provably
 *   stale (the field is `private` without [SerializeField]), and those are marked trust:"code-default".
 *
 * THE SECOND TRAP, discovered by this tool (see PREFAB_SELF_MODIFICATION_TRAP below):
 *   A prefab ASSET's own `Prefab` document carries an `m_Modification.m_Modifications` list whose
 *   entries all have `target: {fileID: 0}`. Those are INERT residue, not overrides. Applying them
 *   would give the HoverJet maxSpeed 200 instead of 437.5 and the JumpSeat boost 1.25 instead of
 *   1.65 — i.e. the cardinal-rule failure mode running in reverse.
 *
 * Usage:
 *   node tools/extract/constants.mjs                    write the sheet
 *   node tools/extract/constants.mjs --check            fail (exit 3) if the sheet would change
 *   node tools/extract/constants.mjs --unity <path>     point at a different Unity project copy
 *   node tools/extract/constants.mjs --out <dir>        write somewhere else
 *   node tools/extract/constants.mjs --print <key>      dump one resolved entry and exit
 *
 * Determinism: no timestamps, no absolute paths, no Math.random, sorted keys, fixed float
 * formatting. Same input bytes -> byte-identical output. That is what makes --check meaningful.
 *
 * This tool NEVER writes to the Unity project. It opens every legacy file read-only.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { assertOutsideLegacy, LEGACY_UNSET_MESSAGE, legacyRootOrNull } from '../legacy-root.mjs'
import { buildScenes, classifyScene } from '../unity/build-settings.mjs'
import {
  activeOf,
  chainIsLive,
  chainUp,
  componentIdsOf,
  componentsOfGo,
  goOfComponent,
  nameOfGo,
  transformOfGo,
} from '../unity/graph.mjs'
import { loadGuidIndex } from '../unity/guid-index.mjs'
import { rawColour, rawFloat, shaderGuidOf } from '../unity/material.mjs'
import {
  instancesOf,
  modificationsOf,
  modPath,
  modTarget,
  modTargetOrNull,
  modValue,
  parentGuidOf,
  prefabInstances,
} from '../unity/modifications.mjs'
import { keyLines, readUnityText, scanDocuments, unityYaml } from '../unity/yaml.mjs'
import { readParticleSystem } from './particles.mjs'

// ---------------------------------------------------------------------------------------------
// 0. Paths and CLI
// ---------------------------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')

const DEFAULTS = {
  // `$FF2_LEGACY` (env or .env), or null; `--unity` overrides it. Null is fine for `--check`.
  unity: legacyRootOrNull(),
  out: path.join(REPO, 'src', 'generated'),
  guidIndex: path.join(REPO, 'docs', 'research', '_guid_index.tsv'),
  unityYaml: path.join(REPO, 'tools', 'prototype', 'unity_yaml.js'),
}

function parseArgv(argv) {
  const opt = { ...DEFAULTS, check: false, print: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') opt.check = true
    else if (a === '--unity') opt.unity = argv[++i]
    else if (a === '--out') opt.out = argv[++i]
    else if (a === '--guid-index') opt.guidIndex = argv[++i]
    else if (a === '--print') opt.print = argv[++i]
    else if (a === '--help' || a === '-h') {
      process.stdout.write(HELP)
      process.exit(0)
    } else die(`unknown argument: ${a}`)
  }
  return opt
}

const HELP = `constants.mjs — generate src/generated/constants.generated.{ts,json,sha256}

  --check            do not write; exit 3 if the emitted bytes would differ
  --unity <path>     read-only 2016 Unity project root
  --out <dir>        output directory (default src/generated)
  --guid-index <f>   guid<TAB>Assets/path index
  --print <key>      print one resolved entry as JSON and exit
`

function die(msg) {
  process.stderr.write(`constants.mjs: ${msg}\n`)
  process.exit(2)
}

const OPT = parseArgv(process.argv)
const UNITY = (OPT.unity ?? '').replace(/\\/g, '/').replace(/\/+$/, '')

// Belt and braces: the 2016 project is READ-ONLY. Refuse to run at all if the output directory
// would land inside it. (`pnpm check` also asserts zero files newer than t0 under the Unity source.)
try {
  assertOutsideLegacy(OPT.out, UNITY)
} catch (e) {
  die(e.message)
}

/**
 * CI without the Unity project mounted: verify the committed sha256 instead of re-extracting.
 * PORT_PLAN §4.1 — "when the Unity project is not mounted, it verifies the sha256 instead."
 */
if (!UNITY || !fs.existsSync(UNITY)) {
  if (!OPT.check)
    die(
      UNITY
        ? `Unity project not found at ${UNITY} (pass --unity, or --check to verify the committed sha256)`
        : `${LEGACY_UNSET_MESSAGE} (or pass --unity, or --check to verify the committed sha256)`,
    )
  const jsonPath = path.join(OPT.out, 'constants.generated.json')
  const shaPath = path.join(OPT.out, 'constants.generated.sha256')
  if (!fs.existsSync(jsonPath) || !fs.existsSync(shaPath)) {
    die('no committed constants to verify')
  }
  const actual = createHash('sha256')
    .update(fs.readFileSync(jsonPath, 'utf8'), 'utf8')
    .digest('hex')
  const expected = fs.readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0]
  if (actual !== expected) {
    process.stderr.write(
      `constants.mjs --check: sha256 mismatch.\n  committed ${expected}\n  actual    ${actual}\n`,
    )
    process.exit(3)
  }
  process.stdout.write(
    `constants.mjs --check: Unity project not mounted; committed sha256 ${actual} verified.\n`,
  )
  process.exit(0)
}

/** Read a file from the Unity project, read-only, by Assets-relative path. */
function unityRead(relPath) {
  return readUnityText(path.join(UNITY, relPath))
}
function unityExists(relPath) {
  return fs.existsSync(path.join(UNITY, relPath))
}

// ---------------------------------------------------------------------------------------------
// 1. unity_yaml.js loader
//
// tools/prototype/unity_yaml.js is CommonJS but the repo's package.json declares "type": "module",
// so `require()` and `import` both fail on it. tools/unity/yaml.mjs evaluates it in a CJS wrapper
// (TL-1: the one loader that four tools each used to carry a private copy of).
// ---------------------------------------------------------------------------------------------

const { parseDocuments } = unityYaml(OPT.unityYaml)

// ---------------------------------------------------------------------------------------------
// 2. guid index
// ---------------------------------------------------------------------------------------------

const { guidToPath, pathToGuid } = loadGuidIndex(OPT.guidIndex)

/** Resolve a guid to its Assets-relative path, preferring the index but falling back to .meta scan. */
function resolveGuid(guid) {
  const hit = guidToPath.get(guid)
  if (hit) return hit
  return null
}

// ---------------------------------------------------------------------------------------------
// 3. Asset loading: parsed documents + a fileId/key -> line-number index
// ---------------------------------------------------------------------------------------------

const assetCache = new Map()

/**
 * @returns {{
 *   relPath: string, docs: any[], byId: Map<string, any>,
 *   docLine: Map<string, number>, keyLine: Map<string, number>
 * }}
 */
function loadAsset(relPath) {
  const cached = assetCache.get(relPath)
  if (cached) return cached
  const text = unityRead(relPath)
  const docs = parseDocuments(text)
  const byId = new Map()
  for (const d of docs) byId.set(String(d.fileId), d)

  // Line index: 1-based line of each `--- !u!N &id` header, and of each top-level key inside it.
  // A fileId that appears twice keeps the LAST header's line (Map.set) and the FIRST key line.
  const docLine = new Map()
  const keyLine = new Map()
  const lines = text.split(/\r?\n/)
  for (const b of scanDocuments(lines)) {
    docLine.set(b.fileId, b.start + 1)
    for (const [key, line] of keyLines(lines, b)) {
      const kk = `${b.fileId}\u0000${key}`
      if (!keyLine.has(kk)) keyLine.set(kk, line)
    }
  }
  const entry = { relPath, docs, byId, docLine, keyLine }
  assetCache.set(relPath, entry)
  return entry
}

function lineOf(asset, fileId, key) {
  const l = asset.keyLine.get(`${String(fileId)}\u0000${key}`)
  if (l !== undefined) return l
  return asset.docLine.get(String(fileId)) ?? null
}

// ---------------------------------------------------------------------------------------------
// 4. THE PREFAB-SELF-MODIFICATION TRAP
//
// Unity 5 writes a `Prefab` (classId 1001) document into every prefab ASSET. When
// m_IsPrefabParent == 1 and m_ParentPrefab.fileID == 0, that document describes the asset itself,
// and its m_Modification.m_Modifications list is leftover residue from whatever scene instance the
// prefab was last created/applied from. Every entry has `target: {fileID: 0}` — a dangling
// reference that resolves to no object.
//
// Applying those entries is WRONG, and provably so:
//   PlayerShip_SR14_Photon.prefab residue says maxSpeed 200; the Ship_HoverShip component says
//   437.5, which the audits verified as shipped.
//   JumpSeat_Photon.prefab residue says boostMultiplier 1.25; the Thruster component says 1.65,
//   which the audits verified as shipped.
//
// So: a modification is only applied when its `target` resolves to a real fileID. This function
// returns the residue for reporting, and applyModifications() ignores it.
// ---------------------------------------------------------------------------------------------

function prefabDocument(asset) {
  return asset.docs.find((d) => d.type === 'Prefab') ?? null
}

function inertResidue(asset) {
  const pd = prefabDocument(asset)
  if (!pd) return []
  return modificationsOf(pd)
    .filter((m) => modTarget(m) === '0')
    .map((m) => ({ propertyPath: modPath(m), value: m.value }))
    .sort((a, b) =>
      a.propertyPath < b.propertyPath ? -1 : a.propertyPath > b.propertyPath ? 1 : 0,
    )
}

// ---------------------------------------------------------------------------------------------
// 5. C# source index — declarations and consumers
//
// Two rules from PORT_PLAN §4.1:
//   * refuse to emit a field no first-party script READS  -> UNUSED, reason "no-consumer"
//   * refuse to emit a field declared `private` without [SerializeField]; its YAML key is a stale
//     leftover. Take the C# initialiser instead and mark it trust:"code-default".
// ---------------------------------------------------------------------------------------------

const FIRST_PARTY_CS_ROOTS = [
  'Assets/Faceted Flight/Scripts',
  'Assets/FF_GearVR/Scripts',
  'Assets/Motion Recorder/Scripts',
]

function listCsFiles() {
  const out = []
  const walk = (rel) => {
    const abs = path.join(UNITY, rel)
    if (!fs.existsSync(abs)) return
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = `${rel}/${e.name}`
      if (e.isDirectory()) walk(child)
      else if (e.isFile() && e.name.endsWith('.cs')) out.push(child)
    }
  }
  for (const r of FIRST_PARTY_CS_ROOTS) walk(r)
  // top-level Assets/*.cs (Hotas_UI.cs, VehiclePhysicsSettings.cs, Rig_Joystick.cs, ...)
  for (const e of fs.readdirSync(path.join(UNITY, 'Assets'), { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.cs')) out.push(`Assets/${e.name}`)
  }
  out.sort()
  return out
}

const csFiles = listCsFiles()
const csText = new Map()
for (const f of csFiles) csText.set(f, unityRead(f).replace(/^\uFEFF/, ''))

const ACCESS_RE =
  /^(public|private|protected|internal|static|readonly|const|volatile|new|override|virtual|extern|unsafe|abstract|sealed|partial)$/

/**
 * Parse the class-body field declarations of one .cs file.
 * @returns {Map<string, {name:string, access:string, serializeField:boolean, isStatic:boolean,
 *                        type:string, initializer:string|null, line:number, file:string}>}
 */
function parseCsFields(relPath) {
  const src = csText.get(relPath)
  if (src === undefined) return new Map()
  const lines = src.split(/\r?\n/)
  const fields = new Map()
  let depth = 0
  let classBodyDepth = -1
  let pendingAttrs = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.replace(/\/\/.*$/, '').trim()

    if (/(^|\s)(class|struct|enum|interface)\s+[A-Za-z_]/.test(line) && classBodyDepth < 0) {
      classBodyDepth = depth + 1
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      pendingAttrs.push(line)
      depth += countBraces(line)
      continue
    }

    // A field declaration ends in ';' at class-body depth. Its INITIALISER may contain '(' —
    // `public Vector3 thrustDirection = new Vector3(0, 0, 1);` is a field, not a method — so the
    // paren test has to run on the declaration head only, after the assignment is split off.
    if (depth === classBodyDepth && line.endsWith(';')) {
      const decl = parseFieldDeclaration(line)
      if (decl) {
        fields.set(decl.name, {
          ...decl,
          serializeField: pendingAttrs.some((a) => a.includes('SerializeField')),
          line: i + 1,
          file: relPath,
        })
      }
    }

    if (line !== '') pendingAttrs = []
    depth += countBraces(line)
  }
  return fields
}

function countBraces(line) {
  let n = 0
  let inStr = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'") inStr = c
    else if (c === '{') n++
    else if (c === '}') n--
  }
  return n
}

function parseFieldDeclaration(line) {
  const body = line.slice(0, -1) // drop ';'
  const eq = splitTopLevelAssignment(body)
  const head = eq ? eq.lhs : body
  const initializer = eq ? eq.rhs.trim() : null
  if (head.includes('(') || head.includes(')')) return null // a method signature, not a field
  if (head.includes('=>') || head.includes('{')) return null // an expression-bodied member
  // tokenise the head: modifiers... Type Name
  const toks = head.trim().split(/\s+/)
  if (toks.length < 2) return null
  const mods = []
  while (toks.length && ACCESS_RE.test(toks[0])) mods.push(toks.shift())
  if (toks.length < 2) return null
  const name = toks.pop()
  const type = toks.join(' ')
  if (!/^[A-Za-z_]\w*$/.test(name)) return null
  if (!/^[A-Za-z_]/.test(type)) return null
  const access = mods.includes('public')
    ? 'public'
    : mods.includes('protected')
      ? 'protected'
      : mods.includes('internal')
        ? 'internal'
        : 'private'
  return { name, type, access, isStatic: mods.includes('static'), initializer }
}

function splitTopLevelAssignment(s) {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth--
    else if (
      c === '=' &&
      depth === 0 &&
      s[i + 1] !== '=' &&
      s[i - 1] !== '=' &&
      s[i - 1] !== '!' &&
      s[i - 1] !== '<' &&
      s[i - 1] !== '>'
    ) {
      return { lhs: s.slice(0, i), rhs: s.slice(i + 1) }
    }
  }
  return null
}

/**
 * Find every first-party occurrence of an identifier and classify each as a read or a write.
 * A field with zero reads outside its own declaration is dead (PORT_PLAN §4.1's "trace the field
 * to a consumer" rule — Rotator_Input.yawMax is the canonical example).
 */
const consumerCache = new Map()
function findConsumers(name, declFile, declLine) {
  const key = `${name}\u0000${declFile}\u0000${declLine}`
  const hit = consumerCache.get(key)
  if (hit) return hit
  const word = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`)
  const reads = []
  const writes = []
  for (const f of csFiles) {
    const lines = csText.get(f).split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (f === declFile && i + 1 === declLine) continue
      const raw = lines[i]
      const code = raw.replace(/\/\/.*$/, '')
      if (!word.test(code)) continue
      const isWrite = new RegExp(
        `(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])\\s*(=(?!=)|\\+\\+|--|[+\\-*/|&^]=)`,
      ).test(code)
      const rec = { file: f, line: i + 1, text: code.trim().slice(0, 160) }
      if (isWrite && !new RegExp(`[.\\w]\\s*=[^=]*${escapeRe(name)}`).test(code)) writes.push(rec)
      else reads.push(rec)
    }
  }
  const res = { reads, writes }
  consumerCache.set(key, res)
  return res
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------------------------
// 6. Transform composition — the collider-under-shipOffset problem
//
// The HoverJet's colliders hang under `shipOffset`, so a raw m_LocalPosition is wrong in body
// space. Compose the whole parent chain: worldPos = p + q*(s (*) localPos), q = q*localRot,
// s = s (*) localScale.
// ---------------------------------------------------------------------------------------------

const IDENTITY_TRS = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 1, y: 1, z: 1 },
}

function qMul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

function qRotate(q, v) {
  // t = 2 * (q.xyz X v); v' = v + q.w*t + q.xyz X t
  const tx = 2 * (q.y * v.z - q.z * v.y)
  const ty = 2 * (q.z * v.x - q.x * v.z)
  const tz = 2 * (q.x * v.y - q.y * v.x)
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  }
}

/** Unity's Quaternion.eulerAngles order (ZXY intrinsic), in degrees, for human reading only. */
function qToEulerZXY(q) {
  const sinX = 2 * (q.w * q.x - q.y * q.z)
  const clamped = Math.max(-1, Math.min(1, sinX))
  const x = Math.asin(clamped)
  let y
  let z
  if (Math.abs(clamped) > 0.9999995) {
    y = 2 * Math.atan2(q.y, q.w)
    z = 0
  } else {
    y = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.x * q.x + q.y * q.y))
    z = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.x * q.x + q.z * q.z))
  }
  const deg = (r) => round((r * 180) / Math.PI, 6)
  return { x: deg(x), y: deg(y), z: deg(z) }
}

function vec(o, dflt = 0) {
  return {
    x: num(o?.x, dflt),
    y: num(o?.y, dflt),
    z: num(o?.z, dflt),
  }
}
function quat(o) {
  return { x: num(o?.x, 0), y: num(o?.y, 0), z: num(o?.z, 0), w: num(o?.w, 1) }
}
function num(v, dflt = 0) {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : dflt
}
function round(n, digits) {
  const f = 10 ** digits
  const r = Math.round(n * f) / f
  return Object.is(r, -0) ? 0 : r
}

/** Compose a transform chain from `rootTransform` down to `transform` (exclusive of root's own TRS). */
function composeFromRoot(asset, transformDoc, rootId) {
  const chain = []
  let cur = transformDoc
  let guard = 0
  while (cur && String(cur.fileId) !== String(rootId)) {
    chain.unshift(cur)
    const fatherId = String(cur.data?.m_Father?.fileID ?? '0')
    if (fatherId === '0') break
    cur = asset.byId.get(fatherId)
    if (++guard > 512) die('transform chain cycle')
  }
  let acc = { ...IDENTITY_TRS }
  const names = []
  for (const t of chain) {
    const lp = vec(t.data.m_LocalPosition)
    const lr = quat(t.data.m_LocalRotation)
    const ls = vec(t.data.m_LocalScale, 1)
    const scaled = { x: acc.scale.x * lp.x, y: acc.scale.y * lp.y, z: acc.scale.z * lp.z }
    const rotated = qRotate(acc.rotation, scaled)
    acc = {
      position: {
        x: acc.position.x + rotated.x,
        y: acc.position.y + rotated.y,
        z: acc.position.z + rotated.z,
      },
      rotation: qMul(acc.rotation, lr),
      scale: { x: acc.scale.x * ls.x, y: acc.scale.y * ls.y, z: acc.scale.z * ls.z },
    }
    names.push(gameObjectName(asset, t))
  }
  return { trs: acc, chain: names }
}

function gameObjectName(asset, transformDoc) {
  const go = asset.byId.get(String(transformDoc.data?.m_GameObject?.fileID ?? '0'))
  return go?.data?.m_Name ?? '?'
}

function rootTransformOf(asset) {
  const roots = asset.docs.filter(
    (d) => d.type === 'Transform' && String(d.data?.m_Father?.fileID ?? '0') === '0',
  )
  if (roots.length !== 1) die(`${asset.relPath}: expected 1 root Transform, found ${roots.length}`)
  return roots[0]
}

function* descendants(asset, transformDoc) {
  yield transformDoc
  for (const c of transformDoc.data?.m_Children ?? []) {
    const child = asset.byId.get(String(c.fileID))
    if (child) yield* descendants(asset, child)
  }
}

function componentsOf(asset, transformDoc) {
  return componentsOfGo(asset.byId, goOfComponent(asset.byId, transformDoc))
}

function scriptName(doc) {
  const guid = doc?.data?.m_Script?.guid
  if (!guid) return null
  const p = resolveGuid(guid)
  if (!p) return `guid:${guid}`
  return p.split('/').pop().replace(/\.cs$/, '')
}

/** Find the single component on `transformDoc`'s GameObject whose script resolves to `name`. */
function findScript(asset, transformDoc, name) {
  const hits = componentsOf(asset, transformDoc).filter(
    (d) => d.type === 'MonoBehaviour' && scriptName(d) === name,
  )
  if (hits.length !== 1) return null
  return hits[0]
}

// ---------------------------------------------------------------------------------------------
// 7. The model: entries with provenance
// ---------------------------------------------------------------------------------------------

/**
 * Curated prose for the handful of fields that have bitten someone. Notes only — never values.
 * If a note here contradicts the extracted value, the value wins and the note is the bug.
 */
const FIELD_NOTES = {
  'hoverjet.ship.maxSpeed':
    'A FORCE in newtons, not a speed: AddRelativeForce(thrustDirection * enginePower * boostValue, ForceMode.Force). enginePower is spooled up to maxSpeed over ~0.25 s. a = 437.5/4 = 109.375 m/s^2.',
  'hoverjet.ship.driftMultiplier':
    'PER TICK, not per second. Body-X velocity is deleted directly, between force accumulation and the PhysX integrate. Running it at 60 Hz changes the feel.',
  'hoverjet.ship.liftMultiplier':
    'PER TICK, not per second. Body-Y twin of driftMultiplier. The 4.1:1 X:Z anisotropy these two produce is the single feel metric.',
  'hoverjet.ship.useRollCompensation':
    '0 => CompensateRoll() is unreachable. There is NO auto-level in shipped FF1. DEV-001 keeps it that way deliberately.',
  'hoverjet.ship.limitRoll': '0 => rollLimit (12.5) is never applied.',
  'hoverjet.ship.rollLimit': 'Inert while limitRoll is 0. Kept for the record, not for the sim.',
  'hoverjet.input.invertPitch':
    'NOT a vehicle property. The shipped pitch invert is the GLOBAL InControl setting InputManager.InvertYAxis; this serialized bool is per-instance state. Never bake it into a vehicle config.',
  'hoverjet.input.rollToYawRatio':
    'INERT on the HoverJet: glider_lockRollAndYaw is 0, so the coupling branch never runs. Coupling is a Glider-only feature and the Glider never shipped.',
  'hoverjet.input.glider_lockRollAndYaw':
    '0 on the shipped prefab. The DECOY PlayerShip_SR14_unet.prefab carries the OPPOSITE value and is used only by the two enabled multiplayer scenes. Read the value from THIS prefab.',
  'hoverjet.input.controlScheme':
    'The shipped gamepad scheme letter. PORT_PLAN §2.8 ports scheme "a" first.',
  'hoverjet.rigidbody.useGravity':
    'TRUE on the prefab, and FALSE in flight: LaunchElevator.FinishLaunch() turns gravity off when the launch completes. The prefab value is the pre-launch state, not the flight state.',
  'hoverjet.componentEnabled':
    'Ship_HoverShip ships DISABLED on the prefab; the launch sequence enables it. A disabled component still carries the tuning.',
  'jumpseat.thruster.thrustForce':
    'Applied along body +Y through the accelCurve ease over accelTime seconds (useCurve = 1). a = 750/15 = 50 m/s^2 against gravity 32.',
  'jumpseat.rigidbody.useGravity': 'The JumpSeat flies gravity-bound, unlike the HoverJet.',
  'world.fixedDeltaTime':
    'Serialized as .0121999998 = 81.967 Hz. driftMultiplier and liftMultiplier are per-tick fractions, so this is a load-bearing constant, not a preference.',
  'launch.reveal.triggerLocalY':
    "The trigger BOX CENTRE's Y in Position_adjustment's frame — NOT a rise. The launch clip drives Elevator_animator, which rests at animatedNodeRestY in the same frame, so a rise compared straight against this number fires that much late. render/elevator.ts does exactly that, knowingly: see DEV-094.",
  'launch.reveal.triggerBoxScaleY':
    'The BoxCollider is a 1 m cube with m_Center 0, so the transform scale IS the trigger volume. The reveal must land inside the box, not merely at its centre.',
  'launch.reveal.animatedNodeRestY':
    "Position_adjustment/Elevator's own y. The platform DECK hangs 1.53 m below the animated node, which is why DEV-094 could say 'the platform rests at the frame origin' and be right to 0.21 m.",
  'launch.reveal.liveInFrameCount':
    'The copies this number is actually read from: component m_Enabled == 1, m_IsActive == 1 on every GameObject up to the scene root, and parented under Position_adjustment. The three rigs that fail it are an older generation of the prefab, switched off — and they include int_01_hoverJet, the M1 mission.',
}

/** @type {Map<string, any>} */
const entries = new Map()
const warnings = []
const unused = []

/**
 * trust  — PORT_PLAN §4.1's vocabulary: what we know about the number's truth.
 * origin — the task's vocabulary: where the bytes physically came from.
 */
function put(key, e) {
  if (entries.has(key)) die(`duplicate constant key: ${key}`)
  const curated = FIELD_NOTES[key]
  if (curated) e.note = e.note ? `${curated} — ${e.note}` : curated
  entries.set(key, {
    key,
    value: e.value,
    unit: e.unit ?? null,
    trust: e.trust,
    origin: e.origin,
    source: e.source,
    fileId: e.fileId === undefined ? null : String(e.fileId),
    line: e.line ?? null,
    formula: e.formula ?? null,
    note: e.note ?? null,
    consumers: e.consumers ?? null,
  })
  return e.value
}

function warn(w) {
  warnings.push(w)
}

// ---------------------------------------------------------------------------------------------
// 8. World constants (ProjectSettings)
// ---------------------------------------------------------------------------------------------

function extractWorld() {
  const dyn = loadAsset('ProjectSettings/DynamicsManager.asset')
  const dynDoc = dyn.docs.find((d) => d.type === 'PhysicsManager')
  const tim = loadAsset('ProjectSettings/TimeManager.asset')
  const timDoc = tim.docs.find((d) => d.type === 'TimeManager')
  if (!dynDoc || !timDoc) die('ProjectSettings: PhysicsManager/TimeManager not found')

  const src = (f) => `ProjectSettings/${f}`
  const g = vec(dynDoc.data.m_Gravity)

  const world = {}
  world.gravity = put('world.gravity', {
    value: g,
    unit: 'm/s^2',
    trust: 'verified',
    origin: 'project-settings',
    source: `${src('DynamicsManager.asset')}#${dynDoc.fileId} PhysicsManager.m_Gravity`,
    fileId: dynDoc.fileId,
    line: lineOf(dyn, dynDoc.fileId, 'm_Gravity'),
    note: 'Unity default is -9.81; FF1 runs -32. Every mass/force number below is meaningless without it.',
  })
  world.fixedDeltaTime = put('world.fixedDeltaTime', {
    value: num(timDoc.data['Fixed Timestep']),
    unit: 's',
    trust: 'verified',
    origin: 'project-settings',
    source: `${src('TimeManager.asset')}#${timDoc.fileId} TimeManager."Fixed Timestep"`,
    fileId: timDoc.fileId,
    line: lineOf(tim, timDoc.fileId, 'Fixed Timestep'),
    note: 'Serialised as .0121999998. driftMultiplier/liftMultiplier are PER-TICK fractions, so this is not a free parameter.',
  })
  world.maximumDeltaTime = put('world.maximumDeltaTime', {
    value: num(timDoc.data['Maximum Allowed Timestep']),
    unit: 's',
    trust: 'verified',
    origin: 'project-settings',
    source: `${src('TimeManager.asset')}#${timDoc.fileId} TimeManager."Maximum Allowed Timestep"`,
    fileId: timDoc.fileId,
    line: lineOf(tim, timDoc.fileId, 'Maximum Allowed Timestep'),
    note: 'Only 1.02 fixed steps fit in a frame before Unity gives up — FF1 could never run 2 sim ticks in a frame.',
  })
  world.timeScale = put('world.timeScale', {
    value: num(timDoc.data.m_TimeScale, 1),
    unit: null,
    trust: 'verified',
    origin: 'project-settings',
    source: `${src('TimeManager.asset')}#${timDoc.fileId} TimeManager.m_TimeScale`,
    fileId: timDoc.fileId,
    line: lineOf(tim, timDoc.fileId, 'm_TimeScale'),
  })

  const simple = [
    ['solverIterationCount', 'm_SolverIterationCount', null],
    ['bounceThreshold', 'm_BounceThreshold', 'm/s'],
    ['sleepThreshold', 'm_SleepThreshold', null],
    ['defaultContactOffset', 'm_DefaultContactOffset', 'm'],
    ['queriesHitTriggers', 'm_QueriesHitTriggers', null],
    ['enableAdaptiveForce', 'm_EnableAdaptiveForce', null],
  ]
  for (const [name, ykey, unit] of simple) {
    world[name] = put(`world.${name}`, {
      value: num(dynDoc.data[ykey]),
      unit,
      trust: 'verified',
      origin: 'project-settings',
      source: `${src('DynamicsManager.asset')}#${dynDoc.fileId} PhysicsManager.${ykey}`,
      fileId: dynDoc.fileId,
      line: lineOf(dyn, dynDoc.fileId, ykey),
      note:
        ykey === 'm_QueriesHitTriggers'
          ? "1 => HoverMotor's downward ray hits trigger colliders. Reproduce this or the hover reads through rings."
          : null,
    })
  }
  return world
}

// ---------------------------------------------------------------------------------------------
// 9. Shipped scenes: resolve Level.ShipPrefab, and prove there are no per-scene overrides
// ---------------------------------------------------------------------------------------------

const LEVEL_GUID = pathToGuid.get('Assets/Faceted Flight/Scripts/Level.cs')
const BOUNDARY_GUID = pathToGuid.get('Assets/Faceted Flight/Scripts/PlayerBoundary.cs')
// LoadLevelArt.levelName is the first link in the terrain chain: it names the environment scene
// each shipped mission additively loads (LoadLevelArt.cs:23, SceneManager.LoadSceneAsync).
const LOAD_LEVEL_ART_GUID = pathToGuid.get('Assets/Faceted Flight/Scripts/LoadLevelArt.cs')

function shippedSceneList() {
  let scenes
  try {
    scenes = buildScenes(UNITY)
  } catch (e) {
    die(e.message)
  }
  return scenes.filter((s) => {
    if (s.enabled && !s.present) {
      warn(
        `EditorBuildSettings lists an ENABLED scene that is missing from this backup: ${s.path} (skipped)`,
      )
      return false
    }
    return true
  })
}

// classifyScene (a shipped MISSION scene: enabled in the build list and under Scenes/missions/;
// the multiplayer scenes are enabled too, carry the `_unet` decoy prefab, and are listed
// separately) is tools/unity/build-settings.mjs's, shared with level.mjs (TL-16).

/**
 * Scan a scene for Level + PlayerBoundary without parsing the whole 8-19 MB file: locate the
 * candidate documents by their script guid, then parse only those documents' text.
 */
const sceneScanCache = new Map()
function scanSceneCheap(relPath) {
  const hit = sceneScanCache.get(relPath)
  if (hit) return hit
  const res = scanSceneCheapUncached(relPath)
  sceneScanCache.set(relPath, res)
  return res
}

function scanSceneCheapUncached(relPath) {
  const text = unityRead(relPath)
  const lines = text.split(/\r?\n/)
  const out = {
    path: relPath,
    levels: [],
    boundaries: [],
    levelArts: [],
    shipPrefabInstances: [],
  }

  let docStart = -1
  let docId = null
  let docClass = null
  const flush = (endExclusive) => {
    if (docStart < 0) return
    const body = lines.slice(docStart, endExclusive).join('\n')
    if (docClass === 114) {
      if (LEVEL_GUID && body.includes(LEVEL_GUID)) {
        const parsed = parseDocuments(body)[0]
        if (parsed) out.levels.push({ fileId: docId, line: docStart + 1, data: parsed.data })
      } else if (BOUNDARY_GUID && body.includes(BOUNDARY_GUID)) {
        const parsed = parseDocuments(body)[0]
        if (parsed) out.boundaries.push({ fileId: docId, line: docStart + 1, data: parsed.data })
      } else if (LOAD_LEVEL_ART_GUID && body.includes(LOAD_LEVEL_ART_GUID)) {
        const parsed = parseDocuments(body)[0]
        if (parsed) out.levelArts.push({ fileId: docId, line: docStart + 1, data: parsed.data })
      }
    } else if (docClass === 1001) {
      // A prefab INSTANCE in the scene. Cheap prefilter on the guid text, then confirm that the
      // instance's m_ParentPrefab really is a player-ship prefab — a scene's NetworkManager also
      // *mentions* PlayerShip_SR14_unet's guid (as m_GamePlayerPrefab) without being a ship.
      let mentions = false
      for (const guid of SHIP_PREFAB_GUIDS) {
        if (body.includes(guid)) {
          mentions = true
          break
        }
      }
      if (mentions) {
        const parsed = parseDocuments(body)[0]
        const parentGuid = parsed?.data?.m_ParentPrefab?.guid
        if (parentGuid && SHIP_PREFAB_GUIDS.has(String(parentGuid))) {
          out.shipPrefabInstances.push({
            fileId: docId,
            guid: String(parentGuid),
            line: docStart + 1,
            data: parsed.data,
          })
        }
      }
    }
  }

  for (const b of scanDocuments(lines)) {
    docClass = b.classId
    docId = b.fileId
    docStart = b.start
    flush(b.end)
  }
  return out
}

/**
 * Every player-vehicle prefab in Resources/, by guid — seeded up front so the scene census also
 * catches the decoys (`PlayerShip_SR14_unet.prefab`, `_redux`, `_mini`, `SR14b`, the Glider and the
 * HoverChair) rather than only the two prefabs the missions turn out to use.
 */
const SHIP_PREFAB_GUIDS = new Set()
const SHIP_PREFAB_RE = /^Assets\/Faceted Flight\/Resources\/(PlayerShip_.*|JumpSeat_.*)\.prefab$/
for (const [rel, guid] of pathToGuid) {
  if (SHIP_PREFAB_RE.test(rel)) SHIP_PREFAB_GUIDS.add(guid)
}

/**
 * Modifications a scene may make to a player-ship prefab instance without changing shipped physics.
 * Anything outside this list is a potential per-scene override and fails a structural assertion —
 * which is the cardinal rule, mechanised.
 */
const HARMLESS_MODIFICATION_RE =
  /^(m_IsActive|m_RootOrder|m_Name|m_TagString|m_Layer|m_LocalPosition\.[xyz]|m_LocalRotation\.[xyzw]|m_LocalScale\.[xyz]|instantiationId|viewIdField|m_StaticEditorFlags|m_IsStatic)$/

// ---------------------------------------------------------------------------------------------
// 10. Vehicle extraction
// ---------------------------------------------------------------------------------------------

const RIGIDBODY_FIELDS = [
  ['mass', 'm_Mass', 'kg'],
  ['drag', 'm_Drag', '1/s'],
  ['angularDrag', 'm_AngularDrag', '1/s'],
  ['useGravity', 'm_UseGravity', null],
  ['isKinematic', 'm_IsKinematic', null],
  ['interpolate', 'm_Interpolate', null],
  ['collisionDetection', 'm_CollisionDetection', null],
  ['constraints', 'm_Constraints', null],
]

const INTERPOLATE_NAMES = ['None', 'Interpolate', 'Extrapolate']
const COLLISION_DETECTION_NAMES = [
  'Discrete',
  'Continuous',
  'ContinuousDynamic',
  'ContinuousSpeculative',
]

const HOUSEKEEPING = new Set([
  'm_ObjectHideFlags',
  'm_PrefabParentObject',
  'm_PrefabInternal',
  'm_GameObject',
  'm_Script',
  'm_Name',
  'm_EditorClassIdentifier',
  'm_EditorHideFlags',
  'serializedVersion',
])

function extractRigidbody(prefix, asset, rbDoc, label) {
  const out = {}
  for (const [name, ykey, unit] of RIGIDBODY_FIELDS) {
    const raw = num(rbDoc.data[ykey])
    let value = raw
    if (name === 'useGravity' || name === 'isKinematic') value = raw === 1
    out[name] = put(`${prefix}.rigidbody.${name}`, {
      value,
      unit,
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${asset.relPath}#${rbDoc.fileId} Rigidbody.${ykey}`,
      fileId: rbDoc.fileId,
      line: lineOf(asset, rbDoc.fileId, ykey),
      note:
        name === 'interpolate'
          ? `${raw} = ${INTERPOLATE_NAMES[raw] ?? '?'}`
          : name === 'collisionDetection'
            ? `${raw} = ${COLLISION_DETECTION_NAMES[raw] ?? '?'}`
            : name === 'constraints'
              ? `bitmask; ${raw === 0 ? 'no frozen axes' : 'FROZEN AXES PRESENT'}`
              : name === 'useGravity'
                ? `${label}: this is the value on the prefab. Runtime code may flip it — see world.gravityRuntimeNote.`
                : null,
    })
  }
  out.interpolateName = INTERPOLATE_NAMES[num(rbDoc.data.m_Interpolate)] ?? 'Unknown'
  out.collisionDetectionName =
    COLLISION_DETECTION_NAMES[num(rbDoc.data.m_CollisionDetection)] ?? 'Unknown'
  return out
}

/** Emit every serialized field of one MonoBehaviour, honouring the two §4.1 refusal rules. */
/**
 * Find the single MonoBehaviour of a given script anywhere in an asset.
 *
 * `findScript` only looks at the prefab root, which is right for the ship's own
 * components. `Rotator_Input` is not one of those: it lives on `art_pivot`,
 * four levels down, because it rotates the ART and not the ship. Exactly one
 * exists per vehicle prefab (checked), so a whole-asset search is unambiguous —
 * and the function dies rather than guessing if that stops being true.
 */
function findScriptAnywhere(asset, name) {
  const hits = asset.docs.filter(
    (d) => d.type === 'MonoBehaviour' && (scriptName(d) ?? '') === name,
  )
  if (hits.length === 0) return null
  if (hits.length > 1) {
    die(`${asset.relPath}: ${hits.length} ${name} components; expected exactly one`)
  }
  return hits[0]
}

/**
 * Unity `AnimationCurve` keyframes, as plain numbers.
 *
 * These are not decoration: `Rotator_Input` evaluates `inputCurve` to shape how
 * the art leans into a roll, so the curve IS the feel. Reproducing the field
 * values without the curve gives a lean of the right size with the wrong
 * character.
 */
function animationCurve(raw) {
  const keys = raw?.m_Curve
  if (!Array.isArray(keys)) return null
  return {
    keys: keys.map((k) => ({
      time: num(k.time),
      value: num(k.value),
      inSlope: num(k.inSlope),
      outSlope: num(k.outSlope),
    })),
    preInfinity: num(raw.m_PreInfinity) ?? 0,
    postInfinity: num(raw.m_PostInfinity) ?? 0,
  }
}

function extractBehaviour(prefix, asset, doc, scriptRel) {
  const decls = parseCsFields(scriptRel)
  const out = {}
  const keys = Object.keys(doc.data).filter((k) => !HOUSEKEEPING.has(k))
  keys.sort()

  out.componentEnabled = put(`${prefix}.componentEnabled`, {
    value: num(doc.data.m_Enabled) === 1,
    unit: null,
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${asset.relPath}#${doc.fileId} ${scriptRel.split('/').pop()}.m_Enabled`,
    fileId: doc.fileId,
    line: lineOf(asset, doc.fileId, 'm_Enabled'),
    note: 'A disabled component still ships its values; something enables it at runtime.',
  })

  for (const k of keys) {
    if (k === 'm_Enabled') continue
    const decl = decls.get(k)
    const rawValue = doc.data[k]
    const value = normaliseValue(asset, rawValue)
    const source = `${asset.relPath}#${doc.fileId} ${scriptRel.split('/').pop().replace(/\.cs$/, '')}.${k}`
    const line = lineOf(asset, doc.fileId, k)

    if (!decl) {
      unused.push({
        key: `${prefix}.${k}`,
        value,
        reason: 'stale-yaml-key',
        detail: `no field named ${k} is declared in ${scriptRel}; the YAML key is a leftover from a renamed or deleted field`,
        source,
        line,
      })
      continue
    }

    const consumers = findConsumers(decl.name, decl.file, decl.line)
    const consumedBy = consumers.reads.map((r) => `${r.file}:${r.line}`).sort()

    if (decl.access !== 'public' && !decl.serializeField) {
      // Stale YAML key for a now-private field. Unity keeps writing it; the engine ignores it.
      const codeDefault = literalFromCSharp(decl.initializer)
      if (consumers.reads.length === 0) {
        unused.push({
          key: `${prefix}.${k}`,
          value,
          reason: 'private-and-unread',
          detail: `${scriptRel}:${decl.line} declares \`${decl.access} ${decl.type} ${decl.name}\` without [SerializeField], and nothing reads it`,
          source,
          line,
        })
        continue
      }
      out[k] = put(`${prefix}.${k}`, {
        value: codeDefault === null ? value : codeDefault,
        unit: null,
        trust: 'code-default',
        origin: 'csharp-initializer',
        source: `${scriptRel}:${decl.line}`,
        fileId: doc.fileId,
        line: decl.line,
        note: `The YAML key \`${k}\` on ${asset.relPath}#${doc.fileId} is STALE: the field is \`${decl.access}\` without [SerializeField], so Unity does not deserialise it. Shipped behaviour is the C# initialiser. YAML said ${JSON.stringify(value)}.`,
        consumers: consumedBy,
      })
      continue
    }

    if (consumers.reads.length === 0) {
      unused.push({
        key: `${prefix}.${k}`,
        value,
        reason: 'no-consumer',
        detail: `${scriptRel}:${decl.line} declares \`${decl.access} ${decl.type} ${decl.name}\`; serialised and tuned, but no first-party script reads it`,
        source,
        line,
      })
      continue
    }

    out[k] = put(`${prefix}.${k}`, {
      value,
      unit: null,
      trust: 'verified',
      origin: 'shipped-prefab',
      source,
      fileId: doc.fileId,
      line,
      consumers: consumedBy,
    })
  }
  return out
}

/** Turn a YAML value into something JSON-safe, resolving intra-prefab object references to names. */
function normaliseValue(asset, v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v
  if (Array.isArray(v)) return v.map((x) => normaliseValue(asset, x))
  if (typeof v === 'object') {
    const keys = Object.keys(v)
    if (keys.length >= 1 && keys.includes('fileID') && !keys.includes('x')) {
      const id = String(v.fileID)
      if (id === '0') return { ref: null }
      if (v.guid) {
        return { ref: { guid: String(v.guid), path: resolveGuid(String(v.guid)), fileID: id } }
      }
      const target = asset.byId.get(id)
      const name = target ? refDescription(asset, target) : null
      return { ref: { fileID: id, kind: target?.type ?? null, name } }
    }
    const out = {}
    for (const k of keys.sort()) out[k] = normaliseValue(asset, v[k])
    return out
  }
  return String(v)
}

function refDescription(asset, doc) {
  if (doc.type === 'GameObject') return doc.data?.m_Name ?? null
  const goId = String(doc.data?.m_GameObject?.fileID ?? '0')
  const go = asset.byId.get(goId)
  const n = go?.data?.m_Name ?? null
  const s = doc.type === 'MonoBehaviour' ? scriptName(doc) : doc.type
  return n ? `${n}.${s}` : s
}

function literalFromCSharp(init) {
  if (init === null || init === undefined) return null
  const s = init.trim().replace(/[fFdDmM]$/, '')
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return Number(s)
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^".*"$/.test(s)) return s.slice(1, -1)
  return null
}

// ---------------------------------------------------------------------------------------------
// 11. Colliders with full composed local transforms
// ---------------------------------------------------------------------------------------------

const COLLIDER_TYPES = new Set(['BoxCollider', 'SphereCollider', 'CapsuleCollider', 'MeshCollider'])
const CAPSULE_AXIS = ['x', 'y', 'z']

function extractColliders(prefix, asset, rootTf) {
  const list = []
  for (const tf of descendants(asset, rootTf)) {
    const comps = componentsOf(asset, tf)
    for (const c of comps) {
      if (!COLLIDER_TYPES.has(c.type)) continue
      const { trs, chain } = composeFromRoot(asset, tf, rootTf.fileId)
      const shape = { kind: c.type }
      if (c.type === 'BoxCollider') {
        shape.center = vec(c.data.m_Center)
        shape.size = vec(c.data.m_Size, 1)
      } else if (c.type === 'SphereCollider') {
        shape.center = vec(c.data.m_Center)
        shape.radius = num(c.data.m_Radius)
      } else if (c.type === 'CapsuleCollider') {
        shape.center = vec(c.data.m_Center)
        shape.radius = num(c.data.m_Radius)
        shape.height = num(c.data.m_Height)
        shape.direction = num(c.data.m_Direction, 1)
        shape.directionAxis = CAPSULE_AXIS[num(c.data.m_Direction, 1)] ?? '?'
      } else if (c.type === 'MeshCollider') {
        const mesh = c.data.m_Mesh
        shape.mesh = mesh?.guid ? resolveGuid(String(mesh.guid)) : null
        shape.convex = num(c.data.m_Convex) === 1
      }
      const localTf = {
        position: vec(tf.data.m_LocalPosition),
        rotation: quat(tf.data.m_LocalRotation),
        scale: vec(tf.data.m_LocalScale, 1),
      }
      const centerBody = shape.center
        ? addVec(trs.position, qRotate(trs.rotation, mulVec(trs.scale, shape.center)))
        : null
      const go = asset.byId.get(String(tf.data?.m_GameObject?.fileID ?? '0'))
      const parents = chain.slice(0, -1)
      const selfName = gameObjectName(asset, tf)
      // Classify, because a prefab's collider list is mostly not the vehicle's shape: the HoverJet
      // hangs its five real colliders under `shipOffset/Colliders`, the JumpSeat names its own
      // `collider_body` / `collider_head` / leg capsules directly under `offset`, and both carry a
      // dozen HUD-button boxes and camera-target spheres that must never reach the sim.
      const role = parents.some((p) => /HUD|panel_|Canvas|button|control_parent/i.test(p))
        ? 'ui'
        : parents.includes('Colliders') ||
            /^collider/i.test(selfName) ||
            go?.data?.m_TagString === 'Player'
          ? 'ship-collision'
          : parents.some((p) => /^(Art|art_pivot|art_|glowyBits)/.test(p)) ||
              /Combined|glowyBit|sphere_fancy/.test(selfName)
            ? 'art'
            : 'other'
      list.push({
        role,
        name: go?.data?.m_Name ?? '?',
        gameObjectFileId: String(go?.fileId ?? '0'),
        colliderFileId: String(c.fileId),
        parentChain: chain.slice(0, -1),
        parentPath: chain.slice(0, -1).join('/'),
        enabled: num(c.data.m_Enabled, 1) === 1,
        isTrigger: num(c.data.m_IsTrigger) === 1,
        tag: go?.data?.m_TagString ?? null,
        layer: num(go?.data?.m_Layer),
        shape: roundDeep(shape, 6),
        localTransform: roundDeep(localTf, 6),
        composedFromShipRoot: roundDeep(
          { position: trs.position, rotation: trs.rotation, scale: trs.scale },
          6,
        ),
        composedEulerZXYDeg: qToEulerZXY(trs.rotation),
        centerInShipRootSpace: centerBody ? roundDeep(centerBody, 6) : null,
        effective: roundDeep(effectiveShape(shape, trs.scale), 6),
        line: lineOf(asset, c.fileId, 'm_Center'),
      })
    }
  }
  list.sort((a, b) =>
    `${a.parentPath}/${a.name}/${a.colliderFileId}` <
    `${b.parentPath}/${b.name}/${b.colliderFileId}`
      ? -1
      : 1,
  )
  put(`${prefix}.shipCollisionColliders`, {
    value: list.filter((c) => c.role === 'ship-collision'),
    unit: null,
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${asset.relPath} (colliders under shipOffset/Colliders)`,
    fileId: rootTf.fileId,
    note: 'The subset the sim needs. `colliders` also holds HUD-button and camera-target colliders, which are not the vehicle shape.',
  })
  put(`${prefix}.colliders`, {
    value: list,
    unit: null,
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${asset.relPath} (every Box/Sphere/Capsule/MeshCollider under the prefab root)`,
    fileId: rootTf.fileId,
    line: lineOf(asset, rootTf.fileId, 'm_LocalPosition'),
    note: 'composedFromShipRoot walks the whole parent chain (the collider group hangs under `shipOffset`), so a raw m_LocalPosition would be wrong.',
  })
  return list
}

/**
 * The collider's real size in ship-root space, applying Unity's own scaling semantics: a box scales
 * per axis; a sphere takes the largest absolute scale component; a capsule takes the scale along
 * its direction axis for height and the largest of the other two for radius. Nearly every collider
 * on both prefabs is a unit shape whose entire size lives in the transform scale, so without this
 * the shape fields alone would describe a 1 m cube.
 */
function effectiveShape(shape, scale) {
  const ax = Math.abs(scale.x)
  const ay = Math.abs(scale.y)
  const az = Math.abs(scale.z)
  if (shape.kind === 'BoxCollider') {
    return {
      halfExtents: {
        x: (shape.size.x / 2) * ax,
        y: (shape.size.y / 2) * ay,
        z: (shape.size.z / 2) * az,
      },
    }
  }
  if (shape.kind === 'SphereCollider') {
    return { radius: shape.radius * Math.max(ax, ay, az) }
  }
  if (shape.kind === 'CapsuleCollider') {
    const along = [ax, ay, az][shape.direction] ?? ay
    const perp =
      shape.direction === 0
        ? Math.max(ay, az)
        : shape.direction === 1
          ? Math.max(ax, az)
          : Math.max(ax, ay)
    return { radius: shape.radius * perp, height: shape.height * along }
  }
  return {}
}

function addVec(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}
function mulVec(a, b) {
  return { x: a.x * b.x, y: a.y * b.y, z: a.z * b.z }
}

function roundDeep(o, digits) {
  if (typeof o === 'number') return round(o, digits)
  if (Array.isArray(o)) return o.map((x) => roundDeep(x, digits))
  if (o && typeof o === 'object') {
    const out = {}
    for (const k of Object.keys(o)) out[k] = roundDeep(o[k], digits)
    return out
  }
  return o
}

// ---------------------------------------------------------------------------------------------
// 12. Faceted terrain — the level-art environments
//
// `FacetedTerrain` (Scripts/FacetedTerrain.cs) is the 2016 mesh generator, and its serialized
// fields are the ONLY surviving description of a shipped environment's geometry: the generator
// itself lives inside `#if UNITY_EDITOR` and its output was baked to binary `.asset` chunk files
// that cannot ship, so FF2 has to re-run the generator from these parameters (PORT_PLAN D3).
//
// Three things make this section unlike the vehicles:
//
//  1. The component is NOT on the prefab root. It sits on a child GameObject (`terrain`,
//     `terrain_simonetIslands`, `water`), so findScript() — which only looks at one GameObject's
//     component list — cannot see it. We scan the whole asset for MonoBehaviour documents whose
//     m_Script guid is FacetedTerrain's.
//  2. An environment can carry MORE THAN ONE, and they are not variations on a theme.
//     LevelArt_SimonetIslands.prefab has the 4 km island group AND a separate 32 km ocean plate.
//     Emitting only the first, or merging them, would put 256 m chunks on a 32 km world. Every
//     instance is emitted, under its own key.
//  3. Kauai has no prefab at all — its level art lives directly in
//     Scenes/environments/LevelArt_Kauai.unity. Same trust, different provenance: origin
//     `scene-component`, exactly like PlayerBoundary, and the sheet says so per value.
//
// The resolution chain is the cardinal rule's, one link longer than the vehicles':
//   shipped mission scene -> LoadLevelArt.levelName -> Scenes/environments/<levelName>.unity
//   -> (that scene's LevelArt prefab instance, if it has one) -> the FacetedTerrain components.
// crossCheckEnvironmentScene() walks the last link and proves the scene neither overrides a
// FacetedTerrain field on the prefab instance nor carries a divergent inline copy.
// ---------------------------------------------------------------------------------------------

const FACETED_TERRAIN_CS = 'Assets/Faceted Flight/Scripts/FacetedTerrain.cs'
const FACETED_TERRAIN_GUID = pathToGuid.get(FACETED_TERRAIN_CS) ?? null

const SKYSHOP_SKY_CS = 'Assets/Marmoset/Skyshop/Script/Sky.cs'
const SKYSHOP_SKY_GUID = pathToGuid.get(SKYSHOP_SKY_CS) ?? null

/**
 * Marmoset's SH normalisation constants (`Skyshop/Script/SHEncoding.cs`, `sEquationConstants`).
 *
 * `copyToBuffer()` does `cBuffer[i].x = c[i*3+0] * sEquationConstants[i]`, so the serialised `c`
 * array holds RAW projection weights and `cBuffer` holds them pre-multiplied by the real-SH basis
 * constants. These are exactly the textbook values — Y00, Y1m, Y2m — which is the thing that makes
 * the 2016 numbers portable: they are a standard SH radiance projection, not a Marmoset format.
 */
const MARMOSET_SH_EQUATION_CONSTANTS = [
  0.28209479, 0.4886025, 0.4886025, 0.4886025, 1.09254843, 1.09254843, 0.315391565, 1.09254843,
  0.546274215,
]

/**
 * LoadLevelArt.levelName -> FF2 environment id. NAMES, not values — the same four ids
 * content/levels/*.json already uses (tools/extract/level.mjs, ENV_ID). A shipped mission whose
 * levelName is missing from this table produces a warning rather than an invented id.
 */
const ENVIRONMENT_ID = {
  LevelArt_AlpineForest: 'alpine',
  LevelArt_Desert: 'desert',
  LevelArt_Kauai: 'kauai',
  LevelArt_SimonetIslands: 'simonet',
}

/** emitted name, YAML/C# field, unit — an explicit list, for RIGIDBODY_FIELDS' reasons. */
const TERRAIN_FIELDS = [
  ['terrainSize', 'TerrainSize', 'm'],
  ['terrainHeight', 'TerrainHeight', 'm'],
  ['chunkSize', 'ChunkSize', 'm'],
  ['baseResolution', 'BaseResolution', 'm'],
  ['uv2Padding', 'UV2Padding', 'px'],
  ['randomOffset', 'RandomOffset', 'm'],
  ['uv2MapSize', 'UV2MapSize', 'px'],
  ['lodLevels', 'LODLevels', null],
  ['lodDistance', 'LODDistance', 'm'],
  ['lodTransitionTime', 'LODTransitionTime', 's'],
  ['flipFlopPercent', 'FlipFlopPercent', null],
]

/** Curated prose for the terrain fields, same contract as FIELD_NOTES: notes only, never values. */
const TERRAIN_FIELD_NOTES = {
  terrainHeight:
    'The greyscale height map is multiplied by this: `height = heightRGB.grayscale * TerrainHeight` (FacetedTerrain.cs:591). Not a clamp, not a maximum — a scale.',
  baseResolution:
    'METRES PER QUAD at LOD 0, not a vertex count. `originalQuadPerSide = TerrainSize / BaseResolution` (FacetedTerrain.cs:416). Serialized under the name BaseResolution, but [FormerlySerializedAs("MaxResolution")] and ("QuadSize") — the C# still calls the parameter aMaxResolution.',
  randomOffset:
    "Jitter RADIUS in metres: every grid vertex is displaced by `Random.insideUnitSphere * RandomOffset` (FacetedTerrain.cs:595) before triangulation. FF2 cannot reproduce the displacements — Unity's PRNG is not portable (DEV-006) — so this bounds the disagreement rather than removing it.",
  lodDistance:
    'Distance to the FIRST LOD switch; FacetedTerrain.cs:689 doubles it per level up to LODLevels.',
  flipFlopPercent:
    'Hysteresis band around each LOD switch distance (`* (1 +/- FlipFlopPercent)`), so a chunk sitting exactly on a boundary does not thrash.',
  uv2Padding:
    'Lightmap-atlas gutter, in UV2MapSize pixels. Baked lightmaps did not ship in FF2; kept because it is part of the authored parameter set.',
  uv2MapSize: 'Lightmap atlas size in pixels. Editor-time only, like UV2Padding.',
}

/**
 * Two spellings, so the keys read as English rather than as filenames. See terrainLeafName().
 */
const TERRAIN_LEAF_SPELLING = { islandgroup: 'islands', water: 'ocean' }

/**
 * Name an instance from its SOURCE HEIGHT MAP, not from its GameObject name.
 *
 * The GameObject names carry no usable information across environments — Desert and Alpine both
 * call theirs `terrain`, and both oceans are called `water` — while the height map always says what
 * the thing IS. So:
 *
 *   basename, drop the extension and a trailing `_height`, drop a trailing `_<digits>` authoring
 *   ordinal, lowercase, then apply TERRAIN_LEAF_SPELLING. If what is left is the environment's own
 *   name it carries no information, so that instance is the environment's main terrain: `terrain`.
 *
 *   islandgroup_height.png -> islandgroup -> islands
 *   water_height.png       -> water       -> ocean
 *   canyon_04_height.tga   -> canyon_04   -> canyon
 *   forest_02_height.tga   -> forest_02   -> forest
 *   kauai_height.png       -> kauai       -> == the environment id -> terrain
 */
function terrainLeafName(heightMapPath, envId, fileId) {
  if (!heightMapPath) return `unnamed_${fileId}`
  const stem = heightMapPath
    .split('/')
    .pop()
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/_height$/i, '')
    .replace(/_\d+$/, '')
    .toLowerCase()
  const leaf = TERRAIN_LEAF_SPELLING[stem] ?? stem
  return leaf === envId ? 'terrain' : leaf
}

// Material PROPERTIES (a colour, a float) are read off the raw text by tools/unity/material.mjs,
// which answers for both 2016 dialects. This file used to have a parsed `materialProperty` that
// returned null for every property but the last-written one on an old-dialect material, and null
// is emitted as "the shader's default" (TL-7, DEV-043). A material that never had a property
// assigned simply omits it; that case is null rather than 0, because "not set" and "set to
// black" render very differently.

/**
 * Resolve a FacetedTerrain instance's `TerrainMaterial` to shader path + tint.
 *
 * Returns null when the field is unset — Desert's terrains, for instance, may
 * inherit a material from elsewhere, and inventing a white tint would be worse
 * than admitting the gap.
 */
function extractTerrainMaterial(prefix, inst, src, asset, origin) {
  const ref = inst.data.TerrainMaterial
  const guid = ref?.guid ? String(ref.guid) : null
  const matPath = guid ? resolveGuid(guid) : null
  if (!matPath || !unityExists(matPath)) {
    if (guid) warn(`${prefix}: TerrainMaterial guid ${guid} does not resolve to a file`)
    return null
  }

  const mat = loadAsset(matPath)
  const matDoc = mat.docs.find((d) => d.data?.m_SavedProperties) ?? mat.docs[0]
  const shaderGuid = String(matDoc?.data?.m_Shader?.guid ?? '')
  const shaderPath = shaderGuid ? resolveGuid(shaderGuid) : null
  const matText = unityRead(matPath)
  const matFloat = (name) => rawFloat(matText, name)?.value ?? null
  const matColour = (name) => rawColour(matText, name)?.value ?? null
  const tint = matColour('_Color')

  const out = {
    path: put(`${prefix}.material.path`, {
      value: matPath,
      unit: null,
      trust: 'verified',
      origin,
      source: src('TerrainMaterial'),
      fileId: inst.fileId,
      line: lineOf(asset, inst.fileId, 'TerrainMaterial'),
      note: `guid ${guid}, resolved through the guid index.`,
    }),
    shader: shaderPath,
    // THIRD-PARTY. The shader cannot be ported line for line or shipped; the
    // path is here so the port knows what it is matching against by eye.
    shaderIsThirdParty: Boolean(
      shaderPath && /^Assets\/(Marmoset|VacuumShaders|Standard Assets)\//.test(shaderPath),
    ),
    // The Marmoset shader's own parameters. Matt's material file, so these are
    // his numbers, not the plugin's — and they say the terrain is nearly matte:
    // `_SpecInt` is 0.05, which is within a whisker of the 0.04 dielectric
    // reflectance a metalness workflow uses at metalness 0. The port gets the
    // right specular level almost by construction.
    specular: {
      intensity: matFloat('_SpecInt'),
      shininess: matFloat('_Shininess'),
      fresnel: matFloat('_Fresnel'),
      iblBrightness: matFloat('_IBLBrightness'),
      reflectionAmount: matFloat('_ReflectionAmount'),
      color: (() => {
        const sc = matColour('_SpecColor')
        return sc ? sc.slice(0, 3) : null
      })(),
    },
    // ── the REFLECTION, which only the water has ───────────────────────────
    //
    // `Water.mat`'s keywords include `V_LP_REFLECTIVE_REALTIME`: a mirrored
    // camera rendering the scene into `_ReflectionTex`. FF2 does not pay for
    // that (see DEV-021), but the NUMBERS are what decide how the sea reads, and
    // the important one is `_ReflectionFresnel`. At 1 the reflection goes to
    // full strength at grazing angles, which is the difference between water and
    // a sheet of coloured plastic.
    //
    // `_ReflectionAmount` does NOT exist on this shader and was being read as
    // null — the properties are these. Null on every land material, which is
    // correct: only the water is reflective.
    reflection: (() => {
      const c = matColour('_ReflectColor')
      const fresnel = matFloat('_ReflectionFresnel')
      if (!c && fresnel === null) return null
      return {
        /** rgb is the tint; ALPHA is the reflection's overall strength. */
        color: c ?? null,
        fresnel,
        distortion: matFloat('_ReflectionDistortion'),
        roughness: matFloat('_ReflectionRoughness'),
        strengthOffset: matFloat('_ReflectionStrengthOffset'),
        realtime: /V_LP_REFLECTIVE_REALTIME/.test(String(matDoc?.data?.m_ShaderKeywords ?? '')),
      }
    })(),
    tint: tint
      ? put(`${prefix}.material.tint`, {
          value: tint.slice(0, 3),
          unit: null,
          trust: 'verified',
          origin,
          source: `${matPath} m_SavedProperties.m_Colors._Color`,
          fileId: inst.fileId,
          line: null,
          note: 'Multiplies every facet colour. Read by the generator itself as `_MaterialBaseColor` (FacetedTerrain.cs:154). Linear 0..1, NOT sRGB bytes.',
        })
      : null,
  }
  return out
}

/** Every FacetedTerrain field name, as a per-scene m_Modifications propertyPath would spell it. */
const TERRAIN_MODIFICATION_RE = new RegExp(
  `^\\s*-?\\s*propertyPath:\\s*(${[...TERRAIN_FIELDS.map(([, y]) => y), 'SourceHeightMap', 'SourceColorMap', 'HideChunksInHierarchy'].join('|')})\\b`,
)

/**
 * Find every FacetedTerrain MonoBehaviour in one asset, cheaply.
 *
 * LevelArt_AlpineForest.prefab is 36 MB / 74 009 documents and we want two of them, so this walks
 * the document headers, flags the few documents that matter, and YAML-parses only those. It returns
 * the `{relPath, docLine, keyLine}` shape loadAsset() produces, so lineOf() works on it unchanged —
 * and it never puts a 36 MB document tree into assetCache.
 */
const terrainScanCache = new Map()
/** `VacuumShaders.DirectX11LowPolyShader.LowPoly_Displace` — the wave driver. */
const LOWPOLY_DISPLACE_CS =
  'Assets/VacuumShaders/DirectX 11 Low Poly Shader/Example Scenes/Files/Scripts/LowPoly_Displace.cs'

/**
 * The speed CHAIN, which is the mechanic that makes this a racing game.
 *
 * ── What it is ────────────────────────────────────────────────────────────
 *
 * `TriggerCheckpoint` fires `energySystem.IncreaseSpeed()` on every gate whose
 * `energyBoost` is set — and that is **every shipped gate**. `IncreaseSpeed()`
 * adds `speedIncreaseAmt` to the ship's `maxSpeed` and restarts a cooldown; miss
 * the next gate for `maxCooldownTime` seconds and it all falls back. The comment
 * above it says so in one line:
 *
 *   "each ring increases the ships max speed. ships max speed returns to normal
 *    if they don't go through another ring within a certain amount of time."
 *
 * Terminal speed is `2 x maxSpeed / (mass x drag)` = `maxSpeed / 2.4`, so the
 * chain is worth **182 m/s at the start and 340 by the twenty-first gate**. It
 * is why the boost effects have stages at 120, 240 and 350, and it is why a
 * clean run feels different from a scrappy one.
 *
 * ── Why it has to be read out of the .cs ─────────────────────────────────
 *
 * `speedIncreaseAmt` is `private` with no `[SerializeField]`, so Unity never
 * serialises it and there is no YAML key for the normal walk to promote. It is a
 * genuine `code-default` under CLAUDE.md rule 2 — and reading it here rather
 * than typing 18 into the sim is rule 3.
 *
 * ── The evidence that it SHIPPED ─────────────────────────────────────────
 *
 * `EnergySystem_Ship` is `m_Enabled: 0` on the prefab, which would normally end
 * the argument. The ghosts overrule it. `int_01_leftSpawn_fast_01` spends **52 %
 * of its run above the terminal speed the ship can reach without the chain** —
 * a physically impossible flight — and with the chain applied that falls to 6 %.
 * A disabled MonoBehaviour still runs public methods called from outside, which
 * is exactly how `TriggerCheckpoint` calls this one.
 */
function extractSpeedChain() {
  const rel = 'Assets/Faceted Flight/Scripts/EnergySystem_Ship.cs'
  const fields = parseCsFields(rel)
  const out = {}
  for (const [name, note] of [
    [
      'speedIncreaseAmt',
      'Added to `Ship_HoverShip.maxSpeed` on every gate with `energyBoost`, which is all of them.',
    ],
  ]) {
    const decl = fields.get(name)
    if (!decl) {
      warn(`${rel}: no field \`${name}\`; the speed chain cannot be extracted`)
      continue
    }
    if (decl.serializeField || decl.access !== 'private') {
      warn(
        `${rel}:${decl.line} \`${name}\` is ${decl.access}${decl.serializeField ? ' [SerializeField]' : ''} — it is SERIALISED, so the prefab's value ships and this code-default is wrong`,
      )
    }
    out[name] = put(`hoverjet.speedChain.${name}`, {
      value: literalFromCSharp(decl.initializer),
      unit: null,
      trust: 'code-default',
      origin: 'csharp-initializer',
      source: `${rel}:${decl.line}`,
      fileId: null,
      line: decl.line,
      note: `${note} PRIVATE without [SerializeField], so Unity never serialises it and there is no YAML key to prefer — the initialiser IS the shipped value.`,
    })
  }
  return out
}

/**
 * Every particle system on an asset, with the GameObject it hangs off.
 *
 * Unity serialises a `ParticleSystem` (class 198) and its
 * `ParticleSystemRenderer` (class 199) as separate documents on the same
 * GameObject, so both have to be found and paired.
 *
 * Ordered by GameObject name then fileId: fileIDs are opaque and the YAML order
 * is whatever Unity last wrote, so neither alone is a stable key for a generated
 * file — and several systems share a name.
 */
function scanParticleSystems(relPath) {
  if (!unityExists(relPath)) return []
  const asset = loadAsset(relPath)
  const out = []
  for (const doc of asset.docs) {
    if (doc.classId !== 198) continue
    const goId = String(doc.data?.m_GameObject?.fileID ?? '0')
    const go = asset.byId.get(goId)
    // The renderer is a sibling component on the same GameObject.
    const renderer = componentsOfGo(asset.byId, go).find((c) => c.classId === 199)?.data ?? null
    // ── the liveness walk, for particles ───────────────────────────────
    //
    // The same walk the rings get, for the same reason: a GameObject's own
    // `m_IsActive` says nothing about whether an ancestor switched the whole
    // branch off. `int_02` reports 77 rings instead of 21 without this, and a
    // particle system under a dead parent is 21 gates' worth of spray that the
    // 2016 game never drew.
    const transform = transformOfGo(asset.byId, go) ?? null
    // The ancestors, nearest first, excluding the particle's own GameObject. No depth limit: this
    // walk used to stop after 16 and answer "alive" for whatever lay past it (TL-4).
    const up = transform ? chainUp(asset.byId, transform, { includeSelf: false }) : null
    const ancestors = (up?.nodes ?? []).map((n) => {
      const t = n.transform
      return {
        name: nameOfGo(n.go),
        active: n.active === 1,
        position: [
          num(t.data?.m_LocalPosition?.x),
          num(t.data?.m_LocalPosition?.y),
          num(t.data?.m_LocalPosition?.z),
        ].map((v) => round(v, 6)),
        rotation: [
          num(t.data?.m_LocalRotation?.x),
          num(t.data?.m_LocalRotation?.y),
          num(t.data?.m_LocalRotation?.z),
          num(t.data?.m_LocalRotation?.w, 1),
        ].map((v) => round(v, 6)),
        scale: [
          num(t.data?.m_LocalScale?.x, 1),
          num(t.data?.m_LocalScale?.y, 1),
          num(t.data?.m_LocalScale?.z, 1),
        ].map((v) => round(v, 6)),
      }
    })
    const selfActive = activeOf(go) === 1 && chainIsLive(up?.nodes ?? [])

    const local = transform?.data
    const spec = readParticleSystem(doc.data, renderer, {
      name: String(go?.data?.m_Name ?? ''),
      active: selfActive,
    })
    if (spec) {
      out.push({
        ...spec,
        fileId: doc.fileId,
        selfActive: num(go?.data?.m_IsActive) === 1,
        ancestors,
        // UNITY space, local to the prefab. Where the emitter sits and which way
        // it points — a cone aimed the wrong way is a spray into the gate rather
        // than out of it.
        position: [
          num(local?.m_LocalPosition?.x),
          num(local?.m_LocalPosition?.y),
          num(local?.m_LocalPosition?.z),
        ].map((v) => round(v, 6)),
        rotation: [
          num(local?.m_LocalRotation?.x),
          num(local?.m_LocalRotation?.y),
          num(local?.m_LocalRotation?.z),
          num(local?.m_LocalRotation?.w, 1),
        ].map((v) => round(v, 6)),
        scale: [
          num(local?.m_LocalScale?.x, 1),
          num(local?.m_LocalScale?.y, 1),
          num(local?.m_LocalScale?.z, 1),
        ].map((v) => round(v, 6)),
      })
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.fileId < b.fileId ? -1 : 1))
  return out
}

/**
 * The water's waves.
 *
 * ── Why this is a component and not just a material ───────────────────────
 *
 * `Water.mat` serialises `_DisplaceAmplitude`, `_DisplaceDirection`,
 * `_DisplaceFrequency`, `_DisplaceSpeed` and `_DisplaceNoiseCoef`, and it is
 * tempting to read the wave out of it. But `LowPoly_Displace.Update()` **writes
 * all five of them into the material every frame** from its own public fields.
 * The material's copies are whatever the inspector last left there; the
 * component's are what runs.
 *
 * They agree on Simonet — 322 / 2 / 4 / 0.4 / -1 both places — which is a
 * cross-check rather than a coincidence to lean on. Both are recorded so a
 * future divergence is visible instead of silent.
 *
 * ── And the component is load-bearing for a second reason ─────────────────
 *
 * It is the only thing that sets `_V_LP_Time`, and the material has
 * `_DisplaceScriptSynchronize: 1`, which makes the shader use `_V_LP_Time`
 * INSTEAD of Unity's own `_Time.x`. No component, no time, and the water is a
 * frozen wave. So its liveness is not a detail: it is the difference between an
 * ocean that moves and one that does not.
 *
 * ── The field that is NOT used ────────────────────────────────────────────
 *
 * `_DisplaceStrength: 2.31` looks like the obvious amplitude knob and it is
 * dead here. `Core.cginc` only multiplies by it in the `V_LP_DISPLACE_TEXTURE`
 * branch; this material is `V_LP_DISPLACE_PARAMETRIC`, which never reads it.
 * Recorded with that verdict so nobody re-derives it as a scale factor.
 *
 * ── The bob ───────────────────────────────────────────────────────────────
 *
 * `Update()` also moves the TRANSFORM by the same wave evaluated at the
 * object's own origin, lerped in over the first second. The script is meant for
 * an object floating ON the water; here it is attached TO the water, so the
 * whole 262 km plate rises and falls by up to `amplitude` metres while its
 * vertices wave independently. That is what shipped.
 */
function scanWaterDisplace(relPath) {
  const guid = pathToGuid.get(LOWPOLY_DISPLACE_CS) ?? null
  if (!guid) {
    warn(`${LOWPOLY_DISPLACE_CS}: not in the guid index; water waves cannot be extracted`)
    return null
  }
  if (!unityExists(relPath)) return null
  const asset = loadAsset(relPath)

  const out = []
  for (const doc of asset.docs) {
    if (doc.classId !== 114) continue
    if (String(doc.data?.m_Script?.guid ?? '') !== guid) continue
    const go = asset.byId.get(String(doc.data?.m_GameObject?.fileID ?? '0'))

    // The liveness walk, the same one the rings get: the component enabled, the
    // GameObject active, and every ancestor active. A disabled driver is a
    // frozen ocean, so this is checked rather than assumed.
    const transform = transformOfGo(asset.byId, go) ?? null
    // No depth limit: this walk used to stop after 16 nodes and leave `alive` true for whatever
    // lay past it (TL-4).
    const up = transform ? chainUp(asset.byId, transform) : null
    const chain = (up?.nodes ?? []).map((n) => ({
      name: nameOfGo(n.go),
      active: n.active === 1,
    }))
    const alive =
      num(doc.data?.m_Enabled) === 1 && activeOf(go) === 1 && chainIsLive(up?.nodes ?? [])

    out.push({
      fileId: doc.fileId,
      gameObject: String(go?.data?.m_Name ?? ''),
      componentEnabled: num(doc.data?.m_Enabled) === 1,
      live: alive,
      ancestors: chain,
      targetMaterial: doc.data?.targetMaterial?.guid
        ? resolveGuid(String(doc.data.targetMaterial.guid))
        : null,
      /** The values that actually run. Written into the material every frame. */
      direction: num(doc.data?.direction),
      speed: num(doc.data?.speed),
      amplitude: num(doc.data?.amplitude),
      frequency: num(doc.data?.frequency),
      noise: num(doc.data?.noise),
    })
  }
  return out
}

function scanFacetedTerrain(relPath) {
  const hit = terrainScanCache.get(relPath)
  if (hit) return hit
  if (!FACETED_TERRAIN_GUID) die(`${FACETED_TERRAIN_CS}: not in the guid index`)

  const lines = unityRead(relPath).split(/\r?\n/)
  const scan = {
    relPath,
    // Same shape loadAsset() returns, so lineOf()/normaliseValue() work on it unchanged. `byId` is
    // deliberately empty: nothing here holds an intra-asset reference we need to name.
    byId: new Map(),
    docLine: new Map(),
    keyLine: new Map(),
    instances: [],
    modifyingPrefabInstances: [],
    // Every prefab this asset instantiates, by guid — so "the scene loads THIS level-art prefab"
    // is a fact read off the scene rather than an inference from the file name matching.
    parentPrefabGuids: new Set(),
    documentCount: 0,
  }

  // Pass 1: document boundaries, plus the two flags that decide what is worth parsing.
  const bounds = scanDocuments(lines)
  for (const cur of bounds) {
    cur.terrain = false
    for (let i = cur.start + 1; i < cur.end; i++) {
      const line = lines[i]
      if (cur.classId === 114) {
        if (!cur.terrain && line.includes(FACETED_TERRAIN_GUID)) cur.terrain = true
      } else if (cur.classId === 1001) {
        if (!cur.terrain && line.includes('propertyPath:') && TERRAIN_MODIFICATION_RE.test(line)) {
          cur.terrain = true
        } else if (line.startsWith('  m_ParentPrefab:')) {
          // Unity wraps a long flow mapping onto a continuation line, so the guid may be on the next.
          const g =
            /guid:\s*([0-9a-f]{32})/.exec(line) ?? /guid:\s*([0-9a-f]{32})/.exec(lines[i + 1] ?? '')
          if (g) scan.parentPrefabGuids.add(g[1])
        }
      }
    }
  }
  scan.documentCount = bounds.length

  const byId = new Map(bounds.map((b) => [b.fileId, b]))
  const parseOne = (b) => parseDocuments(lines.slice(b.start, b.end).join('\n'))[0] ?? null

  // Pass 2: parse the flagged documents only.
  for (const b of bounds) {
    if (!b.terrain) continue
    const doc = parseOne(b)
    if (!doc) continue
    if (b.classId === 1001) {
      const mods = modificationsOf(doc).filter((mod) =>
        TERRAIN_MODIFICATION_RE.test(`propertyPath: ${modPath(mod)}`),
      )
      if (mods.length === 0) continue
      scan.modifyingPrefabInstances.push({
        fileId: b.fileId,
        line: b.start + 1,
        parentPrefab: resolveGuid(String(doc.data?.m_ParentPrefab?.guid ?? '')),
        modifications: mods
          .map((mod) => ({
            propertyPath: modPath(mod),
            value: modValue(mod.value),
            targetFileId: modTargetOrNull(mod),
          }))
          .sort((x, y) => (x.propertyPath < y.propertyPath ? -1 : 1)),
      })
      continue
    }
    if (String(doc.data?.m_Script?.guid ?? '') !== FACETED_TERRAIN_GUID) continue

    scan.docLine.set(b.fileId, b.start + 1)
    for (const [key, line] of keyLines(lines, b)) {
      const kk = `${b.fileId}\u0000${key}`
      if (!scan.keyLine.has(kk)) scan.keyLine.set(kk, line)
    }
    const goBounds = byId.get(String(doc.data?.m_GameObject?.fileID ?? '0'))
    const go = goBounds ? parseOne(goBounds) : null

    // The GameObject's Transform, because a FacetedTerrain's mesh vertices run
    // 0..TerrainSize in MESH space and the component's own transform is what
    // puts that anywhere in the world. Every chunk is parented at
    // `localPosition = Vector3.zero` (FacetedTerrain.cs:611, :714), so this
    // transform is the ONLY thing between mesh space and world space.
    //
    // It is never zero in practice and one of them is not even unit scale:
    // Simonet's islands sit at (-109.92, -81.69, 180.86) — the y is why sea
    // level is 82 m below the mesh's own zero — and its ocean plate is at
    // (-14949, -46.08, -13692) with **scale (8, 1, 8)**, i.e. a 32 km terrain
    // stretched to 262 km so it runs past the horizon in every direction.
    let transform = null
    for (const id of componentIdsOf(go)) {
      const cb = byId.get(id)
      if (cb?.classId !== 4) continue
      const cd = parseOne(cb)?.data
      if (!cd) continue
      transform = {
        fileId: cb.fileId,
        position: cd.m_LocalPosition ?? null,
        rotation: cd.m_LocalRotation ?? null,
        scale: cd.m_LocalScale ?? null,
        father: cd.m_Father?.fileID ? String(cd.m_Father.fileID) : null,
      }
    }

    // ── Everything ABOVE this terrain, inside this file ────────────────────
    //
    // `transform` above is LOCAL, and for a terrain that is not enough. The note
    // on `transform.position` used to claim the environment scene "instantiates
    // at the origin with no overrides (checked)" — true for alpine, desert and
    // simonet, and FALSE for kauai, whose `LevelArt_Kauai` is an unpacked copy
    // sitting at (-2218, 0, -1691). It was checked where the wrong answer and
    // the right one agree, which is how this project also shipped a wrong
    // centre/corner rule for a day.
    //
    // So: walk the father chain and sum it. It stops at `levelOffset`, because
    // that node is what the LEVEL JSON's `worldOffset` already carries and
    // adding it here would count it twice. For a terrain found inside a prefab
    // (simonet, desert) the chain simply ends at the prefab root and the sum is
    // zero, which is the right answer for them.
    //
    // ── Why the chain's ROTATION and SCALE are read, not just its position ──
    //
    // A sum of local positions is the world offset of a chain only when every
    // node in it is unrotated and unit-scaled. That is true of all five shipped
    // environments — verified below, per node, and asserted in
    // `tests/unit/terrain-env-root.test.ts` — but it was an ASSUMPTION for as
    // long as `envRoot` existed, and an assumption that reads as absence: a
    // rotated parent would produce a `envRoot` that is silently, quietly wrong
    // and no number in the sheet would say so. It is not a hypothetical either.
    // `AlpineTerrain_menu`'s own prefab ROOT is rotated (world quaternion
    // {0.0085, 0.8652, 0.0576, -0.4980}), and `main_menu.unity` hangs that
    // prefab under two more rotated parents at yaw -86.92 (DEV-042). The root
    // is deliberately not counted, so the menu terrain is unaffected — but the
    // rotated node is one level away from a chain this walk WOULD count.
    //
    // So the walk records each ancestor's full TRS and `envRootRigid` says
    // whether `envRoot + local` is exact. If a future environment lands with a
    // rotated intermediate node, a three-vector cannot express its placement,
    // and the extractor says so instead of adding numbers that do not compose.
    // (The agreement lesson: a rule tested only where two explanations agree
    // has not been tested. Here the two explanations — "sum the positions" and
    // "compose the matrices" — agree on every case that exists today.)
    const ancestors = []
    let ancestorOffset = { x: 0, y: 0, z: 0 }
    let ancestorRigid = true
    let stoppedAt = null
    {
      let fatherId = transform?.father ?? null
      let guard = 0
      while (fatherId && guard++ < 64) {
        const fb = byId.get(fatherId)
        if (fb?.classId !== 4) break
        const fd = parseOne(fb)?.data
        if (!fd) break
        const fgo = byId.get(String(fd.m_GameObject?.fileID ?? '0'))
        const fname = (fgo ? parseOne(fgo)?.data?.m_Name : null) ?? null
        if (fname === 'levelOffset') {
          stoppedAt = fname
          break
        }
        const fatherOfFather = fd.m_Father?.fileID ? String(fd.m_Father.fileID) : null
        // A node with NO father is a ROOT, and a root's placement is the level
        // offset itself — which the level JSON's `worldOffset` already carries.
        // Counting it would double it. This is the difference between desert,
        // whose `LevelArt_Desert` IS the root at (-2048, 0, -2048), and kauai,
        // whose `LevelArt_Kauai` sits BELOW `levelOffset` at (-2218, 0, -1691)
        // and is a genuine extra displacement. Getting this wrong in either
        // direction misplaces a whole island by kilometres.
        if (!fatherOfFather) {
          stoppedAt = `${fname ?? '?'} (root, not counted)`
          break
        }
        const lp = fd.m_LocalPosition ?? {}
        const lr = fd.m_LocalRotation ?? {}
        const ls = fd.m_LocalScale ?? {}
        const quat = [
          Number(lr.x) || 0,
          Number(lr.y) || 0,
          Number(lr.z) || 0,
          lr.w === undefined ? 1 : Number(lr.w) || 0,
        ]
        const scale = [
          ls.x === undefined ? 1 : Number(ls.x) || 0,
          ls.y === undefined ? 1 : Number(ls.y) || 0,
          ls.z === undefined ? 1 : Number(ls.z) || 0,
        ]
        // Unity serialises a quaternion to seven significant figures, so the
        // identity can arrive as w = 0.99999994. 1e-6 is two orders of
        // magnitude below the smallest rotation that would move a 4 km terrain
        // by a metre, and well above that noise.
        const rigidHere =
          Math.abs(quat[0]) < 1e-6 &&
          Math.abs(quat[1]) < 1e-6 &&
          Math.abs(quat[2]) < 1e-6 &&
          Math.abs(Math.abs(quat[3]) - 1) < 1e-6 &&
          scale.every((s) => Math.abs(s - 1) < 1e-6)
        if (!rigidHere) ancestorRigid = false
        ancestorOffset = {
          x: ancestorOffset.x + (Number(lp.x) || 0),
          y: ancestorOffset.y + (Number(lp.y) || 0),
          z: ancestorOffset.z + (Number(lp.z) || 0),
        }
        ancestors.push({
          name: fname,
          fileId: fb.fileId,
          localPosition: [Number(lp.x) || 0, Number(lp.y) || 0, Number(lp.z) || 0],
          localRotation: quat,
          localScale: scale,
          rigid: rigidHere,
        })
        fatherId = fatherOfFather
      }
    }

    scan.instances.push({
      fileId: b.fileId,
      line: b.start + 1,
      data: doc.data,
      gameObject: go?.data?.m_Name ?? null,
      transform,
      ancestorOffset,
      ancestorRigid,
      ancestors,
      ancestorStop: stoppedAt,
    })
  }

  // fileIDs are opaque; sort them as strings so the order is stable rather than authored.
  scan.instances.sort((a, b2) => (a.fileId < b2.fileId ? -1 : a.fileId > b2.fileId ? 1 : 0))
  scan.modifyingPrefabInstances.sort((a, b2) => (a.fileId < b2.fileId ? -1 : 1))
  terrainScanCache.set(relPath, scan)
  return scan
}

/**
 * Find the Marmoset Skyshop `Sky` component in a level-art prefab or environment scene.
 *
 * ── Why this matters more than it looks ───────────────────────────────────────────────────
 *
 * The terrain material is `Assets/Marmoset/Shader/VertexColor/Marmoset Specular IBL.shader`,
 * which defines MARMO_DIFFUSE_IBL and MARMO_SPECULAR_IBL and takes NO light from Unity's ambient
 * at all. Its diffuse ambient is `SHLookup(skyRotate(_SkyMatrix, N))` — nine RGB spherical-harmonic
 * coefficients pushed as shader globals by this one component (`Sky.cs:331`). Miss it and the whole
 * world is lit by the sun alone, which is the difference between the 2016 screenshots and a scene
 * where every surface facing away from the sun is black.
 *
 * The coefficients are BAKED and serialised, so they survive without the cubemaps that produced
 * them — a measurement of the sky rather than the sky itself. That distinction is what makes them
 * shippable when `castle_SPEC.cubemap` is not.
 *
 * Same streaming trick as `scanFacetedTerrain`: walk document headers, parse only what matters.
 */
const skyScanCache = new Map()

/** `lineOf` for a sky scan. Its own separator, so it does not depend on `lineOf`'s internals. */
function skyLine(scan, fileId, key) {
  return scan.keyLine.get(`${String(fileId)}#${key}`) ?? scan.docLine.get(String(fileId)) ?? null
}

function scanSkyshopSky(relPath) {
  const hit = skyScanCache.get(relPath)
  if (hit) return hit
  if (!SKYSHOP_SKY_GUID) die(`${SKYSHOP_SKY_CS}: not in the guid index`)

  const lines = unityRead(relPath).split(/\r?\n/)
  const scan = { relPath, byId: new Map(), docLine: new Map(), keyLine: new Map(), instances: [] }

  const bounds = scanDocuments(lines)
  for (const cur of bounds) {
    cur.sky = false
    if (cur.classId !== 114) continue
    for (let i = cur.start + 1; i < cur.end && !cur.sky; i++) {
      if (lines[i].includes(SKYSHOP_SKY_GUID)) cur.sky = true
    }
  }

  const byId = new Map(bounds.map((b) => [b.fileId, b]))
  const parseOne = (b) =>
    b ? (parseDocuments(lines.slice(b.start, b.end).join('\n'))[0] ?? null) : null

  for (const b of bounds) {
    if (!b.sky) continue
    const doc = parseOne(b)
    if (!doc || String(doc.data?.m_Script?.guid ?? '') !== SKYSHOP_SKY_GUID) continue

    scan.docLine.set(b.fileId, b.start + 1)
    for (const [key, line] of keyLines(lines, b)) {
      const kk = `${b.fileId}#${key}`
      if (!scan.keyLine.has(kk)) scan.keyLine.set(kk, line)
    }

    const go = parseOne(byId.get(String(doc.data?.m_GameObject?.fileID ?? '0')))
    // The transform, because `Sky.UpdateSkyTransform()` builds `_SkyMatrix` from it and
    // `skyRotate()` multiplies by its TRANSPOSE — so a rotated sky object rotates the IBL
    // lookup, and `ibl_sky` IS rotated (139 degrees of yaw on Simonet).
    let transform = null
    for (const id of componentIdsOf(go)) {
      const cb = byId.get(id)
      if (cb?.classId !== 4) continue
      const cd = parseOne(cb)?.data
      if (cd) {
        transform = {
          fileId: cb.fileId,
          rotation: cd.m_LocalRotation ?? null,
          father: cd.m_Father?.fileID ? String(cd.m_Father.fileID) : null,
        }
      }
    }

    // The liveness walk, same rule as the rings: a component on an object whose parent chain is
    // inactive ships nothing. Also collects the ancestors' rotations, since a rotated parent would
    // compose into the sky matrix the same way.
    const lazy = { get: (id) => parseOne(byId.get(id)) }
    const tfDoc = transform ? lazy.get(transform.fileId) : null
    const up = tfDoc ? chainUp(lazy, tfDoc, { includeSelf: false }) : null
    const ancestors = (up?.nodes ?? []).map((n) => {
      const rot = n.transform.data?.m_LocalRotation ?? null
      return {
        name: n.go?.data?.m_Name ?? null,
        active: n.active === 1,
        rotation: rot ? [num(rot.x), num(rot.y), num(rot.z), num(rot.w)] : null,
      }
    })
    const live = activeOf(go) === 1 && chainIsLive(up?.nodes ?? [])

    scan.instances.push({
      fileId: b.fileId,
      line: b.start + 1,
      data: doc.data,
      gameObject: go?.data?.m_Name ?? null,
      gameObjectActive: num(go?.data?.m_IsActive) === 1,
      activeInHierarchy: live,
      ancestors,
      transform,
    })
  }

  scan.instances.sort((a, b2) => (a.fileId < b2.fileId ? -1 : a.fileId > b2.fileId ? 1 : 0))
  skyScanCache.set(relPath, scan)
  return scan
}

/**
 * Count `m_Modifications` in the shipped load path that target this Sky, its GameObject or its
 * transform.
 *
 * A prefab value is a hypothesis until the scenes that instantiate it are checked (CLAUDE.md rule
 * 2, broken four times). This is that check, expressed as a number the sheet carries.
 */
function skyOverrideReceipt(targetFileIds, sceneRels) {
  const targets = new Set(targetFileIds.filter(Boolean).map(String))
  const byScene = new Map()
  const details = []
  let checked = 0
  for (const rel of sceneRels) {
    if (!unityExists(rel)) continue
    checked++
    // Cheap pre-filter: if no target fileID appears anywhere in the text there is nothing to parse.
    const text = unityRead(rel)
    if (![...targets].some((t) => text.includes(t))) continue
    for (const doc of parseDocuments(text)) {
      if (doc.classId !== 1001) continue
      for (const mod of modificationsOf(doc)) {
        if (!targets.has(String(mod?.target?.fileID ?? ''))) continue
        const path = modPath(mod)
        const value = mod.value
        if (!byScene.has(rel)) byScene.set(rel, [])
        byScene.get(rel).push({ propertyPath: path, value })
        details.push(
          `${rel}: ${path} = ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
        )
      }
    }
  }
  return {
    scenesChecked: checked,
    modifications: details.length,
    details: details.sort(),
    byScene: Object.fromEntries(
      [...byScene].map(([k, v]) => [
        k,
        v.slice().sort((a, b) => (a.propertyPath < b.propertyPath ? -1 : 1)),
      ]),
    ),
  }
}

/**
 * `Sky.ComputeExposureVector` (Sky.cs:580-591), reimplemented exactly.
 *
 *   x = master * diff        the DIFFUSE ambient multiplier (SHLookup is scaled by this)
 *   y = master * spec        the SPECULAR cubemap multiplier
 *   z = master * sky * expo  the visible skybox multiplier
 *   w = camExposure          folded into Albedo, so it multiplies everything
 *
 * The `ldr2hdr` divisor is the RGBM expansion constant an LDR cubemap would need if it were being
 * treated as HDR. Simonet sets `hdrSky`/`hdrSpec` to 1, so nothing is divided — which is the
 * interesting part, because the cubemaps behind them are ARGB32.
 */
function skyshopExposure(d) {
  const master = num(d.masterIntensity, 1)
  const camExpo = num(d.camExposure, 1)
  const linear = num(d.linearSpace) === 1
  const ldr2hdr = linear ? 6 ** 2.2 : 6
  let y = master * num(d.specIntensity, 1)
  let z = master * num(d.skyIntensity, 1) * camExpo
  if (num(d.hdrSpec) !== 1) y /= ldr2hdr
  if (num(d.hdrSky) !== 1) z /= ldr2hdr
  return {
    diffuse: master * num(d.diffIntensity, 1),
    specular: y,
    sky: z,
    camera: camExpo,
    ldr2hdr,
  }
}

/**
 * The Skyshop IBL for one environment: the nine SH coefficients that ARE its ambient light.
 *
 * Everything here is read off `ibl_sky`'s `Sky` component. The two cubemap paths are recorded as
 * EVIDENCE — they are Marmoset Asset Store demo assets and never enter the build (CLAUDE.md rule
 * 7) — but the SH is a measurement of the sky, not the sky, and that is what ships.
 */
function extractIbl(env, prefabRel, sceneRel, missionScenes, preferRel) {
  // Look in the same file the terrain came from FIRST. Alpine's scene carries its own copy of the
  // level art AND there is a stale prefab beside it holding a different sky; picking by search
  // order rather than by what the game loads would take the stale one.
  const ordered = [preferRel, sceneRel, prefabRel].filter(
    (r, i, a) => r && unityExists(r) && a.indexOf(r) === i,
  )
  let scan = null
  let sourceRel = null
  const alsoIn = []
  for (const rel of ordered) {
    const s = scanSkyshopSky(rel)
    if (s.instances.length === 0) continue
    if (scan) {
      alsoIn.push(rel)
      continue
    }
    scan = s
    sourceRel = rel
  }
  if (!scan) return null

  const live = scan.instances.filter((i) => i.activeInHierarchy && num(i.data.m_Enabled) === 1)
  if (live.length === 0) {
    warn(
      `${env.environment}: ${sourceRel} has a Skyshop Sky but none is live — its IBL ships nothing`,
    )
    return null
  }
  if (live.length > 1) {
    warn(
      `${env.environment}: ${live.length} live Skyshop Sky components in ${sourceRel}; using the first`,
    )
  }
  const inst = live[0]
  const prefix = `terrain.${env.environment}.ibl`
  const src = (field) => `${sourceRel}#${inst.fileId} Sky.${field}`
  const origin = sourceRel === sceneRel ? 'scene-component' : 'shipped-prefab'
  const at = (field) => skyLine(scan, inst.fileId, field)

  // ── Apply the scene's m_Modifications (CLAUDE.md rule 2) ────────────────────────────────────
  //
  // A prefab value is a hypothesis until the scenes that instantiate it have been checked, and
  // this one caught a live case: `LevelArt_Desert.unity` overrides FOUR of the Sky's intensities,
  // so Desert's shipped ambient is not the number on its prefab at all.
  const overrides = skyOverrideReceipt(
    [inst.fileId, inst.transform?.fileId, String(inst.data.m_GameObject?.fileID ?? '')],
    [sceneRel, ...missionScenes],
  )
  const d = { ...inst.data }
  const applied = []
  for (const [rel, mods] of Object.entries(overrides.byScene)) {
    // The environment scene is loaded by every mission that uses it, so its overrides are the
    // environment's. A MISSION scene overriding the sky would make lighting per-mission, which the
    // level JSON has no room for — say so loudly rather than silently taking the last one.
    if (rel !== sceneRel) {
      warn(
        `${env.environment}: ${rel} (a mission scene, not the environment scene) modifies the Skyshop Sky — IBL would have to become per-mission: ${mods.map((m) => m.propertyPath).join(', ')}`,
      )
      continue
    }
    for (const m of mods) {
      if (!(m.propertyPath in d)) {
        warn(`${rel}: modifies Sky.${m.propertyPath}, which is not a field we read`)
        continue
      }
      applied.push(`${m.propertyPath}: ${d[m.propertyPath]} -> ${m.value}`)
      d[m.propertyPath] = m.value
    }
  }
  overrides.applied = applied.sort()
  overrides.appliedFrom = applied.length ? sceneRel : null
  if (alsoIn.length) {
    overrides.alsoPresentIn = alsoIn
  }

  const sh = (d.SH?.c ?? []).map((v) => num(v))
  if (sh.length !== 27) {
    warn(`${sourceRel}#${inst.fileId}: Sky.SH.c has ${sh.length} floats, expected 27`)
  }
  const buffer = (d.SH?.cBuffer ?? []).map((v) => [num(v.x), num(v.y), num(v.z)])

  // Marmoset pre-multiplies `c` by the real-SH basis constants when it uploads. That identity is
  // the receipt that these ARE textbook SH coefficients rather than something Marmoset invented —
  // check it here rather than assume it, because the whole port of the lighting rests on it.
  let bufferMaxError = null
  if (sh.length === 27 && buffer.length === 9) {
    bufferMaxError = 0
    for (let i = 0; i < 9; i++) {
      for (let k = 0; k < 3; k++) {
        const want = sh[i * 3 + k] * MARMOSET_SH_EQUATION_CONSTANTS[i]
        bufferMaxError = Math.max(bufferMaxError, Math.abs(want - buffer[i][k]))
      }
    }
    if (bufferMaxError > 1e-6) {
      warn(
        `${sourceRel}#${inst.fileId}: Sky.SH.cBuffer disagrees with c * sEquationConstants by ${bufferMaxError} — the SH convention is not what we think it is`,
      )
    }
  }

  const rot = inst.transform?.rotation
  const q = rot ? [num(rot.x), num(rot.y), num(rot.z), num(rot.w)] : [0, 0, 0, 1]
  const yawDeg = (2 * Math.acos(Math.min(1, Math.max(-1, q[3]))) * 180) / Math.PI

  const ibl = {
    gameObject: inst.gameObject,
    source: sourceRel,
    fileId: inst.fileId,
    line: inst.line,
  }

  ibl.enabled = put(`${prefix}.enabled`, {
    value: num(d.m_Enabled) === 1 && inst.activeInHierarchy,
    unit: null,
    trust: 'verified',
    origin,
    source: src('m_Enabled'),
    fileId: inst.fileId,
    line: at('m_Enabled'),
    note: `m_Enabled=${d.m_Enabled}, and every ancestor of "${inst.gameObject}" is m_IsActive: 1 — checked, not assumed.`,
  })

  // A field the environment scene overrode did not come from the prefab, and its provenance must
  // say so or the sheet is lying about where the number lives.
  const overridden = new Set(
    (overrides.byScene[sceneRel] ?? []).map((m) => m.propertyPath).filter((p) => p in inst.data),
  )
  const fieldSource = (name) =>
    overridden.has(name)
      ? `${sceneRel} m_Modifications[${name}] on ${sourceRel}#${inst.fileId} Sky.${name}`
      : src(name)
  const fieldOrigin = (name) => (overridden.has(name) ? 'scene-component' : origin)
  const overrideNote = (name) =>
    overridden.has(name)
      ? `OVERRIDDEN by the environment scene: the prefab says ${inst.data[name]}, the scene says ${d[name]}, and the scene is what every mission loads.`
      : null
  const joinNote = (a, b) => (a && b ? `${a} ${b}` : (a ?? b ?? null))

  for (const [name, unit, note] of [
    ['masterIntensity', null, 'Multiplies all three of the others. Sky.cs:582-584.'],
    [
      'diffIntensity',
      null,
      'The SH ambient multiplier — the one that decides how dark shadowed terrain gets.',
    ],
    ['specIntensity', null, null],
    [
      'skyIntensity',
      null,
      'The VISIBLE skybox only. Matt remembered this as a separate setting from the lighting one; it is.',
    ],
    ['camExposure', null, 'Folded into Albedo, so it scales diffuse and specular alike.'],
  ]) {
    ibl[name] = put(`${prefix}.${name}`, {
      value: num(d[name]),
      unit,
      trust: 'verified',
      origin: fieldOrigin(name),
      source: fieldSource(name),
      fileId: inst.fileId,
      line: at(name),
      note: joinNote(note, overrideNote(name)),
    })
  }

  for (const name of ['hdrSky', 'hdrSpec', 'linearSpace', 'autoDetectColorSpace', 'IsProbe']) {
    ibl[name] = put(`${prefix}.${name}`, {
      value: num(d[name]) === 1,
      unit: null,
      trust: 'verified',
      origin: fieldOrigin(name),
      source: fieldSource(name),
      fileId: inst.fileId,
      line: at(name),
      note: joinNote(
        name === 'hdrSky' || name === 'hdrSpec'
          ? 'The cubemaps behind these are m_TextureFormat: 5 (ARGB32, LDR) — Skyshop was told to treat an LDR sky as HDR, so no RGBM divisor is applied.'
          : null,
        overrideNote(name),
      ),
    })
  }

  const e = skyshopExposure(d)
  ibl.exposure = put(`${prefix}.exposure`, {
    value: {
      diffuse: round(e.diffuse, 6),
      specular: round(e.specular, 6),
      sky: round(e.sky, 6),
      camera: round(e.camera, 6),
    },
    unit: null,
    trust: 'derived',
    origin: 'computed',
    source: `${SKYSHOP_SKY_CS} ComputeExposureVector (Sky.cs:580-591) applied to ${src('*Intensity')}`,
    fileId: inst.fileId,
    line: at('masterIntensity'),
    formula: `diffuse = ${d.masterIntensity} * ${d.diffIntensity} = ${round(e.diffuse, 6)}; specular = ${d.masterIntensity} * ${d.specIntensity} = ${round(e.specular, 6)}; sky = ${d.masterIntensity} * ${d.skyIntensity} * ${d.camExposure} = ${round(e.sky, 6)}; ldr2hdr divisor ${round(e.ldr2hdr, 6)} unused because hdrSky and hdrSpec are both 1`,
    note: 'This is `_ExposureIBL`. The shader does `Emission += SHLookup(N) * Albedo * _ExposureIBL.x` (MarmosetSurf.cginc:524).',
  })

  ibl.rotationUnity = put(`${prefix}.rotationUnity`, {
    value: q.map((v) => round(v, 6)),
    unit: null,
    trust: 'verified',
    origin,
    source: `${sourceRel}#${inst.transform?.fileId ?? '(none)'} Transform.m_LocalRotation`,
    fileId: inst.transform?.fileId ?? null,
    line: null,
    formula: `yaw = 2 * acos(${q[3]}) = ${round(yawDeg, 6)} deg about +Y`,
    note:
      'NOT decorative. `Sky.UpdateSkyTransform()` builds `_SkyMatrix` from this transform and ' +
      '`skyRotate()` multiplies a normal by its TRANSPOSE (MarmosetCore.cginc:304-309), so the SH ' +
      'is looked up in sky space. Every ancestor is unrotated, so this quaternion is the whole ' +
      'rotation. Unity space — flip it before use.',
  })

  ibl.sh = put(`${prefix}.sh`, {
    value: sh,
    unit: null,
    trust: 'verified',
    origin,
    source: src('SH.c'),
    fileId: inst.fileId,
    line: at('SH'),
    note:
      '27 floats: nine spherical-harmonic coefficients, RGB-interleaved, bands l=0,1,2 in the ' +
      'conventional order. RADIANCE, not irradiance — Marmoset applies no cosine lobe ' +
      '(`sEquationConstants` are the bare basis constants), so a consumer that expects irradiance ' +
      'must divide by A_l = 1, 2/3, 1/4. Baked from a cubemap we cannot ship; these numbers are a ' +
      'measurement of that sky, not the sky.',
  })

  ibl.shBuffer = put(`${prefix}.shBuffer`, {
    value: buffer,
    unit: null,
    trust: 'verified',
    origin,
    source: src('SH.cBuffer'),
    fileId: inst.fileId,
    line: at('SH'),
    formula: 'cBuffer[i] = c[i*3+k] * sEquationConstants[i] (SHEncoding.cs copyToBuffer)',
    note: `The nine _SH0.._SH8 shader uniforms verbatim. Cross-checked against c * sEquationConstants: max error ${bufferMaxError === null ? '(not checked)' : bufferMaxError.toExponential(2)}.`,
  })

  ibl.averageColor = put(`${prefix}.averageColor`, {
    value: buffer.length ? buffer[0].map((v) => round(v, 6)) : null,
    unit: null,
    trust: 'derived',
    origin: 'computed',
    source: src('SH.cBuffer[0]'),
    fileId: inst.fileId,
    line: at('SH'),
    formula: 'cBuffer[0] = c[0..2] * 0.28209479, which is the sky mean radiance',
    note: 'A sanity handle: this is the flat colour the SH reduces to if you throw away bands 1 and 2.',
  })

  // Evidence only. These are Marmoset Asset Store demo assets; they do not enter the build.
  ibl.bakedFrom = {
    specularCube: d.specularCube?.guid ? resolveGuid(String(d.specularCube.guid)) : null,
    skyboxCube: d.skyboxCube?.guid ? resolveGuid(String(d.skyboxCube.guid)) : null,
    note: 'Recorded so the SH can be re-derived if these ever become available. NEVER shipped (CLAUDE.md rule 7).',
  }

  ibl.overrides = overrides
  ibl.ancestors = inst.ancestors
  return ibl
}

/** The four SHIPPED environments, resolved from the shipped missions' LoadLevelArt.levelName. */
function shippedEnvironments(perScene) {
  const byId = new Map()
  for (const p of perScene) {
    if (p.kind !== 'mission') continue
    if (!p.environmentScene) {
      warn(`${p.scene}: no LoadLevelArt.levelName, so its environment cannot be resolved`)
      continue
    }
    const id = ENVIRONMENT_ID[p.environmentScene]
    if (!id) {
      warn(
        `${p.scene}: LoadLevelArt.levelName "${p.environmentScene}" has no FF2 environment id (tools/extract/level.mjs ENV_ID)`,
      )
      continue
    }
    if (!byId.has(id)) byId.set(id, { environment: id, levelArt: p.environmentScene, missions: [] })
    byId.get(id).missions.push(p.scene)
  }
  return [...byId.values()]
    .map((e) => ({ ...e, missions: e.missions.slice().sort() }))
    .sort((a, b) => (a.environment < b.environment ? -1 : 1))
}

/**
 * Compare an environment scene's own copy of the component against the level-art prefab of the
 * same name, and record whether the scene instantiates that prefab at all.
 *
 * This is where the Alpine surprise lives. `LevelArt_AlpineForest.unity` carries eleven prefab
 * instances and NOT ONE of them is `LevelArt_AlpineForest.prefab`: the scene holds its own copy of
 * the level art, whose objects keep a `m_PrefabParentObject` back-pointer to the prefab they were
 * authored from but are not an instance of it. So reading the Alpine prefab would be reading an
 * asset nothing loads. It happens to agree field for field — which is exactly why the tool has to
 * check rather than assume.
 */
function crossCheckEnvironment(sceneRel, sceneScan, prefabRel, prefabScan) {
  const prefabDifferences = []
  if (prefabScan) {
    for (const si of sceneScan.instances) {
      // A scene copy keeps a back-pointer to the prefab document it was authored from:
      // m_PrefabParentObject.fileID. That is the only sound pairing — the GameObject names repeat
      // across environments (`terrain`, `water`) and the fileIDs do not otherwise correspond.
      const parentId = String(si.data.m_PrefabParentObject?.fileID ?? '0')
      const against = prefabScan.instances.find((pi) => pi.fileId === parentId)
      if (!against) {
        prefabDifferences.push({
          sceneFileId: si.fileId,
          field: '(no matching component in the prefab)',
          scene: si.gameObject,
          prefab: parentId === '0' ? null : parentId,
        })
        continue
      }
      for (const [, ykey] of TERRAIN_FIELDS) {
        const a = normaliseValue(sceneScan, si.data[ykey])
        const b = normaliseValue(sceneScan, against.data[ykey])
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          prefabDifferences.push({ sceneFileId: si.fileId, field: ykey, scene: a, prefab: b })
        }
      }
    }
  }
  const prefabGuid = prefabScan ? (pathToGuid.get(prefabRel) ?? null) : null
  return {
    scene: sceneRel,
    sceneDocumentCount: sceneScan.documentCount,
    inlineFacetedTerrainCount: sceneScan.instances.length,
    levelArtPrefab: prefabScan ? prefabRel : null,
    // Read off the scene's m_ParentPrefab entries, never inferred from the file names lining up.
    // null when there is no same-named prefab to instantiate (Kauai).
    instantiatesLevelArtPrefab: prefabGuid ? sceneScan.parentPrefabGuids.has(prefabGuid) : null,
    fieldModifications: sceneScan.modifyingPrefabInstances,
    prefabDifferences,
  }
}

/** A material colour [r, g, b, a], unrounded, off the RAW text (both dialects); null if absent. */
const materialColour = (matRel, name) => {
  if (!unityExists(matRel)) return null
  return rawColour(unityRead(matRel), name)?.value ?? null
}

/** A material float, unrounded, off the RAW text (both dialects); null if absent. */
const materialFloat = (matRel, name) => {
  if (!unityExists(matRel)) return null
  return rawFloat(unityRead(matRel), name)?.value ?? null
}

/**
 * What the YAML PARSER sees of a material colour: a receipt, not a reader. It returns null for
 * every colour but the last-written one on an old-dialect material (DEV-043), which is exactly
 * the thing the medal and orb entries record as `parserSawColour`. Never feed a value from this
 * into the sheet.
 */
const parsedMaterialColour = (matRel, name) => {
  if (!unityExists(matRel)) return null
  const doc = loadAsset(matRel).docs.find((d) => d.data?.m_SavedProperties)
  const list = doc?.data?.m_SavedProperties?.m_Colors
  if (!Array.isArray(list)) return null
  for (const entry of list) {
    if (String(entry?.first?.name ?? '') === name) return entry.second ?? null
  }
  return null
}

/**
 * Does this material actually BLEND, or is its alpha decoration?
 *
 * `m_ShaderKeywords` is the whole answer and it is easy to skip. Both ring
 * materials carry an alpha in `_Color` — 0.891 on the studs, 0.709 on the
 * frame — but only `checkpoint_enabled` has `_ALPHABLEND_ON`. The studs are
 * OPAQUE and their 0.891 never reached a framebuffer.
 *
 * Rendering them at 89% cost exactly what you would expect: Matt reported the
 * studs reading faint against the 2016 screenshots.
 */
const materialBlends = (matRel) => {
  if (!unityExists(matRel)) return null
  const mat = loadAsset(matRel)
  const doc = mat.docs.find((d) => d.data?.m_SavedProperties) ?? mat.docs[0]
  const keywords = String(doc?.data?.m_ShaderKeywords ?? '')
  return /_ALPHABLEND_ON|_ALPHAPREMULTIPLY_ON/.test(keywords)
}

/**
 * The turn indicator — the cyan chevron that tells you where the course goes.
 *
 * These are the markers in Matt's 2016 screenshots, and every hoverJet mission
 * has them: 9 on `int_01`, 27 on `int_02`. They are placed in TRIOS at each
 * turn — three clusters of three on `int_01` — so a turn reads as a run of
 * arrows sweeping round rather than as one sign.
 *
 * `turnIndicator.prefab` is six objects:
 *
 *   turnIndicator            the root; every scene overrides its pos AND rot
 *     turnIndicator_art (2)  the arrow mesh, material `checkpoint_enabled.mat`,
 *                            scaled NON-UNIFORMLY by (5.13, 4.87, 3.08)
 *       Cube, Cube (1)       the two long bars, material `glowyMaterial.mat`
 *       Cube (2), Cube (3)   the two short bars
 *
 * Two things a port gets wrong here if it is not careful:
 *
 *  1. **The four bars are CHILDREN of the non-uniformly scaled art node**, and
 *     they are rotated (+-35..37 degrees about z). A rotation underneath a
 *     non-uniform parent scale is a SHEAR, not a rotation — flatten the
 *     hierarchy and the chevron's bars come out the wrong shape. three.js
 *     composes TRS exactly as Unity does, so keeping the nesting reproduces it
 *     for free; computing world transforms by hand does not.
 *
 *  2. **The materials are the gate's own.** Both guids resolve to
 *     `checkpoint_enabled.mat` and `glowyMaterial.mat` — the same two materials
 *     `Checkpoint_Ring.prefab` uses. So a turn indicator is, visually, a gate
 *     unrolled into an arrow, and it inherits every correction already made to
 *     those two: the frame blends at 0.709 alpha with `_GlowStrength` 0.25, the
 *     bars are OPAQUE with `_GlowStrength` 2. Nothing here re-extracts them.
 */
/**
 * The jump pad's particles, and which one a scored plate fires (DEV-415).
 *
 * `Trigger_JumpTarget.OnTriggerEnter` (`Scripts/Trigger_JumpTarget.cs:57-59`)
 * plays `jumpPad_fx` when the seat enters a scoring plate and it is not already
 * playing, beside `LandedJumpPad` and the `CollectRing` cue. Every scoring
 * trigger on the prefab names the SAME system, so this reads the reference off
 * the triggers rather than picking one by name, and dies if they disagree: a
 * pad with two different bursts is a different mechanism, not a detail.
 */
function extractJumpPad() {
  const relPath = 'Assets/Faceted Flight/Prefabs/target_jumppad.prefab'
  if (!unityExists(relPath)) {
    warn(`${relPath}: not found; a scored pad will have no burst`)
    return null
  }
  const asset = loadAsset(relPath)
  const refs = new Set()
  let triggers = 0
  for (const doc of asset.docs) {
    if (doc.classId !== 114 || !doc.data || !('jumpPad_fx' in doc.data)) continue
    triggers++
    const id = String(doc.data.jumpPad_fx?.fileID ?? '0')
    if (id !== '0') refs.add(id)
  }
  if (refs.size > 1)
    die(`${relPath}: scoring triggers name ${refs.size} different jumpPad_fx systems`)
  const burstFileId = refs.size === 1 ? [...refs][0] : null
  const particles = scanParticleSystems(relPath)
  if (burstFileId !== null && !particles.some((p) => p.fileId === burstFileId))
    die(`${relPath}: jumpPad_fx ${burstFileId} is not a particle system on the prefab`)
  return {
    source: relPath,
    // How many MonoBehaviours carry the field. All 17 plates on a shipped pad.
    scoringTriggers: triggers,
    // The system a scored plate plays, as `particles[].fileId`. Null if no
    // trigger assigns one, which would mean 2016 had no burst.
    burstFileId,
    particles,
  }
}

function extractTurnIndicator() {
  const relPath = 'Assets/Faceted Flight/Prefabs/turnIndicator.prefab'
  if (!unityExists(relPath)) {
    warn(`${relPath}: not found; the course will have no turn markers`)
    return null
  }
  const asset = loadAsset(relPath)

  // Walk transforms into a {name -> node} map, keeping the parent link so the
  // renderer can rebuild the hierarchy rather than a flattened list.
  const byTransformId = new Map()
  for (const doc of asset.docs) {
    if (doc.type !== 'Transform') continue
    const go = asset.byId.get(String(doc.data?.m_GameObject?.fileID ?? '0'))
    const p = doc.data.m_LocalPosition
    const r = doc.data.m_LocalRotation
    const sc = doc.data.m_LocalScale
    const comps = componentsOfGo(asset.byId, go)
    const filter = comps.find((c) => c.classId === 33)
    const renderer = comps.find((c) => c.classId === 23)
    const meshRef = filter?.data?.m_Mesh
    const matGuid = renderer?.data?.m_Materials?.[0]?.guid
    byTransformId.set(String(doc.fileId), {
      name: String(go?.data?.m_Name ?? ''),
      active: num(go?.data?.m_IsActive) === 1,
      parent: String(doc.data?.m_Father?.fileID ?? '0'),
      // fileID 10202 is Unity's BUILT-IN cube. It has no asset path, and a port
      // that resolves it as a mesh reference gets null and draws nothing.
      mesh: meshRef?.guid ? resolveGuid(String(meshRef.guid)) : null,
      builtinMesh: meshRef?.guid ? null : (num(meshRef?.fileID) ?? null),
      material: matGuid ? resolveGuid(String(matGuid)) : null,
      position: [num(p?.x) ?? 0, num(p?.y) ?? 0, num(p?.z) ?? 0],
      rotation: [num(r?.x) ?? 0, num(r?.y) ?? 0, num(r?.z) ?? 0, num(r?.w) ?? 1],
      scale: [num(sc?.x, 1), num(sc?.y, 1), num(sc?.z, 1)],
    })
  }

  const nodes = [...byTransformId.values()]
  const art = nodes.find((n) => /_art\b/.test(n.name)) ?? null
  if (!art) warn(`${relPath}: no "*_art" node — the arrow mesh will be missing`)

  const bars = nodes
    .filter((n) => /^Cube( \(\d+\))?$/.test(n.name))
    // Stable order, and it is a meaningful one: top pair before bottom pair.
    .sort((a, b) => b.position[1] - a.position[1] || a.position[0] - b.position[0])
    .map(({ name, active, mesh, builtinMesh, material, position, rotation, scale }) => ({
      name,
      active,
      mesh,
      builtinMesh,
      material,
      position: position.map((v) => round(v, 6)),
      rotation: rotation.map((v) => round(v, 6)),
      scale: scale.map((v) => round(v, 6)),
    }))

  return {
    prefab: relPath,
    arrow: put('props.turnIndicator.arrow', {
      value: art && {
        mesh: art.mesh,
        material: art.material,
        position: art.position.map((v) => round(v, 6)),
        rotation: art.rotation.map((v) => round(v, 6)),
        scale: art.scale.map((v) => round(v, 6)),
      },
      unit: 'm',
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${relPath} GameObject "turnIndicator_art (2)" Transform + MeshFilter + MeshRenderer`,
      fileId: null,
      line: null,
      note:
        'UNITY SPACE — flip it before use. The 4.43 x 5.48 x 1.01 m mesh is scaled NON-UNIFORMLY ' +
        'to a 22.7 x 26.7 x 3.1 m arrow, and the four bars hang underneath that scale. Keep the ' +
        'parent/child nesting: a rotated child under a non-uniform parent scale is a shear.',
    }),
    bars: put('props.turnIndicator.bars', {
      value: bars,
      unit: 'm',
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${relPath} GameObjects "Cube", "Cube (1..3)" — children of the art node`,
      fileId: null,
      line: null,
      note:
        'LOCAL TO THE ART NODE, in Unity space. Built-in cube (fileID 10202), so there is no ' +
        'mesh asset to load — a 1 m box is the whole geometry. Two long bars (3.44 x 0.185) and ' +
        'two short (0.271 x 0.956), each rotated about z, forming the chevron.',
    }),
    barCount: bars.length,
    // Deliberately NOT re-extracted: both materials are byte-identical to the
    // gate's, so `props.checkpointRing` is the single place they are described.
    arrowMaterialIsRingFrame:
      art?.material === 'Assets/Faceted Flight/Materials/checkpoint_enabled.mat',
    barMaterialIsRingStud: bars.every(
      (b) => b.material === 'Assets/Faceted Flight/Materials/glowyMaterial.mat',
    ),
  }
}

/**
 * The checkpoint gate, which is not one mesh.
 *
 * Matt's 2016 screenshots show a bright GREEN translucent hexagonal frame with
 * lighter studs around it. The port was drawing a dark thin ring, because
 * `checkpoint_ring.glb` is only ONE of the gate's parts — `jumpGate_diamond` —
 * and it arrives wearing whatever material the FBX carried rather than the
 * material the prefab assigns it.
 *
 * `Prefabs/Checkpoint_Ring.prefab` is 34 objects:
 *
 *   jumpGate_diamond   the frame, material `checkpoint_enabled.mat`
 *   Cube x18           the studs, material `glowyMaterial.mat`
 *   ringBurst x7       particle bursts, ringIdle x1
 *   trigger_checkpoint x3   the TriggerCheckpoint colliders
 *   treeRemover        Trigger_RemoveTrees
 *
 * Both materials use `Marmoset/Shader/Illumin/Marmoset Specular IBL.shader` —
 * third-party, unshippable, so FF2 writes its own. What travels is the numbers:
 * the frame is (0.325, 1.0, 0.059) at 0.709 alpha, and the studs are near-white
 * with a teal `_GlowColor`.
 *
 * The 18 stud transforms come out too. They are plain boxes, so the port can
 * rebuild them from these numbers with no new asset at all.
 */
function extractCheckpointRing() {
  const relPath = 'Assets/Faceted Flight/Prefabs/Checkpoint_Ring.prefab'
  if (!unityExists(relPath)) {
    warn(`${relPath}: not found; the gate will render without its glow`)
    return null
  }
  const asset = loadAsset(relPath)

  const ENABLED = 'Assets/Faceted Flight/Materials/checkpoint_enabled.mat'
  const GLOWY = 'Assets/Faceted Flight/Materials/glowyMaterial.mat'

  // ── The frame's own transform, which was missing and cost us the gate ────────────────────────
  //
  // `jumpGate_diamond` is not at the prefab origin at unit scale: it sits at
  // (-0.069, 0.359, 0.014) and is **scaled 3.885**. Leave that out and the frame renders at a
  // quarter of its size inside a stud cage that IS the right size — which is most of why the gate
  // did not look like the gate.
  //
  // The mesh path is recorded for the same reason. `checkpoint-ring.glb` shipped for a while as
  // `pPipe1`, a 100-vertex Maya pipe from some other file, while the real gate is a 1,698-vertex
  // 908-triangle frame. Naming the FBX here makes that a comparison the asset pipeline can fail on
  // rather than something you notice in a screenshot.
  let frame = null
  let frameFatherId = '0'
  for (const doc of asset.docs) {
    if (doc.type !== 'GameObject') continue
    if (String(doc.data?.m_Name ?? '') !== 'jumpGate_diamond') continue
    const comps = componentsOfGo(asset.byId, doc)
    const t = comps.find((c) => c.classId === 4)
    const filter = comps.find((c) => c.classId === 33)
    const meshGuid = filter?.data?.m_Mesh?.guid ? String(filter.data.m_Mesh.guid) : null
    if (frame) {
      warn(`${relPath}: more than one "jumpGate_diamond"; using the first`)
      break
    }
    const p = t?.data?.m_LocalPosition
    const r = t?.data?.m_LocalRotation
    const sc = t?.data?.m_LocalScale
    frame = {
      active: num(doc.data.m_IsActive) === 1,
      mesh: meshGuid ? resolveGuid(meshGuid) : null,
      position: [num(p?.x), num(p?.y), num(p?.z)],
      rotation: [num(r?.x), num(r?.y), num(r?.z), num(r?.w, 1)],
      scale: [num(sc?.x, 1), num(sc?.y, 1), num(sc?.z, 1)],
    }
    frameFatherId = String(t?.data?.m_Father?.fileID ?? '0')
  }
  if (!frame) warn(`${relPath}: no GameObject named "jumpGate_diamond" — the gate has no frame`)

  // The studs, in the prefab's own local space.
  const studs = []
  const studFatherIds = new Set()
  for (const doc of asset.docs) {
    if (doc.type !== 'Transform') continue
    const go = asset.byId.get(String(doc.data?.m_GameObject?.fileID ?? '0'))
    const name = String(go?.data?.m_Name ?? '')
    if (!/^Cube( \(\d+\))?$/.test(name)) continue
    const p = doc.data.m_LocalPosition
    const r = doc.data.m_LocalRotation
    const sc = doc.data.m_LocalScale
    studFatherIds.add(String(doc.data?.m_Father?.fileID ?? '0'))
    studs.push({
      position: [num(p?.x) ?? 0, num(p?.y) ?? 0, num(p?.z) ?? 0],
      rotation: [num(r?.x) ?? 0, num(r?.y) ?? 0, num(r?.z) ?? 0, num(r?.w) ?? 1],
      scale: [num(sc?.x) ?? 1, num(sc?.y) ?? 1, num(sc?.z) ?? 1],
    })
  }
  // Stable order: fileIDs are opaque, so sort by position rather than by
  // whatever order the YAML happened to serialise.
  studs.sort(
    (a, b) =>
      a.position[1] - b.position[1] ||
      a.position[0] - b.position[0] ||
      a.position[2] - b.position[2],
  )

  // ── the pivot chains, which are why the gate was standing on end ───────
  //
  // Matt, with a 2016 screenshot: *"right now the gates are 'upright' and should
  // be rotated 90. (they're currently tall and skinny, i want them wide)"*
  //
  // The frame and the studs are extracted in their own LOCAL space, and the port
  // composed both straight onto the ring's world matrix. Neither is a child of
  // the ring root. Both hang under an intermediate node carrying
  // `m_LocalEulerAnglesHint: {x: 0, y: 0, z: 90}` — **a 90-degree roll** — and
  // dropping it is exactly the difference between a gate 24 m wide by 35 tall
  // and one 35 by 24.
  //
  // A chain per object, not one shared pivot: the first attempt assumed they
  // shared a parent and the guard caught it on its first run. They do not. The
  // frame hangs directly off the rolled node; the studs hang off `highlightCubes`
  // under it, which is identity — so the net rotation is the same and the depth
  // is not. This is the THIRD transform in this one prefab to go missing this way
  // (the frame's own scale of 3.885 was the second), which is why it walks.
  //
  // The walk stops AT the prefab root: its pose is the ring's own world matrix,
  // which the level JSON already carries per instance.
  const pivotChain = (fatherId) => {
    const chain = []
    const seen = new Set()
    let id = String(fatherId ?? '0')
    while (id && id !== '0' && !seen.has(id)) {
      seen.add(id)
      const t = asset.byId.get(id)
      if (t?.classId !== 4) break
      const nextId = String(t.data?.m_Father?.fileID ?? '0')
      if (nextId === '0') break
      const p = t.data?.m_LocalPosition
      const r = t.data?.m_LocalRotation
      const sc = t.data?.m_LocalScale
      chain.unshift({
        position: [num(p?.x) ?? 0, num(p?.y) ?? 0, num(p?.z) ?? 0],
        rotation: [num(r?.x) ?? 0, num(r?.y) ?? 0, num(r?.z) ?? 0, num(r?.w) ?? 1],
        scale: [num(sc?.x) ?? 1, num(sc?.y) ?? 1, num(sc?.z) ?? 1],
      })
      id = nextId
    }
    return chain
  }
  const framePivots = pivotChain(frameFatherId)
  // Every stud under one parent, or one chain cannot describe them all.
  if (studFatherIds.size > 1) {
    warn(
      `${relPath}: the 18 studs do not share a parent (${[...studFatherIds].join(', ')}) — ` +
        'one pivot chain cannot place them',
    )
  }
  const studPivots = pivotChain([...studFatherIds][0] ?? '0')

  const pivotNote =
    'UNITY SPACE, OUTERMOST FIRST. Compose gate x chain[0] x ... x local. The 90-degree roll ' +
    'about z is in here; leaving it out renders the gate on end, 24 m wide by 35 tall instead ' +
    'of 35 by 24.'

  return {
    prefab: relPath,
    framePivots: put('props.checkpointRing.framePivots', {
      value: framePivots,
      unit: 'm',
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${relPath} the Transform chain between "jumpGate_diamond" and the prefab root`,
      fileId: frameFatherId,
      line: null,
      note: pivotNote,
    }),
    studPivots: put('props.checkpointRing.studPivots', {
      value: studPivots,
      unit: 'm',
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${relPath} the Transform chain between the 18 "Cube" studs and the prefab root`,
      fileId: [...studFatherIds][0] ?? null,
      line: null,
      note: `${pivotNote} Two deep here: the rolled node, then an identity "highlightCubes".`,
    }),
    frame: put('props.checkpointRing.frame', {
      value: frame,
      unit: 'm',
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${relPath} GameObject "jumpGate_diamond" Transform + MeshFilter.m_Mesh`,
      fileId: null,
      line: null,
      note:
        'UNITY SPACE — flip it before use. Scale 3.885 turns a 6.24 x 9.07 x 4.47 m mesh into a ' +
        '24 x 35 m gate, which is what the 18 studs (x +-9.6, y -14.6..+15.5) and the 11.31 m ' +
        'trigger sphere are sized against.',
    }),
    frameColor: put('props.checkpointRing.frameColor', {
      value: materialColour(ENABLED, '_Color'),
      unit: null,
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${ENABLED} m_SavedProperties.m_Colors._Color`,
      fileId: null,
      line: null,
      note: 'Bright green, alpha 0.709. On `jumpGate_diamond`, which IS the mesh shipped as checkpoint-ring.glb — it just arrives wearing the FBX default instead.',
    }),
    studColor: materialColour(GLOWY, '_Color'),
    studGlowColor: materialColour(GLOWY, '_GlowColor'),
    studEmissionColor: materialColour(GLOWY, '_EmissionColor'),
    // -- how each material actually draws ----------------------------------
    //
    // `_ALPHABLEND_ON` is the difference between an alpha that blends and an
    // alpha that is ignored. The studs carry 0.891 and do NOT have the keyword,
    // so they are opaque; the frame carries 0.709 and DOES.
    //
    // `_GlowStrength` is the Illumin shader's emission multiplier and it is very
    // different on the two: **2** on the studs, **0.25** on the frame. So the
    // studs are the bright thing on a gate and the frame is barely lit — which
    // is the opposite of how a port guesses it.
    frameBlends: materialBlends(ENABLED),
    frameGlowColor: materialColour(ENABLED, '_GlowColor'),
    frameGlowStrength: materialFloat(ENABLED, '_GlowStrength'),
    frameSpecular: {
      intensity: materialFloat(ENABLED, '_SpecInt'),
      shininess: materialFloat(ENABLED, '_Shininess'),
      fresnel: materialFloat(ENABLED, '_Fresnel'),
    },
    studBlends: materialBlends(GLOWY),
    studGlowStrength: materialFloat(GLOWY, '_GlowStrength'),
    studSpecColor: materialColour(GLOWY, '_SpecColor'),
    studSpecular: {
      intensity: materialFloat(GLOWY, '_SpecInt'),
      shininess: materialFloat(GLOWY, '_Shininess'),
      fresnel: materialFloat(GLOWY, '_Fresnel'),
    },
    studs,
    studCount: studs.length,
    // The gate's particle systems. Note `ringIdle` does NOT emit — its
    // EmissionModule is disabled — so a gate has no idle sparkle, only bursts.
    // `emits` on each row is the honest answer; `playOnAwake` is not.
    particles: scanParticleSystems(relPath),
    shader: 'Assets/Marmoset/Shader/Illumin/Marmoset Specular IBL.shader',
    shaderIsThirdParty: true,
    // ── A passed gate DISAPPEARS, two seconds later (DEV-122) ─────────────
    //
    // `TriggerCheckpoint.OnTriggerEnter` on tag "Player", with `checkpointArt`
    // set and `triggerOnce` true, starts `Deactivate()`: `WaitForSeconds(2f)`,
    // then `checkpointArt.SetActive(false)` and `Destroy(transform.parent)`.
    // `checkpointArt` is the `offset` node — the rolled pivot BOTH the frame and
    // the stud cage hang under — so the whole gate vanishes at once, as a pop.
    // Traced to the last step of hard rule 2: every one of the 172 live
    // TriggerCheckpoints across the seven shipped scenes resolves
    // `checkpointArt` to a non-null object and `triggerOnce` to 1 after the
    // scene's m_Modifications. Only the PLAYER's pass does this: the "npc" tag
    // branch (line 133) plays the burst and hides nothing.
    //
    // The 2 s is a literal inside the coroutine — no field, so no YAML and
    // nothing a scene could override — which is exactly what `code-default`
    // means here.
    passedHideDelay: put('props.checkpointRing.passedHideDelay', {
      value: 2,
      unit: 's',
      trust: 'code-default',
      origin: 'csharp-initializer',
      source: 'Assets/Faceted Flight/Scripts/TriggerCheckpoint.cs:151',
      fileId: null,
      line: 151,
      note:
        '`yield return new WaitForSeconds (2f)` in `TriggerCheckpoint.Deactivate()`, then ' +
        '`checkpointArt.SetActive(false)`. A literal in the coroutine body, not a serialised ' +
        'field: no YAML carries it and no scene can override it. Player passes only — the ' +
        '"npc" branch never hides a gate.',
    }),
  }
}

/**
 * The FINISH gate's look — `Prefabs/FinishLine.prefab` (DEV-123).
 *
 * The frame is the ring's own `jumpGate_diamond` mesh (so no new asset) wearing
 * a DIFFERENT material: `checkpoint_finish.mat`, orange where a ring is green.
 * Its studs are the ring's `glowyMaterial` — 40 of them, but the per-mission
 * placements are the level extractor's business (`finish.art` in the level
 * JSON), because they are world poses composed through four intermediate
 * pivots and the stripped instance's overrides. What is CONSTANT across the
 * seven missions is the two materials, and that is all this entry carries.
 *
 * `TriangularJumpgate2Green_pwm` — a second frame in the same prefab — is
 * `m_IsActive: 0`, and a Materialized Mesh besides (hard rule 7). Not here.
 */
function extractFinishGate() {
  const relPath = 'Assets/Faceted Flight/Prefabs/FinishLine.prefab'
  const FINISH = 'Assets/Faceted Flight/Materials/checkpoint_finish.mat'
  if (!unityExists(relPath) || !unityExists(FINISH)) {
    warn(`${relPath} or ${FINISH}: not found; the finish gate will render in a ring's colour`)
    return null
  }
  return {
    prefab: relPath,
    frameMaterial: FINISH,
    frameColor: put('props.finishGate.frameColor', {
      value: materialColour(FINISH, '_Color'),
      unit: null,
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${FINISH} m_SavedProperties.m_Colors._Color`,
      fileId: null,
      line: null,
      note:
        'ORANGE (1, 0.62, 0.15) at alpha 0.709 — the same alpha as a ring frame and a ' +
        'different hue, which is how 2016 told the finish from the course. On `jumpGate_diamond` ' +
        'under FinishLine/Checkpoint_Ring, the MeshRenderer that is live in all seven scenes.',
    }),
    frameGlowColor: materialColour(FINISH, '_GlowColor'),
    frameGlowStrength: materialFloat(FINISH, '_GlowStrength'),
    frameBlends: materialBlends(FINISH),
    frameSpecular: {
      intensity: materialFloat(FINISH, '_SpecInt'),
      shininess: materialFloat(FINISH, '_Shininess'),
      fresnel: materialFloat(FINISH, '_Fresnel'),
    },
    // Deliberately NOT re-extracted: the studs are `glowyMaterial.mat`, byte for
    // byte the ring's, so `props.checkpointRing.stud*` is the one description.
    studMaterialIsRingStud: true,
    shader: 'Assets/Marmoset/Shader/Illumin/Marmoset Specular IBL.shader',
    shaderIsThirdParty: true,
  }
}

/**
 * A float off a `.mat`, read from the RAW text so both 2016 dialects answer.
 *
 * `materialFloat` goes through the YAML parser, which reads the old dialect's
 * repeated `data:` keys as ONE key and returns null — the DEV-043 trap, which
 * `rawMaterialColour` already answers for colours. This is its float twin.
 */
function rawMaterialFloat(matRel, name) {
  const f = rawFloat(unityRead(matRel), name)
  return f && { value: round(f.value, 6), line: f.line }
}

/**
 * The energy orb's LOOK — `Prefabs/EnergyOrb.prefab` (DEV-327).
 *
 * Two GameObjects. The root carries the 12.98 m magnet sphere, `Trigger_Magnet`
 * and a sparkle `ParticleSystem`; its one child, `sphere_fancy_lod_01`, is the
 * thing you see and the thing you collect: `MeshFilter` -> mesh 4300000 of
 * `Meshes/sphere_fancy_lod_01.fbx` (`pSolid2`, the file's only mesh — the
 * `_lod_01` is a file name, there is no LODGroup anywhere in the prefab),
 * `MeshRenderer` -> `energy_orb.mat`, the 3 m trigger, and a Unity `Halo`.
 *
 * ── The material is the OLD dialect ─────────────────────────────────────
 *
 * `energy_orb.mat` writes its properties as repeated `data: first/second`
 * blocks, which the parser reads as absence (DEV-043), so every number here is
 * read off the raw text and the parser's own answer rides along as a receipt.
 * Its shader is `Marmoset/Self-Illumin/Diffuse IBL`: `"RenderType"="Opaque"`,
 * `MARMO_SPECULAR_*` both commented out — so the `_Color` alpha (0.843) never
 * blends, and the `.mat`'s `_Shininess` / `_SpecInt` are serialised and unread.
 * What that shader draws is `_Color` lit, plus `_GlowColor * _GlowStrength`
 * (times Marmoset's exposure) as emission, `MarmosetSurf.cginc:439-445`.
 *
 * ── Hard rule 2 for a prefab interior ───────────────────────────────────
 *
 * The prefab's values stand only if no shipped scene overrides them, so the
 * shipped mission scenes' EnergyOrb instances are swept for any modification
 * that targets the ART half — its GameObject, Transform, MeshFilter,
 * MeshRenderer or Halo — other than the tag and static flags, which draw
 * nothing. `sceneArtOverrides` is that list and it is expected EMPTY. The
 * root's own scale overrides are listed separately, because they are real:
 * `int_01_jumpSeat` shrinks some of its orbs (a JumpSeat mission, whose orbs
 * no running mode scores).
 */
function extractEnergyOrb(missionScenePaths) {
  const relPath = 'Assets/Faceted Flight/Prefabs/EnergyOrb.prefab'
  if (!unityExists(relPath)) {
    warn(`${relPath}: not found; the orb will render as the port's stand-in`)
    return null
  }
  const asset = loadAsset(relPath)
  const root = rootTransformOf(asset)
  const rootGoId = String(root.data?.m_GameObject?.fileID ?? '0')

  const renderers = asset.docs.filter((d) => d.classId === 23)
  if (renderers.length !== 1) {
    warn(`${relPath}: expected ONE MeshRenderer, found ${renderers.length}`)
    if (renderers.length === 0) return null
  }
  const renderer = renderers[0]
  const go = asset.byId.get(String(renderer.data?.m_GameObject?.fileID ?? '0'))
  const comps = componentsOfGo(asset.byId, go)
  const tf = comps.find((c) => c.classId === 4)
  const filter = comps.find((c) => c.classId === 33)
  const trigger = comps.find((c) => c.classId === 135)
  const halo = comps.find((c) => c.classId === 122)
  if (String(tf?.data?.m_Father?.fileID ?? '0') !== String(root.fileId)) {
    warn(`${relPath}: the art is not a direct child of the root; one pose cannot place it`)
  }

  // The liveness walk: the art's own GameObject, the root's, and the renderer.
  // (The full chain from the art to the root, not only the two ends: the same answer while the
  // art is a direct child of the root, which the warning above reports when it is not.)
  const rootGo = asset.byId.get(rootGoId)
  const live =
    activeOf(go) === 1 &&
    activeOf(rootGo) === 1 &&
    chainIsLive(tf ? chainUp(asset.byId, tf).nodes : []) &&
    num(renderer.data?.m_Enabled) === 1

  // Mesh: the guid to the file, the fileID to the node through the .meta.
  const meshRef = filter?.data?.m_Mesh
  const meshPath = meshRef?.guid ? resolveGuid(String(meshRef.guid)) : null
  const meshFileId = meshRef?.fileID === undefined ? null : String(meshRef.fileID)
  let meshNode = null
  const meshImport = { serializedVersion: null, globalScale: null, useFileScale: null }
  if (meshPath && unityExists(`${meshPath}.meta`)) {
    const meta = unityRead(`${meshPath}.meta`)
    meshNode = new RegExp(`^\\s*${meshFileId}: (.+?)\\s*$`, 'm').exec(meta)?.[1] ?? null
    meshImport.serializedVersion = num(/^\s*serializedVersion: (\d+)/m.exec(meta)?.[1], null)
    meshImport.globalScale = num(/^\s*globalScale: ([-\d.eE]+)/m.exec(meta)?.[1], null)
    // ABSENT on a serializedVersion-16 meta, and absence is the finding: the
    // same-era `hoverJet_w_cockpit` (v16, globalScale 1, UnitScaleFactor 1)
    // draws its file numbers as metres, so a v16 import applies no file scale.
    const ufs = /^\s*useFileScale: (\d+)/m.exec(meta)?.[1]
    meshImport.useFileScale = ufs === undefined ? null : num(ufs) === 1
  }

  const matGuid = renderer.data?.m_Materials?.[0]?.guid
  const MAT = matGuid ? resolveGuid(String(matGuid)) : null
  if (!MAT || !unityExists(MAT)) {
    warn(`${relPath}: the orb's material does not resolve`)
    return null
  }
  const matText = unityRead(MAT)
  const shaderGuid = shaderGuidOf(matText)
  const shader = shaderGuid ? resolveGuid(shaderGuid) : null
  const shaderText = shader && unityExists(shader) ? unityRead(shader) : ''
  const shaderRenderType = /"RenderType"\s*=\s*"(\w+)"/.exec(shaderText)?.[1] ?? null

  const colour = rawMaterialColour(MAT, '_Color')
  const glowColour = rawMaterialColour(MAT, '_GlowColor')
  const glowStrength = rawMaterialFloat(MAT, '_GlowStrength')
  const emissionLM = rawMaterialFloat(MAT, '_EmissionLM')
  if (!colour || !glowColour || !glowStrength)
    warn(`${MAT}: a colour or the glow strength is missing`)

  const p = tf?.data?.m_LocalPosition
  const r = tf?.data?.m_LocalRotation
  const sc = tf?.data?.m_LocalScale

  // Color32 packs r in the LOW byte.
  const haloRgba = num(halo?.data?.m_Color?.rgba, 0) >>> 0
  const byte = (shift) => round(((haloRgba >>> shift) & 255) / 255, 6)

  // ── the shipped scenes, per hard rule 2 ───────────────────────────────
  const prefabGuid = pathToGuid.get(relPath) ?? null
  const artIds = new Set(
    [go, tf, filter, renderer, halo].filter(Boolean).map((d) => String(d.fileId)),
  )
  const inertPaths = /^(m_TagString|m_StaticEditorFlags)$/
  const sceneArtOverrides = []
  const rootScaleOverrides = []
  // Eight missions re-state the trigger's radius. Kept as the set of VALUES, so
  // a scene that ever changed it shows up as a second number here.
  const sceneTriggerRadii = new Set()
  let sceneInstances = 0
  for (const scene of missionScenePaths) {
    if (!prefabGuid || !unityExists(scene)) continue
    const text = unityRead(scene)
    const sceneLines = text.split(/\r?\n/)
    const scaled = new Map()
    for (const h of scanDocuments(sceneLines)) {
      if (h.classId !== 1001) continue
      const body = sceneLines.slice(h.start + 1, h.end).join('\n')
      if (!new RegExp(`m_ParentPrefab: \\{fileID: \\d+, guid: ${prefabGuid}`).test(body)) continue
      sceneInstances++
      const scale = {}
      for (const m of body.matchAll(
        /- target: \{fileID: (\d+)[^}]*\}\s*\r?\n\s*propertyPath: (\S+)\s*\r?\n\s*value: ([^\r\n]*)/g,
      )) {
        const [, target, prop, value] = m
        if (artIds.has(target) && !inertPaths.test(prop)) {
          sceneArtOverrides.push({ scene, target, propertyPath: prop, value: value.trim() })
        }
        if (trigger && target === String(trigger.fileId) && prop === 'm_Radius') {
          sceneTriggerRadii.add(round(Number(value), 6))
        }
        if (target === String(root.fileId) && /^m_LocalScale\.[xyz]$/.test(prop)) {
          scale[prop.slice(-1)] = round(Number(value), 6)
        }
      }
      const s = [scale.x ?? 1, scale.y ?? 1, scale.z ?? 1]
      if (s.some((v) => v !== 1)) {
        const key = s.join(',')
        scaled.set(key, (scaled.get(key) ?? 0) + 1)
      }
    }
    for (const [key, count] of scaled) {
      rootScaleOverrides.push({ scene, count, scale: key.split(',').map(Number) })
    }
  }
  if (sceneArtOverrides.length) {
    warn(
      `${relPath}: ${sceneArtOverrides.length} shipped-scene modification(s) touch the orb's art; ` +
        'the prefab values are not the whole story',
    )
  }

  return {
    prefab: relPath,
    art: put('props.energyOrb.art', {
      value: {
        name: String(go?.data?.m_Name ?? ''),
        live,
        mesh: meshPath,
        meshFileId,
        meshNode,
        meshImport,
        material: MAT,
        position: [num(p?.x), num(p?.y), num(p?.z)],
        rotation: [num(r?.x), num(r?.y), num(r?.z), num(r?.w, 1)],
        scale: [num(sc?.x, 1), num(sc?.y, 1), num(sc?.z, 1)],
      },
      unit: 'm',
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${relPath} GameObject "${String(go?.data?.m_Name ?? '')}" Transform + MeshFilter.m_Mesh + MeshRenderer.m_Materials`,
      fileId: go ? String(go.fileId) : null,
      line: tf ? lineOf(asset, tf.fileId, 'm_LocalScale') : null,
      note:
        'UNITY SPACE, local to the orb root, which the level JSON places per instance. The mesh ' +
        "is referenced as a MESH (fileID 4300000), not as the FBX's model, so the node's own Lcl " +
        'Scaling in the file (15.2987) never reaches the screen: the ball is the mesh times this ' +
        'scale. The same scale sizes the 3 m trigger, which is why the collection sphere is 4.885 m.',
    }),
    triggerRadius: put('props.energyOrb.triggerRadius', {
      value: num(trigger?.data?.m_Radius, null),
      unit: 'm',
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${relPath} SphereCollider on "${String(go?.data?.m_Name ?? '')}" m_Radius`,
      fileId: trigger ? String(trigger.fileId) : null,
      line: trigger ? lineOf(asset, trigger.fileId, 'm_Radius') : null,
      note:
        "LOCAL to the art node: the world collection radius is this times the art's largest scale " +
        'component, which is what `game/orbs.ts` computes. `Trigger_EnergyOrb` is on the same node.',
    }),
    color: put('props.energyOrb.color', {
      value: colour?.value ?? null,
      unit: null,
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${MAT} m_Colors _Color`,
      fileId: '2100000',
      line: colour?.line ?? null,
      note:
        `sRGB [r, g, b, a], read from the raw YAML (${colour?.dialect ?? '?'} dialect). Pale green. ` +
        'The shader is Opaque, so the 0.843 alpha never blends.',
    }),
    glowColor: put('props.energyOrb.glowColor', {
      value: glowColour?.value ?? null,
      unit: null,
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${MAT} m_Colors _GlowColor`,
      fileId: '2100000',
      line: glowColour?.line ?? null,
      note: `sRGB, raw YAML (${glowColour?.dialect ?? '?'} dialect). The emission's colour; within 0.2% of _Color.`,
    }),
    glowStrength: put('props.energyOrb.glowStrength', {
      value: glowStrength?.value ?? null,
      unit: null,
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${MAT} m_Floats _GlowStrength`,
      fileId: '2100000',
      line: glowStrength?.line ?? null,
      note: '`glow.rgb *= _GlowStrength` in MarmosetSurf.cginc: the emission multiplier.',
    }),
    emissionLM: emissionLM?.value ?? null,
    blends: materialBlends(MAT),
    shader,
    shaderRenderType,
    shaderIsThirdParty: true,
    // Receipts: the parser's own answer on this file (null on the old dialect,
    // DEV-043), and which dialect the raw reads found.
    materialDialect: colour?.dialect ?? null,
    parserSawColour: parsedMaterialColour(MAT, '_Color') !== null,
    // A Unity Halo is an ENGINE feature, not an asset: recorded, NOT ported —
    // the same call DEV-322 made for the anti-grav wing's glowyBits.
    halo: halo
      ? {
          enabled: num(halo.data?.m_Enabled) === 1,
          color: [byte(0), byte(8), byte(16), byte(24)],
          size: num(halo.data?.m_Size, null),
        }
      : null,
    // The root's sparkles. Recorded, NOT ported (DEV-327).
    particles: scanParticleSystems(relPath),
    sceneInstances,
    sceneArtOverrides,
    sceneTriggerRadii: [...sceneTriggerRadii].sort((a, b) => a - b),
    rootScaleOverrides,
  }
}

/**
 * The ghost racer's engine trail — the one TrailRenderer in the shipped game.
 *
 * Matt: *"it'd be nice to get the vfx trail from the ghost/ai engines we used to
 * have (helped players see the ai jets)."* That is exactly what it is for, and
 * the asymmetry is the evidence: `PlayerShip_SR14_Photon.prefab` has NO
 * TrailRenderer. Only `GhostRacer.prefab` does. The trail was never a jet
 * effect, it was a read on where the opposition is.
 *
 * Three things here are easy to get wrong:
 *
 *  1. **It is OPAQUE.** The material is `glowyMaterial.mat` — the SAME material
 *     as the checkpoint ring's studs — on `Marmoset/Self-Illumin/Specular IBL`,
 *     whose SubShader declares `"Queue"="Geometry" "RenderType"="Opaque"`. So
 *     `_Color`'s 0.891 alpha never blended, and neither did the descending
 *     alphas in `m_Colors` below. A port that fades the trail out is inventing
 *     a fade the 2016 build did not draw.
 *
 *  2. **`m_Colors` is five Unity `Color32`s packed as one uint32 each, r in the
 *     LOW byte.** Decoded here rather than in the game, because a byte order
 *     read backwards produces a plausible colour and no error.
 *
 *  3. **The two transforms in the chain cancel.** `trails` sits at local
 *     (-2.827, 1.503, 0.002) under `GhostRider_01`, and each carries a ~90 deg
 *     yaw that is the exact inverse of the other. Composed, the trail is at
 *     (0, 0.573, -5.650) from the ship root with IDENTITY rotation — dead on
 *     the centreline, 5.65 m back, 1.8 m forward of the tail of the ship's own
 *     11.45 m capsule. The chain is emitted rather than the composition so the
 *     game composes it with the same `chain()` the rings use.
 */
function extractGhostTrail() {
  const relPath = 'Assets/Faceted Flight/Prefabs/legacy_root_prefabs/PreFabs/GhostRacer.prefab'
  const MATERIAL = 'Assets/Faceted Flight/Materials/glowyMaterial.mat'
  if (!unityExists(relPath)) return null
  const asset = loadAsset(relPath)

  const doc = asset.docs.find((d) => d.classId === 96)
  if (!doc) {
    warn(`${relPath}: no TrailRenderer (class 96) — the ghost trail cannot be extracted`)
    return null
  }
  const goId = String(doc.data?.m_GameObject?.fileID ?? '0')
  const go = asset.byId.get(goId)

  const transform = transformOfGo(asset.byId, go) ?? null

  // ── the liveness walk ──────────────────────────────────────────────────
  //
  // Same walk the rings and the particles get. A TrailRenderer with
  // `m_Enabled: 1` under a branch its grandparent switched off draws nothing,
  // and the component alone gives no hint of that.
  const upAll = transform ? chainUp(asset.byId, transform, { includeSelf: false }).nodes : []
  const nodes = []
  for (const n of upAll) {
    if (n.transform.classId !== 4) break
    nodes.push(n)
  }
  const ancestors = nodes.map((n) => ({ name: nameOfGo(n.go), active: n.active === 1 }))
  const live = activeOf(go) === 1 && num(doc.data?.m_Enabled) === 1 && chainIsLive(nodes)
  // The chain stops AT the prefab root, whose pose is the racer's own world placement: the game
  // supplies that, not this chain. So the root (the node whose father is 0) is an ancestor for
  // the liveness walk and NOT a pivot. Root-most pivot first.
  const pivots = nodes
    .filter((n) => n.fatherId !== '0')
    .map((n) => {
      const p = n.transform.data?.m_LocalPosition
      const r = n.transform.data?.m_LocalRotation
      const sc = n.transform.data?.m_LocalScale
      return {
        position: [num(p?.x) ?? 0, num(p?.y) ?? 0, num(p?.z) ?? 0].map((v) => round(v, 6)),
        rotation: [num(r?.x) ?? 0, num(r?.y) ?? 0, num(r?.z) ?? 0, num(r?.w) ?? 1].map((v) =>
          round(v, 6),
        ),
        scale: [num(sc?.x) ?? 1, num(sc?.y) ?? 1, num(sc?.z) ?? 1].map((v) => round(v, 6)),
      }
    })
    .reverse()

  // ── the five colour stops, read from the RAW YAML ──────────────────────
  //
  // `unity_yaml.js` returns `{}` for `m_Colors`: the stops are keyed
  // `m_Color[0]` .. `m_Color[4]`, each a nested map, and the loader does not
  // carry that shape. We do not own `tools/prototype/`, so the bytes are read
  // directly here rather than by widening a parser four other extractors
  // depend on.
  //
  // Unity `Color32` packs r in the LOW byte of the uint32. Read the other way
  // round every colour is still a plausible colour and nothing errors, so the
  // decode is asserted in `tests/unit/ghost-trail.test.ts` against the head
  // stop, which is a near-white (240, 253, 255) and would be a saturated blue
  // if the order were wrong.
  const colors = []
  {
    const lines = unityRead(relPath).split(/\r?\n/)
    const bound = scanDocuments(lines).find(
      (b) => b.classId === 96 && b.fileId === String(doc.fileId),
    )
    const block = bound ? lines.slice(bound.start, bound.end).join('\n') : ''
    for (let i = 0; i < 5; i++) {
      const m = block.match(new RegExp(`m_Color\\[${i}\\]:[\\s\\S]{0,200}?rgba:\\s*(\\d+)`))
      if (!m) break
      const v = Number(m[1]) >>> 0
      colors.push([
        round((v & 0xff) / 255, 6),
        round(((v >>> 8) & 0xff) / 255, 6),
        round(((v >>> 16) & 0xff) / 255, 6),
        round(((v >>> 24) & 0xff) / 255, 6),
      ])
    }
  }
  if (colors.length !== 5) {
    warn(`${relPath}: TrailRenderer has ${colors.length} colour stops, expected 5`)
  }

  const local = transform?.data
  return {
    live: put('props.ghostTrail.live', {
      value: live,
      unit: null,
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${relPath} TrailRenderer on GameObject "${String(go?.data?.m_Name ?? '')}"`,
      fileId: null,
      line: null,
      note:
        'The full liveness walk: the component enabled, its GameObject active, and every ' +
        `ancestor active (${ancestors.map((a) => `${a.name}=${a.active ? 1 : 0}`).join(', ')}).`,
    }),
    ancestors,
    seconds: put('props.ghostTrail.seconds', {
      value: num(doc.data?.m_Time),
      unit: 's',
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${relPath} TrailRenderer.m_Time`,
      fileId: null,
      line: null,
      note: 'How long a point survives. 0.14 s at ~180 m/s is a ribbon about 25 m long.',
    }),
    startWidth: put('props.ghostTrail.startWidth', {
      value: num(doc.data?.m_StartWidth),
      unit: 'm',
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${relPath} TrailRenderer.m_StartWidth`,
      fileId: null,
      line: null,
      note: 'At the HEAD, where the trail meets the ship.',
    }),
    endWidth: put('props.ghostTrail.endWidth', {
      value: num(doc.data?.m_EndWidth),
      unit: 'm',
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${relPath} TrailRenderer.m_EndWidth`,
      fileId: null,
      line: null,
      note: 'At the TAIL. The ribbon tapers to a point rather than fading out.',
    }),
    minVertexDistance: put('props.ghostTrail.minVertexDistance', {
      value: num(doc.data?.m_MinVertexDistance),
      unit: 'm',
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${relPath} TrailRenderer.m_MinVertexDistance`,
      fileId: null,
      line: null,
      note:
        'A point is only appended once the emitter has moved this far, so the ribbon keeps its ' +
        'SHAPE across frame rates even though its point count does not.',
    }),
    castShadows: num(doc.data?.m_CastShadows) === 1,
    autodestruct: num(doc.data?.m_Autodestruct) === 1,
    colors: put('props.ghostTrail.colors', {
      value: colors,
      unit: null,
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${relPath} TrailRenderer.m_Colors`,
      fileId: null,
      line: null,
      note:
        'Five stops, [0] at the head, decoded from Unity Color32 with r in the LOW byte. ' +
        'The alphas run 255, 122, 192, 69, 14 — non-monotonic, and IGNORED: the material is ' +
        'opaque. Kept because they are what shipped, not because they blend.',
    }),
    pivots: put('props.ghostTrail.pivots', {
      value: pivots,
      unit: null,
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${relPath} Transform.m_Father chain above the TrailRenderer`,
      fileId: null,
      line: null,
      note:
        'UNITY SPACE, OUTERMOST FIRST. Compose ship x pivots[0] x ... x local. The two yaws in ' +
        'here are exact inverses, so the composition is (0, 0.573, -5.650) with identity ' +
        'rotation — but composing it by hand is how a 5.65 m offset becomes a 2.83 m one.',
    }),
    local: put('props.ghostTrail.local', {
      value: {
        position: [
          num(local?.m_LocalPosition?.x),
          num(local?.m_LocalPosition?.y),
          num(local?.m_LocalPosition?.z),
        ].map((v) => round(v, 6)),
        rotation: [
          num(local?.m_LocalRotation?.x),
          num(local?.m_LocalRotation?.y),
          num(local?.m_LocalRotation?.z),
          num(local?.m_LocalRotation?.w, 1),
        ].map((v) => round(v, 6)),
        scale: [
          num(local?.m_LocalScale?.x, 1),
          num(local?.m_LocalScale?.y, 1),
          num(local?.m_LocalScale?.z, 1),
        ].map((v) => round(v, 6)),
      },
      unit: 'm',
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${relPath} Transform of "${String(go?.data?.m_Name ?? '')}"`,
      fileId: null,
      line: null,
      note: 'UNITY SPACE. The innermost link of the chain above.',
    }),
    // The material is `glowyMaterial.mat`, byte for byte the one the ring studs
    // wear — which is why the trail reads as the same cyan-white as the gates.
    color: materialColour(MATERIAL, '_Color'),
    glowColor: materialColour(MATERIAL, '_GlowColor'),
    glowStrength: materialFloat(MATERIAL, '_GlowStrength'),
    emissionColor: materialColour(MATERIAL, '_EmissionColor'),
    specColor: materialColour(MATERIAL, '_SpecColor'),
    specular: {
      intensity: materialFloat(MATERIAL, '_SpecInt'),
      shininess: materialFloat(MATERIAL, '_Shininess'),
      fresnel: materialFloat(MATERIAL, '_Fresnel'),
    },
    blends: materialBlends(MATERIAL),
    material: MATERIAL,
    shader: 'Assets/Marmoset/Shader/Illumin/Marmoset Specular IBL.shader',
    shaderIsThirdParty: true,
  }
}

/**
 * Terrains that are NOT an environment, but are still `FacetedTerrain`.
 *
 * There is one: the alpine valley you stand in on the TITLE SCREEN.
 * `main_menu.unity` instantiates `Prefabs/Menus/AlpineTerrain_menu.prefab`, and
 * that prefab carries a `FacetedTerrain` with its own maps and parameters — so
 * 2016's title screen is this port's own generator with a different heightmap,
 * not a bought environment. (Of the 194 guids `main_menu.unity` references, 177
 * resolve and nine are Polyworld.)
 *
 * It has no environment scene and no mission, so the loop below is told where
 * to look explicitly rather than deriving paths from a `levelArt` name.
 */
function nonEnvironmentTerrains() {
  const prefab = 'Assets/Faceted Flight/Prefabs/Menus/AlpineTerrain_menu.prefab'
  if (!unityExists(prefab)) {
    warn(`menu: ${prefab} is missing from this backup; the title valley will not be extracted`)
    return []
  }
  return [
    {
      environment: 'menu',
      levelArt: 'AlpineTerrain_menu',
      missions: [],
      sourcePrefab: prefab,
      // No environment scene, and no Skyshop IBL: the menu lights itself.
      sourceScene: null,
      skipIbl: true,
    },
  ]
}

function extractTerrain(perScene) {
  const out = {}
  for (const env of [...shippedEnvironments(perScene), ...nonEnvironmentTerrains()]) {
    const prefabRel =
      env.sourcePrefab ?? `Assets/Faceted Flight/Prefabs/Levels/${env.levelArt}.prefab`
    const sceneRel =
      env.sourceScene === null
        ? null
        : (env.sourceScene ?? `Assets/Faceted Flight/Scenes/environments/${env.levelArt}.unity`)
    if (sceneRel !== null && !unityExists(sceneRel)) {
      warn(`${env.environment}: environment scene ${sceneRel} is missing from this backup`)
      continue
    }

    const sceneScan = sceneRel === null ? { instances: [] } : scanFacetedTerrain(sceneRel)
    const prefabScan =
      unityExists(prefabRel) && scanFacetedTerrain(prefabRel).instances.length > 0
        ? scanFacetedTerrain(prefabRel)
        : null

    // The SCENE is what LoadLevelArt loads, so if it carries the components itself that IS the
    // shipped copy — Alpine and Kauai both do. Only when it does not (Desert, Simonet: the scene is
    // a few KB and instantiates the level-art prefab) does the prefab become the source.
    const fromScene = sceneScan.instances.length > 0
    const asset = fromScene ? sceneScan : prefabScan
    const sourceRel = fromScene ? sceneRel : prefabRel
    const origin = fromScene ? 'scene-component' : 'shipped-prefab'
    if (!asset || asset.instances.length === 0) {
      warn(
        `${env.environment}: no FacetedTerrain component in ${sceneRel ?? '(no scene)'} or ${prefabRel}`,
      )
      continue
    }

    const record = {
      environment: env.environment,
      levelArt: env.levelArt,
      missions: env.missions,
      source: sourceRel,
      sourceGuid: pathToGuid.get(sourceRel) ?? null,
      origin,
      // The Skyshop IBL, which is where this environment's ambient light actually comes from —
      // the terrain material is a Marmoset shader and takes no Unity ambient at all.
      ibl: env.skipIbl ? null : extractIbl(env, prefabRel, sceneRel, env.missions, sourceRel),
      terrains: {},
    }

    const seen = new Set()
    for (const inst of asset.instances) {
      const heightRef = inst.data.SourceHeightMap
      const colourRef = inst.data.SourceColorMap
      const heightGuid = heightRef?.guid ? String(heightRef.guid) : null
      const colourGuid = colourRef?.guid ? String(colourRef.guid) : null
      const heightPath = heightGuid ? resolveGuid(heightGuid) : null
      const colourPath = colourGuid ? resolveGuid(colourGuid) : null

      let leaf = terrainLeafName(heightPath, env.environment, inst.fileId)
      if (seen.has(leaf)) {
        warn(
          `${sourceRel}#${inst.fileId}: two FacetedTerrain instances name themselves "${env.environment}.${leaf}"; disambiguating by fileID`,
        )
        leaf = `${leaf}_${inst.fileId}`
      }
      seen.add(leaf)
      inst.leaf = leaf

      const prefix = `terrain.${env.environment}.${leaf}`
      const src = (field) => `${sourceRel}#${inst.fileId} FacetedTerrain.${field}`
      const t = { key: `${env.environment}.${leaf}`, gameObject: inst.gameObject }

      t.componentEnabled = put(`${prefix}.componentEnabled`, {
        value: num(inst.data.m_Enabled) === 1,
        unit: null,
        trust: 'verified',
        origin,
        source: src('m_Enabled'),
        fileId: inst.fileId,
        line: lineOf(asset, inst.fileId, 'm_Enabled'),
      })

      for (const [name, ykey, unit] of TERRAIN_FIELDS) {
        if (inst.data[ykey] === undefined) {
          warn(`${sourceRel}#${inst.fileId}: FacetedTerrain has no serialized ${ykey}`)
          t[name] = null
          continue
        }
        t[name] = put(`${prefix}.${name}`, {
          value: num(inst.data[ykey]),
          unit,
          trust: 'verified',
          origin,
          source: src(ykey),
          fileId: inst.fileId,
          line: lineOf(asset, inst.fileId, ykey),
          note: TERRAIN_FIELD_NOTES[name] ?? null,
        })
      }

      t.sourceHeightMap = put(`${prefix}.sourceHeightMap`, {
        value: heightPath,
        unit: null,
        trust: 'verified',
        origin,
        source: src('SourceHeightMap'),
        fileId: inst.fileId,
        line: lineOf(asset, inst.fileId, 'SourceHeightMap'),
        note: `guid ${heightGuid ?? '(none)'}, resolved through the guid index. Greyscale; FacetedTerrain samples it with GetPixelBilinear and multiplies by TerrainHeight.`,
      })
      t.sourceColorMap = put(`${prefix}.sourceColorMap`, {
        value: colourPath,
        unit: null,
        trust: 'verified',
        origin,
        source: src('SourceColorMap'),
        fileId: inst.fileId,
        line: lineOf(asset, inst.fileId, 'SourceColorMap'),
        note: `guid ${colourGuid ?? '(none)'}, resolved through the guid index. Sampled once per TRIANGLE, at its barycentre — that single sample per face is the faceted look.`,
      })
      t.sourceHeightMapGuid = heightGuid
      t.sourceColorMapGuid = colourGuid

      // --- the material the chunks render with ---------------------------------------------------
      //
      // Needed because the faceted look is NOT "show the vertex colour". The
      // shipped shader is a vertex-colour variant of a LIT shader, and the
      // material carries a base tint that multiplies into every facet —
      // `FacetedTerrain.cs:154` reads `TerrainMaterial.GetColor("_Color")` into
      // `_MaterialBaseColor` and pushes it through MaterialPropertyBlocks
      // during LOD fades, so the tint is load-bearing in the generator too, not
      // just in the renderer.
      //
      // The shader itself is third-party (Marmoset Skyshop / VacuumShaders) and
      // cannot ship — see content/MANIFEST.md. What travels is the shader's
      // PATH, as evidence of what has to be matched by eye, plus the numbers.
      t.material = extractTerrainMaterial(prefix, inst, src, asset, origin)

      // --- the waves, for whichever terrain is the water ----------------------------------------
      //
      // Matched by GameObject name rather than by terrain key: the driver is a
      // component on the same object the FacetedTerrain sits on, and which of an
      // environment's terrains is "the water" is a fact read off the scene, not
      // a guess from the key. Null on every land terrain, which is correct — the
      // islands have no wave driver.
      const waveDrivers = scanWaterDisplace(sourceRel) ?? []
      const wave = waveDrivers.find((w) => w.gameObject === inst.gameObject) ?? null
      t.displace = put(`${prefix}.displace`, {
        value: wave,
        unit: null,
        // Verified either way. A land terrain having NO wave driver is a fact
        // read off the scene, not an assumption — the scan looked and found
        // none, which is exactly as checked as finding one.
        trust: 'verified',
        origin,
        source: wave
          ? `${sourceRel}#${wave.fileId} LowPoly_Displace (public fields, which Update() writes into the material every frame)`
          : `${sourceRel}: no LowPoly_Displace on "${inst.gameObject}"`,
        fileId: wave?.fileId ?? null,
        line: null,
        note:
          'The COMPONENT wins: LowPoly_Displace.Update() overwrites the five material ' +
          '_Displace* floats every frame from these fields, and it is the only thing that sets ' +
          '_V_LP_Time — which _DisplaceScriptSynchronize: 1 makes the shader use instead of ' +
          '_Time.x. No live component, no moving water. `_DisplaceStrength` is NOT part of this: ' +
          'Core.cginc only reads it in the V_LP_DISPLACE_TEXTURE branch and this material is ' +
          'V_LP_DISPLACE_PARAMETRIC.',
      })

      // --- where the mesh actually sits ----------------------------------------------------------
      const tr = inst.transform
      if (inst.ancestorRigid === false) {
        warn(
          `${prefix}: an ancestor between ${inst.gameObject} and ${
            inst.ancestorStop ?? 'the file root'
          } is rotated or scaled, so transform.envRoot is a sum that does not compose. ` +
            'A consumer adding envRoot + position will misplace this terrain.',
        )
      }
      const v3 = (v, d) => (v ? [num(v.x) ?? d, num(v.y) ?? d, num(v.z) ?? d] : [d, d, d])
      t.transform = {
        // UNITY coordinates, matching the mesh the generator emits. Converting
        // to three space is the renderer's job and is done once, for the mesh
        // and this offset together — doing it in two places is how a world ends
        // up mirrored relative to its own content.
        position: put(`${prefix}.transform.position`, {
          value: v3(tr?.position, 0),
          unit: 'm',
          trust: tr ? 'verified' : 'unverified',
          origin,
          source: src('Transform.m_LocalPosition'),
          fileId: tr?.fileId ?? inst.fileId,
          line: null,
          note:
            'Local to the LevelArt prefab root. ' +
            'WARNING: this used to add "which the environment scene instantiates at the ' +
            'origin with no overrides (checked)", and that is FALSE for kauai. ' +
            '`LevelArt_Kauai` is an UNPACKED copy sitting at (-2218, 0, -1691) under ' +
            '`levelOffset`, so kauai placed as `worldOffset + this` lands 2,218 m / 1,691 m ' +
            'from where 2016 has it. Measured through the flattener, which composes the whole ' +
            'chain: kauai terrain world (-4266, 68, -3739) against this local (0, 68, 0), and ' +
            'kauai water world (-19215, -46.08, -17431) against local (-14949, -46.08, -13692) ' +
            '- the SAME (-4266, 0, -3739) on both, of which (-2048, 0, -2048) is levelOffset ' +
            'and the remaining (-2218, 0, -1691) is the env root nothing records. ' +
            'alpine and desert really are zero here, which is why "(checked)" survived: it was ' +
            'checked where the wrong answer and the right one agree. ' +
            'DO NOT load a second environment on this field alone until the env root is ' +
            'extracted - see docs/NEXT.md.',
        }),
        // Everything between the terrain's own transform and `levelOffset`.
        // Zero for simonet, alpine and desert; (-2218, 0, -1691) for kauai,
        // whose LevelArt root is an unpacked copy the scene moved. A consumer
        // must add BOTH this and the level's `worldOffset` — see the note above.
        envRoot: put(`${prefix}.transform.envRoot`, {
          value: [
            round(inst.ancestorOffset?.x ?? 0, 6),
            round(inst.ancestorOffset?.y ?? 0, 6),
            round(inst.ancestorOffset?.z ?? 0, 6),
          ],
          unit: 'm',
          trust: 'verified',
          origin,
          source: `${sourceRel}: father chain above ${inst.gameObject}, summed to ${
            inst.ancestorStop ?? 'the file root'
          }`,
          fileId: tr?.fileId ?? inst.fileId,
          line: null,
          note: (inst.ancestors ?? []).length
            ? `Ancestors: ${(inst.ancestors ?? [])
                .map(
                  (a) =>
                    `${a.name ?? '?'}${JSON.stringify(a.localPosition)}${
                      a.rigid
                        ? ''
                        : ` ROTATED/SCALED q=${JSON.stringify(a.localRotation)} s=${JSON.stringify(a.localScale)}`
                    }`,
                )
                .join(' < ')}.`
            : 'No ancestors between this terrain and the file root.',
        }),
        // Whether `envRoot + position` is EXACT, rather than merely a sum of
        // numbers that happen to be on the same chain. See the walk.
        envRootRigid: put(`${prefix}.transform.envRootRigid`, {
          value: inst.ancestorRigid !== false,
          unit: null,
          trust: 'verified',
          origin,
          source: `${sourceRel}: m_LocalRotation and m_LocalScale of every counted father above ${inst.gameObject}`,
          fileId: tr?.fileId ?? inst.fileId,
          line: null,
          note:
            'TRUE when every ancestor between this terrain and ' +
            `${inst.ancestorStop ?? 'the file root'} is unrotated and unit-scaled, which is what ` +
            'makes the VECTOR SUM in `envRoot` equal to composing the chain as matrices. All five ' +
            'shipped environments are rigid, so the two readings agree everywhere they can be ' +
            'compared today — which is exactly the condition under which a placement rule goes ' +
            'unnoticed for a day (DEV-042, DEV-047). FALSE means a three-vector cannot express ' +
            "this terrain's placement and `envRoot` must not be added to anything. Note the " +
            "STOP node is excluded on purpose: `AlpineTerrain_menu`'s own prefab root IS " +
            'rotated, and it is not counted.',
        }),
        scale: put(`${prefix}.transform.scale`, {
          value: v3(tr?.scale, 1),
          unit: null,
          trust: tr ? 'verified' : 'unverified',
          origin,
          source: src('Transform.m_LocalScale'),
          fileId: tr?.fileId ?? inst.fileId,
          line: null,
          note: 'NOT always 1. The Simonet ocean plate is (8, 1, 8) — a 32768 m terrain stretched to 262 km.',
        }),
        rotation: v3(tr?.rotation, 0).concat([num(tr?.rotation?.w) ?? 1]),
      }

      // --- derived, from this instance's own fields ---------------------------------------------
      const size = t.terrainSize
      const chunk = t.chunkSize
      const base = t.baseResolution
      if (chunk > 0 && size % chunk !== 0) {
        warn(`${prefix}: TerrainSize ${size} is not a whole number of ${chunk} m chunks`)
      }
      if (base > 0 && chunk % base !== 0) {
        warn(`${prefix}: ChunkSize ${chunk} is not a whole number of ${base} m quads`)
      }
      t.chunkPerSide = put(`${prefix}.chunkPerSide`, {
        value: Math.trunc(size / chunk),
        unit: null,
        trust: 'derived',
        origin: 'computed',
        source: `${prefix}.terrainSize / ${prefix}.chunkSize`,
        fileId: inst.fileId,
        line: lineOf(asset, inst.fileId, 'ChunkSize'),
        formula: 'chunkPerSide = TerrainSize / ChunkSize   [FacetedTerrain.cs:105, :422]',
        note: `${Math.trunc(size / chunk)} x ${Math.trunc(size / chunk)} chunks, each ${chunk} m across.`,
      })
      t.quadPerChunk = put(`${prefix}.quadPerChunk`, {
        value: Math.trunc(chunk / base),
        unit: null,
        trust: 'derived',
        origin: 'computed',
        source: `${prefix}.chunkSize / ${prefix}.baseResolution`,
        fileId: inst.fileId,
        line: lineOf(asset, inst.fileId, 'BaseResolution'),
        formula: 'quadPerChunk = ChunkSize / BaseResolution   [FacetedTerrain.cs:419]',
        note: 'Integer division, at LOD 0. Each further LOD halves it (FacetedTerrain.cs:445).',
      })

      record.terrains[leaf] = t
    }

    // A cross-check compares the scene's copy against the prefab's. With no
    // scene there is nothing to compare, and the menu terrain has no scene.
    record.crossCheck =
      sceneRel === null ? null : crossCheckEnvironment(sceneRel, sceneScan, prefabRel, prefabScan)
    out[env.environment] = record
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// 13. main
// ---------------------------------------------------------------------------------------------

function main() {
  const t0 = Date.now()
  const model = {
    world: {},
    boundary: {},
    launch: {},
    fade: {},
    hoverjet: {},
    jumpseat: {},
    terrain: {},
    derived: {},
    structural: {},
  }

  // --- world -----------------------------------------------------------------------------------
  model.world = extractWorld()

  // --- shipped scenes -> Level.ShipPrefab ------------------------------------------------------
  const scenes = shippedSceneList()
  const missionScenes = scenes.filter((s) => s.enabled && classifyScene(s.path) === 'mission')
  const multiplayerScenes = scenes.filter(
    (s) => s.enabled && classifyScene(s.path) === 'multiplayer',
  )

  // First pass: what prefab does each shipped mission scene actually instantiate?
  const perScene = []
  for (const s of [...missionScenes, ...multiplayerScenes]) {
    const scan = scanSceneCheap(s.path)
    if (scan.levels.length !== 1 && classifyScene(s.path) === 'mission') {
      warn(`${s.path}: expected exactly 1 Level MonoBehaviour, found ${scan.levels.length}`)
    }
    const lvl = scan.levels[0]
    const ref = lvl?.data?.ShipPrefab
    const guid = ref?.guid ? String(ref.guid) : null
    const prefabPath = guid ? resolveGuid(guid) : null
    if (guid) SHIP_PREFAB_GUIDS.add(guid)
    const boundary = scan.boundaries[0] ?? null
    // Which environment's level art does this mission additively load? One LoadLevelArt per scene;
    // more than one would mean two environments in one mission, which is worth hearing about.
    if (scan.levelArts.length > 1 && classifyScene(s.path) === 'mission') {
      warn(`${s.path}: expected at most 1 LoadLevelArt, found ${scan.levelArts.length}`)
    }
    const levelArt = scan.levelArts[0] ?? null
    const levelArtName = levelArt?.data?.levelName ? String(levelArt.data.levelName) : null
    perScene.push({
      scene: s.path,
      kind: classifyScene(s.path),
      environment: levelArtName ? (ENVIRONMENT_ID[levelArtName] ?? null) : null,
      environmentScene: levelArtName,
      environmentSceneFileId: levelArt ? String(levelArt.fileId) : null,
      environmentSceneLine: levelArt?.line ?? null,
      levelFileId: lvl ? String(lvl.fileId) : null,
      levelLine: lvl?.line ?? null,
      shipPrefabGuid: guid,
      shipPrefabPath: prefabPath,
      shipPrefabFileId: ref?.fileID === undefined ? null : String(ref.fileID),
      forceGameMode: lvl?.data?.ForceGameMode === undefined ? null : num(lvl.data.ForceGameMode),
      forcedGameMode: lvl?.data?.ForcedGameMode === undefined ? null : num(lvl.data.ForcedGameMode),
      startShipSystems:
        lvl?.data?.StartShipSystems === undefined ? null : num(lvl.data.StartShipSystems),
      playerBoundary: boundary
        ? {
            fileId: String(boundary.fileId),
            line: boundary.line,
            enabled: num(boundary.data.m_Enabled) === 1,
            resetDelay:
              boundary.data.resetDelay === undefined ? null : num(boundary.data.resetDelay),
          }
        : null,
    })
  }
  perScene.sort((a, b) => (a.scene < b.scene ? -1 : 1))

  // Second pass: prove no shipped scene instantiates a player-ship prefab at EDIT time (which is
  // the only way a per-scene m_Modifications block could override vehicle physics).
  const sceneInstanceOverrides = []
  for (const s of [...missionScenes, ...multiplayerScenes]) {
    const scan = scanSceneCheap(s.path)
    for (const inst of scan.shipPrefabInstances) {
      const mods = modificationsOf(inst)
      const rows = mods
        .map((m) => ({
          propertyPath: modPath(m),
          value: modValue(m.value),
          targetFileId: modTargetOrNull(m),
          harmless: HARMLESS_MODIFICATION_RE.test(modPath(m)),
        }))
        .sort((a, b) =>
          `${a.propertyPath} ${a.targetFileId}` < `${b.propertyPath} ${b.targetFileId}` ? -1 : 1,
        )
      const activeMod = mods.find((m) => modPath(m) === 'm_IsActive')
      sceneInstanceOverrides.push({
        scene: s.path,
        sceneKind: classifyScene(s.path),
        prefabGuid: inst.guid,
        prefabPath: resolveGuid(inst.guid),
        fileId: String(inst.fileId),
        line: inst.line,
        // An edit-time instance with m_IsActive: 0 is dormant editor residue, not the flying ship:
        // Level.InstantiatePlayerShip() spawns a fresh copy from Level.ShipPrefab at runtime.
        instanceActive: activeMod ? num(activeMod.value) === 1 : true,
        modificationCount: mods.length,
        physicsRelevantModifications: rows.filter((r) => !r.harmless),
        modifications: rows,
      })
    }
  }

  model.structural.scenes = perScene
  model.boundary = extractBoundary(perScene)
  // The launch reveal: one number, and the census that proves it is one number. See 13b.
  const launch = extractLaunchReveal(perScene)
  model.launch = launch ? launch.sheet : null
  model.structural.launchReveal = launch ? launch.structural : null
  // The screen fade: the two durations, and the census of which one a mission actually runs. 13c.
  const screenFade = extractScreenFade(perScene, scenes)
  model.fade = screenFade ? screenFade.sheet : null
  model.structural.screenFade = screenFade ? screenFade.structural : null
  model.structural.sceneShipPrefabInstances = sceneInstanceOverrides
  model.structural.shipPrefabsUsedByMissions = [
    ...new Set(perScene.filter((p) => p.kind === 'mission').map((p) => p.shipPrefabPath ?? '?')),
  ].sort()
  model.structural.shipPrefabsUsedByMultiplayer = [
    ...new Set(
      perScene.filter((p) => p.kind === 'multiplayer').map((p) => p.shipPrefabPath ?? '?'),
    ),
  ].sort()

  // --- the two vehicles ------------------------------------------------------------------------
  const HOVERJET_PREFAB = 'Assets/Faceted Flight/Resources/PlayerShip_SR14_Photon.prefab'
  const JUMPSEAT_PREFAB = 'Assets/Faceted Flight/Resources/JumpSeat_Photon.prefab'

  assertPrefabIsTheOneMissionsUse(perScene, 'hoverJet', HOVERJET_PREFAB)
  assertPrefabIsTheOneMissionsUse(perScene, 'jumpSeat', JUMPSEAT_PREFAB)

  model.hoverjet = extractHoverJet(HOVERJET_PREFAB)
  model.jumpseat = extractJumpSeat(JUMPSEAT_PREFAB)
  model.structural.decoyComparison = extractDecoyComparison(
    HOVERJET_PREFAB,
    'Assets/Faceted Flight/Resources/PlayerShip_SR14_unet.prefab',
  )

  // --- the four shipped environments -----------------------------------------------------------
  model.terrain = extractTerrain(perScene)
  model.props = {
    checkpointRing: extractCheckpointRing(),
    energyOrb: extractEnergyOrb(missionScenes.map((s) => s.path)),
    finishGate: extractFinishGate(),
    turnIndicator: extractTurnIndicator(),
    jumpPad: extractJumpPad(),
    ghostTrail: extractGhostTrail(),
    medals: extractMedals(),
    hangar: extractHangarLighting(),
  }
  // After the hangar: the launch room is placed from the level-select room's anchor (DEV-438).
  model.props.launchRoom = extractLaunchRoom(model.props.hangar)
  // And the room's two reflective materials, for 2016's specular ambient (DEV-439).
  if (model.props.hangar) model.props.hangar.specular = extractHangarSpecular()

  // --- derived ---------------------------------------------------------------------------------
  model.derived = extractDerived(model)

  // --- emit ------------------------------------------------------------------------------------
  const doc = buildDocument(model)

  if (OPT.print) {
    const e = entries.get(OPT.print)
    if (!e) die(`no such key: ${OPT.print}`)
    process.stdout.write(`${JSON.stringify(e, null, 2)}\n`)
    return
  }

  const json = `${stableStringify(doc)}\n`
  const sha = createHash('sha256').update(json, 'utf8').digest('hex')
  const ts = emitTypeScript(doc, sha)

  const files = [
    ['constants.generated.json', json],
    ['constants.generated.sha256', `${sha}  constants.generated.json\n`],
    ['constants.generated.ts', ts],
  ]

  let changed = false
  for (const [name, content] of files) {
    const p = path.join(OPT.out, name)
    const prev = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
    if (prev !== content) changed = true
    if (!OPT.check) {
      fs.mkdirSync(OPT.out, { recursive: true })
      fs.writeFileSync(p, content, 'utf8')
    }
  }

  report(model, doc, sha, Date.now() - t0, changed)

  if (OPT.check && changed) {
    process.stderr.write('\nconstants.mjs --check: output would change. Run `pnpm extract`.\n')
    process.exit(3)
  }
  if (doc.meta.errors.length > 0) {
    process.stderr.write('\nconstants.mjs: structural assertions FAILED (see above).\n')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------------------------
// 13b. The launch reveal — Trigger_EnableTerrain's height
//
// 2016 does not draw the environment while you are in the elevator shaft: the terrain GameObject
// is INACTIVE, and a trigger box part-way up the climb switches it on and the shaft off. That box's
// height is the one number the port needs, and it was hand-typed in render/elevator.ts for four
// sessions (DEV-094 §6 flagged it). This section promotes it.
//
// THE LIVENESS WALK IS WHAT MAKES IT ONE NUMBER. Taken naively, the thirteen shipped scenes carry
// the trigger at two different heights in two different frames — 100.4 m under `Position_adjustment`
// and 5.5 m under the rig root — which reads as "per-mission, put it in the level JSON". It is not:
// every copy at 5.5 is switched OFF, by `m_Enabled: 0` on the component or `m_IsActive: 0` on its
// GameObject. Of the seven rigs, FOUR carry a live trigger and all four say 100.4. DEV-074's lesson.
// ---------------------------------------------------------------------------------------------

const TRIGGER_ENABLE_TERRAIN_CS =
  'Assets/Faceted Flight/FF_WorldTour/scripts/Trigger_EnableTerrain.cs'
const TRIGGER_ENABLE_TERRAIN_GUID = pathToGuid.get(TRIGGER_ENABLE_TERRAIN_CS) ?? null

/**
 * The rig `rookie_01_hoverJet` instantiates, and the only shipped scene that instantiates ANY rig
 * as a live prefab instance. The other six materialise a disconnected copy, so hard rule 2's
 * scene -> prefab -> value -> m_Modifications trace runs through this one and the rest cross-check it.
 */
const LAUNCH_RIG_PREFAB = 'Assets/Faceted Flight/Prefabs/PlayerStart_ElevatorShaft_Photon_02.prefab'
/** Its predecessor. Every materialised trigger's `m_PrefabParentObject` points here. NOT a source. */
const LAUNCH_RIG_PREFAB_OLD =
  'Assets/Faceted Flight/Prefabs/PlayerStart_ElevatorShaft_Photon.prefab'

/**
 * The frame every launch number in this port is already expressed in.
 *
 * `Position_adjustment` is the node the room, the shaft and the elevator all hang from — it sits at
 * y -100 and `tools/extract/level.mjs` already authors `shaft.liveSegmentLocalY` against it. The
 * elevator's animated node rests at +1.32 in it and the clip drives that node 0 -> 106.647, so a
 * height in this frame is directly comparable with a rise. Anchoring on the rig ROOT instead would
 * be wrong: `rookie_02_hoverJet` has no rig-root node at all (its `Position_adjustment` hangs
 * straight off `levelOffset`), and `rookie_01_hoverJet`'s scene moves its root.
 */
const LAUNCH_FRAME = 'Position_adjustment'
/** The node the launch clip animates. Its rest height is what a `rise` of 0 means. */
const LAUNCH_ANIMATED_NODE = 'Elevator_animator'

/**
 * Two adjacent float32s, 8 um apart.
 *
 * `int_02_hoverJet` and the `_02` prefab write `100.4`; `adv_01_hoverJet` and
 * `rookie_02_hoverJet` write `100.399994`, one ulp below (an ulp at 100 is ~7.6e-6). Different
 * Unity saves of the same authored number, not a different number — so the agreement test is a
 * tolerance, and this is it, stated rather than hidden inside a `round()`.
 */
const LAUNCH_Y_EPSILON = 1e-4

/** Sum of `m_LocalPosition.y` from the named ancestor (exclusive) down to `transformDoc`. */
function localYUnder(asset, transformDoc, ancestorName) {
  const up = chainUp(asset.byId, transformDoc).nodes.reverse()
  const chain = up.map((n) => n.transform)
  const names = chain.map((d) => gameObjectName(asset, d))
  const activeChain = up.map((n) => n.active)
  const at = names.indexOf(ancestorName)
  if (at < 0) return { y: null, path: names, activeChain, anchored: false }
  let y = 0
  // A scale anywhere between the anchor and the node would make a plain sum of local Ys wrong.
  // It never is in the shipped rigs, but a silent sum is exactly how the terrain offset went wrong
  // for a day (DEV-042), so this is checked rather than assumed.
  let scaled = false
  for (let k = at; k < chain.length - 1; k++) {
    if (num(chain[k].data?.m_LocalScale?.y, 1) !== 1) scaled = true
  }
  for (let k = at + 1; k < chain.length; k++) y += num(chain[k].data?.m_LocalPosition?.y)
  return { y, path: names.slice(at), activeChain, anchored: true, parentScaled: scaled }
}

/** Every `Trigger_EnableTerrain` in an asset, with its GameObject, Transform and box. */
function enableTerrainTriggers(asset) {
  if (!TRIGGER_ENABLE_TERRAIN_GUID) return []
  const out = []
  for (const doc of asset.docs) {
    if (doc.type !== 'MonoBehaviour') continue
    if (String(doc.data?.m_Script?.guid ?? '') !== TRIGGER_ENABLE_TERRAIN_GUID) continue
    const go = asset.byId.get(String(doc.data?.m_GameObject?.fileID ?? '0'))
    if (!go) continue
    const comps = componentsOfGo(asset.byId, go)
    const tf = comps.find((c) => c.type === 'Transform')
    if (!tf) continue
    out.push({
      component: doc,
      gameObject: go,
      transform: tf,
      box: comps.find((c) => c.type === 'BoxCollider') ?? null,
      renderer: comps.find((c) => c.classId === 23) ?? null,
    })
  }
  return out
}

/**
 * One census row: where a scene's copy of the trigger sits, and whether it runs.
 *
 * `live` is the full walk — the component's own `m_Enabled`, AND `m_IsActive` on every GameObject
 * from the trigger up to the scene root. Reading only the component flag is the bug DEV-074 paid
 * for on `PlayerBoundary`, one deactivated parent away from the same wrong answer.
 */
function launchTriggerRow(label, asset, hit, extra = {}) {
  const frame = localYUnder(asset, hit.transform, LAUNCH_FRAME)
  const animGo = asset.docs.find(
    (d) => d.type === 'GameObject' && d.data?.m_Name === LAUNCH_ANIMATED_NODE,
  )
  let restY = null
  if (animGo) {
    const animTf = componentsOfGo(asset.byId, animGo).find((c) => c.type === 'Transform')
    if (animTf) restY = localYUnder(asset, animTf, LAUNCH_FRAME).y
  }
  const componentEnabled = num(hit.component.data?.m_Enabled, -1) === 1
  const chainActive = frame.activeChain.every((v) => v === 1)
  const parentRef = hit.transform.data?.m_PrefabParentObject?.guid
  return {
    ...extra,
    source: label,
    triggerGameObjectFileId: String(hit.gameObject.fileId),
    triggerTransformFileId: String(hit.transform.fileId),
    triggerComponentFileId: String(hit.component.fileId),
    /** Which rig prefab this copy descends from, for the two-generations story. */
    lineage: parentRef ? (resolveGuid(String(parentRef)) ?? `guid:${parentRef}`) : null,
    frame: frame.anchored
      ? LAUNCH_FRAME
      : `${frame.path[frame.path.length - 2] ?? 'root'} (no ${LAUNCH_FRAME} in the chain)`,
    localY: frame.y === null ? null : round(frame.y, 6),
    boxScaleY: round(num(hit.transform.data?.m_LocalScale?.y, 1), 7),
    boxIsTrigger: hit.box ? num(hit.box.data?.m_IsTrigger, -1) === 1 : null,
    boxSizeY: hit.box ? round(num(hit.box.data?.m_Size?.y, 1), 6) : null,
    boxCentreY: hit.box ? round(num(hit.box.data?.m_Center?.y, 0), 6) : null,
    rendererEnabled: hit.renderer ? num(hit.renderer.data?.m_Enabled, -1) === 1 : null,
    animatedNodeRestY: restY === null ? null : round(restY, 6),
    componentEnabled,
    isActiveChain: frame.activeChain,
    parentScaled: frame.parentScaled ?? null,
    live: componentEnabled && chainActive,
    /** `disabledUntilTriggered` — the TERRAIN half, null in every shipped scene. DEV-094 §2. */
    terrainWired: num(hit.component.data?.disabledUntilTriggered?.fileID, 0) !== 0,
    disableAfterTriggeredCount: (hit.component.data?.disableAfterTriggered ?? []).length,
  }
}

/**
 * The reveal height, and the census that proves it is one number rather than thirteen.
 *
 * Reads the value off `PlayerStart_ElevatorShaft_Photon_02.prefab` — the rig the one shipped scene
 * that instantiates a rig as a prefab instance uses, with that scene's `m_Modifications` checked —
 * and cross-checks it against every live materialised copy.
 */
function extractLaunchReveal(perScene) {
  if (!TRIGGER_ENABLE_TERRAIN_GUID) {
    warn(`${TRIGGER_ENABLE_TERRAIN_CS}: not in the guid index; no launch reveal extracted`)
    return null
  }
  if (!unityExists(LAUNCH_RIG_PREFAB)) {
    warn(`${LAUNCH_RIG_PREFAB}: not found; no launch reveal extracted`)
    return null
  }

  const prefab = loadAsset(LAUNCH_RIG_PREFAB)
  const prefabHits = enableTerrainTriggers(prefab)
  if (prefabHits.length !== 1) {
    warn(`${LAUNCH_RIG_PREFAB}: expected 1 Trigger_EnableTerrain, found ${prefabHits.length}`)
    return null
  }
  const primary = launchTriggerRow(LAUNCH_RIG_PREFAB, prefab, prefabHits[0], { scene: null })
  if (primary.localY === null) {
    warn(`${LAUNCH_RIG_PREFAB}: the trigger has no ${LAUNCH_FRAME} ancestor`)
    return null
  }

  // ── the census, over the thirteen shipped missions ────────────────────────────────────────────
  //
  // Two shapes, and the second one is invisible to a name grep (CLAUDE.md's stripped-prefab trap):
  // six rigs are materialised GameObjects in the scene, and `rookie_01_hoverJet`'s is a `1001`
  // prefab instance whose GameObject names live in the .prefab file, not in the scene.
  const rigGuids = new Map()
  for (const rel of [LAUNCH_RIG_PREFAB, LAUNCH_RIG_PREFAB_OLD]) {
    const g = pathToGuid.get(rel)
    if (g) rigGuids.set(g, rel)
  }
  const census = []
  for (const row of perScene.filter((p) => p.kind === 'mission')) {
    const text = unityRead(row.scene)
    const mentionsTrigger = text.includes(TRIGGER_ENABLE_TERRAIN_GUID)
    const mentionsRig = [...rigGuids.keys()].some((g) => text.includes(g))
    if (!mentionsTrigger && !mentionsRig) continue
    const scene = loadAsset(row.scene)
    for (const hit of enableTerrainTriggers(scene)) {
      census.push(
        launchTriggerRow(row.scene, scene, hit, { scene: row.scene, how: 'materialised' }),
      )
    }
    for (const inst of prefabInstances(scene.docs)) {
      const rel = rigGuids.get(parentGuidOf(inst))
      if (!rel) continue
      const rigAsset = rel === LAUNCH_RIG_PREFAB ? prefab : loadAsset(rel)
      const mods = modificationsOf(inst)
      for (const hit of enableTerrainTriggers(rigAsset)) {
        // CLAUDE.md rule 2: the prefab's value only ships if the SCENE does not override it. The
        // targets that could move this number are the trigger's own Transform and every ancestor
        // between it and the frame anchor.
        const chainIds = new Set([String(hit.transform.fileId)])
        let walk = hit.transform
        for (let guard = 0; walk && guard < 512; guard++) {
          chainIds.add(String(walk.fileId))
          const father = String(walk.data?.m_Father?.fileID ?? '0')
          if (father === '0' || gameObjectName(rigAsset, walk) === LAUNCH_FRAME) break
          walk = rigAsset.byId.get(father)
        }
        const overrides = mods
          .filter((m) => chainIds.has(modTarget(m)) && /^m_Local(Position|Scale)/.test(modPath(m)))
          .map((m) => `${m.propertyPath}=${m.value}`)
          .sort()
        census.push(
          launchTriggerRow(rel, rigAsset, hit, {
            scene: row.scene,
            how: `prefab instance &${inst.fileId} -> ${rel}`,
            frameOverridesInScene: overrides,
          }),
        )
      }
    }
  }
  census.sort((a, b) => (`${a.scene}${a.how}` < `${b.scene}${b.how}` ? -1 : 1))

  const rigScenes = perScene.filter(
    (p) => p.kind === 'mission' && census.some((c) => c.scene === p.scene),
  )
  // Three populations, and conflating them is how this ends up looking like per-mission data:
  //   * live AND anchored in Position_adjustment -> these are what the constant is read from
  //   * live but NOT anchored -> `int_01_jumpSeat`, which carries the HoverJet's rig with no ride
  //   * not live -> the older generation, at 5.5 m under the rig root, switched off
  const liveRows = census.filter((c) => c.live && c.localY !== null)
  const liveUnanchored = census.filter((c) => c.live && c.localY === null)
  const liveYs = [...new Set(liveRows.map((c) => c.localY))].sort((a, b) => a - b)
  const agree = liveYs.length > 0 && liveYs[liveYs.length - 1] - liveYs[0] <= LAUNCH_Y_EPSILON
  if (!agree) {
    warn(
      `the launch reveal height DISAGREES across the live rigs: ${JSON.stringify(liveYs)} — it is per-mission and belongs in content/levels/*.json, not here`,
    )
  }
  // Guarded on emptiness rather than left to NaN: `Math.abs(x - undefined) > eps` is FALSE, so an
  // empty census would have skipped the cross-check silently instead of loudly.
  if (liveYs.length > 0 && Math.abs(primary.localY - liveYs[0]) > LAUNCH_Y_EPSILON) {
    warn(
      `${LAUNCH_RIG_PREFAB} says ${primary.localY} but the live scene copies say ${JSON.stringify(liveYs)}`,
    )
  }
  const scaled = census.filter((c) => c.parentScaled)
  if (scaled.length) {
    warn(
      `a scale between ${LAUNCH_FRAME} and the reveal trigger in: ${JSON.stringify(scaled.map((c) => c.scene))} — the composed height is not a plain sum of local Ys`,
    )
  }

  const trigTf = prefabHits[0].transform
  const src = `${LAUNCH_RIG_PREFAB}#${trigTf.fileId} Transform.m_LocalPosition.y (trigger_enableTerrain, under ${LAUNCH_FRAME})`
  const out = {
    rigPrefab: LAUNCH_RIG_PREFAB,
    rigPrefabGuid: pathToGuid.get(LAUNCH_RIG_PREFAB) ?? null,
    frame: LAUNCH_FRAME,
    reveal: {},
  }
  out.reveal.triggerLocalY = put('launch.reveal.triggerLocalY', {
    value: primary.localY,
    unit: 'm',
    trust: 'verified',
    origin: 'shipped-prefab',
    source: src,
    fileId: String(trigTf.fileId),
    line: lineOf(prefab, trigTf.fileId, 'm_LocalPosition'),
  })
  out.reveal.triggerBoxScaleY = put('launch.reveal.triggerBoxScaleY', {
    value: primary.boxScaleY,
    unit: 'm',
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${LAUNCH_RIG_PREFAB}#${trigTf.fileId} Transform.m_LocalScale.y`,
    fileId: String(trigTf.fileId),
    line: lineOf(prefab, trigTf.fileId, 'm_LocalScale'),
  })
  out.reveal.animatedNodeRestY = put('launch.reveal.animatedNodeRestY', {
    value: primary.animatedNodeRestY,
    unit: 'm',
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${LAUNCH_RIG_PREFAB} ${LAUNCH_FRAME}/Elevator/${LAUNCH_ANIMATED_NODE} composed m_LocalPosition.y`,
  })
  out.reveal.triggerCopies = put('launch.reveal.triggerCopies', {
    value: rigScenes.length,
    unit: null,
    trust: 'verified',
    origin: 'scene-component',
    source:
      'shipped mission scenes carrying a Trigger_EnableTerrain or a launch-rig prefab instance',
  })
  out.reveal.liveInFrameCount = put('launch.reveal.liveInFrameCount', {
    value: liveRows.length,
    unit: null,
    trust: 'verified',
    origin: 'scene-component',
    source: `the same census, filtered to component m_Enabled == 1 AND m_IsActive == 1 all the way up AND anchored in ${LAUNCH_FRAME}`,
  })
  // The census is EVIDENCE, not a constant: it goes to `structural`, which CI diffs like a value.
  return {
    sheet: out,
    structural: {
      agree,
      liveLocalYs: liveYs,
      /** LIVE but outside `Position_adjustment` — so not a source, and not a disagreement either. */
      liveOutsideFrame: liveUnanchored
        .map((c) => `${c.scene} y=${round(num(c.boxScaleY), 6)}-tall box under ${c.frame}`)
        .sort(),
      census,
    },
  }
}

// ---------------------------------------------------------------------------------------------
// 13c. The screen fade — Fade_Mesh, the one transition 2016 has and the port does not
// ---------------------------------------------------------------------------------------------
//
// `Fade_Mesh.cs` drives a black full-screen surface from `fadeValue = timer / fadeTime` through a
// serialised `AnimationCurve`, with an inline `if (fadeValue > 0.85) fadeValue = 1` clamp. The
// numbers the port needs are `public float fadeTime` — so hard rule 2 applies, the .cs initialiser
// is not shipped behaviour, and every value below is traced scene -> prefab -> m_Modifications.
//
// Every C# consumer finds the fader the same way, and that is what makes the census necessary:
// `GameObject.FindGameObjectWithTag("fader")` (Input_Ship, LevelEnd, Trigger_Kill, ...) and
// `FindObjectOfType<Fade_Mesh>()` (LoadLevelArt, CamChanger, Trigger_Reset). Neither has a defined
// answer in a scene that contains two live ones.
//
// THE LIVENESS WALK IS WHAT THIS SECTION IS ABOUT. A grep for `m_TagString: fader` finds thirty
// faders in `setGameplayOptions.unity` and every one of them is dead — parented under a `Cameras
// (1)` and an `old` that both carry `m_IsActive: 0`. Reading the component flag alone is the bug
// DEV-074 paid for on PlayerBoundary, and it would have put 1.5 s into the sheet.

const FADE_MESH_CS = 'Assets/Faceted Flight/Scripts/Fade_Mesh.cs'
const FADE_MESH_GUID = pathToGuid.get(FADE_MESH_CS) ?? null
/** The tag every C# consumer looks the fader up by. */
const FADE_TAG = 'fader'
/** The camera rig every shipped MISSION instantiates. Its `meshFader` is the mission fade. */
const GAMEPLAY_CAMERA_PREFAB = 'Assets/Faceted Flight/Prefabs/Cameras_gameplay.prefab'
/**
 * The camera rig every shipped MENU scene instantiates — and NOT
 * `Assets/Faceted Flight/Prefabs/Cameras.prefab`, which no shipped scene instantiates at all and
 * whose fader says 1.5. Two files one directory apart with the same basename and different
 * numbers: the `islandgroup_height.png` trap, in the camera rigs.
 */
const MENU_CAMERA_PREFAB =
  'Assets/Faceted Flight/Prefabs/legacy_root_prefabs/PreFabs/Cameras.prefab'
/** The other `Cameras.prefab`. Referenced by nothing shipped. Recorded so the decoy is on the record. */
const DECOY_CAMERA_PREFAB = 'Assets/Faceted Flight/Prefabs/Cameras.prefab'
/** The older boot prefab. Four missions carry a DISCONNECTED copy of its dead 1.5 s fader. */
const INIT_LEVEL_PREFAB = 'Assets/Faceted Flight/Prefabs/Init Level.prefab'
/** `Fade_Mesh.cs`'s inline clamp: the last 15% of the ramp is already solid. Not a field. */
const FADE_SOLID_AT = 0.85

/**
 * The DEATH path, which is a different fade with different numbers.
 *
 * `Trigger_Kill.RestartLevel()` overrides the fader's own `fadeTime` to a tenth
 * of a second at runtime, plays "explode2", and waits before reloading the
 * scene. So a boundary death is a SNAP to black and then a long hold — not the
 * one-second fade the same fader does everywhere else — and the two numbers are
 * inline literals in that method, which no prefab can move.
 *
 * The way BACK in is `LoadLevelArt.LoadLevel()`: it loads the environment scene
 * additively and then calls `fader.FadeIn()` on the reloaded scene's own fresh
 * fader, which is at `fade.missionSeconds` again — the 0.1 died with the old
 * object. That is why there is no `respawnInSeconds` key here: it would be a
 * second name for a number the sheet already has, and DEV-069's lesson is that
 * a constant with two names is a constant that will disagree with itself.
 */
const TRIGGER_KILL_CS = 'Assets/Faceted Flight/Scripts/Trigger_Kill.cs'
/** The view toggle's own fade overrides (DEV-128). */
const CAM_CHANGER_CS = 'Assets/Faceted Flight/Scripts/CamChanger.cs'
const LOAD_LEVEL_ART_CS_FADE = 'Assets/Faceted Flight/Scripts/LoadLevelArt.cs'

/**
 * The two rig roots `CameraMode.cs:45-46` SetActive()s at runtime, one of them per boot.
 *
 * `m_IsActive: 0` on one of these is DORMANT, not dead — 2016 ships both a SteamVR rig and an
 * Oculus rig under one prefab and turns exactly one on. A liveness walk that vetoes on them reports
 * the menu scenes as having no fader at all, which is the opposite error to the one above. The
 * reason this is safe rather than a second guess: both rigs' faders carry the SAME fadeTime, so
 * which one wins cannot move the number. `structural.screenFade.menuRigCandidates` shows that.
 */
const RUNTIME_ACTIVATED_RIGS = new Set(['camRig_ovr', 'camRig_steamVR', 'camera_vr', 'camera_mono'])

/** Line splitter. Named so a regex literal does not have to survive a code generator. */
const NEWLINE_RE = /\r?\n/

/**
 * A numeric literal out of a first-party .cs METHOD BODY, with its line.
 *
 * `re` must carry its own anchor — a unique neighbouring statement — and one
 * capture group for the number. `Trigger_Kill.cs` has two `WaitForSeconds` in
 * it, 0.3 in `DelayedStart` and 2.5 in `DelayedReload`, and a regex that just
 * looked for the call would have taken whichever came first. Anchoring is what
 * makes this an extraction rather than a guess that happens to be right.
 *
 * Returns null and WARNS when the anchor does not match, because a silently
 * missing number here becomes a hard-typed one in `src/` the next day.
 */
function csAnchoredNumber(relPath, re, what) {
  const src = csText.get(relPath)
  if (src === undefined) {
    warn(`${relPath}: not a first-party .cs file; no ${what} extracted`)
    return null
  }
  const m = re.exec(src)
  if (!m) {
    warn(`${relPath}: the anchor for ${what} did not match — ${re}`)
    return null
  }
  const value = Number(m[1])
  if (!Number.isFinite(value)) {
    warn(`${relPath}: ${what} is not a number: ${JSON.stringify(m[1])}`)
    return null
  }
  // The line the CAPTURE is on, not the line the anchor starts on.
  const upTo = src.slice(0, m.index + m[0].lastIndexOf(m[1]))
  return { value, line: upTo.split(NEWLINE_RE).length }
}

/** 1-based line of the first line of a first-party .cs file matching `re`, or null. */
function csLineMatching(relPath, re) {
  const src = csText.get(relPath)
  if (src === undefined) return null
  const lines = src.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1
  return null
}

/** `{ name, isActive }` from the asset root down to this transform, root first. */
function activeChainOf(asset, transformDoc) {
  return chainUp(asset.byId, transformDoc)
    .nodes.reverse()
    .map((n) => ({
      // A STRIPPED transform has no GameObject in this file: the prefab instance's own root. Not
      // a veto and not an assertion of life: `-1` says "this file cannot answer", and it is
      // reported.
      name: n.go ? String(n.go.data?.m_Name ?? '?') : null,
      isActive: n.active,
    }))
}

/**
 * Is an `AnimationCurve` the straight line from (0,a) to (1,b)?
 *
 * Both shipped curves are — `fadeInCurve` 1 -> 0 and `fadeOutCurve` 0 -> 1, `tangentMode: 0`, with
 * one slope of 0.0017710662 that is an editor artefact rather than a shape. The port draws a
 * linear ramp BECAUSE of this check, not because linear was the obvious guess.
 */
function linearFadeCurve(curve) {
  const keys = curve?.m_Curve ?? []
  if (keys.length !== 2) return null
  const a = { t: num(keys[0].time, Number.NaN), v: num(keys[0].value, Number.NaN) }
  const b = { t: num(keys[1].time, Number.NaN), v: num(keys[1].value, Number.NaN) }
  if (a.t !== 0 || b.t !== 1) return null
  const slopes = keys.flatMap((k) => [num(k.inSlope), num(k.outSlope)])
  return { from: a.v, to: b.v, maxAbsSlope: round(Math.max(...slopes.map(Math.abs)), 9) }
}

/** Every `Fade_Mesh` in an asset, with the liveness walk and the fields the port needs. */
function fadeMeshRows(asset) {
  if (!FADE_MESH_GUID) return []
  const out = []
  for (const doc of asset.docs) {
    if (doc.type !== 'MonoBehaviour') continue
    if (String(doc.data?.m_Script?.guid ?? '') !== FADE_MESH_GUID) continue
    const go = asset.byId.get(String(doc.data?.m_GameObject?.fileID ?? '0'))
    if (!go) continue
    const tf = componentsOfGo(asset.byId, go).find((c) => c.type === 'Transform')
    const chain = tf
      ? activeChainOf(asset, tf)
      : [{ name: String(go.data?.m_Name ?? '?'), isActive: num(go.data?.m_IsActive, -1) }]
    const componentEnabled = num(doc.data?.m_Enabled, -1) === 1
    // An inactive ancestor kills it, UNLESS it is one of the two rigs CameraMode turns on.
    const deadAncestors = chain
      .filter((c) => c.isActive === 0 && !RUNTIME_ACTIVATED_RIGS.has(c.name ?? ''))
      .map((c) => c.name)
    const dormantAncestors = chain
      .filter((c) => c.isActive === 0 && RUNTIME_ACTIVATED_RIGS.has(c.name ?? ''))
      .map((c) => c.name)
    const parentRef = doc.data?.m_PrefabParentObject?.guid
    out.push({
      fileId: String(doc.fileId),
      gameObjectName: String(go.data?.m_Name ?? '?'),
      tag: String(go.data?.m_TagString ?? ''),
      fadeTime: round(num(doc.data?.fadeTime, Number.NaN), 6),
      delayStart: num(doc.data?.delayStart, 0) === 1,
      delayTime: round(num(doc.data?.delayTime, Number.NaN), 6),
      /** 1 drives a screen-space UI Image tagged `ui_fader`; 0 drives this object's own Renderer. */
      useUIFade: num(doc.data?.useUIFade, 0) === 1,
      fadeInCurve: linearFadeCurve(doc.data?.fadeInCurve),
      fadeOutCurve: linearFadeCurve(doc.data?.fadeOutCurve),
      componentEnabled,
      chain: chain.map((c) => `${c.name ?? '(stripped)'}=${c.isActive}`),
      deadAncestors,
      dormantAncestors,
      /** A DISCONNECTED copy names the prefab it was torn off. `null` means authored in place. */
      lineage: parentRef ? (resolveGuid(String(parentRef)) ?? `guid:${parentRef}`) : null,
      live: componentEnabled && deadAncestors.length === 0,
    })
  }
  return out
}

/** The live faders an asset would contribute to `FindGameObjectWithTag("fader")`. */
function liveTaggedFaders(relPath) {
  if (!unityExists(relPath)) return []
  return fadeMeshRows(loadAsset(relPath)).filter((r) => r.live && r.tag === FADE_TAG)
}

/**
 * The two fade durations, and the census that says which one each scene actually runs.
 *
 * Three findings live in here, and all three contradict a plausible first reading:
 *
 *  1. `setGameplayOptions.unity` has THIRTY faders at 1.5 s and not one of them runs. The liveness
 *     walk is the whole difference.
 *  2. The menu scenes fade at 0.75 s, off `legacy_root_prefabs/PreFabs/Cameras.prefab` — not the
 *     1.5 s on the identically-named `Prefabs/Cameras.prefab`, which nothing shipped instantiates.
 *  3. Four missions carry a disconnected copy of `Init Level.prefab`'s 1.5 s fader. Whether it is
 *     a SECOND live answer is what `ambiguousScenes` reports rather than assumes.
 */
function extractScreenFade(perScene, shippedScenes) {
  if (!FADE_MESH_GUID) {
    warn(`${FADE_MESH_CS}: not in the guid index; no screen fade extracted`)
    return null
  }
  if (!unityExists(GAMEPLAY_CAMERA_PREFAB)) {
    warn(`${GAMEPLAY_CAMERA_PREFAB}: not found; no screen fade extracted`)
    return null
  }

  const rigAsset = loadAsset(GAMEPLAY_CAMERA_PREFAB)
  const rigRows = liveTaggedFaders(GAMEPLAY_CAMERA_PREFAB)
  if (rigRows.length !== 1) {
    warn(
      `${GAMEPLAY_CAMERA_PREFAB}: expected 1 live Fade_Mesh tagged "${FADE_TAG}", found ${rigRows.length}`,
    )
    return null
  }
  const rig = rigRows[0]

  // ── the census, over the thirteen shipped missions ────────────────────────────────────────────
  //
  // Two shapes, and the second is the stripped-prefab trap: a materialised Fade_Mesh is a `!u!114`
  // document in the scene, and a `1001` instance of the camera rig has no components in the scene
  // at all — its fader lives in the .prefab file. Counting only the first reports eight of the
  // thirteen missions as having no fade whatsoever.
  const rigGuid = pathToGuid.get(GAMEPLAY_CAMERA_PREFAB) ?? null
  const census = []
  for (const row of perScene.filter((p) => p.kind === 'mission')) {
    const text = unityRead(row.scene)
    if (!text.includes(FADE_MESH_GUID) && !(rigGuid && text.includes(rigGuid))) continue
    const scene = loadAsset(row.scene)
    for (const hit of fadeMeshRows(scene)) {
      census.push({ scene: row.scene, how: 'materialised', ...hit })
    }
    for (const inst of instancesOf(scene.docs, rigGuid)) {
      const mods = modificationsOf(inst)
      // Hard rule 2's last step. Two ways a scene could move this number: the fader component's own
      // fields, and `m_IsActive` on the instance root — which is how `int_01_hoverJet` retires its
      // second rig. The copy is there, deactivated, and contributes nothing.
      const fadeOverridesInScene = mods
        .filter(
          (m) =>
            modTarget(m) === rig.fileId &&
            /^(fadeTime|delayStart|delayTime|useUIFade)$/.test(modPath(m)),
        )
        .map((m) => `${m.propertyPath}=${m.value}`)
        .sort()
      const instanceDeactivated = mods.some(
        (m) => modPath(m) === 'm_IsActive' && num(m?.value, 1) === 0,
      )
      census.push({
        scene: row.scene,
        how: `prefab instance &${inst.fileId} -> ${GAMEPLAY_CAMERA_PREFAB}`,
        ...rig,
        fadeOverridesInScene,
        instanceDeactivated,
        live: rig.live && !instanceDeactivated,
      })
    }
  }
  census.sort((a, b) =>
    `${a.scene}${a.how}${a.fileId}` < `${b.scene}${b.how}${b.fileId}` ? -1 : 1,
  )

  // `fadeTime` is the only override that could move the CONSTANT. A scene moving `delayStart` or
  // `delayTime` is moving when the fade starts, which is 2016's scene-load choreography and not
  // something the port reproduces — recorded in the census, not warned about.
  const overridden = census.filter((c) =>
    (c.fadeOverridesInScene ?? []).some((o) => o.startsWith('fadeTime=')),
  )
  if (overridden.length) {
    warn(
      `a shipped mission scene overrides the camera rig's fadeTime: ${JSON.stringify(
        overridden.map((c) => `${c.scene} ${c.fadeOverridesInScene.join(',')}`),
      )} — the mission fade is per-mission, not one constant`,
    )
  }
  const missionsWithRig = new Set(
    census.filter((c) => c.how !== 'materialised' && c.live).map((c) => c.scene),
  )
  const missionCount = perScene.filter((p) => p.kind === 'mission').length
  if (missionsWithRig.size !== missionCount) {
    warn(
      `${missionsWithRig.size}/${missionCount} shipped missions carry a live Cameras_gameplay instance — the rest fade by some other object`,
    )
  }
  // The scenes where 2016's own answer is unspecified: more than one LIVE object tagged `fader`.
  const perSceneTagged = new Map()
  for (const c of census.filter((x) => x.live && x.tag === FADE_TAG)) {
    perSceneTagged.set(c.scene, [...(perSceneTagged.get(c.scene) ?? []), c])
  }
  const ambiguousScenes = [...perSceneTagged.entries()]
    .filter(([, rows]) => new Set(rows.map((r) => r.fadeTime)).size > 1)
    .map(
      ([scene, rows]) =>
        `${scene}: ${rows.length} live faders at ${JSON.stringify([...new Set(rows.map((r) => r.fadeTime))].sort())}`,
    )
    .sort()
  if (ambiguousScenes.length) {
    warn(
      `two live faders with DIFFERENT fadeTimes in the same scene — FindGameObjectWithTag has no defined answer: ${JSON.stringify(ambiguousScenes)}`,
    )
  }
  /** The disconnected `Init Level` copies, live or not. The reason the census exists. */
  const initLevelCopies = census
    .filter((c) => c.how === 'materialised' && c.lineage === INIT_LEVEL_PREFAB)
    .map(
      (c) =>
        `${c.scene} fadeTime=${c.fadeTime} live=${c.live} dead=${JSON.stringify(c.deadAncestors)}`,
    )
    .sort()

  // ── the menu fade ─────────────────────────────────────────────────────────────────────────────
  //
  // Which prefab, derived rather than named: the scenes in the build list that are neither missions
  // nor environments, and the camera rig they instantiate. `titlescreen`, `main_menu`,
  // `setGameplayOptions`, `options_screen`, `missionResults` and `credits` all carry the same one.
  const menuRig = liveTaggedFaders(MENU_CAMERA_PREFAB)
  const menuTimes = [...new Set(menuRig.map((r) => r.fadeTime))].sort((a, b) => a - b)
  if (menuRig.length === 0) {
    warn(`${MENU_CAMERA_PREFAB}: no live Fade_Mesh tagged "${FADE_TAG}"`)
  } else if (menuTimes.length !== 1) {
    warn(
      `${MENU_CAMERA_PREFAB}: its ${menuRig.length} faders disagree about fadeTime: ${JSON.stringify(menuTimes)} — which rig CameraMode activates now decides the number`,
    )
  }
  const menuGuid = pathToGuid.get(MENU_CAMERA_PREFAB) ?? null
  const menuScenes = []
  for (const s of shippedScenes) {
    if (!s.enabled || !s.present) continue
    if (classifyScene(s.path) !== 'other') continue
    if (s.path.includes('/environments/')) continue
    const text = unityRead(s.path)
    if (!menuGuid || !text.includes(menuGuid)) continue
    const scene = loadAsset(s.path)
    const overrides = []
    for (const inst of instancesOf(scene.docs, menuGuid)) {
      for (const m of modificationsOf(inst)) {
        if (modPath(m) === 'fadeTime') overrides.push(`${s.path} ${m.value}`)
      }
    }
    menuScenes.push({
      scene: s.path,
      overrides,
      /** Faders authored INTO the scene, alive or not. Thirty of them in setGameplayOptions. */
      materialised: fadeMeshRows(scene).map((r) => ({
        fadeTime: r.fadeTime,
        live: r.live,
        deadAncestors: r.deadAncestors,
      })),
    })
  }
  const menuOverrides = menuScenes.flatMap((m) => m.overrides)
  if (menuOverrides.length) {
    warn(`a shipped menu scene overrides the menu rig's fadeTime: ${JSON.stringify(menuOverrides)}`)
  }

  const curves = [rig.fadeInCurve, rig.fadeOutCurve]
  const curveIsLinear =
    curves.every((c) => c !== null && c.maxAbsSlope < 0.01) &&
    rig.fadeInCurve.from === 1 &&
    rig.fadeInCurve.to === 0 &&
    rig.fadeOutCurve.from === 0 &&
    rig.fadeOutCurve.to === 1
  if (!curveIsLinear) {
    warn(
      `${GAMEPLAY_CAMERA_PREFAB}: the fade curves are NOT the straight 1->0 / 0->1 ramp the port draws: ${JSON.stringify(curves)}`,
    )
  }

  const fadeTimeDecl = parseCsFields(FADE_MESH_CS).get('fadeTime') ?? null
  const consumers = fadeTimeDecl
    ? findConsumers('fadeTime', FADE_MESH_CS, fadeTimeDecl.line)
        .reads.map((r) => `${r.file}:${r.line}`)
        .sort()
    : null

  const out = {
    missionRigPrefab: GAMEPLAY_CAMERA_PREFAB,
    menuRigPrefab: MENU_CAMERA_PREFAB,
    taggedObjectName: rig.gameObjectName,
    tag: FADE_TAG,
  }
  out.missionSeconds = put('fade.missionSeconds', {
    value: rig.fadeTime,
    unit: 's',
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${GAMEPLAY_CAMERA_PREFAB}#${rig.fileId} Fade_Mesh.fadeTime`,
    fileId: rig.fileId,
    line: lineOf(rigAsset, rig.fileId, 'fadeTime'),
    consumers,
    note:
      `The camera rig every shipped mission instantiates, with no scene overriding fadeTime in ` +
      `${missionsWithRig.size}/${missionCount} of them. ${initLevelCopies.length} missions also carry a ` +
      `disconnected copy of ${INIT_LEVEL_PREFAB}'s 1.5 s fader — see structural.screenFade.initLevelCopies ` +
      `for whether any of them is live.`,
  })
  out.menuSeconds = put('fade.menuSeconds', {
    value: menuTimes.length === 1 ? menuTimes[0] : null,
    unit: 's',
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${MENU_CAMERA_PREFAB} Fade_Mesh.fadeTime, on both of the rigs CameraMode chooses between`,
    fileId: menuRig[0]?.fileId ?? null,
    note:
      `Instantiated by ${menuScenes.length} shipped menu scenes, none overriding it. NOT ${DECOY_CAMERA_PREFAB}, ` +
      `which says 1.5 and which no shipped scene instantiates — same basename, one directory apart.`,
  })
  out.solidAtFraction = put('fade.solidAtFraction', {
    value: FADE_SOLID_AT,
    unit: null,
    trust: 'verified',
    origin: 'csharp-initializer',
    source: `${FADE_MESH_CS} Fade_Mesh.Fade(): "if (fadeValue > 0.85) fadeValue = 1"`,
    line: csLineMatching(FADE_MESH_CS, /fadeValue\s*>\s*0\.85/),
    note:
      'An inline literal in the METHOD BODY, not a serialised field — so unlike fadeTime no prefab ' +
      'can move it, which makes `verified` stronger here than the usual code-default. The visible ' +
      'ramp therefore finishes at 0.85 * fadeTime and holds solid for the remaining 15%.',
  })
  out.curve = put('fade.curve', {
    value: curveIsLinear ? 'linear' : 'non-linear',
    unit: null,
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${GAMEPLAY_CAMERA_PREFAB}#${rig.fileId} Fade_Mesh.fadeInCurve / fadeOutCurve`,
    fileId: rig.fileId,
    line: lineOf(rigAsset, rig.fileId, 'fadeInCurve'),
    note: 'Two keys, (0,1)->(1,0) and (0,0)->(1,1), tangentMode 0. Checked rather than assumed.',
  })
  out.usesUiSurface = put('fade.usesUiSurface', {
    value: rig.useUIFade,
    unit: null,
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${GAMEPLAY_CAMERA_PREFAB}#${rig.fileId} Fade_Mesh.useUIFade`,
    fileId: rig.fileId,
    line: lineOf(rigAsset, rig.fileId, 'useUIFade'),
    note:
      '1 => 2016 fades a screen-space UI Image rather than the head-locked quad at z=0.11. ' +
      'PORT_PLAN §2.1 rejected that quad for stereo; `render/vignette.ts` is the clip-space pass ' +
      'that replaces both.',
  })

  // ── the DEATH fade, which is a different shape entirely ──────────────────────────────────────
  //
  // Both anchored on a unique neighbouring statement. `Trigger_Kill.cs` carries two
  // `WaitForSeconds` — 0.3 in `DelayedStart` and 2.5 in `DelayedReload` — so a regex for the call
  // alone would have taken the wrong one and been wrong by 2.4 seconds, silently.
  const killFade = csAnchoredNumber(
    TRIGGER_KILL_CS,
    /restarting\s*=\s*true;[\s\S]{0,200}?meshFader\.fadeTime\s*=\s*([0-9.]+)f/,
    'the kill fade',
  )
  const killHold = csAnchoredNumber(
    TRIGGER_KILL_CS,
    /SetString\("Respawning"[\s\S]{0,200}?WaitForSeconds\(\s*([0-9.]+)f/,
    'the respawn hold',
  )
  /** `LoadLevelArt` is what fades the reloaded scene back IN. Recorded so the claim has a line. */
  const respawnFadeInCaller = csLineMatching(LOAD_LEVEL_ART_CS_FADE, /fader\.FadeIn\(\)/)
  if (respawnFadeInCaller === null) {
    warn(
      `${LOAD_LEVEL_ART_CS_FADE}: no fader.FadeIn() — the claim that a respawn fades back in at fade.missionSeconds has lost its source`,
    )
  }

  out.killSeconds = put('fade.killSeconds', {
    value: killFade ? killFade.value : null,
    unit: 's',
    trust: 'verified',
    origin: 'csharp-initializer',
    source: `${TRIGGER_KILL_CS} Trigger_Kill.RestartLevel(): "meshFader.fadeTime = 0.1f"`,
    line: killFade ? killFade.line : null,
    note:
      "A RUNTIME OVERRIDE of the fader prefab's own fadeTime, not a serialised field — so a death " +
      'is a snap to black where every other transition in the game is a second long. It dies with ' +
      'the scene: the reload builds a fresh fader back at fade.missionSeconds.',
  })
  // ── the CHANGE VIEW fade — CamChanger.ChangeCam(), three runtime overrides ─────────────────
  //
  // DEV-128. 2016 cuts between the first- and third-person camera roots under a short fade:
  // `screenFader.fadeTime = 0.12f; trigger_FadeOut = true; yield WaitForSeconds(0.2f);
  // fadeTime = 0.25f; trigger_FadeIn = true`. Anchored on the trigger flags so the two
  // `fadeTime =` assignments in the same method cannot be taken for each other.
  const camOut = csAnchoredNumber(
    CAM_CHANGER_CS,
    /fadeTime\s*=\s*([0-9.]+)f;\s*\r?\n\s*screenFader\.trigger_FadeOut\s*=\s*true/,
    'the change-view fade out',
  )
  const camHold = csAnchoredNumber(
    CAM_CHANGER_CS,
    /trigger_FadeOut\s*=\s*true;[\s\S]{0,120}?WaitForSeconds\(\s*([0-9.]+)f/,
    'the change-view hold',
  )
  const camIn = csAnchoredNumber(
    CAM_CHANGER_CS,
    /fadeTime\s*=\s*([0-9.]+)f;\s*\r?\n\s*screenFader\.trigger_FadeIn\s*=\s*true/,
    'the change-view fade in',
  )
  out.cameraSwitchOutSeconds = put('fade.cameraSwitchOutSeconds', {
    value: camOut ? camOut.value : null,
    unit: 's',
    trust: 'verified',
    origin: 'csharp-initializer',
    source: `${CAM_CHANGER_CS} CamChanger.ChangeCam(): "screenFader.fadeTime = 0.12f" before trigger_FadeOut`,
    line: camOut ? camOut.line : null,
    note:
      'A runtime override of the fader, like fade.killSeconds: the cut to third person goes black in ' +
      '0.12 s. Both shipped ship prefabs carry CamChanger on the root (hoverjet.camera / jumpseat.camera).',
  })
  out.cameraSwitchHoldSeconds = put('fade.cameraSwitchHoldSeconds', {
    value: camHold ? camHold.value : null,
    unit: 's',
    trust: 'verified',
    origin: 'csharp-initializer',
    source: `${CAM_CHANGER_CS} CamChanger.ChangeCam(): "yield return new WaitForSeconds(0.2f)"`,
    line: camHold ? camHold.line : null,
    note:
      'From the fade-out TRIGGER to the fade-in trigger, so the screen is solid for about ' +
      '0.2 - 0.12 * 0.85 = 0.1 s. The reparent happens after this wait, under black.',
  })
  out.cameraSwitchInSeconds = put('fade.cameraSwitchInSeconds', {
    value: camIn ? camIn.value : null,
    unit: 's',
    trust: 'verified',
    origin: 'csharp-initializer',
    source: `${CAM_CHANGER_CS} CamChanger.ChangeCam(): "screenFader.fadeTime = 0.25f" before trigger_FadeIn`,
    line: camIn ? camIn.line : null,
    note: 'The fade back in on the new camera. Twice the fade out: the same asymmetry as flatFov’s attack/release.',
  })
  out.respawnHoldSeconds = put('fade.respawnHoldSeconds', {
    value: killHold ? killHold.value : null,
    unit: 's',
    trust: 'verified',
    origin: 'csharp-initializer',
    source: `${TRIGGER_KILL_CS} Trigger_Kill.DelayedReload(): "yield return new WaitForSeconds(2.5f)"`,
    line: killHold ? killHold.line : null,
    note:
      'Black, from the moment the snap lands until the scene reload. NOT padding: it is the beat ' +
      'that makes a reset read as a consequence rather than as a stutter, and the port has run it ' +
      'as the `dying` phase of `sim/boundary.ts` since before anything drew it. ' +
      '`content/levels/*.json` takes `boundary.resetFadeSeconds` from THIS key rather than from a ' +
      'second literal in `tools/extract/level.mjs`.',
  })

  return {
    sheet: out,
    structural: {
      missionsWithLiveRig: [...missionsWithRig].sort(),
      /** Where two LIVE faders disagree, so 2016's own answer is unspecified. Empty is the good case. */
      ambiguousScenes,
      initLevelCopies,
      menuScenes,
      menuRigCandidates: menuRig.map(
        (r) =>
          `${r.gameObjectName} fadeTime=${r.fadeTime} dormantUnder=${JSON.stringify(r.dormantAncestors)}`,
      ),
      decoyMenuRig: liveTaggedFaders(DECOY_CAMERA_PREFAB).map((r) => r.fadeTime),
      curveIsLinear,
      /**
       * The death, end to end, so the port's respawn can be checked against a chain rather than
       * against three numbers somebody remembered.
       */
      deathChain: {
        killFadeLine: killFade ? `${TRIGGER_KILL_CS}:${killFade.line}` : null,
        holdLine: killHold ? `${TRIGGER_KILL_CS}:${killHold.line}` : null,
        fadeInCaller: respawnFadeInCaller
          ? `${LOAD_LEVEL_ART_CS_FADE}:${respawnFadeInCaller}`
          : null,
        /**
         * `Ship_HoverShip.Flash()` sets `meshFader.fadeTime = 0.3f` on a collision and never puts
         * it back — a permanent mutation of the shared fader, once per scene. It governs nothing:
         * the scene's own fade-in has already happened by then and `RestartLevel` overrides it
         * again on the way out. Recorded because it LOOKS like a third fade duration and is not.
         */
        strayMutation: csLineMatching(
          'Assets/Faceted Flight/Scripts/Ship_HoverShip.cs',
          /meshFader\.fadeTime\s*=\s*0\.3f/,
        ),
      },
      census,
    },
  }
}
/**
 * PlayerBoundary is the one gameplay constant that is NOT on a prefab: it lives on a component
 * placed in each mission scene, so its trust is `verified` but its origin is `scene-component`.
 * The C# initialiser says 10; every shipped scene says 13. That gap is the cardinal rule in one
 * number, and it is why `origin` and `trust` are two fields rather than one.
 */
function extractBoundary(perScene) {
  const missions = perScene.filter((p) => p.kind === 'mission' && p.playerBoundary)
  const delays = [...new Set(missions.map((m) => m.playerBoundary.resetDelay))]
  const disabled = missions
    .filter((m) => !m.playerBoundary.enabled)
    .map((m) => m.scene)
    .sort()
  const first = missions[0]
  const out = {}
  out.resetDelay = put('boundary.resetDelay', {
    value: delays.length === 1 ? delays[0] : null,
    unit: 's',
    trust: 'verified',
    origin: 'scene-component',
    source: `PlayerBoundary MonoBehaviour in each shipped mission scene (e.g. ${first ? `${first.scene}#${first.playerBoundary.fileId}` : 'n/a'})`,
    fileId: first ? first.playerBoundary.fileId : null,
    line: first ? first.playerBoundary.line : null,
    note: `Assets/Faceted Flight/Scripts/PlayerBoundary.cs says 10. Every one of the ${missions.length} shipped missions says ${JSON.stringify(delays)}. NEVER take this from the .cs.`,
  })
  out.enabledMissionCount = put('boundary.enabledMissionCount', {
    value: missions.length - disabled.length,
    unit: null,
    trust: 'verified',
    origin: 'scene-component',
    source: 'PlayerBoundary.m_Enabled across the shipped mission scenes',
    note: `Out-of-bounds death is a PER-LEVEL flag, not a global rule: it is off in ${disabled.length} of ${missions.length}.`,
  })
  out.disabledIn = put('boundary.disabledIn', {
    value: disabled,
    unit: null,
    trust: 'verified',
    origin: 'scene-component',
    source: 'PlayerBoundary.m_Enabled == 0',
  })
  return out
}

function assertPrefabIsTheOneMissionsUse(perScene, tag, expectedPath) {
  const rows = perScene.filter((p) => p.kind === 'mission' && p.scene.includes(tag))
  if (rows.length === 0) {
    warn(`no shipped mission scene matched "${tag}"`)
    return
  }
  const bad = rows.filter((r) => r.shipPrefabPath !== expectedPath)
  if (bad.length > 0) {
    warn(
      `CARDINAL RULE VIOLATION: ${bad.length}/${rows.length} shipped "${tag}" scenes do not spawn ${expectedPath}: ` +
        bad.map((b) => `${b.scene} -> ${b.shipPrefabPath}`).join('; '),
    )
  }
}

// ---------------------------------------------------------------------------------------------

function extractHoverJet(relPath) {
  const asset = loadAsset(relPath)
  const root = rootTransformOf(asset)
  const out = { prefab: relPath, guid: pathToGuid.get(relPath) ?? null }

  // Every particle system on the ship, paired with its renderer. The SHIP
  // script already references four of them by fileID (`flightEffects`,
  // `boostEffects`, `boostEffects_stage2`, `boostEffects_stage3`), so these rows
  // are what those references resolve to.
  out.particles = scanParticleSystems(relPath)
  out.speedChain = extractSpeedChain()

  const rb = componentsOf(asset, root).find((d) => d.type === 'Rigidbody')
  if (!rb) die(`${relPath}: no Rigidbody on the prefab root`)
  out.rigidbody = extractRigidbody('hoverjet', asset, rb, 'HoverJet')

  const scripts = [
    ['ship', 'Ship_HoverShip', 'Assets/Faceted Flight/Scripts/Ship_HoverShip.cs'],
    ['hoverMotor', 'HoverMotor', 'Assets/Faceted Flight/Scripts/HoverMotor.cs'],
    ['energy', 'EnergySystem_Ship', 'Assets/Faceted Flight/Scripts/EnergySystem_Ship.cs'],
    ['input', 'Input_Ship', 'Assets/Faceted Flight/Scripts/Input_Ship.cs'],
  ]
  for (const [key, name, csPath] of scripts) {
    const doc = findScript(asset, root, name)
    if (!doc) {
      warn(`${relPath}: no unique ${name} on the prefab root`)
      out[key] = null
      continue
    }
    out[key] = extractBehaviour(`hoverjet.${key}`, asset, doc, csPath)
  }

  const thruster = findScript(asset, root, 'Thruster')
  out.hasThruster = thruster !== null

  out.colliders = extractColliders('hoverjet', asset, root)
  // --- the art rotator ------------------------------------------------------------------
  //
  // `Rotator_Input` on `art_pivot` is what Matt remembered as "slightly rotate
  // the ship to loosen the cockpit a bit". It leans the ART, not the ship, and
  // the camera hangs off `shipOffset` rather than the pivot — so the cockpit
  // rolls around a fixed viewpoint. See DEV-010.
  //
  // It is NOT on the prefab root, so `findScript` cannot see it.
  {
    const rotDoc = findScriptAnywhere(asset, 'Rotator_Input')
    if (!rotDoc) {
      warn(`${relPath}: no Rotator_Input; the art lean will be missing`)
      out.artRotator = null
    } else {
      out.artRotator = extractBehaviour(
        'hoverjet.artRotator',
        asset,
        rotDoc,
        'Assets/Faceted Flight/Scripts/Rotator_Input.cs',
      )
      // The curves carry the feel and the generic extractor emits them as raw
      // Unity blobs, so re-emit them in a shape the sim can evaluate.
      out.artRotator.inputCurve = animationCurve(rotDoc.data.inputCurve)
      out.artRotator.transitionCurve = animationCurve(rotDoc.data.transitionCurve)
      out.artRotator.gameObject = gameObjectName(asset, rotDoc) ?? null
    }
  }

  out.shipCollisionColliders = out.colliders.filter((c) => c.role === 'ship-collision')
  out.allRigidbodies = enumerateRigidbodies(asset, root)
  out.camera = extractCameraTargets('hoverjet', asset, root, relPath)
  out.prefabSelfModificationResidue = inertResidue(asset)
  out.centerOfMassObject = centreOfMassObject(asset, root)
  return out
}

/**
 * Every Rigidbody in the prefab, not just the chassis. `_verify-v-flight.md` V7 found a SIXTH body
 * on the JumpSeat (`collider_head`, 10 mg, no joint) that four prose passes had missed. Counting is
 * cheap; being surprised by a free body at M8 is not.
 */
function enumerateRigidbodies(asset, root) {
  const out = []
  for (const tf of descendants(asset, root)) {
    for (const c of componentsOf(asset, tf)) {
      if (c.type !== 'Rigidbody') continue
      const { trs, chain } = composeFromRoot(asset, tf, root.fileId)
      const hasJoint = componentsOf(asset, tf).some((d) => d.type.endsWith('Joint'))
      out.push({
        name: gameObjectName(asset, tf),
        path: chain.join('/') || '(prefab root)',
        fileId: String(c.fileId),
        mass: num(c.data.m_Mass),
        drag: num(c.data.m_Drag),
        angularDrag: num(c.data.m_AngularDrag),
        useGravity: num(c.data.m_UseGravity) === 1,
        isKinematic: num(c.data.m_IsKinematic) === 1,
        interpolate: num(c.data.m_Interpolate),
        collisionDetection: num(c.data.m_CollisionDetection),
        jointed: hasJoint,
        positionInShipRootSpace: roundDeep(trs.position, 6),
      })
    }
  }
  out.sort((a, b) => (`${a.path}/${a.fileId}` < `${b.path}/${b.fileId}` ? -1 : 1))
  return out
}

/**
 * The two camera roots `CamChanger` switches between, composed to the prefab root. DEV-128.
 *
 * Both shipped ship prefabs carry `CamChanger` on the root, `m_Enabled: 1`, with `camTargets[0]`
 * the first-person eye and `camTargets[1]` a `CamRoot_3rdPerson` behind and above the ship —
 * and `Input_Ship.cs:312` / `Input_Manager.cs:247` call `NextCamView()` on InControl's `Action3`
 * (the X button; "CHANGE VIEW" on 2016's own controls poster), `CamChanger.Update()` on the C
 * key. So a third-person view IS shipped 2016 behaviour, rigidly parented
 * (`cameraRoot.transform.SetParent(camTargets[i], false)`, no lag, no probe), with the art swapped
 * by `shipArt[i].SetActive`. The port had read `Art/ThirdPerson`'s `m_IsActive: 0` as "the
 * missions render first person" for its whole life; it is the RESTING state of a toggle.
 *
 * `startInThirdPerson` is `public bool startInThirdPerson = true` in C# and **0** on both shipped
 * prefabs — the cardinal rule, once more. The rotation is kept: the third-person root is pitched
 * (10.9° on the HoverJet, 7.3° on the JumpSeat), and a port that took the position alone would
 * look level over a ship the camera is meant to look down at.
 */
function extractCameraTargets(prefix, asset, root, relPath) {
  const doc = findScript(asset, root, 'CamChanger')
  if (!doc) {
    warn(`${relPath}: no unique CamChanger on the prefab root; no camera targets extracted`)
    return null
  }
  const describe = (ref) => {
    const tf = ref ? asset.byId.get(String(ref.fileID)) : null
    if (tf?.type !== 'Transform') return null
    const { trs, chain } = composeFromRoot(asset, tf, root.fileId)
    return {
      path: chain.join('/'),
      gameObjectFileId: String(tf.data?.m_GameObject?.fileID ?? '0'),
      transformFileId: String(tf.fileId),
      live: activeChainOf(asset, tf).every((c) => c.isActive),
      line: lineOf(asset, tf.fileId, 'm_LocalPosition'),
      positionInShipRootSpace: roundDeep(trs.position, 6),
      rotationInShipRootSpace: roundDeep(trs.rotation, 6),
      eulerZXYDeg: qToEulerZXY(trs.rotation),
    }
  }
  const targets = doc.data.camTargets ?? []
  const shipArt = (doc.data.shipArt ?? []).map((r) => {
    const go = asset.byId.get(String(r.fileID))
    return go ? { name: go.data?.m_Name ?? '?', active: num(go.data?.m_IsActive) === 1 } : null
  })
  const source = `${relPath}#${doc.fileId} CamChanger`
  const out = { script: 'CamChanger', fileId: String(doc.fileId), targetCount: targets.length }
  out.startInThirdPerson = put(`${prefix}.camera.startInThirdPerson`, {
    value: num(doc.data.startInThirdPerson) === 1,
    unit: null,
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${source}.startInThirdPerson`,
    fileId: doc.fileId,
    line: lineOf(asset, doc.fileId, 'startInThirdPerson'),
    note:
      '`public bool startInThirdPerson = true` in CamChanger.cs and 0 on the shipped prefab: the ' +
      'initialiser is not shipped behaviour. The choice then persists in PlayerPrefs["PlayerCameraPref"].',
  })
  out.firstPerson = put(`${prefix}.camera.firstPerson`, {
    value: describe(targets[0]),
    unit: 'm',
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${source}.camTargets[0] (m_LocalPosition / m_LocalRotation composed to the prefab root)`,
    fileId: doc.fileId,
    line: lineOf(asset, doc.fileId, 'camTargets'),
    note: 'UNITY SPACE, ship-root frame. The eye. Three space negates z of the position and x, y of the rotation.',
  })
  out.thirdPerson = put(`${prefix}.camera.thirdPerson`, {
    value: describe(targets[1]),
    unit: 'm',
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${source}.camTargets[1] (m_LocalPosition / m_LocalRotation composed to the prefab root)`,
    fileId: doc.fileId,
    line: lineOf(asset, doc.fileId, 'camTargets'),
    note:
      'UNITY SPACE, ship-root frame. Where `CamChanger` PARKS the camera rig on CHANGE VIEW ' +
      '(X / C) — a PARKING SPACE, NOT AN ARM. The rig does not stay here: the same GameObject ' +
      'carries a live SmoothTransformConstraint that flies it to `cam target 3rdPerson`, and a ' +
      'DelayedReparent that cuts it loose from the ship 0.25 s in. Read ' +
      '`camera.thirdPersonChase` for where the camera actually goes. DEV-128 read this as the ' +
      'whole third-person camera and DEV-150 corrected it; DEV-156 ported it.',
  })
  out.thirdPersonChase = put(`${prefix}.camera.thirdPersonChase`, {
    value: chaseOf(asset, targets[1], describe, relPath),
    unit: null,
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${relPath} components on CamChanger.camTargets[1]'s GameObject`,
    note:
      'What 2016 ACTUALLY does with the third-person camera, and it is not rigid. Four live ' +
      'components on the parked root: DelayedReparent nulls its parent 0.25 s in (so the world ' +
      'delta the ship would otherwise carry it by stops cancelling, and the damp becomes a real ' +
      'trail), a SmoothTransformConstraint SmoothDamps its WORLD position toward ' +
      '`cam target 3rdPerson`, a SmoothLookAtConstraint aims it, and FixRoll zeroes its roll ' +
      'every LateUpdate. `lookSpeed` is a `Quaternion.Slerp` t of `dt * speed` CLAMPED to 1, so ' +
      "the HoverJet's 225 is instantaneous at any frame rate at or below 225 fps and only the " +
      "JumpSeat's 35 actually smooths. `render/classic-chase.ts` is this, verbatim. DEV-156.",
  })
  out.shipArt = shipArt
  return out
}

/** `INTERP_OPTIONS_POS` and `INTERP_OPTIONS`, from the PathologicalGames source, by index. */
const POSITION_INTERPOLATION = ['Linear', 'Damp', 'DampLimited']
const ROTATION_INTERPOLATION = ['Linear', 'Spherical', 'SphericalLimited']

/**
 * The constraint stack on `CamRoot_3rdPerson`, which is what the third-person camera really is.
 *
 * DEV-156. `CamChanger.ChangeCam()` reparents the rig here rigidly, and for four sessions the port
 * read that as the whole story — the ledger even called 8.89 m "2016's own camera". It is a parking
 * space. The GameObject it parks on carries, all `m_Enabled: 1` with the whole `m_Father` chain
 * `m_IsActive: 1`:
 *
 *   - `DelayedReparent`   `Start()` → `WaitForSeconds(0.25f)` → `transform.parent = null`.
 *   - `SmoothTransformConstraint`  `Vector3.SmoothDamp` on the WORLD position toward a target.
 *   - `SmoothLookAtConstraint`     `Quaternion.Slerp` toward `Quaternion.LookRotation`.
 *   - `FixRoll`                    `LateUpdate()` → `localEulerAngles = (x, y, 0)`.
 *
 * `DelayedReparent` is the load-bearing one and it is easy to miss, because without it the whole
 * stack is a no-op at steady state: a transform CARRIED BY ITS PARENT has the same world delta
 * applied to itself and to a target parented to the same ship, so the SmoothDamp error never grows
 * and the camera converges rigidly onto the target. Detached, the error is real and the camera
 * trails by about `speed × smoothTime`. The structural fact decides the number.
 *
 * `FixRoll` is the other one worth naming: it makes 2016's third-person horizon LEVEL, always.
 * Zeroing the `z` of a ZXY euler leaves the forward vector untouched (a rotation about z fixes the
 * z axis), so it takes the bank out and leaves the aim alone.
 */
function chaseOf(asset, targetRef, describe, relPath) {
  const tf = targetRef ? asset.byId.get(String(targetRef.fileID)) : null
  if (tf?.type !== 'Transform') {
    warn(`${relPath}: camTargets[1] is not a Transform; no third-person chase extracted`)
    return null
  }
  const liveComponent = (name) => {
    const d = findScript(asset, tf, name)
    if (!d) return null
    return { doc: d, enabled: num(d.data.m_Enabled) === 1 }
  }
  // The full liveness walk: the component's own flag AND every GameObject above it.
  const chainLive = activeChainOf(asset, tf).every((c) => c.isActive === 1)
  const pos = liveComponent('SmoothTransformConstraint')
  const look = liveComponent('SmoothLookAtConstraint')
  const detach = liveComponent('DelayedReparent')
  const fixRoll = liveComponent('FixRoll')
  if (!pos) warn(`${relPath}: no unique SmoothTransformConstraint on the third-person cam root`)

  const asBool = (c) => Boolean(c?.enabled && chainLive)
  return {
    chainLive,
    position: pos
      ? {
          fileId: String(pos.doc.fileId),
          live: pos.enabled && chainLive,
          target: describe(pos.doc.data._target),
          mode: num(pos.doc.data._mode),
          constrainPosition: num(pos.doc.data.constrainPosition) === 1,
          constrainRotation: num(pos.doc.data.constrainRotation) === 1,
          outputPos: [
            num(pos.doc.data.outputPosX) === 1,
            num(pos.doc.data.outputPosY) === 1,
            num(pos.doc.data.outputPosZ) === 1,
          ],
          interpolation:
            POSITION_INTERPOLATION[num(pos.doc.data.position_interpolation)] ?? 'unknown',
          smoothTimeSeconds: num(pos.doc.data.positionSpeed),
          maxSpeed: num(pos.doc.data.positionMaxSpeed),
          line: lineOf(asset, pos.doc.fileId, 'positionSpeed'),
        }
      : null,
    look: look
      ? {
          fileId: String(look.doc.fileId),
          live: look.enabled && chainLive,
          target: describe(look.doc.data._target),
          upTarget: describe(look.doc.data.upTarget),
          pointAxis: roundDeep(vec(look.doc.data.pointAxis), 6),
          upAxis: roundDeep(vec(look.doc.data.upAxis), 6),
          interpolation: ROTATION_INTERPOLATION[num(look.doc.data.interpolation)] ?? 'unknown',
          speed: num(look.doc.data.speed),
          line: lineOf(asset, look.doc.fileId, 'speed'),
        }
      : null,
    /** `DelayedReparent`: the root is cut loose from the ship, so the damp becomes a real trail. */
    detachesFromShip: asBool(detach),
    /** `FixRoll`: the horizon is LEVEL. 2016's third person never banks. */
    zeroRoll: asBool(fixRoll),
  }
}

/**
 * The decoy, read on purpose. `PlayerShip_SR14_unet.prefab` has identical flight physics and the
 * OPPOSITE glider_lockRollAndYaw, and reproducing _CORRECTIONS.md C1 means opening this file by
 * mistake. Extract it, diff it against the shipped prefab, and make the difference an assertion so
 * the trap can never be re-sprung silently.
 */
function extractDecoyComparison(shippedRel, decoyRel) {
  if (!unityExists(decoyRel)) return null
  const shipped = loadAsset(shippedRel)
  const decoy = loadAsset(decoyRel)
  const shippedRoot = rootTransformOf(shipped)
  const decoyRoot = rootTransformOf(decoy)

  const inputOf = (asset, root) => {
    const hits = componentsOf(asset, root).filter(
      (d) => d.type === 'MonoBehaviour' && (scriptName(d) ?? '').startsWith('Input_Ship'),
    )
    return hits[0] ?? null
  }
  const shipOf = (asset, root) => {
    const hits = componentsOf(asset, root).filter(
      (d) => d.type === 'MonoBehaviour' && (scriptName(d) ?? '').startsWith('Ship_HoverShip'),
    )
    return hits[0] ?? null
  }
  const sIn = inputOf(shipped, shippedRoot)
  const dIn = inputOf(decoy, decoyRoot)
  const sShip = shipOf(shipped, shippedRoot)
  const dShip = shipOf(decoy, decoyRoot)
  const sRb = componentsOf(shipped, shippedRoot).find((d) => d.type === 'Rigidbody')
  const dRb = componentsOf(decoy, decoyRoot).find((d) => d.type === 'Rigidbody')

  const same = {}
  for (const [k, a, b] of [
    ['mass', num(sRb?.data.m_Mass), num(dRb?.data.m_Mass)],
    ['drag', num(sRb?.data.m_Drag), num(dRb?.data.m_Drag)],
    ['angularDrag', num(sRb?.data.m_AngularDrag), num(dRb?.data.m_AngularDrag)],
    ['maxSpeed', num(sShip?.data.maxSpeed), num(dShip?.data.maxSpeed)],
    ['driftMultiplier', num(sShip?.data.driftMultiplier), num(dShip?.data.driftMultiplier)],
    ['liftMultiplier', num(sShip?.data.liftMultiplier), num(dShip?.data.liftMultiplier)],
    ['rollRate', num(sShip?.data.rollRate), num(dShip?.data.rollRate)],
    ['pitchRate', num(sShip?.data.pitchRate), num(dShip?.data.pitchRate)],
    ['yawRate', num(sShip?.data.yawRate), num(dShip?.data.yawRate)],
    ['acceleration', num(sShip?.data.acceleration), num(dShip?.data.acceleration)],
    ['airbrakeSpeed', num(sShip?.data.airbrakeSpeed), num(dShip?.data.airbrakeSpeed)],
    [
      'glider_lockRollAndYaw',
      num(sIn?.data.glider_lockRollAndYaw),
      num(dIn?.data.glider_lockRollAndYaw),
    ],
    ['rollToYawRatio', num(sIn?.data.rollToYawRatio), num(dIn?.data.rollToYawRatio)],
  ]) {
    same[k] = { shipped: a, decoy: b, identical: a === b }
  }
  return {
    shippedPrefab: shippedRel,
    decoyPrefab: decoyRel,
    shippedInputScript: sIn ? scriptName(sIn) : null,
    decoyInputScript: dIn ? scriptName(dIn) : null,
    fields: same,
    differingFields: Object.keys(same)
      .filter((k) => !same[k].identical)
      .sort(),
    note: 'The decoy is used ONLY by the two enabled multiplayer scenes. Never take a vehicle constant from it.',
  }
}

function extractJumpSeat(relPath) {
  const asset = loadAsset(relPath)
  const root = rootTransformOf(asset)
  const out = { prefab: relPath, guid: pathToGuid.get(relPath) ?? null }

  const rb = componentsOf(asset, root).find((d) => d.type === 'Rigidbody')
  if (!rb) die(`${relPath}: no Rigidbody on the prefab root`)
  out.rigidbody = extractRigidbody('jumpseat', asset, rb, 'JumpSeat')

  // Every particle system on the seat (DEV-416). Four scripts reference them
  // by fileID: `Thruster.thruster_fx` and `boost_fx`, `HoverMotor.ground_fx`
  // and `JumpSeat_EffectsManager.windEffects`, so these rows are what those
  // references resolve to. Before this the port flew the seat with the
  // HoverJet's systems.
  out.particles = scanParticleSystems(relPath)

  const scripts = [
    ['thruster', 'Thruster', 'Assets/Faceted Flight/Scripts/Gameplay/Thruster.cs'],
    // `windEffects` above `minWindEffectSpeed`, by velocity MAGNITUDE
    // (`JumpSeat_EffectsManager.cs:26-45`). DEV-416.
    [
      'effects',
      'JumpSeat_EffectsManager',
      'Assets/Faceted Flight/Scripts/JumpSeat_EffectsManager.cs',
    ],
    ['hoverMotor', 'HoverMotor', 'Assets/Faceted Flight/Scripts/HoverMotor.cs'],
    ['input', 'Input_Manager', 'Assets/Faceted Flight/Scripts/Input_Manager.cs'],
    ['fuel', 'FuelManager', 'Assets/Faceted Flight/Scripts/FuelManager.cs'],
    ['landingGear', 'LandingGearManager', 'Assets/Faceted Flight/Scripts/LandingGearManager.cs'],
    // ── how the JumpSeat turns ──────────────────────────────────────────────
    //
    // The HoverJet steers through `Ship_HoverShip` (`hoverjet.ship.rollRate`
    // 3 / `pitchRate` 3.4 / `yawRate` 2.5). The JumpSeat has no
    // `Ship_HoverShip` at all — it steers through `ShipOrientationManager`,
    // which is a different component with the SAME three field names and
    // different values. Reaching for `hoverjet.ship.*` because the names match
    // is exactly the shape of mistake the `_unet` decoy exists to warn about,
    // so the JumpSeat gets its own namespace.
    //
    // `ShipOrientationManager.cs:27-41` scales each rate by the rigidbody mass
    // and a local scale before `AddRelativeTorque`, so these are not rad/s —
    // they are torque coefficients, and the sim has to apply the same two
    // factors or the JumpSeat turns 15x too slowly.
    [
      'orientation',
      'ShipOrientationManager',
      'Assets/Faceted Flight/Scripts/ShipOrientationManager.cs',
    ],
    // ── the free-fall drag swap ─────────────────────────────────────────────
    //
    // `drag_freefall` is `public float drag_freefall = 0.3f` in C# and **0.65**
    // on the shipped prefab. Cardinal rule: the initialiser is not shipped
    // behaviour, so 0.65 is the number and the sheet carries it with its own
    // line and fileID.
    //
    // Its `m_Enabled` is 0 on the prefab and that does NOT mean it never runs:
    // `HoverMotor.cs:60-62` disables it while the hover ray finds ground and
    // `:85-90` enables it when it does not, so the component is switched on in
    // the air and off over a surface. `componentEnabled` records the AUTHORED
    // state; the caller above is why it is not the shipped one.
    ['dragHack', 'DragHack', 'Assets/Faceted Flight/Scripts/DragHack.cs'],
  ]
  for (const [key, name, csPath] of scripts) {
    const doc = findScript(asset, root, name)
    if (!doc) {
      warn(`${relPath}: no unique ${name} on the prefab root`)
      out[key] = null
      continue
    }
    out[key] = extractBehaviour(`jumpseat.${key}`, asset, doc, csPath)
  }

  const hasShipHoverShip = findScript(asset, root, 'Ship_HoverShip') !== null
  // --- the art rotator ------------------------------------------------------------------
  //
  // `Rotator_Input` on `art_pivot` is what Matt remembered as "slightly rotate
  // the ship to loosen the cockpit a bit". It leans the ART, not the ship, and
  // the camera hangs off `shipOffset` rather than the pivot — so the cockpit
  // rolls around a fixed viewpoint. See DEV-010.
  //
  // It is NOT on the prefab root, so `findScript` cannot see it.
  {
    const rotDoc = findScriptAnywhere(asset, 'Rotator_Input')
    if (!rotDoc) {
      warn(`${relPath}: no Rotator_Input; the art lean will be missing`)
      out.artRotator = null
    } else {
      out.artRotator = extractBehaviour(
        'jumpseat.artRotator',
        asset,
        rotDoc,
        'Assets/Faceted Flight/Scripts/Rotator_Input.cs',
      )
      // The curves carry the feel and the generic extractor emits them as raw
      // Unity blobs, so re-emit them in a shape the sim can evaluate.
      out.artRotator.inputCurve = animationCurve(rotDoc.data.inputCurve)
      out.artRotator.transitionCurve = animationCurve(rotDoc.data.transitionCurve)
      out.artRotator.gameObject = gameObjectName(asset, rotDoc) ?? null
    }
  }

  const hasInputShip = findScript(asset, root, 'Input_Ship') !== null
  out.hasShipHoverShip = hasShipHoverShip
  out.hasInputShip = hasInputShip

  out.colliders = extractColliders('jumpseat', asset, root)
  out.shipCollisionColliders = out.colliders.filter((c) => c.role === 'ship-collision')
  out.allRigidbodies = enumerateRigidbodies(asset, root)
  out.legs = extractLegs(asset, root)
  out.camera = extractCameraTargets('jumpseat', asset, root, relPath)
  out.art = extractJumpSeatArt(asset, root)
  out.prefabSelfModificationResidue = inertResidue(asset)
  out.centerOfMassObject = centreOfMassObject(asset, root)
  return out
}

function centreOfMassObject(asset, root) {
  for (const tf of descendants(asset, root)) {
    const name = gameObjectName(asset, tf)
    if (name !== 'cog') continue
    const { trs, chain } = composeFromRoot(asset, tf, root.fileId)
    return {
      name,
      path: chain.join('/'),
      fileId: String(tf.fileId),
      positionInShipRootSpace: roundDeep(trs.position, 6),
      note: 'Ship_HoverShip.centerOfGravity points here; Unity Rigidbody.centerOfMass is set from it at runtime.',
    }
  }
  return null
}

/** The JumpSeat's four HingeJoint legs: joint config plus the leg Rigidbody it hangs off. */
function extractLegs(asset, root) {
  const legs = []
  for (const tf of descendants(asset, root)) {
    for (const c of componentsOf(asset, tf)) {
      if (c.type !== 'HingeJoint') continue
      const go = asset.byId.get(String(tf.data?.m_GameObject?.fileID ?? '0'))
      const rb = componentsOf(asset, tf).find((d) => d.type === 'Rigidbody')
      const { trs, chain } = composeFromRoot(asset, tf, root.fileId)
      const spring = c.data.m_Spring ?? {}
      legs.push({
        name: go?.data?.m_Name ?? '?',
        jointFileId: String(c.fileId),
        parentPath: chain.slice(0, -1).join('/'),
        composedPosition: roundDeep(trs.position, 6),
        anchor: roundDeep(vec(c.data.m_Anchor), 6),
        axis: roundDeep(vec(c.data.m_Axis), 6),
        useSpring: num(c.data.m_UseSpring) === 1,
        spring: {
          spring: num(spring.spring),
          damper: num(spring.damper),
          targetPosition: num(spring.targetPosition),
        },
        useMotor: num(c.data.m_UseMotor) === 1,
        useLimits: num(c.data.m_UseLimits) === 1,
        limits: {
          min: num(c.data.m_Limits?.min),
          max: num(c.data.m_Limits?.max),
          bounciness: num(c.data.m_Limits?.bounciness ?? c.data.m_Limits?.bounceMinVelocity),
        },
        enableCollision: num(c.data.m_EnableCollision) === 1,
        breakForce: c.data.m_BreakForce,
        breakTorque: c.data.m_BreakTorque,
        rigidbody: rb
          ? {
              fileId: String(rb.fileId),
              mass: num(rb.data.m_Mass),
              drag: num(rb.data.m_Drag),
              angularDrag: num(rb.data.m_AngularDrag),
              useGravity: num(rb.data.m_UseGravity) === 1,
              isKinematic: num(rb.data.m_IsKinematic) === 1,
            }
          : null,
      })
    }
  }
  legs.sort((a, b) => (`${a.parentPath}/${a.name}` < `${b.parentPath}/${b.name}` ? -1 : 1))
  put('jumpseat.legs', {
    value: legs,
    unit: null,
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${JUMPSEAT_PREFAB_REL} (every HingeJoint under the prefab root)`,
    note: 'Cosmetic in FF2 (§2.2): four 1-DOF angular springs driven by chassis acceleration.',
  })
  return legs
}

// ---------------------------------------------------------------------------------------------
// 13d. The JumpSeat's ART: the rig its meshes hang on, and the colours its materials carry
//
// DEV-114. Everything `src/game/jumpseat-art.ts` places is read from here rather than typed: the
// composed transform of the art root, the pivot of every live submesh (Unity's OWN import of the
// FBX, which is what makes them a mirror oracle for the converted GLB), the three hover engines
// (Unity-native spheres, an asymmetric triangle), the eight leg struts, and the four `_Color`s.
//
// LIVENESS is the full `m_IsActive` chain to the prefab root, plus the renderer's `m_Enabled`.
// The prefab carries three generations of this art (`jumpseat_rough_00`, `_01`, `_02`) and a
// whole `art_thirdPerson` branch, all switched off; only what survives the walk is emitted as
// live, and the dead nodes are emitted with `live: false` so a reader can see they were counted.
// ---------------------------------------------------------------------------------------------

function extractJumpSeatArt(asset, root) {
  const rel = asset.relPath
  const goOf = (tf) => asset.byId.get(String(tf.data?.m_GameObject?.fileID ?? '0'))
  // Alive: every GameObject from this Transform to the prefab root is active, AND the chain
  // really reaches the root (a father that is not in this file means the walk cannot say).
  const activeChain = (tf) => {
    const up = chainUp(asset.byId, tf)
    return up.rootReached && chainIsLive(up.nodes)
  }
  const pathOf = (tf) => composeFromRoot(asset, tf, root.fileId).chain.join('/')
  const byPath = new Map()
  for (const tf of descendants(asset, root)) {
    const p = pathOf(tf)
    byPath.set(p, [...(byPath.get(p) ?? []), tf])
  }
  const one = (p) => {
    const hits = byPath.get(p) ?? []
    if (hits.length !== 1) die(`${rel}: expected exactly one '${p}', found ${hits.length}`)
    return hits[0]
  }
  const assetRef = (r) => {
    if (!r) return null
    const guid = r.guid ? String(r.guid) : null
    return {
      path: guid ? (resolveGuid(guid) ?? null) : null,
      guid,
      fileId: r.fileID === undefined ? null : String(r.fileID),
    }
  }
  const trsOf = (tf) => ({
    position: roundDeep(vec(tf.data.m_LocalPosition), 6),
    rotation: roundDeep(quat(tf.data.m_LocalRotation), 6),
    scale: roundDeep(vec(tf.data.m_LocalScale, 1), 6),
  })
  const composedOf = (tf) => {
    const { trs } = composeFromRoot(asset, tf, root.fileId)
    return {
      position: roundDeep(trs.position, 6),
      rotation: roundDeep(trs.rotation, 6),
      scale: roundDeep(trs.scale, 6),
      eulerZXYDeg: qToEulerZXY(trs.rotation),
    }
  }
  const renderable = (tf) => {
    const go = goOf(tf)
    const filter = componentsOf(asset, tf).find((d) => d.type === 'MeshFilter')
    const renderer = componentsOf(asset, tf).find((d) => d.type === 'MeshRenderer')
    const meshRef = filter?.data?.m_Mesh
    const builtin = meshRef && !meshRef.guid ? num(meshRef.fileID) : null
    const live = activeChain(tf) && num(renderer?.data?.m_Enabled) === 1
    return {
      name: go?.data?.m_Name ?? '?',
      path: pathOf(tf),
      gameObjectFileId: String(go?.fileId),
      transformFileId: String(tf.fileId),
      line: lineOf(asset, tf.fileId, 'm_LocalPosition'),
      active: num(go?.data?.m_IsActive) === 1,
      rendererEnabled: renderer ? num(renderer.data.m_Enabled) === 1 : null,
      live,
      mesh: builtin === null ? assetRef(meshRef) : null,
      builtinMesh: builtin,
      material: assetRef(renderer?.data?.m_Materials?.[0]) ?? null,
      local: trsOf(tf),
      composed: composedOf(tf),
    }
  }

  // ── the rig, root -> art root ────────────────────────────────────────────
  const ART_ROOT_PATH = 'offset/art_pivot (1)/art_firstPerson/testArt (2)/jumpseat_rough_01'
  const artRootTf = one(ART_ROOT_PATH)
  const chain = []
  {
    let cur = artRootTf
    while (cur && String(cur.fileId) !== String(root.fileId)) {
      const go = goOf(cur)
      chain.unshift({
        name: go?.data?.m_Name ?? '?',
        gameObjectFileId: String(go?.fileId),
        transformFileId: String(cur.fileId),
        line: lineOf(asset, cur.fileId, 'm_LocalPosition'),
        active: num(go?.data?.m_IsActive) === 1,
        local: trsOf(cur),
      })
      cur = asset.byId.get(String(cur.data?.m_Father?.fileID ?? '0'))
    }
  }
  const rootComposed = composedOf(artRootTf)
  const artRoot = put('jumpseat.art.root', {
    value: {
      path: ART_ROOT_PATH,
      gameObjectFileId: String(goOf(artRootTf)?.fileId),
      transformFileId: String(artRootTf.fileId),
      live: activeChain(artRootTf),
      composed: rootComposed,
      chain,
    },
    unit: 'm',
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${rel} ${ART_ROOT_PATH} (m_LocalPosition composed to the prefab root)`,
    fileId: artRootTf.fileId,
    line: lineOf(asset, artRootTf.fileId, 'm_LocalPosition'),
    note: 'UNITY SPACE. Identity rotation and unit scale all the way down: the JumpSeat art has NO yaw, unlike the HoverJet’s -89.988 deg — SHIP_MODEL_YAW does not carry over. The GLB is exported in three space, so the renderer flips this position’s z and applies nothing else.',
  })

  // ── the eye: where 2016 put the first-person camera ─────────────────────
  const eyeTf = one('offset/camTarget_FirstPerson')
  const eye = put('jumpseat.art.eye', {
    value: {
      path: 'offset/camTarget_FirstPerson',
      gameObjectFileId: String(goOf(eyeTf)?.fileId),
      transformFileId: String(eyeTf.fileId),
      live: activeChain(eyeTf),
      positionInShipRootSpace: composedOf(eyeTf).position,
    },
    unit: 'm',
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${rel} offset/camTarget_FirstPerson`,
    fileId: eyeTf.fileId,
    line: lineOf(asset, eyeTf.fileId, 'm_LocalPosition'),
    note: 'CamChanger.camTargets[0]. Under `offset`, NOT under `art_pivot (1)`: the art leans around a still head. The port eye (`JUMPSEAT_EYE`) sits on collider_head, 12 cm higher; both are Unity-native points in the same prefab and either pins the seat’s fore-aft handedness.',
  })

  // ── the submeshes, live and dead, under the art root ────────────────────
  const meshes = []
  for (const tf of descendants(asset, artRootTf)) {
    if (String(tf.fileId) === String(artRootTf.fileId)) continue
    const r = renderable(tf)
    if (!r.mesh && r.builtinMesh === null) continue // `jumpseat_shell_04`, an Animator-only group
    meshes.push(r)
  }
  meshes.sort((a, b) => (a.path < b.path ? -1 : 1))
  put('jumpseat.art.meshes', {
    value: meshes,
    unit: 'm',
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${rel} every MeshFilter under ${ART_ROOT_PATH}`,
    fileId: artRootTf.fileId,
    line: lineOf(asset, artRootTf.fileId, 'm_Children'),
    note: '`local.position` is Unity’s OWN reading of each FBX node’s Maya pivot — a Unity-native number the converted GLB must agree with: the file says seat x = -0.0025 and console_thing x = +0.0272, Unity says +0.0025 and -0.0272, so Unity’s importer negates x and Blender’s does not. That is the JumpSeat’s left-right mirror oracle (tests/unit/jumpseat-art.test.ts). The dead `shell` under jumpseat_rough_01 points at jumpseat_rough_02.fbx and is m_IsActive: 0; the shipped shell is jumpseat_shell_04/shell.',
  })

  // ── the three hover engines: Unity-native spheres, an asymmetric triangle ─
  const engines = []
  for (const tf of descendants(asset, one('offset/art_pivot (1)/art_firstPerson/testArt (2)'))) {
    const go = goOf(tf)
    const name = go?.data?.m_Name ?? ''
    if (!/^hover_engine \(\d\)$/.test(name)) continue
    const parts = [...descendants(asset, tf)].filter((c) => c !== tf).map(renderable)
    engines.push({
      name,
      gameObjectFileId: String(go?.fileId),
      transformFileId: String(tf.fileId),
      line: lineOf(asset, tf.fileId, 'm_LocalPosition'),
      live: activeChain(tf),
      local: trsOf(tf),
      composed: composedOf(tf),
      sphere: parts.find((p) => p.builtinMesh === 10207) ?? null,
      // `Projector04-Faceted.asset` is a VacuumShaders faceting pass over bought
      // geometry (survey FIND-jumpseat-04). Hard rule 7 as Matt revised it on
      // 2026-09-23 lets it ship from R2, never git: DEV-433 draws it, converted
      // by tools/assets/convert-jumpseat-cone.mjs and placed from this row.
      projector: parts.find((p) => p.mesh?.path?.includes('Projector04')) ?? null,
      halo: parts.some((p) => p.name === 'GameObject (1)'),
    })
  }
  engines.sort((a, b) => (a.name < b.name ? -1 : 1))
  put('jumpseat.art.engines', {
    value: engines,
    unit: 'm',
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${rel} offset/art_pivot (1)/art_firstPerson/testArt (2)/hover_engine (1..3)`,
    fileId: artRootTf.fileId,
    line: lineOf(asset, artRootTf.fileId, 'm_LocalPosition'),
    note: 'UNITY SPACE, composed to the prefab root. One aft on the centreline, two forward at x +0.31 / -0.39 — an asymmetric triangle a mirror breaks. Each is a built-in Sphere (10207) squashed to a disc in glowyMaterial, a Halo, and an upturned Projector04 cone around the disc (bought geometry, shipped from R2 since hard rule 7’s revision; DEV-433).',
  })

  // ── the leg struts: hexTile.fbx, eight live renderers on four hinged legs ─
  const legStruts = []
  for (const tf of descendants(asset, root)) {
    const r = renderable(tf)
    if (!r.mesh?.path?.endsWith('hexTile.fbx')) continue
    const leg = r.path.split('/').slice(0, -1).join('/')
    legStruts.push({ leg, ...r })
  }
  legStruts.sort((a, b) => (a.path < b.path ? -1 : 1))
  put('jumpseat.art.legStruts', {
    value: legStruts,
    unit: 'm',
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${rel} every MeshFilter referencing Assets/Faceted Flight/Meshes/hexTile.fbx`,
    fileId: root.fileId,
    line: lineOf(asset, root.fileId, 'm_Children'),
    note: '`local` is in the LEG rigidbody’s frame — `jumpseat.art.legFrames`, composed to the prefab root — and `composed` is that frame times `local`. Eight are live (renderer enabled, chain active), two per hinged leg; the rest are counted and marked. hexTile’s own mesh runs y 0.003..0.503 (Unity import scale 0.1), so a strut grows UP its local y from its origin rather than being centred on it.',
  })

  // ── the four leg frames the struts hang in (DEV-433) ────────────────────
  //
  // Each live strut is a child of a leg RIGIDBODY — the GameObject carrying the
  // HingeJoint — and 2016 draws it at `local` in that body's frame, so the frame
  // swings with the hinge and both struts ride it. `jumpseat.legs` carries the
  // body's composed POSITION; this is its composed POSITION AND ROTATION, which
  // is what the art needs to place the eight struts where the prefab authors
  // them instead of deriving one from the sim's hinge-to-foot line. Read, not
  // derived: every link of the chain from the root composes, and the extractor
  // refuses a strut parent that is not a jointed rigidbody.
  const legFrames = []
  for (const legPath of [...new Set(legStruts.filter((s) => s.live).map((s) => s.leg))].sort()) {
    const tf = one(legPath)
    const kinds = componentsOf(asset, tf).map((d) => d.type)
    if (!kinds.includes('HingeJoint') || !kinds.includes('Rigidbody')) {
      die(`${rel}: a live hexTile strut hangs off '${legPath}', which is not a hinged rigidbody`)
    }
    const go = goOf(tf)
    legFrames.push({
      name: go?.data?.m_Name ?? '?',
      path: legPath,
      gameObjectFileId: String(go?.fileId),
      transformFileId: String(tf.fileId),
      line: lineOf(asset, tf.fileId, 'm_LocalPosition'),
      live: activeChain(tf),
      local: trsOf(tf),
      composed: composedOf(tf),
    })
  }
  put('jumpseat.art.legFrames', {
    value: legFrames,
    unit: 'm',
    trust: 'verified',
    origin: 'shipped-prefab',
    source: `${rel} the four leg rigidbodies (HingeJoint GameObjects) the live hexTile struts hang off`,
    fileId: root.fileId,
    line: lineOf(asset, root.fileId, 'm_Children'),
    note: 'UNITY SPACE, composed to the prefab root: the frame `jumpseat.art.legStruts[].local` is in, at the hinge’s rest angle. `composed.position` is `jumpseat.legs[].composedPosition`; the hinge is `jumpseat.legs[].anchor` / `axis` in this frame. Unit scale on all four. game/jumpseat-art.ts swings it about that hinge by the angle the sim holds.',
  })

  // ── the four colours the port paints by name ────────────────────────────
  //
  // `DarkGrey.mat` and `OrangeSmooth.mat` are licence-blocked as ASSETS — a
  // vendor pack and Unity's own SampleScenes — and their `_Color`s are numbers
  // (DEV-111 §4). `lambert1.mat` here is `Meshes/Materials/lambert1.mat`, NOT
  // the `lowPolyArt/Materials/` one `render/lambert1.ts` carries for the
  // HoverJet: seven files share the basename and `boxes` wears this one.
  const colours = {}
  const COLOURS = [
    ['darkGrey', 'Assets/CactusPack/Meshes/Materials/DarkGrey.mat', 'seat, console_thing, botton'],
    ['orangeSmooth', 'Assets/SampleScenes/Materials/OrangeSmooth.mat', 'jumpseat_shell_04/shell'],
    ['lambert1Meshes', 'Assets/Faceted Flight/Meshes/Materials/lambert1.mat', 'boxes'],
    ['grey', 'Assets/Faceted Flight/Materials/grey.mat', 'the eight hexTile leg struts'],
  ]
  for (const [key, matRel, wornBy] of COLOURS) {
    const c = materialColour(matRel, '_Color')
    if (!c) die(`${matRel}: no _Color (check the YAML dialect before believing that)`)
    const shaderGuid = loadAsset(matRel).docs[0]?.data?.m_Shader?.guid
    colours[key] = put(`jumpseat.art.colors.${key}`, {
      value: c,
      unit: 'sRGB 0..1, as serialised',
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${matRel} m_SavedProperties.m_Colors._Color`,
      fileId: '2100000',
      line: null,
      note: `Worn by ${wornBy}. Shader ${shaderGuid ? (resolveGuid(String(shaderGuid)) ?? shaderGuid) : '?'} — never ported; the colour is the whole of what crosses.`,
    })
  }

  return { prefab: rel, root: artRoot, eye, meshes, engines, legStruts, legFrames, colors: colours }
}

const JUMPSEAT_PREFAB_REL = 'Assets/Faceted Flight/Resources/JumpSeat_Photon.prefab'

// ---------------------------------------------------------------------------------------------
// 14. Derived values — ONE drag model, stated, applied everywhere
// ---------------------------------------------------------------------------------------------

const DRAG_MODEL = 'unity-multiply'
const DRAG_MODEL_FORMULA = 'v *= clamp01(1 - drag * dt)   [Unity 5 Rigidbody.drag]'

function dragFactor(k, dt) {
  return Math.max(0, Math.min(1, 1 - k * dt))
}
/** Fixed point of v' = (v + a*dt) * (1 - k*dt). */
function terminalSpeed(a, k, dt) {
  const f = dragFactor(k, dt)
  return (a * dt * f) / (1 - f)
}
/** Continuous-time equivalent of a per-tick multiplicative retention. */
function perTickToRate(fraction, dt) {
  return -Math.log(1 - fraction) / dt
}

function extractDerived(model) {
  const dt = model.world.fixedDeltaTime
  const g = -model.world.gravity.y
  const d = {}

  d.dragModel = put('derived.dragModel', {
    value: DRAG_MODEL,
    unit: null,
    trust: 'derived',
    origin: 'computed',
    source: 'PORT_PLAN.md §4.3 / adr/0005',
    formula: DRAG_MODEL_FORMULA,
    note: "The loser is v /= (1 + drag*dt), which yields 91.15 / 182.29. Every derived number in this file uses 'unity-multiply'; do not mix.",
  })
  d.tickRateHz = put('derived.tickRateHz', {
    value: round(1 / dt, 6),
    unit: 'Hz',
    trust: 'derived',
    origin: 'computed',
    source: 'world.fixedDeltaTime',
    formula: '1 / dt',
  })
  d.dragRetentionPerTick = put('derived.dragRetentionPerTick', {
    value: round(dragFactor(model.hoverjet.rigidbody.drag, dt), 9),
    unit: null,
    trust: 'derived',
    origin: 'computed',
    source: 'hoverjet.rigidbody.drag, world.fixedDeltaTime',
    formula: 'clamp01(1 - drag * dt)',
  })

  // --- HoverJet -------------------------------------------------------------------------------
  const hj = model.hoverjet
  const mass = hj.rigidbody.mass
  const thrustN = hj.ship?.maxSpeed
  const boost = hj.ship?.boostMultiplier
  const k = hj.rigidbody.drag

  if (typeof thrustN === 'number' && typeof boost === 'number') {
    const aCruise = thrustN / mass
    const aBoost = aCruise * boost
    d.hoverjet = {}
    d.hoverjet.thrustNewtons = put('derived.hoverjet.thrustNewtons', {
      value: thrustN,
      unit: 'N',
      trust: 'derived',
      origin: 'computed',
      source: 'hoverjet.ship.maxSpeed',
      formula: 'AddRelativeForce(thrustDirection * enginePower * boostValue, ForceMode.Force)',
      note: '`maxSpeed` is a force in newtons, not a speed. The field name is a lie; the units are not.',
    })
    d.hoverjet.accelCruise = put('derived.hoverjet.accelCruise', {
      value: round(aCruise, 6),
      unit: 'm/s^2',
      trust: 'derived',
      origin: 'computed',
      source: 'hoverjet.ship.maxSpeed / hoverjet.rigidbody.mass',
      formula: 'a = F / m',
    })
    d.hoverjet.accelBoost = put('derived.hoverjet.accelBoost', {
      value: round(aBoost, 6),
      unit: 'm/s^2',
      trust: 'derived',
      origin: 'computed',
      source: 'derived.hoverjet.accelCruise * hoverjet.ship.boostMultiplier',
      formula: 'a = F * boostMultiplier / m',
    })
    d.hoverjet.terminalSpeedCruise = put('derived.hoverjet.terminalSpeedCruise', {
      value: round(terminalSpeed(aCruise, k, dt), 4),
      unit: 'm/s',
      trust: 'derived',
      origin: 'computed',
      source: 'derived.hoverjet.accelCruise, hoverjet.rigidbody.drag, world.fixedDeltaTime',
      formula: 'v_inf = a*dt*f / (1 - f),  f = clamp01(1 - drag*dt)   [== a*(1-drag*dt)/drag]',
      note: 'Gravity is OFF in flight, so this is a pure thrust/drag fixed point.',
    })
    d.hoverjet.terminalSpeedBoost = put('derived.hoverjet.terminalSpeedBoost', {
      value: round(terminalSpeed(aBoost, k, dt), 4),
      unit: 'm/s',
      trust: 'derived',
      origin: 'computed',
      source: 'derived.hoverjet.accelBoost, hoverjet.rigidbody.drag, world.fixedDeltaTime',
      formula: 'v_inf = a*dt*f / (1 - f),  f = clamp01(1 - drag*dt)',
    })
  }

  const drift = hj.ship?.driftMultiplier
  const lift = hj.ship?.liftMultiplier
  if (typeof drift === 'number' && typeof lift === 'number') {
    const rDrag = perTickToRate(k * dt, dt)
    const rDrift = perTickToRate(drift, dt)
    const rLift = perTickToRate(lift, dt)
    d.bleed = {}
    d.bleed.dragRateContinuous = put('derived.bleed.dragRateContinuous', {
      value: round(rDrag, 6),
      unit: '1/s',
      trust: 'derived',
      origin: 'computed',
      source: 'hoverjet.rigidbody.drag, world.fixedDeltaTime',
      formula: '-ln(1 - drag*dt) / dt',
      note: 'Nominal drag is 1.2/s; the discrete multiply makes it 1.2089/s. Use the effective number.',
    })
    d.bleed.driftRateContinuous = put('derived.bleed.driftRateContinuous', {
      value: round(rDrift, 6),
      unit: '1/s',
      trust: 'derived',
      origin: 'computed',
      source: 'hoverjet.ship.driftMultiplier, world.fixedDeltaTime',
      formula: '-ln(1 - driftMultiplier) / dt',
      note: 'Body-X velocity deleted every tick, BEFORE the PhysX integrate. This plus lift IS the signature feel.',
    })
    d.bleed.liftRateContinuous = put('derived.bleed.liftRateContinuous', {
      value: round(rLift, 6),
      unit: '1/s',
      trust: 'derived',
      origin: 'computed',
      source: 'hoverjet.ship.liftMultiplier, world.fixedDeltaTime',
      formula: '-ln(1 - liftMultiplier) / dt',
    })
    const totalX = rDrift + rDrag
    const totalY = rLift + rDrag
    d.bleed.observedRateBodyX = put('derived.bleed.observedRateBodyX', {
      value: round(totalX, 6),
      unit: '1/s',
      trust: 'derived',
      origin: 'computed',
      source: 'derived.bleed.driftRateContinuous + derived.bleed.dragRateContinuous',
      formula: 'drift + drag  (a real trajectory decays under BOTH)',
    })
    d.bleed.observedRateBodyY = put('derived.bleed.observedRateBodyY', {
      value: round(totalY, 6),
      unit: '1/s',
      trust: 'derived',
      origin: 'computed',
      source: 'derived.bleed.liftRateContinuous + derived.bleed.dragRateContinuous',
      formula: 'lift + drag',
    })
    d.bleed.observedRateBodyZ = put('derived.bleed.observedRateBodyZ', {
      value: round(rDrag, 6),
      unit: '1/s',
      trust: 'derived',
      origin: 'computed',
      source: 'derived.bleed.dragRateContinuous',
      formula: 'drag only — nothing bleeds body-Z',
    })
    const hl = (r) => round((Math.log(2) / r) * 1000, 2)
    d.bleed.halfLifeBodyXms = put('derived.bleed.halfLifeBodyXms', {
      value: hl(totalX),
      unit: 'ms',
      trust: 'derived',
      origin: 'computed',
      source: 'derived.bleed.observedRateBodyX',
      formula: '1000 * ln2 / rate',
    })
    d.bleed.halfLifeBodyYms = put('derived.bleed.halfLifeBodyYms', {
      value: hl(totalY),
      unit: 'ms',
      trust: 'derived',
      origin: 'computed',
      source: 'derived.bleed.observedRateBodyY',
      formula: '1000 * ln2 / rate',
    })
    d.bleed.halfLifeBodyZms = put('derived.bleed.halfLifeBodyZms', {
      value: hl(rDrag),
      unit: 'ms',
      trust: 'derived',
      origin: 'computed',
      source: 'derived.bleed.observedRateBodyZ',
      formula: '1000 * ln2 / rate',
    })
    d.bleed.anisotropyXZ = put('derived.bleed.anisotropyXZ', {
      value: round(totalX / rDrag, 4),
      unit: null,
      trust: 'derived',
      origin: 'computed',
      source: 'derived.bleed.observedRateBodyX / derived.bleed.observedRateBodyZ',
      formula: '(drift + drag) / drag',
      note: 'THE single feel metric (PORT_PLAN §4.3). A drift-only-over-drag-only ratio (3.1) is a number no trajectory exhibits.',
    })
  }

  // --- energy ---------------------------------------------------------------------------------
  const en = model.hoverjet.energy
  if (en && typeof en.rechargeRate === 'number' && typeof en.engineBurnrate === 'number') {
    // EnergySystem_Ship.cs:144 -> Burn(engineBurnrate * BoostBurnrate * Time.deltaTime)
    const burn = en.engineBurnrate * num(en.BoostBurnrate, 1)
    d.energy = {}
    d.energy.boostBurnPerSecond = put('derived.energy.boostBurnPerSecond', {
      value: round(burn, 6),
      unit: 'energy/s',
      trust: 'derived',
      origin: 'computed',
      source: 'hoverjet.energy.engineBurnrate * hoverjet.energy.BoostBurnrate',
      formula: 'Burn(engineBurnrate * BoostBurnrate * Time.deltaTime)  [EnergySystem_Ship.cs:144]',
      note: 'The two serialized fields multiply; neither alone is the burn rate.',
    })
    d.energy.netWhileBoosting = put('derived.energy.netWhileBoosting', {
      value: round(en.rechargeRate - burn, 6),
      unit: 'energy/s',
      trust: 'derived',
      origin: 'computed',
      source: 'hoverjet.energy.rechargeRate - derived.energy.boostBurnPerSecond',
      formula: 'rechargeRate - engineBurnrate * BoostBurnrate',
      note: 'Positive => boost is effectively free and the reboot subsystem is unreachable. DEV-002 KEEPS this deliberately.',
    })
    d.energy.secondsOfBoostFromFull = put('derived.energy.secondsOfBoostFromFull', {
      value:
        en.rechargeRate - burn >= 0 ? null : round(num(en.maxEnergy) / (burn - en.rechargeRate), 4),
      unit: 's',
      trust: 'derived',
      origin: 'computed',
      source: 'hoverjet.energy.maxEnergy, derived.energy.netWhileBoosting',
      formula: 'net >= 0 ? null (never depletes) : maxEnergy / (burn - recharge)',
      note: 'null is the shipped answer: boost never runs out.',
    })
  }

  // --- JumpSeat --------------------------------------------------------------------------------
  const js = model.jumpseat
  const jsThrust = js.thruster?.thrusterForce ?? js.thruster?.thrustForce ?? js.thruster?.power
  if (typeof jsThrust === 'number' && js.rigidbody) {
    const a = jsThrust / js.rigidbody.mass
    d.jumpseat = {}
    d.jumpseat.accelFromThrust = put('derived.jumpseat.accelFromThrust', {
      value: round(a, 6),
      unit: 'm/s^2',
      trust: 'derived',
      origin: 'computed',
      source: 'jumpseat.thruster (force) / jumpseat.rigidbody.mass',
      formula: 'a = F / m',
    })
    d.jumpseat.netAccelAgainstGravity = put('derived.jumpseat.netAccelAgainstGravity', {
      value: round(a - g, 6),
      unit: 'm/s^2',
      trust: 'derived',
      origin: 'computed',
      source: 'derived.jumpseat.accelFromThrust, world.gravity',
      formula: 'a - |g|',
      note: 'The JumpSeat flies with gravity ON, unlike the HoverJet.',
    })
    d.jumpseat.terminalClimbRate = put('derived.jumpseat.terminalClimbRate', {
      value: round(terminalSpeed(a - g, js.rigidbody.drag, dt), 4),
      unit: 'm/s',
      trust: 'derived',
      origin: 'computed',
      source:
        'derived.jumpseat.netAccelAgainstGravity, jumpseat.rigidbody.drag, world.fixedDeltaTime',
      formula: 'v_inf = a_net*dt*f / (1 - f)',
    })
  }
  const hm = model.jumpseat.hoverMotor
  if (hm && typeof hm.hoverForce === 'number' && typeof hm.hoverHeight === 'number') {
    // HoverMotor.FixedUpdate: p = (h - d)/h; AddForce(up * p*p * hoverForce, ForceMode.Impulse)
    // Impulse => dv = F/m per tick. Equilibrium: p^2 * hoverForce / m == g * dt.
    const p2 = (g * dt * js.rigidbody.mass) / hm.hoverForce
    const settle = p2 >= 0 && p2 <= 1 ? hm.hoverHeight * (1 - Math.sqrt(p2)) : null
    d.jumpseat = d.jumpseat ?? {}
    d.jumpseat.hoverEquilibriumHeight = put('derived.jumpseat.hoverEquilibriumHeight', {
      value: settle === null ? null : round(settle, 4),
      unit: 'm',
      trust: 'derived',
      origin: 'computed',
      source:
        'jumpseat.hoverMotor.hoverForce, jumpseat.hoverMotor.hoverHeight, jumpseat.rigidbody.mass, world.gravity, world.fixedDeltaTime',
      formula:
        'p = (hoverHeight - d)/hoverHeight;  AddForce(up * p^2 * hoverForce, Impulse) => dv = p^2*hoverForce/m.  Equilibrium p^2*hoverForce/m = |g|*dt  =>  d = hoverHeight * (1 - sqrt(|g|*dt*m/hoverForce))',
      note: 'ForceMode.Impulse, so the per-tick velocity change is p^2*hoverForce/m and dt does NOT divide it — but the gravity it opposes IS per-tick, hence |g|*dt on the right. Formula read from HoverMotor.cs:63-67. PORT_PLAN §3 writes "AddForce(up * p^2 * 3.5, Impulse)": 3.5 is the HoverJet\'s hoverForce, and the plan pairs it with the JumpSeat sentence — check which vehicle you are reading.',
    })
  }

  return d
}

// ---------------------------------------------------------------------------------------------
// 15. Document assembly, structural assertions, emit
// ---------------------------------------------------------------------------------------------

function buildDocument(model) {
  const errors = []
  const S = model.structural

  const missionRows = S.scenes.filter((r) => r.kind === 'mission')
  const hoverRows = missionRows.filter((r) => r.scene.includes('hoverJet'))
  const jumpRows = missionRows.filter((r) => r.scene.includes('jumpSeat'))

  const check = (name, ok, detail) => {
    S.assertions = S.assertions ?? []
    S.assertions.push({ name, ok, detail })
    if (!ok) errors.push(`${name}: ${detail}`)
  }

  check(
    'every shipped HoverJet mission spawns PlayerShip_SR14_Photon.prefab',
    hoverRows.length > 0 &&
      hoverRows.every(
        (r) => r.shipPrefabPath === 'Assets/Faceted Flight/Resources/PlayerShip_SR14_Photon.prefab',
      ),
    `${hoverRows.length} scenes; distinct prefabs = ${JSON.stringify([...new Set(hoverRows.map((r) => r.shipPrefabPath))])}`,
  )
  check(
    'every shipped JumpSeat mission spawns JumpSeat_Photon.prefab',
    jumpRows.length > 0 &&
      jumpRows.every(
        (r) => r.shipPrefabPath === 'Assets/Faceted Flight/Resources/JumpSeat_Photon.prefab',
      ),
    `${jumpRows.length} scenes; distinct prefabs = ${JSON.stringify([...new Set(jumpRows.map((r) => r.shipPrefabPath))])}`,
  )
  // The brief's "zero per-scene physics overrides" is TRUE but the obvious way to test it is FALSE:
  // 7 of the 13 shipped missions really do contain an edit-time prefab instance of a player ship.
  // Every one is m_IsActive: 0 — dormant editor residue — and every modification is transform,
  // ordering, tag or Photon-viewId. The assertion has to be about the PROPERTY SET, not the count.
  const shipInstances = S.sceneShipPrefabInstances.filter((i) => i.sceneKind === 'mission')
  const withPhysicsMods = shipInstances.filter((i) => i.physicsRelevantModifications.length > 0)
  check(
    'no shipped MISSION scene modifies a physics-relevant property of a player-ship prefab instance',
    withPhysicsMods.length === 0,
    `${shipInstances.length} edit-time ship instances across the shipped scenes; ${withPhysicsMods.length} carry a modification outside the transform/active/tag/photon allowlist: ${JSON.stringify(
      withPhysicsMods.map((i) => ({
        scene: i.scene,
        prefab: i.prefabPath,
        props: i.physicsRelevantModifications.map((m) => m.propertyPath),
      })),
    )}`,
  )
  const activeShipInstances = shipInstances.filter((i) => i.instanceActive)
  check(
    'every edit-time player-ship instance in a shipped MISSION scene is INACTIVE (the flying ship is spawned at runtime by Level.InstantiatePlayerShip)',
    activeShipInstances.length === 0,
    `${shipInstances.length} instances; active: ${JSON.stringify(activeShipInstances.map((i) => `${i.scene} -> ${i.prefabPath}`))}`,
  )
  const mpInstances = S.sceneShipPrefabInstances.filter((i) => i.sceneKind === 'multiplayer')
  check(
    'the multiplayer scenes are the ONLY place PlayerShip_SR14_unet.prefab appears (informational — never a constants source)',
    mpInstances.every((i) => (i.prefabPath ?? '').includes('_unet')),
    `${mpInstances.length} multiplayer ship instances: ${JSON.stringify(mpInstances.map((i) => `${i.scene} -> ${i.prefabPath} (active=${i.instanceActive})`))}`,
  )
  const delays = [
    ...new Set(missionRows.map((r) => (r.playerBoundary ? r.playerBoundary.resetDelay : 'none'))),
  ]
  check(
    'PlayerBoundary.resetDelay is 13 in every shipped mission that has one',
    delays.filter((x) => x !== 'none').every((x) => x === 13),
    `distinct resetDelay values across ${missionRows.length} shipped missions = ${JSON.stringify(delays)}`,
  )
  const boundaryEnabled = missionRows.filter((r) => r.playerBoundary?.enabled).length
  const boundaryPresent = missionRows.filter((r) => r.playerBoundary).length
  check(
    'PlayerBoundary is disabled in 5 of 13 shipped missions',
    boundaryPresent - boundaryEnabled === 5 && boundaryPresent === 13,
    `present in ${boundaryPresent}, enabled in ${boundaryEnabled}, disabled in ${boundaryPresent - boundaryEnabled}`,
  )
  // --- the launch reveal ---------------------------------------------------------------------
  //
  // §4.7: a structural claim needs a receipt, and this one would otherwise rest on a single
  // prefab read. The claim is NOT "every rig agrees" — three rigs carry the trigger 95 m lower,
  // in a different frame, from an older generation of the prefab. It is "every rig whose copy is
  // LIVE agrees", which is what makes the reveal height a global constant instead of level data.
  const lr = S.launchReveal
  const liveRows = lr ? lr.census.filter((c) => c.live && c.localY !== null) : []
  check(
    'the launch-reveal trigger sits at the same height in every shipped mission whose copy of it is LIVE',
    lr?.agree === true && liveRows.length > 1,
    lr === null
      ? 'no launch reveal extracted'
      : `${liveRows.length} live and in-frame of ${lr.census.length} copies; heights in ${LAUNCH_FRAME} = ${JSON.stringify(lr.liveLocalYs)}; live but out of frame = ${JSON.stringify(lr.liveOutsideFrame)}; dead = ${JSON.stringify(
          lr.census
            .filter((c) => !c.live)
            .map(
              (c) =>
                `${(c.scene ?? '?').split('/').pop()} y=${c.localY} frame=${c.frame} enabled=${c.componentEnabled} active=${JSON.stringify(c.isActiveChain)}`,
            ),
        )}`,
  )
  check(
    "Trigger_EnableTerrain's TERRAIN reference is null in every shipped mission (DEV-094: the port finishes the sentence)",
    lr !== null && lr.census.length > 0 && lr.census.every((c) => !c.terrainWired),
    lr === null
      ? 'no launch reveal extracted'
      : `wired in ${JSON.stringify(lr.census.filter((c) => c.terrainWired).map((c) => c.scene))} of ${lr.census.length}`,
  )
  check(
    'the _unet decoy is confined to multiplayer scenes',
    !missionRows.some((r) => (r.shipPrefabPath ?? '').includes('_unet')),
    `multiplayer prefabs = ${JSON.stringify(S.shipPrefabsUsedByMultiplayer)}`,
  )
  check(
    'HoverJet prefab carries no Thruster (Thruster is the JumpSeat vehicle script)',
    model.hoverjet.hasThruster === false,
    `hasThruster = ${model.hoverjet.hasThruster}`,
  )
  check(
    'JumpSeat prefab carries Input_Manager, not Input_Ship (so glider_lockRollAndYaw does not exist on it)',
    model.jumpseat.hasInputShip === false && model.jumpseat.input !== null,
    `hasInputShip = ${model.jumpseat.hasInputShip}, hasShipHoverShip = ${model.jumpseat.hasShipHoverShip}`,
  )
  const dc = S.decoyComparison
  check(
    'PlayerShip_SR14_unet.prefab differs from the shipped prefab ONLY in glider_lockRollAndYaw (the C1 trap, pinned)',
    dc !== null &&
      dc.differingFields.length === 1 &&
      dc.differingFields[0] === 'glider_lockRollAndYaw',
    dc === null
      ? 'decoy prefab not found'
      : `differing fields = ${JSON.stringify(dc.differingFields)}; shipped ${dc.shippedInputScript} = ${dc.fields.glider_lockRollAndYaw.shipped}, decoy ${dc.decoyInputScript} = ${dc.fields.glider_lockRollAndYaw.decoy}`,
  )
  check(
    'prefab-asset self-modification residue is present and IGNORED (see PREFAB_SELF_MODIFICATION_TRAP)',
    true,
    `hoverjet residue = ${JSON.stringify(model.hoverjet.prefabSelfModificationResidue)}; jumpseat residue = ${JSON.stringify(model.jumpseat.prefabSelfModificationResidue)}`,
  )

  // --- terrain -----------------------------------------------------------------------------
  // The four shipped environments, and the two ways the chain could be lying. `terrain` is keyed
  // by environment id, each holding one or more named FacetedTerrain instances.
  // ENVIRONMENTS only. `model.terrain` also carries the title screen's alpine
  // valley (`menu`), which is a `FacetedTerrain` on a Menus prefab with no
  // environment scene, no mission and no Skyshop IBL — so every check below
  // that is phrased "every shipped environment..." would be false of it for
  // reasons that are not defects. It has its own checks further down.
  const envs = Object.keys(model.terrain)
    .filter((e) => model.terrain[e].crossCheck !== null)
    .sort()
  const terrainRows = envs.flatMap((e) =>
    Object.keys(model.terrain[e].terrains)
      .sort()
      .map((leaf) => ({ env: e, leaf, t: model.terrain[e].terrains[leaf], rec: model.terrain[e] })),
  )
  // ── the title screen's valley ────────────────────────────────────────────
  const menu = model.terrain.menu?.terrains ?? {}
  const menuLeaf = Object.values(menu)[0] ?? null
  check(
    "the title screen's alpine valley extracted, with its own maps and parameters",
    menuLeaf !== null &&
      menuLeaf.sourceHeightMap !== null &&
      menuLeaf.sourceColorMap !== null &&
      menuLeaf.terrainSize === 4096 &&
      menuLeaf.terrainHeight === 1024,
    menuLeaf
      ? `menu: ${menuLeaf.terrainSize} m / ${menuLeaf.terrainHeight} m high, ${menuLeaf.sourceHeightMap}`
      : 'no menu terrain extracted',
  )

  check(
    'every shipped environment (from LoadLevelArt.levelName) yielded at least one FacetedTerrain',
    envs.length === 4 && terrainRows.length >= envs.length,
    `environments = ${JSON.stringify(envs)}; instances = ${JSON.stringify(terrainRows.map((r) => r.t.key))}`,
  )
  check(
    'LevelArt_SimonetIslands carries TWO FacetedTerrain components — the 4 km island group and a separate 32 km ocean plate — and both are emitted',
    (model.terrain.simonet?.terrains?.islands?.terrainSize ?? null) === 4096 &&
      (model.terrain.simonet?.terrains?.ocean?.terrainSize ?? null) === 32768,
    `simonet instances = ${JSON.stringify(
      Object.entries(model.terrain.simonet?.terrains ?? {}).map(
        ([k, v]) => `${k}: ${v.terrainSize} m / ${v.chunkSize} m chunks`,
      ),
    )}`,
  )
  const overridden = terrainRows.filter((r) => r.rec.crossCheck.fieldModifications.length > 0)
  check(
    'no shipped environment SCENE overrides a FacetedTerrain field on its level-art prefab instance (the last link of the cardinal-rule chain)',
    overridden.length === 0,
    `${JSON.stringify(
      envs.map((e) => `${e}: ${model.terrain[e].crossCheck.fieldModifications.length}`),
    )}`,
  )
  // Reading a prefab is only sound when the environment scene actually instantiates it. Alpine's
  // does NOT — it holds its own copy of the level art — so Alpine's origin is scene-component and
  // LevelArt_AlpineForest.prefab is an authoring asset nothing loads.
  const unloadable = envs.filter(
    (e) =>
      model.terrain[e].origin === 'shipped-prefab' &&
      model.terrain[e].crossCheck.instantiatesLevelArtPrefab !== true,
  )
  check(
    'every environment reads its terrain from the scene LoadLevelArt loads, or from a prefab that scene demonstrably instantiates (m_ParentPrefab, not a filename that happens to match)',
    unloadable.length === 0,
    `${JSON.stringify(
      envs.map(
        (e) =>
          `${e}: ${model.terrain[e].origin}, scene instantiates its level-art prefab = ${model.terrain[e].crossCheck.instantiatesLevelArtPrefab}`,
      ),
    )}`,
  )
  const divergent = envs.filter((e) => model.terrain[e].crossCheck.prefabDifferences.length > 0)
  check(
    'where a scene keeps its own copy of the component AND a same-named prefab exists (Alpine), the two agree field for field',
    divergent.length === 0,
    `${JSON.stringify(
      envs.map(
        (e) =>
          `${e}: ${model.terrain[e].crossCheck.inlineFacetedTerrainCount} in the scene, ${model.terrain[e].crossCheck.prefabDifferences.length} differing from the prefab`,
      ),
    )}`,
  )
  const badGrid = terrainRows.filter(
    (r) =>
      r.t.chunkPerSide * r.t.chunkSize !== r.t.terrainSize ||
      r.t.quadPerChunk * r.t.baseResolution !== r.t.chunkSize,
  )
  check(
    'every terrain divides exactly into chunks and quads (TerrainSize % ChunkSize == 0, ChunkSize % BaseResolution == 0)',
    badGrid.length === 0,
    `${badGrid.length} ragged: ${JSON.stringify(badGrid.map((r) => r.t.key))}`,
  )
  const unresolvedMaps = terrainRows.filter(
    (r) => r.t.sourceHeightMap === null || r.t.sourceColorMap === null,
  )
  check(
    'every FacetedTerrain names a source height map and colour map that the guid index can resolve',
    unresolvedMaps.length === 0,
    `${unresolvedMaps.length} unresolved: ${JSON.stringify(
      unresolvedMaps.map((r) => `${r.t.key}: ${r.t.sourceHeightMapGuid}/${r.t.sourceColorMapGuid}`),
    )}`,
  )

  const docCrossCheck = compareAgainstDocs()
  const disagreements = docCrossCheck.filter((r) => !r.agrees)
  S.docCrossCheck = docCrossCheck
  check(
    'the extracted values agree with every number the audits and the plan published',
    disagreements.length === 0,
    `${disagreements.length} of ${docCrossCheck.length} claims disagree: ${JSON.stringify(
      disagreements.map(
        (r) =>
          `${r.key}: doc says ${JSON.stringify(r.docClaim)}, prefab says ${JSON.stringify(r.extracted)} (${r.doc})`,
      ),
    )}`,
  )

  const flat = {}
  for (const key of [...entries.keys()].sort()) flat[key] = entries.get(key)

  return {
    meta: {
      tool: 'tools/extract/constants.mjs',
      toolVersion: TOOL_VERSION,
      unityProject: 'FF Backup - Update 02 (read-only)',
      unityVersion: readUnityVersion(),
      dragModel: DRAG_MODEL,
      dragModelFormula: DRAG_MODEL_FORMULA,
      cardinalRule:
        'shipped scene -> Level.ShipPrefab guid -> guid index -> prefab component -> per-scene m_Modifications. Never a .cs initialiser.',
      prefabSelfModificationTrap: PREFAB_SELF_MODIFICATION_TRAP,
      warnings: warnings.slice().sort(),
      errors: errors.slice().sort(),
      counts: {
        entries: Object.keys(flat).length,
        unused: unused.length,
        shippedEnvironments: envs.length,
        facetedTerrains: terrainRows.length,
        shippedMissionScenes: missionRows.length,
        shippedMultiplayerScenes: S.scenes.filter((r) => r.kind === 'multiplayer').length,
      },
    },
    world: plainOf(model.world),
    boundary: plainOf(model.boundary),
    launch: plainOf(model.launch),
    fade: plainOf(model.fade),
    hoverjet: plainVehicle(model.hoverjet),
    jumpseat: plainVehicle(model.jumpseat),
    terrain: plainOf(model.terrain),
    props: plainOf(model.props),
    derived: plainOf(model.derived),
    structural: model.structural,
    unused: unused.slice().sort((a, b) => (a.key < b.key ? -1 : 1)),
    provenance: flat,
  }
}

const TOOL_VERSION = 1

/**
 * What the corpus PUBLISHED, so the sheet can disagree with it out loud.
 *
 * These are claims copied from the audits and research docs — prose, not constants. The tool never
 * uses them for a value; it only compares. `expected: null` means "the doc names no number, only a
 * claim", and `tolerance` is the doc's own stated rounding. A row whose `agrees` is false is not
 * automatically a doc error, but it is always something a human must look at once.
 */
const DOC_CLAIMS = [
  { key: 'hoverjet.rigidbody.mass', expected: 4, doc: '_verify-v-flight.md §10.0 table' },
  { key: 'hoverjet.rigidbody.drag', expected: 1.2, doc: '_verify-v-flight.md §10.0 table' },
  { key: 'hoverjet.rigidbody.angularDrag', expected: 1.95, doc: '_verify-v-flight.md §10.0 table' },
  {
    key: 'hoverjet.ship.maxSpeed',
    expected: 437.5,
    doc: '_verify-v-flight.md §10.0 / 01-flight-model.md',
  },
  { key: 'hoverjet.ship.boostMultiplier', expected: 2, doc: '_verify-v-flight.md §10.0 table' },
  { key: 'hoverjet.ship.driftMultiplier', expected: 0.045, doc: '_verify-v-flight.md §10.0 table' },
  { key: 'hoverjet.ship.liftMultiplier', expected: 0.065, doc: '_verify-v-flight.md §10.0 table' },
  { key: 'hoverjet.ship.rollRate', expected: 3, doc: '_verify-v-flight.md §10.0 table' },
  { key: 'hoverjet.ship.pitchRate', expected: 3.4, doc: '_verify-v-flight.md §10.0 table' },
  { key: 'hoverjet.ship.yawRate', expected: 2.5, doc: '_verify-v-flight.md §10.0 table' },
  { key: 'hoverjet.ship.acceleration', expected: 4, doc: '_verify-v-flight.md §10.0 table' },
  { key: 'hoverjet.ship.airbrakeSpeed', expected: 5, doc: '_verify-v-flight.md §10.0 table' },
  { key: 'jumpseat.rigidbody.mass', expected: 15, doc: '_verify-v-flight.md §10.2 table' },
  { key: 'jumpseat.rigidbody.drag', expected: 1.1, doc: '_verify-v-flight.md §10.2 table' },
  { key: 'jumpseat.rigidbody.angularDrag', expected: 1.75, doc: '_verify-v-flight.md §10.2 table' },
  { key: 'jumpseat.thruster.thrustForce', expected: 750, doc: '_verify-v-flight.md §1' },
  { key: 'jumpseat.thruster.boostMultiplier', expected: 1.65, doc: '_verify-v-flight.md §1' },
  { key: 'jumpseat.thruster.accelTime', expected: 1.2, doc: '_verify-v-flight.md §1' },
  { key: 'world.gravity', expected: { x: 0, y: -32, z: 0 }, doc: 'PORT_NOTES / brief' },
  {
    key: 'world.fixedDeltaTime',
    expected: 0.0121999998,
    doc: 'TimeManager, quoted as 0.0122 everywhere',
  },
  {
    key: 'derived.hoverjet.terminalSpeedCruise',
    expected: 89.8,
    tolerance: 0.05,
    doc: 'PORT_PLAN §4.3(b) 89.8 +/- 0.2; _verify-v-flight.md V4 also says 89.8',
  },
  {
    key: 'derived.hoverjet.terminalSpeedBoost',
    expected: 179.6,
    tolerance: 0.05,
    doc: 'PORT_PLAN §4.3(b) says 179.6; _verify-v-flight.md V4 says 179.5 — the plan is right',
  },
  {
    key: 'derived.bleed.driftRateContinuous',
    expected: 3.7741,
    tolerance: 0.001,
    doc: 'PORT_PLAN §4.3(a); _verify-v-flight.md §12 says 3.774',
  },
  {
    key: 'derived.bleed.liftRateContinuous',
    expected: 5.5089,
    tolerance: 0.001,
    doc: 'PORT_PLAN §4.3(a); _verify-v-flight.md §12 says 5.509',
  },
  {
    key: 'derived.bleed.dragRateContinuous',
    expected: 1.2089,
    tolerance: 0.001,
    doc: 'PORT_PLAN §4.3(a) "1.2 /s nominal -> 1.2089 /s effective"',
  },
  {
    key: 'derived.bleed.halfLifeBodyXms',
    expected: 139,
    tolerance: 3,
    doc: 'PORT_PLAN §4.3(b) 139 +/- 3 ms',
  },
  {
    key: 'derived.bleed.halfLifeBodyYms',
    expected: 103,
    tolerance: 3,
    doc: 'PORT_PLAN §4.3(b) 103 +/- 3 ms (revision 1 said 154; corrected)',
  },
  {
    key: 'derived.bleed.halfLifeBodyZms',
    expected: 573,
    tolerance: 8,
    doc: 'PORT_PLAN §4.3(b) 573 +/- 8 ms',
  },
  {
    key: 'derived.bleed.anisotropyXZ',
    expected: 4.12,
    tolerance: 0.1,
    doc: 'PORT_PLAN §4.3(b) "THE single feel metric", 4.12 +/- 0.1',
  },
  {
    key: 'derived.jumpseat.hoverEquilibriumHeight',
    expected: 0.492,
    tolerance: 0.005,
    doc: 'PORT_PLAN §4.3(a) "JumpSeat hover equilibrium -> 0.492 m"',
  },
  {
    key: 'derived.energy.boostBurnPerSecond',
    expected: 32,
    tolerance: 0.01,
    doc: 'brief + PORT_PLAN: "recharge 100/s vs 32/s burn"',
  },
  {
    key: 'hoverjet.energy.rechargeRate',
    expected: 100,
    doc: 'brief + PORT_PLAN: "recharge 100/s"',
  },
  {
    key: 'boundary.resetDelay',
    expected: 13,
    doc: '_verify-v-flight.md V1: 13 s in all 13 shipped missions, not the C# default 10',
  },
  {
    key: 'boundary.enabledMissionCount',
    expected: 8,
    doc: '_verify-v-flight.md V1b: PlayerBoundary disabled in 5 of 13',
  },
  {
    key: 'hoverjet.input.glider_lockRollAndYaw',
    expected: 0,
    doc: '_CORRECTIONS.md C1 as re-corrected by _verify-v-input-vr.md E1: 0 on the shipped prefab',
  },
  {
    key: 'hoverjet.ship.useRollCompensation',
    expected: 0,
    doc: 'PORT_PLAN DEV-001: no auto-level; CompensateRoll() unreachable',
  },
  {
    key: 'hoverjet.ship.limitRoll',
    expected: 0,
    doc: 'PORT_PLAN DEV-001',
  },
]

function compareAgainstDocs() {
  const rows = []
  for (const c of DOC_CLAIMS) {
    const e = entries.get(c.key)
    const actual = e ? e.value : undefined
    let agrees
    if (actual === undefined) agrees = false
    else if (typeof c.expected === 'number' && typeof actual === 'number') {
      agrees = Math.abs(actual - c.expected) <= (c.tolerance ?? 1e-9)
    } else {
      agrees = JSON.stringify(actual) === JSON.stringify(c.expected)
    }
    rows.push({
      key: c.key,
      docClaim: c.expected,
      docTolerance: c.tolerance ?? null,
      doc: c.doc,
      extracted: actual === undefined ? null : actual,
      agrees,
    })
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : 1))
  return rows
}

const PREFAB_SELF_MODIFICATION_TRAP = [
  'A prefab ASSET (m_IsPrefabParent: 1, m_ParentPrefab.fileID: 0) carries an m_Modification.m_Modifications',
  'list whose entries all have target: {fileID: 0}. Those are INERT residue, not overrides.',
  'PlayerShip_SR14_Photon residue says maxSpeed 200 (component: 437.5) and boostMultiplier 1.8 (component: 2).',
  'JumpSeat_Photon residue says boostMultiplier 1.25 (component: the Thruster value below).',
  'Applying them would be the cardinal-rule failure mode running in reverse. This tool applies a',
  'modification only when its target resolves to a real fileID.',
].join(' ')

function readUnityVersion() {
  try {
    const t = unityExists('ProjectSettings/ProjectVersion.txt')
      ? unityRead('ProjectSettings/ProjectVersion.txt')
      : ''
    const m = /m_EditorVersion:\s*(\S+)/.exec(t)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function plainOf(o) {
  if (o === null || o === undefined) return null
  if (typeof o !== 'object' || Array.isArray(o)) return o
  const out = {}
  for (const k of Object.keys(o).sort()) out[k] = plainOf(o[k])
  return out
}

function plainVehicle(v) {
  const out = {}
  for (const k of Object.keys(v).sort()) out[k] = v[k] === null ? null : plainOf(v[k])
  return out
}

/** Deterministic JSON: sorted keys everywhere, 2-space indent. */
function stableStringify(value) {
  // Shared references are normal here (the same value object is reachable from both the plain tree
  // and its provenance entry), so cycle detection has to be ancestor-based, not visited-based.
  const stack = []
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v
    if (stack.includes(v)) die('cycle in output document')
    stack.push(v)
    const out = Array.isArray(v)
      ? v.map(walk)
      : Object.keys(v)
          .sort()
          .reduce((acc, k) => {
            acc[k] = walk(v[k])
            return acc
          }, {})
    stack.pop()
    return out
  }
  return JSON.stringify(walk(value), null, 2)
}

// ---------------------------------------------------------------------------------------------
// 16. TypeScript emit
// ---------------------------------------------------------------------------------------------

function tsLiteral(v, indent) {
  const pad = '  '.repeat(indent)
  const padIn = '  '.repeat(indent + 1)
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return Object.is(v, -0) ? '0' : String(v)
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return `[\n${v.map((x) => `${padIn}${tsLiteral(x, indent + 1)}`).join(',\n')},\n${pad}]`
  }
  const keys = Object.keys(v).sort()
  if (keys.length === 0) return '{}'
  return `{\n${keys
    .map((k) => `${padIn}${tsKey(k)}: ${tsLiteral(v[k], indent + 1)}`)
    .join(',\n')},\n${pad}}`
}

function tsKey(k) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k)
}

function emitTypeScript(doc, sha) {
  const L = []
  L.push('// ============================================================================')
  L.push('// GENERATED FILE — DO NOT EDIT.')
  L.push('// Produced by tools/extract/constants.mjs from the read-only 2016 Unity project.')
  L.push(
    '// Regenerate with `pnpm extract`. Verify with `node tools/extract/constants.mjs --check`.',
  )
  L.push('//')
  L.push('// PORT_PLAN.md D4: "FF2 never hand-types a constant." A hand-written table is a cache,')
  L.push('// and caches go stale. Every number below carries the prefab, fileID and line it came')
  L.push('// from, plus a trust level. If a research doc disagrees with this file, this file read')
  L.push('// the prefab and the doc did not.')
  L.push('//')
  L.push(`// sha256(constants.generated.json) = ${sha}`)
  L.push('// ============================================================================')
  L.push('')
  L.push("/** What we know about a number's truth (PORT_PLAN.md §4.1 vocabulary). */")
  L.push(
    "export type Trust = 'verified' | 'derived' | 'code-default' | 'fitted' | 'invented' | 'unverified'",
  )
  L.push('')
  L.push('/** Where the bytes physically came from. */')
  L.push(
    "export type Origin =\n  | 'shipped-prefab'\n  | 'scene-component'\n  | 'project-settings'\n  | 'computed'\n  | 'csharp-initializer'",
  )
  L.push('')
  L.push('export type JsonValue =')
  L.push('  | string')
  L.push('  | number')
  L.push('  | boolean')
  L.push('  | null')
  L.push('  | readonly JsonValue[]')
  L.push('  | { readonly [k: string]: JsonValue }')
  L.push('')
  L.push('export interface ConstantEntry {')
  L.push('  /** Dotted key, e.g. "hoverjet.ship.driftMultiplier". */')
  L.push('  readonly key: string')
  L.push('  readonly value: JsonValue')
  L.push('  readonly unit: string | null')
  L.push('  readonly trust: Trust')
  L.push('  readonly origin: Origin')
  L.push('  /** Unity-relative file, plus `#fileID Component.field` where applicable. */')
  L.push('  readonly source: string')
  L.push('  readonly fileId: string | null')
  L.push('  /** 1-based line in `source`. */')
  L.push('  readonly line: number | null')
  L.push('  /** For derived values: the arithmetic, written out. */')
  L.push('  readonly formula: string | null')
  L.push('  readonly note: string | null')
  L.push('  /** First-party C# sites that READ the field, as `file:line`. */')
  L.push('  readonly consumers: readonly string[] | null')
  L.push('}')
  L.push('')
  L.push(
    '/** Provenance for every emitted constant, keyed by dotted key. The /constants page reads this. */',
  )
  L.push(
    `export const PROVENANCE: Readonly<Record<string, ConstantEntry>> = ${tsLiteral(doc.provenance, 0)} as const`,
  )
  L.push('')
  L.push(
    '/** Unity ProjectSettings. Nothing about mass or force means anything without gravity = -32. */',
  )
  L.push(`export const WORLD = ${tsLiteral(doc.world, 0)} as const`)
  L.push('')
  L.push('/**')
  L.push(
    ' * PlayerBoundary — the one gameplay constant that lives on a SCENE component rather than a',
  )
  L.push(
    ' * prefab. PlayerBoundary.cs initialises resetDelay to 10; every shipped mission scene says',
  )
  L.push(
    ' * 13, and 5 of the 13 missions disable the component entirely. Out-of-bounds is a per-level',
  )
  L.push(' * flag, not a global rule.')
  L.push(' */')
  L.push(`export const BOUNDARY = ${tsLiteral(doc.boundary, 0)} as const`)
  L.push('')
  L.push('/**')
  L.push(
    " * The launch elevator's REVEAL — 2016 does not draw the world while you are in the shaft.",
  )
  L.push(' *')
  L.push(' * `Trigger_EnableTerrain` switches the environment on and the shaft off as the platform')
  L.push(
    " * breaks the surface. `triggerLocalY` is that box centre's height in `Position_adjustment`,",
  )
  L.push(' * the frame the shaft segments and the launch clip are already authored in.')
  L.push(' *')
  L.push(' * READ THE LIVENESS, NOT THE COUNT. Seven shipped missions carry a launch rig and their')
  L.push(' * copies of the trigger do NOT all say the same thing: three sit 95 m lower, in the rig')
  L.push(
    " * root's frame, from an older generation of the prefab — and all three are switched off,",
  )
  L.push(
    ' * two by `m_Enabled: 0` and one by `m_IsActive: 0`. Four are live and all four agree, which',
  )
  L.push(' * is why this is one constant rather than thirteen rows of level data.')
  L.push(' *')
  L.push(
    " * `animatedNodeRestY` is the gap worth knowing: the elevator's animated node rests that far",
  )
  L.push(
    ' * up in the SAME frame, and the launch clip measures its rise from there. So a rise compared',
  )
  L.push(
    ' * directly against `triggerLocalY` fires that many metres late. `STRUCTURAL.launchReveal`',
  )
  L.push(' * carries the per-scene census.')
  L.push(' */')
  L.push(`export const LAUNCH = ${tsLiteral(doc.launch, 0)} as const`)
  L.push('')
  L.push('/**')
  L.push(' * The screen fade. 2016 fades every scene change and the port had none at all until')
  L.push(' * DEV-107. `docs/plan/LOADING.md` is the design; this is where its numbers come from.')
  L.push(' *')
  L.push(' * `missionSeconds` comes off the camera rig every shipped mission instantiates, and it')
  L.push(
    ' * is the one covering a REAL load. `menuSeconds` covers a Unity scene load the port does',
  )
  L.push(' * not perform, so the port deliberately does not spend it on a variable assignment.')
  L.push(
    ' * `solidAtFraction` is the inline clamp in `Fade_Mesh.Fade()`: the visible ramp finishes',
  )
  L.push(' * at 0.85 * fadeTime and the last 15% is already solid black.')
  L.push(' *')
  L.push(' * Both came out of a LIVENESS WALK, and both differ from what a grep says. See')
  L.push(
    ' * `STRUCTURAL.screenFade` and `tests/unit/screen-fade-extract.test.ts`: thirty faders in',
  )
  L.push(' * setGameplayOptions.unity that never run, and an unused prefab of the same basename as')
  L.push(' * the menu rig carrying a different number.')
  L.push(' */')
  L.push(`export const FADE = ${tsLiteral(doc.fade, 0)} as const`)
  L.push('')
  L.push('/**')
  L.push(' * The HoverJet, from Assets/Faceted Flight/Resources/PlayerShip_SR14_Photon.prefab —')
  L.push(
    ' * the prefab `Level.InstantiatePlayerShip()` loads in all seven shipped HoverJet missions.',
  )
  L.push(' * NOT PlayerShip_SR14_unet.prefab, which has identical physics and the opposite')
  L.push(' * glider_lockRollAndYaw, and is used only by the two enabled multiplayer scenes.')
  L.push(' */')
  L.push(`export const HOVERJET = ${tsLiteral(doc.hoverjet, 0)} as const`)
  L.push('')
  L.push('/** The JumpSeat, from Assets/Faceted Flight/Resources/JumpSeat_Photon.prefab. */')
  L.push(`export const JUMPSEAT = ${tsLiteral(doc.jumpseat, 0)} as const`)
  L.push('')
  L.push('/**')
  L.push(
    ' * The four SHIPPED environments, keyed by the environment id content/levels/*.json uses, each',
  )
  L.push(
    ' * holding every `FacetedTerrain` component found in its level art under a name taken from the',
  )
  L.push(' * source height map: `TERRAIN.simonet.terrains.islands`, `.ocean`, and so on.')
  L.push(' *')
  L.push(
    ' * The generator these feed lives inside `#if UNITY_EDITOR` in the 2016 project and its output',
  )
  L.push(
    ' * was baked to binary chunk assets, so these parameters — not the meshes — are what survived.',
  )
  L.push(' *')
  L.push(
    ' * READ THE INSTANCE, NOT THE ENVIRONMENT. Simonet is 4096 m of islands in 256 m chunks AND a',
  )
  L.push(
    ' * 32768 m ocean plate in 1024 m chunks; Kauai is 8192 m of island plus the same ocean. Taking',
  )
  L.push(' * "the terrain" of an environment to be one thing gets the world 8x too small or 8x too')
  L.push(' * coarse.')
  L.push(' *')
  L.push(
    ' * `origin` says which file the values were read from. Desert and Simonet are `shipped-prefab`:',
  )
  L.push(
    ' * their environment scene is a few KB and instantiates LevelArt_<name>.prefab. Alpine and Kauai',
  )
  L.push(
    ' * are `scene-component`: Kauai has no prefab, and Alpine has one that its scene DOES NOT',
  )
  L.push(
    ' * instantiate — the scene holds its own copy of the level art. See `crossCheck` per environment.',
  )
  L.push(' */')
  L.push(`export const TERRAIN = ${tsLiteral(doc.terrain, 0)} as const`)
  L.push('')
  L.push('/**')
  L.push(' * Props: things placed in a course rather than built by a generator.')
  L.push(' *')
  L.push(' * `checkpointRing` is the gate, and it is NOT one mesh. The shipped prefab is a')
  L.push(' * `jumpGate_diamond` frame plus 18 glowing cubes plus seven particle systems, and')
  L.push(' * `checkpoint-ring.glb` is only the frame — arriving with the FBX default material,')
  L.push(' * which renders as a dark thin ring instead of the bright green gate the game had.')
  L.push(' * Both materials use a third-party Marmoset shader, so the numbers travel and the')
  L.push(' * shader does not. The 18 stud transforms come too: they are plain boxes, so the')
  L.push(' * renderer rebuilds them with no extra asset.')
  L.push(' */')
  L.push(`export const PROPS = ${tsLiteral(doc.props, 0)} as const`)
  L.push('')
  L.push('/**')
  L.push(' * Computed values. ONE drag model, applied everywhere:')
  L.push(` *   ${DRAG_MODEL_FORMULA}`)
  L.push(
    ' * Mixing `v /= (1 + k*dt)` in gives 91.15 / 182.29 and a sim that disagrees with its own',
  )
  L.push(' * golden tests. Every entry carries its formula.')
  L.push(' */')
  L.push(`export const DERIVED = ${tsLiteral(doc.derived, 0)} as const`)
  L.push('')
  L.push('/**')
  L.push(
    ' * Structural assertions — PORT_PLAN §4.7. The generated-constants machine protects numbers;',
  )
  L.push(' * these protect the claims that would cost a rewrite. CI diffs them like constants.')
  L.push(' */')
  L.push(`export const STRUCTURAL = ${tsLiteral(doc.structural, 0)} as const`)
  L.push('')
  L.push('/**')
  L.push(
    ' * Serialised, tuned, and DEAD. Never feed these to the sim. Each row says why: either the',
  )
  L.push(
    ' * YAML key has no C# field at all, or the field is `private` without [SerializeField], or',
  )
  L.push(' * no first-party script reads it.')
  L.push(' */')
  L.push(`export const UNUSED = ${tsLiteral(doc.unused, 0)} as const`)
  L.push('')
  L.push('/** Extraction metadata, including anything the tool could not verify. */')
  L.push(`export const META = ${tsLiteral(doc.meta, 0)} as const`)
  L.push('')
  L.push('/** sha256 of constants.generated.json — the CI drift check. */')
  L.push(`export const CONSTANTS_SHA256 = ${JSON.stringify(sha)}`)
  L.push('')
  return `${L.join('\n')}`
}

// ---------------------------------------------------------------------------------------------
// 17. Console report
// ---------------------------------------------------------------------------------------------

function report(model, doc, sha, ms, changed) {
  const w = (s) => process.stdout.write(`${s}\n`)
  const m = doc.meta
  w('')
  w('constants.mjs — Faceted Flight 2 generated constants sheet')
  w(`  unity project   ${UNITY}`)
  w(`  unity version   ${m.unityVersion}`)
  w(`  drag model      ${m.dragModel}  (${m.dragModelFormula})`)
  w(`  entries         ${m.counts.entries}   unused/dead: ${m.counts.unused}`)
  w(
    `  scenes          ${m.counts.shippedMissionScenes} shipped missions, ${m.counts.shippedMultiplayerScenes} multiplayer`,
  )
  w(`  sha256(json)    ${sha}`)
  w(`  elapsed         ${ms} ms   output ${changed ? 'CHANGED' : 'unchanged'}`)
  w('')
  w('  structural assertions')
  for (const a of model.structural.assertions ?? []) {
    w(`    ${a.ok ? 'PASS' : 'FAIL'}  ${a.name}`)
    if (!a.ok) w(`          ${a.detail}`)
  }
  w('')
  w('  headline values')
  const rows = [
    ['world.gravity.y', model.world.gravity.y, 'm/s^2'],
    ['world.fixedDeltaTime', model.world.fixedDeltaTime, 's'],
    ['derived.tickRateHz', model.derived.tickRateHz, 'Hz'],
    ['hoverjet.rigidbody.mass', model.hoverjet.rigidbody.mass, 'kg'],
    ['hoverjet.rigidbody.drag', model.hoverjet.rigidbody.drag, '1/s'],
    ['hoverjet.rigidbody.angularDrag', model.hoverjet.rigidbody.angularDrag, '1/s'],
    ['hoverjet.ship.maxSpeed (thrust)', model.hoverjet.ship?.maxSpeed, 'N'],
    ['hoverjet.ship.boostMultiplier', model.hoverjet.ship?.boostMultiplier, ''],
    ['hoverjet.ship.driftMultiplier', model.hoverjet.ship?.driftMultiplier, '/tick'],
    ['hoverjet.ship.liftMultiplier', model.hoverjet.ship?.liftMultiplier, '/tick'],
    ['derived.hoverjet.terminalSpeedCruise', model.derived.hoverjet?.terminalSpeedCruise, 'm/s'],
    ['derived.hoverjet.terminalSpeedBoost', model.derived.hoverjet?.terminalSpeedBoost, 'm/s'],
    ['derived.bleed.observedRateBodyX', model.derived.bleed?.observedRateBodyX, '1/s'],
    ['derived.bleed.observedRateBodyY', model.derived.bleed?.observedRateBodyY, '1/s'],
    ['derived.bleed.observedRateBodyZ', model.derived.bleed?.observedRateBodyZ, '1/s'],
    ['derived.bleed.halfLifeBodyXms', model.derived.bleed?.halfLifeBodyXms, 'ms'],
    ['derived.bleed.halfLifeBodyYms', model.derived.bleed?.halfLifeBodyYms, 'ms'],
    ['derived.bleed.halfLifeBodyZms', model.derived.bleed?.halfLifeBodyZms, 'ms'],
    ['derived.bleed.anisotropyXZ', model.derived.bleed?.anisotropyXZ, ''],
    ['derived.energy.boostBurnPerSecond', model.derived.energy?.boostBurnPerSecond, 'energy/s'],
    ['hoverjet.energy.rechargeRate', model.hoverjet.energy?.rechargeRate, 'energy/s'],
    ['jumpseat.rigidbody.mass', model.jumpseat.rigidbody?.mass, 'kg'],
    ['jumpseat.rigidbody.drag', model.jumpseat.rigidbody?.drag, '1/s'],
    ['jumpseat.thruster.thrustForce', model.jumpseat.thruster?.thrustForce, 'N'],
    [
      'derived.jumpseat.hoverEquilibriumHeight',
      model.derived.jumpseat?.hoverEquilibriumHeight,
      'm',
    ],
    ['boundary.resetDelay', model.boundary?.resetDelay, 's'],
    ['boundary.enabledMissionCount', model.boundary?.enabledMissionCount, 'of 13'],
    ['launch.reveal.triggerLocalY', model.launch?.reveal?.triggerLocalY, 'm'],
    ['launch.reveal.animatedNodeRestY', model.launch?.reveal?.animatedNodeRestY, 'm'],
    [
      'launch.reveal.liveInFrameCount',
      `${model.launch?.reveal?.liveInFrameCount} of ${model.launch?.reveal?.triggerCopies}`,
      'copies',
    ],
  ]
  for (const [k, v, u] of rows) w(`    ${k.padEnd(40)} ${String(v).padStart(14)} ${u}`)
  w('')
  w('  faceted terrain — the shipped environments')
  w(
    `    ${'key'.padEnd(18)} ${'size'.padStart(7)} ${'height'.padStart(7)} ${'chunk'.padStart(6)} ${'quad'.padStart(5)} ${'grid'.padStart(8)} ${'jitter'.padStart(7)}  height map`,
  )
  for (const envId of Object.keys(model.terrain ?? {}).sort()) {
    const rec = model.terrain[envId]
    for (const leaf of Object.keys(rec.terrains).sort()) {
      const t = rec.terrains[leaf]
      w(
        `    ${t.key.padEnd(18)} ${String(t.terrainSize).padStart(7)} ${String(t.terrainHeight).padStart(7)} ${String(t.chunkSize).padStart(6)} ${String(t.baseResolution).padStart(5)} ${`${t.chunkPerSide}x${t.chunkPerSide}`.padStart(8)} ${String(t.randomOffset).padStart(7)}  ${(t.sourceHeightMap ?? '?').split('/').pop()}`,
      )
    }
    w(`      <- ${rec.origin} ${rec.source}`)
  }
  w('')
  w('  cross-check against what the corpus published')
  for (const r of model.structural.docCrossCheck ?? []) {
    w(
      `    ${r.agrees ? 'agree ' : 'DIFFER'} ${r.key.padEnd(42)} doc ${String(JSON.stringify(r.docClaim)).padStart(14)}  prefab ${String(JSON.stringify(r.extracted)).padStart(14)}`,
    )
    if (!r.agrees) w(`             source of claim: ${r.doc}`)
  }
  w('')
  const dc = model.structural.decoyComparison
  if (dc) {
    w('  decoy check (PlayerShip_SR14_unet.prefab)')
    w(
      `    shipped input script ${dc.shippedInputScript}   decoy input script ${dc.decoyInputScript}`,
    )
    for (const k of Object.keys(dc.fields).sort()) {
      const f = dc.fields[k]
      w(
        `    ${f.identical ? 'same  ' : 'DIFFER'} ${k.padEnd(24)} shipped ${String(f.shipped).padStart(10)}   decoy ${String(f.decoy).padStart(10)}`,
      )
    }
    w('')
  }
  if (m.warnings.length) {
    w('  warnings')
    for (const x of m.warnings) w(`    ! ${x}`)
    w('')
  }
  if (m.errors.length) {
    w('  ERRORS')
    for (const x of m.errors) w(`    X ${x}`)
    w('')
  }
}

// ---------------------------------------------------------------------------------------------
// 13c. The medals — the level select's reward (DEV-113)
//
// 2016 spins your medal over its holotable. `Slot_Medal.cs` reads
// `PlayerPrefs[LevelName + gameMode + " medal"]` on enable, instantiates
// `medal_<Tier>.prefab` as a child of the slot, forces the instance to unit scale,
// and yaws it 55 deg/s from a random start in 0..270. The medal IS the title
// emblem — `logo_polys.fbx`'s `logo_top` + `logo_bottom` — in a tinted material.
//
// THREE THINGS THIS SECTION HAS TO GET PAST, each already in CLAUDE.md:
//
//   1. Five of the six shipped medal materials are in the OLD YAML dialect
//      (`data: first/second`, no leading dash) and `unity_yaml.js` returns `{}`
//      for their `m_Colors` — `medal_Silver.mat` is the exact file DEV-043 names
//      as reading as "having no colour". The colours are read out of the RAW text
//      here, and the sheet records, per material, whether the parser saw them at
//      all, so the trap stays visible.
//   2. Where the slot actually sits in the SHIPPED menu is a stripped prefab
//      instance. `missionSelect_holoTable.prefab` carries the live `slot_medal`;
//      `setGameplayOptions.unity` places that prefab as `!u!1001` blocks under the
//      `missionSel_<ship>_<rank>` pages, and NO modification on any of them
//      touches the slot — so every mission table's medal is the prefab's own
//      transform. A name grep over the scene finds none of this.
//   3. The mission-page PREFABS (`missionSel_hoverJet_int.prefab` etc.) also carry
//      inline `Slot_Medal` components, and every one of them is DEAD: either
//      `m_IsActive: 0` on the slot, or scaled to (0.0004, 0.0002, -0.0003) under a
//      deactivated `event_parent`. The liveness walk is what separates the
//      shipped slot from the eight residues per page.
// ---------------------------------------------------------------------------------------------

const MEDALS_DIR = 'Assets/Faceted Flight/Prefabs/legacy_root_prefabs/PreFabs/medals'
const MEDAL_HOLOTABLE_PREFAB = 'Assets/Faceted Flight/Prefabs/Menus/missionSelect_holoTable.prefab'
const MEDAL_TABLE_MESH =
  'Assets/Faceted Flight/Materialized Mesh/MM_level_sel_room/MM_MM_Commander_Table_01.asset'
const SLOT_MEDAL_CS = 'Assets/Faceted Flight/Scripts/Slot_Medal.cs'
const MENU_SCENE = 'Assets/Faceted Flight/Scenes/setGameplayOptions.unity'
const MEDAL_TIERS = {
  lead: 'Lead',
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  platinum: 'Platinum',
  missing: 'missing',
}

/**
 * A material colour out of the RAW YAML, dialect-blind.
 *
 * Both dialects write `name: _Color` and then `second: {r: .., g: .., b: .., a: ..}`
 * on the next line; only the list marker above them differs. Returns the four
 * channels, the 1-based line of the `second:` value, and which dialect the file
 * is in.
 */
function rawMaterialColour(matRel, name) {
  const c = rawColour(unityRead(matRel), name)
  return c && { value: c.value.map((v) => round(v, 6)), line: c.line, dialect: c.dialect }
}

function extractMedals() {
  if (!unityExists(MEDAL_HOLOTABLE_PREFAB) || !unityExists(`${MEDALS_DIR}/medal_Gold.mat`)) {
    warn('medals: the holotable prefab or the medal materials are missing; nothing extracted')
    return null
  }

  // ── the six colours ──────────────────────────────────────────────────────
  const colors = {}
  const colorDialect = {}
  const parserSawColour = {}
  const materials = {}
  for (const [tier, suffix] of Object.entries(MEDAL_TIERS)) {
    const matRel = `${MEDALS_DIR}/medal_${suffix}.mat`
    materials[tier] = matRel
    const raw = rawMaterialColour(matRel, '_Color')
    if (!raw) {
      warn(`${matRel}: no _Color found in the raw text`)
      continue
    }
    colorDialect[tier] = raw.dialect
    // The parser's own answer, kept as a receipt: `null` on the old dialect is
    // the DEV-043 trap, and a sheet that silently worked around it would be a
    // sheet nobody could tell was working around anything.
    parserSawColour[tier] = parsedMaterialColour(matRel, '_Color') !== null
    colors[tier] = put(`props.medals.colors.${tier}`, {
      value: raw.value,
      unit: null,
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${matRel} m_Colors _Color`,
      fileId: '2100000',
      line: raw.line,
      note:
        `sRGB [r, g, b, a], read from the raw YAML (${raw.dialect} dialect). ` +
        (tier === 'missing'
          ? 'The medal an UNFLOWN course shows in 2016: silver at 7.2% alpha through a Marmoset ' +
            'glass shader. The port does not draw it (DEV-113 §4).'
          : tier === 'lead'
            ? 'Assigned by LevelEnd.cs:198 for a below-bronze run and NEVER written to ' +
              'PlayerPrefs (no SetString in that branch), so no menu slot ever spawns it.'
            : `Worn by both submeshes of medal_${suffix.toLowerCase()}.prefab.`),
    })
  }

  // ── which prefab wears which material, and the emblem's own transform ────
  //
  // `Slot_Medal.SpawnMedalPrefab()` sets the instance's localScale to ONE, so the
  // 0.75 on four of the five tier roots never reaches the screen. What does is the
  // `logo_polys` child: y +0.1222, yawed a half turn, at 0.012847. Read off every
  // tier and required to agree — a tier with its own emblem scale would be a
  // second number to carry, and the sheet refuses to carry it silently.
  const tiers = {}
  const emblems = []
  for (const [tier, suffix] of Object.entries(MEDAL_TIERS)) {
    const prefabRel = `${MEDALS_DIR}/medal_${suffix.toLowerCase()}.prefab`
    if (!unityExists(prefabRel)) {
      warn(`${prefabRel}: missing`)
      continue
    }
    const asset = loadAsset(prefabRel)
    const root = rootTransformOf(asset)
    const renderers = asset.docs.filter((d) => d.classId === 23)
    const matGuids = [
      ...new Set(
        renderers.flatMap((r) => (r.data?.m_Materials ?? []).map((m) => String(m?.guid ?? ''))),
      ),
    ]
    const matPaths = matGuids.map((g) => resolveGuid(g))
    const polys = asset.docs.find(
      (d) => d.classId === 1 && String(d.data?.m_Name ?? '') === 'logo_polys',
    )
    const polysTf = polys
      ? asset.docs.find(
          (d) => d.classId === 4 && String(d.data?.m_GameObject?.fileID) === String(polys.fileId),
        )
      : null
    const meshes = [
      ...new Set(
        asset.docs
          .filter((d) => d.classId === 33)
          .map((d) => resolveGuid(String(d.data?.m_Mesh?.guid ?? '')) ?? '?'),
      ),
    ]
    const p = polysTf?.data?.m_LocalPosition
    const r = polysTf?.data?.m_LocalRotation
    const s = polysTf?.data?.m_LocalScale
    const emblem = polysTf
      ? {
          position: [num(p?.x), num(p?.y), num(p?.z)].map((v) => round(v, 6)),
          rotation: [num(r?.x), num(r?.y), num(r?.z), num(r?.w, 1)].map((v) => round(v, 6)),
          scale: [num(s?.x, 1), num(s?.y, 1), num(s?.z, 1)].map((v) => round(v, 6)),
        }
      : null
    if (emblem)
      emblems.push({ tier, prefabRel, emblem, line: lineOf(asset, polysTf.fileId, 'm_LocalScale') })
    if (matPaths.length !== 1 || matPaths[0] !== materials[tier]) {
      warn(
        `${prefabRel}: expected every renderer to wear ${materials[tier]}, found ${JSON.stringify(matPaths)}`,
      )
    }
    tiers[tier] = {
      prefab: prefabRel,
      material: matPaths[0] ?? null,
      materialAgrees: matPaths.length === 1 && matPaths[0] === materials[tier],
      rootScale: [
        num(root?.data?.m_LocalScale?.x, 1),
        num(root?.data?.m_LocalScale?.y, 1),
        num(root?.data?.m_LocalScale?.z, 1),
      ].map((v) => round(v, 6)),
      meshes,
    }
  }
  const emblemKey = (e) => JSON.stringify(e.emblem)
  const distinctEmblems = [...new Set(emblems.map(emblemKey))]
  if (distinctEmblems.length !== 1) {
    warn(
      `medals: the tier prefabs disagree about the emblem transform — ${JSON.stringify(
        emblems.map((e) => ({ tier: e.tier, ...e.emblem })),
      )}`,
    )
  }
  const emblemOf = emblems.find((e) => e.tier === 'gold') ?? emblems[0] ?? null

  // ── the slot in the SHIPPED holotable ────────────────────────────────────
  const holo = loadAsset(MEDAL_HOLOTABLE_PREFAB)
  const slotGo = holo.docs.find(
    (d) => d.classId === 1 && String(d.data?.m_Name ?? '') === 'slot_medal',
  )
  const slotTf = slotGo
    ? holo.docs.find(
        (d) => d.classId === 4 && String(d.data?.m_GameObject?.fileID) === String(slotGo.fileId),
      )
    : null
  const slotScript = slotGo
    ? holo.docs.find(
        (d) =>
          d.classId === 114 &&
          String(d.data?.m_GameObject?.fileID) === String(slotGo.fileId) &&
          scriptName(d) === 'Slot_Medal',
      )
    : null
  const slotChain = slotTf ? activeChainOf(holo, slotTf) : []
  const slotLive =
    slotGo !== undefined &&
    slotScript !== undefined &&
    num(slotScript?.data?.m_Enabled) === 1 &&
    slotChain.length > 0 &&
    slotChain.every((c) => c.isActive === 1)
  const sp = slotTf?.data?.m_LocalPosition
  const sr = slotTf?.data?.m_LocalRotation
  const ss = slotTf?.data?.m_LocalScale

  // The table under it: the `holotable` mesh node's scale, and the mesh's own
  // bounds. Together they say where the top is and how wide the footprint is,
  // which is what the port's own 0.50 m tables are measured against.
  const tableGo = holo.docs.find(
    (d) => d.classId === 1 && String(d.data?.m_Name ?? '') === 'holotable',
  )
  const tableTf = tableGo
    ? holo.docs.find(
        (d) => d.classId === 4 && String(d.data?.m_GameObject?.fileID) === String(tableGo.fileId),
      )
    : null
  const ts = tableTf?.data?.m_LocalScale
  let tableBounds = null
  if (unityExists(MEDAL_TABLE_MESH)) {
    const text = unityRead(MEDAL_TABLE_MESH)
    const m =
      /m_LocalAABB:\r?\n\s*m_Center: \{x: ([-\d.eE]+), y: ([-\d.eE]+), z: ([-\d.eE]+)\}\r?\n\s*m_Extent: \{x: ([-\d.eE]+), y: ([-\d.eE]+), z: ([-\d.eE]+)\}/.exec(
        text,
      )
    if (m) {
      tableBounds = {
        center: [m[1], m[2], m[3]].map((v) => round(Number(v), 6)),
        extent: [m[4], m[5], m[6]].map((v) => round(Number(v), 6)),
        line: text.slice(0, m.index).split(NEWLINE_RE).length,
      }
    } else {
      warn(`${MEDAL_TABLE_MESH}: no m_LocalAABB found`)
    }
  }

  // ── where that prefab stands in the shipped menu ─────────────────────────
  //
  // Stripped instances, so this is an inventory of `!u!1001` blocks by parent
  // guid (CLAUDE.md, "a STRIPPED PREFAB INSTANCE is invisible..."). For each:
  // the page it hangs under, and whether ANY modification reaches the slot.
  const holoGuid = pathToGuid.get(MEDAL_HOLOTABLE_PREFAB) ?? null
  const slotTargets = new Set(
    [slotGo?.fileId, slotTf?.fileId, slotScript?.fileId].filter((x) => x !== undefined).map(String),
  )
  const menuInstances = []
  if (holoGuid && unityExists(MENU_SCENE)) {
    const scene = loadAsset(MENU_SCENE)
    for (const d of instancesOf(scene.docs, holoGuid)) {
      const parentId = String(d.data?.m_Modification?.m_TransformParent?.fileID ?? '0')
      const parentTf = scene.byId.get(parentId)
      const chain = parentTf ? activeChainOf(scene, parentTf) : []
      const mods = modificationsOf(d)
      const slotMods = mods
        .filter((m) => slotTargets.has(String(m?.target?.fileID ?? '')))
        .map((m) => modPath(m))
      const page =
        chain.map((c) => c.name).find((n) => /^missionSel_/.test(String(n ?? ''))) ?? null
      menuInstances.push({
        fileId: String(d.fileId),
        line: scene.docLine.get(String(d.fileId)) ?? null,
        under: chain.map((c) => c.name).join('/'),
        page,
        slotModifications: slotMods,
      })
    }
    menuInstances.sort((a, b) => (a.fileId < b.fileId ? -1 : 1))
  }
  const underPages = menuInstances.filter((i) => i.page !== null)
  const slotOverridden = menuInstances.filter((i) => i.slotModifications.length > 0)

  // ── the two numbers that live in the script ──────────────────────────────
  //
  // Literals inside `Update()` and `OnEnable()`, not fields: code, so
  // `code-default`, and the only way they could differ per instance is a
  // different build of the game.
  // Anchored on the LIVE line: two commented-out drafts above it carry the same
  // literal, and a looser anchor lands on one of those.
  const spin = csAnchoredNumber(
    SLOT_MEDAL_CS,
    /localEulerAngles\.y \+ Time\.deltaTime \* (\d+(?:\.\d+)?)f/,
    'spin rate',
  )
  const startYaw = csAnchoredNumber(
    SLOT_MEDAL_CS,
    /Random\.RandomRange\(0f, (\d+(?:\.\d+)?)f\)/,
    'start yaw range',
  )
  const unitScaleLine = csLineMatching(SLOT_MEDAL_CS, /localScale = Vector3\.one/)

  return {
    colors,
    colorDialect,
    parserSawColour,
    materials,
    tiers,
    emblemMesh: emblemOf ? (tiers[emblemOf.tier]?.meshes?.[0] ?? null) : null,
    emblem: emblemOf
      ? put('props.medals.emblem', {
          value: emblemOf.emblem,
          unit: 'm',
          trust: 'verified',
          origin: 'shipped-prefab',
          source: `${emblemOf.prefabRel} Transform of "logo_polys"`,
          fileId: '400002',
          line: emblemOf.line,
          note:
            'UNITY SPACE, local to the spawned medal instance — which Slot_Medal.cs forces to ' +
            `unit scale (line ${unitScaleLine}), so the tier prefab's own root scale is inert. ` +
            `All ${emblems.length} tier prefabs agree on this transform.`,
        })
      : null,
    emblemAgrees: distinctEmblems.length === 1,
    slot: slotTf
      ? put('props.medals.slot', {
          value: {
            position: [num(sp?.x), num(sp?.y), num(sp?.z)].map((v) => round(v, 6)),
            rotation: [num(sr?.x), num(sr?.y), num(sr?.z), num(sr?.w, 1)].map((v) => round(v, 6)),
            scale: [num(ss?.x, 1), num(ss?.y, 1), num(ss?.z, 1)].map((v) => round(v, 6)),
          },
          unit: 'm',
          trust: 'verified',
          origin: 'shipped-prefab',
          source: `${MEDAL_HOLOTABLE_PREFAB} Transform of "slot_medal"`,
          fileId: String(slotTf.fileId),
          line: lineOf(holo, slotTf.fileId, 'm_LocalPosition'),
          note:
            'UNITY SPACE, local to the holotable prefab root. The medal instance is a child of ' +
            'this at unit scale, so its size on screen is slot.scale x emblem.scale x mesh.',
        })
      : null,
    slotLive: put('props.medals.slotLive', {
      value: slotLive,
      unit: null,
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${MEDAL_HOLOTABLE_PREFAB} Slot_Medal on "slot_medal"`,
      fileId: slotScript ? String(slotScript.fileId) : null,
      line: slotScript ? lineOf(holo, slotScript.fileId, 'm_Enabled') : null,
      note:
        'The full liveness walk inside the prefab: component enabled, GameObject active, every ' +
        `ancestor active (${slotChain.map((c) => `${c.name}=${c.isActive}`).join(', ')}).`,
    }),
    slotLevelName: slotScript ? String(slotScript.data?.LevelName ?? '') : null,
    slotGameMode: slotScript ? String(slotScript.data?.gameMode ?? '') : null,
    slotSpawnOnStart: slotScript ? num(slotScript.data?.spawnOnStart) === 1 : null,
    table: tableBounds
      ? put('props.medals.table', {
          value: {
            center: tableBounds.center,
            extent: tableBounds.extent,
            scale: [num(ts?.x, 1), num(ts?.y, 1), num(ts?.z, 1)].map((v) => round(v, 6)),
          },
          unit: 'm',
          trust: 'verified',
          origin: 'shipped-prefab',
          source: `${MEDAL_TABLE_MESH} m_LocalAABB, scaled by ${MEDAL_HOLOTABLE_PREFAB} Transform of "holotable"`,
          fileId: tableTf ? String(tableTf.fileId) : null,
          line: tableBounds.line,
          note:
            'The table the slot stands over. Top = (center.y + extent.y) x scale.y; footprint ' +
            'half-extents = extent.xz x scale.xz. The port carries the slot as a RATIO of these.',
        })
      : null,
    spinDegPerSecond: put('props.medals.spinDegPerSecond', {
      value: spin ? spin.value : null,
      unit: 'deg/s',
      trust: 'code-default',
      origin: 'csharp-initializer',
      source: `${SLOT_MEDAL_CS} Update()`,
      fileId: null,
      line: spin ? spin.line : null,
      note: "A literal in Update(), about the slot's local y. Render-clock decoration in the port.",
    }),
    startYawMaxDeg: put('props.medals.startYawMaxDeg', {
      value: startYaw ? startYaw.value : null,
      unit: 'deg',
      trust: 'code-default',
      origin: 'csharp-initializer',
      source: `${SLOT_MEDAL_CS} OnEnable()`,
      fileId: null,
      line: startYaw ? startYaw.line : null,
      note: 'Random.RandomRange(0, THIS) on enable. Not 360: the last quarter turn is never a start.',
    }),
    instanceForcedToUnitScale: unitScaleLine !== null,
    menu: {
      scene: MENU_SCENE,
      instances: menuInstances,
      underMissionPages: underPages.length,
      slotOverridden: slotOverridden.length,
      pages: [...new Set(underPages.map((i) => i.page))].sort(),
    },
  }
}

// ---------------------------------------------------------------------------------------------
// 13f. The level-select room's LIGHT (DEV-437)
//
// Matt, 2026-09-26, on DEV-430's room: *"light to match 2016 if you can."* The room is
// `Environment_Hangar.prefab`, instanced ONCE in `setGameplayOptions.unity` at identity, and it
// carries every light 2016 lit that room with:
//
//   light_ship              a SPOT, straight down over the parked jet: what made f0030's deck tan
//   sky/ibl_sky/light_env   a DIRECTIONAL key, 57 degrees up, lighting every layer but `Vehicles`
//   sky/ibl_sky             a Skyshop `Sky`: the nine-coefficient ambient every Marmoset surface
//                           takes instead of Unity's (the same SH as Simonet's, at its own
//                           intensities)
//
// Read off the PREFAB, then the scene's m_Modifications on each (CLAUDE.md rule 2): the scene
// overrides light_env's shadow type and strength and nothing about any light's colour, intensity or
// aim. Unity space throughout; `roomAnchor` is the frame `hangar-room.glb` is written in (the lift's
// axis at the floor, `tools/assets/convert-hangar-art.mjs`), so a consumer can take a position into
// that frame without a second reading of the prefab.
//
// Which lights are LIVE in the whole scene — these two, and a dozen dark ones inside switched-off
// holotable pages — is `convert-hangar-art.mjs`'s census, which flattens the scene with its prefabs
// expanded and refuses to write if the set moves. This block reads values; that one counts.
// ---------------------------------------------------------------------------------------------

const HANGAR_PREFAB = 'Assets/Faceted Flight/Prefabs/Environment_Hangar.prefab'
/** Unity's `LightType`, in `m_Type` order. */
const UNITY_LIGHT_TYPES = ['spot', 'directional', 'point', 'area']

function extractHangarLighting() {
  if (!unityExists(HANGAR_PREFAB) || !unityExists(MENU_SCENE)) {
    warn(`hangar lighting: ${HANGAR_PREFAB} or ${MENU_SCENE} is missing; nothing extracted`)
    return null
  }
  const asset = loadAsset(HANGAR_PREFAB)
  const root = rootTransformOf(asset)
  const rootId = String(root.fileId)
  const hangarGuid = pathToGuid.get(HANGAR_PREFAB) ?? null

  // ── the one instance, and that it sits at identity ─────────────────────────────────────────
  const scene = loadAsset(MENU_SCENE)
  const instances = instancesOf(scene.docs, hangarGuid)
  if (instances.length !== 1) {
    warn(
      `hangar lighting: ${MENU_SCENE} instances ${HANGAR_PREFAB} ${instances.length} times, not once`,
    )
    if (instances.length === 0) return null
  }
  const inst = instances[0]
  const mods = modificationsOf(inst).map((m) => ({
    target: modTarget(m),
    propertyPath: modPath(m),
    value: m.value,
  }))
  const rootPose = mods.filter(
    (m) => m.target === rootId && /^m_Local(Position|Rotation|Scale)\./.test(m.propertyPath),
  )
  const identity = {
    'm_LocalPosition.x': 0,
    'm_LocalPosition.y': 0,
    'm_LocalPosition.z': 0,
    'm_LocalRotation.x': 0,
    'm_LocalRotation.y': 0,
    'm_LocalRotation.z': 0,
    'm_LocalRotation.w': 1,
  }
  const rootScale = vec(root.data?.m_LocalScale, 1)
  const atIdentity =
    rootPose.every((m) =>
      m.propertyPath in identity ? num(m.value) === identity[m.propertyPath] : num(m.value) === 1,
    ) &&
    rootScale.x === 1 &&
    rootScale.y === 1 &&
    rootScale.z === 1
  if (!atIdentity) {
    warn(
      `hangar lighting: the ${MENU_SCENE} instance of ${HANGAR_PREFAB} is not at identity — every position below would be wrong`,
    )
  }

  // ── the room frame: the lift's axis at the floor ───────────────────────────────────────────
  const tfNamed = (name) =>
    asset.docs.filter((d) => d.classId === 4 && gameObjectName(asset, d) === name)
  const one = (name) => {
    const hits = tfNamed(name)
    if (hits.length !== 1)
      warn(`hangar lighting: ${hits.length} Transforms named ${name}, expected 1`)
    return hits[0] ?? null
  }
  const elevatorTf = one('Elevator')
  const adjustTf = one('Position_adjustment')
  const elevatorAt = elevatorTf ? composeFromRoot(asset, elevatorTf, rootId).trs.position : null
  const adjustAt = adjustTf ? composeFromRoot(asset, adjustTf, rootId).trs.position : null
  const roomAnchor =
    elevatorAt && adjustAt
      ? put('props.hangar.roomAnchor', {
          value: [elevatorAt.x, adjustAt.y, elevatorAt.z].map((v) => round(v, 6)),
          unit: 'm',
          trust: 'derived',
          origin: 'computed',
          source: `${HANGAR_PREFAB} Transforms "Elevator" (x, z) and "Position_adjustment" (y), composed from the root`,
          fileId: String(elevatorTf.fileId),
          line: lineOf(asset, elevatorTf.fileId, 'm_LocalPosition'),
          note:
            'UNITY SPACE. The origin of the ROOM frame `hangar-room.glb` is written in: the lift on its axis, at ' +
            'the floor. A Unity point p goes into that frame as (p - roomAnchor) with z negated. ' +
            "`tests/unit/hangar-light.test.ts` holds this against the GLB's own `anchorUnity`.",
        })
      : null

  // ── every Light in the prefab ──────────────────────────────────────────────────────────────
  const lights = {}
  const lightDocs = asset.docs.filter((d) => d.classId === 108)
  for (const doc of lightDocs) {
    const go = asset.byId.get(String(doc.data?.m_GameObject?.fileID ?? '0'))
    const name = String(go?.data?.m_Name ?? '?')
    const tf = asset.docs.find(
      (d) => d.classId === 4 && String(d.data?.m_GameObject?.fileID) === String(go?.fileId),
    )
    const key = name === 'light_ship' ? 'ship' : name === 'light_env' ? 'env' : null
    if (!key) {
      warn(`hangar lighting: an unexpected light "${name}" in ${HANGAR_PREFAB}`)
      continue
    }
    // Scene overrides on the light, its GameObject or its Transform.
    const targets = new Set([String(doc.fileId), String(go?.fileId), String(tf?.fileId)])
    const own = mods.filter((m) => targets.has(m.target))
    const d = structuredClone(doc.data)
    const applied = []
    for (const m of own) {
      if (m.target !== String(doc.fileId)) {
        // Only an activation override could matter here, and it would be a liveness fact.
        if (m.propertyPath === 'm_IsActive') applied.push(`GameObject m_IsActive -> ${m.value}`)
        continue
      }
      const parts = m.propertyPath.split('.')
      let at = d
      for (let i = 0; i < parts.length - 1; i++) at = at?.[parts[i]]
      if (!at || !(parts.at(-1) in at)) {
        warn(
          `hangar lighting: ${MENU_SCENE} modifies ${name}.${m.propertyPath}, which is not a Light field`,
        )
        continue
      }
      applied.push(
        `${m.propertyPath}: ${JSON.stringify(at[parts.at(-1)])} -> ${JSON.stringify(m.value)}`,
      )
      at[parts.at(-1)] = typeof at[parts.at(-1)] === 'number' ? num(m.value) : m.value
    }
    const chain = tf ? activeChainOf(asset, tf) : []
    const activeOverride = own.find(
      (m) => m.propertyPath === 'm_IsActive' && m.target === String(go?.fileId),
    )
    const live =
      num(d.m_Enabled) === 1 &&
      chain.length > 0 &&
      chain.every((c, i) =>
        i === chain.length - 1 && activeOverride
          ? num(activeOverride.value) === 1
          : c.isActive === 1,
      )
    const composed = tf ? composeFromRoot(asset, tf, rootId).trs : null
    const c = d.m_Color ?? {}
    lights[key] = put(`props.hangar.lights.${key}`, {
      value: {
        gameObject: name,
        live,
        type: UNITY_LIGHT_TYPES[num(d.m_Type)] ?? `unknown ${d.m_Type}`,
        colorSrgb: [num(c.r), num(c.g), num(c.b)].map((v) => round(v, 6)),
        intensity: round(num(d.m_Intensity), 6),
        range: round(num(d.m_Range), 6),
        spotAngleDeg: round(num(d.m_SpotAngle), 6),
        cullingMask: num(d.m_CullingMask?.m_Bits),
        shadows: {
          type: num(d.m_Shadows?.m_Type),
          strength: round(num(d.m_Shadows?.m_Strength), 6),
        },
        lightmapping: num(d.m_Lightmapping),
        positionUnity: composed
          ? [composed.position.x, composed.position.y, composed.position.z].map((v) => round(v, 6))
          : null,
        rotationUnity: composed
          ? [
              composed.rotation.x,
              composed.rotation.y,
              composed.rotation.z,
              composed.rotation.w,
            ].map((v) => round(v, 6))
          : null,
        sceneOverrides: applied.sort(),
      },
      unit: null,
      trust: 'verified',
      origin: applied.length ? 'scene-component' : 'shipped-prefab',
      source: `${HANGAR_PREFAB}#${doc.fileId} Light on "${name}"${applied.length ? `, with ${MENU_SCENE} m_Modifications` : ''}`,
      fileId: String(doc.fileId),
      line: lineOf(asset, doc.fileId, 'm_Intensity'),
      note:
        'UNITY SPACE, world = the prefab root (the instance is at identity). The light shines along its ' +
        "rotation's +z. `colorSrgb` is as authored in a Linear project, so it goes through the sRGB " +
        "transfer function; `intensity` is the multiplier Marmoset's direct term doubles " +
        '(`marmosetSunIntensity`). `cullingMask` bit 8 is `Vehicles`, and NO live renderer in the room ' +
        `is on it, so the env light's mask excludes nothing drawn. Liveness: ${chain.map((x) => `${x.name}=${x.isActive}`).join(', ')}, m_Enabled=${d.m_Enabled}.`,
    })
  }

  // ── the Skyshop ambient ────────────────────────────────────────────────────────────────────
  const sky = scanSkyshopSky(HANGAR_PREFAB)
  const liveSkies = sky.instances.filter((i) => i.activeInHierarchy && num(i.data.m_Enabled) === 1)
  if (liveSkies.length !== 1)
    warn(`hangar lighting: ${liveSkies.length} live Skyshop Skies in ${HANGAR_PREFAB}, expected 1`)
  const skyInst = liveSkies[0] ?? null
  let ibl = null
  if (skyInst) {
    const skyTargets = [
      skyInst.fileId,
      skyInst.transform?.fileId,
      String(skyInst.data.m_GameObject?.fileID ?? ''),
    ]
      .filter(Boolean)
      .map(String)
    const skyMods = mods.filter((m) => skyTargets.includes(m.target))
    if (skyMods.length) {
      warn(
        `hangar lighting: ${MENU_SCENE} modifies the hangar's Skyshop Sky (${skyMods.map((m) => m.propertyPath).join(', ')}); not applied`,
      )
    }
    const d = skyInst.data
    const sh = (d.SH?.c ?? []).map((v) => num(v))
    const buffer = (d.SH?.cBuffer ?? []).map((v) => [num(v.x), num(v.y), num(v.z)])
    let bufferMaxError = null
    if (sh.length === 27 && buffer.length === 9) {
      bufferMaxError = 0
      for (let i = 0; i < 9; i++) {
        for (let k = 0; k < 3; k++) {
          bufferMaxError = Math.max(
            bufferMaxError,
            Math.abs(sh[i * 3 + k] * MARMOSET_SH_EQUATION_CONSTANTS[i] - buffer[i][k]),
          )
        }
      }
    }
    if (sh.length !== 27 || bufferMaxError === null || bufferMaxError > 1e-6) {
      warn(
        `hangar lighting: the hangar Sky's SH does not check (${sh.length} floats, cBuffer error ${bufferMaxError})`,
      )
    }
    // The sky's own rotation, composed with every ancestor's (all identity today — `sky` and the
    // root — and composed anyway, so a rotated parent would reach the SH the way it reaches 2016's).
    let q = { x: 0, y: 0, z: 0, w: 1 }
    // `ancestors` runs nearest-first up to and INCLUDING the prefab root, whose pose in the
    // scene is the instance's (identity, checked above) rather than the prefab file's own.
    const aboveRoot = skyInst.ancestors.slice(0, -1)
    for (const a of [...aboveRoot].reverse()) {
      if (a.rotation)
        q = qMul(q, { x: a.rotation[0], y: a.rotation[1], z: a.rotation[2], w: a.rotation[3] })
    }
    const own = skyInst.transform?.rotation
    if (own) q = qMul(q, quat(own))
    const e = skyshopExposure(d)
    const at = (field) => skyLine(sky, skyInst.fileId, field)
    ibl = {
      sh: put('props.hangar.ibl.sh', {
        value: sh,
        unit: null,
        trust: 'verified',
        origin: 'shipped-prefab',
        source: `${HANGAR_PREFAB}#${skyInst.fileId} Sky.SH.c`,
        fileId: skyInst.fileId,
        line: at('SH'),
        note:
          `27 floats, RADIANCE, the terrain.*.ibl.sh convention; cBuffer cross-check error ${bufferMaxError === null ? '(unchecked)' : bufferMaxError.toExponential(2)}. ` +
          "Byte-identical to Simonet's, and at the same 139-degree yaw: the room was lit by the island's sky, " +
          "at a quarter of the island's diffuse intensity.",
      }),
      rotationUnity: put('props.hangar.ibl.rotationUnity', {
        value: [q.x, q.y, q.z, q.w].map((v) => round(v, 6)),
        unit: null,
        trust: 'verified',
        origin: 'shipped-prefab',
        source: `${HANGAR_PREFAB}#${skyInst.transform?.fileId ?? '(none)'} Transform.m_LocalRotation of "${skyInst.gameObject}", composed with its ancestors`,
        fileId: skyInst.transform?.fileId ?? null,
        line: null,
        note: "UNITY SPACE. `skyRotate()` looks the SH up through this rotation's transpose (MarmosetCore.cginc:304-309).",
      }),
      exposure: put('props.hangar.ibl.exposure', {
        value: {
          diffuse: round(e.diffuse, 6),
          specular: round(e.specular, 6),
          sky: round(e.sky, 6),
          camera: round(e.camera, 6),
        },
        unit: null,
        trust: 'derived',
        origin: 'computed',
        source: `${SKYSHOP_SKY_CS} ComputeExposureVector (Sky.cs:580-591) applied to ${HANGAR_PREFAB}#${skyInst.fileId} Sky.*Intensity`,
        fileId: skyInst.fileId,
        line: at('masterIntensity'),
        formula: `diffuse = ${d.masterIntensity} * ${d.diffIntensity} = ${round(e.diffuse, 6)}; specular = ${d.masterIntensity} * ${d.specIntensity}; sky = ${d.masterIntensity} * ${d.skyIntensity} * ${d.camExposure}`,
        note: '`_ExposureIBL`. Only `.diffuse` reaches the port: the specular half was a cubemap nobody may ship.',
      }),
    }
  }

  // ── RenderSettings, for the record ─────────────────────────────────────────────────────────
  const rs = scene.docs.find((d) => d.type === 'RenderSettings')?.data ?? null
  const sc = rs?.m_AmbientSkyColor ?? {}
  const renderSettings = rs
    ? put('props.hangar.renderSettings', {
        value: {
          ambientMode: num(rs.m_AmbientMode),
          ambientSkyColorSrgb: [num(sc.r), num(sc.g), num(sc.b)].map((v) => round(v, 6)),
          ambientIntensity: round(num(rs.m_AmbientIntensity), 6),
          fog: num(rs.m_Fog) === 1,
        },
        unit: null,
        trust: 'verified',
        origin: 'scene-component',
        source: `${MENU_SCENE} RenderSettings`,
        fileId: null,
        line: null,
        note:
          "Documentation, not a light: nothing in the port reads it, on purpose. Mode 3 is Unity's flat " +
          'ambient, and every surface in this room is a Marmoset Skyshop shader whose ambient is the SH ' +
          "above (MARMO_DIFFUSE_IBL), not Unity's. Fog is off.",
      })
    : null

  return {
    scene: MENU_SCENE,
    prefab: HANGAR_PREFAB,
    placedAtIdentity: atIdentity,
    roomAnchor,
    lights,
    ibl,
    renderSettings,
  }
}

// ---------------------------------------------------------------------------------------------
// 13g. The LAUNCH room: where `hangar-room.glb` goes under a mission's ship (DEV-438)
// ---------------------------------------------------------------------------------------------
//
// Matt, 2026-09-26: *"port the launch room."* 2016's launch rig and its level-select room are ONE
// rig in two places — `Environment_Hangar.prefab` carries a copy called `PlayerStart_ElevatorShaft_`,
// and a mission places `PlayerStart_ElevatorShaft_Photon_02.prefab` (or a materialised copy of it).
// Inside `Position_adjustment` the two agree: the same `Elevator`, the room's three meshes at
// identity, the eight shaft segments 12 m apart. What differs is the rig's ROOT, and one thing about
// it matters more than where it is: **the level-select copy is SCALED, (0.85, 0.733, 0.85)**. So the
// room you choose a mission in is 85 % as wide and 73 % as tall as the room a mission launches you
// from, and `hangar-room.glb` — written in the level-select room's own metres, because the metre is
// sacred there — is the smaller one.
//
// This block is the one matrix that takes the GLB's ROOM frame to the frame the port hangs its launch
// on: `launch-anchor`, the ship at rest, three space. Composed, never typed —
//
//   ROOM (three)  -> un-mirror -> + roomAnchor           Unity world of setGameplayOptions
//                 -> inverse(Position_adjustment world)   the rig's own frame, the scale UNDONE
//                 -> inverse(PlayerShipRoot in that frame, from the MISSION rig)
//                 -> mirror                               the ship's frame, three space
//
// — and what it says in words is: turn 7.9 degrees, stretch by 1/0.85 across and 1/0.733 up, and put
// the lift's axis 1.3 m behind the ship. `tests/unit/launch-art.test.ts` holds the result against
// numbers that did not come through this block: the level JSON's platform offsets and size, and its
// segment spacing.

const LAUNCH_ROOM_NODES = [
  'startingArea_bottomFloor',
  'botfloor_room',
  'botfloor_startingArea',
  'botfloor_startingArea2',
]

function extractLaunchRoom(lighting) {
  if (!lighting?.roomAnchor) {
    warn('launch room: no props.hangar.roomAnchor, so no launch placement')
    return null
  }
  if (!unityExists(HANGAR_PREFAB) || !unityExists(LAUNCH_RIG_PREFAB)) {
    warn(`launch room: ${HANGAR_PREFAB} or ${LAUNCH_RIG_PREFAB} is missing; nothing extracted`)
    return null
  }
  const menu = loadAsset(HANGAR_PREFAB)
  const rig = loadAsset(LAUNCH_RIG_PREFAB)
  const tfNamed = (asset, name) =>
    asset.docs.filter((d) => d.classId === 4 && gameObjectName(asset, d) === name)
  const oneTf = (asset, label, name) => {
    const hits = tfNamed(asset, name)
    if (hits.length !== 1) warn(`launch room: ${label} has ${hits.length} Transforms named ${name}`)
    return hits[0] ?? null
  }
  const menuAdjust = oneTf(menu, HANGAR_PREFAB, 'Position_adjustment')
  const rigAdjust = oneTf(rig, LAUNCH_RIG_PREFAB, 'Position_adjustment')
  const rigShip = oneTf(rig, LAUNCH_RIG_PREFAB, 'PlayerShipRoot')
  if (!menuAdjust || !rigAdjust || !rigShip) return null

  // ── the two rigs agree inside Position_adjustment, or none of this is one room ────────────────
  const under = (asset, adjust, name) => {
    const tf = tfNamed(asset, name).find((d) => {
      for (let n = d; n; n = asset.byId.get(String(n.data?.m_Father?.fileID ?? '0'))) {
        if (String(n.fileId) === String(adjust.fileId)) return true
      }
      return false
    })
    return tf ? composeFromRoot(asset, tf, String(adjust.fileId)).trs : null
  }
  const same = (a, b) =>
    a &&
    b &&
    ['position', 'rotation', 'scale'].every((k) =>
      ['x', 'y', 'z', 'w']
        .filter((c) => c in a[k])
        .every((c) => Math.abs(a[k][c] - b[k][c]) <= LAUNCH_Y_EPSILON),
    )
  const agreeing = []
  for (const name of ['Elevator', ...LAUNCH_ROOM_NODES]) {
    const a = under(menu, menuAdjust, name)
    const b = under(rig, rigAdjust, name)
    if (!same(a, b)) {
      warn(
        `launch room: ${name} sits differently under Position_adjustment in ${HANGAR_PREFAB} and ${LAUNCH_RIG_PREFAB} — the level-select room is not the launch room`,
      )
    } else agreeing.push(name)
  }

  // ── the deck: the one piece the two rigs place differently ────────────────────────────────────
  //
  // `Projector04-Faceted` sits 0.51 m LOWER under the level-select rig's animator than under the
  // mission's, and nowhere else differs. `hangar-room.glb` carries the menu's; the launch wants the
  // mission's. So the difference is carried as a lift in the launch frame — valid only while it is
  // a pure y offset, which is checked, and in metres because `fromRoom` has already undone the scale.
  const menuDeck = under(menu, menuAdjust, 'Projector04-Faceted')
  const rigDeck = under(rig, rigAdjust, 'Projector04-Faceted')
  let deckLift = null
  if (menuDeck && rigDeck) {
    const pureY =
      same(
        { ...menuDeck, position: { ...menuDeck.position, y: 0 } },
        { ...rigDeck, position: { ...rigDeck.position, y: 0 } },
      ) === true
    if (!pureY) {
      warn(
        'launch room: the deck differs between the two rigs by more than a height — a lift cannot carry it',
      )
    } else {
      const deckTf = tfNamed(rig, 'Projector04-Faceted')[0]
      deckLift = put('props.launchRoom.deckLift', {
        value: round(rigDeck.position.y - menuDeck.position.y, 6),
        unit: 'm',
        trust: 'derived',
        origin: 'computed',
        source: `Projector04-Faceted's y under Position_adjustment: ${LAUNCH_RIG_PREFAB} minus ${HANGAR_PREFAB}`,
        fileId: deckTf ? String(deckTf.fileId) : null,
        line: deckTf ? lineOf(rig, deckTf.fileId, 'm_LocalPosition') : null,
        formula: `${round(rigDeck.position.y, 6)} - (${round(menuDeck.position.y, 6)})`,
        note: "Added to the deck's height after `fromRoom`: the GLB's deck is where the MENU stood it.",
      })
    }
  } else warn('launch room: no Projector04-Faceted under Position_adjustment in one of the rigs')

  // ── the menu rig's world, scale and all; and the scene must not move it ────────────────────────
  const menuRoot = rootTransformOf(menu)
  const adjustWorld = composeFromRoot(menu, menuAdjust, String(menuRoot.fileId)).trs
  const scene = loadAsset(MENU_SCENE)
  const hangarGuid = pathToGuid.get(HANGAR_PREFAB) ?? null
  const inst = instancesOf(scene.docs, hangarGuid)[0]
  const chain = new Set()
  for (let n = menuAdjust; n; n = menu.byId.get(String(n.data?.m_Father?.fileID ?? '0'))) {
    chain.add(String(n.fileId))
  }
  const moved = modificationsOf(inst).filter(
    (m) =>
      chain.has(modTarget(m)) &&
      String(m?.target?.fileID) !== String(menuRoot.fileId) &&
      /^m_Local(Position|Rotation|Scale)/.test(modPath(m)),
  )
  if (moved.length) {
    warn(
      `launch room: ${MENU_SCENE} overrides the level-select rig's transform (${moved.map((m) => m.propertyPath).join(', ')}) — the prefab's numbers below are not the scene's`,
    )
  }

  // ── the ship, in the MISSION rig's Position_adjustment frame ───────────────────────────────────
  const ship = composeFromRoot(rig, rigShip, String(rigAdjust.fileId)).trs
  if ([ship.scale.x, ship.scale.y, ship.scale.z].some((s) => Math.abs(s - 1) > 1e-9)) {
    warn('launch room: a scale between Position_adjustment and PlayerShipRoot')
  }

  // ── compose, as a function of a point, then read the matrix off it ─────────────────────────────
  const [ax, ay, az] = lighting.roomAnchor
  const qInv = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w })
  const P = adjustWorld.position
  const S = adjustWorld.scale
  const toShip = ([x, y, z]) => {
    // three -> Unity, into setGameplayOptions' world
    const w = { x: x + ax, y: y + ay, z: -z + az }
    // into Position_adjustment's frame: un-translate, un-rotate, UN-SCALE
    const r = qRotate(qInv(adjustWorld.rotation), { x: w.x - P.x, y: w.y - P.y, z: w.z - P.z })
    const pa = { x: r.x / S.x, y: r.y / S.y, z: r.z / S.z }
    // into the ship's frame, then back to three
    const s = qRotate(qInv(ship.rotation), {
      x: pa.x - ship.position.x,
      y: pa.y - ship.position.y,
      z: pa.z - ship.position.z,
    })
    return [s.x, s.y, -s.z]
  }
  const o = toShip([0, 0, 0])
  const cols = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ].map((e) => toShip(e).map((v, k) => v - o[k]))
  const fromRoom = [...cols[0], 0, ...cols[1], 0, ...cols[2], 0, ...o, 1].map((v) =>
    round(Math.abs(v) < 5e-13 ? 0 : v, 9),
  )

  const scaleSrc = `${HANGAR_PREFAB} Position_adjustment composed from the root (PlayerStart_ElevatorShaft_'s m_LocalScale)`
  return {
    rigPrefab: LAUNCH_RIG_PREFAB,
    menuPrefab: HANGAR_PREFAB,
    agreeInsideTheRig: agreeing,
    deckLift,
    menuRigScale: put('props.launchRoom.menuRigScale', {
      value: [S.x, S.y, S.z].map((v) => round(v, 6)),
      unit: null,
      trust: 'verified',
      origin: 'shipped-prefab',
      source: scaleSrc,
      fileId: String(menuAdjust.fileId),
      line: lineOf(menu, menuAdjust.fileId, 'm_LocalScale'),
      note: 'The level-select room is this scale of the launch room. `hangar-room.glb` is written at it; `fromRoom` undoes it.',
    }),
    fromRoom: put('props.launchRoom.fromRoom', {
      value: fromRoom,
      unit: null,
      trust: 'derived',
      origin: 'computed',
      source: `${HANGAR_PREFAB} Position_adjustment (world, scale included) and props.hangar.roomAnchor; ${LAUNCH_RIG_PREFAB} Position_adjustment/Elevator/Elevator_animator/PlayerShipRoot`,
      fileId: String(rigShip.fileId),
      line: lineOf(rig, rigShip.fileId, 'm_LocalPosition'),
      formula:
        'mirror . inverse(PlayerShipRoot in Position_adjustment, mission rig) . inverse(Position_adjustment world, level-select rig) . translate(roomAnchor) . mirror',
      note: "THREE SPACE, a column-major 4x4 (three's Matrix4.elements). Takes a point in `hangar-room.glb`'s ROOM frame to `launch-anchor`'s frame: the ship at rest, the frame `render/elevator.ts` builds the lift in. Not rigid: it carries 1/menuRigScale.",
    }),
  }
}

// ---------------------------------------------------------------------------------------------
// 13h. The level-select room's two REFLECTIVE materials (DEV-439)
// ---------------------------------------------------------------------------------------------
//
// Matt, 2026-09-26: *"port the ambient."* Of the room's five materials only two were authored against
// Marmoset's SPECULAR shader family — the lift's deck (`lowPolyArt/lambert1`, the VertexColor
// variant) and the shaft segments (`ent_elevatorShaft_pwn_Mat`) — so only those two reflect the
// Skyshop specular sky. The shell, the lower shaft, the chair and the tables are Diffuse IBL and take
// the SH alone. This block reads each reflective material's four numbers, finding the material the
// way a player's frame does: the renderer in `Environment_Hangar.prefab`, its `m_Materials[0]`, then
// the file. `render/hangar-art.ts` turns them into three's F0 and roughness with the conversions the
// terrain already uses (`render/terrain-mesh.ts`); nothing of the shader's source is involved.

/** Each part: the renderers' names, and the ancestor they must hang under (the rig's lift, a segment). */
const HANGAR_REFLECTIVE = {
  deck: { under: 'Elevator_animator', names: ['Projector04-Faceted'] },
  shaft: { under: 'elev_shaft_01', names: ['walls_and_pillars', 'pipes_LOD3', 'vent'] },
}

function extractHangarSpecular() {
  if (!unityExists(HANGAR_PREFAB)) {
    warn(`hangar specular: ${HANGAR_PREFAB} is missing; nothing extracted`)
    return null
  }
  const asset = loadAsset(HANGAR_PREFAB)
  const tfOf = (go) => componentsOfGo(asset.byId, go).find((c) => c.type === 'Transform')
  const hangsUnder = (go, ancestor) => {
    let tf = tfOf(go)
    for (let guard = 0; tf && guard < 512; guard++) {
      const father = asset.byId.get(String(tf.data?.m_Father?.fileID ?? '0'))
      if (!father) return false
      if (gameObjectName(asset, father) === ancestor) return true
      tf = father
    }
    return false
  }
  const materialsOf = (name, ancestor) =>
    asset.docs
      .filter((d) => d.type === 'GameObject' && d.data?.m_Name === name && hangsUnder(d, ancestor))
      .flatMap((go) =>
        componentsOfGo(asset.byId, go)
          .filter((c) => c.classId === 23)
          .map((r) => String(r.data?.m_Materials?.[0]?.guid ?? '')),
      )
      .map((g) => resolveGuid(g) ?? `guid:${g}`)
  const out = {}
  for (const [part, { under, names }] of Object.entries(HANGAR_REFLECTIVE)) {
    const found = [...new Set(names.flatMap((n) => materialsOf(n, under)))]
    if (found.length !== 1) {
      warn(
        `hangar specular: the ${part}'s renderers wear ${JSON.stringify(found)}, not one material`,
      )
      continue
    }
    const matRel = found[0]
    const mat = loadAsset(matRel)
    const doc = mat.docs.find((d) => d.data?.m_SavedProperties) ?? mat.docs[0]
    const shaderGuid = String(doc?.data?.m_Shader?.guid ?? '')
    const shader = resolveGuid(shaderGuid) ?? `guid:${shaderGuid}`
    if (!/Marmoset.*Specular IBL/.test(shader)) {
      warn(
        `hangar specular: the ${part}'s ${matRel} is not a Marmoset Specular IBL material (${shader})`,
      )
    }
    const specColor = materialColour(matRel, '_SpecColor')
    out[part] = put(`props.hangar.specular.${part}`, {
      value: {
        material: matRel,
        shader,
        shininess: materialFloat(matRel, '_Shininess'),
        specInt: materialFloat(matRel, '_SpecInt'),
        fresnel: materialFloat(matRel, '_Fresnel'),
        specColorSrgb: specColor ? specColor.slice(0, 3) : null,
      },
      unit: null,
      trust: 'verified',
      origin: 'shipped-prefab',
      source: `${HANGAR_PREFAB} ${names.join(' / ')} MeshRenderer.m_Materials[0] -> ${matRel} m_SavedProperties`,
      fileId: String(doc?.fileId ?? ''),
      line: null,
      note:
        "Marmoset's `_Shininess` (Specular Sharpness, 2..8), `_SpecInt`, `_Fresnel` and `_SpecColor` (sRGB). " +
        'The reflected sky is the Skyshop specular at `props.hangar.ibl.exposure.specular`.',
    })
  }
  return out
}

main()
