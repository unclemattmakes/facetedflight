#!/usr/bin/env node

// tools/extract/palette.mjs — the terrain colour map, small enough for a table.
//
//   node tools/extract/palette.mjs            write content/palettes/<env>.json
//   node tools/extract/palette.mjs --check    exit 3 if the emitted bytes would differ
//
// ── Why this exists (DEV-140) ─────────────────────────────────────────────
//
// Matt, 2026-09-16: *"holo tables should be using the terrain's colors."*
//
// The world's colour is a per-face sample of 2016's colour MAP (`faceted.ts`:
// `colorMap.sample(u, v)` at each triangle's barycentre), and the level select
// draws four islands at 56 cells across. `game/mission-shape.ts` refuses to
// fetch those maps for the menu and says why: 0.8–6.8 MB apiece, 12.4 MB for
// the four, to colour 0.5 m models. This tool reads the SAME maps the world
// reads — the published PNGs under `public/assets/terrain/`, hash-verified by
// `pnpm assets:check` — and writes a 64 x 64 box-filtered thumbnail of each
// as text: 12 KB of base64 per environment, in git, no fetch.
//
// 64 because the diorama is 56 cells across (`render/diorama.ts` GRID) and a
// cell of the model should not straddle two texels of its palette. A box
// filter over the full-resolution map, in sRGB byte space, because the world
// treats those bytes as linear albedo unconverted (DEV-014) and the model
// should be the mean of the faces it stands for, not one face picked out of
// seventy.
//
// The output records the SOURCE: the published path and the sha256 of the
// bytes it was cut from, so `--check` can verify a committed palette against
// the asset manifest even on a machine that has no PNGs at all (CI) — the same
// posture `constants.mjs --check` takes toward the Unity project.
//
// Sampling convention: `(u, v)` as `MapSampler.sample` takes them, with the
// same `importUnityTexture` nPOT rescale applied first, so a palette texel at
// (u, v) is the mean of the imported texture's texels in that cell — the ones
// the generator would have sampled inside it.
//
// The rescale IS `importUnityTextureImage` from `src/sim/terrain/image-sampler.ts`,
// loaded through Vite (TL-11, DEV-710), not a copy of it. The copy this file used
// to carry (an inline `npotNearest` and bilinear resample) skipped one thing the
// game does: it rounds every resampled texel to a BYTE, because the imported
// texture is an 8-bit image. The palette box-filtered the unrounded values, so it
// was cut from a slightly different image than the one the game samples. On the
// 1025 and 2161 maps that moved 46 to 219 of each palette's 12,288 bytes, each by
// exactly one level.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeSsr, ssrImport } from '../lib/ssr.mjs'
import { decodePng } from '../terrain/png.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..', '..')
const OUT_DIR = path.join(ROOT, 'content', 'palettes')
const MANIFEST = path.join(ROOT, 'tools', 'assets', 'required-assets.json')
const SIZE = 64

const opt = { check: false }
for (const a of process.argv.slice(2)) {
  if (a === '--check') opt.check = true
  else if (a === '--help' || a === '-h') {
    process.stdout.write(
      'usage: node tools/extract/palette.mjs [--check]\n  --check   do not write; exit 3 if the emitted bytes would differ\n',
    )
    process.exit(0)
  } else {
    process.stderr.write(`palette.mjs: unknown argument ${a}\n`)
    process.exit(2)
  }
}

/** The four LAND colour maps, by environment key, off the asset manifest. */
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
const colourAssets = manifest.assets.filter((a) => /^terrain\.[a-z]+\.color$/.test(a.id))
if (colourAssets.length === 0) {
  process.stderr.write('palette.mjs: no terrain.<env>.color assets in the manifest\n')
  process.exit(2)
}

/** `importUnityTextureImage` from the game's own sampler module, loaded once, only when a PNG is on disk. */
let importer = null
const loadImporter = async () => {
  importer ??= (await ssrImport('/src/sim/terrain/image-sampler.ts')).importUnityTextureImage
  return importer
}

/**
 * Box-filter an 8-bit image to SIZE x SIZE after Unity's import rescale.
 *
 * The rescale is the game's own (`importUnityTextureImage`: bilinear to the
 * nearest power of two, every texel rounded to a byte); then each palette texel
 * is the mean of the imported texels whose centres fall in its cell. Both steps
 * are plain arithmetic on bytes so the output is the same on every machine,
 * which is what makes `--check` mean something.
 */
const thumbnail = (img, importUnityTextureImage) => {
  const { width, height, channels, data } = importUnityTextureImage(
    { width: img.width, height: img.height, channels: img.channels, data: img.data },
    'toNearest',
  )
  const out = new Uint8Array(SIZE * SIZE * 3)
  const cellW = width / SIZE
  const cellH = height / SIZE
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const sum = [0, 0, 0]
      let n = 0
      for (let y = Math.floor(py * cellH); y < Math.floor((py + 1) * cellH); y++) {
        for (let x = Math.floor(px * cellW); x < Math.floor((px + 1) * cellW); x++) {
          for (let c = 0; c < 3; c++)
            sum[c] += data[(y * width + x) * channels + Math.min(c, channels - 1)]
          n++
        }
      }
      const o = (py * SIZE + px) * 3
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(sum[c] / n)
    }
  }
  return out
}

/** Stable JSON: fixed key order, two-space indent, trailing newline. */
const emit = (env, asset, sha, rgb) => {
  const doc = {
    $comment:
      'GENERATED by tools/extract/palette.mjs — do not edit. A 64x64 box-filtered thumbnail of the environment colour map the terrain generator samples (DEV-140). `pnpm extract:palettes` rebuilds; `--check` verifies.',
    environment: env,
    source: { id: asset.id, path: asset.path, sha256: sha },
    width: SIZE,
    height: SIZE,
    channels: 3,
    filter:
      'nPOT rescale to nearest power of two (bilinear, each texel rounded to a byte as the game importer does), then box mean per cell, sRGB bytes',
    rgb: Buffer.from(rgb).toString('base64'),
  }
  return `${JSON.stringify(doc, null, 2)}\n`
}

const results = []
let differs = 0
let verifiedOnly = 0
for (const asset of colourAssets) {
  const env = asset.id.split('.')[1]
  const outPath = path.join(OUT_DIR, `${env}.json`)
  const pngPath = path.join(ROOT, 'public', asset.path)
  if (!fs.existsSync(pngPath)) {
    // No PNG on this machine: verify the committed palette's provenance instead.
    if (!fs.existsSync(outPath)) {
      process.stderr.write(`palette.mjs: ${env}: no PNG at ${pngPath} and no committed palette\n`)
      process.exit(opt.check ? 3 : 2)
    }
    const committed = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    if (committed.source.sha256 !== asset.sha256 || committed.source.path !== asset.path) {
      process.stderr.write(
        `palette.mjs: ${env}: committed palette was cut from ${committed.source.path} ${committed.source.sha256}, manifest says ${asset.path} ${asset.sha256}\n`,
      )
      differs++
    }
    verifiedOnly++
    continue
  }
  const bytes = fs.readFileSync(pngPath)
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (sha !== asset.sha256) {
    process.stderr.write(
      `palette.mjs: ${env}: ${asset.path} on disk hashes ${sha}, manifest says ${asset.sha256} — run pnpm assets:check\n`,
    )
    process.exit(2)
  }
  const img = decodePng(pngPath)
  const text = emit(env, asset, sha, thumbnail(img, await loadImporter()))
  const prev = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null
  if (prev !== text) differs++
  results.push({
    env,
    outPath,
    text,
    changed: prev !== text,
    source: `${img.width}x${img.height}x${img.channels}`,
  })
}

await closeSsr()

if (opt.check) {
  if (differs > 0) {
    process.stderr.write(
      `palette.mjs --check: ${differs} palette(s) would change. Run pnpm extract:palettes.\n`,
    )
    process.exit(3)
  }
  process.stdout.write(
    `palette.mjs --check: ${results.length} verified against the PNGs, ${verifiedOnly} against the manifest only.\n`,
  )
  process.exit(0)
}

fs.mkdirSync(OUT_DIR, { recursive: true })
for (const r of results) {
  fs.writeFileSync(r.outPath, r.text)
  process.stdout.write(
    `palette.mjs: ${r.env} <- ${r.source} ${r.changed ? '(changed)' : '(same)'}\n`,
  )
}
if (verifiedOnly > 0)
  process.stdout.write(`palette.mjs: ${verifiedOnly} left as committed (no PNG here)\n`)
