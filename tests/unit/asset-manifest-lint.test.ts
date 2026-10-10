// tests/unit/asset-manifest-lint.test.ts — the manifest linter's own teeth.
//
// `check-assets-present.mjs` is the floor check between "the build ran" and
// "the build works", and until now nothing exercised it. Its own header points
// at the gap: FF2_ASSET_MANIFEST exists "so CI can prove the guard still fails
// on a deliberately broken fixture — a guard nobody has seen fail is not a
// guard". This drives it against such fixtures.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const CHECKER = path.join(process.cwd(), 'tools', 'assets', 'check-assets-present.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-manifest-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

interface Report {
  ok: boolean
  problems: string[]
}

/** Lint one manifest and hand back the report. Never throws on a failing lint. */
const lint = (assets: unknown[], name: string): Report => {
  const file = path.join(tmp, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify({ version: 1, prefix: 'assets', assets }))
  const run = spawnSync(process.execPath, [CHECKER, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, FF2_ASSET_MANIFEST: file },
  })
  return JSON.parse(run.stdout) as Report
}

/** A minimal well-formed row; each test breaks exactly one thing. */
const row = (over: Record<string, unknown>) => ({
  id: 'test.row',
  path: 'assets/props/checkpoint-ring.glb',
  kind: 'mesh',
  state: 'planned',
  licence: 'KEEP',
  share: 'none',
  source: 'Assets/Faceted Flight/Meshes/jumpGate_diamond.fbx',
  ...over,
})

const complaints = (r: Report, needle: RegExp) => r.problems.filter((p) => needle.test(p))

describe('the manifest linter', () => {
  it('passes a well-formed row', () => {
    const r = lint([row({})], 'clean')
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('rejects a capitalised bucket key', () => {
    // R2 keys are case-sensitive and Windows filenames are not, so a
    // capitalised key works on Matt's machine and 404s in production.
    const r = lint([row({ path: 'assets/Props/Checkpoint-Ring.glb' })], 'capitalised')
    expect(r.ok).toBe(false)
    expect(complaints(r, /lower-case by convention/)).toHaveLength(1)
  })

  it('rejects a backslash, an absolute path and a climb out of the tree', () => {
    for (const [p, name] of [
      ['assets\\props\\ring.glb', 'backslash'],
      ['/assets/props/ring.glb', 'absolute'],
      ['assets/../../etc/passwd', 'escape'],
    ] as const) {
      expect(lint([row({ path: p })], name).ok, p).toBe(false)
    }
  })

  it('refuses to let a REPLACE-licensed asset reach state ready', () => {
    // The whole point of the exercise: a REPLACE asset in the bucket is a
    // third-party or derivative work one public deploy away from shipping.
    const r = lint([row({ state: 'ready', licence: 'REPLACE' })], 'replace-ready')
    expect(r.ok).toBe(false)
    expect(complaints(r, /must never be state ready/)).toHaveLength(1)
  })

  it('refuses a row with no share value, and a bought row that claims one', () => {
    const missing = lint([row({ share: undefined })], 'no-share')
    expect(missing.ok).toBe(false)
    expect(complaints(missing, /share must be/)).toHaveLength(1)
    const bought = lint([row({ licence: 'LICENSED', share: 'CC-BY-NC-4.0' })], 'bought-shared')
    expect(bought.ok).toBe(false)
    expect(complaints(bought, /can never carry share/)).toHaveLength(1)
  })

  it('catches a duplicate id and a duplicate path', () => {
    const r = lint([row({}), row({})], 'dupes')
    expect(r.ok).toBe(false)
    expect(complaints(r, /duplicate/).length).toBeGreaterThanOrEqual(2)
  })

  it('lints the shipped manifest clean', () => {
    // Asserting on the lint problems only, so this stays independent of whether
    // the local content tree has been hydrated with `pnpm assets:pull`.
    const run = spawnSync(process.execPath, [CHECKER, '--json'], { encoding: 'utf8' })
    const report = JSON.parse(run.stdout) as Report
    expect(complaints(report, /lower-case|duplicate|must never|escapes/)).toEqual([])
  })
})
