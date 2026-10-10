// tests/unit/canvas-fit.test.ts: the drawing buffer and the lens follow the
// canvas's own box. DEV-595.
//
// Matt, on his phone: *"camera aspect is squished after rotating"*. The rule
// (`render/canvas-fit.ts`) is WHEN to ask the box; the renderer's `apply` is
// what to do with the answer. The browser half (a real canvas, a real
// observer, an emulated Pixel 7 turned both ways) is `phone-refit.spec.ts`.

import { describe, expect, it } from 'vitest'
import {
  attachCanvasFit,
  FIT_DOCUMENT_EVENTS,
  FIT_FOLLOW_FRAMES,
  FIT_WINDOW_EVENTS,
  type FitWindow,
} from '@/render/canvas-fit'

/** Something with listeners that records them, and can fire one. */
const target = () => {
  const on = new Map<string, Set<() => void>>()
  return {
    on,
    addEventListener(type: string, fn: () => void) {
      if (!on.has(type)) on.set(type, new Set())
      on.get(type)?.add(fn)
    },
    removeEventListener(type: string, fn: () => void) {
      on.get(type)?.delete(fn)
    },
    fire(type: string) {
      for (const fn of on.get(type) ?? []) fn()
    },
    count() {
      let n = 0
      for (const set of on.values()) n += set.size
      return n
    },
  }
}

/** A canvas, a window with a frame queue, and (optionally) an observer. */
const rig = (opts: { observer?: boolean } = {}) => {
  const canvas = { clientWidth: 915, clientHeight: 412 }
  const win = target()
  const doc = target()
  const viewport = target()
  const orientation = target()
  let frames: Array<() => void> = []
  let observed: (() => void) | null = null
  let disconnected = false
  const cancelled: number[] = []
  const w: FitWindow = {
    addEventListener: win.addEventListener,
    removeEventListener: win.removeEventListener,
    document: doc,
    visualViewport: viewport,
    screen: { orientation },
    requestAnimationFrame(fn) {
      frames.push(fn)
      return frames.length
    },
    cancelAnimationFrame(id) {
      cancelled.push(id)
    },
    ...(opts.observer
      ? {
          ResizeObserver: class {
            constructor(cb: () => void) {
              observed = cb
            }
            observe() {}
            disconnect() {
              disconnected = true
            }
          },
        }
      : {}),
  }
  const applied: Array<[number, number]> = []
  let presenting = false
  const fit = attachCanvasFit(canvas, w, (width, height) => applied.push([width, height]), {
    skip: () => presenting,
  })
  /** Run one animation frame's worth of queued callbacks. */
  const frame = () => {
    const now = frames
    frames = []
    for (const fn of now) fn()
  }
  return {
    canvas,
    win,
    doc,
    viewport,
    orientation,
    fit,
    applied,
    frame,
    queued: () => frames.length,
    observe: () => observed?.(),
    disconnected: () => disconnected,
    cancelled,
    present: (on: boolean) => {
      presenting = on
    },
  }
}

/** Turn the phone: the box takes the other shape. */
const turn = (canvas: { clientWidth: number; clientHeight: number }) => {
  const { clientWidth, clientHeight } = canvas
  canvas.clientWidth = clientHeight
  canvas.clientHeight = clientWidth
}

describe('the canvas follows its box', () => {
  it('fits once at mount, and not again while the box has not moved', () => {
    const r = rig()
    expect(r.applied).toEqual([[915, 412]])
    r.win.fire('resize')
    r.frame()
    r.frame()
    expect(r.applied).toEqual([[915, 412]])
    expect(r.fit.applied).toBe(1)
  })

  it('a resize that fires AHEAD of its layout is caught on the frames after it', () => {
    // The phone's case. The event arrives while the box still has the old
    // shape; the new shape lands a frame later, with no second event. A
    // handler that read the box only inside the event (the one this replaced)
    // keeps the old aspect from here on.
    const r = rig()
    r.win.fire('resize')
    expect(r.applied).toHaveLength(1)
    turn(r.canvas)
    r.frame()
    expect(r.applied.at(-1)).toEqual([412, 915])
  })

  it('asks on exactly FIT_FOLLOW_FRAMES frames after an event, then stops', () => {
    const r = rig()
    r.win.fire('orientationchange')
    for (let i = 0; i < FIT_FOLLOW_FRAMES; i++) {
      expect(r.queued(), `frame ${i + 1} is asked`).toBe(1)
      r.frame()
    }
    expect(r.queued()).toBe(0)
    // A burst of events is one run of follow-ups, not one per event.
    r.win.fire('resize')
    r.win.fire('resize')
    r.viewport.fire('resize')
    expect(r.queued()).toBe(1)
  })

  it('listens for every event that can move the box', () => {
    const r = rig()
    const fire: Array<[string, () => void]> = [
      ...FIT_WINDOW_EVENTS.map((t) => [`window ${t}`, () => r.win.fire(t)] as [string, () => void]),
      ...FIT_DOCUMENT_EVENTS.map(
        (t) => [`document ${t}`, () => r.doc.fire(t)] as [string, () => void],
      ),
      ['visualViewport resize', () => r.viewport.fire('resize')],
      ['screen.orientation change', () => r.orientation.fire('change')],
    ]
    expect(FIT_WINDOW_EVENTS).toEqual(['resize', 'orientationchange'])
    expect(FIT_DOCUMENT_EVENTS).toEqual(['fullscreenchange', 'webkitfullscreenchange'])
    for (const [name, go] of fire) {
      turn(r.canvas)
      const before = r.applied.length
      go()
      expect(r.applied.length, name).toBe(before + 1)
      expect(r.applied.at(-1), name).toEqual([r.canvas.clientWidth, r.canvas.clientHeight])
    }
  })

  it('refits from the ResizeObserver, with no window event at all', () => {
    const r = rig({ observer: true })
    turn(r.canvas)
    r.observe()
    expect(r.applied.at(-1)).toEqual([412, 915])
  })

  it('leaves the buffer alone while a headset owns it, and fits on demand after', () => {
    const r = rig()
    r.present(true)
    turn(r.canvas)
    r.win.fire('resize')
    r.frame()
    r.frame()
    expect(r.applied).toHaveLength(1)
    r.present(false)
    // `sessionend`: three has just put back the pre-session size, so the
    // renderer asks with `force` whether or not the box looks new.
    expect(r.fit.refit(true)).toBe(true)
    expect(r.applied.at(-1)).toEqual([412, 915])
    expect(r.fit.refit(true)).toBe(true)
    expect(r.fit.refit()).toBe(false)
  })

  it('never hands the renderer a zero side', () => {
    const r = rig()
    r.canvas.clientWidth = 0
    r.canvas.clientHeight = 0
    r.win.fire('resize')
    expect(r.applied.at(-1)).toEqual([1, 1])
  })

  it('dispose takes back every listener, the observer and the queued frame', () => {
    const r = rig({ observer: true })
    r.win.fire('resize')
    expect(r.queued()).toBe(1)
    r.fit.dispose()
    expect(r.win.count() + r.doc.count() + r.viewport.count() + r.orientation.count()).toBe(0)
    expect(r.disconnected()).toBe(true)
    expect(r.cancelled).toEqual([1])
  })

  it('mounts on no window at all (a test, a worker) and still fits on demand', () => {
    const canvas = { clientWidth: 640, clientHeight: 360 }
    const applied: Array<[number, number]> = []
    const fit = attachCanvasFit(canvas, null, (w, h) => applied.push([w, h]))
    expect(applied).toEqual([[640, 360]])
    turn(canvas)
    fit.refit()
    expect(applied.at(-1)).toEqual([360, 640])
    fit.dispose()
  })
})
