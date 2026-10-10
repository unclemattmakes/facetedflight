// tests/unit/audio-cues.test.ts — the catalogue is DATA, so it is assertable.
//
// The audio port's whole claim is that the event map, the gain chain and the
// timing are faithful even though every sample is new. That claim lives in
// `src/audio/cues.ts` as numbers, and numbers can be checked — which is the
// reason the synthesis recipes are plain data and not a sequence of
// `ctx.createOscillator()` calls no node test could ever run.
//
// What is checked here is the arithmetic and the invariants, not taste. "Does
// the boost roar land" is a line on the M5b checklist next to the medal
// arithmetic (D13), and it is Matt's ear, in a headset.

import { describe, expect, it } from 'vitest'
import { CUE_IDS, CUES, type CueSpec, cue, cueTailSeconds, resolveVariation } from '@/audio/cues'
import { cueGain, MASTER_SFX } from '@/audio/mix'

const all: CueSpec[] = CUE_IDS.map((id) => cue(id))
const loops = all.filter((s) => s.loop)
const oneShots = all.filter((s) => !s.loop)

/** A deterministic [0,1) generator. `src/audio/` is not the sim, but a test is. */
const cycle = (values: readonly number[]): (() => number) => {
  let i = 0
  return () => values[i++ % values.length] ?? 0
}

describe('the catalogue is total and self-consistent', () => {
  it('every key maps to a spec that agrees with its own id', () => {
    expect(CUE_IDS.length).toBeGreaterThan(0)
    for (const id of CUE_IDS) expect(CUES[id].id).toBe(id)
  })

  it('has both a one-shot and a loop half, and every cue is one or the other', () => {
    expect(loops.length).toBeGreaterThan(0)
    expect(oneShots.length).toBeGreaterThan(0)
    expect(loops.length + oneShots.length).toBe(all.length)
  })

  it('every cue has at least one layer and at least one variation', () => {
    for (const s of all) {
      expect(s.layers.length, s.id).toBeGreaterThan(0)
      expect(s.variations.length, s.id).toBeGreaterThan(0)
    }
  })

  it('every cue cites where its numbers came from', () => {
    for (const s of all) {
      expect(s.provenance.length, s.id).toBeGreaterThan(10)
      // A cue that is a port of a 2016 group must name the prefab it was read
      // off. A cue that is ours must say so — there are three, and they are
      // deviation candidates AUD-4 and AUD-6.
      if (s.group !== null && s.bank !== null) {
        expect(s.provenance, s.id).toMatch(/MasterAudio_(hoverJet|ship)\.prefab:\d+/)
      }
    }
  })
})

describe('the gain chain is MasterAudio.cs:1718', () => {
  // calcVolume = varVol * groupVolume * busVolume * _masterAudioVolume, and
  // busVolume is 1 for all 54 groups in both banks (every one is busIndex: 0).
  it('every cue gain is exactly clip x group x 0.75', () => {
    for (const s of all) {
      expect(s.gain, s.id).toBeCloseTo(s.clipVolume * s.groupVolume * MASTER_SFX, 12)
      expect(s.gain, s.id).toBe(cueGain(s.groupVolume, s.clipVolume))
    }
  })

  it('no cue is silent and none clips', () => {
    for (const s of all) {
      expect(s.gain, s.id).toBeGreaterThan(0)
      expect(s.gain, s.id).toBeLessThanOrEqual(1)
    }
  })

  it('matches the prefab on four spot values', () => {
    // MasterAudio_hoverJet.prefab:5019 CollectRing groupMasterVolume 0.86538464,
    // variation clip volume 1.
    expect(cue('ring.pass').gain).toBeCloseTo(0.86538464 * 0.75, 10)
    // :8231 JumpSeat_Idle 0.65384614 with the variation's clip volume 0.1 —
    // the 0.1 is why the idle is a bed and not a sound.
    expect(cue('engine.idle').gain).toBeCloseTo(0.65384614 * 0.1 * 0.75, 10)
    // :3704 AfterBurner groupMasterVolume 1, clip volume 1.
    expect(cue('engine.afterburner').gain).toBeCloseTo(0.75, 10)
    // :4275 explode2 0.30769235 — the quietest thing in the game that is not a bed.
    expect(cue('ship.crash').gain).toBeCloseTo(0.30769235 * 0.75, 10)
  })

  it('the idle bed is the quietest cue in the catalogue', () => {
    // Not decoration: 0.049 against a ring ding's 0.649 is a factor of 13, and
    // it is the difference between a bed and a sound. If a later tuning pass
    // ever makes the hum louder than a gate, that is a mix decision and it
    // should have to delete this line to make it.
    const quietest = all.reduce((a, b) => (a.gain <= b.gain ? a : b))
    expect(quietest.id).toBe('engine.idle')
  })
})

describe('the engine loops keep their 2016 pitch ratios', () => {
  // There is ZERO runtime pitch modulation in first-party 2016 code, so these
  // three static pitches are the ENTIRE throttle feel: Thrusters 0.94,
  // AfterBurner 0.88, JumpSeat_Idle 0.55 (with clip volume 0.1). What matters
  // when there is no clip is their ratio to each other, and that is what this
  // asserts — the absolute numbers are meaningless against a synthesized voice,
  // the intervals are not.
  it('carries the three pitches off the prefab', () => {
    expect(cue('engine.thrust').pitch).toBe(0.94)
    expect(cue('engine.afterburner').pitch).toBe(0.88)
    expect(cue('engine.idle').pitch).toBe(0.55)
  })

  it('orders them idle < afterburner < thrust', () => {
    expect(cue('engine.idle').pitch).toBeLessThan(cue('engine.afterburner').pitch)
    expect(cue('engine.afterburner').pitch).toBeLessThan(cue('engine.thrust').pitch)
  })
})

describe('loops and one-shots obey their own rules', () => {
  it('a loop has no duration and cannot interrupt itself', () => {
    for (const s of loops) {
      expect(s.durationSeconds, s.id).toBe(0)
      // 2016's retriggerPercentage 100 on Thrusters / JumpSeat_Idle / whoosh,
      // generalised: asking a running bed to start again must be a no-op, or
      // holding the throttle stacks an engine loop every tick at 82 Hz.
      expect(s.retrigger, s.id).toBe('ignore')
    }
  })

  it('a one-shot has a positive duration and may retrigger', () => {
    for (const s of oneShots) {
      expect(s.durationSeconds, s.id).toBeGreaterThan(0)
      expect(s.retrigger, s.id).toBe('restart')
    }
  })

  it('every layer is inside sane bounds', () => {
    for (const s of all) {
      for (const [i, layer] of s.layers.entries()) {
        const where = `${s.id}[${i}]`
        expect(layer.gain, where).toBeGreaterThan(0)
        expect(layer.gain, where).toBeLessThanOrEqual(1)
        expect(layer.delaySeconds, where).toBeGreaterThanOrEqual(0)
        expect(layer.env.attack, where).toBeGreaterThanOrEqual(0)
        expect(layer.env.decay, where).toBeGreaterThanOrEqual(0)
        expect(layer.env.release, where).toBeGreaterThanOrEqual(0)
        expect(layer.env.sustain, where).toBeGreaterThanOrEqual(0)
        expect(layer.env.sustain, where).toBeLessThanOrEqual(1)
        // Audible band. A 20 Hz fundamental is felt and a 20 kHz one is a dog
        // whistle; either is a typo, not a choice.
        expect(layer.startHz, where).toBeGreaterThan(20)
        expect(layer.startHz, where).toBeLessThan(20_000)
        expect(layer.endHz, where).toBeGreaterThan(20)
        expect(layer.endHz, where).toBeLessThan(20_000)
        expect(layer.sweepSeconds, where).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('a loop sustains and therefore cannot fade to nothing on its own', () => {
    // A looping voice runs attack -> decay -> sustain and then holds. A sustain
    // of zero is a bed that silently disappears a fraction of a second after it
    // starts, with the state machine still believing it is running — which is
    // exactly the class of bug that survives four sessions.
    for (const s of loops) {
      for (const [i, layer] of s.layers.entries()) {
        expect(layer.env.sustain, `${s.id}[${i}]`).toBeGreaterThan(0)
      }
    }
  })
})

describe('cueTailSeconds is derived, not trusted', () => {
  // DEV-027: say what a number is the max OF. It is the max over layers of
  // delay + attack + decay + release, and the declared duration.
  it('is never shorter than the declared duration', () => {
    for (const s of oneShots) {
      expect(cueTailSeconds(s), s.id).toBeGreaterThanOrEqual(s.durationSeconds)
    }
  })

  it('covers the latest layer, including one that starts after the cue "ends"', () => {
    for (const s of all) {
      for (const [i, layer] of s.layers.entries()) {
        const end = layer.delaySeconds + layer.env.attack + layer.env.decay + layer.env.release
        expect(cueTailSeconds(s), `${s.id}[${i}]`).toBeGreaterThanOrEqual(end)
      }
    }
  })

  it('catches a layer that outlives its cue', () => {
    const s = cue('run.medal')
    const stretched: CueSpec = {
      ...s,
      layers: [...s.layers, { ...s.layers[0], delaySeconds: 9 } as (typeof s.layers)[number]],
    }
    expect(cueTailSeconds(stretched)).toBeGreaterThan(9)
  })
})

describe('variations and jitter', () => {
  it('every pitch jitter range is positive and ordered', () => {
    for (const s of all) {
      const [lo, hi] = s.pitchJitter
      expect(lo, s.id).toBeGreaterThan(0)
      expect(hi, s.id).toBeGreaterThanOrEqual(lo)
    }
  })

  it('the ring ding really has six variations, and all six are reachable', () => {
    // The count IS the feature: `CollectRing` is the most-heard cue in the game
    // at 21 a lap, and six randomised clips is what stops it going stale.
    const ring = cue('ring.pass')
    expect(ring.variations.length).toBe(6)
    const seen = new Set<number>()
    // Six probes, one per bucket, each pair of draws being (variation, jitter).
    for (let i = 0; i < 6; i++) {
      const r = cycle([i / 6 + 0.01, 0.5])
      seen.add(resolveVariation(ring, r).pitch)
    }
    expect(seen.size).toBe(6)
  })

  it('resolves to the cue pitch when there is one variation and no jitter', () => {
    const idle = cue('engine.idle')
    expect(resolveVariation(idle, cycle([0.4, 0.9])).pitch).toBeCloseTo(0.55, 12)
  })

  it('applies 2016 jitter as a multiplier across the authored range', () => {
    // button_click: useRandomPitch 1, randomPitchMode 0 (AddToClipPitch),
    // -0.1..+0.4 on a clip pitch of 1 -> a multiplier of 0.9..1.4.
    const confirm = cue('ui.confirm')
    expect(confirm.pitchJitter).toEqual([0.9, 1.4])
    expect(resolveVariation(confirm, cycle([0, 0])).pitch).toBeCloseTo(0.9, 12)
    expect(resolveVariation(confirm, cycle([0, 0.999999])).pitch).toBeCloseTo(1.4, 4)
  })

  it('never resolves a non-positive pitch, whatever the generator returns', () => {
    // A pitch of zero or below is an oscillator that does not oscillate or one
    // that runs backwards; a random source at either extreme must not produce
    // one on any cue in the catalogue.
    for (const s of all) {
      for (const r of [cycle([0, 0]), cycle([0.999999, 0.999999]), cycle([0.5, 0.5])]) {
        expect(resolveVariation(s, r).pitch, s.id).toBeGreaterThan(0)
      }
    }
  })

  it('clamps a generator that returns exactly 1', () => {
    // `Math.random()` is [0, 1), but a stub or a future source might not be,
    // and an out-of-range index would resolve to `undefined` and a pitch of 1 —
    // i.e. silently drop the variation system.
    const ring = cue('ring.pass')
    const last = ring.variations[ring.variations.length - 1]
    expect(resolveVariation(ring, cycle([1, 0])).pitch).toBeCloseTo(
      ring.pitch * (last?.pitch ?? 1) * ring.pitchJitter[0],
      12,
    )
  })
})
