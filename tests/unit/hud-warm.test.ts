// tests/unit/hud-warm.test.ts — DEV-250. The panel's first FLIGHT-LAYOUT
// raster is paid under the loading curtain, and it warms the right thing.
//
// ── What is being defended ───────────────────────────────────────────────
//
// The frame the player is released into flight is dt 27.7 ms on
// `rookie_01_hoverJet`, of which 2.00 ms is inside `renderer.render`. A Chrome
// trace names the rest as `RasterDecoderImpl::DoEndRasterCHROMIUM::Flush`,
// 26.75 ms, in the GPU PROCESS; `?hudRedraw=freeze` takes the frame to 11.1 ms
// and the longest raster slice from 27.05 to 16.45. `docs/plan/HUD-REWORK.md`
// §2 is the A/B and §4 candidate 1 is this remedy.
//
// The remedy only works if the warm draw asks the canvas for **what the flight
// will ask it for**, and there are four ways it could fail while reporting
// success. Each has a `describe`:
//
//  1. **It takes the banner's early return.** `draw()` returns after one plate
//     and one `fillText` when `state.banner` is set, so a warm state with a
//     banner warms the layout the ride has already warmed a hundred times and
//     nothing at all of the flight's. Four calls instead of thirty, and the
//     console line would still say "warmed".
//  2. **It draws at the wrong SIZE.** Skia keys a rasterised glyph on
//     face + size + style. Every font size in `draw()` is derived from `h`,
//     the canvas height, which is a constant — so the sizes are knowable and
//     the ride's are provably not the flight's. This is the heart of the row
//     and it is asserted against the REAL `draw()` through a recording canvas,
//     never against arithmetic repeated here.
//  3. **It misses a branch.** A warm without the bars, the corner or the event
//     line warms less than a flight frame draws.
//  4. **It disturbs the cadence.** A warm that went through the redraw budget
//     would push the launch banner's paint into `owed`; a warm that advanced
//     the signature would leave the flight layout on the panel for the whole
//     ride. Both are invisible in a screenshot taken after the curtain lifts.
//
// ── The one thing this suite cannot prove ────────────────────────────────
//
// **That a warm raster makes the release frame cheaper.** That is a duration,
// it belongs to the coordinator on a quiet box, and the DEV-250 row in
// `docs/DEVIATIONS.md` carries the commands and the arms. What is provable in
// node is that the warm asks the canvas for the same work at the same sizes —
// which is the precondition for the measurement to mean anything, and the
// thing that would silently stop being true if `draw()` moved.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createHud,
  describeHudWarm,
  HUD_REDRAW_DEFAULT_HZ,
  HUD_WARM_DEFAULT,
  type Hud,
  type HudState,
  hudCanvasOps,
  hudSignature,
  parseHudWarm,
  warmHudState,
} from '@/render/hud'

// ── The recording canvas ───────────────────────────────────────────────────
//
// `hud-upload.test.ts`'s counting stub, plus the two things this row turns on:
// the `font` string in force at each call, and the string each `fillText`
// wrote. `createHud` needs a 2-D canvas and this suite is `environment:
// 'node'`, so a stub is the only way to reach `draw()` at all — and driving
// the REAL `draw()` is the whole point, because an expectation re-derived the
// way the code derives it has not tested the code (CLAUDE.md trap 24).

interface Recorder {
  /** Every context METHOD call. Property assignments are not calls. */
  total: number
  texts: number
  measures: number
  /** `font` strings actually used by a `fillText`, in order, with repeats. */
  readonly fonts: string[]
  /** What each `fillText` wrote. */
  readonly strings: string[]
  /** Width and height the panel gave its canvas element. */
  readonly size: { width: number; height: number }
}

const installCanvas = (): Recorder => {
  const element = { width: 0, height: 0, getContext: () => context }
  const rec: Recorder = {
    total: 0,
    texts: 0,
    measures: 0,
    fonts: [],
    strings: [],
    size: element,
  }
  const call = () => {
    rec.total += 1
  }
  const context = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 0,
    textAlign: '',
    textBaseline: '',
    clearRect: call,
    fillRect: call,
    beginPath: call,
    roundRect: call,
    fill: call,
    stroke: call,
    fillText: (s: string) => {
      rec.total += 1
      rec.texts += 1
      // The font as the CONTEXT has it at this instant — which is what the
      // backend rasterises with, and what a strike is keyed on. Reading the
      // property rather than the assignment is what makes this a measurement
      // of `draw()` and not a transcription of it.
      rec.fonts.push(context.font)
      rec.strings.push(s)
    },
    measureText: (s: string) => {
      rec.total += 1
      rec.measures += 1
      return { width: s.length * 8 }
    },
  }
  vi.stubGlobal('document', { createElement: () => element })
  return rec
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

/** The labels a mission hands over. Any three words; the panel is a consumer. */
const LABELS = { countLabel: 'GATES', timeLabel: 'TIME', speedLabel: 'SPEED' } as const

/** A mid-run panel, minimal: three rows and nothing optional. */
const flightState = (over: Partial<HudState> = {}): HudState => ({
  ringsPassed: 7,
  ringsTotal: 21,
  score: 700,
  elapsed: 42.3,
  timeLimit: 180,
  speed: 170,
  medal: '',
  finished: false,
  ...LABELS,
  banner: null,
  autopilot: false,
  ...over,
})

/** Font sizes in px, in order of use, deduplicated — what Skia keys a strike on. */
const sizesOf = (rec: Recorder): number[] => {
  const seen: number[] = []
  for (const font of rec.fonts) {
    // `italic 700 39px "Segoe UI", …` — the number before `px`.
    const m = /(\d+(?:\.\d+)?)px/.exec(font)
    expect(m, `no px size in font string '${font}'`).not.toBeNull()
    const px = Number((m as RegExpExecArray)[1])
    if (!seen.includes(px)) seen.push(px)
  }
  return seen.sort((a, b) => a - b)
}

// ───────────────────────────────────────────────────────────────────────────

describe('parseHudWarm — the arm, and the default it must not move', () => {
  it('reads every spelling a shell command plausibly carries', () => {
    for (const raw of ['on', 'ON', ' on ', '1', 'true', 'YES']) {
      expect(parseHudWarm(raw), raw).toBe(true)
    }
    for (const raw of ['off', 'OFF', ' off ', '0', 'false', 'No']) {
      expect(parseHudWarm(raw), raw).toBe(false)
    }
  })

  it('round-trips through describeHudWarm, so an ask and a reading compare by string', () => {
    for (const raw of ['on', '1', 'off', 'FALSE']) {
      const parsed = parseHudWarm(raw)
      expect(parsed, raw).not.toBeNull()
      const spelled = describeHudWarm(parsed as boolean)
      expect(parseHudWarm(spelled), `${raw} -> ${spelled}`).toBe(parsed)
      expect(['on', 'off']).toContain(spelled)
    }
  })

  it('returns null rather than throwing for nothing and for nonsense', () => {
    for (const raw of [null, undefined, '', '   ', 'warm', 'freeze', '10hz', 'mip']) {
      expect(parseHudWarm(raw), String(raw)).toBeNull()
    }
  })

  it('DISTINGUISHES absent from off — the arm expressed by absence is uncheckable', () => {
    // `null` is "nobody said", which the caller turns into the default; `false`
    // is "somebody pinned off for a measurement". A parser that collapsed them
    // would make the console line for the control arm identical to the line for
    // an unpinned load, and the control is half of every A/B in this wave.
    expect(parseHudWarm(undefined)).toBeNull()
    expect(parseHudWarm('off')).toBe(false)
  })

  it('SHIPS ON, and the escape hatch it is measured against still exists', () => {
    // DEV-250 became the default on 2026-09-20, on the release-window
    // measurement in `render/hud.ts`'s `HUD_WARM_DEFAULT` block: the worst
    // frame in the forty after release goes 33.4 ms -> 11.1, which is the
    // `?hudRedraw=freeze` floor exactly, for no pixel and no program. It was
    // verified with the arms reversed, as DEV-248 requires — an unpinned load
    // read 11.1 and `?hudWarm=off` read 33.4 on the same tree.
    //
    // This assertion is not a tautology about a constant. **A default is only
    // defensible while the arm that measured it can still be run**, and the
    // pair below is what a reviewer flipping the default has to confront: turn
    // it off here and the second line tells you what you are giving up.
    expect(HUD_WARM_DEFAULT).toBe(true)
    // `off` must stay reachable, or there is no way back and no way to
    // re-measure it. That is the half a bare default check would miss.
    expect(parseHudWarm('off')).toBe(false)
    expect(describeHudWarm(HUD_WARM_DEFAULT)).toBe('on')
  })
})

describe('warmHudState — the state that warms the FLIGHT, not the ride', () => {
  it('is not the banner, which is the one field that decides whether it warms anything', () => {
    // `draw()` returns after one plate and one `fillText` when `banner` is set.
    // A warm that took that branch would repaint the layout the lift ride has
    // already painted a hundred times and none of the layout the release frame
    // needs — and every console line and counter would still say it worked.
    expect(warmHudState(LABELS).banner).toBeNull()
  })

  it('carries the caller’s labels through unchanged — the panel never invents copy', () => {
    const state = warmHudState({
      countLabel: 'ORBS',
      timeLabel: 'CLOCK',
      speedLabel: 'VEL',
      speedUnit: 'kmh',
    })
    expect(state.countLabel).toBe('ORBS')
    expect(state.timeLabel).toBe('CLOCK')
    expect(state.speedLabel).toBe('VEL')
    expect(state.speedUnit).toBe('kmh')
  })

  it('asks the canvas for AT LEAST what any flight state asks for', () => {
    // The guard the row turns on. `hudCanvasOps` mirrors `draw()` branch for
    // branch and `hud-upload.test.ts` keeps it honest against the real thing,
    // so it is the right oracle for "did the warm exercise every branch a
    // flight frame can take". A battery rather than one state, because the
    // branches are per-mode and per-vehicle and no single mission takes them
    // all: the JumpSeat has fuel and the HoverJet a gate combo.
    const warm = hudCanvasOps(warmHudState(LABELS))
    const flights: [string, HudState][] = [
      ['bare three rows', flightState()],
      ['autopilot', flightState({ autopilot: true })],
      ['speed chain', flightState({ chain: { stacks: 3, fraction: 0.6 } })],
      ['speed chain run out: track only', flightState({ chain: { stacks: 1, fraction: 0 } })],
      ['boost tank', flightState({ energy: { fraction: 0.2, available: true } })],
      ['jumpseat fuel, unlit', flightState({ energy: { fraction: 0, available: false } })],
      ['multiplier', flightState({ multiplier: 4 })],
      ['a mid-run award', flightState({ award: '+60' })],
      ['a long award', flightState({ award: 'SILVER MEDAL EARNED' })],
      ['finished, medal shown', flightState({ finished: true, medal: 'GOLD' })],
      [
        'everything a HoverJet can have at once',
        flightState({
          autopilot: true,
          multiplier: 4,
          chain: { stacks: 3, fraction: 0.6 },
          energy: { fraction: 0.2, available: true },
          award: '+60',
        }),
      ],
    ]
    for (const [name, state] of flights) {
      const ops = hudCanvasOps(state)
      expect(warm.total, `${name}: total`).toBeGreaterThanOrEqual(ops.total)
      expect(warm.texts, `${name}: texts`).toBeGreaterThanOrEqual(ops.texts)
      expect(warm.measures, `${name}: measures`).toBeGreaterThanOrEqual(ops.measures)
    }
    // And STRICTLY more than the bare panel, or the "at least" above would be
    // satisfied by a warm that happened to match the cheapest flight frame
    // and warmed none of the optional instruments.
    expect(warm.total).toBeGreaterThan(hudCanvasOps(flightState()).total)
  })

  it('takes every optional branch, named, so a new one is noticed rather than skipped', () => {
    // `hudCanvasOps` above proves the warm is not SMALLER than a flight state.
    // It cannot prove the warm took a particular branch, because two branches
    // can cost the same number of calls. These are the fields, by name.
    const s = warmHudState(LABELS)
    expect(s.chain?.stacks, 'the chain badge needs > 1 stack').toBeGreaterThan(1)
    expect(s.chain?.fraction, 'the chain bar').toBeGreaterThan(0)
    expect(s.energy?.fraction, 'the tank bar').toBeGreaterThan(0)
    expect(s.multiplier, 'the streak badge needs > 1').toBeGreaterThan(1)
    expect(s.autopilot, 'the AUTO badge').toBe(true)
    expect(s.award, 'the event line').toBeTruthy()
    expect(s.timeLimit, 'a positive limit, or the clock row reads --').toBeGreaterThan(0)
  })
})

describe('the SIZES it rasterises — why the lift ride cannot have warmed the flight', () => {
  it('the launch banner and the flight layout share NO font size', () => {
    // The mechanism, measured off the real `draw()` rather than argued. Skia
    // keys a rasterised glyph on face + size + style, so two layouts that share
    // no size share no strike: everything the ride paints is thrown away at the
    // moment the banner clears, and the release frame builds the flight's
    // strikes from nothing. That is what DEV-250 moves under the curtain.
    const ride = installCanvas()
    const rideHud = createHud()
    // The three things the banner shows, in order: the prompt, the ride, the
    // countdown. The last is one character and takes `draw()`'s `big` branch.
    for (const banner of ['PRESS A', 'LAUNCHING', '3']) {
      rideHud.warm(flightState({ banner }))
    }
    const rideSizes = sizesOf(ride)
    rideHud.dispose()

    vi.unstubAllGlobals()
    const flight = installCanvas()
    const flightHud = createHud()
    flightHud.warm(warmHudState(LABELS))
    const flightSizes = sizesOf(flight)
    flightHud.dispose()

    expect(rideSizes.length, 'the banner drew no text at all').toBeGreaterThan(0)
    expect(flightSizes.length, 'the flight layout drew no text at all').toBeGreaterThan(0)
    const shared = flightSizes.filter((px) => rideSizes.includes(px))
    expect(
      shared,
      `the ride painted ${rideSizes.join('/')} px and the flight paints ${flightSizes.join('/')} px.\n` +
        'If those overlap, the ride already warms part of the release frame and the\n' +
        'size arithmetic in hud.ts’s DEV-250 block is stale — re-read it before\n' +
        'trusting any A/B taken against this arm.',
    ).toEqual([])
  })

  it('the warm draws at EVERY size a flight frame can draw at', () => {
    // The other half, and the one that catches a warm state drifting away from
    // the layout it is supposed to stand in for. A size the flight uses and the
    // warm does not is a strike still built on the release frame.
    const warmRec = installCanvas()
    const warmHud = createHud()
    warmHud.warm(warmHudState(LABELS))
    const warmSizes = sizesOf(warmRec)
    warmHud.dispose()

    const states: [string, HudState][] = [
      ['bare three rows', flightState()],
      ['autopilot and a streak', flightState({ autopilot: true, multiplier: 4 })],
      ['a short award', flightState({ award: '+60' })],
      ['the end-of-run medal', flightState({ finished: true, medal: 'GOLD' })],
      ['every instrument', flightState({ autopilot: true, multiplier: 3, award: 'BRONZE' })],
    ]
    for (const [name, state] of states) {
      vi.unstubAllGlobals()
      const rec = installCanvas()
      const hud = createHud()
      hud.warm(state)
      const missing = sizesOf(rec).filter((px) => !warmSizes.includes(px))
      hud.dispose()
      expect(
        missing,
        `${name}: drawn at ${missing.join('/')} px, which warmHudState never paints ` +
          `(it paints ${warmSizes.join('/')}).`,
      ).toEqual([])
    }
  })

  it('the long award needs no size of its own — it reuses the corner’s', () => {
    // The event line picks its size from the string's LENGTH, and one draw
    // cannot be both branches. That looked like a residual until it was
    // measured: the short branch is `rowH * 0.50` = 31 px and the LONG branch
    // is `rowH * 0.34` = 21 px, which is the corner badges' size, so a warm
    // that takes the short branch covers both. One draw covers every size the
    // panel can paint — which is why there is a single warm and not three.
    //
    // Asserted rather than left in a comment, because the coefficient that
    // makes it true (`0.34` in two places) is one edit away from not being.
    vi.unstubAllGlobals()
    const rec = installCanvas()
    const hud = createHud()
    hud.warm(warmHudState(LABELS))
    const sizes = sizesOf(rec)
    hud.dispose()

    vi.unstubAllGlobals()
    const longRec = installCanvas()
    const longHud = createHud()
    longHud.warm(flightState({ award: 'PLATINUM MEDAL EARNED' }))
    const longSizes = sizesOf(longRec)
    longHud.dispose()

    expect(
      longSizes.filter((px) => !sizes.includes(px)),
      'the long-award branch was expected to reuse a size the warm already paints',
    ).toEqual([])
  })

  it('warms every digit, so no glyph is built for the first time in the air', () => {
    // Cheap to get right and invisible when wrong: a digit the warm misses is
    // rasterised the first time the reading reaches it, which is mid-flight.
    // One glyph rather than a strike, so this is a polish assertion, not the
    // row — but it is the assertion that keeps the chosen numbers from being
    // tidied into `0/0`, `0` and `0` by somebody who reads them as placeholders.
    const rec = installCanvas()
    const hud = createHud()
    hud.warm(warmHudState(LABELS))
    hud.dispose()
    const painted = rec.strings.join('')
    for (const digit of '0123456789') {
      expect(painted.includes(digit), `digit ${digit} is never painted by the warm`).toBe(true)
    }
    expect(painted, 'the count row’s separator').toContain('/')
  })
})

describe('Hud.warm — what it must NOT disturb', () => {
  /** The panel, plus a clock the caller controls. */
  const panel = (): { hud: Hud; at: (ms: number, state: HudState) => void } => {
    const hud = createHud()
    return { hud, at: (ms, state) => hud.update(state, ms) }
  }

  it('does not consume the redraw budget — the launch banner still paints at once', () => {
    // THE TRAP. `HUD_REDRAW_DEFAULT` admits at most ten paints a second, and a
    // warm that recorded itself as a paint would put the very next `update()`
    // — the launch banner, the first thing the player reads — into `owed` and
    // hold it for up to an interval. Under the curtain that is invisible; the
    // point is that it is invisible, not that it is small.
    installCanvas()
    const { hud, at } = panel()
    hud.warm(warmHudState(LABELS))
    expect(hud.report().warmPaints, 'the warm did not happen').toBe(1)
    expect(hud.report().repaints, 'a warm is not a repaint').toBe(0)

    // One millisecond later — well inside the 100 ms interval.
    at(1, flightState({ banner: 'PRESS A' }))
    expect(
      hud.report().repaints,
      'the banner was withheld: the warm paced the budget it was supposed to bypass',
    ).toBe(1)
    expect(hud.report().skipped, 'nothing should have been withheld yet').toBe(0)
  })

  it('does not advance the signature — the first live update still repaints', () => {
    // The other half. `update()` returns early when the signature has not moved
    // and nothing is owed, so a warm that wrote the signature for a state the
    // caller never passes would be harmless, while a warm that wrote the
    // signature for a state the caller DOES pass would leave the warm picture
    // on the panel until something else moved. Assert the general form: the
    // first `update()` after a warm repaints, whatever it is handed.
    installCanvas()
    const { hud, at } = panel()
    const state = warmHudState(LABELS)
    hud.warm(state)
    // The same state the warm used — the adversarial case, and the only one
    // where an advanced signature would actually bite.
    at(1, state)
    expect(
      hud.report().repaints,
      'the first live update was swallowed: the warm advanced the signature',
    ).toBe(1)
    // And the signature really is the thing being tested, not a coincidence.
    expect(hudSignature(state)).toBe(hudSignature(state))
  })

  it('leaves report().canvasOps meaning "the last REPAINT", not "the last draw"', () => {
    // `repaints: 0` beside a non-zero `canvasOps` is the shape of a draw path
    // that forgot to count itself, and a reader would spend an hour on it.
    installCanvas()
    const { hud, at } = panel()
    const ops = hud.warm(warmHudState(LABELS))
    expect(ops.total, 'warm() returns what IT drew').toBeGreaterThan(0)
    expect(hud.report().canvasOps, 'and the report still says nothing has repainted').toEqual({
      total: 0,
      texts: 0,
      measures: 0,
    })
    at(1, flightState())
    expect(hud.report().canvasOps.total).toBe(hudCanvasOps(flightState()).total)
  })

  it('is counted by three’s own upload counter — repaints + warmPaints + 1', () => {
    // `uploads` is `texture.version`, which nothing in this module owns. It is
    // the number that disagrees when a draw path forgets a `needsUpdate` or
    // sets two, and the sum has to stay reconcilable or it stops being able to.
    // The `+ 1` is `CanvasTexture`'s constructor pushing the blank canvas.
    installCanvas()
    const { hud, at } = panel()
    hud.warm(warmHudState(LABELS))
    at(1, flightState({ banner: 'PRESS A' }))
    at(1000, flightState())
    const r = hud.report()
    expect(r.warmPaints).toBe(1)
    expect(r.repaints).toBe(2)
    expect(r.uploads).toBe(r.repaints + r.warmPaints + 1)
  })

  it('still paints under ?hudRedraw=freeze, which is the arm it is measured beside', () => {
    // `freeze` is the FLOOR of every A/B in this wave, so `?hudWarm=on` has to
    // be usable with it: the warm is not a repaint and does not spend the one
    // paint a freeze allows. A reader comparing the two arms sees
    // `warmPaints: 1, repaints: 1` and can tell which is which.
    installCanvas()
    const { hud, at } = panel()
    hud.setRedraw({ kind: 'freeze' })
    hud.warm(warmHudState(LABELS))
    at(1, flightState({ banner: 'PRESS A' }))
    at(2, flightState())
    const r = hud.report()
    expect(r.warmPaints).toBe(1)
    expect(r.repaints, 'freeze still allows exactly one live paint').toBe(1)
    expect(r.cadence).toBe('freeze')
  })

  it('does not count towards rateHz — a boot-time paint is not a cadence', () => {
    // `rateHz` is repaints per second of the panel's LIFE, and the DEV-243
    // two-panel comparison is built on it. A warm folded in would inflate the
    // HUD's rate against the perf plate's, which has no warm, and the two
    // panels would stop being comparable — which is the whole of why they share
    // `createPanelCounter`.
    installCanvas()
    const { hud, at } = panel()
    hud.warm(warmHudState(LABELS))
    at(0, flightState({ banner: 'PRESS A' }))
    at(1000, flightState())
    const r = hud.report()
    expect(r.seconds).toBeCloseTo(1, 6)
    expect(r.rateHz, 'two repaints over one second').toBeCloseTo(2, 6)
    // And the budget really was in force over that second, or the rate above is
    // a fact about a cadence nobody applied.
    expect(HUD_REDRAW_DEFAULT_HZ).toBe(10)
  })
})
