// tests/unit/jumpseat-pilot-respawn.test.ts — a respawn restarts the autopilot's
// tour, as it restarts the run.
//
// Found chasing DEV-530's e2e sweep. `int_02_jumpSeat` in the browser, twice on
// DEV-530's legs and once on the legs before it: the autopilot struck its head
// in the air at ~97 s, the run restarted at the respawn marker, and then struck
// again within three seconds of EVERY restart, taking one plate in 217 s. The
// seam's `respawn()` reset the seat, the gear, the feet, the tank, the head and
// the stranded rule, and not the pilot: its cursor stayed on pad 6, so from the
// respawn marker it flew straight at a far pad, low, into whatever the head met
// first. The headless harness (`helpers/jumpseat-run.ts`) ENDS at a head strike
// and never respawns, which is why no unit run had ever seen it.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { autopilotFinishPad, autopilotWaypointsFor } from '@/game/jumpseat-flight'
import {
  createJumpSeatPilot,
  type JumpSeatPilot,
  planJumpSeatRoute,
  resetJumpSeatPilot,
} from '@/sim/jumpseat-autopilot'
import { loadJumpSeatLevel } from './helpers/jumpseat-run'

const routeOf = (id: string) => {
  const level = loadJumpSeatLevel(id)
  const [x, y, z] = level.respawn.pos as [number, number, number]
  return planJumpSeatRoute(autopilotWaypointsFor(level), { x, y, z: -z }, autopilotFinishPad(level))
}

/** A pilot as a run leaves it: deep in the tour, diverted, mid-hop. */
const wornPilot = (route: ReturnType<typeof routeOf>): JumpSeatPilot => {
  const p = createJumpSeatPilot(route)
  p.head = { box: null, surfaces: [], props: null } as unknown as JumpSeatPilot['head']
  p.cursor = Math.min(5, route.length - 1)
  p.phase = 'settle' as JumpSeatPilot['phase']
  p.onStopSeconds = 4.2
  p.abandoned = 1
  p.divert = 2
  p.diversions = 3
  p.boost = true
  p.aim.x = 117
  p.aim.y = 490
  p.aim.z = 457
  p.spider.hops = 7
  p.spider.divert = 1
  p.spider.order.push(3, 1, 2)
  p.spider.bestRange = 12
  return p
}

/** Everything but the parts the reset deliberately keeps. */
const state = (p: JumpSeatPilot) => {
  const { head: _head, route: _route, ...rest } = p
  return JSON.parse(JSON.stringify(rest, (_k, v) => (v === Infinity ? 'Infinity' : v)))
}

describe('a respawn restarts the pilot’s tour', () => {
  it('puts every field createJumpSeatPilot builds back to what it builds', () => {
    const route = routeOf('int_02_jumpSeat')
    expect(route.length).toBeGreaterThan(5)
    const p = wornPilot(route)
    expect(state(p)).not.toEqual(state(createJumpSeatPilot(route)))
    resetJumpSeatPilot(p)
    expect(state(p)).toEqual(state(createJumpSeatPilot(route)))
    expect(p.cursor).toBe(0)
  })

  it('keeps the route, the head guard, and the identity of aim and spider', () => {
    const route = routeOf('int_02_jumpSeat')
    const p = wornPilot(route)
    const { head, aim, spider } = p
    resetJumpSeatPilot(p)
    expect(p.route).toBe(route)
    expect(p.head).toBe(head)
    expect(p.aim).toBe(aim)
    expect(p.spider).toBe(spider)
  })

  it('leaves a SECOND pilot alone (trap 19)', () => {
    const route = routeOf('int_02_jumpSeat')
    const a = wornPilot(route)
    const b = wornPilot(route)
    const before = state(b)
    resetJumpSeatPilot(a)
    expect(state(b)).toEqual(before)
  })

  it('is what the seam’s respawn() does', () => {
    // The seam needs the GLBs to build, so this is read off its source: the
    // body of `respawn()` in `game/jumpseat-flight.ts` resets the pilot.
    const src = fs.readFileSync('src/game/jumpseat-flight.ts', 'utf8')
    const start = src.indexOf('    respawn() {')
    expect(start).toBeGreaterThan(0)
    const end = src.indexOf('\n    },', start)
    expect(src.slice(start, end)).toContain('resetJumpSeatPilot(pilot)')
  })
})
