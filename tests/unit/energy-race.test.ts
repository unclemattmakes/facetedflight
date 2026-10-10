// tests/unit/energy-race.test.ts — DEV-144, the tank as a clock.
//
// ── The test that matters is the last one ─────────────────────────────────
//
// A survival mode that cannot be survived is not a mode, and this project has
// shipped that exact bug twice: `adv_01_jumpSeat` and `adv_02_jumpSeat` were
// unwinnable for months behind a 180 s clock 2016 does not enforce (DEV-056),
// and `int_01_jumpSeat` reset every 15.5 s for ever (DEV-074). Both were
// invisible to unit tests that only exercised the mechanism.
//
// So the guard here is not "does the tank drain at the rate I set it to". It is
// **replay the two 2016 ghost recordings' real gate times through the tank and
// see who lives** — a measurement against something outside the port, on the
// only two recordings of the shipped game this repo has.
//
// The control that makes it mean anything is the last assertion: at the sheet's
// RAW drain (`drainScale` 1, i.e. `engineBurnrate` straight) both pilots die.
// Without it the replay would pass for a tank that never empties.

import { describe, expect, it } from 'vitest'
import { HOVERJET } from '@/generated/constants.generated'
import { FIXED_DT } from '@/sim/constants'
import {
  createEnergyRace,
  energyRaceFraction,
  energyRaceSpec,
  payGate,
  secondsOfFlight,
  stepEnergyRace,
} from '@/sim/energy-race'
import anniversary from '../../content/editions/anniversary.json'
import ghostFast from '../../content/ghosts/int_01_leftSpawn_fast_01.json'
import ghostSlow from '../../content/ghosts/int_01_rightSpawn_slow_01.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

const DRAIN = anniversary.gameplay.energyRace.drainScale
const PAY = anniversary.gameplay.energyRace.gatePayFraction
const SPEC = energyRaceSpec(DRAIN, PAY)

describe('the rates come off the sheet, and boost is a SURCHARGE', () => {
  it('cruises at engineBurnrate x the preset scale', () => {
    expect(SPEC.drainPerSecond).toBe(HOVERJET.energy.engineBurnrate * DRAIN)
    expect(SPEC.maxEnergy).toBe(HOVERJET.energy.maxEnergy)
  })

  it('costs the ENGINE burn as well while boosting, the way the prototype does', () => {
    // `Energy_System.cs` fires BOTH branches on a boosting tick:
    //   if (isBoosting) Burn(engineBurnrate * BoostBurnrate * dt);
    //   if (enginesOn)  Burn(engineBurnrate * dt);
    // so the multiplier is 1 + BoostBurnrate = 5, not BoostBurnrate = 4. This
    // asserts the RELATIONSHIP rather than the number 12, so a re-extraction
    // that moved `BoostBurnrate` moves both sides.
    expect(SPEC.boostDrainPerSecond).toBe(SPEC.drainPerSecond * (1 + HOVERJET.energy.BoostBurnrate))
    expect(SPEC.boostDrainPerSecond).toBeGreaterThan(SPEC.drainPerSecond)
  })
})

describe('the tank', () => {
  it('costs NOTHING while coasting — the mode’s one real decision', () => {
    // `enginesOn` is `Energy_System.cs`'s throttle axis, not the airspeed. A
    // pilot who cuts the engine on a straight pays nothing and loses the race
    // to a clock that keeps running, which is a choice rather than a free lunch.
    const s = createEnergyRace(SPEC)
    for (let i = 0; i < 10000; i++) stepEnergyRace(s, SPEC, false, false, FIXED_DT)
    expect(s.energy).toBe(SPEC.maxEnergy)
    expect(s.powered).toBe(true)
    expect(secondsOfFlight(s, SPEC, false, false)).toBe(Number.POSITIVE_INFINITY)
  })

  it('goes out at zero and STAYS out', () => {
    const s = createEnergyRace(SPEC)
    let died = 0
    for (let i = 0; i < 10000; i++) {
      if (!stepEnergyRace(s, SPEC, true, true, FIXED_DT) && died === 0) died = i
    }
    expect(died).toBeGreaterThan(0)
    expect(s.energy).toBe(0)
    expect(s.powered).toBe(false)
    // Boosted, a full tank is maxEnergy / boostDrain seconds. Asserted as the
    // relationship; the number it evaluates to is in the module's header.
    expect(died * FIXED_DT).toBeCloseTo(SPEC.maxEnergy / SPEC.boostDrainPerSecond, 1)
  })

  it('is not revived by a gate it falls through', () => {
    // A wreck tumbling through the next ring must not restart its engines in
    // mid-air. Without this the mode has no failure state at all on a course
    // whose rings are below the racing line.
    const s = createEnergyRace(SPEC)
    while (s.powered) stepEnergyRace(s, SPEC, true, true, FIXED_DT)
    payGate(s, SPEC)
    expect(s.energy).toBe(0)
    expect(s.powered).toBe(false)
  })

  it('clamps a gate at the top, the way AddEnergy does', () => {
    const s = createEnergyRace(SPEC)
    payGate(s, SPEC)
    payGate(s, SPEC)
    expect(s.energy).toBe(SPEC.maxEnergy)
    expect(energyRaceFraction(s, SPEC)).toBe(1)
  })

  it('reports seconds of flight, which is four times shorter with boost in', () => {
    const s = createEnergyRace(SPEC)
    const cruise = secondsOfFlight(s, SPEC, true, false)
    const boosting = secondsOfFlight(s, SPEC, true, true)
    expect(cruise / boosting).toBeCloseTo(1 + HOVERJET.energy.BoostBurnrate, 6)
  })
})

describe('trap 19 — a second tank leaves the first alone', () => {
  it('steps two states independently', () => {
    const a = createEnergyRace(SPEC)
    const b = createEnergyRace(SPEC)
    for (let i = 0; i < 100; i++) stepEnergyRace(a, SPEC, true, false, FIXED_DT)
    const aEnergy = a.energy
    for (let i = 0; i < 5000; i++) stepEnergyRace(b, SPEC, true, true, FIXED_DT)
    payGate(b, SPEC)
    expect(a.energy).toBe(aEnergy)
    expect(a.powered).toBe(true)
  })
})

// ── The 2016 recordings ───────────────────────────────────────────────────

type Ghost = typeof ghostFast

/**
 * When the ghost was closest to each gate's trigger sphere.
 *
 * Lifted from `speed-chain.test.ts`, which established the method and the 1.8x
 * tolerance: keyframes are ~12 m apart at speed, so the closest SAMPLE can sit
 * outside a 22.6 m sphere the ship really flew through. All 21 gates match on
 * both clips, which is the check the first assertion makes.
 */
const gateTimes = (ghost: Ghost): number[] => {
  const O = int01.worldOffset as number[]
  const Q = ghost.quant as { time: number; pos: number }
  const times = ghost.t.map((v) => v / Q.time)
  const points: [number, number, number][] = []
  for (let i = 0; i < ghost.p.length; i += 3) {
    points.push([
      (ghost.p[i] as number) / Q.pos + (O[0] as number),
      (ghost.p[i + 1] as number) / Q.pos + (O[1] as number),
      (ghost.p[i + 2] as number) / Q.pos + (O[2] as number),
    ])
  }
  return (int01.routes[0]?.rings ?? [])
    .map((ring) => {
      const c = ring.trigger.pos as number[]
      let best = Number.POSITIVE_INFINITY
      let at: number | null = null
      for (let i = 0; i < points.length; i++) {
        const p = points[i] as [number, number, number]
        const d = Math.hypot(
          p[0] - (c[0] as number),
          p[1] - (c[1] as number),
          p[2] - (c[2] as number),
        )
        if (d < best) {
          best = d
          at = times[i] as number
        }
      }
      return best <= ring.trigger.radius * 1.8 ? at : null
    })
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)
}

/**
 * Fly a ghost's gate schedule through the tank and answer where it ran out.
 *
 * `boostFraction` is how much of each second the pilot holds boost — the one
 * thing the recording cannot tell us directly, so it is a SWEPT parameter
 * rather than an assumed one. The assertions below say what has to be true at
 * each end of the sweep rather than picking a value and believing it.
 */
const replay = (
  gates: readonly number[],
  spec: ReturnType<typeof energyRaceSpec>,
  boostFraction: number,
): { survivedTo: number; finished: boolean; lowest: number; gatesTaken: number } => {
  const s = createEnergyRace(spec)
  const end = gates[gates.length - 1] as number
  let next = 0
  let lowest = spec.maxEnergy
  // The pilot boosts the first `boostFraction` of every second. A duty cycle,
  // not a random draw — the sim is deterministic and so is this.
  for (let t = 0; t < end; t += FIXED_DT) {
    const boosting = t % 1 < boostFraction
    stepEnergyRace(s, spec, true, boosting, FIXED_DT)
    if (!s.powered) return { survivedTo: t, finished: false, lowest: 0, gatesTaken: next }
    lowest = Math.min(lowest, s.energy)
    while (next < gates.length && (gates[next] as number) <= t) {
      payGate(s, spec)
      next++
    }
  }
  return { survivedTo: end, finished: true, lowest, gatesTaken: next }
}

describe('the 2016 ghosts fly it', () => {
  const fast = gateTimes(ghostFast)
  const slow = gateTimes(ghostSlow)

  it('matches all 21 gates on both recordings', () => {
    // If this ever drops, every number below is measuring a different course.
    expect(fast.length).toBe(21)
    expect(slow.length).toBe(21)
  })

  it('has the gate spacing the preset was sized against', () => {
    // The measurement that set `drainScale` and `gatePayFraction`, asserted so
    // the preset's note cannot quietly stop being true of the data.
    const gaps = (g: number[]) => g.slice(1).map((t, i) => t - (g[i] as number))
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    expect(mean(gaps(fast))).toBeCloseTo(2.7, 1)
    expect(mean(gaps(slow))).toBeCloseTo(4.9, 1)
    // And the stretch that actually binds: release to the first gate, the
    // longest gateless run either pilot makes. NOT the run home, which is under
    // two seconds — `ghost.duration - lastGate` is 24 s of the recording
    // rolling on while the ship coasts to a stop, and reading it as the run
    // home would have sized this tank at twenty times what the mode needs.
    expect(fast[0] as number).toBeCloseTo(9.9, 0)
    expect(slow[0] as number).toBeCloseTo(9.3, 0)
  })

  it('lets BOTH pilots finish at HALF boost, comfortably', () => {
    // **The anti-DEV-056 assertion**, and the reason this file exists. A mode
    // nobody can complete is the bug this project has shipped twice
    // (`adv_01_jumpSeat` and `adv_02_jumpSeat`, behind a clock 2016 does not
    // enforce), and it was invisible both times because every test exercised
    // the MECHANISM rather than the RUN.
    //
    // Half the lap on boost is a normal way to fly. Both pilots must get to the
    // last gate, and with room to spare rather than on fumes — a mode whose
    // completable case is a knife edge is not completable in a headset.
    for (const gates of [fast, slow]) {
      const r = replay(gates, SPEC, 0.5)
      expect(r.finished).toBe(true)
      expect(r.lowest).toBeGreaterThan(SPEC.maxEnergy * 0.4)
    }
  })

  it('and cruising is comfortable for both — the tank taxes GREED, not flying', () => {
    for (const gates of [fast, slow]) {
      const r = replay(gates, SPEC, 0)
      expect(r.finished).toBe(true)
      expect(r.lowest).toBeGreaterThan(SPEC.maxEnergy * 0.8)
    }
  })

  it('but flat-out boost is the FAST line’s privilege alone', () => {
    // The mechanic biting, and the tuning's anchor: at 100 % boost the slow
    // ghost's line cannot be sustained, while the fast ghost's just about can.
    // If both survived the tank would be decoration; if neither did the mode
    // would be unflyable.
    //
    // The fast pilot's margin at 100 % is ZERO units, which is exactly what
    // picked these two numbers — but a zero is not a thing to assert against,
    // so the claim here is the robust one: the slow line dies, and it dies
    // early in the lap rather than limping to the end.
    const s = replay(slow, SPEC, 1)
    expect(s.finished).toBe(false)
    expect(s.gatesTaken).toBeLessThan(fast.length / 2)
  })

  it('and three-quarter boost separates the two lines without killing either', () => {
    // The band the mode actually lives in. Both finish; the fast line has real
    // margin and the slow line is nearly empty. A rule that gave them the same
    // answer would not be a rule about flying.
    const f = replay(fast, SPEC, 0.75)
    const sl = replay(slow, SPEC, 0.75)
    expect(f.finished).toBe(true)
    expect(sl.finished).toBe(true)
    expect(f.lowest).toBeGreaterThan(sl.lowest * 2)
  })

  it('THE CONTROL: at the sheet’s raw drain, nobody finishes', () => {
    // `drainScale` 1 is `engineBurnrate` straight off the prefab — 8/s cruising
    // and 40/s boosting against a 100-unit tank. Both pilots die the moment
    // boost is involved at all, which is what makes the preset's 0.2 a decision
    // rather than a decoration: without this, every assertion above would also
    // pass for a tank that can never empty.
    //
    // **Pure cruise at the raw rate survives**, and that is written down rather
    // than tolerated: it is the same defect as the 12-unit gate pay below, from
    // the other side. A mode where cruising is safe and any boost at all is
    // fatal has no middle either, and the middle is the mode.
    const raw = energyRaceSpec(1, PAY)
    for (const duty of [0.5, 1]) {
      expect(replay(fast, raw, duty).finished, `fast duty ${duty}`).toBe(false)
      expect(replay(slow, raw, duty).finished, `slow duty ${duty}`).toBe(false)
    }
    expect(replay(fast, raw, 0.25).finished).toBe(false)
  })

  it('and the sheet’s own gate pay of 12 would be a mode with no middle', () => {
    // `scoring.energyBoostAmount` is 12 on every shipped gate, and the module
    // header says why it is not used. This is that claim, checked rather than
    // asserted: at 12 units a gate is 7.5 s of cruise and 1.5 s of boost, so
    // cruising is free and a quarter-throttle of boost already kills the slow
    // line. There is no band in between, and the band is the whole mode.
    const rings = int01.routes[0]?.rings ?? []
    const amounts = new Set(
      rings.map((r) => (r.scoring as { energyBoostAmount: number }).energyBoostAmount),
    )
    // One value across all 21 — so there is no per-course variation to lose.
    expect([...amounts]).toEqual([12])
    const asShipped = energyRaceSpec(DRAIN, 12 / HOVERJET.energy.maxEnergy)
    expect(replay(fast, asShipped, 0).finished).toBe(true)
    expect(replay(slow, asShipped, 0.25).finished).toBe(false)
  })
})
