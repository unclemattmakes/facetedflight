#!/usr/bin/env node
// tools/assets/build-content-pack.mjs: build the redistributable content pack.
//
//   pnpm content:pack                  # public/assets -> content-pack/facetedflight-content-<version>.zip
//   node tools/assets/build-content-pack.mjs --out <dir> --assets <dir>
//
// Only rows of tools/assets/required-assets.json whose `share` names a licence
// go in. Each file is read from the content tree (default `public/`), checked
// against its recorded sha256, and refused if it differs: a pack is built from
// verified bytes or not at all. The output folder is gitignored. This tool
// never uploads anything; attaching the zip to a GitHub Release is a person's
// decision.
//
// Zip layout:
//   assets/**                paths exactly as the content bucket lays them out
//   CONTENT-MANIFEST.json    per file: path, bytes, sha256, licence, author, title, source, modified
//   LICENSES/<SPDX>.txt      one per licence used
//   README.txt               what this is, the attribution line, the branding carve-out

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  LICENCE_TEXT_DIR,
  loadAssetManifest,
  packFileName,
  packVersion,
  REPO_ROOT,
  SHARE_LICENCES,
  safePackPath,
  sha256Hex,
  sharedAssets,
  shareProblems,
  writeZip,
} from './content-pack-lib.mjs'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--') && !['--out', '--assets'].includes(a)) {
    console.error(`content:pack: unknown argument ${a}`)
    console.error('usage: build-content-pack.mjs [--out <dir>] [--assets <dir>]')
    process.exit(2)
  }
}

const ASSET_DIR = resolve(arg('--assets') ?? process.env.ASSET_DIR ?? join(REPO_ROOT, 'public'))
const OUT_DIR = resolve(arg('--out') ?? join(REPO_ROOT, 'content-pack'))

const humanize = (p) =>
  basename(p)
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')

/** A one-line PUBLIC description: never a Unity path or a guid. */
function describe(a) {
  if (a.share === 'CC0-1.0') {
    const title = /"([^"]+)"/.exec(a.source ?? '')?.[1] ?? humanize(a.path)
    return {
      title,
      source:
        'HoliznaCC0, Retro Wave collection (https://opengameart.org/content/retro-wave-collection), transcoded to Opus',
    }
  }
  if (a.share === 'CC-BY-SA-4.0') {
    return {
      title: a.path.endsWith('.txt') ? 'CRYSTAL Regular licence notice' : 'CRYSTAL Regular',
      source: 'CRYSTAL typeface by Felipe Munoz, served unmodified',
    }
  }
  return {
    title: humanize(a.path),
    source: 'First-party asset of Faceted Flight, converted for the web',
  }
}

const manifest = loadAssetManifest()
const problems = shareProblems(manifest.assets)
const shared = sharedAssets(manifest.assets).sort((a, b) => (a.path < b.path ? -1 : 1))
if (shared.length === 0) problems.push('no asset carries a share licence; nothing to pack')

const files = []
for (const a of shared) {
  if (!safePackPath(a.path)) {
    problems.push(`${a.id}: unsafe path ${a.path}`)
    continue
  }
  const full = join(ASSET_DIR, a.path)
  if (!existsSync(full) || !statSync(full).isFile()) {
    problems.push(`${a.id}: missing on disk: ${full} (run pnpm assets:pull)`)
    continue
  }
  const data = readFileSync(full)
  const sha = sha256Hex(data)
  if (sha !== a.sha256) {
    problems.push(`${a.id}: sha256 on disk ${sha} differs from the manifest's ${a.sha256}`)
    continue
  }
  if (typeof a.bytes === 'number' && a.bytes !== data.length)
    problems.push(`${a.id}: ${data.length} bytes on disk, manifest says ${a.bytes}`)
  const { title, source } = describe(a)
  files.push({
    path: a.path,
    bytes: data.length,
    sha256: sha,
    licence: a.share,
    author: a.shareAuthor,
    title,
    source,
    modified: a.shareModified === true,
    data,
  })
}

const licencesUsed = [...new Set(files.map((f) => f.licence))].sort()
const licenceEntries = []
for (const id of licencesUsed) {
  const p = join(LICENCE_TEXT_DIR, `${id}.txt`)
  if (!existsSync(p)) {
    problems.push(`licence text missing: ${p}`)
    continue
  }
  licenceEntries.push({ name: `LICENSES/${id}.txt`, data: readFileSync(p) })
}

if (problems.length > 0) {
  console.error('content:pack: refusing to build.')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

const version = packVersion()
const contentManifest = {
  pack: 'facetedflight-content',
  version,
  files: files.map(({ data: _data, ...row }) => row),
}
const manifestBuf = Buffer.from(`${JSON.stringify(contentManifest, null, 2)}\n`)

const readme = `Faceted Flight: 10th Anniversary Edition, content pack ${version}

This is the redistributable part of the game's content: first-party models,
terrain maps and textures, CC0 music, and one CC BY-SA font. Unpack it into
public/ (pnpm content:pull does that and checks every file) and serve the game
with VITE_ASSET_BASE_URL=/.

Attribution line for the first-party files:
  Faceted Flight by Uncle Matt Makes, facetedflight.net, CC BY-NC 4.0.
The name and branding "Faceted Flight" are not licensed by this pack: use the
files unmodified in this game, or credit as above when you remix them.

CONTENT-MANIFEST.json lists every file with its sha256, licence, author and
title. LICENSES/ holds the licence for each class of file:
${licencesUsed.map((id) => `  ${id}: ${SHARE_LICENCES[id].name}`).join('\n')}

Not in this pack, on purpose: the Asset Store props and hangar pieces the live
game uses. A clone runs without them; those pieces are simply absent.
`

const entries = [
  ...files.map((f) => ({ name: f.path, data: f.data })),
  { name: 'CONTENT-MANIFEST.json', data: manifestBuf },
  ...licenceEntries,
  { name: 'README.txt', data: Buffer.from(readme) },
]
const zip = writeZip(entries)

mkdirSync(OUT_DIR, { recursive: true })
const zipPath = join(OUT_DIR, packFileName(version))
writeFileSync(zipPath, zip)
writeFileSync(join(OUT_DIR, `facetedflight-content-${version}.manifest.json`), manifestBuf)
writeFileSync(
  join(OUT_DIR, `facetedflight-content-${version}.zip.sha256`),
  `${sha256Hex(zip)}  ${packFileName(version)}\n`,
)

const byClass = {}
for (const f of files) byClass[f.licence] = (byClass[f.licence] ?? 0) + 1
const total = files.reduce((n, f) => n + f.bytes, 0)
console.log(`content:pack: ${files.length} files, ${total} bytes raw, ${zip.length} bytes zipped`)
console.log(`  per licence: ${JSON.stringify(byClass)}`)
console.log(`  ${zipPath}`)
console.log(`  zip sha256 ${sha256Hex(zip)}`)
console.log('  nothing was uploaded; attach the zip to a release by hand')
