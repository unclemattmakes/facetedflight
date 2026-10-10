// tests/unit/briefing-up.test.ts — the briefing is up on the pad and for the
// first half of the ride, and fades out by half way up. DEV-395, DEV-526.
//
// Matt, look call 8 (2026-09-25): *"keep the motes, drop the briefing during
// the elevator ride."* The plate used to be up for `waiting || rising`, so it
// rode the whole 15.5 s lift and hung over the first gate at the reveal; DEV-395
// took it down at the launch press. Matt, 2026-09-29, answering the call that
// followed (drop it at the press, or at the reveal): *"half way up the ride"*.
// DEV-526: by the platform's HEIGHT, fading over the tenth of the climb before
// half way.
//
// Two halves, because a predicate nobody calls is documentation: the rule
// itself, and that `boot/app.ts`'s `briefingLevel` IS that rule rather than a
// second copy of it (the `xr-select.test.ts` precedent of reading the handler
// out of `app.ts`).

import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { launchSpecOf } from '@/game/course-specs'
import { BRIEFING_DOWN_AT, BRIEFING_FADE, briefingOpacity, briefingUp } from '@/render/briefing'
import { REVEAL_RISE, worldRevealed } from '@/render/elevator'
import { evaluateCurve } from '@/sim/art-lean'
import { FIXED_DT } from '@/sim/constants'
import {
  createLaunch,
  type LaunchPhase,
  type LaunchSpec,
  startLaunch,
  stepLaunch,
  topRise,
} from '@/sim/launch'
import int01 from '../../content/levels/int_01_hoverJet.json'
import { appSourceThroughCtx } from './helpers/app-source'

const LEVEL = int01 as unknown as Level
/**
 * The release mission's launch, with the ride on — built by the same function
 * the game builds it with (`game/course-specs.ts`, APP-SPLIT 2.2), where this
 * used to be a hand copy of `boot/app.ts`'s.
 */
const SPEC: LaunchSpec = launchSpecOf(LEVEL, false) as LaunchSpec
const TOP = topRise(SPEC)

const at = (phase: LaunchPhase, share: number): number =>
  briefingOpacity({ phase, rise: TOP * share }, TOP)

describe('DEV-526: the briefing drops half way up the ride', () => {
  it('is up on the pad, waiting for the launch press, at the bottom or at the top', () => {
    // A skipped ride (a Quick Race, a retry) waits at the TOP; the plate is
    // still the thing you read there.
    expect(at('waiting', 0)).toBe(1)
    expect(at('waiting', 1)).toBe(1)
    expect(briefingUp({ phase: 'waiting', rise: TOP }, TOP)).toBe(true)
  })

  it('stays full for the first 40 % of the climb', () => {
    // Just under 40 %: exactly 0.4 is 1 - 2e-16 in floating point.
    for (const share of [0, 0.1, 0.25, BRIEFING_DOWN_AT - BRIEFING_FADE - 1e-9]) {
      expect(at('rising', share), `${share}`).toBe(1)
    }
  })

  it('fades over the next tenth, and is gone at half way', () => {
    const a = at('rising', 0.42)
    const b = at('rising', 0.46)
    expect(a).toBeGreaterThan(b)
    expect(a).toBeLessThan(1)
    expect(b).toBeGreaterThan(0)
    expect(at('rising', BRIEFING_DOWN_AT)).toBe(0)
    expect(briefingUp({ phase: 'rising', rise: TOP * BRIEFING_DOWN_AT }, TOP)).toBe(false)
    expect(at('rising', 0.75)).toBe(0)
    expect(at('rising', 1)).toBe(0)
  })

  it('is half way by HEIGHT, as Matt said it: "half way up the ride"', () => {
    expect(BRIEFING_DOWN_AT).toBe(0.5)
  })

  it('is down through the countdown and the flight', () => {
    for (const phase of ['countdown', 'flying'] as const satisfies readonly LaunchPhase[]) {
      expect(at(phase, 0), phase).toBe(0)
      expect(at(phase, 1), phase).toBe(0)
    }
  })

  it('is never up on a mission with no elevator rig', () => {
    expect(briefingOpacity(null, 0)).toBe(0)
    expect(briefingUp(null, 0)).toBe(false)
  })

  it('on the real ride: full for 8.2 s after the press, gone at 9.1 s, before the reveal', () => {
    // Flown through `stepLaunch` on the fixed step, as the game flies it.
    const launch = createLaunch(SPEC)
    startLaunch(launch, SPEC)
    let fullUntil = Number.NaN
    let goneAt = Number.NaN
    let revealAt = Number.NaN
    let t = 0
    while (launch.phase === 'rising') {
      stepLaunch(launch, SPEC, FIXED_DT)
      t += FIXED_DT
      const o = briefingOpacity(launch, TOP)
      if (o < 1 && Number.isNaN(fullUntil)) fullUntil = t
      if (o === 0 && Number.isNaN(goneAt)) goneAt = t
      if (worldRevealed(launch.rise, true) && Number.isNaN(revealAt)) revealAt = t
    }
    // The clip's own numbers: half the height is later than half the clip,
    // because it holds 0.6 s at the bottom and 1.5 s at the top.
    const halfClip = SPEC.releaseAtSeconds / 2
    const halfClipRise = evaluateCurve({ keys: SPEC.keys }, halfClip)
    console.info(
      `briefing: full until ${fullUntil.toFixed(2)} s, gone at ${goneAt.toFixed(2)} s, ` +
        `the world revealed at ${revealAt.toFixed(2)} s (${REVEAL_RISE.toFixed(1)} m) ` +
        `(top ${TOP.toFixed(1)} m; half the clip is ${halfClip.toFixed(2)} s at ${halfClipRise.toFixed(1)} m)`,
    )
    // Measured: 8.19 s and 9.11 s on `int_01`'s clip.
    expect(fullUntil).toBeGreaterThan(8)
    expect(fullUntil).toBeLessThan(8.4)
    expect(goneAt).toBeGreaterThan(8.9)
    expect(goneAt).toBeLessThan(9.3)
    expect(goneAt - fullUntil, 'a fade, not a pop').toBeGreaterThan(0.5)
    // Gone well before the reveal, the moment DEV-395 took it away for.
    expect(revealAt - goneAt, 'seconds between the plate going and the reveal').toBeGreaterThan(1.5)
    expect(halfClipRise).toBeLessThan(TOP / 2)
  })

  it("is the rule `app.ts`'s briefingLevel uses, not a copy of it", () => {
    // APP-SPLIT 4.8b: `briefingLevel` lives in `boot/app/flight/briefing.ts` and
    // reads the closure's `launchSpec` and `flight` through its `ctx`.
    const app = appSourceThroughCtx()
    // DEV-631 gave it a body: the pad's rule, then the JumpSeat's countdown.
    const level = app.match(/const briefingLevel = \(\): number => \{[\s\S]*?\n {2}\}/)
    expect(level, 'briefingLevel is defined in app.ts').not.toBeNull()
    const body = (level as RegExpMatchArray)[0]
    expect(body).toContain('if (launchSpec) return briefingOpacity(launch, topRise(launchSpec))')
    // DEV-631: no pad (the JumpSeat), the plate is up while the countdown holds.
    expect(body).toContain('flight?.countdownHolds === true')
    // And no phase is spelled beside it: a second reading of the phase is the
    // copy that drifts.
    expect(body).not.toMatch(/'rising'|'waiting'/)
    // And the frame reads it: the plate's visibility and opacity are both it.
    expect(app).toContain('const briefingNow = briefingLevel()')
    expect(app).toContain('flight.briefing.setOpacity(briefingNow)')
  })
})
