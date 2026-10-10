/**
 * The generated-content manifest, and the guard that reads it.
 *
 * `content/_generated.sha256` is the `content/` half of PORT_PLAN §4.1 — "when
 * the Unity project is not mounted, it verifies the sha256 instead" — which
 * `constants.mjs` had and the three tools that write `content/` did not. Twenty-
 * one JSON files could be hand-edited with nothing to say so, on the one host
 * that matters for it: the Linux runner, where `$FF2_LEGACY` does not exist.
 *
 * WHAT THIS ASSERTS, AND WHY NOT THE OBVIOUS THING. Re-hashing the tree here and
 * comparing to the manifest would be the tool's own arithmetic written twice —
 * green whenever the tool is self-consistent, including when it is wrong
 * (CLAUDE.md trap 24, and the `refRoot()` bug that shipped behind exactly that
 * shape). So the assertions are RELATIONSHIPS the manifest has to the tree —
 * same membership, sorted, host-independent — plus the two behaviours that are
 * the whole point: a tampered byte is caught, and an empty tree does not pass.
 *
 * The detection tests run against a temp COPY. Tampering with the real
 * `content/` and restoring it in a `finally` is one crashed assertion away from
 * leaving a corrupted working tree behind, and the thing being tested is a guard
 * against exactly that.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO as ROOT } from './helpers/repo-root'

const TOOL = path.join(ROOT, 'tools', 'extract', 'check-content.mjs')
const MANIFEST = path.join(ROOT, 'content', '_generated.sha256')

/** The trees the tool covers. Kept here as a literal so a change to either side shows up. */
const TREES = ['content/levels', 'content/environments', 'content/ghosts']

const manifestText = fs.readFileSync(MANIFEST, 'utf8')
const lines = manifestText.trim().split('\n')

/** Run the tool against some repo root, and hand back what it did. */
function run(repo: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [TOOL, ...args, '--repo', repo], { encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

/**
 * The `pnpm extract` chain itself.
 *
 * Two decisions here have a failure mode nobody sees until they run the command,
 * and both were live at once: a step that cannot succeed on any machine breaks
 * every step behind it, and a step MISSING from the chain silently produces a
 * lesser tree. Prose in three files did not stop either, so this is the sentence
 * as a test (DEV-108's lesson). Asserting on a script string has precedent here —
 * `licensing-docs.test.ts` does it for `prepare`.
 */
describe('the pnpm extract chain', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const chain: string = pkg.scripts.extract

  it('runs both stages of the environment bake, in that order', () => {
    // content/environments/*.json is a two-stage output: extract:props writes the
    // base, bake:placements adds the baked scatter and DEV-100's spawnClearing.
    // extract ran only the first for months, stripping 138 lines from all four.
    expect(chain).toContain('extract:props')
    expect(chain).toContain('bake:placements')
    expect(chain.indexOf('extract:props')).toBeLessThan(chain.indexOf('bake:placements'))
  })

  it('bakes placements only after the levels they read exist', () => {
    // bake-placements reads content/levels/ for the spawns it clears around.
    expect(chain.indexOf('extract:levels')).toBeLessThan(chain.indexOf('bake:placements'))
  })

  it('does not run extract:ghosts, which cannot succeed on any machine today', () => {
    // It re-packs a prototype staging dir rather than reading Unity, and that dir
    // is on no machine -- so in the chain it was a guaranteed exit 1 that also
    // stopped extract:palettes behind it. The recordings stay guarded by the
    // manifest above, so nothing was weakened by taking it out.
    expect(chain).not.toContain('extract:ghosts')
  })

  it('keeps extract:ghosts runnable by hand', () => {
    expect(pkg.scripts['extract:ghosts']).toBeTruthy()
  })
})

describe('content/_generated.sha256', () => {
  it('is a sha256-and-path table, one line per file', () => {
    for (const line of lines)
      expect(line).toMatch(/^[0-9a-f]{64} {2}content\/[a-z]+\/[\w.-]+\.json$/)
  })

  it('lists exactly the generated JSON on disk — no more, no fewer', () => {
    // Independently derived from the filesystem, NOT by re-running the tool's walk.
    const onDisk = TREES.flatMap((dir) =>
      fs
        .readdirSync(path.join(ROOT, dir))
        .filter((n) => n.endsWith('.json'))
        .map((n) => `${dir}/${n}`),
    ).sort()
    const listed = lines.map((l) => l.slice(66)).sort()
    expect(listed).toEqual(onDisk)
  })

  it('is sorted by path and free of backslashes, so the bytes are the same on both hosts', () => {
    const listed = lines.map((l) => l.slice(66))
    expect(listed).toEqual([...listed].sort())
    expect(manifestText).not.toContain('\\')
  })

  it('covers every shipped mission, every environment and both ghosts', () => {
    const listed = lines.map((l) => l.slice(66))
    // 13 missions + _schema + _structural-assertions, 5 environments, 2 ghosts.
    // FIVE, not four: `menu` is the title screen's valley (DEV-155) and no
    // mission names it, which is why the count is written here rather than
    // derived from the levels.
    expect(listed.filter((f) => f.startsWith('content/levels/'))).toHaveLength(15)
    expect(listed.filter((f) => f.startsWith('content/environments/'))).toHaveLength(5)
    expect(listed.filter((f) => f.startsWith('content/ghosts/'))).toHaveLength(2)
  })
})

describe('check-content.mjs', () => {
  let tmp: string

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-manifest-'))
    fs.mkdirSync(path.join(tmp, 'content'), { recursive: true })
    for (const dir of TREES) {
      fs.cpSync(path.join(ROOT, dir), path.join(tmp, dir), { recursive: true })
    }
    fs.copyFileSync(MANIFEST, path.join(tmp, 'content', '_generated.sha256'))
  })

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('passes on an untouched copy', () => {
    const r = run(tmp, '--check')
    expect(r.out).toContain('match the manifest')
    expect(r.status).toBe(0)
  })

  it('catches a hand-edited generated file, and names it', () => {
    // The exact CLAUDE.md trap: PlayerBoundary.resetDelay is 13 in all thirteen
    // shipped missions and 10 in the C# initialiser. A "correction" to 10 is the
    // most plausible wrong edit anyone would make to this tree.
    const victim = path.join(tmp, 'content', 'levels', 'int_01_hoverJet.json')
    const before = fs.readFileSync(victim, 'utf8')
    expect(before).toContain('"resetDelay": 13')
    fs.writeFileSync(victim, before.replace('"resetDelay": 13', '"resetDelay": 10'))

    const r = run(tmp, '--check')
    expect(r.status).toBe(3)
    expect(r.out).toContain('content/levels/int_01_hoverJet.json')

    fs.writeFileSync(victim, before)
    expect(run(tmp, '--check').status).toBe(0)
  })

  it('catches a file that appears without being regenerated', () => {
    const extra = path.join(tmp, 'content', 'ghosts', 'int_99_invented.json')
    fs.writeFileSync(extra, '{}\n')
    const r = run(tmp, '--check')
    expect(r.status).toBe(3)
    expect(r.out).toContain('not in the manifest')
    fs.rmSync(extra)
  })

  it('catches a file that disappears', () => {
    const victim = path.join(tmp, 'content', 'environments', 'kauai.json')
    const before = fs.readFileSync(victim)
    fs.rmSync(victim)
    const r = run(tmp, '--check')
    expect(r.status).toBe(3)
    expect(r.out).toContain('(gone)')
    fs.writeFileSync(victim, before)
  })

  /**
   * The loud counterpart. `assets:check` reported "0/0 ready verified" and
   * passed while the HoverJet flew backwards; `describe.skipIf` skipped the
   * tests and not the body. A guard whose failure mode is silence is not a
   * guard, so: an empty tree must EXIT 1, and must not look clean.
   */
  it('refuses to pass on an empty tree instead of verifying nothing', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-manifest-empty-'))
    try {
      for (const dir of TREES) fs.mkdirSync(path.join(empty, dir), { recursive: true })
      fs.copyFileSync(MANIFEST, path.join(empty, 'content', '_generated.sha256'))
      const r = run(empty, '--check')
      expect(r.status).toBe(1)
      expect(r.out).toContain('the walk is broken')
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })
})
