// src/boot/app/tv/panel.ts: TV's exhibition and its on-screen layer, out of
// `bootApp`. APP-SPLIT phase 4 (`docs/plan/APP-SPLIT.md` §1b; plan/FF-TV.md).
//
// DEV-483's exhibition (the AI racers, racing for nobody) and DEV-482's panel
// and its sound (`render/tv-panel.ts`). Every line below was moved verbatim
// from the closure; the plumbing is `ctx.x` where the code reads a binding the
// closure still owns (a getter, and a setter where this code writes one: the
// §6 rule 3 bag), and the returned object.

import type { AudioSystem } from '@/audio'
import type { World } from '@/boot/app/world/switch'
import type { Capabilities } from '@/boot/capability-gate'
import type { TvWatchCamera } from '@/boot/tv-watch-camera'
import { assetUrl } from '@/content/asset-url'
import type { GameMode, Level } from '@/content/level-schema'
import type { EditionState } from '@/game/edition'
import { loadPlayerGhost } from '@/game/ghosts'
import { environmentDisplayName, loadMissionIndex, type MissionCard } from '@/game/mission-index'
import { quickRacePool } from '@/game/quick-race'
import type { LoadedRacers } from '@/game/racers'
import { racerName, raceTimeLimit } from '@/game/results-state'
import type { ExhibitionField } from '@/game/tv/exhibition'
import {
  createExhibitionControl,
  exhibitionFieldOf,
  exhibitionGhostOf,
} from '@/game/tv/exhibition-view'
import type { TvView } from '@/game/tv/tv-view'
import { fetchLap } from '@/net/lap-client'
import { loadMesh } from '@/render/load-mesh'
import type { Renderer } from '@/render/renderer'
import { createTvPanel, type TvPanel } from '@/render/tv-panel'
import { createTvControls } from '@/render/tv-panel-controls'
import {
  type TvPanelFeed,
  type TvPanelInput,
  tvCourseLabel,
  tvFeedFromExhibition,
} from '@/render/tv-panel-layout'
import type { UnityFog } from '@/render/unity-fog'
import type { PropHit } from '@/sim/props/collision'
import type { createScreenRouter } from '../screen-router'
import type { WorldHandles } from '../world-handles'

/** What `createTvPanelHost` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface TvPanelHostCtx {
  readonly RUNNING_MODE: GameMode
  readonly audio: AudioSystem
  readonly breakProps: (
    hits: readonly PropHit[],
    velocity: { readonly x: number; readonly y: number; readonly z: number },
    who: string,
  ) => void
  readonly capabilities: Capabilities
  readonly editionState: EditionState
  readonly fog: UnityFog
  readonly handles: WorldHandles
  readonly level: Level
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  quickRaceCards: Promise<MissionCard[]> | null
  readonly render: Renderer
  readonly router: ReturnType<typeof createScreenRouter>
  readonly switchMission: (
    id: string,
    opts?: { readonly skipRide?: boolean; readonly inLoadingScene?: Level; readonly level?: Level },
  ) => Promise<void>
  readonly switching: boolean
  readonly tvActive: () => boolean
  readonly tvView: TvView
  readonly tvWatch: TvWatchCamera
  readonly world: Promise<World> | null
}

export const createTvPanelHost = (ctx: TvPanelHostCtx) => {
  const {
    audio,
    breakProps,
    capabilities,
    editionState,
    handles,
    render,
    router,
    switchMission,
    tvActive,
    tvView,
    tvWatch,
  } = ctx
  // ── DEV-483: TV's exhibition — the AI racers, racing for nobody ─────────
  // The host of `game/tv/exhibition.ts` (whose header has the why). The local
  // craft is never launched: `exhibitionTick` takes every tick above the lift's
  // return. `exhibition.start` is §9.1's `startExhibition`, for DEV-480's door;
  // until it lands, `__ff2.exhibition`.
  let exhibitionField: { of: LoadedRacers; field: ExhibitionField } | null = null
  const exhibition = createExhibitionControl(
    {
      courses: async () => {
        ctx.quickRaceCards ??= loadMissionIndex()
        return quickRacePool(await ctx.quickRaceCards).map((c) => c.id)
      },
      board: async (id) => {
        // Already on it (a `?mission=` boot): back to the pads, no swap. DEV-480:
        // not a world built under a watch, which loaded no racers.
        if (
          router.screen === 'mission' &&
          ctx.world &&
          ctx.level.id === id &&
          !ctx.switching &&
          handles.liveRacers
        ) {
          handles.liveRacers.reset()
        } else await switchMission(id, { skipRide: true })
      },
      aboard: (id) =>
        router.screen === 'mission' &&
        !ctx.switching &&
        !router.pendingScreen &&
        !!ctx.world &&
        ctx.level.id === id,
      field: () => {
        const racers = handles.liveRacers
        if (!racers) return null
        if (exhibitionField?.of !== racers) {
          const field = exhibitionFieldOf(
            racers,
            raceTimeLimit(ctx.level, ctx.RUNNING_MODE),
            (dt) => {
              const g = editionState.current.gameplay
              const props = handles.livePropColliders
              racers.step(
                handles.autopilotTerrain,
                dt,
                handles.collisionTerrain,
                g.crash,
                props && { colliders: props, spec: g.propCollision },
                { ...g.racers, player: null, hit: null, others: null },
              )
              if (!props || !handles.livePropsLive) return
              for (const r of racers.racers)
                breakProps(r.props.hits, r.jet.body.velocity, r.spec.id)
            },
          )
          exhibitionField = { of: racers, field }
        }
        return exhibitionField.field
      },
      fetchLap: async (id) => {
        const r = await fetchLap(id)
        if (!r.ok) return r.reason
        const { mission, doc, seconds, handle } = r.lap
        return { id, mission, doc, seconds: seconds > 0 ? seconds : null, handle }
      },
      ghost: async (lap) => {
        const at = ctx.level.worldOffset as [number, number, number]
        const g = await loadPlayerGhost(at, lap.doc, editionState)
        if (g.wingTrails) ctx.fog.applyTo(g.wingTrails.trails.material)
        return exhibitionGhostOf(g, render.scene)
      },
      now: () => Date.now(),
      log: (line) => console.info(line),
    },
    {
      screen: () => router.screen,
      switching: () => ctx.switching,
      craft: () => handles.flight?.object ?? null,
      view: (ex, dt) => tvWatch.exhibition(ex, dt),
    },
  )
  const exhibitionTick = exhibition.tick
  // ── end DEV-483 ─────────────────────────────────────────────────────────

  // ── DEV-482: TV's on-screen layer and its sound (`render/tv-panel.ts`) ──
  // The ident, the lower third and the results card (plan/FF-TV.md §5.2), and
  // the sting and the soundtrack's two cues (§5.4). DEV-480's TV block writes
  // `tvPanelInput.live` for a room's race and `.lobbies` from the list; with no
  // live feed the exhibition's is built here. A press on a name follows it.
  const tvPanelInput: TvPanelInput = { live: null, lobbies: null }
  let tvPanelCards: readonly MissionCard[] | null = null
  const tvPanel: TvPanel = createTvPanel({
    rig: render.rig,
    camera: render.camera,
    canvas: render.renderer.domElement,
    xr: render.renderer.xr,
    onPick: (n) => tvWatch.pick(n), // DEV-628: and spends the same click's tap
    // DEV-481 follow-up: rig-locked (re-placed on a mode change), unless the comfort cuts are on.
    anchor: () => {
      const r = tvWatch.report()
      return { perCut: r?.headsetCuts === true, key: r?.mode ?? '' }
    },
  })
  // DEV-617: TV's bug is the title's emblem, its own copy as the medals' and the
  // loading plate's are (DEV-113, DEV-434); a missing logo shows no bug.
  void loadMesh(assetUrl('assets/props/title-logo.glb'))
    .then((loaded) => {
      tvPanel.emblem(loaded.object)
      loaded.dispose()
    })
    .catch((error: unknown) => {
      console.warn('tv: no bug, the logo mesh is unavailable', error)
    })
  /** `Simonet Islands · Ring Attack` for course `id`: its card, else the level on screen. */
  const tvPanelCourse = (id: string | null): string => {
    if (id === null) return ''
    if (!tvPanelCards) {
      ctx.quickRaceCards ??= loadMissionIndex()
      void ctx.quickRaceCards.then((c) => {
        tvPanelCards = c
      })
    }
    const card = tvPanelCards?.find((c) => c.id === id)
    if (card) return tvCourseLabel(card.environmentName, card.modeName)
    return id === ctx.level.id
      ? tvCourseLabel(environmentDisplayName(ctx.level.environment), '')
      : ''
  }
  const tvPanelExhibitionFeed = (): TvPanelFeed | null => {
    const ex = exhibition.debug.probe()
    if (ex.phase === 'stopped') return null
    const racers = handles.liveRacers?.racers ?? []
    const byName = (n: string) => racers.find((r) => racerName(r.spec) === n)
    return tvFeedFromExhibition(ex, {
      course: tvPanelCourse(ex.course),
      colourOf: (n) => byName(n)?.spec.colour ?? null,
      ringsOf: (n) => {
        const r = byName(n)
        return r ? r.course.passed.filter(Boolean).length : null
      },
      gates: racers[0]?.course.passed.length ?? 0,
      following: tvWatch.report()?.following ?? null,
      linkFollows: null,
      lobbies: tvPanelInput.lobbies,
    })
  }
  // DEV-628: FF-TV's EXIT, MENU and the controls' hint, flat and on a phone.
  const tvControls = createTvControls({
    onExit: () => tvView.leave(),
    onMenu: () => tvView.toggle(),
  })
  /** Once a frame, after TV's camera has placed the rig. */
  const tvPanelFrame = (dt: number): void => {
    tvControls.update({
      shown:
        tvActive() &&
        router.screen === 'mission' &&
        !ctx.switching &&
        !render.renderer.xr.isPresenting,
      touch: capabilities.touch,
      plateUp: tvView.plateUp(),
      mode: tvWatch.camera?.mode() ?? null,
    })
    const feed = tvPanelInput.live ?? tvPanelExhibitionFeed()
    // DEV-866: the mini-map plate: the course, the field, the followed racer's speed in the HUD's unit.
    tvPanel.map(tvWatch.mapView(), editionState.current.hud.speedUnit)
    for (const cue of tvPanel.update(feed, dt, router.screen === 'mission' && !ctx.switching)) {
      if (cue === 'sting') audio.event({ type: 'tv.ident' })
      else audio.music.start(cue === 'music.go' ? 'go' : 'lift')
    }
    // DEV-654: the camera's lines (an overtake, the winner) go up on the lower third.
    const said = tvWatch.takeAnnouncement()
    if (said && feed) tvPanel.announce(said.line, said.kind)
  }
  // ── end DEV-482 ─────────────────────────────────────────────────────────
  return {
    exhibition,
    tvPanelCourse,
    tvPanelInput,
    exhibitionTick,
    tvPanelFrame,
    tvPanel,
    tvControls,
  }
}
