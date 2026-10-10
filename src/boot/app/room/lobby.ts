// src/boot/app/room/lobby.ts: a room's lobby, by the chair, out of `bootApp`.
// APP-SPLIT phase 4, slice 3 (room; `docs/plan/APP-SPLIT.md` §5).
//
// DEV-389's block, whole: the roster and the actions plates, their aim and
// presses, the invite link and the open rooms' poll, ready and start, and the
// doors that open, join or leave a room. Every line below was moved verbatim
// from the closure; the plumbing is `ctx.x` where the code reads a binding the
// closure still owns (a getter, and a setter where this code writes one: the
// §6 rule 3 bag), and the returned object.

import type * as THREE from 'three'
import type { Capabilities } from '@/boot/capability-gate'
import { sendRoomLink } from '@/boot/room-share'
import type { EditionState } from '@/game/edition'
import { cryptoRandomBytes } from '@/game/lap-identity'
import type { MissionCard } from '@/game/mission-index'
import { safeStorage } from '@/game/personal-best'
import { roomPalette } from '@/game/remote-ships'
import { isRoomCode, newRoomCode, type RoomClient, type RoomProbe } from '@/game/room-client'
import {
  colourName,
  kickSlotOf,
  LOBBY_ACTION,
  LOBBY_KICK_HEADING,
  type LobbyInput,
  lobbyActionRows,
  lobbyEveryoneReady,
  lobbyHeading,
  lobbyKickOffered,
  lobbyKickRows,
  lobbyRosterFooter,
  lobbyRosterHeading,
  lobbyRosterRows,
  lobbyRosterSelected,
  lobbyStartPress,
  nextFreeColour,
  takenColours,
} from '@/game/room-lobby'
import { pressWatchMe, type WatchMeMade, watchMeNow } from '@/game/tv/watch-me'
import { createRowStepper } from '@/input/menu-step'
import type { PointerHand } from '@/input/pointer-hand'
import type { RoomSettings } from '@/net/room-protocol'
import type { ControlsDevice } from '@/render/controls-menu'
import type { OpenRoomDoor } from '@/render/hangar-doors'
import type { LoadingScene } from '@/render/loading-scene'
import { createPause, type Pause, type PauseOption } from '@/render/pause'
import type { Renderer } from '@/render/renderer'
import { LOBBY_BEARING_DEG, placeLobbyPlate } from '@/render/room-lobby'
import type { XrPointer } from '@/render/xr-pointer'
import { planeHitDistance } from '@/render/xr-pointer'
import type { createLetterPlate } from '../hangar/letter-plate'
import { cameraWorld, gazeDirection } from '../head-scratch'
import type { createLoadingHost } from '../world/loading'

/** What `createRoomLobby` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface RoomLobbyCtx {
  readonly ROOM_COLOUR_KEY: string
  readonly _aimDirection: THREE.Vector3
  readonly _aimOrigin: THREE.Vector3
  readonly capabilities: Capabilities
  readonly confirmDevice: () => ControlsDevice
  readonly editionState: EditionState
  readonly goToScreen: (
    to: 'menu' | 'mission' | 'title',
    opts?: {
      readonly outSeconds?: number
      readonly inSeconds?: number
      readonly holdSeconds?: number
      readonly act?: () => void
    },
  ) => void
  readonly letterPlate: ReturnType<typeof createLetterPlate>
  readonly loadingHost: ReturnType<typeof createLoadingHost>
  readonly loadingScene: LoadingScene
  readonly menuScene: THREE.Scene<THREE.Object3DEventMap>
  readonly render: Renderer
  readonly room: RoomClient | null
  readonly roomClose: () => void
  readonly roomConfigure: (id: string, bots?: boolean, listed?: boolean) => void
  readonly roomCourseCards: () => Promise<readonly MissionCard[]>
  /** DEV-851: the COURSE row's cycle, the shipped pool then YOUR COURSES. */
  readonly roomCourseIds: () => Promise<string[]>
  readonly roomCourseTitles: Map<string, string>
  readonly roomCoursesModule: () => Promise<typeof import('@/net/lap-courses') | null>
  /** DEV-851: the room's player course, built from its token (and its title with it). */
  readonly roomPlayerCourse: (token: string, mission: string) => Promise<unknown>
  /** DEV-851: this page's own rules for the room's course, shipped or a player's. */
  readonly roomRulesFor: (settings: RoomSettings, variant: string) => Promise<string | null>
  readonly roomId: string | null
  readonly roomOpen: (id: string, opts?: { readonly existing?: boolean }) => void
  readonly roomVariant: () => string
  readonly screen: 'title' | 'menu' | 'mission'
  readonly seatQuaternion: THREE.Quaternion
  readonly seatWorld: THREE.Vector3
  readonly switching: boolean
  readonly titleLinkRoom: string | null
  readonly tvOn: () => boolean
  readonly xrPointer: XrPointer
}

export const createRoomLobby = (ctx: RoomLobbyCtx) => {
  // ── DEV-389: the lobby, by the chair (plan/MULTIPLAYER.md §6.9) ─────────
  //
  // Two pause plates standing in the hangar (`render/room-lobby.ts` says where
  // and why): the roster, read; the actions, aimed and pressed exactly as the
  // title's rows are — the head or a hand's laser picks a row while it is ON a
  // row, the stick and the arrow keys step it, and the confirm every device
  // already rides presses it. While the lobby is up the holotables are inert:
  // the room decides the course, so a press never boards a table's.
  let lobbyRoster: Pause | null = null
  let lobbyPlate: Pause | null = null
  /** Which of the action plate's rows a press takes. */
  let lobbyAim = 0
  /** One row per push on the lobby's rows (`input/menu-step.ts`). */
  const lobbySteps = createRowStepper()
  /** When the invite link was last copied, ms: the row says so for a moment. */
  let lobbyCopiedAt = Number.NEGATIVE_INFINITY
  let lobbyWatchCopiedAt = Number.NEGATIVE_INFINITY
  /**
   * DEV-633: the public rooms as last read, or null while unknown (not asked,
   * or no rooms here). Up here, not beside `openRoomsFrame`, because the
   * hangar's `doorInput` reads it when the hangar is built.
   */
  let openRooms: readonly OpenRoomDoor[] | null = null
  let openRoomsKey = ''
  let openRoomsAskedAt = Number.NEGATIVE_INFINITY
  let openRoomsAsking = false
  const OPEN_ROOMS_POLL_MS = 5000
  /** DEV-632: when a phone's share sheet last took the link, ms. */
  let lobbySharedAt = Number.NEGATIVE_INFINITY
  const LOBBY_COPIED_MS = 4000
  /** The room's invite link: the room and nothing else, none of this page's own switches. */
  const roomInviteLink = (): string =>
    `${globalThis.location.origin}${globalThis.location.pathname}?room=${ctx.roomId}`
  /**
   * DEV-632: what the invite row's press does here: a phone or a tablet (a touchscreen
   * is the primary pointer, `capabilities.touch`) SHARES, a computer COPIES, a
   * headset keeps INVITE (the code is what it reads aloud). The device CLASS, not
   * the last input: a key pressed on a phone does not take its share sheet away.
   */
  const lobbyInviteMode = (): 'share' | 'copy' | undefined => {
    if (ctx.render.renderer.xr.isPresenting) return undefined
    return ctx.capabilities.touch ? 'share' : 'copy'
  }
  /** The rows as last drawn: the press switches on these, the probe reports them. */
  let lobbyRows: readonly PauseOption[] = []
  let lobbyRosterDrawn: readonly PauseOption[] = []
  let lobbyHeadingDrawn = ''
  /**
   * DEV-459: the action plate's page — the room's rows, or the owner's REMOVE
   * A PLAYER page — and the player that page's next press would remove (the
   * first press arms, the second removes; moving off the row disarms).
   */
  let lobbyPage: 'room' | 'kick' = 'room'
  let lobbyKickArmed: number | null = null
  /**
   * DEV-587: when the owner's START pressed READY on its way (ms), or null.
   * `lobbyFrame` sends START once the room says this player is ready, and
   * gives up after `LOBBY_START_AFTER_READY_MS` (the room refused the ready,
   * or another player stood down meanwhile), so a later READY never starts a
   * race by itself.
   */
  let lobbyStartAfterReady: number | null = null
  const LOBBY_START_AFTER_READY_MS = 5000
  /** DEV-634: half of START's pulse, ms. */
  const LOBBY_PULSE_MS = 450
  /** DEV-634: was everyone ready last frame? The edge puts the aim on START, once. */
  let lobbyAllReadyWas = false

  /**
   * Is the lobby up? In the hangar, in a room, and not on the way to a course —
   * including the fade to the pad, while the loading plate still stands in the
   * room (DEV-465).
   */
  const lobbyUp = (): boolean =>
    ctx.screen === 'menu' &&
    ctx.room !== null &&
    !ctx.switching &&
    ctx.loadingHost.loadingTarget === null &&
    !ctx.loadingScene.shown &&
    // DEV-558: not while the letter plate asks a room for a seat: the lobby
    // stands once the join has seated this page and the plate has gone.
    !ctx.letterPlate.codeOpen &&
    // DEV-558: nor for the LINK's room (`?room=`, joined at boot) when it
    // closed before it ever seated this page (gone, or a site with no rooms):
    // START goes to the hangar under it now, the player asked for nothing yet,
    // and START and the MULTIPLAYER table say why (`titleRoomNotice`), so the
    // doors stay live. A room the player OPENED (HOST A RACE) still stands its
    // closed lobby, whose LEAVE is the way back (DEV-470).
    !(
      ctx.room.status === 'closed' &&
      ctx.room.session.slot === null &&
      ctx.roomId === ctx.titleLinkRoom
    )

  /** Why this page cannot be ready for the room's course, or null when it can. */
  const lobbyCannotRace = (settings: RoomSettings | null): string | null => {
    if (!settings) return 'waiting for the owner to choose a course'
    if (settings.edition !== ctx.editionState.rules.id) {
      return `this room races the ${settings.edition} edition`
    }
    const variant = ctx.roomVariant()
    return settings.rules[variant] === undefined ? `your ${variant} jet cannot race here` : null
  }

  const lobbyInput = (): LobbyInput | null => {
    if (!ctx.room) return null
    const s = ctx.room.session
    // DEV-851: a player's course is named once its token is built.
    if (s.settings?.course !== undefined && !ctx.roomCourseTitles.has(s.settings.mission)) {
      void ctx.roomPlayerCourse(s.settings.course, s.settings.mission)
    }
    return {
      status: ctx.room.status,
      notice: ctx.room.notice,
      slot: s.slot,
      owner: s.owner,
      phase: s.roomPhase,
      settings: s.settings,
      players: s.players,
      race: s.race,
      results: s.results,
      courseName: s.settings ? (ctx.roomCourseTitles.get(s.settings.mission) ?? null) : null,
      colourNames: roomPalette(ctx.editionState.current.render.racerLivery).map(colourName),
      cannotRace: lobbyCannotRace(s.settings),
      copied: performance.now() - lobbyCopiedAt < LOBBY_COPIED_MS,
      copiedWatch: performance.now() - lobbyWatchCopiedAt < LOBBY_COPIED_MS,
      // DEV-441b: the short code, on the INVITE row, when the room has one.
      code: ctx.roomId !== null && isRoomCode(ctx.roomId) ? ctx.roomId : null,
      invite: lobbyInviteMode(), // DEV-632
      shared: performance.now() - lobbySharedAt < LOBBY_COPIED_MS,
      // DEV-634: START's beat once everyone is ready, a little over once a second.
      pulse: Math.floor(performance.now() / LOBBY_PULSE_MS) % 2 === 0,
      tv: ctx.tvOn(), // DEV-480: WATCH ME
      watchMe: watchMeNow(lobbyWatchMe, LOBBY_COPIED_MS),
    }
  }
  let lobbyWatchMe: WatchMeMade | null = null

  /** Ready (or not), carrying the colour, the aircraft and — to be ready — its rules. */
  const lobbyReady = (ready: boolean, colour?: number): void => {
    const s = ctx.room?.session
    if (!s) return
    const variant = ctx.roomVariant()
    const settings = s.settings
    if (!ready || !settings) {
      s.ready(false, undefined, colour, variant)
      return
    }
    void ctx.roomRulesFor(settings, variant).then((rules) => {
      if (rules === null) console.warn('room: this build has no rules for that course')
      else if (ctx.room?.session === s) s.ready(true, rules, colour, variant)
    })
  }

  /** A press on the lobby's action plate: the row under `lobbyAim`. */
  const lobbyPress = (): void => {
    const s = ctx.room?.session
    const id = lobbyRows[lobbyAim]?.id
    if (!s || id === undefined) return
    const me = s.slot === null ? undefined : s.players[s.slot]
    switch (id) {
      case LOBBY_ACTION.course:
        if (s.slot !== s.owner) return
        void ctx.roomCourseIds().then((list) => {
          const at = list.indexOf(s.settings?.mission ?? '')
          const next = list[(at + 1) % Math.max(1, list.length)]
          if (next !== undefined) ctx.roomConfigure(next)
        })
        return
      case LOBBY_ACTION.bots:
        if (s.slot === s.owner && s.settings)
          ctx.roomConfigure(s.settings.mission, !s.settings.bots)
        return
      case LOBBY_ACTION.listed:
        // DEV-633: PUBLIC or PRIVATE. Nobody's ready is undone by it (the room's rule).
        if (s.slot === s.owner && s.settings) {
          const listed = s.settings.listed !== true
          ctx.roomConfigure(s.settings.mission, s.settings.bots, listed)
          console.info(`room: ${listed ? 'public, in Open Rooms' : 'private'}`)
        }
        return
      case LOBBY_ACTION.colour: {
        if (!me) return
        const count =
          s.settings?.colours ?? roomPalette(ctx.editionState.current.render.racerLivery).length
        const next = nextFreeColour(me.colour, count, takenColours(s.players, s.slot))
        try {
          safeStorage()?.setItem(ctx.ROOM_COLOUR_KEY, String(next))
        } catch {
          // A browser that keeps nothing forgets the colour; the room still has it.
        }
        lobbyReady(me.ready, next)
        return
      }
      case LOBBY_ACTION.ready:
        // Never ready for a race this page would fly differently (another
        // edition, an aircraft the course does not take): the row says why.
        if (me && (me.ready || lobbyCannotRace(s.settings) === null)) lobbyReady(!me.ready)
        return
      case LOBBY_ACTION.start: {
        // DEV-587: START is the owner's ready too, so a room of one starts on
        // one press and AI racers fill the empty starts. The room hears READY
        // first; `lobbyFrame` sends START once it has (`lobbyStartAfterReady`).
        const input = lobbyInput()
        const press = input ? lobbyStartPress(input) : null
        if (press === 'start') s.start()
        else if (press === 'ready-and-start') {
          lobbyReady(true)
          lobbyStartAfterReady = performance.now()
          console.info('room: START readies the owner, then starts')
        }
        return
      }
      case LOBBY_ACTION.invite: {
        // DEV-632: a phone's share sheet (else the clipboard); a computer's
        // and a headset's clipboard, said on the row at once as it always was.
        const link = roomInviteLink()
        const share = lobbyInviteMode() === 'share'
        if (!share) lobbyCopiedAt = performance.now()
        sendRoomLink(link, share, (how) => {
          if (how === 'shared') lobbySharedAt = performance.now()
          if (how === 'copied') lobbyCopiedAt = performance.now()
          if (how === 'failed') console.warn(`room: could not send the link (${link})`)
          else console.info(`room: invite link ${how}: ${link}`)
        })
        return
      }
      case LOBBY_ACTION.spectate: {
        // DEV-436: the same room, watched: through its broadcaster, 2 s behind.
        const link = `${globalThis.location.origin}${globalThis.location.pathname}?watch=${ctx.roomId}`
        lobbyWatchCopiedAt = performance.now()
        void navigator.clipboard?.writeText(link).then(
          () => console.info(`room: watch link copied — ${link}`),
          (err: unknown) => console.warn(`room: could not copy the link (${link})`, err),
        )
        return
      }
      case LOBBY_ACTION.watchMe: {
        // DEV-480: `game/tv/watch-me.ts`
        if (ctx.roomId !== null && s.slot !== null)
          pressWatchMe(ctx.roomId, s.slot, ctx.render.renderer.xr.isPresenting, (m) => {
            lobbyWatchMe = m
          })
        return
      }
      case LOBBY_ACTION.leave:
        ctx.roomClose()
        return
      // ── DEV-459: REMOVE A PLAYER. The room enforces who may; this only asks. ──
      case LOBBY_ACTION.kick:
        lobbyPage = 'kick'
        lobbyKickArmed = null
        lobbyAim = 0
        return
      case LOBBY_ACTION.kickBack:
        lobbyToRoomRows()
        return
      default: {
        const slot = kickSlotOf(id)
        if (slot === null || s.slot !== s.owner) return
        if (lobbyKickArmed !== slot) {
          lobbyKickArmed = slot
          return
        }
        lobbyKickArmed = null
        s.kick(slot)
        console.info(`room: removed the player in slot ${slot}`)
        return
      }
    }
  }
  /** Back to the room's own rows, aimed at REMOVE A PLAYER (or the first row). */
  const lobbyToRoomRows = (): void => {
    lobbyPage = 'room'
    lobbyKickArmed = null
    const input = lobbyInput()
    const rows = input ? lobbyActionRows(input) : []
    lobbyAim = Math.max(
      0,
      rows.findIndex((r) => r.id === LOBBY_ACTION.kick),
    )
  }

  /** Every frame the hangar is drawn: the plates shown, aimed and painted. */
  const lobbyFrame = (pointing: PointerHand | null): void => {
    const up = lobbyUp()
    if (up && lobbyPlate === null) {
      lobbyRoster = createPause({ footer: true })
      lobbyPlate = createPause()
      lobbyRoster.object.name = 'room-lobby-roster'
      lobbyPlate.object.name = 'room-lobby'
      // The chair does not move (`seatWorld` is composed once), so neither do they.
      placeLobbyPlate(
        lobbyRoster.object,
        LOBBY_BEARING_DEG.roster,
        ctx.seatWorld,
        ctx.seatQuaternion,
      )
      placeLobbyPlate(
        lobbyPlate.object,
        LOBBY_BEARING_DEG.actions,
        ctx.seatWorld,
        ctx.seatQuaternion,
      )
      ctx.menuScene.add(lobbyRoster.object, lobbyPlate.object)
      void ctx.roomCourseIds()
    }
    lobbyRoster?.setVisible(up)
    lobbyPlate?.setVisible(up)
    const input = up ? lobbyInput() : null
    if (!input || !lobbyPlate || !lobbyRoster) {
      lobbyRows = []
      lobbyPage = 'room'
      lobbyAllReadyWas = false
      lobbyKickArmed = null
      lobbyStartAfterReady = null
      return
    }
    // DEV-587: START pressed READY first; START itself once the room has heard it.
    if (lobbyStartAfterReady !== null) {
      const meReady = input.slot !== null && input.players[input.slot]?.ready === true
      if (performance.now() - lobbyStartAfterReady > LOBBY_START_AFTER_READY_MS) {
        lobbyStartAfterReady = null
        console.info('room: START gave up waiting for the ready')
      } else if (meReady && lobbyStartPress(input) === 'start') {
        lobbyStartAfterReady = null
        ctx.room?.session.start()
      }
    }
    // DEV-459: the REMOVE A PLAYER page while it has somebody to remove and this
    // page is still the owner in a lobby; else back to the room's rows. An armed
    // row the aim has left is disarmed, so only two presses ON it remove.
    if (lobbyPage === 'kick' && !lobbyKickOffered(input)) lobbyToRoomRows()
    if (lobbyKickArmed !== null && kickSlotOf(lobbyRows[lobbyAim]?.id) !== lobbyKickArmed) {
      lobbyKickArmed = null
    }
    lobbyRows = lobbyPage === 'kick' ? lobbyKickRows(input, lobbyKickArmed) : lobbyActionRows(input)
    // DEV-634: Matt, 2026-10-04: *"i had a hard time finding the button to
    // start the match once everybody was ready."* The moment the last player
    // readies, START is the selected row (once: the aim is the owner's again
    // after it), its note says so and pulses (`lobbyActionRows`), and a phone
    // stands a big START over the screen (`boot/room-share.ts`).
    const allReady = lobbyPage === 'room' && lobbyEveryoneReady(input)
    if (allReady && !lobbyAllReadyWas) {
      const at = lobbyRows.findIndex((r) => r.id === LOBBY_ACTION.start)
      if (at >= 0) lobbyAim = at
      console.info('room: everyone is ready; START is selected')
    }
    lobbyAllReadyWas = allReady
    lobbyRosterDrawn = lobbyRosterRows(input)
    lobbyHeadingDrawn = lobbyPage === 'kick' ? LOBBY_KICK_HEADING : lobbyHeading(input)
    lobbyAim = Math.max(0, Math.min(lobbyRows.length - 1, lobbyAim))
    // The laser when it is on the plate, else the head: `aimMenus` left the
    // hand's ray in `_aimOrigin` (or the head's, when no hand points).
    let looked = lobbyPlate.pick(ctx._aimOrigin, ctx._aimDirection, lobbyRows.length)
    if (pointing !== null && looked >= 0) {
      ctx.xrPointer.show(
        pointing,
        planeHitDistance(ctx._aimOrigin, ctx._aimDirection, lobbyPlate.object),
        cameraWorld,
      )
    } else if (pointing !== null) {
      looked = lobbyPlate.pick(cameraWorld, gazeDirection, lobbyRows.length)
    }
    if (looked >= 0) lobbyAim = looked
    lobbyPlate.update({
      options: lobbyRows,
      selected: lobbyAim,
      title: lobbyHeadingDrawn,
    })
    lobbyRoster.update({
      options: lobbyRosterDrawn,
      selected: lobbyRosterSelected(lobbyRosterDrawn, input.slot),
      footer: lobbyRosterFooter(ctx.roomId ?? ''),
      title: lobbyRosterHeading(input),
    })
  }

  /** The lobby as the probe reports it: what the plates last drew, or null while down. */
  const lobbyProbe = (): RoomProbe['lobby'] =>
    lobbyUp() && lobbyRows.length > 0
      ? {
          heading: lobbyHeadingDrawn,
          aim: lobbyAim,
          rows: lobbyRows.map((r) => ({
            id: r.id,
            label: r.label,
            value: r.value ?? null,
            note: r.note,
          })),
          roster: lobbyRosterDrawn.map((r) => ({
            label: r.label,
            value: r.value ?? null,
            note: r.note,
          })),
        }
      : null

  /**
   * The title's HOST A RACE (DEV-389's Race Friends, on DEV-441's Multiplayer
   * page): a fresh room, named by a fresh short code (DEV-441b) that is also
   * its link, joined at once, and the hangar, where its lobby stands. A room a
   * link joined at boot is left for it: hosting is another room, and the Join
   * Room row beside this one is the way into the link's.
   */
  const startRoom = (): void => {
    if (ctx.room) ctx.roomClose()
    ctx.roomOpen(newRoomCode(cryptoRandomBytes))
    ctx.goToScreen('menu', { act: () => console.info(`title: to the room ${ctx.roomId}`) })
  }
  /**
   * The title's JOIN ROOM: room `id`, the one its link named — joined at boot,
   * or again if the letter plate left it for another code — and the way in.
   */
  const joinLinkRoom = (id: string): void => {
    if (ctx.room && ctx.roomId !== id) ctx.roomClose()
    if (!ctx.room) ctx.roomOpen(id)
    ctx.goToScreen('menu', { act: () => console.info(`title: to the room ${ctx.roomId}`) })
  }
  return {
    lobbyUp,
    lobbyReady,
    lobbyProbe,
    startRoom,
    joinLinkRoom,
    OPEN_ROOMS_POLL_MS,
    lobbyPress,
    lobbySteps,
    roomInviteLink,
    lobbyFrame,
    get openRooms() {
      return openRooms
    },
    set openRooms(v: readonly OpenRoomDoor[] | null) {
      openRooms = v
    },
    get openRoomsAsking() {
      return openRoomsAsking
    },
    set openRoomsAsking(v: boolean) {
      openRoomsAsking = v
    },
    get openRoomsAskedAt() {
      return openRoomsAskedAt
    },
    set openRoomsAskedAt(v: number) {
      openRoomsAskedAt = v
    },
    get openRoomsKey() {
      return openRoomsKey
    },
    set openRoomsKey(v: string) {
      openRoomsKey = v
    },
    get lobbyAim() {
      return lobbyAim
    },
    set lobbyAim(v: number) {
      lobbyAim = v
    },
    get lobbyRows() {
      return lobbyRows
    },
    get lobbyPlate() {
      return lobbyPlate
    },
    get lobbyAllReadyWas() {
      return lobbyAllReadyWas
    },
  }
}
