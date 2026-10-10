/**
 * The draft shelf. DEV-889 (docs/plan/PLAYTEST-AGENTS-2026-10-09.md, finding 10).
 *
 * The agent playtest built five courses on five islands and could reach one:
 * the others were in this browser and in no list, and Back to hangar said
 * nothing. Now the Share menu lists the last drafts, newest first, named by
 * course, island and time, and starting another course asks first when the
 * shelf is full and the oldest would go.
 *
 * Driven as a person drives it: the Share menu, the Drafts list, New course,
 * the question's buttons. The shelf is filled the one way a spec can without
 * five sessions of clicking: copies of the draft the editor itself wrote, kept
 * under other slots before a reload (the storage the game reads, nothing
 * switched in the build).
 *
 * Tagged `@gpu`; the tier is pinned (`PINNED`, by `openEditor`).
 */

import { collectPageErrors, openEditor } from './fixtures/editor-boot'
import { openMenu } from './fixtures/editor-menus'
import type { Ff2Global } from './fixtures/ff2'
import { expect, type Page, test } from './fixtures/test'

const INDEX = 'ff2.editor.drafts.v1'
const slotOf = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const d = w.__ff2.editor().desk
    if (!d) throw new Error('the desk has not loaded')
    return (d as { slot: string }).slot
  })

test.describe('@gpu the draft shelf (DEV-889)', () => {
  test('lists the other drafts, opens one, and asks before the oldest is pushed off', async ({
    page,
  }) => {
    test.setTimeout(420_000)
    const errors = collectPageErrors(page)
    await openEditor(page)
    // One edit, so the editor writes its draft; then five copies of it, as five
    // courses, each with a second point so none is a blank draft.
    await page.locator('[data-editor="reroll"]').click()
    await expect
      .poll(() => page.evaluate((k) => localStorage.getItem(k), INDEX), { timeout: 15_000 })
      .not.toBeNull()
    await page.evaluate((index) => {
      const list = JSON.parse(localStorage.getItem(index) as string) as { slot: string }[]
      const first = list[0] as { slot: string }
      const raw = JSON.parse(localStorage.getItem(`ff2.editor.draft.v1.${first.slot}`) as string)
      const p0 = raw.course.path.points[0] ?? [0, 100, 0]
      raw.course.path.points = [p0, [p0[0] + 120, p0[1], p0[2] + 120]]
      localStorage.removeItem(`ff2.editor.draft.v1.${first.slot}`)
      const now = Date.now()
      const seeded = [0, 1, 2, 3, 4].map((k) => {
        const slot = `shelf${k}`
        localStorage.setItem(`ff2.editor.draft.v1.${slot}`, JSON.stringify(raw))
        return {
          ...first,
          slot,
          updated: now + 60_000 - k * 3_600_000,
          points: 2,
        }
      })
      localStorage.setItem(index, JSON.stringify(seeded))
    }, INDEX)
    await openEditor(page)
    // The newest of the five is the one reopened; the other four are the shelf.
    expect(await slotOf(page)).toBe('shelf0')
    await openMenu(page, 'share')
    const drafts = page.locator('[data-editor="drafts"]')
    await expect(drafts.locator('option')).toHaveCount(5) // the prompt and four drafts
    const oldest = (await drafts.locator('option').last().textContent()) as string
    expect(oldest).toContain(' · ')

    // New course: the shelf is full, so it asks and names the draft it would drop.
    await page.locator('[data-editor="new"]').click()
    const ask = page.locator('[data-editor="leave-dialog"]')
    await expect(ask).toBeVisible()
    await expect(ask).toHaveAttribute('data-kind', 'shelf')
    await expect(ask).toContainText(oldest)
    // Keep editing: nothing changed.
    await page.locator('[data-editor="leave-stay"]').click()
    await expect(ask).toHaveCount(0)
    expect(await slotOf(page)).toBe('shelf0')

    // Open another draft from the shelf: it never asks (the shelf does not grow).
    await openMenu(page, 'share')
    await drafts.selectOption('shelf2')
    await expect.poll(() => slotOf(page), { timeout: 30_000 }).toBe('shelf2')
    await expect(ask).toHaveCount(0)

    // New course, "Start anyway": a new draft, and the oldest is off the shelf.
    await openMenu(page, 'share')
    await page.locator('[data-editor="new"]').click()
    await expect(ask).toBeVisible()
    await page.locator('[data-editor="leave-anyway"]').click()
    await expect.poll(() => slotOf(page), { timeout: 30_000 }).not.toBe('shelf2')
    await expect
      .poll(
        () => page.evaluate((k) => localStorage.getItem(`ff2.editor.draft.v1.${k}`), 'shelf4'),
        { timeout: 15_000 },
      )
      .toBeNull()
    expect(errors, 'no page errors').toEqual([])
  })
})
