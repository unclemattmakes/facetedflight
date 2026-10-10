/**
 * The editor's top-bar menus, opened the way a player opens them. DEV-878.
 *
 * Copy link, Save file, New course and Remix live in the Share menu; the
 * problems pill's popover holds Lift clear of the ground and the run-in's fix;
 * the corner's "?" opens the key table. A spec that needs one of those clicks
 * the trigger, exactly as a person does, and waits for the menu to be there.
 * Nothing here reaches the page any other way: no script, no attribute.
 *
 * Idempotent: a menu left open by an earlier step is not toggled shut.
 */
import { expect, type Page } from '@playwright/test'

/** A trigger's `data-editor` name, and the `data-editor` name of what it opens. */
const MENUS = {
  share: 'share-menu',
  problems: 'problems-pop',
  keys: 'keys-sheet',
} as const

export type EditorMenu = keyof typeof MENUS

/** Open `menu` if it is not open; resolves once it is on screen. */
export const openMenu = async (page: Page, menu: EditorMenu): Promise<void> => {
  const pop = page.locator(`[data-editor="${MENUS[menu]}"]`)
  if (!(await pop.isVisible())) await page.locator(`[data-editor="${menu}"]`).click()
  await expect(pop, `the ${menu} menu is open`).toBeVisible()
}

/**
 * Is `p` (a screen point, CSS px) on the canvas and clear of the editor's
 * chrome: the inspector on the right, the top bar, the tool strip top left and
 * the view corner at the foot? A spec that CLICKS a projected point wants one
 * a person could click: a button standing over it would take the press.
 */
export const clearOfChrome = (
  p: { readonly x: number; readonly y: number },
  view: { readonly width: number; readonly height: number },
): boolean =>
  p.x > 8 &&
  p.x < view.width - 330 &&
  p.y > 56 &&
  p.y < view.height - 56 &&
  !(p.x < 316 && p.y < 120)
