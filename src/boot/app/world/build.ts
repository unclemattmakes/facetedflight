// src/boot/app/world/build.ts: the mission world, built, out of `bootApp`.
// APP-SPLIT phase 4, slice 7 (world; `docs/plan/APP-SPLIT.md` §5).
//
// `buildWorld`, whole: the parallel load, the terrain passes, the props, the
// dressing, the start grid and the launch rig, the opponents and the laps, the
// shadows and bakes, the warm-up, and the publish, which stays LAST and in one
// place (the frame relies on `flight`, the terrain, the effects and the rings
// appearing together). It writes the world into `handles` (APP-SPLIT 3.1),
// whose release is `teardownWorld`'s registry. Every line below was moved
// verbatim from the closure; the plumbing is `ctx.x` where the code reads a
// binding the closure still owns (a getter, and a setter where this code
// writes one: the §6 rule 3 bag), and the returned object.

import * as THREE from 'three'
import type { Capabilities } from '@/boot/capability-gate'
import type { LoadProgress } from '@/boot/load-progress'
import type { ShakeLookdev } from '@/boot/lookdev-shake'
import { createSlicer } from '@/boot/slice'
import { assetUrl } from '@/content/asset-url'
import type { Edition, EditionCockpit, EditionHudPlacement } from '@/content/edition-schema'
import type { GameMode, Level } from '@/content/level-schema'
import { loadEnvironmentProps } from '@/content/load-environment'
import { loadNoPropVolumes } from '@/content/no-prop-volumes'
import { uiLabel } from '@/content/ui-strings'
import { loadAmbientTraffic } from '@/game/ambient-traffic'
import { loadClouds } from '@/game/clouds'
import type { EditionState } from '@/game/edition'
import { EYE, loadFlight } from '@/game/flight'
import { LOCAL_LAP_RULES } from '@/game/ghost-store'
import { loadGhosts, loadPlayerGhost, noGhosts } from '@/game/ghosts'
import { jumpSeatAutopilotOf } from '@/game/jumpseat-flight'
import type { ChosenGhost } from '@/game/lap-run'
import { createLapRun, ghostTagText } from '@/game/lap-run'
import { createLife, lifeWanted } from '@/game/life/load-life'
import type { MissionState } from '@/game/mission'
import { environmentDisplayName } from '@/game/mission-index'
import { terrainOriginSim } from '@/game/mission-shape'
import { countLabel, isLive, rulesFor } from '@/game/modes'
import { attachOrbArt, loadOrbs } from '@/game/orb-art'
import { loadPads } from '@/game/pad-art'
import { loadParticleFx, propBurstAtLoad, splashScale } from '@/game/particle-fx'
import type { LineClearingReceipt } from '@/game/props/course-clearing'
import { worldClearings } from '@/game/props/course-clearing'
import { loadDressing, spawnClearingsOf } from '@/game/props/load-dressing'
import { groundUnderGroupPoint, loadProps } from '@/game/props/load-props'
import { describeVolumes } from '@/game/props/no-prop-volumes'
import { seaLineFor } from '@/game/props/sea-line'
import { attemptCallsignSeed, roomCallsignSeed } from '@/game/race-callsigns'
import type { RacerStart } from '@/game/racer-grid'
import { racerStarts } from '@/game/racer-grid'
import { loadRacers, racesIn } from '@/game/racers'
import { roomPalette } from '@/game/remote-ships'
import { racerName } from '@/game/results-state'
import { GATE_FRAME_ORDER, loadRings } from '@/game/rings'
import type { SpeedLineRamp } from '@/game/speed-line-ramp'
import type { CraftSplashState } from '@/game/splash-crossing'
import { oceanFor } from '@/game/terrain/course-water'
import { customEnvironmentProps, customGroundOf, donorLand } from '@/game/terrain/custom-ground'
import { detailRingFor } from '@/game/terrain/detail-ring'
import {
  environmentTerrains,
  type LoadedTerrain,
  loadTerrain,
  oceanRingsSpecFor,
  terrainLocalPosition,
} from '@/game/terrain/load-terrain'
import { loadTurnIndicators } from '@/game/turn-indicators'
import type { BakedLight, BakedLightReport } from '@/render/baked-light'
import type { Bloom } from '@/render/bloom'
import type { CloudShadow } from '@/render/cloud-shadow'
import { attachEditionCoast, coastHeightTexture, coastMapFrom } from '@/render/coast'
import type { CockpitSelfShadow } from '@/render/cockpit-self-shadow'
import { createElevator, revealRiseFor } from '@/render/elevator'
import type { FarShadow } from '@/render/far-shadow'
import type { FlatFov } from '@/render/flat-fov'
import { installFragmentGates } from '@/render/fragment-gates'
import { createHangar } from '@/render/hangar'
import { readHeadPosition } from '@/render/head-pose'
import { createHorizonGeo, type HorizonWorld } from '@/render/horizon-geo'
import { glowMaterial } from '@/render/hover-glow'
import { type HudRaster, warmHudState } from '@/render/hud'
import type { IllustrativeLighting } from '@/render/illustrative'
import {
  columnRadiusOf,
  hatchHeightOf,
  holeTableFor,
  landRevealFor,
  sealLift,
  worldTopIn,
} from '@/render/lift-seal'
import { loadMesh } from '@/render/load-mesh'
import type { LodFadeSpec } from '@/render/lod-fade'
import type { ParticleOverride } from '@/render/particles'
import type { PerfPlate } from '@/render/perf-plate'
import { PLATE_SIDE } from '@/render/perf-plate'
import { scopeWorldPointLights } from '@/render/point-light-scope'
import { createPropFracture } from '@/render/prop-fracture'
import { paletteColour } from '@/render/racer-livery'
import type { Renderer } from '@/render/renderer'
import { CAMERA_FAR } from '@/render/renderer'
import type { SceneTint } from '@/render/scene-tint'
import type { SeaReflection } from '@/render/sea-reflection'
import type { SunShadows } from '@/render/shadows'
import { shadowMeshesOf } from '@/render/shadows'
import type { SkyVisibility } from '@/render/sky-visibility'
import { marmosetSunIntensity } from '@/render/skyshop-ibl'
import {
  createStartDeck,
  type DeckPlacement,
  insideConvex,
  START_DECK_MESH,
  type StartDeck,
} from '@/render/start-deck'
import {
  createStartGrid,
  cutShaftAtRim,
  deckPadsOf,
  heldAtRelease,
  NO_DECK,
  releasePadOf,
  START_PAD_MESH,
} from '@/render/start-grid'
import type { SurfaceGloss } from '@/render/terrain-surface'
import { toneLookOf } from '@/render/tone'
import type { UnityFog } from '@/render/unity-fog'
import { applyUnityPose } from '@/render/unity-space'
import { HOVERJET_FULL_ROLL_RATE, JUMPSEAT_FULL_ROLL_RATE, type Vignette } from '@/render/vignette'
import type { SunHalo } from '@/render/vr-halo'
import { createInstancedHalos } from '@/render/vr-halo'
import { warmWorldLinked } from '@/render/warm-up'
import { SHAFT_REACH_STEPS } from '@/render/water'
import { DEFAULT_HANGAR_DROP, hangarSpecFor } from '@/sim/hangar'
import { buildCanopyField } from '@/sim/props/canopy'
import type { Clearing } from '@/sim/props/clearing'
import { buildPropColliders, createPropCollision } from '@/sim/props/collision'
import { shRadiance } from '@/sim/sky-dome'
import { terrainHeightAt } from '@/sim/terrain/height-field'
import { sceneTintLookdevGroup } from '../../lookdev-scene-tint'
import { BUILD_VERSION } from '../../version'
import type { createAtmosphere } from '../atmosphere'
import { horizonReferenceY, horizonSeed } from '../horizon'
import { buildLookdev, LOOKDEV, type PlacementTuning } from '../lookdev-panel'
import {
  CHUNK_BATCH,
  editorPartialRun,
  flightVariantFor,
  GUIDE_SPLINE,
  HUD_WARM_PIN,
  KEEP_POINT_LIGHTS,
  LAUNCH_RIG_2016_WAIT_MS,
  MENU_EDITION,
  OCEAN_PIN,
  OCEAN_RINGS_PIN,
  OPPONENTS,
  PROP_CELLS,
  PROP_LOD,
  PROPS_ON,
  RIDE_HIDE,
  SWELL,
  TERRAIN_LIT,
  TINT_IS_SRGB,
  URL_TAINT,
} from '../pins'
import type { createResults } from '../results'
import type { createRoomCore } from '../room/core'
import type { createAppSettings } from '../settings'
import type { WorldHandles } from '../world-handles'

/**
 * DEV-489: milliseconds the last custom island's prop re-scatter took at world
 * build (`customEnvironmentProps`), for the receipt and `__ff2`. Module-level
 * for EDITOR_RUN's reason: the world build reads it before the editor block runs.
 */
export let customGroundPropsMs = 0

/**
 * DEV-489: the last world build's receipt for a custom island, or null for a
 * shipped one — every stage's milliseconds of main-thread work, wall time (so
 * it includes the frames `boot/slice.ts` lets through), and what it made.
 * `__ff2.customGround()` reads it; the e2e prints it.
 */
export let customGroundReceipt: Record<string, number | string> | null = null

/** What `createWorldBuild` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface WorldBuildCtx {
  readonly HANGAR_SEED: number
  readonly RUNNING_MODE: GameMode
  readonly _splashEye: THREE.Vector3
  readonly appSettings: ReturnType<typeof createAppSettings>
  readonly applyAtmosphere: (m: THREE.Material<THREE.MaterialEventMap>) => void
  readonly applyCourseClearing: (
    clearings: readonly Clearing[],
    levelId: string,
  ) => LineClearingReceipt | null
  readonly applyGroundAtmosphere: (m: THREE.Material<THREE.MaterialEventMap>) => void
  readonly applyPropAtmosphere: (m: THREE.Material<THREE.MaterialEventMap>) => void
  readonly applyPropVisibility: () => void
  readonly applyWireframe: (world: { terrain: LoadedTerrain; ocean: LoadedTerrain | null }) => void
  readonly atmosphere: ReturnType<typeof createAtmosphere>
  readonly bakedLight: BakedLight
  readonly bloom: Bloom
  readonly buildLesson: (
    sheet:
      | {
          readonly allRigidbodies: readonly {
            readonly angularDrag: number
            readonly collisionDetection: number
            readonly drag: number
            readonly fileId: string
            readonly interpolate: number
            readonly isKinematic: boolean
            readonly jointed: boolean
            readonly mass: number
            readonly name: string
            readonly path: string
            readonly positionInShipRootSpace: {
              readonly x: number
              readonly y: number
              readonly z: number
            }
            readonly useGravity: boolean
          }[]
          readonly artRotator: {
            readonly componentEnabled: boolean
            readonly gameObject: string
            readonly goalPitch: number
            readonly goalRoll: number
            readonly inputCurve: {
              readonly keys: readonly (
                | {
                    readonly inSlope: number
                    readonly outSlope: number
                    readonly time: number
                    readonly value: number
                  }
                | {
                    readonly inSlope: number
                    readonly outSlope: number
                    readonly time: number
                    readonly value: number
                  }
              )[]
              readonly postInfinity: number
              readonly preInfinity: number
            }
            readonly inputManager: { readonly ref: null }
            readonly inputTime: number
            readonly pitchMax: number
            readonly resetTime: number
            readonly rollMax: number
            readonly shipInput: {
              readonly ref: {
                readonly fileID: string
                readonly kind: string
                readonly name: string
              }
            }
            readonly speed: number
            readonly transitionCurve: {
              readonly keys: readonly (
                | {
                    readonly inSlope: number
                    readonly outSlope: number
                    readonly time: number
                    readonly value: number
                  }
                | {
                    readonly inSlope: number
                    readonly outSlope: number
                    readonly time: number
                    readonly value: number
                  }
                | {
                    readonly inSlope: number
                    readonly outSlope: number
                    readonly time: number
                    readonly value: number
                  }
              )[]
              readonly postInfinity: number
              readonly preInfinity: number
            }
          }
          readonly camera: {
            readonly fileId: string
            readonly firstPerson: {
              readonly eulerZXYDeg: { readonly x: number; readonly y: number; readonly z: number }
              readonly gameObjectFileId: string
              readonly line: number
              readonly live: boolean
              readonly path: string
              readonly positionInShipRootSpace: {
                readonly x: number
                readonly y: number
                readonly z: number
              }
              readonly rotationInShipRootSpace: {
                readonly w: number
                readonly x: number
                readonly y: number
                readonly z: number
              }
              readonly transformFileId: string
            }
            readonly script: string
            readonly shipArt: readonly (
              | { readonly active: boolean; readonly name: string }
              | { readonly active: boolean; readonly name: string }
            )[]
            readonly startInThirdPerson: boolean
            readonly targetCount: number
            readonly thirdPerson: {
              readonly eulerZXYDeg: { readonly x: number; readonly y: number; readonly z: number }
              readonly gameObjectFileId: string
              readonly line: number
              readonly live: boolean
              readonly path: string
              readonly positionInShipRootSpace: {
                readonly x: number
                readonly y: number
                readonly z: number
              }
              readonly rotationInShipRootSpace: {
                readonly w: number
                readonly x: number
                readonly y: number
                readonly z: number
              }
              readonly transformFileId: string
            }
            readonly thirdPersonChase: {
              readonly chainLive: boolean
              readonly detachesFromShip: boolean
              readonly look: {
                readonly fileId: string
                readonly interpolation: string
                readonly line: number
                readonly live: boolean
                readonly pointAxis: { readonly x: number; readonly y: number; readonly z: number }
                readonly speed: number
                readonly target: {
                  readonly eulerZXYDeg: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly gameObjectFileId: string
                  readonly line: number
                  readonly live: boolean
                  readonly path: string
                  readonly positionInShipRootSpace: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly rotationInShipRootSpace: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly transformFileId: string
                }
                readonly upAxis: { readonly x: number; readonly y: number; readonly z: number }
                readonly upTarget: {
                  readonly eulerZXYDeg: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly gameObjectFileId: string
                  readonly line: number
                  readonly live: boolean
                  readonly path: string
                  readonly positionInShipRootSpace: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly rotationInShipRootSpace: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly transformFileId: string
                }
              }
              readonly position: {
                readonly constrainPosition: boolean
                readonly constrainRotation: boolean
                readonly fileId: string
                readonly interpolation: string
                readonly line: number
                readonly live: boolean
                readonly maxSpeed: number
                readonly mode: number
                readonly outputPos: readonly boolean[]
                readonly smoothTimeSeconds: number
                readonly target: {
                  readonly eulerZXYDeg: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly gameObjectFileId: string
                  readonly line: number
                  readonly live: boolean
                  readonly path: string
                  readonly positionInShipRootSpace: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly rotationInShipRootSpace: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly transformFileId: string
                }
              }
              readonly zeroRoll: boolean
            }
          }
          readonly centerOfMassObject: {
            readonly fileId: string
            readonly name: string
            readonly note: string
            readonly path: string
            readonly positionInShipRootSpace: {
              readonly x: number
              readonly y: number
              readonly z: number
            }
          }
          readonly colliders: readonly (
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: { readonly radius: number }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly radius: number
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: { readonly radius: number }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly radius: number
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: { readonly height: number; readonly radius: number }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly direction: number
                  readonly directionAxis: string
                  readonly height: number
                  readonly kind: string
                  readonly radius: number
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: { readonly height: number; readonly radius: number }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly direction: number
                  readonly directionAxis: string
                  readonly height: number
                  readonly kind: string
                  readonly radius: number
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: { readonly radius: number }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly radius: number
                }
                readonly tag: string
              }
          )[]
          readonly energy: {
            readonly BoostBurnrate: number
            readonly DisableThese: readonly never[]
            readonly PlayerShip: { readonly ref: null }
            readonly RebootTime: number
            readonly componentEnabled: boolean
            readonly currentCooldownTime: number
            readonly currentEnergy: number
            readonly enableGravityOnReboot: number
            readonly engineBurnrate: number
            readonly enginesOn: number
            readonly gatesCleared: number
            readonly hasEnergy: number
            readonly hoverMotor: {
              readonly ref: {
                readonly fileID: string
                readonly kind: string
                readonly name: string
              }
            }
            readonly isBoosting: number
            readonly maxCooldownTime: number
            readonly maxEnergy: number
            readonly numGates: number
            readonly rechargeRate: number
            readonly shipDistance: number
            readonly shipHUD: {
              readonly ref: {
                readonly fileID: string
                readonly kind: string
                readonly name: string
              }
            }
            readonly speed: number
            readonly timerRunning: number
          }
          readonly guid: string
          readonly hasThruster: boolean
          readonly hoverMotor: {
            readonly componentEnabled: boolean
            readonly ground_fx: { readonly ref: null }
            readonly hoverForce: number
            readonly hoverHeight: number
            readonly layerMask: { readonly m_Bits: number; readonly serializedVersion: number }
            readonly thruster: { readonly ref: null }
          }
          readonly input: {
            readonly ToggleGravEnabled: number
            readonly afterburnerFX: {
              readonly ref: {
                readonly fileID: string
                readonly kind: string
                readonly name: string
              }
            }
            readonly boostPressed: number
            readonly brakePressed: number
            readonly componentEnabled: boolean
            readonly controlScheme: string
            readonly debounceTime: number
            readonly gameReady: number
            readonly gasPressed: number
            readonly glider_lockRollAndYaw: number
            readonly gravButtonEnabled: number
            readonly invertPitch: number
            readonly jetFX: {
              readonly ref: {
                readonly fileID: string
                readonly kind: string
                readonly name: string
              }
            }
            readonly lookInput: { readonly ref: null }
            readonly pause: number
            readonly pitchSensitivity: number
            readonly pitchValue: number
            readonly rebootPressed: number
            readonly rebooting: number
            readonly rollSensitivity: number
            readonly rollToYawRatio: number
            readonly rollValue: number
            readonly shipHUD: { readonly ref: null }
            readonly shipMotor: {
              readonly ref: {
                readonly fileID: string
                readonly kind: string
                readonly name: string
              }
            }
            readonly throttleVal: number
            readonly triggerDeadZone: number
            readonly triggerInputMultiplier: number
            readonly useHotas: number
            readonly worldSelectLevel: number
            readonly yawSensitivity: number
            readonly yawValue: number
          }
          readonly particles: readonly (
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly never[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly (
                    | { readonly max: number; readonly min: number; readonly time: number }
                    | { readonly max: number; readonly min: number; readonly time: number }
                  )[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly {
                    readonly max: number
                    readonly min: number
                    readonly time: number
                  }[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly (
                    | { readonly max: number; readonly min: number; readonly time: number }
                    | { readonly max: number; readonly min: number; readonly time: number }
                  )[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly never[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly never[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly {
                    readonly max: number
                    readonly min: number
                    readonly time: number
                  }[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly {
                    readonly max: number
                    readonly min: number
                    readonly time: number
                  }[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly (
                    | { readonly max: number; readonly min: number; readonly time: number }
                    | { readonly max: number; readonly min: number; readonly time: number }
                  )[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly (
                    | { readonly max: number; readonly min: number; readonly time: number }
                    | { readonly max: number; readonly min: number; readonly time: number }
                  )[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly never[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly never[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly never[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly never[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly never[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly never[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
            | {
                readonly active: boolean
                readonly ancestors: readonly (
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                  | {
                      readonly active: boolean
                      readonly name: string
                      readonly position: readonly number[]
                      readonly rotation: readonly number[]
                      readonly scale: readonly number[]
                    }
                )[]
                readonly clampVelocity: {
                  readonly dampen: number
                  readonly enabled: boolean
                  readonly magnitude: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly separateAxis: boolean
                }
                readonly colourOverLifetime: {
                  readonly enabled: boolean
                  readonly gradient: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                }
                readonly emission: {
                  readonly bursts: readonly never[]
                  readonly enabled: boolean
                  readonly rate: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly type: number
                }
                readonly emits: boolean
                readonly fileId: string
                readonly force: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly randomizePerFrame: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly initial: {
                  readonly colour: {
                    readonly max: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly min: {
                      readonly alphas: readonly (
                        | { readonly alpha: number; readonly time: number }
                        | { readonly alpha: number; readonly time: number }
                      )[]
                      readonly colours: readonly (
                        | { readonly color: readonly number[]; readonly time: number }
                        | { readonly color: readonly number[]; readonly time: number }
                      )[]
                    }
                    readonly mode: number
                  }
                  readonly enabled: boolean
                  readonly gravityModifier: number
                  readonly lifetime: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly maxParticles: number
                  readonly rotationDeg: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly size: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly speed: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
                readonly lengthSeconds: number
                readonly looping: boolean
                readonly name: string
                readonly playOnAwake: boolean
                readonly position: readonly number[]
                readonly prewarm: boolean
                readonly randomSeed: number
                readonly renderer: {
                  readonly cameraVelocityScale: number
                  readonly lengthScale: number
                  readonly maxParticleSize: number
                  readonly mode: string
                  readonly sortMode: number
                  readonly sortingOrder: number
                  readonly velocityScale: number
                }
                readonly rotation: readonly number[]
                readonly rotationOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly scale: readonly number[]
                readonly scalingMode: number
                readonly selfActive: boolean
                readonly shape: {
                  readonly angleDeg: number
                  readonly box: readonly number[]
                  readonly enabled: boolean
                  readonly length: number
                  readonly radius: number
                  readonly randomDirection: boolean
                  readonly type: string
                }
                readonly simulationSpace: string
                readonly simulationSpeed: number
                readonly sizeBySpeed: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                  readonly range: readonly number[]
                }
                readonly sizeOverLifetime: {
                  readonly curve: {
                    readonly max: number
                    readonly maxCurve: readonly (
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                      | {
                          readonly inSlope: number
                          readonly outSlope: number
                          readonly time: number
                          readonly value: number
                        }
                    )[]
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly enabled: boolean
                }
                readonly startDelay: {
                  readonly max: number
                  readonly maxCurve: null
                  readonly min: number
                  readonly minCurve: null
                  readonly mode: number
                  readonly scalar: number
                }
                readonly velocityOverLifetime: {
                  readonly enabled: boolean
                  readonly inWorldSpace: boolean
                  readonly x: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly y: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                  readonly z: {
                    readonly max: number
                    readonly maxCurve: null
                    readonly min: number
                    readonly minCurve: null
                    readonly mode: number
                    readonly scalar: number
                  }
                }
              }
          )[]
          readonly prefab: string
          readonly prefabSelfModificationResidue: readonly (
            | { readonly propertyPath: string; readonly value: number }
            | { readonly propertyPath: string; readonly value: number }
            | { readonly propertyPath: string; readonly value: number }
            | { readonly propertyPath: string; readonly value: number }
            | { readonly propertyPath: string; readonly value: number }
            | { readonly propertyPath: string; readonly value: number }
          )[]
          readonly rigidbody: {
            readonly angularDrag: number
            readonly collisionDetection: number
            readonly collisionDetectionName: string
            readonly constraints: number
            readonly drag: number
            readonly interpolate: number
            readonly interpolateName: string
            readonly isKinematic: boolean
            readonly mass: number
            readonly useGravity: boolean
          }
          readonly ship: {
            readonly ForwardSpeed: number
            readonly Reboot: number
            readonly _cacheRigidbody: { readonly ref: null }
            readonly acceleration: number
            readonly airbrakeSpeed: number
            readonly boostEffects: {
              readonly ref: {
                readonly fileID: string
                readonly kind: string
                readonly name: string
              }
            }
            readonly boostEffects_stage2: {
              readonly ref: {
                readonly fileID: string
                readonly kind: string
                readonly name: string
              }
            }
            readonly boostEffects_stage3: {
              readonly ref: {
                readonly fileID: string
                readonly kind: string
                readonly name: string
              }
            }
            readonly boostMultiplier: number
            readonly boostValue: number
            readonly centerOfGravity: {
              readonly ref: {
                readonly fileID: string
                readonly kind: string
                readonly name: string
              }
            }
            readonly componentEnabled: boolean
            readonly currentMaxSpeed: number
            readonly dbg_vel: { readonly x: number; readonly y: number; readonly z: number }
            readonly driftMultiplier: number
            readonly driftVel: { readonly x: number; readonly y: number; readonly z: number }
            readonly endOnCollide: number
            readonly energySystem: {
              readonly ref: {
                readonly fileID: string
                readonly kind: string
                readonly name: string
              }
            }
            readonly enginePower: number
            readonly flashColor: {
              readonly a: number
              readonly b: number
              readonly g: number
              readonly r: number
            }
            readonly flashOnCollide: number
            readonly flightEffects: {
              readonly ref: {
                readonly fileID: string
                readonly kind: string
                readonly name: string
              }
            }
            readonly fwdSpeed: number
            readonly label_speed: { readonly ref: null }
            readonly liftMultiplier: number
            readonly limitRoll: number
            readonly localVel: { readonly x: number; readonly y: number; readonly z: number }
            readonly maxSpeed: number
            readonly meshFader: { readonly ref: null }
            readonly minBoostEffect_stage2_speed: number
            readonly minBoostEffect_stage3_speed: number
            readonly minBoostEffectsSpeed: number
            readonly minEffectsSpeed: number
            readonly orbEffects: {
              readonly ref: {
                readonly fileID: string
                readonly kind: string
                readonly name: string
              }
            }
            readonly originalAirbrakeSpeed: number
            readonly originalMaxSpeed: number
            readonly panel_missionUI: { readonly ref: null }
            readonly pitchRate: number
            readonly rebooting: number
            readonly rollCompensationSpeed: number
            readonly rollLimit: number
            readonly rollRate: number
            readonly shipHUD: {
              readonly ref: {
                readonly fileID: string
                readonly kind: string
                readonly name: string
              }
            }
            readonly shipInput: {
              readonly ref: {
                readonly fileID: string
                readonly kind: string
                readonly name: string
              }
            }
            readonly showMissionUI: number
            readonly targetSpeed: number
            readonly thrustDirection: { readonly x: number; readonly y: number; readonly z: number }
            readonly useRollCompensation: number
            readonly vertSpeed: number
            readonly yawRate: number
          }
          readonly shipCollisionColliders: readonly (
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: { readonly height: number; readonly radius: number }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly direction: number
                  readonly directionAxis: string
                  readonly height: number
                  readonly kind: string
                  readonly radius: number
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: { readonly height: number; readonly radius: number }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly direction: number
                  readonly directionAxis: string
                  readonly height: number
                  readonly kind: string
                  readonly radius: number
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
            | {
                readonly centerInShipRootSpace: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly colliderFileId: string
                readonly composedEulerZXYDeg: {
                  readonly x: number
                  readonly y: number
                  readonly z: number
                }
                readonly composedFromShipRoot: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly effective: {
                  readonly halfExtents: {
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                }
                readonly enabled: boolean
                readonly gameObjectFileId: string
                readonly isTrigger: boolean
                readonly layer: number
                readonly line: number
                readonly localTransform: {
                  readonly position: { readonly x: number; readonly y: number; readonly z: number }
                  readonly rotation: {
                    readonly w: number
                    readonly x: number
                    readonly y: number
                    readonly z: number
                  }
                  readonly scale: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly name: string
                readonly parentChain: readonly string[]
                readonly parentPath: string
                readonly role: string
                readonly shape: {
                  readonly center: { readonly x: number; readonly y: number; readonly z: number }
                  readonly kind: string
                  readonly size: { readonly x: number; readonly y: number; readonly z: number }
                }
                readonly tag: string
              }
          )[]
          readonly speedChain: { readonly speedIncreaseAmt: number }
        }
      | undefined,
  ) => Promise<void>
  readonly capabilities: Capabilities
  readonly chosenGhost: (mission: string, variant: string) => ChosenGhost
  readonly cloudShadow: CloudShadow
  readonly cockpitNow: () => EditionCockpit
  readonly cockpitSelfShadow: CockpitSelfShadow
  readonly craftSplashes: Map<string, CraftSplashState>
  readonly editionState: EditionState
  readonly editionsLoaded: Map<'classic' | 'anniversary', Edition>
  readonly farShadow: FarShadow
  readonly flatFov: FlatFov
  readonly fog: UnityFog
  readonly handles: WorldHandles
  readonly hudPlacementNow: () => EditionHudPlacement
  readonly hudRaster: HudRaster
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  landRevealRise: number
  readonly level: Level
  readonly loading: LoadProgress
  readonly lodFadeSpec: () => LodFadeSpec | null
  readonly mission: MissionState
  readonly perfPlate: PerfPlate | null
  readonly placementTuning: PlacementTuning
  readonly refreshBakedLight: () => BakedLightReport
  readonly render: Renderer
  readonly resetThirdPerson: () => void
  readonly results: ReturnType<typeof createResults>
  readonly ringBurstRandomNow: () => number
  readonly roomActive: () => boolean
  readonly roomBotHost: () => boolean
  readonly roomBots: () => { starts: RacerStart[]; names: string[] }
  readonly roomCore: ReturnType<typeof createRoomCore>
  readonly roomOccupiedStarts: () => RacerStart[]
  readonly roomWorldBuilt: (_variant: string) => void
  readonly sceneTint: SceneTint
  readonly seaReflection: SeaReflection
  readonly setChunkBatch: (on: boolean) => unknown
  readonly shakeLookdev: ShakeLookdev
  readonly skyVisibility: SkyVisibility
  readonly speedLineLiftNow: () => number
  readonly speedLinesNow: () => ParticleOverride | null
  readonly speedRampNow: () => SpeedLineRamp | null
  readonly sunHalo: SunHalo
  readonly sunShadows: SunShadows
  readonly surfaceGloss: SurfaceGloss
  readonly syncRaceMap: (hud: THREE.Object3D<THREE.Object3DEventMap>) => void
  readonly vignette: Vignette
  readonly warp: IllustrativeLighting
}

export const createWorldBuild = (ctx: WorldBuildCtx) => {
  const {
    HANGAR_SEED,
    _splashEye,
    appSettings,
    applyAtmosphere,
    applyCourseClearing,
    applyGroundAtmosphere,
    applyPropAtmosphere,
    applyPropVisibility,
    applyWireframe,
    atmosphere,
    bakedLight,
    bloom,
    capabilities,
    chosenGhost,
    cloudShadow,
    cockpitNow,
    cockpitSelfShadow,
    craftSplashes,
    editionState,
    editionsLoaded,
    farShadow,
    flatFov,
    handles,
    hudPlacementNow,
    loading,
    lodFadeSpec,
    mission,
    perfPlate,
    placementTuning,
    refreshBakedLight,
    render,
    resetThirdPerson,
    results,
    ringBurstRandomNow,
    roomActive,
    roomBotHost,
    roomBots,
    roomCore,
    roomOccupiedStarts,
    roomWorldBuilt,
    sceneTint,
    seaReflection,
    shakeLookdev,
    skyVisibility,
    speedLineLiftNow,
    speedLinesNow,
    speedRampNow,
    sunHalo,
    sunShadows,
    surfaceGloss,
    syncRaceMap,
    vignette,
    warp,
  } = ctx
  const buildWorld = async () => {
    appSettings.worldEdition = editionState.current.id // DEV-451: what this world is read under
    const worldOffset = ctx.level.worldOffset as [number, number, number]
    // WHICH terrains, from the LEVEL — not from two string literals that only
    // ever named Simonet. See `environmentTerrains` for what that cost: nine of
    // the thirteen shipped missions rendered the wrong world without erroring.
    //
    // An environment whose maps are not published now fails LOUDLY, out of
    // `loadTerrain`, naming the key and saying to add it to `MAP_PATHS` and
    // `required-assets.json` together. That is the point of the change: desert
    // and kauai still cannot load, but they now SAY so instead of quietly
    // drawing Simonet with another mission's spawn inside a hillside.
    const envTerrain = environmentTerrains(ctx.level.environment)
    // ── DEV-489: a player's ground in place of the island's own ──────────
    //
    // The land is generated from the ground the level carries, wearing its
    // island's colours, grain and props; the sea, the sky and every other
    // environment fact stay the sky's. Null on every shipped mission.
    const ground = customGroundOf(ctx.level)
    const landKey = ground ? donorLand(ground.island).key : envTerrain.land
    // ── DEV-500: the sea a level draws, and how far it is lifted ─────────
    //
    // A shipped level: its own ocean at lift 0, or none on desert and alpine,
    // as before (`course-water.test.ts` sweeps them). A player course with a
    // water level moves the plate there, or borrows one where the base has none.
    const sea = oceanFor(ctx.level)
    // ── the readout (DEV-107) ────────────────────────────────────────────
    //
    // Every channel is opened HERE, before any of them reports, because the
    // aggregate is a mean and a channel opened late would drop it. There are
    // two whatever the environment: alpine and desert have no ocean, and a
    // null channel keeps the denominator honest rather than making the bar run
    // at half speed on two of the four worlds.
    //
    // It was THREE until DEV-281, because the title valley loaded here too —
    // and the third channel is the whole of why this bar used to spend a third
    // of itself on a world the player was not looking at, under a word naming
    // a world they had not chosen. `buildTitleWorld` opens its own.
    loading.restart(environmentDisplayName(ctx.level.environment))
    const landProgress = loading.channel()
    const oceanProgress = loading.channel()
    if (sea === null) oceanProgress(1)
    // DEV-355: every long stretch below stops when a frame's budget is spent
    // and hands the thread back, so the frames keep coming while a world
    // builds. `boot/slice.ts` has the measurement and the mechanism.
    const slicer = createSlicer()
    const [terrain, ocean, rings, turnIndicators, particleFx, loadedFlight, ghosts] =
      await Promise.all([
        loadTerrain(landKey, {
          worldOffset,
          ground, // DEV-489
          fixDiagonal: editionState.current.terrain.diagonalFix.enabled, // DEV-831
          tintIsSrgb: TINT_IS_SRGB,
          // `?terrainLit=`, DEV-182. Undefined on every ordinary load.
          lit: TERRAIN_LIT,
          onProgress: landProgress,
          slice: slicer.checkpoint,
          // The spawn, so chunks start at the LOD they will be wanted at rather
          // than all at 0 and then coarsening visibly on the first frames.
          camera: [ctx.level.spawn.pos[0] as number, ctx.level.spawn.pos[2] as number],
          // ── Anniversary systems: T1, the detail ring (DEV-085) ──────────
          //
          // LOD −1 around the ship, on the LAND only. A getter, read once per
          // `updateLod`, so a preset flip or a quality change from the pause
          // menu takes effect on the next frame rather than at the next mission
          // load. `game/terrain/detail-ring.ts` is where every exclusion lives —
          // Classic, the ocean, and quality `low`.
          detailRing: () =>
            detailRingFor(editionState.current.terrain.detailRing, {
              isOcean: false,
              quality: editionState.settings.quality,
            }),
          // ── Anniversary systems: V7, the illustrative warp (DEV-092) ────
          //
          // Handed to all three `loadTerrain` calls and applied by NONE of the
          // callers: the loader tests `entry.material.shader` and skips a
          // VacuumShaders surface, so the ocean is excluded by the same fact
          // that decides its roughness rather than by a second rule here.
          applyIllustrative: (m) => warp.applyTo(m),
          applySurfaceGloss: (m) => surfaceGloss.applyTo(m),
          // DEV-232, and LAND only — by being passed to this `loadTerrain` call
          // and not to the ocean's, because the sea has no bakeable normal at
          // all: `render/water.ts` computes it per fragment from the wave, so
          // "the face's normal" does not exist at bake time.
          bakeGeometry: (g) => {
            bakedLight.offer(g)
          },
          lodFade: lodFadeSpec,
        }),
        // The ocean is a SECOND faceted terrain: 32 km of water scaled 8x to 262
        // km, so it runs past the horizon in every direction. Only the chunks
        // near the island are built — see `visibleRadius`.
        // Not every environment HAS water: alpine and desert are a single land
        // terrain and the sheet says so. `null`, and nothing draws an ocean.
        sea === null
          ? null
          : loadTerrain(sea.key, {
              worldOffset,
              lift: sea.lift, // DEV-500
              fixDiagonal: editionState.current.terrain.diagonalFix.enabled, // DEV-831
              tintIsSrgb: TINT_IS_SRGB,
              onProgress: oceanProgress,
              slice: slicer.checkpoint,
              // The sea's SPECULAR needs the mission's sun, and its reflection the
              // sky — see `render/water.ts` for why the faceting is the specular.
              skySh: ctx.level.lighting.sky?.available ? ctx.level.lighting.sky.sh : null,
              sun: ctx.level.lighting.sun
                ? {
                    direction: ctx.level.lighting.sun.direction as number[],
                    colorLinear: ctx.level.lighting.sun.colorLinear as number[],
                    intensity: ctx.level.lighting.sun.intensity,
                  }
                : null,
              swellWavelength: SWELL,
              // The preset's ladder, or one number if `?ocean=` pinned it.
              // Read ONCE here, like `?swell=`: this is the geometry of every
              // chunk that gets built, and a preset flip cannot re-mesh a sea
              // that is already drawn. DEV-183.
              meshSubdivision: OCEAN_PIN ?? editionState.current.terrain.ocean.subdivisionByLod,
              // DEV-339: the preset's rings, `?oceanRings=1|0` over it.
              rings: oceanRingsSpecFor(editionState.current.terrain.oceanRings, OCEAN_RINGS_PIN),
              // Derived from the LAND terrain's own position rather than typed: a
              // literal here is rule 3's smell, and this one silently belonged to
              // Simonet.
              centre: envTerrain.oceanCentre,
              visibleRadius: CAMERA_FAR,
              camera: [ctx.level.spawn.pos[0] as number, ctx.level.spawn.pos[2] as number],
              // Passed, and the loader will NOT use it: see the land call above.
              applyIllustrative: (m) => warp.applyTo(m),
              // The sea's LOD swaps pop too — 8 km chunks, six bands — so the
              // fade is for both terrains. The gloss is not: same guard.
              lodFade: lodFadeSpec,
            }),
        loadRings(ctx.level),
        loadTurnIndicators(ctx.level),
        // The S2 re-authoring goes in at CONSTRUCTION, so an Anniversary boot
        // never draws a frame of 2016's hairlines on its way to the wide ones.
        loadParticleFx(ctx.level, {
          speedLines: speedLinesNow(),
          speedLineLift: speedLineLiftNow(),
          speedRamp: speedRampNow(),
          ringBurstRandomDirection: ringBurstRandomNow(),
          // DEV-867: no gates built where the mode has none (Free Flight).
          rings: isLive(ctx.RUNNING_MODE, 'ring'),
          // DEV-428 / DEV-429: built only when on at load, like the colliders
          // the strike belongs to — a world without them compiles no paper
          // program. The spray's sea arrives with the ocean (`setSea` below).
          // DEV-464: the rule is `propBurstAtLoad`'s, so a test can ask it of
          // the composed Classic-look preset.
          propBurst: propBurstAtLoad(editionState.current),
          waterSpray: editionState.current.fx.waterSpray.enabled
            ? editionState.current.fx.waterSpray
            : null,
          // DEV-613: built only when on at load, like the spray beside it.
          splash: editionState.current.fx.splash.enabled ? editionState.current.fx.splash : null,
        }),
        // DEV-256. The raster mode goes in at CONSTRUCTION, because
        // `getContext` options are honoured only on a canvas's first context —
        // so unlike the cadence and the upload mode this cannot be left to the
        // frame loop to assert onto a panel that is already built. The loop
        // still re-asserts it, which is what carries a LIVE flip across the
        // next course swap; this is what makes the pin land on the first frame.
        loadFlight(
          ctx.level,
          hudPlacementNow(),
          { raster: ctx.hudRaster },
          // DEV-380: the aircraft variant, resolved now, against the live edition.
          flightVariantFor(ctx.level.vehicle, editionState.current),
        ),
        // ONLY when they are the opponents. They were loaded unconditionally
        // and disposed unused on the default path — and because `loadGhosts`
        // throws on a clip that was never staged, that made eight of the
        // thirteen missions fail to load over opponents they never show.
        OPPONENTS === 'ghosts' ? loadGhosts(ctx.level, worldOffset) : noGhosts(),
      ])
    // The terrains are in, and the rest of this function is rings, indicators,
    // props, dressing, the ship and the sky. The WORD changes here rather than
    // the number carrying on, because a bar fed by `onProgress` alone reaches
    // 100% and then sits there — a new lie replacing the old one.
    loading.assembling()

    // The fog is per-material, so every chunk has to be given it before its
    // first frame — through `LoadedTerrain.materials`, which is the ONE
    // material a terrain's chunks are all cut from, and NOT by walking
    // `group.children`.
    //
    // That walk was right while a terrain had exactly one material and it is
    // the bug now (DEV-183): an ocean chunk may carry a per-LOD water BAND,
    // which is a clone that delegates its whole `onBeforeCompile` chain back to
    // the base. Patch the clone as well and the fog's prologue is spliced
    // twice — `'vUnityFogWorldPos' : redefinition`, and the sea does not
    // compile. `unity-fog` guards per material and cannot see it.
    //
    // The land is the GROUND the far-field term describes; the sea is not
    // (DEV-133), so the two take different doors.
    for (const m of terrain.materials) applyGroundAtmosphere(m)
    if (ocean) for (const m of ocean.materials) applyAtmosphere(m)
    // ── The measurement gates, and they go LAST on purpose ────────────────
    //
    // `render/fragment-gates.ts` puts three `#define`-gated cuts into the
    // fragment stack of the two terrains that ARE the frame — the island (51 %)
    // and the sea (20 %). No define is set here, so the preprocessor removes
    // every gate before the driver sees it and the compiled program is the one
    // this build has always drawn; what they buy is the ability to flip one
    // BETWEEN TWO READINGS of a live page, which is the only A/B this laptop
    // can do for a fill-dominated cost (perf-protocol §3a-ter).
    //
    // After the atmosphere, not before: an `onBeforeCompile` chain runs in
    // install order, `far-shadow.ts` REPLACES `#include <lights_fragment_begin>`
    // with a rewritten expansion, and whichever of the two runs first takes that
    // include away from the other. The gates cope with either shape and
    // far-shadow does not, so the gates go second.
    for (const m of terrain.materials) installFragmentGates(m)
    if (ocean) for (const m of ocean.materials) installFragmentGates(m)
    // DEV-232, and on the LAND's base material only. `render/lod-fade.ts` cuts
    // pooled clones from that base and `acquire()` re-syncs each one against
    // the base's `variantKey`, which spreads the base's defines — so a define
    // set here reaches every clone, and one set on a clone would not survive
    // its next trip through the pool.
    for (const m of terrain.materials) bakedLight.applyTo(m)
    // REGISTERED HERE, where `terrain` is in scope, rather than fetched from
    // `liveTerrain` — which is assigned 900 lines below this and was the whole
    // of why the first A/B measured nothing. The LAND's group only: the sea has
    // no bakeable normal, and the module's `offered` set keeps the scatter and
    // the dressing out even though `boot/app.ts` parents both under this group.
    bakedLight.addRoot(terrain.group)
    // The attach above ran before this terrain existed, so the define has never
    // been pushed at this material. The chunks already carry the bake — they
    // came through `bakeGeometry` as they were built — and this is the other
    // half. A no-op in both shipped presets.
    refreshBakedLight()
    // ── Anniversary systems: the shoreline ─────────────────────────────────
    //
    // V6 / DEV-087, and it has to be here because it needs BOTH terrains: the
    // sea is told where the ISLAND is and handed the island's own height map, so
    // a water fragment can work out how much water is under it. The island's
    // placement is READ off the group it was hung on rather than recomputed —
    // `worldOffset + local + envRoot` has been wrong twice (DEV-042) and a
    // second copy of it here would be a third chance.
    //
    // An environment with no ocean (alpine, desert) never reaches this, and one
    // whose water loads without a land map leaves the coast inert by its own
    // rule rather than by a check here. See `render/coast.ts`.
    if (ocean?.water) {
      ocean.water.setCoastSource(
        coastMapFrom({
          position: terrain.group.position,
          scale: terrain.group.scale,
          terrainSize: terrain.params.terrainSize,
          terrainHeight: terrain.params.terrainHeight,
          mapWidth: terrain.heightMap.width,
          mapHeight: terrain.heightMap.height,
        }),
        coastHeightTexture(terrain.heightMap),
      )
      attachEditionCoast(ocean.water, editionState)
    }

    // Wireframe, at whatever stage the page is in: `?wire=` on the first world,
    // and the last O press on every world after it. The stage and the O/L
    // handler live beside `liveTerrain`, once per page — see `applyWireframe`.
    applyWireframe({ terrain, ocean })

    render.scene.add(terrain.group)
    // Named so a spec can find it. `completion.spec.ts` asserts the island is
    // not drawn while the menu is up — which is now true because the menu is a
    // different scene, rather than because something remembered to hide it.
    terrain.group.name = 'world-terrain'

    // ── the prop layer ──────────────────────────────────────────────────
    //
    // Parented to the TERRAIN group, not the scene, so it inherits that
    // group's `worldOffset + localPos + envRoot` composition for free. The
    // alternative is a second copy of the arithmetic DEV-042 already cost a
    // session, and two copies drift the moment one learns about a parent the
    // other does not.
    //
    // Failure is non-fatal ON PURPOSE. The props live in `public/assets/props/`,
    // which is gitignored and hydrated by `pnpm assets:pull`, so a clone that
    // has not pulled them must still be able to fly. It says so once, loudly,
    // instead of failing the boot.
    // ── DEV-287: the authored no-prop volumes for THIS mission ──────────
    //
    // Resolved once and handed to both the scatter and the dressing, so the
    // trees and the rocks leave alone the same ground off the same list — the
    // DEV-103 decision, applied to the authored half.
    //
    // **Every anchor point below is SIM world space**, which is the one thing
    // `game/props/no-prop-volumes.ts` will not convert for you. `Gate.centre`
    // already is; `level.spawn.pos` is THREE, so its z flips here, at the one
    // place that knows which frame it is holding. That single conversion is
    // checked against DEV-100's own receipt in `no-prop-volumes.test.ts`.
    // DEV-489: a custom island's origin is its OWN (centred on the donor's
    // land, `customTerrainLocal`), which the height field already carries in
    // SIM space; the sheet's origin for the key is the donor's corner. And the
    // environment's authored volumes are the DONOR's ground's, so a custom
    // island reads none (its line is cleared by the course's own clearing).
    const landOrigin: readonly number[] = terrain.custom
      ? [terrain.heightField.originX, terrain.heightField.originY, terrain.heightField.originZ]
      : terrainOriginSim(terrain.key, ctx.level.worldOffset).position
    // DEV-502: the whole list, in ONE pure function (`game/props/course-clearing.ts`),
    // split in two. `fixed` is subtracted at load, and on every shipped
    // mission it is the list this block built before, in its order: the
    // authored volumes (DEV-287), every live JumpSeat pad (DEV-345), a player
    // course's start pad (DEV-475, empty elsewhere) and, on a custom ground
    // under a SHIPPED mission (the preview door), DEV-489's chords. `course`
    // is a PLAYER course's own — its pad, the volumes resolved against its
    // pad and rings, and the capsule chain along its FLOWN line — and it is
    // MASKED on the loaded forest below, so the editor can move it.
    const clearingInput = {
      level: ctx.level,
      volumes: terrain.custom ? null : await loadNoPropVolumes(),
      origin: landOrigin,
      gates: mission.course.gates.map((g) => ({ x: g.centre.x, z: g.centre.z })),
      spawnRadius: (await loadEnvironmentProps(ctx.level.environment))?.spawnClearing?.radius,
      customRadius: terrain.custom
        ? (await loadEnvironmentProps(terrain.custom.ground.island))?.spawnClearing?.radius
        : null,
      custom: Boolean(terrain.custom),
    }
    const clearings = worldClearings(clearingInput)
    const noPropVolumes = clearings.resolved
    const clearedGround = clearings.fixed
    // Held for the editor's live re-mask (`deskHost.clearLine`): the same
    // input with a draft's level in it is the same function's answer.
    handles.worldClearingInput = clearingInput

    let liveProps: Awaited<ReturnType<typeof loadProps>> = null
    // ── DEV-489: a custom island's forest, scattered over it now ──────────
    //
    // The island's own prop sets, re-run by `scatterProps` over the player's
    // ground at a density measured off the island's own bake, its landmarks
    // dropped (`customEnvironmentProps`). Everything after is the one prop
    // path every shipped island takes. Null on every shipped mission, which
    // hands `loadProps` its environment id exactly as before.
    let propsSource: Parameters<typeof loadProps>[0] = ctx.level.environment
    if (PROPS_ON && terrain.custom) {
      const donorEnv = await loadEnvironmentProps(terrain.custom.ground.island)
      if (donorEnv) {
        const t0 = performance.now()
        const c = terrain.custom
        propsSource = customEnvironmentProps(donorEnv, c.grids.donor, c.ground, c.grids.ground).env
        customGroundPropsMs = performance.now() - t0
      }
    }
    if (PROPS_ON) {
      try {
        liveProps = await loadProps(propsSource, {
          terrain: {
            terrainSize: terrain.params.terrainSize,
            terrainHeight: terrain.params.terrainHeight,
            chunkSize: terrain.params.chunkSize,
          },
          heightMap: terrain.heightMap,
          // DEV-102. Classic draws the two passes 2016 baked; Anniversary also
          // draws the three it authored and never ran. Read HERE, at world
          // build, so an EDITION flip mid-run does not restack the trees under
          // you — the next course swap rebuilds the world and picks it up.
          unbakedPasses: editionState.current.props.unbakedPasses.enabled,
          // DEV-134, same moment and for the same reason: the per-kind scale
          // and the ground snap are read at WORLD BUILD. Classic's map is
          // empty and its snap is off, so both are no-ops there by content.
          scale: editionState.current.props.scale,
          groundSnap: editionState.current.props.groundSnap.enabled
            ? { params: terrain.params, sink: editionState.current.props.groundSnap.sink }
            : null,
          // DEV-356: bare ground where the rendered facet is too steep to stand
          // a trunk on. Same moment and same reason — it takes the collider
          // with the prop, so a mid-run flip would have to rebuild the forest.
          // The TITLE valley does not pass it: that frame is composed, and
          // taking its trees is Matt's call, not this row's.
          maxSlope: editionState.current.props.maxSlope.enabled
            ? { params: terrain.params, sin: editionState.current.props.maxSlope.sin }
            : null,
          // DEV-862: no tree stands in the sea. The bake is height-blind, so a
          // palm on the seabed is a palm on the seabed; the floor is the
          // ocean's rest surface plus its high-water mark, both looks, and null
          // where there is no sea (alpine, desert).
          seaLine: ocean
            ? seaLineFor(terrain.heightField, ocean.heightField, ocean.highWater)
            : null,
          // DEV-135: the hand-placed spires 2016 drew, on both presets. Their
          // frame is the LevelArt root; the terrain's own local position is
          // what takes them into the terrain's mesh frame this group draws in.
          landmarks: { terrainLocalPosition: terrainLocalPosition(terrain.key) },
          // DEV-218 / DEV-219: scenery THIS MISSION places, which the
          // environment cannot carry because it is per-mission. Same shape and
          // same frame as a landmark, so it concatenates rather than taking a
          // second path — ten of the thirteen pass an empty array.
          missionProps: ctx.level.props ?? null,
          noPropVolumes: clearedGround,
          // DEV-338: the coarser meshes. The RUNGS at world build, because
          // they decide which geometries get made; `enabled` as a getter, so
          // `?feature=props.meshLod:off` or a live flip walks the forest back
          // to full detail on the next scan. Classic's rungs are empty and
          // nothing is built.
          meshLod: {
            rungs: editionState.current.props.meshLod.rungs,
            enabled: () => editionState.current.props.meshLod.enabled,
          },
          ...(PROP_CELLS !== undefined ? { cellsPerAxis: PROP_CELLS } : {}),
          ...(PROP_LOD !== undefined ? { lodDistance: PROP_LOD } : {}),
        })
        if (liveProps) {
          terrain.group.add(liveProps.group)
          // Held so a mission swap can free them: they are parented under the
          // terrain, and `LoadedTerrain.dispose` deliberately does not reach
          // into children it did not make.
          handles.livePropsDispose = () => liveProps?.dispose()
          handles.livePropsLive = liveProps
          // DEV-303: and at BUILD too, not only on the next notify. A world
          // attached while the row is already off would otherwise draw the
          // forest until something else moved the preset.
          applyPropVisibility()
          for (const child of liveProps.group.children) {
            for (const inst of child.children) {
              const m = (inst as THREE.Mesh).material as THREE.Material | undefined
              if (m) applyPropAtmosphere(m)
            }
          }
          console.info(
            `props: ${liveProps.instanceCount} instances in ${liveProps.drawCalls} draw calls ` +
              `(${ctx.level.environment}, ${editionState.current.id})` +
              `; ${liveProps.landmarkCount} landmarks (DEV-135)` +
              (editionState.current.props.groundSnap.enabled
                ? `; ground snap moved ${liveProps.floatingFixed} floating props down (DEV-134)`
                : '') +
              `; ${describeVolumes(noPropVolumes)} and ` +
              `${clearings.padCount} pad clearings (DEV-345) took out ` +
              `${liveProps.clearedByVolumes} (DEV-287)`,
          )
          // ── DEV-136: the props are solid, and they break ───────────────
          //
          // GAMEPLAY, read at world build like the two flags above. The
          // colliders sit in SIM space — the height field carries the
          // terrain's origin there — and the fracture group hangs under the
          // terrain group, the frame the instances are drawn in.
          const pc = editionState.current.gameplay.propCollision
          if (pc.enabled) {
            const hf = terrain.heightField
            handles.livePropColliders = buildPropColliders(
              liveProps.colliderInputs,
              { x: hf.originX, y: hf.originY, z: hf.originZ },
              pc,
            )
            handles.livePropCollision = createPropCollision()
            // ── DEV-148: the pieces land ─────────────────────────────────
            //
            // The fracture group is a child of the terrain group, so a piece's
            // (x, y, z) is the terrain's MESH frame in three space — and
            // `instanceMatrixOf` put those instances there with `(x, y, -z)`,
            // so mesh z is the NEGATION of this frame's z. One flip, here, at
            // the only place that knows both frames.
            //
            // The surface is the RENDERED one — the jittered vertex grid the
            // chunks were built from, `LoadedTerrain.surfaceGrid`, at LOD 0 —
            // and not `heightField`. They differ by up to `randomOffset` per
            // vertex (1.3 m on Simonet), and a piece resting on the invisible
            // one floats or sinks by that much. DEV-134 learned this for the
            // trees; this is the same lesson for what is left of them.
            handles.liveFracture = createPropFracture(
              pc.fractureSeconds,
              groundUnderGroupPoint(terrain.surfaceGrid, terrain.heightMap, terrain.params),
            )
            terrain.group.add(handles.liveFracture.group)
            // The direct list is named because `count` and `cells.size` do NOT
            // add up without it — an oversized collider is on one list or the
            // other, never both (DEV-187) — and because seeing it go from 16 to
            // 0 on desert is how you would notice the landmarks had stopped
            // being solid.
            console.info(
              `props: ${handles.livePropColliders.count} colliders in ${handles.livePropColliders.cells.size} cells` +
                ` + ${handles.livePropColliders.oversized.length} tested directly (DEV-136, DEV-187)`,
            )
          }
          // ── DEV-502: a player course's own clearing, MASKED ──────────────
          //
          // After the colliders, so the mask takes each hidden prop's collider
          // out with it. Empty, and nothing runs, on every other level.
          if (clearings.course.length > 0) {
            const r = applyCourseClearing(clearings.course, ctx.level.id)
            if (r) {
              console.info(
                `props: the course's clearing masked ${r.masked} of ${r.scatter} scatter props ` +
                  `(${r.clearings} capsules along the pad, the run-in and the line) in ` +
                  `${r.ms.toFixed(1)} ms (DEV-502)`,
              )
            }
          }
        } else {
          console.info(`props: no scatter data for '${ctx.level.environment}'`)
        }
      } catch (err) {
        console.warn(
          `props: not drawn — ${err instanceof Error ? err.message : String(err)}. ` +
            'Run `pnpm assets:pull`, or `node tools/assets/extract-props.mjs` with $FF2_LEGACY set.',
        )
      }
    }
    // ── Anniversary systems: V9, the familiar sizes (DEV-089) ───────────
    //
    // Boulders, rocks, shrubs and flocks, generated and placed by rule. Under
    // the SAME terrain group as the palms above, for the same reason — the
    // parent chain is composed, never re-derived (DEV-042). Classic builds
    // nothing and draws nothing; the group is simply invisible.
    //
    // Nothing is fetched: the height map, the colour map and the ocean are the
    // objects the terrain already holds, and the meshes are generated. That is
    // the whole point of a generated palette (ANNIVERSARY.md §1.5 item 6).
    //
    // DEV-103: it leaves alone the ground the palms were baked to leave alone,
    // and it reads the SAME list — the environment JSON's `spawnClearing`
    // receipt. `loadProps` above already imported that module and the glob is
    // cached, so this is a lookup and not a fetch. Null is an environment with
    // no JSON, which has no scatter and no receipt either.
    // DEV-489: on a custom island, the re-scattered environment, whose spawn
    // centres are dropped (they are the donor's spawns on the donor's ground),
    // and the island it wears.
    const spawnClearings =
      typeof propsSource !== 'string'
        ? spawnClearingsOf(propsSource)
        : terrain.custom
          ? [] // props off: still never the donor's spawns on this ground
          : spawnClearingsOf(await loadEnvironmentProps(ctx.level.environment))
    handles.liveDressing = loadDressing(editionState, {
      environmentId: terrain.custom ? terrain.custom.ground.island : ctx.level.environment,
      terrain: terrain.heightField,
      heightMap: terrain.heightMap,
      colorMap: terrain.colorMap,
      water: ocean?.heightField ?? null,
      routePoints: ctx.level.route ?? null,
      gates: mission.course.gates.map((g) => g.centre),
      spawnClearings,
      // DEV-502: and a player course's own, which the scatter MASKS: the
      // dressing collides with nothing and is not re-masked by the editor, so
      // it takes the list at load, as the custom island's chords always were.
      noPropVolumes: [...clearedGround, ...clearings.course],
      // DEV-288 (wishlist #20), and the SAME switch DEV-134 gives the scatter: props stand on the
      // surface you can see. Read at world build like the flags above, so an
      // edition flip mid-run does not move the rocks under you.
      //
      // Measured over 23,053 shipped placements, the dressing was 0.42-1.55 m
      // off the rendered mesh in the mean and up to 21.8 m at worst, with 40-87
      // % of every band further than 0.3 m. **Not the jitter** - rebuilding the
      // grid with `randomOffset: 0` moves the mean by 0.09-0.23 m and leaves
      // the rest, because the props are placed on a 4 m bilinear map and the
      // mesh is an 8 m triangulation of it. See the ledger row.
      groundSnap: editionState.current.props.groundSnap.enabled ? { params: terrain.params } : null,
      // BEFORE the variant patch, not after — `render/dressing.ts` says why the
      // order is load-bearing and takes it as a parameter so it cannot be lost.
      applyFog: (m) => applyPropAtmosphere(m),
      // V7 as well (DEV-092), so a boulder is lit by the same ramp as the
      // ground it is standing on. No flag of its own — `render/dressing.ts`
      // says why a knob that let them disagree is one nobody would want.
      applyIllustrative: (m) => warp.applyTo(m),
    })
    terrain.group.add(handles.liveDressing.group)
    if (handles.liveDressing.instanceCount > 0) {
      console.info(
        `dressing: ${handles.liveDressing.instanceCount} instances in ${handles.liveDressing.drawCalls} draw ` +
          `calls, ${handles.liveDressing.triangleCount} triangles, ${handles.liveDressing.flockCount} flocks, ` +
          `${spawnClearings.length} spawn clearings (${ctx.level.environment})` +
          (editionState.current.props.groundSnap.enabled
            ? `; ground snap brought ${handles.liveDressing.floatingFixed} down out of the air (DEV-288)`
            : ''),
      )
    }
    // ── The life pass: DEV-447, the boats ───────────────────────────────
    //
    // Moored and anchored boats on the sea, placed by rule over THIS course's
    // line and spawn and floated on the triangle the sea is drawn with. At the
    // scene root, because they ride the ocean plate and the plate is its own
    // root group. Built HERE, under the curtain, when the preset and the
    // comfort quality want them now — so the world's warm-up compiles their
    // program rather than the first frame they are in view. A run that starts
    // on Classic fetches nothing; the frame loop's `sync` builds once on a
    // later flip. Never a collider, never a score — no sim module can see one
    // (DEV-146's rule).
    //
    // DEV-449: and the dolphins, leaping from the same drawn sea; `ready`
    // waits for their mesh too, so the warm-up sees every kind. (DEV-448's
    // crowds on the shore were cut by DEV-463, and DEV-449's fish by DEV-545.)
    handles.liveLife = createLife(() => editionState.current.life, {
      levelId: ctx.level.id,
      routePoints: ctx.level.route ?? null,
      spawn: ctx.level.spawn.pos,
      gates: mission.course.gates.map((g) => g.centre),
      land: terrain,
      ocean: ocean ?? null,
      spawnClearings,
      // The scatter props' atmosphere, so a boat hazes as a palm does and asks
      // for the program the palms already compiled.
      applyFog: (m) => applyPropAtmosphere(m),
      // DEV-613: a dolphin leaving the water and landing in it, at the drawn
      // wave. The live field when it happens (the life pass is built before the
      // world's `liveFx` is set, and a leap after it reads the one in force).
      splash: (s) => {
        const spec = editionState.current.fx.splash
        if (!handles.liveFx || !spec.enabled) return
        handles.liveFx.splash(
          s,
          { x: s.vx, y: s.vy, z: s.vz },
          splashScale(spec, spec.dolphinBody * (s.entering ? 1 : spec.outScale), s.speed),
          readHeadPosition(render.renderer.xr, render.camera, _splashEye),
        )
      },
    })
    render.scene.add(handles.liveLife.group)
    handles.liveLife.sync(lifeWanted(editionState.current.life, editionState.settings.quality))
    await handles.liveLife.ready()
    if (ocean) {
      render.scene.add(ocean.group)
      ocean.group.name = 'world-ocean'
    }
    seaReflection.setSea(ocean ?? null) // DEV-583: before the warm, so the mirror's variants are in it
    // Free Flight is the mode that switches the rings OFF, and `hoverJet_kauai_beg`
    // is the mission that proves it matters: it authors all 21 and forces Free
    // Flight, so a port that draws them unconditionally ships a ring course
    // nothing scores. `forcedMode` finally has a consumer.
    if (isLive(ctx.RUNNING_MODE, 'ring')) render.scene.add(rings.object)
    // DEV-336: halos beside the studs, sharing their instance matrix. Only
    // with gates to hang them on; hidden until a headset presents.
    handles.liveStudHalos = null
    if (isLive(ctx.RUNNING_MODE, 'ring') && rings.count > 0) {
      const studs = rings.object.getObjectByName('ring-studs')
      if (studs instanceof THREE.InstancedMesh && studs.parent) {
        const glow = (studs.material as THREE.MeshStandardMaterial).emissive
        handles.liveStudHalos = createInstancedHalos(studs, glow)
        // DEV-422: BEFORE the frames. The frames now write depth, and a stud
        // sits inside its bar, so a halo tested after them would lose every
        // pixel the bar covers. Drawn first, it glows through the bar's 29 %.
        handles.liveStudHalos.object.renderOrder = GATE_FRAME_ORDER - 1
        studs.parent.add(handles.liveStudHalos.object)
      }
    }
    if (sunHalo.object.parent !== render.scene) render.scene.add(sunHalo.object)
    if (isLive(ctx.RUNNING_MODE, 'orb')) {
      handles.liveOrbArt = loadOrbs(ctx.level)
      render.scene.add(handles.liveOrbArt.object)
      // 2016's ball arrives when its GLB does; a failed fetch warns and flies
      // the stand-in (DEV-327). Not awaited: the orbs are dressing on a load
      // that has plenty else to wait for, and a swapped mission ignores it.
      void attachOrbArt(handles.liveOrbArt)
    }
    if (isLive(ctx.RUNNING_MODE, 'padZone')) {
      handles.livePadArt = loadPads(ctx.level)
      render.scene.add(handles.livePadArt.object)
    }

    // ── the environment's clouds ─────────────────────────────────────────
    //
    // Placements from 2016, geometry generated: the source meshes are a bought
    // pack and cannot ship (D26). Fogged like everything else — at 500 m to
    // 3 km they are exactly where the fog does its work, and an unfogged cloud
    // hangs in front of the sky instead of in it.
    //
    // ── Anniversary systems: V5, clouds that are clouds (DEV-090) ──────────
    //
    // The preset and the MISSION's sun go in together, and the fog goes on
    // AFTER: a chained `onBeforeCompile` runs `previous` first, so the patch
    // registered first lands earliest in the shader, which gives
    // cloud look -> haze -> fog and leaves the fog with the last word on the
    // colour. `game/clouds.ts`'s `applyCloudLook` header has the whole argument;
    // do not move the `fog.applyTo` loop above `loadClouds`.
    if (ctx.level.clouds?.length) {
      handles.liveClouds = loadClouds(ctx.level.clouds, {
        edition: editionState,
        sun: ctx.level.lighting.sun,
      })
      render.scene.add(handles.liveClouds.group)
      for (const cloud of handles.liveClouds.group.children) {
        const m = (cloud as THREE.Mesh).material as THREE.Material | undefined
        if (m) applyAtmosphere(m)
      }
      console.info(`clouds: ${handles.liveClouds.count} generated from placements`)
      cloudShadow.setClouds(handles.liveClouds, ctx.level.lighting.sun) // DEV-585
    }

    // ── Anniversary systems: the far shore (DEV-119) ──────────────────────
    //
    // Built on BOTH presets and shown by the flag, the way the clouds are: a
    // flip mid-run must not rebuild a world. The reference level the ridges
    // stand on is the sea where there is one — the ocean's own collision
    // field, which is the surface without the wave — and otherwise a valley
    // floor read off the land's field, so alpine and desert get a far range
    // that starts under their lowest ground rather than under a sea they do
    // not have. Colour comes from the mission's sky: the dome's SH where the
    // mission carries it, the fog colour where it does not — pillar 4, the sky
    // is the mission's and never a colour typed here. Fogged by the same
    // door as everything else, and it has to be: the fog is what makes a card
    // at 5 km read as a far shore rather than as a wall.
    {
      const sh = ctx.level.lighting.sky?.sh
      const skySh = sh && sh.length === 9 ? sh : null
      const fogLinear = new THREE.Color(
        ctx.level.fog.color[0] ?? 0,
        ctx.level.fog.color[1] ?? 0,
        ctx.level.fog.color[2] ?? 0,
      ).convertSRGBToLinear()
      const horizonWorld: HorizonWorld = {
        referenceY: horizonReferenceY(terrain.heightField, ocean?.heightField ?? null),
        sunDirection: ctx.level.lighting.sun?.direction ?? [0, -1, 0],
        sunColor: ctx.level.lighting.sun?.colorLinear ?? [1, 1, 1],
        horizonColor: (dx, dz, out) => {
          if (skySh) {
            // The coefficients are in UNITY space: one negated z, as the dome
            // does it. A hair above the horizon, where the dome's colour is.
            shRadiance(skySh, dx, 0.03, -dz, out)
            out.r = Math.max(0, out.r)
            out.g = Math.max(0, out.g)
            out.b = Math.max(0, out.b)
          } else {
            out.r = fogLinear.r
            out.g = fogLinear.g
            out.b = fogLinear.b
          }
        },
        seed: horizonSeed(ctx.level.id),
      }
      handles.liveHorizonGeo = createHorizonGeo(editionState, horizonWorld)
      applyAtmosphere(handles.liveHorizonGeo.material)
      render.scene.add(handles.liveHorizonGeo.object)
    }

    // ── the lookdev panel ────────────────────────────────────────────────
    //
    // Built last, because it takes handles to everything it tunes and every one
    // of them has to exist. The sun is found by TYPE rather than threaded down
    // from `applyLighting`: there is exactly one directional light in the scene
    // (the sun is per-mission, and the validator refuses a level whose
    // environment contributes a second), so the search is unambiguous and the
    // alternative is changing a signature for a dev tool.
    if (LOOKDEV) {
      let sunLight: THREE.DirectionalLight | null = null
      render.scene.traverse((o) => {
        if (!sunLight && (o as THREE.DirectionalLight).isDirectionalLight) {
          sunLight = o as THREE.DirectionalLight
        }
      })
      handles.liveLookdev = buildLookdev(
        ctx.fog,
        sunLight,
        handles.liveClouds,
        handles.liveSky,
        render.scene,
        render.renderer,
        editionState,
        flatFov,
        warp,
        bloom,
        placementTuning,
        sceneTintLookdevGroup(sceneTint, editionState.current, ctx.level.id),
        ctx.level.id,
        shakeLookdev.group(editionState.current.cockpit.shake, editionState.current.id),
      )
      console.info('lookdev: press L')
    }

    render.scene.add(turnIndicators.object)
    render.scene.add(particleFx.object)
    render.scene.add(loadedFlight.object)
    // DEV-358: the ship's wing-tip trails, at the ROOT (world-space vertices),
    // through the fog's door as a thing in the world. Unlit, so only the fog:
    // the far shadow is a lighting term and there is none to patch.
    if (loadedFlight.wingTrails) {
      render.scene.add(loadedFlight.wingTrails.trails.object)
      ctx.fog.applyTo(loadedFlight.wingTrails.trails.material)
    }

    // ── the race start platform ──────────────────────────────────────────
    //
    // The deck you stand on, the 75 m start line, and the three launch pads.
    // World-space, not parented to the ship: it does not move, and the ship
    // leaves it. See `render/start-grid.ts` for what is measured and what is
    // ours to author.
    // DEV-457: a course with no deck (the two rookie courses) still gets the
    // pads under its racers, so it runs this block with an empty one.
    const authoredGrid = (ctx.level.spawn as { startGrid?: Parameters<typeof createStartGrid>[0] })
      .startGrid
    // DEV-475: a player course's deck is PADS with no slabs (its start pad and
    // the sky's two `ai` pads beside it), and those are drawn too. No shipped
    // level authors pads without slabs, so every shipped deck is as it was.
    const grid = authoredGrid?.slabs?.length || authoredGrid?.pads?.length ? authoredGrid : NO_DECK
    // DEV-444: 2016's pad art, loading; awaited before the warm, as the launch
    // rig is (below, beside DEV-438's), and dropped if it lands after it.
    let startPadArt: Promise<boolean> | null = null
    let startPadArtOpen = true
    // DEV-549/550: 2016's deck and the hover glows, after the pads; the same gate.
    let startDeckArt: Promise<boolean> | null = null
    let startDeckArtOpen = true
    // The starts that hold a ship at the release and so stand on a copy of the
    // player's pad: the preset's slots (DEV-125) and, on a course with no `ai`
    // pad, 2016's two ghost starts (DEV-442, both presets since DEV-457). In a
    // room, those of them the race put a ship on, person or bot (DEV-477).
    const releaseStarts = roomActive()
      ? roomOccupiedStarts().filter(heldAtRelease)
      : rulesFor(ctx.RUNNING_MODE).opponents && OPPONENTS !== 'ghosts'
        ? racerStarts(ctx.level, editionState.current.gameplay.racers).filter(heldAtRelease)
        : []
    if (grid.slabs.length || releaseStarts.length) {
      // ── a pad under every Anniversary slot (DEV-125) ──────────────────
      //
      // The three 2016 pads are measured; the slots are the preset's, laid
      // out by `racer-grid.ts` — the SAME list `loadRacers` spawns from, so a
      // racer and its pad cannot disagree. Only when the mode has opponents to
      // stand on them: a Free Flight course with three empty pads ahead of the
      // player would be a grid for a race that never starts.
      //
      // DEV-444: each is a copy of the pad under the PLAYER at the release —
      // the lift's height, 2016's player pad's size and turn (`releasePadOf`) —
      // because a slot holds its racer at that same altitude. An AI pad's dish
      // at an AI pad's height, which the octagon stood for, has its floor
      // 0.21 m over the hull on `int_01`. A room's people stand on the same
      // starts, so on the same pads (DEV-477).
      const releasePad = releasePadOf(grid, ctx.level.spawn, ctx.level.spawn.launch)
      // DEV-444: and the player's own pad where the lift leaves the ship, not
      // where 2016 authored it (0.41 m and 0.65 m over it on the adv decks).
      const padSpecs = deckPadsOf(grid, releasePad, releaseStarts)
      handles.startGrid = createStartGrid({ ...grid, pads: padSpecs })
      render.scene.add(handles.startGrid.object)
      for (const mesh of handles.startGrid.object.children) {
        mesh.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.Material | undefined
          if (m) applyAtmosphere(m)
        })
      }
      console.info(
        `start grid: ${grid.slabs.length} slabs, ${grid.pads.length} pads ` +
          `(${grid.pads.filter((p) => p.role === 'ai').length} AI)`,
      )
      // ── and every pad in 2016's art, when it lands (DEV-444) ──────────
      //
      // `projector04-faceted.glb`: the mesh the lift rides on, in its own frame.
      // A failed fetch leaves the octagons, which is the grid as it was.
      const dressing = handles.startGrid
      startPadArt = loadMesh(assetUrl(START_PAD_MESH)).then(
        (loaded) => {
          try {
            if (!startPadArtOpen) return false
            dressing.dress(loaded.object, applyAtmosphere)
            return true
          } catch (error) {
            console.warn("start grid: 2016's pad would not stand; the octagons stay —", error)
            return false
          } finally {
            loaded.dispose()
          }
        },
        (error: unknown) => {
          console.warn("start grid: 2016's pad did not load; the octagons stay —", error)
          return false
        },
      )
      // ── 2016's deck, a lift under every pad (DEV-549), and a hover glow
      //    under every pad that stands on nothing (DEV-550) ────────────────
      //
      // After the pads stand, because each opening is cut down what its pad
      // DRAWS (`render/start-deck.ts`); the file is fetched alongside them. A
      // failed fetch leaves FF2's slabs, which is the deck as it was.
      const placements = (grid as { art?: readonly DeckPlacement[] }).art ?? []
      const deckFile = placements.length > 0 ? loadMesh(assetUrl(START_DECK_MESH)) : null
      // DEV-898: the deck's fetch is awaited only after the pads' art settles. A deck that is
      // absent (a clone has no bought meshes) can reject before that, and an unhandled
      // rejection is a console ERROR for a failure the code below already handles. This marks
      // the rejection handled; the `await` further down still sees it and falls back to slabs.
      deckFile?.catch(() => {})
      // A deck that never stands: the slabs' tops, as the pads' floor.
      const slabFootprints = grid.slabs.map((slab) => {
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3().fromArray(slab.pos as number[]),
          new THREE.Quaternion().fromArray(slab.quat as number[]),
          new THREE.Vector3(1, 1, 1),
        )
        const [w = 0, , d = 0] = slab.size as number[]
        return [
          [-w / 2, -d / 2],
          [w / 2, -d / 2],
          [w / 2, d / 2],
          [-w / 2, d / 2],
        ].map(([x = 0, z = 0]) => {
          const v = new THREE.Vector3(x, 0, z).applyMatrix4(m)
          return { x: v.x, z: v.z }
        })
      })
      startDeckArt = startPadArt.then(async () => {
        let deck: StartDeck | null = null
        if (deckFile) {
          try {
            const loaded = await deckFile
            try {
              if (!startDeckArtOpen) return false
              deck = createStartDeck(loaded.object, placements, dressing.pads, applyAtmosphere)
              dressing.standDeck(deck)
            } finally {
              loaded.dispose()
            }
          } catch (error) {
            console.warn("start deck: 2016's deck did not stand; the slabs stay —", error)
            deck = null
          }
        }
        if (!startDeckArtOpen) return false
        // A pad floats where nothing is under its centre: no tile of 2016's
        // deck, or — where that did not stand — none of the slabs (asked in
        // either winding: a slab's corners go round whichever way its turn
        // leaves them). Never the player's: it is the lift's car, on its own
        // shaft's head, on every course.
        const floors = deck ? deck.tiles.map((t) => t.hull) : slabFootprints
        const on = (p: { x: number; z: number }) =>
          floors.some((f) => insideConvex(f, p) || insideConvex([...f].reverse(), p))
        const under = dressing.pads.map(
          (pad, i) =>
            padSpecs[i]?.role !== 'player' && !on({ x: pad.position.x, z: pad.position.z }),
        )
        // The wings' own glow material, AS the wings wear it: not through
        // `applyAtmosphere`, so it keys like theirs and compiles nothing
        // (measured: programs 136 -> 136 on `rookie_01`; through the
        // atmosphere's patches it was 139). Unfogged as the wings are, at
        // the 12-20 m a neighbour stands from the seat.
        const glow = glowMaterial()
        dressing.hover(under, glow)
        console.info(
          `start deck: ${deck ? `2016's deck stands (DEV-549), ${deck.openings.length} openings` : grid.slabs.length ? 'the slabs stand' : 'no deck'}; ` +
            `${under.filter(Boolean).length} of ${under.length} pads float (DEV-550)`,
        )
        return true
      })
    }

    // ── the launch elevator, on a STATIC anchor ──────────────────────────
    //
    // It used to be parented to `loadedFlight.object`, under a comment saying
    // that was "so it inherits the spawn pose". It does — and then it inherits
    // every pose after it, because that group IS the ship: `flight.render()`
    // writes the interpolated body transform straight onto it every frame.
    //
    // Measured: 15 s into a run the elevator's world position was
    // (716, 349, 1260) and the ship's was (717, 350, 1259). The launch pad and
    // the shaft were flying the course welded to the jet, 1.6 km from the
    // island they belong to.
    //
    // Nothing caught it because nothing could see it. From the cockpit the
    // platform is directly below and behind, and the one live shaft segment is
    // 96 m overhead — outside the forward view in every screenshot we own, and
    // `?view=chase` points at the AI racers rather than at the player.
    //
    // So: an anchor at the spawn POSE, set once, never touched again. Every
    // offset inside `createElevator` is relative to where the ship starts,
    // which is exactly what this group is — so the contents need no change.
    const launchArt = ctx.level.spawn.launch
    // DEV-438: 2016's launch room and shaft, loading; awaited before the warm.
    let launchRig2016: Promise<boolean> | null = null
    let launchRig2016Open = true
    {
      // ── what is gated on the ELEVATOR, and what is not ─────────────────
      //
      // This block used to open `if (launchArt?.platform && launchArt.shaft)`,
      // and it holds three things: the elevator, the HANGAR, and the TITLE
      // SCREEN. Only the first of the three has anything to do with a launch
      // rig — and **six of the thirteen missions have no rig**, because 2016's
      // JumpSeat spawns on its own sprung legs with no shaft to ride. So all six
      // booted into a game with no title screen and no level select: a menu
      // screen with no room, no chair, no tables, and no press that did
      // anything. Half the content was unreachable, and the picker offered it
      // anyway. (`tests/e2e/completion.spec.ts` is what asked.)
      //
      // The room is now built for every mission and the elevator for the seven
      // that have one. The size does not change: all seven rigs are the same
      // `[9.35, 1.75, 9.28]` platform on a spacing of 12, so `hangarSpecFor()`'s
      // defaults ARE those numbers and the room has always been one room.
      const anchor = new THREE.Group()
      anchor.name = 'launch-anchor'
      // At the spawn MARKER — the platform's resting place — not at the ship.
      //
      // `flight.ts` starts the body at `launchBaseY + rise`, already at the top
      // of the shaft, so copying the ship's initial position puts the anchor
      // 106.6 m high and the hangar with it. Everything inside `createElevator`
      // is expressed relative to the RESTING platform (`platform.position.y =
      // offset + rise`, the shaft segment at `localY + offset`), so the resting
      // place is the frame those offsets are in.
      //
      // This is what the old ship-parented version accidentally got right: the
      // ship's own descent to the marker cancelled the mistake out. Static, it
      // does not, and the first build of this put the hangar at pad height with
      // the player in open air 106 m below it.
      //
      // Sim space to three: position flips z, orientation negates x and y.
      const p0 = loadedFlight.jet.body.position
      const q0 = loadedFlight.jet.body.orientation
      // One rise below the ship, which is the platform's resting place when
      // there is a platform — and `DEFAULT_HANGAR_DROP` (the same 106.647 m)
      // when there is not, so a JumpSeat's room is as deep as a HoverJet's and
      // just as far from the terrain, the water and the ship.
      // DEV-475: a lift that rises nothing (a player course's start pad) is no
      // shaft to hang a room under, so it takes the default drop as a JumpSeat
      // does; every shipped lift rises 106.647 m and is as it was.
      applyUnityPose(
        anchor,
        { x: p0.x, y: p0.y - (launchArt?.rise ? launchArt.rise : DEFAULT_HANGAR_DROP), z: p0.z },
        q0,
      )
      // ── DEV-249: which chunks the bore actually passes through ──────────
      //
      // Selected by each chunk's own WORLD bounds against a disc around the
      // bore, never by arithmetic on chunk indices: the terrain group carries a
      // transform (`load-terrain.ts` composes the Unity offset into it) and the
      // `chunk_<cx>_<cy>` names encode grid position, not world position. Asking
      // `Box3.setFromObject` cannot be wrong about where a mesh is; a derived
      // index can, and the env-root lesson in DEVIATIONS says so in four
      // environments' worth of detail.
      //
      // `margin` carries the generator's jitter, which is the same quantity
      // `revealRiseFor` adds for the same reason: the collision surface a bound
      // is computed from is not the surface the render draws. Called for the
      // generated bore when the world is built, and again for 2016's shaft
      // when it lands (DEV-460), which is wider and off the ship.
      const pickBoreChunks = (cx: number, cz: number, margin: number): void => {
        if (RIDE_HIDE !== 'bore') return
        const grp = terrain.group
        grp.updateMatrixWorld(true)
        const box = new THREE.Box3()
        handles.boreChunks = grp.children.filter((child) => {
          if (!child.name.startsWith('chunk_')) return false
          box.setFromObject(child)
          if (box.isEmpty()) return false
          // Nearest point of the chunk's footprint to the bore's axis.
          const dx = Math.max(box.min.x - cx, 0, cx - box.max.x)
          const dz = Math.max(box.min.z - cz, 0, cz - box.max.z)
          return dx * dx + dz * dz <= margin * margin
        })
        handles.boreChunkNames = new Set(handles.boreChunks.map((c) => c.name))
        console.info(
          `ride: ?rideHide=bore \u2014 hiding ${handles.boreChunks.length} of ` +
            `${grp.children.filter((c) => c.name.startsWith('chunk_')).length} chunks ` +
            `within ${margin.toFixed(1)} m of the bore` +
            (handles.boreChunks.length === 0
              ? ' — NONE, so the ride shows the world and the bore may show ground'
              : `: ${handles.boreChunks.map((c) => c.name).join(', ')}`),
        )
      }
      if (launchArt?.platform && launchArt.shaft) {
        handles.elevator = createElevator({
          platform: launchArt.platform,
          // Carries both segment lists. `createElevator` builds the seven 2016
          // disabled as well as the one it shipped — without them the hangar's
          // bore opens into 79 m of open sky and the room does not read as
          // underground at all. DEV-024c.
          shaft: launchArt.shaft,
          rise: launchArt.rise,
          // The walls (DEV-106) are sized off the room below, and crunched
          // with its seed.
          hangar: hangarSpecFor(),
          seed: HANGAR_SEED,
        })
        anchor.add(handles.elevator.object)

        // ── nothing of the world inside the tube ─────────────────────────
        //
        // The walls seal the shaft (DEV-106), which turns "what can the eye
        // see from the ride" into "what crosses the bore's own volume": the
        // sea, on Simonet, and the hillside, on rookie_01. Two mechanisms,
        // because the two surfaces are different shapes —
        //
        //   the SEA is cut out of the bore per fragment, in the water shader,
        //   because its ceiling swings ±7.5 m and no hold-until height clears
        //   it before the rim does (`setShaftBore`);
        //
        //   the LAND is held off until the deck is above the highest ground in
        //   the bore, which on six rigs is 2016's own trigger height and on
        //   rookie_01 is 1.4 m later (`revealRiseFor`). The collision surface,
        //   sampled where the render's jitter is added back as a margin.
        //
        // The anchor is the platform's resting place, so heights here are
        // world minus the anchor's y — the frame `rise` is in.
        {
          const field = terrain.heightField
          let top = Number.NEGATIVE_INFINITY
          for (let ri = 0; ri <= 6; ri++) {
            for (let ai = 0; ai < 24; ai++) {
              const r = (ri / 6) * handles.elevator.boreRadius
              const a = (ai / 24) * Math.PI * 2
              // The field is SIM space, which mirrors z.
              const h = terrainHeightAt(
                field,
                anchor.position.x + Math.cos(a) * r,
                -(anchor.position.z + Math.sin(a) * r),
              )
              if (h > top) top = h
            }
          }
          const [, py] = launchArt.platform.offset as [number, number, number]
          const [, sy] = launchArt.platform.shipOffset as [number, number, number]
          ctx.landRevealRise = revealRiseFor(
            Number.isFinite(top) ? top - anchor.position.y : null,
            sy - py,
            terrain.params.randomOffset,
          )
          ocean?.water?.setShaftBore(
            anchor.position.x,
            anchor.position.z,
            handles.elevator.boreRadius,
            anchor.position.y + handles.elevator.rimY,
          )

          // DEV-249: which chunks the bore passes through (`pickBoreChunks`).
          pickBoreChunks(
            anchor.position.x,
            anchor.position.z,
            handles.elevator.boreRadius + terrain.params.randomOffset,
          )
        }
      }

      // ── the hangar ─────────────────────────────────────────────────────
      //
      // The room the shaft comes out of. `_ui-flow.md` §5: 2016's level-select
      // room IS the base of this shaft — an `Environment_Hangar.prefab` with
      // the player seated and holotables ringing the seat — so the menu and the
      // launch were always one place. It was generated (DEV-035) while rule 7
      // barred the bought geometry it is made of; since DEV-438 2016's own room
      // is drawn over it when `hangar-room.glb` lands (below), and the
      // generated one stays as what stands until then.
      //
      // On the SAME anchor as the elevator, and for the same reason it exists:
      // a room parented to the ship would fly the course with it.
      // The LAUNCH room: shell, strips and lamp, and nothing else — which is
      // what `PlayerStart_ElevatorShaft_Photon_02.prefab` carries. You ride out
      // of this one. The furnished one is in `menuScene`, where 2016 keeps it.
      handles.launchRoom = createHangar({
        spec: hangarSpecFor(),
        seed: HANGAR_SEED,
        furnished: false,
        title: '',
        subtitle: '',
        level: null,
      })
      // ── two rooms, two names ───────────────────────────────────────────
      //
      // `createHangar` names its group `hangar`, and since DEV-076 there are two
      // of them in two different scenes. `walkthrough.spec.ts` and
      // `title-screen.spec.ts` both asserted *"the room is up"* by traversing
      // `render.scene` for that name — where the only `hangar` is THIS one, the
      // launch room, which nothing ever hid. So both were reading the launch
      // shell's existence and reporting it as the menu being on screen, which is
      // the trap `completion.spec.ts`'s own probe warns about in as many words.
      // Nothing caught it because the two were indistinguishable. They are not
      // any more. DEV-094.
      handles.launchRoom.object.name = 'launch-room'
      anchor.add(handles.launchRoom.object)
      render.scene.add(anchor)

      // ── 2016's launch room and shaft, when they land (DEV-438) ─────────
      //
      // Out of `hangar-room.glb`, the level-select room's own file, at the size
      // a mission's rig is — `render/hangar-art.ts` says why that is not the
      // menu's size. Only where there is a lift to ride: the six JumpSeat rooms
      // are never on screen. Awaited before the warm-up below, so the room, the
      // shaft and the tubes compile there and not in the ride; a load that
      // lands later is dropped and the generated rig stays.
      if (handles.elevator) {
        const room = handles.launchRoom.object
        const lifted = handles.elevator
        // ── DEV-460: the world stays outside 2016's shaft ─────────────────
        //
        // Everything above was sized off the GENERATED bore: round, 6.78 m,
        // about the ship. 2016's shaft is a square with its corners let out to
        // 9.4 m, about the lift 1.3 m off the ship, so the sea stood in its
        // corners at eye level and the ground came on inside it at the reveal.
        // `render/lift-seal.ts` clears the lift's column, hatches the shaft at
        // the world's height, and reports the shaft's own outline; here the
        // sea's hole takes that outline, the land is held to that footprint,
        // and the frame loop closes the hole once the lift plugs the hatch.
        const [, py = 0] = (launchArt?.platform?.offset ?? []) as number[]
        const [, sy = 0] = (launchArt?.platform?.shipOffset ?? []) as number[]
        let groundTop: number | null = null
        const landSurface = {
          field: terrain.heightField,
          jitter: terrain.params.randomOffset,
          map: terrain.heightMap,
          // The ring on this look now (Anniversary), whose reconstruction
          // stands up to half a grey level over the map. A look flipped from
          // the pause plate mid-ride is not re-read.
          ring: ((spec) =>
            spec ? { jitter: terrain.params.randomOffset * spec.jitterScale } : null)(
            detailRingFor(editionState.current.terrain.detailRing, {
              isOcean: false,
              quality: editionState.settings.quality,
            }),
          ),
        }
        const sealed = sealLift(lifted, {
          hatchFor: (axis, radius) => {
            anchor.updateMatrixWorld(true)
            const top = worldTopIn(
              anchor.matrixWorld,
              axis,
              radius,
              landSurface,
              ocean?.water
                ? {
                    field: ocean.heightField,
                    jitter: ocean.params.randomOffset,
                    displace: ocean.water.displace,
                  }
                : null,
            )
            groundTop = top.land
            return hatchHeightOf(top, terrain.params.randomOffset)
          },
          onSeal: (seal) => {
            anchor.updateMatrixWorld(true)
            const at = new THREE.Vector3(seal.axis.x, 0, seal.axis.z).applyMatrix4(
              anchor.matrixWorld,
            )
            handles.liftSeal = {
              seal,
              x: at.x,
              z: at.z,
              topY: anchor.position.y + lifted.rimY,
              table: holeTableFor(seal.reach, anchor.quaternion, SHAFT_REACH_STEPS),
              live: true,
            }
            ocean?.water?.setShaftBore(at.x, at.z, 0, handles.liftSeal.topY, handles.liftSeal.table)
            // The land waits for the plug, but not past the eye clearing the
            // rim, and never for less than the ground in the lift's column.
            const deckDrop = Math.max(sy - py, -seal.deckFoot)
            const inColumn = worldTopIn(
              anchor.matrixWorld,
              seal.axis,
              columnRadiusOf(seal),
              landSurface,
              null,
            ).land
            const jitter = terrain.params.randomOffset
            ctx.landRevealRise = landRevealFor({
              plugged: revealRiseFor(groundTop, deckDrop, jitter),
              column: revealRiseFor(inColumn, deckDrop, jitter),
              eyeClears: lifted.rimY - EYE.y,
            })
            pickBoreChunks(at.x, at.z, seal.boreRadius + terrain.params.randomOffset)
            console.info(
              `launch: 2016's shaft sealed (DEV-460) — hole ${seal.boreRadius.toFixed(2)} m ` +
                `about the lift, hatch ${seal.hatchY === null ? 'none' : `at ${seal.hatchY.toFixed(2)} m`}, ` +
                `sea closes at rise ${seal.sealRise === null ? 'never' : seal.sealRise.toFixed(2)}, ` +
                `land at ${ctx.landRevealRise.toFixed(2)}`,
            )
          },
        })
        // DEV-443: 2016's shaft head cut at the rim, where the generated shaft
        // ended, so the start deck is not walled off from the seat at the top.
        const lift = cutShaftAtRim(sealed)
        // DEV-568: and wears the hangar's curve, the menus' (D35), on any look.
        const hangarTone = editionsLoaded.get(MENU_EDITION)
        launchRig2016 = import('@/render/hangar-art')
          .then(({ createLaunchArt }) => {
            const art = createLaunchArt({
              room,
              lift,
              alive: () => launchRig2016Open,
              look: hangarTone && {
                hangar: toneLookOf(hangarTone),
                live: () => toneLookOf(editionState.current),
              },
            })
            handles.liveLaunchLook = art.retone
            return art.ready
          })
          .catch(() => false)
      }
    }
    // The opposition. See OPPONENTS: AI racers by default, the 2016 recordings
    // under `?opponents=ghosts`. Never both — three ships on the line is the
    // grid, six is a pile-up.
    if (!rulesFor(ctx.RUNNING_MODE).opponents || !racesIn(ctx.level.vehicle)) {
      // Nobody to race. An opponent is a RACE, and Target Practice is a score
      // attack while Free Flight is exploration — so six of the thirteen
      // missions had two HoverJets flying a ring course the mode does not
      // score, for the whole life of the port. See `ModeRules.opponents` for
      // why the three JumpSeat scenes that DO carry a `GhostRacer` are not
      // evidence against this. DEV-055. And DEV-399: a mode that races, in an
      // aircraft no racer flies — the glider — races nobody (`racesIn`).
      ghosts.dispose()
      console.info(
        rulesFor(ctx.RUNNING_MODE).opponents
          ? `opponents: none \u2014 no racer flies the ${ctx.level.vehicle}`
          : `opponents: none \u2014 ${ctx.RUNNING_MODE} does not race`,
      )
    } else if (roomActive()) {
      // DEV-388: a room races people — and DEV-391's bots, which the room's
      // owner flies here as single player flies its racers, from the starts
      // the room handed them, in the colours it gave them.
      ghosts.dispose()
      const race = roomCore.room?.session.race ?? null
      const bots = roomBotHost() && race ? roomBots().starts : []
      if (race && bots.length > 0) {
        const pal = roomPalette(editionState.current.render.racerLivery)
        handles.liveRacers = await loadRacers(
          ctx.level,
          mission.course.gates,
          GUIDE_SPLINE,
          editionState.current.gameplay.racers,
          {
            edition: editionState,
            sheet: loadedFlight.jet.sheet,
            starts: bots,
            // DEV-651: the same seed every client names these bots from.
            callsignSeed: roomCallsignSeed(race),
            palette: race.bots.map((b) => paletteColour(pal, b.colour)),
            // Every other human in the room, in their traffic picture.
            others: Math.max(0, (roomCore.room?.session.settings?.seats ?? 1) - 1),
          },
        )
        for (const m of handles.liveRacers.solidMaterials) applyAtmosphere(m)
        if (handles.liveRacers.wingTrails)
          ctx.fog.applyTo(handles.liveRacers.wingTrails.trails.material)
        render.scene.add(handles.liveRacers.group)
      }
      console.info(
        bots.length > 0
          ? `opponents: the room, and its ${bots.length} bots, flown here (the host)`
          : 'opponents: the room',
      )
    } else if (OPPONENTS === 'ghosts') {
      render.scene.add(ghosts.group)
      handles.liveGhosts = ghosts
    } else {
      ghosts.dispose()
      // The grid is the PRESET's (DEV-125): Classic's is 2016's two pads,
      // Anniversary's adds three slots ahead. Read at load — a preset flip
      // mid-run changes the rules, not how many ships are already flying.
      handles.liveRacers = await loadRacers(
        ctx.level,
        mission.course.gates,
        GUIDE_SPLINE,
        editionState.current.gameplay.racers,
        // DEV-350: the livery — the palette at load, the look followed live.
        // DEV-382: and the machine, the player's own view of the sheet, so the
        // racers fly your variant (AIRCRAFT-VARIANTS §6.4). Undefined on a
        // JumpSeat, which races nobody: 2016's HoverJet.
        // DEV-651: and their callsigns, drawn for this course (`game/race-callsigns.ts`).
        {
          edition: editionState,
          sheet: loadedFlight.jet.sheet,
          // DEV-844: a fresh draw each attempt (Matt, 2026-10-08), not the
          // course's fixed five: asked at load and again on every retry.
          attemptCallsignSeed: () => attemptCallsignSeed(ctx.level.id),
        },
      )
      // A SOLID racer is a thing in the world, so it takes the world's door:
      // the fog and the far-field shadow, as the player's hull takes the second
      // (DEV-350). The hologram never went through it and still does not, so
      // Classic is unchanged. Handed out rather than walked for, because in
      // Classic these materials are on no mesh at all.
      for (const m of handles.liveRacers.solidMaterials) applyAtmosphere(m)
      // DEV-358: their wing-tip trails, fog only, as the player's are.
      if (handles.liveRacers.wingTrails)
        ctx.fog.applyTo(handles.liveRacers.wingTrails.trails.material)
      render.scene.add(handles.liveRacers.group)
      console.info(
        `opponents: ${handles.liveRacers.count} AI racers (${handles.liveRacers.racers.map((r) => racerName(r.spec)).join(', ')})`,
      )
    }
    document.body.dataset.opponents = String(
      handles.liveRacers?.count ?? handles.liveGhosts?.count ?? 0,
    )
    roomWorldBuilt(loadedFlight.variant) // DEV-388
    // ── DEV-371: your lap, and the ghost of the one you race ────────────
    //
    // A THIRD slot, beside the opposition and not in its branch: the ghost
    // flies WITH the racers (PLAYER-GHOSTS §8 call 1), on both presets —
    // 2016's opposition were ghosts, so Classic gets it too (§4.2). Only where
    // the mode races, for the reason the racers are: a ghost is a race.
    //
    // DEV-372's two fields, out of the lap server's own module so the recorder
    // and the validator cannot disagree: `rules` is its hash of the course, the
    // edition's gameplay block and the aircraft VARIANT (a board per variant;
    // null where it keeps no board, and then the lap is local), and `vehicle`
    // is `<vehicle>:<variant>`, `standard` included. The variant is the one this
    // flight was BUILT as (`flight.variant`: the hangar's choice, else the
    // remembered one, else `?variant=`), and a different variant is a world
    // swap (DEV-382), so a lap run never outlives its variant. LAZY:
    // `content/lap-courses.json` is 155 KB and only a race needs it. A chunk
    // that will not load records no laps this world, rather than writing a
    // second copy of `lapVehicle`'s format that could drift from the first.
    // DEV-469: and none for a "fly from here", which is part of a course: its
    // lap is not the course's, and must never be kept as its best or raced.
    const courses =
      rulesFor(ctx.RUNNING_MODE).opponents && !editorPartialRun()
        ? await import('@/net/lap-courses').catch((err: unknown) => {
            console.warn('laps: the lap-server courses did not load; no laps this world', err)
            return null
          })
        : null
    if (courses) {
      const mission = ctx.level.id
      const variant = loadedFlight.variant
      handles.lapRun = createLapRun({
        level: ctx.level,
        worldOffset,
        mode: ctx.RUNNING_MODE,
        build: BUILD_VERSION,
        // DEV-851: a room's player course carries the room's rules, which this
        // page hashed itself to ready (`roomRulesFor`); elsewhere it is local.
        rulesFor: (edition) =>
          courses.lapRules(mission, edition, variant) ??
          ctx.roomCore.roomLapRules(mission, edition, variant) ??
          LOCAL_LAP_RULES,
        vehicle: courses.lapVehicle(ctx.level.vehicle, variant),
        variant,
        urlTaint: URL_TAINT,
        now: () => performance.now(),
        // DEV-373: the ghost the player chose for this course, in this aircraft
        // — a card's pick or a link — asked at every new run.
        chosen: () => chosenGhost(mission, variant),
      })
      const racing = handles.lapRun.newRun(editionState.rules.id)
      handles.livePlayerGhost = await loadPlayerGhost(
        worldOffset,
        racing?.doc ?? null,
        editionState,
      )
      // DEV-856: the ghost is named where it flies, "YOUR GHOST 61.2".
      handles.livePlayerGhost.setLap(racing?.doc ?? null, ghostTagText(racing))
      render.scene.add(handles.livePlayerGhost.group)
      // DEV-408: its wing trails take the fog the racers' do.
      if (handles.livePlayerGhost.wingTrails)
        ctx.fog.applyTo(handles.livePlayerGhost.wingTrails.trails.material)
      console.info(
        racing
          ? `ghost: ${racing.handle ? `${racing.handle}'s lap` : 'your best'} in the ${variant} ${ctx.level.vehicle}, ${racing.result.seconds?.toFixed(2) ?? 'DNF'} s, ${racing.doc.keyCount} keys${racing.tainted ? ' (tainted)' : ''}`
          : `ghost: none for this course in the ${variant} ${ctx.level.vehicle}`,
      )
    }
    // ── DEV-146: the other mission's ships ──────────────────────────────
    //
    // OUTSIDE the opponents branch above, on purpose and twice over. They are
    // not opponents, so `OPPONENTS=ghosts` does not replace them and the
    // results panel never sees them; and the mode rule that says a JumpSeat
    // course races nobody is the rule that makes this the mission worth
    // flying them over. The pairing is the level's, the switch is the preset's,
    // and this call is the whole of what `src/` does about it.
    handles.liveTraffic = await loadAmbientTraffic(
      ctx.level,
      editionState.current.gameplay.ambientTraffic,
    )
    if (handles.liveTraffic) {
      render.scene.add(handles.liveTraffic.group)
      console.info(
        `ambient traffic: ${handles.liveTraffic.count} ship(s) flying ${handles.liveTraffic.mission}'s course`,
      )
    }
    document.body.dataset.traffic = String(handles.liveTraffic?.count ?? 0)
    // DEV-377: the lesson and its instructor, where the mode teaches.
    await ctx.buildLesson(loadedFlight.jet.sheet)
    // The cabin, before the first frame draws it (DEV-088) — with any Placement
    // patch the lookdev panel remembered (DEV-129), and the readout likewise.
    loadedFlight.setInterior(cockpitNow())
    loadedFlight.placeHud(hudPlacementNow())
    if (perfPlate) {
      // loadedFlight.eye, not a constant: six of thirteen missions fly the
      // JumpSeat and its eye is not the HoverJet's.
      loadedFlight.object.add(perfPlate.object)
      perfPlate.place(hudPlacementNow(), PLATE_SIDE, loadedFlight.eye)
    }
    // DEV-361: the race map, on the new panel, before the warm draws it.
    syncRaceMap(loadedFlight.hud.object)
    // DEV-362: and inside the dash's upper screen, so the warm's raster is the
    // layout the flight draws.
    loadedFlight.hud.setSidePlate(
      results.raceMap?.object ?? null,
      editionState.current.hud.raceMap.widthMetres,
    )
    resetThirdPerson()
    // The finish banner is a preset's, so it is built here and on every flip
    // (DEV-123). A no-op on the six missions with no finish art.
    rings.setFinishBanner(editionState.current.gates.finishBanner)
    // The aim reticle, on the same terms and for the same reason (DEV-153).
    rings.setBullseye(
      editionState.current.gameplay.gateBullseye,
      editionState.current.gameplay.gateEvents.cleanCentredness,
    )
    // ── Anniversary systems: the world, handed to the shadow map (DEV-086) ──
    //
    // Both terrains go in even though only the land casts — each one knows which
    // of its own chunks are at LOD 0, and the ocean's answer is "none of them,
    // and it does not receive either" (`shadowFlagsFor` says why). The ship's
    // EXTERIOR hull is found by name because that is the name `flight.ts` gives
    // it; the JumpSeat has no exterior mesh and gets null, which is the honest
    // answer rather than a fallback.
    //
    // DEV-224: the scatter and the landmarks arrive as TWO lists rather than as
    // one walk of `liveProps.group`, because the scatter is the one class
    // `props.scatterShadows` may take out of the caster set. `load-props.ts`
    // collects each as it builds it, so nothing here re-derives the split by
    // matching a group name.
    sunShadows.attach({
      terrains: ocean ? [terrain, ocean] : [terrain],
      scatter: liveProps?.scatterMeshes ?? [],
      landmarks: liveProps?.landmarkMeshes ?? [],
      // DEV-305: the MESHES, not the glTF scene root. three reads `castShadow`
      // off the object it is about to draw and a `Group` is never drawn, so
      // the flag written here had reached nothing since the map landed and the
      // hull cast no shadow in ANY view. `shadowMeshesOf` carries the whole
      // argument. DEV-306 adds the cockpit shell on the same terms — it had no
      // entry at all, so its two flags were three's defaults rather than this
      // table's answer, and the two agreed at `{false, false}`.
      shipExterior: shadowMeshesOf(loadedFlight.object.getObjectByName('ship_third_person')),
      shipCockpit: shadowMeshesOf(loadedFlight.object.getObjectByName('ship_first_person')),
      // DEV-350: the AI racers, which cast only while they are solid.
      racers: handles.liveRacers?.shadowMeshes ?? [],
    })
    // The far-field term (DEV-116): swept from the LAND field and the mission
    // sun's travel direction, once. The ship's own materials — cockpit shell,
    // cabin, exterior hull, the JumpSeat's art — take the same patch, which is
    // the half Unity could never balance: a cockpit that is in the shadow of
    // the ridge it is flying under, by the same rule as the ridge.
    const sweepStart = performance.now()
    // The land's vertex jitter in world metres: `randomOffset` is applied in
    // mesh space (`sim/terrain/faceted.ts`), so the terrain's own y scale
    // carries it to the world. The object path's lift is derived from it.
    // ── DEV-295: and the forest's own darkening, onto the same grid ──────
    //
    // `colliderInputs` is one entry per DRAWN prop in the terrain's MESH frame
    // — the frame `buildPropColliders` turns into sim space by adding the
    // height field's origin — which is the frame the field's grid already runs
    // over, so a texel is `(x / step, z / step)` and there is no transform to
    // get wrong. `counted` is the receipt that says so; a frame mistake here
    // produces an empty field and a picture identical to the build before it,
    // which is the quietest possible failure.
    const canopySpec = editionState.current.render.canopyShade
    const canopy =
      canopySpec.enabled && liveProps
        ? buildCanopyField(
            terrain.heightField,
            // DEV-502: not the trees a course's clearing masked — they are
            // not drawn, so they darken nothing. Every prop on any other world.
            handles.liveLineMask
              ? liveProps.colliderInputs.filter((_, id) => handles.liveLineMask?.masked[id] !== 1)
              : liveProps.colliderInputs,
            canopySpec,
          )
        : null
    // DEV-355: stepped, a row of the march at a time. It was 13 % of one 3.4 s
    // task. `sweepMs` is wall time and so includes the frames let through.
    await slicer.checkpoint()
    const sweep = await slicer.drain(
      farShadow.setWorldSteps(
        terrain.heightField,
        ctx.level.lighting.sun?.direction ?? null,
        terrain.params.randomOffset * (terrain.heightField.scaleY || 1),
        canopy,
      ),
    )
    const sweepMs = performance.now() - sweepStart
    // DEV-476: the same inputs, kept for the editor's re-bake under a moved sun.
    atmosphere.sunBakeInputs = {
      land: terrain,
      jitterMetres: terrain.params.randomOffset * (terrain.heightField.scaleY || 1),
      canopy,
    }
    // DEV-333, from the sweep just taken: it is the sun verdict the bounce
    // needs, and the sun colour is the light `applyLighting` built, composed
    // the same way (linear colour × Marmoset's 2π intensity).
    const bakeSun = ctx.level.lighting.sun
    // DEV-355: stepped, a row of samples at a time. It was 44 % of that task.
    const skyBake = await slicer.drain(
      skyVisibility.setWorldSteps(
        terrain.heightField,
        terrain.colorMap,
        sweep,
        bakeSun
          ? new THREE.Color()
              .setRGB(
                bakeSun.colorLinear[0],
                bakeSun.colorLinear[1],
                bakeSun.colorLinear[2],
                THREE.LinearSRGBColorSpace,
              )
              .multiplyScalar(marmosetSunIntensity(bakeSun.intensity))
          : null,
      ),
    )
    await slicer.checkpoint()
    // ── DEV-489: the custom island's receipt ─────────────────────────────
    customGroundReceipt = terrain.custom
      ? {
          island: terrain.custom.ground.island,
          size: terrain.params.terrainSize,
          maxHeight: terrain.params.terrainHeight,
          ...terrain.custom.timings,
          propsMs: customGroundPropsMs,
          props: liveProps?.instanceCount ?? 0,
          farShadowMs: sweepMs,
          skyVisibilityMs: skyVisibility.bakeMs,
        }
      : null
    if (customGroundReceipt) {
      console.info(
        `custom ground: ${Object.entries(customGroundReceipt)
          .map(([k, v]) => `${k} ${typeof v === 'number' ? v.toFixed(0) : v}`)
          .join(', ')} (DEV-489)`,
      )
    }
    if (skyBake) {
      console.info(
        `sky-visibility: baked ${skyBake.samplesPerSide}² (stride ${skyBake.stride}) in ` +
          `${skyVisibility.bakeMs.toFixed(0)} ms — V min ${skyBake.min.toFixed(3)}, mean ` +
          `${skyBake.mean.toFixed(3)}; bounce peak ${skyBake.maxBounce.toFixed(3)} of the sun (DEV-333)`,
      )
    }
    if (canopy) {
      console.info(
        `canopy-shade: swept ${canopy.counted} props (${canopy.offGrid} off-grid) onto ` +
          `${canopy.vertPerSide}² texels — ${(canopy.occludedFraction * 100).toFixed(1)} % of the ` +
          `grid has canopy over it, and THERE the occlusion is p50 ` +
          `${canopy.p50Occluded.toFixed(3)} / p95 ${canopy.p95Occluded.toFixed(3)} against a ` +
          `${canopySpec.strength} ceiling (peak coverage ${canopy.maxDensity.toFixed(2)}, ` +
          `mean canopy ${canopy.meanCanopyMetres.toFixed(1)} m)`,
      )
    }
    loadedFlight.object.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
      if (!m) return
      for (const mat of Array.isArray(m) ? m : [m]) farShadow.applyTo(mat)
    })
    // DEV-323, and AFTER the far-field patch above on purpose: far-shadow
    // expands `#include <lights_fragment_begin>` and needs to find it, while
    // the near map's patch copes with either shape. Before `warmWorld` below,
    // so the shell's patched program is the one the warm draw compiles.
    cockpitSelfShadow.attach(loadedFlight.object)
    if (sweep) {
      console.info(
        `sun-height: marched ${sweep.vertPerSide}² texels in ${sweepMs.toFixed(0)} ms ` +
          `(${(sweep.steps / (sweep.vertPerSide * sweep.vertPerSide)).toFixed(1)} steps/ray), ` +
          `deepest shadow ${sweep.maxDepth.toFixed(1)} m${sweep.degenerate ? ' (degenerate sun: no term)' : ''}`,
      )
    }
    // The ground, now that it exists. Both terrains: the ocean is a second
    // `FacetedTerrain` and 2016 gave it a `TerrainCollider` too, so the sea
    // stops you the same way a hillside does.
    loadedFlight.setTerrain(
      ocean ? [terrain.heightField, ocean.heightField] : [terrain.heightField],
    )
    // The autopilot looks at the ISLANDS only: the ocean plate is flat and
    // 262 km wide, so including it would have the controller permanently
    // pulling up away from sea level it is already 150 m above.
    handles.autopilotTerrain = [terrain.heightField]
    // The JumpSeat's own controller avoids the same islands the HoverJet's
    // does. Null on a HoverJet mission, so this is a no-op on seven of thirteen.
    jumpSeatAutopilotOf(loadedFlight)?.setAvoidTerrain(handles.autopilotTerrain)
    // Full stick on the JumpSeat is 25.6 deg/s, which is INSIDE the HoverJet's
    // own deadband — share one calibration and the seat never vignettes at all.
    vignette.setFullRate(
      ctx.level.vehicle === 'jumpseat' ? JUMPSEAT_FULL_ROLL_RATE : HOVERJET_FULL_ROLL_RATE,
    )
    // What a racer HITS is not what it AVOIDS. Same two fields the player's
    // hull is given above, and for the same reason: an AI racer with no ground
    // rule at all is how DEV-032's symptom came to be the sea floor rather than
    // a hillside. `stepAiRacer` takes them separately so the controller can
    // keep ignoring the sea while the hull does not.
    handles.collisionTerrain = ocean
      ? [terrain.heightField, ocean.heightField]
      : [terrain.heightField]

    console.info(
      `${terrain.key}: ${terrain.chunkCount} chunks / ` +
        `${terrain.triangleCount.toLocaleString()} tris; ` +
        (ocean
          ? `${ocean.key}: ${ocean.chunkCount} chunks / ` +
            `${ocean.triangleCount.toLocaleString()} tris ` +
            `(LOD ${JSON.stringify(ocean.lodHistogram)}, ` +
            `x${OCEAN_PIN ?? editionState.current.terrain.ocean.subdivisionByLod.join('/')}); `
          : 'no ocean in this environment; ') +
        `${rings.count} rings; ${turnIndicators.count} turn indicators; ` +
        `${ghosts.count} ghosts`,
    )

    // ── the cabin's two lamps leave the world's shaders (DEV-192) ────────
    //
    // `render/cockpit-interior.ts` puts two `PointLight`s in this scene to
    // light a dashboard, and three has no per-object light scoping — so every
    // lit material in the frame runs two `RE_Direct_Physical` evaluations per
    // fragment for a lamp in a sealed canopy. Both lamps carry a `distance`
    // (3 m and 1.8 m), so past the cutoff three's own `getDistanceAttenuation`
    // returns zero and `RE_Direct` has no early-out: the full BRDF runs and is
    // multiplied by nothing. DEV-191 priced that at **−0.38 ms at one worn eye
    // on the land alone**, 60 % of the terrain's entire fragment stack.
    //
    // HERE, and not in `applyAtmosphere`, because the cut has to be the LAST
    // patch on every material it touches: an `onBeforeCompile` chain runs in
    // install order, `far-shadow.ts` expands `#include <lights_fragment_begin>`
    // and `fragment-gates.ts` rewrites the `#if` inside it, and either arriving
    // after this one would find a statement already replaced. The world is
    // built by then and one sweep is the only place that is reliably last.
    //
    // And BEFORE `warmWorld` below, so the programs the warm draw builds are
    // the programs the flight uses — the whole of DEV-117's lesson.
    //
    // **The SHIP is exempt, and it is one node rather than a list because the
    // lamps hang off `art_pivot` at the EYE.** The cockpit shell, the cabin
    // body and the exterior hull are all under it — the hull because in third
    // person its inner faces are still inside the lamps' 3 m — and the dash
    // instruments (`next-gate-arrow.ts` is 0.82 m from the eye) are under the
    // ship group beside it. So the exemption is the ship group, which is the
    // same object the lamps are inside.
    const pointLightScope = KEEP_POINT_LIGHTS
      ? null
      : scopeWorldPointLights(render.scene, [loadedFlight.object])
    console.info(
      pointLightScope === null
        ? 'point-light scope: ?pointLights=keep — the NUM_POINT_LIGHTS loop is still in every ' +
            'world shader. This is the A arm of DEV-192’s photograph, not a way to play.'
        : `point-light scope: cut the NUM_POINT_LIGHTS loop from ${pointLightScope.scoped} ` +
            `materials (${pointLightScope.already} already cut, ` +
            `${pointLightScope.exempt} exempt under '${loadedFlight.object.name}') — DEV-192`,
    )

    // ── the world's first draw, under the curtain (DEV-117) ──────────────
    //
    // Before `loading.ready()` releases the fade and before `terrain-ready` is
    // published, so the frame is black and no spec has started its clock. The
    // land group is still hidden for the ride at this point, and its first
    // draw — 19 programs and 164 buffers on `int_01` — would otherwise land on
    // the reveal frame 100 m up the shaft, which is the 2.0–2.6 s hitch Matt
    // reported. `render/warm-up.ts` says why `renderer.compile` was not enough.
    //
    // Drawn under the FLIGHT's lights, not the room's: three keys every lit
    // program on the light COUNTS, the reveal hides the room and its lamp, the
    // cockpit's two lamps are on once you are aboard, and the title screen's
    // logo key light (a `SpotLight`, `render/title.ts`) sits in this scene
    // until the world is torn down. So the room and the title are hidden for
    // the draw and the ship put in first person — the view the frame loop
    // sets every frame anyway (`flight?.setView(...)`), so nothing here needs
    // putting back. `render/warm-up.ts` has the measurement; the title light
    // was found on `rookie_01_hoverJet`, whose alpine build is quick enough to
    // finish while the title is still up, where `int_01`'s was not — a race,
    // and the hide is what makes it not one.
    {
      loadedFlight.setView('first')
      const hide: THREE.Object3D[] = []
      if (handles.launchRoom) hide.push(handles.launchRoom.object)
      // The title screen, whose logo carries a `SpotLight` and therefore a
      // `numSpotLights` of its own in three's program cache key — so a warm
      // draw with it in the scene builds variants the flight never uses
      // (DEV-188).
      //
      // **Since DEV-281 this is always null and the guard is belt to a brace.**
      // The title world is either never built (a `?menu=0` boot) or torn down
      // by the course selection that got here, so there is nothing in the scene
      // to hide and the warm compiles at zero spot lights unconditionally —
      // which is what it was contorting to achieve. Kept because `hide` is a
      // list of *things that must not be in the warm draw* and the title is one
      // of them whatever the current call graph says.
      if (handles.title) hide.push(handles.title.object)
      // DEV-152: and the START GRID compiled a second time with the room back
      // on. The draw above hides the room so the programs match the FLIGHT's
      // light count, which is what killed the reveal hitch — but that leaves
      // the SHAFT (one more point light, `numPointLights` is in the cache key)
      // to compile live. Everything else in the shaft draws on the ride's first
      // frame; the launch deck is outside the frustum at the bottom and first
      // draws about 44 m up, which was the one program still compiling in the
      // clear (90–180 ms, DEV-117 §4).
      const shaftLit: THREE.Object3D[] = []
      if (handles.startGrid) shaftLit.push(handles.startGrid.object)
      // And the shaft itself: `elevator-shaft-wall` took the same new key at
      // rise ~0.1 on about one ride in four — the same mechanism a tenth of a
      // metre up instead of forty-four, and cheap to warm at the same time.
      if (handles.elevator) shaftLit.push(handles.elevator.object)
      // ── and the fracture's piece material (DEV-177) ────────────────────
      //
      // BEFORE the draw, not after, and that is the whole trick: a piece is a
      // plain `Mesh` drawn transparent, so three's `instancing` and `opaque`
      // parameters put it on a program of its own no matter what we do to the
      // GLSL — and it first drew when a racer clipped a palm at ~26 s, in the
      // seat, for 200 ms. `prime` hangs an invisible mesh carrying that
      // material under the fracture group; `warmWorld`'s own `compile(scene,
      // …)` traverses with `traverse` rather than `traverseVisible`, so it is
      // built inside the same render-target binding and the same light count
      // as everything else here. Then the meshes come out and the MATERIALS
      // stay, pooled — disposing one would hand the program straight back.
      const primed = handles.liveFracture?.prime(
        handles.livePropsLive
          ? handles.livePropsLive.group.children.flatMap((cellGroup) =>
              (cellGroup.children as THREE.Object3D[]).flatMap((o) => {
                const mesh = o as THREE.Mesh
                const material = mesh.material as THREE.Material | undefined
                return mesh.isMesh && material ? [{ geometry: mesh.geometry, material }] : []
              }),
            )
          : [],
      )
      // ── and the LOD fade's clone program (DEV-184) ─────────────────────
      //
      // BEFORE the warm, not after, and that is the whole trick. The fade's
      // discard now lives behind a `#define` the pooled clones carry and the
      // base does not, so a clone is a SECOND program — and its first draw
      // would otherwise be a LOD change in flight, in the clear. Swapping the
      // clone onto a live chunk here puts it inside `warmWorld`'s own draw,
      // where it inherits the composer target (its colour space is in three's
      // cache key — DEV-117) and the flight's light count (field #36 —
      // DEV-152). A `warmVariants`-shaped call after the fact would get both
      // wrong and warm a variant nothing ever draws.
      //
      // Null on Classic and on any terrain that cannot fade, so this is
      // nothing at all on the preset that never cuts a clone.
      const undoFadeWarm = [terrain.warmLodFade(), ocean?.warmLodFade() ?? null]
      // ── and the HUD's first FLIGHT-LAYOUT raster (DEV-250) ─────────────
      //
      // BEFORE the draw, like the fracture's material and the fade's clone,
      // and for the same shape of reason: `draw()` only sets
      // `texture.needsUpdate`, and the bytes do not move until three binds
      // this material inside a real `renderer.render`. The render below is
      // that one, and `show` is what guarantees the panel is in it.
      //
      // The labels are the LIVE mission's, read the same way the frame loop
      // reads them — a warm that drew `GATES` on a level whose copy says
      // `ORBS` would rasterise five glyphs the flight never asks for and miss
      // four it does. `speedUnit` likewise: Anniversary's row ends `km/h` and
      // Classic's does not.
      //
      // `RUNNING_MODE` and not `mission.mode`: the count label follows the
      // mode actually being played, `?mode=` included, which is what the loop
      // passes too.
      const warmHudOps = HUD_WARM_PIN
        ? loadedFlight.hud.warm(
            warmHudState({
              countLabel: countLabel(ctx.level, ctx.RUNNING_MODE),
              timeLabel: uiLabel(ctx.level, 'timeLabel', 'TIME'),
              speedLabel: uiLabel(ctx.level, 'speedLabel', 'SPEED'),
              speedUnit: editionState.current.hud.speedUnit,
            }),
          )
        : null
      // DEV-438: 2016's launch rig is in the scene before the warm, or not at
      // all. It started loading with the room, seconds ago, so this is almost
      // always already settled; the bound is for a slow R2, and past it the
      // gate closes and the generated rig rides instead.
      if (launchRig2016) {
        const stood = await Promise.race([
          launchRig2016,
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), LAUNCH_RIG_2016_WAIT_MS),
          ),
        ])
        launchRig2016Open = false
        console.info(
          stood
            ? "launch: 2016's room and shaft stand (DEV-438)"
            : "launch: the generated room and shaft ride (2016's did not land in time)",
        )
      }
      // DEV-444: and 2016's pads on the start deck, the same way.
      if (startPadArt) {
        const stood = await Promise.race([
          startPadArt,
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), LAUNCH_RIG_2016_WAIT_MS),
          ),
        ])
        startPadArtOpen = false
        console.info(
          stood
            ? "start grid: 2016's pads stand (DEV-444)"
            : "start grid: the octagons stand (2016's pads did not land in time)",
        )
      }
      // DEV-549/550: and 2016's deck under them, and the glows: in the scene
      // before the warm, so their materials compile there, or not at all.
      if (startDeckArt) {
        const stood = await Promise.race([
          startDeckArt,
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), LAUNCH_RIG_2016_WAIT_MS),
          ),
        ])
        startDeckArtOpen = false
        if (!stood) console.info("start deck: the slabs stand (2016's deck did not land in time)")
      }
      let warm: Awaited<ReturnType<typeof warmWorldLinked>>
      try {
        // DEV-355: the same warm in two passes, with the ~1.5 s of program links
        // waited out BETWEEN them, off the thread — `warmWorldLinked` says how.
        warm = await warmWorldLinked(
          render.renderer,
          render.scene,
          render.camera,
          terrain.group,
          {
            // The rig, and the camera and everything riding on it, is in the
            // ROOM's scene when a course is picked from the room. The mission
            // frame draws it in this one, so it is warmed in this one.
            adopt: [render.rig],
            // And the ride's first frame, room lamp and all: 1.6–2.1 s of
            // compiles on that frame before DEV-355. Linked with the rest, off
            // the thread. The room is hidden while you are in the menu, so it
            // is named and shown for this rather than found showing.
            rideLit: handles.launchRoom ? [handles.launchRoom.object] : [],
            offscreen: bloom.willComposite(),
            // ── and the SESSION's binding too (DEV-239) ─────────────────
            //
            // `willComposite()` is `!renderer.xr.isPresenting && …` and this
            // runs under the loading CURTAIN, which is before `#enter-vr` has
            // been pressed — so on Anniversary it is always true and every
            // program above is built against the composer's linear target,
            // which a session never draws through. Three gives an XR render
            // target the canvas's colour space and tone mapping, so the
            // default binding IS the session's; `warm-up.ts` has the two lines
            // of `getParameters` that say so, and the numbers.
            //
            // Gated on the device, not on intent: a build that cannot enter a
            // session must not pay for the session's programs, and `?xr=off`
            // leaves this false for exactly that reason (it skips the probe
            // rather than answering it — see the `xr.supported` note above).
            // A device that CAN enter one pays whether or not the player does,
            // because nothing under the curtain knows which button is coming.
            alsoDefaultTarget: capabilities.immersiveVr,
            hide,
            // DEV-250. Only when the arm is on, so the two arms differ by the
            // whole of the change and not by a forced draw either way.
            //
            // And the player's ghost (DEV-371), on both arms, so they still
            // differ by the panel alone: it is hidden until the release and
            // after a lap with no ghost, so without this its program would
            // first compile on the frame it first appears, in the air. It is
            // counted in `shown` below with the panel.
            show: [
              ...(HUD_WARM_PIN ? [loadedFlight.hud.object] : []),
              ...(handles.livePlayerGhost ? [handles.livePlayerGhost.object] : []),
            ],
            shaftLit,
            // ── the sea's four variants (DEV-167 / W6, corrected) ────────
            //
            // INSIDE the warm, not after it. `outputColorSpace` comes from the
            // bound render target and is in three's program cache key, and so
            // is the light count — so the first version of this, a
            // `renderer.compile` made once `warmWorld` had returned, compiled
            // against the CANVAS with the launch room's lamp back in the
            // count, and built four programs nothing ever draws. It reported
            // `+4` and would have reported `+4` either way.
            //
            // A ride uses three of the four in twelve seconds: two-sided with
            // the bore at the bottom of the shaft, above-water with the bore
            // for the last fifteen metres, above-water without it once the rim
            // clears. Every one is inside the shot DEV-094 keeps.
            //
            // ── and the sea's fade CLONE is four programs too ─────────────
            //
            // DEV-184 made a `lod-fade` clone its own program (the discard is
            // behind a define the clone carries), and the DEV-186 follow-up
            // made the clone copy the base's runtime defines at `acquire`. Put
            // together, the ocean's clone has the same four variants the base
            // has — and `warmLodFade()`, which runs once before `warmWorld`,
            // warms whichever ONE the base happened to be in.
            //
            // Measured on `int_01` with the rest of this correct: the base's
            // four were all warm and `above/bore/fadeClone` still compiled 15 s
            // into the flight, in the clear. So the clone is acquired again
            // INSIDE each variant — `acquire` re-syncs its defines from the
            // base, which is exactly the hook needed — and released after.
            // Cheap: the pool hands the same two clones back each time and
            // three has the program cached after the first of each pair.
            duringWarm: (compile) => {
              const group = ocean?.group
              if (!group) return
              ocean?.water?.warmVariants(() => {
                const undoClone = ocean.warmLodFade()
                try {
                  compile(group)
                } finally {
                  undoClone?.()
                }
              })
            },
          },
          () => performance.now(),
          // A poll every few milliseconds, each one a single round trip.
          () => new Promise<void>((resolve) => setTimeout(resolve, 4)),
        )
      } finally {
        for (const undo of undoFadeWarm) undo?.()
      }
      primed?.done()
      console.info(
        `warm-up: first draw of the world in ${warm.ms.toFixed(0)} ms ` +
          `(links waited out over ${warm.linkMs.toFixed(0)} ms, ${warm.linkWaits} polls, DEV-355) — ` +
          `${warm.programs} programs, ${warm.geometries} geometries, ` +
          `${warm.meshes} meshes unculled, ${warm.offscreen ? 'composer target' : 'default target'}` +
          (warm.bindings > 1 ? ' + the session’s default-target key (DEV-239)' : '') +
          `; lod-fade clones warmed: ${undoFadeWarm.filter((u) => u !== null).length}` +
          (primed === undefined
            ? ''
            : `; fracture pieces ${primed.materials} materials (DEV-177)`) +
          // DEV-250. Both halves, because either alone is a warm that did
          // nothing: `ops` says the PAINT took the flight layout rather than
          // the banner's four-call early return, and `shown` says the panel
          // was actually in the draw that uploaded it.
          (warmHudOps === null
            ? ''
            : `; hud warmed at its flight layout — ${warmHudOps.total} canvas calls ` +
              `(${warmHudOps.texts} text, ${warmHudOps.measures} measure), ` +
              `${warm.shown} drawable(s) forced into the draw (DEV-250)`),
      )
    }
    // ── the world goes LIVE here, whole (DEV-355) ──────────────────────────
    //
    // These four were assigned up beside `resetThirdPerson()`, before the bakes
    // and the warm, at a point no frame could see: nothing after it awaited.
    // Now the bakes and the link wait hand the thread back to the frame loop,
    // and a frame that finds `flight` set steps the sim, and one that finds
    // `liveTerrain` set streams LOD from wherever the camera is — which during
    // a course switch is the ROOM's chair, in another scene's coordinates. So
    // the frame loop sees the new world when it is finished and not before,
    // which is the same "between two courses" state it already sees during
    // every `await` above.
    handles.flight = loadedFlight
    handles.liveTerrain = { terrain, ocean }
    handles.liveFx = particleFx
    // DEV-429: where the sea is, for the spray. The bob is the ocean group's
    // travel from where it was BUILT — `load-terrain.ts`'s own `groupBaseY`,
    // read here, before the first `setWaveTime` has moved it.
    // DEV-613: the same sea, kept for the jets' splashes, and a fresh slate of
    // crossings for the new world.
    handles.liveSea = null
    craftSplashes.clear()
    if (ocean) {
      const oceanBaseY = ocean.group.position.y
      handles.liveSea = {
        ocean: ocean.heightField,
        land: terrain.heightField,
        bob: () => ocean.group.position.y - oceanBaseY,
      }
      particleFx.setSea(handles.liveSea)
    }
    handles.liveRings = rings
    // DEV-193's spike, if it was asked for. HERE and not beside
    // `liveTerrain = {...}`, because the batch key carries `castShadow` and the
    // chunks do not have their flags until `sunShadows.attach` has run — folding
    // earlier would split every band in two and report a plan that is about the
    // order of two statements rather than about the terrain.
    if (CHUNK_BATCH) ctx.setChunkBatch(true)
    // Read by the e2e screenshot test, which cannot know when generation of
    // 1.8 M vertices has finished from the outside.
    document.body.dataset.terrainReady = 'true'
    document.body.dataset.ringCount = String(rings.count)
    // The RUNNING mode, `forcedMode` applied — which is the thing two shipped
    // scenes override and nothing used to read. `ringCount` above is what was
    // LOADED, not what is in the scene: Free Flight loads kauai's 21 and draws
    // none of them, and the difference between those two numbers is exactly
    // what this attribute exists to make visible from outside the page.
    document.body.dataset.mode = ctx.RUNNING_MODE
    document.body.dataset.ringsLive = String(isLive(ctx.RUNNING_MODE, 'ring'))
    document.body.dataset.turnIndicatorCount = String(turnIndicators.count)
    loading.ready()
    return { terrain, ocean, rings, turnIndicators, particleFx, flight: loadedFlight, ghosts }
  }
  return {
    buildWorld,
  }
}
