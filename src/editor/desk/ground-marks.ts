// src/editor/desk/ground-marks.ts — what the desk draws RED where the course
// is in the ground. DEV-478.
//
// Matt, 2026-09-27: the editor WARNED that a ring was in a hill ("Ring 3: the
// ground reaches 73.1 m into its opening") and it was easy to miss, because it
// said so in a list. So the trouble is drawn where it is:
//
//   · a BURIED RING (`ring-in-ground`, an error): its opening's rim, the very
//     points `ringIntrusion` judged (`ringOpeningRim`), as a closed loop — the
//     circle drawn is the circle measured, not a second idea of the ring;
//   · a stretch of line UNDER THE GROUND (`line-under-ground`): the spline's
//     own samples over the warning's span, which the warning built from the
//     samples below the surface — so the red stretch is where the line is in
//     the rock, not the whole dip;
//   · DEV-486: a stretch of the RUN-IN under the ground (the straight from the
//     ship on its pad to point 1, a `line-under-ground` carrying `runIn`): its
//     own samples over that stretch, the straight rebuilt from the expanded
//     level's spawn (where `runInOf` begins it) and the curve's first sample.
//   · DEV-503: a ring a PROP reaches into (`ring-in-prop`, an error): its rim,
//     as the buried ring's; and a stretch of the line (or the run-in) within
//     reach of a colliding prop (`line-through-prop`): its samples, as the
//     stretch under the ground's. Kept on their own lists, so a reader can
//     tell the rock from the tree.
//
// Pure geometry, three-free, so `editor-lift.test.ts` holds it against the
// ground it came from in node; `view.ts` turns it into lines.

import type { CourseSpline } from '@/content/course-spline'
import { type Level, liveRings, type Vec3Tuple } from '@/content/level-schema'
import { type EditorWarning, ringOpeningRim, runInSamples } from '@/editor/core'

export interface GroundMarks {
  /** One closed loop per buried ring (its opening's rim), with the ring's index. */
  readonly rings: readonly { readonly ring: number; readonly rim: readonly Vec3Tuple[] }[]
  /** One polyline per stretch of line under the ground. */
  readonly under: readonly (readonly Vec3Tuple[])[]
  /** DEV-503: one closed loop per ring a prop reaches into, with the ring's index. */
  readonly propRings: readonly { readonly ring: number; readonly rim: readonly Vec3Tuple[] }[]
  /** DEV-503: one polyline per stretch of line within reach of a prop. */
  readonly propLine: readonly (readonly Vec3Tuple[])[]
}

export const NO_MARKS: GroundMarks = { rings: [], under: [], propRings: [], propLine: [] }

/**
 * A line warning's stretch as points: on the run-in's straight (`runIn`, the
 * straight rebuilt from the expanded level's spawn to the curve's first
 * sample) or on the curve (`span`, the spline's own samples over it). Empty
 * when the warning has neither, or there is nothing to draw it on.
 */
const stretchOf = (
  w: EditorWarning,
  level: Level | null,
  spline: CourseSpline | null,
): Vec3Tuple[] => {
  if (w.runIn && level && spline) {
    const a = level.spawn.pos
    const b = spline.samples[0]
    if (!b) return []
    const from = { x: a[0] as number, y: a[1] as number, z: a[2] as number }
    const length = Math.hypot(b.x - from.x, b.y - from.y, b.z - from.z)
    const [f0, f1] = w.runIn
    return runInSamples({ from, to: b, length })
      .filter((s) => s.f >= f0 - 1e-9 && s.f <= f1 + 1e-9)
      .map((s) => [s.at.x, s.at.y, s.at.z])
  }
  if (w.span && spline && spline.length > 0) {
    const L = spline.length
    // The span's ends ARE sample arcs (the warning took them off the table);
    // a hair either side keeps a float's last bit from dropping one.
    const s0 = w.span[0] * L - 1e-6
    const s1 = w.span[1] * L + 1e-6
    const run: Vec3Tuple[] = []
    spline.samples.forEach((p, i) => {
      const s = spline.arc[i] as number
      if (s >= s0 && s <= s1) run.push([p.x, p.y, p.z])
    })
    return run
  }
  return []
}

/**
 * The red marks for `warnings`, over the expanded `level` (the rings) and the
 * course's `spline` (the line). Either may be null: a course that does not
 * validate has no rings to bury, and fewer than two points no line.
 */
export const groundMarks = (
  warnings: readonly EditorWarning[],
  level: Level | null,
  spline: CourseSpline | null,
): GroundMarks => {
  const live = level ? liveRings(level) : []
  const rings: { ring: number; rim: Vec3Tuple[] }[] = []
  const under: Vec3Tuple[][] = []
  const propRings: { ring: number; rim: Vec3Tuple[] }[] = []
  const propLine: Vec3Tuple[][] = []
  for (const w of warnings) {
    if ((w.kind === 'ring-in-ground' || w.kind === 'ring-in-prop') && w.ring !== undefined) {
      const ring = live[w.ring]
      if (!ring) continue
      const loop = { ring: w.ring, rim: ringOpeningRim(ring) }
      if (w.kind === 'ring-in-ground') rings.push(loop)
      else propRings.push(loop) // DEV-503
    } else if (w.kind === 'line-under-ground' || w.kind === 'line-through-prop') {
      // DEV-486: a run-in's stretch lies on the straight itself.
      const run = stretchOf(w, level, spline)
      if (run.length === 0) continue
      if (w.kind === 'line-under-ground') under.push(run)
      else propLine.push(run) // DEV-503
    }
  }
  return { rings, under, propRings, propLine }
}
