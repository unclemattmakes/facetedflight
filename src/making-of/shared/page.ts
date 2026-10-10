// src/making-of/shared/page.ts: what every page's module script calls. DEV-507.
//
// A chapter page is `startChapter('bugs')`: look the chapter up in the manifest,
// load its toys from the registry, and mount whichever `[data-toy]` elements
// the HTML placed. The playground is `startPlayground()`: every toy in the
// registry, grouped under its chapter.

import { CHAPTERS } from '../chapters'
import { TOY_LOADERS, toysFor } from '../toys/registry'
import { fillChrome } from './chrome'
import { mountToysOnPage } from './toy-host'

export const startChapter = async (slug: string): Promise<void> => {
  fillChrome()
  const chapter = CHAPTERS.find((c) => c.slug === slug)
  if (!chapter) throw new Error(`making-of: no chapter "${slug}" in chapters.ts`)
  mountToysOnPage(await toysFor(chapter.toys))
}

export const startPlayground = async (): Promise<void> => {
  fillChrome()
  const host = document.querySelector<HTMLElement>('#playground')
  if (!host) return
  for (const chapter of CHAPTERS) {
    const ids = chapter.toys.filter((id) => id in TOY_LOADERS)
    if (!ids.length) continue
    const section = document.createElement('section')
    section.className = 'playground-section'
    const h = document.createElement('h2')
    h.textContent = `${chapter.number} · ${chapter.title}`
    section.append(h)
    for (const id of ids) {
      const slot = document.createElement('div')
      slot.dataset.toy = id
      section.append(slot)
    }
    host.append(section)
  }
  mountToysOnPage(await toysFor(Object.keys(TOY_LOADERS)))
}
