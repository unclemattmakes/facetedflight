// tests/unit/hud-redraw.test.ts — DEV-243's redraw budget, which DEV-248 made
// the default, and the arm that goes back.
//
// ── DEV-248 turned this file's first job inside out, deliberately ────────
//
// Written for DEV-243, the first `describe` below was the guard in the OTHER
// direction: *"off by default means the default path repaints on precisely the
// frames it always did"*, written so that it would have been green on the
// unfixed code too. **Matt enabled the budget on 2026-09-20** — *"sounds like
// we should enable the redraw budget"* — so that guard now defends a default
// that no longer exists, and a guard defending the wrong thing is worse than
// no guard: it would be green on a silent revert.
//
// It is RESTATED rather than deleted, and it is restated as two tests rather
// than one, because the one it was has split into two claims:
//
//  · **`live` still paints once per signature transition.** That contract is
//    2016's and it is untouched; what changed is that reaching it now takes
//    `?hudRedraw=live` / `setRedraw(HUD_REDRAW_LIVE)`. Still derived from
//    `hudSignature`'s transitions rather than from the budget (trap 24).
//  · **The default withholds.** The inverted guard: the same stream, no pin,
//    must paint FEWER times, at the shipped rate, and must still end on the
//    current state. This one fails on a revert to `live`, which is the whole
//    point of writing it.
//
// The rest of the file needed one mechanical change of the same origin: a
// handful of tests reached `live` by taking `createHud()`'s / the budget's
// default, and now name it. Wherever `HUD_REDRAW_LIVE` appears as an explicit
// argument below and looks redundant, that is why it is there.
//
// ── What is actually being defended ──────────────────────────────────────
//
// `VR-PERF-WAVE-4.md` §3.5 queue F found the vehicle group carrying the whole
// of every mission's ±1.7 ms per-frame residual, and queue H narrowed it to one
// object by name: hiding `jumpseat/hud` takes `adv_02_jumpSeat` from GPU p50
// 4.52 / p95 7.46 to 4.16 / 5.25. The mechanism is in `render/hud.ts`'s DEV-243
// block — a repaint re-uploads a 560 × 203 canvas, with a full mip regeneration
// on top of it, from inside `renderer.render`, which is inside `boot/app.ts`'s
// `gpu.begin() … gpu.end()` bracket.
//
// So this file has two jobs and they pull in opposite directions:
//
//  1. The arms do what they say. An arm that did not fire is the failure this
//     whole wave keeps paying for (DEV-232's 0.025 ms, DEV-231's fourteen
//     withdrawn rows), and a cadence is exactly the kind of thing that can
//     look applied and not be. **Since DEV-248 that includes `live`**, which
//     is now the arm and not the default.
//  2. **The shipped panel is the budgeted one, and it must not drift either
//     way.** The default repaints at 10 Hz, withholds the rest, and never
//     LOSES an update — the `owed` flag below is the whole of that third
//     clause and it is what keeps a 0.8 s banner reachable.
//
// ── Why the panel itself is driven, and not just the arithmetic ──────────
//
// `createHud` needs a 2-D canvas and this suite is `environment: 'node'`, which
// is why `perf-plate.test.ts` tests `plateOffsetX` and never builds a plate.
// But the question here is not arithmetic, it is *"does a repaint happen"*, and
// the thing that answers it is the texture. So a recording stub stands in for
// the canvas — every method `hud.ts` calls, counted — and the assertions about
// uploads read **three's own `texture.version`**, which `Texture.needsUpdate`'s
// setter increments and nothing in this port touches. CLAUDE.md's rule, as
// literally as it can be applied: compare against something outside the port.
//
// ── The assertion that fails on the unfixed code ─────────────────────────
//
// Every `describe` below fails on pre-DEV-243 `main` — `hudRedraw`,
// `createHudRedrawBudget`, `setRedraw` and `report` do not exist there. The
// first one additionally fails on pre-DEV-248 `main`, where the default is
// `live`, and that is now the point of it.

import type * as THREE from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STRANDED_BANNER_SECONDS } from '@/game/jumpseat-flight'
import { PAD_BANNER_SECONDS } from '@/game/mission'
import { OVERTAKE } from '@/game/overtake'
import {
  createHud,
  createHudRedrawBudget,
  createPanelCounter,
  describeHudRedraw,
  HUD_REDRAW_DEFAULT,
  HUD_REDRAW_DEFAULT_HZ,
  HUD_REDRAW_LIVE,
  HUD_REDRAW_MAX_HZ,
  HUD_REDRAW_MIN_HZ,
  type Hud,
  type HudRedraw,
  type HudState,
  hudSignature,
  PIXELS_PER_METRE,
  parseHudRedraw,
  WIDTH,
} from '@/render/hud'
import { createPerfPlate, PLATE_H, PLATE_W } from '@/render/perf-plate'
import { appSource } from './helpers/app-source'

// ── The canvas stub ────────────────────────────────────────────────────────
//
// Seventeen members, which is every `ctx.*` and `canvas.*` `hud.ts` reaches
// for. `measureText` is the only one that has to return anything; the rest
// record and do nothing, because what is being counted is WHETHER a draw
// happened and not what it drew.

interface Recorder {
  /** `clearRect` calls — one per `draw()`, at the top of it. */
  clears: number
  /** `fillText` calls, so a "nothing was repainted" claim has a second witness. */
  texts: number
  /**
   * Every string `fillText` was handed, in order. DEV-248.
   *
   * A count answers *"did a repaint happen"*; this answers *"did the player
   * ever SEE this"*, which is the question a rate limiter raises about a
   * banner with a 0.8 s life. Nothing before DEV-248 needed it, and a banner
   * that is delayed past its own window is invisible to `repaints`.
   */
  strings: string[]
}

const installCanvas = (): Recorder => {
  const recorder: Recorder = { clears: 0, texts: 0, strings: [] }
  const context = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 0,
    textAlign: '',
    textBaseline: '',
    clearRect: () => {
      recorder.clears += 1
    },
    fillRect: () => {},
    beginPath: () => {},
    roundRect: () => {},
    fill: () => {},
    stroke: () => {},
    fillText: (s: string) => {
      recorder.texts += 1
      recorder.strings.push(s)
    },
    // A width proportional to the string, so any layout that divides by it
    // cannot produce a NaN and take a test down for the wrong reason.
    measureText: (s: string) => ({ width: s.length * 8 }),
  }
  const element = {
    width: 0,
    height: 0,
    getContext: () => context,
  }
  vi.stubGlobal('document', { createElement: () => element })
  return recorder
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

// ── A flight, as a stream of panel states ──────────────────────────────────

/** A mid-run panel. Every field present, so a stream can move exactly one. */
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
  autopilot: true,
  ...over,
})

/**
 * The worst case for this panel, and the one §3.5 is about: a speed that moves
 * every frame, so `hudSignature` changes every frame and the unbudgeted panel
 * re-uploads every frame.
 *
 * The speeds are a ramp with a fractional step, so consecutive frames round to
 * different integers — the m/s row is the entry in the signature that changes
 * (`hud.ts`'s `formatSpeed`, DEV-200's note on the rule), and a ramp that
 * happened to round to the same value twice would be a quieter stream than the
 * one being defended against.
 */
const changingStream = (frames: number, hz = 90): { at: number; s: HudState }[] =>
  Array.from({ length: frames }, (_, i) => ({
    at: (i * 1000) / hz,
    s: state({ speed: 40 + i * 1.7, elapsed: 10 + i / hz }),
  }))

// ───────────────────────────────────────────────────────────────────────────

/**
 * Ten frames of a 90 Hz flight, spanning exactly 100 ms — one interval of the
 * shipped 10 Hz default, which is what makes the two tests below a pair.
 *
 * Five of the ten move `hudSignature`: the first panel, the speed reaching 42,
 * the speed reaching 50, the clock reaching 60, and the banner. The other five
 * move a value the panel does not draw, or nothing at all.
 */
const tenFrames = (): { at: number; s: HudState }[] =>
  [
    state({ speed: 40.2 }),
    state({ speed: 40.4 }), // rounds to 40 as well — NOT a transition
    state({ speed: 41.6 }),
    state({ speed: 41.6, score: 9999 }), // undrawn field — NOT a transition
    state({ speed: 41.6 }),
    state({ speed: 50.0 }),
    state({ speed: 50.0, elapsed: 42.9 }), // same TIME text — NOT a transition
    state({ speed: 50.0, elapsed: 60.0 }), // a new TIME text — a transition
    state({ speed: 50.0, banner: '3' }),
    state({ speed: 50.0, banner: '3' }),
  ].map((s, i) => ({ at: (i * 1000) / 90, s }))

/** Transitions of `hudSignature` over a stream. Derived from the signature. */
const transitionsOf = (stream: { s: HudState }[]): number => {
  let transitions = 0
  let previous = ''
  for (const { s } of stream) {
    const next = hudSignature(s)
    if (next !== previous) transitions += 1
    previous = next
  }
  return transitions
}

describe('the cadence the game ships on', () => {
  /**
   * THE REGRESSION GUARD, in the direction DEV-248 left it.
   *
   * It used to read *"is `live` unless something asks otherwise"* and it was
   * correct until Matt enabled the budget. Inverted rather than deleted, so
   * that a silent revert to `live` — the exact change this row is — turns it
   * red instead of leaving a green suite behind.
   *
   * `HUD_REDRAW_DEFAULT_HZ` is asserted as a literal on purpose, which is the
   * one place in this file that is deliberately not derived: **10 Hz is the
   * only rate anyone has MEASURED** (wave 4 §3.10, three runs of p95
   * 7.09 · 7.16 · 7.20 on `int_01_hoverJet` against a 7.78 ms rule), so a
   * change to the number is a change that needs a new measurement, and this
   * assertion is what makes somebody notice they owe one.
   */
  it('is the 10 Hz budget unless something asks otherwise', () => {
    installCanvas()
    expect(HUD_REDRAW_DEFAULT).toEqual({ kind: 'budget', hz: 10 })
    expect(HUD_REDRAW_DEFAULT_HZ).toBe(10)
    // Through the panel, not just the constant: `createHud()` takes no
    // argument at either production call site, so this is the cadence the
    // game flies on.
    const report = createHud().report()
    expect(report.cadence).toBe(describeHudRedraw(HUD_REDRAW_DEFAULT))
    expect(report.cadence).toBe('10hz')
    // The inversion, said out loud. Before DEV-248 this was `'live'`.
    expect(report.cadence).not.toBe('live')
  })

  /**
   * THE OTHER HALF OF THE INVERSION: the default WITHHOLDS, and it catches up.
   *
   * Ten frames spanning exactly one 100 ms interval, five of them signature
   * transitions. `live` paints all five (the test below). The default paints
   * the first — the panel must have something on it — withholds the next
   * seven frames, and pays the debt on the frame that lands ON the interval,
   * drawing the CURRENT state rather than the one that was owed.
   *
   * The counts are stated absolutely because each one is a different failure:
   * `repaints` 5 is a revert, `repaints` 1 is a budget with no `owed` flag
   * (the panel would hold a stale reading for the rest of the run), and
   * `skipped` 0 with `repaints` 2 would mean the arm removed nothing.
   */
  it('withholds those same transitions to the shipped rate, and pays the debt', () => {
    const recorder = installCanvas()
    const hud = createHud()
    const stream = tenFrames()

    for (const { s, at } of stream) hud.update(s, at)

    const report = hud.report()
    expect(report.repaints).toBe(2)
    expect(recorder.clears).toBe(2)
    // Seven frames wanted a paint and did not get one. The gap between this
    // and `transitionsOf` is the `owed` flag doing its work: only four of the
    // seven were themselves transitions, and the other three are frames that
    // moved nothing while a refusal was outstanding.
    expect(report.skipped).toBe(7)
    expect(transitionsOf(stream)).toBe(5)
    expect(report.repaints).toBeLessThan(transitionsOf(stream))

    // Nothing was LOST. The banner is the last thing the stream raises and it
    // reached the canvas — `owed` repaints the CURRENT reading, so the paint
    // that pays the debt carries everything that moved while it was owed.
    expect(recorder.strings).toContain('3')
  })

  it('`live` still paints once per signature transition, and not once more', () => {
    // The contract 2016 had and the panel shipped with until DEV-248, now
    // reached by the arm. `hudSignature` is exported, separately tested
    // (`hud-clock.test.ts`, `hud-speed-unit.test.ts`) and untouched by either
    // row — so counting its transitions is an expectation derived from
    // something OTHER than the budget, which is CLAUDE.md's trap 24: a test
    // that re-derives its expectation the way the code does has not tested the
    // code.
    const recorder = installCanvas()
    const hud = createHud()
    hud.setRedraw(HUD_REDRAW_LIVE)
    const stream = tenFrames()

    for (const { s, at } of stream) hud.update(s, at)

    expect(hud.report().repaints).toBe(transitionsOf(stream))
    // And the absolute number, written down, so a change to the SIGNATURE
    // itself is visible here rather than cancelling out against a recount.
    expect(transitionsOf(stream)).toBe(5)
    expect(recorder.clears).toBe(5)
    expect(hud.report().skipped).toBe(0)
  })

  it('asks three for one upload per repaint, plus CanvasTexture’s own', () => {
    // `uploads` is `texture.version`, three's counter. `CanvasTexture`'s
    // constructor sets `needsUpdate = true` itself, so the blank canvas is
    // uploaded once before `draw()` has ever run — a real upload, and the
    // reason the relationship is `+ 1` rather than equality.
    //
    // This is the assertion that would catch a `draw()` path returning without
    // a `needsUpdate` (a stale panel) or setting two (a doubled upload). Both
    // are invisible to `repaints`, which counts our own calls.
    installCanvas()
    const hud = createHud()
    for (const { s, at } of changingStream(40)) hud.update(s, at)
    const report = hud.report()
    expect(report.uploads).toBe(report.repaints + 1)
  })

  it('reports the canvas the panel actually allocated', () => {
    installCanvas()
    const report = createHud().report()
    // Not a magic pair: the panel's metres at its own pixel density, the same
    // relationship `perf-plate.test.ts` asserts for the plate.
    expect(report.pixels.width).toBe(Math.round(WIDTH * PIXELS_PER_METRE))
    expect(report.pixels.width).toBe(560)
    expect(report.pixels.height).toBe(203)
    expect(report.bytes).toBe(report.pixels.width * report.pixels.height * 4)
  })
})

describe('the budget’s arithmetic', () => {
  it('admits every change on `live`', () => {
    // DEV-248: named, not defaulted. The factory's default is the 10 Hz
    // budget now, so a bare `createHudRedrawBudget()` here would be testing
    // the shipped cadence under the name of the arm.
    const budget = createHudRedrawBudget(HUD_REDRAW_LIVE)
    for (let i = 0; i < 50; i += 1) expect(budget.admit(true, i * 11.11)).toBe(true)
    expect(budget.repaints).toBe(50)
  })

  it('never admits a frame whose signature did not move', () => {
    // At every cadence: the budget gates the PAINT, it does not invent one.
    for (const policy of [HUD_REDRAW_LIVE, { kind: 'freeze' } as const, redraw(10)]) {
      const budget = createHudRedrawBudget(policy)
      for (let i = 0; i < 20; i += 1) expect(budget.admit(false, i * 11.11)).toBe(false)
      expect(budget.repaints, describeHudRedraw(policy)).toBe(0)
    }
  })

  it('admits exactly one on `freeze`, however long the run', () => {
    const budget = createHudRedrawBudget({ kind: 'freeze' })
    const admitted = changingStream(900, 90).filter(({ at }) => budget.admit(true, at))
    expect(admitted).toHaveLength(1)
    // The FIRST one, not a later one — the panel has to have something on it.
    expect(admitted[0]?.at).toBe(0)
    expect(budget.repaints).toBe(1)
  })

  describe('a rate, on a stream that changes every single frame', () => {
    // The stream §3.5 is about: 90 Hz, ten seconds, the speed row moving on
    // every one of the 900 frames.
    for (const hz of [1, 2, 10, 30]) {
      it(`keeps ${hz} Hz on a 90 Hz frame stream`, () => {
        const budget = createHudRedrawBudget(redraw(hz))
        const at = changingStream(900, 90)
          .filter(({ at }) => budget.admit(true, at))
          .map((f) => f.at)

        // THE CONTRACT, and it is the strong form: no two paints are closer
        // together than the interval. "At most N a second" follows from it and
        // is true of any frame stream rather than of a tidy one.
        const interval = 1000 / hz
        for (let i = 1; i < at.length; i += 1) {
          const gap = (at[i] as number) - (at[i - 1] as number)
          expect(gap, `gap ${i} at ${hz} Hz`).toBeGreaterThanOrEqual(interval)
        }

        // ── The count, and why the bounds are DERIVED rather than guessed ──
        //
        // The first draft of this asserted `hz × seconds ± 1`, which is the
        // ideal and not the guarantee: the greedy rule paints at the first
        // frame AT OR AFTER `last + interval`, so each paint can land up to one
        // frame period late, and at 30 Hz against a 90 Hz stream that is the
        // difference between painting every third frame and every fourth. It is
        // decided by whether `(i+3)·1000/90 − i·1000/90` comes out a hair above
        // or a hair below `1000/30` in binary — which is not a property of the
        // budget and is not something a test should be pinned to.
        //
        // So both bounds come out of the mechanism and are true of any stream:
        //   · at most one paint per interval, plus the one at t = 0;
        //   · at least one per `interval + framePeriod`, because a paint can
        //     never be delayed by more than the wait for the next frame.
        const framePeriod = 1000 / 90
        const span = at.length === 0 ? 0 : (at[at.length - 1] as number)
        const T = (899 * 1000) / 90
        expect(at.length, 'more paints than the interval allows').toBeLessThanOrEqual(
          Math.floor(T / interval) + 1,
        )
        expect(
          at.length,
          'fewer paints than a frame-quantised interval can explain',
        ).toBeGreaterThanOrEqual(Math.floor(T / (interval + framePeriod)))

        // THE LIVENESS ASSERTION, and it is sharper than any count. A budget
        // that painted a handful of times and then stopped satisfies every
        // spacing bound above and every loose count bound; it cannot satisfy
        // this, because the last paint would sit seconds from the end.
        expect(
          T - span,
          `the budget stopped painting ${(T - span).toFixed(0)} ms before the end`,
        ).toBeLessThanOrEqual(interval + framePeriod)
        expect(budget.repaints).toBe(at.length)
      })
    }
  })

  it('paints the first change immediately, whatever the clock reads', () => {
    // The sentinel is `null`, not 0 and not −Infinity: a numeric sentinel would
    // make the first decision depend on how long boot took, which is a cadence
    // that behaves differently on a slow load.
    const budget = createHudRedrawBudget(redraw(1))
    expect(budget.admit(true, 987_654.321)).toBe(true)
  })

  it('does not restart the cadence when the same policy is re-asserted', () => {
    // `boot/app.ts` calls `setRedraw` every frame. If that reset the pacing,
    // the budget would admit every frame and the arm would silently be `live`.
    const budget = createHudRedrawBudget(redraw(10))
    let painted = 0
    for (const { at } of changingStream(900, 90)) {
      budget.set(redraw(10))
      if (budget.admit(true, at)) painted += 1
    }
    // 900 frames at 90 Hz is TEN seconds, so a 10 Hz budget paints about a
    // hundred times. A budget whose pacing was reset by the re-assertion would
    // admit every frame and report 900 — which is the failure this exists for,
    // and it is nine times the bound rather than a near miss.
    expect(painted).toBeLessThanOrEqual(101)
  })

  it('does restart it when the policy actually changes', () => {
    // An arm flipped on a live page has to show its first frame at once, or an
    // operator cannot tell "applied" from "applied and idle".
    const budget = createHudRedrawBudget(redraw(1))
    expect(budget.admit(true, 0)).toBe(true)
    expect(budget.admit(true, 100)).toBe(false) // inside the 1 Hz interval
    budget.set(redraw(10))
    expect(budget.admit(true, 101)).toBe(true)
  })

  it('reports the policy it is on', () => {
    // Starts on the factory default, which DEV-248 made the shipped budget.
    const budget = createHudRedrawBudget()
    expect(describeHudRedraw(budget.policy)).toBe('10hz')
    budget.set(HUD_REDRAW_LIVE)
    expect(describeHudRedraw(budget.policy)).toBe('live')
    budget.set({ kind: 'freeze' })
    expect(describeHudRedraw(budget.policy)).toBe('freeze')
    budget.set(redraw(10))
    expect(describeHudRedraw(budget.policy)).toBe('10hz')
  })
})

describe('a budget does not LOSE an update', () => {
  /**
   * The bug this branch nearly shipped, and the reason `update` carries an
   * `owed` flag.
   *
   * A signature that moves ONCE and then holds — a gate passed, a banner
   * raised, `SPEED: 0` on the pad — changes on exactly one frame. If that frame
   * falls inside the interval the paint is refused; every frame after it
   * compares equal to the stored signature and returns early. Without `owed`
   * the panel shows the PREVIOUS reading for the rest of the run, with every
   * number it holds correct and stale, which is the failure mode `hud.ts`'s own
   * header warns about twice for the clock row.
   */
  it('catches up after the interval when the state moved once and then held', () => {
    installCanvas()
    const hud = createHud()
    hud.setRedraw(redraw(10))

    // Frame 0: the run's first panel. Paints.
    hud.update(state({ speed: 100, banner: null }), 0)
    expect(hud.report().repaints).toBe(1)

    // Frame 1, 11 ms later and well inside the 100 ms interval: a gate goes by
    // and the count row changes. Refused.
    const afterGate = state({ speed: 100, banner: null, ringsPassed: 8 })
    hud.update(afterGate, 11)
    expect(hud.report().repaints).toBe(1)
    expect(hud.report().skipped).toBe(1)

    // Frames 2..8: nothing moves at all. Still refused, still owed.
    for (let i = 2; i <= 8; i += 1) hud.update(afterGate, i * 11)
    expect(hud.report().repaints).toBe(1)

    // Frame 9, past the interval, with the signature STILL unchanged since the
    // refusal. The unfixed shape returns early here and the panel never shows
    // the new gate count. This is the assertion.
    hud.update(afterGate, 110)
    expect(hud.report().repaints).toBe(2)

    // And it settles: nothing is owed any more, so a quiet panel stops
    // repainting rather than ticking along at the budget for ever.
    for (let i = 11; i <= 40; i += 1) hud.update(afterGate, i * 11)
    expect(hud.report().repaints).toBe(2)
  })

  /**
   * THE SAME CLAIM AT THE SHIPPED DEFAULT, with no `setRedraw` anywhere.
   *
   * The test above proves `owed` works on a policy somebody asked for. DEV-248
   * makes it the policy every player flies on, so it is worth one test that
   * touches no lever at all: if the flag ever regressed, the panel would go
   * stale for every run of the game and only an arm-driven test would notice.
   */
  it('the SHIPPED default pays an owed paint too, with no arm set', () => {
    installCanvas()
    const hud = createHud()
    hud.update(state({ speed: 100 }), 0)
    const afterGate = state({ speed: 100, ringsPassed: 8 })
    hud.update(afterGate, 11)
    expect(hud.report().repaints).toBe(1)
    expect(hud.report().skipped).toBe(1)
    for (let i = 2; i <= 8; i += 1) hud.update(afterGate, i * 11)
    expect(hud.report().repaints).toBe(1)
    hud.update(afterGate, 110)
    expect(hud.report().repaints).toBe(2)
  })
})

// ── DEV-248: what the shipped cadence can make stale, and what it cannot ───
//
// The readability question Matt's call raises: at ~9 Hz the speed row updates
// every ~110 ms. What follows is that number derived rather than repeated, and
// then the two rows where a lag could be a BUG rather than a coarseness.
//
// The budget's guarantee is *"no two paints are closer together than
// `1000 / hz` ms"*, and `update` is called once a frame, so the longest a
// signature change can wait is one interval plus one frame — the change lands
// just after a paint, and the first frame at or past the interval takes it.
// At 90 fps that is 111.1 ms and at 72 fps 113.9. It is a DELAY and never a
// DROP, because `owed` repaints on the next admission whether or not anything
// moved on that frame.
//
// Row by row, at 10 Hz:
//
//  · **the gate counter** — one change per gate, seconds apart. Up to ~111 ms
//    late behind a sound and a gate going past the canopy. Never skipped.
//  · **the clock** — `formatTime` rounds to whole seconds, so it changes at
//    1 Hz. Two transitions cannot fall inside one 100 ms interval, so every
//    second is drawn; each tick is up to ~111 ms late, which is a wobble in
//    WHEN the second turns over and never a second that does not appear.
//  · **the speed** — the row this is all for. It stepped ~48 times a second
//    and now steps ~9, and intermediate integers are genuinely discarded.
//    The reading is never more than ~111 ms old; how many units that is
//    depends on the acceleration at the moment, and in km/h (Anniversary's
//    unit, `hud.speedUnit`) the integer moves 3.6x as fast, so the budget
//    withholds MORE there and the panel is that much steadier.
//  · **the two sliding bars (DEV-110) and the tank (DEV-143)** — already
//    quantised to 20 / 20 / 40 steps for this exact reason. The tank moves
//    16 % of the bar a second at the Anniversary rate, i.e. 6.4 steps/s,
//    which is inside 9 Hz and therefore unaffected. The proximity meter can
//    cross its range faster than that on a dive, and there the bar glides in
//    ~9 steps a second instead of ~20. Coarser, not wrong.
//  · **the banners** — the case to check hardest, and the one below. A banner
//    has a WINDOW, and a budget that DROPPED an update rather than delaying
//    it could let a banner miss its own. `owed` is what rules that out, and
//    the arithmetic is what bounds it: the shortest window the game raises is
//    0.8 s against a worst lag of ~111 ms.

/** The worst a change can lag at `hz`, on a frame stream of `fps`. */
const worstLagMs = (hz: number, fps: number): number => 1000 / hz + 1000 / fps

describe('DEV-248: what the shipped cadence can make stale, and for how long', () => {
  it('bounds the lag at one interval plus one frame, at every phase', () => {
    // Swept rather than sampled. A single phase proves nothing about a rate
    // limiter — the interesting case is a change arriving just after a paint,
    // and "just after" is a phase, not a moment.
    const fps = 90
    const frame = 1000 / fps
    const bound = worstLagMs(HUD_REDRAW_DEFAULT_HZ, fps)
    expect(bound).toBeCloseTo(111.1, 1)

    for (let phase = 1; phase < 9; phase += 1) {
      const recorder = installCanvas()
      const hud = createHud()
      // Frame 0 paints and starts the interval.
      hud.update(state({ speed: 100 }), 0)
      const before = recorder.clears
      // The change arrives at `phase` frames in and then HOLDS, which is the
      // worst shape: nothing later re-triggers the comparison.
      const moved = state({ speed: 100, ringsPassed: 8 })
      const changedAt = phase * frame
      let paintedAt: number | null = null
      for (let i = phase; i < 60; i += 1) {
        const at = i * frame
        hud.update(moved, at)
        if (paintedAt === null && recorder.clears > before) paintedAt = at
      }
      expect(paintedAt, `phase ${phase}`).not.toBeNull()
      expect((paintedAt ?? 0) - changedAt, `phase ${phase}`).toBeLessThanOrEqual(bound)
    }
  })

  it('draws every clock second — a 1 Hz row cannot lose a tick to a 10 Hz budget', () => {
    // The clock is the row `hud.ts`'s own header warns about twice, and it is
    // the one where a lag would be a BUG: a second that never appears reads
    // as a stopped clock. Two transitions cannot share a 100 ms interval when
    // they are a second apart, so every one is drawn.
    const recorder = installCanvas()
    const hud = createHud()
    const fps = 90
    const seen = new Set<string>()
    for (let i = 0; i < fps * 6; i += 1) {
      const s = state({ speed: 100, elapsed: 10 + i / fps })
      seen.add(hudSignature(s))
      hud.update(s, (i * 1000) / fps)
    }
    // Six distinct clock texts over six seconds, and the panel painted each.
    expect(seen.size).toBe(6)
    expect(hud.report().repaints).toBe(6)
    expect(recorder.clears).toBe(6)
  })

  it('cannot let the shortest banner the GAME raises miss its own window', () => {
    // The arithmetic first, then the panel.
    //
    // The windows are read out of `boot/app.ts` rather than written down here,
    // because a literal in a test is a second copy of a number that lives
    // somewhere else — and the failure this guards against is somebody ADDING
    // a banner shorter than the interval, which a literal could never see.
    const app = appSource()
    const windows: number[] = []
    const symbolic: string[] = []
    for (const m of app.matchAll(/until:\s*mission\.elapsed\s*\+\s*([^,}\n]+)/g)) {
      const raw = (m[1] ?? '').trim()
      const n = Number(raw)
      if (Number.isFinite(n)) windows.push(n)
      else symbolic.push(raw)
    }
    // The symbolic windows are imported rather than parsed: the pad banner's,
    // and DEV-342's "OUT OF FUEL". ANOTHER symbolic one would be a window this
    // test cannot see, so it fails rather than ignoring it.
    expect([...symbolic].sort()).toEqual([
      'OVERTAKE.nameSeconds',
      'STRANDED_BANNER_SECONDS',
      'hit.seconds',
    ])
    windows.push(PAD_BANNER_SECONDS, STRANDED_BANNER_SECONDS, OVERTAKE.nameSeconds)
    expect(windows.length).toBeGreaterThanOrEqual(8)

    const shortest = Math.min(...windows)
    // 0.8 s — `CLOSE` and `LOW`, both Anniversary-only and both already
    // guarded against replacing a live award.
    expect(shortest).toBe(0.8)
    // The claim: the worst lag is a fraction of the shortest window, at the
    // slowest frame rate the pass rule contemplates.
    expect(worstLagMs(HUD_REDRAW_DEFAULT_HZ, 72)).toBeLessThan(shortest * 1000)

    // And through the panel, swept over the phase, at the shortest window.
    const fps = 90
    const frame = 1000 / fps
    const held = Math.round((shortest * 1000) / frame)
    for (let phase = 1; phase < 9; phase += 1) {
      const recorder = installCanvas()
      const hud = createHud()
      hud.update(state({ speed: 100 }), 0)
      for (let i = 1; i < 40; i += 1) {
        const inWindow = i >= phase && i < phase + held
        hud.update(
          state({ speed: 100, award: inWindow ? 'CLOSE  +20' : null, awardTone: 'gain' }),
          i * frame,
        )
      }
      // `hud.ts:1591` draws the award upper-cased, which is what a player
      // sees — asserted on the string the canvas was handed, not on a count.
      expect(recorder.strings, `phase ${phase}`).toContain('CLOSE  +20')
    }
  })
})

describe('the panel, through each arm', () => {
  it('`freeze` draws once and never touches the canvas again', () => {
    const recorder = installCanvas()
    const hud = createHud()
    hud.setRedraw({ kind: 'freeze' })
    for (const { s, at } of changingStream(900)) hud.update(s, at)

    const report = hud.report()
    expect(report.cadence).toBe('freeze')
    expect(report.repaints).toBe(1)
    // Two independent witnesses that the 2-D context stopped being written to:
    // the clear at the top of `draw` and the text it lays down.
    expect(recorder.clears).toBe(1)
    expect(recorder.texts).toBeGreaterThan(0)
    const textsAfterFirst = recorder.texts
    hud.update(state({ speed: 999 }), 99_999)
    expect(recorder.texts).toBe(textsAfterFirst)
    // And three is asked for exactly the constructor's upload plus that one.
    expect(report.uploads).toBe(2)
    // **`skipped` is what proves the arm fired.** `repaints: 1` alone is also
    // what a flight where nothing ever moved would report.
    expect(report.skipped).toBeGreaterThan(800)
  })

  it('a rate cuts the uploads by about the ratio, and says so in its counts', () => {
    const recorder = installCanvas()
    const hud = createHud()
    hud.setRedraw(redraw(10))
    for (const { s, at } of changingStream(900, 90)) hud.update(s, at)

    const report = hud.report()
    expect(report.cadence).toBe('10hz')
    // TEN seconds at 10 Hz — 900 frames at 90 Hz is ten seconds, not one.
    // Bounded by the mechanism the way the budget's own test is: at most one
    // per 100 ms plus the one at t = 0, at least one per 100 + 11.1 ms.
    expect(report.repaints).toBeLessThanOrEqual(101)
    expect(report.repaints).toBeGreaterThanOrEqual(89)
    expect(recorder.clears).toBe(report.repaints)
    expect(report.uploads).toBe(report.repaints + 1)
    expect(report.skipped).toBe(900 - report.repaints)
    // Nothing was drawn twice for one admission, and nothing quietly stopped.
    expect(report.unchanged).toBe(0)
  })

  it('the same stream at `live` repaints on every frame — the thing being cut', () => {
    // The control. Without it "10 Hz gave 10 repaints" says nothing about what
    // was saved, because a stream that only changed ten times would give the
    // same number at `live`.
    installCanvas()
    const hud = createHud()
    hud.setRedraw(HUD_REDRAW_LIVE) // DEV-248: the arm, named
    for (const { s, at } of changingStream(900, 90)) hud.update(s, at)
    expect(hud.report().repaints).toBe(900)
    expect(hud.report().skipped).toBe(0)
  })

  it('switches cadence on a live panel without rebuilding it', () => {
    // perf-protocol §3d: one load, two readings. An arm that needed a reload
    // would be a second measurement of a different page.
    installCanvas()
    const hud: Hud = createHud()
    hud.setRedraw(HUD_REDRAW_LIVE) // DEV-248: this leg is the arm, so name it
    const frames = changingStream(900, 90)

    for (const { s, at } of frames.slice(0, 90)) hud.update(s, at)
    const afterLive = hud.report().repaints
    expect(afterLive).toBe(90)

    hud.setRedraw(redraw(10))
    for (const { s, at } of frames.slice(90, 450)) hud.update(s, at)
    const afterBudget = hud.report().repaints - afterLive
    // 360 frames at 90 Hz is four seconds, so a 10 Hz arm paints about forty
    // times where `live` painted 360. Bounded on BOTH sides, and both bounds
    // from the mechanism rather than the ideal: at most one per 100 ms plus the
    // one at the switch, at least one per 100 + 11.1 ms. The lower one catches
    // an arm that applied and then stopped.
    expect(afterBudget).toBeLessThanOrEqual(41)
    expect(afterBudget).toBeGreaterThanOrEqual(35)

    hud.setRedraw(HUD_REDRAW_LIVE)
    for (const { s, at } of frames.slice(450)) hud.update(s, at)
    expect(hud.report().repaints - afterLive - afterBudget).toBe(450)
  })
})

describe('the pin parses, and round-trips through what the probe prints', () => {
  it('reads the three arms', () => {
    expect(parseHudRedraw('live')).toEqual({ kind: 'live' })
    expect(parseHudRedraw('freeze')).toEqual({ kind: 'freeze' })
    expect(parseHudRedraw('10')).toEqual({ kind: 'budget', hz: 10 })
    expect(parseHudRedraw('10hz')).toEqual({ kind: 'budget', hz: 10 })
    expect(parseHudRedraw('  FREEZE ')).toEqual({ kind: 'freeze' })
  })

  it('round-trips: what the probe prints parses back to the same arm', () => {
    // The e2e mechanism check compares the probe's `cadence` against the arm it
    // asked for, so the two spellings have to be one spelling. A string built
    // ad hoc at each call site is how a run comes to refuse its own arm.
    for (const raw of ['live', 'freeze', '10', '2', '30hz', '0.5']) {
      const parsed = parseHudRedraw(raw)
      expect(parsed, raw).not.toBeNull()
      expect(parseHudRedraw(describeHudRedraw(parsed as HudRedraw))).toEqual(parsed)
    }
  })

  it('refuses what it cannot mean, rather than guessing', () => {
    // `'hz'` is in the list because `Number('')` is 0 and a bare unit must not
    // fall through as a rate of nought — which would be an interval of
    // Infinity wearing a budget's name.
    for (const raw of ['', '  ', 'yes', 'fast', 'NaN', '-5', 'Infinity', 'hz']) {
      expect(parseHudRedraw(raw), raw).toBeNull()
    }
    expect(parseHudRedraw(null)).toBeNull()
    expect(parseHudRedraw(undefined)).toBeNull()
  })

  it('refuses a rate outside the band, at both ends', () => {
    expect(parseHudRedraw(String(HUD_REDRAW_MIN_HZ))).not.toBeNull()
    expect(parseHudRedraw(String(HUD_REDRAW_MAX_HZ))).not.toBeNull()
    expect(parseHudRedraw(String(HUD_REDRAW_MIN_HZ / 2))).toBeNull()
    expect(parseHudRedraw(String(HUD_REDRAW_MAX_HZ + 1))).toBeNull()
    // The ceiling is above any display this game runs on, so a budget AT the
    // cap is indistinguishable from `live` rather than a silent third thing.
    expect(HUD_REDRAW_MAX_HZ).toBeGreaterThan(144)
  })

  it('reads `0` as a freeze rather than as a division by zero', () => {
    // A rate of nought is not a rate. Taken literally it would be an interval
    // of Infinity, which is a freeze that reports itself as `0hz` — one
    // behaviour under two names, and the e2e check compares names. So the unit
    // comes off BEFORE the keyword tests and both spellings land on one answer.
    expect(parseHudRedraw('0')).toEqual({ kind: 'freeze' })
    expect(parseHudRedraw('0hz')).toEqual({ kind: 'freeze' })
    expect(parseHudRedraw('freeze')).toEqual(parseHudRedraw('0'))
  })
})

describe('the panel is still a panel', () => {
  it('stays on the scene graph and stays drawable at every cadence', () => {
    // The measurement this is FOR turns on the difference between a frozen
    // panel and a hidden one: `?hudRedraw=freeze` must leave the quad in the
    // frame, both eyes, every frame, so that the gap against the
    // `jumpseat/hud` hide is the panel's own presence. A freeze that also hid
    // it would collapse the two arms into one and the answer would be lost.
    installCanvas()
    for (const policy of [HUD_REDRAW_LIVE, { kind: 'freeze' } as const, redraw(10)]) {
      const hud = createHud()
      hud.setRedraw(policy)
      for (const { s, at } of changingStream(120)) hud.update(s, at)
      const mesh = hud.object as THREE.Mesh
      expect(mesh.visible, describeHudRedraw(policy)).toBe(true)
      expect(mesh.name).toBe('hud')
      // And the map is still the live texture, so three still binds it.
      expect((mesh.material as THREE.MeshBasicMaterial).map).not.toBeNull()
    }
  })
})

// ── The rate, and the two-panel comparison it exists for ───────────────────
//
// The coordinator's question, after the measurements landed: **why does
// `int_01_hoverJet` pay roughly six times what `adv_02_jumpSeat` pays for the
// same panel?** (p50 −2.01 against −0.36.) The rate hypothesis says the two
// missions repaint at different rates; `rateHz` here and `hud_paints` in the
// trace are what confirm or kill it, and this suite's job is that the number
// means what its name says before anybody reads one off a rig.

describe('the repaint RATE', () => {
  it('is repaints per second of the panel’s LIFE, not per second of painting', () => {
    // The distinction that makes the number worth having. A rate measured
    // between paints would be `1 / interval` by construction and would read
    // 10 Hz for a 10 Hz budget on every mission, including one where the panel
    // never moved — which is exactly the case the 6x question has to separate.
    const counter = createPanelCounter()
    // The trailing `true` at every `report()` below is DEV-244's
    // `generateMipmaps`, which the counter needs to say what a chain costs.
    // These probes are about the RATE and carry the shipped answer; the
    // argument is required rather than defaulted so that no caller can have
    // `mipBytes` assert a chain on its behalf.
    //
    // Ten seconds of life, four paints in the first second and nothing after.
    for (let t = 0; t <= 10_000; t += 100) counter.seen(t)
    for (const t of [0, 250, 500, 750]) counter.painted(t)
    const r = counter.report('probe', 10, 10, 5, true)
    expect(r.seconds).toBeCloseTo(10, 6)
    expect(r.rateHz).toBeCloseTo(0.4, 6)
  })

  it('is zero, not Infinity, before the window has opened', () => {
    // A rate over no time is an unanswered question, not a large rate — and
    // `Infinity` in a probe line is the kind of thing that gets pasted into a
    // report.
    const fresh = createPanelCounter()
    expect(fresh.report('probe', 10, 10, 1, true).rateHz).toBe(0)
    expect(fresh.report('probe', 10, 10, 1, true).seconds).toBe(0)
    const once = createPanelCounter()
    once.seen(1234)
    once.painted(1234)
    expect(once.report('probe', 10, 10, 2, true).rateHz).toBe(0)
  })

  it('folds size and rate into bytesPerSecond, which is the comparison', () => {
    const counter = createPanelCounter()
    for (let t = 0; t <= 2000; t += 100) counter.seen(t)
    for (let t = 0; t <= 2000; t += 500) counter.painted(t)
    const r = counter.report('probe', 100, 50, 6, true)
    expect(r.bytes).toBe(100 * 50 * 4)
    expect(r.rateHz).toBeCloseTo(2.5, 6)
    expect(r.bytesPerSecond).toBeCloseTo(r.bytes * r.rateHz, 6)
  })

  it('reports a live HUD’s rate over the clock the caller passed', () => {
    installCanvas()
    const hud = createHud()
    hud.setRedraw(redraw(10))
    for (const { s, at } of changingStream(900, 90)) hud.update(s, at)
    const r = hud.report()
    // Ten seconds of stream. A 10 Hz arm should read about 10 Hz — the whole
    // point being that a reader can tell it from the ~90 Hz `live` arm below
    // without counting anything themselves.
    expect(r.seconds).toBeCloseTo(9.99, 1)
    expect(r.rateHz).toBeGreaterThan(8.5)
    expect(r.rateHz).toBeLessThan(10.5)
    expect(r.rateHz).toBeCloseTo(r.repaints / r.seconds, 6)
  })

  it('separates `live` from a budget by an order of magnitude in one number', () => {
    // The assertion the 6x question turns on: `bytesPerSecond` has to be the
    // thing that moves, by the ratio of the rates, on one panel of one size.
    installCanvas()
    const live = createHud()
    live.setRedraw(HUD_REDRAW_LIVE) // DEV-248: the arm, named
    for (const { s, at } of changingStream(900, 90)) live.update(s, at)
    installCanvas()
    const budgeted = createHud()
    budgeted.setRedraw(redraw(10))
    for (const { s, at } of changingStream(900, 90)) budgeted.update(s, at)

    const a = live.report()
    const b = budgeted.report()
    expect(a.bytes).toBe(b.bytes)
    expect(a.bytesPerSecond / b.bytesPerSecond).toBeGreaterThan(8)
  })
})

describe('the perf plate is the same instrument, so it reports the same shape', () => {
  // DEV-243 §2b. The plate is the CONTROL: same kind of object, same parent,
  // same pixel density, 49 % more canvas, a fraction of the rate. The row only
  // reads if both panels are measured the same way, so the counter is shared
  // and this is the test that says so.

  it('is BIGGER than the HUD, which is the direction that matters', () => {
    // If the plate were smaller, "the bigger panel costs less" would not be
    // available as an argument and the control would prove much less. Stated
    // as the RELATIONSHIP rather than as two pinned pairs of numbers.
    installCanvas()
    const hudPixels = createHud().report().pixels
    installCanvas()
    const platePixels = createPerfPlate().report().pixels
    expect(platePixels.width * platePixels.height).toBeGreaterThan(
      hudPixels.width * hudPixels.height,
    )
    // And it is the plate's own metres at the HUD's density, not a magic pair.
    expect(platePixels.width).toBe(Math.round(PLATE_W * PIXELS_PER_METRE))
    expect(platePixels.height).toBe(Math.round(PLATE_H * PIXELS_PER_METRE))
  })

  it('counts repaints, uploads and a rate the same way the HUD does', () => {
    installCanvas()
    const plate = createPerfPlate()
    // Four seconds at the 4 Hz `app.ts` drives it with, and the rows change on
    // every other call — a plate whose numbers have settled does not repaint.
    for (let i = 0; i < 16; i += 1) {
      plate.update([`row ${Math.floor(i / 2)}`], i * 250)
    }
    const r = plate.report()
    expect(r.panel).toBe('perf-plate')
    expect(r.repaints).toBe(8)
    expect(plate.paints).toBe(8)
    // three's own counter again: one for `CanvasTexture`'s constructor.
    expect(r.uploads).toBe(r.repaints + 1)
    expect(r.seconds).toBeCloseTo(3.75, 6)
    expect(r.rateHz).toBeCloseTo(8 / 3.75, 6)
  })

  it('never repaints for rows that did not change', () => {
    installCanvas()
    const plate = createPerfPlate()
    for (let i = 0; i < 40; i += 1) plate.update(['steady', 'rows'], i * 250)
    expect(plate.report().repaints).toBe(1)
    expect(plate.paints).toBe(1)
  })
})

/** `{ kind: 'budget', hz }`, spelled once. */
function redraw(hz: number): HudRedraw {
  return { kind: 'budget', hz }
}
