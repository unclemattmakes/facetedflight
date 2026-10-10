// src/editor/bench/index.ts — the VR bench: the course editor's headset front
// end. DEV-492 (EDITOR.md §1 and §5.3, "On the bench (headset)").
//
// Matt's 2016 experiment, live spline editing in VR, done where 2016 already
// put its islands: on a table. The hangar's diorama (`render/diorama.ts`), the
// same island off the same height field, enlarged to ~1:2000 on a two-metre
// table in front of the seat. Seated and stationary: nothing moves under you,
// and everything is within an arm or a laser.
//
//   TRIGGER on the island     adds a point at the placement height over the
//                             RENDER surface (the desk's `placeHeightFor`)
//   TRIGGER on the line       inserts a point there (`insertPointOnPath`)
//   TRIGGER on a handle       selects it
//   GRIP near a handle        grabs it (the nearest within reach of the hand,
//                             else the one the ray is on) and drags it with
//                             the hand: across the island, or up and down
//   GRIP on the pad           drags the start pad across the ground
//   STICK CLICK               deletes the selected point
//   A / X, B / Y              undo, redo
//   the PLATE                 UNDO · REDO · DELETE · LIFT · FLY · LEAVE (LIFT is
//                             the desk's LIFT CLEAR OF THE GROUND, the core's
//                             `liftClear`, one undo step)
//
// ── One core, two front ends ─────────────────────────────────────────────
//
// Everything that edits is `src/editor/core/`: the commands, the history (one
// drag is one undo, by the core's coalescing), the warnings, the playtest
// contract. The draft is stored exactly where and how the desktop stores it
// (`core/drafts.ts`, `localStorage`), so a line started on the bench opens on
// the desk and the other way round. What the bench adds is only the hand.
//
// ── The ground ───────────────────────────────────────────────────────────
//
// A point stands at the placement height over what you SEE, the render
// surface, never the height field (CLAUDE.md: they differ by up to 21.8 m on
// steep ground). That surface exists only where the game has BUILT the
// island: the world behind the room is the last mission's. So when it is the
// draft's island the bench judges and places over it (`editor/desk/ground.ts`,
// the desk's own), and otherwise over the drawn field, and says so on the
// plate and in the probe (`ground: 'field'`). After a first flight from the
// bench the world IS the draft's island, and the render surface takes over.
//
// ── Saving ───────────────────────────────────────────────────────────────
//
// The draft autosaves as the desk's does. A FILE and a LINK need the
// desktop's dialogs and clipboard, so the plate says "save on the desktop"
// rather than opening a dialog inside a headset.

import * as THREE from 'three'
import { type CourseSpline, splineTangentAt } from '@/content/course-spline'
import { paletteFor } from '@/content/holo-palette'
import { type Level, liveRings, type Vec3Tuple } from '@/content/level-schema'
import { playerCourseSpline, randomCourseName } from '@/content/player-course'
import {
  addPoint,
  canRedo,
  canUndo,
  createDebounce,
  createHistory,
  createHistoryLoop,
  type DraftEvaluation,
  deletePoint,
  depth,
  type EditorDraft,
  evaluateDraft,
  GROUND_WARNING_KINDS,
  type Ground,
  type History,
  insertPointOnPath,
  isAnchoredPoint,
  liftClear,
  listDrafts,
  loadDraft,
  movePad,
  movePoint,
  newDraft,
  newDraftSlot,
  onReturn,
  playtestRequest,
  randomInt,
  record,
  redo,
  runInOf,
  saveDraft,
  seal,
  select,
  undo,
  withAuthorLap,
} from '@/editor/core'
import { deskGround } from '@/editor/desk/ground'
import { groundMarks } from '@/editor/desk/ground-marks'
import { placeHeightFor } from '@/editor/desk/policy'
import { courseSlots } from '@/editor/desk/slots'
import { missionField, missionSeaLevel } from '@/game/mission-shape'
import { safeLocalStorage } from '@/game/storage'
import { customGroundOf } from '@/game/terrain/custom-ground'
import { createDiorama, type Diorama } from '@/render/diorama'
import type { HeightField } from '@/sim/terrain/height-field'
import { terrainHeightAt } from '@/sim/terrain/height-field'
import {
  type BenchFrame,
  dragTo,
  drawnHeightAt,
  pickLine,
  pickPoint,
  rayOntoIsland,
  toBench,
  toWorld,
} from './frame'
import type { Bench, BenchBeam, BenchHand, BenchHost, BenchProbe } from './host'
import { BENCH_CELLS, type BenchCell, createBenchPlate } from './plate'
import { BENCH_POLICY } from './policy'

export type { Bench, BenchBeam, BenchHand, BenchHost, BenchProbe } from './host'
export { BENCH_POLICY } from './policy'

// ── The look (docs/ART_DIRECTION.md) ──────────────────────────────────────
//
// Things on the island are UI: `toneMapped: false`, the HUD's accent for the
// live thing, the room's ink for the rest, red for a warning — the desk's own
// meanings. None of it is on layer 1 or 2 (the eyes).
const HANDLE = 0xf4f6f8
const SELECTED = 0xffcf7a
const HELD = 0x7fd7ff
/** DEV-501: the anchored point wears the pad's colour: it is the pad's, and a grip on it takes the pad. */
const ANCHORED = 0x7fd7ff
const LINE = 0xffb347
const RING = 0xffcf7a
const WARNING = 0xff4a3d
const PAD = 0x7fd7ff
const TABLE = 0x10181f

const ui = (color: number, extra: THREE.MeshBasicMaterialParameters = {}) =>
  new THREE.MeshBasicMaterial({ color, toneMapped: false, ...extra })

type Held =
  | {
      readonly kind: 'point'
      readonly index: number
      readonly pointAtGrab: Vec3Tuple
      readonly handAtGrab: Vec3Tuple
    }
  | { readonly kind: 'pad'; readonly pointAtGrab: Vec3Tuple; readonly handAtGrab: Vec3Tuple }

type Aim =
  | { readonly kind: 'cell'; readonly cell: BenchCell | null; readonly distance: number }
  | { readonly kind: 'point'; readonly index: number; readonly distance: number }
  | { readonly kind: 'pad'; readonly distance: number }
  | { readonly kind: 'line'; readonly t: number; readonly distance: number }
  | { readonly kind: 'ground'; readonly at: Vec3Tuple; readonly distance: number }

interface HandState {
  trigger: boolean
  squeeze: boolean
  stick: boolean
  lower: boolean
  upper: boolean
  held: Held | null
  aim: Aim | null
  /** The last hand origin, bench frame, and the island under the ray (level frame). */
  readonly origin: THREE.Vector3
  hit: Vec3Tuple | null
  ray: { origin: Vec3Tuple; direction: Vec3Tuple } | null
}

const aimName = (a: Aim | null): string | null =>
  a === null
    ? null
    : a.kind === 'cell'
      ? a.cell === null
        ? 'plate'
        : `cell:${a.cell}`
      : a.kind === 'point'
        ? `point:${a.index}`
        : a.kind

export const createBench = (host: BenchHost): Bench => {
  const storage = safeLocalStorage()
  const root = new THREE.Group()
  root.name = 'bench'
  root.visible = false
  host.room.add(root)

  // ── state ────────────────────────────────────────────────────────────────
  let up = false
  let loading: Promise<void> | null = null
  let donor: Level | null = null
  let field: HeightField | null = null
  let diorama: Diorama | null = null
  let frame: BenchFrame | null = null
  let size = 0
  let slot: string | null = null
  let history: History | null = null
  let evaluation: DraftEvaluation | null = null
  let spline: CourseSpline | null = null
  let ground: Ground | null = null
  let groundKind: 'render' | 'field' | null = null
  let placeHeight = 0
  let note = ''
  let noteWarns = false
  let lastEvaluate = 0
  let lastLine = 0
  let lineDirty = false
  let evaluateDirty = false
  let beamHand: 'left' | 'right' = 'right'
  const hands: Record<'left' | 'right', HandState> = {
    left: blankHand(),
    right: blankHand(),
  }
  function blankHand(): HandState {
    return {
      trigger: false,
      squeeze: false,
      stick: false,
      lower: false,
      upper: false,
      held: null,
      aim: null,
      origin: new THREE.Vector3(),
      hit: null,
      ray: null,
    }
  }

  const draft = (): EditorDraft | null => history?.present ?? null

  // ── the furniture ────────────────────────────────────────────────────────
  const table = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.02, 48), ui(TABLE))
  table.name = 'bench-table'
  root.add(table)
  const plate = createBenchPlate(BENCH_POLICY.plateWidth)
  root.add(plate.object)

  const handleGeometry = new THREE.OctahedronGeometry(BENCH_POLICY.handleRadius, 1)
  const handleMaterial = ui(0xffffff)
  let handles = new THREE.InstancedMesh(handleGeometry, handleMaterial, 1)
  handles.name = 'bench-handles'
  handles.count = 0
  handles.frustumCulled = false
  root.add(handles)

  const stalkMaterial = new THREE.LineBasicMaterial({
    color: HANDLE,
    toneMapped: false,
    transparent: true,
    opacity: 0.5,
  })
  const stalks = new THREE.LineSegments(new THREE.BufferGeometry(), stalkMaterial)
  stalks.name = 'bench-stalks'
  stalks.frustumCulled = false
  root.add(stalks)

  const runInMaterial = new THREE.LineDashedMaterial({
    color: LINE,
    toneMapped: false,
    dashSize: 0.01,
    gapSize: 0.008,
  })
  const runIn = new THREE.Line(new THREE.BufferGeometry(), runInMaterial)
  runIn.name = 'bench-run-in'
  runIn.frustumCulled = false
  root.add(runIn)

  // The pad: a cone lying down, its tip the ship's nose (built to point +z, then
  // turned to the heading), so the heading reads from any side.
  const padGeometry = new THREE.ConeGeometry(0.014, 0.04, 6)
  padGeometry.rotateX(Math.PI / 2)
  const pad = new THREE.Mesh(padGeometry, ui(PAD))
  pad.name = 'bench-pad'
  root.add(pad)

  const ringGeometry = new THREE.TorusGeometry(1, 0.14, 4, 12)
  const ringMaterial = ui(RING)
  let rings = new THREE.InstancedMesh(ringGeometry, ringMaterial, 1)
  rings.name = 'bench-rings'
  rings.count = 0
  rings.frustumCulled = false
  root.add(rings)

  const markGeometry = new THREE.OctahedronGeometry(0.011, 0)
  const markMaterial = ui(WARNING)
  let marks = new THREE.InstancedMesh(markGeometry, markMaterial, 1)
  marks.name = 'bench-warnings'
  marks.count = 0
  marks.frustumCulled = false
  root.add(marks)
  const underMaterial = new THREE.LineBasicMaterial({ color: WARNING, toneMapped: false })
  const under = new THREE.LineSegments(new THREE.BufferGeometry(), underMaterial)
  under.name = 'bench-under'
  under.frustumCulled = false
  root.add(under)

  const grow = <M extends THREE.InstancedMesh>(mesh: M, n: number, name: string): M => {
    if (n <= mesh.instanceMatrix.count) return mesh
    const next = new THREE.InstancedMesh(
      mesh.geometry,
      mesh.material,
      Math.max(n, 2 * mesh.instanceMatrix.count),
    ) as unknown as M
    next.name = name
    next.frustumCulled = false
    root.remove(mesh)
    mesh.dispose()
    root.add(next)
    return next
  }

  /** Stand the bench in front of the seat: see the policy. */
  const place = (): void => {
    const b = host.seatBearing
    root.position.set(
      host.seat.x + Math.sin(b) * BENCH_POLICY.centreReach,
      host.seat.y - BENCH_POLICY.waterBelowEye,
      host.seat.z - Math.cos(b) * BENCH_POLICY.centreReach,
    )
    // Its +z toward the seat, as the room turns a label (`labelYaw`).
    root.rotation.set(0, -b, 0)
    const r = size / 2 + 0.04
    table.scale.set(r, 1, r)
    table.position.y = -0.012
    // The plate: at the near shore, tilted back to face the eye. In the
    // bench's own frame, where the eye is (0, waterBelowEye, centreReach): a
    // turn about x of −θ takes the plane's +z up toward it.
    const plateZ = size / 2 + BENCH_POLICY.plateNearShore
    const plateY = 0.06
    plate.object.position.set(0, plateY, plateZ)
    plate.object.rotation.set(
      -Math.atan2(BENCH_POLICY.waterBelowEye - plateY, BENCH_POLICY.centreReach - plateZ),
      0,
      0,
    )
  }

  // ── the ground ───────────────────────────────────────────────────────────
  const fieldGround = (f: HeightField, seaY: number): Ground => ({
    surfaceAt: (x, z) => drawnHeightAt(f, seaY, x, z),
    waterAt: (x, z) => terrainHeightAt(f, x, -z) <= seaY,
  })
  const pickGround = (): void => {
    if (!donor || !field || !frame) return
    const live = host.liveLevel()
    const t = host.terrains()
    const same =
      live !== null &&
      t !== null &&
      live.environment === donor.environment &&
      customGroundOf(live) === null &&
      customGroundOf(donor) === null
    const drawn = fieldGround(field, frame.seaY)
    if (same && t) {
      const seen = deskGround(t)
      // Off the built terrain's extent the render surface is −∞: the drawn field there.
      ground = {
        surfaceAt: (x, z) => {
          const h = seen.surfaceAt(x, z)
          return Number.isFinite(h) ? h : drawn.surfaceAt(x, z)
        },
        waterAt: (x, z) => seen.waterAt?.(x, z) ?? false,
      }
      groundKind = 'render'
    } else {
      ground = drawn
      groundKind = 'field'
    }
  }

  // ── what follows a change of the draft ───────────────────────────────────
  const _m = new THREE.Matrix4()
  const _q = new THREE.Quaternion()
  const _s = new THREE.Vector3()
  const _p = new THREE.Vector3()
  const _t = new THREE.Vector3()
  const Z = new THREE.Vector3(0, 0, 1)
  const _c = new THREE.Color()

  const onBench = (p: readonly number[]): Vec3Tuple => toBench(frame as BenchFrame, p)

  const drawHandles = (): void => {
    const d = draft()
    if (!d || !frame || !field) return
    const pts = d.course.path.points
    handles = grow(handles, pts.length, 'bench-handles')
    handles.count = pts.length
    const heldIndex = (['left', 'right'] as const)
      .map((h) => hands[h].held)
      .find((x) => x?.kind === 'point')
    const stalk: number[] = []
    for (const [i, p] of pts.entries()) {
      const b = onBench(p)
      _m.makeTranslation(b[0], b[1], b[2])
      handles.setMatrixAt(i, _m)
      const held = heldIndex?.kind === 'point' && heldIndex.index === i
      const locked = isAnchoredPoint(d.course, i) // DEV-501
      handles.setColorAt(
        i,
        _c.setHex(locked ? ANCHORED : held ? HELD : d.selection === i ? SELECTED : HANDLE),
      )
      const foot = onBench([p[0], drawnHeightAt(field, frame.seaY, p[0], p[2]), p[2]])
      stalk.push(foot[0], foot[1], foot[2], b[0], b[1], b[2])
    }
    handles.instanceMatrix.needsUpdate = true
    if (handles.instanceColor) handles.instanceColor.needsUpdate = true
    stalks.geometry.dispose()
    stalks.geometry = new THREE.BufferGeometry()
    stalks.geometry.setAttribute('position', new THREE.Float32BufferAttribute(stalk, 3))
    // The pad, and the run-in from it to the first point.
    const s = d.course.start
    const pb = onBench(s.pos)
    pad.position.set(pb[0], pb[1] + 0.006, pb[2])
    // The nose is local −z turned by yaw (2016's spawn convention, `playtest.ts`).
    const yaw = (s.yaw * Math.PI) / 180
    _t.set(-Math.sin(yaw), 0, -Math.cos(yaw))
    pad.quaternion.setFromUnitVectors(Z, _t)
    const r = donor && d.course.island === donor.environment ? runInOf(d.course, donor) : null
    runIn.geometry.dispose()
    runIn.geometry = new THREE.BufferGeometry()
    if (r) {
      const a = onBench([r.from.x, r.from.y, r.from.z])
      const b = onBench([r.to.x, r.to.y, r.to.z])
      runIn.geometry.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b], 3))
      runIn.computeLineDistances()
    }
  }

  const drawLine = (): void => {
    lastLine = performance.now()
    lineDirty = false
    const samples = spline ? spline.samples.map((p) => [p.x, p.y, p.z]) : null
    // The diorama's own jets fly it, and it draws the line (DEV-420's route).
    diorama?.setRoute(samples && samples.length > 1 ? samples : null, LINE)
  }

  const evaluate = (): void => {
    const d = draft()
    lastEvaluate = performance.now()
    evaluateDirty = false
    if (!d || !donor || !ground || !frame) return
    try {
      evaluation = evaluateDraft(
        d,
        donor,
        ground,
        courseSlots(d.course.start, donor, host.racers()),
      )
    } catch (err) {
      console.warn('bench: could not evaluate the draft', err)
      evaluation = null
    }
    // The rings, every gap along the line, each facing along it.
    const level = evaluation?.level ?? null
    const live = level ? liveRings(level) : []
    rings = grow(rings, live.length, 'bench-rings')
    rings.count = live.length
    for (const [i, ring] of live.entries()) {
      const b = onBench(ring.pos)
      let tangent: Vec3Tuple = [0, 0, 1]
      if (spline && spline.samples.length > 1) {
        let best = 0
        let bestD = Number.POSITIVE_INFINITY
        for (const [j, q] of spline.samples.entries()) {
          const dd = (q.x - ring.pos[0]) ** 2 + (q.y - ring.pos[1]) ** 2 + (q.z - ring.pos[2]) ** 2
          if (dd < bestD) {
            bestD = dd
            best = j
          }
        }
        const tt = splineTangentAt(spline, spline.arc[best] as number)
        tangent = [tt.x, tt.y * frame.relief, tt.z]
      }
      _t.set(tangent[0], tangent[1], tangent[2]).normalize()
      _q.setFromUnitVectors(Z, _t)
      const radius = Math.max(BENCH_POLICY.ringMinRadius, ring.trigger.radius * frame.scale)
      _s.setScalar(radius)
      _m.compose(_p.set(b[0], b[1], b[2]), _q, _s)
      rings.setMatrixAt(i, _m)
    }
    rings.instanceMatrix.needsUpdate = true
    // The warnings: a red mark where each one is, and red down every stretch
    // of line that is under the ground (the desk's `groundMarks`).
    const warnings = (evaluation?.warnings ?? []).filter(
      (w) => w.at !== null && w.severity !== 'note',
    )
    marks = grow(marks, warnings.length, 'bench-warnings')
    marks.count = warnings.length
    for (const [i, w] of warnings.entries()) {
      const b = onBench(w.at as Vec3Tuple)
      _m.makeTranslation(b[0], b[1] + 0.02, b[2])
      marks.setMatrixAt(i, _m)
    }
    marks.instanceMatrix.needsUpdate = true
    const red = groundMarks(evaluation?.warnings ?? [], level, spline)
    const seg: number[] = []
    const polyline = (run: readonly (readonly number[])[]): void => {
      for (let k = 1; k < run.length; k++) {
        seg.push(...onBench(run[k - 1] as number[]), ...onBench(run[k] as number[]))
      }
    }
    for (const run of red.under) polyline(run)
    for (const loop of red.rings) polyline([...loop.rim, loop.rim[0] as Vec3Tuple])
    under.geometry.dispose()
    under.geometry = new THREE.BufferGeometry()
    under.geometry.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3))
  }

  const autosave = createDebounce(() => {
    const d = draft()
    if (d && slot) saveDraft(storage, slot, d, Date.now())
  }, BENCH_POLICY.autosaveMs)
  const saveNow = (): void => autosave.flush()

  const dragging = (): boolean => hands.left.held !== null || hands.right.held !== null

  const changed = (): void => {
    const d = draft()
    if (!d) return
    try {
      spline = d.course.path.points.length >= 2 ? playerCourseSpline(d.course) : null
    } catch {
      spline = null
    }
    drawHandles()
    const now = performance.now()
    if (!dragging() || now - lastLine >= BENCH_POLICY.dragLineMs) drawLine()
    else lineDirty = true
    if (!dragging() || now - lastEvaluate >= BENCH_POLICY.dragEvaluateMs) evaluate()
    else evaluateDirty = true
    autosave.schedule()
  }

  const { step: apply } = createHistoryLoop<EditorDraft>({
    get: () => history,
    set: (h) => {
      history = h
    },
    changed: () => changed(),
  })
  const edit = (next: (d: EditorDraft) => EditorDraft, coalesce?: string): void =>
    apply((h) => record(h, next(h.present), coalesce ? { coalesce } : {}))

  // ── the draft, the donor, the island ─────────────────────────────────────
  const load = async (): Promise<void> => {
    const recent = listDrafts(storage)[0]
    const stored = recent ? loadDraft(storage, recent.slot) : null
    let sky = stored?.course.sky ?? host.defaultSky
    let level: Level
    try {
      level = await host.loadLevel(sky)
    } catch {
      sky = host.defaultSky
      level = await host.loadLevel(sky)
    }
    donor = level
    slot = stored && recent ? recent.slot : newDraftSlot(randomInt)
    history = createHistory(stored ?? newDraft(level, randomCourseName(randomInt)))
    placeHeight = placeHeightFor(level)
    field = await missionField(level)
    const span = Math.max(
      field.terrainSize * (field.scaleX || 1),
      field.terrainSize * (field.scaleZ || 1),
    )
    size = span / BENCH_POLICY.worldPerBenchMetre
    // DEV-799: the waterline the mission stands its island on. Without it the
    // island's zero was the land field's own origin, which on a course over
    // Simonet's sea is the SEABED (35 m under it): the whole course stood on the
    // seabed, underwater. Null where the environment has no sea (alpine, the
    // canyon), which is the land's origin as before.
    const seaLevel = await missionSeaLevel(level)
    diorama = createDiorama({
      field,
      seaLevel,
      palette: paletteFor(level.environment),
      holo: host.holoLook(),
      route: null,
      size,
      grid: BENCH_POLICY.grid,
      relief: BENCH_POLICY.relief,
      craftScale: 1.6,
    })
    diorama.object.name = 'bench-island'
    root.add(diorama.object)
    frame = diorama.frame
    place()
    console.info(
      `bench: ${level.environment} at 1:${BENCH_POLICY.worldPerBenchMetre}, ${size.toFixed(2)} m across, ` +
        `draft ${slot} (${history.present.course.path.points.length} points)`,
    )
  }

  // ── the hands ────────────────────────────────────────────────────────────
  const _inv = new THREE.Matrix4()
  const _o = new THREE.Vector3()
  const _d = new THREE.Vector3()
  const _w = new THREE.Vector3()

  const benchPoints = (): Vec3Tuple[] =>
    (draft()?.course.path.points ?? []).map((p) => onBench(p) as Vec3Tuple)
  const padPoint = (): Vec3Tuple | null => {
    const d = draft()
    return d ? onBench(d.course.start.pos) : null
  }

  /** What `origin`/`direction` (bench frame) is on. */
  const aimOf = (origin: THREE.Vector3, direction: THREE.Vector3): Aim | null => {
    const o: Vec3Tuple = [origin.x, origin.y, origin.z]
    const dir: Vec3Tuple = [direction.x, direction.y, direction.z]
    const onPlate = plate.hit(origin, direction)
    if (onPlate) return { kind: 'cell', cell: onPlate.cell, distance: onPlate.distance }
    const P = BENCH_POLICY
    const pts = benchPoints()
    const i = pickPoint(pts, o, dir, P.handReach, P.pickTolerance, P.pickPerMetre)
    if (i >= 0) {
      const p = pts[i] as Vec3Tuple
      return {
        kind: 'point',
        index: i,
        distance: Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2]),
      }
    }
    const pp = padPoint()
    if (pp && pickPoint([pp], o, dir, P.handReach, P.pickTolerance, P.pickPerMetre) === 0) {
      return { kind: 'pad', distance: Math.hypot(pp[0] - o[0], pp[1] - o[1], pp[2] - o[2]) }
    }
    const f = frame as BenchFrame
    const land = field
      ? rayOntoIsland(
          f,
          (x, z) => drawnHeightAt(field as HeightField, f.seaY, x, z),
          o,
          dir,
          size / 2,
          P.rayReach,
          P.rayStep,
        )
      : null
    if (spline && spline.length > 0) {
      const samples = spline.samples.map((q) => onBench([q.x, q.y, q.z]))
      const j = pickLine(
        samples,
        o,
        dir,
        P.pickTolerance,
        P.pickPerMetre,
        land ? land.distance : P.rayReach,
      )
      if (j >= 0) {
        const q = samples[j] as Vec3Tuple
        return {
          kind: 'line',
          t: (spline.arc[j] as number) / spline.length,
          distance: Math.hypot(q[0] - o[0], q[1] - o[1], q[2] - o[2]),
        }
      }
    }
    if (land) return { kind: 'ground', at: toWorld(f, land.point), distance: land.distance }
    return null
  }

  /** A new point over `at` (level frame): the placement height over the render surface. */
  const pointOver = (at: Vec3Tuple): Vec3Tuple => {
    const g = ground?.surfaceAt(at[0], at[2]) ?? Number.NEGATIVE_INFINITY
    const base = Number.isFinite(g) ? g : at[1]
    return [at[0], base + placeHeight, at[2]]
  }

  const press = (cell: BenchCell): void => {
    const d = draft()
    if (!d || !history || !donor) return
    if (cell === 'undo') apply(undo)
    else if (cell === 'redo') apply(redo)
    else if (cell === 'delete') {
      if (d.selection !== null) edit((x) => deletePoint(x, x.selection as number))
    } else if (cell === 'lift') {
      const g = ground
      if (g) edit((x) => liftClear(x, donor as Level, g))
    } else if (cell === 'leave') {
      saveNow()
      host.leave()
    } else if (cell === 'fly') {
      const blocking = (evaluation?.warnings ?? []).find((w) => w.severity === 'error')
      const request = blocking ? null : playtestRequest(d, donor)
      if (!request) {
        note = blocking
          ? `Cannot fly yet: ${blocking.message}`
          : 'Cannot fly yet: two points make a course'
        noteWarns = true
        return
      }
      saveNow()
      console.info(`bench: flying ${request.courseId}`)
      host.fly(request)
    }
  }

  const enabledCells = (): Record<BenchCell, boolean> => {
    const d = draft()
    const blocking = (evaluation?.warnings ?? []).some((w) => w.severity === 'error')
    return {
      undo: history !== null && canUndo(history),
      redo: history !== null && canRedo(history),
      delete: d?.selection !== null && d?.selection !== undefined,
      lift:
        (d?.course.path.points.length ?? 0) >= 2 &&
        (evaluation?.warnings ?? []).some((w) => GROUND_WARNING_KINDS.has(w.kind)),
      fly: !!evaluation?.level && !blocking,
      leave: true,
    }
  }

  const statusLine = (): string => {
    const d = draft()
    if (!d) return 'Setting out the bench…'
    const n = d.course.path.points.length
    const r = evaluation?.level ? liveRings(evaluation.level).length : 0
    const fix = (evaluation?.warnings ?? []).filter((w) => w.severity === 'error').length
    return (
      `${d.course.name[0]} ${d.course.name[1]} · ${n} point${n === 1 ? '' : 's'} · ${r} rings` +
      (fix ? ` · ${fix} to fix` : '')
    )
  }
  const noteLine = (): { text: string; warns: boolean } => {
    if (note) return { text: note, warns: noteWarns }
    const first = (evaluation?.warnings ?? []).find((w) => w.severity !== 'note')
    if (first) return { text: first.message, warns: true }
    if (groundKind === 'field') {
      return {
        text: 'Heights over the model until this island is flown · save on the desktop',
        warns: false,
      }
    }
    return { text: 'Kept in this browser · save a file or a link on the desktop', warns: false }
  }

  const handFrame = (h: BenchHand): BenchBeam | null => {
    const s = hands[h.hand]
    const f = frame
    if (!f) return null
    // World ray into the bench's frame. `root.matrixWorld` is recomposed first:
    // it is stale inside the XR frame until render (CLAUDE.md).
    _o.set(h.origin[0], h.origin[1], h.origin[2]).applyMatrix4(_inv)
    _d.set(h.origin[0] + h.direction[0], h.origin[1] + h.direction[1], h.origin[2] + h.direction[2])
      .applyMatrix4(_inv)
      .sub(_o)
      .normalize()
    s.origin.copy(_o)
    s.ray = { origin: [...h.origin], direction: [...h.direction] }
    const aim = s.held ? null : aimOf(_o, _d)
    s.aim = aim
    s.hit = aim?.kind === 'ground' ? aim.at : null

    const edge = (now: boolean, was: boolean): boolean => now && !was
    const trig = edge(h.trigger, s.trigger)
    const grip = edge(h.squeeze, s.squeeze)
    const released = !h.squeeze && s.squeeze
    const stick = edge(h.stick, s.stick)
    const lower = edge(h.lower, s.lower)
    const upper = edge(h.upper, s.upper)
    s.trigger = h.trigger
    s.squeeze = h.squeeze
    s.stick = h.stick
    s.lower = h.lower
    s.upper = h.upper
    const acted = trig || grip || stick || lower || upper || s.held !== null
    if (acted) {
      beamHand = h.hand
      if (note && (trig || grip)) note = ''
    }

    if (trig && aim) {
      if (aim.kind === 'cell' && aim.cell) press(aim.cell)
      else if (aim.kind === 'point') {
        // DEV-501: the anchored point is the pad's; a trigger on it selects nothing.
        const c = draft()?.course
        if (!c || !isAnchoredPoint(c, aim.index)) edit((d) => select(d, aim.index))
      } else if (aim.kind === 'line') edit((d) => insertPointOnPath(d, aim.t))
      else if (aim.kind === 'ground') edit((d) => addPoint(d, pointOver(aim.at)))
    }
    if (grip && !s.held) {
      const P = BENCH_POLICY
      const o: Vec3Tuple = [_o.x, _o.y, _o.z]
      const dir: Vec3Tuple = [_d.x, _d.y, _d.z]
      const pts = benchPoints()
      const i = pickPoint(pts, o, dir, P.handReach, P.pickTolerance, P.pickPerMetre)
      const pp = padPoint()
      const c = draft()?.course
      // DEV-501: a grip on the anchored point takes the PAD, and the ring follows it.
      const onAnchor = i >= 0 && c !== undefined && isAnchoredPoint(c, i)
      if (i >= 0 && !onAnchor) {
        s.held = { kind: 'point', index: i, pointAtGrab: pts[i] as Vec3Tuple, handAtGrab: o }
        edit((d) => select(d, i))
      } else if (onAnchor && pp) {
        s.held = { kind: 'pad', pointAtGrab: pp, handAtGrab: o }
      } else if (
        pp &&
        pickPoint([pp], o, dir, P.handReach, P.pickTolerance, P.pickPerMetre) === 0
      ) {
        s.held = { kind: 'pad', pointAtGrab: pp, handAtGrab: o }
      }
      drawHandles()
    }
    if (s.held && h.squeeze) {
      const to = dragTo(s.held.pointAtGrab, s.held.handAtGrab, [_o.x, _o.y, _o.z])
      const w = toWorld(f, to)
      if (s.held.kind === 'point') {
        const index = s.held.index
        edit((d) => movePoint(d, index, w), `bench-move:${index}`)
      } else {
        const g = ground?.surfaceAt(w[0], w[2]) ?? Number.NEGATIVE_INFINITY
        const y = Number.isFinite(g) ? g : (draft()?.course.start.pos[1] ?? w[1])
        edit((d) => movePad(d, [w[0], y, w[2]]), 'bench-pad')
      }
    }
    if (released && s.held) {
      s.held = null
      if (history) history = seal(history)
      drawLine()
      evaluate()
      drawHandles()
    }
    if (stick) {
      const d = draft()
      if (d && d.selection !== null) edit((x) => deletePoint(x, x.selection as number))
    }
    if (lower) apply(undo)
    if (upper) apply(redo)

    if (!aim) return { hand: h.hand, distance: null }
    // The beam ends on the thing, in WORLD metres (the room is not scaled, but
    // measure rather than assume).
    const local = _w.copy(_d).multiplyScalar(aim.distance).add(_o)
    root.localToWorld(local)
    const distance = Math.hypot(local.x - h.origin[0], local.y - h.origin[1], local.z - h.origin[2])
    return { hand: h.hand, distance }
  }

  // ── the bench ────────────────────────────────────────────────────────────
  const bench: Bench = {
    object: root,
    open(result) {
      up = true
      root.visible = true
      note = ''
      // Every button counts as HELD until it is let go: the trigger that
      // pressed the door is still down on the bench's first frame, and must
      // not also drop a point there.
      for (const h of ['left', 'right'] as const) {
        const s = hands[h]
        s.trigger = true
        s.squeeze = true
        s.stick = true
        s.lower = true
        s.upper = true
      }
      if (!loading) {
        loading = load().catch((err: unknown) => {
          console.error('bench: could not set out the bench', err)
          note = 'The bench could not load its island'
          noteWarns = true
        })
      }
      void loading.then(() => {
        if (!history) return
        if (result) {
          const lap = onReturn(history.present, result)
          history = withAuthorLap(history, lap.authorLap)
          console.info(
            `bench: back from ${result.courseId}, ${result.ringsTaken}/${result.ringsTotal} rings` +
              (result.seconds === null ? '' : `, ${result.seconds.toFixed(2)} s`),
          )
        }
        pickGround()
        changed()
        drawLine()
        evaluate()
      })
    },
    close() {
      saveNow()
      up = false
      root.visible = false
      for (const h of ['left', 'right'] as const) {
        hands[h].held = null
        hands[h].aim = null
      }
      if (history) history = seal(history)
    },
    frame(seconds, input) {
      if (!up || !frame || !history) return null
      diorama?.update(seconds)
      root.updateWorldMatrix(true, true)
      _inv.copy(root.matrixWorld).invert()
      let beam: BenchBeam | null = null
      const seen = new Set<'left' | 'right'>()
      for (const h of input) {
        seen.add(h.hand)
        const b = handFrame(h)
        if (b && (beam === null || h.hand === beamHand)) beam = b
      }
      // A hand that went away lets go.
      for (const h of ['left', 'right'] as const) {
        if (!seen.has(h) && hands[h].held) {
          hands[h].held = null
          history = seal(history)
          drawLine()
          evaluate()
        }
      }
      if (lineDirty && performance.now() - lastLine >= BENCH_POLICY.dragLineMs) drawLine()
      if (evaluateDirty && performance.now() - lastEvaluate >= BENCH_POLICY.dragEvaluateMs) {
        evaluate()
      }
      const aimed = hands[beamHand].aim
      const n = noteLine()
      plate.paint(
        statusLine(),
        n.text,
        n.warns,
        aimed?.kind === 'cell' ? aimed.cell : null,
        enabledCells(),
      )
      return beam
    },
    probe(): BenchProbe {
      const d = draft()
      const cells: Record<string, [number, number, number]> = {}
      if (frame) {
        root.updateWorldMatrix(true, true)
        for (const c of BENCH_CELLS) {
          const v = plate.cellCentre(c, new THREE.Vector3())
          root.localToWorld(v)
          cells[c] = [v.x, v.y, v.z]
        }
      }
      const axes: [number, number, number][] | null = frame
        ? (() => {
            root.updateWorldMatrix(true, false)
            const o = new THREE.Vector3().setFromMatrixPosition(root.matrixWorld)
            const out: [number, number, number][] = [[o.x, o.y, o.z]]
            for (const i of [0, 1, 2]) {
              const v = new THREE.Vector3().setFromMatrixColumn(root.matrixWorld, i).normalize()
              out.push([v.x, v.y, v.z])
            }
            return out
          })()
        : null
      const handOf = (h: 'left' | 'right') => hands[h]
      return {
        up,
        ready: up && frame !== null && history !== null,
        slot,
        sky: d?.course.sky ?? null,
        island: d?.course.island ?? null,
        points: (d?.course.path.points ?? []).map((p) => [p[0], p[1], p[2]] as const),
        selection: d?.selection ?? null,
        pad: d ? [d.course.start.pos[0], d.course.start.pos[1], d.course.start.pos[2]] : null,
        undo: history ? depth(history) : 0,
        redo: history ? history.future.length : 0,
        rings: rings.count,
        warnings: (evaluation?.warnings ?? []).map((w) => ({ kind: w.kind, severity: w.severity })),
        ground: groundKind,
        placeHeight,
        aimed: { left: aimName(handOf('left').aim), right: aimName(handOf('right').aim) },
        held: {
          left: handOf('left').held
            ? handOf('left').held?.kind === 'pad'
              ? 'pad'
              : String((handOf('left').held as { index: number }).index)
            : null,
          right: handOf('right').held
            ? handOf('right').held?.kind === 'pad'
              ? 'pad'
              : String((handOf('right').held as { index: number }).index)
            : null,
        },
        frame: frame ? { ...frame } : null,
        axes,
        cells,
        status: statusLine(),
        note: noteLine().text,
        authorLap: d?.authorLap?.seconds ?? null,
        rays: { left: handOf('left').ray, right: handOf('right').ray },
        hits: { left: handOf('left').hit, right: handOf('right').hit },
        groundUnder: (d?.course.path.points ?? []).map((p) => {
          const g = ground?.surfaceAt(p[0], p[2])
          return g !== undefined && Number.isFinite(g) ? g : null
        }),
      }
    },
  }
  return bench
}
