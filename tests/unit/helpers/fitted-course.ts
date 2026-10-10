// tests/unit/helpers/fitted-course.ts: DEV-468's fixture course, moved out of
// `editor-course.ts` (DEV-851) so a Playwright spec can build it too: this file
// imports no three, no terrain and no loader. NOT a `.test.ts`.

import { nearestArc } from '@/content/course-spline'
import type { Level } from '@/content/level-schema'
import {
  PLAYER_COURSE_LIMITS,
  PLAYER_COURSE_VERSION,
  type PlayerCourse,
  playerCourseArea,
  playerCourseSpline,
} from '@/content/player-course'
import { v3 } from '@/sim/math/vec3'

type V = [number, number, number]

/** A valid course along 2016's own `int_01` line, finishing at 2016's gate. */
export const fittedCourse = (int01: Level): PlayerCourse => {
  const area = playerCourseArea(int01)
  if (!area) throw new Error('no area')
  const route = (int01.route as V[]).filter((p) => {
    if (area.kind !== 'sphere') return true
    const d = Math.hypot(p[0] - area.centre[0], p[1] - area.centre[1], p[2] - area.centre[2])
    return d < area.radius * 0.98
  })
  const points: V[] = []
  for (let i = 0; i < route.length; i += 12) points.push(route[i] as V)
  const last = route[route.length - 1] as V
  if (points[points.length - 1] !== last) points.push(last)
  const base: PlayerCourse = {
    v: PLAYER_COURSE_VERSION,
    island: int01.environment,
    sky: int01.id,
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    path: { points: points.slice(0, PLAYER_COURSE_LIMITS.points.max), gap: 400 },
    rings: [],
    // DEV-475: the pad at the line's first point, headed west (yaw 90).
    start: { pos: [...(points[0] as V)] as V, yaw: 90 },
    finish: { t: 1 },
    timeLimit: int01.timer.timeLimit,
    name: ['Amber', 'Heron'],
  }
  const spline = playerCourseSpline(base)
  const fin = int01.finish as NonNullable<Level['finish']>
  const t = nearestArc(spline, v3(fin.pos[0], fin.pos[1], fin.pos[2])) / spline.length
  return { ...base, finish: { t: Math.round(t * 1e4) / 1e4 } }
}
