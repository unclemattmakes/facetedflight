/**
 * The two canyon lessons, flown in the running game, every step's plate read
 * and photographed from the seat. DEV-378.
 *
 * `docs/plan/FLIGHT-INSTRUCTOR.md` §9: the golden lessons fly both courses
 * headless (`tests/unit/lesson-canyon.test.ts`); this is the other half — the
 * app wiring, the plate and the tokens, on the path a player's run takes once
 * they are in the mission: lesson 1 keeps the lift ride (§11 call 3, no
 * `ride=0`), lesson 2 starts in the air.
 *
 * ── How it gets through ten steps without a pilot ────────────────────────
 *
 * The spec presses the launch (Enter: so the keyboard is the last device and
 * the plate speaks its words), then hands the stick to the autopilot (P), the
 * player's own, and reads each plate as the lesson's own triggers bring it up.
 * The one step the autopilot does not perform is lesson 1's bank — it banks
 * INTO turns and never lets go on purpose — so that step is photographed and
 * then passed with the pause menu's *Skip step*, the way a stuck player would
 * (plan §7). Every other step ends on its trigger.
 *
 * Each plate is asserted on what a player reads: the title (`N · TITLE`), the
 * prompt with every `{token}` resolved (no brace survives; `{target}` is the
 * step's own speed in the dash's unit, DEV-378), and a change from the plate
 * before. `__ff2.lesson()` reports what the plate was last handed.
 *
 * Photographs from the seat, flat, pinned (`PINNED`), one per step, into
 * `LESSON_CANYON_PHOTO_DIR` (default `test-results/lesson-canyon`).
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/lesson-canyon.spec.ts
 *
 * Tagged `@gpu`.
 */

import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { hold as keysHold } from './fixtures/keys'
import { knownRed } from './fixtures/known-red'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { pressPauseRow } from './fixtures/pause-menu'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const PHOTOS = process.env.LESSON_CANYON_PHOTO_DIR ?? path.join('test-results', 'lesson-canyon')

interface Probe {
  readonly step: number
  readonly steps: number
  readonly stepId: string | null
  readonly interrupt: string | null
  readonly done: boolean
  readonly plate: { readonly key: string; readonly title: string; readonly text: string } | null
  readonly plateVisible: boolean
  readonly student: { readonly arc: number; readonly speed: number; readonly held: boolean }
  readonly instructor: { readonly id: string; readonly mode: string; readonly gap: number }
}

const lesson = (page: Page): Promise<Probe | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.lesson?.() ?? null)

/**
 * Wait for the plate to show step `id`, let the 0.3 s cross-fade finish, and
 * return what it says. Polled finely: a step the autopilot ends in a second
 * (a speed already reached) is still up long enough to read and photograph.
 */
const plateOn = async (page: Page, id: string, timeout: number): Promise<Probe> => {
  await expect
    .poll(async () => (await lesson(page))?.plate?.key ?? null, { timeout, intervals: [50] })
    .toBe(id)
  await page.waitForTimeout(350)
  return (await lesson(page)) as Probe
}

const holdKey = (page: Page, key: string, settle = 300): Promise<void> =>
  keysHold(page, key, { down: 150, settle })

/** Pause, then press the row named `id`; the fixture computes the walk from the live selection. */
const pauseAndPress = async (page: Page, id: string): Promise<void> => {
  await holdKey(page, 'Backspace')
  await pressPauseRow(page, id, 300)
}

/**
 * Whether the autopilot is flying, off its own console lines (`autopilot ON`,
 * `autopilot off — you took the stick`). The pause menu is walked with the
 * arrow keys, which are the keyboard's pitch, and grabbing the stick stands
 * the autopilot down, exactly as it would for a player: so after *Skip step*
 * the spec hands it the stick again, with the key a player would press.
 */
const trackAutopilot = (page: Page): { on: boolean } => {
  const pilot = { on: false }
  page.on('console', (m) => {
    const text = m.text()
    if (text.startsWith('autopilot ON')) pilot.on = true
    else if (text.startsWith('autopilot off')) pilot.on = false
  })
  return pilot
}

/** One step as the plate must read it: its title and a prompt pattern, in the keyboard's words. */
interface Expect {
  readonly id: string
  readonly title: string
  readonly text: RegExp
  /** Pass it with *Skip step* once photographed: the autopilot does not perform it. */
  readonly skip?: boolean
}

/** `{speed}` / `{target}` as the dash prints them: km/h on Anniversary, bare m/s on Classic. */
const SPEED = String.raw`\d+( km/h)?`

const LESSON_1: readonly Expect[] = [
  {
    id: 'launch',
    title: '1 · LAUNCH',
    text: /^Press \S+ to launch\. Ride the lift up: I'll be waiting at the top\.$/,
  },
  {
    id: 'throttle',
    title: '2 · THROTTLE',
    // `{target}` is the step's own 50 m/s: 180 km/h, or 50 on Classic.
    text: new RegExp(
      String.raw`^Hold Space to fly\. The ship goes where its nose points\. Follow me up to (180 km/h|50)\. SPEED ${SPEED}$`,
    ),
  },
  {
    id: 'climb',
    title: '3 · CLIMB',
    text: /^S to climb, W to dive\. Climb with me through ring \d+\.$/,
  },
  {
    id: 'thread',
    title: '4 · THREAD THE RINGS',
    text: /^Aim for the middle of each ring and fly straight through it\. Next: ring \d+\.$/,
  },
  {
    id: 'bank',
    title: '5 · THE BANK STAYS',
    text: /^Roll with A \/ D, then let go: it stays banked\. This ship never levels itself\. Roll back to level and hold it\.$/,
    skip: true,
  },
  {
    id: 'turning',
    title: '6 · TURNING',
    text: /^W\/S Q\/E nudges the nose\. For a real turn, roll onto your side, then S: it comes round faster\.$/,
  },
  {
    id: 'boost',
    title: '7 · BOOST',
    text: new RegExp(
      String.raw`^A straight\. Hold Z with Space and get past (432 km/h|120)\. SPEED ${SPEED}$`,
    ),
  },
  {
    id: 'corner',
    title: '8 · A CORNER AT SPEED',
    text: /^Two hard corners\. Let go of Z, tap C to shed speed, then roll and pull round\.$/,
  },
  {
    id: 'canyon',
    title: '9 · INTO THE CANYON',
    text: /^W and follow me down between the walls\. Watch the ground come up\.$/,
  },
  { id: 'home', title: '10 · ON YOUR OWN', text: /^You have it\. Race me to the finish!$/ },
]

const LESSON_2: readonly Expect[] = [
  {
    id: 'in',
    title: '1 · THE CANYON',
    text: /^This is the canyon proper\. Hold Space and follow me in\. Stay between the walls\.$/,
  },
  {
    id: 'corner',
    title: '2 · A HARD CORNER',
    text: /^Tap C early, roll onto your side and pull round with me\. Through ring \d+\.$/,
  },
  {
    id: 'esses',
    title: '3 · ONE, THEN THE OTHER',
    text: /^Two turns back to back\. Roll, pull, and roll level between them\.$/,
  },
  {
    id: 'hairpin',
    title: '4 · THE HAIRPIN',
    text: /^The tightest turn in the canyon\. Slow right down with C, then roll and pull hard\.$/,
  },
  {
    id: 'straight',
    title: '5 · OPEN IT UP',
    text: new RegExp(
      String.raw`^A straight between the walls\. Hold Z with Space and get past (360 km/h|100)\. SPEED ${SPEED}$`,
    ),
  },
  {
    id: 'last',
    title: '6 · THE LAST HARD TURNS',
    text: /^Let go of Z and tap C\. Two more hard turns, then we're out\.$/,
  },
  { id: 'home', title: '7 · RACE ME OUT', text: /^Out of the canyon\. Race me to the finish!$/ },
]

/**
 * Fly `steps` of the lesson that is up: read each plate as it comes, photograph
 * it, skip the ones the autopilot cannot perform, and return what each said.
 */
const walk = async (
  page: Page,
  course: string,
  steps: readonly Expect[],
  from: number,
  pilot: { on: boolean } | null = null,
): Promise<Probe[]> => {
  const seen: Probe[] = []
  let before = ''
  for (let i = from; i < steps.length; i++) {
    const want = steps[i] as Expect
    const p = await plateOn(page, want.id, 120_000)
    expect(p.plateVisible, `${want.id}: the plate is up`).toBe(true)
    expect(p.plate?.title).toBe(want.title)
    expect(p.plate?.text, `${want.id}: no brace survives`).not.toMatch(/[{}]/)
    expect(p.plate?.text).toMatch(want.text)
    expect(p.plate?.text, `${want.id}: the plate redrew`).not.toBe(before)
    before = p.plate?.text ?? ''
    await page.screenshot({
      path: path.join(PHOTOS, `${course}-step${i}-${want.id}-seat-${PINNED}.png`),
    })
    seen.push(p)
    // Only while it is still up: a step that ended on its own meanwhile must
    // not cost the next one its plate.
    if (want.skip && (await lesson(page))?.stepId === want.id) {
      await pauseAndPress(page, 'skipstep')
      if (pilot && !pilot.on) {
        await holdKey(page, 'KeyP')
        await expect.poll(() => pilot.on, { timeout: 5_000 }).toBe(true)
      }
    }
  }
  return seen
}

test.describe('@gpu the canyon lessons (DEV-378)', () => {
  test.setTimeout(600_000)

  test('lesson 1, First Flight: the pad, the lift, and every plate to the finish', async ({
    page,
  }) => {
    knownRed('KR-03')
    const problems = watchPageErrors(page)
    await page.goto(`/?mission=lesson_01_canyon&xr=off&menu=0&${PINNED}`)
    await firstPress(page)
    await missionReady(page, 240_000)
    await focusCanvas(page)
    await page.waitForTimeout(1_500)
    const pinned = await drawState(page)
    console.log(`lesson 1: ${drawStateLine(pinned)}`)

    // Step 0 on the pad: the instructor exists and waits at the top.
    const s0 = (await walk(page, 'lesson_01_canyon', LESSON_1.slice(0, 1), 0))[0] as Probe
    expect(s0.instructor.id).toBeTruthy()
    expect(s0.instructor.mode).toBe('hold')
    expect(s0.student.held).toBe(true)

    // The launch press, the keyboard's: step 1 comes up on the ride.
    await holdKey(page, 'Enter')
    const [s1] = await walk(page, 'lesson_01_canyon', LESSON_1.slice(0, 2), 1)
    expect(s1?.student.held, 'on the lift').toBe(true)

    // The player's autopilot takes the stick for the rest.
    const pilot = trackAutopilot(page)
    await holdKey(page, 'KeyP')
    await expect.poll(() => pilot.on, { timeout: 5_000 }).toBe(true)
    const rest = await walk(page, 'lesson_01_canyon', LESSON_1, 2, pilot)
    expect(rest.length).toBe(LESSON_1.length - 2)

    // The finish ends the lesson.
    await expect
      .poll(async () => (await lesson(page))?.done ?? false, { timeout: 120_000, intervals: [250] })
      .toBe(true)
    expect(drawStateDiff(pinned, await drawState(page)), 'the tier held').toEqual([])
    expect(problems.list()).toEqual([])
  })

  test('lesson 2, Canyon Run: an airborne start, and every plate to the finish', async ({
    page,
  }) => {
    const problems = watchPageErrors(page)
    await page.goto(`/?mission=lesson_02_canyon_run&xr=off&menu=0&${PINNED}`)
    await firstPress(page)
    await missionReady(page, 240_000)
    await focusCanvas(page)
    const pinned = await drawState(page)
    console.log(`lesson 2: ${drawStateLine(pinned)}`)

    // A direct spawn: no lift, so the first step is up and the student is
    // flying — at rest, in the air, between the walls. A tap of the throttle
    // makes the keyboard the device whose words the plate speaks (P alone is
    // not a flight key); then the autopilot takes the stick.
    await holdKey(page, 'Space')
    await holdKey(page, 'KeyP')
    const seen = await walk(page, 'lesson_02_canyon_run', LESSON_2, 0)
    expect(seen.length).toBe(LESSON_2.length)
    expect(seen[0]?.student.held, 'no lift to hold it').toBe(false)

    await expect
      .poll(async () => (await lesson(page))?.done ?? false, { timeout: 120_000, intervals: [250] })
      .toBe(true)
    expect(drawStateDiff(pinned, await drawState(page)), 'the tier held').toEqual([])
    expect(problems.list()).toEqual([])
  })
})
