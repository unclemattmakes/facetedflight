// tests/unit/content-pack.test.ts: the content pack's classification and its tools.
//
// Hard rule 7: bought Asset Store geometry (and anything baked from it) and
// Unity Companion License content never leave the game. The `share` field on
// every row of required-assets.json is the positive list; these tests assert it
// is complete, that no bought row can carry it, and that the builder, the
// puller and `assets:check --pack` agree on a real round trip (into temp dirs:
// public/ is never written).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  geometrySource,
  loadAssetManifest,
  type ManifestAsset,
  NEVER_SHARE_PROVENANCE,
  readZip,
  SHARE_LICENCES,
  sha256Hex,
  sharedAssets,
  shareProblems,
  writeZip,
} from '../../tools/assets/content-pack-lib.mjs'
import { REPO } from './helpers/repo-root'

const assets = loadAssetManifest().assets
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-content-pack-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const node = (script: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [path.join(REPO, 'tools', 'assets', script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })

describe('the share classification', () => {
  it('every asset has a share value: none, or an SPDX id we ship a licence text for', () => {
    for (const a of assets) {
      expect(['none', ...Object.keys(SHARE_LICENCES)], a.id).toContain(a.share)
    }
    const texts = fs.readdirSync(path.join(REPO, 'tools', 'assets', 'licences'))
    for (const id of Object.keys(SHARE_LICENCES)) expect(texts).toContain(`${id}.txt`)
  })

  it('the classification is coherent', () => {
    expect(shareProblems(assets)).toEqual([])
  })

  it('no bought or replace-class asset is shareable', () => {
    const bought = assets.filter((a) => a.licence !== 'KEEP')
    expect(bought.length).toBeGreaterThan(40)
    for (const a of bought) expect(a.share, a.id).toBe('none')
  })

  it('no shareable asset has bought-pack or Unity provenance', () => {
    for (const a of sharedAssets(assets)) {
      expect(`${a.id} ${geometrySource(a)}`, a.id).not.toMatch(NEVER_SHARE_PROVENANCE)
    }
  })

  it('the tripwire has teeth: a KEEP row that names a bought pack is refused', () => {
    const base = assets.find((a) => a.share === 'CC-BY-NC-4.0') as ManifestAsset
    for (const src of [
      'Assets/Tree Pack/Mesh/trees_03.fbx',
      'Assets/AxeyWorks Low Poly/Models/Bush.fbx',
      'Assets/Quantum Theory/Polyworld/Spire.fbx',
      'Assets/Marmoset/Examples/Sky/castle.hdr',
      'Assets/Geometric-Landscape-Tropic-Island/palm.fbx',
      'Materialized Mesh/MM_level_sel_room/MM_chair.asset',
      'Assets/Standard Assets/Sky/skybox.mat',
    ]) {
      expect(shareProblems([{ ...base, source: src }]).join(), src).toMatch(/bought pack or Unity/)
    }
    // A material named after the geometry clause does not count: only its colour crossed.
    expect(
      shareProblems([{ ...base, source: 'Meshes/x.fbx, material SampleScenes/Orange.mat' }]),
    ).toEqual([])
  })

  it('the mascot is not shared, the title logo is, the share still is not', () => {
    const byId = (id: string) => assets.find((a) => a.id === id) as ManifestAsset
    expect(byId('brand.uncleMattCircle').share).toBe('none')
    expect(byId('prop.titleLogo').share).toBe('CC-BY-NC-4.0')
    expect(byId('share.still').share).toBe('none')
    expect(
      shareProblems([{ ...byId('brand.uncleMattCircle'), share: 'CC-BY-NC-4.0' }]).length,
    ).toBeGreaterThan(0)
  })

  it('the music is CC0 and the font is CC BY-SA with its notice', () => {
    for (const a of assets.filter((x) => x.path.startsWith('assets/audio/') && x.state === 'ready'))
      expect(a.share, a.id).toBe('CC0-1.0')
    for (const a of assets.filter((x) => x.path.startsWith('assets/fonts/')))
      expect(a.share, a.id).toBe('CC-BY-SA-4.0')
  })
})

describe('the zip codec', () => {
  it('round-trips bytes, stored and deflated, and is reproducible', () => {
    const entries = [
      { name: 'a/text.txt', data: Buffer.from('hello hello hello hello hello hello') },
      {
        name: 'a/random.bin',
        data: Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 97) % 251)),
      },
      { name: 'empty', data: Buffer.alloc(0) },
    ]
    const zip = writeZip(entries)
    expect(sha256Hex(writeZip(entries))).toBe(sha256Hex(zip))
    const back = readZip(zip)
    for (const e of entries) expect(back.get(e.name)?.equals(e.data), e.name).toBe(true)
  })

  it('refuses a corrupted entry and a non-zip', () => {
    const zip = writeZip([{ name: 'x', data: Buffer.from('payload payload payload payload') }])
    const bad = Buffer.from(zip)
    bad[30 + 1 + 3] = (bad[30 + 1 + 3] ?? 0) ^ 0xff
    expect(() => readZip(bad)).toThrow()
    expect(() => readZip(Buffer.from('nope'))).toThrow(/not a zip/)
  })
})

describe('pull refuses a missing release', () => {
  it('says so plainly and writes nothing', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end('not found')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const dest = path.join(tmp, 'no-release')
    // spawnSync would block the server's event loop, so run the child asynchronously.
    const { spawn } = await import('node:child_process')
    const out = await new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          path.join(REPO, 'tools', 'assets', 'pull-content-pack.mjs'),
          '--url',
          `http://127.0.0.1:${port}/pack.zip`,
          '--dest',
          dest,
        ],
        { env: process.env },
      )
      let err = ''
      child.stderr.on('data', (d) => {
        err += d
      })
      child.on('close', (code) => resolve({ code, err }))
    })
    server.close()
    expect(out.code).toBe(1)
    expect(out.err).toMatch(/does not exist|no content pack/)
    expect(fs.existsSync(dest)).toBe(false)
  })

  it('refuses a non-https, non-local URL', () => {
    const r = node('pull-content-pack.mjs', [
      '--url',
      'http://example.com/p.zip',
      '--dest',
      path.join(tmp, 'x'),
    ])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/non-https/)
  })
})

// The round trip needs the real bytes (the builder verifies each against its
// recorded sha). On a checkout without them the suite below is skipped; the
// disk reads happen inside the tests, never during collection.
const haveAssets = () =>
  sharedAssets(assets).every((a) => fs.existsSync(path.join(REPO, 'public', a.path)))

describe.skipIf(!haveAssets())('build, pull and verify a real pack', () => {
  const out = path.join(tmp, 'out')
  const unpack = path.join(tmp, 'unpack')
  let zipPath = ''

  it('builds a pack of exactly the shareable assets', () => {
    const r = node('build-content-pack.mjs', ['--out', out])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    zipPath = fs
      .readdirSync(out)
      .map((f) => path.join(out, f))
      .find((f) => f.endsWith('.zip')) as string
    const entries = readZip(fs.readFileSync(zipPath))
    const manifest = JSON.parse((entries.get('CONTENT-MANIFEST.json') as Buffer).toString('utf8'))
    const shared = sharedAssets(assets)
      .map((a) => a.path)
      .sort()
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual(shared)
    // No bought asset, no Unity path or guid anywhere in what a stranger reads.
    for (const a of assets.filter((x) => x.share === 'none'))
      expect(entries.has(a.path), a.id).toBe(false)
    const text = JSON.stringify(manifest) + (entries.get('README.txt') as Buffer).toString('utf8')
    expect(text).not.toMatch(/guid|Assets\/|FacetedFlight|C:\\|Users/)
    for (const f of manifest.files) {
      expect(f.licence).toMatch(/^CC/)
      expect(f.author).toBeTruthy()
      expect(entries.has(`LICENSES/${f.licence}.txt`)).toBe(true)
    }
  })

  it('pulls it into a temp dir and assets:check --pack passes', () => {
    const r = node('pull-content-pack.mjs', ['--from', zipPath, '--dest', unpack])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    const check = node('check-assets-present.mjs', ['--pack'], { ASSET_DIR: unpack })
    expect(check.stderr).toBe('')
    expect(check.status).toBe(0)
    expect(check.stdout).toMatch(/absent, which is expected/)
  })

  it('assets:check --pack fails when one byte of a shared file changes, or one is missing', () => {
    const victim = path.join(unpack, (sharedAssets(assets)[0] as ManifestAsset).path)
    const good = fs.readFileSync(victim)
    const flipped = Buffer.from(good)
    flipped[0] = (flipped[0] ?? 0) ^ 1
    fs.writeFileSync(victim, flipped)
    expect(node('check-assets-present.mjs', ['--pack'], { ASSET_DIR: unpack }).status).toBe(1)
    fs.rmSync(victim)
    const missing = node('check-assets-present.mjs', ['--pack'], { ASSET_DIR: unpack })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toMatch(/missing/)
    fs.writeFileSync(victim, good)
  })

  it('pull refuses a pack whose bytes differ from its manifest, and writes nothing', () => {
    const entries = readZip(fs.readFileSync(zipPath))
    const first = (sharedAssets(assets)[0] as ManifestAsset).path
    const bad = Buffer.from(entries.get(first) as Buffer)
    bad[0] = (bad[0] ?? 0) ^ 1
    entries.set(first, bad)
    const tampered = path.join(tmp, 'tampered.zip')
    fs.writeFileSync(tampered, writeZip([...entries].map(([name, data]) => ({ name, data }))))
    const dest = path.join(tmp, 'tampered-dest')
    const r = node('pull-content-pack.mjs', ['--from', tampered, '--dest', dest])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/failed verification/)
    expect(fs.existsSync(dest)).toBe(false)
  })

  it('pull refuses a path that climbs out of the tree', () => {
    const entries = readZip(fs.readFileSync(zipPath))
    const manifest = JSON.parse((entries.get('CONTENT-MANIFEST.json') as Buffer).toString('utf8'))
    const body = Buffer.from('x')
    manifest.files.push({
      path: 'assets/../../evil.txt',
      bytes: 1,
      sha256: sha256Hex(body),
      licence: 'CC0-1.0',
    })
    entries.set('CONTENT-MANIFEST.json', Buffer.from(JSON.stringify(manifest)))
    entries.set('assets/../../evil.txt', body)
    const evil = path.join(tmp, 'evil.zip')
    fs.writeFileSync(evil, writeZip([...entries].map(([name, data]) => ({ name, data }))))
    const dest = path.join(tmp, 'evil-dest')
    const r = node('pull-content-pack.mjs', ['--from', evil, '--dest', dest])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/unsafe/)
    expect(fs.existsSync(path.join(tmp, 'evil.txt'))).toBe(false)
  })
})
