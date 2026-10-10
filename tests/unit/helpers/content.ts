// tests/unit/helpers/content.ts: the shipped content JSON, read straight off disk.
//
// One door for what ~60 test files each wrote for themselves (TS-10 in
// docs/plan/code-reuse/tests.md). Three flavours exist ON PURPOSE and are kept
// as separate functions, so no test is ever switched from one to another by
// accident:
//
//   RAW        `levelJson`, `editionJson`, `environmentJson`: `JSON.parse` and a
//              cast. No defaults filled, nothing thrown on a bad row. A data test
//              that checks the file itself wants exactly this.
//   VALIDATED  `validLevel`, `validEdition`: through the same `validate*` the
//              game's loader runs (defaults filled, throws on a bad row).
//   UNTYPED    `readJson<T>(rel)`: the JSON is the truth and the types lag it
//              (`terrain-field.ts` says so), so a caller that reads fields the
//              type does not carry yet asks for `any` and says why.
//
// Everything is anchored on the repository root, never on `process.cwd()`, so a
// test run from another directory reads the same files. It deliberately does
// NOT go through `src/content/load-level.ts` (an async `import.meta.glob`): a
// test of the data must not depend on the loader that may be under test.

import fs from 'node:fs'
import path from 'node:path'
import { type Edition, validateEdition } from '@/content/edition-schema'
import { type Level, validateLevel } from '@/content/level-schema'
import type { EnvironmentProps } from '@/content/load-environment'
import { REPO } from './repo-root'

export { REPO }

export const LEVELS_DIR = path.join(REPO, 'content', 'levels')
export const EDITIONS_DIR = path.join(REPO, 'content', 'editions')
export const ENVIRONMENTS_DIR = path.join(REPO, 'content', 'environments')

/** A repo-relative JSON file, parsed and cast. The cast is the caller's claim. */
export const readJson = <T>(rel: string): T =>
  JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8')) as T

/** Every shipped level file's id, sorted. `_`-prefixed files are notes, not levels. */
export const shippedLevelIds = (): string[] =>
  fs
    .readdirSync(LEVELS_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) => f.slice(0, -'.json'.length))

/** A level exactly as it sits on disk. */
export const levelJson = (id: string): Level =>
  JSON.parse(fs.readFileSync(path.join(LEVELS_DIR, `${id}.json`), 'utf8')) as Level

/** A level through `validateLevel`, as the game's loader returns it. */
export const validLevel = (id: string): Level => validateLevel(levelJson(id))

/** Every shipped level, validated, in id order. */
export const shippedLevels = (): Level[] => shippedLevelIds().map(validLevel)

/** An edition preset exactly as it sits on disk. */
export const editionJson = (id: string): Edition =>
  JSON.parse(fs.readFileSync(path.join(EDITIONS_DIR, `${id}.json`), 'utf8')) as Edition

/** An edition preset through `validateEdition`, as `content/load-edition.ts` checks it. */
export const validEdition = (id: string): Edition => validateEdition(editionJson(id))

/** An environment's props JSON exactly as it sits on disk. */
export const environmentJson = <T = EnvironmentProps>(id: string): T =>
  JSON.parse(fs.readFileSync(path.join(ENVIRONMENTS_DIR, `${id}.json`), 'utf8')) as T
