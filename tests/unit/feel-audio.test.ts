// tests/unit/feel-audio.test.ts: the audio half of DEV-642 and DEV-643.
//
// A near miss whooshes from the side the terrain was on; a crash's gain and low
// end scale with the speed into the surface and a graze stays 2016's cue; the
// music ducks and comes back; and the crash's one timeline (hold, splash,
// curtain) and the near-miss geometry are asserted as geometry and arithmetic.

import { describe, expect, it } from 'vitest'
import { createRecordingBackend } from '@/audio/backend'
import { CUES } from '@/audio/cues'
import type { CueAction } from '@/audio/engine'
import {
  actionsForEvent,
  CRASH_GAIN_BOOST,
  CRASH_PITCH_DROP,
  CRASH_WEIGHT_FROM,
  CRASH_WEIGHT_FULL,
  crashWeight,
} from '@/audio/events'
import { createAudioSystem } from '@/audio/index'
import { toListenerSpace } from '@/audio/spatial'
import type { Feel } from '@/boot/feel'
import {
  CRASH_CURTAIN_DELAY_SECONDS,
  CRASH_HOLD_MS,
  createBoostFeel,
  createCrashFeel,
  NEAR_MISS_WHOOSH_METRES,
  nearMissAt,
  nearMissSide,
} from '@/boot/feel-events'

describe('a crash has weight (DEV-643)', () => {
  it('a graze is 2016’s cue exactly: no gain, no pitch, no sub layer', () => {
    expect(actionsForEvent({ type: 'ship.struck' }, [])).toEqual([
      { kind: 'play', cue: 'ship.crash' },
    ])
    for (const impact of [0, 5, CRASH_WEIGHT_FROM]) {
      const out = actionsForEvent({ type: 'ship.struck', impact }, [])
      expect(out).toEqual([{ kind: 'play', cue: 'ship.crash' }])
    }
  })

  it('weight is 0 at the floor, 1 at the ceiling and linear between', () => {
    expect(crashWeight(CRASH_WEIGHT_FROM)).toBe(0)
    expect(crashWeight(CRASH_WEIGHT_FULL)).toBe(1)
    expect(crashWeight(10_000)).toBe(1)
    const mid = (CRASH_WEIGHT_FROM + CRASH_WEIGHT_FULL) / 2
    expect(crashWeight(mid)).toBeCloseTo(0.5, 12)
  })

  it('a harder hit is louder, lower and has a bigger sub layer than a softer one', () => {
    const gains = [50, 90, 140].map((impact) => {
      const out = actionsForEvent({ type: 'ship.struck', impact }, []) as Extract<
        CueAction,
        { kind: 'play' }
      >[]
      const crash = out.find((a) => a.cue === 'ship.crash')
      const sub = out.find((a) => a.cue === 'ship.crash.sub')
      expect(sub).toBeDefined()
      return { gain: crash?.gain ?? 0, pitch: crash?.pitch ?? 1, sub: sub?.gain ?? 0 }
    })
    for (let i = 1; i < gains.length; i++) {
      expect(gains[i]!.gain).toBeGreaterThan(gains[i - 1]!.gain)
      expect(gains[i]!.pitch).toBeLessThan(gains[i - 1]!.pitch)
      expect(gains[i]!.sub).toBeGreaterThan(gains[i - 1]!.sub)
    }
    expect(gains[2]!.gain).toBeCloseTo(1 + CRASH_GAIN_BOOST, 12)
    expect(gains[2]!.pitch).toBeCloseTo(1 - CRASH_PITCH_DROP, 12)
  })

  it('the sub layer lives in the catalogue and is low', () => {
    const layers = CUES['ship.crash.sub'].layers
    for (const l of layers) {
      if (l.kind === 'tone') expect(Math.max(l.startHz, l.endHz)).toBeLessThan(100)
      else expect(Math.max(l.startHz, l.endHz)).toBeLessThan(400)
    }
  })

  it('reaches the backend through the system, with the gain scaled by the weight', () => {
    const backend = createRecordingBackend()
    const s = createAudioSystem({ backend, random: () => 0 })
    s.event({ type: 'ship.struck', impact: CRASH_WEIGHT_FULL })
    const plays = backend.calls.filter((c) => c.call === 'play')
    const crash = plays.find((c) => c.id === 'ship.crash')
    const sub = plays.find((c) => c.id === 'ship.crash.sub')
    expect(crash).toBeDefined()
    expect(sub).toBeDefined()
    if (crash?.call !== 'play') throw new Error('x')
    expect(crash.gain).toBeCloseTo(CUES['ship.crash'].gain * (1 + CRASH_GAIN_BOOST), 10)
  })
})

describe('the music duck (DEV-643)', () => {
  it('goes to the backend as an amount and a duration, and comes back', () => {
    const backend = createRecordingBackend()
    const s = createAudioSystem({ backend, random: () => 0 })
    s.duckMusic(1, 0.1)
    s.duckMusic(0, 0.5)
    expect(backend.calls.filter((c) => c.call === 'musicDuck')).toEqual([
      { call: 'musicDuck', amount: 1, seconds: 0.1 },
      { call: 'musicDuck', amount: 0, seconds: 0.5 },
    ])
  })
})

describe('the near miss whoosh (DEV-642)', () => {
  it('is a positional cue, in the whoosh family, with no Doppler', () => {
    const cue = CUES['terrain.whoosh']
    expect(cue.group).toBe('whoosh')
    expect(cue.spatial).not.toBeNull()
    expect(cue.spatial?.doppler).toBe(0)
  })

  it('the event plays it at the point it was given', () => {
    const out = actionsForEvent({ type: 'ship.nearMiss', at: [-8, 0, 0] }, [])
    expect(out).toEqual([{ kind: 'play', cue: 'terrain.whoosh', at: [-8, 0, 0] }])
  })

  it('comes from the SIDE the terrain was on: a left wall is heard to the left', () => {
    // The camera looks down -z with +x right (WebAudio's own frame). The probe
    // indices are `sim/surface-proximity.ts`'s PROBES: 0 left, 1 right, 3 and 4
    // the lower diagonals, 2 straight down.
    const head = { x: 100, y: 50, z: -30 }
    const right = { x: 1, y: 0, z: 0 }
    const listener = {
      position: [head.x, head.y, head.z] as const,
      forward: [0, 0, -1] as const,
      up: [0, 1, 0] as const,
    }
    const at = (probe: number) =>
      toListenerSpace(listener, nearMissAt([0, 0, 0], head, right, probe))
    expect(at(0)[0]).toBeCloseTo(-NEAR_MISS_WHOOSH_METRES, 9)
    expect(at(1)[0]).toBeCloseTo(NEAR_MISS_WHOOSH_METRES, 9)
    expect(at(3)[0]).toBeLessThan(0)
    expect(at(4)[0]).toBeGreaterThan(0)
    // Down and ahead-down are centred, and below.
    for (const p of [2, 5, -1]) {
      const v = at(p)
      expect(v[0]).toBe(0)
      expect(v[1]).toBeCloseTo(-NEAR_MISS_WHOOSH_METRES, 9)
    }
    // Every emitter is the same distance from the head: the level does not
    // depend on which probe won.
    for (const p of [0, 1, 2, 3, 4, 5]) {
      const v = at(p)
      expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(NEAR_MISS_WHOOSH_METRES, 9)
    }
  })

  it('names the side from the probe index', () => {
    expect([0, 1, 2, 3, 4, 5, -1].map(nearMissSide)).toEqual([-1, 1, 0, -1, 1, 0, 0])
  })
})

describe('the crash timeline: hold, splash, curtain (DEV-643, DEV-797)', () => {
  const stubFeel = () => {
    const calls: string[] = []
    const feel = {
      shake: (t: number) => calls.push(`shake ${t}`),
      haptic: (k: string) => calls.push(`haptic ${k}`),
      jolt: () => calls.push('jolt'),
      fovKick: () => {},
      boostHum: (l: number) => calls.push(`hum ${l}`),
    } as unknown as Feel
    return { feel, calls }
  }

  it('the hold is inside Matt’s 80 to 120 ms and the curtain waits about 0.4 s', () => {
    expect(CRASH_HOLD_MS).toBeGreaterThanOrEqual(80)
    expect(CRASH_HOLD_MS).toBeLessThanOrEqual(120)
    expect(CRASH_CURTAIN_DELAY_SECONDS).toBeGreaterThan(0.3)
    expect(CRASH_CURTAIN_DELAY_SECONDS).toBeLessThan(0.5)
  })

  it('holds the frame from the crash for the hold, then lets the world draw', () => {
    const { feel } = stubFeel()
    const c = createCrashFeel(feel)
    expect(c.holdsFrame(1000, false)).toBe(false)
    c.begin(1000, false)
    expect(c.holdsFrame(1000, false)).toBe(true)
    expect(c.holdsFrame(1000 + CRASH_HOLD_MS - 1, false)).toBe(true)
    expect(c.holdsFrame(1000 + CRASH_HOLD_MS, false)).toBe(false)
  })

  it('NEVER holds a frame in a headset', () => {
    const { feel } = stubFeel()
    const c = createCrashFeel(feel)
    c.begin(1000, true)
    expect(c.holdsFrame(1010, true)).toBe(false)
    // Even if a session starts mid-hold.
    c.begin(2000, false)
    expect(c.holdsFrame(2010, true)).toBe(false)
  })

  it('shakes, jolts and rumbles at the blow, and clear drops the hold', () => {
    const { feel, calls } = stubFeel()
    const c = createCrashFeel(feel)
    c.begin(0, false)
    expect(calls).toContain('jolt')
    expect(calls).toContain('haptic crash')
    expect(calls.some((x) => x.startsWith('shake'))).toBe(true)
    c.clear()
    expect(c.holdsFrame(1, false)).toBe(false)
  })

  it('the curtain is due only after the delay, on the sim’s own clock', () => {
    const { feel } = stubFeel()
    const c = createCrashFeel(feel)
    expect(c.curtainDue(0)).toBe(false)
    expect(c.curtainDue(CRASH_CURTAIN_DELAY_SECONDS - 0.001)).toBe(false)
    expect(c.curtainDue(CRASH_CURTAIN_DELAY_SECONDS)).toBe(true)
  })

  it('the curtain starts BEFORE the sim’s hold ends, so the reset lands behind it', () => {
    // The sim's `gameplay.crash.holdSeconds` is 0.55 and is untouched. The curtain
    // must be solid by then: delay plus the kill snap has to fit inside it.
    const hold = 0.55
    const killSnap = 0.1
    expect(CRASH_CURTAIN_DELAY_SECONDS + killSnap * 0.85).toBeLessThan(hold)
  })
})

describe('the boost feel', () => {
  it('shakes on a RISING stage while boosting, not falling and not unboosted', () => {
    const calls: string[] = []
    const feel = {
      shake: (t: number) => calls.push(`shake ${t}`),
      boostHum: (l: number) => calls.push(`hum ${l.toFixed(2)}`),
    } as unknown as Feel
    const b = createBoostFeel(feel)
    b.step(true, 100)
    b.step(true, 130) // stage 1
    expect(calls.filter((c) => c.startsWith('shake'))).toHaveLength(1)
    b.step(true, 130)
    expect(calls.filter((c) => c.startsWith('shake'))).toHaveLength(1)
    b.step(true, 100) // falls back
    b.step(false, 130) // rises again, but not boosting: no shake
    expect(calls.filter((c) => c.startsWith('shake'))).toHaveLength(1)
  })

  it('hums while boosting, scaled by stage, and goes to 0 when the tank is empty', () => {
    const levels: number[] = []
    const feel = { shake: () => {}, boostHum: (l: number) => levels.push(l) } as unknown as Feel
    const b = createBoostFeel(feel)
    b.step(true, 0)
    b.step(true, 130)
    b.step(true, 250)
    b.step(true, 360)
    expect(levels[1]!).toBeGreaterThan(levels[0]!)
    expect(levels[3]!).toBeGreaterThan(levels[2]!)
    expect(levels[3]!).toBeLessThanOrEqual(1)
    b.step(false, 360)
    expect(levels.at(-1)).toBe(0)
    b.reset()
    expect(levels.at(-1)).toBe(0)
  })
})
