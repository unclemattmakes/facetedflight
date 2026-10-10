// tests/unit/menu-tap.test.ts — DEV-299: a TAP of an arrow key moves one row.
//
// ── The bug, which is two right constants composed into a wrong one ───────
//
// Matt, 2026-09-23: *"arrow keys need several presses in the pause screen."*
//
// The pause list is stepped from the flight PITCH axis, edge-detected past
// `MENU_NUDGE_DEADBAND`. And the keyboard's axes RAMP — `keyboard.ts` explains
// why, and it is right: a key is on or off, a stick is not, and a binary roll
// axis on an aircraft with no auto-level is unflyable. Compose the two and the
// answer is arithmetic:
//
//   > an arrow key had to be held for deadband x ramp = ~90 ms before the menu
//   > saw anything at all, and a tap shorter than that moved nothing.
//
// §1 measures that rather than quoting it. The ramp is right for flying and
// wrong for a list, which is the same correction already in `menuNudge`'s own
// header — *"the invert has no business reaching a menu"* — so the fix is that
// the menu reads the KEY (`keyboard.menuPitch`) and not the ramped axis. The
// D-pad path, `xr.menuStep`, has always read the button and never had this bug.
//
// ── What is measured, and why it is not "the menu moved" ─────────────────
//
// "The menu moved" is green for a 200 ms press on the build that shipped. The
// variable a player is actually complaining about is the TAP DURATION, so that
// is the variable here: §2 sweeps it, and §3 covers the half that is easiest to
// miss — the ramp's DECAY holds the caller's edge detector for another ~90 ms
// after the key comes up, so a fast second tap was eaten even when the first
// one landed. That is why `app.ts` reads this axis INSTEAD of the keyboard's
// ramped one and not as well as it, and §4 is the guard on that.
//
// Every claim is written against BOTH axes in the same breath. A test of the
// fix alone would stay green if the ramp were deleted outright, which would
// hand the flight model a binary stick — the bug `keyboard.ts` exists to avoid.

import { describe, expect, it } from 'vitest'
import { MENU_NUDGE_DEADBAND, menuNudge } from '@/input/actions'
import { attachKeyboard, type KeyboardSource } from '@/input/keyboard'
import { createRowStepper } from '@/input/menu-step'
import { appFileWith, codeOnly } from './helpers/app-source'

const OPTS = { invertPitch: false }
/** A 60 Hz frame. The flat build's, and slower than the headset's. */
const FRAME = 1 / 60

/** The two things a menu could read: the key, or the axis the ship flies on. */
type Axis = 'menuPitch' | 'ramped'

const axisValue = (keyboard: KeyboardSource, axis: Axis, dt: number): number => {
  // `read` ADVANCES the ramps, so it runs on every frame whichever axis the
  // menu ends up consulting — exactly as `app.ts` does it.
  const ramped = keyboard.read(dt, OPTS).pitch
  return axis === 'ramped' ? ramped : keyboard.menuPitch(OPTS)
}

/**
 * Press `ArrowDown` for each duration in turn and answer HOW MANY ROWS moved.
 *
 * The body is the row stepper `boot/app.ts` wraps around `menuNudge` (the real
 * one, `input/menu-step.ts`), and it is here because no single function in
 * `src/` returns the thing a player complains about. It is not a second copy of
 * the DIRECTION: that stays in `menuNudge`, which is the whole reason that
 * function exists.
 */
const rowsForTaps = (holds: readonly number[], gapSeconds: number, axis: Axis): number => {
  const { keyboard, press, release } = fakeKeyboard()
  let rows = 0
  const stepper = createRowStepper()
  const frame = (): void => {
    const nudge = menuNudge(axisValue(keyboard, axis, FRAME), OPTS.invertPitch)
    rows += stepper.take(nudge)
  }
  try {
    for (const seconds of holds) {
      press('ArrowDown')
      for (let t = 0; t < seconds; t += FRAME) frame()
      release('ArrowDown')
      for (let t = 0; t < gapSeconds; t += FRAME) frame()
    }
  } finally {
    keyboard.dispose()
  }
  return rows
}

describe('§1 the bug, as a measured number rather than a quoted one', () => {
  /** Seconds of held key before `menuNudge` sees `axis` at all. */
  const secondsToCross = (axis: Axis): number => {
    const { keyboard, press } = fakeKeyboard()
    press('ArrowDown')
    // A millisecond step, so the answer is the ramp's and not the frame rate's.
    const step = 0.001
    let t = 0
    try {
      while (t < 1 && menuNudge(axisValue(keyboard, axis, step), OPTS.invertPitch) === 0) t += step
    } finally {
      keyboard.dispose()
    }
    return t
  }

  it('cost ~90 ms of HELD key on the ramped axis', () => {
    // Derived here, not copied from the two constants — a number you compute
    // yourself has no provenance machinery behind it (DEV-027), so it gets a
    // test rather than a comment. Bracketed rather than pinned: the claim is
    // "about a tenth of a second", and pinning it to the millisecond would make
    // this file fail the day somebody retunes the ramp for a good reason.
    const t = secondsToCross('ramped')
    expect(t, 'a tenth of a second of held key, for one row').toBeGreaterThan(0.08)
    expect(t).toBeLessThan(0.1)
  })

  it('and none at all on the key', () => {
    // Zero, exactly: the axis is ±1 the instant the key is down, so the first
    // frame a menu looks at it is the frame it steps.
    expect(secondsToCross('menuPitch')).toBe(0)
  })

  it('is a deflection of exactly 1, so the deadband is not a second tuning', () => {
    // `menuPitch` is `read().pitch` with the ramp taken out, same convention and
    // same sign — so `menuNudge` stays the only place that knows which way a row
    // moves, whatever `MENU_NUDGE_DEADBAND` is set to.
    const { keyboard, press } = fakeKeyboard()
    press('ArrowDown')
    expect(Math.abs(keyboard.menuPitch(OPTS))).toBe(1)
    expect(Math.abs(keyboard.menuPitch(OPTS))).toBeGreaterThan(MENU_NUDGE_DEADBAND)
    keyboard.dispose()
  })

  it('is what the ramp CONVERGES to, which is how the two stay one axis', () => {
    // The relationship, not the value (trap 24). Hold the key until the ramp
    // saturates and the two axes are the same number — so a sign or a binding
    // that moved would move both, and a menu can never disagree with the ship
    // about which key is nose-up.
    for (const invertPitch of [false, true]) {
      const { keyboard, press } = fakeKeyboard()
      press('ArrowDown')
      let ramped = 0
      for (let t = 0; t < 0.5; t += FRAME) ramped = keyboard.read(FRAME, { invertPitch }).pitch
      expect(ramped, `invertPitch ${invertPitch}`).toBeCloseTo(
        keyboard.menuPitch({ invertPitch }),
        12,
      )
      keyboard.dispose()
    }
  })
})

describe('§2 a tap moves exactly one row, whatever a realistic tap is', () => {
  // 33 ms is a brisk tap, 50 ms an ordinary one, 83 ms a deliberate one — and
  // every one of them is under the ~90 ms §1 measured, which is why "press it
  // again" was the only thing that ever worked.
  for (const ms of [33, 50, 83]) {
    it(`moves one row for a ${ms} ms tap — and moved NONE on the ramped axis`, () => {
      expect(rowsForTaps([ms / 1000], 0.2, 'menuPitch'), 'the key').toBe(1)
      expect(rowsForTaps([ms / 1000], 0.2, 'ramped'), 'the ramped axis').toBe(0)
    })
  }

  it('moves one row for a long hold too, rather than strobing the list', () => {
    // The edge detection is the other half and it still has to work: a held key
    // is one row, not sixty a second. This is the case that was always green.
    expect(rowsForTaps([1.5], 0.2, 'menuPitch')).toBe(1)
    expect(rowsForTaps([1.5], 0.2, 'ramped')).toBe(1)
  })
})

describe('§3 the DECAY half — why the ramped axis had to leave, not be joined', () => {
  it('counts three quick taps as three rows', () => {
    // Long enough presses that the ramp reaches the deadband, with a gap SHORTER
    // than the ~90 ms the ramp takes to fall back through it. On the ramped axis
    // the decaying value holds the edge detector down and taps two and three are
    // swallowed — *"no number of extra taps helps"*, which is Matt's report
    // exactly and the reason a fix that merely ADDED the key would not be one.
    expect(rowsForTaps([0.2, 0.2, 0.2], 0.05, 'menuPitch')).toBe(3)
    expect(rowsForTaps([0.2, 0.2, 0.2], 0.05, 'ramped')).toBe(1)
  })

  it('and still counts them when the gap is long enough for either', () => {
    // The control case: with a quarter-second between taps both axes agree, so
    // the disagreement above is about the gap and not about the taps.
    expect(rowsForTaps([0.2, 0.2, 0.2], 0.25, 'menuPitch')).toBe(3)
    expect(rowsForTaps([0.2, 0.2, 0.2], 0.25, 'ramped')).toBe(3)
  })
})

describe('§4 app.ts reads the key here, and the ramped axis nowhere near it', () => {
  // Structural, and reading the file with its comments stripped — a guard that
  // classifies by substring is answered by prose about it, and the paragraph
  // this change added to `app.ts` names both halves (CLAUDE.md, DEV-287).
  const nudgeBlock = (): string => {
    // The five menus (pause, lobby, lap questions, title, TV) read ONE step,
    // `menuStepNow`, so this is the whole of the keys-versus-stick question.
    // The ONE file holding it, so the slice below cannot cross files.
    const src = codeOnly(appFileWith('menuStepNow').text)
    const open = src.indexOf('menuStepFrom(')
    expect(open, 'the menus step').toBeGreaterThan(-1)
    const close = src.indexOf('comfort.invertPitch', open)
    expect(close, 'the end of its arguments').toBeGreaterThan(open)
    return src.slice(open, close)
  }

  it('steps from the unramped key first', () => {
    expect(nudgeBlock()).toMatch(/^menuStepFrom\(\s*keyboard\.menuPitch\(/)
  })

  it('has every menu read that one step, and none of them read a device itself', () => {
    const src = codeOnly(appFileWith('menuStepNow').text)
    expect(src.match(/menuStepNow\(\)/g) ?? []).toHaveLength(6)
    expect(src).not.toMatch(/menuNudge\(keyboard\.menuPitch/)
  })

  it('does not let the merged flight actions back in', () => {
    // THE regression. `actions` merges the keyboard IN, so reading it here is
    // the bug by another route — and it would look like a harmless tidy-up.
    expect(nudgeBlock()).not.toContain('actions.pitch')
  })

  it('still steps from the pad, the XR sticks and a phone', () => {
    // Removing the keyboard from that merge must not have removed anything
    // else: three devices reach this menu through the stick half and a fourth
    // (a D-pad) through `xr.menuStep`.
    const block = nudgeBlock()
    for (const device of ['pad', 'xr.actions', 'thumbs', 'xr.menuStep']) {
      expect(block, device).toContain(device)
    }
  })
})

// ── fakes ─────────────────────────────────────────────────────────────────

interface FakeKeyboard {
  readonly keyboard: KeyboardSource
  press(code: string): void
  release(code: string): void
}

/**
 * `attachKeyboard` against the three methods it touches.
 *
 * `tests/unit` is `environment: 'node'` — no DOM. Duplicated from
 * `control-scheme.test.ts` on purpose, for the reason that file gives about its
 * own copy: a shared fixture between two files that exist to check each other
 * is one more thing that can be wrong in both at once.
 */
function fakeKeyboard(): FakeKeyboard {
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  const target = {
    addEventListener(type: string, fn: (e: unknown) => void) {
      const set = listeners.get(type) ?? new Set()
      set.add(fn)
      listeners.set(type, set)
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn)
    },
  }
  const fire = (type: string, code: string): void => {
    for (const fn of listeners.get(type) ?? []) fn({ code, preventDefault() {} })
  }
  return {
    keyboard: attachKeyboard(target as unknown as EventTarget),
    press: (code) => fire('keydown', code),
    release: (code) => fire('keyup', code),
  }
}
