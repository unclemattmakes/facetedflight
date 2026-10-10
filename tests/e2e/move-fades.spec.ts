/**
 * Every large camera move passes through black, over 2016's own fade. DEV-427.
 *
 * Matt, 2026-09-26: *"should fade in/out when making large camera moves
 * (title-screen to hangar. hangar to elevator, mission to hangar, first to
 * third, third to first)"*.
 *
 * ── What this found before anything was changed ──────────────────────────
 *
 * The first version of this file only recorded, and on `72b6314` it printed
 * this (Anniversary, the 180 Hz desk, 18:39, lease held):
 *
 *     title->hangar      out 53 frames / 827 ms · black 2 · in 52 frames / 298 ms
 *     hangar->loading    out  9 frames / 525 ms · black 2 · in 31 frames / 368 ms
 *     loading->mission   out 32 frames / 446 ms · black 2 · in 143 frames / 849 ms
 *     first->third       out 18 frames / 112 ms · black 2 · in 37 frames / 212 ms
 *     third->first       out 18 frames / 106 ms · black 2 · in 38 frames / 216 ms
 *     mission->hangar    out 53 frames / 303 ms · black 2 · in 50 frames / 297 ms
 *
 * Every move reached solid black and every picture change landed on a black
 * frame: DEV-107 had put all of them through `goToScreen`'s curtain already.
 * What Matt did not see was a FADE — about 0.3 s each way on the port's own
 * `CUT_FADE_SECONDS`, and a camera switch with two frames of black in it where
 * 2016's `CamChanger` waits 0.2 s from the trigger. (The title's 827 ms out is
 * one 536 ms frame: the hangar's first draw, on the black frame, where it is
 * invisible.)
 *
 * The first CLASSIC run found one more: its title fade-out was 4 frames over
 * 1,441 ms with a 782 ms frame inside the ramp. The title wears Anniversary
 * whatever was chosen (DEV-405), and the chosen edition was `set` the moment
 * its fetch landed, a few frames into the fade: the valley re-lit as Classic
 * in plain view and recompiled there. So the on-screen key below carries the
 * edition, and "changed only under the curtain" covers it. Since DEV-451 the
 * flips are elsewhere — every menu wears Anniversary, and a Classic run puts
 * Classic on at the black into the loading scene and takes it off at the
 * black back into the hangar — and the same key holds them to black. Since
 * DEV-465 an Anniversary run waits its load out in the room, with no black
 * until the pad's, and the key reads the loading SCENE (its dome) rather than
 * the plate, which stands in the room in plain view on purpose.
 *
 * ── What it asserts ──────────────────────────────────────────────────────
 *
 * Per move, from frames recorded in the page on every animation frame:
 *
 *   1. the curtain reached solid black;
 *   2. what is on screen changed ONLY on black frames — the move is behind it;
 *   3. each leg took AT LEAST 2016's number for the screen it is drawn on
 *      (`FADE.menuSeconds`, `FADE.missionSeconds`, to the `solidAtFraction`
 *      clamp), and the camera switch's fade-in began no sooner than 2016's
 *      `WaitForSeconds(0.2f)` after its fade-out did.
 *
 * Lower bounds on purpose. The fade runs on render time, so a starved box can
 * only make a leg LONGER; a bound from below is true on any machine, where a
 * two-sided one would be a claim about this one. With one exception it had
 * to be built around: the frame that MAKES the black carries the swap and the
 * new screen's first draw, so a leg is measured to its last ramp frame, or a
 * slow first draw would pad a short fade past the bound (it did, on the base).
 *
 * The numbers come off the sheet, never off `render/fade.ts`'s rule: a spec
 * that asked the code which duration to expect would pass whatever the code
 * said (trap 24). Both editions, because a fade in a headset is comfort.
 */

import { FADE } from '@/generated/constants.generated'
import { bootReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { board, hold, INT_01_HOVERJET } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { expect, type Page, test } from './fixtures/test'
import { aimTitleRow, TITLE_ROW } from './fixtures/title'

const PIN = 'xr=off&adaptive=0&quality=high'

/** One animation frame, as the page drew it. */
interface MoveFrame {
  /** `performance.now()` at the sample, ms. */
  t: number
  /** The fade's amount, 0..1: `__ff2.fade().amount`. */
  a: number
  /** What is on screen, as a key: the edition, the stage, the title's rows, the loading scene, the chase view. */
  id: string
}

/**
 * Record every animation frame: the curtain and what is behind it.
 *
 * Per frame and in the page, because a black that lasts two frames at 180 Hz
 * is 11 ms, which a poll from outside steps over. The game's own frame
 * callback runs ahead of this one in every frame (`quick-race.spec.ts`), so
 * each sample describes the frame just drawn.
 */
const record = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    type Named = { visible: boolean; getObjectByName?: (n: string) => Named | undefined }
    type Stage = { name?: string; getObjectByName: (n: string) => Named | undefined }
    const w = globalThis as unknown as {
      __ff2?: {
        stage: () => Stage
        fade: () => { amount: number }
        titleMenu?: () => { up: boolean }
        thirdPerson: () => { live: boolean }
        edition: { current: { id: string } }
      }
      __mvFrames?: unknown[]
      __mvStop?: boolean
    }
    const frames: unknown[] = []
    w.__mvFrames = frames
    w.__mvStop = false
    const sample = (): void => {
      const app = w.__ff2
      if (!app) return
      const stage = app.stage()
      // The loading SCENE — a place the player is moved to, dome and all
      // (DEV-355). Not the plate alone in the room (DEV-465), which stands in
      // plain view by design: nothing about the room moves, so it is not a
      // move this file holds to a black.
      const scene = stage.getObjectByName('loading-scene')
      const loading =
        (scene?.visible ?? false) && (scene?.getObjectByName?.('loading-dome')?.visible ?? true)
      const title = app.titleMenu?.().up ?? false
      const third = app.thirdPerson().live
      frames.push({
        t: performance.now(),
        a: app.fade().amount,
        // The EDITION too: every menu wears Anniversary whatever was chosen
        // (DEV-451), so a Classic run re-lights the world on the way into a
        // mission and out of it, and that is a change of picture like any other.
        id:
          `${app.edition.current.id}:${stage.name ?? ''}` +
          `${title ? '+title' : ''}${loading ? '+loading' : ''}${third ? '+third' : ''}`,
      })
    }
    // Sample 0 NOW, before the caller presses anything.
    sample()
    const tick = (): void => {
      sample()
      if (!w.__mvStop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

/** Stop the recorder and take what it saw. */
const takeFrames = async (page: Page): Promise<MoveFrame[]> =>
  page.evaluate(() => {
    const w = globalThis as unknown as { __mvFrames?: MoveFrame[]; __mvStop?: boolean }
    w.__mvStop = true
    return (w.__mvFrames ?? []) as MoveFrame[]
  })

/**
 * One move: a run of solid-black frames, the ramp down into it and the ramp up
 * out of it.
 *
 * Found by its BLACK, not by the curtain leaving zero, because two moves can
 * share one dip: a course that loads fast asks for the cockpit while the
 * loading scene is still fading in, `goToScreen` begins from wherever the
 * curtain is, and the screen never clears between the two blacks. So a ramp
 * starts at the lowest the curtain got since the last black, and ends at the
 * lowest it gets before the next.
 */
interface Episode {
  from: string
  to: string
  /** Frames and ms from the lowest frame before to the first black one. */
  outFrames: number
  outMs: number
  blackFrames: number
  /** From the first black frame to the first frame that is not black. */
  blackMs: number
  /** From the lowest frame before to the first frame after the black: the trigger to the fade-in. */
  triggerToInMs: number
  /** Frames and ms from the last black frame to the lowest one after. */
  inFrames: number
  inMs: number
  /** False when the next move began before this one came all the way back. */
  inComplete: boolean
  /** The longest single frame in each ramp — a stall inside a ramp is a ramp you do not see. */
  outLongestMs: number
  inLongestMs: number
  /**
   * The frame that MADE the black: the swap and the new screen's first draw
   * happen in it, so it is often the longest in the move, and invisible —
   * the frame on screen while it runs is the last of the ramp, all but black.
   */
  intoBlackMs: number
}

const longest = (span: readonly MoveFrame[]): number => {
  let m = 0
  for (let k = 1; k < span.length; k++) m = Math.max(m, (span[k]?.t ?? 0) - (span[k - 1]?.t ?? 0))
  return m
}

const episodes = (frames: readonly MoveFrame[]): Episode[] => {
  const blacks: [number, number][] = []
  for (let i = 0; i < frames.length; i++) {
    if ((frames[i]?.a ?? 0) < 1) continue
    const s = i
    while (i + 1 < frames.length && (frames[i + 1]?.a ?? 0) >= 1) i++
    blacks.push([s, i])
  }
  return blacks.map(([s, e], j) => {
    const lo = j === 0 ? 0 : (blacks[j - 1]?.[1] ?? 0) + 1
    const hi = j === blacks.length - 1 ? frames.length - 1 : (blacks[j + 1]?.[0] ?? 0) - 1
    // The LAST lowest frame before the black (the press, or the turn of a
    // shared dip), and the FIRST lowest one after it.
    let from = Math.max(lo, s - 1)
    for (let k = lo; k < s; k++) if ((frames[k]?.a ?? 1) <= (frames[from]?.a ?? 1)) from = k
    let to = Math.min(hi, e + 1)
    for (let k = e + 1; k <= hi; k++) if ((frames[k]?.a ?? 1) < (frames[to]?.a ?? 1)) to = k
    const at = (k: number): MoveFrame | undefined => frames[k]
    return {
      from: at(from)?.id ?? '',
      to: at(to)?.id ?? '',
      outFrames: s - from,
      // To the LAST RAMP frame, not to the black one. A sample is taken after
      // its frame's work, and the black frame's work is the swap and the new
      // screen's first draw, which can be half a second: counted in, it let a
      // 0.3 s fade-out pass a 0.57 s bound on `72b6314`'s title. A ramp that
      // went black in one frame is 0 here, as it should be.
      outMs: (at(s - 1)?.t ?? Number.NaN) - (at(from)?.t ?? Number.NaN),
      blackFrames: e - s + 1,
      blackMs: (at(e + 1)?.t ?? Number.NaN) - (at(s)?.t ?? Number.NaN),
      triggerToInMs: (at(e + 1)?.t ?? Number.NaN) - (at(from)?.t ?? Number.NaN),
      inFrames: to - e,
      inMs: (at(to)?.t ?? Number.NaN) - (at(e)?.t ?? Number.NaN),
      inComplete: (at(to)?.a ?? 1) <= 0,
      outLongestMs: longest(frames.slice(from, s)),
      inLongestMs: longest(frames.slice(e, to + 1)),
      intoBlackMs: (at(s)?.t ?? Number.NaN) - (at(s - 1)?.t ?? Number.NaN),
    }
  })
}

/** Every frame on which what is on screen changed, with the curtain then. */
const changes = (frames: readonly MoveFrame[]): { id: string; a: number }[] => {
  const out: { id: string; a: number }[] = []
  for (let k = 1; k < frames.length; k++) {
    const f = frames[k]
    if (f && f.id !== frames[k - 1]?.id) out.push({ id: f.id, a: f.a })
  }
  return out
}

const fadeIdle = async (page: Page): Promise<void> => {
  await expect(page.locator('body')).toHaveAttribute('data-fade', 'idle', { timeout: 60_000 })
}

/**
 * Two frames at 60 Hz: one because a ramp is measured to its last frame
 * rather than to the black it reaches inside the next, and one for where in
 * its frame a sample lands. A frame at any faster rate is inside it.
 */
const SLACK_MS = 34

/** A leg's lower bound: the ramp reaches its end at `solidAtFraction` of the leg. */
const leg = (seconds: number): number => seconds * FADE.solidAtFraction * 1000 - SLACK_MS

const MENU = FADE.menuSeconds
const MISSION = FADE.missionSeconds

interface Expect {
  readonly label: string
  readonly out: number
  readonly in: number
}

/**
 * Print the moves, then hold them to the three claims in the header. Returns
 * the episodes, for a caller with a claim of its own.
 */
const check = (
  edition: string,
  moves: readonly Expect[],
  frames: readonly MoveFrame[],
): Episode[] => {
  const eps = episodes(frames)
  const seen = changes(frames)
  for (const [k, e] of eps.entries()) {
    console.info(
      `move-fades ${edition} ${moves[k]?.label ?? '?'}: ${e.from} -> ${e.to} · ` +
        `out ${e.outFrames} frames / ${e.outMs.toFixed(0)} ms (longest ${e.outLongestMs.toFixed(0)}) · ` +
        `into black ${e.intoBlackMs.toFixed(0)} ms · ` +
        `black ${e.blackFrames} frames / ${e.blackMs.toFixed(0)} ms · ` +
        `in ${e.inFrames} frames / ${e.inMs.toFixed(0)} ms (longest ${e.inLongestMs.toFixed(0)})` +
        `${e.inComplete ? '' : ' [cut short by the next move]'}`,
    )
  }
  console.info(`move-fades ${edition}: on screen ${JSON.stringify(seen)}`)
  // 1. Each move reached solid black — one black per move, and no more.
  expect(eps.length, `${moves.map((m) => m.label).join(', ')}: one black per move`).toBe(
    moves.length,
  )
  // 2. Nothing on screen changed except under the curtain, anywhere in the
  //    recording — a move that cut in plain view is a change at a < 1.
  expect(seen.length, 'the picture changed').toBeGreaterThanOrEqual(moves.length)
  for (const c of seen) {
    expect(c.a, `${c.id} came on screen UNDER the curtain`).toBeGreaterThanOrEqual(1)
  }
  // 3. Each leg took at least 2016's number for the screen it is drawn on. An
  //    in-leg the next move interrupted has no end of its own to measure.
  //    SOFT, so one run reports every short leg rather than the first.
  for (const [k, m] of moves.entries()) {
    const e = eps[k]
    if (!e) continue
    expect
      .soft(e.outMs, `${m.label}: out over at least ${m.out} s`)
      .toBeGreaterThanOrEqual(leg(m.out))
    if (e.inComplete) {
      expect
        .soft(e.inMs, `${m.label}: in over at least ${m.in} s`)
        .toBeGreaterThanOrEqual(leg(m.in))
    }
  }
  return eps
}

for (const edition of ['anniversary', 'classic'] as const) {
  test.describe(`@gpu every large camera move goes through black (DEV-427) · ${edition}`, () => {
    test.setTimeout(480_000)

    test('title -> hangar -> elevator -> third -> first -> hangar', async ({ page }) => {
      await page.goto(`/?${PIN}&edition=${edition}`)
      await page.bringToFront()
      await bootReady(page)
      await firstPress(page)
      // The title is left with the KEYBOARD: since DEV-418 a click on the
      // title's world is a capture, and this file is about the fades.
      await dropFocus(page)
      await expect
        .poll(
          async () =>
            page.evaluate(
              () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.titleMenu?.().up ?? false,
            ),
          { timeout: 60_000 },
        )
        .toBe(true)
      await fadeIdle(page)
      // DEV-558: START is the hangar's row; aiming it is not a camera move and
      // is left out of the recording. (The room's first step, the doors, is
      // walked by `board` below, inside the hangar's own recording.)
      await aimTitleRow(page, TITLE_ROW.hangar)
      await fadeIdle(page)

      // ── 1. the title to the hangar: two menu scenes ────────────────────
      await record(page)
      await hold(page, 'Enter', 2_500)
      await fadeIdle(page)
      check(edition, [{ label: 'title->hangar', out: MENU, in: MENU }], await takeFrames(page))

      // ── 2. the hangar to the elevator ────────────────────────────────────
      //
      // On Anniversary the load is waited out IN the room (DEV-465): one black,
      // out of the room into the cockpit at the foot of the shaft. On Classic
      // the look's flip needs a black, so two: out of the room into the
      // loading scene (which lives in the menu), and out of that into the
      // cockpit (`boot/load-place.ts` has the rule).
      await record(page)
      await board(page, INT_01_HOVERJET, 600)
      await fadeIdle(page)
      check(
        edition,
        edition === 'anniversary'
          ? [{ label: 'hangar->elevator', out: MENU, in: MISSION }]
          : [
              { label: 'hangar->loading', out: MENU, in: MENU },
              { label: 'loading->elevator', out: MENU, in: MISSION },
            ],
        await takeFrames(page),
      )

      // ── 3. first to third, and 4. third to first ─────────────────────────
      //
      // 2016's own switch: out 0.12 s, in 0.25 s, and the fade-in waits for
      // `WaitForSeconds(0.2f)` from the fade-out's TRIGGER. The last is the
      // number the port never spent, so it is asserted from the trigger too.
      for (const label of ['first->third', 'third->first']) {
        await record(page)
        await hold(page, 'v', 1_500)
        await fadeIdle(page)
        const eps = check(
          edition,
          [{ label, out: FADE.cameraSwitchOutSeconds, in: FADE.cameraSwitchInSeconds }],
          await takeFrames(page),
        )
        expect
          .soft(
            eps[0]?.triggerToInMs ?? 0,
            `${label}: the fade-in waits 2016's ${FADE.cameraSwitchHoldSeconds} s from the trigger`,
          )
          .toBeGreaterThanOrEqual(FADE.cameraSwitchHoldSeconds * 1000 - SLACK_MS)
      }

      // ── 5. the mission to the hangar: pause, EXIT ─────────────────────────
      //
      // EXIT is the plate's last row; pressing down more times than there are
      // rows lands on it whatever the plate grows to (`walkthrough.spec.ts`).
      await hold(page, 'Backspace')
      for (let i = 0; i < 8; i++) await hold(page, 'ArrowDown', 150)
      await record(page)
      await hold(page, 'Enter', 2_500)
      await fadeIdle(page)
      check(edition, [{ label: 'mission->hangar', out: MISSION, in: MENU }], await takeFrames(page))
    })
  })
}
