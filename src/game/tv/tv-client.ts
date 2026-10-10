// src/game/tv/tv-client.ts, what Faceted Flight TV shows, and when it changes. DEV-480.
//
// docs/plan/FF-TV.md §3.3, §3.4, §2.6. The guide (DEV-479) LISTS the races that
// are on; this CHOOSES, on the client, from the list it just read:
//
//   - **at random among the races furthest along**, `racing`, else
//     `countdown`, else `loading` (§2.6: *"random rooms"*), preferring one this
//     session has not shown yet, so Next Race flips through the whole list;
//   - **never cutting away mid-race on its own.** It re-reads the list at each
//     finish (after the results have been up `TV_FINISH_HOLD_MS`) and every
//     `TV_REREAD_MS`; the viewer's NEXT RACE moves on at once;
//   - **never a spin.** A list that does not answer, a site with no rooms (a
//     503, DEV-470), a race that is full (`CLOSE.full`) or gone (a 404 before
//     any upgrade, §2.2): the next race on the list, or the exhibition, AI
//     racers (DEV-483), which is what TV shows whenever nothing is live.
//
// A link to one room (`?tv=<id>`) watches that room; when the room is between
// races it shows the exhibition and cuts back once that room races again, and
// when the room is gone it says so and makes `/tv`'s choice.
//
// THREE-free and DOM-free: the list read, the watch and the clock come in, and
// what to SHOW goes out through `onShow`. `boot/app.ts` owns the watch socket
// (`watchStart`), the exhibition (`startExhibition`) and the camera.

import { CLOSE } from '@/net/room-protocol'
import { TV_ID_SHAPE } from '@/net/tv-protocol'
import { ROOM_OFF, type RoomStatus } from '../room-client'
import type { TvLink } from './tv-link'

/** §3.3: the list route, on the page's own origin (`functions/api/tv/index.ts`). */
export const TV_LIST_PATH = '/api/tv'
/** §3.3: the watch route; `<tvId>` follows it (`functions/api/tv/[id].ts`). */
export const TV_WATCH_PREFIX = '/api/tv/'

/** A race's phase as the guide lists it (§3.2). A lobby is never listed. */
export type TvRacePhase = 'loading' | 'countdown' | 'racing' | 'results'

/** One race on the list (§3.3). No code, no name: a TV id, a course, a phase, a head count. */
export interface TvRace {
  readonly tv: string
  readonly mission: string
  readonly phase: TvRacePhase
  readonly racers: number
  /** Room ms the race entered this phase. Read for nothing here but kept: the lower third may. */
  readonly since: number
}

/** The guide's answer to `GET /api/tv`. */
export interface TvListing {
  readonly races: readonly TvRace[]
  /** Rooms getting ready (in a lobby), for a line such as "2 rooms getting ready". */
  readonly lobbies: number
}

/** Re-read the list this often while nothing changes it, ms (§3.5: 60 reads a viewer-hour). */
export const TV_REREAD_MS = 60_000
/**
 * Hold a race's results this long before choosing again, ms (§3.4: *"a hold of
 * ~8 s"*). Not the guide's `TV_RESULTS_HOLD_MS` (`net/tv-protocol.ts`, ten
 * minutes): that is how long a finished race stays LISTED; this is how long
 * the viewer sees its results before TV moves on. A listed race in `results`
 * is never chosen (`TV_PHASE_RANK`).
 */
export const TV_FINISH_HOLD_MS = 8_000

/** How far along a phase is, for choosing. `results` is 0: a race that has ended is not chosen. */
export const TV_PHASE_RANK: Readonly<Record<TvRacePhase, number>> = {
  racing: 3,
  countdown: 2,
  loading: 1,
  results: 0,
}

const PHASES = new Set<string>(Object.keys(TV_PHASE_RANK))

/** The list, checked: anything that is not the §3.3 shape is null, and a bad race is dropped. */
export const parseTvListing = (value: unknown): TvListing | null => {
  if (typeof value !== 'object' || value === null) return null
  const v = value as { races?: unknown; lobbies?: unknown }
  if (!Array.isArray(v.races)) return null
  const races: TvRace[] = []
  for (const r of v.races as unknown[]) {
    if (typeof r !== 'object' || r === null) continue
    const x = r as Record<string, unknown>
    if (
      typeof x.tv === 'string' &&
      TV_ID_SHAPE.test(x.tv) &&
      typeof x.mission === 'string' &&
      typeof x.phase === 'string' &&
      PHASES.has(x.phase) &&
      typeof x.racers === 'number' &&
      Number.isFinite(x.racers)
    ) {
      races.push({
        tv: x.tv,
        mission: x.mission,
        phase: x.phase as TvRacePhase,
        racers: x.racers,
        since: typeof x.since === 'number' && Number.isFinite(x.since) ? x.since : 0,
      })
    }
  }
  const lobbies =
    typeof v.lobbies === 'number' && Number.isInteger(v.lobbies) && v.lobbies >= 0 ? v.lobbies : 0
  return { races, lobbies }
}

/**
 * The race to show (§2.6, §3.4): AT RANDOM among the races furthest along,
 * preferring one not in `shown`; never `exclude`, never one whose race has
 * ended. Null when nothing on the list is worth cutting to.
 */
export const chooseRace = (
  listing: TvListing,
  opts: {
    readonly exclude?: string | null
    readonly shown?: ReadonlySet<string>
    readonly prefer?: string | null
    readonly random: () => number
  },
): TvRace | null => {
  const eligible = listing.races.filter(
    (r) => TV_PHASE_RANK[r.phase] > 0 && r.tv !== (opts.exclude ?? null),
  )
  if (eligible.length === 0) return null
  // A link's own room, when it is on, whatever else is.
  const preferred = opts.prefer ? eligible.find((r) => r.tv === opts.prefer) : undefined
  if (preferred) return preferred
  const top = Math.max(...eligible.map((r) => TV_PHASE_RANK[r.phase]))
  const tier = eligible.filter((r) => TV_PHASE_RANK[r.phase] === top)
  const fresh = opts.shown ? tier.filter((r) => !opts.shown?.has(r.tv)) : tier
  const pool = fresh.length > 0 ? fresh : tier
  const k = Math.min(pool.length - 1, Math.max(0, Math.floor(opts.random() * pool.length)))
  return pool[k] as TvRace
}

/** THE TV watch URL: the page's own origin, `/api/tv/<tvId>`, as `watchUrl` is for a code. */
export const tvWatchUrl = (
  tv: string,
  location: { readonly protocol: string; readonly host: string },
): string =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${TV_WATCH_PREFIX}${tv}`

/** THE list URL, same origin. */
export const tvListUrl = (location: { readonly protocol: string; readonly host: string }): string =>
  `${location.protocol}//${location.host}${TV_LIST_PATH}`

/** What TV is showing: a room's race, or the exhibition (AI racers, or a lap among them). */
export type TvShow =
  | { readonly kind: 'live'; readonly tv: string; readonly mission: string | null }
  | {
      readonly kind: 'exhibition'
      /** A board lap to fly among the racers (`/tv/lap/<id>`, call 2). */
      readonly lapId: string | null
      /** Move the exhibition on to its next course (Next Race on the exhibition). */
      readonly next: boolean
    }

/** The live watch, as the client reads it each frame (`boot/app.ts`'s `WatchClient`). */
export interface TvWatchState {
  readonly status: RoomStatus
  readonly closeCode: number | null
  /** The diagnosis GET's status after a handshake that never opened (DEV-470), or null. */
  readonly probed: number | null
  /** The watched room's phase, once its keyframe is in; null before. */
  readonly phase: string | null
}

/** The notes the viewer is shown, in one line each and plain words. */
export const TV_NOTE = {
  closed: 'That room has closed, so here is what is on.',
  full: 'That race is full of viewers, so here is the next one.',
  lost: 'That race could not be reached, so here is the next one.',
  between: 'That room is between races. TV cuts to it when it races again.',
  live: 'A live race is on: press Next Race to watch it.',
  noRooms: 'Nothing is live right now: AI racers.',
} as const

export type TvMode = 'off' | 'choosing' | 'live' | 'exhibition'

/** TV as `__ff2.tv()` reports it, for the specs and the console (`boot/app.ts`). */
export interface TvProbe {
  readonly mode: TvMode
  /** The race on screen, live; null on the exhibition. */
  readonly tv: string | null
  readonly mission: string | null
  readonly note: string | null
  readonly reads: number
  /** A race the clock found while the exhibition runs: it cuts in at the finish. */
  readonly waiting: string | null
  /** The exhibition's lap, when a `/tv/lap/<id>` link asked for one. */
  readonly lapId: string | null
  /** The camera's mode, and the craft it is on (its name, and its racer number when a room's). */
  readonly camera: string | null
  readonly following: string | null
  readonly followingRacer: number | null
  /** The plate: up or not, the row a press takes, and its rows. */
  readonly plate: {
    readonly up: boolean
    readonly selected: number
    readonly rows: readonly {
      readonly id: string
      readonly label: string
      readonly value: string | null
      readonly note: string
    }[]
  }
  /** The last link SHARE THIS VIEW made (the short form), or null. */
  readonly shared: string | null
}

export interface TvClientOptions {
  readonly now: () => number
  readonly random: () => number
  /** `GET /api/tv`: its status and parsed body (null when not JSON). Rejects on no network. */
  readonly list: () => Promise<{ readonly status: number; readonly body: unknown }>
  /** The live watch's state now, or null when there is none. */
  readonly watchState: () => TvWatchState | null
  /** Show this, now: the app starts or stops the watch and the exhibition to match. */
  readonly onShow: (show: TvShow) => void
  /** Every change of mode or note, for the log and the probe. */
  readonly onChange?: (client: TvClient) => void
}

/**
 * The channel's state machine. `start` once per boarding, `update` every frame,
 * `next` for the plate's NEXT RACE, `exhibitionFinished` when the exhibition's
 * race ends, `stop` on LEAVE TV.
 */
export class TvClient {
  mode: TvMode = 'off'
  /** The race on screen, when live. */
  tv: string | null = null
  /** Its course, when the list said. */
  mission: string | null = null
  /** The one line the viewer is told, or null. */
  note: string | null = null
  /** The last list read, or null. */
  listing: TvListing | null = null
  /** A race on the list while the exhibition runs: cut in at the exhibition's finish (§4.0). */
  waiting: TvRace | null = null
  /** The site has no rooms (503): the list is not read again this session. */
  roomsOff = false
  /** Lists read, for the specs. */
  reads = 0
  readonly #opts: TvClientOptions
  readonly #shown = new Set<string>()
  /** A link's own room: preferred whenever it is on (§2.6). */
  #wanted: string | null = null
  /** Bumped on every decision, so a list read that lands after one is ignored. */
  #gen = 0
  #lastRead = Number.NEGATIVE_INFINITY
  #reading = false
  #resultsSince: number | null = null
  /** The watched room's phase has been seen at least once since `#watch`. */
  #phaseSeen = false
  /** The clock's read found the race on screen listed in `results`. */
  #listedOver = false

  constructor(opts: TvClientOptions) {
    this.#opts = opts
  }

  /** Board TV on `link`. A link to one room watches it first; anything else reads the list. */
  start(link: TvLink, refused: string | null = null): void {
    this.#gen++
    this.#shown.clear()
    this.waiting = null
    this.note = refused
    this.#wanted = link.kind === 'race' ? link.tv : null
    if (link.kind === 'race') {
      this.#watch(link.tv, null)
      return
    }
    if (link.kind === 'lap') {
      this.#exhibition({ lapId: link.lap, next: false }, this.note)
      // A lap is the viewer's choice: the list is read on the usual clock, and a
      // live race waits for the lap's finish like any other cut-in.
      this.#lastRead = this.#opts.now()
      return
    }
    this.mode = 'choosing'
    this.#changed()
    void this.#read(null)
  }

  /** NEXT RACE: another race on the list at once, else the exhibition's next course. */
  next(): void {
    this.#gen++
    this.note = null
    const exclude = this.mode === 'live' ? this.tv : null
    if (this.waiting) {
      const race = this.waiting
      this.waiting = null
      this.#watch(race.tv, race.mission)
      return
    }
    this.mode = this.mode === 'off' ? 'choosing' : this.mode
    void this.#read(exclude, true)
  }

  /** The exhibition's race has ended: a race waiting on the list cuts in now (§4.0). */
  exhibitionFinished(): void {
    if (this.mode !== 'exhibition') return
    if (this.waiting) {
      const race = this.waiting
      this.waiting = null
      this.#gen++
      this.#watch(race.tv, race.mission)
      return
    }
    void this.#read(null)
  }

  /** LEAVE TV. */
  stop(): void {
    this.#gen++
    this.mode = 'off'
    this.tv = null
    this.mission = null
    this.waiting = null
    this.note = null
    this.#changed()
  }

  /** Every frame: the watch's health, the finish, and the clock's re-read. */
  update(): void {
    if (this.mode === 'off') return
    const now = this.#opts.now()
    if (this.mode === 'live') {
      const w = this.#opts.watchState()
      if (w && w.status === 'closed') {
        this.#watchFailed(w)
        return
      }
      const phase = this.#listedOver ? 'results' : (w?.phase ?? null)
      if (phase !== null) {
        if (!this.#phaseSeen && phase === 'lobby' && this.tv === this.#wanted) {
          // A link's room between races: the exhibition, until it is on again.
          this.#phaseSeen = true
          this.#exhibition({ lapId: null, next: false }, TV_NOTE.between)
          this.#lastRead = now
          return
        }
        this.#phaseSeen = true
        if (phase === 'results' || phase === 'lobby') {
          this.#resultsSince ??= now
          if (now - this.#resultsSince >= TV_FINISH_HOLD_MS) {
            this.#resultsSince = null
            this.#gen++
            this.note = null
            // The race we watched may race again; it is not excluded.
            void this.#read(null)
          }
        } else {
          this.#resultsSince = null
        }
      }
    }
    if (
      (this.mode === 'exhibition' || this.mode === 'live') &&
      !this.roomsOff &&
      now - this.#lastRead >= TV_REREAD_MS
    ) {
      // Only to NOTICE a race: a live race is never cut away from on the clock.
      void this.#read(null, false, true)
    }
  }

  // ── inside ────────────────────────────────────────────────────────────────

  #changed(): void {
    this.#opts.onChange?.(this)
  }

  #watch(tv: string, mission: string | null): void {
    this.mode = 'live'
    this.tv = tv
    this.mission = mission
    this.waiting = null
    this.#shown.add(tv)
    this.#resultsSince = null
    this.#phaseSeen = false
    this.#listedOver = false
    this.#opts.onShow({ kind: 'live', tv, mission })
    this.#changed()
  }

  #exhibition(opts: { lapId: string | null; next: boolean }, note: string | null): void {
    this.mode = 'exhibition'
    this.tv = null
    this.mission = null
    this.note = note
    this.#opts.onShow({ kind: 'exhibition', lapId: opts.lapId, next: opts.next })
    this.#changed()
  }

  /** The live watch closed: say why in one line, then the next race or the exhibition. */
  #watchFailed(w: TvWatchState): void {
    const was = this.tv
    this.#gen++
    if (w.closeCode === ROOM_OFF || w.probed === 503) {
      this.roomsOff = true
      this.#exhibition({ lapId: null, next: false }, TV_NOTE.noRooms)
      return
    }
    this.note =
      w.probed === 404 ? TV_NOTE.closed : w.closeCode === CLOSE.full ? TV_NOTE.full : TV_NOTE.lost
    if (was === this.#wanted) this.#wanted = null
    this.mode = 'choosing'
    this.#changed()
    void this.#read(was)
  }

  /**
   * Read the list and act on it. `exclude`: never this race. `next`: NEXT
   * RACE's read, which moves the exhibition on when nothing is live.
   * `notice`: the clock's read, which never cuts away from what is on, a race
   * found while the exhibition runs waits for its finish.
   */
  async #read(exclude: string | null, next = false, notice = false): Promise<void> {
    if (this.roomsOff) {
      if (!notice) this.#exhibition({ lapId: null, next }, this.note ?? TV_NOTE.noRooms)
      return
    }
    if (notice && this.#reading) return
    const gen = this.#gen
    this.#lastRead = this.#opts.now()
    this.#reading = true
    let listing: TvListing | null = null
    let status = 0
    try {
      const answer = await this.#opts.list()
      status = answer.status
      listing = answer.status === 200 ? parseTvListing(answer.body) : null
    } catch {
      listing = null
    } finally {
      this.#reading = false
      this.reads++
    }
    if (gen !== this.#gen || this.mode === 'off') return
    if (status === 503) this.roomsOff = true
    this.listing = listing
    const race = listing
      ? chooseRace(listing, {
          exclude,
          shown: this.#shown,
          prefer: this.#wanted,
          random: this.#opts.random,
        })
      : null
    if (notice) {
      // The clock's read: tell the viewer, cut nothing. A link's own room cuts
      // in at the exhibition's finish too; on a live race nothing changes, unless
      // the list says that race is over (`#listedOver`): the watch's phase may
      // not say so (a `results` message moves no session's phase).
      if (this.mode === 'exhibition') {
        this.waiting = race
        if (race) this.note = TV_NOTE.live
        this.#changed()
      } else if (this.mode === 'live' && listing) {
        this.#listedOver = listing.races.some((r) => r.tv === this.tv && r.phase === 'results')
      }
      return
    }
    if (race) {
      this.#watch(race.tv, race.mission)
      return
    }
    // Nothing live. On the exhibition already, NEXT RACE moves it on; anything
    // else shows it (or keeps it) with the note that says why.
    const keep = this.note
    this.#exhibition(
      { lapId: null, next: next && this.mode === 'exhibition' },
      keep ?? (this.roomsOff ? TV_NOTE.noRooms : null),
    )
  }
}
