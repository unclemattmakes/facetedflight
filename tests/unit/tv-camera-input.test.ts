// tests/unit/tv-camera-input.test.ts: TV's mouse, without a pointer capture. DEV-616.
//
// Matt, 2026-10-03: "fftv seems to capture my cursor. ... don't capture the
// cursor plz. if i do click and drag, i want to orbit (in chase cam) if i'm in
// a first person view, click-drag should be the same as mouse-look". TV no
// longer captures (`boot/app.ts` keeps the mouse-look off while watching, and
// spends no mouse click as a confirm), so a held LEFT button is a drag here,
// read as a deliberate look: the camera orbits with it, or looks in Free.
//
// A window and a canvas made of plain `EventTarget`s: the module listens on
// both, and nothing else of the DOM is read but the clock, the document's
// pointer lock; the pads come through `firstStandardPad` (the global navigator).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTvCameraInput } from '@/boot/tv-camera-input'
import { BUTTON, setPadsHeld } from '@/input/gamepad'

const harness = () => {
  let now = 1000
  const win = Object.assign(new EventTarget(), {
    performance: { now: () => now },
    document: { pointerLockElement: null },
  })
  const canvas = new EventTarget()
  const input = attachTvCameraInput(
    canvas as unknown as HTMLElement,
    win as unknown as Window & typeof globalThis,
  )
  const fire = (target: EventTarget, type: string, props: Record<string, unknown> = {}): void => {
    target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), props))
  }
  const mouse = { pointerType: 'mouse', pointerId: 1 }
  return {
    input,
    canvas,
    win,
    fire,
    mouse,
    tick: (ms: number) => {
      now += ms
    },
    read: () => input.read(false, null, false),
  }
}

describe('DEV-616: TV reads a left-button drag, with no capture', () => {
  it('a held left button that moves is a deliberate look', () => {
    const h = harness()
    h.read() // watching
    h.fire(h.canvas, 'pointerdown', { ...h.mouse, button: 0 })
    h.fire(h.win, 'pointermove', { ...h.mouse, movementX: 30, movementY: -8 })
    h.fire(h.win, 'pointermove', { ...h.mouse, movementX: 12, movementY: 0 })
    const r = h.read()
    expect(r.lookDx).toBe(42)
    expect(r.lookDy).toBe(-8)
    expect(r.deliberateLook).toBe(true)
    // Let go: the mouse moves the view no more.
    h.fire(h.win, 'pointerup', { ...h.mouse, button: 0 })
    h.fire(h.win, 'pointermove', { ...h.mouse, movementX: 50, movementY: 5 })
    expect(h.read().lookDx).toBe(0)
    h.input.dispose()
  })

  it('a free mouse, with no button held and no capture, looks at nothing', () => {
    const h = harness()
    h.read()
    h.fire(h.win, 'pointermove', { ...h.mouse, movementX: 50, movementY: 50 })
    const r = h.read()
    expect(r.lookDx).toBe(0)
    expect(r.deliberateLook).toBe(false)
    h.input.dispose()
  })

  it('outside TV (nothing reading) a drag is not TV’s', () => {
    const h = harness()
    h.read()
    h.tick(2000) // nobody has read for 2 s: not watching
    h.fire(h.canvas, 'pointerdown', { ...h.mouse, button: 0 })
    h.fire(h.win, 'pointermove', { ...h.mouse, movementX: 80, movementY: 0 })
    expect(h.read().lookDx).toBe(0)
    h.input.dispose()
  })
})

// DEV-628 (QUESTIONS item 10): "unclear how to change which racer i'm
// following". A plain click or a one-finger tap is the next racer; a drag is
// the orbit and never a tap, even one that comes back to where it started.
describe('DEV-628: a plain click or tap is a tap; a drag is not', () => {
  const at = (x: number, y: number, t: number) => ({ clientX: x, clientY: y, stamp: t })
  /** `harness().fire`, with the event's own `timeStamp` (a read-only getter on a real Event). */
  const fire = (target: EventTarget, type: string, props: Record<string, unknown>): void => {
    const { stamp, ...rest } = props
    const e = Object.assign(new Event(type, { cancelable: true }), rest)
    Object.defineProperty(e, 'timeStamp', { value: stamp })
    target.dispatchEvent(e)
  }

  it('a left click that stays put is one tap, read once', () => {
    const h = harness()
    h.read()
    fire(h.canvas, 'pointerdown', { ...h.mouse, button: 0, ...at(100, 100, 0) })
    fire(h.win, 'pointerup', { ...h.mouse, button: 0, ...at(104, 101, 120) })
    expect(h.read().tap).toBe(true)
    expect(h.read().tap).toBe(false)
    h.input.dispose()
  })

  it('a drag is not a tap, even when it comes back; nor is a long press, or the right button', () => {
    const h = harness()
    h.read()
    fire(h.canvas, 'pointerdown', { ...h.mouse, button: 0, ...at(100, 100, 0) })
    fire(h.win, 'pointermove', { ...h.mouse, movementX: 60, ...at(160, 100, 50) })
    fire(h.win, 'pointermove', { ...h.mouse, movementX: -60, ...at(100, 100, 100) })
    fire(h.win, 'pointerup', { ...h.mouse, button: 0, ...at(100, 100, 150) })
    const dragged = h.read()
    expect(dragged.tap).toBe(false)
    expect(dragged.deliberateLook).toBe(true)
    fire(h.canvas, 'pointerdown', { ...h.mouse, button: 0, ...at(100, 100, 1000) })
    fire(h.win, 'pointerup', { ...h.mouse, button: 0, ...at(100, 100, 1900) })
    expect(h.read().tap).toBe(false)
    fire(h.canvas, 'pointerdown', { ...h.mouse, button: 2, ...at(100, 100, 2000) })
    fire(h.win, 'pointerup', { ...h.mouse, button: 2, ...at(100, 100, 2050) })
    expect(h.read().tap).toBe(false)
    h.input.dispose()
  })

  it('a one-finger tap is a tap; a second finger makes it none', () => {
    const h = harness()
    h.read()
    const f1 = { pointerType: 'touch', pointerId: 7 }
    const f2 = { pointerType: 'touch', pointerId: 8 }
    fire(h.canvas, 'pointerdown', { ...f1, ...at(50, 50, 0) })
    fire(h.win, 'pointerup', { ...f1, ...at(52, 50, 90) })
    expect(h.read().tap).toBe(true)
    fire(h.canvas, 'pointerdown', { ...f1, ...at(50, 50, 200) })
    fire(h.canvas, 'pointerdown', { ...f2, ...at(300, 50, 220) })
    fire(h.win, 'pointerup', { ...f2, ...at(300, 50, 260) })
    fire(h.win, 'pointerup', { ...f1, ...at(50, 50, 280) })
    expect(h.read().tap).toBe(false)
    h.input.dispose()
  })
})

// DEV-695: TV's pad goes through `firstStandardPad`, so DEV-566's hold reaches
// it. `gamepad.ts` promised "every pad reads as unplugged" while a phone is
// upright; TV's own loop over `navigator.getGamepads()` kept that promise
// false: a pad paired to an upright phone still cycled and flew the camera.
// The pad is stubbed on the GLOBAL navigator because that is what the shared
// reader reads (and what the real window is).
describe('DEV-695: the TV camera reads pads through the shared reader', () => {
  const makePad = (down: readonly number[], axes: readonly number[], l2 = 0, r2 = 0) => ({
    connected: true,
    mapping: 'standard',
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({
      pressed: down.includes(i),
      value: i === 6 ? l2 : i === 7 ? r2 : down.includes(i) ? 1 : 0,
    })),
  })
  const withPad = (pad: unknown): void => {
    vi.stubGlobal('navigator', { getGamepads: () => [pad] })
  }
  afterEach(() => {
    setPadsHeld(false)
    vi.unstubAllGlobals()
  })

  it('a standard pad cycles (Y), picks racers (bumpers) and flies (sticks, triggers)', () => {
    withPad(makePad([BUTTON.y, BUTTON.l1, BUTTON.r1], [0.5, -0.25, 0.75, -1], 0.25, 1))
    const h = harness()
    const r = h.read()
    expect(r.cycle).toBe(true)
    expect(r.previous).toBe(true)
    expect(r.next).toBe(true)
    expect(r.padMoveX).toBe(0.5)
    expect(r.padMoveY).toBe(-0.25)
    expect(r.padLookX).toBe(0.75)
    expect(r.padLookY).toBe(-1)
    expect(r.padRise).toBe(0.75)
    // A held button is one edge, not one per read.
    expect(h.read().cycle).toBe(false)
    h.input.dispose()
  })

  it('while a phone is upright (DEV-566) the same pad reads as unplugged', () => {
    withPad(makePad([BUTTON.y, BUTTON.l1, BUTTON.r1], [0.5, -0.25, 0.75, -1], 0.25, 1))
    setPadsHeld(true)
    const h = harness()
    const r = h.read()
    expect(r.cycle).toBe(false)
    expect(r.previous).toBe(false)
    expect(r.next).toBe(false)
    expect(r.padMoveX).toBe(0)
    expect(r.padMoveY).toBe(0)
    expect(r.padLookX).toBe(0)
    expect(r.padLookY).toBe(0)
    expect(r.padRise).toBe(0)
    // And it comes back when the phone is turned.
    setPadsHeld(false)
    expect(h.read().padMoveX).toBe(0.5)
    h.input.dispose()
  })

  it('a pad that is not the standard mapping is not read', () => {
    withPad({ ...makePad([BUTTON.y], [1, 1, 1, 1]), mapping: '' })
    const h = harness()
    const r = h.read()
    expect(r.cycle).toBe(false)
    expect(r.padMoveX).toBe(0)
    h.input.dispose()
  })
})
