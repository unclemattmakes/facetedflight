// src/editor/desk/slots.ts — where the racers stand beside the start pad.
// DEV-475. Pure: no three, no DOM, so `tests/unit/editor-desk.test.ts` runs it.
//
// The game's own list, laid over the spawn a course EXPANDS to: `racerStarts`
// (`game/racer-grid.ts`, the one `game/racers.ts` spawns the racers from) over
// `playerCourseSpawn` — 2016's two `ai` pads carried beside the player's pad,
// then the preset's slots (DEV-125's chevron). Each start comes with the pad
// under it, as `boot/app.ts` stands one: a 2016 `ai` pad at its own height, and
// under a start held at the release, a copy of the player's pad at the player's
// pad's height (`render/start-grid.ts`'s `padsUnder`).
//
// It lives in the desk, not in the core, because `game/racer-grid.ts` reaches
// the edition schema and that reaches a render module; the core judges the
// pads this returns (`evaluateDraft`'s `slots`) without importing either.

import type { EditionRacers } from '@/content/edition-schema'
import type { Level, Vec3Tuple } from '@/content/level-schema'
import { type PlayerCourseStart, playerCourseSpawn } from '@/content/player-course'
import {
  type AnchorAim,
  aimPad,
  anchorHeading,
  type EditorDraft,
  type Ground,
  groundClearance,
  movePad,
  padFootprint,
  type SlotPad,
} from '@/editor/core'
import { type RacerStart, racerStarts } from '@/game/racer-grid'
import { customGroundOf } from '@/game/terrain/custom-ground'

/** One racer's start on a player course, with the pad it stands on. */
export interface CourseSlot extends SlotPad {
  readonly start: RacerStart
  readonly foot: Vec3Tuple
}

/**
 * Where a NEW draft's pad is looked for. Feel, not physics: pinned by value
 * in `tests/unit/editor-desk.test.ts`.
 */
export const PAD_SPOT_POLICY = {
  /**
   * Metres between the places tried, ring by ring outward, and between the
   * samples of the ground round each: under a pad's 9.35 m width, so no
   * pad-sized patch of good (or bad) ground is stepped over.
   */
  stepMetres: 8,
  /** How far from the sky's own start to look, metres: past it, the pad stays where it was. */
  reachMetres: 2000,
  /**
   * Metres of room past the grid's own reach: a pad found there can be nudged
   * this far, and turned any way, with every racer still on dry ground.
   */
  marginMetres: 16,
} as const

/**
 * How far the grid reaches from the pad's centre, metres: the farthest
 * racer's pad, its half-width included. The same at any heading.
 */
export const gridReach = (donor: Level, racers: EditionRacers): number => {
  const origin: PlayerCourseStart = { pos: [0, 0, 0], yaw: 0 }
  let reach = 0
  for (const slot of courseSlots(origin, donor, racers)) {
    const half = Math.max(slot.size[0] as number, slot.size[2] as number) / 2
    reach = Math.max(reach, Math.hypot(slot.foot[0], slot.foot[2]) + half)
  }
  return reach
}

/**
 * The nearest place to `start` where the whole grid can stand, and TURN, on
 * dry ground: the pad's footprint within the hover height of level
 * (`clearance`), and every point within the grid's reach (plus the policy's
 * margin) dry and no higher than the lowest racer's pad rim, so the author can
 * aim the pad any way and nudge it and no racer lands in the hill or the sea.
 * The heading is kept. Null when nothing within reach will do.
 *
 * Why a new draft needs it: its pad begins on the SKY's start, and every
 * HoverJet sky starts on a deck over the sea (`int_01`'s stands at 124.8 m
 * with the water at 116.6), so seated where it began it would stand on the
 * waves. A search that proves the answer beats a guess that is usually
 * right (CLAUDE.md, DEV-041), and it runs once, when a draft is made.
 *
 * DEV-501 follow-up: with `accept`, the nearest good place `accept` takes
 * (`seatNewDraft`'s: one from which some heading clears ring 1); where it
 * takes none within reach, the nearest good place, as without it.
 */
export const padSpot = (
  ground: Ground,
  donor: Level,
  racers: EditionRacers,
  start: PlayerCourseStart,
  clearance: number,
  inside: (x: number, y: number, z: number) => boolean,
  accept?: (at: PlayerCourseStart) => boolean,
): PlayerCourseStart | null => {
  const size = donor.spawn.launch?.platform?.size as readonly number[] | undefined
  if (!size) return null
  const { stepMetres: step, reachMetres: reach, marginMetres } = PAD_SPOT_POLICY
  const disc = gridReach(donor, racers) + marginMetres
  const water = (x: number, z: number): boolean => ground.waterAt?.(x, z) === true
  const good = (x: number, z: number): PlayerCourseStart | null => {
    if (water(x, z)) return null
    const under = padFootprint(ground, [x, 0, z], size)
    if (!under || under.high - under.low > clearance) return null
    const at: PlayerCourseStart = { pos: [x, under.high, z], yaw: start.yaw }
    if (!inside(x, under.high, z)) return null
    // The lowest rim any racer's pad has: the ceiling for the ground round it.
    let ceiling = under.high + (size[1] as number)
    for (const slot of courseSlots(at, donor, racers)) {
      ceiling = Math.min(ceiling, slot.foot[1] + (slot.size[1] as number))
    }
    for (let r = step; r <= disc + 1e-9; r += step) {
      const n = Math.ceil((2 * Math.PI * r) / step)
      for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * k) / n
        const px = x + r * Math.cos(a)
        const pz = z + r * Math.sin(a)
        if (water(px, pz)) return null
        const h = ground.surfaceAt(px, pz)
        if (!Number.isFinite(h) || h > ceiling) return null
      }
    }
    return at
  }
  const [x0, , z0] = start.pos
  let nearest: PlayerCourseStart | null = null
  for (let r = 0; r <= reach; r += step) {
    const n = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / step)
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n
      const found = good(x0 + r * Math.cos(a), z0 + r * Math.sin(a))
      if (!found) continue
      if (!accept || accept(found)) return found
      nearest ??= found
    }
  }
  return nearest
}

/** A new draft's pad as `seatNewDraft` stands it. */
export interface SeatedDraft {
  /** The draft, its pad moved and aimed. */
  readonly draft: EditorDraft
  /** The heading search's verdict at the chosen place (`anchorHeading`). */
  readonly aim: AnchorAim
  /** The heading the pad had before it was aimed, for `anchorAimNote`. */
  readonly fromYaw: number
}

/**
 * DEV-501 follow-up: where a NEW draft's pad stands, and which way it faces —
 * a pure function of the draft, its base and the ground (so one seed gives one
 * new draft). The nearest good place to the sky's start (`padSpot`; on a
 * player's island, from the dry ground nearest it, `nearestDry`) from which
 * some heading clears ring 1 and the straight to it (`anchorHeading`), aimed
 * that way; where no good place within reach has one, the nearest good place,
 * aimed at the least-short heading, and `aim.clears` is false (the panel then
 * says to move the pad). Null where no place is good at all.
 */
export const seatNewDraft = (
  draft: EditorDraft,
  donor: Level,
  ground: Ground,
  racers: EditionRacers,
  inside: (x: number, y: number, z: number) => boolean,
): SeatedDraft | null => {
  const s = draft.course.start
  const from = customGroundOf(donor) ? (nearestDry(ground, s.pos, inside) ?? s.pos) : s.pos
  const clears = (at: PlayerCourseStart): boolean =>
    anchorHeading(movePad(draft, at.pos).course, donor, ground).clears
  const spot = padSpot(
    ground,
    donor,
    racers,
    { pos: from, yaw: s.yaw },
    groundClearance(),
    inside,
    draft.course.path.anchor ? clears : undefined,
  )
  if (!spot) return null
  const placed = movePad(draft, spot.pos)
  const aim = anchorHeading(placed.course, donor, ground)
  return { draft: aimPad(placed, aim.yaw), aim, fromYaw: s.yaw }
}

/**
 * DEV-490: the dry ground nearest `from` — not sea, on the terrain, inside the
 * play area — searched ring by ring outward, or null. Where a new draft's pad
 * search starts on a course's own island, whose sky's start (the donor
 * island's) is as likely open sea as not: DEV-489's cone put it there, and
 * `padSpot`'s 2 km reach never got ashore.
 */
export const nearestDry = (
  ground: Ground,
  from: readonly number[],
  inside: (x: number, y: number, z: number) => boolean,
  step = 32,
  reach = 12_000,
): Vec3Tuple | null => {
  const [x0, , z0] = from as [number, number, number]
  for (let r = 0; r <= reach; r += step) {
    const n = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / step)
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n
      const x = x0 + r * Math.cos(a)
      const z = z0 + r * Math.sin(a)
      if (ground.waterAt?.(x, z) === true) continue
      const y = ground.surfaceAt(x, z)
      if (Number.isFinite(y) && inside(x, y, z)) return [x, y, z]
    }
  }
  return null
}

/** The racers' starts for a start pad over `donor`, under `racers`' grid. Empty with no lift to copy. */
export const courseSlots = (
  start: PlayerCourseStart,
  donor: Level,
  racers: EditionRacers,
): CourseSlot[] => {
  const spawn = playerCourseSpawn(start, donor)
  const size = donor.spawn.launch?.platform?.size as readonly number[] | undefined
  if (!spawn || !size) return []
  const level = { ...donor, spawn, ghosts: [] } as Level
  const pads = spawn.startGrid.pads.filter((p) => p.role === 'ai')
  return racerStarts(level, racers).map((s) => {
    if (s.from.kind === 'pad') {
      const pad = pads[s.from.index]
      if (pad) return { start: s, foot: [...pad.pos] as Vec3Tuple, size: pad.size }
    }
    // Held at the release: on a copy of the player's pad, at its height.
    return { start: s, foot: [s.pos[0], start.pos[1], s.pos[2]] as Vec3Tuple, size }
  })
}
