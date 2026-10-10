// tests/unit/course-line.test.ts: one course-line builder, and the client and
// the lap server agree on it (code-reuse SG-1).
//
// `net/lap-validate.ts`'s `resetLineOf` says it builds the line "exactly as
// `boot/app.ts`'s `makeCrashLine` builds it", and that sentence was a promise
// kept by two hand-written copies. A crash reset the server judges against a
// different line than the client reset onto is a legal lap refused (or an
// illegal one accepted), so the claim is now a test: for EVERY course the
// server holds, the server's line and the client's are the same bytes, route
// and gate arcs both.
//
// The client's line comes from `crashLineOf`, the function `makeCrashLine`
// wraps (through `helpers/crash-line.ts`), and the server's from
// `resetLineOf` on the artefact `content/lap-courses.json`. Neither is
// re-derived here (trap 24).

import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { LAP_COURSES } from '@/net/lap-courses'
import { ghostCourseOf, resetLineOf } from '@/net/lap-validate'
import { gatePolyline, gatePolylineLine, resetLineFor, routeLineOf } from '@/sim/crash'
import { v3 } from '@/sim/math/vec3'
import { createRoute, gateArcLengths } from '@/sim/route'
import { shippedCrashLine } from './helpers/crash-line'
import { loadLevelJson } from './helpers/terrain-field'

const bytes = (a: Float32Array): number[] => Array.from(a)

describe('the lap server resets onto the line the client does', () => {
  const courses = Object.entries(LAP_COURSES.courses)

  it('the artefact holds courses (the loop below is not vacuous)', () => {
    expect(courses.length).toBeGreaterThan(3)
  })

  it.each(courses)('%s', (id, course) => {
    const level = loadLevelJson(id) as Level
    const client = shippedCrashLine(level)
    const server = resetLineOf(course, ghostCourseOf(course).gates)
    expect(server.route.count).toBe(client.route.count)
    expect(bytes(server.route.points)).toEqual(bytes(client.route.points))
    expect(bytes(server.route.cumulative)).toEqual(bytes(client.route.cumulative))
    expect(server.gateArc).toEqual(client.gateArc)
  })
})

describe('the builders', () => {
  const gates = [
    { centre: v3(100, 50, 200), radius: 20, points: 100, triggerOnce: true },
    { centre: v3(400, 80, 500), radius: 20, points: 100, triggerOnce: true },
    { centre: v3(900, 90, 450), radius: 20, points: 100, triggerOnce: true },
  ]
  const authored = [
    [0, 40, -150],
    [150, 55, -260],
    [300, 70, -420],
    [500, 85, -520],
    [900, 90, -450],
  ]

  it('routeLineOf is createRoute plus the arc of each gate on it', () => {
    const line = routeLineOf(authored, gates)
    const route = createRoute(authored)
    expect(bytes(line.route.points)).toEqual(bytes(route.points))
    expect(line.gateArc).toEqual(gateArcLengths(route, gates))
  })

  it('gatePolylineLine puts gate i at point i + 1, so its arc is cumulative[i + 1]', () => {
    const start = v3(0, 40, 150)
    const line = gatePolylineLine(start, gates)
    const route = gatePolyline(start, gates)
    expect(bytes(line.route.cumulative)).toEqual(bytes(route.cumulative))
    expect(line.gateArc).toEqual([1, 2, 3].map((i) => route.cumulative[i]))
    // And the search agrees with the lookup: the polyline passes through each centre.
    expect(line.gateArc).toEqual(gateArcLengths(route, gates))
  })

  it('resetLineFor takes the route at two points or more, the polyline otherwise', () => {
    const start = v3(0, 40, 150)
    expect(resetLineFor(authored, start, gates).gateArc).toEqual(
      routeLineOf(authored, gates).gateArc,
    )
    for (const none of [null, undefined, [], [[0, 0, 0]]]) {
      expect(resetLineFor(none, start, gates).gateArc).toEqual(
        gatePolylineLine(start, gates).gateArc,
      )
    }
  })

  it('no gates, no course: the 1 m stub, from the start', () => {
    const line = gatePolylineLine(v3(5, 6, 7), [])
    expect(line.gateArc).toEqual([])
    expect(line.route.length).toBeCloseTo(1, 5)
  })
})
