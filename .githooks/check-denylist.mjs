#!/usr/bin/env node
/**
 * check-denylist.mjs — the single asset/licence gate for this repository.
 *
 * WHY THIS EXISTS (DECISIONS.md D12 + D26, docs/research/08-third-party-audit.md §7).
 * The 2016 Unity project this port reads from contains ~55 third-party Asset Store packs.
 * Those licences permit use inside a BUILT PRODUCT and forbid redistribution "in a form that
 * allows it to be extracted". Several packs ship no licence file, no readme and no credits at
 * all. `Materialized Mesh/MM_*` are Matt's own bakes of BOUGHT geometry — derivative works that
 * look first-party. Git history is forever and a history rewrite after the fact is not a
 * reliable remedy, so nothing bought, and nothing derived from something bought, may ever be
 * committed. See ASSET-PROVENANCE.md for the file-by-file ruling.
 *
 * `.gitignore` is the first line of defence. This is the second, because a single `git add -f`,
 * or a file extension nobody anticipated, is all it takes to defeat the first.
 *
 * ONE implementation, called from BOTH places, so the hook and CI can never disagree:
 *   .githooks/pre-commit                 -> --staged   (blocks the commit)
 *   .github/workflows/asset-denylist.yml -> --tree     (blocks the push/PR)
 *                                        -> --history  (blocks a bad object anywhere in history)
 *
 * Usage:
 *   node .githooks/check-denylist.mjs --staged            check what is staged for commit
 *   node .githooks/check-denylist.mjs --tree              check every tracked file
 *   node .githooks/check-denylist.mjs --history           check every blob in every commit
 *   node .githooks/check-denylist.mjs --files a b c ...   check these paths (no git needed)
 *   node .githooks/check-denylist.mjs --stdin             check paths from stdin (NL or NUL)
 *   node .githooks/check-denylist.mjs --list-rules        print the rule tables and exit
 *   node .githooks/check-denylist.mjs --max-bytes N       override the size ceiling (testing)
 *   node .githooks/check-denylist.mjs --quiet             print only on failure
 *
 * Exit codes: 0 = clean · 1 = violations found · 2 = usage or internal error.
 *
 * This script deliberately has ZERO dependencies and does not import from src/ — it must run
 * before `pnpm install` in a fresh clone, and inside a git hook where cwd may be anywhere.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

// =================================================================================================
// 1. The size ceiling
//
// 256 KiB, the number named in DECISIONS.md D26. Justification against what is actually on disk:
//
//   largest legitimate hand-written source .......... tools/extract/constants.mjs   ~105 KiB
//   largest committed level design JSON ............. content/levels/adv_01_*.json  ~140 KiB
//   largest research doc ............................ 11a-king-tide-app-shell.md    ~176 KiB
//   ---- 256 KiB ceiling sits here, ~1.8x above the largest real text file --------------------
//   smallest extracted mesh that MATTERS ............ MM_TI_Old_Tree_05.glb         ~328 KiB
//
// So the ceiling has comfortable headroom over every legitimate text file in the tree while
// still landing below the derivative-work mesh that D26 was written about. Small binaries
// (checkpoint_ring.glb is 5.7 KiB) slip under it — which is exactly why the size rule is the
// THIRD line of defence and not the only one. The extension and path rules catch those.
//
// Raising this number is a licensing decision, not a convenience. Add a SIZE_ALLOW entry with a
// written reason instead; every entry there is still capped by HARD_CEILING.
// =================================================================================================

const DEFAULT_MAX_BYTES = 256 * 1024
const HARD_CEILING = 2 * 1024 * 1024

// =================================================================================================
// 2. Denied file extensions
//
// Grouped so the failure message can say WHY, not just "denied". Extensions are matched
// case-insensitively against the end of the file name.
// =================================================================================================

/** @type {ReadonlyArray<{ group: string, why: string, ext: readonly string[] }>} */
const DENIED_EXTENSIONS = [
  {
    group: 'mesh / 3D',
    why: 'geometry is bought, or baked from bought geometry (MM_*) — bucket, never git',
    ext: [
      '.glb',
      '.gltf',
      '.bin',
      '.drc',
      '.fbx',
      '.obj',
      '.mtl',
      '.dae',
      '.3ds',
      '.stl',
      '.ply',
      '.abc',
      '.usd',
      '.usda',
      '.usdc',
      '.usdz',
      '.blend',
      '.blend1',
      '.blend2',
      '.max',
      '.ma',
      '.mb',
    ],
  },
  {
    group: 'texture / image',
    why: 'textures and skies come from Asset Store packs; compiled art lives on the bucket',
    ext: [
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.bmp',
      '.tif',
      '.tiff',
      '.tga',
      '.psd',
      '.psb',
      '.xcf',
      '.webp',
      '.ico',
      '.icns',
      '.exr',
      '.hdr',
      '.dds',
      '.ktx',
      '.ktx2',
      '.basis',
      '.pvr',
      '.astc',
      '.cubemap',
    ],
  },
  {
    group: 'audio',
    why: 'every shipped clip is licensed to Matt for use in a product, not for redistribution',
    ext: [
      '.wav',
      '.mp3',
      '.ogg',
      '.opus',
      '.aif',
      '.aiff',
      '.flac',
      '.m4a',
      '.aac',
      '.wma',
      '.mid',
      '.midi',
    ],
  },
  {
    group: 'video',
    why: 'capture and trailer footage belongs on the bucket, not in history',
    ext: ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.wmv', '.m4v'],
  },
  {
    group: 'font',
    why: 'font files are separately licensed (one shipped face is CC-BY-SA) — link, do not vendor',
    ext: ['.ttf', '.otf', '.woff', '.woff2', '.eot', '.ttc', '.fnt'],
  },
  {
    group: 'Unity project file',
    why: 'a Unity asset/scene/prefab/material serialises third-party content and GUIDs verbatim',
    ext: [
      '.unity',
      '.prefab',
      '.asset',
      '.mat',
      '.anim',
      '.controller',
      '.overridecontroller',
      '.mask',
      '.physicmaterial',
      '.mixer',
      '.fontsettings',
      '.guiskin',
      '.terrainlayer',
      '.unitypackage',
      '.meta',
      '.shader',
      '.cginc',
      '.shadergraph',
      '.compute',
      '.cs',
    ],
  },
  {
    group: 'binary blob / archive',
    why: 'opaque bytes cannot be licence-reviewed by a human reading a diff',
    ext: [
      '.dll',
      '.so',
      '.dylib',
      '.exe',
      '.pdb',
      '.lib',
      '.a',
      '.jar',
      '.aar',
      '.bundle',
      '.wasm',
      '.zip',
      '.7z',
      '.rar',
      '.tar',
      '.gz',
      '.tgz',
      '.bz2',
      '.xz',
      '.pak',
      '.raw',
      '.r16',
      '.bytes',
      '.f32',
      '.npy',
      '.tmd',
      '.pdf',
      '.rtf',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
    ],
  },
]

// =================================================================================================
// 3. Denied paths and names
// =================================================================================================

/** Path prefixes (repo-relative, forward slashes) that may never be committed. */
const DENIED_PREFIXES = [
  {
    prefix: 'tools/prototype/out/',
    why: 'extractor scratch — meshes and clips derived from the read-only Unity project (D26)',
  },
  { prefix: 'public/assets/', why: 'compiled runtime assets live on the content bucket (D12)' },
  { prefix: 'public/audio/', why: 'compiled audio lives on the content bucket (D12)' },
  {
    prefix: 'docs/private/',
    why: 'per-vendor licence evidence — conclusions are public, evidence is not',
  },
  { prefix: 'legacy/', why: 'the 2016 Unity project must never be copied into this tree' },
]

/**
 * Exact path segments that mean somebody copied a vendor pack folder in wholesale.
 * Taken from the folder census in docs/research/08-third-party-audit.md §2.1.
 * Matched case-insensitively against whole path segments only, so a doc *named* after a pack
 * (e.g. docs/marmoset-shader-notes.md) does not trip it.
 */
const DENIED_DIR_SEGMENTS = [
  'FF Backup - Update 02',
  'Materialized Mesh',
  'Marmoset',
  'VacuumShaders',
  'Curvy',
  'InControl',
  'DarkTonic',
  'OVR',
  'SteamVR',
  'OculusPlatform',
  'Steamwork.NET',
  'Photon Unity Networking',
  'Universal Sound FX',
  'Soundrangers',
  'indiesfxcds019c',
  'Tree Pack',
  'CactusPack',
  'AxeyWorks Low Poly',
  'Quantum Theory',
  'Geometric-Landscape-Tropic-Island',
  'Standard Assets',
  'Terrain Assets',
  'Wireframed Meshes',
  'OMS_Animation',
  'ObjectMotionStudio',
  'Motion Recorder',
  'WellFired',
  'FORGE3D',
  'JumpgatesII',
  'Free_Rocks',
  'LowPolyLandscape',
  'LowPolyTreesAndBushes',
  'Network Meteroid',
  'SLK',
  'WeaponSystem',
  'WeaponTrailItems',
  'Sci-fi-Holographic-Screens',
  'VolumetricFog',
  'Skyboxes',
  'Skybox_sunny',
  'SphericalImageCam',
  'OBJExport',
]

/**
 * File-name patterns flagged by name because their provenance is known-bad regardless of what
 * extension somebody renames them to. D26 names the first three explicitly.
 */
const DENIED_NAME_PATTERNS = [
  {
    re: /^MM_/i,
    why: 'Materialized Mesh bake — a derivative work of BOUGHT geometry (audit §7, "the trap")',
  },
  { re: /materialized[ _-]?mesh/i, why: 'Materialized Mesh derivative (audit §7)' },
  { re: /pilot_scifi_rigged/i, why: 'Mixamo pilot — licensed to Matt, not redistributable (D26)' },
  { re: /soundbible/i, why: 'SoundBible library clip — third-party audio, never in git' },
  {
    re: /(?:^heightmap)|(?:world[ _-]?machine)/i,
    why: 'World Machine terrain output — bucket, not git (D26)',
  },
]

// =================================================================================================
// 4. Allowlists
//
// Every entry is a deliberate, reviewed exception. Add one only with a written reason.
// =================================================================================================

/** Exact repo-relative paths exempt from ALL rules. Mirrors the `!` lines in .gitignore. */
const PATH_ALLOW = [
  {
    glob: 'public/favicon.png',
    why: 'tiny first-party UI chrome that must ship with the source build',
  },
  // The four plots VR-PERF-TAIL.md's argument rests on. Every pixel is drawn by
  // `tools/perf/tail.py` from this repo's own `perf-out/*.trace.csv` millisecond
  // columns — no bought geometry, no Unity content, nothing extractable. See
  // ASSET-PROVENANCE.md §2.5. One line each, never the directory: the other ~30
  // plots that same run produces stay out of git.
  {
    glob: 'docs/plan/tail/int_02_hoverJet-timeline.png',
    why: 'first-party matplotlib plot of our own GPU timing column (ASSET-PROVENANCE §2.5)',
  },
  {
    glob: 'docs/plan/tail/runlengths.png',
    why: 'first-party matplotlib plot of our own GPU timing column (ASSET-PROVENANCE §2.5)',
  },
  {
    glob: 'docs/plan/tail/rookie_01_hoverJet-map.png',
    why: 'first-party matplotlib plot of our own GPU timing column (ASSET-PROVENANCE §2.5)',
  },
  {
    glob: 'docs/plan/tail/regime.png',
    why: 'first-party matplotlib plot of our own GPU timing column (ASSET-PROVENANCE §2.5)',
  },
  {
    glob: 'docs/plan/tail/arms-residual.png',
    why: 'first-party matplotlib plot of our own GPU timing column (ASSET-PROVENANCE §2.5)',
  },
  // UX-PASS-2026-10-08.md's inventory (DEV-859): screenshots of our own menus.
  // A rendered frame shows licensed geometry (trees, the hangar), and Matt ruled
  // on 2026-10-08: "screenshots are fair game for our licensed assets." A
  // screenshot is not the asset and cannot be reused as one. Scoped to this
  // folder's PNGs only.
  {
    glob: 'docs/plan/ux-pass/*.png',
    why: "screenshots of the game's own menus; Matt, 2026-10-08: screenshots are fair game for our licensed assets",
  },
  // EDITOR-UX-2026-10-08.md (DEV-878): before and after screenshots of our own
  // editor, same ruling, same scope: this folder's PNGs only.
  {
    glob: 'docs/plan/editor-ux/*.png',
    why: "screenshots of the game's own editor; Matt, 2026-10-08: screenshots are fair game for our licensed assets",
  },
]

/**
 * Globs exempt from the SIZE rule only (never from the extension/path/name rules), and still
 * capped at HARD_CEILING so an allowlist entry can never wave through something enormous.
 */
const SIZE_ALLOW = [
  {
    glob: 'src/generated/constants.generated.*',
    why: "deterministic extract of Matt's own prefab tuning; hash-pinned by `pnpm extract:check`",
  },
  {
    glob: 'content/levels/*.json',
    why: "Matt's own level design as plain numbers (audit §7 'What CAN go in a public repo')",
  },
  {
    glob: 'docs/research/_guid_index.tsv',
    why: 'GUID->path index the extractor needs. It IS a file listing of vendor pack trees (ASSET-PROVENANCE.md §4), and it stays here because this repo stays private: under D33 the public release is a fresh repo and `tools/release/copy-list.mjs` excludes this file by name. It was allowlisted PROVISIONALLY for months against a move to docs/private/ that would have broken the extractor; that promise is now discharged rather than deferred.',
  },
  {
    glob: 'docs/DEVIATIONS.md',
    max: 64 * 1024 * 1024,
    why: "first-party PROSE, and the ledger this whole rule exists to record. It crossed 2 MiB adding DEV-276, which is the backstop catching a code-health problem it was not designed for -- exactly as it did for src/boot/app.ts and tools/extract/constants.mjs, whose entries say the same thing. The LICENCE question is unambiguous: a file of English cannot contain a redistributable Unity asset, and this entry exempts it from the SIZE rule ONLY, never from the extension, path or name rules. The SIZE is real though: the ledger has outgrown one file, it grows by about a hundred lines per DEV row, and splitting it into volumes is a decision for Matt rather than a number for a hook. Matt, 2026-09-21: 'let deviations expand.' So the cap is generous rather than a deadline -- it is here to keep the file in the SIZE_ALLOW table with a written reason, not to schedule a split. Splitting remains available and remains his call.",
  },
  { glob: 'docs/**/*.md', why: 'prose; the research corpus already runs to ~176 KiB per document' },
  {
    glob: 'src/boot/app.ts',
    why: "first-party TypeScript, no vendor bytes — the app's own boot and frame loop. It crossed 256 KiB the same afternoon constants.mjs did (DEV-106's shaft walls and DEV-107's respawn fade landing together), which is the ceiling catching a code-health problem it was not designed for. The licence question is closed; the SIZE is item 10 in ASSET-PROVENANCE.md §6, and this file wants splitting more than the extractor does because it is read far more often.",
  },
  {
    glob: 'src/boot/app/world/build.ts',
    why: "first-party TypeScript, no vendor bytes: `buildWorld`, moved verbatim out of src/boot/app.ts by APP-SPLIT 4.7d, so these are bytes app.ts's own entry already covered. ASSET-PROVENANCE.md §6 item 10.",
  },
  {
    glob: 'src/boot/app/frame.ts',
    why: "first-party TypeScript, no vendor bytes: the frame loop, moved verbatim out of src/boot/app.ts by APP-SPLIT 4.9, so these are bytes app.ts's own entry already covered. ASSET-PROVENANCE.md §6 item 10.",
  },
  {
    glob: 'src/render/hangar.ts',
    why: "first-party TypeScript, no vendor bytes: the hangar room (its steps, tables, plates and doors). It crossed 256 KiB at 257.8 KiB adding DEV-620's CREDITS table (2026-10-04), the ceiling catching a code-health problem as it did for app.ts. The licence question is closed; the SIZE is a refactor (split the steps out as app.ts is being split), recorded beside app.ts in ASSET-PROVENANCE.md section 6.",
  },
  {
    glob: 'tools/extract/constants.mjs',
    why: 'first-party JavaScript, no vendor bytes — the Unity-reading extractor itself. It crossed 256 KiB adding the Fade_Mesh census (DEV-107) at 250 -> 266 KiB. The ceiling exists to catch ASSETS smuggled in as files; this is source, and the licensing question it asks has an unambiguous answer. Its SIZE is nonetheless a code-health problem and ASSET-PROVENANCE.md §6 item 9 says so: it wants splitting into per-section modules, which is a refactor and not a licence ruling.',
  },
  { glob: 'pnpm-lock.yaml', why: 'generated lockfile; text, diffable, load-bearing for CI' },
]

// =================================================================================================
// 5. Matching
// =================================================================================================

/** Translate a restricted glob (`*`, `?`, `**`) into an anchored RegExp. */
function globToRegExp(glob) {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i += 1
      if (glob[i + 1] === '/') {
        i += 1
        re += '(?:.*/)?'
      } else {
        re += '.*'
      }
    } else if (c === '*') {
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`${re}$`)
}

const PATH_ALLOW_RE = PATH_ALLOW.map((a) => ({ ...a, re: globToRegExp(a.glob) }))
const SIZE_ALLOW_RE = SIZE_ALLOW.map((a) => ({ ...a, re: globToRegExp(a.glob) }))

const EXT_INDEX = new Map()
for (const g of DENIED_EXTENSIONS) {
  for (const e of g.ext) EXT_INDEX.set(e, g)
}

const DIR_SEGMENT_INDEX = new Set(DENIED_DIR_SEGMENTS.map((s) => s.toLowerCase()))

/** Normalise to repo-relative, forward-slashed, no leading "./". */
function normalise(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * Apply every rule to one path.
 * @returns {Array<{ rule: string, why: string, detail: string }>}
 */
function violationsFor(file, size, maxBytes) {
  const p = normalise(file)
  const lower = p.toLowerCase()
  const base = p.slice(p.lastIndexOf('/') + 1)

  for (const a of PATH_ALLOW_RE) {
    if (a.re.test(p)) return []
  }

  const out = []

  for (const d of DENIED_PREFIXES) {
    if (lower.startsWith(d.prefix.toLowerCase())) {
      out.push({ rule: 'denied-path', why: d.why, detail: `under ${d.prefix}` })
    }
  }

  const segments = p.split('/').slice(0, -1)
  for (const seg of segments) {
    if (DIR_SEGMENT_INDEX.has(seg.toLowerCase())) {
      out.push({
        rule: 'vendor-dir',
        why: 'a vendor pack folder copied into the tree — Asset Store EULA forbids redistribution',
        detail: `path segment "${seg}"`,
      })
      break
    }
  }

  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : ''
  const extGroup = ext ? EXT_INDEX.get(ext) : undefined
  if (extGroup) {
    out.push({ rule: 'denied-ext', why: extGroup.why, detail: `${ext} (${extGroup.group})` })
  }

  for (const n of DENIED_NAME_PATTERNS) {
    if (n.re.test(base)) {
      out.push({ rule: 'denied-name', why: n.why, detail: `name matches ${n.re}` })
    }
  }

  if (typeof size === 'number') {
    const allow = SIZE_ALLOW_RE.find((a) => a.re.test(p))
    // An entry may carry its own `max`. That is ONLY for first-party PROSE or SOURCE
    // whose licence question is already closed and whose size is a code-health problem
    // instead — see the `docs/DEVIATIONS.md` entry. HARD_CEILING stays where it is for
    // everything else, because it is the backstop against a BINARY slipping through an
    // allowlist glob, and nothing here weakens the extension, path or name rules.
    const limit = allow ? (allow.max ?? HARD_CEILING) : maxBytes
    if (size > limit) {
      out.push({
        rule: 'too-big',
        why: allow
          ? `size-allowlisted (${allow.why}) but past the ${kib(allow.max ?? HARD_CEILING)} ceiling`
          : 'over the size ceiling — large files are assets until proven otherwise',
        detail: `${kib(size)} > ${kib(limit)}`,
      })
    }
  }

  return out
}

function kib(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MiB` : `${(n / 1024).toFixed(1)} KiB`
}

// =================================================================================================
// 6. Input modes
// =================================================================================================

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  })
}

/** Sizes for a list of blob shas, in ONE `git cat-file --batch-check`. */
function blobSizes(shas) {
  const wanted = [...new Set(shas.filter((s) => s && !/^0+$/.test(s)))]
  const sizes = new Map()
  if (wanted.length === 0) return sizes
  const out = git(['cat-file', '--batch-check'], { input: `${wanted.join('\n')}\n` })
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]{7,64}) (\w+) (\d+)$/)
    if (m?.[2] === 'blob') sizes.set(m[1], Number(m[3]))
  }
  return sizes
}

/**
 * Files staged for commit, with their STAGED byte size (not the worktree's).
 *
 * `--no-abbrev` is load-bearing: `git diff --raw` abbreviates object names to 7 chars by
 * default, while `git cat-file --batch-check` answers with the FULL name — so a map keyed on
 * the abbreviated id silently misses every lookup and every staged file reads as "size unknown".
 * That defeated the size rule entirely until it was caught by an end-to-end hook test.
 */
function collectStaged() {
  const raw = git(['diff', '--cached', '--raw', '-z', '--no-abbrev', '--diff-filter=ACMR'])
  const parts = raw.split('\0')
  const entries = []
  let i = 0
  while (i < parts.length) {
    const meta = parts[i]
    if (meta?.[0] !== ':') {
      i += 1
      continue
    }
    const fields = meta.slice(1).split(' ')
    const dstSha = fields[3]
    const status = fields[4] ?? ''
    // R/C emit <src>\0<dst>; everything else emits a single path.
    const pathIdx = status[0] === 'R' || status[0] === 'C' ? i + 2 : i + 1
    const file = parts[pathIdx]
    if (file) entries.push({ file, sha: dstSha })
    i = pathIdx + 1
  }
  const sizes = blobSizes(entries.map((e) => e.sha))
  // Fall back to the worktree byte count if the blob lookup ever comes back empty, so a
  // "size unknown" can never quietly become "size fine".
  return entries.map((e) => ({
    file: e.file,
    size: sizes.get(e.sha) ?? statSize(path.join(REPO, e.file)),
  }))
}

/** Every tracked file in the working tree, sized from disk. */
function collectTree() {
  const raw = git(['ls-files', '-z'])
  return raw
    .split('\0')
    .filter(Boolean)
    .map((file) => ({ file, size: statSize(path.join(REPO, file)) }))
}

/** Every blob that has ever been committed on any ref, with the path it was stored under. */
function collectHistory() {
  const raw = git(['rev-list', '--objects', '--all'])
  const entries = []
  const shas = []
  for (const line of raw.split('\n')) {
    const sp = line.indexOf(' ')
    if (sp < 0) continue
    const sha = line.slice(0, sp)
    const file = line.slice(sp + 1).trim()
    if (!file) continue
    entries.push({ file, sha })
    shas.push(sha)
  }
  const sizes = blobSizes(shas)
  // rev-list --objects lists trees too; blobSizes only knows about blobs, so trees drop out.
  return entries
    .filter((e) => sizes.has(e.sha))
    .map((e) => ({ file: e.file, size: sizes.get(e.sha) }))
}

function statSize(abs) {
  try {
    return fs.statSync(abs).size
  } catch {
    return undefined
  }
}

// =================================================================================================
// 7. CLI
// =================================================================================================

const HELP = `check-denylist.mjs — block bought (or bought-derived) content from entering git.

  --staged        files staged for commit          (used by .githooks/pre-commit)
  --tree          every tracked file               (used by CI)
  --history       every blob in every commit       (used by CI + PUBLIC-CHECKLIST.md)
  --files ...     explicit paths, sized from disk  (no git needed — used by the self-test)
  --stdin         paths from stdin, NL or NUL separated
  --max-bytes N   override the ${kib(DEFAULT_MAX_BYTES)} ceiling
  --list-rules    print the rule tables and exit
  --quiet         print nothing unless something fails

exit 0 clean · 1 violations · 2 usage/internal error
`

function main(argv) {
  let mode = null
  let quiet = false
  let maxBytes = DEFAULT_MAX_BYTES
  const explicit = []

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--staged' || a === '--tree' || a === '--history' || a === '--stdin') {
      mode = a.slice(2)
    } else if (a === '--files') {
      mode = 'files'
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) explicit.push(argv[++i])
    } else if (a === '--max-bytes') {
      maxBytes = Number(argv[++i])
      if (!Number.isFinite(maxBytes) || maxBytes <= 0) return fail('--max-bytes needs a number')
    } else if (a === '--quiet') {
      quiet = true
    } else if (a === '--list-rules') {
      listRules()
      return 0
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(HELP)
      return 0
    } else {
      return fail(`unknown argument: ${a}`)
    }
  }

  if (!mode) {
    process.stderr.write(HELP)
    return 2
  }

  /** @type {Array<{ file: string, size: number | undefined }>} */
  let items
  try {
    if (mode === 'staged') items = collectStaged()
    else if (mode === 'tree') items = collectTree()
    else if (mode === 'history') items = collectHistory()
    else if (mode === 'files') items = explicit.map((f) => ({ file: f, size: statSize(f) }))
    else {
      const raw = fs.readFileSync(0, 'utf8')
      items = raw
        .split(/[\0\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((f) => ({ file: f, size: statSize(f) }))
    }
  } catch (err) {
    return fail(`could not collect files (${mode}): ${err.message}`)
  }

  const bad = []
  for (const it of items) {
    const v = violationsFor(it.file, it.size, maxBytes)
    if (v.length > 0) bad.push({ file: normalise(it.file), size: it.size, violations: v })
  }

  if (bad.length === 0) {
    if (!quiet) {
      process.stdout.write(
        `check-denylist: OK — ${items.length} file(s) checked (${mode}), nothing denied.\n`,
      )
    }
    return 0
  }

  report(bad, mode, maxBytes)
  return 1
}

function report(bad, mode, maxBytes) {
  const w = (s) => process.stderr.write(s)
  w('\n')
  w('  ============================================================================\n')
  w('   BLOCKED — this change would put non-committable content into git history.\n')
  w('  ============================================================================\n')
  w('\n')
  w(`  mode: --${mode}   ceiling: ${kib(maxBytes)}   offending files: ${bad.length}\n\n`)
  for (const b of bad) {
    w(`  ${b.file}${typeof b.size === 'number' ? `  [${kib(b.size)}]` : ''}\n`)
    for (const v of b.violations) w(`      ${v.rule}: ${v.detail}\n          ${v.why}\n`)
    w('\n')
  }
  w('  WHY THIS RULE EXISTS\n')
  w('    The 2016 Unity project is built on ~55 Asset Store packs whose licences permit use\n')
  w('    inside a built product and forbid redistribution as extractable files. Some ship no\n')
  w("    licence at all. `MM_*` meshes are Matt's own bakes of BOUGHT geometry. Git history is\n")
  w('    forever, so this is checked BEFORE the commit, not after.\n')
  w('    Full ruling: ASSET-PROVENANCE.md · policy: DECISIONS.md D12 + D26\n\n')
  w('  WHAT TO DO INSTEAD\n')
  w('    - Compiled art/audio -> the content bucket: `pnpm assets:push` (see .env.example).\n')
  w('    - Extractor scratch  -> leave it in tools/prototype/out/ (already gitignored).\n')
  w('    - Big generated text -> add a SIZE_ALLOW entry in .githooks/check-denylist.mjs WITH A\n')
  w('      REASON, and record the ruling in ASSET-PROVENANCE.md.\n')
  w('    - Unstage what you did not mean to add:  git restore --staged <file>\n\n')
  w('  ESCAPE HATCH (you are asserting the licence is clear, and CI still gets a vote)\n')
  w('    FF2_ALLOW_ASSETS=1 git commit ...      run the check, print it, commit anyway\n')
  w('    git commit --no-verify                 skip the hook entirely\n')
  w('    Both are logged nowhere. The CI job re-runs this over the whole tree.\n\n')
}

function listRules() {
  const w = (s) => process.stdout.write(s)
  w(
    `size ceiling: ${kib(DEFAULT_MAX_BYTES)} (allowlisted paths capped at ${kib(HARD_CEILING)})\n\n`,
  )
  w('denied extensions\n')
  for (const g of DENIED_EXTENSIONS) w(`  ${g.group.padEnd(22)} ${g.ext.join(' ')}\n`)
  w('\ndenied path prefixes\n')
  for (const d of DENIED_PREFIXES) w(`  ${d.prefix}\n`)
  w('\ndenied vendor directory segments\n')
  w(`  ${DENIED_DIR_SEGMENTS.join(', ')}\n`)
  w('\ndenied name patterns\n')
  for (const n of DENIED_NAME_PATTERNS) w(`  ${n.re}\n`)
  w('\nall-rule allowlist\n')
  for (const a of PATH_ALLOW) w(`  ${a.glob}  — ${a.why}\n`)
  w('\nsize-rule allowlist\n')
  for (const a of SIZE_ALLOW) w(`  ${a.glob}  — ${a.why}\n`)
}

function fail(msg) {
  process.stderr.write(`check-denylist: ${msg}\n`)
  return 2
}

process.exit(main(process.argv))
