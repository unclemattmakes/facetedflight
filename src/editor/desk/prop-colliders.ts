// src/editor/desk/prop-colliders.ts — the world's colliding props, in the level's
// frame, for the editor core's prop warnings. DEV-503.
//
// `Props.near(a, b, reach)` (editor/core/warnings.ts) is asked in the LEVEL
// frame, THREE space, the frame a course's points and rings are written in.
// The colliders live in SIM space (`sim/props/collision.ts`: the height
// field's origin already added), and the two differ by the z mirror and
// nothing else: `level.spawn.pos` is THREE and "THREE -> SIM is the z mirror"
// (`no-prop-volumes.ts`'s `startPadClearings`). So the conversion is one
// negation each way, written here and nowhere else in the desk.
//
// The set is the world's LIVE one: what the game built for the world the desk
// draws, less whatever a course's clearing took out (DEV-502 writes the same
// `broken` flag every query skips). Whatever joins that set later (a level's
// hand-placed props, DEV-504) is judged with no change here.

import type { Vec3Tuple } from '@/content/level-schema'
import type { PropContact, Props } from '@/editor/core'
import { type PropColliders, propsNearSegment } from '@/sim/props/collision'

/**
 * `colliders` as the core's `Props`: level frame in, level frame out. Ids in
 * `leaveOut` are not reported (the world's copy of a draft's placed props,
 * which the desk hides); every id is shifted by `idBase`, so two sets can be
 * asked together without their ids meeting.
 */
export const collidersAsProps = (
  colliders: PropColliders,
  leaveOut: ReadonlySet<number> = new Set(),
  idBase = 0,
): Props => ({
  near(a, b, reach): PropContact[] {
    const out: PropContact[] = []
    for (const h of propsNearSegment(colliders, a[0], a[1], -a[2], b[0], b[1], -b[2], reach)) {
      if (leaveOut.has(h.id)) continue
      out.push({
        id: idBase + h.id,
        kind: h.kind,
        at: [h.x, h.y, -h.z] as Vec3Tuple,
        depth: h.depth,
      })
    }
    return out
  },
})

/** Several `Props` asked as one: every set's contacts (their ids must not meet). */
export const allProps = (sets: readonly Props[]): Props => ({
  near(a, b, reach): PropContact[] {
    return sets.flatMap((s) => s.near(a, b, reach))
  },
})
