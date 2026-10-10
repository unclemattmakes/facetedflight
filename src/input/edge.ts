// src/input/edge.ts: a button's rising edge, written once.
//
// `boot/app.ts` hand-rolled this about twenty times: `if (want && !xHeld) act();
// xHeld = want`. Every device field in `input/` says "raw state, the caller
// edge-detects", so every caller wrote the two lines, and each copy got its own
// answer to the questions that decide whether a press is lost or delivered
// late (where the write goes, whether a branch can skip it, who resets it).
//
// ── The one rule: step it EVERY frame, never inside a short-circuit ───────
//
// `step(down)` records the state as well as reporting the edge, so a call that
// does not run is a frame the latch did not see. `if (gate && edge.step(want))`
// skips the step whenever `gate` is false, and the press made in that frame
// arrives later, stale, the first frame `gate` is true again.
// `input/xr-select.ts` documents the same trap for `||` chains. Step first into
// a `const`, then gate:
//
//     const pressed = edge.step(want)   // runs on every frame this code runs
//     if (gate && pressed) act()
//
// A latch that is deliberately stepped only while its screen is up (the menu
// nudges: held state is simply frozen while the menu is down) is a different
// shape and a deliberate one; those sites say so and use `reset()` when the
// screen opens, as `app.ts` did with `pauseNudgeHeld = false`.

export interface Edge {
  /**
   * Record this frame's raw state. True on the frame it went from up to down,
   * false while it stays down and while it is up.
   */
  step(down: boolean): boolean
  /** The state the last `step` recorded: was it down. */
  readonly held: boolean
  /**
   * Count it as already down, so the press in progress does not fire when
   * whatever was covering it lets go (DEV-611's splash). The next `step` still
   * records the real state, as the plain assignment it replaces did.
   */
  hold(): void
  /** Forget: the next down is a fresh press. */
  reset(): void
}

export interface Edges<K> {
  /** `Edge.step` for the latch named `key`, made on first use (a button, a hand). */
  step(key: K, down: boolean): boolean
}

/** One latch per key: a pad's buttons, or the two hands. Each is its own `Edge`. */
export const createEdges = <K>(): Edges<K> => {
  const latches = new Map<K, Edge>()
  return {
    step(key, down) {
      let edge = latches.get(key)
      if (!edge) {
        edge = createEdge()
        latches.set(key, edge)
      }
      return edge.step(down)
    },
  }
}

export const createEdge = (): Edge => {
  let held = false
  return {
    step(down) {
      const rose = down && !held
      held = down
      return rose
    },
    get held() {
      return held
    },
    hold() {
      held = true
    },
    reset() {
      held = false
    },
  }
}
