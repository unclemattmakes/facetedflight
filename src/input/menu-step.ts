// src/input/menu-step.ts: which row a menu moves to, from every device.
//
// `menuNudge` (actions.ts) owns the DIRECTION of one axis. This file owns the
// rest of "a stick, a key or a D-pad moved a menu", which `boot/app.ts` wrote
// out in full for the pause plate, the lobby, the lap questions, the title and
// TV, and `game/tv/tv-view.ts` wrote the tail of a sixth time:
//
//   1. which device is believed when more than one has moved   (`menuStepFrom`)
//   2. one row per push, not one per frame while held           (`createRowStepper`)
//   3. the end of the list stops the aim rather than wrapping   (`clampAim`)
//
// Three small functions because the three parts change for different reasons:
// the precedence is a DEV (299 moved the keys out of the ramp), the latch is an
// input-feel question, and the clamp is a list's shape. They were one block,
// copied, and the next change to any of them would have reached some of six.
//
// What stays at the call site, on purpose: the pause plate clears `actions`
// (a frozen sim must not also receive the stick as a flight command), the
// title does not (it has no ship), and the lap questions map a row INDEX back
// to a row ID. None of that is menu stepping.

import { menuNudge } from './actions'
import { createEdge } from './edge'

/**
 * The step a menu takes this frame: -1 up, +1 down, 0 still.
 *
 * Precedence, which is the whole point of the function:
 *
 *   1. the KEYS, read as keys (DEV-299). `keyPitch` is the keyboard's
 *      `menuPitch`, the pitch axis without its ramp. The ramp's decay is as
 *      much of that bug as its climb: a released key sits past the deadband for
 *      another 90 ms, which holds the latch and eats the next tap. So the keys
 *      are read from a device that is disjoint from the stick.
 *   2. the STICK, merged over the pad, the headset sticks and the touch sticks
 *      (`stickPitch`). It wins over the D-pad because it is the one every
 *      device has.
 *   3. the D-PAD (`dpad`, `xr.menuStep`). It is 0 on a controller whose left
 *      face buttons are face buttons, so a Touch user pays nothing for it.
 *
 * `invertPitch` is undone for both analogue halves by `menuNudge`: it is a
 * flight preference and has no business reaching a menu. The D-pad is a button
 * and was never inverted.
 *
 * Pass `keyPitch` from `keyboard.menuPitch`, never from a ramped flight axis.
 */
export const menuStepFrom = (
  keyPitch: number,
  stickPitch: number,
  dpad: -1 | 0 | 1,
  invertPitch: boolean,
): -1 | 0 | 1 => {
  const key = menuNudge(keyPitch, invertPitch)
  if (key !== 0) return key
  const stick = menuNudge(stickPitch, invertPitch)
  if (stick !== 0) return stick
  return dpad
}

/** `aim` moved by `step` and held inside a list of `count` rows. An empty list gives 0. */
export const clampAim = (aim: number, step: number, count: number): number =>
  Math.max(0, Math.min(count - 1, aim + step))

export interface RowStepper {
  /**
   * Feed this frame's step. Returns it on the frame a push BEGINS (the step was
   * 0 or the stepper was reset, and now it is not), else 0. Holding the stick
   * steps one row; letting go and pushing again steps another. Pushing the
   * other way without letting go does not step: the latch is on "moving", not
   * on a direction, as the five copies it replaces were.
   */
  take(step: number): number
  /** The next push is a fresh one (a menu opening). */
  reset(): void
}

/**
 * One latch per menu, never shared between two (trap 19: a shared latch is
 * a menu that inherits another's held stick).
 */
export const createRowStepper = (): RowStepper => {
  const edge = createEdge()
  return {
    take(step) {
      return edge.step(step !== 0) ? step : 0
    },
    reset() {
      edge.reset()
    },
  }
}
