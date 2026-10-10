// tests/unit/touch-overlay.test.ts — the state machine behind the glass.
//
// `touch-input.test.ts` owns the mapping and `mobile-controls.spec.ts` owns the
// browser. This is the bit between them: which finger is holding which stick,
// when a tap is seen, and what happens to a control that is taken away while a
// thumb is still on it. All of that is plain state, and none of it needs a GPU
// or a phone — which matters, because **CI runs `pnpm check` and does not run
// Playwright at all**. A bug in here would otherwise reach `main` unopposed.
//
// ── The DOM is faked, and `look.test.ts` is the precedent ────────────────
//
// `vitest.config.ts` is `environment: 'node'` and says a test needing a DOM
// belongs in Playwright. That rule is about the RENDER layer; the input layer
// has always had a foot in the document, and `look.test.ts` fakes exactly the
// three methods `attachMouseLook` touches rather than pulling in jsdom for
// them. This is the same trade, one file along and a few methods wider.
//
// What the fake deliberately does NOT model is event bubbling — and it does not
// need to. The buttons are SIBLINGS of the drag surface, not children of it, so
// a press on a chip never reaches the surface's handlers in a real browser
// either. (The `stopPropagation` in `touch-overlay.ts` is belt and braces for
// the day that topology changes.)

import { beforeEach, describe, expect, it } from 'vitest'
import { STICK_RADIUS_PX } from '@/input/touch'
import {
  attachTouchControls,
  IDLE_CONTEXT,
  RACE_LAP_LABEL,
  TOUCH_BUTTON_IDS,
  type TouchContext,
  type TouchControls,
} from '@/input/touch-overlay'
import { appSource } from './helpers/app-source'

const OPTS = { invertPitch: false }
const LOOK = { invertPitch: false, flightIdle: true }

const FLYING: TouchContext = { ...IDLE_CONTEXT, flying: true, confirmLabel: 'LAUNCH' }
const MENU: TouchContext = { ...IDLE_CONTEXT, lookMode: true, confirmLabel: 'SELECT' }

/** Past the gate, so a stick saturates. */
const REACH = STICK_RADIUS_PX * 2

let dom: FakeDom

beforeEach(() => {
  dom = fakeDom()
})

/** Attach, show, and put it in a context. The three things every test below needs. */
const mounted = (ctx: TouchContext = FLYING): TouchControls => {
  const controls = attachTouchControls(dom.canvas, { enabled: true })
  controls.setVisible(true)
  controls.setContext(ctx)
  return controls
}

describe('nothing is built where nothing is wanted', () => {
  it('returns a stand-in on a device with no touchscreen', () => {
    const controls = attachTouchControls(dom.canvas, { enabled: false })
    expect(controls.available).toBe(false)
    // Not "hidden" — ABSENT. A full-screen `pointer-events: auto` surface over
    // a desktop's canvas would swallow the click that requests pointer lock,
    // which IS the desktop look control.
    expect(dom.created()).toBe(0)
    controls.setVisible(true)
    expect(dom.created()).toBe(0)
  })

  it('returns a stand-in in a host with no document at all', () => {
    expect(attachTouchControls(null, { enabled: true }).available).toBe(false)
  })

  it('stays down until the landing card is dismissed', () => {
    const controls = attachTouchControls(dom.canvas, { enabled: true })
    controls.setContext(FLYING)
    expect(dom.root().hidden).toBe(true)
    controls.setVisible(true)
    expect(dom.root().hidden).toBe(false)
  })
})

describe('a tap is seen even when it is faster than a frame', () => {
  it('latches, so a press and a release between two frames still counts', () => {
    const controls = mounted()
    // Down and up with no `read()` in between — a real tap is 40–90 ms and a
    // frame is 11 ms at 90 Hz, but a backgrounded tab or a long frame makes
    // this ordinary rather than exotic.
    dom.press('auto')
    dom.release('auto')
    controls.read(OPTS)
    expect(controls.toggleAutopilot).toBe(true)
  })

  it('spends the latch, so one tap is one toggle and not two', () => {
    const controls = mounted()
    dom.press('auto')
    dom.release('auto')
    controls.read(OPTS)
    expect(controls.toggleAutopilot).toBe(true)
    // `app.ts` edge-detects against the previous frame. A latch that survived
    // would strobe the autopilot on and off at the frame rate.
    controls.read(OPTS)
    expect(controls.toggleAutopilot).toBe(false)
  })

  it('reports a held button for as long as it is held', () => {
    const controls = mounted()
    dom.press('confirm')
    controls.read(OPTS)
    expect(controls.confirm).toBe(true)
    controls.read(OPTS)
    expect(controls.confirm).toBe(true)
    dom.release('confirm')
    controls.read(OPTS)
    expect(controls.confirm).toBe(false)
  })

  it('reads the chips only when `read()` has been called, which is the frame boundary', () => {
    const controls = mounted()
    dom.press('pause')
    // No `read()` yet: the getters report the PREVIOUS frame, which is what
    // makes them a consistent snapshot rather than a live wire into the DOM.
    expect(controls.pause).toBe(false)
    controls.read(OPTS)
    expect(controls.pause).toBe(true)
  })
})

describe('two thumbs, two sticks', () => {
  it('flies with the left thumb and rolls with the right', () => {
    const controls = mounted()
    dom.down(1, 100, 300)
    dom.move(1, 100, 300 - REACH)
    dom.down(2, 800, 300)
    dom.move(2, 800 + REACH, 300)
    const actions = controls.read(OPTS)
    expect(actions.pitch).toBeCloseTo(1, 6)
    expect(actions.roll).toBeCloseTo(-1, 6)
  })

  it('will not let a second finger steal a stick the first is holding', () => {
    // The ship would jump to wherever the new finger landed, which reads as the
    // controls letting go — and a palm resting on the glass is a second finger.
    const controls = mounted()
    dom.down(1, 100, 300)
    dom.move(1, 100, 300 - REACH)
    expect(controls.read(OPTS).pitch).toBeCloseTo(1, 6)

    dom.down(2, 200, 300)
    dom.move(2, 200, 300 + REACH)
    // Still the FIRST finger's stick, untouched.
    expect(controls.read(OPTS).pitch).toBeCloseTo(1, 6)
  })

  it('centres a stick the moment its thumb lifts', () => {
    const controls = mounted()
    dom.down(1, 100, 300)
    dom.move(1, 100, 300 - REACH)
    expect(controls.read(OPTS).pitch).toBeCloseTo(1, 6)
    dom.up(1, 100, 300 - REACH)
    // `toBeCloseTo`, not `toBe`: a centred stick reads `-0` here, exactly as it
    // does on the pad — `-0` is what `-(0)` is, and both readers negate their
    // pitch axis. `touch-input.test.ts` pins that the two agree ON the negative
    // zero, so nobody "fixes" one device and leaves the other.
    expect(controls.read(OPTS).pitch).toBeCloseTo(0, 10)
  })

  it('gives the stick back after a lift, rather than staying dead', () => {
    const controls = mounted()
    dom.down(1, 100, 300)
    dom.up(1, 100, 300)
    dom.down(3, 150, 320)
    dom.move(3, 150, 320 - REACH)
    expect(controls.read(OPTS).pitch).toBeCloseTo(1, 6)
  })

  it('ignores the glass entirely when there is no ship', () => {
    const controls = mounted(IDLE_CONTEXT)
    dom.down(1, 100, 300)
    dom.move(1, 100, 300 - REACH)
    const actions = controls.read(OPTS)
    expect(actions.pitch).toBeCloseTo(0, 10)
    expect(actions.throttle).toBe(0)
  })
})

describe('in the menu a drag looks instead', () => {
  it('turns the view and leaves the sticks centred', () => {
    const controls = mounted(MENU)
    dom.down(1, 400, 200)
    dom.move(1, 480, 200)
    const look = controls.readLook(LOOK)
    // Drag right -> look RIGHT -> yaw DECREASES (`look.ts`'s convention).
    expect(look.yaw).toBeLessThan(0)
    expect(controls.read(OPTS).yaw).toBe(0)
  })

  it('is CONSUMING — a flick is applied once, not every frame after it', () => {
    const controls = mounted(MENU)
    dom.down(1, 400, 200)
    dom.move(1, 480, 200)
    expect(controls.readLook(LOOK).yaw).toBeLessThan(0)
    expect(controls.readLook(LOOK)).toEqual({ yaw: 0, pitch: 0 })
  })

  it('does not replay the last drag once you are back in a cockpit', () => {
    // The pixels are consumed even when the gate refuses the gesture. A reader
    // that kept them would hand the ship a look-sized flick on the first frame
    // of the run.
    const controls = mounted(MENU)
    dom.down(1, 400, 200)
    dom.move(1, 480, 260)
    expect(controls.readLook({ ...LOOK, flightIdle: false })).toEqual({ yaw: 0, pitch: 0 })
    controls.setContext(FLYING)
    expect(controls.readLook(LOOK)).toEqual({ yaw: 0, pitch: 0 })
  })
})

describe('a control that is taken away is a control nobody is holding', () => {
  it('drops every stick and chip when a session starts', () => {
    const controls = mounted()
    dom.down(1, 100, 300)
    dom.move(1, 100, 300 - REACH)
    dom.press('boost')
    controls.read(OPTS)

    // Into the headset. Nothing here belongs in one, and a stick left deflected
    // would fly the ship from a control nobody can see.
    controls.setContext({ ...FLYING, hidden: true })
    const actions = controls.read(OPTS)
    expect(actions.pitch).toBe(0)
    expect(actions.boost).toBe(false)
    expect(dom.root().hidden).toBe(true)
  })

  it('does not deliver a tap from a button that has been taken away', () => {
    // The nastiest ordering this file has: a finger lands on AUTO on the exact
    // frame an immersive session starts. The latch is armed, the overlay goes
    // down, and one frame later the game would receive a press from a button
    // that is no longer on screen.
    const controls = mounted()
    dom.press('auto')
    dom.release('auto')
    controls.setContext({ ...FLYING, hidden: true })
    controls.read(OPTS)
    expect(controls.toggleAutopilot).toBe(false)
  })

  it('drops a held shoulder when the run ends', () => {
    const controls = mounted()
    dom.press('brake')
    expect(controls.read(OPTS).brake).toBe(true)
    // Back to the hangar with a thumb still down.
    controls.setContext(MENU)
    expect(controls.read(OPTS).brake).toBe(false)
  })

  it('takes the flight chips away when there is nothing to fly', () => {
    const controls = mounted()
    for (const act of ['brake', 'boost', 'auto', 'pause'] as const) {
      expect(dom.button(act).hidden).toBe(false)
    }
    controls.setContext(MENU)
    for (const act of ['brake', 'boost', 'auto', 'pause'] as const) {
      expect(dom.button(act).hidden).toBe(true)
    }
    // The one button a menu needs stays, with the menu's word on it.
    expect(dom.button('confirm').hidden).toBe(false)
    expect(dom.button('confirm').textContent).toBe('SELECT')
  })

  it('hides the confirm button when a press would do nothing', () => {
    const controls = mounted()
    expect(dom.button('confirm').hidden).toBe(false)
    controls.setContext({ ...FLYING, confirmLabel: null })
    expect(dom.button('confirm').hidden).toBe(true)
  })

  it('lights AUTO from the game’s own flag, not from the tap', () => {
    // The chip is a READOUT. If it lit itself on press it would say "on" while
    // the autopilot was refusing to engage, which is the one thing a status
    // light must never do.
    const controls = mounted()
    expect(dom.button('auto').dataset.on).toBeUndefined()
    dom.press('auto')
    controls.read(OPTS)
    expect(dom.button('auto').dataset.on).toBeUndefined()
    controls.setContext({ ...FLYING, autopilot: true })
    expect(dom.button('auto').dataset.on).toBe('1')
  })

  it('takes itself out of the document on dispose', () => {
    const controls = mounted()
    expect(dom.root().removed).toBe(false)
    controls.dispose()
    expect(dom.root().removed).toBe(true)
  })
})

describe('the CAM chip — CHANGE VIEW on a phone (DEV-128)', () => {
  it('is a flight chip: on with the sticks, gone in the menu', () => {
    const controls = mounted()
    expect(dom.button('cam').hidden).toBe(false)
    expect(dom.button('cam').textContent).toBe('CAM')
    controls.setContext(MENU)
    expect(dom.button('cam').hidden).toBe(true)
  })

  it('reports a tap once, at the frame boundary, and flies nothing', () => {
    const controls = mounted()
    dom.press('cam')
    dom.release('cam')
    // Not until `read()` — the frame boundary the header describes.
    expect(controls.toggleCamera).toBe(false)
    const actions = controls.read(OPTS)
    expect(controls.toggleCamera).toBe(true)
    expect(actions.boost).toBe(false)
    expect(actions.brake).toBe(false)
    expect(actions.throttle).toBe(0)
    // Spent: the next frame does not see the same tap again.
    controls.read(OPTS)
    expect(controls.toggleCamera).toBe(false)
  })

  it('lights from the game’s own flag, like AUTO — a readout, not a latch', () => {
    const controls = mounted()
    expect(dom.button('cam').dataset.on).toBeUndefined()
    dom.press('cam')
    controls.read(OPTS)
    expect(dom.button('cam').dataset.on).toBeUndefined()
    controls.setContext({ ...FLYING, thirdPerson: true })
    expect(dom.button('cam').dataset.on).toBe('1')
    controls.setContext({ ...FLYING, thirdPerson: false })
    expect(dom.button('cam').dataset.on).toBeUndefined()
  })
})

// ── the fake ──────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string
  id: string
  className: string
  type: string
  hidden: boolean
  textContent: string
  removed: boolean
  clientWidth: number
  readonly dataset: Record<string, string | undefined>
  readonly style: Record<string, string>
  readonly children: FakeElement[]
  firstElementChild: FakeElement | null
  appendChild(child: FakeElement): FakeElement
  remove(): void
  setPointerCapture(id: number): void
  addEventListener(type: string, fn: (e: unknown) => void): void
  removeEventListener(type: string, fn: (e: unknown) => void): void
  fire(type: string, event: Record<string, unknown>): void
}

interface FakeDom {
  /** Cast, as `look.test.ts` casts its fake canvas: the real type is a lie the fake tells. */
  readonly canvas: HTMLElement
  created(): number
  root(): FakeElement
  button(act: string): FakeElement
  surface(): FakeElement
  /** A finger down / moved / lifted on the drag surface. */
  down(pointerId: number, x: number, y: number): void
  move(pointerId: number, x: number, y: number): void
  up(pointerId: number, x: number, y: number): void
  /** A finger down / lifted on one of the chips. */
  press(act: string): void
  release(act: string): void
}

function fakeDom(): FakeDom {
  const all: FakeElement[] = []

  const element = (tagName: string): FakeElement => {
    const listeners = new Map<string, Set<(e: unknown) => void>>()
    const self: FakeElement = {
      tagName,
      id: '',
      className: '',
      type: '',
      hidden: false,
      textContent: '',
      removed: false,
      clientWidth: 900,
      dataset: {},
      style: {},
      children: [],
      firstElementChild: null,
      appendChild(child) {
        self.children.push(child)
        if (!self.firstElementChild) self.firstElementChild = child
        return child
      },
      remove() {
        self.removed = true
      },
      setPointerCapture() {},
      addEventListener(type, fn) {
        const set = listeners.get(type) ?? new Set()
        set.add(fn)
        listeners.set(type, set)
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn)
      },
      fire(type, event) {
        for (const fn of listeners.get(type) ?? []) fn(event)
      },
    }
    all.push(self)
    return self
  }

  const head = element('head')
  const body = element('body')
  const doc = {
    head,
    body,
    documentElement: { clientWidth: 900 },
    createElement: (tag: string) => element(tag),
    getElementById: (id: string) => all.find((e) => e.id === id) ?? null,
  }
  const canvas = { ownerDocument: doc }

  const root = (): FakeElement => {
    const found = all.find((e) => e.id === 'touch-controls')
    if (!found) throw new Error('fakeDom: no #touch-controls — was it attached?')
    return found
  }
  /**
   * A chip by its action, from ANYWHERE under the root.
   *
   * It used to search `root().children` — one level, flat — which was a true
   * description of the overlay right up to DEV-290, when the top row became a
   * flex container and five of the seven buttons moved one level down. Twelve
   * tests in this file then failed with *"no chip [data-act=auto]"*, none of
   * which is about nesting and all of which are about what a chip DOES.
   *
   * So the fake does what `querySelector` does. The depth of the DOM is a
   * layout decision, and a test that pins one is a test that fails the next
   * time somebody wraps something — which is a question for a spec that looks
   * at pixels, not for this one.
   */
  const find = (node: FakeElement, match: (e: FakeElement) => boolean): FakeElement | null => {
    for (const child of node.children) {
      if (match(child)) return child
      const deeper = find(child, match)
      if (deeper) return deeper
    }
    return null
  }
  const button = (act: string): FakeElement => {
    const found = find(root(), (e) => e.dataset.act === act)
    if (!found) throw new Error(`fakeDom: no chip [data-act="${act}"]`)
    return found
  }
  const surface = (): FakeElement => {
    const found = root().children.find((e) => e.className === 'surface')
    if (!found) throw new Error('fakeDom: no drag surface')
    return found
  }

  const pointer = (pointerId: number, x: number, y: number) => ({
    pointerId,
    clientX: x,
    clientY: y,
    preventDefault() {},
    stopPropagation() {},
  })

  return {
    canvas: canvas as unknown as HTMLElement,
    // Only what `attachTouchControls` built: the fake's own head and body do
    // not count, or "nothing was created" could never be asserted.
    created: () => all.length - 2,
    root,
    button,
    surface,
    down: (id, x, y) => surface().fire('pointerdown', pointer(id, x, y)),
    move: (id, x, y) => surface().fire('pointermove', pointer(id, x, y)),
    up: (id, x, y) => surface().fire('pointerup', pointer(id, x, y)),
    press: (act) => button(act).fire('pointerdown', pointer(99, 0, 0)),
    release: (act) => button(act).fire('pointerup', pointer(99, 0, 0)),
  }
}

describe('the pause plate, on glass (DEV-290 / DEV-291)', () => {
  /** Paused: the plate is up over a mission, which is both flags at once. */
  const PLATE: TouchContext = { ...FLYING, menu: true, confirmLabel: 'SELECT' }

  it('reports where the glass was tapped, in viewport pixels', () => {
    const controls = mounted(PLATE)
    expect(controls.readMenuTap(), 'nothing tapped yet').toBeNull()
    dom.down(1, 400, 260)
    // Nothing on the way DOWN: a press that becomes a drag must not have
    // already picked a row by the time the finger moves.
    expect(controls.readMenuTap()).toBeNull()
    dom.up(1, 400, 260)
    expect(controls.readMenuTap()).toEqual({ x: 400, y: 260 })
  })

  it('consumes the tap, so one tap is one press', () => {
    const controls = mounted(PLATE)
    dom.down(1, 10, 20)
    dom.up(1, 10, 20)
    expect(controls.readMenuTap()).not.toBeNull()
    // The bug this is the guard for: a peeked tap re-picks the same row every
    // frame, which on a plate means holding a row down for ever.
    expect(controls.readMenuTap()).toBeNull()
  })

  it('refuses a DRAG, which is somebody scrolling a list that does not scroll', () => {
    const controls = mounted(PLATE)
    dom.down(1, 100, 100)
    dom.move(1, 100, 180)
    dom.up(1, 100, 180)
    expect(controls.readMenuTap(), '80 px is a drag, not a tap').toBeNull()
  })

  it('allows the few pixels a real finger rolls between landing and lifting', () => {
    // The other side of the same rule. A slop of zero would make the picker
    // work for a mouse and fail for a thumb, which is the only device it has.
    const controls = mounted(PLATE)
    dom.down(1, 100, 100)
    dom.up(1, 103, 102)
    expect(controls.readMenuTap()).toEqual({ x: 103, y: 102 })
  })

  it('does not deliver a stick while the plate is up', () => {
    const controls = mounted(PLATE)
    dom.down(1, 100, 300)
    dom.move(1, 100, 300 - REACH)
    // A full-deflection drag in the left half. Flying, this is pitch; paused,
    // the sim is frozen and it must command nothing at all.
    const actions = controls.read(OPTS)
    // `toBeCloseTo`, as the no-ship test above does it and for the same
    // reason: `touchActions` negates the stick's y, and a negated zero is
    // `-0`, which `toBe` separates from `0` and nothing else in the game does.
    expect(actions.pitch, 'the frozen ship is handed nothing').toBeCloseTo(0, 10)
    expect(actions.yaw).toBeCloseTo(0, 10)
  })

  it('turns the hamburger into a close button, and takes the flight chips away', () => {
    const controls = mounted(FLYING)
    expect(dom.button('pause').textContent, 'a hamburger when there is a run').toContain('MENU')
    for (const id of ['brake', 'boost', 'auto', 'cam'] as const) {
      expect(dom.button(id).hidden, `${id} while flying`).toBe(false)
    }

    controls.setContext(PLATE)
    // `✕`, because a control that opens something and does not visibly close it
    // is the discoverability bug this pair of numbers exists to fix.
    expect(dom.button('pause').textContent).not.toContain('MENU')
    expect(dom.button('pause').hidden, 'the way out stays').toBe(false)
    for (const id of ['brake', 'boost', 'auto', 'cam'] as const) {
      expect(dom.button(id).hidden, `${id} with the plate up`).toBe(true)
    }
    // And the SELECT chip, which used to sit exactly over the plate's last two
    // rows on a portrait phone — the rows you could not then read OR press.
    expect(dom.button('confirm').hidden, 'the chip stops covering the rows').toBe(true)

    controls.setContext(FLYING)
    expect(dom.button('pause').textContent, 'and back again').toContain('MENU')
    for (const id of ['brake', 'boost', 'auto', 'cam'] as const) {
      expect(dom.button(id).hidden, `${id} back after resume`).toBe(false)
    }
    expect(dom.button('confirm').hidden).toBe(false)
  })

  it('hides the confirm chip on a screen that NEVER had a label', () => {
    // The bug: `shownLabel` was seeded with `null`, which is also a legal
    // VALUE of `confirmLabel` — it is what the game reports whenever a press
    // would do nothing. So on a screen that opens with no label the cache
    // compared `null !== null`, the block never ran once, and
    // `buttons.confirm.hidden` was never assigned at all: the chip kept the
    // `START` it is CONSTRUCTED with and sat over the cockpit for the whole
    // flight, naming a screen two screens back.
    //
    // It needs a mount that goes straight to a label-less context and stays
    // there, which is `?autopilot=1` — the launch prompt is spent in the same
    // frame it appears, so `confirmLabel` is null from the first sync to the
    // last. Every other test in this file happens to pass through a labelled
    // screen on the way in, which is why 35 of them were green while a button
    // was drawn over the game.
    const controls = attachTouchControls(dom.canvas, { enabled: true })
    controls.setVisible(true)
    controls.setContext({ ...FLYING, confirmLabel: null })
    expect(dom.button('confirm').hidden, 'a chip with no word is not on screen').toBe(true)
  })

  it('drops a pending tap when the controls are taken away', () => {
    const controls = mounted(PLATE)
    dom.down(1, 50, 50)
    dom.up(1, 50, 50)
    // A session starting, the landing card returning — anything that hides the
    // overlay. A tap delivered after that would pick a row on a plate nobody
    // is looking at.
    controls.setVisible(false)
    expect(controls.readMenuTap()).toBeNull()
  })
})

describe('the TILT chip (DEV-292)', () => {
  const WITH_SENSORS: TouchContext = { ...FLYING, tiltAvailable: true }

  it('is absent on a device with no sensors, and present on one with them', () => {
    const controls = mounted(FLYING)
    expect(dom.button('tilt').hidden, 'no gyroscope, no chip').toBe(true)
    controls.setContext(WITH_SENSORS)
    expect(dom.button('tilt').hidden).toBe(false)
  })

  it('lights from the game’s own flag, like AUTO — a readout, not a latch', () => {
    const controls = mounted(WITH_SENSORS)
    expect(dom.button('tilt').dataset.on).toBeUndefined()
    controls.setContext({ ...WITH_SENSORS, tilt: true })
    expect(dom.button('tilt').dataset.on).toBe('1')
    controls.setContext(WITH_SENSORS)
    expect(dom.button('tilt').dataset.on).toBeUndefined()
  })

  it('calls back on RELEASE, inside the gesture, and not on press', () => {
    // The property the whole callback exists for: iOS hands over the
    // orientation sensors only to a call whose stack goes back to a gesture,
    // and transient activation is granted on the release. A latch read from
    // the frame loop would be one animation frame too late, for ever — so if
    // this ever becomes "fires on pointerdown" or "fires from read()", the
    // feature silently stops working on iPhones and nowhere else.
    const controls = mounted(WITH_SENSORS)
    let taps = 0
    controls.onGyroTap(() => {
      taps++
    })
    dom.press('tilt')
    expect(taps, 'not on the way down').toBe(0)
    dom.release('tilt')
    expect(taps).toBe(1)
    // And it is not also delivered through the frame boundary, which would
    // toggle twice per tap.
    controls.read(OPTS)
    expect(taps).toBe(1)
  })
})

describe('the fake is a fake of the real thing', () => {
  it('knows every chip the overlay claims to build', () => {
    // A guard on the FIXTURE. If a chip is renamed, the tests above would start
    // throwing from the helper rather than failing on the behaviour, and a
    // fixture that quietly stops reaching the code is how a suite rots green.
    mounted()
    for (const id of TOUCH_BUTTON_IDS) {
      expect(dom.button(id).dataset.act).toBe(id)
    }
  })
})

describe('the title screen, on glass (DEV-353)', () => {
  // The title's two rows are tapped like the pause plate's, but the title is
  // not a plate over a frozen ship: its START chip is the press that has
  // always started the game on a phone, and it stays. `taps` is the picker
  // half of `menu` without the half that takes the controls away.
  const TITLE: TouchContext = { ...IDLE_CONTEXT, taps: true, confirmLabel: 'START' }

  it('reports a tap on the bare glass, and keeps the START chip', () => {
    const controls = mounted(TITLE)
    dom.down(1, 300, 500)
    dom.up(1, 300, 500)
    expect(controls.readMenuTap()).toEqual({ x: 300, y: 500 })
    expect(dom.button('confirm').hidden, 'START is still there to press').toBe(false)
  })

  it('reports nothing where nobody asked for taps', () => {
    const controls = mounted({ ...IDLE_CONTEXT, confirmLabel: 'START' })
    dom.down(1, 300, 500)
    dom.up(1, 300, 500)
    expect(controls.readMenuTap()).toBeNull()
  })
})

describe('the hangar, on glass: a table is tapped, the room is dragged (DEV-604)', () => {
  const ROOM: TouchContext = { ...MENU, taps: true }

  it('reports a finger that stayed put as a tap', () => {
    const controls = mounted(ROOM)
    dom.down(1, 300, 500)
    dom.up(1, 303, 502)
    expect(controls.readMenuTap()).toEqual({ x: 303, y: 502 })
  })

  it('still LOOKS with a drag, and a drag is not a tap', () => {
    const controls = mounted(ROOM)
    dom.down(1, 300, 500)
    dom.move(1, 420, 500)
    const look = controls.readLook(LOOK)
    expect(Math.abs(look.yaw), 'the drag turned the view').toBeGreaterThan(0)
    dom.up(1, 420, 500)
    expect(controls.readMenuTap(), '120 px is a drag').toBeNull()
  })

  it('taps nothing in the hangar where the context does not ask (the lobby, say)', () => {
    const controls = mounted(MENU)
    dom.down(1, 300, 500)
    dom.up(1, 300, 500)
    expect(controls.readMenuTap()).toBeNull()
  })
})

describe('RACE THIS LAP, on the results panel (DEV-371 follow-up)', () => {
  // Matt, 2026-09-25: *"a touch route to 'race this lap'"*. The panel offers
  // it by R, Y and the right stick's click; a phone had none of the three. The
  // chip is offered exactly when `app.ts`'s race handler would act, and says
  // what the press does there.
  const RESULTS: TouchContext = { ...FLYING, confirmLabel: 'AGAIN', raceLabel: RACE_LAP_LABEL }

  it('is not there where the context says nothing about it', () => {
    mounted(FLYING)
    expect(dom.button('race').hidden, 'flying, no panel').toBe(true)
    dom = fakeDom()
    mounted({ ...IDLE_CONTEXT, confirmLabel: 'START' })
    expect(dom.button('race').hidden, 'the title').toBe(true)
  })

  it('is there, with its word, beside AGAIN when the panel offers a lap', () => {
    mounted(RESULTS)
    expect(dom.button('race').hidden).toBe(false)
    expect(dom.button('race').textContent).toBe(RACE_LAP_LABEL)
    expect(dom.button('confirm').hidden, 'AGAIN stays').toBe(false)
    expect(dom.button('confirm').textContent).toBe('AGAIN')
  })

  it('wears whatever word the context gives it', () => {
    // DEV-571: the race press is always "race this lap" now; the chip still
    // draws the context's word rather than a copy of its own.
    mounted({ ...RESULTS, raceLabel: 'ANOTHER WORD' })
    expect(dom.button('race').textContent).toBe('ANOTHER WORD')
  })

  it('latches a tap, once, and is not a confirm', () => {
    const controls = mounted(RESULTS)
    dom.press('race')
    dom.release('race')
    controls.read(OPTS)
    expect(controls.raceLap, 'a tap between two frames still counts').toBe(true)
    expect(controls.confirm, 'and it is not AGAIN').toBe(false)
    controls.read(OPTS)
    expect(controls.raceLap, 'one tap, one press').toBe(false)
  })

  it('goes away under the pause plate, and comes back when it closes', () => {
    const controls = mounted(RESULTS)
    controls.setContext({ ...RESULTS, menu: true, confirmLabel: 'SELECT' })
    expect(dom.button('race').hidden, 'a chip over a plate hides its rows').toBe(true)
    controls.setContext(RESULTS)
    expect(dom.button('race').hidden).toBe(false)
  })

  it('taken away while held, it cannot still press itself', () => {
    const controls = mounted(RESULTS)
    dom.press('race')
    controls.setContext({ ...FLYING, confirmLabel: null })
    controls.read(OPTS)
    expect(controls.raceLap).toBe(false)
    expect(dom.button('race').hidden).toBe(true)
  })

  it('is wired: `app.ts` reads the chip and offers it on one predicate', () => {
    // Source, because the wiring lives in the frame loop and CI runs no
    // Playwright (`ghost-local.spec.ts` taps it in a phone-shaped browser). The
    // handler and the chip read ONE `raceLapOffered`, so the chip cannot be
    // offered where the press does nothing.
    const app = appSource()
    expect(app).toMatch(/const wantRaceLap = [^\n]*\|\| touch\.raceLap/)
    expect(app).toMatch(/if \(racePress && raceLapOffered\(\)\)/)
    expect(app).toMatch(/raceLabel: touchRaceLabel\(\)/)
    // DEV-571: one word now, so the formatter wraps the ternary in parentheses.
    expect(app).toMatch(/const touchRaceLabel = \(\): string \| null =>\s*\(?raceLapOffered\(\)/)
  })
})
