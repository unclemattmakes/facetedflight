// The agent instructions stay small (docs/CLAUDE-MD.md).
//
// The root CLAUDE.md is read in full by every session, so its size is a cost every session
// pays. It reached 1,082 lines because lessons were appended and none ever left. These caps
// turn growth into a decision: raising one is an edit to this file, with a reason in the
// commit message, and the practice at the cap is one in, one out.
//
// The same sweep checks every relative link in every CLAUDE.md resolves, so a document that
// moves cannot leave a dead pointer in the file every session reads.
//
// CLAUDE.md files are agent instructions and the public export leaves them out at any depth,
// so this suite skips there and its loud counterpart says so here.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAINTAINER_CHECKOUT, present } from './helpers/checkout'
import { REPO } from './helpers/repo-root'

/** Line caps. Raise one deliberately, never to make a red go green without a reason. */
const ROOT_CAP = 200
const NESTED_CAP = 100

const HAVE_ROOT = present('CLAUDE.md')

const instructionFiles = (): string[] =>
  execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', '*CLAUDE.md'], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f === 'CLAUDE.md' || f.endsWith('/CLAUDE.md'))

const lineCount = (rel: string): number =>
  fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\n$/, '').split('\n').length

describe.skipIf(HAVE_ROOT || !MAINTAINER_CHECKOUT)('CLAUDE.md is missing', () => {
  it('says so in the working repository, rather than passing quietly', () => {
    expect(HAVE_ROOT, 'CLAUDE.md is absent; only the public export may lack it').toBe(true)
  })
})

describe.skipIf(!HAVE_ROOT)('the agent instructions stay small', () => {
  it('finds the root and at least one nested file', () => {
    const files = instructionFiles()
    expect(files).toContain('CLAUDE.md')
    expect(files.length).toBeGreaterThan(1)
  })

  it(`the root CLAUDE.md is at most ${ROOT_CAP} lines`, () => {
    expect(
      lineCount('CLAUDE.md'),
      'see docs/CLAUDE-MD.md: move a lesson down a level',
    ).toBeLessThanOrEqual(ROOT_CAP)
  })

  it(`every nested CLAUDE.md is at most ${NESTED_CAP} lines`, () => {
    const over = instructionFiles()
      .filter((f) => f !== 'CLAUDE.md')
      .map((f) => [f, lineCount(f)] as const)
      .filter(([, n]) => n > NESTED_CAP)
    expect(over, 'see docs/CLAUDE-MD.md').toEqual([])
  })

  it('the root points at the practices that keep it small', () => {
    expect(fs.readFileSync(path.join(REPO, 'CLAUDE.md'), 'utf8')).toContain('docs/CLAUDE-MD.md')
  })

  it('every relative link in every CLAUDE.md resolves', () => {
    const dead: string[] = []
    for (const f of instructionFiles()) {
      const text = fs.readFileSync(path.join(REPO, f), 'utf8')
      for (const m of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
        const target = m[1] ?? ''
        if (target === '' || /^[a-z]+:/i.test(target)) continue
        if (!fs.existsSync(path.join(REPO, path.dirname(f), target))) dead.push(`${f} -> ${target}`)
      }
    }
    expect(dead).toEqual([])
  })
})
