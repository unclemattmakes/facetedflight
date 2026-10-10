// tools/assets/content-pack-lib.mjs: the shared half of the content pack.
//
// The pack is the redistributable part of the game's content: every asset in
// `required-assets.json` whose `share` field names a licence, and nothing else.
// `build-content-pack.mjs` writes it, `pull-content-pack.mjs` reads it back,
// `check-assets-present.mjs --pack` verifies a tree made from it. All three
// import this file so "what is shareable" has exactly one definition.
//
// The ZIP writer and reader are here because the repo has no zip dependency and
// a pack is small and simple: stored or deflated entries, no encryption, no
// zip64, fixed timestamps so the same inputs give the same bytes.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync, inflateRawSync, constants as zc } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..', '..')
export const MANIFEST_PATH = join(HERE, 'required-assets.json')
export const LICENCE_TEXT_DIR = join(HERE, 'licences')

/** SPDX ids a `share` field may carry, besides "none". */
export const SHARE_LICENCES = {
  'CC-BY-NC-4.0': {
    name: 'Creative Commons Attribution-NonCommercial 4.0 International',
    url: 'https://creativecommons.org/licenses/by-nc/4.0/legalcode',
  },
  'CC0-1.0': {
    name: 'Creative Commons Zero 1.0 Universal',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode',
  },
  'CC-BY-SA-4.0': {
    name: 'Creative Commons Attribution-ShareAlike 4.0 International',
    url: 'https://creativecommons.org/licenses/by-sa/4.0/legalcode',
  },
}

/**
 * Provenance words that mean "bought pack" or "Unity's own content". A row whose
 * `source` or `id` matches one of these may never be shared, whatever its
 * `licence` field says: the field is a human's opinion, this is a tripwire.
 * Hard rule 7: bought geometry and its derivatives never leave the game, and
 * Unity Companion License content is engine-locked.
 */
export const NEVER_SHARE_PROVENANCE =
  /Tree Pack|AxeyWorks|Quantum Theory|Polyworld|Geometric-Landscape|Materialized Mesh|MM_|Marmoset|SampleScenes|Standard Assets|Unity Technologies|Mixamo|Asset Store/i

/** The version the pack is named for: package.json, one source of truth. */
export function packVersion() {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version
}

export function packFileName(version = packVersion()) {
  return `facetedflight-content-${version}.zip`
}

export function loadAssetManifest(file = MANIFEST_PATH) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(manifest.assets)) throw new Error(`${file} has no assets array`)
  return manifest
}

/**
 * The part of a row's `source` that says where the BYTES came from. A source
 * line often ends with the material the mesh wore in 2016 ("material
 * SampleScenes/..."); only that material's colour numbers crossed, never the
 * material, so the tripwire reads up to the first mention of one.
 */
export function geometrySource(a) {
  return String(a.source ?? '').split(/[,;]?\s+materials?\s/i)[0]
}

/**
 * Problems with the `share` fields, as strings. Empty means the classification
 * is coherent. Used by the unit test, the builder and `assets:check`.
 */
export function shareProblems(assets) {
  const problems = []
  for (const a of assets) {
    const where = `${a.id ?? a.path}`
    const valid = a.share === 'none' || Object.hasOwn(SHARE_LICENCES, a.share)
    if (!valid) {
      problems.push(`${where}: share must be "none" or an SPDX id, got ${JSON.stringify(a.share)}`)
      continue
    }
    if (a.share === 'none') continue
    if (a.licence !== 'KEEP')
      problems.push(`${where}: licence ${a.licence} can never carry share ${a.share}`)
    if (NEVER_SHARE_PROVENANCE.test(`${a.id} ${geometrySource(a)}`))
      problems.push(
        `${where}: provenance names a bought pack or Unity content, so it cannot be shared`,
      )
    if (a.state !== 'ready') problems.push(`${where}: only ready assets can be shared (${a.state})`)
    if (typeof a.sha256 !== 'string')
      problems.push(`${where}: a shared asset needs a recorded sha256`)
    if (typeof a.shareAuthor !== 'string' || a.shareAuthor === '')
      problems.push(`${where}: a shared asset needs shareAuthor`)
    if (a.id === 'brand.uncleMattCircle' || /brand\//.test(a.path))
      problems.push(`${where}: the mascot is not part of the pack (Matt, M8)`)
  }
  return problems
}

export const sharedAssets = (assets) => assets.filter((a) => a.share && a.share !== 'none')

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex')

/** A pack path must be one of the manifest's relative, forward-slash, in-tree paths. */
export function safePackPath(p) {
  return (
    typeof p === 'string' &&
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    !/^[A-Za-z]:/.test(p) &&
    !p.split('/').some((s) => s === '..' || s === '.' || s === '')
  )
}

// ── ZIP ───────────────────────────────────────────────────────────────────
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1 // 1980-01-01, so the bytes are reproducible

/** @param {{name: string, data: Buffer}[]} entries */
export function writeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const deflated = deflateRawSync(data, { level: zc.Z_BEST_COMPRESSION })
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(DOS_TIME, 10)
    lh.writeUInt16LE(DOS_DATE, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    locals.push(lh, nameBuf, body)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(DOS_TIME, 12)
    ch.writeUInt16LE(DOS_DATE, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, nameBuf)
    offset += lh.length + nameBuf.length + body.length
  }
  const central = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, eocd])
}

/** @returns {Map<string, Buffer>} name to bytes; every entry's CRC is checked. */
export function readZip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = new Map()
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory')
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt zip local header: ${name}`)
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + csize)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw)
    else throw new Error(`unsupported zip method ${method}: ${name}`)
    if (data.length !== usize || crc32(data) !== crc)
      throw new Error(`zip entry fails its CRC: ${name}`)
    out.set(name, data)
  }
  return out
}
