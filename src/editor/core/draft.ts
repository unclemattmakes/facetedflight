// src/editor/core/draft.ts — the draft: a player course, the selection, and
// the author lap. DEV-468, E2 (docs/plan/EDITOR-DISPATCH.md, EDITOR.md §5.3).
//
// THREE-FREE AND DOM-FREE: everything under `src/editor/core/` runs in node and
// is unit-tested there. The desktop editor (DEV-469, `src/editor/desk/`) and the
// bench after it are two front-ends over this one draft.
//
// ── A draft is allowed to be unfinished ──────────────────────────────────
//
// `course` has the format's SHAPE (`PlayerCourse`, DEV-466) but not its
// validity: a new draft has no points, a half-drawn one has one, and a drag
// can carry a point outside the boundary for a frame. The validator judges it
// (`evaluateDraft`, which reports the refusal as warnings); nothing here refuses
// an edit because the result would not validate. What commands DO keep is the
// format's ranges on the numbers a control sets (gap, time limit, finish), so a slider cannot write a value no course could hold.
//
// ── The author lap belongs to one course ─────────────────────────────────
//
// It is stored with the course id it was flown on. Any edit that changes the
// course changes the id (`playerCourseId` hashes the canonical bytes), and the
// lap then no longer applies: `authorLapOf` returns null. Nothing has to
// remember to clear it, and an undo back to the flown course gets it back.

import { type Level, liveRings } from '@/content/level-schema'
import {
  anchored,
  normaliseYaw,
  PLAYER_COURSE_LIMITS,
  PLAYER_COURSE_SHAPE,
  PLAYER_COURSE_VERSION,
  type PlayerCourse,
  type PlayerCourseStart,
  playerCourseId,
  startStandUp,
} from '@/content/player-course'
import { anchorHeightFor } from './policy'

/** A clean lap from the start that took every ring, on the course `courseId`. */
export interface AuthorLap {
  readonly courseId: string
  readonly seconds: number
}

export interface EditorDraft {
  /** The course being made. Shaped like the format, not necessarily valid. */
  readonly course: PlayerCourse
  /** The selected control point's index, or null. */
  readonly selection: number | null
  /** The best author lap flown on this draft, for whichever course it was. */
  readonly authorLap: AuthorLap | null
  /**
   * The id of the course this one was remixed from, or null. Credit only:
   * DEV-467 owns the library the source came from.
   */
  readonly remixedFrom: string | null
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

/**
 * The donor's own ring spacing, metres: the mean straight distance between
 * consecutive live rings of its first route, to the format's gap quantum and
 * inside its limits. A new draft starts at the spacing its sky's mission was
 * built at, so the default is 2016's and not a number typed here (397–522 m
 * across the seven HoverJet missions).
 */
export const donorGap = (donor: Level): number => {
  // The first route only: `adv_01_hoverJet` ships two alternates, and the
  // chord from one route's last ring to the other's first is not a spacing.
  const first = donor.routes[0]
  const rings = first ? liveRings({ ...donor, routes: [first] }) : []
  const L = PLAYER_COURSE_LIMITS.gapMetres
  if (rings.length < 2) return L.max
  let total = 0
  for (let i = 1; i < rings.length; i++) {
    const a = (rings[i - 1] as (typeof rings)[number]).pos
    const b = (rings[i] as (typeof rings)[number]).pos
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  }
  const q = PLAYER_COURSE_SHAPE.gapQuantumMetres
  return clamp(Math.round(total / (rings.length - 1) / q) * q, L.min, L.max)
}

/**
 * Where a new draft's pad stands (DEV-475): on the SKY's own start — the dish
 * its lift leaves the ship in (`render/start-grid.ts`'s `releasePadOf`),
 * facing the way that start faces. A shipped place the ship is known to leave
 * from, inside the play area by construction. The desk seats it on the ground
 * it sees there once the ground is built; the author moves it from there.
 */
export const defaultStart = (donor: Level): PlayerCourseStart => {
  const p = donor.spawn.pos as number[]
  const standUp = startStandUp(donor) ?? 0
  const y = (p[1] as number) + (donor.spawn.launch?.rise ?? 0) - standUp
  const q = donor.spawn.quat as number[]
  // The heading of the sky's spawn quaternion: its nose (local −z), flattened.
  const qy = q[1] as number
  const qw = q[3] as number
  const qx = q[0] as number
  const qz = q[2] as number
  const fx = -2 * (qx * qz + qw * qy)
  const fz = -(1 - 2 * (qx * qx + qy * qy))
  return {
    pos: [p[0] as number, y, p[2] as number],
    yaw: normaliseYaw((Math.atan2(-fx, -fz) * 180) / Math.PI),
  }
}

/**
 * A new, empty draft over `donor` (the sky): its island, its ring spacing, its
 * time limit, its pad on the sky's own start (`defaultStart`) and the finish
 * at the line's end.
 *
 * DEV-501: ANCHORED. Its one point is the pad's — one gap ahead of it, at the
 * new-point height over its foot (`anchorHeightFor`) — so the first click on
 * the ground makes it a course, and the first ring is dead ahead of the pad.
 */
export const newDraft = (donor: Level, name: readonly [string, string]): EditorDraft => {
  const T = PLAYER_COURSE_LIMITS.timeLimitSeconds
  return {
    course: anchored({
      v: PLAYER_COURSE_VERSION,
      island: donor.environment,
      sky: donor.id,
      vehicle: 'hoverjet',
      mode: 'ringAttack',
      path: { points: [], gap: donorGap(donor), anchor: { h: anchorHeightFor(donor) } },
      rings: [],
      start: defaultStart(donor),
      finish: { t: 1 },
      timeLimit: clamp(donor.timer.timeLimit, T.min, T.max),
      name: [name[0], name[1]],
    }),
    selection: null,
    authorLap: null,
    remixedFrom: null,
  }
}

/** A draft that opens an existing course, credited as a remix of `remixedFrom`. */
export const draftFromCourse = (
  course: PlayerCourse,
  remixedFrom: string | null = null,
): EditorDraft => ({ course, selection: null, authorLap: null, remixedFrom })

/** The author lap if it was flown on the course as it stands now, else null. */
export const authorLapOf = (draft: EditorDraft): AuthorLap | null => {
  const lap = draft.authorLap
  if (!lap) return null
  return lap.courseId === safeCourseId(draft.course) ? lap : null
}

/**
 * The course's id, or null for a draft the hash cannot be taken of (no
 * points is fine; the canonical form of any shaped course hashes).
 */
export const safeCourseId = (course: PlayerCourse): string | null => {
  try {
    return playerCourseId(course)
  } catch {
    return null
  }
}
