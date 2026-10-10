// tests/unit/helpers/room-harness.ts — a whole multiplayer race, in node. DEV-387.
//
// plan/MULTIPLAYER.md §9.1, the tier king-tide never had. N clients, each a
// real `stepHoverJet` flown by the autopilot through `stepMission` and the
// speed chain (the way `autopilot-lap.ts` flies a lap), each behind its own
// seeded link, through ONE real `RoomServer` in memory. Every client is a real
// `RoomSession` — the code the game ships (DEV-388 wraps the same class around
// a socket) — so the harness exercises the client, not a copy of it.
//
// ── The link is TCP, because the transport is a WebSocket ─────────────────
//
// Messages arrive in order, always. "Loss" is a retransmit: the lost message
// waits `rtoMs` and everything behind it waits too (head-of-line blocking),
// which is exactly the freeze-then-burst king-tide's evaluation #4 describes.
// A stall holds a link's deliveries until it ends. Jitter is uniform ± around
// the base, then ordered. Clocks: each client's local time is the true time
// plus an offset and a drift; the room's clock IS the true time.
//
// ── What is measured ──────────────────────────────────────────────────────
//
// Every `frameMs`, for every observer and every other racer: the drawn pose
// against the sender's TRUE pose at the same shared tick (the render tick the
// observer asked for), the same drawn pose against the sender's LIVE pose
// (the lag §5.1 estimates), and king-tide's arrival-time interpolator fed the
// same stream (`arrival-track.ts`), scored at its own best constant lag.
//
// ── Judged (DEV-390) ──────────────────────────────────────────────────────
//
// With `judge`, each client records its lap as the game does (the pose after
// each step, gate and finish events) and, `judgeMs` after its finish, the REAL
// judge (`judgeRoomLap`) rescores it and hands the room its verdict over the
// binding's internal API: the lap POST's own path, which can overtake or trail
// the `finish` message on the socket.
//
// ── Where each client starts (DEV-477) ────────────────────────────────────
//
// Where the game puts it: when the room's race arrives, each client stands its
// jet on the start the room handed its seat — `race.starts[slot]` into the
// course's start list, `game/racer-grid.ts`'s `roomStarts` (the pad, then the
// racers' own) — height included, as `boot/app.ts` does before it sends
// `loaded`. The judge accepts a seat's lap from that start and no other, so a
// judged race here is also the check that every seat was placed where the room
// said.
//
// Deterministic: time is simulated in whole milliseconds, every draw is
// seeded, and nothing reads a wall clock.

import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { startMission, stepMission } from '@/game/mission'
import { roomStarts } from '@/game/racer-grid'
import { lapToWire } from '@/net/lap-client'
import { lapCourse, lapRules, lapVehicle } from '@/net/lap-courses'
import {
  decodePose,
  type PoseFrame,
  type PoseRecord,
  poseFrame,
  poseRecord,
} from '@/net/pose-codec'
import { drawnPose } from '@/net/remote-track'
import { judgeRoomLap } from '@/net/room-lap'
import { answerRoomLink, type RoomJudgeLink, roomLinkOverFetch } from '@/net/room-link'
import { POSE_KIND, type RoomSettings, type RoomVerdict } from '@/net/room-protocol'
import type { RoomConnection, RoomHost } from '@/net/room-server'
import { RoomServer } from '@/net/room-server'
import { RoomSession, type RoomSessionOptions } from '@/net/room-session'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { type AutopilotTuning, autopilotActions, nextGate } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import {
  createLapRecorder,
  type LapRecorder,
  markLapEvent,
  recordedLap,
  recordPose,
} from '@/sim/ghost-record'
import { createHoverJet, type HoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import { chainGate } from '@/sim/speed-chain'
import anniversaryJson from '../../../content/editions/anniversary.json'
import { ArrivalTrack } from './arrival-track'
import { type Rng, seeded } from './seeded'

const DT_MS = FIXED_DT * 1000

export interface LinkSpec {
  /** One-way base latency, ms. */
  readonly baseMs: number
  /** Uniform ± around the base, ms. */
  readonly jitterMs: number
  /** Chance a message needs a retransmit. */
  readonly loss: number
  /** What a retransmit costs, ms. */
  readonly rtoMs: number
  /** True-time windows in which this link delivers nothing. */
  readonly stalls?: ReadonlyArray<{ readonly at: number; readonly ms: number }>
}

export interface ClientSpec {
  readonly handle: string
  readonly tuning: AutopilotTuning
  /** local = true + offset (+ drift). */
  readonly clockOffsetMs: number
  readonly driftPpm?: number
  /** From `loading` to `loaded`, ms. */
  readonly loadMs: number
  readonly up: LinkSpec
  readonly down: LinkSpec
  /**
   * DEV-390, with `RaceSpec.judge`: from crossing the finish to the judge's
   * verdict reaching the room, ms. The lap POST's own path (HTTP to the Pages
   * Function, then the binding), NOT this socket, so it can overtake or trail
   * the `finish` message.
   */
  readonly judgeMs?: number
}

export interface RaceSpec {
  readonly level: Level
  readonly clients: readonly ClientSpec[]
  readonly seed: number
  /** How often the observers draw, ms. */
  readonly frameMs?: number
  /** Stop after this much racing, s (default: when every client has finished). */
  readonly raceSeconds?: number
  readonly session?: RoomSessionOptions
  /**
   * DEV-390: record each lap and have the REAL judge (`judgeRoomLap`, over the
   * binding's internal API) hand the room its verdict, `judgeMs` after the finish.
   */
  readonly judge?: boolean
}

/** One direction of a TCP connection. */
class Pipe {
  readonly #q: Array<{ at: number; data: string | Uint8Array }> = []
  #last = 0
  constructor(
    readonly spec: LinkSpec,
    readonly rng: Rng,
  ) {}
  send(now: number, data: string | Uint8Array): void {
    // A socket copies on send: the sender's buffer is its own again at once.
    const copy = typeof data === 'string' ? data : new Uint8Array(data)
    const s = this.spec
    let at = now + s.baseMs + (this.rng() * 2 - 1) * s.jitterMs
    if (this.rng() < s.loss) at += s.rtoMs
    at = Math.max(at, this.#last)
    for (const st of s.stalls ?? []) if (at >= st.at && at < st.at + st.ms) at = st.at + st.ms
    this.#last = at
    this.#q.push({ at, data: copy })
  }
  /** Everything due by `now`, in order. */
  due(now: number): Array<string | Uint8Array> {
    let n = 0
    while (n < this.#q.length && (this.#q[n] as { at: number }).at <= now) n++
    return this.#q.splice(0, n).map((m) => m.data)
  }
}

/** A drawn copy scored against the truth. */
export interface Scored {
  /** |drawn − truth at the same shared tick|, m. */
  readonly error: number
  /** |drawn − the sender's live pose|, m: §5.1's figure. */
  readonly lag: number
  readonly mode: string
  readonly observer: number
  readonly sender: number
  readonly trueMs: number
}

interface Client {
  readonly spec: ClientSpec
  readonly session: RoomSession
  readonly conn: RoomConnection & { state: unknown }
  readonly up: Pipe
  readonly down: Pipe
  readonly jet: HoverJet
  readonly mission: ReturnType<typeof startMission>
  readonly input: ReturnType<typeof noInput>
  readonly record: PoseRecord[]
  readonly truth: Float64Array
  readonly arrival: Map<number, ArrivalTrack>
  readonly kt: Array<{ sender: number; trueMs: number; x: number; y: number; z: number }>
  readyDone: boolean
  /** DEV-477: the start the room handed this client's seat, once the race is known. */
  start: number | null
  loadedAt: number | null
  releaseAt: number | null
  tick: number
  finishTick: number | null
  /** DEV-390: the lap as recorded, when the race is judged. */
  readonly rec: LapRecorder | null
  /** True ms the lap's verdict is due at the room, once it has finished. */
  postAt: number | null
}

export interface RaceResult {
  readonly scored: Scored[]
  /** Per client: release (true ms), finish tick, and the truth track (x,y,z per tick). */
  readonly clients: ReadonlyArray<{
    readonly releaseAt: number
    readonly finishTick: number | null
    readonly truth: Float64Array
    readonly clockError: number
    readonly rings: number
    /** DEV-477: the start the room handed this client (an index into `starts`). */
    readonly start: number | null
  }>
  /** DEV-477: the course's start list the clients were placed from, SIM space. */
  readonly starts: ReadonlyArray<readonly [number, number, number]>
  /** king-tide's interpolator at its best constant lag: p95 and max error, m, and the lag. */
  readonly arrival: { readonly lagMs: number; readonly p95: number; readonly max: number }
  readonly goAt: number
  readonly messagesToRoom: number
  /** Each client's slot in the room, in client order. */
  readonly slots: readonly number[]
  /** DEV-390: the room's verdicts, in the order they were JUDGED (arrived). */
  readonly results: readonly RoomVerdict[]
  /** DEV-390: the slots in the order their `finish` messages reached the room. */
  readonly finishArrivals: readonly number[]
}

/** Truth at fractional tick `r`: the sim's own poses, lerped between fixed steps. */
const truthAt = (truth: Float64Array, r: number, last: number): [number, number, number] => {
  const k = Math.max(0, Math.min(last, Math.floor(r)))
  const k1 = Math.min(last, k + 1)
  const s = Math.max(0, Math.min(1, r - k))
  const o = k * 3
  const o1 = k1 * 3
  return [
    (truth[o] as number) + ((truth[o1] as number) - (truth[o] as number)) * s,
    (truth[o + 1] as number) + ((truth[o1 + 1] as number) - (truth[o + 1] as number)) * s,
    (truth[o + 2] as number) + ((truth[o1 + 2] as number) - (truth[o + 2] as number)) * s,
  ]
}

const percentile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number
}

export const runRace = async (spec: RaceSpec): Promise<RaceResult> => {
  const level = spec.level
  const frameMs = spec.frameMs ?? 11
  const rng = seeded(spec.seed)
  let now = 0
  let toRoom = 0

  // ── The room ──
  const stored = new Map<string, unknown>()
  const conns: Array<RoomConnection & { state: unknown }> = []
  const host: RoomHost = {
    now: () => now,
    connections: () => conns,
    storage: {
      get: async <T>(k: string) => structuredClone(stored.get(k)) as T | undefined,
      put: async <T>(k: string, v: T) => {
        stored.set(k, structuredClone(v))
      },
      delete: async (k: string) => stored.delete(k),
    },
    setAlarm: async () => {},
    random: (b) => {
      for (let i = 0; i < b.length; i++) b[i] = Math.floor(rng() * 256)
    },
  }
  const room = await RoomServer.load(host)
  // DEV-390: the judge's line to the room, as the Pages Function holds it.
  const judgeLink = roomLinkOverFetch((req) => answerRoomLink(room, req))
  const worldOffset = lapCourse(level.id)?.worldOffset ?? ([0, 0, 0] as const)
  const finishArrivals: number[] = []

  // 3-2-1-GO is FOUR beats: the level's own `timer.countdown.seconds`, (steps + 1) x stepSeconds.
  const countdownMs = (level.timer.countdown?.seconds ?? 0) * 1000
  const rules = lapRules(level.id, 'anniversary', 'standard') as string
  // DEV-477: the course's starts, as the game reads them, SIM space. The room's
  // seat cap is their count, as `boot/app.ts`'s owner configures it.
  const starts = roomStarts(level, (anniversaryJson as unknown as Edition).gameplay.racers).map(
    (s) => [s.pos[0], s.pos[1], -s.pos[2]] as const,
  )
  const settings: RoomSettings = {
    mission: level.id,
    edition: 'anniversary',
    bots: false,
    seats: starts.length,
    colours: 6,
    countdown: countdownMs,
    timeLimit: Math.round(level.timer.timeLimit * 1000),
    rules: { standard: rules },
  }
  const maxTicks = Math.ceil(level.timer.timeLimit / FIXED_DT) + 1

  // ── The clients ──
  const clients: Client[] = spec.clients.map((cs, i) => {
    const up = new Pipe(cs.up, seeded(spec.seed * 1000 + i * 2 + 1))
    const down = new Pipe(cs.down, seeded(spec.seed * 1000 + i * 2 + 2))
    const conn = {
      id: `conn-${i}`,
      state: null as unknown,
      setState(s: unknown) {
        this.state = s === null ? null : structuredClone(s)
        return this.state
      },
      send: (m: string | ArrayBuffer | ArrayBufferView) => {
        const data =
          typeof m === 'string'
            ? m
            : m instanceof ArrayBuffer
              ? new Uint8Array(m)
              : new Uint8Array(m.buffer, m.byteOffset, m.byteLength)
        down.send(now, data)
      },
      close: () => {},
    }
    const session = new RoomSession(
      { send: (d) => up.send(now, d) },
      { handle: cs.handle, variant: 'standard', colour: i, content: 'ab12cd34ef56ab12' },
      spec.session,
    )
    // The jet, on the pad at the top of the shaft (§6.3: no ride in a room),
    // until the race says which start is its seat's (below).
    const jet = createHoverJet()
    jet.launched = true
    threeTupleToUnity(jet.body.position, level.spawn.pos as number[])
    threeQuatTupleToUnity(jet.body.orientation, level.spawn.quat as number[])
    jet.body.position.y += level.spawn.launch?.rise ?? 0
    return {
      spec: cs,
      session,
      conn,
      up,
      down,
      jet,
      mission: startMission(level),
      input: noInput(),
      record: [poseRecord()],
      truth: new Float64Array(maxTicks * 3),
      arrival: new Map(),
      kt: [],
      readyDone: false,
      start: null,
      loadedAt: null,
      releaseAt: null,
      tick: 0,
      finishTick: null,
      rec: spec.judge ? createLapRecorder(worldOffset, maxTicks) : null,
      postAt: null,
    }
  })
  const localAt = (c: Client, t: number) =>
    t + c.spec.clockOffsetMs + (t * (c.spec.driftPpm ?? 0)) / 1e6
  const frame: PoseFrame = poseFrame()
  const drawn = drawnPose()
  const scored: Scored[] = []

  // Everyone connects and joins, 10 ms apart.
  const joinAt = clients.map((_, i) => 10 * i)
  // The OWNER is whoever the room says it is (the first to join AT THE ROOM, which a
  // link can reorder), as `boot/app.ts` asks: `slot === owner`. Not client 0.
  const ownerNow = (): Client | undefined =>
    clients.find((c) => c.session.slot !== null && c.session.slot === c.session.owner)
  let configured = false
  let startSent = false
  const end = spec.raceSeconds
  let goAt = 0

  for (now = 0; ; now++) {
    // 1. Connections and joins.
    for (const [i, c] of clients.entries()) {
      if (joinAt[i] === now) {
        conns.push(c.conn)
        await room.onConnect(c.conn)
        c.session.join()
      }
    }
    // 2. The room hears what arrived.
    for (const c of clients) {
      for (const m of c.up.due(now)) {
        toRoom++
        if (typeof m === 'string' && m.startsWith('{"type":"finish"')) {
          finishArrivals.push(c.session.slot as number)
        }
        await room.onMessage(c.conn, typeof m === 'string' ? m : (m.buffer as ArrayBuffer))
      }
    }
    // 2b. DEV-390: a lap reaches the judge, which hands the room its verdict.
    for (const c of clients) {
      if (c.postAt === now) await postLap(c, level, judgeLink)
    }
    // 3. Each client hears what arrived, and feeds king-tide's interpolator the same poses.
    for (const c of clients) {
      const local = localAt(c, now)
      for (const m of c.down.due(now)) {
        c.session.receive(m, local)
        if (typeof m !== 'string' && decodePose(m, frame) && frame.slot !== c.session.slot) {
          const r = frame.records[0] as PoseRecord
          if (r.kind === POSE_KIND.own) {
            let a = c.arrival.get(frame.slot)
            if (!a) {
              a = new ArrivalTrack()
              c.arrival.set(frame.slot, a)
            }
            a.push(r.px, r.py, r.pz, local)
          }
        }
      }
      c.session.update(local)
    }
    // 4. The lobby, as the game will drive it (DEV-389): owner configures, all
    //    ready, owner starts, everyone loads.
    const owner = ownerNow()
    if (owner && owner.session.settings === null && !configured) {
      owner.session.configure(settings)
      configured = true
    }
    for (const c of clients) {
      if (!c.readyDone && c.session.settings !== null && c.session.roomPhase !== 'loading') {
        c.session.ready(true, rules)
        c.readyDone = true
      }
    }
    const everyoneReady =
      owner !== undefined &&
      Object.keys(owner.session.players).length === clients.length &&
      Object.values(owner.session.players).every((p) => p.ready)
    if (owner && everyoneReady && !startSent) {
      owner.session.start()
      startSent = true
    }
    for (const c of clients) {
      if (c.session.race !== null && c.loadedAt === null) {
        c.loadedAt = now + c.spec.loadMs
        // DEV-477: onto the seat's own start, before `loaded`, as the game does.
        const index = c.session.slot === null ? undefined : c.session.race.starts[c.session.slot]
        const at = index === undefined ? undefined : starts[index]
        if (index !== undefined && at) {
          c.start = index
          c.jet.body.position.x = at[0]
          c.jet.body.position.y = at[1]
          c.jet.body.position.z = at[2]
        }
      }
      if (c.loadedAt === now) c.session.loaded()
    }
    // 5. Release on the room clock, then the fixed steps.
    for (const c of clients) {
      const local = localAt(c, now)
      if (
        c.releaseAt === null &&
        c.session.goAt !== null &&
        c.session.roomNow(local) >= c.session.goAt
      ) {
        c.releaseAt = now
        goAt = c.session.field ?? c.session.goAt
      }
      if (c.releaseAt === null || c.finishTick !== null) continue
      while (c.releaseAt + c.tick * DT_MS <= now && c.finishTick === null) {
        if (c.tick > 0) stepClient(c, level)
        else if (c.rec) recordPose(c.rec, 0, c.jet.body.position, c.jet.body.orientation)
        const p = c.jet.body.position
        c.truth[c.tick * 3] = p.x
        c.truth[c.tick * 3 + 1] = p.y
        c.truth[c.tick * 3 + 2] = p.z
        fillRecord(c)
        c.session.step(c.tick, c.record, 1)
        if (c.mission.finishCrossed) {
          c.finishTick = c.tick
          // What `boot/app.ts`'s `roomStep` does on the crossing step.
          c.session.finish(c.tick)
          if (c.rec) {
            markLapEvent(c.rec, c.tick, 'finish')
            c.postAt = now + (c.spec.judgeMs ?? 0)
          }
        } else c.tick++
      }
    }
    // 6. Draw and score.
    if (now % frameMs === 0) {
      for (const [oi, o] of clients.entries()) {
        if (o.releaseAt === null || o.session.slot === null) continue
        const local = localAt(o, now)
        const roomNow = o.session.roomNow(local)
        for (const [si, s] of clients.entries()) {
          if (si === oi || s.releaseAt === null || s.session.slot === null) continue
          const last = s.finishTick ?? s.tick - 1 // the newest tick WRITTEN
          if (s.finishTick !== null) continue
          const slot = s.session.slot
          const r = o.session.renderTick(slot, 0, 0, roomNow)
          if (r === null || r < 8) continue
          o.session.draw(slot, 0, 0, roomNow, drawn)
          if (drawn.mode === 'none') continue
          const [tx, ty, tz] = truthAt(s.truth, Math.min(r, last), last)
          const [lx, ly, lz] = truthAt(s.truth, last, last)
          scored.push({
            error: Math.hypot(drawn.px - tx, drawn.py - ty, drawn.pz - tz),
            lag: Math.hypot(drawn.px - lx, drawn.py - ly, drawn.pz - lz),
            mode: drawn.mode,
            observer: oi,
            sender: si,
            trueMs: now,
          })
          const kt = o.arrival.get(slot)?.sample(local)
          if (kt) o.kt.push({ sender: si, trueMs: now, ...kt })
        }
      }
    }
    const allDone = clients.every(
      (c) => c.finishTick !== null && (c.postAt === null || c.postAt < now),
    )
    const racing = clients.some((c) => c.releaseAt !== null)
    if (allDone || (racing && end !== undefined && now > goAt + end * 1000)) break
    if (now > 20 * 60 * 1000) {
      const state = clients.map(
        (c) =>
          `${c.spec.handle}: released ${c.releaseAt}, tick ${c.tick}, finish ${c.finishTick}, ` +
          `rings ${c.mission.ringsPassed}, post ${c.postAt}, slot ${c.session.slot}, ` +
          `phase ${c.session.roomPhase}, error ${JSON.stringify(c.session.lastError)}, ` +
          `players ${JSON.stringify(c.session.players)}`,
      )
      throw new Error(`the race never finished — ${state.join('; ')}`)
    }
  }

  // king-tide's interpolator, at the constant lag that suits it best.
  let best = { lagMs: 0, p95: Number.POSITIVE_INFINITY, max: 0 }
  for (let lagMs = 0; lagMs <= 400; lagMs += 5) {
    const errs: number[] = []
    for (const o of clients) {
      for (const k of o.kt) {
        const s = clients[k.sender] as Client
        const last = s.finishTick ?? s.tick - 1 // the newest tick WRITTEN
        const r = (k.trueMs - lagMs - (s.releaseAt as number)) / DT_MS
        if (r < 8 || r > last) continue
        const [tx, ty, tz] = truthAt(s.truth, r, last)
        errs.push(Math.hypot(k.x - tx, k.y - ty, k.z - tz))
      }
    }
    if (errs.length === 0) continue
    const p95 = percentile(errs, 0.95)
    if (p95 < best.p95) best = { lagMs, p95, max: Math.max(...errs) }
  }

  return {
    scored,
    clients: clients.map((c) => ({
      releaseAt: c.releaseAt as number,
      finishTick: c.finishTick,
      rings: c.mission.ringsPassed,
      truth: c.truth,
      clockError: c.session.clock.offset - (now - localAt(c, now)),
      start: c.start,
    })),
    starts,
    arrival: best,
    goAt,
    messagesToRoom: toRoom,
    slots: clients.map((c) => c.session.slot as number),
    results: room.results,
    finishArrivals,
  }
}

/**
 * DEV-390: this client's recorded lap to the REAL judge, as `boot/app.ts`'s
 * `roomPostLap` sends it (`submitRoomLap`'s body), through the Function's
 * handler and the binding's internal API into the room.
 */
const postLap = async (c: Client, level: Level, link: RoomJudgeLink): Promise<void> => {
  const rec = c.rec as LapRecorder
  const doc = recordedLap(rec, {
    mission: level.id,
    mode: 'ringAttack',
    edition: 'anniversary',
    rules: lapRules(level.id, 'anniversary', 'standard') as string,
    vehicle: lapVehicle('hoverjet', 'standard'),
    build: 'room-harness',
  })
  const response = await judgeRoomLap(
    new Request('https://site/api/room/abcdefghij234567/lap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lap: await lapToWire(doc),
        seconds: c.mission.finishAt,
        seat: c.session.seat,
        tainted: false,
      }),
    }),
    link,
  )
  if (response.status !== 200) throw new Error(`the judge refused the post: ${response.status}`)
}

/** One fixed step of one client's flight: `autopilot-lap.ts`'s loop body, per client. */
const stepClient = (c: Client, level: Level): void => {
  const gates = c.mission.course.gates
  const target = nextGate(gates, c.mission.course.passed)
  const finishGate = c.mission.finishGate as NonNullable<typeof c.mission.finishGate>
  const aim = target >= 0 ? (gates[target] as (typeof gates)[number]).centre : finishGate
  const after = target >= 0 ? (gates[target + 1]?.centre ?? finishGate) : null
  autopilotActions(c.jet.body, aim, c.input, c.spec.tuning, [], Number.POSITIVE_INFINITY, after)
  stepHoverJet(c.jet, c.input)
  // The pose recorded AFTER the step, as `autopilot-lap.ts` and the game record it.
  if (c.rec) recordPose(c.rec, c.tick, c.jet.body.position, c.jet.body.orientation)
  const ring = stepMission(c.mission, level, c.jet.body.position, FIXED_DT)
  if (ring >= 0) {
    chainGate(c.jet.chain)
    c.session.ring(ring, c.tick)
    if (c.rec) markLapEvent(c.rec, c.tick, 'gate')
  }
}

const fillRecord = (c: Client): void => {
  const r = c.record[0] as PoseRecord
  const b = c.jet.body
  r.px = b.position.x
  r.py = b.position.y
  r.pz = b.position.z
  r.qx = b.orientation.x
  r.qy = b.orientation.y
  r.qz = b.orientation.z
  r.qw = b.orientation.w
  r.vx = b.velocity.x
  r.vy = b.velocity.y
  r.vz = b.velocity.z
  r.pitch = c.input.pitch
  r.roll = c.input.roll
  r.yaw = c.input.yaw
  r.throttle = c.input.throttle
  r.flags = c.input.boost ? 1 : 0
}

export { percentile }
