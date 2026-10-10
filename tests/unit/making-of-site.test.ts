// tests/unit/making-of-site.test.ts: the manifest, the channels and the toy
// host's context cap. DEV-506, DEV-507.

import { describe, expect, it } from 'vitest'
import { builtChapters, CHAPTERS, SITE_PAGES, visibleChapters } from '../../src/making-of/chapters'
import { createLiveSet, MAX_LIVE_3D } from '../../src/making-of/shared/toy-host'
import { TOY_LOADERS } from '../../src/making-of/toys/registry'
import { buildablePages, pagesOnDisk } from '../../tools/making-of/plugin'

const ROOT = process.cwd()

describe('the chapter manifest', () => {
  it('slugs are unique and numbers read in order', () => {
    expect(new Set(CHAPTERS.map((c) => c.slug)).size).toBe(CHAPTERS.length)
    // The prologue is "Prologue"; after it the chapters count up from 01.
    const nums = CHAPTERS.map((c) => c.number).filter((n) => n !== 'Prologue')
    expect(nums).toEqual(nums.map((_, i) => String(i + 1).padStart(2, '0')))
  })

  it('a chapter has a page on disk exactly when it is not planned', () => {
    const disk = new Set(pagesOnDisk(ROOT))
    for (const c of CHAPTERS) {
      expect(disk.has(c.slug), `${c.slug} (${c.status})`).toBe(c.status !== 'planned')
    }
    for (const slug of disk) {
      expect([...SITE_PAGES, ...CHAPTERS.map((c) => c.slug)]).toContain(slug)
    }
  })

  it('every toy a chapter names is in the registry, and every registered toy is named', () => {
    const named = new Set(CHAPTERS.flatMap((c) => c.toys))
    for (const id of named) expect(TOY_LOADERS, id).toHaveProperty(id)
    for (const id of Object.keys(TOY_LOADERS)) expect(named.has(id), id).toBe(true)
  })
})

describe('channels', () => {
  it('a release build leaves drafts and planned chapters out; a preview keeps them', () => {
    expect(visibleChapters('release').every((c) => c.status === 'published')).toBe(true)
    expect(builtChapters('release').every((c) => c.status === 'published')).toBe(true)
    expect(builtChapters('preview').every((c) => c.status !== 'planned')).toBe(true)
    expect(visibleChapters('preview').length).toBe(CHAPTERS.length)
  })

  it('a release build does not emit a draft chapter as an input', () => {
    const release = buildablePages(ROOT, 'release')
    for (const c of CHAPTERS.filter((x) => x.status === 'draft')) {
      expect(release).not.toContain(c.slug)
      expect(buildablePages(ROOT, 'preview')).toContain(c.slug)
    }
    expect(release).toContain('index')
    expect(release).toContain('playground')
  })
})

describe('the live set', () => {
  it('evicts the least recently seen toy that is off screen, past the cap', () => {
    const live = createLiveSet(MAX_LIVE_3D)
    for (const id of ['a', 'b', 'c']) expect(live.admit(id)).toEqual([])
    live.unseen('a')
    live.unseen('b')
    expect(live.admit('d')).toEqual(['a'])
    expect(live.ids()).toEqual(['b', 'c', 'd'])
  })

  it('never evicts a toy that is on screen, even past the cap', () => {
    const live = createLiveSet(2)
    live.admit('a')
    live.admit('b')
    expect(live.admit('c')).toEqual([])
    expect(live.ids().length).toBe(3)
  })
})
