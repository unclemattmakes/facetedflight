// src/game/results-state.ts — what the results panel is TOLD, separate from how
// it draws it (DEV-344).
//
// The panel's state used to be one object literal in `boot/app.ts`, built once
// on the tick the run ended. Both defects DEV-344 fixes lived in that literal,
// where no unit test could reach them:
//
//  · **The opposition was read once.** A racer still in the air when you crossed
//    the line printed `DNF` and stayed that way; an autopilot that beat all five
//    racers on `int_01_hoverJet` got a board of five DNFs, and the one that
//    crossed five seconds later never appeared. The run's own numbers are fixed
//    when it ends; the RACE is not over until the last racer is home, so the
//    standings are re-read every frame the panel is up (`withStandings`).
//  · **The count was ring-shaped in every mode.** Target Practice counts pads in
//    `mission.counted` and leaves the ring counters at 0, so a perfect
//    `adv_01_jumpSeat` board read `0/0 PADS` under a HUD that had just said
//    `ALL 10 PADS`, and printed a `+ 0 time` term for a mode whose rules earn
//    no time bonus at all.
//
// Renderer-free by design: it reads the mission and the racers and returns
// plain data, so `tests/unit/results-state.test.ts` pins what the panel says
// without a canvas.

import type { GameMode, Level } from '@/content/level-schema'
import { uiLabelWord } from '@/content/ui-strings'
import { type MissionState, missionScore } from '@/game/mission'
import { countLabel, rulesFor } from '@/game/modes'
import { nextMedalLine } from '@/game/next-medal'
import type {
  OpponentStanding,
  ResultsState,
  RunSummary,
  Standing,
  StandingStatus,
} from '@/render/results'

/**
 * The clock that ends a RACE, in seconds, or 0 where the clock ends nothing.
 *
 * `clockEnds`, not `clock`, for the reason `game/modes.ts` separates them: the
 * clock runs in Target Practice and ends nothing (DEV-056). Where it does end a
 * run it ends everybody's — a racer still flying when it runs out has run out of
 * time exactly as the player would have, and that is the one thing on this
 * panel that is a genuine DNF for a live racer.
 */
export const raceTimeLimit = (level: Level, mode: GameMode): number =>
  rulesFor(mode).clockEnds && level.timer.timeLimit > 0 ? level.timer.timeLimit : 0

/**
 * What a racer is CALLED on a board (DEV-651): its callsign where the race drew
 * one, else its tuning id. The id stays its identity everywhere else.
 */
export const racerName = (spec: {
  readonly id: string
  readonly callsign?: string | null
}): string => spec.callsign ?? spec.id

/** What `racerStanding` reads off a live `AiRacer`. */
export interface RacerReading {
  readonly spec: { readonly id: string; readonly callsign?: string | null }
  readonly finished: boolean
  readonly finishedAt: number
  /** Its own race clock, which keeps running after the player's has stopped. */
  readonly elapsed: number
}

/**
 * A live AI racer, right now.
 *
 * `flying` until it crosses, and it only becomes `dnf` when the race clock
 * (`raceTimeLimit`) runs out on it — or it crossed after that clock would have
 * ended its run, which is the same thing measured late. Nothing else ends a
 * live racer's race: the crash rule puts it back on the line (DEV-126) and
 * DEV-180's escape pulls it out of a tree.
 *
 * Every live racer is an AI (DEV-854): the board tags it. A room's humans never
 * come through here.
 */
export const racerStanding = (racer: RacerReading, timeLimit: number): OpponentStanding => {
  const name = racerName(racer.spec)
  const limited = timeLimit > 0
  if (racer.finished && !(limited && racer.finishedAt > timeLimit)) {
    return { name, seconds: racer.finishedAt, status: 'finished', ai: true }
  }
  if (limited && racer.elapsed >= timeLimit) return { name, seconds: null, status: 'dnf', ai: true }
  return { name, seconds: null, status: 'flying', ai: true }
}

/**
 * A 2016 recording under `?opponents=ghosts`.
 *
 * Its result is known at load (`scoreGhost`), so it is never `flying`: a clip
 * that never crosses the finish is a DNF for ever, and one that crosses after
 * the race clock is out of time under the same rule as a live racer.
 */
export const ghostStanding = (
  ghost: { readonly name: string; readonly seconds: number | null },
  timeLimit: number,
): OpponentStanding =>
  ghost.seconds === null || (timeLimit > 0 && ghost.seconds > timeLimit)
    ? { name: ghost.name, seconds: null, status: 'dnf' }
    : { name: ghost.name, seconds: ghost.seconds, status: 'finished' }

/** What the caller knows and the mission does not. */
export interface RunExtras {
  readonly medal: string
  readonly best: number | null
  readonly improved: boolean
  readonly again: string
  readonly back: string
  readonly countLabel: string
  /** DEV-371: "race this lap", worded for the input route, or '' where there is no lap. */
  readonly race?: string
  /** DEV-601: why there is no best, where it is not storage, or absent. */
  readonly bestNote?: string
  /** DEV-650: what the next medal takes (`game/next-medal.ts`), or absent. */
  readonly next?: string | null
}

/**
 * What the boot knows on the tick a run ends, as plain facts, for
 * {@link runExtras}. APP-SPLIT 2.1: these were read inline at the one call
 * site in `boot/app.ts`, where no test could reach the wording or the rules.
 */
export interface RunEndFacts {
  readonly level: Level
  readonly mode: GameMode
  readonly medal: string
  /**
   * `recordRun`'s answer, or null for a run that keeps no best (a part of a
   * course, DEV-469).
   */
  readonly outcome: { readonly best: { readonly score: number }; readonly improved: boolean } | null
  /** The autopilot flew part of the run (DEV-601), so it keeps no best. */
  readonly autopilotFlew?: boolean
  /**
   * DEV-650: the number the medal was read from (`medalInput(mission)`), for
   * the "what would the next medal take" line. Absent says nothing.
   */
  readonly medalInput?: number
  /**
   * Is there storage to have kept the best in? Asked only when there is an
   * outcome, exactly as the call site asked it, so a call here is a call there.
   */
  readonly storageAvailable: () => boolean
  /** The run was flown from the course editor (`EDITOR_RUN.request`). */
  readonly fromEditor: boolean
  /** This run left a lap to race (`lapRun.last`). */
  readonly lapLeft: boolean
  /**
   * The device the panel's prompts are worded for (DEV-599): the headset while
   * one presents, else the last flat device used (`app.ts`'s `confirmDevice`).
   */
  readonly device: () => ResultsDevice
}

/** `render/controls-menu.ts`'s `ControlsDevice`, named here so this module stays render-free. */
export type ResultsDevice = 'xr' | 'touch' | 'keyboard' | 'pad'

/**
 * The results panel's buttons in ONE device's words. DEV-599.
 *
 * The panel said `A or ENTER`, `START or BACKSPACE` and `Y or R`: a pad's
 * button and a keyboard's key on every line, to every player (the 2026-10-03
 * persona playtest, row 15), and in a headset `START or BACKSPACE` named two
 * things the hands do not have. Now each line names the control of the device
 * in use, the way `chooseWords` words the plates' footers.
 *
 * - `home`: the confirm. A on a pad and in a headset (the right hand's A),
 *   ENTER on a keyboard (`CONFIRM_KEYS`), a tap on the screen on a phone
 *   (DEV-607 took the CONTINUE chip away).
 * - `again`: the pause control, which is another go here (DEV-406). START on
 *   a pad, BACKSPACE on a keyboard (Escape pauses too, but a captured pointer
 *   spends it on letting go), the left hand's X in a headset (`input/xr.ts`),
 *   the FLY AGAIN chip on a phone.
 * - `race`: Y on a pad, R on a keyboard, the right stick's click in a
 *   headset (DEV-371), the RACE THIS LAP chip on a phone.
 *
 * The touch words are the chips' own labels (`AGAIN_LABEL`,
 * `RACE_LAP_LABEL`); `results-state.test.ts` holds them to those, since this
 * module does not import the DOM overlay that owns them.
 */
export const resultsWords = (
  device: ResultsDevice,
): { readonly home: string; readonly again: string; readonly race: string } =>
  ({
    pad: { home: 'A', again: 'START', race: 'Y' },
    keyboard: { home: 'ENTER', again: 'BACKSPACE', race: 'R' },
    xr: { home: 'A', again: 'X', race: 'CLICK THE RIGHT STICK' },
    // DEV-607: no CONTINUE chip any more; a tap on the glass is the way home.
    touch: { home: 'tap the screen', again: 'tap FLY AGAIN', race: 'tap RACE THIS LAP' },
  })[device]

/**
 * The share prompt's line under the panel (DEV-571): how to take a row of the
 * menu below it, in the device's words (DEV-599). A headset's laser picks with
 * the trigger as well as A; a phone taps the row itself.
 */
export const rowBelowWords = (device: ResultsDevice): string =>
  device === 'xr'
    ? 'A or the TRIGGER on a row below'
    : device === 'touch'
      ? 'tap a row below'
      : `${resultsWords(device).home} on a row below`

/** The panel's words and the best, from the facts at the run's end. */
export const runExtras = (f: RunEndFacts): RunExtras => ({
  medal: f.medal,
  // Null when nothing could be stored — a private window, or storage
  // off. The panel says so rather than showing this run as the best.
  best: f.outcome && f.storageAvailable() ? f.outcome.best.score : null,
  improved: f.outcome?.improved ?? false,
  ...(f.autopilotFlew ? { bestNote: AUTOPILOT_BEST_NOTE } : {}),
  // DEV-406: the two lines swapped meanings, and the field names are
  // now positional (`again` is the primary line, `back` the second).
  // The confirm is the way home; the pause button is another go. DEV-599:
  // each in the words of the device in use (`resultsWords`), where they
  // were a pad's and a keyboard's at once.
  again: `${resultsWords(f.device()).home} for the ${f.fromEditor ? 'editor' : 'hangar'}`,
  back: `${resultsWords(f.device()).again} to fly again`,
  // `Gates cleared:` -> `GATES`, and the MODE's own word where the
  // objective is not rings. The panel has room for one.
  countLabel: uiLabelWord(f.level, 'gatesCleared', countLabel(f.level, f.mode)),
  // DEV-371: offered only when this run left a lap. Worded for the
  // route in use, because in a headset Y is the other hand's pause.
  race: f.lapLeft ? `${resultsWords(f.device()).race} to race this lap` : '',
  // DEV-650: a medal the autopilot "won" has no next one to take (DEV-601).
  next:
    f.autopilotFlew || f.medalInput === undefined
      ? null
      : nextMedalLine(f.level, f.mode, f.medalInput),
})

/** The results panel's headline for a lesson (DEV-379, FLIGHT-INSTRUCTOR §7). */
export const LESSON_COMPLETE = 'LESSON COMPLETE'

/**
 * The panel's headline where it is not the medal: {@link LESSON_COMPLETE}
 * where the mode TEACHES — the mode row's own question, never its name — and
 * nothing otherwise, which draws the medal as it always has.
 */
export const resultsHeading = (mode: GameMode, autopilotFlew = false): string | undefined =>
  rulesFor(mode).teaches ? LESSON_COMPLETE : autopilotFlew ? AUTOPILOT_HEADING : undefined

/**
 * The headline of a run the autopilot flew any of, where the medal goes
 * (DEV-601). The 2026-10-03 persona playtest finished a Quick Race on the
 * autopilot from ring 2, sixth of six, under PLATINUM and NEW BEST: a medal and
 * a best the player did not fly, the leaderboard alone refusing it.
 */
export const AUTOPILOT_HEADING = 'AUTOPILOT'

/** The best line's words for such a run, where it would otherwise blame storage. */
export const AUTOPILOT_BEST_NOTE = 'kept only for laps you fly'

/**
 * The run's own numbers — everything on the panel that is fixed the tick it
 * ended. Taken ONCE, by the same guard that records the best.
 */
export const summariseRun = (mission: MissionState, extras: RunExtras): RunSummary => ({
  medal: extras.medal,
  heading: resultsHeading(mission.mode, mission.autopilotFlew),
  // The OBJECTIVE's count, which is what the HUD's numerator is — rings in Ring
  // Attack, pads in Target Practice, orbs in Free Flight. `ringsPassed` is
  // ring-shaped on purpose (the speed chain and the gate burst want rings) and
  // is 0 on every JumpSeat mission, which is how a perfect Target Practice
  // board read `0/0 PADS`.
  gates: mission.counted,
  gatesTotal: mission.countTotal,
  timeSeconds: mission.elapsed,
  ringScore: mission.score,
  // Null where the MODE's rules earn none, so the panel prints no term rather
  // than a `+ 0 time` that implies time could have been worth something.
  // Target Practice's rule is the reason the field exists (`modes.ts`).
  timeBonus: rulesFor(mission.mode).timeBonus ? mission.timeBonus : null,
  // DEV-393: a missed ring forfeits the bonus, and the panel says how many.
  timeBonusForfeit: mission.timeBonusForfeit,
  // G1's pool and G2's record (DEV-110). Both are 0 on Classic, where the specs
  // cannot produce either, and `results.ts` draws nothing for a 0. NOT added
  // into `score`: that is what medals read.
  proximityBonus: mission.proximity.bonus,
  cleanStreak: mission.gateEvents.bestCleanStreak,
  score: missionScore(mission),
  // The crossing, on the same clock the racers' `finishedAt` is on, or null for
  // a run the clock ended. A run that did not cross the line has no place.
  finishedAt: mission.finishCrossed ? mission.finishAt : null,
  best: extras.best,
  improved: extras.improved,
  ...(extras.bestNote ? { bestNote: extras.bestNote } : {}),
  again: extras.again,
  back: extras.back,
  countLabel: extras.countLabel,
  race: extras.race ?? '',
  next: extras.next ?? null,
})

const RANK: Record<StandingStatus, number> = { finished: 0, flying: 1, dnf: 2 }

/**
 * The run, and the race as it stands NOW.
 *
 * Called every frame the panel is up, with the opposition re-read each time —
 * so a racer's time fills in the frame it crosses. The player's place is final
 * from the moment they cross (anybody still flying crosses later on the same
 * clock), and that is what makes it safe to state while others are still out.
 *
 * With no opposition there is no race, and the board is empty rather than a
 * list of one.
 */
export const withStandings = (
  run: RunSummary,
  opponents: readonly OpponentStanding[],
  ghosts: readonly OpponentStanding[] = [],
  youCallsign: string | null = null,
): ResultsState => {
  if (opponents.length === 0 && ghosts.length === 0) {
    return { ...run, standings: [], place: null, field: 0 }
  }
  const mine = run.finishedAt
  const entries: OpponentStanding[] = [
    // `YOU` first, so a dead heat lists the player above the racer it tied.
    mine === null
      ? { name: 'you', seconds: null, status: 'dnf' }
      : { name: 'you', seconds: mine, status: 'finished' },
    ...opponents,
  ]
  // ── A player's ghost is on the BOARD and not in the RACE (DEV-371) ────────
  //
  // It is listed in time order with everybody, so the panel says whether you
  // beat it, and it takes no place and does not count in the field. It is a
  // recording of you — a benchmark, the way a time trial's ghost is — and the
  // race map's live place (DEV-361) is measured over the racers alone, so a
  // board that placed it would say `1ST OF 7` beside a map that said `P1/6`.
  // Last on a dead heat, so a lap raced against itself reads YOU, then it.
  const order = [
    ...entries.map((entry, i) => ({ entry, you: i === 0, ghost: false })),
    ...ghosts.map((entry) => ({ entry, you: false, ghost: true })),
  ].sort(
    (a, b) =>
      RANK[a.entry.status] - RANK[b.entry.status] ||
      (a.entry.seconds ?? 0) - (b.entry.seconds ?? 0),
  )
  // A place is one more than the number who crossed STRICTLY sooner, so a dead
  // heat shares it rather than being split by list order.
  const placeOf = (seconds: number): number =>
    1 + entries.filter((e) => e.status === 'finished' && (e.seconds as number) < seconds).length
  const standings: Standing[] = order.map(({ entry, you, ghost }) => ({
    ...entry,
    you,
    // DEV-855: the player's own callsign rides on their line, to sit beside YOU.
    ...(you && youCallsign ? { callsign: youCallsign } : {}),
    ghost,
    place: !ghost && entry.status === 'finished' ? placeOf(entry.seconds as number) : null,
    // Beaten: the player crossed, and this racer did not cross first. A racer
    // still flying is beaten already — it crosses later on the same clock — and
    // one the race clock ran out on never will.
    beaten:
      !you && mine !== null && !(entry.status === 'finished' && (entry.seconds as number) <= mine),
  }))
  // No racers is no race, whatever ghost flew: nothing to place among.
  const raced = opponents.length > 0
  return {
    ...run,
    standings,
    place: !raced || mine === null ? null : placeOf(mine),
    field: raced ? entries.length : 0,
  }
}
