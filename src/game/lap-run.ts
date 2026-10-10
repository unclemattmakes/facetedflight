// src/game/lap-run.ts — recording the player's lap, keeping it, and choosing the
// ghost the next run races. DEV-371.
//
// DEV-370 built the recorder and the format and wired nothing. This is the
// wiring, as one object `boot/app.ts` calls at five points of its fixed step,
// so the rules about WHICH tick is which live here, under a unit test, rather
// than spread through a 14,000-line closure:
//
//   release  — the lift lets go. Tick 0, the pose BEFORE the first flight step,
//              which is where `mission.elapsed` reads 0.
//   placed   — a crash reset PUT the ship where it is this step (DEV-126).
//   restart  — a mid-flight restart (the boundary, an empty tank): the mission
//              clock went back to zero with the ship on the respawn marker, so
//              the lap starts again there.
//   step     — after `stepMission`, every step: tick k is the pose AFTER step k,
//              the position `stepMission` scored, at `mission.elapsed = k × dt`.
//              On the finish tick the lap is cut, rescored from its own poses,
//              and offered to the store. DEV-571: the results panel then asks
//              "save as your ghost?", and `keepLast` is its answer, either way.
//   newRun   — another go. Picks the ghost: your kept best by default (§8
//              call 8), the lap just flown ("race this lap"), or whatever the
//              player chose for this course — none, or a shared lap (DEV-373).
//
// And the run's TAINT (`game/run-taint.ts`), because the lap is the thing it is
// a property of.
//
// ── The ghost's clock is not the mission's ───────────────────────────────
//
// `mission.elapsed` stops when the player crosses the line (`stepMission`
// returns before adding `dt`), and a ghost driven by it stops in mid-air with
// the panel up, which is exactly what DEV-344 found the 2016 recordings doing.
// So the run keeps its own sum: the same `dt` added the same number of times
// while the mission runs, so it IS `mission.elapsed` to the bit until the
// finish, and it keeps going after it.
//
// THREE-FREE and DOM-FREE: storage is injected. The ghost's drawing half is
// `game/ghosts.ts`'s `loadPlayerGhost`.

import type { Level } from '@/content/level-schema'
import { courseGates } from '@/game/mission'
import { FIXED_DT } from '@/sim/constants'
import { decodeGhostClip, type GhostCourse, type LapDoc, scoreGhost } from '@/sim/ghost'
import {
  clearLap,
  createLapRecorder,
  type LapRecorder,
  markLapEvent,
  recordedLap,
  recordPose,
} from '@/sim/ghost-record'
import type { Quat } from '@/sim/math/quat'
import type { Vec3 } from '@/sim/math/vec3'
import {
  keepLap,
  type LapCandidate,
  type LapSlot,
  readLap,
  readLapText,
  restoreLapText,
  type StoredLap,
  writeLap,
} from './ghost-store'
import { safeStorage } from './personal-best'
import { createRunTaint, isTainted, type RunTaint, resetRunTaint, taintRun } from './run-taint'
import { recordingHeld } from './tv/off-the-record'

/**
 * The course a lap is scored on. The level JSON is THREE space and the sim is
 * that mirrored in z, so the finish sphere is flipped here exactly as
 * `game/mission.ts` and `game/racers.ts` flip theirs; a course with none falls
 * back to "every gate taken", which is `runIsOver`'s rule.
 */
export const ghostCourse = (
  level: Level,
  worldOffset: readonly [number, number, number],
): GhostCourse => ({
  gates: courseGates(level),
  finish: level.finish
    ? {
        x: level.finish.pos[0] as number,
        y: level.finish.pos[1] as number,
        z: -(level.finish.pos[2] as number),
        radius: level.finish.radius,
      }
    : null,
  worldOffset,
})

/** What a lap's own poses say it did. */
export interface LapResult {
  /** Mission seconds at the finish, or null for a lap that never crosses it. */
  readonly seconds: number | null
  readonly gates: number
  /** Mission seconds each ring was taken, null for a miss. The HUD split reads these. */
  readonly ringTimes: readonly (number | null)[]
}

/**
 * Rescore a lap from its poses: `scoreGhost`, at the fixed step, with the ring
 * times. The standing the results panel shows and the time the store compares
 * are THIS, never a claimed number — the rule DEV-372's server keeps too.
 */
export const lapResult = (doc: LapDoc, course: GhostCourse): LapResult => {
  const r = scoreGhost(decodeGhostClip(doc), course, FIXED_DT, { ringTimes: true })
  return { seconds: r.seconds, gates: r.gates, ringTimes: r.ringTimes ?? [] }
}

/** A lap a run finished. */
export interface FlownLap extends LapResult {
  readonly doc: LapDoc
  readonly tainted: boolean
  readonly reasons: readonly string[]
  /** The tick the live run crossed the finish on. */
  readonly finishTick: number
  /** It beat what the store held. */
  readonly improved: boolean
  /** It was written. */
  readonly stored: boolean
  /** How long cutting, rescoring and storing it took, ms. Measured by the caller's clock. */
  readonly keptMs: number
  /**
   * DEV-571: the seconds of the lap saved for this course before this one
   * finished, or null when none was. The results panel's keep question names
   * it ("your saved 61.2 s ghost is faster").
   */
  readonly savedBefore: number | null
}

/** The ghost a run races. */
export interface RaceGhost {
  readonly doc: LapDoc
  /**
   * `best`: the kept lap for this course. `this-lap`: "race this lap".
   * `shared`: somebody's posted lap — a `?ghost=` link, or a board entry the
   * hangar's ghost line picked (DEV-373).
   */
  readonly source: 'best' | 'this-lap' | 'shared'
  readonly result: LapResult
  readonly tainted: boolean
  /** Whose: the poster's handle for a `shared` lap, null for your own. */
  readonly handle: string | null
}

/**
 * Which ghost the player CHOSE for this course (DEV-373): the default, your
 * kept best; none at all; or a shared lap, already fetched and decoded. Asked
 * at every new run, so a choice made in the hangar holds for every retry until
 * it is changed. "Race this lap" outranks it for the one run it asks for.
 */
export type ChosenGhost =
  | { readonly kind: 'best' }
  | { readonly kind: 'none' }
  | { readonly kind: 'shared'; readonly doc: LapDoc; readonly handle: string }

/**
 * The split at a ring: seconds BEHIND the ghost (positive) or ahead of it
 * (negative), or null where there is nothing to compare — no ghost, or a ring
 * the ghost missed.
 */
export const ghostSplit = (
  ghost: RaceGhost | null,
  ring: number,
  missionSeconds: number,
): number | null => {
  const at = ghost?.result.ringTimes[ring]
  return at === null || at === undefined ? null : missionSeconds - at
}

/**
 * DEV-856: what a ghost is CALLED where the player reads it (a split, the tag
 * over its ship): the poster's handle for a shared lap, `YOUR GHOST` for your
 * own. Capitals, as the UI sets them.
 */
export const ghostName = (ghost: Pick<RaceGhost, 'handle'>): string =>
  ghost.handle ? ghost.handle.toUpperCase() : 'YOUR GHOST'

/**
 * DEV-856: the tag over the ghost's ship, `YOUR GHOST 61.2`: its name and the
 * lap time it is flying (tenths, as the results print them), or just the name
 * for a lap that never crosses the line. Null for no ghost.
 */
export const ghostTagText = (ghost: RaceGhost | null): string | null => {
  if (!ghost) return null
  const seconds = ghost.result.seconds
  return seconds === null ? ghostName(ghost) : `${ghostName(ghost)} ${seconds.toFixed(1)}`
}

/**
 * `GHOST -0.42`: minus is ahead, as every racing game's split reads. Hundredths,
 * where the results panel prints tenths: a ring-to-ring gap is often under a
 * tenth, and a split that reads `+0.0` for a real deficit teaches nothing.
 */
export const splitText = (split: number): string =>
  `GHOST ${split < 0 ? '-' : '+'}${Math.abs(split).toFixed(2)}`

export interface LapRunOptions {
  readonly level: Level
  readonly worldOffset: readonly [number, number, number]
  /** The rules the run is scored under — `RUNNING_MODE`, as the best's key uses. */
  readonly mode: string
  readonly build: string
  /**
   * The `rules` a lap flown under `edition` carries: DEV-372's
   * `lapRules(mission, edition)` where the lap server has a board for it, and
   * `LOCAL_LAP_RULES` where it has none. A function, because the preset can
   * flip between laps. It is also what a kept lap must match to be raced as
   * your best: a lap under stale rules is not comparable, and is replaced.
   */
  readonly rulesFor: (edition: string) => string
  /** DEV-372's `lapVehicle(level.vehicle, variant)`: `hoverjet`, or `hoverjet:speed`. */
  readonly vehicle: string
  /** The aircraft variant the flight was built as (`flight.variant`, DEV-380). */
  readonly variant: string
  /** `urlTaint(location.search)`, taken once at boot. */
  readonly urlTaint: readonly string[]
  /**
   * The ghost the player chose for this course (DEV-373), asked at each new
   * run. Absent is your kept best, which is DEV-371's default.
   */
  readonly chosen?: () => ChosenGhost
  readonly storage?:
    | (Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>)
    | null
  /** A clock for `keptMs`. `performance.now` in the app; anything in a test. */
  readonly now?: () => number
}

/** The sim body's pose, as the flight model leaves it: SIM space. */
export interface BodyPose {
  readonly position: Vec3
  readonly orientation: Quat
}

export interface LapRun {
  /** Ticks since the release, or -1 before it. */
  readonly tick: number
  /** Mission seconds since the release; runs on past the finish (see the header). */
  readonly clock: number
  readonly taint: RunTaint
  /** The lap THIS run finished, or null (until it does, and for a run that did not). */
  readonly last: FlownLap | null
  /** The ghost this run races, or null. */
  readonly ghost: RaceGhost | null
  /** Another go. `raceLap` races the lap just flown; otherwise the kept best. */
  newRun(edition: string, raceLap?: boolean): RaceGhost | null
  /** Something other than the player flew, or the rules moved. */
  taintRun(reason: string): void
  /** The ship was let go. Tick 0; a no-op once the run has one. */
  release(body: BodyPose, edition: string): void
  /** A crash reset placed the ship this step. */
  placed(): void
  /** The mission clock went back to zero mid-flight, with the ship placed. */
  restart(body: BodyPose, edition: string): void
  /**
   * After `stepMission`, every fixed step. Returns the lap on the tick it
   * crosses the finish, and null otherwise.
   */
  step(
    dt: number,
    body: BodyPose,
    mission: { readonly ring: number; readonly finishCrossed: boolean; readonly finished: boolean },
    edition: string,
  ): FlownLap | null
  /** The kept lap for this course under `edition`, as the store holds it. */
  stored(edition: string): StoredLap | null
  /**
   * DEV-571: is the lap on the panel (`last`) saved as your ghost right now?
   * Null with no lap on the panel, or one that can never be saved here (no
   * storage, or TV's hold).
   */
  readonly lastKept: boolean | null
  /**
   * DEV-571: the panel's answer to "save as your ghost?". True writes `last`
   * over whatever is saved; false puts back what was saved before it finished.
   * Returns `lastKept` after: unchanged when the store would not take it.
   */
  keepLast(yes: boolean): boolean | null
}

export const createLapRun = (options: LapRunOptions): LapRun => {
  const { level, worldOffset, mode, build, urlTaint, rulesFor, vehicle, variant } = options
  const slot = (edition: string): LapSlot => ({
    mission: level.id,
    mode,
    edition,
    rules: rulesFor(edition),
    vehicle,
    variant,
  })
  const storage = options.storage === undefined ? safeStorage() : options.storage
  const now = options.now ?? (() => 0)
  const course = ghostCourse(level, worldOffset)
  // The recorder never grows on a race: `timeLimit / FIXED_DT` ticks is the
  // clock's own end. A course with no limit starts at a minute and doubles.
  const capacity = level.timer.timeLimit > 0 ? Math.ceil(level.timer.timeLimit / FIXED_DT) + 2 : 0
  const rec: LapRecorder = createLapRecorder(worldOffset, capacity || undefined)
  const taint = createRunTaint(urlTaint)

  let tick = -1
  let clock = 0
  let done = false
  let placedPending = false
  let lapEdition: string | null = null
  let last: FlownLap | null = null
  let ghost: RaceGhost | null = null
  /** DEV-571: what `keepLast` needs to say yes or no to `last`. */
  let pending: {
    readonly lap: LapCandidate
    readonly before: string | null
    kept: boolean
    readonly keepable: boolean
  } | null = null

  const begin = (body: BodyPose, edition: string): void => {
    clearLap(rec)
    tick = 0
    clock = 0
    done = false
    placedPending = false
    lapEdition = edition
    recordPose(rec, 0, body.position, body.orientation)
  }

  const finish = (finishTick: number, edition: string): FlownLap => {
    const t0 = now()
    const doc = recordedLap(rec, {
      mission: level.id,
      mode,
      edition,
      rules: rulesFor(edition),
      vehicle,
      build,
    })
    const result = lapResult(doc, course)
    const tainted = isTainted(taint)
    const reasons = [...taint.reasons]
    const candidate: LapCandidate = {
      doc,
      seconds: result.seconds,
      gates: result.gates,
      tainted,
      reasons,
    }
    // DEV-571: what was saved before, as text (a "no" puts it back) and as
    // seconds (the panel's question names it).
    const before = readLapText(doc, variant, storage)
    const savedBefore = readLap(slot(edition), storage)?.seconds ?? null
    const kept = keepLap(candidate, variant, storage)
    pending = {
      lap: candidate,
      before,
      kept: kept.stored,
      // The store is asked again at each press; a lap that never finished, or
      // one under TV's hold (nothing is recorded there), can never be saved.
      keepable: storage !== null && result.seconds !== null && !recordingHeld(),
    }
    return {
      ...result,
      doc,
      tainted,
      reasons,
      finishTick,
      improved: kept.improved,
      stored: kept.stored,
      keptMs: now() - t0,
      savedBefore,
    }
  }

  return {
    get tick() {
      return tick
    },
    get clock() {
      return clock
    },
    taint,
    get last() {
      return last
    },
    get ghost() {
      return ghost
    },

    newRun(edition, raceLap = false) {
      const chosen = options.chosen?.() ?? { kind: 'best' }
      if (raceLap && last) {
        ghost = {
          doc: last.doc,
          source: 'this-lap',
          result: last,
          tainted: last.tainted,
          handle: null,
        }
      } else if (chosen.kind === 'none') {
        ghost = null
      } else if (
        chosen.kind === 'shared' &&
        chosen.doc.mission === level.id &&
        chosen.doc.mode === mode
      ) {
        // Somebody else's lap (DEV-373). Only on the course it was flown on:
        // its poses are relative to THIS level's `worldOffset`, and on another
        // course it would fly through the scenery. Rescored here, as a kept
        // lap is, so the standing is what its own poses say; its rules are
        // not checked, because racing a lap asks nothing of them — a lap from
        // before a rules change still flies the same line (§8 call 6).
        ghost = {
          doc: chosen.doc,
          source: 'shared',
          result: lapResult(chosen.doc, course),
          tainted: false,
          handle: chosen.handle,
        }
      } else {
        const best = readLap(slot(edition), storage)
        ghost = best
          ? {
              doc: best.doc,
              source: 'best',
              // Rescored rather than read back: the stored seconds are the
              // store's to compare, and a standing on the panel must come from
              // the poses the ghost actually flies.
              result: lapResult(best.doc, course),
              tainted: best.tainted,
              handle: null,
            }
          : null
      }
      last = null
      pending = null
      tick = -1
      clock = 0
      done = false
      placedPending = false
      lapEdition = null
      clearLap(rec)
      resetRunTaint(taint, urlTaint)
      return ghost
    },

    taintRun(reason) {
      taintRun(taint, reason)
    },

    release(body, edition) {
      if (tick >= 0) return
      begin(body, edition)
    },

    placed() {
      placedPending = true
    },

    restart(body, edition) {
      // NOT a new run: the player did not choose it, and whatever flew any of
      // this go keeps the taint it earned.
      //
      // The lap simply STARTS on the marker, with no `reset` event at tick 0:
      // an event marks the step INTO a placed pose, and tick 0 has no step
      // before it. DEV-372's validator refuses a reset at tick 0 ("has no pose
      // to be placed at") and accepts a first key on the respawn marker, which
      // is the run this was. `scoreGhost` seeds its first step either way.
      begin(body, edition)
    },

    step(dt, body, mission, edition) {
      if (tick < 0) return null
      clock += dt
      if (done) return null
      if (mission.finished && !mission.finishCrossed) {
        // The clock ended the run. No finish, no lap.
        done = true
        return null
      }
      tick += 1
      recordPose(rec, tick, body.position, body.orientation)
      if (placedPending) {
        markLapEvent(rec, tick, 'reset')
        placedPending = false
      }
      if (mission.ring >= 0) markLapEvent(rec, tick, 'gate')
      // The lap is filed under ONE preset's rules; a flip mid-lap mixed two.
      if (edition !== lapEdition) taintRun(taint, 'edition changed mid-lap')
      if (!mission.finishCrossed) return null
      markLapEvent(rec, tick, 'finish')
      done = true
      last = finish(tick, edition)
      return last
    },

    stored(edition) {
      return readLap(slot(edition), storage)
    },

    get lastKept() {
      return last !== null && pending?.keepable ? pending.kept : null
    },

    keepLast(yes) {
      if (last === null || pending === null || !pending.keepable) return null
      if (yes === pending.kept) return pending.kept
      const done = yes
        ? writeLap(pending.lap, variant, storage)
        : restoreLapText(pending.lap.doc, variant, pending.before, storage)
      if (done) pending.kept = yes
      return pending.kept
    },
  }
}
