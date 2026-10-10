// src/boot/app/hangar/menus.ts: menu aim, the laser, the pause plate and its
// pages, and the one settings sink, out of `bootApp`. APP-SPLIT phase 4,
// slice 6 (hangar and menus; `docs/plan/APP-SPLIT.md` §5).
//
// The laser pointer (DEV-321) and the aim every plate is picked by, the pause
// plate's rows and pages (DEV-223, DEV-621), `onSettings` (the ONE place a
// settings change lands), the comfort, controls, edition, credits, report-bug,
// options and advanced pages, and the row counts a player sees. Every line
// below was moved verbatim from the closure; the plumbing is `ctx.x` where the
// code reads a binding the closure still owns (a getter, so a check narrows as
// the closure's `let` did, and a setter where this code writes one:
// `pauseAim`, and `onSettings`'s `comfort`, `qualityPins` and
// `chosenEdition`: the §6 rule 3 bag, owners in phase 3), and the returned object.

import * as THREE from 'three'
import type { AudioSystem } from '@/audio'
import type { TitleVr } from '@/boot/enter-vr'
import type { Feel } from '@/boot/feel'
import type { PerfCapture } from '@/boot/perf-capture'
import { clearMovedPins, type QualityPins } from '@/boot/quality-pin'
import { type ComfortSettings, editionInForce } from '@/boot/settings'
import { stats } from '@/boot/stats-beacon'
import { BUILD_CHANNEL } from '@/content/build-channel'
import type { Edition, EditionId } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { uiString } from '@/content/ui-strings'
import type { EditionState } from '@/game/edition'
import type { Flight } from '@/game/flight'
import type { MissionState } from '@/game/mission'
import type { TvView } from '@/game/tv/tv-view'
import { createEdge } from '@/input/edge'
import type { MouseLook } from '@/input/look'
import { createRowStepper } from '@/input/menu-step'
import { createPointerArbiter, type PointerHand } from '@/input/pointer-hand'
import { ADVANCED_OPTION, type AdvancedMenu, createAdvancedMenu } from '@/render/advanced-menu'
import { COMFORT_OPTION, type ComfortMenu, createComfortMenu } from '@/render/comfort-menu'
import type { ControlsDevice } from '@/render/controls-menu'
import { CONTROLS_OPTION, type ControlsMenu, createControlsMenu } from '@/render/controls-menu'
import { CREDITS_OPTION, type CreditsMenu, createCreditsMenu } from '@/render/credits-menu'
import { type CreditsRoll, createCreditsRoll } from '@/render/credits-roll'
import { headForward, readHeadPose } from '@/render/head-pose'
import {
  createOptionsMenu,
  HUB_PAGE_IDS,
  MORE_OPTION,
  MORE_TITLE,
  moreRows,
  OPTIONS_OPTION,
  type OptionsMenu,
  optionsRows,
  REPORT_BUG_OPTION,
} from '@/render/options-menu'
import {
  bodyCentreLocalY,
  closeOpenPausePage,
  openPausePage,
  WIDTH as PANEL_WIDTH,
  type PauseDoorPage,
  type PauseOption,
  type PausePage,
  pageOpenedBy,
  pageToPress,
  pausePage,
  ROOT_PAGE,
  shutPausePages,
  syncPausePages,
} from '@/render/pause'
import type { Renderer } from '@/render/renderer'
import { createErrorRing, createReportBugMenu, type ReportBugMenu } from '@/render/report-bug-menu'
import type { Vignette } from '@/render/vignette'
import { createXrPointer, planeHitDistance } from '@/render/xr-pointer'
import { FIXED_DT } from '@/sim/constants'
import { captureRowValue } from '../../perf-capture'
import { BUILD_VERSION } from '../../version'
import type { createLessonHost } from '../flight/lesson'
/** What `createMenus` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
import { _headQuat, cameraWorld, gazeDirection } from '../head-scratch'
import { EDITOR_RECORD, EDITOR_RUN, PERF_HUD } from '../pins'
import type { BootOptions } from '../types'

export interface MenusCtx {
  readonly SKIP_STEP_OPTION: PauseOption
  readonly applyVolume: (s: ComfortSettings) => void
  readonly audio: AudioSystem
  readonly canvas: HTMLCanvasElement
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  chosenEdition: EditionId
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  comfort: ComfortSettings
  readonly confirmDevice: () => ControlsDevice
  readonly editionState: EditionState
  readonly feel: Feel
  readonly flight: Flight | null
  readonly lapAskUp: () => boolean
  readonly lessonHost: ReturnType<typeof createLessonHost>
  readonly level: Level
  readonly mission: MissionState
  readonly mouseLook: MouseLook
  readonly options: BootOptions
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  pauseAim: number
  readonly paused: boolean
  readonly perfCapture: PerfCapture
  readonly pinned: (settings: ComfortSettings) => ComfortSettings
  readonly presetFor: (id: EditionId) => Promise<Edition>
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  qualityPins: QualityPins
  readonly render: Renderer
  readonly roomActive: () => boolean
  readonly screen: 'title' | 'menu' | 'mission'
  readonly titleMenuUp: () => boolean
  readonly titleVr: TitleVr
  readonly tvView: TvView
  readonly vignette: Vignette
  readonly wearEdition: (where: 'menus' | 'mission') => void
}

export const createMenus = (ctx: MenusCtx) => {
  // ── the laser pointer: a motion controller aims the menus (DEV-321) ─────
  //
  // Matt, 2026-09-23: *"laser pointer from motion controller plz"*. The
  // pickers already take a ray and the confirm is already device-blind
  // (DEV-301), so this is a ray and a beam, not a new way to pick. WHICH hand
  // is `input/pointer-hand.ts`; where its ray comes from and what is drawn is
  // `render/xr-pointer.ts`. The beam lives under the RIG, which is what carries
  // the reference space the pose is in: three writes a pose in the session's
  // REFERENCE space, and the camera is a child of the rig for the same reason.
  //
  // It is the ONLY laser. Do not hang one on a `getController(i)` group: those
  // groups are keyed by SLOT, and after the Frame's `+2 -2` input-source swap a
  // slot is not a hand.
  const xrPointer = createXrPointer()
  ctx.render.rig.add(xrPointer.object)
  const pointerArbiter = createPointerArbiter()
  /** The ray the menus are aimed with this frame — a hand's or the head's. Volatile. */
  const _aimOrigin = new THREE.Vector3()
  const _aimDirection = new THREE.Vector3()
  /**
   * Is something up that the laser can aim at? The room's tables and plates,
   * the pause plate and its pages, the title's two rows once the valley is in
   * (DEV-353).
   * Never in flight: *"no beam while flying"* is this predicate being false.
   */
  const pointerWanted = (): boolean =>
    ctx.render.renderer.xr.isPresenting &&
    // DEV-480
    (ctx.screen === 'menu' ||
      ctx.paused ||
      ctx.titleMenuUp() ||
      ctx.tvView.plateUp() ||
      ctx.lapAskUp())
  /**
   * Fill `_aimOrigin` / `_aimDirection` from the pointing hand, or from the
   * head the caller has just read into `cameraWorld` / `gazeDirection` when no
   * hand points. Returns the hand, or null for the head — which is every flat
   * frame, so the flat build aims exactly as it did.
   */
  const aimMenus = (): PointerHand | null => {
    const hand = pointerWanted() ? pointerArbiter.choose(xrPointer.posed) : null
    if (hand !== null && xrPointer.ray(hand, ctx.render.rig, _aimOrigin, _aimDirection)) return hand
    _aimOrigin.copy(cameraWorld)
    _aimDirection.copy(gazeDirection)
    return null
  }
  /** A plate under the rig picked by the head or a laser (`pick`, its own), the beam shown. */
  const aimPlate = (o: THREE.Object3D, pick: (a: THREE.Vector3, b: THREE.Vector3) => number) => {
    readHeadPose(ctx.render.renderer.xr, ctx.render.camera, cameraWorld, _headQuat)
    headForward(_headQuat, gazeDirection)
    const hand = aimMenus()
    const looked = pick(_aimOrigin, _aimDirection)
    const at = looked >= 0 ? planeHitDistance(_aimOrigin, _aimDirection, o) : null
    if (hand !== null) xrPointer.show(hand, at, cameraWorld)
    return looked
  }
  /** One row per push on the pause plate's rows (`input/menu-step.ts`). */
  const pauseSteps = createRowStepper()
  /**
   * DEV-563 follow-up: the free CURSOR chose `pauseAim`, so the gaze, which
   * does not move while the pointer is free, does not take it back. Cleared
   * when the plate opens or closes and when the pointer is captured.
   */
  let pauseCursorAim = false
  const _cursorNdc = new THREE.Vector2()
  const _cursorRay = new THREE.Raycaster()
  /**
   * DEV-563 follow-up: the pause row under a point on the glass, CSS pixels,
   * or -1. The tap's picker (DEV-291) with the cursor as the thing that aims
   * it: a ray off the camera's last drawn pose into `flight.pause.pick`. Only
   * while the plate is up, flat, with the pointer free; anywhere else there is
   * no plate under a cursor to ask about.
   */
  const pauseRowAt = (x: number, y: number): number => {
    if (!ctx.paused || ctx.flight === null || ctx.mouseLook.locked) return -1
    if (ctx.render.renderer.xr.isPresenting) return -1
    const rect = ctx.canvas.getBoundingClientRect()
    if (!Number.isFinite(x + y) || !(rect.width > 0 && rect.height > 0)) return -1
    _cursorNdc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1)
    _cursorRay.setFromCamera(_cursorNdc, ctx.render.camera)
    return ctx.flight.pause.pick(
      _cursorRay.ray.origin,
      _cursorRay.ray.direction,
      pausePlate().rows.length,
    )
  }
  // A cursor click ON a pause row presses it and captures nothing; a click
  // anywhere else is the capture, as everywhere (`input/look.ts`'s `readClick`).
  ctx.mouseLook.setCursorTarget((x, y) => pauseRowAt(x, y) >= 0, 'pause')
  /** Edge state for the XR back button. See the B handling in the frame loop. */
  const pauseBackKey = createEdge()
  /**
   * Three, now that there is somewhere to exit TO.
   *
   * DEV-033b left this at two and said so: *"2016's third button loads
   * `main_menu`... FF2 has no main menu yet, so the choice was a dead button, a
   * button that reloads the tab and rebuilds the terrain for a minute, or no
   * button. The list takes a third entry the day there is somewhere to go."*
   *
   * The hangar is that somewhere (DEV-036), and it is already in the scene — so
   * EXIT is a change of screen rather than a scene load, and it costs nothing.
   */
  // The three labels are 2016's own, byte for byte — `identity` in
  // `tests/unit/extract-ui-strings.test.ts`, so the port changes nothing about
  // them. The NOTES underneath are FF2's: 2016's pause menu has no second line.
  /**
   * The comfort page, and ONE callback to the three things that consume a
   * setting — which is what stops a row added later from telling two of them.
   */
  /**
   * The plate as it stands: which page, its heading, and its rows.
   *
   * ONE function, because `pause.ts` derives its whole layout from the count it
   * is handed: the row band, the hit test and the paint all scale with it. Give
   * the clamp one list and the picker another and the bottom row becomes
   * unreachable on exactly one of them, which is the kind of thing nobody
   * notices until they are in a headset trying to press it.
   *
   * It returns the HEADING too, and the page's NAME, because those were two
   * more ladders over the same three `.open` flags — the title's written out
   * again in the frame loop, the name only ever implied — and three ladders
   * that agree today is the shape this file keeps paying for. `pausePage`
   * names no page but the root: a sub-page is identified by the row that opens
   * it, so `COMFORT_OPTION` is both the row you press and the answer to
   * *"which page am I on"*, and they cannot come apart (DEV-223).
   *
   * The rows are the LIVE list, dev rows and all. They have to be: `pauseAim`
   * indexes THIS list, so a walk down the plate under `?perf=1` lands where
   * this says it lands and nowhere else.
   */
  const pausePlate = (): PausePage =>
    pausePage(
      { title: uiString(ctx.level, 'pauseTitle', '- PAUSE -'), rows: pauseOptions() },
      pauseSubPages(),
    )

  /**
   * The plate's sub-pages, ONCE: what the plate draws (`pausePlate`), what the
   * A press acts on, which row opens which page, what BACK shuts and who is
   * handed a setting another page changed all loop over THIS list (`pageToPress`,
   * `pageOpenedBy` and the rest in `render/pause.ts`). Built on first use,
   * because the menus are declared below it.
   */
  let pauseSubPagesMemo: readonly PauseDoorPage<ComfortSettings>[] | null = null
  const pauseSubPages = (): readonly PauseDoorPage<ComfortSettings>[] =>
    (pauseSubPagesMemo ??= [
      // DEV-621: OPTIONS' own pages come FIRST and OPTIONS itself LAST. Each
      // is opened from OPTIONS, which stays open beneath it, and the first
      // open page wins, so the plate shows the deepest page and a page's
      // BACK lands on OPTIONS, one page up.
      { row: COMFORT_OPTION, menu: comfortMenu },
      { row: CONTROLS_OPTION, menu: controlsMenu },
      // DEV-614: the credits, a page of read-only rows and BACK.
      // DEV-623: it opens on nothing selected, with the roll back at its top.
      {
        row: CREDITS_OPTION,
        menu: creditsMenu,
        openAim: -1,
        onOpen: () => creditsRollFor().reset(),
      },
      // DEV-269's Advanced page landed while this branch was open, as a FOURTH
      // arm of the ladder this replaces. It is a fourth entry here instead —
      // which is the design working: *"a fifth page is a fifth entry in the
      // list `app.ts` hands in"*. Merging without it would have dropped the
      // page from every question the plate answers about itself.
      { row: ADVANCED_OPTION, menu: advancedMenu },
      // DEV-622: REPORT BUG, what a press would send and SEND.
      { row: REPORT_BUG_OPTION, menu: reportBugMenu },
      // DEV-859: MORE is a page of OPTIONS, and credits, effects and report
      // bug are pages of MORE, so it sits after them and before OPTIONS.
      { row: MORE_OPTION, menu: moreMenu },
      { row: OPTIONS_OPTION, menu: optionsMenu },
    ])

  /** Every page of the plate shut, so the next pause opens on the root. */
  const closePausePages = (): void => shutPausePages(pauseSubPages())

  /**
   * DEV-621: BACK one page (B, Backspace, a free Escape, a BACK row). From a
   * page of OPTIONS to OPTIONS, from OPTIONS to the root, the selection on
   * the row that opened the page left. False when the plate is on the root
   * already, where back means resume and the caller does that.
   */
  const pausePageBack = (): boolean => {
    const aim = optionsBack()
    if (aim === null) return false
    ctx.pauseAim = aim
    return true
  }

  /**
   * One page up, for whoever is showing the OPTIONS pages (the pause plate
   * here, the title's plate): the aim to land on, the row that opened the page
   * just left, or null when no page was open. Plays the back sound.
   */
  const optionsBack = (): number | null => {
    const left = pausePlate().page
    if (left === ROOT_PAGE) return null
    closeOpenPausePage(pauseSubPages())
    if (left === OPTIONS_OPTION.id) optionsBackNote = undefined
    const back = pausePlate()
    ctx.audio.event({ type: 'ui.back' })
    return Math.max(
      0,
      back.rows.findIndex((row) => row.id === left),
    )
  }

  /**
   * DEV-859: THE entry point to the OPTIONS pages, the same wherever they
   * open. The pause plate (`frame.ts`) calls it; the title's OPTIONS row and
   * the hangar's OPTIONS table call it too, each showing `rows` / `title` on
   * its own plate with `notesOnSelect` and routing its aim, its confirm and
   * its back to `press` and `back`. Nothing about the pages is known outside
   * this object.
   */
  const options = {
    /** Open OPTIONS (every other page shut first). Returns the aim to open on. */
    open(backNote?: string): number {
      shutPausePages(pauseSubPages())
      optionsBackNote = backNote
      optionsMenu.openPage()
      return 0
    },
    /** Shut every page, so the next open starts on OPTIONS (or the root). */
    close(): void {
      shutPausePages(pauseSubPages())
      optionsBackNote = undefined
    },
    /** Is any OPTIONS page up? OPTIONS is the outermost, so it is open whenever one is. */
    get up(): boolean {
      return optionsMenu.open
    },
    /** The page being shown: its name (the id of the row that opened it), title and rows. */
    plate: (): PausePage => pausePlate(),
    /**
     * One page up. The aim to land on, or null when none was open. Leaving
     * OPTIONS itself shuts it (`up` goes false) and lands on its row, which
     * the caller maps to its own plate.
     */
    back: optionsBack,
    /**
     * A press of A (or Enter, or a tap) on row `aim` of the page being shown.
     * Handles settings that change in place, the doors that open a page, the
     * pages' own rows and BACK. `handled` is false when the row is not one of
     * OPTIONS' (the pause plate's own RESUME, EXIT and the like), so the caller
     * falls through to its own. `now` is the frame's time, for the credits roll.
     */
    press(aim: number, now: number): { handled: boolean; aim: number; recenter: boolean } {
      const plate = pausePlate()
      const subs = pauseSubPages()
      const none = { handled: false, aim, recenter: false }
      const sub = pageToPress(subs)
      if (sub) {
        const action = sub.menu.activate?.(aim)
        if (action === 'back') {
          // The page shut itself: land on its row in the page it hangs off.
          const parent = pausePlate()
          return {
            handled: true,
            aim: Math.max(
              0,
              parent.rows.findIndex((row) => row.id === sub.row.id),
            ),
            recenter: false,
          }
        }
        // DEV-623: a press on the credits speeds the roll; BACK, above, does not.
        if (sub.row.id === CREDITS_OPTION.id) creditsFastUntil = now + CREDITS_FAST_MS
        return { handled: true, aim, recenter: action === 'recenter' }
      }
      if (plate.page !== ROOT_PAGE && !HUB_PAGE_IDS.has(plate.page)) return none
      const chosen = plate.rows[aim]?.id
      const opened = pageOpenedBy(subs, chosen)
      if (opened) return { handled: true, aim: openPausePage(opened), recenter: false }
      if (plate.page !== ROOT_PAGE && chosen === 'back') {
        return { handled: true, aim: optionsBack() ?? aim, recenter: false }
      }
      if (chosen !== undefined && comfortMenu.pressSetting(chosen)) {
        return { handled: true, aim, recenter: false }
      }
      return none
    },
  }

  /**
   * The ONE place a settings change lands, whichever page made it.
   *
   * Both pages sit on the same `ComfortSettings`, so each has to be handed the
   * result of the other's press — see `ComfortMenu.sync`. `sync` is silent, so
   * this cannot loop.
   */
  const onSettings = (next: ComfortSettings): void => {
    // A player who moved the quality or adaptive row has said something about
    // THIS load that is newer than the URL, so that pin drops and the menu owns
    // it from here. Computed against the OLD `comfort`, which is what the menu
    // was showing — a change to some other row leaves the pins alone.
    ctx.qualityPins = clearMovedPins(ctx.qualityPins, ctx.comfort, next)
    ctx.comfort = next
    ctx.feel.haptics.setEnabled(next.haptics) // DEV-637: the Controls page's HAPTICS row
    ctx.vignette.setSetting(next.vignette)
    // The menus keep — and save — `next`; only what reaches the renderer and
    // the edition carries the pin.
    ctx.render.quality.apply(ctx.pinned(next))
    ctx.applyVolume(next)
    syncPausePages(pauseSubPages(), next)
    // DEV-269. The Advanced page's rows are the last layer over the preset, and
    // this is where they reach it. BEFORE `setSettings` below, so a single press
    // produces ONE notification with both halves already in place rather than
    // two — the subscribers rebuild materials, and a feature that arrived on the
    // second of two notifies would have been drawn wrong for one frame.
    ctx.editionState.setFeatureOverrides(next.featureOverrides)
    // The speed slider, and anything else a feature reads off the settings.
    ctx.editionState.setSettings(ctx.pinned(next))
    // A FLIP of the LOOK (DEV-452: the rules are the page's, whatever this
    // says). DEV-451: the choice is remembered at once, and worn at once only
    // inside a mission (the Edition page is the pause plate's, so that is
    // where a press comes from); a menu goes on wearing Anniversary, and the
    // next mission puts the choice on at its black. The preset is a lazy
    // import, so the features read the old one until it lands, a frame or
    // two; a failed load is logged and leaves the old one live.
    const look = editionInForce(next, ctx.render.renderer.xr.isPresenting)
    if (look !== ctx.chosenEdition) {
      ctx.chosenEdition = look
      if (ctx.screen === 'mission') ctx.wearEdition('mission')
      else void ctx.presetFor(look).catch(() => undefined)
    }
  }

  const comfortMenu: ComfortMenu = createComfortMenu({
    settings: ctx.comfort,
    onChange: onSettings,
    presenting: () => ctx.render.renderer.xr.isPresenting, // DEV-581: no ultra in a headset
  })

  const controlsMenu: ControlsMenu = createControlsMenu({
    settings: ctx.comfort,
    onChange: onSettings,
  })

  // DEV-614 (Matt, 2026-10-03: *"add a "credits" panel to the options screen.
  // that's where credits should live (not the footer of the title)"*).
  const creditsMenu: CreditsMenu = createCreditsMenu({ version: BUILD_VERSION })
  /**
   * DEV-623: the roll the CREDITS page hangs in the plate's body, built on
   * the first open and re-hung on whichever cockpit's plate is up (`flight`
   * is rebuilt on every course swap). `CREDITS_BODY_M` is the body's height:
   * with one row (BACK) under it, the plate is the height a seven-row page is.
   */
  const CREDITS_BODY_M = 0.4
  /** DEV-623: one press of A runs the roll fast for this long, ms; a held A keeps it fast. */
  const CREDITS_FAST_MS = 1500
  let creditsFastUntil = 0
  let creditsRoll: CreditsRoll | null = null
  const creditsRollFor = (): CreditsRoll => {
    if (creditsRoll === null) {
      creditsRoll = createCreditsRoll({
        lines: creditsMenu.roll,
        width: PANEL_WIDTH * 0.9,
        height: CREDITS_BODY_M * 0.96,
      })
      creditsRoll.object.renderOrder = 13 // over the plate, which is 12
      creditsRoll.object.position.set(0, bodyCentreLocalY(CREDITS_BODY_M), 0.002)
    }
    return creditsRoll
  }

  /**
   * DEV-622: the last few errors this page saw, for REPORT BUG's ERRORS line.
   * Its own small ring, not the stats beacon's: that one runs only for a
   * player who has not opted out, and a report is its own explicit press.
   */
  const errorRing = createErrorRing()
  addEventListener('error', (e) => errorRing.push(e.message || String(e.error)))
  addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as { message?: unknown } | undefined
    errorRing.push(typeof reason?.message === 'string' ? reason.message : String(e.reason))
  })

  /** DEV-622: REPORT BUG. Its sender is `stats.reportBug()` (`boot/stats-beacon.ts`). */
  const reportBugMenu: ReportBugMenu = createReportBugMenu({
    snapshot: () => ({
      version: BUILD_VERSION,
      channel: BUILD_CHANNEL,
      screen: ctx.screen,
      mission: ctx.level.id,
      tick: Math.round(ctx.mission.elapsed / FIXED_DT),
      quality: String(ctx.render.quality.report.quality),
      device: ctx.render.renderer.xr.isPresenting
        ? 'headset'
        : ctx.confirmDevice() === 'touch'
          ? 'phone'
          : 'desktop',
      errors: errorRing.recent,
    }),
    // The analytics sender (a `bug` row, answered with a short id) unless a caller supplies one.
    reportBug: ctx.options.reportBug ?? (() => stats.reportBug()),
  })

  /**
   * DEV-621, DEV-859: the OPTIONS page. MUTE, VOLUME, INVERT PITCH and LOOK
   * show their value and change in place; COMFORT, CONTROLS and MORE are
   * doors; BACK. A getter, as the root's rows are, because the values move.
   */
  /** Where OPTIONS' BACK row says it goes: set by whoever opens the page, spent on leaving it. */
  let optionsBackNote: string | undefined
  const optionsMenu: OptionsMenu = createOptionsMenu(() =>
    optionsRows({
      settings: ctx.comfort,
      presenting: ctx.render.renderer.xr.isPresenting,
      comfort: COMFORT_OPTION,
      controls: CONTROLS_OPTION,
      dev: [],
      backNote: optionsBackNote,
    }),
  )

  /** DEV-859: MORE, under OPTIONS: quality and the race strip in place, then the doors. */
  const moreMenu: OptionsMenu = createOptionsMenu(
    () =>
      moreRows({
        settings: ctx.comfort,
        // DEV-334: the quality row shows a `?quality=` pin while it is in force.
        qualityPin: ctx.qualityPins.quality,
        presenting: ctx.render.renderer.xr.isPresenting,
        effects: ADVANCED_OPTION,
        credits: CREDITS_OPTION,
      }),
    MORE_TITLE,
  )

  // DEV-269. `live` is a GETTER, not the edition: the rows re-read the preset
  // after every press and after entering VR, because what a row shows is what
  // the renderer is DOING (preset + the VR layer + the overrides composed) and
  // not what the player asked for. Those two disagree exactly in the headset.
  const advancedMenu: AdvancedMenu = createAdvancedMenu({
    settings: ctx.comfort,
    live: () => ctx.editionState.current,
    // DEV-302. The edition cannot see this: `render/bloom.ts` refuses to
    // composite while `renderer.xr.isPresenting` whatever the preset says, and
    // `render.bloom` is deliberately NOT in `vr.disable` because it does not
    // have to be. So the row read "on" for a pass that has never run in a
    // headset — in the one place this page exists for.
    presenting: () => ctx.editionState.immersive,
    onChange: onSettings,
  })

  /**
   * The root pause plate. A FUNCTION, because MUTE shows its own state.
   *
   * It was a const, and the mute row is the reason it is not: a toggle that
   * does not say which way it is currently set turns every press into an
   * experiment, and at two in the morning the experiment is "turn the sound
   * back on". Rebuilding five small objects per paused frame is what
   * `comfortMenu.rows` has always done for eight.
   */
  const pauseOptions = (): readonly PauseOption[] => [
    { id: 'resume', label: uiString(ctx.level, 'pauseResume', 'Resume'), note: 'back to the run' },
    // DEV-389: a room's race cannot be restarted by one of its racers (§6.3).
    ...(ctx.roomActive()
      ? []
      : [
          {
            id: 'restart',
            label: uiString(ctx.level, 'pauseRestart', 'Restart'),
            note: 'from the launch pad, score cleared',
          },
        ]),
    // DEV-377: *Skip step*, while a lesson has a step left (plan §7) — the way
    // past a step a player is stuck on, and how a spec drives a whole lesson.
    ...(ctx.lessonHost.liveLesson && !ctx.lessonHost.liveLesson.run.done
      ? [ctx.SKIP_STEP_OPTION]
      : []),
    // ── OPTIONS, DEV-621 ───────────────────────────────────────────────
    //
    // Matt, 2026-10-04: *"pause - group into pages: resume, restart, options,
    // exit"*. MUTE, CONTROLS, COMFORT, EDITION, CREDITS and REPORT BUG live
    // on the OPTIONS page (`optionsMenu` above; ADVANCED too, under
    // `?perf=1`). The reason is the plate's own arithmetic: `ROWS_MAX_M` is
    // fixed, so rows do not make the plate taller, they make each other
    // shorter, and DEV-614's CREDITS had taken the root to nine rows in a
    // headset, 3.55 degrees each, under the 4.00-degree floor. Seven is the
    // most any page holds now. Before EXIT, so RESUME stays row 0 (a blind
    // press is still the safe option) and EXIT stays last.
    OPTIONS_OPTION,
    // ── EXIT VR, and only while a headset is presenting. DEV-270 ───────────
    //
    // Matt, 2026-09-21: *"i'm not able to exit vr once in vr."* He was right,
    // and it was not a binding he had missed — `grep -rn "session.end()" src/`
    // returned NOTHING. A WebXR app with no way out is a bad citizen: the only
    // ways out were the headset's own system menu and killing the tab, and on a
    // streamed Frame the first is two menus deep while wearing it.
    //
    // It also blocks the cheapest experiment left on the 45 Hz lock. Both worn
    // sessions open with a 400–1600 ms stall and exactly one frame at 90 Hz
    // before the compositor drops them to a tier they never leave; exiting and
    // immediately re-entering starts a session with the world already warm,
    // which separates "the start-up stall latches the tier" from "the tier is a
    // per-app decision" in one click. That could not be done at all.
    //
    // Presenting only, because the row is meaningless flat and the plate's
    // height is a comfort budget: `edition-menu.ts`'s header does the
    // arithmetic — the rows are ~4.6° apart and a head cannot reliably hold 3°,
    // so a row that cannot act is a row that makes every other row harder to
    // hit. Above EXIT for the same reason EXIT is last: the two most
    // consequential rows must not be neighbours you can slip between.
    ...(ctx.render.renderer.xr.isPresenting
      ? [
          {
            id: 'exitvr',
            label: 'Exit VR',
            note: 'back to the monitor; the run is kept',
          } as const,
        ]
      : // ── ENTER VR, flat, on a page that has a headset. DEV-557 ────────
        //
        // EXIT VR's other half, in its place. It is DEV-206's route back in:
        // SteamVR can end a session from ITS side, and until DEV-557 the
        // landing card came back on `sessionend` with its Enter VR button,
        // the only way back short of a reload (which costs a terrain build
        // spent in a headset looking at nothing). With the card gone the
        // title has the way in, and this is the way in from anywhere else,
        // the run kept. Only where a headset is there: a row that cannot act
        // makes every other row harder to hit.
        ctx.titleVr.supported
        ? [
            {
              id: 'entervr',
              label: 'Enter VR',
              note:
                ctx.titleVr.state === 'needs-key'
                  ? 'a pad cannot start VR: press H, or click'
                  : 'into the headset; the run is kept',
            } as const,
          ]
        : []),
    // PERF CAPTURE, and only under `?perf=1` — a player never sees this row.
    // Last but one, above EXIT: it is the row least often wanted and the one
    // whose neighbour must not be pressed by accident, and EXIT stays the
    // bottom of the plate because that is where six sessions have learned it is.
    ...(PERF_HUD
      ? [
          {
            id: 'perfcapture',
            label: 'Perf capture',
            note: ctx.perfCapture.recording
              ? 'stop, and write the runs to a file'
              : 'record every run from here until you stop',
            value: captureRowValue(ctx.perfCapture),
          } as const,
        ]
      : []),
    // DEV-469: a playtest from the editor leaves for the editor, not the
    // hangar, and in EXIT's own place: the bottom row is the way out, and the
    // way out of a test flight is back to the course you were making.
    // DEV-491: and so does a recording flight, with what it recorded.
    EDITOR_RUN.request || EDITOR_RECORD.level
      ? {
          id: 'editor',
          label: 'Back to editor',
          note: EDITOR_RECORD.level
            ? 'with the flight recorded so far'
            : 'the course as you left it',
        }
      : { id: 'exit', label: uiString(ctx.level, 'pauseExit', 'Exit'), note: 'back to the hangar' },
  ]

  return {
    _aimOrigin,
    _aimDirection,
    xrPointer,
    pointerArbiter,
    aimPlate,
    comfortMenu,
    controlsMenu,
    moreMenu,
    options,
    optionsMenu,
    pauseOptions,
    pausePlate,
    pausePageBack,
    closePausePages,
    pauseSteps,
    pauseBackKey,
    pauseRowAt,
    pointerWanted,
    pauseSubPages,
    CREDITS_FAST_MS,
    aimMenus,
    creditsRollFor,
    CREDITS_BODY_M,
    get pauseCursorAim() {
      return pauseCursorAim
    },
    set pauseCursorAim(v: boolean) {
      pauseCursorAim = v
    },
    get creditsFastUntil() {
      return creditsFastUntil
    },
    set creditsFastUntil(v: number) {
      creditsFastUntil = v
    },
    get creditsRoll() {
      return creditsRoll
    },
  }
}
