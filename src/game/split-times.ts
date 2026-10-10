// src/game/split-times.ts: the gap at a gate, to your ghost or to the field. DEV-649.
//
// Matt, 2026-10-05: *"could use the typical time difference between yourself
// and your ghost (or the next racers) - maybe every n-gates or something?"*
//
// ── What it shows, and when ───────────────────────────────────────────────
//
// Every fourth gate and always the last (`isSplitGate`), for two seconds. The
// gap is to YOUR GHOST when one flies and has a time at that gate, and
// otherwise to the racer just AHEAD of you and the racer just BEHIND you at
// that same gate. Plus is behind, minus is ahead, as every racing game's split
// reads and as `lap-run.ts`'s `splitText` already did: `+1.4` is a loss
// (the opponent got there 1.4 s before you) and `-0.8` is a gain.
//
// ── Measured, never estimated ─────────────────────────────────────────────
//
// A gap is two times at ONE gate: the mission clock when each entrant crossed
// it. The player's is read on the tick `stepMission` scored the gate; a racer's
// is `racer.elapsed` on the tick its own course first marked the gate passed;
// the ghost's is `ghost.result.ringTimes`, which is `scoreGhost`'s own fixed
// step. None of them is a distance divided by a speed. So the racer BEHIND you
// has no number until it reaches the gate (an estimate would be the thing this
// row forbids): the split waits for it, shows it if it arrives inside the
// window, and the window is stretched a little (`SPLIT_LATE_CAP_SECONDS`) so a
// racer a second back is not flashed for a tenth of one. A racer further back
// than that is simply not shown, which is the honest answer.
//
// Stamped in the fixed step (`observe` after the racers step), never per
// frame, so a slow frame cannot make a gap a frame late.
//
// PURE: arrays and numbers in, a `Split` out. The sim is untouched: this reads
// what the sim already decided and writes nothing back (hard rule 4).

/** Show a split on every Nth gate, and on the last. Matt: "every n-gates"; the brief's rec is 4. */
export const SPLIT_EVERY_GATES = 4
/** How long a split stays up once it is complete, mission seconds. */
export const SPLIT_SECONDS = 2
/** The longest a split is held for a late racer behind you, from your crossing. */
export const SPLIT_LATE_CAP_SECONDS = 4

/** Is the gate at `index` (0-based) one that shows a split? `total` is the course's gate count. */
export const isSplitGate = (index: number, total: number): boolean =>
  index >= 0 && ((index + 1) % SPLIT_EVERY_GATES === 0 || index + 1 === total)

/** One number on the split: who it is against, and the gap in seconds (plus is behind). */
export interface SplitEntry {
  readonly label: string
  readonly gap: number
  /** DEV-854: an AI racer. The strip tags it; absent for a ghost (a recording). */
  readonly ai?: boolean
}

export interface Split {
  /** The gate (0-based index) it is at. */
  readonly gate: number
  /** Mission seconds the player crossed it. */
  readonly at: number
  /** Mission seconds the split goes down. Moves later when the racer behind arrives. */
  readonly until: number
  readonly source: 'ghost' | 'field'
  /** The ghost's, or the racer ahead's then the racer behind's. Never empty. */
  readonly entries: readonly SplitEntry[]
}

/** `+1.4` or `-0.8`, one decimal. A gap that rounds to nothing reads `0.0`, with no sign. */
export const gapText = (gap: number): string => {
  const tenths = Math.round(Math.abs(gap) * 10) / 10
  if (tenths === 0) return '0.0'
  return `${gap < 0 ? '-' : '+'}${tenths.toFixed(1)}`
}

/** A gap's colour: behind is a loss, level or ahead is a gain. */
export const gapTone = (gap: number): 'gain' | 'loss' =>
  gapText(gap).startsWith('+') ? 'loss' : 'gain'

/** `CUTTER +1.4  STEADY -0.8`: the split as one line, for a plate that has room for words. */
export const splitLine = (split: Split): string =>
  split.entries.map((e) => `${e.label}${e.ai ? ' AI' : ''} ${gapText(e.gap)}`).join('  ')

/** The tone of the line as a whole: a loss anywhere inks it as one, as the event line's single tone must. */
export const splitTone = (split: Split): 'gain' | 'loss' =>
  split.entries.some((e) => gapTone(e.gap) === 'loss') ? 'loss' : 'gain'

/** What the tracker reads off a racer: structural, so a test needs no `AiRacer`. */
export interface SplitRacer {
  readonly spec: { readonly id: string; readonly callsign?: string | null | undefined }
  /** Race seconds, the racer's own clock (`AiRacer.elapsed`). */
  readonly elapsed: number
  readonly course: { readonly passed: readonly boolean[] }
}

/** The ghost's side: when it took each ring, null for a miss, and what to call it. */
export interface SplitGhost {
  readonly label: string
  readonly ringTimes: readonly (number | null)[]
}

export interface SplitTracker {
  /** Forget everything: a new run. Also done on its own when a clock goes backwards. */
  reset(): void
  /**
   * Stamp every racer's newly passed gates. Call once per FIXED step, after the
   * racers step, so the stamp is the tick the gate was taken on.
   */
  observe(racers: readonly SplitRacer[]): void
  /**
   * The player took `gate` at mission seconds `t`. Opens a split when that gate
   * shows one. Returns it (or null) for the caller's convenience.
   */
  playerPass(gate: number, t: number, total: number, ghost: SplitGhost | null): Split | null
  /** The split to show at mission seconds `t`, or null. */
  current(t: number): Split | null
  /** Every stamp of one racer (index in `observe`'s array), NaN where not taken. For tests and probes. */
  stamps(racer: number): readonly number[]
}

const NO_STAMP = Number.NaN
/** Two stamps within this are one tick: both clocks are the same sum of the same step. */
const SAME_TICK = 1e-9

export const createSplitTracker = (): SplitTracker => {
  /** Per racer index: the race seconds each gate was first seen passed. */
  let racerStamps: number[][] = []
  /** The labels, by racer index. */
  let labels: string[] = []
  let lastRacerClock = 0
  let lastPlayerClock = 0
  /** The open split, and what it is still waiting for. */
  let shown: Split | null = null
  let waiting: { gate: number; at: number } | null = null

  const reset = (): void => {
    racerStamps = []
    labels = []
    lastRacerClock = 0
    lastPlayerClock = 0
    shown = null
    waiting = null
  }

  return {
    reset,
    observe(racers) {
      // A racer's clock going backwards is a new run (its elapsed is zeroed by
      // a restart): the stamps of the old one would be read as the new one's.
      const clock = racers[0]?.elapsed ?? 0
      if (clock < lastRacerClock) {
        racerStamps = []
        labels = []
        shown = null
        waiting = null
      }
      lastRacerClock = clock
      let behind: SplitEntry | null = null
      for (let r = 0; r < racers.length; r += 1) {
        const racer = racers[r] as SplitRacer
        const passed = racer.course.passed
        let stamps = racerStamps[r]
        if (!stamps) {
          stamps = new Array<number>(passed.length).fill(NO_STAMP)
          racerStamps[r] = stamps
          // DEV-854: called what the results call it (DEV-651's callsign, else the tuning id).
          labels[r] = (racer.spec.callsign ?? racer.spec.id).toUpperCase()
        }
        for (let g = 0; g < passed.length; g += 1) {
          if (!passed[g] || !Number.isNaN(stamps[g] as number)) continue
          stamps[g] = racer.elapsed
          // The racer behind, arriving: the first one to take the gate we are
          // waiting on, strictly after the player did.
          if (
            waiting &&
            g === waiting.gate &&
            racer.elapsed > waiting.at + SAME_TICK &&
            racer.elapsed <= waiting.at + SPLIT_LATE_CAP_SECONDS
          ) {
            const gap = waiting.at - racer.elapsed
            if (behind === null || gap > behind.gap) {
              behind = { label: labels[r] as string, gap, ai: true }
            }
          }
        }
      }
      if (behind && waiting && shown && shown.gate === waiting.gate) {
        const arrived = waiting.at - behind.gap
        shown = {
          ...shown,
          entries: [...shown.entries, behind],
          until: Math.min(
            waiting.at + SPLIT_LATE_CAP_SECONDS,
            Math.max(shown.until, arrived + SPLIT_SECONDS / 2),
          ),
        }
        waiting = null
      }
    },
    playerPass(gate, t, total, ghost) {
      if (t < lastPlayerClock) {
        shown = null
        waiting = null
      }
      lastPlayerClock = t
      if (!isSplitGate(gate, total)) return null
      const ghostAt = ghost?.ringTimes[gate]
      if (ghost && ghostAt !== null && ghostAt !== undefined) {
        waiting = null
        shown = {
          gate,
          at: t,
          until: t + SPLIT_SECONDS,
          source: 'ghost',
          entries: [{ label: ghost.label, gap: t - ghostAt }],
        }
        return shown
      }
      // The racer just ahead: the latest stamp at this gate that is not after us.
      let ahead: SplitEntry | null = null
      let aheadAt = Number.NEGATIVE_INFINITY
      for (let r = 0; r < racerStamps.length; r += 1) {
        const at = (racerStamps[r] as number[])[gate]
        if (at === undefined || Number.isNaN(at) || at > t + SAME_TICK) continue
        if (at > aheadAt) {
          aheadAt = at
          ahead = { label: labels[r] as string, gap: t - at, ai: true }
        }
      }
      // Nobody racing, or nobody has a stamp yet and nobody will: no split.
      if (racerStamps.length === 0) {
        shown = null
        waiting = null
        return null
      }
      waiting = { gate, at: t }
      shown = {
        gate,
        at: t,
        until: t + SPLIT_SECONDS,
        source: 'field',
        entries: ahead ? [ahead] : [],
      }
      return shown
    },
    current(t) {
      if (!shown) return null
      if (t >= shown.until) {
        shown = null
        waiting = null
        return null
      }
      // Waiting for the racer behind and nobody ahead: nothing to say yet.
      return shown.entries.length === 0 ? null : shown
    },
    stamps(racer) {
      return racerStamps[racer] ?? []
    },
  }
}
