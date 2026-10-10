// src/net/lap-courses-text.ts: `content/lap-courses.json`'s bytes from the
// files on disk, through the level loader. DEV-544; split from
// `lap-courses-build.ts` by DEV-851 so the builder itself reaches no
// `import.meta.glob` and a Function can import it.

import type { Aircraft } from '@/content/aircraft-schema'
import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { type LevelModules, type LevelTrees, loadLevelFrom } from '@/content/load-level'
import { buildLapCourses, serialiseLapCourses } from './lap-courses-build'

/**
 * DEV-544: the files the artefact is built from, as JSON read off disk, so the
 * dev server's shipped-course Save (`tools/dev/override-writer.mjs`) can
 * rebuild it in the same write as the override — Matt, 2026-09-30: *"we don't
 * want a new download each edit. so probably just when saving manually."* The
 * writer reads the files itself (fresh, after the override it is about to
 * write), because the page's `import.meta.glob` of `content/overrides/` is a
 * module the dev server caches.
 */
export interface LapCourseSources {
  /** `content/levels/<id>.json`, by id: the generated missions (no `_` files). */
  readonly generated: Readonly<Record<string, unknown>>
  /** `content/overrides/<id>.json`, by id (no `_` files): as `loadLevel` applies them. */
  readonly overrides: Readonly<Record<string, unknown>>
  readonly editions: readonly unknown[]
  readonly aircraft: readonly unknown[]
}

const treeOf = (prefix: string, files: Readonly<Record<string, unknown>>): LevelModules =>
  Object.fromEntries(
    Object.entries(files).map(([id, json]) => [
      `${prefix}${id}.json`,
      () => Promise.resolve({ default: json as Level }),
    ]),
  )

/**
 * The file's bytes from {@link LapCourseSources}: every generated mission through
 * `loadLevelFrom` — the loader's own core, overrides applied — then the same
 * build and serialisation `tests/unit/lap-courses.test.ts` compares. That test
 * holds this path to the committed bytes as well, so the Save's write and the
 * check cannot disagree about what the file should be.
 */
export const lapCoursesTextFrom = async (src: LapCourseSources): Promise<string> => {
  const trees: LevelTrees = {
    generated: treeOf('/content/levels/', src.generated),
    authored: {},
    overrides: treeOf('/content/overrides/', src.overrides),
  }
  const levels = await Promise.all(Object.keys(src.generated).map((id) => loadLevelFrom(trees, id)))
  return serialiseLapCourses(
    buildLapCourses(levels, src.editions as Edition[], src.aircraft as Aircraft[]),
  )
}
