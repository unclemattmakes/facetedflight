// src/render/canvas-fit.ts: the drawing buffer and the lens follow the canvas's
// own box, whatever moved it. DEV-595.
//
// Matt, 2026-10-03, on his phone: *"phone - camera aspect is squished after
// rotating. doesn't go into full screen"*.
//
// ── Why one `resize` listener was not enough ────────────────────────────
//
// Until this row `render/renderer.ts` re-fitted on the window's `resize` and
// nothing else, reading `canvas.clientWidth` / `clientHeight` inside the
// event. That is right on a desktop, where a window's size and its `resize`
// arrive together, and it is the reading every Playwright spec makes, because
// Chromium's device emulation changes the viewport and sends the event in one
// step. A phone does not promise that. A turn is an animation the browser
// runs, and the event can fire while the layout still has the old shape (iOS
// Safari is the case most often reported: the numbers read inside the event
// are the pre-rotation ones, and the right ones arrive a frame or two later
// with no second `resize`). The handler read the box once, and if that box was
// stale it set the old aspect and nothing ever asked again, so the picture
// stayed stretched to the new shape until something else resized the window.
// NOT reproduced on a real phone from here: an emulated turn cannot be made to
// send a stale event. What the spec does reproduce is the shape of it, a canvas
// box that moves with no `resize` after it (`phone-refit.spec.ts`), and the old
// handler stays squished there.
//
// So the question is turned round: not "did the window say it resized?" but
// "is the canvas's box still the size we drew for?". Asked:
//
//  - by a `ResizeObserver` on the canvas, which the browser runs AFTER layout,
//    so it cannot read a stale box: it fires because the box changed;
//  - on every event that can move the box (the window's `resize` and
//    `orientationchange`, the visual viewport's `resize`, the screen
//    orientation's `change`, and entering or leaving fullscreen), at once AND
//    on the next `FIT_FOLLOW_FRAMES` animation frames, which covers a browser
//    without the observer and an event that fired ahead of its own layout.
//
// Every ask is cheap when nothing moved: two integer reads and a compare, and
// `apply` runs only when the box is a different size. One camera serves every
// view (title, hangar, flight, chase, results), so one fit serves them all.
//
// No three.js. `apply` is the renderer's; this file only decides WHEN.

/** Animation frames after an event on which the box is asked again. */
export const FIT_FOLLOW_FRAMES = 2

/** Window events that can move the canvas's box. */
export const FIT_WINDOW_EVENTS = ['resize', 'orientationchange'] as const
/** Document events that can: entering and leaving fullscreen (the prefixed one is older WebKit). */
export const FIT_DOCUMENT_EVENTS = ['fullscreenchange', 'webkitfullscreenchange'] as const

interface Listens {
  addEventListener(type: string, fn: () => void): void
  removeEventListener(type: string, fn: () => void): void
}

/** The pieces of a canvas this reads. Structural, so a test hands in a stand-in. */
export interface FitCanvas {
  readonly clientWidth: number
  readonly clientHeight: number
}

/** The pieces of a window this reads. Every one optional but the listeners. */
export interface FitWindow extends Listens {
  readonly document?: Listens | null
  readonly visualViewport?: Listens | null
  readonly screen?: { readonly orientation?: Partial<Listens> | null } | null
  requestAnimationFrame?(fn: () => void): number
  cancelAnimationFrame?(id: number): void
  readonly ResizeObserver?: new (
    callback: () => void,
  ) => { observe(target: never): void; disconnect(): void }
}

export interface CanvasFit {
  /**
   * Ask now. Applies and returns true when the box is not the size last
   * applied (or always, with `force`). Returns false while `skip` holds.
   */
  refit(force?: boolean): boolean
  /** How many times `apply` has run, for a probe. */
  readonly applied: number
  dispose(): void
}

export const attachCanvasFit = (
  canvas: FitCanvas,
  win: FitWindow | null,
  apply: (width: number, height: number) => void,
  options: {
    /** True while something else owns the drawing buffer (a headset session). */
    readonly skip?: () => boolean
  } = {},
): CanvasFit => {
  let lastWidth = -1
  let lastHeight = -1
  let applied = 0

  const refit = (force = false): boolean => {
    if (options.skip?.()) return false
    const w = canvas.clientWidth || 1
    const h = canvas.clientHeight || 1
    if (!force && w === lastWidth && h === lastHeight) return false
    lastWidth = w
    lastHeight = h
    applied += 1
    apply(w, h)
    return true
  }

  // ── the follow-up frames ──────────────────────────────────────────────
  let frame: number | null = null
  let framesLeft = 0
  const follow = () => {
    frame = null
    refit()
    framesLeft -= 1
    if (framesLeft > 0 && win?.requestAnimationFrame) frame = win.requestAnimationFrame(follow)
  }
  const onEvent = () => {
    refit()
    framesLeft = FIT_FOLLOW_FRAMES
    if (frame === null && win?.requestAnimationFrame) frame = win.requestAnimationFrame(follow)
  }

  const doc = win?.document ?? null
  const viewport = win?.visualViewport ?? null
  const orientation = win?.screen?.orientation ?? null
  for (const type of FIT_WINDOW_EVENTS) win?.addEventListener(type, onEvent)
  for (const type of FIT_DOCUMENT_EVENTS) doc?.addEventListener(type, onEvent)
  viewport?.addEventListener('resize', onEvent)
  orientation?.addEventListener?.('change', onEvent)

  // The observer is the one that cannot read a stale box. Where there is none
  // (an old browser, a test), the events and their follow-up frames still ask.
  const Observer = win?.ResizeObserver
  const observer = Observer ? new Observer(() => refit()) : null
  observer?.observe(canvas as never)

  refit()

  return {
    refit,
    get applied() {
      return applied
    },
    dispose() {
      for (const type of FIT_WINDOW_EVENTS) win?.removeEventListener(type, onEvent)
      for (const type of FIT_DOCUMENT_EVENTS) doc?.removeEventListener(type, onEvent)
      viewport?.removeEventListener('resize', onEvent)
      orientation?.removeEventListener?.('change', onEvent)
      observer?.disconnect()
      if (frame !== null) win?.cancelAnimationFrame?.(frame)
      frame = null
    },
  }
}
