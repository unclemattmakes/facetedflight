// src/editor/desk/index.ts — the desktop course editor. DEV-469, E4
// (docs/plan/EDITOR-DISPATCH.md; the workflow is EDITOR.md §5.3, and this is
// its desktop half: "On the map (desktop). Orbit camera, click on the terrain
// to add points, TransformControls to move them, a top-down view for layout,
// numeric fields for the exact altitude").
//
// LAZILY IMPORTED. `boot/app.ts` reaches this module only through
// `import('@/editor/desk')`, so the game's entry chunk carries none of it; the
// unit test reads app.ts and refuses a static import.
//
// ── What it is made of ────────────────────────────────────────────────────
//
//   core (DEV-468)   the draft, the pure commands, undo AND redo, the live
//                    warnings, the drafts in storage, the playtest contract.
//                    Everything that decides anything about the course.
//   camera.ts        its own orbit camera and the top-down view.
//   view.ts          the draft drawn in the world; the rings through the
//                    game's own `loadRings`.
//   panel.ts         the side panel, plain DOM.
//   ground.ts        the RENDER surface in the level's frame (never heightField).
//   pick.ts          what a click or a key means, pure.
//
// ── The loop with the game ────────────────────────────────────────────────
//
// The game runs the editor's frame (`frame`) while the editor is up. FLY hands
// `playtestRequest`'s level to `host.fly`, which is `switchMission`; the desk
// is suspended and the world is rebuilt as the course. The pause plate's Back
// to editor, or the results panel's press after a finish, brings the player
// back through `resume(result)`, where DEV-468's `onReturn` records the author
// lap when the flight earns it. The draft, the selection and the camera are
// the desk's own and nothing touched them while it was away.
//
// A change of SKY is a different world (the sun is per mission, CLAUDE.md), so
// it goes through the same switch (`host.showWorld`) and comes back with
// `resume(null)`. It is driven by the draft, not by the control, so an undo
// across a sky change swaps the world back as well.

import * as THREE from 'three'
import { type CourseSpline, nearestArc, splinePointAt } from '@/content/course-spline'
import { reopenMapFile } from '@/content/island-map'
import { type Level, liveRings, type Vec3Tuple } from '@/content/level-schema'
import { generatedLevelIds, loadLevel } from '@/content/load-level'
import {
  groundKey,
  insideArea,
  islandSeaLevel,
  isMapIsland,
  isSeedIsland,
  normalisePropYaw,
  PLAYER_COURSE_LIMITS,
  PLAYER_COURSE_SHAPE,
  PLAYER_COURSE_WATER,
  type PlayerCourse,
  type PlayerCourseProp,
  playerCourseArea,
  playerCourseProps,
  playerCourseSpline,
  propFrameOf,
  randomCourseName,
  seededWaterLevel,
  waterCeiling,
} from '@/content/player-course'
import { clampLight, clampSunToSky, skyLight } from '@/content/player-course-light'
import { linkRefusal, PLAYER_COURSE_WIRE } from '@/content/player-course-wire'
import { placedLandmark, propEntry, propGroups } from '@/content/prop-library'
import {
  addPoint,
  addProp,
  aimPad,
  anchorAimNote,
  anchorHeading,
  anchorHeightFor,
  anchorToPad,
  authorLapOf,
  canRedo,
  canUndo,
  clampPropScale,
  createDebounce,
  createHistory,
  createHistoryLoop,
  type DraftEvaluation,
  deleteDraft,
  deletePoint,
  deleteProp,
  draftFromCourse,
  draftToDrop,
  EDITOR_POLICY,
  type EditorDraft,
  evaluateDraft,
  extendRunout,
  GROUND_WARNING_KINDS,
  type Ground,
  type History,
  insertPointOnPath,
  isAnchoredPoint,
  isBlankDraft,
  liftClear,
  listDrafts,
  loadDraft,
  movePad,
  movePoint,
  moveProp,
  NO_GROUND,
  newDraft,
  newDraftSlot,
  onReturn,
  type PlaytestResult,
  type Props,
  padSizeOf,
  playtestRequest,
  randomInt,
  redo,
  rerollName,
  runInFixOf,
  runInOf,
  saveDraft,
  scaleProp,
  seal,
  seatPadAt,
  select,
  setFinish,
  setGap,
  setLight,
  setSky,
  setTimeLimit,
  setWater,
  shelfLabel,
  shelfOf,
  straightenRunIn,
  toggleRingSkip,
  turnProp,
  undo,
  withAuthorLap,
} from '@/editor/core'
import { applyFit, fitFlight, flightOfClip, recordingLevel } from '@/editor/core/fit'
import { environmentDisplayName } from '@/game/mission-index'
import type { LineClearingReceipt } from '@/game/props/course-clearing'
import { safeLocalStorage } from '@/game/storage'
import { courseWaterOf, waterWorldY, withCourseWater } from '@/game/terrain/course-water'
import {
  type CustomGround,
  customGroundOf,
  donorLand,
  withCustomGround,
} from '@/game/terrain/custom-ground'
import { decodeGhostClip } from '@/sim/ghost'
import { buildPropColliders, type PropColliders } from '@/sim/props/collision'
import { baseLabels } from './bases'
import { createDeskCamera } from './camera'
import { createFinishMarker, finishRadiusOf } from './finish-marker'
import { viewOf } from './fly'
import { createDeskGizmo, ringGeometryOf } from './gizmo'
import { deskGround } from './ground'
import { groundHit } from './ground-hit'
import { groundMarks } from './ground-marks'
import type { Desk, DeskHost, DeskLibraryEntry, DeskRecordedFlight } from './host'
import {
  type IslandChoice,
  type IslandDialog,
  openIslandDialog,
  openSeedDialog,
} from './island-dialog'
import { createLeaveDialog, leaveAsks, shelfWords } from './leave'
import { createDeskPanel, formatDistance, type PanelSky } from './panel'
import { deskKeyAction, nearestOnPolyline, nearestWithin, type ScreenPoint } from './pick'
import { DESK_POLICY, placeHeightFor, propYawFor } from './policy'
import { allProps, collidersAsProps } from './prop-colliders'
import { createDeskProps, footprintSeat } from './props'
import { createDeskRecording } from './recording'
import { courseSlots, seatNewDraft } from './slots'
import { createDeskStartPad, START_PAD_POLICY } from './start-pad'
import { type DeskPicked, type DeskTool, gizmoFor, toolNote, uniformScaleOf } from './tools'
import { createDeskView } from './view'

/** DEV-499: what the panel says to do about a course whose imported map this browser lost. */
const LOST_MAP_HINT =
  'Open its map file (or its .ffcourse) to bring the map back, or make a new island.'

export type { Desk, DeskHost } from './host'

/**
 * The sky of the draft this browser saved last, or null: where the title's
 * MAKE A COURSE builds its island, so the editor opens on the draft's own.
 */
export const lastDraftSky = (): string | null => listDrafts(safeLocalStorage())[0]?.sky ?? null

/**
 * DEV-490: the course of the draft this browser saved last, or null: MAKE A
 * COURSE builds the world over its own island when it has one, so the world
 * is built once rather than built and then swapped.
 */
export const lastDraftCourse = (): PlayerCourse | null => {
  const storage = safeLocalStorage()
  const recent = listDrafts(storage)[0]
  return recent ? (loadDraft(storage, recent.slot)?.course ?? null) : null
}

/**
 * The HoverJet missions on `island`: its skies (DEV-466 refuses the JumpSeat
 * ones). DEV-499: the panel calls them BASES and names each by its place and a
 * derived word (`bases.ts`), not by the mission.
 */
const skiesOn = async (island: string | null): Promise<{ sky: PanelSky; level: Level }[]> => {
  const levels: Level[] = []
  for (const id of generatedLevelIds()) {
    const level = await loadLevel(id)
    if ((island === null || level.environment === island) && level.vehicle === 'hoverjet') {
      levels.push(level)
    }
  }
  const labels = baseLabels(levels)
  return levels.map((level) => ({
    sky: {
      id: level.id,
      title: labels.get(level.id) ?? level.title,
      place: environmentDisplayName(level.environment),
    },
    level,
  }))
}

/**
 * DEV-875: every island's bases. Matt: *"I can't seem to build a course on Mesa
 * Canyon nor Alpine."* The picker listed only the draft's own island's bases
 * and no control changed the island, so a player who came in over Simonet (the
 * default) could never leave it. The panel groups these by place.
 */
export const allSkies = (): Promise<{ sky: PanelSky; level: Level }[]> => skiesOn(null)

/**
 * DEV-498: metres from `eye` to the far edge of the ocean's far sea, or 0 while
 * there is none or it is hidden. Its bounds are measured once per object, in
 * x and z only: the ocean group bobs with the wave (`setWaveTime`), so a sphere
 * measured in 3D is a function of the wave's phase at the moment of measuring,
 * and a Fly and back measured a new far sea 5 cm away (`editor-desk.spec.ts`
 * holds the camera to the one it left).
 */
const farSeaSpheres = new WeakMap<THREE.Object3D, THREE.Sphere>()
const farSeaReach = (
  ocean: { farSea(build?: boolean): THREE.Object3D | null } | null,
  eye: THREE.Vector3,
): number => {
  const far = ocean?.farSea(false) ?? null
  if (!far?.visible) return 0
  let sphere = farSeaSpheres.get(far)
  if (!sphere) {
    far.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(far)
    const centre = new THREE.Vector3((box.min.x + box.max.x) / 2, 0, (box.min.z + box.max.z) / 2)
    const radius = Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z) / 2
    sphere = new THREE.Sphere(centre, radius)
    farSeaSpheres.set(far, sphere)
  }
  return eye.distanceTo(sphere.center) + sphere.radius
}

export const createDesk = (host: DeskHost): Desk => {
  const storage = safeLocalStorage()
  // DEV-472 follow-up: the fly reads the ground under the eye (its speed and
  // near plane) and never starts while the gizmo holds a drag.
  const cam = createDeskCamera(host.gameCamera, host.canvas, {
    surfaceAt: (x, z) => ground.surfaceAt(x, z),
    blocked: () => dragging,
    // DEV-498: the far sea the game builds for the desk (`farSea`), once shown.
    farReach: (eye) => farSeaReach(host.terrains()?.ocean ?? null, eye),
  })
  const view = createDeskView()
  // DEV-473: the finish, labelled, moved live by the panel's slider.
  const finishMarker = createFinishMarker()
  view.root.add(finishMarker.object)
  // DEV-475: the start pad, the racers' pads beside it, and its heading.
  const startPad = createDeskStartPad()
  view.root.add(startPad.object)
  // DEV-491: the last recorded flight, drawn under the line it became.
  const recordingLine = createDeskRecording()
  view.root.add(recordingLine.object)
  // DEV-504: the draft's placed props, drawn by the flight's own landmark path.
  const deskProps = createDeskProps()
  view.root.add(deskProps.object)

  // ── the draft ───────────────────────────────────────────────────────────
  //
  // The most recent draft in this browser, or a new one over the world the
  // game booted. A sky must be a HoverJet mission (DEV-466): a `?mission=`
  // naming a JumpSeat course gives a draft the validator refuses by its sky,
  // said in the panel, until one of the island's HoverJet skies is chosen.
  const bootLevel = host.level()
  const recent = listDrafts(storage)[0]
  const stored = recent ? loadDraft(storage, recent.slot) : null
  let slot = stored && recent ? recent.slot : newDraftSlot(randomInt)
  let donor: Level = bootLevel
  let history: History = createHistory(stored ?? newDraft(bootLevel, randomCourseName(randomInt)))
  let skies: PanelSky[] = [{ id: bootLevel.id, title: bootLevel.title }]
  let placeHeight = placeHeightFor(bootLevel)
  // ── DEV-490: the island the world was built on ──────────────────────────
  /**
   * `groundKey` of the world's ground: '' for the sky's own island. A fixture
   * ground with no key (DEV-489's `?island=cone` door) counts as the sky's
   * own, so a plain draft over it does not rebuild the world.
   */
  let worldKey = customGroundOf(bootLevel)?.key ?? ''
  /** A ground just built by the island dialog, used rather than read back. */
  let pendingGround: CustomGround | null = null
  /** A draft's island that could not be built, so it is not asked again; said in the panel. */
  let groundTrouble: {
    readonly key: string
    readonly why: string
    /** DEV-499: its imported map is not in this browser, so the panel offers New and Open. */
    readonly lost: boolean
  } | null = null
  let islandDialog: IslandDialog | null = null

  let active = true
  let busy = false
  let ground: Ground = NO_GROUND
  let groundOf: unknown = null
  /** DEV-500: the water the ground was last built with, world metres; null for none. */
  let groundWater: number | null = null
  /** DEV-500: whether the world standing has a course's water in it (`courseWaterOf`). */
  let worldWater = false
  let evaluation: DraftEvaluation | null = null
  let dragging = false
  let lastEvaluate = 0
  let spline: CourseSpline | null = null
  /** DEV-467's library, for Remix; read at the start and on every return. */
  let library: readonly DeskLibraryEntry[] = []
  /** What the last Save file or Copy link did, and the link it made. */
  let shared = ''
  let link = ''
  // ── DEV-491: what the last recording made ─────────────────────────────────
  /** Said under Record a flight. */
  let recordNote = ''
  /** Its numbers, for the probe. */
  let lastRecording: {
    readonly seconds: number
    readonly metres: number
    readonly samples: number
    readonly points: number
    readonly error: number
    readonly tolerance: number
    readonly within: boolean
  } | null = null
  const forgetRecording = (): void => {
    recordNote = ''
    lastRecording = null
    recordingLine.set(null)
  }
  // ── DEV-501 follow-up (Matt: "yes"): say when the desk turned the pad ────
  /**
   * Said under "Ring 1 is anchored to the pad." when the desk turned the pad
   * itself so its anchored ring 1 clears the ground (a new draft, a re-seated
   * pad, Anchor ring 1 to pad). The next edit, undo or redo clears it.
   */
  let padTurnNote = ''
  /**
   * Aim the pad where ring 1 clears (`anchorHeading`), and say so if that
   * turned it — or, where no heading clears it, say THAT: only moving the pad
   * can (DEV-501 follow-up: it said "so ring 1 clears" whenever it turned).
   */
  const aimClear = (d: EditorDraft): EditorDraft => {
    const aim = anchorHeading(d.course, donor, ground)
    padTurnNote = anchorAimNote(d.course.start.yaw, aim)
    return aimPad(d, aim.yaw)
  }
  // ── DEV-475: the start pad as a thing to pick, move and aim ──────────────
  //
  // The pad is picked apart from the points (a draft's `selection` is a point
  // index; the pad is the desk's own choice of what the gizmo holds). Picked,
  // the gizmo moves it on X and Z only and the desk SEATS it on what you can
  // see there (`seatPadAt`: the highest ground under its footprint), or, in
  // rotate mode (E since DEV-570; R before), turns it about Y only.
  let padPicked = false
  /**
   * A draft just opened whose pad may not stand on the ground yet — a new
   * draft's, on the sky's own start, or a v1 course's, moved to v2 in the air.
   * Seated once, when the ground is built, if nothing has been edited since.
   */
  let seatFor: EditorDraft | null = null
  /** A NEW draft's pad is looked for on dry, flat ground (`padSpot`), not only seated. */
  let seatSearch = false
  // ── DEV-504: placed props, picked and placed ────────────────────────────
  //
  // As the pad: the desk's own choice of what the gizmo holds, not the
  // draft's. `propPlacing` is a library kind every ground click drops one of;
  // `propPicked` an index into `course.props`, which the gizmo moves on X and
  // Z (seated on what you can see) or, spinning (E since DEV-570), turns
  // about Y, or (R, DEV-570) is sized.
  let propPlacing: string | null = null
  let propPicked: number | null = null
  /** The land group's child count the desk last hid the world's placed props under. */
  let landKids = -1
  // ── DEV-570: Maya's tools (`tools.ts`) ──────────────────────────────────
  //
  // Q select, W move, E rotate, R scale: the DESK's tool, kept as the
  // selection changes (Maya's way). It replaces DEV-475's `padRotate` and
  // DEV-504's `propSpin`, which were the same idea held twice, each reset by
  // every pick, and reached by R.
  let tool: DeskTool = 'move'
  /** The picked prop's size as a scale drag began: the drag's reference. */
  let scaleFrom = 1

  const draft = (): EditorDraft => history.present
  const course = () => history.present.course
  /** DEV-570: what the gizmo is held on, by kind. */
  const pickedKind = (): DeskPicked | null =>
    propPicked !== null && course().props?.[propPicked]
      ? 'prop'
      : padPicked
        ? 'pad'
        : draft().selection !== null
          ? 'point'
          : null
  /** DEV-570: the picked pad is shown its ring (E): DEV-475's "aiming". */
  const padAiming = (): boolean => padPicked && gizmoFor('pad', tool)?.mode === 'rotate'
  /** DEV-570: the picked prop is shown its ring (E): DEV-504's "spinning". */
  const propSpinning = (): boolean =>
    propPicked !== null && gizmoFor('prop', tool)?.mode === 'rotate'
  /** DEV-570: choose a tool; the gizmo follows on the next `changed`. */
  const setTool = (t: DeskTool): void => {
    if (t === tool) return
    tool = t
    changed()
  }

  // ── the gizmo ───────────────────────────────────────────────────────────
  const {
    proxy,
    gizmo,
    debugHooks: gizmoDebug,
  } = createDeskGizmo(cam.camera, host.canvas, view.root)
  gizmo.addEventListener('dragging-changed', (e) => {
    dragging = e.value === true
    cam.controls.enabled = !dragging
    // DEV-570: a scale drag is measured from the size it began at.
    if (dragging && propPicked !== null) scaleFrom = course().props?.[propPicked]?.scale ?? 1
    if (!dragging) {
      history = seal(history)
      changed()
    }
  })
  gizmo.addEventListener('objectChange', () => {
    if (!dragging) return
    // DEV-504: a placed prop — moved on X and Z and seated, or turned about Y.
    // The gizmo's own mode says what the drag is (`syncGizmo` set it from the tool).
    if (propPicked !== null) {
      const i = propPicked
      if (gizmo.mode === 'rotate') {
        const q = proxy.quaternion
        const yaw = (2 * Math.atan2(q.y, q.w) * 180) / Math.PI
        apply(reseated(turnProp(draft(), i, yaw), i), `prop:turn:${i}`)
      } else if (gizmo.mode === 'scale') {
        // DEV-570: R. A prop has one size, so whichever handle is pulled sizes
        // it whole; the proxy is set back to that size, clamped, each step.
        const s = proxy.scale
        const want = uniformScaleOf([s.x, s.y, s.z], scaleFrom)
        const next = reseated(scaleProp(draft(), i, want), i)
        apply(next, `prop:scale:${i}`)
        proxy.scale.setScalar(next.course.props?.[i]?.scale ?? want)
      } else {
        const p = proxy.position
        const old = course().props?.[i]
        const y = old ? (seatProp({ ...old, pos: [p.x, p.y, p.z] }) ?? p.y) : p.y
        proxy.position.y = y
        apply(moveProp(draft(), i, [p.x, y, p.z]), `prop:move:${i}`)
      }
      return
    }
    // DEV-475: the pad — moved on X and Z and seated, or turned about Y.
    if (padPicked) {
      if (gizmo.mode === 'rotate') {
        // The gizmo turns the proxy about world Y only (`syncGizmo` shows no
        // other ring), so its quaternion is a heading's, the spawn's own.
        const q = proxy.quaternion
        apply(aimPad(draft(), (2 * Math.atan2(q.y, q.w) * 180) / Math.PI), 'pad:aim')
      } else {
        const p = proxy.position
        const y = seatY(p.x, p.z) ?? p.y
        proxy.position.y = y
        apply(movePad(draft(), [p.x, y, p.z]), 'pad:move')
      }
      return
    }
    const i = draft().selection
    if (i === null) return
    const p = proxy.position
    apply(movePoint(draft(), i, [p.x, p.y, p.z]), `move:${i}`)
  })
  /** DEV-475: where the pad's foot stands over (x, z): the ground's highest under it. */
  const seatY = (x: number, z: number): number | null => {
    const size = padSizeOf(donor)
    return size ? seatPadAt(ground, x, z, size) : null
  }
  /**
   * DEV-504: where prop `p`'s pivot stands over its (x, z): the LOWEST ground
   * you see under its base (`props.ts`'s `footprintSeat`; its base's reach is
   * measured off the mesh as the flight would draw it, turned and scaled),
   * less the preset's sink. Its pivot alone while its mesh is still loading.
   */
  const seatProp = (p: PlayerCourseProp): number | null => {
    const entry = propEntry(p.kind)
    if (!entry) return null
    const landmark = placedLandmark(p, entry, propFrameOf(course(), donor), 0)
    const r = deskProps.footprint(landmark, { x: p.pos[0], z: p.pos[2] }, host.terrains()) ?? 0
    return footprintSeat(
      (x, z) => ground.surfaceAt(x, z),
      p.pos[0],
      p.pos[2],
      r,
      host.propLook().sink,
    )
  }
  /** DEV-504: `d` with prop `i` seated again (a turn or a new size moves its base). */
  const reseated = (d: EditorDraft, i: number): EditorDraft => {
    const p = d.course.props?.[i]
    const y = p ? seatProp(p) : null
    return p && y !== null ? moveProp(d, i, [p.pos[0], y, p.pos[2]]) : d
  }
  /** DEV-504: pick placed prop `i` (or none). Picking one drops the pad and the point. */
  const pickProp = (i: number | null): void => {
    propPicked = i
    if (i !== null) padPicked = false
    if (i !== null && draft().selection !== null) {
      apply(select(draft(), null))
      return
    }
    changed()
  }
  /**
   * DEV-504: a new prop of `kind`, where a ground click landed. NOT picked: a
   * garden is several clicks, and a gizmo jumping to each new prop would stand
   * its arrows over the next click. A click on one picks it.
   */
  const placeProp = (kind: string, at: THREE.Vector3): void => {
    const entry = propEntry(kind)
    if (!entry) return
    // Seated only once its mesh has loaded: `seatProp` measures the base off
    // the mesh, and before it loads it has only the pivot to stand on. A click
    // right after the kind was picked (the preload still in flight) seated
    // on the pivot's ground and stood a cactus on air at the edge of a facet —
    // editor-props.spec.ts's one red. The same draft, or none: a click whose
    // draft was swapped while it waited places nothing.
    const onDraft = slot
    void deskProps.ready(entry.asset).then(() => {
      if (slot !== onDraft || !active) return
      const n = course().props?.length ?? 0
      if (n >= PLAYER_COURSE_LIMITS.props.max) return
      const look = host.propLook().scale[entry.kind ?? ''] ?? 1
      const yaw = normalisePropYaw(propYawFor(n))
      const scale = clampPropScale(kind, entry.scale.default * look)
      const y = seatProp({ kind, pos: [at.x, at.y, at.z], yaw, scale })
      if (y === null) return
      apply(addProp(draft(), kind, [at.x, y, at.z], yaw, scale))
    })
  }
  /** DEV-504: another draft opened: nothing picked, nothing being placed. */
  const dropPropTools = (): void => {
    propPicked = null
    propPlacing = null
  }
  /** DEV-504: delete the picked prop, one undo step; nothing is picked after. */
  const removeProp = (): void => {
    const i = propPicked
    if (i === null) return
    propPicked = null
    apply(deleteProp(draft(), i))
  }
  /** DEV-504: the prop under a click, by a ray at the drawn props. */
  const propHit = (clientX: number, clientY: number): number | null => {
    const rect = host.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    propRay.setFromCamera(ndc, cam.camera)
    return deskProps.pick(propRay)
  }
  const propRay = new THREE.Raycaster()
  /** DEV-475: pick the pad (or drop it). Picking it drops the point selection. */
  const pickPad = (on: boolean): void => {
    padPicked = on
    if (on) propPicked = null // DEV-504
    if (on && draft().selection !== null) {
      apply(select(draft(), null))
      return
    }
    changed()
  }
  /** DEV-475: seat the opened draft's pad, once, if the ground is here and nothing moved. */
  const seatOpened = (): void => {
    const opened = seatFor
    // DEV-490: not while a world is being built, and never over another island's.
    if (!opened || ground === NO_GROUND || busy) return
    // DEV-875: and not over another sky's world (a base on another island).
    if (donor.id !== opened.course.sky) return
    if (groundKey(opened.course.ground) !== worldKey) return
    seatFor = null
    if (history.present !== opened || canUndo(history)) return
    const s = opened.course.start
    const searched = seatSearch // DEV-501: a new draft, whose pad is aimed too
    if (seatSearch) {
      seatSearch = false
      const area = playerCourseArea(donor)
      const inside = (x: number, y: number, z: number): boolean =>
        area ? insideArea(area, { x, y, z }) : true
      // DEV-490 (Matt's call 4 on DEV-489): on a course's own island the sky's
      // start is often open sea; the search starts from the dry ground
      // nearest it instead. DEV-501 follow-up: and it passes over places from
      // which no heading clears ring 1 (`seatNewDraft`, pure, so a seed and a
      // base give one new draft).
      const seated = seatNewDraft(opened, donor, ground, host.racers(), inside)
      if (seated) {
        const p = seated.draft.course.start.pos
        padTurnNote = anchorAimNote(seated.fromYaw, seated.aim)
        history = createHistory(seated.draft)
        console.info(
          `editor: the start pad stands on dry, flat ground ${Math.hypot(
            p[0] - s.pos[0],
            p[2] - s.pos[2],
          ).toFixed(0)} m from the sky's own start`,
        )
        changed()
        return
      }
    }
    const y = seatY(s.pos[0], s.pos[2])
    const seat =
      y === null || Math.abs(y - s.pos[1]) <= PLAYER_COURSE_SHAPE.pointQuantumMetres
        ? opened
        : movePad(opened, [s.pos[0], y, s.pos[2]])
    const next = searched ? aimClear(seat) : seat
    if (next === opened) return
    // Not an undo step: the pad was always meant to stand on the ground.
    history = createHistory(next)
    if (y !== null) {
      console.info(`editor: the start pad seated on the ground (${(y - s.pos[1]).toFixed(1)} m)`)
    }
    changed()
  }

  // ── the panel ───────────────────────────────────────────────────────────
  const heightAboveGround = (p: readonly number[]): number => {
    const g = ground.surfaceAt(p[0] as number, p[2] as number)
    return Number.isFinite(g) ? (p[1] as number) - g : (p[1] as number)
  }
  // ── DEV-473: a slider's drag is ONE undo step ───────────────────────────
  //
  // Each `live` value while the slider moves replaces the entry the drag
  // opened (the history's coalescing, as a gizmo drag uses it); the release,
  // or a typed number, seals it, so the next drag or the next typed value is
  // an entry of its own.
  const slide = (next: EditorDraft, key: string, live: boolean): void => {
    apply(next, key)
    if (!live) history = seal(history)
  }
  // ── DEV-476: the course's light, on the world as it is edited ───────────
  //
  // The draft holds the light (`setLight`: clamped into the sky's band, on its
  // grid); the GAME lights the world by it (`host.setLight`). While a light
  // slider is dragged the game moves only what is cheap, and on its release
  // it re-bakes the island's two sun maps — so `lightSliding` is the drag, and
  // every change of the draft (an undo, a sky swap, a draft opened) hands the
  // game the light as settled.
  let lightSliding = false
  /** The last sun slider asked for a place the sky would not have (`clampSunToSky`). */
  let lightHeld = false
  /** The light the desk draws by: the course's, or the sky's own; always inside the sky's band. */
  const lightShown = () => clampLight(donor, course().light ?? skyLight(donor))
  const pushLight = (settled: boolean): void => {
    if (!busy) host.setLight(course().light ?? null, donor, settled)
  }
  const lightActions = {
    sun: (azimuth: number, elevation: number, live: boolean): void => {
      lightHeld = clampSunToSky(donor, azimuth, elevation).held
      lightSliding = live
      const from = course().light ?? skyLight(donor)
      slide(
        setLight(draft(), { ...from, sunAzimuth: azimuth, sunElevation: elevation }, donor),
        'panel:light',
        live,
      )
      if (!live) pushLight(true) // the release re-bakes even when it moved nothing more
      renderPanel()
    },
    tint: (colour: readonly [number, number, number], amount: number, live: boolean): void => {
      lightSliding = live
      const from = course().light ?? skyLight(donor)
      slide(
        setLight(draft(), { ...from, tint: colour, tintAmount: amount }, donor),
        'panel:tint',
        live,
      )
      if (!live) pushLight(true)
    },
    skyLight: (): void => {
      lightHeld = false
      lightSliding = false
      apply(setLight(draft(), null, donor))
    },
  }
  // ── end DEV-476 ─────────────────────────────────────────────────────────
  // ── DEV-500: the water, previewed on the world as it is edited ──────────
  //
  // On or off rebuilds the world (`syncSky`: a sea plate is added or put back).
  // A level moved is PREVIEWED: the drawn plate moves by the difference from the
  // level the world was built with (`host.previewWater`), and the checks read
  // the course's level at once (`syncGround`); the next world built — a Fly, a
  // return — is built at the level itself.
  /** DEV-876: the sea the course's island has of its own, as a water level; null where there is none. */
  const ownSeaWater = (): { level: number } | null => {
    const sea = islandSeaLevel(course().island)
    return sea === null ? null : { level: sea }
  }
  const pushWater = (): void => {
    // DEV-876: a base with a sea of its own always has a plate to move.
    const own = ownSeaWater()
    const w = course().water ?? own
    const built = courseWaterOf(host.level()) ?? own
    host.previewWater(
      w && built && (worldWater || own) ? waterWorldY(donor, w) - waterWorldY(donor, built) : 0,
    )
  }
  /**
   * A new water's level: the base's own sea; where there is none, a little over
   * the lowest ground in the course's box (its line and pad, sampled on a
   * grid), and never over the pad's own foot less the same margin — a flooded
   * valley floor that leaves the pad dry.
   */
  const firstWaterLevel = (): number => {
    const c = course()
    const sea = islandSeaLevel(c.island)
    if (sea !== null) return sea
    // DEV-877: a seeded island's water starts at the level Matt asked for.
    const floor = waterWorldY(donor, { level: 0 })
    if (isSeedIsland(c.ground)) return seededWaterLevel(c.island, c.ground, floor)
    const depth = PLAYER_COURSE_WATER.defaultDepthMetres
    const xs = [...c.path.points, c.start.pos].map((p) => p[0])
    const zs = [...c.path.points, c.start.pos].map((p) => p[2])
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]
    const n = PLAYER_COURSE_WATER.firstLevelSamples
    let low = Number.POSITIVE_INFINITY
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        const y = ground.surfaceAt(x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * j) / n)
        if (Number.isFinite(y)) low = Math.min(low, y)
      }
    }
    const pad = ground.surfaceAt(c.start.pos[0], c.start.pos[2])
    const top = Number.isFinite(pad) ? pad - depth : Number.POSITIVE_INFINITY
    const y = Math.min(Number.isFinite(low) ? low + depth : floor, top)
    return y - floor
  }
  const waterActions = {
    on: (on: boolean): void => apply(setWater(draft(), on ? firstWaterLevel() : null)),
    level: (worldY: number, live: boolean): void => {
      const floor = waterWorldY(donor, { level: 0 })
      slide(setWater(draft(), worldY - floor), 'panel:water', live)
    },
  }
  // ── end DEV-500 ─────────────────────────────────────────────────────────
  /** DEV-875: every base's level by id, filled when the skies load. */
  const skyIslands = new Map<string, Level>()
  /**
   * DEV-875: a new, empty course over `base`, which may be on another island:
   * the draft's sky is `base`, so `syncSky` loads that world.
   */
  const newCourseOver = (base: Level): void => {
    slot = newDraftSlot(randomInt)
    history = createHistory(newDraft(base, randomCourseName(randomInt)))
    seatFor = history.present
    seatSearch = true
    padPicked = false
    dropPropTools()
    forgetRecording()
    shared = ''
    link = ''
    groundTrouble = null
    console.info(`editor: a new course over ${base.id} (${base.environment})`)
    changed()
    seatOpened()
  }
  const panel = createDeskPanel({
    gap: (m, live) => slide(setGap(draft(), m), 'panel:gap', live),
    timeLimit: (s) => apply(setTimeLimit(draft(), s)),
    // A NEW point's height; the selected point's own is `pointHeight`.
    height: (m) => {
      placeHeight = Math.max(0, m)
      renderPanel()
    },
    pointHeight: (m) => {
      const i = draft().selection
      const p = i === null ? null : course().path.points[i]
      if (i === null || !p) return
      const g = ground.surfaceAt(p[0], p[2])
      apply(movePoint(draft(), i, [p[0], (Number.isFinite(g) ? g : 0) + m, p[2]]))
    },
    // DEV-475: the pad, picked from the panel as well as in the world, aimed
    // by a typed heading as well as by the gizmo's ring.
    // DEV-570: MOVE PAD picks it under the Move tool (W); AIM PAD under Rotate
    // (E), and pressed again while aiming, back to Move. Each says what it does.
    pad: () => {
      if (padPicked) return pickPad(false)
      tool = 'move'
      pickPad(true)
    },
    padRotate: () => {
      tool = padAiming() ? 'move' : 'rotate'
      if (!padPicked) pickPad(true)
      else changed()
    },
    padYaw: (deg) => apply(aimPad(draft(), deg)),
    tool: (t) => setTool(t), // DEV-570
    // DEV-501: the first point becomes the pad's, one undo step.
    anchor: () => {
      const a = anchorToPad(draft(), anchorHeightFor(donor))
      // One step: anchored, and turned (only if it must be) until ring 1 clears.
      if (ground === NO_GROUND) return apply(a)
      const aimed = aimClear(a)
      const note = padTurnNote // `apply` clears it, as it does after any edit
      apply(aimed)
      if (note) {
        padTurnNote = note
        changed()
      }
    },
    finish: (t, live) => slide(setFinish(draft(), t), 'panel:finish', live),
    light: lightActions, // DEV-476
    water: waterActions, // DEV-500
    // DEV-504: the prop library and the picked prop.
    props: {
      place: (kind) => {
        propPlacing = kind && propEntry(kind) ? kind : null
        // Its mesh now, so the first one placed is seated by its base.
        const asset = propPlacing ? propEntry(propPlacing)?.asset : undefined
        if (asset) deskProps.preload(asset)
        if (propPlacing) padPicked = false
        renderPanel()
      },
      yaw: (deg) => {
        if (propPicked !== null) apply(reseated(turnProp(draft(), propPicked, deg), propPicked))
      },
      scale: (s, live) => {
        if (propPicked !== null)
          slide(
            reseated(scaleProp(draft(), propPicked, s), propPicked),
            `prop:scale:${propPicked}`,
            live,
          )
      },
      // DEV-570: SPIN is the Rotate tool (E); pressed again, Move (W).
      spin: () => {
        if (propPicked === null) return
        setTool(propSpinning() ? 'move' : 'rotate')
      },
      remove: () => removeProp(),
      done: () => pickProp(null),
    },
    sky: (id) => {
      // DEV-875: a base on another island is a new course over it (its points
      // and pad are in this island's world); the same island keeps the course.
      const other = skyIslands.get(id)
      if (other && other.environment !== course().island)
        return departing(() => newCourseOver(other))
      apply(setSky(draft(), id))
    },
    reroll: () => apply(rerollName(draft(), randomInt)),
    undo: () => step(undo),
    redo: () => step(redo),
    deletePoint: () => {
      const i = draft().selection
      if (i !== null) apply(deletePoint(draft(), i))
    },
    topDown: () => {
      cam.setTopDown(!cam.topDown)
      renderPanel()
    },
    frame: () => frameArea(),
    fly: () => fly(null),
    // DEV-478: raise the line clear of the ground, one undo step.
    lift: () => {
      if (busy || dragging || ground === NO_GROUND) return
      const before = course().path.points.length
      const next = liftClear(draft(), donor, ground)
      apply(next)
      if (next !== draft() && next.course.path.points.length > before) {
        console.info(
          `editor: lifted clear of the ground, ${next.course.path.points.length - before} point(s) added`,
        )
      }
    },
    // DEV-486: the fix beside a too-sharp run-in, one undo step.
    straighten: () => {
      if (busy || dragging || ground === NO_GROUND) return
      const out = straightenRunIn(draft(), donor, ground, (s) =>
        courseSlots(s, donor, host.racers()),
      )
      if (out.fix === null) {
        console.info('editor: the run-in: nowhere behind point 1 to move the pad')
        return
      }
      apply(out.draft)
      console.info(
        out.fix === 'aim'
          ? `editor: the start pad aimed at point 1 (${out.draft.course.start.yaw.toFixed(1)}°)`
          : `editor: the start pad moved behind point 1, ${out.draft.course.start.pos.map((v) => v.toFixed(1)).join(', ')}`,
      )
    },
    flyFromHere: () => {
      const i = draft().selection
      const p = i === null ? null : course().path.points[i]
      if (!p || !spline) return
      fly(nearestArc(spline, { x: p[0], y: p[1], z: p[2] }) / spline.length)
    },
    newCourse: () =>
      departing(() => {
        slot = newDraftSlot(randomInt)
        history = createHistory(newDraft(donor, randomCourseName(randomInt)))
        seatFor = history.present // DEV-475
        seatSearch = true
        padPicked = false
        dropPropTools() // DEV-504
        forgetRecording() // DEV-491
        changed()
        seatOpened()
      }),
    // DEV-569: Back to hangar. The draft is written now; only a browser that
    // would not keep it is asked first (`leave.ts`).
    leave: () => requestLeave(),
    // ── sharing, through DEV-467's wire (a VALID course only: the quantised
    // one the evaluation holds, whose id is the id the panel shows) ────────
    saveFile: () => {
      const c = evaluation?.course
      if (!c || busy || refused()) return
      shared = 'saving…'
      renderPanel()
      void host.saveFile(c).then(
        () => {
          shared = `Saved ${c.name[0]}-${c.name[1]}.ffcourse`
          document.body.dataset.editorSaved = evaluation?.courseId ?? ''
          refreshLibrary()
        },
        (err: unknown) => {
          shared = 'Could not save the file'
          console.warn('editor: save file', err)
          renderPanel()
        },
      )
    },
    importIsland: () => openIsland('map'),
    seedIsland: () => openIsland('seed'), // DEV-493
    // DEV-499: the course's own map, picked again: the same bytes or nothing.
    reopenMap: (file: File) => {
      const c = course()
      const g = c.ground
      if (busy || !isMapIsland(g)) return
      const key = groundKey(g)
      void (async () => {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const r = await reopenMapFile(g.map, bytes)
        if (!r.ok) {
          groundTrouble = { key, lost: true, why: `That file ${r.why}. ${LOST_MAP_HINT}` }
          renderPanel()
          return
        }
        if (!(await host.keepMap(g.map, bytes))) {
          console.warn('editor: the heightmap could not be kept in this browser')
        }
        console.info(`editor: the map ${g.map.slice(0, 12)}… is back`)
        groundTrouble = null
        if (groundKey(course().ground) === key) syncSky()
        renderPanel()
      })().catch((err: unknown) => {
        console.warn('editor: the map file could not be read', err)
        groundTrouble = { key, lost: true, why: `That file could not be read. ${LOST_MAP_HINT}` }
        renderPanel()
      })
    },
    copyLink: () => {
      const c = evaluation?.course
      if (!c || busy || refused()) return
      // DEV-490: an imported island has no link, nor (DEV-533) a course past
      // a link's 128 props; say so, and offer the file.
      const noLink = linkRefusal(c)
      if (noLink) {
        shared = noLink.why
        link = ''
        renderPanel()
        return
      }
      void host.link(c).then(
        async (made) => {
          link = made
          try {
            await navigator.clipboard.writeText(made)
            shared = `Link copied (${made.length} characters)`
          } catch {
            shared = 'The clipboard said no: copy the link below'
          }
          refreshLibrary()
        },
        (err: unknown) => {
          shared = 'Could not make the link'
          console.warn('editor: copy link', err)
          renderPanel()
        },
      )
    },
    remix: (id) => {
      const entry = library.find((e) => e.id === id)
      if (!entry || busy) return
      departing(() => {
        slot = newDraftSlot(randomInt)
        history = createHistory(draftFromCourse(entry.course, entry.id))
        seatFor = history.present // DEV-475
        padPicked = false
        dropPropTools() // DEV-504
        shared = ''
        link = ''
        forgetRecording() // DEV-491
        console.info(`editor: remixing ${entry.id} (${entry.name}) as draft ${slot}`)
        changed()
        seatOpened()
      })
    },
    // DEV-889: open a draft from the shelf. The one being edited is kept first.
    openDraft: (wanted) => {
      if (busy || dragging) return
      const found = loadDraft(storage, wanted)
      if (!found) {
        console.warn(`editor: draft ${wanted} could not be read`)
        return
      }
      departing(() => {
        slot = wanted
        history = createHistory(found)
        seatFor = history.present // DEV-475
        padPicked = false
        dropPropTools() // DEV-504
        shared = ''
        link = ''
        groundTrouble = null
        forgetRecording() // DEV-491
        console.info(`editor: draft ${wanted} reopened from the shelf`)
        changed()
        seatOpened()
      }, false)
    },
    // DEV-889: the fix beside "the line ends too close to the finish".
    extendRunout: () => {
      if (busy || dragging) return
      const next = extendRunout(draft(), donor, ground === NO_GROUND ? undefined : ground)
      apply(next)
      if (next === draft()) console.info('editor: no room to extend the run-out')
    },
    record: () => startRecording(), // DEV-491
  })

  /**
   * DEV-490 / DEV-493: "New island from a heightmap…" or "… from a seed". The
   * dialog previews; "Use this island" hands back the island block and its
   * ground, built once, and a new draft is made on it. The world is rebuilt
   * by `syncSky`, which uses the ground handed back rather than building it
   * again, and the pad is sought on its dry land (`seatOpened`).
   */
  const openIsland = (mode: 'map' | 'seed'): void => {
    if (busy || islandDialog) return
    const base = {
      island: donor.environment,
      defaultSize: customGroundOf(donor)?.size ?? donorLand(donor.environment).entry.terrainSize,
      close: () => {
        islandDialog = null
      },
      use: (choice: IslandChoice) =>
        departing(() => {
          const g = choice.island
          if (isMapIsland(g) && choice.bytes) {
            void host.keepMap(g.map, choice.bytes).then((kept) => {
              if (!kept) console.warn('editor: the heightmap could not be kept in this browser')
            })
          }
          pendingGround = choice.ground
          groundTrouble = null
          slot = newDraftSlot(randomInt)
          const fresh = newDraft(donor, randomCourseName(randomInt))
          // DEV-888: a seeded island starts WITH its water, at the default level.
          const seeded = { ...fresh, course: { ...fresh.course, ground: g } }
          const floor = waterWorldY(donor, { level: 0 })
          history = createHistory(
            isSeedIsland(g)
              ? setWater(seeded, seededWaterLevel(donor.environment, g, floor))
              : seeded,
          )
          seatFor = history.present
          seatSearch = true
          padPicked = false
          dropPropTools() // DEV-504
          shared = ''
          link = ''
          forgetRecording()
          console.info(`editor: a new island, ${groundKey(g)}`)
          changed()
          seatOpened()
        }),
    }
    islandDialog = mode === 'map' ? openIslandDialog(base) : openSeedDialog({ ...base, randomInt })
  }

  const refreshLibrary = (): void => {
    void host.library().then(
      (entries) => {
        library = entries
        renderPanel()
      },
      () => renderPanel(),
    )
  }

  // ── the loop of an edit ─────────────────────────────────────────────────

  /** Record a command's result (a no-op records nothing) and redraw; `step` runs undo, redo and the like. */
  const { edit: apply, step } = createHistoryLoop<EditorDraft>({
    get: () => history,
    set: (h) => {
      history = h
    },
    changed: () => changed(),
    // DEV-501 follow-up: the note is about the edit before this one
    onMoved: () => {
      padTurnNote = ''
    },
    canEdit: () => !busy,
    canStep: () => !busy && !dragging,
  })

  /** Write the draft to this browser now; false when the browser would not keep it. */
  const autosave = createDebounce(
    () => saveDraft(storage, slot, draft(), Date.now()),
    DESK_POLICY.autosaveMs,
  )
  const saveNow = (): boolean => autosave.flush()

  // ── DEV-569: the way back to the hangar ─────────────────────────────────
  const leaveDialog = createLeaveDialog()
  /**
   * DEV-889: leave this draft for another (a new course or island, a remix, one
   * off the shelf). The draft is kept on the shelf, so nothing is lost unless
   * the shelf is full: then the oldest is pushed off, and that is asked first
   * (`shelfWords`). A draft with nothing in it is not kept: it is dropped, and
   * pushes nothing. `keep` false (opening a draft from the shelf) never asks:
   * the shelf does not grow.
   */
  const departing = (go: () => void, grows = true): void => {
    if (leaveDialog.isOpen()) return
    if (isBlankDraft(draft())) {
      autosave.cancel()
      deleteDraft(storage, slot)
      go()
      return
    }
    saveNow()
    const drop = grows ? draftToDrop(storage) : null
    if (!drop) {
      go()
      return
    }
    lastShelfAsk = shelfLabel(drop, Date.now())
    console.info(`editor: the shelf is full; asking before dropping ${lastShelfAsk}`)
    leaveDialog.open(go, shelfWords(lastShelfAsk, EDITOR_POLICY.maxDrafts))
  }
  /** The label the last shelf question named, for the probe. */
  let lastShelfAsk: string | null = null
  /** How the last Back to hangar went, for the probe: left at once, asked, or left unkept. */
  let lastLeave: 'left' | 'asked' | 'left-unkept' | null = null
  const requestLeave = (): void => {
    if (dragging || leaveDialog.isOpen()) return
    const kept = saveNow()
    if (!leaveAsks(kept)) {
      lastLeave = 'left'
      host.leave()
      return
    }
    lastLeave = 'asked'
    console.info('editor: this browser would not keep the draft; asking before leaving (DEV-569)')
    leaveDialog.open(() => {
      lastLeave = 'left-unkept'
      host.leave()
    })
  }

  /**
   * DEV-475: any ERROR refuses the course: the validator's, and the editor's
   * own that the format cannot see (the pad or a racer's pad in the ground).
   * `WarningSeverity`'s own words: it "cannot be flown or shared as it stands".
   */
  const refused = (): boolean => (evaluation?.warnings ?? []).some((w) => w.severity === 'error')
  /** DEV-478: something is in or near the ground, and there is a ground to lift it clear of. */
  const canLift = (): boolean =>
    ground !== NO_GROUND &&
    course().path.points.length >= 2 &&
    // DEV-501: not for what only the pad can mend (an anchored ring 1 or its straight).
    (evaluation?.warnings ?? []).some((w) => GROUND_WARNING_KINDS.has(w.kind) && !w.anchored)
  // ── DEV-502: the forest follows the line ─────────────────────────────────
  //
  // When an edit SETTLES — a drag's end, an undo or a redo, a click that adds
  // a point, a world arrived — the draft's own clearing (its pad, the island's
  // volumes at its pad and rings, and the capsule chain along its flown line)
  // is masked on the world as drawn (`host.clearLine`): the trees it covers
  // go, colliders and all, and the ones the last line took come back. Not on
  // every drag step: the mask repacks the scatter's buffers, and the forest a
  // drag passes over is not the forest the line will fly through.
  /** The course whose line the world's forest was last cleared for, and on which world. */
  let lineCleared: { readonly world: unknown; readonly id: string } | null = null
  /** The last mask the game reported, for the probe and DEV-502's row. */
  let lineReceipt: LineClearingReceipt | null = null
  const clearLine = (level: Level | null): boolean => {
    if (dragging || busy) return false
    // A course that does not expand keeps the last line's clearing (a point
    // dragged outside the play area is an edit on its way somewhere), unless
    // there is no line at all: a draft of one point clears nothing.
    const none = !level && course().path.points.length < 2
    if (!level && !none) return false
    const world = host.terrains()?.land ?? null
    if (!world) return false
    const id = level ? level.id : '(no line)'
    if (lineCleared && lineCleared.world === world && lineCleared.id === id) return false
    lineCleared = { world, id }
    const r = host.clearLine(level)
    if (r) lineReceipt = r
    return r !== null && r.hidden + r.shown > 0
  }
  // ── end DEV-502 ─────────────────────────────────────────────────────────

  /** DEV-503: the world's live colliding props, in the level frame; null with no world or forest. */
  //
  // With DEV-504's placed props: the world's copy of them (after a Fly) is
  // hidden by the desk, which draws the DRAFT's, so the world's placed
  // colliders are left out and the draft's are built here, as the flight
  // builds a landmark's (`landmarkColliderInputFor`, the hull and the
  // triangles), and asked beside the world's under ids past the world's.
  let draftCols: { key: string; land: unknown; cols: PropColliders | null } | null = null
  const draftPropColliders = (world: PropColliders): PropColliders | null => {
    const land = host.terrains()?.land ?? null
    const placed = course().props ?? []
    if (!land || placed.length === 0) return null
    const { inputs, complete } = deskProps.colliderInputs()
    const key = `${JSON.stringify(placed)}|${inputs.length}|${complete}`
    if (draftCols && draftCols.key === key && draftCols.land === land) return draftCols.cols
    const hf = land.heightField
    const cols =
      inputs.length > 0
        ? buildPropColliders(
            inputs,
            { x: hf.originX, y: hf.originY, z: hf.originZ },
            {
              // Queries read the hash's cell, the world's. Every input here
              // carries a hull and triangles, so `radiusFraction` (read only
              // for a bare cylinder) is never read; the rest are a flier's.
              cellMetres: world.cellMetres,
              radiusFraction: Math.SQRT1_2,
              breakSpeed: 0,
              breakSlowdown: 0,
              bounceRestitution: 0,
              racerStuckSeconds: 0,
            },
          )
        : null
    draftCols = { key, land, cols }
    return cols
  }
  const propsNow = (): Props | null => {
    const world = host.propColliders()
    if (!world) return null
    const own = collidersAsProps(world, new Set(host.placedPropIds()))
    const draft = draftPropColliders(world)
    return draft ? allProps([own, collidersAsProps(draft, new Set(), world.count)]) : own
  }
  /** DEV-503: the last evaluation's wall time, milliseconds, props included. */
  let evaluateMs = 0
  /** DEV-503: the last evaluation ran while a placed prop's mesh was loading. */
  let propsPending = false
  const judge = (): DraftEvaluation | null => {
    const t0 = performance.now()
    // `evaluateDraft` never throws on an unfinished draft; the guard is for a
    // donor that is still the previous sky's while the new one loads.
    try {
      return evaluateDraft(
        draft(),
        donor,
        ground,
        courseSlots(course().start, donor, host.racers()), // DEV-475
        propsNow(), // DEV-503
      )
    } catch (err) {
      console.warn('editor: could not evaluate the draft', err)
      return null
    } finally {
      evaluateMs = performance.now() - t0
    }
  }
  /** The level the next ring rebuild draws: the last one `evaluate` judged. */
  let pendingRingLevel: Level | null = null
  const ringRebuild = createDebounce(
    () => view.setLevel(pendingRingLevel),
    DESK_POLICY.ringRebuildMs,
  )
  const evaluate = (): void => {
    lastEvaluate = performance.now()
    propsPending = deskProps.pending()
    evaluation = judge()
    // DEV-502, then DEV-503: a settled edit moves the forest, and the props it
    // took or gave back are judged as they now stand.
    if (clearLine(evaluation?.level ?? null)) evaluation = judge()
    view.setWarnings(evaluation?.warnings ?? [])
    // DEV-478: what is in the ground, red where it is.
    view.setGroundMarks(groundMarks(evaluation?.warnings ?? [], evaluation?.level ?? null, spline))
    pendingRingLevel = evaluation?.level ?? null
    ringRebuild.schedule()
  }

  const syncGizmo = (): void => {
    // DEV-570: what is picked, and the tool, say the gizmo (`tools.ts`):
    // DEV-504's prop and DEV-475's pad on X and Z or their heading on Y (and a
    // prop's size), a point on all three axes; nothing at all under Select.
    const kind = pickedKind()
    const shown = gizmoFor(kind, tool)
    // Mid-drag the mode stays the drag's: a tool key waits for the release.
    if (!shown || (kind === 'point' && !course().path.points[draft().selection ?? -1])) {
      if (!dragging) gizmo.detach()
      return
    }
    if (!dragging) {
      gizmo.setMode(shown.mode)
      gizmo.showX = shown.x
      gizmo.showY = shown.y
      gizmo.showZ = shown.z
    }
    const prop = kind === 'prop' && propPicked !== null ? course().props?.[propPicked] : undefined
    const at: readonly number[] | undefined =
      kind === 'prop'
        ? prop?.pos
        : kind === 'pad'
          ? course().start.pos
          : course().path.points[draft().selection ?? -1]
    const yaw = kind === 'prop' ? (prop?.yaw ?? 0) : kind === 'pad' ? course().start.yaw : 0
    if (!dragging && at) {
      proxy.position.set(at[0] as number, at[1] as number, at[2] as number)
      const h = (yaw * Math.PI) / 360
      proxy.quaternion.set(0, Math.sin(h), 0, Math.cos(h))
      proxy.scale.setScalar(kind === 'prop' ? (prop?.scale ?? 1) : 1)
    }
    if (gizmo.object !== proxy) gizmo.attach(proxy)
  }

  /**
   * DEV-504: the draft's props, drawn: the expansion's own landmarks
   * (`playerCourseProps`), over the world's land. Only over the island they
   * were placed on; a sky still loading draws none.
   */
  const syncProps = (): void => {
    const c = course()
    const landmarks = c.props && donor.environment === c.island ? playerCourseProps(c, donor) : []
    deskProps.set(landmarks, host.terrains(), propPicked)
  }

  /** Everything that follows a change of the draft. */
  const changed = (): void => {
    const c = course()
    try {
      spline = c.path.points.length >= 2 ? playerCourseSpline(c) : null
    } catch {
      spline = null
    }
    view.setCourse(c, spline, draft().selection)
    finishMarker.set(spline, c.finish.t, finishRadiusOf(donor)) // DEV-473
    startPad.set(c.start, donor, host.racers(), padPicked) // DEV-475
    // DEV-504: an undo can take the picked prop away.
    if (propPicked !== null && !c.props?.[propPicked]) propPicked = null
    syncProps()
    // DEV-486: the run-in, drawn from the ship on its pad to point 1.
    const runIn = donor.environment === c.island ? runInOf(c, donor) : null
    view.setRunIn(
      runIn ? [runIn.from.x, runIn.from.y, runIn.from.z] : null,
      runIn ? [runIn.to.x, runIn.to.y, runIn.to.z] : null,
    )
    syncGizmo()
    syncGround() // DEV-500: a water level moved moves the ground the checks read
    pushWater() // DEV-500
    // A drag evaluates at a gentler rate; everything else at once.
    if (!dragging || performance.now() - lastEvaluate >= DESK_POLICY.dragEvaluateMs) evaluate()
    autosave.schedule()
    syncSky()
    pushLight(!lightSliding) // DEV-476
    renderPanel()
  }

  /** DEV-486: the run-in fix's label: what pressing it will do. */
  const runInFixLabel = (): string =>
    runInFixOf(draft(), donor) === 'aim' ? 'Aim the pad at point 1' : 'Move the pad behind point 1'

  /** The top-down state the panel last drew (DEV-472 follow-up: a fly can leave top-down). */
  let panelTopDown = false
  const renderPanel = (): void => {
    panelTopDown = cam.topDown
    const d = draft()
    const c = d.course
    const i = d.selection
    const p = i === null ? null : c.path.points[i]
    const level = evaluation?.level ?? null
    const lap = authorLapOf(d)
    panel.render({
      name: `${c.name[0]} ${c.name[1]}`,
      // DEV-499: the place's own name, as the Base picker and the level select say it.
      island: isMapIsland(c.ground)
        ? `${environmentDisplayName(c.island)} colours, an imported map`
        : c.ground
          ? `${environmentDisplayName(c.island)} colours, seed ${c.ground.seed}`
          : environmentDisplayName(c.island),
      islandTrouble:
        groundTrouble && groundTrouble.key === groundKey(c.ground) ? groundTrouble.why : '',
      islandLost: !!groundTrouble?.lost && groundTrouble.key === groundKey(c.ground), // DEV-499
      sky: c.sky,
      skies,
      gap: c.path.gap,
      timeLimit: c.timeLimit,
      // DEV-473: the new point's height and the selected one's, apart.
      placeHeight,
      selectedHeight: p ? heightAboveGround(p) : null,
      padYaw: c.start.yaw,
      padPicked,
      padRotate: padAiming(),
      // DEV-570
      tool,
      toolNote: toolNote(pickedKind(), tool),
      finish: c.finish.t,
      // DEV-476: the light as it will fly.
      // DEV-500
      water: (() => {
        const floor = waterWorldY(donor, { level: 0 })
        const top = waterCeiling(c.island, c.ground ?? null) ?? 0
        const own = ownSeaWater()
        return {
          // DEV-876: a base's own sea is water the course already has.
          y: c.water ? waterWorldY(donor, c.water) : own ? waterWorldY(donor, own) : null,
          own: own !== null,
          min: floor,
          max: floor + top,
        }
      })(),
      light: (() => {
        const l = lightShown()
        return {
          azimuth: l.sunAzimuth,
          elevation: l.sunElevation,
          tint: [l.tint[0], l.tint[1], l.tint[2]] as const,
          tintAmount: l.tintAmount,
          own: c.light !== undefined,
          held: lightHeld,
          busy,
        }
      })(),
      // DEV-504: the library, the base's island first, and the picked prop.
      props: (() => {
        const picked = propPicked === null ? undefined : c.props?.[propPicked]
        const entry = picked ? propEntry(picked.kind) : null
        const R = PLAYER_COURSE_LIMITS.propScaleRatio
        const d = entry?.scale.default ?? 1
        return {
          groups: propGroups(c.island).map((g) => ({
            place: environmentDisplayName(g.place),
            entries: g.entries.map((e) => ({ id: e.id, name: e.name })),
          })),
          placing: propPlacing,
          picked:
            picked && propPicked !== null
              ? {
                  index: propPicked,
                  name: entry?.name ?? picked.kind,
                  yaw: picked.yaw,
                  scale: picked.scale,
                  min: Math.ceil(d * R.min * 100) / 100,
                  max: Math.floor(d * R.max * 100) / 100,
                  spinning: propSpinning(),
                }
              : null,
          count: c.props?.length ?? 0,
          max: PLAYER_COURSE_LIMITS.props.max,
          linkMax: PLAYER_COURSE_WIRE.linkMaxProps, // DEV-533
          busy,
        }
      })(),
      lineLength: spline && spline.length > 0 ? spline.length : null,
      selection: i,
      points: c.path.points.length,
      rings: level ? liveRings(level).length : null,
      courseId: evaluation?.courseId ?? null,
      authorLap: lap ? lap.seconds : null,
      remixedFrom: d.remixedFrom,
      canUndo: canUndo(history),
      canRedo: canRedo(history),
      canFly: level !== null && !refused(), // DEV-475: an error refuses, not only the validator
      // DEV-478: why it refuses, said beside the refused buttons, and the fix.
      refusal: (evaluation?.warnings ?? [])
        .filter((w) => w.severity === 'error')
        .map((w) => w.message),
      canLift: canLift(),
      anchored: c.path.anchor !== undefined, // DEV-501
      topDown: cam.topDown,
      busy,
      library: library.map((e) => ({ id: e.id, name: `${e.name} · ${e.island}` })),
      drafts: shelfOf(storage, slot).map((d) => ({
        slot: d.slot,
        label: shelfLabel(d, Date.now()),
      })),
      shared,
      link,
      // DEV-491: a recording leaves from the pad, on the sky's lift.
      canRecord: padSizeOf(donor) !== null,
      recordNote,
      padTurnNote, // DEV-501 follow-up
      warnings: (evaluation?.warnings ?? []).map((w) => ({
        severity: w.severity,
        message: w.message,
        // DEV-486: the fix beside a too-sharp run-in, named for what it will do.
        ...(w.kind === 'run-in-turn' && ground !== NO_GROUND ? { fix: runInFixLabel() } : {}),
        // DEV-889: and a button on the run-out note.
        ...(w.kind === 'finish-no-runoff'
          ? { fix: 'Extend run-out', fixKind: 'runout' as const }
          : {}),
      })),
    })
  }

  // ── sky, world and ground ───────────────────────────────────────────────

  /** The island the camera last framed: a world swap to another one frames again. */
  let framedIsland = ''
  const frameArea = (): void => {
    const area = playerCourseArea(donor)
    if (area) cam.frame(area)
    framedIsland = `${donor.environment}|${worldKey}`
  }

  /**
   * DEV-490: which island the world now standing IS, read off the level the
   * game built — not the one the desk last asked for, which a switch the game
   * refused (one already under way) never built.
   */
  const worldArrived = (): void => {
    worldKey = customGroundOf(host.level())?.key ?? ''
    worldWater = courseWaterOf(host.level()) !== null // DEV-500
    if (pendingGround?.key === worldKey) pendingGround = null
  }

  /** The draft's sky is not the world's: load it and ask the game for its world. */
  const syncSky = (): void => {
    const want = course().sky
    // DEV-490: and the draft's own island, when it has one.
    const wantKey = groundKey(course().ground)
    // DEV-500: and water on or off (a level moved is previewed, not rebuilt).
    // DEV-876: on a base with a sea of its own the world has water either way:
    // a level is previewed (`pushWater`) and the next world is built at it.
    const wantWater = ownSeaWater() !== null ? worldWater : course().water !== undefined
    if (busy || (want === donor.id && wantKey === worldKey && wantWater === worldWater)) return
    if (wantKey !== '' && groundTrouble?.key === wantKey) return
    busy = true
    renderPanel()
    const c = course()
    void (async () => {
      const sky = want === donor.id ? donor : await loadLevel(want)
      let built: CustomGround | null = null
      if (wantKey !== '') {
        built = pendingGround?.key === wantKey ? pendingGround : await host.groundOf(c)
      }
      // Kept until the world has it (`worldArrived`): a switch the game
      // refuses (one already under way) is asked again without rebuilding.
      pendingGround = built
      const next = withCourseWater(withCustomGround(sky, built), c.water ?? null)
      donor = next
      worldKey = wantKey
      worldWater = wantWater
      placeHeight = placeHeightFor(next)
      host.showWorld(next)
    })().catch((err: unknown) => {
      console.warn(`editor: the world for ${want} could not be built`, err)
      if (wantKey !== '') {
        const why = (err as { errors?: readonly (readonly [string, string])[] }).errors?.[0]?.[1]
        groundTrouble = {
          key: wantKey,
          // DEV-499: a map this browser does not have can be opened again, or replaced.
          lost: isMapIsland(c.ground),
          why: `This course's island could not be built: ${
            why ?? 'its heightmap is not in this browser'
          }. ${LOST_MAP_HINT}`,
        }
      }
      busy = false
      renderPanel()
    })
  }

  /** Rebuild the ground when the world under it is a new one. */
  const syncGround = (): boolean => {
    const t = host.terrains()
    const key = t?.land ?? null
    // DEV-500: the course's water is the sea the checks stand on.
    const w = course().water
    const water = w ? waterWorldY(donor, w) : null
    if (key === groundOf && water === groundWater) return false
    groundOf = key
    groundWater = water
    ground = t ? deskGround(t, water) : NO_GROUND
    return true
  }

  // ── pointer and keys ────────────────────────────────────────────────────

  const _v = new THREE.Vector3()
  const screenOf = (x: number, y: number, z: number): ScreenPoint | null => {
    const rect = host.canvas.getBoundingClientRect()
    _v.set(x, y, z).project(cam.camera)
    if (_v.z > 1 || _v.z < -1) return null
    return {
      x: rect.left + ((_v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - _v.y) / 2) * rect.height,
    }
  }

  const raycaster = new THREE.Raycaster()
  const terrainHit = (clientX: number, clientY: number): THREE.Vector3 | null => {
    const t = host.terrains()
    if (!t) return null
    const rect = host.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    raycaster.setFromCamera(ndc, cam.camera)
    // The rendered CHUNKS: each terrain group's own meshes, not what hangs
    // under it (the dressing's instanced boulders, the fracture pieces).
    const chunks: THREE.Object3D[] = []
    for (const terrain of [t.land, t.ocean]) {
      if (!terrain) continue
      for (const child of terrain.group.children) {
        const mesh = child as THREE.Mesh
        if (
          mesh.isMesh &&
          !(mesh as unknown as THREE.InstancedMesh).isInstancedMesh &&
          mesh.visible
        ) {
          chunks.push(mesh)
        }
      }
    }
    const hit = raycaster.intersectObjects(chunks, false)[0]
    const landPoint = hit ? hit.point.clone() : null
    // DEV-339: with the sea drawn as camera-centred rings the plate's chunks are
    // not in the group, so a ray over open water meets no mesh and a click on the
    // sea did nothing. The rings are a flat sea to the eye, so the ray meets the
    // sea's resting plane instead, and whichever of the land and the plane it
    // reaches first is the ground. Callers read the height from `ground`.
    const ocean = t.ocean
    if (!ocean?.rings?.on) return landPoint
    const rest = new THREE.Vector3(
      ocean.group.position.x,
      Number.isFinite(ocean.restY) ? ocean.restY : ocean.group.position.y,
      ocean.group.position.z,
    )
    ocean.group.parent?.updateWorldMatrix(true, false)
    ocean.group.parent?.localToWorld(rest)
    const seaY = rest.y
    return groundHit(raycaster.ray, landPoint, seaY)
  }

  const click = (e: PointerEvent): void => {
    const d = draft()
    const c = d.course
    const x = e.clientX
    const y = e.clientY
    // Shift: a ring — drawn, or skipped — is skipped or put back.
    if (e.shiftKey && spline) {
      const L = spline.length
      const placed = evaluation?.level ? liveRings(evaluation.level).map((r) => r.pos) : []
      const skipped = c.rings.map((r) => {
        const q = splinePointAt(spline as CourseSpline, r.t * L)
        return [q.x, q.y, q.z] as Vec3Tuple
      })
      const all = [...placed, ...skipped]
      const hit = nearestWithin(
        all.map((p) => screenOf(p[0], p[1], p[2])),
        x,
        y,
        DESK_POLICY.pickPixels * 2,
      )
      if (hit !== null) {
        const p = all[hit] as Vec3Tuple
        const t =
          hit < placed.length
            ? nearestArc(spline, { x: p[0], y: p[1], z: p[2] }) / L
            : (c.rings[hit - placed.length]?.t ?? 0)
        apply(toggleRingSkip(d, t))
      }
      return
    }
    // DEV-504: placing — a click on a prop picks it; anywhere on the ground drops one.
    if (propPlacing !== null) {
      const onProp = propHit(x, y)
      if (onProp !== null) {
        pickProp(onProp)
        return
      }
      const at = terrainHit(x, y)
      if (at) placeProp(propPlacing, at)
      return
    }
    // A handle.
    const handle = nearestWithin(
      c.path.points.map((p) => screenOf(p[0], p[1], p[2])),
      x,
      y,
      DESK_POLICY.pickPixels,
    )
    if (handle !== null) {
      // DEV-501: the anchored point is the pad's: a click on it picks the PAD,
      // so a drag from there moves the pad and the ring comes with it.
      if (isAnchoredPoint(c, handle)) {
        pickPad(true)
        return
      }
      padPicked = false
      propPicked = null // DEV-504: the gizmo is the point's now
      apply(select(d, handle))
      return
    }
    // DEV-475: the start pad's handle.
    const pad = c.start.pos
    const onPad = nearestWithin(
      [screenOf(pad[0], pad[1], pad[2])],
      x,
      y,
      DESK_POLICY.pickPixels * START_PAD_POLICY.handleHandles,
    )
    if (onPad !== null) {
      pickPad(true)
      return
    }
    padPicked = false
    // DEV-504: a placed prop, by a ray at what is drawn.
    const onProp = propHit(x, y)
    if (onProp !== null) {
      pickProp(onProp)
      return
    }
    propPicked = null
    // The line: insert a point on it.
    if (spline) {
      const s = spline
      const on = nearestOnPolyline(
        s.samples.map((p) => screenOf(p.x, p.y, p.z)),
        x,
        y,
        DESK_POLICY.linePixels,
      )
      if (on) {
        const a = s.arc[on.segment] as number
        const b = s.arc[on.segment + 1] as number
        apply(insertPointOnPath(d, (a + (b - a) * on.u) / s.length))
        return
      }
    }
    // The ground: a new point at the end of the line, at the set height above
    // what you can SEE there.
    const hit = terrainHit(x, y)
    if (hit) {
      const g = ground.surfaceAt(hit.x, hit.z)
      const base = Number.isFinite(g) ? g : hit.y
      apply(addPoint(d, [hit.x, base + placeHeight, hit.z]))
      return
    }
    apply(select(d, null))
  }

  let down: { x: number; y: number; onGizmo: boolean } | null = null
  const onPointerDown = (e: PointerEvent): void => {
    if (!active || e.button !== 0) return
    down = { x: e.clientX, y: e.clientY, onGizmo: gizmo.axis !== null }
  }
  const onPointerUp = (e: PointerEvent): void => {
    const d = down
    down = null
    if (!active || busy || !d || e.button !== 0 || d.onGizmo || dragging) return
    // DEV-472: Alt+left is Maya's orbit, a camera gesture: never a tool's click.
    if (e.altKey) return
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > DESK_POLICY.clickSlopPixels) return
    click(e)
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!active) return
    const target = e.target as HTMLElement | null
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return
    // DEV-569: the leave question holds the keys while it is up.
    if (leaveDialog.isOpen()) return
    const action = deskKeyAction(e)
    if (!action) return
    // DEV-570: while the right button flies the eye, W, A, Q and E are the
    // fly's (`camera.ts` reads them by place), so no tool key acts then.
    if (cam.flying && (action === 'frame-all' || action.startsWith('tool-'))) return
    e.preventDefault()
    // DEV-472: while the gizmo holds a drag, the drag is the only thing going on.
    if (dragging) return
    if (action === 'frame-all') {
      frameArea() // DEV-570: Maya's A
      return
    }
    if (action === 'frame') {
      const i = draft().selection
      const prop = propPicked === null ? undefined : course().props?.[propPicked] // DEV-504
      const p = prop
        ? prop.pos
        : padPicked
          ? course().start.pos
          : i === null
            ? null
            : course().path.points[i]
      if (p) cam.focus(new THREE.Vector3(p[0], p[1], p[2]))
      else frameArea()
      return
    }
    if (action === 'undo') step(undo)
    else if (action === 'redo') step(redo)
    else if (action === 'delete') {
      const i = draft().selection
      if (propPicked !== null)
        removeProp() // DEV-504
      else if (i !== null) apply(deletePoint(draft(), i))
    } else if (action === 'deselect') {
      // DEV-504: Esc stops placing first, then puts a picked prop down.
      if (propPlacing !== null) {
        propPlacing = null
        renderPanel()
      } else if (propPicked !== null) pickProp(null)
      else if (padPicked) pickPad(false)
      else apply(select(draft(), null))
    } else if (action === 'tool-select') setTool('select')
    else if (action === 'tool-move') setTool('move')
    else if (action === 'tool-rotate') setTool('rotate')
    else if (action === 'tool-scale') setTool('scale')
    else if (action === 'top-down') {
      cam.setTopDown(!cam.topDown)
      renderPanel()
    }
  }
  host.canvas.addEventListener('pointerdown', onPointerDown)
  host.canvas.addEventListener('pointerup', onPointerUp)
  globalThis.addEventListener('keydown', onKeyDown)

  // ── fly ─────────────────────────────────────────────────────────────────

  /** DEV-475: `fromT` null flies the full lap from the start pad. */
  const fly = (fromT: number | null): void => {
    if (busy || dragging || refused()) return
    const request = playtestRequest(draft(), donor, fromT)
    if (!request) return
    saveNow()
    busy = true
    renderPanel()
    host.fly(request)
  }

  // ── DEV-491: fly-to-author ──────────────────────────────────────────────
  //
  // *Record a flight* flies free from the draft's pad (`recordingLevel`: Free
  // Flight, no rings, the sky's boundary); in flight R starts and stops the
  // recording, and the game hands the recorder's lap doc back through
  // `recorded`. Here it becomes the line: fitted (`fitFlight`), then applied
  // as ONE command (`applyFit`), so one undo takes the whole recording back.

  /** Leave for a recording flight from the pad. */
  const startRecording = (): void => {
    if (busy || dragging) return
    const level = recordingLevel(course(), donor)
    if (!level) {
      recordNote = 'This base has no lift to fly from.'
      renderPanel()
      return
    }
    saveNow()
    busy = true
    recordNote = ''
    renderPanel()
    host.record(level)
  }

  /** The recording, as the line. Called with the desk active again. */
  const takeRecording = (recorded: DeskRecordedFlight | null): void => {
    if (!recorded) {
      recordNote = 'Nothing was recorded: in flight, press R to start and R again to stop.'
      return
    }
    const flight = flightOfClip(decodeGhostClip(recorded.doc), recorded.worldOffset)
    let metres = 0
    for (let i = 1; i < flight.points.length; i++) {
      const a = flight.points[i - 1] as Vec3Tuple
      const b = flight.points[i] as Vec3Tuple
      metres += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    }
    recordingLine.set(flight.points)
    const fit = fitFlight(flight.points)
    if (!fit || fit.points.length < 2) {
      lastRecording = null
      recordNote = `Too short to make a line (${formatDistance(metres)}): fly further before pressing R again.`
      return
    }
    apply(applyFit(draft(), fit, donor, ground === NO_GROUND ? null : ground, flight.seconds))
    lastRecording = {
      seconds: flight.seconds,
      metres,
      samples: flight.points.length,
      points: fit.points.length,
      error: fit.error,
      tolerance: fit.tolerance,
      within: fit.withinTolerance,
    }
    recordNote =
      `Recorded ${flight.seconds.toFixed(1)} s over ${formatDistance(metres)}: ` +
      `${fit.points.length} points, the line within ${fit.error.toFixed(1)} m of the flight` +
      (fit.withinTolerance ? '.' : ' (too winding to fit closer in the points a course may have).')
    console.info(
      `editor: recorded ${flight.seconds.toFixed(1)} s, ${Math.round(metres)} m, ${flight.points.length} poses ` +
        `-> ${fit.points.length} points within ${fit.error.toFixed(2)} m ` +
        `(tolerance ${fit.tolerance.toFixed(2)} m${fit.withinTolerance ? '' : ', widened'}) (DEV-491)`,
    )
  }
  // ── end DEV-491 ─────────────────────────────────────────────────────────

  // ── start ───────────────────────────────────────────────────────────────

  const setActive = (on: boolean): void => {
    active = on
    if (!on) leaveDialog.close() // DEV-569
    panel.setVisible(on)
    cam.controls.enabled = on && !dragging
    gizmo.enabled = on
    view.root.visible = on
  }

  frameArea()
  syncGround()
  seatFor = history.present // DEV-475
  seatSearch = !stored
  changed()
  seatOpened()
  refreshLibrary()
  // DEV-540: "Shipped missions (dev)" at the panel's foot — `pnpm dev` only.
  // A production build folds `import.meta.env.DEV` to false and drops this
  // import with its chunk (`tests/unit/editor-shipped-door.test.ts`).
  if (import.meta.env.DEV) {
    void import('./shipped-door')
      .then((m) => m.mountShippedDoor(panel.devSlot, saveNow))
      .catch((err: unknown) => console.warn('editor: the shipped-mission list did not load', err))
  }
  // The island's skies, for the panel. The draft's own sky first, so the
  // control never shows a value it does not list while the rest load.
  void allSkies().then(
    (found) => {
      skies = found.map((f) => f.sky)
      for (const f of found) skyIslands.set(f.level.id, f.level)
      if (!skies.some((k) => k.id === course().sky)) {
        skies = [{ id: course().sky, title: course().sky }, ...skies]
      }
      renderPanel()
    },
    (err: unknown) => console.warn('editor: the skies did not load', err),
  )
  console.info(
    `editor: ${stored ? `draft ${slot} reopened` : 'a new draft'} over ${course().sky} ` +
      `(${course().path.points.length} points)`,
  )

  return {
    frame(seconds) {
      if (view.root.parent !== host.scene) host.scene.add(view.root)
      // DEV-503: a placed prop whose mesh was still loading when the draft was
      // last judged has no collider in it; judge again once the mesh is in.
      if (propsPending && !deskProps.pending()) {
        propsPending = false
        evaluate()
        renderPanel()
      }
      if (syncGround()) {
        evaluate()
        renderPanel()
        seatOpened() // DEV-475
        pushLight(true) // DEV-476: a new world is lit by the course's sun
        // DEV-504: the draft's props over the new land, and never the world's
        // own copy of them beside (a Fly's world is the course's).
        syncProps()
        deskProps.hideWorldCopies(host.terrains())
      }
      // DEV-504: and if the world's forest arrives after its ground did.
      const land = host.terrains()?.land.group ?? null
      const kids = land ? land.children.length : -1
      if (kids !== landKids) {
        landKids = kids
        deskProps.hideWorldCopies(host.terrains())
      }
      // DEV-472 follow-up: the fly moves the eye by the frame's time, and a
      // fly begun top-down leaves it, which the panel's button has to say.
      const wasTopDown = cam.topDown
      cam.update(seconds)
      if (cam.topDown !== wasTopDown || cam.topDown !== panelTopDown) renderPanel()
      view.update(cam.camera)
      return cam.camera
    },
    suspend() {
      setActive(false)
    },
    resume(result: PlaytestResult | null) {
      busy = false
      worldArrived() // DEV-490
      if (result) {
        const next = onReturn(draft(), result)
        if (next !== draft()) {
          history = withAuthorLap(history, next.authorLap)
          console.info(`editor: author lap ${next.authorLap?.seconds.toFixed(2)} s recorded`)
        }
      }
      setActive(true)
      if (`${donor.environment}|${worldKey}` !== framedIsland) frameArea()
      syncGround()
      changed()
      seatOpened() // DEV-490: a new island's pad, once its world is here
      refreshLibrary()
      // DEV-504: back from a Fly the world is the course's, its props and all;
      // the desk draws the draft's, so the world's copy goes.
      deskProps.hideWorldCopies(host.terrains())
    },
    // DEV-491: back from a recording flight, with what it recorded.
    recorded(flight: DeskRecordedFlight | null) {
      busy = false
      worldArrived() // DEV-490
      setActive(true)
      if (`${donor.environment}|${worldKey}` !== framedIsland) frameArea()
      syncGround()
      takeRecording(flight)
      changed()
      refreshLibrary()
      deskProps.hideWorldCopies(host.terrains()) // DEV-504
    },
    probe() {
      const d = draft()
      const c = d.course
      const lap = authorLapOf(d)
      return {
        active,
        busy,
        slot,
        sky: c.sky,
        island: c.island,
        // DEV-490: the draft's own island, and the one the world was built on.
        ground: groundKey(c.ground),
        worldGround: worldKey,
        pad: [...c.start.pos],
        courseId: evaluation?.courseId ?? null,
        valid: evaluation?.level !== null && evaluation !== null && !refused(),
        points: c.path.points.map((p) => [p[0], p[1], p[2]]),
        anchored: c.path.anchor !== undefined, // DEV-501
        padTurnNote, // DEV-501 follow-up
        selection: d.selection,
        gap: c.path.gap,
        rings: evaluation?.level ? liveRings(evaluation.level).length : null,
        drawnRings: view.rings()?.count ?? 0,
        warnings: (evaluation?.warnings ?? []).map((w) => w.kind),
        // DEV-503: the prop warnings with their markers, and the last evaluation's cost.
        propWarnings: (evaluation?.warnings ?? [])
          .filter((w) => w.kind === 'line-through-prop' || w.kind === 'ring-in-prop')
          .map((w) => ({
            kind: w.kind,
            severity: w.severity,
            message: w.message,
            ring: w.ring ?? null,
            props: (w.props ?? []).map((p) => [...p]),
          })),
        evaluateMs,
        // DEV-503: the world's colliding landmarks (a hull or triangles: the
        // spires), level frame: where each stands, its top and its reach.
        landmarks: (() => {
          const c = host.propColliders()
          if (!c) return []
          const out: { at: number[]; top: number; radius: number; kind: string }[] = []
          for (let id = 0; id < c.count; id++) {
            if (!c.hulls.has(id) && !c.meshes.has(id)) continue
            out.push({
              at: [c.x[id] as number, c.bottom[id] as number, -(c.z[id] as number)],
              top: c.top[id] as number,
              radius: c.radius[id] as number,
              kind: c.kind[id] as string,
            })
          }
          return out
        })(),
        // DEV-502: the last clearing of the draft's line on the world's forest.
        lineClearing: lineReceipt ? { ...lineReceipt } : null,
        // DEV-478: the errors that refuse the course, by kind, and whether Lift can act.
        errors: (evaluation?.warnings ?? [])
          .filter((w) => w.severity === 'error')
          .map((w) => w.kind),
        canLift: canLift(),
        // DEV-486: the run-in as drawn, and the fix its warning offers.
        runIn: view.runIn(),
        runInFix: runInFixOf(d, donor),
        authorLap: lap ? lap.seconds : null,
        canUndo: canUndo(history),
        canRedo: canRedo(history),
        topDown: cam.topDown,
        camera: {
          position: cam.camera.position.toArray(),
          target: cam.controls.target.toArray(),
          // DEV-472: the orbit's distance and the depth range it set.
          distance: cam.camera.position.distanceTo(cam.controls.target),
          near: cam.camera.near,
          far: cam.camera.far,
          // DEV-472 follow-up: the fly, and where the eye looks.
          flying: cam.flying,
          flyScale: cam.flyScale,
          direction: viewOf(cam.camera.quaternion).toArray(),
        },
        gizmo: { attached: gizmo.object !== undefined, axis: gizmo.axis, dragging },
        placeHeight,
        groundReady: ground !== NO_GROUND,
        remixedFrom: d.remixedFrom,
        library: library.map((e) => e.id),
        link,
        // DEV-473: the finish as the draft holds it, and as each of the two
        // things that draw it has it — the hoop (at once) and the game's gate
        // (with the rebuilt rings).
        finish: c.finish.t,
        finishMarker: finishMarker.position(),
        finishGate: view.rings()?.finish?.frame.position.toArray() ?? null,
        lineLength: spline?.length ?? null,
        undoDepth: history.past.length,
        // DEV-475: the pad as the draft holds it, and as the desk draws it.
        start: { pos: [...c.start.pos], yaw: c.start.yaw },
        // DEV-476: the course's light as stored, and as it will fly.
        light: c.light ? { ...c.light, tint: [...c.light.tint] } : null,
        lightShown: (() => {
          const l = lightShown()
          return { azimuth: l.sunAzimuth, elevation: l.sunElevation }
        })(),
        lightHeld,
        padPicked,
        padRotate: padAiming(),
        gizmoMode: gizmo.mode,
        // DEV-570: Maya's tool, the axes the gizmo shows, and the last way out.
        tool,
        gizmoAxes: { x: gizmo.showX, y: gizmo.showY, z: gizmo.showZ },
        leave: lastLeave,
        leaveAsking: leaveDialog.isOpen(),
        pads: startPad.pads(),
        padDressed: startPad.dressed(),
        startArrow: startPad.arrow(),
        padSeat: seatY(c.start.pos[0], c.start.pos[2]),
        // Where the expanded level holds the ship: the racing line's first point.
        spawn: evaluation?.level ? [...evaluation.level.spawn.pos] : null,
        slots: courseSlots(c.start, donor, host.racers()).map((r) => ({
          kind: r.start.from.kind,
          pos: [...r.start.pos],
          foot: [...r.foot],
        })),
        // DEV-491: the last recording's numbers, and what the panel said.
        recording: lastRecording ? { ...lastRecording } : null,
        recordNote,
        // DEV-504: the placed props as the draft holds them, and what the desk does with them.
        props: (c.props ?? []).map((p) => ({
          kind: p.kind,
          pos: [p.pos[0], p.pos[1], p.pos[2]] as [number, number, number],
          yaw: p.yaw,
          scale: p.scale,
        })),
        propsDrawn: deskProps.drawn(),
        propPicked,
        propPlacing,
        propSpin: propSpinning(),
        propSink: host.propLook().sink,
      }
    },
    debug: {
      screenOf: (x, y, z) => screenOf(x, y, z),
      ringGeometry: () => ringGeometryOf(view.rings()),
      lineSamples: () => view.lineSamples(),
      // DEV-478: the red loops and stretches as drawn, and the ground under a point.
      groundMarks: () => view.groundMarks(),
      groundAt: (x, z) => ground.surfaceAt(x, z),
      recordedFlight: () => recordingLine.points(), // DEV-491
      // DEV-503: what the prop warnings cost, measured here where they run:
      // the draft judged `runs` times with the world's props and without,
      // the median of each, milliseconds.
      propsNear: (a, b, reach) =>
        propsNow()
          ?.near(a, b, reach)
          .map((h) => ({ ...h })) ?? null,
      evaluateCost: (runs) => {
        const slots = courseSlots(course().start, donor, host.racers())
        const props = propsNow()
        const median = (withProps: boolean): number => {
          const t: number[] = []
          for (let k = 0; k < Math.max(1, runs); k++) {
            const t0 = performance.now()
            evaluateDraft(draft(), donor, ground, slots, withProps ? props : null)
            t.push(performance.now() - t0)
          }
          t.sort((a, b) => a - b)
          return t[t.length >> 1] as number
        }
        return { withProps: median(true), withoutProps: median(false), props: props !== null }
      },
      // DEV-504: where the desk draws prop `i` (its world matrix, column-major),
      // and its box when picked; the flight's copy is read off the world.
      propMatrix: (i) => deskProps.drawnMatrix(i)?.toArray() ?? null,
      propBase: (i) => {
        const p = course().props?.[i]
        const entry = p ? propEntry(p.kind) : null
        if (!p || !entry) return null
        const landmark = placedLandmark(p, entry, propFrameOf(course(), donor), i)
        const radius = deskProps.footprint(landmark, { x: p.pos[0], z: p.pos[2] }, host.terrains())
        return radius === null ? null : { radius, seat: seatProp(p) }
      },
      propBox: () => {
        const b = deskProps.pickedBox()
        return b ? { min: b.min.toArray(), max: b.max.toArray() } : null
      },
      ...gizmoDebug(screenOf),
    },
  }
}
