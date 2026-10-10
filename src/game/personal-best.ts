// src/game/personal-best.ts — the number that makes you fly it again.
//
// PORT_PLAN M4, product P1: *"Revision 1's entire reward surface was
// `score = rings × 100` ... The loop was: fly, collect all 21 in a generous
// 180 s window, get platinum, close the tab. That is a demo, not a game, and it
// is the link being sent to strangers and to the 2016 Steam audience."*
//
// A best is the cheapest fix for that and the only one that needs no server, no
// account and no second mission. It is also the thing a results screen has to
// have before "play again" means anything.
//
// ── Why this is not in `src/sim` ─────────────────────────────────────────
//
// `localStorage` is DOM, and the sim layer may not touch it (rule 4). It is not
// a sim concern either: nothing about the flight model changes because you beat
// your best.
//
// ── Every read and write is wrapped, and that is not defensive noise ─────
//
// `localStorage` THROWS on access — not returns null, throws — in a private
// window with site data blocked, and in some embedded webviews. An unguarded
// read at boot takes the whole app down before the first frame, for a feature
// nobody would miss. The same rule the artifact guidance gives for browser
// storage, and the same one king-tide learned.
//
// It also has to survive garbage: this is a public URL, the key is visible in
// devtools, and a hand-edited `"best": "platinum"` must not put `NaN` on the
// results panel.

import { STANDARD_VARIANT_ID } from '@/content/aircraft-schema'
import { safeLocalStorage } from '@/game/storage'
import { recordingHeld } from '@/game/tv/off-the-record'

/** One mission's best, as stored. */
export interface PersonalBest {
  /** `missionScore` — rings plus the time bonus. */
  readonly score: number
  /** Seconds, at the moment the run ended. */
  readonly timeSeconds: number
  /**
   * The objective's count: rings, pads or orbs by mode. Bests stored before
   * DEV-344 hold the RING count here, which is 0 for every Target Practice run.
   */
  readonly gates: number
  /** `Date.now()` when it was set. Display only; never compared. */
  readonly setAt: number
}

/** What a finished run offers up. */
export interface RunResult {
  readonly score: number
  readonly timeSeconds: number
  readonly gates: number
}

/**
 * What a best that MISSED part of its objective can be worth today. DEV-393.
 *
 * Built from the level by `bestRule` (`game/best-medal.ts`), because this file
 * is storage and knows no course. Null where the mode pays no time bonus, since
 * then no stored score can carry one and there is nothing to read differently.
 */
export interface BestRule {
  /** The objective's total. A best that counted this many is clean and read as stored. */
  readonly total: number
  /** `worth[k]`: the most `k` of the objective can score with no time bonus. */
  readonly worth: readonly number[]
}

/**
 * A stored best, read under DEV-393's rule — a missed objective forfeits the
 * time bonus.
 *
 * Bests set before DEV-393 on a run that missed a ring and crossed the finish
 * carry a bonus the rule no longer pays: `int_01_hoverJet` flown to the finish
 * with no rings stored ~1,771 and wore a silver on its table. The record keeps
 * no split between rings and time, but it keeps the COUNT, and `k` rings can
 * be worth at most `worth[k]` — so the stored score is held there. On every
 * shipped course a ring is worth the same 100 and this is exact: the bonus
 * comes off and the rings stay.
 *
 * A clean best, and every best on a mode with no bonus, reads byte for byte as
 * it always did. Nothing is rewritten on read — the same posture as
 * {@link legacyBestKey}: the first run that beats the held score replaces the
 * record, and until then it is simply read as what it is worth.
 */
export const underRule = (
  best: PersonalBest | null,
  rule: BestRule | null | undefined,
): PersonalBest | null => {
  if (best === null || !rule || best.gates >= rule.total) return best
  const cap = rule.worth[Math.max(0, Math.floor(best.gates))]
  return cap !== undefined && best.score > cap ? { ...best, score: cap } : best
}

const KEY_PREFIX = 'ff2.best.'

/**
 * Namespaced per mission id AND per mode, so M6's second course does not
 * overwrite this one and a course flown under two sets of rules keeps two bests.
 *
 * ── Why the mode is in the key at all (DEV-204) ──────────────────────────
 *
 * Matt, 2026-09-17: *"free flight should be a mode. so aircraft > mode >
 * difficulty > location."* Once the mode is a step of the menu rather than a
 * property nobody chooses, the same course can in principle be offered under
 * more than one set of rules — and a score is only comparable to another score
 * under the same rules. `hoverJet_kauai_beg` is already `int_01_hoverJet`'s
 * course authored twice and forced to a different mode; the day either forcing
 * moves, a single per-mission key silently compares a Ring Attack score with a
 * Free Flight count.
 *
 * ── And why ONE namespace for all four modes ─────────────────────────────
 *
 * 2016 split it. `LevelEnd.cs:205-237` writes `PlayerPrefs[levelName +
 * gameMode + " medal"]`, and `levelName` is the ENVIRONMENT on a Free Flight
 * run (`"simonet_islands" + "freeFlight"`) and the SCENE NAME on a Ring Attack
 * one (`"adv_02_hoverJet" + "ringAttack"`) — two key shapes for one record.
 * `docs/research/03-game-modes-and-levels.md` calls that *"an inconsistency FF2
 * should not reproduce"*, and Matt chose the single namespace on 2026-09-17.
 * A row in `docs/DEVIATIONS.md` records the departure.
 *
 * The version suffix is the escape hatch for a scoring change: DEV-014 already
 * moved the medal thresholds once, and a best set under different arithmetic is
 * not a best, it is a number that makes the delta lie. Bump it and every stored
 * best is ignored rather than migrated.
 *
 * ── And the AIRCRAFT VARIANT, since DEV-382 ──────────────────────────────
 *
 * A speed-variant lap is not comparable with a standard one, so records are
 * per variant (AIRCRAFT-VARIANTS §6.3, Matt's call: shared medal thresholds,
 * per-variant records). `standard` keeps today's key BYTE FOR BYTE, so every
 * best already stored is the standard's with no migration; any other variant
 * gets its own segment, `ff2.best.<id>.<mode>.<variant>.v1`, and can never
 * overwrite a standard record. Classic reads only the standard's.
 *
 * ── And the COURSE, since DEV-538 ────────────────────────────────────────
 *
 * A shipped mission can be edited by an override (`content/overrides/`,
 * plan/SHIPPED-COURSE-EDITS §6.2), and a best set on 2016's course is not a
 * best on the edited one. Matt's call 3 (2026-09-30): fresh bests. So a level
 * whose course an override changed carries `courseKey` (`Level.courseKey`,
 * eight hex of the course body) and its bests get one more segment,
 * `ff2.best.<id>.<mode>[.<variant>].c<key>.v1`. **Absent on every course as
 * 2016 shipped it, so today's keys are unchanged BYTE FOR BYTE** — the
 * variant segment's own precedent — and an override reverted to the baseline
 * gets its old bests back. Pass `level.courseKey`; never build one here.
 */
export const bestKey = (
  missionId: string,
  mode: string,
  variant: string = STANDARD_VARIANT_ID,
  course: string | null = null,
): string =>
  `${KEY_PREFIX}${missionId}.${mode}${variant === STANDARD_VARIANT_ID ? '' : `.${variant}`}${
    course ? `.c${course}` : ''
  }.v1`

/**
 * The key bests were stored under before the mode joined it (DEV-204).
 *
 * **Read-through only, and never written.** Real players have these in real
 * browsers and orphaning them silently is not an option a fidelity ledger would
 * accept — but neither is a migration pass that rewrites storage at boot, which
 * is a write on a read path and a thing that can half-finish. So
 * {@link readBest} falls back to this key when the moded one is absent, and
 * {@link recordRun} always writes the moded one. A player keeps their best; the
 * first time they beat it, the record moves forward on its own and the old key
 * is simply never consulted again.
 *
 * The attribution is unambiguous because a mission runs in exactly one mode at
 * a time (`game/modes.ts`'s `runningMode`), so a legacy best can only ever have
 * been set under the mode that mission runs in now.
 */
export const legacyBestKey = (missionId: string): string => `${KEY_PREFIX}${missionId}.v1`

/** A stored value that is not a plausible result is treated as absent. */
const parse = (raw: string | null): PersonalBest | null => {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<PersonalBest>
    // A real number, finite, not negative. `typeof` rather than `Number(...)`
    // because coercion accepts too much: `Number(null)` is 0 and `Number('')`
    // is 0, so a key edited to `"gates": null` would come back as a best with
    // zero gates instead of being thrown away. A hand-edited key is a
    // public-URL certainty.
    const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
    if (!ok(v.score) || !ok(v.timeSeconds) || !ok(v.gates)) return null
    return {
      score: v.score,
      timeSeconds: v.timeSeconds,
      gates: v.gates,
      // Display only and never compared, so a record missing it is still a
      // usable best. Discarding it would silently reset someone.
      setAt: ok(v.setAt) ? v.setAt : 0,
    }
  } catch {
    return null
  }
}

/**
 * The stored best, or null.
 *
 * `storage` is injectable so the tests need no DOM and can hand in a store that
 * throws — which is the case that matters and the one a jsdom mock never
 * reproduces by accident.
 *
 * Falls through to {@link legacyBestKey} when the moded key is absent, so
 * DEV-204 costs nobody a best they already have. Never writes the fallback
 * forward: see `legacyBestKey` for why a read path does not migrate.
 *
 * `variant` is the aircraft variant's id (DEV-382). The legacy fallback is the
 * STANDARD's alone: that key predates variants, so it can only have been set
 * by 2016's machine, and a speed variant with no record of its own has none.
 *
 * `rule` reads the record under today's scoring (DEV-393, {@link underRule}).
 * Every caller with a level in hand passes `bestRule(level, mode)`.
 *
 * `course` is `level.courseKey` (DEV-538): an edited course reads its own
 * record, and never the legacy one, which can only have been set on 2016's.
 */
export const readBest = (
  missionId: string,
  mode: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage(),
  variant: string = STANDARD_VARIANT_ID,
  rule: BestRule | null = null,
  course: string | null = null,
): PersonalBest | null => {
  if (!storage) return null
  try {
    return underRule(
      parse(storage.getItem(bestKey(missionId, mode, variant, course))) ??
        (variant === STANDARD_VARIANT_ID && !course
          ? parse(storage.getItem(legacyBestKey(missionId)))
          : null),
      rule,
    )
  } catch {
    return null
  }
}

/**
 * Record a run if it beats the stored best, and say what happened.
 *
 * Returns the best that now stands and whether this run set it, so the caller
 * can say "NEW BEST" without reading back and guessing.
 *
 * **Ties do not count.** Repeating your exact score is not an improvement, and
 * flashing NEW BEST at it devalues the one time it means something.
 *
 * `variant` is the aircraft variant the run was flown in (DEV-382): compared
 * with, and written to, that variant's record only.
 *
 * `rule` (DEV-393): the stored best is compared as it reads TODAY, so a best
 * that kept a time bonus its missed ring no longer earns cannot out-rank a run
 * that took more.
 *
 * `course` (DEV-538): `level.courseKey`, so a run on an edited course is
 * compared with, and written to, that course's record only.
 */
export const recordRun = (
  missionId: string,
  mode: string,
  run: RunResult,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage(),
  variant: string = STANDARD_VARIANT_ID,
  rule: BestRule | null = null,
  course: string | null = null,
): { best: PersonalBest; improved: boolean; previous: PersonalBest | null } => {
  const previous = readBest(missionId, mode, storage, variant, rule, course)
  const candidate: PersonalBest = {
    score: run.score,
    timeSeconds: run.timeSeconds,
    gates: run.gates,
    setAt: Date.now(),
  }
  // DEV-483: while TV's exhibition holds the record doors, nothing is written
  // and nothing is a new best (`game/tv/off-the-record.ts`). Every medal,
  // completion mark and holotable reads this store, so this one line is all
  // of them.
  if (recordingHeld()) return { best: previous ?? candidate, improved: false, previous }
  const improved = previous === null || run.score > previous.score
  if (!improved) return { best: previous as PersonalBest, improved: false, previous }

  try {
    // Always the MODED key, never the legacy one. A write that went back to the
    // old shape would keep two records alive and let them disagree.
    storage?.setItem(
      bestKey(missionId || 'unknown', mode || 'unknown', variant, course),
      JSON.stringify(candidate),
    )
  } catch {
    // Quota, a private window, a webview with storage off. The run still
    // happened and the panel still has a number to show; only the memory is
    // lost, and losing it silently is better than losing the results screen.
  }
  return { best: candidate, improved: true, previous }
}

/**
 * `localStorage`, or null where touching it throws.
 *
 * Reading the property itself is what throws in a blocked context, so the
 * try/catch has to be around the ACCESS and not merely around `getItem`.
 */
export const safeStorage = (): Pick<Storage, 'getItem' | 'setItem'> | null => safeLocalStorage()

// ── Has this browser finished anything? (DEV-379) ─────────────────────────
//
// The title's first-visit note, and which lesson Learn to Fly boards, both ask
// whether a best was ever WRITTEN — a question about the namespace, not about
// one key — so they read the store's key list. Here, beside the prefix, so the
// namespace is spelled in one file. A key is enough: `recordRun` writes one
// only for a run that ended, so a key is a finished run, whatever its value.

/** The store as far as listing its keys, or null where touching it throws. */
export type KeyedStorage = Pick<Storage, 'length' | 'key'>

/** `localStorage` for listing, or null where touching it throws. */
export const keyedStorage = (): KeyedStorage | null => safeLocalStorage()

/** Is there a stored key under `prefix`? False where the store is absent or throws. */
const anyKeyUnder = (prefix: string, storage: KeyedStorage | null): boolean => {
  if (!storage) return false
  try {
    for (let i = 0; i < storage.length; i++) {
      if (storage.key(i)?.startsWith(prefix)) return true
    }
  } catch {
    // A blocked store knows nothing, which reads as "never finished".
  }
  return false
}

/**
 * Has this browser finished a run of ANYTHING — any mission, mode or variant?
 * A store with no `ff2.best.` key at all has not, and neither has one that
 * throws: a private window is a first visit every time, which is the honest
 * answer about what it can remember.
 */
export const hasAnyBest = (storage: KeyedStorage | null = keyedStorage()): boolean =>
  anyKeyUnder(KEY_PREFIX, storage)

/**
 * Has this browser finished `missionId`, in any mode or variant? Every key
 * that course was ever stored under starts `ff2.best.<id>.` — the moded one,
 * a variant's and the legacy one (`bestKey`, `legacyBestKey`) — and a mission
 * id carries no dot, so the prefix cannot also match a longer id.
 */
export const hasBestFor = (
  missionId: string,
  storage: KeyedStorage | null = keyedStorage(),
): boolean => anyKeyUnder(`${KEY_PREFIX}${missionId}.`, storage)
