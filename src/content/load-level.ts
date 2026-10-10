// src/content/load-level.ts — the only way a course enters the game.
// Extracted, hand-authored and generated levels all arrive through here.

import { validateModeContent } from '@/game/modes'
import { FLEET_2016, type Fleet } from './aircraft-schema'
import { globIds } from './glob-tree'
import { applyOverride } from './level-override'
import { type Level, LevelSchemaError, validateLevel } from './level-schema'

/**
 * Levels live in TWO trees, and the split is not tidiness.
 *
 * `content/levels/*.json` is GENERATED — `tools/extract/level.mjs` writes it,
 * `.gitattributes` marks the whole directory `linguist-generated`, and
 * `content/_generated.sha256` hashes every file in it so `pnpm extract:check`
 * fails if one is hand-edited. That guard is the only thing standing between a
 * shipped mission and a number somebody typed.
 *
 * `content/authored/*.json` is written by a human. It is deliberately a
 * SEPARATE DIRECTORY rather than a file dropped in beside the thirteen, because
 * `check-content.mjs` hashes `*.json` under `content/levels` wholesale: an
 * authored file there would have to be added to the manifest, and a manifest
 * whose entries are a mix of "the extractor wrote these bytes" and "a person
 * wrote these bytes" no longer means what its own header says it means. The
 * brief for DEV-145 put it exactly: do not weaken the guard. So the guard is
 * untouched, and the two kinds of course are told apart by where they live —
 * which is also the first thing a reader wants to know about a level file.
 *
 * Both are pulled in by Vite as lazy dynamic imports. They are small, textual
 * and versioned in git (unlike assets, which live on R2 — PORT_PLAN §2.5), so a
 * PR that adds a mission adds one file and touches no code. `import.meta.glob`
 * also means a typo in a level id is a build-time list you can print, not a 404
 * at runtime.
 */
const generated = import.meta.glob<{ default: Level }>('/content/levels/*.json')
const authored = import.meta.glob<{ default: Level }>('/content/authored/*.json')
/**
 * DEV-538: the THIRD tree, `content/overrides/<id>.json` — a hand-authored
 * patch over a generated mission (`content/level-override.ts`,
 * plan/SHIPPED-COURSE-EDITS.md). `_`-prefixed files (the format's schema and
 * the tests' `_fixture_` overrides) are left out of the GLOB, not just skipped
 * by `globIds`, so they never become chunks of a build.
 */
const overrides = import.meta.glob<{ default: unknown }>([
  '/content/overrides/*.json',
  '!/content/overrides/_*.json',
])

/** A tree, as `import.meta.glob` hands it back: path -> lazy module. */
export type LevelModules = Readonly<Record<string, () => Promise<{ default: Level }>>>

/** The override tree, as `import.meta.glob` hands it back. Unknown until validated. */
export type OverrideModules = Readonly<Record<string, () => Promise<{ default: unknown }>>>

const GENERATED_PREFIX = '/content/levels/'
const AUTHORED_PREFIX = '/content/authored/'
const OVERRIDE_PREFIX = '/content/overrides/'

/**
 * The GENERATED courses: the shipped thirteen, and nothing else.
 *
 * What a test means when it says "every shipped mission". Before DEV-375 this
 * was `levelIds()` itself, and the two meanings coincided only because no
 * authored course was on a menu yet.
 */
export const generatedLevelIds = (): string[] => globIds(generated, GENERATED_PREFIX)

/** The hand-authored courses, listed or not. See {@link levelIds} for the difference. */
export const authoredLevelIds = (): string[] => globIds(authored, AUTHORED_PREFIX)

/**
 * The menu's list from two trees — {@link levelIds}' core, with the trees
 * injected so a test can hand it a listed authored course that the repo does
 * not have yet.
 *
 * **One rule, `Level.listed`:** a generated course is always on the menus; an
 * authored one only when its file says `"listed": true`. Absent is no, because
 * `content/authored/` holds perf fixtures as well as courses — the two
 * `dev230_*` crossings (DEV-230) are a JumpSeat on a HoverJet course and the
 * reverse, measurement arms that must never be a table. So an author opts a
 * course IN. (DEV-145's glider course was the third reason until DEV-399 wired
 * the glider; it is listed now, behind the edition's fleet.)
 *
 * Deciding it means reading the file, so this is async: an authored module is
 * loaded here and again by `loadLevel`, which Vite's module cache makes one
 * fetch. An authored file that will not load is left off with a warning rather
 * than taking the whole list with it — the index's own rule, that one broken
 * level costs one table and not the menu (`game/mission-index.ts`).
 */
export const listedLevelIds = async (
  trees: {
    readonly generated: LevelModules
    readonly authored: LevelModules
  },
  // DEV-399. Which aircraft the menus offer: an authored course in an aircraft
  // the edition does not fly is not listed, whatever its file says. The glider
  // is the one that stands behind a flag (`gameplay.glider`, Anniversary), so
  // this is how Classic never sees it. The default is 2016's two, so a caller
  // that does not ask gets Classic's list, never Anniversary's by accident.
  fleet: Fleet = FLEET_2016,
): Promise<string[]> => {
  const candidates = globIds(trees.authored, AUTHORED_PREFIX)
  const settled = await Promise.allSettled(
    candidates.map(async (id) => {
      const load = trees.authored[`${AUTHORED_PREFIX}${id}.json`] as () => Promise<{
        default: Level
      }>
      const level = (await load()).default
      return level.listed === true && fleet(level.vehicle)
    }),
  )
  const listed: string[] = []
  for (const [i, result] of settled.entries()) {
    if (result.status === 'rejected') {
      console.warn('level list: skipping an authored level that will not load —', result.reason)
    } else if (result.value) {
      listed.push(candidates[i] as string)
    }
  }
  return [...globIds(trees.generated, GENERATED_PREFIX), ...listed].sort()
}

/**
 * The level ids the MENU enumerates — the hangar's tables and every pool built
 * from the index. Sorted, so menus are stable.
 *
 * The generated thirteen plus every authored course whose file says
 * `"listed": true` (DEV-375) AND whose aircraft `fleet` flies (DEV-399: the
 * glider's course joins on Anniversary, behind `gameplay.glider`). See
 * {@link listedLevelIds} for the rule and why absent means no.
 * `game/mission-index.ts` builds the holotables from this, so anything in it
 * is something a player can walk up to and select.
 *
 * `loadLevel` reads BOTH trees whatever this says, so `?mission=` finds an
 * unlisted course and every test can.
 */
export const levelIds = (fleet: Fleet = FLEET_2016): Promise<string[]> =>
  listedLevelIds({ generated, authored }, fleet)

/** The mission ids `content/overrides/` edits (DEV-538). Every one must be a generated id. */
export const overriddenLevelIds = (): string[] => globIds(overrides, OVERRIDE_PREFIX)

/** The three trees `loadLevel` reads, injectable so a test can hand it a fixture override. */
export interface LevelTrees {
  readonly generated: LevelModules
  readonly authored: LevelModules
  readonly overrides: OverrideModules
}

/**
 * {@link loadLevel}'s core, with the trees injected (as {@link listedLevelIds}
 * takes them) — so the proof that overriding a mission needs no `src/` change
 * is a test that hands it a tree with one more file (hard rule 6,
 * plan/SHIPPED-COURSE-EDITS §3.5).
 *
 * The order is the one the file always ran — load, `validateLevel`,
 * `validateModeContent` — with DEV-538's step between: a generated mission with
 * a file in `content/overrides/` has it applied (`applyOverride`, which
 * validates it against the closed field list and the baseline, and throws
 * naming the problem), and the result is validated again as the level it now
 * is. `baseline: true` skips that step: {@link loadBaselineLevel}.
 */
export const loadLevelFrom = async (
  trees: LevelTrees,
  id: string,
  options: { readonly baseline?: boolean } = {},
): Promise<Level> => {
  const fromGenerated = trees.generated[`${GENERATED_PREFIX}${id}.json`]
  const load = fromGenerated ?? trees.authored[`${AUTHORED_PREFIX}${id}.json`]
  if (!load) {
    throw new Error(
      `loadLevel("${id}"): no such level. Known: ${[
        ...globIds(trees.generated, GENERATED_PREFIX),
        ...globIds(trees.authored, AUTHORED_PREFIX),
      ].join(', ')}`,
    )
  }
  let level = validateLevel((await load()).default)
  // `listed` is an AUTHORED file's opt-in. On a generated file it could only be
  // a hand edit, which `pnpm extract:check` exists to refuse — so it is refused
  // here too, where it would otherwise quietly mean nothing.
  if (fromGenerated && level.listed !== undefined) {
    throw new LevelSchemaError(
      id,
      '"listed" is an authored-file field; the generated tree is always listed',
    )
  }
  // DEV-538: these two are written by `applyOverride` and by nothing else. On a
  // file on disk they could only be typed, and a typed `courseKey` would split
  // a mission's bests with no course change behind it.
  if (level._override !== undefined || level.courseKey !== undefined) {
    throw new LevelSchemaError(
      id,
      '"_override" and "courseKey" are set by an override on load; a level file may not carry them',
    )
  }
  const override = id.startsWith('_') ? undefined : trees.overrides[`${OVERRIDE_PREFIX}${id}.json`]
  if (override && !fromGenerated) {
    // An authored course is edited in place; an override is for what 2016 shipped.
    throw new LevelSchemaError(
      id,
      'content/overrides/ edits a SHIPPED mission; an authored course is edited in its own file',
    )
  }
  if (override && !options.baseline) {
    level = validateLevel(applyOverride(level, (await override()).default))
  }
  // The mode rows live in `game/modes.ts`, so the lesson-vs-mode check does too.
  return validateModeContent(level)
}

/** The level `id` names, as the game flies it — a shipped mission with its override applied (DEV-538). */
export const loadLevel = (id: string): Promise<Level> =>
  loadLevelFrom({ generated, authored, overrides }, id)

/**
 * DEV-538: `id` as 2016 shipped it, with no override — the editor's draft
 * base and its "Fly 2016's", and what a test pinning a 2016 fact through the
 * loader means (plan/SHIPPED-COURSE-EDITS §3.1). The same as {@link loadLevel}
 * for every mission nobody has overridden.
 */
export const loadBaselineLevel = (id: string): Promise<Level> =>
  loadLevelFrom({ generated, authored, overrides }, id, { baseline: true })
