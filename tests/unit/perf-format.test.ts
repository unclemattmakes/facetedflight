// tests/unit/perf-format.test.ts — the ten rows of the in-headset plate.
//
// DEV-160, `docs/plan/VR-PERF.md` §5.5 D. The plate itself is a canvas and a
// `CanvasTexture`, so it cannot be reached from an `environment: 'node'` suite
// at all; the whole point of `boot/perf-format.ts` existing as a separate module
// is that the part that can be WRONG — what the rows say, and when they change —
// is testable without a browser. `render/hud.ts` split `hudSignature` out for
// the same reason and its header says what happened while it did not: the rule
// was "enforced by nothing".
//
// **What is actually at risk here**, and it is not typography:
//
//  - A signature that tracks the MODEL rather than the TEXT redraws on every
//    frame (a canvas upload at 4 Hz that should have been one an hour), or
//    worse, holds a stale plate while the numbers move — `render/hud.ts`'s
//    speed-unit trap, one layer up.
//  - `GPU n/a` is the branch the reach target and possibly the first worn
//    session will take (VR-PERF gap 11 / §4: the timer query is unproven inside
//    a session). A `null` that printed `p50 0.0` would be a measurement claim
//    nobody made, on the one row the whole exercise is about.
//  - `NaN.toFixed(1)` is the string `"NaN"`, which renders perfectly — the
//    exact lesson `perf-recorder.test.ts` opens with.

import { describe, expect, it } from 'vitest'
import {
  contaminationLine,
  eyeEstimate,
  type PerfPlateModel,
  perfPlateLines,
  plateSignature,
} from '@/boot/perf-format'
import { plateRows } from '@/render/perf-plate'

/**
 * A plausible worn frame: 90 Hz measured, Anniversary, `int_01`, mid-soak.
 *
 * Every number is arbitrary EXCEPT that each is chosen to be unambiguous in the
 * output — no two fields share a value, so a row that printed the wrong field
 * would not accidentally read correctly.
 */
const MODEL: PerfPlateModel = {
  version: 'v0.0.0',
  mode: 'production',
  edition: 'anniversary',
  mission: 'int_01_hoverJet',

  budgetMs: 11.111,
  budgetHz: 90,
  budgetSource: 'measured',
  budgetShare: 0.834,
  // Null is the keeping-up case, which is what this fixture is. The tier row is
  // exercised on its own below, against the worn 90/45 (DEV-161).
  budgetTierHz: null,

  fps: 89.4,
  p50Ms: 10.92,
  p95Ms: 12.41,
  maxMs: 31.04,

  hitchFraction: 0.0075,
  hitches: 2,
  // DEV-179's other half. Deliberately unlike `hitchFraction`: a lap can be
  // pinned in a tier and still be pacing it perfectly, which is exactly what
  // lap 4 was, and the fixture would say nothing if the two agreed.
  tierFraction: 0.0299,
  frames: 268,
  engagedFraction: 0,
  scale: 1,

  simMs: 0.93,
  ticksMin: 1,
  ticksMax: 2,
  renderMs: 3.14,
  jsMs: 6.22,

  gpu: { p50Ms: 7.81, p95Ms: 9.93, samples: 240 },

  presenting: true,
  calls: 540,
  triangles: 5_920_000,
  programs: 41,
  geometries: 812,
  textures: 33,

  trace: { status: 'recording', recordedSeconds: 42, totalSeconds: 90, frames: 3780 },

  xr: {
    layer: 'XRWebGLLayer',
    fixedFoveation: null,
    viewportWidth: 0,
    framebufferWidth: 2016,
    framebufferHeight: 2016,
    // Null here so the base row stays the shape every other assertion in this
    // file was written against; the pair is exercised on its own below.
    nativeScale: null,
  },
}

const withModel = (patch: Partial<PerfPlateModel>): string[] =>
  perfPlateLines({ ...MODEL, ...patch })

describe('the ten rows', () => {
  it('is exactly ten rows — the grid the plate is laid out for', () => {
    // This comment used to read: *"Eleven rows would not overflow, it would
    // draw the eleventh off the bottom edge of a 336 px canvas and nobody would
    // know which one went missing."* It was right, and it guarded the wrong
    // door. The eleventh row did not come from THIS function — `boot/app.ts`
    // concatenates `xrInputLine()` and the frame-error line onto the ten, so
    // the count asserted here stayed at ten while the plate was handed eleven,
    // and the XR row was painted below the bottom edge for the whole of the
    // first Frame session. Matt, wearing it: *"i don't see anything about the
    // buttons in the perf panel. is it out of bounds from the perf panel?"*
    //
    // `render/perf-plate.ts` now divides by `plateRows(lines.length)` and this
    // is the tie to it: ten is the floor, not the cap.
    expect(perfPlateLines(MODEL)).toHaveLength(10)
    expect(
      plateRows(perfPlateLines(MODEL).length),
      'the plate must lay out at least as many rows as the formatter emits',
    ).toBe(perfPlateLines(MODEL).length)
  })

  it('does not let the HITCH row set the plate’s type size — DEV-179', () => {
    // `render/perf-plate.ts` fits the type to the WIDEST of the ten rows —
    // always, because every row is already wider than the plate at the starting
    // size — so a row that grows past the current widest shrinks the type on
    // the other nine. That is a legibility change to an instrument read through
    // a headset, and nothing in a string test would otherwise notice it.
    //
    // Scripted at the worn values, which is the configuration the plate is
    // actually read in: lap 4's own saturated tier, and DEV-178's `5032×2516 ·
    // ×1.00` XR row. The assertion is the RELATIONSHIP — HITCH is not the
    // longest — rather than a character count, because a count would be this
    // file re-deriving the format it is testing and would go stale the first
    // time a version string grew a digit.
    const worn = withModel({
      hitchFraction: 0.01,
      hitches: 24,
      tierFraction: 0.73,
      frames: 2364,
      engagedFraction: 1,
      scale: 0.6,
      xr: {
        layer: 'XRProjectionLayer',
        fixedFoveation: 1,
        viewportWidth: 0,
        framebufferWidth: 5032,
        framebufferHeight: 2516,
        nativeScale: 1,
      },
    })
    const hitch = worn[3] as string
    expect(hitch).toContain('HITCH')
    expect(hitch).toContain('tier 73%')
    const others = worn.filter((_, i) => i !== 3).map((line) => line.length)
    expect(hitch.length).toBeLessThan(Math.max(...others))
  })

  it('prints the worn frame the way VR-PERF §5.5 writes it', () => {
    expect(perfPlateLines(MODEL)).toEqual([
      'PERF v0.0.0 production · anniversary · int_01_hoverJet',
      'BUDGET 11.1 ms · 90 Hz measured (0.83)',
      'FPS 89 · p50 10.9 p95 12.4 max 31.0 ms',
      'HITCH 1% (2/268) · tier 3% · engaged 0% · x1.00',
      'SIM 0.9 ms (1–2 ticks) · RENDER 3.1 · JS 6.2',
      'GPU p50 7.8 p95 9.9 ms (n=240)',
      'DRAW 540 calls (2 eyes ≈ 270/eye) · 5.9M tri · 41 prog',
      'MEM 812 geo · 33 tex',
      'TRACE rec 42/90 s · 3,780 frames',
      'XR XRWebGLLayer · fov — · vp — · 2016×2016',
    ])
  })

  it('never prints NaN or Infinity, whatever it is handed', () => {
    // The first second of every session: an empty recorder, no GPU sample yet,
    // no session. `perf-recorder.ts` returns zeros rather than NaN, but the
    // frame timers in `app.ts` are subtractions of `performance.now()` and a
    // division by a zero frame count is one refactor away.
    const lines = withModel({
      budgetMs: Number.NaN,
      budgetHz: Number.POSITIVE_INFINITY,
      fps: Number.NaN,
      p50Ms: Number.NaN,
      p95Ms: Number.NaN,
      maxMs: Number.NaN,
      hitchFraction: Number.NaN,
      tierFraction: Number.NaN,
      engagedFraction: Number.NaN,
      simMs: Number.NaN,
      renderMs: Number.NaN,
      jsMs: Number.NaN,
      triangles: Number.NaN,
      calls: Number.NaN,
      frames: Number.NaN,
    })
    for (const line of lines) {
      expect(line, line).not.toMatch(/NaN|Infinity/)
    }
  })
})

describe('the ≈ per-eye estimate', () => {
  it('halves the frame total', () => {
    expect(eyeEstimate(540)).toBe(270)
    // Odd totals round rather than truncate — a plate that read `269/eye` from
    // 539 would be off by the same half-call every time.
    expect(eyeEstimate(539)).toBe(270)
  })

  it('is what the DRAW row prints IN SESSION, and the row says it is an estimate', () => {
    const draw = withModel({ presenting: true, calls: 377 })[6]
    expect(draw).toContain('377 calls')
    expect(draw).toContain('≈ 189/eye')
    // The `≈` is the whole disclaimer on a plate read at a glance: the frame
    // total includes the shadow pass, which is drawn ONCE and not per eye, so
    // halving under-counts the eyes by half the shadow draws. DEV-118 measured
    // that residual at 64 of `int_01`'s 270 monocular calls.
    expect(draw).toContain('≈')
  })

  it('is NOT printed flat — the row says `(flat)` instead', () => {
    // Out of session there is one view, so halving reads low by two. The first
    // version printed it anyway and the number would have been filed; a row
    // that cannot be misread beats a caveat that has to be remembered.
    const draw = withModel({ presenting: false, calls: 322, triangles: 2_800_000 })[6]
    expect(draw).toBe('DRAW 322 calls (flat) · 2.8M tri · 41 prog')
    expect(draw).not.toContain('/eye')
    expect(draw).not.toContain('≈')
  })

  it('still counts ten rows and keeps the other nine identical either way', () => {
    // `presenting` moves ONE row. A change that leaked into the XR row or the
    // budget row would be a second meaning attached to the same flag.
    const worn = perfPlateLines({ ...MODEL, presenting: true })
    const flat = perfPlateLines({ ...MODEL, presenting: false })
    expect(flat).toHaveLength(10)
    for (let i = 0; i < 10; i += 1) {
      if (i === 6) expect(flat[i]).not.toBe(worn[i])
      else expect(flat[i], `row ${i}`).toBe(worn[i])
    }
  })

  it('survives a nonsense total rather than printing one', () => {
    expect(eyeEstimate(Number.NaN)).toBe(0)
  })
})

describe('the branches that only appear in a headset', () => {
  it('says GPU n/a rather than inventing a zero', () => {
    const lines = withModel({ gpu: null })
    expect(lines[5]).toBe('GPU n/a (no timer query in session)')
    expect(lines[5]).not.toContain('0.0')
  })

  it('prints the three trace states', () => {
    expect(
      withModel({ trace: { status: 'idle', recordedSeconds: 0, totalSeconds: 0, frames: 0 } })[8],
    ).toBe('TRACE idle · ?trace=<s>')
    expect(
      withModel({
        trace: { status: 'done', recordedSeconds: 90, totalSeconds: 90, frames: 8100 },
      })[8],
    ).toBe('TRACE done → __ff2perf.trace')
    expect(lineOf(MODEL, 8)).toBe('TRACE rec 42/90 s · 3,780 frames')
  })

  it('prints the measured share only where a share means something', () => {
    // §5.3 B: `measured` is the modal frame interval and its `share` is the
    // confidence in it. `session` is the runtime STATING its rate, and a
    // confidence printed beside that would invite the reading that the runtime
    // is 83 % sure.
    expect(withModel({ budgetSource: 'session' })[1]).toBe('BUDGET 11.1 ms · 90 Hz session')
    expect(withModel({ budgetSource: 'default' })[1]).toBe('BUDGET 11.1 ms · 90 Hz default')
    expect(lineOf(MODEL, 1)).toBe('BUDGET 11.1 ms · 90 Hz measured (0.83)')
  })

  it('names the TIER when the app is not getting the display-s frames', () => {
    // DEV-161, and the reason the row needs it: worn 2026-09-17 the budget was
    // 11.1 ms (90 Hz, the display) while the FPS row two lines down read 42.
    // Without this the plate is a contradiction a reader has to resolve in
    // their head, and the resolution most people reach for is the wrong one —
    // "the budget is stale" rather than "SteamVR has us in half rate".
    expect(withModel({ budgetTierHz: 45, budgetShare: 0.6 })[1]).toBe(
      'BUDGET 11.1 ms · 90 Hz measured (0.60) · app 45 Hz',
    )
    // The third-rate tier the second worn lap read.
    expect(withModel({ budgetTierHz: 30, budgetShare: 0.6 })[1]).toContain('· app 30 Hz')
  })

  it('says nothing about a tier when there is not one', () => {
    // A machine keeping up has `tierHz === displayHz`, and a row that printed
    // `90 Hz ... app 90 Hz` would train a reader to stop looking at it.
    expect(withModel({ budgetTierHz: 90 })[1]).toBe('BUDGET 11.1 ms · 90 Hz measured (0.83)')
    expect(withModel({ budgetTierHz: null })[1]).toBe('BUDGET 11.1 ms · 90 Hz measured (0.83)')
  })

  it('dashes the XR row out of session rather than printing zeros', () => {
    const lines = withModel({
      xr: {
        layer: '',
        fixedFoveation: null,
        viewportWidth: 0,
        framebufferWidth: 0,
        framebufferHeight: 0,
        nativeScale: null,
      },
    })
    expect(lines[9]).toBe('XR — · fov — · vp — · —')
  })

  it('prints the WORN target with its denominator', () => {
    // 3522 x 1761 at a native scale of 1 is the session that started this: 1761
    // per eye on a 2160 panel, which is 0.6 of what the runtime recommended
    // (DEV-178). Either number alone says nothing — a width with no scale is
    // not a measurement — so the row prints the pair or neither.
    const lines = withModel({
      xr: {
        layer: 'XRProjectionLayer',
        fixedFoveation: 1,
        viewportWidth: 0,
        framebufferWidth: 3522,
        framebufferHeight: 1761,
        nativeScale: 1,
      },
    })
    expect(lines[9]).toBe('XR XRProjectionLayer · fov 1.00 · vp — · 3522×1761 · ×1.00')
  })

  it('leaves the scale off when there is nothing to scale', () => {
    // Out of session there is no size, so a lone `×1.00` would be a claim about
    // a framebuffer that does not exist.
    const lines = withModel({
      xr: {
        layer: '',
        fixedFoveation: null,
        viewportWidth: 0,
        framebufferWidth: 0,
        framebufferHeight: 0,
        nativeScale: 1,
      },
    })
    expect(lines[9]).toBe('XR — · fov — · vp — · —')
  })

  it('prints a projection layer and its foveation when three builds one', () => {
    // VR-PERF gap 11 turns on WHICH layer three chose: on the `XRWebGLLayer`
    // path `setFoveation` writes a value nothing reads and the adaptive
    // controller moves nothing at all. This row is how the worn session answers
    // that in one glance.
    const lines = withModel({
      xr: {
        layer: 'XRProjectionLayer',
        fixedFoveation: 0.5,
        viewportWidth: 0,
        framebufferWidth: 2160,
        framebufferHeight: 2160,
        nativeScale: null,
      },
    })
    expect(lines[9]).toBe('XR XRProjectionLayer · fov 0.50 · vp — · 2160×2160')
  })

  it('prints the LIVE eye width, which is the only field that can move', () => {
    // DEV-236. `vp` used to be `XRView.recommendedViewportScale` — the UA's
    // hint, null on every runtime measured here — and it was being read as our
    // request having landed. It is the per-eye width now, in pixels.
    //
    // `framebufferWidth` beside it is the layer's TEXTURE: allocated once at
    // session start and unchanged by any `requestViewportScale`. So a row
    // carrying only that one read `2016×2016` whether the request landed or was
    // dropped on the floor, which for six weeks it was, and nothing on the
    // plate could have told the two apart. The pair below is the state that
    // used to be unrepresentable: a 2016 px texture with a 1210 px eye in it.
    const lines = withModel({
      xr: {
        layer: 'XRProjectionLayer',
        fixedFoveation: 1,
        viewportWidth: 1210,
        framebufferWidth: 2016,
        framebufferHeight: 2016,
        nativeScale: 1,
      },
    })
    expect(lines[9]).toBe('XR XRProjectionLayer · fov 1.00 · vp 1210px · 2016×2016 · ×1.00')
    // The relationship, not the string: the live eye and the layer texture are
    // separately readable off the row whatever the format. A version that
    // printed one number for both passes a `toBe` nobody updated and fails
    // this.
    expect(lines[9]).toContain('1210')
    expect(lines[9]).toContain('2016')
  })

  it('keeps the XR row from shrinking the type on the other nine', () => {
    // `render/perf-plate.ts` fits the type to the WIDEST row and XR is it —
    // which is why DEV-236 REPLACED the `vp` field rather than adding a fourth.
    // A `vp rec 0.90 · eye 1210px` row is 70 characters worn against the old
    // 58, and would have shrunk every row by a fifth: a legibility change to an
    // instrument read through a headset, invisible to every string test, and
    // the exact consequence `perf-plate.ts`'s header tells a row's author to
    // check.
    //
    // The bound is DRAW, not a character count (trap 24): XR may be the widest
    // — it already was — but not by more than the digits its own numbers carry.
    const worn = withModel({
      scale: 0.6,
      xr: {
        layer: 'XRProjectionLayer',
        fixedFoveation: 1,
        viewportWidth: 1210,
        framebufferWidth: 5032,
        framebufferHeight: 2516,
        nativeScale: 1,
      },
    })
    const xr = worn[9] as string
    const draw = worn[6] as string
    expect(xr).toContain('XR ')
    expect(draw).toContain('DRAW ')
    // Ten characters of headroom over the second-widest row. The pre-DEV-236
    // row had nine; the four-field version would have had twenty-one.
    expect(xr.length - draw.length, `XR is "${xr}"`).toBeLessThan(10)
  })

  it('does not let the ask stand in for the outcome, or the other way round', () => {
    // The two quantities the worn reading compares, on one plate, in one
    // glance: the ASK is the `x0.60` on the HITCH row (`scale`, what
    // `requestViewportScale` was called with) and the OUTCOME is `vp`. An ask
    // of 0.60 against an eye that never left 2016 px is the request not
    // landing — which is exactly what DEV-208 shipped, and is how *"the
    // plumbing is proved"* came to be written about a knob never once turned.
    const lines = withModel({
      scale: 0.6,
      xr: {
        layer: 'XRProjectionLayer',
        fixedFoveation: 1,
        viewportWidth: 2016,
        framebufferWidth: 2016,
        framebufferHeight: 2016,
        nativeScale: 1,
      },
    })
    expect(lines[3], 'the ask, on the HITCH row').toContain('x0.60')
    expect(lines[9], 'the outcome, on the XR row').toContain('vp 2016px')
  })

  it('agrees with itself about a single tick', () => {
    expect(withModel({ ticksMin: 1, ticksMax: 1 })[4]).toContain('(1 tick)')
    expect(withModel({ ticksMin: 0, ticksMax: 0 })[4]).toContain('(0 ticks)')
    // The hitch-causes-a-hitch signature (gap 23): one stalled frame lets the
    // next run up to 20 fixed steps, and the range is the only place that shows.
    expect(withModel({ ticksMin: 1, ticksMax: 20 })[4]).toContain('(1–20 ticks)')
  })
})

describe('the signature', () => {
  it('is the rows joined — what is compared IS what is drawn', () => {
    const lines = perfPlateLines(MODEL)
    expect(plateSignature(lines)).toBe(lines.join('\n'))
  })

  it('holds still while values move under the quantum', () => {
    const before = plateSignature(perfPlateLines(MODEL))
    // Every one of these moves by less than the decimal the row prints. A
    // signature built from the model would change on all of them, four times a
    // second, for the life of the session.
    const after = plateSignature(
      withModel({
        fps: 89.49,
        p50Ms: 10.949,
        p95Ms: 12.449,
        maxMs: 31.04999,
        simMs: 0.9349,
        renderMs: 3.1449,
        jsMs: 6.2249,
        hitchFraction: 0.00749,
        budgetMs: 11.1449,
        triangles: 5_921_000,
      }),
    )
    expect(after).toBe(before)
  })

  it('changes the moment a value crosses one', () => {
    const before = plateSignature(perfPlateLines(MODEL))
    // 10.92 -> 10.96 is 0.04 ms, and it is the difference between a plate that
    // is telling the truth and one that is a frame behind for ever.
    expect(plateSignature(withModel({ p50Ms: 10.96 }))).not.toBe(before)
    // One more draw call, on a budget written per eye.
    expect(plateSignature(withModel({ calls: 541 }))).not.toBe(before)
    // And a preset flip, which is the whole reason the first row exists.
    expect(plateSignature(withModel({ edition: 'classic' }))).not.toBe(before)
    // Entering a session changes what the DRAW row MEANS, so it must redraw —
    // a plate still reading `(flat)` after Enter VR would be the one moment the
    // number matters and the one moment it is stale.
    expect(plateSignature(withModel({ presenting: false }))).not.toBe(before)
  })

  it('separates the trace states, so the plate cannot show a finished soak as live', () => {
    const rec = plateSignature(perfPlateLines(MODEL))
    const done = plateSignature(
      withModel({ trace: { status: 'done', recordedSeconds: 90, totalSeconds: 90, frames: 8100 } }),
    )
    expect(done).not.toBe(rec)
  })
})

describe('DEV-914: the contamination row', () => {
  it('is absent on a session that was never flagged, so a clean plate is unchanged', () => {
    expect(contaminationLine(0, 0)).toBeNull()
  })

  it('says TAINTED and why, in a word, while the last frame is flagged', () => {
    expect(contaminationLine(1 | 4, 1234)).toBe('TAINTED hmr+cpu · 1,234 fr flagged')
  })

  it('says some frames were, once it has cleared', () => {
    expect(contaminationLine(0, 12)).toBe('taint · 12 fr were flagged')
  })

  it("is no wider than the plate's widest row in the ordinary cases", () => {
    // The plate fits its type to the widest row (58 characters worn), so a row
    // wider than that shrinks all ten. One reason and a five-figure count fits.
    expect((contaminationLine(8, 99999) as string).length).toBeLessThanOrEqual(58)
  })
})

/**
 * The `i`th row of a model. Named so an expectation reads as a row number.
 *
 * Throws rather than returning `string | undefined`: a row that is not there is
 * the ten-row invariant broken, and `expect(undefined).toBe('TRACE …')` would
 * report it as a text mismatch instead.
 */
function lineOf(model: PerfPlateModel, i: number): string {
  const line = perfPlateLines(model)[i]
  if (line === undefined) throw new Error(`perf-format: no row ${i}`)
  return line
}
