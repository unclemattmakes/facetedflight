// src/input/haptics.ts: rumble, with a priority scheduler. DEV-637.
//
// docs/research/09-web-platform-research.md section 7.6 is the reference, and it
// says the one thing that shapes this file: *"A new call preempts the previous
// effect, there is no mixing."* So three systems calling `playEffect` on their
// own would cut each other off at random, and a gate tick would kill a crash's
// rumble. This module OWNS the actuator and arbitrates:
//
//     crash > hit > near miss > go > clean gate > gate > countdown > boost hum
//
// A stronger effect pre-empts a weaker one and a weaker one NEVER pre-empts a
// stronger one that is still running (it is dropped, not queued: a gate tick
// 200 ms after a crash is not worth feeling late). An effect of equal priority
// replaces the running one.
//
// ── Two halves ────────────────────────────────────────────────────────────
//
// The scheduler (`createHaptics`) is pure: it takes the time as an argument and
// writes to a `HapticSink`, so a node test drives it with a fake clock and a
// recording sink. The sinks (`gamepadSink`, `xrSink`) are the only code that
// touches a `Gamepad`, and they are fire-and-forget: every call is optional-
// chained and its promise is caught, because Quest Browser moved controller
// haptics behind a permission on 2026-02-18 and a rejected promise must never
// surface (research 09 section 3.4). Never gate gameplay on it.
//
// What that permission change means for the Steam Frame: very likely nothing.
// The target is DESKTOP Chrome streaming through SteamVR (CLAUDE.md), which has
// no such prompt, and `vibrationActuator` on a SteamVR controller is the same
// path a gamepad takes. If a headset's browser did gate it, the call no-ops and
// the game plays on, which is the failure mode the catch exists for.
//
// ── Where it is felt ─────────────────────────────────────────────────────
//
// Flat: a standard-mapping gamepad's dual-rumble motors. XR: both controllers'
// `gamepad`. Not on a phone (`navigator.vibrate` is a different API with a
// different grammar, and nothing in the brief asks for it). Both looks, on a
// player's own switch (the HAPTICS row on the Controls page, on by default).
// Not scaled by Speed FX: a rumble is not optic flow and creates no vection.

/** The things that can be felt, named for what HAPPENED. */
export type HapticKind = 'crash' | 'hit' | 'nearMiss' | 'go' | 'cleanGate' | 'gate' | 'countdown'

/** Higher wins. The order is the brief's: crash > hit > near miss > clean gate > gate > boost hum. */
export const HAPTIC_PRIORITY: Readonly<Record<HapticKind, number>> = {
  crash: 7,
  hit: 6,
  nearMiss: 5,
  go: 4,
  cleanGate: 3,
  gate: 2,
  countdown: 1.5,
}

/** The boost hum's rank, under everything above. */
export const BOOST_HUM_PRIORITY = 1

/** One burst: when it starts (ms after the effect), how long it runs, and both motors 0..1. */
export interface HapticSegment {
  readonly at: number
  readonly ms: number
  /** The low-frequency (heavy) motor. */
  readonly strong: number
  /** The high-frequency (light) motor. */
  readonly weak: number
}

/**
 * The effects. Strong is the heavy motor (a thud), weak the light one (a tick).
 * A tick is the weak motor alone; a blow is both; a decay is a list of
 * segments whose magnitudes fall.
 */
export const HAPTIC_EFFECTS: Readonly<Record<HapticKind, readonly HapticSegment[]>> = {
  gate: [{ at: 0, ms: 40, strong: 0, weak: 0.5 }],
  // The double tick: a clean gate is TWO of them, so it feels like a different
  // event, not a harder gate.
  cleanGate: [
    { at: 0, ms: 40, strong: 0, weak: 0.55 },
    { at: 85, ms: 50, strong: 0.12, weak: 0.8 },
  ],
  nearMiss: [{ at: 0, ms: 35, strong: 0.2, weak: 1 }],
  hit: [{ at: 0, ms: 130, strong: 0.65, weak: 0.5 }],
  crash: [
    { at: 0, ms: 170, strong: 1, weak: 1 },
    { at: 170, ms: 140, strong: 0.8, weak: 0.6 },
    { at: 310, ms: 160, strong: 0.55, weak: 0.35 },
    { at: 470, ms: 200, strong: 0.3, weak: 0.15 },
    { at: 670, ms: 240, strong: 0.12, weak: 0.05 },
  ],
  countdown: [{ at: 0, ms: 50, strong: 0, weak: 0.45 }],
  go: [{ at: 0, ms: 130, strong: 0.5, weak: 0.6 }],
}

/** Where a burst goes. The scheduler's only output. */
export interface HapticSink {
  /** Run both motors for `ms`, replacing whatever is running. Must never throw. */
  rumble(strong: number, weak: number, ms: number): void
  /** Stop what is running, if the device can. */
  stop(): void
}

/** The boost hum is refreshed this often (ms) and each refresh runs this long, so a gap never opens. */
const HUM_REFRESH_MS = 100
const HUM_PULSE_MS = 140

export interface Haptics {
  /** The master switch (the Controls page's HAPTICS row). Off stops everything now. */
  setEnabled(enabled: boolean): void
  readonly enabled: boolean
  /**
   * Hold everything while a menu stands over the game: nothing new starts and a
   * running effect is stopped. A held scheduler drops triggers rather than
   * queuing them.
   */
  setHeld(held: boolean): void
  /**
   * Start an effect at `now` (ms). Returns whether it was accepted: false when
   * disabled, held, or a stronger effect is still running.
   */
  trigger(kind: HapticKind, now: number): boolean
  /**
   * The boost hum's level, 0..1 (0 stops it: an empty tank, or the button
   * released). Scaled by boost stage by the caller. Under every discrete effect.
   */
  setBoost(level: number): void
  /** Advance to `now` (ms): start due segments, refresh the hum, retire the finished. */
  update(now: number): void
  /** Which effect is running at `now`, or null. For the tests and the debug handle. */
  active(now: number): HapticKind | 'boost' | null
}

interface Running {
  readonly kind: HapticKind
  readonly priority: number
  readonly start: number
  readonly end: number
  next: number
}

const unit = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0)

export const createHaptics = (sink: HapticSink, enabled = true): Haptics => {
  let on = enabled
  let held = false
  let running: Running | null = null
  let boost = 0
  let humNext = 0
  let humOn = false

  const update = (now: number): void => {
    if (!on || held) return
    const r = running
    if (r) {
      const segments = HAPTIC_EFFECTS[r.kind]
      while (r.next < segments.length) {
        const seg = segments[r.next] as HapticSegment
        if (now < r.start + seg.at) break
        sink.rumble(unit(seg.strong), unit(seg.weak), seg.ms)
        r.next += 1
      }
      if (now >= r.end) running = null
      else return
    }
    // The hum: only when nothing else is running, refreshed in short pulses.
    if (boost > 0 && (!humOn || now >= humNext)) {
      sink.rumble(0.12 + 0.28 * boost, 0, HUM_PULSE_MS)
      humOn = true
      humNext = now + HUM_REFRESH_MS
    }
  }

  return {
    get enabled() {
      return on
    },
    setEnabled(next) {
      if (next === on) return
      on = next
      if (!on) {
        running = null
        boost = 0
        humOn = false
        sink.stop()
      }
    },
    setHeld(next) {
      if (next === held) return
      held = next
      if (held) {
        running = null
        humOn = false
        sink.stop()
      }
    },
    trigger(kind, now) {
      if (!on || held) return false
      const priority = HAPTIC_PRIORITY[kind]
      if (running && now < running.end && running.priority > priority) return false
      const last = HAPTIC_EFFECTS[kind].at(-1)
      if (!last) return false
      running = { kind, priority, start: now, end: now + last.at + last.ms, next: 0 }
      humOn = false
      update(now)
      return true
    },
    setBoost(level) {
      boost = on ? unit(level) : 0
      if (boost <= 0) humOn = false
    },
    update,
    active(now) {
      if (running && now < running.end) return running.kind
      return humOn && boost > 0 ? 'boost' : null
    },
  }
}

// ── The sinks: the only code that touches a Gamepad ───────────────────────

/** The two actuator shapes in the wild, as far as this file needs them. */
interface DualRumbleActuator {
  playEffect?: (
    type: 'dual-rumble',
    params: {
      startDelay?: number
      duration: number
      weakMagnitude: number
      strongMagnitude: number
    },
  ) => Promise<unknown> | undefined
  reset?: () => Promise<unknown> | undefined
}
interface PulseActuator {
  pulse?: (value: number, duration: number) => Promise<unknown> | undefined
}
interface HapticGamepad {
  vibrationActuator?: DualRumbleActuator | null
  hapticActuators?: readonly PulseActuator[] | null
}

/** Swallow a rejected haptics promise: never an unhandled rejection. */
const swallow = (r: unknown): void => {
  if (r && typeof (r as Promise<unknown>).catch === 'function') {
    ;(r as Promise<unknown>).catch(() => {})
  }
}

/** One gamepad, dual-rumble first, then the older pulse path. Never throws. */
const buzz = (
  pad: HapticGamepad | null | undefined,
  strong: number,
  weak: number,
  ms: number,
): void => {
  if (!pad) return
  try {
    const va = pad.vibrationActuator
    if (va?.playEffect) {
      swallow(
        va.playEffect('dual-rumble', {
          startDelay: 0,
          duration: ms,
          weakMagnitude: weak,
          strongMagnitude: strong,
        }),
      )
      return
    }
    const pulse = pad.hapticActuators?.[0]?.pulse
    if (pulse) swallow(pulse.call(pad.hapticActuators?.[0], Math.max(strong, weak * 0.8), ms))
  } catch {
    // A device that throws is a device without haptics.
  }
}

const calm = (pad: HapticGamepad | null | undefined): void => {
  try {
    swallow(pad?.vibrationActuator?.reset?.())
  } catch {
    // as above
  }
}

/**
 * The sink for the player's hands: the XR controllers while a session runs
 * (both of them), else the first standard gamepad. `getPads` and `getSession`
 * are injected so the app passes `firstStandardPad` and the live session and a
 * test passes fakes.
 */
export const createHapticOutput = (
  getPad: () => Gamepad | null,
  getSession: () => XRSession | null,
): HapticSink => {
  const targets = (): HapticGamepad[] => {
    const session = getSession()
    if (session) {
      const out: HapticGamepad[] = []
      for (const source of session.inputSources ?? []) {
        if (source.gamepad) out.push(source.gamepad as unknown as HapticGamepad)
      }
      return out
    }
    const pad = getPad() as unknown as HapticGamepad | null
    return pad ? [pad] : []
  }
  return {
    rumble(strong, weak, ms) {
      for (const pad of targets()) buzz(pad, strong, weak, ms)
    },
    stop() {
      for (const pad of targets()) calm(pad)
    },
  }
}
