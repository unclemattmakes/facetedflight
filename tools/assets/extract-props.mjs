// tools/assets/extract-props.mjs — bring the prop art over.
//
//   node tools/assets/extract-props.mjs           # convert everything
//   node tools/assets/extract-props.mjs --list    # what would be converted
//   node tools/assets/extract-props.mjs --env alpine
//   node tools/assets/extract-props.mjs --kind unity    # only the `.asset` meshes (no Blender)
//   node tools/assets/extract-props.mjs --out <dir>     # write somewhere else, rows beside them
//
// Writes `public/assets/props/<id>.glb` (gitignored) and prints manifest rows.
//
// ── Licence ───────────────────────────────────────────────────────────────
//
// These meshes are BOUGHT, or baked from bought geometry, and they ship under
// `LICENSED` — see content/MANIFEST.md's legend, corrected 2026-09-13. An Asset
// Store purchase grants use in the buyer's own products, unlimited, and not
// only in Unity. What it withholds is redistribution in extractable form.
//
// So: into the game, yes. Into git, never — the denylist refuses every binary
// regardless of licence and that gate is unchanged. Onto the content bucket,
// yes, with the honest caveat that a web build has no compiled container and a
// `.glb` URL is a file anyone can fetch. That is Matt's call, taken knowingly.
//
// ── Two source formats, two converters, and a trap in each ────────────────
//
// `MM_*` are Unity YAML `.asset` meshes — the Mesh Materializer bakes, i.e. the
// FACETED look. `tools/assets/prop-mesh-glb.mjs` decodes them (the hardened
// reader, `unity-mesh-asset.mjs`) and negates Z with a winding reverse, which is
// the correct Unity -> glTF change of handedness. It replaced the prototype
// `unity_mesh_to_obj.js` in DEV-760 and writes the SAME BYTES (proved for all
// sixteen: docs/plan/code-reuse/progress/reuse-prop-mesh.md), so nothing needed
// re-exporting.
//
// Raw pack `.fbx` go through Blender (`tools/prototype/blender_fbx_to_glb.py`).
// **That path is the one that shipped every mesh mirrored in x for a session**
// (trap 22): a mirror reverses winding, so the geometry was also inside-out,
// and it hid on a symmetric cockpit and a hexagonal gate. Anything converted
// here that is ASYMMETRIC needs a measurement against something in its own
// prefab before it is believed.
//
// ── What is NOT emitted ───────────────────────────────────────────────────
//
// Nothing is invented. Every mesh here is named by `content/environments/
// *.json`, which was itself extracted from the shipped scenes and prefabs, so
// a mesh that appears is a mesh some generator or landmark actually places.
//
// The legacy Unity project is READ-ONLY. This reads and never writes there.

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertOutsideLegacy, legacyRoot } from '../legacy-root.mjs'
import { propGlbFromAsset } from './prop-mesh-glb.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LEGACY = legacyRoot()
const ENV_DIR = path.join(REPO, 'content', 'environments')
const argv = process.argv.slice(2)
const argAfter = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null)
// `--out` is how a conversion is run WITHOUT touching `public/assets/`, which is
// one folder shared by every checkout.
const OUT_DIR = argAfter('--out')
  ? path.resolve(argAfter('--out'))
  : path.join(REPO, 'public', 'assets', 'props')
const BLENDER =
  process.env.FF2_BLENDER ?? 'C:/Program Files/Blender Foundation/Blender 5.1/blender.exe'
// The HARDENED converter, not tools/prototype/blender_fbx_to_glb.py. The
// prototype does no unit-scale fix, no opaque-colour fix and no unmirror;
// cross-checking GL-Palmtree-01 through both paths caught it negating x and
// swapping y/z against the Unity decode of the same geometry (trap 22).
const BLENDER_SCRIPT = path.join(REPO, 'tools', 'assets', 'convert-fbx.py')

const listOnly = argv.includes('--list')
const onlyEnv = argAfter('--env')
const onlyKind = argAfter('--kind') // 'unity' | 'fbx' | null
if (onlyKind && onlyKind !== 'unity' && onlyKind !== 'fbx') {
  console.error('--kind takes unity or fbx')
  process.exit(2)
}

/**
 * `Assets/…/MM_Tree1/Tree1_MM.asset` -> `tree1`, stable and URL-safe.
 *
 * `node` is the SUB-MESH name when the source is a container, and then it — not
 * the file — names the asset. Mirrors `meshAssetPath()` in
 * tools/extract/props.mjs; the two must agree or the game asks for a URL this
 * tool never wrote. Keep them together.
 */
const assetId = (rel, node = null) => {
  const stem = node ?? path.basename(rel).replace(/\.(asset|fbx)$/i, '')
  return stem
    .replace(/^MM_/, '')
    .replace(/_MM$/, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

/**
 * The scale Unity applies to an FBX at IMPORT, reproduced.
 *
 * ── The bug this exists to not have ──────────────────────────────────────
 *
 * `convert-fbx.py` discards Blender's centimetre compensation, which is right
 * for the ship meshes — their FBX vertices are already in metres — and wrong
 * for a pack authored in centimetres. Nothing told it which it had, so the Tree
 * Pack and the AxeyWorks bushes shipped **100x** oversized: desert's bushes
 * were 359-1,077 m and alpine's trees kilometres tall (DEV-099).
 *
 * Unity's rule, reproduced here rather than guessed:
 *
 *   useFileScale: 1  ->  fileScale = UnitScaleFactor / 100   (cm file -> 0.01)
 *   useFileScale: 0  ->  fileScale = 1
 *   then multiplied by the importer's own `globalScale`.
 *
 * Checked against an INDEPENDENT number: Unity's `LODGroup.m_Size` is the
 * authored world size of the prefab's geometry, and for Tree1/Tree5/Tree10 it
 * is 1.8676 / 2.4900 / 3.8881 against raw FBX extents of 186.76 / 249.00 /
 * 388.81. A ratio of exactly 100.000, three times, from a field that has
 * nothing to do with this calculation. That is why this is a port of Unity's
 * rule and not a plausible constant.
 *
 * The six Geometric-Landscape palms carry `useFileScale: 0`, so they come back
 * 1.0 and their published bytes do not move — which is the check that this did
 * not "fix" the assets that were already right.
 */
const fbxUnitScale = (rel) => {
  const meta = path.join(LEGACY, `${rel}.meta`)
  if (!fs.existsSync(meta)) return 1
  const text = fs.readFileSync(meta, 'utf8')
  const useFileScale = /^\s*useFileScale: (\d+)/m.exec(text)?.[1] === '1'
  const globalScale = Number(/^\s*globalScale: ([\d.]+)/m.exec(text)?.[1] ?? 1)
  if (!useFileScale) return globalScale
  // `UnitScaleFactor` lives in the FBX itself — ASCII as a quoted property,
  // binary as a little-endian double after the `D` type tag.
  const buf = fs.readFileSync(path.join(LEGACY, rel))
  const at = buf.indexOf('UnitScaleFactor')
  if (at < 0) return globalScale
  const seg = buf.subarray(at, at + 200)
  const ascii = /"double",\s*"Number",\s*"",([\d.]+)/.exec(seg.toString('latin1'))
  let unit = ascii ? Number(ascii[1]) : null
  if (unit === null) {
    for (let i = 0; i < seg.length - 9; i++) {
      if (seg[i] !== 0x44) continue // 'D'
      const v = seg.readDoubleLE(i + 1)
      if (v > 0.0001 && v < 10000) {
        unit = v
        break
      }
    }
  }
  if (unit === null) return globalScale
  return (unit / 100) * globalScale
}

/** Collect every distinct mesh the extracted environments actually place. */
const collect = () => {
  const wanted = new Map()
  const files = fs
    .readdirSync(ENV_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .filter((f) => !onlyEnv || f === `${onlyEnv}.json`)

  for (const file of files) {
    const env = JSON.parse(fs.readFileSync(path.join(ENV_DIR, file), 'utf8'))
    const add = (mesh, origin, licence, usedBy, node = null) => {
      if (!mesh) return
      const id = assetId(mesh, node)
      const hit = wanted.get(id)
      if (hit) {
        hit.usedBy.add(usedBy)
        return
      }
      wanted.set(id, { id, mesh, node, origin, licence, usedBy: new Set([usedBy]) })
    }
    for (const s of env.scatter ?? []) {
      for (const p of s.palette ?? []) add(p.mesh, p.origin, p.licence, env.id, p.meshNode ?? null)
    }
    for (const l of env.landmarks ?? []) add(l.mesh, l.origin, l.licence, env.id)
  }
  return [...wanted.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// Z negated, winding reversed, glTF being right-handed: see prop-mesh-glb.mjs.
// Nothing else is written (the prototype left an .obj and a .json beside it).
const convertUnityMesh = (src, out) => {
  fs.writeFileSync(out, propGlbFromAsset(src))
}

/**
 * Blender's EXIT CODE IS NOT EVIDENCE HERE, in either direction.
 *
 * This machine has a `brushstroke_tools` extension that throws from its
 * `unregister()` during Blender's shutdown, long after the export has been
 * written. Blender exits non-zero, `execFileSync` throws, and a conversion that
 * printed `[OK] ... (122,928 bytes)` and produced a correct GLB is reported as
 * a failure. Eight of thirteen props "failed" that way.
 *
 * The usual lesson is to read the exit code of the command you actually care
 * about rather than the pipe's. This is that lesson inverted: the exit code
 * belongs to the process teardown and not to the work. So the ground truth is
 * the tool's own `[OK]`/`[FAIL]` line plus the artifact on disk, and a throw is
 * only fatal when those disagree.
 */
const convertFbx = (src, out, unitScale = 1, node = null) => {
  const args = ['--background', '--python', BLENDER_SCRIPT, '--', '--src', src, '--dest', out]
  if (unitScale !== 1) args.push('--unit-scale', String(unitScale))
  if (node) args.push('--node', node)
  let stdout = ''
  try {
    stdout = String(execFileSync(BLENDER, args, { stdio: 'pipe' }))
  } catch (err) {
    stdout = String(err.stdout ?? '')
    if (!stdout.includes('[OK]') || !fs.existsSync(out)) throw err
  }
  if (stdout.includes('[FAIL]')) {
    const fail = /^.*\[FAIL\].*$/m.exec(stdout)
    throw new Error(fail ? fail[0] : 'convert-fbx reported [FAIL]')
  }
}

// ── main ──────────────────────────────────────────────────────────────────

const isUnityAsset = (it) => it.mesh.toLowerCase().endsWith('.asset')
const items = collect().filter((it) => !onlyKind || (onlyKind === 'unity') === isUnityAsset(it))
console.log(`${items.length} distinct prop meshes named by content/environments/\n`)

if (listOnly) {
  for (const it of items) {
    const kind = it.mesh.endsWith('.asset') ? 'unity' : 'fbx  '
    if (!it.mesh.endsWith('.asset')) {
      const u = fbxUnitScale(it.mesh)
      if (u !== 1 || it.node) {
        console.log(`      unit-scale ${u}${it.node ? `  node ${it.node}` : ''}`)
      }
    }
    console.log(`  ${kind}  ${it.id.padEnd(24)} ${it.licence.padEnd(8)} ${it.mesh}`)
  }
  process.exit(0)
}

assertOutsideLegacy(OUT_DIR)
fs.mkdirSync(OUT_DIR, { recursive: true })

// `--clean` removes ONLY the files this tool owns.
//
// `assets/props/` is shared: `checkpoint-ring.glb`, `turn-indicator.glb`,
// `cliff.glb`, `rock1.glb` and `title-logo.glb` were staged there long before
// the scatter existed. A `rm public/assets/props/*.glb` between runs therefore
// deletes five assets nobody is thinking about, and the only thing that
// notices is `turn-indicator.test.ts` quietly moving three mirror assertions
// from PASS to SKIP while the suite stays green. (It happened; the restore was
// possible only because the manifest records a sha256 per asset, which is also
// the thing that proved the restore was byte-correct.)
//
// So: never reach for a glob. This deletes the ids in `collect()` and nothing
// else, and anything it does not recognise it leaves alone.
if (argv.includes('--clean')) {
  let removed = 0
  for (const it of items) {
    const f = path.join(OUT_DIR, `${it.id}.glb`)
    if (fs.existsSync(f)) {
      fs.rmSync(f)
      removed++
    }
  }
  console.log(`  --clean: removed ${removed} tool-owned glb, left everything else
`)
}

const rows = []
let failed = 0

for (const it of items) {
  const src = path.join(LEGACY, it.mesh)
  const out = path.join(OUT_DIR, `${it.id}.glb`)
  if (!fs.existsSync(src)) {
    console.error(`  MISSING  ${it.mesh}`)
    failed++
    continue
  }
  try {
    if (isUnityAsset(it)) convertUnityMesh(src, out)
    else convertFbx(src, out, fbxUnitScale(it.mesh), it.node)
  } catch (err) {
    console.error(`  FAILED   ${it.id}: ${String(err.message ?? err).split('\n')[0]}`)
    failed++
    continue
  }
  if (!fs.existsSync(out)) {
    console.error(`  NO OUTPUT ${it.id}`)
    failed++
    continue
  }
  const bytes = fs.readFileSync(out)
  rows.push({
    id: `prop.${it.id}`,
    path: `assets/props/${it.id}.glb`,
    kind: 'mesh',
    // `planned`, not `staged`: `staged` makes check-assets-present look for a
    // `stagedFrom` file in the staging dir, and these are written straight to
    // public/assets/ by this tool. Same convention the World Machine terrain
    // maps already use — produced on demand, not yet pushed to the bucket.
    state: 'planned',
    bytes: bytes.length,
    sha256: sha256(bytes),
    // `LICENSED`, not `REPLACE`: bought geometry is licensed for USE. See the
    // header and content/MANIFEST.md's legend.
    licence: it.licence === 'KEEP' ? 'KEEP' : 'LICENSED',
    source: it.mesh,
    notes:
      `Prop mesh placed by ${[...it.usedBy].sort().join(', ')}. Origin: ${it.origin}. ` +
      'Ships under the Asset Store EULA, which grants use in the buyer\u2019s own products and ' +
      'is not restricted to Unity; it withholds redistribution in extractable form, so this ' +
      'never enters git and is never offered as a standalone download.',
  })
  console.log(`  ok  ${it.id.padEnd(24)} ${String(bytes.length).padStart(9)} B  ${it.origin}`)
}

// NOT into OUT_DIR. `public/assets/` IS the bucket's contents — everything in
// it is uploaded verbatim by `pnpm assets:push` — and this file is a manifest
// fragment for a human to merge, not something the game loads. Writing it
// beside the art put a tool intermediate one `rclone copy` away from being
// served under the game's own asset URLs. The push DRY-RUN is what caught it,
// which is the argument for dry-running an external write even when the
// command is a one-liner you have read.
//
// With `--out` the rows go beside the scratch GLBs instead, so a trial run
// leaves the repo's own props-rows.json alone.
const ROWS_OUT = argAfter('--out')
  ? path.join(OUT_DIR, 'props-rows.json')
  : path.join(REPO, 'tools', 'assets', 'props-rows.json')
assertOutsideLegacy(ROWS_OUT)
fs.writeFileSync(
  ROWS_OUT,
  `${JSON.stringify(rows, null, 2)}
`,
)
console.log(
  `\n${rows.length} converted, ${failed} failed. Rows -> ${argAfter('--out') ? ROWS_OUT : 'tools/assets/props-rows.json'}`,
)
if (failed > 0) process.exitCode = 1
