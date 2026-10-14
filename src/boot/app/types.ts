// src/boot/app/types.ts — the `__ff2` handle's type, and the reports its
// members return.
//
// Moved verbatim out of `boot/app.ts` (APP-SPLIT phase 1,
// `docs/plan/APP-SPLIT.md`): types only, so the move changes nothing that
// runs. `boot/app.ts` re-exports every name here, so `@/boot/app` is still
// the one door `main.ts` and anything else imports these through.
//
// `e2e-debug-handle.test.ts` reads `interface App` out of whichever file
// declares it, and requires every `__ff2.<member>` an e2e spec reaches to be
// declared here.

import type * as THREE from 'three'
import type { CueId, LiftAudioProbe } from '@/audio'
import type { LoadState } from '@/boot/load-progress'
import type { BakedLightRung } from '@/content/edition-schema'
import type { BenchProbe } from '@/editor/bench/host'
import type { DeskDebug } from '@/editor/desk/host'
import type { LoadedTraffic } from '@/game/ambient-traffic'
import type { EditionState } from '@/game/edition'
import type { Flight } from '@/game/flight'
import type { LoadedGhosts } from '@/game/ghosts'
import type { ShareState } from '@/game/lap-share'
import type { LessonProbe } from '@/game/lesson-session'
import type { LifeProbe } from '@/game/life/load-life'
import type { MissionState } from '@/game/mission'
import type { LineClearingReceipt } from '@/game/props/course-clearing'
import type { LoadedRacers } from '@/game/racers'
import type { ResultsBoardFetch } from '@/game/results-board'
import type { LoadedRings } from '@/game/rings'
import type { RoomProbe } from '@/game/room-client'
import type { LoadedTerrain } from '@/game/terrain/load-terrain'
import type { ExhibitionOptions } from '@/game/tv/exhibition'
import type { ExhibitionReport } from '@/game/tv/exhibition-view'
import type { TvProbe } from '@/game/tv/tv-client'
import type { WatchProbe } from '@/game/watch-client'
import type { TouchControls } from '@/input/touch-overlay'
import type { BoardKey } from '@/net/lap-client'
import type { BakedLightReport } from '@/render/baked-light'
import type { YourCoursesProbe } from '@/render/course-shelf'
import type { FadePhase } from '@/render/fade'
import type { HangarAim, HangarView } from '@/render/hangar'
import type { CanvasPanelReport, HudReport } from '@/render/hud'
import type { HudFontState } from '@/render/hud-font'
import type { LensMaskReport } from '@/render/lens-mask'
import type { LoadingPlace } from '@/render/loading-scene'
import type { MultiviewReport } from '@/render/multiview'
import type { ProbeOptions, ProbeResult, XrEyeCapture } from '@/render/multiview-probe'
import type { RaceMapReport } from '@/render/race-map'
import type { Renderer } from '@/render/renderer'
import type { ReportBugHook } from '@/render/report-bug-menu'
import type { BoardPlateView } from '@/render/results'
import type { SceneTint } from '@/render/scene-tint'
import type { StaticReport } from '@/render/static-scene'
import type { TvPanelReport } from '@/render/tv-panel'
import type { TvControlsReport } from '@/render/tv-panel-controls'
import type { TvPanelFeed } from '@/render/tv-panel-layout'
import type { CrashState } from '@/sim/crash'
import type { LaunchPhase } from '@/sim/launch'
import type { HeightField } from '@/sim/terrain/height-field'
import type { Capabilities } from '../capability-gate'
import type { GpuTimer } from '../gpu-timer'
import type { FrameRecorder } from '../perf-recorder'
import type { PerfSurface } from '../perf-surface'
import type { Census } from '../render-census'
import type { RateReport } from './update-rates'

/** `App.laps()`: DEV-371's state, as a spec reads it. */
export interface LapsReport {
  readonly run: { readonly tick: number; readonly clock: number; readonly taint: readonly string[] }
  readonly last: {
    readonly seconds: number | null
    readonly gates: number
    readonly keys: number
    readonly finishTick: number
    /** DEV-372's board fields, as the lap carries them. */
    readonly rules: string
    readonly vehicle: string
    readonly tainted: boolean
    readonly reasons: readonly string[]
    readonly improved: boolean
    readonly stored: boolean
    readonly keptMs: number
    /** DEV-571: saved as your ghost NOW (the panel's answer), or null where it cannot be. */
    readonly kept: boolean | null
    /** DEV-571: the saved lap's seconds before this one finished, or null. */
    readonly savedBefore: number | null
  } | null
  readonly ghost: {
    readonly source: 'best' | 'this-lap' | 'shared'
    /** DEV-373: the poster's handle for a shared lap; null for your own. */
    readonly handle: string | null
    readonly seconds: number | null
    readonly gates: number
    readonly keys: number
    readonly tainted: boolean
    /** Drawn this frame, and where, THREE space. */
    readonly visible: boolean
    /** DEV-856: the tag over the ship: its words, whether it is drawn, and its opacity. */
    readonly tag: {
      readonly text: string
      readonly visible: boolean
      readonly opacity: number
    } | null
    readonly at: readonly [number, number, number]
  } | null
  readonly stored: {
    readonly seconds: number
    readonly gates: number
    readonly keys: number
    readonly tainted: boolean
  } | null
}

/** `App.share()`: DEV-373's state, as a spec reads it. */
export interface ShareReport {
  /** The panel offers Share: a finished, untainted lap with a board's rules. */
  readonly offered: boolean
  readonly phase: ShareState['phase']
  readonly handle: string | null
  readonly id: string | null
  readonly link: string | null
  readonly board: boolean
  readonly rank: number | null
  readonly reason: string | null
  /** Laps this page has sent. A tainted run must leave it where it was. */
  readonly posts: number
  /** The panel's prompts as drawn this frame, and its block. */
  readonly prompts: { readonly again: string; readonly race: string; readonly back: string } | null
  /** `?ghost=<id>`: what the link fetched, or null without one. */
  readonly linkGhost: {
    readonly id: string
    readonly state: 'loading' | 'ready' | 'gone'
    readonly mission: string | null
    readonly variant: string | null
    readonly edition: string | null
    readonly handle: string | null
    readonly keys: number | null
  } | null
  /** The course cards on the hangar's page that is up: their ghost lines. */
  readonly cards: readonly { readonly id: string; readonly line: string | null }[]
  /** The course and aircraft variant the built world flies, or null before one is built. */
  readonly aboard: { readonly mission: string; readonly variant: string } | null
  /**
   * DEV-571: the questions after a lap: whether the plate is up, its rows as
   * drawn (id, label, value) and the aimed row's id. Null with no lap on the panel.
   */
  readonly ask: {
    readonly up: boolean
    readonly rows: readonly {
      readonly id: string
      readonly label: string
      readonly value: string | null
    }[]
    readonly aim: string
    /** Each row's centre on the glass, CSS pixels, for a finger; null while the plate is down. */
    readonly centres:
      | readonly { readonly id: string; readonly x: number; readonly y: number }[]
      | null
  } | null
}

/** `App.resultsBoard()`: DEV-431's board on the results panel, as a spec reads it. */
export interface ResultsBoardReport {
  /** The board the run on the panel reads; null where the course keeps none, or in a room. */
  readonly key: BoardKey | null
  /** What the last answer held: `loading`, `ready` or `failed`; null with no board. */
  readonly status: ResultsBoardFetch['status'] | null
  readonly refreshing: boolean
  /** Board requests this page has sent from the results panel. */
  readonly fetches: number
  /** The plate as the panel last DREW it (`Results.drawn`), or null. */
  readonly drawn: BoardPlateView | null
}

/**
 * DEV-471: where `?edit=1`'s editor is. `loading` — the world or the editor is
 * still on its way; `ready` — the editor has drawn over the built island and
 * takes a click; `off` — it is not coming (this build has no editor, or its
 * chunk failed), and the page is the cockpit `?menu=0` boots.
 */
export type EditorBootPhase = 'loading' | 'ready' | 'off'

/**
 * What `main.ts` hands `bootApp` about the page around it. DEV-611: the
 * developer splash (`boot/dev-splash.ts`). While it is `covering` the game
 * takes no confirm, and the title's curtain lifts on `lifting`, so the flypast is flown
 * into a valley somebody can see.
 */
export interface BootOptions {
  readonly splash?: { covering(): boolean; readonly lifting: Promise<void> }
  /**
   * DEV-622: what REPORT BUG's SEND calls. Unset, nothing is sent and the page
   * says so. The analytics session wires the real sender (`main.ts`).
   */
  readonly reportBug?: ReportBugHook
}

/** DEV-902: a box on the glass, css px from the page's top left. */
export interface TitleBox {
  l: number
  r: number
  t: number
  b: number
}

export interface App {
  readonly capabilities: Capabilities
  readonly render: Renderer
  /**
   * Resolves when the MISSION world is in the scene, rejects if it could not
   * load, and is **null while no course has been chosen** (DEV-281).
   *
   * A getter: boot into the title screen builds no mission, the first selection
   * builds one, and every swap after that replaces it.
   */
  readonly world: Promise<{
    terrain: LoadedTerrain
    /** `null` for an environment with no water — alpine and desert have none. */
    ocean: LoadedTerrain | null
    rings: LoadedRings
    flight: Flight
    ghosts: LoadedGhosts
  }> | null
  /** Live run state. Read by the e2e specs and the console. */
  readonly mission: MissionState
  /**
   * The live preset — Classic or Anniversary — and the speed slider resolved
   * to a multiplier. `current` is a getter, so a spec reads the one that is
   * live after a flip rather than the one that was live at boot.
   */
  readonly edition: EditionState
  /**
   * The AI racers, or null before the level loads.
   *
   * An accessor, not a value: a spec that captured it at boot would hold a
   * stale null forever. It exists to make a MOVING target aimable — four
   * screenshot runs went on guessing where the racers were at t = 5 s.
   */
  racers(): LoadedRacers | null
  /**
   * DEV-388. The room this page is in (`?room=`), or null: the socket's status,
   * the clock, this client's GO and tick, and every other player's ship as drawn
   * — with `truth(tick)`, this client's own pose, for a drawn-vs-truth check
   * across two pages. `ready()` and `start()` are the lobby's READY and START
   * (DEV-389), for a spec that boots onto a course rather than walking the plates.
   */
  room(): RoomProbe | null
  /** DEV-436. The room this page WATCHES (`?watch=`), or null: the stream, the phase, the ships, who the camera follows. */
  watch(): WatchProbe | null
  /** DEV-480. Faceted Flight TV, or null when it is off. */
  tv(): TvProbe | null
  /** DEV-483. TV's exhibition, until DEV-480's door: `start({ course?, lapId? })`, `stop()`, `probe()`. */
  readonly exhibition: {
    start(options?: ExhibitionOptions): ExhibitionReport
    stop(): void
    probe(): ExhibitionReport
  }
  /** DEV-482. TV's panels: `probe()`, and `feed(f)` / `lobbies(n)` standing in for DEV-480's TV block. */
  readonly tvPanel: {
    probe(): TvPanelReport
    /** DEV-628: FF-TV's EXIT, MENU and hint (`render/tv-panel-controls.ts`). */
    controls(): TvControlsReport
    feed(feed: TvPanelFeed | null): void
    lobbies(n: number | null): void
  }
  /**
   * DEV-361. The race map beside the readout, or null where there is none
   * (Classic, a mode with no opponents, `?opponents=ghosts`). Counts, texts and
   * plate positions — the place it SHOWS, which is what a spec should read.
   */
  raceMap(): RaceMapReport | null
  /**
   * DEV-371. The player's laps, or null where the mode races nobody: this run's
   * taint and ticks, the lap it finished, the ghost it races (and where that
   * came from), and what the store keeps for this course and preset. Times are
   * the laps' own rescores (`scoreGhost`), which is what the panel shows.
   */
  laps(): LapsReport | null
  /**
   * DEV-373. Share on the results panel, the `?ghost=` link, and the hangar's
   * ghost lines — what each says now, and how many laps this page has sent.
   */
  share(): ShareReport
  /**
   * DEV-431. The course's board on the results panel: which board the run on
   * the panel reads, what its fetch holds, how often this page asked, and the
   * plate as last drawn. Null before any run has ended.
   */
  resultsBoard(): ResultsBoardReport | null
  /**
   * DEV-362 follow-up. Where the cockpit readout's face stands: `loaded` is the
   * only state in which a panel draws in CRYSTAL. A photograph of the panel is
   * a photograph of the font only if this says so first.
   */
  hudFont(): HudFontState
  /**
   * DEV-146's other population: another mission's ships over this island, or
   * null when the preset is off, the level names none, or the budget is zero.
   *
   * Separate from `racers()` on purpose. These are not opponents and they are
   * not in the results, so anything that asks "who am I racing" must not find
   * them — and anything measuring the frame cost of the feature needs to be
   * able to count exactly them.
   */
  traffic(): LoadedTraffic | null
  /**
   * DEV-447: the life pass — whether the boats are wanted, built and shown, and
   * each boat's place, the drawn sea's height under it and its keel. Null
   * before a world is built. What a spec photographs the harbour by.
   */
  life(): LifeProbe | null
  /**
   * DEV-377. The lesson running on this course — its step, any interrupt, the
   * plate's text and the instructor — or null where the mode does not teach.
   * Plain values: the PLATE's text is what a spec asserts, because that is what
   * a player reads.
   */
  lesson(): LessonProbe | null
  /** The player's ship, or null before the level loads. Same reasoning. */
  flight(): Flight | null
  /** The player's crash state (DEV-126): phase, count, and where it goes back to. */
  crash(): CrashState
  /**
   * The feel layer itself (DEV-636/637, `boot/feel.ts`): a spec calls
   * `shake`/`haptic`/`fovKick` through the SAME door the game does and reads
   * `cameraShake.trauma`, `haptics.active(...)` and `cockpitJolt` back.
   */
  feel(): import('@/boot/feel').Feel
  /**
   * The soundtrack as an out-of-process test can see it (DEV-247).
   *
   * `seconds` is the decoded length off the `AudioBuffer` and is the only
   * field a BROKEN soundtrack cannot produce — `track` and `running` were
   * both true of the live site for the months it was fetching `index.html`
   * for every song. See the accessor's own note.
   */
  music(): {
    tracks: number
    track: string | null
    seconds: number | null
    running: boolean
  }
  /**
   * The lift ride's voice (DEV-424): the platform speed it derived, the motor
   * and arrival state, and every cue the backend reports sounding.
   */
  liftAudio(): LiftAudioProbe & { sounding: readonly CueId[] }
  /**
   * The two energy tanks (DEV-143, DEV-144), and which mechanic the running
   * mode selected. See the accessor's own note: a gauge drawn on a canvas
   * texture inside a cockpit is the one surface a spec cannot read, and
   * *"did the number move"* is the only question worth asking about either.
   */
  energy(): {
    mode: 'race' | 'boost'
    boost: { energy: number; lockout: number; lit: boolean }
    race: { energy: number; powered: boolean; drained: number; paid: number }
  }
  /**
   * The two height-field lists the sim is fed — what the autopilot AVOIDS and
   * what a hull HITS — for a spec that wants to time or probe the sim against
   * the live world. Accessor: both are replaced on a mission swap.
   */
  heightFields(): { autopilot: readonly HeightField[]; collision: readonly HeightField[] }
  /**
   * The prop fracture (DEV-148): pieces in the air, and pieces that have
   * LANDED. Null before the world loads and on Classic, which has no props.
   *
   * It exists because a screenshot cannot answer *"do the pieces fall through
   * the hill?"* — a shard below the ground is hidden BY the ground, so the bug
   * and the fix photograph the same. `tests/e2e/prop-break.spec.ts` asks the
   * page instead.
   */
  fracture(): { live: number; landed: number } | null
  /**
   * DEV-428: the struck-prop bursts thrown in this world, and pieces in the
   * air. Null with no strike field (Classic, or the strike off at load).
   * `prop-break-programs.spec.ts` reads it beside `fracture()` to name the
   * frame a strike appears on.
   */
  propStrike(): { bursts: number; alive: number } | null
  /**
   * DEV-504: the world's prop colliders — how many, and how many are
   * LANDMARKS (a hull or the mesh's own triangles, DEV-213/345) — or null with
   * none built. `editor-props.spec.ts` holds a course's placed props to one
   * landmark collider each.
   */
  propColliders(): { count: number; landmarks: number } | null
  /**
   * DEV-429: the spray's last reading — `strength` 0-1 of its rate, `height`
   * over the visible sea and `depth` of water under the ship (null: no sea
   * read), droplets alive. Null
   * with no spray field (Classic, a JumpSeat course, the flag off at load).
   */
  spray(): { strength: number; height: number | null; depth: number | null; alive: number } | null
  /**
   * DEV-613: the splashes thrown in this world, pieces in the air, the pool's
   * size and the most pieces it can hold, and where the last one landed (THREE
   * world) at what scale. Null with no splash field (Classic, or the flag off
   * at load). `splash.spec.ts` aims its photographs with `last`.
   */
  splash(): {
    thrown: number
    alive: number
    emitters: number
    capacity: number
    last: { x: number; y: number; z: number; scale: number } | null
  } | null
  /** DEV-937: how many objects are frozen, any a check had to hand back, and the lift's state. */
  staticScene(): StaticReport
  /** DEV-976: every declared update rate and how many frames it ran and skipped. */
  updateRates(): Readonly<Record<string, RateReport>>
  /**
   * DEV-926 / DEV-927: the vapour cone's strength and pieces in the air, and
   * shockwaves thrown and pieces in the air. Null for a world built without
   * either (each is built only when on at load).
   */
  swings(): {
    vapour: { strength: number; alive: number } | null
    shockwave: { thrown: number; alive: number } | null
    vortices: { strength: number; turnDeg: number; alive: number } | null
  } | null
  /**
   * WHICH page the pause plate is turned to, its heading, and its rows.
   *
   * The `hangarAim()` of the pause menu, and it exists for the same reason
   * (DEV-223). The plate is a canvas texture, so for the life of it the only
   * way to ask what it was showing was to photograph it — and a spec that
   * walked down to CONTROLS by pressing ArrowDown four times could open the
   * COMFORT page instead, assert the plate was up, write a picture of the
   * wrong menu and PASS. The count was the only thing holding it to the right
   * row, against a list whose length has moved twice.
   *
   * `page` is `'pause'` for the plate itself and otherwise the id of the row
   * that opened the page — so a spec names the row it wants and gets told
   * whether it got there. `rows` is the LIVE list, including the row only
   * `?perf=1` adds, because that is the list `pauseAim` indexes and a counted
   * walk has to agree with it.
   *
   * **So do not count these and assert what a PLAYER sees.** Asserting
   * `rows.length === 7` here passes on a plain run and breaks under `?perf=1`,
   * in a spec that has nothing to do with the flag, which reads as flake rather
   * than as the mistake it is.
   *
   * It says what the plate is DRAWING, not whether you can see it: an unpaused
   * run hides the plate. Whether it is on screen is the object's `visible` flag, which
   * is a different question with its own answer.
   */
  pausePlate(): {
    page: string
    title: string
    rows: { id: string; label: string; value: string | null }[]
    /**
     * Whether the plate is actually UP, and which row a press would take
     * (DEV-291). Everything above is true of the plate whether or not anybody
     * can see it — see the paragraph above — which is precisely what made a
     * tap-picker untestable until these two existed.
     */
    open: boolean
    selected: number
    /** DEV-623: how far the credits roll has climbed, sheet-widths; null before it is built. */
    rolled: number | null
  }
  /** DEV-894: the text size of every UI plate on the glass, css px (see `debug-handle.ts`). */
  uiText(): {
    name: string
    cssPerPx: number
    onGlass: boolean
    box: { l: number; r: number; t: number; b: number } | null
    sizes: { px: number; chars: number; css: number }[]
  }[]
  /** DEV-882: the hangar's OPTIONS plate: up, the aimed row, and each row's centre on the glass (CSS px). */
  hangarOptions(): {
    up: boolean
    selected: number
    rowsAt: { x: number; y: number }[] | null
  }
  /**
   * The title's rows, for a spec (DEV-353): up or not, the row a press
   * would take, the row ids in order, and each row's centre on screen in CSS
   * pixels (null while the rows are down). DEV-379: each row's note as the
   * plate is handed it, and whether it is painted in the accent — the
   * first-visit note is text on a canvas, and this is how a spec reads it.
   */
  /**
   * DEV-902: the title's elements on the glass, css px (`debug-handle.ts` says how each
   * is measured), and the size each one's type is set at. Null while the rows are down.
   */
  titleLayout(): {
    glass: { w: number; h: number }
    logo: TitleBox | null
    edition: (TitleBox & { fontPx: number }) | null
    plate: TitleBox
    rows: (TitleBox & { id: string })[]
    version: (TitleBox & { fontPx: number }) | null
    mascot: (TitleBox & { fontPx: number }) | null
    /** The add-to-home-screen card (DEV-842), null where it is not shown. */
    guide: (TitleBox & { fontPx: number }) | null
  } | null
  titleMenu(): {
    up: boolean
    selected: number
    rows: string[]
    rowsAt: { x: number; y: number }[] | null
    /** DEV-895: the plate's bottom edge on the glass, css px (null while the rows are down). */
    plateBottom: number | null
    notes: string[]
    accents: boolean[]
    /**
     * DEV-441: the page that is up, its heading, and EVERY page's row ids. Since
     * DEV-558 the title is one page, `top` (START, ENTER VR, a link's row); the
     * doors are the hangar's first step. Kept so a spec still names the row it
     * wants and the walk is the one press (`tests/e2e/fixtures/title.ts`).
     */
    page: string
    heading: string
    pages: Record<string, string[]>
    /**
     * DEV-441b: the letter plate, or null while it is down: what is typed, the
     * key aimed at, every key's id and its centre on screen (CSS pixels), and
     * the plate's footer (a refusal is said there). In the HANGAR since DEV-558
     * (Multiplayer's JOIN WITH A CODE table); reported here, beside the rows it
     * used to stand in place of, because that is where every spec reads it.
     */
    code: {
      typed: string
      selected: number
      keys: string[]
      keysAt: { x: number; y: number }[]
      footer: string
      joining: string | null
    } | null
    /**
     * DEV-557's ENTER VR, a ROW since DEV-558 (`render/title-menu.ts`'s
     * `enterVrRow`): whether the row stands, what it says (`TitleVrState`),
     * whether the aim is on it, and its centre on screen in CSS pixels (null
     * while it does not stand, or the rows are down).
     */
    vr: {
      shown: boolean
      state: string
      label: string
      note: string
      aimed: boolean
      at: { x: number; y: number } | null
    }
  }
  /** The course being flown: its id, its aircraft and the mode it RUNS in. */
  course(): { id: string; vehicle: string; mode: string }
  /**
   * The look the CHASE ARM was handed last frame, or null when the
   * third-person camera is not drawing (DEV-292). Radians.
   *
   * Declared here rather than left as an undeclared extra on the returned
   * object, because a field the type does not mention is a field nothing
   * guards — CLAUDE.md's *"a generated constant that NO CODE PATH READS is
   * documentation, not a guard"*, one layer along. The implementation's own
   * comment says why a spec has to ask for this instead of measuring it.
   */
  orbitLook(): { yaw: number; pitch: number; fromDevice: boolean } | null
  /**
   * The live world's two terrains, or null before the level loads. Same
   * reasoning again — and the same job: a LOD swap is a moving target, and
   * the pop measurement in `tests/e2e/lod-pop.spec.ts` (DEV-130) has to know
   * when the worker has nothing left in flight before it trusts a frame.
   */
  terrain(): { terrain: LoadedTerrain; ocean: LoadedTerrain | null } | null
  /** DEV-489: the last world build's custom-island receipt, or null for a shipped island. */
  customGround(): Record<string, number | string> | null
  /** DEV-955: where the last world build's terrain bakes came from and the rows of march it ran. */
  terrainBake(): import('./world/terrain-bake-step').TerrainBakeReceipt | null
  /** DEV-955: sha256 of each field as its shipped file would hold it (the manifest's sha256). */
  terrainBakeDigest(): Promise<{
    sun: string | null
    sky: string | null
    /** sha256 of the half-float RGBA the GPU gets for the sky field (the gate; `sky` is informational). */
    skyTexture: string | null
  } | null>
  /**
   * DEV-502: the course clearing on this world's scatter, as the WORLD has it:
   * the last mask's receipt; how many scatter props are masked, and of those
   * how many are still DRAWN (a non-zero matrix) or still SOLID (a collider
   * not out) — both must be 0; how many masked props stood in the world
   * level's flown line (the ship's hull would have touched them: within their
   * collider's reach of the route, at its height) — the sample that says the
   * clearing had work to do; and the ship's hull swept along that route every
   * `sweepMetres`, counting the samples that touch any prop at all. `low` is
   * the same sweep over the line's PLAN at the hover height over the ground
   * (the lowest a HoverJet flies: nap of the earth, where the trees are),
   * with the clearing, and with the masked colliders put back for the one
   * synchronous call — the separating sample: what the line would have hit.
   */
  lineClearing(sweepMetres?: number): {
    receipt: LineClearingReceipt | null
    scatter: number
    masked: number
    maskedDrawn: number
    maskedSolid: number
    colliders: boolean
    inLine: number
    sweep: { samples: number; touching: number } | null
    low: { samples: number; touching: number; touchingUncleared: number; inLine: number } | null
    /** Every scatter prop's plan position, LEVEL frame (THREE x, z): where the forest stands. */
    forest: [number, number][]
  } | null
  /**
   * Set `render/fragment-gates.ts`'s cuts on the live terrain materials and
   * return how many changed. The within-run A/B the terrain's 4.3 ms needs —
   * see the implementation for why a define and not a query parameter.
   */
  fragmentGates(
    gates: readonly string[],
    which?: 'land' | 'ocean' | 'both',
  ): {
    moved: number
    defines: string[]
    /** Distinct materials the named terrains draw with. */
    materials: number
    /** How many of them carry EVERY wanted define. DEV-238's mechanism check. */
    carrying: number
    which: 'land' | 'ocean' | 'both'
  }
  /**
   * DEV-232. Throw the land's baked-light arm, or read it without moving it.
   *
   * The report separates **`wanted`** (what was asked for) from **`on`** (what
   * is actually true), and carries a `reason` when they differ. The first
   * version returned neither, so `{ materials: 0, geometries: 0 }` meant both
   * *"off, correctly"* and *"on, and it reached nothing"* — and an A/B read the
   * milliseconds, filed 0.025 ms against a 0.05 ms bracket, and nearly
   * published "the bake buys nothing" for an arm that never fired.
   *
   * `on` requires a baked buffer, not just a define, because a define with
   * nothing behind it is the failure this is for.
   *
   * DEV-237 adds the RUNG, and it is the second argument rather than a second
   * method so that the within-run A-B-A the protocol needs is one call per arm:
   *
   *     __ff2.bakedLight(false)           // A — the shipped build
   *     __ff2.bakedLight(true, 1)         // B — baked, shadows kept
   *     __ff2.bakedLight(true, 3)         // C — baked, shadows gone (DEV-232's arm)
   *     __ff2.bakedLight(true, 'split')   // D — baked apart, shadows on the sun only
   *     __ff2.bakedLight(false)           // A again, the bracket
   *
   * Omit it and the rung does not move, so every call written before DEV-237
   * still means what it meant. The report carries `rung` (asked) beside
   * `liveRung` and `defines` (read back off the materials), because the only
   * failure this module has ever had was an intent that reached nothing.
   */
  bakedLight(on?: boolean, rung?: BakedLightRung): BakedLightReport
  /**
   * The land's chunk batching, on or off (DEV-193, DEV-904). Batching is the
   * shipped default, so `false` is the OFF arm of an A/B and `true` rebuilds the
   * bands from the chunks as they are. Returns the PLAN, never a verdict: the
   * draw-call answer is `renderer.info.render.calls` read around this call.
   */
  chunkBatch(on?: boolean): unknown
  /**
   * DEV-930, the app's lens mask, live. No argument reads it; a radius (NDC)
   * sizes it; `0` or `null` turns it off. For the worn calibration during fast
   * head yaw, and the on/off arms of its A/B on one load. `render/lens-mask.ts`.
   */
  lensMask(radius?: number | null): LensMaskReport
  /**
   * DEV-986: multiview's report (`render/multiview.ts`), or null when the page
   * was not loaded with `?multiview=1` and nothing is installed.
   */
  multiview(): MultiviewReport | null
  /**
   * DEV-988: draw the live stage both ways in one turn and compare the eyes
   * (`render/multiview-probe.ts`). Null without `?multiview=1`. Debug only.
   */
  multiviewProbe(options?: ProbeOptions): ProbeResult | null
  /**
   * DEV-989: the next XR frame's real eye buffer, both eyes, read inside the
   * frame. With or without `?multiview=1` (the A/B's two arms); without it the
   * session must be single-sampled (`?aa=0`). Rejects when not presenting.
   */
  xrEyeCapture(step?: number): Promise<XrEyeCapture>
  /**
   * DEV-238. The REAL per-frame submission sequence, folded into runs.
   *
   * Not the scene graph and not the census: every call that reaches
   * `renderBufferDirect`, in the order three handed it over, shadow pass
   * included. It answers the one question the census cannot — *which of the
   * sky, the sea and the land goes first* — and three's answer today is
   * decided by `material.id`, not by depth. See `render/draw-order.ts`.
   *
   * Resolves after `frames` frames, so it is a promise.
   */
  drawOrder(frames?: number): Promise<unknown>
  /**
   * DEV-238's ordering switches, **all ON by default since DEV-241 /
   * DEV-246** and all restoring exactly. `ocean` puts the sea after every
   * opaque terrain band; `sky` puts the dome last among the world's opaques at
   * the far plane; `cockpit` puts the player's vehicle FIRST, ahead of the
   * terrain, the props, the clouds and the racers.
   *
   * So `false` is the A/B ARM now — it subtracts a shipped default and hands
   * back the build wave 4's baselines were taken on. `true` re-asserts the
   * default and is a no-op on a level that has just loaded, which is what a
   * sweep re-applying an arm after a course swap wants.
   *
   * Omit `on` to read the state without moving it.
   */
  drawOrderSwitch(which: 'ocean' | 'sky' | 'cockpit', on?: boolean): unknown
  /**
   * DEV-339. Which sea draws: the camera-centred rings (`true`) or the plate's
   * chunks (`false`), live, in one load. Omit `on` to read without moving.
   *
   * It reports what is TRUE and not what was asked (DEV-232 section 10c: an arm
   * that cannot say it fired is not an arm): `wanted` is the preset, `on` is
   * whether the rings are drawing, `reason` is why not, `triangles` is what the
   * sea is drawing (the rings' rasterised triangles, or the plate's), `submitted`
   * the rings' per-frame total with holes. **The first `true` BUILDS the rings and
   * the first `false` after a rings-first load builds the plate**, so the first
   * call of either kind is a build and not a reading: call it, let a few frames
   * pass, then sample. Null on a level with no sea. Async because the plate's
   * build is.
   *
   * DEV-340: `normals` picks where the face normal comes from, `face` (the
   * vertex shader's) or `derived` (the fragment derivatives'); `normals` in the
   * report says which is in force.
   */
  oceanRings(on?: boolean, normals?: 'derived' | 'face'): Promise<unknown>
  /**
   * DEV-243. The cockpit HUD's redraw cadence, read or set, and its counts.
   *
   * The panel is a 560 × 203 `CanvasTexture` and a repaint re-uploads the whole
   * canvas INSIDE the timed render (`render/hud.ts`'s DEV-243 block has three's
   * own line numbers). `hudSignature` carries the rounded speed in m/s, so on a
   * flight that is most frames, and `VR-PERF-WAVE-4.md` §3.5 queue H reads the
   * panel as the whole of the vehicle group's ±1.7 ms per-frame residual.
   *
   *     __ff2.hud()            // read, without moving anything
   *     __ff2.hud('freeze')    // one paint ever — the upload, isolated
   *     __ff2.hud(10)          // the shipped cadence, DEV-248's default
   *     __ff2.hud('live')      // back to 2016's — the A/B arm
   *
   * A live flip for the reason `drawOrderSwitch` and `bakedLight` take one:
   * this machine cannot compare two LOADS of a fill-dominated cost
   * (perf-protocol §3a-ter), so an arm has to be reachable on one page.
   * `?hudRedraw=` is the same thing applied at load, for the trace spec.
   *
   * Counts and sizes only, never a duration — the durations are the
   * coordinator's, taken on a quiet box.
   *
   * It also carries the PERF PLATE's counts, in the same shape and the same
   * call. That is the point of it: the plate is the same kind of object at a
   * twentieth of the rate and 49 % more canvas, so the pair is the argument
   * that the cost is the RATE and not the panel — and a pair assembled from
   * two probe calls at two moments is a comparison of two windows.
   * `plate` is null without `?perf=1`, which is every player's session.
   *
   * Returns null before there is a ship to hang a panel on.
   */
  hud(next?: string | number): (HudReport & { plate: CanvasPanelReport | null }) | null
  /**
   * DEV-244. How the HUD's texture is UPLOADED, read or set — the other half of
   * `hud()`'s lever, and the one that attacks the TAIL rather than the median.
   *
   *     __ff2.hudUpload()          // read, without moving anything
   *     __ff2.hudUpload('nomip')   // no mip chain, no anisotropy
   *     __ff2.hudUpload('mip')     // back to the shipped texture
   *
   * A separate call rather than a second argument to `hud()`, because the two
   * pins take different vocabularies and a single setter would have to guess
   * which one a bare string meant — which is the ambiguity `parseHudUpload`
   * refuses `off` over.
   *
   * Returns the same report `hud()` does, so a sweep reads one shape either
   * way. `upload` is the intent and `liveUpload` is classified off the
   * texture's own fields: equal is the only acceptable answer, and the trace
   * spec's `hud.upload` row refuses a run where they differ.
   */
  hudUpload(next?: string): (HudReport & { plate: CanvasPanelReport | null }) | null
  /**
   * DEV-256. Which BACKEND rasterises the HUD's canvas, read or set — the third
   * pin on the panel, and the one that questions the pipeline rather than the
   * rate or the bytes.
   *
   *     __ff2.hudRaster()        // read, without moving anything
   *     __ff2.hudRaster('cpu')   // willReadFrequently: the software canvas that SHIPS
   *     __ff2.hudRaster('gpu')   // the way back: a GPU-rastered canvas
   *
   * **A set here is a REBUILD, not a field write**, and that is the one way
   * this call differs from the other two: `getContext` options are honoured
   * only on a canvas's first context, so `setRaster` builds a new canvas, a new
   * `CanvasTexture` and points the material at it. The old texture is disposed
   * and the old pixels are carried across, so the panel does not blink — but
   * the rebuild is real and `rasterRebuilds` in the report counts it.
   *
   * **Under `?hudRedraw=freeze` a flip here measures nothing**: with no
   * repaints admitted there is no raster to price, and the carried pixels stand
   * for the rest of the run. Pin `?hudRaster=` at LOAD for a frozen comparison.
   *
   * Returns the same report `hud()` does. `raster` is the intent and
   * `liveRaster` is read off the live context's `getContextAttributes()` —
   * which catches a pin that never reached `getContext`, and does not by itself
   * prove Chromium honoured the hint. That half is the Chrome trace's.
   */
  hudRaster(next?: string): (HudReport & { plate: CanvasPanelReport | null }) | null
  /**
   * DEV-257. `__ff2.hudGauges()` reads; `__ff2.hudGauges('needle')` moves.
   *
   *     __ff2.hudGauges()             // read, without moving anything
   *     __ff2.hudGauges('bar')        // speed as a bar, digits coarsened
   *     __ff2.hudGauges('needle')     // speed as a swept pointer
   *     __ff2.hudGauges('bar-only')   // …and no speed digits at all
   *     __ff2.hudGauges('off')        // back to the shipped panel
   */
  hudGauges(next?: string): (HudReport & { plate: CanvasPanelReport | null }) | null
  /**
   * Every material the mission scene would draw, and whether DEV-192's
   * point-light cut reached it. Raw rows with no verdict — the verdict lives
   * in `tests/e2e/point-light-scope.spec.ts`, which holds its own copy of the
   * rule so the two can disagree.
   */
  pointLightScope(): {
    path: string
    material: string
    name: string
    drawn: boolean
    scoped: boolean
    scope: string | null
  }[]
  /**
   * Lift the curtain. The canvas is solid black from boot and stays that way
   * until the landing card is dismissed AND the first world has settled — L3
   * and L4 of `docs/plan/LOADING.md`, DEV-107.
   *
   * Calling it twice is harmless; calling it before the world lands queues it.
   */
  /**
   * Lift the curtain, and NOTHING else. DEV-279.
   *
   * `reveal()` does this too, and also builds the AudioContext, which is why
   * it belongs on the player's first gesture and this does not. A browser suspends a
   * context created without a user gesture behind it, and the 40 ms that
   * builds one is measured (see `reveal`), so the gesture keeps that job.
   *
   * Called at boot by `main.ts` so the title valley is on screen BEFORE the
   * press, the way polyfish starts its render loop before its title screen.
   * The `firstWorldSettled` half of the gate is untouched: a half-built world
   * still assembles behind black, which is what L4 of `docs/plan/LOADING.md`
   * actually argues for. What goes is the extra wait for a human.
   */
  showWorld(): void
  /**
   * The page's first gesture (DEV-557; the landing card's Start click until
   * then): lift the curtain, build the AudioContext inside the gesture, and
   * mark the page as having had its press (`cardLifted` in `boot/app.ts`).
   * `main.ts` calls it from the event handler of the first key, click or touch.
   */
  reveal(): void
  /**
   * How far the world is, pushed on every change (L1, DEV-107).
   *
   * Fires once per terrain chunk while the islands generate, so a listener must
   * be cheap. Called immediately with the current state on subscribe, which is
   * what lets `main.ts` paint the button without waiting for the next chunk.
   */
  onLoadProgress(listener: (state: LoadState) => void): void
  /**
   * DEV-471: `?edit=1`'s editor, as the landing card waited on it until
   * DEV-557 took the card away; kept for a listener that wants it. Called at
   * once with the phase as it stands and again on every change — and NEVER on
   * a boot that did not ask for the editor, so a listener anywhere else costs
   * nothing and is never called. `main.ts` holds the card over the world while
   * it is `loading` and takes it away, with no press, at `ready`.
   */
  onEditorBoot(listener: (phase: EditorBootPhase) => void): void
  /**
   * The live transition. An accessor, because `phase` changes every frame.
   *
   * `document.body.dataset.fade` carries the same `phase` for a spec that
   * cannot reach `__ff2` — a production build, or a `waitForSelector`.
   */
  fade(): {
    amount: number
    phase: FadePhase
    busy: boolean
    /** Screen transitions queued so far — one black each. See `screenFades`. */
    screenFades: number
  }
  /**
   * The lift: its phase, its rise, and whether this world build still owes a
   * ride. Same reasoning again — all three change on a mission swap.
   *
   * `ridePending` is null on the six missions with no launch rig. DEV-094.
   */
  launch(): { phase: LaunchPhase; rise: number; ridePending: boolean | null }
  /**
   * The level select's live aim and page, or null before the room exists.
   *
   * It earns its place the way `racers()` did. Two e2e specs went red the day
   * the picker landed, and "is the resting gaze on a table, and WHICH" had no
   * answer from outside the page — so a one-line interaction bug read as a
   * regression in the picker. One probe answered it.
   */
  /**
   * The scene currently on screen — the MENU world or the mission world.
   *
   * They are different `THREE.Scene`s now (2016 keeps its menus in their own
   * scenes; DEV-076), so "is the island drawn" is no longer a question about
   * anything's `visible` flag and a spec that traverses `render.scene` gets the
   * wrong answer confidently. This is the one it should traverse.
   */
  stage(): THREE.Scene
  /**
   * DEV-465: where a course switch is being waited out, named — `room` (the
   * plate in the hangar), `scene` (DEV-355's loading scene) or null while no
   * plate is up — the course it names, and the course the room is focused on.
   * A spec waits on THIS rather than on what is drawn, so the one it wants is
   * the one it names.
   */
  loading(): {
    place: LoadingPlace | null
    target: string | null
    focus: string | null
  }
  /**
   * DEV-469: the course editor, as plain values — whether it is up, the
   * playtest in flight (its course id), and the desk's own probe (null until
   * the desk has loaded) — and the desk's test hooks for `editor-desk.spec.ts`.
   */
  editor(): {
    editing: boolean
    flying: string | null
    desk: unknown
    /** DEV-476: the last re-bake of the sun maps under a moved sun, milliseconds. */
    sunBake: { farShadowMs: number; skyVisibilityMs: number; skyMs: number } | null
  }
  editorDebug(): DeskDebug | null
  /** DEV-492: the VR bench, as plain values: up, the door, and the bench's own probe. */
  bench(): {
    up: boolean
    door: { up: boolean; aimed: boolean }
    flying: boolean
    probe: BenchProbe | null
  }
  /**
   * DEV-558: the Custom Courses shelf (DEV-488), as its own probe reads it:
   * whether its door stands and is aimed, whether the shelf is open, what its
   * tables stand for (the COURSES hub's actions first, then the courses), and
   * what the pointer is on.
   */
  courseShelf(): YourCoursesProbe
  hangarAim(): {
    aim: HangarAim | null
    page: number
    view: HangarView
    /**
     * The screen the app is on (DEV-558). The room lays its first step at boot,
     * under the title, so `view` alone does not say a press reaches the room:
     * a walk waits for `'menu'` before it aims.
     */
    screen: 'title' | 'menu' | 'mission'
    /** The steps this room walks (DEV-382): five on Anniversary, four on Classic. */
    views: HangarView[]
    /** The open aircraft's variants and their records; empty on the first step and on Classic. */
    variants: { id: string; name: string; flown: number; courses: number; lastFlown: boolean }[]
    /** The open variant's id, below the variant step; null above it and on Classic. */
    variant: string | null
    /**
     * Every aircraft, every flight plan of the one that is open, and every rank
     * of the plan that is open, with how much of each has been flown.
     *
     * The one thing a spec cannot read any other way: the tables carry their
     * progress as PIXELS ON A CANVAS. Without this, "the run you just finished
     * shows up on the table you launched from" — `HangarArt.refresh` — is only
     * checkable by looking at a screenshot, which is how the title jets flew
     * backwards for four sessions.
     *
     * `modes` is empty on the aircraft step and `ranks` above the ranks step,
     * because nothing is open yet.
     */
    vehicles: { vehicle: string; name: string; flown: number; courses: number }[]
    modes: { mode: string; name: string; flown: number; courses: number }[]
    ranks: { difficulty: string; name: string; flown: number; courses: number }[]
    /**
     * DEV-558: the door tables on the step that is up (the first step, or
     * Multiplayer's), left to right, with their words; empty off a door step.
     */
    doors: { id: string; name: string; detail: string; note: string }[]
  } | null
  /**
   * The on-screen thumbsticks, or a do-nothing stand-in on a device with no
   * touchscreen.
   *
   * Exposed because ONE thing about them was not `app.ts`'s to decide: whether
   * the landing card was still up. Since DEV-557 there is no card and
   * `main.ts` calls `setVisible(true)` at boot; see `TouchControls.setVisible`.
   */
  readonly touch: TouchControls
  /**
   * The last few seconds of frame times. Always recording — the ring is 9 KB
   * and the feed is O(1), so `app.perf.stats()` answers from the console at any
   * moment. `?perf=1` adds the panel that displays it (`boot/perf-hud.ts`).
   */
  readonly perf: FrameRecorder
  /**
   * What the last frame drew, by group, and the measured overdraw. DEV-118's
   * attribution; a diagnostic that runs only when called. Between frames only.
   */
  census(): Census
  /** The frame's GPU time, when enabled. `?perf=1` enables it; `__ff2.gpu.enable()` too. */
  readonly gpu: GpuTimer
  /**
   * The read-only handle that SHIPS — `globalThis.__ff2perf` (VR-PERF §5.4).
   *
   * Non-null only under `?perf=1`. Everything above is a live object and lives
   * behind `import.meta.env.DEV`; this is frozen snapshots and an allow-list,
   * and `main.ts` attaches it OUTSIDE the dev block — because a headset only
   * ever opens the deployed URL, and until now there was nothing to read there.
   * See `boot/perf-surface.ts`. NOT called `perf`: that is the recorder, and
   * two specs already read it under that name.
   */
  readonly perfSurface: PerfSurface | null
  /**
   * `?snap=<seconds>`, and whether it has fired. For a spec that has to know
   * WHETHER the sim is frozen rather than infer it from a clock that might
   * simply be between ticks. See `boot/snap.ts`.
   */
  snap(): { at: number | null; frozen: boolean }
  /** The out-of-bounds clock and the static it draws (DEV-127). */
  boundary(): { phase: string; outsideFor: number; progress: number; fuzz: number }
  /** CHANGE VIEW's state, per frame (DEV-128). See the implementation's note. */
  thirdPerson(): { wanted: boolean; live: boolean; spring: boolean; armLength: number }
  start(): void
  stop(): void
  /**
   * DEV-446. The scene tint: what it is drawing now, and the authoring value
   * `?lookdev=1` writes — which a spec writes the same way, so a photograph of
   * a tint is taken through the one door a person uses.
   */
  readonly sceneTint: Pick<SceneTint, 'report' | 'setOverride'>
}
