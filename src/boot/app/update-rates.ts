// src/boot/app/update-rates.ts: how often a piece of presentation work runs. DEV-976.
//
// Matt, 2026-10-13, after Source's tick model: *"not updating everything, every
// frame. would that help?"* This is the small scheduler that question asked for.
// The frame's phases (`frame.ts`) each do their work every frame; a subsystem
// that does not need to says so here, once, in a rate, and the phase asks the
// gate instead of running unconditionally.
//
// ── The rules a rate lives under ─────────────────────────────────────────
//
//  * **Never anything bound to the head, the hands, the cockpit or the near
//    field.** The eye's pose, the listener, the controllers, the HUD, the
//    cockpit's shake and lens, the particles round the ship, the near-field air
//    and the ship itself run every frame. A headset re-projects a late frame,
//    and a pose that is one frame old is a visible judder; nothing here may
//    make one.
//  * **The sim stays on the fixed step** (hard rules 4 and 5). A rate is for
//    work that only PRESENTS the sim or only READS it for a cue; it never skips
//    a tick and never changes how a tick is taken. The AI racers' physics, the
//    race clock, the scoring and the contact rules are not in this file.
//  * **Time is accumulated, not dropped.** A gated run is handed every second
//    of frame time since it last ran, so an easing or a debounce that takes a
//    `dt` ages exactly as it did when it ran every frame.
//  * **Stagger, do not batch.** Work that serves many things (racers, flocks,
//    chunks) runs a slice of them each frame, never all of them every Nth
//    frame: a frame that carries all of the work is a spike, and a spike is a
//    reprojected frame in a headset. {@link UpdateRates.staggered} gives each
//    slot its own frame.
//
// PURE: no three, no DOM, no clock. Time arrives as an argument (the frame's
// seconds), so a test drives it with numbers.

/** What one declared rate has done: `due` runs, `skipped` frames. For `__ff2.updateRates()`. */
export interface RateReport {
  /** How the rate was declared, `20 Hz` or `1 slot in 3`. */
  readonly rate: string
  readonly due: number
  readonly skipped: number
}

/**
 * Call once per frame with that frame's seconds. Returns the frame seconds the
 * run stands for (everything since the last run, 0 or more) when it is due, and
 * null when it is not.
 */
export type HzGate = (frameSeconds: number) => number | null

/**
 * Is slot `slot` of `every` due on frame `frame`? Slot `s` runs when
 * `(frame + s) % every === 0`, so consecutive slots run on consecutive frames
 * and every frame carries about `1 / every` of the work.
 */
export type StaggerGate = (frame: number, slot: number) => boolean

export interface UpdateRates {
  /**
   * Work that runs at most `hz` times a second of FRAME time. The first call is
   * due. A frame longer than the period (a hitch, a slow display) is due and
   * hands over all the time it carries; the cadence keeps its phase otherwise,
   * so 20 Hz on a 72 Hz display runs on frames 0, 3, 7, 10, 14... (a mean of
   * 20 Hz, never twice in a frame).
   */
  hz(name: string, hz: number): HzGate
  /** Work over `every` slots, one slot per frame in turn. `every` below 2 is every frame. */
  staggered(name: string, every: number): StaggerGate
  /** Every declared rate and what it has done. */
  report(): Readonly<Record<string, RateReport>>
}

/** A cadence shorter than this is every frame; it also absorbs float error in the phase sum. */
const EPSILON = 1e-9

export const createUpdateRates = (): UpdateRates => {
  const counts = new Map<string, { rate: string; due: number; skipped: number }>()
  const entry = (name: string, rate: string) => {
    const e = { rate, due: 0, skipped: 0 }
    counts.set(name, e)
    return e
  }
  return {
    hz(name, hz) {
      const e = entry(name, `${hz} Hz`)
      const seconds = (frameSeconds: number): number =>
        Number.isFinite(frameSeconds) && frameSeconds > 0 ? frameSeconds : 0
      // An unusable rate is every frame, never silence: a typo must not stop a subsystem.
      if (!(Number.isFinite(hz) && hz > 0)) {
        return (frameSeconds) => {
          e.due++
          return seconds(frameSeconds)
        }
      }
      const period = 1 / hz
      // Due on the first call; `since` is what the run is handed, `phase` keeps the cadence.
      let phase = period
      let since = 0
      return (frameSeconds) => {
        const dt = seconds(frameSeconds)
        since += dt
        phase += dt
        if (phase < period - EPSILON) {
          e.skipped++
          return null
        }
        // Keep the cadence's phase. After a hitch (a frame of several periods) the missed runs
        // are not owed: one run carries all the time, and the next is a whole period on.
        phase = Math.max(0, phase - period) % period
        const stands = since
        since = 0
        e.due++
        return stands
      }
    },
    staggered(name, every) {
      const n = Number.isFinite(every) && every >= 2 ? Math.floor(every) : 1
      const e = entry(name, n === 1 ? 'every frame' : `1 slot in ${n}`)
      return (frame, slot) => {
        if (n === 1 || (frame + slot) % n === 0) {
          e.due++
          return true
        }
        e.skipped++
        return false
      }
    },
    report() {
      const out: Record<string, RateReport> = {}
      for (const [name, e] of counts) out[name] = { rate: e.rate, due: e.due, skipped: e.skipped }
      return out
    },
  }
}
