/**
 * tests/e2e/fixtures/editor-boot.ts: the way INTO the course editor, and the
 * little things every editor spec does around it.
 *
 * Twenty `editor-*.spec.ts` files each carried the same preamble: a `hold`, a
 * list of page errors, a `goto`, a `bootReady`/`missionReady`, and a 240 s wait
 * on `data-editor="editing"` plus a poll on the desk's ground. This file is
 * that preamble once. It drives the SAME game path the specs drove: two doors
 * a player has, and no switch the game would not have without a test.
 *
 *   `openEditorFromTitle`  the player's door: title, the Custom Courses shelf,
 *                          MAKE A COURSE (the calls the specs made one by one).
 *   `openEditor`           the link's door, `?edit=1` (optionally `mission=` or
 *                          `shipped=`), which is a real URL the game documents.
 *
 * What stays in a spec on purpose:
 *   - the screenshot helper. `tests/unit/e2e-photo-pin-debt.test.ts` finds the
 *     photo specs by the screenshot call in a spec's own text, so a call moved
 *     in here would take its spec out of the ledger. That guard also reads this
 *     file (it names it as a loader that pins the tier), so the page loads in
 *     here stay on the pins.
 *   - each spec's own `desk(page)` probe and its typed shape.
 *   - the shipped desk's readiness (`editor-shipped*.spec.ts`), which is a
 *     different probe (`kind === 'shipped'`): they pass `ground: false`.
 *
 * Nothing from `src/` is imported here, not even a type (see
 * `fixtures/editor-course.ts`: one value edge into `src/` reaching
 * `import.meta.glob` takes the whole Playwright collection to zero).
 */
import { expect, type Page } from '@playwright/test'
import { bootReady, missionReady } from './boot'
import { dropFocus } from './canvas'
import { hold } from './keys'
import { firstPress } from './landing'
import { PINNED } from './quality-pin'
import { pressShelfAction, SHELF_ACTION, titleRowsUp } from './title'

/** The settle after a release in every editor spec: one frame to see the key up, and some. */
export const EDITOR_SETTLE_MS = 150

/**
 * Held, not tapped (`fixtures/keys.ts` says why), with the editor suite's own
 * timing: `ms` down (default 200), then `EDITOR_SETTLE_MS`.
 */
export const editorHold = (page: Page, key: string, ms = 200): Promise<void> =>
  hold(page, key, { down: ms, settle: EDITOR_SETTLE_MS })

/**
 * The messages of every uncaught page exception from now on. Call before
 * `goto`. This is exactly what the specs collected by hand (`pageerror`, the
 * message only); `fixtures/page-errors.ts`'s `watchPageErrors` is the
 * stricter sibling (console errors and 4xx/5xx too) and adopting it is a
 * decision per spec, since a spec may go red on a long-standing 404.
 */
export const collectPageErrors = (page: Page): string[] => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  return errors
}

/** How long the editor may take to say it is `editing`, the longest the specs allowed. */
export const EDITING_TIMEOUT_MS = 240_000

/** How long the desk may take to have its ground to judge against. */
export const GROUND_TIMEOUT_MS = 60_000

/** The body says the editor is up. */
export const expectEditing = (page: Page, timeout = EDITING_TIMEOUT_MS): Promise<void> =>
  expect(page.locator('body')).toHaveAttribute('data-editor', 'editing', { timeout })

/** The desk reports its ground in. A desk that is not up yet reads as not ready. */
export const expectDeskGround = (page: Page, timeout = GROUND_TIMEOUT_MS): Promise<void> =>
  expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = globalThis as unknown as {
            __ff2: { editor(): { desk: { groundReady?: boolean } | null } }
          }
          return w.__ff2.editor().desk?.groundReady === true
        }),
      { timeout },
    )
    .toBe(true)

export interface EditorWait {
  /** Longest wait for `data-editor="editing"`. Default `EDITING_TIMEOUT_MS`. */
  readonly timeout?: number
  /** Also wait for the desk's ground. Default true; the shipped desk has its own probe. */
  readonly ground?: boolean
}

/** The editor is up (and, unless told otherwise, its ground is in). */
export const waitForEditor = async (page: Page, wait: EditorWait = {}): Promise<void> => {
  await expectEditing(page, wait.timeout ?? EDITING_TIMEOUT_MS)
  if (wait.ground !== false) await expectDeskGround(page)
}

export interface EditorLink {
  /** `&mission=<id>`: open the editor over that mission's island. */
  readonly mission?: string
  /** `&shipped=<id>`: open the shipped desk over that mission. */
  readonly shipped?: string
}

/** The `?edit=1` URL, with the pins every photographing spec carries. */
export const editorLinkUrl = (link: EditorLink = {}): string => {
  const mission = link.mission ? `&mission=${link.mission}` : ''
  const shipped = link.shipped ? `&shipped=${link.shipped}` : ''
  return `/?edit=1${mission}${shipped}&xr=off&audio=off&${PINNED}`
}

/** Open the editor by the link's door and wait until it is up. */
export const openEditor = async (
  page: Page,
  link: EditorLink = {},
  wait: EditorWait = {},
): Promise<void> => {
  await page.goto(editorLinkUrl(link))
  await missionReady(page)
  await waitForEditor(page, wait)
}

export interface TitleDoor extends EditorWait {
  /** More query, after the pins, with its leading `&`: `'&island=cone'`. */
  readonly query?: string
}

/**
 * Open the editor by the player's door: the title, the Custom Courses shelf,
 * MAKE A COURSE. The same calls, in the same order, as the specs made.
 */
export const openEditorFromTitle = async (page: Page, door: TitleDoor = {}): Promise<void> => {
  await page.goto(`/?xr=off&audio=off&${PINNED}${door.query ?? ''}`)
  await bootReady(page, 240_000)
  await firstPress(page)
  await dropFocus(page)
  await titleRowsUp(page)
  await pressShelfAction(page, SHELF_ACTION.makeCourse)
  await missionReady(page)
  await waitForEditor(page, door)
}
