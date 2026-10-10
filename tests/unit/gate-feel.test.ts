// tests/unit/gate-feel.test.ts: the gate as the hero (DEV-638) and its losses (DEV-639).
//
// Two halves. The ladder and the loss classifier live in `game/gate-feel.ts` and
// read the SIM's verdict; what a count sounds like lives in `audio/ladder.ts` and
// the map in `audio/events.ts`. The assertions are relationships (a rung is a
// semitone, a reset is back to the floor), not restated constants.

import { describe, expect, it } from 'vitest'
import type { CueAction } from '@/audio/engine'
import { actionsForEvent } from '@/audio/events'
import {
  GATE_LOSS_VOICE,
  type GateLossKind,
  ladderPitch,
  ladderSemitones,
  SEMITONES_PER_OCTAVE,
} from '@/audio/ladder'
import {
  createChainWatch,
  createGateLadder,
  GATE_FEEL,
  ladderChainExpired,
  ladderGate,
  resetGateLadder,
} from '@/game/gate-feel'
import { createGateEvents, recordGate } from '@/sim/gate-quality'

const play = (event: Parameters<typeof actionsForEvent>[0]): CueAction[] =>
  actionsForEvent(event, [])

describe('the pitch ladder: what a streak sounds like', () => {
  it('the first clean gate is at the floor, then one semitone per consecutive clean gate', () => {
    expect(ladderSemitones(0)).toBe(0)
    expect(ladderSemitones(1)).toBe(0)
    for (let n = 2; n <= 9; n++) expect(ladderSemitones(n) - ladderSemitones(n - 1)).toBe(1)
  })

  it('is capped at an octave, and the octave is exactly 2x', () => {
    expect(ladderSemitones(500)).toBe(SEMITONES_PER_OCTAVE)
    expect(ladderPitch(500)).toBeCloseTo(2, 12)
    expect(ladderPitch(1)).toBe(1)
  })

  it('every rung is the same frequency ratio above the last: a scale, not a slope', () => {
    const step = ladderPitch(3) / ladderPitch(2)
    for (let n = 3; n <= 12; n++) expect(ladderPitch(n) / ladderPitch(n - 1)).toBeCloseTo(step, 12)
    expect(step).toBeCloseTo(2 ** (1 / 12), 12)
  })

  it('a non-finite or negative streak answers the floor, not NaN', () => {
    expect(ladderPitch(Number.NaN)).toBe(1)
    expect(ladderPitch(-3)).toBe(1)
  })
})

describe('the ladder: what the count does', () => {
  it('DEV-845: every gate taken in time extends the chain, clean or not', () => {
    const ladder = createGateLadder()
    for (let i = 0; i < 5; i++) ladderGate(ladder, true)
    expect(ladder.streak).toBe(5)
    expect(ladder.run).toBe(5)
    ladderGate(ladder, false)
    // The chain keeps; only the clean run falls.
    expect(ladder.streak).toBe(6)
    expect(ladder.run).toBe(0)
    expect(ladder.lost).toBe(0)
    ladderGate(ladder, true)
    expect(ladder.streak).toBe(7)
    expect(ladder.run).toBe(1)
  })

  it('falls only when the speed chain expires, and says what that cost', () => {
    const ladder = createGateLadder()
    for (let i = 0; i < 4; i++) ladderGate(ladder, i % 2 === 0)
    expect(ladderChainExpired(ladder)).toBe(4)
    expect(ladder.streak).toBe(0)
    expect(ladder.run).toBe(0)
    ladderGate(ladder, false)
    expect(ladder.lost).toBe(0)
  })

  it('agrees with the SIM on which gates are clean (it reads its verdict, never its own)', () => {
    // The sim's own clean streak (the clean-gate bonus) and the ladder's clean
    // run walk together while no chain expires. Run the real `recordGate`.
    const spec = {
      cleanCentredness: 0.6,
      minSpeed: 100,
      nearMissMetres: 8,
      nearMissCooldown: 1,
      nearMissPoints: 0,
    }
    const events = createGateEvents()
    const ladder = createGateLadder()
    const centred = [0.9, 0.8, 0.2, 0.95, 0.7, 0.7, 0.1, 0.9]
    for (const c of centred) {
      ladderGate(ladder, recordGate(events, c, 150, spec))
      expect(ladder.run).toBe(events.cleanStreak)
    }
    expect(ladder.streak).toBe(centred.length)
  })

  it('a reset clears both numbers', () => {
    const ladder = createGateLadder()
    ladderGate(ladder, true)
    ladderGate(ladder, false)
    resetGateLadder(ladder)
    expect(ladder).toEqual({ streak: 0, run: 0, lost: 0 })
  })

  it('trap 19: stepping a SECOND ladder does not move the first', () => {
    const a = createGateLadder()
    const b = createGateLadder()
    ladderGate(a, true)
    ladderGate(a, true)
    ladderGate(b, false)
    expect(a.streak).toBe(2)
    expect(a.run).toBe(2)
    expect(b.streak).toBe(1)
    expect(b.run).toBe(0)
  })
})

describe('the loss: only the chain running out', () => {
  it('the chain watch fires on the one step the stacks fall to nothing, never on a gate', () => {
    const watch = createChainWatch()
    expect(watch.step(0)).toBe(false)
    expect(watch.step(1)).toBe(false)
    expect(watch.step(2)).toBe(false)
    expect(watch.step(2)).toBe(false)
    expect(watch.step(0)).toBe(true)
    expect(watch.step(0)).toBe(false)
  })

  it('a drop the caller masks (a crash reset) is not an expiry', () => {
    const watch = createChainWatch()
    watch.step(3)
    expect(watch.step(0, true)).toBe(false)
  })
})

describe('the loss cue: one cue, three voices', () => {
  const kinds: GateLossKind[] = ['miss', 'streak', 'chain']

  it('every kind plays gate.dud at its own level and pitch', () => {
    for (const loss of kinds) {
      const [a] = play({ type: 'gate.loss', loss })
      expect(a).toMatchObject({
        kind: 'play',
        cue: 'gate.dud',
        gain: GATE_LOSS_VOICE[loss].gain,
        pitch: GATE_LOSS_VOICE[loss].pitch,
      })
    }
  })

  it('a break of the streak is the loudest, the chain the lowest, a plain miss the quietest', () => {
    expect(GATE_LOSS_VOICE.streak.gain).toBeGreaterThan(GATE_LOSS_VOICE.chain.gain)
    expect(GATE_LOSS_VOICE.chain.gain).toBeGreaterThan(GATE_LOSS_VOICE.miss.gain)
    expect(GATE_LOSS_VOICE.chain.pitch).toBeLessThan(GATE_LOSS_VOICE.streak.pitch)
    expect(GATE_LOSS_VOICE.streak.pitch).toBeLessThan(GATE_LOSS_VOICE.miss.pitch)
  })

  it('every loss is quieter than the gain it follows (a loss must not outshout a ring)', () => {
    for (const loss of kinds) expect(GATE_LOSS_VOICE[loss].gain).toBeLessThanOrEqual(1)
  })
})

describe('the gate event: a clean gate climbs, every other gate is the 2016 cue', () => {
  it('a clean gate on rung N is ring.pass at the ladder pitch, variations skipped', () => {
    const [ring, boost] = play({
      type: 'gate.passed',
      index: 3,
      kind: 'ring',
      clean: true,
      streak: 4,
    })
    expect(ring).toMatchObject({
      kind: 'play',
      cue: 'ring.pass',
      exact: true,
      pitch: ladderPitch(4),
    })
    expect(boost).toMatchObject({ kind: 'play', cue: 'ring.boost' })
  })

  it('a gate that is not clean, or carries no verdict (Classic, a pad), is exactly what it was', () => {
    for (const event of [
      { type: 'gate.passed', index: 3, kind: 'ring', clean: false, streak: 0 },
      { type: 'gate.passed', index: 3, kind: 'ring' },
      { type: 'gate.passed', index: 3 },
    ] as const) {
      expect(play(event)).toEqual([
        { kind: 'play', cue: 'ring.pass' },
        { kind: 'play', cue: 'ring.boost' },
      ])
    }
  })

  it('the rungs rise with the streak until the octave, then hold', () => {
    const pitches = [1, 2, 3, 8, 13, 14, 40].map((streak) => {
      const [ring] = play({ type: 'gate.passed', index: 0, kind: 'ring', clean: true, streak })
      return ring?.kind === 'play' ? (ring.pitch ?? 1) : Number.NaN
    })
    for (let i = 1; i < pitches.length; i++) {
      expect(pitches[i] as number).toBeGreaterThanOrEqual(pitches[i - 1] as number)
    }
    expect(pitches[4]).toBeCloseTo(2, 12)
    expect(pitches[6]).toBeCloseTo(2, 12)
  })
})

describe('the numbers the wiring reads', () => {
  it('a gate kick is a small shove: positive, and brief next to the gate-to-gate gap', () => {
    expect(GATE_FEEL.fovKickDegrees).toBeGreaterThan(0)
    expect(GATE_FEEL.fovKickSeconds).toBeGreaterThan(0)
    expect(GATE_FEEL.fovKickSeconds).toBeLessThan(1)
  })

  it('a clean pulse is stronger than a plain one, and the sparkle layer is a smaller, faster spray', () => {
    expect(GATE_FEEL.cleanPulseScale).toBeGreaterThan(1)
    expect(GATE_FEEL.sparkleScale).toBeLessThan(1)
    expect(GATE_FEEL.sparkleSpeed).toBeGreaterThan(1)
  })
})
