// tests/unit/gate-pulse.test.ts — S6's gate pass as an event (DEV-108).
//
// The order is the order these would hurt in:
//
//  1. **It cannot reach the centre of the frame.** Research 05 §R7 allows a
//     pulse at the periphery and nowhere else, and calls a central flash a
//     nausea trigger rather than a visual defect. That is asserted as a
//     RELATIONSHIP against the comfort aperture the vignette already owns — not
//     against a restated 0.3 — because trap 24 is what a test that re-derives
//     its expectation the way the code does costs.
//  2. **Classic is untouched.** Zero twice over: the flag is off AND the curve
//     is flat zero, so a hand-edit of either one alone still draws nothing.
//  3. **Two gates do not add up.** A pulse that got brighter the better you
//     played would be a comfort effect driven by skill. The max is asserted
//     against a LIVE level rather than against a stored peak, because those two
//     readings differ exactly when the bug would.
//  4. **The wedge count is whole.** `atan`'s branch cut runs along -x and the
//     wedge function is continuous across it only for integer counts — a
//     fractional one draws a seam down the left of the frame for ever.
//  5. **The ear and the eye were given one event.** The gain curve is
//     `gateWhooshGain`'s breakpoints deliberately, and DEV-069's lesson is to
//     assert that against the other file rather than to write it in a note.
//
// No GL context and no DOM: the driver is arithmetic, and the one number this
// reads out of the render layer is a scalar.

import { describe, expect, it } from 'vitest'
import { sampleCurve } from '@/audio/speed-curves'
import type { Edition, EditionGatePulse } from '@/content/edition-schema'
import { validateEdition } from '@/content/edition-schema'
import { PROPS } from '@/generated/constants.generated'
import { R_CLOSED_STRONG } from '@/render/aperture'
import {
  createGatePulse,
  PHASE_STEP,
  pulseColorLinear,
  pulseEnvelope,
  pulsePeak,
} from '@/render/gate-pulse'
import { srgbToLinear } from '@/render/unity-space'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const classic = classicJson as unknown as Edition
const anniversary = anniversaryJson as unknown as Edition
const anniv: EditionGatePulse = anniversary.fx.gatePulse

describe('S6 — the band cannot reach the centre of the frame', () => {
  it('starts at or outside the aperture the STRONGEST comfort vignette closes to', () => {
    // The whole R7 argument in one line. `R_CLOSED_STRONG` is the radius the
    // comfort layer is willing to black out entirely, so a band that begins at
    // or outside it can only ever brighten a pixel the comfort layer already
    // treats as peripheral. Imported from `aperture.ts` rather than restated:
    // move the vignette and this moves with it.
    expect(anniv.innerRadius).toBeGreaterThanOrEqual(R_CLOSED_STRONG)
    expect(classic.fx.gatePulse.innerRadius).toBeGreaterThanOrEqual(R_CLOSED_STRONG)
  })

  it('is refused at load below that radius, which is where the harm would be', () => {
    const bad = structuredClone(anniversary) as Edition & {
      fx: { gatePulse: { innerRadius: number } }
    }
    bad.fx.gatePulse.innerRadius = R_CLOSED_STRONG - 0.01
    expect(() => validateEdition(bad)).toThrow(/peripheral/)
  })

  it('leaves the central 84 % of the frame at literally zero, in both dimensions', () => {
    // The shipped 0.42 said as the thing a player would see. A UV circle is an
    // ellipse on screen, so `innerRadius` is the same fraction of the half-width
    // and of the half-height: 0.42 of 0.5 is 84 % of each, untouched at any
    // strength because the band's `smoothstep` is exactly 0 below it.
    expect(anniv.innerRadius / 0.5).toBeGreaterThan(0.8)
    // And full only past the edge midpoint, so a whole edge is never at peak.
    expect(anniv.innerRadius + anniv.feather).toBeGreaterThan(0.5)
  })
})

describe('S6 — Classic draws nothing, twice over', () => {
  it('is off, and its curve is flat zero at every speed', () => {
    const block = classic.fx.gatePulse
    expect(block.enabled).toBe(false)
    expect(block.strength).toBe(0)
    for (const speed of [0, 40, 120, 240, 340, 500]) {
      expect(sampleCurve(block.gainBySpeed, speed)).toBe(0)
      expect(pulsePeak(block, speed, 1)).toBe(0)
    }
  })

  it('draws nothing even if the flag alone is flipped', () => {
    const forced = { ...classic.fx.gatePulse, enabled: true }
    expect(pulsePeak(forced, 340, 1)).toBe(0)
  })
})

describe('S6 — the envelope', () => {
  it('peaks on the frame the gate was crossed and is gone at the end', () => {
    expect(pulseEnvelope(0, 2)).toBe(1)
    expect(pulseEnvelope(1, 2)).toBe(0)
    expect(pulseEnvelope(1.5, 2)).toBe(0)
    // Total rather than guarded: a negative u is not a negative base raised to
    // a fractional power, it is nothing.
    expect(pulseEnvelope(-0.5, 2)).toBe(0)
  })

  it('still has most of its light when the gate clears the periphery', () => {
    // THE MEASUREMENT, and the reason the shipped numbers are not S6's own.
    // Photographed on `int_01` at 178 m/s: a frame at the crossing is green to
    // all four edges — the 24 x 35 m ring IS the periphery at that instant —
    // and a frame 0.09 s later has clear sky there. So the light this feature
    // spends in its first 0.09 s is spent behind the object that triggered it,
    // and an envelope that is nearly over by then has been rendered rather than
    // reviewed (DEV-044).
    //
    // S6 proposed 0.2 s; at a squared decay that leaves 30 % at the mark, which
    // is what the first pass shipped and what the photograph refused. The
    // assertion is the CONSTRAINT, not the numbers that satisfy it today.
    const GATE_CLEARS_SECONDS = 0.09
    const atClear = pulseEnvelope(GATE_CLEARS_SECONDS / anniv.seconds, anniv.decayShape)
    expect(atClear).toBeGreaterThan(0.5)
    // And the first pass is pinned as the thing that fails it, so a well-meant
    // return to S6's own figures cannot pass this file silently.
    expect(pulseEnvelope(GATE_CLEARS_SECONDS / 0.2, 2)).toBeLessThan(0.5)
  })

  it('is still punctuation: it is over well before the next gate', () => {
    // `int_01`'s 21 gates are about 540 m apart, which at the boosted terminal
    // of 179.62 m/s is just over 3 s. A pulse that outlived the gap would stop
    // being an event and become the lighting.
    expect(anniv.seconds).toBeLessThan(1)
  })

  it('decays to nothing over the preset’s own seconds, at any frame rate', () => {
    for (const dt of [1 / 144, 1 / 72, 1 / 30]) {
      const pulse = createGatePulse()
      pulse.fire(anniv, 340, 1)
      expect(pulse.level).toBeGreaterThan(0)
      let t = 0
      while (t < anniv.seconds + dt) {
        pulse.update(dt)
        t += dt
      }
      expect(pulse.level).toBe(0)
    }
  })

  it('a backgrounded tab does not leave a pulse lit for a minute', () => {
    const pulse = createGatePulse()
    pulse.fire(anniv, 340, 1)
    // One delta of a whole minute. The clamp caps the step, so this does not
    // finish the window in one go — but two more ordinary frames must.
    pulse.update(60)
    pulse.update(0.25)
    expect(pulse.level).toBe(0)
  })
})

describe('S6 — two gates do not add up', () => {
  it('takes the MAX against what is on screen, never a sum', () => {
    const pulse = createGatePulse()
    pulse.fire(anniv, 340, 1)
    const first = pulse.level
    pulse.fire(anniv, 340, 1)
    expect(pulse.level).toBeCloseTo(first, 12)
  })

  it('a dim late gate does not relight a pulse that had already decayed', () => {
    // The reading that separates "max against the live level" from "max against
    // the stored peak": halfway through a fast pulse, a slow gate arrives whose
    // own peak is below the original peak but ABOVE what is currently on screen.
    // Against the stored peak it would be discarded and the screen would jump
    // DOWN as the window restarted; against the live level it lifts.
    const pulse = createGatePulse()
    pulse.fire(anniv, 340, 1)
    pulse.update(anniv.seconds * 0.6)
    const live = pulse.level
    pulse.fire(anniv, 120, 1)
    expect(pulse.level).toBeGreaterThan(live)
    expect(pulse.level).toBeLessThan(pulsePeak(anniv, 340, 1))
    expect(pulse.level).toBeCloseTo(pulsePeak(anniv, 120, 1), 12)
  })

  it('DEV-638: a clean gate pulses harder than a plain one, and never past the full pulse', () => {
    const plain = createGatePulse()
    const clean = createGatePulse()
    plain.fire(anniv, 120, 1)
    clean.fire(anniv, 120, 1, 1.6)
    expect(clean.level).toBeGreaterThan(plain.level)
    // The clamp is on the SCALED peak: no scale can exceed the full pulse.
    const huge = createGatePulse()
    huge.fire(anniv, 340, 1, 1000)
    expect(huge.level).toBeLessThanOrEqual(1)
    // A scale of nothing (absent, zero, negative) is the plain pulse.
    for (const scale of [undefined, 0, -2]) {
      const p = createGatePulse()
      p.fire(anniv, 120, 1, scale)
      expect(p.level).toBeCloseTo(plain.level, 12)
    }
  })

  it('DEV-638: the clean scale does not breach the slider: Speed FX off is still no pulse', () => {
    const p = createGatePulse()
    p.fire(anniv, 340, 0, 1.6)
    expect(p.level).toBe(0)
  })

  it('turns the wedges so no two gates IN A ROW stamp the same pattern', () => {
    // The picture repeats every WEDGE, not every turn, so the separation that
    // decides whether two passes look alike is the phase difference modulo
    // `2π / streaks`. This assertion is scoped to CONSECUTIVE gates, and the
    // scoping is the finding: the first version asked it of all 21 gates of
    // `int_01`, which no step can satisfy — twenty-one points inside one wedge
    // have a mean spacing of a twenty-first of it, so some pair is always close.
    // `PHASE_STEP`'s own comment now carries the measured table.
    const pulse = createGatePulse()
    const seen: number[] = []
    for (let i = 0; i < 21; i++) {
      pulse.fire(anniv, 200, 1)
      seen.push(pulse.phase)
    }
    const wedge = (Math.PI * 2) / anniv.streaks
    const apart = (a: number, b: number): number => {
      const d = (((a - b) % wedge) + wedge) % wedge
      return Math.min(d, wedge - d) / wedge
    }
    for (let i = 1; i < seen.length; i++) {
      expect(apart(seen[i] as number, seen[i - 1] as number)).toBeGreaterThan(0.25)
    }
    // And the phase itself never comes back to where it started, because the
    // step is an irrational fraction of a turn. This is what says the driver
    // needs no seed and no PRNG.
    expect(PHASE_STEP / (Math.PI * 2)).not.toBeCloseTo(1 / 3, 6)
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).not.toBeCloseTo(seen[0] as number, 6)
    }
  })
})

describe('S6 — the comfort slider', () => {
  it('draws nothing at `off` and half at `light`', () => {
    // §2.6 names S6's pulse in the list the slider scales, beside S1's density,
    // S2's width and S3's amplitude. `off` must be nothing at all rather than a
    // little: a player who turned the speed effects off did not ask for a
    // quieter flash.
    expect(pulsePeak(anniv, 340, 0)).toBe(0)
    expect(pulsePeak(anniv, 340, 0.5)).toBeCloseTo(pulsePeak(anniv, 340, 1) / 2, 12)
  })

  it('never exceeds an alpha of one, whatever the preset asks for', () => {
    const loud = { ...anniv, strength: 4 }
    expect(pulsePeak(loud, 340, 1)).toBe(1)
  })
})

describe('S6 — one event, two channels', () => {
  it('is keyed on the SAME breakpoints as the whoosh it fires beside', () => {
    // DEV-069's lesson: when another file already holds the shape, assert
    // against that file rather than restating the numbers here. A gate that
    // sounded big and looked small would be the two channels disagreeing about
    // one event, and nothing else in the suite would see it.
    const whoosh = anniversary.audio.speedCurves.gateWhooshGain
    expect(anniv.gainBySpeed.map(([x]) => x)).toEqual(whoosh.map(([x]) => x))
    expect(anniv.gainBySpeed.map(([, y]) => y)).toEqual(whoosh.map(([, y]) => y))
  })

  it('is smaller at 40 m/s than at 240, because those are not the same gate', () => {
    expect(pulsePeak(anniv, 40, 1)).toBeLessThan(pulsePeak(anniv, 240, 1))
  })
})

describe('S6 — the colour is extracted, not invented', () => {
  it('is the ring’s own glow, brought toward white by the preset’s tint', () => {
    const glow = PROPS.checkpointRing.frameGlowColor
    const [r, g, b] = pulseColorLinear(anniv.tint)
    const expected = [0, 1, 2].map((i) => {
      const c = srgbToLinear(glow[i] as number)
      return c + (1 - c) * anniv.tint
    })
    expect([r, g, b]).toEqual(expected)
    // The endpoints, which are what say the blend runs the way the key claims.
    expect(pulseColorLinear(0)[1]).toBeCloseTo(srgbToLinear(glow[1] as number), 12)
    expect(pulseColorLinear(1)).toEqual([1, 1, 1])
    // Green, still: the gate's colour must survive the blend or the key is
    // decoration. Rec.709 is not needed to say a green channel leads.
    expect(g).toBeGreaterThan(r)
    expect(g).toBeGreaterThan(b)
  })
})

describe('S6 — the wedge count is whole', () => {
  it('is an integer in both presets', () => {
    expect(Number.isInteger(anniv.streaks)).toBe(true)
    expect(Number.isInteger(classic.fx.gatePulse.streaks)).toBe(true)
  })

  it('is refused at load when it is not', () => {
    const bad = structuredClone(anniversary) as Edition & { fx: { gatePulse: { streaks: number } } }
    bad.fx.gatePulse.streaks = 13.5
    expect(() => validateEdition(bad)).toThrow(/whole number/)
  })
})
