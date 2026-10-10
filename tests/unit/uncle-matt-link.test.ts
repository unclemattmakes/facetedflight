// tests/unit/uncle-matt-link.test.ts: the Uncle Matt Makes portrait button.
// DEV-803 (Matt, 2026-10-07). One piece of code makes it on the title screen
// and in the making-of site's header (Matt: "re-use the code from the title
// screen"): `src/render/uncle-matt-link.{ts,css}`. index.html only places it.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { UNCLE_MATT_LABEL, UNCLE_MATT_URL } from '@/render/uncle-matt-link'

const page = (): string => fs.readFileSync('index.html', 'utf8')
const main = (): string => fs.readFileSync('src/main.ts', 'utf8')
const link = (): string => fs.readFileSync('src/render/uncle-matt-link.ts', 'utf8')
const css = (): string => fs.readFileSync('src/render/uncle-matt-link.css', 'utf8')

describe('DEV-803: the Uncle Matt Makes portrait link', () => {
  it('is a labelled new-tab link to the maker, with noopener and the splash portrait', () => {
    expect(UNCLE_MATT_URL).toBe('https://unclemattmakes.com')
    expect(UNCLE_MATT_LABEL).toBe('Uncle Matt Makes')
    const src = link()
    expect(src).toContain("a.target = '_blank'")
    expect(src).toContain("a.rel = 'noopener'")
    expect(src).toContain("a.setAttribute('aria-label', UNCLE_MATT_LABEL)")
    expect(src).toContain('img.src = assetUrl(SPLASH_PORTRAIT_PATH)')
  })

  it('is a round 48px button (56 on touch), the look shared with the making-of header', () => {
    expect(css()).toMatch(/\.uncle-matt-link \{[^}]*width: 48px/)
    expect(css()).toMatch(/\.uncle-matt-link \{[^}]*border-radius: 50%/)
    expect(css()).toMatch(/pointer: coarse\)\s*\{\s*\.uncle-matt-link\s*\{\s*width: 56px/)
  })

  it('on the title: made by the shared code, 16px in from the corner, only while the title is up', () => {
    expect(main()).toContain("applyUncleMattLink(el<HTMLAnchorElement>('uncle-matt-link'))")
    // A no-JavaScript fallback: an address and a label, and the shared code does the rest.
    expect(page()).toMatch(/<a id="uncle-matt-link" href="https:\/\/unclemattmakes\.com"/)
    const html = page()
    expect(html).toContain('body:not([data-title-up]) #uncle-matt-link { display: none; }')
    expect(html).toMatch(/#uncle-matt-link \{[^}]*left: calc\(16px \+ env\(safe-area-inset-left/)
    expect(html).toMatch(
      /#uncle-matt-link \{[^}]*bottom: calc\(16px \+ env\(safe-area-inset-bottom/,
    )
    expect(html).toMatch(/max-width: 639px\) \{\s*#uncle-matt-link \{ bottom: calc\(40px/)
  })

  it('in the making-of header: the same code, not a copy', () => {
    const chrome = fs.readFileSync('src/making-of/shared/chrome.ts', 'utf8')
    expect(chrome).toContain("import { applyUncleMattLink } from '@/render/uncle-matt-link'")
    const plugin = fs.readFileSync('tools/making-of/plugin.ts', 'utf8')
    expect(plugin).toContain('<a data-uncle-matt-link></a>')
    expect(plugin).not.toContain('unclemattmakes.com')
  })
})
