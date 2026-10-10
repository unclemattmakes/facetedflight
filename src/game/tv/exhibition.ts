// src/game/tv/exhibition.ts — the AI racers, racing for nobody. DEV-483.
//
// plan/FF-TV.md §4.0. When no room is racing, TV shows an EXHIBITION: the five
// AI racers (DEV-125's field) on a HoverJet Ring Attack course the UTC clock
// picks (`tv-schedule.ts`), then ~8 s of results, then the next slot's course,
// for as long as nobody turns it off. A board lap's link (`/tv/lap/<id>`,
// §2.6, call 2) flies that lap as one ghost beside them, on its own course.
//
// ── The finding: the field needs no player; the GO was the player's ─────
//
// `sim/racer-field.ts` takes `player: null` and means it (`:179`, `:236`): no
// body in the traffic picture, nothing pushed, nothing hit. What a player DID
// supply was the start. `boot/app.ts` steps the racers inside the fixed step
// BELOW the lift's early return (`if (rideSpec && launchHoldsShip(launch))`),
// so they stand on their pads until the local craft is let go — the grid waits
// for you, which is DEV-125's rule and right for a race. An exhibition has
// nobody to wait for, so it supplies its own GO: a countdown of its own on the
// fixed step, then the field stepped on that step with no player in it. The
// plan's fallback — the local craft on the autopilot, hidden, as the race's
// clock — is not needed, and is worse: it would fly a real run through the
// finish block that records one, and put a sixth body in the racers' air.
//
// ── What it never does ───────────────────────────────────────────────────
//
// Record. The local craft is never launched, so the run that records never
// starts; and the exhibition holds `off-the-record.ts`'s hold from `start` to
// `stop`, which every record door checks. `tests/unit/tv-exhibition.test.ts`
// runs one to its finish and knocks on every door.
//
// ── The shape: a host, and this ─────────────────────────────────────────
//
// Everything that needs the running game — boarding a course, the racers'
// meshes, the ghost's, the lap server — is the HOST's (`ExhibitionHost`),
// which `boot/app.ts`'s exhibition block implements in a dozen lines. The
// phases, the clock, the places and the loop are here, so a unit test drives
// the very same machine over a headless racer field. The hand-off the rest of
// TV codes against (§9.1) is `Exhibition`: `stop()`, `craft()`, `onFinish()`.
//
// Renderer-free: no three, no DOM. Wall time only through `host.now()`, for
// the schedule; the race itself runs on the fixed steps it is handed.

import type { RaceLine } from '@/game/race-place'
import { raceProgress } from '@/game/race-place'
import { type RacerReading, racerName, racerStanding } from '@/game/results-state'
import type { StandingStatus } from '@/render/results'
import type { LapDoc } from '@/sim/ghost'
import { advanceRoute, createRouteCursor } from '@/sim/route'
import { holdRecording } from './off-the-record'
import { nextExhibitionSlot } from './tv-schedule'

/** The 3-2-1 before the racers leave their pads, seconds of fixed step. */
export const EXHIBITION_COUNTDOWN_SECONDS = 3

/** How long the results stand before the next course (§4.0: "~8 s"). */
export const EXHIBITION_RESULTS_SECONDS = 8

/**
 * A race with no clock that ends it still ends, seconds. Every Ring Attack
 * course has one (180 s today, `raceTimeLimit`); this is for a course that
 * does not, and for a ghost whose lap never crosses.
 */
export const EXHIBITION_MAX_RACE_SECONDS = 300

/** Wall seconds a board may take before the exhibition gives up on it and moves on. */
export const EXHIBITION_BOARD_TIMEOUT_SECONDS = 90

/**
 * What TV calls a shared lap's ghost. Never the board's handle: Matt,
 * 2026-09-30, "no names on TV, ever" (plan/FF-TV.md §8).
 */
export const TV_LAP_NAME = 'Shared lap'

export type ExhibitionPhase = 'boarding' | 'countdown' | 'racing' | 'results' | 'stopped'

interface Vec3Like {
  x: number
  y: number
  z: number
}
interface QuatLike {
  x: number
  y: number
  z: number
  w: number
}

/** A racer, as the exhibition reads one: an `AiRacer` satisfies it. */
export interface ExhibitionRacer extends RacerReading {
  readonly course: { readonly passed: readonly boolean[] }
  readonly jet: { readonly body: { readonly position: Vec3Like } }
}

/** The boarded course's racers, as the host hands them over. */
export interface ExhibitionField {
  readonly racers: readonly ExhibitionRacer[]
  /** The line every entrant is measured along, or null on a course with none. */
  readonly line: RaceLine | null
  /** `raceTimeLimit` for the course's mode: 0 where the clock ends nothing. */
  readonly timeLimit: number
  /** One fixed step of the whole field, with no player in it (`player: null`). */
  step(dt: number): void
  /** Racer `i`'s DRAWN pose, THREE space (interpolated, as the meshes are). */
  pose(i: number, position: Vec3Like, quaternion: QuatLike): void
}

/** A board lap, as `net/lap-client.ts`'s `fetchLap` returns its parts. */
export interface ExhibitionLap {
  readonly id: string
  readonly mission: string
  readonly doc: LapDoc
  /** The server's rescore, or null for a lap that never crossed. */
  readonly seconds: number | null
  readonly handle: string
}

/** The lap's ghost, built by the host from `loadPlayerGhost`'s parts. */
export interface ExhibitionGhost {
  /** Fly it to `clock` seconds after GO (and draw it there). */
  update(clock: number): void
  /** Its drawn pose, THREE space; false when it has none (before GO, after its lap). */
  pose(position: Vec3Like, quaternion: QuatLike): boolean
  dispose(): void
}

/** What the running game does for an exhibition. `boot/app.ts` implements it. */
export interface ExhibitionHost {
  /** The courses the clock schedules over: Quick Race's pool, by id. */
  courses(): Promise<readonly string[]>
  /** Begin boarding `course` (no ride, the local craft hidden and never launched). */
  board(course: string): Promise<void>
  /** On `course`, on the mission screen, with its field built (or none to build). */
  aboard(course: string): boolean
  /** The boarded course's racers, or null where its mode races nobody. */
  field(): ExhibitionField | null
  /** A board lap by id, or the reason there is none. */
  fetchLap(id: string): Promise<ExhibitionLap | string>
  /** The lap's ghost on the boarded course, or null if it cannot be built. */
  ghost(lap: ExhibitionLap): Promise<ExhibitionGhost | null>
  /** Wall-clock ms, UTC: for the schedule, and nothing in the race. */
  now(): number
  /** One line for the console. */
  log(line: string): void
}

/** One craft on screen: what DEV-481's camera and DEV-482's standings read. */
export interface ExhibitionCraft {
  readonly kind: 'racer' | 'ghost'
  /** The racer's callsign (DEV-651; its tuned `spec.id` where none was drawn), or the lap's handle for a ghost. */
  readonly name: string
  /** Drawn, THREE space. */
  readonly position: Readonly<Vec3Like>
  /** Drawn, THREE space. The hull noses along its local -z (trap 22). */
  readonly quaternion: Readonly<QuatLike>
  /**
   * The nose's yaw, radians, as three's `rotation.y` would hold it for a
   * -z-nosed hull: 0 is nose to -z, positive turns toward -x.
   */
  readonly heading: number
  /** 1-based, finishers by time, then the air by progress, then out of time. */
  readonly place: number
  readonly status: StandingStatus
  /** Its time once it has crossed. */
  readonly seconds: number | null
}

/** A race's result, as `onFinish` hands it on. */
export interface ExhibitionResult {
  readonly course: string
  /** Seconds from GO to the finish of the last entrant (or the cap). */
  readonly raceSeconds: number
  /** Every entrant, in place order. */
  readonly standings: readonly {
    readonly kind: 'racer' | 'ghost'
    readonly name: string
    readonly status: StandingStatus
    readonly seconds: number | null
  }[]
  /** The lap the ghost flew, or null. */
  readonly lapId: string | null
}

/** What `startExhibition` takes (§9.1): a course to start on, or a lap to fly. */
export interface ExhibitionOptions {
  /** Start on this course instead of the clock's. The loop then follows the clock. */
  readonly course?: string
  /** Fly this board lap as a ghost beside the racers, on the lap's own course. */
  readonly lapId?: string
}

/** The hand-off (§9.1): what the TV block and the camera code against. */
export interface Exhibition {
  readonly phase: ExhibitionPhase
  /** The course on screen, or being boarded; null before the first is chosen. */
  readonly course: string | null
  /** Seconds since GO this race; 0 before it. */
  readonly raceSeconds: number
  /** Races finished since `start`. */
  readonly races: number
  /** Stop it now: the hold released, the ghost gone. Idempotent. */
  stop(): void
  /** Every craft on screen, ghost included, in place order. */
  craft(): readonly ExhibitionCraft[]
  /** Called at each race's finish, before the results hold. Returns an unsubscribe. */
  onFinish(cb: (result: ExhibitionResult) => void): () => void
  /**
   * Cut away: at once if no race is being run (boarding, the countdown, the
   * results), else at this race's finish — never mid-race (§4.0). Stops the
   * exhibition, then calls `go`.
   */
  cutIn(go: () => void): void
}

/** The driver `boot/app.ts` holds: the hand-off, and the two calls that run it. */
export interface ExhibitionDriver extends Exhibition {
  /** One fixed step. True while the exhibition owns the step (anything but stopped). */
  tick(dt: number): boolean
  /**
   * Once a frame, before the camera: boarding, and the ghost's drawn pose.
   * `alpha` is what `stepFixed` returned (D4; 1 when absent): the ghost is
   * drawn `1 - alpha` of a step behind the race clock, where the racers'
   * interpolation draws them (DEV-612, DEV-371's rule for the player's ghost).
   */
  frame(frameSeconds: number, alpha?: number): void
}

/** Volatile scratch for progress reads. Valid only inside one `standingsOf`. */
const _sim = { x: 0, y: 0, z: 0 }

/**
 * Start an exhibition on `host` — the machine behind `boot/app.ts`'s
 * `startExhibition` (§9.1). It boards at once; nothing is recorded until it is
 * stopped.
 */
export const createExhibition = (
  host: ExhibitionHost,
  options: ExhibitionOptions = {},
): ExhibitionDriver => {
  const release = holdRecording('tv exhibition')
  let phase: ExhibitionPhase = 'boarding'
  let course: string | null = null
  let slot: number | null = null
  let lap: ExhibitionLap | null = null
  let ghost: ExhibitionGhost | null = null
  let ghostPending = false
  let boardWait = 0
  let boardIssued = false
  let countdown = 0
  let raceClock = 0
  /** The last fixed step's length: how far behind the clock `1 - alpha` of a step is. */
  let lastStep = 0
  let resultsLeft = 0
  let races = 0
  let cut: (() => void) | null = null
  const listeners = new Set<(r: ExhibitionResult) => void>()
  const ghostCursor = createRouteCursor()

  const dropGhost = (): void => {
    ghost?.dispose()
    ghost = null
    ghostPending = false
  }

  const boardCourse = (next: string, nextSlot: number | null): void => {
    dropGhost()
    course = next
    slot = nextSlot
    phase = 'boarding'
    boardWait = 0
    boardIssued = true
    raceClock = 0
    ghostCursor.index = 0
    ghostCursor.s = 0
    host.log(
      `tv: exhibition boarding ${next}` +
        (nextSlot !== null ? ` (slot ${nextSlot})` : '') +
        (lap ? ` with lap ${lap.id}` : ''),
    )
    void host.board(next)
  }

  /** The clock's next course, past the one just flown. */
  const boardNext = async (): Promise<void> => {
    const courses = await host.courses()
    if (phase === 'stopped') return
    const now = host.now()
    let chosen = nextExhibitionSlot(
      now,
      courses,
      course !== null && slot !== null ? { slot, course } : null,
    )
    // A course the clock did not choose (a lap's, or `options.course`) has no
    // slot, and is still the one not to fly twice running.
    if (chosen && course !== null && chosen.course === course) {
      chosen = nextExhibitionSlot(now, courses, { slot: chosen.slot, course })
    }
    if (!chosen) {
      host.log('tv: exhibition has no course to fly; stopping')
      stop()
      return
    }
    boardCourse(chosen.course, chosen.slot)
  }

  const begin = async (): Promise<void> => {
    if (options.lapId) {
      const got = await host.fetchLap(options.lapId)
      if (phase === 'stopped') return
      if (typeof got === 'string') {
        host.log(`tv: lap ${options.lapId} will not fly (${got}); the clock's course instead`)
      } else {
        lap = got
        boardCourse(got.mission, null)
        return
      }
    }
    if (options.course) {
      boardCourse(options.course, null)
      return
    }
    await boardNext()
  }

  // ── where everybody is ─────────────────────────────────────────────────

  interface Entry {
    kind: 'racer' | 'ghost'
    name: string
    index: number
    status: StandingStatus
    seconds: number | null
    reached: number
    arc: number
  }

  const standingsOf = (): Entry[] => {
    const field = host.field()
    const entries: Entry[] = []
    if (field) {
      field.racers.forEach((racer, index) => {
        const standing = racerStanding(racer, field.timeLimit)
        const progress = field.line
          ? raceProgress(field.line, racer.course.passed, racer.jet.body.position)
          : { reached: 0, arc: 0 }
        entries.push({
          kind: 'racer',
          name: racerName(racer.spec),
          index,
          status: standing.status,
          seconds: standing.seconds,
          reached: progress.reached,
          arc: progress.arc,
        })
      })
    }
    if (lap) {
      const crossed = lap.seconds !== null && raceClock >= lap.seconds
      let reached = 0
      let arc = 0
      const position = { x: 0, y: 0, z: 0 }
      const q = { x: 0, y: 0, z: 0, w: 1 }
      if (field?.line && ghost?.pose(position, q)) {
        // Back to SIM space (z mirrored) to measure along the line, with a
        // forward-only cursor: a lap is continuous, and a whole-line search
        // would put a ghost on a leg that doubles back nine gates ahead.
        _sim.x = position.x
        _sim.y = position.y
        _sim.z = -position.z
        advanceRoute(field.line.route, ghostCursor, _sim, 8)
        arc = ghostCursor.s
        for (const g of field.line.gateArc) if (g <= arc) reached += 1
      }
      entries.push({
        kind: 'ghost',
        name: TV_LAP_NAME,
        index: -1,
        status: crossed ? 'finished' : 'flying',
        seconds: crossed ? lap.seconds : null,
        reached: crossed ? Number.POSITIVE_INFINITY : reached,
        arc,
      })
    }
    const rank = (e: Entry): number => (e.status === 'finished' ? 0 : e.status === 'flying' ? 1 : 2)
    return entries.sort((a, b) => {
      const ra = rank(a)
      const rb = rank(b)
      if (ra !== rb) return ra - rb
      if (ra === 0) return (a.seconds ?? 0) - (b.seconds ?? 0)
      if (a.reached !== b.reached) return b.reached - a.reached
      return b.arc - a.arc
    })
  }

  const raceOver = (): boolean => {
    const field = host.field()
    const cap = field && field.timeLimit > 0 ? field.timeLimit : EXHIBITION_MAX_RACE_SECONDS
    if (raceClock >= cap) return true
    const racersDone =
      !field || field.racers.every((r) => racerStanding(r, field.timeLimit).status !== 'flying')
    const ghostDone = !lap || (lap.seconds !== null ? raceClock >= lap.seconds : false)
    return racersDone && ghostDone
  }

  const finish = (): void => {
    races += 1
    const result: ExhibitionResult = {
      course: course ?? '',
      raceSeconds: raceClock,
      standings: standingsOf().map((e) => ({
        kind: e.kind,
        name: e.name,
        status: e.status,
        seconds: e.seconds,
      })),
      lapId: lap?.id ?? null,
    }
    host.log(
      `tv: exhibition finished on ${result.course} in ${raceClock.toFixed(1)} s — ` +
        result.standings
          .map((s, i) => `${i + 1}. ${s.name} ${s.seconds?.toFixed(2) ?? s.status}`)
          .join(', '),
    )
    phase = 'results'
    resultsLeft = EXHIBITION_RESULTS_SECONDS
    for (const cb of [...listeners]) cb(result)
    if (phase === 'results' && cut) cutNow()
  }

  const stop = (): void => {
    if (phase === 'stopped') return
    phase = 'stopped'
    dropGhost()
    release()
    host.log('tv: exhibition stopped')
  }

  const cutNow = (): void => {
    const go = cut
    cut = null
    stop()
    go?.()
  }

  void begin()

  return {
    get phase() {
      return phase
    },
    get course() {
      return course
    },
    get raceSeconds() {
      return raceClock
    },
    get races() {
      return races
    },
    stop,
    craft() {
      const field = host.field()
      return standingsOf().map((e, i) => {
        const position = { x: 0, y: 0, z: 0 }
        const quaternion = { x: 0, y: 0, z: 0, w: 1 }
        if (e.kind === 'racer') field?.pose(e.index, position, quaternion)
        else ghost?.pose(position, quaternion)
        // The nose: local -z, rotated (trap 22).
        const { x, y, z, w } = quaternion
        const fx = -(2 * (x * z + w * y))
        const fz = -(1 - 2 * (x * x + y * y))
        return {
          kind: e.kind,
          name: e.name,
          position,
          quaternion,
          heading: Math.atan2(-fx, -fz),
          place: i + 1,
          status: e.status,
          seconds: e.seconds,
        }
      })
    },
    onFinish(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    cutIn(go) {
      if (phase === 'stopped') {
        go()
        return
      }
      cut = go
      if (phase !== 'racing') cutNow()
    },
    tick(dt) {
      if (phase === 'stopped') return false
      if (phase === 'countdown') {
        countdown -= dt
        if (countdown <= 0) {
          phase = 'racing'
          raceClock = 0
          host.log(`tv: exhibition GO on ${course}`)
        }
      } else if (phase === 'racing') {
        host.field()?.step(dt)
        raceClock += dt
        lastStep = dt
        if (raceOver()) finish()
      } else if (phase === 'results') {
        // The racers fly on — a finished racer climbs away (`ai-racer.ts`) —
        // so the card stands over a sky that is still moving.
        host.field()?.step(dt)
        resultsLeft -= dt
        if (resultsLeft <= 0) {
          lap = null // `/tv/lap/<id>` flies its lap once, then the clock's choice (§2.6)
          phase = 'boarding'
          boardIssued = false
          void boardNext()
        }
      }
      return true
    },
    frame(frameSeconds, alpha = 1) {
      if (phase === 'boarding' && course !== null && boardIssued) {
        boardWait += frameSeconds
        if (host.aboard(course) && !ghostPending) {
          if (lap && !ghost) {
            ghostPending = true
            const flying = lap
            void host.ghost(flying).then((g) => {
              ghostPending = false
              if (phase === 'stopped' || lap !== flying) {
                g?.dispose()
                return
              }
              ghost = g
              if (!g) host.log(`tv: lap ${flying.id}'s ghost could not be built; racing without it`)
              lap = g ? flying : null
              phase = 'countdown'
              countdown = EXHIBITION_COUNTDOWN_SECONDS
            })
          } else {
            phase = 'countdown'
            countdown = EXHIBITION_COUNTDOWN_SECONDS
          }
        } else if (boardWait > EXHIBITION_BOARD_TIMEOUT_SECONDS) {
          host.log(
            `tv: ${course} did not board in ${EXHIBITION_BOARD_TIMEOUT_SECONDS} s; moving on`,
          )
          lap = null
          boardIssued = false
          void boardNext()
        }
      }
      // DEV-612: while the clock runs, drawn where the racers are drawn, `1 -
      // alpha` of a step behind it (DEV-371's rule for the player's ghost). At
      // the clock itself the ghost stepped at 82 Hz beside racers that glide,
      // and a camera following it showed the step. The results hold the clock.
      const drawnAt =
        phase === 'racing' ? Math.max(0, raceClock - (1 - alpha) * lastStep) : raceClock
      if (ghost && (phase === 'racing' || phase === 'results')) ghost.update(drawnAt)
    },
  }
}
