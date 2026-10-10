// src/game/course-specs.ts — what a level asks of the run around it: its
// boundary, its launch, the authored racing line, and the line a crash puts
// you back on.
//
// Lifted out of `boot/app.ts` (APP-SPLIT 2.2, `docs/plan/APP-SPLIT.md`), where
// each was a closure function reading `level`, `mission` and two URL pins.
// Here each takes those as arguments, so the course a mission swap produces is
// a function of the level and nothing else, and a test can build the same one
// the game does instead of copying it (`briefing-up.test.ts` used to carry a
// hand copy of the launch spec).
//
// `boot/app.ts` keeps its four `make*` names as one-line wrappers that pass
// the live level, mission and pins in, because a mission swap calls them again
// for the next level.

import type { Level } from '@/content/level-schema'
import type { MissionState } from '@/game/mission'
import { threeTupleToUnity } from '@/render/unity-space'
import type { BoundarySpec } from '@/sim/boundary'
import { type CourseLine, gatePolylineLine, routeLineOf } from '@/sim/crash'
import { type HoverJetSheet, hoverJetView, speedProfileModel } from '@/sim/hoverjet'
import type { LaunchSpec } from '@/sim/launch'
import type { Vec3 } from '@/sim/math/vec3'
import { type Route, routeArcThrough, withSpeedProfile } from '@/sim/route'

/** The level's boundary sphere, or null where it has none (6 of 13 shipped missions disable it). */
export const boundarySpecOf = (level: Level): BoundarySpec | null =>
  level.boundary.volume?.radius
    ? {
        enabled: level.boundary.enabled,
        centre: threeTupleToUnity({ x: 0, y: 0, z: 0 }, level.boundary.volume.centre as number[]),
        radius: level.boundary.volume.radius,
        resetDelaySeconds: level.boundary.resetDelay,
        fadeSeconds: level.boundary.resetFadeSeconds ?? 2.5,
      }
    : null

/** The level's launch — the lift and the countdown — or null where it has no lift. */
export const launchSpecOf = (level: Level, skipRide: boolean): LaunchSpec | null =>
  level.spawn.launch
    ? {
        keys: level.spawn.launch.keys,
        releaseAtSeconds: level.spawn.launch.releaseAtSeconds,
        countdownSteps: level.timer.countdown?.steps ?? 0,
        countdownStepSeconds: level.timer.countdown?.stepSeconds ?? 0,
        skipRide,
      }
    : null

/** The authored racing line, as the player proxy and the racers follow it. */
export interface RacingGuide {
  route: Route
  gateArc: readonly number[]
  /** The jet the velocity profile was built for (DEV-382 follow-up). */
  profiledFor: HoverJetSheet | null
  /**
   * Where the line runs through the finish, or NaN where it does not
   * (DEV-394): the autopilot flies the run home on the line when it can.
   */
  finishArc: number
}

/**
 * The velocity profile, for the jet that will fly it — `withSpeedProfile`'s
 * limits are measured off this game's own flight model, and its TOP speed is
 * that jet's boosted terminal (DEV-382 follow-up). Rebuilt in place, only
 * when the jet changes: the boot build makes its guide before its flight
 * exists, and the autopilot hands the flight's sheet in on its first tick.
 * A flight with no HoverJet sheet (the JumpSeat) is profiled for 2016's jet;
 * no HoverJet autopilot reads it.
 */
export const profileGuide = (
  guideNow: { readonly route: Route; profiledFor: HoverJetSheet | null },
  sheet: HoverJetSheet | undefined,
  lateralAccel: number,
): void => {
  const jet = sheet ?? hoverJetView({})
  if (guideNow.profiledFor === jet) return
  // DEV-394: the braking and the acceleration are this jet's own, off its sheet.
  withSpeedProfile(guideNow.route, speedProfileModel(jet, lateralAccel))
  guideNow.profiledFor = jet
}

/**
 * The guide over `routePoints` (the level's `route`, or null under
 * `?guide=off`), or null where there is no line to follow.
 */
export const guideFor = (
  routePoints: Level['route'] | null,
  mission: Pick<MissionState, 'course' | 'finishGate'>,
  sheet: HoverJetSheet | undefined,
  lateralAccel: number,
): RacingGuide | null => {
  if (!routePoints || routePoints.length <= 1) return null
  const line = routeLineOf(routePoints, mission.course.gates)
  const guide: RacingGuide = {
    route: line.route,
    gateArc: line.gateArc,
    profiledFor: null as HoverJetSheet | null,
    finishArc: Number.NaN,
  }
  const home = mission.finishGate
  if (home) guide.finishArc = routeArcThrough(guide.route, home, home.radius)
  profileGuide(guide, sheet, lateralAccel)
  return guide
}

/**
 * The course a CRASH puts you back on (DEV-126): the authored line when the
 * mission has one — the same `Route` the guide follows, so the player and the
 * racers are reset onto one line — and the polyline through the gate centres
 * from the release point when it does not.
 */
export const crashLineOf = (
  guide: Pick<RacingGuide, 'route' | 'gateArc'> | null,
  level: Level,
  gates: MissionState['course']['gates'],
): CourseLine => {
  if (guide) return { route: guide.route, gateArc: guide.gateArc }
  return gatePolylineLine(releasePointOf(level), gates)
}

/**
 * Where the lift lets go, SIM space: `spawn.pos` raised by `launch.rise`, with
 * THREE -> SIM done once here (the z mirror) the way `racers.ts` does it. The
 * lap server's `course.release` is the same number, built into
 * `content/lap-courses.json` by `net/lap-courses-build.ts`.
 */
export const releasePointOf = (level: Level): Vec3 => {
  const pos = level.spawn.pos as number[]
  return {
    x: pos[0] as number,
    y: (pos[1] as number) + (level.spawn.launch?.rise ?? 0),
    z: -(pos[2] as number),
  }
}
