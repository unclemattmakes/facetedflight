/**
 * tests/e2e/perf-capture.spec.ts — the pause plate's PERF CAPTURE row, end to
 * end on a real flight.
 *
 * `tests/unit/perf-capture.test.ts` holds the accumulation — N runs in, N runs
 * out, in order. What it cannot hold is the half that lives in `boot/app.ts`:
 * **does turning the row on actually arm the recorder?** A capture that
 * collects nothing is exactly as quiet as one that works, and the player
 * discovering that is wearing a headset at the time.
 *
 * So this gates the two mechanisms that make the feature exist at all:
 *
 *  1. the row is on the plate under `?perf=1` and ABSENT without it — a player
 *     must never see a debug row;
 *  2. toggling it starts the recorder **with no `?trace=` in the URL**, which
 *     is the whole point (a query parameter is not reachable from inside a
 *     headset).
 *
 * Gates counts and states, never a millisecond (`perf-protocol.md` rule 1).
 *
 *   E2E_PORT=<yours> pnpm exec playwright test tests/e2e/perf-capture.spec.ts --workers 1
 */

import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold } from './fixtures/freeze'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

const MISSION = process.env.CAPTURE_MISSION ?? 'int_01_hoverJet'

/** The pause plate's row ids, in order, as the player would meet them. */
const pauseRowIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: { pausePlate: () => { rows: { id: string }[] } }
    }
    return w.__ff2.pausePlate().rows.map((r) => r.id)
  })

const captureState = (page: Page): Promise<{ recording: boolean; runs: number }> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2perf: { capture: { recording: () => boolean; runs: () => number } }
    }
    return { recording: w.__ff2perf.capture.recording(), runs: w.__ff2perf.capture.runs() }
  })

const traceStatus = (page: Page): Promise<string> =>
  page.evaluate(() =>
    (
      globalThis as unknown as { __ff2perf: { trace: { status: () => string } } }
    ).__ff2perf.trace.status(),
  )

test.describe('@measure @gpu the perf capture row', () => {
  test.setTimeout(600_000)

  test('is absent without ?perf=1', async ({ page }) => {
    await page.goto(`/?autopilot=1&xr=off&mission=${MISSION}&edition=anniversary`)
    await firstPress(page)
    await missionReady(page, 240_000)
    // A debug row on a player's pause plate is a bug, not an inconvenience.
    expect(await pauseRowIds(page)).not.toContain('perfcapture')
  })

  test('records from BOOT under ?perf=1, before the ship is ever released', async ({ page }) => {
    // ── DEV-261, and the assertion is the FIRST one now ────────────────────
    //
    // Matt: *"make it so once perf=1 is there, it records until i stop it."*
    // This test used to assert the opposite — `recording: false` and a trace
    // `idle` until something asked — and that was right for the old design and
    // is the whole of what changed.
    //
    // Why it changed, in one number: the compositor drops the app to a 45 Hz
    // tier AT THE RACE START, the recorder armed AT the race start, and so all
    // three worn laps open at 22.20 ms with the lock already in force. The
    // event was always one frame before the first row.
    await page.goto(`/?perf=1&autopilot=1&xr=off&mission=${MISSION}&edition=anniversary`)
    await firstPress(page)
    await missionReady(page, 240_000)

    expect(await pauseRowIds(page)).toContain('perfcapture')
    // Recording already, with nothing banked: `?perf=1` alone armed it.
    expect(await captureState(page)).toEqual({ recording: true, runs: 0 })
    // THE assertion. The ship has not been released — the lift ride has not
    // even been taken — and the recorder is already running. Under the old
    // arming this read `idle` here and only moved once the race started.
    expect(await traceStatus(page)).toBe('recording')

    await focusCanvas(page)
    await hold(page, 'Enter')

    // ── The wait has to be the GAME's state now, not the recorder's ────────
    //
    // This polled `traceStatus() === 'recording'` until DEV-261, and that
    // worked by accident: the recorder only reached `recording` at the
    // release, so polling it waited out the ~100 s lift ride. Now it is
    // recording from boot, so the same poll returns on the first tick and the
    // stop below would land in the middle of the ride — which is exactly what
    // it did, and the `phase == 1` assertion caught it with a zero.
    //
    // `__ff2.launch().phase` is the game saying it, the way `engine-sound`
    // and `launch-ride-on-switch` ask it. The recorder cannot be the witness
    // for a question about the thing it is recording.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const w = globalThis as unknown as { __ff2?: { launch(): { phase: string } } }
            return w.__ff2?.launch().phase ?? 'none'
          }),
        { timeout: 300_000, intervals: [500] },
      )
      .toBe('flying')
    expect(await traceStatus(page)).toBe('recording')

    // And turning it off stops collecting. The payload is still readable
    // afterwards — that is the recovery path when a browser refuses the
    // download the row tries to make.
    await page.evaluate(() =>
      (
        globalThis as unknown as { __ff2perf: { capture: { toggle: () => void } } }
      ).__ff2perf.capture.toggle(),
    )
    expect((await captureState(page)).recording).toBe(false)
    const payload = await page.evaluate(() =>
      (
        globalThis as unknown as {
          __ff2perf: {
            capture: {
              payload: () => { kind: string; runs: { mission: string; csv: string }[] }
            }
          }
        }
      ).__ff2perf.capture.payload(),
    )
    expect(payload.kind).toBe('ff2-perf-capture')

    // ── THE assertion this spec was missing, and it cost a headset session ──
    //
    // Matt, 2026-09-20, after a Frame session: *"the perf recorder has
    // regressed or something — it doesn't write logs anymore."* It wrote a
    // file every time. **The file had nothing in it**, and this test passed
    // throughout, because it stopped at `payload.kind` — a shape check that a
    // capture holding zero runs satisfies perfectly.
    //
    // The stop above happens MID-FLIGHT, on purpose: the loop's own
    // `perfCapture.add` fires only when the 300 s window elapses or the
    // mission finishes plus a tail, so before `captureLiveRun` this line read
    // **0** and nothing downstream noticed. That is the whole regression in
    // one number.
    //
    // This is the repo's own lesson one level up — a gate that cannot
    // distinguish "it worked" from "it produced nothing" is not a gate
    // (CLAUDE.md, on a skipped gate reading as a pass).
    expect(
      payload.runs.length,
      'a capture stopped mid-flight KEEPS the run in progress',
    ).toBeGreaterThanOrEqual(1)
    expect((await captureState(page)).runs).toBeGreaterThanOrEqual(1)
    // And the run has to carry FRAMES, not just an entry: an empty CSV would
    // satisfy the count and still hand the reader nothing.
    const first = payload.runs[0]
    expect(first?.mission).toBe(MISSION)
    expect(first?.csv.split('\n').length, 'the CSV carries a header and real rows').toBeGreaterThan(
      10,
    )

    // ── DEV-261: the PRE-FLIGHT frames are in the file ─────────────────────
    //
    // The point of the whole change, asserted on the artifact rather than on
    // the recorder's state — because "it was recording early" and "the early
    // frames reached the file" are two claims and only the second one is what
    // a reader opens hours later on another machine.
    //
    // A count, not a presence test: `phase == 0` appearing once could be a
    // single boot frame. The lift ride is ~100 s, so a capture that genuinely
    // spans it has hundreds.
    const lines = first?.csv.trim().split('\n') ?? []
    const columns = (lines[1] ?? '').split(',')
    const phaseAt = columns.indexOf('phase')
    expect(phaseAt, 'the CSV carries a phase column').toBeGreaterThanOrEqual(0)
    const phases = lines.slice(2).map((row) => row.split(',')[phaseAt])
    expect(
      phases.filter((p) => p === '0').length,
      'the capture spans the ride, not just the flight',
    ).toBeGreaterThan(20)
    // And it reached flight too, so this is one continuous recording across
    // the boundary rather than a trace that stopped when the race began.
    expect(phases.filter((p) => p === '1').length).toBeGreaterThan(0)
  })
})
