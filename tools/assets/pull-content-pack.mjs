#!/usr/bin/env node
// tools/assets/pull-content-pack.mjs: fetch the content pack and unpack it.
//
//   pnpm content:pull                       # the pack for package.json's version, from GitHub Releases
//   pnpm content:pull -- --from <zip>       # a local zip (a pack you built, or downloaded by hand)
//   pnpm content:pull -- --url <url>        # another URL
//   pnpm content:pull -- --dest <dir>       # unpack under <dir> instead of public/
//   FF2_CONTENT_PACK_URL=<url> pnpm content:pull
//
// The default URL is a GitHub Release asset of the public repository, named for
// the version in package.json. If the release does not exist (the repository is
// new, or the version was never released) this says so and exits 1; nothing is
// written. Every file is verified against the pack's CONTENT-MANIFEST.json (and
// against tools/assets/required-assets.json when the row is there) BEFORE any
// file is written, so a bad pack leaves the tree untouched.
//
// Afterwards: `pnpm assets:check -- --pack` verifies the unpacked tree, and
// `pnpm dev` with VITE_ASSET_BASE_URL=/ serves it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  loadAssetManifest,
  packFileName,
  packVersion,
  REPO_ROOT,
  readZip,
  SHARE_LICENCES,
  safePackPath,
  sha256Hex,
} from './content-pack-lib.mjs'

/** Where releases of the public repository live. Override with --url or FF2_CONTENT_PACK_URL. */
export const RELEASE_BASE_URL = 'https://github.com/unclemattmakes/facetedflight/releases/download'

const MAX_PACK_BYTES = 512 * 1024 * 1024

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--') && a !== '--' && !['--from', '--url', '--dest'].includes(a)) {
    console.error(`content:pull: unknown argument ${a}`)
    console.error('usage: pull-content-pack.mjs [--from <zip> | --url <url>] [--dest <dir>]')
    process.exit(2)
  }
}

const version = packVersion()
const dest = resolve(arg('--dest') ?? join(REPO_ROOT, 'public'))
const from = arg('--from')
const url =
  arg('--url') ??
  process.env.FF2_CONTENT_PACK_URL ??
  `${RELEASE_BASE_URL}/v${version}/${packFileName(version)}`

/** Thrown, never process.exit: exiting with a fetch socket open crashes libuv on Windows. */
class Fail extends Error {}
function fail(msg) {
  throw new Fail(msg)
}

async function obtain() {
  if (from) {
    if (!existsSync(from)) fail(`no such file: ${from}`)
    return readFileSync(from)
  }
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url))
    fail(`refusing a non-https pack URL: ${url}`)
  let res
  try {
    res = await fetch(url, { redirect: 'follow' })
  } catch (err) {
    fail(
      `could not reach ${url}\n  ${err.message}\n  Offline? Build a pack with pnpm content:pack and use --from <zip>.`,
    )
  }
  if (res.status === 404) {
    fail(
      `no content pack at ${url}\n` +
        `  The release for v${version} does not exist (yet). The public repository may not be\n` +
        `  published, or this version was never released. Options: set FF2_CONTENT_PACK_URL or\n` +
        `  --url to a pack you can reach, or --from <zip> for a local one.`,
    )
  }
  if (!res.ok) fail(`${url} answered ${res.status} ${res.statusText}`)
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_PACK_BYTES) fail(`pack is ${len} bytes, over the ${MAX_PACK_BYTES} byte cap`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_PACK_BYTES) fail(`pack is over the ${MAX_PACK_BYTES} byte cap`)
  return buf
}

async function main() {
  const zipBuf = await obtain()
  let entries
  try {
    entries = readZip(zipBuf)
  } catch (err) {
    fail(`the pack is not a readable zip: ${err.message}`)
  }

  const manifestBuf = entries.get('CONTENT-MANIFEST.json')
  if (!manifestBuf) fail('the pack has no CONTENT-MANIFEST.json')
  let packManifest
  try {
    packManifest = JSON.parse(manifestBuf.toString('utf8'))
  } catch {
    fail('CONTENT-MANIFEST.json is not valid JSON')
  }
  if (packManifest.pack !== 'facetedflight-content' || !Array.isArray(packManifest.files))
    fail('CONTENT-MANIFEST.json is not a facetedflight content pack manifest')
  if (
    !from &&
    !arg('--url') &&
    !process.env.FF2_CONTENT_PACK_URL &&
    packManifest.version !== version
  )
    fail(`the pack is version ${packManifest.version} but package.json is ${version}`)

  const local = new Map(loadAssetManifest().assets.map((a) => [a.path, a]))
  const problems = []
  const listed = new Set()
  for (const f of packManifest.files) {
    if (!safePackPath(f.path) || !f.path.startsWith('assets/')) {
      problems.push(`unsafe or out-of-tree path in the manifest: ${JSON.stringify(f.path)}`)
      continue
    }
    if (!Object.hasOwn(SHARE_LICENCES, f.licence)) {
      problems.push(`${f.path}: licence ${JSON.stringify(f.licence)} is not a shareable licence`)
      continue
    }
    listed.add(f.path)
    const data = entries.get(f.path)
    if (!data) {
      problems.push(`${f.path}: listed in the manifest but not in the zip`)
      continue
    }
    const sha = sha256Hex(data)
    if (sha !== f.sha256 || data.length !== f.bytes)
      problems.push(`${f.path}: bytes do not match the pack manifest (sha256 ${sha})`)
    const row = local.get(f.path)
    if (row) {
      if (row.share === 'none') problems.push(`${f.path}: this checkout does not share that file`)
      else if (typeof row.sha256 === 'string' && row.sha256 !== sha)
        problems.push(
          `${f.path}: differs from tools/assets/required-assets.json (a pack from another build?)`,
        )
    }
  }
  for (const name of entries.keys()) {
    const extra =
      name === 'CONTENT-MANIFEST.json' ||
      name === 'README.txt' ||
      /^LICENSES\/[\w.-]+\.txt$/.test(name)
    if (!extra && !listed.has(name)) problems.push(`${name}: in the zip but not in the manifest`)
  }
  if (problems.length > 0) {
    console.error('content:pull: the pack failed verification; nothing was written.')
    for (const p of problems) console.error(`  - ${p}`)
    process.exitCode = 1
    return
  }

  for (const f of packManifest.files) {
    const out = join(dest, f.path)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, entries.get(f.path))
  }
  const noticeDir = join(dest, 'assets', '_content-pack')
  mkdirSync(noticeDir, { recursive: true })
  for (const [name, data] of entries) {
    if (name === 'CONTENT-MANIFEST.json' || name === 'README.txt' || name.startsWith('LICENSES/'))
      writeFileSync(join(noticeDir, name.replace('/', '__')), data)
  }
  console.log(
    `content:pull: ${packManifest.files.length} files verified and unpacked under ${join(dest, 'assets')}`,
  )
  console.log('  next: pnpm assets:check -- --pack, then pnpm dev with VITE_ASSET_BASE_URL=/')
}

try {
  await main()
} catch (err) {
  if (!(err instanceof Fail)) throw err
  console.error(`content:pull: ${err.message}`)
  process.exitCode = 1
}
