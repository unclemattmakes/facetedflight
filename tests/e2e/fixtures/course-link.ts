/**
 * A shared course's LINK, for the specs that need the title's other route into
 * a mission. DEV-558.
 *
 * Until DEV-558 the title had a QUICK RACE row, and specs that had to prove a
 * mission reached by a SWITCH from the title (`sun-switch.spec.ts`,
 * `haze-switch.spec.ts`; AGENT-NOTES §8) pressed it: one fade from the title
 * into the loading scene, then `switchMission(id, { inLoadingScene })`. The
 * title is START and ENTER VR now (Matt, 2026-10-01). The same route is taken
 * from the title by a shared course's `#c=` link (its row stands first on the
 * title, aimed), so a spec opens the page with one.
 *
 * The course is `player-course-share.spec.ts`'s: ten points on 2016's own
 * int_01 line, over int_01's sky, so the mission it boards wears int_01's sun
 * and fog. Built through `src/content/player-course.ts` and
 * `player-course-wire.ts` ONLY: the loader reaches a Vite-only glob
 * (`tests/unit/e2e-import-graph.test.ts`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { type PlayerCourse, playerCourseId } from '../../../src/content/player-course'
import { courseFragment } from '../../../src/content/player-course-wire'

type V = [number, number, number]
const INT01 = JSON.parse(
  fs.readFileSync(path.join('content', 'levels', 'int_01_hoverJet.json'), 'utf8'),
) as { route: V[]; environment: string; id: string }

/** The sky the course flies under: int_01's, so its sun and haze are int_01's. */
export const LINK_COURSE_SKY = INT01.id

/** Ten points on int_01's own line, rings every 400 m. */
export const LINK_COURSE: PlayerCourse = {
  v: 2,
  island: INT01.environment,
  sky: INT01.id,
  vehicle: 'hoverjet',
  mode: 'ringAttack',
  path: { points: Array.from({ length: 10 }, (_, i) => INT01.route[i * 12] as V), gap: 400 },
  rings: [],
  start: { pos: INT01.route[0] as V, yaw: 0 },
  finish: { t: 1 },
  timeLimit: 180,
  name: ['Amber', 'Heron'],
}

/** Its id, `pc_…`: what the title's row and `__ff2.course()` name. */
export const LINK_COURSE_ID = playerCourseId(LINK_COURSE)

/** The `#c=` fragment that opens the title on it. */
export const linkCourseFragment = (): Promise<string> => courseFragment(LINK_COURSE)

/** The title row the link stands (`render/title-menu.ts`'s `courseRowId`). */
export const LINK_COURSE_ROW = `course:${LINK_COURSE_ID}`
