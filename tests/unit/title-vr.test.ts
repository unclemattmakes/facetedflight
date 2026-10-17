// tests/unit/title-vr.test.ts: ENTER VR on the title screen. DEV-557; a row
// of the title's plate since DEV-558.
//
// Matt, 2026-10-01: "add an enter VR button to the title screen (or "connect
// vr headset" if it can't find one)". Kinds of claim, each one a thing a
// screenshot would not catch:
//
//   1. The words are his, for the two states he named.
//   2. Where it stands at all: not in a headset, not on a phone with no
//      headset. (Where the ROW hangs is the title's plate, and
//      `title-menu.test.ts` holds it; DEV-557's plate beside the rows went
//      with DEV-558.)
//   3. The state machine: `?xr=off` never asks the platform (it starts SteamVR
//      on this kind of box), a gamepad press without user activation is told
//      what will work instead of failing silently, and a headset plugged in
//      later is found by `devicechange`.

import { describe, expect, it, vi } from 'vitest'
import { createTitleVr, type EnterVrOutcome, MAX_POLLS, type TitleVrDeps } from '@/boot/enter-vr'
import { titleVrShown, titleVrText } from '@/render/title-vr'

describe('the words', () => {
  it('are Matt’s for the two states he named', () => {
    expect(titleVrText('enter').label).toBe('Enter VR')
    expect(titleVrText('connect').label).toBe('Connect VR headset')
  })

  it('tell a gamepad what will work, since a pad cannot start a session', () => {
    expect(titleVrText('needs-key').note).toMatch(/press H, or click/)
  })
})

describe('when it is shown', () => {
  it('not in a headset: you are in VR', () => {
    expect(titleVrShown({ presenting: true, touch: false, state: 'enter' })).toBe(false)
  })

  it('on a desktop either way, so a missing headset is said rather than hidden', () => {
    expect(titleVrShown({ presenting: false, touch: false, state: 'enter' })).toBe(true)
    expect(titleVrShown({ presenting: false, touch: false, state: 'connect' })).toBe(true)
    expect(titleVrShown({ presenting: false, touch: false, state: 'off' })).toBe(true)
  })

  it('not on a phone with no headset; yes on a touch device that has one', () => {
    expect(titleVrShown({ presenting: false, touch: true, state: 'connect' })).toBe(false)
    expect(titleVrShown({ presenting: false, touch: true, state: 'enter' })).toBe(true)
  })
})

/** A platform double: what the probe answers, whether a press has activation, and the session. */
const platform = (o: {
  supported?: boolean
  probe?: boolean
  answer?: boolean
  activation?: boolean
  outcome?: EnterVrOutcome
}) => {
  const calls = { ask: 0, enter: 0 }
  let devicechange: (() => void) | null = null
  const deps: TitleVrDeps = {
    supported: o.supported ?? false,
    probe: o.probe ?? true,
    ask: async () => {
      calls.ask += 1
      return o.answer ?? false
    },
    activation: () => o.activation ?? true,
    enter: async () => {
      calls.enter += 1
      return o.outcome ?? 'entered'
    },
    watchDevices: (f) => {
      devicechange = f
      return () => {
        devicechange = null
      }
    },
  }
  return { deps, calls, fire: () => devicechange?.(), watching: () => devicechange !== null }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('the state machine', () => {
  it('?xr=off never asks the platform: not at boot, not on a press, not on devicechange', async () => {
    const p = platform({ probe: false })
    const vr = createTitleVr(p.deps)
    expect(vr.state).toBe('off')
    vr.press()
    await settle()
    expect(p.calls.ask).toBe(0)
    expect(p.watching()).toBe(false)
    expect(vr.state).toBe('off')
  })

  it('starts from what boot’s probe answered', () => {
    expect(createTitleVr(platform({ supported: true }).deps).state).toBe('enter')
    expect(createTitleVr(platform({ supported: false }).deps).state).toBe('connect')
  })

  it('a press with activation asks for a session, and comes back to enter', async () => {
    const p = platform({ supported: true })
    const vr = createTitleVr(p.deps)
    vr.press()
    expect(vr.state).toBe('starting')
    await settle()
    expect(p.calls.enter).toBe(1)
    expect(vr.state).toBe('enter')
  })

  it('a press WITHOUT activation (a gamepad) asks for nothing and says what will work', async () => {
    const p = platform({ supported: true, activation: false })
    const vr = createTitleVr(p.deps)
    vr.press()
    await settle()
    expect(p.calls.enter).toBe(0)
    expect(vr.state).toBe('needs-key')
    expect(vr.supported).toBe(true)
  })

  it('a refusal is said, and the next press tries again', async () => {
    const p = platform({ supported: true, outcome: 'refused' })
    const vr = createTitleVr(p.deps)
    vr.press()
    await settle()
    expect(vr.state).toBe('refused')
    vr.press()
    await settle()
    expect(p.calls.enter).toBe(2)
  })

  it('CONNECT VR HEADSET asks again on a press, and on devicechange', async () => {
    const p = platform({ supported: false, answer: true })
    const vr = createTitleVr(p.deps)
    vr.press()
    expect(vr.state).toBe('checking')
    await settle()
    expect(p.calls.ask).toBe(1)
    expect(vr.state).toBe('enter')

    const q = platform({ supported: false, answer: true })
    const later = createTitleVr(q.deps)
    q.fire()
    await settle()
    expect(q.calls.ask).toBe(1)
    expect(later.state).toBe('enter')
    later.dispose()
    expect(q.watching()).toBe(false)
  })
})

// DEV-992: a headset that comes up AFTER the page loaded. Matt, 2026-10-14: the
// probe answered false in 4 ms (SteamVR still starting), the page booted flat,
// SteamVR came up, and H did nothing until a reload. Each case below is a way
// that stayed dead: the press only re-lit the row, a hung ask held `checking`
// forever, and nothing asked again unless `devicechange` fired.
describe('a headset that arrives after boot (DEV-992)', () => {
  /** A runtime that says no until `up()`, and whose answer can be held. */
  const runtime = (o: { activation?: boolean } = {}) => {
    let isUp = false
    let hang = false
    const calls = { ask: 0, enter: 0 }
    const deps: TitleVrDeps = {
      supported: false,
      probe: true,
      ask: () => {
        calls.ask += 1
        return hang ? new Promise<boolean>(() => {}) : Promise.resolve(isUp)
      },
      activation: () => o.activation ?? true,
      enter: async () => {
        calls.enter += 1
        return 'entered'
      },
      watchDevices: () => () => {},
      pollMs: 1000,
      askTimeoutMs: 500,
    }
    return {
      deps,
      calls,
      up: () => {
        isUp = true
      },
      hang: (h: boolean) => {
        hang = h
      },
    }
  }

  it('H once the runtime is up asks again and ENTERS, not just lights the row', async () => {
    const r = runtime()
    const vr = createTitleVr(r.deps)
    expect(vr.state).toBe('connect')
    r.up()
    vr.press()
    await settle()
    expect(r.calls.enter).toBe(1)
    vr.dispose()
  })

  it('a press while the runtime is still down stays on connect, and a later press can enter', async () => {
    const r = runtime()
    const vr = createTitleVr(r.deps)
    vr.press()
    await settle()
    expect(vr.state).toBe('connect')
    expect(r.calls.enter).toBe(0)
    r.up()
    vr.press()
    await settle()
    expect(r.calls.enter).toBe(1)
    vr.dispose()
  })

  it('a gamepad press (no activation) asks, lights the row, and does not try to enter', async () => {
    const r = runtime({ activation: false })
    const vr = createTitleVr(r.deps)
    r.up()
    vr.press()
    await settle()
    expect(r.calls.enter).toBe(0)
    expect(vr.state).toBe('enter')
    vr.dispose()
  })

  it('an ask that never answers is given up on, so the next press asks afresh', async () => {
    vi.useFakeTimers()
    try {
      const r = runtime()
      r.hang(true)
      const vr = createTitleVr(r.deps)
      vr.press()
      expect(vr.state).toBe('checking')
      await vi.advanceTimersByTimeAsync(600)
      expect(vr.state).toBe('connect')
      r.hang(false)
      r.up()
      vr.press()
      await vi.advanceTimersByTimeAsync(0)
      expect(r.calls.ask).toBe(2)
      expect(r.calls.enter).toBe(1)
      vr.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('with no devicechange and no press, a poll finds the headset and lights the row', async () => {
    vi.useFakeTimers()
    try {
      const r = runtime()
      const vr = createTitleVr(r.deps)
      await vi.advanceTimersByTimeAsync(1100)
      expect(vr.state).toBe('connect')
      expect(r.calls.ask).toBe(1)
      r.up()
      await vi.advanceTimersByTimeAsync(1000)
      expect(vr.state).toBe('enter')
      expect(r.calls.enter).toBe(0)
      vr.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the poll is bounded, so a closed SteamVR is not relaunched for ever', async () => {
    vi.useFakeTimers()
    try {
      const r = runtime()
      const vr = createTitleVr(r.deps)
      await vi.advanceTimersByTimeAsync((MAX_POLLS + 20) * 1000)
      expect(r.calls.ask).toBe(MAX_POLLS)
      vr.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('?xr=off never polls', async () => {
    vi.useFakeTimers()
    try {
      const r = runtime()
      const vr = createTitleVr({ ...r.deps, probe: false })
      await vi.advanceTimersByTimeAsync(60 * 1000)
      expect(r.calls.ask).toBe(0)
      vr.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
