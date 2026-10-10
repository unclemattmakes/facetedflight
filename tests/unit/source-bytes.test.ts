// tests/unit/source-bytes.test.ts — no invisible bytes in source.
//
// This exists because the failure mode is real, has happened twice, and is
// undetectable by reading:
//
//   * A NUL byte was once written into `tools/extract/constants.mjs` by a tool
//     and had to be repaired at the byte level.
//   * A literal **backspace** (0x08) was written into a regex in
//     `tests/unit/water.test.ts`, turning `/\binverse\s*\(/` into
//     `/<BS>inverse\s*\(/` — a pattern that can never match. `grep` printed the
//     line looking exactly right, the file typechecked, the suite was green, and
//     the assertion was dead. Only a mutation caught it.
//
// Both came from an escaping layer between a generator and the file: `\b` is a
// backspace in most languages' string literals, and a regex written through one
// of those loses its word boundary and gains a control character.
//
// The cost of the guard is a directory walk. The cost of not having it is an
// assertion that passes forever while testing nothing.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { walkTree } from './helpers/source-tree'

const ROOTS = ['src', 'tests', 'tools', 'content/levels', 'content/ghosts']

/** Tab, newline and carriage return are the only control bytes source may hold. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d])

const walk = (dir: string): string[] =>
  walkTree(dir, {
    match: (name) => /\.(ts|tsx|mjs|js|json|md)$/.test(name),
    skipDir: (name) => name === 'node_modules' || name.startsWith('.'),
    optional: true,
  })

describe('source files', () => {
  it('contain no control characters other than tab, LF and CR', () => {
    const files = ROOTS.flatMap((r) => walk(r))
    // Guard the guard: an empty sweep would make this vacuous, and the walk is
    // the part most likely to break silently.
    expect(files.length).toBeGreaterThan(50)

    const offenders: string[] = []
    for (const file of files) {
      const bytes = fs.readFileSync(file)
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i] as number
        if (b >= 0x20 || ALLOWED.has(b)) continue
        // Report the line, because "byte 41203" is not actionable.
        const line = bytes.subarray(0, i).toString('utf8').split('\n').length
        offenders.push(`${file}:${line} has 0x${b.toString(16).padStart(2, '0')}`)
        break
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('has no lone DEL byte either', () => {
    // 0x7f is above the 0x20 floor above, so it needs saying separately. It has
    // the same property: invisible in a terminal, fatal in a regex.
    const offenders = ROOTS.flatMap((r) => walk(r)).filter((f) => fs.readFileSync(f).includes(0x7f))
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
