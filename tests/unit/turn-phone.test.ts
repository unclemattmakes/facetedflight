// tests/unit/turn-phone.test.ts: a phone plays sideways. DEV-566.
//
// The rule (`input/turn-phone.ts`) is a phone held upright gets TURN YOUR
// PHONE; a tablet, a desktop and a phone held sideways get nothing. The DOM
// half (the screen standing over the glass, keys stopped, the pause) is
// `tests/e2e/mobile-controls.spec.ts`'s, on an emulated Pixel 7; this file
// owns the arithmetic and the two switches the frame loop throws.

import { describe, expect, it } from 'vitest'
import { nextPaused, type PauseSignals } from '@/input/escape-pause'
import { firstStandardPad, gamepadConfirm, setPadsHeld } from '@/input/gamepad'
import {
  askLandscapeLock,
  attachTurnScreen,
  FULLSCREEN_TRIES,
  HOME_HINT_STORAGE_KEY,
  isPhone,
  offersFullscreen,
  PHONE_SHORT_SIDE_PX,
  runsStandalone,
  TURN_HOME_SCREEN_NOTE,
  TURN_NOTE,
  TURN_PAUSED_NOTE,
  TURN_TITLE,
  type TurnInputs,
  wantsTurnScreen,
} from '@/input/turn-phone'

/** A device, held one way: screen and viewport in css px, as the browser reports them. */
const held = (
  screen: readonly [number, number],
  view: readonly [number, number],
  touch = true,
): TurnInputs => ({
  touch,
  screenWidth: screen[0],
  screenHeight: screen[1],
  viewWidth: view[0],
  viewHeight: view[1],
})

describe('which devices are asked to turn', () => {
  it('a Pixel 7 held upright, and not held sideways', () => {
    // Playwright's Pixel 7: 412 x 915, the screen the size of the viewport.
    expect(wantsTurnScreen(held([412, 915], [412, 915]))).toBe(true)
    expect(wantsTurnScreen(held([915, 412], [915, 412]))).toBe(false)
  })

  it('reads the SCREEN for phone-ness, so browser chrome eating the viewport changes nothing', () => {
    // Android Chrome in landscape: the toolbar takes 50-odd px of a 412 tall screen.
    expect(wantsTurnScreen(held([915, 412], [915, 360]))).toBe(false)
    // iOS reports screen.width/height in PORTRAIT whichever way the phone is held.
    expect(wantsTurnScreen(held([390, 844], [844, 340]))).toBe(false)
    expect(wantsTurnScreen(held([390, 844], [390, 664]))).toBe(true)
  })

  it('leaves a tablet alone, upright or not, and in split view', () => {
    // The smallest iPad (mini, 744 x 1133), an iPad Air, a 600 dp Android tablet.
    expect(wantsTurnScreen(held([744, 1133], [744, 1133]))).toBe(false)
    expect(wantsTurnScreen(held([820, 1180], [820, 1180]))).toBe(false)
    expect(wantsTurnScreen(held([600, 960], [600, 960]))).toBe(false)
    // Split view makes the WINDOW phone-narrow; the screen is still a tablet's.
    expect(wantsTurnScreen(held([1180, 820], [390, 820]))).toBe(false)
  })

  it('leaves a desktop alone, even a narrow window, even with ?touch=1', () => {
    // Not touch mode: never, whatever the shape.
    expect(wantsTurnScreen(held([412, 915], [412, 915], false))).toBe(false)
    // `?touch=1` on a monitor: touch mode, but a 1080 p screen is no phone.
    expect(wantsTurnScreen(held([1920, 1080], [500, 900]))).toBe(false)
  })

  it('draws the phone/tablet line at the short side, strictly under 600', () => {
    expect(PHONE_SHORT_SIDE_PX).toBe(600)
    expect(isPhone({ touch: true, screenWidth: 599, screenHeight: 900 })).toBe(true)
    expect(isPhone({ touch: true, screenWidth: 600, screenHeight: 900 })).toBe(false)
    // A folding phone, folded and open (Galaxy Z Fold: about 344 and 673 across).
    expect(isPhone({ touch: true, screenWidth: 344, screenHeight: 882 })).toBe(true)
    expect(isPhone({ touch: true, screenWidth: 673, screenHeight: 841 })).toBe(false)
  })

  it('counts a square viewport as upright, as CSS (orientation: portrait) does', () => {
    expect(wantsTurnScreen(held([412, 915], [412, 412]))).toBe(true)
    // A window not laid out yet is not a reason to cover the game.
    expect(wantsTurnScreen(held([412, 915], [0, 0]))).toBe(false)
  })
})

describe('the words', () => {
  it('are short, plain, and carry no em-dash (CLAUDE.md rule 11)', () => {
    const dash = String.fromCharCode(0x2014)
    for (const words of [TURN_TITLE, TURN_NOTE, TURN_PAUSED_NOTE]) {
      expect(words).not.toContain(dash)
      expect(words.length).toBeLessThanOrEqual(32)
    }
    // The title is in the pause plate's capitals.
    expect(TURN_TITLE).toBe(TURN_TITLE.toUpperCase())
  })
})

describe('the pause: held, not toggled', () => {
  const NONE: PauseSignals = { toggle: false, escape: false, lostCapture: false }

  it('pauses a running flight on any frame the screen stands', () => {
    expect(nextPaused(false, { ...NONE, held: true })).toBe(true)
  })

  it('cannot be toggled off from behind the screen, by any control', () => {
    expect(nextPaused(true, { ...NONE, held: true, toggle: true })).toBe(true)
    expect(nextPaused(true, { ...NONE, held: true, escape: true })).toBe(true)
    // Nor does the lookdev exemption reach it: that is about Escape alone.
    expect(nextPaused(true, { ...NONE, held: true, toggle: true, escapeFreesOnly: true })).toBe(
      true,
    )
  })

  it('stays paused once the screen goes, until the player resumes', () => {
    // The frame the phone comes round: held is false, nothing pressed.
    expect(nextPaused(true, { ...NONE, held: false })).toBe(true)
    // And RESUME (the pause control) is what lets it go.
    expect(nextPaused(true, { ...NONE, toggle: true })).toBe(false)
  })
})

describe('the pads, held off behind the screen', () => {
  /** A fake `navigator.getGamepads` with A held. Same shape as `control-scheme.test.ts`'s. */
  const withPadPressingA = <T>(fn: () => T): T => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        getGamepads: () => [
          {
            connected: true,
            mapping: 'standard',
            axes: [0, 0, 0, 0],
            buttons: Array.from({ length: 17 }, (_, i) => ({
              value: i === 0 ? 1 : 0,
              pressed: i === 0,
            })),
          },
        ],
      },
      configurable: true,
      writable: true,
    })
    try {
      return fn()
    } finally {
      if (previous) Object.defineProperty(globalThis, 'navigator', previous)
      else Reflect.deleteProperty(globalThis, 'navigator')
    }
  }

  it('reads as unplugged while held, and comes back when let go', () => {
    withPadPressingA(() => {
      expect(gamepadConfirm()).toBe(true)
      setPadsHeld(true)
      try {
        expect(firstStandardPad()).toBeNull()
        expect(gamepadConfirm()).toBe(false)
      } finally {
        setPadsHeld(false)
      }
      expect(gamepadConfirm()).toBe(true)
    })
  })
})

describe('the orientation lock: asked, never relied on', () => {
  it('says so where there is no lock to ask (iOS Safari)', async () => {
    expect(await askLandscapeLock(undefined)).toBe('not offered')
    expect(await askLandscapeLock({})).toBe('not offered')
  })

  it('catches a refusal (Android Chrome outside fullscreen) rather than throwing', async () => {
    const refusing = {
      lock: () =>
        Promise.reject(Object.assign(new Error('not fullscreen'), { name: 'NotSupportedError' })),
    }
    expect(await askLandscapeLock(refusing)).toBe('refused (NotSupportedError)')
  })

  it('asks for landscape, and reports a grant', async () => {
    const asked: string[] = []
    const granting = {
      lock: (o: 'landscape') => {
        asked.push(o)
        return Promise.resolve()
      },
    }
    expect(await askLandscapeLock(granting)).toBe('granted')
    expect(asked).toEqual(['landscape'])
  })
})

// Matt, 2026-10-02 (*"sure"*): a phone's first press also asks for fullscreen,
// the one state in which Android Chrome grants the lock. A plain stand-in
// document: just enough element for the mount, and a fullscreen that records.
const stubElement = (): Record<string, unknown> => {
  const el: Record<string, unknown> = {
    hidden: false,
    dataset: {},
    style: {},
    append: () => {},
    appendChild: () => {},
    setAttribute: () => {},
    addEventListener: () => {},
    remove: () => {},
  }
  return el
}
const mount = (opts: {
  screen: [number, number]
  fullscreen: 'grant' | 'refuse' | 'absent'
  /** `navigator.userActivation`; absent (a browser without it) when not given. */
  activation?: { isActive: boolean }
  /** iOS's `navigator.standalone`: launched from the home screen. */
  standalone?: boolean
  /** The viewport, when it is not the screen held sideways. */
  view?: [number, number]
  /** `localStorage`; a Map shared between mounts is one phone across page loads. */
  storage?: Map<string, string> | 'throws'
}) => {
  const calls = { fullscreen: 0, lock: 0 }
  const listeners = new Map<string, (e: Event) => void>()
  const made: Array<Record<string, unknown>> = []
  const docListeners = new Map<string, () => void>()
  const doc = {
    fullscreenElement: null as unknown,
    body: stubElement(),
    head: stubElement(),
    getElementById: () => null,
    createElement: () => {
      const el = stubElement()
      made.push(el)
      return el
    },
    addEventListener: (t: string, fn: () => void) => docListeners.set(t, fn),
    removeEventListener: () => {},
    documentElement: {
      ...(opts.fullscreen === 'absent'
        ? {}
        : {
            requestFullscreen: () => {
              calls.fullscreen += 1
              if (opts.fullscreen === 'refuse') {
                return Promise.reject(Object.assign(new Error('no'), { name: 'TypeError' }))
              }
              doc.fullscreenElement = doc.documentElement
              docListeners.get('fullscreenchange')?.()
              return Promise.resolve()
            },
          }),
    },
  }
  const storage = opts.storage
  const win = {
    innerWidth: opts.view?.[0] ?? opts.screen[1],
    innerHeight: opts.view?.[1] ?? opts.screen[0],
    localStorage:
      storage === 'throws'
        ? {
            getItem: () => {
              throw new Error('SecurityError')
            },
            setItem: () => {
              throw new Error('SecurityError')
            },
          }
        : storage
          ? {
              getItem: (k: string) => storage.get(k) ?? null,
              setItem: (k: string, v: string) => void storage.set(k, v),
            }
          : null,
    screen: {
      width: opts.screen[1],
      height: opts.screen[0],
      orientation: {
        lock: () => {
          calls.lock += 1
          return Promise.resolve()
        },
      },
    },
    navigator: {
      ...(opts.activation ? { userActivation: opts.activation } : {}),
      ...(opts.standalone !== undefined ? { standalone: opts.standalone } : {}),
    },
    addEventListener: (t: string, fn: (e: Event) => void) => listeners.set(t, fn),
    removeEventListener: () => {},
  }
  attachTurnScreen(doc as unknown as Document, win, { enabled: true })
  const press = (type: 'pointerup' | 'touchend' = 'pointerup') => listeners.get(type)?.({} as Event)
  /** The player leaves fullscreen (Android's back gesture). */
  const leave = () => {
    doc.fullscreenElement = null
    docListeners.get('fullscreenchange')?.()
  }
  /** The home-screen line, found by its class. */
  const homeLine = () => made.find((el) => el.className === 'home')
  return { calls, press, leave, homeLine }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('a phone’s first press: fullscreen, then the lock', () => {
  it('asks a phone for fullscreen once, and the lock follows the fullscreen', async () => {
    const { calls, press } = mount({ screen: [412, 915], fullscreen: 'grant' })
    press()
    press()
    await settle()
    expect(calls.fullscreen).toBe(1)
    expect(calls.lock).toBe(1)
  })

  it('still asks the lock where fullscreen is refused or absent (an iPhone)', async () => {
    for (const fullscreen of ['refuse', 'absent'] as const) {
      const { calls, press } = mount({ screen: [412, 915], fullscreen })
      press()
      await settle()
      expect(calls.lock, fullscreen).toBe(1)
    }
  })

  it('never asks a tablet for fullscreen', async () => {
    const { calls, press } = mount({ screen: [800, 1280], fullscreen: 'grant' })
    press()
    await settle()
    expect(calls.fullscreen).toBe(0)
    expect(calls.lock).toBe(0)
  })
})

// DEV-595, Matt on his phone: *"doesn't go into full screen"*.
describe('a phone that did not go fullscreen (DEV-595)', () => {
  it('a touchend asks too: a touch the browser took for a pan never sends pointerup', async () => {
    const { calls, press } = mount({ screen: [412, 915], fullscreen: 'grant' })
    press('touchend')
    // The pointerup of the same tap, arriving behind it, asks nothing more.
    press('pointerup')
    await settle()
    expect(calls.fullscreen).toBe(1)
    expect(calls.lock).toBe(1)
  })

  it('a press that is not a user activation is not spent', async () => {
    const activation = { isActive: false }
    const { calls, press } = mount({ screen: [412, 915], fullscreen: 'grant', activation })
    press()
    await settle()
    expect(calls.fullscreen, 'refused before it was asked: nothing asked').toBe(0)
    activation.isActive = true
    press()
    await settle()
    expect(calls.fullscreen).toBe(1)
  })

  it('a refusal is not the last word, up to FULLSCREEN_TRIES presses', async () => {
    const { calls, press } = mount({ screen: [412, 915], fullscreen: 'refuse' })
    for (let i = 0; i < FULLSCREEN_TRIES + 2; i++) {
      press()
      await settle()
    }
    expect(FULLSCREEN_TRIES).toBe(3)
    expect(calls.fullscreen).toBe(FULLSCREEN_TRIES)
    // The lock is asked once, on the first refusal, not on every one.
    expect(calls.lock).toBe(1)
  })

  it('a player who leaves fullscreen is not pulled back in by the next tap', async () => {
    const { calls, press, leave } = mount({ screen: [412, 915], fullscreen: 'grant' })
    press()
    await settle()
    leave()
    press()
    await settle()
    expect(calls.fullscreen).toBe(1)
  })
})

describe('an iPhone is told its route to full screen (DEV-595)', () => {
  it('shows the home-screen line on a phone with no element fullscreen', () => {
    const { homeLine } = mount({ screen: [390, 844], fullscreen: 'absent' })
    expect(homeLine()?.textContent).toBe(TURN_HOME_SCREEN_NOTE)
    expect(homeLine()?.hidden).toBe(false)
  })

  it('not where fullscreen exists (Android), nor once launched from the home screen', () => {
    expect(mount({ screen: [412, 915], fullscreen: 'grant' }).homeLine()?.hidden).toBe(true)
    expect(
      mount({ screen: [390, 844], fullscreen: 'absent', standalone: true }).homeLine()?.hidden,
    ).toBe(true)
  })

  it('shows on ONE page load and never again on that phone: a hint, not a nag', () => {
    const phone = new Map<string, string>()
    const upright = { screen: [390, 844] as [number, number], view: [390, 664] as [number, number] }
    const first = mount({ ...upright, fullscreen: 'absent', storage: phone })
    expect(first.homeLine()?.hidden).toBe(false)
    expect(phone.get(HOME_HINT_STORAGE_KEY)).toBe('1')
    const second = mount({ ...upright, fullscreen: 'absent', storage: phone })
    expect(second.homeLine()?.hidden).toBe(true)
  })

  it('is remembered only once it has stood in front of the player', () => {
    const phone = new Map<string, string>()
    // Booted sideways: the turn screen is down, so the line was never seen.
    mount({ screen: [390, 844], view: [750, 342], fullscreen: 'absent', storage: phone })
    expect(phone.has(HOME_HINT_STORAGE_KEY)).toBe(false)
  })

  it('storage that refuses: the line still shows, and nothing throws', () => {
    const m = mount({
      screen: [390, 844],
      view: [390, 664],
      fullscreen: 'absent',
      storage: 'throws',
    })
    expect(m.homeLine()?.hidden).toBe(false)
  })

  it('not on a tablet, which keeps portrait and never sees the turn screen', () => {
    expect(mount({ screen: [820, 1180], fullscreen: 'absent' }).homeLine()?.hidden).toBe(true)
  })

  it('reads fullscreen and standalone off the platform, not a user agent', () => {
    expect(offersFullscreen({ documentElement: {} } as unknown as Document)).toBe(false)
    expect(
      offersFullscreen({
        documentElement: { requestFullscreen: () => Promise.resolve() },
      } as unknown as Document),
    ).toBe(true)
    expect(runsStandalone({ navigator: { standalone: true } })).toBe(true)
    expect(runsStandalone({ matchMedia: (q) => ({ matches: q.includes('standalone') }) })).toBe(
      true,
    )
    expect(runsStandalone({ matchMedia: () => ({ matches: false }) })).toBe(false)
    expect(runsStandalone(null)).toBe(false)
  })

  it('is one plain line with no em-dash (CLAUDE.md rule 11)', () => {
    expect(TURN_HOME_SCREEN_NOTE).not.toContain(String.fromCharCode(0x2014))
    expect(TURN_HOME_SCREEN_NOTE.length).toBeLessThanOrEqual(56)
  })
})
