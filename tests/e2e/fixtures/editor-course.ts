/**
 * Every editor spec's course is FLYABLE. DEV-478.
 *
 * Matt watched DEV-475's e2e fly its course and saw every AI racer dive into a
 * hill: the spec's four points 150 m over int_01 made a Catmull-Rom that sagged
 * through the ground, a ring stood in the rock, and the racers fly the
 * author's line exactly. The editor had said so in its list, and no spec
 * checked that its own course was clean. So each one does, with one of these:
 *
 *   `liftToFlyable(page)`       in the desk: when anything is in or near the
 *                               ground, press LIFT CLEAR OF THE GROUND as a
 *                               person does (a real click on the panel's
 *                               button), then `expectFlyable`.
 *   `expectFlyable(page)`       in the desk: no error, nothing in or near the
 *                               ground, the course valid.
 *   `expectCourseFlyable(page, course, sky)`
 *                               a course built IN CODE and never opened in a
 *                               desk (a link, a file): the same judgement,
 *                               `evaluateDraft`, run IN THE PAGE over the
 *                               ground the GAME built for the island
 *                               (`__ff2.terrain()`, handed to the desk's own
 *                               `deskGround`), once a world stands.
 *
 * "In or near the ground" is the three kinds the lift answers:
 * `ring-in-ground` (an error), `line-under-ground` and `line-near-ground`.
 *
 * NOTHING from `src/` is imported here, not even a type: `deskGround` and the
 * level loader reach `import.meta.env`, and one such edge takes the whole
 * Playwright collection to zero (`tests/unit/e2e-import-graph.test.ts` refused
 * the first draft of this file, which judged in node). The page imports them
 * by URL from the dev server instead, the modules the game itself runs.
 */
import { expect, type Page } from '@playwright/test'
import { openMenu } from './editor-menus'
import type { Ff2Global } from './ff2'

export const GROUND_KINDS: readonly string[] = [
  'ring-in-ground',
  'line-under-ground',
  'line-near-ground',
]

interface FlyableProbe {
  valid: boolean
  warnings: string[]
  errors: string[]
  canLift: boolean
  groundReady: boolean
}

const deskProbe = (page: Page): Promise<FlyableProbe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const d = w.__ff2.editor().desk
    if (!d) throw new Error('the desk has not loaded')
    return d
  }) as Promise<FlyableProbe>

/** The desk's course: no error, nothing in or near the ground, valid. */
export const expectFlyable = async (page: Page, what = 'the course'): Promise<void> => {
  const d = await deskProbe(page)
  expect(d.groundReady, `${what}: the desk has its ground to judge against`).toBe(true)
  expect(d.errors, `${what}: no errors`).toEqual([])
  expect(
    d.warnings.filter((k) => GROUND_KINDS.includes(k)),
    `${what}: nothing in or near the ground`,
  ).toEqual([])
  expect(d.valid, `${what}: valid`).toBe(true)
}

/**
 * A draft that is not a course yet (one point): nothing of it is in or near
 * the ground, and LIFT is off. What a spec that never builds a course can hold.
 */
export const expectNothingInTheGround = async (page: Page, what = 'the draft'): Promise<void> => {
  const d = await deskProbe(page)
  expect(
    d.warnings.filter((k) => GROUND_KINDS.includes(k)),
    `${what}: nothing in or near the ground`,
  ).toEqual([])
  await expect(page.locator('[data-editor="lift"]'), `${what}: nothing to lift`).toBeDisabled()
}

/**
 * Press LIFT CLEAR OF THE GROUND with a real click when the desk has anything
 * in or near the ground (the button is enabled exactly then), and hold the
 * result to `expectFlyable`. Returns whether it pressed: one undo step if so.
 */
export const liftToFlyable = async (page: Page, what = 'the course'): Promise<boolean> => {
  await expect.poll(async () => (await deskProbe(page)).groundReady, { timeout: 60_000 }).toBe(true)
  const button = page.locator('[data-editor="lift"]')
  const before = await deskProbe(page)
  if (!before.canLift) {
    await expect(button, 'nothing to lift: the button is off').toBeDisabled()
    await expectFlyable(page, what)
    return false
  }
  await expect(button).toBeEnabled()
  // DEV-878: the button stands in the problems pill's popover, beside the
  // problem it answers. Open it as a person does, press, and close it again so
  // it does not stand over the view for the spec's next click.
  await openMenu(page, 'problems')
  await button.click()
  await page.locator('[data-editor="problems"]').click()
  await expect(page.locator('[data-editor="problems-pop"]')).toBeHidden()
  await expect.poll(async () => (await deskProbe(page)).canLift, { timeout: 10_000 }).toBe(false)
  await expect(button).toBeDisabled()
  await expectFlyable(page, what)
  return true
}

/**
 * A course built in code, judged as the desk would judge it, IN THE PAGE: the
 * editor core's `evaluateDraft` over `sky` (a shipped mission id, loaded by
 * the game's own loader) and the ground the game built for that island,
 * through the desk's `deskGround`. Call it once a world of that island stands
 * (`__ff2.terrain()` is not null). The racers' pads beside the start are the
 * desk's to lay out, and are judged there, not here.
 */
export const expectCourseFlyable = async (
  page: Page,
  course: unknown,
  sky: string,
  what = 'the course',
): Promise<void> => {
  const judged = await page.evaluate(
    async ([c, id]) => {
      // By URL, from the dev server: the same modules the game runs.
      const coreUrl = '/src/editor/core/index.ts'
      const groundUrl = '/src/editor/desk/ground.ts'
      const loaderUrl = '/src/content/load-level.ts'
      const core = await import(/* @vite-ignore */ coreUrl)
      const desk = await import(/* @vite-ignore */ groundUrl)
      const loader = await import(/* @vite-ignore */ loaderUrl)
      const w = globalThis as unknown as Ff2Global
      const t = w.__ff2.terrain()
      if (!t) return null
      const donor = await loader.loadLevel(id)
      const ground = desk.deskGround({ land: t.terrain, ocean: t.ocean })
      const e = core.evaluateDraft(core.draftFromCourse(c), donor, ground)
      return {
        expands: e.level !== null,
        warnings: (e.warnings as { kind: string; severity: string; message: string }[]).map(
          (x) => ({ kind: x.kind, severity: x.severity, message: x.message }),
        ),
      }
    },
    [course, sky] as const,
  )
  expect(judged, `${what}: a world stands to judge it against`).not.toBeNull()
  const { expands, warnings } = judged as {
    expands: boolean
    warnings: { kind: string; severity: string; message: string }[]
  }
  expect(expands, `${what}: it expands`).toBe(true)
  expect(
    warnings.filter((x) => x.severity === 'error').map((x) => x.message),
    `${what}: no errors`,
  ).toEqual([])
  expect(
    warnings.filter((x) => GROUND_KINDS.includes(x.kind)).map((x) => x.message),
    `${what}: nothing in or near the ground`,
  ).toEqual([])
}
