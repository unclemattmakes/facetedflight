// tests/unit/hud-clock.test.ts — the TIME row, which counted the wrong way.
//
// DEV-200. `HUD_Ship.cs:112-121` writes `raceTimer.GetRemainingTime()` into that
// row and `Timer_Race.cs:38-43` is `(maxRaceTime - currentRaceTime).ToString("00")`
// — seconds REMAINING, rounded, minimum two digits. The port printed
// `Math.floor(elapsed)`, which is the same row saying the opposite thing on
// every frame of every race.
//
// ── What this file compares against ──────────────────────────────────────
//
// CLAUDE.md's rule: *compare against something outside the port*. A test that
// re-derives its expectation the way the code does has not tested the code.
// So the anchors here are, in order of strength:
//
//  1. `content/levels/*.json`'s `ui.strings.timeEmpty` — the BYTES out of
//     `PlayerShip_SR14_Photon.prefab#11482956`, not a literal anybody retyped.
//     If the panel's "no clock" text ever stops being 2016's, this goes red.
//  2. The 2016 gameplay capture (youtu.be/1-Sf7TiHPsg), read as a RELATIONSHIP
//     and never as a value: between 125 s and 215 s of that recording the panel
//     goes `TIME: 110` to `TIME: 22` while the gates go 05 to 16. Ninety real
//     seconds, eighty-eight displayed seconds, downward. The assertion below is
//     "over ninety seconds of elapsed time the row falls by ninety", which is
//     true on every platform, of every limit, and false for the old code.
//  3. `game/modes.ts`'s `clockEnds`, which is the port's own — used only to
//     pin WHICH modes count down, never to derive the arithmetic.
//
// ── And the redraw signature ─────────────────────────────────────────────
//
// The half most likely to go wrong quietly, and the file `hud.ts` warns about
// in its own comments. `Math.floor(state.elapsed)` tracked this row's text
// exactly while the text WAS the floored elapsed seconds. The moment a
// subtraction and a rounding sat in between, the two stopped agreeing: elapsed
// 10.4 and 10.6 both floor to 10, and against a 180 s limit they round to 170
// and 169. The old signature would have held the panel on `170` while the
// drawing said `169` — a second stale with every number it reads correct.

import { describe, expect, it } from 'vitest'
import { rulesFor } from '@/game/modes'
import { formatTime, type HudState, hudSignature } from '@/render/hud'
import hoverJet from '../../content/levels/int_01_hoverJet.json'
import jumpSeat from '../../content/levels/int_01_jumpSeat.json'

/** A mid-run panel. Every field present, so a test can change exactly one. */
const state = (over: Partial<HudState> = {}): HudState => ({
  ringsPassed: 7,
  ringsTotal: 21,
  score: 700,
  elapsed: 42.3,
  timeLimit: 180,
  speed: 170,
  medal: '',
  finished: false,
  countLabel: 'GATES',
  timeLabel: 'TIME',
  speedLabel: 'SPEED',
  banner: null,
  autopilot: false,
  ...over,
})

describe("the row 2016 drew, against 2016's own bytes", () => {
  it('prints the extracted `--` when there is no clock, not a literal of ours', () => {
    // `PlayerShip_SR14_Photon.prefab#11482956 val_time`. The extractor read it;
    // nobody typed it. A mission with no clock has `timeLimit` 0 here because
    // `hudTimeLimit` returns 0 when `rulesFor(mode).clock` is false, which is
    // the observable form of `RaceTimer.cs:30`.
    const extracted = (hoverJet.ui.strings as Record<string, string>).timeEmpty
    expect(extracted).toBe('--')
    expect(formatTime(42.3, 0, true)).toBe(extracted)
    expect(formatTime(42.3, 0, false)).toBe(extracted)
  })

  it('pads to a minimum of two digits, the way `.ToString("00")` does', () => {
    expect(formatTime(171, 180, true)).toBe('09')
    expect(formatTime(179, 180, true)).toBe('01')
    expect(formatTime(180, 180, true)).toBe('00')
    // ...and does NOT pad past two. 110 in the capture is three characters.
    expect(formatTime(70, 180, true)).toBe('110')
  })

  it('ROUNDS rather than truncating, because `.ToString("00")` rounds', () => {
    // Remaining 169.6 and 169.4 about a 180 s limit.
    expect(formatTime(10.4, 180, true)).toBe('170')
    expect(formatTime(10.6, 180, true)).toBe('169')
  })

  it('never goes negative, because 2016 ends the run at zero', () => {
    // The clamp is FF2's and it is stated as such in `formatTime`: a row reading
    // `-3` would be reporting a state the game is not in. Reachable only where
    // the clock does not end the run, and there the row does not count down.
    expect(formatTime(240, 180, true)).toBe('00')
  })
})

describe('the capture, read as a relationship and not as a value', () => {
  it('FALLS by ninety over ninety seconds of flying', () => {
    // youtu.be/1-Sf7TiHPsg: `TIME: 110` at 125 s (five gates down), `TIME: 22`
    // at 215 s (sixteen). This is the assertion the OLD code fails — it rose.
    const at = (elapsed: number) => Number(formatTime(elapsed, 180, true))
    expect(at(100) - at(10)).toBe(-90)
    // And the two readings themselves are reachable on the same clock: 110 and
    // 22 are 88 apart, which is the 90 s of the capture less the two seconds
    // the recording's own frame times lose.
    expect(at(70)).toBe(110)
    expect(at(158)).toBe(22)
  })
})

describe('WHICH modes count down — the DEV-056 distinction', () => {
  it('counts down where running out ENDS the run', () => {
    // Ring Attack's timeout finds the `Trigger_FinishLine` every HoverJet scene
    // carries, so the clock means something.
    expect(rulesFor('ringAttack').clockEnds).toBe(true)
    expect(rulesFor('energyRace').clockEnds).toBe(true)
  })

  it('does NOT count down in Target Practice, where the clock ends nothing', () => {
    // No JumpSeat scene has a `Trigger_FinishLine`, so 2016's timeout null-refs
    // (DEV-056) — and 2016 drew no TIME row on that vehicle at all. The
    // JumpSeat's own `ui.strings` set is the evidence: it carries a fuel gauge
    // and no time label, so the port's `TIME` there is the fallback word.
    expect(rulesFor('targetPractice').clock).toBe(true)
    expect(rulesFor('targetPractice').clockEnds).toBe(false)
    const js = jumpSeat.ui.strings as Record<string, string>
    expect(js.timeLabel).toBeUndefined()
    expect(js.fuelLabel).toBe('Fuel :')
  })

  it('has no clock at all in Free Flight', () => {
    expect(rulesFor('freeFlight').clock).toBe(false)
  })
})

describe('an absent flag is the old row, character for character', () => {
  it('counts up when nothing says otherwise', () => {
    // Every caller that says nothing — the screenshot builders, the other
    // suites — keeps exactly what it drew before.
    expect(formatTime(42.9, 180)).toBe('42')
    expect(formatTime(42.9, 180, false)).toBe('42')
    expect(formatTime(0, 180, false)).toBe('0')
  })
})

describe('the redraw signature holds what is DRAWN', () => {
  it('tracks a change the OLD signature could not see', () => {
    // THE RED TEST. `Math.floor(10.4)` and `Math.floor(10.6)` are both 10, so
    // the signature this row used to carry was identical across these two —
    // while the text they draw is `170` and `169`.
    const a = state({ elapsed: 10.4, timeCountsDown: true })
    const b = state({ elapsed: 10.6, timeCountsDown: true })
    expect(Math.floor(a.elapsed)).toBe(Math.floor(b.elapsed))
    expect(formatTime(a.elapsed, a.timeLimit, true)).not.toBe(
      formatTime(b.elapsed, b.timeLimit, true),
    )
    expect(hudSignature(a)).not.toBe(hudSignature(b))
  })

  it('repaints when the direction changes and nothing else does', () => {
    expect(hudSignature(state({ timeCountsDown: true }))).not.toBe(
      hudSignature(state({ timeCountsDown: false })),
    )
  })

  it('treats an absent flag as counting up, so no existing caller repaints', () => {
    expect(hudSignature(state())).toBe(hudSignature(state({ timeCountsDown: false })))
  })

  it('repaints when the LIMIT changes, which the old signature never held', () => {
    // A countdown's text depends on the limit as much as on the elapsed time,
    // and `timeLimit` was drawn-from and never in the signature.
    expect(hudSignature(state({ timeLimit: 180, timeCountsDown: true }))).not.toBe(
      hudSignature(state({ timeLimit: 120, timeCountsDown: true })),
    )
  })

  it('does NOT repaint for a change too small to draw', () => {
    // Under a tenth of a second either side of the same rounded value.
    expect(hudSignature(state({ elapsed: 42.3, timeCountsDown: true }))).toBe(
      hudSignature(state({ elapsed: 42.35, timeCountsDown: true })),
    )
  })

  it('leaves every other row alone', () => {
    const base = state({ timeCountsDown: true })
    expect(hudSignature(base)).not.toBe(hudSignature({ ...base, ringsPassed: 8 }))
    expect(hudSignature(base)).not.toBe(hudSignature({ ...base, speed: 171 }))
    expect(hudSignature(base)).not.toBe(hudSignature({ ...base, countLabel: 'ORBS' }))
  })
})
