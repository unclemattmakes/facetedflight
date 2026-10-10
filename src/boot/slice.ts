// src/boot/slice.ts — long work in slices, so the frames keep coming. DEV-355.
//
// ── Why a slice and not a worker ─────────────────────────────────────────
//
// Matt: *"add a vr-comfy loading screen — the app currently freezes."* The
// measurement (`tests/e2e/switch-stall.spec.ts`, DEVIATIONS DEV-355 §1) found
// the freeze was not one thing: a course switch on `int_01_hoverJet` ran the
// far-shadow march, the sky-visibility bake and the shader warm-up back to back
// with no `await` between them, 3.4 s in ONE task, and in a headset a task that
// long is a frame the compositor has to invent from the last one.
//
// A worker would take the bakes off the thread entirely, and it is the better
// end state; it is also a structured clone of the height field and a second
// copy of each bake's inputs, which is a larger change than the complaint. The
// bakes are already pure generators (`sim/steps.ts`), so the cheap move is to
// run them a frame's budget at a time on the thread they already use.
//
// ── How it hands the thread back ─────────────────────────────────────────
//
// A macrotask, posted through a `MessageChannel`. Not a microtask (a resolved
// promise never lets a frame in), not `setTimeout(0)` (the nesting clamp makes
// every yield after the fifth cost at least 4 ms of nothing), and not
// `requestAnimationFrame` — which is not the frame clock while an immersive
// session presents (the session's own `requestAnimationFrame` is, and three's
// `setAnimationLoop` switches to it), so waiting on the window's would wait on
// the wrong thing. A posted task goes to the back of the queue; the renderer's
// frame, flat or XR, is serviced before it whenever one is due.

import type { Steps } from '@/sim/steps'

/**
 * How long a slice may run before it gives the thread back.
 *
 * Against the tightest frame the game is played at: 90 Hz, 11.1 ms. The loading
 * scene draws in well under 2 ms, so 8 ms of work leaves the frame whole on a
 * flat 60 Hz screen and costs at most every other frame at 90, which the
 * compositor fills by reprojecting a scene at infinity — the one case where
 * reprojection is exact.
 */
export const SLICE_BUDGET_MS = 8

/** Hand the thread back for one turn of the event loop. */
export const yieldToEventLoop = (): Promise<void> =>
  new Promise<void>((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0)
      return
    }
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })

export interface Slicer {
  /**
   * A point at which the work may stop. Resolves at once while the slice has
   * budget left; once it is spent, yields a turn and starts a new slice.
   */
  checkpoint(): Promise<void>
  /**
   * Run a stepped bake to the end, stopping at its row boundaries whenever the
   * budget is spent. `onProgress` sees each yielded fraction.
   */
  drain<T>(steps: Steps<T>, onProgress?: (fraction: number) => void): Promise<T>
  /** Turns handed back so far. A receipt: zero on a build that never yielded. */
  readonly yields: number
}

export interface SlicerOptions {
  readonly budgetMs?: number
  /** A clock, so a test can run the schedule without waiting on one. */
  readonly now?: () => number
  /** How to hand the thread back. The test's is a counter. */
  readonly yieldTurn?: () => Promise<void>
}

export const createSlicer = (options: SlicerOptions = {}): Slicer => {
  const budget = options.budgetMs ?? SLICE_BUDGET_MS
  const now = options.now ?? (() => performance.now())
  const yieldTurn = options.yieldTurn ?? yieldToEventLoop
  let started = now()
  let yields = 0

  const checkpoint = async (): Promise<void> => {
    if (now() - started < budget) return
    yields += 1
    await yieldTurn()
    started = now()
  }

  return {
    checkpoint,
    async drain<T>(steps: Steps<T>, onProgress?: (fraction: number) => void): Promise<T> {
      for (;;) {
        const next = steps.next()
        if (next.done) return next.value
        onProgress?.(next.value)
        await checkpoint()
      }
    },
    get yields() {
      return yields
    },
  }
}
