// tests/unit/haptics.test.ts: the haptics priority scheduler (DEV-637).
//
// The rule that matters: a stronger effect pre-empts a weaker one, and a weaker
// one NEVER pre-empts a stronger one that is still running. The device itself
// does the opposite (any new call replaces the last), which is the whole reason
// the scheduler exists (research 09 section 7.6). A fake clock and a recording
// sink drive it; the real sinks are exercised against fake gamepads.

import { describe, expect, it } from 'vitest'
import {
  BOOST_HUM_PRIORITY,
  createHapticOutput,
  createHaptics,
  HAPTIC_EFFECTS,
  HAPTIC_PRIORITY,
  type HapticKind,
  type HapticSink,
} from '@/input/haptics'

interface Call {
  strong: number
  weak: number
  ms: number
}

const recorder = () => {
  const calls: Call[] = []
  let stops = 0
  const sink: HapticSink = {
    rumble: (strong, weak, ms) => calls.push({ strong, weak, ms }),
    stop: () => {
      stops++
    },
  }
  return {
    sink,
    calls,
    get stops() {
      return stops
    },
  }
}

describe('the priority order is the brief’s', () => {
  it('crash > hit > near miss > clean gate > gate, with the boost hum under all of them', () => {
    const p = HAPTIC_PRIORITY
    expect(p.crash).toBeGreaterThan(p.hit)
    expect(p.hit).toBeGreaterThan(p.nearMiss)
    expect(p.nearMiss).toBeGreaterThan(p.cleanGate)
    expect(p.cleanGate).toBeGreaterThan(p.gate)
    expect(p.gate).toBeGreaterThan(BOOST_HUM_PRIORITY)
    expect(p.countdown).toBeGreaterThan(BOOST_HUM_PRIORITY)
  })

  it('every effect has segments in time order, magnitudes in 0..1, and a positive length', () => {
    for (const kind of Object.keys(HAPTIC_EFFECTS) as HapticKind[]) {
      let at = -1
      for (const seg of HAPTIC_EFFECTS[kind]) {
        expect(seg.at).toBeGreaterThanOrEqual(at)
        at = seg.at
        expect(seg.ms).toBeGreaterThan(0)
        for (const m of [seg.strong, seg.weak]) {
          expect(m).toBeGreaterThanOrEqual(0)
          expect(m).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('the crash decays: each segment is no stronger than the last', () => {
    const segs = HAPTIC_EFFECTS.crash
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1]
      const b = segs[i]
      expect(b!.strong).toBeLessThanOrEqual(a!.strong)
    }
  })

  it('a clean gate is a DOUBLE tick and a plain gate is one', () => {
    expect(HAPTIC_EFFECTS.cleanGate).toHaveLength(2)
    expect(HAPTIC_EFFECTS.gate).toHaveLength(1)
  })
})

describe('the scheduler', () => {
  it('plays an effect at once and its later segments when they are due', () => {
    const r = recorder()
    const h = createHaptics(r.sink)
    expect(h.trigger('cleanGate', 1000)).toBe(true)
    expect(r.calls).toHaveLength(1)
    h.update(1040)
    expect(r.calls).toHaveLength(1)
    h.update(1090)
    expect(r.calls).toHaveLength(2)
    h.update(1500)
    expect(r.calls).toHaveLength(2)
    expect(h.active(1500)).toBeNull()
  })

  it('a stronger effect PRE-EMPTS a weaker one', () => {
    const r = recorder()
    const h = createHaptics(r.sink)
    h.trigger('gate', 0)
    expect(h.trigger('crash', 10)).toBe(true)
    expect(h.active(10)).toBe('crash')
    expect(r.calls).toHaveLength(2)
  })

  it('a weaker effect NEVER pre-empts a stronger one that is still running', () => {
    const r = recorder()
    const h = createHaptics(r.sink)
    h.trigger('crash', 0)
    const n = r.calls.length
    expect(h.trigger('gate', 100)).toBe(false)
    expect(h.trigger('cleanGate', 200)).toBe(false)
    expect(h.trigger('nearMiss', 300)).toBe(false)
    expect(h.trigger('hit', 300)).toBe(false)
    expect(r.calls).toHaveLength(n)
    expect(h.active(300)).toBe('crash')
  })

  it('...but once the stronger effect has ended, the weaker one plays', () => {
    const r = recorder()
    const h = createHaptics(r.sink)
    h.trigger('crash', 0)
    const last = HAPTIC_EFFECTS.crash.at(-1)!
    const end = last.at + last.ms
    expect(h.trigger('gate', end + 1)).toBe(true)
    expect(h.active(end + 1)).toBe('gate')
  })

  it('an effect of EQUAL priority replaces the running one (the newest tick)', () => {
    const r = recorder()
    const h = createHaptics(r.sink)
    h.trigger('gate', 0)
    expect(h.trigger('gate', 10)).toBe(true)
    expect(r.calls).toHaveLength(2)
  })

  it('a double tick is not cut by a plain gate arriving inside it', () => {
    const r = recorder()
    const h = createHaptics(r.sink)
    h.trigger('cleanGate', 0)
    expect(h.trigger('gate', 30)).toBe(false)
  })

  it('drops everything when disabled, and stops the actuator', () => {
    const r = recorder()
    const h = createHaptics(r.sink)
    h.setBoost(1)
    h.update(0)
    h.setEnabled(false)
    expect(r.stops).toBe(1)
    expect(h.trigger('crash', 10)).toBe(false)
    h.update(500)
    const n = r.calls.length
    h.update(900)
    expect(r.calls).toHaveLength(n)
    expect(h.active(900)).toBeNull()
  })

  it('a HELD scheduler (a menu is up) drops triggers and stops what runs', () => {
    const r = recorder()
    const h = createHaptics(r.sink)
    h.trigger('crash', 0)
    h.setHeld(true)
    expect(r.stops).toBe(1)
    expect(h.trigger('gate', 10)).toBe(false)
    h.setHeld(false)
    expect(h.trigger('gate', 20)).toBe(true)
  })

  it('starts disabled when asked to', () => {
    const r = recorder()
    const h = createHaptics(r.sink, false)
    expect(h.enabled).toBe(false)
    expect(h.trigger('gate', 0)).toBe(false)
    expect(r.calls).toHaveLength(0)
  })
})

describe('the boost hum', () => {
  it('pulses in short refreshes while on, scaled by level, and stops on 0', () => {
    const r = recorder()
    const h = createHaptics(r.sink)
    h.setBoost(0.5)
    h.update(0)
    expect(r.calls).toHaveLength(1)
    h.update(50)
    expect(r.calls).toHaveLength(1)
    h.update(110)
    expect(r.calls).toHaveLength(2)
    expect(h.active(110)).toBe('boost')
    const half = r.calls[0]!
    h.setBoost(1)
    h.update(300)
    const full = r.calls.at(-1)!
    expect(full.strong).toBeGreaterThan(half.strong)
    expect(full.weak).toBe(0)
    h.setBoost(0)
    const n = r.calls.length
    h.update(600)
    expect(r.calls).toHaveLength(n)
    expect(h.active(600)).toBeNull()
  })

  it('is UNDER every discrete effect: no hum refresh while one runs, and it resumes after', () => {
    const r = recorder()
    const h = createHaptics(r.sink)
    h.setBoost(1)
    h.update(0)
    h.trigger('gate', 20)
    const n = r.calls.length
    h.update(40)
    h.update(55)
    expect(r.calls).toHaveLength(n)
    h.update(200)
    expect(r.calls.length).toBeGreaterThan(n)
    expect(h.active(200)).toBe('boost')
  })

  it('level is clamped and NaN is off', () => {
    const r = recorder()
    const h = createHaptics(r.sink)
    h.setBoost(7)
    h.update(0)
    expect(r.calls[0]!.strong).toBeLessThanOrEqual(1)
    h.setBoost(Number.NaN)
    expect(h.active(0)).toBeNull()
  })
})

describe('the sinks never throw and never leak a rejection', () => {
  const noSession = () => null

  it('prefers dual-rumble on a gamepad and passes the magnitudes', () => {
    const seen: unknown[] = []
    const pad = {
      vibrationActuator: {
        playEffect: (type: string, params: unknown) => {
          seen.push([type, params])
          return Promise.resolve('complete')
        },
      },
    }
    const out = createHapticOutput(() => pad as unknown as Gamepad, noSession)
    out.rumble(0.6, 0.3, 120)
    expect(seen).toEqual([
      ['dual-rumble', { startDelay: 0, duration: 120, weakMagnitude: 0.3, strongMagnitude: 0.6 }],
    ])
  })

  it('falls back to hapticActuators[0].pulse', () => {
    const seen: number[][] = []
    const pad = {
      hapticActuators: [
        {
          pulse(value: number, ms: number) {
            seen.push([value, ms])
            return Promise.resolve(true)
          },
        },
      ],
    }
    const out = createHapticOutput(() => pad as unknown as Gamepad, noSession)
    out.rumble(0.2, 0.9, 50)
    expect(seen).toHaveLength(1)
    expect(seen[0]![1]).toBe(50)
    expect(seen[0]![0]).toBeGreaterThan(0.5)
  })

  it('swallows a rejected promise and a throwing actuator', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    const rejecting = {
      vibrationActuator: { playEffect: () => Promise.reject(new Error('permission')) },
    }
    const throwing = {
      vibrationActuator: {
        playEffect: () => {
          throw new Error('device lost')
        },
      },
    }
    for (const pad of [rejecting, throwing]) {
      const out = createHapticOutput(() => pad as unknown as Gamepad, noSession)
      expect(() => out.rumble(1, 1, 10)).not.toThrow()
      expect(() => out.stop()).not.toThrow()
    }
    await new Promise((r) => setTimeout(r, 20))
    process.off('unhandledRejection', onUnhandled)
    expect(unhandled).toEqual([])
  })

  it('does nothing with no pad and no session', () => {
    const out = createHapticOutput(() => null, noSession)
    expect(() => out.rumble(1, 1, 10)).not.toThrow()
  })

  it('in a session, pulses BOTH controllers and not the flat pad', () => {
    let flat = 0
    const hands: number[] = []
    const mk = (n: number) => ({
      gamepad: {
        vibrationActuator: {
          playEffect: () => {
            hands.push(n)
            return Promise.resolve()
          },
        },
      },
    })
    const session = { inputSources: [mk(0), mk(1), { gamepad: null }] } as unknown as XRSession
    const out = createHapticOutput(
      () => {
        flat++
        return null
      },
      () => session,
    )
    out.rumble(1, 1, 10)
    expect(hands).toEqual([0, 1])
    expect(flat).toBe(0)
  })
})
