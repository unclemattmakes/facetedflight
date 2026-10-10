// tests/unit/launch.test.ts — the elevator ride, against the clip that drives it.
//
// ── What this is really testing ───────────────────────────────────────────
//
// That the port reads the RIGHT SOURCE. `spawn.launchRise` used to come from
// `Mover_Lift.amplitude` — 108.5 on a component whose `move` flag is 0 and which
// nothing in the 2016 codebase ever sets, so `LiftMove()` never ran once. The
// motion is an `Animator` that starts `m_Enabled: 0` and is switched on by
// `LaunchElevator.StartLaunch()`, playing `elevator_up.anim`.
//
// The two agree to within two metres, which is exactly why it survived: 108.5
// against the clip's 106.647 looks like rounding if you are not looking.
//
// The tie-breaker is the ghosts. They are recordings of actual 2016 flights and
// they begin at the moment of release, so where they start IS where the elevator
// lets go — and that is an oracle no amount of reading YAML can argue with.

import { describe, expect, it } from 'vitest'
import { FIXED_DT } from '@/sim/constants'
import {
  countdownNumber,
  createLaunch,
  launchHoldsShip,
  resetLaunch,
  startLaunch,
  stepLaunch,
  topRise,
} from '@/sim/launch'
import int01 from '../../content/levels/int_01_hoverJet.json'

const LAUNCH = int01.spawn.launch as {
  keys: { time: number; value: number; inSlope: number; outSlope: number }[]
  rise: number
  duration: number
  settledAtSeconds: number
  releaseAtSeconds: number
}

const COUNTDOWN = int01.timer.countdown as {
  shipped: boolean
  /** `Timer_Race.useCountdown`, which is 0 on all thirteen and gates only `OnEnable`. */
  useCountdownFlag: boolean
  /** A live `Trigger_EnableShip` calling the public `StartCountdown()`. DEV-048. */
  startedByTrigger: boolean
  steps: number
  stepSeconds: number
  seconds: number
}

/**
 * The ride as 2016 ran it. `skipRide: false` on purpose — everything below this
 * line is a statement about the shipped elevator, and DEV-024 cut it from FF2's
 * default without deleting a line of it. If the ride ever comes back, these are
 * the tests that say it still works.
 */
const spec = {
  keys: LAUNCH.keys,
  releaseAtSeconds: LAUNCH.releaseAtSeconds,
  countdownSteps: COUNTDOWN.steps,
  countdownStepSeconds: COUNTDOWN.stepSeconds,
  skipRide: false,
}

/** Ride to the top. Stops the moment the platform stops rising. */
const ride = () => {
  const state = createLaunch(spec)
  startLaunch(state, spec)
  const heights: { t: number; rise: number }[] = []
  for (let i = 0; i < 4000 && state.phase === 'rising'; i++) {
    stepLaunch(state, spec, FIXED_DT)
    heights.push({ t: state.elapsed, rise: state.rise })
  }
  return { state, heights }
}

/** Ride AND count down, to the tick the ship is let go. */
const wholeSequence = () => {
  const state = createLaunch(spec)
  startLaunch(state, spec)
  const numbers: (number | null)[] = []
  let releases = 0
  let total = 0
  for (let i = 0; i < 6000 && state.phase !== 'flying'; i++) {
    total += FIXED_DT
    if (stepLaunch(state, spec, FIXED_DT)) releases++
    numbers.push(countdownNumber(state, spec))
  }
  return { state, numbers, releases, total }
}

describe('the clip the extractor read', () => {
  it('is elevator_up.anim, not the dead Mover_Lift beside it', () => {
    expect(int01.spawn.launchKind).toBe('elevator')
    expect((int01.spawn.launch as { clip: string }).clip).toMatch(/elevator_up\.anim$/)
    // The dead component is still in the sheet as evidence, and it must NOT be
    // the number in use. If these ever become equal, someone has quietly gone
    // back to the wrong source.
    expect(int01.spawn.deadMoverLiftAmplitude).toBe(108.5)
    expect(LAUNCH.rise).not.toBeCloseTo(int01.spawn.deadMoverLiftAmplitude as number, 1)
  })

  it('lands the ship where the 2016 ghosts start', () => {
    // THE ARGUMENT. Two independent sources: an animation curve authored in
    // 2015, and two flights recorded by a human in 2016. The spawn marker plus
    // the clip's rise has to equal where those recordings begin.
    //
    // The bound is 60 cm rather than 20 because THE TWO GHOSTS DISAGREE WITH
    // EACH OTHER by 65 cm — they are `leftSpawn` and `rightSpawn`, two markers
    // at different places on the same platform, so neither is "the" release
    // height and the spread is the platform's own width, not our error:
    //
    //   elevator_up.anim  ->  126.435
    //   leftSpawn  ghost      126.286   (+0.149)
    //   rightSpawn ghost      126.934   (-0.499)
    const release = (int01.spawn.pos[1] as number) + LAUNCH.rise
    for (const ghost of int01.ghosts) {
      expect(Math.abs(release - (ghost.spawn[1] as number)), ghost.clip).toBeLessThan(0.6)
    }
    // And the dead component does NOT land there, on EITHER ghost — which is
    // what makes this a discriminating test rather than a tautology. 108.5 puts
    // the release at 128.29, outside the platform's own spread.
    const wrong = (int01.spawn.pos[1] as number) + (int01.spawn.deadMoverLiftAmplitude as number)
    for (const ghost of int01.ghosts) {
      expect(Math.abs(wrong - (ghost.spawn[1] as number)), ghost.clip).toBeGreaterThan(1.3)
    }
  })

  it('starts the ship deep underwater, which is the point of the ride', () => {
    // 19.79 m, ~95 m below the sea and well inside the 164 m fog plane. If this
    // ever stops being true the elevator has become decoration.
    expect(int01.spawn.pos[1] as number).toBeLessThan(int01.fog.height)
    expect((int01.spawn.pos[1] as number) + LAUNCH.rise).toBeGreaterThan(int01.fog.height - 40)
  })
})

describe('the ride', () => {
  it('holds still for the first 0.6 s, because both opening keys are zero', () => {
    // The beat between pressing and moving. A lerp between key 0 and key 2 would
    // start creeping immediately and lose it.
    const state = createLaunch(spec)
    startLaunch(state, spec)
    stepLaunch(state, spec, 0.5)
    expect(state.rise).toBeCloseTo(0, 6)
    stepLaunch(state, spec, 0.2) // now at 0.7 s
    expect(state.rise).toBeGreaterThan(0)
  })

  it('climbs without reversing, then settles onto the top from 13 cm above it', () => {
    // Cubic Hermite CAN overshoot between keys — that is exactly what separates
    // it from a lerp — and here it does. Between the key at 13.17 s (slope 2.03
    // m/s) and the one at 13.97 s (slope 0.03) the curve peaks at 106.7795 m at
    // t = 13.492, which is **13.25 cm above** the final 106.647, then eases back
    // down onto it.
    //
    // That is NOT a bug and it is deliberately not tuned away: Unity's
    // `AnimationCurve` does the same arithmetic on the same keys, so
    // reproducing it IS the job. At ~2 m/s it reads as the platform settling,
    // which is presumably what the animator wanted.
    //
    // What is worth pinning is the SIZE. A real fault in the evaluator — a
    // mis-signed tangent, an interval width off by one key — shows up as metres
    // and a ship visibly popping off the platform.
    const { heights } = ride()

    // The ascent proper never reverses.
    let previous = -1
    for (const { t, rise } of heights) {
      if (t > 13.4) break
      expect(rise, `t=${t.toFixed(3)}`).toBeGreaterThanOrEqual(previous - 1e-6)
      previous = rise
    }

    const peak = Math.max(...heights.map((h) => h.rise))
    const overshoot = peak - LAUNCH.rise
    expect(overshoot).toBeGreaterThan(0.05)
    expect(overshoot).toBeLessThan(0.25)

    // And it is back on the mark well before release — within a centimetre from
    // the settle key onward. An explicit bound rather than `toBeCloseTo(_, 2)`,
    // which is 0.005 and which the tail of the ease clears by 20 microns.
    const settled = heights.filter((h) => h.t >= LAUNCH.settledAtSeconds)
    expect(settled.length).toBeGreaterThan(50)
    for (const h of settled) {
      expect(Math.abs(h.rise - LAUNCH.rise), `t=${h.t.toFixed(3)}`).toBeLessThan(0.01)
    }
  })

  it('arrives at the top at the end of the clip, and starts counting', () => {
    const { state } = ride()
    expect(state.phase).toBe('countdown')
    expect(state.rise).toBeCloseTo(LAUNCH.rise, 3)
    expect(state.elapsed).toBeGreaterThanOrEqual(LAUNCH.releaseAtSeconds)
    expect(state.elapsed - LAUNCH.releaseAtSeconds).toBeLessThan(FIXED_DT)
  })

  it('is already at full height before release, and holds there', () => {
    // The clip arrives at 13.97 s and the release is at 15.47 s, so there is a
    // 1.5 s hold at the top. That gap is real and it is where `FinishLaunch()`
    // would have been called if we could find its caller — see the extractor.
    const state = createLaunch(spec)
    startLaunch(state, spec)
    stepLaunch(state, spec, LAUNCH.settledAtSeconds)
    expect(state.rise).toBeCloseTo(LAUNCH.rise, 2)
    expect(state.phase).toBe('rising')
  })

  it('takes about a quarter of a minute, which the timer has to survive', () => {
    const { total } = wholeSequence()
    // The ride is 15.47 s and the countdown adds 4, so the whole opening is
    // about twenty seconds before you have control.
    expect(total).toBeGreaterThan(19)
    expect(total).toBeLessThan(20)
    // The mission's own time limit dwarfs it, so starting the clock at RELEASE
    // rather than at load is a real difference and not a rounding one: twenty
    // seconds off a 180 s limit is an entire medal tier.
    expect(total).toBeGreaterThan(int01.timer.timeLimit * 0.05)
  })
})

describe('the state machine', () => {
  it('does nothing until it is started', () => {
    const state = createLaunch(spec)
    expect(state.phase).toBe('waiting')
    expect(stepLaunch(state, spec, 1)).toBe(false)
    expect(state.rise).toBe(0)
    expect(state.elapsed).toBe(0)
  })

  it('ignores a second start, because the button is held', () => {
    // `Input_Ship` polls the button every frame and guards with `gameReady`
    // (Input_Ship.cs:382). Without the same guard here, holding the button drops
    // the platform back to the bottom on every frame.
    const state = createLaunch(spec)
    startLaunch(state, spec)
    stepLaunch(state, spec, 5)
    const partway = state.rise
    expect(partway).toBeGreaterThan(0)
    startLaunch(state, spec)
    expect(state.rise).toBe(partway)
    expect(state.elapsed).toBeCloseTo(5, 6)
  })

  it('reports release EXACTLY once', () => {
    // The caller starts the mission clock and the ghosts on this signal. Twice
    // would restart them mid-run; never would leave the race unstarted.
    const state = createLaunch(spec)
    startLaunch(state, spec)
    let count = 0
    for (let i = 0; i < 4000; i++) if (stepLaunch(state, spec, FIXED_DT)) count++
    expect(count).toBe(1)
  })

  it('holds the ship through the ride AND the countdown, and not after', () => {
    const state = createLaunch(spec)
    expect(launchHoldsShip(state)).toBe(true)
    startLaunch(state, spec)
    expect(launchHoldsShip(state)).toBe(true)
    stepLaunch(state, spec, LAUNCH.releaseAtSeconds)
    expect(state.phase).toBe('countdown')
    expect(launchHoldsShip(state), 'still held while counting').toBe(true)
    stepLaunch(state, spec, COUNTDOWN.seconds)
    expect(state.phase).toBe('flying')
    expect(launchHoldsShip(state)).toBe(false)
  })

  it('lands at the top even if a single step skips the whole clip', () => {
    // A tab that was backgrounded, or a first frame with a huge delta. The ship
    // must end up at the release height, not somewhere off the end of the curve.
    const state = createLaunch(spec)
    startLaunch(state, spec)
    expect(stepLaunch(state, spec, 999)).toBe(true)
    expect(state.rise).toBeCloseTo(LAUNCH.rise, 6)
    expect(state.phase).toBe('flying')
  })

  it('spends an overshooting step on the countdown instead of dropping it', () => {
    // A step that lands past the top carries time with it. Throwing that away
    // would make the countdown quietly longer on a slow frame, which on a four
    // second countdown is the difference between racing the ghosts and
    // conceding to them.
    const state = createLaunch(spec)
    startLaunch(state, spec)
    stepLaunch(state, spec, LAUNCH.releaseAtSeconds + 0.4)
    expect(state.phase).toBe('countdown')
    expect(state.countdownElapsed).toBeCloseTo(0.4, 6)
  })
})

describe('the race countdown', () => {
  // -- It is a PORT after all, which is DEV-048 ---------------------------------
  //
  // This block used to say the countdown was a feature FF2 invented: `Timer_Race`
  // is fully built and tuned in 2016 and `useCountdown` is **0 on all thirteen
  // shipped missions**, so DEV-015 turned it on as a deviation.
  //
  // `useCountdown` gates exactly one caller, `Timer_Race.OnEnable`.
  // `StartCountdown()` is public, and `Trigger_EnableShip.DelayedEnable()` calls
  // it after its own `delay` without ever looking at the flag —
  // `int_01_hoverJet` wires that up with `delay: 2`. So 2016 really did count
  // down, on six of the seven HoverJet missions, and the race clock starts at
  // the end of that same coroutine. `level.timer.countdown` now carries the flag
  // and the behaviour as separate fields with `shipped` derived from them,
  // because the whole finding is that the two disagree.
  //
  // The TIMING was never in doubt. `countdownTime` and `delayBetweenCountdown`
  // are read off the shipped component, and note the latter is 1 rather than the
  // C# initialiser's 0.5 -- so the cardinal rule earns its keep either way.

  it('takes its numbers from the shipped component, which really did run it', () => {
    // `int_01_hoverJet` is one of the six: the flag is off and the trigger
    // starts it anyway. Both halves are asserted, because "shipped: true" alone
    // would read as the flag having been 1.
    expect(COUNTDOWN.useCountdownFlag, 'Timer_Race.useCountdown was 0 in 2016').toBe(false)
    expect(COUNTDOWN.startedByTrigger, 'Trigger_EnableShip calls StartCountdown()').toBe(true)
    expect(COUNTDOWN.shipped, 'so a countdown does happen').toBe(true)
    expect(COUNTDOWN.steps).toBe(3)
    expect(COUNTDOWN.stepSeconds).toBe(1)
    // (steps + 1) beats, because `Timer_Race.Countdown()` fires GO on the beat
    // AFTER the last number. Four, not three.
    expect(COUNTDOWN.seconds).toBe(4)
  })

  it('counts 3, 2, 1, GO -- one beat each, in that order', () => {
    const { numbers } = wholeSequence()
    const shown = numbers.filter((n): n is number => n !== null)
    const sequence: number[] = []
    for (const n of shown) if (sequence[sequence.length - 1] !== n) sequence.push(n)
    expect(sequence).toEqual([3, 2, 1, 0])
  })

  it('holds each number for its full beat', () => {
    const state = createLaunch(spec)
    startLaunch(state, spec)
    stepLaunch(state, spec, LAUNCH.releaseAtSeconds)
    expect(countdownNumber(state, spec)).toBe(3)
    stepLaunch(state, spec, COUNTDOWN.stepSeconds * 0.99)
    expect(countdownNumber(state, spec), 'still 3 just before the beat').toBe(3)
    stepLaunch(state, spec, COUNTDOWN.stepSeconds * 0.02)
    expect(countdownNumber(state, spec), '2 just after it').toBe(2)
  })

  it('shows nothing before the ride and nothing after GO', () => {
    const state = createLaunch(spec)
    expect(countdownNumber(state, spec), 'waiting').toBeNull()
    startLaunch(state, spec)
    stepLaunch(state, spec, 1)
    expect(countdownNumber(state, spec), 'rising').toBeNull()
    stepLaunch(state, spec, 999)
    expect(state.phase).toBe('flying')
    expect(countdownNumber(state, spec), 'flying').toBeNull()
  })

  it('releases exactly (steps + 1) beats after the top, on the fixed step', () => {
    const { state, releases, total } = wholeSequence()
    expect(state.phase).toBe('flying')
    expect(releases).toBe(1)
    const expected = LAUNCH.releaseAtSeconds + COUNTDOWN.seconds
    expect(total).toBeGreaterThanOrEqual(expected)
    expect(total - expected).toBeLessThan(FIXED_DT)
  })

  it('degenerates to an immediate release when there are no steps', () => {
    // A mission that wants no countdown sets steps to 0 and must not then wait a
    // beat for nothing.
    const none = { ...spec, countdownSteps: 0, countdownStepSeconds: 0 }
    const state = createLaunch(spec)
    startLaunch(state, spec)
    expect(stepLaunch(state, spec, LAUNCH.releaseAtSeconds)).toBe(false)
    const immediate = createLaunch(spec)
    startLaunch(immediate, spec)
    expect(stepLaunch(immediate, none, LAUNCH.releaseAtSeconds)).toBe(true)
    expect(immediate.phase).toBe('flying')
  })

  it('holds the ship for every tick of the countdown', () => {
    // The whole reason release is a single signal. The ghosts are recordings
    // that begin at the moment 2016 let go, so starting them any earlier hands
    // them a lead the player cannot see.
    const { state, numbers } = wholeSequence()
    expect(state.phase).toBe('flying')
    expect(numbers[numbers.length - 1]).toBeNull()
    expect(numbers.filter((n) => n === 0).length).toBeGreaterThan(50)
  })
})

// ── DEV-024: the platform starts at the top ──────────────────────────────
//
// Matt: *"when i start, the platform floats up and then the ship floats up. plz
// make it so the platform starts at the top position... we cut the elevator ride
// for this version."*
//
// A cut, not a correction. `LaunchElevator` is live in the shipped
// `int_01_hoverJet.unity` — `m_Enabled: 1`, GameObject active, and every node up
// the chain active — so 2016 really did ride the lift for 15.5 s. This is one
// flag, and `?ride=1` puts it back.
describe('skipRide', () => {
  const skipped = { ...spec, skipRide: true }

  it('has the platform at the top BEFORE the button is pressed', () => {
    // The ship is parented to the platform and held there, so "at the top" has
    // to be true from the first frame rather than from the first press. This is
    // the actual bug Matt saw: the platform rose, and the ship rose after it.
    const state = createLaunch(skipped)
    expect(state.phase).toBe('waiting')
    expect(state.rise).toBeCloseTo(LAUNCH.rise, 4)
    expect(topRise(skipped)).toBeCloseTo(LAUNCH.rise, 4)
  })

  it('still starts at the BOTTOM when the ride is on', () => {
    expect(createLaunch(spec).rise).toBe(0)
    expect(createLaunch(null).rise).toBe(0)
  })

  it('goes straight to the countdown, skipping the ride entirely', () => {
    const state = createLaunch(skipped)
    startLaunch(state, skipped)
    expect(state.phase).toBe('countdown')
    expect(state.rise).toBeCloseTo(LAUNCH.rise, 4)
  })

  it('still runs a full 3-2-1-GO, and releases on the same tick it always did', () => {
    // The countdown is 2016's own (DEV-048, superseding DEV-015) and it is not
    // what was cut. Cutting the ride must not quietly cut the beats with it.
    const state = createLaunch(skipped)
    startLaunch(state, skipped)
    const total = (COUNTDOWN.steps + 1) * COUNTDOWN.stepSeconds
    let released = false
    let t = 0
    for (let i = 0; i < 4000 && !released; i++) {
      released = stepLaunch(state, skipped, FIXED_DT)
      t += FIXED_DT
    }
    expect(released).toBe(true)
    expect(t).toBeGreaterThanOrEqual(total)
    expect(t).toBeLessThan(total + FIXED_DT * 2)
    expect(state.phase).toBe('flying')
    // And it never dropped: the platform held the top the whole way down.
    expect(state.rise).toBeCloseTo(LAUNCH.rise, 4)
  })

  it('saves the ride time, which is the point', () => {
    // 15.5 s of animation against a 180 s medal limit is an entire tier.
    expect(LAUNCH.releaseAtSeconds).toBeGreaterThan(15)
  })

  it('is still idempotent, because the button is held for many frames', () => {
    const state = createLaunch(skipped)
    startLaunch(state, skipped)
    stepLaunch(state, skipped, FIXED_DT)
    const elapsed = state.countdownElapsed
    startLaunch(state, skipped)
    expect(state.countdownElapsed).toBe(elapsed)
    expect(state.phase).toBe('countdown')
  })
})

// ── DEV-159: a mission with NO elevator has already started ──────────────

describe('a course with no launch rig', () => {
  // The six JumpSeat courses author none. Nothing will ever move their phase,
  // because `stepLaunch` is only reached through `if (rideSpec && ...)` — so
  // whatever `createLaunch`/`resetLaunch` leave is what that mission has for
  // ever. `boot/app.ts` carried `if (!launchSpec) launch.phase = 'flying'`
  // beside two of the three entry points and NOT beside `resetLaunch`, which
  // every restart goes through.

  it('is flying from the first frame, not held on a pad', () => {
    expect(launchHoldsShip(createLaunch(null))).toBe(false)
    expect(createLaunch(null).phase).toBe('flying')
  })

  it('is STILL flying after a restart — the half nobody wrote down', () => {
    // The regression, stated as the sequence that produced it: fly, restart,
    // and the run that comes back must be under way. Before this it came back
    // `waiting`, which froze the cockpit shake and the speed lens for the rest
    // of the session and would have hidden the next-gate arrow with them.
    const state = createLaunch(null)
    resetLaunch(state, null)
    expect(state.phase).toBe('flying')
    expect(launchHoldsShip(state)).toBe(false)
  })

  it('and a course that HAS a rig is still held until it lets go', () => {
    // The counter-case, kept loud: the rule must be about the spec, not about
    // "everything starts flying now".
    const state = createLaunch(spec)
    expect(launchHoldsShip(state)).toBe(true)
    resetLaunch(state, spec)
    expect(state.phase).toBe('waiting')
    expect(launchHoldsShip(state)).toBe(true)
  })
})
