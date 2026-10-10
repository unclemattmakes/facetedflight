// src/game/props/course-clearing.ts — the ground a world's forest leaves
// alone, and a PLAYER COURSE's own clearing along its flown line. DEV-502.
//
// Matt, 2026-09-28: *"let's add clearing along the line"* (docs/plan/
// EDITOR-PROPS.md). Until this row the shipped islands cleared a player
// course's start pad and nothing else (DEV-475), and a custom island (DEV-489)
// cleared chords from the pad to gate 0, then gate to gate. A chord cuts the
// inside of a bend and leaves trees on the outside of it, which is where the
// jet flies.
//
// ── Two lists, and why a player course's is a MASK ───────────────────────
//
// `worldClearings` splits what a world clears into two:
//
//   fixed    SUBTRACTED at load (`withoutVolumes`), before the buckets, the
//            culling cells and the collider inputs. Every shipped mission's
//            whole list, BYTE FOR BYTE what `boot/app.ts` built before this
//            row (`tests/unit/course-clearing.test.ts` sweeps all thirteen and
//            the authored lessons against the placed props they leave).
//   course   a player course's own: its start pad (DEV-475), the island's
//            authored volumes resolved against ITS pad and rings (DEV-287),
//            and the capsule chain along its flown line. MASKED on the loaded
//            forest (`createLineMask`) rather than subtracted: the instance
//            stays in its batch with a zero matrix and its collider is taken
//            out (`setPropCleared`), so the editor can move the line and put
//            back the trees the old one took. A subtraction cannot be undone
//            without rebuilding the world.
//
// Everything a player course clears is on the second list for the same
// reason: every one of those volumes moves when the author moves the pad or
// the line, and a clearing that could not follow would leave a bald stripe
// where the line USED to be, in the editor's world after a playtest.
//
// ── The line is the FLOWN line, not the chords ───────────────────────────
//
// `level.route` for a player course is the curve itself, sampled every
// `PLAYER_COURSE_SHAPE.routeSpacingMetres` (25 m) from the ship on its pad,
// through the run-in (DEV-486) to the line's first point, then along the
// curve to its end — past the finish, as 2016's own routes run on. The chain
// of capsules along it is cut at the finish: `flownLine` walks the rings in
// order and then the finish, each found where the route passes inside its own
// trigger radius, so a loop that passes its finish early cannot end the line
// there. A course whose rings do not all match keeps its whole route: the
// failure clears more, never less.
//
// PURE and three-free: the arithmetic of a line and a few capsules, so the
// test sweeps it in node with no assets.

import { type Level, liveRings, type Vec3Tuple } from '@/content/level-schema'
import type { NoPropVolumeFile } from '@/content/no-prop-volumes'
import { PLAYER_COURSE_GENERATOR } from '@/content/player-course'
import { padSurfaces } from '@/game/targets'
import { courseCorridor } from '@/game/terrain/custom-ground'
import { lerp } from '@/sim/math/scalar'
import { type Clearing, insideAnyClearing } from '@/sim/props/clearing'
import {
  padClearings,
  type ResolvedVolumes,
  resolveNoPropVolumes,
  startPadClearings,
} from './no-prop-volumes'

/** A point in plan, SIM world space (THREE's z mirrored). */
export interface PlanPoint {
  readonly x: number
  readonly z: number
}

/**
 * Is `level` a PLAYER course — the `pc_` id `playerCourseId` gives and the
 * generator `expandPlayerCourse` stamps? Both, so a hand-authored level that
 * borrowed either one alone is not mistaken for one.
 */
export const isPlayerCourseLevel = (level: Level): boolean =>
  level.generated?.generator === PLAYER_COURSE_GENERATOR && level.id.startsWith('pc_')

/** Where a point lies along segment `a`→`b` in plan and in 3D: its parameter and its distance. */
const onSegment = (
  a: readonly number[],
  b: readonly number[],
  p: readonly number[],
): { readonly u: number; readonly d: number } => {
  const ex = (b[0] as number) - (a[0] as number)
  const ey = (b[1] as number) - (a[1] as number)
  const ez = (b[2] as number) - (a[2] as number)
  const len2 = ex * ex + ey * ey + ez * ez
  const px = (p[0] as number) - (a[0] as number)
  const py = (p[1] as number) - (a[1] as number)
  const pz = (p[2] as number) - (a[2] as number)
  const u = len2 > 0 ? Math.min(1, Math.max(0, (px * ex + py * ey + pz * ez) / len2)) : 0
  return { u, d: Math.hypot(px - u * ex, py - u * ey, pz - u * ez) }
}

/**
 * A player course's flown line in plan, SIM world space: the ship on its pad,
 * the run-in, then the curve to the finish (see the header). Null for any
 * level that is not a player course, and for one with no route.
 */
export const flownLine = (level: Level): PlanPoint[] | null =>
  flownRoute(level)?.map((p) => ({ x: p[0], z: -p[2] })) ?? null

/**
 * The same line in 3D, THREE space as the level carries it: `level.route` cut
 * at the finish (the header). What a probe sweeps a hull along; `flownLine`
 * is its plan.
 */
export const flownRoute = (level: Level): Vec3Tuple[] | null => {
  if (!isPlayerCourseLevel(level)) return null
  const route = level.route ?? []
  if (route.length === 0) return null
  // The targets in the order the line takes them: every live ring, then the
  // finish gate where the sky has one (with none the run ends on the last ring).
  const targets = liveRings(level).map((r) => ({ pos: r.pos, reach: r.trigger.radius }))
  if (level.finish?.shape === 'sphereUnion') {
    targets.push({ pos: level.finish.pos, reach: level.finish.radius })
  }
  let seg = 0
  let cut: { seg: number; u: number } | null = null
  for (const t of targets) {
    // The first pass INSIDE the target's reach, then on to that pass's
    // closest approach: the reach is a gate's whole trigger (the finish's is
    // tens of metres), and the line takes the gate where it is nearest it.
    let found = -1
    let u = 0
    let best = Number.POSITIVE_INFINITY
    for (let i = seg; i + 1 < route.length; i++) {
      const hit = onSegment(route[i] as number[], route[i + 1] as number[], t.pos)
      if (found < 0 ? hit.d <= t.reach : hit.d <= best) {
        found = i
        u = hit.u
        best = hit.d
      } else if (found >= 0) {
        break
      }
    }
    if (found < 0) {
      cut = null // a target the line never reaches: keep the whole route
      break
    }
    seg = found
    cut = { seg: found, u }
  }
  const copy = (p: readonly number[]): Vec3Tuple => [p[0] as number, p[1] as number, p[2] as number]
  if (!cut) return route.map(copy)
  const out = route.slice(0, cut.seg + 1).map(copy)
  const a = route[cut.seg] as number[]
  const b = (route[cut.seg + 1] ?? a) as number[]
  const at = (k: number): number => lerp(a[k] as number, b[k] as number, cut.u)
  out.push([at(0), at(1), at(2)])
  return out
}

/**
 * The capsule chain along a player course's flown line, `radius` wide, in the
 * terrain's MESH space (`origin` is the terrain's SIM origin: the one
 * subtraction `game/props/no-prop-volumes.ts` makes). Empty for anything but
 * a player course, and for a radius that is not positive. A lone point (a
 * route of one) is a cylinder.
 */
export const lineClearings = (
  level: Level,
  radius: number | null | undefined,
  origin: readonly number[],
): Clearing[] => {
  if (!(typeof radius === 'number' && radius > 0)) return []
  const line = flownLine(level)
  if (!line || line.length === 0) return []
  if (line.length === 1) {
    const p = line[0] as PlanPoint
    return [{ x: p.x - (origin[0] ?? 0), z: p.z - (origin[2] ?? 0), radius }]
  }
  // `courseCorridor` is the chain: one capsule per pair, ends shifted by the
  // origin. Reused, so a custom island's old chords and this line are one
  // spelling of "capsules between consecutive points".
  return courseCorridor(line, radius, origin)
}

/** What a world is being built for, as `worldClearings` needs it. */
export interface WorldClearingInput {
  readonly level: Level
  /** `content/no-prop-volumes.json`; null on a custom island, whose ground is not the file's. */
  readonly volumes: NoPropVolumeFile | null
  /** The land terrain's SIM origin: `terrainOriginSim` on a shipped island, the height field's on a custom one. */
  readonly origin: readonly number[]
  /** The RUNNING course's live gates, SIM space, in order (`mission.course.gates`). */
  readonly gates: readonly PlanPoint[]
  /** The level's island's DEV-100 `spawnClearing.radius` (51.97 m on every island). */
  readonly spawnRadius: number | null | undefined
  /**
   * A custom island's donor's `spawnClearing.radius`, or null on a shipped
   * island. Non-null only where the world stands on a custom ground.
   */
  readonly customRadius: number | null | undefined
  /** The world stands on a custom ground (DEV-489). */
  readonly custom: boolean
}

export interface WorldClearings {
  /** Subtracted at load. Every shipped mission's whole list, as it always was. */
  readonly fixed: readonly Clearing[]
  /** A player course's own, MASKED on the loaded forest (the header). Empty on every other level. */
  readonly course: readonly Clearing[]
  /** The authored volumes as resolved, for the console's receipt. */
  readonly resolved: ResolvedVolumes
  /** How many of `fixed` are pad clearings rather than authored volumes (DEV-345, DEV-475, DEV-489). */
  readonly padCount: number
}

/**
 * Everything a world clears, split into what is subtracted at load and what
 * a player course masks (the header). `boot/app.ts` builds a world from it,
 * and the editor re-masks a draft's `course` list on the world it draws.
 */
export const worldClearings = (input: WorldClearingInput): WorldClearings => {
  const { level, origin } = input
  const resolved = resolveNoPropVolumes(input.custom ? null : input.volumes, {
    environmentId: level.environment,
    missionId: level.id,
    origin,
    anchors: {
      spawn: {
        x: (level.spawn.pos[0] as number) ?? 0,
        z: -((level.spawn.pos[2] as number) ?? 0),
      },
      gates: input.gates,
    },
  })
  // DEV-345: every live JumpSeat pad's landing surface. Empty on a HoverJet
  // course, a player's included (`pads: []`). Always fixed: a pad is the
  // level's, and nothing an author does moves it.
  const pads = padClearings(padSurfaces(level), origin)
  if (isPlayerCourseLevel(level)) {
    return {
      fixed: pads,
      course: [
        ...resolved.volumes,
        // DEV-475: the start pad's deck.
        ...padClearings(startPadClearings(level, input.spawnRadius), origin),
        // DEV-502: and the flown line.
        ...lineClearings(level, input.spawnRadius, origin),
      ],
      resolved,
      padCount: pads.length,
    }
  }
  // Every other level: the list `boot/app.ts` built before DEV-502, in its
  // order. `startPadClearings` is empty for anything but a player course; the
  // chord corridor survives only for a SHIPPED mission put on a custom ground
  // by the preview build's `?island=` door, which is not a player's course.
  const corridor = input.custom
    ? courseCorridor(
        [{ x: level.spawn.pos[0] as number, z: -(level.spawn.pos[2] as number) }, ...input.gates],
        input.customRadius ?? 0,
        origin,
      )
    : []
  const fixed = [
    ...resolved.volumes,
    ...pads,
    ...padClearings(startPadClearings(level, input.spawnRadius), origin),
    ...corridor,
  ]
  return { fixed, course: [], resolved, padCount: fixed.length - resolved.volumes.length }
}

// ── The mask: a course clearing on a forest already loaded ────────────────

/** What one mask of a world's scatter did, for the console, `__ff2` and the editor. */
export interface LineClearingReceipt {
  /** The level whose clearing it is. */
  readonly level: string
  /** Capsules and cylinders in the clearing. */
  readonly clearings: number
  /** Scatter props masked now. */
  readonly masked: number
  /** Hidden by this mask, and shown again by it. */
  readonly hidden: number
  readonly shown: number
  /** Scatter props in the world. */
  readonly scatter: number
  /** Wall time of the mask, milliseconds: the grid walk, the diff, the repacks and the colliders. */
  readonly ms: number
}

/** What one `update` changed: scatter ids to hide, and ids to show again. */
export interface LineMaskChange {
  readonly hide: readonly number[]
  readonly show: readonly number[]
}

/**
 * A course clearing held over a loaded forest's SCATTER, by collider id.
 *
 * `update(clearings, standing)` masks exactly the scatter inside `clearings`
 * and reports the difference from what it masked before. An id is newly
 * masked only while `standing(id)`: a tree already broken in flight (DEV-136)
 * is not the mask's, so the mask never shows it again either. `masked` is the
 * live state, one byte per scatter id.
 */
export interface LineMask {
  readonly masked: Uint8Array
  /** How many scatter ids are masked now. */
  count(): number
  update(clearings: readonly Clearing[], standing: (id: number) => boolean): LineMaskChange
}

/**
 * A mask over `points` — the scatter's placements in MESH space, collider ids
 * `0 … points.length − 1` — bucketed on a `cellMetres` grid so an update costs
 * the ground its capsules cover rather than a sweep of the whole forest.
 */
export const createLineMask = (
  points: readonly { readonly x: number; readonly z: number }[],
  cellMetres: number,
): LineMask => {
  const n = points.length
  const cell = cellMetres > 0 ? cellMetres : 1
  const buckets = new Map<string, number[]>()
  const key = (cx: number, cz: number): string => `${cx},${cz}`
  for (let id = 0; id < n; id++) {
    const p = points[id] as { x: number; z: number }
    const k = key(Math.floor(p.x / cell), Math.floor(p.z / cell))
    const list = buckets.get(k)
    if (list) list.push(id)
    else buckets.set(k, [id])
  }
  const masked = new Uint8Array(n)
  const inside = new Uint8Array(n)
  let live = 0
  const one: Clearing[] = []
  return {
    masked,
    count: () => live,
    update(clearings, standing) {
      inside.fill(0)
      for (const c of clearings) {
        const x2 = c.x2 !== undefined && c.z2 !== undefined ? c.x2 : c.x
        const z2 = c.x2 !== undefined && c.z2 !== undefined ? c.z2 : c.z
        const cx0 = Math.floor((Math.min(c.x, x2) - c.radius) / cell)
        const cx1 = Math.floor((Math.max(c.x, x2) + c.radius) / cell)
        const cz0 = Math.floor((Math.min(c.z, z2) - c.radius) / cell)
        const cz1 = Math.floor((Math.max(c.z, z2) + c.radius) / cell)
        one[0] = c
        for (let cx = cx0; cx <= cx1; cx++) {
          for (let cz = cz0; cz <= cz1; cz++) {
            const list = buckets.get(key(cx, cz))
            if (!list) continue
            for (const id of list) {
              if (inside[id]) continue
              const p = points[id] as { x: number; z: number }
              // The one point-in-capsule test the load-time subtraction uses.
              if (insideAnyClearing(p.x, p.z, one)) inside[id] = 1
            }
          }
        }
      }
      const hide: number[] = []
      const show: number[] = []
      for (let id = 0; id < n; id++) {
        if (inside[id] && !masked[id]) {
          if (!standing(id)) continue
          masked[id] = 1
          live++
          hide.push(id)
        } else if (!inside[id] && masked[id]) {
          masked[id] = 0
          live--
          show.push(id)
        }
      }
      return { hide, show }
    },
  }
}
