// src/game/glider-flight.ts — the glider, as a third aircraft. DEV-399.
//
// docs/plan/AIRCRAFT-VARIANTS.md §5, G1: *"`VehicleId` gains `glider`;
// `loadFlight` branches to a glider seam (`stepGlider` for `stepHoverJet`,
// `Flight.clearance` into `glider.clearance` for ground effect, the hover motor
// off)"*. This file is that seam: everything glider-shaped the flight needs,
// and nothing that draws.
//
// ── Why it borrows the HoverJet's loader rather than being one ────────────
//
// The glider has no art of its own (G3 is Matt's asset call), so it flies in
// the HoverJet's cockpit and hull, reads the HoverJet's dash placement and
// rides the HoverJet's camera — exactly as the 2026-09-16 triage asked for the
// prototype ("in the HoverJet's cockpit for now") and exactly as 2016's own
// `PlayerShip_Glider_Photon.prefab` is built: a HoverJet with `maxSpeed 0` and
// `useGravity 1`. So `game/flight.ts`'s `loadAirframeFlight` builds it, and the
// physics is swapped through its `Airframe`: {@link gliderAirframe}.
//
// ── What the flight gets on top ───────────────────────────────────────────
//
//  · `fuel`, the rocket's tank as the panel's tank gauge reads it — the
//    `Flight.fuel` shape the JumpSeat already fills, so `boot/app.ts` draws it
//    with no new line: a tank that burns while held and refills once released
//    IS a tank;
//  · `stall`, the stall margin for the dash's new bar (`Flight.stall`);
//  · `gliderAutopilot`, `sim/glider-autopilot.ts` on this glider, the way
//    `game/jumpseat-flight.ts` carries the JumpSeat's pilot, so `?autopilot`
//    and the P key fly a glider as a glider (DEV-145's own brief: *"a glider
//    that cannot complete its own mission is not a prototype"*).
//
// Imports only TYPES back from `game/flight.ts`, so there is no runtime cycle:
// `flight.ts` imports this for the arm, and this needs nothing of it that
// survives compilation. No three and no DOM, so a node test flies it.

import { gliderTuning } from '@/content/load-aircraft'
import type { FlightActions } from '@/input/actions'
import type { HudOptions } from '@/render/hud'
import {
  createGlider,
  type Glider,
  type GliderTuning,
  launchGlider,
  noGliderInput,
  refuelGlider,
  stallMarginAt,
  stepGlider,
  terminalDiveSpeed,
} from '@/sim/glider'
import { gliderAutopilotActions } from '@/sim/glider-autopilot'
import type { Vec3 } from '@/sim/math/vec3'
import type { SpeedChainState } from '@/sim/speed-chain'
import type { Airframe, Flight } from './flight'

/**
 * A glider, off the aircraft's own file (`content/aircraft/glider.json`). The
 * ONE place the seam builds one, exported so a test flies the glider the game
 * builds rather than a second opinion about it. `tuning` is injectable for the
 * same reason `jumpSeatFor`'s variant is.
 */
export const gliderFor = (tuning: GliderTuning = gliderTuning()): Glider => createGlider(tuning)

/**
 * The glider's speed chain: NONE, and one that cannot be banked.
 *
 * `boot/app.ts` calls `chainGate(flight.jet.chain)` on every scored ring
 * without knowing which aircraft it is flying (`FlightShip`'s note in
 * `flight.ts`), and the dash draws `stacks` as a `+N` badge over a draining
 * bar. The JumpSeat's plain `createSpeedChain()` is never reached, because no
 * JumpSeat mode scores a ring. The glider's course is Ring Attack and scores
 * ten, so an ordinary chain would bank ten stacks for a mechanic the glider
 * does not have — nothing steps it, so they would never even expire — and the
 * panel would draw an instrument that lies. Reads are zero; writes are dropped.
 */
export const unbankableChain = (): SpeedChainState => ({
  get stacks() {
    return 0
  },
  set stacks(_banked: number) {},
  get sinceGate() {
    return 0
  },
  set sinceGate(_seconds: number) {},
})

/**
 * The glider as an {@link Airframe}: `stepGlider` where the HoverJet has
 * `stepHoverJet`, no hover motor, the belly clearance as ground effect, a full
 * rocket on every reload, and a launch at trim speed.
 *
 * The stick maps axis for axis — `GliderInput` keeps `HoverJetInput`'s
 * convention on purpose (`sim/glider.ts` pins the pitch and roll signs against
 * `stepHoverJet`) — and the ROCKET is the BOOST button: the glider's burst on
 * the same trigger as the jet's, and the throttle, which a glider has nothing
 * to answer with, does nothing.
 */
export const gliderAirframe = (glider: Glider): Airframe => {
  // This glider's own input object — never a shared one (trap 19).
  const input = noGliderInput()
  return {
    ship: { body: glider.body, chain: unbankableChain() },
    name: 'glider',
    hovers: false,
    fly(actions: FlightActions, clearance: number) {
      // BEFORE the step, as `Glider.clearance`'s own note asks: the belly
      // reading the last tick ended on, after its collision had resolved.
      glider.clearance = clearance
      input.roll = actions.roll
      input.pitch = actions.pitch
      input.yaw = actions.yaw
      input.rocket = actions.boost
      stepGlider(glider, input)
    },
    reset() {
      refuelGlider(glider)
    },
    start() {
      launchGlider(glider)
    },
  }
}

/** What the glider's two instruments read. */
export interface GliderReadout {
  /** The rocket's tank, 0..1, and whether it will light. `Flight.fuel`'s shape. */
  readonly fuel: { readonly fraction: number; readonly lit: boolean }
  /** `Flight.stall`: the margin over the stall, 0..1, and whether the wing has let go at all. */
  readonly stall: { readonly margin: number; readonly stalling: boolean }
}

/**
 * The HUD row, off the glider's OWN state — the numbers the physics used this
 * tick (`airspeed`, `liftAuthority`, `fuel`), never a second opinion computed
 * from the body. `lit` is "the rocket has fuel to burn": holding the button on
 * an empty tank burns nothing, and it refills only once released.
 */
export const gliderReadout = (glider: Glider): GliderReadout => ({
  fuel: {
    fraction: glider.tuning.rocketSeconds > 0 ? glider.fuel / glider.tuning.rocketSeconds : 0,
    lit: glider.fuel > 0,
  },
  stall: {
    margin: stallMarginAt(glider.tuning, glider.airspeed),
    stalling: glider.liftAuthority < 1,
  },
})

/**
 * The panel the glider asks for: whatever the caller pinned, with the speed
 * gauge's full scale at the glider's terminal dive — the fastest a glider
 * goes, where the HoverJet's is its chained boosted terminal. An explicit
 * caller value wins, as `flight.ts`'s own default does.
 */
export const gliderHudOptions = (glider: Glider, hudOptions: HudOptions): HudOptions => ({
  speedFullScale: terminalDiveSpeed(glider.tuning),
  ...hudOptions,
})

/**
 * The glider's pilot, on the seam that owns the glider — `JumpSeatAutopilotSeam`'s
 * shape and for its reason: `Flight` exposes only `jet.body`, and the pilot
 * needs the airspeed, the fuel and the tuning the physics reads.
 */
export interface GliderAutopilotSeam {
  /**
   * One FIXED step of pilot intent toward `target` — the next ring's centre,
   * or the finish once every ring is taken, in SIM space — as the actions
   * `flight.step` takes. Call it once per sim step, never per frame (DEV-027).
   */
  step(target: Vec3): FlightActions
}

/** `sim/glider-autopilot.ts` on one glider, with an input object of its own (trap 19). */
export const gliderAutopilot = (glider: Glider): GliderAutopilotSeam => {
  const input = noGliderInput()
  return {
    step(target) {
      gliderAutopilotActions(
        glider.body,
        target,
        glider.airspeed,
        glider.fuel,
        glider.tuning,
        input,
      )
      // The inverse of `gliderAirframe.fly`'s mapping: axes straight across,
      // the rocket on the boost button, nothing on the throttle.
      return {
        pitch: input.pitch,
        yaw: input.yaw,
        roll: input.roll,
        throttle: 0,
        boost: input.rocket,
        brake: false,
        airbrake: false,
      }
    },
  }
}

/** A `Flight` that is a glider. Declared here so `game/flight.ts` needs no glider type. */
export interface GliderFlight extends Flight {
  readonly gliderAutopilot: GliderAutopilotSeam
  readonly fuel: GliderReadout['fuel']
  readonly stall: GliderReadout['stall']
}

/**
 * Put the glider's three members on a flight built round its airframe. LIVE
 * getters for the two readings, so the panel reads this tick's glider and not
 * the one at boarding; the pilot is built once.
 */
export const withGliderSeam = (flight: Flight, glider: Glider): GliderFlight => {
  Object.defineProperties(flight, {
    gliderAutopilot: { value: gliderAutopilot(glider), enumerable: true },
    fuel: { get: () => gliderReadout(glider).fuel, enumerable: true },
    stall: { get: () => gliderReadout(glider).stall, enumerable: true },
  })
  return flight as GliderFlight
}

/**
 * The glider autopilot on this flight, or null for any other aircraft — the
 * narrowing `boot/app.ts` uses, `jumpSeatAutopilotOf`'s shape, so its
 * `?autopilot` branch reads "this aircraft brought its own controller".
 */
export const gliderAutopilotOf = (flight: Flight): GliderAutopilotSeam | null =>
  (flight as Partial<GliderFlight>).gliderAutopilot ?? null
