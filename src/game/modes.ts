// src/game/modes.ts — what a MODE is, as data fields instead of a branch.
//
// THREE-FREE: `game/mission.ts` imports this and runs headless.
//
// ── The seam ──────────────────────────────────────────────────────────────
//
// 2016 got this right and it is worth copying. `Level.Start()`
// (`Scripts/Level.cs:133-214`) does not change a single rule — it toggles two
// GameObject subtrees, `ringAttackParent` and `freeFlightParent`. Everything
// else a mode "does" is four separate components reading one string:
//
//     RaceTimer.cs:30       == "freeFlight" -> enabled = false      (the clock)
//     FuelManager.cs:30     == "freeFlight" -> shouldUpdateFuel = false
//     FreeFlightText.cs:9   == "freeFlight" -> the gate label becomes "Orbs:"
//     LevelEnd.cs:76-79     == "freeFlight" -> Exploration, the orb medal curve
//
// So a mode is: **which content is live, what scores, what ends the run, and
// what scale the medal is on.** One row per mode, no ladder. Adding a mode is
// adding a row — CLAUDE.md hard rule 6, and `docs/research/_modes-spec.md` §8.1.
//
// Nothing outside this file should ever ask "is the mode freeFlight?". It should
// ask the descriptor a question about behaviour, and
// `tests/unit/mode-rules.test.ts` asserts on those observables rather than on
// the flag — because "the clock is off" is a property a fourth mode can also
// have, and `mode === 'freeFlight'` is not. That test also scans `src/game/**`
// and `src/sim/**` for a mode NAME in code, which is what makes "a fourth mode
// is a row" checkable rather than aspirational.
//
// ── What is DELIBERATELY not here ─────────────────────────────────────────
//
// `GameMode_Manager` and `ModeManager` are dead in 2016 — zero live instances in
// any of the thirteen mission scenes, and `ModeManager` names five modes of
// which two survive. Do not read its list as evidence of shipped modes (§6.3).

import {
  type GameMode,
  type Level,
  LevelSchemaError,
  liveRings,
  type Medals,
} from '@/content/level-schema'
import { clockCountsInMedal, timeTermFor } from '@/game/medal-time'
import { liveOrbs } from '@/game/orbs'
import { arcadePadCeiling, livePads, maxPadScore } from '@/game/targets'

/** What a mode can put in the world and score against. */
export type CollectibleKind = 'ring' | 'orb' | 'padZone'

// ── The Target Practice medal — PROVISIONAL, and Matt's call ──────────────
//
// **There is no 2016 curve to port.** No medal is ever awarded in a JumpSeat
// mission, for three independent reasons (`_modes-spec.md` §5.1):
// `Trigger_Finish_JumpSeat.cs:19` has the `LevelEnd` lookup commented out;
// `LevelEnd.DelayedStart()` waits forever for a `ShipLogic`-tagged object the
// JumpSeat does not have, so it never finishes initialising; and
// `rookie_01_jumpSeat` has no `finale_logic` instance at all, which is why its
// `medalsExp` block is four nulls.
//
// The `medals` block in those six level JSONs (1600 / 2000 / 2600 / 3000) is a
// set of prefab-instance overrides that nothing reads — ring-attack numbers on a
// shared prefab. Against them the shipped FLAT ceilings are:
//
//   mission                live pads   @100/pad   @150/pad   bronze 1600
//   rookie_01_jumpSeat         5          500        750     -- (no thresholds)
//   rookie_02_jumpSeat         7          700       1050     unreachable
//   int_01_jumpSeat            6          600        900     unreachable
//   int_02_jumpSeat            9          900       1350     unreachable
//   adv_01_jumpSeat           10         1000       1500     unreachable
//   adv_02_jumpSeat           12         1200       1800     reachable ONLY at 150
//
// `tests/unit/mode-medals.test.ts` keeps that visible in CI: it asserts the
// shipped bronze stays unreachable, so the finding cannot quietly rot.
//
// FF2 does not award against those numbers. It awards against the ceiling of its
// OWN rule — the accuracy streak (`sim/targets.ts`) — and every figure below is
// computed by `arcadePadCeiling` from the three knobs in `game/targets.ts`, not
// typed here. Reproduced for the reader, and pinned by
// `tests/unit/pad-streak.test.ts` so a comment that drifts fails CI:
//
//   mission              pads   streak   clear   CEILING   bronze  silver  gold
//   rookie_01_jumpSeat      5     1500     500      2000      800    1200  1600
//   int_01_jumpSeat         6     2000     600      2600     1040    1560  2080
//   rookie_02_jumpSeat      7     2500     700      3200     1280    1920  2560
//   int_02_jumpSeat         9     3500     900      4400     1760    2640  3520
//   adv_01_jumpSeat        10     4000    1000      5000     2000    3000  4000
//   adv_02_jumpSeat        12     5000    1200      6200     2480    3720  4960

/**
 * The options from `_modes-spec.md` §9, as functions.
 *
 * - `padStreak`  **FF2's arcade rule, and the one that ships.** Fractions of the
 *                ceiling an ACCURACY STREAK can reach — see `sim/targets.ts` for
 *                the rule and `game/targets.ts` for its three knobs. Matt asked
 *                for this one by name, so it is an invention on purpose rather
 *                than a port with a gap in it.
 * - `padCount`   (b) count pads, not points. The option with a 2016 precedent:
 *                the game's one working non-ring curve is Free Flight's and it
 *                counts OBJECTS (3 / 5 / 9 / 12 orbs). The analogue is
 *                `jumpPadsLanded`, the counter 2016 kept and never used. It makes
 *                the 25/50/100 tiers decorative, which is what the streak fixes.
 * - `padPoints`  (a) fractions of the FLAT points ceiling. Self-scaling; nothing
 *                about it is 2016's, and with no multiplier the three tiers are
 *                worth 4:2:1 and nothing else.
 * - `shipped`    award against the 2016 `medals` block as it stands. Honest,
 *                and unreachable on five missions of six.
 * - `none`       (d) faithful: score only, no medal, ever.
 *
 * §9's option (c) — reviving the commented-out time bonus and fuel penalty — is
 * NOT here. It is a new design wearing 2016's variable names, it needs `parTime`
 * / `pointsPerSecond` / `fuelPenalty` that the extractor does not emit and the
 * spec itself carries second-hand (§11 item 3), and inventing them to make a
 * medal work is the exact move this project keeps getting burned by. The streak
 * is an invention too — but it is an invention with its own name on it, tuned
 * against measured pad spacing and a measured cruise speed, rather than four
 * dead prefab fields worn as a disguise.
 */
const MEDAL_RULES = {
  padCount: (level: Level): Medals | null => {
    const pads = livePads(level).length
    if (pads === 0) return null
    return {
      bronze: Math.ceil(pads * 0.4),
      silver: Math.ceil(pads * 0.6),
      gold: Math.ceil(pads * 0.8),
      platinum: pads,
    }
  },
  padPoints: (level: Level): Medals | null => fractionsOf(maxPadScore(level)),
  padStreak: (level: Level): Medals | null => fractionsOf(arcadePadCeiling(level)),
  shipped: (level: Level): Medals | null => level.medalsFf2 ?? level.medals,
  none: (): Medals | null => null,
} as const

/**
 * 40 / 60 / 80 / 100 % of a ceiling. Shared by both points rules ON PURPOSE.
 *
 * Not a fourth knob: the two rules differ in what they measure, not in how
 * generously they band it, and a second set of fractions would be a second thing
 * to keep in step. Platinum sits AT the ceiling because the ceiling is a run
 * somebody can fly (`streakCeiling` guarantees that) — platinum is "perfect", the
 * way Free Flight's own working curve puts platinum at every orb on
 * `rookie_01_hoverJet`.
 */
const fractionsOf = (ceiling: number): Medals | null =>
  ceiling === 0
    ? null
    : {
        bronze: Math.round(ceiling * 0.4),
        silver: Math.round(ceiling * 0.6),
        gold: Math.round(ceiling * 0.8),
        platinum: ceiling,
      }

export type TargetPracticeMedalRule = keyof typeof MEDAL_RULES

/**
 * **THE LINE.** Change this one identifier to take §9's decision.
 *
 * `'padStreak'` is Matt's call, taken this session: *"target practice — yeah,
 * this went in late and wasn't ever really satisfied with how it shipped. come up
 * with a arcade-feeling scoring method and let's use that."* It is NOT a ported
 * value — nothing in 2016 ever awarded a Target Practice medal — and it needs a
 * `docs/DEVIATIONS.md` row, as would every other entry here including `'none'`.
 *
 * Everything downstream follows from it: the scale below, the HUD, the results
 * panel and the tests. Nothing else has to change.
 */
export const TARGET_PRACTICE_MEDAL_RULE: TargetPracticeMedalRule = 'padStreak'

/**
 * Which number each rule's thresholds are compared against.
 *
 * A row per rule rather than a condition, for the same reason `MODES` is a row
 * per mode: the compiler then refuses a new rule that forgot to say. It is
 * derived and not a second switch — a curve of pad COUNTS compared against a pad
 * POINTS total would award platinum on pad one, and half a taken decision is
 * worse than none.
 */
const MEDAL_RULE_SCALE: Record<TargetPracticeMedalRule, 'points' | 'count'> = {
  padCount: 'count',
  padPoints: 'points',
  padStreak: 'points',
  shipped: 'points',
  // No curve at all, so the scale is unobservable. 'count' keeps a run that
  // switches to it reading `PADS: 03/06` against nothing, rather than silently
  // starting to add a time bonus to a score nobody is judging.
  none: 'count',
}

const TARGET_PRACTICE_MEDAL_SCALE: 'points' | 'count' = MEDAL_RULE_SCALE[TARGET_PRACTICE_MEDAL_RULE]

export interface ModeRules {
  /**
   * What exists in the world at all — 2016's two subtree toggles, plus the pads.
   *
   * **The pads are under NEITHER parent** (`levelOffset/jumpPad_group`,
   * `levelOffset/jumpPads`, or `levelOffset` itself, all authored active), so no
   * mode ever turns a target off and pad content is live in every mode (§6.1).
   */
  readonly live: readonly CollectibleKind[]
  /**
   * What actually banks a score. A subset of `live`, and the gap is real:
   * `rookie_02_jumpSeat` authors 29 rings AND 11 pads side by side with
   * `ringAttackParent` **null**, so nothing can ever switch those rings off —
   * and they still award zero, because `TriggerCheckpoint.cs:95` guards on an
   * `EnergySystem_Ship` the JumpSeat does not have. They play the sound, fade,
   * and score nothing. Scoring them in the port would invent 2,900 points 2016
   * never awarded (§7).
   */
  readonly scores: readonly CollectibleKind[]
  /** `'finishGate'` reads `game/targets.ts`'s `finishFor`; `'never'` is Free Flight. */
  readonly endsOn: 'finishGate' | 'never'
  /**
   * Seconds the run stays SCOREABLE after the finish volume is crossed.
   *
   * This exists because of a geometry trap on the Target Practice finish pad.
   * The finish slab spans pad-local y -0.458 .. +5.194 and the scoring plates
   * live at +1.167 and below, so **a descent enters the finish about 6.9 m above
   * the bullseye it is about to cross** — and at 2-5 m of travel per sim step,
   * committing the instant the slab is entered throws the finish pad's own 0-100
   * points away. 2016 hits the same wall and half-solves it the same way:
   * `LevelFinaleManager.cs:36` waits **0.1 s** before calling `CalcScore()`, and
   * `_modes-spec.md` §4.2 notes the resulting race and says the port should not
   * reproduce it. The number is 2016's; the other half of the fix is
   * `finishPadAirspace` in `game/targets.ts`.
   *
   * Zero for the other two: Ring Attack's finish is 234.6 m past the last ring
   * with nothing left to score, and a settle there would move every recorded
   * time by 0.1 s.
   */
  readonly finishSettleSeconds: number
  /**
   * Does the race clock run?
   *
   * False switches off the time bonus AND puts `--` on the HUD's TIME row,
   * which is the observable form of `RaceTimer.cs:30`.
   *
   * It does NOT decide whether the clock ENDS anything — see `clockEnds`,
   * which used to be this same flag and should not have been.
   */
  readonly clock: boolean
  /**
   * Does running out of time END the run?
   *
   * **Separate from `clock` because 2016 separates them, and collapsing the two
   * made two missions unwinnable.**
   *
   * `timer.timeLimit` is 180 on all thirteen. In Ring Attack the timeout means
   * something: `Timer_Race` calls `FindObjectOfType<Trigger_FinishLine>()` and
   * every HoverJet scene has one, so the clock ends the run.
   *
   * In Target Practice it means nothing. **No JumpSeat scene has a
   * `Trigger_FinishLine`**, so the same call returns null and the timeout
   * null-refs and does nothing — `timer.timeLimit` is a tuned, UNREAD field on
   * all six (`_modes-spec.md` §4.3, which lists a time limit as ❌ against a
   * finish trigger's ✅ and says "and only this").
   *
   * The port enforced it anyway, and it was measured: flying all six with
   * `sim/jumpseat-autopilot.ts`, **`adv_01_jumpSeat` and `adv_02_jumpSeat`
   * cannot be completed in 180 s.** Lift the clock and the same controller
   * finishes them at **229.5 s** (9/10 pads) and **242.4 s** (12/12, 5,950
   * points) — so it was the clock, not the route, the fuel or the controller.
   *
   * This is a FIDELITY fix and not a difficulty decision: 2016 does not end a
   * Target Practice run on time, the clock still runs and still shows, and the
   * finish pad is still the only way out. `docs/DEVIATIONS.md` DEV-056.
   */
  readonly clockEnds: boolean
  /**
   * Does the vehicle burn fuel?
   *
   * `FuelManager.cs:30` — the second of 2016's four switch-by-name behaviours. In
   * Free Flight you never run dry, and the pads' refuel spheres (`Trigger_Refuel`
   * at `refuelRate: 10`/s, live in all six pad missions) are decorative. It lives
   * here rather than on the vehicle for the same reason the clock does: it is a
   * property of the mode, and a vehicle that asked `level.mode` directly would
   * also be asking the wrong question, because `forcedMode` overrides it.
   */
  readonly burnsFuel: boolean
  /**
   * Does a fast run earn points?
   *
   * Its OWN field, and not a consequence of `medalScale === 'points'`, which is
   * what decided it until the accuracy streak landed. That coupling was invisible
   * and load-bearing: `scoring.timeAffectsMedal` is **true on all six JumpSeat
   * missions** with an 180 s par and an 11.5/s multiplier, so the moment Target
   * Practice moved onto a points scale it would have started quietly awarding up
   * to ~2,070 points for finishing early — more than the whole streak ceiling on
   * three of the six, and the exact thing the design is NOT (`sim/targets.ts`:
   * an accuracy streak, not a time chain). CLAUDE.md's agreement lesson, in its
   * usual shape: two rules that give the same answer everywhere anyone had looked.
   *
   * False here is also the faithful reading — `ScoreKeeper_JumpPads.CalcScore()`
   * computes `timeScore` at line 54 and throws it away at line 67.
   */
  readonly timeBonus: boolean
  /** `'points'` is rings/pads; `'count'` is a raw number of objects taken. */
  readonly medalScale: 'points' | 'count'
  /**
   * When the medal lands.
   *
   * `'onCrossing'` is 2016's Free Flight: `LevelEnd.cs:202-243` tests
   * `score == <that band's min>` — equality, not `>=` — so the banner fires once,
   * on the orb that crosses, mid-run, in the air. It is the only part of these
   * two modes that shipped working and it is worth keeping (§5.2).
   */
  readonly awardWhen: 'onCrossing' | 'atEnd'
  /** Fallback HUD count label. `countLabel` prefers the level's own 2016 string. */
  readonly countFallback: string
  /**
   * Does anyone else fly this mission — an AI racer, or a 2016 ghost?
   *
   * **Only Ring Attack.** An opponent is a RACE, and Target Practice is a score
   * attack against a dartboard while Free Flight is exploration; neither has
   * anyone to beat. Until this field existed `boot/app.ts` loaded two AI racers
   * unconditionally, so every JumpSeat mission had a pair of HoverJets racing a
   * ring course the mode does not score.
   *
   * ── This is NOT simply "2016 had none" ─────────────────────────────────
   *
   * Three JumpSeat scenes DO carry a `GhostRacer`: `adv_01_jumpSeat` and
   * `rookie_02_jumpSeat` two each, `adv_02_jumpSeat` four. So the naive reading
   * of the scenes says Target Practice has opponents.
   *
   * It does not. Measured across all thirteen missions, every ghost clip
   * against its own mission's environment:
   *
   *     12 of 12 HoverJet ghosts   the mission's OWN course
   *      8 of 8  JumpSeat ghosts   `rookie_01_*`, an ALPINE course
   *
   * `adv_02_jumpSeat` is on Simonet and `adv_01`/`rookie_02_jumpSeat` are in the
   * desert, and all three point at the same alpine clip. Twelve for twelve and
   * eight for eight, with nothing in between, is not a coincidence — it is a `GhostRacer` object dragged between
   * scenes with its clip pool still attached. Playing them would fly a HoverJet
   * down another island's racing line through a Target Practice mission.
   *
   * So the port shows none, and the reason on the record is the mismatch rather
   * than an absence that is not there. `docs/DEVIATIONS.md` DEV-055.
   */
  readonly opponents: boolean
  /**
   * Does the ship fly on a TANK that only a gate refills — and does running dry
   * end the run? DEV-144.
   *
   * The fourth row's whole reason to exist, expressed as a property so that
   * nothing outside this file has to ask *"is the mode energyRace?"*. `sim/
   * energy-race.ts` is the arithmetic and `boot/app.ts` asks this question.
   *
   * False on all three 2016 modes: `EnergySystem_Ship` recharges at 100/s
   * against a 32/s boost burn and does not drain from flying at all, so the
   * shipped game's tank cannot empty (DEV-002, DEV-143). It is NOT the same
   * thing as `burnsFuel`, which is the JumpSeat's `FuelManager` and belongs to
   * the other vehicle.
   */
  readonly energyPowered: boolean
  /**
   * Does boost never run out? DEV-853 (Matt, 2026-10-08: "Free Flight: give
   * infinite boost"). Free Flight is exploration with no clock and no fuel
   * (`burnsFuel`), so Anniversary's boost tank, which exists to make a race
   * choose its moments, has nothing to say there. The tank is held full and
   * the HUD bar stays full. Classic never steps the tank, so it is already
   * free. A property of the mode, as `burnsFuel` is, so a forced mode follows.
   */
  readonly infiniteBoost: boolean
  /**
   * Does this mode TEACH — is there an instructor, a step list and a lesson
   * plate? DEV-375.
   *
   * The fifth row's reason to exist, and the one question everything built on
   * it asks, so that nothing outside this file ever spells the row's name: the
   * lesson runner is built only where it is true (DEV-377); a level must carry a
   * `lesson` block exactly where its running mode teaches, which
   * {@link validateModeContent} enforces at load; the title's Learn to Fly pool
   * is the listed cards whose mode teaches (DEV-379); and the hangar's mark and
   * the results heading key on it.
   *
   * False on 2016's three and on DEV-144's `energyRace`. 2016 authored a
   * Training rank and switched it off (`button_training (1)`, `m_IsActive: 0`),
   * so no shipped mode taught — the historical hook, not a constraint.
   */
  readonly teaches: boolean
  /**
   * Can the autopilot be switched on (DEV-435)? Matt, 2026-09-26: *"unavailable
   * in free flight"*. There it has nothing to fly (orbs are taken in any order,
   * and the arrow points at nothing on purpose), so it showed AUTO while the
   * player kept the stick. P, the AUTO chip, a headset's held X and
   * `?autopilot=1` all read this.
   */
  readonly autopilot: boolean
  /**
   * Does the level select choose this mode's DIFFICULTY on the place's own
   * table (DEV-420)? Matt, 2026-09-26: *"instead of choosing difficulty and then
   * the terrain, let's combine the menu, so we go ring attack > terrain. on each
   * terrain holotable, we should indicate difficulty like a ski map (green
   * square, blue circle, black diamond)"*.
   *
   * True: the hangar walks plan -> place, and each place table stands a column
   * of ski-map marks, one per course there, and draws the picked course's route
   * (`render/hangar.ts`, `PlaceCard`). False: 2016's chain, plan -> rank ->
   * place. Ring Attack only: Matt named it, and the other plans' calls are his
   * (DEV-420's row). The same on both editions, as every level-select layout
   * change has been (DEV-203, DEV-354, DEV-379, DEV-419).
   */
  readonly difficultyOnPlace: boolean
  /**
   * Does the level select skip the RANK step with no marks in its place
   * (DEV-800)? Matt, 2026-10-07 ("go with your recs", QUESTIONS item 61):
   * 2016's `ChallengeSelection()` goes straight from Free Flight to
   * `page_environmentSelect`, so the plan opens onto its places and the place
   * tables carry no difficulty marks (one course a place, nothing to choose
   * between). `difficultyOnPlace`'s sibling, never both on one row: a mode that
   * carries its difficulty on the place skips the rank step by that flag.
   */
  readonly skipsRank: boolean
}

export const MODES: Record<GameMode, ModeRules> = {
  ringAttack: {
    live: ['ring', 'padZone'],
    scores: ['ring'],
    endsOn: 'finishGate',
    finishSettleSeconds: 0,
    clock: true,
    burnsFuel: true,
    // DEV-004 / DEV-014: 2016 computed a bonus and displayed it, FF2 lets it
    // count. This is the only mode it applies to.
    timeBonus: true,
    medalScale: 'points',
    awardWhen: 'atEnd',
    // `Gates:` -> `GATES`. The HUD appends its own colon, so the colon goes.
    clockEnds: true,
    countFallback: 'GATES',
    // The only mode that races. Two AI racers by default, or the 2016
    // recordings under `?opponents=ghosts`.
    opponents: true,
    // 2016's tank cannot empty — see the field's own note.
    energyPowered: false,
    infiniteBoost: false,
    teaches: false,
    autopilot: true,
    difficultyOnPlace: true,
    skipsRank: false,
  },
  targetPractice: {
    live: ['ring', 'padZone'],
    scores: ['padZone'],
    endsOn: 'finishGate',
    // `LevelFinaleManager.cs:36`'s `Delay_CalcScore`. See the field's own note.
    finishSettleSeconds: 0.1,
    // 2016 has NO time limit here: `timer.timeLimit = 180` is a tuned, unread
    // field on all six, and `int_01_jumpSeat`'s live clock calls
    // `FindObjectOfType<Trigger_FinishLine>()` — which no JumpSeat scene has —
    // and null-refs into nothing (§4.3, §6.5). The clock still RUNS (the run is
    // timed, and the results panel says so); it just cannot end anything, which
    // is what `endsOn` decides.
    clock: true,
    // ...and it ends NOTHING. No JumpSeat scene has a `Trigger_FinishLine`,
    // so `Timer_Race`'s timeout null-refs. Enforcing it made `adv_01` and
    // `adv_02` unwinnable — they finish at 229.5 s and 242.4 s. DEV-056.
    clockEnds: false,
    // Every pad is also a refuel pad, which only means something if the tank
    // is draining.
    burnsFuel: true,
    // The run is TIMED and the results panel says so — it is just not SCORED on
    // time. See the field's own note: this is where "accuracy, not a stopwatch"
    // is actually enforced.
    timeBonus: false,
    medalScale: TARGET_PRACTICE_MEDAL_SCALE,
    awardWhen: 'atEnd',
    // 2016 has no string for this row at all: the JumpSeat `ui.strings` set
    // carries a fuel gauge and no gate/orb label, and `HUD_Gameplay.UpdateUI()`
    // is commented out end to end (`:56-83`), so the in-mission HUD showed no
    // live score and no target count. FF2's word, and it is on the record here.
    countFallback: 'PADS',
    // A score attack against a dartboard. The three scenes that carry a
    // `GhostRacer` all point it at another environment's course — see the
    // field's own note.
    opponents: false,
    // The JumpSeat's tank is `FuelManager`'s and `burnsFuel` above is its
    // switch. A different tank, a different vehicle, a different mode.
    energyPowered: false,
    infiniteBoost: false,
    teaches: false,
    autopilot: true,
    // DEV-874 (Matt, 2026-10-08: "revise the jumpseat menu flow to match the
    // hover-jet's (locations w/ difficulty icons)"): Target Practice walks plan ->
    // place like Ring Attack, each location's table carrying the difficulty marks.
    difficultyOnPlace: true,
    skipsRank: false,
  },
  freeFlight: {
    live: ['orb', 'padZone'],
    scores: ['orb'],
    // `Trigger_FinishLine` is not under `ringAttackParent` and is not switched
    // off — but Free Flight is exploration and 2016 ends it from the menu
    // (`Exploration EnDing...`), never from a gate. Nothing in `LevelEnd`'s Free
    // Flight path waits for one, and the medal has already been awarded in the
    // air by then.
    endsOn: 'never',
    finishSettleSeconds: 0,
    clock: false,
    // `FuelManager.cs:30`. In Free Flight the tank never drains.
    burnsFuel: false,
    // No clock to earn one against — `RaceTimer.cs:30` disables itself.
    timeBonus: false,
    medalScale: 'count',
    awardWhen: 'onCrossing',
    // `Orbs FounD:` -> `ORBS`. The port drops 2016's stray capital D with the
    // rest of the word; it is a label, not a sentence.
    // No clock at all, so nothing to end. `endsOn: 'never'` says the same
    // thing from the other side; both are here because a future mode could
    // have a clock that does not end it, which is exactly Target Practice.
    clockEnds: false,
    countFallback: 'ORBS',
    // Exploration. 2016 ends it from the menu, not from a finish line, and
    // there is nobody to end it against.
    opponents: false,
    // Exploration with a fuel clock would be a contradiction.
    energyPowered: false,
    // DEV-853: Free Flight's boost never runs out.
    infiniteBoost: true,
    teaches: false,
    autopilot: false,
    difficultyOnPlace: false,
    skipsRank: true,
  },
  // ── DEV-144 — THE FOURTH ROW ──────────────────────────────────────────
  //
  // *"Gates give energy, run dry and you fall."* Ring Attack, with a tank
  // under it that only a gate refills. The whole mode is the last field: every
  // other line is `ringAttack`'s, deliberately and not by accident — it is the
  // SAME course, the same live content, the same scorer, the same finish gate,
  // the same clock and the same medal curve. What changes is that the ship can
  // run out.
  //
  // That is the claim `modes.ts` was built to make cheap (§8.1 of
  // `_modes-spec.md`, CLAUDE.md hard rule 6): a mode is which content is live,
  // what scores, what ends the run and what scale the medal is on — one row, no
  // ladder. This row is the first test of it since the three were written, and
  // it cost one new FIELD and no branch anywhere.
  //
  // `opponents: true` is a real decision rather than a copied line: the racers
  // fly `sim/ai-racer.ts` with no tank, so in this mode they are immortal and
  // the player is not. See the DEV-144 row's open questions.
  energyRace: {
    live: ['ring', 'padZone'],
    scores: ['ring'],
    endsOn: 'finishGate',
    finishSettleSeconds: 0,
    clock: true,
    clockEnds: true,
    burnsFuel: true,
    timeBonus: true,
    medalScale: 'points',
    awardWhen: 'atEnd',
    countFallback: 'GATES',
    opponents: true,
    energyPowered: true,
    infiniteBoost: false,
    teaches: false,
    autopilot: true,
    difficultyOnPlace: false,
    skipsRank: false,
  },
  // ── DEV-375 — THE FIFTH ROW: a lesson ─────────────────────────────────
  //
  // *"want to learn to fly - add an ai-pilot flight instructor course through
  // the canyon"* (Matt, 2026-09-24). Neither existing row can carry it
  // (`docs/plan/FLIGHT-INSTRUCTOR.md` §4.3): Free Flight does not make rings
  // live, so the canyon's gates would not be drawn; Ring Attack runs a clock
  // that ENDS the run at 180 s, when a learner's ~50 m/s is 3.5 to 4 minutes of
  // flying before any waiting, and it puts racers on the grid, pays a time
  // bonus, awards a medal and joins Quick Race's pool.
  //
  // So: Ring Attack's course and scorer, with the clock, the bonus, the medal
  // and the opponents taken away, and the one new field set. "Flight School" in
  // the hangar (`mission-index.ts`), "Learn to Fly" on the title (DEV-379).
  lesson: {
    live: ['ring', 'padZone'],
    // The HUD counts rings, and `next-target.ts` asks this same list, so the
    // next-gate arrow points at the next one for free.
    scores: ['ring'],
    endsOn: 'finishGate',
    finishSettleSeconds: 0,
    // A lesson is not timed: a player may stop at any time and the instructor
    // waits (plan §5.4). No clock, so nothing for it to end.
    clock: false,
    clockEnds: false,
    // Nothing to learn about a tank that can empty; the HoverJet's cannot
    // (DEV-002), and a JumpSeat lesson is a later course with its own row.
    burnsFuel: false,
    timeBonus: false,
    // No medal on a lesson (Matt's call 11): the course's `medals` are four
    // nulls and `complete()` turns that into "none". The scale is 'count' so a
    // run reads `GATES: 03/21`, never a points total nobody is judging.
    medalScale: 'count',
    awardWhen: 'atEnd',
    countFallback: 'GATES',
    // The instructor is NOT an opponent: not in `racers`, the standings, the
    // results or the race map. DEV-146's ambient traffic is the precedent for a
    // population that is not the race.
    opponents: false,
    energyPowered: false,
    infiniteBoost: false,
    teaches: true,
    autopilot: true,
    difficultyOnPlace: false,
    skipsRank: false,
  },
}

export const rulesFor = (mode: GameMode): ModeRules => MODES[mode]

/**
 * Throws on a level whose modes and whose lesson disagree. DEV-375.
 *
 * `validateLevel` (`content/level-schema.ts`) checks a lesson block's SHAPE and
 * cannot ask this, because the answer is a mode ROW and the rows live here —
 * so `loadLevel` runs both, and a level reaches the game only through it.
 *
 * Two questions, both about the level as it runs when nothing requests a mode
 * (`runningMode(level)`, the mode the menus file it under):
 *
 * 1. **Is every mode it names a row?** A typo in a hand-authored file's `mode`
 *    would otherwise surface as `MODES[mode]` being undefined, far from the
 *    file, on the first rules question anybody asked.
 * 2. **Does it carry a lesson exactly where that mode teaches?** A teaching
 *    mode with no lesson is a runner with no steps; a lesson on a mode that does
 *    not teach is a block nothing would ever read.
 *
 * It asks the ROW, never the name — `modes` is injectable so a test can prove
 * that by flipping `teaches` on a different row.
 */
export const validateModeContent = (
  level: Level,
  modes: Readonly<Record<string, Pick<ModeRules, 'teaches'>>> = MODES,
): Level => {
  const named = [level.mode, level.forcedMode, level.forcedModeFf2?.mode]
  for (const mode of named) {
    if (mode !== null && mode !== undefined && !Object.hasOwn(modes, mode)) {
      throw new LevelSchemaError(
        level.id,
        `mode ${JSON.stringify(mode)} is not a row in game/modes.ts; known: ` +
          Object.keys(modes).join(', '),
      )
    }
  }
  const mode = runningMode(level)
  const teaches = (modes[mode] as Pick<ModeRules, 'teaches'>).teaches
  const hasLesson = level.lesson !== null && level.lesson !== undefined
  if (teaches && !hasLesson) {
    throw new LevelSchemaError(
      level.id,
      `runs in ${JSON.stringify(mode)}, a mode that teaches, and carries no lesson block`,
    )
  }
  if (!teaches && hasLesson) {
    throw new LevelSchemaError(
      level.id,
      `carries a lesson block but runs in ${JSON.stringify(mode)}, a mode that does not teach`,
    )
  }
  // 3. **A lesson carries no medal thresholds** (DEV-377). `medalCurve` awards
  //    nothing where the mode teaches whatever the file says, so a number here
  //    is a threshold nothing reads — and a reader of the file would believe it.
  if (teaches) {
    const numbered = (m: unknown): boolean =>
      typeof m === 'object' &&
      m !== null &&
      (['bronze', 'silver', 'gold', 'platinum'] as const).some(
        (k) => typeof (m as Record<string, unknown>)[k] === 'number',
      )
    for (const [field, value] of [
      ['medals', level.medals],
      ['medalsFf2', level.medalsFf2],
    ] as const) {
      if (numbered(value)) {
        throw new LevelSchemaError(
          level.id,
          `runs in ${JSON.stringify(mode)}, a mode that teaches and awards no medal, and its ` +
            `${field} carries thresholds; a lesson's are four nulls`,
        )
      }
    }
  }
  return level
}

/**
 * The mode the title's Quick Race boards (DEV-353). Matt: *"a random HoverJet
 * Ring Attack course"*. Spelled HERE because this is the one file allowed to
 * spell a mode (`mode-rules.test.ts`); `game/quick-race.ts` reads it.
 */
export const QUICK_RACE_MODE: GameMode = 'ringAttack'

/**
 * The mode a run is actually played in.
 *
 * `Level.ReadGameMode()` (`Scripts/Level.cs:96-120`): `if (ForceGameMode)
 * GameMode = ForcedGameMode; else <read the player's choice>`. Exactly two
 * shipped scenes force one — `int_02_jumpSeat` and `hoverJet_kauai_beg`, both to
 * Free Flight — and the `null` on the other eleven is MEANINGFUL, not unknown:
 * three of them carry `ForcedGameMode = 1` with the flag off, and it is inert.
 *
 * This is `forcedMode`'s one consumer. It had none, which is why kauai shipped
 * with the 21 rings, the race timer and the ring medal curve that 2016's Free
 * Flight switches off by name (§6.2, §6.6, NEXT.md claim 2).
 *
 * ── DEV-061: FF2 drops ONE of the two forcings ────────────────────────────
 *
 * `level.forcedModeFf2` is FF2's own decision and it wins where it exists.
 * `int_02_jumpSeat` carries `{ mode: null }` — *force nothing* — because 2016
 * locks it into Free Flight while every one of its twelve orbs ships
 * deactivated and nine of its eleven jump pads are live: the forced mode scores
 * nothing and the live content belongs to the JumpSeat default. Kauai's forcing
 * is coherent (all eleven orbs live) and is honoured untouched.
 *
 * **`forcedModeFf2 ?? forcedMode` would be wrong**, because the FF2 value is
 * itself null; the ternary is load-bearing and the object wrapper exists to make
 * the `??` version a type error. `level.mode` already follows the same decision
 * (the extractor derives it), so the two halves cannot drift apart.
 */
export const runningMode = (level: Level, requested?: GameMode): GameMode =>
  (level.forcedModeFf2 ? level.forcedModeFf2.mode : level.forcedMode) ??
  (requested !== undefined && requestKeepsTeaching(level, requested) ? requested : undefined) ??
  level.mode

/**
 * May a `?mode=` request run on this level? Only if it does not change whether
 * the run TEACHES. DEV-377.
 *
 * `validateModeContent` makes a level's own running mode teach exactly where
 * the level carries a lesson. A request could undo that from outside the file:
 * Ring Attack on a lesson course runs the rings with five racers and the lesson
 * block unread, and a teaching mode on a course with no lesson is a runner with
 * no steps (DEV-375's open note). So a request that crosses the line is not
 * honoured, and the level's own mode runs — the posture `?mode=` already has
 * for a request the preset will not honour, and for a level that forces a mode.
 *
 * Asked of the ROW and the BLOCK, never of a name. `tools/perf/vehicle-mode-
 * sweep.mjs` carries a copy of this rule over the raw JSON, and
 * `vehicle-mode-cross.test.ts` holds the two equal on every level and request.
 */
export const requestKeepsTeaching = (level: Level, requested: GameMode): boolean => {
  const row = MODES[requested] as ModeRules | undefined
  if (!row) return false
  const hasLesson = level.lesson !== null && level.lesson !== undefined
  return row.teaches === hasLesson
}

export const scores = (mode: GameMode, kind: CollectibleKind): boolean =>
  MODES[mode].scores.includes(kind)

/** Should the renderer build this content at all? 2016's subtree toggle. */
export const isLive = (mode: GameMode, kind: CollectibleKind): boolean =>
  MODES[mode].live.includes(kind)

/**
 * What the HUD's first row is called.
 *
 * The label comes from the level's own extracted 2016 strings where the mission
 * has one — `gatesLabel` is `Gates:` and `orbsFound` is `Orbs FounD:` on the
 * HoverJet set — and from `countFallback` where it does not. The JumpSeat set has
 * neither, so Target Practice is the port's word either way.
 */
export const countLabel = (level: Level, mode: GameMode): string => {
  const strings = level.ui?.strings ?? {}
  const scored = MODES[mode].scores
  // Asks the descriptor what this mode counts, not what it is called.
  const source = scored.includes('ring')
    ? strings.gatesLabel
    : scored.includes('orb')
      ? strings.orbsFound
      : undefined
  if (!source) return MODES[mode].countFallback
  return (source.split(' ')[0] ?? '').replace(/\s*:$/, '').toUpperCase()
}

/** How many of the objective there are to take. The HUD's denominator. */
export const countTotal = (level: Level, mode: GameMode): number => {
  const rules = MODES[mode]
  if (rules.scores.includes('orb')) return liveOrbs(level).length
  if (rules.scores.includes('padZone')) return livePads(level).length
  // `liveRings` is that expression, exported once (DEV-210). Spelling it out here made a
  // third independent derivation of "the course" that could drift from the other two.
  return liveRings(level).length
}

/**
 * LOCAL VIEW — **collapse into `Level` in `src/content/level-schema.ts`.**
 *
 * `tools/extract/level.mjs` emits `medalsExp` for all thirteen missions and the
 * `Level` interface does not declare it, which is the whole reason nothing in
 * the port could read Free Flight's curve (`FIND-modes-25`). Four nulls on
 * `rookie_01_jumpSeat`, which has no `finale_logic` instance to read them from.
 */
type LevelWithExp = Level & {
  readonly medalsExp?: Readonly<Record<keyof Medals, number | null>> | null
}

/**
 * The thresholds a medal is awarded against, or null when this mode awards none.
 *
 * Free Flight's are 2016's own, and they are a RAW ORB COUNT — 3 / 5 / 9 / 12,
 * never `x 100` (`LevelEnd.cs:185-192`). Two shipped missions are one orb short
 * of platinum (`hoverJet_kauai_beg` and `int_01_hoverJet`, 11 live orbs against
 * 12), the same arithmetic shape as `rookie_01_hoverJet`'s 16 rings against
 * 1700 — which Matt ruled a bug to fix (DEV-003). **DEV-393 fixes it, out loud:**
 * a count can never ask for more objects than the course has live, so every
 * orb there is platinum (see {@link withinReach}). 2016's numbers stay in the
 * JSON; this is what FF2 awards against.
 */
export const medalCurve = (level: Level, mode: GameMode): Medals | null => {
  // No medal on a lesson (Matt's call 11), as a RULE of the row rather than a
  // fact about the file: DEV-375 left it resting on four nulls that nothing
  // refused, so a lesson file that forgot them would have awarded one. DEV-377.
  // An unknown mode has no row: `cardFor` must still word a fourteenth mission
  // in a fifth mode (`mission-index.test.ts`, "never hides a mission behind an
  // unknown key"), and that test went red when this line read the row bare.
  const row = MODES[mode] as (typeof MODES)[GameMode] | undefined
  if (row?.teaches) return null
  if (mode === 'freeFlight') {
    // Counted only once there is a curve to hold: a card built from a level
    // with no curve has nothing to count against, and may carry no orbs at all.
    const curve = complete((level as LevelWithExp).medalsExp ?? null)
    return curve && withinReach(curve, countTotal(level, mode))
  }
  if (mode === 'targetPractice') return complete(MEDAL_RULES[TARGET_PRACTICE_MEDAL_RULE](level))
  // FF2's ring thresholds, falling back to 2016's. `medalsFf2` is 2016's with
  // platinum at every ring (the DEV-393 follow-up), and it is GENERATED
  // (`tools/extract/level.mjs`), so the rule lives with the data, not here.
  const base = complete(level.medalsFf2 ?? level.medals)
  return base && withTimePlatinum(level, mode, base)
}

/**
 * DEV-846: where the clock counts in the medal (`game/medal-time.ts`), platinum
 * is every ring PLUS a share of the time term, so a slow clean lap is gold and a
 * quick one platinum. The ring part is held to the course's own ceiling, so the
 * bar can never ask for more rings than exist (`rookie_01_hoverJet`'s lesson);
 * bronze, silver and gold stay ring counts.
 */
const withTimePlatinum = (level: Level, mode: GameMode, base: Medals): Medals => {
  if (!clockCountsInMedal(level, rulesFor(mode))) return base
  const term = timeTermFor(level) as NonNullable<ReturnType<typeof timeTermFor>>
  const ceiling = liveRings(level).reduce(
    (sum, r) => sum + r.scoring.addScore * level.scoring.gateMultiplier,
    0,
  )
  return { ...base, platinum: Math.min(base.platinum, ceiling) + term.platinumPoints }
}

/**
 * A COUNT curve that asks for no more objects than exist. DEV-393.
 *
 * On a count scale a threshold IS a number of objects, so one above `live`
 * cannot be met by any run, however perfect — `hoverJet_kauai_beg`'s platinum
 * asked for 12 orbs of 11. Each threshold is held to `live`, which makes taking
 * every one of them platinum, and leaves a threshold that was reachable exactly
 * where 2016 put it.
 *
 * `live === 0` is left alone ON PURPOSE: holding four thresholds to zero would
 * award platinum for doing nothing, the trap `complete` below exists for. A
 * course with nothing to take keeps a curve nothing can meet, and reads `none`.
 */
const withinReach = (curve: Medals, live: number): Medals =>
  live <= 0
    ? curve
    : {
        bronze: Math.min(curve.bronze, live),
        silver: Math.min(curve.silver, live),
        gold: Math.min(curve.gold, live),
        platinum: Math.min(curve.platinum, live),
      }

/**
 * Four numbers, or nothing. **A missing threshold is not a threshold of zero.**
 *
 * `rookie_01_jumpSeat` ships `medals` AND `medalsExp` as four nulls, because it
 * has no `finale_logic` instance for the extractor to read them from — and
 * `Level.medals` is typed `Medals`, four `number`s, so TypeScript does not see
 * it. `awardMedal(0, { bronze: null, … })` evaluates `0 >= null` as `0 >= 0` and
 * hands back **platinum, instantly, for doing nothing**. That is live today on
 * `?mission=rookie_01_jumpSeat`.
 *
 * So null it is, and null means "this mission awards no medal", which is exactly
 * what 2016 does there.
 */
const complete = (
  medals: Readonly<Record<keyof Medals, number | null>> | null | undefined,
): Medals | null => {
  if (!medals) return null
  const { bronze, silver, gold, platinum } = medals
  if (
    typeof bronze !== 'number' ||
    typeof silver !== 'number' ||
    typeof gold !== 'number' ||
    typeof platinum !== 'number'
  ) {
    return null
  }
  return { bronze, silver, gold, platinum }
}

/**
 * DEV-631: the Anniversary briefing's words, by mode and then by vehicle. Here
 * because this is the one file allowed to spell a mode's name
 * (`tests/unit/mode-rules.test.ts`); `game/briefing-copy.ts` reads it and says
 * where each claim was checked against the rules. `withoutRingBoost` is the
 * sentence for a rule set whose rings pay the boost tank nothing.
 */
export interface BriefingWords {
  readonly text: string
  readonly withoutRingBoost?: string
}

export const BRIEFING_WORDS: Readonly<
  Partial<Record<GameMode, Readonly<Partial<Record<string, BriefingWords>>>>>
> = {
  ringAttack: {
    hoverjet: {
      text: "Rings give boost and increase top speed. Don't Crash!!",
      withoutRingBoost: "Rings increase top speed. Don't Crash!!",
    },
  },
  energyRace: {
    hoverjet: { text: "Rings refill your tank. Run dry and you fall. Don't Crash!!" },
  },
  freeFlight: {
    hoverjet: { text: "No clock here. Collect orbs to earn medals. Don't Crash!!" },
  },
  targetPractice: {
    jumpseat: { text: 'Target pads refuel your craft. See how far you can get.' },
  },
}
