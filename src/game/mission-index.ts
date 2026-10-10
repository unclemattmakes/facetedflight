// src/game/mission-index.ts — the thirteen, read off the disk rather than typed.
//
// The level select needs a row per mission: what it is called, what you fly,
// where, under which rules, and what you have already done on it. None of that
// may be a list in code. CLAUDE.md hard rule 6: *"Adding a mission, an
// environment or a vehicle must never require touching `src/`. If it does, that
// is an architecture bug, not a task."* A picker with thirteen ids in it is that
// bug wearing a menu, and `boot/app.ts` has already shipped the same mistake
// once — it asked for `'simonet.islands'` as a string literal and rendered nine
// missions in the wrong world without erroring (see `load-terrain.ts`).
//
// So the index is `content/levels/*.json`, through the loader that already
// exists. A fourteenth JSON appears in the room with no code change and no
// regeneration step, and `tests/unit/mission-index.test.ts` is the guard.
//
// ── Why the whole level, and not a generated summary ─────────────────────
//
// The obvious optimisation is a small `content/levels/_index.json` written by
// the extractor. Measured before reaching for it: the thirteen levels are
// **2.05 MB raw, 301 KB gzipped** — number arrays compress hard — and they are
// already lazy dynamic imports (`import.meta.glob`), so they arrive as thirteen
// cacheable chunks in parallel rather than as one blocking payload. 301 KB is
// half of one terrain height map. A generated summary would buy that back and
// cost a second source of truth that can drift from the levels it summarises,
// which is the `islandgroup_height.png` trap in miniature: two files that must
// agree, and *almost right is the most expensive kind of wrong*.
//
// ── DISPLAY names are presentation, and they fall back ───────────────────
//
// `vehicle`, `mode` and `environment` are machine keys (`hoverjet`,
// `ringAttack`, `simonet`). A player needs "HoverJet · Ring Attack · Simonet
// Islands". That table is the one thing here that is not data — and it is
// deliberately a *decoration*, not a gate: an unknown key is humanised
// (`kauai` -> "Kauai", `ringAttack` -> "Ring Attack") rather than dropped.
// **Trap: a display table must never be able to hide a mission.** A fourteenth
// mission in a fifth environment shows up with a slightly plainer label, which
// is a cosmetic debt; being absent from the menu is a content bug.

import { FLEET_2016, type Fleet, STANDARD_VARIANT_ID } from '@/content/aircraft-schema'
import {
  DIFFICULTY_ORDER,
  type Difficulty,
  type GameMode,
  type Level,
  type Medals,
  type VehicleId,
} from '@/content/level-schema'
import { levelIds, loadLevel } from '@/content/load-level'
import { bestRule, curveMedal, type MedalTier } from '@/game/best-medal'
import { medalCurve, runningMode } from '@/game/modes'
import { type BestRule, type PersonalBest, readBest } from '@/game/personal-best'

/** One row of the level select. Everything the table needs and nothing else. */
export interface MissionCard {
  readonly id: string
  /** `level.title` — 2016's own, e.g. "Intermediate 1 - HoverJet". */
  readonly title: string
  readonly vehicle: VehicleId
  /** Which of 2016's three ranks. Extracted; see `Level.difficulty`. */
  readonly difficulty: Difficulty
  /**
   * 2016's own running order — `Button_Next.cs`'s chain — or null for a course
   * outside it.
   *
   * Since DEV-203 it is also what every step's FIXED SLOTS are ordered by: see
   * {@link slotOrder}. A key's place on the arc is the earliest chain index at
   * which it appears, so the shipped thirteen pin the layout and anything added
   * later appends to it instead of shuffling it.
   */
  readonly chainIndex: number | null
  readonly environment: string
  /**
   * The mode it will actually RUN in — the forcing FF2 obeys, applied.
   *
   * `hoverJet_kauai_beg` is authored Ring Attack and forced to Free Flight; a
   * menu that prints `level.mode` tells you the opposite of what you are about
   * to play. This is `runningMode`'s second consumer, and it was worth the
   * import: the flag was in the schema and read by nothing for weeks (NEXT.md).
   *
   * `int_02_jumpSeat` is forced to Free Flight by 2016 too, and FF2 drops that
   * one (DEV-061) — so a card built off `level.forcedMode` would now name a mode
   * the mission does not run. That is why this asks `runningMode` and not either
   * field.
   */
  readonly mode: GameMode
  /** "HoverJet" / "JumpSeat". */
  readonly vehicleName: string
  /** "Beginner" / "Intermediate" / "Professional". 2016's own three words. */
  readonly difficultyName: string
  /** "Ring Attack" / "Target Practice" / "Free Flight". */
  readonly modeName: string
  /** "Simonet Islands" / "Alpine Forest" / "Mesa Canyon" / "Kauai". */
  readonly environmentName: string
  /** The stored best, or null. Read once, at index time. */
  readonly best: PersonalBest | null
  /**
   * The medal that best earns, or null — never flown, below bronze, or a mode
   * that awards none. What spins over the table (DEV-113). Derived from `best`
   * by `game/best-medal.ts`, so it cannot disagree with it.
   */
  readonly medal: MedalTier | null
  /**
   * WHICH aircraft variant's record `best` is (DEV-382): records are per
   * variant, so a card says whose. Absent is `standard`, which every card
   * built before variants — and every hand-made test card — is.
   */
  readonly variant?: string
  /**
   * The course's medal thresholds in the mode it runs in, or null for a mode
   * that awards none — kept so {@link withVariant} can re-derive the medal for
   * another variant's best with no level in hand. SHARED by every variant
   * (AIRCRAFT-VARIANTS §7: a ring is a ring). Absent reads as none.
   */
  readonly curve?: Medals | null
  /**
   * How a best on this course reads under DEV-393's rule — a missed ring
   * forfeits the time bonus — kept for {@link withVariant} for the reason
   * `curve` is. Absent or null reads a best as stored.
   */
  readonly bestRule?: BestRule | null
  /**
   * DEV-538: `level.courseKey` — which COURSE `best` is the record of, kept
   * for {@link withVariant} for the reason `curve` is. Absent or null is the
   * course as 2016 shipped it.
   */
  readonly course?: string | null
  /**
   * The colour the course's flight instructor wears (`lesson.instructor.colour`,
   * `#rrggbb`), or null on a course with no lesson (DEV-379). A Flight School
   * table stands the instructor's hull in it (`render/mode-mark.ts`), read off
   * its signature course, as a Target Practice table reads its pad. Absent reads
   * as none.
   */
  readonly instructorColour?: string | null
}

/**
 * `hoverjet` -> "HoverJet". Two entries, and both are 2016's own spelling.
 *
 * 2016 writes the vehicle into the mission title (`"Rookie 1 - JumpSeat"`) and
 * into the HUD label set, so the capitalisation here is transcribed rather than
 * invented — `level.ui.strings` carries `JumpSeat` with that exact inner cap.
 */
const VEHICLE_NAMES: Readonly<Record<string, string>> = {
  hoverjet: 'HoverJet',
  jumpseat: 'JumpSeat',
  // DEV-399. 2016's own word: `MenuManager.cs` routes `playerShip == "Glider"`
  // to `page_challengeSelect_glider_*`, and the prefab is
  // `PlayerShip_Glider_Photon`. One capital, no inner one to transcribe.
  glider: 'Glider',
}

/**
 * The three ranks, spelled the way 2016's own rank page spells them.
 *
 * `page_rankSelection`'s three live buttons carry `lbl_levelName` Texts reading
 * `Beginner`, `IntermeDiate` and `PROfessional` — the inner capitals are the
 * title font's own styling (the same scene writes "The Simonet IslanDs" and
 * "the hiDDen Orbs"), not spellings, so they are transcribed here in ordinary
 * case the way `VEHICLE_NAMES` transcribes "JumpSeat".
 *
 * A fourth button, `button_training (1)`, reads `Training` and is
 * `m_IsActive: 0`. It is not here because it never shipped; if a future course
 * arrives filed under it, `named()` humanises it rather than dropping it.
 */
const DIFFICULTY_NAMES: Readonly<Record<string, string>> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  professional: 'Professional',
}

/**
 * The three modes, spelled the way 2016's own UI spells them.
 *
 * `hoverJet_kauai_beg`'s extracted title is literally `"Kauai - Free Flight"`,
 * so "Free Flight" is the shipped wording rather than a guess at one.
 *
 * And one of FF2's (DEV-375): the teaching mode's table reads **Flight School**,
 * Matt's call 1 in `docs/plan/FLIGHT-INSTRUCTOR.md`. The alternative with
 * history was "Training", the word on 2016's switched-off rank button — a RANK
 * there, so it would have been a reinterpretation. (`energyRace` has no entry
 * and no course; `named()` humanises it.)
 */
const MODE_NAMES: Readonly<Record<string, string>> = {
  ringAttack: 'Ring Attack',
  targetPractice: 'Target Practice',
  freeFlight: 'Free Flight',
  lesson: 'Flight School',
}

/**
 * The four environments, in 2016's OWN words for them.
 *
 * ── Read off the menu, not invented from the scene name ──────────────────
 *
 * These were derived from `level.environmentScene` for three sessions —
 * `LevelArt_Simonet_Islands` -> "Simonet Islands", `LevelArt_AlpineForest` ->
 * "Alpine Forest" — and `LevelArt_Desert` has no second word, so the port
 * supplied one: **"Desert Canyon"**, taken from the height map the environment
 * loads (`canyon_04-height.png`). Plausible, and not what the game says.
 *
 * 2016 writes the player-facing place name into `MissionSelector.levelName_ui`,
 * one per holotable, in `Scenes/setGameplayOptions.unity`. The desert reads
 * **"Mesa Canyon"** in FIVE independent instance overrides: the environment
 * table on `page_envSelection/spacer_helper/arm_01`, and the mission tables for
 * `rookie_02_hoverJet`, `rookie_02_jumpSeat`, `adv_01_hoverJet` and
 * `adv_01_jumpSeat` — which are exactly the missions this repo's level JSON
 * marks `environment: "desert"`. "Alpine Forest" and "Simonet Islands" come
 * back off the same field unchanged, which is what makes the third one a
 * correction rather than a preference.
 *
 * Kauai has no `levelName_ui` anywhere: it shipped after this backup and never
 * got an environment table. Its mission title is 2016's own `"Kauai - Free
 * Flight"`, so the bare place name is transcribed from that.
 *
 * **A place name is what the LAST step of the level select says** — one per
 * table on the courses page, exactly as 2016's `missionSel_*` holotables are
 * labelled — so a name that is merely plausible is a name the player learns
 * wrong.
 */
const ENVIRONMENT_NAMES: Readonly<Record<string, string>> = {
  simonet: 'Simonet Islands',
  alpine: 'Alpine Forest',
  desert: 'Mesa Canyon',
  kauai: 'Kauai',
}

/**
 * A machine key, made readable, when the table above does not know it.
 *
 * `ringAttack` -> "Ring Attack"; `simonet` -> "Simonet"; `sky_city` -> "Sky
 * City". Never empty for a non-empty key — an unlabelled table is worse than a
 * plainly labelled one.
 */
export const humanise = (key: string): string =>
  key
    .replace(/[_-]+/g, ' ')
    // A lower-to-upper boundary is a word break: `ringAttack` -> `ring Attack`.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

const named = (table: Readonly<Record<string, string>>, key: string): string =>
  table[key] ?? humanise(key)

/**
 * Which of the things a level-select step is choosing between. `variant` is
 * the aircraft variant (DEV-382), a step Anniversary adds after the aircraft;
 * its names come from `content/aircraft/<vehicle>.json`, never from here, so
 * its table below is empty and a key with no card is humanised.
 */
export type SlotFacet = 'vehicle' | 'variant' | 'mode' | 'difficulty' | 'environment'

const FACET_NAMES: Readonly<Record<SlotFacet, Readonly<Record<string, string>>>> = {
  vehicle: VEHICLE_NAMES,
  variant: {},
  mode: MODE_NAMES,
  difficulty: DIFFICULTY_NAMES,
  environment: ENVIRONMENT_NAMES,
}

/**
 * The player-facing name of a key **with no card behind it** (DEV-203).
 *
 * Every step now draws its whole arc: `Ring Attack · Target Practice · Free
 * Flight` on the flight-plan step whatever the aircraft flies, all three ranks,
 * all four places. A position the content has nothing for still gets a plate,
 * and a plate needs a word — but there is no `MissionCard` to take it from,
 * because the absence of a card is precisely what makes the position empty.
 *
 * The SAME four tables the cards use, which is the whole point: a dead
 * "Target Practice" and a live one have to be the same two words, or the player
 * learns that the greyed one is a different thing. §5 of the orientation
 * lesson — *two things that must stay equal should be the same object*.
 */
export const facetName = (facet: SlotFacet, key: string): string => named(FACET_NAMES[facet], key)

/**
 * A card's key for one facet — the other half of {@link facetName}.
 *
 * One table rather than four call sites asking `c.mode` / `c.difficulty`,
 * because the four steps have to agree about what a step is keyed on and the
 * orders, the grouping and {@link reachableKeys} all need the same answer.
 */
export const facetKeyOf: Readonly<Record<SlotFacet, (card: MissionCard) => string>> = {
  vehicle: (c) => c.vehicle,
  // Whose record the card carries, which is the variant the hangar has open.
  variant: (c) => c.variant ?? STANDARD_VARIANT_ID,
  mode: (c) => c.mode,
  difficulty: (c) => c.difficulty,
  environment: (c) => c.environment,
}

/**
 * Which keys of `facet` a set of missions reaches at all. DEV-312.
 *
 * ── What it is for: a JumpSeat table must not offer a HoverJet mode ───────
 *
 * Matt, 2026-09-21, wishlist #41d: *"A JumpSeat table must not show HoverJet
 * modes, or the reverse."* The flight-plan arc drew all three plans whatever
 * the aircraft flew — Ring Attack and Free Flight greyed on the JumpSeat's
 * page, Target Practice greyed on the HoverJet's — because
 * `hangar.ts`'s `pagesFor` turns EVERY position the global order names into a
 * plate, and the orders are global on purpose (DEV-203).
 *
 * Passed the OPEN AIRCRAFT's missions, this is the set of keys a dead plate is
 * still honest about. A position outside it is drawn as nothing.
 *
 * ── Two readings of a dead plate, and only one of them survives ──────────
 *
 * A dead plate says *"this exists, and not down the path you are on"*. That is
 * true and useful for a combination the content has not reached yet — Free
 * Flight × Intermediate, the pair DEV-203's own prose is written about — and it
 * is false for a flight plan the aircraft in front of you does not fly, which
 * is not a thing that is missing. **The aircraft is the one choice that changes
 * which game you are in**; everything below it is a place inside that game.
 *
 * ── 2016 agrees, and this is not a deviation ─────────────────────────────
 *
 * It was worth checking, because it is Matt's 2026-09-21 against Matt's
 * 2026-09-17 (*"a dead table is still a thing you try to press"*), and this
 * project's rule is to compare against something outside the port.
 *
 * 2016 drew a VOID. `MenuManager.ModeSelection(string shipName)`
 * (`MenuManager.cs:60-71`) swaps to `page_modeSelection_jumpseat` for the
 * JumpSeat and `page_modeSelection` for everything else — and the JumpSeat's
 * copy carries `button_freeflight` at `m_IsActive: 0`
 * (`Scenes/setGameplayOptions.unity:2041841`) where the HoverJet's has it at
 * `m_IsActive: 1` (`:708335`). Nothing greyed, nothing dead: the plate is not
 * in the room. Live mode plates per aircraft were therefore HoverJet 2
 * (Missions, Free Flight) and JumpSeat 1 (Missions) — the same two sets
 * `modeCards` produces here.
 *
 * `EnvSelection()` and `ChallengeSelection()` (`:75`, `:89`) branch on
 * `PlayerShip` as well, so the whole 2016 tree below the aircraft was
 * aircraft-scoped by construction, which is why this scopes the places step
 * too and not only the flight plans.
 *
 * And 2016's idiom for *"a position we have no content for"* was the same
 * everywhere: `button_training (1)` is authored complete and switched off
 * (`:1594714`, with its `Button_Look_Simple` still `m_Enabled: 1` — the
 * component-enabled/object-dead trap), and `page_envSelection`'s `arm_04`
 * carrying *"[Alpha] Canyonland"* is deactivated at `:41859`. **2016 drew no
 * live-but-dead pressable plate anywhere in its level select.** That goes
 * FURTHER than this change does, and deliberately is not followed: the plate
 * for a reachable-but-empty combination is Matt's 2026-09-17 call and stands.
 */
export const reachableKeys = (
  missions: readonly MissionCard[],
  facet: SlotFacet,
): ReadonlySet<string> => new Set(missions.map((m) => facetKeyOf[facet](m)))

/**
 * The player-facing name of an environment key, for anything that is not a
 * mission card — the loading readout, for one (DEV-107).
 *
 * The same table the cards use, deliberately. *"A place name is what the LAST
 * step of the level select says"*, and a loading screen that called the desert
 * something else would teach a visitor a name the menu then contradicts.
 */
export const environmentDisplayName = (environment: string): string =>
  facetName('environment', environment)

/**
 * Turn a loaded level into a card.
 *
 * Split out from {@link loadMissionIndex} so a test can build a card from a
 * hand-made level with no network and no `import.meta.glob`.
 *
 * `storage` is injectable for the same reason `readBest`'s is: the case worth
 * testing is a store that THROWS, and no jsdom mock produces that by accident.
 */
export const cardFor = (
  level: Level,
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null,
  /** Whose record to read (DEV-382). The standard's by default, as before variants. */
  variant: string = STANDARD_VARIANT_ID,
): MissionCard => {
  // `runningMode`, not `level.mode` — and the SAME value goes into the storage
  // key and onto the label, so the medal a table wears and the namespace it was
  // stored under cannot disagree (DEV-204).
  const mode = runningMode(level)
  // DEV-393: a best is read as it scores TODAY, so a table cannot wear a medal
  // an old run earned with a time bonus its missed rings no longer pay.
  const rule = bestRule(level, mode)
  const best =
    storage === undefined
      ? readBest(level.id, mode, undefined, variant, rule, level.courseKey ?? null)
      : readBest(level.id, mode, storage, variant, rule, level.courseKey ?? null)
  const curve = medalCurve(level, mode)
  return {
    id: level.id,
    title: level.title,
    vehicle: level.vehicle,
    difficulty: level.difficulty,
    chainIndex: level.chainIndex ?? null,
    environment: level.environment,
    mode,
    vehicleName: named(VEHICLE_NAMES, level.vehicle),
    difficultyName: named(DIFFICULTY_NAMES, level.difficulty),
    modeName: named(MODE_NAMES, mode),
    environmentName: named(ENVIRONMENT_NAMES, level.environment),
    best,
    medal: curveMedal(curve, best),
    variant,
    curve,
    bestRule: rule,
    // Only on an overridden course, so every other card is the shape it was.
    ...(level.courseKey ? { course: level.courseKey } : {}),
    instructorColour: level.lesson?.instructor.colour ?? null,
  }
}

/**
 * The same cards with `vehicle`'s re-read under `variant` (DEV-382): its best,
 * and the medal that best earns on the course's own, shared, thresholds. Every
 * other aircraft's card is returned as it was, the same object.
 *
 * SYNCHRONOUS, and that is why a card keeps its `curve`: the hangar re-reads
 * on the press that picks a variant, and lays the next step on the same frame,
 * so the flight-plan tables never show one frame of another variant's record.
 */
export const withVariant = (
  cards: readonly MissionCard[],
  vehicle: string,
  variant: string,
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null,
): MissionCard[] =>
  cards.map((card) => {
    if (card.vehicle !== vehicle) return card
    const best =
      storage === undefined
        ? readBest(
            card.id,
            card.mode,
            undefined,
            variant,
            card.bestRule ?? null,
            card.course ?? null,
          )
        : readBest(card.id, card.mode, storage, variant, card.bestRule ?? null, card.course ?? null)
    return { ...card, best, medal: curveMedal(card.curve ?? null, best), variant }
  })

/**
 * Every mission on the menus, in `levelIds()` order: the generated thirteen and
 * the authored courses whose file says `"listed": true` (DEV-375). An unlisted
 * authored file — a perf fixture, a course the boot path cannot fly yet — is
 * not a card, so no table, no pool and no count built from this ever sees it.
 *
 * Loaded in PARALLEL and **failure-tolerant per mission**: one malformed level
 * JSON must cost you that one table, not the whole menu. A picker that goes
 * blank because a level somebody is mid-authoring fails `validateLevel` is a
 * picker that makes the game unplayable from a content mistake, and the same
 * mistake already has a loud channel — `loadLevel` throws where it is flown.
 */
export const loadMissionIndex = async (
  /**
   * Whose records each aircraft's cards carry (DEV-382): the hangar's open or
   * remembered variant on Anniversary, `standard` on Classic and by default.
   */
  variantOf: (vehicle: VehicleId) => string = () => STANDARD_VARIANT_ID,
  /**
   * Which aircraft the menus offer (DEV-399): the live edition's, where the
   * glider's course joins on Anniversary. 2016's two by default, so Quick
   * Race's pool and every caller that does not ask never sees the glider.
   */
  fleet: Fleet = FLEET_2016,
): Promise<MissionCard[]> => {
  const settled = await Promise.allSettled((await levelIds(fleet)).map((id) => loadLevel(id)))
  const cards: MissionCard[] = []
  for (const result of settled) {
    if (result.status === 'fulfilled')
      cards.push(cardFor(result.value, undefined, variantOf(result.value.vehicle)))
    else console.warn('level select: skipping an unreadable level —', result.reason)
  }
  return cards
}

/* ════════════════════════════════ FIXED SLOTS ════════════════════════════ */

/**
 * The ORDER the slots of one step are in — a total order over the keys that
 * step offers, derived from the content and from nothing else.
 *
 * ── What it is for, and the bug it replaces ──────────────────────────────
 *
 * Matt, 2026-09-17: *"free flight should be a mode. so aircraft > mode >
 * difficulty > location (these should be fixed, not randomly placed as they are
 * now)."*
 *
 * They were not random; they were a function of the wrong thing. A table's
 * bearing came from `tableBearings(count)` — the slot INDEX and the number of
 * tables the page happened to hold — and then the page was ROTATED so the
 * option you arrived in sat under the resting pointer. So "Beginner" was at
 * -45 on a three-rank page and at -15 on a one-rank page, and the whole arc
 * span round whenever the loaded mission changed. A player could not learn
 * where anything was, because where it was depended on what else was there.
 * (DEV-203.)
 *
 * The fix is to give every key a slot of its OWN, for the life of the build.
 * That needs an ordering, and an ordering that lives in code would be a table
 * a fourteenth mission has to be added to — hard rule 6 says no.
 *
 * ── The rule: 2016's own campaign chain ─────────────────────────────────
 *
 * A key's rank is **the earliest point in `Button_Next.cs`'s chain at which it
 * appears**; a key that never appears in the chain sorts after every key that
 * does, by key. `chainIndex` is extracted, generated and hash-guarded, so the
 * shipped thirteen pin the order and anything added later appends to it — which
 * is exactly the stability a fixed slot needs.
 *
 * One rule, all four steps, and it REPRODUCES the two orders this file already
 * spells out by hand:
 *
 *   vehicles   hoverjet(0) jumpseat(6)                  == {@link VEHICLE_ORDER}
 *   ranks      beginner(0) intermediate(2) professional(4) == `DIFFICULTY_ORDER`
 *   modes      ringAttack(0) targetPractice(6) freeFlight(-)
 *   courses    alpine(0) desert(1) simonet(2) kauai(-)
 *
 * That agreement is the check worth having, and it is the kind CLAUDE.md asks
 * for: `VEHICLE_ORDER` and `DIFFICULTY_ORDER` were transcribed from 2016's
 * `page_shipSelection` and `page_rankSelection`, and the chain is a different
 * 2016 file saying the same thing. `tests/unit/level-steps.test.ts` asserts it
 * — *compare against something outside the port*, twice.
 */
export const slotOrder = (
  cards: readonly MissionCard[],
  keyOf: (card: MissionCard) => string,
): readonly string[] => {
  const first = new Map<string, number>()
  for (const card of cards) {
    const key = keyOf(card)
    const at = card.chainIndex ?? Number.POSITIVE_INFINITY
    const seen = first.get(key)
    if (seen === undefined || at < seen) first.set(key, at)
  }
  const rank = (key: string): number => first.get(key) ?? Number.POSITIVE_INFINITY
  // Compared with `<` rather than subtracted: `Infinity - Infinity` is `NaN`,
  // and a comparator that returns NaN leaves the sort implementation-defined —
  // which for the unchained keys (every Free Flight course) is every key that
  // matters here.
  return [...first.keys()].sort((a, b) => {
    const x = rank(a)
    const y = rank(b)
    if (x !== y) return x < y ? -1 : 1
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/**
 * Lay `items` into FIXED positions: page `floor(r / width)`, slot `r % width`,
 * where `r` is the item's key's place in {@link slotOrder}. `null` is a
 * position this step has nothing for.
 *
 * Three properties, and each of them is a bug that has already been paid for
 * somewhere in this repo:
 *
 *  1. **A key's position does not depend on what else is present.** That is the
 *     whole of DEV-203. Free Flight × Intermediate holds no course today, so
 *     Intermediate's page has a gap where Professional would be — and
 *     Professional does NOT slide left to fill it, because a menu that closes
 *     its gaps is a menu whose options move.
 *  2. **Nothing can be hidden.** `mission-index`'s standing rule is that a
 *     display table must never be able to drop a mission. Two items with one
 *     key — two courses in one environment in one cell, which no shipped
 *     content produces and a fourteenth JSON could — put the second on the same
 *     slot one page later rather than overwriting the first. An item whose key
 *     is not in the order at all takes the first free position anywhere.
 *  3. **The page count is a property of the ORDER**, not of the items, so the
 *     back/page plates do not appear and disappear as content is filtered.
 *
 * `width` is the arc's capacity (`TABLES_PER_PAGE`), passed in rather than
 * imported: this file is content and knows nothing about how many tables fit in
 * front of a chair.
 */
export const fixedPages = <T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  order: readonly string[],
  width: number,
): readonly (readonly (T | null)[])[] => {
  const w = Math.max(1, Math.min(Math.max(1, width), Math.max(1, order.length)))
  const pages: (T | null)[][] = []
  const page = (at: number): (T | null)[] => {
    while (pages.length <= at) pages.push(Array.from({ length: w }, () => null))
    return pages[at] as (T | null)[]
  }
  // Every key in the order gets its page, whether or not this step has an item
  // for it. Property 3.
  page(Math.max(0, Math.ceil(order.length / w) - 1))
  for (const item of items) {
    const at = order.indexOf(keyOf(item))
    if (at < 0) {
      // Property 2's second half: a key the order has never seen still gets a
      // table, just a plainer place than its own.
      for (let p = 0; ; p++) {
        const row = page(p)
        const free = row.indexOf(null)
        if (free >= 0) {
          row[free] = item
          break
        }
      }
      continue
    }
    const slot = at % w
    let p = Math.floor(at / w)
    while (page(p)[slot] !== null) p++
    page(p)[slot] = item
  }
  return pages
}

/**
 * The order the aircraft are offered in. 2016's own: `page_shipSelection` puts
 * `button_HoverJet_grp` before `button_jumpSeat_grp`, and `Button_Next.cs`'s
 * campaign chain flies all six HoverJet missions before the first JumpSeat one.
 *
 * Not `VehicleId[]` typed, deliberately: an unknown vehicle must still get a
 * table (see the display-name note at the top of this file), so this is a
 * ranking and not a filter.
 */
const VEHICLE_ORDER: readonly string[] = [
  'hoverjet',
  'jumpseat',
  // DEV-399. Last, as 2016's own switched-off `missionSel_glider_*` tables and
  // its `MenuManager` routing put it after the two it shipped — and as
  // `slotOrder` puts it anyway, its one course being outside the chain.
  'glider',
]

/** Where `key` sits in `order`, or the end. Unknown keys sort last, in key order. */
const rankOf = (order: readonly string[], key: string): number => {
  const at = order.indexOf(key)
  return at === -1 ? order.length : at
}

/**
 * Compare two cards by (vehicle, difficulty, id) — the level select's own order.
 *
 * Inside a cell it is **2016's campaign chain**, not the id: `hoverJet_kauai_beg`
 * sorts before `rookie_01_hoverJet` alphabetically, so an id sort opens the
 * HoverJet beginner page on the bonus free-flight course and pushes the two the
 * game starts you on to the right of it. `chainIndex` is `Button_Next.cs`'s own
 * order and Kauai's `null` puts it last, which is where a course that is not in
 * the campaign belongs. The id is the tiebreak under it, so a fourteenth course
 * outside the chain still has a stable place.
 *
 * ONE comparator, used by every grouping below, because the three steps have to
 * agree: a rank table that counted a course the course page does not show would
 * be a menu that disagrees with itself. §5 of the orientation lesson, applied to
 * an ordering — *two things that must stay equal should be the same object*.
 */
const byCell = (a: MissionCard, b: MissionCard): number =>
  rankOf(VEHICLE_ORDER, a.vehicle) - rankOf(VEHICLE_ORDER, b.vehicle) ||
  (a.vehicle < b.vehicle ? -1 : a.vehicle > b.vehicle ? 1 : 0) ||
  // The MODE, between the aircraft and the rank, because that is where Matt put
  // the step and a comparator that disagreed with the menu would deal a rank
  // page whose courses came from two modes. `chainIndex` is the ranking, the
  // same one `slotOrder` uses, so the two cannot drift.
  (a.chainIndex ?? Number.POSITIVE_INFINITY) - (b.chainIndex ?? Number.POSITIVE_INFINITY) ||
  (a.mode < b.mode ? -1 : a.mode > b.mode ? 1 : 0) ||
  rankOf(DIFFICULTY_ORDER, a.difficulty) - rankOf(DIFFICULTY_ORDER, b.difficulty) ||
  (a.difficulty < b.difficulty ? -1 : a.difficulty > b.difficulty ? 1 : 0) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * The cards, gathered into one group per `key`, in {@link byCell} order.
 *
 * Its own function because the four steps are four views of one menu, and if
 * they grouped independently a later step could hold a course an earlier one
 * did not count.
 */
const groupBy = (
  cards: readonly MissionCard[],
  key: (card: MissionCard) => string,
): MissionCard[][] => {
  const cells = new Map<string, MissionCard[]>()
  for (const card of cards.slice().sort(byCell)) {
    const at = key(card)
    const cell = cells.get(at)
    if (cell) cell.push(card)
    else cells.set(at, [card])
  }
  return [...cells.values()]
}

/**
 * An AIRCRAFT, and everything you can fly in it. The first step.
 *
 * 2016's `page_shipSelection` under the header *"- Select an Aircraft -"*, with
 * `button_HoverJet_grp` reading **"Hover-Jet"** and `button_jumpSeat_grp`
 * reading **"Jump Seat"**. The port keeps `VEHICLE_NAMES`' spelling —
 * "HoverJet" / "JumpSeat" — because that is what the mission titles and the HUD
 * label set say, and a menu that hyphenates a word the cockpit does not is a
 * menu teaching the player two names for one aircraft.
 */
export interface VehicleCard {
  readonly vehicle: VehicleId
  /** What the table says: "HoverJet". */
  readonly name: string
  /** Every course you fly in it, in the order the later steps deal them. */
  readonly missions: readonly MissionCard[]
  /** How many of them you have a time on. */
  readonly flown: number
  /**
   * The MODES it is offered in, in slot order. The line under the name.
   *
   * Modes and not ranks since DEV-203: a table's middle line says what the NEXT
   * step will ask, and the next step is now the flight plan.
   */
  readonly modes: readonly GameMode[]
}

/** One card per aircraft, in the same order the cells are dealt. */
export const vehicleCards = (cards: readonly MissionCard[]): readonly VehicleCard[] =>
  groupBy(cards, (c) => c.vehicle).map((missions) => {
    const first = missions[0] as MissionCard
    const modes: GameMode[] = []
    for (const m of missions) if (!modes.includes(m.mode)) modes.push(m.mode)
    return {
      vehicle: first.vehicle,
      name: first.vehicleName,
      missions,
      flown: missions.filter((m) => m.best !== null).length,
      modes,
    }
  })

/**
 * A MODE within one aircraft. The second step, and the whole of DEV-203.
 *
 * ── Why the port did not have one, and what it cost ─────────────────────
 *
 * 2016 had it. `Scripts/MenuManager.cs` page-swaps **ship -> mode -> rank ->
 * challenge**, `GoBack()` unwinds `page_rankSelection -> page_modeSelection ->
 * page_ShipSelection`, and `ChallengeSelection()` dispatches on
 * `PlayerShip × MissionRank × GameMode` — **three axes**. The port kept two
 * (`HANGAR_VIEWS = ['vehicles','ranks','courses']`), so the one Free Flight
 * course had nowhere of its own to live and landed on the Beginner rank page
 * because its extracted `difficulty` says `beginner`.
 *
 * Matt, from the headset: *"the beginner flow is currently odd - it should just
 * be ring attack, but includes free flight missions"*, and then the call:
 * *"free flight should be a mode. so aircraft > mode > difficulty > location."*
 *
 * The page header is 2016's own: `modeSelection.prefab` carries
 * *"- Select a Flight Plan -"*.
 *
 * ── Which modes exist is read off the CONTENT ───────────────────────────
 *
 * Never a list. `MODES` in `game/modes.ts` has a fourth entry, `energyRace`
 * (DEV-143), with no shipped level — and a mode table with nothing behind it is
 * worse than no table. So a mode is offered exactly when some course runs in
 * it, which also means a fourteenth JSON adds a mode table with no code change
 * (hard rule 6).
 */
export interface ModeCard {
  readonly vehicle: VehicleId
  readonly mode: GameMode
  /** What the table says: "Ring Attack". */
  readonly name: string
  /** The courses in this (aircraft, mode) cell, in the order below it. */
  readonly missions: readonly MissionCard[]
  /** How many of them you have a time on. */
  readonly flown: number
  /** The ranks it is offered in. The line under the name. */
  readonly difficulties: readonly Difficulty[]
  /**
   * The course a pad-scoring plan's table reads its one target from.
   *
   * Its island stood on the plan's table until DEV-354; the plan now stands one
   * mark (`render/mode-mark.ts`), and a pad is content, so a Target Practice
   * plan's pad is this course's own (`loadMissionPad`). Derived — the first
   * course in the cell — for the reason {@link RankCard.signature} gives.
   */
  readonly signature: MissionCard
}

/** One card per mode offered in `vehicle`, in the order the cells are dealt. */
export const modeCards = (cards: readonly MissionCard[], vehicle: string): readonly ModeCard[] =>
  groupBy(
    cards.filter((c) => c.vehicle === vehicle),
    (c) => c.mode,
  ).map((missions) => {
    const first = missions[0] as MissionCard
    const difficulties: Difficulty[] = []
    for (const m of missions)
      if (!difficulties.includes(m.difficulty)) difficulties.push(m.difficulty)
    return {
      vehicle: first.vehicle,
      mode: first.mode,
      name: first.modeName,
      missions,
      flown: missions.filter((m) => m.best !== null).length,
      difficulties,
      signature: first,
    }
  })

/**
 * A RANK within one aircraft AND MODE. The third step.
 *
 * 2016's `page_rankSelection` under the header *"- Mission Difficulty -"*, with
 * `button_beginner` / `button_intermediate` / `button_pro` writing `beginner`,
 * `intermediate` and `professional` into `PlayerPrefs["MissionRank"]`.
 */
export interface RankCard {
  readonly vehicle: VehicleId
  readonly mode: GameMode
  readonly difficulty: Difficulty
  /** What the table says: "Intermediate". */
  readonly name: string
  /** The courses in this cell, in the order the course page deals them. */
  readonly missions: readonly MissionCard[]
  /** How many of them you have a time on. */
  readonly flown: number
  /**
   * The course whose island stands on the rank's table.
   *
   * The first course in the cell, so it is derived rather than chosen — a
   * hand-picked "hero course" per rank would be a table in code, and hard rule
   * 6 says a fourteenth mission must not need one.
   */
  readonly signature: MissionCard
}

/**
 * One card per rank offered in (`vehicle`, `mode`), easiest first.
 *
 * **Only the ranks that HAVE a course.** Free Flight × Intermediate and Free
 * Flight × Professional hold nothing today and are not errors — they are
 * content the sequel will add. The empty POSITION is `fixedPages`' business,
 * not this function's: a rank with no courses has no name, no count and no
 * island, so inventing a card for it would be inventing content.
 */
export const rankCards = (
  cards: readonly MissionCard[],
  vehicle: string,
  mode: string,
): readonly RankCard[] =>
  groupBy(
    cards.filter((c) => c.vehicle === vehicle && c.mode === mode),
    (c) => c.difficulty,
  ).map((missions) => {
    const first = missions[0] as MissionCard
    return {
      vehicle: first.vehicle,
      mode: first.mode,
      difficulty: first.difficulty,
      name: first.difficultyName,
      missions,
      flown: missions.filter((m) => m.best !== null).length,
      signature: first,
    }
  })

/*
 * ── `vehicleOf` / `rankOfMission` are GONE, and that is DEV-203 ──────────
 *
 * They answered *"which aircraft, and which rank, holds the mission you are
 * flying"*, and the only caller was the rotation: `slotsFor` used them to spin
 * each page until that option sat under the resting pointer. Fixed slots have
 * no use for the answer — a table's position is its identity's and nothing
 * else's — so the functions went with the mechanism.
 *
 * What survives is the one question the rotation was really answering, and it
 * is about a PAGE rather than a position: `render/hangar.ts`'s `pageHolding`.
 */

/**
 * The line under a mission's name: your best, or an invitation.
 *
 * Kept here rather than in the renderer so every step of the level select
 * cannot word it differently — §5 of the orientation lesson, applied to a
 * string: *two things that must stay equal should be the same object*.
 */
export const bestLine = (best: PersonalBest | null): string =>
  best ? `best ${best.score} · ${best.timeSeconds.toFixed(1)}s` : 'no time set'

/**
 * The middle line on a MODE's table: which ranks it is offered in. (An
 * AIRCRAFT's table had the same line one level up, the plans it flies, until
 * DEV-559: Matt, 2026-10-01, *"don't show the game modes on the aircraft mode
 * select"*. Its label is the aircraft's name alone.)
 *
 * "Beginner · Intermediate · Professional" is 37 characters, which is the
 * tightest line in the room and the reason nothing above it lists places.
 */
export const modeRanks = (mode: ModeCard): string =>
  mode.difficulties
    .map((d) => mode.missions.find((m) => m.difficulty === d)?.difficultyName ?? d)
    .join(' · ')

/**
 * The middle line on a RANK's table: which places it takes you.
 *
 * The same question one level down again — and it is the one thing the rank
 * step can say that the two above it could not, because by here the list is one
 * to three names long instead of four.
 */
export const rankPlaces = (rank: RankCard): string => {
  const seen: string[] = []
  for (const mission of rank.missions) {
    if (!seen.includes(mission.environmentName)) seen.push(mission.environmentName)
  }
  return seen.join(' · ')
}

/**
 * The line under a group's name: how much of it you have flown.
 *
 * One function for all three group steps, because their tables ask the same
 * question — *where have I not been yet* — and a count is a number a player can
 * hold where "50%" of a group with one course in it is a lie.
 */
export const flownLine = (total: number, flown: number): string => {
  const courses = `${total} course${total === 1 ? '' : 's'}`
  if (flown === 0) return `${courses} · none flown`
  if (flown === total) return `${courses} · all flown`
  return `${courses} · ${flown} flown`
}
