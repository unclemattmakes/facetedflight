// tests/unit/snap.test.ts — the two pure halves of `?snap=<seconds>`.
//
// **What this cannot test.** Whether the sim actually STOPS. That lives in
// `app.ts`'s frame loop and is `tests/e2e/snap.spec.ts`'s job, exactly as
// `pause-menu.test.ts` proves the hit test while `pause.spec.ts` proves the
// freeze. The split is the same one and for the same reason: *"it says nothing
// about whether pausing actually STOPS anything, which is the entire point of
// the feature."*
//
// **What it can test** is the parse — a switch that reads a URL has to survive
// whatever is typed into one — and the trigger, whose `null` case is the one
// that decides whether a build with no `?snap=` ever freezes. That case runs on
// every single frame of every normal run, which makes it the most-executed line
// in the file and the one nobody would notice was wrong until a mission stopped.

import { describe, expect, it, vi } from 'vitest'
import { parseSnap, shouldFreeze } from '@/boot/snap'
import { FIXED_DT } from '@/sim/constants'

describe('parseSnap', () => {
  it('reads a number of seconds', () => {
    expect(parseSnap('20')).toBe(20)
    expect(parseSnap('12.5')).toBe(12.5)
    // The first tick. Legal, and the natural way to photograph a spawn.
    expect(parseSnap('0')).toBe(0)
  })

  it('is null when the switch is absent or empty', () => {
    expect(parseSnap(null)).toBe(null)
    expect(parseSnap('')).toBe(null)
    expect(parseSnap('   ')).toBe(null)
  })

  it('ignores what it cannot read, loudly, rather than failing to boot', () => {
    // `?edition=`'s precedent, five lines above it in `app.ts`: *"An unknown id
    // is ignored rather than fatal, with a line in the console: a typo in a URL
    // should not be a black page."*
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseSnap('twenty')).toBe(null)
    expect(parseSnap('-5')).toBe(null)
    expect(parseSnap('NaN')).toBe(null)
    expect(parseSnap('Infinity')).toBe(null)
    expect(warn).toHaveBeenCalledTimes(4)
    warn.mockRestore()
  })
})

describe('shouldFreeze', () => {
  it('never freezes without a snap', () => {
    // The case every normal run takes, on every frame. If this were ever true a
    // mission would stop for no reason anyone could trace back to a URL.
    expect(shouldFreeze(0, null)).toBe(false)
    expect(shouldFreeze(99_999, null)).toBe(false)
    expect(shouldFreeze(Number.NaN, null)).toBe(false)
  })

  it('freezes at the mark and stays frozen past it', () => {
    expect(shouldFreeze(11.99, 12)).toBe(false)
    expect(shouldFreeze(12, 12)).toBe(true)
    expect(shouldFreeze(12.5, 12)).toBe(true)
  })

  it('fires on the first tick at or past the mark, within one fixed step', () => {
    // The precision the tool actually has, asserted against the sim's own
    // constant rather than a number typed here (CLAUDE.md rule 3): the clock
    // advances in 0.0121999998 s steps, so it lands SOMEWHERE in
    // [snapAt, snapAt + FIXED_DT) and never exactly on 12.
    const snapAt = 12
    let elapsed = 0
    while (!shouldFreeze(elapsed, snapAt)) elapsed += FIXED_DT
    expect(elapsed).toBeGreaterThanOrEqual(snapAt)
    expect(elapsed).toBeLessThan(snapAt + FIXED_DT)
    // And comfortably inside the band `snap.spec.ts` asserts, which is what
    // makes that spec a check on the freeze rather than on the step size.
    expect(elapsed - snapAt).toBeLessThan(0.05)
  })

  it('freezes immediately at zero', () => {
    expect(shouldFreeze(0, 0)).toBe(true)
  })
})
