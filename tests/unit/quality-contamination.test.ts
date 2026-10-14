// tests/unit/quality-contamination.test.ts: DEV-914.
//
// **A starved frame is not a slow build.** On 2026-09-17 an agent's `pnpm
// check` starved the box, `quality.ts` read the frames as the build being slow
// and dropped to the 45 Hz tier under a wearer (perf-protocol section
// 3a-quater). The controller now takes a per-frame FLAG and does not decide on
// a flagged frame; these tests drive it with synthetic traces, because nothing
// in CI has a box that can be starved on demand.
//
// Four claims, and each is a pair so the test cannot pass for the wrong
// reason:
//
//  1. A contaminated burst does not downgrade (and the same trace UNflagged
//     does, so the trace is genuinely one that would).
//  2. A genuine sustained slowdown still downgrades, including right after a
//     burst, and not earlier than the evidence allows.
//  3. A burst cannot COMPLETE a downgrade that clean frames half-built before
//     it, which is the failure a plain "skip the frame" would still have.
//  4. With nothing flagged, the controller decides exactly as it did before
//     the flag existed, frame for frame, on a recorded-style trace.
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import {
  CONTAMINATION,
  CONTAMINATION_HOLD_SECONDS,
  contaminationLabel,
  createContaminationGate,
} from '@/render/contamination'
import {
  type AdaptiveConfig,
  createAdaptiveState,
  createQualityController,
  DEFAULT_ADAPTIVE,
  stepAdaptive,
} from '@/render/quality'

const BUDGET = 1 / 90
const CONFIG: AdaptiveConfig = { ...DEFAULT_ADAPTIVE, targetSeconds: BUDGET }
/** A frame at about a third of the rate the budget wants: unambiguously over. */
const SLOW = 0.03
const GOOD = BUDGET * 0.9

/** Run `seconds` of `dt` frames through one state; returns the frame each step landed on. */
const run = (
  state: ReturnType<typeof createAdaptiveState>,
  seconds: number,
  dt: number,
  contaminated: boolean,
): number[] => {
  const steps: number[] = []
  const frames = Math.round(seconds / dt)
  for (let i = 0; i < frames; i++) {
    if (stepAdaptive(state, dt, CONFIG, undefined, contaminated)) steps.push(i)
  }
  return steps
}

describe('a contaminated burst does not downgrade', () => {
  it('the control: the same slow trace, unflagged, steps down', () => {
    const state = createAdaptiveState()
    run(state, 4, SLOW, false)
    expect(state.stepIndex).toBeGreaterThan(0)
  })

  it('flagged, the same trace moves nothing and the frames are counted', () => {
    const state = createAdaptiveState()
    const steps = run(state, 4, SLOW, true)
    expect(steps).toEqual([])
    expect(state.stepIndex).toBe(0)
    expect(state.contaminatedFrames).toBe(state.frames)
    expect(state.frames).toBeGreaterThan(100)
  })

  it('also moves nothing UP: a flagged stretch is not evidence of headroom', () => {
    const state = createAdaptiveState()
    run(state, 4, SLOW, false) // go below full resolution first
    const floor = state.stepIndex
    expect(floor).toBeGreaterThan(0)
    run(state, 20, GOOD * 0.5, true) // plenty of "headroom", all flagged
    expect(state.stepIndex).toBe(floor)
  })
})

describe('a genuine sustained slowdown still downgrades', () => {
  it('right after a burst, and only after sustainSeconds of CLEAN over-budget frames', () => {
    const state = createAdaptiveState()
    run(state, 3, SLOW, true)
    expect(state.stepIndex).toBe(0)
    const steps = run(state, 3, SLOW, false)
    expect(steps.length).toBeGreaterThan(0)
    // Not earlier than the evidence: the burst must not have pre-loaded it.
    const firstAtSeconds = ((steps[0] as number) + 1) * SLOW
    expect(firstAtSeconds).toBeGreaterThanOrEqual(DEFAULT_ADAPTIVE.sustainSeconds - SLOW)
  })

  it('with the flag never raised at all', () => {
    const state = createAdaptiveState()
    const steps = run(state, 6, SLOW, false)
    expect(steps.length).toBeGreaterThanOrEqual(2)
  })
})

describe('a burst cannot complete a downgrade clean frames half-built', () => {
  it('1.0 s clean-slow, 1.0 s flagged, 0.6 s clean-slow: nothing moves', () => {
    const state = createAdaptiveState()
    run(state, 1.0, SLOW, false)
    expect(state.overSeconds).toBeGreaterThan(0.5) // half-built, and not yet a step
    run(state, 1.0, SLOW, true)
    run(state, 0.6, SLOW, false)
    expect(state.stepIndex).toBe(0)
  })

  it('the control: 2.6 s clean-slow with no flag in it does step', () => {
    const state = createAdaptiveState()
    run(state, 1.0, SLOW, false)
    run(state, 1.0, SLOW, false)
    run(state, 0.6, SLOW, false)
    expect(state.stepIndex).toBeGreaterThan(0)
  })

  it('the average is reseeded, so the first clean frames are not judged on the starved tail', () => {
    const state = createAdaptiveState()
    run(state, 2, SLOW, true)
    expect(state.ema).toBe(0)
    stepAdaptive(state, GOOD, CONFIG, undefined, false)
    expect(state.ema).toBeCloseTo(GOOD, 6)
  })
})

/** A small deterministic PRNG: the trace must be the same on every machine. */
const lcg = (seed: number) => {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/** Bimodal intervals (11 ms and 22 ms, DEV-228), hitches, and a slow stretch. */
const recordedStyleTrace = (frames: number): number[] => {
  const rand = lcg(914)
  const out: number[] = []
  for (let i = 0; i < frames; i++) {
    const slowStretch = i % 3000 > 2200
    const r = rand()
    const base = slowStretch ? 0.019 : r < 0.85 ? 0.0111 : 0.0222
    out.push(r > 0.995 ? 0.25 : base)
  }
  return out
}

describe('with nothing flagged the controller decides exactly as before', () => {
  it('stepAdaptive: omitted and explicit false agree on every frame of 30,000', () => {
    const trace = recordedStyleTrace(30000)
    const a = createAdaptiveState()
    const b = createAdaptiveState()
    const steps: number[] = []
    for (const dt of trace) {
      const moved = stepAdaptive(a, dt, CONFIG)
      expect(stepAdaptive(b, dt, CONFIG, undefined, false)).toBe(moved)
      expect(b).toEqual(a)
      if (moved) steps.push(a.stepIndex)
    }
    // The trace must actually exercise the controller or "identical" is vacuous.
    expect(steps.length).toBeGreaterThan(2)
    expect(Math.max(...steps)).toBeGreaterThan(0)
    expect(a.contaminatedFrames).toBe(0)
  })

  it('the controller: a gate that never fires equals no gate, report for report', () => {
    const trace = recordedStyleTrace(8000)
    const bare = controller(undefined)
    const gated = controller(() => 0)
    for (const dt of trace) {
      bare.frame(dt)
      gated.frame(dt)
      expect(gated.report).toEqual(bare.report)
    }
    expect(bare.report.scale).toBeLessThan(1)
  })
})

describe('the controller records the flag', () => {
  it('flagged frames hold the resolution, are counted, and the mask is reported', () => {
    const flag: { mask: number } = { mask: CONTAMINATION.HOST_CPU }
    const c = controller(() => flag.mask)
    for (let i = 0; i < 400; i++) c.frame(SLOW)
    expect(c.report.scale).toBe(1)
    expect(c.report.contamination).toBe(CONTAMINATION.HOST_CPU)
    expect(c.report.contaminatedFrames).toBe(400)
    flag.mask = 0
    for (let i = 0; i < 400; i++) c.frame(SLOW)
    expect(c.report.scale).toBeLessThan(1)
    expect(c.report.contamination).toBe(0)
    expect(c.report.contaminatedFrames).toBe(400)
  })

  it('is recorded under ?adaptive=0 too, the measuring configuration', () => {
    const c = controller(() => CONTAMINATION.HMR, { adaptiveResolution: false })
    for (let i = 0; i < 10; i++) c.frame(SLOW)
    expect(c.report.contamination).toBe(CONTAMINATION.HMR)
    expect(c.report.contaminatedFrames).toBe(10)
    expect(c.report.scale).toBe(1)
  })
})

describe('the gate', () => {
  it('holds a reason for CONTAMINATION_HOLD_SECONDS of frame time after the last sighting', () => {
    const gate = createContaminationGate()
    gate.observe(CONTAMINATION.LEASE)
    expect(gate.advance(0.01)).toBe(CONTAMINATION.LEASE)
    let frames = 0
    while (gate.advance(0.01) !== 0) frames++
    expect(frames * 0.01).toBeGreaterThanOrEqual(CONTAMINATION_HOLD_SECONDS - 0.02)
    expect(frames * 0.01).toBeLessThanOrEqual(CONTAMINATION_HOLD_SECONDS + 0.02)
  })

  it('a fresh sighting restarts the hold, and reasons are independent', () => {
    const gate = createContaminationGate(1)
    gate.observe(CONTAMINATION.HMR)
    // 0.25 s frames: a binary fraction, so the countdown is exact.
    gate.advance(0.25)
    gate.observe(CONTAMINATION.HOST_CPU)
    expect(gate.advance(0.25)).toBe(CONTAMINATION.HMR | CONTAMINATION.HOST_CPU)
    // hmr (1 s, 0.75 left after the frame above) runs out on the third frame
    // from here; cpu (restarted at the frame above) still has 0.25.
    for (let i = 0; i < 2; i++) {
      expect(gate.advance(0.25) & CONTAMINATION.HMR).toBe(CONTAMINATION.HMR)
    }
    expect(gate.advance(0.25)).toBe(CONTAMINATION.HOST_CPU)
    gate.observe(CONTAMINATION.HOST_CPU)
    expect(gate.advance(0.25)).toBe(CONTAMINATION.HOST_CPU)
  })

  it('does not run its clock on a stalled frame: dt is clamped like the controller', () => {
    const gate = createContaminationGate(2)
    gate.observe(CONTAMINATION.HIDDEN)
    gate.advance(0)
    expect(gate.advance(90)).toBe(CONTAMINATION.HIDDEN) // 90 s of backgrounded tab = 0.25 s
  })

  it('names its reasons for the plate', () => {
    expect(contaminationLabel(0)).toBe('')
    expect(contaminationLabel(CONTAMINATION.HMR | CONTAMINATION.HOST_CPU)).toBe('hmr+cpu')
    expect(contaminationLabel(CONTAMINATION.HIDDEN)).toBe('hidden')
  })
})

// ── a flat renderer double: enough for the controller, nothing more ──────────
function controller(
  contamination: ((dt: number) => number) | undefined,
  settings: { adaptiveResolution?: boolean } = {},
) {
  const renderer = {
    xr: {
      isPresenting: false,
      setFoveation: () => {},
      setFramebufferScaleFactor: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      getSession: () => null,
    },
    setPixelRatio: () => {},
    domElement: { clientWidth: 1280, clientHeight: 720 },
  } as unknown as import('three').WebGLRenderer
  const c = createQualityController(renderer, {
    devicePixelRatio: () => 1,
    ...(contamination ? { contamination } : {}),
  })
  c.apply({ ...DEFAULT_SETTINGS, ...settings })
  return c
}
