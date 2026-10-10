// src/editor/desk/shipped-door.ts — "Shipped missions (dev)" in the player
// desk's panel. DEV-540 (plan/SHIPPED-COURSE-EDITS.md §4.3).
//
// The other way in to `shipped.ts` beside `?edit=1&shipped=<id>`: the HoverJet
// missions 2016 shipped, in a list in the course editor's Share menu (DEV-878; it was the panel's foot),
// and an Open that reloads the page on that mission's desk (the player's
// draft is saved first). A reload rather than a swap in place because the
// shipped desk is a different desk over a different world, and the page's
// own boot already builds both.
//
// **`pnpm dev` only.** `desk/index.ts` reaches this module only through an
// `import()` inside `if (import.meta.env.DEV)`, which a production build folds
// away with the chunk (`tests/unit/editor-shipped-door.test.ts`). Players never
// see it: a player has no repo to write an override into.

import { generatedLevelIds, loadBaselineLevel } from '@/content/load-level'
import { isShippedEditable } from '@/editor/core'
import { shippedUrl } from './shipped'

/** Append the list to `panel`; `before` runs before the page leaves (the player's draft, saved). */
export const mountShippedDoor = async (panel: HTMLElement, before: () => void): Promise<void> => {
  const missions: { id: string; title: string }[] = []
  for (const id of generatedLevelIds()) {
    const level = await loadBaselineLevel(id)
    if (isShippedEditable(level)) missions.push({ id, title: level.title })
  }
  const group = document.createElement('div')
  group.className = 'group'
  group.dataset.editor = 'shipped-door'
  const head = document.createElement('div')
  head.className = 'head'
  head.textContent = 'Shipped missions (dev)'
  const row = document.createElement('div')
  row.className = 'row'
  const select = document.createElement('select')
  select.dataset.editor = 'shipped-door-mission'
  select.title = 'A mission 2016 shipped, to edit its override (content/overrides/). pnpm dev only.'
  for (const m of missions) {
    const option = document.createElement('option')
    option.value = m.id
    option.textContent = `${m.title} · ${m.id}`
    select.append(option)
  }
  const open = document.createElement('button')
  open.type = 'button'
  open.textContent = 'Open'
  open.dataset.editor = 'shipped-door-open'
  open.title = 'Open that mission in the shipped-mission editor. Your course is saved first.'
  open.addEventListener('click', () => {
    if (!select.value) return
    before()
    location.assign(shippedUrl(select.value))
  })
  row.append(select, open)
  group.append(head, row)
  panel.append(group)
}
