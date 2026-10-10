// tests/unit/menu-step.test.ts: the menu step, held against the code it replaced.
//
// `boot/app.ts` carried the same block five times (pause, lobby, lap questions,
// title, TV) and `game/tv/tv-view.ts` the tail of a sixth. The consolidation is
// a pure refactor, so the proof is not "the suite stayed green" (no unit test
// reached the precedence at all: only e2e did) but a replay: the OLD inline
// code is kept below, transcribed from `app.ts` at 94251c7f, and driven with
// the same scripted frames as the new helpers. The traces must be identical,
// frame for frame.
//
// The old code stays here as the oracle. Delete it only with the helpers.

import { describe, expect, it } from 'vitest'
import { menuNudge } from '@/input/actions'
import { createEdge } from '@/input/edge'
import { clampAim, createRowStepper, menuStepFrom } from '@/input/menu-step'
import { lcg } from './helpers/seeded'

type Dir = -1 | 0 | 1

interface Frame {
  /** `keyboard.menuPitch`: 0 or +-1 (the ramp taken out). */
  key: number
  /** The merged stick's pitch: anything in [-1, 1]. */
  stick: number
  /** `xr.menuStep`. */
  dpad: Dir
  invert: boolean
}

/** Values chosen to land on both sides of the deadband, and exactly on it. */
const STICKS = [0, 0, 0, 0.2, -0.2, 0.49, -0.49, 0.5, -0.5, 0.51, -0.51, 0.8, -0.8, 1, -1]

const script = (seed: number, frames: number): Frame[] => {
  const rand = lcg(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T
  const out: Frame[] = []
  // Held for a few frames at a time, as a real push is, so the latch is exercised.
  let cur: Frame = { key: 0, stick: 0, dpad: 0, invert: false }
  for (let i = 0; i < frames; i++) {
    if (rand() < 0.45) {
      cur = {
        key: pick([0, 0, 0, 1, -1]),
        stick: pick(STICKS),
        dpad: pick<Dir>([0, 0, 0, 1, -1]),
        invert: rand() < 0.3 ? !cur.invert : cur.invert,
      }
    }
    out.push(cur)
  }
  return out
}

// ── the oracle: app.ts as it was ─────────────────────────────────────────

/** app.ts 14033-14039 (and the copies): keys, then the stick, then the D-pad. */
const oldNudge = (f: Frame): number => {
  const keyNudge = menuNudge(f.key, f.invert)
  const stickNudge = menuNudge(f.stick, f.invert)
  return keyNudge !== 0 ? keyNudge : stickNudge !== 0 ? stickNudge : f.dpad
}

/** app.ts 14090-14098, the TV's terser spelling of the same precedence. */
const oldTvNudge = (f: Frame): number => {
  const k = menuNudge(f.key, f.invert)
  const s = menuNudge(f.stick, f.invert)
  return k || s || f.dpad
}

/** The pause, lobby and title copies: `aim` clamped to the rows, once per push. */
const oldPlate = () => {
  let aim = 0
  let held = false
  return {
    frame(nudge: number, rows: number): number {
      if (nudge !== 0 && !held) aim = Math.max(0, Math.min(rows - 1, aim + nudge))
      held = nudge !== 0
      return aim
    },
    reset(): void {
      held = false
    },
  }
}

/** app.ts `askNudge`: the same, but the aim is a row ID, mapped through an index. */
const oldAsk = (ids: readonly string[]) => {
  let aimId = ids[0] as string
  let held = false
  return (step: number): string => {
    if (step !== 0 && !held) {
      const at = ids.indexOf(aimId)
      aimId = ids[Math.max(0, Math.min(ids.length - 1, at + step))] ?? aimId
    }
    held = step !== 0
    return aimId
  }
}

/** tv-view.ts `nudge`: the latch moves every call, the aim only while the plate is up. */
const oldTv = () => {
  let up = false
  let aim = 0
  let nudgeHeld = false
  let backHeld = false
  const log: string[] = []
  return {
    setUp(v: boolean) {
      up = v
    },
    nudge(step: number, back: boolean, rows: number): void {
      if (up && step !== 0 && !nudgeHeld) aim = Math.max(0, Math.min(rows - 1, aim + step))
      nudgeHeld = step !== 0
      if (back && !backHeld) {
        if (up) up = false
        else log.push('leave')
      }
      backHeld = back
    },
    state: () => `${up}/${aim}/${log.length}`,
  }
}

// ── the same code on the helpers ─────────────────────────────────────────

const newPlate = () => {
  let aim = 0
  const stepper = createRowStepper()
  return {
    frame(nudge: number, rows: number): number {
      const step = stepper.take(nudge)
      if (step !== 0) aim = clampAim(aim, step, rows)
      return aim
    },
    reset(): void {
      stepper.reset()
    },
  }
}

const newAsk = (ids: readonly string[]) => {
  let aimId = ids[0] as string
  const stepper = createRowStepper()
  return (step: number): string => {
    const taken = stepper.take(step)
    if (taken !== 0) {
      const at = ids.indexOf(aimId)
      aimId = ids[clampAim(at, taken, ids.length)] ?? aimId
    }
    return aimId
  }
}

const newTv = () => {
  let up = false
  let aim = 0
  const steps = createRowStepper()
  const backEdge = createEdge()
  const log: string[] = []
  return {
    setUp(v: boolean) {
      up = v
    },
    nudge(step: number, back: boolean, rows: number): void {
      const taken = steps.take(step)
      if (up && taken !== 0) aim = clampAim(aim, taken, rows)
      if (backEdge.step(back)) {
        if (up) up = false
        else log.push('leave')
      }
    },
    state: () => `${up}/${aim}/${log.length}`,
  }
}

describe('menuStepFrom: the precedence', () => {
  it('takes the keys first, then the stick, then the D-pad', () => {
    expect(menuStepFrom(1, -1, 1, false)).toBe(-1)
    expect(menuStepFrom(0, -1, -1, false)).toBe(1)
    expect(menuStepFrom(0, 0, -1, false)).toBe(-1)
    expect(menuStepFrom(0, 0, 0, false)).toBe(0)
  })

  it('reads the stick through the deadband, and the deadband itself as still', () => {
    expect(menuStepFrom(0, 0.5, 0, false)).toBe(0)
    expect(menuStepFrom(0, -0.5, 0, false)).toBe(0)
    expect(menuStepFrom(0, -0.51, 0, false)).toBe(1)
    expect(menuStepFrom(0, 0.51, 0, false)).toBe(-1)
  })

  it('undoes invertPitch for the keys and the stick, and never touches the D-pad', () => {
    // Pulling back (negative pitch) is DOWN the list whatever the flight setting says.
    expect(menuStepFrom(0, -1, 0, true)).toBe(menuStepFrom(0, 1, 0, false))
    expect(menuStepFrom(-1, 0, 0, true)).toBe(menuStepFrom(1, 0, 0, false))
    expect(menuStepFrom(0, 0, 1, true)).toBe(1)
    expect(menuStepFrom(0, 0, -1, true)).toBe(-1)
  })

  it('lets the keys win a tie with a stick pushing the other way', () => {
    expect(menuStepFrom(-1, 1, 0, false)).toBe(1)
    expect(menuStepFrom(1, -1, 0, false)).toBe(-1)
  })

  it('matches the old inline merge, and the TV spelling of it, on every scripted frame', () => {
    let nonZero = 0
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const f of script(seed, 600)) {
        const now = menuStepFrom(f.key, f.stick, f.dpad, f.invert)
        expect(now).toBe(oldNudge(f))
        expect(now).toBe(oldTvNudge(f))
        if (now !== 0) nonZero++
      }
    }
    // The script has to MOVE something or "identical" means "both zero".
    expect(nonZero).toBeGreaterThan(300)
  })
})

describe('clampAim', () => {
  it('holds the aim inside the list at both ends', () => {
    expect(clampAim(0, -1, 9)).toBe(0)
    expect(clampAim(8, 1, 9)).toBe(8)
    expect(clampAim(3, 1, 9)).toBe(4)
    expect(clampAim(3, -1, 9)).toBe(2)
  })

  it('gives row 0 for an empty list, as the inline clamp did', () => {
    expect(clampAim(0, 1, 0)).toBe(0)
    expect(clampAim(0, -1, 0)).toBe(0)
  })
})

describe('createRowStepper', () => {
  it('steps once per push, not while held, and again after a release', () => {
    const s = createRowStepper()
    expect([1, 1, 1, 0, 1, 1, 0, 0, -1].map((n) => s.take(n))).toEqual([1, 0, 0, 0, 1, 0, 0, 0, -1])
  })

  it('does not step when the push changes direction without a release', () => {
    const s = createRowStepper()
    expect([1, -1, -1, 0, -1].map((n) => s.take(n))).toEqual([1, 0, 0, 0, -1])
  })

  it('forgets a held push on reset, so a menu opening on a held stick steps once', () => {
    const s = createRowStepper()
    expect(s.take(1)).toBe(1)
    expect(s.take(1)).toBe(0)
    s.reset()
    expect(s.take(1)).toBe(1)
  })

  it('is one latch per instance (trap 19): a second stepper does not inherit the first', () => {
    const a = createRowStepper()
    const b = createRowStepper()
    expect(a.take(1)).toBe(1)
    // `a` holds the push. `b` has never seen one.
    expect(b.take(1)).toBe(1)
    expect(a.take(1)).toBe(0)
    expect(b.take(1)).toBe(0)
  })
})

describe('the replay: old inline blocks against the helpers, selection trace for selection trace', () => {
  it('pause, lobby and title: the aim after every frame is identical', () => {
    for (const seed of [11, 12, 13, 14]) {
      for (const rows of [1, 2, 4, 9]) {
        const old = oldPlate()
        const now = newPlate()
        let moved = 0
        let last = 0
        script(seed, 800).forEach((f, i) => {
          // The pause plate re-opens: `pauseAim = 0; pauseNudgeHeld = false`.
          if (i % 97 === 96) {
            old.reset()
            now.reset()
          }
          const nudge = oldNudge(f)
          const a = old.frame(nudge, rows)
          const b = now.frame(menuStepFrom(f.key, f.stick, f.dpad, f.invert), rows)
          expect(b, `seed ${seed} rows ${rows} frame ${i}`).toBe(a)
          if (a !== last) moved++
          last = a
        })
        if (rows > 1) expect(moved).toBeGreaterThan(5)
      }
    }
  })

  it('the lap questions: the aimed row ID is identical after every frame', () => {
    const ids = ['another', 'race-lap', 'post', 'share', 'home']
    for (const seed of [21, 22, 23]) {
      const old = oldAsk(ids)
      const now = newAsk(ids)
      script(seed, 800).forEach((f, i) => {
        const nudge = oldNudge(f)
        expect(now(menuStepFrom(f.key, f.stick, f.dpad, f.invert)), `seed ${seed} frame ${i}`).toBe(
          old(nudge),
        )
      })
    }
  })

  it('TV: the aim, the plate and the leave count are identical, with the plate coming and going', () => {
    for (const seed of [31, 32, 33, 34]) {
      const rand = lcg(seed * 7)
      const old = oldTv()
      const now = newTv()
      let backs = 0
      script(seed, 900).forEach((f, i) => {
        // The plate is toggled from the menu button now and then, outside the nudge.
        if (rand() < 0.06) {
          const up = rand() < 0.5
          old.setUp(up)
          now.setUp(up)
        }
        const back = rand() < 0.2 ? true : i > 0 && rand() < 0.5
        if (back) backs++
        old.nudge(oldTvNudge(f), back, 6)
        now.nudge(menuStepFrom(f.key, f.stick, f.dpad, f.invert), back, 6)
        expect(now.state(), `seed ${seed} frame ${i}`).toBe(old.state())
      })
      expect(backs).toBeGreaterThan(100)
    }
  })
})
