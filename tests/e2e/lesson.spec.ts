/**
 * A lesson runs, and flying moves it on. DEV-377.
 *
 * `docs/plan/FLIGHT-INSTRUCTOR.md` §9: boot a lesson, read step 0 off the
 * plate, press launch, read step 1, and find an instructor on `__ff2` — the
 * app wiring no unit test can see. This spec goes one step further, because
 * the launch is a press and the brief asks for flying: it holds the throttle
 * through the ride and the countdown until the throttle step's own trigger
 * ends it, and reads the plate change a second time.
 *
 * It asserts the PLATE'S TEXT — what a player reads — through `__ff2.lesson()`,
 * which reports what `render/lesson-plate.ts` was last handed and whether it is
 * up, alongside the step machine's own step. Each text is also compared with
 * the one before it, so a plate that never redrew is red even if the step
 * moved underneath it.
 *
 * ── The fixture, and the route ──────────────────────────────────────────
 *
 * `content/authored/dev377_lesson_fixture.json` is `int_01_hoverJet` with a
 * four-step lesson on it: Simonet is the world every spec already loads, and
 * the canyon courses are DEV-378's. It is NOT listed, so it is on no menu — and
 * that is why this boots `?mission=` rather than walking the title and the
 * hangar (AGENT-NOTES §8). The player's route into a lesson is DEV-379's front
 * door, which does not exist yet; that row's `learn-to-fly.spec.ts` is where
 * the route spec belongs. What this one does take is the path a player's
 * mission takes once they are in it: the lift ride (the lesson KEEPS it, call
 * 3), the countdown and the release, with no `ride=0`.
 *
 * Photographs from the seat, flat, pinned (`PINNED`), of the plate on each of
 * the three steps, into `LESSON_PHOTO_DIR` (default `test-results/lesson`).
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/lesson.spec.ts
 *
 * Tagged `@gpu`.
 */
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { pausePlateState, pressPauseRow } from './fixtures/pause-menu'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const FIXTURE = 'dev377_lesson_fixture'
const PHOTOS = process.env.LESSON_PHOTO_DIR ?? path.join('test-results', 'lesson')

interface Probe {
  readonly step: number
  readonly stepId: string | null
  readonly interrupt: string | null
  readonly plate: { readonly key: string; readonly title: string; readonly text: string } | null
  readonly plateVisible: boolean
  readonly student: { readonly arc: number; readonly speed: number; readonly held: boolean }
  readonly instructor: {
    readonly id: string
    readonly mode: string
    readonly gap: number
    readonly settled: boolean
    readonly speed: number
    readonly thrust: number
    readonly rollRate: number
  }
}

/** `__ff2.lesson()`: the step, the plate and the instructor, or null with no lesson. */
const lesson = (page: Page): Promise<Probe | null> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __ff2?: { lesson?: () => Probe | null } }).__ff2?.lesson?.() ??
      null,
  )

/** Is the named object in the scene, and drawn? */
const drawn = (page: Page, name: string): Promise<boolean> =>
  page.evaluate((n) => {
    let seen = false
    ;(
      globalThis as unknown as {
        __ff2?: {
          render: {
            scene: {
              traverse: (
                f: (o: { name?: string; visible?: boolean; parent?: unknown }) => void,
              ) => void
            }
          }
        }
      }
    ).__ff2?.render.scene.traverse((o) => {
      if (o.name === n) seen = o.visible === true
    })
    return seen
  }, name)

/** Wait for the plate to settle on a step, then return what it says. */
const plateOn = async (page: Page, stepId: string, timeout: number): Promise<Probe> => {
  await expect
    .poll(async () => (await lesson(page))?.plate?.key ?? null, { timeout, intervals: [250] })
    .toBe(stepId)
  // The cross-fade is 0.3 s; a photograph taken inside it is of two prompts.
  await page.waitForTimeout(600)
  return (await lesson(page)) as Probe
}

/** A key held across frames: every confirm here is a LEVEL read once a frame. */
const holdKey = (page: Page, key: string, settle = 400): Promise<void> =>
  keysHold(page, key, { down: 200, settle })

/**
 * Pause, then press the row named `id`. The fixture reads the live selection
 * and computes the walk, so nothing here assumes the plate opens on row 0.
 * (`fixtures/pause-menu.ts` takes its row ids as literals for the same reason
 * this file once did: an import edge into `src/` zeroes the e2e collection.)
 */
const pauseAndPress = async (page: Page, id: string): Promise<void> => {
  await holdKey(page, 'Backspace')
  await pressPauseRow(page, id, 400)
}

test.describe('@gpu the lesson runner (DEV-377)', () => {
  test.setTimeout(420_000)

  test('boots a lesson, and flying moves the plate on two steps', async ({ page }) => {
    const problems = watchPageErrors(page)
    await page.goto(`/?mission=${FIXTURE}&xr=off&menu=0&${PINNED}`)
    await firstPress(page)
    await missionReady(page, 240_000)
    await focusCanvas(page)
    await page.waitForTimeout(1_500)
    const pinned = await drawState(page)
    console.log(`lesson: ${drawStateLine(pinned)}`)

    // ── step 0, on the pad ────────────────────────────────────────────────
    const s0 = await plateOn(page, 'launch', 30_000)
    expect(s0.stepId).toBe('launch')
    expect(s0.plateVisible, 'the plate is up on the pad').toBe(true)
    expect(s0.plate?.title).toBe('1 · LAUNCH')
    // The device's word for the launch; which device is the harness's, so
    // this asserts the sentence around it and that the brace is gone.
    expect(s0.plate?.text).toMatch(/^Press \S+ to launch\. I'll be waiting at the top\.$/)
    // One plate: the lesson's replaces the briefing.
    expect(await drawn(page, 'briefing'), 'the briefing is down while a lesson runs').toBe(false)
    expect(await drawn(page, 'lesson-plate'), 'the lesson plate is drawn').toBe(true)
    // The instructor exists, and waits: the student is on the pad.
    expect(s0.instructor.id).toBeTruthy()
    expect(s0.instructor.mode).toBe('hold')
    expect(s0.student.held).toBe(true)
    await page.screenshot({ path: path.join(PHOTOS, `step0-launch-seat-${PINNED}.png`) })

    // ── the launch press: step 1, on the ride ─────────────────────────────
    await page.keyboard.down('Enter')
    await page.waitForTimeout(250)
    await page.keyboard.up('Enter')
    const s1 = await plateOn(page, 'throttle', 10_000)
    expect(s1.plate?.title).toBe('2 · THROTTLE')
    // Enter was the last device: the keyboard's word.
    expect(s1.plate?.text).toBe(
      'Hold Space to fly. The ship goes where the nose points. Follow me.',
    )
    expect(s1.plate?.text).not.toBe(s0.plate?.text)
    await page.screenshot({ path: path.join(PHOTOS, `step1-throttle-seat-${PINNED}.png`) })

    // ── flying: hold the throttle until the step's own trigger ends it ─────
    // Through the rest of the ride and the countdown: the throttle does
    // nothing until the release, and the step is 30 m/s for half a second.
    await page.keyboard.down('Space')
    const s2 = await plateOn(page, 'climb', 90_000)
    await page.keyboard.up('Space')
    expect(s2.plate?.title).toBe('3 · CLIMB')
    // `{speed}` is the dash's own string: `km/h` on Anniversary, bare on Classic.
    expect(s2.plate?.text).toMatch(
      /^S to climb, W to dive\. Through ring \d+\. SPEED \d+( km\/h)?$/,
    )
    expect(s2.plate?.text).not.toBe(s1.plate?.text)
    // The student was flying at the step's speed when it ended.
    expect(s2.student.speed).toBeGreaterThan(25)
    expect(s2.student.held).toBe(false)
    await page.screenshot({ path: path.join(PHOTOS, `step2-climb-seat-${PINNED}.png`) })
    const after = await drawState(page)
    expect(drawStateDiff(pinned, after), 'the tier held across the photographs').toEqual([])
    // No console error, no uncaught exception, no failed load, all the way through.
    expect(problems.list()).toEqual([])
    console.log(
      `lesson: step0 "${s0.plate?.text}" · step1 "${s1.plate?.text}" · step2 "${s2.plate?.text}"` +
        ` · instructor ${s2.instructor.mode} gap ${s2.instructor.gap.toFixed(0)} m` +
        ` at ${s2.instructor.speed.toFixed(1)} m/s`,
    )
  })

  test("the instructor flies the player's variant (DEV-382 follow-up)", async ({ page }) => {
    // The instructor is a racer, and racers fly your variant. `?variant=speed`
    // is the development switch for the machine the hangar would have handed
    // the flight; the instructor must be built from the same view, which the
    // flight's own jet (`__ff2.flight()`) and the lesson's probe both report.
    // Red with `boot/app.ts` building the lesson without the player's sheet:
    // the instructor flies 2016's 437.5 N against the player's 525.
    await page.goto(`/?mission=${FIXTURE}&variant=speed&xr=off&menu=0&${PINNED}`)
    await firstPress(page)
    await missionReady(page, 240_000)
    const machines = await page.evaluate(() => {
      const ff = (
        globalThis as unknown as {
          __ff2: {
            flight: () => {
              variant: string
              jet: { tuning: { maxSpeed: number; rollRate: number } }
            }
            lesson: () => { instructor: { thrust: number; rollRate: number } } | null
          }
        }
      ).__ff2
      const f = ff.flight()
      const l = ff.lesson()
      return {
        variant: f.variant,
        player: { thrust: f.jet.tuning.maxSpeed, rollRate: f.jet.tuning.rollRate },
        instructor: l ? { thrust: l.instructor.thrust, rollRate: l.instructor.rollRate } : null,
      }
    })
    console.log(`lesson on the speed jet: ${JSON.stringify(machines)}`)
    expect(machines.variant, 'the premise: the player flies the speed jet').toBe('speed')
    expect(machines.player.thrust, 'the premise: a view, not 2016').not.toBe(437.5)
    expect(machines.instructor, 'the lesson is up').not.toBeNull()
    expect(machines.instructor?.thrust).toBe(machines.player.thrust)
    expect(machines.instructor?.rollRate).toBe(machines.player.rollRate)
  })

  test('the pause menu skips a step, and Restart puts the lesson back at the start', async ({
    page,
  }) => {
    const problems = watchPageErrors(page)
    await page.goto(`/?mission=${FIXTURE}&xr=off&menu=0&${PINNED}`)
    await firstPress(page)
    await missionReady(page, 240_000)
    await focusCanvas(page)
    await page.waitForTimeout(1_500)
    await plateOn(page, 'launch', 30_000)
    await holdKey(page, 'Enter')
    const s1 = await plateOn(page, 'throttle', 10_000)

    // ── SKIP STEP, the way a player stuck on a step would ─────────────────
    await holdKey(page, 'Backspace')
    expect((await lesson(page))?.plateVisible, 'the lesson plate is down under the menu').toBe(
      false,
    )
    await holdKey(page, 'Backspace')
    await pauseAndPress(page, 'skipstep')
    expect((await pausePlateState(page)).open, 'back in the run').toBe(false)
    const skipped = await plateOn(page, 'climb', 10_000)
    expect(skipped.plate?.text).not.toBe(s1.plate?.text)
    expect(skipped.plateVisible).toBe(true)

    // ── RESTART: step 0 again, and the instructor back where it waits ─────
    await pauseAndPress(page, 'restart')
    const again = await plateOn(page, 'launch', 10_000)
    expect(again.step).toBe(0)
    expect(again.instructor.mode).toBe('hold')
    expect(again.student.held).toBe(true)
    expect(problems.list()).toEqual([])
  })
})
