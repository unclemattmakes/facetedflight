// tests/unit/tv-exhibition.test.ts — the AI racers race for nobody, and
// nothing is written down. DEV-483 (plan/FF-TV.md §4.0).
//
// The machine is `game/tv/exhibition.ts`, the very one `boot/app.ts` drives;
// the host here is headless: Anniversary's real grid on the real course, the
// real racer field with `player: null`, no terrain (the terrain changes where
// a racer flies, not whether a race finishes). What is asserted:
//
//  1. The field reaches GO and the FINISH with no player in it — the finding
//     the row asked for (`exhibition.ts`'s header) — and the loop then boards
//     the next course, which is never the one just flown.
//  2. `craft()` is the hand-off DEV-481's camera reads: one entry per craft,
//     places 1..n, drawn poses, a heading that agrees with the drawn velocity.
//  3. A lap link flies one ghost beside the five, on the lap's course, and the
//     race waits for it.
//  4. **An exhibition run to its finish writes nothing.** At the finish — the
//     moment a race records — every record door is knocked on as the game's
//     finish block knocks on it (`recordRun`, `keepLap`, `submitLap`,
//     `submitRoomLap`), against a spied store and a spied fetch: zero writes,
//     zero requests. Then the exhibition stops and the same calls DO write,
//     which proves the doors work and the hold does not leak into the
//     player's next run. Shown red by deleting each door's guard.
//  5. Cut-in happens at the finish, never mid-race.

import { afterEach, describe, expect, it } from 'vitest'
import { type Edition, validateEdition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { loadLevel } from '@/content/load-level'
import { keepLap } from '@/game/ghost-store'
import { courseGates } from '@/game/mission'
import { loadMissionIndex } from '@/game/mission-index'
import { runningMode } from '@/game/modes'
import { recordRun } from '@/game/personal-best'
import { quickRacePool } from '@/game/quick-race'
import { racerStarts } from '@/game/racer-grid'
import { assignTunings } from '@/game/racers'
import { raceTimeLimit } from '@/game/results-state'
import {
  createExhibition,
  EXHIBITION_COUNTDOWN_SECONDS,
  EXHIBITION_RESULTS_SECONDS,
  type ExhibitionDriver,
  type ExhibitionField,
  type ExhibitionGhost,
  type ExhibitionHost,
  type ExhibitionLap,
  type ExhibitionOptions,
  type ExhibitionResult,
  TV_LAP_NAME,
} from '@/game/tv/exhibition'
import { recordingHeld } from '@/game/tv/off-the-record'
import { TV_SLOT_SECONDS } from '@/game/tv/tv-schedule'
import { submitLap, submitRoomLap } from '@/net/lap-client'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { AI_RACER_TUNINGS, type AiRacer, createAiRacer, gateArcLengths } from '@/sim/ai-racer'
import { FIXED_DT } from '@/sim/constants'
import type { LapDoc } from '@/sim/ghost'
import { createLapRecorder, recordedLap, recordPose } from '@/sim/ghost-record'
import { v3 } from '@/sim/math/vec3'
import { createRacerField, stepRacerField } from '@/sim/racer-field'
import { createRoute, routeAt } from '@/sim/route'
import anniversaryJson from '../../content/editions/anniversary.json'

const ANNIVERSARY: Edition = validateEdition(anniversaryJson as unknown as Edition)
const RACERS = ANNIVERSARY.gameplay.racers

/** A course's racer field, headless: `game/racers.ts`'s recipe with no meshes. */
const headlessField = (level: Level): ExhibitionField & { racers: AiRacer[] } => {
  const gates = courseGates(level)
  const route = level.route && level.route.length > 1 ? createRoute(level.route) : null
  const guide = route ? { route, gateArc: gateArcLengths(route, gates) } : null
  const finish = level.finish
    ? {
        x: level.finish.pos[0] as number,
        y: level.finish.pos[1] as number,
        z: -(level.finish.pos[2] as number),
        radius: level.finish.radius,
      }
    : null
  const starts = racerStarts(level, RACERS)
  const assigned = assignTunings(starts)
  const racers = starts.map((start, i) => {
    const { id, tuning } = assigned[i] as { id: string; tuning: string }
    const spawn = threeTupleToUnity(v3(), [start.pos[0], start.pos[1], start.pos[2]])
    const q = { x: 0, y: 0, z: 0, w: 1 }
    threeQuatTupleToUnity(q, start.quat as unknown as number[])
    return createAiRacer(
      {
        id,
        spawn,
        orientation: [q.x, q.y, q.z, q.w],
        tuning: AI_RACER_TUNINGS[tuning] as (typeof AI_RACER_TUNINGS)[string],
      },
      gates,
      finish,
    )
  })
  const field = createRacerField(racers, route)
  const rules = { separation: RACERS.separation, contact: RACERS.contact, player: null }
  return {
    racers,
    line: guide,
    timeLimit: raceTimeLimit(level, runningMode(level)),
    step: (dt) =>
      stepRacerField(
        field,
        racers,
        gates,
        [],
        dt,
        guide,
        [],
        ANNIVERSARY.gameplay.crash,
        null,
        rules,
      ),
    pose: (i, p, q) => {
      const b = (racers[i] as AiRacer).jet.body
      // SIM to THREE: z mirrored (`render/unity-space.ts`'s flips).
      p.x = b.position.x
      p.y = b.position.y
      p.z = -b.position.z
      q.x = -b.orientation.x
      q.y = -b.orientation.y
      q.z = b.orientation.z
      q.w = b.orientation.w
    },
  }
}

/** A board lap along a course's line at 150 m/s, built by the game's own recorder. */
const lapAlong = (level: Level, id: string): ExhibitionLap => {
  const route = createRoute(level.route as number[][])
  const rec = createLapRecorder([0, 0, 0], 16_384)
  const step = 150 * FIXED_DT
  const p = v3()
  let tick = 0
  for (let s = 0; s < (route.cumulative[route.count - 1] as number); s += step) {
    routeAt(route, s, p)
    recordPose(rec, tick++, p, { x: 0, y: 0, z: 0, w: 1 })
  }
  const doc = recordedLap(rec, {
    mission: level.id,
    mode: 'ringAttack',
    edition: 'anniversary',
    rules: 'test',
    vehicle: 'hoverjet:standard',
    build: 'unit',
  })
  return { id, mission: level.id, doc, seconds: tick * FIXED_DT, handle: 'BOARD ACE' }
}

interface Rig {
  host: ExhibitionHost
  boarded: string[]
  log: string[]
  field: () => (ExhibitionField & { racers: AiRacer[] }) | null
  ghosts: { lap: ExhibitionLap; disposed: boolean; clock: number }[]
}

/** A host over headless fields. `pool` is the clock's list; `lapCourse` the lap's. */
const rig = async (
  pool: readonly string[],
  opts: { now?: number; lap?: ExhibitionLap | string } = {},
): Promise<Rig> => {
  const levels = new Map<string, Level>()
  for (const id of pool) levels.set(id, await loadLevel(id))
  if (opts.lap && typeof opts.lap !== 'string' && !levels.has(opts.lap.mission)) {
    levels.set(opts.lap.mission, await loadLevel(opts.lap.mission))
  }
  let current: (ExhibitionField & { racers: AiRacer[] }) | null = null
  let on: string | null = null
  const r: Rig = {
    boarded: [],
    log: [],
    ghosts: [],
    field: () => current,
    host: {
      courses: async () => pool,
      board: async (course) => {
        r.boarded.push(course)
        current = headlessField(levels.get(course) as Level)
        on = course
      },
      aboard: (course) => on === course,
      field: () => current,
      fetchLap: async () => opts.lap ?? 'no lap',
      ghost: async (lap) => {
        const route = createRoute((levels.get(lap.mission) as Level).route as number[][])
        const entry = { lap, disposed: false, clock: -1 }
        r.ghosts.push(entry)
        const g: ExhibitionGhost = {
          update: (clock) => {
            entry.clock = clock
          },
          pose: (p, q) => {
            if (entry.clock < 0 || entry.disposed) return false
            const at = routeAt(
              route,
              Math.min(entry.clock * 150, route.cumulative[route.count - 1] as number),
              v3(),
            )
            p.x = at.x
            p.y = at.y
            p.z = -at.z
            q.x = 0
            q.y = 0
            q.z = 0
            q.w = 1
            return true
          },
          dispose: () => {
            entry.disposed = true
          },
        }
        return g
      },
      now: () => opts.now ?? Date.UTC(2026, 9, 6, 12),
      log: (line) => r.log.push(line),
    },
  }
  return r
}

/** Let the exhibition's promises settle (the host's are immediate). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** Run frames and fixed steps until `until` holds, or `maxSeconds` of sim pass. */
const run = async (
  ex: ExhibitionDriver,
  until: () => boolean,
  maxSeconds: number,
  each?: () => void,
): Promise<number> => {
  let t = 0
  while (!until() && t < maxSeconds) {
    ex.frame(FIXED_DT)
    await settle()
    ex.tick(FIXED_DT)
    each?.()
    t += FIXED_DT
  }
  return t
}

const POOL = ['int_01_hoverJet', 'rookie_02_hoverJet', 'adv_02_hoverJet']

/** Every exhibition a test starts, stopped after it whatever happened, so no hold leaks. */
const live: ExhibitionDriver[] = []
const start = (host: ExhibitionHost, options?: ExhibitionOptions): ExhibitionDriver => {
  const ex = createExhibition(host, options)
  live.push(ex)
  return ex
}
afterEach(() => {
  for (const ex of live.splice(0)) ex.stop()
})

describe('the racers race with no player in the field', () => {
  it('reach GO on their own countdown, finish, and the next course boards', async () => {
    const r = await rig(POOL)
    const ex = start(r.host, { course: 'int_01_hoverJet' })
    await settle()
    expect(ex.phase).toBe('boarding')
    expect(r.boarded).toEqual(['int_01_hoverJet'])
    // The countdown holds every racer on its pad.
    await run(ex, () => ex.phase === 'racing', 10)
    const field = r.field()
    expect(field?.racers).toHaveLength(5)
    let finished: ExhibitionResult | null = null
    ex.onFinish((res) => {
      finished = res
    })
    const raced = await run(ex, () => finished !== null, 400)
    expect(finished, 'the race finished').not.toBeNull()
    const result = finished as unknown as ExhibitionResult
    expect(result.course).toBe('int_01_hoverJet')
    expect(result.standings).toHaveLength(5)
    // Every racer crossed: nobody needed a player to race against.
    for (const s of result.standings) expect(s.status, s.name).toBe('finished')
    // In place order, by time.
    const times = result.standings.map((s) => s.seconds as number)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    expect(raced).toBeGreaterThan(0)
    expect(ex.races).toBe(1)
    // The results stand, then the next course boards — never the one just flown.
    expect(ex.phase).toBe('results')
    await run(ex, () => ex.phase === 'boarding', EXHIBITION_RESULTS_SECONDS + 1)
    await settle()
    expect(r.boarded).toHaveLength(2)
    expect(r.boarded[1]).not.toBe('int_01_hoverJet')
    expect(POOL).toContain(r.boarded[1])
    ex.stop()
    expect(ex.phase).toBe('stopped')
  }, 120_000)

  it('without a course, boards the clock’s', async () => {
    const r = await rig(POOL, { now: Date.UTC(2026, 9, 6, 12) })
    const ex = start(r.host)
    await settle()
    expect(POOL).toContain(r.boarded[0])
    ex.stop()
  })
})

describe('every course in the pool races to its finish, and outlasts a slot', () => {
  it('has all five home under the course clock on every course, each programme longer than a slot', async () => {
    // The release pool, as `boot/app.ts` builds it (`tv-schedule.test.ts` holds
    // it to the disk). `TV_SLOT_SECONDS`'s header leans on the second half: a
    // slot shorter than any programme is what keeps every viewer on the clock.
    const pool = quickRacePool(await loadMissionIndex()).map((c) => c.id)
    expect(pool.length).toBeGreaterThanOrEqual(3)
    const lines: string[] = []
    for (const course of pool) {
      const r = await rig(pool)
      const ex = start(r.host, { course })
      let res: ExhibitionResult | null = null
      ex.onFinish((x) => {
        res = x
      })
      await run(ex, () => ex.phase === 'racing', 10)
      await run(ex, () => res !== null, 400)
      const result = res as unknown as ExhibitionResult
      expect(result, course).not.toBeNull()
      const limit = (r.field() as ExhibitionField).timeLimit
      for (const s of result.standings) {
        expect(s.status, `${course} ${s.name}`).toBe('finished')
        expect(s.seconds as number, `${course} ${s.name}`).toBeLessThan(limit)
      }
      const programme =
        EXHIBITION_COUNTDOWN_SECONDS + result.raceSeconds + EXHIBITION_RESULTS_SECONDS
      expect(programme, `${course}: a programme outlasts a slot`).toBeGreaterThan(TV_SLOT_SECONDS)
      lines.push(`${course} ${result.raceSeconds.toFixed(1)} s`)
      ex.stop()
    }
    expect(lines).toHaveLength(pool.length)
  }, 120_000)
})

describe('craft(): the list the camera reads', () => {
  it('names five racers, places them 1..5, and points each heading along its flight', async () => {
    const r = await rig(POOL)
    const ex = start(r.host, { course: 'int_01_hoverJet' })
    await run(ex, () => ex.phase === 'racing', 10)
    await run(ex, () => ex.raceSeconds > 20, 30)
    const craft = ex.craft()
    expect(craft.map((c) => c.place)).toEqual([1, 2, 3, 4, 5])
    expect(craft.every((c) => c.kind === 'racer')).toBe(true)
    expect(new Set(craft.map((c) => c.name)).size).toBe(5)
    const field = r.field() as ExhibitionField & { racers: AiRacer[] }
    for (const c of craft) {
      const racer = field.racers.find((x) => x.spec.id === c.name) as AiRacer
      // The drawn position is the racer's, in THREE space.
      expect(c.position.z).toBeCloseTo(-racer.jet.body.position.z, 6)
      // The heading is the way it is going: compared with the SIM velocity,
      // flipped, which is outside the quaternion maths it was derived by.
      const v = racer.jet.body.velocity
      const travel = Math.atan2(-v.x, v.z) // three: (-sin h, -cos h) is (v.x, -v.z)
      const off = Math.atan2(Math.sin(c.heading - travel), Math.cos(c.heading - travel))
      expect(Math.abs(off), `${c.name} heading vs travel`).toBeLessThan(0.6)
    }
    ex.stop()
  }, 60_000)
})

describe('a board lap flies one ghost beside the five (/tv/lap/<id>)', () => {
  it('boards the lap’s course, waits for the ghost to finish, then the clock’s course', async () => {
    const rookie = await loadLevel('rookie_02_hoverJet')
    const lap = lapAlong(rookie, 'LaPiD12345')
    const r = await rig(POOL, { lap })
    const ex = start(r.host, { lapId: lap.id })
    await settle()
    expect(r.boarded).toEqual(['rookie_02_hoverJet'])
    await run(ex, () => ex.phase === 'racing', 10)
    expect(r.ghosts).toHaveLength(1)
    await run(ex, () => ex.raceSeconds > 5, 10)
    const craft = ex.craft()
    expect(craft).toHaveLength(6)
    expect(craft.filter((c) => c.kind === 'ghost').map((c) => c.name)).toEqual([TV_LAP_NAME])
    let result: ExhibitionResult | null = null
    ex.onFinish((res) => {
      result = res
    })
    await run(ex, () => result !== null, 400)
    const res = result as unknown as ExhibitionResult
    expect(res.lapId).toBe(lap.id)
    expect(res.raceSeconds).toBeGreaterThanOrEqual(lap.seconds as number)
    const ghostRow = res.standings.find((s) => s.kind === 'ghost')
    expect(ghostRow?.seconds).toBe(lap.seconds)
    // Once flown, the lap is done with: the next race is the clock's, with no ghost.
    await run(ex, () => ex.phase === 'boarding', EXHIBITION_RESULTS_SECONDS + 1)
    await settle()
    expect(r.ghosts[0]?.disposed).toBe(true)
    expect(r.boarded[1]).not.toBe('rookie_02_hoverJet')
    await run(ex, () => ex.phase === 'racing', 10)
    expect(ex.craft().every((c) => c.kind === 'racer')).toBe(true)
    ex.stop()
  }, 120_000)

  // DEV-612. The racers are drawn `alpha` of the way between their last two
  // steps (D4), so a frame shows the race `1 - alpha` of a step behind its
  // clock. A ghost drawn AT the clock stepped at 82 Hz beside them, and TV's
  // camera, following it, showed the step. Driven here as `boot/app.ts` drives
  // it: a 180 Hz display, `stepFixed`'s accumulator, then `frame(dt, alpha)`.
  it('is drawn where the racers are drawn: its clock advances by each frame, not each step', async () => {
    const rookie = await loadLevel('rookie_02_hoverJet')
    const lap = lapAlong(rookie, 'LaPiD12345')
    const r = await rig(POOL, { lap })
    const ex = start(r.host, { lapId: lap.id })
    await settle()
    await run(ex, () => ex.phase === 'racing', 10)
    await run(ex, () => ex.raceSeconds > 2, 10)
    const ghost = r.ghosts[0] as Rig['ghosts'][number]
    const frameDt = 1 / 180
    /** The ghost's clock over 180 frames at `frameDt`, `alpha` as given (or the accumulator's). */
    const drive = (fixedAlpha: number | null): number[] => {
      let acc = 0
      const clocks: number[] = []
      for (let i = 0; i < 180; i++) {
        acc += frameDt
        while (acc >= FIXED_DT) {
          ex.tick(FIXED_DT)
          acc -= FIXED_DT
        }
        ex.frame(frameDt, fixedAlpha ?? acc / FIXED_DT)
        clocks.push(ghost.clock)
      }
      return clocks
    }
    const advances = (c: readonly number[]): number[] =>
      c.slice(1).map((v, i) => v - (c[i] as number))
    // The base's draw (alpha 1: at the clock) saws between no advance and two
    // steps' worth: the premise that this sample can see the bug at all.
    const atClock = advances(drive(1))
    expect(Math.max(...atClock) - Math.min(...atClock)).toBeGreaterThan(FIXED_DT * 0.9)
    // Drawn behind it by `1 - alpha` of a step: every frame advances by the frame.
    const drawn = advances(drive(null))
    expect(ex.phase).toBe('racing')
    for (const a of drawn) expect(Math.abs(a - frameDt)).toBeLessThan(1e-9)
    expect(ghost.clock).toBeLessThanOrEqual(ex.raceSeconds)
    expect(ex.raceSeconds - ghost.clock).toBeLessThan(FIXED_DT + 1e-9)
    ex.stop()
  }, 120_000)

  it('falls back to the clock’s course when the lap will not fetch', async () => {
    const r = await rig(POOL, { lap: 'gone' })
    const ex = start(r.host, { lapId: 'NoSuchLap1' })
    await settle()
    expect(POOL).toContain(r.boarded[0])
    expect(r.log.some((l) => l.includes('will not fly'))).toBe(true)
    ex.stop()
  })
})

// ── 4. nothing is written down ─────────────────────────────────────────────

/** A store that counts what is written to it. */
const spiedStore = () => {
  const data = new Map<string, string>()
  const writes: string[] = []
  return {
    writes,
    store: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        writes.push(k)
        data.set(k, v)
      },
    },
  }
}

/** A fetch that counts what is sent, and answers like the lap server would. */
const spiedFetch = () => {
  const sent: string[] = []
  const fetchFn = async (url: string): Promise<Response> => {
    sent.push(url)
    return new Response(JSON.stringify({ id: 'AbCdEfGhIj', verdict: { verdict: 'ok' } }), {
      status: url.includes('/room/') ? 200 : 201,
    })
  }
  return { sent, fetchFn }
}

/** Every record door the game has, knocked on as the finish block knocks (`boot/app.ts`). */
const knockOnEveryDoor = async (
  doc: LapDoc,
  store: ReturnType<typeof spiedStore>['store'],
  fetchFn: ReturnType<typeof spiedFetch>['fetchFn'],
) => {
  const best = recordRun(
    'int_01_hoverJet',
    'ringAttack',
    { score: 2100, timeSeconds: 88, gates: 21 },
    store,
  )
  const kept = keepLap(
    { doc, seconds: 88, gates: 21, tainted: false, reasons: [] },
    'standard',
    store,
  )
  const posted = await submitLap(
    { doc, seconds: 88, handle: 'NOBODY', owner: 'x'.repeat(32) },
    fetchFn,
  )
  const judged = await submitRoomLap(
    { room: 'K7QX4M2', doc, seconds: 88, seat: 's', tainted: false },
    fetchFn,
  )
  return { best, kept, posted, judged }
}

describe('an exhibition run to its finish writes nothing (§4.0)', () => {
  it('holds every record door shut from start to stop, and opens them again after', async () => {
    const int01 = await loadLevel('int_01_hoverJet')
    const doc = lapAlong(int01, 'unused').doc
    const r = await rig(POOL)
    expect(recordingHeld(), 'nothing holds the doors before TV').toBe(false)
    const during = spiedStore()
    const net = spiedFetch()
    let knocking: ReturnType<typeof knockOnEveryDoor> | null = null
    const ex = start(r.host, { course: 'int_01_hoverJet' })
    // At the finish: where a race records, every door the game writes through.
    ex.onFinish(() => {
      knocking = knockOnEveryDoor(doc, during.store, net.fetchFn)
    })
    await run(ex, () => knocking !== null, 400)
    expect(knocking, 'the race reached its finish').not.toBeNull()
    expect(ex.phase, 'still on: the results card').toBe('results')
    // Awaited here, not polled through the loop: a post that DID go out packs
    // the lap through a CompressionStream, which settles on a macrotask.
    const k = await (knocking as unknown as ReturnType<typeof knockOnEveryDoor>)
    expect(during.writes, 'no best, medal, completion or kept lap').toEqual([])
    expect(net.sent, 'no lap posted, to a board or a room').toEqual([])
    expect(k.best.improved).toBe(false)
    expect(k.kept.stored).toBe(false)
    expect(k.posted.ok).toBe(false)
    expect(k.judged.ok).toBe(false)
    // …and through the results card and into the next board, still nothing.
    await run(ex, () => ex.phase === 'boarding', EXHIBITION_RESULTS_SECONDS + 1)
    expect(recordingHeld()).toBe(true)

    // Stopped, the doors are the player's again: the hold does not leak.
    ex.stop()
    expect(recordingHeld()).toBe(false)
    const after = spiedStore()
    const net2 = spiedFetch()
    const open = await knockOnEveryDoor(doc, after.store, net2.fetchFn)
    expect(open.best.improved).toBe(true)
    expect(open.kept.stored).toBe(true)
    expect(after.writes.length, 'a best and a kept lap').toBe(2)
    expect(net2.sent.length, 'a board post and a room post').toBe(2)
  }, 120_000)

  it('a stop called twice releases once, and two holders do not release each other', async () => {
    const r = await rig(POOL)
    const a = start(r.host, { course: 'int_01_hoverJet' })
    const b = start(r.host, { course: 'rookie_02_hoverJet' })
    a.stop()
    a.stop()
    expect(recordingHeld(), 'b still holds').toBe(true)
    b.stop()
    expect(recordingHeld()).toBe(false)
  })
})

describe('the cut to a live race lands at the finish, never mid-race (§4.0)', () => {
  it('waits out the race, then stops and goes', async () => {
    const r = await rig(POOL)
    const ex = start(r.host, { course: 'int_01_hoverJet' })
    await run(ex, () => ex.raceSeconds > 10, 20)
    let wentAt: number | null = null
    const raceAtCut = ex.raceSeconds
    ex.cutIn(() => {
      wentAt = ex.raceSeconds
    })
    expect(wentAt, 'not mid-race').toBeNull()
    expect(ex.phase).toBe('racing')
    await run(ex, () => wentAt !== null, 400)
    expect(ex.phase).toBe('stopped')
    expect(ex.races).toBe(1)
    expect(wentAt as unknown as number).toBeGreaterThan(raceAtCut)
    // Every racer had crossed when it cut.
    for (const racer of (r.field() as { racers: AiRacer[] }).racers)
      expect(racer.finished).toBe(true)
  }, 120_000)

  it('between races, cuts at once', async () => {
    const r = await rig(POOL)
    const ex = start(r.host, { course: 'int_01_hoverJet' })
    await settle()
    let went = false
    ex.cutIn(() => {
      went = true
    })
    expect(went).toBe(true)
    expect(ex.phase).toBe('stopped')
  })
})
