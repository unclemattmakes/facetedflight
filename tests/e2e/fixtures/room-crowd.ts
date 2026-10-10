// tests/e2e/fixtures/room-crowd.ts — autopilot players in node, over real sockets. DEV-388.
//
// plan/MULTIPLAYER.md §8 DEV-388's perf gate: "a harness room of five autopilot
// clients in node feeding one browser". Each is a real `RoomSession` on a real
// WebSocket to the room sidecar, flying a real `stepHoverJet` on the autopilot
// through `stepMission` and the speed chain, at WALL-CLOCK rate from the
// room's GO, so the browser receives exactly the stream five players would
// send. The first to join owns the room and configures it the way the game's
// owner does (`boot/app.ts`'s `roomSettingsFor`); it starts the race once
// everybody — the browser included — is ready. Each stands on the start the
// room hands its seat (DEV-477), off the judge's own list, before `loaded`, as
// the game does.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Level } from '../../../src/content/level-schema'
import { startMission, stepMission } from '../../../src/game/mission'
import { contentDigest, fillOwnPose } from '../../../src/game/room-client'
import type { LapCourses } from '../../../src/net/lap-courses'
import { poseRecord } from '../../../src/net/pose-codec'
import { FIXED_DT_MS, sharedTickAt } from '../../../src/net/room-clock'
import type { RoomSettings } from '../../../src/net/room-protocol'
import { RoomSession } from '../../../src/net/room-session'
import { threeQuatTupleToUnity, threeTupleToUnity } from '../../../src/render/unity-space'
import { AI_RACER_TUNINGS } from '../../../src/sim/ai-racer'
import {
  type AutopilotTuning,
  autopilotActions,
  DEFAULT_AUTOPILOT,
  nextGate,
} from '../../../src/sim/autopilot'
import { FIXED_DT } from '../../../src/sim/constants'
import { createHoverJet, noInput, stepHoverJet } from '../../../src/sim/hoverjet'
import { chainGate } from '../../../src/sim/speed-chain'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// Handles off the game's own lists (`net/handles.ts`): a browser draws anything
// else as "Racer N" (DEV-485, `game/room-names.ts`), and these are honest players.
const HANDLES = [
  'Swift Kestrel 42',
  'Steady Heron 17',
  'Bright Falcon 33',
  'Calm Finch 19',
  'Bold Wren 55',
]
const TUNINGS: AutopilotTuning[] = [
  DEFAULT_AUTOPILOT,
  AI_RACER_TUNINGS.fast as AutopilotTuning,
  AI_RACER_TUNINGS.steady as AutopilotTuning,
  AI_RACER_TUNINGS.cutter as AutopilotTuning,
  AI_RACER_TUNINGS.wide as AutopilotTuning,
]

export interface CrowdOptions {
  readonly url: string
  readonly level: Level
  readonly count: number
  /** How many players (the crowd and the browsers) to wait for before the owner starts. */
  readonly players: number
  /**
   * DEV-480: tell the room each racer's finish, as the game does, so the race
   * reaches its results when they are all home rather than at the time limit.
   * Absent: they never say (DEV-388's crowd, which the perf specs were built on).
   */
  readonly finish?: boolean
}

export interface Crowd {
  /** Every client has joined and is ready. */
  readonly ready: Promise<void>
  readonly goAt: () => number | null
  /** Ticks flown, per client. */
  ticks(): number[]
  stop(): void
}

/** A level's JSON, off disk (Playwright's ESM loader will not import JSON without an attribute). */
export const loadLevel = (id: string): Level =>
  JSON.parse(fs.readFileSync(path.join(ROOT, `content/levels/${id}.json`), 'utf8')) as Level

/**
 * The lap courses, off disk: Playwright's ESM loader wants an import attribute
 * on JSON that `lap-courses.ts` (built for Vite) does not carry. Same bytes.
 */
const lapCourses = (): LapCourses =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'content/lap-courses.json'), 'utf8')) as LapCourses

/** DEV-477: `level`'s room starts, SIM space: the judge's list, the one the game places from. */
export const roomStartsOf = (level: Level): ReadonlyArray<readonly [number, number, number]> =>
  lapCourses().courses[level.id]?.editions.anniversary?.rooms?.starts ?? []

/** The owner's settings for `level`, as the game's owner computes them (`boot/app.ts`'s `roomSettingsFor`). */
export const roomSettingsFor = (level: Level): RoomSettings => {
  const courses = lapCourses()
  const variants = courses.courses[level.id]?.editions.anniversary?.variants ?? {}
  const rules: Record<string, string> = {}
  for (const [v, r] of Object.entries(variants)) rules[v] = r.rules
  return {
    mission: level.id,
    edition: 'anniversary',
    bots: false,
    // The course's starts, one ship each (DEV-477).
    seats: roomStartsOf(level).length,
    colours: 6,
    countdown: (level.timer.countdown?.seconds ?? 0) * 1000,
    timeLimit: Math.round(level.timer.timeLimit * 1000),
    rules,
  }
}

export const startCrowd = async (opts: CrowdOptions): Promise<Crowd> => {
  const { level } = opts
  const content = contentDigest(
    fs.readFileSync(path.join(ROOT, 'content/_generated.sha256'), 'utf8'),
  )
  const settings = roomSettingsFor(level)
  const starts = roomStartsOf(level)
  const worldOffset = level.worldOffset as [number, number, number]
  const timers: ReturnType<typeof setInterval>[] = []
  const sockets: WebSocket[] = []
  const clients = Array.from({ length: opts.count }, (_, i) => {
    const jet = createHoverJet()
    jet.launched = true
    threeTupleToUnity(jet.body.position, level.spawn.pos as number[])
    threeQuatTupleToUnity(jet.body.orientation, level.spawn.quat as number[])
    jet.body.position.y += level.spawn.launch?.rise ?? 0
    return {
      i,
      jet,
      mission: startMission(level),
      input: noInput(),
      record: [poseRecord()],
      tuning: TUNINGS[i % TUNINGS.length] as AutopilotTuning,
      tick: -1,
      session: null as RoomSession | null,
      readied: false,
      loadedSent: false,
      finishSent: false,
    }
  })

  const owner = clients[0] as (typeof clients)[number]
  /** When the owner last asked to START: once, then again only if the room did not move. */
  let startAskedAt = Number.NEGATIVE_INFINITY
  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((r) => {
    resolveReady = r
  })

  const connect = (c: (typeof clients)[number]) =>
    new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(opts.url)
      ws.binaryType = 'arraybuffer'
      sockets.push(ws)
      const session = new RoomSession(
        {
          send: (d) => {
            // The codec hands a view of its reused buffer; a socket copies on send.
            if (ws.readyState === WebSocket.OPEN)
              ws.send(d as string | ArrayBufferView<ArrayBuffer>)
          },
        },
        {
          handle: HANDLES[c.i % HANDLES.length] as string,
          variant: 'standard',
          colour: c.i,
          content,
        },
      )
      c.session = session
      ws.onopen = () => {
        session.join()
        resolve()
      }
      ws.onerror = () => reject(new Error(`crowd ${c.i}: the socket failed`))
      ws.onmessage = (e) => session.receive(e.data as string | ArrayBuffer, performance.now())
    })

  // One at a time, so the first is the owner.
  for (const c of clients) {
    await connect(c)
    await new Promise((r) => setTimeout(r, 150))
  }

  const step = (c: (typeof clients)[number]) => {
    const gates = c.mission.course.gates
    const target = nextGate(gates, c.mission.course.passed)
    const finishGate = c.mission.finishGate as NonNullable<typeof c.mission.finishGate>
    const aim = target >= 0 ? (gates[target] as (typeof gates)[number]).centre : finishGate
    const after = target >= 0 ? (gates[target + 1]?.centre ?? finishGate) : null
    autopilotActions(c.jet.body, aim, c.input, c.tuning, [], Number.POSITIVE_INFINITY, after)
    stepHoverJet(c.jet, c.input)
    const ring = stepMission(c.mission, level, c.jet.body.position, FIXED_DT)
    if (ring >= 0) chainGate(c.jet.chain)
  }

  timers.push(
    setInterval(() => {
      const local = performance.now()
      let everyoneReady = true
      for (const c of clients) {
        const s = c.session as RoomSession
        s.update(local)
        if (c === owner && s.slot === s.owner && s.settings === null) s.configure(settings)
        if (!c.readied && s.settings !== null) {
          s.ready(true, settings.rules.standard)
          c.readied = true
        }
        if (!c.readied) everyoneReady = false
        if (s.race !== null && !c.loadedSent) {
          // DEV-477: onto the start the room handed this seat, then `loaded`.
          const at = s.slot === null ? undefined : starts[s.race.starts[s.slot] ?? -1]
          if (at) {
            c.jet.body.position.x = at[0]
            c.jet.body.position.y = at[1]
            c.jet.body.position.z = at[2]
          }
          s.loaded()
          c.loadedSent = true
        }
        if (s.goAt === null) continue
        const due = Math.floor(sharedTickAt(s.roomNow(local), s.goAt))
        while (c.tick < due && !c.mission.finishCrossed) {
          if (c.tick >= 0) step(c)
          c.tick++
          fillOwnPose(c.record[0] as (typeof c.record)[number], c.jet.body, worldOffset, {
            pitch: c.input.pitch,
            roll: c.input.roll,
            yaw: c.input.yaw,
            throttle: c.input.throttle,
            flags: c.input.boost ? 1 : 0,
          })
          s.step(c.tick, c.record, 1)
        }
        if (opts.finish === true && c.mission.finishCrossed && !c.finishSent) {
          c.finishSent = true
          s.finish(c.tick)
        }
      }
      if (everyoneReady) resolveReady()
      const o = owner.session as RoomSession
      const players = Object.values(o.players)
      if (
        o.slot === o.owner &&
        o.race === null &&
        players.length >= opts.players &&
        players.every((p) => p.ready) &&
        local - startAskedAt > 2000
      ) {
        startAskedAt = local
        o.start()
      }
    }, FIXED_DT_MS / 3),
  )

  return {
    ready,
    goAt: () => owner.session?.goAt ?? null,
    ticks: () => clients.map((c) => c.tick),
    stop() {
      for (const t of timers) clearInterval(t)
      for (const ws of sockets) ws.close(1000, 'done')
    },
  }
}
