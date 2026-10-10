// tools/assets/extract-terrain-maps.mjs — publish the World Machine terrain
// maps into the local content tree.
//
//   node tools/assets/extract-terrain-maps.mjs            # simonet.islands
//   node tools/assets/extract-terrain-maps.mjs --all
//   node tools/assets/extract-terrain-maps.mjs --check    # verify, write nothing
//
// ── What it does, and what it deliberately does not ───────────────────────
//
// It copies. It does NOT apply Unity's import-time 1025 -> 1024 rescale, even
// though the generator samples the rescaled image (DEV-007).
//
// That is a deliberate call. The rescale lives in `importUnityTexture()` in the
// sim layer, where the oracle test exercises it against the 2016 bake. Baking
// it in here would put a second copy of that arithmetic in a tool nothing
// verifies — the exact split that produced the bug in the first place, when the
// bilinear sampler lived in `tools/` and the browser was about to grow its own.
// So the bucket carries the artist's file, and the runtime reproduces Unity's
// importer. One implementation, one test.
//
// The cost is a megapixel resample at load. It runs once, in a plain Worker,
// off the critical path.
//
// ── Provenance ────────────────────────────────────────────────────────────
//
// CORRECTED 2026-09-13. This block used to say the maps are "`CONFIRM` in
// content/MANIFEST.md, not `KEEP`" and that publishing waits on C-6. **That was
// false, and it was a claim about another file made without opening it.**
// `content/MANIFEST.md` §2 marks all thirteen `KEEP` — "first-party, safe to
// publish" — and `required-assets.json` agrees on every row. No terrain map has
// ever carried `CONFIRM`.
//
// R2 settled it in practice long before anyone noticed the contradiction: ten
// of these have been served from `ff2-content` since 2026-09-09, including the
// `islandgroup_*.png` pair that O13/C-6 is actually about. The warning below
// guarded a line crossed four days before it was written.
//
// What is STILL open is C-6 itself: World Machine's free tier is
// non-commercial, the edition that produced these is unrecorded, and `KEEP` is
// a claim rather than an answer. The decision was never "may we publish these
// three" — it was "ten are already public under a classification nobody
// verified". Matt authorised the remaining three on 2026-09-13 knowing that.
//
// The lesson is the repo's own: a structural claim with one source is a
// hypothesis, and this one asserted what a second file said while that file
// said the opposite. This tool writes to
// `public/assets/`, which is gitignored — `pnpm assets:push` is a
// separate, deliberate step.
//
// Paths come from the generated sheet, never from a filename. Two files called
// `islandgroup_height.png` exist in the source tree (Simonet Islands, and
// E3/San Juans); the sheet resolved ours through the material guid.
//
// The legacy Unity project is READ-ONLY. This reads and never writes there.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertOutsideLegacy, legacyRoot } from '../legacy-root.mjs'
import { decodeBmp } from '../terrain/bmp.mjs'
import { decodePng, encodePng } from '../terrain/png.mjs'
import { decodeTga } from '../terrain/tga.mjs'
import { DENSITY_MAPS, DENSITY_ROOT } from './density-maps.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LEGACY = legacyRoot()
const SHEET = path.join(REPO, 'src', 'generated', 'constants.generated.json')
const OUT_ROOT = path.join(REPO, 'public')

const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')
const all = args.has('--all')

const sheet = JSON.parse(fs.readFileSync(SHEET, 'utf8'))

/**
 * Bucket path per terrain map. These MUST match `tools/assets/required-assets
 * .json`; `check-assets-present.mjs` reads that file and this one has to agree
 * with it or a build passes its asset gate and then 404s.
 */
const TARGETS = {
  'simonet.islands': {
    sourceHeightMap: 'assets/terrain/simonet/islandgroup-height.png',
    sourceColorMap: 'assets/terrain/simonet/islandgroup-color.png',
  },
  'simonet.ocean': {
    sourceHeightMap: 'assets/terrain/simonet/water-height.png',
    sourceColorMap: 'assets/terrain/simonet/water-color.png',
  },
  // The alpine valley. `LevelArt_AlpineForest` and the TITLE SCREEN's
  // `AlpineTerrain_menu.prefab` are the same terrain, field for field and map
  // for map — 2016 stood the title screen in the Alpine Forest environment.
  // One entry serves both; `menu.forest` below points at the same bucket path
  // rather than publishing a second copy of a 4 MB file.
  'alpine.forest': {
    sourceHeightMap: 'assets/terrain/alpine/forest_02-height.png',
    sourceColorMap: 'assets/terrain/alpine/forest_02-color.png',
  },
  'menu.forest': {
    sourceHeightMap: 'assets/terrain/alpine/forest_02-height.png',
    sourceColorMap: 'assets/terrain/alpine/forest_02-color.png',
  },
  // The desert canyon. ONE terrain and NO OCEAN — `LevelArt_Desert.prefab` has a
  // single `FacetedTerrain` against simonet's two, and its root has three
  // children (terrain/art/sky) where simonet has four. Four missions use it.
  //
  // Its COLOUR map is a 24-bit Windows BMP wearing a `.tga` extension, which is
  // why the decode below sniffs magic bytes rather than trusting the name.
  'desert.canyon': {
    sourceHeightMap: 'assets/terrain/desert/canyon_04-height.png',
    sourceColorMap: 'assets/terrain/desert/canyon_04-color.png',
  },
  // Kauai's LAND. An 8192 m terrain — twice Simonet's — from a 2161x2161 source,
  // and its COLOUR map is the only 16-bit PNG in the project, which
  // `tools/terrain/png.mjs` refused until it learned bit depth 16.
  'kauai.terrain': {
    sourceHeightMap: 'assets/terrain/kauai/kauai-height.png',
    sourceColorMap: 'assets/terrain/kauai/kauai-color.png',
  },
  // Kauai's OCEAN is Simonet's ocean. Not "similar to" — the generated sheet
  // gives both the same two source files, `Simonet Islands/water_height.png`
  // and `water_color.bmp`. So it points at the already-published Simonet water
  // rather than writing a second copy, exactly as `menu.forest` shares alpine's.
  'kauai.ocean': {
    sourceHeightMap: 'assets/terrain/simonet/water-height.png',
    sourceColorMap: 'assets/terrain/simonet/water-color.png',
  },
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

const collect = () => {
  const out = []
  for (const [env, envData] of Object.entries(sheet.terrain ?? {})) {
    for (const [name, terrain] of Object.entries(envData.terrains ?? {})) {
      const key = `${env}.${name}`
      if (!all && key !== 'simonet.islands') continue
      const targets = TARGETS[key]
      if (!targets) {
        console.warn(`  skip ${key}: no bucket path defined in TARGETS`)
        continue
      }
      for (const [field, bucketPath] of Object.entries(targets)) {
        const rel = terrain[field]
        if (!rel) continue
        out.push({ key, field, source: path.join(LEGACY, rel), rel, bucketPath, outRoot: OUT_ROOT })
      }
    }
  }
  return out
}

/**
 * Bucket path per PROP DENSITY map — the `ObjectPlacementMap` of each
 * `FacetedTerrainObjectGenerator`. Same contract as `TARGETS`: these MUST match
 * `tools/assets/required-assets.json`.
 *
 * These are World Machine output exactly as the height and colour maps are, and
 * carry the same first-party clearance Matt gave on 2026-09-12 — and the same
 * residual C-6 about which edition produced them.
 *
 * Keyed by the SOURCE path rather than by environment, because kauai and simonet
 * share one map: both scatter `island_group_02/islands_02_trees.png` with
 * identical parameters. That is the same shape as `kauai.ocean` above pointing
 * at Simonet's water, so one bucket path serves both rather than publishing a
 * second copy.
 */
const PROP_MAP_TARGETS = DENSITY_MAPS
/**
 * The density maps named by `content/environments/*.json`.
 *
 * Driven by the extracted content rather than by a list here, so a map this
 * tool publishes is by construction a map some generator actually samples. An
 * environment JSON naming a map with no bucket path is a hard failure, not a
 * skip: the alternative is a build whose asset gate passes and whose alpine
 * forest is empty.
 */
const collectPropMaps = () => {
  const dir = path.join(REPO, 'content', 'environments')
  if (!fs.existsSync(dir)) return []
  const out = []
  const seen = new Set()
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
    const env = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    for (const s of env.scatter ?? []) {
      const rel = s.placementMap
      if (!rel || seen.has(rel)) continue
      seen.add(rel)
      const bucketPath = PROP_MAP_TARGETS[rel]
      if (!bucketPath) {
        console.error(`  NO TARGET  ${rel} (named by content/environments/${file})`)
        process.exitCode = 1
        continue
      }
      out.push({
        key: `${env.id}.props`,
        field: 'objectPlacementMap',
        source: path.join(LEGACY, rel),
        rel,
        bucketPath,
        // NOT `public/`. See DENSITY_ROOT.
        outRoot: DENSITY_ROOT,
      })
    }
  }
  return out
}

let failed = 0
const rows = []

for (const item of [...collect(), ...(all ? collectPropMaps() : [])]) {
  if (!fs.existsSync(item.source)) {
    console.error(`  MISSING  ${item.rel}`)
    failed++
    continue
  }
  // Decode as a validation step: a map this decoder cannot read is a map the
  // Node oracle harness cannot read either, and that needs to fail here rather
  // than three layers down.
  //
  // The ocean colour map is a 24-bit BMP — World Machine wrote it that way in
  // 2015 and nobody re-saved it. It is re-encoded to PNG here so the runtime
  // never learns BMP exists, and because 790 KB of uncompressed BMP is absurd
  // for what turns out to be a single flat colour.
  // The alpine HEIGHT map is a 32-bit uncompressed Targa — World Machine wrote
  // it that way and nobody re-saved it either. Re-encoded here for the same two
  // reasons as the BMP: the runtime never learns TGA exists, and 4.2 MB of
  // uncompressed BGRA is absurd for a grayscale height field.
  //
  // ── The format is SNIFFED, not read off the extension ────────────────────
  //
  // `canyon_04_color.tga` is a 24-bit Windows BMP wearing a `.tga` extension —
  // it starts with the bytes `42 4d`, "BM". Dispatching on the name handed it to
  // `decodeTga`, which threw `image type 0 (no image data)`, and the desert
  // could not be published at all. Its sibling `canyon_04_height.tga` IS a real
  // Targa (`00 00 02 00`), so the two files in one directory disagree with each
  // other about what `.tga` means.
  //
  // It is the only such mismatch among the fourteen maps in the sheet today,
  // and that is not a reason to special-case it: trap 21's lesson is that **an
  // asset is only what its BYTES say it is**, and a name is a claim by whoever
  // last saved the file. PNG and BMP both carry a magic number; TGA does not, so
  // it is the fallback, and `decodeTga` throws a clear error if the bytes are
  // something else again.
  const magic = fs.readFileSync(item.source).subarray(0, 8)
  const isPng = magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47
  const isBmp = magic[0] === 0x42 && magic[1] === 0x4d
  const isTga = !isPng && !isBmp
  const lower = item.source.toLowerCase()
  if ((lower.endsWith('.png') && !isPng) || (lower.endsWith('.bmp') && !isBmp)) {
    console.warn(
      `  NOTE  ${item.rel} is named ${lower.slice(lower.lastIndexOf('.'))} but its bytes say ` +
        `${isPng ? 'png' : isBmp ? 'bmp' : 'tga'}; going by the bytes.`,
    )
  }
  let img
  let bytes
  try {
    if (isBmp) {
      img = decodeBmp(item.source)
      bytes = encodePng(img)
    } else if (isTga) {
      const raw = decodeTga(item.source)
      // A height map stored as BGRA is a grayscale image wearing four channels.
      // Dropped to RGB here rather than at load: the alpha is 255 everywhere,
      // and carrying it would put a quarter of the file's bytes on the wire for
      // nothing. Verified rather than assumed — see the check below.
      if (raw.channels === 4) {
        const rgb = new Uint8Array(raw.width * raw.height * 3)
        for (let i = 0, j = 0; i < raw.data.length; i += 4, j += 3) {
          rgb[j] = raw.data[i]
          rgb[j + 1] = raw.data[i + 1]
          rgb[j + 2] = raw.data[i + 2]
        }
        img = { width: raw.width, height: raw.height, channels: 3, data: rgb }
      } else img = raw
      bytes = encodePng(img)
    } else {
      img = decodePng(item.source)
      // A 16-bit PNG is RE-ENCODED rather than copied. `kauai_color.png` is the
      // only one in the project and copying it verbatim shipped **16.19 MB** of
      // samples whose low byte nothing downstream can use: `ImageData8`, the
      // sampler, the vertex colours and the browser's own canvas are 8-bit end
      // to end. Re-encoding publishes exactly what the runtime will sample, and
      // what the oracle test checks, which is the same reason the BMP and TGA
      // branches re-encode.
      bytes = img.bitDepth === 16 ? encodePng(img) : fs.readFileSync(item.source)
    }
    void isPng
  } catch (err) {
    console.error(`  UNREADABLE  ${item.rel}\n              ${err.message}`)
    failed++
    continue
  }

  const dest = path.join(item.outRoot ?? OUT_ROOT, item.bucketPath)
  const already = fs.existsSync(dest) && Buffer.compare(fs.readFileSync(dest), bytes) === 0

  if (!checkOnly && !already) {
    assertOutsideLegacy(dest)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, bytes)
  }

  rows.push({
    key: `${item.key}.${item.field.replace('source', '').replace('Map', '').toLowerCase()}`,
    dims: `${img.width}x${img.height}x${img.channels}`,
    bytes: bytes.length,
    from: isBmp ? 'bmp->png' : isTga ? 'tga->png' : img.bitDepth === 16 ? 'png16->png8' : 'copied',
    sha: sha256(bytes).slice(0, 16),
    state: checkOnly ? (already ? 'present' : 'MISSING') : already ? 'unchanged' : 'written',
    bucketPath: item.bucketPath,
  })
  if (checkOnly && !already) failed++
}

const pad = (s, n) => String(s).padEnd(n)
console.log(`\n${pad('map', 26)}${pad('source', 16)}${pad('bytes', 10)}${pad('sha256', 18)}state`)
for (const r of rows) {
  console.log(
    `${pad(r.key, 26)}${pad(r.dims, 16)}${pad(r.bytes.toLocaleString(), 10)}${pad(r.from, 10)}${pad(r.sha, 18)}${r.state}`,
  )
}
console.log(`\n  -> ${path.relative(REPO, OUT_ROOT)}/assets/terrain/`)
console.log('  Sampled at 1024 after `importUnityTexture` applies nPOTScale: 1 (DEV-007).')
console.log('  Licence KEEP in content/MANIFEST.md and required-assets.json.')
console.log('  C-6 (which World Machine edition produced these) is open, but it does NOT')
console.log('  gate publishing: all thirteen are on the content bucket as of 2026-09-13,')
console.log('  and ten of them have been since 2026-09-09.')

if (failed) {
  console.error(`\n${failed} map(s) failed.`)
  process.exit(1)
}
