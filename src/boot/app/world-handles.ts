// src/boot/app/world-handles.ts: the world's handles, as ONE record with one
// owner. APP-SPLIT phase 3, slice 1 (`docs/plan/APP-SPLIT.md` §4a).
//
// ── What this replaces ───────────────────────────────────────────────────
//
// `bootApp` held these as closure `let`s. `buildWorld` and `buildTitleWorld`
// assigned them, and `teardownWorld` disposed and nulled them one by one in a
// second list kept by hand. Nothing checked that the two lists agreed, so a
// handle somebody added to a build and forgot in the teardown survived every
// course swap. The field docs below are the ones those `let`s carried, moved
// verbatim.
//
// ── What a field here is ─────────────────────────────────────────────────
//
// Exactly what `teardownWorld` takes down: a world build writes it, and a
// course swap releases it.
//
// ── The release ──────────────────────────────────────────────────────────
//
// `disposeWorldHandles` takes a table with one disposer per field, typed
// against this record, so a field without a disposer, or a disposer for a
// field that does not exist, is a compile error rather than a leak somebody
// finds a week later; `tests/unit/world-handles.test.ts` holds the same as a
// relationship over the record's own keys. A handle with nothing of its own to
// free says so with `resetOnly`. The table's ORDER is the order the disposers
// run in, which is the order `teardownWorld` spelled them in before this
// record existed, side effects and all; every disposer runs before any field
// is emptied.
//
// Types only, apart from the four functions: nothing here builds anything, so
// it is safe to import from a node test.

import type * as THREE from 'three'
import type { LoadedTraffic } from '@/game/ambient-traffic'
import type { LoadedClouds } from '@/game/clouds'
import type { Flight } from '@/game/flight'
import type { LoadedGhosts, PlayerGhost } from '@/game/ghosts'
import type { LapRun } from '@/game/lap-run'
import type { Life } from '@/game/life/load-life'
import type { LoadedOrbs } from '@/game/orb-art'
import type { LoadedPads } from '@/game/pad-art'
import type { ParticleFx, SeaSource } from '@/game/particle-fx'
import type { LineMask, WorldClearingInput } from '@/game/props/course-clearing'
import type { LoadedDressing } from '@/game/props/load-dressing'
import type { loadProps } from '@/game/props/load-props'
import type { LoadedRacers } from '@/game/racers'
import type { LoadedRings } from '@/game/rings'
import type { LoadedTerrain } from '@/game/terrain/load-terrain'
import type { TitleTrails } from '@/game/title-trails'
import type { Elevator } from '@/render/elevator'
import type { HangarArt } from '@/render/hangar'
import type { HorizonGeo } from '@/render/horizon-geo'
import type { LiftSeal } from '@/render/lift-seal'
import type { Pause } from '@/render/pause'
import type { PropFracture } from '@/render/prop-fracture'
import type { Sky } from '@/render/sky'
import type { StartGrid } from '@/render/start-grid'
import type { Title } from '@/render/title'
import type { TitleCurtain } from '@/render/title-curtain'
import type { UnityFog } from '@/render/unity-fog'
import type { InstancedHalos } from '@/render/vr-halo'
// DEV-143. The boost tank: `sim/energy.ts` owns the arithmetic and takes every
// number but the preset's `rechargeScale` off the generated sheet.
// DEV-144. The energy race's tank: gates pay in, flying takes out, empty is the
// end of the run. Never live at the same time as the boost tank above.
import type { PropColliders, PropCollisionState } from '@/sim/props/collision'
// `terrainHeightAt` is gone from this file with DEV-042's lift: the title rig's
// height is now 2016's own, composed rather than rescued, and the mission
// terrain's field is passed straight to the sim. Nothing here samples ground.
import type { HeightField } from '@/sim/terrain/height-field'
import type { Lookdev } from '../lookdev'
// DEV-388: the generated-content manifest, digested for a room's `join` (§6.7).
import { _headQuat } from './head-scratch'
import type { applyLighting } from './lighting'

/** The world's handles: what a world build writes and a course swap releases. */
export interface WorldHandles {
  // The mission decides the light, the fog and the sky. Loaded before the
  // terrain because it is one small JSON and the scene should never be lit by
  // a placeholder, even for the second it takes the island to generate.
  flight: Flight | null
  liveGhosts: LoadedGhosts | null
  /**
   * DEV-371: the player's laps and the ghost of the one being raced. Built per
   * world where the mode races (`rulesFor(mode).opponents`), null elsewhere.
   * The ghost is a THIRD slot beside `OPPONENTS`: it flies with the racers,
   * never instead of them, and nothing touches it (see `loadPlayerGhost`).
   */
  lapRun: LapRun | null
  livePlayerGhost: PlayerGhost | null
  liveOrbArt: LoadedOrbs | null
  livePadArt: LoadedPads | null
  /** DEV-568: the launch rig redraws the hangar's curve for the look now on (`render/hangar-art.ts`). */
  liveLaunchLook: (() => void) | null
  liveRacers: LoadedRacers | null
  /**
   * DEV-146. Another mission's ships over this island, scoring nothing.
   *
   * Deliberately NOT `liveRacers`, and that is the whole isolation story: every
   * place a racer is counted reads `liveRacers` — the results panel's
   * `opponentTimes`, `dataset.opponents`, `racerEngines.sync`, the chase camera,
   * the title screen — so traffic is absent from all of them by construction
   * rather than by a filter somebody has to remember to write. It is also
   * independent of `rulesFor(RUNNING_MODE).opponents`: a JumpSeat mission has no
   * opponents at all, which is exactly the mission this feature exists for.
   */
  liveTraffic: LoadedTraffic | null
  liveClouds: LoadedClouds | null
  liveSky: Sky | null
  /** The far shore (DEV-119). Per world; the flag only shows or hides it. */
  liveHorizonGeo: HorizonGeo | null
  /** The bare shell at the base of the launch shaft. See `HangarOptions.furnished`. */
  launchRoom: HangarArt | null
  liveLookdev: Lookdev | null
  liveTerrain: { terrain: LoadedTerrain; ocean: LoadedTerrain | null } | null
  liveFx: ParticleFx | null
  /**
   * DEV-613: the sea the splashes read, SIM space (the spray's `SeaSource`),
   * and each jet's crossing state by who it is. Per world: null and empty
   * between worlds, set where the spray's sea is.
   */
  liveSea: SeaSource | null
  /**
   * The course's gates, once the world is built. Held for DEV-122's passed-gate
   * fade (a run event -> a render change) and DEV-123's finish banner (a preset
   * flip -> a rebuild); null between worlds, like every other live handle.
   */
  liveRings: LoadedRings | null
  /**
   * DEV-336: the gate studs' halos, the headset's bloom. Parented beside the
   * studs inside `rings.object`, so they leave with the world; null on a
   * course with no gates (the studs' mesh keeps one placeholder instance
   * there, and a halo on it would glow at the origin).
   */
  liveStudHalos: InstancedHalos | null
  /** V9's scenery (DEV-089). Out here because the flocks are advanced per frame. */
  liveDressing: LoadedDressing | null
  /** The life pass (DEV-447): the boats. Out here because they ride the sea per frame. */
  liveLife: Life | null
  autopilotTerrain: readonly HeightField[]
  /** What a racer's HULL is tested against — islands AND the ocean plate. */
  collisionTerrain: readonly HeightField[]
  elevator: Elevator | null
  /**
   * 2016's shaft, sealed against the world (DEV-460, `render/lift-seal.ts`):
   * the sea's hole in its outline, where it sits in the world, and whether it
   * is open. Null until 2016's rig lands, and with the generated one.
   */
  liftSeal: {
    readonly seal: LiftSeal
    readonly x: number
    readonly z: number
    readonly topY: number
    readonly table: Float32Array
    live: boolean
  } | null
  /**
   * The chunk meshes the shaft BORE passes through — DEV-249, `?rideHide=bore`.
   *
   * Empty under `?rideHide=all`, and empty on the six missions with no rig.
   * Rebuilt with the world, because the chunk meshes are.
   */
  boreChunks: THREE.Object3D[]
  /**
   * The same selection, by NAME — because the group grows meshes afterwards.
   *
   * `boreChunks` is a snapshot of `terrain.group.children` taken once, when the
   * world is built. `load-terrain.ts` then adds a second mesh to that same
   * group every time a chunk cross-fades between LODs
   * (`chunk_5_5:incoming`), and one of those is a mesh the selection could
   * never have contained. So the bore's own chunk went on being hidden while
   * its incoming half drew the hillside inside a sealed shaft, for
   * `lodTransitionTime` — **one second** on alpine.
   *
   * `07bf549` argued that *"`chunk.visible = revealed` is written EVERY frame,
   * so the chunks come back at the reveal and no hole can outlive the ride"*.
   * That is true, and it is a statement about the chunks in the list. DEV-268.
   */
  boreChunkNames: Set<string>
  startGrid: StartGrid | null
  title: Title | null
  missionSun: ReturnType<typeof applyLighting>
  /**
   * The title valley, held so the swap can dispose it. Local to the builder
   * otherwise, and it is a `LoadedTerrain` like the island is.
   */
  liveTitleValley: LoadedTerrain | null
  /** The props under the island, which the island will not dispose for us. */
  livePropsDispose: (() => void) | null
  /** The title valley's forest, same reason. DEV-155. */
  titleValleyPropsDispose: (() => void) | null
  /**
   * The two ships the flypast flies. DEV-281.
   *
   * The title screen's own, since boot stopped building a mission for them to
   * be borrowed from — `main_menu.unity`'s two `SplineWalker`s carry their own
   * ships too. Held here rather than reached for through `title` because
   * `Title.update` takes the array as an argument: it flies what it is handed
   * and owns none of it, which is the property that let it borrow in the first
   * place.
   */
  liveTitleJets: readonly THREE.Object3D[]
  // DEV-412: the flypast's trails (world-space, at the scene root) and the
  // wings' glows, both freed with the title.
  liveTitleTrails: TitleTrails | null
  liveTitleGlows: { dispose(): void }[]
  /**
   * The black over the title valley while it assembles, with the emblem lit
   * on top of it (DEV-352, `render/title-curtain.ts`). Null before the title
   * builds, and again once it has lifted and left the scene.
   */
  titleCurtain: TitleCurtain | null
  /**
   * The title's rows: START and ENTER VR, and a link's row above them when a
   * link brought the page here (DEV-558, `render/title-menu.ts`). The pause
   * plate's own painter and hit test, hung under the rig (that file says why
   * that and not a new one). Null on a boot that never shows the title.
   */
  titleMenu: Pause | null
  /**
   * The title screen's own air — `main_menu.unity`'s fog, and Pisa's ambient.
   * DEV-155.
   *
   * A SECOND `UnityFog` rather than a retune of the mission's: the two worlds
   * are 30 km apart in one scene and only one of them is ever on screen, so
   * they can each carry their own atmosphere and nothing has to be swapped per
   * frame. The probe is a scene light, so that one IS swapped — by intensity,
   * beside the sun that already swaps.
   */
  titleFog: UnityFog | null
  titleProbe: THREE.LightProbe | null
  titleSky: Sky | null
  /**
   * The mission probe's own gain, captured the first time it is dimmed.
   *
   * Read off the light rather than recomputed from the sheet: `applyLighting`
   * decides it (`?ambient=sky` takes a different route to the same number) and
   * a second derivation here would be a second thing to keep in step.
   */
  missionProbeGain: number | null
  // DEV-136: the props' colliders, the contact state, and the fracture group.
  // All three per WORLD, rebuilt at every course swap and null on Classic.
  livePropColliders: PropColliders | null
  livePropCollision: PropCollisionState | null
  liveFracture: PropFracture | null
  /** The drawn props, held so a hit can hide the instance it names. */
  livePropsLive: Awaited<ReturnType<typeof loadProps>>
  /**
   * DEV-502: a player course's clearing, MASKED on this world's scatter
   * (`game/props/course-clearing.ts`), and what the world was built from, so
   * the editor can re-mask a draft's line on it. Per world, like the three
   * above; null on a world with no scatter.
   */
  liveLineMask: LineMask | null
  worldClearingInput: WorldClearingInput | null
}

/**
 * The record between two worlds: every handle null, every list empty. A NEW
 * object each call, with new lists, so a released record never shares a list
 * with the one it replaced. These are the values the `let`s were declared
 * with, and the values `teardownWorld` assigned back.
 */
export const emptyWorldHandles = (): WorldHandles => ({
  flight: null,
  liveGhosts: null,
  lapRun: null,
  livePlayerGhost: null,
  liveOrbArt: null,
  livePadArt: null,
  liveLaunchLook: null,
  liveRacers: null,
  liveTraffic: null,
  liveClouds: null,
  liveSky: null,
  liveHorizonGeo: null,
  launchRoom: null,
  liveLookdev: null,
  liveTerrain: null,
  liveFx: null,
  liveSea: null,
  liveRings: null,
  liveStudHalos: null,
  liveDressing: null,
  liveLife: null,
  autopilotTerrain: [],
  collisionTerrain: [],
  elevator: null,
  liftSeal: null,
  boreChunks: [],
  boreChunkNames: new Set<string>(),
  startGrid: null,
  title: null,
  missionSun: null,
  liveTitleValley: null,
  livePropsDispose: null,
  titleValleyPropsDispose: null,
  liveTitleJets: [],
  liveTitleTrails: null,
  liveTitleGlows: [],
  titleCurtain: null,
  titleMenu: null,
  titleFog: null,
  titleProbe: null,
  titleSky: null,
  missionProbeGain: null,
  livePropColliders: null,
  livePropCollision: null,
  liveFracture: null,
  livePropsLive: null,
  liveLineMask: null,
  worldClearingInput: null,
})

/** One disposer per field of `H`, each handed that field's value. */
export type Disposers<H extends object> = { readonly [K in keyof H]: (handle: H[K]) => void }

/** What `teardownWorld` does with each world handle before the record is emptied. */
export type WorldDisposers = Disposers<WorldHandles>

/** A handle with nothing of its own to free: emptying the record is its whole teardown. */
export const resetOnly = (): void => {}

/**
 * Run every disposer, in the table's order, each with its field's CURRENT
 * value; then put every field back to `empty()`. No field is emptied until
 * every disposer has run, so a disposer never sees another handle half-released.
 * Generic so its test can drive it with a record of its own.
 */
export const releaseHandles = <H extends object>(
  handles: H,
  disposers: Disposers<H>,
  empty: () => H,
): void => {
  for (const key of Object.keys(disposers) as (keyof H)[]) disposers[key](handles[key])
  Object.assign(handles, empty())
}

/** `teardownWorld`'s release: every world handle through its disposer, then empty. */
export const disposeWorldHandles = (handles: WorldHandles, disposers: WorldDisposers): void =>
  releaseHandles(handles, disposers, emptyWorldHandles)
