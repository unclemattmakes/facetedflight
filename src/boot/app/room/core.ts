// src/boot/app/room/core.ts: a ROOM, live multiplayer, out of `bootApp`.
// APP-SPLIT phase 4, slice 3 (room; `docs/plan/APP-SPLIT.md` §5).
//
// DEV-388's core (the client, its open and close, the world built and torn for
// a room, the settings and the course list, the frame, the step and the
// render hooks, the probe) and DEV-391's bots, whole. The race's result, the
// lobby and watching a room follow it as their own modules (`room/results.ts`,
// `room/lobby.ts`, `room/watch.ts`); TV's camera stays in the closure with
// TV. Every line below was moved verbatim from the closure; the plumbing is
// `ctx.x` where the code reads a binding the closure still owns (a getter, and
// a setter where this code writes one: the §6 rule 3 bag), and the returned
// object.

import type * as THREE from 'three'
import type { World } from '@/boot/app/world/switch'
import { stats } from '@/boot/stats-beacon'
import type { Edition, EditionId } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { loadLevel } from '@/content/load-level'
import { loadPlayerCourse } from '@/content/load-player-course'
import { type PlayerCourse, playerCourseId } from '@/content/player-course'
import { courseLinkable, courseToken, readCourseToken } from '@/content/player-course-wire'
import type { LibraryEntry } from '@/game/course-library'
import type { EditionState } from '@/game/edition'
import type { Flight } from '@/game/flight'
import { cryptoRandomBytes, cryptoRandomInt, readHandle } from '@/game/lap-identity'
import type { FlownLap, LapRun } from '@/game/lap-run'
import { loadMissionIndex, type MissionCard } from '@/game/mission-index'
import { safeStorage } from '@/game/personal-best'
import { QUICK_RACE, quickRacePool } from '@/game/quick-race'
import { roomBotCallsigns } from '@/game/race-callsigns'
import { type RacerStart, roomStarts } from '@/game/racer-grid'
import type { LoadedRacers } from '@/game/racers'
import { createRemoteShips, type RemoteShips, roomPalette } from '@/game/remote-ships'
import {
  contentDigest,
  fillOwnPose,
  ROOM_PAGE_STORE,
  RoomClient,
  type RoomProbe,
  roomUrl,
} from '@/game/room-client'
import {
  courseName,
  ROOM_LISTED_DEFAULT,
  roomCountdownStep,
  roomWaitingText,
} from '@/game/room-lobby'
import type { CustomGround } from '@/game/terrain/custom-ground'
import type { WatchClient } from '@/game/watch-client'
import { toBase64url } from '@/net/base64url'
import { randomHandle } from '@/net/handles'
import { POSE_FLAG, poseRecord } from '@/net/pose-codec'
import { sharedTickAt } from '@/net/room-clock'
import {
  PLAYER_COURSE_MISSION,
  POSE_KIND,
  ROOM_MAX_COLOURS,
  type RoomRace,
  type RoomSettings,
  SEAT_SHAPE,
} from '@/net/room-protocol'
import type { RoomSession } from '@/net/room-session'
import { paintLivery, paletteColour } from '@/render/racer-livery'
import type { Renderer } from '@/render/renderer'
import type { RunSummary } from '@/render/results'
import type { UnityFog } from '@/render/unity-fog'
import { FIXED_DT } from '@/sim/constants'
import type { FixedStepClock } from '@/sim/integrator'
import type { LaunchState } from '@/sim/launch'
import { type LaunchSpec, startLaunch } from '@/sim/launch'
import CONTENT_MANIFEST from '../../../../content/_generated.sha256?raw'
import { flightVariantFor, MENU_EDITION, ROOM_AT_BOOT, WATCH_AT_BOOT } from '../pins'
import type { createRoomResults } from './results'
import type { createRoomWatch } from './watch'

/** What `createRoomCore` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface RoomCoreCtx {
  readonly applyAtmosphere: (m: THREE.Material<THREE.MaterialEventMap>) => void
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  autopilot: boolean
  readonly clock: FixedStepClock
  readonly editionState: EditionState
  readonly editionsLoaded: Map<'classic' | 'anniversary', Edition>
  readonly flight: Flight | null
  readonly fog: UnityFog
  readonly lapRun: LapRun | null
  readonly lastResult: RunSummary | null
  readonly launch: LaunchState
  readonly level: Level
  readonly liveRacers: LoadedRacers | null
  readonly lobbyProbe: () => {
    readonly heading: string
    readonly aim: number
    readonly rows: readonly {
      readonly id: string
      readonly label: string
      readonly value: string | null
      readonly note: string
    }[]
    readonly roster: readonly {
      readonly label: string
      readonly value: string | null
      readonly note: string
    }[]
  } | null
  readonly lobbyReady: (ready: boolean, colour?: number | undefined) => void
  readonly lobbyUp: () => boolean
  readonly paused: boolean
  readonly presetFor: (id: EditionId) => Promise<Edition>
  readonly render: Renderer
  readonly rideSpec: LaunchSpec | null
  readonly roomPostLap: (lap: FlownLap) => Promise<void>
  readonly roomResults: ReturnType<typeof createRoomResults>
  readonly roomRingsSent: boolean[]
  readonly roomStandingsNow: () =>
    | readonly {
        readonly name: string
        readonly you: boolean
        readonly status: string
        readonly seconds: number | null
        readonly place: number | null
      }[]
    | null
  readonly roomWatch: ReturnType<typeof createRoomWatch>
  readonly screen: 'title' | 'menu' | 'mission'
  readonly switchMission: (
    id: string,
    opts?: { readonly skipRide?: boolean; readonly inLoadingScene?: Level; readonly level?: Level },
  ) => Promise<void>
  readonly switching: boolean
  readonly world: Promise<World> | null
  /** DEV-851: YOUR COURSES, the library's entries (the owner's COURSE row offers the linkable ones). */
  readonly playerCourseEntries: () => readonly LibraryEntry[]
  /** DEV-851: a course's own ground (a seeded island's), as the shelf builds it. */
  readonly groundOfCourse: (course: PlayerCourse) => Promise<CustomGround | null>
}

/**
 * DEV-851: a player's course as this page races it, built from the room's
 * token: `level` to fly (on its own ground), `bare` to hash rules over (the
 * judge's level, `net/room-course.ts`), and its two-word name for the plates.
 */
interface RoomPlayerCourse {
  readonly course: PlayerCourse
  readonly level: Level
  readonly bare: Level
  readonly title: string
}

export const createRoomCore = (ctx: RoomCoreCtx) => {
  const { editionState, editionsLoaded, presetFor, render } = ctx
  // ── DEV-388: a ROOM — live multiplayer (plan/MULTIPLAYER.md) ─────────────
  //
  // `?room=<id>` joins the room of that id on this page's own origin (§6.2).
  // Everything a room does lives in `game/room-client.ts` (the socket and the
  // protocol), `game/remote-ships.ts` (the others, drawn) and `net/` (the
  // clock, the codec, the tracks); this block is the wiring, and the lines
  // that call it elsewhere are one each:
  //
  //   the world's build and teardown · the frame, before the fixed step · the
  //   fixed step, after the lap's own step · the frame, after the camera · the
  //   engine audio · `beginLaunch` (A does nothing in a room: the room starts
  //   the countdown, §6.3) · the opposition (no racers in a room until DEV-391)
  //   · `SKIP_RIDE` (no elevator in a room, Matt's call 2) · `__ff2.room()`.
  //
  // DEV-389: the LOBBY. A room is opened by the title's Race Friends row (a
  // fresh id, put in the address bar so the link is the room) or by booting
  // from a `?room=` link, and it waits in the hangar: two plates by the chair
  // (`render/room-lobby.ts`) with the seats, your colour, ready, the owner's
  // course and START, and the invite link. START boards everyone with no ride
  // (`switchMission`), onto their own start on the human row; the room's
  // countdown releases them together; the results panel's A (or the pause
  // plate's EXIT, which forfeits) comes back to the lobby, and the first
  // player there takes the settled room back for the next race (protocol 3).
  //
  // DEV-441: the MENU'S edition, which is also the edition a room races. Matt,
  // 2026-09-27: *"our menus should only ever be anniversary."* The title's rows
  // (and the room's settings: its rules, its grid's seats, its palette) read
  // Anniversary's own preset as this build ships it — a release build's is the
  // one with `PREVIEW_ONLY` off — and NEVER the live edition, which is the
  // player's choice once a course is boarded. On a title boot the live preset
  // IS Anniversary at this point (`MENU_EDITION`, DEV-405/451), so it is taken
  // at once; otherwise it is fetched, and a row that asks before it lands
  // reads "no rooms, no variants". The same object `presetFor` hands the
  // edition's own flips (DEV-451), so the menus and the flip hold one copy.
  let menuEdition: Edition | null = editionsLoaded.get(MENU_EDITION) ?? null
  const menuEditionLoad: Promise<Edition> = presetFor(MENU_EDITION)
  void menuEditionLoad.then(
    (e) => {
      menuEdition = e
    },
    (err: unknown) => console.warn(`menus: could not load the ${MENU_EDITION} preset`, err),
  )
  let roomId: string | null = ROOM_AT_BOOT
  /**
   * The room a LINK named, joined at boot (DEV-389), or null: Multiplayer's
   * JOIN ROOM (DEV-558), and the one closed room that stands no lobby.
   */
  const titleLinkRoom: string | null = roomId
  let room: RoomClient | null = null
  /**
   * DEV-436: this page WATCHES a room (`?watch=<id>`) rather than racing in one:
   * the broadcaster's stream, two seconds behind the race, drawn by the same
   * remote ships, with a director camera and no ship of its own.
   */
  const WATCH_ID = WATCH_AT_BOOT
  let watch: WatchClient | null = null
  /** The session the room's ships are drawn from: a player's, or a viewer's. */
  const roomSessionNow = (): RoomSession | null => room?.session ?? watch?.watch.session ?? null
  let roomShips: RemoteShips | null = null
  const roomRecord = [poseRecord()]
  /** A bot's record carries no stick: its hull's surfaces rest (DEV-391). */
  const ROOM_BOT_INPUT = { pitch: 0, roll: 0, yaw: 0, throttle: 1, flags: 0 }
  /** Own poses by tick, THREE world space, for the specs' drawn-vs-truth check. */
  const ROOM_TRUTH_TICKS = 1024
  const roomTruth = new Float64Array(ROOM_TRUTH_TICKS * 4).fill(Number.NaN)
  let roomLoadedSent = false
  let roomCountdownAt: number | null = null
  /** The room's time at this frame's timestamp, in a room; else null. What each fixed step reads. */
  let roomFrameRoom: number | null = null
  let roomGoRoom: number | null = null
  let roomConfigured = false
  /** DEV-389: this client has boarded the race the room is running. Reset in the lobby. */
  let roomBoarded = false
  /** DEV-389: this client has asked for the settled race to end (`again`). Reset in the lobby. */
  let roomAgainSent = false
  /** DEV-389: this client's ship stands on its start (§6.3; DEV-477's). Reset per world. */
  let roomStartPlaced = false
  /**
   * DEV-477: metres the lift holds this client's ship ABOVE the release, so it
   * stands at its own start's height: 2016's pads stand their racers at their
   * own decks' hover height, up to 1.7 m over the release (DEV-158). Added to
   * the ride's rise on every held step; 0 outside a room. Reset per world.
   */
  let roomHeldLift = 0
  /** DEV-389: this world's own hull wears the room colour. Reset per world. */
  let roomHullPainted = false
  /** DEV-389: the autopilot was switched on by a pause in a room, and goes off with it. */
  let roomAutopilotHolds = false
  /** A room's race is under way for this client: its GO is known. The sim never stops then. */
  const roomRaceLive = (): boolean => room !== null && room.session.goAt !== null
  const _roomAt = { x: 0, y: 0, z: 0 }
  const _roomStill = { x: 0, y: 0, z: 0 }
  /**
   * DEV-477: the course's starts for the race the room froze, or null outside
   * one. THREE space. Matt, 2026-09-27: *"1 player per start-point (players
   * instead of the ai racers)"* — single player's list, the pad first
   * (`game/racer-grid.ts`'s `roomStarts`), which the room hands out by index:
   * people on the first ones (`race.starts[slot]`), bots on the rest
   * (`race.bots[i].start`). Once per race AND course: a race is frozen in the
   * lobby, before this page has boarded its course, and a list read there is
   * the lobby's world's.
   */
  let roomStartsFor: { race: RoomRace; level: Level; starts: RacerStart[] } | null = null
  const roomStartList = (): RacerStart[] | null => {
    const race = roomSessionNow()?.race ?? null
    if (!race) return null
    if (roomStartsFor?.race !== race || roomStartsFor.level !== ctx.level) {
      const starts = roomStarts(ctx.level, editionState.current.gameplay.racers)
      roomStartsFor = { race, level: ctx.level, starts }
    }
    return roomStartsFor.starts
  }
  /** A slot's start, THREE space, or null. */
  const roomStartOf = (slot: number) => {
    const index = roomSessionNow()?.race?.starts[slot]
    return index === undefined ? null : (roomStartList()?.[index] ?? null)
  }
  const roomOwnStart = () => {
    const slot = room?.session.slot
    return slot === null || slot === undefined ? null : roomStartOf(slot)
  }
  // ── DEV-391: the room's bots (§6.6) ──────────────────────────────────
  //
  // The owner is the bot host: it flies every bot on its own fixed step as
  // single player flies its racers (`liveRacers`, built at the world's build),
  // with every other human's drawn pose in their traffic picture and no
  // contact, and sends their poses in its own pose message (kind 1). Everyone
  // else draws them from that stream (`game/remote-ships.ts`).
  /** This page flies the room's bots: it is the owner (§7.1, the room names it). */
  const roomBotHost = (): boolean =>
    room !== null && room.session.slot !== null && room.session.slot === room.session.owner
  let roomBotsFor: { list: RacerStart[]; starts: RacerStart[]; names: string[] } | null = null
  /**
   * The race's bots: each one's start on the room's start list, as the room
   * handed them out (`race.bots[i].start`, DEV-477: the starts no person took),
   * and its name, its callsign (DEV-651: drawn from the frozen race, as the
   * host's `loadRacers` draws them, so every client names a bot as its host
   * flies it; it was the tuning it flies). Once per start list (per race and course).
   */
  const roomBots = (): { starts: RacerStart[]; names: string[] } => {
    const race = roomSessionNow()?.race ?? null
    const list = roomStartList()
    if (!race || !list || race.bots.length === 0) return { starts: [], names: [] }
    if (roomBotsFor?.list === list) return roomBotsFor
    const starts = race.bots
      .map((b) => list[b.start])
      .filter((x): x is RacerStart => x !== undefined)
    // DEV-651: a bot's name is its callsign, drawn from the frozen race, so the
    // host's own boards and every other client's tags agree (`roomBotCallsigns`).
    roomBotsFor = { list, starts, names: roomBotCallsigns(race) }
    return roomBotsFor
  }
  /** Which bots the host has reported finished, by index. Reset per world. */
  const roomBotFinishSent: boolean[] = []
  /** The other humans where each is drawn, SIM space, for the bots' traffic picture. Reused. */
  const roomOthers: { x: number; y: number; z: number }[] = []
  const roomOthersNow = (): readonly { x: number; y: number; z: number }[] => {
    roomOthers.length = 0
    for (const d of roomShips?.drawn() ?? []) {
      if (d.slot >= 0 && d.drawn) roomOthers.push(d.position)
    }
    return roomOthers
  }

  /**
   * The pad's banner while a room holds the start (§6.3 beat 2), or null
   * outside a room: WAITING FOR PLAYERS n/m until the room releases the field,
   * then GET READY until the countdown starts it.
   */
  const roomWaitingLine = (): string | null => {
    const s = room?.session
    if (!s) return null
    return roomWaitingText(s.race, s.loadedSlots, s.goAt)
  }
  /**
   * DEV-477: the starts the race put a ship on — every person's and every
   * bot's — or none outside a race. The start grid draws the pads under them
   * by single player's own rule (`render/start-grid.ts`): the player's start
   * is the lift's dish, 2016's pads are the deck's own, and each slot or ghost
   * start stands on a copy of the pad under the release. So a person on a
   * racer's start gets the one pad that racer would have stood on, never a
   * second, and an empty start gets none. Only when the race is known as the
   * world is built, which the lobby's START makes the case (a room joined
   * mid-boot builds without).
   */
  const roomOccupiedStarts = (): RacerStart[] => {
    const race = roomSessionNow()?.race ?? null
    const list = roomStartList()
    if (!race || !list) return []
    const taken = new Set([...Object.values(race.starts), ...race.bots.map((b) => b.start)])
    return list.filter((_, k) => taken.has(k))
  }
  let roomCourses: Promise<typeof import('@/net/lap-courses') | null> | null = null
  const roomCoursesModule = () =>
    (roomCourses ??= import('@/net/lap-courses').catch((err: unknown) => {
      console.warn('room: the lap courses did not load; this build cannot join a room', err)
      return null
    }))
  /** This page is in a room: A does not launch, the pause cannot restart, no racers fly. */
  const roomActive = (): boolean => room !== null || watch !== null
  /** The launch countdown, ms: 3-2-1-GO is `steps + 1` beats (`sim/launch.ts`). */
  const roomCountdownMs = (): number =>
    ctx.rideSpec ? (ctx.rideSpec.countdownSteps + 1) * ctx.rideSpec.countdownStepSeconds * 1000 : 0
  /** The same, off a level that is not built yet: what the owner tells the room. */
  const roomCountdownMsOf = (lvl: Level): number =>
    lvl.spawn.launch
      ? ((lvl.timer.countdown?.steps ?? 0) + 1) * (lvl.timer.countdown?.stepSeconds ?? 0) * 1000
      : 0
  /**
   * The aircraft this player flies in a room: the one a flight built now would
   * be (DEV-382's precedence: a pin, the hangar's board, the last flown). The
   * room checks the rules against it; `buildWorld` resolves the same answer.
   */
  const roomVariant = (): string => flightVariantFor(QUICK_RACE.vehicle, editionState.current).id
  /**
   * DEV-459: this TAB's own token, sent on every join (`join.page`), so a page
   * the owner removed is kept out even when it comes back with no seat token.
   * Kept in `sessionStorage`, so it lasts the tab's reloads (the address bar
   * still names the room, and a reload is the first thing a removed player
   * tries) and no longer: a new tab is a new page. 128 random bits, and never
   * shown to another player: the room keeps it and says nothing of it.
   * DEV-542: made the first time this tab JOINS (`roomOpen`), not at the
   * load, so a player who never joins a room never has one (`/privacy` says
   * so; `rooms-off.spec.ts` checks the store is empty until HOST A RACE).
   */
  const ROOM_PAGE_KEY = ROOM_PAGE_STORE
  let roomPageMade: string | null = null
  const roomPageToken = (): string => {
    if (roomPageMade !== null) return roomPageMade
    try {
      const kept = globalThis.sessionStorage?.getItem(ROOM_PAGE_KEY) ?? null
      if (kept !== null && SEAT_SHAPE.test(kept)) {
        roomPageMade = kept
        return kept
      }
    } catch {
      // A tab that keeps nothing gets a token for this load only.
    }
    const made = toBase64url(cryptoRandomBytes(16))
    roomPageMade = made
    try {
      globalThis.sessionStorage?.setItem(ROOM_PAGE_KEY, made)
    } catch {
      // As above.
    }
    return made
  }
  /** The colour this browser last chose in a room (§6.9's "remembered colour"). */
  const ROOM_COLOUR_KEY = 'ff2.room.colour.v1'
  const rememberedRoomColour = (): number => {
    const v = Number(safeStorage()?.getItem(ROOM_COLOUR_KEY) ?? 0)
    return Number.isInteger(v) && v >= 0 && v < ROOM_MAX_COLOURS ? v : 0
  }

  /**
   * Join room `id`, now: the socket, the handshake, a seat. The lobby shows
   * whenever the hangar does. The address bar carries the room, so the page's
   * own link is the invitation and a reload rejoins it. DEV-441b: `existing`
   * for a code typed by hand — the room refuses it (4004) when nobody is in.
   */
  const roomOpen = (id: string, opts: { readonly existing?: boolean } = {}): void => {
    if (room) return
    roomId = id
    stats.count('roomsJoined')
    const url = new URL(globalThis.location.href)
    if (url.searchParams.get('room') !== id) {
      url.searchParams.set('room', id)
      history.replaceState(history.state, '', url)
    }
    room = new RoomClient({
      url: roomUrl(id, globalThis.location),
      identity: {
        handle: readHandle() ?? randomHandle(cryptoRandomInt),
        variant: roomVariant(),
        colour: rememberedRoomColour(),
        content: contentDigest(CONTENT_MANIFEST),
        ...(opts.existing === true ? { existing: true } : {}),
        page: roomPageToken(),
      },
      now: () => performance.now(),
      probe: (u) => fetch(u).then((r) => r.status),
      onStatus: (status, notice) => {
        document.body.dataset.room = status
        console.info(`room ${id}: ${status}${notice ? ` — ${notice}` : ''}`)
      },
    })
    room.connect()
  }

  /**
   * LEAVE: out of the room for good. A racer still in a race forfeits it first
   * (the room hears `left` now, not after the rejoin window), and the room's id
   * leaves the address bar with it, so a reload does not walk back in.
   */
  const roomClose = (): void => {
    if (!room) return
    if (room.session.roomPhase !== 'lobby') room.session.forfeit()
    room.leave()
    room = null
    roomShips?.dispose()
    roomShips = null
    roomId = null
    roomConfigured = false
    roomBoarded = false
    const url = new URL(globalThis.location.href)
    url.searchParams.delete('room')
    history.replaceState(history.state, '', url)
    document.body.dataset.room = 'left'
    console.info('room: left')
  }

  /** At a world's build: this course's remote ships, in a room. */
  const roomWorldBuilt = (_variant: string): void => {
    // DEV-477: a new world's ship is at the release until a room places it,
    // in a room or out of one.
    roomHeldLift = 0
    ctx.roomWatch.watchShipsDue = false // DEV-480
    const session = roomSessionNow()
    if (!session) return
    roomShips?.dispose()
    roomShips = createRemoteShips({
      worldOffset: ctx.level.worldOffset as [number, number, number],
      edition: editionState,
      session,
      now: () => performance.now(),
      dressed: (solid, trails) => {
        for (const m of solid) ctx.applyAtmosphere(m)
        for (const m of trails) ctx.fog.applyTo(m)
      },
      // DEV-389: the others stand on their starts until their GO (DEV-477's).
      startOf: roomStartOf,
      // DEV-391: and the bots on theirs, named by their tunings.
      botStartOf: (i) => roomBots().starts[i] ?? null,
      botName: (i) => roomBots().names[i] ?? `bot ${i + 1}`,
    })
    render.scene.add(roomShips.group)
    roomLoadedSent = false
    roomCountdownAt = null
    roomGoRoom = null
    roomTruth.fill(Number.NaN)
    ctx.roomRingsSent.length = 0
    ctx.roomResults.roomFinishSent = false
    ctx.roomResults.roomPostDue = false
    ctx.roomResults.roomPosted = null
    ctx.roomResults.roomMap = null
    roomStartPlaced = false
    roomHullPainted = false
    roomBotFinishSent.length = 0
  }

  const roomWorldTorn = (): void => {
    roomShips?.dispose()
    roomShips = null
  }

  /**
   * The courses a room races (§6.9): Quick Race's pool off the level index
   * (HoverJet Ring Attack, `game/quick-race.ts`), those the judge has a course
   * for. Read once; each card's title is what the COURSE row says.
   */
  let roomCourseList: Promise<readonly MissionCard[]> | null = null
  const roomCourseTitles = new Map<string, string>()
  const roomCourseCards = (): Promise<readonly MissionCard[]> =>
    (roomCourseList ??= Promise.all([loadMissionIndex(), roomCoursesModule()]).then(
      ([cards, courses]) => {
        const list = quickRacePool(cards).filter((c) => courses?.lapCourse(c.id) != null)
        for (const c of list) roomCourseTitles.set(c.id, courseName(c.title, c.vehicle))
        return list
      },
    ))

  // ── DEV-851: a PLAYER'S course in a room ──────────────────────────────────
  //
  // The room carries the course's link token (`RoomSettings.course`). Every
  // page builds the course from it, so a player who never had the course
  // races it all the same, and hashes its rules with the judge's own code
  // (`net/room-course.ts`): the owner to configure, everyone to ready.
  let roomCourseCode: Promise<typeof import('@/net/room-course') | null> | null = null
  const roomCourseModule = () =>
    (roomCourseCode ??= import('@/net/room-course').catch((err: unknown) => {
      console.warn('room: the player-course code did not load', err)
      return null
    }))
  const roomPlayerCourses = new Map<string, Promise<RoomPlayerCourse | null>>()
  /** The course a room's token names, built once a token; null when it is not `mission`. */
  const roomPlayerCourse = (token: string, mission: string): Promise<RoomPlayerCourse | null> => {
    const key = `${mission} ${token}`
    let built = roomPlayerCourses.get(key)
    if (!built) {
      built = (async () => {
        const [code, read] = await Promise.all([roomCourseModule(), readCourseToken(token)])
        if (!code || !read.ok || playerCourseId(read.course) !== mission) {
          console.warn(`room: the room's course is not ${mission}`)
          return null
        }
        const course = read.course
        const bare = code.playerCourseLevel(course, await loadLevel(course.sky))
        const level = await loadPlayerCourse(course, { ground: await ctx.groundOfCourse(course) })
        const title = course.name.join(' ')
        roomCourseTitles.set(mission, title)
        return { course, level, bare, title }
      })().catch((err: unknown) => {
        console.warn(`room: could not build the room's course ${mission}`, err)
        return null
      })
      roomPlayerCourses.set(key, built)
    }
    return built
  }
  /** The player courses an owner may offer: YOUR COURSES that fit in a link. */
  /**
   * DEV-887: the editor's saved drafts that are whole courses. The library
   * holds a course only after SAVE FILE or COPY LINK, so a creator who built
   * one and went straight to a room found only the shipped courses in the
   * COURSE row (playtest 2026-10-09). A draft that validates is offered too.
   */
  let roomDraftEntries: LibraryEntry[] = []
  const roomPlayerCourseEntries = (): LibraryEntry[] => {
    const kept = ctx.playerCourseEntries()
    const have = new Set(kept.map((e) => e.id))
    return [...kept, ...roomDraftEntries.filter((e) => !have.has(e.id))].filter((e) =>
      courseLinkable(e.course),
    )
  }
  const readRoomDrafts = async (): Promise<void> => {
    try {
      const [drafts, storage] = await Promise.all([
        import('@/editor/core/drafts'),
        import('@/game/storage'),
      ])
      const ls = storage.safeLocalStorage()
      const out: LibraryEntry[] = []
      for (const summary of drafts.listDrafts(ls)) {
        const course = drafts.loadDraft(ls, summary.slot)?.course
        if (!course || !courseLinkable(course)) continue
        // Only a draft the judge's own reader accepts: a half-built one would
        // stick the row on a course that cannot be configured.
        const read = await readCourseToken(await courseToken(course)).catch(() => null)
        if (!read?.ok) continue
        out.push({
          id: playerCourseId(course),
          course,
          name: course.name.join(' '),
          island: course.island,
          date: summary.updated,
          source: 'made-here',
        })
      }
      roomDraftEntries = out
    } catch (err: unknown) {
      console.warn('room: the editor drafts could not be read', err)
    }
  }
  /** Every course the COURSE row cycles: the shipped pool, then YOUR COURSES. */
  const roomCourseIds = async (): Promise<string[]> => {
    await readRoomDrafts()
    const shipped = (await roomCourseCards()).map((c) => c.id)
    const mine = roomPlayerCourseEntries()
    for (const e of mine) roomCourseTitles.set(e.id, e.name)
    return [...shipped, ...mine.map((e) => e.id)]
  }
  /** DEV-851: the rules a lap on THIS room's player course carries, or null for any other course. */
  const roomLapRules = (mission: string, edition: string, variant: string): string | null => {
    const s = room?.session.settings
    if (!s || s.course === undefined || s.mission !== mission || s.edition !== edition) return null
    return s.rules[variant] ?? null
  }
  /** DEV-851: this page's own rules for the room's course and `variant`, to ready with. */
  const roomRulesFor = async (settings: RoomSettings, variant: string): Promise<string | null> => {
    if (settings.course === undefined) {
      const courses = await roomCoursesModule()
      return courses?.lapRules(settings.mission, settings.edition, variant) ?? null
    }
    const [code, built] = await Promise.all([
      roomCourseModule(),
      roomPlayerCourse(settings.course, settings.mission),
    ])
    return (built && code?.playerRoomRules(built.bare, settings.edition)?.[variant]) ?? null
  }
  /** DEV-851: the level a room's race flies, when this page must build it from the token. */
  const roomRaceLevel = (settings: RoomSettings | null): Promise<Level | null> =>
    settings?.course === undefined
      ? Promise.resolve(null)
      : roomPlayerCourse(settings.course, settings.mission).then((c) => c?.level ?? null)

  /** The owner's settings for a player course from YOUR COURSES. */
  const roomPlayerSettingsFor = async (id: string, bots: boolean): Promise<RoomSettings | null> => {
    const entry = roomPlayerCourseEntries().find((e) => e.id === id)
    if (entry) return roomPlayerSettingsOf(entry.course, bots)
    // The room's own course, for an owner who never had it (one handed the
    // room, or a BOTS or PUBLIC press on a course from a link): its token.
    const s = room?.session.settings
    if (s?.course === undefined || s.mission !== id) return null
    const read = await readCourseToken(s.course)
    return read.ok ? roomPlayerSettingsOf(read.course, bots) : null
  }
  /** The same from the course itself; null for one a link cannot carry. */
  const roomPlayerSettingsOf = async (
    course: PlayerCourse,
    bots: boolean,
  ): Promise<RoomSettings | null> => {
    if (!courseLinkable(course)) return null
    const id = playerCourseId(course)
    const races = await (menuEdition ?? menuEditionLoad)
    const token = await courseToken(course)
    const [code, built] = await Promise.all([roomCourseModule(), roomPlayerCourse(token, id)])
    const rules = built && code?.playerRoomRules(built.bare, races.id)
    if (!built || !rules) return null
    return {
      mission: id,
      edition: races.id,
      bots,
      seats: roomStarts(built.bare, races.gameplay.racers).length,
      colours: roomPalette(races.render.racerLivery).length,
      countdown: roomCountdownMsOf(built.bare),
      timeLimit: Math.round(built.bare.timer.timeLimit * 1000),
      rules,
      course: token,
    }
  }

  /** The owner's settings for course `id`, read off its level whether or not it is built. */
  const roomSettingsFor = async (id: string, bots = true): Promise<RoomSettings | null> => {
    if (PLAYER_COURSE_MISSION.test(id)) return roomPlayerSettingsFor(id, bots)
    const [courses, lvl, races] = await Promise.all([
      roomCoursesModule(),
      id === ctx.level.id ? ctx.level : loadLevel(id),
      // DEV-441: a room races Anniversary, whatever this page wears (the menu's edition).
      menuEdition ?? menuEditionLoad,
    ])
    const edition = races.id
    const variants = courses?.lapCourse(id)?.editions[edition]?.variants
    if (!courses || !variants) return null
    const rules: Record<string, string> = {}
    for (const [v, r] of Object.entries(variants)) rules[v] = r.rules
    return {
      mission: id,
      edition,
      // DEV-391: Fill empty starts with bots — on unless the owner says (§6.6).
      bots,
      // The course's starts (§6.3, DEV-477): the player's pad and the racers'
      // own, one ship each — so a room can never hold more than it can stand.
      seats: roomStarts(lvl, races.gameplay.racers).length,
      colours: roomPalette(races.render.racerLivery).length,
      countdown: roomCountdownMsOf(lvl),
      // DEV-390: the course's own clock, which DNFs a racer still out when it runs.
      timeLimit: Math.round(lvl.timer.timeLimit * 1000),
      rules,
    }
  }

  /** The owner's course, to the room. The room un-readies everyone when it changes. */
  const roomConfigure = (
    id: string,
    bots = room?.session.settings?.bots ?? true,
    // DEV-633: PUBLIC or PRIVATE, kept across a course change; a new room's is the default.
    listed = room?.session.settings?.listed ?? ROOM_LISTED_DEFAULT,
  ): void => {
    const s = room?.session
    if (!s) return
    void roomSettingsFor(id, bots).then(
      (settings) => {
        if (!settings) console.warn(`room: ${id} is not a room course on this edition`)
        else if (room?.session === s) s.configure({ ...settings, listed })
      },
      (err: unknown) => console.warn(`room: could not read ${id}`, err),
    )
  }

  /** Every frame, before the fixed step: the clock, the owner's settings, `loaded`, the countdown. */
  const roomFrame = (time: number): void => {
    if (!room) return
    room.update()
    const s = room.session
    roomShips?.sync()
    // DEV-389, §11 call 6: A ROOM CANNOT PAUSE. The pause plate still opens (and
    // the SteamVR dashboard still forces it), but the race goes on: the fixed
    // step keeps running (`roomRaceLive` in the step's wall time) and the
    // autopilot holds the ship until you are back, which taints the lap as
    // assisted, exactly as a press of P would. Handed back on the way out.
    const hold = roomRaceLive() && ctx.screen === 'mission' && ctx.flight !== null && ctx.paused
    if (hold && !ctx.autopilot) {
      ctx.autopilot = true
      roomAutopilotHolds = true
      console.info('room: the autopilot holds your ship while the race goes on')
    } else if (!hold && roomAutopilotHolds) {
      ctx.autopilot = false
      roomAutopilotHolds = false
      console.info('room: your ship is yours again')
    }
    // The owner's first course: the one this page is on if the room races it,
    // else the pool's first. The COURSE row moves it on from there.
    if (s.slot !== null && s.slot === s.owner && s.settings === null && !roomConfigured) {
      roomConfigured = true
      void roomCourseCards().then((list) => {
        const id = list.some((c) => c.id === ctx.level.id) ? ctx.level.id : list[0]?.id
        if (id !== undefined) roomConfigure(id)
      })
    }
    // START (§6.3 beat 1): the room froze a race with this player on a start.
    // Board it with no ride — unless this page already stands on that course's
    // pad (a `?mission=` boot, the harness's own route), where boarding again
    // would only rebuild the world it is on.
    if (s.roomPhase === 'lobby') {
      roomBoarded = false
      roomAgainSent = false
    } else if (
      !roomBoarded &&
      s.race !== null &&
      s.slot !== null &&
      s.race.starts[s.slot] !== undefined
    ) {
      roomBoarded = true
      const onIt =
        ctx.screen === 'mission' &&
        ctx.world !== null &&
        !ctx.switching &&
        ctx.level.id === s.race.mission &&
        ctx.launch.phase === 'waiting' &&
        ctx.lastResult === null &&
        // DEV-391: a host whose world was built before the race has no bots.
        (s.race.bots.length === 0 || !roomBotHost() || ctx.liveRacers !== null)
      console.info(`room: boarding ${s.race.mission}${onIt ? ' (already on its pad)' : ''}`)
      // DEV-851: a player's course is built from the room's token, so a racer
      // who never had it boards it all the same.
      const mission = s.race.mission
      if (!onIt && PLAYER_COURSE_MISSION.test(mission)) {
        void roomRaceLevel(s.settings).then((level) => {
          if (level) void ctx.switchMission(mission, { skipRide: true, level })
          else console.warn(`room: cannot build ${mission}; staying in the lobby`)
        })
      } else if (!onIt) void ctx.switchMission(mission, { skipRide: true })
    }
    // After the race (protocol 3): once this player is back in the lobby and
    // every racer has a verdict, the room goes back too, for the next race.
    if (ctx.lobbyUp() && s.settled && s.roomPhase !== 'lobby' && !roomAgainSent) {
      roomAgainSent = true
      s.again()
      console.info('room: the race is settled; back to the lobby')
    }
    // DEV-389: your own hull in your colour (§6.4), once a world, once the race
    // has frozen the colours. Once, because `paintLivery` recolours what READS
    // as the orange livery and a painted hull no longer does; a new race is a
    // new world (the lobby's START boards afresh), so once is enough.
    if (!roomHullPainted && s.race !== null && s.slot !== null && ctx.flight !== null) {
      roomHullPainted = true
      const colour = s.race.colours[s.slot] ?? 0
      const hull = ctx.flight.object.getObjectByName('ship_third_person')
      if (hull && colour !== 0) {
        const pal = roomPalette(editionState.current.render.racerLivery)
        const painted = paintLivery(hull, paletteColour(pal, colour))
        console.info(`room: your hull in colour ${colour} (${painted} vertices)`)
      }
    }
    // DEV-477: onto this player's own start (§6.3) — the racers' own starts,
    // one each, Matt's *"1 player per start-point"* — once the race says which
    // and before anything is sent: the lap's tick 0 is recorded wherever the
    // ship stands at the release, and the judge accepts exactly this start for
    // this seat and no other (`net/room-lap.ts`'s `roomSeatStart`). Its HEIGHT
    // too: 2016's pads hold their racers at their own decks' hover height, and
    // the lift holds this ship there until GO (`roomHeldLift`, on the step).
    if (
      !roomStartPlaced &&
      s.race !== null &&
      s.slot !== null &&
      ctx.flight !== null &&
      ctx.launch.phase === 'waiting'
    ) {
      const start = roomOwnStart()
      if (start) {
        const b = ctx.flight.jet.body
        const spawn = ctx.level.spawn.pos as number[]
        roomHeldLift = start.pos[1] - ((spawn[1] as number) + (ctx.level.spawn.launch?.rise ?? 0))
        _roomAt.x = start.pos[0]
        _roomAt.y = start.pos[1]
        _roomAt.z = -start.pos[2]
        _roomStill.x = 0
        _roomStill.y = 0
        _roomStill.z = 0
        ctx.flight.placeAt(_roomAt, b.orientation, _roomStill)
      }
      roomStartPlaced = true
    }
    // Beat 2 (§6.3): on the start, course built, every known hull loaded.
    if (
      !roomLoadedSent &&
      roomStartPlaced &&
      s.race !== null &&
      ctx.screen === 'mission' &&
      ctx.flight !== null &&
      ctx.launch.phase === 'waiting' &&
      roomShips?.ready === true
    ) {
      roomLoadedSent = true
      s.loaded()
    }
    // Beat 3: one countdown, released at `goAt`, whatever this machine's clock
    // says. Started by the fixed STEP it stands for (`roomStepCountdown`), not
    // by this frame: the room's time at the frame's own timestamp is all this
    // frame hands the steps — `time`, not `performance.now()` here, because the
    // stepper's wall time is the frame timestamps', and this line runs some
    // milliseconds into the frame.
    roomFrameRoom = s.roomNow(time)
    // DEV-390: the lap to the judge, once, the frame after the step that crossed.
    if (ctx.roomResults.roomPostDue && ctx.lapRun?.last) {
      ctx.roomResults.roomPostDue = false
      void ctx.roomPostLap(ctx.lapRun.last)
    }
  }

  /**
   * Beat 3 (§6.3), on each fixed step while the ship waits: the room's countdown
   * starts on the step whose room time reaches `goAt − countdown`, carrying
   * the part of the step past it, so the release is the first step at or past
   * the room's GO (`game/room-lobby.ts`'s `roomCountdownStep`). The step's room
   * time is the frame's less what the stepper has not spent yet.
   */
  const roomStepCountdown = (dt: number): void => {
    const s = room?.session
    if (!s || s.goAt === null || roomFrameRoom === null || roomCountdownAt !== null) return
    if (!s.clock.synced) return
    if (ctx.launch.phase !== 'waiting') return
    const stepRoom = roomFrameRoom - ctx.clock.accumulator * 1000
    const elapsed = roomCountdownStep(stepRoom, s.goAt, roomCountdownMs(), dt)
    if (elapsed === null) return
    startLaunch(ctx.launch, ctx.rideSpec)
    ctx.launch.countdownElapsed = elapsed
    roomCountdownAt = stepRoom
    console.info(
      `room: countdown from room ${(s.goAt - roomCountdownMs()).toFixed(0)} ms, on the step at ${stepRoom.toFixed(1)}`,
    )
  }

  /** Every fixed step, after the lap's own: this player's pose, one message in four. */
  const roomStep = (
    body: {
      position: { x: number; y: number; z: number }
      orientation: { x: number; y: number; z: number; w: number }
      velocity: { x: number; y: number; z: number }
    },
    stick: { pitch: number; roll: number; yaw: number; throttle: number; boost: boolean },
    held: boolean,
    finished: boolean,
    passed: readonly boolean[],
  ): void => {
    if (!room || !ctx.lapRun || ctx.lapRun.tick < 0) return
    // The lap's clock, which runs on past the finish: the stream does too.
    const tick = Math.round(ctx.lapRun.clock / FIXED_DT)
    // The room time this client's lap clock started at: this step's room time
    // (the frame's, less what the stepper has not spent) less the lap clock.
    // Once, on the first step after the release. For the specs and the log.
    if (roomGoRoom === null && roomFrameRoom !== null) {
      roomGoRoom = roomFrameRoom - ctx.clock.accumulator * 1000 - ctx.lapRun.clock * 1000
    }
    // DEV-390: this race's rings and its crossing, as events, once each, on the
    // step they happened (the others' live place, §7.1). Not a result: the
    // result is the judged lap (§6.5), posted from `roomFrame`.
    if (!ctx.roomResults.roomFinishSent) {
      for (let g = 0; g < passed.length; g++) {
        if (passed[g] && !ctx.roomRingsSent[g]) {
          ctx.roomRingsSent[g] = true
          room.session.ring(g, tick)
        }
      }
      if (finished) {
        ctx.roomResults.roomFinishSent = true
        ctx.roomResults.roomPostDue = true
        room.session.finish(tick)
      }
    }
    const o = ctx.level.worldOffset as [number, number, number]
    fillOwnPose(roomRecord[0] as (typeof roomRecord)[number], body, o, {
      pitch: stick.pitch,
      roll: stick.roll,
      yaw: stick.yaw,
      throttle: stick.throttle,
      flags:
        (stick.boost ? POSE_FLAG.boost : 0) |
        (held ? POSE_FLAG.crashHeld : 0) |
        (finished ? POSE_FLAG.finished : 0),
    })
    // The truth is the SIM body flipped to THREE world by the one flip every
    // mesh uses, NOT read back off the record just filled: a check whose truth
    // came through `fillOwnPose` could not see a bug in it (trap 24).
    const at = (tick % ROOM_TRUTH_TICKS) * 4
    roomTruth[at] = tick
    roomTruth[at + 1] = body.position.x
    roomTruth[at + 2] = body.position.y
    roomTruth[at + 3] = -body.position.z
    // DEV-391: the bot host's bots, in the same message (kind 1, §7.2), and
    // each one's finish once, timed by the host's own GO. Not judged (§6.6).
    let count = 1
    if (ctx.liveRacers && roomBotHost()) {
      const racers = ctx.liveRacers.racers
      for (let i = 0; i < racers.length; i++) {
        const racer = racers[i] as (typeof racers)[number]
        const record = roomRecord[count] ?? poseRecord()
        roomRecord[count] = record
        fillOwnPose(record, racer.jet.body, o, ROOM_BOT_INPUT)
        record.kind = POSE_KIND.bot
        record.index = i
        count++
        if (racer.finished && !roomBotFinishSent[i]) {
          roomBotFinishSent[i] = true
          room.session.finish(Math.round(racer.finishedAt / FIXED_DT), i)
        }
      }
    }
    room.sendPose(tick, roomRecord, count)
  }

  /**
   * Every frame, BEFORE any camera (DEV-612): place the others at room time.
   * TV's camera and `?watch=`'s follow a ship's drawn root; placed after them,
   * as `roomRender` used to, the camera sat on the pose the previous frame drew.
   */
  const roomPlace = (): void => {
    const session = roomSessionNow()
    if (!session || !roomShips) return
    roomShips.update(session.roomNow(performance.now()))
  }

  /** Every frame, after the camera: the others' trails and tags, from the poses `roomPlace` set. */
  const roomRender = (eye: THREE.Vector3, dt: number, wingDt: number): void => {
    if (!roomSessionNow() || !roomShips) return
    roomShips.renderTrails(eye, dt, wingDt)
  }

  /** This client's own pose at fractional `tick`, world THREE space, or null if it is not held. */
  const roomTruthAt = (tick: number): [number, number, number] | null => {
    const k = Math.floor(tick)
    const a = (k % ROOM_TRUTH_TICKS) * 4
    const b = ((k + 1) % ROOM_TRUTH_TICKS) * 4
    if (roomTruth[a] !== k || roomTruth[b] !== k + 1) return null
    const f = tick - k
    const lerp = (i: number) =>
      (roomTruth[a + i] as number) +
      ((roomTruth[b + i] as number) - (roomTruth[a + i] as number)) * f
    return [lerp(1), lerp(2), lerp(3)]
  }

  const roomProbe = (): RoomProbe | null => {
    if (!room) return null
    const s = room.session
    const local = performance.now()
    const roomNow = s.clock.synced ? s.roomNow(local) : null
    return {
      id: roomId as string,
      status: room.status,
      notice: room.notice,
      connects: room.connects,
      slot: s.slot,
      owner: s.owner,
      phase: s.roomPhase,
      players: { ...s.players },
      settings: s.settings,
      goAt: s.goAt,
      field: s.field,
      clock: { synced: s.clock.synced, offset: s.clock.offset, rtt: s.clock.rtt },
      roomNow,
      sharedTick: roomNow !== null && s.goAt !== null ? sharedTickAt(roomNow, s.goAt) : null,
      tick: ctx.lapRun && ctx.lapRun.tick >= 0 ? ctx.lapRun.clock / FIXED_DT : null,
      countdownAt: roomCountdownAt,
      goRoom: roomGoRoom,
      ships: roomShips?.report() ?? [],
      stats: roomShips?.stats() ?? null,
      resetStats: () => roomShips?.resetStats(),
      truth: roomTruthAt,
      ownStart: roomOwnStart()?.pos ?? null,
      ownAt: ctx.flight
        ? [
            ctx.flight.jet.body.position.x,
            ctx.flight.jet.body.position.y,
            -ctx.flight.jet.body.position.z,
          ]
        : null,
      // The lobby's own READY and START, for a spec that does not drive the plates.
      ready: () => ctx.lobbyReady(true),
      start: () => s.start(),
      bots: (on: boolean) => {
        if (s.slot === s.owner && s.settings) roomConfigure(s.settings.mission, on)
      },
      course: (token: string) => {
        if (s.slot !== s.owner) return
        void readCourseToken(token).then(async (read) => {
          const settings = read.ok
            ? await roomPlayerSettingsOf(read.course, s.settings?.bots ?? true)
            : null
          if (!settings) console.warn('room: that link is not a course this room can race')
          else if (room?.session === s)
            s.configure({ ...settings, listed: s.settings?.listed ?? ROOM_LISTED_DEFAULT })
        })
      },
      lobby: ctx.lobbyProbe(),
      results: s.results,
      botFinishes: s.bots,
      posted: ctx.roomResults.roomPosted,
      rings: s.ringTicks,
      standings: ctx.roomStandingsNow(),
    }
  }
  return {
    roomBots,
    ROOM_COLOUR_KEY,
    roomClose,
    roomConfigure,
    roomCourseCards,
    roomCourseIds,
    roomCourseTitles,
    roomCoursesModule,
    roomLapRules,
    roomPlayerCourse,
    roomRaceLevel,
    roomRulesFor,
    roomOpen,
    roomVariant,
    titleLinkRoom,
    roomWorldBuilt,
    menuEditionLoad,
    WATCH_ID,
    roomActive,
    roomOccupiedStarts,
    roomBotHost,
    roomWorldTorn,
    roomWaitingLine,
    roomRaceLive,
    roomFrame,
    roomStepCountdown,
    roomOthersNow,
    roomStep,
    roomPlace,
    roomRender,
    roomProbe,
    get room() {
      return room
    },
    get roomShips() {
      return roomShips
    },
    set roomShips(v: RemoteShips | null) {
      roomShips = v
    },
    get roomId() {
      return roomId
    },
    set roomId(v: string | null) {
      roomId = v
    },
    get watch() {
      return watch
    },
    set watch(v: WatchClient | null) {
      watch = v
    },
    get menuEdition() {
      return menuEdition
    },
    get roomHeldLift() {
      return roomHeldLift
    },
  }
}
