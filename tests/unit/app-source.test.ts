// tests/unit/app-source.test.ts — the guard on the guards' reader.
//
// `helpers/app-source.ts` is what every source-text guard on `boot/app.ts`
// reads through (APP-SPLIT phase 0). A reader that silently returned '' would
// turn every "does not contain" green at once, so this is its loud
// counterpart (CLAUDE.md: *"A guarded suite also needs its loud
// counterpart"*): it proves the reader reads, that the order helpers refuse
// what they must refuse, and that no test goes back to reading the entry file
// by name — the habit that would make the next negative guard blind to the
// code the split moves out of it.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_DIR,
  APP_ENTRY,
  type AppFile,
  appFiles,
  appFileWith,
  appSource,
  codeOnly,
  fileWithIn,
  inOrder,
  readThroughCtx,
} from './helpers/app-source'

const UNIT = path.join(process.cwd(), 'tests', 'unit')

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('the reader reads', () => {
  it('starts at the entry, and every file it returns has code in it', () => {
    const files = appFiles()
    expect(files[0]?.file).toBe(APP_ENTRY)
    for (const f of files) expect(f.text.length, f.file).toBeGreaterThan(0)
    // The entry is where `bootApp` is exported from, whatever else moves.
    expect(files[0]?.text).toMatch(/export\s+(const|async function|\{)/)
  })

  it('returns every .ts file under the split directory, and nothing outside it', () => {
    const files = appFiles().map((f) => f.file)
    const dir = path.join(process.cwd(), APP_DIR)
    const onDisk = fs.existsSync(dir)
      ? walk(dir).map((p) => path.relative(process.cwd(), p).split(path.sep).join('/'))
      : []
    expect(files.slice(1).sort()).toEqual(onDisk.sort())
    for (const f of files.slice(1)) expect(f.startsWith(`${APP_DIR}/`), f).toBe(true)
  })

  it('appSource holds every file of the tree, whole', () => {
    const all = appSource()
    for (const f of appFiles()) expect(all.includes(f.text), f.file).toBe(true)
  })

  it('finds the one file a real anchor names', () => {
    expect(appFileWith('export const bootApp').file).toBe(APP_ENTRY)
  })
})

describe('the order helpers refuse what they must', () => {
  const tree: AppFile[] = [
    { file: 'a.ts', text: 'const one = 1\nconst shared = 0\n' },
    { file: 'b.ts', text: 'const two = 2\nconst shared = 0\n' },
  ]

  it('fileWithIn returns the one file holding the anchor', () => {
    expect(fileWithIn(tree, 'const two').file).toBe('b.ts')
    expect(fileWithIn(tree, /const\s+one/).file).toBe('a.ts')
  })

  it('fileWithIn throws on an anchor no file holds', () => {
    expect(() => fileWithIn(tree, 'const three')).toThrow(/no file/)
  })

  it('fileWithIn throws on an anchor that names two places', () => {
    expect(() => fileWithIn(tree, 'const shared')).toThrow(/2 files/)
  })

  it('fileWithIn treats a /g regex as a plain test, not a stateful one', () => {
    const g = /const/g
    expect(() => fileWithIn(tree, g)).toThrow(/2 files/)
    expect(() => fileWithIn(tree, g)).toThrow(/2 files/)
  })

  it('inOrder returns the positions, each after the last', () => {
    expect(inOrder('a b c', ['a', 'b', 'c'])).toEqual([0, 2, 4])
  })

  it('inOrder throws on a missing anchor, rather than comparing a -1', () => {
    expect(() => inOrder('a b', ['a', 'z'])).toThrow(/not in this file/)
  })

  it('inOrder throws when an anchor occurs only BEFORE its predecessor', () => {
    expect(() => inOrder('b then a', ['a', 'b'])).toThrow(/only BEFORE/)
  })

  it('codeOnly strips both comment forms and keeps the code', () => {
    expect(codeOnly('/* x */ const a = 1 // y\nconst b = 2')).toBe(' const a = 1 \nconst b = 2')
  })

  it('readThroughCtx removes the `ctx.` plumbing and nothing else', () => {
    expect(readThroughCtx('if (ctx.launchSpec) ctx.flight?.x(ctx.level.id)')).toBe(
      'if (launchSpec) flight?.x(level.id)',
    )
    // A property that merely ends in `ctx`, or a `.ctx.` member, is not the plumbing.
    expect(readThroughCtx('a.ctx.b + myctx.c + ctxs.d')).toBe('a.ctx.b + myctx.c + ctxs.d')
    // The live tree has plumbing to read through (the loud counterpart: a
    // helper that changed nothing would turn every guard using it into a copy
    // of `appSource()`, which is what moved code fails).
    expect(appSource()).toMatch(/(?<![\w$.])ctx\./)
    expect(readThroughCtx(appSource())).not.toMatch(/(?<![\w$.])ctx\.(?=[A-Za-z_$])/)
  })
})

describe('no unit test reads the entry by name', () => {
  // Built, not written: this file must not itself spell the paths it forbids,
  // or the sweep would be answered by its own prose (CLAUDE.md, DEV-287).
  const entry = APP_ENTRY.split('/')
  const quoted = (s: string) => `['"\`]${s.replace(/\./g, '\\.')}['"\`]`
  const forms = [
    new RegExp(quoted(entry.join('/'))),
    new RegExp(`${quoted(entry[1] as string)}\\s*,\\s*${quoted(entry[2] as string)}`),
    new RegExp(quoted(`../../${entry.join('/')}`)),
  ]

  it('finds every source-text guard going through the helper', () => {
    const helper = path.join(UNIT, 'helpers', 'app-source.ts')
    const offenders: string[] = []
    for (const file of walk(UNIT)) {
      if (file === helper) continue
      const code = codeOnly(fs.readFileSync(file, 'utf8'))
      for (const form of forms) {
        if (form.test(code)) offenders.push(`${path.relative(UNIT, file)}: ${form}`)
      }
    }
    expect(
      offenders,
      'read the boot tree through tests/unit/helpers/app-source.ts, so the guard ' +
        'follows the code when the app-split moves it out of the entry file',
    ).toEqual([])
  })

  it('and the sweep can see the form it forbids', () => {
    // Its premise: the three forms match the way the readers used to spell it.
    // Split from the constant: an array literal of the three parts IS the
    // second form, and this file would then trip its own sweep.
    const a = APP_ENTRY.split('/')
    expect(forms[0]?.test(`readFileSync('${a.join('/')}', 'utf8')`)).toBe(true)
    expect(forms[1]?.test(`path.join(ROOT, 'src', '${a[1]}', '${a[2]}')`)).toBe(true)
    expect(forms[2]?.test(`new URL('../../${a.join('/')}', import.meta.url)`)).toBe(true)
  })
})
