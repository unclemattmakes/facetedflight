// tests/unit/making-of-sources.test.ts: every number and listing on the site
// resolves against the tree. DEV-508 (docs/plan/MAKING-OF.md §2.4).
//
// `data-const` and `data-snippet` are resolved at build; this resolves every
// one in every page on disk, so renaming `stepBoundary` or moving a constant
// fails `pnpm check` with the page's path in the message instead of leaving an
// empty <pre> on a public page. It also runs the whole page transform, so a
// placeholder the plugin does not know about shows up here too.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pagesOnDisk, transformPage } from '../../tools/making-of/plugin'
import {
  constKeysIn,
  cutSnippet,
  highlight,
  lookupConstant,
  resolveSources,
  snippetRefsIn,
} from '../../tools/making-of/source-truth'

const ROOT = process.cwd()
const pageHtml = (slug: string) =>
  fs.readFileSync(
    path.join(ROOT, 'making-of', slug === 'index' ? 'index.html' : `${slug}/index.html`),
    'utf8',
  )

describe('making-of sources', () => {
  it('there are pages with sources to resolve (the sweep is not vacuous)', () => {
    const all = pagesOnDisk(ROOT).map(pageHtml)
    expect(all.flatMap(constKeysIn).length).toBeGreaterThan(0)
    expect(all.flatMap(snippetRefsIn).length).toBeGreaterThan(0)
  })

  for (const slug of pagesOnDisk(ROOT)) {
    it(`${slug}: every data-const and data-snippet resolves, and none is left behind`, () => {
      const out = transformPage(ROOT, slug, pageHtml(slug), 'preview')
      expect(out).not.toMatch(/data-const=|data-snippet=|<!--ff2:/)
    })
  }

  it('a constant is read from the sheet, with its unit and trust', () => {
    const hit = lookupConstant(ROOT, 'boundary.resetDelay')
    expect(hit.value).toBe(13)
    expect(hit.trust).toBe('verified')
  })

  it('a key that is not in the sheet fails, naming the page', () => {
    expect(() =>
      resolveSources(ROOT, '<span data-const="boundary.noSuchThing"></span>', 'making-of/x'),
    ).toThrow(/making-of\/x: data-const "boundary.noSuchThing" does not resolve/)
  })

  it('a renamed declaration or a missing file fails, naming the page', () => {
    expect(() =>
      resolveSources(
        ROOT,
        '<pre data-snippet="src/sim/boundary.ts#stepBoundaryGone"></pre>',
        'making-of/x',
      ),
    ).toThrow(/making-of\/x: data-snippet .* no top-level declaration named stepBoundaryGone/)
    expect(() =>
      resolveSources(ROOT, '<pre data-snippet="src/sim/nope.ts#x"></pre>', 'making-of/x'),
    ).toThrow(/does not exist/)
  })

  it('a snippet is the declaration, cut by name, with its line', () => {
    const hit = cutSnippet(ROOT, 'src/sim/boundary.ts#stepBoundary')
    expect(hit.text.startsWith('export const stepBoundary')).toBe(true)
    expect(hit.text.trimEnd().endsWith('}')).toBe(true)
    const file = fs.readFileSync(path.join(ROOT, 'src/sim/boundary.ts'), 'utf8').split('\n')
    expect(file[hit.startLine - 1]).toContain('export const stepBoundary')
  })

  it('highlighting reproduces the text exactly, escaped', () => {
    const text = 'const a = "x" < 3 // note\nif (a) { return `t` }'
    const html = highlight(text)
    const plain = html
      .replace(/<[^>]+>/g, '')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&amp;', '&')
    expect(plain).toBe(text)
    expect(html).toContain('<span class="keyword">const</span>')
    expect(html).toContain('<span class="comment">// note</span>')
  })
})
