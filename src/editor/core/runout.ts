// src/editor/core/runout.ts: "Extend run-out", the fix beside the
// `finish-no-runoff` note. DEV-889.
//
// Matt approved (2026-10-09, the agent playtest's question 6): the note that
// the line ends too close to the finish gate said only "add a point", and it
// appears on every five-click course. Now it has a button like Lift clear and
// Straighten run-in.
//
// What it does: one point is added past the line's end, straight on along the
// last stretch (level with the last point, and over the ground there where a
// ground is given), as far as the finish gate needs; the FINISH keeps its
// place in metres (its `t` is a fraction of a line that just got longer). So
// the course flies the same up to the gate, and the racers carry on through it.
//
// PURE, ONE UNDO STEP: a new draft, or the input itself when there is nothing
// to extend (a line with fewer than two points, no finish gate, a run-out
// already long enough, or no room inside the play area).

import type { Level, Vec3Tuple } from '@/content/level-schema'
import {
  insideArea,
  PLAYER_COURSE_LIMITS,
  PLAYER_COURSE_SHAPE,
  playerCourseArea,
  playerCourseSpline,
} from '@/content/player-course'
import { v3 } from '@/sim/math/vec3'
import type { EditorDraft } from './draft'
import { groundClearance } from './policy'
import type { Ground } from './warnings'

/** Metres the search for the shortest long-enough run-out steps by. */
const STEP = 5
/** The most a run-out will add, metres. */
const MOST = 600

const lengthOf = (draft: EditorDraft): number => {
  try {
    const s = playerCourseSpline(draft.course)
    return Number.isFinite(s.length) ? s.length : 0
  } catch {
    return 0
  }
}

export const extendRunout = (draft: EditorDraft, donor: Level, ground?: Ground): EditorDraft => {
  const c = draft.course
  const pts = c.path.points
  const n = pts.length
  const radius = donor.finish?.radius
  if (n < 2 || n >= PLAYER_COURSE_LIMITS.points.max || !(typeof radius === 'number')) return draft
  const L = lengthOf(draft)
  if (!(L > 0)) return draft
  const finishAt = c.finish.t * L
  if (L - finishAt >= radius) return draft
  const a = pts[n - 2] as Vec3Tuple
  const b = pts[n - 1] as Vec3Tuple
  const dx = b[0] - a[0]
  const dz = b[2] - a[2]
  const flat = Math.hypot(dx, dz)
  if (!(flat > 1e-6)) return draft
  const ux = dx / flat
  const uz = dz / flat
  const area = donor.environment === c.island ? playerCourseArea(donor) : null
  const Q = PLAYER_COURSE_SHAPE.pointQuantumMetres
  const spacing = PLAYER_COURSE_LIMITS.pointSpacingMetres.min
  const margin = Q * 2 + groundClearance()
  for (let d = Math.max(STEP, spacing); d <= MOST; d += STEP) {
    const x = b[0] + ux * d
    const z = b[2] + uz * d
    let y = b[1]
    if (ground) {
      const g = ground.surfaceAt(x, z)
      if (Number.isFinite(g)) y = Math.max(y, g + margin)
    }
    const p: Vec3Tuple = [x, y, z]
    if (area && !insideArea(area, v3(x, y, z))) return draft
    const points = [...pts, p]
    const longer: EditorDraft = {
      ...draft,
      course: { ...c, path: { ...c.path, points } },
      selection: n,
    }
    const L2 = lengthOf(longer)
    if (!(L2 > 0)) continue
    // The finish stays where it is in metres; its t is rounded DOWN to the grid,
    // so it can only move toward the start: more run-out, never less.
    const grid = PLAYER_COURSE_SHAPE.tQuantum
    const t = Math.max(grid, Math.floor(finishAt / L2 / grid) * grid)
    if (L2 - t * L2 >= radius + 1) {
      return { ...longer, course: { ...longer.course, finish: { t } } }
    }
  }
  return draft
}
