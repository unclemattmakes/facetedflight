// tests/unit/speed-chain.test.ts — the mechanic the ghosts proved was missing.
//
// ── How this was found ────────────────────────────────────────────────────
//
// The ported HoverJet's terminal speed is `2 x maxSpeed / (mass x drag)` —
// 437.5 x 2 over 4 x 1.2 — which is 182.3 m/s, and it sat there. The 2016 ghost
// recording of this same course spends **52 % of its run faster than that**,
// peaking at 308. Not a tuning difference: a flight the model cannot produce.
//
// The cause is `EnergySystem_Ship.IncreaseSpeed()`, called by every gate whose
// `energyBoost` is set — which is every shipped gate, a flag the extractor had
// captured and nothing read. +18 to `maxSpeed` per gate, all of it falling back
// after 5.5 s without one.
//
// ── The test that matters ─────────────────────────────────────────────────
//
// Not "does the chain add 18", which is arithmetic. The one at the bottom:
// replay the real ghost's gate times, and count the windows where it flew faster
// than the model says is possible. A correct model has almost none. That number
// is what identified the mechanic, and it is what would catch its removal.

import { describe, expect, it } from 'vitest'
import { HOVERJET } from '@/generated/constants.generated'
import { FIXED_DT } from '@/sim/constants'
import { createHoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import {
  chainCountdown,
  chainedMaxSpeed,
  chainGate,
  createSpeedChain,
  type SpeedChainSpec,
  stepSpeedChain,
  terminalSpeed,
} from '@/sim/speed-chain'
import ghost from '../../content/ghosts/int_01_leftSpawn_fast_01.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

const SPEC: SpeedChainSpec = {
  increment: HOVERJET.speedChain.speedIncreaseAmt,
  cooldownSeconds: HOVERJET.energy.maxCooldownTime,
}
const BASE = HOVERJET.ship.maxSpeed
const TERM = (maxSpeed: number) =>
  terminalSpeed(
    maxSpeed,
    HOVERJET.ship.boostMultiplier,
    HOVERJET.rigidbody.mass,
    HOVERJET.rigidbody.drag,
  )

describe('what the extractor already had', () => {
  it('flags energyBoost on EVERY shipped ring', () => {
    // The trigger for the whole mechanic, extracted long ago and never read. If
    // this were true on only some rings the chain would be a route decision
    // rather than the game's core loop.
    const rings = int01.routes[0]?.rings ?? []
    expect(rings.length).toBe(21)
    for (const r of rings) {
      expect((r.scoring as { energyBoost: boolean }).energyBoost, `ring ${r.i}`).toBe(true)
    }
  })

  it('reads the increment from the C#, because it is never serialised', () => {
    // `private float speedIncreaseAmt = 18f` with no [SerializeField]. There is
    // no YAML key for the normal walk to promote, so it is extracted explicitly
    // as a code-default rather than typed into the sim.
    expect(SPEC.increment).toBe(18)
    expect(SPEC.cooldownSeconds).toBe(5.5)
  })
})

describe('the chain', () => {
  it('adds the increment per gate, with no ceiling', () => {
    // 2016 does `maxSpeed += speedIncreaseAmt` and never clamps, so a longer
    // course gives a longer chain.
    const s = createSpeedChain()
    expect(chainedMaxSpeed(s, SPEC, BASE)).toBe(BASE)
    for (let i = 1; i <= 30; i++) {
      chainGate(s)
      expect(chainedMaxSpeed(s, SPEC, BASE)).toBeCloseTo(BASE + 18 * i, 9)
    }
  })

  it('falls back ALL AT ONCE, not gradually', () => {
    // The assignment is `maxSpeed = _startingMaxSpeed`. Twenty gates vanish in
    // one statement the instant the timer expires, which is what makes a missed
    // gate expensive rather than merely slow — and a decay would be a much
    // gentler game.
    const s = createSpeedChain()
    for (let i = 0; i < 20; i++) chainGate(s)
    // A tick short: still everything.
    stepSpeedChain(s, SPEC, SPEC.cooldownSeconds - 0.01)
    expect(s.stacks).toBe(20)
    stepSpeedChain(s, SPEC, 0.02)
    expect(s.stacks).toBe(0)
    expect(chainedMaxSpeed(s, SPEC, BASE)).toBe(BASE)
  })

  it('restarts the clock on every gate, so a chain survives indefinitely', () => {
    const s = createSpeedChain()
    for (let i = 0; i < 10; i++) {
      chainGate(s)
      // Just inside the window, ten times over — far more than the cooldown in
      // total elapsed time.
      stepSpeedChain(s, SPEC, SPEC.cooldownSeconds - 0.1)
      expect(s.stacks).toBe(i + 1)
    }
  })

  it('does nothing at all before the first gate', () => {
    const s = createSpeedChain()
    stepSpeedChain(s, SPEC, 1000)
    expect(s.stacks).toBe(0)
    expect(chainCountdown(s, SPEC)).toBeNull()
  })

  it('counts down in whole seconds once a chain is live', () => {
    const s = createSpeedChain()
    chainGate(s)
    expect(chainCountdown(s, SPEC)).toBe(6)
    stepSpeedChain(s, SPEC, 2)
    expect(chainCountdown(s, SPEC)).toBe(4)
  })
})

describe('what it is worth', () => {
  /** Fly at full throttle and boost for `seconds`, holding `stacks` gates. */
  const peakSpeed = (stacks: number, seconds = 30): number => {
    const jet = createHoverJet()
    for (let i = 0; i < stacks; i++) chainGate(jet.chain)
    const input = { ...noInput(), throttle: 1, boost: true }
    let peak = 0
    const ticks = Math.round(seconds / FIXED_DT)
    for (let i = 0; i < ticks; i++) {
      // Keep the chain alive, as a pilot clearing gates would.
      if (stacks > 0) jet.chain.sinceGate = 0
      stepHoverJet(jet, input, FIXED_DT)
      const v = jet.body.velocity
      peak = Math.max(peak, Math.hypot(v.x, v.y, v.z))
    }
    return peak
  }

  it('takes the ship from 182 to 340 m/s over twenty-one gates', () => {
    // The whole point, and the reason the boost effects have three stages.
    expect(peakSpeed(0)).toBeGreaterThan(175)
    expect(peakSpeed(0)).toBeLessThan(190)
    expect(peakSpeed(21)).toBeGreaterThan(320)
  })

  it('matches the closed-form terminal at every stack count', () => {
    // The sim integrates; this is the algebra. Agreeing to 2 % says the drag
    // model and the thrust model are the same two things the C# has.
    for (const stacks of [0, 4, 8, 12, 16, 21]) {
      const predicted = TERM(BASE + SPEC.increment * stacks)
      expect(peakSpeed(stacks), `${stacks} gates`).toBeGreaterThan(predicted * 0.97)
      expect(peakSpeed(stacks), `${stacks} gates`).toBeLessThan(predicted * 1.02)
    }
  })

  it('unlocks the boost effect stages the ship art is built around', () => {
    // `boostEffects` 120, stage 2 at 240, stage 3 at 350. Stage 2 is
    // UNREACHABLE without the chain, which is how the missing mechanic first
    // showed itself.
    expect(peakSpeed(0)).toBeLessThan(240)
    // Stage 2 arrives on the NINTH gate, not the eighth: the closed form clears
    // 240 at 7.7 gates, and the integrator runs about 1.5 % under it.
    expect(peakSpeed(8)).toBeLessThan(240)
    expect(peakSpeed(9)).toBeGreaterThan(240)
    // Stage 3 needs essentially a perfect run, and the fast ghost never hit it.
    expect(peakSpeed(16)).toBeLessThan(350)
  })
})

describe('the 2016 ghost', () => {
  // THE test. A recording of the shipped game, replayed against the model's
  // speed ceiling. A flight faster than the ceiling is one the model cannot
  // produce, so counting those windows measures how wrong the model is.

  const O = int01.worldOffset as number[]
  const Q = ghost.quant as { time: number; pos: number }
  const times = ghost.t.map((v) => v / Q.time)
  const points: [number, number, number][] = []
  for (let i = 0; i < ghost.p.length; i += 3) {
    points.push([
      (ghost.p[i] as number) / Q.pos + (O[0] as number),
      (ghost.p[i + 1] as number) / Q.pos + (O[1] as number),
      (ghost.p[i + 2] as number) / Q.pos + (O[2] as number),
    ])
  }

  /** When the ghost was closest to each gate's trigger sphere. */
  const gateTimes = (int01.routes[0]?.rings ?? [])
    .map((ring) => {
      const c = ring.trigger.pos as number[]
      let best = Number.POSITIVE_INFINITY
      let at: number | null = null
      for (let i = 0; i < points.length; i++) {
        const p = points[i] as [number, number, number]
        const d = Math.hypot(
          p[0] - (c[0] as number),
          p[1] - (c[1] as number),
          p[2] - (c[2] as number),
        )
        if (d < best) {
          best = d
          at = times[i] as number
        }
      }
      // Generous: keyframes are ~12 m apart at speed, so the closest SAMPLE can
      // sit outside a 22.6 m sphere the ship really flew through.
      return best <= ring.trigger.radius * 1.8 ? at : null
    })
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)

  /** Ground speed over one-second windows — robust to irregular keyframes. */
  const windows: { t: number; v: number }[] = []
  for (let b = 0; b < ghost.duration - 1; b += 0.5) {
    const i0 = times.findIndex((x) => x >= b)
    const i1 = times.findIndex((x) => x >= b + 1)
    if (i0 < 0 || i1 <= i0) continue
    let d = 0
    for (let i = i0 + 1; i <= i1; i++) {
      const a = points[i - 1] as [number, number, number]
      const c = points[i] as [number, number, number]
      d += Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2])
    }
    windows.push({ t: b + 0.5, v: d / ((times[i1] as number) - (times[i0] as number)) })
  }

  /** Windows where the ghost outran the model's ceiling, as a fraction. */
  const impossibleFraction = (increment: number): number => {
    let over = 0
    let n = 0
    for (const w of windows) {
      if (!gateTimes.length || w.t < (gateTimes[0] as number)) continue
      const passed = gateTimes.filter((x) => x <= w.t)
      const last = passed[passed.length - 1] as number
      const stacks = w.t - last > SPEC.cooldownSeconds ? 0 : passed.length
      // 2 % of slack for window smoothing and keyframe quantisation.
      if (w.v > TERM(BASE + increment * stacks) * 1.02) over++
      n++
    }
    return over / n
  }

  it('crossed all twenty-one gates, fast enough to keep the chain alive', () => {
    expect(gateTimes).toHaveLength(21)
    const gaps = gateTimes.slice(1).map((x, i) => x - (gateTimes[i] as number))
    // Only one gap exceeds the 5.5 s cooldown, so the chain runs nearly the
    // whole course — which is what a fast run IS.
    expect(gaps.filter((g) => g > SPEC.cooldownSeconds).length).toBeLessThanOrEqual(2)
  })

  it('is IMPOSSIBLE without the chain — over half the run breaks the model', () => {
    // The finding. 52 %: for most of its length the recording is faster than the
    // ship can go. No amount of piloting does that; it is a missing mechanic.
    expect(impossibleFraction(0)).toBeGreaterThan(0.4)
  })

  it('is explained WITH it', () => {
    // 6 %, and that residue is the resolution of the gate-crossing times —
    // closest-sample rather than true crossing, on keyframes ~47 ms apart.
    expect(impossibleFraction(SPEC.increment)).toBeLessThan(0.15)
  })

  it('is explained by 18 better than by any neighbouring value', () => {
    // Guards the number itself. Too small and the ghost still outruns the
    // ceiling; too large and the ceiling stops being a constraint at all, which
    // this cannot see — so only the lower side is asserted, honestly.
    expect(impossibleFraction(6)).toBeGreaterThan(impossibleFraction(SPEC.increment))
    expect(impossibleFraction(12)).toBeGreaterThan(impossibleFraction(SPEC.increment))
  })
})
