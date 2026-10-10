// tests/unit/audio-jump-charge.test.ts — the jumping spider's charge tone. DEV-383.
//
// AIRCRAFT-VARIANTS §4.5: the launch is telegraphed by "a ring filling, with a
// rising tone". The ring is `hud-fuel.test.ts`'s; this is the tone, first as
// the pure step and then through the whole audio system against the recording
// backend, where "a charge held through the end of a run does not hum on into
// the hangar" is a transcript rather than a listening test.
//
// The step is compared against the CHARGE it is handed, and
// `spider-charge-input.test.ts` hands it a real spider's charge, so the chain
// from a held trigger to a sounding loop is covered end to end in node.

import { describe, expect, it } from 'vitest'
import { createAudioSystem } from '@/audio'
import { createRecordingBackend } from '@/audio/backend'
import { CUES } from '@/audio/cues'
import type { CueAction } from '@/audio/engine'
import {
  createJumpChargeAudio,
  JUMP_CHARGE_RISE,
  jumpChargeRate,
  stepJumpChargeAudio,
} from '@/audio/jump-charge'
import { SPIDER_READY } from './helpers/spider-ready'

const ticks = (charges: readonly (number | undefined)[]) => {
  const state = createJumpChargeAudio()
  return charges.map((c) => stepJumpChargeAudio(state, c, []))
}

// NOT READY TO SHIP (Matt, 2026-09-25, DEV-403): the spider is `listed: false`,
// and its tests skip on `SPIDER_READY` until it is ready (`variant-listed.test.ts`).
describe.skipIf(!SPIDER_READY)('the charge tone, as a step', () => {
  it('never sounds on a seat that is not charging — undefined on other seats, 0 on an idle spider', () => {
    for (const tick of ticks([undefined, 0, undefined, 0, 0])) expect(tick).toEqual([])
  })

  it('starts on the first tick of a charge, at the right pitch in the same tick', () => {
    const [first] = ticks([0.01])
    expect(first).toEqual([
      { kind: 'play', cue: 'jump.charge' },
      { kind: 'modulate', cue: 'jump.charge', rate: jumpChargeRate(0.01) },
    ])
  })

  it('rises with the charge, an octave over a full one, and plays only once', () => {
    const charges = Array.from({ length: 82 }, (_, i) => (i + 1) / 82)
    const out = ticks(charges).flat()
    expect(out.filter((a) => a.kind === 'play')).toHaveLength(1)
    const rates = out.flatMap((a) => (a.kind === 'modulate' ? [a.rate ?? Number.NaN] : []))
    expect(rates).toHaveLength(charges.length)
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeGreaterThan(rates[i - 1] as number)
    expect(rates[0]).toBeGreaterThan(1)
    // An octave is 1200 cents — the unit the backend turns a rate into.
    expect(1200 * Math.log2(rates.at(-1) as number)).toBeCloseTo(1200, 9)
    expect(JUMP_CHARGE_RISE).toBe(2)
  })

  it('stops the tick the charge ends, once, and starts again for the next one', () => {
    const out = ticks([0.3, 0.6, 0, 0, 0.1])
    const kinds = out.map((tick) => tick.map((a: CueAction) => a.kind))
    expect(kinds).toEqual([['play', 'modulate'], ['modulate'], ['stop'], [], ['play', 'modulate']])
  })

  it('keeps its state per owner (trap 19): one charging leaves the other silent', () => {
    const a = createJumpChargeAudio()
    const b = createJumpChargeAudio()
    stepJumpChargeAudio(a, 0.5, [])
    expect(stepJumpChargeAudio(b, 0, [])).toEqual([])
    expect(a.playing).toBe(true)
    expect(b.playing).toBe(false)
  })

  it('is a loop in the catalogue, so a held charge is one voice and not one per tick', () => {
    expect(CUES['jump.charge'].loop).toBe(true)
    expect(CUES['jump.charge'].retrigger).toBe('ignore')
    // Rate-modulated, so no authored sweep for the modulation to fight.
    for (const layer of CUES['jump.charge'].layers) expect(layer.sweepSeconds).toBe(0)
  })
})

describe.skipIf(!SPIDER_READY)('the charge tone, through the audio system', () => {
  const flying = { speed: 0, throttle: 1, boost: false, released: true }

  it('sounds while the charge builds and stops when it ends', () => {
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend, random: () => 0.5 })
    system.stepFlight({ ...flying, jumpCharge: 0 })
    expect(backend.sounding).not.toContain('jump.charge')
    system.stepFlight({ ...flying, jumpCharge: 0.4 })
    expect(backend.sounding).toContain('jump.charge')
    const mods = backend.calls.filter((c) => c.call === 'modulate' && c.id === 'jump.charge')
    expect(mods).toHaveLength(1)
    system.stepFlight({ ...flying, jumpCharge: 0 })
    expect(backend.sounding).not.toContain('jump.charge')
  })

  it('a HoverJet step, which carries no charge at all, never touches the cue', () => {
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend, random: () => 0.5 })
    for (let i = 0; i < 50; i++)
      system.stepFlight({ speed: 150, throttle: 1, boost: true, released: true })
    expect(backend.calls.some((c) => 'id' in c && c.id === 'jump.charge')).toBe(false)
  })

  it('a charge held through mission.end is silenced, and the next run’s first charge starts it again', () => {
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend, random: () => 0.5 })
    system.stepFlight({ ...flying, jumpCharge: 0.7 })
    system.event({ type: 'mission.end' })
    expect(backend.sounding).not.toContain('jump.charge')
    const plays = () => backend.calls.filter((c) => c.call === 'play' && c.id === 'jump.charge')
    expect(plays()).toHaveLength(1)
    system.stepFlight({ ...flying, jumpCharge: 0.1 })
    expect(plays()).toHaveLength(2)
    expect(backend.sounding).toContain('jump.charge')
  })

  it('stopAll forgets the charge the same way', () => {
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend, random: () => 0.5 })
    system.stepFlight({ ...flying, jumpCharge: 0.7 })
    system.stopAll()
    system.stepFlight({ ...flying, jumpCharge: 0.2 })
    expect(backend.calls.filter((c) => c.call === 'play' && c.id === 'jump.charge')).toHaveLength(2)
  })
})
