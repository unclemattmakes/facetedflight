// src/boot/app/results.ts: what follows a run, out of `bootApp`. APP-SPLIT
// phase 4, slice 4 (`docs/plan/APP-SPLIT.md` §5).
//
// The opponents' standings (DEV-344, DEV-371), sharing a lap and picking the
// ghost you race (DEV-373, DEV-374), the questions under the results panel
// (DEV-571, DEV-629), the course's board on the panel (DEV-431) and the race
// map (DEV-361). Every line below was moved verbatim from the closure; the
// plumbing is `ctx.x` where the code reads a binding the closure still owns (a
// getter, so a check narrows as the closure's `let` did), and the returned
// object, which hands the closure what it still calls and reads (`share`, which
// `restartRun` puts back to idle, is an accessor on it).

import * as THREE from 'three'
import { stats } from '@/boot/stats-beacon'
import { STANDARD_VARIANT_ID } from '@/content/aircraft-schema'
import type { Edition } from '@/content/edition-schema'
import type { Level, VehicleId } from '@/content/level-schema'
import { aircraftFor } from '@/content/load-aircraft'
import type { PlayerCourse } from '@/content/player-course'
import type { EditionState } from '@/game/edition'
import type { Flight } from '@/game/flight'
import {
  type BoardView,
  DEFAULT_GHOST_PICK,
  type GhostPick,
  ghostLine,
  nextGhostPick,
  pickEntry,
  pickNeedsBoard,
  retryGhost,
} from '@/game/ghost-pick'
import { LOCAL_LAP_RULES, readLap } from '@/game/ghost-store'
import type { LoadedGhosts, PlayerGhost } from '@/game/ghosts'
import {
  LAP_ASK_HEADING,
  type LapAskFacts,
  lapAskAction,
  lapAskAimIndex,
  lapAskAsks,
  lapAskOpeningRow,
  lapAskOpeningRowFor,
  lapAskPlace,
  lapAskRows,
  lapAskScale,
  lapWouldRank,
} from '@/game/lap-ask'
import {
  cryptoRandomBytes,
  cryptoRandomInt,
  ownerKey,
  readHandle,
  rerollHandle,
  saveHandle,
} from '@/game/lap-identity'
import { type ChosenGhost, type FlownLap, ghostTagText, type LapRun } from '@/game/lap-run'
import {
  boardedLap,
  deleteFailed,
  keepPosted,
  pressShare,
  rerollShare,
  SHARE_IDLE,
  type ShareState,
  shareAsking,
  shareable,
  shareBlock,
  shareDeleted,
  shareFailed,
  sharePosted,
} from '@/game/lap-share'
import type { MissionState } from '@/game/mission'
import type { MissionCard } from '@/game/mission-index'
import { rulesFor } from '@/game/modes'
import type { RaceLine } from '@/game/race-place'
import type { LoadedRacers } from '@/game/racers'
import {
  nextBeat,
  nextBeatLine,
  type ResultsBoardFetch,
  resultsBoardView,
} from '@/game/results-board'
import { ghostStanding, racerStanding, raceTimeLimit, rowBelowWords } from '@/game/results-state'
import type { MouseLook } from '@/input/look'
import { clampAim, createRowStepper } from '@/input/menu-step'
import type { TouchControls } from '@/input/touch-overlay'
import { randomHandle } from '@/net/handles'
import {
  type BoardEntry,
  type BoardKey,
  deleteLap,
  fetchBoard,
  fetchLap,
  type SharedLap,
  shareLink,
  submitLap,
} from '@/net/lap-client'
import { LAP_BOARD_SIZE } from '@/net/lap-policy'
import type { RoomRace } from '@/net/room-protocol'
import type { ControlsDevice } from '@/render/controls-menu'
import type { HangarArt } from '@/render/hangar'
import type { HudRedraw } from '@/render/hud'
import {
  createPause,
  WIDTH as PANEL_WIDTH,
  type Pause,
  type PauseOption,
  rowCentreLocalY,
  TOP_LOCAL_Y,
} from '@/render/pause'
import { phoneUi, RESULTS_PHONE_SCALE } from '@/render/phone-floor'
import { createRaceMap, type RaceMap } from '@/render/race-map'
import type { Renderer } from '@/render/renderer'
import {
  type OpponentStanding,
  RESULTS_PANEL_HEIGHT,
  RESULTS_PANEL_WIDTH,
  type RunSummary,
} from '@/render/results'
import type { LaunchState } from '@/sim/launch'
import { boardedVariant, EDITOR_RUN, GHOST_LINK_ID, OPPONENTS, RULES_PARAM } from './pins'
import type { ResultsBoardReport, ShareReport } from './types'

/** What `createResults` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface ResultsCtx {
  readonly aimPlate: (
    o: THREE.Object3D<THREE.Object3DEventMap>,
    pick: (a: THREE.Vector3, b: THREE.Vector3) => number,
  ) => number
  readonly canvas: HTMLCanvasElement
  readonly confirmDevice: () => ControlsDevice
  readonly coursePanelOf: (summary: RunSummary) => RunSummary | null
  readonly editionState: EditionState
  readonly flight: Flight | null
  readonly glassRay: (x: number, y: number) => THREE.Ray | null
  readonly hangar: HangarArt | null
  readonly hudRedraw: HudRedraw
  readonly lapRun: LapRun | null
  readonly lastResult: RunSummary | null
  readonly launch: LaunchState
  readonly level: Level
  readonly liveGhosts: LoadedGhosts | null
  readonly livePlayerGhost: PlayerGhost | null
  readonly liveRacers: LoadedRacers | null
  readonly mission: MissionState
  readonly mouseLook: MouseLook
  readonly paused: boolean
  readonly playerCourseNow: () => PlayerCourse | null
  readonly render: Renderer
  readonly roomActive: () => boolean
  readonly roomMapField: () => {
    readonly race: RoomRace
    readonly line: RaceLine
    readonly finish: { x: number; y: number; z: number } | null
    readonly colours: string[]
    readonly slots: number[]
  } | null
  readonly screen: 'title' | 'menu' | 'mission'
  readonly touch: TouchControls
  readonly tvOn: () => boolean
}

export const createResults = (ctx: ResultsCtx) => {
  /**
   * Where each opponent is in the race RIGHT NOW: crossed (with its time),
   * still flying, or out of time.
   *
   * Read off the LIVE racers every frame the results panel is up, not once:
   * the player's run ending is not the race ending. Read once, on the tick the
   * player crossed, every racer still in the air printed `DNF` and stayed that
   * way — an autopilot that beat all five on `int_01_hoverJet` got a board of
   * five DNFs (DEV-344). `racerStanding` keeps DNF for the one thing that
   * genuinely ends a live racer's race: the race clock.
   *
   * Under `?opponents=ghosts` there are no racers, and the panel used to show an
   * empty list: the 2016 clips are flight paths with no recorded RESULT. There
   * is one now. `scoreGhost` replays each clip through `stepCourse` at fixed dt
   * and records when it crosses the finish gate — 57.32 s for the fast run and
   * 102.44 s for the slow one, computed once at load, with no flight model and
   * no renderer. Same `OpponentStanding` shape either way, so the panel needs
   * no branch of its own.
   */
  const opponentStandings = (): OpponentStanding[] => {
    const limit = raceTimeLimit(ctx.level, ctx.mission.mode)
    // DEV-391: in a room the host's racers ARE the room's bots, listed by the
    // room for everyone (`roomPanelOpponents`), not twice.
    if (ctx.roomActive()) return []
    return OPPONENTS === 'ghosts'
      ? (ctx.liveGhosts?.standings ?? []).map((s) => ghostStanding(s, limit))
      : (ctx.liveRacers?.racers ?? []).map((racer) => racerStanding(racer, limit))
  }
  /**
   * DEV-371: the ghost you raced, as a row on the board. Its time is the lap's
   * own rescore, known at the restart, so like a 2016 recording it is finished
   * or DNF and never flying. `withStandings` lists it and does not place it.
   */
  const playerGhostStandings = (): OpponentStanding[] =>
    ctx.lapRun?.ghost
      ? [
          ghostStanding(
            // DEV-373: somebody else's lap stands under its poster's handle.
            // DEV-571: your own as YOUR GHOST, the panel's word for it.
            {
              name: ctx.lapRun.ghost.handle ?? 'your ghost',
              seconds: ctx.lapRun.ghost.result.seconds,
            },
            raceTimeLimit(ctx.level, ctx.mission.mode),
          ),
        ]
      : []

  // ── DEV-373: sharing a lap, and picking the ghost you race ─────────────
  //
  // PLAYER-GHOSTS §5's DEV-373, in one block: the three doors §4.2 names, over
  // DEV-372's server (`net/lap-client.ts` is all of the HTTP).
  //
  //   Share    the results panel, explicit (§8 call 9). Since DEV-571 a menu
  //            under the panel ASKS (`game/lap-ask.ts`): POST TO LEADERBOARD?
  //            with the name it would post under, ANOTHER NAME, SAVE AS YOUR
  //            GHOST?, and home. The press on the post row is the yes; the
  //            panel then shows the short link. A tainted lap is never posted
  //            (D30, DEV-371). `game/lap-share.ts` is the post's state and the
  //            panel's words. Once posted, the same row takes the lap back,
  //            asked first (DEV-374).
  //   a card   the hangar's course card carries a ghost line — your best by
  //            default, then world #1, the lap just above yours, none — and the
  //            race button moves the aimed card's line on (`game/ghost-pick.ts`).
  //            Nothing is fetched until a press asks for the board (§8 call 8).
  //   a link   `?ghost=<id>`, fetched at boot; the title's Quick Race row then
  //            names it, and boards its course in its aircraft with no ride.
  //
  // Every ghost reaches the run the one way DEV-371 built: `LapRun.newRun`
  // asks `chosenGhost` for the course, and the ghost flies intangible beside
  // the racers.

  /** Share's state, for the run on the panel. Back to idle with every new run. */
  let share: ShareState = SHARE_IDLE
  /** Laps this page has sent: what a spec counts to prove a press did NOT post. */
  let sharePosts = 0
  /** This device's owner key (`game/lap-identity.ts`), read or minted on the first post. */
  let owner: string | null = null

  // DEV-452 (D35): nothing new is written to a Classic board, so a run under
  // the development switch `?rules=classic` offers no Share.
  const shareOffered = (): boolean =>
    ctx.lastResult !== null && RULES_PARAM === null && shareable(ctx.lapRun?.last ?? null)
  const shareRoute = (): 'flat' | 'xr' => (ctx.render.renderer.xr.isPresenting ? 'xr' : 'flat')

  // ── DEV-571: the questions after a lap, as one menu ────────────────────
  //
  // `game/lap-ask.ts` has the why and the words. This holds the plate (the
  // menus' own, `render/pause.ts`, on the ship's group under the results
  // panel), its aim BY ROW ID (a row that comes or goes never moves it onto a
  // neighbour), and the presses. Every device's input reaches it through the
  // hooks the pause plate already has: the nudge block, the tap and cursor
  // block, the confirm handler, and the render block's `askFrame`.
  /** The lap the questions are about: a new one starts them again. */
  let askFor: FlownLap | null = null
  let askAimId: string = lapAskOpeningRow
  let askPlate: Pause | null = null
  const askSteps = createRowStepper()
  /** The aim was put there by the head or a laser (in a headset), not the stick. */
  let askAimByRay = false
  /**
   * DEV-629: the aim is the plate's own default, not the player's: it follows
   * {@link lapAskOpeningRowFor} as the board lands, until the player aims.
   */
  let askAimDefault = true
  /** Where the plate was last hung: beside the panel (a touch screen) or under it. */
  let askPlacedBeside: boolean | null = null
  /** The facts the rows are a function of, for the lap on the panel. */
  const askFacts = (): LapAskFacts | null => {
    const lap = ctx.lapRun?.last ?? null
    if (!lap || !ctx.lastResult) return null
    return {
      share,
      // DEV-452 (D35): `?rules=classic` writes no board, so it asks nothing about one.
      boarded: RULES_PARAM === null && boardedLap(lap),
      postable: shareOffered(),
      taint: lap.reasons,
      kept: ctx.lapRun?.lastKept ?? null,
      savedBefore: lap.savedBefore,
      home: EDITOR_RUN.request ? 'editor' : 'hangar',
      // DEV-629: where it would land on the board the panel fetched as the run
      // ended. Not known until that board lands (or ever, if it failed).
      wouldRank:
        lap.seconds !== null &&
        resultsBoard?.result === ctx.lastResult &&
        resultsBoard.fetch.status === 'ready'
          ? lapWouldRank(
              lap.seconds,
              resultsBoard.fetch.entries.map((e) => e.seconds),
              LAP_BOARD_SIZE,
            )
          : null,
    }
  }
  /**
   * The plate is up: a finished run left a lap, on the mission screen, nothing
   * paused, and there is something to ask. Never in a room (its panel is the
   * room's standings) or on a player course (its panel shares the COURSE).
   */
  const lapAskUp = (): boolean => {
    if (!ctx.flight || ctx.screen !== 'mission' || ctx.paused || ctx.roomActive()) return false
    if (ctx.playerCourseNow() !== null) return false
    const facts = askFacts()
    return facts !== null && lapAskAsks(facts)
  }
  const askRows = (): PauseOption[] => {
    const facts = askFacts()
    return facts ? lapAskRows(facts) : []
  }
  /** A new lap on the panel: the question starts with the name it would post under, aimed home. */
  const askSync = (): void => {
    const lap = ctx.lapRun?.last ?? null
    if (lap === askFor) return
    askFor = lap
    askAimId = lapAskOpeningRow
    askAimDefault = true
    askAimByRay = false
    if (lap) share = shareAsking(readHandle() ?? randomHandle(cryptoRandomInt))
  }
  /**
   * A press on the plate's row `id`. True when the press was the plate's;
   * false for home, which the caller performs as A after a run always has
   * (DEV-406), so there is one way home and not two.
   */
  const askPress = (id: string | undefined): boolean => {
    const action = lapAskAction(id)
    // DEV-374: any press but the confirming one keeps a posted lap.
    if (action !== 'post') share = keepPosted(share) ?? share
    switch (action) {
      case 'post': {
        const pressed = pressShare(share, shareOffered())
        share = pressed.next
        if (pressed.post) void postLap()
        if (pressed.remove) void removeLap()
        return true
      }
      case 'name': {
        share = rerollShare(share, (current) => rerollHandle(current, cryptoRandomInt)) ?? share
        console.info(`share: another name, ${share.handle}`)
        return true
      }
      case 'keep': {
        const was = ctx.lapRun?.lastKept ?? null
        const now = was === null ? null : (ctx.lapRun?.keepLast(!was) ?? null)
        console.info(`ghost: this lap ${now ? 'saved' : 'not saved'} as your ghost`)
        if (now) stats.count('ghostSaves')
        return true
      }
      case 'home':
        return false
      default:
        return true
    }
  }
  /** The confirm press with the plate up: the aimed row. False: go home, as A does. */
  const askConfirm = (): boolean => askPress(askAimId)
  /** The stick, the D-pad or the arrow keys: one row per push. */
  const askNudge = (step: number): void => {
    const taken = askSteps.take(step)
    if (taken !== 0) {
      const rows = askRows()
      const at = lapAskAimIndex(rows, askAimId)
      askAimId = rows[clampAim(at, taken, rows.length)]?.id ?? askAimId
      askAimByRay = false
      askAimDefault = false
    }
  }
  /** The row under a point on the glass, CSS pixels, or null: a finger's or a free cursor's. */
  const askRowAt = (x: number, y: number): string | null => {
    if (!askPlate || !lapAskUp()) return null
    const ray = ctx.glassRay(x, y)
    if (!ray) return null
    const rows = askRows()
    const hit = askPlate.pick(ray.origin, ray.direction, rows.length)
    return hit >= 0 ? (rows[hit]?.id ?? null) : null
  }
  // A free cursor's click ON a row presses it and captures nothing, as on the
  // pause plate (DEV-563 follow-up); anywhere else it is the capture.
  ctx.mouseLook.setCursorTarget((x, y) => askRowAt(x, y) !== null, 'lap-ask')
  /** A finger pressed a row: the aim goes back home after the press (`askFrame`). */
  let askTapPressed = false
  /**
   * The tap and cursor block's hook: a finger on a row presses it, a free
   * cursor moving onto one aims it (its click is already a press). True when
   * a tap pressed a row, which rides `confirm`.
   */
  const askPointer = (
    tap: { x: number; y: number } | null,
    hover: { x: number; y: number } | null,
  ): boolean => {
    if (tap !== null) {
      const id = askRowAt(tap.x, tap.y)
      if (id === null) return false
      askAimId = id
      askAimDefault = false
      askTapPressed = true
      return true
    }
    if (hover !== null && !ctx.mouseLook.locked && !ctx.render.renderer.xr.isPresenting) {
      const id = askRowAt(hover.x, hover.y)
      if (id !== null && id !== askAimId) {
        askAimId = id
        askAimDefault = false
      }
    }
    return false
  }
  /**
   * Every frame, in the render block: the plate placed under the results
   * panel, aimed (the head or a laser in a headset; on a flat screen the keys
   * and the cursor aim it, and the nose does not, since it is still flying),
   * and painted.
   */
  const askFrame = (visible: boolean): void => {
    askSync()
    // A phone has no stick on this menu and its confirm chip is CONTINUE (home),
    // so a row a finger pressed does not keep the aim.
    if (askTapPressed) {
      askTapPressed = false
      askAimId = lapAskOpeningRow
      askAimDefault = false
    }
    // DEV-629: an aim nobody has moved follows the lap's default, which turns
    // to POST once the board lands and says this lap would rank.
    if (askAimDefault) askAimId = lapAskOpeningRowFor(askFacts())
    const up = visible && lapAskUp()
    if (!up || !ctx.flight) {
      askPlate?.setVisible(false)
      return
    }
    if (askPlate === null) askPlate = createPause()
    const plate = askPlate
    // Beside the panel on a touch screen, whose chips stand under it; under it
    // everywhere else (`lapAskPlace`).
    const beside = ctx.touch.available && !ctx.render.renderer.xr.isPresenting
    if (plate.object.parent !== ctx.flight.object || askPlacedBeside !== beside) {
      ctx.flight.object.add(plate.object)
      const at = ctx.flight.results.object.position
      // DEV-894: a phone scales the panel and this plate together (`phone-floor.ts`).
      const k = phoneUi.on ? RESULTS_PHONE_SCALE : 1
      const to = lapAskPlace(
        { y: at.y, z: at.z, width: RESULTS_PANEL_WIDTH * k, height: RESULTS_PANEL_HEIGHT * k },
        { width: PANEL_WIDTH * k, top: TOP_LOCAL_Y * k },
        beside,
      )
      plate.object.position.set(to.x + at.x, to.y, to.z)
      plate.object.scale.setScalar(lapAskScale(beside) * k)
      plate.object.name = 'lap-ask'
      askPlacedBeside = beside
    }
    plate.setVisible(true)
    const rows = askRows()
    if (ctx.render.renderer.xr.isPresenting) {
      // The head or a laser aims a row while it is ON one. Off the plate, an
      // aim the ray made goes back home: a glance that crossed POST TO
      // LEADERBOARD? on the way to somewhere else must not leave A posting.
      // An aim the stick or D-pad made stays where it was put.
      const looked = ctx.aimPlate(plate.object, (o, d) => plate.pick(o, d, rows.length))
      if (looked >= 0) {
        askAimId = rows[looked]?.id ?? askAimId
        askAimByRay = true
        askAimDefault = false
      } else if (askAimByRay) {
        // Back to the lap's default (DEV-629), which is home unless it ranks.
        askAimId = lapAskOpeningRowFor(askFacts())
        askAimByRay = false
        askAimDefault = true
      }
    }
    plate.update({
      options: rows,
      selected: lapAskAimIndex(rows, askAimId),
      title: LAP_ASK_HEADING,
    })
  }

  /**
   * For a probe: where each row's centre is on the glass, CSS pixels, from the
   * plate's own layout (`rowCentreLocalY`) through the camera of the last
   * frame. A spec taps there, as a finger would; null while the plate is down.
   */
  const askCentres = (): { id: string; x: number; y: number }[] | null => {
    if (!askPlate?.object.visible) return null
    const rows = askRows()
    const rect = ctx.canvas.getBoundingClientRect()
    askPlate.object.updateWorldMatrix(true, false)
    return rows.map((r, i) => {
      const v = askPlate?.object.localToWorld(
        new THREE.Vector3(0, rowCentreLocalY(i, rows.length), 0),
      ) as THREE.Vector3
      v.project(ctx.render.camera)
      return {
        id: r.id,
        x: rect.left + ((v.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - v.y) / 2) * rect.height,
      }
    })
  }

  /** The panel as Share leaves it: its three prompts, and its block where the board was. */
  const withShare = (summary: RunSummary): RunSummary => {
    // DEV-467: a player course's panel shares the COURSE on this button (`coursePanelOf`).
    const course = ctx.coursePanelOf(summary)
    if (course) return course
    if (!lapAskUp()) return summary
    // DEV-571: A answers the menu under the panel (home, unless it was moved),
    // so the panel's primary line is the other way on: another go.
    return {
      ...summary,
      again: summary.back,
      // DEV-599: the device's own words, as the panel's lines are.
      back: rowBelowWords(ctx.confirmDevice()),
      share: shareBlock(share, shareOffered(), ctx.tvOn()),
    }
  }

  /** Post the lap on the panel under the handle on screen. Never throws. */
  const postLap = async (): Promise<void> => {
    const lap = ctx.lapRun?.last ?? null
    const handle = share.handle
    if (!lap || lap.seconds === null || handle === null) return
    owner ??= ownerKey(cryptoRandomBytes)
    saveHandle(handle)
    sharePosts += 1
    const result = await submitLap({ doc: lap.doc, seconds: lap.seconds, handle, owner })
    // Another go while it was in flight has a Share of its own; this answer
    // belongs to a lap that is no longer on the panel.
    if (ctx.lapRun?.last !== lap || share.phase !== 'posting') return
    if (!result.ok) {
      share = shareFailed(share, result.reason)
      console.warn(`share: not posted (${result.status} ${result.error}): ${result.reason}`)
      return
    }
    stats.count('posts')
    const link = shareLink(location.host, result.id)
    share = sharePosted(share, {
      id: result.id,
      link,
      board: result.board,
      rank: result.rank,
      boardReason: result.boardReason,
    })
    console.info(
      `share: posted ${result.id} as ${handle}, ` +
        `${result.board ? `#${result.rank} on the board` : `not on the board (${result.boardReason})`}: ${link}`,
    )
    // Flat, the link goes on the clipboard too: a link that can be pasted is
    // the one that gets sent. Best effort; the panel prints it either way.
    if (shareRoute() === 'flat') {
      void navigator.clipboard?.writeText(`${location.protocol}//${link}`).then(
        () => {
          if (share.id === result.id) share = { ...share, copied: true }
        },
        () => {},
      )
    }
  }

  /**
   * DEV-374: take the posted lap back off the server, with this device's owner
   * key (§8 call 6, "deletable by their owner"). The press that asks and the
   * press that sends are `game/lap-share.ts`'s; this is only the call. Never
   * throws.
   */
  const removeLap = async (): Promise<void> => {
    const id = share.id
    if (id === null) return
    owner ??= ownerKey(cryptoRandomBytes)
    const result = await deleteLap(id, owner)
    // A new run while it was in flight has a panel of its own.
    if (share.id !== id || share.phase !== 'deleting') return
    if (!result.ok) {
      share = deleteFailed(share, result.reason)
      console.warn(`share: not deleted (${result.status} ${result.error}): ${result.reason}`)
      return
    }
    share = shareDeleted(share)
    console.info(`share: deleted ${id}`)
  }

  /** One course card's ghost pick, and what it has fetched. */
  interface PickState {
    pick: GhostPick
    board: BoardView | null
    /** The lap the pick names once it is here, and the id on its way. */
    lap: SharedLap | null
    lapId: string | null
    /**
     * DEV-650: set by the results panel's "next lap to beat" (`armRetryGhost`),
     * not by a press on the card. A pick that is `auto` is the player's default
     * and may be re-armed by the next finish; a press makes a pick theirs.
     */
    auto?: boolean
  }
  /** Keyed by course, aircraft variant and preset: a card is all three (DEV-382). */
  const ghostPicks = new Map<string, PickState>()
  const pickKey = (mission: string, variant: string, edition: string): string =>
    `${mission}|${variant}|${edition}`
  /** `?ghost=<id>`'s lap, once fetched. */
  let linkGhost: SharedLap | null = null
  let linkState: 'loading' | 'ready' | 'gone' | null = GHOST_LINK_ID ? 'loading' : null

  const pickFor = (mission: string, variant: string, edition: string): PickState => {
    const kept = ghostPicks.get(pickKey(mission, variant, edition))
    if (kept) return kept
    // The link's course, in the link's aircraft, opens on the link's lap —
    // whichever door the player comes in by.
    return linkGhost !== null && linkGhost.mission === mission && linkGhost.variant === variant
      ? { pick: 'link', board: null, lap: linkGhost, lapId: linkGhost.id }
      : { pick: DEFAULT_GHOST_PICK, board: null, lap: null, lapId: null }
  }

  /**
   * The courses module, lazily (DEV-372 §7: 155 KB, and only a race needs it —
   * here, the card's `rules` to find your kept lap by). Null until it lands,
   * and the cards are relabelled when it does.
   */
  let lapCourses: typeof import('@/net/lap-courses') | null = null
  let lapCoursesAsked = false
  const coursesNow = (): typeof import('@/net/lap-courses') | null => {
    if (lapCourses === null && !lapCoursesAsked) {
      lapCoursesAsked = true
      void import('@/net/lap-courses').then(
        (m) => {
          lapCourses = m
          ctx.hangar?.relabel()
        },
        (err: unknown) => console.warn('ghost line: the lap-server courses did not load', err),
      )
    }
    return lapCourses
  }

  /** Your kept lap's seconds on a card's course, preset and aircraft, or null. */
  const keptSeconds = (card: MissionCard, variant: string, edition: string): number | null => {
    const courses = coursesNow()
    if (!courses) return null
    return (
      readLap({
        mission: card.id,
        mode: card.mode,
        edition,
        rules: courses.lapRules(card.id, edition, variant) ?? LOCAL_LAP_RULES,
        vehicle: courses.lapVehicle(card.vehicle, variant),
        variant,
      })?.seconds ?? null
    )
  }

  /** A course card's ghost line, with its button; null where the mode races nobody. */
  const ghostLineFor = (card: MissionCard): string | null => {
    if (!rulesFor(card.mode).opponents || coursesNow() === null) return null
    const edition = ctx.editionState.rules.id
    const variant = card.variant ?? STANDARD_VARIANT_ID
    const state = pickFor(card.id, variant, edition)
    const line = ghostLine(state.pick, {
      mine: keptSeconds(card, variant, edition),
      board: state.board,
      link:
        state.pick === 'link' && state.lap
          ? { handle: state.lap.handle, seconds: state.lap.seconds }
          : null,
    })
    return `${line} ${ctx.render.renderer.xr.isPresenting ? '[R STICK]' : '[R/Y]'}`
  }

  /**
   * The waiting run's ghost, chosen again after a pick or a fetch moved it —
   * only while that run has not been let go (a ghost swapped mid-lap would be
   * another race), and only for the world that is built.
   */
  const repickGhost = (): void => {
    if (!ctx.lapRun || ctx.lapRun.tick >= 0 || ctx.launch.phase !== 'waiting') return
    const racing = ctx.lapRun.newRun(ctx.editionState.rules.id)
    ctx.livePlayerGhost?.setLap(racing?.doc ?? null, ghostTagText(racing))
  }

  /** Laps fetched this page, by id: a lap never changes, so a cycle back to it costs nothing. */
  const sharedLaps = new Map<string, SharedLap>()

  /** Fetch the lap a pick names, when it names one that is not already here. */
  const fetchPickLap = (key: string, state: PickState, mine: number | null): void => {
    const entry = pickEntry(state.pick, state.board, mine)
    if (!entry) {
      state.lap = null
      state.lapId = null
      return
    }
    if (state.lapId === entry.id) return
    state.lapId = entry.id
    state.lap = sharedLaps.get(entry.id) ?? null
    if (state.lap) {
      repickGhost()
      return
    }
    void fetchLap(entry.id).then((r) => {
      if (!r.ok) {
        console.warn(`ghost line: lap ${entry.id} did not load: ${r.reason}`)
        return
      }
      sharedLaps.set(entry.id, r.lap)
      if (ghostPicks.get(key) !== state || state.lapId !== entry.id) return
      state.lap = r.lap
      repickGhost()
    })
  }

  /** The race button on a course card: its next ghost (`nextGhostPick`). */
  const cycleGhost = (card: MissionCard): void => {
    const edition = ctx.editionState.rules.id
    const variant = card.variant ?? STANDARD_VARIANT_ID
    const key = pickKey(card.id, variant, edition)
    const was = pickFor(card.id, variant, edition)
    // DEV-488 follow-up: only a course the lap server has a board for may pick
    // one, by the results panel's own test (`resultsBoardKey`). A player
    // course's `pc_` id never reaches the server (/privacy).
    const courses = coursesNow()
    const boardable = courses !== null && courses.lapRules(card.id, edition, variant) !== null
    const state: PickState = {
      pick: nextGhostPick(was.pick, boardable),
      board: was.board,
      lap: null,
      lapId: null,
    }
    ghostPicks.set(key, state)
    const mine = keptSeconds(card, variant, edition)
    if (
      boardable &&
      pickNeedsBoard(state.pick) &&
      (state.board === null || state.board.status === 'failed')
    ) {
      // The one fetch the opt-in asks for (§8 call 8), once per card until it fails.
      state.board = { status: 'loading' }
      void fetchBoard({ mission: card.id, mode: card.mode, edition, variant }).then((r) => {
        const view: BoardView = r.ok
          ? { status: 'ready', entries: r.entries }
          : { status: 'failed', reason: r.reason }
        if (!r.ok) console.warn(`ghost line: no board for ${card.id}: ${r.reason}`)
        const live = ghostPicks.get(key)
        if (live) {
          live.board = view
          fetchPickLap(key, live, mine)
        }
        ctx.hangar?.relabel()
      })
    } else {
      fetchPickLap(key, state, mine)
    }
    console.info(`ghost line: ${card.id} in the ${variant}, ${edition}: ${state.pick}`)
    ctx.hangar?.relabel()
    repickGhost()
  }

  /**
   * DEV-650: a repeat attempt races the lap just above the one flown, unless the
   * player has picked a ghost for this card (`retryGhost`). Armed through the
   * hangar card's own 'above' pick, so the card's ghost line says what the next
   * run will race and a press on it takes the pick over. The lap is fetched now,
   * while the results are up, so it is here by the time fly-again is pressed;
   * `repickGhost` swaps it in if the press came first.
   */
  const armRetryGhost = (entries: readonly BoardEntry[], mine: number): void => {
    if (!ctx.flight) return
    const edition = ctx.editionState.rules.id
    const variant = ctx.flight.variant
    const key = pickKey(ctx.level.id, variant, edition)
    const kept = ghostPicks.get(key)
    // Theirs: a press on the card, or the link's lap that opened this page.
    const chosen =
      (kept !== undefined && kept.auto !== true) ||
      pickFor(ctx.level.id, variant, edition).pick === 'link'
    const entry = retryGhost(chosen, entries, mine)
    if (!entry) return
    const state: PickState = {
      pick: 'above',
      board: { status: 'ready', entries },
      lap: null,
      lapId: null,
      auto: true,
    }
    ghostPicks.set(key, state)
    fetchPickLap(key, state, mine)
    console.info(`ghost line: ${ctx.level.id}: the next lap up (${entry.handle}) for the next run`)
  }

  /** What each new run of a course races (`LapRunOptions.chosen`). */
  const chosenGhost = (mission: string, variant: string): ChosenGhost => {
    const state = pickFor(mission, variant, ctx.editionState.rules.id)
    if (state.pick === 'best') return { kind: 'best' }
    if (state.pick === 'none') return { kind: 'none' }
    // A pick that names a lap races it once it is here, and nothing before:
    // "WORLD #1 · LOADING" must not race your best under another name.
    return state.lap
      ? { kind: 'shared', doc: state.lap.doc, handle: state.lap.handle }
      : { kind: 'none' }
  }

  // The link, fetched at boot. The title reads `linkGhost` (`titleRows`).
  if (GHOST_LINK_ID) {
    void fetchLap(GHOST_LINK_ID).then((r) => {
      if (!r.ok) {
        linkState = 'gone'
        document.body.dataset.ghostLink = 'gone'
        console.warn(`ghost link: ${GHOST_LINK_ID}: ${r.reason}`)
        return
      }
      linkGhost = r.lap
      linkState = 'ready'
      document.body.dataset.ghostLink = r.lap.mission
      console.info(
        `ghost link: ${r.lap.handle}, ${r.lap.seconds.toFixed(2)} s on ${r.lap.mission} ` +
          `(${r.lap.edition}, ${r.lap.variant}), ${r.lap.doc.keyCount} keys`,
      )
      ctx.hangar?.relabel()
    })
  }

  /**
   * Board a link's lap (DEV-373): its aircraft VARIANT, as the hangar's board
   * would hold it (`boardedVariant`: this load only). Returns the course to
   * race.
   *
   * It used to board the lap's PRESET for the page too, because the time on a
   * link means something only under the rules it was flown under. Since
   * DEV-452 (D35) there is one set of rules and one set of boards, so the page
   * already flies them, and the player's look is the player's. A lap from a
   * Classic board (written before D35) is raced as a ghost under the page's
   * rules; the console says so.
   */
  const boardLinkGhost = async (lap: SharedLap): Promise<string> => {
    if (lap.edition !== ctx.editionState.rules.id) {
      console.info(
        `ghost link: a ${lap.edition} lap, raced under ${ctx.editionState.rules.id}'s rules (DEV-452)`,
      )
    }
    const vehicle = lap.doc.vehicle.split(':')[0] as VehicleId
    if (ctx.editionState.rules.gameplay.variants.enabled) boardedVariant.set(vehicle, lap.variant)
    return lap.mission
  }

  /** `__ff2.share()`. */
  const shareReport = (): ShareReport => {
    const panel = ctx.lastResult ? withShare(ctx.lastResult) : null
    const page = ctx.hangar?.pages[ctx.hangar.page] ?? []
    const cards: { id: string; line: string | null }[] = []
    for (const slot of page) {
      if (slot?.kind === 'course')
        cards.push({ id: slot.mission.id, line: ghostLineFor(slot.mission) })
      // DEV-420: a place's table is the card of the course it has PICKED.
      if (slot?.kind === 'place' && ctx.hangar) {
        const pick = ctx.hangar.pickFor(slot.place)
        cards.push({ id: pick.id, line: ghostLineFor(pick) })
      }
    }
    return {
      offered: shareOffered(),
      phase: share.phase,
      handle: share.handle,
      id: share.id,
      link: share.link,
      board: share.board,
      rank: share.rank,
      reason: share.reason,
      posts: sharePosts,
      prompts: panel ? { again: panel.again, race: panel.race ?? '', back: panel.back } : null,
      linkGhost:
        GHOST_LINK_ID && linkState
          ? {
              id: GHOST_LINK_ID,
              state: linkState,
              mission: linkGhost?.mission ?? null,
              variant: linkGhost?.variant ?? null,
              edition: linkGhost?.edition ?? null,
              handle: linkGhost?.handle ?? null,
              keys: linkGhost?.doc.keyCount ?? null,
            }
          : null,
      cards,
      aboard: ctx.flight ? { mission: ctx.level.id, variant: ctx.flight.variant } : null,
      ask: askFacts()
        ? {
            up: lapAskUp(),
            rows: askRows().map((r) => ({ id: r.id, label: r.label, value: r.value ?? null })),
            aim: askAimId,
            centres: askCentres(),
          }
        : null,
    }
  }

  // ── DEV-431: the course's board on the results panel ───────────────────
  //
  // Matt: *"i don't see leaderboards in the game at all - in the past, they
  // were shown at the mission results screen."* 2016's results room listed the
  // course's top five beside the score (`game/results-board.ts` has what it
  // drew, and where). This block fetches the board of the run on the panel and
  // hands `render/results.ts` its plate, which hangs above the panel.
  //
  //   WHICH board   the run's course, preset and aircraft variant — the board a
  //                 Share of this lap would be filed on (DEV-380) — and only
  //                 where the lap server keeps one (`lapRules`: Ring Attack's
  //                 six courses). Never in a room: a room's panel is the room's
  //                 standings, and a room lap is never boarded (§11 call 10),
  //                 so the solo board there would be a list you cannot be on.
  //   WHEN          the first frame the panel holds a run, and again, UNCACHED,
  //                 once a Share lands and once a delete does, so the list
  //                 holds (or loses) the lap the panel just named. The server
  //                 answers `max-age=30`: a refetch the browser answered from
  //                 its cache would print the board without the lap the share
  //                 block had just called "#2 ON THE BOARD".
  //   WHAT IS SENT  a GET of a public list, the course in its path. No handle,
  //                 no owner key, no lap. Which line is yours is decided here,
  //                 from what the device already holds (`isMine`).
  //
  // Read off the STATE the frame loop already has — a new `lastResult`, Share's
  // phase — not hung on the presses, so a post, a delete and a new run are each
  // seen once, however they came about.

  interface ResultsBoardRun {
    /** The panel's run this board belongs to; a new run is a new board. */
    readonly result: RunSummary
    /** Null: this run's course keeps no board, or it is a room's. Nothing is fetched. */
    readonly key: BoardKey | null
    readonly edition: string
    readonly variant: string | null
    fetch: ResultsBoardFetch
    refreshing: boolean
    /** The device's kept handle as the run ended; Share's, once it posts. */
    handle: string | null
    /** DEV-650: the next-lap ghost was armed for this run (once). */
    armed?: boolean
  }
  let resultsBoard: ResultsBoardRun | null = null
  /** Lap ids this page posted and has not taken back: exactly yours. */
  const postedLapIds = new Set<string>()
  /** Board requests sent from the results panel, for the probe. */
  let resultsBoardFetches = 0

  /** The board the run on the panel would be filed on, or null where there is none. */
  const resultsBoardKey = (courses: NonNullable<typeof lapCourses>): BoardKey | null => {
    if (ctx.roomActive() || !ctx.flight) return null
    const edition = ctx.editionState.rules.id
    const variant = ctx.flight.variant
    if (courses.lapRules(ctx.level.id, edition, variant) === null) return null
    if (courses.lapCourse(ctx.level.id)?.mode !== ctx.mission.mode) return null
    return { mission: ctx.level.id, mode: ctx.mission.mode, edition, variant }
  }

  /** Ask for the run's board. `fresh` goes past the browser's cache (see the header). */
  const loadResultsBoard = (run: ResultsBoardRun, fresh: boolean): void => {
    const key = run.key
    if (!key) return
    resultsBoardFetches += 1
    void fetchBoard(key, fetch, '', fresh).then((r) => {
      // A newer run owns the panel; this answer is for one that is gone.
      if (resultsBoard !== run) return
      run.fetch = r.ok
        ? { status: 'ready', entries: r.entries }
        : { status: 'failed', offline: r.status === 0, reason: r.reason }
      run.refreshing = false
      const which = `${key.mission} ${key.edition} ${key.variant}`
      if (r.ok) console.info(`results board: ${which}, ${r.entries.length} laps`)
      else console.warn(`results board: ${which}: ${r.status} ${r.error}: ${r.reason}`)
    })
  }

  /** Again, uncached, keeping the lines on screen until the answer lands. */
  const refreshResultsBoard = (run: ResultsBoardRun): void => {
    if (run.fetch.status !== 'ready') run.fetch = { status: 'loading' }
    run.refreshing = true
    loadResultsBoard(run, true)
  }

  /** The panel's run with its board plate; unchanged where the course keeps none. */
  const withResultsBoard = (summary: RunSummary): RunSummary => {
    if (!ctx.lastResult || !ctx.flight) return summary
    if (resultsBoard?.result !== ctx.lastResult) {
      // The courses module is lazy (DEV-372 §7); until it lands, no plate yet.
      const courses = coursesNow()
      if (!courses) return summary
      const key = resultsBoardKey(courses)
      const variant = ctx.flight.variant
      resultsBoard = {
        result: ctx.lastResult,
        key,
        edition: ctx.editionState.rules.title,
        // A board per variant only where the preset flies more than one.
        variant: ctx.editionState.current.gameplay.variants.enabled
          ? (aircraftFor(ctx.level.vehicle).variants.find((v) => v.id === variant)?.name ?? variant)
          : null,
        fetch: { status: 'loading' },
        refreshing: false,
        handle: readHandle(),
      }
      loadResultsBoard(resultsBoard, false)
    }
    const run = resultsBoard
    if (!run.key) return summary
    // Share's answers, seen once each: a lap posted joins your lines, a lap
    // taken back leaves them, and either way the board is asked again.
    if (share.phase === 'posted' && share.id !== null && !postedLapIds.has(share.id)) {
      postedLapIds.add(share.id)
      run.handle = share.handle ?? run.handle
      refreshResultsBoard(run)
    } else if (share.phase === 'deleted' && share.id !== null && postedLapIds.has(share.id)) {
      postedLapIds.delete(share.id)
      refreshResultsBoard(run)
    }
    // Where the lap on the panel would stand: only a lap Share would post to
    // THIS board — clean, every ring — and only before it is sent.
    const lap = ctx.lapRun?.last ?? null
    const unsent = share.phase === 'idle' || share.phase === 'posting' || share.phase === 'failed'
    const eligible =
      unsent && shareOffered() && lap?.seconds != null && summary.gates === summary.gatesTotal
        ? lap.seconds
        : null
    // DEV-650: the lap to beat next, for a lap that took every ring (a run with
    // a ring still to take has a medal line instead, and the two never meet).
    const beat =
      run.fetch.status === 'ready' && summary.gates === summary.gatesTotal
        ? nextBeat(run.fetch.entries, { posted: postedLapIds, handle: run.handle, eligible })
        : null
    if (beat && run.fetch.status === 'ready' && !run.armed) {
      run.armed = true
      armRetryGhost(run.fetch.entries, beat.mine)
    }
    return {
      ...summary,
      next: beat ? nextBeatLine(beat) : summary.next,
      world: resultsBoardView({
        fetch: run.fetch,
        refreshing: run.refreshing,
        edition: run.edition,
        variant: run.variant,
        posted: postedLapIds,
        handle: run.handle,
        eligible,
      }),
    }
  }

  /** `__ff2.resultsBoard()`. */
  const resultsBoardReport = (): ResultsBoardReport | null =>
    resultsBoard
      ? {
          key: resultsBoard.key,
          status: resultsBoard.key ? resultsBoard.fetch.status : null,
          refreshing: resultsBoard.refreshing,
          fetches: resultsBoardFetches,
          drawn: ctx.lastResult ? (ctx.flight?.results.drawn?.world ?? null) : null,
        }
      : null

  // ── DEV-361: the race map, and your place on it ────────────────────────
  //
  // A plate beside the readout — a CHILD of it, so the placement, the
  // third-person camera and the pause menu all carry it (`render/race-map.ts`
  // says why), with a dot per ship and `#2/6`. Built where the racers are, in
  // `buildWorld` and BEFORE the warm, so its one program compiles under the
  // curtain rather than on the first frame of flight; and re-checked every
  // frame, which is how a preset flip, a course swap and a restart that
  // rebuilds the racers all land without a hook of their own.
  //
  // Only where the MODE races (`rulesFor(mode).opponents`, never a mode name)
  // and live AI racers fly. Under `?opponents=ghosts` there is no map: the
  // recordings take no gates, and that fallback is a development switch
  // (DEV-344 says the same of their results).
  let raceMap: RaceMap | null = null
  let raceMapLine: RaceLine | null = null
  /** What the live map was built for. A change to any of the three rebuilds it. */
  let raceMapFor: {
    hud: THREE.Object3D
    /** The racers, or a room's field (DEV-390): whichever the dots are. */
    racers: object
    spec: Edition['hud']['raceMap']
  } | null = null
  const syncRaceMap = (hud: THREE.Object3D): void => {
    const spec = ctx.editionState.current.hud.raceMap
    const racers = ctx.liveRacers
    // DEV-390: in a room the dots are the other players, on the same guide.
    const roomField = ctx.roomActive() ? ctx.roomMapField() : null
    const field = roomField ?? racers
    const wanted =
      spec.enabled &&
      rulesFor(ctx.mission.mode).opponents &&
      (roomField ? roomField.slots.length > 0 : racers !== null && racers.count > 0)
    const current =
      raceMapFor !== null &&
      raceMapFor.hud === hud &&
      raceMapFor.racers === field &&
      raceMapFor.spec === spec
    if (wanted && current) return
    if (raceMap) {
      raceMap.object.removeFromParent()
      raceMap.dispose()
      raceMap = null
      raceMapLine = null
      raceMapFor = null
    }
    if (!wanted || field === null) return
    // The line the racers follow, so every entrant is measured along ONE line.
    // Every HoverJet mission ships a route; the gate polyline is `?guide=off`.
    const line = roomField
      ? roomField.line
      : (racers?.guide ?? racers?.racers[0]?.fallbackCourse ?? null)
    if (!line) return
    raceMapLine = line
    raceMap = createRaceMap({
      line,
      finish: roomField ? roomField.finish : (racers?.racers[0]?.finish ?? null),
      racerColours: roomField
        ? roomField.colours
        : (racers?.racers.map((r) => r.spec.colour ?? null) ?? []),
      size: spec,
      redraw: ctx.hudRedraw,
    })
    hud.add(raceMap.object)
    raceMapFor = { hud, racers: field, spec }
  }
  return {
    lapAskUp,
    ghostLineFor,
    shareRoute,
    chosenGhost,
    syncRaceMap,
    boardLinkGhost,
    askNudge,
    askPointer,
    askConfirm,
    cycleGhost,
    withResultsBoard,
    withShare,
    opponentStandings,
    playerGhostStandings,
    askFrame,
    shareReport,
    resultsBoardReport,
    get share() {
      return share
    },
    set share(v: ShareState) {
      share = v
    },
    get linkGhost() {
      return linkGhost
    },
    get raceMap() {
      return raceMap
    },
    get raceMapLine() {
      return raceMapLine
    },
  }
}
