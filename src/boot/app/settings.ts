// src/boot/app/settings.ts: the player's settings and the edition they choose,
// out of `bootApp`. APP-SPLIT phase 3, slice 4 (`docs/plan/APP-SPLIT.md` §5).
//
// `comfort` (the player's, from storage), the reload echo and its drift
// (DEV-220), `?quality=`'s pins and `pinned`, the chosen edition and the
// presets' one load each (`presetFor`), and DEV-451's rule for which edition a
// screen wears (`wearEdition`, `wearEditionFor`, `editionWorn`,
// `worldEdition`). The settings SINK, `onSettings`, is the pause plate's and
// lives with it (`boot/app/hangar/menus.ts`); it writes `comfort`,
// `qualityPins` and `chosenEdition` through the accessors below. Every line
// below was moved verbatim from the closure; the plumbing is `ctx.x` where the
// code reads a binding the closure still owns, and the returned object.

import {
  applyQualityPins,
  describeQualityPins,
  hasQualityPin,
  type QualityPins,
} from '@/boot/quality-pin'
import {
  type ComfortSettings,
  editionInForce,
  loadSettings,
  VR_AUTO_EDITION,
} from '@/boot/settings'
import type { Edition, EditionId } from '@/content/edition-schema'
import { loadEdition } from '@/content/load-edition'
import type { EditionState } from '@/game/edition'
import {
  AUTOPILOT_AT_BOOT,
  EDITION_PARAM,
  MENU_EDITION,
  QUALITY_PINS,
  RULES_EDITION,
  SKIP_MENU,
  VIEWPOINT,
  VR_LOOK_TIER,
} from './pins'

/** What `createAppSettings` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface AppSettingsCtx {
  readonly editionState: EditionState
  /** Is a headset session presenting (DEV-896: AUTO's look is a headset's own)? */
  presenting(): boolean
}

export const createAppSettings = (ctx: AppSettingsCtx) => {
  /**
   * The player's comfort settings, from `localStorage`.
   *
   * Read BEFORE the renderer, because the XR framebuffer scale is only settable
   * when three builds the layer — so the first session gets the stored quality
   * or it does not get it at all. See `render/quality.ts`.
   */
  let comfort: ComfortSettings = loadSettings()
  /**
   * `?quality=` / `?adaptive=`, live for this load only.
   *
   * `comfort` stays the PLAYER's throughout — it is the object the menus are
   * seeded from and the object `saveSettings` writes — and the pin is overlaid
   * only where the settings reach something that consumes them. That split is
   * what makes "never written to the stored settings" a property of the code
   * rather than a promise; `tests/unit/quality-pin.test.ts` holds it.
   */
  let qualityPins: QualityPins = QUALITY_PINS
  /** The settings as the renderer and the edition should see them this load. */
  const pinned = (settings: ComfortSettings): ComfortSettings =>
    applyQualityPins(settings, qualityPins)
  if (hasQualityPin(qualityPins)) {
    console.info(
      `quality: pinned for this load (${describeQualityPins(qualityPins)}) — ` +
        'not saved; a menu change on that row wins',
    )
  }
  // The preset is a lazy import, so it is STARTED here and awaited below —
  // overlapping the capability probe rather than queuing behind it. The landing
  // page's Start button enables only once this function resolves, and
  // `boot.spec.ts` gives that five seconds on a cold dev server; a fetch put in
  // series with the probe was the difference between passing and flaking.
  // ── DEV-451: the menus always wear Anniversary ──────────────────────────
  //
  // Matt, 2026-09-27: *"our menus should only ever be anniversary."* A boot to
  // a menu (the title, or `?title=0`'s hangar) loads `MENU_EDITION` whatever
  // was chosen; the CHOSEN edition (`?edition=`, else the stored one) is worn
  // inside a mission only, from the black into the loading scene to the black
  // out of the mission (`wearEdition`, below). A boot that lands IN a mission
  // (`?mission=`, `?menu=0`, a viewpoint, `?autopilot=1`) loads the chosen one.
  // DEV-405 did this for the title alone and flipped at the press that left
  // it, so on Classic the hangar and its steps wore Classic.
  const BOOTS_TO_A_MISSION = SKIP_MENU || AUTOPILOT_AT_BOOT || VIEWPOINT
  let chosenEdition: EditionId = EDITION_PARAM ?? comfort.edition
  /** One load per preset per page, so a flip is the same object every time. */
  const editionPresets = new Map<EditionId, Promise<Edition>>()
  /** The ones that have landed, so a flip at a black can be made in that frame. */
  const editionsLoaded = new Map<EditionId, Edition>()
  const presetFor = (id: EditionId): Promise<Edition> => {
    let p = editionPresets.get(id)
    if (!p) {
      p = loadEdition(id).then((e) => {
        editionsLoaded.set(id, e)
        return e
      })
      editionPresets.set(id, p)
    }
    return p
  }
  const editionLoading = presetFor(BOOTS_TO_A_MISSION ? chosenEdition : MENU_EDITION)
  // Both, warm, so the flip at a black never waits on a fetch.
  for (const id of new Set([MENU_EDITION, chosenEdition, RULES_EDITION, VR_AUTO_EDITION])) {
    presetFor(id).catch((err: unknown) => console.error(`edition: could not load ${id}`, err))
  }
  // ── DEV-451: which edition a screen wears ────────────────────────────────
  //
  // Matt, 2026-09-27: *"our menus should only ever be anniversary."* Every
  // menu wears `MENU_EDITION`; a mission wears the chosen one. The flip is
  // made at a BLACK, never in view: DEV-427 measured a flip on screen as a
  // 782 ms frame with the title half-faded, because every material on screen
  // recompiles. Two blacks carry it:
  //
  //   * INTO the loading scene (or straight onto the pad, the cheap door):
  //     the mission's edition, so the world is BUILT under the edition it will
  //     be flown in. Several things are read once at build (the detail ring,
  //     the ocean's subdivision, the particle specs, the canopy, the speed
  //     unit), so a world built under the menus' edition and flipped at the
  //     cockpit's black would keep those as the menus' for the whole run. The
  //     loading scene still wears the MENUS' look: it is unlit and unfogged,
  //     and it draws the menus' tone curve into its own colours rather than
  //     take the renderer's (`render/loading-scene.ts`, `LoadingTone`), which
  //     is the mission's by then. Photographed before that, a Classic
  //     player's loading scene came out lighter than an Anniversary one's.
  //   * OUT of a mission, to the hangar or the room: back to the menus'.
  //
  // `wearEditionFor` is called by the frame loop's screen swap after the act,
  // with what it arrived at; `switchMission` waits on `editionWorn` before it
  // builds. DEV-405 flipped at the press that LEFT the title instead, so on
  // Classic the hangar, its steps and its tables wore Classic, and Matt's
  // first run of the multiplayer build read that as "stuck on the classic
  // mode" (DEV-442).
  /**
   * The edition a mission wears: the chosen one. DEV-452 (D35) made it a look
   * and nothing else, so a shared lap's edition no longer decides it (DEV-373
   * pinned the lap's preset for the page, because its RULES were the lap's);
   * every run flies `editionState.rules`.
   */
  const missionEdition = (): EditionId =>
    // DEV-896: a `?edition=` pin, else the look IN FORCE: on AUTO a headset wears Classic.
    EDITION_PARAM ?? editionInForce(comfort, ctx.presenting())
  /**
   * DEV-931: the look a HEADSET wears, presenting or not yet: what AUTO's
   * headset tier follows (`render/quality.ts`'s `headsetLook`). `null` under
   * `?vrLookTier=0`, which leaves the headset at `VR_AUTO_QUALITY`.
   */
  const headsetLook = (): EditionId | null =>
    VR_LOOK_TIER ? (EDITION_PARAM ?? editionInForce(comfort, true)) : null
  /** The latest flip, resolved once it has landed. `switchMission` waits on it. */
  let editionWorn: Promise<void> = Promise.resolve()
  /** Which ask is the latest, so a slower load can never land over a newer one. */
  let wearAsk = 0
  const wearEdition = (where: 'menus' | 'mission'): void => {
    const id = where === 'menus' ? MENU_EDITION : missionEdition()
    const ask = ++wearAsk
    const put = (e: Edition): void => {
      if (ask !== wearAsk || ctx.editionState.current.id === e.id) return
      ctx.editionState.setLook(e)
      console.info(`edition: ${e.id} (${where === 'menus' ? 'the menus' : 'a mission'}, DEV-451)`)
    }
    // Loaded (both are warmed at boot): in THIS frame, which is the black one.
    // A microtask later would be after it, and the next frame is already
    // coming back up (`move-fades.spec.ts` asserts the picture changes only
    // on black).
    const ready = editionsLoaded.get(id)
    if (ready) {
      put(ready)
      editionWorn = Promise.resolve()
      return
    }
    editionWorn = presetFor(id).then(put, (err: unknown) =>
      console.error(`edition: could not load ${id}`, err),
    )
  }
  /**
   * What a screen wears, from where the swap just ARRIVED: a mission, and the
   * loading scene a mission is being built behind, wear the mission's
   * edition; every other screen is a menu.
   */
  const wearEditionFor = (arrived: 'title' | 'menu' | 'mission', building: boolean): void =>
    wearEdition(arrived === 'mission' || building ? 'mission' : 'menus')
  /**
   * The edition the mission world was BUILT under; null before any world.
   * Re-boarding the course already loaded is the cheap door (no load), and it
   * must not board a world built under another edition: a flip on the pause
   * plate changes what follows live but not what was read at build (DEV-442).
   */
  let worldEdition: EditionId | null = null
  return {
    pinned,
    editionLoading,
    presetFor,
    editionsLoaded,
    wearEditionFor,
    wearEdition,
    missionEdition,
    headsetLook,
    get comfort() {
      return comfort
    },
    set comfort(v: ComfortSettings) {
      comfort = v
    },
    get qualityPins() {
      return qualityPins
    },
    set qualityPins(v: QualityPins) {
      qualityPins = v
    },
    get chosenEdition() {
      return chosenEdition
    },
    set chosenEdition(v: EditionId) {
      chosenEdition = v
    },
    get worldEdition() {
      return worldEdition
    },
    set worldEdition(v: EditionId | null) {
      worldEdition = v
    },
    get editionWorn() {
      return editionWorn
    },
  }
}
