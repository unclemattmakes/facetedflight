/**
 * DEV-501: a draft made BEFORE the anchor, as a returning player's browser
 * holds one — the course's first point free, and no points yet — written into
 * the page's localStorage by the drafts' own writer (`saveDraft`). The desk
 * opens the most recent draft (`desk/index.ts`), so after a reload the spec
 * edits an old-style course by the same path a player with one does.
 *
 * Every draft made since DEV-501 is anchored; a spec about what only a FREE
 * first point can do (DEV-486's run-in turn, which an anchored course cannot
 * raise) starts here. `start` is the pad to stand it on: a spec takes the one
 * the desk's own pad search found for a new draft, since a stored draft is
 * seated where it stands and not searched (the sky's own start on int_01 is
 * over the water's edge).
 */
import type { Page } from '@playwright/test'
import type { Level } from '../../../src/content/level-schema'
import type { PlayerCourseStart } from '../../../src/content/player-course'
import { newDraft } from '../../../src/editor/core/draft'
import { DRAFT_INDEX_KEY, saveDraft } from '../../../src/editor/core/drafts'

export const writeFreeDraft = async (
  page: Page,
  donor: Level,
  start: PlayerCourseStart,
): Promise<void> => {
  const d = newDraft(donor, ['Amber', 'Heron'])
  const free = {
    ...d,
    course: { ...d.course, start, path: { points: [], gap: d.course.path.gap } },
  }
  const mem = new Map<string, string>()
  const ok = saveDraft(
    {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, v),
      removeItem: (k) => void mem.delete(k),
    },
    'dev501free',
    free,
    Date.now(),
  )
  if (!ok) throw new Error('the free draft did not save')
  await page.evaluate(
    ([entries, index]) => {
      // Only this draft is listed, so it is the one the desk opens.
      localStorage.removeItem(index)
      for (const [k, v] of entries) localStorage.setItem(k, v)
    },
    [[...mem], DRAFT_INDEX_KEY] as const,
  )
}
