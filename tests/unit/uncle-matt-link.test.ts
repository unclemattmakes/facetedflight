// tests/unit/uncle-matt-link.test.ts: the Uncle Matt Makes portrait button.
// DEV-803 (Matt, 2026-10-07). One piece of code makes it on the title screen
// and in the making-of site's header (Matt: "re-use the code from the title
// screen"): `src/render/uncle-matt-link.{ts,css}`. index.html only places it.
//
// DEV-967: the first case now RUNS `applyUncleMattLink` on a stand-in anchor instead of
// reading its source for the assignments. The three cases that matched CSS pixel values,
// index.html's rules and an import line as text were removed: they restated a stylesheet and
// proved no behaviour. Nothing replaces them: the look is a photograph, and that the making-of
// header calls the shared function rather than a copy is a review matter, not a gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyUncleMattLink, UNCLE_MATT_LABEL, UNCLE_MATT_URL } from '@/render/uncle-matt-link'

interface FakeImg {
  alt: string
  width: number
  height: number
  decoding: string
  src: string
}

/** The few members of an anchor the function touches. */
const fakeAnchor = () => {
  const attrs = new Map<string, string>()
  const classes = new Set<string>()
  const children: FakeImg[] = []
  return {
    classList: { add: (c: string) => classes.add(c) },
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    querySelector: () => children[0] ?? null,
    append: (img: FakeImg) => children.push(img),
    href: '',
    target: '',
    rel: '',
    title: '',
    attrs,
    classes,
    children,
  }
}

// The portrait's URL comes from the asset base, which a plain clone (the public CI) has
// no .env for; give it one, as splash.test.ts does.
beforeEach(() => vi.stubEnv('VITE_ASSET_BASE_URL', '/'))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('DEV-803: the Uncle Matt Makes portrait link', () => {
  it('makes an empty anchor a labelled new-tab link to the maker, with noopener and the splash portrait', () => {
    expect(UNCLE_MATT_URL).toBe('https://unclemattmakes.com')
    expect(UNCLE_MATT_LABEL).toBe('Uncle Matt Makes')
    vi.stubGlobal('document', { createElement: () => ({}) as FakeImg })
    const a = fakeAnchor()
    applyUncleMattLink(a as unknown as HTMLAnchorElement)
    expect(a.href).toBe(UNCLE_MATT_URL)
    expect(a.target).toBe('_blank')
    expect(a.rel).toBe('noopener')
    expect(a.attrs.get('aria-label')).toBe(UNCLE_MATT_LABEL)
    expect(a.classes.has('uncle-matt-link')).toBe(true)
    expect(a.children).toHaveLength(1)
    expect(a.children[0]?.src).toMatch(/\.(png|jpg|webp)$/)
  })

  it('does not add a second image when the anchor already holds one', () => {
    vi.stubGlobal('document', { createElement: () => ({}) as FakeImg })
    const a = fakeAnchor()
    applyUncleMattLink(a as unknown as HTMLAnchorElement)
    applyUncleMattLink(a as unknown as HTMLAnchorElement)
    expect(a.children).toHaveLength(1)
  })
})
