// src/boot/app/title/menu.ts: the title's rows and the hangar's first step, out
// of `bootApp`. APP-SPLIT phase 4, slice 5 (title; `docs/plan/APP-SPLIT.md` §5).
//
// DEV-557's ENTER VR in the game, DEV-558's title rows (START and ENTER VR) and
// the doors of the hangar's first step, DEV-633's open rooms, and DEV-418's
// title look and its glass ray. Three blocks of the closure, with the player
// courses (`title/player-courses.ts`) and the letter plate
// (`hangar/letter-plate.ts`) between them. Every line below was moved
// verbatim from the closure; the plumbing is `ctx.x` where the code reads a
// binding the closure still owns (a getter, and a setter where this code
// writes one: the §6 rule 3 bag), and the returned object.

import * as THREE from 'three'
import type { Capabilities } from '@/boot/capability-gate'
import { stats } from '@/boot/stats-beacon'
import type { MissionCard } from '@/game/mission-index'
import type { RoomClient } from '@/game/room-client'
import { PLAYER_COURSE_ROOM_LABEL, roomCodeText } from '@/game/room-lobby'
import type { TvView } from '@/game/tv/tv-view'
import { createEdge } from '@/input/edge'
import type { MouseLook } from '@/input/look'
import { parseRoomList } from '@/net/room-directory'
import { PLAYER_COURSE_MISSION } from '@/net/room-protocol'
import type { CreditsRoll } from '@/render/credits-roll'
import type { HangarArt } from '@/render/hangar'
import { DOOR, openRoomOfDoor as openRoomOf } from '@/render/hangar-doors'
import type { Pause, PauseOption } from '@/render/pause'
import type { Renderer } from '@/render/renderer'
import {
  ghostRaceRow,
  ghostWatchRow,
  makingOfRow,
  newsletterRow,
  OPTIONS_ROW_ID,
  optionsRow,
  placeTitleMenu,
  START_ROW,
  type TitleInput,
  titleOpeningAim,
  titleRows as titleRowsOf,
} from '@/render/title-menu'
import { titleVrShown } from '@/render/title-vr'
import {
  createTitleVr,
  hasTransientActivation,
  probeImmersiveVr,
  requestImmersiveSession,
  watchXrDevices,
} from '../../enter-vr'
import type { createLetterPlate } from '../hangar/letter-plate'
import type { createMenus } from '../hangar/menus'
import { XR_PROBE_OFF } from '../pins'
import type { createResults } from '../results'
import type { createRoomLobby } from '../room/lobby'
import { createTitleOptionsPlate } from './options-plate'
import type { createPlayerCourses } from './player-courses'

/** What `createTitleMenu` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface TitleMenuCtx {
  /** DEV-881: the credits roll's body band, metres, and its one sheet (`hangar/menus.ts`). */
  readonly CREDITS_BODY_M: number
  readonly creditsRollFor: () => CreditsRoll
  readonly menus: {
    readonly creditsFastUntil: number
    readonly creditsRoll: CreditsRoll | null
  }
  readonly OPEN_ROOMS_POLL_MS: number
  readonly canvas: HTMLCanvasElement
  readonly capabilities: Capabilities
  readonly codeOpenPlate: () => void
  /** DEV-857: the OPTIONS table stands the pause plate's OPTIONS page in the hangar. */
  readonly openOptionsPlate: () => void
  /** DEV-879: the first step's COURSE EDITOR table opens the editor (the shelf's MAKE A COURSE). */
  readonly makeCourse: () => void
  readonly codeUp: () => boolean
  readonly courseLinkRow: () => PauseOption | null
  readonly editorOn: () => boolean
  readonly goToScreen: (
    to: 'menu' | 'mission' | 'title',
    opts?: {
      readonly outSeconds?: number
      readonly inSeconds?: number
      readonly holdSeconds?: number
      readonly act?: () => void
    },
  ) => void
  readonly hangar: HangarArt | null
  readonly joinLinkRoom: (id: string) => void
  readonly letterPlate: ReturnType<typeof createLetterPlate>
  readonly menuFlags: () => { readonly variants: boolean; readonly rooms: boolean }
  readonly mouseLook: MouseLook
  /** DEV-859: the one OPTIONS entry point (`hangar/menus.ts`), shown on this plate while it is up. */
  readonly options: ReturnType<typeof createMenus>['options']
  readonly playerCourseHost: ReturnType<typeof createPlayerCourses>
  readonly render: Renderer
  readonly results: ReturnType<typeof createResults>
  readonly room: RoomClient | null
  readonly roomClose: () => void
  readonly roomCourseCards: () => Promise<readonly MissionCard[]>
  readonly roomCourseTitles: Map<string, string>
  readonly roomId: string | null
  readonly roomLobby: ReturnType<typeof createRoomLobby>
  readonly roomOpen: (id: string, opts?: { readonly existing?: boolean }) => void
  readonly screen: 'title' | 'menu' | 'mission'
  readonly startQuickRace: () => void
  readonly startRoom: () => void
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  titleAim: number
  readonly titleLinkRoom: string | null
  readonly titleMenu: Pause | null
  readonly titleMenuUp: () => boolean
  readonly titleRoomNotice: () => string | null
  readonly tvOn: () => boolean
  readonly tvView: TvView
}

export const createTitleMenu = (ctx: TitleMenuCtx) => {
  const {
    CREDITS_BODY_M,
    OPEN_ROOMS_POLL_MS,
    canvas,
    capabilities,
    goToScreen,
    joinLinkRoom,
    menuFlags,
    mouseLook,
    render,
    results,
    roomClose,
    roomCourseCards,
    roomCourseTitles,
    roomLobby,
    roomOpen,
    startRoom,
    titleLinkRoom,
    titleRoomNotice,
    tvOn,
    tvView,
  } = ctx
  // ── DEV-881, DEV-882: the OPTIONS pages' own plate (`title/options-plate.ts`) ──
  const titleOptions = createTitleOptionsPlate({
    CREDITS_BODY_M,
    creditsRollFor: () => ctx.creditsRollFor(),
    get menus() {
      return ctx.menus
    },
    options: {
      get up() {
        return ctx.options.up
      },
      plate: () => ctx.options.plate(),
    },
    rig: render.rig,
  })
  // ── DEV-557: ENTER VR, in the game (`render/title-vr.ts`, `boot/enter-vr.ts`) ──
  //
  // Matt, 2026-10-01: *"add an enter VR button to the title screen (or
  // "connect vr headset" if it can't find one)"*. The state lives for the life
  // of the page, because two things press it: the title's ENTER VR row
  // (DEV-558; DEV-557's plate until then), and while a page that HAS a headset
  // is flat, the pause plate's ENTER VR row (DEV-206's way back in after a
  // session the runtime ended, which the landing card was). `?xr=off` never
  // asks the platform: it starts SteamVR here.
  const titleVr = createTitleVr({
    supported: capabilities.immersiveVr,
    probe: !XR_PROBE_OFF,
    ask: probeImmersiveVr,
    activation: hasTransientActivation,
    enter: async () => {
      stats.xr('pressed')
      const outcome = await requestImmersiveSession(render.renderer.xr, () =>
        render.quality.applyBeforeSession(),
      )
      if (outcome === 'refused') stats.xr('refused')
      return outcome
    },
    // DEV-603: a probe that answered after boot stopped waiting is a device
    // change too: a late yes makes the row ask again, and light.
    watchDevices: (onChange) => watchXrDevices(onChange, capabilities.xrProbeLate),
    // DEV-992: a runtime that came up after boot need not fire `devicechange`
    // (Matt, 2026-10-14: SteamVR started after the page loaded, and the page
    // stayed flat). While the row says "connect", ask quietly every 10 s (at
    // most `MAX_POLLS` times a page) so it lights without a press; a press asks
    // too and, on a yes, enters. Never under `?xr=off` (`probe` is false there).
    pollMs: 10_000,
    canPoll: () => !globalThis.document?.hidden && !render.renderer.xr.isPresenting,
  })
  /** Edge state for H, ENTER VR's key. */
  const enterVrKey = createEdge()
  /**
   * DEV-558: ENTER VR was asked for ON THE TITLE (its row, or H). When the
   * session starts the page goes to the hangar, as START does: Matt, *"Clicking
   * either should take us to the Hangar"*. Spent by the frame that goes.
   */
  let titleVrToHangar = false
  /**
   * Does the title offer ENTER VR? `titleVrShown` is the rule: not while
   * presenting, and not on a touch device with no headset (a phone's title is
   * START alone, DEV-557's call 2).
   */
  const titleVrOffered = (): boolean =>
    titleVrShown({
      presenting: render.renderer.xr.isPresenting,
      touch: capabilities.touch,
      state: titleVr.state,
    })
  /**
   * The title's rows, cached on what can change them within a page (the VR
   * state, a link's row arriving, a room's notice), so the frame loop's
   * per-frame `update` builds no array.
   */
  let titleRowsFor: { key: string; rows: readonly PauseOption[] } | null = null
  // ── DEV-558: the title's rows, START and ENTER VR ──────────────────────
  //
  // Matt, 2026-10-01: *"Title Screen: Start, Enter VR. Clicking either should
  // take us to the Hangar"*. DEV-441's doors and the pages behind them, and
  // DEV-480's TV row, are the hangar's first step now (`doorInput` above the
  // room, `doorPress` below). What is left here is the way in, and a link's
  // row when a link brought the page here (`render/title-menu.ts`).
  /** START's note for this visit: a `?room=` link's room, or why a link's room or race failed. */
  const titleStartNote = (): TitleInput['start'] => {
    const notice = titleRoomNotice()
    if (notice !== null) return { note: notice, accent: true }
    if (titleLinkRoom !== null && ctx.room !== null && ctx.roomId === titleLinkRoom) {
      return {
        note: `room ${roomCodeText(titleLinkRoom)}: its lobby is in the hangar`,
        accent: true,
      }
    }
    return null
  }
  /** DEV-373: a shared lap's RACE THIS LAP row, once its fetch lands; null otherwise. */
  const titleGhostRow = (): PauseOption | null => {
    const lap = results.linkGhost
    return lap ? ghostRaceRow(lap.handle, lap.seconds, lap.variant) : null
  }
  /**
   * DEV-571: and WATCH THIS LAP under it, where the build has TV, whose lap
   * show (`/tv/lap/<id>`) is the watching. Since DEV-578 every build has TV;
   * a build without it (the flag off) offers the race alone.
   */
  const titleWatchRow = (): PauseOption | null => {
    const lap = results.linkGhost
    return lap && tvOn() ? ghostWatchRow(lap.handle, lap.seconds) : null
  }
  const titleInput = (): TitleInput => ({
    vr: titleVrOffered() ? titleVr.state : null,
    link: titleGhostRow() ?? ctx.courseLinkRow(),
    watch: titleWatchRow(),
    start: titleStartNote(),
    // DEV-859: OPTIONS, under START, in a headset as well as on a flat screen.
    options: optionsRow(),
    // DEV-658: not in a headset, where its tab would open behind the eyes.
    newsletter: render.renderer.xr.isPresenting ? null : newsletterRow(newsletterBlocked),
    // DEV-802: and the making-of, above it, on the same terms.
    makingOf: render.renderer.xr.isPresenting ? null : makingOfRow(),
  })
  /** What the title's rows are a function of, as one string: the cache's key. */
  const titleRowsKey = (): string =>
    [
      titleVrOffered() ? titleVr.state : '',
      results.linkGhost?.id ?? '',
      results.linkGhost && tvOn() ? 'watch' : '', // DEV-571
      ctx.editorOn() ? (ctx.playerCourseHost.courseLinkId ?? '') : '',
      ctx.playerCourseHost.courseRefusal?.from === 'link'
        ? ctx.playerCourseHost.courseRefusal.reason
        : '',
      ctx.playerCourseHost.courseEntries.length,
      titleRoomNotice() ?? '',
      ctx.room !== null && ctx.roomId === titleLinkRoom,
      render.renderer.xr.isPresenting, // DEV-658: the newsletter row
      newsletterBlocked,
    ].join('|')
  /** DEV-658: the browser refused the newsletter's tab on the last press (a pad's, say). */
  let newsletterBlocked = false
  /** The link row the title last opened aimed at, so it is aimed once, as it arrives. */
  let titleLinkAimed: string | null = null
  /** DEV-859: the OPTIONS pages are on this plate (so the rows are theirs, not the title's). */
  let optionsShown = false
  /** The title row the aim lands on when OPTIONS closes. */
  let aimOnReturn: string | undefined
  const titleRows = (): readonly PauseOption[] => {
    if (ctx.options.up) {
      // DEV-859: the same OPTIONS page the pause plate shows. DEV-882: drawn
      // on its own plate at the pause plate's size (`title/options-plate.ts`),
      // not on this one, so there is no placement to do here; the rows are
      // still this plate's to AIM (`titleAim`), whoever draws them.
      const rows = ctx.options.plate().rows
      optionsShown = true
      aimOnReturn = OPTIONS_ROW_ID
      return rows
    }
    if (optionsShown) {
      // Back on the title's own rows: re-place for them, and aim at OPTIONS.
      optionsShown = false
      titleRowsFor = null
    }
    const key = titleRowsKey()
    if (titleRowsFor?.key === key) return titleRowsFor.rows
    const rows = titleRowsOf(titleInput())
    // A link's row aims the title, ONCE, when it arrives: a lap's fetch or a
    // course's read lands after the rows are up, and the press it was sent for
    // must still be the first one. Otherwise the aim stays on its row as the
    // rows change round it (ENTER VR's words, a notice).
    const was = aimOnReturn ?? titleRowsFor?.rows[ctx.titleAim]?.id
    aimOnReturn = undefined
    const link = rows[0]?.id === START_ROW.id ? null : (rows[0]?.id ?? null)
    if (link !== titleLinkAimed) {
      titleLinkAimed = link
      ctx.titleAim = titleOpeningAim(rows)
    } else {
      const at = rows.findIndex((r) => r.id === was)
      ctx.titleAim = at >= 0 ? at : Math.max(0, Math.min(rows.length - 1, ctx.titleAim))
    }
    // DEV-571: a fourth row (a shared lap's WATCH) sizes the plate down to keep
    // its bottom edge where three put it (`titleMenuScale`); its pick follows.
    if (ctx.titleMenu && titleRowsFor?.rows.length !== rows.length) {
      placeTitleMenu(ctx.titleMenu.object, rows.length, !render.renderer.xr.isPresenting)
    }
    titleRowsFor = { key, rows }
    return rows
  }
  /**
   * DEV-558: a door table the room handed over (`HangarOptions.onDoor`): FF-TV,
   * or one of Multiplayer's room choices. Single Player and Multiplayer
   * themselves are the room's own descents.
   */
  /**
   * DEV-558: from the title to the hangar's FIRST step, behind the one fade:
   * START, and a session ENTER VR asked for on the title. The doors are re-laid
   * at the black, so a link's room or a refusal that arrived while the title
   * was up is on the MULTIPLAYER table.
   */
  const goToTheHangar = (log: string): void => {
    goToScreen('menu', {
      act: () => {
        ctx.hangar?.showDoors()
        console.info(log)
      },
    })
  }
  const doorPress = (id: string): void => {
    if (id === DOOR.quickRace) {
      // DEV-565: Quick Race's route, from the room. Flying anything else is
      // leaving a room a link joined (DEV-389), as the title's row did.
      roomClose()
      ctx.startQuickRace()
    } else if (id === DOOR.tv) {
      tvView.boardFromHangar()
      stats.count('tvWatched')
    } else if (id === DOOR.host) startRoom()
    else if (id === DOOR.joinLink) {
      if (titleLinkRoom !== null) joinLinkRoom(titleLinkRoom)
    } else if (id === DOOR.joinCode) ctx.codeOpenPlate()
    else if (id === DOOR.options) ctx.openOptionsPlate()
    else if (id === DOOR.editor) ctx.makeCourse()
    else {
      // DEV-633: a public room's table: its room, asked for a seat as a typed
      // code is (`existing`), so a room gone since the list refuses rather
      // than opening a new one. A refusal stands the lobby's ROOM CLOSED.
      const code = openRoomOf(id)
      if (code !== null) {
        if (ctx.room) roomClose()
        roomOpen(code, { existing: true })
        goToScreen('menu', { act: () => console.info(`hangar: into the open room ${code}`) })
      }
    }
  }
  // ── DEV-633: OPEN ROOMS, the public rooms on the Multiplayer step ─────
  //
  // Matt, 2026-10-04: *"i like your idea of listing public rooms."* While the
  // hangar stands on its Multiplayer step, `GET /api/rooms` every few seconds
  // (`net/room-directory.ts` behind it); a list that CHANGED re-lays the step's
  // tables (`render/hangar-doors.ts`, `openRoomCards`). Nothing a stranger
  // typed is on a table: the course is this page's own name for its id.
  // (The list's state is declared with the lobby's, above: `doorInput` reads
  // it when the hangar is built, before this point in the boot.)
  const openRoomsFrame = (): void => {
    if (ctx.screen !== 'menu' || ctx.hangar?.view !== 'multiplayer' || !menuFlags().rooms) return
    const now = performance.now()
    if (roomLobby.openRoomsAsking || now - roomLobby.openRoomsAskedAt < OPEN_ROOMS_POLL_MS) return
    roomLobby.openRoomsAsking = true
    roomLobby.openRoomsAskedAt = now
    void Promise.all([fetch('/api/rooms').then((r) => (r.ok ? r.json() : null)), roomCourseCards()])
      .then(([body]) => {
        const next =
          body === null
            ? null
            : parseRoomList(body).map((r) => ({
                code: r.room,
                spoken: roomCodeText(r.room),
                course:
                  r.mission === null
                    ? null
                    : (roomCourseTitles.get(r.mission) ??
                      // DEV-851: a stranger's own course; its name is not in the list.
                      (PLAYER_COURSE_MISSION.test(r.mission) ? PLAYER_COURSE_ROOM_LABEL : null)),
                players: r.players,
                seats: r.seats,
                racing: r.phase === 'racing',
              }))
        const key = JSON.stringify(next)
        if (key === roomLobby.openRoomsKey) return
        roomLobby.openRoomsKey = key
        roomLobby.openRooms = next
        console.info(`hangar: open rooms ${next === null ? 'unknown' : next.length}`)
        if (ctx.screen === 'menu' && ctx.hangar?.view === 'multiplayer') ctx.hangar.refresh()
      })
      .catch(() => {
        // A site with no rooms, or a network blip: the step stands what it had.
      })
      .finally(() => {
        roomLobby.openRoomsAsking = false
      })
  }
  // ── DEV-418: the title looks around, like the other menus ─────────────────
  //
  // Matt, 2026-09-26: *"titlescreen: enable look just like the other menus"*.
  // Flat only: in a headset the title was always a world you can look round.
  //
  // The hangar's model, whole: click to capture, the mouse (and the right
  // stick, which the title leaves free) turns the view, the NOSE picks what it
  // is on, and a click while captured presses it. The title's rows are the
  // pause plate's painter and hit test, and the frame loop already aimed them
  // with the head every frame — on a flat screen that ray simply never left the
  // monument, because the camera could not move.
  //
  // The one thing the hangar does not have is a CURSOR that already means
  // something: a click on a row presses that row (DEV-353), which is how one
  // click still leaves the title. So a cursor click ON a row stays a press, and
  // only a cursor click on the world is the capture (`setCursorTarget`, and
  // `input/look.ts`'s `readClick` for the rule it refines).
  /** The look, radians, on top of the title's own pose: yaw about up, pitch about the view's x. */
  let titleLookYaw = 0
  let titleLookPitch = 0
  /** The camera's LOCAL turn under the title's level rig: yaw first, then pitch. */
  const titleLookEuler = new THREE.Euler(0, 0, 0, 'YXZ')
  const _titleLookQuat = new THREE.Quaternion()
  const _rowNdc = new THREE.Vector2()
  const _rowRay = new THREE.Raycaster()
  /**
   * Which of the title's rows is under a point on the glass, CSS pixels, or −1.
   * The camera's last drawn pose: on the title it moves only while the pointer
   * is captured, and a captured pointer has no point on the glass to ask about.
   */
  /** The ray through a point on the glass, CSS pixels, or null. Volatile. */
  const glassRay = (x: number, y: number): THREE.Ray | null => {
    const rect = canvas.getBoundingClientRect()
    if (!Number.isFinite(x + y) || !(rect.width > 0 && rect.height > 0)) return null
    _rowNdc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1)
    _rowRay.setFromCamera(_rowNdc, render.camera)
    return _rowRay.ray
  }
  const titleRowAt = (x: number, y: number): number => {
    // DEV-441b: while the letter plate is up (in the hangar since DEV-558),
    // the KEY under the point.
    if (ctx.codeUp()) {
      const ray = ctx.letterPlate.codePlate === null ? null : glassRay(x, y)
      return ray === null ? -1 : (ctx.letterPlate.codePlate?.pick(ray.origin, ray.direction) ?? -1)
    }
    const ray = ctx.titleMenu === null || !ctx.titleMenuUp() ? null : glassRay(x, y)
    if (ctx.titleMenu === null || ray === null) return -1
    // DEV-882: the OPTIONS pages are on their own plate while they are up.
    if (ctx.options.up) return titleOptions.pick(ray.origin, ray.direction)
    return ctx.titleMenu.pick(ray.origin, ray.direction, titleRows().length)
  }
  mouseLook.setCursorTarget(
    (x, y) =>
      (ctx.titleMenuUp() || ctx.codeUp()) &&
      !render.renderer.xr.isPresenting &&
      titleRowAt(x, y) >= 0,
  )
  return {
    glassRay,
    titleOptions,
    titleVr,
    doorPress,
    titleRows,
    enterVrKey,
    goToTheHangar,
    titleRowAt,
    titleLookEuler,
    _titleLookQuat,
    openRoomsFrame,
    get titleVrToHangar() {
      return titleVrToHangar
    },
    set titleVrToHangar(v: boolean) {
      titleVrToHangar = v
    },
    get newsletterBlocked() {
      return newsletterBlocked
    },
    set newsletterBlocked(v: boolean) {
      newsletterBlocked = v
    },
    get titleLookYaw() {
      return titleLookYaw
    },
    set titleLookYaw(v: number) {
      titleLookYaw = v
    },
    get titleLookPitch() {
      return titleLookPitch
    },
    set titleLookPitch(v: number) {
      titleLookPitch = v
    },
  }
}
