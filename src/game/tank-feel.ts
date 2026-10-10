// src/game/tank-feel.ts: a tank you can feel. DEV-640.
//
// `sim/energy.ts:114` records Matt: players do not realise the boost bar fills and
// empties. The sim already says everything (`drained`, `lit`, the energy itself,
// a ring's `refillEnergy`); this module is the presentation's half: the edges the
// sounds hang off, the numbers every channel shares, and the one smoothing the
// cockpit's lamps and the lens use. PURE: no three, no DOM, no clock. Presentation
// only (hard rule 4): nothing here is read by the sim.

/** What the tank feels like, in one table. FF2's own: 2016 had a bar and nothing else. */
export const TANK_FEEL = {
  /**
   * Flat only: the lens opens this many degrees while boost is lit, over
   * `fovPushAttack` and back over `fovPushRelease` (the lens's own ease: the
   * speed term has its own on top). Scaled by the Speed FX slider by the caller.
   */
  fovPushDegrees: 3,
  /** The cabin lamps' glow rises over this many seconds when boost lights... */
  glowAttackSeconds: 0.12,
  /** ...and falls over this many when it stops. */
  glowReleaseSeconds: 0.4,
  /**
   * The empty flash: the gate pulse's own quad, in amber (LINEAR rgb), at this
   * strength as a multiple of a plain gate's pulse. The speed it is fired at is
   * `finish-feel.ts`'s `EDGE_FLASH_SPEED`: a flash is not a gate pass.
   */
  flashColor: [1, 0.45, 0.12] as const,
  flashScale: 1,
} as const

/**
 * A rising-edge detector: true on the one call a held input goes from false to
 * true. Per detector, never module scratch (trap 19).
 */
export interface RisingEdge {
  step(held: boolean): boolean
  reset(): void
}

export const createRisingEdge = (): RisingEdge => {
  let last = false
  return {
    step(held) {
      const edge = held && !last
      last = held
      return edge
    },
    reset() {
      last = false
    },
  }
}

/**
 * Is this boost press a DRY one: a press with nothing to light. `pressed` is the
 * rising edge of the raw stick, `available` the tank's own answer
 * (`sim/energy.ts` `boostAvailable`) BEFORE this tick's step, `flying` that the
 * ship is released and not held by a crash.
 */
export const isDryPress = (pressed: boolean, available: boolean, flying: boolean): boolean =>
  pressed && flying && !available

/**
 * One step of a 0..1 level chasing a target with an attack when it rises and a
 * release when it falls, frame-rate independent (`1 - exp(-dt / tau)`, the same
 * ease `render/flat-fov.ts` uses). A non-positive `dt` leaves the level where it
 * is; a non-positive time constant snaps. Snaps to the target inside 0.001 so a
 * resting lamp is exactly at rest and writes nothing.
 */
export const easeLevel = (
  level: number,
  target: number,
  attackSeconds: number,
  releaseSeconds: number,
  dt: number,
): number => {
  if (!(dt > 0)) return level
  const tau = target > level ? attackSeconds : releaseSeconds
  if (!(tau > 0)) return target
  const next = level + (target - level) * (1 - Math.exp(-dt / tau))
  return Math.abs(next - target) < 0.001 ? target : next
}
