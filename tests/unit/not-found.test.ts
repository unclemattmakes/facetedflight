/**
 * DEV-602: the site's 404 page. Cloudflare Pages answers an unknown path with
 * `index.html` and status 200 unless the build carries a top-level `404.html`.
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NOT_FOUND_PAGE, notFound, notFoundHtml } from '../../tools/dev/not-found.mjs'

describe('the 404 page (DEV-602)', () => {
  it('is named what Pages looks for, and is emitted by every build', () => {
    expect(NOT_FOUND_PAGE).toBe('404.html')
    const plugin = notFound()
    expect(plugin.apply).toBe('build')
    const emitted: { fileName?: string; source?: unknown }[] = []
    const hook = plugin.generateBundle as unknown as (this: unknown) => void
    hook.call({ emitFile: (f: { fileName?: string; source?: unknown }) => emitted.push(f) })
    expect(emitted).toEqual([{ type: 'asset', fileName: '404.html', source: notFoundHtml() }])
  })

  it('says the anniversary name, links home, asks not to be indexed, and runs no script', () => {
    const html = notFoundHtml()
    expect(html).toContain('Faceted Flight: 10th Anniversary Edition')
    expect(html).toContain('href="/"')
    expect(html).toContain('name="robots" content="noindex"')
    expect(html).not.toMatch(/<script/i)
  })

  it('is wired into vite.config.ts', () => {
    const config = fs.readFileSync('vite.config.ts', 'utf8')
    expect(config).toMatch(/^\s+notFound\(\),$/m)
  })
})
