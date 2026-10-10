// tests/unit/fade.test.ts — the transition schedule.
//
// The two things worth guarding here are both places where a plausible
// implementation is wrong in a way nobody would see for months:
//
//   1. **The ramp finishes at 0.85, not at 1.0.** 2016's `Fade_Mesh.Fade()`
//      clamps `fadeValue > 0.85` to 1, so a 1 s fade is solid after 850 ms. An
//      implementation that runs the whole duration looks identical in a
//      screenshot and is 15% slower to black in the hand. The number is
//      imported from the sheet rather than typed (DEV-069: "when you implement
//      something the sheet has a key for, import the key and assert against
//      it") — so the assertions below are about the RELATIONSHIP between the
//      ramp and `SOLID_AT`, not about 0.85.
//
//   2. **`'released'` must not need a promise.** A backgrounded tab stops
//      `setAnimationLoop`, so anything awaiting "the screen is black now" waits
//      for ever with the world half torn down. The hold is a flag consumed by
//      `update()`, and the test for that is that `release()` before the screen
//      is black does not skip the black.

import { describe, expect, it } from 'vitest'
import { FADE } from '@/generated/constants.generated'
import {
  CAMERA_SWITCH_BLACK_SECONDS,
  CUT_FADE_SECONDS,
  createFade,
  type FadeScreen,
  type FadeSpec,
  fadeRamp,
  KILL_FADE_SECONDS,
  LOAD_FADE_SECONDS,
  MENU_FADE_SECONDS,
  SOLID_AT,
  screenMoveFade,
} from '@/render/fade'
import { loadLevelJson, MISSIONS } from './helpers/terrain-field'

const FRAME = 1 / 60

/** Run `seconds` of frames and return the amount at the end. */
const run = (fade: ReturnType<typeof createFade>, seconds: number): number => {
  const steps = Math.round(seconds / FRAME)
  for (let i = 0; i < steps; i++) fade.update(FRAME)
  return fade.amount
}

const CUT: FadeSpec = {
  outSeconds: CUT_FADE_SECONDS,
  inSeconds: CUT_FADE_SECONDS,
  holdSeconds: 0,
}

describe('the ramp is 2016s, clamp included', () => {
  it('reaches solid EARLY, at SOLID_AT of the duration', () => {
    expect(fadeRamp(SOLID_AT, 1)).toBeCloseTo(1, 6)
    // And it is genuinely early — a ramp that finishes at the end would fail
    // this, which is the whole point of the assertion.
    expect(SOLID_AT).toBeLessThan(1)
    expect(fadeRamp(SOLID_AT * 0.999, 1)).toBeLessThan(1)
  })

  it('holds solid for the remainder rather than overshooting', () => {
    expect(fadeRamp(1, 1)).toBe(1)
    expect(fadeRamp(10, 1)).toBe(1)
  })

  it('is linear up to the clamp', () => {
    // Half of the way to the clamp is half of the way to black.
    expect(fadeRamp(SOLID_AT / 2, 1)).toBeCloseTo(0.5, 6)
  })

  it('treats a zero duration as instant rather than dividing by zero', () => {
    expect(fadeRamp(0, 0)).toBe(1)
    expect(Number.isFinite(fadeRamp(0, 0))).toBe(true)
  })
})

describe('the durations, and which of them is ours', () => {
  it('spends 2016s own number where a real load is covered', () => {
    // Imported from the sheet, not typed. If the extractor ever stops emitting
    // it this is a type error rather than a silent literal.
    expect(LOAD_FADE_SECONDS).toBeGreaterThan(0)
  })

  it('spends a SHORTER one on a transition that is a variable assignment', () => {
    // The deviation, stated as a relationship: whatever the two numbers are, a
    // cut must never cost more than a load. A change that made them equal would
    // be re-adopting 2016's choreography for a change that has no load in it.
    expect(CUT_FADE_SECONDS).toBeLessThan(LOAD_FADE_SECONDS)
  })
})

describe('DEV-427: a move between screens takes 2016s own fade, per leg', () => {
  // Matt did not see the moves fade. They did — `tests/e2e/move-fades.spec.ts`
  // measured every one reaching black — over `CUT_FADE_SECONDS`, about 0.3 s to
  // black. 2016's `LevelLoader` fades out over the LEAVING scene's fader and
  // the next scene fades in over its own: the menus' rig and the missions' rig,
  // both on the sheet. Asserted against the SHEET, not against this module's
  // own aliases, so a rule that re-derived its answer the way the code does
  // would not pass by construction (trap 24).
  const MENU = FADE.menuSeconds
  const MISSION = FADE.missionSeconds

  it('title to hangar is the menu rig both ways', () => {
    expect(screenMoveFade('title', 'menu')).toEqual({ outSeconds: MENU, inSeconds: MENU })
  })

  it('hangar to mission leaves on the menu rig and arrives on the mission rig', () => {
    expect(screenMoveFade('menu', 'mission')).toEqual({ outSeconds: MENU, inSeconds: MISSION })
  })

  it('mission to hangar leaves on the mission rig and arrives on the menu rig', () => {
    expect(screenMoveFade('mission', 'menu')).toEqual({ outSeconds: MISSION, inSeconds: MENU })
  })

  it('the loading scene lives in the menu, so its legs are the menu rig', () => {
    expect(screenMoveFade('menu', 'menu')).toEqual({ outSeconds: MENU, inSeconds: MENU })
  })

  it('no leg of any move spends the port’s cut any more', () => {
    // The defect, stated as the relationship it broke: every move was spending
    // a number shorter than either of 2016's.
    const screens: readonly FadeScreen[] = ['title', 'menu', 'mission']
    for (const from of screens) {
      for (const to of screens) {
        const move = screenMoveFade(from, to)
        expect(move.outSeconds, `${from} -> ${to} out`).toBeGreaterThan(CUT_FADE_SECONDS)
        expect(move.inSeconds, `${from} -> ${to} in`).toBeGreaterThan(CUT_FADE_SECONDS)
      }
    }
    expect(MENU_FADE_SECONDS).toBe(MENU)
  })
})

describe('DEV-427: the camera switch HOLDS its black, as CamChanger does', () => {
  // `CamChanger.ChangeCam()`: fade out over 0.12 s, `WaitForSeconds(0.2f)` from
  // THAT trigger, then fade in over 0.25 s. The port came back on the first
  // black frame. Run through the real state machine at a fine step and read
  // the clock the fade-in starts on: it must be the sheet's wait, measured from
  // the trigger — not the out leg plus a frame.
  const STEP = 1 / 2000
  const SWITCH: FadeSpec = {
    outSeconds: FADE.cameraSwitchOutSeconds,
    inSeconds: FADE.cameraSwitchInSeconds,
    holdSeconds: CAMERA_SWITCH_BLACK_SECONDS,
  }

  const schedule = () => {
    const fade = createFade()
    fade.begin(SWITCH)
    let t = 0
    let blackAt = Number.NaN
    let inAt = Number.NaN
    let clearAt = Number.NaN
    for (let i = 0; i < 4000 && Number.isNaN(clearAt); i++) {
      fade.update(STEP)
      t += STEP
      if (Number.isNaN(blackAt) && fade.black) {
        blackAt = t
        // `boot/app.ts` swaps the view and calls `release()` on the first black
        // frame. A timed hold must not be cut short by it.
        fade.release()
      }
      if (Number.isNaN(inAt) && fade.phase === 'in') inAt = t
      if (!Number.isNaN(inAt) && fade.phase === 'idle') clearAt = t
    }
    return { blackAt, inAt, clearAt }
  }

  it('starts coming back at 2016s wait after the trigger, not a frame after black', () => {
    const { blackAt, inAt } = schedule()
    expect(blackAt).toBeCloseTo(FADE.cameraSwitchOutSeconds * SOLID_AT, 2)
    expect(inAt).toBeCloseTo(FADE.cameraSwitchHoldSeconds, 2)
    expect(inAt - blackAt, 'solid black for most of a tenth of a second').toBeGreaterThan(0.05)
  })

  it('is clear again one in-leg after that', () => {
    const { inAt, clearAt } = schedule()
    expect(clearAt - inAt).toBeCloseTo(FADE.cameraSwitchInSeconds * SOLID_AT, 2)
  })

  it('spends a hold shorter than the wait, because the out leg is inside it', () => {
    expect(CAMERA_SWITCH_BLACK_SECONDS).toBeGreaterThan(0)
    expect(CAMERA_SWITCH_BLACK_SECONDS).toBeLessThan(FADE.cameraSwitchHoldSeconds)
  })
})

describe('a plain cut: out, nothing, back', () => {
  it('starts clear and ends clear', () => {
    const fade = createFade()
    expect(fade.amount).toBe(0)
    expect(fade.busy).toBe(false)
    fade.begin(CUT)
    expect(fade.busy).toBe(true)
    run(fade, CUT_FADE_SECONDS * 2 + 0.1)
    expect(fade.amount).toBe(0)
    expect(fade.phase).toBe('idle')
    expect(fade.busy).toBe(false)
  })

  it('is solid black in the middle, and says so', () => {
    const fade = createFade()
    fade.begin(CUT)
    run(fade, CUT_FADE_SECONDS * SOLID_AT + FRAME)
    expect(fade.amount).toBe(1)
    expect(fade.black).toBe(true)
  })

  it('never leaves the 0..1 range, on any frame', () => {
    const fade = createFade()
    fade.begin(CUT)
    for (let i = 0; i < 200; i++) {
      fade.update(FRAME)
      expect(fade.amount).toBeGreaterThanOrEqual(0)
      expect(fade.amount).toBeLessThanOrEqual(1)
    }
  })

  it('survives a zero and a negative frame delta', () => {
    // `setAnimationLoop` after a stall, and a clock that went backwards.
    const fade = createFade()
    fade.begin(CUT)
    fade.update(0)
    fade.update(-1)
    expect(fade.amount).toBe(0)
    expect(fade.phase).toBe('out')
  })
})

describe('a real load: hold until released', () => {
  const LOAD: FadeSpec = {
    outSeconds: CUT_FADE_SECONDS,
    inSeconds: LOAD_FADE_SECONDS,
    holdSeconds: 'released',
  }

  it('waits at black indefinitely', () => {
    const fade = createFade()
    fade.begin(LOAD)
    run(fade, 30)
    expect(fade.amount).toBe(1)
    expect(fade.phase).toBe('hold')
  })

  it('comes back only after release', () => {
    const fade = createFade()
    fade.begin(LOAD)
    run(fade, 5)
    fade.release()
    run(fade, LOAD_FADE_SECONDS + 0.1)
    expect(fade.amount).toBe(0)
    expect(fade.phase).toBe('idle')
  })

  it('does not SKIP the black when the work finishes before the fade-out does', () => {
    // The case a promise-based design gets wrong: a warm swap can land before
    // 0.35 s is up, and the screen must still have gone black or the cut it
    // exists to hide happens in plain view.
    const fade = createFade()
    fade.begin(LOAD)
    fade.release() // instantly: the level was already in cache
    run(fade, CUT_FADE_SECONDS * SOLID_AT * 0.5)
    expect(fade.amount).toBeLessThan(1)
    expect(fade.phase).toBe('out')
    run(fade, CUT_FADE_SECONDS)
    // It passed THROUGH black rather than around it.
    expect(fade.phase).toBe('in')
  })

  it('does nothing at all while no frames are delivered', () => {
    // A hidden tab. Nothing advances, nothing resolves, nothing is stuck.
    const fade = createFade()
    fade.begin(LOAD)
    fade.release()
    expect(fade.amount).toBe(0)
    expect(fade.phase).toBe('out')
  })
})

describe('the boot handover, and interruptions', () => {
  it('blackOut starts solid and waits', () => {
    // L4: the first frame a visitor sees is a finished one. The canvas is black
    // from boot and released when the world is ready.
    const fade = createFade()
    fade.blackOut()
    expect(fade.amount).toBe(1)
    expect(fade.black).toBe(true)
    run(fade, 10)
    expect(fade.amount).toBe(1)
    fade.release()
    run(fade, CUT_FADE_SECONDS + 0.1)
    expect(fade.amount).toBe(0)
  })

  it('a second begin does not brighten the screen first', () => {
    // Press EXIT, then press it again. Restarting the fade from 0 would flash
    // the room back at you on the way to black.
    const fade = createFade()
    fade.begin(CUT)
    run(fade, CUT_FADE_SECONDS * SOLID_AT * 0.6)
    const mid = fade.amount
    expect(mid).toBeGreaterThan(0)
    fade.begin(CUT)
    fade.update(FRAME)
    expect(fade.amount).toBeGreaterThanOrEqual(mid)
  })

  it('an out of 0 from a black screen holds rather than re-fading', () => {
    const fade = createFade()
    fade.blackOut()
    fade.begin({ outSeconds: 0, inSeconds: CUT_FADE_SECONDS, holdSeconds: 'released' })
    fade.update(FRAME)
    expect(fade.phase).toBe('hold')
    expect(fade.amount).toBe(1)
  })
})

describe('the death, which is a snap and then a wait', () => {
  /**
   * 2016's shape, end to end: `Trigger_Kill.RestartLevel()` overrides the
   * fader to `fadeTime = 0.1` and triggers it, `DelayedReload()` waits 2.5 s,
   * the scene reloads, and `LoadLevelArt` fades the new one in at the fresh
   * rig's own 1.0 s.
   *
   * The port runs the middle leg on the SIM's clock — `sim/boundary.ts` has
   * been counting that 2.5 s as its `dying` phase since long before there was a
   * curtain — so the fade is given `'released'` rather than a number, and
   * `boot/app.ts` releases it off the phase. These tests are about the two legs
   * either side of that hold, and about the relationship that makes the hold
   * safe.
   */
  const DEATH: FadeSpec = {
    outSeconds: KILL_FADE_SECONDS,
    inSeconds: LOAD_FADE_SECONDS,
    holdSeconds: 'released',
  }

  it('is solid FAR inside the hold the sim runs', () => {
    // The one that matters. The sim moves the ship at the end of the hold; if
    // the snap had not landed by then the respawn would happen in plain view,
    // which is the whole thing the curtain exists to hide. Asserted as a
    // relationship between the two extracted numbers, not as 0.085 < 2.5.
    const fade = createFade()
    fade.begin(DEATH)
    run(fade, FADE.respawnHoldSeconds / 10)
    expect(fade.black, 'black within a tenth of the hold').toBe(true)
  })

  it('comes back SLOWER than it went', () => {
    // A death snaps and a respawn eases. Backwards would read as a stutter,
    // which is the thing `boundary.ts`'s own header says the 2.5 s exists to
    // avoid — and it is exactly what a single duration for both legs would give.
    expect(KILL_FADE_SECONDS).toBeLessThan(LOAD_FADE_SECONDS)
  })

  it('holds until the sim says so, however long that is', () => {
    const fade = createFade()
    fade.begin(DEATH)
    run(fade, FADE.respawnHoldSeconds * 4)
    expect(fade.phase, 'still waiting on the sim').toBe('hold')
    fade.release()
    run(fade, LOAD_FADE_SECONDS + 0.1)
    expect(fade.amount).toBe(0)
  })
})

describe('the two generated trees agree about the hold', () => {
  it("every mission's resetFadeSeconds is the sheet's number", () => {
    // `content/levels/*.json` and `constants.generated.json` are produced by
    // two different tools from the same Unity project, and until this session
    // the level extractor carried a hand-typed `2.5` with its provenance in a
    // comment — hard rule 3's smell, and the kind of number that gets built on
    // and never re-derived (DEV-027). It reads the sheet now; this is the guard
    // that says it still does.
    for (const id of MISSIONS) {
      const level = loadLevelJson(id)
      expect(level.boundary.resetFadeSeconds, id).toBe(FADE.respawnHoldSeconds)
    }
  })
})
