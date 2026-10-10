// tests/unit/helpers/crash-line.ts: the line a crash puts a ship back on, built
// by the GAME's own functions (code-reuse SG-1).
//
// Three specs (`crash-reset-clearance`, `prop-hash-reach`,
// `spire-line-attribution`) each carried a hand copy of "the line
// `boot/app.ts`'s `makeCrashLine` builds". The copies were not that line, and
// the differences were the trap a copy sets (CLAUDE.md, trap 24: a test that
// re-derives its expectation does not test the code):
//
//   * their gates came from `level.routes['0'].rings`' `pos`, where the game
//     reads `courseGates(level)` at each live ring's `trigger.pos`. On the
//     shipped HoverJet courses the two are up to 1.86 m apart. (The ring set is
//     the same today, one route and every ring live; only the position differs.)
//   * they gave every gate `points: 100`, where the game reads the ring's score.
//
// Both only reach the gate POLYLINE (a level with no authored route, or the
// spire spec's deliberate chord), and measured against the old copies the
// only printed numbers that moved are the chord's: its length (up to 8 m on a
// 7.7 to 13.4 km line) and its closest approach to the sea stack (475.5 m to
// 476.5 m). No verdict changed. The `launch.rise` start was already right in
// all three, which the audit's note had wrong.
// This helper asks the game: `routeLineOf` for a route, `crashLineOf` (the
// function `makeCrashLine` wraps) for the rest.

import type { Level } from '@/content/level-schema'
import { crashLineOf, releasePointOf } from '@/game/course-specs'
import { courseGates } from '@/game/mission'
import { type CourseLine, gatePolylineLine, routeLineOf } from '@/sim/crash'
import type { Route } from '@/sim/route'

/**
 * The crash line for a mission, as the live game builds it. `kind` is for the
 * printed tables: "route" for the authored line, "gates(n)" for the polyline.
 */
export const shippedCrashLine = (level: Level): CourseLine & { kind: string } => {
  const gates = courseGates(level)
  const guide = level.route && level.route.length > 1 ? routeLineOf(level.route, gates) : null
  const line = crashLineOf(guide, level, gates)
  return { ...line, kind: guide ? 'route' : `gates(${gates.length})` }
}

/**
 * The straight path from the release point through every ring centre, even on
 * a level that has an authored route: the line a PLAYER who ignores the spline
 * flies, and the one the game falls back to when the guide is off. The same
 * function as the crash line's fallback, so the two cannot be told apart.
 */
export const shippedChord = (level: Level): Route =>
  gatePolylineLine(releasePointOf(level), courseGates(level)).route
