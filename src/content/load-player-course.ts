// src/content/load-player-course.ts — the door a player course comes in by.
// DEV-466, E0.
//
// `loadPlayerCourse(input)` is `loadLevel`'s counterpart for a course that was
// not bundled: validate the recipe, load its donor (`sky`), validate the
// recipe again against that donor, expand it, and hold the result to the same
// two gates every bundled level passes (`validateLevel`, `validateModeContent`).
// DEV-467 calls it from a `#c=` link or a picked file, and hands the level to
// `switchMission(id, { inLoadingScene: level })`.
//
// A separate file from `player-course.ts` because THIS one reaches
// `import.meta.glob` (through `load-level.ts`), which Playwright's transformer
// does not have: a spec that imported it would collect zero tests
// (`tests/unit/e2e-import-graph.test.ts`). The format itself stays importable
// from a spec; the loader does not need to be.

import { validateModeContent } from '@/game/modes'
import { withCourseWater } from '@/game/terrain/course-water'
import {
  type CustomGround,
  mapGround,
  seedGround,
  withCustomGround,
} from '@/game/terrain/custom-ground'
import { decodeHeightmap, heightmapSha } from './island-map'
import type { Level } from './level-schema'
import { validateLevel } from './level-schema'
import { generatedLevelIds, loadLevel } from './load-level'
import {
  expandPlayerCourse,
  groundKey,
  isMapIsland,
  isSeedIsland,
  type PlayerCourse,
  PlayerCourseError,
  seedVersion,
  validatePlayerCourse,
} from './player-course'

/**
 * A course, from anything, to a playable `Level` — or a `PlayerCourseError`
 * whose `errors` say what was refused and where. `input` is whatever a link or
 * a file decoded to; it is not trusted.
 */
export const loadPlayerCourse = async (
  input: unknown,
  /**
   * DEV-489: the course's own ground, when it has one. The seam DEV-490 (an
   * imported map) and DEV-493 (a seed) call: each decodes or synthesises a
   * `CustomGround` and hands it here, and the level comes back carrying it
   * (`withCustomGround`), so `switchMission` builds the player's island. No
   * course format holds a ground yet; absent is the sky's own island.
   */
  options: { readonly ground?: CustomGround | null } = {},
): Promise<Level> => {
  const parsed = validatePlayerCourse(input)
  if (!parsed.ok) throw new PlayerCourseError(parsed.errors)
  const course = parsed.course
  // A donor is a SHIPPED mission: the generated thirteen. An authored file (a
  // lesson, a perf fixture) is not a sky.
  if (!generatedLevelIds().includes(course.sky)) {
    throw new PlayerCourseError([['sky', 'is not a shipped mission']])
  }
  // DEV-490: a course on its own island is flown over THAT island or not at
  // all — never over its sky's, where its line would stand in the wrong place.
  const want = groundKey(course.ground)
  const have = options.ground?.key ?? (options.ground ? 'unkeyed' : '')
  if (want !== '' && have !== want) {
    throw new PlayerCourseError([
      ['island', have === '' ? 'its own island is not here' : 'is not the ground it was given'],
    ])
  }
  const donor = await loadLevel(course.sky)
  const level = validateModeContent(validateLevel(expandPlayerCourse(course, donor)))
  const grounded = options.ground ? withCustomGround(level, options.ground) : level
  // DEV-500: and its water, which the world build reads (`oceanFor`).
  return course.water ? withCourseWater(grounded, course.water) : grounded
}

/**
 * DEV-490: the ground a course stands on, from what came with it: null for a
 * course on its sky's own island; for an imported map, its FILE's bytes
 * decoded (`content/island-map.ts`) and set at the course's size, height and
 * waterline (`mapGround`). Throws `PlayerCourseError` when the map is absent,
 * is not the one the course names, or does not decode.
 */
export const courseGround = async (
  course: PlayerCourse,
  map: Uint8Array | null,
): Promise<CustomGround | null> => {
  const g = course.ground
  // DEV-493; DEV-499: the generator the course names
  if (isSeedIsland(g))
    return seedGround(g.seed, g.shape, course.island, groundKey(g), seedVersion(g))
  if (!isMapIsland(g)) return null
  if (!map) throw new PlayerCourseError([['island', 'its heightmap is not here']])
  if ((await heightmapSha(map)) !== g.map) {
    throw new PlayerCourseError([['island', 'its heightmap is not the one it names']])
  }
  const read = await decodeHeightmap(map)
  if (!read.ok) throw new PlayerCourseError([['island.map', read.error]])
  return mapGround(read.map, course.island, g, groundKey(g))
}
